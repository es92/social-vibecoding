// Tests for the `bounty` flag on POST /api/feedback (#964) — the Send
// Feedback dialog's "Put a kudos bounty on this" checkbox.
//
// The governing rule this file exists to protect: THE ISSUE IS ALWAYS FILED.
// A bounty that can't be placed — allowance spent, repo isn't an app, the
// service throwing outright — must come back as 200 with a `url` and a
// `bounty.placed:false` explanation, never as a failed submission that loses
// what the user wrote.
//
// Same harness shape as tests/feedback-page-state.test.js: override getPool
// BEFORE requiring the route module, stub the GitHub calls, hit the router
// over HTTP.
//
// Run with: node --test tests/feedback-bounty.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── Pool stub ────────────────────────────────────────────────────────
// Records every INSERT into issue_bounties so the assertions can check the
// app_id / issue number / week_start actually written.
const poolMod = require('../src/db/pool');
let poolQueries = [];
let bountyRows = [];
let allowanceUsed = 0;
let appRowOverride = null;
let insertError = null;

poolMod.getPool = () => ({
  query: async (sql, params) => {
    const s = String(sql);
    poolQueries.push({ sql: s, params });
    // App lookup for app-targeted feedback. The route selects the access
    // columns alongside name/repo_url when a bounty was requested.
    if (/FROM apps WHERE slug = \$1/.test(s)) {
      return { rows: appRowOverride === null ? [DEFAULT_APP_ROW] : (appRowOverride ? [appRowOverride] : []) };
    }
    // findAppByRepo scans every app and matches on repo_url in JS, so the
    // stub returns the whole (two-row) fleet and lets it do the matching —
    // asserting that the platform submit picks the PLATFORM app, not just
    // whatever row came back first.
    if (/FROM apps\b/.test(s) && /repo_url/.test(s) && !/WHERE slug/.test(s)) {
      if (appRowOverride === false) return { rows: [] };
      return { rows: appRowOverride ? [appRowOverride] : [DEFAULT_APP_ROW, PLATFORM_APP_ROW] };
    }
    // Shared weekly allowance (pr_kudos + issue_bounties).
    if (/FROM issue_bounties\s+WHERE giver_user_id = \$1 AND week_start = \$2/i.test(s)) {
      return { rows: [{ c: String(allowanceUsed) }] };
    }
    if (/INSERT INTO issue_bounties/i.test(s)) {
      if (insertError) {
        const err = new Error('bounty insert exploded');
        err.code = insertError;
        throw err;
      }
      bountyRows.push({
        app_id: params[0], github_issue_number: params[1],
        giver_user_id: params[2], week_start: params[3],
      });
      return { rows: [{ id: 900 + bountyRows.length, created_at: '2026-08-05T00:00:00.000Z' }] };
    }
    if (/SELECT COUNT\(\*\)::int AS c FROM issue_bounties/i.test(s)) {
      return { rows: [{ c: bountyRows.length }] };
    }
    return { rows: [] };
  },
});

// The app row both lookups resolve to. Carries appAccess.ACCESS_COLUMNS
// (collab_visibility / view_visibility / created_by / self_hosted) because
// checkAppAccess THROWS on a row whose access columns were projected away —
// the exact trap the route's conditional SELECT exists to avoid.
const DEFAULT_APP_ROW = {
  id: 3, slug: 'demo-app', name: 'Demo App',
  repo_url: 'https://github.com/owner/demo-app',
  created_by: 99, self_hosted: false,
  collab_visibility: 'public', view_visibility: 'public',
};

// The self-hosted platform app — the row a platform-targeted submit must
// resolve to by repo (on production this is slug `usernode-2d5619`).
const PLATFORM_APP_ROW = {
  id: 1, slug: 'usernode-self', name: 'Homeroom',
  repo_url: 'https://github.com/plat/repo',
  created_by: 1, self_hosted: true,
  collab_visibility: 'public', view_visibility: 'public',
};

// ── Service stubs ────────────────────────────────────────────────────
const llm = require('../src/services/llm');
llm.generateIssueTitle = async () => ({ title: 'Generated title', usage: undefined, model: 'claude-haiku-4-5' });

const github = require('../src/services/github');
github.isEnabled = () => true;
github.noteIssueCreated = () => {};
github.createIssue = async (owner, repo) => ({
  number: 9, html_url: `https://github.com/${owner}/${repo}/issues/9`,
});

