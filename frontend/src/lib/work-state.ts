/**
 * Where a request or a change stands: one word set on every screen
 * (docs/plans/bot-one-model.md, step 3).
 *
 * The server decides it once (src/services/work-state.js) and stores it; the
 * Homeroom bot tab, the chat's drawer, a request's page and a project's chat
 * draw what it sent, and a `work_state` push says when it changed. Screens
 * differ only in how much of it they show: the stage word alone, or the
 * stage and its second line.
 *
 * Ten stages: reading, planning, waiting_for_you (always with a why),
 * building, checking, up_for_vote, going_live, live, stopped (with a
 * reason), closed. The second line (`line`) carries a queue place, a hold, a
 * round of review, and the like.
 */

export type Stage =
  | 'reading' | 'planning' | 'waiting_for_you' | 'building' | 'checking'
  | 'up_for_vote' | 'going_live' | 'live' | 'stopped' | 'closed';

export type Why = 'question' | 'plan' | 'decide' | 'already_works' | 'needs_detail';

export type Reason = 'build_failed' | 'fix_stopped' | 'look_failed' | 'change_closed' | 'stalled';

export interface WorkLine {
  code: string;
  /** `queued`: its place in Homeroom bot's line (1 is next). */
  place?: number;
  /** `reviewing`: the round, of how many. */
  round?: number;
  of?: number;
  /** `checks_failing`: how many tests failed. */
  failing?: number;
  /** `checks_running`: about how many minutes are left. */
  minutes?: number;
  /** `claimed`: who pressed Claim. */
  by?: string;
  /** `reason`: Homeroom bot's own sentence. */
  text?: string;
}

export interface WorkState {
  stage: Stage;
  why?: Why | null;
  reason?: Reason | null;
  line?: WorkLine | null;
  whoseMove?: 'bot' | 'requester' | 'group' | 'builder' | null;
  since?: string | null;
}

export interface Phrase {
  id: string;
  values?: Record<string, string | number>;
}

export const STAGES: readonly Stage[] = Object.freeze([
  'reading', 'planning', 'waiting_for_you', 'building', 'checking',
  'up_for_vote', 'going_live', 'live', 'stopped', 'closed',
]);

const STAGE_WORDS: Record<Stage, string> = {
  reading: 'core:work.stage.reading',
  planning: 'core:work.stage.planning',
  waiting_for_you: 'core:work.stage.waitingForYou',
  building: 'core:work.stage.building',
  checking: 'core:work.stage.checking',
  up_for_vote: 'core:work.stage.upForVote',
  going_live: 'core:work.stage.goingLive',
  live: 'core:work.stage.live',
  stopped: 'core:work.stage.stopped',
  closed: 'core:work.stage.closed',
};

const WHY_YOURS: Record<Why, string> = {
  question: 'core:work.why.question',
  plan: 'core:work.why.plan',
  decide: 'core:work.why.decide',
  already_works: 'core:work.why.alreadyWorks',
  needs_detail: 'core:work.why.needsDetail',
};

const WHY_OTHERS: Record<Why, string> = {
  question: 'core:work.whyOthers.question',
  plan: 'core:work.whyOthers.plan',
  decide: 'core:work.whyOthers.decide',
  already_works: 'core:work.whyOthers.alreadyWorks',
  needs_detail: 'core:work.whyOthers.needsDetail',
};

const REASON_WORDS: Record<Reason, string> = {
  build_failed: 'core:work.reason.buildFailed',
  fix_stopped: 'core:work.reason.fixStopped',
  look_failed: 'core:work.reason.lookFailed',
  change_closed: 'core:work.reason.changeClosed',
  stalled: 'core:work.reason.stalled',
};

const NOT_STARTED: ReadonlySet<string> = new Set(['queued', 'waiting', 'on_hold', 'cooldown', 'first_version_wait']);
const READY: ReadonlySet<string> = new Set(['queued', 'held_builds', 'held_waiting']);

// The second lines that need no value.
const LINE_WORDS: Record<string, string> = {
  queued: 'core:work.line.queued',
  first_version_wait: 'core:work.line.firstVersionWait',
  held_builds: 'core:work.line.heldBuilds',
  held_waiting: 'core:work.line.heldWaiting',
  on_hold: 'core:work.line.onHold',
  cooldown: 'core:work.line.cooldown',
  reply: 'core:work.line.reply',
  retry_plan: 'core:work.line.retryPlan',
  starting: 'core:work.line.starting',
  proposing: 'core:work.line.proposing',
  fixing: 'core:work.line.fixing',
  revising: 'core:work.line.revising',
  update_queued: 'core:work.line.updateQueued',
  checks_failing: 'core:work.line.checksFailing',
  sync_wait: 'core:work.line.syncWait',
  conflict_on_yes: 'core:work.line.conflictOnYes',
  github_checks: 'core:work.line.githubChecks',
  github_checks_failing: 'core:work.line.githubChecksFailing',
  github_wait: 'core:work.line.githubWait',
  first_version: 'core:work.line.firstVersion',
  planning_with_you: 'core:work.line.planningWithYou',
  waiting: 'core:work.line.waiting',
};

