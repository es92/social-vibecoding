'use strict';
require('./lib/media-store').useMemoryMedia(require('node:test'));
const { fixtureKey } = require('./lib/media-store');

// How the admin connector reads the before & after shots of merged
// proposals (routes/gallery.js shotsStats, services/bench/connector-data.js
// recentShots), against the REAL schema in a throwaway PostgreSQL database.
// Reading the 200 proposals merged 2026-10-09 to 10-12 showed a change whose
// before and after came out the same read as plain ready, a run that shot
// one change of three read as a success, and the stats counted the retired
// route-capture pipeline over all time. Pinned here: a run's changes are
// listed with how each came out and counted; the stats cover only proposals
// merged in the window, by how their shots ended, how their current runs'
// changes came out, whether noted problems are also on the before build,
// and why runs failed. Skipped when no server is reachable, and required
// when TEST_DATABASE_URL is set, the same contract as the other *-postgres
// suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

const { seedStagingShotsNoticed } = require('../src/db/migrate');
const planContract = require('../src/services/visible-changes');
const shotsState = require('../src/services/shots-state');
const gallery = require('../src/routes/gallery');
const connectorData = require('../src/services/bench/connector-data');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const APP = 'staging-demo-gallery-app';
const BASE = 'c'.repeat(40);
const HEAD = 'd'.repeat(40);

