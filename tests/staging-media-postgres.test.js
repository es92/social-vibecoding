'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const media = require('../src/services/media-store');
const { withStagingMedia } = require('../src/services/staging-media');
const { dropMediaByteColumns } = require('./lib/media-store');
const seeds = require('../src/db/migrate');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('staging visual fixtures seed and serve keys without byte columns', { timeout: 30000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'staging_media_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  pool.on('error', () => {});
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await dropMediaByteColumns(pool);
  // Exercise the actual credential-free preview adapter, not the test mock.
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'staging-media-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const adapter = require('../src/services/staging-media-store');
  const create = adapter.createStagingMediaStore;
  t.mock.method(adapter, 'createStagingMediaStore', () => create({ directory }));
  const store = create({ directory });
  const beforeEnv = process.env.USERNODE_ENV;
  t.after(() => { if (beforeEnv === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = beforeEnv; });
  const run = async (db) => {
    await seeds.seedStagingTranscriptShowcase(db, { selfAppSlug: 'media-fixture' });
    await seeds.seedStagingVisuals(db);
    await seeds.seedStagingGalleryProposals(db);
  };
  process.env.USERNODE_ENV = 'production';
  await run({ query() { assert.fail('no media fixture may seed production'); } });
  await pool.query(`INSERT INTO users (username, password) VALUES ('usernode-capture-admin', 'x'), ('staging-demo-user', 'x');
    INSERT INTO apps (id, name, slug) VALUES (900001, 'Fixture', 'media-fixture');
    INSERT INTO chat_sessions (id, app_id, user_id) SELECT 900001, 900001, id FROM users WHERE username='staging-demo-user'`);
  process.env.USERNODE_ENV = 'staging';
  await run(pool);
  const { rows } = await pool.query('SELECT id, object_key, bytes, sha256, legacy_etag, content_type FROM session_visuals ORDER BY id');
  assert.equal(rows.length, 31, 'seven transcript, eleven multi-route and thirteen gallery media');
  for (const row of rows) {
    const data = await media.bytes(store, row);
    assert.equal(data.length, row.bytes);
    assert.equal(media.objectKey(data), row.object_key);
    assert.equal(row.sha256, row.object_key.slice(media.PREFIX.length));
    assert.match(row.legacy_etag, /^W\//);
  }
  await run(pool);
  assert.deepEqual((await pool.query('SELECT id, object_key, bytes, sha256, legacy_etag, content_type FROM session_visuals ORDER BY id')).rows, rows);
  assert.equal((await fsp.readdir(directory)).length, new Set(rows.map((r) => r.object_key)).size,
    'all seeds share only the distinct fixture files');
  // The same cloned DB on a replacement container recreates its fake files.
  await fsp.rm(directory, { recursive: true, force: true });
  await run(pool);
  for (const row of rows) assert.equal((await media.bytes(store, row)).length, row.bytes);

  const orphan = Buffer.from('fixture row refused after upload');
  await assert.rejects(withStagingMedia(pool, orphan, 'image/png', async (tx, m) => {
    await tx.query(`INSERT INTO session_visuals (id, session_id, kind, media, content_type, object_key, sha256, bytes, legacy_etag)
      VALUES ('no-parent', -1, 'after', 'png', 'image/png', $1, $2, $3, $4)`, [m.key, m.sha256, m.bytes, m.legacyEtag]);
  }), { code: '23503' });
  assert.equal((await pool.query('SELECT 1 FROM media_objects WHERE object_key=$1', [media.objectKey(orphan)])).rowCount, 0,
    'failed fixture insertion rolls back its registry row too');
});
