// Route test for GET /api/me/active-sessions (src/routes/sessions.js) —
// the cross-app "viewer's own sessions" endpoint. Long the data source
// for the dev tab's "Active Sessions (x/y)" panel, it now also backs the
// header cog's "Your sessions" drawer section, so its owner scoping,
// status filtering, busy detection, and totals arithmetic are
// load-bearing on a prominent surface.
//
// Same harness shape as tests/github-issues-route.test.js: override
// getPool BEFORE requiring the route module (sessions.js destructures it
// at require time), mount the router on a real express app, and inject
// req.user. The pool stub captures every query so tests can assert the
// SQL's owner/status/headless filters directly — the filtering lives in
// the WHERE clause, so the captured query text is the contract.
//
// Run with: node --test tests/me-active-sessions.test.js

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

const worker = require('../src/services/worker');
const workerProgress = require('../src/services/worker-progress');
const { activeWorkers } = require('../src/services/active-workers');

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

// `viewer` / `config` are overridable so the caps tests can mount the
// same router as a full admin, a view-only admin, and with a tuned
// config — the payload's `caps` field is per-requester.
function startServer({ viewer = VIEWER, config = {} } = {}) {
  const app = express();
  app.use((req, res, next) => { req.user = viewer; next(); });
  app.use(sessionRoutes(config));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function sessionRow(overrides = {}) {
  return {
    id: 1,
    user_id: VIEWER.id,
    branch_name: 'dev/tester-1',
    pr_number: null,
    pr_url: null,
    pr_title: null,
    status: 'active',
    linked_issues: [],
    created_at: '2026-06-12T00:00:00Z',
    last_activity_at: '2026-06-12T01:00:00Z',
    app_slug: 'demo',
    app_name: 'Demo App',
    agent_backend: 'claude_code',
    agent_model: null,
    ...overrides,
  };
}

// The active-sessions list is the chat_sessions query a request here makes.
// session-state's row lookup (`WHERE cs.id = $1`) reads the same table and
// runs on its own: a test that adds to activeWorkers schedules it 150 ms
// later (session-state.touch). Under CI load it landed after the next test
// had cleared capturedQueries, was found first, and failed that test's
// column assertions (main, 12 Oct 2026). The shared-sessions test below
// guards against the same thing.
const isActiveSessionsQuery = (c) => /FROM chat_sessions cs/.test(c.sql) && !/WHERE cs\.id = \$1\b/.test(c.sql);

async function fetchActiveSessions(server, { includeImported = false } = {}) {
  const port = server.address().port;
  const suffix = includeImported ? '?include_imported=1' : '';
  const res = await fetch(`http://127.0.0.1:${port}/api/me/active-sessions${suffix}`);
  return { res, body: await res.json() };
}

test('query is owner-scoped and excludes archived/headless rows', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer();
  try {
    const { res, body } = await fetchActiveSessions(server);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(body.sessions, []);

    const q = capturedQueries.find(isActiveSessionsQuery);
    assert.ok(q, 'active-sessions query was issued');
    // Owner scoping: the first filter param is the viewer's own id —
    // another user's rows can never satisfy the WHERE clause.
    assert.match(q.sql, /cs\.user_id = \$1/);
    assert.match(q.sql, /SELECT cs\.id, cs\.user_id,/, 'the rerun guard needs the actual owner on each row');
    assert.deepStrictEqual(q.params, [VIEWER.id, false]);
    // Status filtering: non-archived statuses only, headless excluded.
    assert.match(q.sql, /status IN \('active', 'promoted', 'paused'\)/);
    assert.match(q.sql, /is_headless = FALSE/);
    assert.match(q.sql, /\$2::boolean OR cs\.source IS DISTINCT FROM 'imported'/,
      'worker/session consumers exclude imported rows by default');
    assert.match(q.sql, /ORDER BY last_activity_at DESC/);
    // shared_at rides along so the owner's pinned cards can render their
    // "Visible to everyone" / "Make visible" state.
    assert.match(q.sql, /cs\.shared_at/);
    assert.match(q.sql, /cs\.check_state/);
    assert.match(q.sql, /cs\.check_phase/);
    assert.match(q.sql, /cs\.check_error_detail/);
    assert.match(q.sql, /cs\.agent_backend/);
    assert.match(q.sql, /cs\.agent_model/);
  } finally {
    server.close();
  }
});

