'use strict';

// B5: Homeroom bot's name, face and first hello.
//
//   - the bot is "Homeroom bot" wherever Messages names it, with the Homeroom
//     mark for its picture and an "AI" badge; people keep their @handles;
//   - its DM is the first row of the list, whatever was said last;
//   - it says hello once per person, ever, with questions to tap: a maker
//     with their first project, anybody else with their first request.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-hello.test.js

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

test('B5: the bot is named by its name, a person by their handle', () => {
  const { senderName, UserAvatar } = loadTsx('frontend/src/features/messages/format.tsx');
  assert.equal(senderName({ id: 2, username: 'homeroom_bot', bot: true, displayName: 'Homeroom bot' }), 'Homeroom bot');
  assert.equal(senderName({ id: 3, username: 'ada' }), '@ada');
  assert.equal(senderName({ id: 3, username: 'ada', displayName: 'Ada L' }), '@ada', 'a person keeps their handle');
  assert.equal(senderName({ id: 0, username: 'Deleted user' }), 'Deleted user');
  assert.equal(senderName(null), '');
  const face = renderToHtml(createElement(UserAvatar, { user: { id: 2, username: 'homeroom_bot', bot: true }, shape: 'square' }));
  assert.match(face, /<img src="\/brand\/homeroom-mark\.png" alt="" class="[^"]*rounded-xl[^"]*" data-bot-avatar=""\/>/);
  const person = renderToHtml(createElement(UserAvatar, { user: { id: 3, username: 'ada' }, shape: 'square' }));
  assert.doesNotMatch(person, /homeroom-mark/);
  const { normalizeUser } = loadTsx('frontend/src/features/messages/api.ts');
  assert.deepEqual(normalizeUser({ id: 2, username: 'homeroom_bot', bot: true, displayName: 'Homeroom bot' }),
    { id: 2, username: 'homeroom_bot', avatarUrl: null, bot: true, displayName: 'Homeroom bot' });
  assert.equal(Object.hasOwn(normalizeUser({ id: 3, username: 'ada', displayName: 'x' }), 'displayName'), false,
    'only a platform account is named this way');
});

test('B5: every place Messages names the bot names it, with an AI badge beside it', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /\{senderName\(message\.sender\)\}<\/span>\{message\.sender\.bot \? <span className="messages-bot-badge">AI<\/span> : null\}/);
  assert.doesNotMatch(row, />Bot<\/span>/);
  assert.match(row, /<span>\{senderName\(message\.reply\.sender\)\}<\/span>/, 'the quote');
  assert.match(row, /preview=\{\{ who: senderName\(message\.sender\)/, 'the action sheet');
  assert.match(row, /label: `Message from \$\{senderName\(message\.sender\)\}`/, 'the report');
  assert.doesNotMatch(row, /'@' : ''\}\{message\.(reply\.)?sender\.username\}/);
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /conversation\.kind === 'direct' && peer \? senderName\(peer\) : conversation\.title\}\{conversation\.kind === 'direct' && peer\?\.bot \? <span className="messages-bot-badge">AI<\/span> : null\}/, 'the list row');
  assert.match(screen, /active\.kind === 'direct' && person \? senderName\(person\)[^\n]*person\?\.bot \? <span className="messages-bot-badge">AI<\/span>/, 'the header');
  assert.match(read('frontend/src/features/messages/composer.tsx'), /Replying to \{senderName\(reply\.sender\)\}/);
  assert.match(read('frontend/src/features/messages/store.ts'), /state\.active\.peer\.displayName/, 'the typing line');
});

test('B5: the bot\'s DM is the first row, and a search lists results as they happened', () => {
  const { buildInbox, inClockOrder } = loadTsx('frontend/src/features/messages/inbox.ts');
  const conversations = [
    { id: 1, lastActivityAt: '2026-10-04T10:00:00Z', kind: 'direct' },
    { id: 2, lastActivityAt: '2026-10-01T10:00:00Z', kind: 'direct', homeroomBot: true },
    { id: 3, lastActivityAt: '2026-10-03T10:00:00Z', kind: 'direct' },
  ];
  const base = { conversations, discussions: [], agents: [] };
  assert.deepEqual(buildInbox({ ...base, filter: 'all' }).map((e) => e.key), ['person:2', 'person:1', 'person:3']);
  assert.deepEqual(buildInbox({ ...base, filter: 'agents' }).map((e) => e.key), ['person:2']);
  assert.deepEqual(buildInbox({ ...base, filter: 'people' }).map((e) => e.key), ['person:1', 'person:3']);
  assert.deepEqual(inClockOrder(buildInbox({ ...base, filter: 'all' })).map((e) => e.key), ['person:1', 'person:3', 'person:2']);
  assert.match(read('frontend/src/features/messages/index.tsx'), /const shown = q \? inClockOrder\(found\) : found;/);
});

