'use strict';

// The Journey page's one-person reading (#3369), against the real schema in a
// throwaway database: required when TEST_DATABASE_URL is set, skipped when no
// server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const journey = require('../src/services/journey');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('one person: first mile, found and came back, possibly lost, failures, Challenges and the card', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'journey_person_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const now = new Date('2026-10-07T12:00:00Z');
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const host = (await one(
    "INSERT INTO users (username, password, has_platform_access) VALUES ('host', 'x', TRUE) RETURNING id")).id;
  const mia = (await one(
    `INSERT INTO users (username, password, has_platform_access, platform_access_granted_at, created_at,
                        communities_onboarded_at, tour_done_at, getting_started_seen)
     VALUES ('mia', 'x', TRUE, '2026-10-01T09:30:00Z', '2026-10-01T09:20:00Z', '2026-10-01T09:40:00Z',
             '2026-10-01T09:45:00Z', '{"join_answer":"joined","tour_ended":"skip","tour_step":1}') RETURNING id`)).id;
  await pool.query("INSERT INTO waitlist_signups (email, submitted_at, released_at, linked_user_id) VALUES ('mia@example.test', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', $1)", [mia]);
  const app = async (slug, by) => (await one(
    "INSERT INTO apps (name, slug, created_by, status) VALUES ($1, $1, $2, 'running') RETURNING id", [slug, by])).id;
  const runClub = await app('run-club', host);
  const tally = await app('tally', host);
  const mine = await app('mias-app', mia);
  await pool.query(`INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES
    ($1, $4, 300, '2026-10-01'), ($1, $4, 200, '2026-10-02'), ($1, $4, 100, '2026-10-03'),
    ($2, $4, 8, '2026-10-02'),
    ($3, $4, 900, '2026-10-02')`, [runClub, tally, mine, mia]);

  const ev = (seconds, metadata, appId = null) => pool.query(
    `INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
     VALUES ($1, $2, 'ui_experience', $3::jsonb, '2026-10-01T10:00:00Z'::timestamptz + make_interval(secs => $4::int))`,
    [mia, appId, JSON.stringify(metadata), seconds]);
  // A visit handed to her by an invite link into Run Club…
  await ev(0, { kind: 'screen_visit', screen: 'home', via: 'address', sequence: 1 });
  await ev(40, { kind: 'screen_visit', screen: 'app', via: 'handed', sequence: 2 }, runClub);
  // …and, the next day, a fast circling visit that ended with nothing.
  const circle = ['home', 'discover', 'home', 'communities', 'home', 'challenges', 'home', 'discover', 'home', 'profile'];
  for (let i = 0; i < circle.length; i += 1) {
    await ev(86400 + i * 3, { kind: 'screen_visit', screen: circle[i], via: i === 0 ? 'returned' : 'own', sequence: i + 1 });
  }
  // A failed attempt is not a landing; it ends the visit's last screen.
  await ev(86400 + 30, { kind: 'action_outcome', outcome: 'failure', errorCode: 'network', screen: 'app_detail' });

  const season = (await one(
    "INSERT INTO seasons (name, starts_at, ends_at) VALUES ('S', '2026-09-01', '2026-12-01') RETURNING id")).id;
  const event = (await one(
    `INSERT INTO season_events (name, starts_at, ends_at, scoring_formula, season_id)
     VALUES ('E', '2026-09-01', '2026-12-01', '{}', $1) RETURNING id`, [season])).id;
  const tpl = (await one(
    "INSERT INTO challenge_templates (category, goal, task, reward) VALUES ('Onboarding', 'Try an app', 't', 'r') RETURNING id")).id;
  const ch = (await one(
    'INSERT INTO challenges (season_event_id, challenge_template_id) VALUES ($1, $2) RETURNING id', [event, tpl])).id;
  await pool.query(
    `INSERT INTO user_activities (user_id, season_event_id, activity_type, activity_at, challenge_id, points, source)
     VALUES ($1, $2, 'challenge', '2026-10-01T10:05:00Z', $3, 500, 'challenge_scorer')`, [mia, event, ch]);

  // Where she came from (#6540): the invite link she opened first, and the
  // waitlist landing. Only hosts and tags.
  await pool.query(
    `INSERT INTO community_invite_opens (maker_id, app_id, user_id, referrer_host, via, opened_at)
     VALUES ($1, $2, $3, 'discord.com', 'copied', '2026-10-01T08:50:00Z')`, [host, runClub, mia]);
  await pool.query(
    `UPDATE waitlist_signups SET referrer_host = 'none', utm_source = 'x',
            utm_campaign = 'launch', ref = 'post-1' WHERE linked_user_id = $1`, [mia]);

  const p = await journey.person(pool, { userId: mia, now });
  assert.equal(p.name, 'mia');
  assert.equal(p.cohort, '2026-10-01');
  assert.deepEqual(p.cameFrom, {
    invite: { referrerHost: 'discord.com', via: 'copied', project: 'run-club', at: '2026-10-01T08:50:00.000Z' },
    waitlist: { referrerHost: 'none', utmSource: 'x', utmCampaign: 'launch', ref: 'post-1', at: '2026-10-01T09:00:00.000Z' },
  });
  assert.equal(p.firstMile.furthest, 'first_act');
  assert.deepEqual(p.firstMile.tour, { ended: 'skip', step: 1, at: new Date('2026-10-01T09:45:00Z') });
  assert.deepEqual(p.found.map((f) => [f.slug, f.how, f.stayed]), [['run-club', 'handed', true], ['tally', null, false]],
    'what she reached first, how, and whether it held her; her own app is not a find');
  assert.deepEqual(p.cameBackTo.map((a) => [a.slug, a.days]), [['run-club', 3]]);
  assert.deepEqual(p.usedOftenNotOnHome.map((a) => a.slug), ['run-club'], 'used on three days and not on her Home');
  assert.equal(p.visits, 2);
  assert.deepEqual(p.waysIn, { address: 1, returned: 1 });
  assert.equal(p.possiblyLost.length, 1);
  assert.equal(p.possiblyLost[0].path.length, 10);
  assert.deepEqual(p.possiblyLost[0].cutoffs, journey.LOST_CUTOFFS, 'the flag says which cut-offs it used');
  assert.equal(p.failedAttempts, 1);
  assert.ok(p.challenges.openedAt, 'she opened Challenges');
  assert.deepEqual(p.challenges.credits.map((c) => [c.title, c.firstChallenge]), [['Try an app', true]]);
  assert.deepEqual(p.navigation, { recorded: true });
  assert.equal(await journey.person(pool, { userId: 999999, now }), null);
});

