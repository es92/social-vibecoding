'use strict';

// #3685: how far along the Homeroom bot is with one person's work, read from
// the platform's own records, so its DM (homeroom-bot-mayor.js) can answer
// "how far along are you?" with what is true and nothing more.
//
// Every request the bot works on for somebody moves through the same steps,
// and each step leaves a record behind:
//
//   set up the project   a first version only: the project's row is still
//                        'creating' and homeroom_bot_first_versions waits for
//                        it. app-creation-phase says which of the four parts
//                        of the setup runs, when it runs in this process.
//   read the request     homeroom_bot_queue: waiting (enqueued_at) or being
//                        read now (started_at). A question the bot asked
//                        waits in homeroom_bot_dm_messages.
//   write a plan         a live 'ready' run whose build session exists and
//                        whose spec is not posted yet.
//   build it             the spec is posted (homeroom_bot_posts 'spec') and
//                        the build session is still active.
//   run its checks       the proposal's check_state, check_phase and
//                        checks_progress.
//   group vote           the proposal is up and its checks passed: votes for
//                        and against, and how many it needs.
//   live                 merged.
//
// The queue row of a request is deleted as soon as it has been read, BEFORE
// its plan and build (homeroom-bot.js runTriage), so a build in progress is
// found from its run and its build session, never from the queue.
//
// Nothing here guesses. A step has a time limit when the platform enforces
// one (a reading turn, a plan, a build), which is the most it can take, not
// an estimate, and a record the bot cannot read is left out, not filled in.
// How long a step usually takes is a fixed range per step (typicalMinutes,
// #19), said as that and nothing finer.
//
// #3734: the DM's activity tray (homeroom-bot-tray.js) lists under Now what
// this module says is in flight (inFlight below), so the tray and the bot's
// own answer never disagree. They used to read it separately: the tray from
// claimed queue rows alone, so a build (whose queue row is gone) and a
// follow-up waiting its turn showed as nothing while the bot said otherwise.

const { changeHref } = require('./change-destination');
// #6528: the ready rule the bot's own ready card uses (checks passed and the
// before & after shots settled), one copy shared with the change machine.
const { heldUntil } = require('../workflow/rules/bot-readiness.ts');

// Lazy: the live module is large, and only the queue readers below need it.
function live() { return require('./homeroom-bot-live'); }

/**
 * #3734: the projects a queue row is the bot's own work on (live.appsScope),
 * whether or not it is switched on: that is said apart (botIsOn). Null when
 * there are no settings to read them from.
 */
function actsScope(settings) {
  return settings ? live().appsScope(settings) : null;
}

const MINUTE_MS = 60 * 1000;
// A ready verdict with no build session yet is a build starting. Past this,
// nothing about it is recorded, and that is what is said.
const START_GRACE_MS = 15 * MINUTE_MS;
// 3 Nov 2026 (#6228): how long a reply nobody has queued a read for still
// reads as waiting to be read. After it, a reply the bot does not pick up
// goes back to how the request was (Decide, Stopped), so a request does not
// say "reading" forever.
const REPLY_WAIT_MS = 2 * MINUTE_MS;

/**
 * #6228: the newest message a person wrote in a request's own thread after
 * the run that decided about it: what tells whether the bot has a reply
 * waiting to be read. `$`-free SQL, so progress and track can share one
 * definition: the aliases are the caller's (`m.app_id` in requestRows,
 * `a.id` in the track's read).
 */
function replyLateralSql({
  appId = 'm.app_id', issueNumber = 'm.issue_number', runAt = 'run.created_at',
} = {}) {
  return `LEFT JOIN LATERAL (
    SELECT cm.id AS reply_id, cm.created_at AS reply_at, cm.user_id AS reply_user_id
      FROM chat_messages cm
      JOIN users ru ON ru.id = cm.user_id
     WHERE cm.app_id = ${appId}
       AND cm.thread_type = 'issue'
       AND cm.thread_ref = ${issueNumber}
       AND cm.msg_type = 'message'
       AND cm.deleted_at IS NULL
       AND ru.is_synthetic IS NOT TRUE
       AND cm.created_at > ${runAt}
     ORDER BY cm.id DESC LIMIT 1
  ) reply ON TRUE`;
}

/**
 * #6246 (4 Nov 2026): a plan waiting for Build it, as `$`-free SQL that
 * returns the newest run's `awaiting_go_at` when the request's newest run
 * (newest by id, any mode) waits: live, ready, nothing built from it, not
 * held by a limit, on a request still open. Null otherwise. The aliases are
 * the caller's, as replyLateralSql's are, so the bot page (ai-work.js
 * FACTS_SQL) and anything else that asks the same question asks it one way.
 * planWaits below mirrors it field by field.
 */
function planWaitingSql({ appId = 'm.app_id', issueNumber = 'm.issue_number' } = {}) {
  return `(SELECT CASE WHEN run.mode = 'live' AND run.verdict = 'ready'
                    AND run.awaiting_go_at IS NOT NULL
                    AND run.live_build_waiting_at IS NULL
                    AND run.build_ok IS NULL
                    AND run.build_session_id IS NULL
                    AND run.proposal_session_id IS NULL
                    AND run.cap_suppressed IS NULL
                    AND NOT (COALESCE((SELECT ri.status = 'closed' FROM issues ri
                                        WHERE ri.app_id = ${appId} AND ri.github_issue_number = ${issueNumber}
                                        ORDER BY ri.id DESC LIMIT 1), FALSE)
                             OR EXISTS (SELECT 1 FROM homeroom_bot_closed_requests cr
                                         WHERE cr.app_id = ${appId} AND cr.issue_number = ${issueNumber}
                                           AND cr.closed_at IS NOT NULL))
                   THEN run.awaiting_go_at END
              FROM homeroom_bot_runs run
             WHERE run.app_id = ${appId} AND run.issue_number = ${issueNumber}
             ORDER BY run.id DESC LIMIT 1)`;
}

/**
 * Pure (#6246): whether a requestRows row is a plan waiting for Build it:
 * its newest run is live and ready with nothing built from it, the plan still
 * waits (plan_waiting_at), no build is queued or under way, no limit held it,
 * and the request is not closed. planWaitingSql is the same test in SQL.
 */
function planWaits(row) {
  return !!row && row.mode === 'live' && row.verdict === 'ready' && row.build_ok == null
    && !row.run_proposal && !!row.plan_waiting_at && !row.build_waiting_at
    && !row.build_session_id && !row.cap_suppressed && row.request_closed !== true;
}

/**
 * Pure (#6357): why a queue row is held and until when, or null when it is
 * not held (no held_until, or one already past): { kind, until }. `kind` is
 * `allowance` (its payer's building time for the week is used up, held
 * until the week resets) or `cooldown` (its look threw THROWN_TRIES times
 * in a row, held for a day: src/workflow/bot-request/machine.ts), as the
 * workflow recorded it (held_reason). A hold stored before that has no
 * reason, and is not guessed as the allowance: an allowance hold always ends
 * at the week's reset (limits.weeklyResetAt, Monday 00:00 UTC), so only a
 * hold ending exactly there is one, and any other is a cooldown.
 * HOLD_IS_ALLOWANCE_SQL is the same rule in SQL.
 */
function holdOf(row, { now = new Date() } = {}) {
  const until = row && row.held_until ? new Date(row.held_until) : null;
  if (!until || Number.isNaN(until.getTime()) || until.getTime() <= new Date(now).getTime()) return null;
  const said = row.held_reason === 'allowance' || row.held_reason === 'cooldown' ? row.held_reason : null;
  const weekBoundary = until.getUTCDay() === 1 && until.getUTCHours() === 0 && until.getUTCMinutes() === 0
    && until.getUTCSeconds() === 0 && until.getUTCMilliseconds() === 0;
  return { kind: said || (weekBoundary ? 'allowance' : 'cooldown'), until: until.toISOString() };
}

/**
 * holdOf's allowance, in SQL, for the queue row aliased `q`. Written out the
 * same in homeroom-bot-dm.js noteOverAllowance, whose query stays static.
 */
const HOLD_IS_ALLOWANCE_SQL = `(q.held_reason = 'allowance' OR (q.held_reason IS NULL
  AND q.held_until = date_trunc('week', q.held_until AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))`;

/**
 * Pure (#6228): whether a person's reply on a request is newer than the
 * bot's last look and still waiting to be read, from a requestRows row (with
 * the `reply` lateral). A read that has started, or a queue row not on hold,
 * is a read coming. Otherwise the reply only counts for REPLY_WAIT_MS: a
 * reply the refresh did not queue goes back to what it was.
 */
function replyWaits(row, { now = new Date() } = {}) {
  if (!row || !row.reply_at) return false;
  const at = new Date(row.reply_at).getTime();
  const runAt = row.run_at ? new Date(row.run_at).getTime() : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(runAt) || at <= runAt) return false;
  if (row.request_closed === true) return false;
  if (row.proposal_status === 'promoted' || row.proposal_status === 'merging') return false;
  if (row.started_at) return true;
  if (row.queue_id) {
    const held = row.held_until ? new Date(row.held_until) : null;
    if (held && !Number.isNaN(held.getTime()) && held > now) return false;
    return true;
  }
  return now.getTime() - at <= REPLY_WAIT_MS;
}
// What finished lately, for "is it ready yet?".
const FINISHED_WITHIN_DAYS = 14;
const MAX_FINISHED = 3;
const MAX_REQUESTS = 25;
// #3771: the bot's account, whose follow-ups run beside a project's other work.
const BOT_USERNAME = 'homeroom_bot';
// A live build older than this is not holding its project up any more (the
// longest one, a platform build's plan and build turn, is under two hours).
const BUSY_BUILD_HOURS = 4;
// How many of one project's builds run at once: BUILDS_PER_APP, or the
// project's own number (homeroom-bot.js appCapsOf). Lazy, as every read of
// that module here is.
function buildCapOf(settings, appId) {
  return require('./homeroom-bot').appCapsOf(settings, appId).building;
}

// #4053: a first version's steps are named for what is happening, never as
// an instruction: "Step 4 of 7: Build it" read to an invited member as if
// they were asked to build it (onboarding test, 6 October 2026). One story
// per request: a request's steps are named the same way, in the same words
// everywhere they are said (the card, the tray, the bot's answers).
const FIRST_VERSION_STEPS = Object.freeze([
  'Setting up', 'Reading', 'Planning', 'Building', 'Testing', 'Ready to try', 'Live',
]);
const REQUEST_STEPS = Object.freeze([
  'Reading', 'Planning', 'Building', 'Testing', 'Ready to try', 'Live',
]);

// Which step each stage is part of. A request's first step is "Read".
const STEP_OF_STAGE = Object.freeze({
  setting_up: 'setup',
  queued: 'read',
  on_hold: 'read',
  reading: 'read',
  question: 'read',
  // B6: a first version's plan, waiting for its creator's Build it.
  plan: 'plan',
  build_queued: 'plan',
  held: 'plan',
  starting: 'plan',
  planning: 'plan',
  stalled: 'plan',
  building: 'build',
  // A first version's screens reviewed and fixed (services/bot-review.js):
  // still building it, as far as its creator is concerned.
  reviewing: 'build',
  proposing: 'build',
  checks: 'checks',
  checks_failed: 'checks',
  fix_queued: 'checks',
  fixing: 'checks',
  followup_queued: 'vote',
  revising: 'vote',
  vote: 'vote',
  merging: 'vote',
});

// The stages in which the bot itself (or the setup it started) is doing
// something this minute, rather than waiting on the person, the group, the
// checks or its queue: what "working on now" means.
const BUSY_STAGES = new Set([
  'setting_up', 'reading', 'revising', 'fixing', 'starting', 'planning', 'building', 'reviewing', 'proposing', 'merging',
]);

// #3734: what the bot has in hand for the person: doing this minute, or in
// its queue to be done (a request to read, a follow-up on its proposal).
// Not what waits on them or the group, a proposal's checks running, or a
// build held back or stalled. The activity tray's Now is exactly this.
const IN_FLIGHT_STAGES = new Set([...BUSY_STAGES, 'queued', 'build_queued', 'followup_queued', 'fix_queued']);

// app-creation-phase.js PHASES, in words.
const SETUP_PARTS = Object.freeze({
  database: 'making its database',
  repository: 'making its code repository',
  build: 'building it for the first time',
  deploy: 'starting it up',
});

