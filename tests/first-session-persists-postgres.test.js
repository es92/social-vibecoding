'use strict';

// "What do you want to make?" is owed until it is answered, against the
// REAL schema in a throwaway PostgreSQL database, through the real session
// middleware, /api/auth/me and the first session's routes
// (src/routes/onboarding.js, src/services/first-session.js).
//
// Production, 5 Oct 2026: a new account was shown the make screen, answered
// nothing, reloaded, and landed on an empty Home for good, because the
// screen's start (POST /api/me/first-session/started) was recorded as the
// join screen's answer. Now the start is a record of its own, and only Make
// it or "Look around first" ends the question; every boot until then reads
// needsCommunitiesChoice and storyFirstSession TRUE on /api/auth/me, which
// is what the shell opens the make screen from
// (tests/first-session-persists.test.js runs that half).
//
// Skipped when no server is reachable, required when TEST_DATABASE_URL is
// set, like tests/onboarding-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the first session\'s question is owed until it is answered, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 30000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'first_session_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6, connectionTimeoutMillis: 30000 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  require('../src/db/pool').getPool = () => pool;
  const ws = require('../src/services/ws');
  ws.pushNotificationToUser = () => {};
  ws.sendSystemMessage = async () => {};
  require('../src/services/events').record = async () => {};
  const cookieParser = require('cookie-parser');
  const { authMiddleware } = require('../src/middleware/auth');
  const { authRoutes } = require('../src/routes/auth');
  const { onboardingRoutes } = require('../src/routes/onboarding');
  const firstSession = require('../src/services/first-session');

  // Every sign-up path writes both flags (routes/auth.js, email-signup.js,
  // test-accounts.js); `access` FALSE is the waiting room.
  const person = async (username, { access = true, owed = true } = {}) => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, needs_communities_choice, getting_started_gate)
       VALUES ($1, 'x', $2, $3, $3) RETURNING id, username`,
      [username, access, owed]);
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [token, u.id]);
    return { ...u, token };
  };
  const project = async (slug, createdBy, { selfHosted = false } = {}) => {
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, status, view_visibility, collab_visibility)
       VALUES ($1, $1, $2, $3, 'running', 'public', 'public') RETURNING id`,
      [slug, createdBy, selfHosted]);
    return (await pool.query('SELECT * FROM apps WHERE id = $1', [a.id])).rows[0];
  };
  // The platform's own project, which every account with access is in from
  // the start: being in it is not "already somewhere".
  await project('homeroom', null, { selfHosted: true });

  const server = express();
  server.use(express.json(), cookieParser());
  server.use(authMiddleware({}));
  server.use(authRoutes({}));
  server.use(onboardingRoutes({ selfAppPublicVoting: true }));
  const listener = await new Promise((resolve) => { const s = server.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const post = (who, path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `session=${who.token}` },
    body: JSON.stringify(body || {}),
  });
  // One boot of the shell: what it reads to decide on the make screen.
  const boot = async (who) => {
    const { user } = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: `session=${who.token}` } })).json();
    return { access: user.hasPlatformAccess, owed: user.needsCommunitiesChoice, make: user.storyFirstSession };
  };
  const cardShows = async (who) => {
    const { user } = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: `session=${who.token}` } })).json();
    return user.showGettingStarted;
  };
  const row = async (who) => (await pool.query(
    `SELECT needs_communities_choice AS owed, communities_onboarded_at,
            getting_started_seen->>'first_session' AS first_session,
            getting_started_seen->>'join_answer' AS join_answer,
            getting_started_seen->>'first_session_answer' AS answer
       FROM users WHERE id = $1`, [who.id])).rows[0];

  t.after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  await t.test('shown and not answered: every later boot is asked again, and the start is kept once', async () => {
    const maya = await person('maya');
    assert.deepEqual(await boot(maya), { access: true, owed: true, make: true });
    // The make screen opens, and records that it was asked.
    assert.equal((await post(maya, '/api/me/first-session/started', { via: 'sign_in' })).status, 200);
    assert.deepEqual(await row(maya),
      { owed: true, communities_onboarded_at: null, first_session: 'sign_in', join_answer: null, answer: null });
    // A reload, a new tab, the app relaunched, a sign-in again: still asked.
    assert.deepEqual(await boot(maya), { access: true, owed: true, make: true });
    // Asked again on that boot, recorded again: the first record stands.
    assert.equal((await post(maya, '/api/me/first-session/started', {})).status, 200);
    assert.equal((await row(maya)).first_session, 'sign_in', 'recorded once, the first time');
    assert.deepEqual(await boot(maya), { access: true, owed: true, make: true });

    // Make it: POST /api/apps answers it as it makes the project (its
    // `from: 'first-session'` branch calls exactly this).
    await project('maya-club', maya.id);
    await firstSession.answerJoinScreenByMaking(pool, maya.id);
    assert.deepEqual(await row(maya),
      { owed: false, communities_onboarded_at: null, first_session: 'sign_in', join_answer: 'sign_in', answer: 'made' },
      'Journey still reads how it reached them; the answer sits beside it');
    assert.deepEqual(await boot(maya), { access: true, owed: false, make: false });
    // #4601: a new account gets the Getting started card (and the gate it
    // is) however it came in. The join screen was never answered, and it
    // does not need to be.
    assert.equal(await cardShows(maya), true, 'the card shows for a new account that made a project');
  });

  await t.test('"Look around first" ends it too, once', async () => {
    const lena = await person('lena');
    assert.equal((await post(lena, '/api/me/first-session/started', {})).status, 200);
    assert.equal((await row(lena)).first_session, 'story');
    const res = await post(lena, '/api/me/first-session/look-around');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(await row(lena),
      { owed: false, communities_onboarded_at: null, first_session: 'story', join_answer: 'story', answer: 'looked_around' });
    assert.deepEqual(await boot(lena), { access: true, owed: false, make: false }, 'the next boot is Home');
    // A second press, or a late replay, changes nothing.
    assert.equal((await post(lena, '/api/me/first-session/look-around')).status, 200);
    assert.equal((await row(lena)).answer, 'looked_around');
    // Nor does a late start.
    assert.equal((await post(lena, '/api/me/first-session/started', { via: 'sign_in' })).status, 200);
    assert.equal((await row(lena)).first_session, 'story');
  });

  await t.test('an account already in a group, or with a project of its own, is never asked what to make', async () => {
    // An invitee by a link: the redemption answers the join screen itself
    // (services/community-invites.js), so it is not owed at all.
    const ivy = await person('ivy');
    await pool.query(
      `UPDATE users SET needs_communities_choice = FALSE,
              getting_started_seen = jsonb_build_object('join_answer', 'invite') WHERE id = $1`, [ivy.id]);
    assert.deepEqual(await boot(ivy), { access: true, owed: false, make: false });
    assert.equal(await cardShows(ivy), true, '#4601: an invitee gets the card too');
    // Anything else that got them in first: a group they are a member of,
    // or a project made some other way. Asked the join screen, which lists
    // what they are in, rather than what to make.
    const grace = await person('grace', { owed: false });
    const club = await project('book-club', grace.id);
    const noor = await person('noor');
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by) VALUES ($1, $2, 'member', $3)`,
      [club.id, noor.id, grace.id]);
    assert.deepEqual(await boot(noor), { access: true, owed: true, make: false });
    const owen = await person('owen');
    await project('owen-run', owen.id);
    assert.deepEqual(await boot(owen), { access: true, owed: true, make: false });
    // Homeroom alone is not somewhere: every account with access is in it.
    const hal = await person('hal');
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS n FROM community_members m JOIN apps a ON a.community_id = m.community_id
        WHERE m.user_id = $1 AND a.self_hosted`, [hal.id])).rows[0].n, 1);
    assert.deepEqual(await boot(hal), { access: true, owed: true, make: true });
  });

  await t.test('the waiting room: the start is kept, the question waits for the day they are let in', async () => {
    const wren = await person('wren', { access: false });
    // The story's sheet records the start before the account is let in.
    assert.equal((await post(wren, '/api/me/first-session/started', {})).status, 200);
    assert.deepEqual(await row(wren),
      { owed: true, communities_onboarded_at: null, first_session: 'story', join_answer: null, answer: null });
    // The shell keeps them in the waiting room (hasPlatformAccess false),
    // and the answer is not open to them there.
    assert.equal((await boot(wren)).access, false);
    assert.notEqual((await post(wren, '/api/me/first-session/look-around')).status, 200);
    assert.equal((await row(wren)).owed, true);
    // Let in: the first boot asks what to make.
    await pool.query('UPDATE users SET has_platform_access = TRUE, platform_access_granted_at = NOW() WHERE id = $1', [wren.id]);
    assert.deepEqual(await boot(wren), { access: true, owed: true, make: true });
  });

  await t.test('with the story switched off it is the join screen, as before', async () => {
    const sam = await person('sam');
    await firstSession.setStoryLanding(pool, { enabled: false });
    try {
      assert.deepEqual(await boot(sam), { access: true, owed: true, make: false });
    } finally {
      await firstSession.setStoryLanding(pool, { enabled: true });
    }
    assert.deepEqual(await boot(sam), { access: true, owed: true, make: true });
  });
});
