// bot-change: one of the Homeroom bot's changes, from the moment it goes up
// for a vote until it is live or closed. One instance per change
// (`session:<id>`), created by the first thing a machine tells it: the
// proposal machine's promote (Proposed), the preview's verdict, the shots
// settling, the merge (each a message the sender's own transition writes:
// rules/bot-notes.ts).
//
//   checking ──verdict passes, shots still to come──▶ waiting_on_shots ──settled / held long enough──▶ ready
//      │   └──part of it fails (checks, or its shots)──▶ with_the_bot ──the bot's round looked──▶ ready
//      └──its preview will not start──▶ stopped          merged ──live──▶ live        (any) ──closed──▶ closed
//
// Under its lock it decides what its requester and its approvers hear and
// when the change goes back to the bot to fix: ready to try, once per
// approval epoch (and its approvers asked once, when nothing is broken);
// back to the bot when its checks fail or its shots show part of it failing
// or could not reach part of it for want of seed data, once per head; and,
// once merged and live, that it is live. Every decision is made from the
// session's row (facts.ts) with the transaction's clock, so a message is
// only "look now": a late or repeated one decides the same thing again.
// Its work only sends (services.ts), each item keyed so it is said once.
// workflow-foundation's design-bot-notes.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, Event, Json, Machine, Outcome, Push, TransitionContext, Tx, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { toUser } from '../pushes.ts';
import { BOT_CHANGE, botChangeKey } from '../rules/bot-notes.ts';
import { checksDue, readiness } from '../rules/bot-readiness.ts';
import type { Claim } from '../rules/bot-readiness.ts';
import { NO_FACTS, readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = BOT_CHANGE;
export const sessionKey = botChangeKey;
export const WORK = Object.freeze({
  ready: 'bot.tellReady',
  stopped: 'bot.tellStopped',
  fix: 'bot.queueFix',
  merged: 'bot.stopRequestWork',
  liveDm: 'bot.tellLive',
  livePost: 'bot.commentLive',
  approved: 'bot.tellApproved',
  // #6264: the promises people asked for, kept where they asked.
  followups: 'bot.tellFollowups',
});
// How often a change being merged is looked at again (a merge GitHub does
// not confirm puts it back up for its vote).
export const FIX_LOOK_MS = 10 * 60 * 1000;
// A change handed back to the bot waits for the bot's answer: its request's
// instance (bot-request) tells it how the round it asked for ended
// (FixRoundEnded, with `outcome`), or that it was not taken (FixRefused).
// A round lost (its look ended without it, or failed for good) is asked
// once more (Q3); lost again, it is given up on: a change whose checks pass
// is ready to try, saying what does not work; one whose checks fail is left
// as [main] left it (nobody is told). A round a person stopped is not asked
// again for that head: it is asked when it is next needed (a new verdict,
// its shots, a promote), as a refusal is (design-bot-loop Q1).
export const FIX_ROUNDS = 2;
// The outcomes of a round that did not look at the head.
const LOST: ReadonlySet<string> = new Set(['lost', 'requeued']);

// ── State ───────────────────────────────────────────────────────────────

type Name = 'checking' | 'waiting_on_shots' | 'with_the_bot' | 'ready' | 'stopped' | 'merged' | 'live' | 'closed';
// A work item and what came of it, for Admin → Workflows' retry.
interface Note { kind: string; input: Json; status: 'pending' | 'done' | 'failed' | 'exhausted' | 'retried'; error?: string }
// The change handed back to the bot for this head: whether a round is asked
// and not answered yet (`asked`), how many were lost (`lost`), and why the
// bot would not take the last ask (`refused`: off, not on this app, the
// platform's failure, which it says itself; asked again on the next verdict),
// or that it gave up waiting (`gaveUp`, for this head).
interface Fix { head: string; asked: boolean; lost: number; refused: string | null; gaveUp: boolean }
export interface Data {
  sessionId: number;
  appId: number;
  // The epoch whose ready card was asked for.
  told: number | null;
  stoppedEpoch: number | null;
  fix: Fix | null;
  notes: Record<string, Note>;
}
export type BState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<BState, { data: Data }>;

// Live is the end. A closed change may be reopened and put up for a vote
// again (the proposal machine's Reopen): its next Proposed follows it again.
const FINAL: ReadonlySet<string> = new Set(['live']);
const UP: ReadonlySet<string> = new Set(['promoted', 'merging', 'merged']);

// ── Events ──────────────────────────────────────────────────────────────

const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optSha = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : null);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const session = (p: any) => ({ sessionId: int(p?.sessionId, 'sessionId') });