// B6: a first version's plan is the one its creator answers (stage 'plan').
// Once they tap Build it, the build's own plan being written, and its turn
// and workspace being waited for, are the build to them, not the plan again:
// "Step 3 of 7", "writing the plan for the build", read as if their Build it
// had not counted (first-session run-through, 5 October 2026). A request's
// steps are unchanged: its plan is the bot's own.
const FIRST_VERSION_BUILD_STAGES = new Set(['build_queued', 'starting', 'planning']);

const STEP_ORDER = Object.freeze(['setup', 'read', 'plan', 'build', 'checks', 'vote', 'live']);

function stepNumber(stage, firstVersion) {
  const key = firstVersion && FIRST_VERSION_BUILD_STAGES.has(stage) ? 'build' : STEP_OF_STAGE[stage];
  if (!key) return null;
  const at = STEP_ORDER.indexOf(key);
  return firstVersion ? at + 1 : at;
}

/**
 * #4053: the build line, one line at the foot of a project's thumbnail that
 * says where its first version is, the same way on every screen that draws
 * it (the made screen, the App tab, the hub). The browser holds the words
 * (frontend/src/features/first-session/build-line.tsx); the server says
 * which one, for the person reading:
 *
 *   planning     steps 1 to 3: set up, read, plan       everyone
 *   plan         its plan waits for Build it            the person who started it
 *   plan-member  the same                               everyone else
 *   question     it asked the person who started it     them
 *   building     step 4 (from Build it on)              everyone
 *   testing      step 5: its checks                     everyone
 *   ready        step 6: up for approval, to try        everyone
 *   live         step 7                                 everyone
 *   stopped      its build stopped, nothing live yet    everyone
 *
 * Step numbers stay in Homeroom bot's chat: the line never counts.
 *
 * `stopped` (14 Oct 2026, newcomer run eight, Club Votes): its first version
 * was built and could not be proposed, and the App tab had no first version
 * to say any more, so it showed the starter template running, with nothing
 * to say that anything had gone wrong. It is not a step: buildLineOf never
 * names it, and homeroom-bot-dm.js firstVersionState says it when
 * firstVersionStopped below does.
 */
const BUILD_LINE_STATES = Object.freeze(['planning', 'plan', 'plan-member', 'question', 'building', 'testing', 'ready', 'live', 'stopped']);

const BUILD_LINE_OF_STEP = Object.freeze({
  setup: 'planning', read: 'planning', plan: 'planning', build: 'building', checks: 'testing', vote: 'ready', live: 'live',
});

/**
 * Pure: the build line for a first version at `stage` (stageOf, or
 * 'setting_up'), read by its creator (`forCreator`) or anyone else.
 * `question` is a question the bot waits on the creator for. Null for a
 * stage that is no step.
 */
function buildLineOf(stage, { forCreator = false, question = false } = {}) {
  if (stage === 'plan') return forCreator ? 'plan' : 'plan-member';
  if (stage === 'question' && question && forCreator) return 'question';
  const key = FIRST_VERSION_BUILD_STAGES.has(stage) ? 'build' : STEP_OF_STAGE[stage];
  return (key && BUILD_LINE_OF_STEP[key]) || null;
}

// N4 (newcomer run four, 12-13 October 2026): every stage of a first
// version's build named for what is happening, with when it began, so a
// screen can say "Drawing the screens · 2 min so far". The build line
// (buildLineOf) still says `building` for all of them, which Live and the
// thumbnail's screens key on; this is the finer name its words come from
// (frontend/src/features/first-session/build-line-words.js PHASE_WORDS).
// Until this the spec turn, the build and each review round all read as
// "Building it", and the build agent's last phrase ("Adding the ballot
// bar") stayed up through 36 minutes of review.
//
//   starting   its build waits its turn and its workspace starts: no
//              spec turn yet, so nothing is drawn (run five, 13 Oct 2026:
//              "Drawing the screens" showed before the build was picked up)
//   drawing    its spec turn draws the screens (the first look is drawn
//              first: the spec saves its main screen before it writes the
//              rest, live.js FIRST_VERSION_SCREENS_FIRST)
//   writing    the spec turn writes the rest of the plan, once the first
//              look is drawn
//   building   the build turn
//   built      the build landed and its screens are captured for review
//   checking   a review round, `round` of `rounds`
//   testing    proposed, and its checks run (or are fixed)
const FIRST_VERSION_PHASES = Object.freeze(['starting', 'drawing', 'writing', 'building', 'built', 'checking', 'testing']);

/**
 * Pure: the phase of a first version whose plan is decided, from its stage
 * (stageOf), its request row (requestRows) and when its first look was
 * drawn: `{ key, since, round?, rounds? }`, or null for a stage before or
 * after the build (setting up, reading, the plan waiting, ready to try).
 */
function firstVersionPhase(state, row = {}, { firstLookAt = null } = {}) {
  const stage = state && state.stage;
  const since = (value) => iso(value);
  switch (stage) {
    case 'build_queued':
    case 'starting':
      return { key: 'starting', since: since(state.since || row.build_waiting_at || row.run_at) };
    case 'planning':
      return firstLookAt
        ? { key: 'writing', since: since(firstLookAt) }
        : { key: 'drawing', since: since(row.build_started_at || state.since) };
    case 'building':
      return { key: 'building', since: since(state.since) };
    case 'reviewing': {
      const rounds = Math.max(1, Number(row.review_max_rounds) || 1);
      const round = Math.min(Number(row.review_round) || 0, rounds);
      return round > 0
        ? { key: 'checking', since: since(row.review_started_at || state.since), round, rounds }
        : { key: 'built', since: since(row.review_started_at || state.since) };
    }
    case 'proposing':
    case 'checks':
    case 'checks_failed':
    case 'fix_queued':
    case 'fixing':
      return { key: 'testing', since: since(row.proposal_at || state.since) };
    default:
      return null;
  }
}

// The App tab's step list (N4), in order, by key: Plan written, Screens
// drawn, Building, Checking the screens, Testing, Live (the words are the
// browser's: build-line-words.js STEP_WORDS).
const FIRST_VERSION_STEP_KEYS = Object.freeze(['plan', 'screens', 'build', 'check', 'test', 'live']);

const PHASE_STEP = Object.freeze({
  starting: 'screens', drawing: 'screens', writing: 'build', building: 'build', built: 'check', checking: 'check', testing: 'test',
  // Run five (13 Oct 2026, fix 7): merged and not live yet (stage
  // 'merging'). Never a phase a screen names: only the step list's place,
  // so every step before Live stays done while it goes live.
  live: 'live',
});

/** The step list's place while a first version goes live (firstVersionSteps). */
const GOING_LIVE = Object.freeze({ key: 'live', since: null });

/**
 * Pure: the App tab's step list for a first version still on its way:
 * one row per FIRST_VERSION_STEP_KEYS, `state` 'done', 'now', 'next' or
 * 'skipped' (no review ran: the row is left out). A done row carries the
 * whole minutes it took when both its ends are known; the row being worked
 * on carries when it began (`since`), which the browser counts on from.
 * `times` are when things happened: `made` (Make it), `decided` (its plan
 * went ahead), `firstLook`, `spec` (the plan for the build posted),
 * `review` (the review began) and `proposal`. `phase` is firstVersionPhase,
 * null while the plan is not decided yet, or GOING_LIVE once it merged and
 * is not live yet: every step before Live done, Live under way.
 */
function firstVersionSteps(phase, times = {}) {
  const at = phase ? FIRST_VERSION_STEP_KEYS.indexOf(PHASE_STEP[phase.key]) : 0;
  const t = (value) => {
    const ms = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  const screensEnd = t(times.firstLook) ?? t(times.spec);
  const bounds = {
    plan: [t(times.made), t(times.decided)],
    screens: [t(times.decided), screensEnd],
    build: [screensEnd, t(times.review) ?? t(times.proposal)],
    check: [t(times.review), t(times.proposal)],
    test: [t(times.proposal), null],
    live: [null, null],
  };
  return FIRST_VERSION_STEP_KEYS.map((key, i) => {
    if (i < at) {
      if (key === 'check' && !times.review) return { key, state: 'skipped' };
      const [from, to] = bounds[key];
      const minutes = from != null && to != null && to >= from ? Math.floor((to - from) / MINUTE_MS) : null;
      return { key, state: 'done', ...(minutes != null ? { minutes } : {}) };
    }
    if (i === at) {
      // From when the step began, else from when its phase did.
      const since = bounds[key][0] ?? t(phase?.since);
      return { key, state: 'now', ...(since != null ? { since: new Date(since).toISOString() } : {}) };
    }
    return { key, state: 'next' };
  });
}

function iso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function minutesSince(value, now) {
  if (!value) return null;
  const ms = now.getTime() - new Date(value).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / MINUTE_MS)) : null;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Pure: a proposal's checks, in plain words, from its columns. */
function checksWords({ check_state: state, check_phase: phase, checks_progress: progress, failed_checks: failedChecks }) {
  if (state === 'passing') return 'passed';
  if (state === 'skipped') return 'not needed for this change';
  if (state === 'failing') {
    const n = Number(failedChecks);
    return Number.isInteger(n) && n > 0 ? `failed (${plural(n, 'test')} did not pass)` : 'failed';
  }
  if (state === 'error' || state === 'unknown') return 'could not run (the preview or the test run broke)';
  if (state === 'pending' || state === 'running') {
    if (phase === 'building') return 'running: building the preview first';
    const p = progress && typeof progress === 'object' ? progress : {};
    if (phase === 'queued') {
      const ahead = Number(p.queue && p.queue.ahead);
      return Number.isInteger(ahead) && ahead > 0
        ? `waiting for a checks slot (${ahead} ahead)`
        : 'waiting for a checks slot';
    }
    const ran = Number(p.ran);
    const expected = Number(p.expected);
    const failed = Number(p.failed) || 0;
    if (Number.isInteger(ran) && Number.isInteger(expected) && expected > 0) {
      return `running: ${ran} of ${expected} done, ${failed} failed so far`;
    }
    return 'running';
  }
  return 'not run yet';
}

/** Pure: how many checks did not pass, from a proposal's test_results. */
function failedCount(results) {
  if (!Array.isArray(results)) return null;
  return results.filter((t) => t && t.status && t.status !== 'pass').length;
}

function links(domain, { slug, number = null, proposal = null, pr = null }) {
  if (!domain || !slug) return {};
  const base = `https://${domain}/#app/${encodeURIComponent(slug)}`;
  return {
    project: base,
    ...(number ? { request: `${base}/dev/issues/${Number(number)}` } : {}),
    // #4367: a change with a pull request goes by its number.
    ...(proposal ? { proposal: `https://${domain}/${changeHref(slug, proposal, pr)}` } : {}),
  };
}

/**
 * Pure (#8, WP3): whether a request's queue row is left over from before its
 * proposal merged: put there before the merge (a reply, a look again), and
 * moot once it went live. It read as "waiting in the queue" in the DM's
 * header long after. A row put there after the merge is new work.
 */
function leftOverQueue(row) {
  if (row.proposal_status !== 'merged' || !row.queue_id || !row.merged_at) return false;
  // B24 (audit 2 Nov 2026): nor is any row on a request that closed with its
  // change live: the bot reads open requests only, so nothing comes of it.
  // A live request's row read "Reading the request" under its "It's live".
  if (row.request_closed === true) return true;
  const ms = (value) => (value instanceof Date ? value.getTime() : Date.parse(value || ''));
  const queued = ms(row.enqueued_at || row.started_at);
  const merged = ms(row.merged_at);
  return Number.isFinite(queued) && Number.isFinite(merged) && queued <= merged;
}

/**
 * Pure (N5): whether a proposal's check verdict is about the head up for
 * approval: its reviewed head (an imported pull request's own head), from a
 * requestRows row. True when either is not recorded, as before this was
 * read. The merge queue asks the same (src/workflow/merge-queue/facts.ts).
 */
function checksOnHead(row) {
  const head = row?.proposal_source === 'imported' ? row?.imported_pr_head_sha : row?.reviewed_head_sha;
  const checked = row?.checks_sha;
  if (typeof head !== 'string' || !head || typeof checked !== 'string' || !checked) return true;
  return head.toLowerCase() === checked.toLowerCase();
}

/**
 * #6521: checksOnHead for a change as the change page's own rows carry it
 * (routes/votes.js /promoted and /proposals/:id, whose columns are `source`
 * and `checks_commit_sha`), so the page, the thread list (stageOf) and the
 * merge gate read one rule instead of the page believing a stale pass.
 */
