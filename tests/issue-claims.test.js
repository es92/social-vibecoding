// Route tests for the manual "In progress" claims on GitHub issues:
//   POST   /api/apps/:slug/github-issues/:number/claim  (claim + self-assign)
//   DELETE /api/apps/:slug/github-issues/:number/claim  (clear own / admin)
//
// Claims are per-user (UNIQUE app_id, github_issue_number, user_id): many
// people can claim one issue concurrently, so POST never 409s — it always
// upserts the CALLER's own claim (create or renew). Only the claimer or a
// write-capable admin can clear a claim; expiry is a read-time filter
// exercised in tests/github-issues-route.test.js.
//
// Same harness shape as tests/github-issues-route.test.js: override the
// pool + ws collaborators BEFORE requiring the route module (issues.js
// destructures them at require time), mount on a real express app, and
// inject req.user per server.
//
// Run with: node --test tests/issue-claims.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql: String(sql), params });
    return poolQueryHandler(sql, params);
  },
});

// ws collaborators are destructured at require time by issues.js — stub
// them first so pushes/system messages are capturable instead of touching
// real sockets / the (mocked, empty) DB.
const ws = require('../src/services/ws');
const pushed = [];
const sysMsgs = [];
ws.pushIssueUpdate = (d) => pushed.push(d);
ws.sendSystemMessage = async (pool, appId, content, type, x, thread) => {
  sysMsgs.push({ content, thread });
};

const kudos = require('../src/routes/kudos');
kudos.countWeeklyAllowanceUsed = async () => 0;

const github = require('../src/services/github');
github.isEnabled = () => true;

const appAccess = require('../src/services/app-access');
appAccess.getAppForUser = async () => ({
  id: 1, slug: 'demo', repo_url: 'https://github.com/o/r',
});

const { issueRoutes } = require('../src/routes/issues');
const express = require('express');

const GH_ISSUES = [1, 2, 3].map((n) => ({
  number: n, title: `issue ${n}`, body: '', labels: [],
  updated_at: '2026-06-10T00:00:00Z',
  html_url: `https://github.com/o/r/issues/${n}`,
  user: { login: 'someone' },
}));

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('api.github.com')) {
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => GH_ISSUES,
    };
  }
  return realFetch(url, opts);
};

