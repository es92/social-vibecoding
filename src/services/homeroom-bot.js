'use strict';

// #2684: the Homeroom bot (`homeroom_bot`), slice 1 — shadow-mode triage.
//
// ── What it is ───────────────────────────────────────────────────────────
//
// A synthetic platform user that walks every app's open requests and, for
// each one, runs ONE read-only scout turn on the OpenRouter coding backend
// with the app's repository checked out, and records a verdict:
//
//   question  the request is not clear enough to build; here is the one
//             question the bot would ask, with a suggested default
//   ready     the request is clear and the change is small and safe; here
//             is what the bot would change
//   person    the request is clear but a person has to decide something
//             (auth, billing, schema, a design question)
//
// In this slice the verdict is ALL it produces. Nothing is posted to the
// issue, nothing is claimed, nothing is built, nobody is notified. The admin
// console's "Homeroom bot" section reads the ledger and shows, per issue,
// what the bot would have done — and an admin rates each verdict, which is
// the calibration signal the later slices are gated on.
//
// ── Shape ────────────────────────────────────────────────────────────────
//
// A QUEUE, not an hourly sweep. `refreshQueue` reads the GitHub issue cache
// for every app every REFRESH_INTERVAL_MS and upserts one row per eligible
// issue into homeroom_bot_queue; the leader's work loop drains it. Draining
// is PER APP in batches: the bot keeps one dev session per app, so every
// issue of that app runs through the same warm worker container and pays
// the clone once. Scout mode already fetches and resets the workspace at
// the start of each turn, so issues do not see each other's state, and each
// turn starts a fresh model thread.
//
// A `homeroom_bot_mode` platform setting is `off` (the loop idles), `shadow`
// (this slice) or `live` (reserved; the settings route refuses it). Ships
// `off`, so the change that adds the bot is itself inert.
//
// ── What the bot never does here ─────────────────────────────────────────
//
// The scout runner blanks the push token (worker/run-codex-agent.sh), so
// "nothing is built" is structural rather than a prompt instruction. The
// bot's sessions carry an empty linked_issues and is_headless FALSE, so the
// issue payload's `headless` and `in_progress` derivations never paint them
// on a card; routes/issues.js excludes synthetic authors there as well, as
// defence in depth. The sessions sit `paused` between turns and are
// excluded from the global session cap (routes/sessions.js), so a bot turn
// never costs a person a slot.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const log = require('./logger');
const githubBudget = require('./github-budget');
const { HOMEROOM_BOT_LOCK } = require('./advisory-locks');
const live = require('./homeroom-bot-live');
const followup = require('./homeroom-bot-followup');
const durableSteps = require('./durable-steps');
const durableTurn = require('./durable-turn');
const { FIX_COMMIT_MESSAGES } = require('./homeroom-commits');
const snapshots = require('./homeroom-bot-snapshots');
const { withoutEmDashes } = require('./em-dashes');
const { agentApiFailure } = require('./agent-result-text');
// Newcomer run five: a first version's stages, as they happen.
const timeline = require('./first-version-timeline');

// The bot-build machine's legacy side (src/workflow/bot-build/): live and
// shadow builds are durable builds there. Lazy: it reaches back into this
// module for what each build runs.
function buildRuns() { return require('./build-runs'); }

/** Whether the run has said `kind` on its request (homeroom_bot_posts): a post is never said twice. */
async function runPosted(pool, runId, kind) {
  if (!runId) return false;
  try {
    // A post still going out when a restart came is not said yet (live.post).
    const { rows } = await pool.query(
      'SELECT 1 FROM homeroom_bot_posts WHERE run_id = $1 AND kind = $2 AND pending IS NOT TRUE LIMIT 1',
      [Number(runId), String(kind)],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Debit the bot's allowance for a build's spend, once per build: a restart
 * that brings the build back here does not debit it again (the step is kept
 * before the debit: a restart between the two leaves it undebited rather
 * than debited twice).
 */
async function debitBuildOnce(steps, key, totalUsd, debit) {
  if (!(Number(totalUsd) > 0)) return 0;
  if (steps.has(key)) return 0;
  await steps.set(key, { usd: Number(totalUsd) });
  await debit(Number(totalUsd));
  return Number(totalUsd);
}

// #3692: the activity tray in a person's DM with the bot. Lazy, as the DM
// module is: it reads this module's settings.
function tray() { return require('./homeroom-bot-tray'); }
// #3736: and the activity card that follows one piece of work there.
function activity() { return require('./homeroom-bot-activity'); }
// How a project's first version is built: the current configuration, its
// side builds and their results (services/bot-configs.js), and its review
// (services/bot-review.js). Lazy: they read this module's settings.
function botConfigs() { return require('./bot-configs'); }
// #4387: what a first version's App tab shows while it is built.
function firstVersionScreens() { return require('./first-version-screens'); }
// #4449: and Live, the app itself while it is built.
function firstVersionLive() { return require('./first-version-live'); }
// Newcomer run six: the early first look, drawn from the plan at Make it.
function firstVersionEarlyLook() { return require('./first-version-early-look'); }
function botReview() { return require('./bot-review'); }
// #4210: interrupted builds, kept for admins.
function incidents() { return require('./platform-incidents'); }
// #4530: whether the new words on a request the bot already answered were
// for the bot, so a repeat note is held back when they were not.
function addressedMod() { return require('./homeroom-bot-addressed'); }
// The bot's voice outside its DM (homeroom-bot-voice.js): which places it
// answers in, and the asks it queues on its changes.
function voiceModule(deps) { return (deps && deps.voice) || require('./homeroom-bot-voice'); }
// Its proposals for requests closed some other way (a person's change, a
// close vote, GitHub): withdrawn, which frees their slots.
function closedRequests() { return require('./homeroom-bot-closed-requests'); }

// One name, in the live module, which compares thread authors against it.
const { BOT_USERNAME } = live;
// B5: what people see it called (users.display_name), in place of the handle.
const BOT_DISPLAY_NAME = 'Homeroom bot';
const MODES = Object.freeze(['off', 'shadow', 'live']);
// `empty` (#2737) is the fourth: a request with nothing in it to build or
// even to ask about. It exists because the prompt's unclear branch used to
// force a question, so a placeholder issue got asked "what do you mean?"
// with a suggested default of "discard" — the model already knew, and had
// nowhere to say it. Shadow only in this slice: it posts nothing.
const VERDICTS = Object.freeze(['question', 'ready', 'person', 'empty']);

const KEY_MODE = 'homeroom_bot_mode';
const KEY_CONCURRENCY = 'homeroom_bot_concurrency';
const KEY_BATCH_SIZE = 'homeroom_bot_batch_size';
const KEY_PAUSED_APPS = 'homeroom_bot_paused_apps';
const KEY_TURN_SECONDS = 'homeroom_bot_turn_seconds';
const KEY_TURN_INPUT_TOKENS = 'homeroom_bot_turn_input_tokens';
// Shadow builds: on an app the bot does not act on for real (every app on
// a staging copy, live.liveScope), a ready verdict is also
// built, on a branch of its own that nobody is shown: no proposal, no
// post, nothing in the app. The dashboard and the export carry the branch,
// so what the bot WOULD have proposed can be spot-checked before an app goes
// live. A switch, bounded by the bot's weekly allowance rather than a daily
// count, so a backfill of every open ready request can run to the end. It
// ships off. The builds run in a lane of their own (see "The build lane"),
// `homeroom_bot_build_concurrency` at a time, and skip the platform's own
// repository unless `homeroom_bot_shadow_build_platform` is on.
const KEY_SHADOW_BUILDS = 'homeroom_bot_shadow_builds';
const KEY_BUILD_CONCURRENCY = 'homeroom_bot_build_concurrency';
const KEY_SHADOW_BUILD_PLATFORM = 'homeroom_bot_shadow_build_platform';
// #3624: what one person's requests may cost the bot in a week, in cents,
// on top of (and apart from) their own weekly allowance for agents. The
// platform pays; this is the ceiling that keeps one person from spending
// it all.
const KEY_USER_WEEKLY_CENTS = 'homeroom_bot_user_weekly_cents';
// The same ceiling for an admin (users.is_admin, view-only admins included),
// which applies to them instead of the one above (homeroom-bot-dm.js
// weeklyCapCents). Admins build the platform itself, so theirs starts higher.
const KEY_ADMIN_WEEKLY_CENTS = 'homeroom_bot_admin_weekly_cents';
// #3654: the OpenRouter model each stage runs on. Blank means the platform
// default (OPENROUTER_DEFAULT_CODEX_MODEL), which every stage used before.
// `followup` covers both kinds of follow-up turn: an answer to people's
// replies and a fix for the proposal's own failing checks.
const MODEL_STAGES = Object.freeze(['triage', 'spec', 'build', 'followup']);
const KEY_MODELS = Object.freeze({
  triage: 'homeroom_bot_model_triage',
  spec: 'homeroom_bot_model_spec',
  build: 'homeroom_bot_model_build',
  followup: 'homeroom_bot_model_followup',
});
// An OpenRouter model id: `vendor/model`, as the catalog spells them.
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}\/[a-z0-9][a-z0-9._:-]{0,100}$/i;
// #3624, stage 2: how much live work runs at once (see "How much at once"
// below). `homeroom_bot_concurrency` is the background lane's: how many
// apps' shadow triage runs at once, beside the live work, never in its way.
const KEY_LIVE_AT_ONCE = 'homeroom_bot_live_at_once';
const KEY_PER_PERSON = 'homeroom_bot_per_person';
// #3624, stage 2: whether a DM to the bot is read by a model
// (homeroom-bot-mayor.js). On by default; the switch is there to stop it
// without switching the whole bot off.
const KEY_DM_CHAT = 'homeroom_bot_dm_chat';
// Its voice outside the DM (homeroom-bot-voice.js), one switch per place, on
// unless switched off: on, the bot answers there as it does in a DM; off, a
// place goes back to the fixed notes it had before. On its own changes (any
// person's message there), on requests (a mention or a reply to it), and in
// project chats, topics and #general (a mention or a reply to it).
const KEY_VOICE_SESSION = 'homeroom_bot_voice_session';
const KEY_VOICE_ISSUE = 'homeroom_bot_voice_issue';
const KEY_VOICE_CHAT = 'homeroom_bot_voice_chat';
// Whether reading a request again continues the conversation that read it
// last (previousRead), so the model starts from what it already found
// rather than from the repository. On by default; off reads every time
// from scratch, as every read did before.
const KEY_CONTINUE_READS = 'homeroom_bot_continue_reads';
// The bot works for every person with platform access, and acts for real
// on every project but a paused one (live.liveScope), the platform's own
// included. It used to be given out one person at a time (a DM list, a list
// of live apps, a Settings -> Experimental switch, then an admin's switch
// to everyone); this is what that switch became. The moment it went on for
// everyone is kept (KEY_EVERYONE_SINCE, written once by schema.sql on the
// first boot of this build): a request nobody has touched since, older than
// that, is not picked up on its own (refreshApp), or the first refresh would
// read and build every open request on every app at once. The key keeps the
// name the switch wrote, so a moment an admin's switch already recorded
// stands.
const KEY_EVERYONE_SINCE = 'homeroom_bot_audience_since';
// The most proposals the bot may have up for a vote at once, across every
// app (botProposalCeiling). Unset (0) is automatic: EVERYONE_PROPOSAL_CEILING,
// since "5 per live app" would be every app there is.
const KEY_PROPOSAL_CEILING = 'homeroom_bot_proposal_ceiling';
// #4449: Live, a first version shown taking shape while it is built
// (services/first-version-live.js, which reads it through its own short
// cache). On unless switched off: off, no watcher starts and no App tab
// offers it.
const KEY_LIVE_BUILD_STREAM = 'live_build_stream';
const SETTING_KEYS = Object.freeze([
  KEY_MODE, KEY_CONCURRENCY, KEY_BATCH_SIZE, KEY_PAUSED_APPS,
  KEY_TURN_SECONDS, KEY_TURN_INPUT_TOKENS,
  KEY_SHADOW_BUILDS, KEY_BUILD_CONCURRENCY, KEY_SHADOW_BUILD_PLATFORM,
  KEY_USER_WEEKLY_CENTS, KEY_ADMIN_WEEKLY_CENTS, KEY_LIVE_AT_ONCE, KEY_PER_PERSON, KEY_DM_CHAT,
  KEY_VOICE_SESSION, KEY_VOICE_ISSUE, KEY_VOICE_CHAT,
  KEY_CONTINUE_READS, KEY_EVERYONE_SINCE, KEY_PROPOSAL_CEILING,
  KEY_LIVE_BUILD_STREAM,
  ...Object.values(KEY_MODELS),
]);
const MAX_USER_WEEKLY_CENTS = 10_000_000;

// batchSize is how many of ONE app's issues a pass takes before the loop
// looks for the most urgent app again — the fairness knob between apps, not
// a throughput cap: the loop drains continuously (see the cadence below).
// 100 means "finish the app you are on" for any realistic board.
const DEFAULTS = Object.freeze({
  mode: 'off',
  concurrency: 1,
  batchSize: 100,
  pausedApps: [],
  turnSeconds: 20 * 60,
  turnInputTokens: 10_000_000,
  shadowBuilds: false,
  buildConcurrency: 2,
  shadowBuildPlatform: false,
  userWeeklyCents: 5000,
  adminWeeklyCents: 10000,
  // #3654: per-stage models; blank is the platform default (stageModel).
  models: Object.freeze({ triage: '', spec: '', build: '', followup: '' }),
  // Raised from 6 and 2 when every project went live: the background
  // lane's shadow triage, which took workers beside it, has no app left to
  // read in production.
  liveAtOnce: 12,
  perPerson: 3,
  dmChat: true,
  voiceSession: true,
  voiceIssue: true,
  voiceChat: true,
  continueReads: true,
  everyoneSince: null,
  proposalCeiling: 0,
  liveBuildStream: true,
});
const MAX_CONCURRENCY = 4;
const MAX_BUILD_CONCURRENCY = 4;
// Each live turn holds a worker from the pool people's own coding sessions
// use (the worker namespace's quota), so the ceiling stays well under it.
const MAX_LIVE_AT_ONCE = 24;
const MAX_PER_PERSON = 6;
// How many live builds one project may have under way at once. Each build
// is a session and a branch of its own (live.buildAndPropose), so they do
// not share a worker; one at a time made a busy project's ready requests
// (Homeroom's own above all, where a build can take almost two hours) wait
// in a line behind each other. Reads stay one per project: they share the
// project's one session.
const BUILDS_PER_PROJECT = 3;
const MAX_PROPOSAL_CEILING = 1000;
// The automatic ceiling: what twenty live apps
// had under "5 per live app", and well past what 16 builds at once can fill
// in the days a vote takes.
const EVERYONE_PROPOSAL_CEILING = 100;
const MAX_BATCH_SIZE = 500;
// The budget a single triage turn may spend (#2737). Measured over the
// first 213 shadow runs: 7 of the 74 that produced a verdict took $30.04 of
// the $31.40 spent, one of them running 56 minutes for a single verdict,
// and 13 more returned nothing at all after 25 to 149 minutes. The 67 that
// behaved cost $1.36 between them, and 90% finished inside 9 minutes.
//
// Only the clock can STOP a turn (#3035). The token limit was meant to
// catch a turn that burns tokens fast, but neither agent the bot runs
// reports usage until the turn is over, so a token stop can only land on a
// finished turn. It is read after the turn instead: the verdict is kept and
// the overrun logged. The figure is the worker's `inputTokens`, which on
// Codex is the THREAD's running total — meaningful per turn only because
// each triage now starts a fresh thread.
const MIN_TURN_SECONDS = 30;
const MAX_TURN_SECONDS = 3 * 60 * 60;
const MIN_TURN_INPUT_TOKENS = 100_000;
const MAX_TURN_INPUT_TOKENS = 5_000_000_000;

// The bot's own weekly allowance, on its users row like anybody else's.
// $150 to start: at Flash prices a triage is a few cents, so this is a
// ceiling on a runaway loop, not a budget anybody expects to reach.
const DEFAULT_WEEKLY_LIMIT_CENTS = 15000;

// Loop cadence. The loop is EVENT-DRIVEN: an issue filed, edited or
// discussed on the platform calls noteIssueActivity, which queues that app's
// issues and wakes the loop at once (through the ws-bus when the event
// landed on another Pod, since only the leader runs the loop). A pass drains
// one batch; when it did work the next pass follows almost at once, and when
// the queue was empty the loop sleeps until the next wake. The idle delay is
// only a fallback poll for a wake that was lost, and REFRESH_INTERVAL_MS is
// the reconcile sweep for what no event can tell us — an issue opened or
// commented on GitHub directly, a claim that expired — read through
// github.fetchPublicIssues' own cache.
const FIRST_PASS_DELAY_MS = 60 * 1000;
const BUSY_PASS_DELAY_MS = 2 * 1000;
const IDLE_PASS_DELAY_MS = 30 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const BUS_KIND = 'homeroom_bot';
// One turn for a burst. People write a thought in two or three messages, or
// a message and then a bare "@Homeroom bot" (PR #4584, 9 Oct 2026: a message
// and its ping 2 seconds apart were answered twice, 23 seconds apart). A
// reply turn waits until a person's last message on the request, or on the
// bot's change for it, is this old, so it reads them all at once
// (liveCandidates); a wake that long after the message picks it up then
// (wakeAfterSettle).
const SETTLE_MS = 20 * 1000;
// What wakes the loop for a person's words, and so waits to settle.
const SETTLE_REASONS = new Set(['thread', 'proposal_thread']);
// What a person asked for in their DM with the bot queues with one of these
// (homeroom-bot-mayor.js, homeroom-bot-dm.js). One story per request: every
// request gets a card in its requester's chat with the bot, however it was
// asked (homeroom-bot-activity.js startCard); `inDm` says only that its
// thread starts "Filed from our chat."
const DM_REASONS = new Set(['dm_request', 'dm_start', 'dm_answer', 'dm_comment', 'dm_revise', 'plan_change']);

// Eligibility windows. A human claim counts while it is younger than the
// board's own claim TTL; a paused human session counts while it is inside
// the board's in-progress window. Both mirror routes/issues.js.
const CLAIM_TTL_DAYS = 7;
const PAUSED_SESSION_WINDOW_DAYS = 7;

// The live caps the dashboard SIMULATES in shadow mode: a run reports
// whether these would have suppressed it, so the dashboard shows the live
// bot's behaviour and not only the raw model's.
// 5 since #3576: 2 left most of a backlog held, a slot freeing only when
// the group voted.
const PROPOSALS_PER_APP_CAP = 5;
// Questions and `empty` verdicts share this one allowance, so the bot
// cannot answer a quiet board with ten questions AND ten close proposals in
// the same day. Both are a demand on somebody's attention.
const QUESTION_TRIPWIRE_PER_DAY = 10;
const TRIPWIRE_VERDICTS = Object.freeze(['question', 'empty']);

// A session that refuses a turn is backed off per app rather than retried
// on the next wake (#2737). One wedged session produced 121 of 124 refusals
// in the first day, a median of 31 seconds apart, which is the idle poll.
const BACKOFF_BASE_MS = 2 * 60 * 1000;
const BACKOFF_CEILING_MS = 60 * 60 * 1000;
// How far past one turn's budget a claimed queue row counts as abandoned.
const STALE_CLAIM_MARGIN_SECONDS = 10 * 60;
// A build on the platform's own repository gets this many times a build's
// clocks, its spec's and its build turn's (#3396). The repository is far
// larger than any app's: its specs ran past 10 minutes, and a build ran out
// of time on its 92nd model request, in the middle of the test run the
// repository's own instructions ask for, having spent $0.29. Time, not
// money, is what those builds run out of.
//
// 3 since the 2026-10-02 verdicts export: at 2 (40 minutes on the default
// 20-minute turn) half the platform's shadow builds still ran out of time
// (9 built, 9 failed since Oct 1 12:00, against 11 of 16 built on every
// other app), several in the middle of a mapped test run of thousands of
// tests ("The mapping ran 3570 tests with 33 failures"). The build prompt
// now also tells a platform build to run only the suites for the files it
// changed (live.PLATFORM_TEST_NOTE), which is what the repository's own
// instructions ask of every agent; the clock is the margin for a large
// repository's reading and its slower suites, and costs nothing unless a
// build uses it. It is also the longest a build can take, which the stale
// build release and the lost-live-build sweep wait out.
const PLATFORM_BUILD_TIME_FACTOR = 3;
// A project's whole first version (#3624) keeps the factor it had: its
// repository is the small starter template, so only the size of the change
// is larger, not the code it reads or the tests it runs.
const FIRST_VERSION_BUILD_TIME_FACTOR = 2;
// The queue reason of an issue a restart sent back to be looked at again.
const RESTART_REASON = 'restart';
// The queue reason of an issue an admin's "Triage this app again" queued
// (retriageApp). Such a pass takes a whole backlog at once, and the proposal
// cap fills within two builds, so the rest were each told "looking into it"
// and then "held" (9 of the first 24 live runs, #3509). The cap_freed
// refresh already brings a held issue back when there is room, so these
// are triaged without either post: they speak only when they have
// something to say (a question, a spec, a proposal).
const APP_AGAIN_REASON = 'app_again';
// The queue reason of a request whose last verdict a cap held, brought back
// once that cap has room (refreshApp). A held ready verdict is reused then,
// with no new read, when the request has not changed since (reuseHeldVerdict).
const CAP_FREED_REASON = 'cap_freed';
// The queue reason of an issue whose bot proposal's checks settled failing
// on its current head (noteProposalChecks): a follow-up turn fixes them.
const CHECKS_REASON = 'checks_failing';
// The queue reason of a read started over because a person wrote on the
// request while it ran (interruptRead). It was already told the bot is
// looking, and it is never started over a second time.
const READ_AGAIN_REASON = 'read_again';
// The queue reason of a request somebody asked the bot to build from its
// page, or just filed on a project it builds on (homeroom-bot-dm.js
// askBotToBuild, noteRequestFiled).
const ASKED_REASON = 'asked';
// Rows the bot queued for itself rather than for anything on the issue: a
// restart's (#3471), a failing check's, and a read started over. The issue
// has not changed since the bot last looked, which is exactly what a
// refresh reads as "nothing to do", so a refresh keeps them (and their
// reason) while the issue is open and nobody else has it. It used to delete
// a restart's row on the very pass its wake started, which is how a live
// build a restart interrupted was never looked at again (recipebot #48,
// run 613).
const SELF_QUEUED_REASONS = Object.freeze([RESTART_REASON, CHECKS_REASON, READ_AGAIN_REASON]);
// The queue reason of a request whose last triage failed (an unparseable
// reply, a provider error) and has not been tried again on the same thread.
// A failed run counted as having read the thread, so the request waited for
// somebody to post on it: gas-lock #2 failed on a GLM 400 on 2026-10-04 and
// was never read again. It is retried once, quietly (no second "looking"),
// after FAILED_TRIAGE_RETRY_AFTER_MS, and a second failure on the same
// thread is final until something new happens on it.
const RETRY_FAILED_REASON = 'retry_failed';
const FAILED_TRIAGE_TRIES = 2;
const FAILED_TRIAGE_RETRY_AFTER_MS = 30 * 60 * 1000;
// #3703: what runTriage answers when a row the loop started as a follow-up
// (beside other work on its app, see "How much at once") no longer has the
// bot's proposal to follow up on. It touches nothing and is handed back, to
// be taken when the app's own session is free.
const NOT_FOLLOW_UP = 'not_follow_up';

// Bounds on what a verdict may carry into the ledger.
const MAX_FIELD_CHARS = 4000;
const MAX_ERROR_CHARS = 600;

const TRIAGE_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'homeroom-bot-triage.md');

// #3624: a project's first version, filed by the bot from what its creator
// described when they made it (homeroom-bot-dm.js). The repository is the
// starter template, so "a small, bounded change" cannot hold: the whole
// app is the change. Everything else in the ready criteria still does.
//
// #3688: a new app gets a light and a dark look that follow the viewer's
// Homeroom theme. The template already has both; said here so the plan the
// spec and the build work from says so too, rather than leaving a rewrite
// of the template's screen to drop the dark half (or the light one).
//
// #3737: and a look of its own. "Look like the closest existing screen"
// means the starter's placeholder here, and its default palette is nobody's
// look (a starter's zinc and violet are the platform shell's; the Empty
// starter's design kit ships quiet greys and a teal accent to re-point); the
// plan names what the spec then decides (services/prompts.js
// FIRST_VERSION_SPEC_DESIGN_BRIEF).
//
// 7 Oct 2026: as a first sketch, which the spec settles and may replace
// (homeroom-bot-live.js specScopeLines): every first version an Opus 5.5
// spec wrote over this note kept the GLM triage's accent, signature element
// and layout. Its example subjects were two of the App bench's starter
// briefs and are gone; its colours are no longer one accent plus neutrals.
const FIRST_VERSION_NOTE = [
  'THIS REQUEST IS A NEW PROJECT\'S FIRST VERSION. Its creator just made the project and described what it should',
  'be; the repository is still the platform\'s starter template. Read "a small, bounded change" in the `ready`',
  'criteria as "a first version a person can try": the app the description asks for, kept to its core, built on the',
  'template. Every other `ready` criterion still holds. Ask a `question` only for a real blocker, as above, with',
  'suggested answers; otherwise decide, list your choices under `assumptions`, and answer `ready`.',
  'Plan it with a light and a dark look that follow the viewer\'s Homeroom theme and switch live when it changes, as',
  'the template already does: keep the template\'s theme script and give every screen both looks (the platform',
  'conventions\' "New apps: a light and a dark look, following the platform"). Only an app whose one fixed look is the',
  'point, such as a game drawn as its own scene, keeps a single look. Say which in `build_note`, list a single look',
  'under `assumptions` when you choose one, and never ask about it.',
  'Sketch a look of its own, too: the starter\'s screen is placeholder, so there is no existing screen for it to look',
  'like. Say in `build_note` the screen\'s one job and its one primary action, its colours (neutrals, an action colour',
  'and any set of colours the subject itself uses, each working in both looks; not the starter\'s default palette,',
  'unless chosen on purpose), ONE signature element drawn from the app\'s subject, something no other app would have,',
  'and a rough layout. It is a first sketch: the spec that follows settles the look, the layout and the scope, and may',
  'replace any of it. Never ask about them.',
  // The first session's card (services/app-sketch.js): when the request
  // quotes it, its creator has seen a summary of the idea, never a screen.
  // Until 5 October 2026 it was a mock of the main screen, and this said to
  // plan the first version as that screen.
  'When the request quotes the featured card its creator was shown (`design/sketch.json`: an emoji, a tagline and a',
  'few points), read it as a short summary of the description, not a design: it shows no screen, so it sets no layout,',
  'words or colours, and where the two differ the description wins.',
  // 2026-10-04: a sketch's made-up flatmates became a plan's question ("The
  // sketch rotates chores between Maya, Jasper and Sophie. Should you be in
  // the rotation too?") on a project of two real people.
  'Sample names, dates and numbers are placeholders, never facts about the group, and never a `plan` bullet or a',
  '`choices` question. When the app involves the people in its group (whose turn it is, who did what, who sees what),',
  'plan around the project\'s real members, listed under WHO IS IN THIS PROJECT when known, and around new members',
  'joining later; never around people made up for an example.',
  // B6: the creator sees the plan before anything is built, and taps Build
  // it or asks for changes (homeroom-bot-dm.js sendPlanCard). #4046: its
  // card is light, so its lines are a few words each ("Log a run for any
  // day"), not sentences.
  'Its creator sees your plan before anything is built, and taps Build it or asks for changes. So with `ready`, also',
  'give `plan`: 3 to 5 short lines of a few words each, at most 40 characters, saying in their own terms what the',
  'first version will do:',
  'what they will see and can do, with no file names, code, colours or jargon. And give `choices`: at most 2 decisions',
  'you would otherwise make yourself that change what they will see or do, each a plain question with 2 to 4 short',
  '`answers`, the one you suggest first. They can tap another; one they leave goes with yours. Only a choice they would',
  'care about, never the look or the theme. Often there are none: then give `choices` as an empty list.',
  // Newcomer run seven (14 Oct 2026, Club Votes): a plan line settled what
  // a question asked ("Vote yes, no or maybe on each one" beside "How should
  // votes be counted?"), and the spec, bound by both, built a maybe that the
  // creator's answer had ruled out (first-version-plan.js PLAN_SYSTEM).
  'A `plan` line, `build_note` and `assumptions` never settle a point one of the `choices` asks: their answer decides',
  'it. Where a choice decides something, the line says what the app does without the answer ("Vote on each',
  'decision", not "Vote yes, no or maybe on each one"), and `build_note` leaves that point to the answer.',
].join('\n');

/**
 * The first-version note, for a project made from a game starter
 * (services/app-templates.js `bot`, by template id): its repository is a
 * working game, not the empty scaffold, so the plan is the creator's game
 * built by changing it. Null or any other template: FIRST_VERSION_NOTE as
 * it is. Pure; throws when the wording it replaces has moved, so a reworded
 * note fails its test instead of telling a starter's plan its screen is
 * placeholder.
 */
function firstVersionNote(starter = null) {
  const s = starter ? require('./app-templates').botStarter(starter) : null;
  if (!s) return FIRST_VERSION_NOTE;
  const swaps = [
    ['the repository is still the platform\'s starter template.',
      `the repository is already Homeroom's ${s.title}: ${s.bot.what}. It works, live, for everyone in the project.`],
    ['the app the description asks for, kept to its core, built on the\ntemplate.',
      'the game the description asks for, kept to its core, built ON that starter by changing it, never by starting\nover.'],
    ['Sketch a look of its own, too: the starter\'s screen is placeholder, so there is no existing screen for it to look\nlike.',
      'Sketch a look of its own, too: the starter\'s screen works, but wears the design kit\'s default look, not this\ngame\'s.'],
  ];
  const note = swaps.reduce((out, [from, to]) => {
    if (!out.includes(from)) throw new Error(`First-version note wording not found: ${from.slice(0, 60)}`);
    return out.replace(from, to);
  }, FIRST_VERSION_NOTE);
  return [
    note,
    `STARTER: ${s.bot.build} In \`build_note\`, say what of the starter the game keeps and what it changes. In \`plan\``,
    'and `choices`, describe the creator\'s game, never the starter\'s example.',
  ].join('\n');
}

/**
 * The game starter a project was made from, by template id, when its first
 * version builds on one (services/app-templates.js `bot`); else null. Read
 * off the app's row, since the bot's app list does not carry it.
 */
async function starterOfApp(pool, appId) {
  const { rows } = await pool.query('SELECT template FROM apps WHERE id = $1', [appId]);
  const id = rows[0] ? rows[0].template : null;
  return require('./app-templates').botStarter(id) ? id : null;
}

let timer = null;
let stopped = false;
let passInFlight = false;
let lastRefreshAt = 0;
let triagePromptCache = null;
// The config start() was handed, so a wake can schedule a pass itself.
let loopConfig = null;
// appId → { until, attempts }. In memory on purpose: the loop is a
// singleton on the leader, and a restart SHOULD retry immediately — a new
// process is exactly the event most likely to have cleared the wedge.
const appBackoff = new Map();
// "appId:issueNumber" → the same, for a follow-up on the bot's own proposal:
// it runs on the proposal's session, not the app's, so its proposal being
// busy (a before & after shots turn on it, another follow-up) backs off that
// follow-up alone. It used to back off the whole app, reading and building
// included, for up to an hour.
const followUpBackoff = new Map();
// sessionId → when we last killed that session's container on a budget stop
// (#2870). An issue dispatched into the same session while the kill lands
// comes back with an empty reply that has nothing to do with the issue, and
// used to be recorded as a permanent parse failure against it.
const stoppedSessions = new Map();
// What the last pass refused, for the dashboard's loop line. Refusals are
// counted here instead of being written as verdict rows.
let lastRefusals = [];
// A platform fault backs off the WHOLE bot (#3122): the worker quota, a
// missing key or a refused ledger fails every app the same way, and the
// loop used to retry the same issue every 30 seconds, writing a failed row
// each time — 60 rows in 70 minutes while the volume quota was full.
// { attempts, until, error, at }. In memory for the same reason as
// appBackoff: a restart is the event most likely to have cleared it.
let platformFault = null;
// When the bot last freed its own leftover worker volumes.
let lastVolumeSweepAt = 0;
// When it last looked for live builds nothing finished.
let lastLiveSweepAt = 0;
// Apps whose issues changed since the last pass (wake), and whether a full
// reconcile was asked for (the mode was switched on, say). Read and cleared
// at the top of every pass; only meaningful on the Pod running the loop.
const pendingApps = new Set();
let refreshAllRequested = false;
let wakeRequested = false;
// What the last pass did, for the dashboard: a loop that is on but idle
// on budget or on a worker fault should say so rather than show nothing.
// `startedAt` and `ms` say how long it took, and `passStartedAt` is the one
// running now: the live loop's own, not the shadow build lane's
// (lastBuildDrain), which run five (13 Oct 2026) first read it as.
let lastPass = null;
let passStartedAt = null;
// The minute sweep for DM answers a process that died had promised
// (homeroom-bot-mayor.js resumeDeferred).
let deferResumeTimer = null;
const DEFER_RESUME_MS = 60 * 1000;

// Failures the platform, not the model, produced: the worker could not be
// bootstrapped, the bot has no key or model, the ledger refused the turn.
// Retrying the next issue would fail the same way, so the pass stops and
// the loop idles; the queue row is kept for when the fault is cleared.
const INFRA_ERRORS = new Set([
  'backend_disabled', 'credential_required', 'model_required', 'invalid_base_url',
  'agent_context_changed', 'session_busy', 'ledger_start_failed', 'not_a_codex_session',
]);

// ── Settings ─────────────────────────────────────────────────────────────

function parseSettings(rows) {
  const map = new Map((rows || []).map((r) => [r.key, r.value]));
  const mode = MODES.includes(map.get(KEY_MODE)) ? map.get(KEY_MODE) : DEFAULTS.mode;
  const concurrency = clampInt(map.get(KEY_CONCURRENCY), DEFAULTS.concurrency, 1, MAX_CONCURRENCY);
  const batchSize = clampInt(map.get(KEY_BATCH_SIZE), DEFAULTS.batchSize, 1, MAX_BATCH_SIZE);
  let pausedApps = DEFAULTS.pausedApps;
  try {
    const parsed = JSON.parse(map.get(KEY_PAUSED_APPS) || '[]');
    if (Array.isArray(parsed)) pausedApps = parsed.filter((s) => typeof s === 'string').slice(0, 500);
  } catch {
    pausedApps = DEFAULTS.pausedApps;
  }
  const turnSeconds = clampInt(
    map.get(KEY_TURN_SECONDS), DEFAULTS.turnSeconds, MIN_TURN_SECONDS, MAX_TURN_SECONDS,
  );
  const turnInputTokens = clampInt(
    map.get(KEY_TURN_INPUT_TOKENS), DEFAULTS.turnInputTokens,
    MIN_TURN_INPUT_TOKENS, MAX_TURN_INPUT_TOKENS,
  );
  const shadowBuilds = map.get(KEY_SHADOW_BUILDS) === 'on';
  const buildConcurrency = clampInt(
    map.get(KEY_BUILD_CONCURRENCY), DEFAULTS.buildConcurrency, 1, MAX_BUILD_CONCURRENCY,
  );
  const shadowBuildPlatform = map.get(KEY_SHADOW_BUILD_PLATFORM) === 'on';
  const userWeeklyCents = clampInt(
    map.get(KEY_USER_WEEKLY_CENTS), DEFAULTS.userWeeklyCents, 0, MAX_USER_WEEKLY_CENTS,
  );
  const adminWeeklyCents = clampInt(
    map.get(KEY_ADMIN_WEEKLY_CENTS), DEFAULTS.adminWeeklyCents, 0, MAX_USER_WEEKLY_CENTS,
  );
  const models = {};
  for (const stage of MODEL_STAGES) {
    const raw = String(map.get(KEY_MODELS[stage]) || '').trim();
    models[stage] = MODEL_ID_RE.test(raw) ? raw : '';
  }
  const liveAtOnce = clampInt(map.get(KEY_LIVE_AT_ONCE), DEFAULTS.liveAtOnce, 1, MAX_LIVE_AT_ONCE);
  const perPerson = clampInt(map.get(KEY_PER_PERSON), DEFAULTS.perPerson, 1, MAX_PER_PERSON);
  const dmChat = map.get(KEY_DM_CHAT) !== 'off';
  const voiceSession = map.get(KEY_VOICE_SESSION) !== 'off';
  const voiceIssue = map.get(KEY_VOICE_ISSUE) !== 'off';
  const voiceChat = map.get(KEY_VOICE_CHAT) !== 'off';
  const continueReads = map.get(KEY_CONTINUE_READS) !== 'off';
  // Written once by schema.sql; readSettings fills in a database without it.
  const sinceMs = Date.parse(map.get(KEY_EVERYONE_SINCE) || '');
  const everyoneSince = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null;
  const proposalCeiling = clampInt(map.get(KEY_PROPOSAL_CEILING), DEFAULTS.proposalCeiling, 0, MAX_PROPOSAL_CEILING);
  const liveBuildStream = map.get(KEY_LIVE_BUILD_STREAM) !== 'off';
  return {
    mode, concurrency, batchSize, pausedApps, turnSeconds, turnInputTokens,
    shadowBuilds, buildConcurrency, shadowBuildPlatform, userWeeklyCents, adminWeeklyCents,
    liveAtOnce, perPerson, dmChat, voiceSession, voiceIssue, voiceChat, continueReads, models,
    everyoneSince, proposalCeiling, liveBuildStream,
  };
}

// The platform's own project, by slug (#4239: a request about Homeroom
// itself means nothing on Homeroom's own board): its self-hosted row
// (config.js SELF_APP_SLUG, never renamed), and any app on the platform's
// repository. Read at most once a minute: a triage reads it, and which app
// is the platform's does not change. A read that fails keeps the last answer,
// and the fixed slug is left out even before the first one.
const PLATFORM_SELF_APP_SLUG = 'usernode-2d5619';
const PLATFORM_SLUGS_TTL_MS = 60 * 1000;
let platformSlugsCache = null;

async function platformAppSlugs(pool) {
  if (platformSlugsCache && platformSlugsCache.until > Date.now()) return platformSlugsCache.slugs;
  // readSettings is handed no config: the same variables config.js reads
  // for platformRepoUrl, in its order.
  const platformRepoUrl = process.env.USERNODE_PLATFORM_REPO || process.env.USERNODE_REPO_URL || DEFAULT_PLATFORM_REPO_URL;
  const platform = parseRepo(platformRepoUrl);
  try {
    const { rows } = await pool.query(
      "SELECT slug, repo_url, self_hosted FROM apps WHERE self_hosted = TRUE OR repo_url ILIKE '%' || $1 || '%'",
      [platform ? `${platform.owner}/${platform.repo}` : PLATFORM_SELF_APP_SLUG],
    );
    const slugs = [...new Set([
      PLATFORM_SELF_APP_SLUG,
      ...rows.filter((r) => r.self_hosted || isPlatformRepo(r, { platformRepoUrl })).map((r) => r.slug),
    ])];
    platformSlugsCache = { slugs, until: Date.now() + PLATFORM_SLUGS_TTL_MS };
    return slugs;
  } catch (err) {
    log.warn('homeroom-bot', 'platform app read failed', { err: err.message });
    return platformSlugsCache?.slugs || [PLATFORM_SELF_APP_SLUG];
  }
}

/**
 * #3654: the model a stage runs on: the admin's choice for it, else the
 * platform default. One answer for the run that is recorded and the turn
 * that runs (stampSessionModel makes the session agree with it).
 */
function stageModel(settings, config, stage) {
  const chosen = settings?.models?.[stage];
  if (typeof chosen === 'string' && MODEL_ID_RE.test(chosen)) return chosen;
  return (config && config.openrouterDefaultCodexModel) || null;
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function readSettings(pool) {
  try {
    const { rows } = await pool.query(
      'SELECT key, value FROM platform_settings WHERE key = ANY($1)',
      [SETTING_KEYS],
    );
    const settings = parseSettings(rows);
    // schema.sql writes the moment once; a database that has not run it
    // yet counts from now, never from no time at all, which would read
    // every old request.
    if (!settings.everyoneSince) settings.everyoneSince = new Date().toISOString();
    return settings;
  } catch (err) {
    // platform_settings may not exist on a very first boot before migrate()
    // has run; the defaults keep the loop idle, which is the safe answer.
    log.warn('homeroom-bot', 'settings read failed; using defaults', { err: err.message });
    return { ...DEFAULTS };
  }
}

/**
 * Validate an admin's settings patch. Returns { ok, error } or
 * { ok, updates: [[key, value], …], weeklyLimitCents }. `live` is refused
 * here rather than merely ignored: this slice has no live behaviour, and a
 * switch that reads "live" while the bot posts nothing would be a lie.
 */
function validateSettingsPatch(patch) {
  const body = patch || {};
  const updates = [];
  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode)) return { ok: false, error: 'mode must be off, shadow or live' };
    if (body.mode === 'live') {
      return { ok: false, error: 'Live mode is not available yet: this build only triages in shadow mode.' };
    }
    updates.push([KEY_MODE, body.mode]);
  }
  if (body.concurrency !== undefined) {
    const n = Number(body.concurrency);
    if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
      return { ok: false, error: `concurrency must be an integer from 1 to ${MAX_CONCURRENCY}` };
    }
    updates.push([KEY_CONCURRENCY, String(n)]);
  }
  if (body.liveAtOnce !== undefined) {
    const n = Number(body.liveAtOnce);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIVE_AT_ONCE) {
      return { ok: false, error: `liveAtOnce must be an integer from 1 to ${MAX_LIVE_AT_ONCE}` };
    }
    updates.push([KEY_LIVE_AT_ONCE, String(n)]);
  }
  if (body.perPerson !== undefined) {
    const n = Number(body.perPerson);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PER_PERSON) {
      return { ok: false, error: `perPerson must be an integer from 1 to ${MAX_PER_PERSON}` };
    }
    updates.push([KEY_PER_PERSON, String(n)]);
  }
  if (body.dmChat !== undefined) {
    if (typeof body.dmChat !== 'boolean') return { ok: false, error: 'dmChat must be true or false' };
    updates.push([KEY_DM_CHAT, body.dmChat ? 'on' : 'off']);
  }
  for (const [field, key] of [['voiceSession', KEY_VOICE_SESSION], ['voiceIssue', KEY_VOICE_ISSUE], ['voiceChat', KEY_VOICE_CHAT]]) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'boolean') return { ok: false, error: `${field} must be true or false` };
    updates.push([key, body[field] ? 'on' : 'off']);
  }
  if (body.continueReads !== undefined) {
    if (typeof body.continueReads !== 'boolean') return { ok: false, error: 'continueReads must be true or false' };
    updates.push([KEY_CONTINUE_READS, body.continueReads ? 'on' : 'off']);
  }
  if (body.liveBuildStream !== undefined) {
    if (typeof body.liveBuildStream !== 'boolean') return { ok: false, error: 'liveBuildStream must be true or false' };
    updates.push([KEY_LIVE_BUILD_STREAM, body.liveBuildStream ? 'on' : 'off']);
  }
  if (body.proposalCeiling !== undefined) {
    const n = Number(body.proposalCeiling);
    if (!Number.isInteger(n) || n < 0 || n > MAX_PROPOSAL_CEILING) {
      return { ok: false, error: `proposalCeiling must be an integer from 0 (automatic) to ${MAX_PROPOSAL_CEILING}` };
    }
    updates.push([KEY_PROPOSAL_CEILING, String(n)]);
  }
  if (body.turnSeconds !== undefined) {
    const n = Number(body.turnSeconds);
    if (!Number.isInteger(n) || n < MIN_TURN_SECONDS || n > MAX_TURN_SECONDS) {
      return { ok: false, error: `turnSeconds must be an integer from ${MIN_TURN_SECONDS} to ${MAX_TURN_SECONDS}` };
    }
    updates.push([KEY_TURN_SECONDS, String(n)]);
  }
  if (body.turnInputTokens !== undefined) {
    const n = Number(body.turnInputTokens);
    if (!Number.isInteger(n) || n < MIN_TURN_INPUT_TOKENS || n > MAX_TURN_INPUT_TOKENS) {
      return { ok: false, error: `turnInputTokens must be an integer from ${MIN_TURN_INPUT_TOKENS} to ${MAX_TURN_INPUT_TOKENS}` };
    }
    updates.push([KEY_TURN_INPUT_TOKENS, String(n)]);
  }
  if (body.batchSize !== undefined) {
    const n = Number(body.batchSize);
    if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE) {
      return { ok: false, error: `batchSize must be an integer from 1 to ${MAX_BATCH_SIZE}` };
    }
    updates.push([KEY_BATCH_SIZE, String(n)]);
  }
  if (body.pausedApps !== undefined) {
    if (!Array.isArray(body.pausedApps)
        || !body.pausedApps.every((s) => typeof s === 'string' && /^[a-z0-9-]{1,120}$/.test(s))) {
      return { ok: false, error: 'pausedApps must be an array of app slugs' };
    }
    updates.push([KEY_PAUSED_APPS, JSON.stringify([...new Set(body.pausedApps)])]);
  }
  if (body.shadowBuilds !== undefined) {
    if (typeof body.shadowBuilds !== 'boolean') return { ok: false, error: 'shadowBuilds must be true or false' };
    updates.push([KEY_SHADOW_BUILDS, body.shadowBuilds ? 'on' : 'off']);
  }
  if (body.buildConcurrency !== undefined) {
    const n = Number(body.buildConcurrency);
    if (!Number.isInteger(n) || n < 1 || n > MAX_BUILD_CONCURRENCY) {
      return { ok: false, error: `buildConcurrency must be an integer from 1 to ${MAX_BUILD_CONCURRENCY}` };
    }
    updates.push([KEY_BUILD_CONCURRENCY, String(n)]);
  }
  if (body.shadowBuildPlatform !== undefined) {
    if (typeof body.shadowBuildPlatform !== 'boolean') {
      return { ok: false, error: 'shadowBuildPlatform must be true or false' };
    }
    updates.push([KEY_SHADOW_BUILD_PLATFORM, body.shadowBuildPlatform ? 'on' : 'off']);
  }
  if (body.userWeeklyCents !== undefined) {
    const n = Number(body.userWeeklyCents);
    if (!Number.isInteger(n) || n < 0 || n > MAX_USER_WEEKLY_CENTS) {
      return { ok: false, error: 'userWeeklyCents must be a non-negative integer' };
    }
    updates.push([KEY_USER_WEEKLY_CENTS, String(n)]);
  }
  if (body.adminWeeklyCents !== undefined) {
    const n = Number(body.adminWeeklyCents);
    if (!Number.isInteger(n) || n < 0 || n > MAX_USER_WEEKLY_CENTS) {
      return { ok: false, error: 'adminWeeklyCents must be a non-negative integer' };
    }
    updates.push([KEY_ADMIN_WEEKLY_CENTS, String(n)]);
  }
  if (body.models !== undefined) {
    if (!body.models || typeof body.models !== 'object' || Array.isArray(body.models)) {
      return { ok: false, error: 'models must be an object of stage to model id' };
    }
    for (const [stage, value] of Object.entries(body.models)) {
      if (!MODEL_STAGES.includes(stage)) {
        return { ok: false, error: `models: unknown stage "${stage}" (one of ${MODEL_STAGES.join(', ')})` };
      }
      const id = value == null ? '' : String(value).trim();
      if (id && !MODEL_ID_RE.test(id)) {
        return { ok: false, error: `models.${stage} must be an OpenRouter model id such as z-ai/glm-5.3-flash, or blank for the default` };
      }
      updates.push([KEY_MODELS[stage], id]);
    }
  }
  let weeklyLimitCents;
  if (body.weeklyLimitCents !== undefined) {
    const n = Number(body.weeklyLimitCents);
    if (!Number.isInteger(n) || n < 0 || n > 10_000_000) {
      return { ok: false, error: 'weeklyLimitCents must be a non-negative integer' };
    }
    weeklyLimitCents = n;
  }
  if (!updates.length && weeklyLimitCents === undefined) {
    return { ok: false, error: 'Nothing to update' };
  }
  return { ok: true, updates, weeklyLimitCents };
}

async function writeSettings(pool, patch, actorId, config = {}) {
  const valid = validateSettingsPatch(patch);
  if (!valid.ok) return valid;
  let modeBefore = null;
  if (valid.updates.some(([key]) => key === KEY_MODE)) {
    try {
      modeBefore = (await readSettings(pool)).mode;
    } catch {}
  }
  for (const [key, value] of valid.updates) {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [key, value, actorId || null],
    );
  }
  if (valid.updates.some(([key]) => key === KEY_LIVE_BUILD_STREAM)) firstVersionLive().forgetSetting(pool);
  if (valid.weeklyLimitCents !== undefined) {
    // The cap lives on the bot's users row, which the first pass used to be
    // the only thing that created — so a cap saved before that pass updated
    // nothing and the box stayed blank. Create the row first.
    await ensureBotUser(pool, config);
    await pool.query(
      'UPDATE users SET weekly_limit_cents = $1 WHERE username = $2 AND is_synthetic = TRUE',
      [valid.weeklyLimitCents, BOT_USERNAME],
    );
    // The cap the platform enforces is the users row above; the child key's
    // provider-side limit is a backstop and lags until the next sync.
    try {
      const limits = require('./limits');
      limits.invalidate();
    } catch {}
  }
  // More room for live work is used now, not on the next idle pass.
  if (valid.updates.some(([key]) => [KEY_LIVE_AT_ONCE, KEY_PER_PERSON, KEY_CONCURRENCY].includes(key))) {
    wakeAll();
  }
  const modeAfter = valid.updates.find(([key]) => key === KEY_MODE)?.[1];
  if (modeAfter && modeAfter !== 'off' && modeAfter !== modeBefore) {
    // Switched on: rebuild the whole queue now rather than when the next
    // reconcile sweep happens to be due.
    wakeAll();
  }
  // A lane turned on, or given more room, starts its next build now, on
  // whichever Pod is draining it.
  if (valid.updates.some(([key]) => key === KEY_SHADOW_BUILDS || key === KEY_BUILD_CONCURRENCY)) {
    wakeBuilds();
    publishWake({ builds: true });
  }
  return { ok: true };
}

// ── Identity ─────────────────────────────────────────────────────────────

/**
 * The bot's users row, created on first use. Synthetic like demo mode's
 * partner: a random discarded password, no admin bit, no app quota, and
 * routes/auth.js refuses the row at login. Its company-funded OpenRouter
 * key is minted through the same path every account's is; a refusal there
 * is logged and retried on the next pass rather than failing the loop.
 */
async function ensureBotUser(pool, config = {}) {
  const { rows: found } = await pool.query(
    'SELECT id, username, weekly_limit_cents FROM users WHERE username = $1',
    [BOT_USERNAME],
  );
  let bot = found[0] || null;
  if (bot && !(await isSynthetic(pool, bot.id))) {
    // A person registered the name before the bot existed. Never adopt a
    // real account as the bot.
    throw new Error(`users row '${BOT_USERNAME}' exists and is not synthetic`);
  }
  if (!bot) {
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    await pool.query(
      // daily_limit_cents is set too: #2571 stopped applying the daily cap,
      // but a per-user override is still what marks an account as having
      // its allowance decided by an admin rather than by a verified identity
      // (limits.getUserCreditEntitlement), and the bot has no identity.
      `INSERT INTO users (username, password, is_admin, can_create_apps, is_synthetic,
                          weekly_limit_cents, daily_limit_cents)
       VALUES ($1, $2, FALSE, FALSE, TRUE, $3, $3)
       ON CONFLICT (username) DO NOTHING`,
      [BOT_USERNAME, hash, DEFAULT_WEEKLY_LIMIT_CENTS],
    );
    const { rows } = await pool.query(
      'SELECT id, username, weekly_limit_cents FROM users WHERE username = $1',
      [BOT_USERNAME],
    );
    bot = rows[0];
    if (!bot) throw new Error(`Could not create the ${BOT_USERNAME} user`);
    log.info('homeroom-bot', 'Bot user created', { userId: bot.id });
  }
  if (bot.weekly_limit_cents == null) {
    await pool.query('UPDATE users SET weekly_limit_cents = $1 WHERE id = $2',
      [DEFAULT_WEEKLY_LIMIT_CENTS, bot.id]);
    bot.weekly_limit_cents = DEFAULT_WEEKLY_LIMIT_CENTS;
  }
  // B5: the name people see it by; its username stays what it is.
  await pool.query(
    'UPDATE users SET display_name = $2 WHERE id = $1 AND display_name IS DISTINCT FROM $2',
    [bot.id, BOT_DISPLAY_NAME],
  ).catch((err) => log.warn('homeroom-bot', 'Could not name the bot', { err: err.message }));
  try {
    const managedOpenRouter = require('./openrouter-managed-keys');
    const key = await managedOpenRouter.ensureIncludedKey({
      pool, userId: bot.id, config, reason: 'homeroom_bot',
    });
    if (key?.created) log.info('homeroom-bot', 'Included OpenRouter key issued to the bot', { userId: bot.id });
  } catch (err) {
    log.warn('homeroom-bot', 'Included key check failed', { err: err.message });
  }
  return bot;
}

async function isSynthetic(pool, userId) {
  const { rows } = await pool.query('SELECT is_synthetic FROM users WHERE id = $1', [userId]);
  return rows[0]?.is_synthetic === true;
}

// ── Verdict parsing (pure) ──────────────────────────────────────────────

// How many `{` from the end of a reply are tried as the start of its verdict
// object, and the longest object read from one: a reply is working notes and
// one block, and neither bound is near what a verdict needs.
const MAX_OBJECT_STARTS = 500;
const MAX_OBJECT_CHARS = 64 * 1024;

function clip(value, max = MAX_FIELD_CHARS) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The verdict is the LAST complete JSON object in the agent's final message
 * that carries one of the verdicts, fenced or not; anything before it is
 * working notes. A message with no such object yields null and the run is
 * recorded as `failed` with the tail of the text — never a guessed verdict.
 */
// A posted question is for a real blocker only. The triage names which one
// and why its default could waste the build; the two blockers are these.
const BLOCKERS = Object.freeze(['user_facing', 'impossible']);
const MAX_ASSUMPTIONS = 12;

function parseAssumptions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((a) => clip(typeof a === 'string' ? a.replace(/\s+/g, ' ') : '', 300))
    .filter(Boolean)
    .slice(0, MAX_ASSUMPTIONS);
}

/** The build note, with the choices the triage made written under it. */
function noteWithAssumptions(note, assumptions) {
  if (!assumptions.length) return note;
  return clip(`${note || ''}\n\nAssumptions:\n${assumptions.map((a) => `- ${a}`).join('\n')}`.trim());
}

/**
 * #3624: a question's suggested answers, as the DM offers them: two to
 * four short distinct lines, the default first (added when the model left
 * it out), each at most SUGGESTED_ANSWER_MAX characters. Never empty when
 * there is a default: every question offers at least that.
 */
const SUGGESTED_ANSWER_MAX = 120;
const MAX_SUGGESTED_ANSWERS = 4;
function suggestedAnswers(raw, fallback = null) {
  const out = [];
  const add = (value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > SUGGESTED_ANSWER_MAX) return;
    if (out.some((a) => a.toLowerCase() === text.toLowerCase())) return;
    out.push(text);
  };
  const short = String(fallback || '').replace(/\s+/g, ' ').trim();
  if (short && short.length <= SUGGESTED_ANSWER_MAX) add(short);
  for (const value of Array.isArray(raw) ? raw : []) {
    if (typeof value === 'string') add(value);
    if (out.length >= MAX_SUGGESTED_ANSWERS) break;
  }
  return out;
}

// B6: a plan its person sees before anything is built: at most this many
// bullets, each at most this long (the prompt asks for 80), and at most two
// questions, each with two to four answers (the suggested one first).
const MAX_PLAN_BULLETS = 5;
const PLAN_BULLET_MAX = 120;
const MAX_PLAN_QUESTIONS = 2;
const PLAN_QUESTION_MAX = 300;

/** Pure (B6): a plan's bullets, plain one-liners, from what the read returned. */
function planBullets(raw) {
  const out = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    if (typeof value !== 'string') continue;
    const text = value.replace(/\s+/g, ' ').replace(/^[-*•]\s*/, '').trim();
    if (!text) continue;
    out.push(text.length > PLAN_BULLET_MAX ? `${text.slice(0, PLAN_BULLET_MAX - 1).trimEnd()}…` : text);
    if (out.length >= MAX_PLAN_BULLETS) break;
  }
  return out;
}

/** Pure (B6): one question a person answers by tapping, or null: a question and two answers at least. */
function planQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const question = String(raw.question || '').replace(/\s+/g, ' ').trim();
  const answers = suggestedAnswers(raw.answers, raw.default);
  if (!question || question.length > PLAN_QUESTION_MAX || answers.length < 2) return null;
  return { question, answers };
}

/** Pure (B6): the questions of a plan, at most two. */
function planQuestions(raw) {
  const out = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const q = planQuestion(value);
    if (q && !out.some((o) => o.question.toLowerCase() === q.question.toLowerCase())) out.push(q);
    if (out.length >= MAX_PLAN_QUESTIONS) break;
  }
  return out;
}

/**
 * 5 Oct 2026: what a verdict says to people (its question and the answers
 * to tap, a first version's plan, why a person should decide or why there
 * is nothing to build) without em dashes, whatever the model wrote
 * (em-dashes.js). Pure.
 */
function plainVerdict(v) {
  if (!v) return v;
  const plain = (t) => (typeof t === 'string' ? withoutEmDashes(t) : t);
  return {
    ...v,
    question: plain(v.question),
    questionDefault: plain(v.questionDefault),
    questionAnswers: Array.isArray(v.questionAnswers) ? v.questionAnswers.map(plain) : v.questionAnswers,
    plan: v.plan ? {
      bullets: v.plan.bullets.map(plain),
      questions: v.plan.questions.map((q) => ({ question: plain(q.question), answers: q.answers.map(plain) })),
    } : v.plan,
    reason: plain(v.reason),
  };
}

function parseVerdict(text) {
  return plainVerdict(readVerdict(text));
}

// How much of a reply whose verdict could not be read is kept on its run:
// its start (what it set out to do) and its end (where a verdict block
// would be). The run's error line keeps only a short tail.
const KEPT_REPLY_HEAD_CHARS = 4 * 1024;
const KEPT_REPLY_TAIL_CHARS = 12 * 1024;

/**
 * A reply kept for an admin to read: { text, chars }, the text whole when it
 * fits, else its first and last characters around a line saying how many
 * were left out; `chars` is the whole reply's length. Null for no reply.
 * Pure.
 */
function keptReply(value) {
  const text = String(value == null ? '' : value);
  if (!text.trim()) return null;
  const chars = text.length;
  if (chars <= KEPT_REPLY_HEAD_CHARS + KEPT_REPLY_TAIL_CHARS) return { text, chars };
  const left = chars - KEPT_REPLY_HEAD_CHARS - KEPT_REPLY_TAIL_CHARS;
  return {
    text: `${text.slice(0, KEPT_REPLY_HEAD_CHARS)}\n\n[… ${left} characters left out …]\n\n${text.slice(-KEPT_REPLY_TAIL_CHARS)}`,
    chars,
  };
}

/** A run's unreadable_reply: the reply, and the repair turn's reply if one was asked for. Null when neither has text. */
function unreadableReplyOf(reply, repair = null) {
  const kept = { reply: keptReply(reply), repair: keptReply(repair) };
  return kept.reply || kept.repair ? kept : null;
}

// The fixed issue number that marks the staging run below.
const STAGING_UNREADABLE_ISSUE = 936711;

/**
 * Staging only (USERNODE_ENV), idempotent, and never throws: one obviously
 * fake failed triage whose reply had no verdict block, with the reply and the
 * repair turn's reply kept as keptReply keeps them, so a preview of the
 * console's run row has an unreadable reply to show. Run on a running app,
 * under an issue number no request has.
 */
async function seedStagingUnreadableReply(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return false;
  try {
    const { rows: [have] } = await pool.query(
      'SELECT 1 FROM homeroom_bot_runs WHERE issue_number = $1 LIMIT 1', [STAGING_UNREADABLE_ISSUE],
    );
    if (have) return false;
    const { rows: [app] } = await pool.query("SELECT id FROM apps WHERE status = 'running' ORDER BY id LIMIT 1");
    if (!app) return false;
    const reply = [
      'Staging demo: I read the request and the files it names.',
      'The change is small and bounded: one button, no schema, nothing anyone else is working on.',
      'So it can be built now. Verdict below.',
    ].join('\n\n');
    const repair = 'Staging demo: it is ready to build, as I said.';
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, model, cost_usd, duration_ms, error, created_at)
       VALUES ($1, $2, 'shadow', 'failed', 'staging/demo', 0.02, 95000, $3, NOW() - INTERVAL '1 hour')
       RETURNING id`,
      [app.id, STAGING_UNREADABLE_ISSUE, `unparseable: ${clip(reply.slice(-300), 300)}`],
    );
    await pool.query('UPDATE homeroom_bot_runs SET unreadable_reply = $2 WHERE id = $1',
      [run.id, JSON.stringify(unreadableReplyOf(reply, repair))]);
    return true;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not seed the staging unreadable reply', { err: err.message });
    return false;
  }
}

/**
 * Every JSON object a reply holds, as text, the one that ends last first
 * (and, of two that end together, the outer one). Each `{` is matched to its
 * own closing brace with strings and escapes respected, so a verdict is
 * found whatever surrounds it. Reading only fenced blocks, with the first
 * `{` to the last `}` as a fallback taken only when there was no fence at
 * all, lost the verdict whenever the notes quoted code in a fence of their
 * own or used a brace, and whenever the block's closing fence never came.
 * A `{` in prose that is never closed is no object. Pure.
 */
function jsonObjectSpans(raw) {
  const starts = [];
  for (let i = raw.indexOf('{'); i !== -1; i = raw.indexOf('{', i + 1)) starts.push(i);
  const spans = [];
  for (const start of starts.slice(-MAX_OBJECT_STARTS)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    const stop = Math.min(raw.length, start + MAX_OBJECT_CHARS);
    for (let j = start; j < stop; j += 1) {
      const c = raw[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === '{') {
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          spans.push({ start, end: j + 1 });
          break;
        }
      }
    }
  }
  spans.sort((a, b) => (b.end - a.end) || (a.start - b.start));
  return spans.map(({ start, end }) => raw.slice(start, end));
}

function readVerdict(text) {
  const candidates = jsonObjectSpans(String(text || ''));
  for (const candidate of candidates) {
    let obj;
    try { obj = JSON.parse(candidate); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    let verdict = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : '';
    if (!VERDICTS.includes(verdict)) continue;
    const missing = clip(obj.missing_fact, 1000);
    const assumptions = parseAssumptions(obj.assumptions);
    const blocker = typeof obj.blocker === 'string' ? obj.blocker.trim().toLowerCase() : '';
    const whyDefaultFails = clip(obj.why_default_fails, 1000);
    let demoted = null;
    if (verdict === 'question' && !(BLOCKERS.includes(blocker) && whyDefaultFails)) {
      // A question that cannot say which blocker it is, or why its own
      // default would fail, is a choice the bot makes itself: it is built
      // with that default, written down as an assumption. Only when there
      // is no plan to build from does it stay a question.
      const question = clip(obj.question, 500);
      const fallback = clip(obj.default, 500);
      if (clip(obj.build_note) && fallback) {
        verdict = 'ready';
        demoted = { question, default: fallback };
        assumptions.unshift(`${fallback} (the triage asked "${question}", but it was not a blocker)`);
        if (assumptions.length > MAX_ASSUMPTIONS) assumptions.length = MAX_ASSUMPTIONS;
      }
    }
    const questionDefault = verdict === 'question' ? clip(obj.default, 1000) : null;
    const questionAnswers = verdict === 'question' ? suggestedAnswers(obj.answers, questionDefault) : null;
    // B6: a ready verdict's plan (a first version's, for its creator to see
    // before it is built), or a question verdict's second question.
    let plan = null;
    if (verdict === 'ready') {
      const bullets = planBullets(obj.plan);
      if (bullets.length) plan = { bullets, questions: planQuestions(obj.choices) };
    } else if (verdict === 'question') {
      const first = planQuestion({ question: clip(obj.question, PLAN_QUESTION_MAX), answers: questionAnswers });
      const second = planQuestion(obj.second_question);
      if (first && second && second.question.toLowerCase() !== first.question.toLowerCase()) {
        plan = { bullets: [], questions: [first, second] };
      }
    }
    return {
      verdict,
      determined: typeof obj.determined === 'boolean' ? obj.determined : null,
      missingFact: missing && /^none\.?$/i.test(missing) ? null : missing,
      question: verdict === 'question' ? clip(obj.question, 2000) : null,
      questionDefault,
      // #3624: the replies a person can tap to answer, the default first.
      questionAnswers,
      plan,
      buildNote: verdict === 'ready' ? noteWithAssumptions(clip(obj.build_note), assumptions) : null,
      assumptions: verdict === 'ready' ? assumptions : [],
      // `person` says which criterion fails; `empty` says what a person
      // should do with a request that has nothing in it; a `question` says
      // which blocker it is and why its default could waste the build; a
      // `ready` that was asked as a question says so. Same field.
      reason: (verdict === 'person' || verdict === 'empty') ? clip(obj.reason, 2000)
        : verdict === 'question' ? (BLOCKERS.includes(blocker) && whyDefaultFails ? `${blocker}: ${whyDefaultFails}` : null)
          : demoted ? clip(`Asked "${demoted.question}", but it was not a blocker: built with its default, "${demoted.default}".`, 2000)
            : null,
      demoted: !!demoted,
      // #4488: a ready change on an existing app that is checked with its
      // requester before it is built (a plan card first), and whose screens
      // are reviewed once it is. Only a ready verdict carries it; a first
      // version is always planned with its creator and drops it (actOnVerdict).
      complicated: verdict === 'ready' && obj.complicated === true,
      // #4239: a request the bot leaves because it is about Homeroom itself,
      // not the app it was filed on. Only a person verdict carries it.
      platform: verdict === 'person' && obj.platform === true,
      // A request whose ask is already there (in the app, or done by a merged
      // change): its requester is offered a vote on closing it, not left at a
      // "person decides" with nothing to decide. A person or empty verdict
      // carries it; one about Homeroom itself is offered the move instead.
      done: (verdict === 'person' || verdict === 'empty') && obj.done === true && obj.platform !== true,
      stopMentioning: live.parseStopMentioning(obj.stop_mentioning),
      resumeMentioning: live.parseStopMentioning(obj.resume_mentioning),
    };
  }
  return null;
}

// ── Eligibility (pure) ──────────────────────────────────────────────────

function toMs(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Decide whether one open issue should be queued, and at what priority.
 *
 *   issue        a normalized GitHub issue ({ number, updatedAt, ... })
 *   threadLastAt newest Homeroom discussion message on it, or null
 *   busy         true when a person has a live claim, session or proposal
 *                on it — the bot never competes with a human who started
 *   lastRun      the bot's most recent run on it ({ thread_seen_at,
 *                cap_suppressed, live_building }), or null
 *
 * `threadSeenAt` is the newest activity the bot knows of. A run is only
 * worth repeating when something happened after the last one saw it, or
 * (#3152) when a live cap held its verdict: that issue comes back as `held`,
 * naming the cap, and refreshApp decides whether the cap has room again.
 *
 * A request whose live build is waiting its turn or under way
 * (`live_building`, lastRunsByIssue) is the bot's own work in progress, and
 * is not read again until that build ends. The build posts its spec on the
 * issue as it goes, which moves the issue's updated_at, and records what it
 * has seen only once it is over: read as a change, the request was read
 * again mid-build and built twice (Plant Pal #1 and #3, 2026-10-03).
 */
function classifyIssue({ issue, threadLastAt = null, busy = false, lastRun = null, now = Date.now() }) {
  if (!issue || !Number.isInteger(issue.number)) return { eligible: false, reason: 'invalid' };
  if (issue.state && issue.state !== 'open') return { eligible: false, reason: 'closed' };
  if (busy) return { eligible: false, reason: 'in_progress' };
  if (lastRun?.live_building) return { eligible: false, reason: 'building' };
  const seenMs = Math.max(toMs(issue.updatedAt), toMs(issue.createdAt), toMs(threadLastAt));
  const threadSeenAt = seenMs ? new Date(seenMs).toISOString() : null;
  if (lastRun) {
    const lastSeenMs = toMs(lastRun.thread_seen_at);
    if (lastSeenMs && seenMs <= lastSeenMs) {
      if (lastRun.cap_suppressed) {
        return { eligible: false, reason: 'held', cap: lastRun.cap_suppressed, threadSeenAt };
      }
      // A failed read is not a read: tried once more, a while later
      // (RETRY_FAILED_REASON). `failed_tries` counts the failed runs that saw
      // this same thread (lastRunsByIssue).
      const failedAt = toMs(lastRun.created_at);
      if (lastRun.verdict === 'failed' && Number(lastRun.failed_tries || 0) < FAILED_TRIAGE_TRIES
          && (!failedAt || now - failedAt >= FAILED_TRIAGE_RETRY_AFTER_MS)) {
        return { eligible: true, reason: RETRY_FAILED_REASON, priority: 3, threadSeenAt };
      }
      return { eligible: false, reason: 'unchanged', threadSeenAt };
    }
    // What moved past the last read: the GitHub issue (any comment, edit or
    // label moves its updated_at) or a person's message on Homeroom. Kept
    // on the run as its read_reason, so a request read again and again says
    // why.
    const changedBy = toMs(threadLastAt) > lastSeenMs && toMs(threadLastAt) >= toMs(issue.updatedAt) ? 'discussion' : 'github';
    return { eligible: true, reason: 'changed', priority: 2, threadSeenAt, changedBy };
  }
  return { eligible: true, reason: 'new', priority: 1, threadSeenAt };
}

function parseRepo(url) {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// ── The queue ───────────────────────────────────────────────────────────

// The projects the refresh reads: every one that runs on a repository, and
// (newcomer run nine, 15 Oct 2026) one still being set up whose first
// version the bot builds is filed (homeroom-bot-dm.js FILEABLE_SQL files it
// once its repository holds the starter), so its request is read while the
// starter is built and deployed, not once it runs.
async function listApps(pool) {
  const { rows } = await pool.query(
    `SELECT id, slug, name, repo_url, self_hosted
       FROM apps
      WHERE status = 'running' AND repo_url IS NOT NULL
         OR (status = 'creating' AND repo_url IS NOT NULL AND EXISTS (
           SELECT 1 FROM homeroom_bot_first_versions fv
            WHERE fv.app_id = apps.id AND fv.bot_builds AND fv.status = 'filed'))
      ORDER BY id`,
  );
  return rows;
}

/**
 * Everything that makes an issue "somebody's": a live human claim (#4190:
 * one made before the bot was on the request; see below), a live
 * non-synthetic session that declared it, a human auto-solve run on it, or
 * an open proposal addressing it. One query per kind, per app.
 *
 * #3751: who, and since when, by issue number: each hold is { kind: 'claim'
 * | 'session' | 'proposal', username, since }, so a mention of the bot on a
 * held request can be told who holds it (homeroom-bot-holds.js).
 */
async function issueHolders(pool, appId) {
  const holders = new Map();
  const add = (rows, kindOf) => {
    for (const r of rows) {
      if (r.n == null) continue;
      const n = Number(r.n);
      if (!holders.has(n)) holders.set(n, []);
      holders.get(n).push({ kind: kindOf(r), username: r.username || null, since: r.since || null });
    }
  };
  const sessionKind = (r) => (r.status === 'promoted' || r.status === 'merging' ? 'proposal' : 'session');
  // #4190: a claim made once the bot was already on the request is a person
  // working on it ALONGSIDE the bot, not a hold: the bot keeps going and
  // delivers. "On it" is what the request page shows as the bot's work
  // (homeroom-bot-progress.js botWorkByIssue): a request somebody asked it to
  // build (a priority-0 row), one it has started reading (a started row), and
  // a live build waiting its turn or under way, or a plan waiting for its
  // Build it, measured from when that run's read began. A claim made before
  // any of those still holds the bot off, as before; and once the bot's run
  // is over, the claim is an ordinary one again.
  const claims = await pool.query(
    `SELECT ic.github_issue_number AS n, u.username, ic.claimed_at AS since
       FROM issue_claims ic JOIN users u ON u.id = ic.user_id
      WHERE ic.app_id = $1 AND u.is_synthetic IS NOT TRUE
        AND ic.claimed_at > NOW() - make_interval(days => $2)
        AND NOT EXISTS (
          SELECT 1 FROM homeroom_bot_queue q
           WHERE q.app_id = ic.app_id AND q.issue_number = ic.github_issue_number
             AND (CASE WHEN q.priority = 0 THEN q.enqueued_at ELSE q.started_at END) <= ic.claimed_at)
        AND NOT EXISTS (
          SELECT 1 FROM homeroom_bot_runs r
           WHERE r.app_id = ic.app_id AND r.issue_number = ic.github_issue_number
             AND r.mode = 'live' AND r.build_ok IS NULL AND r.proposal_session_id IS NULL
             AND ((r.verdict = 'ready' AND (r.live_build_waiting_at IS NOT NULL OR r.build_session_id IS NOT NULL)
                   AND r.created_at > NOW() - make_interval(days => $3))
                  OR r.awaiting_go_at IS NOT NULL)
             AND r.created_at - make_interval(secs => COALESCE(r.duration_ms, 0) / 1000.0) <= ic.claimed_at)`,
    [appId, CLAIM_TTL_DAYS, ABANDONED_LIVE_WINDOW_DAYS],
  );
  add(claims.rows, () => 'claim');
  const linked = await pool.query(
    `SELECT u.username, cs.status, COALESCE(cs.last_activity_at, cs.created_at) AS since, UNNEST(cs.linked_issues) AS n
       FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND u.is_synthetic IS NOT TRUE
        AND cardinality(cs.linked_issues) > 0
        AND (cs.status IN ('active', 'promoted', 'merging')
             OR (cs.status = 'paused'
                 AND cs.last_activity_at > NOW() - make_interval(days => $2)))`,
    [appId, PAUSED_SESSION_WINDOW_DAYS],
  );
  add(linked.rows, sessionKind);
  const headless = await pool.query(
    `SELECT cs.headless_issue_number AS n, u.username, COALESCE(cs.last_activity_at, cs.created_at) AS since
       FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND u.is_synthetic IS NOT TRUE
        AND cs.is_headless = TRUE AND cs.headless_status IN ('generating', 'ready')`,
    [appId],
  );
  add(headless.rows, () => 'session');
  const created = await pool.query(
    `SELECT cs.created_from_issue_number AS n, u.username, cs.status, COALESCE(cs.last_activity_at, cs.created_at) AS since
       FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND u.is_synthetic IS NOT TRUE
        AND cs.created_from_issue_number IS NOT NULL
        AND cs.status IN ('active', 'promoted', 'merging')`,
    [appId],
  );
  add(created.rows, sessionKind);
  return holders;
}

/**
 * When a person last wrote in one request's discussion: threadActivityByIssue
 * for a single request, read the same way, so a run that records it agrees
 * with the refresh that compares against it.
 */
async function personActivityAt(pool, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT MAX(m.created_at) AS last_at
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = $2
        AND m.msg_type = 'message' AND u.is_synthetic IS NOT TRUE`,
    [appId, issueNumber],
  );
  return rows[0]?.last_at || null;
}

async function threadActivityByIssue(pool, appId) {
  const { rows } = await pool.query(
    // #3288: the bot's own posts are ordinary messages now, so "a person
    // answered" has to say person: a synthetic author is never one.
    `SELECT m.thread_ref AS n, MAX(m.created_at) AS last_at
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.msg_type = 'message'
        AND u.is_synthetic IS NOT TRUE
      GROUP BY m.thread_ref`,
    [appId],
  );
  return new Map(rows.map((r) => [Number(r.n), r.last_at]));
}

/**
 * #3264: the newest person's message in the discussion of each of the bot's
 * open proposals on this app, by the issue it answers. Messages only
 * (`msg_type = 'message'`), so the promote and vote-reset notices never
 * re-queue it, and from people only (#3288): the bot's own replies there are
 * ordinary messages too.
 */
async function proposalThreadActivityByIssue(pool, appId, botId) {
  const { rows } = await pool.query(
    `SELECT n, MAX(m.created_at) AS last_at
       FROM chat_sessions cs
       CROSS JOIN LATERAL UNNEST(cs.linked_issues) AS n
       JOIN chat_messages m
         ON m.app_id = cs.app_id AND m.thread_type = 'session' AND m.thread_ref = cs.id
        AND m.msg_type = 'message' AND m.deleted_at IS NULL
       LEFT JOIN users author ON author.id = m.user_id
      WHERE cs.app_id = $1 AND cs.user_id = $2 AND cs.status = 'promoted'
        AND author.is_synthetic IS NOT TRUE
      GROUP BY n`,
    [appId, botId],
  );
  return new Map(rows.map((r) => [Number(r.n), r.last_at]));
}

function latestOf(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return toMs(a) >= toMs(b) ? a : b;
}

/**
 * The run each issue was last judged by, for the "unchanged since" check.
 *
 * Two kinds of row are not a judgement of the issue and are skipped (#3035):
 * a turn killed as collateral from a stop on the same session, and a turn
 * discarded by the token check between #2870 and #3035, which fired on every
 * finished turn because it compared a whole conversation's running total.
 * Counting either as "seen" left the issue unchanged-since-its-last-run and
 * so never queued again, which is how issues dropped out without a verdict.
 * Skipping them puts those issues back on the next refresh; no new rows of
 * either kind are written once the causes are gone, so the filter is a
 * recovery that costs nothing afterwards.
 *
 * `live_building`: that run is a live build waiting its turn or under way
 * (classifyIssue), as liveCandidates reads it. One older than the window a
 * build from before builds were durable is asked for again in
 * (requeueLegacyBuilds) holds nothing.
 */
async function lastRunsByIssue(pool, appId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (issue_number) issue_number, thread_seen_at, verdict, cap_suppressed, created_at, mode,
            (mode = 'live' AND verdict = 'ready' AND build_ok IS NULL AND proposal_session_id IS NULL
             AND (live_build_waiting_at IS NOT NULL OR build_session_id IS NOT NULL)
             AND created_at > NOW() - make_interval(days => $2)) AS live_building,
            -- Failed runs that read this same thread (RETRY_FAILED_REASON).
            (SELECT count(*)::int FROM homeroom_bot_runs f
              WHERE f.app_id = r.app_id AND f.issue_number = r.issue_number AND f.verdict = 'failed'
                AND f.thread_seen_at IS NOT DISTINCT FROM r.thread_seen_at) AS failed_tries
       FROM homeroom_bot_runs r
      WHERE app_id = $1
        AND budget_stop IS DISTINCT FROM 'input tokens'
        AND (error IS NULL OR error NOT LIKE 'collateral:%')
      ORDER BY issue_number, created_at DESC`,
    [appId, ABANDONED_LIVE_WINDOW_DAYS],
  );
  return new Map(rows.map((r) => [Number(r.issue_number), r]));
}

/**
 * One refresh of one app's slice of the queue. Returns what it did so a
 * test can drive it directly. `github` is injectable for the same reason.
 *
 * `capRoom` (#3152) is how many more verdicts each live cap would let
 * through on this app right now, from capRoomFor; null on a shadow app.
 * An unchanged issue whose last verdict a cap held comes back once that
 * cap has room: oldest hold first, and no more of them than there is room
 * for, so a merged proposal brings back one held build rather than all of
 * them at once.
 */
async function refreshApp(pool, app, {
  github = require('./github'), capRoom = null, bot = null, ws = null, notifications = null, everyoneSince = null,
  settings = null, dm = null,
} = {}) {
  const repo = parseRepo(app.repo_url);
  const out = { app: app.slug, queued: 0, removed: 0, skipped: null };
  if (!repo) { out.skipped = 'no_repo'; return out; }
  const fetched = await github.fetchPublicIssues(repo.owner, repo.repo);
  const issues = Array.isArray(fetched?.issues) ? fetched.issues : [];
  if (!issues.length && fetched?.note) { out.skipped = 'github_unavailable'; return out; }

  // A proposal of the bot's for requests closed on GitHub, where Homeroom
  // gets no signal (a person's change and a close vote withdraw theirs as
  // they close: homeroom-bot-closed-requests.js), is withdrawn here, and the
  // slot it held goes to a held request in this same refresh. Live apps
  // only, and only from a whole, fresh list; GitHub then confirms each close.
  if (capRoom && bot && !fetched?.note && !fetched?.truncatedList) {
    const { withdrawn } = await closedRequests().sweepClosedRequests(pool, {
      appId: app.id, openNumbers: issues.map((issue) => Number(issue.number)), deps: { github },
    });
    if (withdrawn.length) capRoom = await capRoomFor(pool, bot, app.id, settings);
  }

  // #3264: on a live app (capRoom is set only there) a person's reply in the
  // discussion of the bot's own open proposal is activity on its issue, so
  // it comes back for a follow-up.
  // #3624: an imported project is live from the start, but the issues it
  // arrived with are new to nobody: each is judged
  // as if the bot had seen it at the import, so it waits until something
  // happens on it, rather than the whole backlog being worked at once.
  // "Triage again" on the admin screen takes all of them.
  const [holders, threads, lastRuns, proposalThreads, importedAt] = await Promise.all([
    issueHolders(pool, app.id),
    threadActivityByIssue(pool, app.id),
    lastRunsByIssue(pool, app.id),
    // With the bot's voice on in changes' discussions, what people say there
    // is the voice's to answer: it brings nothing back (homeroom-bot-voice.js).
    capRoom && bot && !voiceModule(null).voiceOn(settings, { type: 'session' })
      ? proposalThreadActivityByIssue(pool, app.id, bot.id) : new Map(),
    capRoom ? require('./homeroom-bot-dm').importedAt(pool, app.id).catch(() => null) : null,
  ]);
  const backlogUntil = toMs(importedAt);
  // The moment the bot went on for everyone (KEY_EVERYONE_SINCE), on a live
  // app: what the bot had not read live before it is judged as if it had
  // read it then, as an import's backlog is just above. A request nobody has touched
  // since waits for somebody to (a comment, an answer, "Ask Homeroom bot to
  // build this"); one the bot only read in the background is read again only
  // when something new happens on it. Without this, the first refresh after
  // that moment would read, and build, every open request on every app.
  const everyoneMs = capRoom ? toMs(everyoneSince) : 0;
  // #3751: on a live app, a mention of the bot on a request a person holds
  // is answered (who holds it, and how to ask it to go ahead anyway), and a
  // go-ahead lets the bot take the request up after all.
  const busy = new Set(holders.keys());
  if (capRoom && bot && busy.size) {
    const cleared = await require('./homeroom-bot-holds').answerMentions(pool, {
      app, repo, github, bot, holders, deps: { ws, notifications },
    });
    for (const n of cleared) busy.delete(n);
  }

  const eligible = [];
  const held = [];
  // Open and nobody else's: where a row the bot queued for itself may stay.
  const quiet = [];
  for (const issue of issues) {
    const n = Number(issue.number);
    let lastRun = lastRuns.get(n)
      || (backlogUntil && toMs(issue.createdAt) <= backlogUntil ? { thread_seen_at: importedAt } : null);
    if (everyoneMs && (!lastRun || lastRun.mode !== 'live') && toMs(issue.createdAt) <= everyoneMs) {
      const floor = new Date(everyoneMs).toISOString();
      lastRun = lastRun
        ? { ...lastRun, thread_seen_at: toMs(lastRun.thread_seen_at) > everyoneMs ? lastRun.thread_seen_at : floor }
        : { thread_seen_at: floor };
    }
    const verdict = classifyIssue({
      issue,
      threadLastAt: latestOf(threads.get(n), proposalThreads.get(n)),
      busy: busy.has(n),
      lastRun,
    });
    if (verdict.eligible) eligible.push({ n, ...verdict });
    else if (verdict.reason === 'held') held.push({ n, heldAt: toMs(lastRun.created_at), ...verdict });
    // A request the bot is building keeps a row it queued for itself, as an
    // unchanged one does: it is read once the build ends.
    if (verdict.reason === 'unchanged' || verdict.reason === 'held' || verdict.reason === 'building') quiet.push(n);
  }
  if (capRoom) {
    const room = { ...capRoom };
    held.sort((a, b) => a.heldAt - b.heldAt);
    for (const h of held) {
      if (!(room[h.cap] > 0)) continue;
      room[h.cap] -= 1;
      eligible.push({ n: h.n, eligible: true, reason: CAP_FREED_REASON, priority: 2, threadSeenAt: h.threadSeenAt });
    }
  }

  const byNumber = new Map(issues.map((issue) => [Number(issue.number), issue]));
  for (const item of eligible) {
    const { rows: queued } = await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, thread_seen_at, changed_by)
       VALUES ($1, $2, $3, $4, $5, $7)
       ON CONFLICT (app_id, issue_number) DO UPDATE
         SET priority = LEAST(homeroom_bot_queue.priority, EXCLUDED.priority),
             thread_seen_at = EXCLUDED.thread_seen_at,
             reason = CASE WHEN homeroom_bot_queue.priority = 0
                             OR homeroom_bot_queue.reason = ANY($6::text[])
                           THEN homeroom_bot_queue.reason ELSE EXCLUDED.reason END,
             changed_by = CASE WHEN homeroom_bot_queue.priority = 0
                                 OR homeroom_bot_queue.reason = ANY($6::text[])
                               THEN homeroom_bot_queue.changed_by ELSE EXCLUDED.changed_by END
       WHERE homeroom_bot_queue.started_at IS NULL
       RETURNING id, (xmax = 0) AS inserted`,
      [app.id, item.n, item.priority, item.reason, item.threadSeenAt, SELF_QUEUED_REASONS, item.changedBy || null],
    );
    out.queued += 1;
    // A new request on a live app: the person it is for gets its card now,
    // under the key the read will start from (runTriage), so the wait for a
    // free builder is on the card rather than silent. Best-effort.
    if (capRoom && bot && item.reason === 'new' && queued[0]?.inserted) {
      await noteQueued(pool, { app, repo, issue: byNumber.get(item.n), queueId: queued[0].id, bot, settings, dm });
    }
  }
  // Rows the refresh no longer wants (closed, claimed, unchanged) leave the
  // queue; an admin's "run now" (priority 0) is kept until it runs, and a
  // row the bot queued for itself while its issue is open and nobody
  // else's (SELF_QUEUED_REASONS).
  const removed = await pool.query(
    `DELETE FROM homeroom_bot_queue
      WHERE app_id = $1 AND started_at IS NULL AND priority > 0
        AND NOT (issue_number = ANY($2::int[]))
        AND NOT (reason = ANY($3::text[]) AND issue_number = ANY($4::int[]))`,
    [app.id, eligible.map((e) => e.n), SELF_QUEUED_REASONS, quiet],
  );
  out.removed = removed.rowCount || 0;
  return out;
}

/** When the bot went on for everyone (refreshApp), or null. */
function everyoneSinceOf(settings) {
  return settings?.everyoneSince || null;
}

/**
 * A new request was queued on a live app (refreshApp): record who it is for
 * and start their activity card (homeroom-bot-activity.js startCard, which
 * sends nothing to somebody the bot does not talk to). Never throws.
 */
async function noteQueued(pool, { app, repo, issue, queueId, bot, settings = null, dm = null }) {
  if (!issue) return null;
  try {
    const dmSvc = dm || require('./homeroom-bot-dm');
    const requester = await dmSvc.recordRequester(pool, { app, repo, issueNumber: Number(issue.number), issue });
    if (!requester) return null;
    return await activity().startCard(pool, {
      app, issueNumber: Number(issue.number), requester, bot, jobKey: queueId, settings, queued: true, deps: { dm: dmSvc },
    });
  } catch (err) {
    log.warn('homeroom-bot', 'Could not start the card for a queued request', { app: app.slug, issueNumber: issue.number, err: err.message });
    return null;
  }
}

async function refreshQueue(pool, settings, deps = {}) {
  const apps = await listApps(pool);
  const paused = new Set(settings?.pausedApps || []);
  const summary = { apps: 0, queued: 0, removed: 0, skipped: 0 };
  for (const app of apps) {
    if (paused.has(app.slug)) continue;
    summary.apps += 1;
    try {
      const capRoom = deps.bot && live.isLiveFor(settings, app)
        ? await capRoomFor(pool, deps.bot, app.id, settings) : null;
      const r = await refreshApp(pool, app, { ...deps, capRoom, everyoneSince: everyoneSinceOf(settings), settings });
      summary.queued += r.queued;
      summary.removed += r.removed;
      if (r.skipped) summary.skipped += 1;
    } catch (err) {
      log.warn('homeroom-bot', 'Queue refresh failed for app', { app: app.slug, err: err.message });
    }
  }
  return summary;
}

/** refreshQueue for the named apps only: what a wake asks for. */
async function refreshApps(pool, settings, appIds, deps = {}) {
  const wanted = new Set(appIds.map(Number));
  const apps = (await listApps(pool)).filter((a) => wanted.has(Number(a.id)));
  const paused = new Set(settings?.pausedApps || []);
  const summary = { apps: 0, queued: 0, removed: 0, skipped: 0 };
  for (const app of apps) {
    if (paused.has(app.slug)) continue;
    summary.apps += 1;
    try {
      const capRoom = deps.bot && live.isLiveFor(settings, app)
        ? await capRoomFor(pool, deps.bot, app.id, settings) : null;
      const r = await refreshApp(pool, app, { ...deps, capRoom, everyoneSince: everyoneSinceOf(settings), settings });
      summary.queued += r.queued;
      summary.removed += r.removed;
      if (r.skipped) summary.skipped += 1;
    } catch (err) {
      log.warn('homeroom-bot', 'Queue refresh failed for app', { app: app.slug, err: err.message });
    }
  }
  return summary;
}

/**
 * The next batch: the app holding the most urgent queued item, and up to
 * `batchSize` of that app's items. Apps in `excludeAppIds` are skipped so
 * concurrent passes never share an app (one container, one turn at a time).
 */
/**
 * Release rows a pass claimed and never finished. runTriage claims its row
 * (`started_at`) before it runs; nextBatch takes unclaimed rows only, and a
 * refresh updates and deletes unclaimed rows only, so a row whose pass died
 * mid-turn (a platform restart) was skipped for good and its issue never
 * looked at again. Passes hold the loop's lock, so nothing live is older
 * than one turn's budget; past that, with a margin, the claim is abandoned.
 */
async function releaseStaleClaims(pool, settings, { keepIds = [] } = {}) {
  const seconds = (Number(settings?.turnSeconds) || DEFAULTS.turnSeconds) + STALE_CLAIM_MARGIN_SECONDS;
  // #3624 stage 2: passes now run while work does, so a row this Pod is
  // still working on (a long live build) is not handed back under it.
  const keep = keepIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const { rowCount } = await pool.query(
    `UPDATE homeroom_bot_queue SET started_at = NULL
      WHERE started_at IS NOT NULL AND started_at < NOW() - make_interval(secs => $1)${
  keep.length ? '\n        AND NOT (id = ANY($2::int[]))' : ''}`,
    keep.length ? [seconds, keep] : [seconds],
  );
  if (rowCount) log.info('homeroom-bot', 'Released queue rows an unfinished pass had claimed', { count: rowCount });
  return rowCount || 0;
}

/**
 * A triage that threw left its row claimed, recorded nothing, and so was
 * never tried again (rss-reader #24, 2026-09-25: its "looking" post and then
 * silence). Record it as a failed run and drop the row, as recordFailure does
 * for a failure it sees. Not a retry: a throw that repeats would sit at the
 * head of the queue and starve every other app. What it has seen is now, so
 * the bot's own post just before the throw is not read as a change; the issue
 * is looked at again when somebody changes it, or on an admin's Run now.
 */
async function recordThrownTriage(pool, { app, item, settings, err }) {
  try {
    await insertRun(pool, {
      ...billingOf(item, live.isLiveFor(settings, app) ? 'live' : settings.mode),
      readReason: readReasonOf(item),
      appId: app.id, issueNumber: item.issue_number,
      mode: live.isLiveFor(settings, app) ? 'live' : settings.mode,
      verdict: 'failed', error: `threw: ${err?.message || err}`,
      threadSeenAt: new Date().toISOString(),
    });
    await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
  } catch (recordErr) {
    log.warn('homeroom-bot', 'Could not record a triage that threw', {
      app: app.slug, issueNumber: item.issue_number, err: recordErr.message,
    });
  }
}

async function nextBatch(pool, { batchSize, excludeAppIds = [], pausedApps = [], scope = null }) {
  // #3624 stage 2: an app the bot acts on for real (live.liveScope) is the
  // live lane's, and is left out here like a paused one.
  const { rows: head } = await pool.query(
    `SELECT q.app_id
       FROM homeroom_bot_queue q JOIN apps a ON a.id = q.app_id
      WHERE q.started_at IS NULL
        AND NOT (q.app_id = ANY($1::int[]))
        AND NOT (a.slug = ANY($2::text[]))
        AND NOT (CASE WHEN $4::boolean THEN NOT (a.slug = ANY($5::text[])) ELSE a.slug = ANY($3::text[]) END)
      ORDER BY q.priority, q.enqueued_at
      LIMIT 1`,
    [excludeAppIds, pausedApps, scope?.slugs || [], !!scope?.all, scope?.except || []],
  );
  if (!head.length) return null;
  const appId = head[0].app_id;
  const { rows: appRows } = await pool.query(
    'SELECT id, slug, name, repo_url, self_hosted FROM apps WHERE id = $1', [appId],
  );
  const { rows: items } = await pool.query(
    `SELECT id, app_id, issue_number, priority, reason, thread_seen_at, requested_by, changed_by
       FROM homeroom_bot_queue
      WHERE app_id = $1 AND started_at IS NULL
      ORDER BY priority, enqueued_at
      LIMIT $2`,
    [appId, batchSize],
  );
  return { app: appRows[0], items };
}

// ── The triage turn ─────────────────────────────────────────────────────

function triagePrompt() {
  if (triagePromptCache) return triagePromptCache;
  triagePromptCache = fs.readFileSync(TRIAGE_PROMPT_PATH, 'utf8');
  return triagePromptCache;
}

// What the triage knows of the platform. A request often turns on it (its
// native kit, its `--un-*` tokens, what an app may do), and the app's
// repository does not hold those answers.
//
// The conventions are a TOOL CALL away, not inline. #3161 inlined all
// 150 KB of them, as an agent-chat scout carries them, and on rss-reader #24
// (2026-09-26) that went wrong twice: once the model took the whole message
// for one conventions document and never triaged; once every request
// carried 50k tokens before the first file read, the context crossed the
// auto-compaction limit after 86 reads, and the model's own summary said
// the task was "not visible in my surviving context". The Homeroom read
// tool every scout has serves the same document on demand: the essentials
// and an index of sections, then one section at a time. The UI design
// guidance the coding agents build with is small, so it stays inline.
//
// It goes AFTER the request and the triage instructions, fenced and
// labelled as reference, so it is never read as the task.
//
// Its one variable line, the design self-check, follows what the turn's
// model can see (prompts.runtimeReadsImages). It used to be the text-only
// line for every model, which told GLM 5.3 Flash, a model that takes images,
// "you read text, not images" in the same prompt that asks it to look at the
// reporter's screenshot.
function triageReference({ readsImages = false } = {}) {
  const designGuidance = require('./prompts').getDesignGuidance({ readsImages });
  return `==== PLATFORM REFERENCE (for looking things up; not the request) ====

The Homeroom platform's own conventions (its rules for every app on it: its native UI kit, its \`--un-*\` theme tokens, its APIs and what an app may do) are one tool call away. Call \`get_platform_conventions\` with no arguments for the essentials and an index of its sections, then with a section's slug to read just that section. Use it when the request turns on the platform; nothing in this reference is a task.

The UI design guidance every coding agent here builds with follows, for judging a request that changes what people see.

${designGuidance}

==== END PLATFORM REFERENCE ====`;
}

// The last thing the model reads says what it is doing and restates the one
// format parseVerdict accepts, so the verdict does not depend on it
// remembering instructions from earlier in the turn.
// The one shape parseVerdict reads, as the end of every triage prompt says
// it. A re-read and the repair ask restate it too (VERDICT_KEYS_LINE):
// without it, a re-read answered in keys of its own (`next_step`,
// `ask_reporter`) that nothing reads, and so did the ask to repair it.
const VERDICT_FORMAT = '{"verdict": "question" | "empty" | "ready" | "person", "determined": true | false, "missing_fact": "...", "question": "...", "default": "...", "build_note": "...", "reason": "..."}';
const VERDICT_KEYS_LINE = 'Use these keys and the others your instructions name (such as `answers`, `blocker`, `assumptions`, `platform`): a block with keys of its own, or no `verdict`, cannot be read.';

function triageClosing(issueNumber) {
  return `That is the end of the reference. Now answer the triage request above, for issue #${issueNumber}: decide which verdict is true, and END YOUR REPLY WITH EXACTLY ONE fenced JSON block in this format, and nothing after it:
${VERDICT_FORMAT}`;
}

/**
 * #3654: the whole triage prompt for one request, as runTriage sends it and
 * as the benchmark rebuilds it from a snapshot's seed. Pure apart from the
 * cached prompt file and the design guidance it reads. `readsImages` is
 * whether the turn's model takes images, from the runtime the turn resolved
 * (prompts.runtimeReadsImages); a prompt rebuilt without it is the text-only
 * one every triage ran before it existed.
 */
function triagePromptFor({
  seed, issueNumber, firstVersion = false, readsImages = false, decider = null, planChange = null, members = null,
  // The App bench studio's pack guidance (services/bench/packs.js). The
  // live bot never passes any, and then the prompt is what it always was.
  guidance = null,
  // The game starter a first version builds on (firstVersionNote).
  starter = null,
  // #4645: the requester's language preference (users.locale; null unset).
  // The wording rule is in the prompt file above; this names the value it
  // matches, and says nothing when it is unset, so the default stands.
  locale = null,
}) {
  return [
    seed, live.screenshotNote(seed).join('\n').trim(), triagePrompt(),
    locale ? `The requester's locale is \`${locale}\`.` : null,
    live.requestRulesLines().join('\n').trim(),
    firstVersion ? firstVersionNote(starter) : null,
    firstVersion ? membersNote(members) : null,
    firstVersion ? planChangeNote(planChange) : null,
    deciderNote(decider),
    live.guidanceLines(guidance).join('\n').trim() || null,
    triageReference({ readsImages }), triageClosing(issueNumber),
  ].filter(Boolean).join('\n\n');
}

/**
 * B6: what a first version's creator asked its plan changed with (Change
 * something, homeroom-bot-dm.js changePlan), every time, oldest first, and
 * the newest plan they were shown: { bullets, changes }, or null when they
 * asked for none. Their words are kept on the plan's run, never posted.
 */
async function planChangesFor(pool, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT plan, plan_change FROM homeroom_bot_runs
      WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND plan IS NOT NULL
      ORDER BY id`,
    [appId, issueNumber],
  );
  const changes = rows.map((r) => String(r.plan_change || '').trim()).filter(Boolean);
  if (!changes.length) return null;
  const shown = [...rows].reverse().find((r) => Array.isArray(r.plan?.bullets) && r.plan.bullets.length);
  return { bullets: shown ? shown.plan.bullets : [], changes };
}

/** Pure (B6): the triage's note of the changes a first version's creator asked for. */
function planChangeNote(planChange) {
  if (!planChange?.changes?.length) return null;
  const who = planChange.requester ? `@${planChange.requester}` : 'Its creator';
  return [
    '==== THE CREATOR\'S CHANGES TO YOUR PLAN ====',
    '',
    `${who} was shown your plan for this first version and asked for changes, in a private chat with you. Their words`,
    'below are what they want from the app, newest last: plan it again with them, within every rule above, keep what',
    'they did not ask to change, and give a new `plan` and `choices`.',
    '',
    ...(planChange.bullets?.length ? ['The plan they were shown:', ...planChange.bullets.map((b) => `- ${b}`), ''] : []),
    'What they asked:',
    ...planChange.changes.map((c) => `- "${String(c).replace(/\s+/g, ' ').slice(0, 1500)}"`),
  ].join('\n');
}

// How many of a first version's people its plan is told by name.
const PROJECT_MEMBERS_SHOWN = 12;

/**
 * 2026-10-04: who is in a first version's project, so its plan is about
 * them. The sketch it was drawn from showed sample people, and a plan that
 * could not see the real ones planned around those: it asked a project of
 * two whether its creator should join the sketch's three made-up flatmates
 * in the rota. Pure; null says nothing (no roster, or an empty one), which
 * is also every prompt the benchmark rebuilds from a snapshot without one.
 */
function membersNote(members) {
  const people = Array.isArray(members?.people) ? members.people.filter((p) => p && p.username) : [];
  if (!people.length) return null;
  const label = (p) => {
    const handle = `@${String(p.username).slice(0, 40)}`;
    const name = String(p.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return name && name.toLowerCase() !== String(p.username).toLowerCase() ? `${name} (${handle})` : handle;
  };
  const lines = people.map((p) => `- ${label(p)}${p.creator ? ', who made the project' : ''}${p.invited ? ', invited and not joined yet' : ''}`);
  const more = Number(members.more) || 0;
  if (more > 0) lines.push(`- and ${more} more`);
  const byEmail = Number(members.emailInvites) || 0;
  if (byEmail > 0) lines.push(`- and ${byEmail} invited by email, not on Homeroom yet`);
  return [
    '==== WHO IS IN THIS PROJECT ====',
    '',
    'Its real people right now. Plan anything about who uses it around them, and around more people joining later:',
    ...lines,
  ].join('\n');
}

/**
 * The people of a project, for membersNote: its members (its creator
 * first), then the people invited who have not joined, by display name and
 * username, and a count of invites by email still waiting for an account.
 * { people, more, emailInvites }, or null when it has nobody.
 */
async function projectMembers(pool, app) {
  if (!app?.id) return null;
  const { rows } = await pool.query(
    `SELECT username, display_name, creator, invited,
            (COUNT(*) OVER ())::int AS total,
            (SELECT COUNT(*)::int FROM app_email_invites e
              WHERE e.app_id = $1 AND e.claimed_at IS NULL) AS by_email
       FROM (
         SELECT u.username, u.display_name, COALESCE(u.id = a.created_by, FALSE) AS creator, FALSE AS invited,
                m.joined_at AS since
           FROM apps a
           JOIN community_members m ON m.community_id = a.community_id
           JOIN users u ON u.id = m.user_id
          WHERE a.id = $1 AND u.is_synthetic = FALSE
         UNION ALL
         SELECT u.username, u.display_name, FALSE, TRUE, c.created_at
           FROM app_collaborators c
           JOIN apps a ON a.id = c.app_id
           JOIN users u ON u.id = c.user_id
          WHERE c.app_id = $1 AND c.status = 'invited' AND u.is_synthetic = FALSE
            AND NOT EXISTS (SELECT 1 FROM community_members m
                             WHERE m.community_id = a.community_id AND m.user_id = c.user_id)
       ) p
      ORDER BY invited, creator DESC, since, username
      LIMIT $2`,
    [app.id, PROJECT_MEMBERS_SHOWN],
  );
  if (!rows.length) return null;
  return {
    people: rows.map((r) => ({
      username: r.username, name: r.display_name || null, creator: r.creator === true, invited: r.invited === true,
    })),
    more: Math.max(0, (Number(rows[0].total) || 0) - rows.length),
    emailInvites: Number(rows[0].by_email) || 0,
  };
}

/**
 * #3772: who decides on this project, when that changes the verdict. The
 * ready rules send every new dependency, service or design choice to "a
 * person", and the bot then left it "for the group". On a project with one
 * member, the person who asked IS the group: Ear Trainer #13 (sounds from a
 * MIDI instrument) was left for a group of one, who was told someone in the
 * group would have to take it up. There, a decision they can make is a
 * question to them with choices to tap, and their answer decides it.
 * On a project with more people, its creator and its admins steer what gets
 * built (the group still votes on every change): a request one of them made
 * is decided the same way, and anyone else's names them, so a go-ahead from
 * one of them decides it and nobody's go-ahead loops back to "a person"
 * (Geneva hike planner #2, read three times to the same answer). Pure; null
 * says nothing.
 */
function deciderNote(decider) {
  if (decider?.requesterDecides) {
    const who = decider.role === 'creator'
      ? `@${decider.requester} asked for this, and made this project: the decisions its group would make before building are theirs. The group still votes on the change it becomes.`
      : decider.role === 'admin'
        ? `@${decider.requester} asked for this, and is an admin of this project: the decisions its group would make before building are theirs. The group still votes on the change it becomes.`
        : `@${decider.requester} asked for this, and is the only member of this project: the decisions its group would make are theirs.`;
    return [
      '==== WHO DECIDES ON THIS PROJECT ====',
      '',
      who,
      '- A request that fails a `ready` criterion only because it needs a decision they can make (a new dependency or external service that needs no credentials, a design or product choice) is a `question` to them, not `person`. Ask it plainly, say what it would add, and give `answers` they can tap: the choice that needs no approval (for example the browser\'s built-in way) first when there is one, then the one that needs it (for example "Add the library"), then "Leave it".',
      '- When the request or its discussion already shows them choosing (they answered your question, or said to go ahead), that criterion is decided: judge the rest as usual.',
      '- Changes to auth, billing, permissions or credentials, and database changes that are not append-only, are still `person`.',
      rulesLine(decider.role ? `@${decider.requester} can` : 'its creator or admins can'),
    ].join('\n');
  }
  const deciders = (Array.isArray(decider?.deciders) ? decider.deciders : []).filter((d) => d?.username);
  if (!deciders.length) return null;
  const named = spokenList(deciders.map((d) => `@${d.username} (${d.role === 'creator' ? 'who made it' : 'an admin'})`), 'and');
  const either = spokenList(deciders.map((d) => `@${d.username}`), 'or');
  return [
    '==== WHO DECIDES ON THIS PROJECT ====',
    '',
    `@${decider.requester} asked for this. On this project ${named} ${deciders.length > 1 ? 'decide' : 'decides'} what gets built; the group still votes on every change.`,
    `- A request that fails a \`ready\` criterion only because it needs a decision they can make (a new dependency or external service that needs no credentials, a design or product choice) is \`person\`, and its \`reason\` says it waits for ${either} to say go ahead in this request's discussion.`,
    `- When the request's discussion shows ${either} choosing (answering your question, or saying to go ahead), that criterion is decided: judge the rest as usual. A go-ahead from anyone else, @${decider.requester} included, does not decide it.`,
    '- Changes to auth, billing, permissions or credentials, and database changes that are not append-only, are still `person`.',
    rulesLine(`${either} can`),
  ].join('\n');
}

/**
 * #4666: how a project's changes are approved, and who can see it, are set
 * in its Who can see & change it sheet by whoever may manage it, as one
 * proposal; a request to change them is never built (Homeroom Maps #30 was
 * read five times to "the group decides"). `who` says who can, by name.
 */
function rulesLine(who) {
  return `- A request to change how this project's changes are approved (who says yes, how many yeses) or who can see it is not code: ${who} change it on the project's page, under ⋯, Settings & rules, Who can see & change it, as one proposal for the group. It is \`person\`, and \`reason\` says where and who.`;
}

/** "a", "a and b", "a, b and c". */
function spokenList(items, word) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

// How many of a project's creator and admins the note names.
const DECIDERS_SHOWN = 4;

/**
 * #3772: whether the person a request is for decides on its project alone:
 * they are its only member (or, on a project not in a community, its
 * creator). { requester, members, requesterDecides }, or null.
 * On a project with more people, its creator and admins decide what gets
 * built: a requester who is one of them decides (`role` 'creator' or
 * 'admin'), and anyone else's request names them (`deciders`, the creator
 * first). Homeroom's own project keeps the rule as it was: its group is
 * everyone, and its admins are the platform's.
 */
async function whoDecides(pool, app, requester) {
  if (!app?.id || !requester?.userId) return null;
  const { rows } = await pool.query(
    `SELECT a.created_by, a.self_hosted, cu.username AS creator,
            (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id) AS members,
            EXISTS (SELECT 1 FROM community_members m
                     WHERE m.community_id = a.community_id AND m.user_id = $2) AS member,
            EXISTS (SELECT 1 FROM app_admins aa WHERE aa.app_id = a.id AND aa.user_id = $2) AS admin,
            ARRAY(SELECT u.username FROM app_admins aa JOIN users u ON u.id = aa.user_id
                   WHERE aa.app_id = a.id AND aa.user_id IS DISTINCT FROM a.created_by
                   ORDER BY aa.created_at, u.username) AS admins
       FROM apps a LEFT JOIN users cu ON cu.id = a.created_by
      WHERE a.id = $1`,
    [app.id, requester.userId],
  );
  const row = rows[0];
  if (!row) return null;
  const members = Number(row.members) || 0;
  const alone = members === 0
    ? Number(row.created_by) === Number(requester.userId)
    : members === 1 && row.member === true;
  const decider = { requester: requester.username, members, requesterDecides: alone };
  if (alone || row.self_hosted === true) return decider;
  if (app.slug && (await platformAppSlugs(pool)).includes(app.slug)) return decider;
  if (Number(row.created_by) === Number(requester.userId)) return { ...decider, requesterDecides: true, role: 'creator' };
  if (row.admin === true) return { ...decider, requesterDecides: true, role: 'admin' };
  const deciders = [
    ...(row.creator ? [{ username: row.creator, role: 'creator' }] : []),
    ...(Array.isArray(row.admins) ? row.admins : []).filter(Boolean).map((username) => ({ username, role: 'admin' })),
  ].slice(0, DECIDERS_SHOWN);
  return deciders.length ? { ...decider, deciders } : decider;
}

/**
 * #3654: the commit a stage is about to run against: where `branch` points
 * on GitHub right now. Best-effort, for the run's snapshot; null when GitHub
 * cannot say.
 */
async function headShaOf(github, repo, branch = 'main') {
  if (!repo || typeof github?.getBranchSha !== 'function') return null;
  try {
    const sha = await github.getBranchSha(repo.owner, repo.repo, branch || 'main');
    return typeof sha === 'string' ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Put the bot's triage session back at rest: `paused`, but only from
 * `active` and only with no turn record on it. Restart recovery throws away
 * a session it finds paused, so pausing one under a turn in flight is how a
 * running turn gets lost (#1006).
 */
async function pauseIdleSession(pool, sessionId) {
  await pool.query(
    `UPDATE chat_sessions SET status = 'paused', last_activity_at = NOW()
      WHERE id = $1 AND status = 'active' AND active_turn IS NULL`,
    [sessionId],
  ).catch(() => {});
}

/**
 * The bot's one triage session per app, created on first use. `paused` at
 * rest and `active` only while a turn runs; is_headless FALSE and an empty
 * linked_issues so no board derivation reads it as work on any issue.
 *
 * ONLY the triage session: the one on `main` that no run builds in. The
 * bot's build sessions are its own too, on their `dev/homeroom_bot-*`
 * branches and `active` while they build, and reading "the bot's newest
 * session" took the running build's (#1006). The triage turn was refused
 * `session_busy`, its `finally` paused the build's session under it, and
 * the next deploy's restart recovery found a paused session and threw the
 * build away: six platform builds lost on 10-02, and about 150 triage turns
 * refused. With no build running, triage ran inside the newest of those
 * paused sessions instead, on that build's stale branch.
 */
async function ensureBotSession(pool, config, bot, app) {
  const { rows: found } = await pool.query(
    `SELECT * FROM chat_sessions cs
      WHERE cs.user_id = $1 AND cs.app_id = $2 AND cs.status IN ('active', 'paused')
        AND cs.branch_name = 'main'
        AND NOT EXISTS (SELECT 1 FROM homeroom_bot_runs r WHERE r.build_session_id = cs.id)
      ORDER BY cs.id DESC LIMIT 1`,
    [bot.id, app.id],
  );
  let session = found[0] || null;
  if (!session) {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues,
                                  session_title, agent_backend, agent_provider, agent_model,
                                  agent_reasoning_effort)
       VALUES ($1, $2, 'main', 'paused', FALSE, '{}', $3, 'codex_openrouter', 'openrouter', $4, $5)
       RETURNING *`,
      [app.id, bot.id, 'Homeroom bot triage',
        config.openrouterDefaultCodexModel || null,
        config.openrouterDefaultCodexReasoning || 'low'],
    );
    session = rows[0];
    log.info('homeroom-bot', 'Bot session created', { app: app.slug, sessionId: session.id });
  }
  session.app_slug = app.slug;
  session.app_name = app.name;
  session.repo_url = app.repo_url;
  session.app_self_hosted = app.self_hosted;
  return session;
}

// Turns the bot queued for itself (SELF_QUEUED_REASONS), and a turn its own
// clock stopped and queued again, are its own doing: nobody's building time
// pays for them.
const UNCHARGED_REASONS = Object.freeze([...SELF_QUEUED_REASONS, 'budget_retry']);

/**
 * Pure: whose weekly building time a run on `item` counts toward
 * (homeroom-bot-dm.js weeklySpentCents). Charged when it is live and asked
 * for by somebody, not caused by the bot itself; paid by whoever asked the
 * bot to start it when that was somebody other than the requester (the
 * queue row's payer), else by the requester, whom the ledger already knows.
 */
function billingOf(item, runMode) {
  return {
    charged: runMode === 'live' && !UNCHARGED_REASONS.includes(String(item?.reason || '')),
    payerUserId: Number(item?.payer_user_id) || null,
  };
}

/**
 * What started a read, kept on its run (read_reason): its queue row's
 * reason, and for a change what moved past the last read (classifyIssue's
 * changedBy, carried on the row as changed_by), as 'changed:github' or
 * 'changed:discussion'. Null with no reason.
 */
function readReasonOf(item) {
  const reason = String(item?.reason || '').trim();
  if (!reason) return null;
  const by = reason === 'changed' && item?.changed_by ? `:${item.changed_by}` : '';
  return clip(`${reason}${by}`, 80);
}

async function insertRun(pool, run) {
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_runs
       (app_id, issue_number, session_id, mode, verdict, determined, missing_fact, question,
        question_default, build_note, reason, cap_suppressed, thread_seen_at, model, cost_usd,
        input_tokens, output_tokens, duration_ms, error, budget_stop, proposal_session_id,
        checks_head_sha, charged, payer_user_id, read_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
     RETURNING id`,
    [run.appId, run.issueNumber, run.sessionId || null, run.mode, run.verdict,
      run.determined ?? null, run.missingFact || null, run.question || null,
      run.questionDefault || null, run.buildNote || null, run.reason || null,
      run.capSuppressed || null, run.threadSeenAt || null, run.model || null,
      run.costUsd ?? null, run.inputTokens ?? null, run.outputTokens ?? null,
      run.durationMs ?? null, run.error ? clip(run.error, MAX_ERROR_CHARS) : null,
      run.budgetStop || null, run.proposalSessionId || null,
      // The failing head a checks follow-up looked at, so it looks once.
      run.checksHeadSha || null,
      // Whose week it counts toward, if anybody's (billingOf): a shadow run
      // never does.
      run.charged ?? run.mode === 'live', run.payerUserId || null,
      // What started this read (readReasonOf), so a request read again and
      // again says why.
      run.readReason || null],
  );
  const id = rows[0]?.id || null;
  // #3624: a question's suggested answers, beside the row rather than in
  // its insert, which only a question run needs.
  if (id && Array.isArray(run.questionAnswers) && run.questionAnswers.length) {
    await pool.query(
      'UPDATE homeroom_bot_runs SET question_answers = $2 WHERE id = $1',
      [id, JSON.stringify(run.questionAnswers)],
    ).catch((err) => log.warn('homeroom-bot', 'Could not record a question\'s answers', { runId: id, err: err.message }));
  }
  // B6: its plan, or its two questions, the same way.
  if (id && run.plan && typeof run.plan === 'object') {
    await pool.query(
      'UPDATE homeroom_bot_runs SET plan = $2 WHERE id = $1',
      [id, JSON.stringify(run.plan)],
    ).catch((err) => log.warn('homeroom-bot', 'Could not record a plan', { runId: id, err: err.message }));
  }
  // A reply whose verdict could not be read (keptReply), the same way.
  if (id && run.unreadableReply && typeof run.unreadableReply === 'object') {
    await pool.query(
      'UPDATE homeroom_bot_runs SET unreadable_reply = $2 WHERE id = $1',
      [id, JSON.stringify(run.unreadableReply)],
    ).catch((err) => log.warn('homeroom-bot', 'Could not record an unreadable reply', { runId: id, err: err.message }));
  }
  // #4488: a ready verdict labelled complicated, the same way.
  if (id && run.complicated) {
    await pool.query('UPDATE homeroom_bot_runs SET complicated = TRUE WHERE id = $1', [id])
      .catch((err) => log.warn('homeroom-bot', 'Could not record a complicated verdict', { runId: id, err: err.message }));
  }
  // What the read saw of its request (readFingerprintOf), and the held run
  // a reused verdict came from (reuseHeldVerdict), the same way.
  if (id && (run.readFingerprint || run.reusedRunId)) {
    await pool.query(
      'UPDATE homeroom_bot_runs SET read_fingerprint = $2, reused_run_id = $3 WHERE id = $1',
      [id, run.readFingerprint ? JSON.stringify(run.readFingerprint) : null, Number(run.reusedRunId) || null],
    ).catch((err) => log.warn('homeroom-bot', 'Could not record what a read saw', { runId: id, err: err.message }));
  }
  // #4239: a person verdict about Homeroom itself, the same way.
  if (id && run.aboutPlatform) {
    await pool.query('UPDATE homeroom_bot_runs SET about_platform = TRUE WHERE id = $1', [id])
      .catch((err) => log.warn('homeroom-bot', 'Could not record a platform verdict', { runId: id, err: err.message }));
  }
  return id;
}

/**
 * The most proposals the bot may have up for a vote at once, across every
 * app (#3576). It stands in for the
 * platform's per-user cap (session-caps.js, 5), which the bot ran into with
 * four live apps and found out about only after a paid build could not be
 * proposed. The Propose route honours it for the bot's own in-process
 * promote only (promoteAsBot); the bot checks it before it builds.
 */
function botProposalCeiling(settings) {
  // An admin's number, when there is one (KEY_PROPOSAL_CEILING).
  const fixed = Number(settings?.proposalCeiling);
  if (Number.isInteger(fixed) && fixed > 0) return fixed;
  return EVERYONE_PROPOSAL_CEILING;
}

/**
 * Which live cap would have stopped this verdict from being posted. The
 * counts are over the bot's own rows, so in shadow mode they read zero
 * until the tripwire on questions trips — which is exactly the number the
 * dashboard exists to show. A ready verdict is checked against both
 * proposal caps before anything is built: a hold costs nothing, and the
 * cap_freed refresh brings the issue back when there is room.
 */
async function simulateCaps(pool, bot, appId, verdict, settings = null) {
  if (verdict === 'ready') {
    if (await openBotProposalCount(pool, bot, appId) >= PROPOSALS_PER_APP_CAP) return 'proposals_per_app';
    if (await openBotProposalTotal(pool, bot) >= botProposalCeiling(settings)) return 'proposals_total';
  }
  if (TRIPWIRE_VERDICTS.includes(verdict)) {
    if (await tripwireCount(pool, appId) >= QUESTION_TRIPWIRE_PER_DAY) return 'question_tripwire';
  }
  return null;
}

async function openBotProposalCount(pool, bot, appId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM chat_sessions
      WHERE app_id = $1 AND user_id = $2 AND status IN ('promoted', 'merging')`,
    [appId, bot.id],
  );
  return rows[0]?.cnt || 0;
}

// The bot's proposals up for a vote on every app, counted as the Propose
// route counts a user's (#3576).
async function openBotProposalTotal(pool, bot) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM chat_sessions
      WHERE user_id = $1 AND status IN ('promoted', 'merging') AND is_headless = FALSE`,
    [bot.id],
  );
  return rows[0]?.cnt || 0;
}

/**
 * #4488: the daily cap on questions and notes, for a complicated change's
 * plan (which asks its requester before anything is built): 'question_tripwire'
 * when the project has had its fill today, else null.
 */
async function planTripwire(pool, appId) {
  return await tripwireCount(pool, appId) >= QUESTION_TRIPWIRE_PER_DAY ? 'question_tripwire' : null;
}

// Only the verdicts that went out (or, in shadow, would have). A held one
// said nothing but the one-line held note, and counting it would let each
// retry of a held question push the window out again (#3152). #4488: a
// complicated change's plan asked its requester, so it counts as well.
async function tripwireCount(pool, appId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM homeroom_bot_runs
      WHERE app_id = $1 AND (verdict = ANY($2::text[]) OR complicated IS TRUE)
        AND cap_suppressed IS NULL
        AND created_at > NOW() - INTERVAL '24 hours'`,
    [appId, TRIPWIRE_VERDICTS],
  );
  return rows[0]?.cnt || 0;
}

/**
 * How many more verdicts each cap would let through on this app now, keyed
 * by the name simulateCaps records (#3152). The same counts, so a held
 * issue is only brought back when the check it failed would now pass. The
 * bot-wide room is the same number for every app; an app refreshed after
 * another took it may bring one back that is held again, at the price of
 * one triage and no post.
 */
async function capRoomFor(pool, bot, appId, settings = null) {
  const [proposals, total, questions] = await Promise.all([
    openBotProposalCount(pool, bot, appId),
    openBotProposalTotal(pool, bot),
    tripwireCount(pool, appId),
  ]);
  return {
    proposals_per_app: Math.max(0, PROPOSALS_PER_APP_CAP - proposals),
    proposals_total: Math.max(0, botProposalCeiling(settings) - total),
    question_tripwire: Math.max(0, QUESTION_TRIPWIRE_PER_DAY - questions),
  };
}

// Errors that mean "this app cannot be worked right now", as opposed to
// "this turn failed". They are refusals: no turn ran, nothing was spent,
// and the queue row is untouched. Writing a verdict row for one is how two
// thirds of the first day's ledger became noise.
const REFUSAL_ERRORS = new Set(['session_busy']);

// How long after a budget stop an empty reply on the same session is read
// as collateral from the kill rather than as the turn's own answer (#2870).
// The two observed cases landed within one second of the stop; a minute
// leaves room for a slower kill without swallowing a later genuine failure.
const STOP_SETTLE_MS = 60 * 1000;

/** Whether this app is inside a backoff window, and how long is left. */
function backoffFor(appId, now = Date.now()) {
  const entry = appBackoff.get(Number(appId));
  if (!entry || entry.until <= now) return null;
  return { ...entry, remainingMs: entry.until - now };
}

/** Double this app's backoff, from 2 minutes up to an hour. */
function noteRefusal(appId, error, now = Date.now()) {
  const id = Number(appId);
  const prior = appBackoff.get(id);
  const attempts = (prior?.attempts || 0) + 1;
  const delay = Math.min(BACKOFF_BASE_MS * (2 ** (attempts - 1)), BACKOFF_CEILING_MS);
  appBackoff.set(id, { attempts, until: now + delay, error, at: now });
  return { attempts, delayMs: delay };
}

/** A turn got through for this app, so the next refusal starts from 2 min. */
function clearRefusals(appId) {
  appBackoff.delete(Number(appId));
}

function followUpKey(appId, issueNumber) {
  return `${Number(appId)}:${Number(issueNumber)}`;
}

/** Double one follow-up's backoff, as noteRefusal does an app's. */
function noteFollowUpRefusal(appId, issueNumber, error, now = Date.now()) {
  const key = followUpKey(appId, issueNumber);
  const prior = followUpBackoff.get(key);
  const attempts = (prior?.attempts || 0) + 1;
  const delay = Math.min(BACKOFF_BASE_MS * (2 ** (attempts - 1)), BACKOFF_CEILING_MS);
  followUpBackoff.set(key, { attempts, until: now + delay, error, at: now });
  return { attempts, delayMs: delay };
}

function clearFollowUpRefusals(appId, issueNumber) {
  followUpBackoff.delete(followUpKey(appId, issueNumber));
}

/** The follow-ups inside a backoff window, as "appId:issueNumber", dropping the ones past it. */
function followUpsBackedOff(now = Date.now()) {
  const out = [];
  for (const [key, entry] of followUpBackoff) {
    if (entry.until > now) out.push(key);
    else followUpBackoff.delete(key);
  }
  return out;
}

/**
 * A platform fault, said the way the dashboard should say it (#3122). The
 * quota refusal arrives as a Kubernetes Status body several hundred
 * characters long; what anyone needs from it is which quota is full.
 */
function summarizeFault(error) {
  const text = String(error || '').replace(/\s+/g, ' ').trim();
  if (/exceeded quota/i.test(text)) {
    return /persistentvolumeclaims|requests\.storage/i.test(text)
      ? 'the worker storage quota is full'
      : 'a worker quota is full';
  }
  return clip(text, 160) || 'unknown platform fault';
}

/** Whether the bot is inside a platform-fault backoff, and for how long. */
function faultBackoff(now = Date.now()) {
  if (!platformFault || platformFault.until <= now) return null;
  return { ...platformFault, remainingMs: platformFault.until - now };
}

/** Double the bot-wide backoff, from 2 minutes up to an hour. */
function noteFault(error, now = Date.now()) {
  const attempts = (platformFault?.attempts || 0) + 1;
  const delayMs = Math.min(BACKOFF_BASE_MS * (2 ** (attempts - 1)), BACKOFF_CEILING_MS);
  platformFault = { attempts, until: now + delayMs, error: summarizeFault(error), at: now };
  return { attempts, delayMs, summary: platformFault.error };
}

/**
 * The same fault the current streak already recorded. A retry that fails
 * the same way is logged, not written to the ledger again: one row says
 * the bot hit it, and the loop line says it is still waiting.
 */
function isRepeatFault(error) {
  return !!platformFault && platformFault.error === summarizeFault(error);
}

/** A turn ran, so the platform is fine again. */
function clearFault() {
  platformFault = null;
}

/**
 * Free the worker volumes the bot's own sessions still hold (#3122).
 *
 * Every Kubernetes worker used to claim a 5Gi volume, and the bot keeps one
 * session per app, paused forever, so every app it ever triaged held one:
 * 26 of the namespace's 120 when the quota refused everybody's workers.
 * The bot has needed no persistent storage since each issue got a fresh
 * thread (#3036), and its workers now start on temporary storage, so what
 * is left is only what it claimed before. A volume is freed only when no
 * worker Deployment for that session exists, so a warm worker is never
 * pulled from under a turn; its volume goes on a later sweep, once the
 * worker has idled out.
 */
async function releaseBotVolumes(pool, bot, deps = {}) {
  const worker = deps.worker || require('./worker');
  if (typeof worker.listWorkerVolumes !== 'function') return [];
  const volumes = await worker.listWorkerVolumes();
  const detached = (volumes || []).filter((v) => !v.attached && !v.terminating
    && Number.isSafeInteger(Number(v.sessionId)));
  if (!detached.length) return [];
  const { rows } = await pool.query(
    'SELECT id FROM chat_sessions WHERE user_id = $1 AND id = ANY($2::int[])',
    [bot.id, detached.map((v) => Number(v.sessionId))],
  );
  const mine = new Set(rows.map((r) => Number(r.id)));
  const freed = [];
  for (const volume of detached) {
    const sessionId = Number(volume.sessionId);
    if (!mine.has(sessionId)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await worker.destroyCcVolume(sessionId);
      freed.push(sessionId);
    } catch (err) {
      log.warn('homeroom-bot', 'Could not free a bot worker volume', { sessionId, err: err.message });
    }
  }
  if (freed.length) log.info('homeroom-bot', 'Freed bot worker volumes', { sessionIds: freed });
  return freed;
}

/** This session's container was just killed on a budget stop (#2870). */
function noteStopped(sessionId, now = Date.now()) {
  stoppedSessions.set(Number(sessionId), now);
}

/**
 * Whether a stop on this session is recent enough to explain an empty reply.
 *
 * Deliberately generous: the window costs a requeue when it is wrong, and
 * costs an issue its triage when it is too short. Entries older than the
 * window are dropped on read, so the map cannot grow without bound.
 */
function wasStoppedRecently(sessionId, now = Date.now()) {
  const id = Number(sessionId);
  for (const [key, at] of stoppedSessions) {
    if (now - at > STOP_SETTLE_MS) stoppedSessions.delete(key);
  }
  const at = stoppedSessions.get(id);
  return at != null && now - at <= STOP_SETTLE_MS;
}

// The triage reads under way in this process, by app and request, from the
// moment a read loads the request until its turn ends: what interruptRead
// stops. Only the Pod that runs the loop has any.
const readsInFlight = new Map();
// What sends a read back to start over: a person writing in the request's
// discussion, or its title or description being edited. A claim, a vote or
// a new request is no change to what the read is reading.
const INTERRUPTING_ACTIVITY = new Set(['thread', 'updated']);

function readKey(appId, issueNumber) {
  return `${Number(appId)}:${Number(issueNumber)}`;
}

/**
 * Somebody changed a request while the bot was reading it: the read is out
 * of date before it says anything. It is marked, and its turn stopped if
 * one is running; runTriage then reads the request again from the start, so
 * the person gets one answer that covers what they just said instead of an
 * answer to the old request followed by a second read. A read that was
 * itself started over is left to finish, so a busy discussion can never
 * keep the bot from answering. Never throws.
 */
function interruptRead({ appId, issueNumber, reason } = {}) {
  if (!INTERRUPTING_ACTIVITY.has(String(reason))) return false;
  const read = readsInFlight.get(readKey(appId, issueNumber));
  if (!read || !read.restartable || read.interrupted) return false;
  read.interrupted = true;
  log.info('homeroom-bot', 'A person changed a request while the bot read it; starting the read over', {
    appId: Number(appId), issueNumber: Number(issueNumber), reason: String(reason), turnRunning: !!read.stop,
  });
  if (typeof read.stop === 'function') read.stop();
  return true;
}

// The conversation each request was last read in, by app and request, for
// the next read of it to continue (KEY_CONTINUE_READS). In memory: what a
// restart of this process forgets is only a saving, since a read with
// nothing to continue reads afresh as every read did before. It is never
// continued past a day, a third time in a row, or under another model, so a
// conversation cannot grow without bound (#3035's 2.7 billion tokens were
// one conversation that every request of an app was read in).
const lastReads = new Map();
const CONTINUE_READ_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CONTINUED_READS = 3;

/**
 * The conversation a read of this request may continue, or null. Taken out
 * of the map either way: a read that fails leaves nothing to continue, and
 * the next one reads afresh.
 */
function previousRead(appId, issueNumber, { model, now = Date.now() } = {}) {
  const key = readKey(appId, issueNumber);
  const last = lastReads.get(key) || null;
  lastReads.delete(key);
  if (!last || !last.threadId || last.model !== model) return null;
  if (now - last.at > CONTINUE_READ_MAX_AGE_MS || last.continued >= MAX_CONTINUED_READS) return null;
  return last;
}

/** A read that reached its verdict: the conversation the next read may continue. */
function rememberRead(appId, issueNumber, { threadId, model, continued = 0, now = Date.now() }) {
  for (const [key, entry] of lastReads) {
    if (now - entry.at > CONTINUE_READ_MAX_AGE_MS) lastReads.delete(key);
  }
  if (threadId) lastReads.set(readKey(appId, issueNumber), { threadId, model, continued, at: now });
}

/**
 * What a read that continues the request's previous one is sent instead of
 * the whole triage prompt: the request as it stands now, in full, and to
 * decide again from what it has already read. The instructions and the
 * reference are earlier in the same conversation; the format is restated
 * last, as triageClosing does. Pure.
 */
function continuedTriagePrompt({ seed, issueNumber }) {
  return [
    `==== REQUEST #${issueNumber} HAS CHANGED SINCE YOU READ IT ====`,
    'Somebody has added to the request you decided earlier in this conversation. Here it is as it stands now, in full: its title, its description, its comments and its discussion.',
    seed,
    live.screenshotNote(seed).join('\n').trim() || null,
    '==== DECIDE IT AGAIN ====',
    'Decide it again, by the same instructions as before, taking in what is new. You have already read the code it touches: read only what the change needs, and do not repeat reads you made before. The app\'s code may have changed since then, so check any file your verdict depends on rather than relying on memory.',
    `END YOUR REPLY WITH EXACTLY ONE fenced JSON block in the same format as before, for issue #${issueNumber}, and nothing after it:\n${VERDICT_FORMAT}\n${VERDICT_KEYS_LINE}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * What a turn used, from the relay's per-request sum, and what that costs
 * at the turn's catalog price (#3038). Null when the relay saw no request
 * finish; `costUsd` is null when the turn had no pricing snapshot. The
 * relay's input counts its cache reads and writes, as the ledger's does, so
 * those shares are priced at the snapshot's cache rates the same way.
 */
function relaySpend(relayUsage, pricing, agentTurn) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const requests = count(relayUsage?.requests);
  if (!requests) return null;
  const inputTokens = count(relayUsage.inputTokens) ?? 0;
  const outputTokens = count(relayUsage.outputTokens) ?? 0;
  const { estimatedCostUsd } = agentTurn.estimateRequestedModelCost({
    inputTokens,
    cachedInputTokens: count(relayUsage.cachedInputTokens) ?? 0,
    cacheWriteInputTokens: count(relayUsage.cacheWriteInputTokens) ?? 0,
    outputTokens,
  }, pricing);
  return {
    requests, inputTokens, outputTokens,
    costUsd: Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : null,
  };
}

/**
 * What one routed turn spent: the ledger's figure when it has one, else the
 * relay's (relaySpend), the way runTriage prices its own turn.
 */
function turnSpend(routed, pricing, agentTurn) {
  const result = (routed && routed.result) || {};
  const ledger = Number.isFinite(routed && routed.estimatedCostUsd) ? routed.estimatedCostUsd : null;
  const relay = relaySpend(result.relayUsage, pricing, agentTurn);
  return {
    costUsd: ledger ?? relay?.costUsd ?? null,
    inputTokens: Number.isFinite(result.inputTokens) ? result.inputTokens : (relay?.inputTokens ?? null),
    outputTokens: Number.isFinite(result.outputTokens) ? result.outputTokens : (relay?.outputTokens ?? null),
  };
}

/** A sum of figures that may be unknown: unknown only when both are. */
function addKnown(a, b) {
  return a == null && b == null ? null : (a || 0) + (b || 0);
}

// The one turn a triage reply that never wrote its JSON block gets, on the
// same thread, and how long it may take. It reads nothing: the verdict was
// reached, usually said in words, and only the block is missing.
const VERDICT_REPAIR_MS = 3 * 60 * 1000;
const VERDICT_REPAIR_PROMPT = [
  'Your reply ended without the fenced JSON block your instructions asked for, so it could not be read.',
  'Do not read any more files and do not use any tool.',
  'Reply now with ONLY that one fenced ```json block, for the verdict you reached, in exactly the format your instructions gave, with nothing before or after it:',
  VERDICT_FORMAT,
  VERDICT_KEYS_LINE,
].join('\n');

/**
 * Ask a triage thread for the JSON block its reply left out: one short turn
 * resuming that thread, stopped on its own wall clock the way the triage is.
 * Returns { routed, pricing, stopped }, or null when there is no thread to
 * resume or another flow took the session meanwhile (#1006). A dispatch
 * that throws is a routed error.
 */
async function askForVerdictBlock(pool, config, {
  bot, session, model, containerName, threadId, budgetMs, deps, harness = 'auto',
}) {
  const { worker, agentTurn, sessions, activeWorkers } = deps;
  if (!threadId || activeWorkers.has(session.id)) return null;
  await pool.query(
    "UPDATE chat_sessions SET status = 'active', last_activity_at = NOW() WHERE id = $1",
    [session.id],
  );
  activeWorkers.add(session.id);
  let stopped = false;
  let stopping = null;
  const timer = setTimeout(() => {
    stopped = true;
    noteStopped(session.id);
    stopping = Promise.resolve(worker.stopTurn(session.id)).catch((err) => {
      log.warn('homeroom-bot', 'Verdict block stop failed', { sessionId: session.id, err: err.message });
    });
  }, budgetMs);
  if (typeof timer.unref === 'function') timer.unref();
  let routed;
  let pricing = null;
  try {
    routed = await sessions.runCodexAttemptLoop({
      pool, session, userId: bot.id, config, isCodexSession: true,
      turnModel: model, resumeThreadId: threadId, mode: 'scout',
      telemetryComponent: 'homeroom_bot_triage',
      resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
        pool, session, userId: bot.id, model, resumeThreadId: threadId, config, harness,
      }),
      dispatchOnce: (ctx) => {
        pricing = ctx?.pricingSnapshot || pricing;
        // A thread the runtime would not resume (another CLI's, #3296)
        // leaves a fresh one, where the ask reads as a request to invent a
        // verdict for a request the model never saw.
        if (ctx && !ctx.resumeSessionId) throw new Error('the triage thread could not be resumed');
        return worker.execInWorker(session.id, {
          mode: 'scout',
          prompt: VERDICT_REPAIR_PROMPT,
          model,
          commitMsg: '',
          resumeSessionId: threadId,
          branchName: session.branch_name,
          ...(ctx || {}),
          telemetryComponent: 'homeroom_bot_triage',
          onProgress: () => {},
        });
      },
      retryPredicate: () => null,
      sendStatus: async () => {},
      waitForStopped: async () => {},
      prepareRetry: async () => false,
      classifyAttemptStatus: ({ failed }) => (failed ? 'failed' : 'completed'),
      containerName,
    });
  } catch (err) {
    routed = { error: `dispatch: ${err.message}` };
  } finally {
    clearTimeout(timer);
    if (stopping) await stopping;
    activeWorkers.delete(session.id);
    await pauseIdleSession(pool, session.id);
  }
  return { routed: routed || { error: 'not_a_codex_session' }, pricing, stopped };
}

/**
 * Why a turn came back with nothing (#2870).
 *
 * The worker's watch state is what `execInWorker` returns, and it already
 * carries the provider's own account of how the turn ended. None of it was
 * being recorded, so an empty reply reached the ledger as the bare string
 * `(empty reply)` — 21 of the first 225 runs, with no way to tell a
 * provider refusal from a rate limit from a container that died. Anything
 * non-null here is worth more than the guess it replaces.
 */
function describeStop(result) {
  const parts = [];
  const add = (label, value) => {
    if (value == null || value === '') return;
    parts.push(`${label}=${clip(String(value), 120)}`);
  };
  add('subtype', result.resultSubtype);
  add('stop', result.providerStopReason);
  add('code', result.agentErrorCode);
  add('markerless', result.markerlessCause);
  if (result.agentExit != null && result.agentExit !== 0) add('agentExit', result.agentExit);
  if (result.ccExit != null && result.ccExit !== 0) add('ccExit', result.ccExit);
  add('err', result.agentError);
  return parts.length ? `[${parts.join(' ')}]` : '[no reason reported]';
}

/**
 * Clear a turn record nothing owns any more (#2737).
 *
 * `chat_sessions.active_turn` is what makes a session refuse a new turn.
 * It is cleared when a turn ends, and a turn that dies without ending is
 * recovered by adopting its worker CONTAINER — so once the container is
 * gone (idle eviction, a replaced Pod) there is nothing left to do the
 * clearing, and the session refuses every turn forever. The first day of
 * shadow triage lost an app to exactly that for over an hour.
 *
 * Narrow on purpose: the bot's own synthetic session, a record older than
 * the turn budget (so a live turn is never touched), and only when no
 * container claims the session.
 */
async function clearStaleTurn(pool, session, { worker, maxAgeMs, now = Date.now() }) {
  const { rows } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [session.id]);
  const activeTurn = rows[0]?.active_turn || null;
  if (!activeTurn) return null;
  const startedAt = toMs(activeTurn.startedAt);
  if (startedAt && now - startedAt < maxAgeMs) return null;

  let containers = [];
  try {
    containers = await worker.listOrphanWorkers();
  } catch (err) {
    log.warn('homeroom-bot', 'Could not list workers; leaving the turn record alone', { err: err.message });
    return null;
  }
  const owned = containers.some((c) => Number(c.sessionId) === Number(session.id)
    && String(c.state || '').toLowerCase() === 'running');
  if (owned) return null;

  const turnLifecycle = require('./turn-lifecycle');
  await worker.clearActiveTurn(session.id, turnLifecycle.cleanupArgs(activeTurn));
  const ageMs = startedAt ? now - startedAt : null;
  log.warn('homeroom-bot', 'Cleared a turn record no container owned', {
    sessionId: session.id, ageMs,
  });
  return { ageMs };
}

// ── A held verdict, reused when its turn comes ──────────────────────────
//
// A ready verdict a cap held is stored as it was reached (cap_suppressed on
// its run), and the refresh brings its request back once the cap has room
// (CAP_FREED_REASON). That used to read the request again from the start:
// a whole model turn, a second "looking at this" note, and then the caps
// checked again, often only to be held again (46 such reads in a week, 25
// of them in 75 minutes). Each read now records what it saw
// (readFingerprintOf); when the request has not changed since the held
// verdict read it, that verdict is acted on again as it stands.

const READ_FINGERPRINT_VERSION = 1;

// A GitHub login or a Homeroom username, compared as the seed compares the
// bot's own login (thread-context.js renderEntry).
function authorKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\[bot\]$/, '');
}

/**
 * Pure: what a read saw of its request, as a hash to compare with a later
 * look: its title and body, its GitHub comments (id, author, body) and its
 * Homeroom discussion (author, time, body). A screenshot is a link in one
 * of those, so a new or changed one changes the hash too. The bot's own
 * posts (`botLogins`: its GitHub login and Homeroom username) are left
 * out: the held note it posts after the read is not a change to the
 * request. The counts beside the hash are for whoever reads the run.
 */
function readFingerprintOf({ issue, comments = [], threadMessages = [], botLogins = [] } = {}) {
  const own = new Set((Array.isArray(botLogins) ? botLogins : []).map(authorKey).filter(Boolean));
  const theirs = (entry) => !own.has(authorKey(entry?.author));
  const github = (Array.isArray(comments) ? comments : []).filter(theirs)
    .map((c) => [c?.id == null ? null : String(c.id), authorKey(c?.author), String(c?.body || '')]);
  const discussion = (Array.isArray(threadMessages) ? threadMessages : []).filter(theirs)
    .map((m) => [authorKey(m?.author), String(m?.createdAt || ''), String(m?.body || '')]);
  const title = String(issue?.title || '');
  const body = String(issue?.body || '');
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify([READ_FINGERPRINT_VERSION, title, body, github, discussion]))
    .digest('hex');
  const ids = github.map(([id]) => id).filter(Boolean);
  return {
    v: READ_FINGERPRINT_VERSION,
    hash,
    comments: github.length,
    lastCommentId: ids.length ? ids[ids.length - 1] : null,
    messages: discussion.length,
  };
}

/**
 * The request's last run, as lastRunsByIssue reads it, when it is a live
 * ready verdict a cap held and it recorded what it read; else null.
 */
async function heldReadyRun(pool, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT id, verdict, cap_suppressed, mode, read_fingerprint, determined, missing_fact, build_note, reason,
            plan, complicated, about_platform, model
       FROM homeroom_bot_runs
      WHERE app_id = $1 AND issue_number = $2
        AND budget_stop IS DISTINCT FROM 'input tokens'
        AND (error IS NULL OR error NOT LIKE 'collateral:%')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [appId, issueNumber],
  );
  const run = rows[0];
  if (!run || run.verdict !== 'ready' || !run.cap_suppressed || run.mode !== 'live') return null;
  if (!run.read_fingerprint?.hash) return null;
  return run;
}

/**
 * A newer verdict on a request replaces any build still waiting for an
 * older one: the shadow lane's, and a live build waiting its turn.
 */
async function supersedeEarlierBuilds(pool, { app, issueNumber, runId }) {
  await supersedeQueuedBuilds(pool, { appId: app.id, issueNumber, runId }).catch((err) => {
    log.warn('homeroom-bot', 'Could not supersede a queued shadow build', { app: app.slug, issueNumber, err: err.message });
  });
  await pool.query(
    `UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_error = 'superseded: a later verdict on the same issue'
      WHERE app_id = $1 AND issue_number = $2 AND id <> $3
        AND live_build_waiting_at IS NOT NULL AND build_ok IS NULL AND build_session_id IS NULL`,
    [app.id, issueNumber, runId],
  ).catch((err) => log.warn('homeroom-bot', 'Could not supersede a waiting live build', { app: app.slug, issueNumber, err: err.message }));
}

/**
 * A cap_freed request whose held ready verdict still answers it: the
 * request as it stands is compared with what that verdict read, and when
 * nothing changed, a new run carries the held one's verdict (its plan,
 * build note and the rest) at no cost, the caps are checked again, and it
 * is acted on as a fresh ready verdict is: built, or held again without
 * the held note said twice. Nothing is posted before it, as nothing was
 * read. Returns runTriage's result, or null to read the request as usual:
 * a held run that recorded nothing, or a request that changed.
 */
async function reuseHeldVerdict(pool, config, {
  bot, app, repo, item, issue, settings, runMode, startedMs, turnBudgetMs, deps,
}) {
  const { github, threadContext, sessions } = deps;
  const issueNumber = Number(item.issue_number);
  const held = await heldReadyRun(pool, app.id, issueNumber).catch((err) => {
    log.warn('homeroom-bot', 'Could not read a request\'s held verdict', { app: app.slug, issueNumber, err: err.message });
    return null;
  });
  if (!held) return null;
  const personAt = await personActivityAt(pool, app.id, issueNumber).catch(() => null);
  const seedReadAt = new Date().toISOString();
  const [{ comments = [] } = {}, thread, botLogin] = await Promise.all([
    github.fetchIssueComments(repo.owner, repo.repo, issueNumber).catch(() => ({ comments: [] })),
    threadContext.loadIssueThread(pool, app.id, issueNumber),
    live.botUsernameOf(github),
  ]);
  const fingerprint = readFingerprintOf({
    issue, comments, threadMessages: thread?.messages || [], botLogins: [botLogin, bot.username],
  });
  if (fingerprint.hash !== held.read_fingerprint.hash) {
    log.info('homeroom-bot', 'Held request changed since its verdict; reading it again', {
      app: app.slug, issueNumber, heldRunId: Number(held.id),
    });
    return null;
  }
  let parsed = {
    verdict: 'ready', determined: held.determined, missingFact: held.missing_fact, buildNote: held.build_note,
    reason: held.reason, plan: held.plan && typeof held.plan === 'object' ? held.plan : null,
    complicated: held.complicated === true, platform: held.about_platform === true,
  };
  // As a fresh read: a change its requester was asked to plan is planned
  // with them again.
  if (!parsed.complicated && await plannedWithRequester(pool, { appId: app.id, issueNumber })) {
    parsed = { ...parsed, complicated: true };
  }
  const capSuppressed = await simulateCaps(pool, bot, app.id, 'ready', settings)
    || (parsed.complicated ? await planTripwire(pool, app.id) : null);
  const runId = await insertRun(pool, {
    ...billingOf(item, runMode),
    readReason: readReasonOf(item),
    appId: app.id, issueNumber, mode: runMode,
    verdict: 'ready', determined: parsed.determined, missingFact: parsed.missingFact,
    plan: parsed.plan, aboutPlatform: parsed.platform, complicated: parsed.complicated,
    buildNote: parsed.buildNote, reason: parsed.reason, capSuppressed,
    threadSeenAt: [issue.updatedAt, issue.createdAt, personAt].reduce(latestOf, item.thread_seen_at || null),
    model: held.model || null, costUsd: 0, inputTokens: 0, outputTokens: 0,
    durationMs: Date.now() - startedMs,
    readFingerprint: fingerprint, reusedRunId: Number(held.id),
  });
  await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
  clearRefusals(app.id);
  await supersedeEarlierBuilds(pool, { app, issueNumber, runId });
  log.info('homeroom-bot', 'Held verdict reused: the request is unchanged since it was read', {
    app: app.slug, issueNumber, runId, heldRunId: Number(held.id), cap: capSuppressed,
  });
  let acted = null;
  try {
    acted = await actOnVerdict({
      pool, config, bot, app, repo, issueNumber, issue, parsed, capSuppressed, runId,
      seed: sessions.buildHeadlessSeed(issueNumber, issue, comments, botLogin, thread?.messages || []),
      seedReadAt, postedAt: [], turnBudgetMs, botLogin, comments,
      model: stageModel(settings, config, 'build'), specModel: stageModel(settings, config, 'spec'),
      // Its requester was told it is held when it was; held again says nothing.
      quietHold: true,
      proposalCeiling: botProposalCeiling(settings),
      deps,
    });
  } catch (err) {
    log.error('homeroom-bot', 'Acting on a reused verdict failed', { app: app.slug, issueNumber, err: err.message });
  }
  return { ran: true, verdict: 'ready', runId, reused: Number(held.id), ...(acted ? { acted } : {}) };
}

/**
 * A project's first version whose plan was written at Make it
 * (services/first-version-plan.js, newcomer run four, 13 October 2026): its
 * request is not read by a triage turn. A run is made from that plan as a
 * ready verdict whose plan it is (its bullets and choices, its build note),
 * and acted on as a first version's ready verdict is (actOnVerdict, then
 * awaitGo). When its maker already answered its questions on the made
 * screen, or it asks none, it goes ahead at once with those answers
 * (goAheadIfDecided): no Build it, and the chat's plan card says it is
 * being built, sent without a ring. Otherwise it waits for them as before,
 * and their Submit, or Build it in the chat, goes ahead with it.
 *
 * Only the request's first look: a plan somebody asked to change, a read a
 * restart sent back, or a request already planned is read by the triage as
 * before; so is one whose plan failed or is not there. A plan still being
 * written is waited for a few seconds (first-version-plan.js whenReady).
 * Returns runTriage's result, or null to read the request as usual.
 */
async function planFromEarly(pool, config, {
  bot, app, repo, item, issue, settings, runMode, startedMs, turnBudgetMs, deps,
}) {
  const { github, threadContext, sessions } = deps;
  const fvPlan = require('./first-version-plan');
  const issueNumber = Number(item.issue_number);
  if (item.reason === 'plan_change' || item.reason === RESTART_REASON || item.reason === READ_AGAIN_REASON) return null;
  let row;
  try {
    const { rows: planned } = await pool.query(
      `SELECT 1 FROM homeroom_bot_runs
        WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND verdict = 'ready' LIMIT 1`,
      [app.id, issueNumber],
    );
    if (planned.length) return null;
    row = await fvPlan.whenReady(pool, app.id);
  } catch (err) {
    log.warn('homeroom-bot', 'Could not read a first version\'s plan from Make it; reading the request', { app: app.slug, issueNumber, err: err.message });
    return null;
  }
  if (!row || Number(row.issue_number) !== issueNumber || fvPlan.planStatus(row) !== 'ready') return null;
  const plan = fvPlan.planOf(row);
  if (!plan) return null;
  const personAt = await personActivityAt(pool, app.id, issueNumber).catch(() => null);
  const seedReadAt = new Date().toISOString();
  const [{ comments = [] } = {}, thread, botLogin] = await Promise.all([
    github.fetchIssueComments(repo.owner, repo.repo, issueNumber).catch(() => ({ comments: [] })),
    threadContext.loadIssueThread(pool, app.id, issueNumber),
    live.botUsernameOf(github),
  ]);
  const fingerprint = readFingerprintOf({
    issue, comments, threadMessages: thread?.messages || [], botLogins: [botLogin, bot.username],
  });
  const decidedNow = fvPlan.decided(row);
  const parsed = {
    verdict: 'ready', determined: true, missingFact: null, buildNote: plan.buildNote, reason: null,
    plan: { bullets: plan.bullets, questions: plan.questions }, complicated: false, platform: false,
    // Decided already: the chat's plan card is news, not a question.
    ...(decidedNow ? { quietPlan: true } : {}),
    // Its timeline has the plan from Make it already (first-version-timeline.js).
    fromMakeIt: true,
  };
  const capSuppressed = await simulateCaps(pool, bot, app.id, 'ready', settings);
  const runId = await insertRun(pool, {
    ...billingOf(item, runMode),
    readReason: readReasonOf(item),
    appId: app.id, issueNumber, mode: runMode,
    verdict: 'ready', determined: true, buildNote: parsed.buildNote, plan: parsed.plan, capSuppressed,
    threadSeenAt: [issue.updatedAt, issue.createdAt, personAt].reduce(latestOf, item.thread_seen_at || null),
    // What it cost was its maker's, at Make it (first-version-plan.js).
    model: plan.model || fvPlan.PLAN_MODEL, costUsd: 0, inputTokens: 0, outputTokens: 0,
    durationMs: Date.now() - startedMs,
    readFingerprint: fingerprint,
  });
  await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
  clearRefusals(app.id);
  await supersedeEarlierBuilds(pool, { app, issueNumber, runId });
  log.info('homeroom-bot', 'A first version is planned from its plan at Make it, with no read', {
    app: app.slug, issueNumber, runId, questions: plan.questions.length, decided: decidedNow, cap: capSuppressed,
  });
  let acted = null;
  try {
    acted = await actOnVerdict({
      pool, config, bot, app, repo, issueNumber, issue, parsed, capSuppressed, runId,
      seed: sessions.buildHeadlessSeed(issueNumber, issue, comments, botLogin, thread?.messages || []),
      seedReadAt, postedAt: [], turnBudgetMs, botLogin, comments,
      model: stageModel(settings, config, 'build'), specModel: stageModel(settings, config, 'spec'),
      proposalCeiling: botProposalCeiling(settings),
      firstVersion: true,
      deps,
    });
    if (acted === PLAN_ACTED.waiting || acted === PLAN_ACTED.unsent) {
      const went = await goAheadIfDecided(pool, { appId: app.id, issueNumber, runId, deps: { dm: deps.dm, ws: deps.ws } });
      if (went) acted = 'build_queued';
    }
  } catch (err) {
    log.error('homeroom-bot', 'Acting on a first version\'s plan from Make it failed', { app: app.slug, issueNumber, err: err.message });
  }
  return { ran: true, verdict: 'ready', runId, early: true, ...(acted ? { acted } : {}) };
}

/**
 * A first version's plan that waits for Build it, gone ahead with now when
 * its maker's answers are in (the made screen's Submit,
 * first-version-plan.js recordAnswers) or its plan from Make it asks
 * nothing: through its chat card when it has one (homeroom-bot-dm.js
 * buildFromAnswers decides it as Build it does), else straight on. True
 * when it went ahead. Never throws.
 */
async function goAheadIfDecided(pool, { appId, issueNumber, runId, deps = {} }) {
  try {
    const fvPlan = require('./first-version-plan');
    const row = await fvPlan.readEarlyPlan(pool, appId);
    if (!row || Number(row.issue_number) !== Number(issueNumber) || !fvPlan.decided(row)) return false;
    const went = await (deps.dm || require('./homeroom-bot-dm')).buildFromAnswers(pool, {
      appId, issueNumber, runId, userId: Number(row.user_id), answers: fvPlan.answersOf(row) || [], deps,
    });
    return !!went?.ok;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not go ahead with a decided first version\'s plan', { appId, issueNumber, runId, err: err.message });
    return false;
  }
}

/**
 * One issue, one read-only scout turn, one ledger row. Returns
 * { ran: true, verdict } or { ran: false, reason }. `budget` is the one
 * reason the caller stops the whole pass on: the queue is left alone and
 * the loop idles until the week's allowance moves.
 */
async function runTriage(pool, config, {
  bot, app, item, mode, settings = null, deps = {}, carried = null,
}) {
  const github = deps.github || require('./github');
  const worker = deps.worker || require('./worker');
  const agentTurn = deps.agentTurn || require('./agent-turn');
  const limits = deps.limits || require('./limits');
  const threadContext = deps.threadContext || require('./thread-context');
  const managedOpenRouter = deps.managedOpenRouter || require('./openrouter-managed-keys');
  // routes/sessions.js exports the seed builder and the per-attempt Codex
  // ledger loop. Required lazily: that module loads half the platform, and
  // this one is required by server.js before the route layer is.
  const sessions = deps.sessions || require('../routes/sessions');
  const activeWorkers = deps.activeWorkers || require('./active-workers').activeWorkers;

  const issueNumber = Number(item.issue_number);
  const startedMs = Date.now();
  // #3146: on an app in the live list the verdict is acted on, and the run
  // is recorded as 'live' so the ledger says which runs spoke.
  const liveMode = live.isLiveFor(settings, app);
  // A follow-up may have been started while the app's session runs
  // something else (#3703); anything but a follow-up would use that session.
  if (item.followUp && !liveMode) return { ran: false, reason: NOT_FOLLOW_UP };
  const runMode = liveMode ? 'live' : mode;
  const liveD = liveMode ? liveDeps(deps) : null;
  const turnBudgetMs = 1000 * clampInt(
    settings?.turnSeconds, DEFAULTS.turnSeconds, MIN_TURN_SECONDS, MAX_TURN_SECONDS,
  );
  const turnInputTokens = clampInt(
    settings?.turnInputTokens, DEFAULTS.turnInputTokens,
    MIN_TURN_INPUT_TOKENS, MAX_TURN_INPUT_TOKENS,
  );
  const repo = parseRepo(app.repo_url);
  // #3654: the triage stage's own model. It used to be the platform default
  // here while the turn itself ran whatever the session was stamped with
  // when it was created, so changing the model changed the ledger and not
  // the turn. stampSessionModel below makes the two agree.
  // A project's first version is read on the current configuration's
  // triage model instead (below, once who it is for is known).
  let model = stageModel(settings, config, 'triage');
  let triageHarness = 'auto';
  let triageGuidance = null;
  // What this turn read, recorded beside every run it produces once the
  // prompt exists (#3654), so it can be replayed by the benchmark.
  let snapshot = null;
  const recordSnapshot = (runId) => (snapshot && runId
    ? snapshots.recordSnapshot(pool, { runId, ...snapshot })
    : Promise.resolve(null));

  // A failed run is recorded either way. A MODEL failure (the turn ran and
  // produced nothing usable) consumes the queue row: retrying costs money
  // and the thread has not changed. A PLATFORM failure keeps the row, hands
  // it back to the queue, and tells the caller to stop the pass.
  // A REFUSAL is not a failure: no turn ran and nothing was spent, so it
  // gets no ledger row. The app backs off instead, and the loop line says
  // what happened.
  // Whether this turn is a follow-up on the bot's own proposal (set again
  // below once its open proposal is found), for what a refusal backs off.
  let followUpTurn = !!item.followUp;
  const recordRefusal = async (error) => {
    // A follow-up's session is its proposal's: only that follow-up waits.
    const { attempts, delayMs } = followUpTurn
      ? noteFollowUpRefusal(app.id, issueNumber, error)
      : noteRefusal(app.id, error);
    log.info('homeroom-bot', followUpTurn ? 'A follow-up was refused a turn; backing it off' : 'App refused a turn; backing off', {
      app: app.slug, issueNumber, error, attempts, delayMs,
    });
    // #4533: and the row says so (queueWait). A refusal leaves it where it
    // was, enqueued_at and all, so nothing showed it was waiting, or why.
    await pool.query(
      'UPDATE homeroom_bot_queue SET wait_reason = $2, wait_until = $3 WHERE id = $1',
      [item.id, error, new Date(Date.now() + delayMs).toISOString()],
    ).catch((err) => log.warn('homeroom-bot', 'Could not note why a queue row waits', { app: app.slug, issueNumber, err: err.message }));
    return { ran: false, reason: 'refused', detail: error, app: app.slug, retryInMs: delayMs, followUp: followUpTurn };
  };

  // This read's entry in readsInFlight, once it has loaded the request, and
  // what takes it out again: every way out of the read after that point
  // goes through recordFailure or past the turn.
  let read = null;
  const endRead = () => {
    if (read && readsInFlight.get(readKey(app.id, issueNumber)) === read) readsInFlight.delete(readKey(app.id, issueNumber));
  };

  // `collateral`: a turn killed by a stop on its session. Its row is kept,
  // as a platform fault's is, but it says 'collateral' rather than 'infra',
  // so it does not back off the whole bot (outcomeOf): it is one session's
  // fallout, not an outage, and pausing every project for it was how a
  // read started over mid-thread stopped all of them.
  const recordFailure = async (error, extra = {}, { infra = false, collateral = false } = {}) => {
    endRead();
    if (REFUSAL_ERRORS.has(error)) return recordRefusal(error);
    // A platform fault the current streak already recorded gets no second
    // row (#3122); the retry is still logged below.
    const id = infra && isRepeatFault(error) ? null : await insertRun(pool, {
      ...billingOf(item, runMode),
      readReason: readReasonOf(item),
      appId: app.id, issueNumber, mode: runMode, verdict: 'failed', error,
      threadSeenAt: item.thread_seen_at || null, model,
      durationMs: Date.now() - startedMs, ...extra,
    });
    // A model failure is a benchmark case too (it is what a better model
    // would get right); a platform fault is not.
    if (!infra) await recordSnapshot(id);
    if (infra) {
      await pool.query('UPDATE homeroom_bot_queue SET started_at = NULL WHERE id = $1', [item.id]);
    } else {
      await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
    }
    log.warn('homeroom-bot', 'Triage failed', { app: app.slug, issueNumber, error, infra });
    return infra
      ? { ran: false, reason: collateral ? 'collateral' : 'infra', detail: error, runId: id }
      : { ran: true, verdict: 'failed', runId: id };
  };

  if (!repo || !github.isEnabled()) return recordFailure('github_unavailable', {}, { infra: true });

  const budget = await limits.checkBudget(pool, bot.id);
  if (budget.error) {
    log.info('homeroom-bot', 'Pass paused on budget', { reason: budget.reason || null });
    // #4610: a person waiting on an answer on the bot's change hears why.
    if (liveMode) await noteFollowUpWait(pool, { app, issueNumber, bot, why: 'budget', ws: liveD.ws });
    return { ran: false, reason: 'budget', detail: budget.reason || null };
  }

  // Claimed only while it is still queued. A batch is loaded up to a
  // hundred rows at once and read one by one, so a row the refresh has
  // removed since (the request was claimed by a person, or closed) would
  // otherwise be read anyway. The live lane claims its rows itself before
  // they get here (`claimed`). The row's thread_seen_at is read back with
  // the claim: the refresh may have moved it on since the batch was loaded.
  const claim = await pool.query(
    'UPDATE homeroom_bot_queue SET started_at = NOW() WHERE id = $1 AND (started_at IS NULL OR $2::boolean) RETURNING thread_seen_at, changed_by',
    [item.id, !!item.claimed],
  );
  if (claim.rowCount === 0) {
    log.info('homeroom-bot', 'Queue row gone before its read; not reading it', { app: app.slug, issueNumber });
    return { ran: false, reason: 'gone' };
  }
  if (claim.rows?.[0]?.thread_seen_at) {
    item = { ...item, thread_seen_at: latestOf(item.thread_seen_at, claim.rows[0].thread_seen_at) };
  }
  // And what moved, for the run's read_reason (readReasonOf).
  if (claim.rows?.[0]?.changed_by) item = { ...item, changed_by: claim.rows[0].changed_by };

  const fetched = await github.fetchPublicIssue(repo.owner, repo.repo, issueNumber);
  const issue = fetched?.issue || null;
  if (!issue || (issue.state && issue.state !== 'open')) {
    await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
    return { ran: false, reason: 'not_open' };
  }
  // #3146: what this run has posted on GitHub, so its own comments are not
  // read back as a change (see homeroom-bot-live.js).
  const postedAt = [];
  // #3624: who the request is for. Their requests' turns count against a
  // weekly allowance of their own (the platform pays, up to that ceiling),
  // and a project's first version is triaged as the whole first version.
  let requester = null;
  if (liveMode) {
    const dm = deps.dm || require('./homeroom-bot-dm');
    requester = await dm.recordRequester(pool, { app, repo, issueNumber, issue }).catch((err) => {
      log.warn('homeroom-bot', 'Could not record who a request is for', { app: app.slug, issueNumber, err: err.message });
      return null;
    });
    // Whose week pays for this look (billingOf): the one who asked the bot
    // to start it, else the requester. A look the bot caused itself is free.
    const billing = billingOf(item, runMode);
    const payerId = billing.payerUserId || requester?.userId || null;
    if (requester && billing.charged && await dm.overWeeklyAllowance(pool, settings, payerId)) {
      // Held, not dropped: the row keeps its place (enqueued_at) and waits
      // for the week to reset, so it goes first then, and the refresh does
      // not drop and queue it again every five minutes meanwhile.
      // liveCandidates leaves a held row alone until then.
      await pool.query(
        'UPDATE homeroom_bot_queue SET started_at = NULL, held_until = $2 WHERE id = $1',
        // The platform's week (limits.js), not a fake's: it is only a date.
        [item.id, require('./limits').weeklyResetAt()],
      );
      const payer = payerId === requester.userId ? null : await dm.personOf(pool, payerId).catch(() => null);
      await dm.noteOverAllowance(pool, { settings, requester, payer, app, issueNumber, bot }).catch((err) => {
        log.warn('homeroom-bot', 'Could not say the allowance is spent', { app: app.slug, issueNumber, err: err.message });
      });
      log.info('homeroom-bot', 'Request held until the week resets: its payer\'s building time is used up', {
        app: app.slug, issueNumber, userId: payerId,
      });
      // #4610: and a person who wrote on the bot's change for it hears it
      // there, where they wrote, not only in the requester's DM.
      await noteFollowUpWait(pool, { app, issueNumber, bot, why: 'allowance', ws: liveD.ws });
      return { ran: false, reason: 'user_allowance' };
    }
  }
  if (liveMode) {
    const open = await live.openBotProposal(pool, bot.id, app.id, issueNumber);
    if (!open && item.followUp) return { ran: false, reason: NOT_FOLLOW_UP };
    if (open) {
      // One proposal per issue: the group is already voting on the bot's
      // answer, and a second build would be a second, competing proposal.
      // What people said since it proposed is answered ON that proposal
      // (#3264), while it is still up for a vote.
      if (open.status === 'promoted') {
        followUpTurn = true;
        return runFollowUp(pool, config, {
          bot, app, repo, item, issue, proposal: open, runMode,
          model: stageModel(settings, config, 'followup'),
          turnBudgetMs: followUpBudgetMs(app, config, turnBudgetMs), startedMs,
          recordFailure,
          deps: {
            github, worker, agentTurn, limits, threadContext, managedOpenRouter, sessions,
            activeWorkers, votes: deps.votes || null, dm: deps.dm || null, ...liveD,
            ...(deps.voice ? { voice: deps.voice } : {}), ...(deps.voiceDeps ? { voiceDeps: deps.voiceDeps } : {}),
          },
        });
      }
      await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
      log.info('homeroom-bot', 'Issue\'s bot proposal is merging; not looking again', {
        app: app.slug, issueNumber, sessionId: open.id,
      });
      return { ran: false, reason: 'has_proposal' };
    }
    // #4488: "build it" from its requester under a complicated change's plan
    // is Build it, not a new look: the build goes ahead from that plan.
    if (await buildItOnRequest(pool, { appId: app.id, issueNumber, requester, deps: { dm: deps.dm, ws: liveD.ws } })) {
      await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
      return { ran: false, reason: 'build_it' };
    }
    // A ready verdict a cap held, its turn come: reused as it stands when
    // the request has not changed since it was read (reuseHeldVerdict), with
    // no read and nothing said first. A first version is planned afresh.
    if (item.reason === CAP_FREED_REASON && !requester?.firstVersion) {
      const reused = await reuseHeldVerdict(pool, config, {
        bot, app, repo, item, issue, settings, runMode, startedMs, turnBudgetMs,
        deps: {
          github, worker, agentTurn, limits, threadContext, managedOpenRouter, sessions, activeWorkers, ...liveD,
        },
      });
      if (reused) return reused;
    }
    // An issue a restart sent back (#3471), or a read started over because
    // somebody changed the request mid-read, was already told the bot is
    // looking; it is not told twice. A backlog pass says nothing yet (#3509).
    const looked = item.reason === RESTART_REASON || item.reason === APP_AGAIN_REASON
      || item.reason === RETRY_FAILED_REASON || item.reason === READ_AGAIN_REASON ? null : await live.post({
      pool, github, ws: liveD.ws, app, repo, issueNumber,
      kind: 'looking', text: live.lookingText(), sender: bot,
      // 10 October: with the bot's voice on in requests' discussions, a read
      // is recorded but not announced: the request's card and the tray say
      // it is reading, and what it posts there is what it found.
      ...(voiceModule(deps).voiceOn(settings, { type: 'issue' }) ? { skipIssueThread: true, skipGithub: true } : {}),
    }).catch((err) => {
      log.warn('homeroom-bot', 'Looking post failed (continuing)', { app: app.slug, issueNumber, err: err.message });
      return null;
    });
    if (looked?.githubCreatedAt) postedAt.push(looked.githubCreatedAt);
    // #3736: and the person it is for gets a card in their DM with the bot
    // that follows this piece of work to its end, told when the request is:
    // not twice for a restart or a read started over, and not for a backlog
    // pass. Never throws.
    if (item.reason !== RESTART_REASON && item.reason !== APP_AGAIN_REASON && item.reason !== READ_AGAIN_REASON) {
      await activity().startCard(pool, {
        app, issueNumber, requester, bot, jobKey: item.id, settings, inDm: DM_REASONS.has(item.reason), reason: item.reason,
        deps: { dm: deps.dm },
      });
      // B9: the chat message it was asked in, if it was, says it is read.
      await require('./homeroom-bot-chat').noteRequestStatus(pool, { appId: app.id, issueNumber, status: 'reading' });
    }
    // B6: a plan still waiting for Build it is not what the bot thinks once
    // it reads the request again. Its buttons go now, so a tap while this
    // look runs builds nothing; this look sends a plan of its own.
    await retireWaitingPlans(pool, { appId: app.id, issueNumber, why: 'the request was read again', deps: { dm: deps.dm } });
    // 13 Oct 2026: a first version whose plan was written at Make it is
    // planned from that plan, with no read (planFromEarly); one without
    // such a plan is read below, as before.
    if (requester?.firstVersion) {
      const early = await planFromEarly(pool, config, {
        bot, app, repo, item, issue, settings, runMode, startedMs, turnBudgetMs,
        deps: {
          github, worker, agentTurn, limits, threadContext, managedOpenRouter, sessions, activeWorkers, ...liveD,
          ...(deps.dm ? { dm: deps.dm } : {}),
        },
      });
      if (early) return early;
    }
  }
  // From here the read has the request as it stands: a person changing it
  // now sends this read back to start over (interruptRead), once.
  read = { restartable: item.reason !== READ_AGAIN_REASON, interrupted: false, stop: null };
  readsInFlight.set(readKey(app.id, issueNumber), read);
  // What this read has seen, recorded on its run: the newest of the row's
  // own figure, the issue as fetched, and a person's last word in the
  // discussion, read BEFORE the thread is loaded so anything it counts is in
  // what the turn reads. The row's figure alone was the refresh's from when
  // it queued the request; a message that landed in between was read but
  // recorded as unread, and the next refresh read the request again for
  // nothing (#4022 sat in a loaded batch for about twenty minutes). A row
  // queued with none (an admin's run now, a restart) recorded none, which
  // the next refresh read as a change.
  const personAt = await personActivityAt(pool, app.id, issueNumber).catch((err) => {
    log.warn('homeroom-bot', 'Could not read a request\'s last discussion message', { app: app.slug, issueNumber, err: err.message });
    return null;
  });
  item = {
    ...item,
    thread_seen_at: [issue.updatedAt, issue.createdAt, personAt].reduce(latestOf, item.thread_seen_at || null),
  };
  const seedReadAt = new Date().toISOString();
  const [{ comments = [] } = {}, thread, botUsername] = await Promise.all([
    github.fetchIssueComments(repo.owner, repo.repo, issueNumber).catch(() => ({ comments: [] })),
    threadContext.loadIssueThread(pool, app.id, issueNumber),
    // Resolved, never the Promise: see live.botUsernameOf.
    live.botUsernameOf(github),
  ]);
  const seed = sessions.buildHeadlessSeed(
    issueNumber, issue, comments, botUsername, thread?.messages || [],
  );
  // What this read saw of the request, so a ready verdict a cap holds can be
  // reused when its turn comes if nothing has changed (reuseHeldVerdict).
  const readFingerprint = readFingerprintOf({
    issue, comments, threadMessages: thread?.messages || [], botLogins: [botUsername, bot.username],
  });
  // #3772: on a project of one, the person who asked decides what the group
  // would; on a project with more, its creator and admins do. Only on a
  // project the bot acts on, where it says its verdict.
  const decider = liveMode && requester
    ? await whoDecides(pool, app, requester).catch((err) => {
      log.warn('homeroom-bot', 'Could not read who decides on a project', { app: app.slug, err: err.message });
      return null;
    })
    : null;
  // B6: what its creator asked a first version's plan changed with, in a
  // private chat with the bot, so this look plans it again with that.
  const planChange = liveMode && requester?.firstVersion
    ? await planChangesFor(pool, app.id, issueNumber).catch((err) => {
      log.warn('homeroom-bot', 'Could not read the changes asked to a plan', { app: app.slug, issueNumber, err: err.message });
      return null;
    })
    : null;
  // 2026-10-04: and who is in its project, so the plan is about its real
  // people rather than the sketch's sample ones.
  const members = liveMode && requester?.firstVersion
    ? await projectMembers(pool, app).catch((err) => {
      log.warn('homeroom-bot', 'Could not read a project\'s members', { app: app.slug, err: err.message });
      return null;
    })
    : null;
  // A project's first version is read by the current configuration
  // (services/bot-configs.js): its triage model, and its pack's guidance.
  // Every other request keeps the per-stage setting.
  if (liveMode && requester?.firstVersion) {
    const version = await botConfigs().currentVersion(pool);
    if (version) {
      model = version.recipe.models.triage;
      triageHarness = live.recipeHarness(model, config);
      triageGuidance = (await botConfigs().recipeGuidance(pool, version.recipe))?.triage || null;
    }
  }
  // A project made from a game starter: its plan is the creator's game
  // built on that working game (firstVersionNote).
  const starter = liveMode && requester?.firstVersion
    ? await starterOfApp(pool, app.id).catch((err) => {
      log.warn('homeroom-bot', 'Could not read a project\'s starter', { app: app.slug, err: err.message });
      return null;
    })
    : null;
  const promptInput = {
    seed, issueNumber, firstVersion: !!requester?.firstVersion, decider,
    ...(members ? { members } : {}),
    ...(starter ? { starter } : {}),
    // #4645: their language preference, for the triage's wording rule.
    locale: requester?.locale || null,
    ...(triageGuidance ? { guidance: triageGuidance } : {}),
    ...(planChange ? { planChange: { ...planChange, requester: requester.username } } : {}),
  };
  // The prompt as it stands before the turn resolves its model. The one sent
  // is rendered at dispatch, for what that model can see, and replaces this
  // in the snapshot (below).
  const prompt = triagePromptFor(promptInput);
  snapshot = {
    stage: 'triage', appId: app.id, issueNumber,
    // The scout turn resets its workspace to the session branch's tip
    // (main) when it starts, so that tip is what it read.
    baseSha: await headShaOf(github, repo, 'main'),
    texts: {
      seed,
      prompt,
      thread: snapshots.frozenThread({
        issueNumber, issue, comments, threadMessages: thread?.messages || [], botLogin: botUsername,
      }),
    },
    extra: {
      model, firstVersion: !!requester?.firstVersion, mode: runMode, reason: item.reason || null,
      ...(deciderNote(decider) ? { decider } : {}),
      // So the benchmark rebuilds the prompt this look read (bench/runner.js).
      ...(members ? { members } : {}),
      ...(starter ? { starter } : {}),
    },
  };

  let session;
  try {
    session = await ensureBotSession(pool, config, bot, app);
  } catch (err) {
    return recordFailure(`session: ${err.message}`, {}, { infra: true });
  }
  // Another flow in this process holds the session: restart recovery
  // following a triage turn that outlived a deploy. Nothing below may
  // touch it (the stale-turn clear, the status, the registry entry), or
  // the turn recovery is finishing is cut from under it (#1006).
  if (activeWorkers.has(session.id)) return recordFailure('session_busy', { sessionId: session.id });
  // The session was stamped with a model once, when it was created; the
  // turn runs whatever it carries (agent-turn resolveCodexRuntimeContext).
  await live.stampSessionModel(pool, session, model);

  let containerName = null;
  try {
    await worker.ensureWorkerImage();
    containerName = await worker.ensureWorker(session.id, {
      repoOwner: repo.owner, repoName: repo.repo, branchName: session.branch_name,
      // Scratch storage, not a volume (#3122, using #3119's option). Every
      // issue starts a fresh thread, so nothing on the worker needs to
      // outlive it, and a volume per app is what filled the quota.
      temporary: true,
      onProgress: () => {},
    });
  } catch (err) {
    // #4533: a worker that cannot change its storage under a running turn
    // is a busy session, never a platform fault that pauses the whole bot.
    if (err?.code === 'session_busy') return recordFailure('session_busy', { sessionId: session.id });
    return recordFailure(`worker: ${err.message}`, { sessionId: session.id }, { infra: true });
  }

  // A turn record nothing owns any more would refuse every turn from here
  // on. Checked after the container is up, so a live turn is never touched.
  await clearStaleTurn(pool, session, { worker, maxAgeMs: turnBudgetMs })
    .catch((err) => log.warn('homeroom-bot', 'Stale turn check failed', { err: err.message }));

  // A fresh model conversation for every issue (#3035). Passing a null
  // thread below is NOT enough: the platform reads null as "carry on the
  // session's saved thread" (resolveCodexRuntimeContext falls back to
  // `session.agent_thread_id`, the attempt loop to the runtime's thread),
  // and every finished turn saves its thread back. So the bot's one session
  // per app was one conversation per app — the Homeroom app's ran from
  // 2026-09-21 onward, every issue triaged with all the earlier ones in
  // context, its usage a running total that passed 2.7 billion tokens.
  // Clearing the saved thread here, in the row and in the object the
  // runtime is resolved from, is what makes every path resolve to none.
  await pool.query(
    "UPDATE chat_sessions SET status = 'active', agent_thread_id = NULL, last_activity_at = NOW() WHERE id = $1",
    [session.id],
  );
  session.agent_thread_id = null;
  activeWorkers.add(session.id);
  // A stop stays pending on the session after the turn it stopped has
  // ended, and the worker skips every dispatch until a new turn clears it
  // (#937). Nothing here cleared it, so the read started over after a
  // person wrote mid-read was skipped at once, came back empty and was
  // recorded as collateral, which paused the bot on every project
  // (homeroom-maps #30, run 1250); a request read after a budget or
  // verdict-block stop on the same session was skipped the same way. This
  // turn is that new turn, as a build's is (#3396). Safe here: the session
  // is the bot's own, this flow holds it (activeWorkers), and each flow
  // that stops a turn on it awaits the stop before letting go of it, so a
  // stop pending now was aimed at a turn that is over. Cleared before this
  // turn's clock starts and its stop is wired up (read.stop), so a stop
  // aimed at this turn is never the one erased; a turn somehow still in
  // flight here keeps its stop.
  if (!worker.isInFlight?.(session.id)) worker.clearPendingStop?.(session.id);

  // The budget (#2737). The wall clock ends the turn the same way a person's
  // Stop button does: the in-container kill plus the journal exit marker,
  // which the attempt loop below resolves on within milliseconds.
  let budgetHit = null;
  // The kill in flight, awaited before this function returns (#3035). It
  // used to be fire-and-forget, and the next issue starts in the same
  // container the moment this one returns: a kill still landing takes that
  // issue down one to three seconds in.
  let stopping = null;
  const spendBudget = (kind) => {
    if (budgetHit) return;
    budgetHit = kind;
    log.warn('homeroom-bot', 'Triage turn stopped on its budget', {
      app: app.slug, issueNumber, kind, sessionId: session.id,
    });
    // Recorded BEFORE the kill, not after it: the bystander dispatch this
    // protects has already failed by the time stopTurn resolves (#2870).
    noteStopped(session.id);
    stopping = Promise.resolve(worker.stopTurn(session.id)).catch((err) => {
      log.warn('homeroom-bot', 'Budget stop failed', { sessionId: session.id, err: err.message });
    });
  };
  const budgetTimer = setTimeout(() => spendBudget('wall clock'), turnBudgetMs);
  if (typeof budgetTimer.unref === 'function') budgetTimer.unref();

  // A person changed the request mid-turn (interruptRead): the turn is
  // stopped the way the wall clock stops it, but it is not a budget stop,
  // and the read starts over below.
  const stopForActivity = () => {
    noteStopped(session.id);
    if (!stopping) {
      stopping = Promise.resolve(worker.stopTurn(session.id)).catch((err) => {
        log.warn('homeroom-bot', 'Stop for new activity failed', { sessionId: session.id, err: err.message });
      });
    }
  };

  // Reading a request again continues the conversation that read it last
  // (KEY_CONTINUE_READS), unless this read is a different job: a first
  // version's plan, or its creator's changes to one.
  const previous = settings?.continueReads !== false && !requester?.firstVersion && !planChange
    ? previousRead(app.id, issueNumber, { model })
    : null;
  // Whether the turn that answered was sent only what changed.
  let continuedTurn = false;

  let routed;
  // The turn's pricing snapshot, as the runtime resolved it, so a turn the
  // ledger could not price is priced from the same catalog (#3038).
  let pricing = null;
  // What a turn spent that could not continue its conversation, before the
  // read went afresh: part of this read, so part of its row.
  let resumeSpent = null;
  const turn = (resumeThreadId) => {
    read.stop = stopForActivity;
    return sessions.runCodexAttemptLoop({
      pool, session, userId: bot.id, config, isCodexSession: true,
      turnModel: model, resumeThreadId, mode: 'scout',
      telemetryComponent: 'homeroom_bot_triage',
      resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
        pool, session, userId: bot.id, model, resumeThreadId, config,
        // The platform's per-model choice of CLI, as the dev chat's scout
        // makes it (#3296): GLM runs in Claude Code. A first version's
        // configuration may name an Anthropic model, which runs there too.
        harness: triageHarness,
      }),
      dispatchOnce: (ctx) => {
        pricing = ctx?.pricingSnapshot || pricing;
        // Rendered for what this turn's model can see, as its runtime
        // resolved it, and recorded as what the turn read: the whole prompt
        // even for a continued read, so the benchmark replays the request
        // as it stood.
        const wholePrompt = triagePromptFor({
          ...promptInput, readsImages: require('./prompts').runtimeReadsImages(ctx),
        });
        snapshot.texts.prompt = wholePrompt;
        // Only a conversation the runtime is resuming is sent only what
        // changed: one it would not resume (another CLI's, #3296) leaves a
        // fresh conversation, which needs the whole prompt.
        continuedTurn = !!resumeThreadId && !!ctx?.resumeSessionId;
        const turnPrompt = continuedTurn ? continuedTriagePrompt({ seed, issueNumber }) : wholePrompt;
        return worker.execInWorker(session.id, {
          mode: 'scout',
          // No `onUsage` here, deliberately (#3035). Neither agent the bot can
          // run reports usage until its turn is over, so a token check wired
          // to the stop can only ever fire on a finished turn — and did, on
          // every one, discarding the verdict and killing the next issue. The
          // token limit is read after the turn instead, below, and never
          // throws a result away. The wall clock is what ends a runaway.
          prompt: turnPrompt,
          model,
          commitMsg: '',
          resumeSessionId: null,
          branchName: session.branch_name,
          ...(ctx || {}),
          telemetryComponent: 'homeroom_bot_triage',
          onProgress: () => {},
        });
      },
      retryPredicate: () => null,
      sendStatus: async () => {},
      waitForStopped: async () => {},
      prepareRetry: async () => false,
      classifyAttemptStatus: ({ failed }) => (failed ? 'failed' : 'completed'),
      containerName,
    });
  };
  try {
    // Changed before the turn could start: there is nothing to stop, only
    // the request to read again.
    if (!read.interrupted) {
      routed = await turn(previous ? previous.threadId : null);
      // The worker no longer has that conversation (a new worker since): the
      // runtime asks for a fresh start, which this read makes itself, with
      // the whole prompt.
      if (previous && routed?.result?.agentRetryFresh === true && !budgetHit && !read.interrupted) {
        log.info('homeroom-bot', 'The last read\'s conversation is gone; reading the request afresh', {
          app: app.slug, issueNumber,
        });
        resumeSpent = turnSpend(routed, pricing, agentTurn);
        routed = await turn(null);
      }
    }
  } catch (err) {
    routed = { error: `dispatch: ${err.message}` };
  } finally {
    read.stop = null;
    clearTimeout(budgetTimer);
    if (stopping) await stopping;
    activeWorkers.delete(session.id);
    // Back to rest, unless a turn still holds the session: a session paused
    // under a turn in flight is one restart recovery throws away (#1006).
    await pauseIdleSession(pool, session.id);
  }
  endRead();
  snapshot.extra.continued = continuedTurn;

  // What the turn spent, read ONCE and read null-safely, because both the
  // stopped path and the completed path below need it (#2870). The debit
  // used to live only on the completed path, under a `return` the budget
  // branch took first, so the turns that wasted the most were the only ones
  // the weekly cap never saw.
  const result = (routed && routed.result) || {};
  const ledgerCostUsd = Number.isFinite(routed && routed.estimatedCostUsd)
    ? routed.estimatedCostUsd
    : null;
  // When the ledger has no figure — always, for a turn stopped before
  // turn.completed — fall back to what the relay saw each model request use
  // (#3038), priced by the same estimator the ledger uses for a finished
  // turn, so a stopped turn and a finished one are measured alike. It is a
  // floor: the request in flight at the stop never reports.
  const relay = relaySpend(result.relayUsage, pricing, agentTurn);
  // `let`: a reply that has to be asked for its JSON block adds that turn.
  let costUsd = ledgerCostUsd ?? relay?.costUsd ?? null;
  const usage = {
    inputTokens: Number.isFinite(result.inputTokens) ? result.inputTokens : (relay?.inputTokens ?? null),
    outputTokens: Number.isFinite(result.outputTokens) ? result.outputTokens : (relay?.outputTokens ?? null),
  };
  if (ledgerCostUsd == null && relay) {
    log.info('homeroom-bot', 'Turn priced from the relay: the agent reported no usage', {
      app: app.slug, issueNumber, stopped: budgetHit || null, costUsd: relay.costUsd,
      requests: relay.requests, inputTokens: relay.inputTokens, outputTokens: relay.outputTokens,
    });
  } else if (relay && Number.isFinite(result.inputTokens)) {
    // Both figures exist on a finished turn. With a fresh thread per issue
    // they should agree; this is how production confirms the relay figure
    // before anything relies on it for a turn that did not finish.
    log.info('homeroom-bot', 'Turn usage: agent total vs relay sum', {
      app: app.slug, issueNumber, agentInputTokens: result.inputTokens, relayInputTokens: relay.inputTokens,
      agentOutputTokens: result.outputTokens ?? null, relayOutputTokens: relay.outputTokens,
      requests: relay.requests,
    });
  }

  // #2571: an included (company-funded) key's spend joins the shared weekly
  // pool the budget gate above measures; a personal key would be nobody's
  // to debit, and the bot never has one.
  const debit = async (usd) => {
    if (!(usd > 0)) return;
    try {
      if (await managedOpenRouter.usesIncludedKey(pool, bot.id)) {
        await limits.recordSpend(pool, bot.id, Math.round(usd * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('homeroom-bot', 'Spend debit failed', { err: err.message });
    }
  };
  await debit(costUsd);
  // One row for the whole read: a turn that could not continue its
  // conversation (debited here), and a read this one started over from
  // (debited when it stopped), are both part of what this read cost.
  if (resumeSpent) await debit(resumeSpent.costUsd);
  for (const spent of [resumeSpent, carried]) {
    if (!spent) continue;
    costUsd = addKnown(costUsd, spent.costUsd);
    usage.inputTokens = addKnown(usage.inputTokens, spent.inputTokens);
    usage.outputTokens = addKnown(usage.outputTokens, spent.outputTokens);
  }

  // A person changed the request while this read ran: what it found answers
  // the request as it was, so it is read again now, from the start and with
  // what was just said, rather than answered and then read again later. The
  // row stays this read's (`claimed`), and its reason says it was started
  // over, so it is not announced twice and not started over again.
  if (read.interrupted && !budgetHit) {
    // The stop was this read's own, and its turn is over (the finally above
    // awaited it), so it explains nothing about the read that starts over:
    // that read's turn clears the stop it left pending (above), and its
    // record is dropped here, so a reply that is genuinely empty is
    // recorded as one rather than as collateral.
    stoppedSessions.delete(Number(session.id));
    await pool.query('UPDATE homeroom_bot_queue SET reason = $2 WHERE id = $1', [item.id, READ_AGAIN_REASON]);
    return runTriage(pool, config, {
      bot, app, item: { ...item, reason: READ_AGAIN_REASON, claimed: true }, mode, settings, deps,
      carried: { costUsd, ...usage },
    });
  }

  // The token budget, observed rather than enforced (#2870, #3035). Usage
  // arrives once, when the turn is already over, so there is nothing left
  // to stop and the verdict is kept — but a turn that ran away is worth
  // saying out loud. With a fresh thread per issue this is the turn's own
  // usage; before #3035 it was the conversation's running total, which is
  // why it read in the billions. The wall clock is what bounds a turn.
  if (!budgetHit && usage.inputTokens != null && usage.inputTokens > turnInputTokens) {
    log.warn('homeroom-bot', 'Triage turn finished over its token budget', {
      app: app.slug, issueNumber, inputTokens: usage.inputTokens, budget: turnInputTokens,
    });
  }

  // A turn we stopped ourselves. Recorded as a failure so the ledger shows
  // what it cost, then requeued ONCE at the back — the runaway may have
  // been the issue rather than the bot, and retrying it forever is the loop
  // this whole change exists to end.
  if (budgetHit) {
    const retried = String(item.reason || '') === 'budget_retry';
    const id = await insertRun(pool, {
      ...billingOf(item, runMode),
      readReason: readReasonOf(item),
      appId: app.id, issueNumber, sessionId: session.id, mode: runMode, verdict: 'failed',
      error: `budget: ${budgetHit}`, budgetStop: budgetHit,
      threadSeenAt: item.thread_seen_at || null, model,
      costUsd, ...usage,
      durationMs: Date.now() - startedMs,
    });
    await recordSnapshot(id);
    if (retried) {
      await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
    } else {
      await pool.query(
        `UPDATE homeroom_bot_queue
            SET started_at = NULL, reason = 'budget_retry', priority = 9, enqueued_at = NOW()
          WHERE id = $1`,
        [item.id],
      );
    }
    log.warn('homeroom-bot', 'Triage stopped on its budget', {
      app: app.slug, issueNumber, kind: budgetHit, requeued: !retried, runId: id,
    });
    return { ran: true, verdict: 'failed', runId: id, budget: budgetHit };
  }

  if (!routed) return recordFailure('not_a_codex_session', { sessionId: session.id }, { infra: true });
  if (routed.error) {
    const code = String(routed.error);
    // A turn that died mid-flight on a previous process leaves active_turn
    // set on the bot's own session, and nothing else will ever clear it.
    if (code === 'session_busy' && !worker.isInFlight(session.id) && !activeWorkers.has(session.id)) {
      await worker.clearActiveTurn(session.id).catch(() => {});
      await pauseIdleSession(pool, session.id);
    }
    return recordFailure(code, { sessionId: session.id }, { infra: INFRA_ERRORS.has(code) || code.startsWith('dispatch:') });
  }
  const text = String(result.lastResultText || '');
  let parsed = parseVerdict(text);
  if (!parsed) {
    const body = clip(text.slice(-300), 300);
    if (!body) {
      // An empty reply right after a stop on this session is almost always
      // collateral, not a verdict the bot failed to parse: stopTurn kills
      // the session's container, and an issue dispatched into it
      // concurrently dies with it. Two of the first three budget stops took
      // a bystander issue down this way, each recorded as a permanent parse
      // failure a second after the stop. Put that issue back on the queue
      // instead of burning its triage on somebody else's timeout, and
      // without pausing the bot on every project for it.
      if (!budgetHit && wasStoppedRecently(session.id)) {
        return recordFailure('collateral: the session was stopped mid-dispatch', {
          sessionId: session.id, costUsd, ...usage,
        }, { infra: true, collateral: true });
      }
      // Otherwise say WHY it was empty. The worker's watch state already
      // knows — it was simply being thrown away, which left 21 of the first
      // 225 runs recorded as `(empty reply)` and nothing else.
      return recordFailure(`unparseable: (empty reply) ${describeStop(result)}`, {
        sessionId: session.id, costUsd, ...usage,
      });
    }
    // A reply that IS the runtime's provider error (gas-lock #2, 2026-10-04:
    // "API Error: 400 messages[6]: tool messages must include a non-empty
    // string tool_call_id") is the provider's failure, not the model's: it
    // is a platform fault, so the bot backs off and the issue keeps its turn,
    // and it is no benchmark case. One this issue always gets cannot wedge
    // the bot: the row it writes reads as unchanged at the next refresh,
    // which drops the issue's queue row, and counts toward
    // FAILED_TRIAGE_TRIES on this thread like any failed read.
    const apiFailure = agentApiFailure(text);
    if (apiFailure) {
      return recordFailure(`provider: ${apiFailure.line}`, {
        sessionId: session.id, costUsd, ...usage,
      }, { infra: true });
    }
    // The reply decided in words and never wrote its block (14 of the 19
    // failed triages in the week to 2026-10-06: "Small, bounded, no schema
    // … so it can", "Verdict below."). The reading is done; one short turn
    // on the same thread asks for the block alone before the run fails.
    let repairText = null;
    const repair = await askForVerdictBlock(pool, config, {
      bot, session, model, containerName, harness: triageHarness,
      threadId: result.agentThreadId || null,
      budgetMs: Math.min(VERDICT_REPAIR_MS, turnBudgetMs),
      deps: { worker, agentTurn, sessions, activeWorkers },
    });
    if (repair) {
      const spent = turnSpend(repair.routed, repair.pricing, agentTurn);
      await debit(spent.costUsd);
      costUsd = addKnown(costUsd, spent.costUsd);
      usage.inputTokens = addKnown(usage.inputTokens, spent.inputTokens);
      usage.outputTokens = addKnown(usage.outputTokens, spent.outputTokens);
      repairText = repair.routed?.result?.lastResultText || null;
      parsed = repair.stopped || repair.routed?.error ? null : parseVerdict(repairText);
      log.info('homeroom-bot', parsed ? 'Triage verdict recovered by asking for its JSON block' : 'Asking for the JSON block did not recover a verdict', {
        app: app.slug, issueNumber, verdict: parsed?.verdict || null, costUsd: spent.costUsd,
        stopped: repair.stopped || null, error: repair.routed?.error || null,
      });
    }
    if (!parsed) {
      return recordFailure(`unparseable: ${body}`, {
        sessionId: session.id, costUsd, ...usage, unreadableReply: unreadableReplyOf(text, repairText),
      });
    }
  }
  // #4488: a first version is always planned with its creator, never
  // labelled; and a change whose plan its requester was asked about, and
  // asked to change, is planned with them again whatever this look says.
  if (parsed.complicated && requester?.firstVersion) parsed = { ...parsed, complicated: false };
  if (liveMode && parsed.verdict === 'ready' && !parsed.complicated && !requester?.firstVersion
    && await plannedWithRequester(pool, { appId: app.id, issueNumber })) {
    parsed = { ...parsed, complicated: true };
  }
  // #4488: a complicated change's plan asks its requester before it is
  // built, so it counts against the daily questions and notes as well.
  const capSuppressed = await simulateCaps(pool, bot, app.id, parsed.verdict, settings)
    || (parsed.complicated ? await planTripwire(pool, app.id) : null);
  // #4239: about Homeroom itself means nothing on Homeroom's own board.
  if (parsed.platform && (await platformAppSlugs(pool)).includes(app.slug)) parsed = { ...parsed, platform: false };
  const runId = await insertRun(pool, {
    ...billingOf(item, runMode),
    readReason: readReasonOf(item),
    appId: app.id, issueNumber, sessionId: session.id, mode: runMode,
    verdict: parsed.verdict, determined: parsed.determined, missingFact: parsed.missingFact,
    question: parsed.question, questionDefault: parsed.questionDefault, questionAnswers: parsed.questionAnswers,
    plan: parsed.plan, aboutPlatform: !!parsed.platform, complicated: !!parsed.complicated,
    buildNote: parsed.buildNote, reason: parsed.reason, capSuppressed,
    threadSeenAt: item.thread_seen_at || null, model, costUsd,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    durationMs: Date.now() - startedMs, readFingerprint,
  });
  await recordSnapshot(runId);
  await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
  clearRefusals(app.id);
  // The conversation this verdict was reached in, for the request's next
  // read to continue (previousRead). A first version is planned afresh.
  if (!requester?.firstVersion) {
    rememberRead(app.id, issueNumber, {
      threadId: result.agentThreadId || null, model,
      continued: continuedTurn ? (previous?.continued || 0) + 1 : 0,
    });
  }
  // A newer verdict on the issue replaces any build still waiting for an
  // older one, shadow or live: the lane builds what the bot thinks now.
  await supersedeEarlierBuilds(pool, { app, issueNumber, runId });
  // Before anything is posted: whoever asked the bot to stop tagging them
  // is left out of this post and every later one on the issue, and whoever
  // asked to be tagged again is back in.
  if (parsed.stopMentioning?.length || parsed.resumeMentioning?.length) {
    await live.applyMentionAsks({
      pool, github, app, repo, issueNumber, stop: parsed.stopMentioning, resume: parsed.resumeMentioning, runId,
    }).catch((err) => log.warn('homeroom-bot', 'Could not record a mention opt-out', { app: app.slug, issueNumber, err: err.message }));
  }
  log.info('homeroom-bot', 'Triaged', {
    app: app.slug, issueNumber, verdict: parsed.verdict, costUsd, runId,
    ...(parsed.demoted ? { demotedQuestion: true } : {}),
  });
  let acted = null;
  if (liveMode) {
    try {
      acted = await actOnVerdict({
        pool, config, bot, app, repo, issueNumber, issue, parsed, capSuppressed, runId,
        seed, seedReadAt, postedAt, turnBudgetMs, botLogin: botUsername,
        // #4530: a look the request's own changes started repeats a note
        // only for the bot; everything else speaks as it did. The comments
        // the read fetched, so a mention on the GitHub issue counts too.
        relook: item.reason === 'changed' || item.reason === READ_AGAIN_REASON,
        // And a look somebody asked for (Ask Homeroom bot to build this, or
        // a request just filed) does not say again the note the bot is still
        // waiting on: the button is refused then (homeroom-bot-dm.js
        // askBotToBuild), and this holds the repeat if it got through. A
        // request's first look has no note before it, and speaks.
        askedLook: item.reason === ASKED_REASON,
        comments,
        model: stageModel(settings, config, 'build'), specModel: stageModel(settings, config, 'spec'),
        quietHold: item.reason === APP_AGAIN_REASON,
        proposalCeiling: botProposalCeiling(settings),
        firstVersion: !!requester?.firstVersion,
        // Who a person hand-off waits on, for the requester's DM.
        decider,
        deps: {
          github, worker, agentTurn, limits, threadContext, managedOpenRouter, sessions,
          activeWorkers, ...liveD,
        },
      });
    } catch (err) {
      log.error('homeroom-bot', 'Acting on a live verdict failed', { app: app.slug, issueNumber, err: err.message });
    }
  } else if (parsed.verdict === 'ready') {
    const skip = shadowBuildSkipReason(settings, app, config);
    try {
      if (!skip) {
        // Queued, not built here: the build lane runs it beside triage, so
        // the rest of this app's batch is not held up behind a worker.
        if (await queueShadowBuild(pool, runId)) acted = 'shadow_queued';
      } else {
        // Not built, and the run says why (the console's "Not shadow
        // built"). Fifty ready verdicts in the week to 2026-10-09 had no
        // build and nothing on the run to say why.
        await pool.query(
          `UPDATE homeroom_bot_runs SET build_error = $2
            WHERE id = $1 AND build_ok IS NULL AND build_queued_at IS NULL`,
          [runId, clip(`skipped: ${skip}`, MAX_ERROR_CHARS)],
        );
      }
    } catch (err) {
      log.error('homeroom-bot', skip ? 'Recording why a ready verdict is not shadow built failed' : 'Queueing a shadow build failed', {
        app: app.slug, issueNumber, err: err.message,
      });
    }
  }
  return { ran: true, verdict: parsed.verdict, runId, ...(acted ? { acted } : {}) };
}

// ── The build lane ───────────────────────────────────────────────────────
//
// Shadow builds run beside triage, not inside it. A build holds a worker for
// up to a turn's budget; run inline it held up the rest of its app's batch,
// and one of the loop's few slots with it. So a ready verdict only QUEUES
// its build (build_queued_at on its run), and this lane drains that queue
// with a concurrency of its own: `buildConcurrency` builds at once, shared
// between apps in turns, so one busy board cannot starve another, but a
// slot no other app wants is not left idle either. Each build is its
// own session on its own temporary worker, so builds side by side share
// nothing but the bot's weekly allowance, which every drain checks first.
//
// A run's build moves from queued (build_queued_at set, build_at NULL) to
// building (build_at set, build_ok NULL) to built or failed (build_ok set).
// A skipped one (the issue closed, the app went live) goes back to not
// queued, with the reason in build_error. Only the leader drains, like the
// loop; the claim is still a conditional UPDATE, so a second drainer could
// not take the same run.

// The fallback poll. Enqueueing and every finished build wake the lane at
// once; this is only for a wake that was lost.
const BUILD_IDLE_DELAY_MS = 60 * 1000;
// A platform fault (no worker, no session) backs the lane off, as #3122
// does the loop: without it a backfill of a hundred builds fails a hundred
// times in a minute while the worker quota is full.
const BUILD_FAULT_BASE_MS = 2 * 60 * 1000;
const BUILD_FAULT_CEILING_MS = 30 * 60 * 1000;
// A build interrupted by a restart is retried once, then recorded failed.
const MAX_BUILD_ATTEMPTS = 2;
// Where the platform's own code lives when config does not say.
const DEFAULT_PLATFORM_REPO_URL = 'https://github.com/Usernode-Labs/social-vibecoding';

// runId → { appId, issueNumber, startedAt, promise }. On the leader only.
const buildsInFlight = new Map();
let buildLaneOn = false;
let buildTimer = null;
let buildDrainRunning = false;
let buildDrainAgain = false;
// { attempts, until, error }, like platformFault but for the lane alone.
let buildFault = null;
let lastBuildDrain = null;

/** True when `app` is the platform's own repository. */
function isPlatformRepo(app, config = {}) {
  const platform = parseRepo(config.platformRepoUrl || DEFAULT_PLATFORM_REPO_URL);
  const repo = parseRepo(app?.repo_url);
  if (!platform || !repo) return false;
  return platform.owner.toLowerCase() === repo.owner.toLowerCase()
    && platform.repo.toLowerCase() === repo.repo.toLowerCase();
}

/**
 * Why a ready verdict on `app` is not shadow built, or null when it is.
 * Live apps build for real; the platform's own repository is left out
 * unless an admin includes it, since every branch there is in the
 * repository everybody's proposals are made against.
 */
function shadowBuildSkipReason(settings, app, config = {}) {
  if (!settings?.shadowBuilds) return SHADOW_SKIP.off;
  if (live.isLiveFor(settings, app)) return SHADOW_SKIP.live;
  if (!settings.shadowBuildPlatform && isPlatformRepo(app, config)) return SHADOW_SKIP.platform;
  if ((settings.pausedApps || []).includes(app?.slug)) return SHADOW_SKIP.paused;
  return null;
}
const SHADOW_SKIP = Object.freeze({
  off: 'shadow builds are off',
  live: 'the app is live now',
  platform: "the platform's own repository is left out",
  paused: 'the app is paused',
});

/**
 * Whether a run's build_error is the note triage left when a setting kept
 * its ready verdict from being built (runTriage: "skipped: <why>"). That is
 * a build that may still be made once the setting changes, unlike a skip
 * the lane recorded (the issue closed, the app went away).
 */
function skippedAtTriage(buildError) {
  const m = /^skipped: (.*)$/.exec(String(buildError || ''));
  return !!m && Object.values(SHADOW_SKIP).includes(m[1]);
}

/**
 * Whether a request is its project's first version, from who it is for
 * (homeroom_bot_requesters), as buildOne reads it for a live build. The
 * shadow lane and restart recovery read it the same way, so a first
 * version's build gets its doubled clock wherever it runs (turnly #1,
 * 2026-10-05, was cut at 20 minutes of its 40). False on any error.
 */
async function isFirstVersionRequest(pool, appId, issueNumber) {
  if (appId == null || issueNumber == null) return false;
  try {
    const { rows: [row] = [] } = await pool.query(
      'SELECT first_version FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = $2',
      [appId, issueNumber],
    );
    return row?.first_version === true;
  } catch {
    return false;
  }
}

/**
 * The clocks for one build of `app`: the build turn's, from the turn
 * budget, and the spec's, from its own cap. The platform gets
 * PLATFORM_BUILD_TIME_FACTOR times both, a first version
 * FIRST_VERSION_BUILD_TIME_FACTOR times.
 */
function buildBudgets(app, config, turnBudgetMs, { firstVersion = false } = {}) {
  // #3624: a project's whole first version is a bigger build than any one
  // request, so it gets longer clocks too.
  const factor = isPlatformRepo(app, config) ? PLATFORM_BUILD_TIME_FACTOR
    : firstVersion ? FIRST_VERSION_BUILD_TIME_FACTOR : 1;
  return { turnBudgetMs: turnBudgetMs * factor, specBudgetMs: live.SPEC_TURN_MAX_MS * factor };
}

/**
 * #4610: the clock for a follow-up on `app` (a fix of its red checks, or an
 * answer to a person). It used to be the plain turn budget everywhere, so on
 * the platform's own repository, where a build gets
 * PLATFORM_BUILD_TIME_FACTOR times it for reading a large codebase and
 * running its slower suites, the fix of that same build ran out of time
 * (PR #4582, change 7490). It gets what the build got; a first version's
 * longer clock is for its size, which a follow-up does not have.
 */
function followUpBudgetMs(app, config, turnBudgetMs) {
  return isPlatformRepo(app, config) ? turnBudgetMs * PLATFORM_BUILD_TIME_FACTOR : turnBudgetMs;
}

/**
 * Why a later change's side builds (services/bot-configs.js) are not made,
 * or null when they are. They follow the shadow builds' rule for the
 * platform's own repository: each is a branch in the repository everybody's
 * proposals are made against, so it is left out unless an admin includes it
 * (homeroom_bot_shadow_build_platform). Without settings to read it, left out.
 */
function laterSideSkipReason(settings, app, config = {}) {
  if (isPlatformRepo(app, config) && !settings?.shadowBuildPlatform) {
    return "the platform's own repository is left out of side builds (homeroom_bot_shadow_build_platform is off)";
  }
  return null;
}

/** Drop a queued, unstarted build of an older verdict on the same issue. */
async function supersedeQueuedBuilds(pool, { appId, issueNumber, runId }) {
  await pool.query(
    `UPDATE homeroom_bot_runs
        SET build_queued_at = NULL, build_error = 'superseded: a later verdict on the same issue'
      WHERE app_id = $1 AND issue_number = $2 AND id <> $3
        AND build_queued_at IS NOT NULL AND build_at IS NULL AND build_ok IS NULL`,
    [appId, issueNumber, runId],
  );
}

/** Queue a run's build and wake the lane. False when it was already queued or built. */
async function queueShadowBuild(pool, runId) {
  const { rowCount } = await pool.query(
    `UPDATE homeroom_bot_runs SET build_queued_at = NOW(), build_error = NULL
      WHERE id = $1 AND build_queued_at IS NULL AND build_ok IS NULL`,
    [runId],
  );
  if (rowCount) wakeBuilds();
  return !!rowCount;
}

/**
 * Builds a finished process never recorded. One still in this process is
 * left alone whatever its age; one past the longest a build can take (a
 * platform build's spec and build turn, #3396) and a margin is put back in
 * the queue, or recorded failed once it has had its attempts. The one bound
 * serves every app: waiting longer on an abandoned app build holds no slot
 * in this process, while a shorter bound would recycle a platform build that
 * is still running.
 */
async function releaseStaleBuilds(pool, settings) {
  const turnSeconds = Number(settings?.turnSeconds) || DEFAULTS.turnSeconds;
  const seconds = PLATFORM_BUILD_TIME_FACTOR * (turnSeconds + live.SPEC_TURN_MAX_MS / 1000)
    + STALE_CLAIM_MARGIN_SECONDS;
  const { rows } = await pool.query(
    `UPDATE homeroom_bot_runs
        SET build_at = CASE WHEN build_attempts < $3 THEN NULL ELSE build_at END,
            build_ok = CASE WHEN build_attempts < $3 THEN NULL ELSE FALSE END,
            build_error = CASE WHEN build_attempts < $3 THEN NULL
                               ELSE 'interrupted: the build never finished' END
      WHERE build_queued_at IS NOT NULL AND build_at IS NOT NULL AND build_ok IS NULL
        AND build_at < NOW() - make_interval(secs => $1)
        AND NOT (id = ANY($2::int[]))
        -- A durable build is its work item's to finish, wherever it runs
        -- (services/build-runs.js); this releases only a build that ran in
        -- a process with no workflow runtime and died with it.
        AND NOT EXISTS (
          SELECT 1 FROM wf_instances w
           WHERE w.machine = 'bot-build' AND w.state = 'building'
             AND w.data->>'target' = 'shadow' AND (w.data->>'id')::int = homeroom_bot_runs.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat_sessions cs
           WHERE cs.id = homeroom_bot_runs.build_session_id AND cs.active_turn IS NOT NULL
        )
      RETURNING id, build_ok`,
    [seconds, [...buildsInFlight.keys()], MAX_BUILD_ATTEMPTS],
  );
  if (rows.length) {
    log.info('homeroom-bot', 'Released shadow builds an earlier process never finished', {
      requeued: rows.filter((r) => r.build_ok == null).length,
      failed: rows.filter((r) => r.build_ok === false).length,
    });
  }
  return rows.length;
}

// The free slots, dealt to apps in turns, claimed in one statement. An
// app's queued builds are numbered oldest first, starting after the builds
// it already has under way; the claim takes the lowest numbers, so every
// app with a build waiting gets one slot before any app gets a second, and
// an app alone in the queue takes every free slot. Ties go to the build
// queued first. `$2` is the paused apps: a paused app's builds wait with
// its triage.
const CLAIM_BUILDS_SQL = `WITH building AS (
    SELECT app_id, COUNT(*)::int AS n FROM homeroom_bot_runs
     WHERE build_queued_at IS NOT NULL AND build_at IS NOT NULL AND build_ok IS NULL
     GROUP BY app_id
  ), queued AS (
    SELECT r.id, r.build_queued_at,
           COALESCE(b.n, 0)
             + ROW_NUMBER() OVER (PARTITION BY r.app_id ORDER BY r.build_queued_at, r.id) AS turn
      FROM homeroom_bot_runs r
      JOIN apps a ON a.id = r.app_id
      LEFT JOIN building b ON b.app_id = r.app_id
     WHERE r.build_queued_at IS NOT NULL AND r.build_at IS NULL AND r.build_ok IS NULL
       AND a.status = 'running' AND a.repo_url IS NOT NULL
       AND NOT (a.slug = ANY($2::text[]))
  ), picked AS (
    SELECT id FROM queued ORDER BY turn, build_queued_at, id LIMIT $1
  )
  UPDATE homeroom_bot_runs r
     SET build_at = NOW(), build_attempts = r.build_attempts + 1
    FROM picked
   WHERE r.id = picked.id AND r.build_at IS NULL
  RETURNING r.id, r.app_id, r.issue_number, r.build_note, r.build_spec_md, r.build_attempts`;

/** A build error the platform, not the model, produced. */
function isInfraBuildError(error) {
  const e = String(error || '');
  if (/^(could not open a session|could not create its branch|the worker would not start)/.test(e)) return true;
  const m = e.match(/^the build turn failed \((.+)\)$/);
  return !!m && (INFRA_ERRORS.has(m[1]) || m[1].startsWith('dispatch:'));
}

function noteBuildFault(error, now = Date.now()) {
  const attempts = (buildFault?.attempts || 0) + 1;
  const delayMs = Math.min(BUILD_FAULT_CEILING_MS, BUILD_FAULT_BASE_MS * 2 ** (attempts - 1));
  buildFault = { attempts, until: now + delayMs, error: summarizeFault(error) };
  return { ...buildFault, delayMs };
}

/**
 * #3654: what a build reads, recorded on its run before it starts: the seed,
 * the triage's plan, a spec already written (a restart's), and the commit
 * the build branch is cut from (the tip of main, where
 * session-lifecycle.ensureSessionBranch cuts it). Never throws.
 */
async function recordBuildSnapshot(pool, {
  runId, app, repo, issueNumber, seed, buildNote, github = null, presetSpec = null,
  firstVersion = false, platformRepo = false, model = null, specModel = null, starter = null,
}) {
  if (!runId || !app) return null;
  return snapshots.recordSnapshot(pool, {
    runId, stage: 'build', appId: app.id, issueNumber,
    baseSha: await headShaOf(github, repo, 'main'),
    texts: { seed, build_note: buildNote || '', preset_spec: presetSpec || '' },
    extra: {
      model, specModel: specModel || model, firstVersion: !!firstVersion, platformRepo: !!platformRepo,
      // The game starter a first version built on, so a replay builds on it too.
      ...(starter ? { starter } : {}),
    },
  });
}

/**
 * The build itself, for a claimed run: the same build live runs, with
 * `propose: false`, so the only thing it leaves is its branch. Debited from
 * the weekly allowance like any turn, and recorded on the run. A later
 * change is built by the `later` configuration as a live one is (buildLive):
 * its models, harness and spec effort, its side versions queued beside it,
 * its result recorded. Resolves 'shadow_built', 'shadow_failed', or 'infra'
 * when the platform could not run it (the claim is handed back and the lane
 * backs off).
 */
async function shadowBuild({
  pool, config, bot, app, repo, issueNumber, issue, seed, parsed, runId,
  turnBudgetMs, model: stageBuildModel, specModel: stageSpecModel = null, deps, presetSpec = null, firstVersion = false,
  settings = null,
}) {
  const { limits, managedOpenRouter } = deps;
  // A durable build's steps (services/durable-steps.js), as a live build's.
  const steps = durableSteps.of(deps);
  const version = firstVersion ? null : await steps.once('version', () => botConfigs().laterVersion(pool));
  const recipe = version ? version.recipe : null;
  const model = recipe ? recipe.models.build : stageBuildModel;
  const specModel = recipe ? recipe.models.spec : stageSpecModel;
  const guidance = recipe ? await botConfigs().recipeGuidance(pool, recipe) : null;
  if (version) {
    await pool.query('UPDATE homeroom_bot_runs SET bot_config_version_id = $2 WHERE id = $1', [runId, version.id])
      .catch((err) => log.warn('homeroom-bot', 'Could not record the run\'s configuration', { runId, err: err.message }));
  }
  // A first version made from a game starter builds on it (starterOfApp).
  const starter = firstVersion ? await starterOfApp(pool, app.id).catch(() => null) : null;
  const snapshotId = await steps.once('snapshot', () => recordBuildSnapshot(pool, {
    runId, app, repo, issueNumber, seed, buildNote: parsed.buildNote, github: deps.github, presetSpec,
    firstVersion, platformRepo: isPlatformRepo(app, config), model, specModel, starter,
  }));
  if (version) {
    await steps.once('side_builds', () => botConfigs().spawnSideBuilds(pool, config, {
      botRunId: runId, app, snapshotId, current: version, scope: 'later', skipReason: laterSideSkipReason(settings, app, config),
    }));
  }
  const buildStartedMs = Number(await steps.once('build_started_at', async () => Date.now())) || Date.now();
  // A first version builds as the live lane builds it: its doubled clock,
  // and the spec and build that decide its look (buildOne).
  // #4645: the requester's language preference, for the prompts' wording
  // rule (localeRule); unset, everything the group reads stays English.
  const requester = await (deps.dm || require('./homeroom-bot-dm'))
    .requesterOf(pool, app.id, issueNumber).catch(() => null);
  const built = await steps.once('try', () => live.buildAndPropose({
    pool, config, bot, app, repo, issueNumber, issue, seed, buildNote: parsed.buildNote,
    ...buildBudgets(app, config, turnBudgetMs, { firstVersion }), model, specModel,
    deps: { ...deps, durable: steps.scope('try') }, presetSpec,
    firstVersion, starter,
    locale: requester?.locale || null,
    platformRepo: isPlatformRepo(app, config),
    onSession: (session) => pool.query(
      'UPDATE homeroom_bot_runs SET build_session_id = $2 WHERE id = $1',
      [runId, session.id],
    ),
    ...(version ? {
      harnessOf: live.recipeHarness,
      specGuidance: guidance?.spec || null,
      buildGuidance: guidance?.build || null,
    } : {}),
    origin: { lane: 'shadow', runId },
    onNoChange: (noChange) => keepNoChange(pool, runId, noChange),
    propose: false,
  }));
  const buildMs = Date.now() - buildStartedMs;
  if (built.costUsd > 0) {
    try {
      if (await managedOpenRouter.usesIncludedKey(pool, bot.id)) {
        await debitBuildOnce(steps, 'debited', built.costUsd,
          (usd) => limits.recordSpend(pool, bot.id, Math.round(usd * 1e6) / 1e4, { byok: false }));
      }
    } catch (err) {
      durableSteps.rethrowStop(err, 'shadow debit');
      log.warn('homeroom-bot', 'Shadow build spend debit failed', { err: err.message });
    }
  }
  steps.fence();
  if (!built.ok && isInfraBuildError(built.error)) {
    await pool.query(
      `UPDATE homeroom_bot_runs
          SET build_at = NULL, build_attempts = GREATEST(build_attempts - 1, 0)
        WHERE id = $1`,
      [runId],
    );
    const fault = noteBuildFault(built.error);
    log.warn('homeroom-bot', 'Shadow build hit a platform fault; the lane backs off', {
      app: app.slug, issueNumber, runId, error: built.error, retryInMs: fault.delayMs,
    });
    return 'infra';
  }
  buildFault = null;
  await pool.query(
    `UPDATE homeroom_bot_runs
        SET build_ok = $2, build_branch = $3, build_sha = $4, build_commits = $5,
            build_error = $6, build_cost_usd = $7, build_session_id = $8, build_spec_md = $9,
            build_model = $10, build_no_change = $11::jsonb
      WHERE id = $1`,
    [runId, !!built.ok, built.branchName || null, built.sha || null,
      Number.isFinite(built.commits) ? built.commits : null,
      // A spec that failed is noted even on a build that went ahead from
      // the plan; build_ok says which it was (#3396).
      built.ok
        ? (built.specNote ? clip(built.specNote, MAX_ERROR_CHARS) : null)
        : clip([built.error || 'unknown', built.specNote].filter(Boolean).join('; '), MAX_ERROR_CHARS),
      built.costUsd ?? null, built.sessionId || null, built.specMd || null, model || null,
      // A build turn that changed nothing: what it said and did, and its nudge.
      built.noChange ? JSON.stringify(built.noChange) : null],
  );
  log.info('homeroom-bot', 'Shadow build', {
    app: app.slug, issueNumber, runId, ok: !!built.ok, branch: built.branchName || null,
    commits: built.commits ?? null, costUsd: built.costUsd ?? null, error: built.ok ? null : built.error,
    ...(version ? { configVersionId: version.id } : {}),
  });
  // What the later configuration made of it; then its pairs.
  if (version) {
    await steps.once('configs', async () => {
      await botConfigs().finishLive(pool, { botRunId: runId, version, built, activeMs: buildMs });
      return true;
    });
  }
  return built.ok ? 'shadow_built' : 'shadow_failed';
}

/**
 * One claimed build, start to finish. The issue is read again first: it may
 * have closed since its verdict, and the build works from the thread as it
 * is now. Resolves the outcome, or `skipped: <why>`.
 */
async function runQueuedBuild(pool, config, { bot, claim, settings, deps = {} }) {
  const github = deps.github || require('./github');
  const worker = deps.worker || require('./worker');
  const agentTurn = deps.agentTurn || require('./agent-turn');
  const limits = deps.limits || require('./limits');
  const threadContext = deps.threadContext || require('./thread-context');
  const managedOpenRouter = deps.managedOpenRouter || require('./openrouter-managed-keys');
  const sessions = deps.sessions || require('../routes/sessions');
  const activeWorkers = deps.activeWorkers || require('./active-workers').activeWorkers;
  const sessionLifecycle = deps.sessionLifecycle || require('./session-lifecycle');

  const runId = claim.id;
  const issueNumber = Number(claim.issue_number);
  const skip = async (why) => {
    await pool.query(
      `UPDATE homeroom_bot_runs
          SET build_queued_at = NULL, build_at = NULL, build_error = $2
        WHERE id = $1`,
      [runId, clip(`skipped: ${why}`, MAX_ERROR_CHARS)],
    );
    log.info('homeroom-bot', 'Shadow build skipped', { runId, issueNumber, why });
    return `skipped: ${why}`;
  };
  const handBack = async (why) => {
    await pool.query(
      `UPDATE homeroom_bot_runs
          SET build_at = NULL, build_attempts = GREATEST(build_attempts - 1, 0)
        WHERE id = $1`,
      [runId],
    );
    noteBuildFault(why);
    return 'infra';
  };

  const { rows: appRows } = await pool.query(
    'SELECT id, slug, name, repo_url, self_hosted FROM apps WHERE id = $1', [claim.app_id],
  );
  const app = appRows[0];
  // Asked once, as a step: a build a restart caught is carried on from where
  // it was, never stopped (its turn left running) by a check its first
  // attempt passed (an issue closed since, GitHub down for a moment).
  const checked = await durableSteps.of(deps).once('precheck', async () => {
    if (!app) return { acted: await skip('the app is gone') };
    const why = shadowBuildSkipReason(settings, app, config);
    if (why) return { acted: await skip(why) };
    if (!parseRepo(app.repo_url)) return { acted: await skip('the app has no GitHub repository') };
    if (!github.isEnabled()) return { acted: await handBack('github_unavailable') };
    const r = parseRepo(app.repo_url);
    const fetched = await github.fetchPublicIssue(r.owner, r.repo, issueNumber);
    const found = fetched?.issue || null;
    if (!found || (found.state && found.state !== 'open')) return { acted: await skip('the issue is no longer open') };
    return { issue: found };
  });
  if (checked.acted) return checked.acted;
  const repo = parseRepo(app.repo_url);
  const issue = checked.issue;

  const [{ comments = [] } = {}, thread, botUsername] = await Promise.all([
    github.fetchIssueComments(repo.owner, repo.repo, issueNumber).catch(() => ({ comments: [] })),
    threadContext.loadIssueThread(pool, app.id, issueNumber),
    live.botUsernameOf(github),
  ]);
  const seed = sessions.buildHeadlessSeed(
    issueNumber, issue, comments, botUsername, thread?.messages || [],
  );
  const turnBudgetMs = 1000 * clampInt(
    settings?.turnSeconds, DEFAULTS.turnSeconds, MIN_TURN_SECONDS, MAX_TURN_SECONDS,
  );
  return shadowBuild({
    pool, config, bot, app, repo, issueNumber, issue, seed,
    parsed: { buildNote: claim.build_note }, runId, turnBudgetMs, presetSpec: claim.build_spec_md || null,
    firstVersion: await isFirstVersionRequest(pool, app.id, issueNumber),
    model: stageModel(settings, config, 'build'), specModel: stageModel(settings, config, 'spec'), settings,
    deps: {
      worker, agentTurn, limits, managedOpenRouter, sessions, activeWorkers, sessionLifecycle, github,
      ...(deps.durable ? { durable: deps.durable } : {}),
    },
  });
}

/**
 * Fill the lane's free slots and return at once: each build runs on in
 * the background, and wakes the lane when it ends so the next can start.
 * Never throws. Returns what it started, for the dashboard and for tests.
 */
async function drainBuilds(pool, config, deps = {}) {
  const out = { started: 0, inFlight: buildsInFlight.size, paused: null };
  // Shutting down (stop()): nothing new starts on a process about to close
  // its pool. A build that started anyway failed at dispatch with "Cannot use
  // a pool after calling end on the pool" (page-turners #2, 2026-10-05).
  if (refusingNew()) { out.paused = 'stopped'; return out; }
  // A pass is already filling the lane: it runs again when it ends.
  if (buildDrainRunning) { buildDrainAgain = true; return { ...out, busy: true }; }
  buildDrainRunning = true;
  try {
    const settings = await readSettings(pool);
    if (settings.mode === 'off' || !settings.shadowBuilds) { out.paused = 'off'; return out; }
    out.released = await releaseStaleBuilds(pool, settings);
    const now = deps.now ? deps.now() : Date.now();
    if (buildFault && buildFault.until > now) {
      out.paused = 'infra';
      out.detail = buildFault.error;
      out.retryInMs = buildFault.until - now;
      return out;
    }
    // A build reads GitHub and opens a pull request: background work, held
    // like the triage pass while the hourly budget is nearly used up.
    const githubHold = githubBudget.backgroundHold({ now });
    if (githubHold) {
      out.paused = 'github';
      out.retryInMs = githubHold.retryInMs;
      return out;
    }
    const free = settings.buildConcurrency - buildsInFlight.size;
    if (free <= 0) return out;
    const bot = await ensureBotUser(pool, config);
    const limits = deps.limits || require('./limits');
    const budget = await limits.checkBudget(pool, bot.id);
    if (budget.error) {
      out.paused = 'budget';
      out.detail = budget.reason || budget.error;
      return out;
    }
    // Shutdown may have begun during the reads above.
    if (refusingNew()) { out.paused = 'stopped'; return out; }
    const { rows } = await pool.query(CLAIM_BUILDS_SQL, [free, settings.pausedApps || []]);
    for (const claim of rows) {
      // A durable build on the workflow kernel (services/build-runs.js):
      // resolves once it has ended, wherever it ran.
      const promise = buildRuns().start({
        pool, config, target: 'shadow', id: Number(claim.id), nonce: `a${Number(claim.build_attempts) || 0}.${Date.now().toString(36)}`,
        appId: Number(claim.app_id), input: {},
        deps: { ...deps, bot, settings, inProcessClaim: claim },
      })
        .catch(async (err) => {
          // Not started: the platform began stopping. Back in the queue, its
          // claim not spent, for the next leader.
          if (err?.notStarted) {
            await pool.query(
              `UPDATE homeroom_bot_runs SET build_at = NULL, build_attempts = GREATEST(build_attempts - 1, 0)
                WHERE id = $1 AND build_ok IS NULL`,
              [claim.id],
            ).catch(() => {});
            return 'not_started';
          }
          log.error('homeroom-bot', 'Shadow build threw', { runId: claim.id, err: err.message });
          await pool.query(
            'UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = $2 WHERE id = $1',
            [claim.id, clip(`threw: ${err.message}`, MAX_ERROR_CHARS)],
          ).catch(() => {});
          return 'shadow_failed';
        })
        .finally(() => {
          buildsInFlight.delete(claim.id);
          wakeBuilds();
        });
      buildsInFlight.set(claim.id, {
        appId: claim.app_id, issueNumber: claim.issue_number, startedAt: new Date().toISOString(), promise,
      });
      out.started += 1;
    }
    out.inFlight = buildsInFlight.size;
    return out;
  } catch (err) {
    log.error('homeroom-bot', 'Build lane pass failed', { err: err.message });
    return out;
  } finally {
    buildDrainRunning = false;
    lastBuildDrain = { at: new Date().toISOString(), ...out };
  }
}

function scheduleBuilds(config, delayMs) {
  if (!buildLaneOn) return;
  if (buildTimer) clearTimeout(buildTimer);
  buildTimer = setTimeout(() => { buildTimer = null; buildTick(config); }, delayMs);
  if (typeof buildTimer.unref === 'function') buildTimer.unref();
}

async function buildTick(config) {
  let delay = BUILD_IDLE_DELAY_MS;
  let busy = false;
  try {
    const { getPool } = require('../db/pool');
    const out = await drainBuilds(getPool(config), config);
    busy = !!out.busy;
    if (out.paused === 'infra' && out.retryInMs > 0) delay = Math.max(delay, out.retryInMs);
    if (out.paused === 'github' && out.retryInMs > 0) delay = Math.max(delay, out.retryInMs);
  } catch (err) {
    log.error('homeroom-bot', 'Build tick failed', { err: err.message });
  } finally {
    // The pass under way schedules the next one itself when it ends.
    if (!busy) {
      if (buildDrainAgain) { buildDrainAgain = false; delay = 0; }
      scheduleBuilds(config, delay);
    }
  }
}

/** Run a lane pass now. A no-op on a Pod that is not draining. */
function wakeBuilds() {
  if (!buildLaneOn || !loopConfig) return false;
  scheduleBuilds(loopConfig, 0);
  return true;
}

// ── Builds that outlive their process ────────────────────────────────────
//
// A platform redeploy restarts the server, not the worker: a build's worker
// is its own Pod, and its turns run detached with a journal. The bot's live
// builds and its shadow builds are durable builds on the workflow kernel's
// bot-build machine (services/build-runs.js, docs/plans/bot-build-workflow.md):
// the build's work item outlives the process, the next leader claims it, and
// the build carries itself on from the last step it saved, following a turn
// that was under way (services/durable-turn.js). Nothing here adopts, holds,
// resumes or sweeps a build after a restart; that was a second copy of the
// pipeline (completeRecoveredLive and its sweeps), and every restart bug of
// October 2026 lived in the gaps between the two.
//
// What is left here for a restart is a bot turn that is no build's: a read
// (its triage), which the queue reads again, and a follow-up on a proposal
// the group is voting on. That session is `promoted`, and a person's
// recovery (the PR and staging updated) is the right end for it; #4533: but
// it keeps the bot's clock and ledger. Its record carries the bot's mark
// (homeroom-bot-followup TURN_MARK), which isRecoveredBotFollowUp reads:
// recovery re-arms its clock from the deadline on the mark
// (recoveryDeadline), and once the person's tail has moved the proposal on,
// records what the turn did as the follow-up itself would have
// (finishRecoveredFollowUp).

/**
 * True when restart recovery should hand this session to the bot rather than
 * to a person's dev-chat tail: the bot's own session, while `active`, or
 * `paused` with a turn record on it. A session a durable build owns
 * (`workflow_owner`) is that build's, and server.js leaves it alone before
 * it asks this.
 */
function isRecoveredBotSession(session) {
  return !!session
    && session.username === live.BOT_USERNAME
    && session.user_is_synthetic === true
    && (session.status === 'active' || (session.status === 'paused' && !!session.active_turn));
}

/**
 * #4533: true when the turn restart recovery found is a follow-up of the
 * bot's on its own proposal: the session is the bot's, and the turn's record
 * carries the mark its follow-up left (homeroom-bot-followup turnMarkOf). A
 * person's turn on the same session carries none, so it is never stopped on
 * the bot's clock. Pure.
 */
function isRecoveredBotFollowUp(session, activeTurn = session?.active_turn) {
  return !!session
    && session.username === live.BOT_USERNAME
    && session.user_is_synthetic === true
    && !!followup.turnMarkOf(activeTurn);
}

// What a restart may cost a turn that runs on through it (durable-turn.js).
const RESTART_ALLOWANCE_MS = durableTurn.RESTART_ALLOWANCE_MS;

/** The time a turn's restarts so far give back on its clock (`activeTurn.restarts`). Pure. */
function restartAllowanceMs(activeTurn) {
  return durableTurn.allowanceMs(activeTurn?.restarts);
}

/**
 * When the bot's own clock ends a follow-up a restart caught: the deadline
 * on its mark plus what its restarts cost it, or null for any other turn
 * (a build's turns keep their own clock: durable-turn.js).
 */
async function recoveryDeadline(pool, config, session, activeTurn) {
  const mark = followup.turnMarkOf(activeTurn);
  if (mark) return toMs(mark.deadlineAt) + restartAllowanceMs(activeTurn);
  return null;
}

// How the run of a live build a restart cut short, and that was sent back to
// be triaged again, ends its error. No build is sent back any more; the
// note stays for the runs that were, which the person's activity card reads
// past (homeroom-bot-activity.js, homeroom-bot-chat.js).
const RESTARTED_BUILD_NOTE = 'by a restart; the issue was sent back to be triaged again';
// How many builds of one request in a row a restart could send back, before
// builds outlived restarts (the activity card's window still reads it).
const MAX_RESTARTED_BUILDS = 3;
// How far back the waiting views look for a live build (homeroom-bot-progress.js).
const ABANDONED_LIVE_WINDOW_DAYS = 7;
// What a live build lost for good says on its request.
const LOST_LIVE_REASON = 'the platform failed while it was building, and the build was lost';
// A build every restart took from the process carrying it on.
const ABANDONED_LIVE_REASON = 'the platform restarted while it was building, and the build was lost';

/** A build session is archived once its run is recorded; the triage session rests paused. */
async function putAwayRecoveredSession(pool, session, { archive }) {
  if (archive) {
    await pool.query(
      `UPDATE chat_sessions SET status = 'archived', archived_at = NOW()
        WHERE id = $1 AND status IN ('active', 'paused')`,
      [session.id],
    ).catch(() => {});
    return;
  }
  await pool.query(
    "UPDATE chat_sessions SET status = 'paused', last_activity_at = NOW() WHERE id = $1 AND status = 'active'",
    [session.id],
  ).catch(() => {});
}

/**
 * A bot turn restart recovery found and no build owns (a read: its triage,
 * which the queue reads again). Its session rests paused; the caller has
 * stopped the turn and cleared its record.
 */
async function abandonRecoveredTurn({ pool, session, why }) {
  await putAwayRecoveredSession(pool, session, { archive: false });
  log.info('homeroom-bot', 'Recovered a bot turn no build owns; left for the queue', { sessionId: session.id, why });
  return 'released';
}

/**
 * A bot turn the stale-turn watchdog reaped (server.js). A durable build's
 * turn is its build's: the step following it reads the turn's end. Any
 * other is a read the queue takes again.
 */
async function settleReapedTurn({ pool, session }) {
  if (session?.workflow_owner) return 'durable';
  return abandonRecoveredTurn({ pool, session, why: 'the stale-turn watchdog reaped its turn' });
}

// ── Live and shadow builds on the kernel ─────────────────────────────────

/** What a build runs with: the caller's injected modules, else the real ones. */
function liveBuildDeps(deps = {}) {
  return {
    github: deps.github || require('./github'),
    worker: deps.worker || require('./worker'),
    agentTurn: deps.agentTurn || require('./agent-turn'),
    limits: deps.limits || require('./limits'),
    threadContext: deps.threadContext || require('./thread-context'),
    managedOpenRouter: deps.managedOpenRouter || require('./openrouter-managed-keys'),
    sessions: deps.sessions || require('../routes/sessions'),
    activeWorkers: deps.activeWorkers || require('./active-workers').activeWorkers,
    ...(deps.notifications ? { notifications: deps.notifications } : {}),
    ...(deps.dm ? { dm: deps.dm } : {}),
    ...liveDeps(deps),
  };
}

// What a live build starts from, as its work item keeps it (JSON): what
// buildOne read and decided. The rest (the pool, the bot, the app, the
// modules) is read again where it runs.
const LIVE_BUILD_INPUT_KEYS = [
  'issueNumber', 'issue', 'parsed', 'seed', 'seedReadAt', 'turnBudgetMs', 'botLogin', 'model', 'specModel',
  'proposalCeiling', 'firstVersion', 'presetSpec', 'carriedCostUsd', 'complicated', 'plan', 'presetSpecHtml',
];
function liveBuildInput(args) {
  const out = {};
  for (const k of LIVE_BUILD_INPUT_KEYS) if (args[k] !== undefined) out[k] = args[k];
  return durableSteps.plain(out);
}

// What tells two builds of one run apart (bot-build's key): the moment it
// was asked for, which a plan's Build it sets anew.
function liveBuildNonce(run) {
  const at = run?.live_build_waiting_at ? new Date(run.live_build_waiting_at).getTime() : NaN;
  return Number.isFinite(at) ? `w${at}` : null;
}

/**
 * bot-build's `live` target (services/build-runs.js): one live build, from
 * what buildOne read when it started it (`input.args`), on the durable
 * context `steps`. Run again after a restart, the same call carries the
 * build on from its last saved step. Resolves { acted }.
 */
async function runLiveBuild({ pool, config, id, input = {}, steps, deps = {} }) {
  // Run in its caller's process (no workflow runtime, or a test): the
  // arguments buildOne made, as they are.
  if (deps.inProcessArgs) {
    const a = deps.inProcessArgs;
    return { acted: await buildLive({ ...a, deps: { ...a.deps, durable: steps } }) };
  }
  const args = input.args || {};
  const { rows: [run] = [] } = await pool.query(
    'SELECT id, app_id, issue_number FROM homeroom_bot_runs WHERE id = $1', [Number(id)],
  );
  if (!run) return { acted: 'gone' };
  const { rows: [app] = [] } = await pool.query(
    'SELECT id, slug, name, repo_url, self_hosted FROM apps WHERE id = $1', [run.app_id],
  );
  if (!app) return { acted: 'gone' };
  const repo = parseRepo(app.repo_url);
  if (!repo) return { acted: 'gone' };
  const bot = deps.bot || await ensureBotUser(pool, config);
  const settings = deps.settings || await readSettings(pool);
  const buildDeps = { ...liveBuildDeps(deps), durable: steps };
  const acted = await buildLive({
    ...args, pool, config, bot, app, repo, runId: Number(run.id), issueNumber: Number(run.issue_number),
    settings, deps: buildDeps, postedAt: [],
  });
  return { acted };
}

/**
 * bot-build's `live` target, lost for good: recorded failed, and said on its
 * request. One restarts kept taking from every process that carried it on
 * (the kernel's `lease_lost`) is said to be the restarts' doing.
 */
async function recordLostLiveBuild({ pool, config, id, error = null }) {
  const why = error?.code === 'lease_lost'
    ? ABANDONED_LIVE_REASON
    : `the build could not finish (${clip(error?.message || 'it failed', 200)})`;
  const { rows: [run] = [] } = await pool.query(
    `UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = $2, live_build_waiting_at = NULL
      WHERE id = $1 AND build_ok IS NULL AND proposal_session_id IS NULL
      RETURNING id, app_id, issue_number, build_session_id`,
    [Number(id), clip(`lost: ${error?.message || 'the build failed'}`, MAX_ERROR_CHARS)],
  );
  if (!run) return 'recorded_already';
  if (run.build_session_id) await putAwayRecoveredSession(pool, { id: run.build_session_id }, { archive: true });
  const settings = await readSettings(pool);
  const said = await sayBuildLost(pool, settings, run, { reason: why }).catch((err) => {
    log.warn('homeroom-bot', 'Could not say a lost build failed', { runId: run.id, err: err.message });
    return 'not_said';
  });
  if (settings) await botConfigs().abandonSideBuilds(pool, run.id, why).catch(() => {});
  log.warn('homeroom-bot', 'A live build was lost', { runId: run.id, said, why });
  return said;
}

/**
 * bot-build's `shadow` target: one claimed shadow build (runQueuedBuild), on
 * the durable context `steps`. Resolves { acted }.
 */
async function runShadowBuild({ pool, config, id, steps, deps = {} }) {
  // Its claim, read again where it runs; after a restart even with its
  // outcome in (its last steps carry it on and finish it).
  const claim = deps.inProcessClaim || (await pool.query(
    `SELECT id, app_id, issue_number, build_note, build_spec_md, build_attempts
       FROM homeroom_bot_runs WHERE id = $1 AND (build_ok IS NULL OR $2::boolean)`,
    [Number(id), !!steps?.resumed],
  )).rows[0];
  if (!claim) return { acted: 'gone' };
  const bot = deps.bot || await ensureBotUser(pool, config);
  const settings = deps.settings || await readSettings(pool);
  let acted;
  try {
    acted = await runQueuedBuild(pool, config, { bot, claim, settings, deps: { ...deps, durable: steps } });
  } catch (err) {
    durableSteps.rethrowStop(err, 'shadow build');
    log.error('homeroom-bot', 'Shadow build threw', { runId: claim.id, err: err.message });
    await pool.query(
      'UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = $2 WHERE id = $1 AND build_ok IS NULL',
      [claim.id, clip(`threw: ${err.message}`, MAX_ERROR_CHARS)],
    ).catch(() => {});
    acted = 'shadow_failed';
  }
  return { acted };
}

/** bot-build's `shadow` target, lost for good: recorded failed. */
async function recordLostShadowBuild({ pool, id, error = null }) {
  await pool.query(
    `UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = $2
      WHERE id = $1 AND build_ok IS NULL`,
    [Number(id), clip(`lost: ${error?.message || 'the build failed'}`, MAX_ERROR_CHARS)],
  );
  wakeBuilds();
  return 'recorded';
}

/**
 * Take the slots of the builds under way again, after a restart: each holds
 * its slot (a live build its project's build slot, a shadow build the lane's)
 * until it ends, wherever it runs, as it did when it started. Resolves how
 * many it took. Never throws.
 */
async function holdDurableBuildSlots(pool) {
  let taken = 0;
  try {
    for (const b of await buildRuns().underWay('live')) {
      const slot = buildSlot(b.id);
      if (inFlight.has(slot)) continue;
      const { rows: [run] = [] } = await pool.query(
        `SELECT r.id, r.app_id, r.issue_number, COALESCE(q.user_id, 0) AS person_id
           FROM homeroom_bot_runs r
           LEFT JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
          WHERE r.id = $1`,
        [b.id],
      );
      if (!run) continue;
      taken += 1;
      void track(pool, slot, {
        lane: 'live', build: true, durable: true, appId: Number(run.app_id),
        person: personKeyOf({ person_id: Number(run.person_id) || null, app_id: run.app_id }),
        issueNumber: Number(run.issue_number), runId: Number(run.id), itemId: null, startedAt: new Date().toISOString(),
      }, async () => {
        await buildRuns().whenEnded(b.key);
        return { processed: 0, refusals: [], budgets: [], paused: null, stop: false };
      });
    }
    for (const b of await buildRuns().underWay('shadow')) {
      if (buildsInFlight.has(b.id)) continue;
      const { rows: [run] = [] } = await pool.query(
        'SELECT id, app_id, issue_number FROM homeroom_bot_runs WHERE id = $1', [b.id],
      );
      if (!run) continue;
      taken += 1;
      const promise = buildRuns().whenEnded(b.key).finally(() => {
        buildsInFlight.delete(b.id);
        wakeBuilds();
      });
      buildsInFlight.set(b.id, {
        appId: run.app_id, issueNumber: run.issue_number, startedAt: new Date().toISOString(),
        promise: promise.catch(() => null), durable: true,
      });
    }
  } catch (err) {
    log.warn('homeroom-bot', 'Could not take the slots of the builds under way', { err: err.message });
  }
  if (taken) log.info('homeroom-bot', 'Holding the slots of builds that outlived a restart', { builds: taken });
  return taken;
}

/**
 * Builds started before they were durable (a run with the checkpoint column
 * the old recovery kept, and no build on the machine): the restart that
 * brought this code took their process, and nothing else will finish them.
 * Each is asked for again: a live build from its plan when it had one
 * (build_spec_md), a shadow build back in the lane's queue. Once per run:
 * the column is cleared. Resolves how many. Never throws.
 */
async function requeueLegacyBuilds(pool) {
  try {
    const { rows } = await pool.query(
      `UPDATE homeroom_bot_runs r
          SET build_checkpoint = NULL,
              build_session_id = CASE WHEN r.mode = 'live' THEN NULL ELSE r.build_session_id END,
              live_build_waiting_at = CASE WHEN r.mode = 'live' THEN NOW() ELSE r.live_build_waiting_at END,
              build_spec_md = COALESCE(r.build_spec_md, NULLIF(r.build_checkpoint->'spec'->>'specMd', '')),
              build_at = CASE WHEN r.mode = 'live' THEN r.build_at ELSE NULL END,
              build_attempts = CASE WHEN r.mode = 'live' THEN r.build_attempts ELSE GREATEST(r.build_attempts - 1, 0) END
        WHERE r.build_checkpoint IS NOT NULL
          AND r.build_ok IS NULL AND r.proposal_session_id IS NULL
          AND r.created_at > NOW() - make_interval(days => $1)
        RETURNING r.id, r.mode, r.build_session_id`,
      [ABANDONED_LIVE_WINDOW_DAYS],
    );
    await pool.query(
      'UPDATE homeroom_bot_runs SET build_checkpoint = NULL WHERE build_checkpoint IS NOT NULL',
    ).catch(() => {});
    if (rows.length) {
      log.warn('homeroom-bot', 'Asked again for builds that started before builds were durable', {
        runs: rows.map((r) => Number(r.id)),
      });
      wakeBuilds();
    }
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not ask again for the builds started before builds were durable', { err: err.message });
    return 0;
  }
}

/**
 * A live build lost for good, said on its request (the same "couldn't
 * build" note, in the DM too), unless the issue has moved on: a closed issue
 * needs nothing, and an app the bot is no longer live on is not posted on.
 */
async function sayBuildLost(pool, settings, run, deps = {}) {
  const reason = deps.reason || LOST_LIVE_REASON;
  const { rows: [app] } = await pool.query(
    'SELECT id, slug, name, repo_url, self_hosted FROM apps WHERE id = $1', [run.app_id],
  );
  if (!app || !live.isLiveFor(settings, app)) return 'not_live';
  const repo = parseRepo(app.repo_url);
  const github = deps.github || require('./github');
  if (!repo || !github.isEnabled()) return 'no_github';
  const issueNumber = Number(run.issue_number);
  const fetched = await github.fetchPublicIssue(repo.owner, repo.repo, issueNumber).catch(() => null);
  const issue = fetched?.issue || null;
  if (!issue || (issue.state && issue.state !== 'open')) return 'not_open';
  // The bot that built it exists; nothing here needs its key or allowance.
  const { rows: [bot] } = await pool.query(
    'SELECT id, username FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME],
  );
  if (!bot) return 'no_bot';
  const liveD = liveDeps(deps);
  const since = new Date().toISOString();
  const postedAt = [];
  const botLogin = await live.botUsernameOf(github);
  const say = liveSayer({
    pool, github, ws: liveD.ws, app, repo, issueNumber, issue, runId: run.id, bot, botLogin,
    notifications: deps.notifications || null, postedAt,
  });
  await say('build_failed', live.buildFailedText(reason), { dm: { reason } });
  await live.advanceSeen({
    pool, github, threadContext: deps.threadContext || require('./thread-context'), app, repo, issueNumber,
    runId: run.id, since, postedAt,
  }).catch(() => {});
  return 'said';
}

/**
 * The lane as the dashboard shows it: counts, and what is building now.
 * Only the lane's own builds: every one was queued, and a live build, whose
 * outcome is recorded in the same columns (#3509), never is.
 */
/**
 * #3654: whether the bot's live work (the requests on apps it is live on,
 * which a person is waiting for: reads and builds) fills every live slot it
 * has right now, in this process: `liveAtOnce`, which dispatch fills, each
 * slot a worker from the pool people's own sessions use. The benchmark's
 * lane (services/bench/lane.js) starts nothing while it does, so a benchmark
 * never takes a worker a person is waiting on. Shadow builds in the lane do
 * not count: like a benchmark trial they are an experiment nobody waits for,
 * and counting them let a busy shadow lane hold the benchmark back
 * indefinitely. `counts.besides` adds work that shares the live slots: a
 * later change's side builds use only the slots live work leaves free
 * (lane.js), so live work and side builds together stay inside
 * `liveAtOnce`; live work never waits for them, since dispatch does not
 * count them. `counts.live` is for tests.
 *
 * The limit was `buildConcurrency` (2), from when live builds had that many
 * slots. They have had `liveAtOnce` (12) since, and any two of them held
 * every side build and benchmark trial back: on 9 Oct 2026 none started for
 * hours with twenty queued.
 */
function isLiveLaneSaturated(settings = null, counts = null) {
  const limit = clampInt(settings?.liveAtOnce, DEFAULTS.liveAtOnce, 1, MAX_LIVE_AT_ONCE);
  const live = counts && Number.isFinite(counts.live) ? counts.live
    : [...inFlight.values()].filter((e) => e.lane === 'live').length;
  return live + (Number(counts?.besides) || 0) >= limit;
}

async function buildLaneSummary(pool, memory = null) {
  const mem = memory || memoryStatus();
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE build_at IS NULL AND build_ok IS NULL)::int AS queued,
            COUNT(*) FILTER (WHERE build_at IS NOT NULL AND build_ok IS NULL)::int AS building,
            COUNT(*) FILTER (WHERE build_ok)::int AS built,
            COUNT(*) FILTER (WHERE build_ok = FALSE)::int AS failed,
            COALESCE(SUM(build_cost_usd), 0)::float8 AS cost_usd
       FROM homeroom_bot_runs
      WHERE build_queued_at IS NOT NULL`,
  );
  const t = rows[0] || {};
  return {
    queued: t.queued || 0,
    building: t.building || 0,
    built: t.built || 0,
    failed: t.failed || 0,
    costUsd: Number(t.cost_usd) || 0,
    lane: mem.buildLane,
    fault: mem.buildFault,
  };
}

/**
 * #3703: the newest spec on a proposal's session, the one its spec card
 * opens. '' when it has none or the read fails: the follow-up still has the
 * request, the discussion and the code.
 */
async function proposalSpec(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT content FROM chat_session_specs
        WHERE session_id = $1
        ORDER BY version DESC LIMIT 1`,
      [Number(sessionId)],
    );
    return typeof rows[0]?.content === 'string' ? rows[0].content : '';
  } catch (err) {
    log.warn('homeroom-bot', 'Could not read the proposal\'s spec (continuing without)', { sessionId, err: err.message });
    return '';
  }
}

// #4610: how recent a person's message must be for a wait to be said
// under it: a wait is news about a message somebody is waiting on now.
const WAIT_NOTE_WINDOW_HOURS = 6;

/**
 * #4610: say in the change's thread why the bot's answer waits, instead of
 * waiting silently. Only on the bot's own change while it is up for a vote,
 * and only while a person's message is the newest word in its thread, so it
 * is said once per message waited on: the note itself is the bot's word, and
 * the next pass that waits finds it there. `why` is a key of
 * followup.WAIT_WORDS. Never throws; resolves whether it said it.
 */
async function noteFollowUpWait(pool, { app, issueNumber, bot, why, sessionId = null, ws = null }) {
  const text = followup.waitText(why);
  if (!text || !app || !bot?.id) return false;
  try {
    const open = sessionId ? { id: sessionId, status: 'promoted' }
      : await live.openBotProposal(pool, bot.id, app.id, issueNumber);
    if (!open || open.status !== 'promoted') return false;
    const { rows } = await pool.query(
      `SELECT (u.is_synthetic IS TRUE) AS by_bot,
              (m.created_at > NOW() - make_interval(hours => $3)) AS recent
         FROM chat_messages m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.app_id = $1 AND m.thread_type = 'session' AND m.thread_ref = $2
          AND m.msg_type = 'message' AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1`,
      [app.id, Number(open.id), WAIT_NOTE_WINDOW_HOURS],
    );
    const last = rows[0];
    if (!last || last.by_bot || !last.recent) return false;
    await live.postOnProposal({
      pool, ws: ws || liveDeps().ws, app, issueNumber, kind: 'followup_wait', text, bot, sessionId: Number(open.id),
    });
    log.info('homeroom-bot', 'Said why its answer on its change waits', { app: app.slug, issueNumber, sessionId: open.id, why });
    return true;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not say why a follow-up waits', { app: app?.slug, issueNumber, why, err: err.message });
    return false;
  }
}

/**
 * #4610: a short line from the bot in the thread a person wrote in: the
 * change's own (`sessionId`), else the request's. Homeroom only, never a
 * GitHub comment: a comment moves the issue's updated_at, which reads as new
 * activity and would start another look. Never throws.
 */
async function postThreadNote({ pool, ws, app, issueNumber, runId = null, kind, text, bot, sessionId = null }) {
  try {
    if (sessionId) {
      await live.postOnProposal({ pool, ws, app, issueNumber, runId, kind, text, bot, sessionId: Number(sessionId) });
      return true;
    }
    await pool.query(
      'INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind) VALUES ($1, $2, $3, $4)',
      [app.id, issueNumber, runId, kind],
    );
    await ws.sendBotMessage(pool, app.id, {
      user: bot, content: require('./homeroom-bot-words').firstPerson(text), thread: { type: 'issue', ref: Number(issueNumber) },
    });
    return true;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not post a note in the thread', { app: app?.slug, issueNumber, kind, err: err.message });
    return false;
  }
}

// #4610: the plain cause of a reply turn that failed, for the note it posts
// (followup.replyFailedText). The record stays on the run.
function replyFailedWhy(error) {
  const e = String(error || '');
  if (/^budget: wall clock/.test(e)) return 'it ran out of time';
  if (/^unparseable:/.test(e)) return 'its answer came back unreadable';
  return 'something went wrong while it worked on it';
}

/**
 * #3264: a follow-up on the bot's own open proposal for this issue. Runs
 * where runTriage would otherwise have stopped at "already has a bot
 * proposal". See homeroom-bot-followup.js for what the turn may do.
 *
 * Activity is not the same as somebody talking to the bot: GitHub moves an
 * issue's updated_at when a pull request references it, and a vote reset
 * writes to the proposal thread. So the turn runs only when a PERSON said
 * something since the bot last looked; otherwise that activity is recorded
 * as seen and nothing is posted or spent.
 *
 * #4533: `recovered` is a turn restart recovery followed to its end
 * ({ turn, mark, mode }, finishRecoveredFollowUp): no turn is run, and what
 * follows the turn runs as it does for a live one, from what its mark kept
 * of where it began.
 */
async function runFollowUp(pool, config, {
  bot, app, repo, item, issue, proposal, runMode, model, turnBudgetMs, startedMs,
  recordFailure, deps, recovered = null,
}) {
  const { github, threadContext, sessions, limits, managedOpenRouter, agentTurn } = deps;
  const issueNumber = Number(item.issue_number);
  // #3654: what the follow-up turn read, recorded beside its run.
  let snapshot = null;
  const recordSnapshot = (runId) => (snapshot && runId
    ? snapshots.recordSnapshot(pool, { runId, ...snapshot })
    : Promise.resolve(null));
  // #4610: where the person wrote, once the replies are read, and how many
  // turns already failed to answer them (followup.repliesSince).
  let noteSessionId = null;
  let priorFailures = 0;
  // #4613: what this run has read through, once the replies are read. The
  // queue row's mark can be older than them, or missing (a checks row, Run
  // now, a restart): recording only it had the next look read the same
  // message as new and answer it a second time. Set below, before any run
  // is recorded; fail() reads it.
  let seenThrough = null;
  // 10 October: with the bot's voice on in a change's discussion
  // (homeroom-bot-voice.js), what people say there, and on its request once
  // the change is up, is the voice's to answer, at once. What they ask it to
  // change is queued as an ask wherever they asked (the discussion, a chat,
  // the DM, a No vote's line), and this turn takes those asks: the voice
  // tells each of them what came of it, where they asked, and this turn
  // posts nothing there itself. GitHub's comments come here as before.
  const voice = voiceModule(deps);
  const voiceSettings = await readSettings(pool).catch(() => null);
  const voiceOnChange = voice.voiceOn(voiceSettings, { type: 'session' });
  const voiceOnRequest = voice.voiceOn(voiceSettings, { type: 'issue' });
  const voiceDeps = { ...(deps.voiceDeps || {}), ...(deps.ws ? { ws: deps.ws } : {}) };
  const runTag = recovered?.mark?.askTag || `fu${Number(item.id) || 0}-${Date.now().toString(36)}`;
  let asks = [];
  // The replies that are not asks, which this turn answers itself (set once
  // they are read).
  let others = [];
  let reportSession = { id: proposal.id, pr_number: proposal.pr_number || null, title: proposal.title || null };
  // Asks that came in while this ran, or that wait to be tried again, are
  // its follow-up's next.
  const requeueAsks = async () => {
    if (!(await voice.asksWaiting(pool, proposal.id).catch(() => false))) return;
    await enqueueFront(pool, { appId: app.id, issueNumber, reason: 'voice_update' })
      .catch((err) => log.warn('homeroom-bot', 'Could not queue the asks waiting on a change', { app: app.slug, err: err.message }));
  };
  // A run that took asks and did not make them: they wait for the next one,
  // unless they were tried as often as they may be, and then the people who
  // asked hear so. A refusal or a platform fault never got going, so it is
  // not a try.
  const asksFailed = async (error, { refund = false } = {}) => {
    const gaveUp = await voice.releaseAsks(pool, { runTag, refund }).catch(() => []);
    if (gaveUp.length) {
      await voice.reportFollowUp(pool, config, {
        app, session: reportSession, bot, asks: gaveUp, outcome: { action: 'failed', why: replyFailedWhy(error) }, deps: voiceDeps,
      });
    }
    if (!refund) await requeueAsks();
  };
  const fail = async (error, extra = {}, opts = {}) => {
    const out = await recordFailure(error, { proposalSessionId: proposal.id, threadSeenAt: seenThrough, ...extra }, opts);
    if (!opts.infra && out?.runId) await recordSnapshot(out.runId);
    if (asks.length) {
      await asksFailed(error, { refund: !!opts.infra || REFUSAL_ERRORS.has(error) });
      if (!others.length) return out;
    }
    // #4610: a reply turn that failed used to post nothing, so the person
    // who wrote heard nothing at all. A wait (a refusal) is said where it
    // happens, and a platform fault is retried on its own row: neither is
    // this. One plain line, and whether it tries again on its own.
    if (!opts.infra && !REFUSAL_ERRORS.has(error) && out?.ran && deps.ws) {
      await postThreadNote({
        pool, ws: deps.ws, app, issueNumber, runId: out.runId || null, kind: 'followup_failed', bot, sessionId: noteSessionId,
        text: followup.replyFailedText({
          why: replyFailedWhy(error), retrying: priorFailures + 1 < followup.MAX_REPLY_TRIES,
        }),
      });
    }
    return out;
  };

  const { rows: lastRows } = await pool.query(
    `SELECT id, thread_seen_at FROM homeroom_bot_runs
      WHERE app_id = $1 AND issue_number = $2
        AND budget_stop IS DISTINCT FROM 'input tokens'
        AND (error IS NULL OR error NOT LIKE 'collateral:%')
      ORDER BY created_at DESC LIMIT 1`,
    [app.id, issueNumber],
  );
  const lastRun = lastRows[0] || null;
  // #4610: the runs since the last one that answered, so a reply turn that
  // failed does not count the message it failed on as answered
  // (followup.repliesSince). Without any, the last run's mark stands.
  const { rows: recentRuns } = recovered ? { rows: [] } : await pool.query(
    `SELECT verdict, error, thread_seen_at, proposal_session_id, checks_head_sha
       FROM homeroom_bot_runs
      WHERE app_id = $1 AND issue_number = $2
        AND budget_stop IS DISTINCT FROM 'input tokens'
        AND (error IS NULL OR error NOT LIKE 'collateral:%')
      ORDER BY created_at DESC LIMIT 8`,
    [app.id, issueNumber],
  ).catch(() => ({ rows: [] }));
  const since = recentRuns?.length
    ? followup.repliesSince(recentRuns, proposal.id)
    : { sinceAt: lastRun?.thread_seen_at || null, failures: 0, gaveUp: false };
  priorFailures = since.gaveUp ? 0 : since.failures;

  const seedReadAt = recovered?.mark.seedReadAt || new Date().toISOString();
  const [{ comments = [] } = {}, issueThread, proposalThread, botLogin] = await Promise.all([
    github.fetchIssueComments(repo.owner, repo.repo, issueNumber).catch(() => ({ comments: [] })),
    threadContext.loadIssueThread(pool, app.id, issueNumber),
    threadContext.loadProposalThread(pool, app.id, proposal.id),
    live.botUsernameOf(github),
  ]);
  // #4533: a recovered turn answered what it read before the restart; its
  // mark says where that was, which is where the answer goes.
  let replies = recovered ? [{ where: recovered.mark.onProposal ? 'proposal' : 'issue' }] : followup.newReplies({
    comments,
    issueThread: issueThread?.messages || [],
    proposalThread: proposalThread?.messages || [],
    botLogin,
    botUsername: BOT_USERNAME,
    sinceMs: toMs(since.sinceAt),
  });
  if (!recovered) {
    // What people wrote where the voice answers is the voice's; what they
    // asked it to change comes here as asks.
    replies = replies.filter((r) => r.via !== 'homeroom' || (r.where === 'proposal' ? !voiceOnChange : !voiceOnRequest));
    if (voiceOnChange) {
      asks = await voice.takeAsks(pool, { sessionId: proposal.id, runTag }).catch((err) => {
        log.warn('homeroom-bot', 'Could not take the asks waiting on a change', { app: app.slug, err: err.message });
        return [];
      });
      replies = [...replies, ...asks.map(followup.askAsReply)].sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
    }
  } else if (recovered.mark.askTag) {
    asks = await voice.asksOf(pool, runTag).catch(() => []);
  }
  others = recovered ? (asks.length ? [] : replies) : replies.filter((r) => r.via !== 'ask');
  noteSessionId = others.some((r) => r.where === 'proposal') ? proposal.id : null;
  // #4613: every run this turn records carries a mark past what it read, so
  // the next look does not read the same replies again (followup.readThrough).
  // advanceSeen still raises it further when it can (the GitHub comment's
  // own stamp), and a person writing while the turn runs stays after it.
  seenThrough = followup.readThrough(replies, item.thread_seen_at || null);
  // Its own red checks: a failing verdict on the proposal's current head
  // that no follow-up has looked at yet is a reason to look again even when
  // nobody said anything. A person's reply comes first; a fix still due
  // after it is queued again below (requeueChecks).
  const checks = replies.length ? null : await checksToFix(pool, proposal.id);
  if (!replies.length && !checks) {
    if (lastRun && item.thread_seen_at) {
      await pool.query(
        `UPDATE homeroom_bot_runs
            SET thread_seen_at = GREATEST(COALESCE(thread_seen_at, $2::timestamptz), $2::timestamptz)
          WHERE id = $1`,
        [lastRun.id, item.thread_seen_at],
      );
    }
    await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
    log.info('homeroom-bot', 'Activity on a bot proposal\'s issue, but nobody said anything new', {
      app: app.slug, issueNumber, sessionId: proposal.id,
    });
    return { ran: false, reason: 'no_new_replies' };
  }

  // The proposal as every revision path reads it (cs.* plus the app's
  // identity), and only while it is still the bot's open proposal.
  const { rows: sessionRows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url, a.self_hosted AS app_self_hosted
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status = 'promoted'`,
    [proposal.id, bot.id],
  );
  const session = sessionRows[0];
  if (!session || !session.branch_name) {
    await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
    if (asks.length) {
      // Merged or closed before its update: what was asked of it goes, and
      // the people who asked hear so.
      await voice.finishAsks(pool, { runTag, status: 'dropped' }).catch(() => {});
      await voice.dropAsks(pool, proposal.id);
      await voice.reportFollowUp(pool, config, {
        app, session: reportSession, bot, asks, outcome: { action: 'gone' }, deps: voiceDeps,
      });
    }
    return { ran: false, reason: 'has_proposal' };
  }
  reportSession = session;
  // #4533: whether a recovered turn moved the head is read against the head
  // it started from: the person's recovery tail has made its push the
  // reviewed head since.
  if (recovered) session.reviewed_head_sha = recovered.mark.reviewedHeadSha || null;

  const { rows: revisionRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM homeroom_bot_runs
      WHERE proposal_session_id = $1 AND verdict = 'revise'`,
    [session.id],
  );
  // #4533: a recovered turn ran in the mode it was given then.
  const canRevise = recovered ? recovered.mode === 'build' : (revisionRows[0]?.n || 0) < followup.MAX_REVISIONS;
  const mode = canRevise ? 'build' : 'scout';

  if (checks) {
    return runChecksFix(pool, config, {
      bot, app, repo, item, issue, session, checks, canRevise, mode, runMode, model, turnBudgetMs, startedMs,
      recordFailure, lastRun, seedReadAt, comments, issueThread, proposalThread, botLogin, deps,
    });
  }
  // A fix still due after this turn (it answered, or its change did not
  // land) is looked at on the next pass: this run consumes the queue row.
  const requeueChecks = () => noteProposalChecks(pool, { sessionId: session.id });

  // #4533: a recovered turn has run already; nothing is read for a prompt.
  let turn = recovered ? recovered.turn : null;
  if (!turn) {
    const seed = sessions.buildHeadlessSeed(
      issueNumber, issue, comments, botLogin, issueThread?.messages || [],
    );
    const proposalBlock = require('./thread-context').buildProposalDiscussionBlock({
      sessionId: session.id, prNumber: session.pr_number,
      threadMessages: proposalThread?.messages || [], truncated: !!proposalThread?.truncated,
    });
    // #3703: the spec whose card leads the proposal's discussion, which is
    // what a reply there is usually about.
    const spec = await proposalSpec(pool, session.id);
    // #3767: a revision gets the design guidance and the browser check its
    // build had (#3748), read for what the turn's model can see.
    const design = canRevise
      ? live.revisionDesignText({ readsImages: await live.buildSeesImages({ pool, config, userId: bot.id, model }) })
      : '';
    // #4572: a person writing on a change whose checks fail is shown them
    // too, so the reply can fix them (followup.failingNowLines). Whether or
    // not a fix turn already looked at this head.
    const failingNow = await failingChecksNow(pool, session.id);
    // #4645: the requester's language preference (users.locale), for the
    // prompts' wording rule: a question the bot asks reaches them in their
    // DM with it, so that is where the rule can match their locale.
    const requester = await (deps.dm || require('./homeroom-bot-dm'))
      .requesterOf(pool, app.id, issueNumber).catch(() => null);
    const locale = requester?.locale || null;
    const prompt = followup.followUpPrompt({
      seed, proposalBlock, spec, prNumber: session.pr_number, replies, canRevise, design, checks: failingNow,
      // #4612: how an updated plan is written, when the revision changes
      // what the change does for people.
      planFormat: canRevise ? live.followUpPlanFormat({ config, app, locale }) : undefined,
      locale,
    });
    snapshot = {
      stage: 'followup', appId: app.id, issueNumber,
      // The follow-up works on the proposal's branch, at its reviewed head.
      baseSha: session.reviewed_head_sha || null,
      texts: {
        seed, prompt, proposal_block: proposalBlock, spec,
        replies: JSON.stringify(replies),
        thread: snapshots.frozenThread({
          issueNumber, issue, comments, threadMessages: issueThread?.messages || [], botLogin,
        }),
      },
      extra: { model, canRevise, prNumber: session.pr_number || null, mode },
    };

    turn = await followup.runFollowUpTurn({
      pool, config, bot, repo, session, prompt, mode, issueNumber, turnBudgetMs, model, deps,
      turnMark: followUpMark({
        kind: 'reply', app, item, runMode, model, startedMs, seedReadAt, session,
        threadSeenAt: seenThrough,
        extra: { onProposal: others.some((r) => r.where === 'proposal'), ...(asks.length ? { askTag: runTag } : {}) },
      }),
      // #4610: once the turn is really going ahead, the person hears so. An
      // ask was told so by the voice when it was queued.
      onStart: deps.ws && !asks.length ? () => postThreadNote({
        pool, ws: deps.ws, app, issueNumber, kind: 'followup_working', text: followup.workingText(), bot,
        sessionId: noteSessionId,
      }) : null,
    });
    // #4610: and when it has to wait for another turn on the change, why.
    if (turn.routed?.error === 'session_busy' && deps.ws && !asks.length) {
      await noteFollowUpWait(pool, { app, issueNumber, bot, why: 'session_busy', sessionId: session.id, ws: deps.ws });
    }
  }
  const result = turn.result || {};
  const relay = relaySpend(result.relayUsage, turn.pricing, agentTurn);
  const costUsd = turn.costUsd ?? relay?.costUsd ?? null;
  const usage = {
    inputTokens: Number.isFinite(result.inputTokens) ? result.inputTokens : (relay?.inputTokens ?? null),
    outputTokens: Number.isFinite(result.outputTokens) ? result.outputTokens : (relay?.outputTokens ?? null),
  };
  if (costUsd > 0) {
    try {
      if (await managedOpenRouter.usesIncludedKey(pool, bot.id)) {
        await limits.recordSpend(pool, bot.id, Math.round(costUsd * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('homeroom-bot', 'Spend debit failed', { err: err.message });
    }
  }
  const spent = { sessionId: session.id, costUsd, ...usage };

  if (turn.stopped) {
    return fail('budget: wall clock', { ...spent, budgetStop: 'wall clock' });
  }
  if (turn.routed?.error) {
    const code = String(turn.routed.error);
    return fail(code, spent, {
      infra: !!turn.infra || INFRA_ERRORS.has(code) || code.startsWith('dispatch:'),
    });
  }

  const parsed = followup.parseFollowUp(result.lastResultText);
  if (parsed?.stopMentioning?.length || parsed?.resumeMentioning?.length) {
    await live.applyMentionAsks({
      pool, github, app, repo, issueNumber, stop: parsed.stopMentioning, resume: parsed.resumeMentioning,
      proposalSessionId: session.id,
    }).catch((err) => log.warn('homeroom-bot', 'Could not record a mention opt-out', { app: app.slug, issueNumber, err: err.message }));
  }
  const moved = followup.headMoved({
    mode, result, reviewedHeadSha: session.reviewed_head_sha, action: parsed?.action,
  });
  // A failed turn is never a revision (followup.headMoved); this says why.
  const turnFailed = live.failedClaudeTurn(result);
  if (!parsed && !moved) {
    if (turnFailed) return fail(`the follow-up turn failed (${turnFailed})`, spent);
    return fail(`unparseable: ${clip(String(result.lastResultText || '').slice(-300), 300) || '(empty reply)'}`, {
      ...spent, unreadableReply: unreadableReplyOf(result.lastResultText),
    });
  }

  let runId = null;
  let targets;
  const say = async (kind, text, postedAt, extra = {}) => {
    // The people on the issue and the proposal, as a verdict's posts tag them.
    if (targets === undefined) {
      targets = await live.mentionTargets({
        pool, github, app, repo, issueNumber, issue, botLogin, bot, proposalSessionId: session.id,
      }).catch(() => []);
    }
    const posted = await live.post({
      pool, github, ws: deps.ws, app, repo, issueNumber, kind, runId, text, sender: bot, senderId: bot.id,
      mentions: live.tagsPoster(kind) ? targets : [], notifications: deps.notifications || null,
      // Answered where it was asked: the proposal's thread too, when that
      // is where somebody wrote, and there alone when nobody wrote anywhere
      // else (live.post onlyProposal).
      proposalSessionId: others.some((r) => r.where === 'proposal') ? session.id : null,
      onlyProposal: others.length > 0 && others.every((r) => r.where === 'proposal'),
      // What the voice tells the people who asked is not said again in the
      // request's thread, and GitHub hears an update, or an answer to a
      // comment left there, and nothing else.
      ...(asks.length ? {
        skipIssueThread: !others.some((r) => r.where === 'issue' && r.via === 'homeroom'),
        skipGithub: kind !== 'followup_revise' && !others.some((r) => r.via === 'github'),
      } : {}),
      ...extra,
    });
    if (posted?.githubCreatedAt) postedAt.push(posted.githubCreatedAt);
  };

  // Said it would revise, but the push moved nothing.
  if (parsed && parsed.action === 'revise' && !moved) {
    const why = turnFailed ? `the turn failed (${turnFailed}), so its change was not kept`
      : mode === 'build' && result.pushOk === false
        ? 'its change could not be pushed' : 'the turn produced no change';
    runId = await insertRun(pool, {
      ...billingOf(item, runMode),
      readReason: readReasonOf(item),
      appId: app.id, issueNumber, mode: runMode, verdict: 'failed', error: `revise: ${why}`,
      reason: parsed.reply, threadSeenAt: seenThrough, model,
      durationMs: Date.now() - startedMs, proposalSessionId: session.id, ...spent,
    });
    await recordSnapshot(runId);
    await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
    log.warn('homeroom-bot', 'Follow-up said it revised, but the change did not move', {
      app: app.slug, issueNumber, sessionId: session.id, why, runId,
    });
    const postedAt = [];
    // What happened in plain words, and how to start it again; the record
    // (`why`) stays on the run and in the line above (followup.revisionFailedText).
    // The requester hears it in their DM too, with the change's card.
    const proposalUrl = deps.domain ? live.proposalLink(deps.domain, app.slug, session.id, session.pr_number) : null;
    // Asks are tried again, once, and the voice says when they give up.
    if (asks.length) await asksFailed(`revise: ${why}`);
    if (others.length) {
      await say('followup_failed', followup.revisionFailedText({ why, canRevise }), postedAt, {
        dm: { reason: why, canRevise, sessionId: session.id, link: proposalUrl },
      })
        .catch((err) => log.warn('homeroom-bot', 'Follow-up post failed', { err: err.message }));
    }
    await live.advanceSeen({
      pool, github, threadContext, app, repo, issueNumber, runId, since: seedReadAt, postedAt,
      proposalSessionId: session.id,
    }).catch(() => {});
    await requeueChecks();
    return { ran: true, verdict: 'failed', runId };
  }

  const action = moved ? 'revise' : parsed.action;
  const reply = parsed?.reply || 'It updated the change to follow the latest replies.';
  // #4533: after a restart, the person's recovery tail has already done
  // this for the new head (server.js finalizeRecoveredTurn).
  if (moved && !recovered) await reconcileRevision({ config, pool, session, app, issueNumber, deps });
  // #3767: and its name, when the revision changed what it does. Ear Trainer's
  // size options were taken out and its proposal was still called "Lead size
  // options with the number of sounds" when it merged.
  if (moved && parsed?.title) await renameRevised({ pool, github, repo, session, title: parsed.title, app });

  // #4612: when the revision changed what the plan says, the turn wrote the
  // whole updated plan before its JSON block. Store it as the change's next
  // spec version; when it could not be read or stored, the revision goes on
  // with the plan it has.
  let planVersion = null;
  let planRead = null;
  if (moved && parsed?.planChanged) {
    planRead = live.readSpec(followup.planOutOf(result.lastResultText));
    if (planRead.ok) {
      planVersion = await live.publishSpec({
        pool, sessions, session, specMd: planRead.specMd, specHtml: planRead.specHtml, model, revised: true,
      });
    } else {
      log.warn('homeroom-bot', 'The revised plan could not be read; keeping the previous one', {
        app: app.slug, issueNumber, sessionId: session.id, error: planRead.error,
      });
    }
  }

  const askAnswers = action === 'ask' ? suggestedAnswers(parsed?.answers) : null;
  runId = await insertRun(pool, {
    ...billingOf(item, runMode),
    readReason: readReasonOf(item),
    appId: app.id, issueNumber, mode: runMode, verdict: followup.VERDICT_FOR[action],
    question: action === 'ask' ? reply : null,
    questionAnswers: askAnswers,
    reason: reply,
    buildNote: action === 'revise' ? (parsed?.summary || null) : null,
    threadSeenAt: seenThrough, model,
    durationMs: Date.now() - startedMs, proposalSessionId: session.id, ...spent,
  });
  await recordSnapshot(runId);
  await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
  clearFollowUpRefusals(app.id, issueNumber);
  log.info('homeroom-bot', 'Followed up on its proposal', {
    app: app.slug, issueNumber, sessionId: session.id, action, costUsd, runId,
  });

  const prNumber = session.pr_number;
  const proposalUrl = deps.domain ? live.proposalLink(deps.domain, app.slug, session.id, session.pr_number) : null;
  const text = action === 'revise'
    ? followup.revisedText({
      summary: parsed?.summary, reply: parsed?.reply, planVersion, prNumber, link: proposalUrl,
    })
    : action === 'ask' ? followup.askText({ reply, prNumber })
      : action === 'person' ? followup.personText({ reply, prNumber })
        : followup.answerText({ reply, prNumber });
  // #3624: what reaches the requester's DM. An answer is for whoever asked
  // it, on the proposal, so it stays there.
  const dm = action === 'ask' ? { question: reply, answers: askAnswers || [] }
    : action === 'revise' ? { summary: parsed?.summary || reply, link: proposalUrl, sessionId: session.id }
      : action === 'person' ? { reason: reply }
        : null;
  const postedAt = [];
  // B4: an update carries the change's card in the thread, in place of an address.
  const card = action === 'revise'
    ? { msgType: 'vote', metadata: { vote: { sessionId: session.id, prNumber } } } : {};
  // With asks, a question or a note reaches the requester's DM only when
  // somebody asked there; an update still moves their card.
  const dmHere = dm && (!asks.length || action === 'revise' || others.length > 0 || asks.some((a) => a.source === 'dm'))
    ? dm : null;
  await say(`followup_${action}`, text, postedAt, { ...card, ...(dmHere ? { dm: dmHere } : {}) })
    .catch((err) => log.warn('homeroom-bot', 'Follow-up post failed', { err: err.message }));
  if (asks.length) {
    // The people who asked hear what came of it, where they asked, in the
    // voice's own words.
    await voice.reportFollowUp(pool, config, {
      app, session, bot, asks, deps: voiceDeps,
      outcome: { action, moved, summary: parsed?.summary || null, reply: parsed?.reply || null, planVersion },
    });
    await voice.finishAsks(pool, { runTag, runId }).catch(() => {});
  }
  // #4612: the updated plan, where the first plan was posted: the spec card
  // in the change's discussion, then its copy on the GitHub issue. Its own
  // comment is pushed into postedAt so the turn does not read it back as
  // new activity.
  if (planVersion && planRead) {
    await live.postSpecOnProposal({
      pool, ws: deps.ws, app, bot, sessionId: session.id, version: planVersion, spec: planRead.specMd, revised: true,
    }).catch((err) => log.warn('homeroom-bot', 'Could not post the revised plan card', {
      app: app.slug, issueNumber, err: err.message,
    }));
    const planComment = await live.postRevisedSpecComment({
      github, repo, issueNumber, spec: planRead.specMd, version: planVersion,
    }).catch((err) => {
      log.warn('homeroom-bot', 'Could not post the revised plan on the issue', {
        app: app.slug, issueNumber, err: err.message,
      });
      return null;
    });
    if (planComment?.created_at) postedAt.push(planComment.created_at);
  }
  await live.advanceSeen({
    pool, github, threadContext, app, repo, issueNumber, runId, since: seedReadAt, postedAt,
    proposalSessionId: session.id,
  }).catch((err) => log.warn('homeroom-bot', 'Could not record what the bot has seen', { err: err.message }));
  if (!moved) await requeueChecks();
  await requeueAsks();
  return { ran: true, verdict: followup.VERDICT_FOR[action], runId, acted: `followup_${action}` };
}

/**
 * #3767: give the bot's own proposal the name its revision chose, through
 * the seam a person's own revision uses (proposal-update.js
 * applyProposedTitle): the panel's name, and the pull request's on GitHub.
 * Never throws.
 */
async function renameRevised({ pool, github, repo, session, title, app }) {
  try {
    const { rows } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [session.id]);
    const fresh = rows[0];
    if (!fresh) return;
    const out = await require('./proposal-update').applyProposedTitle({
      pool, gh: github, session: fresh, owner: repo.owner, repo: repo.repo, title, viewerLogin: null,
    });
    if (out.changed) log.info('homeroom-bot', 'Renamed its proposal after a revision', { app: app.slug, sessionId: session.id });
  } catch (err) {
    log.warn('homeroom-bot', 'Could not rename its proposal after a revision', { app: app.slug, sessionId: session.id, err: err.message });
  }
}

/**
 * The same reconcile a person's revision reaches, after a follow-up moved
 * the proposal's head: the new head becomes the reviewed one, earlier votes
 * stop counting, checks and the staging preview re-run on it, and the
 * thread says so. Never throws.
 */
async function reconcileRevision({ config, pool, session, app, issueNumber, deps }) {
  try {
    const votes = deps.votes || require('../routes/votes');
    const { rows: fresh } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url, a.self_hosted AS app_self_hosted
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
      [session.id],
    );
    await votes.reconcileNativeReviewedHead({
      config, pool, session: fresh[0] || session, fresh: true, notify: true, madeBy: 'bot',
    });
  } catch (err) {
    log.error('homeroom-bot', 'Follow-up revision pushed, but reconciling the proposal failed', {
      app: app.slug, issueNumber, sessionId: session.id, err: err.message,
    });
  }
}

// ── Its own red checks ───────────────────────────────────────────────────
//
// See homeroom-bot-followup.js for what the turn may do. The wiring:
//   - every settled check verdict reaches visuals' noteBotChecksAfterChecks,
//     beside the merge re-drive; a 'failing' one calls noteProposalChecks,
//     which queues the issue of a proposal of the bot's (CHECKS_REASON) when
//     a fix is due (followup.checksDue) and the app is live;
//   - the queue row reaches runTriage, which finds the open proposal and
//     hands it to runFollowUp; with no new replies and a fix due, that is
//     runChecksFix. A reply comes first, and a fix still due after it is
//     queued again.
//   - each failing head is looked at once: the run that looked records it
//     (checks_head_sha), and checksDue reads that back as `looked`.
//   - a declared change its before & after shots show failing on that head
//     is due the same turn (followup.brokenClaims): every settled shots run
//     reaches homeroom-bot-dm.noteShotsSettled, whose noteChangeReady calls
//     noteProposalChecks before it would offer the change as ready to try.
//     So is one they skipped for want of data the change can seed
//     (followup.skippedClaims); its revision is a new head, whose shots are
//     taken again once. A skip is never a reason for a round once a fix
//     round has revised the proposal (`fix_revised`), so it never loops.

const CHECKS_ROW_SQL = `SELECT cs.id, cs.app_id, cs.linked_issues, cs.check_state, cs.checks_commit_sha,
            cs.reviewed_head_sha, cs.test_results, cs.shots_state, cs.shots_detail, a.slug, a.name, a.repo_url,
            EXISTS (
              SELECT 1 FROM homeroom_bot_runs r
               WHERE r.proposal_session_id = cs.id
                 AND r.checks_head_sha = LOWER(cs.reviewed_head_sha)
            ) AS looked,
            EXISTS (
              SELECT 1 FROM homeroom_bot_runs r
               WHERE r.proposal_session_id = cs.id
                 AND r.verdict = 'revise' AND r.checks_head_sha IS NOT NULL
            ) AS fix_revised
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
       JOIN users u ON u.id = cs.user_id
      WHERE cs.id = $1 AND cs.status = 'promoted' AND u.username = $2 AND u.is_synthetic = TRUE`;

/**
 * #4572: the checks failing on the bot's proposal `sessionId` now, and what
 * its shots show failing, whether or not a fix turn looked at this head
 * already: what a reply turn is shown (followup.failingNowLines). Null when
 * nothing fails or the read fails.
 */
async function failingChecksNow(pool, sessionId) {
  try {
    const { rows } = await pool.query(CHECKS_ROW_SQL, [Number(sessionId), BOT_USERNAME]);
    return rows[0] ? followup.checksDue({ ...rows[0], looked: false }) : null;
  } catch {
    return null;
  }
}

/** The fix the bot's proposal `sessionId` is due, or null (followup.checksDue). */
async function checksToFix(pool, sessionId) {
  const { rows } = await pool.query(CHECKS_ROW_SQL, [Number(sessionId), BOT_USERNAME]);
  return followup.checksDue(rows[0]);
}

/**
 * A check verdict settled 'failing' on proposal `sessionId` (visuals.js),
 * or its before & after shots showed a declared change failing, or skipped
 * one for want of data the change can seed, while its checks passed
 * (homeroom-bot-dm.noteChangeReady). When it is the bot's own
 * open proposal, on an app it is live on, and a fix is due on its current
 * head, its issue is queued for a checks follow-up and the loop woken. A
 * run that looks like the platform's fault (followup.checksLookLikeInfra)
 * is left for the platform's own re-run. Never throws; resolves whether it
 * queued.
 */
async function noteProposalChecks(pool, { sessionId } = {}) {
  try {
    const { rows } = await pool.query(CHECKS_ROW_SQL, [Number(sessionId), BOT_USERNAME]);
    const row = rows[0];
    const due = followup.checksDue(row);
    if (!due) return false;
    const issueNumber = Array.isArray(row.linked_issues) ? Number(row.linked_issues[0]) : null;
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) return false;
    const settings = await readSettings(pool);
    if (settings.mode === 'off' || !live.isLiveFor(settings, { slug: row.slug })) return false;
    if (followup.checksLookLikeInfra(due)) {
      log.info('homeroom-bot', 'Its proposal\'s checks failed, but it looks like the platform; not revising', {
        app: row.slug, issueNumber, sessionId: row.id, failing: due.failing.length, total: due.total,
      });
      // #4242: nothing else tells its requester, and its card would say it
      // is still being checked for good: they hear it needs a look.
      if (due.failing.length) await require('./homeroom-bot-dm').noteNeedsLook(pool, { sessionId: row.id, why: 'checks' });
      return false;
    }
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (app_id, issue_number) DO UPDATE
         SET priority = LEAST(homeroom_bot_queue.priority, 1),
             reason = CASE WHEN homeroom_bot_queue.priority = 0
                           THEN homeroom_bot_queue.reason ELSE EXCLUDED.reason END,
             enqueued_at = NOW()
       WHERE homeroom_bot_queue.started_at IS NULL`,
      [row.app_id, issueNumber, CHECKS_REASON],
    );
    log.info('homeroom-bot', due.failing.length
      ? 'Its proposal\'s checks failed; queued to fix them'
      : due.broken?.length
        ? 'Part of its proposal failed when Homeroom tried it; queued to fix it'
        : 'Its proposal\'s shots could not reach a change for want of data; queued to add it', {
      app: row.slug, issueNumber, sessionId: row.id, head: due.head, failing: due.failing.length, total: due.total,
      broken: due.broken?.length || 0, skipped: due.skipped?.length || 0,
    });
    noteIssueActivity({ appId: row.app_id, issueNumber, reason: CHECKS_REASON });
    return true;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not look at a failing check verdict', { sessionId, err: err.message });
    return false;
  }
}

/**
 * ONE turn on the bot's own proposal to fix its failing checks, or the
 * hand-off to a person when it may not or cannot. Every outcome that spent
 * a turn, and every hand-off, records the head it looked at, so the same
 * failing head is never looked at twice; a platform fault records nothing
 * of the kind and keeps the queue row, as a triage's does.
 *
 * #4533: `recovered` is a fix turn restart recovery followed to its end
 * ({ turn, mark, mode }, finishRecoveredFollowUp): no turn is run, and
 * everything after it is what a live fix does, but the reconcile, which the
 * person's recovery tail has done.
 */
async function runChecksFix(pool, config, {
  bot, app, repo, item, issue, session, checks, canRevise, mode, runMode, model, turnBudgetMs, startedMs,
  recordFailure, lastRun, seedReadAt, comments, issueThread, proposalThread, botLogin, deps, recovered = null,
}) {
  const { github, threadContext, sessions, limits, managedOpenRouter, agentTurn } = deps;
  const issueNumber = Number(item.issue_number);
  const prNumber = session.pr_number;
  const { head, failing, total } = checks;
  // The declared changes its shots show failing on this head, if any.
  const broken = Array.isArray(checks.broken) ? checks.broken : [];
  // And those they skipped for want of data the change can seed itself.
  const skipped = Array.isArray(checks.skipped) ? checks.skipped : [];
  const onlyShots = followup.onlyShotsDue(checks);
  // The run keeps what the bot has seen of the issue: nobody said anything,
  // so the last run's mark stands (without one the next refresh would read
  // the whole thread as new).
  const threadSeenAt = item.thread_seen_at || lastRun?.thread_seen_at || null;
  const dropRow = () => pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
  // #3654: what the fix turn read, recorded beside the run it produces.
  let snapshot = null;
  const recordSnapshot = (id) => (snapshot && id
    ? snapshots.recordSnapshot(pool, { runId: id, ...snapshot })
    : Promise.resolve(null));

  if (!recovered && followup.checksLookLikeInfra(checks)) {
    await dropRow();
    log.info('homeroom-bot', 'Failing checks look like the platform\'s fault; not revising', {
      app: app.slug, issueNumber, sessionId: session.id, failing: failing.length, total,
    });
    return { ran: false, reason: 'checks_infra' };
  }

  let runId = null;
  const handOff = async ({ why, verdict, extra = {}, notChange = false }) => {
    runId = await insertRun(pool, {
      ...billingOf(item, runMode),
      readReason: readReasonOf(item),
      appId: app.id, issueNumber, mode: runMode, verdict,
      reason: why, error: verdict === 'failed' ? `checks: ${why}` : null,
      threadSeenAt, model, durationMs: Date.now() - startedMs,
      proposalSessionId: session.id, checksHeadSha: head, ...extra,
    });
    await recordSnapshot(runId);
    await dropRow();
    // Only shots that could not reach a change, and no data was added: the
    // change works, and its shots card already says why each was skipped, so
    // nobody is told anything more. The head is looked at, so this is not
    // asked again; the ready card that waited on this round goes out now.
    if (onlyShots) {
      log.info('homeroom-bot', 'Its proposal\'s shots could not reach a change, and it added no data for them', {
        app: app.slug, issueNumber, sessionId: session.id, head, why, skipped: skipped.length,
      });
      (deps.dm || require('./homeroom-bot-dm')).noteChangeReady(pool, session.id, { ws: deps.ws || null })
        .catch(() => {});
      return { ran: true, verdict, runId, acted: 'checks_shots_left' };
    }
    if (notChange) {
      // Not the change's doing: the platform's to look at. Admins are told
      // (the Unexpected events list and its digest), the group voting on the
      // change gets one line where it votes, and nobody else is told.
      await incidents().record(pool, {
        kind: incidents().KINDS.CHECKS_NOT_CHANGE, appId: app.id, sessionId: session.id,
        detail: {
          runId, issueNumber, prNumber: prNumber || null, head: head || null,
          failing: failing.slice(0, 5).map((f) => clip(String(f?.name || f?.title || f || ''), 120)),
          why: clip(String(why || ''), 300),
        },
      });
      await live.postOnProposal({
        pool, ws: deps.ws, app, issueNumber, runId, kind: 'checks_not_change', bot, sessionId: session.id,
        text: followup.checksNotChangeText({ failingCount: failing.length }),
      }).catch((err) => log.warn('homeroom-bot', 'Checks note failed', { app: app.slug, issueNumber, err: err.message }));
      log.info('homeroom-bot', 'Its proposal\'s failing checks are not its doing; told admins', {
        app: app.slug, issueNumber, sessionId: session.id, head, runId,
      });
      return { ran: true, verdict, runId, acted: 'checks_not_change' };
    }
    const targets = await live.mentionTargets({
      pool, github, app, repo, issueNumber, issue, botLogin, bot, proposalSessionId: session.id,
    }).catch(() => []);
    const text = followup.checksPersonText({ why, prNumber, failingCount: failing.length, broken });
    const posted = await live.post({
      pool, github, ws: deps.ws, app, repo, issueNumber, kind: 'followup_person', runId, text,
      sender: bot, senderId: bot.id, mentions: targets, notifications: deps.notifications || null,
      // Said where the group votes too: the checks are the proposal's.
      proposalSessionId: session.id,
      // Red checks a person must look at reach the requester as a stop
      // (homeroom-bot-dm.js, kind 'checks'); what does not work yet is theirs.
      dm: failing.length
        ? { reason: `its checks are failing: ${why}`, checks: true, failing: failing.length, sessionId: session.id }
        : { reason: `part of it does not work yet: ${why}` },
    }).catch((err) => {
      log.warn('homeroom-bot', 'Checks hand-off post failed', { app: app.slug, issueNumber, err: err.message });
      return null;
    });
    await live.advanceSeen({
      pool, github, threadContext, app, repo, issueNumber, runId, since: seedReadAt,
      postedAt: posted?.githubCreatedAt ? [posted.githubCreatedAt] : [], proposalSessionId: session.id,
    }).catch(() => {});
    log.info('homeroom-bot', 'Handed its proposal\'s failing checks to a person', {
      app: app.slug, issueNumber, sessionId: session.id, head, why, broken: broken.length,
    });
    // This head has been looked at now. A change whose checks pass but whose
    // shots showed part of it failing was held back from "ready to try" for
    // this round; it goes out now, saying plainly what does not work
    // (homeroom-bot-dm.noteChangeReady).
    if (broken.length) {
      (deps.dm || require('./homeroom-bot-dm')).noteChangeReady(pool, session.id, { ws: deps.ws || null })
        .catch(() => {});
    }
    return { ran: true, verdict, runId, acted: 'checks_person' };
  };

  // Out of revisions: no turn, one note.
  if (!canRevise) {
    return handOff({
      why: `it has already updated this change ${followup.MAX_REVISIONS} times, as many as it may on its own`,
      verdict: 'person',
    });
  }

  // #4533: a recovered turn has run already; nothing is read for a prompt.
  let turn = recovered ? recovered.turn : null;
  if (!turn) {
    const seed = sessions.buildHeadlessSeed(issueNumber, issue, comments, botLogin, issueThread?.messages || []);
    const proposalBlock = require('./thread-context').buildProposalDiscussionBlock({
      sessionId: session.id, prNumber,
      threadMessages: proposalThread?.messages || [], truncated: !!proposalThread?.truncated,
    });
    // #4645: the requester's language preference, for the prompt's wording
    // rule (localeRule); unset, the note to the group stays English.
    const requester = await (deps.dm || require('./homeroom-bot-dm'))
      .requesterOf(pool, app.id, issueNumber).catch(() => null);
    const prompt = followup.checksFixPrompt({
      seed, proposalBlock, prNumber, failing, total, broken, skipped, locale: requester?.locale || null,
    });
    snapshot = {
      stage: 'checks_fix', appId: app.id, issueNumber,
      baseSha: head,
      texts: {
        seed, prompt, proposal_block: proposalBlock,
        failing: JSON.stringify(failing),
        ...(broken.length ? { broken: JSON.stringify(broken) } : {}),
        ...(skipped.length ? { skipped: JSON.stringify(skipped) } : {}),
        thread: snapshots.frozenThread({
          issueNumber, issue, comments, threadMessages: issueThread?.messages || [], botLogin,
        }),
      },
      extra: { model, prNumber: prNumber || null, total, mode },
    };
    turn = await followup.runFollowUpTurn({
      // `mode` is runFollowUp's: a build turn, since revisions remain.
      pool, config, bot, repo, session, prompt, mode, issueNumber, turnBudgetMs, model, deps,
      // A fix round's own message, which the reconcile reads back to know
      // the move changed how the change works, not what it does
      // (homeroom-commits.js).
      commitMsg: FIX_COMMIT_MESSAGES[failing.length ? 'checks' : broken.length ? 'broken' : 'shots'](issueNumber),
      turnMark: followUpMark({
        kind: 'checks_fix', app, item, runMode, model, startedMs, seedReadAt, session, threadSeenAt,
        extra: {
          checks: {
            head, total, failing: failing.length,
            broken: broken.slice(0, 5).map((b) => ({ claim: clip(String(b?.claim || ''), 300) })),
            ...(skipped.length ? { skipped: skipped.slice(0, 5).map((s) => ({ claim: clip(String(s?.claim || ''), 300) })) } : {}),
          },
        },
      }),
    });
  }
  const result = turn.result || {};
  const relay = relaySpend(result.relayUsage, turn.pricing, agentTurn);
  const costUsd = turn.costUsd ?? relay?.costUsd ?? null;
  if (costUsd > 0) {
    try {
      if (await managedOpenRouter.usesIncludedKey(pool, bot.id)) {
        await limits.recordSpend(pool, bot.id, Math.round(costUsd * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('homeroom-bot', 'Spend debit failed', { err: err.message });
    }
  }
  const spent = {
    sessionId: session.id, costUsd,
    inputTokens: Number.isFinite(result.inputTokens) ? result.inputTokens : (relay?.inputTokens ?? null),
    outputTokens: Number.isFinite(result.outputTokens) ? result.outputTokens : (relay?.outputTokens ?? null),
  };

  const code = turn.routed?.error ? String(turn.routed.error) : null;
  if (code && !turn.stopped && (turn.infra || INFRA_ERRORS.has(code) || code.startsWith('dispatch:'))) {
    // The platform's fault: the queue row is kept and retried, and the head
    // is not marked, so the retry can still fix it.
    return recordFailure(code, { proposalSessionId: session.id, ...spent }, { infra: true });
  }

  const parsed = turn.stopped || code ? null : followup.parseFollowUp(result.lastResultText);
  const moved = !turn.stopped && !code && followup.headMoved({
    mode, result, reviewedHeadSha: session.reviewed_head_sha, action: parsed?.action,
  });
  if (moved) {
    // #4533: after a restart, the person's recovery tail has already done
    // this for the new head (server.js finalizeRecoveredTurn).
    if (!recovered) await reconcileRevision({ config, pool, session, app, issueNumber, deps });
    const summary = parsed?.summary || parsed?.reply || (onlyShots
      ? 'It added the data the before and after shots need.'
      : 'It updated the change so its checks pass.');
    runId = await insertRun(pool, {
      ...billingOf(item, runMode),
      readReason: readReasonOf(item),
      appId: app.id, issueNumber, mode: runMode, verdict: 'revise',
      reason: parsed?.reply || summary, buildNote: summary,
      threadSeenAt, model, durationMs: Date.now() - startedMs,
      proposalSessionId: session.id, checksHeadSha: head, ...spent,
    });
    await recordSnapshot(runId);
    await dropRow();
    clearFollowUpRefusals(app.id, issueNumber);
    // Said in the proposal's own discussion, where the group votes and the
    // checks are shown; not on the issue, whose people asked for the change,
    // not for its checks. The reconcile has already said the votes were
    // cleared there. Run four (13 Oct): what was fixed, from what failed, in
    // plain words; the turn's own summary stays on the run, and the note
    // links nowhere, as it is on the change's page already.
    await live.postOnProposal({
      pool, ws: deps.ws, app, issueNumber, runId, kind: 'checks_revise', bot, sessionId: session.id,
      text: followup.checksRevisedText({ failing, broken, skipped }),
    }).catch((err) => log.warn('homeroom-bot', 'Checks revision post failed', { app: app.slug, issueNumber, err: err.message }));
    log.info('homeroom-bot', 'Revised its proposal to fix its failing checks', {
      app: app.slug, issueNumber, sessionId: session.id, head, failing: failing.length, skipped: skipped.length, costUsd, runId,
    });
    return { ran: true, verdict: 'revise', runId, acted: 'checks_revise' };
  }

  // #4572: a fix that ran out of time is tried once more before anybody is
  // asked: it used to mark the head looked at and hand over at once, though
  // nothing about the change said a person was needed (PR #4582, change
  // 7490). Its own one retry per head (checksRetryError): the run keeps no
  // `checks_head_sha`, so the head is still due, and a failed run never
  // counts toward MAX_REVISIONS. The second time out hands over as before.
  if (turn.stopped && !await checksRetried(pool, session.id, head)) {
    runId = await insertRun(pool, {
      ...billingOf(item, runMode),
      readReason: readReasonOf(item),
      appId: app.id, issueNumber, mode: runMode, verdict: 'failed',
      reason: 'its attempt to fix them ran out of time', error: checksRetryError(head),
      threadSeenAt, model, durationMs: Date.now() - startedMs,
      proposalSessionId: session.id, ...spent, budgetStop: 'wall clock',
    });
    await recordSnapshot(runId);
    await dropRow();
    await live.postOnProposal({
      pool, ws: deps.ws, app, issueNumber, runId, kind: 'checks_retry', bot, sessionId: session.id,
      text: followup.checksRetryText({ broken: broken.length > 0, failing: failing.length > 0, skipped: skipped.length > 0 }),
    }).catch((err) => log.warn('homeroom-bot', 'Checks retry post failed', { app: app.slug, issueNumber, err: err.message }));
    log.warn('homeroom-bot', 'Fix of its proposal\'s checks ran out of time; trying once more', {
      app: app.slug, issueNumber, sessionId: session.id, head, runId,
    });
    await noteProposalChecks(pool, { sessionId: session.id });
    return { ran: true, verdict: 'failed', runId, acted: 'checks_retry' };
  }

  // The turn could not fix them: one note, and a person takes it from here.
  const turnFailed = !turn.stopped && !code ? live.failedClaudeTurn(result) : null;
  const why = turn.stopped ? 'its attempt to fix them ran out of time'
    : code ? `its attempt to fix them failed (${clip(code, 200)})`
      : turnFailed ? `its attempt to fix them failed (${turnFailed})`
        : parsed?.action === 'person' ? parsed.reply
          : parsed ? 'its attempt to fix them changed nothing'
            : 'its attempt to fix them ended without an answer';
  return handOff({
    why,
    verdict: parsed?.action === 'person' ? 'person' : 'failed',
    extra: { ...spent, ...(turn.stopped ? { budgetStop: 'wall clock' } : {}) },
    // The turn found the failures are not the change's (followup.CAUSES).
    notChange: parsed?.action === 'person' && parsed.cause === 'not_change' && failing.length > 0 && !broken.length,
  });
}

// #4572: the error a timed-out fix records when it is tried once more, one
// per head, so the retry is counted by the head it was for.
function checksRetryError(head) {
  return `checks: ran out of time on ${String(head || '').toLowerCase()}, trying once more`;
}

/** Whether a fix of `head` on proposal `sessionId` already ran out of time once (checksRetryError). */
async function checksRetried(pool, sessionId, head) {
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM homeroom_bot_runs WHERE proposal_session_id = $1 AND error = $2 LIMIT 1',
      [Number(sessionId), checksRetryError(head)],
    );
    return rows.length > 0;
  } catch {
    // A read that fails hands over, as before: never a loop of retries.
    return true;
  }
}

// ── A follow-up after a restart (#4533) ──────────────────────────────────
//
// A follow-up runs on its PROMOTED proposal's session, so restart recovery
// follows its turn through the person's tail (see "After a restart"), which
// moves the proposal on: the push, the votes cleared, staging and checks on
// the new head. What it never did was the bot's part. On PR #4533 (change
// 7428) a checks fix a deploy caught pushed its fix, and the ledger had no
// run for it, no `checks_revise` post and no cost, so MAX_REVISIONS and
// "already looked at this head" (checksDue's `looked`) could not see it.
// Its record now carries the bot's mark (followUpMark, kept by
// runFollowUpTurn with the deadline), and recovery hands the turn's result
// back to the same runChecksFix / runFollowUp that run after a live turn.

// The turn_effects key that keeps recording one recovered follow-up to at
// most once, whatever replays the recovery tail.
const RECOVERED_FOLLOWUP_EFFECT = 'homeroom_bot_followup_outcome';

/**
 * #4533: what a follow-up's turn record keeps for restart recovery
 * (homeroom-bot-followup TURN_MARK; runFollowUpTurn adds the deadline):
 * where it was (app, issue, queue row), what its run is billed and recorded
 * as, and the head it started from. Nothing anybody wrote. Pure.
 */
function followUpMark({
  kind, app, item, runMode, model, startedMs, seedReadAt, session, threadSeenAt = null, extra = {},
}) {
  return {
    followUp: kind,
    appId: Number(app.id), issueNumber: Number(item.issue_number),
    queueId: Number(item.id) || null, reason: item.reason || null,
    payerUserId: Number(item.payer_user_id) || null, changedBy: item.changed_by || null,
    runMode, model: model || null,
    startedAt: new Date(startedMs || Date.now()).toISOString(),
    seedReadAt: seedReadAt || null, threadSeenAt: threadSeenAt || null,
    reviewedHeadSha: session?.reviewed_head_sha || null,
    ...extra,
  };
}

/** What one logical turn cost, from its attempts' own ledger rows (agent_turns). Never throws. */
async function ledgerSpendOfTurn(pool, activeTurn) {
  const none = { costUsd: null, inputTokens: null, outputTokens: null };
  const id = activeTurn?.logicalTurnId || activeTurn?.turnId || null;
  if (!id) return none;
  try {
    const { rows: [row] = [] } = await pool.query(
      `SELECT SUM(estimated_cost_usd)::float8 AS cost, SUM(input_tokens)::float8 AS input_tokens,
              SUM(output_tokens)::float8 AS output_tokens
         FROM agent_turns WHERE logical_turn_id = $1::uuid`,
      [String(id)],
    );
    const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    return { costUsd: num(row?.cost), inputTokens: num(row?.input_tokens), outputTokens: num(row?.output_tokens) };
  } catch {
    return none;
  }
}

/**
 * #4533: a follow-up of the bot's (a checks fix, or its answer to replies)
 * that restart recovery followed to its end, recorded as the follow-up
 * records one: `result` is what the journal replay returned, `timedOut`
 * that the bot's clock, re-armed from the deadline on its mark, ended it.
 * The run goes in the ledger with its verdict, the failing head it looked
 * at and what it cost; the bot says what it did where it would have; the
 * follow-up's wait is cleared. Called by server.js once the person's tail
 * has moved the proposal on, which therefore is not done again. At most
 * once per turn (turn_effects). Resolves what it did; never throws.
 */
async function finishRecoveredFollowUp({
  pool, config = {}, session, activeTurn, result = {}, timedOut = false, deps = {},
}) {
  const mark = followup.turnMarkOf(activeTurn);
  const turnId = require('./turn-lifecycle').turnIdentity(activeTurn);
  if (!mark || !session || !turnId) return null;
  const turnEffects = deps.turnEffects || require('./turn-effects');
  try {
    const claim = await turnEffects.claimExternalEffect({
      pool, turnId, effectKey: RECOVERED_FOLLOWUP_EFFECT, sessionId: session.id,
    });
    if (!claim.claimed) return 'already_recorded';
    const { rows: [app] = [] } = await pool.query(
      'SELECT id, slug, name, repo_url, self_hosted FROM apps WHERE id = $1', [Number(mark.appId)],
    );
    const repo = app ? parseRepo(app.repo_url) : null;
    let out = null;
    if (repo) {
      const issueNumber = Number(mark.issueNumber);
      const github = deps.github || require('./github');
      const fetched = await github.fetchPublicIssue(repo.owner, repo.repo, issueNumber).catch(() => null);
      // What the turn cost is its own attempts' (the journal replay settled
      // them before this runs), debited by the run as a live turn's is.
      const spend = await ledgerSpendOfTurn(pool, activeTurn);
      const turnResult = {
        ...(result || {}),
        inputTokens: Number.isFinite(result?.inputTokens) ? result.inputTokens : spend.inputTokens,
        outputTokens: Number.isFinite(result?.outputTokens) ? result.outputTokens : spend.outputTokens,
      };
      // The clock re-armed past a deadline fires at once, even for a turn
      // that had finished before the restart: one whose journal ended on its
      // own exit 0, before the stop's 143, did its work in time.
      const stopped = !!timedOut && Number(result?.exitCode) !== 0;
      const recovered = {
        mark, mode: activeTurn.mode === 'scout' ? 'scout' : 'build',
        turn: { routed: { result: turnResult }, result: turnResult, stopped, costUsd: spend.costUsd, pricing: null },
      };
      const item = {
        id: mark.queueId, app_id: app.id, issue_number: issueNumber, reason: mark.reason,
        thread_seen_at: mark.threadSeenAt, payer_user_id: mark.payerUserId, changed_by: mark.changedBy,
      };
      const startedMs = toMs(mark.startedAt) || toMs(activeTurn.startedAt) || Date.now();
      // A turn that failed is a failed run, and its queue row is spent, as
      // runTriage's recordFailure records a model failure.
      const recordFailure = async (error, extra = {}) => {
        const runId = await insertRun(pool, {
          ...billingOf(item, mark.runMode), readReason: readReasonOf(item),
          appId: app.id, issueNumber, mode: mark.runMode, verdict: 'failed', error,
          threadSeenAt: mark.threadSeenAt || null, model: mark.model, durationMs: Date.now() - startedMs, ...extra,
        });
        await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
        return { ran: true, verdict: 'failed', runId };
      };
      const runDeps = {
        github,
        threadContext: deps.threadContext || require('./thread-context'),
        sessions: deps.sessions || null,
        limits: deps.limits || require('./limits'),
        managedOpenRouter: deps.managedOpenRouter || require('./openrouter-managed-keys'),
        agentTurn: deps.agentTurn || require('./agent-turn'),
        votes: deps.votes || null, dm: deps.dm || null, notifications: deps.notifications || null,
        ...liveDeps(deps),
      };
      const common = {
        bot: { id: session.user_id, username: BOT_USERNAME }, app, repo, item, issue: fetched?.issue || null,
        runMode: mark.runMode, model: mark.model, turnBudgetMs: 0, startedMs, recordFailure, deps: runDeps, recovered,
      };
      if (mark.followUp === 'checks_fix') {
        const { rows: [row] = [] } = await pool.query(
          `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url, a.self_hosted AS app_self_hosted
             FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
          [session.id],
        );
        const c = mark.checks || {};
        out = row ? await runChecksFix(pool, config, {
          ...common,
          // Whether it moved the head is read against the head it started
          // from: the person's recovery tail has made its push the reviewed
          // head since.
          session: { ...row, reviewed_head_sha: mark.reviewedHeadSha || null },
          checks: {
            head: c.head || null, total: Number(c.total) || 0,
            // How many failed is all that is said again; the turn read why.
            failing: Array.from({ length: Math.max(0, Number(c.failing) || 0) }, () => ({})),
            broken: Array.isArray(c.broken) ? c.broken : [],
            skipped: Array.isArray(c.skipped) ? c.skipped : [],
          },
          canRevise: true, mode: recovered.mode, lastRun: null, seedReadAt: mark.seedReadAt || null,
          comments: [], issueThread: null, proposalThread: null, botLogin: await live.botUsernameOf(github),
        }) : { ran: false, reason: 'gone' };
      } else {
        out = await runFollowUp(pool, config, { ...common, proposal: { id: session.id } });
      }
    }
    // What it waited on is over: a row still queued for it is read on the
    // next pass, not after the rest of a backoff.
    clearFollowUpRefusals(mark.appId, mark.issueNumber);
    await pool.query(
      'UPDATE homeroom_bot_queue SET wait_reason = NULL, wait_until = NULL WHERE app_id = $1 AND issue_number = $2',
      [Number(mark.appId), Number(mark.issueNumber)],
    ).catch(() => {});
    const outcome = out?.acted || out?.verdict || out?.reason || 'gone';
    await turnEffects.completeExternalEffect({
      pool, turnId, effectKey: RECOVERED_FOLLOWUP_EFFECT, result: { outcome, runId: out?.runId || null },
    }).catch(() => {});
    log.info('homeroom-bot', 'Recorded a follow-up a restart interrupted', {
      sessionId: session.id, appId: mark.appId, issueNumber: mark.issueNumber, kind: mark.followUp,
      outcome, runId: out?.runId || null, timedOut: !!timedOut, exitCode: result?.exitCode ?? null,
    });
    return outcome;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not record a follow-up a restart interrupted', {
      sessionId: session.id, kind: mark.followUp, err: err.message,
    });
    return 'error';
  }
}

/**
 * #3146: what a live verdict does. Posts to the issue, builds and proposes
 * a ready request, then records what the bot has seen so its own comments
 * are not read back as a change. A verdict the live caps hold back posts
 * one line saying so (#3152), and only when that same line is not already
 * the bot's newest post there: a held issue is retried whenever its cap has
 * room, and a retry that is held again has nothing new to say.
 */
/**
 * How the live path speaks on an issue: a post on GitHub and the issue's
 * thread. Whoever filed the issue, and whoever took part in its discussion,
 * are tagged on the posts that concern them, so they are notified
 * (live.mentionTargets), except anybody who asked the bot to stop. Looked up
 * once, when the first such post goes out, and read fresh on each run.
 * `postedAt` collects what was posted, so it is not read back as a change.
 */
function liveSayer({
  pool, github, ws, app, repo, issueNumber, issue, runId, bot, botLogin = null, notifications = null, postedAt = [],
}) {
  let targets;
  const targetsOnce = async () => {
    if (targets === undefined) {
      targets = await live.mentionTargets({ pool, github, app, repo, issueNumber, issue, botLogin, bot })
        .catch((err) => {
          log.warn('homeroom-bot', 'Could not work out who to tag', { app: app.slug, issueNumber, err: err.message });
          return [];
        });
    }
    return targets;
  };
  return async (kind, text, extra = {}) => {
    const mentions = live.tagsPoster(kind) ? await targetsOnce() : [];
    const posted = await live.post({
      pool, github, ws, app, repo, issueNumber, kind, runId, text, mentions, senderId: bot.id, sender: bot,
      notifications, ...extra,
    });
    if (posted?.githubCreatedAt) postedAt.push(posted.githubCreatedAt);
    return posted;
  };
}

/**
 * A build turn that changed nothing, kept on its run the moment it ends,
 * before its nudge starts (homeroom-bot-live.js buildAndPropose's
 * onNoChange), so the run says what the first turn said while the nudge
 * runs. The outcome's own record replaces it.
 */
async function keepNoChange(pool, runId, noChange) {
  if (!runId || !noChange) return;
  await pool.query(
    'UPDATE homeroom_bot_runs SET build_no_change = $2::jsonb WHERE id = $1',
    [runId, JSON.stringify(noChange)],
  ).catch((err) => log.warn('homeroom-bot', 'Could not keep a build turn that changed nothing on its run', { runId, err: err.message }));
}

/**
 * Whether a live first version's build that did not become a proposal is
 * one to try once more on its own: it failed (not stopped as a skip, found
 * impossible, another build's, or built and only not proposed) and it has
 * the plan to build from. Pure.
 */
function autoRetryable(built) {
  if (!built || built.ok || built.skipped || built.blocked || built.lostClaim || built.notProposed) return false;
  // Its project's setup failed (15 Oct 2026): another try would stop the same way.
  if (built.setupFailed) return false;
  if (built.partial) return false;
  return typeof built.specMd === 'string' && built.specMd.trim().length > 0;
}

/**
 * Claim a first version's one automatic retry: its run gives up the failed
 * session's link and waits again, with the plan kept, so a restart before
 * the retry links its own session builds it from the lane (buildOne's
 * presetSpec). Only once per first version: no run of the request has been
 * retried before. Resolves whether it was claimed; never throws.
 */
async function claimAutoRetry(pool, { runId, appId, issueNumber, built }) {
  try {
    const { rows } = await pool.query(
      `UPDATE homeroom_bot_runs r
          SET build_retry = jsonb_build_object('at', NOW(), 'error', $4::text, 'session_id', $3::int),
              build_session_id = NULL, live_build_waiting_at = NOW(),
              build_spec_md = COALESCE(r.build_spec_md, $5)
        WHERE r.id = $1 AND r.build_retry IS NULL AND r.build_ok IS NULL AND r.proposal_session_id IS NULL
          AND r.build_session_id IS NOT DISTINCT FROM $3::int
          AND NOT EXISTS (
            SELECT 1 FROM homeroom_bot_runs o
             WHERE o.app_id = $2 AND o.issue_number = r.issue_number AND o.build_retry IS NOT NULL
          )
          AND r.issue_number = $6
        RETURNING r.id`,
      [runId, appId, built.sessionId || null, clip(built.error || 'unknown', MAX_ERROR_CHARS), built.specMd, issueNumber],
    );
    return rows.length > 0;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not claim a first version\'s retry; it ends as it is', { runId, err: err.message });
    return false;
  }
}

/**
 * What a live build came to, recorded on its run in the columns a shadow
 * build fills (#3509): before this it was only said on the issue, so an
 * export could not tell a build that failed from one found impossible, nor
 * say why a proposal had no spec. build_at and build_queued_at stay NULL:
 * those are the lane's, and a live build never went through it. A spec
 * that failed is noted beside a build that went ahead, as a shadow
 * build's is (#3396). A run whose proposal is another build's keeps that
 * build's record: a second build of run 1267 that stopped after the first
 * was up for a vote wrote "failed" and its own branch over it. Never throws.
 */
async function recordLiveBuild(pool, runId, built, model = null) {
  if (!runId || !built) return;
  // A build that finished from a failed turn's work (buildAndPropose's
  // keepPartial), and a first version tried once more (buildLive), say so
  // beside what came of it.
  // 15 Oct 2026: and one its maker's Try again proposed after it was built
  // and could not be (finishBuiltFirstVersion), with why it could not.
  const notes = [
    built.partial ? `finished from partial work (${built.partial.reason})` : null,
    built.retried ? `tried once more after: ${built.retried.error || 'unknown'}` : null,
    built.finished ? `proposed on its maker's Try again after: ${built.finished.error || 'unknown'}` : null,
    built.specNote,
  ].filter(Boolean);
  const error = built.ok
    ? (notes.length ? clip(notes.join('; '), MAX_ERROR_CHARS) : null)
    : clip([
      built.blocked ? `blocked: ${built.blocked}` : (built.error || 'unknown'),
      ...notes,
    ].filter(Boolean).join('; '), MAX_ERROR_CHARS);
  await pool.query(
    `UPDATE homeroom_bot_runs
        SET build_ok = $2, build_error = $3,
            build_branch = COALESCE($4, build_branch), build_sha = COALESCE($5, build_sha),
            build_commits = COALESCE($6, build_commits), build_cost_usd = COALESCE($7, build_cost_usd),
            build_session_id = COALESCE(build_session_id, $8), build_spec_md = COALESCE($9, build_spec_md),
            build_model = COALESCE($10, build_model), build_no_change = COALESCE($11::jsonb, build_no_change)
      WHERE id = $1 AND (proposal_session_id IS NULL OR proposal_session_id = $8)`,
    [runId, !!built.ok, error, built.branchName || null, built.sha || null,
      Number.isFinite(built.commits) ? built.commits : null,
      Number.isFinite(built.costUsd) ? built.costUsd : null,
      built.sessionId || null, built.specMd || null, model || built.model || null,
      // A build turn that changed nothing: what it said and did, and its
      // nudge (homeroom-bot-live.js buildNudgePrompt).
      built.noChange ? JSON.stringify(built.noChange) : null],
  ).catch((err) => log.warn('homeroom-bot', 'Could not record the live build on its run', { runId, err: err.message }));
}

/**
 * What a live build came to, said on its issue: the proposal (and the spec
 * on it, where the group votes), the request found impossible, or the build
 * that did not become a proposal. Shared by the live path and the recovery
 * of a live build a restart interrupted (#3471). `firstVersion`: the
 * project's first version, whose stop is said without approval (14 Oct
 * 2026, live.buildFailedText). Returns what was done.
 */
async function announceBuilt({ pool, ws, app, bot, issueNumber, runId, built, say, domain, firstVersion = false }) {
  await recordLiveBuild(pool, runId, built, built.model || null);
  if (built.ok) {
    // The run's first proposal stays its proposal (recordLiveBuild).
    await pool.query(
      'UPDATE homeroom_bot_runs SET proposal_session_id = $2 WHERE id = $1 AND proposal_session_id IS NULL',
      [runId, built.sessionId],
    ).catch(() => {});
    // The vote-card metadata the promote route's own activity rows carry,
    // so the issue's thread shows the live proposal card, not only a link.
    // Said once per run: a restart after it was said, before the run was
    // recorded, finishes the build without saying it again.
    if (await runPosted(pool, runId, 'proposal')) {
      log.info('homeroom-bot', 'The proposal was said before a restart; not saying it again', { app: app.slug, issueNumber, runId });
      return 'proposed';
    }
    const link = live.proposalLink(domain, app.slug, built.sessionId, built.prNumber);
    // Homeroom names the change by its title, over its vote card; GitHub links it.
    const { rows: [named] = [] } = await pool.query(
      `SELECT COALESCE(NULLIF(pr_title, ''), NULLIF(proposed_pr_title, ''), NULLIF(session_title, '')) AS title
         FROM chat_sessions WHERE id = $1`,
      [built.sessionId],
    ).catch(() => ({ rows: [] }));
    await say('proposal', live.proposalText({ link }), {
      homeroomText: live.proposalHomeroomText({ title: named?.title || null }),
      msgType: 'vote', metadata: { vote: { sessionId: built.sessionId, prNumber: built.prNumber } },
      dm: { link, prNumber: built.prNumber, sessionId: built.sessionId },
    });
    // And the spec on the proposal itself, where the group votes.
    if (built.specMd && built.specVersion) {
      await live.postSpecOnProposal({
        pool, ws, app, bot, sessionId: built.sessionId, version: built.specVersion, spec: built.specMd,
      }).catch((err) => log.warn('homeroom-bot', 'Could not post the spec on the proposal', {
        app: app.slug, issueNumber, sessionId: built.sessionId, err: err.message,
      }));
    }
    return 'proposed';
  }
  if (built.blocked) {
    // Impossible as written, which only reading the code showed: said on
    // the issue like a question, so a reply sends it round again.
    if (!await runPosted(pool, runId, 'blocked')) {
      await say('blocked', live.blockedText(built.blocked), { dm: { reason: built.blocked } });
    }
    return 'blocked';
  }
  log.warn('homeroom-bot', 'Live build did not become a proposal', {
    app: app.slug, issueNumber, sessionId: built.sessionId || null, error: built.error,
  });
  // Said once per run, whatever brought the build here again.
  if (!await runPosted(pool, runId, 'build_failed')) {
    await say('build_failed', live.buildFailedText(built.error, { firstVersion }), { dm: { reason: built.error } });
  }
  return 'build_failed';
}

// ── Try again finishes a first version that was built (15 Oct 2026) ─────
//
// A first version built to the end whose proposal was refused stops "built
// but could not be proposed": its session paused, its branch pushed
// (homeroom-bot-live.js buildAndPropose; promoteOwnBuild throws a refusal it
// can wait out back to the build, #5162, so this is one it could not). Its
// maker read "Tap Try again" (#5170), and Try again started over: the tap
// reached the bot's chat model, which put the request first in the queue
// (homeroom-bot-mayor.js start_request), so it was read again, planned again
// for Build it, and built again in a new session, tens of minutes paid from
// the maker's allowance, with the built session left behind; and
// claimAutoRetry leaves such a build alone on purpose. Now the tap is
// decided without the model (homeroom-bot-dm.js finishOnTryAgain): the
// session the build left is proposed exactly as the build proposes one
// (promoteOwnBuild: as the bot, past the drain guard with OWN_WORK, under its
// ceiling), the run records it as its proposal and says so (announceBuilt),
// and from there it is any proposed first version: tested, ready to try, live
// without a vote. Whatever would make that unsafe (any other stop, a newer
// look at the request, its session or branch gone or moved, the request
// closed or answered) leaves the tap to the model, which starts it over.

// A claim this old with no outcome is a process that died holding it: the
// promote route itself refuses a session already up, so taking it again
// cannot propose twice.
const FINISH_STALE_MINUTES = 10;

/**
 * The run Try again would finish, with what deciding it reads: its build
 * session; the request's newest run; the fields progress.firstVersionStopped
 * reads, as homeroom-bot-progress.js requestRows reads them (the request's
 * newest proposal's state, whether the request is closed); whether it is in
 * the queue (a start over asked for already); its project; and the maker of
 * the project's first version when this request is it. Null when no run.
 */
async function finishableRun(pool, runId) {
  const { rows: [run] = [] } = await pool.query(
    `SELECT r.id, r.app_id, r.issue_number, r.mode, r.verdict, r.build_ok, r.build_error,
            r.build_session_id, r.build_branch, r.build_sha, r.build_commits, r.build_spec_md,
            r.proposal_session_id, r.build_finish,
            COALESCE((r.build_finish->>'at')::timestamptz < NOW() - make_interval(mins => $2), FALSE) AS finish_stale,
            (SELECT n.id FROM homeroom_bot_runs n
              WHERE n.app_id = r.app_id AND n.issue_number = r.issue_number
              ORDER BY n.id DESC LIMIT 1) AS newest_run_id,
            bs.status AS session_status, bs.user_id AS session_user_id, bs.branch_name AS session_branch,
            bs.is_headless AS session_headless,
            ps.status AS own_proposal_status,
            (SELECT CASE WHEN cs.status = 'merged' AND cs.live_at IS NULL THEN 'merging' ELSE cs.status END
               FROM homeroom_bot_runs p JOIN chat_sessions cs ON cs.id = p.proposal_session_id
              WHERE p.app_id = r.app_id AND p.issue_number = r.issue_number
              ORDER BY p.id DESC LIMIT 1) AS proposal_status,
            (SELECT ri.status = 'closed' FROM issues ri
              WHERE ri.app_id = r.app_id AND ri.github_issue_number = r.issue_number
              ORDER BY ri.id DESC LIMIT 1) AS request_closed,
            EXISTS (SELECT 1 FROM homeroom_bot_queue q
                     WHERE q.app_id = r.app_id AND q.issue_number = r.issue_number) AS queued,
            f.user_id AS maker_id,
            a.slug, a.name, a.repo_url
       FROM homeroom_bot_runs r
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN chat_sessions bs ON bs.id = r.build_session_id
       LEFT JOIN chat_sessions ps ON ps.id = r.proposal_session_id
       LEFT JOIN homeroom_bot_first_versions f
         ON f.app_id = r.app_id AND f.issue_number = r.issue_number AND f.bot_builds = TRUE AND f.status = 'filed'
      WHERE r.id = $1`,
    [Number(runId), FINISH_STALE_MINUTES],
  );
  return run || null;
}

/**
 * Pure (15 Oct 2026): why Try again from `userId` cannot finish `run`
 * (finishableRun) from what was built, or null when it can: the newest look
 * at the first version of `userId`'s own project, stopped as its screens say
 * (progress.firstVersionStopped) because it was built and only not proposed,
 * nothing else under way for it (no queue row: a start over is asked for
 * already), and its session still the bot's, paused, on the branch the build
 * pushed. The branch's head on GitHub is checked after this.
 */
function whyNotFinish(run, { userId, botId }) {
  if (!run) return 'no_run';
  if (!run.maker_id || Number(run.maker_id) !== Number(userId)) return 'not_their_first_version';
  if (Number(run.newest_run_id) !== Number(run.id)) return 'not_newest';
  if (!require('./homeroom-bot-progress').firstVersionStopped(run)) return 'not_stopped';
  if (require('./homeroom-bot-dm').buildFailedCause(run.build_error).cause !== 'unproposed') return 'not_unproposed';
  if (run.proposal_session_id) return 'proposed';
  if (run.queued) return 'queued';
  if (!run.build_session_id || run.session_status !== 'paused') return 'session_gone';
  if (Number(run.session_user_id) !== Number(botId) || run.session_headless === true) return 'not_the_bots';
  if (!run.session_branch || (run.build_branch && run.build_branch !== run.session_branch)) return 'branch_moved';
  return null;
}

/**
 * 15 Oct 2026: Try again from `user` under their first version that was
 * built and could not be proposed (homeroom-bot-dm.js finishOnTryAgain): the
 * session its build left proposed, and the run on its way as any proposed
 * first version is. `onProposed(app)` is called once it is proposed, before
 * the run says so. Resolves
 *   { ok: true, sessionId, prNumber, app }  proposed now;
 *   { ok: true, already: true, app }        another tap has it, or it is up;
 *   { ok: false, why, app }                 not proposed: the caller starts
 *                                           it over, as Try again did before.
 * Claimed once per run (build_finish), so a double tap proposes once. Never
 * throws, and never answers ok: false once it has proposed.
 */
async function finishBuiltFirstVersion(pool, config, { runId, user, bot, deps = {}, onProposed = null }) {
  let run;
  let app = null;
  try {
    run = await finishableRun(pool, runId);
    if (!run || !user?.id || !bot?.id) return { ok: false, why: 'no_run', app };
    app = { id: Number(run.app_id), slug: run.slug, name: run.name, repo_url: run.repo_url };
    const mine = run.maker_id && Number(run.maker_id) === Number(user.id);
    // Up already (this run's proposal, a tap's or its build's own), or
    // another tap is proposing it now: nothing more is proposed.
    if (mine && run.proposal_session_id && ['promoted', 'merging'].includes(run.own_proposal_status)) {
      return { ok: true, already: true, app };
    }
    const finish = run.build_finish && typeof run.build_finish === 'object' ? run.build_finish : null;
    if (mine && finish && !finish.outcome && !run.finish_stale) return { ok: true, already: true, app };
    // Proposed by a tap, and not recorded on the run yet (proposeFinished
    // says so under that tap first): up, as long as its session is.
    if (mine && finish?.outcome === 'proposed' && ['promoted', 'merging'].includes(run.session_status)) {
      return { ok: true, already: true, app };
    }
    // Tried once and refused: what follows is the start over.
    if (finish?.outcome === 'failed') return { ok: false, why: 'finish_failed', app };
    // A claim whose process died after it proposed and before the run said
    // so: its session is up, and is recorded and said now (proposeFinished
    // reads it back, proposedAlready), with nothing checked again.
    const recovering = !!(mine && finish && !finish.outcome && run.finish_stale && !run.proposal_session_id
      && Number(finish.session_id) === Number(run.build_session_id)
      && ['promoted', 'merging'].includes(run.session_status));
    if (!recovering) {
      const why = whyNotFinish(run, { userId: user.id, botId: bot.id });
      if (why) return { ok: false, why, app };
      const settings = await readSettings(pool);
      if (!live.isLiveFor(settings, app)) return { ok: false, why: 'not_live', app };
      const repo = parseRepo(run.repo_url);
      const github = deps.github || require('./github');
      if (!repo || typeof github.isEnabled !== 'function' || !github.isEnabled()) return { ok: false, why: 'no_github', app };
      // What the build pushed is still there, as it was: a branch deleted, or
      // moved by somebody since, is not what was built.
      const head = await Promise.resolve()
        .then(() => github.getBranchSha(repo.owner, repo.repo, run.session_branch))
        .catch((err) => {
          log.info('homeroom-bot', 'Try again: the built branch could not be read', { runId: run.id, err: err.message });
          return null;
        });
      if (!head) return { ok: false, why: 'branch_gone', app };
      if (run.build_sha && String(head).toLowerCase() !== String(run.build_sha).toLowerCase()) {
        return { ok: false, why: 'branch_moved', app };
      }
      // The backstop every proposal of the bot's meets (whyNotBuild): another
      // proposal of the request, another build of it under way, or its issue
      // closed on GitHub.
      const skip = await whyNotBuild(pool, {
        runId: run.id, botId: bot.id, appId: app.id, issueNumber: Number(run.issue_number), github, repo,
      });
      if (skip) return { ok: false, why: 'skip', detail: skip, app };
    }
    const { rows: claimed } = await pool.query(
      `UPDATE homeroom_bot_runs
          SET build_finish = jsonb_build_object('at', NOW(), 'by', $2::int, 'session_id', $3::int)
        WHERE id = $1 AND build_ok = FALSE AND proposal_session_id IS NULL AND build_session_id = $3
          AND (build_finish IS NULL
               OR (build_finish->>'outcome' IS NULL
                   AND (build_finish->>'at')::timestamptz < NOW() - make_interval(mins => $4)))
        RETURNING id`,
      [run.id, Number(user.id), Number(run.build_session_id), FINISH_STALE_MINUTES],
    );
    if (!claimed.length) return { ok: true, already: true, app };
  } catch (err) {
    log.warn('homeroom-bot', 'Try again could not read a first version it built; it starts over', { runId, err: err.message });
    return { ok: false, why: 'error', app };
  }
  return proposeFinished(pool, config, { run, app, user, bot, deps, onProposed });
}

/**
 * finishBuiltFirstVersion once its claim is taken: propose, then record and
 * say it as the build would have. A refusal gives the claim its outcome and
 * answers ok: false; from the proposal on, nothing answers ok: false.
 */
async function proposeFinished(pool, config, { run, app, user, bot, deps, onProposed }) {
  const sessionId = Number(run.build_session_id);
  const issueNumber = Number(run.issue_number);
  const settle = (outcome) => pool.query(
    'UPDATE homeroom_bot_runs SET build_finish = build_finish || jsonb_build_object(\'outcome\', $2::text) WHERE id = $1',
    [run.id, outcome],
  ).catch((err) => log.warn('homeroom-bot', 'Could not record what Try again came to', { runId: run.id, outcome, err: err.message }));
  const since = new Date().toISOString();
  let promoted;
  try {
    const settings = await readSettings(pool);
    promoted = await live.proposedAlready(pool, sessionId) || await live.promoteOwnBuild({
      pool, steps: durableSteps.none(), ...(Array.isArray(deps.proposeRetryMs) ? { waits: deps.proposeRetryMs } : {}),
      config, bot, sessionId, router: deps.votesRouter || null, ceiling: botProposalCeiling(settings),
    });
  } catch (err) {
    promoted = { status: 500, body: { error: err.message } };
  }
  if (promoted?.status !== 200 || !promoted.body?.ok) {
    const why = promoted?.body?.error || promoted?.body?.message || `promotion answered ${promoted?.status}`;
    await settle('failed');
    log.warn('homeroom-bot', 'Try again could not propose a first version it built; it starts over', {
      app: app.slug, issueNumber, runId: run.id, sessionId, why,
    });
    return { ok: false, why: 'refused', detail: why, app };
  }
  const prNumber = promoted.body.prNumber ?? null;
  await settle('proposed');
  log.info('homeroom-bot', 'Try again proposed a first version it had built', {
    app: app.slug, issueNumber, runId: run.id, sessionId, prNumber, userId: user.id,
  });
  void timeline.recordStep(pool, { runId: run.id, step: 'proposed', sessionId, detail: prNumber ? { prNumber: Number(prNumber) } : null });
  if (typeof onProposed === 'function') {
    try { await onProposed(app); } catch (err) {
      log.warn('homeroom-bot', 'Could not say a first version is being finished', { runId: run.id, err: err.message });
    }
  }
  // Recorded and said as the build says a proposal: the run's proposal, its
  // card on the request and in its maker's chat (built and being tested,
  // then ready to try), the plan on the proposal, and what the bot has seen.
  try {
    const github = deps.github || require('./github');
    const ws = deps.ws || require('./ws');
    const repo = parseRepo(run.repo_url);
    const postedAt = [];
    const botLogin = await live.botUsernameOf(github);
    const say = liveSayer({
      pool, github, ws, app, repo, issueNumber, issue: null, runId: run.id, bot, botLogin,
      notifications: deps.notifications || null, postedAt,
    });
    const { rows: [spec] = [] } = await pool.query(
      'SELECT version FROM chat_session_specs WHERE session_id = $1 ORDER BY version DESC LIMIT 1', [sessionId],
    ).catch(() => ({ rows: [] }));
    await announceBuilt({
      pool, ws, app, bot, issueNumber, runId: run.id, say, domain: deps.domain || require('./caddy').USERNODE_DOMAIN,
      firstVersion: true,
      built: {
        ok: true, sessionId, prNumber, branchName: run.session_branch, sha: run.build_sha || null,
        commits: run.build_commits == null ? undefined : Number(run.build_commits),
        specMd: run.build_spec_md || null, specVersion: spec?.version ?? null,
        finished: { error: run.build_error },
      },
    });
    await live.advanceSeen({
      pool, github, threadContext: deps.threadContext || require('./thread-context'), app, repo, issueNumber,
      runId: run.id, since, postedAt,
    }).catch((err) => log.warn('homeroom-bot', 'Could not record what the bot has seen', { err: err.message }));
  } catch (err) {
    log.warn('homeroom-bot', 'Try again proposed a first version, but could not say so', { runId: run.id, sessionId, err: err.message });
  }
  return { ok: true, sessionId, prNumber, app };
}

async function actOnVerdict({
  pool, config, bot, app, repo, issueNumber, issue, parsed, capSuppressed, runId,
  seed, seedReadAt, postedAt, turnBudgetMs, model, specModel = null, botLogin = null, quietHold = false,
  proposalCeiling = PROPOSALS_PER_APP_CAP, firstVersion = false, relook = false, askedLook = false, comments = [],
  decider = null, deps,
}) {
  const { github, ws } = deps;
  const say = liveSayer({
    pool, github, ws, app, repo, issueNumber, issue, runId, bot, botLogin,
    notifications: deps.notifications || null, postedAt,
  });
  let acted = capSuppressed ? 'held' : parsed.verdict;
  // #4530: a look the request's own changes started (a 'changed' or
  // 'read_again' reason) repeats one of the note verdicts only when somebody
  // has addressed the bot since its last note: mentioned it, replied to one
  // of its messages, or answered a question it asked. People working
  // something out among themselves are not for it. Fails open, and never
  // holds a ready verdict or a note a cap is already quiet about. A look
  // somebody asked for (`askedLook`) is held exactly when the button that
  // asks is refused (waitingOnly, homeroom-bot-addressed.js waitingOn): only
  // while the bot's last word there is itself one of those notes (after a
  // failed build or a held verdict, asking is what brings it back), and an
  // edit of the request since counts as news.
  // With the bot's voice on in requests' discussions, a mention or a reply
  // there is the voice's to answer (homeroom-bot-voice.js), not a reason to
  // say the note again.
  const voiceAnswers = (relook || askedLook) && voiceModule(deps).voiceOn(await readSettings(pool).catch(() => null), { type: 'issue' });
  const gate = (relook || askedLook) && !capSuppressed && addressedMod().NOTE_KINDS.includes(parsed.verdict)
    ? await addressedMod().shouldSpeak(pool, {
      appId: app.id, issueNumber, botId: bot.id, comments, botLogin, waitingOnly: !relook, updatedAt: issue?.updatedAt || null,
      voiceAnswers,
    })
    : { speak: true };
  if (!gate.speak) {
    log.info('homeroom-bot', 'Live note not repeated: nobody addressed the bot', {
      app: app.slug, issueNumber, verdict: parsed.verdict,
    });
    acted = 'unaddressed';
    // A note about Homeroom itself held so offers no move: the run says why.
    if (parsed.verdict === 'person' && parsed.platform) {
      await require('./homeroom-bot-move').noteMoveOffer(pool, runId, 'repeat_held');
    }
  } else if (capSuppressed) {
    const kind = live.heldKind(capSuppressed);
    const already = await live.lastPostKind(pool, app.id, issueNumber) === kind;
    log.info('homeroom-bot', 'Live verdict held by a cap', {
      app: app.slug, issueNumber, verdict: parsed.verdict, cap: capSuppressed, noted: !already && !quietHold,
    });
    if (!already && !quietHold) {
      const limit = capSuppressed === 'proposals_per_app' ? PROPOSALS_PER_APP_CAP
        : capSuppressed === 'proposals_total' ? proposalCeiling : QUESTION_TRIPWIRE_PER_DAY;
      // A build a proposal cap holds is a quiet line in the request's thread
      // (homeroom-bot-dm.js dmText) and its card says Waiting. A question
      // the daily tripwire holds is not: there is nothing to tell them yet.
      const toDm = capSuppressed === 'proposals_per_app' || capSuppressed === 'proposals_total';
      await say(kind, live.heldText({
        cap: capSuppressed, verdict: parsed.verdict === 'ready' && parsed.complicated ? 'plan' : parsed.verdict, limit,
        project: app.name || app.slug,
      }), toDm ? { dm: { limit } } : undefined);
    }
  } else if (parsed.verdict === 'question') {
    // #3624: `dm` carries the question to the requester's DM too, with the
    // answers they can tap (homeroom-bot-dm.js).
    await say('question', live.questionText(parsed), {
      dm: {
        question: parsed.question, answers: parsed.questionAnswers || [],
        // B6: a read that asks two questions asks both at once.
        ...(parsed.plan?.questions?.length > 1 ? { questions: parsed.plan.questions } : {}),
      },
    });
  } else if (parsed.verdict === 'person') {
    // #4239: about Homeroom itself, the requester's DM offers to move it to
    // Homeroom's own board (homeroom-bot-dm.js relayIssuePost). A requester
    // who does not decide on the project is told who does, rather than
    // offered a Go ahead that would only read it again (whoDecides).
    const deciders = decider && !decider.requesterDecides && Array.isArray(decider.deciders)
      ? decider.deciders.map((d) => d?.username).filter(Boolean)
      : [];
    // Homeroom's copy names who can say Go ahead: the people who decide, or
    // the person who asked for it.
    const asker = deciders.length || parsed.platform ? null
      : await require('./homeroom-bot-dm').requesterOf(pool, app.id, issueNumber).catch(() => null);
    const project = app.name || app.slug;
    await say('person', live.personText({ ...parsed, project }), {
      homeroomText: live.personHomeroomText({ ...parsed, project, requester: asker?.username || null, deciders }),
      dm: {
        reason: parsed.reason, ...(parsed.platform ? { platform: true } : {}), ...(deciders.length ? { deciders } : {}),
        ...(parsed.done ? { done: true } : {}),
      },
    });
  } else if (parsed.verdict === 'empty') {
    await say('empty', live.emptyText(parsed), { dm: { reason: parsed.reason, ...(parsed.done ? { done: true } : {}) } });
  } else if (parsed.verdict === 'ready') {
    // B6: a first version waits for its creator's Build it, under the plan
    // they are sent first. #4175: it is never built without it. A plan that
    // could not reach them waits and is sent again (retryUnsentPlans); one
    // with nobody to send it to stops (awaitGo).
    // #4210: a first version its creator already said Build it to, that a
    // restart sent back to be read again, is not asked again: it is built
    // from what they approved.
    if (firstVersion && await carryApprovedPlan(pool, { runId, appId: app.id, issueNumber })) {
      await queueLiveBuild(pool, { runId, appId: app.id });
      acted = 'build_queued';
    } else if (firstVersion) {
      acted = PLAN_ACTED[await awaitGo(pool, { runId, app, issueNumber, parsed, bot, deps })];
    } else if (parsed.complicated) {
      // #4488: a complicated change's spec is drafted first, in the build's
      // own slot (buildLive planBeforeBuilding), and shown to its requester
      // with Build it and Change something. Nothing is built until they
      // say Build it.
      await queueLiveBuild(pool, { runId, appId: app.id });
      acted = 'plan_queued';
    } else {
      // Built after this turn, in a slot of its own (buildLive, started by
      // the lane), not inside it: the build held the project's one slot for
      // the whole of its run (up to 50 minutes, 110 on the platform's own
      // repository), and every other request on the project waited unread
      // behind it, with nothing said. Recorded on the run, so a restart
      // between the verdict and the build loses nothing.
      await queueLiveBuild(pool, { runId, appId: app.id });
      acted = 'build_queued';
    }
  }
  await live.advanceSeen({
    pool, github, threadContext: deps.threadContext, app, repo, issueNumber, runId,
    since: seedReadAt, postedAt,
  }).catch((err) => log.warn('homeroom-bot', 'Could not record what the bot has seen', { err: err.message }));
  return acted;
}

/**
 * A live 'ready' verdict's build, waiting its turn: started by the lane
 * (dispatch) as soon as its project has fewer than BUILDS_PER_PROJECT
 * running. Never throws.
 */
// Once: a run already waiting keeps its place, and one already building or
// built is left alone.
async function queueLiveBuild(pool, { runId, appId }) {
  try {
    // Queued with no Build it to wait for: that is its go-ahead (goAhead
    // keeps the tap's time for a plan that waited for one).
    await pool.query(
      `UPDATE homeroom_bot_runs SET live_build_waiting_at = COALESCE(live_build_waiting_at, NOW()),
              go_ahead_at = COALESCE(go_ahead_at, NOW())
        WHERE id = $1 AND build_ok IS NULL AND build_session_id IS NULL`,
      [runId],
    );
  } catch (err) {
    log.warn('homeroom-bot', 'Could not queue a live build', { runId, err: err.message });
  }
  wake({ appId });
}

// ── B6: a first version's plan, before it is built ──────────────────────
//
// A ready verdict on a project's first version is not built at once: its
// creator is sent the plan the read wrote (3 to 5 plain bullets, up to two
// choices with the suggested answer first) with Build it and Change
// something (homeroom-bot-dm.js sendPlanCard), and its run waits with
// `awaiting_go_at`. Build it (goAhead) sets live_build_waiting_at, as a
// ready verdict does, with the plan and its choices written into the build
// note as what the creator approved. (The made screen's Submit, which shows
// the questions alone, writes the bullets as the plan's own lines and only
// the answers as theirs: creatorChoiceNote's `planShown`, run seven.)
// Change something (dm.changePlan) and a new look at the request
// (retireWaitingPlans) end the wait; so does a week with no tap
// (settleStalePlans). A waiting plan is not a build: a new look at its
// request replaces it with a new plan, and nothing is built twice.

// Days a plan waits for Build it. The same week a live build is looked for.
const PLAN_WAIT_DAYS = 7;

/** Pure (B6): the plan a first version is shown: the read's, else its assumptions as bullets. */
function planFor(parsed) {
  if (parsed?.plan?.bullets?.length) {
    return { bullets: parsed.plan.bullets, questions: Array.isArray(parsed.plan.questions) ? parsed.plan.questions : [] };
  }
  const bullets = planBullets(parsed?.assumptions || []);
  return { bullets: bullets.length ? bullets : ['A first version of what you described, kept to its core'], questions: [] };
}

/**
 * Pure (B6): the answer each of a plan's questions goes with: the one
 * tapped, when it is one of its answers, else the suggested one (the first).
 */
function choicesFrom(questions, answers = []) {
  return (Array.isArray(questions) ? questions : []).map((q, i) => {
    const offered = Array.isArray(q?.answers) ? q.answers : [];
    const tapped = Array.isArray(answers) && typeof answers[i] === 'string' ? answers[i] : null;
    const answer = offered.includes(tapped) ? tapped : offered[0];
    return { question: String(q?.question || ''), answer: answer || '', suggested: answer === offered[0] };
  }).filter((c) => c.question && c.answer);
}

/**
 * Pure (B6): what a first version's spec and build are told its creator
 * approved, added to the plan's build note once they tap Build it: the
 * plan's bullets they were shown (`bullets`) and the answer each choice goes
 * with; '' when there is neither. The benchmark adds the same lines for a
 * creator who taps Build it without changing anything (services/bench/
 * runner.js firstVersionStage). The spec reads them apart from the triage's
 * note, as binding (homeroom-bot-live.js splitApprovedPlan). Until 7 October
 * 2026 only the choices were written, and the bullets reached neither turn.
 */
// #4488: `requester` for a complicated change on an existing project, whose
// requester approved it: said as theirs, under its own heads.
// Newcomer run seven (14 Oct 2026, Club Votes): `planShown` false for a plan
// gone ahead with from the made screen's Submit, which shows its questions
// and never its bullets (homeroom-bot-dm.js buildFromAnswers). Its bullets
// are then the plan's own lines, in the sketch the spec may improve on
// (live.PLAN_LINES_HEAD), and only the answers are the creator's, under a
// head that says they win over a line (live.MADE_SCREEN_CHOICES_HEAD). The
// default is Build it under the plan card, word for word as before.
function creatorChoiceNote(chosen, { bullets = [], requester = false, planShown = true } = {}) {
  const plan = (Array.isArray(bullets) ? bullets : []).map((b) => String(b || '').trim()).filter(Boolean);
  const picks = Array.isArray(chosen) ? chosen : [];
  const answers = picks.map((c) => `- ${c.question} ${c.answer}`);
  if (!planShown && !requester) {
    const blocks = [
      ...(plan.length ? [[live.PLAN_LINES_HEAD, ...plan.map((b) => `- ${b}`)].join('\n')] : []),
      ...(picks.length ? [[live.MADE_SCREEN_CHOICES_HEAD, ...answers].join('\n')] : []),
    ];
    return blocks.length ? `\n\n${blocks.join('\n\n')}` : '';
  }
  const lines = [];
  if (plan.length) lines.push(requester ? live.APPROVED_BY_REQUESTER_HEAD : live.APPROVED_PLAN_HEAD, ...plan.map((b) => `- ${b}`));
  if (picks.length) {
    lines.push(requester ? live.REQUESTER_CHOICES_HEAD : live.CREATOR_CHOICES_HEAD, ...answers);
  }
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

// #4175: a plan that could not be sent keeps its run waiting and is sent
// again on a later wake, this many minutes after the attempt before (the
// bot's sweeps run every REFRESH_INTERVAL_MS): four sends over about an
// hour. Until 8 October 2026 it was built at once, with nobody asked.
const PLAN_SEND_RETRY_MINUTES = [5, 15, 40];
const PLAN_SEND_ATTEMPTS = PLAN_SEND_RETRY_MINUTES.length + 1;
// Why a first version's plan stopped before anyone saw it (build_error,
// after 'skipped: ', as retireWaitingPlans records a plan it ends).
const PLAN_STOPPED_WHY = {
  no_requester: 'nobody to send the plan to: its creator could not be found',
  no_bot: 'nobody to send the plan to: its creator no longer has Homeroom bot',
  unsent: 'the plan could not be sent to its creator',
};
// What actOnVerdict reports for each way awaitGo resolves.
const PLAN_ACTED = {
  waiting: 'awaiting_go', unsent: 'plan_unsent', stopped: 'plan_stopped', already: 'already_built', failed: 'plan_failed',
};

/**
 * A first version's ready verdict waits for its creator's Build it, under the
 * plan sent to them. Never builds it. Resolves 'waiting' (the plan reached
 * them), 'unsent' (it waits, and is sent again: retryUnsentPlans), 'stopped'
 * (there is nobody to send it to: recorded as not built), 'already' (the run
 * already has a build state: nothing is queued twice) or 'failed' (the wait
 * could not be recorded). Never throws.
 */
async function awaitGo(pool, { runId, app, issueNumber, parsed, bot, deps = {} }) {
  const plan = planFor(parsed);
  try {
    const { rowCount } = await pool.query(
      `UPDATE homeroom_bot_runs SET awaiting_go_at = NOW(), plan = $2, plan_send_attempts = 0, plan_unsent_at = NULL
        WHERE id = $1 AND build_ok IS NULL AND build_session_id IS NULL AND live_build_waiting_at IS NULL`,
      [runId, JSON.stringify(plan)],
    );
    if (!rowCount) return 'already';
  } catch (err) {
    log.warn('homeroom-bot', 'Could not record a first version\'s plan', { app: app.slug, issueNumber, runId, err: err.message });
    return 'failed';
  }
  // The triage wrote it just now; a plan from Make it was recorded when it
  // was written (first-version-plan.js startEarlyPlan).
  if (!parsed?.fromMakeIt) {
    void timeline.record(pool, { runId, stage: 'plan_written', detail: { source: 'triage', questions: plan.questions.length } });
  }
  // A plan its maker already decided on the made screen (planFromEarly) is
  // sent without a ring: it goes ahead the moment it is sent.
  return sendRunPlan(pool, { runId, app, issueNumber, plan, bot, deps, quiet: parsed?.quietPlan === true });
}

/**
 * #4175: one try at sending a waiting first version's plan to its creator.
 * Sent: it waits for Build it. Nobody to send it to: it stops at once, as
 * not built. Otherwise it waits to be sent again, until PLAN_SEND_ATTEMPTS
 * tries have failed, and then stops. Resolves 'waiting', 'unsent' or
 * 'stopped'. Never throws.
 */
async function sendRunPlan(pool, { runId, app, issueNumber, plan, bot, deps = {}, quiet = false }) {
  let sent = null;
  try {
    const dm = deps.dm || require('./homeroom-bot-dm');
    sent = await dm.sendPlanCard(pool, { app, issueNumber, runId, plan, bot, ws: deps.ws || null, ...(quiet ? { quiet: true } : {}) });
  } catch (err) {
    log.warn('homeroom-bot', 'Could not send a first version\'s plan (it waits, and is sent again)', {
      app: app.slug, issueNumber, runId, err: err.message,
    });
  }
  try {
    if (sent?.messageId) {
      await pool.query(
        'UPDATE homeroom_bot_runs SET plan_send_attempts = plan_send_attempts + 1, plan_unsent_at = NULL WHERE id = $1',
        [runId],
      );
      log.info('homeroom-bot', 'A first version waits for its creator to check the plan', { app: app.slug, issueNumber, runId });
      return 'waiting';
    }
    if (sent?.stop) {
      // #4488: a complicated change's plan is on its request's discussion
      // too, where its requester answers it without the bot: it waits there.
      if (plan?.complicated) {
        await pool.query('UPDATE homeroom_bot_runs SET plan_unsent_at = NULL WHERE id = $1', [runId]);
        return 'waiting';
      }
      await stopUnsentPlan(pool, { runId, why: PLAN_STOPPED_WHY[sent.stop] || PLAN_STOPPED_WHY.unsent });
      return 'stopped';
    }
    const { rows: [run] } = await pool.query(
      `UPDATE homeroom_bot_runs SET plan_send_attempts = plan_send_attempts + 1, plan_unsent_at = NOW()
        WHERE id = $1 AND awaiting_go_at IS NOT NULL AND build_ok IS NULL AND build_session_id IS NULL
        RETURNING plan_send_attempts`,
      [runId],
    );
    if (run && Number(run.plan_send_attempts) >= PLAN_SEND_ATTEMPTS) {
      // #4488: on its request it still waits for an answer; the DM stops trying.
      if (plan?.complicated) {
        await pool.query('UPDATE homeroom_bot_runs SET plan_unsent_at = NULL WHERE id = $1', [runId]);
        return 'waiting';
      }
      await stopUnsentPlan(pool, { runId, why: PLAN_STOPPED_WHY.unsent });
      return 'stopped';
    }
    log.info('homeroom-bot', 'A first version\'s plan could not be sent; it waits to be sent again', {
      app: app.slug, issueNumber, runId, attempts: run ? Number(run.plan_send_attempts) : null,
    });
  } catch (err) {
    log.warn('homeroom-bot', 'Could not record a first version\'s plan send', { app: app.slug, issueNumber, runId, err: err.message });
  }
  return 'unsent';
}

/**
 * #4175: a first version's plan that stops before anyone saw it is recorded
 * as not built, with why, as retireWaitingPlans records one it ends. It had
 * no card to close. Never throws.
 */
async function stopUnsentPlan(pool, { runId, why }) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE homeroom_bot_runs SET awaiting_go_at = NULL, plan_unsent_at = NULL, build_ok = FALSE, build_error = $2
        WHERE id = $1 AND awaiting_go_at IS NOT NULL AND build_ok IS NULL AND build_session_id IS NULL`,
      [runId, `skipped: ${why}`],
    );
    if (rowCount) log.info('homeroom-bot', 'A first version\'s plan stopped before anyone saw it', { runId, why });
  } catch (err) {
    log.warn('homeroom-bot', 'Could not stop a first version\'s plan', { runId, err: err.message });
  }
}

/**
 * #4175: send again the first versions' plans that could not be sent, each
 * once its wait since the last try (PLAN_SEND_RETRY_MINUTES) is up. Run on
 * the bot's sweep cadence. Resolves { sent, unsent, stopped }. Never throws.
 */
async function retryUnsentPlans(pool, bot, deps = {}) {
  const out = { sent: 0, unsent: 0, stopped: 0 };
  if (!bot?.id) return out;
  let rows = [];
  try {
    ({ rows } = await pool.query(
      `SELECT r.id, r.app_id, r.issue_number, r.plan, a.slug, a.name
         FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id
        WHERE r.awaiting_go_at IS NOT NULL AND r.plan_unsent_at IS NOT NULL
          AND r.build_ok IS NULL AND r.build_session_id IS NULL
          AND r.plan_unsent_at <= NOW() - make_interval(mins => ($1::int[])[
                GREATEST(1, LEAST(r.plan_send_attempts, cardinality($1::int[])))])
        ORDER BY r.plan_unsent_at, r.id
        LIMIT 20`,
      [PLAN_SEND_RETRY_MINUTES],
    ));
  } catch (err) {
    log.warn('homeroom-bot', 'Could not read the plans waiting to be sent again', { err: err.message });
    return out;
  }
  for (const row of rows) {
    const app = { id: Number(row.app_id), slug: row.slug, name: row.name };
    const plan = {
      bullets: Array.isArray(row.plan?.bullets) ? row.plan.bullets : [],
      questions: Array.isArray(row.plan?.questions) ? row.plan.questions : [],
      // #4488: a complicated change's, with the spec it shows.
      ...(row.plan?.complicated ? { complicated: true, spec: row.plan.spec || null } : {}),
    };
    const state = await sendRunPlan(pool, { runId: Number(row.id), app, issueNumber: Number(row.issue_number), plan, bot, deps });
    out[state === 'waiting' ? 'sent' : state] += 1;
  }
  return out;
}

/**
 * #4210: when the request's previous live run is a first version its creator
 * approved (Build it: its plan has `chosen`) and a restart sent it back to be
 * read again (RESTARTED_BUILD_NOTE), carry what they approved onto this run:
 * its plan, and the bullets and answers in its build note. Resolves true when
 * it did, so the caller builds without sending the plan card again. Never
 * throws.
 */
async function carryApprovedPlan(pool, { runId, appId, issueNumber }) {
  try {
    const { rows: [prev] = [] } = await pool.query(
      `SELECT id, plan, build_error FROM homeroom_bot_runs
        WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND id < $3
        ORDER BY id DESC LIMIT 1`,
      [appId, issueNumber, runId],
    );
    if (!prev || !Array.isArray(prev.plan?.chosen)) return false;
    if (!String(prev.build_error || '').endsWith(RESTARTED_BUILD_NOTE)) return false;
    // Run seven: the same note goAhead wrote, for a plan its maker was not
    // shown as for one they tapped Build it under.
    const note = creatorChoiceNote(prev.plan.chosen, { bullets: prev.plan.bullets, planShown: prev.plan.planShown !== false });
    const { rowCount } = await pool.query(
      `UPDATE homeroom_bot_runs SET build_note = CONCAT(build_note, $2::text), plan = $3::jsonb
        WHERE id = $1 AND build_ok IS NULL AND build_session_id IS NULL AND awaiting_go_at IS NULL`,
      [runId, note, JSON.stringify(prev.plan)],
    );
    if (!rowCount) return false;
    log.info('homeroom-bot', 'A first version a restart sent back keeps the plan its creator approved', {
      appId, issueNumber, runId, from: Number(prev.id),
    });
    return true;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not carry an approved plan across a restart', { appId, issueNumber, runId, err: err.message });
    return false;
  }
}

// ── #4488: a complicated change, checked with its requester first ────────
//
// A ready verdict on an existing project the triage labels `complicated`
// (homeroom-bot-triage.md: a new screen or kind of thing, a change to how
// people get around or what it stores, two quite different ways to do it,
// or large) is not built at once. Its build slot drafts the spec first
// (planBeforeBuilding: buildAndPropose's planOnly), with its before and
// after screens, and it is shown to its requester with Build it and Change
// something: on the request's discussion and GitHub, where anyone can read
// it, and as the plan card in their DM with the bot when they have it. Its
// run then waits with `awaiting_go_at` like a first version's plan, under
// the same week (settleStalePlans) and the same new look (retireWaitingPlans).
// Build it (the card's button, or "build it" from the requester on the
// request: buildItOnRequest) is goAhead, and the build reads the spec they
// saw (presetSpec, its screens from approvedSpecHtml) rather than drawing
// another. Change something posts their words on the request, and its next
// look plans it again (plannedWithRequester). Its screens are reviewed once
// it is built, as a first version's are (buildLive).

/**
 * #4488: whether the request's newest live ready verdict was a complicated
 * change whose plan its requester was asked about and that has not become
 * a proposal: a new look at it plans it with them again rather than
 * building. False when it cannot be read. Never throws.
 */
async function plannedWithRequester(pool, { appId, issueNumber }) {
  try {
    const { rows: [prev] = [] } = await pool.query(
      `SELECT complicated, proposal_session_id FROM homeroom_bot_runs
        WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND verdict = 'ready'
        ORDER BY id DESC LIMIT 1`,
      [appId, issueNumber],
    );
    return !!prev && prev.complicated === true && prev.proposal_session_id == null;
  } catch {
    return false;
  }
}

/**
 * #4488: the HTML (the before and after screens) of the spec a complicated
 * change's requester approved, from the version its plan was shown with, or
 * null. Never throws.
 */
async function approvedSpecHtml(pool, plan) {
  const sessionId = Number(plan?.spec?.sessionId);
  const version = Number(plan?.spec?.version);
  if (!Number.isInteger(sessionId) || sessionId <= 0 || !Number.isInteger(version) || version <= 0) return null;
  try {
    const { rows: [row] = [] } = await pool.query(
      'SELECT content_html FROM chat_session_specs WHERE session_id = $1 AND version = $2',
      [sessionId, version],
    );
    return row?.content_html || null;
  } catch {
    return null;
  }
}

/** Pure (#4488): the plan's choices, as the spec that draws them is told. */
function planChoicesNote(questions) {
  const asks = (Array.isArray(questions) ? questions : []).filter((q) => q?.question && q.answers?.length);
  const lines = [
    'This spec is shown to the person who asked for it BEFORE anything is built, and the build will follow it as',
    'written. Draw its before and after screens as they will really look.',
  ];
  if (asks.length) {
    lines.push('They will also be asked these, with the first answer suggested. Draw the suggested answer, and say in a',
      'line what would change with each other answer:', ...asks.map((q) => `- ${q.question} ${q.answers.join(' / ')}`));
  }
  return `\n\n${lines.join('\n')}`;
}

/** Pure (#4488): the bullets a complicated change's plan card shows: the read's, else one plain line. */
function complicatedPlanBullets(plan) {
  const bullets = planBullets(plan?.bullets || []);
  return bullets.length ? bullets : ['The change this request asks for, as the plan and its screens below show it'];
}

/**
 * #4488: a complicated change's plan, drafted in its build slot and shown to
 * its requester before anything is built (see above). Resolves what was done:
 * 'awaiting_go' (shown, and waiting for Build it), 'blocked', 'skipped',
 * 'already_built' or 'build_failed' (no plan could be written, said on the
 * request). Never builds.
 */
async function planBeforeBuilding({
  pool, config, bot, app, repo, issueNumber, issue, parsed, plan = null, runId, seed, seedReadAt, postedAt,
  turnBudgetMs, model, specModel, guidance = null, harnessed = false, say, deps,
}) {
  const { github, ws } = deps;
  const questions = planQuestions(plan?.questions || []);
  let drafted;
  // Each part a step of the durable build: run again after a restart, the
  // plan is not drafted, debited, recorded, sent or said a second time.
  const planSteps = durableSteps.of(deps);
  {
    // #4645: the requester's language preference, for the plan's wording
    // rule (localeRule); unset, the plan stays English.
    const requester = await (deps.dm || require('./homeroom-bot-dm'))
      .requesterOf(pool, app.id, issueNumber).catch(() => null);
    drafted = await planSteps.once('plan', () => live.buildAndPropose({
      pool, config, bot, app, repo, issueNumber, issue, seed,
      buildNote: `${parsed.buildNote || ''}${planChoicesNote(questions)}`,
      ...buildBudgets(app, config, turnBudgetMs), model, specModel, deps: { ...deps, durable: planSteps.scope('plan') },
      platformRepo: isPlatformRepo(app, config), planOnly: true,
      locale: requester?.locale || null,
      skipCheck: () => whyNotBuild(pool, { runId, botId: bot.id, appId: app.id, issueNumber, github, repo }),
      origin: { lane: 'live', runId },
      ...(harnessed ? { harnessOf: live.recipeHarness, specGuidance: guidance?.spec || null } : {}),
    }));
  }
  await debitBuildOnce(planSteps, 'plan_debited', drafted.costUsd, async (usd) => {
    try {
      if (await deps.managedOpenRouter.usesIncludedKey(pool, bot.id)) {
        await deps.limits.recordSpend(pool, bot.id, Math.round(usd * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('homeroom-bot', 'Plan spend debit failed', { err: err.message });
    }
  });
  const settle = () => pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL WHERE id = $1', [runId]).catch(() => {});
  if (drafted.skipped) {
    await recordLiveBuild(pool, runId, drafted, model);
    await settle();
    log.info('homeroom-bot', 'A complicated change stopped before its plan was shown', { app: app.slug, issueNumber, runId, why: drafted.skipped });
    return 'skipped';
  }
  if (!drafted.planned) {
    const acted = await announceBuilt({ pool, ws, app, bot, issueNumber, runId, built: drafted, say, domain: deps.domain });
    await settle();
    return acted;
  }
  const shown = {
    bullets: complicatedPlanBullets(plan), questions, complicated: true,
    ...(drafted.specVersion ? { spec: { sessionId: Number(drafted.sessionId), version: Number(drafted.specVersion) } } : {}),
  };
  // Once: a plan another drafting of this run already put to its requester
  // stays the one they are asked about (turnly #6 was asked about two). A
  // step: this drafting, run again after a restart, keeps the answer it had.
  const { rowCount } = await planSteps.once('plan_recorded', async () => ({ rowCount: (await pool.query(
    `UPDATE homeroom_bot_runs
        SET live_build_waiting_at = NULL, awaiting_go_at = NOW(), plan = $2::jsonb, plan_send_attempts = 0, plan_unsent_at = NULL,
            build_spec_md = $3, build_cost_usd = $4, build_model = COALESCE($5, build_model)
      WHERE id = $1 AND build_ok IS NULL AND build_session_id IS NULL AND proposal_session_id IS NULL
        AND awaiting_go_at IS NULL`,
    [runId, JSON.stringify(shown), drafted.specMd, Number.isFinite(drafted.costUsd) ? drafted.costUsd : null, specModel || model || null],
  ).catch((err) => {
    durableSteps.rethrowStop(err, 'plan recorded');
    log.warn('homeroom-bot', 'Could not record a complicated change\'s plan', { app: app.slug, issueNumber, runId, err: err.message });
    return { rowCount: 0 };
  })).rowCount }));
  if (!rowCount) return 'already_built';
  if (shown.spec) await live.shareSpecVersion(pool, shown.spec.sessionId, shown.spec.version).catch(() => {});
  // Their DM first, so the request's post does not ring them twice.
  const dmSvc = deps.dm || require('./homeroom-bot-dm');
  const sent = await planSteps.once('plan_card', async () => {
    let out = null;
    try {
      out = await dmSvc.sendPlanCard(pool, { app, issueNumber, runId, plan: shown, bot, ws: ws || null });
    } catch (err) {
      durableSteps.rethrowStop(err, 'plan card');
      log.warn('homeroom-bot', 'Could not send a complicated change\'s plan to its requester (it waits on the request)', {
        app: app.slug, issueNumber, runId, err: err.message,
      });
    }
    await pool.query(
      'UPDATE homeroom_bot_runs SET plan_send_attempts = 1, plan_unsent_at = $2 WHERE id = $1',
      [runId, out?.messageId || out?.stop ? null : new Date()],
    ).catch(() => {});
    return { messageId: out?.messageId ?? null, stop: out?.stop ?? null };
  });
  const asker = await Promise.resolve().then(() => dmSvc.requesterOf(pool, app.id, issueNumber)).catch(() => null);
  const told = sent?.messageId ? asker : null;
  // Said once per run (a restart after it does not say it again).
  if (!(await runPosted(pool, runId, 'plan'))) await say('plan', live.planCommentText({ spec: drafted.specMd, questions }), {
    threadMessage: shown.spec
      ? live.specCard({
        sessionId: shown.spec.sessionId, version: shown.spec.version, spec: drafted.specMd, bot, asking: true,
        requester: asker?.username || null,
      })
      : null,
    ...(told?.username ? { untag: told.username } : {}),
  });
  await live.advanceSeen({
    pool, github, threadContext: deps.threadContext, app, repo, issueNumber, runId, since: seedReadAt, postedAt,
  }).catch((err) => log.warn('homeroom-bot', 'Could not record what the bot has seen', { err: err.message }));
  log.info('homeroom-bot', 'A complicated change waits for its requester to check the plan', {
    app: app.slug, issueNumber, runId, dm: !!sent?.messageId, choices: questions.length,
  });
  return 'awaiting_go';
}

// Words a requester writes on their request that say Build it to the plan
// waiting there (the DM's own list: homeroom-bot-dm.js PLAN_GO_WORDS).
function isGoWord(text) {
  const dmSvc = require('./homeroom-bot-dm');
  return dmSvc.isPlanGoWord(text);
}

/**
 * #4488: "build it" from a complicated change's requester on its request,
 * under a plan waiting there, is Build it: the build goes ahead (goAhead)
 * and their DM card says so. Only when everything people wrote on the
 * request since the plan is theirs and says to go ahead; anything else is a
 * new look, which plans it again. Resolves true when it went ahead. Never
 * throws.
 */
async function buildItOnRequest(pool, { appId, issueNumber, requester, deps = {} }) {
  if (!requester?.userId) return false;
  try {
    const { rows: [run] = [] } = await pool.query(
      `SELECT id, awaiting_go_at FROM homeroom_bot_runs
        WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND awaiting_go_at IS NOT NULL
          AND build_ok IS NULL AND build_session_id IS NULL AND (plan->>'complicated')::boolean IS TRUE
        ORDER BY id DESC LIMIT 1`,
      [appId, issueNumber],
    );
    if (!run) return false;
    const { rows: said } = await pool.query(
      `SELECT m.user_id, m.content FROM chat_messages m
         JOIN users u ON u.id = m.user_id
        WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = $2
          AND m.created_at > $3 AND m.deleted_at IS NULL AND u.is_synthetic IS NOT TRUE
        ORDER BY m.id`,
      [appId, issueNumber, run.awaiting_go_at],
    );
    const people = said.filter((m) => m.user_id != null);
    if (!people.length || !people.every((m) => Number(m.user_id) === Number(requester.userId) && isGoWord(m.content))) return false;
    const went = await goAhead(pool, { runId: Number(run.id) });
    if (!went.ok) return false;
    await (deps.dm || require('./homeroom-bot-dm')).markPlanBuilt(pool, Number(run.id), { chosen: went.chosen, ws: deps.ws || null })
      .catch(() => {});
    log.info('homeroom-bot', 'Build it, said on the request under a complicated change\'s plan', { appId, issueNumber, runId: Number(run.id) });
    return true;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not read a Build it said on a request', { appId, issueNumber, err: err.message });
    return false;
  }
}

/**
 * B6: Build it, under a first version's plan. The plan's bullets and the
 * answers tapped (any left go with the suggested one) are written into the
 * build note the spec and the build read, and the build waits its turn as
 * any ready verdict's does. Once: a plan already built, replaced or stopped
 * is `gone`. Resolves { ok: true,
 * appId, issueNumber, chosen } or { ok: false, why }.
 *
 * Newcomer run seven (14 Oct 2026): `planShown` false when its maker went
 * ahead without being shown the bullets (the made screen's Submit, or a
 * plan decided before it was sent: homeroom-bot-dm.js buildFromAnswers).
 * The bullets are then written as the plan's own lines and only the answers
 * as theirs (creatorChoiceNote), and the plan keeps `planShown: false` next
 * to `chosen`, so a run a restart sent back writes the same note
 * (carryApprovedPlan).
 */
async function goAhead(pool, { runId, answers = [], planShown = true }) {
  const { rows: [run] } = await pool.query(
    `SELECT plan FROM homeroom_bot_runs
      WHERE id = $1 AND awaiting_go_at IS NOT NULL AND build_ok IS NULL AND build_session_id IS NULL`,
    [runId],
  );
  if (!run) return { ok: false, why: 'gone' };
  const chosen = choicesFrom(run.plan?.questions, answers);
  const requester = run.plan?.complicated === true;
  // A complicated change's plan is only ever gone ahead with by its
  // requester's own Build it, under the plan they were shown.
  const shown = planShown !== false || requester;
  const note = creatorChoiceNote(chosen, { bullets: run.plan?.bullets, requester, planShown: shown });
  // `go_ahead_at` keeps when, after live_build_waiting_at is cleared (the
  // build's start): how long the build waited for its slot (buildLive).
  const { rows: [went] } = await pool.query(
    `UPDATE homeroom_bot_runs
        SET awaiting_go_at = NULL, live_build_waiting_at = NOW(), go_ahead_at = NOW(),
            build_note = CONCAT(build_note, $2::text),
            plan = COALESCE(plan, '{}'::jsonb) || jsonb_build_object('chosen', $3::jsonb) || $4::jsonb
      WHERE id = $1 AND awaiting_go_at IS NOT NULL AND build_ok IS NULL AND build_session_id IS NULL
      RETURNING app_id, issue_number`,
    [runId, note, JSON.stringify(chosen), JSON.stringify(shown ? {} : { planShown: false })],
  );
  if (!went) return { ok: false, why: 'gone' };
  void timeline.record(pool, { runId, stage: 'go_ahead', detail: { answers: chosen.length } });
  // The tap is served by whichever Pod the person reached, and only the
  // leader runs the loop that starts the build: the local wake does nothing
  // anywhere else, and the build waited for the leader's next idle pass (up
  // to IDLE_PASS_DELAY_MS; 43 s in run four, 13 Oct 2026). The bus wake
  // reaches the leader, as an issue event's does (noteIssueActivity).
  // Run five (13 Oct 2026): the wake only queued a pass, and a pass started
  // builds after its refresh (46 s from Submit to the spec). The build is
  // started on its own wake now, on the leader, even while a pass runs.
  wake({ appId: Number(went.app_id) });
  wakeLiveBuilds();
  publishWake({ appId: Number(went.app_id), buildRunId: Number(runId) });
  log.info('homeroom-bot', 'Build it: a first version\'s plan goes ahead', {
    appId: Number(went.app_id), issueNumber: Number(went.issue_number), runId, choices: chosen.length, planShown: shown,
  });
  return { ok: true, appId: Number(went.app_id), issueNumber: Number(went.issue_number), chosen };
}

/**
 * B6: end the wait of any plan on a request that still waits for Build it,
 * as `why` (a new look at the request, a merge): recorded as not built,
 * and its card's buttons go. Resolves the runs ended. Never throws.
 */
// `before` leaves alone the plans made after it (a merge's bookkeeping run
// late by the merge-followups workflow machine: noteRequestMerged).
async function retireWaitingPlans(pool, { appId, issueNumber = null, issues = null, why, before = null, deps = {} }) {
  const numbers = issues || [issueNumber];
  let rows = [];
  try {
    ({ rows } = await pool.query(
      `UPDATE homeroom_bot_runs SET awaiting_go_at = NULL, build_ok = FALSE, build_error = $3
        WHERE app_id = $1 AND issue_number = ANY($2::int[]) AND awaiting_go_at IS NOT NULL
          AND build_ok IS NULL AND build_session_id IS NULL
          AND ($4::timestamptz IS NULL OR created_at <= $4::timestamptz)
        RETURNING id`,
      [appId, numbers.map(Number), `skipped: ${why}`, before],
    ));
    if (rows.length) await (deps.dm || require('./homeroom-bot-dm')).closePlanCards(pool, rows.map((r) => Number(r.id)));
  } catch (err) {
    if (deps.strict) throw err;
    log.warn('homeroom-bot', 'Could not end a waiting plan', { appId, issueNumber, err: err.message });
  }
  return rows.map((r) => Number(r.id));
}

/**
 * B6: a plan nobody tapped Build it under for PLAN_WAIT_DAYS stops waiting.
 * Its card keeps its bullets and says so, and one message under it says so
 * too (homeroom-bot-dm.js closePlanCards); a reply to it brings a new plan.
 * Nothing rings. Resolves how many stopped. Never throws.
 */
async function settleStalePlans(pool, deps = {}) {
  try {
    const { rows } = await pool.query(
      `UPDATE homeroom_bot_runs SET awaiting_go_at = NULL, build_ok = FALSE,
              build_error = 'skipped: nobody tapped Build it within a week'
        WHERE awaiting_go_at IS NOT NULL AND awaiting_go_at < NOW() - make_interval(days => $1)
          AND build_ok IS NULL AND build_session_id IS NULL
        RETURNING id, app_id, issue_number`,
      [PLAN_WAIT_DAYS],
    );
    if (rows.length) {
      await (deps.dm || require('./homeroom-bot-dm')).closePlanCards(pool, rows.map((r) => Number(r.id)), { stopped: true });
      log.info('homeroom-bot', 'Plans nobody tapped Build it under stopped waiting', { runs: rows.map((r) => Number(r.id)) });
    }
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not stop the plans nobody answered', { err: err.message });
    return 0;
  }
}

/**
 * #4488: the review of a complicated change once it is built: the screens
 * check round a first version gets (bot-review.js capture, review, fix),
 * with the reviewer and budget the current first-version configuration
 * gives them, the run's rounds recorded the same way. Null when that
 * configuration has no reviewer or cannot be read: the change is proposed
 * as built, as a review that cannot run fails open. Never throws.
 */
async function complicatedReview(pool, { runId, bot, deps = {} }) {
  let current = null;
  try {
    current = await botConfigs().currentVersion(pool);
  } catch (err) {
    log.warn('homeroom-bot', 'Could not read the reviewer for a complicated change (building without a review)', { runId, err: err.message });
    return null;
  }
  const recipe = current ? current.recipe : null;
  if (!recipe || !botConfigs().reviews(recipe)) return null;
  return {
    reviewer: recipe.reviewer,
    owner: { botRunId: runId },
    onState: (state) => recordReviewState(pool, runId, state),
    budgetCheck: ({ spentUsd } = {}) => botBudgetStop(pool, bot, deps, { spentUsd }),
  };
}

// A first version whose configuration has no reviewer is only captured, for
// the side builds it is compared with: a few minutes, never a review.
const CAPTURE_ONLY_MINUTES = 15;

/**
 * Persist a first version's review state on its run (homeroom_bot_runs.review,
 * slimmed: bot-review.js slimState), with the two numbers its listing
 * shows. Throws on a failed write; the loop carries on without it.
 */
async function recordReviewState(pool, runId, state) {
  const summary = botReview().summaryOf(state);
  await pool.query(
    `UPDATE homeroom_bot_runs SET review = $2::jsonb, review_rounds = $3, review_stop = $4
      WHERE id = $1`,
    [runId, JSON.stringify(botReview().slimState(state)), summary.rounds, summary.stop],
  );
}

/**
 * Why the bot may not spend more on a review round (its weekly allowance),
 * or null. `spentUsd` is what this build has spent so far, which is debited
 * only once it is over, so the ledger alone does not have it yet. Never
 * throws.
 */
async function botBudgetStop(pool, bot, deps = {}, { spentUsd = 0 } = {}) {
  try {
    const limits = deps.limits || require('./limits');
    const budget = await limits.checkBudget(pool, bot.id);
    if (budget && budget.error) return String(budget.reason || budget.error);
    const spentCents = Number(spentUsd) > 0 ? Number(spentUsd) * 100 : 0;
    const left = Number(budget?.weeklyRemaining);
    if (spentCents > 0 && Number.isFinite(left) && spentCents >= left) {
      return `weekly_limit: this build has spent $${(spentCents / 100).toFixed(2)}, and $${(left / 100).toFixed(2)} of the week was left`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A live build's claim on its run (buildLive's `onSession`): its session
 * linked and its wait over (live_build_waiting_at cleared), only when no
 * other build has the run and no outcome is in.
 * Resolves { claimed, waitedMs }: how long after it went ahead
 * (go_ahead_at, which the claim leaves) it took its slot, or null when that
 * is not known.
 */
async function claimLiveBuild(pool, { runId, sessionId }) {
  const { rows } = await pool.query(
    `UPDATE homeroom_bot_runs SET build_session_id = $2, live_build_waiting_at = NULL
      WHERE id = $1
        -- Its own link again: a restart between the link and the build's
        -- saving its claim step runs the claim twice.
        AND (build_session_id IS NULL OR build_session_id = $2)
        AND build_ok IS NULL AND proposal_session_id IS NULL
      RETURNING id, ROUND(EXTRACT(EPOCH FROM (NOW() - go_ahead_at)) * 1000)::bigint AS waited_ms`,
    [runId, sessionId],
  );
  if (!rows.length) return { claimed: false, waitedMs: null };
  const waited = rows[0].waited_ms;
  return { claimed: true, waitedMs: waited == null ? null : Math.max(0, Number(waited)) };
}

/**
 * Build a live 'ready' verdict and say what came of it on the issue: the
 * spec as it is written, then the proposal, the request found impossible,
 * or the build that did not finish. What actOnVerdict did inline until the
 * build got a slot of its own; it takes the same arguments, read fresh when
 * the build starts (buildOne). Returns what was done.
 */
async function buildLive({
  pool, config, bot, app, repo, issueNumber, issue, parsed, runId,
  seed, seedReadAt, postedAt = [], turnBudgetMs, model: stageBuildModel, specModel: stageSpecModel = null, botLogin = null,
  proposalCeiling = PROPOSALS_PER_APP_CAP, firstVersion = false, presetSpec = null, carriedCostUsd = 0, settings = null, deps,
  // #4488: a complicated change on an existing project: its plan first
  // (planBeforeBuilding), and once its requester said Build it, built from
  // that spec (presetSpec, its screens `presetSpecHtml`) and reviewed.
  complicated = false, plan = null, presetSpecHtml = null,
}) {
  const { github, ws } = deps;
  // The build's durable steps (services/durable-steps.js): run again after
  // a restart, this goes on from the last one it finished.
  const steps = durableSteps.of(deps);
  // A project's first version is built by the CURRENT CONFIGURATION
  // (services/bot-configs.js): its spec and build models, its pack's
  // guidance, and its reviewer (services/bot-review.js); its side
  // configurations are built beside it on the App bench lane. Every LATER
  // change is built by the `later` scope's current version the same way,
  // with no review and no capture; with none (or one the catalog cannot
  // run, or a lookup that fails: laterVersion) it keeps the per-stage
  // settings it was handed, exactly as before. Chosen once: a restart does
  // not move a build onto a configuration promoted since it started.
  const version = await steps.once('version', async () => (firstVersion
    ? botConfigs().currentVersion(pool) : botConfigs().laterVersion(pool)));
  const recipe = version ? version.recipe : null;
  const model = recipe ? recipe.models.build : stageBuildModel;
  const specModel = recipe ? recipe.models.spec : stageSpecModel;
  const guidance = recipe ? await botConfigs().recipeGuidance(pool, recipe) : null;
  if (version) {
    await pool.query('UPDATE homeroom_bot_runs SET bot_config_version_id = $2 WHERE id = $1', [runId, version.id])
      .catch((err) => log.warn('homeroom-bot', 'Could not record the run\'s configuration', { runId, err: err.message }));
  }
  const say = liveSayer({
    pool, github, ws, app, repo, issueNumber, issue, runId, bot, botLogin,
    notifications: deps.notifications || null, postedAt,
  });
  // #4488: a complicated change is not built until its requester has seen
  // its plan: this slot drafts the spec and asks them.
  const checkFirst = complicated && !firstVersion;
  if (checkFirst && !presetSpec) {
    return planBeforeBuilding({
      pool, config, bot, app, repo, issueNumber, issue, parsed, plan, runId, seed, seedReadAt, postedAt,
      turnBudgetMs, model, specModel, guidance, harnessed: !!version, say, deps,
    });
  }
  // The spec is posted on the issue the moment it is written, and the
  // build goes straight on: it is there to read, not to approve. A plan
  // its requester approved (#4488) was posted when they were asked.
  const onSpec = async ({ sessionId, version, specMd }) => {
    if (version) await live.shareSpecVersion(pool, sessionId, version);
    // Said once per run: a build asked for again from its kept plan (a build
    // from before builds were durable: requeueLegacyBuilds) has it on the
    // issue already.
    if (await runPosted(pool, runId, 'spec')) {
      log.info('homeroom-bot', 'The plan was said before a restart; not saying it again', { app: app.slug, issueNumber, runId, sessionId });
    } else {
      // #4488: a plan its requester said Build it to is on the request
      // already: a short note says so, and no second card.
      const asker = checkFirst
        ? await require('./homeroom-bot-dm').requesterOf(pool, app.id, issueNumber).catch(() => null)
        : null;
      await say('spec', live.specCommentText(specMd, { approved: checkFirst }), {
        threadMessage: version && !checkFirst ? live.specCard({ sessionId, version, spec: specMd, bot }) : null,
        ...(checkFirst ? { homeroomText: live.approvedBuildHomeroomText({ requester: asker?.username || null }) } : {}),
        // The plan in a line, for the quiet line in the request's thread.
        dm: { building: true, plan: live.specTitle(specMd) || null },
      });
    }
    // WP1 (#2): what the run has seen moves past its own plan comment now,
    // not only once the build is announced. The request is held while it is
    // built (classifyIssue), but a build can end without that last step (it
    // throws, or restart recovery finishes it), and the comment then read as
    // a change the moment the hold lifted. A reply from somebody else since
    // the build read the request still leaves it to be read again.
    await live.advanceSeen({
      pool, github, threadContext: deps.threadContext, app, repo, issueNumber, runId,
      since: seedReadAt, postedAt,
    }).catch((err) => log.warn('homeroom-bot', 'Could not record what the bot has seen', { err: err.message }));
  };
  let built;
  let buildMs = null;
  {
    // A first version made from a game starter builds on it (starterOfApp),
    // and so do its side builds, which replay this snapshot.
    const starter = firstVersion ? await starterOfApp(pool, app.id).catch(() => null) : null;
    const snapshotId = await steps.once('snapshot', () => recordBuildSnapshot(pool, {
      runId, app, repo, issueNumber, seed, buildNote: parsed.buildNote, github,
      firstVersion, platformRepo: isPlatformRepo(app, config), model, specModel, starter,
    }));
    // The side builds, queued on the App bench lane before the live build
    // starts, from the same request, plan and commit (the snapshot above).
    // Once: each is a trial of its own.
    const sides = version
      ? await steps.once('side_builds', () => botConfigs().spawnSideBuilds(pool, config, {
        botRunId: runId, app, snapshotId, current: version,
        ...(firstVersion ? {} : { scope: 'later', skipReason: laterSideSkipReason(settings, app, config) }),
      }))
      : null;
    const reviewing = firstVersion && version && botConfigs().reviews(recipe);
    // A first version's first build is captured whenever something is
    // compared with it: its own review rounds, or a side configuration. A
    // later change's never is: its pairs compare specs and diffs.
    const review = firstVersion && version && (reviewing || (sides && sides.derived + sides.trials > 0)) ? {
      reviewer: reviewing ? recipe.reviewer : { model: null, maxRounds: 0, budgetMinutes: CAPTURE_ONLY_MINUTES },
      owner: { botRunId: runId },
      onState: (state) => recordReviewState(pool, runId, state),
      budgetCheck: ({ spentUsd } = {}) => botBudgetStop(pool, bot, deps, { spentUsd }),
    } : checkFirst ? await complicatedReview(pool, { runId, bot, deps }) : null;
    const buildStartedMs = Number(await steps.once('build_started_at', async () => Date.now())) || Date.now();
    // How many times a build of this run took its slot: a first version that
    // did not finish is tried once more (below), and claims it again.
    let claims = 0;
    // #4645: the requester's language preference, for the prompts' wording
    // rule (localeRule); unset, everything the group reads stays English.
    const requester = await (deps.dm || require('./homeroom-bot-dm'))
      .requesterOf(pool, app.id, issueNumber).catch(() => null);
    const buildArgs = {
      pool, config, bot, app, repo, issueNumber, issue, seed, buildNote: parsed.buildNote,
      ...buildBudgets(app, config, turnBudgetMs, { firstVersion }), model, specModel, deps, onSpec, proposalCeiling,
      platformRepo: isPlatformRepo(app, config), presetSpec,
      locale: requester?.locale || null,
      // #3737: a first version's spec and build decide and record its look;
      // made from a game starter, they build on it.
      firstVersion, starter,
      // Newcomer run six (14 Oct 2026): and its spec starts its main screen
      // from the early first look its maker has been shown, when that was
      // drawn from the plan it is built from (first-version-early-look.js).
      ...(firstVersion ? {
        earlyLook: () => firstVersionEarlyLook().forSpec(pool, { appId: app.id, buildNote: parsed.buildNote }),
      } : {}),
      // WP1 (#2): asked once the plan is written and again just before it is
      // proposed (whyNotBuild).
      skipCheck: () => whyNotBuild(pool, { runId, botId: bot.id, appId: app.id, issueNumber, github, repo }),
      // Newcomer run nine (15 Oct 2026): a first version filed while its
      // project was set up stops at the same steps when that setup failed,
      // and waits for the project to run before it is proposed.
      ...(firstVersion ? { setupCheck: setupCheckFor(pool, app.id) } : {}),
      // Linked before any turn runs, so a restart mid-build can find the run
      // (#3471): the build's worker outlives the restart; this process does
      // not. From here restart recovery owns it, so it is no longer waiting.
      // And only once: the link is the build's claim on its run, and a run
      // another build already linked (or whose outcome is in) refuses it, so
      // a second build of one run stops before its plan (LOST_CLAIM).
      // Run five (13 Oct 2026): and says how long the build waited for its
      // slot since it went ahead (`waitedMs`, from go_ahead_at, which the
      // claim leaves; live_build_waiting_at is the one it clears).
      onSession: async (session) => {
        const claim = await claimLiveBuild(pool, { runId, sessionId: session.id });
        if (!claim.claimed) return LOST_CLAIM;
        claims += 1;
        const { waitedMs } = claim;
        log.info('homeroom-bot', 'A live build took its slot', {
          app: app.slug, issueNumber, runId, sessionId: session.id, waitedMs, attempt: claims,
        });
        if (firstVersion) {
          void timeline.record(pool, {
            runId, stage: 'picked_up', sessionId: session.id,
            detail: { ...(waitedMs != null ? { waitedMs } : {}), attempt: claims },
          });
        }
        return null;
      },
      onStep: (name, data) => {
        // A first version's step boundaries that are stages of its timeline
        // (first-version-timeline.js STAGE_OF_STEP), as the build reaches them.
        if (firstVersion) {
          void timeline.recordStep(pool, {
            runId, step: name, sessionId: data.sessionId,
            detail: name === 'landed' ? { partial: !!data.landed?.partial }
              : name === 'proposed' && data.prNumber ? { prNumber: Number(data.prNumber) } : null,
          });
        }
      },
      origin: { lane: 'live', runId },
      onNoChange: (noChange) => keepNoChange(pool, runId, noChange),
      // #4387: what the people waiting on a first version watch on its App
      // tab: the spec's main screen drawn as its first look, and the build
      // agent's "Adding …" phrases (services/first-version-screens.js).
      ...(firstVersion ? (() => {
        // #4449: and Live, the app itself taking shape, watched beside the
        // build turn while the Admin setting is on; every first version's
        // build turn is measured, with whether it was watched.
        const caption = firstVersionScreens().captionWatcher(pool, runId);
        const liveWatch = firstVersionLive().liveController({
          pool, runId, appId: app.id, worker: deps.worker || require('./worker'),
        });
        // 13 Oct 2026: the main screen the spec saved first is drawn as the
        // first look at once, while the spec goes on; the spec's own figure
        // is drawn once it is in only when that did not happen.
        let drewEarly = false;
        return {
          onProgress: (line) => { caption(line); liveWatch.onProgress(line); },
          onBuildTurn: (turn) => liveWatch.onBuildTurn(turn),
          onScreen: ({ n, markup, containerName }) => {
            if (Number(n) !== 1) return;
            void firstVersionScreens().renderSavedFirstLook({
              pool, worker: deps.worker || require('./worker'), containerName, runId, markup,
            }).then((drawn) => {
              if (!drawn) return;
              drewEarly = true;
              log.info('homeroom-bot', 'A first version\'s first look is drawn from its saved main screen', { app: app.slug, runId });
              void timeline.record(pool, { runId, stage: 'first_look_saved', detail: { from: 'saved_screen' } });
            });
          },
          onFirstLook: ({ specHtml, containerName }) => (drewEarly ? false : firstVersionScreens().renderFirstLook({
            pool, worker: deps.worker || require('./worker'), containerName, runId, specHtml,
          }).then((drawn) => {
            if (drawn) void timeline.record(pool, { runId, stage: 'first_look_saved', detail: { from: 'spec' } });
            return drawn;
          })),
        };
      })() : {}),
      ...(version ? {
        harnessOf: live.recipeHarness,
        review,
        specGuidance: guidance?.spec || null,
        buildGuidance: guidance?.build || null,
        // Build speed: the configuration's tweaks, a first version's only.
        ...(firstVersion ? { tweaks: botConfigs().tweaksOf(recipe) } : {}),
      } : {}),
      // #4662: a kept plan's screens ride along whatever the build: a
      // recovered build publishes its plan whole, as a fresh one does.
      ...(presetSpecHtml ? { presetSpecHtml } : {}),
      // #4488: a complicated change's review, whatever builds later changes;
      // and its description says it was checked first.
      ...(checkFirst ? { review, checkedFirst: !!presetSpec } : {}),
      // A first version's build turn that does not finish keeps its work.
      ...(firstVersion ? { keepPartial: true } : {}),
    };
    // A first version that did not finish is tried once more on its own,
    // from the plan it wrote and its creator approved: no new read, plan
    // card, Build it or spec turn. Once per first version.
    let first = null;
    for (;;) {
      // Each try is a step of its own, its own steps scoped under it, so a
      // restart in the second try does not run the first again.
      const tryKey = first ? 'retry' : 'try';
      const tryArgs = first ? {
        ...buildArgs, presetSpec: first.specMd, onSpec: null,
        // Its first look was drawn by the first try.
        onFirstLook: null, onScreen: null,
      } : buildArgs;
      built = await steps.once(tryKey, () => live.buildAndPropose({
        ...tryArgs, deps: { ...tryArgs.deps, durable: steps.scope(tryKey) },
      }));
      if (first) {
        built.retried = { error: first.error, sessionId: first.sessionId || null };
        if (Number(first.costUsd) > 0) built.costUsd = (Number(built.costUsd) || 0) + Number(first.costUsd);
        break;
      }
      if (!firstVersion || !autoRetryable(built)
          || !await steps.once('retry_claim', () => claimAutoRetry(pool, { runId, appId: app.id, issueNumber, built }))) break;
      first = built;
      log.warn('homeroom-bot', 'A first version did not finish; trying once more from its plan', {
        app: app.slug, issueNumber, runId, sessionId: first.sessionId || null, error: first.error,
      });
      await steps.once('retry_said', () => say('spec', live.retryCommentText(), { dm: { building: true, retry: true } })
        .then(() => true)
        .catch((err) => {
          durableSteps.rethrowStop(err, 'retry note');
          log.warn('homeroom-bot', 'Could not say the first version is tried once more', { runId, err: err.message });
          return false;
        }));
    }
    buildMs = Date.now() - buildStartedMs;
  }
  // Its run refused the link (onSession): another build of it has it, and
  // records the run, settles its side builds and says what came of it, or
  // its outcome came in meanwhile (noteRequestMerged). This one stopped
  // before its plan with nothing spent, and touches none of it.
  if (built?.lostClaim) {
    log.warn('homeroom-bot', 'Live build stopped before its plan: its run is another build\'s, or already settled', {
      app: app.slug, issueNumber, runId, sessionId: built.sessionId || null,
    });
    return 'lost_claim';
  }
  if (built) built.model = model;
  // #4387: and, once it is reviewed, up to three of its real screens, from
  // the review's last capture, for its App tab from "Testing it".
  if (firstVersion && built?.review?.finalCapture) {
    await steps.once('real_screens', async () => {
      await firstVersionScreens().keepRealScreens(pool, runId, built.review.finalCapture);
      return true;
    });
  }
  if (built.specMd) {
    await pool.query('UPDATE homeroom_bot_runs SET build_spec_md = $2 WHERE id = $1', [runId, built.specMd])
      .catch(() => {});
  }
  if (built.costUsd > 0) {
    try {
      if (await deps.managedOpenRouter.usesIncludedKey(pool, bot.id)) {
        await debitBuildOnce(steps, 'debited', built.costUsd,
          (usd) => deps.limits.recordSpend(pool, bot.id, Math.round(usd * 1e6) / 1e4, { byok: false }));
      }
    } catch (err) {
      durableSteps.rethrowStop(err, 'debit');
      log.warn('homeroom-bot', 'Build spend debit failed', { err: err.message });
    }
  }
  // A build from a kept plan records what the plan cost beside its own. The
  // plan was debited when it was written, so it is added only after this
  // build's own debit.
  if (carriedCostUsd > 0) built.costUsd = (Number(built.costUsd) || 0) + carriedCostUsd;
  // What the current configuration made of it, and what its round-0
  // snapshot says for a side configuration with no reviewer; then the pairs.
  // A later change stopped before it was proposed (its request merged or
  // closed) says nothing about its configuration: its side builds are
  // stopped instead.
  await steps.once('configs', async () => {
    if (version && built.skipped && !firstVersion) {
      await botConfigs().abandonSideBuilds(pool, runId, `stopped before it was proposed (${clip(built.skipped, 120)})`);
    } else if (version) {
      await botConfigs().finishLive(pool, { botRunId: runId, version, built, activeMs: buildMs, carriedUsd: carriedCostUsd });
    }
    return true;
  });
  steps.fence();
  let acted;
  if (built.skipped) {
    // WP1 (#2): stopped, not failed, and nothing said: a proposal of the
    // bot's already answers the request, or it was closed. Recorded as a
    // skip, which the cards, the tray and the bot's own words read as
    // stopped. Never the "couldn't finish" note.
    await recordLiveBuild(pool, runId, built, built.model || null);
    log.info('homeroom-bot', 'Live build stopped before it was proposed', {
      app: app.slug, issueNumber, runId, sessionId: built.sessionId || null, why: built.skipped,
    });
    acted = 'skipped';
  } else {
    // Once: a restart after it was said does not say it again (and each post
    // is also guarded on the posts table: runPosted).
    acted = await steps.once('announced', () => announceBuilt({
      pool, ws, app, bot, issueNumber, runId, built, say, domain: deps.domain, firstVersion,
    }));
  }
  await pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL WHERE id = $1', [runId]).catch(() => {});
  await live.advanceSeen({
    pool, github, threadContext: deps.threadContext, app, repo, issueNumber, runId,
    since: seedReadAt, postedAt,
  }).catch((err) => log.warn('homeroom-bot', 'Could not record what the bot has seen', { err: err.message }));
  return acted;
}

// Resolved lazily, and only for a live app: ws and session-lifecycle load
// half the platform. Each is injectable for the tests.
function liveDeps(deps = {}) {
  return {
    ws: deps.ws || require('./ws'),
    sessionLifecycle: deps.sessionLifecycle || require('./session-lifecycle'),
    domain: deps.domain || require('./caddy').USERNODE_DOMAIN,
    votesRouter: deps.votesRouter || null,
  };
}

// ── How much at once (#3624 stage 2) ────────────────────────────────────
//
// Two lanes, both run from the loop below.
//
// LIVE work is an issue on an app the bot acts on for real: every app but a
// paused one (live.isLiveFor). It is started one issue at a
// time, up to `liveAtOnce` across the platform, up to `perPerson` for any one
// person, and never two at once on one app: the bot has ONE session per app
// (ensureBotSession), and two turns in it would fight over it. The person is
// whoever the request is for (homeroom_bot_requesters), else whoever filed
// it on Homeroom, else the app itself, so a person with a long list cannot
// take every slot while somebody else waits.
//
// A FOLLOW-UP is the exception to "one at a time on an app" (#3703): a row
// whose issue has the bot's own proposal up for a vote is somebody talking
// to the bot about that proposal (or its checks failing), and it runs on the
// proposal's own session, never the app's. So it neither waits for the app
// nor holds it, and it starts ahead of every row but the queue's front ones
// (priority 0: a Run now, an answer given in the DM). Before, a question in
// the discussion of the bot's proposal on an Ear Trainer project waited
// eleven minutes behind two other requests' builds on that project, the
// newer request taken first, and was reported as the bot not answering.
//
// BACKGROUND work is shadow triage of the apps it does not act on for real
// (every app on a staging copy): the calibration sweep. It keeps its old shape, a batch of one app's issues at a time,
// `concurrency` apps at once, in slots of its own, so it never holds up
// somebody waiting in a DM.
//
// The loop does not wait for the work. A pass refreshes the queue, fills
// the free slots and returns; each piece of work asks for the next pass the
// moment it ends. So a 40-minute build on one app never holds up a DM
// answer on another. `inFlight` is the leader's record of what runs; the
// queue row's started_at is the durable one, claimed before the work starts
// so a second Pod could never take the same row.

// slot → { lane, appId, person, issueNumber, itemId, startedAt, followUp }.
// A slot is the app's id for work on the app's own session, and
// `followup:<queue row id>` for a follow-up, which runs on its proposal's.
const inFlight = new Map();
// A spent weekly cap stops dispatch until the next idle pass, rather than
// re-dispatching (and refusing) on every completion.
let budgetPausedUntil = 0;

function personKeyOf(row) {
  return row?.person_id ? `u${Number(row.person_id)}` : `a${Number(row?.app_id)}`;
}

/**
 * Pure: which live queue rows to start now. `candidates` are queue rows in
 * priority order (each carrying `person_id` or null, and
 * `follow_up_session_id` when its issue has the bot's own open proposal);
 * `busyAppIds` are apps whose session something already runs on;
 * `blockedAppIds` are apps whose session is backed off; `active` is the
 * live work running, as { person }. One per app, at most `perPerson` per
 * person counting what runs, at most `slots` new ones in all. A follow-up
 * (#3703) runs on its proposal's session, so neither a busy app nor one
 * backed off holds it back (it has a backoff of its own), and it does not
 * make the app busy.
 */
function pickLive(candidates, {
  busyAppIds = [], blockedAppIds = [], active = [], slots = 0, perPerson = 1,
} = {}) {
  const busy = new Set(busyAppIds.map(Number));
  const blocked = new Set(blockedAppIds.map(Number));
  const count = new Map();
  for (const a of active) count.set(a.person, (count.get(a.person) || 0) + 1);
  const picks = [];
  for (const row of candidates || []) {
    if (picks.length >= slots) break;
    const appId = Number(row.app_id);
    const followUp = row.follow_up_session_id != null;
    if (!followUp && (blocked.has(appId) || busy.has(appId))) continue;
    const person = personKeyOf(row);
    if ((count.get(person) || 0) >= perPerson) continue;
    if (!followUp) busy.add(appId);
    count.set(person, (count.get(person) || 0) + 1);
    picks.push({ ...row, person, followUp });
  }
  return picks;
}

// ── A project's first version goes first ────────────────────────────────
//
// Flat 4B Chores, 4 October 2026: the bot built the project's first version
// (a chores rota) and put it up for approval. Six minutes after the invite,
// the invitee's idea became a second request, and the bot read and built it
// at once, on `main`: the starter the repository was made with, not the
// first version. It proposed a different app altogether, and the group was
// asked to approve both as if one built on the other; whichever merged
// second would conflict with, or throw away, the other. A third request (a
// fix to the first version) was queued to build on the starter too.
//
// So while a project's first version is not live, the bot starts nothing
// else on that project: no other request is read (liveCandidates) and no
// other build starts (liveBuildCandidates). The request waits in the queue
// in its place, neither failed nor closed, and its card says what it waits
// for (homeroom-bot-activity.js cardText, homeroom-bot-progress.js
// queuedWait). Once the first version merges it is picked up in its usual
// order, from the new main (noteRequestMerged wakes the loop for it).
//
// Not held: the first version's own request; a follow-up on a change of the
// bot's already up for a vote (it runs on that change's own branch); an
// admin's Run now; and anything already running, which is never stopped.
//
// "Not live" is a first version the bot builds (`bot_builds`; one left to
// the group holds nothing, since nobody may ever build it), and either
//   - not filed yet, for a day at most (the project is being set up), or
//   - filed, with no change for it merged, its request not closed on the
//     platform, and the bot still on it: a look at it waits or runs, it was
//     filed within the day and nothing has looked at it yet, or the bot's
//     newest live look has not ended short of a merge.
// A first version that ended short of a merge holds nothing: filing it
// failed, the bot left it to the group or found nothing to build, its look
// or its build failed, its plan waited a week for Build it, or its change
// was closed. Somebody taking it up again (a reply, Try again) queues a look
// at it, and the hold is back until that look comes to something.
//
// `fv` is the first-version row (homeroom_bot_first_versions). One constant,
// so the read lane, the build lane and the card read the same rule.
const FIRST_VERSION_PENDING_SQL = `(
         (fv.status IN ('waiting', 'filing') AND fv.created_at > NOW() - INTERVAL '24 hours')
         OR (fv.status = 'filed' AND fv.issue_number IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM chat_sessions fvm
              WHERE fvm.app_id = fv.app_id AND fvm.status = 'merged'
                AND fv.issue_number = ANY(fvm.linked_issues))
           AND NOT EXISTS (
             SELECT 1 FROM homeroom_bot_runs fvr JOIN chat_sessions fvp ON fvp.id = fvr.proposal_session_id
              WHERE fvr.app_id = fv.app_id AND fvr.issue_number = fv.issue_number AND fvp.status = 'merged')
           AND NOT EXISTS (
             SELECT 1 FROM issues fvi
              WHERE fvi.app_id = fv.app_id AND fvi.github_issue_number = fv.issue_number
                AND fvi.kind = 'general' AND fvi.status = 'closed')
           AND (
             EXISTS (
               SELECT 1 FROM homeroom_bot_queue fvq
                WHERE fvq.app_id = fv.app_id AND fvq.issue_number = fv.issue_number)
             OR (COALESCE(fv.filed_at, fv.created_at) > NOW() - INTERVAL '24 hours'
                 AND NOT EXISTS (
                   SELECT 1 FROM homeroom_bot_runs fvn
                    WHERE fvn.app_id = fv.app_id AND fvn.issue_number = fv.issue_number))
             OR EXISTS (
               SELECT 1
                 FROM (SELECT fvlr.mode, fvlr.verdict, fvlr.build_ok, fvlr.proposal_session_id
                         FROM homeroom_bot_runs fvlr
                        WHERE fvlr.app_id = fv.app_id AND fvlr.issue_number = fv.issue_number
                          AND fvlr.budget_stop IS DISTINCT FROM 'input tokens'
                          AND (fvlr.error IS NULL OR fvlr.error NOT LIKE 'collateral:%')
                        ORDER BY fvlr.id DESC LIMIT 1) fvl
                 LEFT JOIN LATERAL (
                   SELECT fvcs.status
                     FROM homeroom_bot_runs fvcr JOIN chat_sessions fvcs ON fvcs.id = fvcr.proposal_session_id
                    WHERE fvcr.app_id = fv.app_id AND fvcr.issue_number = fv.issue_number
                    ORDER BY fvcr.id DESC LIMIT 1) fvc ON TRUE
                WHERE fvl.mode = 'live'
                  AND (fvc.status IN ('promoted', 'merging')
                       OR (fvl.build_ok IS NOT FALSE AND fvl.verdict NOT IN ('person', 'empty', 'failed')
                           AND (fvc.status IS NULL OR fvc.status NOT IN ('closed', 'archived')
                                OR (fvl.verdict IN ('ready', 'question') AND fvl.build_ok IS NULL
                                    AND fvl.proposal_session_id IS NULL)))))))
       )`;

// What a request held by its project's first version waits for, by name
// (homeroom-bot-progress.js `waitingFor.reason`).
const FIRST_VERSION_HOLD = 'first_version_pending';

/**
 * The projects among `appIds` whose first version is not live yet (see
 * above), as Map(app id → the first version's request number, or null while
 * it is not filed yet). An app missing from the map holds nothing.
 */
async function firstVersionHolds(pool, appIds = []) {
  const ids = [...new Set((Array.isArray(appIds) ? appIds : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT fv.app_id, fv.issue_number
       FROM homeroom_bot_first_versions fv
      WHERE fv.app_id = ANY($1::int[]) AND fv.bot_builds
        AND ${FIRST_VERSION_PENDING_SQL}`,
    [ids],
  );
  return new Map(rows.map((r) => [Number(r.app_id), r.issue_number == null ? null : Number(r.issue_number)]));
}

/**
 * Pure: whether request `issueNumber` on `appId` waits for its project's
 * first version, from firstVersionHolds' map. Never the first version's own
 * request, nor an admin's Run now (`reason` 'admin'), as liveCandidates
 * reads it.
 */
function heldForFirstVersion(holds, { appId, issueNumber, firstVersion = false, reason = null } = {}) {
  if (firstVersion || reason === 'admin' || !(holds instanceof Map)) return false;
  const id = Number(appId);
  if (!holds.has(id)) return false;
  const number = holds.get(id);
  return number == null || Number(number) !== Number(issueNumber);
}

/**
 * Newcomer run nine (15 Oct 2026): the projects among `appIds` whose first
 * version the bot builds is filed and not read yet, which runOnce refreshes
 * and starts the read of before anything else in its pass.
 */
async function firstVersionsToRead(pool, appIds = []) {
  const ids = [...new Set((Array.isArray(appIds) ? appIds : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT fv.app_id
       FROM homeroom_bot_first_versions fv
      WHERE fv.app_id = ANY($1::int[]) AND fv.bot_builds AND fv.status = 'filed' AND fv.issue_number IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM homeroom_bot_runs r
           WHERE r.app_id = fv.app_id AND r.issue_number = fv.issue_number)`,
    [ids],
  );
  return rows.map((r) => Number(r.app_id));
}

// ── A first version filed while its project is set up ───────────────────
//
// Newcomer run nine (15 Oct 2026): a first version is filed once its
// repository holds the starter (homeroom-bot-dm.js FILEABLE_SQL), while the
// starter is still built and deployed, so its plan, spec and build start
// without waiting for the project to run. They need only the repository and
// the build's own worker (its review's captures run the app in that worker
// on a database of its own). What does need the project is its proposal:
// the proposal's preview copies the project's database, and its merge
// deploys over the project's container. So a first version's build waits for
// its project to run before it is proposed, and stops, as a build that did
// not finish does (announceBuilt), when the project's setup failed: before
// it starts (buildOne), at its steps (homeroom-bot-live.js buildAndPropose
// `setupCheck`), and before it is proposed.

// The reasons a first version stops for its project's setup, as the run
// records them; their words are a build's that could not start, did not
// finish, or was built and not put live (homeroom-bot-dm.js
// buildFailedCause), so nothing new is said.
const SETUP_FAILED_BEFORE = 'the build could not start (its project could not be set up)';
const SETUP_FAILED_DURING = 'its project could not be set up, so the build was stopped';
const SETUP_NOT_PROPOSED = 'the change was built but could not be proposed: its project was still being set up';
// How long a built first version waits for its project to run before it is
// proposed, and how often it looks. A project is 'creating' for a minute or
// so, and the creation watchdog fails one that takes ten
// (app-creation-owner.js), long before a build ends.
const SETUP_WAIT_MS = 15 * 60 * 1000;
const SETUP_POLL_MS = 5 * 1000;

/**
 * Why a first version on `appId` stops for its project's setup, or null to
 * go on: 'failed' when its creation failed (or it is gone), 'timeout' when
 * it was still being set up for all of `waitMs`. Without `wait` a project
 * still being set up is no reason; with it, it is waited for. A project
 * running, or in any other state (awaiting its secrets, say), is set up as
 * far as its first version is concerned: what such a project does to a
 * proposal is what it always did. `fence` (a durable build's) is called
 * between looks, so a build this process no longer holds stops waiting.
 * Throws what the read throws.
 */
async function projectSetUpStop(pool, appId, {
  wait = false, waitMs = SETUP_WAIT_MS, pollMs = SETUP_POLL_MS, fence = null, sleep = null, now = Date.now,
} = {}) {
  const until = now() + waitMs;
  for (;;) {
    if (typeof fence === 'function') fence();
    // eslint-disable-next-line no-await-in-loop
    const { rows: [app] = [] } = await pool.query('SELECT status FROM apps WHERE id = $1', [appId]);
    if (!app || app.status === 'error' || app.status === 'deleted') return 'failed';
    if (app.status !== 'creating' || !wait) return null;
    if (now() + pollMs > until) return 'timeout';
    // eslint-disable-next-line no-await-in-loop
    await (sleep ? sleep(pollMs) : new Promise((resolve) => { setTimeout(resolve, pollMs); }));
  }
}

/**
 * A first version's `setupCheck` for buildAndPropose: resolves null to go
 * on, or what the build comes to: `{ error }` (stopped), or `{ error,
 * notProposed }` (built, and its session left for a person to propose, as a
 * proposal refused is). `waiting` is projectSetUpStop's clock, for a test.
 */
function setupCheckFor(pool, appId, waiting = {}) {
  return async ({ wait = false, fence = null } = {}) => {
    const stop = await projectSetUpStop(pool, appId, { ...waiting, wait, fence });
    if (stop === 'timeout') return { error: SETUP_NOT_PROPOSED, notProposed: true };
    if (stop === 'failed') return { error: SETUP_FAILED_DURING };
    return null;
  };
}

/**
 * The live queue's heads, in priority order, with who each one is for.
 * Nothing on an app in `excludeAppIds` (backed off); on an app in
 * `busyAppIds` (its session taken), only follow-ups. A follow-up (#3703),
 * a row whose issue has the bot's own proposal still up for a vote, comes
 * right after the priority-0 rows: somebody is usually waiting on the bot in
 * that proposal's discussion, and it is one turn on the proposal's own
 * session.
 */
// `firstVersionsOnly` (15 Oct 2026): only a project's first version's own
// request, for the read runOnce starts before its full refresh and sweeps.
async function liveCandidates(pool, {
  scope: given = null, liveSlugs = [], excludeAppIds, pausedApps, busyAppIds = [], botId = null, limit = 200, excludeFollowUps = [],
  firstVersionsOnly = false,
}) {
  // A scope from live.liveScope; a bare list of slugs is just those apps.
  const scope = given || { all: false, slugs: liveSlugs, except: [] };
  if (live.scopeIsEmpty(scope)) return [];
  const { rows } = await pool.query(
    `SELECT q.id, q.app_id, q.issue_number, q.priority, q.reason, q.thread_seen_at, q.requested_by,
            q.payer_user_id, q.changed_by,
            COALESCE(r.user_id, i.created_by) AS person_id,
            fu.id AS follow_up_session_id
       FROM homeroom_bot_queue q
       JOIN apps a ON a.id = q.app_id
       LEFT JOIN homeroom_bot_requesters r ON r.app_id = q.app_id AND r.issue_number = q.issue_number
       LEFT JOIN LATERAL (
         SELECT created_by FROM issues
          WHERE app_id = q.app_id AND github_issue_number = q.issue_number
          ORDER BY id LIMIT 1
       ) i ON TRUE
       LEFT JOIN LATERAL (
         SELECT cs.id FROM chat_sessions cs
          WHERE cs.app_id = q.app_id AND cs.user_id = $6
            AND q.issue_number = ANY(cs.linked_issues)
            AND cs.status = 'promoted' AND cs.is_headless = FALSE
          ORDER BY cs.id DESC LIMIT 1
       ) fu ON TRUE
      WHERE q.started_at IS NULL
        AND (CASE WHEN $9::boolean THEN NOT (a.slug = ANY($10::text[])) ELSE a.slug = ANY($1::text[]) END)
        -- Held until its payer's week resets (runTriage): its turn then.
        AND (q.held_until IS NULL OR q.held_until <= NOW())
        -- An app backed off after its session refused a turn holds back
        -- what runs on that session; a follow-up runs on its proposal's, and
        -- is backed off on its own.
        AND (fu.id IS NOT NULL OR NOT (q.app_id = ANY($2::int[])))
        AND (fu.id IS NULL OR NOT ((q.app_id::text || ':' || q.issue_number::text) = ANY($7::text[])))
        AND (fu.id IS NOT NULL OR NOT (q.app_id = ANY($5::int[])))
        AND NOT (a.slug = ANY($3::text[]))
        -- A request whose live build is waiting its turn or under way is
        -- read once that build ends (classifyIssue): read now, it was found
        -- ready again and built twice. Whatever queued it (a refresh, Run
        -- now, an answer in the DM) waits, and is a follow-up on the
        -- proposal by then.
        AND NOT EXISTS (
          SELECT 1 FROM homeroom_bot_runs b
           WHERE b.app_id = q.app_id AND b.issue_number = q.issue_number
             AND b.mode = 'live' AND b.verdict = 'ready' AND b.build_ok IS NULL AND b.proposal_session_id IS NULL
             AND (b.live_build_waiting_at IS NOT NULL OR b.build_session_id IS NOT NULL)
             AND b.created_at > NOW() - make_interval(days => $8)
        )
        -- The project's first version goes first (FIRST_VERSION_PENDING_SQL):
        -- while it is not live, nothing else on the project is read. Its own
        -- request, a follow-up on a change of the bot's up for a vote, and an
        -- admin's Run now are not held.
        AND (fu.id IS NOT NULL OR q.reason = 'admin' OR NOT EXISTS (
          SELECT 1 FROM homeroom_bot_first_versions fv
           WHERE fv.app_id = q.app_id AND fv.bot_builds AND fv.issue_number IS DISTINCT FROM q.issue_number
             AND ${FIRST_VERSION_PENDING_SQL}
        ))
        -- One turn for a burst (SETTLE_MS): a person still writing on the
        -- request, or on the bot's change for it, is read once they pause.
        AND NOT EXISTS (
          SELECT 1 FROM chat_messages m
            LEFT JOIN users mu ON mu.id = m.user_id
           WHERE m.app_id = q.app_id AND m.msg_type = 'message' AND m.deleted_at IS NULL
             AND mu.is_synthetic IS NOT TRUE
             AND ((m.thread_type = 'issue' AND m.thread_ref = q.issue_number)
               OR (fu.id IS NOT NULL AND m.thread_type = 'session' AND m.thread_ref = fu.id))
             AND m.created_at > NOW() - make_interval(secs => $11)
        )
        AND (NOT $12::boolean OR EXISTS (
          SELECT 1 FROM homeroom_bot_first_versions fvo
           WHERE fvo.app_id = q.app_id AND fvo.issue_number = q.issue_number AND fvo.bot_builds
        ))
      ORDER BY (q.priority = 0) DESC, (fu.id IS NOT NULL) DESC, q.priority, q.enqueued_at
      LIMIT $4`,
    [scope.slugs, excludeAppIds, pausedApps, limit, busyAppIds, botId, excludeFollowUps, ABANDONED_LIVE_WINDOW_DAYS,
      scope.all, scope.except, SETTLE_MS / 1000, !!firstVersionsOnly],
  );
  return rows;
}

// ── Live builds, up to BUILDS_PER_PROJECT per project (buildLive) ───────
//
// A live 'ready' verdict is built after the turn that read it, in a slot of
// its own: `build:<runId>`. The project's read slot is free again the moment
// the verdict is recorded, so its next request is read (and asked about, or
// left for a person, or queued to build) while the build runs. Each build is
// a session and a branch of its own, so up to BUILDS_PER_PROJECT of one
// project's run side by side; two that touch the same files meet as any two
// proposals do, at merge. Each waits on its run (live_build_waiting_at), so a
// restart loses none of them.

/** The inFlight slot of one live build, keyed by its run. */
function buildSlot(runId) {
  return `build:${Number(runId)}`;
}

/**
 * The live builds waiting their turn, oldest first, with who each is for,
 * on projects the bot acts on and has not paused. A run a newer verdict on
 * the same issue replaced waits for nothing. While a project's first
 * version is not live (FIRST_VERSION_PENDING_SQL), no other build on it
 * starts: it would be built on the starter.
 */
async function liveBuildCandidates(pool, { scope: given = null, liveSlugs = [], pausedApps = [], limit = 50 }) {
  // As liveCandidates: a scope, or a bare list of slugs.
  const scope = given || { all: false, slugs: liveSlugs, except: [] };
  if (live.scopeIsEmpty(scope)) return [];
  const { rows } = await pool.query(
    `SELECT r.id, r.app_id, r.issue_number, r.build_note, r.live_build_waiting_at, r.created_at,
            r.build_spec_md, r.build_spec_html, r.build_cost_usd, r.charged, r.payer_user_id, r.complicated, r.plan,
            COALESCE(q.user_id, i.created_by) AS person_id
       FROM homeroom_bot_runs r
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
       LEFT JOIN LATERAL (
         SELECT created_by FROM issues
          WHERE app_id = r.app_id AND github_issue_number = r.issue_number
          ORDER BY id LIMIT 1
       ) i ON TRUE
      WHERE r.live_build_waiting_at IS NOT NULL AND r.mode = 'live' AND r.verdict = 'ready'
        AND r.build_ok IS NULL AND r.build_session_id IS NULL AND r.proposal_session_id IS NULL
        AND (CASE WHEN $4::boolean THEN NOT (a.slug = ANY($5::text[])) ELSE a.slug = ANY($1::text[]) END) AND NOT (a.slug = ANY($2::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM homeroom_bot_runs n
           WHERE n.app_id = r.app_id AND n.issue_number = r.issue_number AND n.id > r.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM homeroom_bot_first_versions fv
           WHERE fv.app_id = r.app_id AND fv.bot_builds AND fv.issue_number IS DISTINCT FROM r.issue_number
             AND ${FIRST_VERSION_PENDING_SQL}
        )
      ORDER BY r.live_build_waiting_at, r.id
      LIMIT $3`,
    [scope.slugs, pausedApps, limit, scope.all, scope.except],
  );
  return rows;
}

/**
 * Pure: which waiting builds to start now. At most `perProject` under way on
 * one project, counting those already building (`buildingAppIds`, one entry
 * per build), at most `perPerson` live pieces of work for any one person
 * counting what runs (`active`), and at most `slots` in all.
 */
function pickLiveBuilds(candidates, {
  buildingAppIds = [], active = [], slots = 0, perPerson = 1, perProject = BUILDS_PER_PROJECT,
} = {}) {
  const building = new Map();
  for (const id of buildingAppIds) building.set(Number(id), (building.get(Number(id)) || 0) + 1);
  const count = new Map();
  for (const a of active) count.set(a.person, (count.get(a.person) || 0) + 1);
  const picks = [];
  for (const row of candidates || []) {
    if (picks.length >= slots) break;
    const appId = Number(row.app_id);
    if ((building.get(appId) || 0) >= perProject) continue;
    const person = personKeyOf(row);
    if ((count.get(person) || 0) >= perPerson) continue;
    building.set(appId, (building.get(appId) || 0) + 1);
    count.set(person, (count.get(person) || 0) + 1);
    picks.push({ ...row, person });
  }
  return picks;
}

/**
 * The bot's own proposal for a request, up for a vote or merging, or merged
 * at or after `since` (the verdict of the build that asks): `{ id }`, or
 * null. Throws when it cannot be read. Asked before a build starts
 * (buildOne), and again before one is proposed (whyNotBuild).
 */
async function requestProposal(pool, { appId, botId, issueNumber, since = null }) {
  const { rows } = await pool.query(
    `SELECT id FROM chat_sessions
      WHERE app_id = $1 AND user_id = $2 AND $3 = ANY(linked_issues) AND is_headless = FALSE
        AND (status IN ('promoted', 'merging') OR (status = 'merged' AND merged_at >= $4::timestamptz))
      ORDER BY id DESC LIMIT 1`,
    [appId, botId, issueNumber, since || null],
  );
  return rows[0] || null;
}

/** What a build its request's proposal made unneeded records: a skip, read as stopped. */
function hasProposalSkip(sessionId) {
  return `skipped: the request already has a proposal (${Number(sessionId)})`;
}

/**
 * Another live build of the same request under way: the build session of
 * another of its runs, still open (`active` while a turn runs, `paused`
 * between its turns), started within BUILD_UNDER_WAY_HOURS, and its run's
 * outcome not in. Given `before` (the asking build's own session), only one
 * that started before it, so of two builds of one request the first goes on
 * and the second stops, never both. `{ id }` (that session), or null. Throws
 * when it cannot be read. Asked beside requestProposal (buildOne,
 * whyNotBuild): a build still under way is no proposal, and two of them
 * were two proposals of one request. A run's own second build is stopped
 * earlier, by its claim (buildLive's onSession).
 */
async function requestBuilding(pool, { appId, issueNumber, runId, before = null }) {
  const { rows } = await pool.query(
    `SELECT bs.id FROM homeroom_bot_runs b
       JOIN chat_sessions bs ON bs.id = b.build_session_id
      WHERE b.app_id = $1 AND b.issue_number = $2 AND b.id <> $3 AND b.mode = 'live'
        AND b.build_ok IS NULL AND b.proposal_session_id IS NULL
        AND bs.status IN ('active', 'paused') AND bs.created_at > NOW() - make_interval(hours => $4)
        AND ($5::int IS NULL OR bs.id < $5::int)
      ORDER BY bs.id LIMIT 1`,
    [appId, issueNumber, runId, BUILD_UNDER_WAY_HOURS, Number(before) || null],
  );
  return rows[0] || null;
}

/** What a build another build of its request made unneeded records: a skip, read as stopped. */
function beingBuiltSkip(sessionId) {
  return `skipped: the request is already being built (${Number(sessionId)})`;
}

// What a build whose run another build claimed first resolves (buildLive's
// onSession). Never recorded: the run is that other build's.
const LOST_CLAIM = 'skipped: another build of its run started first';

// What a build whose request was closed while it was built records.
const CLOSED_WHILE_BUILDING = 'skipped: the request was closed before it was proposed';

/**
 * WP1 (#2): why a live build under way should stop where it is, or null to
 * go on. buildOne asks before a build starts; this is asked once its plan is
 * written and again just before it is proposed (buildAndPropose's
 * `skipCheck`), and before restart recovery proposes one. A reason is a
 * skip: the run already stopped (noteRequestMerged), a proposal of the
 * bot's for the request (up for a vote, merging, or merged since this
 * verdict), another build of the request that started before this one
 * (requestBuilding), or the request's issue closed. Both of Plant Pal's
 * duplicate proposals went up after their issue had closed. What cannot be
 * read never stops a build: this is the backstop, not the guard.
 */
async function whyNotBuild(pool, { runId, botId, appId, issueNumber, github = null, repo = null }) {
  try {
    const { rows: [run] = [] } = await pool.query(
      'SELECT created_at, build_ok, build_error, build_session_id FROM homeroom_bot_runs WHERE id = $1', [runId],
    );
    if (run?.build_ok === false && /^skipped:/.test(String(run.build_error || ''))) return String(run.build_error);
    const proposed = await requestProposal(pool, { appId, botId, issueNumber, since: run?.created_at || null });
    if (proposed) return hasProposalSkip(proposed.id);
    // Its own session is the run's (its claim); a plan, which links none,
    // gives way to any build of the request under way.
    const building = await requestBuilding(pool, { appId, issueNumber, runId, before: run?.build_session_id || null });
    if (building) return beingBuiltSkip(building.id);
  } catch (err) {
    log.warn('homeroom-bot', 'Could not look for the request\'s proposal during its build', { runId, issueNumber, err: err.message });
  }
  if (github && repo) {
    const fetched = await github.fetchPublicIssue(repo.owner, repo.repo, issueNumber).catch(() => null);
    const state = fetched?.issue?.state;
    if (state && state !== 'open') return CLOSED_WHILE_BUILDING;
  }
  return null;
}

/**
 * Start one waiting live build: the issue, its discussion and who it is for
 * read fresh (a comment since the verdict is in the build's seed), then
 * buildLive. A closed issue is skipped and recorded so; a platform that
 * cannot read the issue leaves it waiting. A build that throws is recorded
 * as failed and said, so it is never started again in a loop.
 */
async function buildOne(pool, config, { bot, app, run, settings, deps = {} }) {
  const buildDeps = liveBuildDeps(deps);
  const { github, sessions, threadContext } = buildDeps;
  const issueNumber = Number(run.issue_number);
  const repo = parseRepo(app.repo_url);
  if (!repo || !github.isEnabled()) return { ran: false, reason: 'infra', detail: 'github_unavailable' };
  const fetched = await github.fetchPublicIssue(repo.owner, repo.repo, issueNumber).catch(() => null);
  const issue = fetched?.issue || null;
  if (!issue) return { ran: false, reason: 'infra', detail: 'issue_unreadable' };
  if (issue.state && issue.state !== 'open') {
    await pool.query(
      `UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = $2
        WHERE id = $1 AND build_ok IS NULL`,
      [run.id, 'skipped: the request was closed before its build started'],
    ).catch(() => {});
    log.info('homeroom-bot', 'Live build skipped: its request was closed', { app: app.slug, issueNumber, runId: run.id });
    return { ran: false, reason: 'not_open' };
  }
  // A request the bot already proposed is not built again: its proposal up
  // for a vote or merging, or one merged since this verdict. Two verdicts on
  // one request each waited for a build and both were built (Plant Pal #1
  // and #3, 2026-10-03); the second started seconds after the first was put
  // up for a vote. When this cannot be read, it is not built either: it
  // keeps waiting, and the next pass looks again. Nor is one built while
  // another build of the request is under way (requestBuilding).
  let proposed;
  let building = null;
  try {
    proposed = await requestProposal(pool, { appId: app.id, botId: bot.id, issueNumber, since: run.created_at || null });
    if (!proposed) building = await requestBuilding(pool, { appId: app.id, issueNumber, runId: run.id });
  } catch (err) {
    log.warn('homeroom-bot', 'Could not look for the request\'s proposal before its build', { app: app.slug, issueNumber, err: err.message });
    return { ran: false, reason: 'infra', detail: 'proposal_unreadable' };
  }
  if (proposed || building) {
    await pool.query(
      `UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = $2
        WHERE id = $1 AND build_ok IS NULL`,
      [run.id, proposed ? hasProposalSkip(proposed.id) : beingBuiltSkip(building.id)],
    ).catch(() => {});
    log.info('homeroom-bot', proposed
      ? 'Live build skipped: its request already has a proposal'
      : 'Live build skipped: its request is already being built', {
      app: app.slug, issueNumber, runId: run.id, sessionId: Number((proposed || building).id),
    });
    return { ran: false, reason: proposed ? 'has_proposal' : 'being_built' };
  }
  const dm = deps.dm || require('./homeroom-bot-dm');
  const requester = await dm.requesterOf(pool, app.id, issueNumber).catch(() => null);
  // Newcomer run nine (15 Oct 2026): a first version filed while its project
  // was set up is not started once that setup failed. It ends as a build
  // that could not start does (below), and nothing of it runs.
  if (requester?.firstVersion) {
    const stop = await projectSetUpStop(pool, app.id).catch((err) => {
      log.warn('homeroom-bot', 'Could not read whether a first version\'s project is set up (building it)', {
        app: app.slug, issueNumber, err: err.message,
      });
      return null;
    });
    if (stop) {
      log.warn('homeroom-bot', 'First version not built: its project could not be set up', { app: app.slug, issueNumber, runId: run.id });
      const say = liveSayer({
        pool, github, ws: buildDeps.ws, app, repo, issueNumber, issue, runId: Number(run.id), bot,
        botLogin: await live.botUsernameOf(github).catch(() => null), notifications: deps.notifications || null,
      });
      await announceBuilt({
        pool, ws: buildDeps.ws, app, bot, issueNumber, runId: Number(run.id), say, domain: buildDeps.domain,
        firstVersion: true, built: { ok: false, error: SETUP_FAILED_BEFORE, setupFailed: true },
      }).catch(() => {});
      await pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL WHERE id = $1', [run.id]).catch(() => {});
      return { ran: true, verdict: 'ready', runId: Number(run.id), acted: 'build_failed' };
    }
  }
  const seedReadAt = new Date().toISOString();
  const [{ comments = [] } = {}, thread, botLogin] = await Promise.all([
    github.fetchIssueComments(repo.owner, repo.repo, issueNumber).catch(() => ({ comments: [] })),
    threadContext.loadIssueThread(pool, app.id, issueNumber),
    live.botUsernameOf(github),
  ]);
  const seed = sessions.buildHeadlessSeed(issueNumber, issue, comments, botLogin, thread?.messages || []);
  const turnBudgetMs = 1000 * clampInt(settings?.turnSeconds, DEFAULTS.turnSeconds, MIN_TURN_SECONDS, MAX_TURN_SECONDS);
  const args = {
    pool, config, bot, app, repo, issueNumber, issue, runId: Number(run.id),
    parsed: { verdict: 'ready', buildNote: run.build_note || '' },
    seed, seedReadAt, postedAt: [], turnBudgetMs, botLogin,
    model: stageModel(settings, config, 'build'), specModel: stageModel(settings, config, 'spec'),
    proposalCeiling: botProposalCeiling(settings), firstVersion: !!requester?.firstVersion, settings, deps: buildDeps,
    // The plan a build kept on its run (one from before builds were
    // durable, asked for again: requeueLegacyBuilds), and what writing it
    // cost.
    presetSpec: run.build_spec_md || null,
    carriedCostUsd: run.build_spec_md ? Number(run.build_cost_usd) || 0 : 0,
    // #4488: a complicated change, planned with its requester first; once
    // they said Build it, built from exactly the spec they were shown (its
    // markdown above, its screens read back here). A plan kept from a build
    // a restart interrupted carries its own HTML beside it (#4662): a
    // complicated plan still prefers the exact version its requester
    // approved, and falls back to the run's when that cannot be read.
    complicated: run.complicated === true && !requester?.firstVersion,
    plan: run.plan && typeof run.plan === 'object' ? run.plan : null,
    presetSpecHtml: run.build_spec_md
      ? ((run.complicated === true ? await approvedSpecHtml(pool, run.plan) : null) || run.build_spec_html || null)
      : null,
  };
  // How long it waited its turn since its go-ahead (a ready verdict, or
  // Build it under a plan): live_build_waiting_at is cleared once the build
  // links its session, so the time is kept here (run five, 13 Oct 2026).
  const waitingSince = run.live_build_waiting_at ? new Date(run.live_build_waiting_at).getTime() : NaN;
  log.info('homeroom-bot', 'Live build started', {
    app: app.slug, issueNumber, runId: run.id, ...(run.build_spec_md ? { fromKeptPlan: true } : {}),
    waitedMs: Number.isFinite(waitingSince) ? Math.max(0, Date.now() - waitingSince) : null,
  });
  try {
    // A durable build on the workflow kernel (services/build-runs.js): this
    // resolves once it has ended, wherever it ran, so the slot it holds is
    // held for as long as it runs. What it starts from is what was read
    // here, so a restart does not read the request again under it.
    const ended = await buildRuns().start({
      pool, config, target: 'live', id: Number(run.id), nonce: liveBuildNonce(run), appId: Number(app.id),
      input: { args: liveBuildInput(args) },
      deps: { ...deps, bot, settings, inProcessArgs: args },
    });
    const acted = ended?.acted || ended?.result?.acted || (ended?.state === 'failed' ? 'build_failed' : 'built');
    return { ran: true, verdict: 'ready', runId: Number(run.id), acted };
  } catch (err) {
    // The platform began stopping before the build could start: it is still
    // asked for (still waiting), and the next leader starts it.
    if (err?.notStarted) {
      log.info('homeroom-bot', 'Live build left for the next leader: the platform is stopping', { app: app.slug, issueNumber, runId: run.id });
      return { ran: false, verdict: 'ready', runId: Number(run.id), acted: 'not_started' };
    }
    log.error('homeroom-bot', 'Live build threw', { app: app.slug, issueNumber, runId: run.id, err: err.message });
    const say = liveSayer({
      pool, github, ws: buildDeps.ws, app, repo, issueNumber, issue, runId: Number(run.id), bot, botLogin,
      notifications: deps.notifications || null,
    });
    await announceBuilt({
      pool, ws: buildDeps.ws, app, bot, issueNumber, runId: Number(run.id), say, domain: buildDeps.domain,
      firstVersion: !!requester?.firstVersion,
      built: { ok: false, error: `the build could not start (${clip(err.message, 200)})` },
    }).catch(() => {});
    await pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL WHERE id = $1', [run.id]).catch(() => {});
    return { ran: true, verdict: 'ready', runId: Number(run.id), acted: 'build_failed' };
  }
}

// ── A request's proposal merged (WP1, #2) ────────────────────────────────
//
// The safety net behind the hold and the checks before a build starts and
// before it is proposed. Once the bot's proposal for a request is merged,
// nothing else of the bot's on that request goes on: a build still waiting
// its turn is stopped, one under way is stopped too (its turn ended, which
// frees its project's build slot, and the build reads the stop as a skip,
// whyNotBuild), another proposal of the bot's for the request is withdrawn,
// and the request's queue rows go, except one a person waits on (priority
// 0). Before, a second build of Plant Pal #1 held the project's build slot
// after the first was merged, and the next request waited behind it.

/**
 * Called by the merge (routes/votes.js finalizeMerge) once `session` is
 * merged. Only for a proposal of the bot's. Never throws; resolves what it
 * did ({ skipped, stopped, withdrawn, dequeued }), or null.
 *
 * `deps.before` (the merge's time) leaves alone the builds, proposals and
 * queue rows that started after it: the merge-followups workflow machine
 * can run this well after the merge, and work begun since is not what the
 * merge made unneeded.
 *
 * `deps.strict` (the machine's durable work, which retries) throws what it
 * could not do instead of resolving null. Run again, it stops the builds
 * an earlier run marked but may not have reached, so a crash between the
 * two leaves nothing running.
 */
async function noteRequestMerged(pool, session, deps = {}) {
  if (!session?.id) return null;
  try {
    const { rows: [merged] = [] } = await pool.query(
      `SELECT cs.id, cs.app_id, cs.user_id, cs.linked_issues
         FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
        WHERE cs.id = $1 AND cs.status = 'merged' AND u.username = $2 AND u.is_synthetic = TRUE`,
      [session.id, BOT_USERNAME],
    );
    if (!merged) return null;
    const issues = [...new Set((merged.linked_issues || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!issues.length) return null;
    const appId = Number(merged.app_id);
    const why = hasProposalSkip(merged.id);
    const before = deps.before ? new Date(deps.before) : null;
    const out = { skipped: 0, stopped: 0, withdrawn: 0, dequeued: 0 };
    // Recorded before anything is stopped: whatever the stopped turn comes
    // to then reads as this skip, never as a failure.
    const { rows: settled } = await pool.query(
      `UPDATE homeroom_bot_runs r
          SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = $3
        WHERE r.app_id = $1 AND r.issue_number = ANY($2::int[])
          AND r.mode = 'live' AND r.verdict = 'ready' AND r.build_ok IS NULL AND r.proposal_session_id IS NULL
          AND r.build_session_id IS DISTINCT FROM $4
          AND ($5::timestamptz IS NULL OR r.created_at <= $5::timestamptz)
          AND ((r.live_build_waiting_at IS NOT NULL AND r.build_session_id IS NULL)
               OR EXISTS (SELECT 1 FROM chat_sessions bs
                           WHERE bs.id = r.build_session_id AND bs.status IN ('active', 'paused')))
        RETURNING r.id, r.build_session_id`,
      [appId, issues, why, Number(merged.id), before],
    );
    // Builds an earlier run of this marked with the same skip, whose turn
    // may not have been stopped (a crash in between): stopped again.
    const { rows: marked } = await pool.query(
      `SELECT r.id, r.build_session_id FROM homeroom_bot_runs r
        WHERE r.app_id = $1 AND r.issue_number = ANY($2::int[])
          AND r.mode = 'live' AND r.build_ok = FALSE AND r.build_error = $3
          AND r.build_session_id IS NOT NULL AND r.build_session_id IS DISTINCT FROM $4
          AND ($5::timestamptz IS NULL OR r.created_at <= $5::timestamptz)
          AND EXISTS (SELECT 1 FROM chat_sessions bs
                       WHERE bs.id = r.build_session_id AND bs.status IN ('active', 'paused'))`,
      [appId, issues, why, Number(merged.id), before],
    );
    for (const run of marked) {
      if (!settled.some((s) => Number(s.id) === Number(run.id))) settled.push({ ...run, again: true });
    }
    // B6: and a first version's plan still waiting for Build it.
    out.skipped += (await retireWaitingPlans(pool, { appId, issues, why: why.replace(/^skipped:\s*/, ''), before, deps })).length;
    const worker = deps.worker || require('./worker');
    for (const run of settled) {
      if (!run.build_session_id) { out.skipped += 1; continue; }
      // A stop asked again is not news: the counts say what this run did.
      if (!run.again) out.stopped += 1;
      await Promise.resolve(worker.stopTurn(run.build_session_id)).catch((err) => {
        log.warn('homeroom-bot', 'Could not stop a build its request\'s merge made unneeded', {
          runId: run.id, sessionId: run.build_session_id, err: err.message,
        });
      });
    }
    // The same request's other proposals of the bot's, still up for a vote:
    // withdrawn as the platform withdraws one (no person withdrew it).
    const { rows: others } = await pool.query(
      `SELECT id FROM chat_sessions
        WHERE app_id = $1 AND user_id = $2 AND linked_issues && $3::int[] AND is_headless = FALSE
          AND status = 'promoted' AND id <> $4
          AND ($5::timestamptz IS NULL OR created_at <= $5::timestamptz)
        ORDER BY id`,
      [appId, merged.user_id, issues, Number(merged.id), before],
    );
    const sessionLifecycle = deps.sessionLifecycle || require('./session-lifecycle');
    for (const other of others) {
      try {
        const done = await sessionLifecycle.archiveSession({ pool, sessionId: Number(other.id), reason: 'superseded' });
        if (done?.archived) out.withdrawn += 1;
      } catch (err) {
        if (deps.strict) throw err;
        log.warn('homeroom-bot', 'Could not withdraw a duplicate proposal', { sessionId: other.id, err: err.message });
      }
    }
    const { rowCount } = await pool.query(
      `DELETE FROM homeroom_bot_queue
        WHERE app_id = $1 AND issue_number = ANY($2::int[]) AND priority > 0 AND started_at IS NULL
          AND ($3::timestamptz IS NULL OR enqueued_at <= $3::timestamptz)`,
      [appId, issues, before],
    );
    out.dequeued = rowCount || 0;
    if (out.skipped || out.stopped || out.withdrawn || out.dequeued) {
      log.info('homeroom-bot', 'A request\'s proposal merged; the rest of the bot\'s work on it stopped', {
        sessionId: Number(merged.id), appId, issues, ...out,
      });
      wake({ appId });
    }
    // The project's first version is live: what waited for it
    // (FIRST_VERSION_PENDING_SQL) is picked up now, from the new main, on
    // whichever Pod runs the loop, rather than on its next idle pass.
    const { rows: firstVersion } = await pool.query(
      `SELECT issue_number FROM homeroom_bot_first_versions
        WHERE app_id = $1 AND bot_builds AND issue_number = ANY($2::int[])
        LIMIT 1`,
      [appId, issues],
    ).catch(() => ({ rows: [] }));
    if (firstVersion.length) {
      log.info('homeroom-bot', 'A project\'s first version is live; what waited for it is picked up now', {
        sessionId: Number(merged.id), appId, issueNumber: Number(firstVersion[0].issue_number),
      });
      noteIssueActivity({ appId, issueNumber: Number(firstVersion[0].issue_number), reason: 'first_version_live' });
    }
    return out;
  } catch (err) {
    if (deps.strict) throw err;
    log.warn('homeroom-bot', 'Could not settle a merged request\'s other work', { sessionId: session.id, err: err.message });
    return null;
  }
}

/** Ask for a pass now: idle, it runs at once; mid-pass, it runs next. */
function requestPass() {
  if (stopped) return false;
  wakeRequested = true;
  if (!passInFlight && loopConfig) schedule(loopConfig, 0);
  return true;
}

/** The apps backed off after a refusal, for the dashboard's loop line. */
function currentRefusals(now = Date.now()) {
  const out = [];
  for (const [appId, b] of appBackoff) {
    if (b.until > now) out.push({ appId, error: b.error, retryInMs: b.until - now });
  }
  return out;
}

/**
 * What one finished piece of work means for the loop: counted, a refusal
 * noted, or the dispatch paused (the weekly cap, a platform fault, the mode
 * switched off). A 'collateral' failure is none of these: its row is back on
 * the queue and the next pass takes it. Returns { processed, refusals,
 * budgets, paused, detail, retryInMs, stop }.
 */
function outcomeOf(r, { app, item }) {
  const o = { processed: 0, refusals: [], budgets: [], paused: null, stop: false };
  if (!r) return o;
  if (r.ran) { o.processed = 1; clearFault(); }
  if (r.budget) o.budgets.push({ app: app.slug, issueNumber: item.issue_number, kind: r.budget });
  if (r.reason === 'budget') {
    o.paused = 'budget';
    o.stop = true;
    budgetPausedUntil = Date.now() + IDLE_PASS_DELAY_MS;
  } else if (r.reason === 'mode_off') {
    o.paused = 'mode_off';
    o.stop = true;
  } else if (r.reason === 'refused') {
    // A refusal moves on to the next APP: the others are not wedged just
    // because this one is.
    o.refusals.push({ app: r.app, appId: Number(app.id), error: r.detail, retryInMs: r.retryInMs });
    o.stop = true;
  } else if (r.reason === 'infra') {
    const fault = noteFault(r.detail);
    log.warn('homeroom-bot', 'Platform fault; the bot backs off', {
      app: app.slug, issueNumber: item.issue_number, fault: fault.summary,
      attempts: fault.attempts, retryInMs: fault.delayMs,
    });
    o.paused = 'infra';
    o.detail = fault.summary;
    o.retryInMs = fault.delayMs;
    o.stop = true;
  }
  return o;
}

/**
 * The bot's own weekly budget (its users row, limits.checkBudget) is spent:
 * nothing more is dispatched until the idle pass looks again, and the people
 * whose work was next hear it once a week (dm.notePausedForWeek) rather than
 * finding the bot quiet. Only the weekly cap is a pause "for the rest of the
 * week"; any other refusal is said by nobody, as before. Never throws.
 */
async function pauseOnBudget(pool, { settings, bot, reason = null, people = [], deps = {} }) {
  budgetPausedUntil = Date.now() + IDLE_PASS_DELAY_MS;
  if (reason !== 'weekly_limit') return;
  const dm = deps.dm || require('./homeroom-bot-dm');
  for (const userId of [...new Set(people.map(Number).filter((n) => Number.isInteger(n) && n > 0))]) {
    await dm.notePausedForWeek(pool, { settings, bot, userId }).catch((err) => {
      log.warn('homeroom-bot', 'Could not say the bot paused for the week', { userId, err: err.message });
    });
  }
}

/** One issue through runTriage, a throw recorded rather than lost. */
async function triageOne(pool, config, { bot, app, item, deps }) {
  const settings = await readSettings(pool);
  if (settings.mode === 'off') return { ran: false, reason: 'mode_off' };
  try {
    return await runTriage(pool, config, { bot, app, item, mode: settings.mode, settings, deps });
  } catch (err) {
    log.error('homeroom-bot', 'Triage threw', { app: app.slug, issueNumber: item.issue_number, err: err.message });
    await recordThrownTriage(pool, { app, item, settings, err });
    return { ran: false, reason: 'threw' };
  }
}

/**
 * A live row ended without consuming its claim (the cap, a refusal, the
 * mode): hand it back so it is taken again when that clears.
 */
async function releaseClaim(pool, itemId) {
  await pool.query('UPDATE homeroom_bot_queue SET started_at = NULL WHERE id = $1', [itemId])
    .catch((err) => log.warn('homeroom-bot', 'Could not hand a queue row back', { itemId, err: err.message }));
}

/** Run one piece of work in its slot and free the slot when it ends. */
function track(pool, slot, entry, work) {
  inFlight.set(slot, entry);
  return (async () => {
    let o;
    try {
      o = await work();
    } catch (err) {
      log.error('homeroom-bot', 'Work slot failed', { appId: entry.appId, err: err.message });
      o = { processed: 0, refusals: [], budgets: [], paused: null, stop: false };
    } finally {
      inFlight.delete(slot);
    }
    // #3703: what people said on the app while this ran is read on the very
    // next pass. A reply that lands while the bot works on its issue cannot
    // queue it (the row is claimed, and the run deletes it as it ends), and
    // the run leaves it unread on purpose (live.advanceSeen), so it used to
    // wait for the next full refresh, up to REFRESH_INTERVAL_MS.
    if (entry.lane === 'live') pendingApps.add(Number(entry.appId));
    if (o.refusals.length) lastRefusals = [...lastRefusals.filter((x) => x.app !== o.refusals[0].app), ...o.refusals];
    // The slot is free: fill it now, unless the loop is paused on the cap
    // or a fault, which the next idle pass retries.
    if (o.paused !== 'budget' && o.paused !== 'infra') requestPass();
    return o;
  })();
}

// ── Live builds, started as soon as they may ────────────────────────────
//
// A live build waiting its turn (a ready verdict, or a plan its creator
// tapped Build it under) used to be started only inside a pass's dispatch,
// after the pass's refresh, and every REFRESH_INTERVAL_MS that refresh is
// the full sweep of every app. A wake cannot cut into a running pass, so
// run five's Submit (13 Oct 2026) waited 46 s for its spec to begin. Now a
// pass starts them first, before its refresh and sweeps, and Build it's
// wake (goAhead, onBusMessage) starts them on the leader at once, even
// while a pass runs. One dispatch at a time in this process
// (liveDispatchRunning): a call that finds one running asks it to look
// again rather than reading the same waiting rows beside it, so a run is
// never started twice from the two paths; across processes only the leader
// runs the loop, as before.

// Whether a dispatch is under way in this process (set before its first
// await), whether another call asked it to look again, and a promise that
// settles when it ends, for those calls to wait on.
let liveDispatchRunning = false;
let liveDispatchAgain = false;
let liveDispatchDone = Promise.resolve();
// The dispatch Build it's wake started, for a test to wait on.
let liveKick = null;
// Test seams for the wake's dispatch: the pool and deps it uses.
let liveKickSeams = {};

/**
 * Start the live builds waiting their turn that have a slot, and return
 * the promises of the work started. Guarded like drainBuilds: a call that
 * finds a dispatch under way asks it to look again, waits for it (so what
 * it started is in its slots before the caller counts them), and returns
 * []. Never throws.
 */
async function dispatchLiveBuilds(pool, config, { settings = null, bot = null, deps = {}, seen = new Set(), now = null } = {}) {
  if (liveDispatchRunning) {
    liveDispatchAgain = true;
    await liveDispatchDone;
    return [];
  }
  liveDispatchRunning = true;
  let done;
  liveDispatchDone = new Promise((resolve) => { done = resolve; });
  const started = [];
  try {
    let given = settings;
    do {
      liveDispatchAgain = false;
      if (refusingNew()) break;
      const at = now ?? (deps.now ? deps.now() : Date.now());
      // eslint-disable-next-line no-await-in-loop
      const s = given || await readSettings(pool);
      given = null;
      if (s.mode === 'off' || faultBackoff(at) || budgetPausedUntil > Date.now()) break;
      // A build reads GitHub: held, as a pass is, while its hourly budget
      // is nearly used up (runOnce checks this before its own call).
      if (githubBudget.backgroundHold({ now: at })) break;
      // eslint-disable-next-line no-await-in-loop
      const b = bot || await ensureBotUser(pool, config);
      // eslint-disable-next-line no-await-in-loop
      started.push(...await startLiveBuilds(pool, config, { settings: s, bot: b, deps, seen }));
    } while (liveDispatchAgain);
  } catch (err) {
    log.error('homeroom-bot', 'Live build dispatch failed', { err: err.message });
  } finally {
    // In the same turn as the last look-again check: a call that arrives
    // after it starts a dispatch of its own.
    liveDispatchAgain = false;
    liveDispatchRunning = false;
    done();
  }
  return started;
}

/**
 * Build it was tapped (goAhead here, or its bus message from another Pod):
 * where the loop runs, start the build now rather than at the next pass.
 * Returns whether a dispatch was started. Never throws.
 */
function wakeLiveBuilds() {
  const running = timer !== null || passInFlight;
  if (stopped || !running || !loopConfig) return false;
  const config = loopConfig;
  let pool;
  try {
    pool = liveKickSeams.pool || require('../db/pool').getPool(config);
  } catch (err) {
    log.warn('homeroom-bot', 'Could not start a live build on its wake', { err: err.message });
    return false;
  }
  liveKick = dispatchLiveBuilds(pool, config, { deps: liveKickSeams.deps || {} })
    .then((started) => {
      if (started.length) log.info('homeroom-bot', 'Live builds started on Build it\'s wake', { started: started.length });
      return started;
    });
  return true;
}

/** One dispatch of live builds; dispatchLiveBuilds holds the guard. */
async function startLiveBuilds(pool, config, { settings, bot, deps = {}, seen }) {
  const started = [];
  // A staging copy never acts (live.liveScope), so there every app is the
  // background lane's.
  const scope = live.liveScope(settings);
  const liveAtOnce = settings.liveAtOnce || DEFAULTS.liveAtOnce;
  const perPerson = settings.perPerson || DEFAULTS.perPerson;
  // Up to BUILDS_PER_PROJECT per project, each in a slot of its own, so the
  // project's read slot stays free (buildLive).
  const buildSlots = Math.max(0, liveAtOnce - [...inFlight.values()].filter((e) => e.lane === 'live').length);
  if (buildSlots && !live.scopeIsEmpty(scope)) {
    const running = [...inFlight.values()];
    // Never a run whose build already has its slot (track sets it before
    // any await). Its run reads as waiting until buildLive links its
    // session, several awaits later, and `seen` lasts one pass, so the pass
    // the next wake started picked it again once #4544 let a project build
    // three at once: homestead #31 and #32 and kasirku #7 were each built two
    // or three times from one run, and turnly #6's requester was asked about
    // two plans. A slot frees when its work ends, whatever it came to.
    const waiting = (await liveBuildCandidates(pool, { scope, pausedApps: settings.pausedApps || [] }))
      .filter((row) => !seen.has(`build:${Number(row.id)}`) && !inFlight.has(buildSlot(row.id)));
    const picks = pickLiveBuilds(waiting, {
      buildingAppIds: running.filter((e) => e.build).map((e) => Number(e.appId)),
      active: running.filter((e) => e.lane === 'live'), slots: buildSlots, perPerson,
    });
    if (picks.length) {
      // A build spends from the bot's weekly budget like a read does, and
      // more: it is checked here, before any starts, as runTriage checks it
      // before a read. It used to be checked before reads alone, so builds
      // waiting their turn went on past a spent budget.
      const budget = await (deps.limits || require('./limits')).checkBudget(pool, bot.id);
      if (budget.error) {
        log.info('homeroom-bot', 'Builds paused on budget', { reason: budget.reason || null });
        await pauseOnBudget(pool, { settings, bot, reason: budget.reason, people: picks.map((p) => p.person_id), deps });
        return started;
      }
    }
    if (picks.length) {
      const { rows: apps } = await pool.query(
        'SELECT id, slug, name, repo_url, self_hosted FROM apps WHERE id = ANY($1::int[])',
        [picks.map((p) => Number(p.app_id))],
      );
      const byId = new Map(apps.map((a) => [Number(a.id), a]));
      const dm = deps.dm || require('./homeroom-bot-dm');
      for (const pick of picks) {
        // Shutdown began during this pass: start nothing more.
        if (refusingNew()) break;
        const app = byId.get(Number(pick.app_id));
        if (!app) continue;
        seen.add(`build:${Number(pick.id)}`);
        // Its payer's week is spent (the run's payer, else its requester):
        // it waits for the week to reset, as a request waiting to be read
        // does (runTriage), and says so once. A build the bot owes nobody
        // for (an uncharged run) is never held.
        const payerId = Number(pick.payer_user_id) || pick.person_id;
        if (pick.charged !== false && payerId
            && await dm.overWeeklyAllowance(pool, settings, payerId).catch(() => false)) {
          const requester = await dm.requesterOf(pool, app.id, Number(pick.issue_number)).catch(() => null);
          if (requester) {
            const payer = Number(payerId) === Number(requester.userId) ? null
              : await dm.personOf(pool, payerId).catch(() => null);
            await dm.noteOverAllowance(pool, { settings, requester, payer, app, issueNumber: Number(pick.issue_number), bot })
              .catch(() => {});
          }
          continue;
        }
        tray().noteWorkChanged(pick.person_id, deps);
        const item = { issue_number: pick.issue_number };
        started.push(track(pool, buildSlot(pick.id), {
          lane: 'live', build: true, appId: Number(app.id), person: pick.person, issueNumber: Number(pick.issue_number),
          runId: Number(pick.id), itemId: null, startedAt: new Date().toISOString(),
        }, async () => {
          try {
            const r = await buildOne(pool, config, { bot, app, run: pick, settings, deps });
            return outcomeOf(r, { app, item });
          } finally {
            tray().noteWorkChanged(pick.person_id, deps);
          }
        }));
      }
    }
  }

  return started;
}

/**
 * Fill the free slots, live first. Returns the promises of the work it
 * started (each resolves to its outcome). `seen` keeps one drain from
 * starting the same row twice. `firstVersionsOnly` (15 Oct 2026): only the
 * reads of projects' first versions, which runOnce starts before its full
 * refresh and sweeps; nothing of the build lane or the background lane.
 */
async function dispatch(pool, config, {
  settings, bot, backedOff = [], deps = {}, seen = new Set(), now = Date.now(), firstVersionsOnly = false,
}) {
  if (refusingNew() || settings.mode === 'off') return [];
  if (faultBackoff(now) || budgetPausedUntil > Date.now()) return [];
  const started = [];
  // A staging copy never acts (live.liveScope), so there every app is the
  // background lane's.
  const scope = live.liveScope(settings);
  const liveAtOnce = settings.liveAtOnce || DEFAULTS.liveAtOnce;

  // Live builds waiting their turn first: they are further along than
  // anything still to be read.
  if (!firstVersionsOnly) started.push(...await dispatchLiveBuilds(pool, config, { settings, bot, deps, seen, now }));

  const running = [...inFlight.values()];
  const liveActive = running.filter((e) => e.lane === 'live');
  // The apps whose one session is taken. A follow-up runs on its
  // proposal's session instead (#3703), and a build on a session of its own
  // (buildLive), so neither takes the app.
  const sessionTaken = running.filter((e) => !e.followUp && !e.build).map((e) => Number(e.appId));

  // Live: one issue per start.
  const liveSlots = Math.max(0, liveAtOnce - liveActive.length);
  if (liveSlots && !live.scopeIsEmpty(scope)) {
    const candidates = (await liveCandidates(pool, {
      scope, excludeAppIds: backedOff, busyAppIds: sessionTaken, botId: bot?.id ?? null,
      pausedApps: settings.pausedApps || [], excludeFollowUps: followUpsBackedOff(now), firstVersionsOnly,
    })).filter((row) => !seen.has(Number(row.id)));
    const picks = pickLive(candidates, {
      busyAppIds: sessionTaken, blockedAppIds: backedOff, active: liveActive,
      slots: liveSlots, perPerson: settings.perPerson || DEFAULTS.perPerson,
    });
    if (picks.length) {
      const { rows: apps } = await pool.query(
        'SELECT id, slug, name, repo_url, self_hosted FROM apps WHERE id = ANY($1::int[])',
        [picks.map((p) => Number(p.app_id))],
      );
      const byId = new Map(apps.map((a) => [Number(a.id), a]));
      for (const pick of picks) {
        if (refusingNew()) break;
        const app = byId.get(Number(pick.app_id));
        if (!app) continue;
        // Claimed before the work starts: the row is this Pod's.
        const { rows: claimed } = await pool.query(
          'UPDATE homeroom_bot_queue SET started_at = NOW() WHERE id = $1 AND started_at IS NULL RETURNING id',
          [pick.id],
        );
        if (!claimed.length) continue;
        seen.add(Number(pick.id));
        // #3692: the person it is for sees it start (and end, below) in the
        // activity tray of their DM with the bot, if it is open.
        tray().noteWorkChanged(pick.person_id, deps);
        const item = {
          id: pick.id, app_id: pick.app_id, issue_number: pick.issue_number, priority: pick.priority,
          reason: pick.reason, thread_seen_at: pick.thread_seen_at, requested_by: pick.requested_by,
          payer_user_id: pick.payer_user_id || null, followUp: !!pick.followUp,
          // Claimed just above, so runTriage does not claim it again.
          claimed: true,
        };
        started.push(track(pool, pick.followUp ? `followup:${Number(pick.id)}` : Number(app.id), {
          lane: 'live', appId: Number(app.id), person: pick.person, issueNumber: Number(pick.issue_number),
          itemId: Number(pick.id), startedAt: new Date().toISOString(), followUp: !!pick.followUp,
        }, async () => {
          try {
            const r = await triageOne(pool, config, { bot, app, item, deps });
            const o = outcomeOf(r, { app, item });
            if (['budget', 'refused', 'mode_off', NOT_FOLLOW_UP].includes(r?.reason)) await releaseClaim(pool, item.id);
            if (r?.reason === 'budget') {
              await pauseOnBudget(pool, { settings, bot, reason: r.detail, people: [pick.person_id], deps });
            }
            return o;
          } finally {
            tray().noteWorkChanged(pick.person_id, deps);
          }
        }));
      }
    }
  }

  if (firstVersionsOnly) return started;
  // Background: a batch of one app's issues per start, as before.
  const shadowActive = [...inFlight.values()].filter((e) => e.lane === 'background').length;
  for (let i = shadowActive; i < (settings.concurrency || DEFAULTS.concurrency); i += 1) {
    if (refusingNew()) break;
    const batch = await nextBatch(pool, {
      batchSize: settings.batchSize,
      excludeAppIds: [...new Set([...inFlight.values()].map((e) => Number(e.appId))), ...backedOff],
      pausedApps: settings.pausedApps || [], scope,
    });
    if (!batch || !batch.app) break;
    const items = (batch.items || []).filter((it) => !seen.has(Number(it.id)));
    if (!items.length) break;
    for (const it of items) seen.add(Number(it.id));
    const app = batch.app;
    started.push(track(pool, Number(app.id), {
      lane: 'background', appId: Number(app.id), person: `a${Number(app.id)}`, issueNumber: Number(items[0].issue_number),
      itemId: Number(items[0].id), startedAt: new Date().toISOString(),
    }, async () => {
      const total = { processed: 0, refusals: [], budgets: [], paused: null, stop: false };
      for (const item of items) {
        if (stopped) break;
        const entry = inFlight.get(Number(app.id));
        if (entry) { entry.issueNumber = Number(item.issue_number); entry.itemId = Number(item.id); }
        const r = await triageOne(pool, config, { bot, app, item, deps });
        const o = outcomeOf(r, { app, item });
        total.processed += o.processed;
        total.refusals.push(...o.refusals);
        total.budgets.push(...o.budgets);
        if (o.stop) {
          total.paused = o.paused;
          if (o.detail) total.detail = o.detail;
          if (o.retryInMs) total.retryInMs = o.retryInMs;
          break;
        }
      }
      return total;
    }));
  }
  return started;
}

/** A staging copy never acts (live.isLiveFor), so it has no live lane. */
function isStagingLoop() {
  return process.env.USERNODE_ENV === 'staging';
}

/**
 * What the bot is reading now, for the dashboard and for a person asking in
 * a DM: every claimed queue row, with its app and who it is for. Read from
 * the database, so any Pod can answer, not only the one running it. Its
 * builds are buildsNow's: they run from their runs, not from the queue.
 */
async function workingNow(pool, settings, { userId = null } = {}) {
  const scope = live.liveScope(settings);
  const { rows } = await pool.query(
    `SELECT q.app_id, q.issue_number, q.started_at, q.reason, a.slug, a.name,
            COALESCE(r.user_id, i.created_by) AS person_id, u.username AS person
       FROM homeroom_bot_queue q
       JOIN apps a ON a.id = q.app_id
       LEFT JOIN homeroom_bot_requesters r ON r.app_id = q.app_id AND r.issue_number = q.issue_number
       LEFT JOIN LATERAL (
         SELECT created_by FROM issues
          WHERE app_id = q.app_id AND github_issue_number = q.issue_number
          ORDER BY id LIMIT 1
       ) i ON TRUE
       LEFT JOIN users u ON u.id = COALESCE(r.user_id, i.created_by)
      WHERE q.started_at IS NOT NULL
        AND ($1::int IS NULL OR COALESCE(r.user_id, i.created_by) = $1)
      ORDER BY q.started_at
      LIMIT 50`,
    [userId],
  );
  return rows.map((row) => ({
    appSlug: row.slug,
    appName: row.name,
    issueNumber: Number(row.issue_number),
    since: row.started_at,
    lane: live.inScope(scope, row.slug) ? 'live' : 'background',
    kind: 'read',
    person: row.person || null,
  }));
}

// A live build is under way from the moment its session is linked (onSession)
// until its outcome is recorded; one older than this is not work under way
// (a platform build's plan and build turn, the longest, take under two
// hours, and a durable build that cannot finish ends failed). Its session is
// paused between its turns (buildTurnRunner pauses it after each), through a
// first version's review (captures and reviewer calls) above all, and that is
// still the build: run 1746's console showed nothing building for most of its
// review (run four, 13 Oct 2026).
const BUILD_UNDER_WAY_HOURS = 4;

// The live builds under way (a session linked, no outcome yet, the session
// still open) and how many wait their turn (the newest verdict on their
// issue, no session yet), for the dashboard. A plan waiting for its Build it
// is neither.
const BUILDS_UNDER_WAY_SQL = `
  SELECT r.app_id, r.issue_number, bs.created_at AS since, a.slug, a.name, u.username AS person
    FROM homeroom_bot_runs r
    JOIN chat_sessions bs ON bs.id = r.build_session_id
    JOIN apps a ON a.id = r.app_id
    LEFT JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
    LEFT JOIN users u ON u.id = q.user_id
   WHERE r.mode = 'live' AND r.verdict = 'ready' AND r.build_ok IS NULL AND r.proposal_session_id IS NULL
     AND r.awaiting_go_at IS NULL AND bs.status IN ('active', 'paused')
     AND bs.created_at > NOW() - make_interval(hours => $1)
   ORDER BY bs.created_at
   LIMIT 50`;
const BUILDS_WAITING_SQL = `
  SELECT COUNT(*)::int AS waiting
    FROM homeroom_bot_runs r
   WHERE r.mode = 'live' AND r.verdict = 'ready' AND r.live_build_waiting_at IS NOT NULL
     AND r.build_ok IS NULL AND r.build_session_id IS NULL AND r.proposal_session_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM homeroom_bot_runs n
        WHERE n.app_id = r.app_id AND n.issue_number = r.issue_number AND n.id > r.id
     )`;

/**
 * The bot's live builds for the dashboard: `building`, the ones under way,
 * in workingNow's shape with `kind: 'build'`, and `waiting`, how many wait
 * their turn. Read from the database, so any Pod can answer. Never throws:
 * nothing to show is empty.
 */
async function buildsNow(pool) {
  try {
    const [{ rows: building }, { rows: [waiting] }] = await Promise.all([
      pool.query(BUILDS_UNDER_WAY_SQL, [BUILD_UNDER_WAY_HOURS]),
      pool.query(BUILDS_WAITING_SQL),
    ]);
    return {
      building: building.map((row) => ({
        appSlug: row.slug,
        appName: row.name,
        issueNumber: Number(row.issue_number),
        since: row.since,
        lane: 'live',
        kind: 'build',
        person: row.person || null,
      })),
      waiting: Number(waiting?.waiting) || 0,
    };
  } catch (err) {
    log.warn('homeroom-bot', 'Builds under way read failed', { err: err.message });
    return { building: [], waiting: 0 };
  }
}

// ── The work loop ───────────────────────────────────────────────────────

/**
 * One pass: take the loop lock, refresh the queue when due, drain up to
 * `concurrency` app batches, release. Returns what it did so a test can
 * drive it directly and so the scheduler knows whether to come straight
 * back or idle. Never throws.
 */
async function runOnce(pool, config, deps = {}) {
  const out = { mode: null, busy: false, refreshed: false, processed: 0, paused: null };
  const startedAt = Date.now();
  let client;
  let locked = false;
  try {
    client = await pool.connect();
    const lock = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired', [HOMEROOM_BOT_LOCK, 0],
    );
    if (lock.rows[0]?.acquired !== true) { out.busy = true; return out; }
    locked = true;
    passStartedAt = new Date(startedAt).toISOString();

    const settings = await readSettings(pool);
    out.mode = settings.mode;
    if (settings.mode === 'off') return out;

    // Before anything is picked: a row an unfinished pass claimed is free again.
    out.releasedClaims = await releaseStaleClaims(pool, settings, {
      keepIds: [...inFlight.values()].map((e) => e.itemId),
    });

    const now = deps.now ? deps.now() : Date.now();
    // Every pass reads GitHub (the queue refresh, then the work it starts),
    // and it is background work. While GitHub's hourly budget is nearly used
    // up the pass waits for the reset, so people's own work keeps the
    // reserve (services/github-budget.js). Wakes stay queued for that pass.
    const githubHold = githubBudget.backgroundHold({ now });
    if (githubHold) {
      out.paused = 'github';
      out.retryInMs = githubHold.retryInMs;
      return out;
    }
    // Shutting down: no refresh and no new work on a pool about to close.
    if (stopped) { out.paused = 'stopped'; return out; }
    // Take the wakes that arrived before this pass. Ones that arrive DURING
    // it are left for the next, which tick() schedules at once.
    const targeted = [...pendingApps];
    pendingApps.clear();
    const forceAll = !!deps.forceRefresh || refreshAllRequested;
    refreshAllRequested = false;
    wakeRequested = false;
    // Before the refresh: on a live app it asks how much room the caps have
    // for the bot's held issues (#3152).
    const bot = await ensureBotUser(pool, config);
    // Run five (13 Oct 2026): a build waiting its turn starts before the
    // refresh and the sweeps, which every REFRESH_INTERVAL_MS read every app
    // and held a Submit's spec back 46 s. The pass's dispatch below fills
    // what is left, the slots its reads take counted after these.
    const seen = new Set();
    const pausedBefore = budgetPausedUntil > Date.now();
    const early = await dispatchLiveBuilds(pool, config, { settings, bot, deps, seen, now });
    out.liveBuilds = early.length;
    // An app inside its backoff window is skipped exactly like a paused one
    // (#2737). Without this, a session that refuses every turn is retried on
    // every wake, which is how one wedged app wrote 121 rows in a day.
    const backedOff = [];
    for (const [appId] of appBackoff) {
      if (backoffFor(appId, now)) backedOff.push(Number(appId));
      else appBackoff.delete(appId);
    }
    out.backedOffApps = backedOff.length;
    // Newcomer run nine (15 Oct 2026): a woken project whose first version
    // was just filed is refreshed and its request's read started here,
    // before the full refresh and the sweeps, which every
    // REFRESH_INTERVAL_MS read every app first: 14.6 s from filing to its
    // run, against about 4 s in runs seven and eight. Its read alone; the
    // rest of the pass is as it was.
    const firstReads = targeted.length
      ? await firstVersionsToRead(pool, targeted).catch((err) => {
        log.warn('homeroom-bot', 'Could not read which woken projects wait on their first version', { err: err.message });
        return [];
      })
      : [];
    if (firstReads.length) {
      const summary = await refreshApps(pool, settings, firstReads, { ...deps, bot });
      out.refreshed = true;
      if (summary.queued) log.info('homeroom-bot', 'First versions queued ahead of the pass', summary);
      const reads = await dispatch(pool, config, { settings, bot, backedOff, deps, seen, now, firstVersionsOnly: true });
      out.firstVersionReads = reads.length;
      early.push(...reads);
    }
    // A pass that was not already paused says what it dispatched, even when
    // these builds found the budget spent and it stops below.
    if (!pausedBefore) out.dispatched = early.length;
    if (forceAll || now - lastRefreshAt >= REFRESH_INTERVAL_MS) {
      // #3624: a project waiting for its first version whose creation hook
      // missed it is filed here, before the refresh that queues it.
      try {
        const filed = await (deps.dm || require('./homeroom-bot-dm')).sweepFirstVersions(pool, config, deps);
        if (filed) log.info('homeroom-bot', 'First versions filed', { filed });
      } catch (err) {
        log.warn('homeroom-bot', 'First-version sweep failed', { err: err.message });
      }
      const summary = await refreshQueue(pool, settings, { ...deps, bot });
      lastRefreshAt = now;
      out.refreshed = true;
      if (summary.queued) log.info('homeroom-bot', 'Queue refreshed', summary);
    } else if (targeted.length) {
      // The first versions' projects were refreshed above.
      const rest = targeted.filter((id) => !firstReads.includes(Number(id)));
      const summary = rest.length ? await refreshApps(pool, settings, rest, { ...deps, bot }) : { queued: 0 };
      out.refreshed = true;
      out.woken = targeted.length;
      if (summary.queued) log.info('homeroom-bot', 'Queue refreshed on activity', summary);
    }

    // Free what the bot's own sessions still hold, on the refresh cadence
    // (#3122). Runs before the fault check on purpose: a full quota is
    // exactly when freeing a volume helps.
    if (now - lastVolumeSweepAt >= REFRESH_INTERVAL_MS) {
      lastVolumeSweepAt = now;
      try {
        const freed = await releaseBotVolumes(pool, bot, deps);
        if (freed.length) out.volumesFreed = freed.length;
      } catch (err) {
        log.warn('homeroom-bot', 'Bot volume sweep failed', { err: err.message });
      }
    }

    // A live build nothing finished is recorded and said, on the same
    // cadence: it only has to be noticed, not raced.
    if (now - lastLiveSweepAt >= REFRESH_INTERVAL_MS) {
      lastLiveSweepAt = now;
      // A build a restart caught is its work item's to carry on
      // (services/build-runs.js): nothing here resumes or settles one.
      // Review screenshots past their keeping (a few times a day).
      await botConfigs().maybePruneCaptureArtifacts(pool, now);
      // B6: and a plan nobody tapped Build it under for a week stops waiting.
      const stalePlans = await settleStalePlans(pool, { dm: deps.dm });
      if (stalePlans) out.plansStopped = stalePlans;
      // #4175: and a first version's plan that could not be sent is sent again.
      const resent = await retryUnsentPlans(pool, bot, { dm: deps.dm, ws: deps.ws || null });
      if (resent.sent || resent.unsent || resent.stopped) out.plansResent = resent;
      // A change that passed its checks and waited longer than it should on
      // its before & after shots is offered as ready to try anyway.
      const heldReady = await (deps.dm || require('./homeroom-bot-dm')).sweepHeldReady?.(pool, { ws: deps.ws || null });
      if (heldReady) out.heldReadyLooked = heldReady;
      // #4242: and a build that succeeded and became no proposal is said.
      const unproposed = await (deps.dm || require('./homeroom-bot-dm')).sweepUnproposedBuilds?.(pool, { ws: deps.ws || null });
      if (unproposed) out.unproposedLooked = unproposed;
    }

    // Inside a platform-fault backoff nothing is dispatched (#3122). A wake
    // still refreshes the queue above, but cannot restart the retry storm.
    const fault = faultBackoff(now);
    if (fault) {
      out.paused = 'infra';
      out.detail = fault.error;
      out.retryInMs = fault.remainingMs;
      return out;
    }

    // The weekly cap ran out under a piece of work: wait for the idle pass.
    if (budgetPausedUntil > Date.now()) {
      out.paused = 'budget';
      out.inFlight = inFlight.size;
      return out;
    }
    // #3624 stage 2: fill the free slots and, unless a test asks to drain,
    // return without waiting for the work (see "How much at once").
    const drain = deps.drain !== false;
    let started = [...early, ...await dispatch(pool, config, { settings, bot, backedOff, deps, seen, out, now })];
    out.dispatched = started.length;
    if (!drain) {
      out.inFlight = inFlight.size;
      out.refusals = currentRefusals(now);
      return out;
    }
    out.processed = 0;
    out.refusals = [];
    out.budgets = [];
    while (started.length) {
      const outcomes = await Promise.all(started);
      for (const o of outcomes) {
        out.processed += o.processed;
        out.refusals.push(...o.refusals);
        out.budgets.push(...o.budgets);
        if (o.paused && !out.paused) {
          out.paused = o.paused;
          if (o.detail) out.detail = o.detail;
          if (o.retryInMs) out.retryInMs = o.retryInMs;
        }
      }
      if (out.paused || stopped) break;
      const live = await readSettings(pool);
      if (live.mode === 'off') { out.paused = 'mode_off'; break; }
      started = await dispatch(pool, config, { settings: live, bot, backedOff, deps, seen, out, now });
      out.dispatched += started.length;
    }
    lastRefusals = out.refusals;
    out.inFlight = inFlight.size;
    return out;
  } catch (err) {
    log.error('homeroom-bot', 'Pass failed', { err: err.message });
    return out;
  } finally {
    // `at` is when it ended, as before; `startedAt` and `ms` say how long
    // the live loop's pass took (a lock another process held is no pass).
    if (locked) passStartedAt = null;
    lastPass = { at: new Date().toISOString(), startedAt: new Date(startedAt).toISOString(), ms: Date.now() - startedAt, ...out };
    if (client) {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [HOMEROOM_BOT_LOCK, 0]).catch(() => {});
      }
      client.release();
    }
  }
}

function schedule(config, delayMs) {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; tick(config); }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

async function tick(config) {
  if (stopped || passInFlight) return;
  passInFlight = true;
  let delay = IDLE_PASS_DELAY_MS;
  try {
    const { getPool } = require('../db/pool');
    // The work runs in its own slots; the pass only fills them.
    const out = await runOnce(getPool(config), config, { drain: false });
    if (out.processed > 0 && !out.paused && out.mode !== 'off') delay = BUSY_PASS_DELAY_MS;
    // A platform fault waits out its backoff rather than the 30-second idle.
    if (out.paused === 'infra' && out.retryInMs > 0) delay = Math.max(IDLE_PASS_DELAY_MS, out.retryInMs);
    // And a GitHub budget hold waits for the hour to reset.
    if (out.paused === 'github' && out.retryInMs > 0) delay = Math.max(IDLE_PASS_DELAY_MS, out.retryInMs);
    // A wake that landed while this pass ran is not made to wait out the
    // idle delay; a pass that paused (budget, fault) is not spun by it.
    if (wakeRequested && !out.paused && out.mode !== 'off') delay = 0;
  } catch (err) {
    log.error('homeroom-bot', 'Tick failed', { err: err.message });
  } finally {
    passInFlight = false;
    schedule(config, delay);
  }
}

/** Started from becomeLeader(): the loop is a singleton across Pods. */
function start(config) {
  if (timer) return;
  stopped = false;
  loopConfig = config;
  // Before the first pass: builds from before builds were durable are asked
  // for again, and the durable builds under way (a restart's) hold their
  // slots again, so the first dispatch counts them.
  {
    const { getPool } = require('../db/pool');
    const pool = getPool(config);
    void requeueLegacyBuilds(pool).then(() => holdDurableBuildSlots(pool)).catch(() => {});
  }
  schedule(config, FIRST_PASS_DELAY_MS);
  // The build lane, on its own timer: a build never holds up a triage pass.
  buildLaneOn = true;
  scheduleBuilds(config, FIRST_PASS_DELAY_MS);
  // #3772: the DM answers a process that is gone had promised to ask again.
  const resume = setTimeout(() => {
    if (stopped) return;
    const { getPool } = require('../db/pool');
    require('./homeroom-bot-mayor').resumeDeferred(getPool(config), config);
  }, FIRST_PASS_DELAY_MS);
  if (typeof resume.unref === 'function') resume.unref();
  // And every minute after: the web processes answer DMs and never lead
  // (docs/plans/web-and-conductor.md), so one that died left its promises
  // with no election to pick them up. What a live process holds is its own.
  if (!deferResumeTimer) {
    deferResumeTimer = setInterval(() => {
      if (refusingNew()) return;
      const { getPool } = require('../db/pool');
      require('./homeroom-bot-mayor').resumeDeferred(getPool(config), config, {}, { minAgeSeconds: 60 });
    }, DEFER_RESUME_MS);
    if (typeof deferResumeTimer.unref === 'function') deferResumeTimer.unref();
  }
}

/**
 * True once the loops are stopped or shutdown has begun (lifecycle, set
 * first thing in server.js cleanup): no new read, build, follow-up or checks
 * fix starts. A durable build under way is not new: in a process a release
 * replaced it goes on to its end there, its own steps included (its promote
 * passes the drain guard: lifecycle.js OWN_WORK), and the drain waits for
 * it (docs/plans/draining-releases.md). Only a process that stops at once,
 * or one whose drain ran out, gives its work item up at the next step, and
 * the next leader carries it on (services/build-runs.js).
 */
function refusingNew() {
  if (stopped) return true;
  try { return !!require('./lifecycle').isShuttingDown(); } catch { return false; }
}

/**
 * Stops both loops; nothing new starts. A durable build under way is its
 * work item's: it finishes in this process while it drains, and only what
 * the workflow runtime gives up as it stops (no drain, or its deadline) is
 * carried on by the next leader. server.js calls it first thing on
 * shutdown, before the pool closes: a pass or lane drain that started after
 * that read and wrote a closed pool (93 "Cannot use a pool after calling end
 * on the pool" lines from 10-03 to 10-05, and one live build lost at
 * dispatch).
 */
function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  if (deferResumeTimer) clearInterval(deferResumeTimer);
  deferResumeTimer = null;
  buildLaneOn = false;
  if (buildTimer) clearTimeout(buildTimer);
  buildTimer = null;
}

// ── Wakes ────────────────────────────────────────────────────────────────
//
// The loop runs on the leader Pod only; an issue event can land on any Pod.
// So a wake has two halves: the local one (below) records what changed and
// pulls the next pass forward, and the bus half tells the other Pods the
// same thing — the leader among them does the local half on receipt. A Pod
// that is not running the loop records nothing, so the pending set cannot
// grow on the Pods that never drain it.

/** Record that `appId`'s issues changed (or `all` did) and run a pass now. */
function wake({ appId = null, all = false } = {}) {
  const running = timer !== null || passInFlight;
  if (stopped || !running) return false;
  if (all) refreshAllRequested = true;
  else if (Number.isInteger(Number(appId)) && Number(appId) > 0) pendingApps.add(Number(appId));
  else return false;
  wakeRequested = true;
  // Idle (a timer waiting): pull the pass forward. In a pass: tick() sees
  // wakeRequested and schedules the next one at once.
  if (!passInFlight && loopConfig) schedule(loopConfig, 0);
  return true;
}

function publishWake(data) {
  try {
    require('./ws-bus').publish(BUS_KIND, null, data);
  } catch (err) {
    log.warn('homeroom-bot', 'wake publish failed', { err: err.message });
  }
}

/** The whole queue is stale (the mode was switched on): every Pod hears. */
function wakeAll() {
  wake({ all: true });
  publishWake({ all: true });
}

/**
 * An issue was filed, edited or discussed on the platform. Called from the
 * places that already know (routes/issues.js on create, ws.pushIssueUpdate
 * on edits and unclaims, ws.handleMessage on a thread post); never throws,
 * never waits — the event has already happened and the bot is a follower.
 */
function noteIssueActivity({ appId, issueNumber, reason = 'activity' } = {}) {
  const id = Number(appId);
  const n = Number(issueNumber);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(n) || n <= 0) return false;
  interruptRead({ appId: id, issueNumber: n, reason });
  wake({ appId: id });
  if (SETTLE_REASONS.has(reason)) wakeAfterSettle(id);
  publishWake({ appId: id, issueNumber: n, reason: String(reason).slice(0, 40) });
  return true;
}

/**
 * A person's message waits SETTLE_MS before a turn reads it (liveCandidates),
 * so the loop is woken again once it has: the idle poll would find it too,
 * up to IDLE_PASS_DELAY_MS later. Only where the loop runs (wake answers
 * false elsewhere, and the leader schedules its own from the bus).
 */
function wakeAfterSettle(appId) {
  const t = setTimeout(() => { wake({ appId }); }, SETTLE_MS + 1000);
  if (typeof t?.unref === 'function') t.unref();
}

/**
 * #3264: somebody wrote in a proposal's discussion. When that proposal is
 * the bot's own and still up for a vote, it is activity on the issue it
 * answers; any other proposal's thread is none of the bot's business and
 * costs one indexed lookup. Never throws.
 */
async function noteProposalActivity(pool, { appId, sessionId, deps = {} } = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT cs.linked_issues, u.id AS bot_id, u.username AS bot_username, a.slug
         FROM chat_sessions cs JOIN users u ON u.id = cs.user_id JOIN apps a ON a.id = cs.app_id
        WHERE cs.id = $1 AND cs.app_id = $2 AND cs.status = 'promoted' AND u.username = $3`,
      [Number(sessionId), Number(appId), BOT_USERNAME],
    );
    const issueNumber = Array.isArray(rows[0]?.linked_issues) ? rows[0].linked_issues[0] : null;
    if (!issueNumber) return false;
    // #4610: on a project the bot is paused on, nothing will read this
    // message (refreshQueue skips the app): the person hears why, once.
    const settings = await readSettings(pool).catch(() => null);
    if (settings && settings.mode !== 'off' && (settings.pausedApps || []).includes(rows[0].slug)) {
      await noteFollowUpWait(pool, {
        app: { id: Number(appId), slug: rows[0].slug }, issueNumber: Number(issueNumber),
        bot: { id: rows[0].bot_id, username: rows[0].bot_username }, why: 'paused', sessionId: Number(sessionId),
        ws: deps.ws || null,
      });
    }
    // With the bot's voice on in changes' discussions, it answers there
    // itself (homeroom-bot-voice.js), and a change asked for is queued as an
    // ask: a message is no reason to look at the change again.
    if (voiceModule(deps).voiceOn(settings, { type: 'session' })) return false;
    return noteIssueActivity({ appId, issueNumber, reason: 'proposal_thread' });
  } catch (err) {
    log.warn('homeroom-bot', 'Proposal activity check failed', { err: err.message });
    return false;
  }
}

/** ws._onBusMessage hands BUS_KIND envelopes here. */
function onBusMessage(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.builds) return wakeBuilds();
  // The activity may have landed on another Pod than the one reading.
  if (data.issueNumber != null) interruptRead({ appId: data.appId, issueNumber: data.issueNumber, reason: data.reason });
  const woke = wake({ appId: data.appId, all: !!data.all });
  if (woke && SETTLE_REASONS.has(data.reason)) wakeAfterSettle(Number(data.appId));
  // Build it on another Pod (goAhead): its build starts now, not at the
  // next pass's dispatch.
  const built = data.buildRunId != null && wakeLiveBuilds();
  return woke || built;
}

// ── The dashboard's read and writes ─────────────────────────────────────

const RUNS_PAGE = 50;

// One static statement, filters as nullable parameters, so the SQL lint's
// inventory stays static and the shadow database checks every column. The
// dashboard's page and the CSV export are the same query at different page
// sizes — `$3` is a keyset cursor (`id <`) over the `id DESC` order, which
// is what lets the export walk the whole ledger a chunk at a time.
const RUNS_SQL = `SELECT r.id, r.issue_number, r.mode, r.verdict, r.determined, r.missing_fact,
            r.budget_stop,
            r.question, r.question_default, r.build_note, r.reason, r.cap_suppressed,
            r.rating, r.rating_note, r.rated_at, r.thread_seen_at, r.model, r.cost_usd::float8 AS cost_usd,
            r.input_tokens, r.output_tokens, r.duration_ms, r.error, r.unreadable_reply, r.created_at,
            r.proposal_session_id,
            r.build_ok, r.build_branch, r.build_sha, r.build_commits, r.build_error,
            r.build_cost_usd::float8 AS build_cost_usd, r.build_at, r.build_queued_at, r.build_spec_md,
            r.build_session_id, r.build_no_change, r.live_build_waiting_at, r.awaiting_go_at,
            r.question_answers, dm.dm_sent_at, dm.dm_answered_at, r.checks_head_sha,
            r.label_verdict, r.build_model,
            r.bot_config_version_id, bc.key AS bot_config_key, bc.label AS bot_config_label,
            bc.version AS bot_config_version, r.review_rounds, r.review_stop, r.read_reason, r.reused_run_id,
            r.charged, r.payer_user_id, pu.username AS payer_username,
            a.slug AS app_slug, a.name AS app_name, a.repo_url, u.username AS rated_by
       FROM homeroom_bot_runs r
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN users u ON u.id = r.rating_by
       LEFT JOIN bot_config_versions bc ON bc.id = r.bot_config_version_id
       -- Whose weekly building time it counts toward when it is charged
       -- (homeroom-bot-dm.js weeklySpentCents): its payer, else the requester.
       LEFT JOIN homeroom_bot_requesters rq ON rq.app_id = r.app_id AND rq.issue_number = r.issue_number
       LEFT JOIN users pu ON pu.id = COALESCE(r.payer_user_id, rq.user_id)
       -- #3624: whether this run's news reached the requester's DM, and when
       -- they answered its question there (homeroom-bot-dm.js records each
       -- DM it sends, with its run).
       LEFT JOIN LATERAL (
         SELECT MIN(d.created_at) AS dm_sent_at, MIN(d.answered_at) AS dm_answered_at
           FROM homeroom_bot_dm_messages d
          WHERE d.run_id = r.id
       ) dm ON TRUE
      WHERE ($1::text IS NULL OR a.slug = $1::text)
        AND ($2::text IS NULL OR r.verdict = $2::text)
        AND ($3::int IS NULL OR r.id < $3::int)
        AND (NOT $5::boolean OR r.budget_stop IS NOT NULL)
      ORDER BY r.id DESC
      LIMIT $4`;

/**
 * A shadow build's branch against the repository's default branch, on
 * GitHub, for a spot check. Built from the app's own repo_url and the
 * branch the platform named; null when either is missing.
 */
function buildUrlFor(row) {
  if (!row.repo_url || !row.build_branch) return null;
  return `${String(row.repo_url).replace(/\.git$/, '')}/compare/${encodeURIComponent(row.build_branch).replace(/%2F/g, '/')}`;
}

/** The issue this run triaged, on GitHub. Null when the app has no repo. */
function issueUrlFor(row) {
  return row.repo_url
    ? `${String(row.repo_url).replace(/\.git$/, '')}/issues/${row.issue_number}`
    : null;
}

// The CSV's columns, in order: the whole record, so the file can answer
// questions the dashboard cannot (how often `ready` was rated wrong, what a
// verdict costs by app, which questions repeat). `repo_url` is left out —
// `issue_url` already carries it in the form a reader wants.
const EXPORT_COLUMNS = Object.freeze([
  'id', 'created_at', 'app_slug', 'app_name', 'issue_number', 'issue_url',
  'mode', 'verdict', 'determined', 'missing_fact',
  'question', 'question_default', 'build_note', 'reason', 'cap_suppressed',
  'rating', 'rating_note', 'rated_by', 'rated_at',
  'model', 'cost_usd', 'input_tokens', 'output_tokens', 'duration_ms',
  'error', 'budget_stop', 'thread_seen_at',
  // #3146: the proposal a live `ready` run opened. Last, so an analysis
  // that reads the earlier columns by position is not shifted.
  'proposal_session_id',
  // Shadow builds, after everything else for the same reason.
  'build_ok', 'build_branch', 'build_url', 'build_sha', 'build_commits', 'build_error',
  'build_cost_usd', 'build_at', 'build_queued_at',
  // The spec the build worked from, live or shadow.
  'build_spec_md',
  // #3385: the build's session, to look a build up by.
  'build_session_id',
  // #3624's DM: a question's suggested answers (joined with " | "), when
  // the run's news was sent to the requester's DM, and when they answered
  // its question there. Empty when it was never sent, or never answered.
  'question_answers', 'dm_sent_at', 'dm_answered_at',
  // The failing head a checks follow-up looked at.
  'checks_head_sha',
  // #3654: the verdict a labeller says was right, and the build's model.
  'label_verdict', 'build_model',
  // What started the read ('new', 'changed:github', 'retry_failed', …).
  'read_reason',
  // The held run whose verdict this one reused, with no read of its own.
  'reused_run_id',
]);

/** A question's suggested answers as one cell: "Yes | No | Later". */
function answersCell(value) {
  if (!Array.isArray(value)) return value == null ? null : String(value);
  const answers = value.map((a) => String(a == null ? '' : a).replace(/\s+/g, ' ').trim()).filter(Boolean);
  return answers.length ? answers.join(' | ') : null;
}

/** One run as the values of EXPORT_COLUMNS, in that order. */
function exportRow(row) {
  const flat = {
    ...row, issue_url: issueUrlFor(row), build_url: buildUrlFor(row), question_answers: answersCell(row.question_answers),
  };
  return EXPORT_COLUMNS.map((key) => {
    const v = flat[key];
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString();
    return v;
  });
}

// How many rows one export query takes. Bounded so a ledger of any size
// streams in constant memory; not a cap on how many rows the file holds.
const EXPORT_CHUNK = 500;

/**
 * Every run matching the filters, oldest page last, a chunk at a time.
 *
 * Keyset paging rather than OFFSET: rows are only ever appended, so `id <`
 * the last id of the previous chunk cannot skip or repeat a row while the
 * export runs. Caller writes each chunk out and never holds the whole set.
 */
async function* iterateRunsForExport(pool, {
  app = null, verdict = null, chunk = EXPORT_CHUNK, budgetOnly = false,
} = {}) {
  const size = Math.min(Math.max(Number(chunk) || EXPORT_CHUNK, 1), 2000);
  let cursor = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await pool.query(RUNS_SQL, [app || null, verdict || null, cursor, size, !!budgetOnly]);
    if (!rows.length) return;
    yield rows;
    if (rows.length < size) return;
    cursor = rows[rows.length - 1].id;
  }
}

/**
 * #4533: why a queue row that is not running waits, and until when, or null
 * when it is simply next in line: { reason, until } (`until` null when the
 * wait has no clock), and the first version's request number for
 * `first_version_pending`. In the order the loop meets them:
 *   - its own refusal (`wait_reason`, recorded by runTriage's recordRefusal
 *     with its backoff), then its payer's week (`allowance`, held_until),
 *     then the whole bot's pause on a platform fault (`platform_fault`,
 *     faultBackoff, known on the Pod running the loop);
 *   - `bot_paused`: the bot is off (`off`), or its weekly budget is spent
 *     (`budgetUntil`; dispatch starts nothing until then);
 *   - `app_paused`: its app is on the paused list (`row.app_paused`);
 *   - `first_version_pending`: its project's first version is not live yet
 *     (FIRST_VERSION_PENDING_SQL; never the first version's own request, a
 *     follow-up or an admin's Run now, as liveCandidates reads it);
 *   - `build_pending`: a live build of the same request waits or runs
 *     (liveCandidates' NOT EXISTS), read once it ends;
 *   - `session_busy`: something else runs on its app's one session, or the
 *     app is backed off (`busyApps`: Map(app id → until ms or null)); never
 *     a follow-up, which runs on its proposal's session;
 *   - `per_person`: the person it is for already has `perPerson` pieces of
 *     live work running (`personCounts`: Map(person key → count));
 *   - `settling`: a person wrote on it under SETTLE_MS ago (`settle_from`),
 *     so it is read once they pause.
 * A wait whose time has passed is no wait. Pure.
 */
function queueWait(row, {
  fault = null, now = Date.now(), off = false, budgetUntil = 0,
  busyApps = new Map(), personCounts = new Map(), perPerson = DEFAULTS.perPerson,
} = {}) {
  if (!row || row.started_at) return null;
  const at = (ms) => new Date(ms).toISOString();
  const own = toMs(row.wait_until);
  if (row.wait_reason && own > now) return { reason: String(row.wait_reason), until: at(own) };
  const held = toMs(row.held_until);
  if (held > now) return { reason: 'allowance', until: at(held) };
  if (fault && Number(fault.until) > now) return { reason: 'platform_fault', until: at(Number(fault.until)) };
  if (off) return { reason: 'bot_paused', until: null };
  if (Number(budgetUntil) > now) return { reason: 'bot_paused', until: at(Number(budgetUntil)) };
  if (row.app_paused) return { reason: 'app_paused', until: null };
  const followUp = row.follow_up_session_id != null;
  if (row.first_version_pending && !followUp && row.reason !== 'admin') {
    const n = Number(row.first_version_issue);
    return { reason: FIRST_VERSION_HOLD, until: null, firstVersionIssue: Number.isInteger(n) && n > 0 ? n : null };
  }
  if (row.build_pending) return { reason: 'build_pending', until: null };
  if (!followUp && busyApps instanceof Map && busyApps.has(Number(row.app_id))) {
    const until = Number(busyApps.get(Number(row.app_id)));
    return { reason: 'session_busy', until: until > now ? at(until) : null };
  }
  if (personCounts instanceof Map && (personCounts.get(personKeyOf(row)) || 0) >= Math.max(1, Number(perPerson) || 1)) {
    return { reason: 'per_person', until: null };
  }
  const settle = toMs(row.settle_from) + SETTLE_MS;
  if (row.settle_from && settle > now) return { reason: 'settling', until: at(settle) };
  return null;
}

// How many queued rows the console and get_homeroom_bot list: the first
// QUEUE_LISTED waiting, in the order they are read, and every running one
// (at most 24 run at once, liveAtOnce's ceiling, with room for the
// background lane).
const QUEUE_LISTED = 12;
const QUEUE_RUNNING_LISTED = 40;

// One statement, so one snapshot: the counts (window functions, taken before
// the list is cut) and the rows listed always describe the same queue. Each
// listed row carries what queueWait needs from the database, read with the
// rules liveCandidates applies.
const QUEUE_SNAPSHOT_SQL = `
  WITH snap AS (
    SELECT q.*,
           COUNT(*) FILTER (WHERE q.started_at IS NULL) OVER ()::int AS waiting_total,
           COUNT(*) FILTER (WHERE q.started_at IS NOT NULL) OVER ()::int AS running_total,
           ROW_NUMBER() OVER (PARTITION BY (q.started_at IS NULL)
                              ORDER BY q.started_at DESC, (q.priority = 0) DESC, q.priority, q.enqueued_at, q.id) AS rn
      FROM homeroom_bot_queue q
  )
  SELECT q.id, q.app_id, q.issue_number, q.priority, q.reason, q.enqueued_at, q.started_at,
         q.held_until, q.wait_reason, q.wait_until, q.waiting_total, q.running_total,
         a.slug AS app_slug, a.name AS app_name,
         (a.slug = ANY($1::text[])) AS app_paused,
         COALESCE(r.user_id, i.created_by) AS person_id,
         fu.id AS follow_up_session_id,
         fvh.issue_number AS first_version_issue,
         (fvh.app_id IS NOT NULL) AS first_version_pending,
         EXISTS (
           SELECT 1 FROM homeroom_bot_runs b
            WHERE b.app_id = q.app_id AND b.issue_number = q.issue_number
              AND b.mode = 'live' AND b.verdict = 'ready' AND b.build_ok IS NULL AND b.proposal_session_id IS NULL
              AND (b.live_build_waiting_at IS NOT NULL OR b.build_session_id IS NOT NULL)
              AND b.created_at > NOW() - make_interval(days => $2)
         ) AS build_pending,
         (SELECT MAX(m.created_at) FROM chat_messages m
            LEFT JOIN users mu ON mu.id = m.user_id
           WHERE m.app_id = q.app_id AND m.msg_type = 'message' AND m.deleted_at IS NULL
             AND mu.is_synthetic IS NOT TRUE
             AND ((m.thread_type = 'issue' AND m.thread_ref = q.issue_number)
               OR (fu.id IS NOT NULL AND m.thread_type = 'session' AND m.thread_ref = fu.id))
             AND m.created_at > NOW() - make_interval(secs => $3)) AS settle_from
    FROM snap q
    JOIN apps a ON a.id = q.app_id
    LEFT JOIN homeroom_bot_requesters r ON r.app_id = q.app_id AND r.issue_number = q.issue_number
    LEFT JOIN LATERAL (
      SELECT created_by FROM issues
       WHERE app_id = q.app_id AND github_issue_number = q.issue_number
       ORDER BY id LIMIT 1
    ) i ON TRUE
    LEFT JOIN LATERAL (
      SELECT cs.id FROM chat_sessions cs
       WHERE cs.app_id = q.app_id AND cs.user_id = $4
         AND q.issue_number = ANY(cs.linked_issues)
         AND cs.status = 'promoted' AND cs.is_headless = FALSE
       ORDER BY cs.id DESC LIMIT 1
    ) fu ON TRUE
    LEFT JOIN LATERAL (
      SELECT fv.app_id, fv.issue_number FROM homeroom_bot_first_versions fv
       WHERE fv.app_id = q.app_id AND fv.bot_builds AND fv.issue_number IS DISTINCT FROM q.issue_number
         AND ${FIRST_VERSION_PENDING_SQL}
       LIMIT 1
    ) fvh ON TRUE
   WHERE (q.started_at IS NULL AND q.rn <= $5) OR (q.started_at IS NOT NULL AND q.rn <= $6)
   ORDER BY q.started_at DESC NULLS LAST, q.rn`;

/**
 * The queue as the console and get_homeroom_bot show it, from one snapshot:
 * { depth (waiting), running, items, listedWaiting, listedRunning }, the
 * running rows first, each waiting row with why it waits (queueWait).
 * `depth` keeps its name: it has always been the rows not running.
 */
async function queueSnapshot(pool, settings = {}, { botId = null, now = Date.now(), memory = null } = {}) {
  const { rows } = await pool.query(QUEUE_SNAPSHOT_SQL, [
    settings.pausedApps || [], ABANDONED_LIVE_WINDOW_DAYS, SETTLE_MS / 1000,
    botId, QUEUE_LISTED, QUEUE_RUNNING_LISTED,
  ]);
  const mem = memory || memoryStatus(now);
  const running = rows.filter((q) => q.started_at);
  // The apps whose one session is taken: a read running there (not a
  // follow-up, which runs on its proposal's), from the snapshot and from
  // the loop's own record, and the apps backed off after a refusal.
  const busyApps = new Map();
  for (const q of running) if (q.follow_up_session_id == null) busyApps.set(Number(q.app_id), null);
  for (const e of mem.inFlight) if (!e.followUp && !e.build) busyApps.set(Number(e.appId), null);
  for (const [appId, until] of mem.backoff) if (Number(until) > now) busyApps.set(Number(appId), Number(until));
  // Live work running per person: the reads running, and the builds the
  // loop runs (they run from their runs, not the queue).
  const personCounts = new Map();
  const bump = (key) => personCounts.set(key, (personCounts.get(key) || 0) + 1);
  for (const q of running) bump(personKeyOf(q));
  for (const e of mem.inFlight) if (e.build && e.lane === 'live' && e.person) bump(e.person);
  const ctx = {
    fault: mem.fault, now, off: settings.mode === 'off', budgetUntil: mem.budgetUntil,
    busyApps, personCounts, perPerson: settings.perPerson || DEFAULTS.perPerson,
  };
  const items = rows.map(({ waiting_total: _w, running_total: _r, ...q }) => ({ ...q, waiting: queueWait(q, ctx) }));
  return {
    depth: Number(rows[0]?.waiting_total) || 0,
    running: Number(rows[0]?.running_total) || 0,
    items,
    listedWaiting: items.length - running.length,
    listedRunning: running.length,
  };
}

// What the loop keeps in memory and the console and get_homeroom_bot show,
// as one plain object: the last pass and its refusals, what runs, the apps
// backed off, the platform fault, the budget pause and the build lane's
// last drain. The process running the loop publishes it
// (services/leader-status.js); one that does not (a web process, which never
// leads: docs/plans/web-and-conductor.md) reads that copy (loopMemory).
const MEMORY_STATUS_KEY = 'homeroom-bot';

function memoryStatus(now = Date.now()) {
  const fault = faultBackoff(now);
  return {
    // A refusal shows while its app is still backed off (#3624 stage 2:
    // work ends between passes now, so the list is pruned here).
    loop: lastPass ? {
      ...lastPass,
      refusals: lastRefusals.filter((r) => !r.appId || backoffFor(r.appId, now))
        .map((r) => (r.appId && backoffFor(r.appId, now) ? { ...r, retryInMs: Math.max(0, appBackoff.get(Number(r.appId)).until - now) } : r)),
      // The pass running now, if one is: a long one is a sweep.
      runningSince: passStartedAt,
    } : lastPass,
    inFlight: [...inFlight.values()].map((e) => ({
      appId: Number(e.appId), followUp: !!e.followUp, build: !!e.build, lane: e.lane || null, person: e.person || null,
    })),
    backoff: [...appBackoff.keys()].map((appId) => [Number(appId), backoffFor(appId, now)?.until || 0])
      .filter(([, until]) => until > now),
    fault: fault ? { attempts: fault.attempts, until: fault.until, error: fault.error, at: fault.at } : null,
    budgetUntil: budgetPausedUntil,
    buildLane: lastBuildDrain,
    buildFault: buildFault ? { error: buildFault.error, retryAt: new Date(buildFault.until).toISOString() } : null,
  };
}

/** Whether the loop runs in this process (start() and not stop()). */
function runsHere() {
  return !!loopConfig && !stopped;
}

/**
 * The loop's memory wherever it runs: this process's own when the loop runs
 * here, else the copy its process published, else this process's (empty)
 * own, which is what a follower always showed.
 */
async function loopMemory(pool, now = Date.now()) {
  if (!runsHere()) {
    const published = await require('./leader-status').read(MEMORY_STATUS_KEY, pool);
    if (published && Array.isArray(published.inFlight) && Array.isArray(published.backoff)) return published;
  }
  return memoryStatus(now);
}

async function adminPayload(pool, config, {
  app = null, verdict = null, before = null, limit = RUNS_PAGE, budgetOnly = false,
} = {}) {
  const settings = await readSettings(pool);
  const memory = await loopMemory(pool);
  const limits = require('./limits');
  const managedOpenRouter = require('./openrouter-managed-keys');

  let { rows: botRows } = await pool.query(
    'SELECT id, username, weekly_limit_cents FROM users WHERE username = $1 AND is_synthetic = TRUE',
    [BOT_USERNAME],
  );
  if (!botRows.length) {
    // Nothing else creates the row until the loop's first pass in a mode
    // that is not off — which left the cap box blank and the cap write a
    // no-op on a fresh deployment. The dashboard creates it on load.
    try {
      await ensureBotUser(pool, config);
      ({ rows: botRows } = await pool.query(
        'SELECT id, username, weekly_limit_cents FROM users WHERE username = $1 AND is_synthetic = TRUE',
        [BOT_USERNAME],
      ));
    } catch (err) {
      log.warn('homeroom-bot', 'Could not create the bot user for the dashboard', { err: err.message });
    }
  }
  const botRow = botRows[0] || null;
  let bot = null;
  if (botRow) {
    let weeklySpentCents = 0;
    let hasIncludedKey = false;
    try { weeklySpentCents = await limits.getWeeklySpentCents(pool, botRow.id); } catch {}
    try { hasIncludedKey = await managedOpenRouter.usesIncludedKey(pool, botRow.id); } catch {}
    bot = {
      id: botRow.id,
      username: botRow.username,
      weeklyLimitCents: botRow.weekly_limit_cents ?? DEFAULT_WEEKLY_LIMIT_CENTS,
      weeklySpentCents,
      hasIncludedKey,
      model: config.openrouterDefaultCodexModel || null,
      // #3654: what each stage runs on now, the default filled in.
      models: Object.fromEntries(MODEL_STAGES.map((stage) => [stage, stageModel(settings, config, stage)])),
    };
  }

  const { rows: totalRows } = await pool.query(
    `SELECT COUNT(*)::int AS runs,
            COUNT(*) FILTER (WHERE verdict = 'question')::int AS questions,
            COUNT(*) FILTER (WHERE verdict = 'ready')::int AS ready,
            COUNT(*) FILTER (WHERE verdict = 'person')::int AS person,
            COUNT(*) FILTER (WHERE verdict = 'failed' AND budget_stop IS NULL)::int AS failed,
            COUNT(*) FILTER (WHERE budget_stop IS NOT NULL)::int AS budget_stopped,
            COUNT(*) FILTER (WHERE rating IS NOT NULL)::int AS rated,
            COUNT(*) FILTER (WHERE rating = 'yes')::int AS agreed,
            COUNT(*) FILTER (WHERE cap_suppressed IS NOT NULL)::int AS suppressed,
            COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd
       FROM homeroom_bot_runs
      WHERE created_at > NOW() - INTERVAL '7 days'`,
  );
  const t = totalRows[0] || {};
  const totals = {
    days: 7,
    runs: t.runs || 0,
    questions: t.questions || 0,
    ready: t.ready || 0,
    person: t.person || 0,
    // Failures are failures again: a turn we stopped ourselves is counted
    // separately, not as one (#2742).
    failed: t.failed || 0,
    budgetStopped: t.budget_stopped || 0,
    rated: t.rated || 0,
    agreed: t.agreed || 0,
    suppressed: t.suppressed || 0,
    costUsd: Number(t.cost_usd) || 0,
  };

  // The queue from one snapshot (queueSnapshot): how many wait and how many
  // run, and the rows listed, read by one statement so the counts and the
  // lists describe the same set. #4533 and after: why each one that is not
  // running waits, and until when.
  const queue = await queueSnapshot(pool, settings, { botId: botRow?.id ?? null, memory });
  // Running now and Waiting count builds too: they run from their runs, not
  // from the queue, and were left out of both while the bot was busy.
  const builds = await buildsNow(pool);

  const pageSize = Math.min(Math.max(Number(limit) || RUNS_PAGE, 1), 200);
  const { rows: runRows } = await pool.query(
    RUNS_SQL,
    [app || null, verdict || null, before == null ? null : Number(before), pageSize, !!budgetOnly],
  );

  const { rows: appRows } = await pool.query(
    `SELECT slug, name FROM apps WHERE status = 'running' AND repo_url IS NOT NULL ORDER BY name`,
  );

  // #3654: which stages each run on this page can be replayed at (a run
  // before snapshots existed has none), for "Add to a benchmark suite".
  let replayable = {};
  try {
    replayable = await snapshots.stagesForRuns(pool, runRows.map((r) => r.id));
  } catch (err) {
    log.warn('homeroom-bot', 'Could not read which runs have snapshots', { err: err.message });
  }

  return {
    settings,
    modes: MODES,
    defaultModel: config.openrouterDefaultCodexModel || null,
    bot,
    loop: memory.loop,
    totals,
    queue: { ...queue, buildsWaiting: builds.waiting },
    runs: runRows.map((r) => ({
      ...r, issueUrl: issueUrlFor(r), buildUrl: buildUrlFor(r), replayStages: replayable[r.id] || [],
    })),
    apps: appRows,
    caps: {
      proposalsPerApp: PROPOSALS_PER_APP_CAP,
      proposalsTotal: botProposalCeiling(settings),
      questionsPerAppPerDay: QUESTION_TRIPWIRE_PER_DAY,
    },
    // The shadow lane's own counts (buildLaneSummary, which never counts a
    // live build, #3509), and beside them the live builds under way and
    // waiting (buildsNow): first versions above all, which until run four
    // (13 Oct 2026) the lane's figures left at 0 while one built. The live
    // build loop's own last pass is the loop's status (`loop`), which the
    // connector carries as live.lastPass (bench/connector-data.js, #4993).
    builds: { ...await buildLaneSummary(pool, memory), live: { building: builds.building.length, waiting: builds.waiting } },
    mentionOptOuts: await mentionOptOutList(pool),
    // #3624 stage 2: what runs now, and what the DM's answers cost.
    workingNow: [...await workingNow(pool, settings), ...builds.building],
    dmChat: await dmChatSummary(pool),
    // And its voice outside the DM this week (homeroom-bot-voice.js).
    voice: await voiceModule(null).voiceSummary(pool),
    // Whether it is working, over the last week (homeroom-bot-health.js).
    health: await require('./homeroom-bot-health').rolloutHealth(pool, { botUsername: BOT_USERNAME }),
    // #4210: errors that should not happen (a build a restart cut short),
    // the last week's, newest first (platform-incidents.js).
    incidents: await incidents().recent(pool),
    // The configurations' pairs waiting for a pick, per scope: picked only
    // through the connector, so the Overview says they wait.
    pairsWaiting: await botConfigs().pairsWaitingByScope(pool),
    // Requests about Homeroom itself: the move offers of the last week, how
    // they were decided, and the verdicts that sent none, with why.
    moveOffers: await require('./homeroom-bot-move').moveOfferSummary(pool).catch((err) => {
      log.warn('homeroom-bot', 'Could not read the move offers', { err: err.message });
      return null;
    }),
  };
}

/**
 * The bot's answers in DMs this week: how many, what they cost, how many
 * failed, and how many only answered after a failed request was asked again.
 * #3733: and the last week's failures themselves, with their codes and what
 * answered instead (homeroom-bot-mayor.js recordTurn), so an admin can read
 * why a DM said "I couldn't answer" instead of guessing. Never the words.
 */
async function dmChatSummary(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS turns, COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS failed,
              COUNT(*) FILTER (WHERE error IS NULL AND cardinality(failures) > 0)::int AS recovered,
              COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd, COUNT(DISTINCT user_id)::int AS people
         FROM homeroom_bot_dm_turns WHERE created_at >= date_trunc('week', NOW())`,
    );
    const { rows: recent } = await pool.query(
      `SELECT t.created_at, u.username, t.error, t.failures, t.fallback, t.rounds
         FROM homeroom_bot_dm_turns t JOIN users u ON u.id = t.user_id
        WHERE t.created_at >= NOW() - INTERVAL '7 days'
          AND (t.error IS NOT NULL OR cardinality(t.failures) > 0)
        ORDER BY t.id DESC
        LIMIT 20`,
    );
    const r = rows[0] || {};
    return {
      turns: r.turns || 0,
      failed: r.failed || 0,
      recovered: r.recovered || 0,
      people: r.people || 0,
      costUsd: Number(r.cost_usd) || 0,
      recentFailures: recent.map((f) => ({
        at: new Date(f.created_at).toISOString(),
        username: f.username,
        error: f.error,
        failures: f.failures || [],
        fallback: f.fallback,
        rounds: f.rounds,
      })),
    };
  } catch (err) {
    log.warn('homeroom-bot', 'DM chat summary failed', { err: err.message });
    return { turns: 0, failed: 0, recovered: 0, people: 0, costUsd: 0, recentFailures: [] };
  }
}

const MENTION_OPTOUTS_PAGE = 100;

/** Who asked the bot to stop tagging them, newest first, for the dashboard. */
async function mentionOptOutList(pool) {
  const { rows } = await pool.query(
    `SELECT o.issue_number, o.created_at, u.username, a.slug AS app_slug, a.name AS app_name,
            COUNT(*) OVER ()::int AS total
       FROM homeroom_bot_mention_optouts o
       JOIN users u ON u.id = o.user_id
       JOIN apps a ON a.id = o.app_id
      ORDER BY o.created_at DESC, o.issue_number
      LIMIT $1`,
    [MENTION_OPTOUTS_PAGE],
  );
  return {
    total: rows[0]?.total || 0,
    items: rows.map(({ total, ...r }) => r),
  };
}

/**
 * An admin's "tag again", for an ask the bot misread: the person goes back
 * into that issue's mentions. The person themselves does this by saying so
 * on the issue.
 */
async function removeMentionOptOut(pool, { slug, issueNumber, username }) {
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, status: 400, error: 'Invalid issue number' };
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,120}$/.test(slug)) return { ok: false, status: 400, error: 'Invalid app slug' };
  if (typeof username !== 'string' || !username || username.length > 64) return { ok: false, status: 400, error: 'Invalid username' };
  const { rowCount } = await pool.query(
    `DELETE FROM homeroom_bot_mention_optouts o
      USING apps a, users u
      WHERE o.app_id = a.id AND o.user_id = u.id
        AND a.slug = $1 AND o.issue_number = $2 AND LOWER(u.username) = LOWER($3)`,
    [slug, n, username],
  );
  if (!rowCount) return { ok: false, status: 404, error: 'No such opt-out' };
  return { ok: true };
}

// #3654: the verdicts a labeller can name as the right one for a run.
const LABEL_VERDICTS = Object.freeze(['question', 'ready', 'person', 'empty', 'answer', 'revise']);

/**
 * An admin's rating of a run. Each of `rating`, `note` and `labelVerdict` is
 * changed only when it is passed: the table's one-tap Yes/No sends a rating
 * alone, and used to erase the note written beside it (#3654). `undefined`
 * leaves a field as it is; `null` clears it.
 */
async function rateRun(pool, { id, rating, note, labelVerdict, actorId }) {
  const runId = Number(id);
  if (!Number.isInteger(runId) || runId <= 0) return { ok: false, status: 400, error: 'Invalid run id' };
  if (rating !== undefined && rating !== null && rating !== 'yes' && rating !== 'no') {
    return { ok: false, status: 400, error: 'rating must be "yes", "no" or null' };
  }
  if (labelVerdict !== undefined && labelVerdict !== null && !LABEL_VERDICTS.includes(labelVerdict)) {
    return { ok: false, status: 400, error: `labelVerdict must be one of ${LABEL_VERDICTS.join(', ')}, or null` };
  }
  if (rating === undefined && note === undefined && labelVerdict === undefined) {
    return { ok: false, status: 400, error: 'Nothing to rate' };
  }
  const cleanNote = note == null ? null : clip(String(note), 1000);
  const { rows } = await pool.query(
    `UPDATE homeroom_bot_runs
        SET rating = CASE WHEN $5::boolean THEN $2::text ELSE rating END,
            rating_by = CASE WHEN NOT $5::boolean THEN rating_by
                             WHEN $2::text IS NULL THEN NULL ELSE $3::int END,
            rated_at = CASE WHEN NOT $5::boolean THEN rated_at
                            WHEN $2::text IS NULL THEN NULL ELSE NOW() END,
            rating_note = CASE WHEN $6::boolean THEN $4::text ELSE rating_note END,
            label_verdict = CASE WHEN $8::boolean THEN $7::text ELSE label_verdict END
      WHERE id = $1
      RETURNING id, rating, rating_note, rated_at, label_verdict`,
    [runId, rating ?? null, actorId || null, cleanNote, rating !== undefined, note !== undefined,
      labelVerdict ?? null, labelVerdict !== undefined],
  );
  if (!rows.length) return { ok: false, status: 404, error: 'Run not found' };
  return { ok: true, run: rows[0] };
}

/**
 * "Triage this app again" (#3480): every open issue on a live app, as if it
 * had just been posted. An app added to the live list was triaged in shadow
 * before, and the refresh queues only what changed since its last verdict,
 * so without this the bot does nothing live there until somebody comments.
 *
 * Nothing new is scheduled: the issues go in the app's queue, oldest first,
 * and the loop takes them the way it takes new ones, one at a time, back to
 * back, with the live path and its caps as usual, except that it posts no
 * "looking" and no cap's "held" note on them (APP_AGAIN_REASON, #3509).
 * They go in at priority 0,
 * as Run now's do, because the refresh drops an unchanged issue's row
 * otherwise. What the regular refresh leaves out stays out: a closed issue,
 * and one somebody is working on (issueHolders). A row the bot is on
 * right now is left alone. Not while paused, and never on a staging copy.
 */
async function retriageApp(pool, { slug, actorId = null, deps = {} } = {}) {
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,120}$/.test(slug)) {
    return { ok: false, status: 400, error: 'Invalid app slug' };
  }
  const settings = await readSettings(pool);
  if ((settings.pausedApps || []).includes(slug)) {
    return { ok: false, status: 409, error: 'The app is paused for the bot' };
  }
  // An import's backlog waits for exactly this. Off, nothing is live
  // (live.liveScope), but the queue still holds what it is told; a staging
  // copy never acts.
  if (!live.inScope(live.liveScope({ ...settings, mode: 'shadow' }), slug)) {
    return { ok: false, status: 409, error: 'The bot does not act on apps for real on a staging copy' };
  }
  const { rows: [app] } = await pool.query(
    'SELECT id, slug, name, repo_url FROM apps WHERE slug = $1 AND repo_url IS NOT NULL', [slug],
  );
  const repo = app && parseRepo(app.repo_url);
  if (!repo) return { ok: false, status: 404, error: 'App not found' };
  const github = deps.github || require('./github');
  const fetched = await github.fetchPublicIssues(repo.owner, repo.repo);
  const issues = Array.isArray(fetched?.issues) ? fetched.issues : [];
  if (!issues.length && fetched?.note) return { ok: false, status: 503, error: 'GitHub is unavailable; try again shortly' };

  const [holders, threads] = await Promise.all([
    issueHolders(pool, app.id),
    threadActivityByIssue(pool, app.id),
  ]);
  // #3751: a request somebody asked the bot to build anyway is not held.
  const busy = new Set(holders.keys());
  if (busy.size) {
    for (const n of await require('./homeroom-bot-holds').goneAhead(pool, app.id, holders)) busy.delete(n);
  }
  const picked = [];
  const left = { busy: 0, closed: 0 };
  for (const issue of issues) {
    const n = Number(issue.number);
    // Judged as if never triaged: the last verdict does not count here.
    const verdict = classifyIssue({ issue, threadLastAt: threads.get(n), busy: busy.has(n) });
    if (verdict.eligible) picked.push({ n, createdMs: toMs(issue.createdAt), threadSeenAt: verdict.threadSeenAt });
    else if (verdict.reason === 'in_progress') left.busy += 1;
    else if (verdict.reason === 'closed') left.closed += 1;
  }
  // Oldest first: each row's place in the queue is its turn.
  picked.sort((a, b) => (a.createdMs - b.createdMs) || (a.n - b.n));
  if (picked.length) {
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, requested_by, thread_seen_at, enqueued_at)
       SELECT $1, q.n, 0, 'app_again', $4, q.seen, NOW() + q.ord * INTERVAL '1 millisecond'
         FROM UNNEST($2::int[], $3::timestamptz[]) WITH ORDINALITY AS q(n, seen, ord)
       ON CONFLICT (app_id, issue_number) DO UPDATE
         SET priority = 0, reason = EXCLUDED.reason, requested_by = EXCLUDED.requested_by,
             thread_seen_at = EXCLUDED.thread_seen_at, enqueued_at = EXCLUDED.enqueued_at
       WHERE homeroom_bot_queue.started_at IS NULL`,
      [app.id, picked.map((p) => p.n), picked.map((p) => p.threadSeenAt), actorId],
    );
    wake({ appId: app.id });
  }
  log.info('homeroom-bot', 'App queued to be triaged again', {
    app: slug, queued: picked.length, busy: left.busy,
  });
  return { ok: true, queued: picked.length, left };
}

/** An admin's "run now": the issue goes to the head of the queue. */
/**
 * #3624 stage 2: somebody answered the bot in its DM, or had it file a
 * request there. The request goes to the front of the queue, as an admin's
 * Run now does, so it is looked at next rather than behind every new
 * request on the platform. A row already being worked on is left alone:
 * that run ends first, and the wake re-queues the issue after it.
 */
async function enqueueFront(pool, { appId, issueNumber, userId = null, reason = 'dm_answer', payerId = null }) {
  const id = Number(appId);
  const n = Number(issueNumber);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(n) || n <= 0) return null;
  // Somebody acted on it, so a hold for its last payer's week is lifted: the
  // look this starts is paid by `payerId` (whoever asked the bot to start it,
  // when that is not its requester), else by its requester (billingOf).
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, requested_by, payer_user_id)
     VALUES ($1, $2, 0, $3, $4, $5)
     ON CONFLICT (app_id, issue_number) DO UPDATE
       SET priority = 0, reason = EXCLUDED.reason, requested_by = EXCLUDED.requested_by, enqueued_at = NOW(),
           payer_user_id = EXCLUDED.payer_user_id, held_until = NULL
     WHERE homeroom_bot_queue.started_at IS NULL
     RETURNING id`,
    [id, n, String(reason).slice(0, 40), userId || null, payerId || null],
  );
  noteIssueActivity({ appId: id, issueNumber: n, reason });
  return rows[0] || null;
}

async function enqueueNow(pool, { slug, issueNumber, actorId }) {
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, status: 400, error: 'Invalid issue number' };
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,120}$/.test(slug)) {
    return { ok: false, status: 400, error: 'Invalid app slug' };
  }
  const { rows: apps } = await pool.query(
    'SELECT id, slug FROM apps WHERE slug = $1 AND repo_url IS NOT NULL', [slug],
  );
  if (!apps.length) return { ok: false, status: 404, error: 'App not found' };
  // A row the loop has claimed is left alone, as enqueueFront leaves it:
  // clearing its claim let a second turn start on the same request while the
  // first still ran (on a follow-up, on the same proposal's session), whose
  // "session busy" then backed the project off.
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, requested_by)
     VALUES ($1, $2, 0, 'admin', $3)
     ON CONFLICT (app_id, issue_number) DO UPDATE
       SET priority = 0, reason = 'admin', requested_by = EXCLUDED.requested_by, enqueued_at = NOW()
       WHERE homeroom_bot_queue.started_at IS NULL
     RETURNING id, app_id, issue_number, priority, reason, enqueued_at`,
    [apps[0].id, n, actorId || null],
  );
  if (!rows.length) return { ok: true, running: true, item: null };
  // And the loop hears it now, not on its next poll.
  noteIssueActivity({ appId: apps[0].id, issueNumber: n, reason: 'admin' });
  return { ok: true, item: rows[0] };
}

module.exports = {
  BOT_DISPLAY_NAME,
  // #4239: Homeroom's own board, where a request about the platform moves.
  PLATFORM_SELF_APP_SLUG,
  platformAppSlugs,
  start,
  stop,
  runOnce,
  runTriage,
  refreshQueue,
  refreshApp,
  issueHolders,
  retriageApp,
  nextBatch,
  ensureBotUser,
  ensureBotSession,
  pauseIdleSession,
  readSettings,
  writeSettings,
  validateSettingsPatch,
  parseSettings,
  adminPayload,
  memoryStatus,
  loopMemory,
  MEMORY_STATUS_KEY,
  iterateRunsForExport,
  exportRow,
  EXPORT_COLUMNS,
  EXPORT_CHUNK,
  rateRun,
  LABEL_VERDICTS,
  enqueueNow,
  // #3654: per-stage models and the pieces the benchmark replays with.
  stageModel,
  MODEL_STAGES,
  KEY_MODELS,
  MODEL_ID_RE,
  triagePromptFor,
  firstVersionNote,
  starterOfApp,
  deciderNote,
  whoDecides,
  membersNote,
  projectMembers,
  headShaOf,
  INFRA_ERRORS,
  isLiveLaneSaturated,
  mentionOptOutList,
  removeMentionOptOut,
  wake,
  wakeAll,
  backoffFor,
  noteRefusal,
  clearRefusals,
  clearStaleTurn,
  noteStopped,
  interruptRead,
  previousRead,
  rememberRead,
  continuedTriagePrompt,
  VERDICT_FORMAT,
  VERDICT_REPAIR_PROMPT,
  triageClosing,
  MAX_CONTINUED_READS,
  CONTINUE_READ_MAX_AGE_MS,
  wasStoppedRecently,
  actOnVerdict,
  // Live builds in slots of their own, one per project.
  buildLive,
  buildOne,
  // WP1 (#2): a build re-checked before it is proposed, and a merge's net.
  requestProposal,
  requestBuilding,
  whyNotBuild,
  hasProposalSkip,
  beingBuiltSkip,
  LOST_CLAIM,
  CLOSED_WHILE_BUILDING,
  noteRequestMerged,
  queueLiveBuild,
  // B6: a first version's plan, before it is built.
  PLAN_WAIT_DAYS,
  planFor,
  choicesFrom,
  creatorChoiceNote,
  awaitGo,
  planBeforeBuilding,
  plannedWithRequester,
  approvedSpecHtml,
  buildItOnRequest,
  complicatedReview,
  planChoicesNote,
  retryUnsentPlans,
  PLAN_SEND_RETRY_MINUTES,
  PLAN_SEND_ATTEMPTS,
  goAhead,
  carryApprovedPlan,
  autoRetryable,
  claimAutoRetry,
  // 15 Oct 2026: Try again finishes a first version that was built.
  finishBuiltFirstVersion,
  finishableRun,
  whyNotFinish,
  FINISH_STALE_MINUTES,
  retireWaitingPlans,
  settleStalePlans,
  planChangesFor,
  planChangeNote,
  // 13 Oct 2026: a first version planned at Make it (first-version-plan.js).
  planFromEarly,
  goAheadIfDecided,
  planBullets,
  planQuestions,
  parseAssumptions,
  noteWithAssumptions,
  liveBuildCandidates,
  pickLiveBuilds,
  noteFollowUpRefusal,
  clearFollowUpRefusals,
  followUpsBackedOff,
  summarizeFault,
  faultBackoff,
  noteFault,
  isRepeatFault,
  clearFault,
  releaseBotVolumes,
  describeStop,
  relaySpend,
  STOP_SETTLE_MS,
  ABANDONED_LIVE_WINDOW_DAYS,
  ABANDONED_LIVE_REASON,
  LOST_LIVE_REASON,
  BACKOFF_BASE_MS,
  BACKOFF_CEILING_MS,
  TRIPWIRE_VERDICTS,
  REFUSAL_ERRORS,
  MIN_TURN_SECONDS,
  MAX_TURN_SECONDS,
  MIN_TURN_INPUT_TOKENS,
  MAX_TURN_INPUT_TOKENS,
  KEY_TURN_SECONDS,
  KEY_TURN_INPUT_TOKENS,
  DEFAULTS,
  noteIssueActivity,
  noteProposalActivity,
  shadowBuild,
  runQueuedBuild,
  drainBuilds,
  queueShadowBuild,
  supersedeQueuedBuilds,
  buildLaneSummary,
  shadowBuildSkipReason,
  laterSideSkipReason,
  isPlatformRepo,
  buildBudgets,
  followUpBudgetMs,
  noteFollowUpWait,
  replyFailedWhy,
  PLATFORM_BUILD_TIME_FACTOR,
  isRecoveredBotSession,
  runLiveBuild,
  recordLostLiveBuild,
  runShadowBuild,
  recordLostShadowBuild,
  holdDurableBuildSlots,
  requeueLegacyBuilds,
  liveBuildInput,
  liveBuildNonce,
  runPosted,
  settleReapedTurn,
  // #4662: put a live run back in line with its kept plan, markdown and HTML.
  liveSayer,
  announceBuilt,
  RESTART_REASON,
  RETRY_FAILED_REASON,
  READ_AGAIN_REASON,
  FAILED_TRIAGE_RETRY_AFTER_MS,
  RESTARTED_BUILD_NOTE,
  MAX_RESTARTED_BUILDS,
  restartAllowanceMs,
  RESTART_ALLOWANCE_MS,
  APP_AGAIN_REASON,
  CHECKS_REASON,
  SELF_QUEUED_REASONS,
  NOT_FOLLOW_UP,
  noteProposalChecks,
  checksToFix,
  runChecksFix,
  // #4533: a follow-up a restart caught.
  isRecoveredBotFollowUp,
  followUpMark,
  finishRecoveredFollowUp,
  RECOVERED_FOLLOWUP_EFFECT,
  queueWait,
  queueSnapshot,
  recordReviewState,
  CAPTURE_ONLY_MINUTES,
  FIRST_VERSION_BUILD_TIME_FACTOR,
  recordLiveBuild,
  keepNoChange,
  recoveryDeadline,
  abandonRecoveredTurn,
  isInfraBuildError,
  wakeBuilds,
  MAX_BUILD_CONCURRENCY,
  MAX_BUILD_ATTEMPTS,
  KEY_SHADOW_BUILDS,
  KEY_BUILD_CONCURRENCY,
  KEY_SHADOW_BUILD_PLATFORM,
  onBusMessage,
  refreshApps,
  BUS_KIND,
  MAX_BATCH_SIZE,
  // Pure, exported for tests.
  classifyIssue,
  lastRunsByIssue,
  BLOCKERS,
  capRoomFor,
  simulateCaps,
  planTripwire,
  parseVerdict,
  keptReply,
  unreadableReplyOf,
  seedStagingUnreadableReply,
  parseRepo,
  BOT_USERNAME,
  MODES,
  VERDICTS,
  KEY_MODE,
  KEY_CONCURRENCY,
  KEY_BATCH_SIZE,
  KEY_PAUSED_APPS,
  KEY_LIVE_AT_ONCE,
  KEY_PER_PERSON,
  KEY_DM_CHAT,
  KEY_VOICE_SESSION,
  KEY_VOICE_ISSUE,
  KEY_VOICE_CHAT,
  KEY_CONTINUE_READS,
  KEY_LIVE_BUILD_STREAM,
  KEY_EVERYONE_SINCE,
  KEY_PROPOSAL_CEILING,
  EVERYONE_PROPOSAL_CEILING,
  pickLive,
  personKeyOf,
  enqueueFront,
  billingOf,
  readReasonOf,
  readFingerprintOf,
  reuseHeldVerdict,
  CAP_FREED_REASON,
  skippedAtTriage,
  liveCandidates,
  buildsNow,
  BUILDS_PER_PROJECT,
  // A project's first version goes first.
  FIRST_VERSION_PENDING_SQL,
  FIRST_VERSION_HOLD,
  firstVersionHolds,
  isFirstVersionRequest,
  heldForFirstVersion,
  // 15 Oct 2026: a first version filed while its project is set up.
  firstVersionsToRead,
  listApps,
  projectSetUpStop,
  setupCheckFor,
  SETUP_FAILED_BEFORE,
  SETUP_FAILED_DURING,
  SETUP_NOT_PROPOSED,
  workingNow,
  dmChatSummary,
  dispatch,
  claimLiveBuild,
  dispatchLiveBuilds,
  wakeLiveBuilds,
  DEFAULT_WEEKLY_LIMIT_CENTS,
  REFRESH_INTERVAL_MS,
  IDLE_PASS_DELAY_MS,
  BUSY_PASS_DELAY_MS,
  PROPOSALS_PER_APP_CAP,
  botProposalCeiling,
  QUESTION_TRIPWIRE_PER_DAY,
  _resetForTests() {
    lastRefreshAt = 0; triagePromptCache = null; stopped = false; passInFlight = false; lastPass = null;
    appBackoff.clear(); followUpBackoff.clear(); lastRefusals = []; platformFault = null; lastVolumeSweepAt = 0; lastLiveSweepAt = 0;
    inFlight.clear(); budgetPausedUntil = 0; platformSlugsCache = null;
    readsInFlight.clear(); lastReads.clear();
    passStartedAt = null; liveDispatchRunning = false; liveDispatchAgain = false; liveDispatchDone = Promise.resolve();
    liveKick = null; liveKickSeams = {};
    if (timer) clearTimeout(timer);
    if (deferResumeTimer) clearInterval(deferResumeTimer); deferResumeTimer = null;
    timer = null; loopConfig = null; pendingApps.clear(); refreshAllRequested = false; wakeRequested = false;
    buildsInFlight.clear(); buildLaneOn = false; buildDrainRunning = false; buildDrainAgain = false;
    buildFault = null; lastBuildDrain = null;
    if (buildTimer) clearTimeout(buildTimer);
    buildTimer = null;
  },
  // The build lane runs its builds in the background; a test awaits them.
  async _awaitBuildsForTests() {
    await Promise.all([...buildsInFlight.values()].map((b) => b.promise));
  },
  _buildsInFlightForTests() { return [...buildsInFlight.keys()]; },
  // Test seams for the wake path.
  _pendingForTests() { return { apps: [...pendingApps], all: refreshAllRequested, wake: wakeRequested, armed: timer !== null }; },
  // `seams` gives Build it's wake (wakeLiveBuilds) its pool and deps.
  _armForTests(config, seams = {}) {
    stopped = false; loopConfig = config; passInFlight = false; timer = setTimeout(() => {}, 1e9); timer.unref();
    liveKickSeams = seams;
  },
  async _awaitLiveKickForTests() { return liveKick ? liveKick : []; },
  _setPassInFlightForTests(v) { passInFlight = !!v; },
  _inFlightForTests() { return [...inFlight.values()].map((e) => ({ ...e })); },
};
