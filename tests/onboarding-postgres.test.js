'use strict';

// A new account's first run (communities, stage 5), against the REAL schema
// in a throwaway PostgreSQL database: what "What communities do you want to
// join?" lists and what answering it does, and the Getting started card's
// three steps ticking off from what the person did. Driven through the
// routes (src/routes/onboarding.js) so the HTTP shapes are pinned too.
// Skipped when no server is reachable, required when TEST_DATABASE_URL is
// set, like tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the first run: join screen and Getting started, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'onboarding_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  require('../src/db/pool').getPool = () => pool;
  const ws = require('../src/services/ws');
  ws.pushNotificationToUser = () => {};
  ws.sendSystemMessage = async () => {};
  require('../src/services/events').record = async () => {};
  const { onboardingRoutes } = require('../src/routes/onboarding');

  const { rows: people } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access, needs_communities_choice) VALUES
       ('newbie', 'x', TRUE, TRUE), ('grace', 'x', TRUE, FALSE), ('old_hand', 'x', TRUE, FALSE),
       ('skipper', 'x', TRUE, TRUE)
     RETURNING id, username`
  );
  const [newbie, grace, oldHand, skipper] = people;
  const app = async (n, fields) => {
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, status, view_visibility, collab_visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [n, fields.slug, fields.createdBy ?? grace.id, !!fields.selfHosted, fields.status || 'running',
        fields.view || 'public', fields.collab || 'public']
    );
    // Re-read: the community is minted by an AFTER INSERT trigger, so
    // RETURNING still shows the row without it.
    return (await pool.query('SELECT * FROM apps WHERE id = $1', [rows[0].id])).rows[0];
  };
  // Homeroom first: the platform's own project, which every account with
  // platform access is already in (the trigger in schema.sql).
  const homeroom = await app('Homeroom', { slug: 'homeroom', selfHosted: true, createdBy: null });
  const garden = await app('City garden', { slug: 'city-garden' });
  const soccer = await app('Pickup soccer', { slug: 'pickup-soccer' });
  const club = await app('Book club', { slug: 'book-club', view: 'private', collab: 'private' });
  const diary = await app('Diary', { slug: 'diary', view: 'private', collab: 'private' });
  const broken = await app('Broken', { slug: 'broken', status: 'error' });
  // The smallest open community, but one an admin has featured.
  const chess = await app('Chess club', { slug: 'chess-club' });
  await pool.query('INSERT INTO featured_apps (app_id, sort_order) VALUES ($1, 0)', [chess.id]);
  // The garden describes itself in its dapp.json; the soccer club does not.
  await pool.query(`UPDATE apps SET manifest_snapshot = $2 WHERE id = $1`,
    [garden.id, { description: '  Swap seeds and   plan the shared plots.  ' }]);
  // Members, so the open communities sort by size: the garden is bigger.
  await pool.query(
    `INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $3, 'joined'), ($2, $3, 'joined'), ($1, $4, 'joined')`,
    [garden.community_id, soccer.community_id, oldHand.id, grace.id]);
  // Grace invited the newcomer into her private group.
  await pool.query(
    `INSERT INTO app_collaborators (app_id, user_id, status, invited_by) VALUES ($1, $2, 'member', NULL), ($1, $3, 'invited', $2)`,
    [club.id, grace.id, newbie.id]);

  let viewer = { id: newbie.id, username: newbie.username, isAdmin: false };
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.user = viewer; next(); });
  server.use(onboardingRoutes({ selfAppPublicVoting: true }));
  const listener = await new Promise((resolve) => { const s = server.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const inCommunity = async (a, userId) => (await pool.query(
    'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2', [a.community_id, userId])).rows.length > 0;

  t.after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  await t.test('the join screen lists Homeroom, the invite, what is featured, then open communities by size', async () => {
    const res = await call('GET', '/api/me/join-suggestions');
    assert.equal(res.status, 200);
    const list = res.data.communities;
    assert.deepEqual(list.map((c) => c.slug), ['homeroom', 'book-club', 'chess-club', 'city-garden', 'pickup-soccer'],
      'the featured community leads the open ones, however small');
    list.splice(2, 1);
    assert.equal(list[0].detail, 'Contribute to the Homeroom platform');
    assert.equal(list[0].checked, true, 'already in Homeroom, so it arrives ticked');
    assert.equal(list[1].detail, 'Invited by @grace');
    assert.equal(list[1].checked, true, 'an invite arrives ticked');
    assert.equal(list[2].detail, 'Swap seeds and plan the shared plots.',
      'a community says what it is, in its own dapp.json description, tidied');
    assert.equal(list[3].detail, '', 'and says nothing when it has none, rather than the same words on every row');
    assert.equal(list[2].checked, false);
    assert.ok(!list.some((c) => c.slug === diary.slug), 'a private project nobody invited you to is never offered');
    assert.ok(!list.some((c) => c.slug === broken.slug), 'nor a project that is not running');
  });

  await t.test('Homeroom is offered only where it is listed anywhere else', async () => {
    const onboarding = require('../src/services/onboarding');
    const hidden = await onboarding.joinSuggestions(pool, newbie.id, { showSelfHosted: false });
    assert.ok(!hidden.some((c) => c.self_hosted));
  });

  await t.test('the Getting started card waits for the join screen', async () => {
    const res = await call('GET', '/api/me/getting-started');
    assert.equal(res.data.show, false);
  });

  await t.test('answering joins what was ticked, accepts the invite, and leaves an unticked Homeroom', async () => {
    assert.equal(await inCommunity(homeroom, newbie.id), true, 'in Homeroom by default');
    const res = await call('POST', '/api/me/communities', { join: ['book-club', 'city-garden', 'diary', 'nope'] });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.joined.sort(), ['book-club', 'city-garden']);
    assert.deepEqual(res.data.left, ['homeroom']);
    assert.equal(await inCommunity(garden, newbie.id), true);
    assert.equal(await inCommunity(homeroom, newbie.id), false, 'unticked: left');
    assert.equal(await inCommunity(diary, newbie.id), false, 'a private project is not joined by naming it');
    const collab = await pool.query(
      'SELECT status FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [club.id, newbie.id]);
    assert.equal(collab.rows[0].status, 'member', 'the invite was accepted, as the notification would');
    assert.equal(await inCommunity(club, newbie.id), true);
    const pin = await pool.query('SELECT hidden FROM app_favorites WHERE app_id = $1 AND user_id = $2', [garden.id, newbie.id]);
    assert.equal(pin.rows[0]?.hidden, false, 'joining puts it on Home');
    const u = (await pool.query(
      'SELECT needs_communities_choice, communities_onboarded_at FROM users WHERE id = $1', [newbie.id])).rows[0];
    assert.equal(u.needs_communities_choice, false);
    assert.ok(u.communities_onboarded_at);
  });

  await t.test('Skip for now records the answer and joins or leaves nothing', async () => {
    viewer = { id: skipper.id, username: skipper.username, isAdmin: false };
    try {
      assert.equal(await inCommunity(homeroom, skipper.id), true);
      const res = await call('POST', '/api/me/communities', { skip: true });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.deepEqual([res.data.joined, res.data.left], [[], []]);
      assert.equal(await inCommunity(homeroom, skipper.id), true, 'a skip keeps Homeroom');
      const u = (await pool.query(
        'SELECT needs_communities_choice, communities_onboarded_at FROM users WHERE id = $1', [skipper.id])).rows[0];
      assert.equal(u.needs_communities_choice, false, 'the screen does not come back');
      assert.ok(u.communities_onboarded_at);
      assert.equal((await call('POST', '/api/me/communities', { skip: true })).status, 409);
    } finally {
      viewer = { id: newbie.id, username: newbie.username, isAdmin: false };
    }
  });

  await t.test('a second answer is refused, and so is a bad body', async () => {
    const again = await call('POST', '/api/me/communities', { join: ['pickup-soccer'] });
    assert.equal(again.status, 409);
    assert.equal(again.data.alreadyDone, true);
    assert.equal(await inCommunity(soccer, newbie.id), false);
    viewer = { id: oldHand.id, username: oldHand.username, isAdmin: false };
    const never = await call('POST', '/api/me/communities', { join: ['pickup-soccer'] });
    assert.equal(never.status, 409, 'an account that was never asked cannot answer');
    const bad = await call('POST', '/api/me/communities', { join: 'city-garden' });
    assert.equal(bad.status, 400);
    viewer = { id: newbie.id, username: newbie.username, isAdmin: false };
  });

  await t.test('the card is about the first community joined, and ticks off from what was done', async () => {
    let card = (await call('GET', '/api/me/getting-started')).data;
    assert.equal(card.show, true);
    assert.equal(card.community.slug, 'book-club', 'the first one joined on the screen, in its order');
    assert.deepEqual(card.steps.map((s) => s.id), ['say-hi', 'vote', 'explore']);
    assert.equal(card.steps[0].title, 'Say hi in Book club');
    assert.equal(card.steps[0].href, '#messages/app/book-club');
    assert.equal(card.steps[1].title, 'Look around the Workshop', 'nothing is waiting on a vote yet');
    assert.equal(card.steps[2].title, 'Open Book club and try it');
    assert.equal(card.done, 0);

    // Something waiting on a vote changes the second step's words.
    const { rows: s } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'promoted') RETURNING id`, [club.id, grace.id]);
    card = (await call('GET', '/api/me/getting-started')).data;
    assert.equal(card.steps[1].title, 'Vote on what needs you');
    assert.equal(card.steps[1].detail, '1 waiting in Book club');

    await pool.query(`INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, 'hi all')`, [club.id, newbie.id]);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [s[0].id, newbie.id]);
    await pool.query(`INSERT INTO app_activity (app_id, user_id, seconds_spent) VALUES ($1, $2, 30)`, [club.id, newbie.id]);
    card = (await call('GET', '/api/me/getting-started')).data;
    assert.deepEqual(card.steps.map((x) => x.done), [true, true, true]);
    assert.equal(card.done, 3);
  });

  await t.test('a visit the card asked for is recorded, and only while it shows', async () => {
    const onboarding = require('../src/services/onboarding');
    const seen = await call('POST', '/api/me/getting-started/seen', { step: 'workshop' });
    assert.equal(seen.status, 200);
    const u = (await pool.query('SELECT getting_started_seen FROM users WHERE id = $1', [newbie.id])).rows[0];
    assert.ok(u.getting_started_seen.workshop);
    assert.equal((await call('POST', '/api/me/getting-started/seen', { step: 'admin' })).status, 400);
    await onboarding.markSeen(pool, oldHand.id, 'discover');
    const other = (await pool.query('SELECT getting_started_seen FROM users WHERE id = $1', [oldHand.id])).rows[0];
    assert.equal(other.getting_started_seen, null, 'no card, nothing recorded');
  });

  await t.test('closing the card ends it for good', async () => {
    assert.equal((await call('POST', '/api/me/getting-started/close')).status, 200);
    assert.equal((await call('GET', '/api/me/getting-started')).data.show, false);
  });

  // An admin's "Reset first run" (Admin → Users → ⋯). Continues from the
  // newcomer above, who has answered, visited, closed the card and joined.
  await t.test('Reset first run brings the first run back and touches nothing the account owns', async () => {
    const onboarding = require('../src/services/onboarding');
    const membershipsBefore = (await pool.query(
      'SELECT community_id FROM community_members WHERE user_id = $1 ORDER BY community_id', [newbie.id])).rows;
    const pinsBefore = (await pool.query(
      'SELECT app_id FROM app_favorites WHERE user_id = $1 AND NOT hidden ORDER BY app_id', [newbie.id])).rows;

    assert.deepEqual(await onboarding.resetFirstRun(pool, newbie.id), { id: newbie.id, username: 'newbie' });
    const u = (await pool.query(
      `SELECT needs_communities_choice, communities_onboarded_at, getting_started_closed_at, getting_started_seen
         FROM users WHERE id = $1`, [newbie.id])).rows[0];
    assert.deepEqual(u, {
      needs_communities_choice: true, communities_onboarded_at: null,
      getting_started_closed_at: null, getting_started_seen: null,
    }, 'exactly a new account\'s first-run state');
    assert.deepEqual((await pool.query(
      'SELECT community_id FROM community_members WHERE user_id = $1 ORDER BY community_id', [newbie.id])).rows,
    membershipsBefore, 'still in everything it joined');
    assert.deepEqual((await pool.query(
      'SELECT app_id FROM app_favorites WHERE user_id = $1 AND NOT hidden ORDER BY app_id', [newbie.id])).rows,
    pinsBefore, 'its Home tiles stay');

    // The join screen shows what it is already in, ticked, and can be
    // answered again; the card comes back after it.
    const list = (await call('GET', '/api/me/join-suggestions')).data.communities;
    assert.equal(list.find((c) => c.slug === 'city-garden').checked, true);
    assert.equal((await call('GET', '/api/me/getting-started')).data.show, false, 'no card before the screen');
    const again = await call('POST', '/api/me/communities', { join: ['city-garden'] });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal((await call('GET', '/api/me/getting-started')).data.show, true);
    assert.equal(await onboarding.resetFirstRun(pool, 987654321), null, 'no such account');
  });
});