function sessionChecksOnHead(session) {
  if (!session) return true;
  return checksOnHead({
    proposal_source: session.source,
    imported_pr_head_sha: session.imported_pr_head_sha,
    reviewed_head_sha: session.reviewed_head_sha,
    checks_sha: session.checks_commit_sha,
  });
}

// N5: a proposal's stages on the vote step that are not ready to try: a
// follow-up waiting its turn or running changes the change.
const FOLLOW_UP_STAGES = new Set(['followup_queued', 'revising']);

// #6282 (4 Nov 2026): a change with an update on its way asks for no vote: a
// yes cast now is cleared when the update lands, and Homeroom asks again.
// These two windows are the ones the bot's own records already use, so an
// ask that has stopped holding the bot (homeroom-bot-voice.js takeAsks puts a
// taken ask older than STALE_ASK_HOURS back to queued) stops holding the
// vote too, and a queued ask past the sweep's week is not an update any more.
const UPDATE_TAKEN_HOURS = 3; // = homeroom-bot-voice.js STALE_ASK_HOURS
const UPDATE_QUEUED_DAYS = 7; // = homeroom-bot.js sweepStrandedAsks' window
// #6348 (5 Nov 2026): the longest a turn may run (src/workflow/turn/machine.ts
// MAX_TURN_MS). A turn marker older than this is one whose process died
// without releasing it, and it is no update on its way.
const UPDATE_TURN_HOURS = 6; // = src/workflow/turn/machine.ts MAX_TURN_MS

/**
 * #6348: an ask holds the vote only while its change is still on the version
 * the ask was made against. `asked_head_sha` is recorded when the ask is
 * queued (homeroom-bot-voice.js recordAsk); NULL for asks made before the
 * column existed, which keep the time windows alone. A NULL current head
 * keeps holding, as it did before the head was compared at all. `$`-free
 * SQL; `uk` is a homeroom_bot_change_asks alias and `cs` a chat_sessions one.
 */
function askOnHeadSql(uk, cs) {
  return `(${uk}.asked_head_sha IS NULL
           OR lower(${uk}.asked_head_sha) = lower(COALESCE(CASE WHEN ${cs}.source = 'imported'
                                                               THEN ${cs}.imported_pr_head_sha
                                                               ELSE ${cs}.reviewed_head_sha END,
                                                            ${uk}.asked_head_sha)))`;
}

/**
 * #6282: whether an update to a change (`cs`, a chat_sessions alias) is on
 * its way, as `$`-free SQL: 'running' while a fresh turn is in flight on it,
 * or the bot holds a fresh taken ask; 'queued' while an ask waits its turn,
 * and the change is still on the version the ask was made against (#6348);
 * NULL when no update is coming. It reads the bot's own records
 * (homeroom_bot_change_asks) and the durable turn marker
 * (chat_sessions.active_turn), so nothing new is stored.
 *
 * Read by the Needs you feed (routes/workshop-overview.js
 * OWED_PROPOSALS_WHERE), the AI tab (ai-work.js THREADS_SQL) and the
 * change's own proposal row (routes/votes.js), so all three agree.
 */
function updateComingSql(cs) {
  return `(CASE
    WHEN (${cs}.active_turn IS NOT NULL
          AND (${cs}.active_turn->>'startedAt' IS NULL
               OR (${cs}.active_turn->>'startedAt')::timestamptz > NOW() - make_interval(hours => ${UPDATE_TURN_HOURS})))
      OR EXISTS (SELECT 1 FROM homeroom_bot_change_asks uk
                  WHERE uk.session_id = ${cs}.id AND uk.status = 'taken'
                    AND uk.taken_at > NOW() - make_interval(hours => ${UPDATE_TAKEN_HOURS})
                    AND ${askOnHeadSql('uk', cs)})
      THEN 'running'
    WHEN EXISTS (SELECT 1 FROM homeroom_bot_change_asks uk
                  WHERE uk.session_id = ${cs}.id AND uk.status = 'queued'
                    AND uk.created_at > NOW() - make_interval(days => ${UPDATE_QUEUED_DAYS})
                    AND ${askOnHeadSql('uk', cs)})
      THEN 'queued' END)`;
}

/**
 * #6282: what the update on its way changes, for "Updating: …": the newest
 * fresh taken ask's instruction, else the newest queued one's, or NULL when
 * the turn has nobody's ask behind it. #6348: it names only an ask that
 * holds, so "Updating: …" and the hold never disagree. `$`-free SQL; `cs` is
 * a chat_sessions alias, as updateComingSql's is.
 */
function updateAskSql(cs) {
  return `(SELECT uk.instruction
             FROM homeroom_bot_change_asks uk
            WHERE uk.session_id = ${cs}.id
              AND ((uk.status = 'taken'
                    AND uk.taken_at > NOW() - make_interval(hours => ${UPDATE_TAKEN_HOURS}))
                OR (uk.status = 'queued'
                    AND uk.created_at > NOW() - make_interval(days => ${UPDATE_QUEUED_DAYS})))
              AND ${askOnHeadSql('uk', cs)}
            ORDER BY CASE uk.status WHEN 'taken' THEN 0 ELSE 1 END, uk.id DESC
            LIMIT 1)`;
}

/**
 * Pure (N5): the stage a first version's App tab is drawn at, from its
 * stage (stageOf) and whether it is ready to try (`ready`:
 * homeroom-bot-dm.changeReadiness, the rule its ready card goes out on: its
 * checks passed on its head and its before & after shots settled). Ready to
 * try ('vote') only then; a vote that is not ready yet, and a follow-up
 * queued or running on it, are its checks ('checks': Testing it). Any other
 * stage is itself.
 */
function firstVersionStage(stage, { ready = false } = {}) {
  if (stage === 'vote') return ready ? 'vote' : 'checks';
  if (FOLLOW_UP_STAGES.has(stage)) return 'checks';
  return stage;
}

/**
 * Pure: the stage of one of the person's requests, from one row of
 * requestRows below, or null when nothing about it is in progress.
 * `{ stage, since, doing, waitingOn?, limit? }`, where `limit` names which
 * clock applies ('reading', 'plan' or 'build').
 */
function stageOf(input, { now = new Date() } = {}) {
  const row = leftOverQueue(input) ? { ...input, queue_id: null, started_at: null, enqueued_at: null, queue_reason: null } : input;
  const proposalOpen = row.proposal_status === 'promoted' || row.proposal_status === 'merging';
  // #4539: the request itself was closed. Its waiting plan and the open
  // question about it no longer wait on the person, and a build not started
  // yet reads as not in progress; a proposal still open shows its own state.
  const closed = row.request_closed === true;
  const it = row.first_version ? 'the description' : 'the request';
  if (proposalOpen) {
    if (row.started_at) {
      return row.queue_reason === 'checks_failing'
        ? { stage: 'fixing', since: row.started_at, doing: 'fixing what its tests found' }
        : { stage: 'revising', since: row.started_at, doing: 'reading the newest replies on the change' };
    }
    // #3734: a follow-up waiting its turn (a reply on the proposal, a change
    // asked for in the DM, its own failing checks). Only while it is up for
    // a vote: the loop does not follow up on a proposal being merged.
    if (row.queue_id && row.proposal_status === 'promoted') {
      return row.queue_reason === 'checks_failing'
        ? { stage: 'fix_queued', since: row.enqueued_at, doing: 'waiting for a free builder to fix what its tests found' }
        : { stage: 'followup_queued', since: row.enqueued_at, doing: 'waiting for a free builder to follow up on the newest replies on the change' };
    }
    if (row.question_at && !closed) {
      return { stage: 'question', since: row.question_at, doing: 'waiting for an answer to the question asked', waitingOn: 'them' };
    }
    if (row.proposal_status === 'merging') {
      return { stage: 'merging', since: null, doing: 'approved; making it live now' };
    }
    // N5: a verdict about another commit than the one up for approval says
    // nothing about it: its own checks are still to come (Club Votes, 12
    // October 2026, read "Ready to try" off a pass of a fix the restart
    // recovery had rolled back, and its own head then failed).
    if (!checksOnHead(row)) {
      const checks = checksWords({ ...row, check_state: 'pending', check_phase: null });
      return { stage: 'checks', since: row.checks_at || row.proposal_at, doing: `it's waiting for approval, and its tests are ${checks}` };
    }
    const checks = checksWords({ ...row, failed_checks: row.failed_checks ?? failedCount(row.test_results) });
    // 13 Oct 2026, D1: a project's first version goes live without a vote
    // once its tests pass (governance-gate.ts applyFirstVersion), so it
    // waits on nobody's approval.
    const first = row.first_version === true;
    if (row.check_state === 'passing' || row.check_state === 'skipped') {
      if (first) {
        return { stage: 'vote', since: row.proposal_at, doing: 'its tests passed, and as the project\'s first version it goes live without a vote in a minute or two' };
      }
      // #6528: its tests passed but its before & after shots are still being
      // taken: it reads as checking, so the "Ready to try" bell (and the
      // ready card) waits until the pictures are there. The rule is the
      // bot's own readiness (bot-readiness.ts heldUntil), with its 45-minute
      // lapse when no settle ever comes; a change with nothing visible to
      // shoot is not held.
      const head = (row.proposal_source === 'imported' ? row.imported_pr_head_sha : row.reviewed_head_sha) || row.checks_sha;
      const held = heldUntil({
        shots_state: row.shots_state,
        shots_run_id: row.shots_run_id,
        shots_detail: row.shots_detail,
        shots_updated_at: row.shots_updated_at,
        checks_checked_at: row.checks_at,
      }, head, now.getTime());
      if (held != null) {
        return {
          stage: 'checks', since: row.checks_at || row.proposal_at,
          doing: 'it\'s waiting for approval, and its tests passed; its before and after shots are still being taken',
        };
      }
      return { stage: 'vote', since: row.proposal_at, doing: 'it\'s waiting for approval', waitingOn: 'the group' };
    }
    const waiting = first ? 'it goes live without a vote once its tests pass' : 'it\'s waiting for approval';
    // #6284: the bot stopped at its own limit on failing checks. Needs you
    // says so, with Let it try again, rather than reading as still checking.
    if (row.fix_stopped === true && (row.check_state === 'failing' || row.check_state === 'error' || row.check_state === 'unknown')) {
      return { stage: 'fix_stopped', since: row.checks_at || row.proposal_at, doing: 'its checks are failing, and Homeroom bot stopped fixing them', waitingOn: 'them' };
    }
    if (row.check_state === 'failing' || row.check_state === 'error' || row.check_state === 'unknown') {
      return { stage: 'checks_failed', since: row.checks_at || row.proposal_at, doing: `${waiting}, and its tests ${checks}` };
    }
    return { stage: 'checks', since: row.checks_at || row.proposal_at, doing: `${waiting}, and its tests are ${checks}` };
  }
  // #6246 (4 Nov 2026): a plan waiting for Build it is what the person acts
  // on now, so it stays the plan whatever sits beside it: a reply the bot is
  // reading, a queue row on hold, or a question left open from before the
  // look that made it (#6219: asked before that run started, like a note
  // from a pass the day's limit held). A question the plan's own look asked
  // still wins. The Workshop reads the same wait (planWaitingSql).
  if (planWaits(row)) {
    const olderQuestion = !!row.question_at && !!row.run_at && new Date(row.question_at) < new Date(row.run_at);
    if (row.question_at && !olderQuestion) {
      return { stage: 'question', since: row.question_at, doing: 'waiting for an answer to the question asked', waitingOn: 'them' };
    }
    return {
      stage: 'plan', since: row.plan_waiting_at, waitingOn: 'them',
      doing: 'the plan is ready and waits for Build it',
    };
  }
  if (row.started_at) {
    // #6228: a read under way after a person replied is reading that reply.
    if (replyWaits(row, { now })) {
      return { stage: 'reading', reply: true, since: row.started_at, doing: 'reading the new reply', limit: 'reading' };
    }
    return { stage: 'reading', since: row.started_at, doing: `reading ${it} to decide whether to ask a question or build it`, limit: 'reading' };
  }
  if (row.question_at && !closed) {
    return { stage: 'question', since: row.question_at, doing: 'waiting for an answer to the question asked', waitingOn: 'them' };
  }
  // The newest look decided to build it, and nothing has finished it yet.
  if (row.mode === 'live' && row.verdict === 'ready' && row.build_ok == null && !row.run_proposal) {
    // #4539, 30 Oct 2026: on a closed request nothing waits to be built any
    // more. The bot's refresh reads open requests only, so a build held back
    // by a limit, a plan waiting for Build it, or one waiting its turn never
    // starts; it reads as not built because the request was closed
    // (outcomeOf). Main said "held back" of four closed requests while the
    // bot tab rightly left them out. A build already under way builds on.
    if (closed && !row.build_session_id) return null;
    if (row.cap_suppressed) {
      return {
        stage: 'held',
        since: row.run_at,
        // #6156: the project's builds are a limit of their own, freed by a
        // build finishing rather than by a vote. Its changes waiting for
        // approval and the bot's ceiling across projects are the others
        // (homeroom-bot.js SLOT_CAPS).
        doing: row.cap_suppressed === 'builds_per_app'
          ? 'ready to build, but waiting for its turn: the bot is already building as many changes on this project as it may at once'
          : 'ready to build, but held back until one of the changes waiting for approval goes live or is closed (only so many may wait at once)',
      };
    }
    // B6: a first version's plan, sent to its creator, waits for Build it.
    // Not on a closed request (above).
    if (row.plan_waiting_at && !row.build_waiting_at && !row.build_session_id) {
      return {
        stage: 'plan', since: row.plan_waiting_at, waitingOn: 'them',
        doing: 'the plan is ready and waits for Build it',
      };
    }
    // Built after the turn that read it, up to the project's build number
    // per project at once (homeroom-bot.js appCapsOf): waiting its turn
    // until its build starts.
    if (row.build_waiting_at && !row.build_session_id) {
      return { stage: 'build_queued', since: row.build_waiting_at, doing: 'ready to build; waiting its turn to be built' };
    }
    if (!row.build_session_id) {
      if (now.getTime() - new Date(row.run_at).getTime() <= START_GRACE_MS) {
        return { stage: 'starting', since: row.run_at, doing: 'starting a workspace to build it in' };
      }
      return { stage: 'stalled', since: row.run_at, doing: 'it was found ready to build, but nothing about the build has been recorded since' };
    }
    if (row.build_status === 'archived') return null;
    // A first version whose build landed and whose screens are being
    // reviewed and fixed before it is proposed (services/bot-review.js).
    if (row.review_state === 'reviewing') {
      const of = Math.max(1, Number(row.review_max_rounds) || 1);
      const round = Math.max(1, Math.min(Number(row.review_round) || 1, of));
      return {
        stage: 'reviewing',
        since: row.review_started_at || row.build_last_activity || null,
        doing: `reviewing the screens (round ${round} of ${of}) and fixing what the review finds`,
        limit: 'review',
      };
    }
    if (row.build_status === 'paused' || row.build_status === 'promoted') {
      return { stage: 'proposing', since: row.build_last_activity || null, doing: 'the build finished; getting it ready to try now' };
    }
    // Building once its plan is posted, or once the build turn itself runs
    // (a plan that failed is not posted, and the build goes ahead without).
    if (row.spec_at || row.build_turn_mode === 'build') {
      return { stage: 'building', since: row.spec_at || row.build_turn_at || row.build_started_at, doing: 'building it', limit: 'build' };
    }
    return { stage: 'planning', since: row.build_started_at || row.run_at, doing: 'writing the plan for the build', limit: 'plan' };
  }
  if (row.queue_id) {
    // One story: held until the week resets, because its payer's building
    // time is used up (homeroom-bot.js runTriage): On hold until Monday.
    // #6357: or held for a day after its look threw again and again, which
    // is no money at all: paused, and tried again then.
    const hold = holdOf(row, { now });
    if (hold && hold.kind === 'cooldown') {
      return {
        stage: 'on_hold', hold: 'cooldown', until: hold.until, since: row.enqueued_at, waitingOn: 'time',
        doing: `paused after repeated errors: trying again at ${hold.until.slice(0, 16).replace('T', ' ')} UTC`,
      };
    }
    if (hold) {
      return {
        stage: 'on_hold', until: hold.until, since: row.enqueued_at, waitingOn: 'time',
        doing: 'on hold until Monday: this week\'s building time is used up',
      };
    }
    // Not its number in the queue: that counts every project's requests, and
    // the per-project and per-person limits decide more (queuedWait).
    // #6228: a reply waiting for the read the bot has queued reads as that
    // read about to happen, not as a request waiting its turn.
    if (replyWaits(row, { now })) {
      return { stage: 'reading', reply: true, waiting: true, since: row.reply_at, doing: 'reading the new reply in a moment' };
    }
    return { stage: 'queued', since: row.enqueued_at, doing: 'waiting for a free builder',
      ...(planFailed(row) ? { retry: 'plan' } : {}) };
  }
  // #6228: a reply nobody has queued a read for yet still reads as one
  // coming, for REPLY_WAIT_MS: the bot's refresh sees it and queues it.
  if (replyWaits(row, { now })) {
    return { stage: 'reading', reply: true, waiting: true, since: row.reply_at, doing: 'reading the new reply in a moment' };
  }
  return null;
}

