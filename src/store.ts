import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config';
import { clock } from './clock';
import type { ClosedTrade, Position } from './types';

// Persistent desk state. Survives restarts. One JSON file per concern, written
// atomically (tmp + rename) so a crash mid-write can't corrupt it.

const dir = CONFIG.dataDir;
fs.mkdirSync(dir, { recursive: true });
const file = (name: string) => path.join(dir, name);

export function readJson<T>(name: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) as T; } catch { return fallback; }
}
export function writeJson(name: string, data: unknown) {
  const p = file(name), tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, p);
}

export interface DeskState {
  mode: 'paper' | 'live';
  sessionStartedAt: number;
  startBalanceSol: number;
  balanceSol: number;               // free SOL (cash)
  positions: Position[];
  closed: ClosedTrade[];
  dayKey: string;                   // YYYY-MM-DD in recap tz
  dayStartEquity: number;
  dailyHalted: boolean;
  lossStreak: number;
  cooldownUntil: number;
  revengeBans: Record<string, number>; // mint -> until ts
  equity: { t: number; v: number }[];  // sampled equity curve (SOL)
  violations: string[];               // any hard-limit breach attempts (should stay empty)
  counters?: Record<string, Record<string, number>>; // agent activity counters, kept across restarts
  lastRecapDay: string;
}

const stateName = () => (CONFIG.data === 'sim' ? 'state.sim.json' : `state.${CONFIG.mode}.json`);

export function loadState(startBalance: number): DeskState {
  const s = readJson<DeskState | null>(stateName(), null);
  if (s && s.mode === CONFIG.mode) return s;
  const now = clock.now();
  return {
    mode: CONFIG.mode, sessionStartedAt: now, startBalanceSol: startBalance, balanceSol: startBalance,
    positions: [], closed: [], dayKey: '', dayStartEquity: startBalance, dailyHalted: false,
    lossStreak: 0, cooldownUntil: 0, revengeBans: {}, equity: [{ t: now, v: startBalance }], violations: [], lastRecapDay: '',
  };
}
export function saveState(s: DeskState) {
  if (s.equity.length > 3000) s.equity = s.equity.slice(-3000);
  writeJson(stateName(), s);
}
export const statePath = () => file(stateName());

// Creator intelligence: who launched what, who rugged, who funded whom.
export interface CreatorDb {
  launches: Record<string, number[]>;     // creator -> launch timestamps (72h window)
  rugged: Record<string, string[]>;       // creator -> rugged mints
  funders: Record<string, string | null>; // creator -> first funder
  blacklist: Record<string, string>;      // wallet -> reason
  mintCreator: Record<string, { creator: string; symbol: string; name: string; ts: number }>;
}
const creatorName = () => (CONFIG.data === 'sim' ? 'creators.sim.json' : 'creators.json');
export function loadCreators(): CreatorDb {
  const db = readJson<CreatorDb>(creatorName(), { launches: {}, rugged: {}, funders: {}, blacklist: {}, mintCreator: {} });
  // seed blacklist the user can edit by hand: one wallet per line, optional "# reason"
  try {
    const seed = fs.readFileSync(file('blacklist.txt'), 'utf8');
    for (const line of seed.split('\n')) {
      const [w, ...r] = line.split('#'); const wallet = w.trim();
      if (wallet.length >= 32) db.blacklist[wallet] ??= `manual: ${r.join('#').trim() || 'listed in blacklist.txt'}`;
    }
  } catch { /* optional */ }
  return db;
}
export function saveCreators(db: CreatorDb) {
  const cutoff = clock.now() - 72 * 3600_000;
  for (const [c, ts] of Object.entries(db.launches)) {
    const keep = ts.filter((t) => t > cutoff);
    if (keep.length) db.launches[c] = keep; else delete db.launches[c];
  }
  const mcCut = clock.now() - 48 * 3600_000;
  for (const [m, v] of Object.entries(db.mintCreator)) if (v.ts < mcCut) delete db.mintCreator[m];
  writeJson(creatorName(), db);
}
