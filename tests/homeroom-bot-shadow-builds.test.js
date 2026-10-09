// Shadow builds: where the bot is not live on an app, a ready verdict is
// also built on a branch of its own, and nothing else happens. No proposal,
// no post, nothing in the app: the dashboard and the export carry the
// branch, so what the bot would have proposed can be spot-checked. The bot
// is live on every app but a paused one (live.liveScope), so that is a
// staging copy, where nothing is live: this file runs as one
// (USERNODE_ENV=staging, set below) unless a test says otherwise.
//
// The builds run in a lane of their own, beside triage: a ready verdict only
// queues its build, and the lane drains the queue `buildConcurrency` at a
// time, shared between apps in turns. tests/homeroom-bot-build-lane-postgres.test.js runs the
// lane's SQL against the real schema; this file pins the rest with stubs.
//
// Run with: node --test tests/homeroom-bot-shadow-builds.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const APP = { id: 9, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo', self_hosted: false };
const PLATFORM = { id: 1, slug: 'usernode-2d5619', name: 'Homeroom', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding.git' };
const REPO = { owner: 'usernode-bot', repo: 'todo' };
const BOT = { id: 77, username: 'homeroom_bot' };
const ITEM = { id: 31, app_id: 9, issue_number: 12, priority: 1, reason: 'new', thread_seen_at: '2026-09-28T00:00:00Z' };
const READY = '```json\n{"verdict":"ready","determined":true,"missing_fact":"none","build_note":"Add an hourly refresh."}\n```';
const PERSON = '```json\n{"verdict":"person","determined":false,"missing_fact":"x","reason":"policy"}\n```';
const ON = { mode: 'shadow', pausedApps: [], shadowBuilds: true, buildConcurrency: 2, shadowBuildPlatform: false };

// A staging copy acts on nothing (live.liveScope), so every app there is the
// shadow lane's; outside one, every app but a paused one is live.
function setEnv(value) {
  if (value === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = value;
}
const ENV_BEFORE = process.env.USERNODE_ENV;
test.before(() => setEnv('staging'));
test.after(() => setEnv(ENV_BEFORE));

async function outsideStaging(fn) {
  const prev = process.env.USERNODE_ENV;
  setEnv(undefined);
  try { return await fn(); } finally { setEnv(prev); }
}

// ── The settings ─────────────────────────────────────────────────────────

test('shadow builds ship off; the lane runs two at once and leaves the platform out', () => {
  const s = bot.parseSettings([]);
  assert.equal(s.shadowBuilds, false, 'off unless someone turns it on');
  assert.equal(s.buildConcurrency, 2);
  assert.equal(s.shadowBuildPlatform, false);
  const on = bot.parseSettings([
    { key: bot.KEY_SHADOW_BUILDS, value: 'on' },
    { key: bot.KEY_BUILD_CONCURRENCY, value: '99' },
    { key: bot.KEY_SHADOW_BUILD_PLATFORM, value: 'on' },
  ]);
  assert.equal(on.shadowBuilds, true);
  assert.equal(on.buildConcurrency, bot.MAX_BUILD_CONCURRENCY, 'clamped');
  assert.equal(on.shadowBuildPlatform, true);
  assert.equal(bot.parseSettings([{ key: bot.KEY_SHADOW_BUILDS, value: 'yes' }]).shadowBuilds, false, 'only "on" is on');

  assert.deepEqual(bot.validateSettingsPatch({ shadowBuilds: true, buildConcurrency: 3, shadowBuildPlatform: false }).updates, [
    [bot.KEY_SHADOW_BUILDS, 'on'], [bot.KEY_BUILD_CONCURRENCY, '3'], [bot.KEY_SHADOW_BUILD_PLATFORM, 'off'],
  ]);
  for (const bad of [{ shadowBuilds: 'on' }, { shadowBuilds: 1 }, { buildConcurrency: 0 }, { buildConcurrency: 5 },
    { buildConcurrency: 1.5 }, { shadowBuildPlatform: 'true' }]) {
    assert.equal(bot.validateSettingsPatch(bad).ok, false, `refuses ${JSON.stringify(bad)}`);
  }
  const schema = read('src/db/schema.sql');
  assert.match(schema, /\('homeroom_bot_shadow_builds', 'off'\)/, 'seeded off');
  assert.match(schema, /\('homeroom_bot_build_concurrency', '2'\)/);
  assert.match(schema, /\('homeroom_bot_shadow_build_platform', 'off'\)/);
  assert.doesNotMatch(schema, /homeroom_bot_shadow_builds_per_day/, 'the daily count is gone: the weekly cap bounds the lane');
});

test('which apps are shadow built: not live, not paused, and not the platform unless included', async () => {
  const why = (settings, app, config = {}) => bot.shadowBuildSkipReason(settings, app, config);
  // A staging copy: nothing is live.
  assert.equal(why(ON, APP), null);
  assert.equal(why({ ...ON, shadowBuilds: false }, APP), 'shadow builds are off');
  assert.equal(why({ ...ON, pausedApps: ['todo'] }, APP), 'the app is paused');
  assert.equal(why(ON, PLATFORM), "the platform's own repository is left out");
  assert.equal(why({ ...ON, shadowBuildPlatform: true }, PLATFORM), null);
  await outsideStaging(() => {
    assert.equal(why(ON, APP), 'the app is live now', 'every app but a paused one is live');
    assert.equal(why({ ...ON, shadowBuildPlatform: true }, PLATFORM), 'the app is live now', "the platform's own included");
    assert.equal(why({ ...ON, pausedApps: ['todo'] }, APP), 'the app is paused');
    assert.equal(why({ ...ON, mode: 'off' }, APP), null, 'with the bot off nothing is live either');
  });
  assert.equal(bot.isPlatformRepo({ repo_url: 'https://github.com/usernode-labs/Social-Vibecoding' }), true, 'case-insensitive, as GitHub is');
  assert.equal(bot.isPlatformRepo(APP, { platformRepoUrl: 'https://github.com/usernode-bot/todo' }), true, 'config names it');
  assert.equal(bot.isPlatformRepo(APP), false);
});

// ── The build: the same one live runs, minus everything a person sees ────

function buildHarness(result = { pushOk: true, ahead: 2, sha: 'c'.repeat(40) }) {
  const calls = { queries: [], promoted: [] };
  const pool = {
    async query(sql, params) {
      calls.queries.push({ sql: String(sql), params });
      if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [{ id: 6001, app_id: APP.id, user_id: BOT.id }] };
      return { rows: [] };
    },
  };
  const router = express.Router();
  router.post('/api/sessions/:id/promote', (req, res) => { calls.promoted.push(req.params.id); res.json({ ok: true, prNumber: 9 }); });
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-6001'; },
      async execInWorker() { return result; },
      stopTurn() { return Promise.resolve(); },
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        const r = await args.dispatchOnce({});
        // The spec turn (tests/homeroom-bot-spec.test.js) writes nothing here.
        if (args.mode === 'scout') return { result: {}, error: null, estimatedCostUsd: null };
        return { result: r, error: null, estimatedCostUsd: 0.04 };
      },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `dev/homeroom_bot-s${sessionId}` }; } },
    activeWorkers: new Set(),
    votesRouter: router,
  };
  return { pool, deps, calls };
}

