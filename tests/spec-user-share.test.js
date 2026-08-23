// Tests for the #86 private "Share to user" spec flow.
//
// Two surfaces:
//   1. POST /api/sessions/:id/specs/:version/share-user — owner-only,
//      resolves the recipient case-insensitively, respects collab-private
//      membership, inserts the share row + exactly one 'spec_shared'
//      notification (re-shares are idempotent and never re-ping).
//   2. GET /api/sessions/:id/specs/:version — the read gate widened by a
//      share row: the recipient can fetch the exact shared version while
//      an unrelated third user still 404s.
//
// Like session-done-notifications.test.js, the pool is an in-memory mock
// that pattern-matches SQL, and the ws module is stubbed via require.cache
// so pushes are recorded instead of broadcast. No real Postgres / sockets.
//
// Run with: node --test tests/spec-user-share.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// ── require.cache stubbing ──────────────────────────────────────────────

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = {
    id, filename: id, loaded: true, exports,
    paths: original ? original.paths : [],
  };
  return original;
}

// Load ../src/routes/sessions fresh with a mock pool + a ws spy.
function loadSessions(mockPool) {
  const poolPath = require.resolve('../src/db/pool');
  const wsPath = require.resolve('../src/services/ws');
  const sessionsPath = require.resolve('../src/routes/sessions');
  const notificationsPath = require.resolve('../src/services/notifications');

  const pushes = [];
  const origPool = stubModule(poolPath, { getPool: () => mockPool });
  const origWs = stubModule(wsPath, {
    pushNotificationToUser: (userId, payload) => { pushes.push({ userId, payload }); return 1; },
    broadcastGlobal: () => {},
    broadcast: () => {},
  });
  delete require.cache[sessionsPath];
  delete require.cache[notificationsPath];

  const subject = require('../src/routes/sessions');
  const notifications = require('../src/services/notifications');

  const restore = () => {
    if (origPool) require.cache[poolPath] = origPool; else delete require.cache[poolPath];
    if (origWs) require.cache[wsPath] = origWs; else delete require.cache[wsPath];
    delete require.cache[sessionsPath];
    delete require.cache[notificationsPath];
  };
  return { subject, notifications, pushes, restore };
}

