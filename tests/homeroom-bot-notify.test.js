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
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
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
  globalThis.PlatformI18n = englishPlatformI18n();
  loadTsx('frontend/src/features/notifications/notifications.js');
  bell = globalThis.window.Notifications;
  return bell;
}

const AT = new Date(Date.now() - 60 * 1000).toISOString();
const notifyCopy = require('../src/services/homeroom-bot-notify-copy');
// "One story" (section 2.2): what each moment says, from the metadata the
// bot's message carries: [metadata, push title, push body, bell label, bell
// subject]. The full table of variants is tests/homeroom-bot-notify-copy.test.js.
const D = (metadata) => notifyCopy.botNotificationDetail({ appName: 'Plant Pal', requestTitle: 'Dark mode', ...metadata });
const MOMENT_WORDS = [
  [D({ moment: 'needs_you', said: 'question' }), 'Dark mode · Plant Pal', 'I have a question before I build it.', 'Needs you', 'Dark mode'],
  [D({ moment: 'needs_you', said: 'plan' }), 'Dark mode · Plant Pal', 'My plan is ready. Tap Build it if it looks right.', 'Needs you', 'Dark mode'],
  [D({ moment: 'ready', said: 'ready' }), 'Dark mode · Plant Pal', 'Ready to try. Try it, and approve it if you\'re happy.', 'Ready to try', 'Dark mode'],
  [D({ moment: 'ready', said: 'ready_group', appName: 'Supper Club', waiting: 'you and @ada' }), 'Dark mode · Supper Club',
    'Ready to try. It goes live once you and @ada say yes.', 'Ready to try', 'Dark mode'],
  // Built, but its before & after shots show part of it failing: never just "ready to try".
  [D({ moment: 'ready', said: 'ready_broken', appName: 'Flat 4B Chores', ready: { broken: ['Rota'] } }), 'Dark mode · Flat 4B Chores',
    'Built, but one thing isn\'t working yet. Try it to see.', 'Ready to try', 'Dark mode'],
  // A stop says which one, and what is next; never "A person can pick it up".
  [D({ moment: 'stopped', said: 'build_other' }), 'Dark mode · Plant Pal', 'Stopped: something went wrong while I was building. Tap Try again.', 'Stopped', 'Dark mode'],
  [D({ moment: 'stopped', said: 'needs_look' }), 'Dark mode · Plant Pal', 'Stopped: it\'s built, but a person needs to look at it before you can try it.', 'Stopped', 'Dark mode'],
  [D({ moment: 'on_hold', said: 'allowance', count: 2 }), '2 requests on hold', 'On hold until Monday: your building time for this week is used up.', 'On hold', '2 requests on hold'],
  [D({ moment: 'live', said: 'live' }), 'Dark mode · Plant Pal', 'It\'s live. Open Plant Pal to see it.', 'Live', 'Dark mode'],
  [D({ moment: 'live', said: 'live_first', firstVersion: true }), 'Plant Pal', 'Your first version is live. Open Plant Pal to try it.', 'Live', 'Plant Pal first version'],
  // "Live" only once the app answers on it.
  [D({ moment: 'live', said: 'live_soon' }), 'Dark mode · Plant Pal', 'It\'s going live now. Open Plant Pal in a few minutes to see it.', 'Live', 'Dark mode'],
  // A row written before "one story" keeps reading, as the moment it is.
  ['hrbot:question:Plant Pal', 'Plant Pal', 'I have a question before I build it.', 'Needs you', 'Plant Pal'],
  ['hrbot:stopped_build:Plant Pal', 'Plant Pal', 'Stopped: something went wrong while I was building. Tap Try again.', 'Stopped', 'Plant Pal'],
  ['hrbot:held:', 'Homeroom bot', 'On hold until Monday: I\'ve used my budget for this week.', 'On hold', 'Homeroom bot'],
  ['hrbot:live_first:Plant Pal', 'Plant Pal', 'Your first version is live. Open Plant Pal to try it.', 'Live', 'Plant Pal first version'],
];