test('the Dev board can opt imported active rows into the owner list', async () => {
  capturedQueries = [];
  const base = sessionRow({
    id: 44, source: 'imported', imported_pr_author: 'contributor', pr_number: 44,
  });
  poolQueryHandler = async (sql) => {
    if (/ORDER BY last_activity_at DESC/.test(sql)) return { rows: [base] };
    if (/WHERE cs\.id = ANY\(\$1::int\[\]\)/.test(sql)) {
      return { rows: [{
        ...base,
        app_id: 1,
        user_id: VIEWER.id,
        username: VIEWER.username,
        pr_url: 'https://github.example/pull/44',
        pr_summary_md: 'Adds full Underway details.',
        pr_body: '## What changed\n\nFull details.',
        testing_md: 'Open the Dev board.',
        testing_path: '/app/demo/dev',
        testing_paths: [{ path: '/app/demo/dev', viewport: 'desktop' }],
        check_state: 'failing',
        check_phase: null,
        check_trigger: 'pr-import',
        check_error_detail: null,
        test_results: [{ name: 'details', status: 'fail', failureReason: 'missing assignee' }],
        checks_checked_at: '2026-09-04T12:00:00Z',
        visuals_agg: null,
      }] };
    }
    if (/GROUP BY target_ref, field, norm/.test(sql)) {
      return { rows: [
        { ref: 44, field: 'priority', display_value: 'high', count: 2, first_at: '2026-09-04T10:00:00Z' },
        { ref: 44, field: 'assignee', display_value: 'tester', count: 1, first_at: '2026-09-04T10:01:00Z' },
        { ref: 44, field: 'category', display_value: 'bug', count: 1, first_at: '2026-09-04T10:02:00Z' },
      ] };
    }
    if (/FROM topic_attribute_votes/.test(sql) && /AND user_id = \$4/.test(sql)) {
      return { rows: [
        { ref: 44, field: 'assignee', value: 'tester' },
      ] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const { res, body } = await fetchActiveSessions(server, { includeImported: true });
    assert.strictEqual(res.status, 200);
    const imported = body.sessions[0];
    assert.strictEqual(imported.source, 'imported');
    assert.strictEqual(imported.pr_body, '## What changed\n\nFull details.');
    assert.strictEqual(imported.testing_md, 'Open the Dev board.');
    assert.strictEqual(imported.test_results[0].failureReason, 'missing assignee');
    assert.strictEqual(imported.priority.top, 'high');
    assert.strictEqual(imported.assignee.top, 'tester');
    assert.strictEqual(imported.assignee.myValue, 'tester');
    assert.strictEqual(imported.category.top, 'bug');
    const q = capturedQueries.find(isActiveSessionsQuery);
    assert.deepStrictEqual(q.params, [VIEWER.id, true]);
    assert.match(q.sql, /cs\.imported_pr_author/);
    assert.match(q.sql, /cs\.staging_url/);
    const detail = capturedQueries.find((c) => /WHERE cs\.id = ANY\(\$1::int\[\]\)/.test(c.sql));
    assert.ok(detail, 'imported proposal detail query was issued');
    assert.deepStrictEqual(detail.params, [[44], false]);
    assert.match(detail.sql, /cs\.source = 'imported'/);
    assert.match(detail.sql, /cs\.status IN \('active', 'paused'\)/);
    assert.match(detail.sql, /cs\.pr_summary_md/);
    assert.match(detail.sql, /cs\.pr_body/);
    assert.match(detail.sql, /cs\.testing_md/);
    assert.match(detail.sql, /cs\.test_results/);
    assert.match(detail.sql, /cs\.checks_checked_at/);
  } finally {
    server.close();
  }
});

test('response shape: row fields pass through, busy false without a warm worker', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({
    rows: [
      sessionRow({ id: 11, status: 'active', pr_title: 'Add leaderboard' }),
      sessionRow({ id: 12, status: 'promoted', app_slug: 'other', app_name: 'Other App', agent_backend: 'codex_openrouter', agent_model: 'openai/gpt-5.3-codex' }),
      sessionRow({ id: 13, status: 'paused' }),
    ],
  });
  activeWorkers.clear();
  const realIsInFlight = worker.isInFlight;
  worker.isInFlight = () => false;
  const server = await startServer();
  try {
    const { res, body } = await fetchActiveSessions(server);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.sessions.length, 3);
    for (const s of body.sessions) {
      assert.ok(s.app_slug, 'app_slug present');
      assert.ok(s.app_name, 'app_name present');
      assert.ok(s.last_activity_at, 'last_activity_at present');
      assert.strictEqual(s.busy, false);
    }
    assert.strictEqual(body.sessions[0].pr_title, 'Add leaderboard');
    assert.strictEqual(body.sessions[1].agent_backend, 'codex_openrouter');
    assert.strictEqual(body.sessions[1].agent_model, 'openai/gpt-5.3-codex');
    assert.equal(capturedQueries.some(
      (q) => /WHERE cs\.id = ANY\(\$1::int\[\]\)/.test(q.sql)), false,
      'ordinary dev sessions never enter the proposal-detail read');
  } finally {
    worker.isInFlight = realIsInFlight;
    server.close();
  }
});