const EVENTS = {
  Proposed: session,
  Verdict: (p: any) => ({ ...session(p), head: optSha(p?.head), state: text(p?.state, 32) }),
  ShotsSettled: session,
  PreviewStopped: (p: any) => ({ ...session(p), head: optSha(p?.head) }),
  FixRoundEnded: (p: any) => ({ ...session(p), head: optSha(p?.head), outcome: text(p?.outcome, 20) }),
  FixRefused: (p: any) => ({ ...session(p), head: optSha(p?.head), why: text(p?.why, 64) }),
  Merged: (p: any) => ({ ...session(p), before: text(p?.before, 40) }),
  Live: session,
  Closed: (p: any) => ({ ...session(p), reason: text(p?.reason, 64) }),
  Look: () => ({}),
  // A vote on the change, appended in the vote's own statement
  // (routes/votes.js recordVote, retractVote): `vote` 'retracted' for one
  // taken back. `epoch`: the approval epoch it was cast at.
  Voted: (p: any) => {
    if (!['yes', 'no', 'retracted'].includes(p?.vote)) throw new Error('vote must be yes, no or retracted');
    const epoch = Number(p?.epoch);
    return { ...session(p), voterId: int(p?.voterId, 'voterId'), voter: text(p?.voter, 100), vote: p.vote as string,
      epoch: Number.isInteger(epoch) && epoch >= 0 ? epoch : 0 };
  },
  RetryFollowup: (p: any) => {
    if (typeof p?.workKey !== 'string' || !p.workKey) throw new Error('workKey is required');
    return { workKey: p.workKey as string };
  },
};
// Whatever tells it about a change first creates it (a verdict can be
// heard before the promote's own message, a merge of a change an older
// release proposed before its adoption).
const CREATE = ['Proposed', 'Verdict', 'ShotsSettled', 'PreviewStopped', 'FixRoundEnded', 'Merged', 'Live'];
// What a verdict, a settle or a promote says anew: a round the bot would
// not take on this head is asked again (its settings, its live list or the
// failure's look may have changed).
const NEWS: ReadonlySet<string> = new Set(['Verdict', 'ShotsSettled', 'Proposed']);

// ── Moves ───────────────────────────────────────────────────────────────

const step = (name: Name, data: Data, more: Omit<Outcome<BState>, 'next'> = {}): Outcome<BState> =>
  ({ next: { name, data }, ...more });

// Work, recorded as a note so an admin can ask for it again.
function asked(d: Data, work: WorkRequest[]): Data {
  if (!work.length) return d;
  const notes = { ...d.notes };
  for (const w of work) notes[w.key] = { kind: w.kind, input: w.input, status: 'pending' };
  return { ...d, notes };
}

// The tray of whoever asked for it reads again (homeroom-bot-tray.js: the
// strip in their chat with the bot; it reads its records on the event).
// A promote's: the proposal machine's message (an adoption at boot pushes
// nothing). A close's is pushed by the close's own write (rules/bot-notes.ts),
// for a change this machine never followed too.
const tray = (f: Facts): Push[] => (f.requesterId ? [toUser(f.requesterId, { type: 'homeroom_bot_work_changed' })] : []);
const fromProposal = (e: Event<any>) => e.source.kind === 'message' && e.source.from.machine === 'proposal';

