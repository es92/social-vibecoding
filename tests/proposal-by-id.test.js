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

const { previewDisplayState } = require('../src/services/staging');

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
  // The real derivation: the by-id read answers with what /promoted does (#6140).
  stub(ids.staging, { previewDisplayState });
  stub(ids.docker, {});
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

// #6287: the page's Vote button asks "Still yes?" from the row it reads. The
// single-change read must carry the viewer's vote on an earlier version,
// exactly as the /promoted list already does; the "Your yes was on an earlier
// version" line comes from a different read, so without this the card knew
// about the earlier yes while its button offered a fresh "Vote".
test('#6287: the row carries the viewer\'s vote on an earlier version', async () => {
  const row = { id: 4242, pr_number: 88, status: 'promoted', my_vote: null, my_prior_vote: 'yes' };
  const { routes, captured } = loadVotes({ row });
  const { payload, statusCode } = await callById(routes, { id: 4242, user: { id: 7 } });
  assert.equal(statusCode, 200);
  assert.equal(payload.proposal.my_prior_vote, 'yes', 'the change page can ask "Still yes?"');
  assert.equal(payload.proposal.my_vote, null);
  const q = captured.calls.find((c) => /cs\.id = \$3/.test(c.sql));
  assert.ok(q, 'by-id query issued');
  assert.match(q.sql, /NOT COALESCE\(\(pv\.approval_epoch = cs\.approval_epoch\), FALSE\)\) as my_prior_vote/,
    'the earlier vote is outside the current epoch');
  assert.match(q.sql, /WHERE pv\.session_id = cs\.id AND pv\.user_id = \$2/,
    'read for the viewer bound at \$2');
  assert.deepEqual(q.params, [1, 7, 4242], 'app_id, userId, id bound');
});

// #6814: a change that alters nothing on screen falls back to "What it
// touches" where its page said "Nothing you can see changes". The page reads
// it from this route, which shows it only for the head it was read at, as the
// board rows do.
test('#6814: the page carries "What it touches" for the change\'s current head', async () => {
  const head = 'a'.repeat(40);
  const touches = { version: 1, files: 2, areas: [{ key: 'server', label: 'Server', files: 2, lines: 7 }] };
  const row = { id: 4242, pr_number: 88, status: 'promoted', reviewed_head_sha: head };
  const { routes, captured } = loadVotes({
    row,
    db: (sql) => (/SELECT pr_diagram, pr_diagram_source, pr_touches, pr_touches_sha/.test(sql)
      ? [{ pr_diagram: null, pr_diagram_source: null, pr_touches: touches, pr_touches_sha: head }] : undefined),
  });
  const { payload, statusCode } = await callById(routes, { id: 4242 });
  assert.equal(statusCode, 200);
  assert.deepEqual(payload.proposal.touches, touches, 'read for this head');
  const q = captured.calls.find((c) => /pr_diagram, pr_diagram_source, pr_touches, pr_touches_sha/.test(c.sql));
  assert.ok(q, 'the #4490 read selects the picture and the head it was read at');
  assert.ok(!('pr_touches' in payload.proposal) && !('pr_touches_sha' in payload.proposal),
    'the raw columns stay out of the row');
});

