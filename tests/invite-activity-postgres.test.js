'use strict';

// WP-E against the full schema (src/services/invite-activity.js): what an
// invite link brings back to its maker. Opens are counted once per person
// and never named, a join and a first hello name the person who came by the
// link, each kind rings once a day per project and folds the rest into a
// count, and none of it reaches anybody but the link's maker. Only a
// signed-in open is news (#4176): one signed out is remembered and recorded
// for the admin Journey, and tells nobody. An open is news only until that
// person joins: the join replaces it.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/invite-activity-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const activity = require('../src/services/invite-activity');

test('invite activity against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `invite_activity_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6, connectionTimeoutMillis: 10000 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

  async function user(username) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
      [username]);
    return u;
  }
  const maya = await user('maya');
  const sam = await user('sam');
  const alex = await user('alex');
  const lee = await user('lee');
  const old = await user('old_member');

  let n = 0;
  async function project() {
    n += 1;
    const { rows: [community] } = await pool.query('INSERT INTO communities DEFAULT VALUES RETURNING id');
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, community_id) VALUES ($1, $2, 'running', $3, $4)
       RETURNING id, community_id, name, slug`,
      [`Run Club ${n}`, `run-club-${n}`, maya.id, community.id]);
    await pool.query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [app.community_id, maya.id]);
    const token = crypto.randomBytes(16).toString('base64url').slice(0, 22);
    const { rows: [invite] } = await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days') RETURNING id, token`,
      [token, app.community_id, app.id, maya.id]);
    return { app, invite };
  }
  async function joinBy(invite, app, who) {
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, applied_at) VALUES ($1, $2, 'joined', NOW())`,
      [invite.id, who.id]);
    await pool.query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [app.community_id, who.id]);
  }
  async function say(app, who, content = 'hi all') {
    const { rows: [m] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, $3) RETURNING id`,
      [app.id, who.id, content]);
    return m.id;
  }
  const rowsOf = async (userId, kind) => (await pool.query(
    `SELECT id, app_id, source_user_id, chat_message_id, detail, read_at FROM notifications
      WHERE user_id = $1 AND kind = $2 ORDER BY id`, [userId, kind])).rows;

  await t.test('schema: the two push categories and their kinds', async () => {
    const { rows } = await pool.query(
      `SELECT kind, category, default_enabled FROM mobile_push_kind_categories
        WHERE category IN ('builds', 'invite_activity') ORDER BY kind`);
    assert.deepEqual(rows.map((r) => `${r.kind}:${r.category}:${r.default_enabled}`), [
      'build_live:builds:true', 'build_needs_you:builds:true', 'build_ready:builds:true', 'build_stopped:builds:true',
      'first_message:invite_activity:true', 'invite_link_busy:invite_activity:true',
      'invite_link_paused:invite_activity:true', 'invite_opened:invite_activity:true',
      'member_joined:invite_activity:true',
    ]);
    // A person may switch either off.
    await pool.query(`INSERT INTO mobile_push_preferences (user_id, category, enabled) VALUES ($1, 'builds', FALSE), ($1, 'invite_activity', FALSE)`, [alex.id]);
    const { rows: cols } = await pool.query(
      `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'activity_email'`);
    assert.equal(cols[0].is_nullable, 'NO');
    assert.match(cols[0].column_default, /true/);
  });

  await t.test('a join names who came by the link, to its maker only, and the day folds into one row', async () => {
    const { app, invite } = await project();
    await joinBy(invite, app, sam);
    const first = await activity.noteJoined(pool, { inviteId: invite.id, user: { id: sam.id } });
    assert.equal(first.fresh, true);
    await joinBy(invite, app, alex);
    const second = await activity.noteJoined(pool, { inviteId: invite.id, user: { id: alex.id } });
    assert.equal(second.fresh, false, 'folded, not a second ring');
    const rows = (await rowsOf(maya.id, 'member_joined')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, '2');
    assert.equal(rows[0].source_user_id, alex.id, 'the newest person leads');
    assert.equal((await rowsOf(sam.id, 'member_joined')).length, 0);
    // The maker following their own link is not news.
    assert.equal(await activity.noteJoined(pool, { inviteId: invite.id, user: { id: maya.id } }), null);
  });

  // A browser, as the route hands it over: the hash of its cookie.
  const browser = (name) => crypto.createHash('sha256').update(`test-browser:${name}`).digest('hex');
  const opensOf = async (app) => (await pool.query(
    `SELECT user_id, browser, notification_id, referrer_host, via FROM community_invite_opens WHERE app_id = $1 ORDER BY id`, [app.id])).rows;
  const openEvents = async (invite) => (await pool.query(
    `SELECT user_id, app_id, metadata FROM events
      WHERE event_type = 'invite_opened' AND (metadata->>'inviteId')::int = $1`, [invite.id])).rows;
  const waitForEvents = async (invite, n) => {
    for (let i = 0; i < 40 && (await openEvents(invite)).length < n; i += 1) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    return openEvents(invite);
  };

  await t.test('an open signed out tells nobody, but is one open for the Journey, once per browser (#4176)', async () => {
    const { app, invite } = await project();
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM mobile_push_deliveries')).rows[0].n;
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, browser: browser('clicked-a') }),
        { row: null, fresh: false }, 'only clicked the link: the maker hears nothing');
    }
    assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, browser: browser('clicked-b') }),
      { row: null, fresh: false });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0, 'no notice');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM mobile_push_deliveries')).rows[0].n, before, 'no push');
    assert.deepEqual((await opensOf(app)).map((r) => [r.user_id, r.notification_id]), [[null, null], [null, null]],
      'each browser remembered, on no notice');
    const recorded = await waitForEvents(invite, 2);
    assert.deepEqual(recorded.map((r) => [r.user_id, r.app_id, r.metadata.signedIn]), Array(2).fill([null, app.id, false]),
      'two browsers, two opens, with no name on either');
  });

  await t.test('an open keeps where it came from, and a merge keeps the first open\'s source (#6540)', async () => {
    const { app, invite } = await project();
    // One browser opened it signed out from Discord, the link tagged copied.
    await activity.noteOpened(pool, {
      token: invite.token, browser: browser('came-from'),
      source: { referrerHost: 'discord.com', via: 'copied' },
    });
    const [row] = await opensOf(app);
    assert.equal(row.referrer_host, 'discord.com');
    assert.equal(row.via, 'copied');
    const recorded = await waitForEvents(invite, 1);
    assert.equal(recorded[0].metadata.referrerHost, 'discord.com');
    assert.equal(recorded[0].metadata.via, 'copied');
    // Opening it signed in is the same person: one row, and the first open's
    // source stays.
    await activity.noteOpened(pool, {
      token: invite.token, viewerId: sam.id, browser: browser('came-from'),
      source: { referrerHost: 't.co', via: 'shared' },
    });
    const rows = await opensOf(app);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, sam.id);
    assert.equal(rows[0].referrer_host, 'discord.com');
    assert.equal(rows[0].via, 'copied');
  });

  await t.test('three people signed in on the first day ring once, and the push waits for a join', async () => {
    const { app, invite } = await project();
    await pool.query(
      `INSERT INTO mobile_push_deployment_state (environment, firebase_project_id, send_enabled, send_not_before)
       VALUES ('production', 'social-prod', TRUE, NOW() - INTERVAL '1 hour')
       ON CONFLICT (environment) DO UPDATE SET send_enabled = TRUE, send_not_before = EXCLUDED.send_not_before`);
    // A phone needs a native session behind it; that chain is not what this
    // checks, so the scratch database drops the link to it.
    await pool.query('ALTER TABLE mobile_push_registrations DROP CONSTRAINT IF EXISTS mobile_push_registrations_native_credential_user_fk');
    await pool.query(
      `INSERT INTO mobile_push_registrations
         (user_id, native_session_credential_reference, environment, installation_id,
          registration_hash, registration_enc, platform, permission_status, session_expires_at)
       VALUES ($1, $2, 'production', $3, $4, 'enc:opaque', 'ios', 'authorized', NOW() + INTERVAL '30 days')`,
      [maya.id, `nsc_${String(maya.id).padStart(43, '0')}`, crypto.randomUUID(), crypto.randomBytes(32).toString('hex')]);
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM mobile_push_deliveries')).rows[0].n;
    const first = await activity.noteOpened(pool, { token: invite.token, viewerId: sam.id, browser: browser('ring-a') });
    assert.equal(first.fresh, true);
    assert.equal((await activity.noteOpened(pool, { token: invite.token, viewerId: alex.id, browser: browser('ring-b') })).fresh, false);
    assert.equal((await activity.noteOpened(pool, { token: invite.token, viewerId: lee.id, browser: browser('ring-c') })).fresh, false);
    const rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, '3', 'three people');
    assert.equal(rows[0].source_user_id, null, 'an open is never a name');
    const deliveries = (await pool.query(
      `SELECT available_at > NOW() + INTERVAL '14 minutes' AS waits, status
         FROM mobile_push_deliveries WHERE notification_id = $1`, [rows[0].id])).rows;
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM mobile_push_deliveries')).rows[0].n;
    assert.equal(after - before, 1, 'one push for three opens');
    assert.deepEqual(deliveries, [{ waits: true, status: 'pending' }],
      `the open's push waits ${activity.OPEN_PUSH_DELAY_MINUTES} minutes, for a join to replace it`);
    // Each person's open is also an event for the admin Journey's first
    // session, with the account on it.
    const recorded = await waitForEvents(invite, 3);
    assert.deepEqual(recorded.map((r) => [r.user_id, r.app_id, r.metadata.signedIn]).sort(),
      [[sam.id, app.id, true], [alex.id, app.id, true], [lee.id, app.id, true]].sort());
  });

  await t.test('one person opening a link four times is one open: no count, no unread, no ring', async () => {
    const { app, invite } = await project();
    const first = await activity.noteOpened(pool, { token: invite.token, viewerId: sam.id, browser: browser('one-person') });
    assert.equal(first.fresh, true);
    await pool.query('UPDATE notifications SET read_at = NOW() WHERE id = $1', [first.row.id]);
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, viewerId: sam.id, browser: browser('one-person') }),
        { row: null, fresh: false }, 'the same person again');
    }
    const rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, null, '"Someone opened your invite", not "4 people"');
    assert.ok(rows[0].read_at, 'and it stays read');
    assert.equal((await opensOf(app)).length, 1);
    assert.equal((await waitForEvents(invite, 1)).length, 1, 'one event, as one person');

    // Signed in, they are their account on every device and browser: the
    // phone, then the laptop, then the phone signed out, then signed in.
    const signed = await project();
    await activity.noteOpened(pool, { token: signed.invite.token, viewerId: sam.id, browser: browser('sam-phone') });
    assert.deepEqual(await activity.noteOpened(pool, { token: signed.invite.token, viewerId: sam.id, browser: browser('sam-laptop') }),
      { row: null, fresh: false }, 'another device, same account');
    assert.deepEqual(await activity.noteOpened(pool, { token: signed.invite.token, browser: browser('sam-phone') }),
      { row: null, fresh: false }, 'the same phone, signed out');
    const signedRows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === signed.app.id);
    assert.equal(signedRows.length, 1);
    assert.equal(signedRows[0].detail, null);
    assert.deepEqual((await opensOf(signed.app)).map((r) => [r.user_id, r.browser]), [[sam.id, browser('sam-phone')]]);
  });

  await t.test('two people are two, and a second link of the same maker\'s does not count them again', async () => {
    const { app, invite } = await project();
    await activity.noteOpened(pool, { token: invite.token, viewerId: sam.id, browser: browser('two-sam') });
    await activity.noteOpened(pool, { token: invite.token, viewerId: alex.id, browser: browser('two-alex') });
    await activity.noteOpened(pool, { token: invite.token, browser: browser('two-stranger') });
    const rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, '2', '"2 people opened your invite": the stranger only clicked it');
    // Maya made a second link to the same project: Sam opening it is not a third.
    const token = crypto.randomBytes(16).toString('base64url').slice(0, 22);
    await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')`,
      [token, app.community_id, app.id, maya.id]);
    assert.deepEqual(await activity.noteOpened(pool, { token, viewerId: sam.id, browser: browser('two-sam-2') }),
      { row: null, fresh: false });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id)[0].detail, '2');
  });

  await t.test('a browser opened signed out is news once it opens the link signed in, and is one person', async () => {
    const { app, invite } = await project();
    await activity.noteOpened(pool, { token: invite.token, browser: browser('later-v1') });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0);
    // Alex signs in on that browser and opens the link again, not in it yet:
    // now the maker hears.
    const told = await activity.noteOpened(pool, { token: invite.token, viewerId: alex.id, browser: browser('later-v1') });
    assert.equal(told.fresh, true);
    assert.equal(told.row.kind, 'invite_opened');
    const rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, null, 'one person');
    assert.deepEqual((await opensOf(app)).map((r) => [r.user_id, r.browser, r.notification_id]),
      [[alex.id, browser('later-v1'), rows[0].id]], 'the browser was Alex all along');
    // Counted once for the Journey: the open signed out was the person's open.
    assert.deepEqual((await waitForEvents(invite, 1)).map((r) => [r.user_id, r.metadata.signedIn]), [[null, false]]);
    // And quiet from then on, on any device.
    assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, viewerId: alex.id, browser: browser('later-v2') }),
      { row: null, fresh: false });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id)[0].detail, null);
  });

  await t.test('a browser opened signed out and then signed in, and a person seen on two rows, are one', async () => {
    const { app, invite } = await project();
    await activity.noteOpened(pool, { token: invite.token, browser: browser('merge-v1') });
    await activity.noteOpened(pool, { token: invite.token, viewerId: alex.id, browser: browser('merge-v2') });
    assert.equal((await opensOf(app)).length, 2, 'until they sign in there, two browsers are two opens');
    // Alex signs in on the first browser: that browser was Alex all along.
    assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, viewerId: alex.id, browser: browser('merge-v1') }),
      { row: null, fresh: false });
    const rows = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, null, 'one person after all');
    assert.equal((await opensOf(app)).length, 1);
  });

  await t.test('signed up from a link opened signed out and joined: the maker only hears the join', async () => {
    const { app, invite } = await project();
    await activity.noteOpened(pool, { token: invite.token, browser: browser('join-sam') });
    await joinBy(invite, app, sam);
    const joined = await activity.noteJoined(pool, { inviteId: invite.id, user: { id: sam.id }, browser: browser('join-sam') });
    assert.equal(joined.fresh, true);
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0,
      'never "Someone opened your invite"');
    assert.equal((await rowsOf(maya.id, 'member_joined')).filter((r) => r.app_id === app.id).length, 1,
      '"Joined through your invite" says it');
    // They are remembered, with their account: opening the link again
    // signed out in that browser is not news.
    assert.deepEqual((await opensOf(app)).map((r) => [r.user_id, r.notification_id]), [[sam.id, null]]);
    assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, browser: browser('join-sam') }),
      { row: null, fresh: false });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0);
  });

  await t.test('a join replaces the open: off the notice, which goes when nobody is left, its waiting push with it', async () => {
    const { app, invite } = await project();
    // Opened signed in, then joined.
    const opened = await activity.noteOpened(pool, { token: invite.token, viewerId: sam.id, browser: browser('replace-sam') });
    const notice = opened.row.id;
    await pool.query(
      `INSERT INTO mobile_push_deliveries (notification_id, environment, installation_id, available_at)
       VALUES ($1, 'production', $2, NOW() + INTERVAL '15 minutes') ON CONFLICT DO NOTHING`,
      [notice, crypto.randomUUID()]);
    await joinBy(invite, app, sam);
    const joined = await activity.noteJoined(pool, { inviteId: invite.id, user: { id: sam.id }, browser: browser('replace-sam') });
    assert.equal(joined.fresh, true);
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0,
      'the open is gone: "Joined through your invite" says it');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM mobile_push_deliveries WHERE notification_id = $1', [notice])).rows[0].n, 0,
      'and its push never goes');
    assert.equal((await rowsOf(maya.id, 'member_joined')).filter((r) => r.app_id === app.id).length, 1);
    assert.deepEqual((await opensOf(app)).map((r) => [r.user_id, r.notification_id]), [[sam.id, null]]);

    // Two opened; one joins: the other is still somebody who opened.
    const both = await project();
    await activity.noteOpened(pool, { token: both.invite.token, viewerId: alex.id, browser: browser('join-alex') });
    await activity.noteOpened(pool, { token: both.invite.token, viewerId: lee.id, browser: browser('join-other') });
    await joinBy(both.invite, both.app, alex);
    await activity.noteJoined(pool, { inviteId: both.invite.id, user: { id: alex.id } });
    const left = (await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === both.app.id);
    assert.equal(left.length, 1);
    assert.equal(left[0].detail, null, '"Someone opened your invite": the one who has not joined');
  });

  await t.test('a browser counted before opens were kept by person is remembered, not counted again', async () => {
    const { app, invite } = await project();
    assert.deepEqual(
      await activity.noteOpened(pool, { token: invite.token, browser: browser('legacy'), seenBefore: true }),
      { row: null, fresh: false });
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0);
    assert.deepEqual(await activity.noteOpened(pool, { token: invite.token, browser: browser('legacy') }),
      { row: null, fresh: false }, 'and stays quiet once the old cookie has gone');
    assert.equal(await activity.noteOpened(pool, { token: invite.token }), null,
      'nothing to know a person by, so nothing to count once');
  });

  await t.test('an open by the maker, a member or a dead link counts nothing', async () => {
    const { app, invite } = await project();
    await joinBy(invite, app, old);
    assert.equal(await activity.noteOpened(pool, { token: invite.token, viewerId: maya.id, browser: browser('maker') }), null);
    assert.equal(await activity.noteOpened(pool, { token: invite.token, viewerId: old.id, browser: browser('member') }), null);
    await pool.query('UPDATE community_invites SET revoked_at = NOW() WHERE id = $1', [invite.id]);
    assert.equal(await activity.noteOpened(pool, { token: invite.token, browser: browser('dead') }), null);
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS n FROM events WHERE event_type = 'invite_opened' AND (metadata->>'inviteId')::int = $1`,
      [invite.id])).rows[0].n, 0, 'and records no open');
  });

  await t.test('a first message from somebody the link brought is a hello; the second is not', async () => {
    const { app, invite } = await project();
    await joinBy(invite, app, sam);
    const hi = await say(app, sam, 'hello from sam');
    const first = await activity.noteFirstMessage(pool, { appId: app.id, userId: sam.id, chatMessageId: hi });
    assert.equal(first.fresh, true);
    const again = await say(app, sam, 'and again');
    assert.equal(await activity.noteFirstMessage(pool, { appId: app.id, userId: sam.id, chatMessageId: again }), null);
    const rows = (await rowsOf(maya.id, 'first_message')).filter((r) => r.app_id === app.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chat_message_id, hi);
    assert.equal(rows[0].source_user_id, sam.id);
  });

  await t.test('no hello from somebody who did not come by a link, or long after joining', async () => {
    const { app, invite } = await project();
    // In the community, but not by this link.
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, alex.id]);
    const m1 = await say(app, alex);
    assert.equal(await activity.noteFirstMessage(pool, { appId: app.id, userId: alex.id, chatMessageId: m1 }), null);
    // By the link, but two months ago.
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, applied_at, created_at)
       VALUES ($1, $2, 'joined', NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days')`,
      [invite.id, old.id]);
    const m2 = await say(app, old);
    assert.equal(await activity.noteFirstMessage(pool, { appId: app.id, userId: old.id, chatMessageId: m2 }), null);
    assert.equal((await rowsOf(maya.id, 'first_message')).filter((r) => r.app_id === app.id).length, 0);
  });

  // The email a day's first join or hello owes is written with the notice
  // that rang (mailed_at NULL) and sent by the notice-mail clock, once:
  // sent after the commit before, a restart in between lost it for good.
  await t.test('a day\'s first join or hello owes its email with its notice; the clock sends each once and marks it', async () => {
    const activityMail = require('../src/services/activity-mail');
    const real = activityMail.emailIfNoPush;
    const sent = [];
    activityMail.emailIfNoPush = async (_pool, args) => { sent.push(args); return 'sent'; };
    try {
      await pool.query(`UPDATE notifications SET mailed_at = NOW() WHERE mailed_at IS NULL`);
      const { app, invite } = await project();
      await joinBy(invite, app, lee);
      await activity.noteJoined(pool, { inviteId: invite.id, user: { id: lee.id } });
      await joinBy(invite, app, old);
      await activity.noteJoined(pool, { inviteId: invite.id, user: { id: old.id } });
      const hi = await say(app, lee, 'hello from lee');
      await activity.noteFirstMessage(pool, { appId: app.id, userId: lee.id, chatMessageId: hi });
      await activity.noteOpened(pool, { token: invite.token, viewerId: alex.id, browser: browser('mail') });
      const owed = await activityMail.noticeMailTargets(pool);
      const [joined] = (await rowsOf(maya.id, 'member_joined')).filter((r) => r.app_id === app.id);
      const [hello] = (await rowsOf(maya.id, 'first_message')).filter((r) => r.app_id === app.id);
      assert.deepEqual(owed.items.map((i) => i.target), [`notification:${joined.id}`, `notification:${hello.id}`],
        'the day\'s first of each, never the fold or an open');
      const steps = () => { const kept = new Map(); return { once: async (k, fn) => (kept.has(k) ? kept.get(k) : kept.set(k, await fn()).get(k)) }; };
      for (const item of owed.items) assert.deepEqual(await activityMail.mailNotice(pool, item.input.notificationId, steps()), { said: 'sent' });
      assert.deepEqual(sent.map((m) => [m.userId, m.kind, m.appSlug, m.line]), [
        [maya.id, 'invite_activity', app.slug, `@old_member joined ${app.name} through your invite.`],
        [maya.id, 'invite_activity', app.slug, `@lee said hi in ${app.name}.`],
      ]);
      assert.deepEqual((await activityMail.noticeMailTargets(pool)).items, [], 'marked once handled');
      assert.deepEqual(await activityMail.mailNotice(pool, joined.id, steps()), { said: 'settled' }, 'a second item sends nothing');
      // Past a day it is not news any more.
      const { app: later, invite: laterInvite } = await project();
      await joinBy(laterInvite, later, sam);
      await activity.noteJoined(pool, { inviteId: laterInvite.id, user: { id: sam.id } });
      await pool.query(`UPDATE notifications SET created_at = NOW() - INTERVAL '25 hours' WHERE app_id = $1`, [later.id]);
      assert.deepEqual((await activityMail.noticeMailTargets(pool)).items, []);
      assert.equal(sent.length, 2);
    } finally {
      activityMail.emailIfNoPush = real;
    }
  });

  await t.test('a row from yesterday is not folded into: today rings again', async () => {
    const { app, invite } = await project();
    await activity.noteOpened(pool, { token: invite.token, viewerId: sam.id, browser: browser('yesterday') });
    await pool.query(
      `UPDATE notifications SET created_at = NOW() - INTERVAL '25 hours' WHERE user_id = $1 AND app_id = $2 AND kind = 'invite_opened'`,
      [maya.id, app.id]);
    const today = await activity.noteOpened(pool, { token: invite.token, viewerId: alex.id, browser: browser('today') });
    assert.equal(today.fresh, true);
    assert.equal((await rowsOf(maya.id, 'invite_opened')).filter((r) => r.app_id === app.id).length, 2);
  });
});