test('busy flag: set via activeWorkers or worker.isInFlight; totals arithmetic consistent', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({
    rows: [
      sessionRow({ id: 21, status: 'active' }),   // busy via activeWorkers
      sessionRow({ id: 22, status: 'active' }),   // idle
      sessionRow({ id: 23, status: 'promoted' }), // busy via worker.isInFlight
      sessionRow({ id: 24, status: 'paused' }),
    ],
  });
  activeWorkers.clear();
  activeWorkers.add(21);
  const realIsInFlight = worker.isInFlight;
  worker.isInFlight = (id) => id === 23;
  const server = await startServer();
  try {
    const { body } = await fetchActiveSessions(server);
    const byId = Object.fromEntries(body.sessions.map((s) => [s.id, s]));
    assert.strictEqual(byId[21].busy, true);
    assert.strictEqual(byId[22].busy, false);
    assert.strictEqual(byId[23].busy, true);
    assert.strictEqual(byId[24].busy, false);

    // totals: active counts 'active'-status rows only; busy counts the
    // mid-turn subset; total covers every returned row.
    assert.deepStrictEqual(body.totals, {
      active: 2,
      promoted: 1,
      paused: 1,
      busy: 2,
      total: 4,
    });
  } finally {
    worker.isInFlight = realIsInFlight;
    activeWorkers.clear();
    server.close();
  }
});

test('busy runtime identity does not overwrite the session-pinned backend', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({
    rows: [sessionRow({
      id: 31,
      agent_backend: 'codex_openrouter',
      agent_model: 'openai/gpt-5.3-codex',
    })],
  });
  workerProgress.set(31, 'Editing locally', {
    backend: 'claude_code', model: null,
  });
  const server = await startServer();
  try {
    const { body } = await fetchActiveSessions(server);
    const session = body.sessions[0];
    assert.strictEqual(session.agent_backend, 'codex_openrouter', 'next platform turn stays pinned');
    assert.strictEqual(session.agent_model, 'openai/gpt-5.3-codex');
    assert.strictEqual(session.agentBackend, 'claude_code', 'busy tooltip names the actual local runtime');
    assert.strictEqual(session.agentModel, null);
  } finally {
    workerProgress.clear(31);
    server.close();
  }
});

// ── #1959: awaiting_input — the Improve panel's "Ready for your input" ──
//
// The panel's idle pill used to read "Ready" for every session; the feedback
// wanted "Ready for your input" — but only when true. The payload carried
// nothing that could tell a finished spec with open questions from one with
// nothing to ask, so the endpoint now ships the verdict as ONE boolean,
// computed here from what it already reads: the newest user/assistant row
// (whose turn is it, and did the assistant leave answer chips) and the spec
// body (does its Questions section still have content — the same parser the
// headless path refuses a build on). The inputs stay off the wire.
test('awaiting_input: the query reads the last conversational row and the spec body', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer();
  try {
    await fetchActiveSessions(server);
    const q = capturedQueries.find(isActiveSessionsQuery);
    assert.match(q.sql, /cs\.spec_md/);
    assert.match(q.sql, /lt\.role AS last_turn_role, lt\.asks AS last_turn_asks/);
    // The newest user/assistant row: system rows (scout cards, status lines)
    // are not turns and must not decide whose turn it is.
    assert.match(q.sql,
      /WHERE session_id = cs\.id AND role IN \('user', 'assistant'\)\s+ORDER BY id DESC\s+LIMIT 1/);
    // The same key, read the same way, as the clone path that forwards chips.
    assert.match(q.sql,
      /jsonb_array_length\(COALESCE\(metadata->'suggestions', '\[\]'::jsonb\)\) > 0 AS asks/);
  } finally {
    server.close();
  }
});

