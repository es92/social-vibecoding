// Tests for the topic-thread parity work (dev card list polish):
//
//   1. notifications.listForUser / serialize carry the chat message's
//      thread scope (threadType / threadRef) so the client drawer can
//      route a mention/reply/reaction click to the topic view instead
//      of general chat.
//   2. POST /api/sessions/:id/promote dual-posts its announcement —
//      one general-chat system message (no thread) AND one scoped into
//      the proposal's own thread ({ type: 'session', ref }), both
//      carrying the vote metadata for the inline vote buttons.
//
// Like session-done-notifications.test.js, the pool is an in-memory
// mock that pattern-matches SQL, and side-effect modules (ws,
// app-access, github) are stubbed via require.cache.
//
// Run with: node --test tests/thread-activity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// ── 1. notifications: thread fields ─────────────────────────────────────

const notifications = require('../src/services/notifications');

test('listForUser selects thread_type/thread_ref off the chat message', async () => {
  let capturedSql = null;
  const pool = {
    query: async (sql) => {
      capturedSql = String(sql);
      return {
        rows: [{
          id: 1, kind: 'mention', read_at: null, created_at: 'now',
          app_id: 5, app_slug: 'demo', app_name: 'Demo',
          chat_message_id: 99, message_content: 'hey @alice',
          thread_type: 'issue', thread_ref: 42,
          session_id: null, pr_title: null, pr_number: null,
          headless_issue_number: null, branch_name: null,
          source_username: 'bob', detail: null,
        }],
      };
    },
  };
  const rows = await notifications.listForUser(pool, 1);
  assert.match(capturedSql, /cm\.thread_type, cm\.thread_ref/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].thread_type, 'issue');
  assert.equal(rows[0].thread_ref, 42);
});

test('serialize exposes threadType/threadRef (null when unscoped)', () => {
  const base = {
    id: 1, kind: 'mention', read_at: null, created_at: 'now',
    app_id: 5, app_slug: 'demo', app_name: 'Demo',
    chat_message_id: 99, message_content: 'hey',
    session_id: null, pr_title: null, pr_number: null,
    headless_issue_number: null, branch_name: null,
    source_username: 'bob', detail: null,
  };
  const threaded = notifications.serialize({
    ...base, thread_type: 'session', thread_ref: 10,
  });
  assert.equal(threaded.threadType, 'session');
  assert.equal(threaded.threadRef, 10);

  // A general-chat mention (or a pre-thread row hydrated without the
  // columns) serializes to explicit nulls — the client falls back to
  // the Dev → Chat navigation.
  const general = notifications.serialize(base);
  assert.equal(general.threadType, null);
  assert.equal(general.threadRef, null);
});

// ── 2. promote dual-post ────────────────────────────────────────────────

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = {
    id, filename: id, loaded: true, exports,
    paths: original ? original.paths : [],
  };
  return original;
}

// Load ../src/routes/votes fresh against a mock pool + recording ws +
// pass-through app-access guard + disabled github.
function loadVotes(mockPool) {
  const poolPath = require.resolve('../src/db/pool');
  const wsPath = require.resolve('../src/services/ws');
  const appAccessPath = require.resolve('../src/services/app-access');
  const githubPath = require.resolve('../src/services/github');
  const votesPath = require.resolve('../src/routes/votes');

  const systemMessages = [];
  const origPool = stubModule(poolPath, { getPool: () => mockPool });
  const origWs = stubModule(wsPath, {
    sendSystemMessage: async (_pool, appId, content, msgType, metadata, thread) => {
      systemMessages.push({ appId, content, msgType, metadata: metadata || null, thread: thread || null });
    },
    pushNotificationToUser: () => 1,
    pushSessionUpdate: () => {},
    pushVoteUpdate: () => {},
    pushKudosUpdate: () => {},
    pushAppUpdate: () => {},
    pushIssueUpdate: () => {},
    pushAppStatusUpdate: () => {},
    broadcast: () => {},
    broadcastGlobal: () => {},
    broadcastGlobalScoped: () => {},
    getOnlineUsers: () => [],
    getReactionsForMessages: async () => new Map(),
    attach: () => {},
  });
  const origAppAccess = stubModule(appAccessPath, {
    sessionCollabGuard: () => (_req, _res, next) => next(),
    getAppForUser: async () => null,
  });
  const origGithub = stubModule(githubPath, {
    isEnabled: () => false,
    getInstallationOctokit: async () => { throw new Error('github disabled in test'); },
  });
  delete require.cache[votesPath];

  const subject = require('../src/routes/votes');

  const restore = () => {
    if (origPool) require.cache[poolPath] = origPool; else delete require.cache[poolPath];
    if (origWs) require.cache[wsPath] = origWs; else delete require.cache[wsPath];
    if (origAppAccess) require.cache[appAccessPath] = origAppAccess; else delete require.cache[appAccessPath];
    if (origGithub) require.cache[githubPath] = origGithub; else delete require.cache[githubPath];
    delete require.cache[votesPath];
  };
  return { subject, systemMessages, restore };
}

// Minimal pool for the happy-path promote: an active session with a PR
// and staging already in place (skips lazy PR creation and the
// fire-and-forget staging build).
function makePromotePool(session) {
  const calls = [];
  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });
    if (/WHERE cs\.id = \$1 AND cs\.user_id = \$2 AND cs\.status IN \('active', 'paused'\)/.test(s)) {
      return Number(params[0]) === session.id && params[1] === session.user_id
        ? { rows: [session] } : { rows: [] };
    }
    if (/SELECT COUNT\(\*\) AS cnt FROM chat_sessions/.test(s)) {
      return { rows: [{ cnt: '0' }] };
    }
    if (/SET status = 'promoted', promoted_at = NOW\(\)/.test(s)) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  return { query, calls };
}

async function startVotesServer(loaded, user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(loaded.subject.voteRoutes({ maxUserPromotedSessions: 3 }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('promote announces to general chat AND the proposal thread', async () => {
  const session = {
    id: 10, user_id: 1, app_id: 5, app_slug: 'demo', app_name: 'Demo',
    repo_url: 'https://github.com/o/r', status: 'active', is_headless: false,
    pr_number: 7, pr_title: 'Add feature', pr_url: 'https://github.com/o/r/pull/7',
    branch_name: 'dev/alice-1', staging_url: 'https://pr7.example',
  };
  const pool = makePromotePool(session);
  const loaded = loadVotes(pool);
  const srv = await startVotesServer(loaded, { id: 1, username: 'alice' });
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/10/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.prNumber, 7);

    const promos = loaded.systemMessages.filter((m) => /promoted PR #7/.test(m.content));
    assert.equal(promos.length, 2, 'one general post + one thread post');

    const general = promos.find((m) => !m.thread);
    assert.ok(general, 'general-chat announcement (no thread scope)');
    assert.equal(general.msgType, 'vote');
    assert.deepEqual(general.metadata, { vote: { sessionId: 10, prNumber: 7 } });

    const threaded = promos.find((m) => m.thread);
    assert.ok(threaded, 'thread-scoped announcement');
    assert.deepEqual(threaded.thread, { type: 'session', ref: 10 });
    assert.equal(threaded.msgType, 'vote');
    assert.deepEqual(threaded.metadata, { vote: { sessionId: 10, prNumber: 7 } });
    assert.equal(threaded.content, general.content);
  } finally {
    await srv.close();
    loaded.restore();
  }
});
