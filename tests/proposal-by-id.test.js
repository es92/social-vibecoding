// GET /api/apps/:slug/proposals/:id — the single-proposal fetch-on-demand
// recovery path. The Completed list is keyset-paginated, so a merged
// proposal beyond the first cached page can't be resolved from client
// state; the FE (_fetchProposalById) calls this endpoint to load just that
// one row in the SAME merged-shaped form the list returns, instead of
// bouncing back to the dev forum. This suite drives the real route handler
// with a recording express Router and a stubbed pool, asserting:
//   • a found proposal is returned under { proposal } with its row fields;
//   • the query is collab-gated, filters by app_id + id, and accepts
//     promoted/merging/merged;
//   • an unknown id 404s;
//   • a non-collaborator (gate returns null) 404s;
//   • under IS_STAGING + ?demo=1 a mock id resolves from the generators,
//     and a non-demo unknown id still 404s.
//
// Same hermetic Module._load stubbing as merged-pagination.
//
// Run with: node --test tests/proposal-by-id.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function makeRecordingRouter(routes) {
  const record = (method) => (path, ...handlers) => {
    routes.push({ method, path, handler: handlers[handlers.length - 1] });
  };
  return { get: record('get'), post: record('post'), put: record('put'), delete: record('delete'), use() {} };
}

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// loadVotes wires the real votes route module against stubs. `row` is the
// merged-shaped row the by-id SELECT should return (null → not found in DB).
// `gateApp` is what appAccess.getAppForUser resolves to (null → no access).
// `staging` flips USERNODE_ENV to 'staging' before the module is required,
// so its module-load-time IS_STAGING const is true for the demo path.
function loadVotes({ row = null, gateApp = { id: 1, slug: 'demo' }, staging = false, db = null } = {}) {
  const routes = [];
  const ids = {
    express: 'express',
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
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) {
    if (k === 'express') continue;
    orig[k] = require.cache[id];
  }

  const captured = { calls: [] };

  const _origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'express') return { Router: () => makeRecordingRouter(routes) };
    return _origLoad.call(this, request, ...rest);
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, {
    getPool: () => ({
      async query(sql, params) {
        captured.calls.push({ sql, params });
        // Test-specific answers first (e.g. the governance queries the
        // #3669 enrichment issues); fall through to the defaults below.
        if (db) {
          const rows = db(sql, params);
          if (rows !== undefined) return { rows };
        }
        // The by-id merged SELECT — return the configured row (or none).
        if (/cs\.id = \$3/.test(sql) && /cs\.status IN/.test(sql)) {
          return { rows: row ? [row] : [] };
        }
        return { rows: [] };
      },
    }),
  });
  stub(ids.github, { isEnabled: () => false });
  stub(ids.staging, {});
  stub(ids.docker, {});
  stub(ids.resolver, { checkAndResolveConflicts: async () => {}, isResolving: () => false });
  stub(ids.ws, { broadcast() {}, getReactionsForMessages: async () => ({}) });
  // The #3669 enrichment calls the real gate math (mergeGate / atLeastGate /
  // oppositionWindowMs / requiredVotes); only the DB-reading electorate
  // functions are stubbed. The real module loads hermetically.
  stub(ids.activeUsers, {
    ...require('../src/services/active-users'),
    getActiveUserStats: async () => ({ active: 3, majority: 2 }),
    isUserActive: async () => true,
    listActiveUserIds: async () => [],
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.appAccess, {
    getAppForUser: async () => gateApp,
    sessionCollabGuard: () => (req, res, next) => next(),
    ACCESS_COLUMNS: '',
  });
  stub(ids.topicAttrs, {
    summarizeForTargets: async () => new Map(),
    summarizeForProposals: async () => new Map(),
    emptySummary: () => ({ priority: null, assignee: null }),
  });
  stub(ids.visuals, { shapeAgg: () => null });

  const prevEnv = process.env.USERNODE_ENV;
  if (staging) process.env.USERNODE_ENV = 'staging';
  else delete process.env.USERNODE_ENV;

  delete require.cache[ids.subject];
  const { voteRoutes } = require('../src/routes/votes');
  voteRoutes({});

  if (prevEnv === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = prevEnv;

  Module._load = _origLoad;
  delete require.cache[ids.subject];
  for (const [k, id] of Object.entries(ids)) {
    if (k === 'express') continue;
    if (orig[k]) require.cache[id] = orig[k];
    // No prior entry: leave the stub in place. The route handlers resolve
    // some collaborators lazily at request time (governance → active-users,
    // main-watch), after this function returns — removing the stub would
    // load the real module against this suite's stub pool.
  }

  return { routes, captured };
}

function findRoute(routes, method, path) {
  return routes.find((r) => r.method === method && r.path === path);
}

async function callById(routes, { slug = 'demo', id, query = {}, user = { id: 1 } }) {
  const route = findRoute(routes, 'get', '/api/apps/:slug/proposals/:id');
  assert.ok(route, 'proposals/:id route registered');
  let payload = null;
  let statusCode = 200;
  await route.handler(
    { params: { slug, id: String(id) }, user, query },
    { json(p) { payload = p; }, status(c) { statusCode = c; return { json(p) { payload = p; } }; } }
  );
  return { payload, statusCode };
}

test('returns the merged-shaped row under { proposal }', async () => {
  const row = { id: 4242, pr_number: 88, pr_title: 'A merged proposal', status: 'merged', chat_count: 3, kudos_count: 1 };
  const { routes, captured } = loadVotes({ row });
  const { payload, statusCode } = await callById(routes, { id: 4242 });
  assert.equal(statusCode, 200);
  assert.ok(payload.proposal, 'proposal present');
  assert.equal(payload.proposal.id, 4242);
  assert.equal(payload.proposal.pr_number, 88);
  assert.equal(payload.proposal.chat_count, 3);
  // priority/assignee chips attached (empty summary from the stub).
  assert.ok('priority' in payload.proposal && 'assignee' in payload.proposal, 'attrs attached');

  const q = captured.calls.find((c) => /cs\.id = \$3/.test(c.sql));
  assert.ok(q, 'by-id query issued');
  assert.match(q.sql, /cs\.app_id = \$1 AND cs\.id = \$3/, 'filters by app + id');
  assert.match(q.sql, /cs\.status IN \('promoted', 'merging', 'merged'\)/, 'accepts active + merged');
  assert.deepEqual(q.params, [1, 1, 4242], 'app_id, userId, id bound');
});

test('unknown id 404s', async () => {
  const { routes } = loadVotes({ row: null });
  const { payload, statusCode } = await callById(routes, { id: 999999 });
  assert.equal(statusCode, 404);
  assert.match(payload.error, /not found/i);
});

test('non-collaborator (gate returns null) 404s without querying', async () => {
  const { routes, captured } = loadVotes({ gateApp: null });
  const { statusCode } = await callById(routes, { id: 4242 });
  assert.equal(statusCode, 404);
  assert.ok(!captured.calls.some((c) => /cs\.id = \$3/.test(c.sql)), 'no row query past the gate');
});

test('non-numeric id 404s', async () => {
  const { routes } = loadVotes({ row: null });
  const { statusCode } = await callById(routes, { id: 'abc' });
  assert.equal(statusCode, 404);
});

test('IS_STAGING + ?demo=1 resolves a mock merged id not in the DB', async () => {
  // 9100024 is a mock Completed row that never reaches the first page —
  // exactly the bug case. With demo=1 the by-id endpoint resolves it from
  // stagingMockMerged() so the discussion view can open on demand.
  const { routes } = loadVotes({ row: null, staging: true });
  const { payload, statusCode } = await callById(routes, { id: 9100024, query: { demo: '1' } });
  assert.equal(statusCode, 200);
  assert.equal(payload.proposal.id, 9100024);
  assert.equal(payload.proposal.status, 'merged');
});

test('#4505: the existing staging merged sample has the same viewer owner in list and detail', async () => {
  const viewer = { id: 777, username: 'sample-member' };
  const { routes } = loadVotes({ row: null, staging: true });
  const detail = await callById(routes, { id: 9100000, query: { demo: '1' }, user: viewer });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.payload.proposal.user_id, viewer.id);
  assert.equal(detail.payload.proposal.username, viewer.username);
  assert.match(detail.payload.proposal.pr_title, /^\[Mock\]/);
  const route = findRoute(routes, 'get', '/api/apps/:slug/merged');
  let payload, statusCode = 200;
  await route.handler({ params: { slug: 'demo' }, user: viewer, query: { demo: '1' } }, {
    json(p) { payload = p; }, status(c) { statusCode = c; return this; },
  });
  assert.equal(statusCode, 200, JSON.stringify(payload));
  const sample = payload.merged.find((row) => row.id === 9100000);
  assert.equal(sample.user_id, detail.payload.proposal.user_id);
  assert.equal(sample.username, detail.payload.proposal.username);
  assert.equal(sample.deployment_state, 'pending');
  assert.equal(payload.merged.find((row) => row.id === 9100001).username, 'staging-tester');
  const incomplete = await callById(routes, { id: 9100000, query: { demo: '1' }, user: { id: 777 } });
  assert.equal(incomplete.payload.proposal.user_id, 0);
  assert.equal(incomplete.payload.proposal.username, 'staging-tester');
  const regular = await callById(routes, { id: 9100000, user: viewer });
  assert.equal(regular.statusCode, 404, 'normal staging does not fabricate the sample');
  const production = loadVotes({ row: null, staging: false });
  assert.equal((await callById(production.routes, { id: 9100000, query: { demo: '1' }, user: viewer })).statusCode, 404,
    'production never fabricates a viewer-owned sample');
});

