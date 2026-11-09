// merge-queue: an app's line of proposals in review, and the one place that
// decides which of them is merged or brought up to date next. One instance
// per app (`app:<id>`), created by the first ask.
//
//   idle ⇄ working (an attempt and/or a resolution under way)
//
// Everything that may make a proposal mergeable asks it (MergeWanted): a
// vote, a verdict that passed (the preview machine), a merge that landed or
// main turning green (merge-followups), the review check finding a window
// elapsed (the proposal machine), an admin's force, main resumed or moved.
// It asks the proposal machine, which decides under the proposal's lock:
//
//   - the direct lane: every approved (or forced) candidate that merges
//     cleanly with main, cheapest first, one at a time (MergeRequested →
//     AttemptEnded). Being behind main is no reason to wait;
//   - the conflict lane: at most one resolution at a time (a sync with main
//     by the agent: SyncRequested → ResolutionEnded), admitted by rule C,
//     and only while no direct attempt or checks run is under way (a
//     resolution made against a main about to move is made twice).
//
// A pass tries each candidate once; an ask that arrives during a pass makes
// one more pass after it (`owed`). Nothing here is in process memory: what
// is under way, what this pass tried and what is owed are the instance's.
// workflow-foundation's design-merge.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, DomainWrite, Event, Json, Machine, MessageRequest, Outcome, TransitionContext, Tx } from '../kernel/index.ts';
import { NO_FACTS, readFacts } from './facts.ts';
import type { Candidate, Facts } from './facts.ts';
import { forceWaivesChecks } from '../rules/merge-claim.ts';
import { createPrProposedNotifications } from '../rules/proposal-notifications.ts';

export const MACHINE = 'merge-queue';
export const appKey = (appId: number) => `app:${appId}`;
const sessionKey = (sessionId: number) => `session:${sessionId}`;

// A proposal the queue waits on longer than this is looked at again: one
// that is no longer being measured, merged or synced for it frees its slot.
export const CHECK_MS = 30 * 60 * 1000;
// While nothing is under way and the line is not empty, the queue looks at
// it again this often, as the old eligible-merge sweep did: what nobody asks
// about (a vote window that elapsed, a conflict before its vote, a decline
// for a turn that has since ended, a back-off over) is picked up.
export const SWEEP_MS = 4 * 60 * 1000;

// ── State ───────────────────────────────────────────────────────────────