test('awaiting_input: true only when the assistant is the one waiting', async () => {
  const QUESTIONS = '# Goal\n\n## Questions\n\n1. Soft or hard delete?';
  const NOTHING_TO_ASK = '# Goal\n\n## Questions\n\nNone';
  poolQueryHandler = async () => ({
    rows: [
      // The assistant asked with answer chips, still up.
      sessionRow({ id: 41, last_turn_role: 'assistant', last_turn_asks: true }),
      // A finished spec whose Questions section is open, nothing built yet.
      sessionRow({ id: 42, last_turn_role: 'assistant', last_turn_asks: false, spec_md: QUESTIONS }),
      // A finished spec with nothing to ask.
      sessionRow({ id: 43, last_turn_role: 'assistant', last_turn_asks: false, spec_md: NOTHING_TO_ASK }),
      // Built despite the questions: a session with a PR is past its spec.
      sessionRow({ id: 44, last_turn_role: 'assistant', last_turn_asks: false, spec_md: QUESTIONS, pr_number: 44 }),
      // The owner replied: it is their turn that is pending, not a question.
      sessionRow({ id: 45, last_turn_role: 'user', last_turn_asks: true, spec_md: QUESTIONS }),
      // No conversation yet.
      sessionRow({ id: 46, last_turn_role: null, last_turn_asks: null, spec_md: QUESTIONS }),
    ],
  });
  activeWorkers.clear();
  const realIsInFlight = worker.isInFlight;
  worker.isInFlight = () => false;
  const server = await startServer();
  try {
    const { body } = await fetchActiveSessions(server);
    const byId = Object.fromEntries(body.sessions.map((s) => [s.id, s]));
    assert.strictEqual(byId[41].awaiting_input, true, 'answer chips up');
    assert.strictEqual(byId[42].awaiting_input, true, 'a spec with open questions');
    assert.strictEqual(byId[43].awaiting_input, false, 'a spec with nothing to ask');
    assert.strictEqual(byId[44].awaiting_input, false, 'a PR outranks the spec');
    assert.strictEqual(byId[45].awaiting_input, false, 'the owner has the floor');
    assert.strictEqual(byId[46].awaiting_input, false, 'nothing has been said');
    for (const s of body.sessions) {
      assert.strictEqual('spec_md' in s, false, 'the spec body never reaches a list payload (#894)');
      assert.strictEqual('last_turn_role' in s, false);
      assert.strictEqual('last_turn_asks' in s, false);
      assert.ok(s.app_slug && s.last_activity_at, 'everything else still passes through');
    }
  } finally {
    worker.isInFlight = realIsInFlight;
    server.close();
  }
});

// ── caps: the per-viewer "(N/M)" denominators ───────────────────────────
//
// The dev drawer used to hardcode "/3", which lied the moment an operator
// retuned MAX_USER_SESSIONS and could never express the raised admin caps.
// The server now ships the viewer's own effective ceilings, so display and
// enforcement can't drift. Gating is on canAdminWrite (NOT isAdmin) —
// view-only admins stay on the base caps.
test('caps: regular viewer gets the base 3/5 tier', async () => {
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer();
  try {
    const { body } = await fetchActiveSessions(server);
    assert.deepStrictEqual(body.caps, { activeSessions: 3, promotedSessions: 5 });
  } finally {
    server.close();
  }
});

test('caps: full platform admin gets the raised 5/8 tier', async () => {
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer({
    viewer: { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true },
  });
  try {
    const { body } = await fetchActiveSessions(server);
    assert.deepStrictEqual(body.caps, { activeSessions: 5, promotedSessions: 8 });
  } finally {
    server.close();
  }
});

test('caps: view-only admin stays on the base tier', async () => {
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer({
    viewer: { id: 2, username: 'viewadmin', isAdmin: true, canAdminWrite: false },
  });
  try {
    const { body } = await fetchActiveSessions(server);
    assert.deepStrictEqual(body.caps, { activeSessions: 3, promotedSessions: 5 });
  } finally {
    server.close();
  }
});

test('caps: a tuned config is reflected per tier', async () => {
  poolQueryHandler = async () => ({ rows: [] });
  const config = {
    maxUserSessions: 2, maxUserPromotedSessions: 4,
    maxAdminUserSessions: 9, maxAdminUserPromotedSessions: 10,
  };
  const asUser = await startServer({ config });
  try {
    const { body } = await fetchActiveSessions(asUser);
    assert.deepStrictEqual(body.caps, { activeSessions: 2, promotedSessions: 4 });
  } finally {
    asUser.close();
  }
  const asAdmin = await startServer({
    config, viewer: { id: 1, username: 'admin', canAdminWrite: true },
  });
  try {
    const { body } = await fetchActiveSessions(asAdmin);
    assert.deepStrictEqual(body.caps, { activeSessions: 9, promotedSessions: 10 });
  } finally {
    asAdmin.close();
  }
});

