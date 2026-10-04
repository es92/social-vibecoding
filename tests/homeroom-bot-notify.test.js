'use strict';

// B4: when the Homeroom bot rings, and what its notifications say.
//
// A message from the bot notifies only at four moments in a request's life
// (needs your answer, ready to try, stopped, live) and when it answers what
// the person just wrote to it. Everything else is stored, counts as unread,
// and rings nothing. What does ring says what happened, from "Homeroom bot",
// in the push and in the bell alike.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-notify.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { loadTsx } = require('./lib/render-tsx');

const policy = require('../src/services/mobile-push-policy');
const dm = require('../src/services/homeroom-bot-dm');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

let bell = null;
function loadBell() {
  if (bell) return bell;
  if (!globalThis.window) globalThis.window = globalThis;
  loadTsx('frontend/src/features/notifications/notifications.js');
  bell = globalThis.window.Notifications;
  return bell;
}

const AT = new Date(Date.now() - 60 * 1000).toISOString();
const MOMENT_WORDS = [
  ['hrbot:question:Plant Pal', 'Plant Pal: I have a question'],
  ['hrbot:ready:Plant Pal', 'Plant Pal is ready to try'],
  ['hrbot:ready_group:Supper Club', 'Your change to Supper Club is ready to try'],
  ['hrbot:stopped:Plant Pal', 'Plant Pal: your change didn\'t finish'],
  ['hrbot:held:Plant Pal', 'Plant Pal: I\'ll start it on Monday'],
  ['hrbot:held:', 'I\'ve paused until Monday'],
  ['hrbot:live:Plant Pal', 'Your change to Plant Pal is live'],
  ['hrbot:live_first:Plant Pal', 'Plant Pal is live'],
];

