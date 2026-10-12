'use strict';

// "One request, one story": the platform does not ping the person who asked
// Homeroom bot for something a second time about it (the bot tells them in
// their chat with it), and nobody is pinged twice about one update.
//
//   - vote_digest leaves out a change the bot built for a request the reader
//     asked for, and a change they were told is ready to try in the last day;
//   - voted_change_merged skips the change's requester, and says how the
//     voter voted;
//   - revision_recheck names whose ask the update was ("@ada", "you"), and
//     whoever got it for a version is not also sent change_ready for it;
//   - the requester's own "ready to try" (build_ready, a row of their chat
//     with the bot) is linked to the change and settled when it is decided.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/one-story-pings-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const notifications = require('../src/services/notifications');
const voteDigest = require('../src/services/vote-digest');
const dm = require('../src/services/homeroom-bot-dm');
const policy = require('../src/services/mobile-push-policy');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('one story: who the platform pings about a change Homeroom bot built, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `one_story_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const bot = await user('homeroom_bot', true);
  const maya = await user('maya');
  const ben = await user('ben');
  const cy = await user('cy');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ('Supper Club', 'supper-club', 'running', $1) RETURNING id, slug, name`,
    [maya.id],
  );
  const { rows: [{ community_id: communityId }] } = await pool.query('SELECT community_id FROM apps WHERE id = $1', [app.id]);
  for (const u of [maya, ben, cy]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [communityId, u.id]);
    await pool.query('INSERT INTO app_favorites (user_id, app_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, app.id]);
  }
  // A change Homeroom bot built for `requester`'s request #issue.
  const botChange = async (issue, requester, title) => {
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, $4)`,
      [app.id, issue, requester.id, title],
    );
    const { rows: [change] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, check_state)
       VALUES ($1, $2, $3, 'promoted', $4, NOW() - INTERVAL '2 hours', 'passing') RETURNING id`,
      [app.id, bot.id, `bot/${issue}`, title],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, $2, 'live', 'ready', $3)`,
      [app.id, issue, change.id],
    );
    return change;
  };
  const darkMode = await botChange(1, maya, 'Dark mode');
  const rota = await botChange(2, cy, 'Weekly rota');

  await t.test('the vote digest leaves out your own bot-built change, and one you were just told is ready', async () => {
    // Ben was told an hour ago that the rota is ready to try.
    await pool.query(
      `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail, created_at)
       VALUES ($1, $2, $3, $4, 'change_ready', 'epoch:0', NOW() - INTERVAL '1 hour')`,
      [ben.id, app.id, rota.id, cy.id],
    );
    const result = await voteDigest.sweep(pool);
    assert.equal(result.busy, false);
    const { rows } = await pool.query(
      `SELECT user_id, detail, session_id FROM notifications WHERE kind = 'vote_digest' ORDER BY user_id`,
    );
    const by = new Map(rows.map((r) => [Number(r.user_id), r]));
    assert.deepEqual([by.get(maya.id)?.detail, Number(by.get(maya.id)?.session_id)], ['1', rota.id],
      'maya owes the rota, never her own dark mode');
    assert.deepEqual([by.get(cy.id)?.detail, Number(by.get(cy.id)?.session_id)], ['1', darkMode.id],
      'cy owes dark mode, never her own rota');
    assert.deepEqual([by.get(ben.id)?.detail, Number(by.get(ben.id)?.session_id)], ['1', darkMode.id],
      'ben owes dark mode; the rota asked him an hour ago');
    // The digest's live count reads the same way (DIGEST_WAITING_SQL): a
    // digest of several counts the rota as waiting on maya, not her own.
    const { rows: [several] } = await pool.query(
      `INSERT INTO notifications (user_id, kind, detail) VALUES ($1, 'vote_digest', '5') RETURNING id`, [maya.id]);
    const listed = await notifications.listForUser(pool, maya.id, { limit: 50 });
    const digest = listed.find((n) => n.id === several.id);
    assert.equal(Number(digest.digest_waiting), 1, 'her own change is not counted as waiting on her');
    await pool.query('DELETE FROM notifications WHERE id = $1', [several.id]);
  });

  await t.test('"Still good?" names whose ask it was, and the same version is not also "ready to try"', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_change_asks (app_id, session_id, issue_number, asker_id, instruction, status, taken_at)
       VALUES ($1, $2, 1, $3, 'Make the toggle bigger', 'done', NOW() - INTERVAL '5 minutes')`,
      [app.id, darkMode.id, ben.id],
    );
    const rechecked = await notifications.createRevisionRecheckNotifications(pool, {
      appId: app.id, sessionId: darkMode.id, authorId: bot.id, voterIds: [ben.id, cy.id], epoch: 3,
    });
    const detail = new Map(rechecked.map((r) => [Number(r.user_id), r.detail]));
    assert.equal(detail.get(ben.id), 'epoch:3:you', 'his own ask');
    assert.equal(detail.get(cy.id), 'epoch:3:@ben', 'somebody else\'s');
    const again = await notifications.createRevisionRecheckNotifications(pool, {
      appId: app.id, sessionId: darkMode.id, authorId: bot.id, voterIds: [ben.id, cy.id], epoch: 3,
    });
    assert.deepEqual(again, [], 'one ask per version, whatever its asker');
    const words = (d) => policy.buildNotificationCopy('revision_recheck', {
      detail: d, sourceUsername: 'homeroom_bot', sourceIsSynthetic: true, sessionTitle: 'Dark mode', appName: 'Supper Club',
    });
    assert.deepEqual(words(detail.get(ben.id)), {
      title: 'Still good? Dark mode · Supper Club',
      body: '@homeroom_bot updated it after you asked for a change. One tap keeps your yes.',
    });
    assert.equal(words(detail.get(cy.id)).body, '@homeroom_bot updated it after @ben asked for a change. One tap keeps your yes.');
    assert.equal(words('epoch:3').body, '@homeroom_bot updated it after a request for changes. One tap keeps your yes.',
      'nobody known: never "after your feedback"');

    // One ping per update: the people asked "Still good?" about epoch 3 are
    // not told it is ready to try at epoch 3; somebody new still is.
    const dana = await user('dana');
    const ready = await notifications.createChangeReadyNotifications(pool, {
      appId: app.id, sessionId: darkMode.id, sourceUserId: maya.id, recipientIds: [ben.id, cy.id, dana.id], epoch: 3,
    });
    assert.deepEqual(ready.map((r) => Number(r.user_id)), [dana.id]);
    const next = await notifications.createChangeReadyNotifications(pool, {
      appId: app.id, sessionId: darkMode.id, sourceUserId: maya.id, recipientIds: [ben.id], epoch: 4,
    });
    assert.deepEqual(next.map((r) => Number(r.user_id)), [ben.id], 'a later version is news again');
  });

  await t.test('the requester\'s "ready to try" settles with the change, and its voters hear it is live, not her', async () => {
    const sent = await dm.sendDm(pool, {
      bot, userId: maya.id, content: 'It\'s built.', idempotencyKey: 'one-story-ready',
      metadata: {
        kind: 'proposal', moment: 'ready', said: 'ready_group', appSlug: app.slug, appName: app.name, issueNumber: 1,
        requestTitle: 'Dark mode', waiting: '@ben', sessionId: darkMode.id,
      },
    });
    assert.ok(sent?.messageId);
    const { rows: [ring] } = await pool.query(
      `SELECT id, kind, detail, session_id, read_at FROM notifications WHERE user_id = $1 AND kind = 'build_ready'`, [maya.id]);
    assert.equal(ring.read_at, null);
    assert.equal(policy.buildNotificationCopy('build_ready', { detail: ring.detail, sourceIsSynthetic: true }).title, 'Dark mode · Supper Club');

    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes'), ($1, $3, 'no'), ($1, $4, 'yes')`,
      [darkMode.id, maya.id, ben.id, cy.id]);
    await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [darkMode.id]);
    const told = await notifications.settleDecidedChange(pool, darkMode.id, { push: false });
    assert.ok(told.includes(maya.id));
    const { rows: [settled] } = await pool.query('SELECT session_id, read_at FROM notifications WHERE id = $1', [ring.id]);
    assert.equal(Number(settled.session_id), darkMode.id, 'linked to its change');
    assert.ok(settled.read_at, 'and read');
    const listed = await notifications.listForUser(pool, maya.id, { limit: 50 });
    assert.ok(!listed.some((n) => n.id === ring.id), 'a merged change\'s "ready to try" leaves the bell');

    const live = await notifications.createVotedChangeMergedNotifications(pool, { appId: app.id, sessionId: darkMode.id, authorId: bot.id });
    const byUser = new Map(live.map((r) => [Number(r.user_id), r.detail]));
    assert.deepEqual([...byUser.keys()].sort((a, b) => a - b), [ben.id, cy.id].sort((a, b) => a - b),
      'the voters, never the requester: the bot\'s own message tells her');
    assert.equal(byUser.get(cy.id), 'yes');
    assert.equal(byUser.get(ben.id), null);
    const words = (d) => policy.buildNotificationCopy('voted_change_merged', { detail: d, sessionTitle: 'Dark mode', appName: 'Supper Club' });
    assert.deepEqual(words('yes'), { title: 'Dark mode · Supper Club', body: 'It\'s live. You voted yes.' });
    assert.deepEqual(words(null), { title: 'Dark mode · Supper Club', body: 'It\'s live. You voted on it.' });
    assert.equal(policy.buildNotificationCopy('voted_change_merged', {
      detail: 'yes', sessionTitle: 'Dark mode', appName: 'Homeroom', appSelfHosted: true,
    }).body, 'Approved. It will be live in a few minutes. You voted yes.');
  });
});
