'use strict';

// B9: mention Homeroom bot in a project's group chat.
//
// "@Homeroom bot could it remind us on Sundays?" in a project's chat files a
// request in its writer's words (after a quick read says it asks for a
// change), and the bot writes nothing into the chat: everybody sees the
// message's status chip, and its writer alone a card under it. A question is
// pointed at the bot's own chat; an unclear one asks first. "Make this a
// request" does the same without the read. Only a person's own message, in
// the main stream, and never a connector's. Names starting with "homeroom"
// are taken, and nobody gets a notification for mentioning the bot.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-chat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const botChat = require('../src/services/homeroom-bot-chat');

test('B9: what counts as asking the bot, and what was asked', () => {
  for (const text of ['@Homeroom bot could it remind us?', 'hey @homeroom_bot, add tags', '@HOMEROOM  BOT hi']) {
    assert.equal(botChat.mentionsBot(text), true, text);
  }
  for (const text of ['@Homeroom could it', 'mail a@homeroom_bot', '@homeroom_botty', 'no mention']) {
    assert.equal(botChat.mentionsBot(text), false, text);
  }
  assert.equal(botChat.askedWords('@Homeroom bot could it remind us on Sundays?'), 'could it remind us on Sundays?');
  assert.equal(botChat.askedWords('hey @homeroom_bot, add tags'), 'hey add tags');
  assert.equal(botChat.fallbackTitle('could it remind us on Sundays? thanks'), 'Could it remind us on Sundays');
  assert.equal(botChat.fallbackTitle(''), 'A request from the chat');
});

test('B9 (E8): names starting with homeroom are taken; the bot is never notified', () => {
  const usernames = require('../src/services/usernames');
  for (const name of ['homeroom', 'homeroom_fan', 'HomeroomBot', 'home_room']) {
    assert.equal(usernames.validateUsername(name).ok, false, name);
  }
  assert.equal(usernames.validateUsername('homer').ok, true);
  assert.match(read('src/services/notifications.js'), /'SELECT id FROM users WHERE id = ANY\(\$1::int\[\]\) AND is_synthetic = FALSE'/);
});