/**
 * Pure (#6313): whether a request's newest look could not write its plan
 * (homeroom-bot-live.js buildAndPropose: "no plan could be written (…)", the
 * spec turn's final message "only part of a spec"). Nothing was built; the
 * request is queued for another read, which is a retry of the plan.
 */
function planFailed(row) {
  return row?.build_ok === false
    && /no plan could be written|only part of a spec/.test(String(row.build_error || ''));
}

/**
 * Pure (14 Oct 2026, newcomer run eight): whether a first version's build
 * stopped, from its request row (requestRows) while nothing about it is in
 * progress (stageOf answered null): its newest look went ahead to build it
 * and the build came to nothing (build_ok false: it did not finish, or it
 * was built and not proposed), on a request still open, with no proposal of
 * it up or merged. Not a build stopped as a skip (its request was answered
 * or closed meanwhile) nor one found impossible as written (`blocked:`,
 * which asks its maker for detail instead). Homeroom bot said it stopped,
 * with Try again, in the build's thread.
 */
function firstVersionStopped(row) {
  if (!row || row.mode !== 'live' || row.verdict !== 'ready' || row.build_ok !== false) return false;
  if (row.request_closed === true) return false;
  if (['promoted', 'merging', 'merged'].includes(row.proposal_status)) return false;
  return !/^(?:skipped|blocked):/.test(String(row.build_error || ''));
}

/**
 * Pure (30 Oct 2026): a request Homeroom bot looked at and handed back to
 * the person, from its row (requestRows) while nothing about it is in
 * progress (stageOf answered null), or null. 'decide' when its newest look
 * left it for a person to decide (verdict 'person', the Go ahead its DM
 * offers); 'already_works' when that look found the ask already there (its
 * `done` tag, #6306), which only waits to be closed; 'build_stopped' when
 * the build came to nothing as firstVersionStopped tells it, which reads no
 * first-version field (the Try again its DM offers). Only on a request still
 * open with no change of it up or merged. Nothing moves on either until
 * somebody does something, so the Homeroom bot tab lists them under Needs
 * you (services/ai-work.js botStages), where they read "Nobody is building
 * it yet" before.
 */
function handedBack(row) {
  if (!row || row.mode !== 'live' || row.request_closed === true) return null;
  if (['promoted', 'merging', 'merged'].includes(row.proposal_status)) return null;
  if ((row.verdict === 'person' || row.verdict === 'empty') && row.run_already_done === true) return 'already_works';
  if (row.verdict === 'person') return 'decide';
  return firstVersionStopped(row) ? 'build_stopped' : null;
}

/** Pure: what a request that is not in progress came to, or null. */
function outcomeOf(row) {
  if (row.proposal_status === 'merged') return 'approved and live';
  if (row.proposal_status === 'closed') return 'the change was closed without going live';
  if (row.mode !== 'live') return null;
  // #4539: the request was closed while it was still to be built (its plan
  // waited for Build it, a limit held it back, or it waited its turn): it
  // was not built because the request was closed.
  if (row.request_closed === true && row.verdict === 'ready' && row.build_ok == null
    && !row.run_proposal && !row.build_session_id) {
    return 'not built: the request was closed';
  }
  if (row.build_ok === false && /^skipped:/.test(String(row.build_error || ''))) {
    return `not built: ${String(row.build_error).replace(/^skipped:\s*/, '').slice(0, 200)}`;
  }
  if (row.build_ok === false) return `the build did not succeed${row.build_error ? `: ${String(row.build_error).slice(0, 200)}` : ''}`;
  switch (row.verdict) {
    case 'person': return 'left for the group to decide';
    case 'empty': return 'nothing to build was found in it';
    case 'failed': return 'the last look at it failed';
    default: return null;
  }
}

/** The time limits of the steps that have one, in minutes, for this request. */
function limitsFor(row, { settings, config, botSvc }) {
  try {
    const turnSeconds = Number(settings?.turnSeconds) || botSvc.DEFAULTS.turnSeconds;
    const budgets = botSvc.buildBudgets({ repo_url: row.repo_url }, config || {}, turnSeconds * 1000, {
      firstVersion: !!row.first_version,
    });
    return {
      reading: Math.round(turnSeconds / 60),
      plan: Math.round(budgets.specBudgetMs / MINUTE_MS),
      build: Math.round(budgets.turnBudgetMs / MINUTE_MS),
      ...(Number(row.review_minutes) > 0 ? { review: Number(row.review_minutes) } : {}),
    };
  } catch {
    return {};
  }
}

// #19 (WP3, D5): how long each step usually takes, in minutes, by stage: a
// fixed range for now, to be read from recent runs later. "How long will it
// take?" is answered with this. A step's time limit is the most it can take
// before it is stopped, and a reply that quoted it as the wait ("about 40
// minutes") was answering a different question.
const TYPICAL_MINUTES = Object.freeze({
  setting_up: Object.freeze([2, 6]),
  reading: Object.freeze([1, 3]),
  starting: Object.freeze([1, 5]),
  planning: Object.freeze([3, 8]),
  building: Object.freeze([10, 25]),
  reviewing: Object.freeze([5, 25]),
  proposing: Object.freeze([1, 3]),
  checks: Object.freeze([5, 20]),
  revising: Object.freeze([5, 20]),
  fixing: Object.freeze([5, 20]),
});

/**
 * Pure: how long a stage's step usually takes, `{ from, to }` in minutes, or
 * null for a stage that waits on somebody (a queue, a question, the vote)
 * rather than takes a while. Never past the step's time limit.
 */
function typicalMinutes(stage, limit = null) {
  const range = TYPICAL_MINUTES[stage];
  if (!range) return null;
  const to = Number.isFinite(limit) && limit > 0 ? Math.min(range[1], limit) : range[1];
  return { from: Math.min(range[0], to), to };
}

/**
 * #6234: where Homeroom bot's own fix of a change's failing checks stands,
 * for the change's Testing card (AppView._changeTestingView), which said
 * "Its author needs to fix this" while the author, the bot, was fixing it.
 * Null unless the change is the bot's, up for a vote and failing its checks
 * now; then, in order:
 *   { state: 'fixing', since, reason }   its request's checks_failing queue
 *                                        row has started (reason 'retry'
 *                                        when this head's fix ran out of
 *                                        time once, homeroom-bot.js
 *                                        checksRetried; else null)
 *   { state: 'queued', since }           that row waits its turn
 *   { state: 'platform' }                #6388: the failing checks on this
 *                                        head all look like the platform's
 *                                        (a preview that did not answer), so
 *                                        the bot leaves them to Homeroom's
 *                                        preview and its re-run
 *   { state: 'handed_off' }              its newest run on this head gave it
 *                                        to a person (verdict person or
 *                                        failed)
 *   { state: 'stopped', tries, canTryAgain, head }
 *                                        #6284: it stopped at its own limit of
 *                                        3 fixes, and the requester, an admin
 *                                        or an admin may let it try once more
 *   null                                 nothing of the bot's is recorded
 * A read that fails is null: the card keeps its usual words. The queue is
 * keyed by request; the change reaches it through linked_issues.
 */
