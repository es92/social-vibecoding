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
const { HOMEROOM_BOT_LOCK } = require('./advisory-locks');
const live = require('./homeroom-bot-live');
const followup = require('./homeroom-bot-followup');
const snapshots = require('./homeroom-bot-snapshots');
// #3692: the activity tray in a person's DM with the bot. Lazy, as the DM
// module is: it reads this module's settings.
function tray() { return require('./homeroom-bot-tray'); }
// #3736: and the activity card that follows one piece of work there.
function activity() { return require('./homeroom-bot-activity'); }

// One name, in the live module, which compares thread authors against it.
const { BOT_USERNAME } = live;
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
// #3146: the apps the bot acts on for real — posts on their issues, and
// builds and proposes the clear ones. Everything else stays in shadow.
const KEY_LIVE_APPS = 'homeroom_bot_live_apps';
// Shadow builds: on an app NOT in the live list, a ready verdict is also
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
// #3624: the people the bot talks to in a DM (homeroom-bot-dm.js), one
// at a time while it is tried out: their requests' questions and outcomes
// reach them there, and a project they create can be built by the bot from
// a description. Lower-cased usernames. An admin keeps it on the dashboard,
// and a person can put themselves on it or take themselves off it from
// Settings -> Experimental (setDmMember).
const KEY_DM_USERS = 'homeroom_bot_dm_users';
// #3624: what one person's requests may cost the bot in a week, in cents,
// on top of (and apart from) their own weekly allowance for agents. The
// platform pays; this is the ceiling that keeps one person from spending
// it all.
const KEY_USER_WEEKLY_CENTS = 'homeroom_bot_user_weekly_cents';
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
// (homeroom-bot-mayor.js). On by default for the people on the DM list; the
// switch is there to stop it without taking anybody off the list.
const KEY_DM_CHAT = 'homeroom_bot_dm_chat';
// Who has the bot: `list`, the people on KEY_DM_USERS and the projects they
// made (everything above), or `everyone`: every person with platform
// access, and every project but a paused one and the platform's own
// (live.liveScope). It ships as `list`, and switching it is the decision to
// turn the bot on for everybody, so it is an admin's alone; `list` stays a
// working way back. When it is switched to `everyone` the moment is kept
// (KEY_AUDIENCE_SINCE): a request nobody has touched since, older than that,
// is not picked up on its own (refreshApp), or the first refresh would read
// and build every open request on every app at once.
const AUDIENCES = Object.freeze(['list', 'everyone']);
const KEY_AUDIENCE = 'homeroom_bot_audience';
const KEY_AUDIENCE_SINCE = 'homeroom_bot_audience_since';
// With the `everyone` audience, whether the bot also acts for real on the
// platform's own project. Off: its requests stay in shadow, as they do on
// any project not in the live list today.
const KEY_LIVE_PLATFORM = 'homeroom_bot_live_platform';
// The most proposals the bot may have up for a vote at once, across every
// app (botProposalCeiling). Unset (0) is automatic: 5 per live app with the
// list audience, as before, and EVERYONE_PROPOSAL_CEILING with `everyone`,
// where "per live app" would be every app there is.
const KEY_PROPOSAL_CEILING = 'homeroom_bot_proposal_ceiling';
const SETTING_KEYS = Object.freeze([
  KEY_MODE, KEY_CONCURRENCY, KEY_BATCH_SIZE, KEY_PAUSED_APPS,
  KEY_TURN_SECONDS, KEY_TURN_INPUT_TOKENS, KEY_LIVE_APPS,
  KEY_SHADOW_BUILDS, KEY_BUILD_CONCURRENCY, KEY_SHADOW_BUILD_PLATFORM,
  KEY_DM_USERS, KEY_USER_WEEKLY_CENTS, KEY_LIVE_AT_ONCE, KEY_PER_PERSON, KEY_DM_CHAT,
  KEY_AUDIENCE, KEY_AUDIENCE_SINCE, KEY_LIVE_PLATFORM, KEY_PROPOSAL_CEILING,
  ...Object.values(KEY_MODELS),
]);
const MAX_DM_USERS = 50;
const MAX_USER_WEEKLY_CENTS = 10_000_000;
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// batchSize is how many of ONE app's issues a pass takes before the loop
// looks for the most urgent app again — the fairness knob between apps, not
// a throughput cap: the loop drains continuously (see the cadence below).
// 100 means "finish the app you are on" for any realistic board.
const DEFAULTS = Object.freeze({
  mode: 'off',
  concurrency: 1,
  batchSize: 100,
  pausedApps: [],
  liveApps: [],
  turnSeconds: 20 * 60,
  turnInputTokens: 10_000_000,
  shadowBuilds: false,
  buildConcurrency: 2,
  shadowBuildPlatform: false,
  dmUsers: [],
  userWeeklyCents: 5000,
  // #3654: per-stage models; blank is the platform default (stageModel).
  models: Object.freeze({ triage: '', spec: '', build: '', followup: '' }),
  liveAtOnce: 6,
  perPerson: 2,
  dmChat: true,
  audience: 'list',
  audienceSince: null,
  livePlatform: false,
  proposalCeiling: 0,
  // Not a stored setting: the projects somebody on the DM list made
  // (homeroom-bot-dm.js projectsMadeFor), live like the apps in liveApps.
  // readSettings fills it in, with the list audience only.
  firstVersionApps: [],
  // Not a stored setting either: the slugs of the platform's own project,
  // which the `everyone` audience leaves out unless livePlatform is on.
  // readSettings fills it in, with that audience only.
  platformSlugs: [],
});
const MAX_CONCURRENCY = 4;
const MAX_BUILD_CONCURRENCY = 4;
// Each live turn holds a worker from the pool people's own coding sessions
// use, so the ceiling stays well under it.
const MAX_LIVE_AT_ONCE = 16;
const MAX_PER_PERSON = 4;
const MAX_PROPOSAL_CEILING = 1000;
// The automatic ceiling with the `everyone` audience: what twenty live apps
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
// The queue reason of an issue whose bot proposal's checks settled failing
// on its current head (noteProposalChecks): a follow-up turn fixes them.
const CHECKS_REASON = 'checks_failing';
// Rows the bot queued for itself rather than for anything on the issue: a
// restart's (#3471) and a failing check's. The issue has not changed since
// the bot last looked, which is exactly what a refresh reads as "nothing
// to do", so a refresh keeps them (and their reason) while the issue is
// open and nobody else has it. It used to delete a restart's row on the
// very pass its wake started, which is how a live build a restart
// interrupted was never looked at again (recipebot #48, run 613).
const SELF_QUEUED_REASONS = Object.freeze([RESTART_REASON, CHECKS_REASON]);
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
  'Plan a look of its own, too: the starter\'s screen is placeholder, so there is no existing screen for it to look',
  'like. Say in `build_note` the screen\'s one job and its one primary action, an accent colour plus neutrals that',
  'work in both looks (not the starter\'s default palette, unless chosen on purpose), ONE signature element',
  'drawn from the app\'s subject (for example a staff or a keyboard for an ear trainer, a proofing timeline for a',
  'bread app) and a rough layout. The spec settles the details; never ask about them.',
].join('\n');

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
let lastPass = null;

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
  let liveApps = DEFAULTS.liveApps;
  try {
    const parsed = JSON.parse(map.get(KEY_LIVE_APPS) || '[]');
    if (Array.isArray(parsed)) liveApps = parsed.filter((s) => typeof s === 'string').slice(0, 50);
  } catch {
    liveApps = DEFAULTS.liveApps;
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
  let dmUsers = DEFAULTS.dmUsers;
  try {
    const parsed = JSON.parse(map.get(KEY_DM_USERS) || '[]');
    if (Array.isArray(parsed)) {
      dmUsers = [...new Set(parsed.filter((s) => typeof s === 'string' && USERNAME_RE.test(s))
        .map((s) => s.toLowerCase()))].slice(0, MAX_DM_USERS);
    }
  } catch {
    dmUsers = DEFAULTS.dmUsers;
  }
  const userWeeklyCents = clampInt(
    map.get(KEY_USER_WEEKLY_CENTS), DEFAULTS.userWeeklyCents, 0, MAX_USER_WEEKLY_CENTS,
  );
  const models = {};
  for (const stage of MODEL_STAGES) {
    const raw = String(map.get(KEY_MODELS[stage]) || '').trim();
    models[stage] = MODEL_ID_RE.test(raw) ? raw : '';
  }
  const liveAtOnce = clampInt(map.get(KEY_LIVE_AT_ONCE), DEFAULTS.liveAtOnce, 1, MAX_LIVE_AT_ONCE);
  const perPerson = clampInt(map.get(KEY_PER_PERSON), DEFAULTS.perPerson, 1, MAX_PER_PERSON);
  const dmChat = map.get(KEY_DM_CHAT) !== 'off';
  const audience = AUDIENCES.includes(map.get(KEY_AUDIENCE)) ? map.get(KEY_AUDIENCE) : DEFAULTS.audience;
  // Written with the switch (writeSettings); readSettings fills in a switch
  // made some other way.
  const sinceMs = Date.parse(map.get(KEY_AUDIENCE_SINCE) || '');
  const audienceSince = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null;
  const livePlatform = map.get(KEY_LIVE_PLATFORM) === 'on';
  const proposalCeiling = clampInt(map.get(KEY_PROPOSAL_CEILING), DEFAULTS.proposalCeiling, 0, MAX_PROPOSAL_CEILING);
  return {
    mode, concurrency, batchSize, pausedApps, liveApps, turnSeconds, turnInputTokens,
    shadowBuilds, buildConcurrency, shadowBuildPlatform, dmUsers, userWeeklyCents,
    liveAtOnce, perPerson, dmChat, models,
    audience, audienceSince, livePlatform, proposalCeiling,
    firstVersionApps: [],
    platformSlugs: [],
  };
}

