// Route test for GET /api/me/session-state (src/routes/sessions.js) — the
// reconcile snapshot behind #1038's live `session_state` events.
//
// This endpoint is the correctness backstop for the whole feature: every
// "we might have missed a push" path on the client (WS reconnect, a tab
// returning to the foreground, the adaptive tick) funnels through it, and
// the client REPLACES its override set from the response. So the two things
// that must hold are (a) it reports only genuinely non-idle sessions —
// anything it wrongly omits clears a real spinner, anything it wrongly
// includes strands a phantom one — and (b) it never leaks another user's
// private session.
//
// Same harness shape as tests/me-active-sessions.test.js: override getPool
// BEFORE requiring the route module (sessions.js destructures it at require
// time), mount the router on a real express app, and inject req.user.
//
// Run with: node --test tests/me-session-state-route.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql, params });
    return poolQueryHandler(sql, params);
  },
});

const appAccess = require('../src/services/app-access');
const { activeWorkers } = require('../src/services/active-workers');

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

function startServer({ viewer = VIEWER, config = {} } = {}) {
  const app = express();
  app.use((req, res, next) => { req.user = viewer; next(); });
  app.use(sessionRoutes(config));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function get(server, path) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
  return { status: res.status, body: await res.json() };
}

function sessionRow(over = {}) {
  return {
    id: 1,
    status: 'active',
    is_headless: false,
    headless_status: null,
    headless_outcome: null,
    headless_issue_number: null,
    shared: false,
    app_id: 3,
    user_id: VIEWER.id,
    app_slug: 'demo-app',
    ...over,
  };
}

// The route runs two distinct queries: the viewer's own rows, then (only
// with ?app=) that app's shared + headless rows. Route by the WHERE clause.
function routeQueries({ mine = [], appRows = [] } = {}) {
  poolQueryHandler = async (sql) => {
    if (sql.includes('cs.user_id = $1')) return { rows: mine };
    if (sql.includes('cs.app_id = $1')) return { rows: appRows };
    return { rows: [] };
  };
}

test.beforeEach(() => {
  capturedQueries = [];
  poolQueryHandler = async () => ({ rows: [] });
  activeWorkers.clear();
});

test('reports only non-idle sessions — an idle row is simply absent', async () => {
  routeQueries({ mine: [sessionRow({ id: 11 }), sessionRow({ id: 12 })] });
  // Only 11 has a turn in flight.
  activeWorkers.add(11);

  const server = await startServer();
  try {
    const { status, body } = await get(server, '/api/me/session-state');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.sessions.map((s) => s.id), [11]);
    assert.strictEqual(body.sessions[0].busy, true);
    assert.strictEqual(body.sessions[0].appSlug, 'demo-app');
  } finally {
    activeWorkers.delete(11);
    server.close();
  }
});

test('carries a bootId so a client can detect a platform restart', async () => {
  routeQueries({ mine: [] });
  const server = await startServer();
  try {
    const { body } = await get(server, '/api/me/session-state');
    assert.ok(body.bootId, 'bootId identifies this platform process');
    assert.strictEqual(typeof body.bootId, 'string');
    assert.ok(typeof body.at === 'number');
    assert.deepStrictEqual(body.sessions, []);
  } finally {
    server.close();
  }
});

test('the bootId is stable across requests within one process', async () => {
  routeQueries({ mine: [] });
  const server = await startServer();
  try {
    const a = await get(server, '/api/me/session-state');
    const b = await get(server, '/api/me/session-state');
    assert.strictEqual(a.body.bootId, b.body.bootId,
      'a changing bootId would make every client clear its state on every tick');
  } finally {
    server.close();
  }
});

test('own-session query is scoped to the viewer and excludes archived rows', async () => {
  routeQueries({ mine: [] });
  const server = await startServer();
  try {
    await get(server, '/api/me/session-state');
    const mineQ = capturedQueries.find((q) => q.sql.includes('cs.user_id = $1'));
    assert.ok(mineQ, 'the viewer-scoped query ran');
    assert.deepStrictEqual(mineQ.params, [VIEWER.id]);
    assert.ok(mineQ.sql.includes("IN ('active', 'promoted', 'paused')"),
      'archived sessions can never be working');
  } finally {
    server.close();
  }
});

test('without ?app the shared-session query never runs', async () => {
  routeQueries({ mine: [] });
  const server = await startServer();
  try {
    await get(server, '/api/me/session-state');
    assert.ok(!capturedQueries.some((q) => q.sql.includes('cs.app_id = $1')),
      'no app scope requested, so no other-user rows are read at all');
  } finally {
    server.close();
  }
});

test('?app is gated on view access — a denied app contributes nothing', async () => {
  routeQueries({
    mine: [],
    appRows: [sessionRow({ id: 21, user_id: 999, shared: true })],
  });
  activeWorkers.add(21);

  const orig = appAccess.getAppForUser;
  appAccess.getAppForUser = async () => null; // denied / unknown slug
  const server = await startServer();
  try {
    const { body } = await get(server, '/api/me/session-state?app=secret-app');
    assert.deepStrictEqual(body.sessions, [],
      "another app's sessions must not leak through the app param");
    assert.ok(!capturedQueries.some((q) => q.sql.includes('cs.app_id = $1')),
      'the gate short-circuits before the query');
  } finally {
    appAccess.getAppForUser = orig;
    activeWorkers.delete(21);
    server.close();
  }
});

