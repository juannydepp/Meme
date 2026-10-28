import type { AnalystTicket, FilterTicket } from './types';

// Pass tickets are the hard hand-off. Only the Filter holds the filter issuer,
// only the Analyst holds the analyst issuer (each can be claimed exactly once).
// The Executor can only *verify* tickets — it can never mint one — so it is
// structurally impossible for it to trade something that skipped a gate.

const filterTickets = new Map<string, FilterTicket>();
const analystTickets = new Map<string, AnalystTicket>();
let filterClaimed = false, analystClaimed = false, seq = 0;

export function claimFilterIssuer() {
  if (filterClaimed) throw new Error('filter issuer already claimed');
  filterClaimed = true;
  return (t: Omit<FilterTicket, 'ticketId'>): FilterTicket => {
    const ticket = deepFreeze({ ...t, ticketId: `F-${++seq}` }) as FilterTicket;
    filterTickets.set(ticket.ticketId, ticket);
    return ticket;
  };
}

export function claimAnalystIssuer() {
  if (analystClaimed) throw new Error('analyst issuer already claimed');
  analystClaimed = true;
  return (t: Omit<AnalystTicket, 'ticketId'>): AnalystTicket => {
    if (!filterTickets.has(t.filterTicketId)) throw new Error('analyst ticket must reference a real filter ticket');
    const ticket = deepFreeze({ ...t, ticketId: `A-${++seq}` }) as AnalystTicket;
    analystTickets.set(ticket.ticketId, ticket);
    return ticket;
  };
}

/** Executor-side verification. Returns the reason it fails, or null if valid. */
export function verifyTickets(analystTicketId: string): { filter?: FilterTicket; analyst?: AnalystTicket; problem: string | null } {
  const analyst = analystTickets.get(analystTicketId);
  if (!analyst) return { problem: 'no analyst ticket on record' };
  const filter = filterTickets.get(analyst.filterTicketId);
  if (!filter) return { analyst, problem: 'no filter ticket on record' };
  if (filter.mint !== analyst.mint) return { analyst, filter, problem: 'ticket mint mismatch' };
  const failed = filter.checks.filter((c) => !c.pass);
  if (failed.length) return { analyst, filter, problem: `filter ticket has failing checks: ${failed.map((c) => c.name).join(',')}` };
  return { analyst, filter, problem: null };
}

export function pruneTickets(olderThan: number) {
  for (const [k, t] of filterTickets) if (t.issuedAt < olderThan) filterTickets.delete(k);
  for (const [k, t] of analystTickets) if (t.issuedAt < olderThan) analystTickets.delete(k);
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') { Object.values(o as object).forEach(deepFreeze); Object.freeze(o); }
  return o;
}