test('B9: the room hands a mention over after it is stored, and only from the main stream', () => {
  const ws = read('src/services/ws.js');
  assert.match(ws, /if \(!thread\) \{\s*void require\('\.\/homeroom-bot-chat'\)\.noteChatMessage\(pool, null, \{\s*appId: client\.appId, userId: client\.user\.id, messageId: rows\[0\]\.id, content, thread, postedVia,/);
  assert.ok(ws.indexOf("noteChatMessage(pool, null") > ws.indexOf('await broadcastFromSender(pool, client.appId, outMsg, client.user.id);'), 'after the room has it');
  const chat = read('src/routes/chat.js');
  assert.match(chat, /router\.post\('\/api\/apps\/:slug\/messages\/:id\/request', groupChatWriteLimiter, sameOriginBrowserOnly,\s*communities\.requireAppMembership\(pool\),/);
  assert.match(chat, /router\.get\('\/api\/apps\/:slug\/my-bot-requests', appChatReadLimiter,/);
  const policy = require('../src/services/cli-api-policy');
  assert.equal(policy.isConnectorApiRequest('POST', '/api/apps/x/messages/5/request'), false, 'a person\'s own browser only');
});

test('B9: the chip and the card', () => {
  const { BotStatusChip, BotRequestCardView, cardWords } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  const chip = (status, extra = {}) => renderToHtml(createElement(BotStatusChip, { chip: { status, issueNumber: 4, sessionId: null, ...extra } }));
  assert.match(chip('reading'), /data-bot-request="reading"[^>]*>.*👀.*Reading/);
  assert.match(chip('building'), /🔨.*Building/);
  assert.match(chip('live'), /✅.*Live/);
  assert.match(chip('ready', { sessionId: 9 }), /<button[^>]*data-bot-request="ready"[^>]*>.*Try it/);
  assert.ok(!/<button/.test(chip('reading')), 'nobody but its asker taps Reading');
  assert.match(renderToHtml(createElement(BotStatusChip, { chip: { status: 'building', issueNumber: 4, sessionId: null }, mine: true })), /<button/);
  assert.equal(cardWords({ kind: 'filed', title: 'Add a Sunday reminder', typicalMinutes: 8 }), 'Got it: Add a Sunday reminder. Usually about 8 minutes.');
  assert.equal(cardWords({ kind: 'group', title: 'Add tags' }), 'Filed as a request for the group: Add tags.');
  assert.equal(cardWords({ kind: 'question' }), 'I answer questions in our chat.');
  const unsure = renderToHtml(createElement(BotRequestCardView, { card: { messageId: 5, kind: 'unsure', title: 'Add tags', issueNumber: null } }));
  assert.match(unsure, /Only you can see this/);
  assert.match(unsure, /data-bot-request-action="file"><span>File it/);
  assert.match(unsure, /data-bot-request-action="not-now"><span>Not now/);
  const filed = renderToHtml(createElement(BotRequestCardView, { card: { messageId: 5, kind: 'filed', title: 'Add tags', issueNumber: 3 } }));
  assert.match(filed, /data-bot-request-action="progress"><span>See progress/);
  const row = read('frontend/src/features/group-chat/transcript.tsx');
  assert.match(row, /\{msg\.mine && msg\.botCard \? \(\s*<BotRequestCardView/);
  assert.match(row, /if \(surface === 'main' && msg\.canAskBot\) \{\s*items\.push\(\{ key: 'ask-bot', label: 'Make this a request'/);
  const gc = read('public/js/group-chat.js');
  assert.match(gc, /const insert = `@\$\{username === MentionAutocomplete\.BOT \? MentionAutocomplete\.BOT_NAME : username\} `;/);
  assert.match(gc, /@\(\[A-Za-z0-9_\]\{1,32\}\(\?:\(\?<=homeroom\) bot\\b\)\?\)/, '"@Homeroom bot" is one mention');
  assert.match(read('public/js/app.js'), /case 'bot_request_card':\s*\/\/[^\n]*\n[^\n]*\n\s*window\.GroupChat\?\.applyBotRequestCard\?\.\(data\);/);
});

test('B9: asking from the chat, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_chat_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  await user('homeroom_bot', true);
  const ben = await user('ben');
  const ada = await user('ada');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
     VALUES ('Supper Club', 'supper-club', 'running', $1, 'private', 'private', 'https://github.com/example/supper-club')
     RETURNING id`,
    [ben.id],
  );
  const app = (await pool.query('SELECT id, slug, name, repo_url, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  for (const person of [ben, ada]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, person.id]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, person.id]);
  }
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_dm_users', JSON.stringify(['ben']));
  await set('homeroom_bot_mode', 'live');
  await set('homeroom_bot_live_apps', JSON.stringify(['supper-club']));

  let nextIssue = 40;
  const created = [];
  const frames = [];
  const pushed = [];
  const deps = (read) => ({
    readAsk: async () => read,
    github: {
      isEnabled: () => true,
      safeMention: (s) => s,
      createIssue: async (owner, repo, issue) => { created.push(issue); nextIssue += 1; return { number: nextIssue }; },
    },
    ws: {
      broadcast: (appId, frame) => frames.push(frame),
      pushToUser: (userId, frame) => pushed.push({ userId, frame }),
      sendSystemMessage: async () => {},
      pushIssueUpdate: () => {},
    },
    notifications: { createIssueOpenedNotifications: async () => [] },
  });
  const say = async (who, content, extra = {}) => (await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, posted_via)
     VALUES ($1, $2, $3, 'message', '{}', $4, $5, $6) RETURNING id`,
    [app.id, who.id, content, extra.thread ? 'issue' : null, extra.thread || null, extra.postedVia || null],
  )).rows[0].id;
  const metaOf = async (id) => (await pool.query('SELECT metadata FROM chat_messages WHERE id = $1', [id])).rows[0].metadata;

  await t.test('a change is filed in his words, the room sees its chip, and only he gets the card', async () => {
    const id = await say(ben, '@Homeroom bot could it remind us on Sundays to pick who hosts?');
    const out = await botChat.noteChatMessage(pool, null, {
      appId: app.id, userId: ben.id, messageId: id, content: '@Homeroom bot could it remind us on Sundays to pick who hosts?',
      deps: deps({ kind: 'change', title: 'Add a Sunday host reminder' }),
    });
    assert.equal(out.ok, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'Add a Sunday host reminder');
    assert.match(created[0].body, /^could it remind us on Sundays to pick who hosts\?\n\n---\nAsked in Supper Club's chat by @ben\.$/);
    const { rows: [req] } = await pool.query('SELECT * FROM chat_bot_requests WHERE chat_message_id = $1', [id]);
    assert.deepEqual([req.kind, req.issue_number, req.requester_id], ['filed', 41, ben.id]);
    const { rows: [asked] } = await pool.query('SELECT user_id, asked_text FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = 41', [app.id]);
    assert.deepEqual(asked, { user_id: ben.id, asked_text: 'could it remind us on Sundays to pick who hosts?' });
    assert.deepEqual((await metaOf(id)).botRequest, { issueNumber: 41, status: 'reading' });
    assert.deepEqual(frames.at(-1), { type: 'bot_request_status', messageId: id, botRequest: { issueNumber: 41, status: 'reading' } });
    const card = pushed.at(-1);
    assert.equal(card.userId, ben.id, 'his alone');
    assert.deepEqual([card.frame.type, card.frame.card.kind, card.frame.card.title], ['bot_request_card', 'filed', 'Add a Sunday host reminder']);
    const { rows: room } = await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE app_id = $1 AND thread_type IS NULL', [app.id]);
    assert.equal(room[0].n, 1, 'the bot wrote nothing into the room');
    // Asked again (a retry, an edit): nothing more is filed.
    await botChat.noteChatMessage(pool, null, { appId: app.id, userId: ben.id, messageId: id, content: '@homeroom_bot again', deps: deps({ kind: 'change', title: 'x' }) });
    assert.equal(created.length, 1);
    // Its moments move the chip; stopping takes it away.
    await botChat.noteRequestStatus(pool, { appId: app.id, issueNumber: 41, status: 'building', deps: deps(null) });
    assert.equal((await metaOf(id)).botRequest.status, 'building');
    await botChat.noteRequestStatus(pool, { appId: app.id, issueNumber: 41, status: 'ready', sessionId: 9, deps: deps(null) });
    assert.deepEqual((await metaOf(id)).botRequest, { issueNumber: 41, status: 'ready', sessionId: 9 });
    await botChat.noteRequestStatus(pool, { appId: app.id, issueNumber: 41, status: 'stopped', deps: deps(null) });
    assert.equal((await metaOf(id)).botRequest, undefined);
    // His cards come back after a reload; Ada sees none of them.
    const mine = await botChat.myRequests(pool, { app, user: { id: ben.id, username: 'ben', hasPlatformAccess: true } });
    assert.deepEqual([mine.bot, mine.builds, mine.cards.length, mine.cards[0].messageId], [true, true, 1, id]);
    const hers = await botChat.myRequests(pool, { app, user: { id: ada.id, username: 'ada', hasPlatformAccess: true } });
    assert.deepEqual([hers.bot, hers.cards.length], [false, 0]);
  });

  await t.test('a question goes to its chat, an unclear one asks first, and File it files it', async () => {
    const q = await say(ben, '@Homeroom bot what can you build?');
    await botChat.noteChatMessage(pool, null, { appId: app.id, userId: ben.id, messageId: q, content: '@Homeroom bot what can you build?', deps: deps({ kind: 'question', title: null }) });
    assert.equal(pushed.at(-1).frame.card.kind, 'question');
    const maybe = await say(ben, '@Homeroom bot the list feels long');
    await botChat.noteChatMessage(pool, null, { appId: app.id, userId: ben.id, messageId: maybe, content: '@Homeroom bot the list feels long', deps: deps({ kind: 'unsure', title: null }) });
    assert.deepEqual([pushed.at(-1).frame.card.kind, pushed.at(-1).frame.card.title], ['unsure', 'The list feels long']);
    assert.equal(created.length, 1, 'nothing filed until he says so');
    assert.equal((await metaOf(maybe)).botRequest, undefined, 'no chip while it waits on him');
    const filed = await botChat.requestFromMessage(pool, null, {
      app, user: { id: ben.id, username: 'ben', hasPlatformAccess: true }, messageId: maybe, deps: deps(null),
    });
    assert.equal(filed.ok, true);
    assert.equal(filed.card.kind, 'filed');
    assert.equal(created.length, 2);
    const notNow = await say(ben, '@Homeroom bot hmm');
    await botChat.noteChatMessage(pool, null, { appId: app.id, userId: ben.id, messageId: notNow, content: '@Homeroom bot hmm', deps: deps({ kind: 'unsure', title: null }) });
    await botChat.requestFromMessage(pool, null, { app, user: { id: ben.id, username: 'ben' }, messageId: notNow, dismiss: true, deps: deps(null) });
    const { rows: [gone] } = await pool.query('SELECT kind FROM chat_bot_requests WHERE chat_message_id = $1', [notNow]);
    assert.equal(gone.kind, 'dismissed');
  });

  await t.test('only a person\'s own message in the main stream, and never somebody the bot does not answer', async () => {
    const before = created.length;
    const thread = await say(ben, '@Homeroom bot in a thread', { thread: 41 });
    assert.equal(await botChat.noteChatMessage(pool, null, { appId: app.id, userId: ben.id, messageId: thread, content: '@Homeroom bot in a thread', thread: { type: 'issue', ref: 41 }, deps: deps({ kind: 'change', title: 'x' }) }), null);
    const agent = await say(ben, '@Homeroom bot from an agent', { postedVia: 'agent' });
    assert.equal(await botChat.noteChatMessage(pool, null, { appId: app.id, userId: ben.id, messageId: agent, content: '@Homeroom bot from an agent', postedVia: 'agent', deps: deps({ kind: 'change', title: 'x' }) }), null);
    const hers = await say(ada, '@Homeroom bot add tags');
    const refused = await botChat.noteChatMessage(pool, null, { appId: app.id, userId: ada.id, messageId: hers, content: '@Homeroom bot add tags', deps: deps({ kind: 'change', title: 'x' }) });
    assert.equal(refused.ok, false, 'the bot is not on for her yet');
    const notHis = await botChat.requestFromMessage(pool, null, { app, user: { id: ben.id, username: 'ben', hasPlatformAccess: true }, messageId: hers, deps: deps(null) });
    assert.equal(notHis.status, 403, 'only your own message');
    assert.equal(created.length, before);
  });

  await t.test('ten filings an hour from chats, then it says so', async () => {
    await pool.query(
      `INSERT INTO chat_bot_requests (chat_message_id, app_id, requester_id, kind, issue_number)
       SELECT id, $1, $2, 'filed', 900 + id FROM chat_messages WHERE app_id = $1 AND user_id = $2 AND id NOT IN (SELECT chat_message_id FROM chat_bot_requests)`,
      [app.id, ben.id],
    );
    for (let i = 0; i < 10; i += 1) {
      const id = await say(ben, `filler ${i}`);
      await pool.query(`INSERT INTO chat_bot_requests (chat_message_id, app_id, requester_id, kind, issue_number) VALUES ($1, $2, $3, 'filed', $4)`, [id, app.id, ben.id, 1000 + i]);
    }
    const id = await say(ben, '@Homeroom bot one more');
    const out = await botChat.noteChatMessage(pool, null, { appId: app.id, userId: ben.id, messageId: id, content: '@Homeroom bot one more', deps: deps({ kind: 'change', title: 'x' }) });
    assert.deepEqual([out.ok, out.code, out.card.kind], [false, 'busy', 'busy']);
  });

  await t.test('mentioning the bot notifies nobody', async () => {
    const notifications = require('../src/services/notifications');
    const id = await say(ben, '@homeroom_bot and @ada');
    const rows = await notifications.createMentionNotifications(pool, { appId: app.id, chatMessageId: id, senderId: ben.id, content: '@homeroom_bot and @ada' });
    assert.deepEqual(rows.map((r) => r.user_id), [ada.id]);
  });
});
