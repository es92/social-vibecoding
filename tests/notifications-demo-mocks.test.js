// Route tests for the staging (?demo=1) session-notification mocks and
// the kind-scoped mark-all on POST /api/notifications/read.
//
// GET /api/notifications?demo=1 in staging injects unread mock rows
// — one per session-related kind (session_done / session_stalled (#3181) /
// auto_solve_done / stale_pr / check_failed), a second session_done covering the #971
// untitled tail of the label ladder, and a consecutive PAIR of
// `conversation_message` rows in one conversation (which the sheet collapses
// into a single counted row) — so
// the green session badge, the bell's EXCLUSION of the session kinds from
// its own count, and the message notifications it DOES count are all
// reviewable in a staging preview. Per the "Staging
// mock data" convention the injection is request-time only, first page
// only, bumps the unread aggregate to match, and is strictly a no-op
// outside staging (or without ?demo=1).
//
// Harness shape mirrors tests/me-proposals-approver-tally.test.js: stub
// getPool BEFORE requiring the route module (destructured at require
// time), mount on a real express app, inject req.user. The route module
// captures USERNODE_ENV at load, so each environment gets a fresh
// require.
//
// Run with: node --test tests/notifications-demo-mocks.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');

// In-memory pool answering the three queries the GET route issues plus
// the mark-read UPDATEs, recording every call.
function makeMockPool() {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/FROM notifications n/.test(sql)) {
        // One real row so mock-vs-real ordering is observable.
        return Promise.resolve({
          rows: [{
            id: 1, kind: 'mention', read_at: null,
            created_at: '2026-07-01T00:00:00Z', app_id: 5,
            app_slug: 'real-app', app_name: 'Real App',
            chat_message_id: 10, message_content: 'hi @you',
            thread_type: null, thread_ref: null, session_id: null,
            pr_title: null, pr_number: null, headless_issue_number: null,
            branch_name: null, source_username: 'alice', detail: null,
          }],
        });
      }
      if (/COUNT\(\*\)::int AS c FROM notifications/.test(sql)) {
        return Promise.resolve({ rows: [{ c: 2 }] });
      }
      if (/FROM app_collaborators/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/UPDATE notifications SET read_at/.test(sql)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

// Load ../src/routes/notifications fresh under a given USERNODE_ENV.
function loadRoutes(env, pool) {
  const prevEnv = process.env.USERNODE_ENV;
  if (env == null) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = env;
  const prevGetPool = poolMod.getPool;
  poolMod.getPool = () => pool;
  const routePath = require.resolve('../src/routes/notifications');
  delete require.cache[routePath];
  const mod = require('../src/routes/notifications');
  // Restore for other test files; the loaded module keeps its capture.
  if (prevEnv == null) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = prevEnv;
  poolMod.getPool = prevGetPool;
  delete require.cache[routePath];
  return mod;
}

function startServer(mod) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(mod.notificationsRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

const SESSION_KINDS = ['session_done', 'auto_solve_done', 'stale_pr', 'check_failed'];
// #3181: the demo feed also carries a session that stopped before finishing,
// the one way a preview can show that row. Kept out of SESSION_KINDS, which
// the mark-read scoping test below sends as a request body.
const DEMO_KINDS = [...SESSION_KINDS, 'session_stalled'];

test('staging + ?demo=1: eleven mock rows prepend, and only the unread ones bump unread', async () => {
  const pool = makeMockPool();
  const mod = loadRoutes('staging', pool);
  const { server, port } = await startServer(mod);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notifications?limit=100&demo=1`);
    assert.equal(res.status, 200);
    const body = await res.json();

    const mocks = body.notifications.filter((n) => n.id >= 990000);
    assert.equal(mocks.length, 11, 'exactly eleven mock rows injected');
    assert.deepEqual(
      [...new Set(mocks.map((n) => n.kind))].sort(),
      [...DEMO_KINDS, 'conversation_message', 'platform_limit'].sort(),
      'every session-related kind is covered, plus the message row and a platform limit alert'
    );
    assert.equal(
      mocks.filter((n) => n.kind === 'session_done').length, 4,
      '#971: two session_done rows — one titled, one untitled — plus the read one below; '
      + "#1808's row from an earlier year is the fourth"
    );
    // The message row exists because the bell COUNTS message notifications
    // and lists them: a staging clone has no conversations (the tables are
    // staging:private), so without it a preview shows the sheet with no
    // message in it. It leads the list, which is what the screenshots catch.
    const conversationMocks = mocks.filter((n) => n.kind === 'conversation_message');
    assert.equal(conversationMocks.length, 2,
      'TWO of them, so a preview can show a collapsed run and not just one row');
    const conversationMock = conversationMocks[0];
    assert.equal(mocks[0].id, conversationMock.id, 'and they lead the set');
    // Adjacent, and in one conversation: that is what collapses them into a
    // single row carrying a count. Split them with any other row and the
    // preview shows two ordinary rows instead.
    assert.equal(mocks[1].id, conversationMocks[1].id, 'the pair is consecutive');
    assert.equal(
      conversationMocks[0].conversationId, conversationMocks[1].conversationId,
      'and both sit in the same conversation',
    );
    assert.ok(
      Date.parse(conversationMocks[0].createdAt) > Date.parse(conversationMocks[1].createdAt),
      'newest first, like the feed they are prepended to',
    );
    assert.equal(conversationMock.appSlug, null,
      'a conversation row carries no app attribution — serialize fails that shape closed');
    assert.match(conversationMock.conversationTitle, /^\[Mock\]/);
    assert.match(conversationMock.messageContent, /^\[Mock\]/);
    assert.ok(conversationMock.conversationId > 0, 'a routable conversation id');
    // The unread rows feed the cog badge, and ONE ships already read. That
    // last one is the only thing a staging preview has behind the drawer's
    // "See more notifications" button: without it the button does not
    // render at all and the caught-up state is unreachable, so the two things
    // a reviewer is asked to look at are both invisible.
    assert.equal(mocks.filter((n) => !n.readAt).length, 10,
      'ten unread rows feed the badges');
    const readMocks = mocks.filter((n) => n.readAt);
    assert.equal(readMocks.length, 1, 'exactly one already-read row');
    assert.match(readMocks[0].sessionTitle, /\[Mock\]/,
      'and it is obviously fake, like the rest');
    assert.ok(
      mocks.filter((n) => n.kind !== 'conversation_message' && n.kind !== 'platform_limit')
        .every((n) => n.appSlug === 'staging-demo'),
      'obviously-fake app attribution on every APP-scoped row',
    );
    // The platform limit row is the server's, not an app's, like the real one.
    const limit = mocks.find((n) => n.kind === 'platform_limit');
    assert.equal(limit.appSlug, null);
    assert.equal(limit.detail, 'apps_warn:40:50');
    assert.equal(limit.readAt, null, 'unread, so it shows on the Unread tab the sheet opens on');
    assert.equal(
      mocks.find((n) => n.kind === 'auto_solve_done').detail, 'failed',
      'the auto-solve mock exercises the failed variant'
    );
    // Real rows survive after the mocks; unread bumped by the UNREAD mock
    // count so the client's badge subtraction stays honest. Counting all
    // eleven would claim the read row as unread — inflating the badge by one
    // and leaving "Mark all read" enabled with nothing left to mark.
    assert.ok(body.notifications.some((n) => n.id === 1), 'real rows still present');
    assert.equal(body.unread, 2 + 10);
  } finally {
    server.close();
  }
});

test('staging WITHOUT ?demo=1 and follow-up pages stay mock-free', async () => {
  const pool = makeMockPool();
  const mod = loadRoutes('staging', pool);
  const { server, port } = await startServer(mod);
  try {
    const first = await (await fetch(`http://127.0.0.1:${port}/api/notifications?limit=100`)).json();
    assert.ok(first.notifications.every((n) => n.id < 990000), 'no mocks without demo=1');
    assert.equal(first.unread, 2);

    // Cursor follow-up WITH demo=1: mocks are first-page-only (they would
    // duplicate on every older page otherwise).
    const paged = await (await fetch(
      `http://127.0.0.1:${port}/api/notifications?limit=100&demo=1&before=2026-07-01T00:00:00Z&before_id=1`
    )).json();
    assert.ok(paged.notifications.every((n) => n.id < 990000), 'no mocks on cursor pages');
    assert.equal(paged.unread, undefined, 'unread aggregate stays first-page-only');
  } finally {
    server.close();
  }
});

test('production: ?demo=1 is a strict no-op', async () => {
  const pool = makeMockPool();
  const mod = loadRoutes('production', pool);
  const { server, port } = await startServer(mod);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/notifications?limit=100&demo=1`)).json();
    assert.ok(body.notifications.every((n) => n.id < 990000), 'no mock rows in production');
    assert.equal(body.unread, 2);
  } finally {
    server.close();
  }
});

test('stagingMockNotifications rows carry the fields the shared row renderers read', () => {
  const pool = makeMockPool();
  const mod = loadRoutes('staging', pool);
  const rows = mod.stagingMockNotifications();
  assert.equal(rows.length, 11);
  for (const r of rows) {
    assert.ok(r.id >= 990000 && r.id < 1000000, 'ids sit in the 99xxxx mock range');
    // `readAt` is null on every row EXCEPT the one that exists to be read —
    // the drawer parks read notifications behind "See more notifications",
    // and a staging clone has nothing to put there otherwise.
    assert.ok(r.readAt === null || typeof r.readAt === 'string',
      'readAt is either absent or a timestamp');
    assert.ok(r.createdAt, 'timestamp present for relativeTime');
    // App attribution on the app-scoped rows only. The message row is a
    // CONVERSATION row: serialize() nulls the app fields on one and fails the
    // shape closed when they are both set, so a mock carrying them would be
    // describing something the real pipeline never emits.
    assert.equal(r.appName,
      r.kind === 'conversation_message' || r.kind === 'platform_limit' ? null : 'Staging demo app');
    assert.ok('sessionTitle' in r, '#971: every mock row carries the sessionTitle field');
  }

  // The message row carries what the conversation branch of rowView reads:
  // the sender, the conversation's title, and the snippet under it.
  const conversation = rows.find((r) => r.kind === 'conversation_message');
  assert.ok(conversation, 'a message notification is among the mocks');
  assert.equal(rows.filter((r) => r.kind === 'conversation_message').length, 2,
    'a PAIR, so the collapsed-run row has something to collapse');
  assert.equal(conversation.readAt, null, 'it is unread, so the bell counts it');
  assert.match(conversation.sourceUsername, /staging-demo/, 'an obviously-fake sender');
  assert.match(conversation.conversationTitle, /^\[Mock\]/);
  assert.match(conversation.messageContent, /^\[Mock\]/);
  assert.equal(conversation.appId, null, 'no app attribution on a conversation row');

  // #971: the titled session_done row is the issue's exact case — a session
  // that has a title but no PR yet. It must carry BOTH so a preview shows the
  // title winning over the dev name.
  const titled = rows.find((r) => r.kind === 'session_done' && r.sessionTitle);
  assert.match(titled.sessionTitle, /^\[Mock\]/, 'mock titles are obviously fake');
  assert.equal(titled.prTitle, null, 'no PR title — the pre-promotion case');
  assert.match(titled.branchName, /^dev\//, 'a dev name is present to be beaten');

  // The already-read row: read STRICTLY after it was created, so the drawer's
  // older view sorts it sensibly and nothing renders a negative age.
  const readRow = rows.find((r) => r.readAt);
  assert.ok(readRow, 'one row ships already read');
  assert.ok(Date.parse(readRow.readAt) > Date.parse(readRow.createdAt),
    'read after it arrived');
  assert.ok(Date.parse(readRow.createdAt) < Date.now(), 'and it is genuinely older');
  assert.equal(rows.filter((r) => r.readAt).length, 1, 'exactly one');

  // ...and the untitled one proves the branch-name fallback survives.
  const untitled = rows.find((r) => r.kind === 'session_done' && !r.sessionTitle);
  assert.equal(untitled.sessionTitle, null);
  assert.equal(untitled.prTitle, null);
  assert.match(untitled.branchName, /^dev\//, 'falls back to the dev name');

  for (const kind of ['stale_pr', 'check_failed']) {
    const row = rows.find((r) => r.kind === kind);
    assert.match(row.prTitle, /^\[Mock\]/, `${kind} row keeps its PR title`);
    assert.match(row.sessionTitle, /^\[Mock\]/, `${kind} row carries a session title too`);
  }

  const autoSolve = rows.find((r) => r.kind === 'auto_solve_done');
  assert.ok(autoSolve.headlessIssueNumber, 'auto-solve row points at an issue number');

  // #3181: the stalled row names its session and points at it, like the
  // finished one, so the row renders its title and opens the change.
  const stalled = rows.find((r) => r.kind === 'session_stalled');
  assert.ok(stalled, 'a stalled-session row is among the mocks');
  assert.equal(stalled.readAt, null, 'unread, so the Unread tab shows it');
  assert.match(stalled.sessionTitle, /^\[Mock\]/);
  assert.ok(stalled.sessionId >= 990000, 'a routable mock session id');
});

// ── POST /api/notifications/read kind scoping ───────────────────────────

// The ROUTE's kind scoping, which is unchanged. #1610 removed the last CLIENT
// that sent `exclude_kinds` (the bell's mark-all, which used to skip the
// session kinds because a second surface counted them), but the parameter is
// how any scoped clear is expressed and an unpinned SQL builder is how one
// silently starts clearing the wrong rows.
test('POST /read {all, kinds} and {all, exclude_kinds} reach the service scoped', async () => {
  const pool = makeMockPool();
  const mod = loadRoutes('production', pool);
  const { server, port } = await startServer(mod);
  try {
    await fetch(`http://127.0.0.1:${port}/api/notifications/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, kinds: SESSION_KINDS }),
    });
    let update = pool.calls.find((c) => /UPDATE notifications SET read_at/.test(c.sql));
    assert.ok(update, 'update issued');
    assert.match(update.sql, /kind = ANY\(\$2\)/);
    assert.deepEqual(update.params, [7, SESSION_KINDS]);

    pool.calls.length = 0;
    await fetch(`http://127.0.0.1:${port}/api/notifications/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, exclude_kinds: SESSION_KINDS }),
    });
    update = pool.calls.find((c) => /UPDATE notifications SET read_at/.test(c.sql));
    assert.match(update.sql, /NOT \(kind = ANY\(\$2\)\)/);
    assert.deepEqual(update.params, [7, SESSION_KINDS]);

    // Non-array / junk kind values are ignored → unscoped clear-all.
    pool.calls.length = 0;
    await fetch(`http://127.0.0.1:${port}/api/notifications/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, kinds: 'session_done' }),
    });
    update = pool.calls.find((c) => /UPDATE notifications SET read_at/.test(c.sql));
    assert.doesNotMatch(update.sql, /ANY/);
    assert.deepEqual(update.params, [7]);
  } finally {
    server.close();
  }
});