const words = (claims: Claim[]) => claims.map((c) => c.claim).filter(Boolean).slice(0, 3);
const shortSha = (sha: string) => sha.slice(0, 12);
const lookIn = (ctx: TransitionContext) => ({ at: new Date(ctx.now.getTime() + FIX_LOOK_MS), event: { type: 'Look' } });

// What the change's row says now, decided once: the one rule every look
// runs (a verdict, the shots settling, the bot's round, the clock, the
// promote). A change not up for a vote waits for its promote; one being
// merged keeps its clock (a merge GitHub does not confirm puts it back up
// for its vote); one merged waits for its Merged and its Live.
function decide(s: Live | null, f: Facts, ctx: TransitionContext, base: Data, extra: { push?: Push[] } = {}): Outcome<BState> {
  const row = f.row!;
  let d = base;
  const now = ctx.now.getTime();
  // #6264: the promises people asked for, kept by the change's own moments.
  // Each is keyed so it is asked once: the checks' by the head they were
  // about, the vote's by the approval epoch. Firing is a no-op when nobody
  // is waiting.
  const follow: WorkRequest[] = [];
  const checkState = String(row.check_state || '');
  const checksKey = row.reviewed_head_sha ? `followups:checks:${shortSha(String(row.reviewed_head_sha))}` : null;
  if (checksKey && ['passing', 'skipped', 'failing'].includes(checkState) && !d.notes[checksKey]) {
    follow.push({ kind: WORK.followups, key: checksKey,
      input: { sessionId: d.sessionId, event: 'checks', head: String(row.reviewed_head_sha), verdict: checkState } });
  }
  if (follow.length) d = asked(d, follow);
  const at = (name: Name, more: Omit<Outcome<BState>, 'next'> = {}) =>
    step(name, d, { push: extra.push, ...(follow.length ? { work: follow } : {}), ...more });
  const kept = (s?.name as Name) || 'checking';
  // (A timer that fired is spent: a look while it is being merged arms the
  // next one for what it was waiting on.)
  // While it is being merged its clock looks again until it is merged or
  // back up for its vote: what it waited on, or a card it was not sent.
  if (row.status === 'merging') return at(kept === 'merged' ? 'checking' : kept, { timer: lookIn(ctx) });
  if (row.status === 'merged') return at('merged', { timer: null });
  if (row.status !== 'promoted') return at('checking', { timer: null });
  const r = readiness(row, now);
  const due = checksDue({ ...row, looked: f.looked, fix_revised: f.fixRevised });
  const fixHere = d.fix && due && d.fix.head === due.head ? d.fix : null;
  // Its shots on the head still to come: it waits, at most READY_HOLD_MS
  // after the later of the verdict and the slot's last move.
  if (r.checked && r.heldUntil != null) {
    return at('waiting_on_shots', { timer: { at: new Date(r.heldUntil + 1000), event: { type: 'Look' } } });
  }
  // Part of it fails, and no round looked at this head yet: it goes back to
  // the bot, once per head (its round revises it, a new head, or records it
  // looked), unless the bot would not take it or gave up waiting. (With its
  // checks passed, what is due is what its shots show.)
  if (due && !(fixHere && (fixHere.refused || fixHere.gaveUp))) {
    if (fixHere?.asked) return at('with_the_bot', { timer: null });
    return askFix(d, due.head, fixHere?.lost || 0, ctx, extra);
  }
  // Failing checks the bot does not fix (it is off, not on this app, or the
  // failure looks like the platform's and it said so itself): nobody else is
  // told anything, as on [main].
  if (!r.checked) return at('checking', { timer: null });
  // Ready to try: said once per epoch, saying what does not work. An epoch
  // asked before and not sent (it was being merged meanwhile) is asked
  // again under a key of its own; the DM's own key is the epoch's.
  const broken = words(r.broken);
  const first = `ready:${r.epoch}`;
  const voteKey = `followups:vote:${r.epoch}`;
  const work: WorkRequest[] = d.told === r.epoch ? [] : [{
    kind: WORK.ready, key: d.notes[first] ? `${first}:v${ctx.version + 1}` : first,
    input: { sessionId: d.sessionId, epoch: r.epoch, broken },
  }];
  // Whoever asked to be told when it is ready to vote hears it once, at
  // this epoch (a later epoch is a newer change to vote on).
  if (!d.notes[voteKey]) {
    work.push({ kind: WORK.followups, key: voteKey, input: { sessionId: d.sessionId, event: 'vote', epoch: r.epoch } });
  }
  if (!work.length) return at('ready', { timer: null });
  d = asked({ ...d, ...(d.told === r.epoch ? {} : { told: r.epoch }) }, work);
  return step('ready', d, { push: extra.push, work: [...follow, ...work], timer: null });
}