test('?app includes another user\'s SHARED busy session once view access passes', async () => {
  routeQueries({
    mine: [],
    appRows: [sessionRow({ id: 22, user_id: 999, shared: true })],
  });
  activeWorkers.add(22);

  const orig = appAccess.getAppForUser;
  appAccess.getAppForUser = async () => ({ id: 3, slug: 'demo-app' });
  const server = await startServer();
  try {
    const { body } = await get(server, '/api/me/session-state?app=demo-app');
    assert.deepStrictEqual(body.sessions.map((s) => s.id), [22]);
    const appQ = capturedQueries.find((q) => q.sql.includes('cs.app_id = $1'));
    assert.ok(appQ.sql.includes('cs.shared_at IS NOT NULL OR cs.is_headless = TRUE'),
      'only explicitly-shared rows and group-visible auto-runs are eligible');
  } finally {
    appAccess.getAppForUser = orig;
    activeWorkers.delete(22);
    server.close();
  }
});

test('a generating auto-run is non-idle even with no worker in flight', async () => {
  // The auto-run's liveness lives in the row, not in any in-memory registry,
  // so this is the case that would silently drop out if the endpoint keyed
  // on `busy` alone — and every issue card's spinner would clear.
  routeQueries({
    mine: [],
    appRows: [sessionRow({
      id: 23, user_id: 999, is_headless: true,
      headless_status: 'generating', headless_issue_number: 900003,
    })],
  });

  const orig = appAccess.getAppForUser;
  appAccess.getAppForUser = async () => ({ id: 3, slug: 'demo-app' });
  const server = await startServer();
  try {
    const { body } = await get(server, '/api/me/session-state?app=demo-app');
    assert.deepStrictEqual(body.sessions.map((s) => s.id), [23]);
    assert.strictEqual(body.sessions[0].busy, false);
    assert.deepStrictEqual(body.sessions[0].headless, {
      status: 'generating', outcome: null, issueNumber: 900003,
    });
  } finally {
    appAccess.getAppForUser = orig;
    server.close();
  }
});

test('a finished auto-run is idle and drops out', async () => {
  routeQueries({
    mine: [],
    appRows: [sessionRow({
      id: 24, user_id: 999, is_headless: true,
      headless_status: 'ready', headless_outcome: 'spec', headless_issue_number: 900003,
    })],
  });
  const orig = appAccess.getAppForUser;
  appAccess.getAppForUser = async () => ({ id: 3, slug: 'demo-app' });
  const server = await startServer();
  try {
    const { body } = await get(server, '/api/me/session-state?app=demo-app');
    assert.deepStrictEqual(body.sessions, []);
  } finally {
    appAccess.getAppForUser = orig;
    server.close();
  }
});

test('a session appearing in both queries is reported once', async () => {
  const shared = sessionRow({ id: 25, shared: true });
  routeQueries({ mine: [shared], appRows: [shared] });
  activeWorkers.add(25);

  const orig = appAccess.getAppForUser;
  appAccess.getAppForUser = async () => ({ id: 3, slug: 'demo-app' });
  const server = await startServer();
  try {
    const { body } = await get(server, '/api/me/session-state?app=demo-app');
    assert.strictEqual(body.sessions.length, 1);
    assert.strictEqual(body.sessions[0].id, 25);
  } finally {
    appAccess.getAppForUser = orig;
    activeWorkers.delete(25);
    server.close();
  }
});

test('the payload is ids-plus-flags only — no titles or PR metadata', async () => {
  routeQueries({ mine: [sessionRow({ id: 26 })] });
  activeWorkers.add(26);
  const server = await startServer();
  try {
    const { body } = await get(server, '/api/me/session-state');
    assert.deepStrictEqual(
      Object.keys(body.sessions[0]).sort(),
      ['appSlug', 'busy', 'headless', 'id', 'phase', 'status', 'stopping']
    );
  } finally {
    activeWorkers.delete(26);
    server.close();
  }
});

test('?demo=1 is inert outside staging', async () => {
  routeQueries({ mine: [] });
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production';
  const server = await startServer();
  try {
    const { body } = await get(server, '/api/me/session-state?demo=1');
    assert.deepStrictEqual(body.sessions, [],
      'demo rows must never reach production');
  } finally {
    process.env.USERNODE_ENV = prev;
    server.close();
  }
});

test('?demo=1 in staging keeps the mock spinners alive through a reconcile', async () => {
  // Without these rows the very first reconcile in a ?demo=1 preview would
  // report every mock session idle and wipe the demo spinners off the board
  // — the sibling endpoints seed them, so this endpoint has to agree.
  routeQueries({ mine: [] });
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  const server = await startServer({ config: { selfAppSlug: 'usernode' } });
  try {
    const { body } = await get(server, '/api/me/session-state?demo=1');
    const ids = body.sessions.map((s) => s.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [990001, 990102, 990301]);
    assert.ok(body.sessions.every((s) => s.appSlug === 'usernode'));
    // The busy own-session card, the busy shared card, and the generating
    // auto-run on mock issue 900003.
    const headless = body.sessions.find((s) => s.headless);
    assert.strictEqual(headless.headless.status, 'generating');
    assert.strictEqual(headless.headless.issueNumber, 900003);
  } finally {
    process.env.USERNODE_ENV = prev;
    server.close();
  }
});

test('a database failure answers 500 rather than a misleading empty snapshot', async () => {
  // An empty snapshot means "everything is idle" to the client, which would
  // clear every real spinner. A 500 leaves the previous state in place.
  poolQueryHandler = async () => { throw new Error('db down'); };
  const server = await startServer();
  try {
    const { status } = await get(server, '/api/me/session-state');
    assert.strictEqual(status, 500);
  } finally {
    server.close();
  }
});