const BUILD_ARGS = {
  config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12,
  issue: { title: 'Refresh feeds every hour' }, seed: 'Please work on GitHub issue #12.',
  buildNote: 'Add an hourly refresh.', turnBudgetMs: 60_000, model: 'z-ai/glm-5.3-flash',
};

test('propose: false builds and pushes, then puts the session away: no proposal, no linked issue', async () => {
  const h = buildHarness();
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS, propose: false });
  assert.deepEqual(out, {
    ok: true, sessionId: 6001, branchName: 'dev/homeroom_bot-s6001', sha: 'c'.repeat(40), commits: 2, costUsd: 0.04,
    specNote: 'no spec (the spec turn returned nothing); the build worked from the plan',
    // The build's own cost on its model (services/stage-costs.js).
    stageCosts: { build: { usd: 0.04, model: 'z-ai/glm-5.3-flash' } },
  }, 'this harness writes no spec, and the result says so');
  assert.deepEqual(h.calls.promoted, [], 'never promoted');
  const insert = h.calls.queries.find((q) => /INSERT INTO chat_sessions/.test(q.sql));
  assert.equal(insert.params[2], null, 'no issue: no board reads it as work under way on #12');
  assert.match(insert.params[3], /^Homeroom bot shadow build: #12 /);
  const archived = h.calls.queries.find((q) => /SET status = 'archived'/.test(q.sql));
  assert.ok(archived, 'archived the moment the build ends');
  assert.deepEqual(archived.params, [6001, BOT.id]);
});