async function changeBotFix(pool, sessionId, { viewer = null } = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const { rows } = await pool.query(
      `SELECT cs.app_id, cs.status, cs.check_state, cs.checks_commit_sha, cs.reviewed_head_sha,
              cs.linked_issues, cs.test_results, u.username
         FROM chat_sessions cs
         JOIN users u ON u.id = cs.user_id
        WHERE cs.id = $1`,
      [id],
    );
    const cs = rows[0];
    if (!cs || cs.username !== BOT_USERNAME || cs.status !== 'promoted' || cs.check_state !== 'failing') return null;
    const issues = (Array.isArray(cs.linked_issues) ? cs.linked_issues : []).map(Number).filter(Number.isInteger);
    if (issues.length) {
      const queued = await pool.query(
        `SELECT started_at, enqueued_at FROM homeroom_bot_queue
          WHERE app_id = $1 AND issue_number = ANY($2::int[]) AND reason = $3
          ORDER BY started_at DESC NULLS LAST, enqueued_at ASC
          LIMIT 1`,
        [cs.app_id, issues, 'checks_failing'],
      );
      const row = queued.rows[0];
      if (row && row.started_at) {
        const retried = await require('./homeroom-bot').checksRetried(pool, id, cs.reviewed_head_sha);
        return { state: 'fixing', since: row.started_at, reason: retried ? 'retry' : null };
      }
      if (row) return { state: 'queued', since: row.enqueued_at, reason: null };
    }
    const head = String(cs.reviewed_head_sha || '').toLowerCase();
    if (!head) return null;
    // #6388: the checks that failed on the head up for a vote look like the
    // platform's own trouble (a preview that never answered), which the bot
    // already chose not to revise for (homeroom-bot.js oweChecksFix). The
    // card says so instead of falling through to "Its author needs to fix
    // this", which its requester read as being about them.
    if (String(cs.checks_commit_sha || '').toLowerCase() === head) {
      const followup = require('./homeroom-bot-followup');
      const { failing, total } = followup.failingChecks(cs.test_results);
      if (followup.checksLookLikeInfra({ failing, total })) return { state: 'platform', since: null, reason: null };
    }
    const runs = await pool.query(
      `SELECT id, limit_stop FROM homeroom_bot_runs
        WHERE proposal_session_id = $1 AND LOWER(checks_head_sha) = $2 AND verdict IN ('person', 'failed')
        ORDER BY id DESC
        LIMIT 1`,
      [id, head],
    );
    if (!runs.rows.length) return null;
    const run = runs.rows[0];
    if (run.limit_stop !== 'own_revisions') return { state: 'handed_off', since: null, reason: null };
    // #6284: stopped at its own limit. An open grant means a round is
    // already waiting or running for this stop.
    const counts = await require('./homeroom-bot-followup').revisionCounts(pool, id);
    if (counts.openGrant) return { state: 'queued', since: null, reason: null };
    const canTryAgain = viewer
      ? await require('./homeroom-bot-retry-grants').mayGrant(pool, { sessionId: id, user: viewer }).catch(() => false)
      : false;
    return {
      state: 'stopped', since: null, reason: null, head,
      tries: counts.own + counts.grants,
      canTryAgain,
    };
  } catch {
    return null;
  }
}

/**
 * #6280 (4 Nov 2026): whether a request is closed, as `$`-free SQL the
 * caller's aliases name. The newest issue row by id (issues is not unique on
 * (app_id, github_issue_number), so a join could duplicate rows); null: no
 * mirrored issue, or a first version before its request is filed. Null reads
 * as not closed, unless the bot recorded its close (a request with no row of
 * ours: homeroom-bot-closed-requests.js recordClosed). The bot page's rows
 * and a request's track read it one way.
 */
function requestClosedSql({ appId = 'm.app_id', issueNumber = 'm.issue_number' } = {}) {
  return `(COALESCE((SELECT ri.status = 'closed' FROM issues ri
                      WHERE ri.app_id = ${appId} AND ri.github_issue_number = ${issueNumber}
                      ORDER BY ri.id DESC LIMIT 1), FALSE)
             OR EXISTS (SELECT 1 FROM homeroom_bot_closed_requests cr
                         WHERE cr.app_id = ${appId} AND cr.issue_number = ${issueNumber} AND cr.closed_at IS NOT NULL))`;
}

/**
 * #6280 (4 Nov 2026): the records one request's row is read from, as
 * `$`-free SQL the caller's aliases name: its queue row, its newest LIVE run
 * (the one stageOf reads: a shadow build's newer run is not this request's
 * stage), the build session that run started, its newest plan post, its
 * newest proposal and change, the newest reply after that run, and an open
 * question about it. The bot page (requestRows below) and a request's own
 * track (homeroom-bot-track.js REQUEST_ROWS_SQL) read one source, so their
 * stages cannot disagree. `userIdSql` narrows the open question to one
 * person's (the bot page's); left out, any open question counts (a track).
 */
function requestRecordJoinsSql({ appId = 'm.app_id', issueNumber = 'm.issue_number', userIdSql = null } = {}) {
  return `LEFT JOIN homeroom_bot_queue q ON q.app_id = ${appId} AND q.issue_number = ${issueNumber}
       LEFT JOIN LATERAL (
         SELECT id, mode, verdict, created_at, duration_ms, cap_suppressed, build_ok, build_error, build_session_id,
                proposal_session_id, live_build_waiting_at, awaiting_go_at,
                reason AS run_reason, already_done AS run_already_done,
                review->>'state' AS review_state, review->>'startedAt' AS review_started_at,
                jsonb_array_length(COALESCE(review->'rounds', '[]'::jsonb)) AS review_round,
                (review->'reviewer'->>'maxRounds')::int AS review_max_rounds,
                (review->'reviewer'->>'budgetMinutes')::int AS review_minutes,
                build_no_change->'turns'->-1->>'said' AS no_change_said
           FROM homeroom_bot_runs
          WHERE app_id = ${appId} AND issue_number = ${issueNumber} AND mode = 'live'
          ORDER BY id DESC LIMIT 1
       ) run ON TRUE
       ${replyLateralSql({ appId, issueNumber, runAt: 'run.created_at' })}
       LEFT JOIN chat_sessions bs ON bs.id = run.build_session_id
       LEFT JOIN LATERAL (
         SELECT created_at FROM homeroom_bot_posts
          WHERE run_id = run.id AND kind = 'spec'
          ORDER BY id DESC LIMIT 1
       ) spec ON TRUE
       LEFT JOIN LATERAL (
         SELECT proposal_session_id FROM homeroom_bot_runs
          WHERE app_id = ${appId} AND issue_number = ${issueNumber} AND proposal_session_id IS NOT NULL
          ORDER BY id DESC LIMIT 1
       ) prop ON TRUE
       LEFT JOIN chat_sessions cs ON cs.id = prop.proposal_session_id
       LEFT JOIN LATERAL (
         SELECT created_at FROM homeroom_bot_dm_messages
          WHERE app_id = ${appId} AND issue_number = ${issueNumber} AND question_status = 'open'
            ${userIdSql ? `AND user_id = ${userIdSql}` : ''}
          ORDER BY created_at DESC LIMIT 1
       ) oq ON TRUE`;
}

/** The columns requestRecordJoinsSql provides, as both readers select them. */
const REQUEST_RECORD_COLUMNS = `q.id AS queue_id, q.started_at, q.enqueued_at, q.reason AS queue_reason, q.held_until, q.held_reason,
            run.id AS run_id, run.mode, run.verdict, run.created_at AS run_at, run.duration_ms AS run_duration_ms,
            run.cap_suppressed,
            run.build_ok, run.build_error, run.build_session_id, run.proposal_session_id AS run_proposal,
            run.live_build_waiting_at AS build_waiting_at, run.awaiting_go_at AS plan_waiting_at,
            run.review_state, run.review_started_at, run.review_round, run.review_max_rounds, run.review_minutes,
            run.no_change_said, run.run_reason, run.run_already_done,
            bs.status AS build_status, bs.created_at AS build_started_at, bs.last_activity_at AS build_last_activity,
            bs.active_turn->>'mode' AS build_turn_mode, bs.active_turn->>'startedAt' AS build_turn_at,
            spec.created_at AS spec_at,
            prop.proposal_session_id,
            -- Merged but not live yet (live_at) reads as merging: going live.
            CASE WHEN cs.status = 'merged' AND cs.live_at IS NULL THEN 'merging' ELSE cs.status END AS proposal_status,
            cs.check_state, cs.check_phase,
            -- #6528: the change's before & after shots, so a passing change
            -- still being shot reads as checking rather than ready.
            cs.shots_state, cs.shots_run_id, cs.shots_detail, cs.shots_updated_at,
            cs.merge_conflict_state, cs.integration_merges_clean, cs.integration_block_reasons,
            cs.checks_progress, cs.checks_checked_at AS checks_at, cs.test_results,
            -- N5: which commit the verdict is about, and the head up for
            -- approval (checksOnHead).
            cs.checks_commit_sha AS checks_sha, cs.reviewed_head_sha, cs.imported_pr_head_sha,
            cs.source AS proposal_source,
            COALESCE(cs.promoted_at, cs.created_at) AS proposal_at, cs.live_at AS merged_at,
            oq.created_at AS question_at,
            -- #6284: it stopped at its own limit on this change, with no
            -- grant open: Needs you reads that, not "checking".
            EXISTS (
              SELECT 1 FROM homeroom_bot_runs lr
               WHERE lr.proposal_session_id = prop.proposal_session_id
                 AND lr.limit_stop = 'own_revisions'
                 AND lr.id = (
                   SELECT MAX(lr2.id) FROM homeroom_bot_runs lr2
                    WHERE lr2.proposal_session_id = prop.proposal_session_id
                      AND lr2.verdict IN ('person', 'failed')
                      AND LOWER(lr2.checks_head_sha) = LOWER(cs.reviewed_head_sha))
                 AND NOT EXISTS (
                   SELECT 1 FROM homeroom_bot_revision_grants g
                    WHERE g.session_id = prop.proposal_session_id AND g.used_at IS NULL)
            ) AS fix_stopped,
            reply.reply_id, reply.reply_at, reply.reply_user_id`;

// #6280: a row beyond the newest MAX_REQUESTS whose record looks live, so
// requestStates can read its stage before applying the cap to finished work.
// Generous on purpose: a row it picks that stageOf reads as finished is
// dropped below.
const REQUEST_RECORD_LIVE_SQL = `(queue_id IS NOT NULL
             OR question_at IS NOT NULL
             OR proposal_status IN ('promoted', 'merging')
             -- ready with nothing finished from it: plan waiting, build
             -- queued or under way, reviewing, and a build handed back.
             OR (mode = 'live' AND verdict = 'ready' AND build_ok IS NULL)
             OR (mode = 'live' AND verdict IN ('person', 'failed'))
             OR (mode = 'live' AND verdict = 'ready' AND build_ok = FALSE
                 AND build_error NOT LIKE 'skipped:%' AND build_error NOT LIKE 'blocked:%')
             -- a reply nobody has queued a read for yet, while it counts.
             OR (reply_at IS NOT NULL
                 AND reply_at > NOW() - make_interval(secs => ${Math.round(REPLY_WAIT_MS / 1000)})))`;

/**
 * Every request recorded as the person's (homeroom_bot_requesters), and
 * anything of theirs waiting in the bot's queue, with each record the steps
 * above read. Newest first.
 *
 * #6280 (4 Nov 2026, #6251): MAX_REQUESTS is a cap on the requests FINISHED
 * work is read from, never on work under way. A request being built, fixed,
 * reviewed or handed back, a plan waiting for Build it, and an open question
 * drop out of a plain 25-row window on a busy day (the platform's requester
 * had more than 25 newer runs), and the bot page then said "Nobody on it"
 * while the request's own page said Building. So every row whose record
 * looks live is read too, whatever its age; requestStates drops the ones
 * stageOf reads as finished, and only the newest MAX_REQUESTS of those stay.
 */
async function requestRows(pool, userId) {
  const { rows } = await pool.query(
    `WITH mine AS (
       SELECT r.app_id, r.issue_number, r.issue_title, r.first_version
         FROM homeroom_bot_requesters r WHERE r.user_id = $1
       UNION
       SELECT q.app_id, q.issue_number, i.title, FALSE
         FROM homeroom_bot_queue q
         JOIN issues i ON i.app_id = q.app_id AND i.github_issue_number = q.issue_number
        WHERE i.created_by = $1
          AND NOT EXISTS (SELECT 1 FROM homeroom_bot_requesters r2
                           WHERE r2.app_id = q.app_id AND r2.issue_number = q.issue_number)
     ), recs AS (
       SELECT m.app_id, a.slug, a.name, a.repo_url, m.issue_number, m.issue_title, m.first_version,
            ${REQUEST_RECORD_COLUMNS},
            -- #4539: the request's own state (requestClosedSql).
            ${requestClosedSql({ appId: 'm.app_id', issueNumber: 'm.issue_number' })} AS request_closed,
            ROW_NUMBER() OVER (
              ORDER BY GREATEST(COALESCE(run.created_at, 'epoch'::timestamptz),
                                COALESCE(q.enqueued_at, 'epoch'::timestamptz),
                                COALESCE(q.started_at, 'epoch'::timestamptz)) DESC
            ) AS record_rank
       FROM mine m
       JOIN apps a ON a.id = m.app_id
       ${requestRecordJoinsSql({ appId: 'm.app_id', issueNumber: 'm.issue_number', userIdSql: '$1' })}
     )
     SELECT * FROM recs
      WHERE record_rank <= ${MAX_REQUESTS} OR ${REQUEST_RECORD_LIVE_SQL}
      ORDER BY record_rank`,
    [userId],
  );
  return rows;
}

