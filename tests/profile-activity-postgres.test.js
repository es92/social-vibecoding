'use strict';

// The "This week" card's two reads (#5626) against the full PostgreSQL schema
// (src/routes/profile.js): seven UTC days whether or not a row exists, one
// person's rows alone, apps opened or used, and an index under the read that
// runs on every open of the profile.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const profile = require('../src/routes/profile');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the week against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'profile_activity_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [username])).rows[0].id;
  const app = async (slug) => (await pool.query(
    `INSERT INTO apps (name, slug, repo_url) VALUES ($1, $2, $3) RETURNING id`,
    [slug, slug, `https://github.com/acme/${slug}`])).rows[0].id;
  const me = await user('activity_me');
  const someone = await user('activity_someone');
  const [notes, runs, chess, old] = await Promise.all(['notes', 'runs', 'chess', 'old'].map(app));

  const { rows: [{ today }] } = await pool.query(
    `SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date::text AS today`);
  const dayAgo = (n) => {
    const at = new Date(`${today}T00:00:00Z`);
    at.setUTCDate(at.getUTCDate() - n);
    return at.toISOString().slice(0, 10);
  };
  const time = (appId, by, n, seconds) => pool.query(
    `INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES ($1, $2, $3, $4)`,
    [appId, by, seconds, dayAgo(n)]);
  await time(notes, me, 0, 600);
  await time(runs, me, 0, 30);
  await time(notes, me, 6, 120); // the week's first day
  await time(old, me, 7, 9000); // a day too old
  await time(chess, someone, 0, 5000); // somebody else
  const opened = (appId, by, at) => pool.query(
    `INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
     VALUES ($1, $2, 'dapp_opened', '{}'::jsonb, $3::timestamptz)`, [by, appId, at]);
  await opened(chess, me, `${dayAgo(6)}T00:00:00Z`); // opened, never used
  await opened(notes, me, `${dayAgo(1)}T12:00:00Z`); // counted once with its time
  await opened(old, me, `${dayAgo(7)}T23:59:59Z`); // a second too old
  await opened(old, someone, `${today}T00:00:00Z`); // somebody else

  const read = async (id) => profile.shapeActivity(
    (await pool.query(profile.SUMMARY_ACTIVITY_DAYS_SQL, [id])).rows,
    (await pool.query(profile.SUMMARY_ACTIVITY_APPS_SQL, [id])).rows[0]);

  const week = await read(me);
  assert.deepEqual(week.days.map((d) => d.date), [6, 5, 4, 3, 2, 1, 0].map(dayAgo), 'seven days, today last');
  assert.deepEqual(week.days.map((d) => d.seconds), [120, 0, 0, 0, 0, 0, 630]);
  assert.equal(week.totalSeconds, 750);
  assert.equal(week.appsOpened, 3, 'notes and runs by their time, chess by its open');

  const nobody = await read(await user('activity_new'));
  assert.equal(nobody.days.length, 7);
  assert.equal(nobody.totalSeconds, 0);
  assert.equal(nobody.appsOpened, 0);

  // ── The week's accomplishments (#6464): live changes and challenges ────
  //
  // The same seven UTC days: a merge still going live, a headless auto
  // session, an older merge and somebody else's row are all out.
  const merged = (appId, by, at, { headless = false, status = 'merged' } = {}) => pool.query(
    `INSERT INTO chat_sessions (user_id, app_id, status, is_headless, merged_at, live_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)`,
    [by, appId, status, headless, at]);
  await merged(notes, me, `${dayAgo(0)}T01:00:00Z`);
  await merged(runs, me, `${dayAgo(6)}T23:00:00Z`); // the week's first day
  await merged(notes, me, `${dayAgo(0)}T02:00:00Z`); // a second in the same app
  await merged(chess, me, `${dayAgo(7)}T23:59:59Z`); // a second too old
  await merged(chess, me, `${dayAgo(1)}T00:00:00Z`, { headless: true }); // never authored
  await merged(notes, someone, `${dayAgo(1)}T00:00:00Z`); // somebody else
  // Merged but not live: a row the merge machine inserted and has not put
  // into production yet. The insert trigger makes an ordinary merged row
  // live, and only the machine's writer marker keeps it dark.
  const dark = await pool.connect();
  try {
    await dark.query('BEGIN');
    await dark.query("SET LOCAL app.wf_writer = 'transition'");
    await dark.query(
      `INSERT INTO chat_sessions (user_id, app_id, status, is_headless, merged_at, live_at)
       VALUES ($1, $2, 'merged', FALSE, $3::timestamptz, NULL)`,
      [me, chess, `${dayAgo(1)}T00:00:00Z`]);
    await dark.query('COMMIT');
  } finally {
    dark.release();
  }

  const weekMerged = profile.shapeWeek(
    (await pool.query(profile.SUMMARY_WEEK_MERGED_SQL, [me])).rows[0],
    (await pool.query(profile.SUMMARY_WEEK_APPS_SQL, [me])).rows,
    0,
  );
  assert.equal(weekMerged.merged, 3, 'the three live merges in the window, nobody else\'s');
  assert.deepEqual(weekMerged.apps, [{ slug: 'notes', name: 'notes' }, { slug: 'runs', name: 'runs' }],
    'one entry per app, most recently merged first');
  const nobodyMerged = profile.shapeWeek(
    (await pool.query(profile.SUMMARY_WEEK_MERGED_SQL, [await user('activity_no_merges')])).rows[0],
    [],
    0,
  );
  assert.deepEqual(nobodyMerged, { merged: 0, apps: [], challengesDone: 0 });

  // Challenges: two are done, but only one's latest credit fell in the week.
  const { rows: [season] } = await pool.query(
    `INSERT INTO seasons (name, starts_at, ends_at, is_active)
     VALUES ('Activity season', NOW() - INTERVAL '30 days', NOW() + INTERVAL '30 days', TRUE) RETURNING id`);
  const { rows: [event] } = await pool.query(
    `INSERT INTO season_events (name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
     VALUES ('Activity event', NOW() - INTERVAL '30 days', NOW() + INTERVAL '30 days', TRUE, '{}'::jsonb, $1, 'season')
     RETURNING id`, [season.id]);
  const addChallenge = async () => {
    const { rows: [template] } = await pool.query(
      `INSERT INTO challenge_templates (category, goal, task, reward)
       VALUES ('PERSISTENT', 'Do a thing', 'Do it.', '10') RETURNING id`);
    const { rows: [challenge] } = await pool.query(
      `INSERT INTO challenges (season_event_id, challenge_template_id) VALUES ($1, $2) RETURNING id`,
      [event.id, template.id]);
    return challenge.id;
  };
  const credit = (challengeId, n) => pool.query(
    `INSERT INTO user_activities (user_id, season_event_id, activity_type, points, activity_at, challenge_id)
     VALUES ($1, $2, 'challenge_completion', 10, $3::timestamptz, $4)`,
    [me, event.id, `${dayAgo(n)}T12:00:00Z`, challengeId]);
  await credit(await addChallenge(), 2);
  await credit(await addChallenge(), 8); // done, but not this week

  assert.equal(await profile.readChallengesDoneSince(pool, me, season.id), 1,
    'the latest credit, not the completion total');
  const totals = await profile.readChallengeTotals(pool, me, season.id);
  assert.equal(totals.done, 2, 'both are still done in the season');
  assert.equal(totals.total, 2);

  // A tiny table prefers a scan, so ask whether the index CAN serve the read.
  const client = await pool.connect();
  try {
    await client.query('SET enable_seqscan = off');
    const plan = (await client.query(
      `EXPLAIN ${profile.SUMMARY_ACTIVITY_DAYS_SQL.replace('$1', String(me))}`)).rows
      .map((row) => row['QUERY PLAN']).join('\n');
    assert.match(plan, /idx_app_activity_user_date/);
  } finally {
    await client.query('RESET enable_seqscan');
    client.release();
  }
});
