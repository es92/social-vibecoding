'use strict';

// #3624: the Homeroom bot's DM against the full PostgreSQL schema.
//
// What only a real database can show: the bot's DM is a direct
// conversation both people are already in (no invitation), a person who
// blocked the bot gets none, a message's metadata is the platform's alone
// and reaches a reader only on the bot's own messages, a request's question
// lands in its requester's DM with its suggested answers, an answer given
// there is posted on the request and closes the question, the weekly
// allowance is summed per requester, and a project's description is filed
// as its first-version request once it runs. #3698: the bot's post on a
// request tags its requester exactly when their DM did not reach them, so
// the news reaches them once, and never somebody who blocked the bot.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Realtime and push are process-wide singletons: capture what the module
// hands them. handleMessage is the app-thread write a DM answer goes
// through; here it records the post and answers like the real one.
const events = [];
const threadPosts = [];
const issueUpdates = [];
const systemMessages = [];
let threadAllowed = true;
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds, payload) { events.push({ memberIds: [...memberIds], payload }); return memberIds.length; },
    pushToUser(userId, payload) { events.push({ userId, payload }); return 1; },
    pushNotificationToUser(userId, payload) { events.push({ userId, payload }); return 1; },
    async handleMessage(_pool, client, msg) {
      if (!threadAllowed) return { ok: false, code: 'not_collaborator' };
      threadPosts.push({ userId: client.user.id, appId: client.appId, msg });
      return { ok: true, message: { id: threadPosts.length } };
    },
    async sendSystemMessage(_pool, appId, content, msgType, metadata, thread) {
      systemMessages.push({ appId, content, thread });
      return { id: systemMessages.length };
    },
    // The bot's message in a request's thread, written as the real one
    // writes it, so a mention notification has a row to point at (#3698).
    async sendBotMessage(db, appId, { user: from, content, metadata = null, thread, msgType = 'message' }) {
      const { rows: [row] } = await db.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
        [appId, from.id, content, msgType, JSON.stringify(metadata || {}), thread.type, thread.ref],
      );
      return { id: row.id, createdAt: row.created_at };
    },
    pushIssueUpdate(data) { issueUpdates.push(data); },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

const conversations = require('../src/services/conversations');
const dm = require('../src/services/homeroom-bot-dm');
const homeroomBot = require('../src/services/homeroom-bot');