test('B4: each moment\'s push names the request and its project and says what happened, in plain words', () => {
  for (const [detail, title, body] of MOMENT_WORDS) {
    for (const kind of ['conversation_message', 'conversation_reply', 'build_ready', 'build_stopped']) {
      const copy = policy.buildNotificationCopy(kind, {
        sourceUsername: 'homeroom_bot', sourceIsSynthetic: true, detail,
        messageContent: '**Plant Pal** · request #4: Sort by date\n\nIt\'s built.',
      });
      assert.deepEqual(copy, { title, body }, `${kind} ${detail}`);
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
  // A build moment with no detail at all still says which moment it is.
  assert.deepEqual(policy.buildNotificationCopy('build_live', {}), { title: 'Homeroom bot', body: 'It\'s live.' });
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

test('B4: the bell heads each moment as the push names it, under the project and the bot, and never folds them', () => {
  const N = loadBell();
  for (const [detail, , , label, subject] of MOMENT_WORDS) {
    for (const kind of ['conversation_reply', 'build_ready']) {
      const view = N._rowView({
        id: 1, createdAt: AT, readAt: null, kind, detail, conversationId: 7,
        conversationKind: 'direct', sourceUsername: 'homeroom_bot', messageContent: '**Plant Pal** · request #4',
      });
      assert.equal(view.label, label, detail);
      assert.deepEqual(view.segments.map((s) => s.v), [subject], detail);
      const app = notifyCopy.parseBotDetail(detail).appName;
      assert.equal(view.appLine, app ? `${app} · Homeroom bot` : 'Homeroom bot', `${detail}: the project, then who it is from`);
      assert.equal(view.by, null, 'no "by @homeroom_bot" under it');
      assert.equal(view.conversation, true, 'still a Messages row');
    }
  }
  const reply = N._rowView({
    id: 2, createdAt: AT, readAt: null, kind: 'conversation_reply', detail: 'hrbot:reply:', conversationId: 7,
    conversationKind: 'direct', sourceUsername: 'homeroom_bot', messageContent: 'Yes, **Pin notes** is up.',
  });
  assert.deepEqual([reply.label, reply.segments[0].v], ['Homeroom bot', 'Yes, Pin notes is up.']);
  // A build row without a detail is its moment, from Homeroom bot.
  const bare = N._rowView({ id: 4, createdAt: AT, readAt: null, kind: 'build_stopped', detail: null, conversationId: 7, conversationKind: 'direct' });
  assert.deepEqual([bare.label, bare.segments[0].v], ['Stopped', 'Homeroom bot']);
  const views = N._screenViews([
    { id: 3, createdAt: AT, kind: 'conversation_message', detail: D({ moment: 'live', said: 'live' }), conversationId: 7, conversationKind: 'direct' },
    { id: 2, createdAt: AT, kind: 'conversation_message', detail: 'hrbot:question:Plant Pal', conversationId: 7, conversationKind: 'direct' },
    { id: 1, createdAt: AT, kind: 'conversation_message', detail: null, conversationId: 7, conversationKind: 'direct', sourceUsername: 'ada', messageContent: 'a' },
    { id: 0, createdAt: AT, kind: 'conversation_message', detail: null, conversationId: 7, conversationKind: 'direct', sourceUsername: 'ada', messageContent: 'b' },
  ]);
  assert.deepEqual(views.map((v) => v.count || 1), [1, 1, 2], '"is live" does not hide "needs you"; a person\'s run still folds');
});

test('one story: a bell row or push tap opens the request\'s thread in the chat with the bot', () => {
  const N = loadBell();
  const row = (extra) => ({ id: 1, createdAt: AT, conversationId: 9, conversationKind: 'direct', ...extra });
  // The thread its message is in.
  assert.equal(N._conversationHref(row({ kind: 'build_ready', conversationMessageId: 80, conversationThreadRootId: 77, detail: D({ moment: 'ready' }) })),
    '#messages/9/thread/77');
  // Or the card the detail names.
  assert.equal(N._conversationHref(row({ kind: 'build_needs_you', conversationMessageId: 80, detail: D({ moment: 'needs_you', threadRootId: 76 }) })),
    '#messages/9/thread/76');
  // Or the message itself (the chat opens its thread from it).
  assert.equal(N._conversationHref(row({ kind: 'build_live', conversationMessageId: 80, detail: 'hrbot:live:Plant Pal' })), '#messages/9/m/80');
  assert.equal(N._conversationHref(row({ kind: 'build_live', detail: null })), '#messages/9');
  // A moment that rang as a message (an older row) lands the same way; a person's message still opens the chat.
  assert.equal(N._conversationHref(row({ kind: 'conversation_message', conversationMessageId: 80, detail: 'hrbot:question:Plant Pal' })), '#messages/9/m/80');
  assert.equal(N._conversationHref(row({ kind: 'conversation_message', conversationMessageId: 80, detail: null })), '#messages/9');
});

test('B4: the push and the bell keep one copy of the words', () => {
  const N = loadBell();
  // The bell's moment labels are catalog entries (notifications:row.bot.label.*):
  // each says exactly what the push module's label says.
  const ids = { needs_you: 'needsYou', ready: 'ready', stopped: 'stopped', on_hold: 'onHold', live: 'live' };
  for (const [moment, label] of Object.entries(notifyCopy.BELL_LABELS)) {
    assert.equal(message(`notifications:row.bot.label.${ids[moment]}`), label, moment);
  }
  assert.equal(message('notifications:row.bot.subject.firstVersion', { project: 'Plant Pal' }), 'Plant Pal first version');
  assert.equal(message('notifications:row.bot.meta', { project: 'Plant Pal' }), 'Plant Pal · Homeroom bot');
  // And every variant's row is headed and titled as the push module heads it.
  for (const [moment, saids] of Object.entries(notifyCopy.SAID_BY_MOMENT)) {
    for (const said of saids) {
      const first = /first/.test(said);
      const detail = D({ moment, said, firstVersion: first, count: moment === 'on_hold' ? 3 : undefined });
      const server = notifyCopy.botMomentCopy(detail);
      const view = N._rowView({ id: 1, createdAt: AT, kind: 'build_ready', detail, conversationId: 7, conversationKind: 'direct' });
      assert.deepEqual([view.label, view.segments[0].v, view.appLine], [server.bellLabel, server.bellSubject, server.bellMeta], `${moment}/${said}`);
    }
  }
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
  const moments = (rows) => rows.map((r) => {
    const d = notifyCopy.parseBotDetail(r.detail);
    return d ? `${d.moment}/${d.said}:${d.appName}` : r.detail;
  });
  assert.deepEqual(moments(rang), [
    'needs_you/question:Plant Pal', 'ready/ready_first:Plant Pal', 'live/live_first:Plant Pal',
  ], 'needs your answer, ready, live: nothing else');
  // WP-E: each as its build moment's own kind, in the "Your builds" category.
  assert.deepEqual(rang.map((r) => r.kind), ['build_needs_you', 'build_ready', 'build_live']);
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
  assert.deepEqual(moments(benRang), ['ready/ready_group:Supper Club', 'live/live:Supper Club']);

  await t.test('"it\'s built" waits until the change is ready to try, and is said once per approval round', async () => {
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
    assert.deepEqual(moments(rang), ['ready/ready:Plant Pal'], 'one ring, when it was ready');

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
    assert.deepEqual(moments([last]), ['stopped/needs_look:Plant Pal'], 'WP-F: which stop it was, so it can say what is next');
  });
});

test('WP-F: a merged change is "live" only once the app answers on it, and a stop says which one', async () => {
  const pool = { async query() { return { rows: [] }; } };
  const said = async (moment, metadata) => {
    const d = notifyCopy.parseBotDetail(await dm.notificationDetail(pool, moment, { appName: 'Plant Pal', ...metadata }));
    return `${d.moment}/${d.said}`;
  };
  assert.equal(await said('live', { live: true }), 'live/live');
  assert.equal(await said('live', { live: false }), 'live/live_soon');
  assert.equal(await said('live', { live: true, firstVersion: true }), 'live/live_first');
  assert.equal(await said('live', { live: false, firstVersion: true }), 'live/live_first_soon');
  assert.equal(await said('live', {}), 'live/live', 'a message from before the field keeps its words');
  for (const [kind, moment] of [['build_failed', 'stopped/build_other'], ['blocked', 'needs_you/blocked'], ['person', 'needs_you/decide'],
    ['empty', 'needs_you/empty'], ['first_version_failed', 'stopped/first_failed'], ['preview_failed', 'stopped/needs_look'],
    ['needs_look', 'stopped/needs_look']]) {
    assert.equal(dm.momentOf({ kind }), 'stopped', kind);
    assert.equal(await said('stopped', { kind }), moment, kind);
  }
  // A sender that names the variant is taken at its word.
  assert.equal(await said('stopped', { kind: 'build_failed', said: 'build_time' }), 'stopped/build_time');
  // Every moment rings as its kind, by its new name or its old one.
  assert.deepEqual(['needs_you', 'question', 'ready', 'stopped', 'on_hold', 'held', 'live'].map((m) => dm.BUILD_KINDS[m]),
    ['build_needs_you', 'build_needs_you', 'build_ready', 'build_stopped', 'build_stopped', 'build_stopped', 'build_live']);
  // The chat chip moves to Live after the app answers, not on the merge.
  const src = fs.readFileSync(require.resolve('../src/services/homeroom-bot-dm.js'), 'utf8');
  const merged = src.slice(src.indexOf('async function noteProposalMerged('), src.indexOf('// ── A person writing to the bot'));
  assert.ok(merged.indexOf('const live = await liveAfterMerge(') < merged.indexOf('noteChatLive(pool, run)'));
  assert.match(merged, /if \(live \|\| platform\) await noteChatLive\(pool, run\);\n {2}else laterChatLive\(pool, run, \{ config, sha, deps \}\);/);
});
