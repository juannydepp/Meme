import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, HARD } from './config';
import { readJson, type DeskState } from './store';
import type { Decision } from './types';

// Rule audit: replays the logs and proves every hard rule held. Run: ./desk audit

const name = CONFIG.data === 'sim' ? 'state.sim.json' : `state.${CONFIG.mode}.json`;
const s = readJson<DeskState | null>(name, null);
if (!s) { console.log('no state'); process.exit(1); }
const ds: Decision[] = [];
for (const day of fs.existsSync(CONFIG.logDir) ? fs.readdirSync(CONFIG.logDir).sort() : []) {
  const f = path.join(CONFIG.logDir, day, 'decisions.jsonl');
  if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l) ds.push(JSON.parse(l));
}
ds.sort((a, b) => a.ts - b.ts);

const results: { rule: string; ok: boolean; detail: string }[] = [];
const check = (rule: string, bad: string[], n: number) => results.push({ rule, ok: bad.length === 0, detail: bad.length ? bad.slice(0, 5).join(' | ') : `${n} checked` });

// replay balance to verify each buy against the balance at that moment
let bal = s.startBalanceSol; const sizeBad: string[] = []; let buys = 0;
const open = new Map<string, number>(); const avgDownBad: string[] = [];
const lossAt = new Map<string, number>(); const revengeBad: string[] = [];
const passedMints = new Set<string>(); const approved = new Map<string, number>(); const gateBad: string[] = [];
const reasonBad: string[] = [];
for (const d of ds) {
  const data = (d.data ?? {}) as any;
  if (['kill', 'reject', 'buy', 'exit'].includes(d.kind) && (!d.reason || d.reason.length < 12)) reasonBad.push(`${d.agent} ${d.kind} without reason`);
  if (d.agent === 'FILTER' && d.kind === 'pass' && d.mint) {
    if ((data.checks ?? []).some((c: any) => !c.pass)) gateBad.push(`filter passed ${d.symbol} with a failing check`);
    passedMints.add(d.mint);
  }
  if (d.agent === 'ANALYST' && d.kind === 'score' && d.mint) approved.set(d.mint, data.score);
  if (d.agent === 'EXECUTOR' && d.kind === 'buy' && d.mint) {
    buys++;
    if (!passedMints.has(d.mint)) gateBad.push(`bought ${d.symbol} without a filter pass`);
    if (!(approved.get(d.mint)! >= HARD.MIN_ANALYST_SCORE)) gateBad.push(`bought ${d.symbol} without score ≥ 0.6`);
    // swap input must be ≤ 8% of balance (cost includes a ~0.0002 SOL fee estimate)
    if (data.cost - 0.0003 > HARD.MAX_POSITION_PCT * bal + 1e-9) sizeBad.push(`${d.symbol} cost ${data.cost} vs 8% of ${bal.toFixed(4)}`);
    if (open.has(d.mint)) avgDownBad.push(`added to open ${d.symbol}`);
    if ((lossAt.get(d.mint) ?? -Infinity) > d.ts - 24 * 3600_000) revengeBad.push(`re-bought ${d.symbol} within 24h of a loss`);
    open.set(d.mint, d.ts); bal -= data.cost;
  }
  if (d.agent === 'EXECUTOR' && d.kind === 'exit' && d.mint) {
    open.delete(d.mint); bal += data.proceeds;
    if (data.pnlSol < 0) lossAt.set(d.mint, d.ts);
  }
}
check('every buy ≤ 8% of balance at that moment', sizeBad, buys);
check('every buy had a Filter pass + Analyst score ≥ 0.6', gateBad, buys);
check('no averaging down (never added to an open token)', avgDownBad, buys);
check('no revenge trades (no re-buy within 24h of a loss)', revengeBad, buys);
check('every kill / reject / trade has a logged reason', reasonBad, ds.length);

const stopBad: string[] = [], trailBad: string[] = [];
for (const t of s.closed) {
  if (t.exitReason.startsWith('hard stop')) {
    const markChg = (Number(t.exitReason.match(/at ([+-][\d.]+)%/)?.[1]) || 0);
    if (markChg > -HARD.STOP_LOSS_PCT * 100 + 0.01) stopBad.push(`${t.symbol} stopped at ${markChg}%`);
  }
  if (t.exitReason.startsWith('trailing')) {
    if (t.peakPrice < t.entryPrice * (1 + HARD.TRAIL_ACTIVATE_PCT) - 1e-12) trailBad.push(`${t.symbol} trailed before +12% (peak ${((t.peakPrice / t.entryPrice - 1) * 100).toFixed(1)}%)`);
  }
}
check('hard stops fire at -6% (mark vs cost basis)', stopBad, s.closed.length);
check('trailing only after +12%', trailBad, s.closed.length);
check('zero hard-limit violations recorded', s.violations, 1);

const worst = s.closed.reduce((m, t) => Math.min(m, t.pnlPct), 0);
console.log(`\nRULE AUDIT — ${s.closed.length} closed trades, ${ds.length} decisions\n`);
for (const r of results) console.log(`  ${r.ok ? '✔' : '✘'} ${r.rule}  ${r.ok ? `(${r.detail})` : `\n      ${r.detail}`}`);
console.log(`\n  worst realized trade: ${worst.toFixed(2)}% (stop is -6% on mark; slippage on a gap can push fills past it)\n`);
process.exit(results.every((r) => r.ok) ? 0 : 2);
