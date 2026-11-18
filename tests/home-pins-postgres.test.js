'use strict';

// One Home (#6361, one-home-pins.sql, services/home-pins.js): pinning an app
// and joining its community are separate. Joining pins the COMMUNITY to Home,
// not its app; pinning an app joins nobody; a community can be pinned without
// joining; leaving unpins the community and keeps the app; the notification
// audiences (app_stakes) are members who keep it on Home either way; and the
// migration pins, for everyone, the communities their My apps already showed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');
const express = require('express');
const communities = require('../src/services/communities');
const { homePinRoutes } = require('../src/routes/home-pins');

test('home pins: join pins the community, so does making one, an app pin joins nobody, leave keeps the app (PostgreSQL)', async (t) => {
  const dsn = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const root = new Client({ connectionString: dsn, connectionTimeoutMillis: 2000 });
  try { await root.connect(); } catch (err) { await root.end().catch(() => {}); return t.skip(`Local test database unavailable: ${err.code}`); }
  const name = `home_pins_test_${process.pid}`;
  let pool;
  let server;
  try {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(dsn); url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    const addUser = async (username) => (await pool.query(
      "INSERT INTO users (username, password) VALUES ($1, 'unused') RETURNING id, username", [username])).rows[0];
    const alice = await addUser('alice');
    const bob = await addUser('bob');
    // Read back after the insert: the trigger that gives an app its
    // community runs after RETURNING has answered.
    const addApp = async (slug, visibility = 'public') => {
      await pool.query(
        `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility, icon_emoji)
         VALUES ($1, $1, $2, $3, $3, '🌊')`, [slug, bob.id, visibility]);
      return (await pool.query('SELECT * FROM apps WHERE slug = $1', [slug])).rows[0];
    };
    const tide = await addApp('tide');
    const chess = await addApp('chess');
    const garden = await addApp('garden');
    const secret = await addApp('secret', 'private');
    const member = async (app, user) => (await pool.query(
      'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2', [app.community_id, user.id])).rowCount === 1;
    const favorite = async (app, user) => (await pool.query(
      'SELECT 1 FROM app_favorites WHERE app_id = $1 AND user_id = $2', [app.id, user.id])).rowCount === 1;
    const stake = async (app, user) => (await pool.query(
      'SELECT 1 FROM app_stakes WHERE app_id = $1 AND user_id = $2', [app.id, user.id])).rowCount === 1;
    assert.ok(tide.community_id, 'every app has a community');

    // Joining pins the community, not the app.
    await communities.join(pool, tide, alice.id);
    assert.equal(await member(tide, alice), true);
    assert.equal(await favorite(tide, alice), false, 'the app is not pinned by joining');

    // Pinning an app joins nobody.
    await pool.query('INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2)', [chess.id, alice.id]);
    assert.equal(await member(chess, alice), false, 'an app pin is only a pin');

    const web = express();
    web.use(express.json());
    web.use((req, res, next) => { req.user = { alice, bob }[req.get('x-test-user')]; next(); });
    web.use(homePinRoutes({}, { pool }));
    server = web.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const call = async (method, url, user = 'alice', body) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        method, headers: { 'x-test-user': user, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${server.address().port}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.json() };
    };
    const slugs = (r) => r.body.pins.map((p) => p.slug);

    assert.equal((await call('GET', '/api/me/home-pins', '')).status, 401, 'signed out has no account list');
    let r = await call('GET', '/api/me/home-pins');
    assert.deepEqual(r.body.pins, [{ slug: 'tide', name: 'tide', iconUrl: null, iconEmoji: '🌊', iconColor: null, member: true }],
      'the joined community, as the grid draws it');

    // A community can be pinned without joining, and stays unjoined.
    r = await call('PUT', '/api/me/home-pins/garden');
    assert.equal(r.status, 200);
    assert.deepEqual(slugs(r), ['tide', 'garden']);
    assert.equal(r.body.pins[1].member, false);
    assert.equal(await member(garden, alice), false);
    assert.deepEqual(slugs(await call('PUT', '/api/me/home-pins/garden')), ['tide', 'garden'], 'pinning again changes nothing');
    assert.equal((await call('PUT', '/api/me/home-pins/secret')).status, 404, 'one you cannot see is not found');

    // A pin made while it was public says nothing once the project is
    // private to someone who is not in it, and comes back when it opens.
    await pool.query("UPDATE apps SET view_visibility = 'private', collab_visibility = 'private' WHERE id = $1", [garden.id]);
    assert.deepEqual(slugs(await call('GET', '/api/me/home-pins')), ['tide']);
    await pool.query("UPDATE apps SET view_visibility = 'public', collab_visibility = 'public' WHERE id = $1", [garden.id]);
    assert.deepEqual(slugs(await call('GET', '/api/me/home-pins')), ['tide', 'garden']);

    // Order is the person's.
    assert.deepEqual(slugs(await call('PUT', '/api/me/home-pins', 'alice', { slugs: ['garden', 'tide'] })), ['garden', 'tide']);

    // Device pins move in at sign-in; what is gone or hidden is skipped.
    r = await call('POST', '/api/me/home-pins/import', 'alice', { slugs: ['chess', 'secret', 'no-such-app', 'tide'] });
    assert.deepEqual(slugs(r), ['garden', 'tide', 'chess']);

    // The audience that hears about votes: members who keep it on Home, either way.
    assert.equal(await stake(tide, alice), true, 'a member with the community pinned');
    assert.equal(await stake(garden, alice), false, 'following a community before joining is not a stake');
    assert.equal(await stake(chess, alice), false, 'nor is pinning its app');
    await communities.join(pool, chess, alice.id);
    assert.equal(await stake(chess, alice), true, 'once joined, it is');

    // Leaving unpins the community and keeps the app.
    const left = await communities.leave(pool, chess, alice.id);
    assert.equal(left.ok, true);
    assert.equal(await member(chess, alice), false);
    assert.equal(await favorite(chess, alice), true, 'the app stays pinned');
    assert.deepEqual(slugs(await call('GET', '/api/me/home-pins')), ['garden', 'tide'], 'the community is unpinned');

    // Unpinning a community keeps the membership.
    assert.deepEqual(slugs(await call('DELETE', '/api/me/home-pins/tide')), ['garden']);
    assert.equal(await member(tide, alice), true);

    // The migration: a My apps app someone is in becomes a pinned community, in My apps' order.
    await pool.query('DELETE FROM home_community_pins');
    await pool.query('INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [chess.community_id, alice.id, 'joined']);
    await pool.query('INSERT INTO app_favorites (app_id, user_id, sort_order) VALUES ($1, $2, 0) ON CONFLICT (app_id, user_id) DO UPDATE SET sort_order = 0',
      [chess.id, alice.id]);
    await pool.query('INSERT INTO app_favorites (app_id, user_id, sort_order) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING',
      [tide.id, alice.id]);
    for (const app of [chess, tide, garden]) {
      await pool.query(
        "INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING",
        [app.id, bob.id]);
    }
    // A project's maker finds its community on Home: the creator's
    // membership row pins it, as a join does (community_members_pin_created).
    assert.deepEqual((await call('GET', '/api/me/home-pins', 'bob')).body.pins.map((p) => p.slug), ['chess', 'tide', 'garden'],
      'each community bob made, in the order he came to be in them');
    await pool.query('DELETE FROM home_community_pins WHERE user_id = $1', [bob.id]);
    await pool.query('INSERT INTO app_favorites (app_id, user_id, hidden) VALUES ($1, $2, TRUE)', [garden.id, bob.id]);
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/migrations/one-home-pins.sql'), 'utf8'));
    assert.deepEqual(slugs(await call('GET', '/api/me/home-pins')), ['chess', 'tide'], 'My apps\' communities, in its order');
    const bobs = (await call('GET', '/api/me/home-pins', 'bob')).body.pins.map((p) => p.slug).sort();
    assert.deepEqual(bobs, ['chess', 'tide'], 'the projects someone builds, less the one hidden from My apps');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  }
});