test('a shadow build that changes nothing is a failure with its branch named', async () => {
  const h = buildHarness({ pushOk: true, ahead: 0, sha: 'd'.repeat(40) });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS, propose: false });
  assert.equal(out.ok, false);
  assert.match(out.error, /no change/);
  assert.equal(out.branchName, 'dev/homeroom_bot-s6001');
  assert.deepEqual(h.calls.promoted, []);
});

// ── runTriage: a ready verdict QUEUES its build, and never waits on it ───

function triage({ settings = ON, verdictText = READY, app = APP } = {}) {
  const calls = { queries: [], builds: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT \* FROM chat_sessions/.test(s)) {
        return { rows: [{ id: 501, user_id: 77, app_id: app.id, branch_name: 'main', agent_backend: 'codex_openrouter' }] };
      }
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 900 }] };
      if (/SET build_queued_at = NOW\(\)/.test(s)) return { rows: [], rowCount: 1 };
      if (/COUNT\(\*\)::int AS cnt/.test(s)) return { rows: [{ cnt: 0 }] };
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 12, title: 'Refresh feeds', body: 'hourly', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'w'; },
      async execInWorker() { return { lastResultText: verdictText }; },
      isInFlight: () => false,
      async clearActiveTurn() {},
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return true; } },
    sessions: {
      buildHeadlessSeed: (n) => `ISSUE #${n}`,
      async runCodexAttemptLoop({ dispatchOnce }) {
        const r = await dispatchOnce({});
        return { result: r, error: null, estimatedCostUsd: 0.001 };
      },
    },
    activeWorkers: new Set(),
    sessionLifecycle: {},
  };
  return { pool, deps, calls, settings: { turnSeconds: 1200, turnInputTokens: 10_000_000, ...settings } };
}

async function runWith(t, h, app = APP) {
  const real = live.buildAndPropose;
  t.after(() => { live.buildAndPropose = real; });
  live.buildAndPropose = async (args) => { h.calls.builds.push(args); return { ok: true }; };
  return bot.runTriage(h.pool, {}, { bot: BOT, app, item: ITEM, mode: 'shadow', settings: h.settings, deps: h.deps });
}

const queuedFor = (h) => h.calls.queries.find((q) => /SET build_queued_at = NOW\(\)/.test(q.s));

test('a shadow ready verdict is queued for the lane, and triage moves straight on', async (t) => {
  const h = triage();
  const out = await runWith(t, h);
  assert.equal(out.verdict, 'ready');
  assert.equal(out.acted, 'shadow_queued');
  assert.equal(h.calls.builds.length, 0, 'nothing is built inside triage');
  assert.deepEqual(queuedFor(h).params, [900]);
  assert.match(queuedFor(h).s, /WHERE id = \$1 AND build_queued_at IS NULL AND build_ok IS NULL/, 'queued once, never rebuilt');
});

test('every verdict supersedes an older queued build of the same issue, ready or not', async (t) => {
  for (const verdictText of [READY, PERSON]) {
    const h = triage({ verdictText });
    await runWith(t, h);
    const sup = h.calls.queries.find((q) => /superseded: a later verdict/.test(q.s));
    assert.ok(sup, 'the lane builds what the bot thinks now');
    assert.deepEqual(sup.params, [APP.id, 12, 900]);
    assert.match(sup.s, /build_queued_at IS NOT NULL AND build_at IS NULL AND build_ok IS NULL/, 'never one under way or done');
  }
});

test('nothing is queued when it is off, not ready, the app is paused, or it is the platform', async (t) => {
  const cases = [
    ['off', triage({ settings: { ...ON, shadowBuilds: false } }), APP],
    ['not ready', triage({ verdictText: PERSON }), APP],
    ['paused', triage({ settings: { ...ON, pausedApps: ['todo'] } }), APP],
    ['the platform', triage({ app: PLATFORM }), PLATFORM],
  ];
  for (const [why, h, app] of cases) {
    const out = await runWith(t, h, app);
    assert.equal(queuedFor(h), undefined, `no build when ${why}`);
    assert.equal(out.acted, undefined, why);
  }
});

