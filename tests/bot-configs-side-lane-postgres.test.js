'use strict';

// The Homeroom bot configurations' side builds on the App bench lane
// (src/services/bench/lane.js, src/services/bot-configs.js), against the
// FULL PostgreSQL schema, as they stood on 9 Oct 2026 and since:
//
//   - a side build its run's cap stops is finished, its result skipped with
//     why ("capped: ..."), and counted; before, capRun left it pending for
//     good, never paired and never counted (9 of the last 50);
//   - one already left that way, or cancelled by an admin, is settled on the
//     lane's next pass; one this process still holds is left to its own
//     finisher;
//   - a side build going on from what it kept after a restart is counted at
//     what is still to come of its estimate, so it is not capped for spend it
//     already had; spend a restart threw away is still counted;
//   - a side build's branch is kept while its pair waits for a pick (up to
//     BRANCH_KEEP_WAITING_DAYS), and goes at seven days once it does not;
//   - the pairs waiting per scope, which the Homeroom bot console's Overview
//     shows.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const lane = require('../src/services/bench/lane');
const runner = require('../src/services/bench/runner');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const OPUS = 'anthropic/claude-opus-5.5';
const GLM = 'z-ai/glm-5.3-flash';
const BASE = 'a'.repeat(40);

test('keptSpend: what a checkpoint\'s kept work was charged, never what a restart threw away', () => {
  assert.equal(lane.keptSpend(null), 0);
  assert.equal(lane.keptSpend({}), 0);
  const cp = {
    spec: { sessionId: 11, specMd: '# Plan' }, build: { sessionId: 12, sha: 'b'.repeat(40) },
    sessions: [10, 11, 12], charged: { 10: 0.5, 11: 0.25, 12: 0.5 },
  };
  assert.equal(lane.keptSpend(cp), 0.75, 'the spec and the build it kept, not session 10 whose work was thrown away');
  assert.equal(lane.keptSpend({ ...cp, build: null }), 0.25);
  assert.equal(lane.keptSpend({ spec: { sessionId: 11 }, charged: {} }), 0, 'kept, but not charged yet');
});

