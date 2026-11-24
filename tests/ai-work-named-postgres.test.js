'use strict';

// Mobile 04 (24 Nov 2026, Evan): every thread you are in is on the Homeroom
// bot tab, and being named with @ is Needs you until you answer or dismiss
// it. Against the FULL PostgreSQL schema in a throwaway database:
// services/ai-work.js (threadsInSql, THREADS_SQL, standing, workFor),
// services/thread-mentions.js (NAMED_SQL, dismiss), services/ai-history.js,
// the Needs you feed (routes/workshop-overview.js ?in=threads) and the
// Dismiss route (routes/ai-work.js).
//
// What this pins, the brief's "Done when" in order:
//   1. A thread she only wrote in, while its change is checked, is listed
//      with its stage, below her own; one she only voted in is not, and is
//      Live this week once it lands; one she voted and wrote in is listed.
//   2. A thread she was only named in is listed at every stage, and a vote
//      it owes her is in the Needs you feed.
//   3. Being named is a row of its own (`named`) until she writes in the
//      thread after the @, presses Dismiss (kept, so a re-read keeps it
//      away) or the thread finishes. Opening the thread or reading the bell
//      ends nothing, and a new @ brings it back.
//   4. An @ more than a week old starts no row, and a row leaves when its @
//      turns a week old. Naming yourself is not being named; Homeroom bot
//      naming you is; a request's own text names you too; Mute removes it.
//   5. A finished thread she only wrote or was named in is in History,
//      under All.
//   6. The board's Yours filter lists what it listed before.
//   7. Every one of her newest recent threads is on the tab, in the feed or
//      in History, but the moving one she only voted in.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/ai-work-named-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { settleWorkStates } = require('./lib/work-states');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('mobile 04: every thread you are in, and being named, against the full schema', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `ai_named_${crypto.randomBytes(6).toString('hex')}`;
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
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const aiWork = require('../src/services/ai-work');
  const aiHistory = require('../src/services/ai-history');
  const mentions = require('../src/services/thread-mentions');
  const notifications = require('../src/services/notifications');
  const threadReads = require('../src/services/thread-reads');
  const { needsFeedFor } = require('../src/routes/workshop-overview');
  const { recentThreadsPage } = require('../src/services/recent-threads');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username, synthetic = false) => one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`, [username, synthetic]);
  const ada = await user('an_ada');
  const bob = await user('an_bob');
  const bot = await user('homeroom-bot-an', true);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Garden club', 'an-garden', 'running', $1, 'public', 'public') RETURNING id, slug`, [bob.id]);
  // A member, so a vote is hers to cast (the Needs you feed's rule).
  await pool.query(
    `INSERT INTO community_members (community_id, user_id) SELECT community_id, $2 FROM apps WHERE id = $1 ON CONFLICT DO NOTHING`,
    [app.id, ada.id]);
  const request = async (number, by, title, state = 'open') => one(
    `INSERT INTO requests (app_id, number, title, created_by, state) VALUES ($1, $2, $3, $4, $5) RETURNING id, thread_id`,
    [app.id, number, title, by.id, state]);
  const change = (pr, by, issue, status, extra = {}) => one(
    `INSERT INTO chat_sessions (app_id, user_id, pr_number, linked_issues, status, shared_at, promoted_at, merged_at, live_at, check_state)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9) RETURNING id, thread_id`,
    [app.id, by.id, pr, [issue], status, extra.promotedAt || null, extra.mergedAt || null, extra.liveAt || null, extra.checkState || null]);
  // A message in a request's thread (the thread trigger attaches it), and
  // when it was written.
  const say = (by, issue, content, at = null) => one(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, created_at)
     VALUES ($1, $2, $3, 'issue', $4, COALESCE($5::timestamptz, NOW())) RETURNING id, thread_id, created_at`,
    [app.id, by.id, content, issue, at]);
  // Somebody names her in a thread's chat, as the socket does: the message,
  // then its notifications (services/notifications.js).
  const name_ = async (by, issue, at = null) => {
    const msg = await say(by, issue, `@${ada.username} can you look?`, at);
    await notifications.createMentionNotifications(pool, {
      appId: app.id, chatMessageId: msg.id, senderId: by.id, content: `@${ada.username} can you look?`,
    });
    return msg;
  };
  const threadOf = async (number) => Number((await one(
    'SELECT thread_id FROM requests WHERE app_id = $1 AND number = $2', [app.id, number])).thread_id);
  const work = async () => {
    await settleWorkStates(pool);
    return aiWork.workFor(pool, { user: { id: ada.id }, deps: { bot } });
  };
  const listed = (w) => [...w.needs, ...w.next, ...w.waiting, ...w.live];
  const row = (w, title) => listed(w).find((r) => r.title === title) || null;
  const named = (w, title) => w.named.find((r) => r.title === title) || null;

  // ── 1. Wrote, voted, both, while a change is checked ───────────────────
  // Hers: she asked for it, Bob's change is being checked.
  await request(1, ada, 'Her own');
  await change(2, bob, 1, 'promoted', { promotedAt: new Date(Date.now() - 3600000), checkState: 'pending' });
  // Bob's, where she only wrote.
  await request(3, bob, 'Only wrote');
  await change(4, bob, 3, 'promoted', { promotedAt: new Date(Date.now() - 1800000), checkState: 'pending' });
  await say(ada, 3, 'looks good to me');
  // Bob's, which she only voted on.
  await request(5, bob, 'Only voted');
  const votedOnly = await change(6, bob, 5, 'promoted', { promotedAt: new Date(Date.now() - 1800000), checkState: 'pending' });
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [votedOnly.id, ada.id]);
  // Bob's, which she voted on and wrote in.
  await request(7, bob, 'Voted and wrote');
  const both = await change(8, bob, 7, 'promoted', { promotedAt: new Date(Date.now() - 1800000), checkState: 'pending' });
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [both.id, ada.id]);
  await say(ada, 7, 'yes from me');
  // Bob's, open, which she only voted on, whose change was set aside weeks
  // ago (Evan's Type Racer Battle #2): nothing of it is being built.
  await request(29, bob, 'Voted, set aside');
  const aside = await change(30, bob, 29, 'archived', { promotedAt: new Date(Date.now() - 40 * 86400000) });
  await pool.query(`UPDATE chat_sessions SET archived_at = NOW() - interval '30 days' WHERE id = $1`, [aside.id]);
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [aside.id, ada.id]);
  // Bob's, which she only voted on, live yesterday.
  await request(9, bob, 'Voted, live');
  const landed = await change(10, bob, 9, 'merged', { mergedAt: new Date(Date.now() - 2 * 86400000), liveAt: new Date(Date.now() - 86400000) });
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [landed.id, ada.id]);

  let w = await work();
  const wrote = row(w, 'Only wrote');
  assert.ok(wrote, 'a thread she only wrote in is listed while its change is checked');
  assert.equal(wrote.work.stage, 'checking', 'with its stage');
  assert.equal(wrote.tookPart, true, 'marked as not hers');
  const own = row(w, 'Her own');
  assert.equal(own.work.stage, 'checking');
  assert.equal(own.group, wrote.group, 'placed as her own would be');
  const group = w[own.group];
  assert.ok(group.indexOf(own) < group.indexOf(wrote), 'below her own');
  assert.equal(row(w, 'Only voted'), null, 'one she only voted in is not listed while it moves');
  assert.ok(row(w, 'Voted and wrote'), 'one she voted and wrote in is listed while it moves');
  assert.equal(row(w, 'Voted and wrote').myVote, 'yes', 'saying how she voted');
  assert.equal(row(w, 'Voted, live').group, 'live', 'one she only voted in is Live this week once it lands');
  // Evan's update (24 Nov 2026): not while it is stalled either. It used to
  // be Waiting, "Not moving".
  assert.equal(row(w, 'Voted, set aside'), null, 'an open thread she only voted in, nothing being built, is not listed');
  const read = await pool.query(aiWork.THREADS_SQL, [ada.id, false, false, aiWork.THREADS_MAX, aiWork.LIVE_DAYS]);
  assert.ok(!read.rows.some((r) => r.thread_title === 'Voted, set aside' || r.request_title === 'Voted, set aside'),
    'and it is not read, so it spends none of the most rows');
  // It is History's, under Votes, now that the change she voted on closed.
  const votesPast = await aiHistory.historyFor(pool, { user: { id: ada.id }, kind: 'vote', deps: { bot } });
  assert.ok(votesPast.rows.some((r) => r.title === 'Voted, set aside' && r.kind === 'vote'));

  // ── 2. Named only, at every stage ──────────────────────────────────────
  await request(11, bob, 'Named only');
  const at11 = await name_(bob, 11);
  w = await work();
  assert.ok(row(w, 'Named only'), 'a thread she was only named in is listed, nothing in flight');
  assert.equal(row(w, 'Named only').tookPart, true);
  const n11 = named(w, 'Named only');
  assert.ok(n11, 'and being named is its own Needs you row');
  assert.equal(n11.by, bob.username, 'who named her');
  assert.equal(n11.messageId, Number(at11.id), 'the message Reply opens at');
  assert.equal(n11.threadId, await threadOf(11));
  assert.equal(n11.href, '#app/an-garden/dev/issues/11', 'its request\'s page');
  assert.equal(n11.number, 11);
  const c12 = await change(12, bob, 11, 'promoted', { promotedAt: new Date(), checkState: 'pending' });
  w = await work();
  assert.equal(row(w, 'Named only').work.stage, 'checking', 'listed while its change is checked');
  // Up for a vote she owes: the feed's (?in=threads), now that being named
  // puts the thread among hers.
  await pool.query(`UPDATE chat_sessions SET check_state = 'passing' WHERE id = $1`, [c12.id]);
  await settleWorkStates(pool);
  const feed = await needsFeedFor(pool, { user: { id: ada.id }, inThreads: true });
  assert.ok(feed.some((item) => item.kind === 'proposal' && item.id === Number(c12.id)),
    'a vote a thread she was only named in owes her is in Needs you');
  // Without the @ branches the feed would not have it: a vote on a thread
  // nobody named her in, that she is not in, stays off.
  await request(13, bob, 'Not hers at all');
  const c14 = await change(14, bob, 13, 'promoted', { promotedAt: new Date(), checkState: 'passing' });
  await settleWorkStates(pool);
  assert.ok(!(await needsFeedFor(pool, { user: { id: ada.id }, inThreads: true })).some((item) => item.id === Number(c14.id)));

  // ── 3. What ends the row, and what does not ────────────────────────────
  await request(15, bob, 'Asked a question');
  const thread15 = await threadOf(15);
  await name_(bob, 15, new Date(Date.now() - 3600000));
  w = await work();
  assert.ok(named(w, 'Asked a question'));
  // Opening the thread and reading the bell end nothing.
  await threadReads.markRead(pool, { userId: ada.id, threadId: thread15 });
  await pool.query(`UPDATE notifications SET read_at = NOW() WHERE user_id = $1`, [ada.id]);
  w = await work();
  assert.ok(named(w, 'Asked a question'), 'opening the thread or the bell does not end it');
  // She answers: a message after the @.
  await say(ada, 15, 'on it');
  w = await work();
  assert.equal(named(w, 'Asked a question'), null, 'writing in the thread after the @ ends it');
  assert.ok(row(w, 'Asked a question'), 'and the thread is where it would otherwise be');
  // A reaction is not an answer.
  await request(16, bob, 'Reacted only');
  const m16 = await name_(bob, 16, new Date(Date.now() - 600000));
  await pool.query(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, '👍')`, [m16.id, ada.id]);
  w = await work();
  assert.ok(named(w, 'Reacted only'), 'a reaction is not a response');
  // A new @ brings it back.
  await name_(bob, 15);
  w = await work();
  assert.ok(named(w, 'Asked a question'), 'being named again brings it back');
  // Dismiss, kept per person and thread.
  assert.equal(await mentions.dismiss(pool, { userId: ada.id, threadId: thread15 }), true);
  w = await work();
  assert.equal(named(w, 'Asked a question'), null, 'Dismiss ends it');
  assert.ok(row(w, 'Asked a question'), 'and the thread moves to where it would be');
  assert.equal(named(await work(), 'Asked a question'), null, 'it stays out after a reload');
  const kept = await one('SELECT user_id, thread_id FROM thread_mention_dismissals WHERE user_id = $1', [ada.id]);
  assert.deepEqual([Number(kept.user_id), Number(kept.thread_id)], [ada.id, thread15], 'per person, per thread');
  assert.equal(await mentions.dismiss(pool, { userId: bob.id, threadId: thread15 }), true);
  assert.equal((await pool.query('SELECT 1 FROM thread_mention_dismissals WHERE thread_id = $1', [thread15])).rows.length, 2,
    'one row each');
  // A later @ brings it back (written a second after the dismiss, so the
  // order does not hang on the clock), and pressing Dismiss again is one row
  // still.
  await name_(bob, 15, new Date(Date.now() + 1000));
  w = await work();
  assert.ok(named(w, 'Asked a question'), 'a new @ after a dismiss starts it again');
  await mentions.dismiss(pool, { userId: ada.id, threadId: thread15 });
  assert.equal((await pool.query('SELECT 1 FROM thread_mention_dismissals WHERE user_id = $1', [ada.id])).rows.length, 1);
  // The thread finishing ends it: its request closes.
  await request(17, bob, 'Finishes');
  await name_(bob, 17);
  w = await work();
  assert.ok(named(w, 'Finishes'));
  await pool.query(`UPDATE requests SET state = 'closed', closed_at = NOW() WHERE app_id = $1 AND number = 17`, [app.id]);
  w = await work();
  assert.equal(named(w, 'Finishes'), null, 'the thread finishing ends it');

  // ── 4. A week, yourself, the bot, a request's text, Mute ───────────────
  await request(18, bob, 'Old @');
  await name_(bob, 18, new Date(Date.now() - 8 * 86400000));
  await request(19, bob, 'Six days');
  const m19 = await name_(bob, 19, new Date(Date.now() - 6 * 86400000));
  w = await work();
  assert.equal(named(w, 'Old @'), null, 'an @ more than 7 days old starts no row');
  assert.ok(named(w, 'Six days'), 'one from the last week does');
  await pool.query(`UPDATE chat_messages SET created_at = NOW() - interval '7 days 1 minute' WHERE id = $1`, [m19.id]);
  w = await work();
  assert.equal(named(w, 'Six days'), null, 'a row leaves Needs you when its @ passes 7 days');
  await request(20, bob, 'Named myself');
  const self = await say(ada, 20, `@${ada.username} remind me`);
  await notifications.createMentionNotifications(pool, { appId: app.id, chatMessageId: self.id, senderId: ada.id, content: `@${ada.username} remind me` });
  w = await work();
  assert.equal(named(w, 'Named myself'), null, 'naming yourself is not being named');
  await request(21, bob, 'The bot named her');
  const fromBot = await say(bot, 21, `@${ada.username} this is ready for your look`);
  await notifications.createMentionNotifications(pool, { appId: app.id, chatMessageId: fromBot.id, senderId: bot.id, content: `@${ada.username} this is ready for your look` });
  w = await work();
  assert.equal(named(w, 'The bot named her').byBot, true, 'Homeroom bot naming you counts');
  assert.equal(named(w, 'The bot named her').by, null);
  await request(22, bob, `Named in the request, @${ada.username}`);
  await notifications.createIssueMentionNotifications(pool, {
    appId: app.id, issueNumber: 22, authorId: bob.id, text: `Named in the request, @${ada.username}`,
  });
  w = await work();
  const inText = w.named.find((r) => r.number === 22);
  assert.ok(inText, 'an @ in a request\'s own text names her');
  assert.equal(inText.messageId, null, 'no message: its page opens');
  assert.ok(row(w, inText.title), 'and the thread is on the tab');
  await request(23, bob, 'Muted');
  await name_(bob, 23);
  await pool.query('INSERT INTO thread_followers (thread_id, user_id, muted_at) VALUES ($1, $2, NOW())', [await threadOf(23), ada.id]);
  w = await work();
  assert.equal(named(w, 'Muted'), null, 'Mute removes it');
  assert.equal(row(w, 'Muted'), null);

  // ── 5. History ─────────────────────────────────────────────────────────
  await request(24, bob, 'Wrote, closed', 'open');
  await say(ada, 24, 'not sure about this');
  await pool.query(`UPDATE requests SET state = 'closed', closed_at = NOW() WHERE app_id = $1 AND number = 24`, [app.id]);
  await request(25, bob, 'Named, shipped');
  await name_(bob, 25, new Date(Date.now() - 10 * 86400000));
  await change(26, bob, 25, 'merged', { mergedAt: new Date(Date.now() - 9 * 86400000), liveAt: new Date(Date.now() - 9 * 86400000) });
  await pool.query(`UPDATE requests SET state = 'closed', closed_at = NOW() - interval '9 days' WHERE app_id = $1 AND number = 25`, [app.id]);
  const history = await aiHistory.historyFor(pool, { user: { id: ada.id }, deps: { bot } });
  const past = (title) => history.rows.find((r) => r.title === title);
  assert.deepEqual([past('Wrote, closed').kind, past('Wrote, closed').outcome], ['thread', 'closed'],
    'a closed thread she only wrote in is in History');
  assert.deepEqual([past('Named, shipped').kind, past('Named, shipped').outcome], ['thread', 'live'],
    'and one she was only named in, with how it ended');
  const votes = await aiHistory.historyFor(pool, { user: { id: ada.id }, kind: 'vote', deps: { bot } });
  assert.ok(!votes.rows.some((r) => r.kind === 'thread'), 'History\'s kind chips keep their meaning');

  // ── 6. The board's Yours filter ────────────────────────────────────────
  const yours = await aiWork.yoursOn(pool, { user: { id: ada.id }, appId: app.id });
  assert.ok(yours.requests.includes(3), 'one she wrote in, as before');
  assert.ok(!yours.requests.includes(11), 'being named does not make it hers on the board');
  assert.ok(!yours.requests.includes(19), 'nor does an old @');
  const { rows: beforeRows } = await pool.query(
    `WITH mine AS (${aiWork.threadsInSql('$1')}) SELECT thread_id FROM mine ORDER BY thread_id`, [ada.id]);
  const { rows: legacy } = await pool.query(
    `SELECT DISTINCT thread_id FROM (
       SELECT thread_id FROM requests WHERE created_by = $1 AND thread_id IS NOT NULL
       UNION ALL SELECT thread_id FROM issues WHERE created_by = $1 AND thread_id IS NOT NULL
       UNION ALL SELECT t.id FROM homeroom_bot_requesters b JOIN threads t ON t.app_id = b.app_id AND t.number = b.issue_number WHERE b.user_id = $1
       UNION ALL SELECT thread_id FROM chat_sessions WHERE user_id = $1 AND thread_id IS NOT NULL AND is_headless = FALSE
       UNION ALL SELECT t.id FROM issue_claims ic JOIN threads t ON t.app_id = ic.app_id AND t.number = ic.github_issue_number
                 WHERE ic.user_id = $1 AND ic.claimed_at > NOW() - make_interval(days => 7)
       UNION ALL SELECT s.thread_id FROM pr_votes v JOIN chat_sessions s ON s.id = v.session_id WHERE v.user_id = $1 AND s.thread_id IS NOT NULL
       UNION ALL SELECT i.thread_id FROM issue_votes v JOIN issues i ON i.id = v.issue_id WHERE v.user_id = $1 AND i.thread_id IS NOT NULL
       UNION ALL SELECT thread_id FROM chat_messages WHERE user_id = $1 AND thread_id IS NOT NULL AND msg_type = 'message' AND deleted_at IS NULL
       UNION ALL SELECT thread_id FROM thread_followers WHERE user_id = $1 AND muted_at IS NULL
     ) x ORDER BY thread_id`, [ada.id]);
  assert.deepEqual(beforeRows.map((r) => Number(r.thread_id)), legacy.map((r) => Number(r.thread_id)),
    'without `named`, the rule is the one it was');

  // ── 7. Her newest recent threads are all on the tab ────────────────────
  w = await work();
  const feedNow = await needsFeedFor(pool, { user: { id: ada.id }, inThreads: true });
  const all = await aiHistory.historyFor(pool, { user: { id: ada.id }, limit: 60, deps: { bot } });
  const seen = new Set([
    ...listed(w).map((r) => r.threadId),
    ...w.named.map((r) => r.threadId),
    ...feedNow.map((item) => item.threadId),
    ...all.rows.map((r) => r.threadId).filter(Boolean),
  ]);
  const recent = await recentThreadsPage(pool, ada.id, { limit: 50 });
  const missing = recent.threads.filter((r) => !seen.has(r.threadId)).map((r) => r.title);
  // The open thread she only voted in, moving, stays off, on purpose. The
  // stalled one she voted in is History's (its change closed); an @ older
  // than a week in an open thread is listed (Not moving), so neither is
  // missing.
  assert.deepEqual(missing, ['Only voted'], 'every recent thread is somewhere but an open one she only voted in');

  // ── The route: Dismiss is per person, and only for a thread of the app ─
  const { aiWorkRoutes } = require('../src/routes/ai-work');
  const web = express();
  web.use(express.json());
  web.use((req, _res, next) => { req.user = { id: ada.id, username: ada.username }; next(); });
  web.use(aiWorkRoutes());
  server = await new Promise((resolve) => { const s = web.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: base },
    body: JSON.stringify(body),
  });
  await request(27, bob, 'Dismissed by the route');
  await name_(bob, 27);
  assert.ok(named(await work(), 'Dismissed by the route'));
  const pressed = await post('/api/apps/an-garden/threads/mentions/dismiss', { thread_id: await threadOf(27) });
  assert.equal(pressed.status, 200, await pressed.clone().text());
  assert.deepEqual(await pressed.json(), { ok: true });
  assert.equal(named(await work(), 'Dismissed by the route'), null, 'the route dismisses it');
  assert.equal((await post('/api/apps/an-garden/threads/mentions/dismiss', { thread_id: 'x' })).status, 400);
  assert.equal((await post('/api/apps/an-garden/threads/mentions/dismiss', { thread_id: 999999 })).status, 404);
  const other = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Other', 'an-other', 'running', $1, 'public', 'public') RETURNING id`, [bob.id]);
  void other;
  assert.equal((await post('/api/apps/an-other/threads/mentions/dismiss', { thread_id: await threadOf(27) })).status, 404,
    'another app\'s thread is not this app\'s');

  // Homeroom bot's answer names the row, and the thread is in no other list.
  await request(28, bob, 'For the answer');
  await name_(bob, 28);
  await settleWorkStates(pool);
  const page = await aiWork.pageLists(pool, { user: { id: ada.id }, deps: { bot } });
  const said = page.needsYou.find((r) => r.title === 'For the answer');
  assert.ok(said && /an_bob named them with @/.test(said.says), 'the bot\'s answer names who named her');
  assert.ok(![...page.inProgress, ...page.waiting].some((r) => r.title === 'For the answer'), 'one row a thread');
});