// The platform's own project, by slug, for the `everyone` audience to leave
// out (live.liveScope): its self-hosted row (config.js SELF_APP_SLUG, never
// renamed), and any app on the platform's repository. Read at most once a
// minute: readSettings runs on every pass and every DM, and which app is
// the platform's does not change. A read that fails keeps the last answer,
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
    if (settings.audience === 'everyone') {
      // Every project is live but these (live.liveScope), so the projects
      // made by somebody on the list below need no reading: they are live
      // already, and that list is unbounded.
      settings.platformSlugs = await platformAppSlugs(pool);
      // A switch to everyone made without writeSettings (a hand edit) has no
      // moment of its own: it counts from when the audience row last changed
      // (never null: the row was just read), not from no time at all, which
      // would read every old request.
      if (!settings.audienceSince) {
        const { rows: at } = await pool.query(
          'SELECT updated_at FROM platform_settings WHERE key = $1', [KEY_AUDIENCE],
        ).catch(() => ({ rows: [] }));
        if (at[0]?.updated_at) settings.audienceSince = new Date(at[0].updated_at).toISOString();
      }
      return settings;
    }
    // #3624: a project somebody on the DM list made (one the bot builds
    // from its description, or one they imported, forked or created
    // without one) is live while that person is still on the list.
    try {
      settings.firstVersionApps = await require('./homeroom-bot-dm').firstVersionAppSlugs(pool, settings);
    } catch (err) {
      log.warn('homeroom-bot', 'first-version apps read failed', { err: err.message });
    }
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
  if (body.audience !== undefined) {
    if (!AUDIENCES.includes(body.audience)) return { ok: false, error: 'audience must be list or everyone' };
    updates.push([KEY_AUDIENCE, body.audience]);
  }
  if (body.livePlatform !== undefined) {
    if (typeof body.livePlatform !== 'boolean') return { ok: false, error: 'livePlatform must be true or false' };
    updates.push([KEY_LIVE_PLATFORM, body.livePlatform ? 'on' : 'off']);
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
  if (body.liveApps !== undefined) {
    if (!Array.isArray(body.liveApps) || body.liveApps.length > 50
        || !body.liveApps.every((s) => typeof s === 'string' && /^[a-z0-9-]{1,120}$/.test(s))) {
      return { ok: false, error: 'liveApps must be an array of up to 50 app slugs' };
    }
    updates.push([KEY_LIVE_APPS, JSON.stringify([...new Set(body.liveApps)])]);
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
  if (body.dmUsers !== undefined) {
    if (!Array.isArray(body.dmUsers) || body.dmUsers.length > MAX_DM_USERS
        || !body.dmUsers.every((s) => typeof s === 'string' && USERNAME_RE.test(s.replace(/^@/, '')))) {
      return { ok: false, error: `dmUsers must be an array of up to ${MAX_DM_USERS} usernames` };
    }
    updates.push([KEY_DM_USERS, JSON.stringify([...new Set(body.dmUsers.map((s) => s.replace(/^@/, '').toLowerCase()))])]);
  }
  if (body.userWeeklyCents !== undefined) {
    const n = Number(body.userWeeklyCents);
    if (!Number.isInteger(n) || n < 0 || n > MAX_USER_WEEKLY_CENTS) {
      return { ok: false, error: 'userWeeklyCents must be a non-negative integer' };
    }
    updates.push([KEY_USER_WEEKLY_CENTS, String(n)]);
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
  let audienceBefore = null;
  if (valid.updates.some(([key]) => key === KEY_MODE || key === KEY_AUDIENCE)) {
    try {
      const before = await readSettings(pool);
      modeBefore = before.mode;
      audienceBefore = before.audience;
    } catch {}
  }
  const audienceAfter = valid.updates.find(([key]) => key === KEY_AUDIENCE)?.[1];
  // The moment the bot was given to everyone: what is older than it, and
  // untouched since, is not picked up on its own (refreshApp).
  if (audienceAfter === 'everyone' && audienceBefore !== 'everyone') {
    valid.updates.push([KEY_AUDIENCE_SINCE, new Date().toISOString()]);
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
  // More room for live work is used now, not on the next idle pass. A new
  // audience, or the platform's project in or out of it, changes which
  // queue rows are live: the whole queue is rebuilt before the next pick, so
  // a row queued for the background lane is not taken live untouched.
  if (valid.updates.some(([key]) => [KEY_LIVE_AT_ONCE, KEY_PER_PERSON, KEY_CONCURRENCY, KEY_AUDIENCE, KEY_LIVE_PLATFORM].includes(key))) {
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

// How many times setDmMember re-reads the list when another write landed
// between its read and its own. Every round, one of the writers racing for
// the row lands, so this many joining at the same moment all get on.
const DM_MEMBER_ATTEMPTS = 10;

/**
 * Settings -> Experimental: a person puts themselves on the DM list, or
 * takes themselves off it. It is the list an admin keeps, not a second one:
 * the dashboard shows who joined this way, an admin can still take anybody
 * off, it holds MAX_DM_USERS at most, and each person's requests count
 * against the same weekly allowance.
 *
 * Written compare-and-swap: the UPDATE lands only if the list is still the
 * one it read, else it reads again, so a join or an admin's save that lands
 * meanwhile is never written out by this one. (An admin who saves a list
 * they loaded before somebody joined still replaces it, as any admin edit
 * of the list does.)
 *
 * Resolves { ok: true, joined, changed } (asking for what is already so is
 * not an error), or { ok: false, error } with error 'full' (and `max`) when
 * there is no room, 'invalid_username', or 'busy' when the list kept
 * changing underneath it.
 */
async function setDmMember(pool, username, joined, actorId = null) {
  const name = String(username || '').replace(/^@/, '').toLowerCase();
  if (!USERNAME_RE.test(name)) return { ok: false, error: 'invalid_username' };
  const want = !!joined;
  // Seeded by schema.sql; this is for a database that predates the seed.
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, '[]') ON CONFLICT (key) DO NOTHING`,
    [KEY_DM_USERS],
  );
  for (let attempt = 0; attempt < DM_MEMBER_ATTEMPTS; attempt += 1) {
    const { rows } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [KEY_DM_USERS]);
    const stored = rows[0] ? rows[0].value : '[]';
    const list = parseSettings([{ key: KEY_DM_USERS, value: stored }]).dmUsers;
    if (list.includes(name) === want) return { ok: true, joined: want, changed: false };
    if (want && list.length >= MAX_DM_USERS) return { ok: false, error: 'full', max: MAX_DM_USERS };
    const next = want ? [...list, name] : list.filter((n) => n !== name);
    const { rowCount } = await pool.query(
      `UPDATE platform_settings SET value = $2, updated_at = NOW(), updated_by = $3
        WHERE key = $1 AND value = $4`,
      [KEY_DM_USERS, JSON.stringify(next), actorId || null, stored],
    );
    if (rowCount) {
      log.info('homeroom-bot', want ? 'Joined the DM from Settings' : 'Left the DM from Settings', { username: name });
      return { ok: true, joined: want, changed: true };
    }
  }
  return { ok: false, error: 'busy' };
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

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/g;

function clip(value, max = MAX_FIELD_CHARS) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The verdict is the LAST fenced JSON block in the agent's final message;
 * anything before it is working notes. A message with no parseable block,
 * or one whose `verdict` is not one of the three, yields null and the run
 * is recorded as `failed` with the tail of the text — never a guessed
 * verdict.
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

function parseVerdict(text) {
  const raw = String(text || '');
  const candidates = [];
  let m;
  while ((m = FENCE_RE.exec(raw)) !== null) candidates.push(m[1]);
  FENCE_RE.lastIndex = 0;
  // No fence: try the outermost braces of the whole text as a last resort.
  if (!candidates.length) {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    let obj;
    try { obj = JSON.parse(candidates[i]); } catch { continue; }
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
    return {
      verdict,
      determined: typeof obj.determined === 'boolean' ? obj.determined : null,
      missingFact: missing && /^none\.?$/i.test(missing) ? null : missing,
      question: verdict === 'question' ? clip(obj.question, 2000) : null,
      questionDefault,
      // #3624: the replies a person can tap to answer, the default first.
      questionAnswers: verdict === 'question' ? suggestedAnswers(obj.answers, questionDefault) : null,
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
function classifyIssue({ issue, threadLastAt = null, busy = false, lastRun = null }) {
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
      return { eligible: false, reason: 'unchanged', threadSeenAt };
    }
    return { eligible: true, reason: 'changed', priority: 2, threadSeenAt };
  }
  return { eligible: true, reason: 'new', priority: 1, threadSeenAt };
}

function parseRepo(url) {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// ── The queue ───────────────────────────────────────────────────────────

async function listApps(pool) {
  const { rows } = await pool.query(
    `SELECT id, slug, name, repo_url, self_hosted
       FROM apps
      WHERE status = 'running' AND repo_url IS NOT NULL
      ORDER BY id`,
  );
  return rows;
}

/**
 * Everything that makes an issue "somebody's": a live human claim, a live
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
  const claims = await pool.query(
    `SELECT ic.github_issue_number AS n, u.username, ic.claimed_at AS since
       FROM issue_claims ic JOIN users u ON u.id = ic.user_id
      WHERE ic.app_id = $1 AND u.is_synthetic IS NOT TRUE
        AND ic.claimed_at > NOW() - make_interval(days => $2)`,
    [appId, CLAIM_TTL_DAYS],
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
 * (classifyIssue), as liveCandidates reads it. One the abandoned-build
 * sweep can no longer reach (older than its window) holds nothing.
 */
async function lastRunsByIssue(pool, appId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (issue_number) issue_number, thread_seen_at, verdict, cap_suppressed, created_at, mode,
            (mode = 'live' AND verdict = 'ready' AND build_ok IS NULL AND proposal_session_id IS NULL
             AND (live_build_waiting_at IS NOT NULL OR build_session_id IS NOT NULL)
             AND created_at > NOW() - make_interval(days => $2)) AS live_building
       FROM homeroom_bot_runs
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

  // #3264: on a live app (capRoom is set only there) a person's reply in the
  // discussion of the bot's own open proposal is activity on its issue, so
  // it comes back for a follow-up.
  // #3624: a project somebody on the DM list imported is live from the
  // start, but the issues it arrived with are new to nobody: each is judged
  // as if the bot had seen it at the import, so it waits until something
  // happens on it, rather than the whole backlog being worked at once.
  // "Triage again" on the admin screen takes all of them.
  const [holders, threads, lastRuns, proposalThreads, importedAt] = await Promise.all([
    issueHolders(pool, app.id),
    threadActivityByIssue(pool, app.id),
    lastRunsByIssue(pool, app.id),
    capRoom && bot ? proposalThreadActivityByIssue(pool, app.id, bot.id) : new Map(),
    capRoom ? require('./homeroom-bot-dm').importedAt(pool, app.id).catch(() => null) : null,
  ]);
  const backlogUntil = toMs(importedAt);
  // The `everyone` audience (KEY_AUDIENCE_SINCE), on a live app: what the
  // bot had not read live before the switch is judged as if it had read it
  // then, as an import's backlog is just above. A request nobody has touched
  // since waits for somebody to (a comment, an answer, "Ask Homeroom bot to
  // build this"); one the bot only read in the background is read again only
  // when something new happens on it. Without this, the first refresh after
  // the switch would read, and build, every open request on every app.
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
      eligible.push({ n: h.n, eligible: true, reason: 'cap_freed', priority: 2, threadSeenAt: h.threadSeenAt });
    }
  }

  const byNumber = new Map(issues.map((issue) => [Number(issue.number), issue]));
  for (const item of eligible) {
    const { rows: queued } = await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, thread_seen_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id, issue_number) DO UPDATE
         SET priority = LEAST(homeroom_bot_queue.priority, EXCLUDED.priority),
             thread_seen_at = EXCLUDED.thread_seen_at,
             reason = CASE WHEN homeroom_bot_queue.priority = 0
                             OR homeroom_bot_queue.reason = ANY($6::text[])
                           THEN homeroom_bot_queue.reason ELSE EXCLUDED.reason END
       WHERE homeroom_bot_queue.started_at IS NULL
       RETURNING id, (xmax = 0) AS inserted`,
      [app.id, item.n, item.priority, item.reason, item.threadSeenAt, SELF_QUEUED_REASONS],
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

/** When the bot was given to everyone, while it is (refreshApp), else null. */
function everyoneSinceOf(settings) {
  return settings?.audience === 'everyone' ? settings.audienceSince || null : null;
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
    `SELECT id, app_id, issue_number, priority, reason, thread_seen_at, requested_by
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
function triageClosing(issueNumber) {
  return `That is the end of the reference. Now answer the triage request above, for issue #${issueNumber}: decide which verdict is true, and END YOUR REPLY WITH EXACTLY ONE fenced JSON block in this format, and nothing after it:
{"verdict": "question" | "empty" | "ready" | "person", "determined": true | false, "missing_fact": "...", "question": "...", "default": "...", "build_note": "...", "reason": "..."}`;
}

/**
 * #3654: the whole triage prompt for one request, as runTriage sends it and
 * as the benchmark rebuilds it from a snapshot's seed. Pure apart from the
 * cached prompt file and the design guidance it reads. `readsImages` is
 * whether the turn's model takes images, from the runtime the turn resolved
 * (prompts.runtimeReadsImages); a prompt rebuilt without it is the text-only
 * one every triage ran before it existed.
 */
function triagePromptFor({ seed, issueNumber, firstVersion = false, readsImages = false, decider = null }) {
  return [
    seed, live.screenshotNote(seed).join('\n').trim(), triagePrompt(),
    firstVersion ? FIRST_VERSION_NOTE : null,
    deciderNote(decider),
    triageReference({ readsImages }), triageClosing(issueNumber),
  ].filter(Boolean).join('\n\n');
}

/**
 * #3772: who decides on this project, when that changes the verdict. The
 * ready rules send every new dependency, service or design choice to "a
 * person", and the bot then left it "for the group". On a project with one
 * member, the person who asked IS the group: Ear Trainer #13 (sounds from a
 * MIDI instrument) was left for a group of one, who was told someone in the
 * group would have to take it up. There, a decision they can make is a
 * question to them with choices to tap, and their answer decides it. A
 * project with more people keeps the rule as it was. Pure; null says
 * nothing.
 */
function deciderNote(decider) {
  if (!decider?.requesterDecides) return null;
  return [
    '==== WHO DECIDES ON THIS PROJECT ====',
    '',
    `@${decider.requester} asked for this, and is the only member of this project: the decisions its group would make are theirs.`,
    '- A request that fails a `ready` criterion only because it needs a decision they can make (a new dependency or external service that needs no credentials, a design or product choice) is a `question` to them, not `person`. Ask it plainly, say what it would add, and give `answers` they can tap: the choice that needs no approval (for example the browser\'s built-in way) first when there is one, then the one that needs it (for example "Add the library"), then "Leave it".',
    '- When the request or its discussion already shows them choosing (they answered your question, or said to go ahead), that criterion is decided: judge the rest as usual.',
    '- Changes to auth, billing, permissions or credentials, and database changes that are not append-only, are still `person`.',
  ].join('\n');
}

/**
 * #3772: whether the person a request is for decides on its project alone:
 * they are its only member (or, on a project not in a community, its
 * creator). { requester, members, requesterDecides }, or null.
 */
async function whoDecides(pool, app, requester) {
  if (!app?.id || !requester?.userId) return null;
  const { rows } = await pool.query(
    `SELECT a.created_by,
            (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id) AS members,
            EXISTS (SELECT 1 FROM community_members m
                     WHERE m.community_id = a.community_id AND m.user_id = $2) AS member
       FROM apps a WHERE a.id = $1`,
    [app.id, requester.userId],
  );
  const row = rows[0];
  if (!row) return null;
  const members = Number(row.members) || 0;
  const alone = members === 0
    ? Number(row.created_by) === Number(requester.userId)
    : members === 1 && row.member === true;
  return { requester: requester.username, members, requesterDecides: alone };
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

async function insertRun(pool, run) {
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_runs
       (app_id, issue_number, session_id, mode, verdict, determined, missing_fact, question,
        question_default, build_note, reason, cap_suppressed, thread_seen_at, model, cost_usd,
        input_tokens, output_tokens, duration_ms, error, budget_stop, proposal_session_id,
        checks_head_sha, charged, payer_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
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
      run.charged ?? run.mode === 'live', run.payerUserId || null],
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
  return id;
}

/**
 * The most proposals the bot may have up for a vote at once, across every
 * app (#3576): the per-app cap on each live app. It stands in for the
 * platform's per-user cap (session-caps.js, 5), which the bot ran into with
 * four live apps and found out about only after a paid build could not be
 * proposed. The Propose route honours it for the bot's own in-process
 * promote only (promoteAsBot); the bot checks it before it builds.
 */
function botProposalCeiling(settings) {
  // An admin's number, when there is one (KEY_PROPOSAL_CEILING).
  const fixed = Number(settings?.proposalCeiling);
  if (Number.isInteger(fixed) && fixed > 0) return fixed;
  if (settings?.audience === 'everyone') return EVERYONE_PROPOSAL_CEILING;
  const apps = (settings?.liveApps || []).length + (settings?.firstVersionApps || []).length;
  return PROPOSALS_PER_APP_CAP * Math.max(1, apps);
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

// Only the verdicts that went out (or, in shadow, would have). A held one
// said nothing but the one-line held note, and counting it would let each
// retry of a held question push the window out again (#3152).
async function tripwireCount(pool, appId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM homeroom_bot_runs
      WHERE app_id = $1 AND verdict = ANY($2::text[])
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

/**
 * What a turn used, from the relay's per-request sum, and what that costs
 * at the turn's catalog price (#3038). Null when the relay saw no request
 * finish; `costUsd` is null when the turn had no pricing snapshot.
 */
function relaySpend(relayUsage, pricing, agentTurn) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const requests = count(relayUsage?.requests);
  if (!requests) return null;
  const inputTokens = count(relayUsage.inputTokens) ?? 0;
  const outputTokens = count(relayUsage.outputTokens) ?? 0;
  const { estimatedCostUsd } = agentTurn.estimateRequestedModelCost({ inputTokens, outputTokens }, pricing);
  return {
    requests, inputTokens, outputTokens,
    costUsd: Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : null,
  };
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

/**
 * One issue, one read-only scout turn, one ledger row. Returns
 * { ran: true, verdict } or { ran: false, reason }. `budget` is the one
 * reason the caller stops the whole pass on: the queue is left alone and
 * the loop idles until the week's allowance moves.
 */
async function runTriage(pool, config, { bot, app, item, mode, settings = null, deps = {} }) {
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
  const model = stageModel(settings, config, 'triage');
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
  const recordRefusal = (error) => {
    // A follow-up's session is its proposal's: only that follow-up waits.
    const { attempts, delayMs } = followUpTurn
      ? noteFollowUpRefusal(app.id, issueNumber, error)
      : noteRefusal(app.id, error);
    log.info('homeroom-bot', followUpTurn ? 'A follow-up was refused a turn; backing it off' : 'App refused a turn; backing off', {
      app: app.slug, issueNumber, error, attempts, delayMs,
    });
    return { ran: false, reason: 'refused', detail: error, app: app.slug, retryInMs: delayMs, followUp: followUpTurn };
  };

  const recordFailure = async (error, extra = {}, { infra = false } = {}) => {
    if (REFUSAL_ERRORS.has(error)) return recordRefusal(error);
    // A platform fault the current streak already recorded gets no second
    // row (#3122); the retry is still logged below.
    const id = infra && isRepeatFault(error) ? null : await insertRun(pool, {
      ...billingOf(item, runMode),
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
      ? { ran: false, reason: 'infra', detail: error, runId: id }
      : { ran: true, verdict: 'failed', runId: id };
  };

  if (!repo || !github.isEnabled()) return recordFailure('github_unavailable', {}, { infra: true });

  const budget = await limits.checkBudget(pool, bot.id);
  if (budget.error) {
    log.info('homeroom-bot', 'Pass paused on budget', { reason: budget.reason || null });
    return { ran: false, reason: 'budget', detail: budget.reason || null };
  }

  await pool.query('UPDATE homeroom_bot_queue SET started_at = NOW() WHERE id = $1', [item.id]);

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
          model: stageModel(settings, config, 'followup'), turnBudgetMs, startedMs,
          recordFailure,
          deps: {
            github, worker, agentTurn, limits, threadContext, managedOpenRouter, sessions,
            activeWorkers, votes: deps.votes || null, ...liveD,
          },
        });
      }
      await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
      log.info('homeroom-bot', 'Issue\'s bot proposal is merging; not looking again', {
        app: app.slug, issueNumber, sessionId: open.id,
      });
      return { ran: false, reason: 'has_proposal' };
    }
    // An issue a restart sent back (#3471) was already told the bot is
    // looking; it is not told twice. A backlog pass says nothing yet (#3509).
    const looked = item.reason === RESTART_REASON || item.reason === APP_AGAIN_REASON ? null : await live.post({
      pool, github, ws: liveD.ws, app, repo, issueNumber,
      kind: 'looking', text: live.lookingText(), sender: bot,
    }).catch((err) => {
      log.warn('homeroom-bot', 'Looking post failed (continuing)', { app: app.slug, issueNumber, err: err.message });
      return null;
    });
    if (looked?.githubCreatedAt) postedAt.push(looked.githubCreatedAt);
    // #3736: and the person it is for gets a card in their DM with the bot
    // that follows this piece of work to its end, told when the request is:
    // not twice for a restart, and not for a backlog pass. Never throws.
    if (item.reason !== RESTART_REASON && item.reason !== APP_AGAIN_REASON) {
      await activity().startCard(pool, { app, issueNumber, requester, bot, jobKey: item.id, settings, deps: { dm: deps.dm } });
    }
  }
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
  // #3772: on a project of one, the person who asked decides what the group
  // would. Only on a project the bot acts on, where it says its verdict.
  const decider = liveMode && requester
    ? await whoDecides(pool, app, requester).catch((err) => {
      log.warn('homeroom-bot', 'Could not read who decides on a project', { app: app.slug, err: err.message });
      return null;
    })
    : null;
  const promptInput = { seed, issueNumber, firstVersion: !!requester?.firstVersion, decider };
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
      ...(decider?.requesterDecides ? { decider } : {}),
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

  let routed;
  // The turn's pricing snapshot, as the runtime resolved it, so a turn the
  // ledger could not price is priced from the same catalog (#3038).
  let pricing = null;
  try {
    routed = await sessions.runCodexAttemptLoop({
      pool, session, userId: bot.id, config, isCodexSession: true,
      turnModel: model, resumeThreadId: null, mode: 'scout',
      telemetryComponent: 'homeroom_bot_triage',
      resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
        pool, session, userId: bot.id, model, resumeThreadId: null, config,
        // The platform's per-model choice of CLI, as the dev chat's scout
        // makes it (#3296): GLM runs in Claude Code.
        harness: 'auto',
      }),
      dispatchOnce: (ctx) => {
        pricing = ctx?.pricingSnapshot || pricing;
        // Rendered for what this turn's model can see, as its runtime
        // resolved it, and recorded as what the turn read.
        const turnPrompt = triagePromptFor({
          ...promptInput, readsImages: require('./prompts').runtimeReadsImages(ctx),
        });
        snapshot.texts.prompt = turnPrompt;
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
  } catch (err) {
    routed = { error: `dispatch: ${err.message}` };
  } finally {
    clearTimeout(budgetTimer);
    if (stopping) await stopping;
    activeWorkers.delete(session.id);
    // Back to rest, unless a turn still holds the session: a session paused
    // under a turn in flight is one restart recovery throws away (#1006).
    await pauseIdleSession(pool, session.id);
  }

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
  const costUsd = ledgerCostUsd ?? relay?.costUsd ?? null;
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
  if (costUsd > 0) {
    try {
      if (await managedOpenRouter.usesIncludedKey(pool, bot.id)) {
        await limits.recordSpend(pool, bot.id, Math.round(costUsd * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('homeroom-bot', 'Spend debit failed', { err: err.message });
    }
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
  const parsed = parseVerdict(text);
  if (!parsed) {
    const body = clip(text.slice(-300), 300);
    if (!body) {
      // An empty reply right after a stop on this session is almost always
      // collateral, not a verdict the bot failed to parse: stopTurn kills
      // the session's container, and an issue dispatched into it
      // concurrently dies with it. Two of the first three budget stops took
      // a bystander issue down this way, each recorded as a permanent parse
      // failure a second after the stop. Put that issue back on the queue
      // instead of burning its triage on somebody else's timeout.
      if (!budgetHit && wasStoppedRecently(session.id)) {
        return recordFailure('collateral: the session was stopped mid-dispatch', {
          sessionId: session.id, costUsd, ...usage,
        }, { infra: true });
      }
      // Otherwise say WHY it was empty. The worker's watch state already
      // knows — it was simply being thrown away, which left 21 of the first
      // 225 runs recorded as `(empty reply)` and nothing else.
      return recordFailure(`unparseable: (empty reply) ${describeStop(result)}`, {
        sessionId: session.id, costUsd, ...usage,
      });
    }
    return recordFailure(`unparseable: ${body}`, {
      sessionId: session.id, costUsd, ...usage,
    });
  }
  const capSuppressed = await simulateCaps(pool, bot, app.id, parsed.verdict, settings);
  const runId = await insertRun(pool, {
    ...billingOf(item, runMode),
    appId: app.id, issueNumber, sessionId: session.id, mode: runMode,
    verdict: parsed.verdict, determined: parsed.determined, missingFact: parsed.missingFact,
    question: parsed.question, questionDefault: parsed.questionDefault, questionAnswers: parsed.questionAnswers,
    buildNote: parsed.buildNote, reason: parsed.reason, capSuppressed,
    threadSeenAt: item.thread_seen_at || null, model, costUsd,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    durationMs: Date.now() - startedMs,
  });
  await recordSnapshot(runId);
  await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
  clearRefusals(app.id);
  // A newer verdict on the issue replaces any build still waiting for an
  // older one: the lane builds what the bot thinks now.
  await supersedeQueuedBuilds(pool, { appId: app.id, issueNumber, runId }).catch((err) => {
    log.warn('homeroom-bot', 'Could not supersede a queued shadow build', { app: app.slug, issueNumber, err: err.message });
  });
  // And a live build still waiting its turn: what was said since replaces it.
  await pool.query(
    `UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_error = 'superseded: a later verdict on the same issue'
      WHERE app_id = $1 AND issue_number = $2 AND id <> $3
        AND live_build_waiting_at IS NOT NULL AND build_ok IS NULL AND build_session_id IS NULL`,
    [app.id, issueNumber, runId],
  ).catch((err) => log.warn('homeroom-bot', 'Could not supersede a waiting live build', { app: app.slug, issueNumber, err: err.message }));
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
        model: stageModel(settings, config, 'build'), specModel: stageModel(settings, config, 'spec'),
        quietHold: item.reason === APP_AGAIN_REASON,
        proposalCeiling: botProposalCeiling(settings),
        firstVersion: !!requester?.firstVersion,
        deps: {
          github, worker, agentTurn, limits, threadContext, managedOpenRouter, sessions,
          activeWorkers, ...liveD,
        },
      });
    } catch (err) {
      log.error('homeroom-bot', 'Acting on a live verdict failed', { app: app.slug, issueNumber, err: err.message });
    }
  } else if (parsed.verdict === 'ready' && shadowBuildsApply(settings, app, config)) {
    // Queued, not built here: the build lane runs it beside triage, so the
    // rest of this app's batch is not held up behind a worker.
    try {
      if (await queueShadowBuild(pool, runId)) acted = 'shadow_queued';
    } catch (err) {
      log.error('homeroom-bot', 'Queueing a shadow build failed', { app: app.slug, issueNumber, err: err.message });
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
  if (!settings?.shadowBuilds) return 'shadow builds are off';
  if (live.isLiveFor(settings, app)) return 'the app is live now';
  if (!settings.shadowBuildPlatform && isPlatformRepo(app, config)) {
    return "the platform's own repository is left out";
  }
  if ((settings.pausedApps || []).includes(app?.slug)) return 'the app is paused';
  return null;
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

function shadowBuildsApply(settings, app, config = {}) {
  return shadowBuildSkipReason(settings, app, config) === null;
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
        -- A build whose worker outlived a restart is restart recovery's to
        -- finish (#3401): its session still carries the turn in flight.
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
  RETURNING r.id, r.app_id, r.issue_number, r.build_note, r.build_spec_md`;

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
  firstVersion = false, platformRepo = false, model = null, specModel = null,
}) {
  if (!runId || !app) return null;
  return snapshots.recordSnapshot(pool, {
    runId, stage: 'build', appId: app.id, issueNumber,
    baseSha: await headShaOf(github, repo, 'main'),
    texts: { seed, build_note: buildNote || '', preset_spec: presetSpec || '' },
    extra: { model, specModel: specModel || model, firstVersion: !!firstVersion, platformRepo: !!platformRepo },
  });
}

/**
 * The build itself, for a claimed run: the same build live runs, with
 * `propose: false`, so the only thing it leaves is its branch. Debited from
 * the weekly allowance like any turn, and recorded on the run. Resolves
 * 'shadow_built', 'shadow_failed', or 'infra' when the platform could not
 * run it (the claim is handed back and the lane backs off).
 */
async function shadowBuild({
  pool, config, bot, app, repo, issueNumber, issue, seed, parsed, runId,
  turnBudgetMs, model, specModel = null, deps, presetSpec = null,
}) {
  const { limits, managedOpenRouter } = deps;
  await recordBuildSnapshot(pool, {
    runId, app, repo, issueNumber, seed, buildNote: parsed.buildNote, github: deps.github, presetSpec,
    platformRepo: isPlatformRepo(app, config), model, specModel,
  });
  const built = await live.buildAndPropose({
    pool, config, bot, app, repo, issueNumber, issue, seed, buildNote: parsed.buildNote,
    ...buildBudgets(app, config, turnBudgetMs), model, specModel, deps, presetSpec,
    platformRepo: isPlatformRepo(app, config),
    onSession: (session) => pool.query(
      'UPDATE homeroom_bot_runs SET build_session_id = $2 WHERE id = $1', [runId, session.id],
    ),
    propose: false,
  });
  if (built.costUsd > 0) {
    try {
      if (await managedOpenRouter.usesIncludedKey(pool, bot.id)) {
        await limits.recordSpend(pool, bot.id, Math.round(built.costUsd * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('homeroom-bot', 'Shadow build spend debit failed', { err: err.message });
    }
  }
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
            build_model = $10
      WHERE id = $1`,
    [runId, !!built.ok, built.branchName || null, built.sha || null,
      Number.isFinite(built.commits) ? built.commits : null,
      // A spec that failed is noted even on a build that went ahead from
      // the plan; build_ok says which it was (#3396).
      built.ok
        ? (built.specNote ? clip(built.specNote, MAX_ERROR_CHARS) : null)
        : clip([built.error || 'unknown', built.specNote].filter(Boolean).join('; '), MAX_ERROR_CHARS),
      built.costUsd ?? null, built.sessionId || null, built.specMd || null, model || null],
  );
  log.info('homeroom-bot', 'Shadow build', {
    app: app.slug, issueNumber, runId, ok: !!built.ok, branch: built.branchName || null,
    commits: built.commits ?? null, costUsd: built.costUsd ?? null, error: built.ok ? null : built.error,
  });
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
  if (!app) return skip('the app is gone');
  const why = shadowBuildSkipReason(settings, app, config);
  if (why) return skip(why);
  const repo = parseRepo(app.repo_url);
  if (!repo) return skip('the app has no GitHub repository');
  if (!github.isEnabled()) return handBack('github_unavailable');

  const fetched = await github.fetchPublicIssue(repo.owner, repo.repo, issueNumber);
  const issue = fetched?.issue || null;
  if (!issue || (issue.state && issue.state !== 'open')) return skip('the issue is no longer open');

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
    model: stageModel(settings, config, 'build'), specModel: stageModel(settings, config, 'spec'),
    deps: {
      worker, agentTurn, limits, managedOpenRouter, sessions, activeWorkers, sessionLifecycle, github,
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
    const { rows } = await pool.query(CLAIM_BUILDS_SQL, [free, settings.pausedApps || []]);
    for (const claim of rows) {
      const promise = runQueuedBuild(pool, config, { bot, claim, settings, deps })
        .catch(async (err) => {
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

// ── After a restart ──────────────────────────────────────────────────────
//
// A platform redeploy restarts the server, not the worker: a build's worker
// is its own Pod, and its turn runs detached with a journal. Restart
// recovery (server.js adoptOrphanWorker → resumeDetachedTurn) follows that
// journal to the end, as it does a person's turn. What it does NEXT is the
// dev-chat tail: a draft PR, a staging preview, a wrap-up and a
// notification, none of which a shadow build may leave. So recovery hands
// the bot's own turns back here instead (#3401), the way Mayor's
// handBackAfterRecovery takes back its conversations, and the bot records
// what the turn did on the run it belongs to.
//
// Which sessions: the bot's, while `active`, which is every bot turn except
// a follow-up on a proposal the group is voting on. That session is
// `promoted`, and a person's recovery (the PR and staging updated) is the
// right end for it.

/**
 * True when restart recovery should hand this session to the bot.
 *
 * A bot session found `paused` WITH a turn record is the bot's too. The
 * bot never pauses a session under its own turn, but before #1006 its
 * triage pass paused a running build's session (ensureBotSession took the
 * newest one), and recovery read the pause as "nobody wants this" and
 * destroyed the worker in silence. A turn record means something was
 * running: the bot follows it or hands its run back, never neither.
 */
function isRecoveredBotSession(session) {
  return !!session
    && session.username === live.BOT_USERNAME
    && session.user_is_synthetic === true
    && (session.status === 'active' || (session.status === 'paused' && !!session.active_turn));
}

/** The build run a session is the build of, while it is still under way. */
async function runOfSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT id, app_id, issue_number, build_attempts
       FROM homeroom_bot_runs
      WHERE build_session_id = $1 AND build_at IS NOT NULL AND build_ok IS NULL
      ORDER BY id DESC LIMIT 1`,
    [sessionId],
  );
  return rows[0] || null;
}

/**
 * When the bot's own clock ends a recovered turn: its start plus the budget
 * the turn had (a build's or a spec's, the platform's doubled), or null to
 * leave it unbounded (no start on record).
 */
async function recoveryDeadline(pool, config, session, activeTurn) {
  const startedAt = toMs(activeTurn?.startedAt);
  if (!startedAt) return null;
  const settings = await readSettings(pool);
  const turnMs = 1000 * clampInt(settings?.turnSeconds, DEFAULTS.turnSeconds, MIN_TURN_SECONDS, MAX_TURN_SECONDS);
  const budgets = buildBudgets({ repo_url: session.repo_url }, config, turnMs);
  const run = await runOfSession(pool, session.id);
  if (!run) return startedAt + turnMs; // a triage turn: one turn's budget
  return startedAt + (activeTurn.mode === 'scout'
    ? Math.min(budgets.turnBudgetMs, budgets.specBudgetMs)
    : budgets.turnBudgetMs);
}

/** Put a run back in the queue without spending an attempt: a restart is not the build's failure. */
async function handBackRun(pool, runId, why) {
  await pool.query(
    `UPDATE homeroom_bot_runs
        SET build_at = NULL, build_attempts = GREATEST(build_attempts - 1, 0), build_session_id = NULL
      WHERE id = $1 AND build_ok IS NULL`,
    [runId],
  );
  log.info('homeroom-bot', 'Handed a build back to the queue after a restart', { runId, why });
  wakeBuilds();
}

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

/** Both turns of a build session are the build's cost, as on the live path. */
async function sessionCostUsd(pool, sessionId) {
  const { rows } = await pool.query(
    'SELECT SUM(estimated_cost_usd)::float8 AS cost FROM agent_turns WHERE session_id = $1',
    [sessionId],
  );
  const cost = Number(rows[0]?.cost);
  return Number.isFinite(cost) ? cost : null;
}

/** A recovered turn's cost, debited from the bot's allowance as the live path debits a build. */
async function debitRecovered(pool, session, costUsd, deps = {}) {
  if (!(costUsd > 0)) return;
  try {
    const managedOpenRouter = deps.managedOpenRouter || require('./openrouter-managed-keys');
    const limits = deps.limits || require('./limits');
    if (await managedOpenRouter.usesIncludedKey(pool, session.user_id)) {
      await limits.recordSpend(pool, session.user_id, Math.round(costUsd * 1e6) / 1e4, { byok: false });
    }
  } catch (err) {
    log.warn('homeroom-bot', 'Recovered turn spend debit failed', { sessionId: session.id, err: err.message });
  }
}

/**
 * A recovered turn of the bot's, finished. `result` is what the journal
 * replay returned; `timedOut` says the bot's clock, re-armed by recovery,
 * ended it. Never throws on the run's account: recovery clears the turn
 * record whatever this does.
 *
 *   - a build turn: recorded on its run, built or failed, as shadowBuild
 *     records one, and its cost debited from the allowance;
 *   - a spec turn: the spec kept on the run, and the run put back in the
 *     queue, where its build starts from that spec; a spec that found the
 *     request impossible is recorded as such;
 *   - a turn no build run owns (a triage): nothing to record; the queue
 *     row it held is released and triaged again.
 */
async function finishRecoveredTurn({ pool, session, activeTurn, result = {}, timedOut = false, deps = {} }) {
  const run = await runOfSession(pool, session.id);
  if (!run && await noteRecoveredLive(pool, session, { mode: activeTurn?.mode, result, timedOut })) {
    return 'live_pending';
  }
  if (!run) {
    await putAwayRecoveredSession(pool, session, { archive: false });
    log.info('homeroom-bot', 'Recovered a bot turn no build owns; left for the queue', { sessionId: session.id });
    return 'released';
  }
  const note = ' (finished after a restart)';
  if (activeTurn?.mode === 'scout') {
    const read = timedOut ? { ok: false, error: 'the spec ran past its time limit' } : live.readSpec(result.lastResultText);
    await putAwayRecoveredSession(pool, session, { archive: true });
    const specCostUsd = await sessionCostUsd(pool, session.id);
    await debitRecovered(pool, session, specCostUsd, deps);
    if (read.blocked) {
      await pool.query(
        `UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = $2, build_cost_usd = $3
          WHERE id = $1 AND build_ok IS NULL`,
        [run.id, clip(read.error + note, MAX_ERROR_CHARS), specCostUsd],
      );
      wakeBuilds();
      return 'blocked';
    }
    if (read.ok) {
      await pool.query('UPDATE homeroom_bot_runs SET build_spec_md = $2 WHERE id = $1', [run.id, read.specMd]);
    }
    await handBackRun(pool, run.id, read.ok ? 'the spec is written; the build goes on from it' : read.error);
    return 'requeued';
  }

  const turnFailed = timedOut ? null : live.failedClaudeTurn(result);
  const built = result.pushOk === true && Number(result.ahead) > 0 && !timedOut && !turnFailed;
  const error = built ? null
    : timedOut ? `the build ran past its time limit${note}`
      : turnFailed ? `the build turn failed (${turnFailed})${note}`
        : `the build produced no change to propose${note}`;
  const costUsd = await sessionCostUsd(pool, session.id);
  await pool.query(
    `UPDATE homeroom_bot_runs r
        SET build_ok = $2, build_branch = $3, build_sha = $4, build_commits = $5,
            build_error = $6, build_cost_usd = $7,
            build_spec_md = COALESCE(r.build_spec_md, (SELECT spec_md FROM chat_sessions WHERE id = $8))
      WHERE r.id = $1 AND r.build_ok IS NULL`,
    [run.id, built, built ? session.branch_name || null : null, result.sha || null,
      built ? Number(result.ahead) : null, error, costUsd, session.id],
  );
  await putAwayRecoveredSession(pool, session, { archive: true });
  await debitRecovered(pool, session, costUsd, deps);
  log.info('homeroom-bot', 'Recorded a shadow build that finished after a restart', {
    runId: run.id, sessionId: session.id, ok: built, commits: result.ahead ?? null, costUsd,
  });
  wakeBuilds();
  return built ? 'shadow_built' : 'shadow_failed';
}

/**
 * A bot turn recovery could not follow: the worker is gone, or the journal
 * replay failed. The run goes back in the queue unspent; the session is put
 * away. The caller clears the turn record.
 */
async function abandonRecoveredTurn({ pool, session, why }) {
  const run = await runOfSession(pool, session.id);
  if (!run && await noteRecoveredLive(pool, session, { lost: true, why })) return 'live_pending';
  if (run) await handBackRun(pool, run.id, why);
  await putAwayRecoveredSession(pool, session, { archive: !!run });
  return run ? 'requeued' : 'released';
}

/**
 * A bot turn the stale-turn watchdog reaped (server.js): its worker stopped
 * with nothing in this process following it, and the watchdog has cleared
 * the turn record. A person is told to retry; the bot has nobody to tell,
 * so its run goes back in the queue unspent, or a live one is settled the
 * way restart recovery settles one it could not follow. Before #1006 the
 * reap was the end of it: the run sat claimed until the stale-build release
 * spent its attempt, and after two the build was recorded lost. A build
 * this process is still running records its own outcome, untouched.
 */
async function settleReapedTurn({ pool, config = {}, session }) {
  const run = await runOfSession(pool, session.id);
  if (run && buildsInFlight.has(run.id)) return 'in_flight';
  const outcome = await abandonRecoveredTurn({
    pool, session, why: 'the stale-turn watchdog reaped its turn',
  });
  await completeRecoveredLive({ pool, config, sessionId: session.id });
  return outcome;
}

// ── A live build after a restart (#3471) ─────────────────────────────────
//
// A live build is the live path's, not the lane's: its triage pass already
// dropped the issue's queue row, said it was looking and posted the spec,
// and meant to promote the build and say so. A restart ends that pass, so
// recovery does the rest. It is noted while the journal is followed and done
// once recovery has let go of the session (completeRecoveredLive, called by
// server.js's adoptBotOrphan), the order the live path promotes in: after
// the build turn, not inside it.

// sessionId → what recovery found, until completeRecoveredLive acts on it.
const pendingLive = new Map();

// How the run of a live build a restart cut short, and that was sent back to
// be triaged again, ends its error. The piece of work goes on in the look
// that follows, so it is not what that work came to: the person's activity
// card reads past it to that look's run (homeroom-bot-activity.js).
const RESTARTED_BUILD_NOTE = 'by a restart; the issue was sent back to be triaged again';

// How many builds of one request in a row a restart may send back to be
// triaged again. Nothing counted them: on 30 Sep, with 85 merges to main and
// a deploy behind most of them, a request a restart kept catching went round
// again each time (a new ready run, a new spec on the issue, more spend) and
// never ended in a proposal or in a word about why. A spec turn that wrote a
// plan no longer goes round (resumeLiveBuildFromSpec), so this is the
// backstop for the rest: a worker lost with the restart, a spec turn cut
// short before it had a plan. The third one in a row within the window is
// not sent back: it is recorded failed and said, as any failed build is, and
// a reply or Run now starts it again.
const MAX_RESTARTED_BUILDS = 3;
const RESTARTED_BUILDS_WINDOW_HOURS = 24;

/**
 * How many of the request's latest live builds before `runId`, back to back
 * and within the window, a restart sent back. A run that never started a
 * build (a held verdict, a question) is not one of its builds and does not
 * break the count.
 */
async function restartedBuildsBefore(pool, { appId, issueNumber, runId }) {
  const { rows } = await pool.query(
    `SELECT build_error FROM homeroom_bot_runs
      WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND id < $3
        AND build_session_id IS NOT NULL
        AND created_at > NOW() - make_interval(hours => $4)
      ORDER BY id DESC
      LIMIT $5`,
    [appId, issueNumber, runId, RESTARTED_BUILDS_WINDOW_HOURS, MAX_RESTARTED_BUILDS - 1],
  );
  let n = 0;
  for (const row of rows) {
    if (!String(row.build_error || '').endsWith(RESTARTED_BUILD_NOTE)) break;
    n += 1;
  }
  return n;
}

/**
 * Put a live run whose spec turn a restart interrupted back in line for its
 * build, with the spec recovery read from that turn kept on it: buildOne
 * builds from it (buildAndPropose's presetSpec) rather than writing another.
 * The interrupted session is not its build's any more, so the link to it is
 * cleared, and what the spec turn cost stays on the run for the build to
 * carry. True when the run was put back; never throws.
 */
async function resumeLiveBuildFromSpec(pool, { runId, appId, specMd, costUsd = null }) {
  try {
    const { rows } = await pool.query(
      `UPDATE homeroom_bot_runs
          SET build_spec_md = $2, build_cost_usd = $3, build_session_id = NULL, live_build_waiting_at = NOW()
        WHERE id = $1 AND mode = 'live' AND build_ok IS NULL AND proposal_session_id IS NULL
        RETURNING id`,
      [runId, specMd, Number.isFinite(costUsd) ? costUsd : null],
    );
    if (!rows.length) return false;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not put a live build back in line with its plan', { runId, err: err.message });
    return false;
  }
  wake({ appId });
  return true;
}

/** The live run a session is the build of, while it has no proposal or recorded outcome yet. */
async function liveRunOfSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT id, app_id, issue_number
       FROM homeroom_bot_runs
      WHERE build_session_id = $1 AND mode = 'live' AND proposal_session_id IS NULL
        AND build_ok IS NULL
      ORDER BY id DESC LIMIT 1`,
    [sessionId],
  );
  return rows[0] || null;
}

/** Note a recovered live build for completeRecoveredLive. False when the session is no live build's. */
async function noteRecoveredLive(pool, session, outcome) {
  const run = await liveRunOfSession(pool, session.id);
  if (!run) return false;
  pendingLive.set(Number(session.id), { runId: run.id, appId: run.app_id, issueNumber: run.issue_number, ...outcome });
  return true;
}

/** Send an issue back to be triaged again, without saying "looking" twice. */
async function requeueForRestart(pool, appId, issueNumber) {
  await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (app_id, issue_number) DO UPDATE
       SET priority = LEAST(homeroom_bot_queue.priority, 1), reason = EXCLUDED.reason,
           started_at = NULL, enqueued_at = NOW()`,
    [appId, issueNumber, RESTART_REASON],
  );
  wake({ appId });
}

/**
 * Finish a live build recovery noted, once the session is free:
 *   - a build turn that pushed commits is proposed, and the proposal (and its
 *     spec) said on the issue, as the live path would have;
 *   - a build turn that pushed nothing, or ran out of time, is said to have
 *     failed;
 *   - a spec turn that found the request impossible says so;
 *   - a spec turn that wrote a plan keeps it, and the build goes on from it
 *     (resumeLiveBuildFromSpec);
 *   - any other spec turn, and a turn recovery could not follow at all, sends
 *     the issue back to be triaged again: its queue row is gone, and without
 *     this the issue would sit on "looking into it" for good. The third such
 *     build in a row (MAX_RESTARTED_BUILDS) is said to have failed instead.
 * Never throws; returns what it did, or null when nothing was noted.
 */
async function completeRecoveredLive({ pool, config = {}, sessionId, deps = {} }) {
  const plan = pendingLive.get(Number(sessionId));
  if (!plan) return null;
  pendingLive.delete(Number(sessionId));
  try {
    const { rows: [session] } = await pool.query(
      `SELECT cs.id, cs.user_id, cs.status, cs.branch_name, cs.spec_md, cs.agent_model,
              (SELECT MAX(version) FROM chat_session_specs WHERE session_id = cs.id) AS spec_version
         FROM chat_sessions cs WHERE cs.id = $1`,
      [sessionId],
    );
    const { rows: [app] } = await pool.query(
      'SELECT id, slug, name, repo_url, self_hosted FROM apps WHERE id = $1', [plan.appId],
    );
    if (!session || !app) return 'gone';
    const archive = () => putAwayRecoveredSession(pool, session, { archive: true });
    const costUsd = await sessionCostUsd(pool, session.id);
    await debitRecovered(pool, session, costUsd, deps);

    const specRead = plan.mode === 'scout' && !plan.lost && !plan.timedOut
      ? live.readSpec(plan.result?.lastResultText) : null;
    // Set when restarts have cut this request's builds short too many times
    // in a row to send it round again (MAX_RESTARTED_BUILDS).
    let restartedOut = 0;
    if (plan.lost || (plan.mode === 'scout' && !specRead?.blocked)) {
      await archive();
      // WP1 (#2): a build its request no longer needs (stopped by its merge,
      // or answered by another proposal of the bot's) is not started again:
      // recorded as the skip it is, with nothing said.
      const notNeeded = await whyNotBuild(pool, {
        runId: plan.runId, botId: session.user_id, appId: app.id, issueNumber: plan.issueNumber,
      });
      if (notNeeded) {
        await recordLiveBuild(pool, plan.runId, { ok: false, sessionId: Number(sessionId), costUsd, error: notNeeded });
        log.info('homeroom-bot', 'A live build a restart interrupted is not needed any more', {
          app: app.slug, issueNumber: plan.issueNumber, sessionId, why: notNeeded,
        });
        return 'skipped';
      }
      // The person it is for hears it once, so a card that goes back a step
      // is never a mystery (WP1, #9). Never a reason recovery fails.
      const sayRestarted = () => (deps.dm || require('./homeroom-bot-dm')).noteBuildRestarted(pool, {
        app, issueNumber: plan.issueNumber, runId: plan.runId,
      }).catch((err) => log.warn('homeroom-bot', 'Could not say a build was started again', { sessionId, err: err.message }));
      // A spec turn recovery followed to its end with a plan in it: the plan
      // is kept and the build goes on from it, on the same run, as the shadow
      // lane's does (finishRecoveredTurn). Thrown away, the request went back
      // to be triaged and planned from the start, and the next restart could
      // land in that plan too.
      if (specRead?.ok && await resumeLiveBuildFromSpec(pool, {
        runId: plan.runId, appId: plan.appId, specMd: specRead.specMd, costUsd,
      })) {
        log.info('homeroom-bot', 'Kept the plan of a live build a restart interrupted; its build goes on from it', {
          app: app.slug, issueNumber: plan.issueNumber, sessionId,
        });
        await sayRestarted();
        return 'resumed';
      }
      const before = await restartedBuildsBefore(pool, plan).catch(() => 0);
      if (before + 1 < MAX_RESTARTED_BUILDS) {
        // The run says what became of its build: it was interrupted, and the
        // issue goes round again as a new run, which speaks for itself. Left
        // unrecorded, it read as a build with a session and no outcome (run
        // 613), indistinguishable from one still going.
        await recordLiveBuild(pool, plan.runId, {
          ok: false, sessionId: Number(sessionId), costUsd,
          error: `interrupted: ${plan.lost ? (plan.why || 'the turn was lost') : 'the spec turn was cut short'}`
            + ` ${RESTARTED_BUILD_NOTE}`,
        });
        await requeueForRestart(pool, plan.appId, plan.issueNumber);
        log.info('homeroom-bot', 'Sent a live issue back to be triaged after a restart', {
          app: app.slug, issueNumber: plan.issueNumber, sessionId, why: plan.why || plan.mode,
        });
        await sayRestarted();
        return 'requeued';
      }
      // Not sent round again: said below as a failed build, so the person
      // hears why, and recorded without RESTARTED_BUILD_NOTE, so their
      // activity card stops on it instead of reading past it.
      restartedOut = before + 1;
      log.warn('homeroom-bot', 'Restarts cut a live build short too many times in a row; not sending it back', {
        app: app.slug, issueNumber: plan.issueNumber, sessionId, inARow: restartedOut, why: plan.why || plan.mode,
      });
    }

    const github = deps.github || require('./github');
    const repo = parseRepo(app.repo_url);
    const fetched = repo ? await github.fetchPublicIssue(repo.owner, repo.repo, plan.issueNumber).catch(() => null) : null;
    const issue = fetched?.issue || null;
    if (!issue || (issue.state && issue.state !== 'open')) {
      await archive();
      return 'not_open';
    }
    // The session's own user: recovery hands the bot only its own sessions
    // (isRecoveredBotSession checks the name and the synthetic flag).
    const bot = { id: session.user_id, username: live.BOT_USERNAME };
    const liveD = liveDeps(deps);
    const say = liveSayer({
      pool, github, ws: liveD.ws, app, repo, issueNumber: plan.issueNumber, issue, runId: plan.runId, bot,
      botLogin: await live.botUsernameOf(github), notifications: deps.notifications || null,
    });
    const note = ' (finished after a restart)';
    // A failed turn is a failed build here as on the live path.
    const turnFailed = plan.mode === 'scout' || plan.timedOut
      ? null : live.failedClaudeTurn(plan.result);
    let built;
    if (restartedOut) {
      built = {
        ok: false, sessionId: Number(sessionId),
        error: `the platform restarted in the middle of each of its last ${restartedOut} tries at building this`,
      };
    } else if (plan.mode === 'scout') {
      built = { ok: false, sessionId: Number(sessionId), blocked: specRead.blocked };
    } else if (plan.result?.pushOk === true && Number(plan.result?.ahead) > 0 && !plan.timedOut && !turnFailed) {
      const pushed = {
        branchName: session.branch_name || null, sha: plan.result.sha || null, commits: Number(plan.result.ahead) || 0,
      };
      // WP1 (#2): not proposed once a proposal of the bot's answers the
      // request, or it was closed, as the live path does (whyNotBuild).
      const skipped = await whyNotBuild(pool, {
        runId: plan.runId, botId: bot.id, appId: app.id, issueNumber: plan.issueNumber, github, repo,
      });
      if (skipped) {
        await archive();
        await recordLiveBuild(pool, plan.runId, { ok: false, sessionId: Number(sessionId), costUsd, ...pushed, error: skipped });
        log.info('homeroom-bot', 'A live build a restart interrupted was not proposed', {
          app: app.slug, issueNumber: plan.issueNumber, sessionId, why: skipped,
        });
        return 'skipped';
      }
      // Named and described from the spec and the build's own message, as
      // the live path does before it proposes (#3518).
      await live.prepareProposal({
        pool, bot, sessionId, spec: session.spec_md || null,
        buildText: plan.result.lastResultText, model: session.agent_model || null,
      });
      const promoted = await live.promoteAsBot({
        config, bot, sessionId, router: liveD.votesRouter, ceiling: botProposalCeiling(await readSettings(pool).catch(() => null)),
      });
      if (promoted.status === 200 && promoted.body?.ok) {
        built = {
          ok: true, sessionId: Number(sessionId), prNumber: promoted.body.prNumber || null,
          specMd: session.spec_md || null, specVersion: session.spec_version || null, ...pushed,
        };
      } else {
        // Built but not proposed: left as the live path leaves it, for a
        // person to open and propose.
        const why = promoted.body?.error || promoted.body?.message || `promotion answered ${promoted.status}`;
        await putAwayRecoveredSession(pool, session, { archive: false });
        built = {
          ok: false, sessionId: Number(sessionId), ...pushed,
          error: `the change was built but could not be proposed: ${why}`,
        };
      }
    } else {
      await archive();
      built = {
        ok: false, sessionId: Number(sessionId),
        error: (plan.timedOut ? 'the build ran past its time limit'
          : turnFailed ? `the build turn failed (${turnFailed})`
            : 'the build produced no change to propose') + note,
      };
    }
    if (built.blocked) await archive();
    built.costUsd = costUsd;
    const acted = await announceBuilt({
      pool, ws: liveD.ws, app, bot, issueNumber: plan.issueNumber, runId: plan.runId, built, say, domain: liveD.domain,
    });
    log.info('homeroom-bot', 'Finished a live build a restart interrupted', {
      app: app.slug, issueNumber: plan.issueNumber, sessionId, acted,
    });
    return acted;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not finish a recovered live build', { sessionId, err: err.message });
    return 'error';
  }
}

/**
 * Hold a lane slot for a build recovery is finishing, so the lane does not
 * start more than `buildConcurrency` builds beside it. Resolves with the
 * recovery's own outcome.
 */
async function holdSlotDuringRecovery(pool, sessionId, recovery) {
  let run = null;
  try { run = await runOfSession(pool, sessionId); } catch (_) { run = null; }
  if (!run) return holdLiveBuildDuringRecovery(pool, sessionId, recovery);
  if (buildsInFlight.has(run.id)) return recovery;
  const promise = Promise.resolve(recovery).finally(() => {
    buildsInFlight.delete(run.id);
    wakeBuilds();
  });
  buildsInFlight.set(run.id, {
    appId: run.app_id, issueNumber: run.issue_number, startedAt: new Date().toISOString(),
    promise: promise.catch(() => null), recovered: true,
  });
  return promise;
}

/**
 * A live build restart recovery is finishing holds its project's build slot
 * (`build:<appId>`, see dispatch), so the lane does not start the project's
 * next waiting build beside it. Resolves with the recovery's own outcome.
 */
async function holdLiveBuildDuringRecovery(pool, sessionId, recovery) {
  let run = null;
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.app_id, r.issue_number, COALESCE(q.user_id, 0) AS person_id
         FROM homeroom_bot_runs r
         LEFT JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
        WHERE r.build_session_id = $1 AND r.mode = 'live' AND r.build_ok IS NULL
        ORDER BY r.id DESC LIMIT 1`,
      [sessionId],
    );
    run = rows[0] || null;
  } catch (_) { run = null; }
  const slot = run ? `build:${Number(run.app_id)}` : null;
  if (!run || inFlight.has(slot)) return recovery;
  inFlight.set(slot, {
    lane: 'live', build: true, recovered: true, appId: Number(run.app_id),
    person: personKeyOf({ person_id: Number(run.person_id) || null, app_id: run.app_id }),
    issueNumber: Number(run.issue_number), runId: Number(run.id), itemId: null, startedAt: new Date().toISOString(),
  });
  liveBuildsInFlight.add(Number(run.id));
  return Promise.resolve(recovery).finally(() => {
    inFlight.delete(slot);
    liveBuildsInFlight.delete(Number(run.id));
    requestPass();
  });
}

// ── A live build nothing finished ────────────────────────────────────────
//
// A live build is recorded on its run by the live path (announceBuilt), or
// by restart recovery when its worker outlived a restart (#3471). Neither
// runs when the restart took the worker with it and recovery never saw the
// session, or when a second restart lost what recovery had noted, and the
// run was left with a build session and no outcome: nothing said on the
// issue, and its queue row long gone. This sweep is the backstop. A live
// run whose build started longer ago than any build can take, and that
// nothing in this process is still building or recovering, is recorded as
// failed, its session put away, and the issue told once that the build was
// lost (the same "couldn't build" note, in the DM too), unless the issue has
// moved on: a newer run speaks for it, a closed issue needs nothing, an app
// the bot is no longer live on is not posted on, and a run whose outcome
// was already said (before #3509 recorded it) is only recorded.

// runId of every live build actOnVerdict has under way in this process.
const liveBuildsInFlight = new Set();
// How far back the sweep looks. Older runs are history, not a build anybody
// is waiting on.
const ABANDONED_LIVE_WINDOW_DAYS = 7;
const ABANDONED_LIVE_BATCH = 20;
// What the run records, and what the issue is told.
const ABANDONED_LIVE_ERROR = 'interrupted: the platform restarted mid-build and nothing recovered the build';
const ABANDONED_LIVE_REASON = 'the platform restarted while it was building, and the build was lost';

const ABANDONED_LIVE_SQL = `SELECT r.id, r.app_id, r.issue_number, r.build_session_id,
            cs.status AS session_status,
            EXISTS (
              SELECT 1 FROM homeroom_bot_runs n
               WHERE n.app_id = r.app_id AND n.issue_number = r.issue_number AND n.id > r.id
            ) AS superseded,
            (SELECT p.kind FROM homeroom_bot_posts p
              WHERE p.run_id = r.id AND p.kind IN ('proposal', 'build_failed', 'blocked')
              ORDER BY p.id DESC LIMIT 1) AS said
       FROM homeroom_bot_runs r
       JOIN chat_sessions cs ON cs.id = r.build_session_id
      WHERE r.mode = 'live' AND r.build_ok IS NULL AND r.proposal_session_id IS NULL
        AND r.build_queued_at IS NULL
        AND r.created_at < NOW() - make_interval(secs => $1)
        AND r.created_at > NOW() - make_interval(days => $2)
        AND NOT (r.id = ANY($3::int[]))
        AND NOT (r.build_session_id = ANY($4::int[]))
        -- A turn still on the session is restart recovery's to finish, for
        -- as long as one could plausibly be running.
        AND (cs.active_turn IS NULL OR r.created_at < NOW() - INTERVAL '1 day')
      ORDER BY r.id
      LIMIT $5`;

/** How long after its run a live build is past any build's clocks (the platform's, the longest). */
function abandonedLiveAfterSeconds(settings) {
  const turnSeconds = Number(settings?.turnSeconds) || DEFAULTS.turnSeconds;
  return PLATFORM_BUILD_TIME_FACTOR * (turnSeconds + live.SPEC_TURN_MAX_MS / 1000) + STALE_CLAIM_MARGIN_SECONDS;
}

/**
 * Record, and say once, every live build nothing finished (see above).
 * Resolves how many runs it recorded. Never throws.
 */
async function settleAbandonedLiveBuilds(pool, settings, deps = {}) {
  let rows;
  try {
    ({ rows } = await pool.query(ABANDONED_LIVE_SQL, [
      abandonedLiveAfterSeconds(settings), ABANDONED_LIVE_WINDOW_DAYS,
      [...liveBuildsInFlight], [...pendingLive.keys()], ABANDONED_LIVE_BATCH,
    ]));
  } catch (err) {
    log.warn('homeroom-bot', 'Could not look for live builds nothing finished', { err: err.message });
    return 0;
  }
  let settled = 0;
  for (const run of rows) {
    try {
      // A session that became a proposal after all (the process died
      // between the promote and its announcement): the build worked.
      const proposed = ['promoted', 'merging', 'merged'].includes(run.session_status);
      const error = proposed ? null
        : run.said ? `not recorded when it ended; the issue was told: ${run.said}`
          : ABANDONED_LIVE_ERROR;
      // The claim: only the first process to record it says anything.
      const { rows: claimed } = await pool.query(
        `UPDATE homeroom_bot_runs
            SET build_ok = $2, build_error = $3,
                proposal_session_id = CASE WHEN $2 THEN build_session_id ELSE proposal_session_id END
          WHERE id = $1 AND build_ok IS NULL
          RETURNING id`,
        [run.id, proposed, error],
      );
      if (!claimed.length) continue;
      settled += 1;
      if (!proposed) {
        await putAwayRecoveredSession(pool, { id: run.build_session_id }, { archive: true });
      }
      log.warn('homeroom-bot', 'Recorded a live build nothing finished', {
        runId: run.id, appId: run.app_id, issueNumber: run.issue_number, sessionId: run.build_session_id,
        proposed, said: run.said || null, superseded: !!run.superseded,
      });
      if (proposed || run.said || run.superseded) continue;
      await sayBuildLost(pool, settings, run, deps);
    } catch (err) {
      log.warn('homeroom-bot', 'Could not record a live build nothing finished', { runId: run.id, err: err.message });
    }
  }
  return settled;
}

/** The "couldn't build" note for a lost live build, on an open issue of an app the bot is live on. */
async function sayBuildLost(pool, settings, run, deps = {}) {
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
  await say('build_failed', live.buildFailedText(ABANDONED_LIVE_REASON), { dm: { reason: ABANDONED_LIVE_REASON } });
  await live.advanceSeen({
    pool, github, threadContext: deps.threadContext || require('./thread-context'), app, repo, issueNumber,
    runId: run.id, since, postedAt,
  }).catch(() => {});
  return 'said';
}

/**
 * The admin's "build every open ready request": queue the latest verdict
 * of every issue whose latest verdict is ready and that has not been built,
 * queued or skipped. The issue's state is read at build time, so a closed
 * one is skipped then rather than fetched for here.
 */
const BACKFILL_SQL = `SELECT DISTINCT ON (r.app_id, r.issue_number)
         r.id, r.app_id, r.issue_number, r.verdict, r.build_queued_at, r.build_ok, r.build_error,
         a.slug, a.repo_url
    FROM homeroom_bot_runs r
    JOIN apps a ON a.id = r.app_id
   WHERE r.verdict IN ('question', 'ready', 'person', 'empty')
     AND a.status = 'running' AND a.repo_url IS NOT NULL
   ORDER BY r.app_id, r.issue_number, r.id DESC`;

async function queueShadowBackfill(pool, config = {}) {
  const settings = await readSettings(pool);
  if (!settings.shadowBuilds) {
    return { ok: false, status: 409, error: 'Turn shadow builds on first.' };
  }
  const { rows } = await pool.query(BACKFILL_SQL);
  const left = { live: 0, platform: 0, paused: 0 };
  const ids = [];
  for (const r of rows) {
    if (r.verdict !== 'ready' || r.build_queued_at || r.build_ok != null || r.build_error) continue;
    const why = shadowBuildSkipReason(settings, { slug: r.slug, repo_url: r.repo_url }, config);
    if (why === 'the app is live now') { left.live += 1; continue; }
    if (why === "the platform's own repository is left out") { left.platform += 1; continue; }
    if (why === 'the app is paused') { left.paused += 1; continue; }
    if (why) continue;
    ids.push(r.id);
  }
  let queued = [];
  if (ids.length) {
    ({ rows: queued } = await pool.query(
      `UPDATE homeroom_bot_runs SET build_queued_at = NOW()
        WHERE id = ANY($1::int[]) AND build_queued_at IS NULL AND build_ok IS NULL
        RETURNING id, app_id`,
      [ids],
    ));
  }
  if (queued.length) {
    wakeBuilds();
    publishWake({ builds: true });
  }
  log.info('homeroom-bot', 'Shadow build backfill queued', { queued: queued.length, left });
  return {
    ok: true,
    queued: queued.length,
    apps: new Set(queued.map((r) => r.app_id)).size,
    left,
  };
}

/**
 * The lane as the dashboard shows it: counts, and what is building now.
 * Only the lane's own builds: every one was queued, and a live build, whose
 * outcome is recorded in the same columns (#3509), never is.
 */
/**
 * #3654: whether the bot's live builds (ready verdicts on an app it is live
 * on, which a person is waiting for) fill every build slot it has right now,
 * in this process. The benchmark's lane (services/bench/lane.js) starts
 * nothing while they do, so a benchmark never takes a worker a person is
 * waiting on. Shadow builds in the lane do not count: like a benchmark trial
 * they are an experiment nobody waits for, and counting them let a busy
 * shadow lane hold the benchmark back indefinitely. `counts` is for tests.
 */
function isLiveLaneSaturated(settings = null, counts = null) {
  const limit = clampInt(settings?.buildConcurrency, DEFAULTS.buildConcurrency, 1, MAX_BUILD_CONCURRENCY);
  const live = counts && Number.isFinite(counts.live) ? counts.live : liveBuildsInFlight.size;
  return live >= limit;
}

async function buildLaneSummary(pool) {
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
    lane: lastBuildDrain,
    fault: buildFault ? { error: buildFault.error, retryAt: new Date(buildFault.until).toISOString() } : null,
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
 */
async function runFollowUp(pool, config, {
  bot, app, repo, item, issue, proposal, runMode, model, turnBudgetMs, startedMs,
  recordFailure, deps,
}) {
  const { github, threadContext, sessions, limits, managedOpenRouter, agentTurn } = deps;
  const issueNumber = Number(item.issue_number);
  // #3654: what the follow-up turn read, recorded beside its run.
  let snapshot = null;
  const recordSnapshot = (runId) => (snapshot && runId
    ? snapshots.recordSnapshot(pool, { runId, ...snapshot })
    : Promise.resolve(null));
  const fail = async (error, extra = {}, opts = {}) => {
    const out = await recordFailure(error, { proposalSessionId: proposal.id, ...extra }, opts);
    if (!opts.infra && out?.runId) await recordSnapshot(out.runId);
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

  const seedReadAt = new Date().toISOString();
  const [{ comments = [] } = {}, issueThread, proposalThread, botLogin] = await Promise.all([
    github.fetchIssueComments(repo.owner, repo.repo, issueNumber).catch(() => ({ comments: [] })),
    threadContext.loadIssueThread(pool, app.id, issueNumber),
    threadContext.loadProposalThread(pool, app.id, proposal.id),
    live.botUsernameOf(github),
  ]);
  const replies = followup.newReplies({
    comments,
    issueThread: issueThread?.messages || [],
    proposalThread: proposalThread?.messages || [],
    botLogin,
    botUsername: BOT_USERNAME,
    sinceMs: toMs(lastRun?.thread_seen_at),
  });
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
    return { ran: false, reason: 'has_proposal' };
  }

  const { rows: revisionRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM homeroom_bot_runs
      WHERE proposal_session_id = $1 AND verdict = 'revise'`,
    [session.id],
  );
  const canRevise = (revisionRows[0]?.n || 0) < followup.MAX_REVISIONS;
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
  const prompt = followup.followUpPrompt({
    seed, proposalBlock, spec, prNumber: session.pr_number, replies, canRevise, design,
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

  const turn = await followup.runFollowUpTurn({
    pool, config, bot, repo, session, prompt, mode, issueNumber, turnBudgetMs, model, deps,
  });
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
    return fail(`unparseable: ${clip(String(result.lastResultText || '').slice(-300), 300) || '(empty reply)'}`, spent);
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
      // is where somebody wrote.
      proposalSessionId: replies.some((r) => r.where === 'proposal') ? session.id : null,
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
      appId: app.id, issueNumber, mode: runMode, verdict: 'failed', error: `revise: ${why}`,
      reason: parsed.reply, threadSeenAt: item.thread_seen_at || null, model,
      durationMs: Date.now() - startedMs, proposalSessionId: session.id, ...spent,
    });
    await recordSnapshot(runId);
    await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
    const postedAt = [];
    await say('followup_failed', followup.revisionFailedText({ why, prNumber: session.pr_number }), postedAt)
      .catch((err) => log.warn('homeroom-bot', 'Follow-up post failed', { err: err.message }));
    await live.advanceSeen({
      pool, github, threadContext, app, repo, issueNumber, runId, since: seedReadAt, postedAt,
      proposalSessionId: session.id,
    }).catch(() => {});
    await requeueChecks();
    return { ran: true, verdict: 'failed', runId };
  }

  const action = moved ? 'revise' : parsed.action;
  const reply = parsed?.reply || 'It updated the change to follow the latest replies.';
  if (moved) await reconcileRevision({ config, pool, session, app, issueNumber, deps });
  // #3767: and its name, when the revision changed what it does. Ear Trainer's
  // size options were taken out and its proposal was still called "Lead size
  // options with the number of sounds" when it merged.
  if (moved && parsed?.title) await renameRevised({ pool, github, repo, session, title: parsed.title, app });

  const askAnswers = action === 'ask' ? suggestedAnswers(parsed?.answers) : null;
  runId = await insertRun(pool, {
    ...billingOf(item, runMode),
    appId: app.id, issueNumber, mode: runMode, verdict: followup.VERDICT_FOR[action],
    question: action === 'ask' ? reply : null,
    questionAnswers: askAnswers,
    reason: reply,
    buildNote: action === 'revise' ? (parsed?.summary || null) : null,
    threadSeenAt: item.thread_seen_at || null, model,
    durationMs: Date.now() - startedMs, proposalSessionId: session.id, ...spent,
  });
  await recordSnapshot(runId);
  await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
  clearFollowUpRefusals(app.id, issueNumber);
  log.info('homeroom-bot', 'Followed up on its proposal', {
    app: app.slug, issueNumber, sessionId: session.id, action, costUsd, runId,
  });

  const prNumber = session.pr_number;
  const proposalUrl = deps.domain ? live.proposalLink(deps.domain, app.slug, session.id) : null;
  const text = action === 'revise'
    ? followup.revisedText({
      summary: parsed?.summary, reply: parsed?.reply, prNumber, link: proposalUrl,
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
  await say(`followup_${action}`, text, postedAt, { ...card, ...(dm ? { dm } : {}) })
    .catch((err) => log.warn('homeroom-bot', 'Follow-up post failed', { err: err.message }));
  await live.advanceSeen({
    pool, github, threadContext, app, repo, issueNumber, runId, since: seedReadAt, postedAt,
    proposalSessionId: session.id,
  }).catch((err) => log.warn('homeroom-bot', 'Could not record what the bot has seen', { err: err.message }));
  if (!moved) await requeueChecks();
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
      config, pool, session: fresh[0] || session, fresh: true, notify: true,
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

const CHECKS_ROW_SQL = `SELECT cs.id, cs.app_id, cs.linked_issues, cs.check_state, cs.checks_commit_sha,
            cs.reviewed_head_sha, cs.test_results, a.slug, a.name, a.repo_url,
            EXISTS (
              SELECT 1 FROM homeroom_bot_runs r
               WHERE r.proposal_session_id = cs.id
                 AND r.checks_head_sha = LOWER(cs.reviewed_head_sha)
            ) AS looked
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
       JOIN users u ON u.id = cs.user_id
      WHERE cs.id = $1 AND cs.status = 'promoted' AND u.username = $2 AND u.is_synthetic = TRUE`;

/** The fix the bot's proposal `sessionId` is due, or null (followup.checksDue). */
async function checksToFix(pool, sessionId) {
  const { rows } = await pool.query(CHECKS_ROW_SQL, [Number(sessionId), BOT_USERNAME]);
  return followup.checksDue(rows[0]);
}

/**
 * A check verdict settled 'failing' on proposal `sessionId` (visuals.js).
 * When it is the bot's own open proposal, on an app it is live on, and a
 * fix is due on its current head, its issue is queued for a checks
 * follow-up and the loop woken. A run that looks like the platform's fault
 * (followup.checksLookLikeInfra) is left for the platform's own re-run.
 * Never throws; resolves whether it queued.
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
    log.info('homeroom-bot', 'Its proposal\'s checks failed; queued to fix them', {
      app: row.slug, issueNumber, sessionId: row.id, head: due.head, failing: due.failing.length, total: due.total,
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
 */
async function runChecksFix(pool, config, {
  bot, app, repo, item, issue, session, checks, canRevise, mode, runMode, model, turnBudgetMs, startedMs,
  recordFailure, lastRun, seedReadAt, comments, issueThread, proposalThread, botLogin, deps,
}) {
  const { github, threadContext, sessions, limits, managedOpenRouter, agentTurn } = deps;
  const issueNumber = Number(item.issue_number);
  const prNumber = session.pr_number;
  const { head, failing, total } = checks;
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

  if (followup.checksLookLikeInfra(checks)) {
    await dropRow();
    log.info('homeroom-bot', 'Failing checks look like the platform\'s fault; not revising', {
      app: app.slug, issueNumber, sessionId: session.id, failing: failing.length, total,
    });
    return { ran: false, reason: 'checks_infra' };
  }

  let runId = null;
  const handOff = async ({ why, verdict, extra = {} }) => {
    runId = await insertRun(pool, {
      ...billingOf(item, runMode),
      appId: app.id, issueNumber, mode: runMode, verdict,
      reason: why, error: verdict === 'failed' ? `checks: ${why}` : null,
      threadSeenAt, model, durationMs: Date.now() - startedMs,
      proposalSessionId: session.id, checksHeadSha: head, ...extra,
    });
    await recordSnapshot(runId);
    await dropRow();
    const targets = await live.mentionTargets({
      pool, github, app, repo, issueNumber, issue, botLogin, bot, proposalSessionId: session.id,
    }).catch(() => []);
    const text = followup.checksPersonText({ why, prNumber, failingCount: failing.length });
    const posted = await live.post({
      pool, github, ws: deps.ws, app, repo, issueNumber, kind: 'followup_person', runId, text,
      sender: bot, senderId: bot.id, mentions: targets, notifications: deps.notifications || null,
      // Said where the group votes too: the checks are the proposal's.
      proposalSessionId: session.id,
      dm: { reason: `its checks are failing: ${why}` },
    }).catch((err) => {
      log.warn('homeroom-bot', 'Checks hand-off post failed', { app: app.slug, issueNumber, err: err.message });
      return null;
    });
    await live.advanceSeen({
      pool, github, threadContext, app, repo, issueNumber, runId, since: seedReadAt,
      postedAt: posted?.githubCreatedAt ? [posted.githubCreatedAt] : [], proposalSessionId: session.id,
    }).catch(() => {});
    log.info('homeroom-bot', 'Handed its proposal\'s failing checks to a person', {
      app: app.slug, issueNumber, sessionId: session.id, head, why,
    });
    return { ran: true, verdict, runId, acted: 'checks_person' };
  };

  // Out of revisions: no turn, one note.
  if (!canRevise) {
    return handOff({
      why: `it has already updated this change ${followup.MAX_REVISIONS} times, as many as it may on its own`,
      verdict: 'person',
    });
  }

  const seed = sessions.buildHeadlessSeed(issueNumber, issue, comments, botLogin, issueThread?.messages || []);
  const proposalBlock = require('./thread-context').buildProposalDiscussionBlock({
    sessionId: session.id, prNumber,
    threadMessages: proposalThread?.messages || [], truncated: !!proposalThread?.truncated,
  });
  const prompt = followup.checksFixPrompt({ seed, proposalBlock, prNumber, failing, total });
  snapshot = {
    stage: 'checks_fix', appId: app.id, issueNumber,
    baseSha: head,
    texts: {
      seed, prompt, proposal_block: proposalBlock,
      failing: JSON.stringify(failing),
      thread: snapshots.frozenThread({
        issueNumber, issue, comments, threadMessages: issueThread?.messages || [], botLogin,
      }),
    },
    extra: { model, prNumber: prNumber || null, total, mode },
  };
  const turn = await followup.runFollowUpTurn({
    // `mode` is runFollowUp's: a build turn, since revisions remain.
    pool, config, bot, repo, session, prompt, mode, issueNumber, turnBudgetMs, model, deps,
    commitMsg: `Homeroom bot: fix the failing checks on #${issueNumber}`,
  });
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
    await reconcileRevision({ config, pool, session, app, issueNumber, deps });
    const summary = parsed?.summary || parsed?.reply || 'It updated the change so its checks pass.';
    runId = await insertRun(pool, {
      ...billingOf(item, runMode),
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
    // cleared there.
    const link = deps.domain ? live.proposalLink(deps.domain, app.slug, session.id) : null;
    await live.postOnProposal({
      pool, ws: deps.ws, app, issueNumber, runId, kind: 'checks_revise', bot, sessionId: session.id,
      text: followup.checksRevisedText({ summary, reply: parsed?.reply, prNumber, link }),
    }).catch((err) => log.warn('homeroom-bot', 'Checks revision post failed', { app: app.slug, issueNumber, err: err.message }));
    log.info('homeroom-bot', 'Revised its proposal to fix its failing checks', {
      app: app.slug, issueNumber, sessionId: session.id, head, failing: failing.length, costUsd, runId,
    });
    return { ran: true, verdict: 'revise', runId, acted: 'checks_revise' };
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
  });
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
 * What a live build came to, recorded on its run in the columns a shadow
 * build fills (#3509): before this it was only said on the issue, so an
 * export could not tell a build that failed from one found impossible, nor
 * say why a proposal had no spec. build_at and build_queued_at stay NULL:
 * those are the lane's, and a live build never went through it. A spec
 * that failed is noted beside a build that went ahead, as a shadow
 * build's is (#3396). Never throws.
 */
async function recordLiveBuild(pool, runId, built, model = null) {
  if (!runId || !built) return;
  const error = built.ok
    ? (built.specNote ? clip(built.specNote, MAX_ERROR_CHARS) : null)
    : clip([
      built.blocked ? `blocked: ${built.blocked}` : (built.error || 'unknown'),
      built.specNote,
    ].filter(Boolean).join('; '), MAX_ERROR_CHARS);
  await pool.query(
    `UPDATE homeroom_bot_runs
        SET build_ok = $2, build_error = $3,
            build_branch = COALESCE($4, build_branch), build_sha = COALESCE($5, build_sha),
            build_commits = COALESCE($6, build_commits), build_cost_usd = COALESCE($7, build_cost_usd),
            build_session_id = COALESCE(build_session_id, $8), build_spec_md = COALESCE($9, build_spec_md),
            build_model = COALESCE($10, build_model)
      WHERE id = $1`,
    [runId, !!built.ok, error, built.branchName || null, built.sha || null,
      Number.isFinite(built.commits) ? built.commits : null,
      Number.isFinite(built.costUsd) ? built.costUsd : null,
      built.sessionId || null, built.specMd || null, model || built.model || null],
  ).catch((err) => log.warn('homeroom-bot', 'Could not record the live build on its run', { runId, err: err.message }));
}

/**
 * What a live build came to, said on its issue: the proposal (and the spec
 * on it, where the group votes), the request found impossible, or the build
 * that did not become a proposal. Shared by the live path and the recovery
 * of a live build a restart interrupted (#3471). Returns what was done.
 */
async function announceBuilt({ pool, ws, app, bot, issueNumber, runId, built, say, domain }) {
  await recordLiveBuild(pool, runId, built, built.model || null);
  if (built.ok) {
    await pool.query(
      'UPDATE homeroom_bot_runs SET proposal_session_id = $2 WHERE id = $1',
      [runId, built.sessionId],
    ).catch(() => {});
    // The vote-card metadata the promote route's own activity rows carry,
    // so the issue's thread shows the live proposal card, not only a link.
    const link = live.proposalLink(domain, app.slug, built.sessionId);
    await say('proposal', live.proposalText({ link, prNumber: built.prNumber }), {
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
    await say('blocked', live.blockedText(built.blocked), { dm: { reason: built.blocked } });
    return 'blocked';
  }
  log.warn('homeroom-bot', 'Live build did not become a proposal', {
    app: app.slug, issueNumber, sessionId: built.sessionId || null, error: built.error,
  });
  await say('build_failed', live.buildFailedText(built.error), { dm: { reason: built.error } });
  return 'build_failed';
}

async function actOnVerdict({
  pool, config, bot, app, repo, issueNumber, issue, parsed, capSuppressed, runId,
  seed, seedReadAt, postedAt, turnBudgetMs, model, specModel = null, botLogin = null, quietHold = false,
  proposalCeiling = PROPOSALS_PER_APP_CAP, firstVersion = false, deps,
}) {
  const { github, ws } = deps;
  const say = liveSayer({
    pool, github, ws, app, repo, issueNumber, issue, runId, bot, botLogin,
    notifications: deps.notifications || null, postedAt,
  });
  let acted = capSuppressed ? 'held' : parsed.verdict;
  if (capSuppressed) {
    const kind = live.heldKind(capSuppressed);
    const already = await live.lastPostKind(pool, app.id, issueNumber) === kind;
    log.info('homeroom-bot', 'Live verdict held by a cap', {
      app: app.slug, issueNumber, verdict: parsed.verdict, cap: capSuppressed, noted: !already && !quietHold,
    });
    if (!already && !quietHold) {
      const limit = capSuppressed === 'proposals_per_app' ? PROPOSALS_PER_APP_CAP
        : capSuppressed === 'proposals_total' ? proposalCeiling : QUESTION_TRIPWIRE_PER_DAY;
      // A build a proposal cap holds is said in the requester's DM too, so
      // waiting is never a mystery (homeroom-bot-dm.js dmText). A question
      // the daily tripwire holds is not: there is nothing to tell them yet.
      const toDm = capSuppressed === 'proposals_per_app' || capSuppressed === 'proposals_total';
      await say(kind, live.heldText({ cap: capSuppressed, verdict: parsed.verdict, limit }), toDm ? { dm: { limit } } : undefined);
    }
  } else if (parsed.verdict === 'question') {
    // #3624: `dm` carries the question to the requester's DM too, with the
    // answers they can tap (homeroom-bot-dm.js).
    await say('question', live.questionText(parsed), {
      dm: { question: parsed.question, answers: parsed.questionAnswers || [] },
    });
  } else if (parsed.verdict === 'person') {
    await say('person', live.personText(parsed), { dm: { reason: parsed.reason } });
  } else if (parsed.verdict === 'empty') {
    await say('empty', live.emptyText(parsed), { dm: { reason: parsed.reason } });
  } else if (parsed.verdict === 'ready') {
    // Built after this turn, in a slot of its own (buildLive, started by
    // the lane), not inside it: the build held the project's one slot for
    // the whole of its run (up to 50 minutes, 110 on the platform's own
    // repository), and every other request on the project waited unread
    // behind it, with nothing said. Recorded on the run, so a restart
    // between the verdict and the build loses nothing.
    await queueLiveBuild(pool, { runId, appId: app.id });
    acted = 'build_queued';
  }
  await live.advanceSeen({
    pool, github, threadContext: deps.threadContext, app, repo, issueNumber, runId,
    since: seedReadAt, postedAt,
  }).catch((err) => log.warn('homeroom-bot', 'Could not record what the bot has seen', { err: err.message }));
  return acted;
}

/**
 * A live 'ready' verdict's build, waiting its turn: one build per project at
 * a time, started by the lane (dispatch) as soon as its project has none
 * running. Never throws.
 */
async function queueLiveBuild(pool, { runId, appId }) {
  try {
    await pool.query(
      `UPDATE homeroom_bot_runs SET live_build_waiting_at = NOW()
        WHERE id = $1 AND build_ok IS NULL AND build_session_id IS NULL`,
      [runId],
    );
  } catch (err) {
    log.warn('homeroom-bot', 'Could not queue a live build', { runId, err: err.message });
  }
  wake({ appId });
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
  seed, seedReadAt, postedAt = [], turnBudgetMs, model, specModel = null, botLogin = null,
  proposalCeiling = PROPOSALS_PER_APP_CAP, firstVersion = false, presetSpec = null, carriedCostUsd = 0, deps,
}) {
  const { github, ws } = deps;
  const say = liveSayer({
    pool, github, ws, app, repo, issueNumber, issue, runId, bot, botLogin,
    notifications: deps.notifications || null, postedAt,
  });
  // The spec is posted on the issue the moment it is written, and the
  // build goes straight on: it is there for reference, not for approval.
  const onSpec = async ({ sessionId, version, specMd }) => {
    if (version) await live.shareSpecVersion(pool, sessionId, version);
    await say('spec', live.specCommentText(specMd), {
      threadMessage: version ? live.specCard({ sessionId, version, spec: specMd, bot }) : null,
      dm: { building: true },
    });
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
  // Under way in this process: the sweep for live builds nothing finished
  // (settleAbandonedLiveBuilds) leaves it alone whatever its age.
  liveBuildsInFlight.add(runId);
  let built;
  try {
    await recordBuildSnapshot(pool, {
      runId, app, repo, issueNumber, seed, buildNote: parsed.buildNote, github,
      firstVersion, platformRepo: isPlatformRepo(app, config), model, specModel,
    });
    built = await live.buildAndPropose({
      pool, config, bot, app, repo, issueNumber, issue, seed, buildNote: parsed.buildNote,
      ...buildBudgets(app, config, turnBudgetMs, { firstVersion }), model, specModel, deps, onSpec, proposalCeiling,
      platformRepo: isPlatformRepo(app, config), presetSpec,
      // #3737: a first version's spec and build decide and record its look.
      firstVersion,
      // WP1 (#2): asked once the plan is written and again just before it is
      // proposed (whyNotBuild).
      skipCheck: () => whyNotBuild(pool, { runId, botId: bot.id, appId: app.id, issueNumber, github, repo }),
      // Linked before any turn runs, so a restart mid-build can find the run
      // (#3471): the build's worker outlives the restart; this process does
      // not. From here restart recovery owns it, so it is no longer waiting.
      onSession: (session) => pool.query(
        'UPDATE homeroom_bot_runs SET build_session_id = $2, live_build_waiting_at = NULL WHERE id = $1', [runId, session.id],
      ),
    });
  } finally {
    liveBuildsInFlight.delete(runId);
  }
  if (built) built.model = model;
  if (built.specMd) {
    await pool.query('UPDATE homeroom_bot_runs SET build_spec_md = $2 WHERE id = $1', [runId, built.specMd])
      .catch(() => {});
  }
  if (built.costUsd > 0) {
    try {
      if (await deps.managedOpenRouter.usesIncludedKey(pool, bot.id)) {
        await deps.limits.recordSpend(pool, bot.id, Math.round(built.costUsd * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('homeroom-bot', 'Build spend debit failed', { err: err.message });
    }
  }
  // A build from a kept plan records what the plan cost beside its own. The
  // plan was debited when recovery finished it (debitRecovered), so it is
  // added only after this build's own debit.
  if (carriedCostUsd > 0) built.costUsd = (Number(built.costUsd) || 0) + carriedCostUsd;
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
    acted = await announceBuilt({ pool, ws, app, bot, issueNumber, runId, built, say, domain: deps.domain });
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
// LIVE work is an issue on an app the bot acts on for real, or on a project
// it is building for somebody (live.isLiveFor). It is started one issue at a
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
// BACKGROUND work is shadow triage of every other app: the calibration
// sweep. It keeps its old shape, a batch of one app's issues at a time,
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

/**
 * The live queue's heads, in priority order, with who each one is for.
 * Nothing on an app in `excludeAppIds` (backed off); on an app in
 * `busyAppIds` (its session taken), only follow-ups. A follow-up (#3703),
 * a row whose issue has the bot's own proposal still up for a vote, comes
 * right after the priority-0 rows: somebody is usually waiting on the bot in
 * that proposal's discussion, and it is one turn on the proposal's own
 * session.
 */
async function liveCandidates(pool, {
  scope: given = null, liveSlugs = [], excludeAppIds, pausedApps, busyAppIds = [], botId = null, limit = 200, excludeFollowUps = [],
}) {
  // A scope from live.liveScope; a bare list of slugs reads as the list audience.
  const scope = given || { all: false, slugs: liveSlugs, except: [] };
  if (live.scopeIsEmpty(scope)) return [];
  const { rows } = await pool.query(
    `SELECT q.id, q.app_id, q.issue_number, q.priority, q.reason, q.thread_seen_at, q.requested_by,
            q.payer_user_id,
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
      ORDER BY (q.priority = 0) DESC, (fu.id IS NOT NULL) DESC, q.priority, q.enqueued_at
      LIMIT $4`,
    [scope.slugs, excludeAppIds, pausedApps, limit, busyAppIds, botId, excludeFollowUps, ABANDONED_LIVE_WINDOW_DAYS,
      scope.all, scope.except],
  );
  return rows;
}

// ── Live builds, one per project (buildLive) ────────────────────────────
//
// A live 'ready' verdict is built after the turn that read it, in a slot of
// its own: `build:<appId>`. The project's read slot is free again the moment
// the verdict is recorded, so its next request is read (and asked about, or
// left for a person, or queued to build) while the build runs. Builds on one
// project still run one after another: two at once would race on the same
// files, and a request often builds on the one before it. Each waits on its
// run (live_build_waiting_at), so a restart loses none of them.

/**
 * The live builds waiting their turn, oldest first, with who each is for,
 * on projects the bot acts on and has not paused. A run a newer verdict on
 * the same issue replaced waits for nothing.
 */
async function liveBuildCandidates(pool, { scope: given = null, liveSlugs = [], pausedApps = [], limit = 50 }) {
  // As liveCandidates: a scope, or a bare list of slugs.
  const scope = given || { all: false, slugs: liveSlugs, except: [] };
  if (live.scopeIsEmpty(scope)) return [];
  const { rows } = await pool.query(
    `SELECT r.id, r.app_id, r.issue_number, r.build_note, r.live_build_waiting_at, r.created_at,
            r.build_spec_md, r.build_cost_usd, r.charged, r.payer_user_id,
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
      ORDER BY r.live_build_waiting_at, r.id
      LIMIT $3`,
    [scope.slugs, pausedApps, limit, scope.all, scope.except],
  );
  return rows;
}

/**
 * Pure: which waiting builds to start now. One per project, none on a
 * project already building (`buildingAppIds`), at most `perPerson` live
 * pieces of work for any one person counting what runs (`active`), and at
 * most `slots` in all.
 */
function pickLiveBuilds(candidates, { buildingAppIds = [], active = [], slots = 0, perPerson = 1 } = {}) {
  const building = new Set(buildingAppIds.map(Number));
  const count = new Map();
  for (const a of active) count.set(a.person, (count.get(a.person) || 0) + 1);
  const picks = [];
  for (const row of candidates || []) {
    if (picks.length >= slots) break;
    const appId = Number(row.app_id);
    if (building.has(appId)) continue;
    const person = personKeyOf(row);
    if ((count.get(person) || 0) >= perPerson) continue;
    building.add(appId);
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

// What a build whose request was closed while it was built records.
const CLOSED_WHILE_BUILDING = 'skipped: the request was closed before it was proposed';

/**
 * WP1 (#2): why a live build under way should stop where it is, or null to
 * go on. buildOne asks before a build starts; this is asked once its plan is
 * written and again just before it is proposed (buildAndPropose's
 * `skipCheck`), and before restart recovery proposes one. A reason is a
 * skip: the run already stopped (noteRequestMerged), a proposal of the
 * bot's for the request (up for a vote, merging, or merged since this
 * verdict), or the request's issue closed. Both of Plant Pal's duplicate
 * proposals went up after their issue had closed. What cannot be read never
 * stops a build: this is the backstop, not the guard.
 */
async function whyNotBuild(pool, { runId, botId, appId, issueNumber, github = null, repo = null }) {
  try {
    const { rows: [run] = [] } = await pool.query(
      'SELECT created_at, build_ok, build_error FROM homeroom_bot_runs WHERE id = $1', [runId],
    );
    if (run?.build_ok === false && /^skipped:/.test(String(run.build_error || ''))) return String(run.build_error);
    const proposed = await requestProposal(pool, { appId, botId, issueNumber, since: run?.created_at || null });
    if (proposed) return hasProposalSkip(proposed.id);
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
  const github = deps.github || require('./github');
  const sessions = deps.sessions || require('../routes/sessions');
  const threadContext = deps.threadContext || require('./thread-context');
  const buildDeps = {
    github,
    worker: deps.worker || require('./worker'),
    agentTurn: deps.agentTurn || require('./agent-turn'),
    limits: deps.limits || require('./limits'),
    threadContext,
    managedOpenRouter: deps.managedOpenRouter || require('./openrouter-managed-keys'),
    sessions,
    activeWorkers: deps.activeWorkers || require('./active-workers').activeWorkers,
    ...(deps.notifications ? { notifications: deps.notifications } : {}),
    ...liveDeps(deps),
  };
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
  // keeps waiting, and the next pass looks again.
  let proposed;
  try {
    proposed = await requestProposal(pool, { appId: app.id, botId: bot.id, issueNumber, since: run.created_at || null });
  } catch (err) {
    log.warn('homeroom-bot', 'Could not look for the request\'s proposal before its build', { app: app.slug, issueNumber, err: err.message });
    return { ran: false, reason: 'infra', detail: 'proposal_unreadable' };
  }
  if (proposed) {
    await pool.query(
      `UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = $2
        WHERE id = $1 AND build_ok IS NULL`,
      [run.id, hasProposalSkip(proposed.id)],
    ).catch(() => {});
    log.info('homeroom-bot', 'Live build skipped: its request already has a proposal', {
      app: app.slug, issueNumber, runId: run.id, sessionId: Number(proposed.id),
    });
    return { ran: false, reason: 'has_proposal' };
  }
  const dm = deps.dm || require('./homeroom-bot-dm');
  const requester = await dm.requesterOf(pool, app.id, issueNumber).catch(() => null);
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
    proposalCeiling: botProposalCeiling(settings), firstVersion: !!requester?.firstVersion, deps: buildDeps,
    // The plan of a build a restart interrupted, kept by recovery
    // (resumeLiveBuildFromSpec), and what writing it cost.
    presetSpec: run.build_spec_md || null,
    carriedCostUsd: run.build_spec_md ? Number(run.build_cost_usd) || 0 : 0,
  };
  log.info('homeroom-bot', 'Live build started', {
    app: app.slug, issueNumber, runId: run.id, ...(run.build_spec_md ? { fromKeptPlan: true } : {}),
  });
  try {
    const acted = await buildLive(args);
    return { ran: true, verdict: 'ready', runId: Number(run.id), acted };
  } catch (err) {
    log.error('homeroom-bot', 'Live build threw', { app: app.slug, issueNumber, runId: run.id, err: err.message });
    const say = liveSayer({
      pool, github, ws: buildDeps.ws, app, repo, issueNumber, issue, runId: Number(run.id), bot, botLogin,
      notifications: deps.notifications || null,
    });
    await announceBuilt({
      pool, ws: buildDeps.ws, app, bot, issueNumber, runId: Number(run.id), say, domain: buildDeps.domain,
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
    const out = { skipped: 0, stopped: 0, withdrawn: 0, dequeued: 0 };
    // Recorded before anything is stopped: whatever the stopped turn comes
    // to then reads as this skip, never as a failure.
    const { rows: settled } = await pool.query(
      `UPDATE homeroom_bot_runs r
          SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = $3
        WHERE r.app_id = $1 AND r.issue_number = ANY($2::int[])
          AND r.mode = 'live' AND r.verdict = 'ready' AND r.build_ok IS NULL AND r.proposal_session_id IS NULL
          AND r.build_session_id IS DISTINCT FROM $4
          AND ((r.live_build_waiting_at IS NOT NULL AND r.build_session_id IS NULL)
               OR EXISTS (SELECT 1 FROM chat_sessions bs
                           WHERE bs.id = r.build_session_id AND bs.status IN ('active', 'paused')))
        RETURNING r.id, r.build_session_id`,
      [appId, issues, why, Number(merged.id)],
    );
    const worker = deps.worker || require('./worker');
    for (const run of settled) {
      if (!run.build_session_id) { out.skipped += 1; continue; }
      out.stopped += 1;
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
        ORDER BY id`,
      [appId, merged.user_id, issues, Number(merged.id)],
    );
    const sessionLifecycle = deps.sessionLifecycle || require('./session-lifecycle');
    for (const other of others) {
      try {
        const done = await sessionLifecycle.archiveSession({ pool, sessionId: Number(other.id), reason: 'superseded' });
        if (done?.archived) out.withdrawn += 1;
      } catch (err) {
        log.warn('homeroom-bot', 'Could not withdraw a duplicate proposal', { sessionId: other.id, err: err.message });
      }
    }
    const { rowCount } = await pool.query(
      `DELETE FROM homeroom_bot_queue
        WHERE app_id = $1 AND issue_number = ANY($2::int[]) AND priority > 0 AND started_at IS NULL`,
      [appId, issues],
    );
    out.dequeued = rowCount || 0;
    if (out.skipped || out.stopped || out.withdrawn || out.dequeued) {
      log.info('homeroom-bot', 'A request\'s proposal merged; the rest of the bot\'s work on it stopped', {
        sessionId: Number(merged.id), appId, issues, ...out,
      });
      wake({ appId });
    }
    return out;
  } catch (err) {
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
 * switched off). Returns { processed, refusals, budgets, paused, detail,
 * retryInMs, stop }.
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

/**
 * Fill the free slots, live first. Returns the promises of the work it
 * started (each resolves to its outcome). `seen` keeps one drain from
 * starting the same row twice.
 */
async function dispatch(pool, config, { settings, bot, backedOff = [], deps = {}, seen = new Set(), now = Date.now() }) {
  if (stopped || settings.mode === 'off') return [];
  if (faultBackoff(now) || budgetPausedUntil > Date.now()) return [];
  const started = [];
  // A staging copy never acts (live.liveScope), so there every app is the
  // background lane's.
  const scope = live.liveScope(settings);
  const liveAtOnce = settings.liveAtOnce || DEFAULTS.liveAtOnce;
  const perPerson = settings.perPerson || DEFAULTS.perPerson;

  // Live builds waiting their turn first: they are further along than
  // anything still to be read. One per project, in a slot of its own, so
  // the project's read slot stays free (buildLive).
  const buildSlots = Math.max(0, liveAtOnce - [...inFlight.values()].filter((e) => e.lane === 'live').length);
  if (buildSlots && !live.scopeIsEmpty(scope)) {
    const running = [...inFlight.values()];
    const waiting = (await liveBuildCandidates(pool, { scope, pausedApps: settings.pausedApps || [] }))
      .filter((row) => !seen.has(`build:${Number(row.id)}`) && !liveBuildsInFlight.has(Number(row.id)));
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
        started.push(track(pool, `build:${Number(app.id)}`, {
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
      pausedApps: settings.pausedApps || [], excludeFollowUps: followUpsBackedOff(now),
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

  // Background: a batch of one app's issues per start, as before.
  const shadowActive = [...inFlight.values()].filter((e) => e.lane === 'background').length;
  for (let i = shadowActive; i < (settings.concurrency || DEFAULTS.concurrency); i += 1) {
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
 * What the bot is working on now, for the dashboard and for a person asking
 * in a DM: every claimed queue row, with its app and who it is for. Read
 * from the database, so any Pod can answer, not only the one running it.
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
    person: row.person || null,
  }));
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
  let client;
  let locked = false;
  try {
    client = await pool.connect();
    const lock = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired', [HOMEROOM_BOT_LOCK, 0],
    );
    if (lock.rows[0]?.acquired !== true) { out.busy = true; return out; }
    locked = true;

    const settings = await readSettings(pool);
    out.mode = settings.mode;
    if (settings.mode === 'off') return out;

    // Before anything is picked: a row an unfinished pass claimed is free again.
    out.releasedClaims = await releaseStaleClaims(pool, settings, {
      keepIds: [...inFlight.values()].map((e) => e.itemId),
    });

    const now = deps.now ? deps.now() : Date.now();
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
    if (forceAll || now - lastRefreshAt >= REFRESH_INTERVAL_MS) {
      // #3624: a project waiting for its first version whose creation hook
      // missed it is filed here, before the refresh that queues it. With the
      // `everyone` audience there is no list to be empty.
      if (settings.dmUsers?.length || settings.audience === 'everyone') {
        try {
          const filed = await (deps.dm || require('./homeroom-bot-dm')).sweepFirstVersions(pool, config, deps);
          if (filed) log.info('homeroom-bot', 'First versions filed', { filed });
        } catch (err) {
          log.warn('homeroom-bot', 'First-version sweep failed', { err: err.message });
        }
      }
      const summary = await refreshQueue(pool, settings, { ...deps, bot });
      lastRefreshAt = now;
      out.refreshed = true;
      if (summary.queued) log.info('homeroom-bot', 'Queue refreshed', summary);
    } else if (targeted.length) {
      const summary = await refreshApps(pool, settings, targeted, { ...deps, bot });
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
      const settledLive = await settleAbandonedLiveBuilds(pool, settings, deps);
      if (settledLive) out.liveBuildsSettled = settledLive;
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

    // An app inside its backoff window is skipped exactly like a paused one
    // (#2737). Without this, a session that refuses every turn is retried on
    // every wake, which is how one wedged app wrote 121 rows in a day.
    const backedOff = [];
    for (const [appId] of appBackoff) {
      if (backoffFor(appId, now)) backedOff.push(Number(appId));
      else appBackoff.delete(appId);
    }
    out.backedOffApps = backedOff.length;
    // The weekly cap ran out under a piece of work: wait for the idle pass.
    if (budgetPausedUntil > Date.now()) {
      out.paused = 'budget';
      out.inFlight = inFlight.size;
      return out;
    }
    // #3624 stage 2: fill the free slots and, unless a test asks to drain,
    // return without waiting for the work (see "How much at once").
    const drain = deps.drain !== false;
    const seen = new Set();
    let started = await dispatch(pool, config, { settings, bot, backedOff, deps, seen, out, now });
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
    lastPass = { at: new Date().toISOString(), ...out };
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
}

/**
 * Stops both loops. A build already under way runs to its own time limit
 * and records itself; nothing new starts.
 */
function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
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
  wake({ appId: id });
  publishWake({ appId: id, issueNumber: n, reason: String(reason).slice(0, 40) });
  return true;
}

/**
 * #3264: somebody wrote in a proposal's discussion. When that proposal is
 * the bot's own and still up for a vote, it is activity on the issue it
 * answers; any other proposal's thread is none of the bot's business and
 * costs one indexed lookup. Never throws.
 */
async function noteProposalActivity(pool, { appId, sessionId } = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT cs.linked_issues FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
        WHERE cs.id = $1 AND cs.app_id = $2 AND cs.status = 'promoted' AND u.username = $3`,
      [Number(sessionId), Number(appId), BOT_USERNAME],
    );
    const issueNumber = Array.isArray(rows[0]?.linked_issues) ? rows[0].linked_issues[0] : null;
    if (!issueNumber) return false;
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
  return wake({ appId: data.appId, all: !!data.all });
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
            r.input_tokens, r.output_tokens, r.duration_ms, r.error, r.created_at,
            r.proposal_session_id,
            r.build_ok, r.build_branch, r.build_sha, r.build_commits, r.build_error,
            r.build_cost_usd::float8 AS build_cost_usd, r.build_at, r.build_queued_at, r.build_spec_md,
            r.build_session_id,
            r.question_answers, dm.dm_sent_at, dm.dm_answered_at, r.checks_head_sha,
            r.label_verdict, r.build_model,
            a.slug AS app_slug, a.name AS app_name, a.repo_url, u.username AS rated_by
       FROM homeroom_bot_runs r
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN users u ON u.id = r.rating_by
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

async function adminPayload(pool, config, {
  app = null, verdict = null, before = null, limit = RUNS_PAGE, budgetOnly = false,
} = {}) {
  const settings = await readSettings(pool);
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

  const { rows: queueRows } = await pool.query(
    `SELECT q.id, q.issue_number, q.priority, q.reason, q.enqueued_at, q.started_at,
            a.slug AS app_slug, a.name AS app_name
       FROM homeroom_bot_queue q JOIN apps a ON a.id = q.app_id
      ORDER BY q.started_at DESC NULLS LAST, q.priority, q.enqueued_at
      LIMIT 12`,
  );
  const { rows: depthRows } = await pool.query(
    'SELECT COUNT(*)::int AS depth FROM homeroom_bot_queue WHERE started_at IS NULL',
  );

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
    // A refusal shows while its app is still backed off (#3624 stage 2:
    // work ends between passes now, so the list is pruned here).
    loop: lastPass ? {
      ...lastPass,
      refusals: lastRefusals.filter((r) => !r.appId || backoffFor(r.appId))
        .map((r) => (r.appId && backoffFor(r.appId) ? { ...r, retryInMs: Math.max(0, appBackoff.get(r.appId).until - Date.now()) } : r)),
    } : lastPass,
    totals,
    queue: { depth: depthRows[0]?.depth || 0, items: queueRows },
    runs: runRows.map((r) => ({
      ...r, issueUrl: issueUrlFor(r), buildUrl: buildUrlFor(r), replayStages: replayable[r.id] || [],
    })),
    apps: appRows,
    caps: {
      proposalsPerApp: PROPOSALS_PER_APP_CAP,
      proposalsTotal: botProposalCeiling(settings),
      questionsPerAppPerDay: QUESTION_TRIPWIRE_PER_DAY,
    },
    builds: await buildLaneSummary(pool),
    mentionOptOuts: await mentionOptOutList(pool),
    dmUsers: await dmUserList(pool, settings),
    // #3624: the projects it acts on for real because somebody on that list
    // made them, and who, shown in the live list beside the stored ones.
    builtFor: await builtForList(pool, settings),
    // #3624 stage 2: what runs now, and what the DM's answers cost.
    workingNow: await workingNow(pool, settings),
    dmChat: await dmChatSummary(pool),
  };
}

/** #3624: projectsMadeFor, as the dashboard lists them. */
async function builtForList(pool, settings) {
  try {
    const rows = await require('./homeroom-bot-dm').projectsMadeFor(pool, settings);
    const seen = new Set();
    return rows.filter((r) => !seen.has(r.slug) && seen.add(r.slug))
      .map((r) => ({ slug: r.slug, name: r.name || r.slug, username: r.username, origin: r.origin }));
  } catch (err) {
    log.warn('homeroom-bot', 'Built-for list failed', { err: err.message });
    return [];
  }
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

/**
 * #3624: the people on the DM list, as the dashboard shows them: whether
 * the name is an account at all, and what their requests cost the bot this
 * week against the per-person allowance.
 */
async function dmUserList(pool, settings) {
  const names = settings?.dmUsers || [];
  if (!names.length) return [];
  const dm = require('./homeroom-bot-dm');
  const { rows } = await pool.query(
    'SELECT id, username FROM users WHERE LOWER(username) = ANY($1::text[]) AND is_synthetic = FALSE',
    [names],
  );
  const byName = new Map(rows.map((r) => [r.username.toLowerCase(), r]));
  const out = [];
  for (const name of names) {
    const user = byName.get(name);
    let weeklySpentCents = null;
    if (user) {
      try { weeklySpentCents = await dm.weeklySpentCents(pool, user.id); } catch { weeklySpentCents = null; }
    }
    out.push({ username: user ? user.username : name, exists: !!user, weeklySpentCents });
  }
  return out;
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
 * Every issue whose latest verdict is a question, triaged again: how the
 * bar for asking is compared, old verdict against new, in the export. Shadow
 * apps only: on a live app the question was posted, and a new verdict would
 * act (build, or post again) on the strength of a comparison.
 */
const LATEST_VERDICTS_SQL = `SELECT DISTINCT ON (r.app_id, r.issue_number)
         r.app_id, r.issue_number, r.verdict, a.slug
    FROM homeroom_bot_runs r
    JOIN apps a ON a.id = r.app_id
   WHERE r.verdict IN ('question', 'ready', 'person', 'empty')
     AND a.status = 'running' AND a.repo_url IS NOT NULL
   ORDER BY r.app_id, r.issue_number, r.id DESC`;

async function retriageQuestions(pool, { actorId = null } = {}) {
  const settings = await readSettings(pool);
  const { rows } = await pool.query(LATEST_VERDICTS_SQL);
  const questions = rows.filter((r) => r.verdict === 'question');
  const picked = questions.filter((r) => !live.isLiveFor({ ...settings, mode: 'shadow' }, { slug: r.slug }));
  if (picked.length) {
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, requested_by)
       SELECT app_id, issue_number, 0, 'retriage', $3
         FROM UNNEST($1::int[], $2::int[]) AS q(app_id, issue_number)
       ON CONFLICT (app_id, issue_number) DO UPDATE
         SET priority = 0, reason = 'retriage', requested_by = EXCLUDED.requested_by,
             started_at = NULL, enqueued_at = NOW()`,
      [picked.map((r) => r.app_id), picked.map((r) => r.issue_number), actorId],
    );
  }
  log.info('homeroom-bot', 'Questions queued to be triaged again', {
    queued: picked.length, live: questions.length - picked.length,
  });
  return { ok: true, queued: picked.length, live: questions.length - picked.length };
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
 * right now is left alone. Live apps only (the list, or a project somebody
 * on the DM list made), and not while paused.
 */
async function retriageApp(pool, { slug, actorId = null, deps = {} } = {}) {
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,120}$/.test(slug)) {
    return { ok: false, status: 400, error: 'Invalid app slug' };
  }
  const settings = await readSettings(pool);
  // #3624: a project somebody on the DM list made is live too, and an
  // import's backlog waits for exactly this. Off, or on a staging copy,
  // nothing is (live.liveScope), but the queue still holds what it is told.
  if (!live.inScope(live.liveScope({ ...settings, mode: 'shadow' }), slug)) {
    return { ok: false, status: 409, error: 'The bot does not act on this app for real: add it to the live apps first' };
  }
  if ((settings.pausedApps || []).includes(slug)) {
    return { ok: false, status: 409, error: 'The app is paused for the bot' };
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
  setDmMember,
  MAX_DM_USERS,
  validateSettingsPatch,
  parseSettings,
  adminPayload,
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
  deciderNote,
  whoDecides,
  headShaOf,
  INFRA_ERRORS,
  isLiveLaneSaturated,
  retriageQuestions,
  mentionOptOutList,
  removeMentionOptOut,
  wake,
  wakeAll,
  backoffFor,
  noteRefusal,
  clearRefusals,
  clearStaleTurn,
  noteStopped,
  wasStoppedRecently,
  actOnVerdict,
  // Live builds in slots of their own, one per project.
  buildLive,
  buildOne,
  // WP1 (#2): a build re-checked before it is proposed, and a merge's net.
  requestProposal,
  whyNotBuild,
  hasProposalSkip,
  CLOSED_WHILE_BUILDING,
  noteRequestMerged,
  queueLiveBuild,
  liveBuildCandidates,
  pickLiveBuilds,
  holdLiveBuildDuringRecovery,
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
  queueShadowBackfill,
  buildLaneSummary,
  shadowBuildSkipReason,
  isPlatformRepo,
  buildBudgets,
  PLATFORM_BUILD_TIME_FACTOR,
  isRecoveredBotSession,
  settleReapedTurn,
  completeRecoveredLive,
  liveSayer,
  announceBuilt,
  RESTART_REASON,
  RESTARTED_BUILD_NOTE,
  APP_AGAIN_REASON,
  CHECKS_REASON,
  SELF_QUEUED_REASONS,
  NOT_FOLLOW_UP,
  noteProposalChecks,
  checksToFix,
  runChecksFix,
  settleAbandonedLiveBuilds,
  abandonedLiveAfterSeconds,
  ABANDONED_LIVE_ERROR,
  ABANDONED_LIVE_REASON,
  FIRST_VERSION_BUILD_TIME_FACTOR,
  recordLiveBuild,
  recoveryDeadline,
  finishRecoveredTurn,
  abandonRecoveredTurn,
  holdSlotDuringRecovery,
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
  BLOCKERS,
  capRoomFor,
  simulateCaps,
  parseVerdict,
  parseRepo,
  BOT_USERNAME,
  MODES,
  VERDICTS,
  KEY_MODE,
  KEY_CONCURRENCY,
  KEY_BATCH_SIZE,
  KEY_PAUSED_APPS,
  KEY_LIVE_APPS,
  KEY_LIVE_AT_ONCE,
  KEY_PER_PERSON,
  KEY_DM_CHAT,
  AUDIENCES,
  KEY_AUDIENCE,
  KEY_AUDIENCE_SINCE,
  KEY_LIVE_PLATFORM,
  KEY_PROPOSAL_CEILING,
  EVERYONE_PROPOSAL_CEILING,
  pickLive,
  personKeyOf,
  enqueueFront,
  billingOf,
  liveCandidates,
  workingNow,
  dmChatSummary,
  dispatch,
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
    liveBuildsInFlight.clear();
    if (timer) clearTimeout(timer);
    timer = null; loopConfig = null; pendingApps.clear(); refreshAllRequested = false; wakeRequested = false;
    pendingLive.clear();
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
  _armForTests(config) { stopped = false; loopConfig = config; passInFlight = false; timer = setTimeout(() => {}, 1e9); timer.unref(); },
  _setPassInFlightForTests(v) { passInFlight = !!v; },
  _inFlightForTests() { return [...inFlight.values()].map((e) => ({ ...e })); },
};
