// #4533: a checks fix keeps its time limit across a restart, its outcome
// reaches the bot's ledger, and a busy session is a wait.
//
// PR #4533 (change 7428, request #4524), 9 Oct 2026. The bot's checks fix on
// its PROMOTED proposal ran 38 minutes against its 20: its clock was a timer
// in the process a deploy restarted, and recovery followed the turn through
// the person's tail, which re-arms no clock for a promoted session. Its push
// moved the proposal, but the ledger had no run for it, no checks_revise
// post and no cost. Its retry then asked for a temporary-storage worker
// while a sync with main ran on persistent storage: "Cannot change worker
// storage while a turn is running" was recorded as a platform fault, which
// paused the bot on every project, and every later retry hit session_busy
// and backed off in silence for up to an hour.
//
// These pin, without a database: the busy session answered before any
// worker is asked for, and read as a refusal (never a fault); the turn
// record's mark and deadline; the recovery deadline and who it binds; the
// recovered outcome recorded through the same runChecksFix / runFollowUp a
// live turn ends in; and the wait shown on the console's queue, the
// connector's and get_change. tests/homeroom-bot-followup-restart-postgres
// .test.js drives the restart itself through server.js.
//
// Run with: node --test tests/homeroom-bot-followup-restart.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const turnLifecycle = require('../src/services/turn-lifecycle');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const APP = { id: 9, slug: 'recipebot-33b169', name: 'RecipeBot', repo_url: 'https://github.com/usernode-bot/recipebot-33b169', self_hosted: false };
const BOT = { id: 77, username: 'homeroom_bot' };
const SETTINGS = { mode: 'shadow', turnSeconds: 1200, turnInputTokens: 10_000_000 };
const SEEN = '2026-10-01T10:00:00Z';
const ITEM = { id: 31, app_id: 9, issue_number: 50, priority: 1, reason: bot.CHECKS_REASON, thread_seen_at: null };
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const TURN_ID = '6f9c1a52-4b8e-4f43-9a8e-5d1c2b3a4f60';

function results() {
  const rows = [{ name: 'Cooking mode text-size control offers all steps', path: '/#cook', status: 'fail', failureReason: 'expected "Text size"' }];
  for (let i = 1; i < 85; i += 1) rows.push({ name: `check ${i}`, path: '/', status: 'pass' });
  return rows;
}

function checksRow(extra = {}) {
  return {
    id: 5001, app_id: 9, linked_issues: [50], check_state: 'failing', checks_commit_sha: HEAD,
    reviewed_head_sha: HEAD, test_results: results(), slug: APP.slug, name: APP.name, repo_url: APP.repo_url,
    looked: false, ...extra,
  };
}

// runTriage down the checks path, as tests/homeroom-bot-checks-fix.test.js
// drives it, with what holds the session (`activeTurn` on its row) and what
// the worker answers (`ensureWorker`) up to each test.
function harness({ activeTurn = null, ensureWorker = null } = {}) {
  const calls = { queries: [], ensured: 0, exec: [], stamps: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT id, status, pr_number FROM chat_sessions/.test(s)) return { rows: [{ id: 5001, status: 'promoted', pr_number: 82 }] };
      if (/SELECT id, thread_seen_at FROM homeroom_bot_runs/.test(s)) return { rows: [{ id: 800, thread_seen_at: SEEN }] };
      if (/AS looked/.test(s)) return { rows: [checksRow()] };
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) {
        return { rows: [{ id: 5001, user_id: 77, app_id: 9, status: 'promoted', branch_name: 'dev/homeroom_bot-5001', pr_number: 82, reviewed_head_sha: HEAD, app_slug: APP.slug, repo_url: APP.repo_url }] };
      }
      if (/SELECT active_turn FROM chat_sessions WHERE id = \$1/.test(s)) return { rows: [{ active_turn: activeTurn }] };
      if (/jsonb_set\(active_turn, ARRAY\[\$3::text\]/.test(s)) { calls.stamps.push(params); return { rows: [{ id: 5001 }], rowCount: 1 }; }
      if (/COUNT\(\*\)::int AS n FROM homeroom_bot_runs/.test(s)) return { rows: [{ n: 0 }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 901 }] };
      if (/FROM platform_settings/.test(s)) return { rows: [{ key: 'homeroom_bot_mode', value: 'shadow' }] };
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 50, title: 'Bigger text in cooking mode', body: 'please', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { calls.ensured += 1; if (ensureWorker) return ensureWorker(); return 'usernode-worker-5001'; },
      async execInWorker(id, opts) {
        calls.exec.push({ id, opts });
        return { lastResultText: '```json\n{"action":"revise","reply":"Renamed.","summary":"It says Text size."}\n```', pushOk: true, sha: NEW_HEAD };
      },
      async stopTurn() {},
      isInFlight: () => false,
      async clearActiveTurn() {},
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; }, estimateRequestedModelCost: () => ({ estimatedCostUsd: null }) },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    threadContext: {
      async loadIssueThread() { return { messages: [] }; },
      async loadProposalThread() { return { messages: [] }; },
    },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: {
      buildHeadlessSeed: (n) => `ISSUE #${n}`,
      async runCodexAttemptLoop({ dispatchOnce }) {
        // As runCodexAttemptLoop hands each attempt its logical turn id.
        const r = await dispatchOnce({ logicalTurnId: TURN_ID });
        return { result: r, error: null, estimatedCostUsd: 0.02 };
      },
    },
    activeWorkers: new Set(),
    ws: {},
    sessionLifecycle: {},
    domain: 'app.onhomeroom.com',
    votes: { async reconcileNativeReviewedHead() { return { enforced: true }; } },
  };
  return { pool, deps, calls };
}

