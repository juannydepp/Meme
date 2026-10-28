import { CONFIG } from './config';
import { readJson, type DeskState } from './store';
import { clock } from './clock';

// The go-live gate. Live trading refuses to start until paper results clear every bar.
export const GOLIVE_RULES = {
  minPaperHours: 72,
  minClosedTrades: 40,
  minProfitFactor: 1.2,
  maxDrawdownPct: 15,
};

export function maxDrawdownPct(curve: { v: number }[]) {
  let peak = -Infinity, dd = 0;
  for (const p of curve) { peak = Math.max(peak, p.v); dd = Math.max(dd, (1 - p.v / peak) * 100); }
  return dd;
}

export function goLiveReport(s: DeskState | null) {
  const lines: { ok: boolean; text: string }[] = [];
  if (!s) return { ok: false, lines: [{ ok: false, text: 'no paper session found (data/state.paper.json)' }] };
  const hours = (clock.now() - s.sessionStartedAt) / 3600_000;
  const n = s.closed.length;
  const gw = s.closed.filter((t) => t.pnlSol > 0).reduce((a, t) => a + t.pnlSol, 0);
  const gl = -s.closed.filter((t) => t.pnlSol < 0).reduce((a, t) => a + t.pnlSol, 0);
  const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
  const dd = maxDrawdownPct(s.equity);
  lines.push({ ok: hours >= GOLIVE_RULES.minPaperHours, text: `paper runtime ${hours.toFixed(1)}h (need ${GOLIVE_RULES.minPaperHours}h)` });
  lines.push({ ok: n >= GOLIVE_RULES.minClosedTrades, text: `closed paper trades ${n} (need ${GOLIVE_RULES.minClosedTrades})` });
  lines.push({ ok: pf >= GOLIVE_RULES.minProfitFactor, text: `profit factor ${pf === Infinity ? '∞' : pf.toFixed(2)} (need ≥ ${GOLIVE_RULES.minProfitFactor})` });
  lines.push({ ok: dd <= GOLIVE_RULES.maxDrawdownPct, text: `max drawdown ${dd.toFixed(1)}% (need ≤ ${GOLIVE_RULES.maxDrawdownPct}%)` });
  lines.push({ ok: s.violations.length === 0, text: `hard-limit violations ${s.violations.length} (need 0)` });
  return { ok: lines.every((l) => l.ok), lines };
}

if (process.argv[1]?.endsWith('golive.ts')) {
  const s = readJson<DeskState | null>('state.paper.json', null);
  const r = goLiveReport(s);
  console.log(`\nGO-LIVE CHECK (${CONFIG.mode})`);
  for (const l of r.lines) console.log(`  ${l.ok ? '✔' : '✘'} ${l.text}`);
  console.log(r.ok ? '\n  READY. To go live: set MODE=live and LIVE_CONFIRM=I_ACCEPT_REAL_LOSSES in .env, then ./desk restart\n'
    : '\n  NOT READY. Keep paper trading.\n');
}