test('the Homeroom bot DM against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_dm_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  async function setting(key, value) {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url)
     VALUES ('Seed swap', 'seed-swap', 'running', $1, 'https://github.com/usernode-bot/seed-swap') RETURNING *`,
    [ada.id],
  );

  await t.test('schema: the settings are seeded, and the DM index and briefs are private', async () => {
    const { rows } = await pool.query(
      `SELECT key, value FROM platform_settings
        WHERE key IN ('homeroom_bot_dm_users', 'homeroom_bot_user_weekly_cents') ORDER BY key`,
    );
    assert.deepEqual(rows, [
      { key: 'homeroom_bot_dm_users', value: '[]' },
      { key: 'homeroom_bot_user_weekly_cents', value: '5000' },
    ]);
    for (const table of ['homeroom_bot_dm_messages', 'homeroom_bot_first_versions', 'homeroom_bot_dm_projects']) {
      const { rows: [c] } = await pool.query(`SELECT obj_description('${table}'::regclass, 'pg_class') AS comment`);
      assert.equal(c.comment, 'staging:private', table);
    }
  });

  await t.test('the bot\'s DM opens with both people in it, once, and never for somebody who blocked it', async () => {
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    assert.equal(opened.created, true);
    const again = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    assert.equal(again.conversationId, opened.conversationId, 'one DM per person');
    assert.equal(again.created, false);
    const { rows: members } = await pool.query(
      'SELECT user_id, status FROM conversation_members WHERE conversation_id = $1 ORDER BY user_id',
      [opened.conversationId],
    );
    assert.deepEqual(members.map((m) => m.status), ['member', 'member'], 'nobody is left invited');
    const { rows: invites } = await pool.query(
      `SELECT 1 FROM notifications WHERE conversation_id = $1 AND kind = 'conversation_invite'`, [opened.conversationId],
    );
    assert.equal(invites.length, 0, 'and nobody is asked to accept');

    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [sam.id, bot.id]);
    assert.equal(await conversations.ensureAdmittedDirect(pool, bot.id, sam.id), null, 'blocking the bot turns it off');
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1', [sam.id]);
  });

  await t.test('a person opening a DM with the bot gets the same conversation, already open', async () => {
    const mine = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const asked = await conversations.createDirect(pool, ada, bot.id);
    assert.equal(asked.conversationId, mine.conversationId);
    assert.deepEqual(asked.notifications, []);
  });

  await t.test('metadata is the platform\'s: written beside the input, read only on the bot\'s messages', async () => {
    const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const fromBot = await conversations.sendMessage(pool, { id: bot.id }, conversationId, { content: 'Which colour?' }, {
      metadata: { homeroomBot: { kind: 'question', answers: ['Green', 'Blue'], status: 'open' } },
    });
    assert.deepEqual(fromBot.message.metadata, { homeroomBot: { kind: 'question', answers: ['Green', 'Blue'], status: 'open' } });
    assert.equal(fromBot.message.sender.bot, true, 'the bot is marked as one');
    // A request body that carries metadata (the route spreads req.body
    // into the input) writes none.
    const fromAda = await conversations.sendMessage(pool, ada, conversationId, {
      content: 'Green', metadata: { homeroomBot: { kind: 'question' } },
    });
    assert.equal(fromAda.message.metadata, undefined);
    assert.equal(fromAda.message.sender.bot, undefined);
    const { rows: [stored] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [fromAda.message.id]);
    assert.deepEqual(stored.metadata, {});
  });

  await t.test('#3707: the bot quotes the message it answers: only the person\'s own, in their DM, still there to read', async () => {
    const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const asked = await conversations.sendMessage(pool, ada, conversationId, { content: 'Can you sort my list?' });
    // B4: an answer to what she wrote rings as a reply.
    const answered = await dm.sendDm(pool, { bot, userId: ada.id, content: 'On it.', replyToId: asked.message.id, moment: 'reply' });
    const said = await conversations.getMessage(pool, ada, conversationId, answered.messageId);
    assert.equal(said.reply.id, asked.message.id);
    assert.equal(said.reply.content, 'Can you sort my list?');
    assert.equal(said.reply.sender.id, ada.id);
    const { rows: [bell] } = await pool.query(
      'SELECT kind, detail FROM notifications WHERE user_id = $1 AND conversation_message_id = $2', [ada.id, answered.messageId],
    );
    assert.equal(bell.kind, 'conversation_reply', 'she hears the bot replied to her, as from a person');
    assert.equal(bell.detail, 'hrbot:reply:', 'worded as the bot\'s answer');

    // Anything else is left off, never the message.
    const samDm = await conversations.ensureAdmittedDirect(pool, bot.id, sam.id);
    const elsewhere = await conversations.sendMessage(pool, sam, samDm.conversationId, { content: 'Not Ada\'s' });
    const deleted = await conversations.sendMessage(pool, ada, conversationId, { content: 'Never mind' });
    await conversations.deleteMessage(pool, ada, conversationId, deleted.message.id);
    for (const [why, replyToId] of [
      ['a message in another conversation', elsewhere.message.id],
      ['the bot\'s own message', answered.messageId],
      ['a message she deleted', deleted.message.id],
      ['no message at all', 'x'],
    ]) {
      const sent = await dm.sendDm(pool, { bot, userId: ada.id, content: `Plain: ${why}`, replyToId });
      assert.ok(sent?.messageId, why);
      const msg = await conversations.getMessage(pool, ada, conversationId, sent.messageId);
      assert.equal(msg.content, `Plain: ${why}`, why);
      assert.equal(msg.reply, null, why);
    }
  });

  await t.test('nothing reaches a DM for somebody who is not on the list', async () => {
    await setting('homeroom_bot_mode', 'shadow');
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 7, $2, 'Sort by date')`,
      [app.id, ada.id],
    );
    const sent = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 1, bot,
      dm: { question: 'Newest first?', answers: ['Newest first', 'Oldest first'] },
    });
    assert.equal(sent, null);
  });

  await t.test('a question reaches its requester\'s DM with the answers to tap, and an answer is posted on the request', async () => {
    await setting('homeroom_bot_dm_users', JSON.stringify([ada.username]));
    assert.deepEqual(await dm.dmRecipient(pool, app.id, 7), { userId: ada.id, username: ada.username },
      'she is told in her DM, so the post on the request leaves her untagged');
    const sent = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 2, bot,
      dm: { question: 'Newest first?', answers: ['Newest first', 'Oldest first'] },
    });
    assert.ok(sent.messageId);
    const message = await conversations.getMessage(pool, ada, sent.conversationId, sent.messageId);
    assert.match(message.content, /Seed swap.*request #7: Sort by date/);
    assert.match(message.content, /Newest first\?/);
    assert.deepEqual(message.metadata.homeroomBot.answers, ['Newest first', 'Oldest first']);
    assert.equal(message.metadata.homeroomBot.status, 'open');
    assert.equal(message.metadata.homeroomBot.mirrors, true, 'the reader is told answers are public');
    assert.equal(message.reply, null, 'a request filed on its page did not start in the DM: nothing to quote');

    // The same post relayed twice (a retry) sends once.
    const retry = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 2, bot,
      dm: { question: 'Newest first?', answers: ['Newest first'] },
    });
    assert.equal(retry.messageId, sent.messageId);

    // Ada taps "Oldest first": an ordinary message quoting the question.
    const answer = await conversations.sendMessage(pool, ada, sent.conversationId, {
      content: 'Oldest first', reply_to_id: sent.messageId,
    });
    threadPosts.length = 0;
    const from = events.length;
    const ack = await dm.noteUserMessage(pool, {}, { user: ada, conversationId: sent.conversationId, message: answer.message });
    // #3684: the bot typed in her DM while it answered, through the same
    // audience gate as a person's typing, and stopped once the answer was out.
    const order = events.slice(from).filter((e) => e.payload.conversationId === sent.conversationId)
      .map((e) => (e.payload.type === 'conversation_typing' ? `typing:${e.payload.typing}` : e.payload.type));
    assert.equal(order[0], 'typing:true');
    assert.equal(order.at(-1), 'typing:false');
    assert.ok(order.lastIndexOf('conversation_message_created') < order.indexOf('typing:false'), 'stopped after the answer');
    const typed = events.slice(from).find((e) => e.payload.type === 'conversation_typing');
    assert.equal(typed.payload.userId, bot.id);
    assert.ok(typed.memberIds.includes(ada.id), 'to her');
    assert.equal(threadPosts.length, 1, 'posted on the request');
    assert.equal(threadPosts[0].userId, ada.id, 'as her own message');
    assert.deepEqual(threadPosts[0].msg.thread, { type: 'issue', ref: 7 });
    assert.match(threadPosts[0].msg.content, /^Oldest first\n\n\(Answered in a chat with Homeroom bot\.\)$/);
    const after = await conversations.getMessage(pool, ada, sent.conversationId, sent.messageId);
    assert.equal(after.metadata.homeroomBot.status, 'answered');
    assert.equal(after.metadata.homeroomBot.answer, 'Oldest first');
    const thanks = await conversations.getMessage(pool, ada, sent.conversationId, ack.messageId);
    assert.match(thanks.content, /public discussion/, 'and the bot says where it went');
    assert.equal(thanks.reply.id, answer.message.id, 'quoting the answer it took');
  });

  await t.test('the verdicts export says whether a run\'s question reached the DM, and whether it was answered there', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 8, $2, 'Dark mode')`,
      [app.id, ada.id],
    );
    const { rows: [asked] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, question, question_answers)
       VALUES ($1, 8, 'live', 'question', 'Follow the system setting?', $2) RETURNING id`,
      [app.id, JSON.stringify(['Follow the system', 'Always dark', 'A toggle'])],
    );
    const { rows: [quiet] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, question, question_answers)
       VALUES ($1, 8, 'live', 'question', 'Which page?', $2) RETURNING id`,
      [app.id, JSON.stringify(['Home'])],
    );
    const sent = await dm.relayIssuePost({
      pool, app, issueNumber: 8, kind: 'question', runId: asked.id, postId: 81, bot,
      dm: { question: 'Follow the system setting?', answers: ['Follow the system', 'Always dark', 'A toggle'] },
    });
    const exported = async () => {
      const rows = [];
      for await (const chunk of homeroomBot.iterateRunsForExport(pool, { app: app.slug })) rows.push(...chunk);
      const cols = homeroomBot.EXPORT_COLUMNS;
      const pick = (id, col) => homeroomBot.exportRow(rows.find((r) => r.id === id))[cols.indexOf(col)];
      return { pick };
    };
    let { pick } = await exported();
    assert.equal(pick(asked.id, 'question_answers'), 'Follow the system | Always dark | A toggle');
    assert.match(pick(asked.id, 'dm_sent_at'), /^\d{4}-\d\d-\d\dT/, 'sent to her DM');
    assert.equal(pick(asked.id, 'dm_answered_at'), '', 'not answered yet');
    assert.equal(pick(quiet.id, 'dm_sent_at'), '', 'a run whose news never reached a DM');
    assert.equal(pick(quiet.id, 'question_answers'), 'Home');

    const answer = await conversations.sendMessage(pool, ada, sent.conversationId, {
      content: 'Always dark', reply_to_id: sent.messageId,
    });
    await dm.noteUserMessage(pool, {}, { user: ada, conversationId: sent.conversationId, message: answer.message });
    ({ pick } = await exported());
    assert.match(pick(asked.id, 'dm_answered_at'), /^\d{4}-\d\d-\d\dT/, 'answered from the DM');
    const cols = homeroomBot.EXPORT_COLUMNS;
    assert.ok(cols.indexOf('question_answers') > cols.indexOf('build_session_id'), 'appended after every older column');
  });

  // #3624 stage 2: with the model on (the default), a message that does not
  // quote the bot is read by it (homeroom-bot-mayor-postgres.test.js). These
  // two are the stage-1 path, which the switch below still gives.
  await t.test('newer news on a request closes its open question; a reply with nothing open gets the help', async () => {
    await setting('homeroom_bot_dm_chat', 'off');
    const asked = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 3, bot, dm: { question: 'Show dates?', answers: ['Yes'] },
    });
    await dm.relayIssuePost({ pool, app, issueNumber: 7, kind: 'spec', postId: 4, bot, dm: { building: true } });
    const closed = await conversations.getMessage(pool, ada, asked.conversationId, asked.messageId);
    assert.equal(closed.metadata.homeroomBot.status, 'closed');
    const hello = await conversations.sendMessage(pool, ada, asked.conversationId, { content: 'hello?' });
    threadPosts.length = 0;
    const help = await dm.noteUserMessage(pool, {}, { user: ada, conversationId: asked.conversationId, message: hello.message });
    assert.equal(threadPosts.length, 0, 'nothing is posted on a request');
    const text = await conversations.getMessage(pool, ada, asked.conversationId, help.messageId);
    assert.equal(text.content, dm.HELP_TEXT);
    assert.equal(text.reply.id, hello.message.id);
  });

  await t.test('with the model on, free text goes to it; a reply quoting a question still goes to the request', async () => {
    await setting('homeroom_bot_dm_chat', 'on');
    const asked = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 31, bot, dm: { question: 'Font?', answers: ['Serif'] },
    });
    const turns = [];
    const mayor = {
      async decideOffer() { return null; },
      async runDmTurn(_pool, _config, args) { turns.push(args.message.content); return { model: true }; },
    };
    const free = await conversations.sendMessage(pool, ada, asked.conversationId, { content: 'what are you working on?' });
    threadPosts.length = 0;
    assert.deepEqual(await dm.noteUserMessage(pool, {}, { user: ada, conversationId: asked.conversationId, message: free.message, deps: { mayor } }), { model: true });
    assert.deepEqual(turns, ['what are you working on?']);
    assert.equal(threadPosts.length, 0, 'a question to the bot is not posted on a request as an answer');
    const quoting = await conversations.sendMessage(pool, ada, asked.conversationId, { content: 'Serif', reply_to_id: asked.messageId });
    await dm.noteUserMessage(pool, {}, { user: ada, conversationId: asked.conversationId, message: quoting.message, deps: { mayor } });
    assert.deepEqual(turns, ['what are you working on?'], 'a tapped answer never waits on the model');
    assert.equal(threadPosts.length, 1);
    const { rows: [queued] } = await pool.query(
      'SELECT priority, reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 7', [app.id],
    );
    assert.deepEqual(queued, { priority: 0, reason: 'dm_answer' }, 'an answer puts its request at the front of the queue');
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
  });

  await t.test('an answer the request cannot take (not a member) is said, and the question stays open', async () => {
    await setting('homeroom_bot_dm_chat', 'off');
    const asked = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 5, bot, dm: { question: 'Colour?', answers: ['Green'] },
    });
    const reply = await conversations.sendMessage(pool, ada, asked.conversationId, { content: 'Green' });
    threadAllowed = false;
    try {
      const said = await dm.noteUserMessage(pool, {}, { user: ada, conversationId: asked.conversationId, message: reply.message });
      const text = await conversations.getMessage(pool, ada, asked.conversationId, said.messageId);
      assert.match(text.content, /couldn't post that/);
      assert.equal(text.reply.id, reply.message.id);
    } finally {
      threadAllowed = true;
    }
    const still = await conversations.getMessage(pool, ada, asked.conversationId, asked.messageId);
    assert.equal(still.metadata.homeroomBot.status, 'open');
    await setting('homeroom_bot_dm_chat', 'on');
  });

  await t.test('the weekly building time sums the runs each person pays for this week', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cost_usd, build_cost_usd)
       VALUES ($1, 7, 'live', 'ready', 0.40, 12.10), ($1, 7, 'live', 'question', 0.50, NULL)`,
      [app.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cost_usd, created_at)
       VALUES ($1, 7, 'live', 'ready', 99, NOW() - INTERVAL '14 days')`,
      [app.id],
    );
    assert.equal(await dm.weeklySpentCents(pool, ada.id), 1300, 'last week\'s run is not counted');
    assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 5000 }, ada.id), false);
    assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 1200 }, ada.id), true);
    assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 0 }, ada.id), false, '0 is no cap');
    assert.equal(await dm.weeklySpentCents(pool, sam.id), 0);

    // What the bot caused itself (a restart's look, fixing its own checks) is
    // nobody's building time; a look Sam asked for on Ada's request is his.
    const { rows: extra } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cost_usd, charged, payer_user_id)
       VALUES ($1, 7, 'live', 'ready', 3.00, FALSE, NULL), ($1, 7, 'live', 'ready', 2.00, TRUE, $2)
       RETURNING id`,
      [app.id, sam.id],
    );
    // And chatting is not building: her DM's answers never count.
    const { rows: [turn] } = await pool.query(
      `INSERT INTO homeroom_bot_dm_turns (user_id, cost_usd) VALUES ($1, 7.00) RETURNING id`,
      [ada.id],
    );
    assert.equal(await dm.weeklySpentCents(pool, ada.id), 1300, 'unchanged: neither the free run, his run nor her chat');
    assert.equal(await dm.weeklySpentCents(pool, sam.id), 200, 'whoever asks pays');
    assert.equal(await dm.allowanceLow(pool, { userWeeklyCents: 1500 }, ada.id), true, 'under a fifth of the week left');
    assert.equal(await dm.allowanceLow(pool, { userWeeklyCents: 5000 }, ada.id), false);
    await pool.query('DELETE FROM homeroom_bot_runs WHERE id = ANY($1::int[])', [extra.map((r) => r.id)]);
    await pool.query('DELETE FROM homeroom_bot_dm_turns WHERE id = $1', [turn.id]);
  });

  await t.test('a project\'s description is filed as its first version once it runs, under its creator', async () => {
    const { rows: [project] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ('Chore wheel', 'chore-wheel', 'creating', $1) RETURNING *`,
      [ada.id],
    );
    const started = await dm.startFirstVersion(pool, {}, {
      app: project, user: ada, brief: 'Who does the dishes this week, decided fairly for the four of us.',
    });
    assert.ok(started.conversationId, 'and the DM says so');
    const settings = await homeroomBot.readSettings(pool);
    assert.deepEqual(settings.firstVersionApps.sort(), ['chore-wheel'], 'live while its creator is on the list');

    const created = [];
    const github = {
      isEnabled: () => true,
      safeMention: (s) => s,
      async createIssue(owner, repo, body) { created.push({ owner, repo, ...body }); return { number: 1 }; },
      noteIssueCreated() {},
    };
    assert.equal(await dm.fileFirstVersion(pool, {}, project.id, { github }), null, 'not while it is being created');
    await pool.query(
      `UPDATE apps SET status = 'running', repo_url = 'https://github.com/usernode-bot/chore-wheel' WHERE id = $1`,
      [project.id],
    );
    const filed = await dm.fileFirstVersion(pool, {}, project.id, { github });
    assert.deepEqual(filed, { issueNumber: 1 });
    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'First version of Chore wheel');
    assert.match(created[0].body, /^\*\*Source:\*\* Homeroom user \(ada_\d+\)/);
    assert.match(created[0].body, /dishes this week/);
    const requester = await dm.requesterOf(pool, project.id, 1);
    assert.equal(requester.userId, ada.id);
    assert.equal(requester.firstVersion, true);
    const { rows: [issue] } = await pool.query('SELECT created_by FROM issues WHERE app_id = $1', [project.id]);
    assert.equal(issue.created_by, ada.id);
    assert.equal(await dm.fileFirstVersion(pool, {}, project.id, { github }), null, 'filed once');
    assert.equal(await dm.sweepFirstVersions(pool, {}, { github }), 0);

    await setting('homeroom_bot_dm_users', '[]');
    assert.deepEqual((await homeroomBot.readSettings(pool)).firstVersionApps, [], 'off the list, back to shadow');
  });

  await t.test('anybody else\'s description is filed as the first request too, and the bot is left out of it', async () => {
    // Sam is not on the DM list: the same record and filing, and nothing of
    // the bot's (no DM, no requester row, not live, no wake, no failure DM).
    await setting('homeroom_bot_dm_users', JSON.stringify([ada.username]));
    const { rows: [project] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ('Book club', 'book-club', 'creating', $1) RETURNING *`,
      [sam.id],
    );
    const before = events.length;
    const started = await dm.startFirstVersion(pool, {}, {
      app: project, user: sam, brief: 'Pick a book each month, read it together, and talk about it here.',
    });
    assert.equal(started, null, 'no DM to open');
    assert.equal(events.length, before, 'nothing pushed to anybody');
    const { rows: [recorded] } = await pool.query(
      'SELECT user_id, status, bot_builds FROM homeroom_bot_first_versions WHERE app_id = $1', [project.id],
    );
    assert.deepEqual(recorded, { user_id: sam.id, status: 'waiting', bot_builds: false });
    assert.ok(!(await homeroomBot.readSettings(pool)).firstVersionApps.includes('book-club'), 'not on the bot\'s live list');

    const woken = [];
    const realNote = homeroomBot.noteIssueActivity;
    homeroomBot.noteIssueActivity = (args) => { woken.push(args); };
    const created = [];
    const github = {
      isEnabled: () => true,
      safeMention: (x) => x,
      async createIssue(owner, repo, body) { created.push({ owner, repo, ...body }); return { number: 1 }; },
      noteIssueCreated() {},
    };
    try {
      await pool.query(
        `UPDATE apps SET status = 'running', repo_url = 'https://github.com/usernode-bot/book-club' WHERE id = $1`,
        [project.id],
      );
      issueUpdates.length = 0;
      const filed = await dm.sweepFirstVersions(pool, {}, { github });
      assert.equal(filed, 1, 'the sweep files it, the bot\'s or not');
    } finally {
      homeroomBot.noteIssueActivity = realNote;
    }
    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'First version of Book club');
    assert.match(created[0].body, /^\*\*Source:\*\* Homeroom user \(sam_\d+\)/);
    assert.match(created[0].body, /read it together/);
    assert.match(created[0].body, /sam_\d+ described this when they created the project\.$/);
    assert.doesNotMatch(created[0].body, /Homeroom bot/);
    const { rows: [issue] } = await pool.query('SELECT created_by FROM issues WHERE app_id = $1', [project.id]);
    assert.equal(issue.created_by, sam.id, 'under its creator');
    assert.equal(issueUpdates.length, 1, 'the board hears of it');
    assert.equal(await dm.requesterOf(pool, project.id, 1), null, 'no requester row: the bot\'s news has nowhere to go');
    assert.deepEqual(woken, [], 'the bot is not woken for it');
    const { rows: [after] } = await pool.query(
      'SELECT status, issue_number FROM homeroom_bot_first_versions WHERE app_id = $1', [project.id],
    );
    assert.deepEqual(after, { status: 'filed', issue_number: 1 });
    await setting('homeroom_bot_dm_users', '[]');
  });

  await t.test('a project somebody on the list imports, forks or makes without a description is live too, with nothing filed', async () => {
    await setting('homeroom_bot_dm_users', JSON.stringify([ada.username]));
    const make = async (slug, by) => (await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ($1, $1, 'creating', $2) RETURNING *`, [slug, by.id],
    )).rows[0];
    const imported = await make('ada-import', ada);
    const forked = await make('ada-fork', ada);
    const blank = await make('ada-blank', ada);
    const samImport = await make('sam-import', sam);
    assert.equal(await dm.noteProjectMade(pool, { app: imported, user: ada, origin: 'import' }), true);
    assert.equal(await dm.noteProjectMade(pool, { app: forked, user: ada, origin: 'fork' }), true);
    assert.equal(await dm.noteProjectMade(pool, { app: blank, user: ada, origin: 'blank' }), true);
    assert.equal(await dm.noteProjectMade(pool, { app: imported, user: ada, origin: 'import' }), false, 'recorded once');
    assert.equal(await dm.noteProjectMade(pool, { app: samImport, user: sam, origin: 'import' }), false, 'not on the list: nothing recorded');
    assert.equal(await dm.noteProjectMade(pool, { app: samImport, user: ada, origin: 'template' }), false, 'an origin it does not know');

    const settings = await homeroomBot.readSettings(pool);
    assert.deepEqual(settings.firstVersionApps, ['chore-wheel', 'ada-import', 'ada-fork', 'ada-blank'],
      'live while their maker is on the list, beside the project the bot builds from a description');
    const made = await dm.projectsMadeFor(pool, settings);
    assert.deepEqual(made.map((r) => [r.slug, r.username, r.origin]), [
      ['chore-wheel', ada.username, 'description'],
      ['ada-import', ada.username, 'import'],
      ['ada-fork', ada.username, 'fork'],
      ['ada-blank', ada.username, 'blank'],
    ], 'with who made each and how, for the dashboard');
    assert.ok(await dm.importedAt(pool, imported.id) instanceof Date, 'where an import\'s backlog ends');
    assert.equal(await dm.importedAt(pool, forked.id), null, 'a fork arrives with no issues to hold back');
    const { rows: filed } = await pool.query(
      'SELECT app_id FROM homeroom_bot_first_versions WHERE app_id = ANY($1::int[])', [[imported.id, forked.id, blank.id]],
    );
    assert.deepEqual(filed, [], 'nothing to file as a first request');

    // Triage again takes an import's backlog: past the live check (this one
    // has no repository yet), where somebody else's import is refused.
    assert.equal((await homeroomBot.retriageApp(pool, { slug: 'sam-import' })).status, 409);
    assert.equal((await homeroomBot.retriageApp(pool, { slug: 'ada-import' })).status, 404);

    await setting('homeroom_bot_dm_users', '[]');
    assert.deepEqual((await homeroomBot.readSettings(pool)).firstVersionApps, [], 'off the list, back to shadow');
  });

  await t.test('a staging preview has a bot DM with a question open, at its own address, once', async () => {
    const staging = require('../src/services/staging-messages');
    const env = process.env.USERNODE_ENV;
    process.env.USERNODE_ENV = 'staging';
    try {
      const viewer = await user('viewer');
      const first = await staging.resolveLegacyLink(pool, viewer, staging.BOT_DM_LEGACY_ID);
      const again = await staging.resolveLegacyLink(pool, viewer, staging.BOT_DM_LEGACY_ID);
      assert.equal(first, again);
      assert.notEqual(first, staging.BOT_DM_LEGACY_ID);
      const page = await conversations.listMessages(pool, viewer, first, {});
      const messages = page.messages || page;
      // #3624 stage 2: a question, and a request it offers to file. #3707:
      // the offer answers the viewer's ask, between them, and quotes it.
      // #3736: then two activity cards (tests/homeroom-bot-activity-postgres.test.js).
      assert.equal(messages.length, 5, 'one question, one ask, one offer and two cards, not one per visit');
      const [question, ask, offer, ...cards] = [...messages].sort((a, b) => a.id - b.id);
      assert.deepEqual(cards.map((m) => m.metadata.homeroomBot.kind), ['activity', 'activity']);
      assert.equal(question.metadata.homeroomBot.kind, 'question');
      assert.equal(question.metadata.homeroomBot.status, 'open');
      assert.deepEqual(question.metadata.homeroomBot.answers, ['Newest first', 'Oldest first', 'Let me pick each time']);
      assert.match(question.content, /Staging demo/);
      assert.equal(question.reply, null, 'news about a request filed elsewhere quotes nothing');
      assert.equal(ask.sender.id, viewer.id, 'the ask is the viewer\'s own');
      assert.match(ask.content, /^Staging demo: /);
      assert.equal(offer.metadata.homeroomBot.kind, 'confirm');
      assert.deepEqual(offer.metadata.homeroomBot.answers, ['File it', 'Not now']);
      assert.notEqual(offer.metadata.homeroomBot.mirrors, true, 'an offer posts nothing, so it says nothing is public');
      assert.match(offer.content, /Staging demo, add a dark mode/);
      assert.equal(offer.reply.id, ask.id, 'the offer quotes the ask it answers');
      assert.equal(offer.reply.content, ask.content);
      const { rows } = await pool.query('SELECT 1 FROM homeroom_bot_dm_messages WHERE user_id = $1', [viewer.id]);
      assert.equal(rows.length, 0, 'never a question the bot waits on: nothing is posted anywhere');
    } finally {
      if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
    }
  });

  await t.test('somebody not on the list who writes to the bot hears why it does not answer', async () => {
    const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, sam.id);
    const hi = await conversations.sendMessage(pool, sam, conversationId, { content: 'hi' });
    const from = events.length;
    const said = await dm.noteUserMessage(pool, {}, { user: sam, conversationId, message: hi.message });
    const text = await conversations.getMessage(pool, sam, conversationId, said.messageId);
    assert.equal(text.content, dm.NOT_ENABLED_TEXT);
    assert.equal(text.reply.id, hi.message.id);
    assert.ok(!events.slice(from).some((e) => e.payload.type === 'conversation_typing'), 'no typing for a canned line');
  });

  await t.test('#3698: the post on a request tags its requester exactly when their DM did not reach them, never one who blocked the bot', async () => {
    const live = require('../src/services/homeroom-bot-live');
    const io = require('../src/services/ws');
    const github = { async createIssueComment() { return { id: 1, created_at: '2026-10-02T12:00:00Z' }; } };
    const repo = { owner: 'usernode-bot', repo: 'seed-swap' };
    const told = await user('told');
    const failed = await user('failed');
    const gone = await user('gone');
    const blocker = await user('blocker');
    const unrecorded = await user('unrecorded');
    await setting('homeroom_bot_dm_users', JSON.stringify([told, failed, gone, blocker, unrecorded].map((p) => p.username)));

    // One request per requester, its news posted the way a live verdict
    // posts it: tagging whoever filed it and whoever took part (Sam).
    let issueNumber = 3698;
    const postFor = async (requester, db = pool) => {
      issueNumber += 1;
      await pool.query(
        `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, 'Tags')`,
        [app.id, issueNumber, requester.id],
      );
      const posted = await live.post({
        pool: db, github, ws: io, app, repo, issueNumber, kind: 'spec', text: 'Building it now.',
        sender: bot, senderId: bot.id, mentions: [requester.username, sam.username], dm: { building: true },
      });
      assert.equal(posted.thread, true);
      const { rows: [thread] } = await pool.query(
        `SELECT id, content FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2`,
        [app.id, issueNumber],
      );
      // Everything that rang for the requester (nothing else ever did), and
      // what rang for Sam on this post.
      const { rows: bells } = await pool.query(
        'SELECT kind, chat_message_id, conversation_message_id FROM notifications WHERE user_id = $1 ORDER BY id',
        [requester.id],
      );
      const { rows: samBells } = await pool.query(
        'SELECT kind FROM notifications WHERE user_id = $1 AND chat_message_id = $2', [sam.id, thread.id],
      );
      assert.deepEqual(samBells.map((b) => b.kind), ['mention'], 'everybody else on the post is tagged as before');
      const { rows: dms } = await pool.query(
        `SELECT m.id FROM conversation_messages m
           JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
          WHERE m.sender_id = $2`,
        [requester.id, bot.id],
      );
      return { thread, bells, dms: dms.map((r) => r.id) };
    };
    const onlyDm = (seen, why) => {
      assert.equal(seen.thread.content, `@${sam.username} Building it now.`, `${why}: not tagged on the request`);
      assert.equal(seen.dms.length, 1, `${why}: told in the DM`);
      // B4: "I'm building it now" is progress, not one of the moments that
      // ring: told in the DM, it rings nothing, and the post tags nobody.
      assert.deepEqual(seen.bells, [], `${why}: no bell, the DM is where it is`);
    };
    const onlyMention = (seen, who, why) => {
      assert.equal(seen.thread.content, `@${who.username} @${sam.username} Building it now.`, `${why}: tagged on the request`);
      assert.deepEqual(seen.dms, [], `${why}: nothing in a DM`);
      assert.deepEqual(seen.bells, [{ kind: 'mention', chat_message_id: seen.thread.id, conversation_message_id: null }],
        `${why}: one bell, the post's mention`);
    };

    // The DM reached them: it is where the news rings, and only there.
    onlyDm(await postFor(told), 'told in the DM');

    // The relay failed: the post's mention is how the news reaches them.
    const relay = dm.relayIssuePost;
    dm.relayIssuePost = async () => { throw new Error('relay down'); };
    try {
      onlyMention(await postFor(failed), failed, 'the relay threw');
    } finally {
      dm.relayIssuePost = relay;
    }

    // They left the bot's DM: the bot does not open it again for news, so
    // the post tags them.
    const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, gone.id);
    assert.ok(await conversations.leave(pool, gone, conversationId));
    onlyMention(await postFor(gone), gone, 'left the bot\'s DM');

    // They blocked the bot: nothing from it, here or in a DM.
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [blocker.id, bot.id]);
    const blocked = await postFor(blocker);
    assert.equal(blocked.thread.content, `@${sam.username} Building it now.`, 'not tagged');
    assert.deepEqual(blocked.dms, [], 'no DM');
    assert.deepEqual(blocked.bells, [], 'and nothing rings');

    // The DM reached them but could not be recorded after: it still did,
    // so the post must not ring a second time.
    const flaky = {
      query: (sql, params) => (/INSERT INTO homeroom_bot_dm_messages/.test(String(sql))
        ? Promise.reject(new Error('could not record')) : pool.query(sql, params)),
      connect: () => pool.connect(),
    };
    onlyDm(await postFor(unrecorded, flaky), 'told, but not recorded');

    await setting('homeroom_bot_dm_users', '[]');
  });

  // WP1 (#6): on 3 October a second build of Plant Pal #1 said "I'm building
  // this now" in the DM after the first build had said "It's built". A
  // build's news that something newer answered or overtook is not sent, and
  // the post on the request does not ring for it either.
  await t.test('WP1 (#6): a build\'s news is not sent once another proposal answers its request, or a newer look overtook it', async () => {
    const live = require('../src/services/homeroom-bot-live');
    const io = require('../src/services/ws');
    const github = { async createIssueComment() { return { id: 1, created_at: '2026-10-03T16:48:00Z' }; } };
    const repo = { owner: 'usernode-bot', repo: 'seed-swap' };
    const pip = await user('pip');
    await setting('homeroom_bot_dm_users', JSON.stringify([pip.username]));
    const requester = (issueNumber) => pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, 'Watering log')`,
      [app.id, issueNumber, pip.id],
    );
    const runOf = async (issueNumber, { verdict = 'ready', proposal = null, ago = 0 } = {}) => (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, created_at)
       VALUES ($1, $2, 'live', $3, $4, NOW() - make_interval(secs => $5)) RETURNING id`,
      [app.id, issueNumber, verdict, proposal, ago],
    )).rows[0].id;
    const proposalOf = async (issueNumber, status) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, linked_issues, promoted_at)
       VALUES ($1, $2, 'dev/homeroom_bot-x', $3, $4, NOW()) RETURNING id`,
      [app.id, bot.id, status, [issueNumber]],
    )).rows[0].id;
    const dms = async () => (await pool.query(
      `SELECT m.content FROM conversation_messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
        WHERE m.sender_id = $2 ORDER BY m.id`,
      [pip.id, bot.id],
    )).rows.map((r) => r.content);
    const bells = async () => (await pool.query('SELECT kind FROM notifications WHERE user_id = $1', [pip.id])).rows;

    // Run A built request #3783 and its proposal is up for a vote; run B, a
    // second build of the same request, then wrote its plan.
    await requester(3783);
    const first = await proposalOf(3783, 'promoted');
    const a = await runOf(3783, { proposal: first, ago: 600 });
    const b = await runOf(3783, { ago: 300 });
    const stale = await dm.relayIssuePost({ pool, app, issueNumber: 3783, kind: 'spec', runId: b, postId: 37831, bot, dm: { building: true } });
    assert.deepEqual({ stale: stale.stale, messageId: stale.messageId, username: stale.username },
      { stale: true, messageId: null, username: pip.username });
    assert.equal(await dm.untaggedRequester(pool, { appId: app.id, issueNumber: 3783, bot, told: stale }), pip.username,
      'the post on the request leaves her untagged too');
    for (const [kind, extra] of [['proposal', { link: 'https://x/6191', sessionId: 6191 }], ['build_failed', { reason: 'x' }]]) {
      const sent = await dm.relayIssuePost({ pool, app, issueNumber: 3783, kind, runId: b, postId: 37832, bot, dm: extra });
      assert.equal(sent.stale, true, kind);
    }
    assert.deepEqual(await dms(), [], 'none of the second build\'s news reached her');
    // Said through the post, as a live build says it: on the request, and
    // never rung for her.
    const posted = await live.post({
      pool, github, ws: io, app, repo, issueNumber: 3783, kind: 'spec', runId: b, text: 'Building it now.',
      sender: bot, senderId: bot.id, mentions: [pip.username, sam.username], dm: { building: true },
    });
    assert.equal(posted.thread, true);
    const { rows: [thread] } = await pool.query(
      `SELECT content FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 3783`, [app.id],
    );
    assert.equal(thread.content, `@${sam.username} Building it now.`);
    assert.deepEqual(await bells(), []);
    assert.deepEqual(await dms(), []);

    // Run A's own proposal is still told, though run B is newer: it is the
    // one people vote on, and its news must reach her (B4: once it is ready
    // to try, its checks passed).
    await pool.query(`UPDATE chat_sessions SET check_state = 'passing' WHERE id = $1`, [first]);
    const told = await dm.relayIssuePost({
      pool, app, issueNumber: 3783, kind: 'proposal', runId: a, postId: 37833, bot,
      dm: { link: `https://app.onhomeroom.com/#app/seed-swap/dev/proposals/${first}`, sessionId: first },
    });
    assert.ok(told.messageId);
    assert.equal(told.stale, undefined);
    assert.equal((await dms()).length, 1);

    // A proposal merged before this run's verdict is an earlier change, not
    // an answer to this one: its news goes out.
    await requester(3784);
    const earlier = await proposalOf(3784, 'merged');
    await pool.query(`UPDATE chat_sessions SET merged_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [earlier]);
    await runOf(3784, { proposal: earlier, ago: 86400 * 2 });
    const later = await runOf(3784);
    const going = await dm.relayIssuePost({ pool, app, issueNumber: 3784, kind: 'spec', runId: later, postId: 37841, bot, dm: { building: true } });
    assert.ok(going.messageId, 'a later request on the same issue is news');

    // A plan or a failure a newer look overtook is not sent; with no other
    // proposal anywhere, the run's own proposal is.
    await requester(3785);
    const overtaken = await runOf(3785, { ago: 300 });
    await runOf(3785, { verdict: 'question' });
    assert.equal((await dm.relayIssuePost({ pool, app, issueNumber: 3785, kind: 'spec', runId: overtaken, postId: 37851, bot, dm: { building: true } })).stale, true);
    assert.equal((await dm.relayIssuePost({ pool, app, issueNumber: 3785, kind: 'build_failed', runId: overtaken, postId: 37852, bot, dm: { reason: 'x' } })).stale, true);
    assert.ok((await dm.relayIssuePost({ pool, app, issueNumber: 3785, kind: 'proposal', runId: overtaken, postId: 37853, bot, dm: { link: 'https://x/1' } })).messageId);
    await setting('homeroom_bot_dm_users', '[]');
  });

  // WP1 (#9): a build a restart interrupted is started again, and its
  // requester hears it once, so the card going back a step is no mystery.
  await t.test('WP1 (#9): a build started again after a restart is said once, in plain words', async () => {
    const kit = await user('kit');
    await setting('homeroom_bot_dm_users', JSON.stringify([kit.username]));
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 3786, $2, 'Reminders')`,
      [app.id, kit.id],
    );
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, 3786, 'live', 'ready') RETURNING id`, [app.id],
    );
    const sent = await dm.noteBuildRestarted(pool, { app, issueNumber: 3786, runId: run.id });
    assert.ok(sent.messageId);
    const message = await conversations.getMessage(pool, kit, sent.conversationId, sent.messageId);
    assert.equal(message.content, `**Seed swap** · request #3786: Reminders\n\n${dm.RESTARTED_TEXT}`);
    assert.equal(dm.RESTARTED_TEXT, 'My build was interrupted, so I\'ve started it again. Nothing you need to do.');
    assert.equal(message.metadata.homeroomBot.kind, 'restarted');
    const { rows: [keyed] } = await pool.query('SELECT idempotency_key FROM conversation_messages WHERE id = $1', [sent.messageId]);
    assert.equal(keyed.idempotency_key, `hrbot-restart-${run.id}`);
    const again = await dm.noteBuildRestarted(pool, { app, issueNumber: 3786, runId: run.id });
    assert.equal(again.messageId, sent.messageId, 'once per run');
    assert.equal(again.duplicate, true);
    await setting('homeroom_bot_dm_users', '[]');
    assert.equal(await dm.noteBuildRestarted(pool, { app, issueNumber: 3786, runId: run.id + 1 }), null, 'nobody the bot DMs, nothing sent');
  });
});
