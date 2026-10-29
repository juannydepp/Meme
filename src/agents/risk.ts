import { activity, bus } from '../bus';
import { clock } from '../clock';
import { CONFIG } from '../config';
import type { Desk } from '../desk';
import { equityOf, pct, sym } from '../desk';
import type { ClosedTrade, Position } from '../types';

// RISK — owns every rule about losing money. Never picks tokens, never signs.
//   • hard stop at -6% from cost basis (fees included in the basis)
//   • trailing stop arms only after +12%; then exits if price falls TRAIL_DISTANCE from the peak
//   • pool liquidity pulled ≥40% since entry → exit;  no price for 3 min → exit
//   • entry policy the Executor must ask before every buy:
//       no averaging down (one position per token, never add)
//       no revenge trades (a token that stopped you out is banned 24h; loss streaks force a cooldown)
//       daily loss halt, max open positions
export class Risk {
  private dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.recapTz, year: 'numeric', month: '2-digit', day: '2-digit' });
  private exiting = new Set<string>();
  private confirming = new Set<string>();
  private unconfirmed = new Set<string>();
  private ticking = false;
  private pendingJump = new Map<string, number>();
  constructor(private d: Desk) {}

  start() {
    bus.on('position.opened', (p) => {
      activity.inc('RISK', 'watching');
      bus.decide({ agent: 'RISK', kind: 'info', mint: p.mint, symbol: p.symbol,
        reason: `WATCH ${sym(p.symbol, p.mint)} · stop -${(CONFIG.stopLossPct * 100).toFixed(0)}% · trail arms at +${(CONFIG.trailActivatePct * 100).toFixed(0)}%` });
    });
    bus.on('position.closed', (t) => this.onClosed(t));
    clock.every(3000, () => this.tick().catch((e) => bus.decide({ agent: 'RISK', kind: 'error', reason: `risk tick failed: ${e?.message ?? e}` })));
    clock.every(60_000, () => this.dayRoll());
    this.dayRoll();
  }

  /** The Executor must call this before every buy. Returns null if allowed, else the reason. */
  mayOpen(mint: string, symbol = ''): string | null {
    const s = this.d.state, now = clock.now();
    if (s.positions.some((p) => p.mint === mint)) return 'already holding this token (no averaging down)';
    const tick = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const twin = tick(symbol) && s.positions.find((p) => tick(p.symbol) === tick(symbol));
    if (twin) return `already holding $${twin.symbol} — same ticker, copycat tokens move together`;
    if ((s.revengeBans[mint] ?? 0) > now) return `token stopped us out — banned until ${new Date(s.revengeBans[mint]).toISOString().slice(11, 16)}Z (no revenge trades)`;
    if (s.dailyHalted) return `daily loss limit hit (-${CONFIG.dailyLossHaltPct}%) — no new entries until tomorrow`;
    if (s.cooldownUntil > now && CONFIG.cooldownMode === 'enforce') return `loss-streak cooldown (${s.lossStreak} straight losses) for ${Math.ceil((s.cooldownUntil - now) / 60_000)} more min`;
    if (s.positions.length >= CONFIG.maxOpenPositions) return `max ${CONFIG.maxOpenPositions} open positions`;
    return null;
  }

  private async tick() {
    const s = this.d.state;
    this.checkDaily();
    if (!s.positions.length) { activity.state('RISK', s.dailyHalted ? 'halted' : 'idle'); return; }
    activity.state('RISK', 'busy');
    if (this.ticking) return;      // quotes are rate-limited; never let ticks pile up
    this.ticking = true;
    try { await this.mark(); } finally { this.ticking = false; }
  }

  // Positions are marked at what Jupiter would actually pay for them (after impact and fees).
  // DexScreener is only a fallback; it lags badly on young pools and switches between pairs.
  private async mark() {
    const s = this.d.state;
    let snaps = new Map();
    try { snaps = await this.d.market.pairs(s.positions.map((p) => p.mint)); } catch { /* handled via blackout rule */ }
    for (const p of [...s.positions]) {
      if (this.exiting.has(p.id)) continue;
      const snap = snaps.get(p.mint);
      const q = await this.d.market.quoteSell(p.mint, p.tokens, p.decimals);
      const now = clock.now();
      let quoted = !!(q && p.tokens > 0 && q.sol > 0);
      if (quoted) {
        // a single Jupiter quote can be garbage on thin/odd routes (seen: +1002% then -99.8% on XTO).
        // A move of >35% vs the last accepted mark needs a second quote within 15% of it.
        const px = q!.sol / p.tokens;
        const pend = this.pendingJump.get(p.id);
        if (Math.abs(px / p.lastPrice - 1) > 0.35 && !(pend && Math.abs(px / pend - 1) < 0.15)) {
          this.pendingJump.set(p.id, px);
          bus.decide({ agent: 'RISK', kind: 'info', mint: p.mint, symbol: p.symbol,
            reason: `QUOTE JUMP ${sym(p.symbol, p.mint)} ${pct((px / p.entryPrice - 1) * 100)} vs mark ${pct((p.lastPrice / p.entryPrice - 1) * 100)} — re-quoting before acting` });
          quoted = false;
        } else { this.pendingJump.delete(p.id); p.lastPrice = px; p.lastPriceAt = now; }
      }
      if (!quoted && !this.pendingJump.has(p.id) && snap && snap.priceSol > 0) { p.lastPrice = snap.priceSol; p.lastPriceAt = now; }
      // liquidity only counts on the same pool we entered (DexScreener flips between pairs)
      const samePool = snap && (!p.pairAddress || snap.pairAddress === p.pairAddress);
      if (samePool) p.lastLiquidityUsd = snap!.liquidityUsd;
      const chg = (p.lastPrice / p.entryPrice - 1);

      if (now - p.lastPriceAt > CONFIG.priceBlackoutExitSec * 1000) { this.exit(p, `no price data for ${CONFIG.priceBlackoutExitSec}s — exiting blind`); continue; }
      if (samePool && p.lastLiquidityUsd < p.entryLiquidityUsd * (1 - CONFIG.liquidityPullExitPct / 100)) {
        // a real pull shows up in the exit quote; a DexScreener glitch doesn't
        const quoteDown = !quoted || chg <= -CONFIG.stopLossPct / 2;
        if (quoteDown) { this.exit(p, `pool liquidity down ${((1 - p.lastLiquidityUsd / p.entryLiquidityUsd) * 100).toFixed(0)}% since entry, exit value ${pct(chg * 100)} — possible pull`); continue; }
      }
      // peaks and trail arming only move on executable prices, never on a DexScreener spike
      if (quoted && p.lastPrice > p.peakPrice) p.peakPrice = p.lastPrice;
      if (quoted && p.lastPrice <= p.stopPrice) {
        this.exit(p, p.trailActive
          ? `trailing stop: ${pct(chg * 100)} (peak ${pct((p.peakPrice / p.entryPrice - 1) * 100)})`
          : `hard stop -${(CONFIG.stopLossPct * 100).toFixed(0)}%: at ${pct(chg * 100)}`);
        continue;
      }
      if (!p.trailActive && p.peakPrice >= p.entryPrice * (1 + CONFIG.trailActivatePct)) {
        p.trailActive = true;
        bus.decide({ agent: 'RISK', kind: 'info', mint: p.mint, symbol: p.symbol, reason: `TRAIL ARMED ${sym(p.symbol, p.mint)} at ${pct(chg * 100)} — exits ${(CONFIG.trailDistancePct * 100).toFixed(0)}% below peak` });
      }
      if (p.trailActive) p.stopPrice = Math.max(p.stopPrice, p.peakPrice * (1 - CONFIG.trailDistancePct));
      // zombie positions (no move, slowly bleeding) block new entries forever: give each one a deadline
      const heldMin = (now - p.openedAt) / 60_000;
      if (!p.trailActive && heldMin >= CONFIG.staleExitMin && chg < 0) {
        this.exit(p, `stale: no +${(CONFIG.trailActivatePct * 100).toFixed(0)}% in ${Math.round(heldMin)}m, at ${pct(chg * 100)} — freeing the slot`); continue;
      }
      if (p.lastPrice <= p.stopPrice) {
        void this.confirmThenExit(p, p.trailActive
          ? `trailing stop: ${pct(chg * 100)} (peak ${pct((p.peakPrice / p.entryPrice - 1) * 100)})`
          : `hard stop -${(CONFIG.stopLossPct * 100).toFixed(0)}%: at ${pct(chg * 100)}`);
      } else this.unconfirmed.delete(p.id);
    }
  }

  // DexScreener lags on young pools and can sit far from the executable price (entry is a Jupiter fill),
  // so a stop it trips is only acted on once a Jupiter sell quote agrees. No quote (no route / API down) → exit anyway.
  private async confirmThenExit(p: Position, reason: string) {
    if (this.confirming.has(p.id)) return;
    this.confirming.add(p.id);
    try {
      const q = await this.d.market.quoteSell(p.mint, p.tokens, p.decimals);
      const px = q && p.tokens > 0 ? q.sol / p.tokens : null;
      if (!this.d.state.positions.some((x) => x.id === p.id) || this.exiting.has(p.id)) return;
      if (px !== null && px > p.stopPrice) {
        if (!this.unconfirmed.has(p.id)) {
          this.unconfirmed.add(p.id);
          bus.decide({ agent: 'RISK', kind: 'info', mint: p.mint, symbol: p.symbol,
            reason: `STOP NOT CONFIRMED ${sym(p.symbol, p.mint)}: DexScreener says ${reason}, Jupiter quote ${pct((px / p.entryPrice - 1) * 100)} — holding` });
        }
        return;
      }
      this.unconfirmed.delete(p.id);
      this.exit(p, px === null ? `${reason} (no Jupiter quote to confirm)` : `${reason}, Jupiter ${pct((px / p.entryPrice - 1) * 100)}`);
    } finally { this.confirming.delete(p.id); }
  }

  private exit(p: Position, reason: string) {
    this.exiting.add(p.id);
    bus.decide({ agent: 'RISK', kind: 'info', mint: p.mint, symbol: p.symbol, reason: `EXIT ORDER ${sym(p.symbol, p.mint)}: ${reason} → EXECUTOR` });
    bus.emit('exit.order', { positionId: p.id, mint: p.mint, reason, markPrice: p.lastPrice });
  }
  /** In shadow mode: the cooldown that WOULD have blocked an entry right now, else null */
  shadowCooldown(): string | null {
    const s = this.d.state, now = clock.now();
    if (CONFIG.cooldownMode !== 'shadow' || s.cooldownUntil <= now) return null;
    return `${s.lossStreak} losses in a row, ${Math.ceil((s.cooldownUntil - now) / 60_000)} min left`;
  }
  /** Executor reports a failed sell → allow Risk to re-issue on the next tick */
  exitFailed(positionId: string) { this.exiting.delete(positionId); }

  private onClosed(t: ClosedTrade) {
    const s = this.d.state;
    this.exiting.delete(t.id);
    this.unconfirmed.delete(t.id);
    this.pendingJump.delete(t.id);
    if (t.pnlSol < 0) {
      s.lossStreak++;
      s.revengeBans[t.mint] = clock.now() + CONFIG.revengeBanHours * 3600_000;
      if (s.lossStreak >= 3) s.cooldownUntil = clock.now() + CONFIG.lossStreakLongCooldownMin * 60_000;
      else if (s.lossStreak >= 2) s.cooldownUntil = clock.now() + CONFIG.lossStreakCooldownMin * 60_000;
      if (s.cooldownUntil > clock.now())
        bus.decide({ agent: 'RISK', kind: 'warn', reason: CONFIG.cooldownMode === 'shadow'
          ? `${s.lossStreak} losses in a row → cooldown ${Math.round((s.cooldownUntil - clock.now()) / 60_000)} min (SHADOW: not blocking, trades tagged)`
          : `${s.lossStreak} losses in a row → no new entries for ${Math.round((s.cooldownUntil - clock.now()) / 60_000)} min` });
    } else s.lossStreak = 0;
    this.checkDaily();
  }

  private checkDaily() {
    const s = this.d.state;
    const dd = (equityOf(s) / s.dayStartEquity - 1) * 100;
    if (!s.dailyHalted && dd <= -CONFIG.dailyLossHaltPct) {
      s.dailyHalted = true;
      bus.decide({ agent: 'RISK', kind: 'warn', reason: `DAILY HALT: equity ${pct(dd)} today. No new entries until ${CONFIG.recapTz} midnight. Open positions still managed.` });
    }
  }

  private dayRoll() {
    const s = this.d.state;
    for (const [m, until] of Object.entries(s.revengeBans)) if (until < clock.now()) delete s.revengeBans[m];
    const key = this.dayFmt.format(new Date(clock.now()));
    if (key !== s.dayKey) {
      if (s.dayKey) bus.decide({ agent: 'RISK', kind: 'info', reason: `new trading day ${key}: daily limit reset` });
      s.dayKey = key; s.dayStartEquity = equityOf(s); s.dailyHalted = false;
    }
  }
}
