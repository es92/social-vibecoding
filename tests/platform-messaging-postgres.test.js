'use strict';

// Platform messaging's consent and concurrency rules, executed by a REAL
// postgres planner. The source-contract tests pin lock order and predicates;
// this test proves that the actual transactional SQL composes under races.
//
// Like the repository's other postgres tests, it skips when no database is
// reachable and confines every row to a throwaway schema.

const test = require('node:test');
const assert = require('node:assert/strict');

const conversations = require('../src/services/conversations');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

const DDL = `
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) NOT NULL UNIQUE
  );
  CREATE TABLE user_avatars (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('direct', 'group', 'channel')),
    title VARCHAR(80),
    deleted_peer BOOLEAN NOT NULL DEFAULT FALSE,
    channel_key VARCHAR(40) UNIQUE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE conversation_direct_pairs (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    user_low_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    CHECK (user_low_id < user_high_id),
    UNIQUE (user_low_id, user_high_id)
  );
  CREATE TABLE conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL DEFAULT 'member'
      CHECK (role IN ('owner', 'member')),
    status VARCHAR(16) NOT NULL DEFAULT 'invited'
      CHECK (status IN ('invited', 'member', 'declined', 'left', 'removed')),
    invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at TIMESTAMPTZ,
    joined_at TIMESTAMPTZ,
    left_at TIMESTAMPTZ,
    last_read_message_id INTEGER,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE UNIQUE INDEX conversation_active_owner
    ON conversation_members (conversation_id)
    WHERE role = 'owner' AND status = 'member';
  CREATE TABLE conversation_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    content TEXT NOT NULL DEFAULT '',
    msg_type VARCHAR(24) NOT NULL DEFAULT 'message',
    reply_to_id INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
    idempotency_key VARCHAR(64),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    thread_root_id INTEGER REFERENCES conversation_messages(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX conversation_message_idempotency
    ON conversation_messages (conversation_id, sender_id, idempotency_key)
    WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL;
  CREATE TABLE conversation_message_reactions (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, user_id, emoji)
  );
  CREATE TABLE conversation_message_bookmarks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, message_id)
  );
  CREATE TABLE conversation_message_attachments (
    id VARCHAR(32) PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES conversation_messages(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind VARCHAR(16) NOT NULL,
    filename VARCHAR(256) NOT NULL,
    content_type VARCHAR(128) NOT NULL,
    size_bytes INTEGER NOT NULL,
    meta JSONB,
    data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE conversation_message_objects (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
    position SMALLINT NOT NULL DEFAULT 0,
    object_type VARCHAR(24) NOT NULL,
    app_id INTEGER,
    object_ref INTEGER NOT NULL,
    object_version INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, position)
  );
  CREATE TABLE user_blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_user_id)
  );
  CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    conversation_message_id INTEGER REFERENCES conversation_messages(id) ON DELETE CASCADE,
    chat_message_id INTEGER,
    source_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind VARCHAR(32) NOT NULL,
    detail VARCHAR(32),
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- #2386: createDirect reads it (friends skip the invitation) and setBlock
  -- clears it. The full DDL is schema.sql's; tests/friends-postgres.test.js
  -- runs that.
  CREATE TABLE friendships (
    user_low_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at TIMESTAMPTZ,
    PRIMARY KEY (user_low_id, user_high_id),
    CHECK (user_low_id < user_high_id)
  );
  CREATE TABLE chat_session_spec_conversation_shares (
    session_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    shared_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, version, conversation_id)
  );
`;

async function connect() {
  let pg;
  try { pg = require('pg'); } catch { return null; }
  const client = new pg.Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* never connected */ }
    return { error: err.message || err.code || String(err) };
  }
  return { client, Pool: pg.Pool };
}

async function addUser(pool, username) {
  const { rows } = await pool.query(
    'INSERT INTO users (username) VALUES ($1) RETURNING id, username',
    [username]
  );
  return rows[0];
}

