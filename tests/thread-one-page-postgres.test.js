'use strict';

// One page per thread (1 Nov 2026): a change built for a request has no
// page of its own. Against the REAL schema in a throwaway database, this
// pins what the server says about where a change lives and what the
// request's page reads:
//
//   1. A change whose thread a request leads lives on that request's page
//      (threads.requestHome, GET /api/apps/:slug/threads/change/:id); a
//      change with no request keeps its own; a live chat nobody may see is
//      nobody else's to place.
//   2. The request that leads the thread counts its changes' replies.
//   3. A change for several requests lives on the first one's page, and the
//      others' pages say where (`elsewhere`).
//
// The request's merged stream itself is pinned in app-chat-postgres.test.js.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/thread-one-page-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a change built for a request lives on the request\'s page', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `thread_one_page_${crypto.randomBytes(6).toString('hex')}`;
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
  const { threadsRoutes } = require('../src/routes/threads');

  const users = {};
  const user = async (username) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`, [username]);
    users[row.id] = { id: row.id, username: row.username };
    return users[row.id];
  };
  const [ana, dewi, maya] = [await user('op_ana'), await user('op_dewi'), await user('op_maya')];
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, view_visibility, collab_visibility) VALUES ('Club', 'op-club', 'running', 'public', 'public') RETURNING id, slug`);
  await pool.query(
    `INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 10, 'Pin a message', $2), ($1, 11, 'Pin in DMs', $2)`,
    [app.id, ana.id]);
  const change = async (by, { pr = null, linked = [], status = 'promoted', shared = false, title = 'A change' } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, branch_name, shared_at)
     VALUES ($1, $2, $3, $4::int[], $5, $6, $7, CASE WHEN $8::boolean THEN NOW() END) RETURNING id, thread_id`,
    [app.id, by.id, status, linked, pr, title, `feature/${pr || crypto.randomBytes(3).toString('hex')}`, shared])).rows[0];
  const pin = await change(dewi, { pr: 12, linked: [10, 11], title: 'Pin it' });
  const alone = await change(dewi, { pr: 20, title: 'Faster search' });
  const draft = await change(maya, { linked: [10], status: 'active', title: 'Draft' });
  const reply = (who, sessionId, content) => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, $3, 'session', $4)`,
    [app.id, who.id, content, sessionId]);
  await reply(maya, pin.id, 'Works for me.');
  await reply(ana, pin.id, 'Thanks!');
  await reply(maya, draft.id, 'Still thinking.');
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'Please', 'issue', 10)`,
    [app.id, ana.id]);

  const httpApp = express();
  httpApp.use((req, _res, next) => { req.user = users[Number(req.get('x-test-user'))]; next(); });
  httpApp.use(threadsRoutes({}));
  server = await new Promise((resolve) => { const s = httpApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = async (who, path) => {
    const res = await fetch(`${base}${path}`, { headers: who ? { 'x-test-user': String(who.id) } : {} });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  await t.test('a change built for a request lives on its page; one with no request keeps its own', async () => {
    assert.deepEqual(await threads.requestHome(pool, { appId: app.id, sessionId: pin.id, viewerId: ana.id }), {
      number: 10, threadId: Number(pin.thread_id),
    });
    assert.equal(await threads.requestHome(pool, { appId: app.id, sessionId: alone.id, viewerId: ana.id }), null);
    assert.equal(await threads.requestHome(pool, { appId: app.id, sessionId: draft.id, viewerId: ana.id }), null,
      'a live chat nobody may see is not placed for them');
    assert.equal((await threads.requestHome(pool, { appId: app.id, sessionId: draft.id, viewerId: maya.id })).number, 10,
      'its owner reads it on the request\'s page');
    assert.equal(await threads.requestHome(pool, { appId: app.id + 1, sessionId: pin.id, viewerId: ana.id }), null, 'only in its own app');

    assert.deepEqual((await read(ana, `/api/apps/op-club/threads/change/${pin.id}`)).body, { request: 10 });
    assert.deepEqual((await read(null, `/api/apps/op-club/threads/change/${pin.id}`)).body, { request: 10 }, 'signed out, on a public project');
    assert.deepEqual((await read(ana, `/api/apps/op-club/threads/change/${alone.id}`)).body, { request: null });
    assert.deepEqual((await read(ana, '/api/apps/op-club/threads/change/999999')).body, { request: null });
    assert.deepEqual((await read(ana, '/api/apps/op-club/threads/change/0')).body, { request: null });
    assert.equal((await read(ana, `/api/apps/nope/threads/change/${pin.id}`)).status, 404);
  });

  await t.test('the request that leads the thread counts its changes\' replies', async () => {
    const thread = await threads.threadForNumber(pool, { appId: app.id, number: 10 });
    const asAna = await threads.threadPage(pool, { thread, viewerId: ana.id });
    const request = asAna.items.find((i) => i.type === 'request' && i.number === 10);
    assert.equal(request.replies, 3, 'its own reply and the two on its change; the draft is not Ana\'s to read');
    const asMaya = await threads.threadPage(pool, { thread, viewerId: maya.id });
    assert.equal(asMaya.items.find((i) => i.type === 'request').replies, 4, 'the draft\'s owner counts its reply');
  });

  await t.test('#6139: a change is ready only with checks passing on its current head and nothing working on it', async () => {
    const SHA = 'a'.repeat(40);
    const OTHER = 'b'.repeat(40);
    const set = (fields) => pool.query(
      `UPDATE chat_sessions SET check_state = $2, checks_commit_sha = $3, source = $4, imported_pr_head_sha = $5,
                                handoff_uploaded_sha = $6, handoff_head_sha = $7, handoff_upload_checked_sha = $8,
                                active_turn = $9::jsonb, staging_url = NULL
        WHERE id = $1`,
      [draft.id, fields.state ?? 'passing', 'sha' in fields ? fields.sha : SHA, fields.source ?? 'native', fields.imported ?? null,
        fields.uploaded ?? null, fields.head ?? null, fields.uploadChecked ?? null, fields.turn ?? null]);
    const ready = async () => {
      const thread = await threads.threadForNumber(pool, { appId: app.id, number: 10 });
      const page = await threads.threadPage(pool, { thread, viewerId: maya.id });
      const item = page.items.find((i) => i.type === 'change' && i.id === Number(draft.id));
      assert.equal(item.state, 'underway');
      return item.ready;
    };
    await set({});
    assert.equal(await ready(), true, 'passing on its head, idle, its preview asleep');
    for (const [why, fields] of [
      ['checks still running', { state: 'pending' }],
      ['checks failed', { state: 'failing' }],
      ['nothing was built', { state: 'skipped' }],
      ['a verdict about no commit', { sha: null }],
      ['a turn is running', { turn: JSON.stringify({ turnId: 't', phase: 'running' }) }],
      ['an imported head moved on', { source: 'imported', imported: OTHER }],
      ['a local upload is not submitted', { source: 'cli_handoff', uploaded: OTHER, head: SHA, uploadChecked: SHA }],
      ['a submitted upload not checked yet', { source: 'cli_handoff', uploaded: OTHER, head: OTHER, uploadChecked: SHA }],
    ]) {
      await set(fields);
      assert.equal(await ready(), false, why);
    }
    await set({ source: 'imported', imported: SHA.toUpperCase() });
    assert.equal(await ready(), true, 'an imported pull request checked on its head, whatever the case of the sha');
    await set({ source: 'cli_handoff', uploaded: SHA, head: SHA, uploadChecked: OTHER });
    assert.equal(await ready(), true, 'a submitted upload');
    await pool.query(`UPDATE chat_sessions SET check_state = NULL, checks_commit_sha = NULL, source = NULL, imported_pr_head_sha = NULL,
                        handoff_uploaded_sha = NULL, handoff_head_sha = NULL, handoff_upload_checked_sha = NULL WHERE id = $1`, [draft.id]);
    const pinPage = await threads.threadPage(pool, { thread: await threads.threadForNumber(pool, { appId: app.id, number: 10 }), viewerId: ana.id });
    assert.equal(pinPage.items.find((i) => i.type === 'change' && i.id === Number(pin.id)).ready, false, 'one up for a vote is past it');
  });

  await t.test('a change for two requests is on the first one\'s page; the other says where', async () => {
    const other = await threads.threadForNumber(pool, { appId: app.id, number: 11 });
    const page = await threads.threadPage(pool, { thread: other, viewerId: ana.id });
    assert.ok(!page.items.some((i) => i.type === 'change'), 'it is not in #11\'s thread');
    assert.deepEqual(page.elsewhere, [{
      id: Number(pin.id), number: 12, title: 'Pin it', summary: null, on: 10, request: 11,
      disputed: false, mine: true, ask: true,
    }]);
    const first = await threads.threadPage(pool, { thread: await threads.threadForNumber(pool, { appId: app.id, number: 10 }), viewerId: ana.id });
    assert.deepEqual(first.elsewhere, [], 'the first request\'s page has it in its own thread');
  });

  // #6225: a change's Votes card lists every request a yes would close, each
  // resolved to its title and filer, and says whether its requester agreed.
  await t.test('#6225: the closes list resolves titles and filers and marks the unconfirmed', async () => {
    await pool.query(
      `INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 13, 'Sidebar rows too tight', $2), ($1, 14, 'Another one', $2)`,
      [app.id, maya.id]);
    const { rows: [bot] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ('op_bot', 'x', TRUE, TRUE) RETURNING id`);
    const made = async (by, { pr, linked, from = null }) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, branch_name, created_from_issue_number)
       VALUES ($1, $2, 'promoted', $3::int[], $4, $5, $6, $7) RETURNING id`,
      [app.id, by.id, linked, pr, `Change ${pr}`, `feature/${pr}`, from])).rows[0];
    const human = await made(dewi, { pr: 30, linked: [10, 13, 11, 99], from: 10 });
    const authored = await made(ana, { pr: 31, linked: [10, 11, 13] });
    const bots = await made(bot, { pr: 32, linked: [10, 13, 14], from: 13 });

    const page = await threads.threadPage(pool, {
      thread: await threads.threadForNumber(pool, { appId: app.id, number: 10 }), viewerId: ana.id,
    });
    const of = (id) => page.items.find((i) => i.type === 'change' && i.id === Number(id)).closesRequests;

    assert.deepEqual(of(human.id), [
      { number: 10, title: 'Pin a message', by: 'op_ana', confirmed: true },
      { number: 11, title: 'Pin in DMs', by: 'op_ana', confirmed: false },
      { number: 13, title: 'Sidebar rows too tight', by: 'op_maya', confirmed: false },
      { number: 99, title: null, by: null, confirmed: false },
    ], 'built for #10, whoever filed it; the rest not agreed to; a number with no request is bare');

    assert.deepEqual(of(authored.id), [
      { number: 10, title: 'Pin a message', by: 'op_ana', confirmed: true },
      { number: 11, title: 'Pin in DMs', by: 'op_ana', confirmed: true },
      { number: 13, title: 'Sidebar rows too tight', by: 'op_maya', confirmed: false },
    ], 'a change its author filed requests for: those are confirmed');

    assert.deepEqual(of(bots.id), [
      { number: 10, title: 'Pin a message', by: 'op_ana', confirmed: false },
      { number: 13, title: 'Sidebar rows too tight', by: 'op_maya', confirmed: true },
      { number: 14, title: 'Another one', by: 'op_maya', confirmed: true },
    ], 'Homeroom bot\'s change is the requester it was built for: that person\'s requests are confirmed');

    assert.deepEqual(of(pin.id).map((r) => r.confirmed), [false, false],
      'a change with no built-from request: only its author\'s own requests would be confirmed');
  });

  // #6439: an ended vote to close says how it ended, off the governance
  // machine's audit in its payload. The request's page keeps its card.
  await t.test('#6439 an ended close vote\'s outcome is read from its payload audit', async () => {
    const make = (payload, status = 'closed') => pool.query(
      `INSERT INTO issues (app_id, kind, title, payload, status, created_by)
       VALUES ($1, 'close_issue', 'Close #10', $2::jsonb, $3, $4) RETURNING id`,
      [app.id, JSON.stringify({ issueNumber: 10, ...payload }), status, ana.id]);
    const closed = (await make({ appliedAt: '2026-01-15T00:00:00.000Z', appliedBy: 'group-vote' })).rows[0];
    const refused = (await make({ appliedAt: '2026-01-15T00:00:00.000Z', appliedBy: 'refused:conflict' })).rows[0];
    const withdrawn = (await make({ withdrawnAt: '2026-01-15T00:00:00.000Z' })).rows[0];
    const elsewhere = (await make({ supersededBy: 'merge' })).rows[0];
    const open = (await make({}, 'open')).rows[0];
    const thread = await threads.threadForNumber(pool, { appId: app.id, number: 10 });
    const page = await threads.threadPage(pool, { thread, viewerId: ana.id });
    const outcomeOf = (id) => page.items.find((i) => i.type === 'close' && i.id === Number(id)).outcome;
    assert.equal(outcomeOf(closed.id), 'closed', 'applied by the vote');
    assert.equal(outcomeOf(refused.id), 'kept', 'could not be applied');
    assert.equal(outcomeOf(withdrawn.id), 'kept', 'withdrawn');
    assert.equal(outcomeOf(elsewhere.id), 'elsewhere', 'the request closed another way');
    assert.equal(outcomeOf(open.id), null, 'still open');
  });

  // #6124: a title chosen before the change has a pull request lands in
  // proposed_pr_title. The request page's rows read it before the session's
  // old name, so a corrected title is the name on the card — both in the
  // thread and in a multi-request change's "elsewhere" line.
  await t.test('a chosen title is the change\'s name before it has a pull request', async () => {
    const { rows: [fixed] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_title, session_title,
                                  proposed_pr_title, branch_name)
       VALUES ($1, $2, 'active', '{10}', NULL, 'Add dark mdoe toggel',
               'Add a dark mode toggle', 'feature/typo') RETURNING id`,
      [app.id, dewi.id]);
    const page = await threads.threadPage(pool, {
      thread: await threads.threadForNumber(pool, { appId: app.id, number: 10 }), viewerId: dewi.id,
    });
    assert.equal(page.items.find((i) => i.type === 'change' && i.id === Number(fixed.id)).title,
      'Add a dark mode toggle', 'the old session_title does not win over the chosen name');

    // Elsewhere: a change for two requests lives on the first one's page,
    // and the other names it — with the same chosen title.
    const { rows: [second] } = await pool.query(
      `INSERT INTO apps (name, slug, status, view_visibility, collab_visibility)
       VALUES ('Second club', 'op-club-two', 'running', 'public', 'public') RETURNING id, slug`);
    await pool.query(
      `INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 20, 'Home', $2), ($1, 21, 'Elsewhere', $2)`,
      [second.id, ana.id]);
    const { rows: [moved] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, session_title, proposed_pr_title)
       VALUES ($1, $2, 'active', '{21,20}', 'Old typo name', 'The corrected name') RETURNING id`,
      [second.id, dewi.id]);
    const elsewhere = await threads.threadPage(pool, {
      thread: await threads.threadForNumber(pool, { appId: second.id, number: 20 }), viewerId: dewi.id,
    });
    assert.deepEqual(elsewhere.elsewhere.map((e) => [e.id, e.title]),
      [[Number(moved.id), 'The corrected name']]);
  });

  // #6421: a change gathers its other request threads. The merged thread
  // counts its requests, is named by its change, and every old address opens
  // it.
  await t.test('#6421: a merged thread counts and names its requests, and old numbers open it', async () => {
    const moves = require('../src/services/thread-moves');
    const deps = { ws: { async sendSystemMessage() {} } };
    const second = await threads.threadForNumber(pool, { appId: app.id, number: 11 });
    const out = await moves.propose(pool, { app: app, user: ana, thread: second, kind: 'merge', into: 10, deps });
    assert.equal(out.ok, true, out.error);
    const old = await threads.threadForNumber(pool, { appId: app.id, number: 11 });
    assert.equal(Number(old.id), Number(pin.thread_id), 'the old number opens the merged thread');
    const page = await threads.threadPage(pool, { thread: old, viewerId: ana.id });
    assert.equal(page.thread.requests, 2);
    assert.equal(page.thread.number, 10, 'its lead request is still its page');
    assert.equal(page.thread.name, 'Pin it', 'called by the change that lives there');
    assert.deepEqual(page.elsewhere, [], 'both requests are in the one thread: no pointer');
    assert.deepEqual(await threads.requestHome(pool, { appId: app.id, sessionId: pin.id, viewerId: ana.id }), {
      number: 10, threadId: Number(pin.thread_id),
    }, 'the change still lives on the lead request\'s page');
  });
});