test('IS_STAGING + ?demo=1 resolves a mock promoted id too', async () => {
  const { routes } = loadVotes({ row: null, staging: true });
  const { payload, statusCode } = await callById(routes, { id: 9000001, query: { demo: '1' } });
  assert.equal(statusCode, 200);
  assert.equal(payload.proposal.id, 9000001);
});

test('demo mock id without ?demo=1 still 404s', async () => {
  const { routes } = loadVotes({ row: null, staging: true });
  const { statusCode } = await callById(routes, { id: 9100024, query: {} });
  assert.equal(statusCode, 404);
});

test('the canonical change lookup includes underway rows behind an owner-or-shared gate', async () => {
  const { routes, captured } = loadVotes({ row: { id: 4242, status: 'active', user_id: 1, shared_at: null } });
  const { payload, statusCode } = await callById(routes, { id: 4242 });
  assert.equal(statusCode, 200);
  assert.equal(payload.proposal.status, 'active');
  const q = captured.calls.find((c) => /cs\.id = \$3/.test(c.sql));
  assert.match(q.sql, /cs\.status IN \('active', 'paused'\)\s+AND \(cs\.user_id = \$2 OR cs\.shared_at IS NOT NULL\)/);
  assert.deepEqual(q.params, [1, 1, 4242]);
  assert.match(q.sql, /cs\.shared_at/);
  assert.doesNotMatch(q.sql, /cs\.\*|cs\.spec_md|cc_session_id/);
});

