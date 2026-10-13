'use strict';

// #3654: a platform redeploy restarts the server, not the worker, so a
// benchmark trial's turn is often still running when the new server comes
// up. Restart recovery used to abandon every one and leave the trial
// `running` for an hour and a half before the lane ran it again. Now:
//
//   * a turn that is the trial's last (a triage, a follow-up, a checks fix,
//     a build's build turn) is followed to its end through the same journal
//     machinery as any recovered turn, and the trial is recorded by the
//     lane's shared finisher, holding its lane slot meanwhile: no PR, no
//     staging, no notification, no chat row;
//   * any other (a build's spec turn) is abandoned and the trial put back in
//     the queue at once, what it spent charged; after a second interruption
//     it fails;
//   * a recovery that cannot finish the trial puts it back in the queue;
//   * a first version's every turn (its triage, spec and build) is followed,
//     what it produced kept on the trial's checkpoint, and the trial handed
//     back to the lane to go on from there, as the bot's own builds are:
//     kept work costs it no claim, each session is charged to the run once,
//     and the time its claims ran adds up;
//   * so is a configuration's side build (services/bot-configs.js), of a
//     first version or of a later change: its spec turn, its build turn and
//     a review's fix turn, each on the clock its stage gave it, and its next
//     claim goes on from what was kept. Until 7 Oct 2026 every restart ran
//     a side build again, and with restarts every few minutes almost none
//     finished. One whose worker is gone is still released, a claim spent.
//
// server.js only boots when run as the entry point, so requiring it exposes
// adoptOrphanWorker without starting anything. The worker, the agent-turn
// ledger settlement and every outward call are stubbed; the database is a
// real one with the full schema.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

// ── worker stub ─────────────────────────────────────────────────────────
let journalTail = async () => ({});
let stopped = null;
const workerCalls = [];
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  usesKubernetesWorkers: () => false,
  resumeTurnFromJournal: async (sessionId, opts) => {
    workerCalls.push(['resume', sessionId]);
    return journalTail(sessionId, opts);
  },
  stopTurn: async (sessionId) => { workerCalls.push(['stopTurn', sessionId]); stopped?.(); return true; },
  clearPendingStop: () => {},
  finishTurn: async (sessionId) => { workerCalls.push(['finishTurn', sessionId]); return true; },
  clearActiveTurn: async (sessionId) => { workerCalls.push(['clearActiveTurn', sessionId]); return true; },
  markTurnTail: async () => true,
  noteTailMilestone: async () => true,
  adoptWarmWorker: (sessionId) => { workerCalls.push(['adoptWarmWorker', sessionId]); },
  destroyWorker: async (name) => { workerCalls.push(['destroyWorker', name]); },
  evictWorker: async (id) => { workerCalls.push(['evictWorker', id]); },
  isWorkerExecuting: async () => false,
  getTurnByokCents: () => 0,
  getActiveTurnMode: () => null,
  workerContainerName: (id) => `usernode-worker-${id}`,
};

const wsPath = require.resolve('../src/services/ws');
const realWs = require(wsPath);
require.cache[wsPath].exports = { ...realWs, broadcastGlobal: () => {}, pushNotificationToUser: () => 0, pushToUser: () => 0 };

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

const lane = require('../src/services/bench/lane');
const suites = require('../src/services/bench/suites');
const graders = require('../src/services/bench/graders');
const snapshots = require('../src/services/homeroom-bot-snapshots');
const agentTurn = require('../src/services/agent-turn');
const sessionsRoutes = require('../src/routes/sessions');
const prMetadata = require('../src/services/pr-metadata');
const notifications = require('../src/services/notifications');
const githubModule = require('../src/services/github');
const managedKeys = require('../src/services/openrouter-managed-keys');
const limits = require('../src/services/limits');

// What would leave the benchmark, spied: none of it may be called.
const outward = [];
prMetadata.applyPrMetadata = async () => { outward.push('applyPrMetadata'); return {}; };
for (const name of ['createSessionDoneNotification', 'createSessionStalledNotification', 'hydrateAndPush']) {
  notifications[name] = async () => { outward.push(name); return []; };
}
for (const name of ['createPR', 'createIssueComment', 'updatePR', 'mergePR']) {
  githubModule[name] = async () => { outward.push(`github.${name}`); return null; };
}
const staging = { async buildAndDeployStaging() { outward.push('staging'); return {}; } };
// Reads and the trial's own branch: recorded.
const gh = { compared: [], deleted: [] };
githubModule.compareFiles = async (o, r, range) => {
  gh.compared.push(range);
  return { files: [{ filename: 'app.js', status: 'modified' }], diff: 'diff --git a/app.js b/app.js\n+x', complete: true, truncated: false };
};
githubModule.deleteBenchBranch = async (o, r, branch) => { gh.deleted.push(branch); return true; };
const graded = [];
graders.gradeTrial = async (_pool, id) => { graded.push(id); };
agentTurn.persistRecoveredAgentThread = async () => {};
agentTurn.settleRecoveredAgentAttempt = async () => null;
agentTurn.completeCodexAttempt = async () => {};
sessionsRoutes.resumeRecoveredCodexFreshRetry = async () => null;
const debits = [];
managedKeys.usesIncludedKey = async () => true;
limits.recordSpend = async (_p, userId, cents) => { debits.push(cents); };

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const BASE = 'a'.repeat(40);
const VERDICT = '```json\n{"verdict":"ready","build_note":"Pin the markers.","reason":"clear"}\n```';