test('#6814: a moved head has no "What it touches", so the page keeps its box', async () => {
  const row = { id: 4242, pr_number: 88, status: 'promoted', reviewed_head_sha: 'a'.repeat(40) };
  const { routes } = loadVotes({
    row,
    db: (sql) => (/SELECT pr_diagram, pr_diagram_source, pr_touches, pr_touches_sha/.test(sql)
      ? [{
        pr_diagram: null, pr_diagram_source: null,
        pr_touches: { version: 1, files: 1, areas: [{ key: 'server', label: 'Server', files: 1, lines: 3 }] },
        pr_touches_sha: 'b'.repeat(40),
      }] : undefined),
  });
  const { payload } = await callById(routes, { id: 4242 });
  assert.equal(payload.proposal.touches, null, 'a picture read at another head is not shown');
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

test('#4524: IS_STAGING + ?demo=1 also resolves a mock session the board lists hold', async () => {
  // The topic page's fast open asks this endpoint for its item BESIDE the
  // board load, so the mock own session (990101, the session lists' own
  // response) and the mock shared session (990002) must resolve here too —
  // production's SQL serves those states, and a 404 in the network log is a
  // console error, which fails every declared check on the route.
  const { routes } = loadVotes({ row: null, staging: true });
  const own = await callById(routes, { id: 990101, query: { demo: '1' } });
  assert.equal(own.statusCode, 200);
  assert.equal(own.payload.proposal.id, 990101);
  assert.equal(own.payload.proposal.user_id, 1, 'the mock own session belongs to the viewer');
  const shared = await callById(routes, { id: 990002, query: { demo: '1' } });
  assert.equal(shared.statusCode, 200);
  assert.equal(shared.payload.proposal.id, 990002);
  assert.ok(shared.payload.proposal.shared_at, 'the mock shared session is shared');
  const production = loadVotes({ row: null, staging: false });
  assert.equal((await callById(production.routes, { id: 990002, query: { demo: '1' } })).statusCode, 404,
    'production never fabricates a mock session');
  assert.equal((await callById(routes, { id: 42, query: { demo: '1' } })).statusCode, 404,
    'an id no generator holds still 404s');
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

// #6140: a request's page draws a change from this read alone, so its Testing
// card's Try it comes from here (AppView._cardPreviewSpec).
const previewColumns = (over = {}) => (sql) => (/SELECT staging_url, testing_md, testing_path/.test(sql)
  ? [{ staging_url: null, testing_md: null, testing_path: null, can_preview: true, ...over }]
  : undefined);
const voteRow = (over = {}) => ({
  id: 4242, pr_number: 88, status: 'promoted', votes_required: 2, check_state: 'passing', ...over,
});

test('#6140: a promoted row carries its preview, what to test on it, and that it can be woken', async () => {
  const { routes, captured } = loadVotes({
    row: voteRow(),
    db: previewColumns({ staging_url: 'https://p.example', testing_md: 'Try the list', testing_path: '/list' }),
  });
  const { payload: { proposal } } = await callById(routes, { id: 4242 });
  assert.equal(proposal.staging_url, 'https://p.example');
  assert.equal(proposal.testing_md, 'Try the list');
  assert.equal(proposal.testing_path, '/list');
  assert.equal(proposal.can_preview, true);
  assert.equal(proposal.preview_state, 'ready');
  // The session lists' own derivation of whether a slept preview can be woken.
  const q = captured.calls.find((c) => /SELECT staging_url, testing_md, testing_path/.test(c.sql));
  assert.match(q.sql, /pr_number IS NOT NULL OR checks_commit_sha IS NOT NULL\s+OR shared_at IS NOT NULL/);
  assert.deepEqual(q.params, [4242]);
});

test('#6140: a preview that failed says so, one being built is not offered as a rebuild', async () => {
  const failed = await callById(loadVotes({
    row: voteRow({ check_state: 'error', check_error_detail: 'did not boot' }), db: previewColumns(),
  }).routes, { id: 4242 });
  assert.equal(failed.payload.proposal.preview_state, 'failed');
  assert.equal(failed.payload.proposal.staging_error, 'did not boot');

  const building = await callById(loadVotes({
    row: voteRow({ check_state: 'pending', check_phase: 'building' }), db: previewColumns(),
  }).routes, { id: 4242 });
  assert.equal(building.payload.proposal.staging_building, true);
  assert.equal(building.payload.proposal.can_preview, false, 'the spec would offer a rebuild ahead of "building"');

  const asleep = await callById(loadVotes({ row: voteRow(), db: previewColumns() }).routes, { id: 4242 });
  assert.equal(asleep.payload.proposal.staging_url, null, 'always written: the board merges this row key by key');
  assert.equal(asleep.payload.proposal.preview_state, 'unavailable');
  assert.equal(asleep.payload.proposal.can_preview, true);
});

test('#6140: a merged row, and an underway one, keep the shape they had', async () => {
  for (const status of ['merged', 'active']) {
    const { routes, captured } = loadVotes({ row: voteRow({ status }), db: previewColumns({ staging_url: 'https://p.example' }) });
    const { payload: { proposal } } = await callById(routes, { id: 4242 });
    assert.ok(!captured.calls.some((c) => /SELECT staging_url, testing_md/.test(c.sql)), status);
    for (const key of ['staging_url', 'can_preview', 'testing_md', 'preview_state', 'staging_error']) {
      assert.ok(!(key in proposal), `${status}: ${key}`);
    }
  }
});

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
  // Released 3 minutes ago, merged 1 minute ago: built in 4 more, live a minute after.
  assert.deepEqual(payload.proposal.release, { state: 'next', etaAt: new Date(now + 5 * MIN).toISOString() });

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

// #5064: opened on its own (from the bell or Home), a merge of Homeroom
// itself gets the board's deployment_state, so its page says going live
// until the running build carries it, even though the legacy merge stamped
// live_at at once.
test('#5064: a Homeroom merge the running build does not carry yet reads as deploying on its own page', async () => {
  const releaseWatch = require('../src/services/release-watch');
  const A_SHA = 'a'.repeat(40);
  const B_SHA = 'b'.repeat(40);
  const MIN = 60 * 1000;
  const now = Date.now();
  const merged = { id: 4242, status: 'merged', live_at: new Date(now - MIN).toISOString(),
    merged_at: new Date(now - MIN).toISOString(), merge_commit_sha: B_SHA, pr_number: 88 };
  const outlookRow = { id: 1, main_sha: A_SHA, last_deploy_at: new Date(now - 3 * MIN), release_stall: null,
    release_run: null, newest_at: new Date(now - MIN) };
  const boundary = (at) => ({ id: 4100, pr_number: 80, merge_commit_sha: A_SHA, merged_at: at, created_at: at, pending_count: 1 });
  const db = (running) => (sql) => {
    if (/FROM apps a\s+LEFT JOIN LATERAL/.test(sql)) return [outlookRow];
    if (/SELECT id, slug, self_hosted, main_sha, release_stall FROM apps WHERE id = \$1/.test(sql)) {
      return [{ id: 1, slug: 'usernode-2d5619', self_hosted: true, main_sha: running, release_stall: null }];
    }
    if (/FROM chat_sessions live/.test(sql)) return [boundary(new Date(now - 60 * MIN).toISOString())];
    return undefined;
  };
  const gateApp = { id: 1, slug: 'usernode-2d5619', self_hosted: true };

  releaseWatch._forTest.resetOutlook();
  let loaded = loadVotes({ row: merged, gateApp, db: db(A_SHA) });
  let { payload } = await callById(loaded.routes, { id: 4242 });
  assert.equal(payload.proposal.deployment_state, 'deploying', 'merged after the running build: going live');
  assert.equal(payload.proposal.release.state, 'next', 'and its page says when');

  // The running build is the change's own: live.
  releaseWatch._forTest.resetOutlook();
  loaded = loadVotes({ row: { ...merged, merge_commit_sha: A_SHA }, gateApp,
    db: (sql) => (/FROM chat_sessions live/.test(sql)
      ? [{ ...boundary(merged.merged_at), id: 4242 }] : db(A_SHA)(sql)) });
  ({ payload } = await callById(loaded.routes, { id: 4242 }));
  assert.equal(payload.proposal.deployment_state, 'deployed');

  // A child app's merge is not asked about: it goes live with its own deploy.
  loaded = loadVotes({ row: merged, gateApp: { id: 2, slug: 'notes', self_hosted: false }, db: db(A_SHA) });
  ({ payload } = await callById(loaded.routes, { id: 4242 }));
  assert.equal(payload.proposal.deployment_state, undefined);
  assert.ok(!loaded.captured.calls.some((c) => /FROM chat_sessions live/.test(c.sql)));
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
  assert.equal(minutes, 4, 'four minutes off: the demo waits out the release gap (four minutes since 10 Oct 2026)');
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