async function triage(t, h) {
  const real = { post: live.post, seen: live.advanceSeen, onProposal: live.postOnProposal, targets: live.mentionTargets };
  t.after(() => {
    Object.assign(live, { post: real.post, advanceSeen: real.seen, postOnProposal: real.onProposal, mentionTargets: real.targets });
    bot._resetForTests();
  });
  live.post = async () => ({ githubCreatedAt: '2026-10-01T12:05:00Z' });
  live.postOnProposal = async () => ({ postId: 1, thread: true });
  live.advanceSeen = async () => ({ advanced: true });
  live.mentionTargets = async () => [];
  bot._resetForTests();
  return bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings: SETTINGS, deps: h.deps });
}

const waitWrite = (h) => h.calls.queries.find((q) => /UPDATE homeroom_bot_queue SET wait_reason = \$2, wait_until = \$3 WHERE id = \$1/.test(q.s));

// ── 3. A busy session is a wait, never a fault ──────────────────────────

test('a turn already running on the proposal: the fix waits before asking for a worker, and only it waits', async (t) => {
  // The 16:26 sync with main: a turn record on the proposal's row.
  const h = harness({ activeTurn: { turnId: 't-sync', mode: 'sync', startedAt: '2026-10-09T16:20:00Z' } });
  const out = await triage(t, h);
  assert.equal(out.reason, 'refused', 'the ordinary busy refusal');
  assert.equal(out.detail, 'session_busy');
  assert.equal(out.followUp, true, 'a follow-up\'s own wait, not its app\'s');
  assert.equal(h.calls.ensured, 0, 'no worker asked for a storage it cannot have under a running turn');
  assert.equal(h.calls.exec.length, 0);
  assert.equal(bot.faultBackoff(), null, 'nothing pauses the bot');
  assert.deepEqual(bot.followUpsBackedOff(), ['9:50']);
  assert.ok(!h.calls.queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)), 'a wait writes no failed run');
  const wait = waitWrite(h);
  assert.ok(wait, 'the row says why it waits');
  assert.equal(wait.params[0], ITEM.id);
  assert.equal(wait.params[1], 'session_busy');
  const until = Date.parse(wait.params[2]);
  assert.ok(until > Date.now() + 60_000 && until <= Date.now() + 2 * 60_000 + 1000, 'and until when: the first backoff, two minutes');
});

// #4575: before & after shots hold the proposal from their first build, but
// write no turn record until their agent starts, minutes later. A follow-up
// that started in that gap took the session, and the shots failed with
// "durable active turn could not be persisted".
test('a before & after shots run under way on the proposal: the follow-up waits for it, as for a turn', async (t) => {
  const orchestrator = require('../src/services/shots-orchestrator');
  const realRunFor = orchestrator.inFlightRunFor;
  t.after(() => { orchestrator.inFlightRunFor = realRunFor; });
  orchestrator.inFlightRunFor = (id) => (Number(id) === 5001 ? new Promise(() => {}) : null);
  const h = harness();
  const out = await triage(t, h);
  assert.equal(out.reason, 'refused');
  assert.equal(out.detail, 'session_busy');
  assert.equal(h.calls.ensured, 0, 'no worker asked for while the shots hold the session');
  assert.equal(h.calls.exec.length, 0);
  assert.equal(bot.faultBackoff(), null, 'a wait, never a fault');
  assert.ok(waitWrite(h), 'and the row says it waits');
  // turnRunningOn reads the shots run for the session's own id.
  const asked = [];
  const running = await followup.turnRunningOn({
    pool: { async query() { return { rows: [{ active_turn: null }] }; } },
    session: { id: 5001 }, worker: { isInFlight: () => false }, activeWorkers: new Set(),
    shotsRunFor: (id) => { asked.push(id); return null; },
  });
  assert.equal(running, false, 'no shots run and no turn: free');
  assert.deepEqual(asked, [5001]);
});