const savedEnvironment = process.env.USERNODE_ENV;
test.after(() => {
  if (savedEnvironment === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = savedEnvironment;
});

function intentOf(ids) {
  return planContract.parseIntent({
    version: 1,
    impact: 'ui',
    rationale: 'Staging demo: the board changes.',
    stories: ids.map((id) => ({
      id,
      claim: `Staging demo: the board shows ${id}.`,
      persona: 'member',
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      intent: {
        startPath: '/board', steps: ['Open the board'], checkpoint: 'The board is open',
        focus: 'The board', baseState: 'present', animation: 'none',
      },
    })),
  });
}

// One merged proposal `days` days ago, with its current run when it has one,
// as a settled run leaves both.
async function merged(pool, { id, appId = 900106, days, run = null }) {
  const runId = run ? `${id}`.padEnd(32, 'f') : null;
  const row = run ? {
    id: runId, state: run.state, intent: run.intent, base_sha: BASE, head_sha: HEAD,
    plan_hash: run.verdict ? 'e'.repeat(64) : null,
    hard_verdict: run.verdict || null, failure_code: run.failureCode || null,
  } : null;
  const detail = run ? { ...shotsState.runSummary(row), intent: run.intent } : null;
  await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_number, pr_title, status, promoted_at, merged_at,
        reviewed_head_sha, shots_state, shots_run_id, shots_detail, shots_updated_at)
     SELECT $1::int, $2::int, u.id, 'staging-demo/results', $1::int, 'Staging demo results', 'merged',
            NOW() - ($3::int * interval '1 day') - interval '1 hour', NOW() - ($3::int * interval '1 day'),
            $4::varchar, $5::varchar, $6::varchar, $7::jsonb, NOW()
       FROM users u WHERE u.username = 'staging-demo-user'`,
    [id, appId, days, HEAD, run ? run.state : null, runId, detail ? JSON.stringify(detail) : null]
  );
  if (!run) return;
  await pool.query(
    `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, plan_hash, intent, hard_verdict, state,
                            failure_code, trigger, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, 'test', NOW(), NOW())`,
    [runId, id, BASE, HEAD, row.plan_hash, JSON.stringify(run.intent),
      run.verdict ? JSON.stringify(run.verdict) : null, run.state, run.failureCode || null]
  );
}

test('the connector lists each change\'s result and counts the window\'s current shots (PostgreSQL)', async (t) => {
  const root = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await root.connect(); }
  catch (err) {
    await root.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`Local test database unavailable: ${err.code}`);
  }
  const database = `shots_results_${crypto.randomBytes(6).toString('hex')}`;
  let pool;
  try {
    await root.query(`CREATE DATABASE ${database}`);
    const url = new URL(DSN); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.toString() });
    pool.on('error', () => {});
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    await pool.query(`INSERT INTO users (username, password) VALUES ('staging-demo-user', 'staging-demo-not-a-login')`);
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, view_visibility, created_by)
       SELECT v.id, v.name, v.slug, 'awaiting_secrets', 'public', u.id
         FROM users u, (VALUES (900106, 'Staging demo gallery app', '${APP}'),
                               (900107, 'Staging demo other app', 'staging-demo-other-app')) AS v(id, name, slug)
        WHERE u.username = 'staging-demo-user'`
    );

    // Merged an hour ago: one ready change, and two problems noted, one
    // also on the before build and one not.
    process.env.USERNODE_ENV = 'staging';
    await seedStagingShotsNoticed(pool);
    // Two days ago: one change came out the same on both sides, one skipped.
    await merged(pool, { id: 900120, days: 2, run: {
      state: 'verified', intent: intentOf(['board-sort', 'board-filter']),
      verdict: { passed: true, mode: 'shots', runs: 1, stories: [
        { id: 'board-sort', status: 'ready', files: 2, unchanged: true, note: 'any visible difference.' },
        { id: 'board-filter', status: 'skipped', reason: 'Staging demo: needs a second list.' },
      ], notices: [
        { text: 'Staging demo: a heading is cut off.', change: 'board-sort', screen: 'desktop', shot: null, alsoBefore: 'unknown' },
      ] },
    } });
    // A day ago: the shots agent stopped before it saved anything.
    await merged(pool, { id: 900121, days: 1, run: {
      state: 'failed', intent: intentOf(['board-sort']), failureCode: 'shots_agent_failed',
    } });
    // A day ago, with no shots at all.
    await merged(pool, { id: 900122, days: 1 });
    // A month ago: outside the default window.
    await merged(pool, { id: 900123, days: 30, run: {
      state: 'verified', intent: intentOf(['board-sort']),
      verdict: { passed: true, mode: 'shots', runs: 1, stories: [{ id: 'board-sort', status: 'ready', files: 2 }] },
    } });
    // Another app, a day ago.
    await merged(pool, { id: 900124, appId: 900107, days: 1, run: {
      state: 'verified', intent: intentOf(['board-sort']),
      verdict: { passed: true, mode: 'shots', runs: 1, stories: [{ id: 'board-sort', status: 'ready', files: 2 }] },
    } });

    // The listing: each change with how it came out, and the counts.
    const recent = await connectorData.recentShots(pool, { app: APP });
    const listed = new Map(recent.proposals.map((p) => [p.sessionId, p.shots]));
    assert.deepEqual(listed.get(900120).changes, { declared: 2, ready: 0, unchanged: 1, skipped: 1, failed: 0 });
    assert.deepEqual(listed.get(900120).claims.map((c) => [c.id, c.status]),
      [['board-sort', 'unchanged'], ['board-filter', 'skipped']]);
    assert.deepEqual(listed.get(900108).changes, { declared: 1, ready: 1, unchanged: 0, skipped: 0, failed: 0 });
    assert.deepEqual(listed.get(900121).changes, { declared: 1, ready: 0, unchanged: 0, skipped: 0, failed: 0 },
      'a run that stopped before it saved anything has no results to count');

    // The stats: the last week of one app's merged proposals.
    const week = await gallery.shotsStats(pool, { app: APP });
    assert.equal(week.window.days, 7);
    assert.equal(week.proposals, 4, 'the month-old proposal and the other app are left out');
    assert.deepEqual(week.shots, {
      verified: 2, failed: 1, notRequired: 0, overridden: 0, cancelled: 0, stale: 0, inFlight: 0, none: 1,
    });
    assert.deepEqual(week.changes, { declared: 4, ready: 1, unchanged: 1, skipped: 1, failed: 0 });
    assert.deepEqual(week.notices, { total: 3, alsoBefore: 1, notBefore: 1, unknown: 1 });
    assert.deepEqual(week.failureCodes, { shots_agent_failed: 1 });

    // By the app's id, over a longer window, and across every app.
    const twoMonths = await gallery.shotsStats(pool, { app: '900106', days: 60 });
    assert.equal(twoMonths.proposals, 5);
    assert.equal(twoMonths.changes.ready, 2);
    const everyApp = await gallery.shotsStats(pool, {});
    assert.equal(everyApp.proposals, 5);
    assert.equal(everyApp.shots.verified, 3);

    // And through the connector's own read.
    const viaConnector = await connectorData.shotStats(pool, { app: APP, problem: 'root_only', days: '3' });
    assert.equal(viaConnector.stats.window.days, 3);
    assert.equal(viaConnector.stats.proposals, 4, 'the capture-problem filter does not narrow the stats');
  } finally {
    if (pool) await pool.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  }
});
