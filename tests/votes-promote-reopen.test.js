// POST /api/sessions/:id/promote must reconcile the PR's GitHub state
// before flipping the session to 'promoted'. A withdrawn (archived)
// session carries a CLOSED PR; promoting it without a reopen creates a
// proposal that can never merge (session 2398 / PR #26). Now:
//   - closed-unmerged PR → reopened, promote proceeds;
//   - reopen refused → 409 with an actionable error, session NOT promoted;
//   - already-merged PR → 409 (nothing left to vote on);
//   - open PR → its immutable head is captured and promotion proceeds;
//   - imported active PR → current head is captured without mutating GitHub;
//   - imported closed PR → refused without reopening someone else's PR;
//   - transient GET failure → promotion fails closed (nothing can be reviewed
//     or checked against an unknown revision).
//
// Drives the real Express router over HTTP with all collaborators stubbed
// via require.cache (same pattern as debug-route.test.js for the HTTP
// side, votes-checks-gate.test.js for the stub set).
//
// Run with: node --test tests/votes-promote-reopen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { mergeGate } = require('../src/services/active-users');
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function makeRecordingPool(handlers) {
  const queries = [];
  return {
    queries,
    issued(re) { return queries.some((q) => re.test(q.sql)); },
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      for (const [re, rows] of handlers) {
        if (re.test(String(sql))) {
          const out = typeof rows === 'function' ? rows(params) : rows;
          return Array.isArray(out) ? { rows: out, rowCount: out.length } : out;
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// One promotable session: active, owned by user 3, PR + title + staging
// already in place (so no lazy PR creation and no staging rebuild fires).
const sessionRow = {
  id: 7, app_id: 5, app_slug: 'widget', app_name: 'Widget',
  repo_url: 'https://github.com/acme/widget', branch_name: 'dev/x-1',
  pr_number: 26, pr_title: 'Native iOS look', pr_url: 'https://github.com/acme/widget/pull/26',
  staging_url: 'https://stage.example', user_id: 3, status: 'active',
  checks_commit_sha: HEAD,
};

function promotePool(session = sessionRow, { promotionMatches = true } = {}) {
  return makeRecordingPool([
    [/cs\.status IN \('active', 'paused'\)/, (params) =>
      ['active', 'paused'].includes(session.status) && session.user_id === params[1]
        && !session.is_headless ? [{ ...session }] : []],
    [/COUNT\(\*\) AS cnt FROM chat_sessions/i, [{ cnt: '0' }]],
    [/SET status = 'promoted', promoted_at = NOW\(\),[\s\S]*reviewed_head_sha/,
      (params) => {
        const matches = promotionMatches && params[2] === session.status;
        if (matches) session = { ...session, status: 'promoted' };
        return { rows: [], rowCount: matches ? 1 : 0 };
      }],
  ]);
}

function loadVotesRouter({ getPRImpl, reopenImpl, pool } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    docker: require.resolve('../src/services/docker'),
    resolver: require.resolve('../src/services/conflict-resolver'),
    ws: require.resolve('../src/services/ws'),
    activeUsers: require.resolve('../src/services/active-users'),
    notifications: require.resolve('../src/services/notifications'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    topicAttrs: require.resolve('../src/services/topic-attributes'),
    visuals: require.resolve('../src/services/visuals'),
    prImportSync: require.resolve('../src/services/pr-import-sync'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const getPRCalls = [];
  const reopenCalls = [];
  const systemMessages = [];
  const octokitRequests = [];
  const pendingCalls = [];
  const rerunCalls = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.github, {
    isEnabled: () => true,
    getPR: async (owner, repo, pr) => {
      getPRCalls.push({ owner, repo, pr });
      if (!getPRImpl) return { state: 'open', merged: false, head: { sha: HEAD } };
      return getPRImpl(owner, repo, pr);
    },
    reopenPR: async (owner, repo, pr) => {
      reopenCalls.push({ owner, repo, pr });
      if (reopenImpl) return reopenImpl(owner, repo, pr);
      return {};
    },
    // The ready-for-review PATCH goes through a bare installation client.
    getInstallationOctokit: async () => ({
      request: async (route, params) => {
        octokitRequests.push({ route, params });
        return { data: {} };
      },
    }),
  });
  stub(ids.staging, { rebuildProduction: async () => ({ ok: true }), teardownStaging: async () => {} });
  stub(ids.docker, {});
  stub(ids.resolver, {
    checkAndResolveConflicts: async () => {},
    resolveAndMaybeRetry: async () => ({ ok: true }),
    isResolving: () => false,
  });
  stub(ids.ws, {
    sendSystemMessage: async (_pool, _appId, content) => { systemMessages.push(content); },
    pushNotificationToUser() {},
    pushVoteUpdate() {},
    pushSessionUpdate() {},
  });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 1, majority: 1 }),
    isUserActive: async () => true,
    mergeGate,
  });
  stub(ids.notifications, {
    createPrProposedNotifications: async () => [],
    serialize: (x) => x,
  });
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_PROMOTED: 'pr_promoted', PR_MERGED: 'pr_merged' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.topicAttrs, {});
  stub(ids.visuals, {
    setChecksPending: async (_pool, sessionId, sha) => {
      pendingCalls.push({ sessionId, sha });
      return true;
    },
    notifyChecksPending() {},
  });
  stub(ids.prImportSync, {
    rerunChecksForNewHead: async (args) => { rerunCalls.push(args); },
  });

  delete require.cache[ids.subject];
  const { voteRoutes } = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return {
    voteRoutes, getPRCalls, reopenCalls, systemMessages, octokitRequests,
    pendingCalls, rerunCalls, restore,
  };
}

