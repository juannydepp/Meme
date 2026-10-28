import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';

// Live terminal. Reads the snapshot the desk writes every second, so it can be
// opened/closed from any SSH session (phone included) without touching the desk.
// Run: ./desk terminal   ·   q to quit

const E = '\x1b[';
const c = {
  dim: (s: string) => `${E}2m${s}${E}22m`, bold: (s: string) => `${E}1m${s}${E}22m`,
  g: (s: string) => `${E}32m${s}${E}39m`, r: (s: string) => `${E}31m${s}${E}39m`, y: (s: string) => `${E}33m${s}${E}39m`,
  cy: (s: string) => `${E}36m${s}${E}39m`, m: (s: string) => `${E}35m${s}${E}39m`, inv: (s: string) => `${E}7m${s}${E}27m`,
};
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const vlen = (s: string) => [...strip(s)].length;
const fit = (s: string, w: number) => {
  if (vlen(s) <= w) return s + ' '.repeat(w - vlen(s));
  // cut visible chars, keep escape codes balanced by resetting at end
  let out = '', n = 0;
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) { out += part; continue; }
    for (const ch of part) { if (n >= w - 1) break; out += ch; n++; }
  }
  return out + '…' + `${E}0m`;
};
const sgn = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
const colorPct = (v: number, d = 1) => (v >= 0 ? c.g : c.r)(`${sgn(v, d)}%`);
const ago = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`; };
const dur = (ms: number) => { const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`; };

const AGENT_COLOR: Record<string, (s: string) => string> = { SCOUT: c.cy, FILTER: c.y, ANALYST: c.m, EXECUTOR: c.g, RISK: c.r, LOGGER: c.dim };
const STATE_DOT: Record<string, string> = { idle: c.dim('○'), busy: c.g('●'), waiting: c.y('◐'), halted: c.r('■'), down: c.r('✕') };

function agentLine(a: any) {
  const k = a.counters ?? {};
  switch (a.name) {
    case 'SCOUT': return `${k.launches ?? 0} launches seen · ${k.leads ?? 0} leads`;
    case 'FILTER': return `${k.in ?? 0} in · ${c.g(String(k.pass ?? 0))} pass · ${c.r(String(k.kill ?? 0))} kill · ${k.hold ?? 0} held`;
    case 'ANALYST': return `${k.in ?? 0} scored · ${c.g(String(k.approve ?? 0))} ≥${CONFIG.minScore} · ${k.reject ?? 0} <${CONFIG.minScore}`;
    case 'EXECUTOR': return `${k.buys ?? 0} buys · ${k.sells ?? 0} sells · ${k.reject ?? 0} refused`;
    case 'RISK': return `${k.watching ?? 0} watched`;
    case 'LOGGER': return `${k.lines ?? 0} lines · ${(k.errors ?? 0) ? c.r(`${k.errors} errors`) : '0 errors'}`;
  }
  return '';
}

function chart(curve: { t: number; v: number }[], width: number, height: number, base: number) {
  if (curve.length < 2) return [c.dim('  collecting equity samples…')];
  const cols = Math.max(10, width - 9);
  const vals: number[] = [];
  for (let i = 0; i < cols; i++) vals.push(curve[Math.min(curve.length - 1, Math.floor((i / (cols - 1)) * (curve.length - 1)))].v);
  let lo = Math.min(...vals, base), hi = Math.max(...vals, base);
  if (hi - lo < 1e-9) { hi += 0.01; lo -= 0.01; }
  const blocks = ' ▁▂▃▄▅▆▇█';
  const rows: string[] = [];
  const baseLevel = ((base - lo) / (hi - lo)) * height;
  for (let r = height - 1; r >= 0; r--) {
    let line = '';
    for (const v of vals) {
      const h = ((v - lo) / (hi - lo)) * height;
      const fill = Math.max(0, Math.min(1, h - r));
      const ch = blocks[Math.round(fill * 8)];
      const paint = v >= base ? c.g : c.r;
      line += ch === ' ' ? (Math.floor(baseLevel) === r ? c.dim('·') : ' ') : paint(ch);
    }
    const label = r === height - 1 ? hi.toFixed(3) : r === 0 ? lo.toFixed(3) : '';
    rows.push(`${c.dim(label.padStart(7))} ${line}`);
  }
  return rows;
}

