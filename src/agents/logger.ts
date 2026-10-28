import fs from 'node:fs';
import path from 'node:path';
import { activity, bus } from '../bus';
import { clock } from '../clock';
import { CONFIG } from '../config';
import type { Desk } from '../desk';
import { equityOf, sym } from '../desk';
import { readJson, saveCreators, saveState, writeJson } from '../store';
import type { ClosedTrade, Decision } from '../types';

// LOGGER — writes the reason behind every trade and every rejection, and keeps score.
//   logs/<day>/decisions.jsonl  every decision by every agent, with its reason and data
//   logs/<day>/trades.csv       one row per closed trade (entry reason, exit reason, P&L)
//   logs/outcomes.jsonl         what happened to every token we judged, 24h later
//   data/live.json              snapshot the terminal reads
// It also watches what killed tokens did afterwards: if a token's pool is pulled within
// 24h, its dev is marked as a rugger and blacklisted — the desk learns.

interface Tracked {
  mint: string; symbol: string; creator: string | null; verdict: 'filter-kill' | 'analyst-reject' | 'traded';
  reason: string; firstAt: number; firstPrice: number; firstLiq: number; peak: number; low: number; lastLiq: number;
  died: boolean; rugged: boolean;
}

export class Logger {
  private feed: Decision[] = [];
  private tracked = new Map<string, Tracked>();
  private dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.recapTz, year: 'numeric', month: '2-digit', day: '2-digit' });
  private hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.recapTz, hour: '2-digit', hourCycle: 'h23' });
  private statusLines: Record<string, { msg: string; ok: boolean }> = {};
  private waitingCount = () => 0;
  onRecapDue: (() => Promise<void>) | null = null;

  constructor(private d: Desk) {
    fs.mkdirSync(CONFIG.logDir, { recursive: true });
    // resume tracking judged tokens across restarts
    for (const t of readJson<Tracked[]>('outcomes.pending.json', [])) this.tracked.set(t.mint, t);
  }
  setWaitingCounter(f: () => number) { this.waitingCount = f; }

  private dayDir(ts = clock.now()) {
    const dir = path.join(CONFIG.logDir, this.dayFmt.format(new Date(ts)));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  start() {
    activity.state('LOGGER', 'busy');
    bus.on('decision', (d) => this.record(d));
    bus.on('position.closed', (t) => this.tradeRow(t));
    bus.on('position.opened', (p) => this.track(p.mint, p.symbol, null, 'traded', p.entryReason, p.lastPrice, p.entryLiquidityUsd));
    // real-time snapshot for the terminal (wall clock, not sim clock)
    setInterval(() => this.snapshot(), 1000);
    clock.every(60_000, () => { this.d.state.equity.push({ t: clock.now(), v: equityOf(this.d.state) }); saveState(this.d.state); saveCreators(this.d.creators); this.recapCheck(); });
    clock.every(5 * 60_000, () => this.outcomes().catch(() => {}));
  }

  private record(d: Decision) {
    if (d.agent === 'SCOUT' && (d.kind === 'info' || d.kind === 'warn')) this.statusLines[d.reason.split(' ')[0]] = { msg: d.reason, ok: d.kind === 'info' };
    if (d.kind !== 'hold' || (d.data as any)?.attempt === 0) { this.feed.push(d); if (this.feed.length > 80) this.feed.shift(); }
    fs.appendFileSync(path.join(this.dayDir(d.ts), 'decisions.jsonl'), JSON.stringify(d) + '\n');
    activity.inc('LOGGER', 'lines');
    if (d.kind === 'error') activity.inc('LOGGER', 'errors');
    // start tracking what judged tokens do next
    const data = d.data as any;
    if (d.agent === 'FILTER' && d.kind === 'kill' && d.mint) this.track(d.mint, d.symbol ?? '', data?.creator ?? null, 'filter-kill', d.reason, data?.price ?? 0, data?.liq ?? 0);
    if (d.agent === 'ANALYST' && d.kind === 'reject' && d.mint) this.track(d.mint, d.symbol ?? '', null, 'analyst-reject', d.reason, 0, 0);
  }

  private track(mint: string, symbol: string, creator: string | null, verdict: Tracked['verdict'], reason: string, price: number, liq: number) {
    const known = this.d.creators.mintCreator[mint];
    this.tracked.set(mint, { mint, symbol, creator: creator ?? known?.creator ?? null, verdict, reason, firstAt: clock.now(),
      firstPrice: price, firstLiq: liq, peak: price, low: price, lastLiq: liq, died: false, rugged: false });
    if (this.tracked.size > 3000) this.tracked.delete(this.tracked.keys().next().value!);
  }

  private async outcomes() {
    const now = clock.now();
    const open = [...this.tracked.values()];
    if (!open.length) return;
    const snaps = await this.d.market.pairs(open.map((t) => t.mint));
    for (const t of open) {
      const s = snaps.get(t.mint);
      if (s) {
        if (!t.firstPrice) { t.firstPrice = s.priceSol; t.peak = s.priceSol; t.low = s.priceSol; t.firstLiq = s.liquidityUsd; }
        t.peak = Math.max(t.peak, s.priceSol); t.low = Math.min(t.low, s.priceSol); t.lastLiq = s.liquidityUsd;
        if (!t.died && (s.priceSol <= t.firstPrice * 0.2 || s.liquidityUsd <= t.firstLiq * 0.2)) t.died = true;
        // A pool's USD liquidity falls naturally with price (≈ √price in a constant-product pool).
        // It's only a PULL when liquidity collapses far below what the price drop explains.
        const liqRatio = t.firstLiq > 0 ? s.liquidityUsd / t.firstLiq : 1;
        const expected = t.firstPrice > 0 ? Math.sqrt(Math.max(0, s.priceSol / t.firstPrice)) : 1;
        if (!t.rugged && liqRatio <= 0.2 && liqRatio < expected * 0.4) {
          t.rugged = true;
          if (t.creator) {
            const db = this.d.creators;
            (db.rugged[t.creator] ??= []).push(t.mint);
            db.blacklist[t.creator] = `pool pulled on ${sym(t.symbol, t.mint)} ${new Date(now).toISOString().slice(0, 10)}`;
            bus.decide({ agent: 'LOGGER', kind: 'warn', mint: t.mint, symbol: t.symbol,
              reason: `RUG observed on ${sym(t.symbol, t.mint)} (liquidity -${((1 - s.liquidityUsd / t.firstLiq) * 100).toFixed(0)}%) → dev ${t.creator.slice(0, 4)}… blacklisted` });
          }
        }
      }
      if (now - t.firstAt >= 24 * 3600_000) {
        fs.appendFileSync(path.join(CONFIG.logDir, 'outcomes.jsonl'), JSON.stringify({ ...t, resolvedAt: now,
          peakPct: t.firstPrice ? (t.peak / t.firstPrice - 1) * 100 : null, lowPct: t.firstPrice ? (t.low / t.firstPrice - 1) * 100 : null }) + '\n');
        this.tracked.delete(t.mint);
      }
    }
    // interim outcomes so the morning recap can report on tokens that are < 24h old
    writeJson('outcomes.pending.json', [...this.tracked.values()]);
  }

  private tradeRow(t: ClosedTrade) {
    const f = path.join(this.dayDir(t.closedAt), 'trades.csv');
    if (!fs.existsSync(f)) fs.writeFileSync(f, 'opened,closed,symbol,mint,cost_sol,proceeds_sol,pnl_sol,pnl_pct,held_min,entry_reason,exit_reason\n');
    const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
    fs.appendFileSync(f, [new Date(t.openedAt).toISOString(), new Date(t.closedAt).toISOString(), t.symbol, t.mint, t.costSol.toFixed(5), t.proceedsSol.toFixed(5),
      t.pnlSol.toFixed(5), t.pnlPct.toFixed(2), ((t.closedAt - t.openedAt) / 60_000).toFixed(1), q(t.entryReason), q(t.exitReason)].join(',') + '\n');
  }

  private async recapCheck() {
    const now = new Date(clock.now());
    const day = this.dayFmt.format(now), hour = Number(this.hourFmt.format(now));
    if (hour === CONFIG.recapHour && this.d.state.lastRecapDay !== day && this.onRecapDue) {
      this.d.state.lastRecapDay = day;
      await this.onRecapDue().catch((e) => bus.decide({ agent: 'LOGGER', kind: 'error', reason: `recap failed: ${e?.message ?? e}` }));
    }
  }

  snapshot() {
    const s = this.d.state, eq = equityOf(s);
    writeJson('live.json', {
      at: clock.now(), mode: s.mode, data: this.d.market.kind, speed: clock.speed, startedAt: s.sessionStartedAt,
      startBalance: s.startBalanceSol, balance: s.balanceSol, equity: eq, solUsd: this.d.solUsd,
      dayStartEquity: s.dayStartEquity, dailyHalted: s.dailyHalted, cooldownUntil: s.cooldownUntil, lossStreak: s.lossStreak,
      positions: s.positions.map((p) => ({ symbol: p.symbol, mint: p.mint, costSol: p.costSol, valueSol: p.lastPrice * p.tokens, pnlPct: (p.lastPrice * p.tokens / p.costSol - 1) * 100,
        stopPct: (p.stopPrice / p.entryPrice - 1) * 100, trail: p.trailActive, peakPct: (p.peakPrice / p.entryPrice - 1) * 100, openedAt: p.openedAt })),
      closed: { n: s.closed.length, wins: s.closed.filter((t) => t.pnlSol > 0).length, pnl: s.closed.reduce((a, t) => a + t.pnlSol, 0) },
      agents: [...activity.agents.values()], waiting: this.waitingCount(), feeds: this.statusLines,
      equityCurve: s.equity.slice(-400), feed: this.feed.slice(-40), violations: s.violations.length,
    });
  }
}