test('?results=failing: the proposal page counts its passing checks; without it every result is sent', async () => {
  // The page's own read (topic-head.tsx readChangeDetail, AppView._readTopicRow)
  // asks for the short form, and the passing checks' fold reads the rest when
  // opened (tests/item-page-reads.test.js). On production a proposal's row was
  // 265 KB, 255 KB of it the names of checks that passed.
  const results = [
    ...Array.from({ length: 12 }, (_, i) => ({ name: `ok ${i}`, status: 'pass' })),
    { name: 'broken', status: 'fail' },
  ];
  const row = { id: 4242, pr_number: 88, status: 'promoted', test_results: results };
  const { routes } = loadVotes({ row });
  const short = await callById(routes, { id: 4242, query: { results: 'failing' } });
  assert.equal(short.statusCode, 200);
  assert.deepEqual(short.payload.proposal.test_results.map((r) => r.name), ['broken']);
  assert.equal(short.payload.proposal.test_results_omitted, 12);
  assert.equal(short.payload.proposal.pr_number, 88, 'the rest of the row is untouched');

  const { routes: again } = loadVotes({ row: { ...row, test_results: results } });
  const whole = await callById(again, { id: 4242 });
  assert.equal(whole.payload.proposal.test_results.length, 13);
  assert.ok(!('test_results_omitted' in whole.payload.proposal));
});

