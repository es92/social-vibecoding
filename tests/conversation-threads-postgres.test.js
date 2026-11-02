'use strict';

// #2387 — platform conversations get threads, soft delete, permalink paging
// and "mark unread", executed against the REAL migration.
//
// tests/platform-messaging-postgres.test.js proves the consent and block
// rules against a hand-written DDL. This file applies src/db/schema.sql
// itself to a throwaway database instead, because what it pins crosses more
// tables than a hand copy can honestly stand in for: the new columns and
// their self-referencing foreign key, the notifications pipeline (whose
// access gate and bell hydration must learn the new kind), the mobile-push
// kind registry, spec-share grants and moderation evidence. Then it drives
// the HTTP routes over that same database, so the status codes, response
// shapes and realtime envelopes the client is written against are the ones
// asserted here.
//
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

// Realtime and push are process-wide singletons. Capture what the routes
// hand them instead of opening sockets or scheduling badge syncs.
const events = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds, payload, options) {
      events.push({ memberIds: [...memberIds], payload, options });
      return memberIds.length;
    },
    pushToUser(userId, payload) { events.push({ userId, payload }); return 1; },
    pushNotificationToUser(userId, payload) { events.push({ userId, payload }); return 1; },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

let routePool = null;
const poolMod = require('../src/db/pool');
poolMod.getPool = () => routePool;

