import { activity, bus } from '../bus';
import { clock } from '../clock';
import { CONFIG } from '../config';
import type { Desk } from '../desk';
import { sym, usd } from '../desk';
import { claimFilterIssuer } from '../tickets';
import type { CheckResult, Lead, PairSnapshot, SafetyReport } from '../types';

// FILTER — kills anything that fails a hard rule. Owns: pass/kill. Never scores, never trades.
//
//   mint_revoked     mint authority must be null              (fail = dead)
//   freeze_revoked   freeze authority must be null            (fail = dead)  ← added: freeze = honeypot
//   lp_locked        LP >= 95% locked/burned                  (fail = re-check later)
//   top10            top 10 holders <= 20%, pools/burn excl.  (fail = re-check later)
//   volume_1h        >= $50k volume in the last hour          (fail = re-check later)
//   pool_age         pool open >= 20 min (skip the graduation spike) (fail = re-check later)
//   dev_clean        dev not tied to previous rugs            (fail = dead)
//
// "Re-check later" exists because a 3-minute-old pool can't have $50k of hourly volume
// yet. Young leads are re-tested on a schedule (2…60 min). Every check must pass in the
// SAME snapshot to get a ticket. Any missing data = fail (fail-closed, never assume).

const issue = claimFilterIssuer();

export class Filter {
  private inflight = 0;
  private queue: { lead: Lead; attempt: number }[] = [];
  private devCache = new Map<string, { at: number; res: CheckResult }>();
  private waiting = new Map<string, Lead>();
  constructor(private d: Desk) {}

  start() {
    activity.state('FILTER', 'idle');
    bus.on('lead', (lead) => { activity.inc('FILTER', 'in'); this.enqueue(lead, 0); });
  }
  get waitingCount() { return this.waiting.size; }

  private enqueue(lead: Lead, attempt: number) { this.queue.push({ lead, attempt }); this.pump(); }
  private pump() {
    while (this.inflight < 3 && this.queue.length) {
      const job = this.queue.shift()!;
      this.inflight++; activity.state('FILTER', 'busy');
      this.evaluate(job.lead, job.attempt)
        .catch((e) => bus.decide({ agent: 'FILTER', kind: 'error', leadId: job.lead.id, mint: job.lead.mint, reason: `filter crashed: ${e?.message ?? e}` }))
        .finally(() => { this.inflight--; if (!this.inflight && !this.queue.length) activity.state('FILTER', this.waiting.size ? 'waiting' : 'idle'); this.pump(); });
    }
  }

  private async evaluate(lead: Lead, attempt: number) {
    const tag = sym(lead.symbol, lead.mint);
    let safety: SafetyReport | null = null, snap: PairSnapshot | undefined;
    const [s, p] = await Promise.allSettled([this.d.market.safety(lead.mint), this.d.market.pairs([lead.mint])]);
    if (s.status === 'fulfilled') safety = s.value;
    if (p.status === 'fulfilled') snap = p.value.get(lead.mint);
    if (snap && !lead.symbol) lead.symbol = snap.symbol;

    const checks: CheckResult[] = [];
    const add = (name: string, pass: boolean, value: string, rule: string, permanent: boolean) => checks.push({ name, pass, value, rule, permanent });

    if (!safety) {
      add('safety_data', false, `unavailable (${s.status === 'rejected' ? String((s.reason as Error)?.message ?? s.reason).slice(0, 60) : '?'})`, 'contract report required', false);
    } else {
      add('mint_revoked', safety.mintAuthority === null, safety.mintAuthority === null ? 'revoked' : `ACTIVE ${String(safety.mintAuthority).slice(0, 6)}…`, 'mint authority = none', true);
      add('freeze_revoked', safety.freezeAuthority === null, safety.freezeAuthority === null ? 'revoked' : `ACTIVE ${String(safety.freezeAuthority).slice(0, 6)}…`, 'freeze authority = none', true);
      add('lp_locked', safety.lpLockedPct !== null && safety.lpLockedPct >= CONFIG.minLpLockedPct,
        safety.lpLockedPct === null ? 'unknown' : `${safety.lpLockedPct.toFixed(0)}%`, `>= ${CONFIG.minLpLockedPct}%`, false);
      add('top10', safety.top10Pct !== null && safety.top10Pct <= CONFIG.top10MaxPct,
        safety.top10Pct === null ? 'unknown' : `${safety.top10Pct.toFixed(1)}%`, `<= ${CONFIG.top10MaxPct}%`, false);
    }
    if (!snap) add('pair_data', false, 'no SOL pair indexed yet', 'price + volume data required', false);
    else add('volume_1h', snap.volH1 >= CONFIG.minVolumeH1, usd(snap.volH1), `>= ${usd(CONFIG.minVolumeH1)}`, false);
    if (snap) {
      // the first minutes after graduation are a spike that usually dumps; the $50k/1h volume is mostly that spike
      const ageMin = snap.pairCreatedAt > 0 ? (clock.now() - snap.pairCreatedAt) / 60_000 : null;
      add('pool_age', ageMin !== null && ageMin >= CONFIG.minPairAgeMin, ageMin === null ? 'unknown' : `${ageMin.toFixed(0)}m`, `>= ${CONFIG.minPairAgeMin}m since pool opened`, false);
    }

    // dev check is the expensive one; skip it if something already killed the lead for good
    if (!checks.some((c) => !c.pass && c.permanent)) checks.push(await this.devCheck(lead, safety));

    const fails = checks.filter((c) => !c.pass);
    const permanent = fails.filter((c) => c.permanent);
    const why = (cs: CheckResult[]) => cs.map((c) => `${c.name} ${c.value} (need ${c.rule})`).join('; ');

    if (!fails.length && snap && safety) {
      this.waiting.delete(lead.mint);
      const ticket = issue({ leadId: lead.id, mint: lead.mint, symbol: lead.symbol, checks, snapshot: snap, safety, issuedAt: clock.now() });
      activity.inc('FILTER', 'pass');
      bus.decide({ agent: 'FILTER', kind: 'pass', leadId: lead.id, mint: lead.mint, symbol: lead.symbol,
        reason: `PASS ${tag} all ${checks.length} checks → ANALYST [${ticket.ticketId}]`, data: { checks } });
      bus.emit('filter.pass', ticket);
      return;
    }
    if (permanent.length) {
      this.waiting.delete(lead.mint);
      activity.inc('FILTER', 'kill');
      bus.decide({ agent: 'FILTER', kind: 'kill', leadId: lead.id, mint: lead.mint, symbol: lead.symbol,
        reason: `KILL ${tag}: ${why(permanent)}`, data: { checks, killedBy: permanent.map((c) => c.name), creator: lead.creator, price: snap?.priceSol, liq: snap?.liquidityUsd } });
      return;
    }
    // transient: schedule the next re-check, or expire
    const ageMin = (clock.now() - lead.discoveredAt) / 60_000;
    const next = CONFIG.recheckMinutes.find((m) => m > ageMin + 0.25);
    if (next === undefined) {
      this.waiting.delete(lead.mint);
      activity.inc('FILTER', 'kill');
      bus.decide({ agent: 'FILTER', kind: 'kill', leadId: lead.id, mint: lead.mint, symbol: lead.symbol,
        reason: `KILL ${tag}: still failing after 60m — ${why(fails)}`, data: { checks, killedBy: fails.map((c) => c.name), expired: true, creator: lead.creator, price: snap?.priceSol, liq: snap?.liquidityUsd } });
      return;
    }
    this.waiting.set(lead.mint, lead);
    if (attempt === 0) activity.inc('FILTER', 'hold');
    bus.decide({ agent: 'FILTER', kind: 'hold', leadId: lead.id, mint: lead.mint, symbol: lead.symbol,
      reason: `HOLD ${tag}: ${why(fails)} — re-check at ${next}m`, data: { checks, attempt } });
    clock.after((next - ageMin) * 60_000, () => this.enqueue(lead, attempt + 1));
  }

