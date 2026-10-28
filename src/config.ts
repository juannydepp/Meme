import 'dotenv/config';

// ─────────────────────────────────────────────────────────────────────────────
// HARD LIMITS. These are constants in code, not settings. The .env file can
// make the desk MORE conservative, never less. Any attempt to loosen them is
// clamped back and logged at startup.
// ─────────────────────────────────────────────────────────────────────────────
export const HARD = Object.freeze({
  MAX_POSITION_PCT: 0.08,      // max 8% of current SOL balance per trade. never more.
  STOP_LOSS_PCT: 0.06,         // hard stop at -6% from cost basis
  TRAIL_ACTIVATE_PCT: 0.12,    // trailing only starts after +12%
  MIN_ANALYST_SCORE: 0.6,      // under 0.6 = no trade
  TOP10_MAX_PCT: 20,           // top 10 holders (excl. pools/burn) must be <= 20%
  MIN_VOLUME_H1_USD: 50_000,   // >= $50k volume in the last hour
  MIN_LP_LOCKED_PCT: 95,       // LP must be >= 95% locked or burned
});

const env = (k: string) => process.env[k];
const num = (k: string, d: number) => {
  const v = env(k);
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (k: string, d: boolean) => {
  const v = env(k);
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

export const clampNotes: string[] = [];
/** tighter-only: value may be stricter than the hard limit, never looser */
function tighter(name: string, value: number, hard: number, stricterIs: 'lower' | 'higher') {
  const looser = stricterIs === 'lower' ? value > hard : value < hard;
  if (looser) {
    clampNotes.push(`${name}=${value} would loosen a hard limit; clamped to ${hard}`);
    return hard;
  }
  return value;
}

export const CONFIG = {
  mode: (env('MODE') ?? 'paper') as 'paper' | 'live',
  data: (env('DATA') ?? 'live') as 'live' | 'sim',
  simSpeed: num('SIM_SPEED', 1),
  simHours: num('SIM_HOURS', 0), // 0 = run forever

  // risk & sizing (tighter-only)
  maxPositionPct: tighter('MAX_POSITION_PCT', num('MAX_POSITION_PCT', HARD.MAX_POSITION_PCT), HARD.MAX_POSITION_PCT, 'lower'),
  stopLossPct: tighter('STOP_LOSS_PCT', num('STOP_LOSS_PCT', HARD.STOP_LOSS_PCT), HARD.STOP_LOSS_PCT, 'lower'),
  trailActivatePct: HARD.TRAIL_ACTIVATE_PCT, // fixed by spec: trail only after +12%
  trailDistancePct: num('TRAIL_DISTANCE_PCT', 0.06), // once trailing, exit if price falls this far from peak
  minScore: tighter('MIN_ANALYST_SCORE', num('MIN_ANALYST_SCORE', HARD.MIN_ANALYST_SCORE), HARD.MIN_ANALYST_SCORE, 'higher'),

  // filter (tighter-only)
  top10MaxPct: tighter('TOP10_MAX_PCT', num('TOP10_MAX_PCT', HARD.TOP10_MAX_PCT), HARD.TOP10_MAX_PCT, 'lower'),
  minVolumeH1: tighter('MIN_VOLUME_H1_USD', num('MIN_VOLUME_H1_USD', HARD.MIN_VOLUME_H1_USD), HARD.MIN_VOLUME_H1_USD, 'higher'),
  minLpLockedPct: tighter('MIN_LP_LOCKED_PCT', num('MIN_LP_LOCKED_PCT', HARD.MIN_LP_LOCKED_PCT), HARD.MIN_LP_LOCKED_PCT, 'higher'),
  serialLaunchMax: num('SERIAL_LAUNCH_MAX', 3),         // dev launched >= N tokens in 72h = serial launcher = kill
  recheckMinutes: [2, 5, 10, 15, 20, 30, 45, 60],       // when to re-test volume/holder checks on young pairs

  // extra capital-preservation guards
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 3),
  maxPoolSharePct: num('MAX_POOL_SHARE_PCT', 1.5),      // our buy <= 1.5% of pool liquidity
  minTradeSol: num('MIN_TRADE_SOL', 0.02),
  feeReserveSol: num('FEE_RESERVE_SOL', 0.05),
  dailyLossHaltPct: num('DAILY_LOSS_HALT_PCT', 12),     // equity down 12% on the day = no new entries until next day
  lossStreakCooldownMin: num('LOSS_STREAK_COOLDOWN_MIN', 45), // after 2 straight losses
  lossStreakLongCooldownMin: num('LOSS_STREAK_LONG_COOLDOWN_MIN', 120), // after 3+
  revengeBanHours: num('REVENGE_BAN_HOURS', 24),        // never re-buy a token that stopped you out
  ticketMaxAgeSec: num('TICKET_MAX_AGE_SEC', 45),       // filter data older than this = stale, no trade
  liquidityPullExitPct: num('LIQ_PULL_EXIT_PCT', 40),   // pool liquidity down 40% from entry = get out
  priceBlackoutExitSec: num('PRICE_BLACKOUT_EXIT_SEC', 180),

  // paper account
  paperStartSol: num('PAPER_START_SOL', 10),

  // execution
  buySlippageBps: num('BUY_SLIPPAGE_BPS', 500),
  sellSlippageBps: num('SELL_SLIPPAGE_BPS', 1500),     // exits must get out
  priorityMaxLamports: num('PRIORITY_MAX_LAMPORTS', 2_000_000),
  costModelFeePct: num('COST_FEE_PCT', 0.5),            // venue+aggregator fee per side (paper fallback)

  // endpoints & keys
  rpcHttp: env('RPC_HTTP') ?? (env('HELIUS_API_KEY') ? `https://mainnet.helius-rpc.com/?api-key=${env('HELIUS_API_KEY')}` : 'https://api.mainnet-beta.solana.com'),
  rpcWs: env('RPC_WS') ?? (env('HELIUS_API_KEY') ? `wss://mainnet.helius-rpc.com/?api-key=${env('HELIUS_API_KEY')}` : ''),
  jupApiKey: env('JUP_API_KEY') ?? '',
  walletPrivateKey: env('WALLET_PRIVATE_KEY') ?? '',
  scoutRaydium: bool('SCOUT_RAYDIUM', true),
  scoutPumpfun: bool('SCOUT_PUMPFUN', true),

  // live gate
  liveConfirm: env('LIVE_CONFIRM') ?? '',
  goLiveOverride: bool('GOLIVE_OVERRIDE', false),

  // reporting
  recapTz: env('RECAP_TZ') ?? 'America/New_York',
  recapHour: num('RECAP_HOUR', 7),
  telegramToken: env('TELEGRAM_BOT_TOKEN') ?? '',
  telegramChat: env('TELEGRAM_CHAT_ID') ?? '',

  dataDir: env('DATA_DIR') ?? 'data',
  logDir: env('LOG_DIR') ?? 'logs',
};

export const WSOL = 'So11111111111111111111111111111111111111112';
export const BURN_ADDRESSES = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111',
]);
