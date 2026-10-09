'use strict';

// #3401: a platform redeploy restarts the server, not the worker, so a
// Homeroom bot build is still running when the new server comes up, and
// restart recovery adopts it. Recovery used to finish it as a person's dev
// chat: a draft PR on the app's repository, a staging preview, a wrap-up
// and a notification, while the bot's run stayed "building" until it was
// requeued and built a second time. Now recovery follows the journal as
// before and hands the result to the bot, which records it on its run.
//
// server.js only boots when run as the entry point, so requiring it exposes
// adoptOrphanWorker without starting anything. The worker, the agent-turn
// ledger and the spend helpers are stubbed before the require.
//
// Run with: node --test tests/homeroom-bot-restart-recovery.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

// ── worker stub ─────────────────────────────────────────────────────────
// resumeTurnFromJournal stands in for following the journal; `journalTail`
// is what each test's turn returns.
let journalTail = async () => ({});
// What each journal replay was asked for (#1080: its harness).
const resumeOpts = [];
const workerCalls = [];
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  usesKubernetesWorkers: () => false,
  resumeTurnFromJournal: async (sessionId, opts) => {
    workerCalls.push(['resume', sessionId]);
    resumeOpts.push(opts);
    return journalTail(sessionId, opts);
  },
  stopTurn: async (sessionId) => { workerCalls.push(['stopTurn', sessionId]); stopped?.(); return true; },
  finishTurn: async (sessionId) => { workerCalls.push(['finishTurn', sessionId]); return true; },
  markTurnTail: async () => true,
  noteTailMilestone: async () => true,
  clearActiveTurn: async () => true,
  adoptWarmWorker: (sessionId) => { workerCalls.push(['adoptWarmWorker', sessionId]); },
  destroyWorker: async (name) => { workerCalls.push(['destroyWorker', name]); },
  isWorkerExecuting: async () => false,
  getTurnByokCents: () => 0,
  workerContainerName: (id) => `usernode-worker-${id}`,
};
let stopped = null;

const wsPath = require.resolve('../src/services/ws');
const realWs = require(wsPath);
require.cache[wsPath].exports = {
  ...realWs,
  broadcastGlobal: () => {},
  pushNotificationToUser: () => 0,
  pushToUser: () => 0,
};