  private async devCheck(lead: Lead, safety: SafetyReport | null): Promise<CheckResult> {
    const db = this.d.creators;
    const creator = lead.creator ?? safety?.creator ?? db.mintCreator[lead.mint]?.creator ?? null;
    lead.creator = creator;
    const rule = 'dev not linked to past rugs';
    if (!creator) return { name: 'dev_clean', pass: false, value: 'dev wallet unknown', rule, permanent: false };
    const short = `${creator.slice(0, 4)}…${creator.slice(-4)}`;
    const fail = (value: string, permanent = true): CheckResult => {
      const res = { name: 'dev_clean', pass: false, value, rule, permanent };
      this.devCache.set(creator, { at: clock.now(), res });
      return res;
    };
    // blacklist/rug history are re-read every time (the Logger can blacklist a dev at any moment)
    if (db.blacklist[creator]) return fail(`dev ${short} blacklisted: ${db.blacklist[creator]}`);
    if (db.rugged[creator]?.length) return fail(`dev ${short} rugged ${db.rugged[creator].length} token(s) before`);
    const cached = this.devCache.get(creator);
    if (cached && clock.now() - cached.at < 10 * 60_000 && cached.res.pass) {
      const f = db.funders[creator];
      if (!f || !db.blacklist[f]) return cached.res;
    }
    const flagged = safety?.riskNames.find((r) => /rug/i.test(r));
    if (flagged) return fail(`rugcheck flag on dev: ${flagged}`);
    const launches = (db.launches[creator] ?? []).filter((t) => t > clock.now() - 72 * 3600_000).length;
    if (launches >= CONFIG.serialLaunchMax) return fail(`dev ${short} launched ${launches} tokens in 72h (serial launcher)`);

    let funder = db.funders[creator];
    if (funder === undefined) {
      try { funder = await Promise.race([this.d.market.firstFunder(creator), clock.sleep(15_000).then(() => { throw new Error('timeout'); })]) as string | null; db.funders[creator] = funder; }
      catch (e) { return { name: 'dev_clean', pass: false, value: `funder lookup failed (${(e as Error).message})`, rule, permanent: false }; }
    }
    if (funder && db.blacklist[funder]) return fail(`dev ${short} funded by blacklisted ${funder.slice(0, 4)}…: ${db.blacklist[funder]}`);
    if (funder) {
      // a shared funder only counts as a link when it funds a handful of devs — an exchange
      // hot wallet funds thousands and would otherwise blacklist everyone it ever paid
      const funded = Object.entries(db.funders).filter(([c, f]) => f === funder && c !== creator);
      const ruggers = funded.filter(([c]) => db.rugged[c]?.length);
      if (ruggers.length && funded.length <= 15)
        return fail(`dev ${short} shares funder ${funder.slice(0, 4)}… with ${ruggers.length} known rugger(s)`);
    }
    const res: CheckResult = { name: 'dev_clean', pass: true, value: `dev ${short} clean (${launches} launch/72h)`, rule, permanent: true };
    this.devCache.set(creator, { at: clock.now(), res });
    return res;
  }
}
