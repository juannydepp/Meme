import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';

// Live terminal. Reads the snapshot the desk writes every second, so it can be
// opened/closed from any SSH session (phone included) without touching the desk.
// Fills whatever screen it gets: one column in portrait, two columns when wide.
// Run: ./desk terminal   ·   q to quit

const E = '\x1b[';
const c = {
  dim: (s: string) => `${E}2m${s}${E}22m`, bold: (s: string) => `${E}1m${s}${E}22m`,
  g: (s: string) => `${E}32m${s}${E}39m`, r: (s: string) => `${E}31m${s}${E}39m`, y: (s: string) => `${E}33m${s}${E}39m`,
  b: (s: string) => `${E}34m${s}${E}39m`, cy: (s: string) => `${E}36m${s}${E}39m`, m: (s: string) => `${E}35m${s}${E}39m`,
  inv: (s: string) => `${E}7m${s}${E}27m`,
};
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const vlen = (s: string) => [...strip(s)].length;
/** pad or cut a coloured string to exactly w visible columns */
const fit = (s: string, w: number) => {
  if (w <= 0) return '';
  if (vlen(s) <= w) return s + ' '.repeat(w - vlen(s));
  let out = '', n = 0;
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) { out += part; continue; }
    for (const ch of part) { if (n >= w - 1) break; out += ch; n++; }
  }
  return out + `${E}0m…`;
};
/** split plain text into lines of at most w columns, breaking on spaces where possible */
const wrap = (text: string, w: number, maxLines: number) => {
  const out: string[] = [];
  let rest = text;
  while (rest.length && out.length < maxLines) {
    if (rest.length <= w) { out.push(rest); rest = ''; break; }
    let cut = rest.lastIndexOf(' ', w);
    if (cut < w * 0.5) cut = w;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart();
  }
  if (rest.length && out.length) out[out.length - 1] = out[out.length - 1].slice(0, Math.max(0, w - 1)) + '…';
  return out;
};
const sgn = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
const colorPct = (v: number, d = 1) => (v >= 0 ? c.g : c.r)(`${sgn(v, d)}%`);
const ago = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`; };
const hhmm = (t: number) => new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.recapTz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
const tick = (s: string) => `$${String(s || '?').replace(/\s+/g, '')}`;

const AGENT_COLOR: Record<string, (s: string) => string> = { SCOUT: c.b, FILTER: c.y, ANALYST: c.m, EXECUTOR: c.cy, RISK: c.r, LOGGER: c.dim };
const STATE_DOT: Record<string, string> = { idle: c.dim('○'), busy: c.g('●'), waiting: c.y('◐'), halted: c.r('■'), down: c.r('✕') };
const KIND_COLOR: Record<string, (x: string) => string> = { buy: c.g, exit: c.cy, kill: c.r, pass: c.g, score: c.m, reject: c.dim, error: c.r, warn: c.y, hold: c.dim, scout: c.dim, info: (x) => x };

function counters(a: any, s: any) {
  const k = a.counters ?? {};
  switch (a.name) {
    case 'SCOUT': return `${k.leads ?? 0} leads · ${k.launches ?? 0} seen`;
    case 'FILTER': return `${c.g(`${k.pass ?? 0}✓`)} ${c.r(`${k.kill ?? 0}✗`)} ${s.waiting ? c.y(`${s.waiting}◐`) : c.dim('0◐')}`;
    case 'ANALYST': return `${c.g(`${k.approve ?? 0}✓`)} ${c.dim(`${k.reject ?? 0}✗`)} of ${k.in ?? 0}`;
    case 'EXECUTOR': return `${k.buys ?? 0} buy ${k.sells ?? 0} sell ${k.reject ? c.y(`${k.reject} ref`) : c.dim('0 ref')}`;
    case 'RISK': return `${s.positions.length} open${s.dailyHalted ? c.r(' HALT') : ''}`;
    case 'LOGGER': return `${k.lines ?? 0} lines${k.errors ? c.r(` ${k.errors} err`) : ''}`;
  }
  return '';
}

function chart(curve: { t: number; v: number }[], width: number, height: number, base: number) {
  const labelW = 8;
  if (curve.length < 2 || height < 2) return [c.dim(' collecting equity samples…')];
  const cols = Math.max(8, width - labelW);
  const vals: number[] = [];
  for (let i = 0; i < cols; i++) vals.push(curve[Math.min(curve.length - 1, Math.floor((i / (cols - 1)) * (curve.length - 1)))].v);
  let lo = Math.min(...vals, base), hi = Math.max(...vals, base);
  const pad = (hi - lo) * 0.05 || 0.01; hi += pad; lo = Math.max(0, lo - pad);
  const blocks = ' ▁▂▃▄▅▆▇█';
  const rows: string[] = [];
  const baseRow = Math.floor(((base - lo) / (hi - lo)) * height);
  for (let r = height - 1; r >= 0; r--) {
    let line = '';
    for (const v of vals) {
      const h = ((v - lo) / (hi - lo)) * height;
      const ch = blocks[Math.round(Math.max(0, Math.min(1, h - r)) * 8)];
      line += ch === ' ' ? (r === baseRow ? c.dim('·') : ' ') : (v >= base ? c.g : c.r)(ch);
    }
    const lv = lo + ((r + 0.5) / height) * (hi - lo);
    const label = r === height - 1 || r === 0 || r === baseRow ? lv.toFixed(3) : '';
    rows.push(`${c.dim(label.padStart(labelW - 1))} ${line}`);
  }
  const span = curve[curve.length - 1].t - curve[0].t;
  const left = `${hhmm(curve[0].t)}`, right = `${hhmm(curve[curve.length - 1].t)} (${ago(span)})`;
  rows.push(' '.repeat(labelW) + c.dim(left + ' '.repeat(Math.max(1, cols - left.length - right.length)) + right));
  return rows;
}

function hr(title: string, w: number) { return c.dim(`── ${title} ${'─'.repeat(Math.max(0, w - vlen(title) - 4))}`); }

function render(): string {
  const W = Math.max(40, (process.stdout.columns || Number(process.env.COLUMNS) || 80) - 1), H = Math.max(20, process.stdout.rows || Number(process.env.LINES) || 40);
  const file = path.join(CONFIG.dataDir, 'live.json');
  let s: any;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return `\n  ${c.r('Desk not running')} — no ${file} yet.\n  Start it with: ./desk start\n`; }
  const stale = Date.now() - fs.statSync(file).mtimeMs > 10_000;
  const now = s.at;
  const wide = W >= 118;

  // ── header (full width) ──────────────────────────────────────────────────
  const head: string[] = [];
  const mode = s.mode === 'live' ? c.inv(c.r(' LIVE ')) : c.inv(c.y(' PAPER '));
  const data = s.data === 'sim' ? c.m(` SIM x${s.speed}`) : '';
  const clockStr = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.recapTz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(now));
  const pnl = s.equity - s.startBalance, pnlPct = (s.equity / s.startBalance - 1) * 100, dayPct = (s.equity / s.dayStartEquity - 1) * 100;
  const open = s.positions.reduce((a: number, p: any) => a + (p.valueSol ?? p.costSol), 0);
  const recentPnl = s.closed.pnl;
  const top = `${c.bold('◆ MEMEDESK')} ${mode}${data}${stale ? c.r(' ⚠ DESK NOT RESPONDING') : ''} ${c.dim(`up ${ago(now - s.startedAt)} · SOL $${s.solUsd.toFixed(0)}`)}`;
  head.push(fit(top, W - 9) + c.dim(clockStr.padStart(9)));
  const money = `${c.dim('EQUITY')} ${c.bold(s.equity.toFixed(3))} ${c.dim(`($${(s.equity * s.solUsd).toFixed(0)})`)}  ${(pnl >= 0 ? c.g : c.r)(`${sgn(pnl, 3)}`)} ${colorPct(pnlPct, 2)}  ${c.dim('today')} ${colorPct(dayPct)}`;
  const book = `${c.dim('cash')} ${s.balance.toFixed(3)} ${c.dim('in trades')} ${open.toFixed(3)}  ${c.dim('realized')} ${(recentPnl >= 0 ? c.g : c.r)(sgn(recentPnl, 3))}  ${c.dim('trades')} ${s.closed.n} ${c.g(`${s.closed.wins}W`)}/${c.r(`${s.closed.n - s.closed.wins}L`)}`;
  if (wide) head.push(fit(` ${money}   ${c.dim('│')}  ${book}`, W));
  else { head.push(fit(` ${money}`, W)); head.push(fit(` ${book}`, W)); }
  const flags: string[] = [];
  if (s.dailyHalted) flags.push(c.r('■ DAILY LOSS HALT — no new entries today'));
  if (s.cooldownUntil > now) flags.push(c.y(`◐ ${s.cooldownMode === 'shadow' ? 'shadow cooldown (not blocking)' : 'cooldown'} ${ago(s.cooldownUntil - now)} · ${s.lossStreak} losses in a row`));
  for (const f of Object.values(s.feeds ?? {}) as any[]) if (!f.ok) flags.push(c.y(`⚠ ${f.msg}`));
  if (s.violations) flags.push(c.r(`✘ ${s.violations} HARD-LIMIT VIOLATIONS`));
  if (flags.length) head.push(fit(' ' + flags.join(c.dim('  ·  ')), W));

  // ── blocks ───────────────────────────────────────────────────────────────
  const agentsBlock = (w: number) => {
    const out = [hr('AGENTS', w)];
    const cw = 22;
    for (const a of s.agents) {
      const name = AGENT_COLOR[a.name]((a.name === 'EXECUTOR' ? 'EXEC' : a.name).padEnd(7));
      const when = a.lastAt ? ago(now - a.lastAt) : '';
      const lead = `${STATE_DOT[a.state] ?? '○'} ${name} ${fit(counters(a, s), cw)} `;
      out.push(fit(lead + c.dim(a.last ?? ''), w - when.length - 1) + ' ' + c.dim(when));
    }
    return out;
  };
  const positionsBlock = (w: number) => {
    const out = [hr(`POSITIONS ${s.positions.length}/${CONFIG.maxOpenPositions}`, w)];
    if (!s.positions.length) { out.push(c.dim(' flat — no open positions')); return out; }
    const ps = [...s.positions].sort((a: any, b: any) => b.pnlPct - a.pnlPct);
    for (const p of ps) {
      const stop = p.trail ? c.cy(`trail ${sgn(p.stopPct, 0)}%`) : c.dim(`stop ${sgn(p.stopPct, 0)}%`);
      const val = `${(p.valueSol ?? p.costSol).toFixed(3)}${c.dim(`/${p.costSol.toFixed(3)}`)}`;
      out.push(fit(` ${c.bold(tick(p.symbol).padEnd(9))} ${fit(colorPct(p.pnlPct), 8)} ${fit(stop, 10)} ${c.dim(`pk ${sgn(p.peakPct, 0)}%`.padEnd(8))} ${val}  ${c.dim(ago(now - p.openedAt))}`, w));
    }
    return out;
  };
  const tradesBlock = (w: number, max: number) => {
    const rec = [...(s.recent ?? [])].reverse();
    if (max < 2 || !rec.length) return [] as string[];
    const out = [hr('RECENT TRADES', w)];
    for (const t of rec.slice(0, max - 1)) {
      out.push(fit(` ${c.dim(hhmm(t.closedAt))} ${tick(t.symbol).padEnd(9)} ${fit(colorPct(t.pnlPct), 8)} ${fit((t.pnlSol >= 0 ? c.g : c.r)(sgn(t.pnlSol, 3)), 7)} ${c.dim(`${Math.round(t.heldMin)}m`.padStart(4))} ${c.dim(t.exit)}${t.shadow ? c.y(' ◐') : ''}`, w));
    }
    return out;
  };
  const feedBlock = (w: number, max: number) => {
    const out = [hr('FEED  newest first', w)];
    const lines: string[] = [];
    const avail = w - 12;
    for (const d of [...(s.feed ?? [])].reverse()) {
      if (lines.length >= max - 1) break;
      const paint = KIND_COLOR[d.kind] ?? ((x: string) => x);
      const parts = wrap(d.reason, avail, wide ? 1 : 2);
      lines.push(` ${c.dim(hhmm(d.ts))} ${AGENT_COLOR[d.agent](d.agent.slice(0, 4).padEnd(4))} ${paint(parts[0])}`);
      for (const extra of parts.slice(1)) if (lines.length < max - 1) lines.push(' '.repeat(12) + paint(extra));
    }
    if (!lines.length) lines.push(c.dim(' waiting for activity…'));
    return out.concat(lines.map((l) => fit(l, w)));
  };

  // ── layout ───────────────────────────────────────────────────────────────
  let body: string[];
  const bodyH = H - head.length - 1;
  if (wide) {
    const lw = Math.min(84, Math.max(62, Math.floor(W * 0.46)));
    const rw = W - lw - 3;
    const left = [...agentsBlock(lw), ...positionsBlock(lw)];
    left.push(...tradesBlock(lw, Math.min(13, bodyH - left.length)));
    const chartH = Math.max(4, Math.min(16, Math.floor(bodyH * 0.45)));
    const right = [hr('EQUITY (SOL)', rw), ...chart(s.equityCurve, rw, chartH, s.startBalance)];
    right.push(...feedBlock(rw, bodyH - right.length));
    // anything left on the left column also becomes feed if the right is short
    body = [];
    for (let i = 0; i < bodyH; i++) body.push(fit(left[i] ?? '', lw) + c.dim(' │ ') + fit(right[i] ?? '', rw));
  } else {
    body = [...agentsBlock(W), ...positionsBlock(W)];
    const rest = bodyH - body.length;
    const chartH = Math.max(3, Math.min(14, Math.floor(rest * 0.28)));
    body.push(hr('EQUITY (SOL)', W), ...chart(s.equityCurve, W, chartH, s.startBalance));
    body.push(...tradesBlock(W, Math.min(7, Math.floor((bodyH - body.length) * 0.3))));
    body.push(...feedBlock(W, bodyH - body.length));
  }
  return [...head, ...body].slice(0, H - 1).map((l) => l + `${E}0m${E}K`).join('\n');
}

if (process.argv.includes('--once')) {
  const s = render();
  console.log(process.argv.includes('--plain') ? strip(s) : s);
  process.exit(0);
}

process.stdout.write(`${E}?1049h${E}?25l${E}?7l`); // alt screen, hide cursor, no auto-wrap
const restore = () => { process.stdout.write(`${E}?7h${E}?25h${E}?1049l`); process.exit(0); };
process.on('SIGINT', restore); process.on('SIGTERM', restore);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true); process.stdin.resume();
  process.stdin.on('data', (b) => { const k = b.toString(); if (k === 'q' || k === '\u0003') restore(); });
}
const draw = () => process.stdout.write(`${E}H` + render() + `${E}J`);
draw();
setInterval(draw, 700);
process.stdout.on('resize', () => { process.stdout.write(`${E}2J`); draw(); });
