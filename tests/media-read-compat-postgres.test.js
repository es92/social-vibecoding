'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const media = require('../src/services/media-store');
const control = require('../src/services/shots-control');
const fixtures = require('./fixtures/shots');
const { useMemoryMedia } = require('./lib/media-store');
const { within } = require('./lib/wait-for');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('reader release can publish keyed files and retake a keyed slot without retaining stale keys', { timeout: 15000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'media_compat_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const store = useMemoryMedia(t, { now: () => 0 });
  const intent = fixtures.intent();
  const { rows: [user] } = await pool.query("INSERT INTO users (username, password) VALUES ('compat', 'x') RETURNING id");
  const { rows: [app] } = await pool.query("INSERT INTO apps (name, slug, created_by) VALUES ('Compat', 'compat', $1) RETURNING id", [user.id]);
  const { rows: [session] } = await pool.query('INSERT INTO chat_sessions (app_id, user_id) VALUES ($1, $2) RETURNING id', [app.id, user.id]);
  const runId = crypto.randomBytes(16).toString('hex');
  await pool.query(`INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state)
    VALUES ($1, $2, $3, $4, $5::jsonb, 'exploring')`, [runId, session.id, 'a'.repeat(40), 'b'.repeat(40), JSON.stringify(intent)]);
  await control.create(pool, { runId, sessionId: session.id, intent, context: {}, expiresAt: Date.now() + 60000 });
  await pool.query("UPDATE chat_sessions SET shots_run_id = $2, shots_state = 'exploring' WHERE id = $1", [session.id, runId]);
  const old = fixtures.png({ shade: 20 });
  const dense = fixtures.png({ width: 8, height: 6, shade: 20 });
  const tx = await pool.connect();
  let oldKey;
  try {
    await tx.query('BEGIN');
    const keys = await media.putMany(tx, store, [{ data: old }, { data: dense }]);
    oldKey = keys[0];
    await tx.query(`INSERT INTO shot_run_files (run_id, slot, story_id, viewport, side, variant, media, content_type,
      width, height, bytes, sha256, density, dense_width, dense_height, dense_bytes, dense_sha256, object_key, dense_object_key)
      VALUES ($1, 'invite-suggestions/desktop/head/context', 'invite-suggestions', 'desktop', 'head', 'context', 'png', 'image/png',
        4, 3, $2, $3, 2, 8, 6, $4, $5, $6, $7)`,
    [runId, old.length, oldKey.slice(media.PREFIX.length), dense.length, keys[1].slice(media.PREFIX.length), oldKey, keys[1]]);
    const machine = require('../src/workflow/shots/machine.ts').shots({});
    await machine.writes.get('published')(tx, { runId, slots: ['invite-suggestions/desktop/head/context'],
      verdict: { passed: true, stories: [] }, planHash: 'c'.repeat(64) }, { push() {} });
    await tx.query('COMMIT');
  } catch (err) { await tx.query('ROLLBACK'); throw err; } finally { tx.release(); }
  const { rows: [published] } = await pool.query('SELECT * FROM shot_artifacts WHERE run_id = $1', [runId]);
  assert.equal(published.object_key, oldKey);
  assert.equal(published.data, null);
  assert.deepEqual(await media.bytes(store, published), old);
  // The existing <table>_media_check only validates png/webm/gif. It must
  // not mask the new invariant after data becomes nullable.
  await assert.rejects(pool.query('UPDATE shot_run_files SET object_key = NULL WHERE run_id = $1', [runId]), { code: '23514' });
  await assert.rejects(pool.query('UPDATE shot_run_files SET data = $2 WHERE run_id = $1', [runId, old]), { code: '23514' });
  await assert.rejects(pool.query('UPDATE shot_artifacts SET object_key = NULL WHERE run_id = $1', [runId]), { code: '23514' });
  await assert.rejects(pool.query('UPDATE shot_artifacts SET data = $2 WHERE run_id = $1', [runId, old]), { code: '23514' });
  const owner = await pool.connect();
  await owner.query('BEGIN');
  await owner.query('SELECT slot FROM shot_run_files WHERE run_id = $1 FOR UPDATE', [runId]);
  const sweep = media.sweep(pool, store);
  try {
    assert.equal((await within(sweep, 2000, 'cleanup to retain a locked referenced row')).removed, 0);
  } finally { await owner.query('ROLLBACK'); owner.release(); await sweep; }
  // A reader release still writes bytes; the next release writes keys.
  // Both must replace the old key/density and read the actual new bytes.
  await pool.query("UPDATE chat_sessions SET shots_state = 'exploring' WHERE id = $1", [session.id]);
  const fresh = fixtures.png({ shade: 200 });
  await control.withControl(pool, { runId, sessionId: session.id },
    (c) => c.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' }, fresh));
  const [file] = await control.filesFor(pool, runId);
  assert.deepEqual(file.data, fresh);
  const { rows: [row] } = await pool.query('SELECT * FROM shot_run_files WHERE run_id = $1', [runId]);
  assert.notEqual(row.object_key, oldKey);
  assert.equal(row.dense_object_key, null);
  assert.equal(row.dense_data, null);
  assert.equal(row.density, 1);
  assert.notEqual(row.data === null, row.object_key === null, 'exactly one representation');
});