// Home's community cards (Drea's review of #6699, services/home-pins.js
// activity): for each pinned community, how many members, what went live
// this week, and who took part this week (people only, the most recent
// first, with their picture), never for a community the viewer cannot see.
test('home pins: each community you pinned or are in says its members, what went live and who was there this week (PostgreSQL)', async (t) => {
  const dsn = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const root = new Client({ connectionString: dsn, connectionTimeoutMillis: 2000 });
  try { await root.connect(); } catch (err) { await root.end().catch(() => {}); return t.skip(`Local test database unavailable: ${err.code}`); }
  const name = `home_pins_activity_${process.pid}`;
  let pool;
  let server;
  try {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(dsn); url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    const addUser = async (username, synthetic = false) => (await pool.query(
      'INSERT INTO users (username, password, is_synthetic) VALUES ($1, \'unused\', $2) RETURNING id, username', [username, synthetic])).rows[0];
    const alice = await addUser('alice');
    const bob = await addUser('bob');
    const carol = await addUser('carol');
    const dana = await addUser('dana');
    const bot = await addUser('activity_bot', true);
    const addApp = async (slug, visibility = 'public') => {
      await pool.query(
        `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility)
         VALUES ($1, $1, $2, $3, $3)`, [slug, bob.id, visibility]);
      return (await pool.query('SELECT * FROM apps WHERE slug = $1', [slug])).rows[0];
    };
    const tide = await addApp('tide');
    const garden = await addApp('garden');
    const secret = await addApp('secret', 'private');
    await communities.join(pool, tide, alice.id);
    await communities.join(pool, tide, carol.id);
    await pool.query('INSERT INTO home_community_pins (community_id, user_id, position) VALUES ($1, $2, 5), ($3, $2, 6)',
      [garden.community_id, alice.id, secret.community_id]);
    // The Communities page's Joined group: in it, not pinned. Joining pins a
    // community, so orchard is one alice unpinned; club is a private one she
    // is a member of and never pinned.
    const orchard = await addApp('orchard');
    await communities.join(pool, orchard, alice.id);
    await pool.query('DELETE FROM home_community_pins WHERE community_id = $1 AND user_id = $2', [orchard.community_id, alice.id]);
    const club = await addApp('club', 'private');
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)', [club.community_id, alice.id]);

    const say = (app, user, ago) => pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, created_at) VALUES ($1, $2, 'hi', NOW() - $3::interval)`,
      [app.id, user.id, ago]);
    await say(tide, bob, '3 days');
    await say(tide, carol, '1 hour');
    await say(tide, bot, '10 minutes'); // a bot is nobody active
    await say(tide, dana, '10 days'); // last week's is not this week's
    const session = async (app, user, extra = {}) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, merged_at, live_at, created_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW())) RETURNING id`,
      [app.id, user.id, extra.status || 'active', extra.mergedAt || null, extra.liveAt || null, extra.createdAt || null])).rows[0];
    const shipped = await session(tide, bob, { status: 'merged', mergedAt: new Date(Date.now() - 2 * 864e5), liveAt: new Date() });
    await session(tide, bob, { status: 'merged', mergedAt: new Date(Date.now() - 20 * 864e5), liveAt: new Date(Date.now() - 20 * 864e5), createdAt: new Date(Date.now() - 21 * 864e5) });
    await pool.query('INSERT INTO pr_votes (session_id, user_id, vote, created_at) VALUES ($1, $2, \'yes\', NOW() - INTERVAL \'2 hours\')',
      [shipped.id, dana.id]);
    await session(garden, carol);
    await pool.query(
      `INSERT INTO user_avatars (id, user_id, content_type, size_bytes, data, sha256)
       VALUES ('carolpic', $1, 'image/png', 1, '\\x00', 'x')`, [carol.id]);

    const web = express();
    web.use((req, res, next) => { req.user = { alice }[req.get('x-test-user')]; next(); });
    web.use(homePinRoutes({}, { pool }));
    server = web.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const get = async (user = 'alice') => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/me/home-pins/activity`, { headers: { 'x-test-user': user } });
      return { status: res.status, body: await res.json() };
    };
    assert.equal((await get('')).status, 401, 'signed out has none');
    const { activity } = (await get()).body;
    assert.deepEqual(Object.keys(activity).sort(), ['club', 'garden', 'orchard', 'tide'],
      'the pins the page draws and the others she is in; not the private one she only pinned');
    // tide: alice and carol joined it. Bob's change, just now, is the
    // latest; then carol's message, an hour ago; then dana's vote. One change
    // went live this week, the other three weeks ago.
    assert.deepEqual(activity.tide, {
      members: 2,
      liveWeek: 1,
      activeWeek: 3,
      people: [
        { username: 'bob', avatarUrl: null },
        { username: 'carol', avatarUrl: '/avatars/carolpic' },
        { username: 'dana', avatarUrl: null },
      ],
    });
    assert.deepEqual(activity.garden, {
      members: 0, liveWeek: 0, activeWeek: 1, people: [{ username: 'carol', avatarUrl: '/avatars/carolpic' }],
    });
    // A joined one says the same things; a quiet one says only who is in it.
    assert.deepEqual(activity.orchard, { members: 1, liveWeek: 0, activeWeek: 0, people: [] });
    assert.deepEqual(activity.club, { members: 1, liveWeek: 0, activeWeek: 0, people: [] });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  }
});