test('a run records what started its read: its queue reason, and for a change what moved', async (t) => {
  const h = triage();
  const query = h.pool.query;
  h.pool.query = async (sql, params) => {
    if (/UPDATE homeroom_bot_queue SET started_at = NOW\(\)/.test(String(sql))) {
      h.calls.queries.push({ s: String(sql), params });
      return { rows: [{ thread_seen_at: null, changed_by: 'github' }], rowCount: 1 };
    }
    return query(sql, params);
  };
  const real = live.buildAndPropose;
  t.after(() => { live.buildAndPropose = real; });
  live.buildAndPropose = async () => ({ ok: true });
  await bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item: { ...ITEM, reason: 'changed' }, mode: 'shadow', settings: h.settings, deps: h.deps });
  const insert = h.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.match(insert.s, /payer_user_id, read_reason\)/);
  assert.equal(insert.params[insert.params.length - 1], 'changed:github', 'the issue itself moved since the last read');
  assert.equal(bot.readReasonOf({ reason: 'changed', changed_by: 'discussion' }), 'changed:discussion');
  assert.equal(bot.readReasonOf({ reason: 'retry_failed', changed_by: 'github' }), 'retry_failed', 'only a change says what changed');
  assert.equal(bot.readReasonOf({ reason: 'changed' }), 'changed', 'a row queued before changed_by');
  assert.equal(bot.readReasonOf({}), null);
});

test('a ready verdict that is not built says why on its run; a verdict that is not ready says nothing', async (t) => {
  const skippedFor = (h) => h.calls.queries.find((q) => /UPDATE homeroom_bot_runs SET build_error = \$2/.test(q.s));
  const cases = [
    [triage({ settings: { ...ON, shadowBuilds: false } }), APP, 'skipped: shadow builds are off'],
    [triage({ settings: { ...ON, pausedApps: ['todo'] } }), APP, 'skipped: the app is paused'],
    [triage({ app: PLATFORM }), PLATFORM, "skipped: the platform's own repository is left out"],
  ];
  for (const [h, app, said] of cases) {
    await runWith(t, h, app);
    const skipped = skippedFor(h);
    assert.ok(skipped, said);
    assert.deepEqual(skipped.params, [900, said]);
    assert.match(skipped.s, /WHERE id = \$1 AND build_ok IS NULL AND build_queued_at IS NULL/, 'never over a build that happened');
  }
  const queued = triage();
  await runWith(t, queued);
  assert.equal(skippedFor(queued), undefined, 'a queued build has nothing to explain');
  const person = triage({ verdictText: PERSON });
  await runWith(t, person);
  assert.equal(skippedFor(person), undefined, 'only a ready verdict is a build that did not happen');
});

// ── One queued build ─────────────────────────────────────────────────────

function lane({ issueState = 'open', built = null, app = APP, settings = ON, firstVersion = false } = {}) {
  const calls = { queries: [], builds: [], spend: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/FROM apps WHERE id = \$1/.test(s)) return { rows: app ? [app] : [] };
      if (/SELECT first_version FROM homeroom_bot_requesters/.test(s)) return { rows: firstVersion ? [{ first_version: true }] : [] };
      return { rows: [], rowCount: 1 };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 12, title: 'Refresh feeds', body: 'hourly', state: issueState } }; },
      async fetchIssueComments() { return { comments: [{ body: 'every hour please' }] }; },
    },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend(_p, _id, cents) { calls.spend.push(cents); } },
    threadContext: { async loadIssueThread() { return { messages: [{ content: 'and on mobile' }] }; } },
    managedOpenRouter: { async usesIncludedKey() { return true; } },
    sessions: { buildHeadlessSeed: (n, _issue, comments, _u, thread) => `ISSUE #${n} ${comments.length}c ${thread.length}t` },
    worker: {}, agentTurn: {}, activeWorkers: new Set(), sessionLifecycle: {},
  };
  const outcome = built || { ok: true, sessionId: 6001, branchName: 'dev/homeroom_bot-s6001', sha: 'c'.repeat(40), commits: 2, costUsd: 0.04 };
  return { pool, deps, calls, settings: { turnSeconds: 1200, ...settings }, outcome };
}

async function buildWith(t, h, claim = { id: 900, app_id: APP.id, issue_number: 12, build_note: 'Add an hourly refresh.' }) {
  const real = live.buildAndPropose;
  t.after(() => { live.buildAndPropose = real; });
  live.buildAndPropose = async (args) => { h.calls.builds.push(args); return h.outcome; };
  return bot.runQueuedBuild(h.pool, {}, { bot: BOT, claim, settings: h.settings, deps: h.deps });
}