/** Pure (WP1): a live ready run whose build waits its turn or runs. */
function buildUnderWay(run) {
  return run.build_ok == null && !run.proposal_session_id && !run.cap_suppressed
    && ((!!run.live_build_waiting_at && !run.build_session_id) || run.build_status === 'active' || run.build_status === 'paused');
}

/** Pure (WP1): what one earlier build of a request came to, in words. */
function attemptOutcome(run) {
  const why = (prefix) => String(run.build_error || '').replace(prefix, '').slice(0, 200);
  if (run.proposal_session_id) {
    if (run.proposal_status === 'merged') return 'built; approved and live';
    if (run.proposal_status === 'promoted') return 'built; it\'s waiting for approval';
    if (run.proposal_status === 'merging') return 'built; it\'s going live now';
    return 'built; the change was closed';
  }
  if (run.build_ok === true) return 'built';
  if (run.build_ok === false) {
    if (/^skipped:/.test(String(run.build_error || ''))) return `stopped before it was built: ${why(/^skipped:\s*/)}`;
    if (/^blocked:/.test(String(run.build_error || ''))) return `found it cannot be built as written: ${why(/^blocked:\s*/)}`;
    return `the build did not succeed${run.build_error ? `: ${why('')}` : ''}`;
  }
  if (run.cap_suppressed) return 'held back by a limit, never built';
  if (run.build_error) return `never built: ${why(/^superseded:\s*/)}`;
  return 'nothing recorded about how it ended';
}

/**
 * WP1 (#10): the request's other live builds beside the one its stage
 * describes (its open proposal's, else its newest look's), set on each row
 * in place: `also_building`, another build of the same request that waits
 * or runs, and `earlier_attempt`, the build before the described one and
 * what it came to. The stage reads the newest look and the newest proposal
 * only, so a second build of one request was invisible to the bot's answers
 * ("Nothing broke", Plant Pal, 3 October). Never throws.
 */
async function attachAttempts(pool, rows) {
  const keyed = rows.filter((r) => r.app_id && r.issue_number);
  if (!keyed.length) return;
  let runs;
  try {
    ({ rows: runs } = await pool.query(
      `SELECT r.id, r.app_id, r.issue_number, r.created_at, r.build_ok, r.build_error, r.cap_suppressed,
              r.live_build_waiting_at, r.build_session_id, r.proposal_session_id,
              bs.status AS build_status, bs.created_at AS build_started_at,
              CASE WHEN ps.status = 'merged' AND ps.live_at IS NULL THEN 'merging' ELSE ps.status END AS proposal_status
         FROM homeroom_bot_runs r
         LEFT JOIN chat_sessions bs ON bs.id = r.build_session_id
         LEFT JOIN chat_sessions ps ON ps.id = r.proposal_session_id
        WHERE r.mode = 'live' AND r.verdict = 'ready'
          AND (r.app_id, r.issue_number) IN (SELECT * FROM UNNEST($1::int[], $2::int[]))
          AND r.created_at > NOW() - make_interval(days => $3)
        ORDER BY r.id DESC`,
      [keyed.map((r) => Number(r.app_id)), keyed.map((r) => Number(r.issue_number)), FINISHED_WITHIN_DAYS],
    ));
  } catch {
    return;
  }
  const byRequest = new Map();
  for (const run of runs || []) {
    const key = `${Number(run.app_id)}#${Number(run.issue_number)}`;
    if (!byRequest.has(key)) byRequest.set(key, []);
    byRequest.get(key).push(run);
  }
  for (const row of keyed) {
    const list = byRequest.get(`${Number(row.app_id)}#${Number(row.issue_number)}`) || [];
    if (!list.length) continue;
    const open = row.proposal_status === 'promoted' || row.proposal_status === 'merging';
    const proposalRun = open ? list.find((r) => Number(r.proposal_session_id) === Number(row.proposal_session_id)) : null;
    const described = Number(proposalRun?.id ?? row.run_id) || null;
    const other = list.find((r) => Number(r.id) !== described && buildUnderWay(r));
    if (other) {
      const waiting = !other.build_session_id;
      row.also_building = {
        doing: waiting
          ? 'another build of this same request is waiting its turn'
          : 'another build of this same request is under way',
        since: iso(other.build_started_at || other.live_build_waiting_at || other.created_at),
      };
    }
    const earlier = described ? list.find((r) => Number(r.id) < described && !buildUnderWay(r)) : null;
    if (earlier) {
      row.earlier_attempt = {
        outcome: attemptOutcome(earlier),
        when: iso(earlier.created_at),
        ...(earlier.proposal_session_id ? { proposal: Number(earlier.proposal_session_id) } : {}),
      };
    }
  }
}

/** Where each of `rows`' waiting requests is in the live queue, by queue id. */
async function queuePositions(pool, rows, settings) {
  const position = new Map();
  const scope = actsScope(settings);
  if (!scope || live().scopeIsEmpty(scope) || !rows.some((r) => r.queue_id && !r.started_at)) return position;
  const { rows: queue } = await pool.query(
    `SELECT q.id FROM homeroom_bot_queue q JOIN apps a ON a.id = q.app_id
      WHERE q.started_at IS NULL
        AND (CASE WHEN $2::boolean THEN NOT (a.slug = ANY($3::text[])) ELSE a.slug = ANY($1::text[]) END)
      ORDER BY q.priority, q.enqueued_at LIMIT 500`,
    [scope.slugs, scope.all, scope.except],
  );
  queue.forEach((q, i) => position.set(Number(q.id), i + 1));
  return position;
}

/**
 * #3771: what the bot is busy with on each project where a request of the
 * person's waits: a request it is reading now (a claimed queue row, other
 * than a follow-up on its own proposal, which runs beside it), or one it is
 * building (a live ready run with no proposal yet, whose queue row is gone).
 * A read holds the project's other reads (its one session); builds hold its
 * other builds once the project's build number (appCapsOf) are under way. By
 * app id:
 * [{ issueNumber, since, what }], newest first.
 */
async function projectsBusy(pool, rows) {
  const appIds = [...new Set(rows.filter((r) => (r.queue_id && !r.started_at) || (r.build_waiting_at && !r.build_session_id))
    .map((r) => Number(r.app_id)))];
  if (!appIds.length) return new Map();
  const { rows: found } = await pool.query(
    `(SELECT q.app_id, q.issue_number, q.started_at AS since, 'reading' AS what
        FROM homeroom_bot_queue q
       WHERE q.app_id = ANY($1::int[]) AND q.started_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
            WHERE cs.app_id = q.app_id AND q.issue_number = ANY(cs.linked_issues)
              AND cs.status = 'promoted' AND u.username = $2 AND u.is_synthetic = TRUE))
     UNION ALL
     (SELECT DISTINCT ON (r.app_id, r.issue_number) r.app_id, r.issue_number,
             COALESCE(bs.created_at, r.created_at) AS since, 'building' AS what
        FROM homeroom_bot_runs r
        LEFT JOIN chat_sessions bs ON bs.id = r.build_session_id
       WHERE r.app_id = ANY($1::int[]) AND r.mode = 'live' AND r.verdict = 'ready' AND r.build_ok IS NULL
         AND r.cap_suppressed IS NULL AND r.proposal_session_id IS NULL AND r.live_build_waiting_at IS NULL
         -- B6: a plan waiting for its Build it holds nothing up.
         AND r.awaiting_go_at IS NULL
         AND r.created_at > NOW() - make_interval(hours => $3)
         AND (bs.id IS NULL OR bs.status = 'active')
       ORDER BY r.app_id, r.issue_number, r.id DESC)`,
    [appIds, BOT_USERNAME, BUSY_BUILD_HOURS],
  );
  const out = new Map();
  for (const b of found) {
    const list = out.get(Number(b.app_id)) || [];
    list.push({ issueNumber: Number(b.issue_number), since: b.since, what: b.what });
    out.set(Number(b.app_id), list);
  }
  for (const list of out.values()) list.sort((a, b) => new Date(b.since) - new Date(a.since));
  return out;
}

/**
 * What the bot is doing on one project's requests right now, for the
 * request page (routes/issues.js): reading a request, or building one. By
 * issue number: Map(n → { what: 'reading' | 'building', since }).
 *
 * The bot's own sessions are never a request's `in_progress` (the issue
 * routes leave synthetic authors out on purpose), so without this a request
 * it was building read "Unassigned" and offered Start work. #4190: Claim is
 * offered beside the bot's work on purpose, and a claim made once the bot is
 * on the request means "I'm working on this too": it does not stop the bot
 * (homeroom-bot.js issueHolders).
 *
 * Read twice over. First the same two reads as projectsBusy, which takes
 * the projects of the rows it is handed that wait: one waiting row names
 * this project. Then the bot's own "live build waiting its turn or under
 * way" (the run homeroom-bot.js classifyIssue and rules/bot-loop.ts
 * READ_CANDIDATES_SQL hold a request for): a build waiting for the project's build slot can wait a
 * whole other build's length, and projectsBusy does not count it, since it
 * is not yet holding the project up. To the request it is the bot's work
 * all the same, so it reads as building, since it began to wait. A request
 * both read and built at once is called building, the longer of the two.
 */
async function botWorkByIssue(pool, appId) {
  const id = Number(appId);
  const out = new Map();
  if (!Number.isInteger(id) || id <= 0) return out;
  const busy = await projectsBusy(pool, [{ app_id: id, queue_id: -1, started_at: null }]);
  for (const b of busy.get(id) || []) {
    const had = out.get(b.issueNumber);
    if (had && had.what === 'building') continue;
    out.set(b.issueNumber, { what: b.what, since: b.since });
  }
  const { ABANDONED_LIVE_WINDOW_DAYS } = require('./homeroom-bot');
  const { rows: builds } = await pool.query(
    `SELECT DISTINCT ON (r.issue_number) r.issue_number,
            COALESCE(r.live_build_waiting_at, bs.created_at, r.created_at) AS since
       FROM homeroom_bot_runs r
       LEFT JOIN chat_sessions bs ON bs.id = r.build_session_id
      WHERE r.app_id = $1
        AND r.mode = 'live' AND r.verdict = 'ready' AND r.build_ok IS NULL AND r.proposal_session_id IS NULL
        AND (r.live_build_waiting_at IS NOT NULL OR r.build_session_id IS NOT NULL)
        AND r.created_at > NOW() - make_interval(days => $2)
      ORDER BY r.issue_number, r.created_at DESC`,
    [id, ABANDONED_LIVE_WINDOW_DAYS],
  );
  for (const b of builds) {
    const n = Number(b.issue_number);
    if (out.get(n)?.what === 'building') continue;
    out.set(n, { what: 'building', since: b.since });
  }
  // B8: somebody asked the bot to build it (its page, their chat, Ask for a
  // change) and it waits for a free builder: it is the bot's already, and
  // nobody starts it a second time.
  // B6: and a first version's plan, waiting for its creator's Build it.
  // The request page's status card says which (`plan`: a plan waits for
  // whoever asked for it to say Build it).
  const { rows: asked } = await pool.query(
    `SELECT issue_number, enqueued_at, FALSE AS plan FROM homeroom_bot_queue
      WHERE app_id = $1 AND priority = 0 AND started_at IS NULL
        AND (held_until IS NULL OR held_until <= NOW())
     UNION ALL
     SELECT issue_number, awaiting_go_at, TRUE AS plan FROM homeroom_bot_runs
      WHERE app_id = $1 AND awaiting_go_at IS NOT NULL AND build_ok IS NULL`,
    [id],
  );
  for (const q of asked) {
    const n = Number(q.issue_number);
    if (!out.has(n)) out.set(n, { what: 'queued', since: q.enqueued_at, ...(q.plan === true ? { plan: true } : {}) });
  }
  // And a request whose build its own limit holds: it starts when one of
  // its changes on the project is voted in or closed, or (#6156) one of its
  // builds there finishes (live.heldText).
  const { rows: held } = await pool.query(
    `SELECT DISTINCT ON (r.issue_number) r.issue_number, r.created_at, r.cap_suppressed
       FROM homeroom_bot_runs r
      WHERE r.app_id = $1 AND r.mode = 'live'
        AND r.created_at > NOW() - make_interval(days => $2)
      ORDER BY r.issue_number, r.id DESC`,
    [id, ABANDONED_LIVE_WINDOW_DAYS],
  ).catch(() => ({ rows: [] }));
  for (const h of held) {
    const n = Number(h.issue_number);
    if (out.has(n) || !['builds_per_app', 'proposals_per_app', 'proposals_total'].includes(h.cap_suppressed)) continue;
    out.set(n, { what: 'queued', since: h.created_at, held: true, ...(h.cap_suppressed === 'builds_per_app' ? { turn: true } : {}) });
  }
  return out;
}

