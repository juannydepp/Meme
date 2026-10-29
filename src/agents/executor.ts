import { activity, bus } from '../bus';
import { clock } from '../clock';
import { CONFIG, HARD } from '../config';
import type { Desk } from '../desk';
import { pct, sym } from '../desk';
import { saveState } from '../store';
import { verifyTickets } from '../tickets';
import type { AnalystTicket, ClosedTrade, ExitOrder, Position } from '../types';
import type { LiveWallet } from '../data/wallet';
import type { Risk } from './risk';

// EXECUTOR — the only seat that touches the wallet. Has no opinions.
//   Buys ONLY when it holds a valid Analyst ticket that points at a valid Filter ticket
//   with every check passing, the Filter data is fresh, and RISK says the entry is allowed.
//   Size = 8% of current free SOL (or less, if the pool is thin). Never more — asserted twice.
//   Sells ONLY when RISK sends an exit order.

export class Executor {
  private lock: Promise<void> = Promise.resolve();
  private seq = 0;
  private exiting = new Set<string>();
  constructor(private d: Desk, private risk: Risk, private wallet: LiveWallet | null) {}

  start() {
    bus.on('analyst.pass', (t) => this.serial(() => this.buy(t)));
    bus.on('exit.order', (o) => this.sell(o));
  }

  private serial(fn: () => Promise<void>) { this.lock = this.lock.then(fn, fn); return this.lock; }
  private reject(t: AnalystTicket, reason: string) {
    activity.inc('EXECUTOR', 'reject');
    bus.decide({ agent: 'EXECUTOR', kind: 'reject', mint: t.mint, symbol: t.symbol, reason: `REFUSE ${sym(t.symbol, t.mint)}: ${reason}` });
  }

  private async buy(t: AnalystTicket) {
    const s = this.d.state;
    activity.state('EXECUTOR', 'busy');
    try {
      // 1. paperwork
      const v = verifyTickets(t.ticketId);
      if (v.problem || !v.filter || !v.analyst) return this.reject(t, `ticket invalid: ${v.problem}`);
      if (v.analyst.score < CONFIG.minScore) return this.reject(t, `score ${v.analyst.score} < ${CONFIG.minScore}`);
      const age = (clock.now() - v.filter.issuedAt) / 1000;
      if (age > CONFIG.ticketMaxAgeSec) return this.reject(t, `filter data ${age.toFixed(0)}s old (max ${CONFIG.ticketMaxAgeSec}s)`);
      // 2. risk policy
      const veto = this.risk.mayOpen(t.mint, t.symbol);
      if (veto) return this.reject(t, veto);
      // 3. size
      const spendable = Math.max(0, s.balanceSol - CONFIG.feeReserveSol);
      const cap = CONFIG.maxPositionPct * s.balanceSol;
      const poolCapSol = (v.filter.snapshot.liquidityUsd * (CONFIG.maxPoolSharePct / 100)) / this.d.solUsd;
      const size = Math.floor(Math.min(cap, spendable, poolCapSol) * 1e4) / 1e4;
      if (size < CONFIG.minTradeSol) return this.reject(t, `size ${size.toFixed(4)} SOL below minimum ${CONFIG.minTradeSol} (balance/pool too small)`);
      if (size > HARD.MAX_POSITION_PCT * s.balanceSol + 1e-9) {
        s.violations.push(`${new Date(clock.now()).toISOString()} blocked size ${size} > 8% of ${s.balanceSol}`);
        return this.reject(t, 'SIZE ASSERTION FAILED — blocked');
      }
      const why = `score ${t.score.toFixed(2)} [${Object.entries(t.components).map(([k, x]) => `${k} ${x}`).join(', ')}] · ${t.reasons.join(' · ')}`;

      // 4. execute
      const decimals = v.filter.safety.decimals ?? 6;
      let tokens: number, cost: number, sig: string | undefined;
      if (this.wallet) {
        const r = await this.wallet.buy(t.mint, size);
        tokens = r.tokens; cost = r.solSpent; sig = r.sig;
        if (!(tokens > 0)) throw new Error(`buy landed but no tokens received (${sig})`);
      } else {
        const q = await this.d.market.quoteBuy(t.mint, size, decimals);
        const px = v.filter.snapshot.priceSol;
        tokens = q ? q.tokens : (size / px) * (1 - CONFIG.costModelFeePct / 100) * (1 - (size * this.d.solUsd) / (v.filter.snapshot.liquidityUsd / 2));
        cost = size + 0.0002; // + network/priority fee estimate
      }
      // the swap input is capped at 8%; network fee + token-account rent ride on top
      if (cost - size > 0.01) bus.decide({ agent: 'EXECUTOR', kind: 'warn', mint: t.mint, symbol: t.symbol, reason: `fees on buy unusually high: ${(cost - size).toFixed(4)} SOL` });

      const entryPrice = cost / tokens;
      const p: Position = {
        id: `P-${String(++this.seq).padStart(4, '0')}-${t.mint.slice(0, 4)}`, mint: t.mint, symbol: t.symbol, decimals,
        tokens, costSol: cost, entryPrice, entryLiquidityUsd: v.filter.snapshot.liquidityUsd, pairAddress: v.filter.snapshot.pairAddress, openedAt: clock.now(),
        peakPrice: entryPrice, trailActive: false, stopPrice: entryPrice * (1 - CONFIG.stopLossPct),
        lastPrice: entryPrice, lastPriceAt: clock.now(), lastLiquidityUsd: v.filter.snapshot.liquidityUsd,
        filterTicketId: v.filter.ticketId, analystTicketId: t.ticketId, entryReason: why, buySig: sig,
        shadowCooldown: this.risk.shadowCooldown() ?? undefined,
      };
      s.balanceSol -= cost;
      s.positions.push(p);
      saveState(s);
      activity.inc('EXECUTOR', 'buys');
      bus.decide({ agent: 'EXECUTOR', kind: 'buy', mint: t.mint, symbol: t.symbol,
        reason: `BUY ${sym(t.symbol, t.mint)} ${cost.toFixed(3)} SOL (${((cost / (s.balanceSol + cost)) * 100).toFixed(1)}% of bal)${p.shadowCooldown ? ` [IN SHADOW COOLDOWN: ${p.shadowCooldown}]` : ''} — ${why}`,
        data: { positionId: p.id, cost, tokens, entryPrice, sig, shadowCooldown: p.shadowCooldown, filterTicket: v.filter.ticketId, analystTicket: t.ticketId } });
      bus.emit('position.opened', p);
    } catch (e: any) {
      bus.decide({ agent: 'EXECUTOR', kind: 'error', mint: t.mint, symbol: t.symbol, reason: `buy failed ${sym(t.symbol, t.mint)}: ${e?.message ?? e}` });
    } finally { activity.state('EXECUTOR', 'idle'); }
  }

