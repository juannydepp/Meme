import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import { BURN_ADDRESSES, CONFIG, WSOL } from '../config';
import { clock } from '../clock';
import type { PairSnapshot, SafetyReport, Venue } from '../types';
import { getJson, type LaunchEvent, type Market } from './market';

// Sources:
//   PumpPortal websocket  — every pump.fun launch + every graduation to PumpSwap
//   Solana RPC logs       — new Raydium AMM v4 + CPMM pools (incl. LaunchLab graduations)
//   DexScreener           — price, liquidity, volume, buys/sells
//   RugCheck              — mint/freeze authority, LP lock, holders, creator, risk flags
//   Jupiter               — real quotes (price impact) for entries/exits
const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const n = (v: unknown, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

export class LiveMarket implements Market {
  readonly kind = 'live' as const;
  readonly conn = new Connection(CONFIG.rpcHttp, { commitment: 'confirmed', wsEndpoint: CONFIG.rpcWs || undefined });
  private solPx = { v: 0, at: 0 };
  private seenSigs = new Set<string>();

  async start(onLead: Parameters<Market['start']>[0], onLaunch: (e: LaunchEvent) => void, onStatus: (m: string, ok: boolean) => void) {
    if (CONFIG.scoutPumpfun) this.pumpPortal(onLead, onLaunch, onStatus);
    if (CONFIG.scoutRaydium) {
      if (!CONFIG.rpcWs) onStatus('Raydium scanning off: no websocket RPC (set HELIUS_API_KEY or RPC_WS)', false);
      else this.raydium(onLead, onStatus);
    }
  }

  // ── PumpPortal ─────────────────────────────────────────────────────────────
  private pumpPortal(onLead: Parameters<Market['start']>[0], onLaunch: (e: LaunchEvent) => void, onStatus: (m: string, ok: boolean) => void, attempt = 0) {
    const ws = new WebSocket('wss://pumpportal.fun/api/data');
    let alive = true;
    const ping = setInterval(() => { try { ws.ping(); } catch { /* */ } }, 20_000);
    ws.on('open', () => {
      attempt = 0;
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      onStatus('pump.fun stream connected (launches + graduations)', true);
    });
    ws.on('message', (raw) => {
      let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m?.mint) return;
      const tx = String(m.txType ?? '').toLowerCase();
      if (tx === 'create') {
        onLaunch({ mint: m.mint, creator: m.traderPublicKey ?? '', symbol: m.symbol ?? '?', name: m.name ?? '', ts: clock.now() });
      } else if (tx === 'migrate' || tx === 'migration' || m.pool === 'pump-amm') {
        onLead({ mint: m.mint, symbol: m.symbol ?? '', name: m.name ?? '', venue: 'pumpswap', creator: null, pool: m.pool ?? null,
          source: `graduated pump.fun bonding curve → PumpSwap (tx ${String(m.signature ?? '').slice(0, 8)})`, discoveredAt: clock.now() });
      }
    });
    const retry = () => {
      if (!alive) return; alive = false; clearInterval(ping);
      const wait = Math.min(60_000, 2000 * 2 ** attempt);
      onStatus(`pump.fun stream dropped, reconnecting in ${Math.round(wait / 1000)}s`, false);
      setTimeout(() => this.pumpPortal(onLead, onLaunch, onStatus, attempt + 1), wait);
    };
    ws.on('close', retry); ws.on('error', retry);
  }

  // ── Raydium new pools via program logs ─────────────────────────────────────
  private raydium(onLead: Parameters<Market['start']>[0], onStatus: (m: string, ok: boolean) => void) {
    const watch = (program: string, isInit: (logs: string[]) => boolean, label: string) => {
      this.conn.onLogs(new PublicKey(program), async (l) => {
        if (l.err || !isInit(l.logs) || this.seenSigs.has(l.signature)) return;
        this.seenSigs.add(l.signature);
        if (this.seenSigs.size > 5000) this.seenSigs.clear();
        try {
          const tx = await this.conn.getParsedTransaction(l.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
          if (!tx?.meta) return;
          const mints = new Set((tx.meta.postTokenBalances ?? []).map((b) => b.mint));
          if (!mints.has(WSOL)) return;               // SOL pairs only
          mints.delete(WSOL);
          const others = [...mints].filter((m) => m !== USDC);
          if (others.length !== 1) return;
          const feePayer = tx.transaction.message.accountKeys[0]?.pubkey.toBase58() ?? null;
          onLead({ mint: others[0], symbol: '', name: '', venue: 'raydium', creator: feePayer, pool: null,
            source: `new Raydium ${label} pool (tx ${l.signature.slice(0, 8)})`, discoveredAt: clock.now() });
        } catch { /* rpc hiccup: skip this pool */ }
      }, 'confirmed');
    };
    watch(RAYDIUM_AMM_V4, (logs) => logs.some((x) => x.includes('initialize2')), 'AMM v4');
    watch(RAYDIUM_CPMM, (logs) => logs.some((x) => x === 'Program log: Instruction: Initialize'), 'CPMM');
    onStatus('Raydium pool scanner subscribed (AMM v4 + CPMM)', true);
  }

  // ── DexScreener ────────────────────────────────────────────────────────────
  async pairs(mints: string[]) {
    const out = new Map<string, PairSnapshot>();
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      const arr = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`, { minGapMs: 250 });
      if (!Array.isArray(arr)) continue;
      const vol = new Map<string, { m5: number; h1: number; h6: number; b5: number; s5: number; b1: number; s1: number }>();
      for (const p of arr) {
        const mint = p?.baseToken?.address;
        if (!mint || !chunk.includes(mint) || p?.quoteToken?.address !== WSOL) continue;
        const v = vol.get(mint) ?? { m5: 0, h1: 0, h6: 0, b5: 0, s5: 0, b1: 0, s1: 0 };
        v.m5 += n(p.volume?.m5); v.h1 += n(p.volume?.h1); v.h6 += n(p.volume?.h6);
        v.b5 += n(p.txns?.m5?.buys); v.s5 += n(p.txns?.m5?.sells); v.b1 += n(p.txns?.h1?.buys); v.s1 += n(p.txns?.h1?.sells);
        vol.set(mint, v);
        const prev = out.get(mint);
        if (prev && prev.liquidityUsd >= n(p.liquidity?.usd)) continue; // keep deepest SOL pair for price/liquidity
        out.set(mint, {
          mint, symbol: p.baseToken?.symbol ?? '?', pairAddress: p.pairAddress, dexId: p.dexId,
          priceUsd: n(p.priceUsd), priceSol: n(p.priceNative), liquidityUsd: n(p.liquidity?.usd),
          volM5: 0, volH1: 0, volH6: 0, buysM5: 0, sellsM5: 0, buysH1: 0, sellsH1: 0,
          changeM5: n(p.priceChange?.m5), changeH1: n(p.priceChange?.h1), mcapUsd: n(p.marketCap ?? p.fdv),
          pairCreatedAt: n(p.pairCreatedAt), hasSocials: (p.info?.socials?.length ?? 0) + (p.info?.websites?.length ?? 0) > 0,
          fetchedAt: clock.now(),
        });
      }
      for (const [mint, s] of out) {
        const v = vol.get(mint); if (!v || !chunk.includes(mint)) continue;
        s.volM5 = v.m5; s.volH1 = v.h1; s.volH6 = v.h6; s.buysM5 = v.b5; s.sellsM5 = v.s5; s.buysH1 = v.b1; s.sellsH1 = v.s1;
      }
    }
    return out;
  }

  // ── RugCheck ───────────────────────────────────────────────────────────────
  async safety(mint: string): Promise<SafetyReport> {
    const r = await getJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { minGapMs: 700, timeoutMs: 12000 });
    const tok = r?.token ?? {};
    const has = (o: any, k: string) => o && Object.prototype.hasOwnProperty.call(o, k);
    // authorities: prefer token object; fall back to top-level fields. Unknown = treat as NOT revoked.
    const mintAuthority = has(tok, 'mintAuthority') ? tok.mintAuthority : has(r, 'mintAuthority') ? r.mintAuthority : 'unknown';
    const freezeAuthority = has(tok, 'freezeAuthority') ? tok.freezeAuthority : has(r, 'freezeAuthority') ? r.freezeAuthority : 'unknown';

    const markets: any[] = Array.isArray(r?.markets) ? r.markets : [];
    const exclude = new Set<string>([...BURN_ADDRESSES]);
    for (const mk of markets) for (const k of ['pubkey', 'liquidityAAccount', 'liquidityBAccount', 'liquidityA', 'liquidityB'])
      if (typeof mk?.[k] === 'string') exclude.add(mk[k]);
    const deepest = [...markets].sort((a, b) => n(b?.lp?.quoteUSD ?? b?.lp?.baseUSD) - n(a?.lp?.quoteUSD ?? a?.lp?.baseUSD))[0];
    const lpLockedPct = deepest?.lp?.lpLockedPct ?? r?.lpLockedPct ?? null;

    const supply = n(tok.supply);
    const holders: any[] = Array.isArray(r?.topHolders) ? r.topHolders : [];
    const real = holders.filter((h) => !exclude.has(h?.address) && !exclude.has(h?.owner)).slice(0, 10);
    let top10Pct: number | null = null;
    if (holders.length) {
      top10Pct = real.reduce((s, h) => s + (supply > 0 && h?.amount != null ? (n(h.amount) / supply) * 100 : n(h?.pct)), 0);
    }
    return {
      mintAuthority, freezeAuthority, lpLockedPct: lpLockedPct == null ? null : n(lpLockedPct),
      top10Pct, creator: r?.creator ?? null, decimals: tok.decimals ?? null, holders: r?.totalHolders ?? null,
      riskNames: (Array.isArray(r?.risks) ? r.risks : []).map((x: any) => `${x?.name ?? ''}${x?.level ? ` (${x.level})` : ''}`),
      fetchedAt: clock.now(),
    };
  }

  // ── who first funded a wallet (oldest incoming SOL transfer) ───────────────
  async firstFunder(wallet: string) {
    const pk = new PublicKey(wallet);
    let before: string | undefined, oldest: string | undefined;
    for (let page = 0; page < 3; page++) {
      const sigs = await this.conn.getSignaturesForAddress(pk, { limit: 1000, before });
      if (!sigs.length) break;
      oldest = sigs[sigs.length - 1].signature; before = oldest;
      if (sigs.length < 1000) break;
      if (page === 2) return null; // very old/active wallet: funder not meaningful
    }
    if (!oldest) return null;
    const tx = await this.conn.getParsedTransaction(oldest, { maxSupportedTransactionVersion: 0 });
    for (const ix of tx?.transaction.message.instructions ?? []) {
      const p = (ix as any).parsed;
      if (p?.type === 'transfer' && p.info?.destination === wallet) return p.info.source as string;
    }
    return tx?.transaction.message.accountKeys[0]?.pubkey.toBase58() ?? null;
  }

  async solUsd() {
    if (clock.now() - this.solPx.at < 60_000 && this.solPx.v) return this.solPx.v;
    const arr = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${WSOL}`);
    const best = (Array.isArray(arr) ? arr : []).filter((p: any) => p?.baseToken?.address === WSOL && p?.quoteToken?.address === USDC)
      .sort((a: any, b: any) => n(b.liquidity?.usd) - n(a.liquidity?.usd))[0];
    if (best) this.solPx = { v: n(best.priceUsd), at: clock.now() };
    return this.solPx.v || 150;
  }

  // ── Jupiter quotes ─────────────────────────────────────────────────────────
  jupBase() { return CONFIG.jupApiKey ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1'; }
  jupHeaders() { return CONFIG.jupApiKey ? { 'x-api-key': CONFIG.jupApiKey } : undefined; }
  async rawQuote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number) {
    const q = `${this.jupBase()}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
    return getJson(q, { minGapMs: 1100, headers: this.jupHeaders() });
  }
  async quoteBuy(mint: string, sol: number, decimals: number) {
    try {
      const q = await this.rawQuote(WSOL, mint, BigInt(Math.floor(sol * 1e9)), CONFIG.buySlippageBps);
      if (!q?.outAmount) return null;
      return { tokens: Number(q.outAmount) / 10 ** decimals, impactPct: n(q.priceImpactPct) * 100 };
    } catch { return null; }
  }
  async quoteSell(mint: string, tokens: number, decimals: number) {
    try {
      const q = await this.rawQuote(mint, WSOL, BigInt(Math.floor(tokens * 10 ** decimals)), CONFIG.sellSlippageBps);
      if (!q?.outAmount) return null;
      return { sol: Number(q.outAmount) / 1e9, impactPct: n(q.priceImpactPct) * 100 };
    } catch { return null; }
  }
}

export type { Venue };