test('cohortSources counts each person once, by the earlier way in, and prefers utm_source (#6540)', () => {
  const at = (iso) => new Date(iso).toISOString();
  const invite = (referrerHost, when) => ({ referrerHost, via: 'copied', project: 'Pixel Garden', at: at(when) });
  const wait = (referrerHost, utmSource, when) => ({ referrerHost, utmSource, utmCampaign: null, ref: null, at: at(when) });
  const people = [
    // Both records: the invite came first, so it is her way in.
    { cameFrom: { invite: invite('discord.com', '2026-11-01T10:00:00Z'), waitlist: wait('t.co', null, '2026-11-01T12:00:00Z') } },
    { cameFrom: { invite: invite('none', '2026-11-01T10:00:00Z'), waitlist: null } },
    // The waitlist came first, and its utm_source is the word shown.
    { cameFrom: { invite: invite('discord.com', '2026-11-02T10:00:00Z'), waitlist: wait('t.co', 'x', '2026-11-01T09:00:00Z') } },
    { cameFrom: { invite: invite('discord.com', '2026-11-01T10:00:00Z'), waitlist: null } },
    { cameFrom: { invite: null, waitlist: null } },
  ];
  assert.deepEqual(journey.cohortSources(people), [
    { way: 'invite', from: 'discord.com', people: 2 },
    { way: 'invite', from: 'none', people: 1 },
    { way: 'unknown', from: null, people: 1 },
    { way: 'waitlist', from: 'x', people: 1 },
  ]);
  assert.deepEqual(journey.cohortSources([]), []);
});