// ── In-memory mock pool ─────────────────────────────────────────────────
// Holds the tables the share-user route + widened spec read gate touch,
// and answers the SQL shapes they issue.
function makeMockPool(initial = {}) {
  const state = {
    // Map<id, { id, user_id, app_id }>
    sessions: new Map(initial.sessions || []),
    // [{ session_id, version, content, shared_to_group_at }]
    specs: (initial.specs || []).slice(),
    // [{ id, username }]
    users: (initial.users || []).slice(),
    // [{ user_id, username }] — mirrors `username_history` (#1336).
    retired: (initial.retired || []).slice(),
    // Map<appId, { collab_visibility }>
    apps: new Map(initial.apps || []),
    // [{ app_id, user_id, status }]
    collaborators: (initial.collaborators || []).slice(),
    // [{ session_id, version, recipient_id, shared_by }]
    shares: (initial.shares || []).slice(),
    notifications: (initial.notifications || []).slice(),
    nextId: 1000,
  };
  const calls = [];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    // share-user route: owner-scoped session lookup.
    if (/SELECT cs\.id, cs\.app_id\s+FROM chat_sessions cs\s+WHERE cs\.id = \$1 AND cs\.user_id = \$2/i.test(s)) {
      const row = state.sessions.get(Number(params[0]));
      if (!row || row.user_id !== params[1]) return { rows: [] };
      return { rows: [{ id: row.id, app_id: row.app_id }] };
    }
    // share-user route: spec version existence.
    if (/SELECT version FROM chat_session_specs\s+WHERE session_id = \$1 AND version = \$2/i.test(s)) {
      const spec = state.specs.find(
        (x) => x.session_id === Number(params[0]) && x.version === Number(params[1])
      );
      return { rows: spec ? [{ version: spec.version }] : [] };
    }
    // notifications.resolveUsers, which resolves through the retired-handle
    // ledger since #1336 — its query is usernames.resolveHandles, a UNION of
    // `users` and `username_history` projecting `{ id, username, declared }`.
    // Sharing to somebody by a handle they have since retired therefore
    // reaches them, and answers with the name they hold now.
    if (/AS declared/i.test(s)) {
      const names = params[0];
      const rows = [];
      for (const u of state.users) {
        if (names.includes(u.username.toLowerCase())) {
          rows.push({ id: u.id, username: u.username, declared: u.username.toLowerCase(), live: true });
        }
      }
      for (const h of state.retired) {
        if (!names.includes(h.username.toLowerCase())) continue;
        const u = state.users.find((x) => x.id === h.user_id);
        if (u) rows.push({ id: u.id, username: u.username, declared: h.username.toLowerCase(), live: false });
      }
      return { rows };
    }
    // filterToCollaborators: app visibility.
    if (/SELECT collab_visibility FROM apps WHERE id = \$1/i.test(s)) {
      const app = state.apps.get(Number(params[0]));
      return { rows: app ? [app] : [] };
    }
    // filterToCollaborators: membership.
    if (/SELECT user_id FROM app_collaborators/i.test(s)) {
      const [appId, userIds] = params;
      return {
        rows: state.collaborators.filter(
          (c) => c.app_id === appId && c.status === 'member' && userIds.includes(c.user_id)
        ).map((c) => ({ user_id: c.user_id })),
      };
    }
    // Share-row insert with ON CONFLICT DO NOTHING.
    if (/INSERT INTO chat_session_spec_user_shares/i.test(s)) {
      const [sessionId, version, recipientId, sharedBy] = params;
      const dup = state.shares.find(
        (x) => x.session_id === sessionId && x.version === version && x.recipient_id === recipientId
      );
      if (dup) return { rows: [], rowCount: 0 };
      state.shares.push({ session_id: sessionId, version, recipient_id: recipientId, shared_by: sharedBy });
      return { rows: [], rowCount: 1 };
    }
    // createSpecSharedNotification.
    if (/INSERT INTO notifications[\s\S]*'spec_shared'/i.test(s)) {
      const [userId, appId, sessionId, sourceUserId, detail] = params;
      const row = {
        id: state.nextId++, user_id: userId, app_id: appId, session_id: sessionId,
        source_user_id: sourceUserId, kind: 'spec_shared', detail, read_at: null,
        created_at: new Date().toISOString(),
      };
      state.notifications.push(row);
      return { rows: [row] };
    }
    // hydrateAndPush's single-row hydrate.
    if (/SELECT n\.id, n\.kind[\s\S]*FROM notifications n[\s\S]*WHERE n\.id = \$1/i.test(s)) {
      const n = state.notifications.find((x) => x.id === params[0]);
      if (!n) return { rows: [] };
      const su = state.users.find((u) => u.id === n.source_user_id);
      return {
        rows: [{
          ...n, app_slug: 'my-app', app_name: 'My App', message_content: null,
          thread_type: null, thread_ref: null,
          pr_title: 'Add a feature', pr_number: 7, headless_issue_number: null,
          branch_name: 'dev/alice-123', source_username: su ? su.username : null,
        }],
      };
    }
    // Widened spec read gate (GET /specs/:version).
    if (/FROM chat_session_specs s[\s\S]*JOIN chat_sessions cs[\s\S]*chat_session_spec_user_shares us/i.test(s)) {
      const [sessionId, version, userId] = params.map(Number);
      const cs = state.sessions.get(sessionId);
      const spec = state.specs.find(
        (x) => x.session_id === sessionId && x.version === version
      );
      if (!cs || !spec) return { rows: [] };
      const shared = state.shares.some(
        (x) => x.session_id === sessionId && x.version === version && x.recipient_id === userId
      );
      if (cs.user_id !== userId && !spec.shared_to_group_at && !shared) return { rows: [] };
      return {
        rows: [{
          version: spec.version, content: spec.content, built_at: null,
          commit_sha: null, pr_number: null, shared_to_group_at: spec.shared_to_group_at || null,
        }],
      };
    }
    return { rows: [], rowCount: 0 };
  }

  return {
    query, state, calls,
    issued: (re) => calls.some((c) => re.test(c.sql)),
  };
}

