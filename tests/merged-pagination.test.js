// #429: GET /api/apps/:slug/merged must paginate via a keyset cursor so the
// Completed list can reach every merged PR, not just the most recent 20.
// This suite drives the real route handler with a recording express Router
// and a stubbed pool, asserting:
//   • limit+1 is fetched and the look-ahead row is trimmed (hasMore=true);
//   • a clean last page reports hasMore=false;
//   • a `before`/`before_id` cursor adds the keyset predicate + binds it;
//   • a malformed cursor is ignored (newest page, no predicate);
//   • per-row fields survive paging.
//
// Same hermetic Module._load stubbing as votes-merged-chat-count.
//
// Run with: node --test tests/merged-pagination.test.js

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

// `makeRows(n)` produces n merged rows newest-first with distinct
// created_at + id so keyset paging is deterministic.
function makeRows(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: 1000 - i,
      pr_number: 500 - i,
      pr_title: `PR ${i}`,
      status: 'merged',
      chat_count: i % 2,
      kudos_count: 0,
      yes_count: 2,
      no_count: 0,
      created_at: new Date(Date.UTC(2026, 0, 100 - i)).toISOString(),
    });
  }
  return out;
}

function loadVotes({ mergedRows, total, shipped, app, deploymentBoundary, legacyCursor,
  childDeploymentState = 'unknown', stallCarried = false, selfRow = null }) {
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
    delivery: require.resolve('../src/services/proposal-delivery'),
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
        if (/AS completed_at\s+FROM chat_sessions WHERE app_id = \$1 AND id = \$2/.test(sql)) {
          return { rows: legacyCursor ? [{ completed_at: legacyCursor }] : [] };
        }
        if (/FROM chat_sessions live/.test(sql)) {
          return { rows: deploymentBoundary ? [deploymentBoundary] : [] };
        }
        // release-watch.carriedBy: did the recorded commit merge no later
        // than the running one?
        if (/FROM chat_sessions recorded\s+JOIN chat_sessions serving/.test(sql)) {
          return { rows: stallCarried ? [{ '?column?': 1 }] : [] };
        }
        // release-watch.outlook: the self-hosted row the next release's
        // estimate is made from (unanswered unless a test passes it).
        if (/FROM apps a\s+LEFT JOIN LATERAL/.test(sql)) {
          return { rows: selfRow ? [selfRow] : [] };
        }
        // #433: the column-total COUNT (no `cs.` alias) — answer it before
        // the per-row merged SELECT so the two don't collide.
        if (/COUNT\(\*\)::int AS total/.test(sql)) {
          return { rows: [{ total: typeof total === 'number' ? total : mergedRows.length }] };
        }
        // #1922: the whole-history week counts. Unanswered (rows: []) unless
        // a test passes `shipped`, which is what an older stub looks like.
        if (/AS shipped_week/.test(sql)) {
          return { rows: shipped ? [{ shipped_week: shipped.week, shipped_prev_week: shipped.prevWeek }] : [] };
        }
        // Only the merged SELECT returns rows; the topic-attrs query (and
        // anything else) returns empty.
        if (/cs\.status = 'merged'/.test(sql)) return { rows: mergedRows.slice() };
        return { rows: [] };
      },
    }),
  });
  stub(ids.github, { isEnabled: () => false });
  stub(ids.staging, {});
  stub(ids.docker, {});
  stub(ids.resolver, { checkAndResolveConflicts: async () => {}, isResolving: () => false });
  stub(ids.ws, { broadcast() {}, getReactionsForMessages: async () => ({}) });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 3, majority: 2 }),
    isUserActive: async () => true,
    listActiveUserIds: async () => [],
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.appAccess, {
    getAppForUser: async () => ({ id: 1, slug: 'demo', ...(app || {}) }),
    sessionCollabGuard: () => (req, res, next) => next(),
    ACCESS_COLUMNS: '',
  });
  stub(ids.topicAttrs, {
    summarizeForTargets: async () => new Map(),
    summarizeForProposals: async () => new Map(),
    emptySummary: () => ({ priority: null, assignee: null }),
  });
  stub(ids.visuals, { shapeAgg: () => null });
  stub(ids.delivery, { annotateChild: async (_config, _pool, _app, rows) => {
    for (const row of rows) {
      if ((row.row_type || 'pr') === 'pr') {
        row.deployment_state = childDeploymentState;
        row.deployment_kind = 'child';
      }
    }
    return { kind: 'child', state: childDeploymentState, runningSha: null,
      liveSessionId: null, livePrNumber: null, pendingCount: null };
  } });

  delete require.cache[ids.subject];
  const { voteRoutes } = require('../src/routes/votes');
  voteRoutes({});

  Module._load = _origLoad;
  delete require.cache[ids.subject];
  for (const [k, id] of Object.entries(ids)) {
    if (k === 'express') continue;
    if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
  }

  return { routes, captured };
}

