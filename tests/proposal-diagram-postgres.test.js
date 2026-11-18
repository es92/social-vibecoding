'use strict';

// Whether a change already has a stored diagram (#6815): submit_work's
// reminder is skipped when one is kept, so this read runs against PostgreSQL.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/proposal-diagram-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('hasStored reads whether a change already has a diagram', { timeout: 60000 }, async (t) => {
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000, max: 1 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL is unavailable');
    return;
  }
  const schema = `proposal_diagram_${process.pid}_${Date.now()}`;
  const { hasStored } = require('../src/services/proposal-diagram');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: DSN, connectionTimeoutMillis: 2000, max: 1, options: `-c search_path=${schema}`,
  });
  pool.on('error', () => {});
  try {
    await pool.query(`CREATE TABLE chat_sessions (id SERIAL PRIMARY KEY, pr_diagram JSONB);
      INSERT INTO chat_sessions (id, pr_diagram)
      VALUES (1, '{"version":1,"kind":"rename"}'::jsonb), (2, NULL);`);
    assert.equal(await hasStored(pool, 1), true, 'a stored diagram is kept');
    assert.equal(await hasStored(pool, '1'), true, 'an id as text still reads');
    assert.equal(await hasStored(pool, 2), false, 'no diagram stored yet');
    assert.equal(await hasStored(pool, 3), false, 'no such row');
    assert.equal(await hasStored(pool, 'nope'), false, 'a bad id is not a database error');
    assert.equal(await hasStored(null, 1), false, 'no pool, nothing to read');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }

  // A lookup that fails answers true, so the reminder is never sent on a
  // guess (the spec's "sends no reminder when it cannot check").
  const broken = { query: async () => { throw new Error('database down'); } };
  assert.equal(await hasStored(broken, 1), true);
});
