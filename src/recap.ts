import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config';
import { clock } from './clock';
import { equityOf, pct, sym } from './desk';
import { goLiveReport, maxDrawdownPct } from './golive';
import { readJson, type DeskState } from './store';
import type { Decision } from './types';

// Morning recap: what happened since the last recap (or the last `hours`).
// Saved to recaps/recap-<date>.md and sent to Telegram if configured.

function readDecisions(since: number): Decision[] {
  const out: Decision[] = [];
  if (!fs.existsSync(CONFIG.logDir)) return out;
  for (const day of fs.readdirSync(CONFIG.logDir).sort()) {
    const f = path.join(CONFIG.logDir, day, 'decisions.jsonl');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try { const d = JSON.parse(line) as Decision; if (d.ts >= since) out.push(d); } catch { /* skip */ }
    }
  }
  return out;
}

function sparkline(vals: number[], width = 48) {
  if (vals.length < 2) return '';
  const step = Math.max(1, Math.floor(vals.length / width));
  const pts = vals.filter((_, i) => i % step === 0);
  const lo = Math.min(...pts), hi = Math.max(...pts), bars = '▁▂▃▄▅▆▇█';
  return pts.map((v) => bars[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join('');
}

export function buildRecap(s: DeskState, sinceTs?: number) {
  const now = clock.now();
  const since = sinceTs ?? Math.max(s.sessionStartedAt, now - 24 * 3600_000);
  const ds = readDecisions(since);
  const trades = s.closed.filter((t) => t.closedAt >= since);
  const eqWindow = s.equity.filter((p) => p.t >= since);
  const startEq = eqWindow[0]?.v ?? s.startBalanceSol, endEq = equityOf(s);
  const wins = trades.filter((t) => t.pnlSol > 0), losses = trades.filter((t) => t.pnlSol <= 0);
  const gw = wins.reduce((a, t) => a + t.pnlSol, 0), gl = -losses.reduce((a, t) => a + t.pnlSol, 0);
  const count = (agent: string, kind: string) => ds.filter((d) => d.agent === agent && d.kind === kind).length;

  const killReasons = new Map<string, number>();
  for (const d of ds.filter((x) => x.agent === 'FILTER' && x.kind === 'kill'))
    for (const k of ((d.data as any)?.killedBy ?? ['unknown']) as string[]) killReasons.set(k, (killReasons.get(k) ?? 0) + 1);
  const execRefusals = new Map<string, number>();
  for (const d of ds.filter((x) => x.agent === 'EXECUTOR' && x.kind === 'reject')) {
    const k = d.reason.replace(/^REFUSE \S+: /, '').replace(/\d+(\.\d+)?/g, 'N').slice(0, 60);
    execRefusals.set(k, (execRefusals.get(k) ?? 0) + 1);
  }
  const errors = ds.filter((d) => d.kind === 'error');
  const warns = ds.filter((d) => d.kind === 'warn' && d.agent !== 'SCOUT');

  // what did the tokens we refused do?
  const pending = readJson<any[]>('outcomes.pending.json', []);
  let resolved: any[] = [];
  try { resolved = fs.readFileSync(path.join(CONFIG.logDir, 'outcomes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.firstAt >= since - 24 * 3600_000); } catch { /* none yet */ }
  const outs = [...resolved, ...pending].filter((o) => o.firstAt >= since);
  const kills = outs.filter((o) => o.verdict === 'filter-kill'), rejects = outs.filter((o) => o.verdict === 'analyst-reject');
  const died = (a: any[]) => a.filter((o) => o.died).length;
  const ranAway = (a: any[]) => a.filter((o) => o.firstPrice && o.peak / o.firstPrice >= 1.5).length;

  const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.recapTz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(now));
  const hours = ((now - since) / 3600_000).toFixed(1);
  const L: string[] = [];
  L.push(`# Desk recap — ${dayStr}`);
  L.push(`${s.mode.toUpperCase()} mode · ${hours}h window · data: ${CONFIG.data}`);
  L.push('');
  L.push(`## Bottom line`);
  L.push(`- Equity **${startEq.toFixed(3)} → ${endEq.toFixed(3)} SOL** (${pct((endEq / startEq - 1) * 100, 2)})`);
  L.push(`- Trades **${trades.length}** · ${wins.length}W / ${losses.length}L${trades.length ? ` · win rate ${((wins.length / trades.length) * 100).toFixed(0)}%` : ''}`);
  if (trades.length) {
    L.push(`- Avg win ${wins.length ? pct(wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length) : '—'} · avg loss ${losses.length ? pct(losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length) : '—'} · profit factor ${gl > 0 ? (gw / gl).toFixed(2) : gw > 0 ? '∞' : '—'}`);
  }
  L.push(`- Max drawdown in window ${maxDrawdownPct(eqWindow).toFixed(1)}% · open positions ${s.positions.length}`);
  L.push(`- Hard-limit violations: **${s.violations.length}**${s.dailyHalted ? ' · ⚠ daily loss halt is ACTIVE' : ''}`);
  if (eqWindow.length > 2) { L.push(''); L.push('```'); L.push(`equity ${sparkline(eqWindow.map((p) => p.v))}`); L.push('```'); }
  L.push('');
  L.push(`## Funnel`);
  L.push(`| Stage | Count |`); L.push(`|---|---|`);
  L.push(`| Scout: leads (graduations + new pools) | ${count('SCOUT', 'scout')} |`);
  L.push(`| Filter: killed | ${count('FILTER', 'kill')} |`);
  L.push(`| Filter: passed | ${count('FILTER', 'pass')} |`);
  L.push(`| Analyst: scored < ${CONFIG.minScore} (no trade) | ${count('ANALYST', 'reject')} |`);
  L.push(`| Analyst: approved | ${count('ANALYST', 'score')} |`);
  L.push(`| Executor: refused (risk policy / stale data) | ${count('EXECUTOR', 'reject')} |`);
  L.push(`| Executor: bought | ${count('EXECUTOR', 'buy')} |`);
  L.push('');
  if (killReasons.size) {
    L.push(`**What killed leads:** ` + [...killReasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '));
    L.push('');
  }
  if (execRefusals.size) {
    L.push(`**Executor refusals:** ` + [...execRefusals.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(' · '));
    L.push('');
  }
  L.push(`## Did the refusals pay?`);
  if (!outs.length) L.push(`Not enough time has passed to judge refused tokens yet.`);
  else {
    L.push(`- Filter kills tracked: ${kills.length} · **${died(kills)} died** (price -80% or pool pulled) · ${ranAway(kills)} ran +50% after the kill`);
    L.push(`- Analyst no-trades tracked: ${rejects.length} · ${died(rejects)} died · ${ranAway(rejects)} ran +50%`);
    L.push(`- Devs auto-blacklisted after observed rugs: ${ds.filter((d) => d.agent === 'LOGGER' && d.reason.startsWith('RUG observed')).length}`);
  }
  L.push('');
  L.push(`## Every trade`);
  if (!trades.length) L.push('No trades closed in this window.');
  for (const t of trades) {
    const held = ((t.closedAt - t.openedAt) / 60_000).toFixed(0);
    L.push(`**${sym(t.symbol, t.mint)}** ${pct(t.pnlPct)} (${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)} SOL) · ${t.costSol.toFixed(3)} SOL · held ${held}m`);
    L.push(`- in: ${t.entryReason}`);
    L.push(`- out: ${t.exitReason}`);
    L.push(`- \`${t.mint}\``);
    L.push('');
  }
  if (s.positions.length) {
    L.push(`## Still open`);
    for (const p of s.positions) L.push(`- ${sym(p.symbol, p.mint)} ${pct((p.lastPrice * p.tokens / p.costSol - 1) * 100)} · stop ${pct((p.stopPrice / p.entryPrice - 1) * 100)}${p.trailActive ? ' (trailing)' : ''}`);
    L.push('');
  }
  L.push(`## Incidents`);
  if (!errors.length && !warns.length) L.push('None.');
  for (const e of [...warns, ...errors].slice(-15)) L.push(`- ${new Date(e.ts).toISOString().slice(11, 16)}Z ${e.agent} ${e.kind}: ${e.reason}`);
  if (errors.length + warns.length > 15) L.push(`- …and ${errors.length + warns.length - 15} more in the logs`);
  L.push('');
  if (s.mode === 'paper') {
    const g = goLiveReport(s);
    L.push(`## Go-live readiness: ${g.ok ? 'READY' : 'not yet'}`);
    for (const l of g.lines) L.push(`- ${l.ok ? '✅' : '⬜'} ${l.text}`);
    L.push('');
  }
  L.push(`_Full reasons for every decision: logs/<day>/decisions.jsonl · trades: logs/<day>/trades.csv_`);
  return L.join('\n');
}

export async function writeAndSendRecap(s: DeskState, since?: number) {
  const md = buildRecap(s, since);
  fs.mkdirSync('recaps', { recursive: true });
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.recapTz }).format(new Date(clock.now()));
  const file = path.join('recaps', `recap-${day}.md`);
  fs.writeFileSync(file, md);
  if (CONFIG.telegramToken && CONFIG.telegramChat) {
    const text = md.replace(/\*\*/g, '').replace(/`/g, '').replace(/^#+ /gm, '').slice(0, 3900);
    await fetch(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.telegramChat, text, disable_web_page_preview: true }),
    }).catch(() => {});
  }
  return file;
}

if (process.argv[1]?.endsWith('recap.ts')) {
  const name = CONFIG.data === 'sim' ? 'state.sim.json' : `state.${CONFIG.mode}.json`;
  const s = readJson<DeskState | null>(name, null);
  if (!s) { console.log(`No desk state found (${name}). Has the desk run yet?`); process.exit(1); }
  const hrs = Number(process.argv[2] ?? 0);
  // CLI runs on wall clock; for a sim state, end the window at its last equity sample
  const last = s.equity[s.equity.length - 1]?.t ?? Date.now();
  const end = CONFIG.data === 'sim' ? last : Date.now();
  (clock as any).now = () => end;
  writeAndSendRecap(s, hrs ? end - hrs * 3600_000 : undefined).then((f) => { console.log(fs.readFileSync(f, 'utf8')); console.log(`\nsaved → ${f}`); });
}