function findRoute(routes, method, path) {
  return routes.find((r) => r.method === method && r.path === path);
}

async function callMerged(routes, captured, query) {
  const route = findRoute(routes, 'get', '/api/apps/:slug/merged');
  assert.ok(route, 'merged route registered');
  let payload = null;
  let statusCode = 200;
  await route.handler(
    { params: { slug: 'demo' }, user: { id: 1 }, query },
    { json(p) { payload = p; }, status(c) { statusCode = c; return { json(p) { payload = p; } }; } }
  );
  return { payload, statusCode };
}

test('default page fetches limit+1, trims look-ahead row, reports hasMore', async () => {
  // 21 rows available, default limit 20 → 20 returned + hasMore true.
  const { routes, captured } = loadVotes({ mergedRows: makeRows(21) });
  const { payload } = await callMerged(routes, captured, {});
  assert.equal(payload.merged.length, 20, 'page trimmed to limit');
  assert.equal(payload.hasMore, true, 'more pages flagged');
  const mergedCall = captured.calls.find((c) => /cs\.status = 'merged'/.test(c.sql));
  assert.match(mergedCall.sql, /ORDER BY COALESCE\(cs\.merged_at, cs\.created_at\) DESC, cs\.id DESC/, 'tiebreak ordering');
  // limit+1 (=21) bound as the LIMIT param on the no-cursor path ($3).
  assert.equal(mergedCall.params[mergedCall.params.length - 1], 21, 'limit+1 bound');
  assert.ok(!/COALESCE\(cs\.merged_at, cs\.created_at\), cs\.id\) </.test(mergedCall.sql), 'no cursor predicate on first page');
});

test('last page reports hasMore=false', async () => {
  // Exactly 20 rows available, limit 20 → no look-ahead row.
  const { routes, captured } = loadVotes({ mergedRows: makeRows(20) });
  const { payload } = await callMerged(routes, captured, {});
  assert.equal(payload.merged.length, 20);
  assert.equal(payload.hasMore, false, 'no more pages');
});

test('limit is honored and clamped to 50', async () => {
  let { routes, captured } = loadVotes({ mergedRows: makeRows(10) });
  let { payload } = await callMerged(routes, captured, { limit: '5' });
  assert.equal(payload.merged.length, 5, 'custom limit applied');
  assert.equal(payload.hasMore, true);

  ({ routes, captured } = loadVotes({ mergedRows: makeRows(60) }));
  await callMerged(routes, captured, { limit: '999' });
  const mergedCall = captured.calls.find((c) => /cs\.status = 'merged'/.test(c.sql));
  // clamp(999) -> 50, fetched as 51.
  assert.equal(mergedCall.params[mergedCall.params.length - 1], 51, 'limit clamped to 50 (+1)');
});