// ws.js is required lazily inside placeBounty; stub it before the service
// loads so the chat posts and WS push are observable no-ops.
const wsPath = require.resolve('../src/services/ws');
let systemMessages = [];
require.cache[wsPath] = {
  exports: {
    sendSystemMessage: async (pool, appId, text, kind, extra, thread) => {
      systemMessages.push({ appId, text, thread: thread || null });
    },
    pushIssueUpdate: () => {},
    pushNotificationToUser: () => 0,
    pushKudosUpdate: () => {},
  },
  loaded: true, id: wsPath, filename: wsPath, paths: [],
};

const events = require('../src/services/events');
events.record = () => {};

// Platform-target feedback files via a raw fetch with the PAT.
process.env.GITHUB_BOT_TOKEN = 'test-pat';
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('api.github.com')) {
    return {
      ok: true,
      status: 201,
      json: async () => ({ number: 42, html_url: 'https://github.com/plat/repo/issues/42' }),
    };
  }
  return realFetch(url, opts);
};

const { feedbackRoutes } = require('../src/routes/feedback');
const { WEEKLY_KUDOS_LIMIT } = require('../src/services/bounties');
const { weekStartUtc } = require('../src/services/leaderboard-users');
const express = require('express');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/plat/repo' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function reset() {
  poolQueries = [];
  bountyRows = [];
  systemMessages = [];
  allowanceUsed = 0;
  appRowOverride = null;
  insertError = null;
}

async function post(server, body) {
  const port = server.address().port;
  const res = await realFetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, json: await res.json() };
}

// ── App-targeted submits ─────────────────────────────────────────────

