import { clock } from '../clock';
import type { PairSnapshot, SafetyReport } from '../types';
import type { LaunchEvent, Market } from './market';

// A synthetic memecoin market used to test the whole desk end-to-end without
// network access. It is deliberately hostile: lots of rugs, bleeders, serial
// devs, unrevoked mints and fat-tailed volatility. It tests MECHANICS (every
// gate, stop, trail, handoff and log line). It says nothing about real edge.

type Arch = 'rug' | 'bleed' | 'chop' | 'pump' | 'moon';
interface Bucket { vol: number; buys: number; sells: number; close: number; }
interface SimTok {
  mint: string; symbol: string; name: string; creator: string; venue: 'pumpswap' | 'raydium';
  listedAt: number; arch: Arch; phaseEnd: number; rugAt: number; rugged: boolean;
  price: number; price0: number; liq0: number; liqMult: number; hype: number;
  mintAuth: string | null; freezeAuth: string | null; lpLocked: number; top10: number; socials: boolean; flagged: boolean;
  buckets: Map<number, Bucket>;
}

let rngState = Number(process.env.SIM_SEED ?? 42) >>> 0;
const rand = () => { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 2 ** 32; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const addr = () => Array.from({ length: 44 }, () => B58[Math.floor(rand() * 58)]).join('');
const SYL = ['MO', 'GU', 'PE', 'KI', 'DO', 'ZA', 'BO', 'NK', 'FA', 'RT', 'WI', 'F', 'CAT', 'DOG', 'PEP', 'TRUMP', 'AI', 'GOB', 'LIN', 'SOL'];

const SOL_USD = 180;
const TICK_MS = 5000;

export class SimMarket implements Market {
  readonly kind = 'sim' as const;
  private toks = new Map<string, SimTok>();
  private hubs = [addr(), addr(), addr()];
  private creators: { w: string; rugger: boolean; funder: string }[] = [];

  constructor() {
    for (let i = 0; i < 140; i++) {
      const rugger = i < 22;
      this.creators.push({ w: addr(), rugger, funder: rugger && rand() < 0.8 ? pick(this.hubs) : addr() });
    }
  }

  async start(onLead: Parameters<Market['start']>[0], onLaunch: (e: LaunchEvent) => void, onStatus: (m: string, ok: boolean) => void) {
    onStatus('SIM market running (synthetic tokens, no network)', true);
    clock.every(TICK_MS, () => this.tick(onLead, onLaunch));
  }

  private minute(t = clock.now()) { return Math.floor(t / 60_000); }

  private tick(onLead: Parameters<Market['start']>[0], onLaunch: (e: LaunchEvent) => void) {
    const now = clock.now();
    // background launches (dev history signal). ruggers launch far more often.
    // most launches come from one-off wallets; the rugger cohort relaunches ~every 3h each
    if (rand() < 0.5) onLaunch({ mint: addr(), creator: addr(), symbol: pick(SYL) + pick(SYL), name: 'noise', ts: now });
    if (rand() < (22 * TICK_MS) / (3 * 3600_000)) {
      const c = pick(this.creators.slice(0, 22));
      onLaunch({ mint: addr(), creator: c.w, symbol: pick(SYL) + pick(SYL), name: 'noise', ts: now });
    }
    // tradeable leads: graduations / new pools, ~1 every 3 sim-minutes
    if (rand() < TICK_MS / 180_000) {
      const t = this.spawn(now);
      onLaunch({ mint: t.mint, creator: t.creator, symbol: t.symbol, name: t.name, ts: now - 20 * 60_000 });
      onLead({ mint: t.mint, symbol: t.symbol, name: t.name, venue: t.venue, creator: t.venue === 'raydium' ? t.creator : null, pool: null,
        source: t.venue === 'pumpswap' ? 'graduated pump.fun bonding curve → PumpSwap (sim)' : 'new Raydium CPMM pool (sim)', discoveredAt: now });
    }
    for (const t of this.toks.values()) this.step(t, now);
    for (const [k, t] of this.toks) if (now - t.listedAt > 26 * 3600_000) this.toks.delete(k);
  }

  private spawn(now: number): SimTok {
    const c = rand() < 0.3 ? pick(this.creators.slice(0, 22)) : pick(this.creators.slice(22));
    const r = rand();
    const arch: Arch = c.rugger ? (r < 0.7 ? 'rug' : 'bleed') : r < 0.12 ? 'rug' : r < 0.47 ? 'bleed' : r < 0.75 ? 'chop' : r < 0.95 ? 'pump' : 'moon';
    const venue = rand() < 0.75 ? 'pumpswap' : 'raydium';
    const price = 0.00000035 * (0.6 + rand());
    const t: SimTok = {
      mint: addr(), symbol: pick(SYL) + pick(SYL), name: 'sim token', creator: c.w, venue, listedAt: now, arch,
      phaseEnd: now + (arch === 'moon' ? 30 + rand() * 90 : 15 + rand() * 75) * 60_000,
      rugAt: now + (8 + rand() * 170) * 60_000, rugged: false,
      price, price0: price, liq0: 18_000 + rand() * 40_000, liqMult: 1, hype: 0.4 + rand() * 1.4 + (arch === 'pump' || arch === 'moon' ? 0.8 : 0),
      mintAuth: rand() < (c.rugger ? 0.3 : 0.07) ? addr() : null,
      freezeAuth: rand() < 0.04 ? addr() : null,
      lpLocked: venue === 'pumpswap' ? 100 : rand() < (c.rugger ? 0.4 : 0.8) ? 100 : Math.round(rand() * 60),
      top10: Math.max(4, 8 + rand() * 18 + (c.rugger ? 10 : 0) + gauss() * 4),
      socials: rand() < 0.7, flagged: c.rugger && rand() < 0.4, buckets: new Map(),
    };
    this.toks.set(t.mint, t);
    return t;
  }

  private step(t: SimTok, now: number) {
    if (t.rugged) { this.trade(t, now, 0.05); return; }
    if (t.arch === 'rug' && now >= t.rugAt) { t.rugged = true; t.price *= 0.05; t.liqMult = 0.03; t.hype = 0.05; return; }
    let drift = 0;
    const inPhase = now < t.phaseEnd;
    switch (t.arch) {
      case 'pump': drift = inPhase ? 0.0012 : -0.0014; t.hype *= inPhase ? 1.002 : 0.996; break;
      case 'moon': drift = inPhase ? 0.0024 : -0.0018; t.hype *= inPhase ? 1.003 : 0.995; break;
      case 'bleed': drift = -0.0006; t.hype *= 0.9985; break;
      case 'rug': drift = 0.0003; break;
      case 'chop': drift = 0; t.hype *= 0.9993; break;
    }
    const shock = rand() < 0.004 ? gauss() * 0.08 : 0; // fat tails
    t.price *= Math.exp(drift + gauss() * 0.008 + shock);
    t.top10 = Math.max(3, t.top10 + gauss() * 0.05 - 0.004);
    this.trade(t, now, drift);
  }

  private trade(t: SimTok, now: number, drift: number) {
    const m = this.minute(now);
    const b = t.buckets.get(m) ?? { vol: 0, buys: 0, sells: 0, close: t.price };
    const lambda = t.hype * 0.55;
    let k = 0; { let L = Math.exp(-lambda), p = 1; do { k++; p *= rand(); } while (p > L); k -= 1; }
    const pBuy = Math.min(0.8, Math.max(0.2, 0.5 + drift * 120));
    for (let i = 0; i < k; i++) {
      const usd = Math.exp(Math.log(110) + gauss() * 0.9);
      b.vol += usd; if (rand() < pBuy) b.buys++; else b.sells++;
    }
    b.close = t.price;
    t.buckets.set(m, b);
    if (t.buckets.size > 400) { const old = m - 380; for (const key of t.buckets.keys()) if (key < old) t.buckets.delete(key); }
  }

  private liqUsd(t: SimTok) { return t.liq0 * Math.sqrt(t.price / t.price0) * t.liqMult; }
  private window(t: SimTok, mins: number) {
    const m = this.minute(); let vol = 0, buys = 0, sells = 0;
    for (let i = 0; i < mins; i++) { const b = t.buckets.get(m - i); if (b) { vol += b.vol; buys += b.buys; sells += b.sells; } }
    return { vol, buys, sells };
  }
  private priceAgo(t: SimTok, mins: number) {
    const m = this.minute();
    for (let i = mins; i >= 0; i--) { const b = t.buckets.get(m - i); if (b) return b.close; }
    return t.price0;
  }

  async pairs(mints: string[]) {
    await clock.sleep(150);
    const out = new Map<string, PairSnapshot>();
    for (const mint of mints) {
      const t = this.toks.get(mint); if (!t) continue;
      const w5 = this.window(t, 5), w60 = this.window(t, 60), w360 = this.window(t, 360);
      out.set(mint, {
        mint, symbol: t.symbol, pairAddress: 'sim-' + mint.slice(0, 6), dexId: t.venue, priceUsd: t.price * SOL_USD, priceSol: t.price,
        liquidityUsd: this.liqUsd(t), volM5: w5.vol, volH1: w60.vol, volH6: w360.vol,
        buysM5: w5.buys, sellsM5: w5.sells, buysH1: w60.buys, sellsH1: w60.sells,
        changeM5: (t.price / this.priceAgo(t, 5) - 1) * 100, changeH1: (t.price / this.priceAgo(t, 60) - 1) * 100,
        mcapUsd: t.price * SOL_USD * 1e9, pairCreatedAt: t.listedAt, hasSocials: t.socials, fetchedAt: clock.now(),
      });
    }
    return out;
  }

  async safety(mint: string): Promise<SafetyReport> {
    await clock.sleep(400);
    const t = this.toks.get(mint); if (!t) throw new Error('rugcheck: token not indexed');
    if (rand() < 0.03) throw new Error('rugcheck: 502');
    return { mintAuthority: t.mintAuth, freezeAuthority: t.freezeAuth, lpLockedPct: t.lpLocked, top10Pct: t.top10,
      creator: t.creator, decimals: 6, holders: Math.round(200 + rand() * 3000),
      riskNames: t.flagged ? ['Creator history of rugged tokens (danger)'] : [], fetchedAt: clock.now() };
  }

  async firstFunder(wallet: string) { await clock.sleep(300); return this.creators.find((c) => c.w === wallet)?.funder ?? addr(); }
  async solUsd() { return SOL_USD; }

  async quoteBuy(mint: string, sol: number) {
    const t = this.toks.get(mint); if (!t) return null;
    const impact = (sol * SOL_USD) / (this.liqUsd(t) / 2) * 100;
    return { tokens: (sol / t.price) * (1 - impact / 100) * (1 - 0.006), impactPct: impact };
  }
  async quoteSell(mint: string, tokens: number) {
    const t = this.toks.get(mint); if (!t) return null;
    if (rand() < 0.01) return { sol: tokens * t.price * (rand() < 0.5 ? 9 : 0.01), impactPct: 0 }; // bad route
    const gross = tokens * t.price; const impact = (gross * SOL_USD) / (this.liqUsd(t) / 2) * 100;
    return { sol: gross * Math.max(0, 1 - impact / 100) * (1 - 0.006), impactPct: impact };
  }
}
