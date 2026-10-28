import { activity, bus } from '../bus';
import { clock } from '../clock';
import type { Desk } from '../desk';
import { sym } from '../desk';
import type { Lead } from '../types';

// SCOUT — finds new pairs. Owns: discovery only. Never judges, never trades.
//   • every pump.fun launch → recorded against the dev wallet (feeds the dev-history check)
//   • every pump.fun graduation to PumpSwap and every new Raydium SOL pool → a lead for FILTER
//   Bonding-curve tokens are NOT forwarded: they have no LP to lock, so they can never
//   pass the LP rule. They become leads the moment they graduate (LP is burned on migration).
export class Scout {
  private seen = new Map<string, number>();
  private seq = 0;
  constructor(private d: Desk) {}

  async start() {
    activity.state('SCOUT', 'busy');
    await this.d.market.start(
      (l) => this.onLead(l),
      (e) => {
        if (!e.creator) return;
        (this.d.creators.launches[e.creator] ??= []).push(e.ts);
        this.d.creators.mintCreator[e.mint] = { creator: e.creator, symbol: e.symbol, name: e.name, ts: e.ts };
        activity.inc('SCOUT', 'launches');
      },
      (msg, ok) => bus.decide({ agent: 'SCOUT', kind: ok ? 'info' : 'warn', reason: msg }),
    );
    clock.every(3600_000, () => { const cut = clock.now() - 24 * 3600_000; for (const [m, t] of this.seen) if (t < cut) this.seen.delete(m); });
  }

  private onLead(l: Omit<Lead, 'id'>) {
    if (this.seen.has(l.mint)) return;
    this.seen.set(l.mint, clock.now());
    const known = this.d.creators.mintCreator[l.mint];
    const lead: Lead = { ...l, id: `L-${String(++this.seq).padStart(5, '0')}`,
      symbol: l.symbol || known?.symbol || '', name: l.name || known?.name || '', creator: l.creator ?? known?.creator ?? null };
    activity.inc('SCOUT', 'leads');
    bus.decide({ agent: 'SCOUT', kind: 'scout', leadId: lead.id, mint: lead.mint, symbol: lead.symbol,
      reason: `${sym(lead.symbol, lead.mint)} ${lead.source} → FILTER` });
    bus.emit('lead', lead);
  }
}