const conversations = require('../src/services/conversations');
const notifications = require('../src/services/notifications');
const { conversationRoutes } = require('../src/routes/conversations');

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `conversation_threads_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    // A plain DROP waits for the pool's sockets to close; FORCE could cut
    // one mid-shutdown and surface as an uncaught idle-client error.
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, including the new FK and index
  // #5104: accounts start out reachable only by people they share a project
  // with, and out of searches. This file's people are strangers who write
  // to, invite and find each other, which is what it pins, so here they
  // start out open; tests/contact-privacy-postgres.test.js pins the defaults.
  await pool.query(`ALTER TABLE users ALTER COLUMN contact_policy SET DEFAULT 'anyone',
                                      ALTER COLUMN profile_discoverable SET DEFAULT TRUE`);
  return pool;
}

test('conversation threads, soft delete, permalinks and mark-unread on the real schema', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  routePool = pool;

  let seq = 0;
  async function user(name) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`,
      [`${name}_${++seq}`]
    );
    return rows[0];
  }
  const alice = await user('alice');
  const bob = await user('bob');
  const carol = await user('carol');
  const dave = await user('dave');

  async function group(owner, title, members) {
    const created = await conversations.createGroup(pool, owner, title, members.map((m) => m.id));
    for (const member of members) {
      assert.ok(await conversations.respond(pool, member, created.conversationId, 'accept'));
    }
    return created.conversationId;
  }
  async function send(sender, conversationId, input) {
    const result = await conversations.sendMessage(pool, sender, conversationId, input);
    assert.ok(result && !result.error, `send failed: ${JSON.stringify(result)}`);
    return result;
  }
  async function alerts(where, params) {
    return (await pool.query(
      `SELECT user_id, kind, conversation_message_id, read_at FROM notifications WHERE ${where}
        ORDER BY user_id, id`, params
    )).rows;
  }

  const crew = await group(alice, 'Crew', [bob, carol, dave]);
  const direct = await conversations.createDirect(pool, alice, bob.id);
  assert.ok(await conversations.respond(pool, bob, direct.conversationId, 'accept'));

  await t.test('a thread reply joins its root, and the main stream draws it where it landed', async () => {
    const root = await send(alice, crew, { content: 'Who takes the release notes?' });
    const first = await send(bob, crew, { content: 'I can.', thread_root_id: root.messageId });
    assert.equal(first.message.threadRootId, root.messageId);
    assert.equal(first.message.thread, null, 'a reply carries no summary of its own');
    assert.deepEqual(
      (await alerts('conversation_message_id = $1', [first.messageId]))
        .map((row) => [row.user_id, row.kind]),
      [[alice.id, 'conversation_thread_reply']],
      'only the root author is a participant yet; the rest of the room is not rung'
    );

    // carol @mentions alice in the thread: alice gets ONE row, the mention;
    // bob (an earlier replier) gets the thread alert; dave, who never took
    // part, gets nothing.
    const second = await send(carol, crew, {
      content: `Thanks @${alice.username}, I will review.`, thread_root_id: root.messageId,
    });
    assert.deepEqual(
      (await alerts('conversation_message_id = $1', [second.messageId]))
        .map((row) => [row.user_id, row.kind]),
      [[alice.id, 'conversation_mention'], [bob.id, 'conversation_thread_reply']]
    );

    // #2387 follow-up: the main stream carries the replies too, in the order
    // they landed, each naming the message its thread hangs off — the
    // transcript draws them as a card where they happened.
    const page = await conversations.listMessages(pool, alice, crew);
    assert.deepEqual(page.messages.map((m) => m.id), [root.messageId, first.messageId, second.messageId]);
    assert.deepEqual(page.messages[1].threadRoot, {
      id: root.messageId, senderUsername: alice.username, content: 'Who takes the release notes?', deleted: false,
    });
    assert.equal(page.messages[0].threadRoot, null, 'a main-stream message names no thread root');
    const summary = page.messages[0].thread;
    assert.equal(summary.replyCount, 2);
    assert.equal(new Date(summary.lastReplyAt).getTime(), new Date(second.message.createdAt).getTime());
    assert.deepEqual(summary.participants.map((p) => p.id), [carol.id, bob.id],
      'most recent replier first');
    assert.deepEqual(Object.keys(summary.participants[0]).sort(), ['avatarUrl', 'id', 'username']);
    assert.equal(summary.lastReply.id, second.messageId, 'the card shows the newest reply');
    assert.equal(summary.lastReply.sender.id, carol.id);
    assert.equal(summary.lastReply.content, `Thanks @${alice.username}, I will review.`);
    assert.equal(page.messages[0].deleted, false);
    assert.equal(page.messages[0].threadRootId, null);

    const thread = await conversations.listThread(pool, alice, crew, root.messageId);
    assert.equal(thread.root.id, root.messageId);
    assert.equal(thread.root.thread.replyCount, 2);
    assert.deepEqual(thread.messages.map((m) => m.id), [first.messageId, second.messageId]);
    assert.equal(thread.nextBefore, null);
    const newest = await conversations.listThread(pool, alice, crew, root.messageId, { limit: 1 });
    assert.deepEqual(newest.messages.map((m) => m.id), [second.messageId]);
    assert.equal(newest.nextBefore, second.messageId);
    const older = await conversations.listThread(pool, alice, crew, root.messageId, {
      before: newest.nextBefore, limit: 1,
    });
    assert.deepEqual(older.messages.map((m) => m.id), [first.messageId]);
    assert.equal(older.nextBefore, null);

    // The list reads the main stream: the thread neither becomes the latest
    // message nor counts as unread, and posting in it leaves the sender's
    // main-stream cursor where it was.
    const forDave = await conversations.getConversation(pool, dave, crew);
    assert.equal(forDave.latestMessage.id, root.messageId);
    assert.equal(forDave.latestSummary, 'Who takes the release notes?');
    assert.equal(forDave.unreadCount, 1);
    const cursor = (await pool.query(
      `SELECT last_read_message_id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [crew, bob.id]
    )).rows[0].last_read_message_id;
    assert.ok(cursor == null || cursor < root.messageId, 'a thread reply does not read the main stream');

    // One level deep, in its own conversation, never in a direct one.
    assert.equal(await conversations.sendMessage(pool, alice, crew, {
      content: 'nested', thread_root_id: first.messageId,
    }), null);
    const directRoot = await send(alice, direct.conversationId, { content: 'hello' });
    assert.deepEqual(await conversations.sendMessage(pool, bob, direct.conversationId, {
      content: 'no threads here', thread_root_id: directRoot.messageId,
    }), { error: 'threads_not_supported' });
    assert.deepEqual(await conversations.listThread(pool, bob, direct.conversationId, directRoot.messageId),
      { error: 'threads_not_supported' });
    const elsewhere = await group(bob, 'Elsewhere', [alice]);
    assert.equal(await conversations.sendMessage(pool, bob, elsewhere, {
      content: 'wrong room', thread_root_id: root.messageId,
    }), null, 'the root must belong to the same conversation');
    assert.equal(await conversations.listThread(pool, alice, crew, first.messageId), null,
      'a reply is not a root');
    assert.equal(await conversations.listThread(pool, alice, crew, directRoot.messageId), null);

    // The new kind rides the conversation access gate and the bell payload.
    const bell = (await notifications.listForUser(pool, bob.id))
      .map(notifications.serialize)
      .find((row) => row.conversationMessageId === second.messageId);
    assert.equal(bell.kind, 'conversation_thread_reply');
    assert.equal(bell.conversationThreadRootId, root.messageId);
    assert.equal(bell.conversationId, crew);
    assert.equal(bell.messageContent, second.message.content);
    const mention = notifications.serialize(
      (await notifications.listForUser(pool, alice.id))
        .find((row) => row.conversation_message_id === second.messageId)
    );
    assert.equal(mention.kind, 'conversation_mention');
    assert.equal(mention.conversationThreadRootId, root.messageId);
    assert.ok(await notifications.countUnread(pool, bob.id) >= 1);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS n FROM mobile_push_kind_categories
        WHERE kind = 'conversation_thread_reply' AND category = 'messages' AND default_enabled`
    )).rows[0].n, 1, 'the kind is registered for push in the messages category');
  });

  await t.test('blocks hide replies from the summary and drop thread alerts either way', async () => {
    const root = await send(alice, crew, { content: 'Second question' });
    const fromBob = await send(bob, crew, { content: 'from bob', thread_root_id: root.messageId });
    const fromCarol = await send(carol, crew, { content: 'from carol', thread_root_id: root.messageId });
    assert.ok(await conversations.setBlock(pool, dave.id, bob.id, true));
    const forDave = (await conversations.listMessages(pool, dave, crew)).messages
      .find((m) => m.id === root.messageId);
    assert.equal(forDave.thread.replyCount, 1);
    assert.deepEqual(forDave.thread.participants.map((p) => p.id), [carol.id]);
    assert.deepEqual((await conversations.listThread(pool, dave, crew, root.messageId)).messages
      .map((m) => m.id), [fromCarol.messageId]);
    assert.ok(await conversations.setBlock(pool, dave.id, bob.id, false));

    // The SENDER's block: bob blocks carol, a participant. bob's next reply
    // rings alice (the root's author) and not carol.
    assert.ok(await conversations.setBlock(pool, bob.id, carol.id, true));
    const again = await send(bob, crew, { content: 'again', thread_root_id: root.messageId });
    assert.deepEqual(
      (await alerts('conversation_message_id = $1', [again.messageId])).map((row) => row.user_id),
      [alice.id]
    );
    assert.ok(await conversations.setBlock(pool, bob.id, carol.id, false));

    // Blocking someone removes the thread alerts they caused.
    assert.ok((await alerts('user_id = $1 AND conversation_message_id = $2', [alice.id, fromBob.messageId])).length);
    assert.ok(await conversations.setBlock(pool, alice.id, bob.id, true));
    assert.deepEqual(await alerts(
      `user_id = $1 AND source_user_id = $2 AND kind = 'conversation_thread_reply'`, [alice.id, bob.id]
    ), []);
    assert.ok(await conversations.setBlock(pool, alice.id, bob.id, false));
  });

  const paging = await group(alice, 'Paging', [bob]);
  const m = [];
  for (let i = 1; i <= 7; i++) m.push((await send(alice, paging, { content: `m${i}` })).messageId);
  const reply = (await send(bob, paging, { content: 'on m3', thread_root_id: m[2] })).messageId;

  await t.test('around opens a permalink window and after catches up', async () => {
    const around = await conversations.listMessages(pool, bob, paging, { around: m[3], limit: 3 });
    assert.deepEqual(around.messages.map((x) => x.id), [m[2], m[3], m[4]]);
    assert.equal(around.nextBefore, m[2]);
    assert.equal(around.nextAfter, m[4]);
    assert.deepEqual(around.focus, { messageId: m[3], threadRootId: null });

    const inThread = await conversations.listMessages(pool, bob, paging, { around: reply, limit: 3 });
    assert.deepEqual(inThread.messages.map((x) => x.id), [m[1], m[2], m[3]],
      'a thread reply opens the window around its root');
    assert.deepEqual(inThread.focus, { messageId: reply, threadRootId: m[2] });

    const edge = await conversations.listMessages(pool, bob, paging, { around: m[0], limit: 3 });
    assert.deepEqual(edge.messages.map((x) => x.id), [m[0], m[1]]);
    assert.equal(edge.nextBefore, null);
    assert.equal(edge.nextAfter, m[1]);

    // #2387 follow-up: the reply on m3 is part of the main stream, where it
    // landed — after m7.
    const caughtUp = await conversations.listMessages(pool, bob, paging, { after: m[4] });
    assert.deepEqual(caughtUp.messages.map((x) => x.id), [m[5], m[6], reply]);
    assert.equal(caughtUp.nextAfter, null);
    const partial = await conversations.listMessages(pool, bob, paging, { after: m[0], limit: 2 });
    assert.deepEqual(partial.messages.map((x) => x.id), [m[1], m[2]]);
    assert.equal(partial.nextAfter, m[2]);

    const back = await conversations.listMessages(pool, bob, paging, { before: m[3], limit: 2 });
    assert.deepEqual(back.messages.map((x) => x.id), [m[1], m[2]]);
    assert.equal(back.nextBefore, m[1]);

    assert.equal(await conversations.listMessages(pool, bob, paging, { around: 2147483000 }), null);
    assert.equal(await conversations.listMessages(pool, bob, crew, { around: m[3] }), null,
      'a message of another conversation is not visible here');
    assert.equal(await conversations.listMessages(pool, carol, paging, { around: m[3] }), null,
      'nor to a non-member');
    assert.ok(await conversations.setBlock(pool, bob.id, alice.id, true));
    assert.equal(await conversations.listMessages(pool, bob, paging, { around: m[3] }), null,
      'nor when its sender is blocked');
    assert.ok(await conversations.setBlock(pool, bob.id, alice.id, false));
    // #2387 follow-up: a reply's line in the main stream goes with its root:
    // a viewer who blocked the root's author has no line for a thread they
    // cannot open (checked against carol, a new member here, so bob's own
    // membership and the conversation's direct pair are untouched).
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, status) VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`, [paging, carol.id]
    );
    const carolView = async () => (await conversations.listMessages(pool, carol, paging, { limit: 50 })).messages.map((x) => x.id);
    assert.ok((await carolView()).includes(reply));
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [carol.id, alice.id]);
    assert.ok(!(await carolView()).includes(reply), 'no line for a reply under a blocked author\'s root');
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_user_id = $2', [carol.id, alice.id]);
    // A deleted reply leaves no line; its thread keeps the placeholder.
    await pool.query('UPDATE conversation_messages SET deleted_at = NOW() WHERE id = $1', [reply]);
    assert.ok(!(await carolView()).includes(reply), 'a deleted reply leaves no line');
    await pool.query('UPDATE conversation_messages SET deleted_at = NULL WHERE id = $1', [reply]);
    await pool.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [paging, carol.id]);
  });

  await t.test('mark unread moves the cursor back only; mark read stays forward-only', async () => {
    assert.ok(await conversations.markRead(pool, bob, paging, m[6]));
    assert.equal((await conversations.getConversation(pool, bob, paging)).unreadCount, 0);

    const fromFive = await conversations.markUnread(pool, bob, paging, m[4]);
    assert.deepEqual(fromFive, { messageId: m[3], unreadCount: 3 });
    assert.deepEqual(await conversations.markUnread(pool, bob, paging, m[5]),
      { messageId: m[3], unreadCount: 3 }, 'marking a later, already-unread message changes nothing');
    const all = await conversations.markUnread(pool, bob, paging, m[0]);
    assert.equal(all.messageId, null);
    assert.equal(all.unreadCount, 7);
    assert.equal(await conversations.markUnread(pool, bob, paging, reply), null,
      'a thread reply has no place on the main-stream cursor');
    assert.equal(await conversations.markUnread(pool, carol, paging, m[4]), null);

    assert.equal((await conversations.markRead(pool, bob, paging, m[1])).messageId, m[1]);
    assert.equal((await conversations.markRead(pool, bob, paging, m[0])).messageId, m[1]);

    // Reading a THREAD clears its alerts and leaves the cursor alone; reading
    // the main stream past a thread reply's id does not clear its alert.
    const aliceAlert = () => alerts(`user_id = $1 AND conversation_message_id = $2`, [alice.id, reply]);
    assert.equal((await aliceAlert())[0].kind, 'conversation_thread_reply');
    assert.equal((await aliceAlert())[0].read_at, null);
    // B19 follow-up: the thread's first page says where it opens for her,
    // its first reply she has not read, until she reads the thread.
    const opened = await conversations.listThread(pool, alice, paging, m[2]);
    assert.deepEqual(opened.read, { firstUnreadId: reply, unreadCount: 1 });
    assert.equal((await conversations.listThread(pool, alice, paging, m[2], { before: reply + 1 })).read, undefined,
      'an older page says nothing about it');
    const later = await send(bob, paging, { content: 'main stream after the reply' });
    const mainRead = await conversations.markRead(pool, alice, paging, later.messageId);
    assert.equal(mainRead.threadRootId, null);
    assert.equal((await aliceAlert())[0].read_at, null, 'the main stream does not read threads');
    const threadRead = await conversations.markRead(pool, alice, paging, reply);
    assert.equal(threadRead.threadRootId, m[2]);
    assert.equal(threadRead.messageId, later.messageId, 'the cursor did not move');
    assert.notEqual((await aliceAlert())[0].read_at, null);
    assert.equal((await conversations.listThread(pool, alice, paging, m[2])).read, undefined,
      'read: it opens at its newest reply');
  });

  await t.test('deleting your own message leaves a placeholder and removes what hung off it', async () => {
    const app = (await pool.query(
      `INSERT INTO apps (name, slug, created_by) VALUES ('Threads app', 'threads-app', $1) RETURNING id`,
      [alice.id]
    )).rows[0].id;
    const session = (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id) VALUES ($1, $2) RETURNING id`, [app, bob.id]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO chat_session_specs (session_id, version, content) VALUES ($1, 1, 'spec'), ($1, 2, 'spec 2')`,
      [session]
    );

    const doomed = await send(bob, crew, { content: `Checklist for @${alice.username}` });
    const quote = await send(alice, crew, { content: 'Quoting it', reply_to_id: doomed.messageId });
    await conversations.toggleReaction(pool, alice, crew, doomed.messageId, '👍');
    await pool.query(
      `INSERT INTO conversation_message_bookmarks (user_id, message_id) VALUES ($1, $2), ($3, $2)`,
      [alice.id, doomed.messageId, carol.id]
    );
    await pool.query(
      `INSERT INTO conversation_message_attachments
         (id, conversation_id, message_id, user_id, kind, filename, content_type, size_bytes, data)
       VALUES ($1, $2, $3, $4, 'markdown', 'a.md', 'text/markdown', 3, 'abc')`,
      ['c'.repeat(32), crew, doomed.messageId, bob.id]
    );
    // Two spec versions ride this message; version 1 is also carried by a
    // live message, so only version 2's grant goes with the delete.
    const other = await send(carol, crew, { content: 'Also v1' });
    await pool.query(
      `INSERT INTO conversation_message_objects (message_id, position, object_type, app_id, object_ref, object_version)
       VALUES ($1, 0, 'spec', $3, $4, 1), ($1, 1, 'spec', $3, $4, 2), ($2, 0, 'spec', $3, $4, 1)`,
      [doomed.messageId, other.messageId, app, session]
    );
    await pool.query(
      `INSERT INTO chat_session_spec_conversation_shares (session_id, version, conversation_id, shared_by)
       VALUES ($1, 1, $2, $3), ($1, 2, $2, $3)`,
      [session, crew, bob.id]
    );
    // A group rings every member: alice's is a mention, carol's and dave's
    // plain message alerts, and bob's is alice's reaction.
    assert.deepEqual(
      (await alerts('conversation_message_id = $1', [doomed.messageId])).map((row) => [row.user_id, row.kind]),
      [[alice.id, 'conversation_mention'], [bob.id, 'conversation_reaction'],
        [carol.id, 'conversation_message'], [dave.id, 'conversation_message']]
    );

    assert.equal(await conversations.deleteMessage(pool, alice, crew, doomed.messageId), null,
      'only the author may delete');

    const deleted = await conversations.deleteMessage(pool, bob, crew, doomed.messageId);
    assert.equal(deleted.changed, true);
    assert.equal(deleted.threadRootId, null);
    assert.deepEqual(deleted.notifiedUserIds.sort((a, b) => a - b), [alice.id, bob.id, carol.id, dave.id]);
    const placeholder = deleted.message;
    assert.equal(placeholder.deleted, true);
    assert.equal(placeholder.content, '');
    assert.equal(placeholder.editedAt, null);
    assert.equal(placeholder.saved, false);
    assert.deepEqual([placeholder.reactions, placeholder.attachments, placeholder.objects], [[], [], []]);
    assert.equal(placeholder.sender.id, bob.id, 'the sender is kept');

    const count = async (sql) => (await pool.query(sql, [doomed.messageId])).rows[0].n;
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM conversation_message_reactions WHERE message_id = $1'), 0);
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM conversation_message_bookmarks WHERE message_id = $1'), 0);
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM conversation_message_attachments WHERE message_id = $1'), 0);
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM conversation_message_objects WHERE message_id = $1'), 0);
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM notifications WHERE conversation_message_id = $1'), 0);
    assert.deepEqual((await pool.query(
      `SELECT version FROM chat_session_spec_conversation_shares WHERE conversation_id = $1 ORDER BY version`,
      [crew]
    )).rows.map((row) => row.version), [1], 'a still-carried spec version stays shared');
    const stored = (await pool.query(
      `SELECT content, deleted_at FROM conversation_messages WHERE id = $1`, [doomed.messageId]
    )).rows[0];
    assert.equal(stored.content, '');
    assert.ok(stored.deleted_at);

    const quoted = await conversations.getMessage(pool, carol, crew, quote.messageId);
    assert.deepEqual({ ...quoted.reply, sender: quoted.reply.sender.id },
      { id: doomed.messageId, sender: bob.id, content: '', deleted: true });

    const again = await conversations.deleteMessage(pool, bob, crew, doomed.messageId);
    assert.equal(again.changed, false, 'deleting twice is a no-op');
    assert.equal(again.message.deleted, true);

    assert.deepEqual(await conversations.editMessage(pool, bob, crew, doomed.messageId, 'edit'),
      { error: 'message_deleted' });
    assert.deepEqual(await conversations.toggleReaction(pool, alice, crew, doomed.messageId, '🎉'),
      { error: 'message_deleted' });
    assert.deepEqual(await conversations.reportMessage(pool, alice, crew, doomed.messageId, 'spam'),
      { error: 'message_deleted' });
    assert.equal(await conversations.editMessage(pool, alice, crew, doomed.messageId, 'edit'), null,
      'someone else still gets the ordinary not-found');

    // The list skips it: neither latest nor unread.
    const last = await send(bob, crew, { content: 'will vanish too' });
    await conversations.deleteMessage(pool, bob, crew, last.messageId);
    const forCarol = await conversations.getConversation(pool, carol, crew);
    assert.notEqual(forCarol.latestMessage.id, last.messageId);
    assert.notEqual(forCarol.latestMessage.id, doomed.messageId);
    const transcript = await conversations.listMessages(pool, carol, crew);
    assert.equal(transcript.messages.find((x) => x.id === last.messageId).deleted, true,
      'the transcript keeps the placeholder in its place');

    // A reported message's attachment is moderation evidence: it outlives
    // the delete, unreachable to members.
    const reported = await send(bob, crew, { content: 'reported' });
    await pool.query(
      `INSERT INTO conversation_message_attachments
         (id, conversation_id, message_id, user_id, kind, filename, content_type, size_bytes, data)
       VALUES ($1, $2, $3, $4, 'markdown', 'r.md', 'text/markdown', 3, 'abc')`,
      ['d'.repeat(32), crew, reported.messageId, bob.id]
    );
    assert.deepEqual(await conversations.reportMessage(pool, alice, crew, reported.messageId, 'spam'), { ok: true });
    await conversations.deleteMessage(pool, bob, crew, reported.messageId);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS n FROM conversation_message_attachments WHERE id = $1`, ['d'.repeat(32)]
    )).rows[0].n, 1);
    assert.deepEqual((await conversations.getMessage(pool, alice, crew, reported.messageId)).attachments, []);
  });

  await t.test('a deleted root keeps its thread open but cannot start one', async () => {
    const root = await send(alice, crew, { content: 'root to delete' });
    const replyOne = await send(bob, crew, { content: 'reply one', thread_root_id: root.messageId });
    const removed = await conversations.deleteMessage(pool, alice, crew, root.messageId);
    assert.equal(removed.message.deleted, true);
    assert.equal(removed.message.thread.replyCount, 1, 'the placeholder still leads to its thread');
    const thread = await conversations.listThread(pool, carol, crew, root.messageId);
    assert.equal(thread.root.deleted, true);
    assert.deepEqual(thread.messages.map((x) => x.id), [replyOne.messageId]);
    assert.ok(await send(carol, crew, { content: 'still open', thread_root_id: root.messageId }));

    const lonely = await send(alice, crew, { content: 'no replies' });
    await conversations.deleteMessage(pool, alice, crew, lonely.messageId);
    assert.deepEqual(await conversations.sendMessage(pool, bob, crew, {
      content: 'too late', thread_root_id: lonely.messageId,
    }), { error: 'message_deleted' });

    const replyDeleted = await conversations.deleteMessage(pool, bob, crew, replyOne.messageId);
    assert.equal(replyDeleted.threadRootId, root.messageId);
    const after = await conversations.listThread(pool, carol, crew, root.messageId);
    assert.equal(after.messages.find((x) => x.id === replyOne.messageId).deleted, true);
    assert.equal(after.root.thread.replyCount, 1, 'a deleted reply is not counted');
  });

  await t.test('#5219: the request\'s public discussion rides along on a bot card\'s thread', async () => {
    const bot = (await pool.query(
      // threadsAllowed names the bot's account, so the DM is with it.
      `INSERT INTO users (username, password, is_synthetic, display_name)
        VALUES ('homeroom_bot', 'x', TRUE, 'Homeroom bot') RETURNING id`
    )).rows[0];
    const viewer = await user('watcher');
    const dm = (await conversations.createDirect(pool, viewer, bot.id)).conversationId;

    // The request the card is about, public so any member can read it, plus
    // one the viewer cannot see.
    const app = (await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, view_visibility, collab_visibility)
        VALUES ('Demo app', 'demo-app-5219', $1, 'running', 'public', 'public')
        RETURNING id, slug`, [bot.id]
    )).rows[0];
    const hiddenApp = (await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, view_visibility, collab_visibility)
        VALUES ('Hidden app', 'hidden-app-5219', $1, 'running', 'private', 'private')
        RETURNING id, slug`, [bot.id]
    )).rows[0];
    const fan = await user('fan');
    const quiet = await user('quiet');

    async function discuss(appId, userId, content) {
      return (await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref)
          VALUES ($1, $2, $3, 'message', 'issue', 18) RETURNING id, created_at`,
        [appId, userId, content]
      )).rows[0];
    }

    const card = await send(bot, dm, { content: 'Demo app request #18 card' });
    assert.ok(card && card.messageId);
    await pool.query(`UPDATE conversation_messages SET metadata = $2 WHERE id = $1`, [
      card.messageId, JSON.stringify({ homeroomBot: { appSlug: 'demo-app-5219', issueNumber: 18, kind: 'activity' } }),
    ]);

    const visible = [];
    visible.push(await discuss(app.id, fan.id, 'first word'));
    visible.push(await discuss(app.id, viewer.id, 'my own line'));
    // A reply copied from the chat carries the mirror suffix and is left out
    // here: the thread shows the reply itself.
    const mirrored = await discuss(app.id, viewer.id, 'ignored');
    await pool.query(`UPDATE chat_messages SET content = $2 WHERE id = $1`, [
      mirrored.id,
      `the same reply\n\n(Sent ${require('../src/services/homeroom-bot-dm').MIRRORED_FROM_DM}`,
    ]);
    // Rows a real discussion carries but the thread must not.
    await discuss(app.id, bot.id, 'the bot is synthetic, so never shown');
    const moderated = await discuss(app.id, fan.id, 'moderated away');
    await pool.query(`UPDATE chat_messages SET moderation_hidden_at = NOW() WHERE id = $1`, [moderated.id]);
    const deletedDisc = await discuss(app.id, fan.id, 'deleted away');
    await pool.query(`UPDATE chat_messages SET deleted_at = NOW() WHERE id = $1`, [deletedDisc.id]);
    await discuss(app.id, fan.id, 'not a message');
    await pool.query(`UPDATE chat_messages SET msg_type = 'system' WHERE app_id = $1 AND content = 'not a message'`, [app.id]);
    await pool.query(`INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)`, [viewer.id, quiet.id]);
    await discuss(app.id, quiet.id, 'blocked author');

    // The bot's quiet note about a reply it mirrored repeats the discussion
    // message the thread now shows in full; its key names that message.
    await send(bot, dm, {
      content: 'You replied on the request\'s discussion: “first word”',
      thread_root_id: card.messageId,
      idempotency_key: `hrbot-replied-${visible[0].id}`,
    });
    // A note whose key names a message the page does not return stays.
    await send(bot, dm, {
      content: 'someone else replied on the request\'s discussion: “x”',
      thread_root_id: card.messageId,
      idempotency_key: 'hrbot-replied-999999999',
    });
    // The person's own answer, still in the private thread as today.
    await send(viewer, dm, { content: 'my own reply', thread_root_id: card.messageId });

    const thread = await conversations.listThread(pool, viewer, dm, card.messageId);
    assert.equal(thread.error, undefined);
    assert.deepEqual(thread.discussion, {
      appSlug: 'demo-app-5219', issueNumber: 18, more: false,
      messages: [
        { id: visible[0].id, source: 'discussion', sender: { id: fan.id, username: fan.username, avatarUrl: null },
          content: 'first word', createdAt: visible[0].created_at, editedAt: null },
        { id: visible[1].id, source: 'discussion', sender: { id: viewer.id, username: viewer.username, avatarUrl: null },
          content: 'my own line', createdAt: visible[1].created_at, editedAt: null },
      ],
    }, 'people only, oldest first, with the mirror copy and the keyed note dropped');
    const ids = thread.messages.map((x) => x.id);
    assert.equal(ids.filter((id) => ids.indexOf(id) !== ids.lastIndexOf(id)).length, 0, 'no duplicate rows');
    assert.ok(thread.messages.some((x) => x.content.includes('my own reply')), 'the viewer\'s DM reply stays in the thread');
    assert.ok(!thread.messages.some((x) => /first word/.test(x.content)),
      'the note that repeated a shown discussion message is dropped');

    // Not a bot card: no discussion, and nothing else about the reply changes.
    const plain = await send(viewer, dm, { content: 'a person\'s line' });
    const plainThread = await conversations.listThread(pool, viewer, dm, plain.messageId);
    assert.equal(plainThread.discussion, null);

    // Later pages of the same thread carry no discussion.
    await send(viewer, dm, { content: 'second reply', thread_root_id: card.messageId });
    const later = await conversations.listThread(pool, viewer, dm, card.messageId, {
      before: thread.messages[0].id,
    });
    assert.equal(later.discussion, null);

    // An app the viewer cannot view contributes nothing.
    const secretCard = await send(bot, dm, { content: 'Hidden app request #18 card' });
    await pool.query(`UPDATE conversation_messages SET metadata = $2 WHERE id = $1`, [
      secretCard.messageId,
      JSON.stringify({ homeroomBot: { appSlug: 'hidden-app-5219', issueNumber: 18, kind: 'activity' } }),
    ]);
    const secretThread = await conversations.listThread(pool, viewer, dm, secretCard.messageId);
    assert.equal(secretThread.discussion, null);

    // `more` is set when the discussion has more than the newest 50.
    for (let i = 0; i < 60; i += 1) await discuss(app.id, fan.id, `filler ${i}`);
    const wide = await conversations.listThread(pool, viewer, dm, card.messageId);
    assert.equal(wide.discussion.more, true);
    assert.equal(wide.discussion.messages.length, 50, 'the newest 50');
    assert.equal(wide.discussion.messages[0].content, 'filler 10', 'still oldest first');
    assert.equal(wide.discussion.messages[49].content, 'filler 59', 'the newest ends the page');
  });

  await t.test('the HTTP contract: status codes, bodies and realtime envelopes', async () => {
    const app = express();
    app.use(express.json());
    let actor = alice;
    app.use((req, _res, next) => { req.user = { id: actor.id, username: actor.username }; next(); });
    app.use(conversationRoutes({}));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    const call = async (as, method, url, body) => {
      actor = as;
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    const root = await call(alice, 'POST', `/api/conversations/${crew}/messages`, { content: 'http root' });
    assert.equal(root.status, 201);
    assert.equal(root.body.message.threadRootId, null);
    events.length = 0;
    const reply = await call(bob, 'POST', `/api/conversations/${crew}/messages`, {
      content: 'http reply', thread_root_id: root.body.message.id,
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.message.threadRootId, root.body.message.id);
    const created = events.find((e) => e.payload?.type === 'conversation_message_created');
    assert.deepEqual(created.payload, {
      type: 'conversation_message_created', conversationId: crew,
      messageId: reply.body.message.id, threadRootId: root.body.message.id,
    });
    assert.ok(events.some((e) => e.userId === alice.id && e.payload.type === 'notification_new'
      && e.payload.notification.kind === 'conversation_thread_reply'
      && e.payload.notification.conversationThreadRootId === root.body.message.id));

    const direct400 = await call(bob, 'POST', `/api/conversations/${direct.conversationId}/messages`, {
      content: 'x', thread_root_id: root.body.message.id,
    });
    assert.equal(direct400.status, 400);
    assert.deepEqual(direct400.body, { error: 'threads_not_supported' });
    const threadGet = await call(carol, 'GET', `/api/conversations/${crew}/threads/${root.body.message.id}`);
    assert.equal(threadGet.status, 200);
    // #5219: the response shape now carries the request's discussion (null
    // here — this root is not one of the bot's cards).
    assert.deepEqual(Object.keys(threadGet.body).sort(), ['discussion', 'messages', 'nextBefore', 'root']);
    assert.equal(threadGet.body.discussion, null);
    assert.equal(threadGet.body.root.thread.replyCount, 1);
    const directThread = await call(bob, 'GET',
      `/api/conversations/${direct.conversationId}/threads/${root.body.message.id}`);
    assert.equal(directThread.status, 400);
    assert.deepEqual(directThread.body, { error: 'threads_not_supported' });
    assert.equal((await call(carol, 'GET', `/api/conversations/${crew}/threads/${reply.body.message.id}`)).status, 404);

    const around = await call(carol, 'GET', `/api/conversations/${crew}/messages?around=${reply.body.message.id}&limit=5`);
    assert.equal(around.status, 200);
    assert.deepEqual(around.body.focus, { messageId: reply.body.message.id, threadRootId: root.body.message.id });
    assert.deepEqual(Object.keys(around.body).sort(), ['focus', 'messages', 'nextAfter', 'nextBefore']);
    // After the root: its reply, drawn in the main stream where it landed.
    const after = await call(carol, 'GET', `/api/conversations/${crew}/messages?after=${root.body.message.id}`);
    assert.deepEqual(after.body.messages.map((x) => x.id), [reply.body.message.id]);
    assert.equal(after.body.nextAfter, null);
    assert.equal((await call(carol, 'GET', `/api/conversations/${crew}/messages?after=x`)).status, 404);
    assert.equal((await call(carol, 'GET',
      `/api/conversations/${crew}/messages?after=1&before=9`)).status, 404, 'one cursor at a time');

    events.length = 0;
    const del = await call(bob, 'DELETE', `/api/conversations/${crew}/messages/${reply.body.message.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.message.deleted, true);
    const updated = events.find((e) => e.payload?.type === 'conversation_message_updated');
    assert.deepEqual(updated.payload, {
      type: 'conversation_message_updated', conversationId: crew,
      messageId: reply.body.message.id, threadRootId: root.body.message.id,
    });
    assert.ok(events.some((e) => e.userId === alice.id && e.payload.type === 'notifications_changed'),
      'the bell whose row was removed is told to recount');
    assert.equal((await call(bob, 'DELETE', `/api/conversations/${crew}/messages/${reply.body.message.id}`)).status, 200,
      'idempotent');
    assert.equal((await call(alice, 'DELETE', `/api/conversations/${crew}/messages/${root.body.message.id}9`)).status, 404);
    assert.equal((await call(carol, 'DELETE', `/api/conversations/${crew}/messages/${root.body.message.id}`)).status, 404,
      'not the author');

    for (const [method, url, body] of [
      ['PATCH', `/api/conversations/${crew}/messages/${reply.body.message.id}`, { content: 'edit' }],
      ['POST', `/api/conversations/${crew}/messages/${reply.body.message.id}/reactions`, { emoji: '👍' }],
      ['PUT', `/api/conversations/${crew}/messages/${reply.body.message.id}/bookmark`, null],
      ['POST', `/api/conversations/${crew}/messages/${reply.body.message.id}/report`, { reason: 'spam' }],
    ]) {
      const res = await call(method === 'PATCH' ? bob : carol, method, url, body);
      assert.equal(res.status, 409, `${method} ${url}`);
      assert.deepEqual(res.body, { error: 'message_deleted' });
    }

    const main = await call(alice, 'POST', `/api/conversations/${crew}/messages`, { content: 'unread me' });
    await call(carol, 'POST', `/api/conversations/${crew}/read`, { message_id: main.body.message.id });
    events.length = 0;
    const unread = await call(carol, 'POST', `/api/conversations/${crew}/unread`, { message_id: main.body.message.id });
    assert.equal(unread.status, 200);
    assert.deepEqual(unread.body, { unreadCount: 1 });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].memberIds, [carol.id], 'only the reader hears it');
    assert.equal(events[0].payload.type, 'conversation_read');
    assert.equal(events[0].payload.unread, true);
    assert.equal(events[0].payload.userId, carol.id);
    assert.equal((await call(carol, 'POST', `/api/conversations/${crew}/unread`, {})).status, 404);
  });
});
