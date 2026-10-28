import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG, WSOL } from '../config';
import { getJson } from './market';
import type { LiveMarket } from './live';

// Live execution. Only the Executor imports this. Keys never leave the box:
// Jupiter builds the transaction, we sign locally and send through your RPC.

export class LiveWallet {
  readonly kp: Keypair;
  constructor(private m: LiveMarket) {
    if (!CONFIG.walletPrivateKey) throw new Error('WALLET_PRIVATE_KEY is not set');
    const raw = CONFIG.walletPrivateKey.trim();
    this.kp = Keypair.fromSecretKey(raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
  }
  get address() { return this.kp.publicKey.toBase58(); }

  async solBalance() { return (await this.m.conn.getBalance(this.kp.publicKey, 'confirmed')) / 1e9; }

  async tokenBalance(mint: string): Promise<{ ui: number; raw: bigint; decimals: number }> {
    const res = await this.m.conn.getParsedTokenAccountsByOwner(this.kp.publicKey, { mint: new PublicKey(mint) }, 'confirmed');
    let raw = 0n, decimals = 6;
    for (const a of res.value) {
      const ta = (a.account.data as any).parsed?.info?.tokenAmount;
      if (ta) { raw += BigInt(ta.amount); decimals = ta.decimals; }
    }
    return { ui: Number(raw) / 10 ** decimals, raw, decimals };
  }

  private async swap(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number) {
    const quote = await this.m.rawQuote(inputMint, outputMint, amountRaw, slippageBps);
    if (!quote?.outAmount) throw new Error('no route');
    const res = await getJson(`${this.m.jupBase()}/swap`, {
      method: 'POST', headers: this.m.jupHeaders(), minGapMs: 1100, retries: 1, timeoutMs: 15000,
      body: {
        quoteResponse: quote, userPublicKey: this.address, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: CONFIG.priorityMaxLamports, priorityLevel: 'veryHigh' } },
      },
    });
    if (!res?.swapTransaction) throw new Error('swap build failed');
    const tx = VersionedTransaction.deserialize(Buffer.from(res.swapTransaction, 'base64'));
    tx.sign([this.kp]);
    const sig = await this.m.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    const bh = await this.m.conn.getLatestBlockhash('confirmed');
    const conf = await this.m.conn.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: res.lastValidBlockHeight ?? bh.lastValidBlockHeight }, 'confirmed');
    if (conf.value.err) throw new Error(`tx failed on-chain: ${JSON.stringify(conf.value.err)} ${sig}`);
    return sig;
  }

  /** buy with `sol` SOL. returns actual tokens received (measured on-chain) and SOL actually spent */
  async buy(mint: string, sol: number) {
    const solBefore = await this.solBalance();
    const before = await this.tokenBalance(mint);
    const sig = await this.swap(WSOL, mint, BigInt(Math.floor(sol * 1e9)), CONFIG.buySlippageBps);
    const after = await this.tokenBalance(mint);
    const solAfter = await this.solBalance();
    return { sig, tokens: after.ui - before.ui, decimals: after.decimals, solSpent: solBefore - solAfter };
  }

  /** sell entire balance of mint. returns SOL received */
  async sellAll(mint: string) {
    const bal = await this.tokenBalance(mint);
    if (bal.raw === 0n) return { sig: '', solOut: 0 };
    const solBefore = await this.solBalance();
    const sig = await this.swap(mint, WSOL, bal.raw, CONFIG.sellSlippageBps);
    const solAfter = await this.solBalance();
    return { sig, solOut: solAfter - solBefore };
  }
}