// Keyed by the instance's version: a head left and come back to is asked
// again under a key of its own.
function askFix(base: Data, head: string, lost: number, ctx: TransitionContext, extra: { push?: Push[] } = {}): Outcome<BState> {
  const work: WorkRequest[] = [{ kind: WORK.fix, key: `fix:${shortSha(head)}:v${ctx.version + 1}`, input: { sessionId: base.sessionId, head } }];
  const d = asked({ ...base, fix: { head, asked: true, lost, refused: null, gaveUp: false } }, work);
  return step('with_the_bot', d, { work, push: extra.push, timer: null });
}

// The bot's answer about the round it was asked for: looked at the head
// (decided now: the round recorded it), lost (asked once more, then given
// up on), or not taken (decided without a round, until the next verdict
// asks again). An answer about a head the change has left decides nothing
// new.
function answered(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<BState> {
  const fix = s.data.fix;
  if (!fix || !fix.asked || (e.payload.head && e.payload.head !== fix.head)) return decide(s, f, ctx, s.data);
  if (e.type === 'FixRefused') return decide(s, f, ctx, { ...s.data, fix: { ...fix, asked: false, refused: e.payload.why || 'refused' } });
  if (e.payload.outcome === 'stopped') return decide(s, f, ctx, { ...s.data, fix: { ...fix, asked: false, refused: 'stopped' } });
  if (!LOST.has(String(e.payload.outcome || '')) || f.looked || !f.row || f.row.status !== 'promoted') {
    return decide(s, f, ctx, { ...s.data, fix: { ...fix, asked: false } });
  }
  const due = checksDue({ ...f.row, looked: f.looked, fix_revised: f.fixRevised });
  if (!due || due.head !== fix.head) return decide(s, f, ctx, { ...s.data, fix: { ...fix, asked: false } });
  const lost = fix.lost + 1;
  if (lost < FIX_ROUNDS) return askFix(s.data, fix.head, lost, ctx);
  return decide(s, f, ctx, { ...s.data, fix: { ...fix, asked: false, lost, gaveUp: true } });
}

function created(e: Event<any>, f: Facts): Data {
  return { sessionId: e.payload.sessionId, appId: f.row!.app_id, told: null, stoppedEpoch: null, fix: null, notes: {} };
}

// A look from anything that tells it: a verdict, a settle, a round that
// ended, the promote, the clock. A closed change put up for a vote again
// is followed again from here.
function look(s: BState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<BState> {
  const live = s.name === NONE ? null : (s as Live);
  let d = live ? live.data : created(e, f);
  if (NEWS.has(e.type) && d.fix?.refused) d = { ...d, fix: { ...d.fix, refused: null } };
  const push = e.type === 'Proposed' && fromProposal(e) ? tray(f) : undefined;
  if (live && live.name === 'with_the_bot' && (e.type === 'FixRoundEnded' || e.type === 'FixRefused')) return answered(live, e, f, ctx);
  return decide(live && live.name !== 'closed' ? live : null, f, ctx, d, { push });
}

// Its preview will not start: said quietly, once per epoch. What the change
// waits on otherwise (its shots, the bot's round) keeps its clock. #6536: a
// preview build that failed with its own error is a fix due, so the same
// decision that sends failing checks back to the bot sends this one.
function stopped(s: BState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<BState> {
  const live = s.name === NONE ? null : (s as Live);
  const d = live ? live.data : created(e, f);
  if (live && live.name !== 'closed'
      && checksDue({ ...f.row!, looked: f.looked, fix_revised: f.fixRevised })) {
    return decide(live, f, ctx, d);
  }
  const name: Name = !live || live.name === 'checking' || live.name === 'ready' ? 'stopped' : live.name as Name;
  const epoch = Number(f.row!.approval_epoch) || 0;
  if (f.row!.status !== 'promoted' || d.stoppedEpoch === epoch) return step((live?.name as Name) || 'checking', d);
  const work: WorkRequest[] = [{ kind: WORK.stopped, key: `stopped:${epoch}`, input: { sessionId: d.sessionId, epoch } }];
  return step(name, asked({ ...d, stoppedEpoch: epoch }, work), { work });
}

// The bot's other work on the request stops, bounded to what had started
// before the merge (the message's, else the row's own merge time).
function stopWork(d: Data, before: string | null, f: Facts): { d: Data; work: WorkRequest[] } {
  if (d.notes.merged) return { d, work: [] };
  const at = before || (f.row?.merged_at ? new Date(f.row.merged_at).toISOString() : null);
  const work: WorkRequest[] = [{ kind: WORK.merged, key: 'merged', input: { sessionId: d.sessionId, before: at } }];
  return { d: asked(d, work), work };
}

// Merged: its other work on the request stops. Then it waits to be live.
function merged(s: BState, e: Event<any>, f: Facts): Outcome<BState> {
  const live = s.name === NONE ? null : (s as Live);
  const { d, work } = stopWork(live ? live.data : created(e, f), e.payload.before, f);
  // #6264: whoever asked to be told it merged hears it, once.
  const tell = followupWork(d, 'merged', 'followups:merged');
  return step('merged', asked(d, tell), { work: [...work, ...tell], timer: null });
}

// #6264: one follow-up work item, unless it was already asked under its key.
function followupWork(d: Data, event: string, key: string, input: Record<string, Json> = {}): WorkRequest[] {
  if (d.notes[key]) return [];
  return [{ kind: WORK.followups, key, input: { sessionId: d.sessionId, event, ...input } }];
}

// Live: whoever asked hears it (their DM, the chip, a first version's line),
// and the request says it (GitHub and its thread). A change that went live
// with no Merged first (an included change, a change adopted late) stops the
// bot's other work on its request too.
function wentLive(s: BState, e: Event<any>, f: Facts): Outcome<BState> {
  const live = s.name === NONE ? null : (s as Live);
  const stop = stopWork(live ? live.data : created(e, f), null, f);
  const work: WorkRequest[] = [
    { kind: WORK.liveDm, key: 'live-dm', input: { sessionId: stop.d.sessionId } },
    { kind: WORK.livePost, key: 'live-post', input: { sessionId: stop.d.sessionId } },
  ];
  // #6264: whoever asked to be told it is live hears it, once.
  const tell = followupWork(stop.d, 'live', 'followups:live');
  return step('live', asked(stop.d, [...work, ...tell]), { work: [...work, ...tell, ...stop.work], timer: null });
}

// A vote: whoever asked for the change reads where its requests stand again
// (they name who it still waits on). 5 Nov 2026 (docs/plans/bot-one-model.md,
// decision 6): a yes is no longer a line in the request's thread ("ada
// approved it."); the change's votes are on its page. WORK.approved stays
// for work owed before, which its service now settles quietly.
function voted(s: BState, _e: Event<any>, f: Facts, _ctx: TransitionContext): Outcome<BState> {
  const live = s as Live;
  return step(live.name as Name, live.data, { work: [], push: tray(f) });
}

// Closed: whoever asked to be told about it hears that it was closed, once,
// and every promise still waiting on it is called off (thread-followups.js).
function closed(s: Live): Outcome<BState> {
  const tell = followupWork(s.data, 'closed', 'followups:closed');
  return step('closed', asked(s.data, tell), { work: tell, timer: null });
}

// A work result: recorded on its note. The fix the bot would not take, or
// the clock's answer that it gave up, is decided again.
function workResult(status: Note['status']) {
  return {
    guard: (s: BState, e: Event<WorkResultPayload>): Check =>
      ((s as Live).data.notes[e.payload.workKey]?.status === 'pending' ? ok() : reject('stale_result')),
    to: (s: BState, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<BState> => {
      const live = s as Live;
      const prev = live.data.notes[e.payload.workKey]!;
      const notes = { ...live.data.notes, [e.payload.workKey]: { ...prev, status, ...(e.payload.error ? { error: e.payload.error.message.slice(0, 500) } : {}) } };
      let d: Data = { ...live.data, notes };
      // A ready card not sent because it was no longer up for a vote (being
      // merged, say): its epoch is not told, and is considered again now and
      // on every later look (a merge GitHub refuses puts it back up).
      if (e.payload.kind === WORK.ready && status === 'done' && (e.payload.result as any)?.notUp) {
        const epoch = Number((prev.input as any)?.epoch);
        if (d.told === epoch) d = { ...d, told: null };
        if (!FINAL.has(live.name) && live.name !== 'merged' && live.name !== 'closed' && f.row) return decide(live, f, ctx, d);
        return step(live.name as Name, d);
      }
      const fix = live.data.fix;
      // A fix result about the head the bot has now; one about a head the
      // change has left only settles its note.
      if (e.payload.kind === WORK.fix && fix && String((prev.input as any)?.head) === fix.head) {
        const r = (e.payload.result || {}) as { queued?: boolean; why?: string };
        // Taken: the round is the bot's (the clock watches its row). Not
        // taken (the bot is off, not on this app, the failure looks like the
        // platform's, which it says itself), or failing for good: decided
        // again without a round, until the next verdict asks again.
        if (status !== 'done' || !r.queued) {
          d = { ...d, fix: { ...fix, asked: false, refused: status === 'done' ? String(r.why || 'refused') : 'failed' } };
          if (!FINAL.has(live.name) && live.name !== 'merged' && live.name !== 'closed' && f.row) return decide(live, f, ctx, d);
        }
      }
      return step(live.name as Name, d);
    },
  };
}

const retryFollowup = {
  guard: (s: BState, e: Event<any>): Check => {
    const n = (s as Live).data.notes[e.payload.workKey];
    return n && ['failed', 'exhausted'].includes(n.status) ? ok() : reject('not_retryable');
  },
  to: (s: BState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<BState> => {
    const live = s as Live;
    const prev = live.data.notes[e.payload.workKey]!;
    const key = `${e.payload.workKey.replace(/~\d+$/, '')}~${ctx.version + 1}`;
    const notes = { ...live.data.notes, [e.payload.workKey]: { ...prev, status: 'retried' as const }, [key]: { ...prev, status: 'pending' as const } };
    return step(live.name as Name, { ...live.data, notes }, { work: [{ kind: prev.kind, key, input: prev.input, continues: e.payload.workKey }] });
  },
};

// ── The machine ─────────────────────────────────────────────────────────

const fromMachine = (...names: string[]) => (e: Event<any>): Check =>
  ((e.source.kind === 'message' && names.includes(e.source.from.machine)) || e.source.kind === 'system' ? ok() : reject('internal_only'));
const anyProducer = (e: Event<any>): Check =>
  (e.source.kind === 'message' || e.source.kind === 'system' || e.source.kind === 'service' ? ok() : reject('not_a_producer'));
const timer = (e: Event<any>): Check => (e.source.kind === 'timer' ? ok() : reject('timer_only'));
// Web's is the admin console's, admitted as an admin's.
const admin = (e: Event<any>): Check => (e.source.kind === 'admin' || (e.source.kind === 'system' && e.producer === 'platform')
  ? ok() : reject('not_a_producer'));

export function botChange(): Machine<BState, Facts> {
  const works = { WorkSucceeded: workResult('done'), WorkFailed: workResult('failed'), WorkExhausted: workResult('exhausted') };
  const looks = {
    Proposed: { to: look }, Verdict: { to: look }, ShotsSettled: { to: look }, FixRoundEnded: { to: look }, FixRefused: { to: look }, Look: { to: look },
    PreviewStopped: { to: stopped },
    Merged: { to: merged },
    Live: { to: wentLive },
    Closed: { to: closed as any },
    Voted: { to: voted },
    RetryFollowup: retryFollowup,
    ...works,
  };
  const ended = {
    Proposed: { ignore: 'ended' }, Verdict: { ignore: 'ended' }, ShotsSettled: { ignore: 'ended' }, FixRoundEnded: { ignore: 'ended' }, FixRefused: { ignore: 'ended' },
    Look: { ignore: 'ended' }, PreviewStopped: { ignore: 'ended' }, Merged: { ignore: 'ended' }, Live: { ignore: 'ended' },
    Closed: { ignore: 'ended' }, Voted: { ignore: 'ended' }, RetryFollowup: retryFollowup, ...works,
  };
  // Once merged only its Merged (when a look saw the merge first) and its
  // Live move it on.
  const mergedState = {
    ...looks,
    Proposed: { ignore: 'merged' }, Verdict: { ignore: 'merged' }, ShotsSettled: { ignore: 'merged' },
    FixRoundEnded: { ignore: 'merged' }, FixRefused: { ignore: 'merged' }, Look: { ignore: 'merged' }, PreviewStopped: { ignore: 'merged' },
  };
  // Closed: put up for a vote again (reopened), it is followed again.
  const closedState = { ...ended, Proposed: { to: look } };
  // Whatever creates it must be about a change of the bot's that a run of
  // its proposed, up for a vote or past it.
  const creating = (to: (s: BState, e: Event<any>, f: Facts, ctx: TransitionContext) => Outcome<BState>) => ({
    guard: (_s: BState, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      if (ctx.key !== sessionKey(e.payload.sessionId)) return reject('key_mismatch');
      if (!f.row || !f.runId) return reject('not_a_bot_change');
      return UP.has(f.row.status) ? ok() : reject('not_up_for_vote');
    },
    to,
  });
  return defineMachine<BState, Facts>({
    name: MACHINE,
    // 2: a vote on the change (Voted, bot.tellApproved): an older Pod would
    // refuse its event and leave its work's result unread.
    version: 2,
    events: EVENTS,
    create: CREATE,
    // What web appends: a vote on the change, and the admin console's Retry follow-up.
    web: ['Voted', 'RetryFollowup'],
    terminal: [...FINAL],
    decode: (row) => ({ name: row.state, data: row.data } as BState),
    facts: (tx: Tx, state: BState, event: Event<any>) => {
      const id = state.name === NONE ? Number((event.payload as any)?.sessionId) : (state.data as Data).sessionId;
      if (!Number.isInteger(id) || id <= 0) return Promise.resolve(NO_FACTS);
      return readFacts(tx, id);
    },
    authorize: {
      Proposed: fromMachine('proposal'),
      Verdict: fromMachine('preview'),
      ShotsSettled: fromMachine('shots'),
      PreviewStopped: fromMachine('preview'),
      // The request's instance (bot-request), answering the round it was
      // asked for.
      FixRoundEnded: anyProducer,
      FixRefused: anyProducer,
      Merged: fromMachine('merge-followups'),
      Live: fromMachine('merge-followups'),
      Closed: fromMachine('proposal'),
      Look: timer,
      Voted: (e: Event<any>): Check => (e.source.kind === 'route' || e.source.kind === 'system' ? ok() : reject('not_a_producer')),
      RetryFollowup: admin,
    },
    transitions: {
      [NONE]: {
        Proposed: creating(look), Verdict: creating(look), ShotsSettled: creating(look), FixRoundEnded: creating(look),
        PreviewStopped: creating(stopped), Merged: creating(merged), Live: creating(wentLive),
      },
      checking: looks,
      waiting_on_shots: looks,
      with_the_bot: looks,
      ready: looks,
      stopped: looks,
      merged: mergedState,
      live: ended,
      closed: closedState,
    } as any,
  });
}