test('B4: each moment\'s push is from Homeroom bot and says what happened, in plain words', () => {
  for (const [detail, body] of MOMENT_WORDS) {
    for (const kind of ['conversation_message', 'conversation_reply']) {
      const copy = policy.buildNotificationCopy(kind, {
        sourceUsername: 'homeroom_bot', sourceIsSynthetic: true, detail,
        messageContent: '**Plant Pal** · request #4: Sort by date\n\nIt\'s built.',
      });
      assert.deepEqual(copy, { title: 'Homeroom bot', body }, `${kind} ${detail}`);
    }
  }
  // Its answer to what somebody wrote is its words, without their markdown.
  const reply = policy.buildNotificationCopy('conversation_reply', {
    sourceUsername: 'homeroom_bot', sourceIsSynthetic: true, detail: 'hrbot:reply:',
    messageContent: 'Yes, **Pin notes** is up. See [the change](#app/notes/dev/proposals/4) or `run it`.',
  });
  assert.deepEqual(reply, { title: 'Homeroom bot', body: 'Yes, Pin notes is up. See the change or run it.' });
  for (const [detail] of MOMENT_WORDS) {
    const copy = policy.buildNotificationCopy('conversation_message', { sourceIsSynthetic: true, sourceUsername: 'homeroom_bot', detail });
    assert.ok(!/[*`]|@homeroom_bot/.test(`${copy.title} ${copy.body}`), detail);
  }
});

test('B4: only the platform\'s own account words a message by its moment; a person\'s message is theirs', () => {
  const copy = policy.buildNotificationCopy('conversation_message', {
    sourceUsername: 'mallory', sourceIsSynthetic: false, detail: 'hrbot:live:Plant Pal', messageContent: 'hi **there**',
  });
  assert.deepEqual(copy, { title: '@mallory sent you a message', body: 'hi there' }, 'and a person\'s markdown is read as words too');
  const unknown = policy.buildNotificationCopy('conversation_reply', {
    sourceUsername: 'homeroom_bot', sourceIsSynthetic: true, detail: 'hrbot:nonsense:X', messageContent: 'Hello',
  });
  assert.deepEqual(unknown, { title: '@homeroom_bot replied to you', body: 'Hello' }, 'a moment this build cannot read says what it said');
});

test('B4: the bell words each moment as the push does, under the bot\'s name, and never folds them', () => {
  const N = loadBell();
  for (const [detail, body] of MOMENT_WORDS) {
    const view = N._rowView({
      id: 1, createdAt: AT, readAt: null, kind: 'conversation_reply', detail, conversationId: 7,
      conversationKind: 'direct', sourceUsername: 'homeroom_bot', messageContent: '**Plant Pal** · request #4',
    });
    assert.equal(view.label, 'Homeroom bot', detail);
    assert.deepEqual(view.segments.map((s) => s.v), [body], detail);
    assert.equal(view.by, null, 'the name leads; no "by @homeroom_bot" under it');
    assert.equal(view.conversation, true, 'still a Messages row');
  }
  const reply = N._rowView({
    id: 2, createdAt: AT, readAt: null, kind: 'conversation_reply', detail: 'hrbot:reply:', conversationId: 7,
    conversationKind: 'direct', sourceUsername: 'homeroom_bot', messageContent: 'Yes, **Pin notes** is up.',
  });
  assert.deepEqual([reply.label, reply.segments[0].v], ['Homeroom bot', 'Yes, Pin notes is up.']);
  const views = N._screenViews([
    { id: 3, createdAt: AT, kind: 'conversation_message', detail: 'hrbot:live:Plant Pal', conversationId: 7, conversationKind: 'direct' },
    { id: 2, createdAt: AT, kind: 'conversation_message', detail: 'hrbot:question:Plant Pal', conversationId: 7, conversationKind: 'direct' },
    { id: 1, createdAt: AT, kind: 'conversation_message', detail: null, conversationId: 7, conversationKind: 'direct', sourceUsername: 'ada', messageContent: 'a' },
    { id: 0, createdAt: AT, kind: 'conversation_message', detail: null, conversationId: 7, conversationKind: 'direct', sourceUsername: 'ada', messageContent: 'b' },
  ]);
  assert.deepEqual(views.map((v) => v.count || 1), [1, 1, 2], '"is live" does not hide "I have a question"; a person\'s run still folds');
});

test('B4: the push and the bell keep one copy of the words', () => {
  const server = fs.readFileSync(require.resolve('../src/services/mobile-push-policy.js'), 'utf8');
  const client = fs.readFileSync(require.resolve('../frontend/src/features/notifications/notifications.js'), 'utf8');
  const words = (src) => {
    const body = src.slice(src.indexOf('const words = {'), src.indexOf('}[m[1]]'));
    return body.split('\n').map((l) => l.trim()).filter((l) => /^[a-z_]+: app \?/.test(l));
  };
  assert.equal(words(server).length, 7);
  assert.deepEqual(words(client), words(server));
});

test('B4: which of the bot\'s messages ring, by kind', () => {
  const rings = ['question', 'followup_ask', 'plan', 'proposal', 'ready', 'build_failed', 'blocked', 'person', 'empty',
    'first_version_failed', 'preview_failed', 'allowance', 'paused', 'merged', 'chat', 'confirm'];
  const silent = ['activity', 'spec', 'followup_revise', 'followup_person', 'restarted', 'ack', 'filed', 'withdrawn',
    'first_version_started', 'held_proposals_per_app', 'held_proposals_total', undefined];
  for (const kind of rings) assert.ok(dm.momentOf({ kind }), `${kind} rings`);
  for (const kind of silent) assert.equal(dm.momentOf(kind ? { kind } : null), null, `${kind} is silent`);
});

test('B4: what one first version rings for its maker, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_notify_${crypto.randomBytes(6).toString('hex')}`;
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
  const project = async (slug, label, members) => {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ($1, $2, 'running', $3) RETURNING id`,
      [label, slug, members[0].id],
    );
    // The community is made by a trigger after the insert.
    const { rows: [app] } = await pool.query('SELECT id, community_id FROM apps WHERE id = $1', [inserted.id]);
    for (const m of members) {
      await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, m.id]);
    }
    return { slug, name: label };
  };
  const plantPal = await project('plant-pal', 'Plant Pal', [maya]);
  const supper = await project('supper-club', 'Supper Club', [ben, maya]);

  // A first version, start to finish, as the bot tells it.
  const fv = { appSlug: plantPal.slug, appName: plantPal.name, issueNumber: 1, firstVersion: true };
  const said = [
    ['first_version_started', 'Thanks! I\'m setting up Plant Pal now.'],
    ['activity', 'Waiting for a free builder.'],
    ['question', 'I have a question before I build the first version.'],
    ['activity', 'I\'m working on the first version now.'],
    ['spec', 'I\'m building the first version now.'],
    ['proposal', 'It\'s built.'],
    ['merged', 'It\'s live now.'],
  ];
  let n = 0;
  for (const [kind, content] of said) {
    n += 1;
    await dm.sendDm(pool, { bot, userId: maya.id, content, idempotencyKey: `fv-${n}`, metadata: { kind, ...fv } });
  }
  const { rows: rang } = await pool.query(
    'SELECT kind, detail FROM notifications WHERE user_id = $1 ORDER BY id', [maya.id],
  );
  assert.deepEqual(rang.map((r) => r.detail), [
    'hrbot:question:Plant Pal', 'hrbot:ready:Plant Pal', 'hrbot:live_first:Plant Pal',
  ], 'needs your answer, ready, live: nothing else');
  assert.ok(rang.every((r) => r.kind === 'conversation_message'));
  const { rows: [{ unread }] } = await pool.query(
    `SELECT COUNT(*)::int AS unread FROM conversation_messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
      WHERE m.sender_id = $2 AND m.id > COALESCE(cm.last_read_message_id, 0)`,
    [maya.id, bot.id],
  );
  assert.equal(unread, said.length, 'the quiet ones are still there, unread');

  // A change to a project with others in it is "your change to" it.
  await dm.sendDm(pool, {
    bot, userId: ben.id, content: 'It\'s built.', idempotencyKey: 'sc-1',
    metadata: { kind: 'proposal', appSlug: supper.slug, appName: supper.name, issueNumber: 4 },
  });
  await dm.sendDm(pool, {
    bot, userId: ben.id, content: 'It\'s live now.', idempotencyKey: 'sc-2',
    metadata: { kind: 'merged', appSlug: supper.slug, appName: supper.name, issueNumber: 4 },
  });
  const { rows: benRang } = await pool.query('SELECT detail FROM notifications WHERE user_id = $1 ORDER BY id', [ben.id]);
  assert.deepEqual(benRang.map((r) => r.detail), ['hrbot:ready_group:Supper Club', 'hrbot:live:Supper Club']);

  await t.test('"it\'s built" waits until the change is ready to try, and is said once per approval round', async () => {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_dm_users', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify([maya.username])],
    );
    const { rows: [app] } = await pool.query('SELECT id, slug, name FROM apps WHERE slug = $1', [plantPal.slug]);
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 9, $2, 'Water reminders')`,
      [app.id, maya.id],
    );
    const { rows: [change] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, check_state)
       VALUES ($1, $2, 'bot/water', 'promoted', 'Water reminders', NOW(), 'pending') RETURNING id`,
      [app.id, bot.id],
    );
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id)
       VALUES ($1, 9, 'live', 'ready', $2) RETURNING id`,
      [app.id, change.id],
    );
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1', [maya.id])).rows[0].n;
    const told = await dm.relayIssuePost({
      pool, app, issueNumber: 9, kind: 'proposal', runId: run.id, postId: 501, bot,
      dm: { link: 'https://x/#app/plant-pal/dev/proposals/1', sessionId: change.id },
    });
    assert.deepEqual([told.deferred, told.messageId, told.username], [true, null, maya.username],
      'the change went up with its checks still running: nothing yet');
    assert.equal(await dm.untaggedRequester(pool, { appId: app.id, issueNumber: 9, bot, told }), maya.username,
      'and the post on the request does not tag her instead');
    assert.equal(await dm.noteChangeReady(pool, change.id, { bot, domain: 'x' }), null, 'still pending: not ready');

    await pool.query(`UPDATE chat_sessions SET check_state = 'passing' WHERE id = $1`, [change.id]);
    const ready = await dm.noteChangeReady(pool, change.id, { bot, domain: 'x' });
    assert.ok(ready?.messageId, 'checks passed: ready to try');
    const { rows: [msg] } = await pool.query('SELECT idempotency_key, metadata FROM conversation_messages WHERE id = $1', [ready.messageId]);
    assert.equal(msg.idempotency_key, `hrbot-ready-${change.id}-0`);
    assert.equal(msg.metadata.homeroomBot.kind, 'proposal');
    const again = await dm.noteChangeReady(pool, change.id, { bot, domain: 'x' });
    assert.equal(again.duplicate, true, 'a second verdict on the same round says nothing new');
    const { rows: rang } = await pool.query('SELECT detail FROM notifications WHERE user_id = $1 ORDER BY id OFFSET $2', [maya.id, before]);
    assert.deepEqual(rang.map((r) => r.detail), ['hrbot:ready:Plant Pal'], 'one ring, when it was ready');

    // Approvals were cleared (it changed): ready again is news again.
    await pool.query('UPDATE chat_sessions SET approval_epoch = approval_epoch + 1 WHERE id = $1', [change.id]);
    const next = await dm.noteChangeReady(pool, change.id, { bot, domain: 'x' });
    assert.ok(next?.messageId && !next.duplicate && next.messageId !== ready.messageId);

    // Its preview will not start: she hears that once, never "ready".
    await pool.query(`UPDATE chat_sessions SET check_state = 'error' WHERE id = $1`, [change.id]);
    assert.equal(await dm.noteChangeReady(pool, change.id, { bot, domain: 'x' }), null);
    const stuck = await dm.noteChangeStopped(pool, change.id, { deps: { bot } });
    const { rows: [stuckMsg] } = await pool.query('SELECT content FROM conversation_messages WHERE id = $1', [stuck.messageId]);
    assert.match(stuckMsg.content, /its preview didn't start, so it isn't ready to try yet/);
    const { rows: [last] } = await pool.query('SELECT detail FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [maya.id]);
    assert.equal(last.detail, 'hrbot:stopped:Plant Pal');
  });
});
