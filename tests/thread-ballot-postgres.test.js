'use strict';

// #6019 follow-up: ballots, rivals and the votes to close, against the REAL
// schema in a throwaway PostgreSQL database (tracked startup followed by
// receipt verification on reboot).
//
// What this pins:
//   1. Changes compete only when they would close the same request (their
//      linked_issues overlap). A change that is part of a request and closes
//      nothing (#5997 on prod, 29 Oct) is no rival: the merge of one change
//      leaves it open, and the thread payload says what each closes.
//   2. A vote to close competes with the changes that close the request it
//      was filed on (their merge closes that request, which supersedes it),
//      and its pass closes them, and only them (closeThreadChanges).
//   3. Needs you owes a ballot ONCE, on its oldest change's row, with its
//      choices; not to anyone who voted in it (proposing one of it is no
//      vote, 11 Nov 2026); the close vote in it is not owed on its own; the
//      counts agree.
//   4. Homeroom bot's open questions are owed, in the feed and the counts.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/thread-ballot-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('ballots, rivals and close votes against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `thread_ballot_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const threads = require('../src/services/threads');
  const overview = require('../src/routes/workshop-overview');

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`, [username])).rows[0];
  const [ada, bob, cat, dan] = [await user('tb_ada'), await user('tb_bob'), await user('tb_cat'), await user('tb_dan')];
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, view_visibility, collab_visibility) VALUES ('Ballots', 'tb-ballots', 'public', 'public') RETURNING id, slug`);
  for (const u of [ada, bob, cat, dan]) {
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [app.id, u.id]);
  }
  await pool.query(`INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 7, 'Night mode', $2)`, [app.id, ada.id]);
  // #6402: a change is owed a vote only once its checks passed, so every
  // change here is a ready one; this file is about ballots, not the gate.
  const change = async (by, pr, linked, fromIssue = null) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, created_from_issue_number, pr_number, pr_title, check_state)
     VALUES ($1, $2, 'promoted', $3::int[], $4, $5, $6, 'passing') RETURNING id, thread_id`,
    [app.id, by.id, linked, fromIssue, pr, `Change ${pr}`])).rows[0];
  const a = await change(bob, 20, [7]);
  const b = await change(cat, 21, [7]);
  const part = await change(cat, 22, [], 7); // part of #7: it closes nothing
  const { rows: [close] } = await pool.query(
    `INSERT INTO issues (app_id, kind, title, payload, status, created_by)
     VALUES ($1, 'close_issue', 'Close #7', jsonb_build_object('issueNumber', 7, 'reason', 'Done already'), 'open', $2)
     RETURNING id, thread_id`, [app.id, dan.id]);
  const lead = Number(a.thread_id);
  await t.test('every one of them is in the request\'s thread', () => {
    assert.ok(lead > 0);
    assert.deepEqual([b.thread_id, part.thread_id, close.thread_id].map(Number), [lead, lead, lead]);
  });

  const feedFor = async (viewer) => overview.shapeNeedsFeed(
    (await pool.query(overview.NEEDS_FEED_SQL, [viewer.id, false, false, overview.NEEDS_FEED_MAX])).rows)
    .filter((i) => i.app.slug === app.slug);
  const needsFor = async (viewer) => {
    const row = (await pool.query(overview.COUNTS_SQL, [viewer.id, false, false])).rows.find((r) => r.slug === app.slug);
    return row ? Number(row.needs) : 0;
  };

  await t.test('the thread says which requests each change closes', async () => {
    const { rows: [thread] } = await pool.query('SELECT * FROM threads WHERE id = $1', [lead]);
    const page = await threads.threadPage(pool, { thread, viewerId: ada.id });
    const closes = Object.fromEntries(page.items.filter((i) => i.type === 'change').map((i) => [i.id, i.closes]));
    assert.deepEqual(closes, { [a.id]: [7], [b.id]: [7], [part.id]: [] });
    const vote = page.items.find((i) => i.type === 'close');
    assert.deepEqual([vote.target, vote.reason, vote.by], [7, 'Done already', 'tb_dan']);
  });

  await t.test('Needs you owes the ballot once, with its choices; the change that closes nothing on its own', async () => {
    const feed = await feedFor(ada);
    const ballot = feed.find((i) => i.kind === 'ballot');
    assert.ok(ballot, 'one ballot card');
    assert.equal(ballot.id, a.id, 'carried by its oldest change');
    assert.deepEqual(ballot.ballot.options.map((o) => o.id), [a.id, b.id]);
    assert.equal(ballot.ballot.close.id, close.id, 'the close vote is one of its choices');
    assert.deepEqual([ballot.ballot.number, ballot.ballot.title], [7, 'Night mode']);
    assert.deepEqual(feed.filter((i) => i.kind === 'proposal').map((i) => i.id), [part.id], 'not a rival, so a card of its own');
    assert.ok(!feed.some((i) => i.kind === 'governance' && i.id === close.id), 'the close is not owed alone');
    assert.equal(await needsFor(ada), 2, 'the counts agree: the ballot and the other change');
  });

  await t.test('a member who picked owes the ballot no more; proposing one of it is not a pick', async () => {
    // 11 Nov 2026: proposing is never a yes (governance-rules.ts), so it is
    // no pick either: the ballot asks its proposers too.
    assert.ok((await feedFor(bob)).some((i) => i.kind === 'ballot'), 'proposing a change is not a pick');
    assert.ok((await feedFor(dan)).some((i) => i.kind === 'ballot'), 'nor is proposing to close');
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) SELECT id, $2, 'yes', approval_epoch FROM chat_sessions WHERE id = $1`,
      [b.id, ada.id]);
    const after = await feedFor(ada);
    assert.ok(!after.some((i) => i.kind === 'ballot'), 'her Yes on B is her pick');
    assert.equal(await needsFor(ada), 1);
    await pool.query('DELETE FROM pr_votes WHERE session_id = $1 AND user_id = $2', [b.id, ada.id]);
  });

  await t.test('Homeroom bot\'s open questions are owed, in the feed and the counts', async () => {
    const { rows: [bot] } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic) VALUES ('tb_bot', 'x', TRUE) RETURNING id`);
    const { rows: [conv] } = await pool.query(`INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [bot.id]);
    const { rows: [msg] } = await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata)
       VALUES ($1, $2, 'A question', jsonb_build_object('homeroomBot', jsonb_build_object('question', 'Newest first?')))
       RETURNING id`, [conv.id, bot.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, question_status)
       VALUES ($1, $2, $3, $4, 7, 'question', 'open')`, [msg.id, ada.id, conv.id, app.id]);
    const question = (await feedFor(ada)).find((i) => i.kind === 'question');
    assert.deepEqual([question.id, question.title, question.number, question.author], [msg.id, 'Newest first?', 7, 'tb_bot']);
    assert.equal(await needsFor(ada), 3);
    const owed = (await pool.query(overview.COUNTS_SQL, [ada.id, false, false])).rows.find((r) => r.slug === app.slug).owed;
    assert.ok(owed.includes(`question:${msg.id}`), 'under a key the seen record takes');
    await pool.query(`UPDATE homeroom_bot_dm_messages SET question_status = 'answered' WHERE message_id = $1`, [msg.id]);
    assert.equal(await needsFor(ada), 2, 'answered, it is owed no more');
  });

  await t.test('a vote to close passing closes the changes that would close its requests, and only them', async () => {
    const archived = [];
    const lifecycle = { async archiveSession(args) { archived.push(args.sessionId); return { archived: true }; } };
    const ws = { sendSystemMessage: async () => null };
    const closed = await threads.closeThreadChanges(pool, { appId: app.id, threadId: lead, closed: [7], closedBy: 7, deps: { lifecycle, ws } });
    assert.deepEqual(closed.sort(), [a.id, b.id].sort());
    assert.ok(!archived.includes(part.id), 'the change that closes nothing stays');
    assert.deepEqual(await threads.closeThreadChanges(pool, { appId: app.id, threadId: lead, closed: [], deps: { lifecycle, ws } }), []);
  });

  await t.test('the first change live closes its rivals, not the change that closes nothing', async () => {
    await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [a.id]);
    const archived = [];
    const lifecycle = { async archiveSession(args) { archived.push(args.sessionId); return { archived: true }; } };
    const ws = { sendSystemMessage: async () => null };
    assert.deepEqual(await threads.closeRivals(pool, { appId: app.id, prNumber: 20, deps: { lifecycle, ws } }), [b.id]);
    assert.ok(!archived.includes(part.id), '#5997: part of the request is no rival');
  });
});
