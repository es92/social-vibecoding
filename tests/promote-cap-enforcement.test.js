// Enforcement test for the per-user PROMOTED (open-proposal) cap on
// POST /api/sessions/:id/promote (src/routes/votes.js).
//
// Promoted sessions are exempt from the active-session cap (#193 — they're
// un-pausable while their PR is in a vote), so this is the only bound on
// how many open-for-vote PRs one person can hold, each carrying a staging
// preview and vote-panel attention. What's pinned here:
//   1. The ceiling is per-REQUESTER: full platform admins get the raised
//      cap (8 by default), everyone else the base cap (5). Gating is on
//      canAdminWrite, so a view-only admin is refused at the base cap.
//   2. The 429 quotes the number actually enforced.
//   3. The check still runs BEFORE lazy PR creation — an over-cap promote
//      must not open a PR on GitHub it then refuses to put up for vote.
//
// Same require.cache + Router-recorder stubbing pattern as
// tests/promote-github-unavailable.test.js. Nothing real spins up.
//
// Run with: node --test tests/promote-cap-enforcement.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeGate } = require('../src/services/active-users');

const routes = new Map();
function makeRouterStub() {
  const router = {};
  for (const method of ['use', 'get', 'post', 'put', 'delete', 'patch']) {
    router[method] = (path, ...handlers) => {
      if (typeof path === 'string' && handlers.length) {
        routes.set(`${method.toUpperCase()} ${path}`, handlers[handlers.length - 1]);
      }
      return router;
    };
  }
  return router;
}

const Module = require('module');
Module._load = (function (orig) {
  return function (request, ...rest) {
    if (request === 'express') return { Router: makeRouterStub };
    return orig.call(this, request, ...rest);
  };
})(Module._load);

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// A session with NO PR yet, so a promote that gets past the cap would have
// to create one lazily — which is how the "cap checked first" assertion
// below can tell the two orderings apart.
function prLessSessionRow() {
  return {
    id: 7, app_id: 5, user_id: 3, status: 'active', is_headless: false,
    branch_name: 'dev/evan-1', pr_number: null, pr_title: null,
    app_slug: 'whiteboard', app_name: 'Whiteboard',
    repo_url: 'https://github.com/acme/whiteboard',
  };
}

// Loads routes/votes.js with everything stubbed. `promotedCount` is what
// the promoted-count query answers; `onApplyPrMetadata` records whether
// lazy PR creation was reached at all.
function loadPromote({ promotedCount, config, status = 'active' }) {
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
    stagingRecovery: require.resolve('../src/services/staging-recovery'),
    prMetadata: require.resolve('../src/services/pr-metadata'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const seen = { prCreated: false, countQueried: false };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      if (/FROM chat_sessions cs JOIN apps a/.test(s)) return { rows: [{ ...prLessSessionRow(), status }], rowCount: 1 };
      if (/SELECT COUNT\(\*\) AS cnt FROM chat_sessions/.test(s)) {
        seen.countQueried = true;
        return { rows: [{ cnt: String(promotedCount) }], rowCount: 1 };
      }
      if (/FROM chat_session_messages/.test(s)) return { rows: [{ content: 'add a thing' }], rowCount: 1 };
      return { rows: [], rowCount: 0, params };
    },
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.github, {
    isEnabled: () => false,
    describeGithubError: (err) => ({
      status: null, requestId: null, message: (err && err.message) || 'unknown error', data: null,
    }),
  });
  stub(ids.staging, {});
  stub(ids.docker, {});
  stub(ids.resolver, { checkAndResolveConflicts: async () => {}, isResolving: () => false });
  stub(ids.ws, {
    sendSystemMessage: async () => {}, pushNotificationToUser() {},
    pushVoteUpdate() {}, pushSessionUpdate() {},
  });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 1, majority: 1 }),
    isUserActive: async () => true,
    mergeGate,
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => false });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_PROMOTED: 'pr_promoted', PR_MERGED: 'pr_merged' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.stagingRecovery, {
    recheckSessionChecks: async () => 'rechecked',
    rebuildSessionStaging: async () => 'skipped',
    stagingNeedsRebuild: async () => false,
  });
  stub(ids.prMetadata, {
    applyPrMetadata: async () => {
      seen.prCreated = true;
      // Fail the lazy creation: past the cap we only care THAT it was
      // attempted, not that a whole promote succeeds under stubs.
      const err = new Error('stubbed: no GitHub in this test');
      err.code = 'no_commits';
      throw err;
    },
  });

  routes.clear();
  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  subject.voteRoutes(config || {});
  const promote = routes.get('POST /api/sessions/:id/promote');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { promote, seen, restore };
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const USER = { id: 3, username: 'evan' };
const FULL_ADMIN = { id: 3, username: 'evan', isAdmin: true, canAdminWrite: true };
const VIEW_ADMIN = { id: 3, username: 'dfk', isAdmin: true, canAdminWrite: false };

