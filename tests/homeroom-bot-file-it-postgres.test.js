'use strict';

// The File it button the bot promises is the one under its message (#4605).
//
// Drea asked Homeroom bot twice to file "Week by week tracking in insights"
// on Rilo. Both times the model wrote that a File it button would appear
// under its message, and both times none did: it had never called
// offer_request, so nothing was drafted and the buttons never went out. The
// check on what a reply claims (#3769, #3772) knew nothing about a promised
// draft.
//
//   A  a reply that says a draft with File it is under it, with no offer made
//      this turn, is asked for once more with a note naming offer_request;
//      the draft then goes out with its File it and Not now buttons;
//   B  an offer_request that is refused (not a member) leaves no promise in
//      what is sent: the claim is cut and the instead line leads;
//   C  the offer path itself cannot drop the card: a turn that drafted the
//      request and then failed in its reply round still sends it with the
//      buttons, on the offer's own default line.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-file-it-postgres.test.js

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
    pushConversationEvent() { return 0; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushSessionUpdate() {},
    broadcast() {},
    async handleMessage() { return { ok: true, message: { id: 1 } }; },
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
require.cache[githubId] = {
  id: githubId, filename: githubId, loaded: true,
  exports: new Proxy({ isEnabled: () => false, safeMention: (s) => s }, {
    get: (t, k) => (k in t ? t[k] : async () => null),
  }),
};

const conversations = require('../src/services/conversations');
const mayor = require('../src/services/homeroom-bot-mayor');
const homeroomBot = require('../src/services/homeroom-bot');

const CONFIG = { openrouterApiBase: 'https://openrouter.test/api/v1', openrouterOrigin: 'https://test', openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' };

/** A scripted model: each call answers with the next step's tool calls. */
function scripted(steps, seen = []) {
  let i = 0;
  return async (request) => {
    // The turn's `messages` array is mutated in place, so what one request
    // carried is snapshotted here.
    seen.push({ ...request, messages: request.messages.slice() });
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

/** A model that answers the first request, then fails the round. */
function draftThenFail(offer) {
  let i = 0;
  return async () => {
    i += 1;
    if (i === 1) {
      const calls = offer.map((c, n) => ({
        id: `call_1_${n}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1] || {}) },
      }));
      return {
        content: '', toolCalls: calls,
        assistantMessage: { role: 'assistant', content: null, tool_calls: calls },
        usage: { inputTokens: 100, outputTokens: 10, costUsd: 0 },
      };
    }
    throw new Error('the reply round failed');
  };
}

test('the File it promise is kept, or not promised at all', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_fileit_${crypto.randomBytes(6).toString('hex')}`;
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
  const drea = await user('drea');
  const tess = await user('tess');
  const ola = await user('ola');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Rilo', 'rilo', 'running', $1, 'https://github.com/usernode-bot/rilo', 'public', 'public')
     RETURNING id`,
    [drea.id],
  );
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
  for (const member of [drea, tess]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, member.id]);
  }
  await setting('homeroom_bot_mode', 'shadow');

  const chatOf = async (person) => (await conversations.ensureAdmittedDirect(pool, bot.id, person.id)).conversationId;
  const send = async (person, content) => (await conversations.sendMessage(
    pool, person, await chatOf(person), { content },
  )).message;
  const settings = await homeroomBot.readSettings(pool);
  const turn = async (person, text, chat) => mayor.runDmTurn(pool, CONFIG, {
    bot, user: person, settings, conversationId: await chatOf(person), message: await send(person, text),
    deps: { chat, apiKey: 'sk-test', openMcp: async () => null, seesImages: false },
  });
  const messageOf = async (messageId) => (await pool.query(
    'SELECT content, metadata FROM conversation_messages WHERE id = $1', [messageId],
  )).rows[0];
  const actionOf = async (person) => (await pool.query(
    'SELECT kind, title, status, message_id FROM bot_cards WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
    [person.id],
  )).rows[0] || null;
  const lastTurnFailures = async (person) => (await pool.query(
    'SELECT failures FROM homeroom_bot_dm_turns WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [person.id],
  )).rows[0]?.failures || [];

  await t.test('A: a reply that promises File it is asked again, and the draft lands with its buttons', async () => {
    const seen = [];
    const sent = await turn(drea, 'Can you file a request on Rilo for week by week tracking in insights?', scripted([
      [['reply', { text: 'I\'ve drafted the request. A File it button will appear under this message.' }]],
      [['offer_request', { project: 'Rilo', title: 'Week by week tracking in insights', details: 'Show insights week by week, not only as a total.', doneWhen: ['It does what was asked.'] }]],
      [['reply', { text: 'Here it is.' }]],
    ], seen));
    // The second request carries the check note, and it names offer_request.
    const note = seen[1].messages[seen[1].messages.length - 1];
    assert.equal(note.role, 'user');
    assert.match(note.content, /^\[Homeroom check, not from them: your reply says a drafted request with File it is under it\./);
    assert.match(note.content, /no draft is open in this conversation, so nothing is under it/);
    assert.match(note.content, /Call offer_request now with the project, title and details/);
    // The reply goes out as the offer's confirm card.
    assert.ok(sent.messageId);
    const { content, metadata } = await messageOf(sent.messageId);
    assert.match(content, /Here it is\.\n\n\*\*Rilo\*\* · new request: Week by week tracking in insights/);
    assert.ok(content.includes('Show insights week by week, not only as a total.'));
    const card = metadata.homeroomBot;
    assert.equal(card.kind, 'confirm');
    assert.deepEqual(card.answers, ['File it', 'Not now']);
    assert.deepEqual(card.actions.map((a) => a.label), ['File it', 'Not now']);
    assert.equal(card.status, 'open');
    const action = await actionOf(drea);
    assert.equal(action.kind, 'file_request');
    assert.equal(action.title, 'Week by week tracking in insights');
    assert.equal(action.status, 'open');
    assert.equal(action.message_id, sent.messageId, 'the row points at the message the buttons are on');
    // The caught claim is recorded on the turn.
    assert.ok((await lastTurnFailures(drea)).includes('claims:drafted'));
  });

  await t.test('B: a refused offer leaves no promise in what is sent', async () => {
    const sent = await turn(ola, 'Can you file a request on Rilo for week by week tracking in insights?', scripted([
      [['reply', { text: 'I\'ve drafted the request for Rilo.' }]],
      [['offer_request', { project: 'Rilo', title: 'Week by week tracking in insights', details: 'Show insights week by week, not only as a total.', doneWhen: ['It does what was asked.'] }]],
      [['reply', { text: 'Tap File it below.' }]],
    ]));
    const { content, metadata } = await messageOf(sent.messageId);
    assert.equal(metadata.homeroomBot.kind, 'chat', 'no confirm card went out');
    assert.ok(!metadata.homeroomBot.actions, 'no buttons');
    assert.ok(!content.includes('File it'), 'nothing promised');
    assert.ok(content.startsWith('I haven\'t drafted it yet'), 'the instead line leads');
    assert.equal(await actionOf(ola), null, 'no offer row');
  });

  await t.test('C: a turn that drafted the request and then failed its reply round still sends the card', async () => {
    const sent = await turn(tess, 'File a request on Rilo: the insights should show week by week.', draftThenFail([
      ['offer_request', { project: 'Rilo', title: 'Week by week tracking in insights', details: 'Show insights week by week, not only as a total.', doneWhen: ['It does what was asked.'] }],
    ]));
    const { content, metadata } = await messageOf(sent.messageId);
    const card = metadata.homeroomBot;
    assert.equal(card.kind, 'confirm');
    assert.deepEqual(card.answers, ['File it', 'Not now']);
    assert.equal(card.status, 'open');
    // The offer's own default line, since the model's reply never arrived.
    assert.match(content, /^Here is the request I'd file on Rilo\.\n\n\*\*Rilo\*\* · new request: Week by week tracking in insights/);
    const action = await actionOf(tess);
    assert.equal(action.kind, 'file_request');
    assert.equal(action.message_id, sent.messageId);
  });
});
