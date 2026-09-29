'use strict';

// Exercise the actual import transaction's SQL with PostgreSQL. A recording
// client cannot catch parameter-type errors or a declaration that is lost
// between the uncommitted proposal row and its evidence pointer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const state = require('../src/services/visual-evidence-state');
const contract = require('../src/services/visual-evidence-plan');
const fixtures = require('./fixtures/visual-evidence');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://usernode:localdev@127.0.0.1:5440/usernode';

test('the declaration and the proposal pointer commit together on real PostgreSQL', async (t) => {
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
  } catch (error) {
    t.skip(`PostgreSQL unavailable: ${error.code || error.message}`);
    return;
  }
  const schema = `visual_evidence_import_${process.pid}_${Date.now()}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(`CREATE TABLE chat_sessions (
      id INTEGER PRIMARY KEY, visual_evidence_state VARCHAR(24),
      visual_evidence_run_id VARCHAR(32), visual_evidence_detail JSONB,
      visual_evidence_updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE visual_evidence_runs (
      id VARCHAR(32) PRIMARY KEY, session_id INTEGER NOT NULL,
      base_sha VARCHAR(40) NOT NULL, head_sha VARCHAR(40) NOT NULL,
      plan_version INTEGER NOT NULL, intent JSONB NOT NULL,
      state VARCHAR(24) NOT NULL,
      trigger VARCHAR(32), failure_code VARCHAR(48), failure_reason TEXT,
      completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    // The import inserts the proposal row and records its declaration on the
    // same checked-out client, before COMMIT: the row is invisible to any
    // other connection, so this is the only client that can write it.
    await client.query('INSERT INTO chat_sessions (id) VALUES (42)');
    const headSha = 'b'.repeat(40);
    const declared = fixtures.motionIntent();
    const recorded = await state.recordIntentInTransaction(client, 42, declared, { headSha });
    assert.equal(recorded.accepted, true);
    assert.equal(recorded.unchanged, false);
    assert.equal(recorded.state, 'planned');
    assert.equal(recorded.runId, null, 'the preview agent\'s run is created later, not by the import');

    const row = (await client.query(
      `SELECT visual_evidence_state, visual_evidence_run_id, visual_evidence_detail
         FROM chat_sessions WHERE id = 42`
    )).rows[0];
    assert.equal(row.visual_evidence_state, 'planned');
    assert.equal(row.visual_evidence_run_id, null);
    assert.deepEqual(row.visual_evidence_detail.intent, contract.parseIntent(declared),
      'the strictly parsed declaration survives the JSONB round trip');
    assert.equal(row.visual_evidence_detail.headSha, headSha);
    assert.equal(row.visual_evidence_detail.required, true);
    assert.deepEqual(row.visual_evidence_detail.claims.map((claim) => claim.id),
      ['invite-suggestions', 'saved-toast']);
    assert.equal(Object.hasOwn(row.visual_evidence_detail, 'authorPlan'), false);
    const runs = await client.query('SELECT count(*)::int AS n FROM visual_evidence_runs');
    assert.equal(runs.rows[0].n, 0, 'an import stores the declaration and no run');

    // A retried import of the same declaration is idempotent.
    const again = await state.recordIntentInTransaction(client, 42, declared, { headSha });
    assert.equal(again.unchanged, true);

    // A changed declaration cancels active work for the proposal, so shots
    // of the old declaration can never publish as current.
    await client.query(
      `INSERT INTO visual_evidence_runs (id, session_id, base_sha, head_sha, plan_version, intent, state)
       VALUES ($1, 42, $2, $3, 1, $4::jsonb, 'exploring')`,
      ['1'.repeat(32), 'a'.repeat(40), headSha, JSON.stringify(contract.parseIntent(declared))]
    );
    const changed = await state.recordIntentInTransaction(client, 42, fixtures.intent(), { headSha });
    assert.equal(changed.unchanged, false);
    const cancelled = (await client.query(
      'SELECT state, failure_code, completed_at FROM visual_evidence_runs WHERE id = $1', ['1'.repeat(32)]
    )).rows[0];
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.failure_code, 'intent_changed');
    assert.ok(cancelled.completed_at);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});
