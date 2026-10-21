// shots: a proposal's before & after shots. One instance per proposal
// (`session:<id>`), because what is decided is about the proposal's one
// slot: one run at a time, a new head or a new declaration supersedes the
// run under way, a Stop or a waiver applies to whatever is current, and an
// automatic retry is counted per head. A run is a row of shot_runs, written
// by these transitions.
//
// A run: the exact before revision is resolved (shots.revision), the two
// copies are built and seeded and the agent's workspace written
// (shots.copies), the shots agent takes the shots once the proposal's agent
// is free (shots.agent, the turn as a durable step), the two sides are
// compared (shots.publish) and the ready changes published in the
// transition that says so. Whatever way a run ends, its copies go
// (shots.cleanup), and whoever waits on the slot hears it settled (the
// Homeroom bot, the pull request's description).
//
// The declaration (what the proposal says people will see change) is this
// machine's too: every place that declared or moved a head appends here.
// The preview machine says when a head is ready to be shot (HeadReady),
// when an imported proposal's preview will not start (PreviewStopped), when
// a UI change has no declaration (UiUndeclared), and when the proposal has
// left review (Closed).
//
// workflow-foundation's design-shots.md is the design.

import { NONE, canonicalHash, defineMachine, ok, reject } from '../kernel/index.ts';
import type {
  Check, DomainWrite, Event, Json, Machine, Outcome, Push, TimerRequest, TransitionContext, Tx, WorkRef, WorkRequest,
  WorkResultPayload,
} from '../kernel/index.ts';
import { toUser, voteUpdate } from '../pushes.ts';
import { toBotChange, writeBotChange } from '../rules/bot-notes.ts';
import { missingIntentDetail, pendingDetail, requiredForIntent, runSummary } from '../rules/shots-detail.ts';
import { SHOTS_LIVE_STATES } from '../session-work.ts';
import { OPEN, readFacts } from './facts.ts';
import type { Facts, Session } from './facts.ts';

export const MACHINE = 'shots';
export const sessionKey = (sessionId: number) => `session:${sessionId}`;

export const WORK = Object.freeze({
  revision: 'shots.revision',
  copies: 'shots.copies',
  agent: 'shots.agent',
  publish: 'shots.publish',
  cleanup: 'shots.cleanup',
  prBlock: 'github.prShotsBlock',
});

// ── State ───────────────────────────────────────────────────────────────

export interface Run {
  id: string;
  n: number;
  head: string;
  base: string | null;
  trigger: string;
  startedAt: string;
  busy: number;                    // dispatches another turn took the agent from
  died: number;                    // dispatches whose process died under them
  dispatches: number;
  copiesAt: string | null;         // its copies serve: the agent may be waited for from here
  agentStartedAt: string | null;   // the agent's clock: its first dispatch
  agentWaitUntil: string | null;   // waiting for the agent, until
  platformRetry: boolean;          // this run is a platform fault's one retry
  afterOnly: boolean;
  // What publishing it will publish: the agent's verdict, its manifest and
  // the ready files' slots (the comparison only adds outlines).
  publish?: { verdict: Json; manifestHash: string; slots: string[] } | null;
}
// A run that ended, until everything it left is gone. `awaitCopies`: its
// copies were being built when it ended; the step is left to finish (it
// stops at its next phase once it sees the run ended), and the cleanup
// starts once it reports, so nothing it makes after the cleanup is left.
export interface Cleaning { runId: string; n: number; worker: boolean; stopTurn: boolean; awaitCopies?: boolean }
export interface Declared { intent: Json | null; required: boolean }
export interface Data {
  sessionId: number;
  appId: number;
  appSlug: string;
  declared: Declared | null;       // null: nothing declared; intent null: a UI change with no declaration
  head: string | null;             // the head the slot is about
  run: Run | null;                 // the run under way
  // The last run that ended on this head, for its one automatic retry.
  // `row`: it got as far as its row (a run whose revision never resolved
  // has none, so there is nothing on the slot to waive).
  last: { id: string; head: string; fault: string | null; retryAt: string | null; retried: boolean; row: boolean } | null;
  // Why the slot last said no run started, so the same refusal again is
  // not told again.
  notStarted?: string | null;
  n: number;
  cleaning: Cleaning[];
  declaredBy?: number;             // the event whose declaration stands
}

const STATES = [
  'undeclared', 'not_needed', 'waiting_for_preview', 'building_copies', 'waiting_for_agent', 'taking_shots',
  'publishing', 'published', 'failed', 'waived', 'closed',
] as const;
type Name = typeof STATES[number];
export type SState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<SState, { data: Data }>;

// A run under way: these states hold the proposal's worker and its copies
// (src/workflow/session-work.ts, which the other machines read).
export const LIVE: ReadonlySet<string> = new Set(SHOTS_LIVE_STATES);

// ── Events ──────────────────────────────────────────────────────────────

const SHA = /^[0-9a-f]{40}$/;
const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optSha = (v: unknown, what: string) => {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (!SHA.test(s)) throw new Error(`${what} must be a 40-character commit sha`);
  return s;
};
const reqSha = (v: unknown, what: string) => {
  const s = optSha(v, what);
  if (!s) throw new Error(`${what} is required`);
  return s;
};
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
// A declaration is validated where it is made (services/visible-changes.js
// parseIntent): here it is only an object with its stories.
const intentOf = (v: unknown) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray((v as any).stories)) {
    throw new Error('intent must be a parsed declaration of visible changes');
  }
  return v as Json;
};

const session = (p: any) => ({ sessionId: int(p?.sessionId, 'sessionId') });
// The proposal's revision column the head event's caller moved or read, and
// the head the caller read there (see staleHead).
const PINS: ReadonlySet<string> = new Set(['imported', 'reviewed', 'handoff']);
const fence = (p: any) => {
  if (p?.pin != null && !PINS.has(p.pin)) throw new Error('pin must be imported, reviewed or handoff');
  return { pin: p?.pin ?? null, from: optSha(p?.from, 'from') };
};
const clock = (p: any) => ({ runId: text(p?.runId, 64), phase: text(p?.phase, 64) });
const EVENTS = {
  // A declaration of visible changes (the hosted worker's tool, submit_work,
  // a hand-off, PR import, the bot's own proposal), for `head` or the row's.
  Declared: (p: any) => ({ ...session(p), head: optSha(p?.head, 'head'), intent: intentOf(p?.intent), ...fence(p) }),
  // The proposal's head moved: shots of another head no longer stand.
  HeadMoved: (p: any) => ({ ...session(p), head: reqSha(p?.head, 'head'), reason: text(p?.reason, 1000), ...fence(p) }),
  // From the preview machine.
  HeadReady: (p: any) => ({ ...session(p), head: reqSha(p?.head, 'head') }),
  PreviewStopped: (p: any) => ({ ...session(p), head: optSha(p?.head, 'head') }),
  UiUndeclared: (p: any) => ({ ...session(p), head: optSha(p?.head, 'head') }),
  Closed: (p: any) => ({ ...session(p), reason: text(p?.reason, 64) || 'closed' }),
  // People (the proposal's owner or an app manager; an admin waives).
  RetryRequested: (p: any) => ({ ...session(p), intent: p?.intent == null ? null : intentOf(p.intent), reason: text(p?.reason, 32) }),
  StopRequested: (p: any) => ({ ...session(p) }),
  WaiveRequested: (p: any) => ({ ...session(p), userId: int(p?.userId, 'userId'), reason: text(p?.reason, 1000) || (() => { throw new Error('reason is required'); })() }),
  // The machine's own clock: the agent free yet, a step past its deadline,
  // a platform fault's one retry. Each names the run and the step it was
  // set for: one that fired as a transition replaced it is ignored.
  Recheck: clock,
  Overdue: clock,
  RetryDue: clock,
};

