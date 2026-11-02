'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const media = require('../src/services/media-store');
const { metadata } = require('../src/services/check-visual-media');
const { useMemoryMedia } = require('./lib/media-store');
const { within } = require('./lib/wait-for');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('check visual reader release publishes keys and retains merged visuals indefinitely', { timeout: 15000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'visual_readers_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  const store = useMemoryMedia(t, { now: () => 0 });
  const { rows: [user] } = await pool.query("INSERT INTO users (username, password) VALUES ('visual-owner', 'x') RETURNING id");
  const { rows: [app] } = await pool.query("INSERT INTO apps (name, slug, created_by) VALUES ('Visuals', 'visuals', $1) RETURNING id", [user.id]);
  const head = 'b'.repeat(40);
  const { rows: [session] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, status, checks_commit_sha)
    VALUES ($1, $2, 'active', $3) RETURNING id`, [app.id, user.id, head]);
  const data = Buffer.from('visual bytes shared with shots');
  const meta = metadata(data);
  const artifactId = crypto.randomBytes(16).toString('hex');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const key = await media.put(tx, store, data, 'image/png');
    await tx.query(`INSERT INTO check_run_media (id, run_id, session_id, commit_hash, kind, media, content_type,
      object_key, bytes, sha256, legacy_etag) VALUES ($1, 'checks:test', $2, $3, 'after', 'png', 'image/png', $4, $5, $6, $7)`,
    [artifactId, session.id, head, key, meta.bytes, meta.sha256, meta.legacyEtag]);
    await tx.query('COMMIT');
  } catch (err) { await tx.query('ROLLBACK'); throw err; } finally { tx.release(); }
  assert.equal((await media.sweep(pool, store)).removed, 0, 'held media references protect the object');
  const publication = await pool.connect();
  try {
    await publication.query('BEGIN');
    const machine = require('../src/workflow/preview/machine.ts').preview({});
    await machine.writes.get('deferred')(publication, { sessionId: session.id, head, runId: 'checks:test', media: true });
    await publication.query('COMMIT');
  } catch (err) { await publication.query('ROLLBACK'); throw err; } finally { publication.release(); }
  const { rows: [row] } = await pool.query('SELECT * FROM session_visuals WHERE id = $1', [artifactId]);
  assert.ok(row);
  assert.equal(row.object_key, media.objectKey(data));
  assert.equal(row.data, null); assert.equal(row.legacy_etag, meta.legacyEtag);
  assert.deepEqual(await media.bytes(store, row), data);
  assert.equal((await pool.query('SELECT * FROM check_run_media WHERE session_id = $1', [session.id])).rowCount, 0);
  await pool.query("UPDATE chat_sessions SET status = 'merged', merged_at = NOW() - INTERVAL '365 days' WHERE id = $1", [session.id]);
  await pool.query("UPDATE session_visuals SET created_at = NOW() - INTERVAL '365 days' WHERE id = $1", [artifactId]);
  const lock = await pool.connect();
  await lock.query('BEGIN');
  await lock.query('SELECT id FROM session_visuals WHERE id = $1 FOR UPDATE', [artifactId]);
  const sweep = media.sweep(pool, store);
  try { assert.equal((await within(sweep, 2000, 'cleanup to retain a locked merged visual')).removed, 0); }
  finally { await lock.query('ROLLBACK'); lock.release(); await sweep; }
  assert.deepEqual(await media.bytes(store, row), data);
  await pool.query(schema);
});
