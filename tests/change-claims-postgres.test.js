'use strict';

// #6420: a change's `linked_issues` is a claim, not a merge. Against the real
// schema in a throwaway database, this pins:
//
//   1. The first time a change visible to everyone names a request in another
//      thread, Homeroom bot writes ONE line in that request's discussion and
//      the request's followers are notified. A second call writes nothing.
//      A private change, a same-thread request and a closed request are not
//      announced.
//   2. The requester's "This doesn't close it" records the answer once, posts
//      one line in the change's discussion, and never changes linked_issues.
//      The route's membership gate, the requester check and the own-change
//      check hold.
//   3. The request's page reads the claim: the change's summary, whether the
//      viewer may answer, and the answered state.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/change-claims-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a change\'s claim on a request is told once and can be answered', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `change_claims_${crypto.randomBytes(6).toString('hex')}`;
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
  const claims = require('../src/services/change-claims');
  const threads = require('../src/services/threads');
  const communities = require('../src/services/communities');
  const { issueRoutes } = require('../src/routes/issues');

  const users = {};
  const user = async (username) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`, [username]);
    users[row.id] = { id: row.id, username: row.username };
    return users[row.id];
  };
  const [ana, dewi, sam] = [await user('claim_ana'), await user('claim_dewi'), await user('claim_sam')];
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, view_visibility, collab_visibility)
     VALUES ('Claim club', 'claim-club', 'running', 'public', 'public') RETURNING id, slug, community_id`);
  await pool.query(
    `INSERT INTO requests (app_id, number, title, created_by)
     VALUES ($1, 20, 'Show who replied last', $2), ($1, 21, 'Pin a message', $2), ($1, 22, 'Closed one', $2)`,
    [app.id, ana.id]);
  await pool.query(`UPDATE requests SET state = 'closed', closed_at = NOW() WHERE app_id = $1 AND number = 22`, [app.id]);
  // The requester is a member, as filing a request would make them.
  await communities.join(pool, app, ana.id);
  const change = async (by, { linked = [], status = 'promoted', shared = false, pr = null, title = 'Tidy the rows', summary = null } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, pr_summary_md, branch_name, shared_at)
     VALUES ($1, $2, $3, $4::int[], $5, $6, $7, $8, CASE WHEN $9::boolean THEN NOW() END) RETURNING id, thread_id, linked_issues`,
    [app.id, by.id, status, linked, pr, title, summary, `feature/${pr || crypto.randomBytes(3).toString('hex')}`, shared])).rows[0];
  const pin = await change(dewi, { pr: 6230, linked: [21, 20], title: 'Tidy the Workshop', summary: 'Rows show who replied last. Ten at once.' });
  const { rows: [threadTwenty] } = await pool.query('SELECT id FROM requests WHERE app_id = $1 AND number = 20', [app.id]);
  assert.notEqual(Number(pin.thread_id), Number(threadTwenty.id), 'the change lives on request 21\'s page');

  // A second follower of request 20, from an earlier message there.
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'Same here', 'issue', 20)`,
    [app.id, sam.id]);

  const messagesIn = async (number) => (await pool.query(
    `SELECT id, user_id, content FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2 ORDER BY id`,
    [app.id, number])).rows;
  const notificationsFor = async (who) => (await pool.query(
    'SELECT chat_message_id, kind, detail FROM notifications WHERE user_id = $1 AND app_id = $2 ORDER BY id',
    [who.id, app.id])).rows;

  await t.test('the first announcement writes one line and notifies the request\'s followers', async () => {
    assert.equal(await claims.announce(pool, { sessionId: Number(pin.id) }), 1);
    const lines = await messagesIn(20);
    const line = lines.find((m) => /says it closes your request #20/.test(m.content));
    assert.ok(line, 'one line in the request\'s discussion');
    assert.match(line.content, /^Change #6230 says it closes your request #20\.$/);
    const { rows: [bot] } = await pool.query('SELECT id, username FROM users WHERE is_synthetic = TRUE LIMIT 1');
    assert.equal(Number(line.user_id), Number(bot.id), 'written by Homeroom bot');
    for (const who of [ana, sam]) {
      const rows = (await notificationsFor(who)).filter((n) => Number(n.chat_message_id) === Number(line.id));
      assert.equal(rows.length, 1, 'the requester and the follower each hear it once');
      assert.equal(rows[0].kind, 'issue_thread_reply');
      assert.equal(rows[0].detail, '20');
    }
    // Request 21 leads the change's thread: its page draws the change itself.
    assert.ok(!(await messagesIn(21)).some((m) => /says it closes/.test(m.content)), 'no line on the thread that leads it');

    const before = (await messagesIn(20)).length;
    assert.equal(await claims.announce(pool, { sessionId: Number(pin.id) }), 0, 'a second call tells nobody');
    assert.equal((await messagesIn(20)).length, before);
  });

  await t.test('a private change, a same-thread request and a closed request are not announced', async () => {
    const draft = await change(dewi, { linked: [21, 20], status: 'active', title: 'Still private' });
    assert.equal(await claims.announce(pool, { sessionId: Number(draft.id) }), 0, 'not visible to everyone yet');

    const shared = await change(dewi, { linked: [21, 20], status: 'active', shared: true, title: 'Shared draft' });
    assert.equal(await claims.announce(pool, { sessionId: Number(shared.id) }), 1, 'shared is announced');

    const sameThread = await change(dewi, { linked: [21], status: 'promoted', title: 'On 21' });
    assert.equal(await claims.announce(pool, { sessionId: Number(sameThread.id) }), 0, 'the page that leads it already draws it');

    const closed = await change(dewi, { linked: [21, 22], status: 'promoted', title: 'For a closed request' });
    assert.equal(await claims.announce(pool, { sessionId: Number(closed.id) }), 0, 'a closed request is not told');
  });

  await t.test('the request\'s page reads the claim, its summary, and who may answer', async () => {
    const twenty = await threads.threadForNumber(pool, { appId: app.id, number: 20 });
    const asAna = await threads.threadPage(pool, { thread: twenty, viewerId: ana.id });
    const card = asAna.elsewhere.find((e) => Number(e.id) === Number(pin.id));
    assert.deepEqual({ ...card }, {
      id: Number(pin.id), number: 6230, title: 'Tidy the Workshop', summary: 'Rows show who replied last.',
      on: 21, request: 20, disputed: false, mine: true, ask: true,
    });
    const asSam = await threads.threadPage(pool, { thread: twenty, viewerId: sam.id });
    assert.equal(asSam.elsewhere.find((e) => Number(e.id) === Number(pin.id)).ask, false, 'only the requester is asked');
    const signedOut = await threads.threadPage(pool, { thread: twenty, viewerId: null });
    assert.equal(signedOut.elsewhere.find((e) => Number(e.id) === Number(pin.id)).ask, false);
  });

  // The route, mounted as the app mounts it, with the browser write check
  // and the membership gate in front of it.
  const httpApp = express();
  httpApp.use((req, _res, next) => { req.user = users[Number(req.get('x-test-user'))]; next(); });
  httpApp.use(issueRoutes({}));
  server = await new Promise((resolve) => { const s = httpApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const answer = async (who, sessionId = pin.id) => {
    const res = await fetch(`${base}/api/apps/${app.slug}/issues/20/changes/${sessionId}/not-closing`, {
      method: 'POST',
      headers: { 'x-test-user': String(who.id), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const changeLines = async (sessionId) => (await pool.query(
    `SELECT content FROM chat_messages WHERE app_id = $1 AND thread_type = 'session' AND thread_ref = $2
       AND content LIKE '%doesn''t close their request%' ORDER BY id`, [app.id, sessionId])).rows;

  await t.test('answering: the gate, the requester and the change\'s builder', async () => {
    const outsider = await user('claim_outsider');
    const refused = await answer(outsider);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'join_required', 'a non-member meets the request-membership gate');

    await communities.join(pool, app, sam.id);
    const notRequester = await answer(sam);
    assert.equal(notRequester.status, 403);
    assert.equal(notRequester.body.code, 'not_requester');

    const own = await change(ana, { linked: [20], status: 'promoted', title: 'Ana\'s own change' });
    const ownAnswer = await answer(ana, own.id);
    assert.equal(ownAnswer.status, 409);
    assert.equal(ownAnswer.body.code, 'own_change');
  });

  await t.test('answering records it once, posts one line, and leaves linked_issues alone', async () => {
    const linkedBefore = (await pool.query('SELECT linked_issues FROM chat_sessions WHERE id = $1', [pin.id])).rows[0].linked_issues;
    const first = await answer(ana);
    assert.deepEqual(first, { status: 200, body: { ok: true, disputed: true } });
    const lines = await changeLines(pin.id);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].content, '@claim_ana says this doesn\'t close their request #20.');

    const second = await answer(ana);
    assert.deepEqual(second, { status: 200, body: { ok: true, disputed: true } });
    assert.equal((await changeLines(pin.id)).length, 1, 'idempotent, with no second line');
    assert.deepEqual((await pool.query('SELECT linked_issues FROM chat_sessions WHERE id = $1', [pin.id])).rows[0].linked_issues,
      linkedBefore, 'nothing is unlinked');

    const twenty = await threads.threadForNumber(pool, { appId: app.id, number: 20 });
    const asAna = await threads.threadPage(pool, { thread: twenty, viewerId: ana.id });
    const card = asAna.elsewhere.find((e) => Number(e.id) === Number(pin.id));
    assert.equal(card.disputed, true, 'the page shows the answer');
    assert.equal(card.ask, false, 'and stops asking');

    const twentyOne = await threads.threadForNumber(pool, { appId: app.id, number: 21 });
    const home = await threads.threadPage(pool, { thread: twentyOne, viewerId: ana.id });
    assert.deepEqual(home.items.find((i) => i.type === 'change' && Number(i.id) === Number(pin.id)).notConfirmed, [20],
      'the change\'s own "Also closes" line marks request 20');
  });
});