// ── Configuration ───────────────────────────────────────────────────────

export interface Deps {
  execute: boolean;          // config.shots.execute: this deployment takes shots
  agentBudgetMs: number;     // config.shots.maxAgentMs
  runBudgetMs: number;       // config.shots.maxRunMs
}

// How long a step may take before it is overdue: the copies (a platform
// fault), the agent's turn past its own clock (its process is stuck), the
// comparison (published without outlines).
export const COPIES_DEADLINE_MS = 45 * 60 * 1000;
export const AGENT_OVERDUE_MS = 15 * 60 * 1000;
export const PUBLISH_DEADLINE_MS = 15 * 60 * 1000;
// How often the machine looks again whether the proposal's agent is free.
export const AGENT_RECHECK_MS = 20 * 1000;
// A dispatch is started again (after its process died, or the agent was
// busy) only with at least this much of the agent's clock left.
export const MIN_AGENT_RETRY_MS = 60 * 1000;
export const MAX_AGENT_BUSY_RETRIES = 2;
// A platform fault's one retry waits this long (GitHub's hourly limit says
// when it resets).
export const PLATFORM_RETRY_MS = 60 * 1000;
// The platform's own faults, by kind: the copies' database, a clone, the
// worker's bootstrap, GitHub's limit, the agent's process, copies that never
// finished, a run a release cut off, the revision step itself never ending.
// Anything else is the proposal's to fix.
const PLATFORM_FAULTS: ReadonlySet<string> = new Set([
  'database', 'clone', 'worker_bootstrap', 'github_rate_limited', 'agent_exit', 'copies_timeout', 'release', 'revision',
]);

// What each refusal to start says on the proposal (#2601/#2558).
export const NOT_STARTED: ReadonlyMap<string, string> = new Map([
  ['disabled', 'Before & after shots are not being taken on this deployment, so nothing picked this one up.'],
  ['missing_intent', 'This proposal has no declared change recorded, so there was nothing to shoot.'],
  ['no_revision', 'The proposal revision to preview could not be resolved, so the run never started.'],
  ['no_staging_preview', 'No staging preview was built for this commit, so there was nothing to take before & after shots of.'],
]);

export const STOPPED_REASON = 'Stopped before it finished. No shots were taken for this commit; take them again from the proposal.';
export const AGENT_BUSY_REASON = 'The proposal’s agent stayed busy past the time the before/after shots had to start.';
const SUPERSEDED_REASON = 'A newer revision of this proposal replaced these shots.';
const CLOSED_REASON = 'The proposal left review before its shots were taken.';

// ── Helpers ─────────────────────────────────────────────────────────────

const later = (ctx: TransitionContext, ms: number) => new Date(ctx.now.getTime() + ms);
const runId = (ctx: TransitionContext, e: Event<any>) => canonicalHash({ key: ctx.key, event: e.id }).slice(0, 32);
const step = (next: SState, more: Omit<Outcome<SState>, 'next'> = {}): Outcome<SState> => ({ next, ...more });
const live = (s: { name: string }) => LIVE.has(s.name);

function fresh(sessionId: number, f: Facts): Data {
  return {
    sessionId, appId: f.session?.appId ?? 0, appSlug: f.session?.appSlug ?? '',
    declared: null, head: f.session?.head ?? null, run: null, last: null, n: 0, cleaning: [],
  };
}

// What the slot shows for a state with no run under way: a declaration's
// pending detail, or the missing one's.
function slotDetail(d: Data, reason: string | null = null): { state: string; detail: Json } {
  if (d.declared && d.declared.intent) {
    const detail = pendingDetail(d.declared.intent as any, { headSha: d.head, reason });
    return { state: detail.required ? 'planned' : 'not_required', detail: detail as Json };
  }
  return { state: 'planned', detail: missingIntentDetail({ headSha: d.head, reason }) as Json };
}

// Everything a run under way has outstanding.
function runWork(r: Run): WorkRef[] {
  return [
    { kind: WORK.revision, key: `revision:${r.n}` },
    { kind: WORK.copies, key: `copies:${r.n}` },
    ...Array.from({ length: Math.max(1, r.dispatches) }, (_, i) => ({ kind: WORK.agent, key: `agent:${r.n}:${i + 1}` })),
    { kind: WORK.publish, key: `publish:${r.n}` },
  ];
}

function cleanupWork(d: Data, c: Cleaning): WorkRequest {
  return { kind: WORK.cleanup, key: `cleanup:${c.runId}`,
    input: { runId: c.runId, sessionId: d.sessionId, appSlug: d.appSlug, worker: c.worker, stopTurn: c.stopTurn } };
}

// What whoever waits on the slot hears once it settled: the pull request's
// description (work), and the Homeroom bot's change machine, when it is a
// change of the bot's (ready to try, or back to the bot: a write that
// messages it, rules/bot-notes.ts).
function settledWork(d: Data, ctx: TransitionContext): WorkRequest[] {
  return [{ kind: WORK.prBlock, key: `pr-block:v${ctx.version + 1}`, input: { sessionId: d.sessionId } }];
}
const settledNote = (d: Data): DomainWrite => toBotChange(d.sessionId, 'ShotsSettled');

const told = (d: Data, state: string): Push => voteUpdate({
  sessionId: d.sessionId, appId: d.appId, appSlug: d.appSlug, merged: false, action: 'shots', shotsState: state,
});

// The machine's clock for the run under way: each timer names the run and
// the step it was set for (the copies, an agent's dispatch, the comparison),
// so one that fired as a transition replaced it is ignored.
const clockFor = (ctx: TransitionContext, ms: number, type: string, runIdOf: string, phase: string): TimerRequest =>
  ({ at: later(ctx, ms), event: { type, payload: { runId: runIdOf, phase } } });
const agentPhase = (r: Run) => `agent:${r.dispatches}`;

// The run under way ends, whatever way: what it still has outstanding is
// cancelled, its copies (and its turn, when the agent may be at it) go.
// `worker`: the proposal's worker was made for these shots and nothing
// needs it any more. Copies still being built are left to finish (they stop
// at their next phase: services/shots-orchestrator.js buildCopies), and
// their cleanup waits for them; `copiesSettled`: they already reported.
function endRun(s: Live, f: Facts, { worker = true, copiesSettled = false }: { worker?: boolean; copiesSettled?: boolean } = {}):
  { d: Data; cancel: WorkRef[]; work: WorkRequest[] } {
  const r = s.data.run!;
  const awaitCopies = s.name === 'building_copies' && !!r.base && !copiesSettled;
  const c: Cleaning = { runId: r.id, n: r.n, worker: worker && !!f.session?.temporaryWorker,
    stopTurn: s.name === 'taking_shots' || s.name === 'publishing', ...(awaitCopies ? { awaitCopies: true } : {}) };
  const d: Data = { ...s.data, run: null, cleaning: [...s.data.cleaning.filter((x) => x.runId !== r.id), c] };
  return {
    d,
    cancel: runWork(r).filter((w) => !(awaitCopies && w.kind === WORK.copies)),
    work: awaitCopies ? [] : [cleanupWork(d, c)],
  };
}

// The slot says why no run started (#2601/#2558), and whoever waits on it
// hears it settled; the same refusal again says nothing new.
function refuse(d: Data, why: string, reason: string, ctx: TransitionContext): { d: Data; writes: DomainWrite[]; work: WorkRequest[] } {
  if (d.notStarted === why) return { d, writes: [], work: [] };
  const next = { ...d, notStarted: why };
  return { d: next, writes: [{ type: 'notStarted', sessionId: d.sessionId, reason }, settledNote(next)], work: settledWork(next, ctx) };
}

