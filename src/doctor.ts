import WebSocket from 'ws';
import { Connection } from '@solana/web3.js';
import { CONFIG, WSOL, clampNotes } from './config';
import { LiveMarket } from './data/live';

// Pre-flight check. Run on the server before starting: ./desk doctor
// Hits every data source the desk depends on and shows what came back.

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
let fails = 0;
const ok = (m: string) => console.log(`  ✔ ${m}`);
const bad = (m: string) => { fails++; console.log(`  ✘ ${m}`); };
const warn = (m: string) => console.log(`  ! ${m}`);
async function step(name: string, fn: () => Promise<string>) {
  try { ok(`${name}: ${await fn()}`); } catch (e: any) { bad(`${name}: ${e?.message ?? e}`); }
}

(async () => {
  console.log(`\nMEMEDESK DOCTOR — mode ${CONFIG.mode}, node ${process.version}\n`);
  if (Number(process.versions.node.split('.')[0]) < 20) bad('Node 20+ required');
  for (const n of clampNotes) warn(n);
  const m = new LiveMarket();

  await step('RPC (http)', async () => `slot ${await new Connection(CONFIG.rpcHttp).getSlot()} via ${new URL(CONFIG.rpcHttp).host}`);
  if (!CONFIG.rpcWs) warn('no websocket RPC: Raydium scanning disabled. Set HELIUS_API_KEY (free tier works).');
  if (CONFIG.rpcHttp.includes('api.mainnet-beta')) warn('using the public RPC — it rate-limits hard. A free Helius key is strongly recommended.');

  await step('PumpPortal stream', () => new Promise((res, rej) => {
    const ws = new WebSocket('wss://pumpportal.fun/api/data');
    const t = setTimeout(() => { ws.terminate(); rej(new Error('no launch event within 30s')); }, 30_000);
    ws.on('open', () => ws.send(JSON.stringify({ method: 'subscribeNewToken' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg?.mint) { clearTimeout(t); ws.close(); res(`launch event received ($${msg.symbol}, creator field ${msg.traderPublicKey ? 'present' : 'MISSING'})`); }
    });
    ws.on('error', (e) => { clearTimeout(t); rej(e); });
  }));

  await step('DexScreener', async () => {
    const p = (await m.pairs([BONK])).get(BONK);
    if (!p) throw new Error('no SOL pair returned for BONK');
    return `BONK ${p.priceSol.toExponential(3)} SOL · liq $${Math.round(p.liquidityUsd).toLocaleString()} · vol1h $${Math.round(p.volH1).toLocaleString()} · txns1h ${p.buysH1 + p.sellsH1}`;
  });
  await step('SOL price', async () => `$${(await m.solUsd()).toFixed(2)}`);

  await step('RugCheck', async () => {
    const s = await m.safety(BONK);
    const fields = [`mintAuth=${s.mintAuthority === null ? 'null' : s.mintAuthority}`, `freeze=${s.freezeAuthority === null ? 'null' : s.freezeAuthority}`,
      `lpLocked=${s.lpLockedPct}`, `top10=${s.top10Pct?.toFixed(1)}%`, `decimals=${s.decimals}`, `creator=${s.creator ? 'yes' : 'none'}`];
    if (s.mintAuthority === 'unknown' || s.top10Pct === null) throw new Error(`report shape changed? ${fields.join(' ')}`);
    return fields.join(' ');
  });

  await step('Jupiter quote', async () => {
    const q = await m.quoteBuy(BONK, 0.1, 5);
    if (!q) throw new Error('no quote (rate limit or API change)');
    return `0.1 SOL → ${Math.round(q.tokens).toLocaleString()} BONK via ${m.jupBase().split('/')[2]}`;
  });

  await step('dev funder lookup', async () => `ok (${(await m.firstFunder('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'))?.slice(0, 6) ?? 'none'}…)`);

  if (CONFIG.mode === 'live') {
    const { LiveWallet } = await import('./data/wallet');
    await step('wallet', async () => { const w = new LiveWallet(m); return `${w.address} · ${(await w.solBalance()).toFixed(4)} SOL`; });
  }
  if (!CONFIG.telegramToken) warn('Telegram not set — morning recap is saved to recaps/ only.');
  console.log(fails ? `\n  ${fails} problem(s). Fix before running.\n` : `\n  All green. Start with: ./desk start\n`);
  process.exit(fails ? 1 : 0);
})();

void WSOL;
