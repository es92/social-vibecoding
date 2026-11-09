'use strict';

// #6488: a proposal's discussion survives a close and a reopen.
//
// A proposal closed and reopened had every reply vanish for everyone but its
// author. The rows were never lost: the thread link survives both moves. The
// read path decided visibility by the change's CURRENT status, and neither
// `archived` (closed) nor `active` (underway again after a reopen) passes
// it, so `threads.js` dropped the change from the request's page and
// `routes/chat.js` dropped its replies from the request's stream.
//
// Against the REAL schema in a throwaway database, this pins:
//
//   1. Close (`status = 'archived'`, the request closed with it) then reopen
//      (`status = 'active'`, the request open again): the thread's state
//      follows, and the change and its replies keep their `thread_id`.
//   2. For a member who is NOT the change's author, the request's page lists
//      the reopened change, its reply count includes its replies, and
//      GET /api/apps/:slug/messages returns them in their original order
//      with the same author and time. requestHome places the change on the
//      request's page. While it is closed the change is not listed, but its
//      replies stay in the discussion.
//   3. A change that was never up for a vote (`promoted_at` null, no
//      `shared_at`) stays owner-only: hidden from a non-owner and visible to
//      its owner, in the page and in the stream.
//   4. isNavigable's rule, directly.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/thread-reopen-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a reopened proposal keeps its discussion', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `thread_reopen_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
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
  const threads = require('../src/services/threads');
  const issueRefs = require('../src/services/issue-proposal-ref');
  const { chatRoutes } = require('../src/routes/chat');

  const users = {};
  const user = async (username) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`, [username]);
    users[row.id] = { id: row.id, username: row.username };
    return users[row.id];
  };
  const [ana, maya, dewi] = [await user('re_ana'), await user('re_maya'), await user('re_dewi')];
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, view_visibility, collab_visibility) VALUES ('Ship', 're-ship', 'running', 'public', 'public') RETURNING id, slug`);
  await pool.query(
    `INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 10, 'Keep history on reopen', $2)`,
    [app.id, ana.id]);
  // Up for a vote: promoted_at is what `machine.ts`'s `promoted` write sets,
  // and nothing clears it. shared_at stays null, as it is for a proposal.
  const { rows: [proposal] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, branch_name, promoted_at)
     VALUES ($1, $2, 'promoted', ARRAY[10]::int[], 42, 'Keep history on reopen', 'feature/keep-history', NOW())
     RETURNING id, thread_id`,
    [app.id, maya.id]);
  assert.ok(proposal.thread_id, 'the trigger attached the change to the request\'s thread');

  const say = async (who, sessionId, content) => (await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref)
     VALUES ($1, $2, $3, 'session', $4) RETURNING id, user_id, created_at`,
    [app.id, who.id, content, sessionId])).rows[0];
  const first = await say(maya, proposal.id, 'The empty state needs a sentence.');
  const second = await say(ana, proposal.id, 'Agreed, and the phone layout wraps the pill.');
  const third = await say(dewi, proposal.id, 'Both fixed in the latest build.');
  const replies = [first, second, third];
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'Please', 'issue', 10)`,
    [app.id, ana.id]);

  const httpApp = express();
  httpApp.use((req, _res, next) => { req.user = users[Number(req.get('x-test-user'))]; next(); });
  httpApp.use(chatRoutes({}));
  server = await new Promise((resolve) => { const s = httpApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const stream = async (who) => {
    const res = await fetch(`${base}/api/apps/re-ship/messages?thread_type=issue&thread_ref=10`,
      { headers: who ? { 'x-test-user': String(who.id) } : {} });
    assert.equal(res.status, 200);
    return (await res.json()).messages;
  };
  const page = async (who) => threads.threadPage(pool, {
    thread: await threads.threadForNumber(pool, { appId: app.id, number: 10 }), viewerId: who.id,
  });
  const threadState = async () => (await pool.query(
    'SELECT state FROM threads WHERE id = $1', [proposal.thread_id])).rows[0].state;

  await t.test('the thread, the change and its replies keep their link across a close and a reopen', async () => {
    assert.equal(await threadState(), 'open');
    // A close: the proposal archived, and (as a vote to close does) the
    // request it serves closed with it, so the thread has nothing live.
    await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [proposal.id]);
    await pool.query(`UPDATE requests SET state = 'closed' WHERE app_id = $1 AND number = 10`, [app.id]);
    assert.equal(await threadState(), 'closed', 'the schema\'s trigger closed the thread');
    const { rows: [kept] } = await pool.query('SELECT thread_id FROM chat_sessions WHERE id = $1', [proposal.id]);
    assert.equal(Number(kept.thread_id), Number(proposal.thread_id), 'the change keeps its thread');
    const { rows: keptReplies } = await pool.query(
      'SELECT id, thread_id FROM chat_messages WHERE id = ANY($1::int[]) ORDER BY id', [replies.map((r) => r.id)]);
    assert.deepEqual(keptReplies.map((r) => Number(r.thread_id)), replies.map(() => Number(proposal.thread_id)),
      'every reply keeps its thread');

    // A reopen: underway again, its request open.
    await pool.query(`UPDATE chat_sessions SET status = 'active' WHERE id = $1`, [proposal.id]);
    await pool.query(`UPDATE requests SET state = 'open' WHERE app_id = $1 AND number = 10`, [app.id]);
    assert.equal(await threadState(), 'open', 'the schema\'s trigger opened the thread again');
  });

  await t.test('a reopened proposal keeps its replies for a member who is not its author', async () => {
    const asAna = await page(ana);
    const change = asAna.items.find((i) => i.type === 'change' && i.id === Number(proposal.id));
    assert.ok(change, 'the reopened change is listed on the request\'s page');
    assert.equal(change.state, 'underway', 'it is back to being worked on');
    assert.equal(asAna.items.find((i) => i.type === 'request').replies, 4,
      'its own reply plus the change\'s three, read by someone who is not the author');

    const rows = await stream(ana);
    const kept = rows.filter((m) => m.thread_type === 'session');
    assert.deepEqual(kept.map((m) => m.content),
      ['The empty state needs a sentence.', 'Agreed, and the phone layout wraps the pill.', 'Both fixed in the latest build.'],
      'in their original order');
    assert.deepEqual(kept.map((m) => Number(m.user_id)), replies.map((r) => Number(r.user_id)),
      'with the same authors');
    assert.deepEqual(kept.map((m) => new Date(m.created_at).toISOString()),
      replies.map((r) => new Date(r.created_at).toISOString()), 'and the same times');

    assert.deepEqual(await threads.requestHome(pool, { appId: app.id, sessionId: proposal.id, viewerId: ana.id }), {
      number: 10, threadId: Number(proposal.thread_id),
    }, 'its address opens the request\'s page again');
  });

  await t.test('while closed, the change is not listed but its replies stay in the discussion', async () => {
    await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [proposal.id]);
    const asAna = await page(ana);
    assert.ok(!asAna.items.some((i) => i.type === 'change' && i.id === Number(proposal.id)),
      'a closed proposal is not among the request\'s changes');
    assert.equal(asAna.items.find((i) => i.type === 'request').replies, 4,
      'its replies are still read in the discussion');
    assert.deepEqual((await stream(ana)).filter((m) => m.thread_type === 'session').map((m) => m.content),
      ['The empty state needs a sentence.', 'Agreed, and the phone layout wraps the pill.', 'Both fixed in the latest build.']);
    assert.equal((await threads.requestHome(pool, { appId: app.id, sessionId: proposal.id, viewerId: ana.id })).number, 10,
      'and its address still lands on the request\'s page');
    await pool.query(`UPDATE chat_sessions SET status = 'active' WHERE id = $1`, [proposal.id]);
  });

  await t.test('a change never put up for a vote stays owner-only', async () => {
    const { rows: [draft] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, branch_name)
       VALUES ($1, $2, 'active', ARRAY[10]::int[], 'feature/draft') RETURNING id, thread_id`,
      [app.id, dewi.id]);
    assert.equal(draft.thread_id, proposal.thread_id, 'it is in the request\'s thread too');
    await say(dewi, draft.id, 'Still thinking about this one.');

    const asAna = await page(ana);
    assert.ok(!asAna.items.some((i) => i.type === 'change' && i.id === Number(draft.id)),
      'not listed for someone who is not its author');
    assert.equal(asAna.items.find((i) => i.type === 'request').replies, 4, 'its reply is not counted for them');
    assert.ok(!(await stream(ana)).some((m) => m.content === 'Still thinking about this one.'),
      'nor read in the discussion');

    const asDewi = await page(dewi);
    assert.ok(asDewi.items.some((i) => i.type === 'change' && i.id === Number(draft.id)), 'its author still reads it');
    assert.equal(asDewi.items.find((i) => i.type === 'request').replies, 5, 'and its reply counts for them');
    assert.ok((await stream(dewi)).some((m) => m.content === 'Still thinking about this one.'),
      'and is in their stream');
  });

  await t.test('isNavigable: promoted_at keeps a change public whatever its status', () => {
    const otherId = ana.id;
    assert.equal(issueRefs.isNavigable({ status: 'active', promoted_at: '2026-11-04T10:00:00.000Z' }, otherId), true);
    assert.equal(issueRefs.isNavigable({ status: 'archived', promoted_at: '2026-11-04T10:00:00.000Z' }, otherId), true);
    assert.equal(issueRefs.isNavigable({ status: 'active' }, otherId), false);
    assert.equal(issueRefs.isNavigable({ status: 'active', user_id: otherId }, otherId), true, 'its author may read it');
  });
});
