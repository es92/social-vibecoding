'use strict';

// A problem reported on a change that is not live yet revises that change
// (first-session run-through, 5 October 2026).
//
// Sam, an invited flatmate, tried the group's first version (a change
// Homeroom bot built, waiting for approval) and found its main button did
// nothing. He pressed Ask for changes, which attached the change to his
// message to the bot, and wrote "Tapping mark as done doesn't do anything
// for me". The bot's model never saw the attached card: it called it "a bug
// in the app itself", offered a NEW request, and after "Yes please" drafted
// one, whose activity card then read "You asked: Yes please".
//
//   B  a message carrying one of the bot's own changes still waiting for
//      approval goes to that change (reviseProposal, the path Change
//      something on its ready card takes): posted in its discussion as his,
//      its follow-up first, and one line from the bot saying what happens
//      next, with no model turn. A question about it, and anything a gate
//      refuses, goes to the model, which now reads the card under the
//      message (sharedItemLines) and is told the change is what to revise;
//   C  "You asked:" on the activity card is the request as it was filed,
//      never the message that confirmed it;
//   D  no em dashes from the bot: the prompt says so, and a spaced one in a
//      reply becomes a comma.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-attached-change-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const threadPosts = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushSessionUpdate() {},
    broadcast() {},
    async handleMessage(_pool, client, msg) {
      threadPosts.push({ userId: client.user.id, appId: client.appId, msg });
      return { ok: true, message: { id: threadPosts.length } };
    },
    async sendSystemMessage() { return { id: 1 }; },
    pushIssueUpdate() {},
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};
const githubId = require.resolve('../src/services/github');
const created = [];
const githubStub = {
  isEnabled: () => true,
  async fetchPublicIssue(_owner, _repo, number) { return { issue: { number, title: `Issue ${number}`, state: 'open' } }; },
  async createIssue(owner, repo, { title, body }) {
    created.push({ owner, repo, title, body });
    return { number: 40 + created.length, title };
  },
  noteIssueCreated() {},
  safeMention: (s) => s,
};
require.cache[githubId] = {
  id: githubId, filename: githubId, loaded: true,
  exports: new Proxy(githubStub, { get: (t, k) => (k in t ? t[k] : async () => null) }),
};

const conversations = require('../src/services/conversations');
const dm = require('../src/services/homeroom-bot-dm');
const mayor = require('../src/services/homeroom-bot-mayor');
const homeroomBot = require('../src/services/homeroom-bot');

