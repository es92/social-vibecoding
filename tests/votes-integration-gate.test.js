// checkAndMerge under direct-merge lanes (services/merge-queue.js).
//
// The integration gate used to refuse any head behind main, post "syncing
// automatically", and hand the proposal to a queue that spent a worker
// turn, a rebuild and a re-run bringing it level — per proposal, in
// series, each merge putting every sibling one further behind. Now it asks
// one question: does this head merge cleanly with main RIGHT NOW? Clean
// merges as it stands, however far behind; a conflict is refused and
// handed to the conflict lane. The tree that results is judged as a whole
// by services/main-watch.js, which is the main_healthy gate after it.
//
// Same require.cache stubbing as votes-checks-gate.test.js: the vote
// threshold and the checks gate are met, and what varies is what the
// mirror says about the head and what the apps row says about main.
//
// Run with: node --test tests/votes-integration-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeGate } = require('../src/services/active-users');

const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: () => ({}) };
  return _origLoad.call(this, request, ...rest);
};

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function makeRecordingPool(handlers) {
  const queries = [];
  return {
    queries,
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

const HEAD = 'a'.repeat(40);
const MAIN_SHA = 'b'.repeat(40);

function loadVotes({ measured }) {
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
    integration: require.resolve('../src/services/integration'),
    mergeQueue: require.resolve('../src/services/merge-queue'),
    syncMain: require.resolve('../src/services/sync-main'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const systemMessages = [];
  const recheckCalls = [];
  const enqueued = [];
  const syncCalls = [];
  const measureCalls = [];
  const blockReasonWrites = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => makeRecordingPool([]) });
  stub(ids.github, {
    isEnabled: () => true,
    mergePR: async () => ({ sha: 'deadbeefcafe', merged: true }),
  });
  stub(ids.staging, {
    rebuildProduction: async () => ({ ok: true }),
    teardownStaging: async () => {},
  });
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
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_MERGED: 'pr_merged' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.stagingRecovery, {
    recheckSessionChecks: async (args) => { recheckCalls.push(args); return 'rechecked'; },
    rebuildSessionStaging: async () => 'skipped',
    stagingNeedsRebuild: async () => false,
    recordStagingBootFailure: async () => {},
    recordChecksSkipped: async () => {},
  });
  // The mirror's answer about the head, as the gate reads it.
  stub(ids.integration, {
    measureDeduped: async (ctx, opts) => {
      measureCalls.push({ sessionId: ctx.session.id, opts });
      if (measured instanceof Error) throw measured;
      return measured;
    },
    setBlockReasons: async (_pool, sessionId, reasons) => { blockReasonWrites.push({ sessionId, reasons }); },
    _parseRepo: (url) => {
      const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      return m ? { owner: m[1], repo: m[2] } : null;
    },
  });
  stub(ids.mergeQueue, { enqueue: (_config, appId) => { enqueued.push(appId); } });
  // The old gate's remedy. Under direct lanes the gate never calls it.
  stub(ids.syncMain, {
    runSyncMain: async (args) => { syncCalls.push(args); return { ok: true, syncResult: 'clean', behind: 0 }; },
    persistConflictState: async () => {},
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, systemMessages, recheckCalls, enqueued, syncCalls, measureCalls, blockReasonWrites, restore };
}

const session = {
  id: 7, app_id: 5, app_slug: 'whiteboard', app_self_hosted: false,
  repo_url: 'https://github.com/acme/whiteboard', pr_number: 52,
  pr_title: 'Premium brushes', user_id: 3, behind_main: 0,
  reviewed_head_sha: HEAD, integration_block_reasons: [],
};

// Vote threshold met, checks as given, main as given.
function poolWith({ checks = {}, main = null } = {}) {
  const checkRow = {
    check_state: 'passing', test_results: [{ status: 'pass' }], check_error_detail: null,
    checks_commit_sha: HEAD, check_phase: null, checks_checked_at: new Date().toISOString(),
    ...checks,
  };
  return makeRecordingPool([
    [/SELECT COUNT\(\*\) as cnt FROM pr_votes/, [{ cnt: '1' }]],
    [/SELECT check_state, test_results[\s\S]*FROM chat_sessions/, [checkRow]],
    [/SELECT main_check_state[\s\S]*FROM apps WHERE id/, main ? [main] : []],
    [/SET status = 'merging'/, [{ id: 7 }]],
    [/SELECT \* FROM apps WHERE id/, [{ id: 5, slug: 'whiteboard', self_hosted: false }]],
    [/SET\s+status = 'merged'/, { rows: [], rowCount: 1 }],
  ]);
}

const claimed = (p) => p.queries.some((q) => /SET status = 'merging'/.test(q.sql));

// ── the integration gate ─────────────────────────────────────────────────

test('a clean head 12 commits behind main merges as it stands: no sync, no queue, no promise', async () => {
  const { subject, systemMessages, syncCalls, enqueued, measureCalls, blockReasonWrites, restore } = loadVotes({
    measured: { behindBy: 12, aheadBy: 3, mergesClean: true, conflictPaths: [] },
  });
  const p = poolWith();
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, true);
    assert.ok(claimed(p), 'claimed the merge');
    assert.deepEqual(blockReasonWrites, [{ sessionId: 7, reasons: [] }],
      'the claim clears whatever the lane had written: nothing blocks it any more');
    assert.equal(syncCalls.length, 0, 'the gate does not bring the head up to date first');
    assert.equal(enqueued.length, 0, 'nothing is queued for integration');
    assert.ok(!systemMessages.some((m) => /syncing|bringing .* up to date/i.test(m)),
      'no "syncing automatically" — the sentence that used to be a promise nobody kept');
    // Measured now, not remembered off the row: a cached behind_main of 0
    // once let a genuinely-behind head through to a 405.
    assert.equal(measureCalls.length, 1);
    assert.equal(measureCalls[0].opts.force, true);
  } finally { restore(); }
});

