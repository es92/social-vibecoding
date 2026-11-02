'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const visuals = require('../src/services/visuals');
const media = require('../src/services/media-store');
const { metadata } = require('../src/services/check-visual-media');
const { useMemoryMedia } = require('./lib/media-store');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const id = () => crypto.randomBytes(16).toString('hex');

test('check visual uploads, atomic publication against PostgreSQL', { timeout: 30000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'visual_store_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  pool.on('error', () => {});
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
    await require('./lib/media-store').dropMediaByteColumns(pool);
  const store = useMemoryMedia(t, { now: () => 0 });
  const { rows: [user] } = await pool.query("INSERT INTO users (username, password) VALUES ('visual-test', 'x') RETURNING id");
  const { rows: [app] } = await pool.query("INSERT INTO apps (name, slug, created_by) VALUES ('Visual', 'visual', $1) RETURNING id", [user.id]);
  const head = 'a'.repeat(40);
  const { rows: [session] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, status, checks_commit_sha)
    VALUES ($1, $2, 'active', $3) RETURNING id`, [app.id, user.id, head]);
  const { rows: [merged] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, status, merged_at)
    VALUES ($1, $2, 'merged', NOW() - INTERVAL '365 days') RETURNING id`, [app.id, user.id]);
  const targets = [{ index: 0, path: '/' }];
  const shot = (buf) => ({ kind: 'after', media: 'png', index: 0, status: 200, buf });
  const data = Buffer.from('new capture');
  const legacy = Buffer.from('old capture from a merged PR');

  await t.test('new direct and held captures commit keys without bytes and deduplicate the shared content', async () => {
    const direct = await visuals.storeArtifacts(pool, session.id, head, targets, [shot(data)]);
    const held = await visuals.storeArtifacts(pool, session.id, head, targets, [shot(data)], null, { runId: 'checks:new' });
    for (const [sql, artifactId] of [
      ['SELECT * FROM session_visuals WHERE id = $1', direct.captures[0].after.png],
      ['SELECT * FROM check_run_media WHERE id = $1', held.captures[0].after.png],
    ]) {
      const { rows: [row] } = await pool.query(sql, [artifactId]);
      assert.equal(row.data, undefined); assert.equal(row.object_key, media.objectKey(data));
      assert.equal(row.sha256, metadata(data).sha256); assert.equal(row.bytes, data.length);
      assert.equal(row.legacy_etag, metadata(data).legacyEtag);
      assert.deepEqual(await media.bytes(store, row), data);
    }
    assert.equal(store.calls.filter((c) => c.op === 'put').length, 1);
    const before = store.calls.length;
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await require('../src/workflow/preview/machine.ts').preview({}).writes.get('deferred')(tx,
        { sessionId: session.id, head, runId: 'checks:new', media: true });
      await tx.query('COMMIT');
    } catch (err) { await tx.query('ROLLBACK'); throw err; } finally { tx.release(); }
    assert.equal(store.calls.length, before, 'publication only copies keys and metadata');
    assert.equal((await visuals.getForSession(pool, session.id)).captures[0].after.png, held.captures[0].after.png);
  });

  await t.test('failed uploads or row writes restore the previous published set and leave only collectable orphans', async () => {
    const before = (await pool.query('SELECT id FROM session_visuals WHERE session_id = $1 ORDER BY id', [session.id])).rows;
    await assert.rejects(visuals.storeArtifacts(pool, session.id, head, targets, [shot(Buffer.from('unconfigured'))], null, null, { store: null }),
      { code: 'media_storage_unavailable' });
    const failing = { connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql, params) => {
          if (String(sql).trim().startsWith('INSERT INTO session_visuals')) throw new Error('metadata refused');
          return client.query(sql, params);
        }, release: () => client.release(),
      };
    } };
    const orphan = Buffer.from('uploaded but never committed');
    await assert.rejects(visuals.storeArtifacts(failing, session.id, head, targets, [shot(orphan)]), /metadata refused/);
    assert.deepEqual((await pool.query('SELECT id FROM session_visuals WHERE session_id = $1 ORDER BY id', [session.id])).rows, before);
    assert.ok(store.files.has(media.objectKey(orphan)));
    assert.equal((await media.sweep(pool, store)).removed, 1);
    assert.ok(store.files.has(media.objectKey(data)));
  });

});