const CONFIG = { openrouterApiBase: 'https://openrouter.test/api/v1', openrouterOrigin: 'https://test', openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' };
const EM_DASH = '—';

/** A scripted model: each call answers with the next step's tool calls. */
function scripted(steps, seen = []) {
  let i = 0;
  return async (request) => {
    seen.push(request);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const calls = (typeof step === 'function' ? step(request) : step).map((c, n) => ({
      id: `call_${i}_${n}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1] || {}) },
    }));
    return {
      content: '',
      toolCalls: calls,
      assistantMessage: { role: 'assistant', content: null, tool_calls: calls },
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0 },
    };
  };
}
const noModel = async () => { throw new Error('the model was asked'); };

// 5 Oct 2026: a reply goes through the normaliser everything the bot writes
// for people goes through (src/services/em-dashes.js, tests/em-dashes.test.js),
// which picks a full stop, a colon or a comma by the words around the dash.
test('D: the prompt rules em dashes out, and one in a reply becomes what fits there', () => {
  assert.match(mayor.systemPrompt({ username: 'sam' }), /- Never write an em dash\. Use a comma, a colon or a full stop instead\./);
  assert.equal(mayor.cleanReply(`Sorry about that ${EM_DASH} that sounds like a bug.`), 'Sorry about that. That sounds like a bug.');
  assert.equal(mayor.cleanReply(`I've drafted the request ${EM_DASH} tap File it.`), 'I\'ve drafted the request: tap File it.');
  assert.equal(mayor.cleanReply(`It's on your list ${EM_DASH} and I'll start it next.`), 'It\'s on your list, and I\'ll start it next.');
  assert.equal(mayor.cleanReply(`the date${EM_DASH}and the time`), 'the date, and the time', 'with or without spaces');
  assert.equal(mayor.cleanReply(`First\n${EM_DASH} a line`), 'First\n- a line', 'a dash that starts a line is a bullet, and lines stay apart');
  assert.equal(mayor.cleanReply('[about x] Hi'), 'Hi', 'the leading note still goes');
});

test('B: the prompt and revise_proposal say an attached change is the one to fix', () => {
  const prompt = mayor.systemPrompt({ username: 'sam' });
  // One story: the prompt says "change", never "proposal" (its tools keep their names).
  assert.match(prompt, /A change of yours they attached to their message \(the conversation says so, with its proposal id\) is the one\n  they are writing about\./);
  assert.match(prompt, /Never offer a new\n  request for something that change should fix: it is not live yet\./);
  const revise = mayor.TOOLS.find((tool) => tool.function.name === 'revise_proposal');
  assert.match(revise.function.description, /or reported a problem with one they attached to their message\./);
});

test('B: what the bot says once a message went to its change, and which messages are questions', () => {
  assert.equal(mayor.revisingLine({ title: 'Show whose turn each chore is', projectName: 'Flat 4B Chores', queued: true }),
    'Got it. I\'ll fix that in "Show whose turn each chore is" before it goes live. I\'m on it next, and your message is in the change\'s discussion.');
  assert.equal(mayor.revisingLine({ title: 'X', projectName: 'P', queued: false }),
    'Got it. I\'ll fix that in "X" before it goes live, right after what I\'m doing on it now. Your message is in the change\'s discussion.');
  assert.equal(mayor.revisingLine({ title: null, projectName: 'P', queued: null }),
    'Got it. I\'ll fix that in this change before it goes live, when I next look at P. Your message is in the change\'s discussion.');
  assert.equal(mayor.looksLikeQuestion('What does this change do?'), true);
  assert.equal(mayor.looksLikeQuestion('Is it live yet?'), true);
  assert.equal(mayor.looksLikeQuestion('Tapping mark as done doesn\'t do anything for me'), false);
  assert.equal(mayor.looksLikeQuestion('Can you make the button bigger?'), false, 'a request put as a question');
  assert.equal(mayor.looksLikeQuestion('Why does mark as done do nothing?'), false, 'a problem put as a question');
});

test('C: "You asked:" is the request as filed, never the message that confirmed it', () => {
  assert.equal(mayor.askedFor({ title: 'Make Mark as done work', details: 'Tapping Mark as done should tick the chore off.' }),
    'Tapping Mark as done should tick the chore off.');
  assert.equal(mayor.askedFor({ title: 'Make Mark as done work', details: '  ' }), 'Make Mark as done work');
  assert.equal(mayor.askedFor({}), null);
});

test('B and C against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_attached_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess", is_admin AS "isAdmin"`,
    [username, synthetic],
  )).rows[0];
  const setting = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  const bot = await user('homeroom_bot', true);
  const maya = await user('maya');
  const sam = await user('sam');
  const ola = await user('ola');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Flat 4B Chores', 'flat-chores', 'running', $1, 'https://github.com/usernode-bot/flat-chores', 'public', 'public')
     RETURNING id`,
    [maya.id],
  );
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
  for (const member of [maya, sam]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, member.id]);
  }
  // On, for everyone with platform access, on every app but a paused one.
  await setting('homeroom_bot_mode', 'shadow');
  // The group's first version: the bot's change for Maya's request #1,
  // waiting for approval. And an older one of its changes that is live.
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 1, $2, 'First version')`,
    [app.id, maya.id],
  );
  const { rows: [pending] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, linked_issues)
     VALUES ($1, $2, 'bot-first', 'promoted', 'Show whose turn each chore is', NOW(), '{1}') RETURNING id`,
    [app.id, bot.id],
  );
  const { rows: [live] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, merged_at, linked_issues)
     VALUES ($1, $2, 'bot-older', 'merged', 'Add the chores list', NOW(), NOW(), '{1}') RETURNING id`,
    [app.id, bot.id],
  );
  const queueRow = async () => (await pool.query(
    'SELECT reason, requested_by, payer_user_id FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 1', [app.id],
  )).rows[0] || null;
  const clearQueue = () => pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);

  const chatOf = async (person) => (await conversations.ensureAdmittedDirect(pool, bot.id, person.id)).conversationId;
  const samChat = await chatOf(sam);
  const olaChat = await chatOf(ola);
  const send = async (person, conversationId, content, object = null) => (await conversations.sendMessage(
    pool, person, conversationId, { content, ...(object ? { object } : {}) },
  )).message;
  const change = (sessionId) => ({ type: 'proposal', appId: app.id, sessionId });
  const reply = async (conversationId, messageId) => (await pool.query(
    `SELECT id, content, reply_to_id, metadata FROM conversation_messages
      WHERE conversation_id = $1 AND sender_id = $2 AND reply_to_id = $3 ORDER BY id DESC LIMIT 1`,
    [conversationId, bot.id, messageId],
  )).rows[0] || null;
  const turnsOf = async (person) => Number((await pool.query(
    'SELECT COUNT(*)::int AS n FROM homeroom_bot_dm_turns WHERE user_id = $1', [person.id],
  )).rows[0].n);

  await t.test('B: Sam\'s problem with the attached change goes to that change, and the bot says what happens next', async () => {
    threadPosts.length = 0;
    await clearQueue();
    const message = await send(sam, samChat, 'Tapping mark as done doesn\'t do anything for me', change(pending.id));
    await dm.noteUserMessage(pool, CONFIG, {
      user: sam, conversationId: samChat, message,
      deps: { chat: noModel, apiKey: 'sk-test', openMcp: async () => null, seesImages: false },
    });
    // Posted in the change's discussion, as his, the way a reply typed there is.
    assert.equal(threadPosts.length, 1);
    assert.equal(threadPosts[0].userId, sam.id);
    assert.equal(threadPosts[0].appId, app.id);
    assert.deepEqual(threadPosts[0].msg.thread, { type: 'session', ref: pending.id });
    assert.equal(threadPosts[0].msg.content, 'Tapping mark as done doesn\'t do anything for me\n\n(Sent in a chat with Homeroom bot.)');
    // Its follow-up goes first, on his building time (he is not who asked for it).
    assert.deepEqual(await queueRow(), { reason: 'dm_revise', requested_by: sam.id, payer_user_id: sam.id });
    // One line back, quoting him, with the change's card, and no model turn.
    const answer = await reply(samChat, message.id);
    assert.equal(answer.content,
      'Got it. I\'ll fix that in "Show whose turn each chore is" before it goes live. I\'m on it next, and your message is in the change\'s discussion.');
    assert.ok(!answer.content.includes(EM_DASH));
    assert.equal(answer.metadata.homeroomBot.kind, 'chat');
    const { rows: objects } = await pool.query('SELECT object_type, object_ref FROM conversation_message_objects WHERE message_id = $1', [answer.id]);
    assert.deepEqual(objects.map((o) => `${o.object_type}:${o.object_ref}`), [`code_proposal:${pending.id}`]);
    assert.equal(await turnsOf(sam), 0, 'decided without the model');
    const { rows: offers } = await pool.query('SELECT 1 FROM homeroom_bot_dm_actions WHERE user_id = $1', [sam.id]);
    assert.equal(offers.length, 0, 'no new request offered');
  });

  await t.test('B: a question about the change is the model\'s, and it reads the card under the message', async () => {
    threadPosts.length = 0;
    await clearQueue();
    const seen = [];
    const message = await send(sam, samChat, 'What does this change do?', change(pending.id));
    await dm.noteUserMessage(pool, CONFIG, {
      user: sam, conversationId: samChat, message,
      deps: { chat: scripted([[['reply', { text: 'It shows whose turn each chore is.' }]]], seen), apiKey: 'sk-test', openMcp: async () => null, seesImages: false },
    });
    assert.equal(threadPosts.length, 0, 'nothing posted');
    assert.equal(await queueRow(), null, 'nothing queued');
    assert.equal(seen.length, 1);
    const last = seen[0].messages.filter((m) => m.role === 'user').pop();
    assert.equal(last.content, `What does this change do?\n[Homeroom: they attached your own change "Show whose turn each chore is" on Flat 4B Chores (proposal ${pending.id}), waiting for approval. It is not live yet: what they say is wrong with it, or want different in it, goes to that change with revise_proposal (proposal ${pending.id}), never into a new request.]`);
    // The earlier message in the history carries its card too.
    assert.ok(seen[0].messages.some((m) => m.role === 'user' && /^Tapping mark as done[^\n]*\n\[Homeroom: they attached your own change /.test(m.content)));
  });

  await t.test('B: a live change, or somebody a gate refuses, is not sent anywhere: the model reads it', async () => {
    threadPosts.length = 0;
    await clearQueue();
    // A change that is live already: the model is told it is live.
    const seen = [];
    const onLive = await send(sam, samChat, 'The chores list is too small to read', change(live.id));
    await dm.noteUserMessage(pool, CONFIG, {
      user: sam, conversationId: samChat, message: onLive,
      deps: { chat: scripted([[['reply', { text: 'Want me to file a request to make it bigger?' }]]], seen), apiKey: 'sk-test', openMcp: async () => null, seesImages: false },
    });
    assert.equal(threadPosts.length, 0);
    const line = seen[0].messages.filter((m) => m.role === 'user').pop().content;
    assert.match(line, new RegExp(`\\[Homeroom: they attached the change "Add the chores list" on Flat 4B Chores \\(proposal ${live.id}\\), live\\.\\]$`));
    assert.doesNotMatch(line, /revise_proposal/);
    // Ola is not a member and did not ask for it: reviseProposal refuses,
    // nothing is posted, and the model answers him.
    const refusedSeen = [];
    const fromOla = await send(ola, olaChat, 'Mark as done is broken on this', change(pending.id));
    await dm.noteUserMessage(pool, CONFIG, {
      user: ola, conversationId: olaChat, message: fromOla,
      deps: { chat: scripted([[['reply', { text: 'Only members of Flat 4B Chores can ask for changes to it.' }]]], refusedSeen), apiKey: 'sk-test', openMcp: async () => null, seesImages: false },
    });
    assert.equal(threadPosts.length, 0);
    assert.equal(await queueRow(), null);
    assert.equal(refusedSeen.length, 1, 'the model answered');
    assert.equal((await reply(olaChat, fromOla.id)).content, 'Only members of Flat 4B Chores can ask for changes to it.');
  });

  await t.test('C and D: a request drafted after "Want me to?" leads its card with what was filed, not "Yes please"', async () => {
    await clearQueue();
    const settings = await homeroomBot.readSettings(pool);
    const turn = async (text, chat) => mayor.runDmTurn(pool, CONFIG, {
      bot, user: maya, settings, conversationId: await chatOf(maya), message: await send(maya, await chatOf(maya), text),
      deps: { chat, apiKey: 'sk-test', openMcp: async () => null, seesImages: false },
    });
    const asked = await turn('The chores page should let us swap turns', scripted([
      [['reply', { text: `Good idea ${EM_DASH} I can file a request for that. Want me to?` }]],
    ]));
    const first = (await pool.query('SELECT content FROM conversation_messages WHERE id = $1', [asked.messageId])).rows[0];
    // 5 Oct 2026: the shared normaliser (em-dashes.js): a new clause after the dash is a new sentence.
    assert.equal(first.content, 'Good idea. I can file a request for that. Want me to?', 'D: the em dash became a full stop');
    const offered = await turn('Yes please', scripted([
      [['offer_request', { project: 'Flat 4B Chores', title: 'Swap chore turns', details: 'Let two flatmates swap their turns on a chore.' }]],
      [['reply', { text: 'Here it is.' }]],
    ]));
    const tapped = await conversations.sendMessage(pool, maya, await chatOf(maya), { content: 'File it', reply_to_id: offered.messageId });
    const card = await mayor.decideOffer(pool, CONFIG, { bot, user: maya, settings, message: tapped.message, deps: {} });
    assert.equal(created.length, 1, 'filed');
    const { rows: [meta] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [card.messageId]);
    assert.equal(meta.metadata.homeroomBot.kind, 'activity');
    assert.equal(meta.metadata.homeroomBot.askedText, 'Let two flatmates swap their turns on a chore.');
    const { rows: [recorded] } = await pool.query(
      'SELECT asked_text FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = $2', [app.id, 41],
    );
    assert.equal(recorded.asked_text, 'Let two flatmates swap their turns on a chore.', 'and it is what the request keeps');
  });
});