const recorded = (h) => h.calls.queries.find((q) => /SET build_ok = \$2/.test(q.s));

test('a claimed build reads the thread as it is now, builds without proposing, and records its branch', async (t) => {
  bot._resetForTests();
  const h = lane();
  const out = await buildWith(t, h);
  assert.equal(out, 'shadow_built');
  assert.equal(h.calls.builds.length, 1);
  const args = h.calls.builds[0];
  assert.equal(args.propose, false, 'never proposed');
  assert.equal(args.buildNote, 'Add an hourly refresh.', 'from the verdict\'s own plan');
  assert.equal(args.seed, 'ISSUE #12 1c 1t', 'the issue, its comments and its thread, read at build time');
  assert.deepEqual(args.repo, REPO);
  assert.equal(args.turnBudgetMs, 1_200_000, 'the same wall clock a triage turn has');
  // #3654: the model the build ran on (no default in this config), then a
  // build turn that changed nothing (none here).
  assert.deepEqual(recorded(h).params, [900, true, 'dev/homeroom_bot-s6001', 'c'.repeat(40), 2, null, 0.04, 6001, null, null, null]);
  // Its lane, for the count of turns that change nothing, and where that is
  // kept the moment one does (homeroom-bot-live.js buildNudgePrompt).
  assert.deepEqual(args.origin, { lane: 'shadow', runId: 900 });
  assert.equal(typeof args.onNoChange, 'function');
  assert.deepEqual(h.calls.spend, [4], 'paid from the weekly allowance');
});

test('a first version\'s shadow build gets its doubled clock and builds as one, as the live lane does (#1080)', async (t) => {
  // turnly #1 (2026-10-05), a first version, was cut at 20 minutes of 40.
  bot._resetForTests();
  const h = lane({ firstVersion: true });
  assert.equal(await buildWith(t, h), 'shadow_built');
  const args = h.calls.builds[0];
  assert.equal(args.turnBudgetMs, 2_400_000, 'FIRST_VERSION_BUILD_TIME_FACTOR times the turn clock');
  assert.equal(args.firstVersion, true, 'its spec and build decide its look');
  const asked = h.calls.queries.find((q) => /SELECT first_version FROM homeroom_bot_requesters/.test(q.s));
  assert.deepEqual(asked.params, [APP.id, 12]);
});

test('a failed build is recorded with its reason; the lane carries on', async (t) => {
  bot._resetForTests();
  const h = lane({ built: { ok: false, sessionId: 6001, branchName: 'dev/x', error: 'the build produced no change to propose', costUsd: 0.01 } });
  assert.equal(await buildWith(t, h), 'shadow_failed');
  const u = recorded(h).params;
  assert.equal(u[1], false);
  assert.equal(u[5], 'the build produced no change to propose');
});

test('a closed issue, a live app or a gone app is skipped, not built, and says why', async (t) => {
  const cases = [
    ['the issue is no longer open', lane({ issueState: 'closed' })],
    // Outside a staging copy every app but a paused one is live.
    ['the app is live now', lane(), true],
    ['the app is gone', lane({ app: null })],
  ];
  for (const [why, h, isLive] of cases) {
    bot._resetForTests();
    const out = isLive ? await outsideStaging(() => buildWith(t, h)) : await buildWith(t, h);
    assert.equal(out, `skipped: ${why}`);
    assert.equal(h.calls.builds.length, 0, why);
    const skip = h.calls.queries.find((q) => /SET build_queued_at = NULL, build_at = NULL, build_error = \$2/.test(q.s));
    assert.deepEqual(skip.params, [900, `skipped: ${why}`]);
  }
});

