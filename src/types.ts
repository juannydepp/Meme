export type Venue = 'pumpfun' | 'pumpswap' | 'raydium';
export type AgentName = 'SCOUT' | 'FILTER' | 'ANALYST' | 'EXECUTOR' | 'RISK' | 'LOGGER';

export interface Lead {
  id: string;            // L-000123
  mint: string;
  symbol: string;
  name: string;
  venue: Venue;
  creator: string | null;
  pool: string | null;
  source: string;        // why scout raised it (on-chain reason)
  discoveredAt: number;
}

export interface PairSnapshot {
  mint: string;
  symbol: string;
  pairAddress: string;
  dexId: string;
  priceUsd: number;
  priceSol: number;      // price of 1 token in SOL
  liquidityUsd: number;
  volM5: number;
  volH1: number;
  volH6: number;
  buysM5: number; sellsM5: number;
  buysH1: number; sellsH1: number;
  changeM5: number;      // %
  changeH1: number;      // %
  mcapUsd: number;
  pairCreatedAt: number;
  hasSocials: boolean;
  fetchedAt: number;
}

export interface SafetyReport {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  lpLockedPct: number | null;
  top10Pct: number | null;      // excluding pools/burn
  creator: string | null;
  decimals: number | null;
  holders: number | null;
  riskNames: string[];
  fetchedAt: number;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  value: string;
  rule: string;
  permanent: boolean;    // permanent fail = dead. transient fail = re-check later
}

export interface FilterTicket {
  readonly ticketId: string;
  readonly leadId: string;
  readonly mint: string;
  readonly symbol: string;
  readonly checks: readonly CheckResult[];
  readonly snapshot: PairSnapshot;
  readonly safety: SafetyReport;
  readonly issuedAt: number;
}

export interface AnalystTicket {
  readonly ticketId: string;
  readonly filterTicketId: string;
  readonly mint: string;
  readonly symbol: string;
  readonly score: number;
  readonly components: Readonly<Record<string, number>>;
  readonly reasons: readonly string[];
  readonly issuedAt: number;
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  decimals: number;
  tokens: number;          // ui amount held
  costSol: number;         // total SOL spent incl. fees
  entryPrice: number;      // cost basis per token in SOL (costSol / tokens)
  entryLiquidityUsd: number;
  pairAddress?: string;
  openedAt: number;
  peakPrice: number;
  trailActive: boolean;
  stopPrice: number;
  lastPrice: number;
  lastPriceAt: number;
  lastLiquidityUsd: number;
  filterTicketId: string;
  analystTicketId: string;
  entryReason: string;
  buySig?: string;
}

export interface ClosedTrade extends Position {
  exitPrice: number;
  proceedsSol: number;
  pnlSol: number;
  pnlPct: number;
  closedAt: number;
  exitReason: string;
  sellSig?: string;
}

export type DecisionKind = 'scout' | 'pass' | 'kill' | 'hold' | 'reject' | 'score' | 'buy' | 'exit' | 'info' | 'warn' | 'error';

export interface Decision {
  ts: number;
  agent: AgentName;
  kind: DecisionKind;
  leadId?: string;
  mint?: string;
  symbol?: string;
  reason: string;
  data?: Record<string, unknown>;
}

export interface ExitOrder {
  positionId: string;
  mint: string;
  reason: string;
  markPrice: number;
}