function startServer(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user || { id: 7, username: 'tester' };
    next();
  });
  app.use(issueRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function reset() {
  poolQueryHandler = async () => ({ rows: [] });
  capturedQueries = [];
  pushed.length = 0;
  sysMsgs.length = 0;
}

const claimUrl = (port, n) => `http://127.0.0.1:${port}/api/apps/demo/github-issues/${n}/claim`;

test('POST upserts the caller\'s own claim (create) and announces it in the thread', async () => {
  reset();
  poolQueryHandler = async (sql) => {
    if (/INSERT INTO issue_claims/.test(String(sql))) {
      return { rows: [{ claimed_at: '2026-06-12T00:00:00Z', created: true }] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(claimUrl(port, 2), { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.created, true);

    // The upsert targets the per-user key — that's what makes claims
    // concurrent (one row per user, never a cross-user conflict).
    const q = capturedQueries.find((c) => /INSERT INTO issue_claims/.test(c.sql));
    assert.ok(q, 'claim upsert was issued');
    assert.match(q.sql, /ON CONFLICT \(app_id, github_issue_number, user_id\)/);
    assert.match(q.sql, /DO UPDATE SET claimed_at = NOW\(\)/);
    assert.deepStrictEqual(q.params, [1, 2, 7]);

    // #1648: taking the work also casts/moves the caller's assignee vote to
    // their own username. This stays in Homeroom's topic metadata; it does
    // not mutate the GitHub issue.
    const assignment = capturedQueries.find((c) => /INSERT INTO topic_attribute_votes/.test(c.sql));
    assert.ok(assignment, 'claim also upserts the caller\'s assignee vote');
    assert.deepStrictEqual(assignment.params, [1, 'issue', 2, 'assignee', 'tester', 7]);

    // Fresh claim → on-the-record note in the issue's own thread + push.
    assert.strictEqual(sysMsgs.length, 1);
    assert.strictEqual(sysMsgs[0].content, 'tester claimed this issue');
    assert.deepStrictEqual(sysMsgs[0].thread, { type: 'issue', ref: 2 });
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].action, 'claimed');
    assert.strictEqual(pushed[0].issueNumber, 2);
  } finally {
    server.close();
  }
});

test('POST by a second user coexists — same upsert, no 409 path', async () => {
  reset();
  poolQueryHandler = async (sql) => {
    if (/INSERT INTO issue_claims/.test(String(sql))) {
      return { rows: [{ claimed_at: '2026-06-12T01:00:00Z', created: true }] };
    }
    return { rows: [] };
  };
  const server = await startServer({ id: 8, username: 'maya' });
  try {
    const port = server.address().port;
    const res = await realFetch(claimUrl(port, 2), { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const q = capturedQueries.find((c) => /INSERT INTO issue_claims/.test(c.sql));
    assert.deepStrictEqual(q.params, [1, 2, 8], 'second user writes their OWN row');
    const assignment = capturedQueries.find((c) => /INSERT INTO topic_attribute_votes/.test(c.sql));
    assert.deepStrictEqual(assignment.params, [1, 'issue', 2, 'assignee', 'maya', 8]);
  } finally {
    server.close();
  }
});

test('POST renewal (created=false) refreshes silently — no thread message', async () => {
  reset();
  poolQueryHandler = async (sql) => {
    if (/INSERT INTO issue_claims/.test(String(sql))) {
      return { rows: [{ claimed_at: '2026-06-12T02:00:00Z', created: false }] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(claimUrl(port, 2), { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.created, false);
    assert.strictEqual(sysMsgs.length, 0, 'renewals do not spam the thread');
    assert.strictEqual(pushed.length, 1, 'panels still refresh (fresh expiry clock)');
    const assignment = capturedQueries.find((c) => /INSERT INTO topic_attribute_votes/.test(c.sql));
    assert.ok(assignment, 'renewal repairs the caller\'s self-assignment');
    assert.deepStrictEqual(assignment.params, [1, 'issue', 2, 'assignee', 'tester', 7]);
  } finally {
    server.close();
  }
});

test('POST 404s for an issue that is not open on the repo', async () => {
  reset();
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(claimUrl(port, 999), { method: 'POST' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(capturedQueries.filter((c) => /issue_claims/.test(c.sql)).length, 0);
  } finally {
    server.close();
  }
});

test('POST 422s without positive GitHub confirmation', async () => {
  reset();
  const prev = github.isEnabled;
  github.isEnabled = () => false;
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(claimUrl(port, 2), { method: 'POST' });
    assert.strictEqual(res.status, 422);
  } finally {
    github.isEnabled = prev;
    server.close();
  }
});

test('DELETE with no body clears the caller\'s own claim', async () => {
  reset();
  poolQueryHandler = async (sql) => {
    if (/DELETE FROM issue_claims/.test(String(sql))) {
      return { rows: [{ user_id: 7 }] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(claimUrl(port, 2), { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.cleared, true);
    const q = capturedQueries.find((c) => /DELETE FROM issue_claims/.test(c.sql));
    assert.deepStrictEqual(q.params, [1, 2, 7]);
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].action, 'unclaimed');
    // #1112: the message names the claim, not the derived "in progress" state
    // the board no longer calls by that name.
    assert.strictEqual(sysMsgs[0].content, 'tester released their claim on this issue');
  } finally {
    server.close();
  }
});

test('DELETE with a foreign userId is 403 for a non-admin', async () => {
  reset();
  const server = await startServer({ id: 7, username: 'tester', canAdminWrite: false });
  try {
    const port = server.address().port;
    const res = await realFetch(claimUrl(port, 2), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 8 }),
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(capturedQueries.filter((c) => /DELETE FROM issue_claims/.test(c.sql)).length, 0);
    assert.strictEqual(pushed.length, 0);
  } finally {
    server.close();
  }
});

test('DELETE with a foreign userId is 403 for a READ-ONLY admin', async () => {
  reset();
  // auth middleware sets canAdminWrite = is_admin && !admin_readonly, so a
  // readonly admin arrives with the flag false — same deny as a non-admin.
  const server = await startServer({ id: 7, username: 'viewer-admin', canAdminWrite: false });
  try {
    const port = server.address().port;
    const res = await realFetch(claimUrl(port, 2), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 8 }),
    });
    assert.strictEqual(res.status, 403);
  } finally {
    server.close();
  }
});

test('DELETE with a foreign userId succeeds for a write-admin (per-claim clear)', async () => {
  reset();
  poolQueryHandler = async (sql) => {
    if (/DELETE FROM issue_claims/.test(String(sql))) {
      return { rows: [{ user_id: 8 }] };
    }
    return { rows: [] };
  };
  const server = await startServer({ id: 7, username: 'admin', canAdminWrite: true });
  try {
    const port = server.address().port;
    const res = await realFetch(claimUrl(port, 2), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 8 }),
    });
    assert.strictEqual(res.status, 200);
    const q = capturedQueries.find((c) => /DELETE FROM issue_claims/.test(c.sql));
    assert.deepStrictEqual(q.params, [1, 2, 8], 'clears the TARGET user\'s claim');
    assert.strictEqual(sysMsgs[0].content, 'admin released someone else\'s claim on this issue');
  } finally {
    server.close();
  }
});

test('DELETE with your OWN userId in the body is allowed without admin', async () => {
  reset();
  poolQueryHandler = async (sql) => {
    if (/DELETE FROM issue_claims/.test(String(sql))) {
      return { rows: [{ user_id: 7 }] };
    }
    return { rows: [] };
  };
  const server = await startServer({ id: 7, username: 'tester', canAdminWrite: false });
  try {
    const port = server.address().port;
    const res = await realFetch(claimUrl(port, 2), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 7 }),
    });
    assert.strictEqual(res.status, 200);
  } finally {
    server.close();
  }
});

test('DELETE of a nonexistent claim is an idempotent soft 200 (no push, no message)', async () => {
  reset();
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(claimUrl(port, 2), { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.cleared, false);
    assert.strictEqual(pushed.length, 0);
    assert.strictEqual(sysMsgs.length, 0);
  } finally {
    server.close();
  }
});

test('claim routes 404 when the app is not accessible to the viewer', async () => {
  reset();
  const prev = appAccess.getAppForUser;
  appAccess.getAppForUser = async () => null;
  const server = await startServer();
  try {
    const port = server.address().port;
    assert.strictEqual((await realFetch(claimUrl(port, 2), { method: 'POST' })).status, 404);
    assert.strictEqual((await realFetch(claimUrl(port, 2), { method: 'DELETE' })).status, 404);
  } finally {
    appAccess.getAppForUser = prev;
    server.close();
  }
});
