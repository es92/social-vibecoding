'use strict';

// The admin Journey's first session (services/journey.js firstSession): a
// maker's first hour from Make it, and an invited person's from the join.
// The pure reading, the record of a maker's first artefact
// (journey-events.noteFirstArtefactShown), and the reading over the real
// schema in a throwaway database: required when TEST_DATABASE_URL is set,
// skipped when no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const journey = require('../src/services/journey');
const journeyEvents = require('../src/services/journey-events');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const at = (base, seconds) => (seconds == null ? null : new Date(base.getTime() + seconds * 1000).toISOString());

test('the reading: steps against the hour and the two-minute reward, the aha, opens beside joins', () => {
  const t0 = new Date('2026-09-29T08:00:00Z');
  const make = (userId, [reward, invited, running], start = t0) => ({
    path: 'make', user_id: userId, username: `u${userId}`, slug: `p${userId}`, name: `P${userId}`, intent_at: start.toISOString(),
    reward_at: at(start, reward), invited_at: at(start, invited), running_at: at(start, running), said_at: null, suggested_at: null,
  });
  const join = (userId, [said, suggested], start = t0) => ({
    path: 'join', user_id: userId, username: `u${userId}`, slug: 'p1', name: 'P1', intent_at: start.toISOString(),
    reward_at: null, invited_at: null, running_at: null, said_at: at(start, said), suggested_at: at(start, suggested),
  });
  const rows = [
    make(1, [90, 1000, 80]),
    make(2, [200, 4000, null]),
    join(3, [100, null]),
    join(4, [null, 5000]),
  ];
  const since = '2026-09-01T00:00:00Z';
  const r = journey.firstSessionReading(rows, 5, {
    week: { label: '2026-09-28', finished: true }, recordedFrom: { make: since, reward: since, opens: since },
  });
  assert.deepEqual([r.week, r.finished, r.sessionMinutes], ['2026-09-28', true, journey.FIRST_SESSION_MINUTES]);
  assert.equal(r.make.people, 2);
  assert.equal(r.make.notRecorded, null);
  const [reward, invited, running] = r.make.steps;
  assert.deepEqual(reward, { key: 'reward', reached: 2, inSession: 2, medianSeconds: 145, targetSeconds: 120, withinTarget: 1 });
  assert.deepEqual([invited.key, invited.reached, invited.inSession, invited.withinTarget], ['invited', 2, 1, null],
    'an invite after the hour is reached, but not in the session');
  assert.deepEqual([running.key, running.reached], ['running', 1]);
  assert.equal(r.make.aha, 1, 'one maker sent an invite within the hour');
  assert.deepEqual(r.join.steps.map((s) => [s.key, s.reached, s.inSession]), [['said', 1, 1], ['suggested', 1, 0]]);
  assert.equal(r.join.aha, 1, 'one invited person wrote within the hour; a request after it is not the aha');
  assert.deepEqual(r.opens, { opened: 5, joined: 2 });
  assert.deepEqual(r.examples.map((e) => e.userId), [4, 3, 2, 1], 'newest first');
  assert.deepEqual(r.examples[3].steps, { reward: 90, invited: 1000, running: 80 });

  // Before its records began, a measure reads "not recorded", never 0.
  const early = journey.firstSessionReading([], 0, { week: { label: 'all', finished: false } });
  assert.equal(early.make.notRecorded.recorded, false);
  assert.equal(early.opens.opened.recorded, false);
  assert.deepEqual(early.recordedFrom, { make: null, reward: null, opens: null });
  assert.deepEqual(early.make.steps.map((s) => [s.reached, s.medianSeconds]), [[0, null], [0, null], [0, null]]);
});

