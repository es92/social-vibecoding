'use strict';
require('./lib/media-store').useMemoryMedia(require('node:test'));

// The staging fixture that puts a change with several screens in the shots
// member's Needs you (src/db/migrate.js seedStagingShotsScreens), against the
// REAL schema in a throwaway PostgreSQL database: a promoted proposal on the
// demo app with a published run of three phone screens, each changed at a
// different height. Pinned here: it writes nothing outside staging; a second
// boot adds nothing; the member is owed a vote on it by the Needs you feed's
// own query; and the feed's pictures give it three screens, the way the new
// review flow's row of screens needs them. Skipped when no server is
// reachable, and required when TEST_DATABASE_URL is set, the same contract
// as the other *-postgres suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

const { seedStagingShotsScreens } = require('../src/db/migrate');
const overview = require('../src/routes/workshop-overview');
globalThis.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
const AppView = require('../public/js/app-view.js');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SESSION_ID = 900160;

const savedEnvironment = process.env.USERNODE_ENV;
test.after(() => {
  if (savedEnvironment === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = savedEnvironment;
});

test('the three-screen fixture never writes outside staging', async () => {
  process.env.USERNODE_ENV = 'production';
  await seedStagingShotsScreens({ query() { assert.fail('must not seed production'); } });
});

test('a staging preview owes the shots member a change with three screens (PostgreSQL)', async (t) => {
  const root = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await root.connect(); }
  catch (err) {
    await root.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`Local test database unavailable: ${err.code}`);
  }
  const database = `shots_screens_${crypto.randomBytes(6).toString('hex')}`;
  let pool;
  try {
    await root.query(`CREATE DATABASE ${database}`);
    const url = new URL(DSN); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.toString() });
    pool.on('error', () => {});
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    await require('./lib/media-store').dropMediaByteColumns(pool);
    // What seedStagingDemoAppCard and the capture accounts leave for it: the
    // demo owner, the demo app, and the shots member on it.
    const owner = (await pool.query(
      `INSERT INTO users (username, password) VALUES ('staging-demo-user', 'staging-demo-not-a-login') RETURNING id`
    )).rows[0];
    const member = (await pool.query(
      `INSERT INTO users (username, password) VALUES ('usernode-capture', 'x') RETURNING id, username`
    )).rows[0];
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, view_visibility, created_by)
       VALUES (900001, 'Staging demo app', 'staging-demo-app', 'running', 'public', $1)`,
      [owner.id]
    );
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status) VALUES (900001, $1, 'member')`,
      [member.id]
    );

    process.env.USERNODE_ENV = 'staging';
    await seedStagingShotsScreens(pool);
    await seedStagingShotsScreens(pool);
    const counts = (await pool.query(
      `SELECT (SELECT COUNT(*) FROM chat_sessions WHERE id = $1)::int AS sessions,
              (SELECT COUNT(*) FROM shot_runs WHERE session_id = $1)::int AS runs,
              (SELECT COUNT(*) FROM shot_artifacts a JOIN shot_runs r ON r.id = a.run_id WHERE r.session_id = $1)::int AS files`,
      [SESSION_ID]
    )).rows[0];
    assert.deepEqual(counts, { sessions: 1, runs: 1, files: 6 }, 'three screens, before and after; a second boot adds nothing');

    const row = (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [SESSION_ID])).rows[0];
    assert.equal(row.status, 'promoted');
    assert.equal(row.user_id, owner.id, 'not the member\'s own change');
    assert.match(row.pr_title, /^\[Mock\] Staging demo/);

    // The member's Needs you, by the feed's own query and pictures.
    const rows = (await pool.query(overview.NEEDS_FEED_SQL, [member.id, false, false, overview.NEEDS_FEED_MAX])).rows;
    const owed = rows.find((r) => Number(r.id) === SESSION_ID);
    assert.ok(owed, 'the shots member is owed a vote on it');
    await overview.withPictures(pool, [owed], { shotsPresent: true, viewer: member });
    assert.equal(owed.shots.state, 'verified');
    assert.equal(owed.shots.screens.length, 3);
    const pictures = AppView._workshopVisuals(owed.visuals || null, owed.shots);
    assert.ok(pictures && Array.isArray(pictures.screens), 'the review flow gets screens');
    assert.deepEqual(pictures.screens.map((s) => s.viewport), ['phone', 'phone', 'phone'], 'phone screens only, so none is dropped');
    // Each changed at a different height: near the top, the middle, the foot.
    const tops = owed.shots.screens.map((s) => s.regions[0].a[1]);
    assert.deepEqual(tops, [96, 392, 704]);
  } finally {
    await pool?.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  }
});