// Express harness with a per-request user shim.
async function startTestServer(loaded, user = { id: 1, username: 'alice' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = req.testUser || user; next(); });
  app.use(loaded.subject.sessionRoutes({ jwtSecret: 'test' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function baseState() {
  return {
    sessions: [[10, { id: 10, user_id: 1, app_id: 5 }]],
    specs: [{ session_id: 10, version: 3, content: '# My spec', shared_to_group_at: null }],
    users: [
      { id: 1, username: 'alice' },
      { id: 2, username: 'Bob' },
      { id: 3, username: 'carol' },
    ],
    apps: [[5, { collab_visibility: 'public' }]],
  };
}

// ── POST /share-user ────────────────────────────────────────────────────

test('owner shares to a valid user → share row + one spec_shared notification + WS push', async () => {
  const pool = makeMockPool(baseState());
  const loaded = loadSessions(pool);
  const srv = await startTestServer(loaded);
  try {
    // Case-insensitive resolve: 'bob' matches stored 'Bob'.
    const res = await fetch(`${srv.baseUrl}/api/sessions/10/specs/3/share-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.recipient.username, 'Bob');
    assert.equal(data.alreadyShared, undefined);

    assert.equal(pool.state.shares.length, 1);
    assert.deepEqual(pool.state.shares[0], {
      session_id: 10, version: 3, recipient_id: 2, shared_by: 1,
    });

    const rows = pool.state.notifications.filter((n) => n.kind === 'spec_shared');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, 2);
    assert.equal(rows[0].session_id, 10);
    assert.equal(rows[0].source_user_id, 1);
    assert.equal(rows[0].detail, '3');

    assert.equal(loaded.pushes.length, 1);
    assert.equal(loaded.pushes[0].userId, 2);
    assert.equal(loaded.pushes[0].payload.type, 'notification_new');
    assert.equal(loaded.pushes[0].payload.notification.kind, 'spec_shared');
    assert.equal(loaded.pushes[0].payload.notification.detail, '3');
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('repeat share → alreadyShared: true, no second notification or push', async () => {
  const pool = makeMockPool(baseState());
  const loaded = loadSessions(pool);
  const srv = await startTestServer(loaded);
  try {
    const send = () => fetch(`${srv.baseUrl}/api/sessions/10/specs/3/share-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Bob' }),
    });
    let res = await send();
    assert.equal(res.status, 200);

    res = await send();
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.alreadyShared, true);

    assert.equal(pool.state.shares.length, 1);
    assert.equal(pool.state.notifications.filter((n) => n.kind === 'spec_shared').length, 1);
    assert.equal(loaded.pushes.length, 1);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('non-owner POST → 404, unknown username → 404, self-share → 400, bad version → 400', async () => {
  const pool = makeMockPool(baseState());
  const loaded = loadSessions(pool);
  const srv = await startTestServer(loaded, { id: 3, username: 'carol' });
  try {
    // carol does not own session 10.
    let res = await fetch(`${srv.baseUrl}/api/sessions/10/specs/3/share-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Bob' }),
    });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }

  const srv2 = await startTestServer(loaded, { id: 1, username: 'alice' });
  try {
    // Unknown recipient.
    let res = await fetch(`${srv2.baseUrl}/api/sessions/10/specs/3/share-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nosuchuser' }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'User not found');

    // Self-share.
    res = await fetch(`${srv2.baseUrl}/api/sessions/10/specs/3/share-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice' }),
    });
    assert.equal(res.status, 400);

    // Non-numeric version param.
    res = await fetch(`${srv2.baseUrl}/api/sessions/10/specs/abc/share-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Bob' }),
    });
    assert.equal(res.status, 400);

    // Missing spec version.
    res = await fetch(`${srv2.baseUrl}/api/sessions/10/specs/99/share-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Bob' }),
    });
    assert.equal(res.status, 404);

    assert.equal(pool.state.shares.length, 0);
    assert.equal(pool.state.notifications.length, 0);
    assert.equal(loaded.pushes.length, 0);
  } finally {
    await srv2.close();
    loaded.restore();
  }
});

test('collab-private app + non-member recipient → 400, no rows', async () => {
  const init = baseState();
  init.apps = [[5, { collab_visibility: 'private' }]];
  // carol is a member, Bob is not.
  init.collaborators = [{ app_id: 5, user_id: 3, status: 'member' }];
  const pool = makeMockPool(init);
  const loaded = loadSessions(pool);
  const srv = await startTestServer(loaded);
  try {
    let res = await fetch(`${srv.baseUrl}/api/sessions/10/specs/3/share-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Bob' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /doesn't have access/);
    assert.equal(pool.state.shares.length, 0);
    assert.equal(pool.state.notifications.length, 0);

    // A member recipient still works on the same private app.
    res = await fetch(`${srv.baseUrl}/api/sessions/10/specs/3/share-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'carol' }),
    });
    assert.equal(res.status, 200);
    assert.equal(pool.state.shares.length, 1);
    assert.equal(pool.state.shares[0].recipient_id, 3);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

// ── GET /specs/:version read gate ───────────────────────────────────────

test('recipient can GET the shared version; an unrelated third user still 404s', async () => {
  const init = baseState();
  init.shares = [{ session_id: 10, version: 3, recipient_id: 2, shared_by: 1 }];
  const pool = makeMockPool(init);
  const loaded = loadSessions(pool);

  // Recipient (Bob, id 2).
  const asBob = await startTestServer(loaded, { id: 2, username: 'Bob' });
  try {
    const res = await fetch(`${asBob.baseUrl}/api/sessions/10/specs/3`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.spec.version, 3);
    assert.equal(data.spec.content, '# My spec');
  } finally {
    await asBob.close();
  }

  // Unrelated third user (carol, id 3) — not owner, not shared, not group-shared.
  const asCarol = await startTestServer(loaded, { id: 3, username: 'carol' });
  try {
    const res = await fetch(`${asCarol.baseUrl}/api/sessions/10/specs/3`);
    assert.equal(res.status, 404);
  } finally {
    await asCarol.close();
  }

  // The share is version-scoped: Bob cannot read a DIFFERENT version.
  pool.state.specs.push({ session_id: 10, version: 4, content: '# v4', shared_to_group_at: null });
  const asBob2 = await startTestServer(loaded, { id: 2, username: 'Bob' });
  try {
    const res = await fetch(`${asBob2.baseUrl}/api/sessions/10/specs/4`);
    assert.equal(res.status, 404);
  } finally {
    await asBob2.close();
    loaded.restore();
  }
});
