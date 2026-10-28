// #3114: "Move back to Underway": POST /api/sessions/:id/unpromote.
//
// A proposal in review can be taken back to Underway by its author without
// closing its pull request. The move is the proposal machine's
// (src/workflow/proposal/machine.ts, Unpromote): it is decided under the
// row's lock, from the status the route read, and the merge queue's ask for
// the same proposal is an event to the same instance, so the two exclude
// each other (the move back during the gate and after the claim:
// tests/workflow-merge-postgres.test.js M14). This file drives the real
// route, recordVote and the platform's appends (src/workflow/platform.ts)
// with the workflow runtime running against the full PostgreSQL schema: a
// mock pool cannot show that a voided vote stops counting. The machine's own
// refusals are tests/workflow-proposal-postgres.test.js's (P7); this is the
// route's answers and what a person sees after them.
//
// Set TEST_DATABASE_URL to run the database tests; without a reachable server
// they skip (the unit-suite container has none). The source-level checks at
// the bottom run everywhere.
//
// Run with: node --test tests/unpromote-proposal-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SESSIONS_SRC = read('src/routes/sessions.js');
const APP_VIEW_SRC = read('public/js/app-view.js');

const { currentVotePredicateSql } = require('../src/services/pr-vote-revision');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const SHA = 'a'.repeat(40);

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return original;
}