/** Pure: whether a value is a stage this build knows. */
export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/**
 * Pure: the stage's words. Waiting for you says why, in the requester's
 * words (`yours`) or as anyone else reads it; stopped says what stopped it.
 */
export function stageWords(state: WorkState, { yours = true }: { yours?: boolean } = {}): Phrase {
  if (state.stage === 'waiting_for_you' && state.why && WHY_YOURS[state.why]) {
    return { id: (yours ? WHY_YOURS : WHY_OTHERS)[state.why] };
  }
  if (state.stage === 'stopped' && state.reason && REASON_WORDS[state.reason]) return { id: REASON_WORDS[state.reason] };
  // The same stages in plainer words: nobody has started on it yet, or it is
  // read and waits its turn to be built.
  const code = state.line?.code || '';
  // #6531: a conflicting change the lane is catching up says "Syncing with
  // main" in its stage word, not "Checking".
  if (state.stage === 'checking' && code === 'syncing') return { id: 'core:work.stage.syncing' };
  if (state.stage === 'reading' && NOT_STARTED.has(code)) return { id: 'core:work.stage.notStarted' };
  if (state.stage === 'building' && READY.has(code)) return { id: 'core:work.stage.readyToBuild' };
  return { id: STAGE_WORDS[state.stage] || STAGE_WORDS.reading };
}

/** Pure: the second line, or null when it has none. */
export function lineWords(state: WorkState): Phrase | null {
  const line = state.line;
  if (!line || !line.code) return null;
  switch (line.code) {
    case 'queued':
      return line.place ? { id: 'core:work.line.queuedAt', values: { place: line.place } } : { id: LINE_WORDS.queued };
    case 'reviewing':
      return { id: 'core:work.line.reviewing', values: { round: line.round || 1, of: line.of || 1 } };
    case 'checks_failing':
      return line.failing
        ? { id: 'core:work.line.checksFailingCount', values: { count: line.failing } }
        : { id: LINE_WORDS.checks_failing };
    case 'checks_running':
      return line.minutes
        ? { id: 'core:work.line.checksRunning', values: { count: line.minutes } }
        : null;
    case 'claimed':
      return line.by ? { id: 'core:work.line.claimed', values: { username: line.by } } : null;
    case 'reason':
      return line.text ? { id: 'core:work.line.said', values: { reason: line.text } } : null;
    default:
      return LINE_WORDS[line.code] ? { id: LINE_WORDS[line.code] } : null;
  }
}

/** Pure: whether the stage asks something of its requester. */
export function asksRequester(state: WorkState | null | undefined): boolean {
  return !!state && (state.stage === 'waiting_for_you' || state.stage === 'stopped');
}

const WHYS: ReadonlySet<string> = new Set(['question', 'plan', 'decide', 'already_works', 'needs_detail']);
const REASONS: ReadonlySet<string> = new Set(['build_failed', 'fix_stopped', 'look_failed', 'change_closed', 'stalled']);
const MOVES: ReadonlySet<string> = new Set(['bot', 'requester', 'group', 'builder']);
const CODE = /^[a-z_]{1,40}$/;

/**
 * Pure: a work state as the server sent it, field by field, or null for a
 * stage this client does not know (drawn nowhere rather than guessed at).
 */
export function normalizeWorkState(input: unknown): WorkState | null {
  const row = input && typeof input === 'object' ? input as Record<string, unknown> : null;
  if (!row || !isStage(row.stage)) return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  const lineIn = row.line && typeof row.line === 'object' ? row.line as Record<string, unknown> : null;
  const code = text(lineIn?.code);
  const line: WorkLine | null = lineIn && CODE.test(code) ? {
    code,
    ...(num(lineIn.place) ? { place: num(lineIn.place) } : {}),
    ...(num(lineIn.round) ? { round: num(lineIn.round) } : {}),
    ...(num(lineIn.of) ? { of: num(lineIn.of) } : {}),
    ...(num(lineIn.failing) ? { failing: num(lineIn.failing) } : {}),
    ...(num(lineIn.minutes) ? { minutes: num(lineIn.minutes) } : {}),
    ...(text(lineIn.by) ? { by: text(lineIn.by).slice(0, 64) } : {}),
    ...(text(lineIn.text) ? { text: text(lineIn.text).slice(0, 200) } : {}),
  } : null;
  return {
    stage: row.stage,
    why: WHYS.has(text(row.why)) ? text(row.why) as Why : null,
    reason: REASONS.has(text(row.reason)) ? text(row.reason) as Reason : null,
    line,
    whoseMove: MOVES.has(text(row.whoseMove)) ? text(row.whoseMove) as WorkState['whoseMove'] : null,
    since: text(row.since) || null,
  };
}

/** A `work_state` push (services/work-state.js pushOf), as the socket delivers it. */
export interface WorkStatePush {
  type: 'work_state';
  appId: number;
  appSlug: string | null;
  item: { kind: 'request' | 'change'; ref: number; issueNumber: number | null; sessionId: number | null };
  state: WorkState;
}

/** Pure: whether an events-socket message is a work_state push. */
export function isWorkStatePush(event: unknown): event is WorkStatePush {
  const e = event as WorkStatePush | null;
  return !!e && e.type === 'work_state' && !!e.item && !!e.state && isStage(e.state.stage);
}
