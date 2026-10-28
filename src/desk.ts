import type { Market } from './data/market';
import type { CreatorDb, DeskState } from './store';

/** Shared, read-mostly context handed to every agent. */
export interface Desk {
  market: Market;
  state: DeskState;
  creators: CreatorDb;
  solUsd: number;
}

export const equityOf = (s: DeskState) => s.balanceSol + s.positions.reduce((a, p) => a + p.tokens * p.lastPrice, 0);

export const sym = (s: string | undefined, mint?: string) => (s && s !== '?' ? `$${s}` : mint ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : '?');
export const pct = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
export const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`);
