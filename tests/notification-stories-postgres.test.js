'use strict';

// #5580: the bell's stories, against the full PostgreSQL schema.
//
// The sheet stacks a project's notifications and folds one request's news
// into one card, and a card opens to what happened there. What only a real
// database can show:
//
//   1. The Homeroom bot's news about a request rings with that request's
//      project on the row (homeroom-bot-dm.js storyAppId through
//      conversations.sendMessage), and so does its reply in that request's
//      thread, found by the thread's card. The bell's read serializes them
//      with the project and the request, and the bot's reply about a
//      project is counted, not left to Messages as a plain message is.
//   2. A message in a proposal's discussion is about that proposal and the
//      request it was made from (STORY_COLUMNS_SQL).
//   3. The history (services/story-history.js) is the request's discussion
//      and its proposals', newest first, in steps.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Realtime and push are process-wide singletons the send path reaches.
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushIssueUpdate() {},
    async sendSystemMessage() { return { id: 0 }; },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

test('the bell\'s stories against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `notif_stories_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(`ALTER TABLE users ALTER COLUMN contact_policy SET DEFAULT 'anyone',
                                      ALTER COLUMN profile_discoverable SET DEFAULT TRUE`);

  const notifications = require('../src/services/notifications');
  const storyHistory = require('../src/services/story-history');
  const dm = require('../src/services/homeroom-bot-dm');

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ($1, 'x', TRUE, $2) RETURNING id, username, has_platform_access AS "hasPlatformAccess"`,
    [username, synthetic],
  )).rows[0];
  const bot = await user('homeroom_bot', true);
  const ada = await user('ada_stories');
  const ben = await user('ben_stories');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ('Seed swap', 'seed-swap-stories', 'running', $1) RETURNING *`,
    [ada.id],
  );
  const listed = async () => (await notifications.listForUser(pool, ada.id, { limit: 50 }))
    .map(notifications.serialize);

  await t.test('the bot\'s news about a request carries its project and its request', async () => {
    const sent = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'The plant shelf is live.', moment: 'live',
      metadata: { kind: 'merged', appSlug: app.slug, appName: app.name, issueNumber: 5580, issueTitle: 'Plant shelf' },
    });
    assert.ok(sent && sent.messageId, 'the DM was sent');
    const { rows: [row] } = await pool.query(
      'SELECT app_id, kind FROM notifications WHERE user_id = $1 AND conversation_message_id = $2', [ada.id, sent.messageId],
    );
    assert.equal(Number(row.app_id), app.id, 'the row is filed under the request\'s project');

    const bell = (await listed()).find((n) => n.conversationMessageId === sent.messageId);
    assert.ok(bell, 'the bell lists it');
    assert.equal(bell.appId, app.id);
    assert.equal(bell.appSlug, app.slug);
    assert.equal(bell.appName, 'Seed swap');
    assert.equal(bell.storyIssueNumber, 5580, 'and it is about request #5580');
    assert.ok(bell.conversationId, 'it still routes as the conversation row it is');
  });

  await t.test('a plain direct message stays the conversation\'s, with no project', async () => {
    const conversations = require('../src/services/conversations');
    const direct = await conversations.createDirect(pool, ben, ada.id);
    const conversationId = direct.conversationId || direct.conversation?.id;
    // A stranger's first message is an invitation; she takes it.
    await conversations.respond(pool, ada, conversationId, 'accept');
    const said = await conversations.sendMessage(pool, ben, conversationId, { content: 'lunch?' });
    assert.ok(said && !said.error, 'sent');
    const { rows: [row] } = await pool.query(
      `SELECT app_id FROM notifications WHERE user_id = $1 AND conversation_id = $2 AND kind = 'conversation_message'`,
      [ada.id, conversationId],
    );
    assert.equal(row.app_id, null);
    const bell = (await listed()).find((n) => n.conversationId === conversationId);
    assert.equal(bell.appId, null, 'a person\'s message never carries a project');
    assert.equal(bell.storyIssueNumber, null);
    // The bell leaves plain messages to Messages (#18) and counts the bot's
    // news about a project.
    const split = await notifications.countUnreadSplit(pool, ada.id);
    assert.equal(split.messageUnread, 1, 'one plain message: Ben\'s');
    assert.ok(split.unread >= 2);
    const unreadOnly = await notifications.listForUser(pool, ada.id, { limit: 50, unreadOnly: true });
    assert.ok(!unreadOnly.some((n) => n.conversation_id === conversationId), 'not on Unread');
    assert.ok(unreadOnly.some((n) => Number(n.app_id) === app.id && n.conversation_id), 'the bot\'s news is');
  });

  // The request's story: its discussion and its proposal's.
  const at = (minutes) => new Date(Date.UTC(2026, 9, 20, 10, minutes));
  const line = async ({ userId = null, content, msgType = 'message', metadata = null, type, ref, minutes }) => (await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [app.id, userId, content, msgType, JSON.stringify(metadata || {}), type, ref, at(minutes)],
  )).rows[0].id;
  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, pr_number, pr_title, created_from_issue_number, status)
     VALUES ($1, $2, 5590, 'Plant shelf, on the home screen', 5580, 'active') RETURNING id`,
    [app.id, ben.id],
  );

  await t.test('a message in a proposal\'s discussion is about it and its request', async () => {
    const msg = await line({ userId: ben.id, content: '@ada_stories does this look right?', type: 'session', ref: session.id, minutes: 30 });
    await pool.query(
      `INSERT INTO notifications (user_id, kind, app_id, chat_message_id, source_user_id, created_at)
       VALUES ($1, 'mention', $2, $3, $4, $5)`, [ada.id, app.id, msg, ben.id, at(30)],
    );
    const bell = (await listed()).find((n) => n.chatMessageId === msg);
    assert.ok(bell, 'listed');
    assert.equal(bell.storySessionId, session.id, 'the proposal whose discussion it is in');
    assert.equal(bell.storyIssueNumber, 5580, 'and the request it was made from');
    assert.equal(bell.storyPrNumber, 5590);
    assert.equal(bell.storyTitle, 'Plant shelf, on the home screen');
  });

  await t.test('the history is both discussions, newest first, in steps', async () => {
    await line({ content: 'ada_stories created issue: Plant shelf', msgType: 'system', type: 'issue', ref: 5580, minutes: 1 });
    await line({ userId: ben.id, content: 'I can take this one.', type: 'issue', ref: 5580, minutes: 5 });
    await line({ content: 'ben_stories promoted #5590 for a vote', msgType: 'vote', type: 'session', ref: session.id, minutes: 20 });
    await line({ content: 'Automated checks are running on the staging preview', msgType: 'system', type: 'session', ref: session.id, minutes: 21 });
    await line({
      content: 'ada_stories voted yes on #5590', msgType: 'vote', type: 'session', ref: session.id, minutes: 40,
      metadata: { vote: { reason: 'Works on my phone' } },
    });
    await line({ content: '#5590 was merged', msgType: 'system', type: 'session', ref: session.id, minutes: 50, metadata: { merged: true } });
    // Another request's discussion is not this story.
    await line({ userId: ben.id, content: 'Unrelated', type: 'issue', ref: 6000, minutes: 45 });

    const bell = (await listed()).find((n) => n.storyIssueNumber === 5580 && n.conversationId);
    const row = await notifications.getForUser(pool, ada.id, bell.id);
    const story = await storyHistory.storyOf(pool, row);
    assert.equal(story.issueNumber, 5580, 'the bot\'s row names its request in its detail');
    const history = await storyHistory.historyFor(pool, { appId: app.id, ...story });
    assert.equal(history.issueNumber, 5580);
    assert.deepEqual(history.sessionIds, [session.id], 'the proposal made from it');
    assert.deepEqual(history.steps.map((s) => s.kind),
      ['live', 'vote', 'comment', 'proposed', 'comment', 'asked'],
      'newest first, with the platform\'s working lines left out');
    const vote = history.steps.find((s) => s.kind === 'vote');
    assert.deepEqual({ actor: vote.actor, vote: vote.vote, words: vote.words },
      { actor: 'ada_stories', vote: 'yes', words: 'Works on my phone' });
    assert.equal(history.steps.find((s) => s.kind === 'proposed').actor, 'ben_stories');
    assert.equal(history.steps.at(-1).actor, 'ada_stories', 'she asked for it');
    assert.ok(!history.steps.some((s) => s.words === 'Unrelated'));
  });
});
