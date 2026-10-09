'use strict';

// #4533: a checks fix a deploy caught keeps its time limit, and what it did
// reaches the bot's ledger, against the FULL PostgreSQL schema and through
// server.js's own restart recovery.
//
// PR #4533 (change 7428, request #4524), 9 Oct 2026: the bot's checks fix
// on its own PROMOTED proposal ran 38 minutes against its 20. Its clock was
// a timer in the process the deploy replaced, and recovery followed the turn
// through the person's tail (a promoted proposal is not
// isRecoveredBotSession's, on purpose), which re-arms no clock. Its push
// landed, and the ledger had no run for it: no checks_revise post, no cost,
// and nothing for MAX_REVISIONS or "already looked at this head" to count.
//
// The worker is stubbed (the journal runs until a clock stops it, or ends on
// its own); the session, its turn record and restart count, the ledger rows,
// the queue and the turn_effects receipt are real.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
process.env.DATABASE_URL = process.env.DATABASE_URL || DSN;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

// ── worker stub: the fix's agent, still running in its worker ───────────
let journalTail = async () => ({});
let onStop = null;
const stops = [];
const stopTimes = [];
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  usesKubernetesWorkers: () => false,
  resumeTurnFromJournal: async (sessionId, opts) => journalTail(sessionId, opts),
  stopTurn: async (sessionId) => { stops.push(sessionId); stopTimes.push(Date.now()); onStop?.(); return true; },
  finishTurn: async () => true,
  markTurnTail: async () => true,
  noteTailMilestone: async () => true,
  clearActiveTurn: async () => true,
  adoptWarmWorker: () => {},
  destroyWorker: async () => {},
  isWorkerExecuting: async () => true,
  getTurnByokCents: () => 0,
};
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
const live = require('../src/services/homeroom-bot-live');
const github = require('../src/services/github');
const agentTurn = require('../src/services/agent-turn');
const sessionsRoutes = require('../src/routes/sessions');
const managedKeys = require('../src/services/openrouter-managed-keys');

// The ledger attempt and the agent thread are settled as for any recovered
// turn, and the Mayor's wrap-up is the person's tail's: covered elsewhere.
agentTurn.persistRecoveredAgentThread = async () => {};
agentTurn.settleRecoveredAgentAttempt = async () => null;
sessionsRoutes.resumeRecoveredCodexFreshRetry = async () => null;
const wrapUps = [];
sessionsRoutes.runRecoveredWrapUp = async (args) => { wrapUps.push(args.sessionId); };
managedKeys.usesIncludedKey = async () => false;

const ALLOWANCE_MS = bot.RESTART_ALLOWANCE_MS;
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
// What the fix's clock has left when the deploy's server takes it. The
// adoption reads the clock only after its own queries; a few seconds keep a
// loaded suite from reading nothing left (see the build's own restart test).
const CLOCK_LEFT_MS = 5000;
// Still working when a clock stops it, or done on its own after `endMs`
// (before #4533 nothing stopped it: there, it ran on to its own end).
const untilStopped = (endMs = 15_000) => new Promise((resolve) => {
  onStop = () => resolve({ exitCode: 143, pushOk: false, ahead: 0 });
  setTimeout(() => resolve({ exitCode: 0, pushOk: false, ahead: 0, lastResultText: 'ran on' }), endMs);
});

