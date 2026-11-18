'use strict';

// The retention SQL against PostgreSQL, including the JSONB completion
// marker the shots machine's cleanup writes on a run's row once its copies
// are gone (src/workflow/shots/: shots.cleanup). A run whose copies may
// still exist keeps its row; one the proposal still points at is kept
// whatever its age. All fixtures are temporary tables in a rolled-back tx.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const gc = require('../src/services/shots-gc');
const { RESOURCE_CLEANUP_VERSION } = require('../src/services/shots-environment');

test('retention prunes old terminal runs whose copies are gone, and keeps the rest', async (t) => {
  const client = new Client({
    connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
    connectionTimeoutMillis: 2000,
  });
  try { await client.connect(); } catch (error) {
    await client.end();
    if (process.env.TEST_DATABASE_URL) throw error;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  t.after(async () => { try { await client.query('ROLLBACK'); } finally { await client.end(); } });
  await client.query(`BEGIN;
    CREATE TEMP TABLE chat_sessions (id int PRIMARY KEY, app_id int, shots_run_id text, shots_detail jsonb) ON COMMIT DROP;
    CREATE TEMP TABLE shot_runs (
      id varchar(32) PRIMARY KEY, session_id int, state text, failure_code text,
      trace_summary jsonb, completed_at timestamptz, updated_at timestamptz
    ) ON COMMIT DROP;
    CREATE TEMP TABLE shot_artifacts (run_id varchar(32)) ON COMMIT DROP;
    INSERT INTO chat_sessions VALUES (42, 1, repeat('7', 32),
      jsonb_build_object('previous', jsonb_build_object('runId', repeat('8', 32))));`);
  const id = (n) => n.toString(16).repeat(32);
  const old = new Date(Date.now() - 40 * 86_400_000);
  const fresh = new Date();
  const cleaned = { cleanupComplete: true, cleanupVersion: RESOURCE_CLEANUP_VERSION };
  const cases = [
    [1, 'cancelled', null, old],                                 // its cleanup has not finished
    [2, 'stale', cleaned, old],                                  // gone
    [3, 'verified', cleaned, old],                               // published shots are kept
    [4, 'failed', { cleanupComplete: true, cleanupVersion: 1 }, old],   // an older cleanup version
    [5, 'failed', cleaned, fresh],                               // not old enough
    [7, 'stale', cleaned, old],                                  // the proposal still points at it
    [8, 'stale', cleaned, old],                                  // its card shows it as the previous version's
  ];
  for (const [n, state, trace, updated] of cases) {
    await client.query('INSERT INTO shot_runs VALUES ($1, 42, $2, NULL, $3, $4, $4)', [id(n), state, trace, updated]);
  }
  await gc.prune(client);
  const { rows } = await client.query('SELECT id FROM shot_runs ORDER BY id');
  const kept = new Set(rows.map((row) => row.id));
  assert.ok(kept.has(id(1)), 'unfinished cleanup keeps its durable row');
  assert.ok(!kept.has(id(2)), 'old cleaned metadata is pruned');
  assert.ok(kept.has(id(3)), 'a verified run is never pruned');
  assert.ok(kept.has(id(4)), 'a cleanup an older version marked is not trusted');
  assert.ok(kept.has(id(5)), 'a recent run is kept');
  assert.ok(kept.has(id(7)), 'the current session-owned run is retained');
  assert.ok(kept.has(id(8)), 'the run the card shows as the previous version\'s is retained');
});