// Start a run of the declaration on head `head`, or say on the slot why it
// will not start. `trigger`: why it starts.
function start(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps, trigger: string,
  extra: { writes?: DomainWrite[]; cancel?: WorkRef[]; work?: WorkRequest[]; data?: Data; platformRetry?: boolean } = {}): Outcome<SState> {
  const d0 = extra.data || s.data;
  const head = d0.head;
  const why = !deps.execute ? 'disabled' : !d0.declared?.intent ? 'missing_intent' : !head ? 'no_revision' : null;
  if (why) {
    const name: Name = d0.declared?.intent ? 'waiting_for_preview' : 'undeclared';
    const no = refuse(d0, why, NOT_STARTED.get(why)!, ctx);
    return step({ name, data: no.d }, {
      writes: [...(extra.writes || []), ...no.writes],
      cancel: extra.cancel, work: [...(extra.work || []), ...no.work], timer: null,
    });
  }
  if (!d0.declared!.required) {
    return step({ name: 'not_needed', data: d0 }, { writes: extra.writes, cancel: extra.cancel, work: extra.work, timer: null });
  }
  const n = d0.n + 1;
  const run: Run = {
    id: runId(ctx, e), n, head: head!, base: null, trigger, startedAt: ctx.now.toISOString(),
    busy: 0, died: 0, dispatches: 0, copiesAt: null, agentStartedAt: null, agentWaitUntil: null,
    platformRetry: !!extra.platformRetry, afterOnly: false,
  };
  const d: Data = { ...d0, n, run, notStarted: null };
  return step({ name: 'building_copies', data: d }, {
    writes: extra.writes,
    cancel: extra.cancel,
    work: [...(extra.work || []), { kind: WORK.revision, key: `revision:${n}`, input: { sessionId: d.sessionId, head: run.head } }],
    timer: clockFor(ctx, COPIES_DEADLINE_MS, 'Overdue', run.id, 'copies'),
  });
}

// A platform fault is taken again once, on the same head, while the
// proposal is open (unless this run was that retry).
function retryOf(r: Run, f: Facts, ctx: TransitionContext, fault: string | null, retryAt: string | null | undefined) {
  const retry = !!fault && !r.platformRetry && !!f.session && OPEN.has(f.session.status);
  return retry ? (retryAt || later(ctx, PLATFORM_RETRY_MS).toISOString()) : null;
}

// A run that never got its row (its revision never resolved): nothing was
// built and nothing is on the slot to fail or waive, so the slot says it
// never started, and a platform fault is taken again once.
function notStartedRun(s: Live, f: Facts, ctx: TransitionContext, failure: { reason: string; fault?: string | null; retryAt?: string | null }): Outcome<SState> {
  const r = s.data.run!;
  const { d, cancel, work } = endRun(s, f);
  const fault = failure.fault && PLATFORM_FAULTS.has(failure.fault) ? failure.fault : null;
  const retryAt = retryOf(r, f, ctx, fault, failure.retryAt);
  const no = refuse({ ...d, notStarted: null }, 'no_revision', failure.reason, ctx);
  const next: Data = { ...no.d, last: { id: r.id, head: r.head, fault, retryAt, retried: false, row: false } };
  return step({ name: 'waiting_for_preview', data: next }, {
    writes: no.writes, cancel, work: [...work, ...no.work],
    timer: retryAt ? { at: new Date(retryAt), event: { type: 'RetryDue', payload: { runId: r.id, phase: 'retry' } } } : null,
  });
}

// The run under way failed: the slot says why, its copies go, and a
// platform fault is taken again once (unless this run was that retry).
function fail(s: Live, f: Facts, ctx: TransitionContext, failure: {
  code: string; reason: string; fault?: string | null; retryAt?: string | null; verdict?: Json; trace?: Json;
  copiesSettled?: boolean;
}): Outcome<SState> {
  const r = s.data.run!;
  if (!r.base) return notStartedRun(s, f, ctx, failure);
  const { d, cancel, work } = endRun(s, f, { copiesSettled: failure.copiesSettled });
  const fault = failure.fault && PLATFORM_FAULTS.has(failure.fault) ? failure.fault : null;
  const retryAt = retryOf(r, f, ctx, fault, failure.retryAt);
  const next: Data = { ...d, last: { id: r.id, head: r.head, fault, retryAt, retried: false, row: true } };
  const trace = { ...((failure.trace as object) || {}), ...(fault ? { platformFault: { kind: fault, ...(retryAt ? { retryAt: Date.parse(retryAt) } : {}) } } : {}),
    ...(retryAt ? { automaticRetry: true } : {}), failure: { code: failure.code, message: failure.reason } } as Json;
  return step({ name: 'failed', data: next }, {
    writes: [{ type: 'runMoved', runId: r.id, state: 'failed',
      patch: { failureCode: failure.code, failureReason: failure.reason, traceSummary: trace,
        ...(failure.verdict ? { hardVerdict: failure.verdict } : {}) } }, settledNote(next)],
    cancel, work: [...work, ...settledWork(next, ctx)],
    timer: retryAt ? { at: new Date(retryAt), event: { type: 'RetryDue', payload: { runId: r.id, phase: 'retry' } } } : null,
  });
}

// The agent's turn on the run's copies, when the proposal's agent is free;
// otherwise wait for it, until what is left of the run's time from the
// moment its copies served.
function dispatchOrWait(s: Live, f: Facts, ctx: TransitionContext, deps: Deps, writes: DomainWrite[] = []): Outcome<SState> {
  const r = s.data.run!;
  if (f.session?.agentBusy) {
    const from = r.copiesAt || r.startedAt;
    const until = r.agentWaitUntil || new Date(Date.parse(from) + deps.runBudgetMs).toISOString();
    if (Date.parse(until) <= ctx.now.getTime()) {
      return fail(s, f, ctx, { code: 'shots_agent_busy', reason: AGENT_BUSY_REASON });
    }
    return step({ name: 'waiting_for_agent', data: { ...s.data, run: { ...r, agentWaitUntil: until } } }, {
      writes, timer: clockFor(ctx, AGENT_RECHECK_MS, 'Recheck', r.id, 'wait'),
    });
  }
  const agentStartedAt = r.agentStartedAt || ctx.now.toISOString();
  const left = deps.agentBudgetMs - (ctx.now.getTime() - Date.parse(agentStartedAt));
  const k = r.dispatches + 1;
  const run: Run = { ...r, dispatches: k, agentStartedAt, agentWaitUntil: null };
  const budgetMs = Math.max(MIN_AGENT_RETRY_MS, left);
  return step({ name: 'taking_shots', data: { ...s.data, run } }, {
    writes,
    work: [{ kind: WORK.agent, key: `agent:${r.n}:${k}`,
      input: { runId: r.id, sessionId: s.data.sessionId, budgetMs } }],
    timer: clockFor(ctx, budgetMs + AGENT_OVERDUE_MS, 'Overdue', r.id, agentPhase(run)),
  });
}

// The machine's view of a head: the event's, else the slot's, else the
// row's.
const headOf = (d: Data, f: Facts, head: string | null) => head || d.head || f.session?.head || null;