const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...a) => { const t = origSetInterval(...a); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...a) => { const t = origSetTimeout(...a); if (t && t.unref) t.unref(); return t; };
let adoptOrphanWorker;
try {
  ({ adoptOrphanWorker } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

const bot = require('../src/services/homeroom-bot');
const agentTurn = require('../src/services/agent-turn');
const sessionsRoutes = require('../src/routes/sessions');
const prMetadata = require('../src/services/pr-metadata');
const managedKeys = require('../src/services/openrouter-managed-keys');
const limits = require('../src/services/limits');

// The ledger and the thread are settled exactly as for any recovered turn;
// what they do is covered elsewhere, and here they only have to succeed.
const settled = [];
agentTurn.persistRecoveredAgentThread = async () => {};
agentTurn.settleRecoveredAgentAttempt = async ({ activeTurn }) => { settled.push(activeTurn.turnUuid); return null; };
sessionsRoutes.resumeRecoveredCodexFreshRetry = async () => null;
// Anything reaching the dev-chat tail would open a PR through this.
const prCalls = [];
prMetadata.applyPrMetadata = async (args) => { prCalls.push(args); return {}; };
const spends = [];
managedKeys.usesIncludedKey = async () => true;
limits.recordSpend = async (_pool, userId, cents) => { spends.push({ userId, cents }); };

// ── fixtures ────────────────────────────────────────────────────────────

const BOT_ID = 77;
const RUN = { id: 900, app_id: 5, issue_number: 12, build_attempts: 1 };

function botSession(extra = {}) {
  return {
    id: 6001, status: 'active', is_headless: false, user_id: BOT_ID, app_id: 5,
    username: 'homeroom_bot', user_is_synthetic: true,
    app_slug: 'todo', app_name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo',
    branch_name: 'dev/homeroom_bot-s6001',
    active_turn: turn(),
    ...extra,
  };
}

function turn(extra = {}) {
  return {
    turnId: 'turn-1', turnUuid: 'uuid-1', journal: '/journals/turn-1.log',
    phase: 'executing', mode: 'build', backend: 'codex_openrouter', model: 'z-ai/glm-5.3-flash',
    startedAt: new Date().toISOString(), attemptNumber: 1,
    ...extra,
  };
}

/** A pool that answers the session read, the run lookup and the cost sum. */
function makePool({
  session, run = RUN, cost = 0.42, liveRun = null, earlierBuilds = [], firstVersion = false,
  sessionSpec = '# Spec', runSpec = null, resumedBefore = 0, restarts = null,
}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const s = String(sql);
      calls.push({ sql: s, params });
      // The restart counted on the turn's record (turn-lifecycle noteRestart).
      if (/SET active_turn = jsonb_set\(\s*active_turn, '\{restarts\}'/.test(s)) {
        return { rows: restarts == null ? [] : [{ restarts }] };
      }
      // Whether a live build is its project's first version (recoveryDeadline).
      if (/SELECT first_version FROM homeroom_bot_requesters WHERE app_id = \$1/.test(s)) {
        return { rows: firstVersion ? [{ first_version: true }] : [] };
      }
      // The request's earlier live builds, newest first (restartedBuildsBefore).
      if (/SELECT build_error FROM homeroom_bot_runs/.test(s)) return { rows: earlierBuilds };
      // A live run put back in line with its kept plan (resumeLiveBuildFromSpec).
      if (/SET build_spec_md = \$2, build_cost_usd = \$3, build_session_id = NULL/.test(s)) return { rows: [{ id: params[0] }] };
      if (/SELECT cs\.\*/.test(s) && /FROM chat_sessions cs/.test(s)) return { rows: session ? [session] : [] };
      if (/WHERE build_session_id = \$1 AND mode = 'live'/.test(s)) return { rows: liveRun ? [liveRun] : [] };
      if (/FROM homeroom_bot_runs\s+WHERE build_session_id = \$1/.test(s)) return { rows: run ? [run] : [] };
      // What completeRecoveredLive reads once the session is free.
      if (/spec_version/.test(s) && /FROM chat_sessions cs WHERE cs\.id = \$1/.test(s)) {
        return { rows: [{ id: session.id, user_id: BOT_ID, status: 'active', branch_name: session.branch_name, spec_md: sessionSpec, spec_version: 2 }] };
      }
      // #4210: the plan a run kept from an earlier build (keptRunSpec), and
      // how many of its builds already carried on from it (resumesOfRun).
      if (/SELECT build_spec_md FROM homeroom_bot_runs WHERE id = \$1/.test(s)) return { rows: [{ build_spec_md: runSpec }] };
      if (/SELECT COUNT\(\*\)::int AS n FROM events/.test(s)) return { rows: [{ n: resumedBefore }] };
      if (/FROM apps WHERE id = \$1/.test(s)) return { rows: [{ id: 5, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo' }] };
      if (/FROM users WHERE username = \$1/.test(s)) return { rows: [{ id: BOT_ID, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      if (/SUM\(estimated_cost_usd\)/.test(s)) return { rows: [{ cost }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

const staging = { calls: [], async buildAndDeployStaging(...a) { this.calls.push(a); return {}; } };

async function adopt(pool, session, state = 'running') {
  await adoptOrphanWorker(
    { name: `usernode-worker-${session.id}`, sessionId: session.id, state },
    { config: {}, pool, staging, ghub: {}, broadcastGlobal: () => {} },
  );
}

const runUpdates = (pool) => pool.calls.filter((c) => /UPDATE homeroom_bot_runs/.test(c.sql));
const sessionUpdates = (pool) => pool.calls.filter((c) => /UPDATE chat_sessions SET status/.test(c.sql));
const devChatRows = (pool) => pool.calls.filter((c) => /INSERT INTO chat_session_messages/.test(c.sql));

test.beforeEach(() => {
  workerCalls.length = 0; prCalls.length = 0; spends.length = 0; settled.length = 0; staging.calls.length = 0;
  journalTail = async () => ({});
  stopped = null;
  bot._resetForTests();
});

// ── Which sessions are the bot's ─────────────────────────────────────────

test('only the bot\'s own active sessions are handed to it; a person\'s, and the bot\'s proposal, keep dev-chat recovery', () => {
  assert.equal(bot.isRecoveredBotSession(botSession()), true);
  assert.equal(bot.isRecoveredBotSession(botSession({ username: 'alice', user_is_synthetic: false })), false, 'a person');
  assert.equal(bot.isRecoveredBotSession(botSession({ user_is_synthetic: false })), false, 'a real account that took the name');
  assert.equal(bot.isRecoveredBotSession(botSession({ status: 'promoted' })), false,
    'a follow-up on the bot\'s proposal: updating its PR and staging is the right end');
});

// ── A bot session found paused under a turn (#1006) ──────────────────────
// Before #1006 the triage pass took a running build's session (the bot's
// newest) and paused it under the build. The next deploy's recovery read the
// pause as "nobody wants this", destroyed the worker in silence and left the
// turn record for the watchdog: six platform builds lost on 10-02.

test('a bot session paused with a turn record is the bot\'s; one paused with none is not', () => {
  assert.equal(bot.isRecoveredBotSession(botSession({ status: 'paused' })), true);
  assert.equal(bot.isRecoveredBotSession(botSession({ status: 'paused', active_turn: null })), false,
    'nothing in flight: a paused session at rest is still dropped');
  assert.equal(bot.isRecoveredBotSession(botSession({ status: 'archived' })), false);
  assert.equal(bot.isRecoveredBotSession(botSession({ status: 'paused', username: 'alice', user_is_synthetic: false })), false,
    'a person\'s paused session keeps its own rule');
});

test('a build whose session was paused under it is followed and recorded, not destroyed in silence', async () => {
  journalTail = async () => ({ pushOk: true, ahead: 1, sha: 'c'.repeat(40), exitCode: 0 });
  const session = botSession({ status: 'paused' });
  const pool = makePool({ session });
  await adopt(pool, session);
  assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'resume', 'finishTurn'],
    'followed like an active one; the worker is not destroyed first');
  const rec = runUpdates(pool).find((c) => /SET build_ok = \$2/.test(c.sql));
  assert.ok(rec, 'the run is recorded');
  assert.equal(rec.params[1], true);
  assert.deepEqual(devChatRows(pool), []);
});

test('a paused bot session whose worker is gone hands its run back unspent', async () => {
  const session = botSession({ status: 'paused' });
  const pool = makePool({ session });
  await adopt(pool, session, 'exited');
  assert.deepEqual(workerCalls.map((c) => c[0]), ['finishTurn', 'destroyWorker']);
  assert.ok(runUpdates(pool).some((c) => /build_attempts = GREATEST\(build_attempts - 1, 0\)/.test(c.sql)),
    'a deploy is not the build\'s failure');
});

test('a paused bot session with no turn record is still dropped, as before', async () => {
  const session = botSession({ status: 'paused', active_turn: null });
  const pool = makePool({ session });
  await adopt(pool, session);
  assert.deepEqual(workerCalls.map((c) => c[0]), ['destroyWorker']);
  assert.deepEqual(runUpdates(pool), []);
});

// ── A turn the stale-turn watchdog reaped (#1006) ───────────────────────

test('a reaped bot build goes back in the queue unspent, with nothing said to a person', async () => {
  const session = botSession({ status: 'paused' });
  const pool = makePool({ session });
  const outcome = await bot.settleReapedTurn({ pool, config: {}, session });
  assert.equal(outcome, 'requeued');
  assert.ok(runUpdates(pool).some((c) => /build_attempts = GREATEST\(build_attempts - 1, 0\), build_session_id = NULL/.test(c.sql)));
  assert.ok(sessionUpdates(pool).some((c) => /'archived'/.test(c.sql)), 'the dead build session is put away');
  assert.deepEqual(devChatRows(pool), []);
});

test('a reaped turn of a build this process is still running is left to that build', async () => {
  const session = botSession();
  const pool = makePool({ session });
  let finish;
  const holding = bot.holdSlotDuringRecovery(pool, session.id, new Promise((r) => { finish = r; }));
  for (let i = 0; i < 20 && !bot._buildsInFlightForTests().length; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(bot._buildsInFlightForTests(), [900]);
  const before = runUpdates(pool).length;
  assert.equal(await bot.settleReapedTurn({ pool, config: {}, session }), 'in_flight');
  assert.equal(runUpdates(pool).length, before, 'the run is untouched');
  finish();
  await holding;
});

test('the stale-turn watchdog hands a bot or bench turn to its owner before a person\'s breadcrumb', () => {
  const src = require('node:fs').readFileSync(require.resolve('../server'), 'utf8');
  const start = src.indexOf('Stale active_turn watchdog');
  const body = src.slice(start, src.indexOf('Stale active_turn watchdog sweep failed', start));
  assert.match(body, /u\.username, u\.is_synthetic AS user_is_synthetic/, 'the sweep reads who owns the session');
  const reaped = body.indexOf('worker.clearActiveTurn(row.id');
  const bench = body.indexOf("isBenchSession(row)");
  const botAt = body.indexOf('settleReapedTurn({ pool, config, session: row })');
  const breadcrumb = body.indexOf('TURN_UNFINISHED_BREADCRUMB');
  assert.ok(reaped > 0 && bench > reaped && botAt > bench && breadcrumb > botAt,
    'cleared first (a CAS miss hands nothing back), then the owner, then the person path');
  assert.match(body.slice(bench, breadcrumb), /releaseTrialOfSession\(pool, row\.id/);
});

// ── A build turn ─────────────────────────────────────────────────────────

test('a build that finished while the server was down is recorded on its run, with no PR, staging or dev-chat rows', async () => {
  journalTail = async () => ({ pushOk: true, ahead: 2, sha: 'a'.repeat(40), exitCode: 0 });
  const session = botSession();
  const pool = makePool({ session });
  await adopt(pool, session);

  assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'resume', 'finishTurn'],
    'the journal is followed and the turn record cleared, as for any recovered turn');
  assert.deepEqual(settled, ['uuid-1'], 'the ledger attempt is settled');
  const rec = runUpdates(pool).find((c) => /SET build_ok = \$2/.test(c.sql));
  assert.ok(rec, 'the run is recorded');
  assert.deepEqual(rec.params.slice(0, 7), [900, true, 'dev/homeroom_bot-s6001', 'a'.repeat(40), 2, null, 0.42]);
  assert.match(rec.sql, /build_spec_md = COALESCE\(r\.build_spec_md, \(SELECT spec_md FROM chat_sessions WHERE id = \$8\)\)/,
    'the spec the session wrote before the restart is kept');
  assert.ok(sessionUpdates(pool).some((c) => /'archived'/.test(c.sql)), 'the build session is put away');
  assert.deepEqual(spends, [{ userId: BOT_ID, cents: 42 }], 'debited from the bot\'s allowance');
  assert.deepEqual(prCalls, [], 'no PR');
  assert.deepEqual(staging.calls, [], 'no staging');
  assert.deepEqual(devChatRows(pool), [], 'no completion card, breadcrumb or wrap-up row');
});

test('a build that pushed nothing is recorded failed, and says it finished after a restart', async () => {
  journalTail = async () => ({ pushOk: false, ahead: 0, exitCode: 0 });
  const session = botSession();
  const pool = makePool({ session });
  await adopt(pool, session);
  const rec = runUpdates(pool).find((c) => /SET build_ok = \$2/.test(c.sql));
  assert.equal(rec.params[1], false);
  assert.equal(rec.params[5], 'the build produced no change to propose (finished after a restart)');
});

test('the bot\'s clock carries across the restart: a turn past its budget is stopped and recorded as a time-out', async () => {
  // Started 25 minutes ago against the default 20-minute turn budget.
  journalTail = () => new Promise((resolve) => { stopped = () => resolve({ exitCode: 143, pushOk: false, ahead: 0 }); });
  const session = botSession({ active_turn: turn({ startedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString() }) });
  const pool = makePool({ session });
  await adopt(pool, session);
  assert.ok(workerCalls.some((c) => c[0] === 'stopTurn'), 'stopped at once: its time was already up');
  const rec = runUpdates(pool).find((c) => /SET build_ok = \$2/.test(c.sql));
  assert.equal(rec.params[5], 'the build ran past its time limit (finished after a restart)');
});

test('a clock already past its deadline is not unref\'d, so the stop it owes always comes', () => {
  // The case above awaits a journal that only the clock's stopTurn resolves.
  // An unref'd 0 ms timer can be skipped when nothing else holds the event
  // loop open, and node:test then cancels this test and every one after it
  // ("17 cancelled, 0 failed" in the platform's unit run).
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const at = src.indexOf('botClock = setTimeout(');
  assert.ok(at > 0, 'the bot clock is armed in server.js');
  const block = src.slice(at - 200, at + 900);
  assert.match(block, /const botClockMs = Math\.max\(0, deadline - Date\.now\(\)\);/);
  assert.match(block, /if \(botClockMs > 0 && typeof botClock\.unref === 'function'\) botClock\.unref\(\);/);
  assert.doesNotMatch(block, /^\s*if \(typeof botClock\.unref === 'function'\) botClock\.unref\(\);/m,
    'never unref the clock unconditionally');
});

// ── A spec turn ──────────────────────────────────────────────────────────

const SPEC = '# Refresh feeds\n\n## User-facing changes\n\nFeeds refresh.\n\n## Technical implementation\n\nPoll hourly.';

test('a spec turn keeps its spec on the run and puts the build back in the queue, no attempt spent', async () => {
  journalTail = async () => ({ lastResultText: `Done reading.\n${SPEC}`, exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({ session });
  await adopt(pool, session);
  const kept = runUpdates(pool).find((c) => /SET build_spec_md = \$2/.test(c.sql));
  assert.deepEqual(kept.params, [900, SPEC], 'read as the live path reads it: from its title');
  const back = runUpdates(pool).find((c) => /build_attempts = GREATEST\(build_attempts - 1, 0\)/.test(c.sql));
  assert.match(back.sql, /SET build_at = NULL/);
  assert.match(back.sql, /build_session_id = NULL/);
  assert.deepEqual(spends, [{ userId: BOT_ID, cents: 42 }], 'the spec turn\'s cost is debited too');
  assert.deepEqual(prCalls, []);
  assert.deepEqual(devChatRows(pool), [], 'no spec card or wrap-up on the bot\'s session');
});

test('a spec turn that found the request impossible is recorded as blocked', async () => {
  journalTail = async () => ({ lastResultText: 'BLOCKED: the app has no accounts to rank.', exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({ session });
  await adopt(pool, session);
  const rec = runUpdates(pool).find((c) => /SET build_ok = FALSE, build_error = \$2/.test(c.sql));
  assert.deepEqual(rec.params, [900, 'blocked: the app has no accounts to rank. (finished after a restart)', 0.42]);
});

// ── Nothing to follow ────────────────────────────────────────────────────

test('a worker that did not survive puts the run back in the queue unspent', async () => {
  const session = botSession();
  const pool = makePool({ session });
  await adopt(pool, session, 'exited');
  assert.deepEqual(workerCalls.map((c) => c[0]), ['finishTurn', 'destroyWorker'], 'nothing to follow');
  assert.ok(runUpdates(pool).some((c) => /build_attempts = GREATEST\(build_attempts - 1, 0\)/.test(c.sql)));
  assert.deepEqual(prCalls, []);
  assert.deepEqual(devChatRows(pool), []);
});

test('a journal replay that fails puts the run back too, with no stalled notice', async () => {
  journalTail = async () => { throw new Error('journal unreadable'); };
  const session = botSession();
  const pool = makePool({ session });
  agentTurn.completeCodexAttempt = async () => ({ updated: true });
  await adopt(pool, session);
  assert.ok(runUpdates(pool).some((c) => /build_attempts = GREATEST\(build_attempts - 1, 0\)/.test(c.sql)));
  assert.deepEqual(devChatRows(pool), [], 'no "turn unfinished" breadcrumb');
  assert.ok(workerCalls.some((c) => c[0] === 'finishTurn'));
});

test('a triage turn, which no build run owns, rests its session and records nothing', async () => {
  journalTail = async () => ({ lastResultText: '{"verdict":"ready"}', exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({ session, run: null });
  await adopt(pool, session);
  assert.deepEqual(runUpdates(pool), []);
  assert.ok(sessionUpdates(pool).some((c) => /'paused'/.test(c.sql)), 'the triage session rests paused');
  assert.deepEqual(devChatRows(pool), [], 'its verdict is not published as a spec');
});

test('while recovery finishes a build it holds that build\'s lane slot', async () => {
  let release;
  journalTail = () => new Promise((resolve) => { release = () => resolve({ pushOk: true, ahead: 1, sha: 'b'.repeat(40) }); });
  const session = botSession();
  const pool = makePool({ session });
  const running = adopt(pool, session);
  for (let i = 0; i < 50 && !release; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(bot._buildsInFlightForTests(), [900], 'counted against buildConcurrency, and never released as stale');
  release();
  await running;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(bot._buildsInFlightForTests(), []);
});

// ── A live build (#3471) ─────────────────────────────────────────────────
// Its triage pass is gone with the restart: it had dropped the queue row and
// said it was looking. Recovery finishes it the way the live path would.

const live = require('../src/services/homeroom-bot-live');
const github = require('../src/services/github');
const LIVE_RUN = { id: 950, app_id: 5, issue_number: 12 };
const liveCalls = [];
function stubLive({ promote = { status: 200, body: { ok: true, prNumber: 77 } }, issueState = 'open' } = {}) {
  liveCalls.length = 0;
  live.promoteAsBot = async ({ sessionId }) => { liveCalls.push(['promote', sessionId, workerCalls.map((c) => c[0]).join(',')]); return promote; };
  // #3518: named and described before the route runs, as the live path does.
  live.prepareProposal = async ({ sessionId, spec, buildText }) => { liveCalls.push(['prepare', sessionId, spec, buildText || null]); return {}; };
  live.post = async ({ kind, text, metadata }) => { liveCalls.push(['post', kind, text, metadata || null]); return {}; };
  live.postSpecOnProposal = async ({ sessionId, version, spec }) => { liveCalls.push(['specOnProposal', sessionId, version, spec]); };
  live.mentionTargets = async () => [];
  live.botUsernameOf = async () => 'usernode-bot';
  github.fetchPublicIssue = async (_o, _r, n) => ({ issue: { number: n, title: 'Issue', state: issueState } });
}
const requeues = (pool) => pool.calls.filter((c) => /INSERT INTO homeroom_bot_queue/.test(c.sql));
const liveOutcome = (pool) => pool.calls.filter((c) => /SET build_ok = \$2, build_error = \$3/.test(c.sql)).at(-1)?.params;

test('a live build that committed is proposed once recovery lets go, and the proposal is said on the issue', async () => {
  stubLive();
  journalTail = async () => ({ pushOk: true, ahead: 1, sha: 'c'.repeat(40), exitCode: 0, lastResultText: 'Built it.' });
  const session = botSession();
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adopt(pool, session);

  const promote = liveCalls.find((c) => c[0] === 'promote');
  assert.ok(promote, 'proposed');
  // #3518: its name from the spec the session wrote before the restart, and
  // its description from the build's own message, both before the route.
  const prepare = liveCalls.findIndex((c) => c[0] === 'prepare');
  assert.deepEqual(liveCalls[prepare], ['prepare', 6001, '# Spec', 'Built it.']);
  assert.ok(prepare < liveCalls.indexOf(promote), 'named and described before it is proposed');
  assert.equal(promote[1], 6001);
  assert.match(promote[2], /finishTurn/, 'after the turn record is cleared, as the live path promotes after the build turn');
  const said = liveCalls.find((c) => c[0] === 'post' && c[1] === 'proposal');
  assert.ok(said, 'the proposal is said on the issue');
  assert.deepEqual(said[3], { vote: { sessionId: 6001, prNumber: 77 } }, 'with the live vote card');
  assert.deepEqual(liveCalls.find((c) => c[0] === 'specOnProposal'), ['specOnProposal', 6001, 2, '# Spec'], 'and the spec on the proposal');
  assert.ok(pool.calls.some((c) => /SET proposal_session_id = \$2/.test(c.sql) && c.params[0] === 950), 'recorded on the live run');
  const outcome = liveOutcome(pool);
  assert.deepEqual([outcome[0], outcome[1], outcome[2], outcome[4], outcome[5], outcome[6], outcome[7]],
    [950, true, null, 'c'.repeat(40), 1, 0.42, 6001], 'and what it built, as the live path records it (#3509)');
  assert.deepEqual(prCalls, [], 'not the dev-chat PR path');
  assert.deepEqual(requeues(pool), []);
  assert.deepEqual(spends, [{ userId: BOT_ID, cents: 42 }], 'debited as the live path debits a build');
});

test('a live build that pushed nothing says so on the issue, instead of going silent', async () => {
  stubLive();
  journalTail = async () => ({ pushOk: false, ahead: 0, exitCode: 0 });
  const session = botSession();
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adopt(pool, session);
  assert.equal(liveCalls.some((c) => c[0] === 'promote'), false);
  const failed = liveCalls.find((c) => c[0] === 'post' && c[1] === 'build_failed');
  assert.ok(failed, 'the build-failed note is posted');
  // Said in plain words on the request; the run's own record stays on the run.
  assert.equal(failed[2], 'Homeroom bot couldn\'t finish building this: it ended up with no changes to show. '
    + 'Reply here (or on the GitHub issue) and it will try again.');
  assert.deepEqual(liveOutcome(pool).slice(0, 3), [950, false, 'the build produced no change to propose (finished after a restart)']);
  assert.ok(sessionUpdates(pool).some((c) => /'archived'/.test(c.sql)));
});

test('#4553: what a build finished after a restart says is recorded as seen, so it is not built again for it', async (t) => {
  // Run 1278's build "couldn't finish (finished after a restart)"; nothing
  // recorded that note as seen, so the next refresh read it as a change and
  // run 1291 built the request again from scratch, with nobody writing.
  stubLive();
  const realAdvance = live.advanceSeen;
  const seen = [];
  live.advanceSeen = async (args) => { seen.push(args); return { advanced: true }; };
  t.after(() => { live.advanceSeen = realAdvance; });
  live.post = async ({ kind, text }) => { liveCalls.push(['post', kind, text, null]); return { githubCreatedAt: '2026-10-09T12:00:05Z' }; };
  journalTail = async () => ({ pushOk: false, ahead: 0, exitCode: 0 });
  const session = botSession();
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  const query = pool.query.bind(pool);
  // What the run had seen when the restart caught its build.
  pool.query = async (sql, params) => (/SELECT COALESCE\(thread_seen_at, created_at\) AS since FROM homeroom_bot_runs WHERE id = \$1/.test(String(sql))
    ? { rows: [{ since: new Date('2026-10-09T11:40:00Z') }] } : query(sql, params));
  await adopt(pool, session);
  assert.ok(liveCalls.some((c) => c[0] === 'post' && c[1] === 'build_failed'), 'the note is posted');
  assert.equal(seen.length, 1, 'and recorded as seen, as the live path records it');
  assert.deepEqual(
    { runId: seen[0].runId, issueNumber: seen[0].issueNumber, since: seen[0].since, postedAt: seen[0].postedAt, repo: seen[0].repo },
    { runId: 950, issueNumber: 12, since: '2026-10-09T11:40:00.000Z', postedAt: ['2026-10-09T12:00:05Z'], repo: { owner: 'usernode-bot', repo: 'todo' } },
    'from what the run had seen, so a person who wrote while it built is still read',
  );
});

const SPEC_TEXT = '# Spec\n\n## User-facing changes\n\nx\n\n## Technical implementation\n\ny';
const resumes = (pool) => pool.calls.filter((c) => /SET build_spec_md = \$2, build_cost_usd = \$3, build_session_id = NULL/.test(c.sql));

test('a live spec turn that wrote a plan keeps it, and the build goes on from it', async () => {
  stubLive();
  journalTail = async () => ({ lastResultText: SPEC_TEXT, exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adopt(pool, session);
  assert.deepEqual(requeues(pool), [], 'not sent back to be triaged and planned again');
  const [resume] = resumes(pool);
  assert.ok(resume, 'its run is back in line for its build');
  assert.deepEqual(resume.params, [950, SPEC_TEXT, 0.42], 'with the plan, and what writing it cost');
  assert.match(resume.sql, /live_build_waiting_at = NOW\(\)/);
  assert.match(resume.sql, /WHERE id = \$1 AND mode = 'live' AND build_ok IS NULL AND proposal_session_id IS NULL/);
  assert.equal(liveOutcome(pool), undefined, 'no outcome recorded: the build is not over');
  assert.deepEqual(liveCalls.filter((c) => c[0] === 'post'), [], 'nothing said on the issue yet: the build says the plan when it starts');
  assert.ok(sessionUpdates(pool).some((c) => /'archived'/.test(c.sql)), 'the interrupted session is put away');
});

test('a live spec turn with no usable plan sends the issue back to be triaged, and a BLOCKED one says so', async () => {
  stubLive();
  journalTail = async () => ({ lastResultText: '', exitCode: 0 });
  let session = botSession({ active_turn: turn({ mode: 'scout' }) });
  let pool = makePool({ session, run: null, liveRun: LIVE_RUN, sessionSpec: null });
  await adopt(pool, session);
  const [requeue] = requeues(pool);
  assert.ok(requeue, 'back in the queue: its row was gone with the pass');
  assert.deepEqual(requeue.params, [5, 12, 'restart']);
  assert.deepEqual(resumes(pool), []);
  assert.deepEqual(liveCalls.filter((c) => c[0] === 'post'), [], 'nothing said: the fresh triage speaks');

  stubLive();
  journalTail = async () => ({ lastResultText: 'BLOCKED: the app keeps no scores to rank.', exitCode: 0 });
  session = botSession({ active_turn: turn({ mode: 'scout' }) });
  pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adopt(pool, session);
  const blocked = liveCalls.find((c) => c[0] === 'post' && c[1] === 'blocked');
  assert.ok(blocked, 'the blocked note is posted');
  assert.match(blocked[2], /the app keeps no scores to rank\./);
  assert.deepEqual(liveOutcome(pool).slice(0, 2), [950, false]);
  assert.match(liveOutcome(pool)[2], /^blocked: the app keeps no scores to rank\./);
  assert.deepEqual(requeues(pool), []);
  assert.deepEqual(resumes(pool), []);
});

// #4210: a first version's build whose worker was lost was started over from
// the request: a new triage, a new run, a new spec, the creator asked to tap
// Build it again, and "My build was interrupted" in their DM. It carries on
// from the plan it was building instead, on the same run (whose build note
// holds what the creator approved), and nobody is told.
const incidentRows = (pool) => pool.calls
  .filter((c) => /INSERT INTO events/.test(c.sql) && c.params[3] === 'platform_incident')
  .map((c) => ({ appId: c.params[1], sessionId: c.params[2], ...JSON.parse(c.params[4]) }));
const dmRestarts = [];
const dmModule = require('../src/services/homeroom-bot-dm');
dmModule.noteBuildRestarted = async (_pool, args) => { dmRestarts.push(args.runId); return {}; };
test.beforeEach(() => { dmRestarts.length = 0; });

test('a live build whose worker did not survive carries on from its plan, saying nothing, and admins see it', async () => {
  stubLive();
  const session = botSession();
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adopt(pool, session, 'exited');
  assert.deepEqual(requeues(pool), [], 'not sent back to be triaged, planned and approved again');
  const [resume] = resumes(pool);
  assert.ok(resume, 'its run is back in line for its build');
  assert.deepEqual(resume.params, [950, '# Spec', 0.42], 'with the plan it was building from');
  assert.equal(liveOutcome(pool), undefined, 'the run keeps going: its build note (the creator\'s answers) with it');
  assert.equal(liveCalls.some((c) => c[0] === 'promote'), false);
  assert.deepEqual(liveCalls.filter((c) => c[0] === 'post'), [], 'nothing on the issue');
  assert.deepEqual(dmRestarts, [], 'and no "my build was interrupted" in the DM: it is still building');
  const [incident] = incidentRows(pool);
  assert.ok(incident, 'recorded for admins');
  assert.deepEqual(
    [incident.kind, incident.appId, incident.sessionId, incident.runId, incident.issueNumber, incident.outcome],
    ['build_interrupted', 5, 6001, 950, 12, 'resumed'],
  );
  assert.match(incident.why, /worker/);
});

test('a lost build whose session has no plan carries on from the one its run kept', async () => {
  stubLive();
  const session = botSession();
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN, sessionSpec: null, runSpec: '# Kept' });
  await adopt(pool, session, 'exited');
  assert.deepEqual(resumes(pool).map((c) => c.params[1]), ['# Kept']);
  assert.deepEqual(requeues(pool), []);
  assert.deepEqual(dmRestarts, []);
});

test('a lost build with no plan anywhere starts over from the request, and only then is its person told', async () => {
  stubLive();
  const session = botSession();
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN, sessionSpec: null });
  await adopt(pool, session, 'exited');
  assert.deepEqual(requeues(pool).map((c) => c.params), [[5, 12, 'restart']]);
  assert.deepEqual(resumes(pool), []);
  assert.deepEqual(dmRestarts, [950], 'told once that it started again');
  assert.deepEqual(incidentRows(pool).map((i) => i.outcome), ['requeued']);
});

test('a spec turn cut short has no plan to carry on from: its session holds none yet', async () => {
  stubLive();
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN, sessionSpec: null });
  await adopt(pool, session, 'exited');
  assert.deepEqual(resumes(pool), []);
  assert.deepEqual(requeues(pool).map((c) => c.params), [[5, 12, 'restart']]);
});

test('a spec turn that wrote a plan carries on silently too, and is recorded', async () => {
  stubLive();
  journalTail = async () => ({ lastResultText: SPEC_TEXT, exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adopt(pool, session);
  assert.equal(resumes(pool).length, 1);
  assert.deepEqual(dmRestarts, []);
  assert.deepEqual(incidentRows(pool).map((i) => i.outcome), ['resumed']);
});

test('a build that already carried on from its plan twice is stopped the third time, and said', async () => {
  stubLive();
  const session = botSession();
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN, resumedBefore: 2 });
  await adopt(pool, session, 'exited');
  assert.deepEqual(resumes(pool), [], 'not resumed a third time');
  assert.deepEqual(requeues(pool), []);
  assert.ok(liveCalls.some((c) => c[0] === 'post' && c[1] === 'build_failed'), 'said, as any failed build is');
  assert.deepEqual(incidentRows(pool).map((i) => i.outcome), ['failed']);
  const count = pool.calls.find((c) => /SELECT COUNT\(\*\)::int AS n FROM events/.test(c.sql));
  assert.deepEqual(count.params, ['platform_incident', 24, 'build_interrupted', '950']);
});

// Restarts that keep cutting one request's builds short before there is a
// plan to keep, or taking the worker with them: the third in a row is not
// sent round again, but said as a failed build.
const sentBack = (why) => ({ build_error: `interrupted: ${why} ${bot.RESTARTED_BUILD_NOTE}` });

test('the third build in a row a restart cuts short is said to have failed, not sent round again', async () => {
  stubLive();
  journalTail = async () => ({ lastResultText: '', exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({
    session, run: null, liveRun: LIVE_RUN,
    earlierBuilds: [sentBack('the spec turn was cut short'), sentBack('the worker did not survive')],
  });
  await adopt(pool, session);
  assert.deepEqual(requeues(pool), [], 'not back in the queue');
  const failed = liveCalls.find((c) => c[0] === 'post' && c[1] === 'build_failed');
  assert.ok(failed, 'the person is told, as for any failed build');
  assert.match(failed[2], /^Homeroom bot couldn't finish building this: Homeroom restarted in the middle of the build, 3 times in a row\. /);
  const outcome = liveOutcome(pool);
  assert.deepEqual(outcome.slice(0, 2), [950, false]);
  assert.equal(outcome[2], 'the platform restarted in the middle of each of its last 3 tries at building this');
  assert.ok(!outcome[2].endsWith(bot.RESTARTED_BUILD_NOTE), 'the activity card stops on it rather than reading past it');
  // The count reads this request's earlier live builds, newest first, in the window.
  const lookup = pool.calls.find((c) => /SELECT build_error FROM homeroom_bot_runs/.test(c.sql));
  assert.match(lookup.sql, /mode = 'live' AND id < \$3/);
  assert.match(lookup.sql, /build_session_id IS NOT NULL/);
  assert.deepEqual(lookup.params, [5, 12, 950, 24, 2]);
});

test('a lost build after two sent back is stopped the same way', async () => {
  stubLive();
  const session = botSession();
  const pool = makePool({
    session, run: null, liveRun: LIVE_RUN,
    earlierBuilds: [sentBack('the spec turn was cut short'), sentBack('the spec turn was cut short')],
  });
  await adopt(pool, session, 'exited');
  assert.deepEqual(requeues(pool), []);
  assert.ok(liveCalls.some((c) => c[0] === 'post' && c[1] === 'build_failed'));
});

test('restarts that are not back to back still send the build round again', async () => {
  stubLive();
  journalTail = async () => ({ lastResultText: '', exitCode: 0 });
  const session = botSession({ active_turn: turn({ mode: 'scout' }) });
  const pool = makePool({
    session, run: null, liveRun: LIVE_RUN,
    // Newest first: one sent back, then a build that ended some other way.
    earlierBuilds: [sentBack('the spec turn was cut short'), { build_error: 'the build ran past its time limit' }],
    sessionSpec: null,
  });
  await adopt(pool, session);
  assert.deepEqual(requeues(pool).map((c) => c.params), [[5, 12, 'restart']]);
  assert.deepEqual(liveCalls.filter((c) => c[0] === 'post'), [], 'nothing said: the fresh triage speaks');
  assert.ok(liveOutcome(pool)[2].endsWith(bot.RESTARTED_BUILD_NOTE));
});

test('an issue a restart sent back is not told "looking" a second time', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  assert.equal(bot.RESTART_REASON, 'restart');
  assert.match(src, /const looked = item\.reason === RESTART_REASON \|\| item\.reason === APP_AGAIN_REASON\n\s+\|\| item\.reason === RETRY_FAILED_REASON \|\| item\.reason === READ_AGAIN_REASON \? null : await live\.post\(\{\n\s+pool, github, ws: liveD\.ws, app, repo, issueNumber,\n\s+kind: 'looking'/,
    'nor is a request whose failed read is tried again (#1080)');
});

// #1006, after the live stubs above.
test('a reaped live build is settled the way restart recovery settles one it could not follow', async () => {
  stubLive();
  const session = botSession();
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await bot.settleReapedTurn({ pool, config: {}, session });
  assert.deepEqual(resumes(pool).map((c) => c.params[1]), ['# Spec'], 'its build carries on from its plan (#4210)');
  assert.deepEqual(requeues(pool), []);

  stubLive();
  const bare = makePool({ session, run: null, liveRun: LIVE_RUN, sessionSpec: null });
  await bot.settleReapedTurn({ pool: bare, config: {}, session });
  assert.deepEqual(requeues(bare).map((c) => c.params), [[5, 12, 'restart']], 'with no plan, the issue goes back to be triaged');
});

// ── A live build's time, across restarts ────────────────────────────────
// 5 Oct 2026, Page Turners #3: four deploys landed in its build, and its
// requester was told it "ran past its time limit (finished after a
// restart)". #3895 then sent a build whose clock ran out after any restart
// reached it round again from the start; on 7 Oct, with a deploy behind most
// merges, that built two requests that simply needed more than their 20
// minutes three times each. Now the worker's run through a restart is
// trusted: each restart that reaches a turn gives its clock back
// RESTART_ALLOWANCE_MS (counted on the turn's record), and a build whose
// clock still runs out ran too long on its own, and is said so.
//
// A recovery leaves nothing behind it but the turn record, whose start never
// moves: each restart's recovery arms the same deadline, plus the restarts
// counted so far. These adopt the last of them.

const TURN_BUDGET_MS = bot.DEFAULTS.turnSeconds * 1000;
const startedAgo = (ms) => new Date(Date.now() - ms).toISOString();
// Runs until the bot's clock stops it, as a build still working does.
const untilStopped = () => new Promise((resolve) => { stopped = () => resolve({ exitCode: 143, pushOk: false, ahead: 0 }); });
// Time left on the clock when recovery takes the turn: enough that a loaded
// runner cannot spend it all before server.js reads the deadline.
const CLOCK_LEFT_MS = 1500;
// A clock with time left is unref'd in server.js, so it never holds a
// shutting-down process open. Here nothing else holds the event loop while
// the journal waits on that clock, and node:test would end the file and
// cancel this test and every one after it ("7 cancelled, 0 failed" in the
// platform's unit run). Hold the loop open until the adoption settles.
async function adoptHeld(pool, session) {
  const hold = setInterval(() => {}, 1000);
  try { return await adopt(pool, session); } finally { clearInterval(hold); }
}

test('each restart that reaches a turn gives its clock back two minutes, up to ten restarts', async () => {
  assert.equal(bot.RESTART_ALLOWANCE_MS, 2 * 60 * 1000);
  assert.equal(bot.restartAllowanceMs(turn()), 0, 'a turn no restart reached');
  assert.equal(bot.restartAllowanceMs(turn({ restarts: 3 })), 3 * bot.RESTART_ALLOWANCE_MS);
  assert.equal(bot.restartAllowanceMs(turn({ restarts: 50 })), 10 * bot.RESTART_ALLOWANCE_MS, 'a run of restarts is not followed for ever');
  assert.equal(bot.restartAllowanceMs(turn({ restarts: 'x' })), 0);
  const startedAt = new Date('2026-10-07T20:38:48Z').toISOString();
  const session = botSession({ active_turn: turn({ startedAt }) });
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  const plain = await bot.recoveryDeadline(pool, {}, session, turn({ startedAt }));
  const three = await bot.recoveryDeadline(pool, {}, session, turn({ startedAt, restarts: 3 }));
  assert.equal(plain - Date.parse(startedAt), TURN_BUDGET_MS);
  assert.equal(three - plain, 3 * bot.RESTART_ALLOWANCE_MS);
});

test('a live build whose clock runs out after restarts ran too long on its own: said, not sent round again', async () => {
  stubLive();
  journalTail = untilStopped;
  // Three restarts reached it (this recovery's included); its clock with
  // their six minutes given back has a moment left.
  const session = botSession({
    active_turn: turn({ startedAt: startedAgo(TURN_BUDGET_MS + 3 * bot.RESTART_ALLOWANCE_MS - CLOCK_LEFT_MS) }),
  });
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN, restarts: 3 });
  await adoptHeld(pool, session);
  const counted = pool.calls.find((c) => /'\{restarts\}'/.test(c.sql));
  assert.ok(counted, 'the restart is counted on the turn before its clock is read');
  assert.deepEqual(counted.params, [session.id, 'turn-1'], 'on this turn\'s own record');
  assert.ok(workerCalls.some((c) => c[0] === 'stopTurn'), 'the bot\'s clock still ends the turn');
  assert.deepEqual(requeues(pool), [], 'not sent round again: the worker ran on through every restart');
  const failed = liveCalls.find((c) => c[0] === 'post' && c[1] === 'build_failed');
  assert.ok(failed, 'said, as any build that ran too long is');
  assert.deepEqual(liveOutcome(pool).slice(0, 3), [950, false, 'the build ran past its time limit (finished after a restart)']);
});

test('a live build whose time was up before the restart reached it ran too long on its own, and says so', async () => {
  stubLive();
  journalTail = untilStopped;
  const session = botSession({ active_turn: turn({ startedAt: startedAgo(TURN_BUDGET_MS + 5 * 60 * 1000) }) });
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN, restarts: 1 });
  await adoptHeld(pool, session);
  assert.ok(workerCalls.some((c) => c[0] === 'stopTurn'), 'stopped at once: its time, and the two minutes back, were already up');
  assert.deepEqual(requeues(pool), [], 'not sent round again');
  const failed = liveCalls.find((c) => c[0] === 'post' && c[1] === 'build_failed');
  assert.ok(failed, 'said, as any build that ran too long is');
  assert.deepEqual(liveOutcome(pool).slice(0, 3), [950, false, 'the build ran past its time limit (finished after a restart)']);
});

test('a build that finished while the platform was down is proposed, whatever its clock had left', async () => {
  stubLive();
  journalTail = async () => ({ pushOk: true, ahead: 1, sha: 'd'.repeat(40), exitCode: 0, lastResultText: 'Built it.' });
  const session = botSession({ active_turn: turn({ startedAt: startedAgo(TURN_BUDGET_MS - 60 * 1000) }) });
  const pool = makePool({ session, run: null, liveRun: LIVE_RUN });
  await adoptHeld(pool, session);
  assert.ok(liveCalls.some((c) => c[0] === 'promote'));
  assert.equal(workerCalls.some((c) => c[0] === 'stopTurn'), false);
  assert.deepEqual(requeues(pool), []);
});

// #4210: a first version sent back to be read again, with no plan to carry
// on from, is not put to its creator a second time: the plan they approved,
// and the answers they tapped, go onto the new run, which builds at once.
function carryPool({ prev, updated = 1 }) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/SELECT id, plan, build_error FROM homeroom_bot_runs/.test(sql)) return { rows: prev ? [prev] : [] };
      if (/UPDATE homeroom_bot_runs SET build_note = CONCAT/.test(sql)) return { rows: [], rowCount: updated };
      return { rows: [], rowCount: 0 };
    },
  };
}
const APPROVED = {
  bullets: ['A list of restaurants', 'Drag them into tiers'],
  questions: [{ question: 'Which city?', answers: ['SF', 'Oakland'] }],
  chosen: [{ question: 'Which city?', answer: 'Oakland', suggested: false }],
};

test('a first version its creator approved, sent back by a restart, keeps their plan and answers and is not asked again', async () => {
  const pool = carryPool({ prev: { id: 940, plan: APPROVED, build_error: `interrupted: the worker is gone ${bot.RESTARTED_BUILD_NOTE}` } });
  assert.equal(await bot.carryApprovedPlan(pool, { runId: 951, appId: 5, issueNumber: 12 }), true);
  const read = pool.calls[0];
  assert.match(read.sql, /mode = 'live' AND id < \$3\s+ORDER BY id DESC LIMIT 1/);
  assert.deepEqual(read.params, [5, 12, 951]);
  const write = pool.calls[1];
  assert.equal(write.params[0], 951);
  assert.match(write.params[1], /Drag them into tiers/, 'the bullets they approved');
  assert.match(write.params[1], /Which city\? Oakland/, 'and the answer they tapped');
  assert.deepEqual(JSON.parse(write.params[2]), APPROVED);
  assert.match(write.sql, /awaiting_go_at IS NULL/);
});

test('a plan nobody approved, or a run that ended some other way, is asked about as before', async () => {
  const unapproved = { ...APPROVED, chosen: undefined };
  const sentBackNote = `interrupted: the worker is gone ${bot.RESTARTED_BUILD_NOTE}`;
  assert.equal(await bot.carryApprovedPlan(carryPool({ prev: { id: 940, plan: unapproved, build_error: sentBackNote } }), { runId: 951, appId: 5, issueNumber: 12 }), false);
  assert.equal(await bot.carryApprovedPlan(carryPool({ prev: { id: 940, plan: APPROVED, build_error: 'the build ran past its time limit' } }), { runId: 951, appId: 5, issueNumber: 12 }), false);
  assert.equal(await bot.carryApprovedPlan(carryPool({ prev: null }), { runId: 951, appId: 5, issueNumber: 12 }), false);
});

test('a first version\'s ready verdict looks for an approved plan before it sends the plan card', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  assert.match(src, /if \(firstVersion && await carryApprovedPlan\(pool, \{ runId, appId: app\.id, issueNumber \}\)\) \{\n\s+await queueLiveBuild\(pool, \{ runId, appId: app\.id \}\);\n\s+acted = 'build_queued';\n\s+\} else if \(firstVersion\) \{\n\s+acted = PLAN_ACTED\[await awaitGo\(/);
});

test('admins read the week\'s incidents newest first, and a line says what happened', async () => {
  const incidents = require('../src/services/platform-incidents');
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/COUNT/.test(sql)) return { rows: [{ n: 3 }] };
      return { rows: [{ created_at: new Date('2026-10-07T12:00:00Z'), app_slug: 'tiers', metadata: { kind: 'build_interrupted', runId: 950, issueNumber: 1, why: 'the worker is gone', outcome: 'resumed' } }] };
    },
  };
  const out = await incidents.recent(pool);
  assert.equal(out.total, 3);
  assert.deepEqual(out.items[0], {
    at: '2026-10-07T12:00:00.000Z', kind: 'build_interrupted', app: 'tiers', runId: 950, issueNumber: 1, why: 'the worker is gone', outcome: 'resumed',
  });
  assert.match(calls[0].sql, /event_type = \$1 AND e\.created_at > NOW\(\) - make_interval\(days => \$2\)/);
  assert.deepEqual(calls[0].params, ['platform_incident', 7, 20]);
  assert.equal(await incidents.recent({ query: async () => { throw new Error('down'); } }), null, 'never throws');
  const src = require('node:fs').readFileSync(require.resolve('../frontend/src/features/admin/admin-homeroom-bot-health.tsx'), 'utf8');
  assert.match(src, /id="admin-homeroom-bot-unexpected"/);
  assert.match(src, /resumed: 'carried on from its plan'/);
});

test('server.js counts the restart on the turn before it reads the bot\'s clock, for bot and benchmark turns', () => {
  const src = require('node:fs').readFileSync(require.resolve('../server'), 'utf8');
  const at = src.indexOf('const restarts = await turnLifecycle.noteRestart(pool, { sessionId, turnId: activeTurn.turnId })');
  assert.ok(at > 0);
  const clock = src.slice(at, src.indexOf('const botClockMs = Math.max(0, deadline - Date.now());', at));
  assert.match(clock, /const clockTurn = Number\.isInteger\(restarts\) \? \{ \.\.\.activeTurn, restarts \} : activeTurn;/);
  assert.match(clock, /recoveryDeadline\(pool, config, session, clockTurn\)[\s\S]*recoveryDeadline\(pool, config, session, clockTurn\)/,
    'the bench lane\'s clock and the bot\'s both read it');
  assert.doesNotMatch(src, /clockLeftMs/, 'nothing reads what the clock had left any more');
});

// The deadline itself: a live build keeps the budget the live path gave it.
// It used to fall through to a triage turn's one plain budget, so a restart
// halved a first version's clock and cut a platform build's to a third.
test('a recovered live build keeps its own budget: a first version\'s doubled, the platform\'s tripled, a spec capped', async () => {
  const start = Date.parse('2026-10-05T10:31:00Z');
  const at = (mode, { firstVersion = false, repo = 'https://github.com/usernode-bot/todo', liveRun = LIVE_RUN, run = null } = {}) => {
    const session = botSession({ repo_url: repo });
    const pool = makePool({ session, run, liveRun, firstVersion });
    return bot.recoveryDeadline(pool, {}, session, turn({ mode, startedAt: new Date(start).toISOString() }))
      .then((deadline) => (deadline - start) / 60_000);
  };
  const turnMin = TURN_BUDGET_MS / 60_000;
  const specMin = live.SPEC_TURN_MAX_MS / 60_000;
  assert.equal(await at('build'), turnMin, 'a request\'s build');
  assert.equal(await at('scout'), Math.min(turnMin, specMin), 'its spec, as the live path caps it');
  assert.equal(await at('build', { firstVersion: true }), turnMin * bot.FIRST_VERSION_BUILD_TIME_FACTOR, 'a first version');
  assert.equal(await at('scout', { firstVersion: true }), Math.min(turnMin, specMin) * bot.FIRST_VERSION_BUILD_TIME_FACTOR);
  assert.equal(await at('build', { repo: 'https://github.com/Usernode-Labs/social-vibecoding' }),
    turnMin * bot.PLATFORM_BUILD_TIME_FACTOR, 'the platform\'s own repository');
  assert.equal(await at('scout', { liveRun: null }), turnMin, 'a triage turn: one turn\'s budget');
  assert.equal(await at('build', { liveRun: null, run: RUN }), turnMin, 'a lane build, as before');
});

// ── #1080 ────────────────────────────────────────────────────────────────

test('a recovered turn is replayed with its own harness\'s parser', async () => {
  // GLM runs in Claude Code since #3749. Replayed with the default (Codex)
  // parser, a recovered turn came back with no result text, progress or
  // usage: a recovered spec lost its spec, a triage its verdict.
  journalTail = async () => ({ pushOk: true, ahead: 1, sha: 'd'.repeat(40), exitCode: 0 });
  resumeOpts.length = 0;
  let session = botSession({ active_turn: turn({ harness: 'claude' }) });
  await adopt(makePool({ session }), session);
  assert.equal(resumeOpts.at(-1).agentHarness, 'claude');
  session = botSession({ active_turn: turn() });
  await adopt(makePool({ session }), session);
  assert.equal(resumeOpts.at(-1).agentHarness, null, 'a record from before harnesses: the registry\'s own default');
  const src = require('node:fs').readFileSync(require.resolve('../src/routes/sessions'), 'utf8');
  assert.match(src, /agentHarness: activeTurn\.harness \|\| null,/, 'the same as the dev chat\'s own recovery');
});

test('a first version\'s shadow build keeps its doubled clock across a restart', async () => {
  const startedAt = new Date('2026-10-05T00:32:51Z').toISOString();
  const session = botSession({ active_turn: turn({ startedAt }) });
  const plain = await bot.recoveryDeadline(makePool({ session }), {}, session, turn({ startedAt }));
  const first = await bot.recoveryDeadline(makePool({ session, firstVersion: true }), {}, session, turn({ startedAt }));
  assert.equal(first - Date.parse(startedAt), 2 * (plain - Date.parse(startedAt)));
});

test('a shadow build whose clock runs out after a restart ran past its time limit, its restarts given back', async (t) => {
  // Its clock, with its restart given back, has a moment left when recovery
  // takes it, then runs out. The bot's clock is unref'd while it has time
  // left, so hold the loop open.
  const keepAlive = setInterval(() => {}, 20);
  t.after(() => clearInterval(keepAlive));
  journalTail = () => new Promise((resolve) => { stopped = () => resolve({ exitCode: 143, pushOk: false, ahead: 0 }); });
  const session = botSession({
    active_turn: turn({ startedAt: new Date(Date.now() - (20 * 60 * 1000 + bot.RESTART_ALLOWANCE_MS - 150)).toISOString() }),
  });
  const pool = makePool({ session, restarts: 1 });
  await adopt(pool, session);
  assert.equal(runUpdates(pool).some((c) => /SET build_at = NULL, build_session_id = NULL,/.test(c.sql)), false,
    'not back in the lane to be built again');
  const rec = runUpdates(pool).find((c) => /SET build_ok = \$2/.test(c.sql));
  assert.equal(rec.params[5], 'the build ran past its time limit (finished after a restart)');
});

test('shutdown stops the bot\'s loops and its benchmark lane before the pool closes', async () => {
  const src = require('node:fs').readFileSync(require.resolve('../server'), 'utf8');
  const cleanup = src.slice(src.indexOf('async function cleanup()'), src.indexOf("process.on('SIGTERM', cleanup);"));
  const botStop = cleanup.indexOf("require('./src/services/homeroom-bot').stop()");
  const laneStop = cleanup.indexOf("require('./src/services/bench/lane').stop()");
  const poolEnd = cleanup.indexOf('shutdownPool.end()');
  assert.ok(botStop > 0 && laneStop > 0 && poolEnd > laneStop && poolEnd > botStop);

  // And a stopped bot starts nothing: no claim, no read of the pool.
  bot._resetForTests();
  bot.stop();
  const queries = [];
  const pool = { async query(sql) { queries.push(String(sql)); return { rows: [] }; }, async connect() { throw new Error('closed'); } };
  const drained = await bot.drainBuilds(pool, {});
  assert.equal(drained.paused, 'stopped');
  assert.deepEqual(queries, [], 'the lane reads nothing');
  bot._resetForTests();
});