async function withServer({
  getPRImpl, reopenImpl, session, expectedHandoffHead, expectedHandoffStatus, promotionMatches,
} = {}, fn) {
  const pool = promotePool(session, { promotionMatches });
  const ctx = loadVotesRouter({ getPRImpl, reopenImpl, pool });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 3, username: 'evan' };
    if (expectedHandoffHead) req.cliHandoffCheckedHead = expectedHandoffHead;
    if (expectedHandoffStatus) req.cliHandoffStatus = expectedHandoffStatus;
    next();
  });
  app.use(ctx.voteRoutes({ jwtSecret: 's', maxUserPromotedSessions: 3 }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ ...ctx, pool, base });
  } finally {
    server.close();
    ctx.restore();
  }
}

test('paused promotion goes directly to review and duplicate submissions do not repeat it', async () => {
  await withServer({ session: { ...sessionRow, status: 'paused' } }, async ctx => {
    const response = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(response.status, 200);
    const update = ctx.pool.queries.find(q => /SET status = 'promoted'/.test(q.sql));
    assert.match(update.sql, /WHERE id = \$1 AND status = \$3/);
    assert.equal(update.params[2], 'paused');
    assert.equal(update.params[1], HEAD);
    assert.equal(ctx.pool.issued(/SET status = 'active'/), false);
    assert.equal(ctx.pool.issued(/COUNT[\s\S]+status = 'active'/), false);
    const duplicate = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(duplicate.status, 404);
    assert.equal(ctx.getPRCalls.length, 1);
    assert.equal(ctx.rerunCalls.length, 0);
  });
});

test('paused promotion preserves ownership, headless, and terminal status exclusions', async () => {
  for (const patch of [{ user_id: 99 }, { is_headless: true }, { status: 'archived' },
    { status: 'promoted' }, { status: 'merging' }, { status: 'merged' }]) {
    await withServer({ session: { ...sessionRow, status: 'paused', ...patch } }, async ctx => {
      const response = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
      assert.equal(response.status, 404);
      assert.equal(ctx.getPRCalls.length, 0);
      const lookup = ctx.pool.queries[0].sql;
      assert.match(lookup, /cs.user_id = \$2/);
      assert.match(lookup, /cs.is_headless = FALSE/);
    });
  }
});

test('a lifecycle change after native preflight requires a fresh submission', async () => {
  await withServer({ session: { ...sessionRow, source: 'cli_handoff', status: 'paused' },
    expectedHandoffHead: HEAD, expectedHandoffStatus: 'active' }, async ctx => {
    const response = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'session_state_changed');
    assert.equal(ctx.getPRCalls.length, 0);
  });
});

test('a concurrent lifecycle change prevents committing a paused submission', async () => {
  await withServer({ session: { ...sessionRow, status: 'paused' }, promotionMatches: false }, async ctx => {
    const response = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'session_state_changed');
    assert.equal(ctx.systemMessages.length, 0);
  });
});

test('promote: an open PR captures its head and promotes (no reopen call)', async () => {
  await withServer({ getPRImpl: async () => ({ state: 'open', merged: false, head: { sha: HEAD } }) }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.prNumber, 26);
    assert.equal(ctx.reopenCalls.length, 0);
    assert.ok(ctx.pool.issued(/SET status = 'promoted', promoted_at = NOW\(\),[\s\S]*reviewed_head_sha/),
      'session promoted with a reviewed head');
    const update = ctx.pool.queries.find((q) => /reviewed_head_sha/.test(q.sql));
    assert.equal(update.params[1], HEAD, 'live PR head persisted as the reviewed revision');
    assert.equal(ctx.octokitRequests.length, 1, 'a native draft is marked ready at promotion');
    assert.equal(ctx.octokitRequests[0].params.draft, false);
  });
});

test('promote: a CLI handoff refuses a PR head that moved after its ready preflight', async () => {
  const moved = 'c'.repeat(40);
  await withServer({
    session: { ...sessionRow, source: 'cli_handoff' },
    expectedHandoffHead: HEAD,
    getPRImpl: async () => ({ state: 'open', merged: false, head: { sha: moved } }),
  }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.error, 'branch_head_changed');
    assert.ok(!ctx.pool.issued(/SET status = 'promoted', promoted_at = NOW\(\)/),
      'the raced, unchecked PR revision never enters voting');
    const invalidation = ctx.pool.queries.find((q) => /SET check_state = 'error'/.test(q.sql));
    assert.ok(invalidation, 'the stale ready verdict is invalidated for status/UI callers');
    assert.deepEqual(invalidation.params.slice(1), [7, HEAD, 'active']);
  });
});