// The slot moves to another head: the run under way (on another head)
// ends, shots of other heads stop counting, and the declaration carries
// over to the new head.
function moveHead(s: Live, f: Facts, ctx: TransitionContext, head: string, reason: string | null): { s: Live; out: Outcome<SState> } {
  let d: Data = { ...s.data, head, last: null, notStarted: null };
  let cancel: WorkRef[] = [];
  let work: WorkRequest[] = [];
  if (live(s)) {
    ({ d, cancel, work } = endRun({ name: s.name, data: d } as Live, f, { worker: false }));
    d = { ...d, head };
  }
  const slot = slotDetail(d, reason || SUPERSEDED_REASON);
  const name: Name = !d.declared ? (s.name === 'closed' ? 'closed' : 'undeclared')
    : d.declared.intent && !d.declared.required ? 'not_needed' : d.declared.intent ? 'waiting_for_preview' : 'undeclared';
  const next: Live = { name, data: d };
  const writes: DomainWrite[] = [{ type: 'declared', sessionId: d.sessionId, head, keepHead: true,
    state: slot.state, detail: slot.detail, cancelCode: 'superseded', cancelReason: reason || SUPERSEDED_REASON }];
  return { s: next, out: step(next, { writes, cancel, work, timer: null }) };
}

// ── Adoption ────────────────────────────────────────────────────────────

const ACTIVE_RUN_STATES: ReadonlySet<string> = new Set(['planned', 'provisioning', 'exploring', 'replaying', 'reviewing']);
const INTERRUPTED_REASON = 'Homeroom restarted while these before & after shots were being taken. You can take them again.';

// A proposal's first event: the instance starts from what its row says, so
// a declaration [main] stored is kept and its shots stand. A run [main]
// was taking (the process that ran it ends with the release), or one its
// shutdown marked interrupted, is a run the release cut off: its copies go,
// the slot says so, and it is taken again once, as any platform fault is,
// while the proposal is open. platform.ts appends to every such proposal
// nobody else did, for an hour after the release starts leading.
function adopt(sessionId: number, f: Facts, ctx: TransitionContext): { s: Live; writes: DomainWrite[]; work: WorkRequest[]; timer?: TimerRequest } {
  const d = fresh(sessionId, f);
  const slot = f.session?.slot;
  const detail = slot?.detail;
  if (detail && detail.intent && typeof detail.intent === 'object') {
    d.declared = { intent: detail.intent, required: requiredForIntent(detail.intent) };
  } else if (detail && detail.required === true) {
    d.declared = { intent: null, required: true };
  }
  if (typeof detail?.headSha === 'string' && SHA.test(detail.headSha)) d.head = detail.headSha;
  const run = slot?.run;
  if (run && slot?.runId === run.id) {
    d.head = run.head;
    const open = !!f.session && OPEN.has(f.session.status);
    const inFlight = ACTIVE_RUN_STATES.has(run.state);
    if (inFlight || (run.state === 'failed' && run.failureCode === 'shots_run_interrupted')) {
      const retryAt = open && d.declared?.intent ? later(ctx, PLATFORM_RETRY_MS) : null;
      d.last = { id: run.id, head: run.head, fault: 'release', retryAt: retryAt?.toISOString() ?? null, retried: false, row: true };
      const timer: TimerRequest | undefined = retryAt
        ? { at: retryAt, event: { type: 'RetryDue', payload: { runId: run.id, phase: 'retry' } } } : undefined;
      if (!inFlight) return { s: { name: 'failed', data: d }, writes: [], work: [], timer };
      const c: Cleaning = { runId: run.id, n: 0, worker: !!f.session?.temporaryWorker, stopTurn: true };
      d.cleaning = [c];
      return {
        s: { name: 'failed', data: d },
        writes: [{ type: 'runMoved', runId: run.id, state: 'failed', patch: {
          failureCode: 'shots_run_interrupted', failureReason: INTERRUPTED_REASON,
          traceMerge: { interruptedBy: 'release', ...(retryAt ? { automaticRetry: true } : {}) } } }],
        work: [cleanupWork(d, c)],
        timer,
      };
    }
    const name: Name = run.state === 'verified' ? 'published' : run.state === 'overridden' ? 'waived'
      : run.state === 'not_required' ? 'not_needed' : 'failed';
    if (name === 'failed') d.last = { id: run.id, head: run.head, fault: null, retryAt: null, retried: true, row: true };
    return { s: { name, data: d }, writes: [], work: [] };
  }
  const name: Name = !d.declared ? 'undeclared' : !d.declared.intent ? 'undeclared'
    : d.declared.required ? 'waiting_for_preview' : 'not_needed';
  return { s: { name, data: d }, writes: [], work: [] };
}

// ── Transitions ─────────────────────────────────────────────────────────

type Handler = (s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps) => Outcome<SState>;

// `b` happened first: the handler's outcome `a` follows it, and its timer
// stands unless it kept the deadline (undefined), when `b`'s does.
const merge = (a: Outcome<SState>, b: Omit<Outcome<SState>, 'next'>): Outcome<SState> => ({
  ...a,
  writes: [...(b.writes || []), ...(a.writes || [])],
  cancel: [...(b.cancel || []), ...(a.cancel || [])],
  work: [...(b.work || []), ...(a.work || [])],
  timer: a.timer !== undefined ? a.timer : b.timer,
});

// A declaration. The same one again, for the same head, changes nothing (a
// build tool reports it more than once); a new one ends the run under way
// and stands for the head, which is shot at once if its preview is ready.
const declared: Handler = (s, e, f, ctx, deps) => {
  const p = e.payload;
  const head = headOf(s.data, f, p.head);
  const intent = p.intent;
  const required = requiredForIntent(intent as any);
  const same = !!s.data.declared?.intent && JSON.stringify(s.data.declared.intent) === JSON.stringify(intent)
    && s.data.head === head;
  if (same) return step(s);
  let d: Data = { ...s.data, declared: { intent, required }, head, last: null, notStarted: null, declaredBy: e.id };
  let cancel: WorkRef[] = [];
  let work: WorkRequest[] = [];
  if (live(s)) ({ d, cancel, work } = endRun({ name: s.name, data: d } as Live, f, { worker: false }));
  const slot = slotDetail(d);
  const writes: DomainWrite[] = [{ type: 'declared', sessionId: d.sessionId, head, keepHead: false,
    state: slot.state, detail: slot.detail, cancelCode: 'intent_changed', cancelReason: 'The author changed the declared changes.' }];
  if (!required) return step({ name: 'not_needed', data: d }, { writes: [...writes, settledNote(d)], cancel, work: [...work, ...settledWork(d, ctx)], timer: null });
  const ready = !!head && !!f.session && OPEN.has(f.session.status) && f.session.readyHeads.includes(head);
  if (ready) return start({ name: 'waiting_for_preview', data: d }, e, f, ctx, deps, 'declared', { writes, cancel, work });
  return step({ name: 'waiting_for_preview', data: d }, { writes, cancel, work, timer: null });
};

const headMoved: Handler = (s, e, f, ctx) => {
  if (s.data.head === e.payload.head) return step(s);
  return moveHead(s, f, ctx, e.payload.head, e.payload.reason).out;
};

// A head is ready to be shot (its preview serves, or its checks settled).
// Shots of that head that settled, or are under way, stand. A proposal back
// in review (unarchived) is shot again on its head. A head the proposal
// already moved past (the message was on its way as it moved) is not.
const WAITING: ReadonlySet<string> = new Set(['waiting_for_preview', 'undeclared', 'closed']);
const headReady: Handler = (s, e, f, ctx, deps) => {
  const head = e.payload.head;
  if (!f.session || !OPEN.has(f.session.status)) return step(s);
  if (head !== s.data.head && head !== f.session.head) return step(s);
  let base: Live = s;
  let moved: Outcome<SState> | null = null;
  if (s.data.head !== head) ({ s: base, out: moved } = moveHead(s, f, ctx, head, null));
  else if (!WAITING.has(s.name)) return step(s);
  const out = start(base, e, f, ctx, deps, 'preview-ready');
  return moved ? merge(out, moved) : out;
};