// Mounting with an empty config (what most route tests do) must still
// yield numbers — the client renders these directly, so `undefined` here
// would paint "(N/undefined)".
test('caps: never undefined even with an empty config, and totals still ride along', async () => {
  poolQueryHandler = async () => ({
    rows: [sessionRow({ id: 31, status: 'active' }), sessionRow({ id: 32, status: 'promoted' })],
  });
  const realIsInFlight = worker.isInFlight;
  worker.isInFlight = () => false;
  activeWorkers.clear();
  const server = await startServer();
  try {
    const { body } = await fetchActiveSessions(server);
    assert.ok(body.caps, 'caps present');
    assert.ok(Number.isInteger(body.caps.activeSessions) && body.caps.activeSessions > 0);
    assert.ok(Number.isInteger(body.caps.promotedSessions) && body.caps.promotedSessions > 0);
    assert.strictEqual(body.totals.active, 1);
    assert.strictEqual(body.totals.promoted, 1);
  } finally {
    worker.isInFlight = realIsInFlight;
    server.close();
  }
});

test('database failure surfaces as a 500, not a hang or leak', async () => {
  poolQueryHandler = async () => { throw new Error('boom'); };
  const server = await startServer();
  try {
    const { res, body } = await fetchActiveSessions(server);
    assert.strictEqual(res.status, 500);
    assert.ok(body.error);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

// ── shared-sessions: linked_issues rides along for the "#N" chips ────────
//
// The Dev board's shared-session cards render one "#N" chip per linked
// issue (reverse of the issue list's "In progress" chip), so the
// metadata-only /shared-sessions payload must include linked_issues.
// Issue numbers are group-visible data — the issue list itself is
// view-level — so this widens nothing sensitive.
// The shared-sessions list is the only query whose WHERE clause is
// `cs.app_id = $1 AND cs.shared_at IS NOT NULL`. That is what the predicate
// below matches — NOT the bare `shared_at IS NOT NULL`, which is also a
// projected column (`(cs.shared_at IS NOT NULL) AS shared`) in
// session-state.loadRow and the active-sessions list. Any background query
// that reaches the shared pool handler while this test runs (a sweeper on a
// timer, a websocket reconnect from the previous test's server) would take
// the canned row and this test would then find THAT query first and fail its
// column assertions. It did, on main, under CI load: a red main-watch verdict
// paused the platform's merges for an afternoon over it.
const SHARED_SESSIONS_SQL = /WHERE cs\.app_id = \$1 AND cs\.shared_at IS NOT NULL/;

test('shared-sessions returns linked_issues per row', async () => {
  const appAccess = require('../src/services/app-access');
  const prevGet = appAccess.getAppForUser;
  appAccess.getAppForUser = async () => ({ id: 1, slug: 'demo' });
  capturedQueries = [];
  poolQueryHandler = async (sql) => {
    if (SHARED_SESSIONS_SQL.test(String(sql))) {
      return {
        rows: [{
          id: 9, session_title: 'Shared work', pr_title: null,
          branch_name: 'dev/maya-1', status: 'active',
          staging_url: null, can_preview: false,
          linked_issues: [12, 34],
          user_id: 3, username: 'maya',
          shared_at: '2026-06-12T00:00:00Z', created_at: '2026-06-11T00:00:00Z',
          last_activity_at: '2026-06-12T00:00:00Z',
          chat_count: 0, last_message_at: null,
        }],
      };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/shared-sessions`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.sessions.length, 1);
    assert.deepStrictEqual(body.sessions[0].linked_issues, [12, 34]);

    const q = capturedQueries.find((c) => SHARED_SESSIONS_SQL.test(c.sql));
    assert.ok(q, 'shared-sessions query was issued');
    assert.match(q.sql, /cs\.linked_issues/);
    assert.match(q.sql, /cs\.source/);
    assert.match(q.sql, /cs\.imported_pr_author/);
    assert.match(q.sql, /cs\.check_state/);
    assert.match(q.sql, /cs\.check_phase/);
  } finally {
    appAccess.getAppForUser = prevGet;
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});