test('the worker refusing to change its storage under a running turn is the same wait, not a platform fault', async (t) => {
  const thrown = Object.assign(new Error('Cannot change worker storage while a turn is running'), { code: 'session_busy' });
  const busy = harness({ ensureWorker: () => { throw thrown; } });
  const refused = await triage(t, busy);
  assert.equal(refused.reason, 'refused');
  assert.equal(refused.detail, 'session_busy');
  assert.equal(bot.faultBackoff(), null);
  assert.ok(!busy.calls.queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)), 'no "worker:" run in the ledger');
  assert.ok(waitWrite(busy), 'and the row says it waits');
  // Any other worker failure is still the platform's.
  const h = harness({ ensureWorker: () => { throw new Error('exceeded quota: persistentvolumeclaims'); } });
  const out = await triage(t, h);
  assert.equal(out.reason, 'infra');
  assert.match(out.detail, /^worker: exceeded quota/);
  // worker.js keeps its own guard, now saying what it is.
  assert.match(read('src/services/worker.js'),
    /throw Object\.assign\(new Error\('Cannot change worker storage while a turn is running'\), \{ code: 'session_busy' \}\);/);
});

test('a read refused its worker\'s storage under a running turn waits too, rather than pausing the bot', async (t) => {
  t.after(() => bot._resetForTests());
  bot._resetForTests();
  const queries = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      queries.push({ s, params });
      if (/SELECT \* FROM chat_sessions/.test(s)) {
        return { rows: [{ id: 501, user_id: 77, app_id: 9, branch_name: 'main', agent_backend: 'codex_openrouter', agent_model: 'z-ai/glm-5.3-flash' }] };
      }
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      async fetchPublicIssue() { return { issue: { number: 12, title: 'Pins drift', body: 'They drift.', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { throw Object.assign(new Error('Cannot change worker storage while a turn is running'), { code: 'session_busy' }); },
      isInFlight: () => false,
    },
    agentTurn: {},
    limits: { async checkBudget() { return { ok: true }; } },
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: { buildHeadlessSeed: () => 'SEED' },
    activeWorkers: new Set(),
  };
  const app = { ...APP, slug: 'todo' };
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app, item: { id: 32, app_id: 9, issue_number: 12, priority: 1, reason: 'new', thread_seen_at: null },
    mode: 'shadow', settings: { ...SETTINGS, pausedApps: ['todo'] }, deps,
  });
  assert.equal(out.reason, 'refused');
  assert.equal(out.detail, 'session_busy');
  assert.equal(bot.faultBackoff(), null);
  assert.ok(!queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)));
});

test('turnRunningOn: whatever holds the session in this process, its executing worker, or a turn on its row', async () => {
  const pool = (activeTurn) => ({ async query() { return { rows: [{ active_turn: activeTurn }] }; } });
  const worker = (inFlight) => ({ isInFlight: () => inFlight });
  const session = { id: 5001 };
  assert.equal(await followup.turnRunningOn({ pool: pool(null), session, worker: worker(false), activeWorkers: new Set() }), false);
  assert.equal(await followup.turnRunningOn({ pool: pool(null), session, worker: worker(false), activeWorkers: new Set([5001]) }), true);
  assert.equal(await followup.turnRunningOn({ pool: pool(null), session, worker: worker(true), activeWorkers: new Set() }), true);
  assert.equal(await followup.turnRunningOn({ pool: pool({ turnId: 'x' }), session, worker: worker(false), activeWorkers: new Set() }), true);
  const release = require('../src/services/active-workers').beginSessionOperation(5001);
  try {
    assert.equal(await followup.turnRunningOn({ pool: pool(null), session, worker: worker(false), activeWorkers: new Set() }), true,
      'a sync with main holds its session as an operation before it asks for its worker');
  } finally { release(); }
  const down = { async query() { throw new Error('db down'); } };
  assert.equal(await followup.turnRunningOn({ pool: down, session, worker: worker(false), activeWorkers: new Set() }), false,
    'an unreadable row is no reason to wait: the turn\'s own start still refuses a busy session');
});

// ── 1. The turn's record carries its deadline ───────────────────────────