test('side builds on the App bench lane against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bot_configs_side_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const realRunStage = runner.runStage;
  t.after(async () => {
    runner.runStage = realRunStage;
    lane._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  const CATALOG = [
    { id: GLM, pricing: { prompt: '0.0000001', completion: '0.0000004' }, architecture: { input_modalities: ['text'] } },
    { id: OPUS, pricing: { prompt: '0.000005', completion: '0.000025' }, architecture: { input_modalities: ['text', 'image'] } },
  ];
  await pool.query('INSERT INTO openrouter_model_catalog (id, models, fetched_at) VALUES (TRUE, $1::jsonb, NOW())', [JSON.stringify(CATALOG)]);
  const configs = require('../src/services/bot-configs');
  const snapshots = require('../src/services/homeroom-bot-snapshots');
  await configs.seedConfigs(pool);
  const laterCurrent = await configs.currentVersion(pool, 'later');
  const [laterGlm] = await configs.sideVersions(pool, 'later');

  const { rows: [user] } = await pool.query(
    "INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bench', 'x', TRUE) RETURNING id, username",
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/usernode-bot/todo')
     RETURNING id, slug, name, repo_url`,
  );

  let ran = [];
  runner.runStage = async ({ trial }) => {
    ran.push(trial.id);
    return { status: 'ok', cost_usd: 0.1, parsed: { built: true }, duration_ms: 5 };
  };
  const deleted = [];
  const deps = {
    user,
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    isLiveLaneSaturated: () => false,
    github: { isEnabled: () => true, async deleteBenchBranch(_o, _r, branch) { deleted.push(branch); } },
    worker: { async stopTurn() {} },
    afterTrial: async () => {},
  };

  // A later change, built live by the current configuration, with its side
  // build queued on the lane at $0.40, its run capped at three times that.
  let issue = 0;
  const sideBuild = async () => {
    issue += 1;
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, cost_usd, duration_ms, model, bot_config_version_id)
       VALUES ($1, $2, 'live', 'ready', 'Add a dark look.', 0.03, 60000, $3, $4) RETURNING id`,
      [app.id, issue, GLM, laterCurrent.id],
    );
    const snapshotId = await snapshots.recordSnapshot(pool, {
      runId: run.id, stage: 'build', appId: app.id, issueNumber: issue, baseSha: BASE,
      texts: { seed: `Issue #${issue}: Dark mode`, build_note: 'Add a dark look.' },
      extra: { firstVersion: false, model: GLM, specModel: OPUS },
    });
    const out = await configs.spawnSideBuilds(pool, {}, {
      botRunId: run.id, app, snapshotId, current: laterCurrent, scope: 'later', deps: { lane: { wake() {} } },
    });
    assert.equal(out.trials, 1);
    const { rows: [trial] } = await pool.query('SELECT id, run_id FROM bench_trials WHERE bot_run_id = $1', [run.id]);
    await pool.query('UPDATE bench_trials SET est_cost_usd = 0.4 WHERE id = $1', [trial.id]);
    await pool.query('UPDATE bench_runs SET cap_usd = 1.2 WHERE id = $1', [trial.run_id]);
    return { botRunId: run.id, trialId: trial.id, benchRunId: trial.run_id };
  };
  const resultOf = async (botRunId) => (await pool.query(
    "SELECT status, error, trial_id FROM bot_config_results WHERE bot_run_id = $1 AND source = 'trial'", [botRunId],
  )).rows[0];
  const trialOf = async (id) => (await pool.query('SELECT status, error FROM bench_trials WHERE id = $1', [id])).rows[0];
  // A restart handed the trial back: what its sessions spent is charged to
  // its run, and its checkpoint says which of them did work it keeps.
  const handedBack = (s, { kept }) => pool.query(
    `UPDATE bench_trials SET claims = 1, prior_ms = 600000,
            checkpoint = $2::jsonb, interrupted_cost_usd = $3
      WHERE id = $1`,
    [s.trialId, JSON.stringify({
      ...(kept ? { spec: { sessionId: 901, specMd: '# Dark mode' } } : {}),
      sessions: [901], charged: { 901: 1.0 },
    }), kept ? 0 : 1.0],
  ).then(() => pool.query('UPDATE bench_runs SET spent_usd = 1.0 WHERE id = $1', [s.benchRunId]));

  await t.test('a side build its run\'s cap stops is finished skipped, with why, and counted', async () => {
    lane._resetForTests();
    const s = await sideBuild();
    // A restart threw its work away after it had spent $1.00 of its $1.20:
    // the $0.40 it needs again does not fit.
    await handedBack(s, { kept: false });
    const out = await lane.tick(pool, {}, deps);
    assert.equal(out.paused, 'cap');
    assert.equal((await trialOf(s.trialId)).status, 'skipped_cap');
    const r = await resultOf(s.botRunId);
    assert.equal(r.status, 'skipped', 'not left pending for good');
    assert.equal(r.error, 'capped: its run had spent $1.00 of its $1.20 cap');
    const stats = await configs.listWithStats(pool, { scope: 'later' });
    assert.equal(stats.sideBuilds.skipped, 1, 'counted with the side builds that never ran');
    const { rows: pairs } = await pool.query('SELECT 1 FROM bot_config_pairs WHERE bot_run_id = $1', [s.botRunId]);
    assert.equal(pairs.length, 0, 'never offered');
  });

  await t.test('a side build going on from what it kept is counted at what is still to come, not capped for what it spent', async () => {
    lane._resetForTests();
    ran = [];
    const s = await sideBuild();
    // The same $1.00 spent, on a plan the restart kept: what is still to
    // come is less than its whole $0.40 estimate, and fits what is left.
    await handedBack(s, { kept: true });
    const out = await lane.tick(pool, {}, deps);
    assert.equal(out.started, 1, `claimed, not capped (${out.paused})`);
    assert.equal(lane._inFlightForTests().get(s.trialId).est, 0, 'held at what is still to come');
    await lane._awaitTrialsForTests();
    assert.deepEqual(ran, [s.trialId]);
    assert.equal((await trialOf(s.trialId)).status, 'ok');
    assert.equal((await resultOf(s.botRunId)).status, 'done');
    // A run that had spent all its cap is still stopped, kept work or not.
    const over = await sideBuild();
    await handedBack(over, { kept: true });
    await pool.query('UPDATE bench_runs SET spent_usd = 1.3 WHERE id = $1', [over.benchRunId]);
    await lane.tick(pool, {}, deps);
    assert.equal((await trialOf(over.trialId)).status, 'skipped_cap');
    assert.match((await resultOf(over.botRunId)).error, /^capped: its run had spent \$1\.30 of its \$1\.20 cap$/);
  });

  await t.test('one left pending before, or cancelled by an admin, is settled on the next pass; one in flight is left alone', async () => {
    lane._resetForTests();
    // As capRun left them before: the trial skipped, its result pending.
    const before = await sideBuild();
    await pool.query("UPDATE bench_trials SET status = 'skipped_cap', finished_at = NOW() WHERE id = $1", [before.trialId]);
    await pool.query("UPDATE bench_runs SET status = 'capped', spent_usd = 1.15 WHERE id = $1", [before.benchRunId]);
    const cancelled = await sideBuild();
    assert.deepEqual(await lane.cancelTrial(pool, cancelled.trialId, deps), { ok: true, status: 'cancelled' });
    const held = await sideBuild();
    await pool.query("UPDATE bench_trials SET status = 'ok', finished_at = NOW() WHERE id = $1", [held.trialId]);
    lane._inFlightForTests().set(held.trialId, { runId: held.benchRunId, est: 0.4 });
    assert.equal((await resultOf(before.botRunId)).status, 'pending');

    assert.equal(await lane.settleSideResults(pool), 2);
    assert.deepEqual(Object.values(await resultOf(before.botRunId)).slice(0, 2), ['skipped', 'capped: its run had spent $1.15 of its $1.20 cap']);
    assert.deepEqual(Object.values(await resultOf(cancelled.botRunId)).slice(0, 2), ['skipped', 'cancelled by an admin']);
    assert.equal((await resultOf(held.botRunId)).status, 'pending', 'its own finisher records it');
    lane._inFlightForTests().delete(held.trialId);
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [held.benchRunId]);
    assert.equal(await lane.settleSideResults(pool), 1, 'once nothing holds it');
    assert.equal(await lane.settleSideResults(pool), 0, 'once');
    // The lane's own pass runs it.
    const later = await sideBuild();
    await pool.query("UPDATE bench_trials SET status = 'skipped_cap', finished_at = NOW() WHERE id = $1", [later.trialId]);
    await pool.query("UPDATE bench_runs SET status = 'capped' WHERE id = $1", [later.benchRunId]);
    await lane.tick(pool, {}, deps);
    assert.equal((await resultOf(later.botRunId)).status, 'skipped');
  });

  await t.test('a side build\'s branch is kept while its pair waits for a pick, and not for good', async () => {
    lane._resetForTests();
    deleted.length = 0;
    const branchOf = (s) => `bench/r${s.benchRunId}-t${s.trialId}`;
    // Built, finished `days` ago, with its pair `pair` (or none).
    const finished = async (days, pair) => {
      const s = await sideBuild();
      await pool.query(
        `UPDATE bench_trials SET status = 'ok', build_branch = $2, build_commits = 1, build_sha = $3,
                finished_at = NOW() - make_interval(days => $4)
          WHERE id = $1`,
        [s.trialId, branchOf(s), 'd'.repeat(40), days],
      );
      await pool.query("UPDATE bench_runs SET status = 'done' WHERE id = $1", [s.benchRunId]);
      if (!pair) return s;
      const cur = await configs.recordResult(pool, {
        botRunId: s.botRunId, configVersionId: laterCurrent.id, source: 'live', built: true, sha: `live${s.botRunId}`,
      });
      const side = await configs.recordResult(pool, {
        botRunId: s.botRunId, configVersionId: laterGlm.id, source: 'trial', trialId: s.trialId, built: true, sha: 'd'.repeat(40),
      });
      await pool.query(
        `INSERT INTO bot_config_pairs (token, bot_run_id, current_result_id, side_result_id, left_is_current, status, pick)
         VALUES ($1, $2, $3, $4, TRUE, $5, $6)`,
        [crypto.randomBytes(12).toString('base64url'), s.botRunId, cur, side, pair, pair === 'picked' ? 'side' : null],
      );
      return s;
    };
    const waiting = await finished(8, 'waiting');
    const picked = await finished(8, 'picked');
    const alone = await finished(8, null);
    const young = await finished(2, null);
    const stale = await finished(lane.BRANCH_KEEP_WAITING_DAYS + 1, 'waiting');
    await lane.sweepBranches(pool, { ...deps, force: true });
    assert.deepEqual(deleted.sort(), [branchOf(picked), branchOf(alone), branchOf(stale)].sort());
    const gone = async (s) => !!(await pool.query('SELECT branch_deleted_at FROM bench_trials WHERE id = $1', [s.trialId])).rows[0].branch_deleted_at;
    assert.equal(await gone(waiting), false, 'its pair waits: the compare link still opens');
    assert.equal(await gone(young), false);
    assert.equal(await gone(stale), true, 'not kept for good');
    // Picked, it goes on the next sweep.
    await pool.query("UPDATE bot_config_pairs SET status = 'picked', pick = 'tie' WHERE side_result_id = (SELECT id FROM bot_config_results WHERE trial_id = $1)", [waiting.trialId]);
    await lane.sweepBranches(pool, { ...deps, force: true });
    assert.equal(await gone(waiting), true);
  });

  await t.test('the pairs waiting for a pick, per scope', async () => {
    assert.deepEqual(await configs.pairsWaitingByScope(pool), { first_version: 0, later: 1 }, 'the stale one still waits');
    await pool.query("UPDATE bot_config_pairs SET status = 'picked', pick = 'current' WHERE status = 'waiting'");
    assert.deepEqual(await configs.pairsWaitingByScope(pool), { first_version: 0, later: 0 });
    assert.equal(await configs.pairsWaitingByScope({ async query() { throw new Error('down'); } }), null);
  });
});
