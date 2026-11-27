'use strict';

// 20 Nov 2026 (live-draft review): the staging seed the before & after shots
// open a live draft's thread from (src/db/migrate.js
// seedStagingLiveDraftThread). Against the full schema: the shots' member
// fixture's thread on their own fake project holds a draft up for a vote
// with one change not in the proposal yet, which the thread's read
// (live-drafts.js forThread) keeps rather than closing; a second boot adds
// nothing; outside staging it writes nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the live draft thread seed, against the full schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'live_draft_seed_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  const env = process.env.USERNODE_ENV;
  t.after(async () => {
    process.env.USERNODE_ENV = env;
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { seedStagingLiveDraftThread } = require('../src/db/migrate');
  const liveDrafts = require('../src/services/live-drafts');

  const user = async (name, synthetic = false) => (await pool.query(
    'INSERT INTO users (username, password, is_synthetic) VALUES ($1, \'x\', $2) RETURNING id', [name, synthetic])).rows[0];
  const member = await user('usernode-capture');
  const bot = await user('homeroom_bot', true);
  await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ('Staging demo: recipe box', 'staging-demo-recipe-box', 'running', $1)`,
    [member.id]);
  const { rows: [c] } = await pool.query(`INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [member.id]);
  await pool.query('INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id) VALUES ($1, $2, $3)',
    [c.id, Math.min(member.id, bot.id), Math.max(member.id, bot.id)]);

  process.env.USERNODE_ENV = 'production';
  await seedStagingLiveDraftThread(pool);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM live_drafts')).rows[0].n, 0, 'nothing outside staging');

  process.env.USERNODE_ENV = 'staging';
  await seedStagingLiveDraftThread(pool);
  await seedStagingLiveDraftThread(pool);
  const { rows } = await pool.query('SELECT id, root_message_id FROM live_drafts');
  assert.equal(rows.length, 1, 'a second boot adds nothing');
  const draft = await liveDrafts.forThread(pool, { userId: member.id, rootId: rows[0].root_message_id });
  assert.ok(draft, 'still the thread\'s draft: not idle, its proposal not over');
  const said = liveDrafts.describe(draft);
  assert.deepEqual([said.state, said.editable, said.live, said.proposal.open, said.proposal.pending, said.conversationId],
    ['proposed', true, 'live', true, 1, Number(c.id)]);
  const { rows: thread } = await pool.query(
    'SELECT content FROM conversation_messages WHERE thread_root_id = $1 ORDER BY id', [rows[0].root_message_id]);
  assert.equal(thread.length, 4);
  assert.ok(thread.every((m) => m.content.startsWith('Staging demo:')), 'obviously fake');
});

// 27 Nov 2026 (request 7262): the other seeded thread, whose draft is still
// being worked on, so the before & after shots show its preview header before
// it is proposed: where it stands and Propose, and no Open change.
test('the open live draft seed, against the full schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'live_draft_open_seed_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  const env = process.env.USERNODE_ENV;
  t.after(async () => {
    process.env.USERNODE_ENV = env;
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { seedStagingOpenLiveDraft } = require('../src/db/migrate');
  const liveDrafts = require('../src/services/live-drafts');

  const user = async (name, synthetic = false) => (await pool.query(
    'INSERT INTO users (username, password, is_synthetic) VALUES ($1, \'x\', $2) RETURNING id', [name, synthetic])).rows[0];
  const member = await user('usernode-capture');
  const bot = await user('homeroom_bot', true);
  await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ('Staging demo: recipe box', 'staging-demo-recipe-box', 'running', $1)`,
    [member.id]);
  const { rows: [c] } = await pool.query(`INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [member.id]);
  await pool.query('INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id) VALUES ($1, $2, $3)',
    [c.id, Math.min(member.id, bot.id), Math.max(member.id, bot.id)]);

  process.env.USERNODE_ENV = 'production';
  await seedStagingOpenLiveDraft(pool);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM live_drafts')).rows[0].n, 0, 'nothing outside staging');

  process.env.USERNODE_ENV = 'staging';
  await seedStagingOpenLiveDraft(pool);
  await seedStagingOpenLiveDraft(pool);
  const { rows } = await pool.query('SELECT id, root_message_id, state FROM live_drafts');
  assert.equal(rows.length, 1, 'a second boot adds nothing');
  assert.equal(rows[0].state, 'open');
  const draft = await liveDrafts.forThread(pool, { userId: member.id, rootId: rows[0].root_message_id });
  assert.ok(draft, 'the thread\'s draft, still being worked on');
  const said = liveDrafts.describe(draft);
  assert.deepEqual([said.state, said.live, said.proposal, said.edits],
    ['open', 'live', null, 2], 'no proposal yet, and two edits to show where it stands');
  const { rows: thread } = await pool.query(
    'SELECT content FROM conversation_messages WHERE thread_root_id = $1 ORDER BY id', [rows[0].root_message_id]);
  assert.equal(thread.length, 4);
  assert.ok(thread.every((m) => m.content.startsWith('Staging demo:')), 'obviously fake');
});