test('before/before_id cursor adds keyset predicate and binds it', async () => {
  const { routes, captured } = loadVotes({ mergedRows: makeRows(5) });
  const cursor = '2026-01-50T00:00:00.000Z';
  await callMerged(routes, captured, { before: '2026-01-30T00:00:00.000Z', before_id: '900' });
  const mergedCall = captured.calls.find((c) => /cs\.status = 'merged'/.test(c.sql));
  assert.match(mergedCall.sql, /\(COALESCE\(cs\.merged_at, cs\.created_at\), cs\.id\) < \(\$3, \$4\)/, 'keyset predicate present');
  assert.match(mergedCall.sql, /LIMIT \$5/, 'limit bound after cursor params');
  assert.equal(mergedCall.params[2], new Date('2026-01-30T00:00:00.000Z').toISOString(), 'before bound');
  assert.equal(mergedCall.params[3], 900, 'before_id bound');
  // cursor variable only referenced to keep lints quiet about intent
  assert.ok(cursor);
});

test('malformed cursor is ignored — newest page, no predicate', async () => {
  const { routes, captured } = loadVotes({ mergedRows: makeRows(3) });
  const { payload } = await callMerged(routes, captured, { before: 'not-a-date', before_id: 'x' });
  assert.equal(payload.merged.length, 3);
  const mergedCall = captured.calls.find((c) => /cs\.status = 'merged'/.test(c.sql));
  assert.ok(!/\(COALESCE\(cs\.merged_at, cs\.created_at\), cs\.id\) </.test(mergedCall.sql), 'no cursor predicate for bad cursor');
});

test('explicit completion cursor wins over creation date and needs no row lookup', async () => {
  const { routes, captured } = loadVotes({ mergedRows: [] });
  await callMerged(routes, captured, {
    before: '2026-01-01T00:00:00.000Z',
    before_completed_at: '2026-09-23T18:22:52.898Z', before_id: '4697',
  });
  const query = captured.calls.find(c => /cs\.status = 'merged'/.test(c.sql));
  assert.equal(query.params[2], '2026-09-23T18:22:52.898Z');
  assert.equal(query.params[3], 4697);
  assert.ok(!captured.calls.some(c => /FROM chat_sessions WHERE app_id = \$1 AND id = \$2/.test(c.sql)));
});

test('legacy creation cursor resolves its merge time within the requested app', async () => {
  const { routes, captured } = loadVotes({ mergedRows: [], legacyCursor: '2026-09-23T18:22:52.898Z' });
  await callMerged(routes, captured, { before: '2026-01-01T00:00:00.000Z', before_id: '4697' });
  const lookup = captured.calls.find(c => /FROM chat_sessions WHERE app_id = \$1 AND id = \$2/.test(c.sql));
  assert.deepEqual(lookup.params, [1, 4697]);
  const query = captured.calls.find(c => /cs\.status = 'merged'/.test(c.sql));
  assert.equal(query.params[2], '2026-09-23T18:22:52.898Z');
});

test('completed_at exposes merge time and a creation fallback for historical rows', async () => {
  const rows = makeRows(2);
  rows[0].merged_at = '2026-09-23T18:22:52.898Z';
  const { routes, captured } = loadVotes({ mergedRows: rows });
  const { payload } = await callMerged(routes, captured, {});
  assert.equal(payload.merged[0].completed_at, rows[0].merged_at);
  assert.equal(payload.merged[1].completed_at, rows[1].created_at);
});

test('child apps report delivery separately from merged status', async () => {
  const rows = makeRows(2);
  const { routes, captured } = loadVotes({
    mergedRows: rows,
    app: {
      self_hosted: false,
      main_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      main_pr_number: 500,
    },
  });
  const { payload } = await callMerged(routes, captured, {});
  assert.deepEqual(payload.merged.map((row) => row.deployment_state), ['unknown', 'unknown']);
  assert.deepEqual(payload.deployment, {
    kind: 'child', state: 'unknown', runningSha: null,
    liveSessionId: null,
    livePrNumber: null,
    pendingCount: null,
  });
  assert.ok(payload.merged.every((row) => row.deployment_kind === 'child'));
});