test('the first session\'s create marks the project, and the sketch records its maker\'s first artefact', () => {
  // The make screen sends its door: 'first-session' by default, 'create'
  // from the Create button, which the Journey does not count (it reads
  // `from = 'first-session'`).
  assert.match(read('frontend/src/features/first-session/make.tsx'), /from: entry,/);
  const apps = read('src/routes/apps.js');
  assert.match(apps, /const MAKE_ORIGINS = new Set\(\['first-session', 'create'\]\);/);
  assert.match(apps, /\.\.\.\(MAKE_ORIGINS\.has\(req\.body\.from\) \? \{ from: req\.body\.from \} : \{\}\),/,
    'app_created carries it, and nothing else a client sends');
  assert.match(apps, /noteFirstArtefactShown\(pool, \{ appId: app\.id, userId: req\.user\.id \}\)/);
  assert.match(read('src/db/schema.sql'),
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_events_first_artefact_once\n {2}ON events \(app_id\)\n {2}WHERE event_type = 'first_artefact_shown';/);
});

test('first artefacts and the first-session reading against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = 'journey_first_session_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  const schema = read('src/db/schema.sql');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  const user = async (username, cols = {}) => {
    const base = { has_platform_access: true, ...cols };
    const keys = Object.keys(base);
    return (await pool.query(
      `INSERT INTO users (username, password, ${keys.join(', ')})
       VALUES ($1, 'x', ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [username, ...keys.map((k) => base[k])])).rows[0].id;
  };
  const project = async (slug, createdBy, createdAt = null) => {
    const { rows: [c] } = await pool.query('INSERT INTO communities (created_by) VALUES ($1) RETURNING id', [createdBy]);
    return (await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, community_id, created_at)
       VALUES ($1, $2, $3, 'running', $4, COALESCE($5::timestamptz, NOW())) RETURNING id, community_id`,
      [slug.replace(/-/g, ' '), slug, createdBy, c.id, createdAt])).rows[0];
  };
  const event = (type, { userId = null, appId = null, when, metadata = {} }) => pool.query(
    `INSERT INTO events (user_id, app_id, event_type, metadata, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [userId, appId, type, JSON.stringify(metadata), when]);
  const week = () => ({
    start: new Date(Date.now() - 24 * 3600 * 1000), end: new Date(Date.now() + 60 * 1000), label: '2026-09-28', finished: false,
  });

  const ana = await user('ana');
  const ben = await user('ben');
  const cat = await user('cat');
  const tess = await user('tess', { test_account_created_at: new Date() });

  await t.test('before anything was recorded, the reading says so', async () => {
    const r = await journey.firstSession(pool, { week: week() });
    assert.equal(r.make.notRecorded.recorded, false);
    assert.equal(r.opens.opened.recorded, false);
    assert.deepEqual([r.make.people, r.join.people, r.examples.length], [0, 0, 0]);
  });

  const book = await project('book-swap', ana);
  await t.test('a sketch is its maker\'s first artefact once, and only while the project is young', async () => {
    assert.equal(await journeyEvents.noteFirstArtefactShown(pool, { appId: book.id, userId: ben }), false, 'not the maker');
    assert.equal(await journeyEvents.noteFirstArtefactShown(pool, { appId: book.id, userId: ana }), true);
    assert.equal(await journeyEvents.noteFirstArtefactShown(pool, { appId: book.id, userId: ana }), false, 'once per project');
    const old = await project('old-thing', ana, new Date(Date.now() - 3 * 86400000));
    assert.equal(await journeyEvents.noteFirstArtefactShown(pool, { appId: old.id, userId: ana }), false, 'too old to be a first session');
    assert.equal(await journeyEvents.noteFirstArtefactShown(pool, { appId: 'x', userId: ana }), false);
    assert.equal(await journeyEvents.noteFirstArtefactShown(pool, { appId: book.id, userId: null }), false);
    const { rows } = await pool.query(
      "SELECT user_id, app_id, metadata FROM events WHERE event_type = 'first_artefact_shown'");
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].user_id, rows[0].app_id, rows[0].metadata.artefact], [ana, book.id, 'sketch']);
    assert.equal(typeof rows[0].metadata.secondsFromCreation, 'number');
  });

  await t.test('a maker\'s and an invited person\'s first hour, real people only, in the window', async () => {
    const start = new Date(Date.now() - 2 * 3600 * 1000);
    await event('app_created', { userId: ana, appId: book.id, when: start, metadata: { from: 'first-session' } });
    await pool.query("UPDATE events SET created_at = $1 WHERE event_type = 'first_artefact_shown' AND app_id = $2",
      [at(start, 40), book.id]);
    await pool.query('UPDATE apps SET first_running_at = $1 WHERE id = $2', [at(start, 95), book.id]);
    const { rows: [invite] } = await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at, created_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days', $5) RETURNING id`,
      [crypto.randomBytes(8).toString('hex'), book.community_id, book.id, ana, at(start, 300)]);
    const joinedAt = new Date(start.getTime() + 1000 * 1000);
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, created_at, applied_at)
       VALUES ($1, $2, 'joined', $3, $3)`, [invite.id, ben, joinedAt]);
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at) VALUES ($1, $2, 'hi all', 'message', $3)`,
      [book.id, ben, at(joinedAt, 60)]);
    await pool.query(
      'INSERT INTO issues (app_id, title, created_by, created_at) VALUES ($1, $2, $3, $4)',
      [book.id, 'Sort by distance', ben, at(joinedAt, 4000)]);
    // Not first sessions: a project made elsewhere, one made last week, and a test account's.
    const other = await project('tally', cat);
    await event('app_created', { userId: cat, appId: other.id, when: at(start, 10), metadata: {} });
    await event('app_created', { userId: cat, appId: other.id, when: new Date(Date.now() - 9 * 86400000), metadata: { from: 'first-session' } });
    const tests = await project('tess-app', tess);
    await event('app_created', { userId: tess, appId: tests.id, when: at(start, 20), metadata: { from: 'first-session' } });
    // Two opens of live links in the window, one before it.
    await event('invite_opened', { appId: book.id, when: at(start, 900), metadata: { inviteId: invite.id, signedIn: false } });
    await event('invite_opened', { userId: ben, appId: book.id, when: at(start, 950), metadata: { inviteId: invite.id, signedIn: true } });
    await event('invite_opened', { appId: book.id, when: new Date(Date.now() - 3 * 86400000), metadata: { inviteId: invite.id, signedIn: false } });

    const r = await journey.firstSession(pool, { week: week() });
    assert.equal(r.make.notRecorded, null);
    assert.equal(r.make.people, 1, 'ana alone made a project from the first session in the window');
    assert.deepEqual(r.make.steps.map((s) => [s.key, s.reached, s.medianSeconds]),
      [['reward', 1, 40], ['invited', 1, 300], ['running', 1, 95]]);
    assert.equal(r.make.steps[0].withinTarget, 1, 'the sketch inside two minutes');
    assert.equal(r.make.aha, 1);
    assert.equal(r.join.people, 1);
    assert.deepEqual(r.join.steps.map((s) => [s.key, s.reached, s.medianSeconds, s.inSession]),
      [['said', 1, 60, 1], ['suggested', 1, 4000, 0]]);
    assert.equal(r.join.aha, 1);
    assert.deepEqual(r.opens, { opened: 2, joined: 1 });
    assert.deepEqual(r.examples.map((e) => [e.path, e.name, e.slug]), [['join', 'ben', 'book-swap'], ['make', 'ana', 'book-swap']]);
    assert.ok(r.recordedFrom.make && r.recordedFrom.reward && r.recordedFrom.opens);

    // One cohort, and the admin-edited left-out list.
    const cohort = await journey.firstSession(pool, { week: week(), memberIds: new Set([ben]) });
    assert.deepEqual([cohort.make.people, cohort.join.people], [0, 1]);
    const left = await journey.firstSession(pool, { week: week(), leftOutIds: [ana] });
    assert.deepEqual([left.make.people, left.join.people], [0, 1]);
  });
});