test('promote: a concurrent pause/archive cannot be overwritten by the final promotion write', async () => {
  await withServer({
    getPRImpl: async () => ({ state: 'open', merged: false, head: { sha: HEAD } }),
    promotionMatches: false,
  }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'session_state_changed' });
    assert.equal(ctx.systemMessages.length, 0,
      'a promotion that lost the active-state CAS emits no proposal announcement');
  });
});

test('promote: retained votes are limited to the newly reviewed revision', async () => {
  await withServer({
    session: { ...sessionRow, reviewed_head_sha: OLD_HEAD },
    getPRImpl: async () => ({ state: 'open', merged: false, head: { sha: HEAD } }),
  }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 200);
    const deletion = ctx.pool.queries.find((q) => /DELETE FROM pr_votes/.test(q.sql));
    assert.ok(deletion, 'stale or unbound votes are cleared on re-promotion');
    assert.match(deletion.sql, /head_sha IS DISTINCT FROM \$2/);
    assert.deepEqual(deletion.params, [sessionRow.id, HEAD]);
  });
});

test('promote: a closed-unmerged PR is reopened, then promoted', async () => {
  await withServer({ getPRImpl: async () => ({ state: 'closed', merged: false, head: { sha: HEAD } }) }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(ctx.reopenCalls, [{ owner: 'acme', repo: 'widget', pr: 26 }]);
    assert.ok(ctx.pool.issued(/SET status = 'promoted', promoted_at = NOW\(\),[\s\S]*reviewed_head_sha/), 'session promoted');
  });
});

test('promote: an active imported PR captures its head without publishing its draft', async () => {
  const imported = {
    ...sessionRow,
    source: 'imported',
    imported_pr_head_sha: OLD_HEAD,
    checks_commit_sha: HEAD,
  };
  await withServer({
    session: imported,
    getPRImpl: async () => ({ state: 'open', merged: false, head: { sha: HEAD } }),
  }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(ctx.reopenCalls.length, 0);
    const update = ctx.pool.queries.find((q) => /SET status = 'promoted'/.test(q.sql));
    assert.ok(update);
    assert.match(update.sql, /imported_pr_head_sha = CASE WHEN source = 'imported'/);
    assert.equal(update.params[1], HEAD, 'the live imported head is the reviewed revision');
    assert.equal(ctx.octokitRequests.length, 0,
      'local promotion must not change an externally owned PR on GitHub');
  });
});

test('promote: an imported head change is marked pending before voting opens', async () => {
  const imported = {
    ...sessionRow,
    source: 'imported',
    imported_pr_head_sha: OLD_HEAD,
    checks_commit_sha: OLD_HEAD,
  };
  await withServer({
    session: imported,
    getPRImpl: async () => ({ state: 'open', merged: false, head: { sha: HEAD } }),
  }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(ctx.pendingCalls, [{ sessionId: imported.id, sha: HEAD }],
      'the old green verdict is invalidated before the promote response');
    assert.equal(ctx.rerunCalls.length, 1);
    assert.equal(ctx.rerunCalls[0].newHead, HEAD);
  });
});

test('promote: a closed imported PR is refused without reopening it', async () => {
  await withServer({
    session: { ...sessionRow, source: 'imported', imported_pr_head_sha: OLD_HEAD },
    getPRImpl: async () => ({ state: 'closed', merged: false, head: { sha: HEAD } }),
  }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /closed on GitHub/i);
    assert.equal(ctx.reopenCalls.length, 0, 'the platform does not reopen an external PR');
    assert.ok(!ctx.pool.issued(/SET status = 'promoted'/));
  });
});

test('promote: a closed PR whose reopen is refused → 409, session NOT promoted', async () => {
  await withServer({
    getPRImpl: async () => ({ state: 'closed', merged: false, head: { sha: HEAD } }),
    reopenImpl: async () => { throw new Error('head branch was deleted'); },
  }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.match(body.error, /couldn't be reopened/i, 'error explains the reopen failure');
    assert.ok(!ctx.pool.issued(/SET status = 'promoted', promoted_at = NOW\(\)/),
      'a doomed proposal is never promoted');
  });
});

test('promote: an already-merged PR → 409 (nothing left to vote on)', async () => {
  await withServer({ getPRImpl: async () => ({ state: 'closed', merged: true }) }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.match(body.error, /already merged/i);
    assert.equal(ctx.reopenCalls.length, 0, 'a merged PR is never reopened');
    assert.ok(!ctx.pool.issued(/SET status = 'promoted', promoted_at = NOW\(\)/));
  });
});

test('promote: a transient PR-state GET failure fails closed before voting', async () => {
  await withServer({ getPRImpl: async () => { throw new Error('api hiccup'); } }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.match(body.error, /could not verify/i);
    assert.equal(ctx.reopenCalls.length, 0);
    assert.ok(!ctx.pool.issued(/SET status = 'promoted', promoted_at = NOW\(\)/),
      'an unverified revision never enters voting');
  });
});