  private async sell(o: ExitOrder) {
    const s = this.d.state;
    const p = s.positions.find((x) => x.id === o.positionId);
    if (!p || this.exiting.has(p.id)) return;
    this.exiting.add(p.id);
    activity.state('EXECUTOR', 'busy');
    try {
      let proceeds = 0, sig: string | undefined, exitPrice = o.markPrice;
      if (this.wallet) {
        let lastErr: unknown;
        for (let i = 0; i < 5; i++) {
          try { const r = await this.wallet.sellAll(p.mint); proceeds = r.solOut; sig = r.sig; lastErr = null; break; }
          catch (e) { lastErr = e; await clock.sleep(2000 * (i + 1)); }
        }
        if (lastErr) throw lastErr;
      } else {
        let q = await this.d.market.quoteSell(p.mint, p.tokens, p.decimals);
        if (q && o.markPrice > 0 && Math.abs(q.sol / p.tokens / o.markPrice - 1) > 0.35) q = (await this.d.market.quoteSell(p.mint, p.tokens, p.decimals)) ?? q;
        proceeds = q ? q.sol : p.tokens * o.markPrice * (1 - CONFIG.costModelFeePct / 100);
        proceeds = Math.max(0, proceeds - 0.0002);
      }
      exitPrice = p.tokens > 0 ? proceeds / p.tokens : 0;
      const t: ClosedTrade = { ...p, exitPrice, proceedsSol: proceeds, pnlSol: proceeds - p.costSol, pnlPct: (proceeds / p.costSol - 1) * 100,
        closedAt: clock.now(), exitReason: o.reason, sellSig: sig };
      s.positions = s.positions.filter((x) => x.id !== p.id);
      s.balanceSol += proceeds;
      s.closed.push(t);
      saveState(s);
      activity.inc('EXECUTOR', 'sells');
      bus.decide({ agent: 'EXECUTOR', kind: 'exit', mint: p.mint, symbol: p.symbol,
        reason: `SELL ${sym(p.symbol, p.mint)} ${pct(t.pnlPct)} (${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)} SOL) — ${o.reason}`,
        data: { positionId: p.id, proceeds, pnlSol: t.pnlSol, pnlPct: t.pnlPct, heldMin: (t.closedAt - t.openedAt) / 60_000, sig } });
      bus.emit('position.closed', t);
    } catch (e: any) {
      bus.decide({ agent: 'EXECUTOR', kind: 'error', mint: p.mint, symbol: p.symbol, reason: `SELL FAILED ${sym(p.symbol, p.mint)}: ${e?.message ?? e} — Risk will retry` });
      this.risk.exitFailed(p.id);
    } finally { this.exiting.delete(p.id); activity.state('EXECUTOR', 'idle'); }
  }
}