// 2026-10-05: what a request held by its project's first version is doing,
// in the bot's words (its card, the tray, "how far along are you?"), and a
// ready one whose build is held the same way.
const FIRST_VERSION_WAIT = 'waiting for the first version to go live; I\'ll start on this as soon as it does';
const FIRST_VERSION_BUILD_WAIT = 'ready to build; I\'ll start as soon as the first version goes live';

/**
 * Pure: whether `row` waits for its project's first version, from `holds`
 * (homeroom-bot.js firstVersionHolds: app id → the first version's request
 * number, or null before it is filed): `{ reason, number? }`, or null.
 */
function firstVersionWait(row, holds, { reason = null } = {}) {
  if (!(holds instanceof Map) || !holds.size) return null;
  const bot = require('./homeroom-bot');
  if (!bot.heldForFirstVersion(holds, {
    appId: row.app_id, issueNumber: row.issue_number, firstVersion: !!row.first_version, reason,
  })) return null;
  const number = holds.get(Number(row.app_id));
  return { reason: bot.FIRST_VERSION_HOLD, ...(number != null ? { number: Number(number) } : {}) };
}

/**
 * The first-version holds (firstVersionWait) on the projects of the staged
 * rows still waiting to be read or built. Best-effort: a read that fails
 * holds nothing here, and the loop's own read decides.
 */
async function waitingHolds(pool, staged) {
  const appIds = staged
    .filter((s) => s.state?.stage === 'queued' || s.state?.stage === 'build_queued')
    .map((s) => Number(s.row.app_id));
  if (!appIds.length) return new Map();
  try {
    return await require('./homeroom-bot').firstVersionHolds(pool, appIds);
  } catch {
    return new Map();
  }
}

// 1 Nov 2026: a request whose requester works on it with the bot in a
// private thread waits for their plan (rules/bot-loop.ts planHoldSql).
const PLAN_WAIT = 'waiting for your plan: you are working on it with me in a private thread; I\'ll start once a plan is posted on it, or once you tap Let the bot build it now on its page';

/**
 * The requests `userId`'s own private threads hold the bot on now, as
 * `appId:issueNumber` keys. Best-effort: a read that fails holds nothing
 * here, and the loop's own read decides.
 */
async function planHolds(pool, userId) {
  try {
    const { planHoldActiveSql } = require('../workflow/rules/bot-loop.ts');
    const { rows } = await pool.query(
      `SELECT p.app_id, p.about_number FROM private_threads p
        WHERE p.user_id = $1 AND ${planHoldActiveSql('p')}`,
      [userId],
    );
    return new Set(rows.map((r) => `${Number(r.app_id)}:${Number(r.about_number)}`));
  } catch {
    return new Set();
  }
}

/**
 * Pure (#3771): what a request in the queue waits for, as the `queued`
 * stage's words and `waitingFor`. Its project reading as many other
 * requests as it may at once (`readsPerApp`, the bot's setting: each read
 * runs on a triage session of its own; a build runs on a session of its own
 * and holds no read up); the most the bot does for one person at once
 * already under way; or, with nothing in the way, its place in the queue.
 * "Waiting in the queue (number 4)" said none of that, and "when will you
 * pick it up?" had no answer.
 */
function queuedWait(row, {
  busy = new Map(), working = 0, perPerson = 2, queuePosition = null, now = new Date(), holds = null, readsPerApp = 1,
} = {}) {
  // 2026-10-05: its project's first version is not live yet, and nothing
  // else on the project starts until it is (homeroom-bot.js
  // FIRST_VERSION_PENDING_SQL). That is what it waits for, whatever else is.
  const firstVersion = firstVersionWait(row, holds, { reason: row.queue_reason });
  if (firstVersion) return { doing: FIRST_VERSION_WAIT, waitingFor: firstVersion };
  const most = Math.max(1, Math.floor(Number(readsPerApp) || 1));
  const reading = (busy.get(Number(row.app_id)) || [])
    .filter((b) => b.what === 'reading' && b.issueNumber !== Number(row.issue_number));
  const ahead = reading[0];
  if (ahead && reading.length >= most) {
    // How long the other one has run is its own; the entry's time so far is
    // this request's wait.
    const minutes = minutesSince(ahead.since, now);
    const numbers = reading.map((b) => `#${b.issueNumber}`);
    const words = most === 1
      ? `request #${ahead.issueNumber} first (one read per project at a time)`
      : `requests ${numbers.length > 1 ? `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}` : numbers[0]} first (${most} reads per project at a time)`;
    return {
      doing: `waiting its turn: ${row.name || row.slug} is reading ${words}`,
      waitingFor: {
        reason: 'project_busy', number: ahead.issueNumber, doing: 'reading', ...(Number.isInteger(minutes) ? { minutesSoFar: minutes } : {}),
        ...(most > 1 ? { reading: reading.length, most } : {}),
      },
    };
  }
  if (working >= perPerson) {
    return {
      doing: `waiting its turn: ${plural(working, 'thing')} of theirs ${working === 1 ? 'is' : 'are'} in progress, the most at once for one person`,
      waitingFor: { reason: 'person_limit', inProgress: working, most: perPerson },
    };
  }
  if (queuePosition === 1) return { doing: 'next in line for a free builder', waitingFor: { reason: 'queue', ahead: 0 } };
  if (Number.isInteger(queuePosition) && queuePosition > 1) {
    // How many are ahead stays in `waitingFor`, for the model to answer
    // "how long?" with; the words say what it waits for.
    return {
      doing: 'waiting for a free builder',
      waitingFor: { reason: 'queue', ahead: queuePosition - 1 },
    };
  }
  return {};
}

/**
 * Pure: what a build waiting its turn waits for, as the `build_queued`
 * stage's words and `waitingFor`: its project's other builds, once its
 * build number (homeroom-bot.js appCapsOf(settings, appId).building) are
 * under way, the most the bot does for one person at once, or nothing: it
 * starts next.
 */
function buildWait(row, {
  busy = new Map(), working = 0, perPerson = 2, now = new Date(), holds = null,
  perProject = require('./homeroom-bot').BUILDS_PER_APP,
} = {}) {
  // 2026-10-05: no build on a project starts while its first version is
  // not live (rules/bot-loop.ts BUILD_CANDIDATES_SQL).
  const firstVersion = firstVersionWait(row, holds);
  if (firstVersion) return { doing: FIRST_VERSION_BUILD_WAIT, waitingFor: firstVersion };
  const building = (busy.get(Number(row.app_id)) || [])
    .filter((b) => b.what === 'building' && b.issueNumber !== Number(row.issue_number));
  if (building.length >= perProject) {
    // The one that started first is the one likely to finish first; the
    // list is newest first.
    const ahead = building[building.length - 1];
    const minutes = minutesSince(ahead.since, now);
    const numbers = [...building].reverse().map((b) => `#${b.issueNumber}`).join(', ');
    return {
      doing: `ready to build; ${row.name || row.slug} is building ${building.length === 1 ? 'request' : 'requests'} ${numbers} first (up to ${plural(perProject, 'build')} per project at a time)`,
      waitingFor: {
        reason: 'project_building', number: ahead.issueNumber, building: building.length, most: perProject,
        ...(Number.isInteger(minutes) ? { minutesSoFar: minutes } : {}),
      },
    };
  }
  if (working >= perPerson) {
    return {
      doing: `ready to build; ${plural(working, 'thing')} of theirs ${working === 1 ? 'is' : 'are'} in progress, the most at once for one person`,
      waitingFor: { reason: 'person_limit', inProgress: working, most: perPerson },
    };
  }
  return { doing: 'ready to build; its build starts next', waitingFor: { reason: 'next' } };
}

/**
 * A proposal's facts as the DM reads them: its title, where it stands, its
 * checks in words, the votes for and against and how many it needs, and its
 * link. Null when there is no such proposal.
 */