test('a platform fault hands the claim back and backs the lane off, instead of failing the build', async (t) => {
  bot._resetForTests();
  assert.equal(bot.isInfraBuildError('the worker would not start: quota'), true);
  assert.equal(bot.isInfraBuildError('the build turn failed (credential_required)'), true);
  assert.equal(bot.isInfraBuildError('the build turn failed (dispatch: socket hang up)'), true);
  assert.equal(bot.isInfraBuildError('the build produced no change to propose'), false);
  assert.equal(bot.isInfraBuildError('the build ran past its time limit'), false);

  const h = lane({ built: { ok: false, sessionId: 6001, error: 'the worker would not start: volume quota', costUsd: null } });
  assert.equal(await buildWith(t, h), 'infra');
  assert.equal(recorded(h), undefined, 'not recorded as the bot\'s failure');
  const back = h.calls.queries.find((q) => /SET build_at = NULL, build_attempts = GREATEST\(build_attempts - 1, 0\)/.test(q.s));
  assert.deepEqual(back.params, [900], 'back in the queue, the attempt not counted');
  const summary = await bot.buildLaneSummary({ async query() { return { rows: [{}] }; } });
  assert.match(summary.fault.error, /worker would not start/, 'the dashboard says why the lane is idle');
  bot._resetForTests();
});

// ── The lane: builds side by side, never more than its slots ────────────

