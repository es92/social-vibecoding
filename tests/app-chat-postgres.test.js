'use strict';

// #2387 (app channels) and #2967 (the Messages list's sections) against the
// FULL PostgreSQL schema, in a throwaway database, through the real code:
// the canonical chat handler (services/ws.js handleMessage), the REST routes
// (routes/chat.js, routes/messages-overview.js) and services/app-chat.js.
//
// Pinned here:
//   * reply threads — a 'message' thread hangs off a general-stream root of
//     the same app, never nests, never appears in the general stream, and
//     the root carries a summary; the room hears `thread_summary`, with a
//     variant for a viewer who blocked a replier;
//   * 'thread_reply' notifications — root author + earlier repliers, minus
//     the sender, a mention wins, the per-app "Replies to you" switch gates;
//   * soft delete — author only, idempotent, one transaction that clears the
//     text and removes attachments, reactions, bookmarks and notifications;
//     edit / react / save refused afterwards; a placeholder on read;
//   * the read cursor — forward-only read, back-only unread, the unread
//     definition, the lazy cursor at zero, posting as reading;
//   * paging — before / after / around with has_more_* and focus;
//   * the Messages list — "yours" = Home.isYours, "more" = activity, never
//     an app the viewer cannot open, yours first.
//
// Run with: node --test tests/app-chat-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('app channels against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `app_chat_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, the new table and columns included

  // The routes resolve their pool at construction, so it is swapped first.
  // The cross-instance bus is the one place every room frame passes through
  // (publish is a no-op until start(), so nothing else is sent anywhere):
  // recording it is how the test hears what the room would.
  require('../src/db/pool').getPool = () => pool;
  const frames = [];
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = (kind, routing, data) => frames.push({ kind, routing, data });
  const ws = require('../src/services/ws');
  const appChat = require('../src/services/app-chat');
  const { chatRoutes } = require('../src/routes/chat');
  const { messagesOverviewRoutes } = require('../src/routes/messages-overview');

  const users = {};
  async function user(username, { isAdmin = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, is_admin) VALUES ($1, 'x', $2)
       RETURNING id, username`,
      [username, isAdmin]
    );
    users[rows[0].id] = { id: rows[0].id, username, isAdmin };
    return users[rows[0].id];
  }
  async function makeApp(slug, { owner, view = 'public', collab = 'public', selfHosted = false, name: appName } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, self_hosted)
       VALUES ($1, $2, 'running', $3, $4, $5, $6) RETURNING id, slug`,
      [appName || slug, slug, owner ? owner.id : null, view, collab, selfHosted]
    );
    return rows[0];
  }
  async function member(app, who) {
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
       VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING`,
      [app.id, who.id]
    );
  }
  const client = (who, app) => ({ user: { id: who.id, username: who.username }, appId: app.id, appSlug: app.slug });
  // Posting is for the app's community (src/services/communities.js), so a
  // poster here has joined first, the way a person does with the Join
  // button — written straight to community_members so it pins nothing, and
  // the Messages list's yours/more sections below stay what they test.
  async function joinCommunity(app, who) {
    await pool.query(
      `INSERT INTO community_members (community_id, user_id, source)
         SELECT community_id, $2, 'joined' FROM apps WHERE id = $1
       ON CONFLICT DO NOTHING`,
      [app.id, who.id]
    );
  }
  async function post(who, app, content, extra = {}) {
    await joinCommunity(app, who);
    const result = await ws.handleMessage(pool, client(who, app), { type: 'chat', content, ...extra });
    return result;
  }
  async function system(app, content) {
    const { rows } = await pool.query(
      `INSERT INTO chat_messages (app_id, content, msg_type) VALUES ($1, $2, 'system') RETURNING id`,
      [app.id, content]
    );
    return rows[0].id;
  }
  const notificationsFor = async (who, kind) => (await pool.query(
    'SELECT * FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY id', [who.id, kind]
  )).rows;
  const roomFrames = (type) => frames.filter((f) => f.kind === 'room' && f.data?.type === type);

  const httpApp = express();
  httpApp.use(express.json());
  httpApp.use((req, _res, next) => {
    req.user = users[Number(req.get('x-test-user'))];
    next();
  });
  httpApp.use(chatRoutes({}));
  httpApp.use(messagesOverviewRoutes({}));
  server = await new Promise((resolve) => {
    const listening = httpApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, who, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-test-user': String(who.id), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const alice = await user('ta_alice');
  const bob = await user('ta_bob');
  const carol = await user('ta_carol');
  const dave = await user('ta_dave');
  const chan = await makeApp('ta-chan', { owner: alice, name: 'Chan' });
  const other = await makeApp('ta-other', { owner: alice, name: 'Other' });
  await member(chan, alice);
  await member(chan, bob);

  // ── Posting is for members (communities) ────────────────────────────

  await t.test('a post from someone who has not joined is answered join_required, and stores nothing', async () => {
    const outsider = await user('ta_outsider');
    const sent = [];
    const socket = { ...client(outsider, chan), ws: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) } };
    const before = Number((await pool.query('SELECT COUNT(*) AS n FROM chat_messages WHERE app_id = $1', [chan.id])).rows[0].n);
    const result = await ws.handleMessage(pool, socket, { type: 'chat', content: 'hello?' });
    assert.deepEqual(result, { ok: false, code: 'join_required' });
    assert.equal(sent.length, 1, 'answered on that one socket, not dropped in silence');
    assert.equal(sent[0].type, 'join_required');
    assert.equal(sent[0].app.slug, chan.slug);
    assert.deepEqual(sent[0].retry, { type: 'chat', content: 'hello?' }, 'the message comes back to be sent again');
    const after = Number((await pool.query('SELECT COUNT(*) AS n FROM chat_messages WHERE app_id = $1', [chan.id])).rows[0].n);
    assert.equal(after, before);
    const typing = await ws.handleMessage(pool, socket, { type: 'typing' });
    assert.notEqual(typing && typing.code, 'join_required', 'a typing indicator is not posting');
    assert.equal((await call('POST', `/api/apps/${chan.slug}/messages`, outsider, { content: 'over HTTP' })).status, 403,
      'nor over the bearer-compatible HTTP route');
  });

  // ── A refused message is answered, never dropped in silence ─────────
  //
  // The composer empties as a message leaves, so a refusal nobody answered
  // was a message that vanished (feedback, 21 Oct 2026: a reply on a
  // change's page, sent on the socket of the app Messages had open).

  const messageCount = async (app) => Number((await pool.query(
    'SELECT COUNT(*) AS n FROM chat_messages WHERE app_id = $1', [app.id])).rows[0].n);
  const socketFor = (who, app, sent) => ({ ...client(who, app), ws: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) } });

  await t.test('a reply to a change of another app is answered invalid_thread, and stores nothing', async () => {
    await joinCommunity(chan, alice);
    const { rows: [change] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'promoted') RETURNING id`,
      [other.id, alice.id]
    );
    const reply = { type: 'chat', content: 'Can you fix what is failing in the checks?', thread: { type: 'session', ref: change.id } };
    const sent = [];
    const before = await messageCount(chan);
    const result = await ws.handleMessage(pool, socketFor(alice, chan, sent), reply);
    assert.deepEqual(result, { ok: false, code: 'invalid_thread' });
    assert.deepEqual(sent, [{ type: 'error', code: 'invalid_thread' }], 'the sender hears it was not posted');
    assert.equal(await messageCount(chan), before);
    // On the socket of the change's own app, the same reply is posted.
    const posted = await post(alice, other, reply.content, { thread: reply.thread });
    assert.equal(posted.ok, true);
    assert.deepEqual(posted.message.thread, { type: 'session', ref: change.id });
  });

  await t.test('a message from someone who may not build the app is answered with why; their typing is not', async () => {
    const closed = await makeApp('ta-closed', { owner: alice, view: 'private', collab: 'private', name: 'Closed' });
    const sent = [];
    const result = await ws.handleMessage(pool, socketFor(dave, closed, sent), { type: 'chat', content: 'hi' });
    assert.deepEqual(result, { ok: false, code: 'not_collaborator' });
    assert.deepEqual(sent, [{ type: 'error', code: 'not_collaborator', message: 'Only collaborators can post here.' }]);
    sent.length = 0;
    assert.deepEqual(await ws.handleMessage(pool, socketFor(dave, closed, sent), { type: 'typing' }),
      { ok: false, code: 'not_collaborator' });
    assert.deepEqual(sent, [], 'a keystroke is not asked about');
    assert.equal(await messageCount(closed), 0);
  });

  // ── Reply threads ────────────────────────────────────────────────────

  let rootId;
  let bobReply;
  let carolReply;
  await t.test('a reply thread hangs off a general-stream root, and its replies are drawn in the general stream', async () => {
    rootId = (await post(alice, chan, 'Root: which colour for the header?')).message.id;
    frames.length = 0;
    const first = await post(bob, chan, 'Blue, I think.', { thread: { type: 'message', ref: rootId } });
    assert.equal(first.ok, true);
    bobReply = first.message.id;
    assert.deepEqual(first.message.thread, { type: 'message', ref: rootId });

    const chat = roomFrames('chat');
    assert.equal(chat.length, 1);
    assert.deepEqual(chat[0].data.thread, { type: 'message', ref: rootId }, 'the live frame names its thread');
    // #2387 follow-up: and the start of its first message, which the reply's
    // line in the general stream names.
    // #4417: and where that message is: the general stream, so the reply's
    // line is drawn there (a topic channel's root would name its thread).
    assert.deepEqual(chat[0].data.threadRoot,
      { id: rootId, username: 'ta_alice', content: 'Root: which colour for the header?', deleted: false, thread_type: null, thread_ref: null });
    const summary = roomFrames('thread_summary');
    assert.equal(summary.length, 1, 'the room hears the thread grew');
    assert.equal(summary[0].data.root_id, rootId);
    assert.equal(summary[0].data.thread.reply_count, 1);
    assert.deepEqual(summary[0].data.thread.participants, [{ id: bob.id, username: 'ta_bob' }]);

    // No nesting: a reply is not a root. Nor is a system line, a message of
    // another app, or a message that does not exist.
    const sys = await system(chan, 'ta_bob promoted PR #1');
    const otherRoot = (await post(alice, other, 'elsewhere')).message.id;
    for (const ref of [bobReply, sys, otherRoot, 2147483000]) {
      const bad = await post(carol, chan, 'nested?', { thread: { type: 'message', ref } });
      assert.deepEqual(bad, { ok: false, code: 'invalid_thread' }, `ref ${ref}`);
    }

    // The REST write path shares the validation.
    const viaRest = await call('POST', '/api/apps/ta-chan/messages', carol,
      { content: 'Green. @ta_alice what do you think?', thread_type: 'message', thread_ref: rootId });
    assert.equal(viaRest.status, 201);
    assert.equal(viaRest.body.message.thread_type, 'message');
    assert.equal(viaRest.body.message.thread_ref, rootId);
    carolReply = viaRest.body.message.id;
    const nested = await call('POST', '/api/apps/ta-chan/messages', carol,
      { content: 'x', thread_type: 'message', thread_ref: bobReply });
    assert.equal(nested.status, 400);

    // The general stream: the root with its summary — and (#2387 follow-up)
    // its replies too, where they landed, each naming its thread's root.
    const general = await call('GET', '/api/apps/ta-chan/messages', alice);
    assert.equal(general.status, 200);
    const ids = general.body.messages.map((m) => m.id);
    assert.ok(ids.includes(rootId));
    assert.ok(ids.indexOf(rootId) < ids.indexOf(bobReply) && ids.indexOf(bobReply) < ids.indexOf(carolReply),
      'the replies are in the general stream, in the order they landed');
    const bobRow = general.body.messages.find((m) => m.id === bobReply);
    assert.equal(bobRow.thread_type, 'message');
    assert.equal(bobRow.thread_ref, rootId);
    assert.deepEqual(bobRow.thread_root,
      { id: rootId, username: 'ta_alice', content: 'Root: which colour for the header?', deleted: false });
    const root = general.body.messages.find((m) => m.id === rootId);
    assert.equal(root.thread.reply_count, 2);
    assert.deepEqual(root.thread.participants.map((p) => p.username), ['ta_carol', 'ta_bob'],
      'most recent replier first');
    assert.equal(root.thread.last_reply.id, carolReply, 'the card shows the newest reply');
    assert.equal(root.thread.last_reply.username, 'ta_carol');
    assert.equal(root.thread.last_reply.content, 'Green. @ta_alice what do you think?');
    assert.equal(root.deleted, false);
    for (const m of general.body.messages.filter((row) => row.id !== rootId)) {
      assert.equal(m.thread, null, `row ${m.id} has no thread`);
    }

    // The thread itself, with its root.
    const thread = await call('GET', `/api/apps/ta-chan/messages?thread_type=message&thread_ref=${rootId}`, alice);
    assert.equal(thread.status, 200);
    assert.deepEqual(thread.body.messages.map((m) => m.id), [bobReply, carolReply]);
    assert.equal(thread.body.root.id, rootId);
    assert.equal(thread.body.root.thread.reply_count, 2);
    const missing = await call('GET', `/api/apps/ta-chan/messages?thread_type=message&thread_ref=${bobReply}`, alice);
    assert.equal(missing.status, 404, 'a reply is not a thread');
  });

  await t.test('a thread reply notifies the root author and earlier repliers; a mention wins', async () => {
    // bob's reply → alice (root author).
    const aliceThread = await notificationsFor(alice, 'thread_reply');
    assert.deepEqual(aliceThread.map((n) => n.chat_message_id), [bobReply],
      'carol @mentioned alice, so alice has a mention for that reply instead');
    assert.deepEqual((await notificationsFor(alice, 'mention')).map((n) => n.chat_message_id), [carolReply]);
    // carol's reply → bob (an earlier replier), never carol herself.
    assert.deepEqual((await notificationsFor(bob, 'thread_reply')).map((n) => n.chat_message_id), [carolReply]);
    assert.equal((await notificationsFor(carol, 'thread_reply')).length, 0);

    // The row routes to the thread.
    const notifications = require('../src/services/notifications');
    const [row] = await notifications.listForUser(pool, bob.id, { kinds: ['thread_reply'] });
    const serialized = notifications.serialize(row);
    assert.equal(serialized.threadType, 'message');
    assert.equal(serialized.threadRef, rootId);
    assert.equal(serialized.href, `#messages/app/ta-chan/thread/${rootId}`);

    // Push: the kind is in the closed registry, so the outbox trigger runs.
    const { rows: policy } = await pool.query(
      `SELECT category, default_enabled FROM mobile_push_kind_categories WHERE kind = 'thread_reply'`
    );
    assert.deepEqual(policy, [{ category: 'direct_interactions', default_enabled: true }]);

    // "Replies to you", switched off for this app, silences the kind.
    await pool.query(
      `INSERT INTO notification_preferences (user_id, app_id, category, enabled)
       VALUES ($1, $2, 'thread_replies', FALSE)`,
      [bob.id, chan.id]
    );
    await post(dave, chan, 'Purple!', { thread: { type: 'message', ref: rootId } });
    assert.equal((await notificationsFor(bob, 'thread_reply')).length, 1, 'bob muted replies here');
    assert.equal((await notificationsFor(alice, 'thread_reply')).length, 2, 'alice did not');
    assert.equal((await notificationsFor(carol, 'thread_reply')).length, 1, 'carol replied earlier');

    // Posting in the app clears the chat-actionable kinds, this one included.
    await post(carol, chan, 'Back in the main chat.');
    assert.equal((await notificationsFor(carol, 'thread_reply')).filter((n) => !n.read_at).length, 0);
  });

  // #4417 follow-up: a reply thread can start in one of the project's topic
  // channels. Its replies notify exactly as #general's do, and every row
  // about one, read back or pushed live, opens the thread beside the topic's
  // channel (notifications.THREAD_ROOT_COLUMNS_SQL), not beside #general.
  await t.test('a reply thread under a topic message notifies as #general\'s does, and opens beside the topic', async () => {
    const notifications = require('../src/services/notifications');
    const { rows: [topic] } = await pool.query(
      `INSERT INTO app_category_registry (app_id, category_key, label, origin, topic_handle, topic_state, pinned_at)
       VALUES ($1, 'kitchen', 'Kitchen', 'topic', 'kitchen', 'live', NOW()) RETURNING id`,
      [chan.id]
    );
    const topicRoot = (await post(alice, chan, 'Which knives do we keep?', { thread: { type: 'category', ref: topic.id } })).message.id;
    const href = `#messages/app/ta-chan/c/${topic.id}/thread/${topicRoot}`;
    const pushedFor = (messageId) => frames
      .filter((f) => f.kind === 'user' && f.data?.type === 'notification_new' && f.data.notification.chatMessageId === messageId)
      .map((f) => [f.data.notification.kind, f.data.notification.href]);
    frames.length = 0;
    const reply = (await post(carol, chan, 'The small one.', { thread: { type: 'message', ref: topicRoot } })).message.id;
    // The root's author hears of it, as for a #general root…
    const [row] = (await notifications.listForUser(pool, alice.id, { kinds: ['thread_reply'] }))
      .filter((n) => Number(n.chat_message_id) === reply);
    assert.ok(row, 'alice, who started the thread, is told');
    // …and the row opens the thread beside the topic's channel: listed, by
    // id (a native push's read), and pushed live.
    assert.equal(notifications.serialize(row).href, href);
    assert.equal(notifications.serialize(await notifications.getForUser(pool, alice.id, row.id)).href, href);
    assert.deepEqual(pushedFor(reply), [['thread_reply', href]]);
    // A quote reply in the thread (carol's 'reply', hydrated by the socket's
    // own read) and the thread's own row for alice: the same address.
    frames.length = 0;
    const quoted = (await post(bob, chan, 'Agreed, the small one.', {
      thread: { type: 'message', ref: topicRoot }, quote: { source: 'message', refMsgId: reply },
    })).message.id;
    assert.deepEqual(pushedFor(quoted).sort(), [['reply', href], ['thread_reply', href]]);
    // A message in the topic itself opens the channel on it (#4417).
    frames.length = 0;
    const inTopic = (await post(bob, chan, 'And the bread knife?', {
      thread: { type: 'category', ref: topic.id }, quote: { source: 'message', refMsgId: topicRoot },
    })).message.id;
    assert.deepEqual(pushedFor(inTopic), [['reply', `#messages/app/ta-chan/c/${topic.id}/m/${inTopic}`]]);
    // A #general root's thread keeps its own address (the subtest above).
    const general = (await notifications.listForUser(pool, alice.id, { kinds: ['thread_reply'] }))
      .find((n) => Number(n.thread_ref) === rootId);
    assert.equal(notifications.serialize(general).href, `#messages/app/ta-chan/thread/${rootId}`);
  });

  // #4535: a message in a request's discussion thread notifies the
  // request's filer and everyone who posted before, with no @mention
  // needed — the same exclusions a reply thread's fan-out makes.
  await t.test('a request discussion reply notifies the filer and earlier posters', async () => {
    // The earlier subtest muted "Replies to you" for bob here; unmute, and
    // give the app a repo_url so feedback reports can match by owner/repo.
    await pool.query('DELETE FROM notification_preferences WHERE user_id = $1 AND app_id = $2', [bob.id, chan.id]);
    await pool.query('UPDATE apps SET repo_url = $2 WHERE id = $1', [chan.id, 'https://github.com/ta-owner/ta-repo']);
    const { rows: issueRows } = await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, created_by)
       VALUES ($1, 4417, 'Topics behave like channels', $2) RETURNING id`,
      [chan.id, alice.id]
    );
    assert.ok(issueRows[0].id);
    const issueThread = { type: 'issue', ref: 4417 };

    // Filers known only through the other two records: one through the
    // feedback pin (matched on owner/repo, app_id null), one through the
    // bot's requester row.
    const gina = await user('ta_gina');
    const hank = await user('ta_hank');
    await pool.query(
      `INSERT INTO feedback_reports (user_id, target, issue_owner, issue_repo, issue_number, title, description)
       VALUES ($1, 'platform', 'TA-OWNER', 'ta-repo', 4417, 'Topics', 'Topics behave like channels')`,
      [gina.id]
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
       VALUES ($1, 4417, $2, 'Topics behave like channels')`,
      [chan.id, hank.id]
    );

    // A synthetic earlier poster (the bot, written directly as its status
    // line) is in the thread from the start.
    const eve = await user('ta_eve');
    const frank = await user('ta_frank');
    await pool.query('UPDATE users SET is_synthetic = TRUE WHERE id = $1', [frank.id]);
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref)
       VALUES ($1, $2, 'status line', 'message', 'issue', 4417)`,
      [chan.id, frank.id]
    );

    // bob posts first: alice (the filer), gina and hank are notified.
    const first = await post(bob, chan, 'They are like IRC channels, right?', { thread: issueThread });
    assert.equal(first.ok, true);
    const bobFirst = first.message.id;
    const aliceRows = await notificationsFor(alice, 'issue_thread_reply');
    assert.deepEqual(aliceRows.map((n) => n.chat_message_id), [bobFirst]);
    assert.deepEqual(aliceRows.map((n) => Number(n.detail)), [4417]);
    assert.deepEqual((await notificationsFor(gina, 'issue_thread_reply')).map((n) => n.chat_message_id), [bobFirst],
      'the filer through the feedback pin is notified');
    assert.deepEqual((await notificationsFor(hank, 'issue_thread_reply')).map((n) => n.chat_message_id), [bobFirst],
      'the filer through the bot requester row is notified');

    // carol posts, naming alice with @: alice gets only the mention row for
    // that message; bob gets the discussion row. The synthetic poster is
    // never a recipient, and the sender is never notified.
    const second = await post(carol, chan, 'Yes. @ta_alice look?', { thread: issueThread });
    assert.deepEqual((await notificationsFor(alice, 'issue_thread_reply')).map((n) => n.chat_message_id), [bobFirst],
      'a mention wins, never two rows for one message');
    assert.equal((await notificationsFor(alice, 'mention').then((rows) => rows.filter((n) => n.chat_message_id === second.message.id))).length, 1);
    assert.deepEqual((await notificationsFor(bob, 'issue_thread_reply')).map((n) => n.chat_message_id), [second.message.id]);
    assert.equal((await notificationsFor(carol, 'issue_thread_reply')).length, 0, 'the sender is never notified');
    assert.equal((await notificationsFor(frank, 'issue_thread_reply')).length, 0, 'a synthetic poster is not notified');

    // alice (the filer) posts: nobody is notified about it — she is the
    // sender, and she already has her mention row.
    await post(alice, chan, 'Thanks both.', { thread: issueThread });
    assert.deepEqual((await notificationsFor(alice, 'issue_thread_reply')).map((n) => n.chat_message_id), [bobFirst]);

    // An earlier poster whose only post is deleted steps out of the thread.
    const gone = await post(eve, chan, 'gone soon', { thread: issueThread });
    await pool.query('UPDATE chat_messages SET deleted_at = NOW() WHERE id = $1', [gone.message.id]);
    assert.equal((await notificationsFor(eve, 'issue_thread_reply')).length, 0);

    // A blocked pair: dave posts earlier, then blocks carol, so carol's
    // next post rings nobody for him — the row is checked both ways.
    const davesPost = await post(dave, chan, 'They are.', { thread: issueThread });
    assert.equal((await notificationsFor(eve, 'issue_thread_reply')).filter((n) => n.chat_message_id === davesPost.message.id).length, 0,
      'a deleted post leaves its author out');
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [dave.id, carol.id]);
    const third = await post(carol, chan, 'Agreed.', { thread: issueThread });
    assert.equal((await notificationsFor(dave, 'issue_thread_reply')).filter((n) => n.chat_message_id === third.message.id).length, 0,
      'a blocked pair is not notified about each other');
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_user_id = $2', [dave.id, carol.id]);

    // "Replies to you", switched off for this app, silences the kind.
    await pool.query(
      `INSERT INTO notification_preferences (user_id, app_id, category, enabled)
       VALUES ($1, $2, 'thread_replies', FALSE)`,
      [hank.id, chan.id]
    );
    const fourth = await post(carol, chan, 'More on channels.', { thread: issueThread });
    assert.equal((await notificationsFor(hank, 'issue_thread_reply')).filter((n) => n.chat_message_id === fourth.message.id).length, 0,
      'hank muted replies here');
    await pool.query('DELETE FROM notification_preferences WHERE user_id = $1 AND app_id = $2', [hank.id, chan.id]);

    // A request opened directly on GitHub has no filer on record: only its
    // earlier posters are notified.
    const ghThread = { type: 'issue', ref: 5000 };
    const ghFirst = await post(gina, chan, 'First here.', { thread: ghThread });
    const ghSecond = await post(bob, chan, 'Second here.', { thread: ghThread });
    assert.equal((await notificationsFor(gina, 'issue_thread_reply')).filter((n) => n.chat_message_id === ghSecond.message.id).length, 1,
      'an earlier poster on a GitHub-filed request is still notified');
    for (const who of [alice, hank]) {
      assert.equal((await notificationsFor(who, 'issue_thread_reply')).filter((n) => n.chat_message_id === ghSecond.message.id).length, 0,
        'no filer row exists, so the filer is not notified');
    }

    // Push: the kind is in the closed registry, so the outbox trigger runs.
    const { rows: policy } = await pool.query(
      `SELECT category, default_enabled FROM mobile_push_kind_categories WHERE kind = 'issue_thread_reply'`
    );
    assert.deepEqual(policy, [{ category: 'direct_interactions', default_enabled: true }]);

    // Posting anywhere in the project clears the rows, the same way it
    // clears mentions and replies.
    await post(alice, chan, 'Reading the discussion.');
    assert.equal((await notificationsFor(alice, 'issue_thread_reply')).filter((n) => !n.read_at).length, 0);
  });

  await t.test('a viewer who blocked a replier gets their own thread summary', async () => {
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [alice.id, dave.id]);
    frames.length = 0;
    await post(bob, chan, 'Blue still.', { thread: { type: 'message', ref: rootId } });
    const [summary] = roomFrames('thread_summary');
    assert.ok(summary.data.thread.participants.some((p) => p.id === dave.id), 'everybody else sees dave');
    const mine = summary.routing.threadByViewer[alice.id];
    assert.ok(mine, 'alice gets a variant');
    assert.ok(!mine.participants.some((p) => p.id === dave.id), 'without the person she blocked');
    assert.equal(mine.reply_count, summary.data.thread.reply_count - 1);
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1', [alice.id]);
  });

  // ── Soft delete ──────────────────────────────────────────────────────

  await t.test('deleting your own message clears it and everything hanging off it, in one go', async () => {
    const target = (await post(bob, chan, 'Oops, wrong channel @ta_alice')).message.id;
    await pool.query(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, '👍')`, [target, alice.id]);
    await pool.query('INSERT INTO message_bookmarks (user_id, message_id) VALUES ($1, $2)', [alice.id, target]);
    await pool.query(
      `INSERT INTO chat_message_attachments (id, app_id, user_id, kind, filename, content_type, size_bytes, data, message_id)
       VALUES ($1, $2, $3, 'text', 'a.txt', 'text/plain', 1, 'x', $4)`,
      ['f'.repeat(32), chan.id, bob.id, target]
    );
    await pool.query(
      `UPDATE chat_messages SET metadata = '{"attachments":[{"id":"ffff"}],"quote":{"refMsgId":1,"snippet":"s"}}' WHERE id = $1`,
      [target]
    );
    assert.equal((await notificationsFor(alice, 'mention')).filter((n) => n.chat_message_id === target).length, 1);

    const denied = await call('DELETE', `/api/apps/ta-chan/messages/${target}`, alice);
    assert.equal(denied.status, 403, 'author only');
    assert.deepEqual(denied.body, { error: 'not_author' });
    const sys = await system(chan, 'a system line');
    assert.equal((await call('DELETE', `/api/apps/ta-chan/messages/${sys}`, alice)).status, 403,
      'a system line is nobody\'s to take back');
    assert.equal((await call('DELETE', `/api/apps/ta-other/messages/${target}`, bob)).status, 404,
      'the message must be in the named app');

    frames.length = 0;
    const done = await call('DELETE', `/api/apps/ta-chan/messages/${target}`, bob);
    assert.equal(done.status, 200);
    assert.deepEqual(done.body, { ok: true, id: target, thread_type: null, thread_ref: null, deleted: true });
    const [frame] = roomFrames('chat_delete');
    assert.deepEqual(frame.data, { type: 'chat_delete', id: target, thread_type: null, thread_ref: null });
    assert.ok(frames.some((f) => f.kind === 'user' && f.routing.userId === alice.id
      && f.data.type === 'notifications_changed'), 'alice\'s bell re-syncs');

    const { rows: [row] } = await pool.query('SELECT * FROM chat_messages WHERE id = $1', [target]);
    assert.ok(row.deleted_at);
    assert.equal(row.content, '', 'the text is gone from the row, not merely hidden');
    assert.deepEqual(row.metadata, {});
    const count = async (sql) => Number((await pool.query(sql, [target])).rows[0].n);
    assert.equal(await count('SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = $1'), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM message_bookmarks WHERE message_id = $1'), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM chat_message_attachments WHERE message_id = $1'), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM notifications WHERE chat_message_id = $1'), 0);

    // Idempotent, and quiet the second time.
    frames.length = 0;
    const again = await call('DELETE', `/api/apps/ta-chan/messages/${target}`, bob);
    assert.equal(again.status, 200);
    assert.equal(roomFrames('chat_delete').length, 0);

    // Edit, react and save are refused on what is left.
    const edit = await ws.handleMessage(pool, client(bob, chan), { type: 'edit', messageId: target, content: 'resurrect' });
    assert.deepEqual(edit, { ok: false, code: 'message_deleted' });
    await ws.handleMessage(pool, client(alice, chan), { type: 'react', messageId: target, emoji: '🎉' });
    assert.equal(await count('SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = $1'), 0);
    const save = await call('PUT', `/api/apps/ta-chan/messages/${target}/bookmark`, alice);
    assert.equal(save.status, 409);
    assert.deepEqual(save.body, { error: 'message_deleted' });
    assert.equal((await call('DELETE', `/api/apps/ta-chan/messages/${target}/bookmark`, alice)).status, 200,
      'unsaving stays harmless');

    // Read back as a placeholder.
    const general = await call('GET', `/api/apps/ta-chan/messages?around=${target}`, alice);
    const placeholder = general.body.messages.find((m) => m.id === target);
    assert.equal(placeholder.deleted, true);
    assert.equal(placeholder.content, '');
    assert.deepEqual(placeholder.metadata, {});
    assert.deepEqual(placeholder.reactions, []);
    assert.equal(placeholder.bookmarked, false);
    assert.equal(placeholder.username, 'ta_bob', 'the sender is kept');
    assert.equal(placeholder.edited_at, null);

    // A quote of it keeps who said it and loses what; a new quote of it is
    // dropped rather than sent.
    const { rows: [quoting] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, metadata)
       VALUES ($1, $2, 'replying', $3) RETURNING id`,
      [chan.id, carol.id, JSON.stringify({ quote: { source: 'message', refMsgId: target, author: 'ta_bob', snippet: 'Oops' } })]
    );
    const withQuote = (await call('GET', `/api/apps/ta-chan/messages?around=${quoting.id}`, alice))
      .body.messages.find((m) => m.id === quoting.id);
    assert.deepEqual(withQuote.metadata.quote,
      { source: 'message', refMsgId: target, author: 'ta_bob', snippet: '', deleted: true });
    const fresh = await post(carol, chan, 'quoting a ghost', { quote: { source: 'message', refMsgId: target } });
    assert.equal(fresh.message.metadata, undefined, 'sent as a plain message');
  });

  await t.test('deleting a thread reply over the socket updates the thread for the room', async () => {
    const reply = (await post(carol, chan, 'Never mind.', { thread: { type: 'message', ref: rootId } })).message.id;
    const before = (await appChat.threadSummaries(pool, chan.id, [rootId])).get(rootId).reply_count;
    frames.length = 0;
    const result = await ws.handleMessage(pool, client(carol, chan), { type: 'delete', id: reply });
    assert.equal(result.ok, true);
    const [frame] = roomFrames('chat_delete');
    assert.deepEqual(frame.data, { type: 'chat_delete', id: reply, thread_type: 'message', thread_ref: rootId });
    const [summary] = roomFrames('thread_summary');
    assert.equal(summary.data.thread.reply_count, before - 1, 'a deleted reply is not counted');
    // The deleted reply is still a placeholder inside the thread.
    const thread = await call('GET', `/api/apps/ta-chan/messages?thread_type=message&thread_ref=${rootId}`, alice);
    assert.equal(thread.body.messages.find((m) => m.id === reply).deleted, true);

    // A deleted ROOT keeps its thread.
    await ws.handleMessage(pool, client(alice, chan), { type: 'delete', id: rootId });
    const again = await call('GET', `/api/apps/ta-chan/messages?thread_type=message&thread_ref=${rootId}`, bob);
    assert.equal(again.status, 200);
    assert.equal(again.body.root.deleted, true);
    assert.ok(again.body.root.thread.reply_count > 0);
  });

  // ── Paging ───────────────────────────────────────────────────────────

  await t.test('before / after / around page the stream and say whether there is more', async () => {
    const pager = await makeApp('ta-pager', { owner: alice, name: 'Pager' });
    await member(pager, alice);
    const ids = [];
    for (let i = 1; i <= 9; i += 1) ids.push((await post(alice, pager, `m${i}`)).message.id);
    const threadRoot = ids[4];
    const reply = (await post(bob, pager, 'in the thread', { thread: { type: 'message', ref: threadRoot } })).message.id;
    const { rows: [issueRow] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref)
       VALUES ($1, $2, 'on an issue', 'issue', 42) RETURNING id`, [pager.id, alice.id]
    );
    const get = async (qs) => (await call('GET', `/api/apps/ta-pager/messages?${qs}`, alice)).body;
    const idsOf = (page) => page.messages.map((m) => m.id);

    // #2387 follow-up: the reply is part of the general stream now, the
    // newest row of it; the issue's message still is not.
    const latest = await get('limit=3');
    assert.deepEqual(idsOf(latest), [...ids.slice(7), reply]);
    assert.equal(latest.has_more_before, true);
    assert.equal(latest.has_more_after, false);

    const older = await get(`limit=3&before=${ids[6]}`);
    assert.deepEqual(idsOf(older), ids.slice(3, 6));
    assert.equal(older.has_more_before, true);
    assert.equal(older.has_more_after, true);

    const oldest = await get(`limit=5&before=${ids[3]}`);
    assert.deepEqual(idsOf(oldest), ids.slice(0, 3));
    assert.equal(oldest.has_more_before, false);

    const catchUp = await get(`limit=3&after=${ids[2]}`);
    assert.deepEqual(idsOf(catchUp), ids.slice(3, 6), 'ascending, ids above the cursor');
    assert.equal(catchUp.has_more_before, true);
    assert.equal(catchUp.has_more_after, true);
    const caughtUp = await get(`limit=5&after=${ids[6]}`);
    assert.deepEqual(idsOf(caughtUp), [...ids.slice(7), reply]);
    assert.equal(caughtUp.has_more_after, false);

    const window = await get(`limit=5&around=${ids[4]}`);
    assert.deepEqual(idsOf(window), ids.slice(2, 7), 'two before, the target, two after');
    assert.deepEqual(window.focus, { message_id: ids[4], thread_ref: null });
    assert.equal(window.has_more_before, true);
    assert.equal(window.has_more_after, true);
    const edge = await get(`limit=5&around=${ids[0]}`);
    assert.equal(edge.messages[0].id, ids[0]);
    assert.equal(edge.has_more_before, false);

    // A permalink to a reply opens the general stream around its root.
    const toReply = await get(`limit=3&around=${reply}`);
    assert.ok(idsOf(toReply).includes(threadRoot));
    assert.ok(!idsOf(toReply).includes(reply));
    assert.deepEqual(toReply.focus, { message_id: reply, thread_ref: threadRoot });
    // ...and inside the thread, around itself.
    const inThread = await get(`thread_type=message&thread_ref=${threadRoot}&around=${reply}`);
    assert.deepEqual(inThread.focus, { message_id: reply, thread_ref: threadRoot });
    assert.equal(inThread.root.id, threadRoot);

    // A topic-thread message is not in the general stream.
    assert.equal((await call('GET', `/api/apps/ta-pager/messages?around=${issueRow.id}`, alice)).status, 404);
    assert.equal((await call('GET', `/api/apps/ta-pager/messages?around=${ids[0]}&thread_type=issue&thread_ref=42`, alice)).status, 404);
    // A blocked author's message is not visible to around.
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [carol.id, alice.id]);
    assert.equal((await call('GET', `/api/apps/ta-pager/messages?around=${ids[1]}`, carol)).status, 404);
    // #2387 follow-up: nor is a reply under that author's root — a line
    // naming a message the viewer cannot see, in a thread they cannot open.
    const carolView = await call('GET', '/api/apps/ta-pager/messages?limit=50', carol);
    assert.ok(!idsOf(carolView.body).includes(reply), 'no line for a reply under a blocked author\'s root');
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1', [carol.id]);
    // A deleted reply leaves no line in the general stream (its thread keeps
    // the placeholder).
    await pool.query('UPDATE chat_messages SET deleted_at = NOW() WHERE id = $1', [reply]);
    assert.ok(!idsOf(await get('limit=50')).includes(reply), 'a deleted reply leaves no line');
    await pool.query('UPDATE chat_messages SET deleted_at = NULL WHERE id = $1', [reply]);

    for (const qs of [`before=${ids[1]}&after=${ids[0]}`, 'before=abc', 'around=0', 'after=1e3']) {
      assert.equal((await call('GET', `/api/apps/ta-pager/messages?${qs}`, alice)).status, 400, qs);
    }
  });

  // ── The read cursor ──────────────────────────────────────────────────

  await t.test('the read cursor: lazily zero, forward-only read, back-only unread', async () => {
    const reads = await makeApp('ta-reads', { owner: alice, name: 'Reads' });
    await member(reads, alice);
    await member(reads, bob);
    const early = (await post(bob, reads, 'before the cursor existed')).message.id;
    const list = async (who) => (await call('GET', '/api/messages/app-discussions', who)).body.discussions;
    const row = async (who) => (await list(who)).find((d) => d.slug === 'ta-reads');

    assert.equal((await row(alice)).unreadCount, 0, 'a first look starts at zero');
    const { rows: [cursor] } = await pool.query(
      'SELECT last_read_message_id FROM app_chat_reads WHERE app_id = $1 AND user_id = $2', [reads.id, alice.id]
    );
    assert.equal(cursor.last_read_message_id, early, 'seeded at the newest general-stream message');

    const m1 = (await post(bob, reads, 'one')).message.id;
    const m2 = (await post(bob, reads, 'two')).message.id;
    const m3 = (await post(bob, reads, 'three')).message.id;
    await system(reads, 'a system line is not unread');
    await post(bob, reads, 'a thread reply is not in the general stream', { thread: { type: 'message', ref: m1 } });
    const gone = (await post(bob, reads, 'deleted')).message.id;
    await ws.handleMessage(pool, client(bob, reads), { type: 'delete', id: gone });
    assert.equal((await row(alice)).unreadCount, 3);
    assert.equal(await appChat.unreadCount(pool, reads.id, alice.id), 3, 'the service and the list agree');
    // The stream's first page says where reading stands, so the channel can
    // open at its first unread (public/js/group-chat.js _takeUnreadMark); an
    // earlier page and a thread are no opening and say nothing.
    const opening = await call('GET', '/api/apps/ta-reads/messages?limit=50', alice);
    assert.deepEqual(opening.body.read, { last_read_message_id: early, unread_count: 3 });
    assert.equal((await call('GET', `/api/apps/ta-reads/messages?limit=50&before=${m3}`, alice)).body.read, undefined);
    assert.equal((await call('GET', `/api/apps/ta-reads/messages?thread_type=message&thread_ref=${m1}`, alice)).body.read, undefined);

    const read = await call('POST', '/api/apps/ta-reads/messages/read', alice, { message_id: m2 });
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, { unread_count: 1 });
    const back = await call('POST', '/api/apps/ta-reads/messages/read', alice, { message_id: m1 });
    assert.deepEqual(back.body, { unread_count: 1 }, 'read never moves back');

    const unread = await call('POST', '/api/apps/ta-reads/messages/unread', alice, { message_id: m1 });
    assert.deepEqual(unread.body, { unread_count: 3 }, 'm1 and everything after it');
    const forward = await call('POST', '/api/apps/ta-reads/messages/unread', alice, { message_id: m3 });
    assert.deepEqual(forward.body, { unread_count: 3 }, 'unread never moves forward');

    // Blocked authors are not unread for the blocker.
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [alice.id, bob.id]);
    assert.equal(await appChat.unreadCount(pool, reads.id, alice.id), 0);
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1', [alice.id]);

    // Only this app's general stream can move it.
    const replyId = (await pool.query(
      `SELECT id FROM chat_messages WHERE app_id = $1 AND thread_type = 'message' LIMIT 1`, [reads.id]
    )).rows[0].id;
    assert.equal((await call('POST', '/api/apps/ta-reads/messages/read', alice, { message_id: replyId })).status, 404);
    assert.equal((await call('POST', '/api/apps/ta-other/messages/read', alice, { message_id: m3 })).status, 404);
    assert.equal((await call('POST', '/api/apps/ta-reads/messages/read', alice, { message_id: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/apps/ta-reads/messages/read', alice, {})).status, 400);

    // Posting in the general stream is reading it.
    await post(alice, reads, 'caught up');
    assert.equal((await row(alice)).unreadCount, 0);
  });

  // ── The Messages list: yours and more (#2967) ───────────────────────

  await t.test('yours is Home.isYours, more is activity, and nothing the viewer cannot open', async () => {
    const vic = await user('ta_vic');
    const owner = await user('ta_owner');
    const mk = (slug, opts = {}) => makeApp(slug, { owner, name: slug, ...opts });
    const memberApp = await mk('ta-s-member');
    const hiddenApp = await mk('ta-s-hidden');
    const favApp = await mk('ta-s-fav');
    const votedApp = await mk('ta-s-voted');
    const decidedApp = await mk('ta-s-decided');
    const proposedApp = await mk('ta-s-proposed');
    const filedApp = await mk('ta-s-filed');
    const postedApp = await mk('ta-s-posted');
    const reactedApp = await mk('ta-s-reacted');
    const untouched = await mk('ta-s-untouched');
    const privatePosted = await mk('ta-s-private-posted', { view: 'private', collab: 'private' });
    const privateFav = await mk('ta-s-private-fav', { view: 'private', collab: 'private' });
    const privateMember = await mk('ta-s-private-member', { view: 'private', collab: 'private' });
    const selfHosted = await mk('ta-s-self', { selfHosted: true });
    const headless = await mk('ta-s-headless');

    await member(memberApp, vic);
    await member(hiddenApp, vic);
    await member(privateMember, vic);
    await member(selfHosted, vic);
    await pool.query(
      `INSERT INTO app_favorites (app_id, user_id, hidden) VALUES ($1, $3, TRUE), ($2, $3, FALSE), ($4, $3, FALSE)`,
      [hiddenApp.id, favApp.id, vic.id, privateFav.id]
    );
    const session = async (app, who, extra = '') => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status${extra ? ', is_headless, promoted_at' : ''})
       VALUES ($1, $2, 'promoted'${extra ? ', TRUE, NOW()' : ''}) RETURNING id`, [app.id, who.id]
    )).rows[0].id;
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`,
      [await session(votedApp, owner), vic.id]);
    const { rows: [issue] } = await pool.query(
      `INSERT INTO issues (app_id, title, created_by, kind) VALUES ($1, 'rename', $2, 'rename') RETURNING id`,
      [decidedApp.id, owner.id]
    );
    await pool.query(`INSERT INTO issue_votes (issue_id, user_id, vote) VALUES ($1, $2, 'yes')`, [issue.id, vic.id]);
    await session(proposedApp, vic);
    await session(headless, vic, 'headless');
    await pool.query(`INSERT INTO issues (app_id, title, created_by) VALUES ($1, 'please add dark mode', $2)`,
      [filedApp.id, vic.id]);
    await post(vic, postedApp, 'hello from outside');
    // Written straight to the table: vic posted while the app was public, and
    // it has gone private since (the write gate would refuse a post now).
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, 'I was here before it went private')`,
      [privatePosted.id, vic.id]
    );
    const theirs = (await post(owner, reactedApp, 'react to me')).message.id;
    await pool.query(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, '👍')`, [theirs, vic.id]);
    // A later message in the member app, so the order inside yours is by
    // latest activity.
    await post(owner, memberApp, 'newest in a member app');

    const { status, body } = await call('GET', '/api/messages/app-discussions', vic);
    assert.equal(status, 200);
    const bySlug = Object.fromEntries(body.discussions.map((d) => [d.slug, d]));
    const sectionOf = (app) => bySlug[app.slug]?.section;
    assert.equal(sectionOf(memberApp), 'yours');
    assert.equal(sectionOf(favApp), 'yours', 'a favorited non-member app is yours');
    assert.equal(sectionOf(privateMember), 'yours', 'membership opens a private app');
    assert.equal(sectionOf(hiddenApp), 'more', 'a member app hidden from Your apps is more');
    for (const app of [votedApp, decidedApp, proposedApp, filedApp, postedApp, reactedApp]) {
      assert.equal(sectionOf(app), 'more', app.slug);
    }
    for (const app of [untouched, privatePosted, privateFav, selfHosted, headless]) {
      assert.equal(bySlug[app.slug], undefined, `${app.slug} is not listed`);
    }
    const sections = body.discussions.map((d) => d.section);
    assert.deepEqual(sections, [...sections].sort((a, b) => (a === b ? 0 : a === 'yours' ? -1 : 1)),
      'yours first, then more');
    assert.equal(body.discussions[0].slug, memberApp.slug, 'latest activity leads yours');
    const handles = body.discussions.map((d) => d.channel);
    assert.equal(new Set(handles).size, handles.length, 'handles are unique across both sections');
    for (const d of body.discussions) assert.equal(typeof d.unreadCount, 'number');

    // The platform admin sees the self-hosted app they are a member of.
    const root = await user('ta_root', { isAdmin: true });
    await member(selfHosted, root);
    const adminList = (await call('GET', '/api/messages/app-discussions', root)).body.discussions;
    assert.ok(adminList.some((d) => d.slug === selfHosted.slug));
  });

  await t.test('a deleted message cannot be reported', async () => {
    const { moderationRoutes } = require('../src/routes/moderation');
    const live = (await post(bob, chan, 'still here')).message.id;
    const { rows: [gone] } = await pool.query(
      `SELECT id FROM chat_messages WHERE app_id = $1 AND deleted_at IS NOT NULL AND user_id = $2 LIMIT 1`,
      [chan.id, bob.id]
    );
    const reportApp = express();
    reportApp.use(express.json());
    reportApp.use((req, _res, next) => { req.user = users[carol.id]; next(); });
    reportApp.use(moderationRoutes({}, { pool }));
    const reportServer = await new Promise((resolve) => {
      const listening = reportApp.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const report = (id) => fetch(
      `http://127.0.0.1:${reportServer.address().port}/api/apps/ta-chan/messages/${id}/report`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'spam' }) }
    );
    try {
      assert.equal((await report(live)).status, 202, 'a live message can be');
      assert.equal((await report(gone.id)).status, 404);
    } finally {
      await new Promise((resolve) => reportServer.close(resolve));
    }
  });
});
