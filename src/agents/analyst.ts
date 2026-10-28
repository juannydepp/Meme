import { activity, bus } from '../bus';
import { clock } from '../clock';
import { CONFIG } from '../config';
import type { Desk } from '../desk';
import { pct, sym, usd } from '../desk';
import { claimAnalystIssuer } from '../tickets';
import type { FilterTicket } from '../types';

// ANALYST — scores every Filter survivor 0..1. Under 0.6 = no trade.
// Owns: the score. Never sizes, never trades, never sees a token Filter killed.
//
// The score is deterministic arithmetic on the Filter's snapshot — no model that can
// "talk itself into" a trade. Every component is logged so you can audit any score.
//
//   flow          0.25  buyers vs sellers over the last hour (50% = 0, 65%+ = 1)
//   notLate       0.20  hasn't already run: 1h change <= +40% = 1, >= +250% = 0; dumping now = 0
//   depth         0.20  our size vs pool: <= 0.5% of liquidity = 1, >= 3% = 0
//   momentum      0.15  last 5m volume pace vs the hour's average pace
//   distribution  0.10  top-10 share: 5% = 1, 20% = 0
//   participation 0.10  trade count in the hour: 200 = 0, 1500+ = 1
//
// Confidence never changes size. A 0.95 gets the same size as a 0.61.

const issue = claimAnalystIssuer();
const lerp = (v: number, zeroAt: number, oneAt: number) => Math.max(0, Math.min(1, (v - zeroAt) / (oneAt - zeroAt)));
const W = { flow: 0.25, notLate: 0.2, depth: 0.2, momentum: 0.15, distribution: 0.1, participation: 0.1 } as const;

export class Analyst {
  constructor(private d: Desk) {}
  start() {
    bus.on('filter.pass', (t) => this.score(t));
  }

  private score(t: FilterTicket) {
    activity.state('ANALYST', 'busy');
    activity.inc('ANALYST', 'in');
    const s = t.snapshot;
    const tag = sym(t.symbol, t.mint);
    const ourUsd = CONFIG.maxPositionPct * this.d.state.balanceSol * this.d.solUsd;
    const buyShare = s.buysH1 + s.sellsH1 > 0 ? s.buysH1 / (s.buysH1 + s.sellsH1) : 0;
    const paceRatio = s.volH1 > 0 ? (s.volM5 * 12) / s.volH1 : 0;
    const poolShare = s.liquidityUsd > 0 ? (ourUsd / s.liquidityUsd) * 100 : 100;
    const dumping = s.changeM5 <= -12 || (s.sellsM5 > s.buysM5 * 1.5 && s.changeM5 < -5);

    const c = {
      flow: lerp(buyShare, 0.5, 0.65),
      notLate: dumping ? 0 : 1 - lerp(s.changeH1, 40, 250),
      depth: 1 - lerp(poolShare, 0.5, 3),
      momentum: lerp(paceRatio, 0.3, 1.2),
      distribution: 1 - lerp(t.safety.top10Pct ?? 20, 5, 20),
      participation: lerp(s.buysH1 + s.sellsH1, 200, 1500),
    };
    const score = Object.entries(W).reduce((a, [k, w]) => a + w * c[k as keyof typeof c], 0);
    const reasons = [
      `buyers ${(buyShare * 100).toFixed(0)}% of 1h txns`,
      `1h ${pct(s.changeH1, 0)}, 5m ${pct(s.changeM5, 0)}${dumping ? ' (dumping)' : ''}`,
      `our size ≈${poolShare.toFixed(2)}% of ${usd(s.liquidityUsd)} pool`,
      `5m pace ${paceRatio.toFixed(2)}x hourly avg`,
      `top10 ${(t.safety.top10Pct ?? 0).toFixed(1)}%`,
      `${s.buysH1 + s.sellsH1} txns/1h`,
    ];
    const rounded = Math.round(score * 1000) / 1000;
    const comps = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 100) / 100]));

    if (rounded < CONFIG.minScore) {
      activity.inc('ANALYST', 'reject');
      bus.decide({ agent: 'ANALYST', kind: 'reject', mint: t.mint, symbol: t.symbol, leadId: t.leadId,
        reason: `NO TRADE ${tag} score ${rounded.toFixed(2)} < ${CONFIG.minScore} — weakest: ${weakest(comps)}`, data: { score: rounded, components: comps, reasons } });
    } else {
      const ticket = issue({ filterTicketId: t.ticketId, mint: t.mint, symbol: t.symbol, score: rounded, components: comps, reasons, issuedAt: clock.now() });
      activity.inc('ANALYST', 'approve');
      bus.decide({ agent: 'ANALYST', kind: 'score', mint: t.mint, symbol: t.symbol, leadId: t.leadId,
        reason: `APPROVE ${tag} score ${rounded.toFixed(2)} → EXECUTOR [${ticket.ticketId}]`, data: { score: rounded, components: comps, reasons } });
      bus.emit('analyst.pass', ticket);
    }
    activity.state('ANALYST', 'idle');
  }
}

const weakest = (c: Record<string, number>) => Object.entries(c).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