test('a measured conflict is refused and handed to the conflict lane, with the author named', async () => {
  const { subject, systemMessages, enqueued, syncCalls, restore } = loadVotes({
    measured: { behindBy: 2, aheadBy: 1, mergesClean: false, conflictPaths: ['dapp.json', 'src/app.js'] },
  });
  const p = poolWith();
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, false);
    assert.equal(r.blockReason, 'conflict');
    assert.deepEqual(r.conflictPaths, ['dapp.json', 'src/app.js']);
    assert.ok(!claimed(p), 'never claimed the merge');
    assert.deepEqual(enqueued, [5], 'the conflict lane is asked to look at the app');
    assert.equal(syncCalls.length, 0, 'the gate itself resolves nothing; the lane spends the turn');
    const msg = systemMessages.find((m) => /conflicts with main/.test(m));
    assert.ok(msg, 'posted the conflict');
    assert.match(msg, /2 files \(dapp\.json, src\/app\.js\)/);
    assert.match(msg, /The platform will try to resolve it automatically/);
    assert.match(msg, /<@3> needs to resolve it from the session's dev-chat/);
  } finally { restore(); }
});

test("a conflict the lane already gave up on says so: the author's, not the platform's", async () => {
  const { subject, systemMessages, restore } = loadVotes({
    measured: { behindBy: 2, aheadBy: 1, mergesClean: false, conflictPaths: ['dapp.json'] },
  });
  const p = poolWith();
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, {
      ...session, integration_block_reasons: ['unresolvable'],
    });
    assert.equal(r.blockReason, 'conflict');
    const msg = systemMessages.find((m) => /conflicts with main/.test(m));
    assert.match(msg, /The platform cannot resolve this one; <@3> needs to resolve it/);
    assert.ok(!/will try to resolve it automatically/.test(msg));
  } finally { restore(); }
});

test('a measurement that cannot run does not block the merge: GitHub is the real guard', async () => {
  const { subject, restore } = loadVotes({ measured: new Error('mirror fetch: connection reset') });
  const p = poolWith();
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, true, 'failing closed here would wedge every merge behind a git hiccup');
  } finally { restore(); }
});

// ── deferred checks meet a clean head ────────────────────────────────────

test('checks deferred while the head conflicted start now that it measures clean, and the merge waits for them', async () => {
  const { subject, recheckCalls, restore } = loadVotes({
    measured: { behindBy: 1, aheadBy: 1, mergesClean: true, conflictPaths: [] },
  });
  // Stamped hours ago, which would read as a stale pending run without the
  // phase saying nothing was ever started.
  const p = poolWith({
    checks: {
      check_state: 'pending', check_phase: 'deferred', test_results: [],
      checks_checked_at: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    },
  });
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, false);
    assert.equal(r.checksBlocked, true, 'no verdict yet: the gate still holds');
    assert.equal(r.checkState, 'pending');
    assert.equal(recheckCalls.length, 1, 'exactly one kick — as the resolved run, not as a stale-pending rescue');
    assert.equal(recheckCalls[0].reason, 'conflict-resolved');
    assert.equal(recheckCalls[0].session.id, 7);
  } finally { restore(); }
});