function render(): string {
  const W = Math.max(44, process.stdout.columns || 80), H = Math.max(24, process.stdout.rows || 40);
  const file = path.join(CONFIG.dataDir, 'live.json');
  let s: any;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return `\n  ${c.r('Desk not running')} — no ${file} yet.\n  Start it with: ./desk start\n`; }
  const stale = Date.now() - fs.statSync(file).mtimeMs > 10_000;
  const out: string[] = [];
  const hr = (title: string) => c.dim(`── ${title} ${'─'.repeat(Math.max(0, W - title.length - 4))}`);
  const now = s.at;
  const clockStr = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.recapTz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(now));
  const modeTag = s.mode === 'live' ? c.inv(c.r(' LIVE ')) : c.inv(c.y(' PAPER '));
  const dataTag = s.data === 'sim' ? c.m(` SIM x${s.speed}`) : c.dim(' live data');
  out.push(fit(`${c.bold('◆ MEMEDESK')} ${modeTag}${dataTag}${stale ? c.r('  ⚠ DESK NOT RESPONDING') : ''}`, W - 9) + c.dim(clockStr.padStart(9)));
  const pnl = s.equity - s.startBalance, pnlPct = (s.equity / s.startBalance - 1) * 100;
  const dayPct = (s.equity / s.dayStartEquity - 1) * 100;
  out.push(fit(` up ${dur(now - s.startedAt)} · SOL $${s.solUsd.toFixed(0)} · open ${s.positions.length}/${CONFIG.maxOpenPositions}${s.violations ? c.r(` · ${s.violations} VIOLATIONS`) : ''}`, W));
  out.push(fit(` ${c.dim('BALANCE')} ${c.bold(s.balance.toFixed(3))} SOL   ${c.dim('EQUITY')} ${c.bold(s.equity.toFixed(3))} SOL ${c.dim(`($${(s.equity * s.solUsd).toFixed(0)})`)}`, W));
  out.push(fit(` ${c.dim('P&L')} ${(pnl >= 0 ? c.g : c.r)(`${sgn(pnl, 3)} SOL`)} ${colorPct(pnlPct, 2)}   ${c.dim('today')} ${colorPct(dayPct)}   ${c.dim('trades')} ${s.closed.n} ${c.g(`${s.closed.wins}W`)}/${c.r(`${s.closed.n - s.closed.wins}L`)}`, W));
  const flags: string[] = [];
  if (s.dailyHalted) flags.push(c.r('■ DAILY LOSS HALT — no new entries today'));
  if (s.cooldownUntil > now) flags.push(c.y(`◐ cooldown ${ago(s.cooldownUntil - now)} (${s.lossStreak} losses in a row)`));
  for (const f of Object.values(s.feeds ?? {}) as any[]) if (!f.ok) flags.push(c.y(`⚠ ${f.msg}`));
  for (const f of flags) out.push(fit(' ' + f, W));

  out.push(hr('AGENTS'));
  for (const a of s.agents) {
    const name = AGENT_COLOR[a.name](a.name.padEnd(8));
    out.push(fit(` ${STATE_DOT[a.state] ?? '○'} ${name} ${agentLine(a)}${a.name === 'FILTER' && s.waiting ? c.y(` · ${s.waiting} waiting`) : ''}`, W));
    const when = a.lastAt ? c.dim(ago(now - a.lastAt).padStart(4)) : '';
    out.push(fit(`   ${c.dim('└')} ${c.dim(a.last)}`, W - 5) + ' ' + when);
  }

  out.push(hr(`POSITIONS ${s.positions.length}/${CONFIG.maxOpenPositions}`));
  if (!s.positions.length) out.push(c.dim(' flat — no open positions'));
  for (const p of s.positions) {
    const stop = p.trail ? c.cy(`trail ${sgn(p.stopPct)}%`) : c.dim(`stop ${sgn(p.stopPct)}%`);
    out.push(fit(` ${c.bold(('$' + p.symbol).padEnd(10))} ${colorPct(p.pnlPct).padEnd(16)} ${stop}  ${c.dim(`peak ${sgn(p.peakPct)}%`)}  ${p.costSol.toFixed(3)} SOL  ${c.dim(ago(now - p.openedAt))}`, W));
  }

  out.push(hr('EQUITY (SOL)'));
  const chartH = H >= 44 ? 8 : H >= 34 ? 6 : 4;
  out.push(...chart(s.equityCurve, W, chartH, s.startBalance));

  out.push(hr('FEED'));
  const room = Math.max(3, H - out.length - 1);
  const kindColor: Record<string, (x: string) => string> = { buy: c.g, exit: c.cy, kill: c.r, pass: c.g, score: c.m, reject: c.dim, error: c.r, warn: c.y, hold: c.dim, scout: c.dim, info: c.dim };
  const feed = (s.feed ?? []).slice(-room);
  for (const d of feed) {
    const t = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.recapTz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d.ts));
    out.push(fit(` ${c.dim(t)} ${AGENT_COLOR[d.agent](d.agent.slice(0, 4))} ${(kindColor[d.kind] ?? ((x: string) => x))(d.reason)}`, W));
  }
  return out.slice(0, H - 1).map((l) => l + `${E}0m${E}K`).join('\n');
}

if (process.argv.includes('--once')) {
  const s = render();
  console.log(process.argv.includes('--plain') ? strip(s) : s);
  process.exit(0);
}

process.stdout.write(`${E}?1049h${E}?25l`);
const restore = () => { process.stdout.write(`${E}?25h${E}?1049l`); process.exit(0); };
process.on('SIGINT', restore); process.on('SIGTERM', restore);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true); process.stdin.resume();
  process.stdin.on('data', (b) => { const k = b.toString(); if (k === 'q' || k === '\u0003') restore(); });
}
const draw = () => process.stdout.write(`${E}H` + render() + `${E}J`);
draw();
setInterval(draw, 700);
process.stdout.on('resize', () => { process.stdout.write(`${E}2J`); draw(); });
