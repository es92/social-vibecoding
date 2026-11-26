'use strict';

// Communities (src/services/communities.js and the "Communities" block at the
// end of src/db/schema.sql) against the REAL schema in a throwaway PostgreSQL
// database: tracked migrations applied on startup and verified on reboot, then
// the triggers, the one-time backfill and the service's join/leave/gate.
// Skipped when no server is reachable, and required when TEST_DATABASE_URL is
// set — the same contract as tests/user-merge-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { settleWorkStates } = require('./lib/work-states');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const communities = require('../src/services/communities');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('communities against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'communities_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const baseline = fs.readFileSync(require.resolve('../src/db/migrations/0001-baseline.sql'), 'utf8');
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

  let seq = 0;
  async function user({ platform = true, isAdmin = false } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_admin)
       VALUES ($1, 'x', $2, $3) RETURNING id, username, is_admin`,
      [`member_${n}`, platform, isAdmin]
    );
    return rows[0];
  }
  async function app({ createdBy = null, selfHosted = false, view = 'public', collab = 'public' } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, view_visibility, collab_visibility)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [`App ${n}`, `app-${n}`, createdBy, selfHosted, view, collab]
    );
    const { rows: full } = await pool.query('SELECT * FROM apps WHERE id = $1', [rows[0].id]);
    return full[0];
  }
  const members = async (appId) => (await pool.query(
    `SELECT m.user_id, m.source FROM community_members m JOIN apps a ON a.community_id = m.community_id
      WHERE a.id = $1 ORDER BY m.user_id`, [appId])).rows;
  const collaborate = (appId, userId, status = 'member') => pool.query(
    `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, $3)
     ON CONFLICT (app_id, user_id) DO UPDATE SET status = EXCLUDED.status`, [appId, userId, status]);

  await t.test('every app gets its own community on insert', async () => {
    const a = await app();
    const b = await app();
    assert.ok(a.community_id, 'the insert trigger set community_id');
    assert.notEqual(a.community_id, b.community_id, 'one community per app');
  });

  await t.test('an upsert that updates does not mint an orphan community', async () => {
    const before = Number((await pool.query('SELECT COUNT(*) AS n FROM communities')).rows[0].n);
    await pool.query(
      `INSERT INTO apps (name, slug) VALUES ('Again', 'app-1')
       ON CONFLICT (slug) DO UPDATE SET name = apps.name`
    );
    const after = Number((await pool.query('SELECT COUNT(*) AS n FROM communities')).rows[0].n);
    assert.equal(after, before, 'AFTER INSERT fires only for a row really inserted');
  });

  await t.test('collaborators join, and leave with their collaborator row', async () => {
    const owner = await user();
    const guest = await user();
    const a = await app({ createdBy: owner.id, view: 'private', collab: 'private' });
    await collaborate(a.id, owner.id);
    await collaborate(a.id, guest.id, 'invited');
    assert.deepEqual(await members(a.id), [{ user_id: owner.id, source: 'creator' }],
      'a pending invite is not membership');
    await pool.query(`UPDATE app_collaborators SET status = 'member' WHERE app_id = $1 AND user_id = $2`, [a.id, guest.id]);
    assert.deepEqual((await members(a.id)).map((m) => m.source), ['creator', 'collaborator']);
    await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [a.id, guest.id]);
    assert.deepEqual((await members(a.id)).map((m) => m.user_id), [owner.id]);
  });

  await t.test('One Home (#6361): pinning an app joins nobody', async () => {
    const fan = await user();
    const a = await app();
    await pool.query('INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2)', [a.id, fan.id]);
    assert.deepEqual(await members(a.id), [], 'an app pin is only a pin');
    await communities.join(pool, a, fan.id);
    assert.equal((await members(a.id)).length, 1);
    await pool.query('DELETE FROM app_favorites WHERE app_id = $1 AND user_id = $2', [a.id, fan.id]);
    assert.equal((await members(a.id)).length, 1, 'unpinning is not leaving');
  });

  await t.test('the platform project takes in everyone with platform access', async () => {
    const early = await user();
    const self = await app({ selfHosted: true });
    assert.ok((await members(self.id)).some((m) => m.user_id === early.id && m.source === 'auto'),
      'accounts that existed when the platform row was seeded');
    const late = await user({ platform: false });
    assert.ok(!(await members(self.id)).some((m) => m.user_id === late.id));
    await pool.query('UPDATE users SET has_platform_access = TRUE WHERE id = $1', [late.id]);
    assert.ok((await members(self.id)).some((m) => m.user_id === late.id), 'joined on the false → true edge');
    await communities.leave(pool, self, late.id);
    await pool.query('UPDATE users SET has_platform_access = TRUE WHERE id = $1', [late.id]);
    assert.ok(!(await members(self.id)).some((m) => m.user_id === late.id),
      'a redundant re-grant does not put back someone who left');
  });

  await t.test('join, leave and audience through the service', async () => {
    const owner = await user();
    const joiner = await user();
    const a = await app({ createdBy: owner.id });
    await collaborate(a.id, owner.id);
    let m = await communities.getMembership(pool, a, joiner.id);
    assert.equal(m.is_member, false);
    assert.equal(m.audience, 'open');
    assert.equal(m.audience_label, 'Public community');
    await communities.join(pool, a, joiner.id);
    m = await communities.getMembership(pool, a, joiner.id);
    assert.equal(m.is_member, true);
    assert.equal(m.member_count, 2);
    const pin = await pool.query('SELECT 1 FROM app_favorites WHERE app_id = $1 AND user_id = $2', [a.id, joiner.id]);
    assert.equal(pin.rows.length, 0, 'joining does not pin the app (One Home, #6361)');
    const homePin = await pool.query('SELECT 1 FROM home_community_pins WHERE community_id = $1 AND user_id = $2', [a.community_id, joiner.id]);
    assert.equal(homePin.rows.length, 1, 'it pins the community');
    assert.deepEqual(await communities.leave(pool, a, owner.id), {
      ok: false, status: 409, error: 'You started this project, so you can’t leave it.',
    });
    assert.deepEqual(await communities.leave(pool, a, joiner.id), { ok: true });
    assert.equal(await communities.isMember(pool, a.id, joiner.id), false);
    assert.equal((await pool.query('SELECT 1 FROM home_community_pins WHERE community_id = $1 AND user_id = $2', [a.community_id, joiner.id])).rows.length, 0,
      'leaving unpins the community');

    const solo = await app({ createdBy: owner.id, view: 'private', collab: 'private' });
    await collaborate(solo.id, owner.id);
    assert.equal((await communities.getMembership(pool, solo, owner.id)).audience, 'solo');
    await collaborate(solo.id, joiner.id, 'invited');
    assert.equal((await communities.getMembership(pool, solo, owner.id)).audience, 'invited',
      'an invite makes it a group before it is accepted');
  });

  await t.test('the gate refuses a non-member with join_required, and only them', async () => {
    const owner = await user();
    const outsider = await user();
    const adminUser = await user({ isAdmin: true });
    const a = await app({ createdBy: owner.id });
    await collaborate(a.id, owner.id);
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'promoted') RETURNING id`,
      [a.id, owner.id]
    );
    const guard = communities.requireSessionMembership(pool);
    const run = (u) => new Promise((resolve) => {
      const res = {
        status(code) { this.code = code; return this; },
        json(body) { resolve({ code: this.code, body }); },
      };
      guard({ params: { id: String(rows[0].id) }, user: u && { id: u.id, isAdmin: !!u.is_admin } }, res,
        () => resolve({ next: true }));
    });
    assert.deepEqual(await run(owner), { next: true });
    assert.deepEqual(await run(adminUser), { next: true }, 'admins pass, as they pass every access check');
    const refused = await run(outsider);
    assert.equal(refused.code, 403);
    assert.equal(refused.body.code, 'join_required');
    assert.equal(refused.body.app.slug, a.slug);
    await communities.join(pool, a, outsider.id);
    assert.deepEqual(await run(outsider), { next: true });

    const hidden = await app({ createdBy: owner.id, view: 'private', collab: 'private' });
    const { rows: priv } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'promoted') RETURNING id`,
      [hidden.id, owner.id]
    );
    const outcome = await new Promise((resolve) => {
      guard({ params: { id: String(priv[0].id) }, user: { id: outsider.id } },
        { status() { return this; }, json(body) { resolve(body); } }, () => resolve('next'));
    });
    assert.equal(outcome, 'next', 'a private app is the collab guard\'s to refuse, without naming it');
  });

  await t.test('the routes: community card, Join and Leave, and the /api/apps fields', async () => {
    const express = require('express');
    const { getPool } = require('../src/db/pool');
    const { appRoutes } = require('../src/routes/apps');
    const owner = await user();
    const viewer = await user();
    const a = await app({ createdBy: owner.id });
    await collaborate(a.id, owner.id);
    const config = { databaseUrl: String(url), selfAppSlug: 'no-such-self-app', selfAppPublicVoting: true };
    const server = express();
    server.use(express.json());
    let as = viewer;
    server.use((req, _res, next) => { req.user = { id: as.id, username: as.username, isAdmin: false }; next(); });
    server.use(appRoutes(config));
    const listener = await new Promise((resolve) => {
      const l = server.listen(0, '127.0.0.1', () => resolve(l));
    });
    // Closed at the end of THIS subtest, not in an after hook: the outer
    // test's hook drops the database, and it would run first and find the
    // router's pool still connected.
    const done = async () => {
      listener.close();
      await getPool(config).end().catch(() => {});
    };
    try {
      const base = `http://127.0.0.1:${listener.address().port}`;
      const call = async (method, p, body) => {
        const res = await fetch(base + p, {
          method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
      };

      let got = await call('GET', `/api/apps/${a.slug}/community`);
      assert.equal(got.status, 200);
      assert.equal(got.body.is_member, false);
      assert.equal(got.body.audience_label, 'Public community');
      assert.deepEqual(got.body.members.map((m) => m.username), [owner.username]);
      // #4666: the rule by name too (an app on the two columns' default rule is
      // Group vote), and its creator, for the line said from the reader's side.
      assert.deepEqual(got.body.approval, {
        policy: 'anyone', approvals_required: null, electorate: 1, required: 1,
        mode: 'columns', preset: 'group_vote', rules: null, groups: [],
        // #6811: the groups the project's app keeps, so the Who can see &
        // change it sheet lists the ones no rule names yet. This app keeps
        // none, and an empty list (not absent) tells the sheet to say a
        // hand-typed kept group has not been sent.
        appGroups: [],
        creator: { id: owner.id, username: owner.username, display_name: null },
        creator_gone: false,
        // Polish board #13: the invited approvers' names, so the Workshop's
        // rule line is drawn once. None here: approval is not by invitation.
        approvers: null,
      });
      // #6281: a creator who deleted their account leaves apps.created_by
      // NULL (ON DELETE SET NULL), so the sheet is told the account is gone
      // rather than that the project never had a creator. The platform's own
      // project has no creator by design, and keeps saying so.
      await pool.query('UPDATE apps SET created_by = NULL WHERE id = $1', [a.id]);
      got = await call('GET', `/api/apps/${a.slug}/community`);
      assert.equal(got.body.approval.creator, null);
      assert.equal(got.body.approval.creator_gone, true);
      await pool.query('UPDATE apps SET self_hosted = true WHERE id = $1', [a.id]);
      got = await call('GET', `/api/apps/${a.slug}/community`);
      assert.equal(got.body.approval.creator_gone, false, 'no creator by design is not a gone account');
      await pool.query('UPDATE apps SET self_hosted = false, created_by = $2 WHERE id = $1', [a.id, owner.id]);
      assert.deepEqual(got.body.visibility, { build: 'public', view: 'public' });
      const { discussion: said, ...channel } = got.body.channel;
      assert.deepEqual(channel, {
        last_message: null, last_at: null, last_by: null, unread_count: 0,
        recent: [], href: `#messages/app/${a.slug}`, handle: null,
        post_url: `/api/apps/${a.slug}/messages`,
      }, 'a collab-public app: its channel is offered, with its last few messages, its address and where the hub posts');
      // The hub's Discussion (26 Nov 2026, services/discussion.js): when it
      // arrived, and nothing said before it in a channel with no messages.
      const { rows: marker } = await pool.query("SELECT value FROM platform_settings WHERE key = 'discussion_posts_since'");
      assert.deepEqual(said, { since: new Date(marker[0].value).toISOString(), fold_at: 8, earlier: null });
      const { daily, active_people: activePeople, ...counts } = got.body.activity;
      assert.deepEqual(counts, { active_week: 0, shipped_month: 0 },
        'and the hub\'s two numbers');
      assert.equal(daily.length, 14, 'and its fourteen days');
      assert.ok(daily.every((d) => d.n === 0 && /^\d{4}-\d{2}-\d{2}$/.test(d.day)));
      assert.deepEqual(activePeople, [], 'and nobody to name');
      assert.equal(got.body.can_manage, false, 'a viewer cannot propose who it is for');
      assert.equal(got.body.audience_change, null);

      got = await call('POST', `/api/apps/${a.slug}/membership`, { joined: 'yes' });
      assert.equal(got.status, 400, 'joined must be a boolean');
      got = await call('POST', `/api/apps/${a.slug}/membership`, { joined: true });
      assert.equal(got.status, 200);
      assert.equal(got.body.is_member, true);
      assert.equal(got.body.member_count, 2);

      const listed = (await call('GET', '/api/apps')).body.apps.find((x) => x.slug === a.slug);
      assert.equal(listed.is_member, true);
      assert.equal(listed.member_count, 2);
      assert.equal(listed.audience, 'open');
      assert.ok(listed.last_active_at, 'joining is activity, so the Workshop can order by it');
      assert.equal(listed.is_favorited, false, 'Join pins the community, not the app (One Home, #6361)');

      got = await call('POST', `/api/apps/${a.slug}/membership`, { joined: false });
      assert.equal(got.body.is_member, false);
      as = owner;
      got = await call('POST', `/api/apps/${a.slug}/membership`, { joined: false });
      assert.equal(got.status, 409, 'the creator cannot leave');

      // WHO IT IS FOR, AS SOMETHING TO CHANGE: offered to whoever the
      // visibility PR route lets open one, on an app with a repository.
      got = await call('GET', `/api/apps/${a.slug}/community`);
      assert.equal(got.body.can_manage, false, 'no repository, no proposal to open');
      await pool.query(`UPDATE apps SET repo_url = 'https://github.com/o/r' WHERE id = $1`, [a.id]);
      got = await call('GET', `/api/apps/${a.slug}/community`);
      assert.equal(got.body.can_manage, true, 'the creator may propose it');
      assert.equal(got.body.audience_change, null);
      const { rows: pending } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, pr_number, pr_title)
         VALUES ($1, $2, 'promoted', 'visibility/x', 7, 'Make this app private (collaborators only)') RETURNING id`,
        [a.id, owner.id]);
      got = await call('GET', `/api/apps/${a.slug}/community`);
      assert.deepEqual(got.body.audience_change,
        { session_id: pending[0].id, pr_number: 7, title: 'Make this app private (collaborators only)' },
        'one up for a vote is pointed at, not offered again');

      const hidden = await app({ createdBy: owner.id, view: 'private', collab: 'private' });
      as = viewer;
      assert.equal((await call('GET', `/api/apps/${hidden.slug}/community`)).status, 404,
        'a private app\'s community is as invisible as the app');
      assert.equal((await call('POST', `/api/apps/${hidden.slug}/membership`, { joined: true })).status, 404,
        'and cannot be joined from outside');

      // The app's own record says who it is for as well, in the list's
      // words: the preview banner and the vote picker read it off
      // AppView.appData, which is this payload.
      assert.equal((await call('GET', `/api/apps/${a.slug}`)).body.app.audience, 'open');
      as = owner;
      await collaborate(hidden.id, owner.id);
      assert.equal((await call('GET', `/api/apps/${hidden.slug}`)).body.app.audience, 'solo',
        'a private project with one person in it is just theirs');
      await collaborate(hidden.id, viewer.id, 'invited');
      assert.equal((await call('GET', `/api/apps/${hidden.slug}`)).body.app.audience, 'invited',
        'and stops being so the moment someone is invited');
    } finally {
      await done();
    }
  });

  await t.test('the vote threshold counts active MEMBERS, and the gates cover taking part', async () => {
    const activeUsers = require('../src/services/active-users');
    const owner = await user();
    const joined = await user();
    const visitor = await user();
    const a = await app({ createdBy: owner.id });
    await collaborate(a.id, owner.id);
    await communities.join(pool, a, joined.id);
    for (const u of [owner, joined, visitor]) {
      await pool.query(
        `INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES ($1, $2, CURRENT_DATE, 120)`,
        [a.id, u.id]
      );
    }
    assert.equal((await activeUsers.getActiveUserStats(pool, a.id)).active, 2,
      'the visitor used the app but never joined, so a proposal needs no vote of theirs');
    assert.deepEqual((await activeUsers.listActiveUserIds(pool, a.id)).sort((x, y) => x - y),
      [owner.id, joined.id].sort((x, y) => x - y), 'and is not asked for one');
    assert.equal(await activeUsers.isUserActive(pool, a.id, visitor.id), false);
    assert.equal(await activeUsers.isUserActive(pool, a.id, joined.id), true);

    const run = (mw, params, u) => new Promise((resolve) => {
      const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); } };
      mw({ params, user: u && { id: u.id, isAdmin: !!u.is_admin } }, res, () => resolve({ next: true }));
    });
    const bySlug = communities.requireAppMembership(pool);
    assert.equal((await run(bySlug, { slug: a.slug }, visitor)).body.code, 'join_required',
      'starting a change, filing a request and posting are refused to a non-member');
    assert.deepEqual(await run(bySlug, { slug: a.slug }, joined), { next: true });
    assert.deepEqual(await run(bySlug, { slug: 'no-such-app' }, visitor), { next: true },
      'an unknown slug is the route\'s own 404');
    const { rows: iss } = await pool.query(
      `INSERT INTO issues (app_id, title, created_by) VALUES ($1, 'A request', $2) RETURNING id`, [a.id, owner.id]
    );
    const byIssue = communities.requireIssueMembership(pool);
    assert.equal((await run(byIssue, { id: String(iss[0].id) }, visitor)).body.code, 'join_required',
      'voting on a request is voting');
    assert.deepEqual(await run(byIssue, { id: String(iss[0].id) }, joined), { next: true });
    const frame = await communities.chatNeedsJoin(pool, a.id, visitor);
    assert.equal(frame.code, 'join_required', 'the WebSocket chat write is answered, not dropped');
    assert.equal(await communities.chatNeedsJoin(pool, a.id, joined), null);
  });

  await t.test('deleting an app drops its community', async () => {
    const a = await app();
    await pool.query('DELETE FROM apps WHERE id = $1', [a.id]);
    const { rows } = await pool.query('SELECT 1 FROM communities WHERE id = $1', [a.community_id]);
    assert.equal(rows.length, 0);
  });

  await t.test('the backfill runs once and takes in today\'s participants', async () => {
    // Exercise only the historical membership transformation with its marker
    // absent. Current boots verify receipts rather than replaying the baseline.
    const backfillSql = baseline.match(/DO \$\$\nBEGIN\n  IF NOT EXISTS \(SELECT 1 FROM platform_settings WHERE key = 'community_members_backfilled'\)[\s\S]*?END \$\$;/)[0];
    const owner = await user();
    const regular = await user();
    const voter = await user();
    const a = await app({ createdBy: owner.id });
    await pool.query('DELETE FROM community_members');
    await pool.query(`DELETE FROM platform_settings WHERE key = 'community_members_backfilled'`);
    await collaborate(a.id, owner.id);
    await pool.query('DELETE FROM community_members');
    await pool.query(
      `INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES
         ($1, $2, CURRENT_DATE - 30, 120), ($1, $2, CURRENT_DATE - 2, 5)`,
      [a.id, regular.id]
    );
    const { rows: s } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'promoted') RETURNING id`,
      [a.id, owner.id]
    );
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [s[0].id, voter.id]);
    await pool.query(backfillSql);
    const got = await members(a.id);
    assert.deepEqual(got.map((m) => [m.user_id, m.source]), [
      [owner.id, 'creator'], [regular.id, 'active'], [voter.id, 'voter'],
    ]);
    await communities.leave(pool, a, regular.id);
    await pool.query(backfillSql);
    await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
    assert.ok(!(await members(a.id)).some((m) => m.user_id === regular.id), 'the marker and a reboot keep a leaver out');
  });
  await t.test('#general is the Homeroom community\'s channel: members post, everyone reads; its old channel is archived', async () => {
    const owner = await user();
    const member = await user();
    const boss = await user({ isAdmin: true });
    const self = await app({ createdBy: owner.id, selfHosted: true });
    // Everyone let onto the platform joins Homeroom's community on the way
    // in (join_platform_community), so the outsider is one who left it.
    const outsider = await user();
    await communities.leave(pool, self, outsider.id);
    const other = await app({ createdBy: owner.id });
    await communities.join(pool, self, member.id);
    const { rows: room } = await pool.query(`SELECT id FROM conversations WHERE channel_key = 'general'`);
    const general = room[0].id;
    const asUser = (u) => ({ id: u.id, username: u.username, isAdmin: !!u.is_admin });

    // POSTING needs the Homeroom community; an admin passes, as everywhere.
    const refused = await communities.generalNeedsJoin(pool, general, asUser(outsider), self.slug);
    assert.equal(refused && refused.code, 'join_required');
    assert.equal(refused.app.slug, self.slug, 'the Join it offers is Homeroom\'s');
    assert.equal(await communities.generalNeedsJoin(pool, general, asUser(member), self.slug), null);
    assert.equal(await communities.generalNeedsJoin(pool, general, asUser(boss), self.slug), null);
    // Only #general: a group conversation is nobody's community channel.
    const { rows: group } = await pool.query(
      `INSERT INTO conversations (kind, title) VALUES ('group', 'Friends') RETURNING id`);
    assert.equal(await communities.generalNeedsJoin(pool, group[0].id, asUser(outsider), self.slug), null);

    // THE OLD CHANNEL is the platform row's, and only its.
    assert.equal(await communities.channelArchived(pool, self.id), true);
    assert.equal(await communities.channelArchived(pool, other.id), false);

    // The hub's preview: the newest three, oldest first, and unread behind
    // the reader's cursor (none for someone who never opened the room).
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, status, last_read_message_id)
       VALUES ($1, $2, 'member', 'member', NULL)`, [general, member.id]);
    for (const text of ['one', 'two', 'three', 'four']) {
      await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, $3)`,
        [general, owner.id, text]);
    }
    const summary = await communities.generalChannelSummary(pool, member.id);
    assert.equal(summary.conversation_id, general);
    assert.deepEqual(summary.recent.map((m) => m.content), ['two', 'three', 'four']);
    assert.equal(summary.recent[2].by, owner.username);
    assert.equal(summary.last_message, 'four');
    assert.equal(summary.unread_count, 4);
    assert.equal((await communities.generalChannelSummary(pool, outsider.id)).unread_count, 0);

    // An app's own channel carries the same preview.
    for (const text of ['hello', 'there']) {
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, $3)`, [other.id, member.id, text]);
    }
    const chan = await communities.channelSummary(pool, other.id, owner.id);
    assert.deepEqual(chan.recent.map((m) => [m.content, m.by]), [['hello', member.username], ['there', member.username]]);

    // THE HUB'S DISCUSSION (26 Nov 2026, services/discussion.js): what people
    // wrote in the main stream before Discussion arrived, which folds into one
    // post above eight. A reply, a later message and a deleted one are not in it;
    // an author the viewer blocked is left out of the viewer's count.
    const discussion = require('../src/services/discussion');
    discussion.resetDiscussionSinceForTest();
    const since = await discussion.discussionSince(pool);
    assert.ok(since, 'the marker is stamped by the reference data');
    const before = new Date(Date.parse(since) - 3600000).toISOString();
    const { rows: [past] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, created_at) VALUES ($1, $2, 'old', $3) RETURNING id`,
      [other.id, owner.id, before]);
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, created_at, deleted_at) VALUES ($1, $2, 'gone', $3, NOW())`,
      [other.id, owner.id, before]);
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, created_at) VALUES ($1, $2, 'a reply', 'message', $3, $4)`,
      [other.id, member.id, past.id, before]);
    const earlier = await discussion.earlierForApp(pool, other.id, since, owner.id);
    // 'hello' and 'there' were written after the marker: not earlier.
    assert.deepEqual(earlier, { count: 1, from: before, to: before, last_id: past.id });
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [member.id, owner.id]);
    assert.equal(await discussion.earlierForApp(pool, other.id, since, member.id), null, 'the blocked author\'s message is not counted for the blocker');
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_user_id = $2', [member.id, owner.id]);
    const told = await discussion.discussionSummary(pool, { appId: other.id, viewerId: owner.id });
    assert.deepEqual(told, { since, fold_at: 8, earlier });
    const inGeneral = await discussion.discussionSummary(pool, { conversationId: general, viewerId: member.id });
    assert.equal(inGeneral.earlier, null, '#general\'s messages here were all written after the marker');
    discussion.resetDiscussionSinceForTest();

    // Part 2, "Most replies" across the room: the posts busiest first, a
    // page at a time, after the fold's last message; a blocked author's
    // posts and replies are not counted for the person who blocked them.
    const { rows: talk } = await pool.query(
      `SELECT id, content FROM chat_messages WHERE app_id = $1 AND content IN ('hello', 'there') ORDER BY id`, [other.id]);
    const ranked = await discussion.rankedInApp(pool, other.id, { viewerId: owner.id, limit: 2 });
    assert.deepEqual(ranked.posts.map((p) => [p.id, p.reply_count]), [[past.id, 1], [talk[1].id, 0]], 'the post with a reply first, then the newest');
    assert.equal(ranked.more, true);
    const next = await discussion.rankedInApp(pool, other.id, { viewerId: owner.id, limit: 2, offset: 2 });
    assert.deepEqual(next, { posts: [{ id: talk[0].id, reply_count: 0, active_at: next.posts[0].active_at }], more: false });
    assert.deepEqual((await discussion.rankedInApp(pool, other.id, { viewerId: owner.id, afterId: past.id })).posts, [], 'only posts after the fold');
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [owner.id, member.id]);
    assert.deepEqual((await discussion.rankedInApp(pool, other.id, { viewerId: owner.id })).posts.map((p) => [p.id, p.reply_count]), [[past.id, 0]]);
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_user_id = $2', [owner.id, member.id]);
    assert.equal(await discussion.generalConversationId(pool), general);
    const inRoom = await discussion.rankedInConversation(pool, general, { viewerId: member.id, limit: 20 });
    assert.ok(inRoom.posts.length > 0 && inRoom.posts.every((p) => Number.isInteger(p.id) && p.reply_count === 0), '#general\'s posts, ranked');

    // Members & activity: who did something this week, what shipped this month.
    const { rows: s } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, merged_at) VALUES ($1, $2, 'merged', NOW()) RETURNING id`,
      [other.id, owner.id]);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [s[0].id, boss.id]);
    // A synthetic account taking part is neither counted nor named.
    const { rows: [bot] } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic) VALUES ('busy_bot', 'x', TRUE) RETURNING id`);
    const { rows: [beep] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, 'beep') RETURNING id`, [other.id, bot.id]);
    const { daily, active_people: activePeople, ...counts } = await communities.activitySummary(pool, other.id);
    await pool.query('DELETE FROM chat_messages WHERE id = $1', [beep.id]);
    assert.deepEqual(counts, { active_week: 3, shipped_month: 1 });
    // The trend: fourteen days, oldest first, today last, each the number of
    // different people who said something, started a change or voted.
    assert.equal(daily.length, 14);
    assert.deepEqual(daily.slice(0, 13).map((d) => d.n), Array(13).fill(0));
    assert.equal(daily[13].n, 3, 'today: the member who talked, the owner who started, the admin who voted');
    const { rows: [{ today }] } = await pool.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
    assert.equal(daily[13].day, today);
    // WHO, BY NAME (the hub's faces row): the same three people, the most
    // recently active first (the admin's vote came last, the member's
    // messages first), never the bot, with nothing but their names.
    assert.deepEqual(activePeople.map((p) => p.username), [boss.username, owner.username, member.username]);
    assert.deepEqual(Object.keys(activePeople[0]).sort(), ['display_name', 'id', 'username']);
    assert.equal(activePeople[0].id, boss.id);

    // TOP CONTRIBUTORS (request 6837), on a project of its own: a change
    // that went live, a vote on a change and a filed request count one
    // each; a synthetic account, a change that did not go live and a
    // decision (a non-general issue) count for nobody. This month is the
    // calendar month; the most first, then who took part most recently;
    // five at most; nobody at zero.
    {
      const proj = await app({ createdBy: owner.id });
      const people = [];
      for (let i = 0; i < 7; i += 1) people.push(await user());
      const session = async (userId, status, at) => (await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, status, merged_at, created_at)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz) RETURNING id`,
        [proj.id, userId, status, status === 'merged' ? at : null, at])).rows[0].id;
      const { rows: [{ now, old }] } = await pool.query(
        `SELECT NOW() AS now, date_trunc('month', NOW()) - INTERVAL '3 days' AS old`);
      // people[0]: three this month (a live change, a vote, a request).
      const live = await session(people[0].id, 'merged', now);
      const open = await session(people[1].id, 'promoted', now); // not live: counts for nobody
      await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [open, people[0].id]);
      await pool.query(`INSERT INTO issues (app_id, title, created_by) VALUES ($1, 'A request', $2)`, [proj.id, people[0].id]);
      // people[1]: one vote this month, and four live changes last month.
      await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'no')`, [live, people[1].id]);
      for (let i = 0; i < 4; i += 1) await session(people[1].id, 'merged', old);
      // people[2]: a decision only, which is not a request.
      await pool.query(`INSERT INTO issues (app_id, title, created_by, kind) VALUES ($1, 'Close it', $2, 'close_issue')`, [proj.id, people[2].id]);
      // people[3..6]: one request each last month, oldest first.
      for (let i = 3; i < 7; i += 1) {
        await pool.query(
          `INSERT INTO issues (app_id, title, created_by, created_at) VALUES ($1, 'Old request', $2, $3::timestamptz + ($4 || ' minutes')::interval)`,
          [proj.id, people[i].id, old, i]);
      }
      // The bot votes and ships: never listed.
      await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [live, bot.id]);
      await session(bot.id, 'merged', now);
      const top = await communities.contributorsSummary(pool, proj.id);
      assert.deepEqual(top.month.map((c) => [c.username, c.n]), [[people[0].username, 3], [people[1].username, 1]]);
      assert.deepEqual(top.all_time.map((c) => [c.username, c.n]), [
        [people[1].username, 5], [people[0].username, 3],
        [people[6].username, 1], [people[5].username, 1], [people[4].username, 1],
      ], 'the most first, ties by who took part most recently, five at most');
      assert.deepEqual(Object.keys(top.month[0]).sort(), ['display_name', 'id', 'n', 'username']);
      // A project nobody has taken part in: two empty lists.
      assert.deepEqual(await communities.contributorsSummary(pool, (await app()).id), { month: [], all_time: [] });
    }

    // A CHANNEL IS WHAT PEOPLE SAID. A platform line with no thread — a
    // proposal put up for a vote, a merge — is written nowhere: not the
    // Homeroom project's old room, not #general, not another app's channel.
    // A proposal's own thread keeps its copy.
    const ws = require('../src/services/ws');
    const { clearAutomatedChannelLines } = require('../src/db/migrate');
    const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;
    const roomRows = (appId) => count('SELECT COUNT(*)::int AS n FROM chat_messages WHERE app_id = $1', [appId]);
    const generalRows = () => count('SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1', [general]);
    const { rows: prop } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title) VALUES ($1, $2, 'promoted', 41, 'Dark mode') RETURNING id`,
      [self.id, owner.id]);
    const [selfBefore, otherBefore, generalBefore] = [await roomRows(self.id), await roomRows(other.id), await generalRows()];
    assert.equal(await ws.sendSystemMessage(pool, self.id, `${owner.username} promoted PR #41: Dark mode for voting`, 'vote',
      { vote: { sessionId: prop[0].id, prNumber: 41 } }), null);
    await ws.sendSystemMessage(pool, self.id, 'Dark mode merged (PR #41) and will be live in a few minutes.', 'system',
      { merged: { sessionId: prop[0].id, prNumber: 41, title: 'Dark mode' } });
    await ws.sendSystemMessage(pool, other.id, 'promoted PR #2', 'vote', { vote: { sessionId: s[0].id, prNumber: 2 } });
    await ws.sendSystemMessage(pool, self.id, 'thread copy', 'vote',
      { vote: { sessionId: prop[0].id, prNumber: 41 } }, { type: 'session', ref: prop[0].id });
    assert.equal(await roomRows(self.id) - selfBefore, 1, 'only the thread copy');
    assert.equal(await roomRows(other.id), otherBefore);
    assert.equal(await generalRows(), generalBefore);

    // AND THE LINES WRITTEN BEFORE ARE CLEARED ON BOOT. An app channel keeps
    // what people said (a deleted account's message too) and every thread's
    // copy, and loses its platform rows.
    const { rows: [{ id: kept }] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type) VALUES ($1, NULL, 'from a deleted account', 'message') RETURNING id`,
      [other.id]);
    for (const [content, type] of [['promoted PR #3 for voting', 'vote'], ['PR #3 is live', 'system'], ['PR #3 hit a conflict', 'conflict']]) {
      await pool.query(`INSERT INTO chat_messages (app_id, user_id, content, msg_type) VALUES ($1, NULL, $2, $3)`, [other.id, content, type]);
    }
    // #general: two old Homeroom lines. The member read up to the first, and
    // the owner answered the second in a thread.
    const homeroomLine = async (content) => (await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, msg_type) VALUES ($1, NULL, $2, 'system') RETURNING id`,
      [general, content])).rows[0].id;
    const { rows: [{ id: lastPerson }] } = await pool.query(
      `SELECT MAX(id) AS id FROM conversation_messages WHERE conversation_id = $1`, [general]);
    const read = await homeroomLine('evan promoted PR #40: Hub composer for voting');
    const answered = await homeroomLine('Hub composer merged (PR #40)');
    const { rows: [{ id: reply }] } = await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id) VALUES ($1, $2, 'nice one', $3) RETURNING id`,
      [general, owner.id, answered]);
    await pool.query(`UPDATE conversation_members SET last_read_message_id = $3 WHERE conversation_id = $1 AND user_id = $2`,
      [general, member.id, read]);

    await clearAutomatedChannelLines(pool);
    const { rows: left } = await pool.query(
      `SELECT id, content, thread_type FROM chat_messages WHERE app_id = ANY($1::int[]) AND user_id IS NULL ORDER BY id`,
      [[self.id, other.id]]);
    assert.deepEqual(left.map((r) => [r.content, r.thread_type]), [['thread copy', 'session'], ['from a deleted account', null]]);
    assert.equal(left[1].id, kept);
    const { rows: gen } = await pool.query(
      `SELECT id, content, deleted_at IS NOT NULL AS deleted FROM conversation_messages WHERE id = ANY($1::int[]) ORDER BY id`,
      [[read, answered, reply]]);
    assert.deepEqual(gen.map((r) => [r.id, r.content, r.deleted]), [
      [answered, '', true],
      [reply, 'nice one', false],
    ], 'the unanswered line is gone; the answered one keeps its place and loses its words, and the reply stays');
    const { rows: [cursor] } = await pool.query(
      `SELECT last_read_message_id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, [general, member.id]);
    assert.equal(cursor.last_read_message_id, lastPerson, 'moved back to the last line that stays, not to NULL');
    assert.equal((await communities.generalChannelSummary(pool, member.id)).unread_count, 0, 'so the room does not read as unread');
    // Once clean, the next boot changes nothing.
    const snapshot = async () => (await pool.query(
      `SELECT (SELECT COUNT(*) FROM chat_messages)::int AS a, (SELECT COUNT(*) FROM conversation_messages)::int AS b,
              (SELECT COUNT(*) FROM conversation_messages WHERE deleted_at IS NOT NULL)::int AS c`)).rows[0];
    const once = await snapshot();
    await clearAutomatedChannelLines(pool);
    assert.deepEqual(await snapshot(), once);
  });

  await t.test('#3270: the Needs you feed is every decision owed in your projects, mixed, newest first', async () => {
    const overview = require('../src/routes/workshop-overview');
    const me = await user();
    const author = await user();
    const garden = await app({ createdBy: author.id });
    const swap = await app({ createdBy: author.id });
    const stranger = await app({ createdBy: author.id });
    await communities.join(pool, garden, me.id);
    await communities.join(pool, swap, me.id);
    // #6245: the feed is ordered by when the vote opened (promoted_at), never
    // by a change's last activity, so that is what these rows set.
    // #6402: a change is owed only once its checks passed, so these fixtures
    // are ready changes; this test is about the feed's order and contents.
    const promote = async (a, title, ago) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_title, pr_summary_md, pr_number, promoted_at, check_state)
       VALUES ($1, $2, 'promoted', $3, '## Why\n- because', 7, NOW() - $4::interval, 'passing') RETURNING id`,
      [a.id, author.id, title, ago])).rows[0].id;
    const older = await promote(garden, 'Older change', '2 days');
    const newer = await promote(swap, 'Newer change', '1 hour');
    const voted = await promote(garden, 'Already voted', '3 hours');
    await promote(stranger, 'Not my project', '10 minutes');
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [voted, me.id]);
    // #6594: a change whose votes are in asks nobody for one, and one yes is
    // all this project's rule needs; a rule asking for two keeps Older
    // change owed, with its tally so far.
    await pool.query('UPDATE apps SET approvals_required = 2 WHERE id = $1', [garden.id]);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [older, author.id]);
    await settleWorkStates(pool);
    const { rows } = await pool.query(overview.NEEDS_FEED_SQL, [me.id, false, false, overview.NEEDS_FEED_MAX]);
    const feed = overview.shapeNeedsFeed(rows);
    assert.deepEqual(feed.map((f) => [f.app.slug, f.title]), [
      [swap.slug, 'Newer change'], [garden.slug, 'Older change'],
    ], 'mixed across projects by recency; not the one already voted on; not a project I am not in');
    assert.equal(feed[1].yes, 1, 'with the tally so far');
    assert.equal(feed[1].summary, '## Why\n- because', 'and the summary, for the card to set as a paragraph');
    assert.equal(typeof feed[0].epoch, 'number', 'and the epoch a vote must carry');
    // The Homeroom bot tab's Needs you (?in=threads): only the threads I
    // am in, here one I wrote in, and not once I mute it.
    const olderThread = (await pool.query('SELECT thread_id FROM chat_sessions WHERE id = $1', [older])).rows[0].thread_id;
    assert.ok(olderThread, 'a change has a thread of its own');
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'which one?', 'session', $3)`,
      [garden.id, me.id, older]);
    const inThreads = async () => overview.shapeNeedsFeed(
      (await pool.query(overview.NEEDS_FEED_IN_THREADS_SQL, [me.id, false, false, 60])).rows).map((f) => f.title);
    assert.deepEqual(await inThreads(), ['Older change'], 'not a change in a thread I am not in');
    await pool.query('INSERT INTO thread_followers (thread_id, user_id, muted_at) VALUES ($1, $2, NOW())', [olderThread, me.id]);
    assert.deepEqual(await inThreads(), [], 'nor one I muted');
    await pool.query('DELETE FROM thread_followers WHERE thread_id = $1 AND user_id = $2', [olderThread, me.id]);
    // Leaving a project takes its cards with it.
    await communities.leave(pool, swap, me.id);
    await settleWorkStates(pool);
    const after = overview.shapeNeedsFeed((await pool.query(overview.NEEDS_FEED_SQL, [me.id, false, false, 60])).rows);
    assert.deepEqual(after.map((f) => f.title), ['Older change']);
  });

  await t.test('#4270: the feed marks a Just-you change whose Yes is the one it needs `approve`', async () => {
    const overview = require('../src/routes/workshop-overview');
    const me = await user();
    const bot = await user();
    const mine = await app({ createdBy: me.id, view: 'private', collab: 'private' });
    const strict = await app({ createdBy: me.id, view: 'private', collab: 'private' });
    const group = await app({ createdBy: bot.id });
    for (const a of [mine, strict, group]) await communities.join(pool, a, me.id);
    // A private project is seen by the people building it, its maker first.
    for (const a of [mine, strict]) await collaborate(a.id, me.id);
    // A rule asking for two Yes votes keeps the vote, as on the card.
    await pool.query('UPDATE apps SET approvals_required = 2 WHERE id = $1', [strict.id]);
    // #6245: a vote's place is when it opened, not the change's last activity.
    // #6402: ready changes only, so the feed still owes these votes.
    const promote = async (a, title, ago) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_title, promoted_at, check_state)
       VALUES ($1, $2, 'promoted', $3, NOW() - $4::interval, 'passing') RETURNING id`,
      [a.id, bot.id, title, ago])).rows[0].id;
    await promote(mine, 'Sunday reminder', '1 hour');
    await promote(strict, 'Two to say yes', '2 hours');
    await promote(group, 'Group change', '3 hours');
    const read = async () => overview.shapeNeedsFeed(await overview.withVotesRequired(pool,
      (await settleWorkStates(pool), await pool.query(overview.NEEDS_FEED_SQL, [me.id, false, false, overview.NEEDS_FEED_MAX])).rows));
    const feed = await read();
    assert.deepEqual(feed.map((f) => [f.title, f.approve === true]), [
      ['Sunday reminder', true], ['Two to say yes', false], ['Group change', false],
    ]);
    assert.ok(!('approve' in feed[2]), 'a group\'s item carries no flag at all');
    // Once somebody else is in it, it is a group's: the vote is a vote.
    await communities.join(pool, mine, bot.id);
    assert.equal((await read()).find((f) => f.title === 'Sunday reminder').approve, undefined);
  });

  await t.test('#5365: the feed marks a non-approver’s vote advisory and puts it after a deciding row that is older', async () => {
    const overview = require('../src/routes/workshop-overview');
    const me = await user();
    const author = await user();
    const plain = await app({ createdBy: author.id });
    const approvers = await app({ createdBy: author.id });
    await communities.join(pool, plain, me.id);
    await communities.join(pool, approvers, me.id);
    // Only the author decides the governed project's changes: the invited
    // approver roster, under approver_policy='invited'.
    await pool.query('UPDATE apps SET approver_policy = \'invited\' WHERE id = $1', [approvers.id]);
    await pool.query('INSERT INTO app_approvers (app_id, user_id) VALUES ($1, $2)', [approvers.id, author.id]);
    // #6245: a vote's place is when it opened, not the change's last activity.
    // #6402: ready changes only, so the feed still owes these votes.
    const promote = async (a, title, ago) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_title, promoted_at, check_state)
       VALUES ($1, $2, 'promoted', $3, NOW() - $4::interval, 'passing') RETURNING id`,
      [a.id, author.id, title, ago])).rows[0].id;
    const older = await promote(plain, 'Older deciding change', '2 days');
    const newer = await promote(approvers, 'Newer advisory change', '1 hour');
    await settleWorkStates(pool);
    const rows = (await pool.query(overview.NEEDS_FEED_SQL, [me.id, false, false, overview.NEEDS_FEED_MAX])).rows;
    assert.equal(rows.find((r) => r.id === newer).counts, true, 'the viewer is a member, so their vote is counted');
    await overview.withViewerDecides(pool, rows, me.id);
    const feed = overview.decidingFirst(overview.shapeNeedsFeed(rows));
    assert.deepEqual(feed.map((f) => [f.title, f.advisory === true]), [
      ['Older deciding change', false], ['Newer advisory change', true],
    ], 'newest-first would put the advisory one on top; decidingFirst keeps the deciding one first');
    const second = feed[1];
    assert.ok(!('uncounted' in second), 'advisory, not uncounted: the viewer is not a test account');
  });

  await t.test('an app suspended by moderation leaves the Messages and Workshop lists, admins included', async () => {
    const overview = require('../src/routes/workshop-overview');
    const { DISCUSSIONS_SQL } = require('../src/routes/messages-overview');
    const me = await user();
    const author = await user();
    const kept = await app({ createdBy: author.id });
    const suspended = await app({ createdBy: author.id });
    const owedIds = {};
    for (const a of [kept, suspended]) {
      await communities.join(pool, a, me.id);
      const { rows: [s] } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, status, pr_title, check_state)
         VALUES ($1, $2, 'promoted', 'Owed vote', 'passing') RETURNING id`,
        [a.id, author.id]);
      owedIds[a.slug] = s.id;
    }
    await pool.query('UPDATE apps SET moderation_suspended_at = NOW() WHERE id = $1', [suspended.id]);
    for (const isAdmin of [false, true]) {
      const discussions = (await pool.query(DISCUSSIONS_SQL, [me.id, isAdmin])).rows.map((r) => r.slug);
      assert.ok(discussions.includes(kept.slug), 'the live app is still a discussion');
      assert.ok(!discussions.includes(suspended.slug), 'the suspended one is not');
      await settleWorkStates(pool);
      const counted = (await pool.query(overview.COUNTS_SQL, [me.id, isAdmin, isAdmin])).rows;
      const counts = counted.map((r) => r.slug);
      assert.ok(counts.includes(kept.slug) && !counts.includes(suspended.slug), 'no count for a suspended app');
      // #3526: and WHICH votes the count is, in the keys the client's Needs
      // you record uses (frontend/src/features/workshop/needs-seen.ts), so a
      // vote swiped past can be taken off it and a new one cannot.
      assert.deepEqual(counted.find((r) => r.slug === kept.slug).owed, [`proposal:${owedIds[kept.slug]}@0`]);
      const items = (await pool.query(overview.ITEMS_SQL,
        [me.id, isAdmin, isAdmin, overview.ITEMS_PER_APP, overview.ITEMS_TOTAL])).rows.map((r) => r.slug);
      assert.ok(items.includes(kept.slug) && !items.includes(suspended.slug), 'no items for a suspended app');
      const feed = (await pool.query(overview.NEEDS_FEED_SQL,
        [me.id, isAdmin, isAdmin, overview.NEEDS_FEED_MAX])).rows.map((r) => r.slug);
      assert.ok(feed.includes(kept.slug) && !feed.includes(suspended.slug), 'no Needs you card for a suspended app');
    }
  });

  // #6124: a change renamed before it has a pull request was saved as the
  // name that pull request would take (proposed_pr_title) and nothing else.
  // These lists read it now, so the row saved that way shows the chosen
  // name — and a change the update path renames from now on writes both.
  await t.test('#6124: the chosen title outranks the old session name in Workshop and Needs you', async () => {
    const overview = require('../src/routes/workshop-overview');
    const me = await user();
    const author = await user();
    const mine = await app({ createdBy: me.id });
    const theirs = await app({ createdBy: author.id });
    await communities.join(pool, theirs, me.id);
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, session_title, proposed_pr_title, branch_name)
       VALUES ($1, $2, 'active', 'Add dark mdoe toggel', 'Add a dark mode toggle', 'feature/typo')`,
      [mine.id, me.id]);
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, session_title, proposed_pr_title, pr_title, check_state)
       VALUES ($1, $2, 'promoted', 'Add dark mdoe toggel', 'Add a dark mode toggle', NULL, 'passing')`,
      [theirs.id, author.id]);

    await settleWorkStates(pool);
    const items = (await pool.query(overview.ITEMS_SQL,
      [me.id, false, false, overview.ITEMS_PER_APP, overview.ITEMS_TOTAL])).rows;
    assert.equal(items.find((r) => r.slug === mine.slug && r.section === 'working').title,
      'Add a dark mode toggle', 'the Workshop row is the chosen name, not the old session one');

    const feed = (await pool.query(overview.NEEDS_FEED_SQL,
      [me.id, false, false, overview.NEEDS_FEED_MAX])).rows;
    assert.equal(feed.find((r) => r.slug === theirs.slug).title,
      'Add a dark mode toggle', 'and so is the vote owed on it');
  });
});
