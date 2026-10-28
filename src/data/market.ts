import type { Lead, PairSnapshot, SafetyReport } from '../types';

export interface LaunchEvent { mint: string; creator: string; symbol: string; name: string; ts: number; }

/** Everything the agents need from the outside world. Live and sim both implement it. */
export interface Market {
  readonly kind: 'live' | 'sim';
  /** start streams. onLead = something tradeable appeared; onLaunch = any token creation (for dev history) */
  start(onLead: (l: Omit<Lead, 'id'>) => void, onLaunch: (e: LaunchEvent) => void, onStatus: (msg: string, ok: boolean) => void): Promise<void>;
  pairs(mints: string[]): Promise<Map<string, PairSnapshot>>;
  safety(mint: string): Promise<SafetyReport>;
  firstFunder(wallet: string): Promise<string | null>;
  solUsd(): Promise<number>;
  /** quote buying `sol` SOL of mint → ui tokens out + impact % */
  quoteBuy(mint: string, sol: number, decimals: number): Promise<{ tokens: number; impactPct: number } | null>;
  /** quote selling `tokens` ui of mint → SOL out + impact % */
  quoteSell(mint: string, tokens: number, decimals: number): Promise<{ sol: number; impactPct: number } | null>;
}

// ── small HTTP helper: timeout, retry, per-host spacing ──────────────────────
const lastHit = new Map<string, number>();
export async function getJson(url: string, opts: { minGapMs?: number; timeoutMs?: number; retries?: number; headers?: Record<string, string>; method?: string; body?: unknown } = {}): Promise<any> {
  const { minGapMs = 220, timeoutMs = 8000, retries = 2 } = opts;
  const host = new URL(url).host;
  let err: unknown;
  for (let i = 0; i <= retries; i++) {
    const wait = (lastHit.get(host) ?? 0) + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHit.set(host, Date.now());
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: { accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500 * (i + 1))); err = new Error('429 rate limited'); continue; }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${host}`);
      return await res.json();
    } catch (e) { err = e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  throw err;
}
