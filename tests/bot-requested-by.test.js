'use strict';

// #4538: the one rule for "this change was built by Homeroom bot from a
// request made for this viewer", spelled once (services/
// bot-requested-by.js) and read by both places that list a viewer's work in
// flight — the /promoted payload (`requested_by_me`, which the Workshop's
// Your work strip reads) and the Communities counts' MY_PROPOSALS_WHERE —
// so the two cannot disagree about whose work a bot change is.
//
// The predicate part runs against the full PostgreSQL schema, because the
// rule is a join across three tables and a text match cannot prove it
// selects the right rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('path');
const { Pool } = require('pg');

const { botRequestedBySql } = require('../src/services/bot-requested-by');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the fragment is one rule the routes read, not a copy each', () => {
  const fragment = botRequestedBySql('cs', '$2');

  // Built by the bot: a session of a person's that merely links the same
  // issue must not count, so the author is pinned to the synthetic account.
  assert.match(fragment, /EXISTS \(SELECT 1 FROM users bu[\s\S]*?bu\.username = 'homeroom_bot' AND bu\.is_synthetic = TRUE\)/);
  // From a request at all: a shadow build carries no issue number.
  assert.match(fragment, /cs\.created_from_issue_number IS NOT NULL/);
  // For the viewer: the requesters row wins, the filed issue is the
  // fallback — the bot queue's own order (READ_CANDIDATES_SQL's COALESCE), because
  // a request the bot took from a DM is recorded only in the requesters
  // table and `issues.created_by` alone would miss it.
  const coalesce = /COALESCE\(\s*\(SELECT r\.user_id FROM homeroom_bot_requesters r[\s\S]*?\)\s*,\s*\(SELECT i\.created_by FROM issues i[\s\S]*?LIMIT 1\)\)/.exec(fragment);
  assert.ok(coalesce, 'the requesters table is read before the filed issue');
  assert.match(fragment, /= \$2\)$/, 'the comparison binds the caller’s viewer parameter');

  // A second alias is refused, as every shared fragment does.
  assert.throws(() => botRequestedBySql('chat_sessions; DROP TABLE apps', '$1'), /Invalid SQL alias/);
});

test('the routes read the shared fragment', () => {
  // /promoted selects the flag for the viewer it already binds as $2.
  const votes = read('src/routes/votes.js');
  assert.match(votes, /require\('\.\.\/services\/bot-requested-by'\)/);
  assert.match(votes,
    /COALESCE\(\$\{botRequestedBySql\('cs', '\$2'\)\}, FALSE\) AS requested_by_me/,
    'the flag rides the /promoted payload, FALSE for a guest');

  // #4715: the merged rows carry it too, so Your work can tell whose ask a
  // going-live bot change was once it has merged. mergedRowSelect is the
  // shared fragment both /merged and the single-proposal fetch select
  // through, and both bind the viewer as $2 — assert on the function body,
  // not the file, so the match names THIS select and not /promoted's.
  const mergedSelect = /function mergedRowSelect\([^)]*\) \{[\s\S]*?\n\}/.exec(votes);
  assert.ok(mergedSelect, 'mergedRowSelect found');
  assert.match(mergedSelect[0],
    /COALESCE\(\$\{botRequestedBySql\('cs', '\$2'\)\}, FALSE\) AS requested_by_me/,
    'the flag rides the /merged payload too, for the same viewer parameter');

  // The Communities counts read it inside MY_PROPOSALS_WHERE, on $1.
  const overview = read('src/routes/workshop-overview.js');
  assert.match(overview, /require\('\.\.\/services\/bot-requested-by'\)/);
  assert.match(overview, /OR \$\{botRequestedBySql\('cs', '\$1'\)\}/);
});

test('the predicate selects the right sessions, against the full schema', { timeout: 180000 }, async (t) => {
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = 'bot_requested_by_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: people } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ('maya', 'x', TRUE, FALSE),
            ('homeroom_bot', 'x', TRUE, TRUE),
            ('other', 'x', TRUE, FALSE)
     RETURNING id, username`);
  const maya = people.find((u) => u.username === 'maya');
  const bot = people.find((u) => u.username === 'homeroom_bot');
  const other = people.find((u) => u.username === 'other');

  const { rows: appRows } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, view_visibility)
     VALUES ('Garden', 'garden', $1, 'public') RETURNING id`,
    [maya.id]);
  const appId = appRows[0].id;

  // Five promoted bot/person sessions on one app, each a different corner
  // of the rule:
  //   1  bot, requesters row names maya          → maya's work
  //   2  bot, requesters row names other         → not maya's (the record wins)
  //   3  bot, no requesters row, issue maya filed → maya's (the fallback)
  //   4  bot, shadow build, no request at all     → nobody's
  //   5  maya's own session linking the same issue → hers by authorship,
  //      never through this predicate
  const session = async (userId, issueNumber) => {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, created_from_issue_number, linked_issues)
       VALUES ($1, $2, 'promoted', FALSE, $3,
               CASE WHEN $3::int IS NULL THEN '{}'::int[] ELSE ARRAY[$3::int] END)
       RETURNING id`,
      [appId, userId, issueNumber]);
    return rows[0].id;
  };
  const s1 = await session(bot.id, 208);
  const s2 = await session(bot.id, 209);
  const s3 = await session(bot.id, 210);
  const s4 = await session(bot.id, null);
  const s5 = await session(maya.id, 208);
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id)
     VALUES ($1, 208, $2), ($1, 209, $3)`,
    [appId, maya.id, other.id]);
  // Session 3's fallback: the issue maya filed on the board. The bot files
  // every platform-authored issue as itself, so a second, later copy of the
  // same number filed by somebody else must not displace it.
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, created_by)
     VALUES ($1, 210, 'Water the beds', $2), ($1, 210, 'Same number, filed later', $3)`,
    [appId, maya.id, other.id]);

  const mine = async (viewer) => {
    const { rows } = await pool.query(
      `SELECT cs.id FROM chat_sessions cs WHERE ${botRequestedBySql('cs', '$1')} ORDER BY cs.id`,
      [viewer ? viewer.id : null]);
    return rows.map((r) => r.id);
  };

  assert.deepEqual(await mine(maya), [s1, s3],
    'the requesters row wins, and the filed issue is the fallback when none exists');
  assert.deepEqual(await mine(other), [s2], 'a request recorded for somebody else is theirs, not the filer’s');
  assert.deepEqual(await mine(bot), [], 'the bot is not the person a request is for');
  assert.deepEqual(await mine(null), [], 'a guest binds NULL, and NULL is not anybody');

  // And the same rows through MY_PROPOSALS_WHERE as the Communities counts
  // read it: a viewer's working list is their own sessions plus these.
  const route = require('../src/routes/workshop-overview');
  const { rows: mineList } = await pool.query(
    `SELECT cs.id FROM chat_sessions cs
      WHERE ${route.MY_PROPOSALS_WHERE} ORDER BY cs.id`,
    [maya.id]);
  assert.deepEqual(mineList.map((r) => r.id), [s1, s3, s5],
    'their own session, and the two bot changes built from their requests');
});