test('restart recovery of benchmark trials, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bench_recover_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    lane._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/o/todo') RETURNING id",
  );
  const { rows: [user] } = await pool.query(
    "INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bench', 'x', TRUE) RETURNING id",
  );
  const { suite } = await suites.createSuite(pool, { name: 'recover' });
  for (let i = 1; i <= 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { rows: [r] } = await pool.query(
      "INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, $2, 'shadow', 'ready') RETURNING id", [app.id, i],
    );
    for (const stage of ['triage', 'build']) {
      // eslint-disable-next-line no-await-in-loop
      await snapshots.recordSnapshot(pool, { runId: r.id, stage, appId: app.id, issueNumber: i, baseSha: BASE, texts: { seed: `s${i}`, prompt: `p${i}` } });
      // eslint-disable-next-line no-await-in-loop
      await suites.addTaskFromRun(pool, { suiteId: suite.id, runId: r.id, stage });
    }
  }

  const turnOf = (mode, extra = {}) => ({
    turnId: `turn-${crypto.randomUUID()}`, journal: '/journals/t.log', mode, phase: 'executing',
    backend: 'codex_openrouter', model: 'z-ai/glm-5.3-flash', startedAt: new Date().toISOString(), attemptNumber: 1, ...extra,
  });
  const newSession = async (activeTurn, { specMd = '', status = 'active' } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, linked_issues, session_title,
                                agent_backend, agent_provider, agent_model, active_turn, spec_md)
     VALUES ($1, $2, $5, FALSE, '{}', 'bench', 'codex_openrouter', 'openrouter', 'z-ai/glm-5.3-flash', $3::jsonb, $4)
     RETURNING id`,
    [app.id, user.id, activeTurn ? JSON.stringify(activeTurn) : null, specMd, status],
  )).rows[0].id;
  const spend = (sessionId, usd) => pool.query(
    `INSERT INTO agent_turns (id, session_id, user_id, backend, status, estimated_cost_usd, routed_model)
     VALUES ($1, $2, $3, 'codex_openrouter', 'completed', $4, 'z-ai/glm-5.3-flash')`,
    [crypto.randomUUID(), sessionId, user.id, usd],
  );
  const launch = async (stages) => {
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages, repeats: 1 });
    const { rows } = await pool.query(
      `SELECT tr.id, t.stage FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id
        WHERE tr.run_id = $1 ORDER BY tr.id`, [run.id],
    );
    return { run, trials: rows };
  };
  const claimAs = (trialId, sessionId, { claims = 1, baseSha = BASE } = {}) => pool.query(
    `UPDATE bench_trials SET status = 'running', claims = $2, started_at = NOW() - INTERVAL '3 minutes',
            session_id = $3, base_sha = $4, build_branch = 'bench/r' || run_id || '-t' || id
      WHERE id = $1`,
    [trialId, claims, sessionId, baseSha],
  );
  const trialRow = async (id) => (await pool.query(
    `SELECT status, error, parsed, cost_usd::float8 AS cost, interrupted_cost_usd::float8 AS interrupted,
            recovered_at, build_commits, diff, session_id
       FROM bench_trials WHERE id = $1`, [id],
  )).rows[0];
  const sessionRow = async (id) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id])).rows[0];
  const chatRows = async (id) => Number((await pool.query(
    'SELECT COUNT(*) AS n FROM chat_session_messages WHERE session_id = $1', [id],
  )).rows[0].n);
  const spent = async (runId) => (await pool.query('SELECT spent_usd::float8 AS s FROM bench_runs WHERE id = $1', [runId])).rows[0].s;
  const adopt = (sessionId, state = 'running') => adoptOrphanWorker(
    { name: `usernode-worker-${sessionId}`, sessionId, state },
    { config: {}, pool, staging, ghub: githubModule, broadcastGlobal: () => {} },
  );
  const reset = () => {
    workerCalls.length = 0; outward.length = 0; graded.length = 0; debits.length = 0;
    gh.compared.length = 0; gh.deleted.length = 0;
    journalTail = async () => ({});
    stopped = null;
    lane._resetForTests();
  };

  await t.test('a triage turn still running is followed to its end and recorded, holding its slot, with nothing said anywhere', async () => {
    reset();
    const { run, trials } = await launch(['triage']);
    const trial = trials[0];
    const sid = await newSession(turnOf('scout'));
    await claimAs(trial.id, sid);
    await spend(sid, 0.42);
    let heldDuring = null;
    journalTail = async () => {
      heldDuring = lane._inFlightForTests().get(trial.id) || null;
      return { lastResultText: VERDICT, exitCode: 0, resultSeen: true };
    };
    await adopt(sid);

    assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'resume', 'finishTurn', 'destroyWorker'],
      'followed, its turn record cleared, then its worker removed');
    assert.equal(heldDuring?.runId, run.id, 'the trial held a lane slot while recovery followed it');
    assert.equal(heldDuring?.sessionId, sid);
    assert.equal(lane._inFlightForTests().has(trial.id), false, 'and let it go after');
    const row = await trialRow(trial.id);
    assert.equal(row.status, 'ok');
    assert.equal(row.parsed.verdict, 'ready');
    assert.equal(row.cost, 0.42);
    assert.ok(row.recovered_at);
    assert.equal(await spent(run.id), 0.42);
    assert.deepEqual(debits, [42]);
    assert.deepEqual(graded, [trial.id]);
    assert.equal((await sessionRow(sid)).status, 'archived');
    assert.deepEqual(outward, [], 'no PR, staging or notification');
    assert.equal(await chatRows(sid), 0, 'no completion card, breadcrumb or wrap-up row');
  });

  await t.test('a build turn still running is finished with its diff; the branch with its commits is kept', async () => {
    reset();
    const { trials } = await launch(['build']);
    const trial = trials[0];
    const sid = await newSession(turnOf('build'), { specMd: '# Pin the markers' });
    await claimAs(trial.id, sid);
    await spend(sid, 0.6);
    journalTail = async () => ({ pushOk: true, ahead: 3, sha: 'c'.repeat(40), exitCode: 0 });
    await adopt(sid);
    const row = await trialRow(trial.id);
    assert.equal(row.status, 'ok');
    assert.equal(row.build_commits, 3);
    assert.match(row.diff, /app\.js/);
    assert.equal(row.parsed.spec, '# Pin the markers');
    assert.equal(gh.compared.length, 1);
    assert.deepEqual(gh.deleted, []);
    assert.deepEqual(outward, []);
    assert.equal(await chatRows(sid), 0);
  });

  await t.test('the trial\'s own clock ends a recovered turn that runs past it', async () => {
    reset();
    const { trials } = await launch(['triage']);
    const trial = trials[0];
    const sid = await newSession(turnOf('scout', { startedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString() }));
    await claimAs(trial.id, sid);
    journalTail = () => new Promise((resolve) => { stopped = () => resolve({ lastResultText: '', exitCode: 143 }); });
    await adopt(sid);
    assert.ok(workerCalls.some((c) => c[0] === 'stopTurn'), 'stopped on the trial\'s clock');
    const row = await trialRow(trial.id);
    assert.equal(row.status, 'timeout');
    assert.deepEqual(outward, []);

    // A turn that had finished before the restart, its journal ending on its
    // own exit 0, did its work in time, though the re-armed clock fires at
    // once (as the live bot reads it).
    reset();
    const { trials: [done] } = await launch(['triage']);
    const sid2 = await newSession(turnOf('scout', { startedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString() }));
    await claimAs(done.id, sid2);
    journalTail = () => new Promise((resolve) => { stopped = () => resolve({ lastResultText: VERDICT, exitCode: 0, resultSeen: true }); });
    await adopt(sid2);
    const row2 = await trialRow(done.id);
    assert.equal(row2.status, 'ok', 'recorded as the turn ended, not as a time-out');
  });

  await t.test('a build\'s spec turn is followed, its spec kept, and the trial handed back without spending a claim, its spend charged', async () => {
    // Until 13 Oct 2026 it was stopped and abandoned, and the whole trial run again.
    reset();
    const { run, trials } = await launch(['build']);
    const trial = trials[0];
    const specTurn = turnOf('scout');
    const sid = await newSession(specTurn);
    await claimAs(trial.id, sid);
    await spend(sid, 0.15);
    journalTail = async () => ({ lastResultText: '# Pin the markers\n\nOne map with every marker on it.', exitCode: 0, resultSeen: true });
    await adopt(sid);
    assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'resume', 'finishTurn', 'destroyWorker'],
      'followed to its end, never abandoned');
    const { rows: [row] } = await pool.query(
      'SELECT status, session_id, claims, checkpoint, interrupted_cost_usd::float8 AS interrupted FROM bench_trials WHERE id = $1', [trial.id],
    );
    assert.equal(row.status, 'pending', 'back in the queue, to build from its spec');
    assert.equal(row.session_id, null);
    assert.equal(row.claims, 0, 'the restart cost it no claim');
    assert.equal(row.checkpoint.spec.specMd, '# Pin the markers\n\nOne map with every marker on it.');
    assert.equal(row.checkpoint.spec.turnId, specTurn.turnId);
    assert.equal(row.interrupted, 0, 'none of it thrown away');
    assert.equal(await spent(run.id), 0.15, 'its spend charged to the run once');
    assert.deepEqual(debits, [15]);
    assert.equal((await sessionRow(sid)).status, 'archived');
    assert.deepEqual(outward, []);
  });

  await t.test('a trial interrupted a second time fails; one whose worker had already exited is released too', async () => {
    reset();
    const { trials } = await launch(['build']);
    const [twice, exited] = trials;
    // Its spec turn followed, but nothing came of it to keep: the claim is spent.
    const s1 = await newSession(turnOf('scout'));
    await claimAs(twice.id, s1, { claims: 2 });
    await adopt(s1);
    const row = await trialRow(twice.id);
    assert.equal(row.status, 'infra_fail');
    assert.match(row.error, /restarted during it twice/);

    workerCalls.length = 0;
    const s2 = await newSession(turnOf('build'));
    await claimAs(exited.id, s2);
    await adopt(s2, 'exited');
    assert.equal(workerCalls.filter((c) => c[0] === 'resume').length, 0, 'an exited worker is not followed');
    assert.equal((await trialRow(exited.id)).status, 'pending');
  });

  // A first version (services/bench/runner.js firstVersionStage), on a run
  // of its own as the studio makes one.
  const { rows: [snap] } = await pool.query('SELECT id FROM homeroom_bot_run_snapshots ORDER BY id LIMIT 1');
  const token = () => crypto.randomBytes(8).toString('hex');
  const firstVersionTrial = async () => {
    const { rows: [task] } = await pool.query(
      `INSERT INTO bench_tasks (suite_id, stage, app_id, snapshot_id, reference_source, label_token)
       VALUES ($1, 'first_version', $2, $3, 'authored', $4) RETURNING id`,
      [suite.id, app.id, snap.id, token()],
    );
    const { rows: [run] } = await pool.query(
      `INSERT INTO bench_runs (suite_id, models, baseline_model, stages, repeats, cap_usd, concurrency, status, kind)
       VALUES ($1, ARRAY['today'], 'today', ARRAY['first_version'], 1, 50, 1, 'running', 'studio') RETURNING id`,
      [suite.id],
    );
    const { rows: [trial] } = await pool.query(
      "INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token) VALUES ($1, $2, 'today', 1, 'pending', $3) RETURNING id",
      [run.id, task.id, token()],
    );
    return { run, id: trial.id };
  };
  const keep = (trialId, checkpoint) => pool.query(
    'UPDATE bench_trials SET checkpoint = $2::jsonb WHERE id = $1', [trialId, JSON.stringify(checkpoint)],
  );
  const fvRow = async (id) => (await pool.query(
    `SELECT status, claims, session_id, checkpoint, recovered_at, prior_ms::float8 AS prior_ms, duration_ms,
            cost_usd::float8 AS cost, interrupted_cost_usd::float8 AS interrupted
       FROM bench_trials WHERE id = $1`, [id],
  )).rows[0];
  const SPEC = '# Tier List\n\nRank things with friends.';

  let fv;
  let triageSid;
  let specSid;
  await t.test('a first version\'s spec turn is followed, its spec kept, and the trial handed back without spending a claim', async () => {
    reset();
    fv = await firstVersionTrial();
    triageSid = await newSession(null);
    specSid = await newSession(turnOf('scout'));
    await claimAs(fv.id, specSid);
    await keep(fv.id, {
      triageSessionId: triageSid, sessions: [triageSid, specSid],
      triage: { status: 'ok', session_id: triageSid, parsed: { verdict: 'ready', buildNote: 'One board.' } },
    });
    await spend(triageSid, 0.05);
    await spend(specSid, 0.3);
    journalTail = async () => ({ lastResultText: SPEC, exitCode: 0, resultSeen: true });
    await adopt(specSid);

    assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'resume', 'finishTurn', 'destroyWorker'],
      'followed to its end, never abandoned');
    const row = await fvRow(fv.id);
    assert.equal(row.status, 'pending', 'back in the queue to go on');
    assert.equal(row.claims, 0, 'the restart cost it no claim');
    assert.equal(row.session_id, null);
    assert.ok(row.recovered_at);
    const { turnId: specTurnId, ...keptSpec } = row.checkpoint.spec;
    assert.deepEqual(keptSpec, { sessionId: specSid, specMd: SPEC });
    assert.match(specTurnId, /^turn-/, 'with its turn\'s ledger id, so what it cost can still be named');
    assert.equal(row.checkpoint.triage.parsed.verdict, 'ready', 'what it kept before is kept');
    assert.equal(row.checkpoint.handBacks, 1);
    assert.equal(row.checkpoint.handedBackAt, 2);
    assert.deepEqual(row.checkpoint.charged, { [triageSid]: 0.05, [specSid]: 0.3 }, 'every session it opened, charged once');
    assert.equal(row.interrupted, 0, 'none of it thrown away');
    assert.ok(row.prior_ms >= 179000, `the claim's time is kept (${row.prior_ms})`);
    assert.equal(await spent(fv.run.id), 0.35);
    assert.deepEqual(debits, [35]);
    assert.equal((await sessionRow(specSid)).status, 'archived');
    assert.deepEqual(graded, [], 'nothing recorded yet');
    assert.deepEqual(outward, []);
    assert.equal(await chatRows(specSid), 0);
  });

  await t.test('a restart that loses work spends a claim; the trial that finishes is charged only what no release was', async () => {
    reset();
    // The second claim's build turn: its worker was gone at the restart.
    const buildSid = await newSession(turnOf('build'));
    await claimAs(fv.id, buildSid);
    await pool.query(
      "UPDATE bench_trials SET checkpoint = jsonb_set(checkpoint, '{sessions}', checkpoint->'sessions' || to_jsonb($2::int)) WHERE id = $1",
      [fv.id, buildSid],
    );
    await spend(buildSid, 0.2);
    await adopt(buildSid, 'exited');
    let row = await fvRow(fv.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.claims, 1, 'nothing new was kept: this one counts');
    assert.equal(row.checkpoint.handBacks, 1);
    assert.equal(row.interrupted, 0.2, 'the lost build turn is the interrupted cost');
    assert.equal(row.checkpoint.charged[buildSid], 0.2);
    assert.ok(row.prior_ms >= 359000, `both claims' time (${row.prior_ms})`);
    assert.equal(await spent(fv.run.id), 0.55);

    // The third claim builds from the kept spec and records the trial.
    const lastSid = await newSession(null);
    await claimAs(fv.id, lastSid, { claims: 2 });
    await spend(lastSid, 0.5);
    const status = await lane.recordTrial(pool, {
      trialRow: { id: fv.id, run_id: fv.run.id },
      row: { stage: 'first_version', repo_url: 'https://github.com/o/todo' },
      patch: {
        status: 'ok', session_id: lastSid, session_ids: [triageSid, specSid, lastSid], duration_ms: 120000,
        base_sha: BASE, build_branch: `bench/r${fv.run.id}-t${fv.id}`, build_sha: 'e'.repeat(40), build_commits: 2,
        parsed: { built: true },
      },
      user: { id: user.id },
      d: { worker: { evictWorker: async () => {} }, managedOpenRouter: managedKeys, limits, github: githubModule, afterTrial: async () => {} },
    });
    assert.equal(status, 'ok');
    row = await fvRow(fv.id);
    assert.equal(row.cost, 0.85, 'its own cost: the triage, the spec and the build its result is built from');
    assert.equal(row.interrupted, 0.2);
    assert.equal(await spent(fv.run.id), 1.05, 'every session charged to the run exactly once');
    assert.deepEqual(debits, [20, 50], 'the lost turn at its release, the rest at the end');
    assert.ok(row.duration_ms >= 120000 + 359000, `its elapsed time counts every claim (${row.duration_ms})`);
  });

  await t.test('a restart that lost nothing (its screenshot step, after a kept build and review) costs no claim, a few times over', async () => {
    reset();
    const fvc = await firstVersionTrial();
    const triSid = await newSession(null);
    const buildSid = await newSession(null);
    await keep(fvc.id, {
      triageSessionId: triSid, sessions: [triSid, buildSid],
      triage: { status: 'ok', session_id: triSid, parsed: { verdict: 'ready', buildNote: 'One board.' } },
      spec: { sessionId: buildSid, specMd: SPEC },
      build: { ok: true, sessionId: buildSid, sha: 'd'.repeat(40), commits: 2, specMd: SPEC },
      handBacks: 1, handedBackAt: 3,
    });
    await spend(buildSid, 0.4);
    for (let n = 1; n <= 4; n += 1) {
      // Each claim only captures, on a session of its own that spends nothing.
      // eslint-disable-next-line no-await-in-loop
      const shotSid = await newSession(null);
      // Its second claim each time.
      // eslint-disable-next-line no-await-in-loop
      await claimAs(fvc.id, shotSid, { claims: 2 });
      // eslint-disable-next-line no-await-in-loop
      await lane.releaseTrial(pool, { trialId: fvc.id, sessionId: shotSid, why: 'no process or turn holds it', noTurnLost: true });
      // eslint-disable-next-line no-await-in-loop
      const row = await fvRow(fvc.id);
      if (n <= 3) {
        assert.equal(row.status, 'pending', `restart ${n}: back to go on`);
        assert.equal(row.claims, 1, `restart ${n}: nothing was lost, so the claim it took is given back`);
        assert.equal(row.checkpoint.freeRestarts, n);
      } else {
        assert.equal(row.status, 'infra_fail', 'past MAX_FREE_RESTARTS a restart counts again, so one a run of them keeps catching ends');
      }
    }
  });

  await t.test('a first version\'s triage turn is followed and its answer kept, on the triage\'s own clock', async () => {
    reset();
    const tri = await firstVersionTrial();
    const sid = await newSession(turnOf('scout'));
    await claimAs(tri.id, sid);
    await keep(tri.id, { triageSessionId: sid, sessions: [sid] });
    const bot = require('../src/services/homeroom-bot');
    const budgets = require('../src/services/bench/runner').budgetsFor(await bot.readSettings(pool), { repo_url: 'https://github.com/o/todo' }, {}, 'first_version');
    const { rows: [session] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [sid]);
    const at = Date.parse('2026-10-06T22:00:00.000Z');
    const startedAt = new Date(at).toISOString();
    assert.equal(await lane.recoveryDeadline(pool, {}, session, turnOf('scout', { startedAt })), at + budgets.firstVersion.turnMs);
    // Were its triage another session's, this scout turn would be the spec.
    await keep(tri.id, { triageSessionId: sid + 1000, sessions: [sid] });
    assert.equal(await lane.recoveryDeadline(pool, {}, session, turnOf('scout', { startedAt })),
      at + Math.min(budgets.firstVersion.buildMs, budgets.firstVersion.specMs), 'a spec turn: the spec\'s clock');
    assert.equal(await lane.recoveryDeadline(pool, {}, session, turnOf('build', { startedAt })), at + budgets.firstVersion.buildMs);
    // Each restart the turn has been through gives back what it cost, as the
    // live bot's clock does (homeroom-bot.js restartAllowanceMs).
    assert.equal(await lane.recoveryDeadline(pool, {}, session, turnOf('build', { startedAt, restarts: 2 })),
      at + budgets.firstVersion.buildMs + 2 * bot.restartAllowanceMs({ restarts: 1 }));
    await keep(tri.id, { triageSessionId: sid, sessions: [sid] });

    journalTail = async () => ({ lastResultText: VERDICT, exitCode: 0, resultSeen: true });
    await adopt(sid);
    const row = await fvRow(tri.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.claims, 0);
    assert.equal(row.checkpoint.triage.status, 'ok');
    assert.equal(row.checkpoint.triage.session_id, sid);
    assert.equal(row.checkpoint.triage.parsed.verdict, 'ready');
    assert.equal(row.checkpoint.triage.parsed.buildNote, 'Pin the markers.');
    assert.deepEqual(outward, []);
  });

  await t.test('a first version\'s build turn followed after a restart keeps what it could see, and every look its turn took, none twice', async () => {
    reset();
    const fvb = await firstVersionTrial();
    const triSid = await newSession(null);
    const buildTurn = turnOf('build', { logicalTurnId: crypto.randomUUID() });
    const buildSid = await newSession(buildTurn);
    await claimAs(fvb.id, buildSid);
    // What the claim kept before the restart: what its build was told and
    // handed (kept as its build turn started), the counts its build step began
    // with, and its looks as last kept, a few seconds before the restart.
    const sight = { told: true, passed: true };
    await keep(fvb.id, {
      triageSessionId: triSid, sessions: [triSid, buildSid],
      triage: { status: 'ok', session_id: triSid, parsed: { verdict: 'ready', buildNote: 'One board.' } },
      spec: { sessionId: buildSid, specMd: SPEC },
      sight,
      stepLooks: { step: 'build', screenshots: 0, snapshots: 1, navigations: 1 },
      looks: { screenshots: 2, snapshots: 1, navigations: 2 },
    });
    // What its transcript got before the restart: the turn's first two lines.
    await pool.query(
      `INSERT INTO bench_trial_lines (trial_id, at, step, kind, line) VALUES
         ($1, NOW() - INTERVAL '1 hour', 'build', 'step', 'build'),
         ($1, NOW() + INTERVAL '1 second', 'build', 'line', 'Using browser_navigate'),
         ($1, NOW() + INTERVAL '2 seconds', 'build', 'line', 'Using mcp__playwright__browser_take_screenshot')`,
      [fvb.id],
    );
    // What the studio's watch showed when the platform went down.
    await pool.query('UPDATE bench_trials SET progress = $2::jsonb WHERE id = $1', [fvb.id, JSON.stringify({
      step: 'build', stepAt: '2026-10-13T18:20:00.000Z', lines: ['OpenRouter request #3: still responding after 210s'],
      skills: { invoked: [], read: ['frontend-design'] }, looks: { screenshots: 2, snapshots: 1, navigations: 2 },
    })]);
    // The replay shows the turn from its start: the looks kept before the
    // restart, one the restart lost, and the ones after it.
    journalTail = async (_sid, opts) => {
      for (const line of ['Using browser_navigate', 'Using mcp__playwright__browser_take_screenshot', 'Using mcp__playwright__browser_take_screenshot',
        'Using mcp__playwright__browser_take_screenshot', 'Using browser_navigate', 'Using mcp__playwright__browser_take_screenshot']) {
        opts.onProgress(line);
      }
      return { exitCode: 0, resultSeen: true, pushOk: true, ahead: 2, sha: 'd'.repeat(40) };
    };
    await adopt(buildSid);

    const row = await fvRow(fvb.id);
    assert.equal(row.status, 'pending', 'handed back to go on');
    assert.equal(row.checkpoint.build.ok, true);
    assert.deepEqual(row.checkpoint.build.turnIds, [buildTurn.logicalTurnId],
      'with its turn\'s ledger id: the next claim names what it cost, and the report finds its build turn');
    assert.deepEqual(row.checkpoint.sight, sight, 'what it could see is still there for the next claim');
    assert.deepEqual(row.checkpoint.looks, { screenshots: 4, snapshots: 1, navigations: 3 },
      'the step\'s counts plus the whole turn\'s: none counted twice, none lost after the restart');
    // The studio watched the replay, not the moment of the restart.
    const { rows: [{ progress: watched }] } = await pool.query('SELECT progress FROM bench_trials WHERE id = $1', [fvb.id]);
    assert.equal(watched.step, 'build', 'still at its step');
    assert.equal(watched.stepAt, '2026-10-13T18:20:00.000Z');
    assert.equal(watched.lines[watched.lines.length - 1], 'Using mcp__playwright__browser_take_screenshot', 'its lines are the replay\'s');
    assert.deepEqual(watched.looks, { screenshots: 4, snapshots: 1, navigations: 3 }, 'counted on the step\'s opening counts');
    assert.deepEqual(row.checkpoint.skills, { invoked: [], read: ['frontend-design'] }, 'the skills it had reached for, kept for the next claim');
    // Its transcript: the two lines it had, then the replay's other four, marked so.
    const { rows: lines } = await pool.query('SELECT kind, line, replayed FROM bench_trial_lines WHERE trial_id = $1 ORDER BY id', [fvb.id]);
    assert.deepEqual(lines.map((l) => [l.kind, l.replayed]), [
      ['step', false], ['line', false], ['line', false], ['line', true], ['line', true], ['line', true], ['line', true],
    ], 'none of the turn\'s lines twice, none lost');
    assert.equal(lines[3].line, 'Using mcp__playwright__browser_take_screenshot');
    const studio = require('../src/services/bench/studio');
    const timeline = await studio.timelineOf(pool, fvb.id);
    assert.equal(timeline.length, 1);
    assert.deepEqual([timeline[0].step, timeline[0].lines, timeline[0].replayed], ['build', 6, 4]);
    assert.ok(timeline[0].ms >= 3600_000, 'from its step\'s start to its last line');
    const page = await studio.transcriptOf(pool, fvb.id, { limit: 4 });
    assert.equal(page.total, 7);
    assert.equal(page.lines.length, 4);
    const rest = await studio.transcriptOf(pool, fvb.id, { after: page.next });
    assert.equal(rest.lines.length, 3);
    assert.equal(rest.next, null, 'the end');
    assert.equal((await studio.transcriptOf(pool, fvb.id, { step: 'triage' })).lines.length, 0, 'one step\'s lines only');
    // Paged in id order as numbers: run 190's transcripts, ordered as text,
    // put 1000 before 999 and a cursor skipped the lines between.
    await pool.query(`INSERT INTO bench_trial_lines (id, trial_id, at, step, kind, line) VALUES
      (9999, $1, NOW(), 'build', 'line', 'a'), (10000, $1, NOW(), 'build', 'line', 'b'), (100000, $1, NOW(), 'build', 'line', 'c')`, [fvb.id]);
    const seen = [];
    let after = null;
    do {
      // eslint-disable-next-line no-await-in-loop
      const p = await studio.transcriptOf(pool, fvb.id, { limit: 3, after });
      seen.push(...p.lines.map((l) => l.id));
      after = p.next;
    } while (after);
    assert.equal(seen.length, 10, 'every line, none skipped');
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
    assert.deepEqual(seen.slice(-3), [9999, 10000, 100000]);
    assert.ok(row.recovered_at);
    assert.deepEqual(outward, []);
  });

  await t.test('a recovery that cannot finish the trial puts it back in the queue', async () => {
    reset();
    const { trials } = await launch(['triage', 'build']);
    const tri = trials.find((x) => x.stage === 'triage');
    const build = trials.find((x) => x.stage === 'build');

    // The journal replay fails.
    const s1 = await newSession(turnOf('scout'));
    await claimAs(tri.id, s1);
    journalTail = async () => { throw new Error('journal unreadable'); };
    await adopt(s1);
    assert.equal((await trialRow(tri.id)).status, 'pending');
    assert.ok(workerCalls.some((c) => c[0] === 'finishTurn'));

    // The finish fails: a build with no base on record cannot be diffed.
    const s2 = await newSession(turnOf('build'));
    await claimAs(build.id, s2, { baseSha: null });
    journalTail = async () => ({ pushOk: true, ahead: 1, sha: 'd'.repeat(40), exitCode: 0 });
    await adopt(s2);
    assert.equal((await trialRow(build.id)).status, 'pending');
    assert.deepEqual(graded, []);
    assert.deepEqual(outward, [], 'no stalled notification either');
    assert.equal(await chatRows(s1) + await chatRows(s2), 0);
  });

  // ── A configuration's side build ──────────────────────────────────────

  const GLM = 'z-ai/glm-5.3-flash';
  const bot = require('../src/services/homeroom-bot');
  const runner = require('../src/services/bench/runner');
  const versions = {};
  const versionOf = async (scope) => {
    if (!versions[scope]) {
      const { rows: [v] } = await pool.query(
        `INSERT INTO bot_config_versions (key, label, version, recipe, role, scope)
         VALUES ($1, 'All GLM', 1, $2::jsonb, 'side', $3) RETURNING id`,
        [`all-glm-${scope === 'later' ? 'later' : 'first'}`, JSON.stringify({ models: { triage: GLM, spec: GLM, build: GLM }, reviewer: null, pack: null }), scope],
      );
      versions[scope] = v.id;
    }
    return versions[scope];
  };
  // A side trial as spawnSideBuilds makes one: a first version's at the
  // `first_version` stage, a later change's at `build`.
  const sideTrial = async ({ scope = 'first_version' } = {}) => {
    const versionId = await versionOf(scope);
    const { rows: [liveRun] } = await pool.query(
      "INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, 1, 'live', 'ready') RETURNING id", [app.id],
    );
    const stage = scope === 'later' ? 'build' : 'first_version';
    const { rows: [task] } = await pool.query(
      `INSERT INTO bench_tasks (suite_id, stage, app_id, snapshot_id, reference_source, label_token, source_run_id)
       VALUES ($1, $2, $3, $4, 'authored', $5, $6) RETURNING id`,
      [suite.id, stage, app.id, snap.id, token(), liveRun.id],
    );
    const { rows: [run] } = await pool.query(
      `INSERT INTO bench_runs (suite_id, models, baseline_model, stages, repeats, cap_usd, concurrency, status, kind)
       VALUES ($1, ARRAY[$2], $2, ARRAY[$3], 1, 5, 1, 'running', $4) RETURNING id`,
      [suite.id, GLM, stage, scope === 'later' ? 'bot_config_later' : 'bot_config'],
    );
    const { rows: [trial] } = await pool.query(
      `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token, bot_run_id, bot_config_version_id)
       VALUES ($1, $2, $3, 1, 'pending', $4, $5, $6) RETURNING id`,
      [run.id, task.id, `config:${versionId}`, token(), liveRun.id, versionId],
    );
    return { run, id: trial.id, botRunId: liveRun.id, versionId, branch: `bench/r${run.id}-t${trial.id}` };
  };
  const sessionOf = async (id) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [id])).rows[0];
  const budgetsOf = async (stage) => runner.budgetsFor(await bot.readSettings(pool), { repo_url: 'https://github.com/o/todo' }, {}, stage);
  const at = Date.parse('2026-10-07T22:00:00.000Z');
  const startedAt = new Date(at).toISOString();

  await t.test('a side build\'s spec turn is followed, on the spec\'s clock, its spec kept, and the trial handed back without spending a claim', async () => {
    reset();
    const side = await sideTrial();
    const sid = await newSession(turnOf('scout'));
    await claimAs(side.id, sid);
    await keep(side.id, { sessions: [sid] });
    await spend(sid, 0.25);
    const first = (await budgetsOf('first_version')).firstVersion;
    assert.equal(await lane.recoveryDeadline(pool, {}, await sessionOf(sid), turnOf('scout', { startedAt })),
      at + Math.min(first.buildMs, first.specMs), 'a first version\'s spec clock, as draftSpec gives it: never read as a triage');
    assert.equal(await lane.recoveryDeadline(pool, {}, await sessionOf(sid), turnOf('build', { startedAt })), at + first.buildMs);
    journalTail = async () => ({ lastResultText: SPEC, exitCode: 0, resultSeen: true });
    await adopt(sid);

    assert.deepEqual(workerCalls.map((c) => c[0]), ['adoptWarmWorker', 'resume', 'finishTurn', 'destroyWorker'],
      'followed to its end, not abandoned');
    const row = await fvRow(side.id);
    assert.equal(row.status, 'pending', 'back in the queue to go on');
    assert.equal(row.claims, 0, 'the restart cost it no claim');
    assert.equal(row.session_id, null);
    assert.ok(row.recovered_at);
    const { turnId: specTurnId, ...keptSpec } = row.checkpoint.spec;
    assert.deepEqual(keptSpec, { sessionId: sid, specMd: SPEC });
    assert.match(specTurnId, /^turn-/, 'with its turn\'s ledger id, so what it cost can still be named');
    assert.equal(row.checkpoint.handBacks, 1);
    assert.deepEqual(row.checkpoint.charged, { [sid]: 0.25 }, 'charged once');
    assert.equal(row.interrupted, 0, 'none of it thrown away');
    assert.equal(await spent(side.run.id), 0.25);
    assert.equal((await sessionRow(sid)).status, 'archived');
    assert.deepEqual(graded, [], 'nothing recorded yet');
    assert.deepEqual(outward, []);
    assert.equal(await chatRows(sid), 0);
  });

  await t.test('a side build\'s build turn is followed and kept; its next claim captures it without building again, every session charged once', async () => {
    reset();
    const side = await sideTrial();
    const sid = await newSession(turnOf('build'), { specMd: SPEC });
    await claimAs(side.id, sid);
    // Its spec turn ran in the same session, in this same claim.
    await keep(side.id, { sessions: [sid], spec: { sessionId: sid, specMd: SPEC } });
    await spend(sid, 0.6);
    journalTail = async () => ({ pushOk: true, ahead: 2, sha: 'd'.repeat(40), exitCode: 0, resultSeen: true });
    await adopt(sid);
    let row = await fvRow(side.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.claims, 0, 'kept work costs no claim');
    assert.equal(row.checkpoint.build.ok, true);
    assert.equal(row.checkpoint.build.sha, 'd'.repeat(40));
    assert.equal(row.checkpoint.build.commits, 2);
    assert.equal(row.checkpoint.build.specMd, SPEC, 'with the spec it was built from');
    assert.equal(row.checkpoint.handedBackAt, 2);
    assert.equal(await spent(side.run.id), 0.6);

    // The next claim, through the real lane and stage: the worker and the
    // screenshot step are fakes, and no turn may run.
    const { rows: [claim] } = await pool.query(
      `UPDATE bench_trials SET status = 'running', claims = claims + 1, started_at = NOW()
        WHERE id = $1 AND status = 'pending' RETURNING id, run_id`, [side.id],
    );
    const ensured = [];
    const fakeWorker = {
      async ensureWorkerImage() {},
      async ensureWorker(id, opts) { ensured.push({ id: Number(id), branch: opts.branchName, pinnedBase: opts.pinnedBase }); return `w-${id}`; },
      async execInWorker() { throw new Error('no turn runs again'); },
      async stopTurn() {},
      async evictWorker() {},
    };
    const capture = require('../src/services/bench/capture');
    const realCapture = capture.captureTrial;
    capture.captureTrial = async () => ({ ok: true, capture: { booted: true, shots: [] } });
    let status;
    try {
      status = await lane.executeTrial(pool, {}, claim, {
        user: { id: user.id, username: 'homeroom_bench' }, worker: fakeWorker, github: githubModule,
        limits, managedOpenRouter: managedKeys, afterTrial: async () => {},
      });
    } finally {
      capture.captureTrial = realCapture;
    }
    assert.equal(status, 'ok');
    const done = (await pool.query(
      `SELECT status, claims, cost_usd::float8 AS cost, interrupted_cost_usd::float8 AS interrupted, build_sha, build_commits,
              parsed, capture, session_id FROM bench_trials WHERE id = $1`, [side.id],
    )).rows[0];
    assert.equal(done.status, 'ok');
    assert.equal(done.claims, 1, 'only the claim that finished it counted');
    assert.equal(done.build_sha, 'd'.repeat(40));
    assert.equal(done.build_commits, 2);
    assert.equal(done.parsed.built, true);
    assert.equal(done.parsed.spec, SPEC);
    assert.equal(done.parsed.resumedAfterRestart, 1);
    assert.deepEqual(done.parsed.side, { botRunId: side.botRunId });
    assert.equal(done.capture.booted, true);
    assert.equal(ensured.length, 1, 'one worker, for its screenshots');
    assert.notEqual(ensured[0].id, sid, 'on a fresh session: the build\'s worker went with the restart');
    assert.equal(ensured[0].branch, side.branch);
    assert.equal(ensured[0].pinnedBase, BASE, 'sealed at the base, as every worker of a trial is');
    assert.equal(done.cost, 0.6, 'its own cost: the spec and the build it is built from');
    assert.equal(done.interrupted, 0);
    assert.equal(await spent(side.run.id), 0.6, 'every session charged to the run exactly once');
    assert.ok(gh.deleted.includes(side.branch), 'a first version\'s side build keeps no branch');
    const { rows: [result] } = await pool.query(
      'SELECT status, built, booted, sha, trial_id FROM bot_config_results WHERE bot_run_id = $1 AND config_version_id = $2',
      [side.botRunId, side.versionId],
    );
    assert.deepEqual(result, { status: 'done', built: true, booted: true, sha: 'd'.repeat(40), trial_id: side.id },
      'its configuration\'s result recorded, for its pairs');
    row = await fvRow(side.id);
    assert.equal(row.status, 'ok');
  });

  await t.test('a side build whose worker is gone is released as before: a claim spent, then failed after a second', async () => {
    reset();
    const side = await sideTrial();
    const s1 = await newSession(turnOf('build'));
    await claimAs(side.id, s1);
    await keep(side.id, { sessions: [s1] });
    await spend(s1, 0.4);
    await adopt(s1, 'exited');
    assert.equal(workerCalls.filter((c) => c[0] === 'resume').length, 0, 'an exited worker is not followed');
    let row = await fvRow(side.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.claims, 1, 'nothing was kept: this one counts');
    assert.equal(row.interrupted, 0.4, 'the lost turn is the interrupted cost');

    const s2 = await newSession(turnOf('build'));
    await claimAs(side.id, s2, { claims: 2 });
    await adopt(s2, 'exited');
    row = await trialRow(side.id);
    assert.equal(row.status, 'infra_fail');
    assert.match(row.error, /restarted during it twice/);
  });

  await t.test('a side build\'s review fix turn is followed on what was left of the review\'s minutes, and handed back with no claim spent', async () => {
    reset();
    const side = await sideTrial();
    const sid = await newSession(turnOf('build'));
    await claimAs(side.id, sid);
    const reviewStarted = new Date(Date.now() - 18 * 60 * 1000).toISOString();
    const review = {
      state: 'reviewing', startedAt: reviewStarted, reviewer: { model: 'anthropic/claude-opus-5.5', maxRounds: 2, budgetMinutes: 20 },
      rounds: [{ round: 1, verdict: 'fix', reviewerCostUsd: 0.1 }], finalSha: 'd'.repeat(40), finalCommits: 2,
      lastBooted: { sha: 'd'.repeat(40), commits: 2 },
    };
    // The claim before kept the spec and the build; this one began the review.
    await keep(side.id, {
      sessions: [sid], spec: { sessionId: sid, specMd: SPEC },
      build: { ok: true, sessionId: sid, sha: 'd'.repeat(40), commits: 2, specMd: SPEC }, review,
      handBacks: 1, handedBackAt: 2,
    });
    await spend(sid, 0.3);
    const fixStart = new Date().toISOString();
    assert.equal(await lane.recoveryDeadline(pool, {}, await sessionOf(sid), turnOf('build', { startedAt: fixStart })),
      Date.parse(reviewStarted) + 20 * 60 * 1000, 'a fix never runs past the review\'s own minutes');
    journalTail = async () => ({ pushOk: true, ahead: 3, sha: 'e'.repeat(40), exitCode: 0, resultSeen: true });
    await adopt(sid);
    assert.ok(workerCalls.some((c) => c[0] === 'resume'), 'followed to its end');
    const row = await fvRow(side.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.claims, 0, 'its review was kept work: no claim spent');
    assert.equal(row.checkpoint.build.sha, 'd'.repeat(40), 'a fix is not the build: nothing new kept');
    assert.equal(row.checkpoint.review.state, 'reviewing', 'left for the next claim to carry on');
    assert.equal(row.checkpoint.recoveredFix.sha, 'e'.repeat(40), 'with what its fix did, which the review was waiting on');
    assert.equal(row.checkpoint.recoveredFix.ok, true);
    assert.equal(row.checkpoint.handedBackAt, 5, 'its spec, build and review, the review\'s round, and the fix');
    assert.deepEqual(outward, []);
  });

  await t.test('a first version\'s review fix turn is told from its build, followed on what was left of the review\'s minutes, and handed back with no claim spent', async () => {
    reset();
    const fvf = await firstVersionTrial();
    const triSid = await newSession(null);
    // Paused, as its build turn left it (buildTurnRunner): a fix turn runs on
    // it so, and until 13 Oct 2026 its worker was destroyed here unfollowed.
    const sid = await newSession(turnOf('build'), { status: 'paused' });
    await claimAs(fvf.id, sid);
    const reviewStarted = new Date(Date.now() - 18 * 60 * 1000).toISOString();
    const review = {
      state: 'reviewing', startedAt: reviewStarted, reviewer: { model: 'anthropic/claude-opus-5.5', maxRounds: 2, budgetMinutes: 20 },
      rounds: [{ round: 1, verdict: 'fix', reviewerCostUsd: 0.1 }], finalSha: 'd'.repeat(40), finalCommits: 2,
      lastBooted: { sha: 'd'.repeat(40), commits: 2 },
    };
    // This claim kept its build as it pushed, then began the review: until
    // 13 Oct 2026 a first version kept neither, and a restart in the review
    // either built it again or took the fix for the build.
    await keep(fvf.id, {
      triageSessionId: triSid, sessions: [triSid, sid],
      triage: { status: 'ok', session_id: triSid, parsed: { verdict: 'ready', buildNote: 'One board.' } },
      spec: { sessionId: sid, specMd: SPEC },
      build: { ok: true, sessionId: sid, sha: 'd'.repeat(40), commits: 2, specMd: SPEC }, review,
    });
    await spend(sid, 0.3);
    const fixStart = new Date().toISOString();
    assert.equal(await lane.recoveryDeadline(pool, {}, await sessionOf(sid), turnOf('build', { startedAt: fixStart })),
      Date.parse(reviewStarted) + 20 * 60 * 1000, 'a fix never runs past the review\'s own minutes');
    journalTail = async () => ({ pushOk: true, ahead: 3, sha: 'e'.repeat(40), exitCode: 0, resultSeen: true });
    await adopt(sid);
    assert.ok(workerCalls.some((c) => c[0] === 'resume'), 'followed to its end, though its session was paused');
    const row = await fvRow(fvf.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.claims, 0, 'its review was kept work: no claim spent');
    assert.equal(row.checkpoint.build.sha, 'd'.repeat(40), 'a fix is not the build: nothing new kept');
    assert.equal(row.checkpoint.review.state, 'reviewing', 'left for the next claim to carry on');
    assert.equal(row.checkpoint.recoveredFix.sha, 'e'.repeat(40), 'with what its fix did, as a live first version keeps it');
    assert.deepEqual(outward, []);
  });

  await t.test('a later change\'s side build\'s spec turn is followed on a later build\'s clock and kept', async () => {
    reset();
    const side = await sideTrial({ scope: 'later' });
    const sid = await newSession(turnOf('scout'));
    await claimAs(side.id, sid);
    await keep(side.id, { sessions: [sid] });
    const later = await budgetsOf('build');
    assert.equal(await lane.recoveryDeadline(pool, {}, await sessionOf(sid), turnOf('scout', { startedAt })),
      at + Math.min(later.buildMs, later.specMs), 'a later build\'s spec clock, not a first version\'s');
    assert.equal(await lane.recoveryDeadline(pool, {}, await sessionOf(sid), turnOf('build', { startedAt })), at + later.buildMs);
    assert.equal((await lane.recoveryPlan(pool, await sessionOf(sid), turnOf('scout'))).resumable, true,
      'unlike a benchmark build\'s spec turn');
    journalTail = async () => ({ lastResultText: SPEC, exitCode: 0, resultSeen: true });
    await adopt(sid);
    const row = await fvRow(side.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.claims, 0);
    const { turnId: specTurnId, ...keptSpec } = row.checkpoint.spec;
    assert.deepEqual(keptSpec, { sessionId: sid, specMd: SPEC });
    assert.match(specTurnId, /^turn-/, 'with its turn\'s ledger id, so what it cost can still be named');
    assert.deepEqual(outward, []);
  });
});