test('a checks fix a restart caught keeps its deadline, and its outcome reaches the ledger', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_followup_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const real = {
    post: live.post, postOnProposal: live.postOnProposal, mentionTargets: live.mentionTargets,
    botUsernameOf: live.botUsernameOf, advanceSeen: live.advanceSeen, fetchPublicIssue: github.fetchPublicIssue,
  };
  t.after(async () => {
    Object.assign(live, {
      post: real.post, postOnProposal: real.postOnProposal, mentionTargets: real.mentionTargets,
      botUsernameOf: real.botUsernameOf, advanceSeen: real.advanceSeen,
    });
    github.fetchPublicIssue = real.fetchPublicIssue;
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  const posts = [];
  const onProposal = [];
  live.post = async (args) => { posts.push(args); return { postId: posts.length }; };
  live.postOnProposal = async (args) => { onProposal.push(args); return { postId: onProposal.length }; };
  live.mentionTargets = async () => [];
  live.botUsernameOf = async () => 'usernode-bot';
  live.advanceSeen = async () => ({ advanced: true });
  github.fetchPublicIssue = async (_o, _r, n) => ({ issue: { number: n, title: `Request ${n}`, state: 'open' } });

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Homeroom', 'homeroom-4533', 'running', $1)
     RETURNING id, slug, name, repo_url`,
    ['https://github.com/usernode-bot/homeroom-4533'],
  );
  const failing = [{ name: 'Proposal page shows the vote card', path: '/#p', status: 'fail', failureReason: 'expected "Vote"' }]
    .concat(Array.from({ length: 40 }, (_, i) => ({ name: `check ${i}`, path: '/', status: 'pass' })));

  // The bot's promoted proposal, its checks failing on HEAD, its queue row
  // (released by the stale-claim sweep and waiting behind the busy session),
  // and a turn in flight whose deadline is `deadlineMs`. `mark: false` is a
  // turn without the bot's mark: a person's, as far as recovery can tell.
  const proposal = async (issueNumber, deadlineMs, { mark = true, startedAt = new Date(Date.now() - 19 * 60_000) } = {}) => {
    const turnId = crypto.randomUUID();
    // What runFollowUpTurn keeps on the record (homeroom-bot.js followUpMark),
    // written out so the record's shape is pinned here too.
    const markValue = {
      followUp: 'checks_fix', appId: app.id, issueNumber, reason: bot.CHECKS_REASON, payerUserId: null, changedBy: null,
      runMode: 'live', model: 'z-ai/glm-5.3', startedAt: startedAt.toISOString(), seedReadAt: startedAt.toISOString(),
      threadSeenAt: '2026-10-09T10:00:00Z', reviewedHeadSha: HEAD,
      checks: { head: HEAD, total: failing.length, failing: 1, broken: [] },
    };
    const activeTurn = {
      turnId, logicalTurnId: turnId, turnUuid: crypto.randomUUID(), journal: `/journals/${turnId}.log`, phase: 'executing',
      mode: 'build', backend: 'codex_openrouter', model: 'z-ai/glm-5.3', startedAt: startedAt.toISOString(), attemptNumber: 1,
    };
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, pr_number,
                                  reviewed_head_sha, checks_commit_sha, check_state, test_results, active_turn)
       VALUES ($1, $2, $3, 'promoted', FALSE, $4, $5, $6, $6, 'failing', $7, $8) RETURNING id`,
      [app.id, botUser.id, `dev/homeroom_bot-${issueNumber}`, [issueNumber], 4500 + issueNumber, HEAD,
        JSON.stringify(failing), JSON.stringify(activeTurn)],
    );
    const { rows: [q] } = await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, wait_reason, wait_until)
       VALUES ($1, $2, 1, $3, 'session_busy', NOW() + INTERVAL '1 hour') RETURNING id`,
      [app.id, issueNumber, bot.CHECKS_REASON],
    );
    if (mark) {
      // As runFollowUpTurn stamps it (turn-lifecycle stampTurn), the queue
      // row its pass claimed included.
      await pool.query(
        `UPDATE chat_sessions SET active_turn = jsonb_set(active_turn, '{homeroomBotFollowUp}', $2::jsonb, true) WHERE id = $1`,
        [s.id, JSON.stringify({ ...markValue, queueId: q.id, deadlineAt: new Date(deadlineMs).toISOString() })],
      );
    }
    // What its attempt cost, as the ledger settled it.
    await pool.query(
      `INSERT INTO agent_turns (id, session_id, user_id, backend, status, logical_turn_id, estimated_cost_usd, input_tokens, output_tokens)
       VALUES ($1, $2, $3, 'codex_openrouter', 'completed', $4, 0.31, 41000, 2100)`,
      [activeTurn.turnUuid, s.id, botUser.id, turnId],
    );
    const { rows: [withTurn] } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [s.id]);
    return { sessionId: s.id, turnId, queueId: q.id, activeTurn: withTurn.active_turn };
  };
  const recover = (sessionId) => adoptOrphanWorker(
    { name: `usernode-worker-${sessionId}`, sessionId, state: 'running' },
    { config: {}, pool, staging: {}, ghub: {}, broadcastGlobal: () => {} },
  );
  const runsOf = async (sessionId) => (await pool.query(
    `SELECT verdict, error, budget_stop, checks_head_sha, cost_usd::float8 AS cost_usd, input_tokens, session_id, proposal_session_id
       FROM homeroom_bot_runs WHERE proposal_session_id = $1 ORDER BY id`,
    [sessionId],
  )).rows;
  const effectOf = async (turnId) => (await pool.query(
    'SELECT state, result FROM turn_effects WHERE turn_id = $1 AND effect_key = $2', [turnId, bot.RECOVERED_FOLLOWUP_EFFECT],
  )).rows[0] || null;

  await t.test('PR #4533: the fix is stopped at its own deadline, with the restart\'s time given back, and recorded as the bot records one', async () => {
    // Its deadline less the time this restart gives back is CLOCK_LEFT_MS
    // away: stopped then, not at once and not 38 minutes later.
    const { sessionId, turnId, queueId } = await proposal(4524, Date.now() - ALLOWANCE_MS + CLOCK_LEFT_MS);
    assert.ok(await bot.checksToFix(pool, sessionId), 'its failing head is still due before');
    let followedAt = 0;
    journalTail = async () => { followedAt = Date.now(); return untilStopped(); };
    stops.length = 0; stopTimes.length = 0; posts.length = 0; wrapUps.length = 0;
    const t0 = Date.now();
    await recover(sessionId);
    assert.deepEqual(stops, [sessionId], 'the bot\'s clock ended the turn');
    assert.ok(stopTimes[0] - followedAt >= 2000, `followed until its deadline, not stopped at once (${stopTimes[0] - followedAt} ms)`);
    assert.ok(Date.now() - t0 < 60_000, 'at its own deadline: no fresh budget');

    assert.deepEqual(await runsOf(sessionId), [{
      verdict: 'failed', error: 'checks: its attempt to fix them ran out of time', budget_stop: 'wall clock',
      checks_head_sha: HEAD, cost_usd: 0.31, input_tokens: '41000', session_id: sessionId, proposal_session_id: sessionId,
    }], 'one run, on the head it looked at, with what it cost');
    assert.equal(await bot.checksToFix(pool, sessionId), null, 'and that head counts as looked at');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].kind, 'followup_person');
    assert.equal(posts[0].proposalSessionId, sessionId);
    assert.equal((await pool.query('SELECT 1 FROM homeroom_bot_queue WHERE id = $1', [queueId])).rows.length, 0, 'its queue row is spent');
    assert.equal((await effectOf(turnId))?.state, 'completed');
    assert.deepEqual(wrapUps, [sessionId], 'the person\'s tail still ran, as before');
  });

  await t.test('a turn without the bot\'s mark on the same kind of proposal is never stopped on the bot\'s clock', async () => {
    // Started two hours ago: any bot clock would have ended it long since.
    const { sessionId } = await proposal(4600, Date.now() - 60 * 60_000, { mark: false, startedAt: new Date(Date.now() - 2 * 3600_000) });
    journalTail = () => new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, pushOk: false, ahead: 0 }), 1500));
    stops.length = 0; posts.length = 0;
    await recover(sessionId);
    assert.deepEqual(stops, [], 'followed to its own end');
    assert.deepEqual(await runsOf(sessionId), [], 'and nothing of the bot\'s recorded for it');
    assert.equal(posts.length, 0);
  });

  await t.test('a fix that pushed is a revise run counted toward the cap, once however often recovery replays', async () => {
    const { sessionId, turnId, activeTurn } = await proposal(4601, Date.now() + 60_000);
    // The person's tail has made the push the reviewed head (vote-revision).
    await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [sessionId, NEW_HEAD]);
    const { rows: [session] } = await pool.query(
      `SELECT cs.*, u.username, u.is_synthetic AS user_is_synthetic FROM chat_sessions cs JOIN users u ON u.id = cs.user_id WHERE cs.id = $1`,
      [sessionId],
    );
    assert.equal(bot.isRecoveredBotFollowUp(session), true);
    onProposal.length = 0;
    const result = {
      lastResultText: '```json\n{"action":"revise","reply":"Fixed the label.","summary":"The vote card says Vote again."}\n```',
      pushOk: true, sha: NEW_HEAD, ahead: 1,
    };
    assert.equal(await bot.finishRecoveredFollowUp({ pool, session, activeTurn, result }), 'checks_revise');
    const runs = await runsOf(sessionId);
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0].verdict, runs[0].checks_head_sha, runs[0].cost_usd], ['revise', HEAD, 0.31]);
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM homeroom_bot_runs WHERE proposal_session_id = $1 AND verdict = 'revise'`, [sessionId],
    );
    assert.equal(n, 1, 'MAX_REVISIONS sees it');
    assert.equal(onProposal.length, 1);
    assert.equal(onProposal[0].kind, 'checks_revise');
    assert.equal(await bot.finishRecoveredFollowUp({ pool, session, activeTurn, result }), 'already_recorded');
    assert.equal((await runsOf(sessionId)).length, 1, 'never twice');
    assert.equal(onProposal.length, 1);
    assert.deepEqual((await effectOf(turnId)).result, { outcome: 'checks_revise', runId: (await pool.query(
      'SELECT id FROM homeroom_bot_runs WHERE proposal_session_id = $1', [sessionId],
    )).rows[0].id });
  });

  await t.test('the console and the connector show a queued row waiting on its busy session, and until when', async () => {
    await pool.query('DELETE FROM homeroom_bot_queue');
    const until = new Date(Date.now() + 40 * 60_000);
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, wait_reason, wait_until)
       VALUES ($1, 4602, 1, $2, 'session_busy', $3), ($1, 4603, 2, 'new', 'session_busy', NOW() - INTERVAL '1 minute')`,
      [app.id, bot.CHECKS_REASON, until],
    );
    const payload = await bot.adminPayload(pool, {});
    const byIssue = Object.fromEntries(payload.queue.items.map((i) => [i.issue_number, i.waiting]));
    assert.deepEqual(byIssue[4602], { reason: 'session_busy', until: until.toISOString() });
    assert.equal(byIssue[4603], null, 'a wait that is over is none');
    const shaped = await require('../src/services/bench/connector-data').botOverview(pool, {}, {});
    const item = shaped.queue.items.find((i) => i.issueNumber === 4602);
    assert.deepEqual(item.waiting, { reason: 'session_busy', until: until.toISOString() });
  });
});
