'use strict';

// #4772: services/workshop-waiting.js against the real schema: what Homeroom
// bot waits on one viewer for, on one project. Skips without a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const waiting = require('../src/services/workshop-waiting');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `ws_waiting_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return pool;
}

test('what Homeroom bot waits on the viewer for, read off the real tables', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  const user = async (name, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ($1, 'x', TRUE, $2) RETURNING id`, [name, synthetic],
  )).rows[0].id;
  const bot = await user('homeroom_bot', true);
  const ada = await user('ada');
  const sam = await user('sam');
  const appId = (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ('Book club', 'book-club', 'running', $1) RETURNING id`, [ada],
  )).rows[0].id;

  // Plans: #13 is Ada's, its newest run waits for Build it. #14 is Ada's and
  // its plan was built already. #15 is Sam's.
  for (const [n, who] of [[13, ada], [14, ada], [15, sam]]) {
    await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, $2, $3)', [appId, n, who]);
  }
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, awaiting_go_at) VALUES
       ($1, 13, 'live', 'ready', NOW() - INTERVAL '1 hour'),
       ($1, 15, 'live', 'ready', NOW() - INTERVAL '1 hour')`, [appId],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, awaiting_go_at, build_ok) VALUES
       ($1, 14, 'live', 'ready', NOW() - INTERVAL '2 hours', TRUE)`, [appId],
  );

  // Talks: change A, where both Ada and the bot wrote, the bot last; change
  // B, merged; change C, where only Ada wrote; request #9, Ada last.
  const session = async (status) => (await pool.query(
    'INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, $3) RETURNING id', [appId, ada, status],
  )).rows[0].id;
  const a = await session('promoted');
  const b = await session('merged');
  const c = await session('active');
  const say = (who, type, ref, minutesAgo, extra = '') => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, created_at${extra ? ', deleted_at' : ''})
     VALUES ($1, $2, 'hi', $3, $4, NOW() - make_interval(mins => $5)${extra ? ', NOW()' : ''})`,
    [appId, who, type, ref, minutesAgo],
  );
  await say(ada, 'session', a, 120);
  await say(bot, 'session', a, 60);
  await say(ada, 'session', b, 120);
  await say(bot, 'session', b, 60);
  await say(ada, 'session', c, 30);
  await say(bot, 'session', c, 10, 'deleted');
  await say(bot, 'issue', 9, 300);
  await say(ada, 'issue', 9, 200);
  // Older than the window: not a back and forth any more.
  await say(ada, 'issue', 10, 60 * 24 * 5);
  await say(bot, 'issue', 10, 60 * 24 * 5);

  const out = await waiting.waitingOnViewer(pool, { appId, userId: ada, botId: bot });
  assert.deepEqual(out.plans.map((p) => p.number), [13]);
  assert.deepEqual(out.questions, []);
  assert.deepEqual(out.talks.map((x) => [x.type, x.ref, x.botLast]), [['session', a, true], ['issue', 9, false]]);
  assert.ok(out.talks.every((x) => typeof x.at === 'string'));

  const forSam = await waiting.waitingOnViewer(pool, { appId, userId: sam, botId: bot });
  assert.deepEqual(forSam.plans.map((p) => p.number), [15]);
  assert.deepEqual(forSam.talks, [], 'Ada\'s conversations are not Sam\'s');
});