test('#3669: a promoted row carries the governance fields the vote pill and ledger read', async () => {
  // AppView._refreshTopicLive refetches THIS endpoint after a vote and
  // merges the response key-wise into the held board row, so a response
  // without qualified_* / votes_required kept the pre-vote pill ("0 of 1
  // approval") standing until a full reload. The endpoint now enriches a
  // promoted row exactly as /promoted does — and the ledger's stale
  // pre-vote recording ("Votes waiting, 0 of 1") is reconciled against the
  // live tally, since a vote supersedes neither the epoch nor the head.
  const requirements = require('../src/services/merge-requirements');
  const governance = require('../src/services/governance');
  // A 1-approval invited-approver app, like the issue's reporter had.
  const preVote = requirements.trace().context({ locked: false, selfHosted: false });
  preVote.stop('approvals', 'waiting', { note: '0 of 1' });
  preVote.pass('integration').pass('checks');
  const row = {
    id: 4242, pr_number: 88, status: 'promoted', pr_title: 'A promoted change',
    approval_epoch: 1, requires_explicit_approval: false,
    promoted_at: '2026-10-01T00:00:00Z',
    merge_requirements: preVote.toRecord(),
    merge_requirements_at: '2026-10-01T00:00:00Z',
    created_at: '2026-10-01T00:00:00Z',
  };
  const { routes } = loadVotes({
    row,
    db: (sql) => {
      if (/approver_policy, approvals_required FROM apps/.test(sql)) {
        return [{ approver_policy: 'invited', approvals_required: 1 }];
      }
      if (/FROM app_approvers/.test(sql)) return [{ user_id: 7 }];
      // The approver's yes vote, counted live off pr_votes.
      if (/FROM pr_votes/.test(sql) && /user_id = ANY/.test(sql)) {
        return [{ yes: 1, no: 0 }];
      }
      return undefined;
    },
  });
  // governance caches per app for 10s in-process; earlier suites on this
  // app id must not answer this test's config query.
  governance.invalidateGovernance(1);
  const { payload, statusCode } = await callById(routes, { id: 4242 });
  assert.equal(statusCode, 200);
  const p = payload.proposal;
  assert.equal(p.votes_required, 1, 'the configured threshold');
  assert.equal(p.approval_policy, 'invited');
  assert.equal(p.approvals_required, 1);
  assert.equal(p.qualified_yes_count, 1, 'the approver vote counts, live');
  assert.equal(p.qualified_no_count, 0);

  // The ledger: the pre-vote recording is not superseded (same epoch, same
  // head) but its waiting approvals step loses to the live columns.
  assert.ok(p.mergeRequirements, 'ledger attached');
  assert.equal(p.mergeRequirements.provisional, false);
  const approvals = p.mergeRequirements.gates.find((g) => g.key === 'approvals');
  assert.equal(approvals.state, 'done', 'the vote has landed');
  assert.equal(approvals.detail && approvals.detail.note, '1 of 1');
});

// #4367: GET /api/apps/:slug/changes/:number turns a change's pull request
// number into the session its page opens by, under the same view gate and
// visibility rule as the by-id read above.
async function callChange(routes, { slug = 'demo', number, query = {}, user = { id: 1 } }) {
  const route = findRoute(routes, 'get', '/api/apps/:slug/changes/:number');
  assert.ok(route, 'changes/:number route registered');
  let payload = null;
  let statusCode = 200;
  await route.handler(
    { params: { slug, number: String(number) }, user, query },
    { json(p) { payload = p; }, status(c) { statusCode = c; return { json(p) { payload = p; } }; } }
  );
  return { payload, statusCode };
}

test('changes/:number resolves a PR number to its session, by app and visibility', async () => {
  const { routes, captured } = loadVotes({
    db: (sql) => (/cs\.pr_number = \$3/.test(sql) ? [{ id: 7296 }] : undefined),
  });
  const { payload, statusCode } = await callChange(routes, { number: 4509 });
  assert.equal(statusCode, 200);
  assert.deepEqual(payload, { sessionId: 7296, prNumber: 4509 });
  const q = captured.calls.find((c) => /cs\.pr_number = \$3/.test(c.sql));
  assert.match(q.sql, /cs\.app_id = \$1 AND cs\.pr_number = \$3/, 'by app and PR number, never by id');
  assert.match(q.sql, /cs\.status IN \('promoted', 'merging', 'merged'\)/);
  assert.match(q.sql, /cs\.user_id = \$2 OR cs\.shared_at IS NOT NULL/, 'a draft is its owner’s alone');
  assert.deepEqual(q.params, [1, 1, 4509]);
});