const previewStopped: Handler = (s, e, f) => {
  if (s.name !== 'waiting_for_preview' || f.session?.source !== 'imported') return step(s);
  return step(s, { writes: [{ type: 'notStarted', sessionId: s.data.sessionId, reason: NOT_STARTED.get('no_staging_preview')! }] });
};

// A UI change with no declaration: the slot says one is needed, for that
// head. A declaration, or this already said for the head, stands.
const uiUndeclared: Handler = (s, e, f, ctx) => {
  const head = headOf(s.data, f, e.payload.head);
  if (s.data.declared?.intent) return step(s);
  if (s.data.declared && s.data.head === head) return step(s);
  let d: Data = { ...s.data, declared: { intent: null, required: true }, head };
  let cancel: WorkRef[] = [];
  let work: WorkRequest[] = [];
  if (live(s)) ({ d, cancel, work } = endRun({ name: s.name, data: d } as Live, f, { worker: false }));
  const slot = slotDetail(d);
  return step({ name: 'undeclared', data: d }, {
    writes: [{ type: 'declared', sessionId: d.sessionId, head, keepHead: false, state: slot.state, detail: slot.detail,
      cancelCode: 'intent_missing', cancelReason: 'The UI change has no declared change for before/after shots.' }],
    cancel, work, timer: null,
  });
};

// The proposal left review: the run under way ends, and every copy goes.
// Shots that settled stand as they are (no automatic retry while it is out
// of review); a declaration waiting for its preview waits on.
const closed: Handler = (s, e, f, ctx) => {
  if (!live(s)) return step(s, { timer: null });
  const r = s.data.run!;
  const { d, cancel, work } = endRun(s, f);
  return step({ name: 'closed', data: d }, {
    writes: [{ type: 'runMoved', runId: r.id, state: 'failed', patch: { failureCode: 'shots_closed', failureReason: CLOSED_REASON } }, settledNote(d)],
    cancel, work: [...work, ...settledWork(d, ctx)], timer: null,
  });
};

// A person takes the shots again (with a new declaration, maybe). A merged
// proposal's may be taken again by hand, to diagnose an old failure.
const retryRequested: Handler = (s, e, f, ctx, deps) => {
  const p = e.payload;
  let d: Data = { ...s.data, head: headOf(s.data, f, null), last: null };
  if (p.intent) d = { ...d, declared: { intent: p.intent, required: requiredForIntent(p.intent) } };
  const slot = slotDetail(d);
  const writes: DomainWrite[] = p.intent ? [{ type: 'declared', sessionId: d.sessionId, head: d.head, keepHead: false,
    state: slot.state, detail: slot.detail, cancelCode: 'intent_changed', cancelReason: 'The author changed the declared changes.' }] : [];
  const trigger = p.reason === 'release' ? 'release-retry' : 'manual-rerun';
  return start({ name: s.name, data: d } as Live, e, f, ctx, deps, trigger, { writes });
};

const stopRequested: Handler = (s, e, f, ctx) => fail(s, f, ctx, { code: 'shots_stopped', reason: STOPPED_REASON });

const waiveRequested: Handler = (s, e, f, ctx) => {
  const p = e.payload;
  const runIdOf = s.data.run?.id || s.data.last?.id;
  let d = s.data;
  let cancel: WorkRef[] = [];
  let work: WorkRequest[] = [];
  if (live(s)) ({ d, cancel, work } = endRun(s, f));
  return step({ name: 'waived', data: { ...d, last: null } }, {
    writes: [{ type: 'waived', runId: runIdOf!, userId: p.userId, reason: p.reason }, settledNote(d)],
    cancel, work: [...work, ...settledWork(d, ctx)], timer: null,
  });
};

const recheck: Handler = (s, e, f, ctx, deps) => dispatchOrWait(s, f, ctx, deps);
// The step a timer of the run under way was set for, as clockFor names it.
const phaseOf = (s: Live): string | null => (s.name === 'building_copies' ? 'copies'
  : s.name === 'taking_shots' ? agentPhase(s.data.run!) : s.name === 'publishing' ? 'publish'
  : s.name === 'waiting_for_agent' ? 'wait' : null);

// A step past its deadline. The copies are a platform fault (taken again
// once); an agent's turn that never ended means its process is stuck (the
// same); a comparison that never ended publishes without outlines.
const overdue: Handler = (s, e, f, ctx) => {
  if (s.name === 'building_copies') {
    return fail(s, f, ctx, { code: 'shots_copies_timeout', reason: 'The before and after copies took too long to build.', fault: 'copies_timeout' });
  }
  if (s.name === 'taking_shots') {
    return fail(s, f, ctx, { code: 'shots_agent_timeout', reason: 'The shots agent\u2019s turn did not end in time.', fault: 'agent_exit' });
  }
  return publishDone(s, { ...e, type: 'WorkExhausted', payload: { workId: '', kind: WORK.publish, workKey: '', attempt: 0 } } as any, f, ctx);
};

// A platform fault's one retry, on the same head, while it is still the
// proposal's.
const retryDue: Handler = (s, e, f, ctx, deps) => {
  const l = s.data.last;
  if (!l || l.retried || !l.fault || l.head !== s.data.head || !f.session || !OPEN.has(f.session.status)) return step(s, { timer: null });
  return start(s, e, f, ctx, deps, 'platform-retry', { platformRetry: true, data: { ...s.data, last: { ...l, retried: true } } });
};

// ── Work results ────────────────────────────────────────────────────────

const result = (e: Event<WorkResultPayload>): any => (e.type === 'WorkSucceeded' ? (e.payload.result || {}) : null);
const errorOf = (e: Event<WorkResultPayload>) => e.payload.error?.message || 'the step failed';