test('B5: prompts to tap keep the suggestion look, and read back as asked', () => {
  const taps = [];
  const { BotQuestion } = loadTsx('frontend/src/features/messages/bot-question.tsx', {
    stubs: { './store': { answerBotQuestion() {}, scopeKey: () => 'k', setReply() {}, async tapBotAction(m, a) { taps.push(a.id); } } },
  });
  const hello = {
    id: 9, conversationId: 3, content: 'Hi, I\'m Homeroom bot.', createdAt: 'now', reactions: [], attachments: [], objects: [],
    sender: { id: 2, username: 'homeroom_bot', bot: true, displayName: 'Homeroom bot' },
    metadata: { homeroomBot: {
      kind: 'first_version_started', appName: 'Plant Pal', status: 'open',
      actions: [
        { id: 'ask-1', label: 'How long will this take?', style: 'secondary', type: 'prompt' },
        { id: 'ask-2', label: 'What can I ask for?', style: 'secondary', type: 'prompt' },
      ],
    } },
  };
  const html = renderToHtml(createElement(BotQuestion, { message: hello, conversationId: 3 }));
  assert.match(html, /aria-label="Questions you can ask"/);
  assert.match(html, /<button type="button" data-bot-answer="default" data-bot-prompt=""><span>How long will this take\?<\/span><\/button>/);
  assert.doesNotMatch(html, /messages-bot-primary|messages-bot-secondary/, 'a question to ask is not an act');
  const asked = { ...hello, metadata: { homeroomBot: { ...hello.metadata.homeroomBot, status: 'answered', answer: 'What can I ask for?', chosen: 'ask-2' } } };
  const after = renderToHtml(createElement(BotQuestion, { message: asked, conversationId: 3 }));
  assert.doesNotMatch(after, /<button/);
  assert.match(after, /<p class="messages-bot-answered">You asked: What can I ask for\?<\/p>/);
});

test('B5: the hellos say what the bot does, in plain words', () => {
  const dm = require('../src/services/homeroom-bot-dm');
  assert.equal(dm.MAKER_HELLO, 'Hi, I\'m Homeroom bot. I build apps and changes from what you describe, and I\'ll message you when something\'s ready to try.');
  assert.equal(dm.memberHello('Supper Club'), 'Hi, I\'m Homeroom bot. I build the changes people in Supper Club ask for. Here\'s yours:');
  assert.deepEqual(dm.promptActions(dm.MAKER_PROMPTS).map((a) => [a.id, a.type, a.label]), [
    ['ask-1', 'prompt', 'How long will this take?'], ['ask-2', 'prompt', 'What can I ask for?'], ['ask-3', 'prompt', 'How do I invite friends?'],
  ]);
  assert.deepEqual(dm.MEMBER_PROMPTS, ['What else can I ask for?', 'How long will this take?']);
  for (const text of [dm.MAKER_HELLO, dm.memberHello('X'), ...dm.MAKER_PROMPTS, ...dm.MEMBER_PROMPTS, dm.TOUR_HELLO, ...dm.TOUR_PROMPTS]) {
    assert.doesNotMatch(text, /—|homeroom_bot/);
  }
  // #4604: the hello after the tour: who it is, and what to ask it, short.
  assert.equal(dm.TOUR_HELLO, 'Hi, I\'m Homeroom bot, the AI that builds things on Homeroom. Ask me here to build a change, '
    + 'file an idea or fix a bug in any project you\'re in, and I\'ll tell you how it goes.');
  assert.deepEqual(dm.TOUR_PROMPTS, ['What can I ask for?', 'How does the group decide?', 'How do I start a project?']);
});