test('changes/:number 404s for an unknown number, a bad number, or no access', async () => {
  const none = loadVotes({ db: () => undefined });
  assert.equal((await callChange(none.routes, { number: 4509 })).statusCode, 404);
  for (const bad of ['abc', '0', '-3', '12x', '1e3']) {
    const r = loadVotes({ db: () => [{ id: 1 }] });
    assert.equal((await callChange(r.routes, { number: bad })).statusCode, 404, bad);
    assert.ok(!r.captured.calls.some((c) => /pr_number = \$3/.test(c.sql)), `${bad} is never looked up`);
  }
  const gated = loadVotes({ gateApp: null });
  assert.equal((await callChange(gated.routes, { number: 4509 })).statusCode, 404);
  assert.ok(!gated.captured.calls.some((c) => /pr_number = \$3/.test(c.sql)), 'no row query past the gate');
});

// #4309 follow-up: a merged change of the platform's own app that is not live
// yet carries when the next release does, for its page's "Merged; goes live
// in the next release (about 8 minutes)". A child app's does not.
test('a Homeroom merge not live yet carries its next release; a child app\'s, or a live one, does not', async () => {
  const releaseWatch = require('../src/services/release-watch');
  const MIN = 60 * 1000;
  const now = Date.now();
  const selfRow = { id: 1, main_sha: null, last_deploy_at: new Date(now - 3 * MIN), release_stall: null, release_run: null,
    newest_at: new Date(now - MIN) };
  const db = (sql) => (/FROM apps a\s+LEFT JOIN LATERAL/.test(sql) ? [selfRow] : undefined);
  const row = { id: 4242, status: 'merged', live_at: null, merged_at: new Date(now - MIN).toISOString(), pr_number: 88 };

  releaseWatch._forTest.resetOutlook();
  let loaded = loadVotes({ row, gateApp: { id: 1, slug: 'usernode-2d5619', self_hosted: true }, db });
  let { payload } = await callById(loaded.routes, { id: 4242 });
  assert.deepEqual(payload.proposal.release, { state: 'next', etaAt: new Date(now + 8 * MIN).toISOString() });

  releaseWatch._forTest.resetOutlook();
  loaded = loadVotes({ row, gateApp: { id: 2, slug: 'notes', self_hosted: false }, db });
  ({ payload } = await callById(loaded.routes, { id: 4242 }));
  assert.equal(payload.proposal.release, undefined, 'a child app\'s merge goes live with its own deploy');
  assert.ok(!loaded.captured.calls.some((c) => /FROM apps a\s+LEFT JOIN LATERAL/.test(c.sql)));

  releaseWatch._forTest.resetOutlook();
  loaded = loadVotes({ row: { ...row, live_at: new Date(now).toISOString() }, gateApp: { id: 1, slug: 'usernode-2d5619', self_hosted: true }, db });
  ({ payload } = await callById(loaded.routes, { id: 4242 }));
  assert.equal(payload.proposal.release, undefined, 'live');
});

test('?demo=1: the going-live mock reads the same on its page and in the Done column', async () => {
  const { routes } = loadVotes({ row: null, staging: true });
  const detail = await callById(routes, { id: 9100035, query: { demo: '1' } });
  assert.equal(detail.statusCode, 200);
  const p = detail.payload.proposal;
  assert.equal(p.status, 'merged');
  assert.equal(p.live_at, null);
  assert.equal(p.release.state, 'next');
  const minutes = Math.round((Date.parse(p.release.etaAt) - Date.now()) / 60000);
  assert.equal(minutes, 8, 'eight minutes off, the example the words were written from');
  const route = findRoute(routes, 'get', '/api/apps/:slug/merged');
  let payload;
  let statusCode = 200;
  await route.handler({ params: { slug: 'demo' }, user: { id: 1 }, query: { demo: '1' } }, {
    json(body) { payload = body; }, status(c) { statusCode = c; return this; },
  });
  assert.equal(statusCode, 200, JSON.stringify(payload));
  const mock = payload.merged.find((row) => row.id === 9100035);
  assert.equal(mock.deployment_state, 'deploying');
  assert.equal(mock.release.state, 'next');
  assert.equal(mock.live_at, null);
  assert.match(mock.pr_title, /^\[Mock\] Going-live test/);
});