test('a fix turn marks its record as the bot\'s, with its deadline and what recovery needs, before the agent starts', async (t) => {
  const h = harness();
  const before = Date.now();
  const out = await triage(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(h.calls.stamps.length, 1, 'stamped once, on the attempt\'s record');
  const stampAt = h.calls.queries.findIndex((q) => /jsonb_set\(active_turn, ARRAY\[\$3::text\]/.test(q.s));
  assert.ok(stampAt >= 0 && h.calls.exec.length === 1, 'and the agent ran after it');
  const [sessionId, turnId, key, value] = h.calls.stamps[0];
  assert.deepEqual([sessionId, turnId, key], [5001, TURN_ID, followup.TURN_MARK]);
  const mark = JSON.parse(value);
  const deadline = Date.parse(mark.deadlineAt);
  assert.ok(deadline >= before + SETTINGS.turnSeconds * 1000 && deadline <= Date.now() + SETTINGS.turnSeconds * 1000,
    'its deadline is its live clock\'s: start plus the turn budget');
  assert.equal(mark.followUp, 'checks_fix');
  assert.deepEqual([mark.appId, mark.issueNumber, mark.queueId, mark.reason], [9, 50, 31, bot.CHECKS_REASON]);
  assert.equal(mark.reviewedHeadSha, HEAD, 'the head it started from');
  assert.deepEqual(mark.checks, { head: HEAD, total: 85, failing: 1, broken: [] });
  assert.equal(mark.threadSeenAt, SEEN);
  assert.equal(mark.runMode, 'live', 'recorded as the live run it is');
  assert.ok(followup.turnMarkOf({ [followup.TURN_MARK]: mark }), 'and it reads back as the bot\'s mark');
});

test('stampTurn writes one owner key on the exact turn and never a field the lifecycle owns', async () => {
  const asked = [];
  const db = { async query(sql, params) { asked.push({ sql, params }); return { rows: [{ id: 1 }], rowCount: 1 }; } };
  assert.equal(await turnLifecycle.stampTurn(db, { sessionId: 7, turnId: 'turn-1', key: 'homeroomBotFollowUp', value: { a: 1 } }), true);
  assert.match(asked[0].sql, /active_turn->>'turnId' = \$2/, 'compare-and-set on the turn');
  assert.deepEqual(asked[0].params, [7, 'turn-1', 'homeroomBotFollowUp', '{"a":1}']);
  for (const key of ['phase', 'turnId', 'startedAt', 'mode', 'tail', 'restarts', 'stopRequestedAt', 'Bad', '']) {
    await assert.rejects(turnLifecycle.stampTurn(db, { sessionId: 7, turnId: 'turn-1', key, value: 1 }), /not a key/, key);
  }
  await assert.rejects(turnLifecycle.stampTurn(db, { sessionId: 7, turnId: null, key: 'homeroomBotFollowUp', value: 1 }), /turnId required/);
  const missed = { async query() { return { rows: [], rowCount: 0 }; } };
  assert.equal(await turnLifecycle.stampTurn(missed, { sessionId: 7, turnId: 'turn-1', key: 'homeroomBotFollowUp', value: 1 }), false,
    'a turn that no longer holds the session is not stamped');
});

test('the recovery deadline is the mark\'s, given back the time restarts cost it; only the bot\'s own follow-up has one', async () => {
  const deadlineAt = '2026-10-09T15:48:00.000Z';
  const mark = { followUp: 'checks_fix', deadlineAt, appId: 9, issueNumber: 50 };
  const turn = { turnId: TURN_ID, mode: 'build', startedAt: '2026-10-09T15:28:00.000Z', [followup.TURN_MARK]: mark };
  const pool = { async query() { throw new Error('a follow-up\'s deadline needs no lookup'); } };
  assert.equal(await bot.recoveryDeadline(pool, {}, { id: 5001 }, turn), Date.parse(deadlineAt));
  assert.equal(await bot.recoveryDeadline(pool, {}, { id: 5001 }, { ...turn, restarts: 3 }), Date.parse(deadlineAt) + 3 * bot.RESTART_ALLOWANCE_MS);

  const botSession = { username: 'homeroom_bot', user_is_synthetic: true, status: 'promoted', active_turn: turn };
  assert.equal(bot.isRecoveredBotFollowUp(botSession), true);
  assert.equal(bot.isRecoveredBotSession(botSession), false, 'still the person\'s tail: a promoted proposal\'s PR and staging move on');
  const { [followup.TURN_MARK]: _mark, ...unmarked } = turn;
  assert.equal(bot.isRecoveredBotFollowUp({ ...botSession, active_turn: unmarked }), false,
    'a person\'s turn on the bot\'s proposal carries no mark, so the bot\'s clock never stops it');
  assert.equal(bot.isRecoveredBotFollowUp({ ...botSession, username: 'ada', user_is_synthetic: false }), false,
    'and a person\'s own proposal never is the bot\'s');
  assert.equal(bot.isRecoveredBotFollowUp({ ...botSession, active_turn: { ...turn, [followup.TURN_MARK]: { ...mark, deadlineAt: 'soon' } } }), false);
  assert.equal(followup.turnMarkOf({ [followup.TURN_MARK]: { ...mark, followUp: 'build' } }), null);
  assert.equal(followup.turnMarkOf(null), null);
});

test('server.js re-arms the clock for a marked follow-up and records it after the person\'s tail', () => {
  const server = read('server.js');
  assert.match(server, /const botFollowUp = !benchTurn && !botTurn && homeroomBotRecovery\(\)\.isRecoveredBotFollowUp\(session, activeTurn\);/);
  assert.match(server, /if \(botTurn \|\| benchTurn \|\| botFollowUp\) \{\n\s+const restarts = await turnLifecycle\.noteRestart/);
  // Recorded once the tail has moved the proposal on, before the wrap-up.
  const tail = server.indexOf('const { outcome: finalizeOutcome, summary } = await finalizeRecoveredTurn({');
  const record = server.indexOf('await homeroomBotRecovery().finishRecoveredFollowUp({');
  const wrapUp = server.indexOf('// #896: re-issue the Mayor\'s phase-2 wrap-up.');
  assert.ok(tail > 0 && record > tail && wrapUp > record);
  assert.match(server.slice(record, record + 200), /pool, config, session, activeTurn, result, timedOut: botTimedOut,/);
  // A read-only follow-up's answer is never published as the proposal's spec.
  assert.match(server, /if \(botFollowUp && recoveryActiveTurn\.mode === 'scout'\) \{[\s\S]{0,400}?terminalLine = '\[done\]';\n\s+\} else if \(recoveryActiveTurn\.mode === 'scout'\) \{/);
});

// ── 2. A recovered follow-up's outcome reaches the ledger ───────────────

function recoveryPool({ effectState = null, reviewedHead = NEW_HEAD } = {}) {
  const calls = { queries: [], inserted: [], effects: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/INSERT INTO turn_effects/.test(s)) {
        calls.effects.push(params);
        return effectState ? { rows: [], rowCount: 0 } : { rows: [{ state: 'pending' }], rowCount: 1 };
      }
      if (/SELECT state, result FROM turn_effects/.test(s)) return { rows: [{ state: effectState, result: null }] };
      if (/UPDATE turn_effects/.test(s)) return { rows: [{ result: params[2] }], rowCount: 1 };
      if (/FROM apps WHERE id = \$1/.test(s)) return { rows: [APP] };
      if (/FROM agent_turns WHERE logical_turn_id = \$1::uuid/.test(s)) return { rows: [{ cost: 0.31, input_tokens: 41000, output_tokens: 2100 }] };
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) {
        // The person's tail has made the push the reviewed head already.
        return { rows: [{ id: 5001, user_id: 77, app_id: 9, status: 'promoted', branch_name: 'dev/homeroom_bot-5001', pr_number: 82, reviewed_head_sha: reviewedHead, app_slug: APP.slug, repo_url: APP.repo_url }] };
      }
      if (/SELECT id, thread_seen_at FROM homeroom_bot_runs/.test(s)) return { rows: [{ id: 800, thread_seen_at: SEEN }] };
      if (/COUNT\(\*\)::int AS n FROM homeroom_bot_runs/.test(s)) return { rows: [{ n: 0 }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) { calls.inserted.push(params); return { rows: [{ id: 902 }] }; }
      return { rows: [] };
    },
  };
  return { pool, calls };
}

function recoveredTurn(kind = 'checks_fix', extra = {}) {
  return {
    turnId: TURN_ID, logicalTurnId: TURN_ID, mode: 'build', startedAt: '2026-10-09T15:28:00.000Z',
    [followup.TURN_MARK]: {
      followUp: kind, deadlineAt: '2026-10-09T15:48:00.000Z', appId: 9, issueNumber: 50, queueId: 31,
      reason: kind === 'checks_fix' ? bot.CHECKS_REASON : 'changed', payerUserId: null, changedBy: null,
      runMode: 'live', model: 'z-ai/glm-5.3', startedAt: '2026-10-09T15:28:00.000Z',
      seedReadAt: '2026-10-09T15:27:59.000Z', threadSeenAt: SEEN, reviewedHeadSha: HEAD,
      ...(kind === 'checks_fix' ? { checks: { head: HEAD, total: 85, failing: 1, broken: [] } } : { onProposal: true }),
      ...extra,
    },
  };
}

function recoveryDeps(calls) {
  calls.reconciled = [];
  calls.posts = [];
  calls.onProposal = [];
  return {
    github: {
      async fetchPublicIssue() { return { issue: { number: 50, title: 'Bigger text', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
      getBotUsername: async () => 'usernode-bot',
    },
    threadContext: { async loadIssueThread() { return { messages: [] }; }, async loadProposalThread() { return { messages: [] }; } },
    limits: { async recordSpend(_p, _id, cents) { calls.spend = cents; } },
    managedOpenRouter: { async usesIncludedKey() { return true; } },
    agentTurn: { estimateRequestedModelCost: () => ({ estimatedCostUsd: null }) },
    votes: { async reconcileNativeReviewedHead(args) { calls.reconciled.push(args); } },
    ws: {}, sessionLifecycle: {}, domain: 'app.onhomeroom.com',
  };
}

async function withPosts(t, calls, fn) {
  const real = { post: live.post, seen: live.advanceSeen, onProposal: live.postOnProposal, targets: live.mentionTargets, login: live.botUsernameOf };
  t.after(() => Object.assign(live, {
    post: real.post, advanceSeen: real.seen, postOnProposal: real.onProposal, mentionTargets: real.targets, botUsernameOf: real.login,
  }));
  live.post = async (args) => { calls.posts.push(args); return { githubCreatedAt: '2026-10-09T16:00:00Z' }; };
  live.postOnProposal = async (args) => { calls.onProposal.push(args); return { postId: 1 }; };
  live.advanceSeen = async () => ({ advanced: true });
  live.mentionTargets = async () => [];
  live.botUsernameOf = async () => 'usernode-bot';
  return fn();
}

const SESSION = { id: 5001, user_id: 77, username: 'homeroom_bot', user_is_synthetic: true, status: 'promoted' };

test('a recovered fix that pushed is a revise run on the head it looked at, with its cost, said where a live one is', async (t) => {
  const { pool, calls } = recoveryPool();
  const deps = recoveryDeps(calls);
  const out = await withPosts(t, calls, () => bot.finishRecoveredFollowUp({
    pool, session: SESSION, activeTurn: recoveredTurn(), timedOut: false, deps,
    result: {
      lastResultText: '```json\n{"action":"revise","reply":"Renamed the control.","summary":"The text-size button now says \\"Text size\\"."}\n```',
      pushOk: true, sha: NEW_HEAD, ahead: 1,
    },
  }));
  assert.equal(out, 'checks_revise');
  assert.equal(calls.inserted.length, 1, 'one run');
  const run = calls.inserted[0];
  assert.equal(run[4], 'revise', 'counted toward MAX_REVISIONS like any revision');
  assert.equal(run[20], 5001, 'on its proposal');
  assert.equal(run[21], HEAD, 'the failing head it looked at, so it is not looked at again');
  assert.ok(Math.abs(run[14] - 0.31) < 1e-9, 'what its own attempts cost, from the ledger');
  assert.deepEqual([run[15], run[16]], [41000, 2100]);
  assert.equal(run[12], SEEN, 'what it had seen of the issue when it began');
  assert.equal(run[3], 'live');
  assert.equal(calls.spend, 31, 'debited from the bot\'s allowance as a live turn is');
  assert.equal(calls.onProposal.length, 1);
  assert.equal(calls.onProposal[0].kind, 'checks_revise');
  assert.match(calls.onProposal[0].text, /fixed the failing checks on this change: The text-size button now says "Text size"\./);
  assert.equal(calls.reconciled.length, 0, 'the person\'s tail reset the votes and rebuilt staging already');
  assert.ok(calls.queries.some((q) => /DELETE FROM homeroom_bot_queue WHERE id = \$1/.test(q.s) && q.params[0] === 31), 'its queue row is spent');
  assert.ok(calls.queries.some((q) => /UPDATE homeroom_bot_queue SET wait_reason = NULL, wait_until = NULL WHERE app_id = \$1 AND issue_number = \$2/.test(q.s)));
  assert.deepEqual(calls.effects[0].slice(0, 3), [TURN_ID, bot.RECOVERED_FOLLOWUP_EFFECT, 5001], 'claimed for this turn');
  assert.ok(calls.queries.some((q) => /UPDATE turn_effects/.test(q.s)), 'and settled');
});

test('a recovered fix its clock stopped is handed to a person as having run out of time, on the head it looked at', async (t) => {
  const { pool, calls } = recoveryPool({ reviewedHead: HEAD });
  const deps = recoveryDeps(calls);
  const out = await withPosts(t, calls, () => bot.finishRecoveredFollowUp({
    pool, session: SESSION, activeTurn: recoveredTurn(), timedOut: true, deps,
    result: { exitCode: 143, pushOk: false, ahead: 0 },
  }));
  assert.equal(out, 'checks_person');
  const run = calls.inserted[0];
  assert.equal(run[4], 'failed');
  assert.equal(run[18], 'checks: its attempt to fix them ran out of time');
  assert.equal(run[19], 'wall clock');
  assert.equal(run[21], HEAD);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].kind, 'followup_person');
  assert.match(calls.posts[0].text, /can't get this change past its checks on its own: 1 check is still failing/);
});

test('a fix that finished before the restart is not one that ran out of time, though its re-armed clock fired', async (t) => {
  const { pool, calls } = recoveryPool();
  const deps = recoveryDeps(calls);
  // Its journal ended on its own exit 0; the clock, past its deadline by
  // the time the new server read it, fired at once anyway.
  const out = await withPosts(t, calls, () => bot.finishRecoveredFollowUp({
    pool, session: SESSION, activeTurn: recoveredTurn(), timedOut: true, deps,
    result: {
      exitCode: 0, pushOk: true, sha: NEW_HEAD, ahead: 1,
      lastResultText: '```json\n{"action":"revise","reply":"Renamed.","summary":"It says Text size."}\n```',
    },
  }));
  assert.equal(out, 'checks_revise');
  assert.equal(calls.inserted[0][4], 'revise');
  assert.equal(calls.inserted[0][19], null, 'no budget stop');
});

test('a recovered answer to replies is answered where they were, and recorded as the answer it is', async (t) => {
  const { pool, calls } = recoveryPool({ reviewedHead: HEAD });
  const deps = recoveryDeps(calls);
  const out = await withPosts(t, calls, () => bot.finishRecoveredFollowUp({
    pool, session: SESSION, activeTurn: recoveredTurn('reply'), timedOut: false, deps,
    result: { lastResultText: '```json\n{"action":"answer","reply":"It keeps your list."}\n```', pushOk: true, sha: HEAD },
  }));
  assert.equal(out, 'followup_answer');
  assert.equal(calls.inserted[0][4], 'answer');
  assert.equal(calls.inserted[0][21], null, 'an answer looked at no failing head');
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].proposalSessionId, 5001, 'in the proposal\'s discussion, where they asked');
  assert.match(calls.posts[0].text, /It keeps your list\./);
});

test('a recovered follow-up is recorded once, however often its recovery is replayed, and never throws', async (t) => {
  const { pool, calls } = recoveryPool({ effectState: 'completed' });
  const deps = recoveryDeps(calls);
  const out = await withPosts(t, calls, () => bot.finishRecoveredFollowUp({
    pool, session: SESSION, activeTurn: recoveredTurn(), result: { pushOk: true, sha: NEW_HEAD }, deps,
  }));
  assert.equal(out, 'already_recorded');
  assert.equal(calls.inserted.length, 0);
  assert.equal(calls.posts.length + calls.onProposal.length, 0);
  assert.equal(await bot.finishRecoveredFollowUp({ pool, session: SESSION, activeTurn: { turnId: TURN_ID, mode: 'build' } }), null,
    'a turn without the bot\'s mark is not the bot\'s to record');
  const broken = { async query() { throw new Error('db down'); } };
  assert.equal(await bot.finishRecoveredFollowUp({ pool: broken, session: SESSION, activeTurn: recoveredTurn(), deps }), 'error');
});

// ── 4. The wait, where people look ──────────────────────────────────────

test('queueWait: its own refusal, then its payer\'s week, then the bot\'s fault pause; a wait that is over is none', () => {
  const now = Date.parse('2026-10-09T16:30:00Z');
  const later = '2026-10-09T16:40:00.000Z';
  assert.deepEqual(bot.queueWait({ wait_reason: 'session_busy', wait_until: later }, { now }), { reason: 'session_busy', until: later });
  assert.equal(bot.queueWait({ wait_reason: 'session_busy', wait_until: '2026-10-09T16:20:00Z' }, { now }), null);
  assert.equal(bot.queueWait({ started_at: '2026-10-09T16:29:00Z', wait_reason: 'session_busy', wait_until: later }, { now }), null,
    'a running row is not waiting');
  assert.deepEqual(bot.queueWait({ held_until: later }, { now }), { reason: 'allowance', until: later });
  assert.deepEqual(bot.queueWait({}, { now, fault: { until: Date.parse(later) } }), { reason: 'platform_fault', until: later });
  assert.equal(bot.queueWait({}, { now }), null);
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /q\.held_until, q\.wait_reason, q\.wait_until,\n\s+a\.slug AS app_slug/);
  assert.match(src, /const queueRows = queued\.map\(\(q\) => \(\{ \.\.\.q, waiting: queueWait\(q, \{ fault \}\) \}\)\);/);
  assert.match(read('src/db/schema.sql'), /ALTER TABLE homeroom_bot_queue ADD COLUMN IF NOT EXISTS wait_reason TEXT;\nALTER TABLE homeroom_bot_queue ADD COLUMN IF NOT EXISTS wait_until TIMESTAMPTZ;/);
});

test('get_homeroom_bot\'s queue items carry the wait as a code and a time', async () => {
  const data = require('../src/services/bench/connector-data');
  const fake = {
    adminPayload: async () => ({
      settings: {}, bot: null, totals: {}, runs: [],
      queue: { depth: 2, items: [
        { app_slug: 'recipebot', issue_number: 50, reason: 'checks_failing', enqueued_at: '2026-10-09T16:00:00Z', waiting: { reason: 'session_busy', until: '2026-10-09T16:40:00Z' } },
        { app_slug: 'recipebot', issue_number: 51, reason: 'new', enqueued_at: '2026-10-09T16:01:00Z', waiting: { reason: 'Not a code!', until: '2026-10-09T16:40:00Z' } },
        { app_slug: 'recipebot', issue_number: 52, reason: 'new', enqueued_at: '2026-10-09T16:02:00Z', waiting: null },
      ] },
    }),
  };
  const out = await data.botOverview(null, {}, {}, { bot: fake });
  assert.deepEqual(out.queue.items.map((i) => i.waiting), [
    { reason: 'session_busy', until: '2026-10-09T16:40:00.000Z' }, null, null,
  ]);
  assert.match(read('src/services/mcp-tools.js'), /the queue \(each item\\'s waiting, when it waits: why, session_busy for a turn running on its session/);
});

test('the console\'s queue says why a row waits and until when', () => {
  globalThis.window = globalThis.window || globalThis;
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { QueueItems, waitLine } = loadTsx('frontend/src/features/admin/admin-homeroom-bot.tsx', {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, {
          get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)),
        }),
      },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
  const until = '2026-10-09T16:40:00Z';
  assert.match(waitLine({ reason: 'session_busy', until }), /^waiting: a turn is running on its session, until \S/);
  assert.match(waitLine({ reason: 'allowance', until }), /^waiting: its payer's week is used up, until /);
  assert.match(waitLine({ reason: 'platform_fault', until }), /^waiting: the bot is backing off a platform fault, until /);
  assert.match(waitLine({ reason: 'something_new', until: null }), /^waiting: something new$/);
  assert.equal(waitLine(null), '');
  const html = renderToHtml(createElement(QueueItems, { items: [
    { id: 1, issue_number: 50, priority: 1, reason: 'checks_failing', enqueued_at: '', started_at: null, app_slug: 'r', app_name: 'RecipeBot', waiting: { reason: 'session_busy', until } },
    { id: 2, issue_number: 51, priority: 1, reason: 'new', enqueued_at: '', started_at: null, app_slug: 'r', app_name: 'RecipeBot', waiting: null },
  ] }));
  assert.match(html, /id="admin-homeroom-bot-queue"/);
  assert.match(html, /<span>RecipeBot<\/span><span class="muted">#50<\/span><span class="muted" data-queue-waiting="session_busy">waiting: a turn is running on its session, until /);
  assert.match(html, /<span>RecipeBot<\/span><span class="muted">#51<\/span><\/li>/, 'a row next in line says nothing more');
  assert.match(renderToHtml(createElement(QueueItems, { items: [] })), /Nothing queued\./);
});

test('get_change says when the running turn started and what kind it is', async () => {
  const tools = require('../src/services/mcp-tools');
  const shape = (live) => tools.shapeChange({ id: 7428, app_slug: 'homeroom', status: 'promoted', branch_name: 'b' }, live, '', 'external');
  assert.deepEqual(shape({ busy: true, turn: { startedAt: '2026-10-09T16:20:00Z', kind: 'sync' } }).runningTurn,
    { startedAt: '2026-10-09T16:20:00.000Z', kind: 'sync' });
  assert.deepEqual(shape({ busy: true, turn: { startedAt: 'never', kind: 'Not a code' } }).runningTurn, { startedAt: null, kind: null });
  assert.equal(shape({ busy: false, turn: null }).runningTurn, null);
  assert.equal(shape(null).runningTurn, null);
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /const mark = require\('\.\.\/services\/homeroom-bot-followup'\)\.turnMarkOf\(durableTurn\);\n\s+turn = \{\n\s+startedAt: durableTurn\.startedAt \|\| null,\n\s+kind: mark \? `homeroom_bot_\$\{mark\.followUp\}` : \(durableTurn\.mode \|\| null\),/);
  assert.match(sessions, /busy, progress, phase, stopping, stopRequestedAt, stoppable, estimate, turn,/);
});

// #4575: the bot's build and review-fix turns on a session wait for a
// before & after shots run under way there, bounded, as the Mayor's do.
test('a bot turn waits out the shots run on its session, at most its bound', async () => {
  assert.equal(await live.waitOutShotsRun(5001, { shotsRunFor: () => null }), 'idle');
  let finish;
  const run = new Promise((resolve) => { finish = resolve; });
  const waiting = live.waitOutShotsRun(5001, { shotsRunFor: () => run, shotsWaitMs: 60_000 });
  finish();
  assert.equal(await waiting, 'finished');
  // A failed run is over too.
  assert.equal(await live.waitOutShotsRun(5001, {
    shotsRunFor: () => Promise.reject(new Error('shots failed')), shotsWaitMs: 60_000,
  }), 'finished');
  assert.equal(await live.waitOutShotsRun(5001, {
    shotsRunFor: () => new Promise(() => {}), shotsWaitMs: 5,
  }), 'timeout');
  // The runner calls it before its turn's clock starts.
  assert.match(read('src/services/homeroom-bot-live.js'),
    /await waitOutShotsRun\(session\.id, deps\);\n {4}let turnStopped = false;/);
});