async function proposalFacts(pool, sessionId, { domain = null } = {}) {
  if (!sessionId) return null;
  const revision = require('./pr-vote-revision');
  const { rows } = await pool.query(
    `SELECT cs.id, cs.app_id, a.slug,
            CASE WHEN cs.status = 'merged' AND cs.live_at IS NULL THEN 'merging' ELSE cs.status END AS status,
            cs.check_state, cs.check_phase, cs.checks_progress,
            cs.test_results, cs.session_title, cs.pr_title, cs.pr_number, cs.promoted_at, cs.created_at,
            (SELECT COUNT(*)::int FROM pr_votes pv WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                AND ${revision.countedVotePredicateSql('pv', 'cs')}) AS yes,
            (SELECT COUNT(*)::int FROM pr_votes pv WHERE pv.session_id = cs.id AND pv.vote = 'no'
                AND ${revision.countedVotePredicateSql('pv', 'cs')}) AS no
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
    [sessionId],
  );
  const s = rows[0];
  if (!s) return null;
  let needed = null;
  // 13 Oct 2026, D1: a project's first version goes live without a vote.
  const first = s.status === 'promoted'
    ? await require('./first-version-rule').isFirstVersion(pool, s.id)
    : false;
  if (s.status === 'promoted') {
    try {
      const governance = require('./governance');
      const gov = await governance.getGovernance(pool, s.app_id);
      const electorate = await governance.getElectorate(pool, s.app_id, gov);
      needed = governance.computeGate(gov, electorate.active, s.yes, s.no, s.promoted_at || s.created_at, undefined, { firstVersion: first }).required;
    } catch { needed = null; }
  }
  const link = links(domain, { slug: s.slug, proposal: s.id, pr: s.pr_number }).proposal;
  return {
    proposal: Number(s.id),
    title: s.session_title || s.pr_title || null,
    status: first
      ? 'the project\'s first version: it goes live without a vote once its tests pass'
      : ({ promoted: 'waiting for approval', merging: 'going live', merged: 'live', closed: 'closed' }[s.status] || s.status),
    checks: checksWords({ ...s, failed_checks: failedCount(s.test_results) }),
    yesVotes: s.yes,
    noVotes: s.no,
    votesNeeded: Number.isFinite(needed) ? needed : null,
    ...(link ? { link } : {}),
  };
}

/**
 * The first versions the bot is to build for this person whose request is
 * not filed yet: the project is still being set up, or could not be.
 */
async function firstVersionRows(pool, userId) {
  const { rows } = await pool.query(
    `SELECT a.id AS app_id, a.slug, a.name, a.status AS app_status, a.created_at AS app_created_at,
            f.status, f.created_at, f.error
       FROM homeroom_bot_first_versions f JOIN apps a ON a.id = f.app_id
      WHERE f.user_id = $1 AND f.bot_builds = TRUE AND f.status IN ('waiting', 'filing', 'failed')
      ORDER BY f.created_at DESC LIMIT 10`,
    [userId],
  );
  return rows;
}

/** Pure: a first version's setup, as a stage, or a stopped outcome. */
function setupOf(row, { phase = null } = {}) {
  if (row.status === 'failed') return { outcome: 'its first version could not be started' };
  if (row.app_status === 'error') return { outcome: 'setting up the project failed, so its first version could not be started' };
  if (row.app_status === 'awaiting_secrets') {
    return {
      stage: 'setting_up', since: row.app_created_at || row.created_at, waitingOn: 'them',
      doing: 'the project is waiting for its secrets to be set on its page before it can start',
    };
  }
  if (row.app_status === 'running') {
    return { stage: 'setting_up', since: row.created_at, doing: 'the project is set up; its first request is being filed to start on it' };
  }
  const parts = Object.keys(SETUP_PARTS);
  const part = phase && SETUP_PARTS[phase.phase]
    ? `: part ${parts.indexOf(phase.phase) + 1} of ${parts.length}, ${SETUP_PARTS[phase.phase]}`
    : '';
  return { stage: 'setting_up', since: row.app_created_at || row.created_at, doing: `setting up the project${part}` };
}

/** Pure: whether a `progressFor` entry is in the bot's hands now (IN_FLIGHT_STAGES). */
function inFlight(item) {
  return !!item && IN_FLIGHT_STAGES.has(item.stage) && !item.waitingOn;
}

function entry({ row, number = null, title = null, firstVersion, state, proposal = null, limits = {}, domain, now }) {
  const steps = firstVersion ? FIRST_VERSION_STEPS : REQUEST_STEPS;
  const step = stepNumber(state.stage, firstVersion);
  const minutes = minutesSince(state.since, now);
  const limit = state.limit && Number.isFinite(limits[state.limit]) ? limits[state.limit] : null;
  const typical = state.waitingOn ? null : typicalMinutes(state.stage, limit);
  return {
    project: row.slug,
    projectName: row.name || row.slug,
    ...(number ? { number: Number(number) } : {}),
    title: firstVersion ? 'First version' : (title || null),
    ...(firstVersion ? { firstVersion: true } : {}),
    stage: state.stage,
    step,
    of: steps.length,
    stepName: step ? steps[step - 1] : null,
    // The same for what it is doing: building it, once Build it is tapped.
    doing: firstVersion && state.stage === 'planning' ? 'building it' : state.doing,
    busyNow: BUSY_STAGES.has(state.stage) && !state.waitingOn,
    ...(state.since ? { since: iso(state.since), minutesSoFar: minutes } : {}),
    ...(limit ? { stepTimeLimitMinutes: limit } : {}),
    ...(typical ? { typicalMinutes: typical } : {}),
    ...(state.waitingOn ? { waitingOn: state.waitingOn } : {}),
    ...(state.waitingFor ? { waitingFor: state.waitingFor } : {}),
    // #6313: a queued read after a plan that could not be written says so.
    ...(state.retry ? { retry: state.retry } : {}),
    ...(proposal ? { proposal } : {}),
    // WP1 (#10): the request's other builds, beside the one described.
    ...(row.also_building ? { alsoBuilding: row.also_building } : {}),
    ...(row.earlier_attempt ? { earlierAttempt: row.earlier_attempt } : {}),
    links: links(domain, { slug: row.slug, number, proposal: proposal?.proposal }),
  };
}

/**
 * Each of the person's requests (requestRows), newest first, beside the
 * stage it is at (stageOf; null when nothing about it is in progress):
 * `{ row, state }`. What progressFor below says of each, and what the
 * activity cards read (homeroom-bot-activity.js catchUpCards) to find the
 * work under way that has no card yet, so the two cannot disagree on what
 * that work is.
 */
async function requestStates(pool, { userId, settings = null, now = new Date(), working = 0 }) {
  // #3734: a queue row is the bot's work only on a project it acts on for
  // real. On any other the queue is its background triage, which says
  // nothing to anybody, so it is neither "waiting in the queue" nor "reading
  // it" for them. Whether the bot is switched on is said apart (botIsOn).
  const acts = actsScope(settings);
  const rows = (await requestRows(pool, userId)).map((row) => (!acts || live().inScope(acts, row.slug) ? row : {
    ...row, queue_id: null, started_at: null, enqueued_at: null, queue_reason: null,
  }));
  await attachAttempts(pool, rows);
  const position = await queuePositions(pool, rows, settings);
  // #6280: a row read past MAX_REQUESTS only because its record looked live
  // is kept when it really is: a stage, or a request handed back to them. A
  // finished one is dropped, so the cap still applies to finished work.
  const staged = rows.map((row) => {
    const queuePosition = row.queue_id ? position.get(Number(row.queue_id)) || null : null;
    return { row, state: stageOf({ ...row, queue_position: queuePosition }, { now }), queuePosition };
  }).filter((s) => s.row.record_rank == null || Number(s.row.record_rank) <= MAX_REQUESTS || s.state || handedBack(s.row));
  // #3771: what a request still in the queue waits for, in words. `working`
  // is the work already under way that does not come from these requests.
  const busyCount = working
    + staged.filter((s) => s.state && BUSY_STAGES.has(s.state.stage) && !s.state.waitingOn).length;
  const busy = staged.some((s) => s.state?.stage === 'queued' || s.state?.stage === 'build_queued')
    ? await projectsBusy(pool, rows) : new Map();
  const perPerson = Number(settings?.perPerson) || 2;
  const readsPerApp = Number(settings?.readsPerApp) || require('./homeroom-bot').DEFAULTS.readsPerApp;
  const holds = await waitingHolds(pool, staged);
  const plans = staged.some((s) => s.state?.stage === 'queued' || s.state?.stage === 'build_queued')
    ? await planHolds(pool, userId) : new Set();
  return staged.map((s) => {
    // Their plan comes first, whatever else it would wait for.
    if ((s.state?.stage === 'queued' || s.state?.stage === 'build_queued') && !s.row.first_version
      && plans.has(`${Number(s.row.app_id)}:${Number(s.row.issue_number)}`)) {
      return { row: s.row, state: { ...s.state, doing: PLAN_WAIT, waitingOn: 'them', waitingFor: { reason: 'awaiting_plan' } } };
    }
    if (s.state?.stage === 'queued') {
      return {
        row: s.row,
        state: {
          ...s.state,
          ...queuedWait(s.row, { busy, working: busyCount, perPerson, queuePosition: s.queuePosition, now, holds, readsPerApp }),
        },
      };
    }
    if (s.state?.stage === 'build_queued') {
      const perProject = buildCapOf(settings, s.row.app_id);
      return { row: s.row, state: { ...s.state, ...buildWait(s.row, { busy, working: busyCount, perPerson, now, holds, perProject }) } };
    }
    return { row: s.row, state: s.state };
  });
}

/**
 * How far along the bot is with everything it does for `userId`, newest
 * first: `rightNow` (in progress, each with its step of the steps above,
 * what it is doing, since when, the step's time limit and links) and
 * `finishedLately` (the last few that came to something). `facts: false`
 * leaves a proposal as its id alone, without its checks and votes (the
 * activity tray draws no more than that, and reads this on every change).
 */
async function progressFor(pool, { userId, settings = null, config = null, deps = {}, now = new Date(), facts = true }) {
  const botSvc = deps.botSvc || require('./homeroom-bot');
  const phases = deps.creationPhase || require('./app-creation-phase');
  const domain = deps.domain !== undefined ? deps.domain : require('./caddy').USERNODE_DOMAIN;
  const rightNow = [];
  const finished = [];

  for (const row of await firstVersionRows(pool, userId)) {
    const state = setupOf(row, { phase: row.app_status === 'creating' ? await phases.read(pool, row.app_id) : null });
    if (state.outcome) {
      finished.push({ project: row.slug, projectName: row.name || row.slug, title: 'First version', outcome: state.outcome, links: links(domain, { slug: row.slug }) });
    } else {
      rightNow.push(entry({ row, firstVersion: true, state, domain, now }));
    }
  }

  const cutoff = now.getTime() - FINISHED_WITHIN_DAYS * 24 * 60 * MINUTE_MS;
  for (const { row, state } of await requestStates(pool, {
    userId, settings, now, working: rightNow.filter((e) => e.busyNow).length,
  })) {
    if (state) {
      const open = row.proposal_session_id && row.proposal_status && row.proposal_status !== 'closed';
      let proposal = null;
      if (open) {
        proposal = facts
          ? await proposalFacts(pool, Number(row.proposal_session_id), { domain })
          : { proposal: Number(row.proposal_session_id) };
      }
      rightNow.push(entry({
        row, number: row.issue_number, title: row.issue_title, firstVersion: !!row.first_version, state, proposal,
        limits: state.limit ? limitsFor(row, { settings, config, botSvc }) : {}, domain, now,
      }));
      continue;
    }
    const outcome = outcomeOf(row);
    const when = row.merged_at || row.run_at;
    if (outcome && when && new Date(when).getTime() >= cutoff && finished.length < MAX_FINISHED) {
      finished.push({
        project: row.slug,
        projectName: row.name || row.slug,
        number: Number(row.issue_number),
        title: row.first_version ? 'First version' : (row.issue_title || null),
        outcome,
        when: iso(when),
        links: links(domain, { slug: row.slug, number: row.issue_number, proposal: row.proposal_session_id }),
      });
    }
  }
  return {
    botIsOn: settings?.mode !== 'off',
    rightNow,
    finishedLately: finished.slice(0, MAX_FINISHED),
  };
}

/**
 * Pure: `progressFor`'s answer as a short message in plain words, for the
 * DM to send from the records alone when its model could not answer. At
 * most `max` pieces of work, and how many more there are: #4097, the DM
 * sends it with a card for each one it lists (homeroom-bot-mayor.js
 * recordsAnswer), and a piece listed with no card was a number to decode.
 */
function progressText(progress, { max = 5 } = {}) {
  const lines = [];
  const rightNow = progress?.rightNow || [];
  for (const item of rightNow.slice(0, max)) {
    const what = item.number
      ? `${item.projectName} request #${item.number}${item.title ? ` (${item.title})` : ''}`
      : `${item.projectName}, its ${String(item.title || 'first version').toLowerCase()}`;
    const step = item.step ? `step ${item.step} of ${item.of}, ` : '';
    const time = Number.isInteger(item.minutesSoFar)
      ? `, for ${item.minutesSoFar < 1 ? 'under a minute' : plural(item.minutesSoFar, 'minute')} so far`
      : '';
    lines.push(`- ${what}: ${step}${item.doing}${time}.`);
  }
  if (lines.length && rightNow.length > max) lines.push(`- and ${rightNow.length - max} more.`);
  if (!lines.length) {
    const done = (progress?.finishedLately || [])[0];
    return done
      ? `I'm not working on anything for you right now. Most recently, ${done.projectName}${done.number ? ` request #${done.number}` : ''}: ${done.outcome}.`
      : 'I\'m not working on anything for you right now.';
  }
  const off = progress.botIsOn === false ? '\n\nI\'m switched off right now, so this waits until I\'m back on.' : '';
  return `Here is where things stand, from my records:\n\n${lines.join('\n')}${off}`;
}

module.exports = {
  FIRST_VERSION_STEPS,
  REQUEST_STEPS,
  BUILD_LINE_STATES,
  buildLineOf,
  // N4: a first version's stages by name, and its App tab's step list.
  FIRST_VERSION_PHASES,
  FIRST_VERSION_STEP_KEYS,
  firstVersionPhase,
  firstVersionSteps,
  GOING_LIVE,
  SETUP_PARTS,
  BUSY_STAGES,
  IN_FLIGHT_STAGES,
  START_GRACE_MS,
  // #6228: a reply on a request waiting to be read.
  REPLY_WAIT_MS,
  replyWaits,
  holdOf,
  HOLD_IS_ALLOWANCE_SQL,
  replyLateralSql,
  // #6280: one record read for the bot page's rows and a request's track.
  requestClosedSql,
  requestRecordJoinsSql,
  REQUEST_RECORD_COLUMNS,
  // #6246: a plan waiting for Build it, read by the bot page and the Workshop.
  planWaits,
  planWaitingSql,
  // #6282: an update on its way holds the vote it would otherwise ask for.
  UPDATE_TAKEN_HOURS,
  UPDATE_QUEUED_DAYS,
  // #6348: a turn marker older than a turn can run is not an update coming.
  UPDATE_TURN_HOURS,
  askOnHeadSql,
  updateComingSql,
  updateAskSql,
  inFlight,
  stageOf,
  // #6234: the bot's own fix of a change's failing checks, for its page.
  changeBotFix,
  checksOnHead,
  // #6521: the same rule for a change page's own row shape.
  sessionChecksOnHead,
  firstVersionStage,
  firstVersionStopped,
  handedBack,
  buildUnderWay,
  attemptOutcome,
  attachAttempts,
  queuedWait,
  buildWait,
  FIRST_VERSION_WAIT,
  PLAN_WAIT,
  FIRST_VERSION_BUILD_WAIT,
  firstVersionWait,
  projectsBusy,
  botWorkByIssue,
  outcomeOf,
  setupOf,
  stepNumber,
  checksWords,
  failedCount,
  links,
  proposalFacts,
  requestStates,
  progressFor,
  progressText,
  // #8, #19 (WP3)
  TYPICAL_MINUTES,
  leftOverQueue,
  typicalMinutes,
};
