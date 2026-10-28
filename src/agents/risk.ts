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
  constructor(private d: Desk) {}

  start() {
    bus.on('position.opened', (p) => {
      activity.inc('RISK', 'watching');
      bus.decide({ agent: 'RISK', kind: 'info', mint: p.mint, symbol: p.symbol,
        reason: `WATCH ${sym(p.symbol, p.mint)} stop ${p.stopPrice.toPrecision(4)} (-${(CONFIG.stopLossPct * 100).toFixed(0)}%), trail arms at +${(CONFIG.trailActivatePct * 100).toFixed(0)}%` });
    });
    bus.on('position.closed', (t) => this.onClosed(t));
    clock.every(3000, () => this.tick().catch((e) => bus.decide({ agent: 'RISK', kind: 'error', reason: `risk tick failed: ${e?.message ?? e}` })));
    clock.every(60_000, () => this.dayRoll());
    this.dayRoll();
  }

  /** The Executor must call this before every buy. Returns null if allowed, else the reason. */
  mayOpen(mint: string): string | null {
    const s = this.d.state, now = clock.now();
    if (s.positions.some((p) => p.mint === mint)) return 'already holding this token (no averaging down)';
    if ((s.revengeBans[mint] ?? 0) > now) return `token stopped us out — banned until ${new Date(s.revengeBans[mint]).toISOString().slice(11, 16)}Z (no revenge trades)`;
    if (s.dailyHalted) return `daily loss limit hit (-${CONFIG.dailyLossHaltPct}%) — no new entries until tomorrow`;
    if (s.cooldownUntil > now) return `loss-streak cooldown (${s.lossStreak} straight losses) for ${Math.ceil((s.cooldownUntil - now) / 60_000)} more min`;
    if (s.positions.length >= CONFIG.maxOpenPositions) return `max ${CONFIG.maxOpenPositions} open positions`;
    return null;
  }

  private async tick() {
    const s = this.d.state;
    this.checkDaily();
    if (!s.positions.length) { activity.state('RISK', s.dailyHalted ? 'halted' : 'idle'); return; }
    activity.state('RISK', 'busy');
    let snaps = new Map();
    try { snaps = await this.d.market.pairs(s.positions.map((p) => p.mint)); } catch { /* handled via blackout rule */ }
    const now = clock.now();
    for (const p of [...s.positions]) {
      if (this.exiting.has(p.id)) continue;
      const snap = snaps.get(p.mint);
      if (snap && snap.priceSol > 0) { p.lastPrice = snap.priceSol; p.lastPriceAt = now; p.lastLiquidityUsd = snap.liquidityUsd; }
      const chg = (p.lastPrice / p.entryPrice - 1);

      if (now - p.lastPriceAt > CONFIG.priceBlackoutExitSec * 1000) { this.exit(p, `no price data for ${CONFIG.priceBlackoutExitSec}s — exiting blind`); continue; }
      if (p.lastLiquidityUsd < p.entryLiquidityUsd * (1 - CONFIG.liquidityPullExitPct / 100)) {
        this.exit(p, `pool liquidity down ${((1 - p.lastLiquidityUsd / p.entryLiquidityUsd) * 100).toFixed(0)}% since entry — possible pull`); continue;
      }
      if (p.lastPrice > p.peakPrice) p.peakPrice = p.lastPrice;
      if (!p.trailActive && p.peakPrice >= p.entryPrice * (1 + CONFIG.trailActivatePct)) {
        p.trailActive = true;
        bus.decide({ agent: 'RISK', kind: 'info', mint: p.mint, symbol: p.symbol, reason: `TRAIL ARMED ${sym(p.symbol, p.mint)} at ${pct(chg * 100)} — exits ${(CONFIG.trailDistancePct * 100).toFixed(0)}% below peak` });
      }
      if (p.trailActive) p.stopPrice = Math.max(p.stopPrice, p.peakPrice * (1 - CONFIG.trailDistancePct));
      if (p.lastPrice <= p.stopPrice) {
        this.exit(p, p.trailActive
          ? `trailing stop: ${pct(chg * 100)} (peak ${pct((p.peakPrice / p.entryPrice - 1) * 100)})`
          : `hard stop -${(CONFIG.stopLossPct * 100).toFixed(0)}%: at ${pct(chg * 100)}`);
      }
    }
  }

  private exit(p: Position, reason: string) {
    this.exiting.add(p.id);
    bus.decide({ agent: 'RISK', kind: 'info', mint: p.mint, symbol: p.symbol, reason: `EXIT ORDER ${sym(p.symbol, p.mint)}: ${reason} → EXECUTOR` });
    bus.emit('exit.order', { positionId: p.id, mint: p.mint, reason, markPrice: p.lastPrice });
  }
  /** Executor reports a failed sell → allow Risk to re-issue on the next tick */
  exitFailed(positionId: string) { this.exiting.delete(positionId); }

  private onClosed(t: ClosedTrade) {
    const s = this.d.state;
    this.exiting.delete(t.id);
    if (t.pnlSol < 0) {
      s.lossStreak++;
      s.revengeBans[t.mint] = clock.now() + CONFIG.revengeBanHours * 3600_000;
      if (s.lossStreak >= 3) s.cooldownUntil = clock.now() + CONFIG.lossStreakLongCooldownMin * 60_000;
      else if (s.lossStreak >= 2) s.cooldownUntil = clock.now() + CONFIG.lossStreakCooldownMin * 60_000;
      if (s.cooldownUntil > clock.now())
        bus.decide({ agent: 'RISK', kind: 'warn', reason: `${s.lossStreak} losses in a row → no new entries for ${Math.round((s.cooldownUntil - clock.now()) / 60_000)} min` });
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