test('B5: its name and its one hello, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_hello_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = read('src/db/schema.sql');
  await pool.query(schema);
  const conversations = require('../src/services/conversations');
  const dm = require('../src/services/homeroom-bot-dm');
  const activity = require('../src/services/homeroom-bot-activity');
  const user = async (username, synthetic = false, access = true) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', $3, $2) RETURNING id, username`,
    [username, synthetic, access],
  )).rows[0];
  const bot = await user('homeroom_bot', true);
  await pool.query(schema); // boot names it
  const maya = await user('maya');
  const ben = await user('ben');
  const old = await user('old_friend');
  const project = async (slug, label, owner) => {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ($1, $2, 'running', $3) RETURNING id`,
      [label, slug, owner.id],
    );
    return (await pool.query('SELECT id, slug, name, created_by FROM apps WHERE id = $1', [inserted.id])).rows[0];
  };
  const plantPal = await project('plant-pal', 'Plant Pal', maya);
  const herbs = await project('herbs', 'Herbs', maya);
  const supper = await project('supper-club', 'Supper Club', maya);
  const settings = { mode: 'live' };

  await t.test('the bot is "Homeroom bot" to whoever reads it; its handle is unchanged', async () => {
    const { rows: [named] } = await pool.query('SELECT username, display_name FROM users WHERE id = $1', [bot.id]);
    assert.deepEqual(named, { username: 'homeroom_bot', display_name: 'Homeroom bot' });
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, maya.id);
    const asked = await conversations.sendMessage(pool, maya, opened.conversationId, { content: 'hi' });
    const answered = await dm.sendDm(pool, { bot, userId: maya.id, content: 'Hello!', replyToId: asked.message.id, moment: 'reply' });
    const said = await conversations.getMessage(pool, maya, opened.conversationId, answered.messageId);
    assert.deepEqual(said.sender, { id: bot.id, username: 'homeroom_bot', avatarUrl: null, bot: true, displayName: 'Homeroom bot' });
    assert.equal(said.reply.sender.displayName, undefined, 'a person keeps their handle in a quote');
    const quoting = await conversations.sendMessage(pool, maya, opened.conversationId, { content: 'thanks', reply_to_id: answered.messageId });
    assert.equal(quoting.message.reply.sender.displayName, 'Homeroom bot', 'and the bot is named in one');
    const chat = await conversations.getConversation(pool, maya, opened.conversationId);
    assert.equal(chat.title, 'Homeroom bot');
    assert.deepEqual([chat.peer.bot, chat.peer.displayName, chat.peer.username], [true, 'Homeroom bot', 'homeroom_bot']);
    assert.equal(chat.homeroomBot, true);
  });

  await t.test('somebody the bot already wrote to is never greeted', async () => {
    assert.equal(await dm.claimHello(pool, { userId: maya.id, botId: bot.id, kind: 'maker' }), false);
    const { rows: [row] } = await pool.query('SELECT kind FROM homeroom_bot_hellos WHERE user_id = $1', [maya.id]);
    assert.equal(row.kind, 'known');
    await pool.query('DELETE FROM homeroom_bot_hellos WHERE user_id = $1', [maya.id]);
    await pool.query('DELETE FROM conversation_messages WHERE sender_id = $1 OR sender_id = $2', [bot.id, maya.id]);
  });

  await t.test('a maker hears hello with their first project, once, with questions to tap', async () => {
    const first = await dm.startFirstVersion(pool, {}, { app: plantPal, user: { ...maya, hasPlatformAccess: true }, brief: 'A plant watering tracker that reminds me every Sunday.' });
    assert.ok(first?.conversationId);
    const { rows: [msg] } = await pool.query(
      `SELECT id, content, metadata FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 ORDER BY id DESC LIMIT 1`,
      [first.conversationId, bot.id],
    );
    assert.match(msg.content, /^Hi, I'm Homeroom bot\. I build apps and changes from what you describe/);
    // #4097: the project's name is a line of its own after the hello, which
    // Messages draws as the project's card.
    assert.match(msg.content, /\n\n\*\*Plant Pal\*\*\n\nI'm setting up Plant Pal now\./);
    const meta = msg.metadata.homeroomBot;
    assert.equal(meta.status, 'open');
    assert.deepEqual(meta.actions.map((a) => a.label), ['How long will this take?', 'What can I ask for?', 'How do I invite friends?']);
    const { rows: [hello] } = await pool.query('SELECT kind, message_id FROM homeroom_bot_hellos WHERE user_id = $1', [maya.id]);
    assert.deepEqual(hello, { kind: 'maker', message_id: msg.id });

    // She taps one: her words, and the buttons give way everywhere.
    const tapped = await conversations.sendMessage(pool, maya, first.conversationId, { content: 'What can I ask for?' });
    assert.equal(await dm.settlePrompt(pool, { botId: bot.id, userId: maya.id, conversationId: first.conversationId, content: tapped.message.content }), true);
    const { rows: [settled] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [msg.id]);
    assert.deepEqual([settled.metadata.homeroomBot.status, settled.metadata.homeroomBot.answer, settled.metadata.homeroomBot.chosen],
      ['answered', 'What can I ask for?', 'ask-2']);
    assert.equal(await dm.settlePrompt(pool, { botId: bot.id, userId: maya.id, conversationId: first.conversationId, content: 'What can I ask for?' }), false,
      'settled once');

    // Her second project: no second hello. (#4097 follow-up: tapped first,
    // since the bot's next message retires suggestions it has moved on from.)
    await dm.startFirstVersion(pool, {}, { app: herbs, user: { ...maya, hasPlatformAccess: true }, brief: 'A herb garden planner for my balcony.' });
    const { rows: [second] } = await pool.query(
      `SELECT content, metadata FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 ORDER BY id DESC LIMIT 1`,
      [first.conversationId, bot.id],
    );
    assert.match(second.content, /^\*\*Herbs\*\*\n\nThanks! I'm setting up Herbs now\./);
    assert.equal(second.metadata.homeroomBot.actions, undefined);
  });

  await t.test('somebody else hears hello above their first request\'s card, once', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, asked_text) VALUES
         ($1, 4, $2, 'Sunday host reminder', 'Remind the host on Sunday'), ($1, 5, $2, 'Menu', 'A menu page')`,
      [supper.id, ben.id],
    );
    const card = await activity.startCard(pool, {
      app: supper, issueNumber: 4, requester: await dm.requesterOf(pool, supper.id, 4), bot, jobKey: 'hello-1', settings, queued: true,
    });
    const { rows: [msg] } = await pool.query('SELECT content, metadata FROM conversation_messages WHERE id = $1', [card.messageId]);
    assert.match(msg.content, /^Hi, I'm Homeroom bot\. I build the changes people in Supper Club ask for\. Here's yours:\n\n\*\*Supper Club\*\* · request #4/);
    const meta = msg.metadata.homeroomBot;
    assert.equal(meta.kind, 'activity');
    assert.equal(meta.hello, 'Hi, I\'m Homeroom bot. I build the changes people in Supper Club ask for. Here\'s yours:');
    assert.deepEqual(meta.actions.map((a) => a.label), ['What else can I ask for?', 'How long will this take?']);
    const next = await activity.startCard(pool, {
      app: supper, issueNumber: 5, requester: await dm.requesterOf(pool, supper.id, 5), bot, jobKey: 'hello-2', settings, queued: true,
    });
    const { rows: [plain] } = await pool.query('SELECT content, metadata FROM conversation_messages WHERE id = $1', [next.messageId]);
    assert.match(plain.content, /^\*\*Supper Club\*\* · request #5/);
    assert.equal(plain.metadata.homeroomBot.hello, undefined);

    // The maker's own requests never carry the member hello.
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 6, $2, 'Sides')`,
      [supper.id, maya.id],
    );
    const own = await activity.startCard(pool, {
      app: supper, issueNumber: 6, requester: await dm.requesterOf(pool, supper.id, 6), bot, jobKey: 'hello-3', settings, queued: true,
    });
    const { rows: [ownMsg] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [own.messageId]);
    assert.equal(ownMsg.metadata.homeroomBot.hello, undefined);
  });

  await t.test('WP-F: somebody who joins by a link hears hello once, only when the bot builds for them and is on', async () => {
    const tess = await user('tess');
    // Not let in yet: the bot does not build for them (hasBot).
    const zed = await user('zed', false, false);
    const mode = (value) => pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [value]);
    await mode('off');
    assert.equal(await dm.greetJoiner(pool, { user: tess, app: supper }), null, 'switched off: no hello it cannot keep');
    await mode('live');
    assert.equal(await dm.greetJoiner(pool, { user: zed, app: supper }), null, 'not one it builds for');
    const sent = await dm.greetJoiner(pool, { user: tess, app: supper });
    assert.ok(sent?.messageId);
    const { rows: [msg] } = await pool.query('SELECT content, metadata FROM conversation_messages WHERE id = $1', [sent.messageId]);
    assert.equal(msg.content, dm.joinerHello('Supper Club'));
    assert.match(msg.content, /^Hi, I'm Homeroom bot, the AI that builds things for the groups on Homeroom\. Welcome to Supper Club!/);
    assert.match(msg.content, /tap Suggest an improvement on its page\. I'll build it, and the group tries it and decides whether it goes live\.$/);
    assert.equal(msg.metadata.homeroomBot.kind, 'hello_joiner');
    assert.equal(dm.momentOf(msg.metadata.homeroomBot), null, 'a hello rings nothing');
    assert.deepEqual(msg.metadata.homeroomBot.actions.map((a) => a.label), ['What can I ask for?', 'How does the group decide?']);
    const { rows: [hello] } = await pool.query('SELECT kind, message_id FROM homeroom_bot_hellos WHERE user_id = $1', [tess.id]);
    assert.deepEqual(hello, { kind: 'joiner', message_id: sent.messageId });
    assert.equal(await dm.greetJoiner(pool, { user: tess, app: herbs }), null, 'once, ever');
    await mode('off');
    // Redeeming a link is what greets them.
    assert.match(read('src/services/community-invites.js'),
      /if \(status === 'joined'\) \{\n {6}appAccess\.invalidateVisibility\(invite\.app_id, invite\.slug\);\n[^\n]*\n {6}void require\('\.\/homeroom-bot-dm'\)\.greetJoiner\(pool, \{/);
  });

  await t.test('#4604: ending the tour greets once, only somebody the bot has not met, never a quiet test account', async () => {
    const onboarding = require('../src/services/onboarding');
    const mode = (value) => pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [value]);
    const nina = await user('nina');
    const tester = await user('tester_tour');
    await pool.query('UPDATE users SET test_account_created_at = NOW() WHERE id = $1', [tester.id]);
    await mode('off');
    assert.equal(await dm.greetTourFinisher(pool, { userId: nina.id }), null, 'switched off: no hello it cannot keep');
    await mode('live');
    assert.equal(await dm.greetTourFinisher(pool, { userId: tester.id }), null, 'a test account hears nothing');
    const sent = await dm.greetTourFinisher(pool, { userId: nina.id });
    assert.ok(sent?.messageId);
    const { rows: [msg] } = await pool.query('SELECT content, metadata FROM conversation_messages WHERE id = $1', [sent.messageId]);
    assert.equal(msg.content, dm.TOUR_HELLO);
    assert.equal(msg.metadata.homeroomBot.kind, 'hello_tour');
    assert.equal(msg.metadata.homeroomBot.status, 'open', 'a hello they can reply to');
    assert.equal(dm.momentOf(msg.metadata.homeroomBot), null, 'a hello rings nothing');
    assert.deepEqual(msg.metadata.homeroomBot.actions.map((a) => a.label), dm.TOUR_PROMPTS);
    const { rows: [hello] } = await pool.query('SELECT kind, message_id FROM homeroom_bot_hellos WHERE user_id = $1', [nina.id]);
    assert.deepEqual(hello, { kind: 'tour', message_id: sent.messageId });
    assert.equal(await dm.greetTourFinisher(pool, { userId: nina.id }), null, 'once, ever');
    // Somebody greeted another way (the joiner above) is not greeted again.
    const { rows: [tess] } = await pool.query("SELECT id FROM users WHERE username = 'tess'");
    assert.equal(await dm.greetTourFinisher(pool, { userId: tess.id }), null, 'one hello per person, whichever it was');
    // A test account made to receive the welcome DM is greeted like anyone.
    await pool.query('UPDATE users SET test_account_welcome_dm = TRUE WHERE id = $1', [tester.id]);
    assert.ok((await dm.greetTourFinisher(pool, { userId: tester.id }))?.messageId);
    await mode('off');
    // The first end of the tour is what greets, never a backfill.
    const source = read('src/services/onboarding.js');
    assert.match(source, /if \(marked && marked\.rowCount > 0 && ended !== 'backfill'\) \{\n {4}void require\('\.\/homeroom-bot-dm'\)\.greetTourFinisher\(pool, \{ userId \}\);/);
    assert.equal(typeof onboarding.markTourDone, 'function');
  });

  await t.test('two claims at once greet once', async () => {
    const claims = await Promise.all([1, 2, 3].map(() => dm.claimHello(pool, { userId: old.id, botId: bot.id, kind: 'member' })));
    assert.equal(claims.filter(Boolean).length, 1);
  });
});
