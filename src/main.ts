import { activity, bus } from './bus';
import { clock } from './clock';
import { CONFIG, clampNotes } from './config';
import type { Desk } from './desk';
import { equityOf } from './desk';
import type { Market } from './data/market';
import { SimMarket } from './data/sim';
import { LiveMarket } from './data/live';
import { LiveWallet } from './data/wallet';
import { loadCreators, loadState, readJson, saveCreators, saveState, type DeskState } from './store';
import { pruneTickets } from './tickets';
import { goLiveReport } from './golive';
import { writeAndSendRecap } from './recap';
import { Scout } from './agents/scout';
import { Filter } from './agents/filter';
import { Analyst } from './agents/analyst';
import { Executor } from './agents/executor';
import { Risk } from './agents/risk';
import { Logger } from './agents/logger';

async function main() {
  const isSim = CONFIG.data === 'sim';
  clock.init(isSim ? CONFIG.simSpeed : 1);

  // ── live-mode gate ───────────────────────────────────────────────────────
  let wallet: LiveWallet | null = null;
  const market: Market = isSim ? new SimMarket() : new LiveMarket();
  if (CONFIG.mode === 'live') {
    if (isSim) throw new Error('MODE=live cannot run on simulated data');
    if (CONFIG.liveConfirm !== 'I_ACCEPT_REAL_LOSSES') throw new Error('MODE=live requires LIVE_CONFIRM=I_ACCEPT_REAL_LOSSES in .env');
    const g = goLiveReport(readJson<DeskState | null>('state.paper.json', null));
    if (!g.ok && !CONFIG.goLiveOverride) {
      throw new Error('paper results have not cleared the go-live bar:\n' + g.lines.map((l) => `  ${l.ok ? '✔' : '✘'} ${l.text}`).join('\n') + '\n(run ./desk golive for details)');
    }
    wallet = new LiveWallet(market as LiveMarket);
  }

  const startBal = wallet ? await wallet.solBalance() : CONFIG.paperStartSol;
  const state = loadState(startBal);
  if (wallet) {
    // reconcile with the chain: on-chain truth wins
    state.balanceSol = await wallet.solBalance();
    for (const p of [...state.positions]) {
      const b = await wallet.tokenBalance(p.mint);
      if (b.ui <= 0) state.positions = state.positions.filter((x) => x.id !== p.id);
      else p.tokens = b.ui;
    }
  }
  const desk: Desk = { market, state, creators: loadCreators(), solUsd: await market.solUsd().catch(() => 150) };
  clock.every(60_000, () => market.solUsd().then((v) => { desk.solUsd = v; }).catch(() => {}));

  // ── seats ────────────────────────────────────────────────────────────────
  const logger = new Logger(desk);
  const risk = new Risk(desk);
  const executor = new Executor(desk, risk, wallet);
  const analyst = new Analyst(desk);
  const filter = new Filter(desk);
  const scout = new Scout(desk);
  logger.setWaitingCounter(() => filter.waitingCount);
  logger.onRecapDue = async () => { const f = await writeAndSendRecap(state); bus.decide({ agent: 'LOGGER', kind: 'info', reason: `morning recap written → ${f}` }); };

  logger.start(); risk.start(); executor.start(); analyst.start(); filter.start();
  bus.decide({ agent: 'LOGGER', kind: 'info', reason: `desk up · ${CONFIG.mode.toUpperCase()} · data=${CONFIG.data}${isSim ? ` x${CONFIG.simSpeed}` : ''} · balance ${state.balanceSol.toFixed(3)} SOL${wallet ? ` · wallet ${wallet.address}` : ''}` });
  for (const n of clampNotes) bus.decide({ agent: 'LOGGER', kind: 'warn', reason: `config: ${n}` });
  for (const p of state.positions) bus.emit('position.opened', p); // resume managing positions after a restart
  await scout.start();
  activity.state('EXECUTOR', 'idle');

  clock.every(3600_000, () => pruneTickets(clock.now() - 2 * 3600_000));

  const shutdown = (why: string) => {
    bus.decide({ agent: 'LOGGER', kind: 'info', reason: `desk stopping (${why}) · equity ${equityOf(state).toFixed(3)} SOL` });
    logger.snapshot(); saveState(state); saveCreators(desk.creators);
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e: any) => bus.decide({ agent: 'LOGGER', kind: 'error', reason: `unhandled: ${e?.message ?? e}` }));
  process.on('uncaughtException', (e: any) => bus.decide({ agent: 'LOGGER', kind: 'error', reason: `uncaught: ${e?.message ?? e}` }));

  // accelerated test run: stop after SIM_HOURS of sim time and write the recap
  if (isSim && CONFIG.simHours > 0) {
    const started = clock.now();
    clock.after(CONFIG.simHours * 3600_000, async () => {
      const f = await writeAndSendRecap(state, started);
      console.log(`sim complete → ${f}`);
      shutdown('sim finished');
    });
  }
}

main().catch((e) => { console.error(`\n✘ desk refused to start: ${e?.message ?? e}\n`); process.exit(1); });
