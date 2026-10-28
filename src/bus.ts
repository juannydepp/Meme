import { EventEmitter } from 'node:events';
import type { AgentName, AnalystTicket, ClosedTrade, Decision, ExitOrder, FilterTicket, Lead, Position } from './types';
import { clock } from './clock';

// The hand-off lanes. Each agent subscribes ONLY to its upstream lane:
//   SCOUT  --lead-->          FILTER
//   FILTER --filter.pass-->   ANALYST
//   ANALYST--analyst.pass-->  EXECUTOR
//   EXECUTOR--position.opened--> RISK
//   RISK   --exit.order-->    EXECUTOR
//   everyone --decision-->    LOGGER
type Lanes = {
  lead: Lead;
  'filter.pass': FilterTicket;
  'analyst.pass': AnalystTicket;
  'position.opened': Position;
  'position.closed': ClosedTrade;
  'exit.order': ExitOrder;
  decision: Decision;
};

class Bus {
  private ee = new EventEmitter();
  constructor() { this.ee.setMaxListeners(50); }
  emit<K extends keyof Lanes>(lane: K, payload: Lanes[K]) { this.ee.emit(lane, payload); }
  on<K extends keyof Lanes>(lane: K, fn: (p: Lanes[K]) => void | Promise<void>) {
    this.ee.on(lane, (p) => {
      Promise.resolve(fn(p)).catch((e) =>
        this.decide({ agent: 'LOGGER', kind: 'error', reason: `handler crash on ${String(lane)}: ${e?.message ?? e}` }));
    });
  }
  decide(d: Omit<Decision, 'ts'> & { ts?: number }) {
    const full: Decision = { ts: d.ts ?? clock.now(), ...d } as Decision;
    this.ee.emit('decision', full);
    activity.touch(full.agent, full.reason);
  }
}
export const bus = new Bus();

// live agent status for the terminal
export interface AgentStatus { name: AgentName; state: 'idle' | 'busy' | 'waiting' | 'halted' | 'down'; last: string; lastAt: number; counters: Record<string, number>; }
class Activity {
  agents = new Map<AgentName, AgentStatus>();
  constructor() {
    for (const n of ['SCOUT', 'FILTER', 'ANALYST', 'EXECUTOR', 'RISK', 'LOGGER'] as AgentName[])
      this.agents.set(n, { name: n, state: 'idle', last: 'starting', lastAt: 0, counters: {} });
  }
  touch(n: AgentName, last: string) { const a = this.agents.get(n)!; a.last = last; a.lastAt = clock.now(); }
  state(n: AgentName, s: AgentStatus['state']) { this.agents.get(n)!.state = s; }
  inc(n: AgentName, k: string, by = 1) { const c = this.agents.get(n)!.counters; c[k] = (c[k] ?? 0) + by; }
  get(n: AgentName) { return this.agents.get(n)!; }
}
export const activity = new Activity();