test('checks deferred on a head that STILL conflicts are left alone: the conflict gate answers first', async () => {
  const { subject, recheckCalls, restore } = loadVotes({
    measured: { behindBy: 1, aheadBy: 1, mergesClean: false, conflictPaths: ['dapp.json'] },
  });
  const p = poolWith({
    checks: {
      check_state: 'pending', check_phase: 'deferred', test_results: [],
      checks_checked_at: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    },
  });
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.blockReason, 'conflict');
    assert.equal(recheckCalls.length, 0, 'a run now would only defer again');
  } finally { restore(); }
});

// ── the main_healthy gate ────────────────────────────────────────────────

test("a red main pauses this proposal's merge too, whatever its own checks said", async () => {
  const { subject, restore } = loadVotes({
    measured: { behindBy: 0, aheadBy: 1, mergesClean: true, conflictPaths: [] },
  });
  const p = poolWith({
    main: {
      main_check_state: 'failing', main_check_sha: MAIN_SHA,
      main_check_at: new Date().toISOString(), main_check_detail: { summary: '2 failing' },
      main_check_resumed_sha: null,
    },
  });
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session });
    assert.equal(r.merged, false);
    assert.equal(r.blockReason, 'main_failing');
    assert.equal(r.mainCheck.paused, true);
    assert.equal(r.mainCheck.sha, MAIN_SHA);
    assert.ok(!claimed(p), 'never claimed the merge');
  } finally { restore(); }
});

test('an admin resuming merges on that exact red sha lets the merge through; a fresher red sha pauses again', async () => {
  const measured = { behindBy: 0, aheadBy: 1, mergesClean: true, conflictPaths: [] };
  let loaded = loadVotes({ measured });
  try {
    const resumed = poolWith({
      main: {
        main_check_state: 'failing', main_check_sha: MAIN_SHA,
        main_check_at: new Date().toISOString(), main_check_detail: null,
        main_check_resumed_sha: MAIN_SHA,
      },
    });
    const r = await loaded.subject.checkAndMerge({ jwtSecret: 's' }, resumed, { ...session });
    assert.equal(r.merged, true, 'the resume is the admin taking responsibility for this main');
  } finally { loaded.restore(); }

  loaded = loadVotes({ measured });
  try {
    const moved = poolWith({
      main: {
        main_check_state: 'failing', main_check_sha: 'c'.repeat(40),
        main_check_at: new Date().toISOString(), main_check_detail: null,
        main_check_resumed_sha: MAIN_SHA,
      },
    });
    const r = await loaded.subject.checkAndMerge({ jwtSecret: 's' }, moved, { ...session });
    assert.equal(r.blockReason, 'main_failing', 'a resume is for one sha; the next red main is a new question');
  } finally { loaded.restore(); }
});

test('a main that was never watched, is green, or is mid-run does not pause anything', async () => {
  for (const main of [
    null,
    { main_check_state: 'passing', main_check_sha: MAIN_SHA, main_check_resumed_sha: null },
    { main_check_state: 'running', main_check_sha: MAIN_SHA, main_check_resumed_sha: null },
    { main_check_state: 'error', main_check_sha: MAIN_SHA, main_check_resumed_sha: null },
  ]) {
    const { subject, restore } = loadVotes({
      measured: { behindBy: 0, aheadBy: 1, mergesClean: true, conflictPaths: [] },
    });
    try {
      const r = await subject.checkAndMerge({ jwtSecret: 's' }, poolWith({ main }), { ...session });
      assert.equal(r.merged, true, `main ${main ? main.main_check_state : 'unwatched'} merges`);
    } finally { restore(); }
  }
});

test('admin force-merge skips the integration and main_healthy gates alike', async () => {
  const { subject, measureCalls, restore } = loadVotes({
    measured: { behindBy: 2, aheadBy: 1, mergesClean: false, conflictPaths: ['dapp.json'] },
  });
  const p = poolWith({
    main: { main_check_state: 'failing', main_check_sha: MAIN_SHA, main_check_resumed_sha: null },
  });
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, p, { ...session }, { force: true });
    assert.equal(r.merged, true);
    assert.equal(measureCalls.length, 0, 'GitHub refuses a genuinely unmergeable head on its own');
    assert.ok(!p.queries.some((q) => /SELECT main_check_state/.test(q.sql)), 'main is not consulted under force');
  } finally { restore(); }
});