test('self-hosted apps derive deployed and deploying rows from the live merge boundary', async () => {
  const shas = ['cccccccccccccccccccccccccccccccccccccccc', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'];
  const rows = makeRows(3).map((row, i) => ({
    ...row,
    merge_commit_sha: shas[i],
    merged_at: new Date(Date.UTC(2026, 0, 3 - i)).toISOString(),
  }));
  const boundary = { ...rows[1], pending_count: 1 };
  const { routes, captured } = loadVotes({
    mergedRows: rows,
    app: { self_hosted: true, main_sha: shas[1], release_stall: null },
    deploymentBoundary: boundary,
  });
  const { payload } = await callMerged(routes, captured, {});
  assert.deepEqual(payload.merged.map((row) => row.deployment_state), ['deploying', 'deployed', 'deployed']);
  assert.equal(payload.deployment.state, 'deploying');
  assert.equal(payload.deployment.liveSessionId, rows[1].id);
  assert.equal(payload.deployment.livePrNumber, rows[1].pr_number);
  assert.equal(payload.deployment.pendingCount, 1);
  const boundaryCall = captured.calls.find((call) => /FROM chat_sessions live/.test(call.sql));
  assert.ok(boundaryCall, 'live boundary is resolved outside the paginated row query');
  assert.match(boundaryCall.sql, /LOWER\(live\.merge_commit_sha\) = LOWER\(\$2\)/);
});

test('a self-hosted merge going live carries its next release, and the Done column the newest one\'s', async () => {
  // #4309 follow-up: "Merged; goes live in the next release (about 8 minutes)".
  require('../src/services/release-watch')._forTest.resetOutlook();
  const MIN = 60 * 1000;
  const now = Date.now();
  const shas = ['cccccccccccccccccccccccccccccccccccccccc', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'];
  const rows = makeRows(3).map((row, i) => ({
    ...row,
    merge_commit_sha: shas[i],
    merged_at: new Date(now - (1 + 30 * i) * MIN).toISOString(),
  }));
  const { routes, captured } = loadVotes({
    mergedRows: rows,
    app: { self_hosted: true, main_sha: shas[1], release_stall: null },
    deploymentBoundary: { ...rows[1], pending_count: 1 },
    // The running release went out three minutes ago; the gap holds the next.
    selfRow: { id: 1, main_sha: shas[1], last_deploy_at: new Date(now - 3 * MIN), release_stall: null, release_run: null,
      newest_at: new Date(rows[0].merged_at) },
  });
  const { payload } = await callMerged(routes, captured, {});
  assert.deepEqual(payload.merged.map((row) => row.deployment_state), ['deploying', 'deployed', 'deployed']);
  const release = { state: 'next', etaAt: new Date(now + 8 * MIN).toISOString() };
  assert.deepEqual(payload.merged[0].release, release);
  assert.equal(payload.merged[1].release, undefined, 'live already');
  assert.deepEqual(payload.deployment.release, release);
  assert.equal(captured.calls.filter((call) => /FROM apps a\s+LEFT JOIN LATERAL/.test(call.sql)).length, 1, 'one read');
});

test('a child app\'s merges going live carry no release: their own deploy makes them live', async () => {
  require('../src/services/release-watch')._forTest.resetOutlook();
  const { routes, captured } = loadVotes({
    mergedRows: makeRows(2), app: { self_hosted: false, main_sha: null }, childDeploymentState: 'pending',
    selfRow: { id: 1, main_sha: null, last_deploy_at: new Date(), release_stall: null, release_run: null, newest_at: new Date() },
  });
  const { payload } = await callMerged(routes, captured, {});
  assert.ok(payload.merged.every((row) => row.release === undefined));
  assert.equal(payload.deployment.release, undefined);
  assert.ok(!captured.calls.some((call) => /FROM apps a\s+LEFT JOIN LATERAL/.test(call.sql)), 'nothing read for it');
});

test('self-hosted deployment stalls mark the matching pending proposal', async () => {
  const running = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const stalled = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const rows = makeRows(2).map((row, i) => ({
    ...row,
    merge_commit_sha: i === 0 ? stalled : running,
    merged_at: new Date(Date.UTC(2026, 0, 2 - i)).toISOString(),
  }));
  const { routes, captured } = loadVotes({
    mergedRows: rows,
    app: {
      self_hosted: true,
      main_sha: running,
      release_stall: { sha: stalled, kind: 'workflow_failed', detectedAt: '2026-01-03T00:00:00Z' },
    },
    deploymentBoundary: { ...rows[1], pending_count: 1 },
  });
  const { payload } = await callMerged(routes, captured, {});
  assert.deepEqual(payload.merged.map((row) => row.deployment_state), ['stalled', 'deployed']);
  assert.equal(payload.deployment.state, 'stalled');
  assert.equal(payload.deployment.stall.sha, stalled);
  const order = captured.calls.find((call) => /FROM chat_sessions recorded/.test(call.sql));
  assert.deepEqual(order.params, [1, stalled, running], 'the recorded commit is ordered against the running one');
});

// Several merges, one release (#3872): newest first, a merge still on its way,
// the release that is running, and an earlier merge the record names. That
// one never ran by itself; the running build carries it.
function carriedRows() {
  const shas = ['cccccccccccccccccccccccccccccccccccccccc', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'];
  const rows = makeRows(3).map((row, i) => ({
    ...row,
    merge_commit_sha: shas[i],
    merged_at: new Date(Date.UTC(2026, 9, 5, 8, 46 - 15 * i)).toISOString(),
  }));
  return { shas, rows };
}

test('several merges in one release: a recorded stall the running build carries is resolved', async () => {
  const { shas, rows } = carriedRows();
  const { routes, captured } = loadVotes({
    mergedRows: rows,
    app: {
      self_hosted: true,
      main_sha: shas[1],
      release_stall: { sha: shas[2], kind: 'workflow_running', detectedAt: '2026-10-05T08:42:00Z' },
    },
    deploymentBoundary: { ...rows[1], pending_count: 1 },
    stallCarried: true,
  });
  const { payload } = await callMerged(routes, captured, {});
  // The recorded commit is live inside the running build, so it says so.
  assert.deepEqual(payload.merged.map((row) => row.deployment_state), ['deploying', 'deployed', 'deployed']);
  assert.equal(payload.deployment.state, 'deploying', 'the Done column does not call the release stalled');
  assert.equal(payload.deployment.stall, undefined);
});

test('a superseded release: the failed run\'s successor went live and carried it', async () => {
  // The recorded commit's release did not complete (cancelled); the next
  // merge's release did, and is what is running.
  const { shas, rows } = carriedRows();
  const { routes, captured } = loadVotes({
    mergedRows: rows,
    app: {
      self_hosted: true,
      main_sha: shas[0],
      release_stall: { sha: shas[1], kind: 'workflow_failed', detectedAt: '2026-10-05T08:40:00Z' },
    },
    deploymentBoundary: { ...rows[0], pending_count: 0 },
    stallCarried: true,
  });
  const { payload } = await callMerged(routes, captured, {});
  assert.deepEqual(payload.merged.map((row) => row.deployment_state), ['deployed', 'deployed', 'deployed']);
  assert.equal(payload.deployment.state, 'deployed');
  assert.equal(payload.deployment.stall, undefined);
});

test('unmatched self-hosted revisions keep the honest merged fallback', async () => {
  const rows = makeRows(2);
  const { routes, captured } = loadVotes({
    mergedRows: rows,
    app: {
      self_hosted: true,
      main_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      release_stall: null,
    },
    deploymentBoundary: null,
  });
  const { payload } = await callMerged(routes, captured, {});
  assert.deepEqual(payload.merged.map((row) => row.deployment_state), ['unknown', 'unknown']);
  assert.equal(payload.deployment.state, 'unknown');
  assert.equal(payload.deployment.pendingCount, null);
});

test('#433: returns a numeric `total` independent of limit and cursor', async () => {
  // 47 merged sessions exist; the first page returns 20 rows but total=47
  // so the Kanban Done badge can show the real count, not the page size.
  let { routes, captured } = loadVotes({ mergedRows: makeRows(21), total: 47 });
  let { payload } = await callMerged(routes, captured, {});
  assert.equal(payload.merged.length, 20, 'first page still trimmed to limit');
  assert.equal(payload.total, 47, 'total reflects the whole column, not the page');
  const countCall = captured.calls.find((c) => /COUNT\(\*\)::int AS total/.test(c.sql));
  assert.ok(countCall, 'a COUNT query was issued for the total');
  assert.ok(!/\(COALESCE\(cs\.merged_at, cs\.created_at\), cs\.id\) </.test(countCall.sql), 'total COUNT carries no cursor predicate');
  assert.ok(!/LEFT JOIN/.test(countCall.sql), 'total COUNT omits the revert LEFT JOIN');

  // A second page (cursor set, smaller limit) reports the SAME total.
  ({ routes, captured } = loadVotes({ mergedRows: makeRows(5), total: 47 }));
  ({ payload } = await callMerged(routes, captured, { before: '2026-01-30T00:00:00.000Z', before_id: '900', limit: '5' }));
  assert.equal(payload.total, 47, 'total is stable across pages');
});

test('per-row fields survive paging', async () => {
  const { routes, captured } = loadVotes({ mergedRows: makeRows(2) });
  const { payload } = await callMerged(routes, captured, {});
  assert.equal(payload.merged[0].pr_number, 500);
  assert.equal(payload.merged[0].chat_count, 0);
  assert.equal(payload.merged[1].chat_count, 1);
});

// ── #1922: "shipped this week" is counted over the whole history ─────────

test('the first page carries exact week counts over the whole merged history', async () => {
  // 21 rows → the page is partial (hasMore), which is exactly when the
  // Workshop could only say "20+". The counts come from their own query.
  const { routes, captured } = loadVotes({ mergedRows: makeRows(21), shipped: { week: 34, prevWeek: 27 } });
  const { payload } = await callMerged(routes, captured, {});
  assert.equal(payload.hasMore, true);
  assert.deepEqual(payload.shipped, { week: 34, prevWeek: 27 });
  const call = captured.calls.find((c) => /AS shipped_week/.test(c.sql));
  assert.ok(call, 'the week counts are queried');
  assert.equal(call.params[0], 1, 'scoped to this app only');
  assert.equal(call.params.length, 2, 'the app id and the week start, nothing else');
  // Same rows and timestamps as the client's count (app-view.js mergedAtOf).
  assert.match(call.sql, /COALESCE\(merged_at, created_at\) AS t\s+FROM chat_sessions\s+WHERE app_id = \$1 AND status = 'merged'/);
  assert.match(call.sql, /FROM issues\s+WHERE app_id = \$1 AND kind = 'close_issue' AND status = 'closed'\s+AND payload \? 'appliedAt'/);
  // #2176: the calendar week (Monday 00:00 UTC), not a trailing seven days.
  assert.match(call.sql, /t >= \$2::timestamptz\)::int AS shipped_week/);
  assert.match(call.sql, /t < \$2::timestamptz\s+AND t >= \$2::timestamptz - interval '7 days'\)::int AS shipped_prev_week/);
  assert.match(String(call.params[1]), /^\d{4}-\d{2}-\d{2}T00:00:00Z$/, 'the week start rides as a parameter');
  assert.equal(new Date(call.params[1]).getUTCDay(), 1, 'and it is a Monday');
  assert.doesNotMatch(call.sql, /AS total\b|cs\.status/, 'never collides with the other stubs');
});

test('a cursor page does not recount the weeks', async () => {
  const { routes, captured } = loadVotes({ mergedRows: makeRows(5), shipped: { week: 3, prevWeek: 1 } });
  const { payload } = await callMerged(routes, captured, { before: '2026-01-30T00:00:00.000Z', before_id: '900' });
  assert.equal(payload.shipped, undefined);
  assert.ok(!captured.calls.some((c) => /AS shipped_week/.test(c.sql)));
});

test('no week counts in the response when the query answers nothing', async () => {
  const { routes, captured } = loadVotes({ mergedRows: makeRows(3) });
  const { payload } = await callMerged(routes, captured, {});
  assert.equal(payload.shipped, undefined, 'the client then counts its page, as before');
  assert.equal(payload.merged.length, 3);
});