// A fresh database with the full schema, or a reason to skip.
async function connect() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return { skip: 'the pg driver is not installed' }; }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500, max: 1 });
  admin.on('error', () => {});
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error(`TEST_DATABASE_URL is not reachable: ${err.message || err.code}`);
    return { skip: 'No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.' };
  }
  const dbName = `unpromote_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = `/${dbName}`;
  // The suite runs many postgres files at once against one server; this
  // file's own queries are short and the workflow runtime brings its own
  // pool, so a small pool keeps the shared server out of connection
  // contention (which can fail any subtest here).
  const pool = new Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  await pool.query(read('src/db/schema.sql'));
  const drop = async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
    await admin.end().catch(() => {});
  };
  return { pool, url: String(url), drop };
}

// Load routes/sessions.js and routes/votes.js (for recordVote) with the
// pool, the collaborator guard and the outside world stubbed: the worker the
// machine's work destroys, GitHub (off), the explicit-approval stamp a
// promote's review.open asks for. Everything else is the real code.
function loadRoutes(pool) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    worker: require.resolve('../src/services/worker'),
    github: require.resolve('../src/services/github'),
    appAdmins: require.resolve('../src/services/app-admins'),
    appAccess: require.resolve('../src/services/app-access'),
    lifecycle: require.resolve('../src/services/session-lifecycle'),
    sessions: require.resolve('../src/routes/sessions'),
    votes: require.resolve('../src/routes/votes'),
  };
  const spies = { destroyed: [] };
  const originals = [
    [paths.pool, stubModule(paths.pool, { ...require('../src/db/pool'), getPool: () => pool })],
    // The app-level collaborator guard is not what this file is about.
    [paths.appAccess, stubModule(paths.appAccess, {
      ...require('../src/services/app-access'),
      sessionCollabGuard: () => (_req, _res, next) => next(),
    })],
    [paths.worker, stubModule(paths.worker, {
      ...require('../src/services/worker'),
      destroyWorker: async (name) => { spies.destroyed.push(name); },
      // The proposal machine's worker.destroy removes it strictly.
      removeWorker: async (id) => { spies.destroyed.push(`usernode-worker-${id}`); return { removed: true }; },
    })],
    [paths.github, stubModule(paths.github, { ...require('../src/services/github'), isEnabled: () => false })],
    [paths.appAdmins, stubModule(paths.appAdmins, {
      ...require('../src/services/app-admins'),
      refreshExplicitApproval: async () => null,
    })],
  ];
  delete require.cache[paths.lifecycle];
  delete require.cache[paths.sessions];
  delete require.cache[paths.votes];
  const sessions = require('../src/routes/sessions');
  const votes = require('../src/routes/votes');
  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.lifecycle];
    delete require.cache[paths.sessions];
    delete require.cache[paths.votes];
  };
  return { sessions, votes, spies, restore };
}

async function startServer(sessions, user) {
  let current = user;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = current; next(); });
  app.use(sessions.sessionRoutes({ jwtSecret: 'test' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    as(u) { current = u; },
    async post(id) {
      const res = await fetch(`${base}/api/sessions/${id}/unpromote`, { method: 'POST' });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

test('unpromote against a real PostgreSQL, through the proposal machine', { timeout: 120000 }, async (t) => {
  const conn = await connect();
  if (conn.skip) return t.skip(conn.skip);
  const { pool } = conn;

  const users = {};
  for (const name of ['alice', 'bob', 'carol', 'dave']) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [name]);
    users[name] = u;
  }
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ('My App', 'my-app', $1, 'https://github.com/o/r') RETURNING *`,
    [users.alice.id]);

  const loaded = loadRoutes(pool);
  const platform = require('../src/workflow/platform.ts');
  await platform.startWorkflow({
    databaseUrl: conn.url, dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2,
  }, { loops: true });
  const srv = await startServer(loaded.sessions, users.alice);
  t.after(async () => {
    await srv.close();
    await platform.stopWorkflow();
    loaded.restore();
    await conn.drop();
  });

  const { recordVote } = loaded.votes;
  const vote = (sessionId, user, v = 'yes') => recordVote({
    pool, session: { id: sessionId }, userId: user.id, vote: v, headSha: SHA, revisionEnforced: true,
  });

  let prSeq = 6;
  // A row as the platform leaves it; the machine adopts it from the row at
  // its first event, as it adopts every row it does not hold yet.
  async function seed(row = {}) {
    const r = {
      user: users.alice, status: 'promoted', source: null, activeTurn: null,
      prNumber: ++prSeq, prTitle: 'Tidy the header', head: SHA, ...row,
    };
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, active_turn, branch_name,
         pr_number, pr_title, reviewed_head_sha, imported_pr_head_sha, promoted_at, integration_block_reasons)
       VALUES ($1, $2, $3, $4, $5, 'feature', $6, $7, $8, $9, NOW(), '["checks"]'::jsonb)
       RETURNING *`,
      [app.id, r.user.id, r.status, r.source, r.activeTurn, r.prNumber, r.prTitle,
        r.source === 'imported' ? null : r.head, r.source === 'imported' ? r.head : null]);
    return s;
  }
  const counted = async (id) => (await pool.query(
    `SELECT COUNT(*)::int AS n FROM pr_votes pv JOIN chat_sessions cs ON cs.id = pv.session_id
      WHERE cs.id = $1 AND ${currentVotePredicateSql('pv', 'cs')}`, [id])).rows[0].n;
  const statusOf = async (id) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id])).rows[0]?.status;
  const lines = async (id) => (await pool.query(
    `SELECT content, thread_type, thread_ref FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1 ORDER BY id`,
    [id])).rows;
  // The merge queue's ask for the proposal (MergeRequested), appended and
  // waited for: its answer is the queue's AttemptEnded message.
  const { appendEvent } = require('../src/workflow/kernel/index.ts');
  const { proposal, sessionKey } = require('../src/workflow/proposal/machine.ts');
  const decoder = proposal({ idleMs: 0, exemptFixtures: false, reviewCheckMs: 0, staleNotifyMs: 0, staleGraceMs: 0 });
  let asks = 0;
  const askMerge = async (s) => {
    const queueN = 1000 + ++asks;
    const id = await appendEvent(pool, decoder, sessionKey(s.id),
      { type: 'MergeRequested', payload: { sessionId: s.id, queueN, force: false } },
      { requestKey: `ask-${s.id}-${queueN}`, source: { kind: 'system', name: 'merge' }, appId: app.id });
    // The queue decides the ask whenever a slot picks it up; under the
    // suite's parallel load that can lag well past ten seconds, so the
    // deadline is generous. An ask that never settles fails this test loudly.
    const deadline = Date.now() + 30000;
    for (;;) {
      const { rows: [e] } = await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id]);
      if (e && e.result && e.result !== 'pending') {
        const { rows: [told] } = await pool.query(
          `SELECT payload FROM wf_events WHERE machine = 'merge-queue' AND key = $1 AND type = 'AttemptEnded'
              AND (payload->>'n')::int = $2`, [`app:${app.id}`, queueN]);
        return { status: e.result, answer: told?.payload ?? null };
      }
      if (Date.now() >= deadline) {
        assert.fail(`the merge ask on session ${s.id} (event ${id}) never settled: its result is still ${e ? e.result : 'missing'}`);
      }
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  const until = async (check, what) => {
    // Generous: what is waited for is the machine's durable work, done
    // whenever a slot gets to it under the suite's parallel load.
    const deadline = Date.now() + 30000;
    while (!(await check())) {
      if (Date.now() >= deadline) assert.fail(what);
      await new Promise((res) => setTimeout(res, 50));
    }
  };

  let mine;
  await t.test('only the proposer may move it back; others get 403, unknown ids 404', async () => {
    mine = await seed();
    srv.as(users.bob);
    const denied = await srv.post(mine.id);
    assert.equal(denied.status, 403);
    assert.equal(await statusOf(mine.id), 'promoted', 'a refused request changes nothing');

    assert.equal((await srv.post(999999)).status, 404);

    // Someone else's private Underway session reads as missing, not as
    // "not yours": the 403 is only for proposals already public.
    const paused = await seed({ status: 'paused' });
    assert.equal((await srv.post(paused.id)).status, 404);
    srv.as(users.alice);
  });

  await t.test('the author moves it back: paused, votes voided, its line in the proposal thread', async () => {
    await vote(mine.id, users.bob, 'yes');
    await vote(mine.id, users.carol, 'yes');
    assert.equal(await counted(mine.id), 2);

    const res = await srv.post(mine.id);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, status: 'paused' });
    assert.equal(await statusOf(mine.id), 'paused');
    assert.equal(await counted(mine.id), 0, 'every vote cast in review stops counting');
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM pr_votes WHERE session_id = $1', [mine.id]);
    assert.equal(rows[0].n, 2, 'the rows stay as a record, like clearApprovals');
    const { rows: [s] } = await pool.query(
      'SELECT integration_block_reasons, promoted_at FROM chat_sessions WHERE id = $1', [mine.id]);
    assert.deepEqual(s.integration_block_reasons, [], 'nothing is blocking an Underway change');
    assert.ok(s.promoted_at, 'promoted_at stays: it records that it was once proposed');

    const said = await lines(mine.id);
    assert.equal(said.length, 1, 'the proposal thread; a channel carries no activity');
    assert.match(said[0].content, new RegExp(`alice moved PR #${mine.pr_number}: Tidy the header back to Underway`));
    assert.doesNotMatch(said[0].content, /—/, 'no em dashes in product copy');
    // Its worker goes, as the machine's durable work.
    await until(async () => loaded.spies.destroyed.includes(`usernode-worker-${mine.id}`), 'the worker was destroyed');
  });

  await t.test('it is idempotent', async () => {
    const again = await srv.post(mine.id);
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyUnderway, true);
    assert.equal((await lines(mine.id)).length, 1, 'a repeat posts nothing');
  });

  await t.test('an Underway proposal cannot be voted on or asked for by the merge queue', async () => {
    const late = await vote(mine.id, users.dave, 'yes');
    assert.equal(late.rowCount, 0, 'recordVote requires review, so a late click is refused');
    const out = await askMerge(mine);
    assert.equal(out.status, 'accepted', 'the queue\'s ask is always answered');
    assert.deepEqual([out.answer?.outcome, out.answer?.reason], ['declined', 'not_in_review'], 'and never measured');
    assert.equal(await statusOf(mine.id), 'paused');
  });

  await t.test('a proposal that has started merging, or merged, or closed, stays put', async () => {
    // Left merging (the machine adopts it as the claim it is).
    const merging = await seed({ status: 'merging' });
    const res = await srv.post(merging.id);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already merging/);
    assert.equal(await statusOf(merging.id), 'merging');

    const merged = await seed({ status: 'merged' });
    assert.equal((await srv.post(merged.id)).status, 409);
    assert.equal(await statusOf(merged.id), 'merged');

    const archived = await seed({ status: 'archived' });
    const closed = await srv.post(archived.id);
    assert.equal(closed.status, 409);
    assert.match(closed.body.error, /no longer in review/);
  });

  await t.test('a running build or a held secret refuses the move', async () => {
    // The machine reads who works on it from the database (its turn's
    // journal), never one process's memory.
    const turn = await seed({ activeTurn: JSON.stringify({ turnId: 'x' }) });
    const busy = await srv.post(turn.id);
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /build is running/);
    assert.equal(await statusOf(turn.id), 'promoted');

    const secret = await seed();
    await pool.query(
      `INSERT INTO pending_secret_declarations (app_id, session_id, scope, key, declaration, status)
       VALUES ($1, $2, 'app', 'API_KEY', '{}'::jsonb, 'pending')`, [app.id, secret.id]);
    const held = await srv.post(secret.id);
    assert.equal(held.status, 409);
    assert.match(held.body.error, /Withdraw it instead/);
    assert.equal(await statusOf(secret.id), 'promoted');
  });

  await t.test('an imported PR returns to active, the state it was promoted from', async () => {
    const imported = await seed({ source: 'imported' });
    const res = await srv.post(imported.id);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'active');
    assert.equal(await statusOf(imported.id), 'active');
    // Asked about this session's worker alone: a count over every teardown
    // would read one an earlier subtest's work landed late.
    assert.ok(!loaded.spies.destroyed.includes(`usernode-worker-${imported.id}`),
      'an imported PR has no worker to tear down');
  });

  await t.test('re-promotion goes through the machine\'s promote, and starts with no votes counted', async () => {
    // `mine` was moved back above with two voided votes. (The cap is high:
    // this file's other proposals are alice's too.)
    const asked = await platform.promoteProposal({
      sessionId: mine.id, appId: app.id, userId: users.alice.id, username: 'alice', from: 'paused', cap: 100, pr: null,
    });
    // 202 is the route's answer while a slot has yet to process the promote
    // (under the suite's parallel load that can outlast the ask's own wait);
    // the ask then settles on its own, and that end is what this asserts.
    const reply = asked.status === 202
      ? await platform.promoteSettled({ sessionId: mine.id, waitMs: 30000 })
      : asked;
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(await statusOf(mine.id), 'promoted');
    assert.equal(await counted(mine.id), 0, 'the fresh review starts with no votes counted');

    const fresh = await vote(mine.id, users.bob, 'yes');
    assert.equal(fresh.rowCount, 1);
    assert.equal(await counted(mine.id), 1, 'a vote in the new review counts');

    // And it can be moved back a second time.
    assert.equal((await srv.post(mine.id)).status, 200);
    assert.equal(await counted(mine.id), 0);
  });
});