function reqFor(user) {
  return { params: { id: '7' }, user, body: {} };
}

async function promoteAs({ user, promotedCount, config, status }) {
  const ctx = loadPromote({ promotedCount, config, status });
  try {
    const res = makeRes();
    await ctx.promote(reqFor(user), res);
    return { status: res.statusCode, body: res.body, seen: ctx.seen };
  } finally {
    ctx.restore();
  }
}

test('regular user is refused at the base cap of 5, and the message quotes 5', async () => {
  const { status, body } = await promoteAs({ user: USER, promotedCount: 5 });
  assert.strictEqual(status, 429);
  assert.match(body.error, /already have 5 PRs up for vote/);
});

test('full admin is admitted past 5 — the cap check does not stop them there', async () => {
  const { status, body, seen } = await promoteAs({ user: FULL_ADMIN, promotedCount: 5 });
  assert.notStrictEqual(status, 429, 'not refused by the per-user cap');
  assert.ok(seen.prCreated, 'proceeded into lazy PR creation');
  // The stubbed lazy creation reports no commits — that's the next gate,
  // not the cap.
  assert.strictEqual(status, 409);
  assert.ok(body.error);
});

test('full admin is refused at the raised cap of 8, and the message quotes 8', async () => {
  const { status, body } = await promoteAs({ user: FULL_ADMIN, promotedCount: 8 });
  assert.strictEqual(status, 429);
  assert.match(body.error, /already have 8 PRs up for vote/);
});

test('view-only admin is refused at the base cap of 5 like a regular user', async () => {
  const { status, body } = await promoteAs({ user: VIEW_ADMIN, promotedCount: 5 });
  assert.strictEqual(status, 429);
  assert.match(body.error, /already have 5 PRs up for vote/);
});

test('a tuned promoted cap is enforced and quoted per tier', async () => {
  const config = { maxUserPromotedSessions: 2, maxAdminUserPromotedSessions: 4 };
  const user = await promoteAs({ user: USER, promotedCount: 2, config });
  assert.strictEqual(user.status, 429);
  assert.match(user.body.error, /already have 2 PRs up for vote/);

  const admin = await promoteAs({ user: FULL_ADMIN, promotedCount: 4, config });
  assert.strictEqual(admin.status, 429);
  assert.match(admin.body.error, /already have 4 PRs up for vote/);
});

// Ordering guard: an over-cap promote must not leave an orphan PR behind.
test('an over-cap promote never reaches lazy PR creation', async () => {
  const { status, seen } = await promoteAs({ user: USER, promotedCount: 5 });
  assert.strictEqual(status, 429);
  assert.ok(seen.countQueried, 'the cap was actually checked');
  assert.strictEqual(seen.prCreated, false, 'no PR was created on GitHub');
});

test('paused submission still enforces the promoted cap before touching GitHub', async () => {
  const { status, seen } = await promoteAs({ user: USER, promotedCount: 5, status: 'paused' });
  assert.equal(status, 429);
  assert.equal(seen.countQueried, true);
  assert.equal(seen.prCreated, false);
});
