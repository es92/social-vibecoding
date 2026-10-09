'use strict';

// Admin → Homeroom bot, Running now and Waiting in the queue: the live
// builds count too, against the FULL PostgreSQL schema.
//
// 2026-10-09: the tiles said 0 running and 0 waiting while six builds ran for
// one person. Running now read the claimed queue rows and Waiting the queue's
// depth, and a live build is neither: its queue row is gone once its request
// is read, it waits on its run (live_build_waiting_at), and it runs on a
// session of its own (build_session_id). buildsNow reads both from the runs,
// so any Pod can answer, and adminPayload adds them to the tiles.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the live builds under way and waiting, for the dashboard, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_builds_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`,
  );
  const { rows: [ada] } = await pool.query(`INSERT INTO users (username, password) VALUES ('ada', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Seed swap', 'seed-swap', 'running', 'https://github.com/usernode-bot/seed-swap')
     RETURNING id`,
  );
  const session = async ({ status = 'active', ago = 600 } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, created_at)
     VALUES ($1, $2, $3, $4, FALSE, '{}', NOW() - make_interval(secs => $5)) RETURNING id`,
    [app.id, botUser.id, `dev/homeroom_bot-${crypto.randomBytes(3).toString('hex')}`, status, ago],
  )).rows[0].id;
  const run = async (issue, cols = {}) => {
    const fields = { app_id: app.id, issue_number: issue, mode: 'live', verdict: 'ready', build_note: 'build it', ...cols };
    const keys = Object.keys(fields);
    return (await pool.query(
      `INSERT INTO homeroom_bot_runs (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      keys.map((k) => fields[k]),
    )).rows[0].id;
  };
  await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, 3, $2)', [app.id, ada.id]);

  await t.test('nothing yet: empty, never an error', async () => {
    assert.deepEqual(await bot.buildsNow(pool), { building: [], waiting: 0 });
  });

  await t.test('under way: a live build with its session open and no outcome', async () => {
    await run(3, { build_session_id: await session({ ago: 900 }) });
    await run(4, { build_session_id: await session({ ago: 300 }) });
    // Not under way: ended, proposed, its session put away, a shadow build,
    // a plan waiting for Build it, and one the abandoned-build sweep owns.
    await run(5, { build_session_id: await session(), build_ok: false, build_error: 'x' });
    await run(6, { build_session_id: await session({ status: 'promoted' }), proposal_session_id: await session({ status: 'promoted' }) });
    await run(7, { build_session_id: await session({ status: 'archived' }) });
    await run(8, { mode: 'shadow', build_session_id: await session() });
    await run(9, { build_session_id: await session(), awaiting_go_at: new Date() });
    await run(10, { build_session_id: await session({ ago: 5 * 3600 }) });

    const { building } = await bot.buildsNow(pool);
    assert.deepEqual(building.map((b) => [b.appSlug, b.appName, b.issueNumber, b.lane, b.kind, b.person]), [
      ['seed-swap', 'Seed swap', 3, 'live', 'build', 'ada'],
      ['seed-swap', 'Seed swap', 4, 'live', 'build', null],
    ], 'oldest first, with who it is for when somebody asked');
    assert.ok(building.every((b) => b.since instanceof Date), 'since its session started');
  });

  await t.test('waiting: the newest verdict on its request, no session yet', async () => {
    await run(11, { live_build_waiting_at: new Date() });
    await run(12, { live_build_waiting_at: new Date() });
    // Not waiting: a newer verdict replaced it, or it was skipped.
    await run(13, { live_build_waiting_at: new Date() });
    await run(13, { verdict: 'question' });
    await run(14, { live_build_waiting_at: new Date(), build_ok: false, build_error: 'skipped: the request was closed' });
    await run(15, { live_build_waiting_at: new Date(), mode: 'shadow' });
    assert.equal((await bot.buildsNow(pool)).waiting, 2);
  });

  await t.test('the tiles: Running now lists the builds beside the reads, and Waiting counts them', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, reason, started_at) VALUES ($1, 20, 'new', NOW()), ($1, 21, 'new', NULL)`,
      [app.id],
    );
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'shadow')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const payload = await bot.adminPayload(pool, {});
    assert.deepEqual(payload.workingNow.map((w) => [w.issueNumber, w.kind]), [[20, 'read'], [3, 'build'], [4, 'build']]);
    assert.deepEqual({ depth: payload.queue.depth, buildsWaiting: payload.queue.buildsWaiting }, { depth: 1, buildsWaiting: 2 });
  });

  await t.test('a failed read leaves the tiles as they were, not the dashboard broken', async () => {
    const broken = { async query() { throw new Error('connection lost'); } };
    assert.deepEqual(await bot.buildsNow(broken), { building: [], waiting: 0 });
  });
});
