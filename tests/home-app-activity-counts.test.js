// Route test for the home-card activity counts on GET /api/apps
// (src/routes/apps.js, issue #57): open_prs (PRs awaiting community
// votes), active_sessions (dev sessions in flight) and open_issues.
// The counts feed the home screen's activity chips, so two contracts
// matter: the response carries them as integers (defaulting to 0 when
// the aggregate joins yield nothing), and the SQL filters on exactly
// the status values the chips are documented to mean — a future status
// rename must fail this test loudly rather than silently zeroing a
// prominent surface.
//
// Same harness shape as tests/me-active-sessions.test.js: override
// getPool BEFORE requiring the route module (apps.js destructures it
// at require time), mount the router on a real express app, inject
// req.user, and capture every issued query so the WHERE/FILTER clauses
// can be asserted directly.
//
// Run with: node --test tests/home-app-activity-counts.test.js

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

const { appRoutes } = require('../src/routes/apps');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

function startServer() {
  const app = express();
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(appRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

// Minimal app row as the batched listing query would return it.
// status 'error' keeps the per-row enrichment path quiet (no URL
// resolution, no secrets lookup); counts come back from postgres as
// strings because COUNT(*) is bigint.
function appRow(overrides = {}) {
  return {
    id: 1,
    slug: 'demo',
    name: 'Demo App',
    status: 'error',
    self_hosted: false,
    manifest_snapshot: null,
    repo_url: null,
    main_sha: null,
    main_pr_number: null,
    created_by: 7,
    created_at: '2026-06-01T00:00:00Z',
    last_deploy_at: null,
    collab_visibility: 'public',
    view_visibility: 'public',
    is_collaborator: false,
    is_favorited: false,
    favorite_order: null,
    active_users: '0',
    message_count: '0',
    total_seconds: '0',
    ...overrides,
  };
}

async function fetchApps(server, { query = '', headers = {} } = {}) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/apps${query}`, { headers });
  return { res, body: await res.json() };
}

test('activity counts are surfaced as integers on each app', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({
    rows: [appRow({ open_prs: '2', active_sessions: '1', open_issues: '3' })],
  });
  const server = await startServer();
  try {
    const { res, body } = await fetchApps(server);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.apps.length, 1);
    assert.strictEqual(body.apps[0].open_prs, 2);
    assert.strictEqual(body.apps[0].active_sessions, 1);
    assert.strictEqual(body.apps[0].open_issues, 3);
  } finally {
    server.close();
  }
});

test('counts default to 0 when the aggregate joins yield no rows', async () => {
  capturedQueries = [];
  // No count fields at all — simulates an app with zero chat_sessions
  // and zero issues rows (the COALESCE lives in SQL; this also covers
  // any path that drops the fields entirely).
  poolQueryHandler = async () => ({ rows: [appRow()] });
  const server = await startServer();
  try {
    const { res, body } = await fetchApps(server);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.apps[0].open_prs, 0);
    assert.strictEqual(body.apps[0].active_sessions, 0);
    assert.strictEqual(body.apps[0].open_issues, 0);
  } finally {
    server.close();
  }
});

test('SQL filters on the documented status values', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer();
  try {
    const { res } = await fetchApps(server);
    assert.strictEqual(res.status, 200);

    const q = capturedQueries.find((c) => /FROM apps a/.test(c.sql));
    assert.ok(q, 'app listing query was issued');

    // "to vote" = promoted/merging — the same definition the admin
    // dashboard uses; "in dev" = active only (paused/archived/merged
    // excluded); issues chip counts open issues only.
    assert.match(q.sql, /COUNT\(\*\) FILTER \(WHERE status IN \('promoted', 'merging'\)\) AS open_prs/);
    assert.match(q.sql, /COUNT\(\*\) FILTER \(WHERE status = 'active'\) AS active_sessions/);
    assert.match(q.sql, /FROM chat_sessions/);
    assert.match(q.sql, /COUNT\(\*\) AS open_issues/);
    assert.match(q.sql, /FROM issues\s+WHERE status = 'open'/);
  } finally {
    server.close();
  }
});
