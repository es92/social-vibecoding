'use strict';
require('./lib/media-store').useMemoryMedia(require('node:test'));

// The staging fixture that makes the before & after card's "Also noticed"
// reachable on a preview (src/db/migrate.js seedStagingShotsNoticed),
// against the REAL schema in a throwaway PostgreSQL database: a merged
// proposal on the gallery's demo app with a published run whose shots agent
// noticed two problems on the after build. Pinned here: it writes nothing
// outside staging; a second boot adds nothing; and it reads back through the
// platform's own code the way every surface needs it (the change page's
// card, the image route, the admin gallery, the connector's
// list_recent_shots), while nothing that decides whether a change works
// sees the notices. Skipped when no server is reachable, and required when
// TEST_DATABASE_URL is set, the same contract as the other *-postgres suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Client, Pool } = require('pg');

// The image route takes its pool at construction; hand it this test's.
let testPool = null;
require('../src/db/pool').getPool = () => testPool;

const { seedStagingShotsNoticed } = require('../src/db/migrate');
const shotsView = require('../src/services/shots-view');
const shotsState = require('../src/services/shots-state');
// app-view.js reads its words through the language runtime's global, as the
// shell publishes it.
globalThis.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
const AppView = require('../public/js/app-view.js');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SESSION_ID = 900108;

const savedEnvironment = process.env.USERNODE_ENV;
test.after(() => {
  if (savedEnvironment === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = savedEnvironment;
});

test('the Also noticed fixture never writes outside staging', async () => {
  process.env.USERNODE_ENV = 'production';
  await seedStagingShotsNoticed({ query() { assert.fail('must not seed production'); } });
});

test('a staging preview has a published run whose card lists what the shots agent noticed (PostgreSQL)', async (t) => {
  const root = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await root.connect(); }
  catch (err) {
    await root.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`Local test database unavailable: ${err.code}`);
  }
  const database = `shots_noticed_${crypto.randomBytes(6).toString('hex')}`;
  let pool;
  let server;
  try {
    await root.query(`CREATE DATABASE ${database}`);
    const url = new URL(DSN); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.toString() });
    pool.on('error', () => {});
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    await require('./lib/media-store').dropMediaByteColumns(pool);
    // What seedStagingGalleryProposals leaves for it: the demo owner and the
    // gallery's own demo app.
    await pool.query(`INSERT INTO users (username, password) VALUES ('staging-demo-user', 'staging-demo-not-a-login')`);
    const viewer = (await pool.query(
      `INSERT INTO users (username, password) VALUES ('staging-check-viewer', 'x') RETURNING id, username`
    )).rows[0];
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, view_visibility, created_by)
       SELECT 900106, 'Staging demo gallery app', 'staging-demo-gallery-app', 'awaiting_secrets', 'public', id
         FROM users WHERE username = 'staging-demo-user'`
    );

    process.env.USERNODE_ENV = 'staging';
    await seedStagingShotsNoticed(pool);
    await seedStagingShotsNoticed(pool);
    const counts = (await pool.query(
      `SELECT (SELECT COUNT(*) FROM chat_sessions WHERE id = $1)::int AS sessions,
              (SELECT COUNT(*) FROM shot_runs WHERE session_id = $1)::int AS runs,
              (SELECT COUNT(*) FROM shot_artifacts a JOIN shot_runs r ON r.id = a.run_id WHERE r.session_id = $1)::int AS files`,
      [SESSION_ID]
    )).rows[0];
    assert.deepEqual(counts, { sessions: 1, runs: 1, files: 8 }, 'a second boot adds nothing');

    const row = (await pool.query(
      `SELECT cs.*, a.slug AS app_slug FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
      [SESSION_ID]
    )).rows[0];
    assert.equal(row.status, 'merged');
    assert.match(row.pr_title, /^\[Mock\] Staging demo/);
    const run = (await pool.query('SELECT * FROM shot_runs WHERE id = $1', [row.shots_run_id])).rows[0];
    assert.equal(run.state, 'verified');
    assert.equal(run.trace_summary.cleanupComplete, true, 'the cleanup sweep has nothing to tear down for it');

    // The public view, as the change page and the connector's get_proposal read it.
    const shots = await shotsView.getForSession(pool, row, row.app_slug);
    assert.equal(shots.state, 'verified');
    assert.deepEqual(shots.shotResults, [{ id: 'board-sort', status: 'ready', reason: null, note: null }]);
    assert.deepEqual(shots.shotNotices.map((entry) => [entry.screen, entry.shot, entry.alsoBefore]),
      [['desktop', 'screen', true], ['phone', 'screen', false]]);
    for (const entry of shots.shotNotices) assert.match(entry.text, /^Staging demo: /);
    assert.equal(shots.artifacts.length, 8);
    // #4459: every screen also has a dark copy beside its light one, so the
    // card's theme flip is reachable on a preview.
    assert.deepEqual(
      shots.artifacts.filter((a) => a.theme === 'dark').map((a) => [a.viewport, a.side]).sort(),
      [['desktop', 'base'], ['desktop', 'head'], ['phone', 'base'], ['phone', 'head']],
    );
    assert.equal(shots.artifacts.filter((a) => a.theme === 'light').length, 4);
    assert.deepEqual(shotsState.brokenOnHead(row, row.reviewed_head_sha), [],
      'the notices never read as the change not working');

    // The change page's Before and after card shows the screens and the notes.
    const card = AppView.shotsHtml(shots, { sessionId: SESSION_ID, thread: true });
    assert.match(card, /<h3 class="shots-noticed-head">Also noticed<\/h3>/);
    assert.match(card, /Desktop · Also on the before build/);
    assert.match(card, /Phone · Not on the before build/);
    assert.equal((card.match(/<img src="\/api\/apps\/staging-demo-gallery-app\/proposals\/900108\/shots\/[0-9a-f]{32}"/g) || []).length, 8);
    // The theme switch renders because the run has dark shots, and the flip
    // control carries both labels.
    assert.match(card, /shots-theme-pick/);
    assert.match(card, /Show in dark mode/);
    assert.match(card, /Show in light mode/);

    // Its images are served by the proposal's own route to any member.
    testPool = pool;
    const { shotsRoutes } = require('../src/routes/shots');
    const web = express();
    web.use((req, _res, next) => { req.user = viewer; next(); });
    web.use(shotsRoutes({ shots: { present: true } }));
    server = await new Promise((resolve) => { const s = web.listen(0, '127.0.0.1', () => resolve(s)); });
    const after = shots.artifacts.find((artifact) => artifact.side === 'head' && artifact.viewport === 'phone');
    const image = await fetch(`http://127.0.0.1:${server.address().port}${after.url}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await image.arrayBuffer());
    assert.equal(png.readUInt32BE(16), 390, 'the phone screen is phone-sized');
    assert.equal(png.readUInt32BE(20), 844);

    // The admin Screenshot gallery and the connector's list_recent_shots list it.
    const page = await require('../src/routes/gallery').listProposals(pool, {});
    const listed = page.proposals.find((proposal) => proposal.id === SESSION_ID);
    assert.equal(listed.shots.shotNotices.length, 2);
    const recent = await require('../src/services/bench/connector-data').recentShots(pool, {});
    const shown = recent.proposals.find((proposal) => proposal.sessionId === SESSION_ID);
    assert.deepEqual(shown.shots.shotNotices.map((entry) => entry.alsoBefore), [true, false]);
    assert.equal(shown.shots.images, 8);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  }
});