function drainPool({ claims, settings = { shadow_builds: 'on', build_concurrency: '2' }, seen = [] }) {
  return {
    async query(sql, params) {
      const s = String(sql);
      seen.push({ s, params });
      if (/FROM platform_settings/.test(s)) {
        return {
          rows: [
            { key: 'homeroom_bot_mode', value: 'shadow' },
            { key: bot.KEY_SHADOW_BUILDS, value: settings.shadow_builds },
            { key: bot.KEY_BUILD_CONCURRENCY, value: settings.build_concurrency },
          ],
        };
      }
      if (/SELECT id, username, weekly_limit_cents FROM users/.test(s)) return { rows: [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      if (/SELECT is_synthetic FROM users/.test(s)) return { rows: [{ is_synthetic: true }] };
      if (/WITH building AS/.test(s)) return { rows: claims.splice(0, params[0]) };
      if (/FROM apps WHERE id = \$1/.test(s)) return { rows: [{ ...APP, id: params[0], slug: `app-${params[0]}` }] };
      return { rows: [], rowCount: 0 };
    },
  };
}

function drainDeps(budget = { ok: true }) {
  return {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 1, title: 't', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    limits: { async checkBudget() { return budget; }, async recordSpend() {} },
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: { buildHeadlessSeed: () => 'seed' },
    worker: {}, agentTurn: {}, activeWorkers: new Set(), sessionLifecycle: {},
  };
}

test('the lane runs builds side by side, up to its slots, and returns without waiting on them', async (t) => {
  bot._resetForTests();
  const real = live.buildAndPropose;
  t.after(() => { live.buildAndPropose = real; bot._resetForTests(); });
  const gates = [];
  let running = 0;
  let peak = 0;
  live.buildAndPropose = async (args) => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((resolve) => gates.push(resolve));
    running -= 1;
    return { ok: true, sessionId: args.issueNumber, branchName: `dev/b${args.issueNumber}`, commits: 1, costUsd: 0 };
  };
  const claims = [
    { id: 1, app_id: 10, issue_number: 1, build_note: 'a' },
    { id: 2, app_id: 11, issue_number: 2, build_note: 'b' },
    { id: 3, app_id: 12, issue_number: 3, build_note: 'c' },
  ];
  const seen = [];
  const pool = drainPool({ claims, seen });
  const settle = () => new Promise((r) => setTimeout(r, 10));

  const first = await bot.drainBuilds(pool, {}, drainDeps());
  assert.equal(first.started, 2, 'two slots, two builds');
  assert.deepEqual(bot._buildsInFlightForTests(), [1, 2]);
  const claim = seen.find((q) => /WITH building AS/.test(q.s));
  assert.deepEqual(claim.params, [2, []], 'asks for exactly the free slots');
  await settle();
  assert.equal(peak, 2, 'both run at once, each on its own session and worker');

  const again = await bot.drainBuilds(pool, {}, drainDeps());
  assert.equal(again.started, 0, 'no free slot, no claim');
  assert.equal(seen.filter((q) => /WITH building AS/.test(q.s)).length, 1);
  const stale = seen.filter((q) => /interrupted: the build never finished/.test(q.s)).pop();
  assert.deepEqual(stale.params[1], [1, 2], 'a build still running here is never released as stale');

  gates.shift()();
  await settle();
  assert.deepEqual(bot._buildsInFlightForTests(), [2], 'a finished build frees its slot');
  const third = await bot.drainBuilds(pool, {}, drainDeps());
  assert.equal(third.started, 1, 'and the next one takes it');
  await settle();
  while (gates.length) gates.shift()();
  await bot._awaitBuildsForTests();
  assert.deepEqual(bot._buildsInFlightForTests(), []);
});

test('the lane idles when shadow builds are off, and on the weekly cap', async () => {
  bot._resetForTests();
  const seen = [];
  const off = await bot.drainBuilds(drainPool({ claims: [], settings: { shadow_builds: 'off', build_concurrency: '2' }, seen }), {}, drainDeps());
  assert.equal(off.paused, 'off');
  assert.equal(seen.some((q) => /WITH building AS/.test(q.s)), false);
  const capped = await bot.drainBuilds(drainPool({ claims: [{ id: 1, app_id: 10, issue_number: 1 }], seen }), {}, drainDeps({ error: 'limit', reason: 'weekly' }));
  assert.equal(capped.paused, 'budget');
  assert.equal(capped.started, 0);
  assert.equal(seen.some((q) => /WITH building AS/.test(q.s)), false, 'nothing is claimed that cannot be paid for');
});

test('the claim deals the free slots to apps in turns, oldest first, skipping paused apps', () => {
  const src = read('src/services/homeroom-bot.js');
  const sql = src.slice(src.indexOf('const CLAIM_BUILDS_SQL'), src.indexOf('RETURNING r.id, r.app_id, r.issue_number, r.build_note'));
  assert.match(sql, /SELECT app_id, COUNT\(\*\)::int AS n FROM homeroom_bot_runs/, 'builds under way are counted per app');
  assert.match(sql, /COALESCE\(b\.n, 0\)\s*\+ ROW_NUMBER\(\) OVER \(PARTITION BY r\.app_id ORDER BY r\.build_queued_at, r\.id\) AS turn/,
    'an app\'s queued builds take turns after the ones it already has under way');
  assert.doesNotMatch(sql, /NOT IN \(SELECT app_id FROM building\)/, 'an app already building can still fill an idle slot');
  assert.doesNotMatch(sql, /DISTINCT ON/, 'an app alone in the queue is not held to one slot');
  assert.match(sql, /NOT \(a\.slug = ANY\(\$2::text\[\]\)\)/, 'paused apps wait');
  assert.match(sql, /ORDER BY turn, build_queued_at, id LIMIT \$1/, 'turn first, then oldest, the free slots only');
  assert.match(sql, /WHERE r\.id = picked\.id AND r\.build_at IS NULL/, 'the UPDATE is the claim');
});

// ── The backfill is gone with the shadow apps it built for ──────────────

test('there is no backfill any more: every app but a paused one is live', () => {
  assert.equal(bot.queueShadowBackfill, undefined);
  assert.doesNotMatch(read('src/routes/admin.js'), /shadow-builds\/backfill/);
  // A run triage noted it could not build because of a setting is still
  // told apart from a skip the lane made itself (runQueuedBuild).
  assert.equal(bot.skippedAtTriage("skipped: the platform's own repository is left out"), true);
  assert.equal(bot.skippedAtTriage('skipped: the issue is no longer open'), false, 'the lane\'s own skip stays skipped');
  assert.equal(bot.skippedAtTriage(null), false);
});

// ── Seeing it: the export and the dashboard ─────────────────────────────

test('the export carries the branch, with a compare address to open, after every older column', () => {
  const header = bot.EXPORT_COLUMNS;
  const at = header.indexOf('build_ok');
  assert.deepEqual(header.slice(at, at + 11), ['build_ok', 'build_branch', 'build_url', 'build_sha', 'build_commits', 'build_error', 'build_cost_usd', 'build_at', 'build_queued_at', 'build_spec_md', 'build_session_id']);
  assert.ok(header.indexOf('proposal_session_id') < header.indexOf('build_ok'), 'appended, so older analyses do not shift');
  const row = bot.exportRow({
    id: 1, issue_number: 12, repo_url: 'https://github.com/usernode-bot/todo.git',
    build_ok: true, build_branch: 'dev/homeroom_bot-s6001', build_sha: 'c'.repeat(40), build_commits: 2,
  });
  assert.equal(row[header.indexOf('build_url')], 'https://github.com/usernode-bot/todo/compare/dev/homeroom_bot-s6001');
  assert.equal(bot.exportRow({ id: 2, repo_url: 'https://github.com/o/r' })[header.indexOf('build_url')], '', 'no branch, no address');
});

test('the dashboard keeps the two settings that still do something, and the runs keep their shadow history', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  // No shadow apps, so no switch, no backfill and no lane line for them.
  assert.doesNotMatch(tsx, /id="admin-homeroom-bot-shadow-builds"|admin-homeroom-bot-shadow-backfill|admin-homeroom-bot-build-lane|shadow-builds\/backfill/);
  assert.doesNotMatch(tsx, /setField\('shadowBuilds'/);
  // How many shadow builds run at once, and whether side builds include the
  // platform's own repository (laterSideSkipReason), say so; and the note
  // says the benchmark and side builds wait for the live requests at once
  // (isLiveLaneSaturated), not for this number, which held them back behind
  // any two live builds until 9 Oct 2026.
  assert.match(tsx, /id="admin-homeroom-bot-side-builds"/);
  assert.match(tsx, /<NumberField id="admin-homeroom-bot-build-concurrency" label="Shadow builds at once"/);
  assert.doesNotMatch(tsx, /Live builds before side builds wait|fewer live builds than this/);
  assert.match(tsx, /start only while the bot&apos;s live requests leave a slot free \(Live requests at once, under Advanced\)/);
  assert.match(tsx, /onChange=\{\(v\) => setField\('buildConcurrency', v\)\}/);
  assert.match(tsx, /id="admin-homeroom-bot-shadow-build-platform"[\s\S]{0,400}<span>Make side builds on Homeroom&apos;s own repository too<\/span>/);
  assert.match(tsx, /id="admin-homeroom-bot-side-builds-note"/);
  const fn = tsx.slice(tsx.indexOf('function ShadowBuild('), tsx.indexOf('function VerdictBody('));
  assert.match(fn, /data-shadow-build="queued"/);
  assert.match(fn, /data-shadow-build="building"/);
  assert.match(fn, /data-shadow-build="skipped"/);
  assert.match(fn, /Not proposed, not posted\./);
  assert.match(fn, /\{run\.buildUrl \? <p className=\{`\$\{AdminUI\.muted\} break-all select-all`\}>\{run\.buildUrl\}<\/p>/);
  assert.doesNotMatch(fn, /href=/, 'an address built from an app\'s repo_url is text to copy');
  assert.match(tsx, /<ShadowBuild run=\{run\} \/>/);
});

// #3654: the benchmark yields only to live work, the requests a person is
// waiting for. A full shadow lane must not hold it back: both are
// experiments, and counting shadow builds starved the benchmark whenever
// the shadow bot was busy. Live work has `liveAtOnce` slots; the benchmark
// waited behind the shadow lane's `buildConcurrency` (2) until 9 Oct 2026,
// so any two live builds held every trial and side build back.
test('the benchmark waits for live work to fill its live slots only, never for shadow builds', () => {
  const settings = { buildConcurrency: 2, liveAtOnce: 12 };
  assert.equal(bot.isLiveLaneSaturated(settings, { live: 0 }), false, 'nothing live: the bench may run');
  assert.equal(bot.isLiveLaneSaturated(settings, { live: 2 }), false, 'two live builds leave ten live slots free');
  assert.equal(bot.isLiveLaneSaturated(settings, { live: 11 }), false);
  assert.equal(bot.isLiveLaneSaturated(settings, { live: 12 }), true, 'every live slot taken');
  assert.equal(bot.isLiveLaneSaturated({ liveAtOnce: 4, buildConcurrency: 4 }, { live: 3 }), false);
  assert.equal(bot.isLiveLaneSaturated({ liveAtOnce: 4 }, { live: 4 }), true);
  assert.equal(bot.isLiveLaneSaturated({}, { live: 11 }), false, 'the default liveAtOnce (12) when unset');
  assert.equal(bot.isLiveLaneSaturated({}, { live: 12 }), true);
  // With no live work under way in this process, a busy shadow lane
  // does not saturate it.
  assert.equal(bot.isLiveLaneSaturated(settings), false);
  assert.doesNotMatch(String(bot.isLiveLaneSaturated), /buildsInFlight\.size \+/, 'shadow builds are not counted');
  assert.doesNotMatch(String(bot.isLiveLaneSaturated), /buildConcurrency/, 'the shadow lane\'s number is not the live lane\'s');
  assert.match(String(bot.isLiveLaneSaturated), /e\.lane === 'live'/, 'reads and builds alike: the live slots dispatch fills');
});