function revisionDone(s: Live, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<SState> {
  const r = s.data.run!;
  const out = result(e);
  if (!out?.baseSha) {
    // GitHub could not say what the head is compared with: nothing was
    // built, so the slot says the run never started (as it did), and its
    // limit, or its being down, is taken again once.
    const failed = out?.failed || { fault: e.type === 'WorkSucceeded' ? null : 'revision' };
    return notStartedRun(s, f, ctx, { reason: NOT_STARTED.get('no_revision')!, fault: failed.fault, retryAt: failed.retryAt });
  }
  const run: Run = { ...r, base: out.baseSha };
  const d: Data = { ...s.data, run };
  return step({ name: 'building_copies', data: d }, {
    writes: [{ type: 'runStarted', sessionId: d.sessionId, runId: r.id, base: run.base, head: run.head,
      intent: d.declared!.intent, trigger: r.trigger }],
    work: [
      { kind: WORK.copies, key: `copies:${r.n}`, input: { runId: r.id, sessionId: d.sessionId, n: r.n, intent: d.declared!.intent,
        baseSha: run.base, headSha: run.head, budgetMs: deps.agentBudgetMs } },
      { kind: WORK.prBlock, key: `pr-block:${r.id}`, input: { sessionId: d.sessionId } },
    ],
  });
}

function copiesDone(s: Live, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<SState> {
  const r = s.data.run!;
  const out = result(e);
  if (!out || out.failed || out.stale) {
    const failed = out?.failed || { code: 'shots_copies_failed', message: errorOf(e), fault: 'database' };
    return fail(s, f, ctx, { code: failed.code, reason: failed.message, fault: failed.fault, retryAt: failed.retryAt, copiesSettled: true });
  }
  const run: Run = { ...r, afterOnly: !!out.afterOnly, copiesAt: ctx.now.toISOString() };
  const writes: DomainWrite[] = [{ type: 'runMoved', runId: r.id, state: 'exploring', patch: {
    fixtureFingerprint: out.fixtureFingerprint, baseImageDigest: out.baseImageDigest, headImageDigest: out.headImageDigest } }];
  return dispatchOrWait({ name: s.name, data: { ...s.data, run } } as Live, f, ctx, deps, writes);
}

// The agent's trace, with the last tool call the control plane refused (a
// run that saved nothing often says why only there).
function traceOf(out: any): Json {
  const t = out?.lastToolFailure;
  return { ...(out?.trace || {}), ...(t && typeof t === 'object' ? { lastToolFailure: {
    tool: t.tool ?? null, toolCode: t.toolCode ?? t.code ?? null, toolMessage: t.toolMessage ?? t.message ?? null } } : {}) } as Json;
}

function agentDone(s: Live, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<SState> {
  const r = s.data.run!;
  const out = result(e);
  if (!out) {
    return fail(s, f, ctx, { code: 'shots_agent_failed', reason: `The shots agent's step failed: ${errorOf(e)}`.slice(0, 2000), fault: 'agent_exit' });
  }
  const agent = out.agent || { outcome: 'failed' };
  const left = deps.agentBudgetMs - (ctx.now.getTime() - Date.parse(r.agentStartedAt || ctx.now.toISOString()));
  // Another turn took the agent before this one started: wait for it again.
  if (agent.outcome === 'busy' && r.busy < MAX_AGENT_BUSY_RETRIES && left >= MIN_AGENT_RETRY_MS) {
    return dispatchOrWait({ name: s.name, data: { ...s.data, run: { ...r, busy: r.busy + 1, agentWaitUntil: null } } } as Live,
      { session: f.session ? { ...f.session, agentBusy: true } : null }, ctx, deps);
  }
  // Its process died under it (memory, its container): once more on the
  // same copies; what it saved stays saved.
  if (agent.outcome === 'died' && r.died < 1 && left >= MIN_AGENT_RETRY_MS) {
    return dispatchOrWait({ name: s.name, data: { ...s.data, run: { ...r, died: r.died + 1 } } } as Live, f, ctx, deps);
  }
  // Every change with a complete before/after set is published, even when
  // the turn ran out of time or another change was skipped.
  if (out.passed) {
    const publish = { verdict: out.verdict, manifestHash: out.manifestHash, slots: out.slots };
    return step({ name: 'publishing', data: { ...s.data, run: { ...r, publish } } }, {
      writes: [{ type: 'runMoved', runId: r.id, state: 'reviewing', patch: { hardVerdict: out.verdict, planHash: out.manifestHash, traceSummary: out.trace } }],
      work: [{ kind: WORK.publish, key: `publish:${r.n}`, input: { runId: r.id, verdict: out.verdict } }],
      timer: clockFor(ctx, PUBLISH_DEADLINE_MS, 'Overdue', r.id, 'publish'),
    });
  }
  if (agent.outcome !== 'completed' && !out.skippedAny) {
    const fault = agent.platformFault?.kind || agent.fault
      || (agent.outcome === 'died' || agent.code === 'shots_agent_failed' ? 'agent_exit' : null);
    return fail(s, f, ctx, { code: agent.code || 'shots_agent_failed', reason: agent.message || 'The shots agent stopped with an error before it finished.',
      fault, retryAt: agent.retryAt, trace: traceOf(out) });
  }
  if (out.failedCount) return fail(s, f, ctx, { code: 'shots_change_failed', reason: out.failedReason, verdict: out.verdict, trace: traceOf(out) });
  return fail(s, f, ctx, { code: 'shots_capture_incomplete', reason: out.incompleteReason, verdict: out.verdict, trace: traceOf(out) });
}

// Published: with the comparison's outlines, or without them when the
// comparison could not be made.
function publishDone(s: Live, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<SState> {
  const r = s.data.run!;
  const p = r.publish!;
  const compared = result(e)?.verdict;
  const { d, cancel, work } = endRun(s, f);
  return step({ name: 'published', data: d }, {
    timer: null,
    writes: [{ type: 'published', runId: r.id, slots: p.slots, verdict: compared || p.verdict, planHash: p.manifestHash }, settledNote(d)],
    cancel: e.type === 'WorkSucceeded' ? cancel.filter((c) => c.kind !== WORK.publish) : cancel,
    work: [...work, ...settledWork(d, ctx)],
  });
}

// A run's copies are gone: its row says so (the retention prune waits for
// it). One that keeps failing waits for an admin (Admin → Workflows).
function cleaned(s: Live, e: Event<WorkResultPayload>): Outcome<SState> {
  if (e.type !== 'WorkSucceeded') return step(s);
  const runIdOf = String(e.payload.workKey).slice('cleanup:'.length);
  const version = Number((e.payload.result as any)?.version) || null;
  return step({ name: s.name, data: { ...s.data, cleaning: s.data.cleaning.filter((c) => c.runId !== runIdOf) } }, {
    writes: [{ type: 'cleaned', runId: runIdOf, version }],
  });
}

// A work result for the run under way, by its key; anything else is stale.
const workDone: Handler = (s, e, f, ctx, deps) => {
  const p = e.payload as WorkResultPayload;
  if (p.kind === WORK.cleanup) return cleaned(s, e);
  if (p.kind === WORK.prBlock) return step(s);
  // Copies of a run that ended while they were built: now their cleanup.
  const waited = p.kind === WORK.copies ? s.data.cleaning.find((c) => c.awaitCopies && p.workKey === `copies:${c.n}`) : null;
  if (waited) {
    const c: Cleaning = { runId: waited.runId, n: waited.n, worker: waited.worker, stopTurn: waited.stopTurn };
    const d: Data = { ...s.data, cleaning: s.data.cleaning.map((x) => (x === waited ? c : x)) };
    return step({ name: s.name, data: d }, { work: [cleanupWork(d, c)] });
  }
  const r = s.data.run;
  if (!r) return step(s);
  if (p.kind === WORK.revision && s.name === 'building_copies' && p.workKey === `revision:${r.n}`) return revisionDone(s, e, f, ctx, deps);
  if (p.kind === WORK.copies && s.name === 'building_copies' && p.workKey === `copies:${r.n}`) return copiesDone(s, e, f, ctx, deps);
  if (p.kind === WORK.agent && s.name === 'taking_shots' && p.workKey === `agent:${r.n}:${r.dispatches}`) return agentDone(s, e, f, ctx, deps);
  if (p.kind === WORK.publish && s.name === 'publishing' && p.workKey === `publish:${r.n}`) return publishDone(s, e, f, ctx);
  return step(s);
};

// A head event its caller sent for a revision the proposal has since moved
// past. Two callers can move the same proposal at once (two import passes,
// an update and a sync): the one that wrote its column first may append
// last, and its head would take the slot back. The event names the column
// its caller moved or read (`pin`); once that column holds another head, it
// is stale, unless that head is the one the caller read there (`from`: a
// caller that appends before it writes, or that moved nothing).
function staleHead(e: Event<any>, f: Facts): boolean {
  const { head, pin, from } = e.payload;
  if (!head || !pin || !f.session) return false;
  const now = (f.session.pins as Record<string, string | null>)[pin];
  return !!now && now !== head && now !== from;
}

const ranFor = (s: Live, e: Event<any>) => !!s.data.run && s.data.run.id === e.payload.runId && phaseOf(s) === e.payload.phase;

// Which state takes which request.
const GUARDS = new Map<string, (s: Live, e: Event<any>, f: Facts) => Check>([
  ['Declared', (s, e, f) => (staleHead(e, f) ? reject('stale_head') : ok())],
  ['HeadMoved', (s, e, f) => (staleHead(e, f) ? reject('stale_head') : ok())],
  ['RetryRequested', (s, e, f) => {
    if (live(s)) return reject('shots_rerun_in_flight');
    if (!f.session) return reject('session_not_found');
    if (!OPEN.has(f.session.status) && !(f.session.status === 'merged' && e.source.kind === 'route')) return reject('closed');
    if (!e.payload.intent && !s.data.declared?.intent) return reject('missing_visible_changes');
    return ok();
  }],
  // A run whose row exists: the slot shows it (before its revision is
  // resolved, there is nothing on the slot to stop or waive).
  ['StopRequested', (s) => (live(s) && !!s.data.run?.base ? ok() : reject('not_running'))],
  ['WaiveRequested', (s) => ((live(s) && !!s.data.run?.base) || (s.name === 'failed' && !!s.data.last?.row)
    ? ok() : reject('invalid_shots_override_state'))],
  // The machine's clock, for the run and the step it was set for.
  ['Recheck', (s, e) => (s.name === 'waiting_for_agent' && ranFor(s, e) ? ok() : reject('not_waiting'))],
  ['Overdue', (s, e) => (['building_copies', 'taking_shots', 'publishing'].includes(s.name) && ranFor(s, e) ? ok() : reject('nothing_due'))],
  ['RetryDue', (s, e) => ((s.name === 'failed' || s.name === 'waiting_for_preview') && !!s.data.last
    && s.data.last.id === e.payload.runId ? ok() : reject('not_failed'))],
]);
const HANDLERS = new Map<string, Handler>([
  ['Declared', declared], ['HeadMoved', headMoved], ['HeadReady', headReady], ['PreviewStopped', previewStopped],
  ['UiUndeclared', uiUndeclared], ['Closed', closed], ['RetryRequested', retryRequested], ['StopRequested', stopRequested],
  ['WaiveRequested', waiveRequested], ['Recheck', recheck], ['Overdue', overdue], ['RetryDue', retryDue],
  ['WorkSucceeded', workDone], ['WorkFailed', workDone], ['WorkExhausted', workDone],
]);
// The events that may create the instance, and those that need one.
const CREATE = ['Declared', 'HeadMoved', 'HeadReady', 'PreviewStopped', 'UiUndeclared', 'Closed', 'RetryRequested', 'WaiveRequested', 'StopRequested'];

function transitions(deps: Deps) {
  const entry = (type: string) => ({
    guard: (s: any, e: Event<any>, f: Facts) => {
      const g = GUARDS.get(type);
      return g ? g(s, e, f) : ok();
    },
    to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => HANDLERS.get(type)!(s, e, f, ctx, deps),
  });
  const row = Object.fromEntries([...HANDLERS.keys()].map((t) => [t, entry(t)]));
  const table: Record<string, Record<string, any>> = {};
  for (const name of STATES) table[name] = row;
  // The first event adopts the proposal from its row, then is handled.
  const adopting = (type: string) => ({
    guard: (_s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => {
      if (!f.session) return reject('session_not_found');
      if (ctx.key !== sessionKey(e.payload.sessionId)) return reject('key_mismatch');
      const a = adopt(e.payload.sessionId, f, ctx);
      const g = GUARDS.get(type);
      return g ? g(a.s, e, f) : ok();
    },
    to: (_s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => {
      const a = adopt(e.payload.sessionId, f, ctx);
      const out = HANDLERS.get(type)!(a.s, e, f, ctx, deps);
      return merge(out, { writes: a.writes, work: a.work, timer: a.timer });
    },
  });
  table[NONE] = Object.fromEntries(CREATE.map((t) => [t, adopting(t)]));
  return table;
}

// ── The machine ─────────────────────────────────────────────────────────

const PRODUCERS: ReadonlySet<string> = new Set(['route', 'system']);

export function shots(deps: Deps): Machine<SState, Facts> {
  const produced = (e: Event<any>): Check => (PRODUCERS.has(e.source.kind) ? ok() : reject('not_a_producer'));
  // The proposal machine moves the reviewed or imported head, and says so in
  // the move's own transaction.
  const movedByProposal = (e: Event<any>): Check =>
    (PRODUCERS.has(e.source.kind) || (e.source.kind === 'message' && e.source.from.machine === 'proposal') ? ok() : reject('not_a_producer'));
  const fromPreview = (e: Event<any>): Check =>
    ((e.source.kind === 'message' && e.source.from.machine === 'preview') || e.source.kind === 'system' ? ok() : reject('internal_only'));
  const person = (e: Event<any>): Check => (e.source.kind === 'route' || e.source.kind === 'system' ? ok() : reject('not_a_producer'));
  const timer = (e: Event<any>): Check => (e.source.kind === 'timer' ? ok() : reject('timer_only'));
  return defineMachine<SState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: CREATE,
    decode: (row) => ({ name: row.state, data: row.data } as SState),
    facts: (tx, state, event) => {
      const id = state.name === NONE ? Number((event.payload as any)?.sessionId) : (state.data as Data).sessionId;
      if (!Number.isInteger(id) || id <= 0) return Promise.resolve({ session: null });
      return readFacts(tx, id);
    },
    authorize: {
      Declared: produced,
      HeadMoved: movedByProposal,
      HeadReady: fromPreview,
      PreviewStopped: fromPreview,
      UiUndeclared: fromPreview,
      Closed: fromPreview,
      RetryRequested: person,
      StopRequested: person,
      WaiveRequested: person,
      Recheck: timer,
      Overdue: timer,
      RetryDue: timer,
    },
    transitions: transitions(deps) as any,
    writes: WRITES,
    reply: async (tx, event, after) => {
      if (after.name === NONE) return null;
      const d = (after as Live).data;
      const { rows: [s] } = await tx.query('SELECT shots_state, shots_run_id, shots_detail FROM chat_sessions WHERE id = $1', [d.sessionId]);
      // A run that just started has no row until its revision resolves: the
      // slot still shows the run before it.
      const starting = LIVE.has(after.name) && !!d.run && !d.run.base;
      return { machineState: after.name, state: starting ? 'planned' : s?.shots_state ?? null,
        runId: starting ? null : s?.shots_run_id ?? null,
        detail: s?.shots_detail ?? null, required: d.declared?.required ?? null,
        ...(event.type === 'Declared' ? { unchanged: d.declaredBy !== event.id } : {}) };
    },
  });
}

// ── Domain writes ───────────────────────────────────────────────────────
//
// The slot on chat_sessions and the runs in shot_runs, each with what
// browsers hear about it: the proposal's card (vote_update, action 'shots')
// and the open conversations whose active change it is.

const ACTIVE_RUN = `state IN ('planned', 'provisioning', 'exploring', 'replaying', 'reviewing')`;

async function tell(tx: Tx, ctx: any, sessionId: number, state: string | null) {
  const { rows: [s] } = await tx.query(
    'SELECT cs.app_id, a.slug FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1', [sessionId]);
  if (!s) return;
  ctx.push(voteUpdate({ sessionId, appId: s.app_id, appSlug: s.slug, merged: false, action: 'shots', shotsState: state }));
  const { rows } = await tx.query(
    `SELECT id, user_id FROM agent_sessions WHERE active_change_id = $1 AND status = 'open'`, [sessionId]);
  for (const r of rows) ctx.push(toUser(r.user_id, { type: 'agent_session_changed', agentSessionId: r.id }));
}

// The run's row moved: the slot shows its summary (with its files, once
// published).
async function showRun(tx: Tx, ctx: any, runIdOf: string) {
  const { rows: [run] } = await tx.query('SELECT * FROM shot_runs WHERE id = $1', [runIdOf]);
  if (!run) return;
  let artifacts: unknown[] = [];
  if (run.state === 'verified') {
    ({ rows: artifacts } = await tx.query(
      `SELECT id, story_id AS "storyId", viewport, side, variant, media, theme, content_type AS "contentType",
              width, height, bytes, sha256, focus_rect AS "focusRect", stage_labels AS "stageLabels"
         FROM shot_artifacts WHERE run_id = $1 ORDER BY story_id, viewport, side, variant, theme`, [runIdOf]));
  }
  const detail = { ...runSummary(run, artifacts), intent: run.intent };
  const { rowCount } = await tx.query(
    `UPDATE chat_sessions SET shots_state = $2, shots_run_id = $3, shots_detail = $4::jsonb, shots_updated_at = NOW()
      WHERE id = $1 AND shots_run_id = $3`, [run.session_id, run.state, run.id, JSON.stringify(detail)]);
  if (rowCount) await tell(tx, ctx, run.session_id, run.state);
}

const PATCH_COLUMNS: ReadonlyMap<string, string> = new Map([
  ['planHash', 'plan_hash'], ['traceSummary', 'trace_summary'], ['hardVerdict', 'hard_verdict'],
  ['failureCode', 'failure_code'], ['failureReason', 'failure_reason'], ['fixtureFingerprint', 'fixture_fingerprint'],
  ['baseImageDigest', 'base_image_digest'], ['headImageDigest', 'head_image_digest'],
]);
const JSON_COLUMNS: ReadonlySet<string> = new Set(['trace_summary', 'hard_verdict']);
const TERMINAL: ReadonlySet<string> = new Set(['verified', 'failed', 'stale', 'cancelled', 'not_required', 'overridden']);

async function moveRun(tx: Tx, runIdOf: string, state: string, patch: Record<string, unknown>) {
  const sets = ['state = $2', 'updated_at = NOW()'];
  const values: unknown[] = [runIdOf, state];
  for (const [key, column] of PATCH_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const v = patch[key];
    values.push(JSON_COLUMNS.has(column) ? (v == null ? null : JSON.stringify(v)) : v);
    sets.push(`${column} = $${values.length}${JSON_COLUMNS.has(column) ? '::jsonb' : ''}`);
  }
  if (patch.traceMerge) {
    values.push(JSON.stringify(patch.traceMerge));
    sets.push(`trace_summary = COALESCE(trace_summary, '{}'::jsonb) || $${values.length}::jsonb`);
  }
  if (TERMINAL.has(state)) sets.push('completed_at = COALESCE(completed_at, NOW())');
  await tx.query(`UPDATE shot_runs SET ${sets.join(', ')} WHERE id = $1`, values);
}

const WRITES = {
  botChange: writeBotChange,
  // A declaration, a missing one, or a head move: runs that no longer stand
  // end (one under way is cancelled, a settled one goes stale), and the slot
  // shows the declaration for the head. `keepHead`: runs on this head stand.
  declared: async (tx: Tx, w: any, ctx: any) => {
    await tx.query(
      `UPDATE shot_runs
          SET state = CASE WHEN ${ACTIVE_RUN} THEN 'cancelled' ELSE 'stale' END,
              failure_code = CASE WHEN ${ACTIVE_RUN} THEN $3 ELSE failure_code END,
              failure_reason = CASE WHEN ${ACTIVE_RUN} THEN $4 ELSE failure_reason END,
              completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE session_id = $1 AND state NOT IN ('stale', 'cancelled')
          AND ($5::boolean IS FALSE OR head_sha IS DISTINCT FROM $2)`,
      [w.sessionId, w.head, w.cancelCode, w.cancelReason, !!w.keepHead]);
    await tx.query(
      `UPDATE chat_sessions SET shots_state = $2, shots_run_id = NULL, shots_detail = $3::jsonb, shots_updated_at = NOW()
        WHERE id = $1`, [w.sessionId, w.state, JSON.stringify(w.detail)]);
    await tell(tx, ctx, w.sessionId, w.state);
  },
  // A run starts: every other run of the proposal ends, and the slot points
  // at it.
  runStarted: async (tx: Tx, w: any, ctx: any) => {
    await tx.query(
      `UPDATE shot_runs
          SET state = CASE WHEN ${ACTIVE_RUN} THEN 'cancelled' ELSE 'stale' END,
              failure_code = CASE WHEN ${ACTIVE_RUN} THEN 'superseded' ELSE failure_code END,
              completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE session_id = $1 AND state NOT IN ('stale', 'cancelled')`, [w.sessionId]);
    await tx.query(
      `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, plan_version, intent, state, trigger, started_at)
       VALUES ($1, $2, $3, $4, 1, $5::jsonb, 'provisioning', $6, NOW())`,
      [w.runId, w.sessionId, w.base, w.head, JSON.stringify(w.intent), String(w.trigger || '').slice(0, 32)]);
    await tx.query(`UPDATE chat_sessions SET shots_run_id = $2 WHERE id = $1`, [w.sessionId, w.runId]);
    await showRun(tx, ctx, w.runId);
  },
  runMoved: async (tx: Tx, w: any, ctx: any) => {
    await moveRun(tx, w.runId, w.state, w.patch || {});
    await showRun(tx, ctx, w.runId);
  },
  // The ready changes' files become the run's shots, and the run is
  // published, in one transaction.
  published: async (tx: Tx, w: any, ctx: any) => {
    await tx.query(
      `INSERT INTO shot_artifacts (id, run_id, story_id, viewport, side, variant, media, theme, content_type,
                                   data, width, height, bytes, sha256,
                                   density, dense_data, dense_width, dense_height, dense_bytes, dense_sha256,
                                   part, scale, focus_rect, public_safe)
       SELECT md5(f.run_id || ':' || f.slot), f.run_id, f.story_id, f.viewport, f.side, f.variant, f.media, f.theme,
              f.content_type, f.data, f.width, f.height, f.bytes, f.sha256,
              f.density, f.dense_data, f.dense_width, f.dense_height, f.dense_bytes, f.dense_sha256,
              f.part, f.scale, f.focus_rect, f.public_safe
         FROM shot_run_files f WHERE f.run_id = $1 AND f.slot = ANY($2::text[])
       ON CONFLICT DO NOTHING`, [w.runId, w.slots]);
    await moveRun(tx, w.runId, 'verified', { hardVerdict: w.verdict, planHash: w.planHash });
    await showRun(tx, ctx, w.runId);
  },
  waived: async (tx: Tx, w: any, ctx: any) => {
    await tx.query(
      `UPDATE shot_runs SET state = 'overridden', override_user_id = $2, override_reason = $3,
              overridden_at = NOW(), completed_at = NOW(), updated_at = NOW()
        WHERE id = $1`, [w.runId, w.userId, w.reason]);
    await showRun(tx, ctx, w.runId);
  },
  cleaned: async (tx: Tx, w: any) => {
    await tx.query(
      `UPDATE shot_runs SET trace_summary = COALESCE(trace_summary, '{}'::jsonb)
              || jsonb_build_object('cleanupComplete', true, 'cleanupVersion', $2::int)
        WHERE id = $1`, [w.runId, w.version]);
  },
  // Why no run started, on the proposal (#2601, #2558), without touching
  // shots_updated_at: that is how long the slot has waited.
  notStarted: async (tx: Tx, w: any) => {
    await tx.query(
      `UPDATE chat_sessions SET shots_detail = COALESCE(shots_detail, '{}'::jsonb) || jsonb_build_object('notStartedReason', $2::text)
        WHERE id = $1 AND shots_state = 'planned'
          AND shots_detail->>'notStartedReason' IS DISTINCT FROM $2::text`, [w.sessionId, w.reason]);
  },
};