interface Slot { n: number; sessionId: number }
export interface Data {
  appId: number;
  n: number;
  attempt: Slot | null;
  resolution: Slot | null;
  // What this pass has tried: `<session>@<head>@<epoch>` (a head or an epoch
  // that moved is a new candidate).
  tried: string[];
  owed: boolean;
  // Proposals an ask named since the pass began: tried again despite a
  // refusal GitHub gave their head (their votes or something else changed).
  named: number[];
}
export type QState = { name: 'idle' | 'working'; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<QState, { data: Data }>;

// ── Events ──────────────────────────────────────────────────────────────

const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optInt = (v: unknown, what: string) => (v == null ? null : int(v, what));
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

const EVENTS = {
  MergeWanted: (p: any) => ({ appId: int(p?.appId, 'appId'), sessionId: optInt(p?.sessionId, 'sessionId'),
    reason: text(p?.reason, 64) || 'unknown', force: !!p?.force }),
  AttemptEnded: (p: any) => ({ appId: int(p?.appId, 'appId'), sessionId: int(p?.sessionId, 'sessionId'), n: int(p?.n, 'n'),
    outcome: text(p?.outcome, 64) || 'ended', reason: text(p?.reason, 64), kind: text(p?.kind, 64), votesKept: !!p?.votesKept }),
  ResolutionEnded: (p: any) => ({ appId: int(p?.appId, 'appId'), sessionId: int(p?.sessionId, 'sessionId'), n: int(p?.n, 'n'),
    outcome: text(p?.outcome, 64) || 'ended', reason: text(p?.reason, 64) }),
  Check: () => ({}),
  Sweep: () => ({}),
};

// ── The line's rules ────────────────────────────────────────────────────

const triedKey = (c: Candidate) => `${c.id}@${c.head}@${c.epoch}`;

// What a candidate still costs, most decisive first: a measured conflict (a
// resolution, then a new head checked from scratch), then a head whose
// verdict is not settled yet. Ties: the group's stronger preference, then
// the longer wait.
function compare(a: Candidate, b: Candidate): number {
  const conflict = (c: Candidate) => (c.mergesClean === true ? 0 : c.mergesClean == null ? 1 : 2);
  return (Number(b.forced) - Number(a.forced))
    || (conflict(a) - conflict(b))
    || (Number(!a.settled) - Number(!b.settled))
    || (a.mergesClean === false ? a.conflictPaths - b.conflictPaths : 0)
    || (b.yes - a.yes)
    || (a.waitedSince - b.waitedSince);
}

// Rule C: does the conflict lane spend a resolution on this conflicting
// head now, and if not, what does the card say?
export function admission(c: Candidate, now: number): { admit: boolean; reason: string } {
  if (c.forkHead) return { admit: false, reason: 'fork_head' };
  const g = c.gaveUp;
  if (g && g.head === c.head && (g.main == null || c.integrationMain == null || g.main === c.integrationMain)) {
    return { admit: false, reason: 'unresolvable' };
  }
  if (c.backoffUntil > now) return { admit: false, reason: 'sync_backoff' };
  // #6531: a conflict in a mechanical file (the timing baseline, the schema
  // manifest) is settled by Homeroom itself, whatever the resolution state,
  // and spends nothing.
  if (!c.githubConflict && c.conflictFiles.length && c.conflictFiles.every((p) => MECHANICAL_PATHS.has(p))) {
    return { admit: true, reason: 'mechanical' };
  }
  // A stale verdict (checks that failed or could not run) was measured
  // against an older main, and a conflicting head gets no fresh automatic
  // run (services/check-admission.js): the lane resolves it anyway and the
  // new head gets its own full checks run. So it no longer refuses here;
  // it is written as the author's lane reason only once the free resolution
  // has been spent (below).
  const stale = c.unmergeable === 'checks_failing' || c.unmergeable === 'checks_error';
  if ((c.approved || c.forced) && !c.unmergeable) return { admit: true, reason: 'approved' };
  // A stale verdict does not block the free resolution before the vote.
  if (!c.resolutionSpent) return { admit: true, reason: 'first_conflict' };
  // The group said yes and the free resolution is spent: the lane still
  // resolves the conflict, and the new head gets its own full checks run.
  if (c.approved && stale) return { admit: true, reason: 'approved' };
  if (stale) return { admit: false, reason: c.unmergeable! };
  return { admit: false, reason: c.approved ? (c.unmergeable || 'lock') : 'awaiting_approval' };
}
// The paths whose conflict the platform settles mechanically (worker/run-cc.sh
// takes main's timing file, and scripts/record-schema-migration.js rebuilds
// the manifest): a conflict only in these never costs the group a yes.
export const MECHANICAL_PATHS: ReadonlySet<string> = new Set([
  'tests/baselines/test-durations.json',
  'src/db/migrations/manifest.json',
]);
// The block reasons the conflict lane owns on a row (the card's "who acts").
// 'checks_failing' and 'checks_error': written now only after the free
// pre-vote resolution has been spent, when the checks still fail on a head
// nobody else will move (the bot fixes its own; a person's change is theirs).
const LANE_REASONS: ReadonlySet<string> = new Set(['awaiting_approval', 'unresolvable', 'fork_head', 'checks_failing', 'checks_error']);

const free = (c: Candidate) => c.state === 'in_review' && !c.busy;
// A force skips the votes and the lock wherever it stands, the checks only on
// the commit it was given on (or one a mechanical merge of main moved it to).
const waived = (c: Candidate) => forceWaivesChecks(c.forced, c.forcedHead, c.head);
const blocked = (c: Candidate) => !!c.unmergeable && !(c.forced && (c.unmergeable === 'lock' || waived(c)));
// The proposal states that can hold a slot of the queue's.
const HOLDING: ReadonlySet<string> = new Set(['in_review', 'merging', 'underway']);

// ── Moves ───────────────────────────────────────────────────────────────

const step = (next: Live, more: Omit<Outcome<QState>, 'next'> = {}): Outcome<QState> => ({ next, ...more });
const toProposal = (d: Data, sessionId: number, type: string, payload: Record<string, Json>): MessageRequest =>
  ({ to: { machine: 'proposal', key: sessionKey(sessionId) }, event: { type, payload: { sessionId, ...payload } }, appId: d.appId });

// The next thing the line can do, from what this pass has not tried yet.
function pick(d: Data, f: Facts, ctx: TransitionContext): Outcome<QState> {
  const line = f.line;
  let data = { ...d };
  const messages: MessageRequest[] = [];
  const writes: DomainWrite[] = [];
  const tried = new Set(data.tried);
  const named = new Set(data.named);
  // GitHub refused this very head against this main: not asked again until
  // something changes (its head, main, an ask that names it, or — for a
  // refusal that may simply be met again, like GitHub still finishing an
  // earlier merge — its retry time).
  const refusedHere = (c: Candidate) => !!c.refused && c.refused.head === c.head
    && (c.refused.main == null || c.integrationMain == null || c.refused.main === c.integrationMain) && !named.has(c.id)
    && !(c.refused.retryAt && Date.parse(c.refused.retryAt) <= ctx.now.getTime());

  // Direct lane.
  const direct = line
    .filter((c) => (c.approved || c.forced) && c.mergesClean !== false && !blocked(c))
    .sort(compare);
  let directWaiting = 0;
  if (data.attempt) directWaiting++;
  if (!data.attempt) {
    for (const c of direct) {
      if (!free(c)) { if (c.busy) directWaiting++; continue; }
      if (tried.has(triedKey(c)) || refusedHere(c)) continue;
      // Its run reports on its own (the verdict asks again).
      if (!waived(c) && c.runInFlight) { directWaiting++; continue; }
      const n = data.n + 1;
      data = { ...data, n, attempt: { n, sessionId: c.id }, tried: [...data.tried, triedKey(c)] };
      messages.push(toProposal(data, c.id, 'MergeRequested', { queueN: n, force: c.forced }));
      directWaiting++;
      break;
    }
  } else {
    directWaiting += direct.filter((c) => free(c) && !waived(c) && c.runInFlight).length;
  }

  // The conflict lane: every conflicting head's admission is said on its
  // row; one resolution at a time, only while nothing direct is under way.
  const conflicts = line.filter((c) => c.mergesClean === false);
  const admitted: { c: Candidate; reason: string }[] = [];
  for (const c of line) {
    const verdict = c.mergesClean === false ? admission(c, ctx.now.getTime()) : null;
    const want = verdict && !verdict.admit && LANE_REASONS.has(verdict.reason) ? verdict.reason : null;
    const kept = c.laneReasons.filter((r) => !LANE_REASONS.has(r));
    const next = want ? [...kept, want] : kept;
    if (next.length !== c.laneReasons.length || next.some((r, i) => r !== c.laneReasons[i])) {
      writes.push({ type: 'laneReasons', sessionId: c.id, reasons: next });
    }
    if (verdict?.admit) admitted.push({ c, reason: verdict.reason });
  }
  if (!data.resolution && directWaiting === 0 && admitted.length) {
    const rank = (r: string) => (r === 'mechanical' ? 2 : r === 'approved' ? 1 : 0);
    admitted.sort((a, b) => (rank(b.reason) - rank(a.reason)) || compare(a.c, b.c));
    const next = admitted.find((x) => free(x.c) && !tried.has(`sync:${triedKey(x.c)}`));
    if (next) {
      const n = data.n + 1;
      data = { ...data, n, resolution: { n, sessionId: next.c.id }, tried: [...data.tried, `sync:${triedKey(next.c)}`] };
      messages.push(toProposal(data, next.c.id, 'SyncRequested', {
        reason: 'conflict', queueN: n, approved: next.reason === 'approved', githubConflict: next.c.githubConflict,
        mechanical: next.reason === 'mechanical',
      }));
    }
  }
  void conflicts;

  const working = !!data.attempt || !!data.resolution;
  if (!working) {
    // The pass is over: one more if an ask came during it.
    if (data.owed) return pick({ ...data, owed: false, tried: [], named: [] }, f, ctx);
    data = { ...data, tried: [], named: [] };
  }
  const next: Live = { name: working ? 'working' : 'idle', data };
  // The guard against an answer that never came is set when a slot is
  // given, not pushed back by every ask after it; idle, the sweep.
  const assigned = data.attempt !== d.attempt || data.resolution !== d.resolution;
  const timer = working
    ? (assigned ? { at: new Date(ctx.now.getTime() + CHECK_MS), event: { type: 'Check' } } : undefined)
    : line.length ? { at: new Date(ctx.now.getTime() + SWEEP_MS), event: { type: 'Sweep' } } : null;
  return step(next, { messages, writes, timer });
}

function wanted(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<QState> {
  const sid = e.payload.sessionId;
  const named = sid && !s.data.named.includes(sid) ? [...s.data.named, sid] : s.data.named;
  if (s.name === 'working') {
    // A pass is under way: one more after it, and whatever it has not tried
    // yet may still be picked now, the proposal the ask names among them:
    // what this pass declined it for (busy, its checks) may be over, and a
    // pass that is waiting on a resolution can run for minutes.
    const tried = sid ? s.data.tried.filter((k) => !k.startsWith(`${sid}@`)) : s.data.tried;
    return pick({ ...s.data, tried, owed: true, named }, f, ctx);
  }
  return pick({ ...s.data, tried: [], owed: false, named }, f, ctx);
}

function attemptEnded(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<QState> {
  const d = { ...s.data, attempt: null };
  // A head the platform's own sync moved keeps its votes: it is a new
  // candidate (a new head), tried in this same pass.
  return pick(d, f, ctx);
}

function resolutionEnded(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<QState> {
  return pick({ ...s.data, resolution: null }, f, ctx);
}

// The guard against an answer that never came: a slot whose proposal is no
// longer measured, merged or synced for it is freed.
function checked(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<QState> {
  let d = { ...s.data };
  // A proposal holds an attempt slot while its gate or GitHub's merge for
  // that ask is under way, a resolution slot while that sync is.
  const a = d.attempt ? f.waiting.get(d.attempt.sessionId) : null;
  const holdsAttempt = !!a && HOLDING.has(a.state) && !!a.data?.attempt && a.data.attempt.queueN === d.attempt?.n
    && (a.data.attempt.stage === 'gate' || a.data.attempt.stage === 'merge');
  if (d.attempt && !holdsAttempt) d = { ...d, attempt: null };
  const r = d.resolution ? f.waiting.get(d.resolution.sessionId) : null;
  const holdsSync = !!r && HOLDING.has(r.state) && !!r.data?.sync && r.data.sync.queueN === d.resolution?.n;
  if (d.resolution && !holdsSync) d = { ...d, resolution: null };
  if (d.attempt || d.resolution) {
    return step({ name: 'working', data: d }, { timer: { at: new Date(ctx.now.getTime() + CHECK_MS), event: { type: 'Check' } } });
  }
  // Freed: a pass runs again at once (this event read no line).
  return step({ name: 'idle', data: { ...d, tried: [], named: [], owed: false } }, {
    timer: null,
    messages: [{ to: { machine: MACHINE, key: appKey(d.appId) }, event: { type: 'MergeWanted', payload: { appId: d.appId, reason: 'freed' } }, appId: d.appId }],
  });
}

// ── The machine ─────────────────────────────────────────────────────────

const fromProposal = (e: Event<any>): Check =>
  ((e.source.kind === 'message' && e.source.from.machine === 'proposal') || e.source.kind === 'system' ? ok() : reject('internal_only'));
const anyone = (e: Event<any>): Check => (['route', 'system', 'message', 'admin'].includes(e.source.kind) ? ok() : reject('not_a_producer'));
const timer = (e: Event<any>): Check => (e.source.kind === 'timer' ? ok() : reject('timer_only'));

const own = (n: (d: Data) => Slot | null) => (s: Live, e: Event<any>): Check => {
  const slot = n(s.data);
  return slot && slot.n === e.payload.n && slot.sessionId === e.payload.sessionId ? ok() : reject('stale_answer');
};

export function mergeQueue(): Machine<QState, Facts> {
  const live = (to: (s: Live, e: Event<any>, f: Facts, ctx: TransitionContext) => Outcome<QState>) =>
    (s: QState, e: Event<any>, f: Facts, ctx: TransitionContext) => to(s as Live, e, f, ctx);
  const create = {
    MergeWanted: {
      guard: (_s: QState, e: Event<any>, f: Facts, ctx: TransitionContext): Check => (ctx.key === appKey(e.payload.appId) ? ok() : reject('key_mismatch')),
      to: (_s: QState, e: Event<any>, f: Facts, ctx: TransitionContext) =>
        wanted({ name: 'idle', data: { appId: e.payload.appId, n: 0, attempt: null, resolution: null, tried: [], owed: false, named: [] } }, e, f, ctx),
    },
  };
  const table = (name: 'idle' | 'working') => ({
    MergeWanted: { to: live(wanted) },
    AttemptEnded: { guard: (s: QState, e: Event<any>) => own((d) => d.attempt)(s as Live, e), to: live(attemptEnded) },
    ResolutionEnded: { guard: (s: QState, e: Event<any>) => own((d) => d.resolution)(s as Live, e), to: live(resolutionEnded) },
    Check: name === 'working' ? { to: live(checked) } : { ignore: 'idle' },
    Sweep: name === 'idle' ? { to: live((s, e, f, ctx) => pick({ ...s.data, tried: [], owed: false, named: [] }, f, ctx)) } : { ignore: 'working' },
  });
  return defineMachine<QState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['MergeWanted'],
    // What web appends: a vote or a demo that leaves a change ready to merge, and
    // Check for updates.
    web: ['MergeWanted'],
    terminal: [],
    decode: (row) => ({ name: row.state, data: row.data } as QState),
    facts: (tx: Tx, state: QState, event: Event<any>, ctx: TransitionContext) => {
      const appId = state.name === NONE ? Number((event.payload as any)?.appId) : (state.data as Data).appId;
      if (!Number.isInteger(appId) || appId <= 0) return Promise.resolve(NO_FACTS);
      const d = state.name === NONE ? null : (state.data as Data);
      const waitingOn = d ? [d.attempt?.sessionId, d.resolution?.sessionId].filter((x): x is number => !!x) : [];
      return readFacts(tx, appId, event.type, waitingOn, ctx.now);
    },
    authorize: { MergeWanted: anyone, AttemptEnded: fromProposal, ResolutionEnded: fromProposal, Check: timer, Sweep: timer },
    transitions: { [NONE]: create, idle: table('idle'), working: table('working') } as any,
    writes: {
      // The card's "who acts" on a conflicting head (services/merge-requirements.js
      // integrationStep reads it): a description, decided by nothing. A head
      // that has just become vote-ready gets its "new change to vote on"
      // notice here (#6531): the queue is what learns it first.
      laneReasons: async (tx: Tx, w: any) => {
        const { rows: [before] } = await tx.query(
          'SELECT integration_block_reasons, user_id, app_id FROM chat_sessions WHERE id = $1', [w.sessionId]);
        await tx.query(
          `UPDATE chat_sessions SET integration_block_reasons = $2::jsonb
            WHERE id = $1 AND status = 'promoted' AND integration_block_reasons IS DISTINCT FROM $2::jsonb`,
          [w.sessionId, JSON.stringify(w.reasons || [])]);
        const was = Array.isArray(before?.integration_block_reasons) ? before.integration_block_reasons.map(String) : [];
        const now = (w.reasons || []).map(String);
        if (now.includes('awaiting_approval') && !was.includes('awaiting_approval') && before) {
          await createPrProposedNotifications(tx, { appId: Number(before.app_id), sessionId: w.sessionId, proposerId: before.user_id ?? null });
        }
      },
    },
    reply: async (tx, event, after) => (after.name === NONE ? null : { state: after.name }),
  });
}