// ── Source-level checks (no database) ──────────────────────────────────

test('the route is owner-scoped through the lifecycle service', () => {
  const route = SESSIONS_SRC.match(/router\.post\('\/api\/sessions\/:id\/unpromote'[\s\S]*?\n  \}\);/);
  assert.ok(route, 'POST /api/sessions/:id/unpromote must be mounted');
  assert.match(route[0], /sessionLifecycle\.unpromoteSession\(\{\s*pool, sessionId, userId: req\.user\.id/);
  assert.match(route[0], /status\(403\)/);
});

test('the proposal menu and detail view offer the move to the author only', () => {
  const menu = APP_VIEW_SRC.match(/_proposalMenuItems\(pr, state\) \{[\s\S]*?\n  \},/);
  assert.ok(menu);
  assert.match(menu[0],
    /if \(st\.mine && !ro && !isMerged && !isMerging && pr\.status === 'promoted'\) \{\s*items\.push\(\{\s*label: PlatformI18n\.t\('changes:proposal\.menu\.moveBack'\)/);
  assert.equal(require('./lib/platform-i18n').message('changes:proposal.menu.moveBack'), 'Move back to Underway');
  assert.match(APP_VIEW_SRC, /key: 'unpromote', cls: 'gc-vote-btn', label: PlatformI18n\.t\('changes:card\.actions\.moveBack'\)/);
  assert.equal(require('./lib/platform-i18n').message('changes:card.actions.moveBack'), 'Move back to Underway');
  assert.match(APP_VIEW_SRC, /fetch\(`\/api\/sessions\/\$\{sessionId\}\/unpromote`, \{ method: 'POST' \}\)/,
    'the client path is spelled literally, so a search for the route finds its caller');
  const fn = APP_VIEW_SRC.match(/async unpromoteProposal\(sessionId\) \{[\s\S]*?\n  \},/);
  assert.ok(fn);
  // The confirm copy is read from the catalog.
  assert.match(fn[0], /message: PlatformI18n\.t\('changes:proposal\.moveBack\.message', \{ number: prNum \}\),/);
  const confirmCopy = require('./lib/platform-i18n').message('changes:proposal.moveBack.message', { number: 7 });
  assert.match(confirmCopy, /Its votes are cleared and it cannot be merged until you propose it again/);
  assert.doesNotMatch(fn[0], /—/, 'no em dashes in the confirm copy');
  assert.doesNotMatch(confirmCopy, /—/, 'no em dashes in the confirm copy');
});
