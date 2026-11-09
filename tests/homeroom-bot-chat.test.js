'use strict';

// B9: mention Homeroom bot in a project's group chat.
//
// "@Homeroom bot could it remind us on Sundays?" in a project's chat files a
// request in its writer's words (after a quick read says it asks for a
// change), and the bot writes nothing into the chat: its writer alone gets a
// card under it, which says where the request stands from its stored work
// state (services/work-state.js). The room's status chip on the message is
// gone (5 Nov 2026). A question is pointed at the bot's own chat; an unclear
// one asks first. "Make this a request" does the same without the read. Only
// a person's own message, in the main stream, and never a connector's. Names
// starting with "homeroom" are taken, and nobody gets a notification for
// mentioning the bot.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-chat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const botChat = require('../src/services/homeroom-bot-chat');

test('B9: what counts as asking the bot, and what was asked', () => {
  for (const text of ['@Homeroom bot could it remind us?', 'hey @homeroom_bot, add tags', '@HOMEROOM  BOT hi', '@homeroombot could it remind us?', '@HomeroomBot hi']) {
    assert.equal(botChat.mentionsBot(text), true, text);
  }
  for (const text of ['@Homeroom could it', 'mail a@homeroom_bot', '@homeroom_botty', '@homeroombotx', 'mail a@homeroombot.example', 'no mention']) {
    assert.equal(botChat.mentionsBot(text), false, text);
  }
  assert.equal(botChat.askedWords('@Homeroom bot could it remind us on Sundays?'), 'could it remind us on Sundays?');
  assert.equal(botChat.askedWords('hey @homeroom_bot, add tags'), 'hey add tags');
  assert.equal(botChat.askedWords('hey @homeroombot, add tags'), 'hey add tags');
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

test('B9: the chat place\'s turn hands a mention over once it is heard, and only from the main stream or (#4417) a topic\'s channel', () => {
  // Heard in the message's own transaction (ws.js), handed over by the chat
  // place's turn (the bot-voice machine's work), never floated after it.
  const voiceSrc = read('src/services/homeroom-bot-voice.js');
  assert.match(voiceSrc, /const chatPlace = place\.type === 'chat' \|\| place\.type === 'category';/);
  assert.match(voiceSrc, /\? chatModule\(deps\)\.heardInChat\(pool, cfg, \{ app, place, messages: fresh\.filter/);
  const chatSrc = read('src/services/homeroom-bot-chat.js');
  assert.match(chatSrc, /if \(\(thread && thread\.type !== 'category'\) \|\| postedVia === 'agent' \|\| !appId \|\| !userId\) return null;/,
    'a reply thread, an issue\'s or a proposal\'s discussion is not a place to ask the bot');
  assert.doesNotMatch(read('src/services/ws.js'), /noteChatMessage/);
  const chat = read('src/routes/chat.js');
  assert.match(chat, /router\.post\('\/api\/apps\/:slug\/messages\/:id\/request', groupChatWriteLimiter, sameOriginBrowserOnly,\s*communities\.requireAppMembership\(pool\),/);
  assert.match(chat, /router\.get\('\/api\/apps\/:slug\/my-bot-requests', appChatReadLimiter,/);
  const policy = require('../src/services/cli-api-policy');
  assert.equal(policy.isConnectorApiRequest('POST', '/api/apps/x/messages/5/request'), false, 'a person\'s own browser only');
});

// A failed read is logged, and resolves null: one message never ends the
// turn that reads the others.
test('B9: a failed read never rejects', async () => {
  const pool = { query: async () => { throw new Error('connection terminated'); } };
  const out = await botChat.noteChatMessage(pool, null, {
    appId: 7, userId: 3, messageId: 11, content: '@Homeroom bot add tags',
  });
  assert.equal(out, null);
});

test('B9: the card, and no chip for the room', () => {
  const request = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  const { BotRequestCardView, cardWords } = request;
  // The room's status chip is gone (5 Nov 2026): where a request stands is on its own page.
  for (const gone of ['BotStatusChip', 'CHIP_WORDS', 'chipLabel']) assert.equal(request[gone], undefined, `${gone} is gone`);
  assert.equal(typeof request.BOT_CHIP_CLASS, 'string', 'the bot\'s periwinkle pill stays, for the composer');
  const reactions = read('frontend/src/features/group-chat/transcript.tsx');
  assert.doesNotMatch(reactions, /BotStatusChip|msg\.botRequest/, 'the reactions row draws no chip');
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
  assert.match(row, /if \(surface === 'main' && msg\.canAskBot\) \{\s*items\.push\(\{ key: 'ask-bot', label: translate\('chat:group\.menu\.makeRequest'\)/);
  assert.equal(message('chat:group.menu.makeRequest'), 'Make this a request');
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
  const user = async (username, synthetic = false, access = true) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', $3, $2) RETURNING id, username`,
    [username, synthetic, access],
  )).rows[0];
  await user('homeroom_bot', true);
  const ben = await user('ben');
  // Ada is a member, but Homeroom has not let her in yet: the bot works for
  // everyone with platform access, so not for her.
  const ada = await user('ada', false, false);
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
  await set('homeroom_bot_mode', 'live');

  let nextIssue = 40;
  const created = [];
  const frames = [];
  const pushed = [];
  const deps = (read) => ({
    readAsk: async () => read,
    // The chat's own path for a mention, as it is with the bot's voice off
    // in chats (homeroom-bot-voice.js answers it otherwise).
    voice: { enabledFor: async () => false, recordAsk: async () => null, dropAsks: async () => {} },
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
  // The platform's triggers mark a request whose records changed, and its
  // clock derives it again; here that is done by hand before a read.
  const workState = require('../src/services/work-state');
  const rederive = (issueNumber) => workState.refresh(pool, [{ appId: app.id, issueNumber }]);

  await t.test('a change is filed in his words, and only he gets the card, which follows its work state', async () => {
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
    const card = pushed.at(-1);
    assert.equal(card.userId, ben.id, 'his alone');
    assert.deepEqual([card.frame.type, card.frame.card.kind, card.frame.card.title], ['bot_request_card', 'filed', 'Add a Sunday host reminder']);
    assert.equal(card.frame.card.state.stage, 'reading', 'filed, waiting to be read');
    const { rows: room } = await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE app_id = $1 AND thread_type IS NULL', [app.id]);
    assert.equal(room[0].n, 1, 'the bot wrote nothing into the room');
    // The room's status chip is gone (5 Nov 2026): nothing is written on the message or sent to the room.
    assert.equal((await metaOf(id)).botRequest, undefined, 'no chip on the message');
    assert.equal(frames.filter((f) => f.type === 'bot_request_status').length, 0, 'no chip frame for the room');
    // Asked again (a retry, an edit): nothing more is filed.
    await botChat.noteChatMessage(pool, null, { appId: app.id, userId: ben.id, messageId: id, content: '@homeroom_bot again', deps: deps({ kind: 'change', title: 'x' }) });
    assert.equal(created.length, 1);
    // Its moments push his card again, as its work state reads then.
    const cardOf = () => pushed.filter((p) => p.frame.type === 'bot_request_card' && p.frame.card.messageId === id).at(-1);
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, 41, 'live', 'ready') RETURNING id`, [app.id]);
    await rederive(41);
    pushed.length = 0;
    await botChat.noteRequestStatus(pool, { appId: app.id, issueNumber: 41, deps: deps(null) });
    assert.deepEqual([cardOf().userId, cardOf().frame.card.state.stage], [ben.id, 'building'], 'read to build: building');
    await pool.query(`UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = 'the build did not finish' WHERE id = $1`, [run.id]);
    await rederive(41);
    pushed.length = 0;
    await botChat.noteRequestStatus(pool, { appId: app.id, issueNumber: 41, deps: deps(null) });
    assert.equal(cardOf().frame.card.state.stage, 'stopped', 'the build stopped: so does its card');
    assert.equal(pushed.filter((p) => p.userId !== ben.id).length, 0, 'nobody else is pushed anything');
    assert.equal((await metaOf(id)).botRequest, undefined, 'and still nothing on the message');
    assert.equal(frames.filter((f) => f.type === 'bot_request_status').length, 0);
    // His cards come back after a reload; Ada sees none of them.
    const mine = await botChat.myRequests(pool, { app, user: { id: ben.id, username: 'ben', hasPlatformAccess: true } });
    assert.deepEqual([mine.bot, mine.builds, mine.cards.length, mine.cards[0].messageId], [true, true, 1, id]);
    const hers = await botChat.myRequests(pool, { app, user: { id: ada.id, username: 'ada', hasPlatformAccess: false } });
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

// B9's staging fixture: a preview has no live bot, so one demo message in the
// platform's own chat asked Homeroom bot for a change, for the shots and the
// declared check, which now asserts the room sees no chip on it.
test('B9: the staging demo seeds one chat request, once, and only on staging; its check sees no chip', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_chat_seed_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 2 });
  const env = process.env.USERNODE_ENV;
  t.after(async () => {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));
  const owner = (await pool.query(
    `INSERT INTO users (username, password) VALUES ('owner', 'x') RETURNING id`)).rows[0].id;
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ('Homeroom', 'homeroom-self', 'running', $1) RETURNING id`,
    [owner])).rows[0].id;
  const { seedStagingBotChatRequest } = require('../src/db/migrate');
  const config = { selfAppSlug: 'homeroom-self' };

  delete process.env.USERNODE_ENV;
  await seedStagingBotChatRequest(pool, config);
  assert.equal((await pool.query('SELECT 1 FROM chat_messages WHERE id = 900083')).rows.length, 0, 'nothing outside staging');

  process.env.USERNODE_ENV = 'staging';
  await seedStagingBotChatRequest(pool, config);
  await seedStagingBotChatRequest(pool, config);
  const { rows } = await pool.query(
    `SELECT m.app_id, m.content, m.metadata, m.thread_type, u.username
       FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.id = 900083`);
  assert.equal(rows.length, 1, 'seeded once');
  assert.equal(Number(rows[0].app_id), Number(app));
  assert.equal(rows[0].thread_type, null, 'in the main stream');
  assert.equal(rows[0].username, 'staging-demo-asker', 'a demo account, never the viewer');
  assert.match(rows[0].content, /^Staging demo: @Homeroom bot /);
  // The room's status chip is gone (5 Nov 2026): whatever chip the seeded metadata names is drawn nowhere.

  // Folded into #2905's check on the same route rather than taking a slot.
  const check = JSON.parse(read('dapp.json')).tests.find((c) => /a message that asked Homeroom bot wears no status chip/.test(c.name));
  assert.ok(check, 'a declared check reads the message');
  assert.equal(check.path, '/?demo=1#messages/app/usernode-2d5619');
  assert.match(check.expectSelector, /#gc-messages:has\(\.gc-msg\):not\(:has\(\[data-bot-request\]\)\)/, 'a message, and no chip on any');
  assert.ok(check.expectSelector.length <= 256, 'within the capture runner\'s selector cap');
  assert.equal(check.expectText, undefined, 'no chip words to read');
});