test('bounty:true on an app submit writes one row for the created issue', async () => {
  reset();
  const server = await startServer();
  try {
    const { res, json } = await post(server, {
      description: 'The board scrolls sideways on my phone',
      target: 'app', appSlug: 'demo-app', bounty: true,
    });
    assert.equal(res.status, 200);
    assert.equal(json.url, 'https://github.com/owner/demo-app/issues/9');

    assert.equal(bountyRows.length, 1, 'exactly one pledge');
    assert.equal(bountyRows[0].app_id, 3, 'attached to the resolved app row');
    assert.equal(bountyRows[0].github_issue_number, 9, "…and to the issue just filed");
    assert.equal(bountyRows[0].giver_user_id, 7);
    assert.equal(bountyRows[0].week_start, weekStartUtc(), 'in the current week bucket');

    assert.equal(json.bounty.placed, true);
    assert.equal(json.bounty.issueNumber, 9);
    assert.equal(json.bounty.limit, WEEKLY_KUDOS_LIMIT);
    assert.equal(json.bounty.remaining, WEEKLY_KUDOS_LIMIT - 1);

    // The pledge announces itself in chat + the issue thread, exactly as a
    // Dev-screen pledge does. (The feedback route posts no issue-created
    // message of its own, so there is nothing to de-duplicate against.)
    assert.equal(systemMessages.length, 2);
    assert.match(systemMessages[0].text, /tester placed a bounty \(kudos\) on issue #9/);
  } finally {
    server.close();
  }
});

test('the app lookup selects the access columns only when a bounty is wanted', async () => {
  reset();
  const server = await startServer();
  try {
    await post(server, { description: 'no pledge here', target: 'app', appSlug: 'demo-app' });
    const plain = poolQueries.find((q) => /FROM apps WHERE slug = \$1/.test(q.sql));
    assert.doesNotMatch(plain.sql, /collab_visibility/,
      'the plain path keeps its narrow projection');

    reset();
    await post(server, { description: 'with a pledge', target: 'app', appSlug: 'demo-app', bounty: true });
    const withAccess = poolQueries.find((q) => /FROM apps WHERE slug = \$1/.test(q.sql));
    // checkAppAccess throws without these, which would turn every bountied
    // submit into a "couldn't place the bounty just now".
    assert.match(withAccess.sql, /collab_visibility/);
    assert.match(withAccess.sql, /view_visibility/);
    assert.match(withAccess.sql, /repo_url/, 'and still selects what the issue body needs');
  } finally {
    server.close();
  }
});

// ── Platform-targeted submits ────────────────────────────────────────

test('bounty:true on a platform submit resolves the app by repo and pledges', async () => {
  reset();
  const server = await startServer();
  try {
    const { res, json } = await post(server, {
      description: 'The leaderboard subtitle is wrong',
      target: 'platform', bounty: true,
    });
    assert.equal(res.status, 200);
    assert.equal(json.url, 'https://github.com/plat/repo/issues/42');
    assert.equal(bountyRows.length, 1);
    assert.equal(bountyRows[0].app_id, 1, 'resolved to the platform app by repo, not by slug');
    assert.equal(bountyRows[0].github_issue_number, 42);
    assert.equal(json.bounty.placed, true);
  } finally {
    server.close();
  }
});

test("a repo that isn't an app files the issue and explains the missed bounty", async () => {
  reset();
  appRowOverride = false; // no apps row matches
  const server = await startServer();
  try {
    const { res, json } = await post(server, {
      description: 'filed on a deployment whose platform repo is not an app',
      target: 'platform', bounty: true,
    });
    assert.equal(res.status, 200, 'the issue still files');
    assert.equal(json.url, 'https://github.com/plat/repo/issues/42');
    assert.equal(bountyRows.length, 0);
    assert.equal(json.bounty.placed, false);
    assert.match(json.bounty.error, /isn't an app on this platform/);
  } finally {
    server.close();
  }
});

// ── Failure modes that must never cost the user their feedback ───────

test('an exhausted allowance still returns 200 with the issue url', async () => {
  reset();
  allowanceUsed = WEEKLY_KUDOS_LIMIT;
  const server = await startServer();
  try {
    const { res, json } = await post(server, {
      description: 'my allowance ran out while this dialog was open',
      target: 'app', appSlug: 'demo-app', bounty: true,
    });
    assert.equal(res.status, 200);
    assert.equal(json.url, 'https://github.com/owner/demo-app/issues/9');
    assert.equal(bountyRows.length, 0);
    assert.equal(json.bounty.placed, false);
    assert.match(json.bounty.error, /allowance is spent/);
    assert.equal(json.bounty.remaining, 0);
  } finally {
    server.close();
  }
});

test('a throwing placeBounty still returns 200 with the issue url', async () => {
  reset();
  insertError = '08006'; // a real DB failure, not a unique violation
  const server = await startServer();
  try {
    const { res, json } = await post(server, {
      description: 'the database fell over mid-pledge',
      target: 'app', appSlug: 'demo-app', bounty: true,
    });
    assert.equal(res.status, 200, 'the filed issue is never lost to a bounty failure');
    assert.equal(json.url, 'https://github.com/owner/demo-app/issues/9');
    assert.equal(json.bounty.placed, false);
    assert.match(json.bounty.error, /couldn't place the bounty/i);
  } finally {
    server.close();
  }
});

test('a collab-private app files the issue but refuses the pledge', async () => {
  reset();
  // Private to collaborators, and user 7 is neither creator nor collaborator.
  appRowOverride = { ...DEFAULT_APP_ROW, collab_visibility: 'private', view_visibility: 'private' };
  const server = await startServer();
  try {
    const { res, json } = await post(server, {
      description: 'outsider feedback on a private app',
      target: 'app', appSlug: 'demo-app', bounty: true,
    });
    // POST /api/feedback deliberately has no collab gate — only the bounty
    // does, so the submission survives and only the pledge is refused.
    assert.equal(res.status, 200);
    assert.equal(json.url, 'https://github.com/owner/demo-app/issues/9');
    assert.equal(bountyRows.length, 0);
    assert.equal(json.bounty.placed, false);
    assert.match(json.bounty.error, /collaborator access/);
  } finally {
    server.close();
  }
});

// ── Validation and the opt-out default ───────────────────────────────

test('a non-boolean bounty is a 400 and files nothing', async () => {
  reset();
  const server = await startServer();
  try {
    for (const bad of ['true', 1, {}]) {
      const { res, json } = await post(server, {
        description: 'malformed flag', target: 'app', appSlug: 'demo-app', bounty: bad,
      });
      assert.equal(res.status, 400, `bounty:${JSON.stringify(bad)} is rejected`);
      assert.equal(json.error, 'bounty must be a boolean');
      assert.equal(json.url, undefined, 'no issue was filed');
    }
    assert.equal(bountyRows.length, 0);
  } finally {
    server.close();
  }
});

test('omitting bounty pledges nothing and adds no bounty field', async () => {
  reset();
  const server = await startServer();
  try {
    const { res, json } = await post(server, {
      description: 'plain feedback, no pledge', target: 'app', appSlug: 'demo-app',
    });
    assert.equal(res.status, 200);
    assert.equal(json.url, 'https://github.com/owner/demo-app/issues/9');
    assert.equal(bountyRows.length, 0, 'filing feedback never spends the allowance by itself');
    assert.equal(json.bounty, undefined, 'the field is absent unless one was asked for');
    assert.equal(systemMessages.length, 0);
  } finally {
    server.close();
  }
});

test('bounty:false is accepted and behaves exactly like omitting it', async () => {
  reset();
  const server = await startServer();
  try {
    const { res, json } = await post(server, {
      description: 'explicitly declined', target: 'app', appSlug: 'demo-app', bounty: false,
    });
    assert.equal(res.status, 200);
    assert.equal(bountyRows.length, 0);
    assert.equal(json.bounty, undefined);
  } finally {
    server.close();
  }
});