test('postgres serializes conversation consent, retries, and revocation', async (t) => {
  const connection = await connect();
  if (!connection) return t.skip('the pg driver is not installed in this environment');
  if (connection.error) return t.skip(`no postgres reachable at ${DSN}: ${connection.error}`);

  const { client, Pool } = connection;
  const schema = `platform_messaging_test_${process.pid}`;
  let pool;
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: DSN,
      connectionTimeoutMillis: 3000,
      max: 8,
      options: `-c search_path=${schema}`,
    });
    await pool.query(DDL);

    const alice = await addUser(pool, 'alice');
    const bob = await addUser(pool, 'bob');

    // Opposite-direction requests race on the normalized pair lock and become
    // one accepted direct conversation, never two rows or a lost request.
    const [aliceResult, bobResult] = await Promise.all([
      conversations.createDirect(pool, alice, bob.id),
      conversations.createDirect(pool, bob, alice.id),
    ]);
    assert.ok(aliceResult && bobResult);
    assert.equal(aliceResult.conversationId, bobResult.conversationId);
    const directId = aliceResult.conversationId;
    assert.equal(Number((await pool.query(
      'SELECT COUNT(*) AS n FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2',
      [alice.id, bob.id]
    )).rows[0].n), 1);
    assert.deepEqual((await pool.query(
      'SELECT status FROM conversation_members WHERE conversation_id = $1 ORDER BY user_id',
      [directId]
    )).rows.map((row) => row.status), ['member', 'member']);

    await conversations.sendMessage(pool, alice, directId, {
      content: 'accepted direct', idempotency_key: 'accepted-direct-1',
    });
    assert.ok(await conversations.setBlock(pool, bob.id, alice.id, true));
    assert.equal(await conversations.getConversation(pool, alice, directId), null);
    assert.equal(await conversations.getConversation(pool, bob, directId), null);
    assert.equal(Number((await pool.query(
      'SELECT COUNT(*) AS n FROM notifications WHERE conversation_id = $1', [directId]
    )).rows[0].n), 0, 'block removes notification snippets and queued-push parents');

    const carol = await addUser(pool, 'carol');
    const dave = await addUser(pool, 'dave');
    const pending = await conversations.createDirect(pool, carol, dave.id);
    assert.ok(pending);
    assert.equal(await conversations.listMessages(pool, dave, pending.conversationId), null,
      'invitee cannot read retained history before acceptance');

    // QA 2026-09-24 Q2: the requester's side says it is waiting, and may
    // still send its one opening message; the invitee's side does not.
    const beforeOpening = await conversations.getConversation(pool, carol, pending.conversationId);
    assert.equal(beforeOpening.awaitingAcceptance, true);
    assert.equal(beforeOpening.canSend, true, 'the opening message is still available');
    assert.equal((await conversations.getConversation(pool, dave, pending.conversationId)).awaitingAcceptance, false);

    // A lost-response retry of the one allowed opening message returns the
    // same row even when both requests overlap. A new key remains rejected.
    const retryInput = { content: 'opening message', idempotency_key: 'opening-retry-1' };
    const [first, retry] = await Promise.all([
      conversations.sendMessage(pool, carol, pending.conversationId, retryInput),
      conversations.sendMessage(pool, carol, pending.conversationId, retryInput),
    ]);
    assert.ok(first && retry);
    assert.equal(first.messageId, retry.messageId);
    assert.equal(Number((await pool.query(
      'SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = $1',
      [pending.conversationId]
    )).rows[0].n), 1);
    // QA 2026-09-24 Q2: refused as awaiting acceptance (the route's 409),
    // not as a missing conversation, and the requester's canSend says so.
    assert.deepEqual(await conversations.sendMessage(pool, carol, pending.conversationId, {
      content: 'second opening', idempotency_key: 'opening-retry-2',
    }), { error: 'awaiting_acceptance' });
    const afterOpening = await conversations.getConversation(pool, carol, pending.conversationId);
    assert.equal(afterOpening.awaitingAcceptance, true);
    assert.equal(afterOpening.canSend, false, 'the opening message is spent until they accept');

    // ...and once the other person accepts, sending works as it always did.
    const gina = await addUser(pool, 'gina');
    const hank = await addUser(pool, 'hank');
    const request = await conversations.createDirect(pool, gina, hank.id);
    assert.ok(await conversations.sendMessage(pool, gina, request.conversationId, {
      content: 'hello hank', idempotency_key: 'gina-opening-1',
    }));
    assert.deepEqual(await conversations.sendMessage(pool, gina, request.conversationId, {
      content: 'are you there?', idempotency_key: 'gina-second-1',
    }), { error: 'awaiting_acceptance' });
    assert.ok(await conversations.respond(pool, hank, request.conversationId, 'accept'));
    const accepted = await conversations.getConversation(pool, gina, request.conversationId);
    assert.equal(accepted.awaitingAcceptance, false);
    assert.equal(accepted.canSend, true);
    const second = await conversations.sendMessage(pool, gina, request.conversationId, {
      content: 'are you there?', idempotency_key: 'gina-second-2',
    });
    assert.ok(second && !second.error && second.messageId, 'a follow-up sends once accepted');

    await conversations.setBlock(pool, dave.id, carol.id, true);
    const terminal = (await pool.query(
      `SELECT c.status, cm.status AS invitee_status
         FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
        WHERE c.id = $1 AND cm.user_id = $2`,
      [pending.conversationId, dave.id]
    )).rows[0];
    assert.deepEqual(terminal, { status: 'archived', invitee_status: 'declined' });
    await conversations.setBlock(pool, dave.id, carol.id, false);
    assert.equal(await conversations.createDirect(pool, carol, dave.id), null,
      'original requester cannot reopen a declined request');
    const reopened = await conversations.createDirect(pool, dave, carol.id);
    assert.equal(reopened.conversationId, pending.conversationId,
      'the original recipient may explicitly reopen the retained pair');

    const erin = await addUser(pool, 'erin');
    const frank = await addUser(pool, 'frank');
    const group = await conversations.createGroup(pool, erin, 'Retained history', [frank.id]);
    await conversations.sendMessage(pool, erin, group.conversationId, {
      content: 'before acceptance', idempotency_key: 'group-history-1',
    });
    assert.equal(await conversations.listMessages(pool, frank, group.conversationId), null);
    assert.ok(await conversations.respond(pool, frank, group.conversationId, 'accept'));
    assert.deepEqual(
      (await conversations.listMessages(pool, frank, group.conversationId)).messages.map((m) => m.content),
      ['before acceptance'],
      'acceptance grants complete retained group history'
    );
    assert.ok(await conversations.removeMember(pool, erin, group.conversationId, frank.id));
    assert.equal(await conversations.listMessages(pool, frank, group.conversationId), null,
      'removal immediately revokes retained history');

    const grace = await addUser(pool, 'grace');
    const shared = await conversations.createGroup(pool, erin, 'Shared room', [frank.id, grace.id]);
    assert.ok(await conversations.respond(pool, frank, shared.conversationId, 'accept'));
    assert.ok(await conversations.respond(pool, grace, shared.conversationId, 'accept'));
    const firstShared = await conversations.sendMessage(pool, erin, shared.conversationId, {
      content: 'before block', idempotency_key: 'shared-before-block',
    });
    assert.equal((await conversations.listMessages(pool, frank, shared.conversationId)).messages.length, 1);
    await conversations.setBlock(pool, frank.id, erin.id, true);
    assert.deepEqual((await conversations.listMessages(pool, frank, shared.conversationId)).messages, [],
      'a block removes retained messages from the blocker’s shared-room view');
    assert.equal(await conversations.getMessage(pool, frank, shared.conversationId, firstShared.messageId), null);
    assert.equal((await conversations.listMessages(pool, grace, shared.conversationId)).messages.length, 1,
      'other group members keep the conversation history');
    assert.equal((await conversations.getConversation(pool, frank, shared.conversationId)).unreadCount, 0,
      'blocked messages do not contribute to unread count');
    const secondShared = await conversations.sendMessage(pool, erin, shared.conversationId, {
      content: 'after block', idempotency_key: 'shared-after-block',
    });
    assert.ok(secondShared);
    assert.equal((await conversations.listMessages(pool, frank, shared.conversationId)).messages.length, 0);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*) AS n FROM notifications
        WHERE user_id = $1 AND source_user_id = $2`, [frank.id, erin.id]
    )).rows[0].n), 0, 'the block removes old alerts and prevents new ones');
    assert.equal(await conversations.toggleReaction(pool, frank, shared.conversationId,
      firstShared.messageId, '👍'), null, 'a hidden message cannot be reacted to by id');
    await conversations.setBlock(pool, frank.id, erin.id, false);
    assert.deepEqual((await conversations.listMessages(pool, frank, shared.conversationId)).messages
      .map((message) => message.content), ['before block', 'after block'],
    'unblocking restores retained shared-room history');
  } finally {
    if (pool) await pool.end().catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  }
});

// #3188: #general is everybody, so it rings a bell only for an @mention. A
// plain message, a reply to your message, a thread you are in and a reaction
// all stay silent there, and a reply that @mentions you is a mention. The
// same moves in a group chat notify exactly as before.
test('a channel notifies only the people a message @mentions', async (t) => {
  const connection = await connect();
  if (!connection) return t.skip('the pg driver is not installed in this environment');
  if (connection.error) return t.skip(`no postgres reachable at ${DSN}: ${connection.error}`);

  const { client, Pool } = connection;
  const schema = `platform_messaging_channel_test_${process.pid}`;
  let pool;
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: DSN,
      connectionTimeoutMillis: 3000,
      max: 4,
      options: `-c search_path=${schema}`,
    });
    await pool.query(DDL);

    const ada = await addUser(pool, 'ada');
    const lin = await addUser(pool, 'lin');
    const max = await addUser(pool, 'max');
    const general = (await pool.query(
      `INSERT INTO conversations (kind, title, channel_key)
       VALUES ('channel', 'general', 'general') RETURNING id`
    )).rows[0].id;
    for (const user of [ada, lin, max]) await conversations.ensureChannelMemberships(pool, user);

    const rowsFor = async (messageId) => (await pool.query(
      `SELECT user_id, kind FROM notifications
        WHERE conversation_message_id = $1 ORDER BY user_id`, [messageId]
    )).rows;
    const send = async (user, conversationId, input) => {
      const result = await conversations.sendMessage(pool, user, conversationId, input);
      assert.ok(result && !result.error && result.messageId, `sent ${input.idempotency_key}`);
      return result;
    };

    const root = await send(ada, general, { content: 'hello everyone', idempotency_key: 'general-plain' });
    const reply = await send(lin, general, {
      content: 'hi ada', reply_to_id: root.messageId, idempotency_key: 'general-reply',
    });
    assert.deepEqual(await rowsFor(reply.messageId), [], 'a reply to your channel message is silent');
    await send(lin, general, {
      content: 'first in the thread', thread_root_id: root.messageId, idempotency_key: 'general-thread-1',
    });
    const threadReply = await send(max, general, {
      content: 'second in the thread', thread_root_id: root.messageId, idempotency_key: 'general-thread-2',
    });
    assert.deepEqual(await rowsFor(threadReply.messageId), [],
      'a thread reply rings neither the root author nor earlier repliers');
    const reaction = await conversations.toggleReaction(pool, lin, general, root.messageId, '👍');
    assert.deepEqual(reaction.notifications, []);
    assert.deepEqual(await rowsFor(root.messageId), [],
      'a plain channel message, and a reaction to it, ring no one');

    const mention = await send(max, general, { content: 'ping @lin', idempotency_key: 'general-mention' });
    assert.deepEqual(await rowsFor(mention.messageId), [{ user_id: lin.id, kind: 'conversation_mention' }]);
    const mentionReply = await send(lin, general, {
      content: '@ada have a look', reply_to_id: root.messageId, idempotency_key: 'general-mention-reply',
    });
    assert.deepEqual(await rowsFor(mentionReply.messageId), [{ user_id: ada.id, kind: 'conversation_mention' }],
      'a reply that @mentions its author is one mention row');
    const mentionThread = await send(ada, general, {
      content: 'thanks @max', thread_root_id: root.messageId, idempotency_key: 'general-mention-thread',
    });
    assert.deepEqual(await rowsFor(mentionThread.messageId), [{ user_id: max.id, kind: 'conversation_mention' }],
      'in a thread only the mentioned participant is rung');

    // The room still counts as unread in Messages; the bell holds only the
    // one mention.
    assert.equal((await conversations.getConversation(pool, ada, general)).unreadCount, 3);
    assert.deepEqual((await pool.query(
      'SELECT kind FROM notifications WHERE user_id = $1', [ada.id]
    )).rows, [{ kind: 'conversation_mention' }]);

    // A group chat is unchanged: its messages, replies, threads and
    // reactions still notify.
    const group = await conversations.createGroup(pool, ada, 'Unchanged room', [lin.id, max.id]);
    assert.ok(await conversations.respond(pool, lin, group.conversationId, 'accept'));
    assert.ok(await conversations.respond(pool, max, group.conversationId, 'accept'));
    const groupRoot = await send(ada, group.conversationId, { content: 'group hello', idempotency_key: 'group-root' });
    assert.deepEqual(await rowsFor(groupRoot.messageId), [
      { user_id: lin.id, kind: 'conversation_message' },
      { user_id: max.id, kind: 'conversation_message' },
    ]);
    const groupReply = await send(lin, group.conversationId, {
      content: 'hi ada', reply_to_id: groupRoot.messageId, idempotency_key: 'group-reply',
    });
    assert.deepEqual(await rowsFor(groupReply.messageId), [
      { user_id: ada.id, kind: 'conversation_reply' },
      { user_id: max.id, kind: 'conversation_message' },
    ]);
    const groupThread = await send(max, group.conversationId, {
      content: 'in the thread', thread_root_id: groupRoot.messageId, idempotency_key: 'group-thread',
    });
    assert.deepEqual(await rowsFor(groupThread.messageId), [{ user_id: ada.id, kind: 'conversation_thread_reply' }]);
    const groupReaction = await conversations.toggleReaction(pool, lin, group.conversationId, groupRoot.messageId, '👍');
    assert.deepEqual(groupReaction.notifications.map((row) => [row.user_id, row.kind]),
      [[ada.id, 'conversation_reaction']]);
  } finally {
    if (pool) await pool.end().catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  }
});
