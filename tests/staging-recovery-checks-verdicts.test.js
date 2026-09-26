// #461 "run checks, or skip them explicitly": rebuildSessionStaging's no-op
// paths used to `return 'skipped'` with NO verdict written, leaving
// check_state NULL — the merge gate blocks NULL as "still running its tests"
// and the stuck-checks sweeper re-picked the row every pass, re-skipped, and
// the proposal stayed merge-blocked forever. Now every no-op records an
// explicit terminal verdict:
//
//   - unparseable repo_url / missing GITHUB_BOT_TOKEN → 'skipped'
//     ("checks unavailable: GitHub is not configured"), gate-passing;
//   - branch not ahead of main → 'skipped' ("nothing to test");
//   - compareCommits throw → 'error' (retryable via the existing
//     storeChecks backoff bookkeeping).
//
// Also covers the two visuals helpers behind those verdicts:
// storeChecksSkipped (writes 'skipped' + reason, clears the failure streak)
// and setChecksPending (a later push returns a 'skipped' row to 'pending'),
// plus recordStagingBootFailure's exported surface and recordChecksSkipped's
// broadcast + auto-merge re-drive.
//
// Same require.cache stubbing pattern as ensure-staging.test.js — nothing
// real spins up. The ahead_by===0 / compare-throw paths need a live
// @octokit/rest import (not installed in the test tree), so their verdict
// writes are exercised at the helper layer (storeChecksSkipped / the
// storeChecks 'error' branch) rather than through rebuildSessionStaging.
//
// Run with: node --test tests/staging-recovery-checks-verdicts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// services/visuals pulls in jsonwebtoken / pg at load time (paths these
// tests never reach). They aren't installed in the test environment, so shim
// them the same way checks-auto-merge-trigger.test.js does.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'jsonwebtoken') return { sign: () => 'tok', verify: () => ({}) };
  if (request === 'pg') return { Pool: class { async query() { return { rows: [] }; } } };
  return _origLoad.call(this, request, ...rest);
};

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return original;
}

function makeRecordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return { rows: [], rowCount: 1 };
    },
  };
}

// Load staging-recovery with visuals + ws stubbed so recordChecksSkipped /
// recordStagingBootFailure calls are observable without touching Postgres.
function loadRecovery() {
  const paths = {
    logger: require.resolve('../src/services/logger'),
    visuals: require.resolve('../src/services/visuals'),
    ws: require.resolve('../src/services/ws'),
    subject: require.resolve('../src/services/staging-recovery'),
  };
  const skippedCalls = [];
  const errorChecks = [];
  const drains = [];
  const broadcasts = [];
  const notes = [];
  const originals = [
    [paths.logger, stubModule(paths.logger, { info() {}, warn() {}, error() {}, debug() {} })],
    [paths.visuals, stubModule(paths.visuals, {
      storeChecksSkipped: async (_pool, sessionId, commitSha, reason, expectedCommitSha) => {
        skippedCalls.push({ sessionId, commitSha, reason, expectedCommitSha });
      },
      storeChecks: async (_pool, sessionId, commitSha, result, detail) => {
        errorChecks.push({ sessionId, commitSha, result, detail });
      },
      maybeAutoMergeAfterChecks: (_config, _pool, session, state) => {
        drains.push({ sessionId: session.id, state });
      },
      summarizeBootFailure: (err) => (err && err.message) || 'boot failure',
    })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: (m) => broadcasts.push(m),
      pushSessionUpdate: () => {},
      // #866: imported proposals narrate into the group discussion thread
      // (they have no dev chat), so this is now part of the failure path.
      sendSystemMessage: async (_pool, appId, text, kind, metadata, target) => {
        notes.push({ appId, text, kind, metadata, target });
      },
    })],
  ];
  delete require.cache[paths.subject];
  const subject = require('../src/services/staging-recovery');
  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.subject];
  };
  return { subject, skippedCalls, errorChecks, drains, broadcasts, notes, restore };
}

const SESSION = {
  id: 42, app_id: 5, app_slug: 'whiteboard', app_name: 'Whiteboard',
  branch_name: 'feat/x', status: 'promoted',
  checks_commit_sha: 'cafe1234',
};

test('stuck-check recovery includes submitted active CLI handoffs without widening to drafts or ordinary sessions', async () => {
  const { subject, restore } = loadRecovery();
  const submitted = {
    id: 2,
    status: 'active',
    source: 'cli_handoff',
    checks_commit_sha: 'head-2',
    handoff_head_sha: 'head-2',
    handoff_uploaded_sha: 'head-2',
    handoff_upload_checked_sha: null,
  };
  const candidates = [
    { id: 1, status: 'promoted', source: 'native' },
    submitted,
    { id: 3, status: 'active', source: 'native', checks_commit_sha: 'head-3' },
    { id: 4, status: 'active', source: 'cli_handoff', checks_commit_sha: null },
    {
      id: 5,
      status: 'active',
      source: 'cli_handoff',
      checks_commit_sha: 'old-head',
      handoff_head_sha: 'old-head',
      handoff_uploaded_sha: 'new-upload',
      handoff_upload_checked_sha: 'old-head',
    },
  ];
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return { rows: candidates };
    },
  };
  try {
    assert.equal(subject.isStuckCheckRecoveryScope(submitted), true);
    const { rows } = await subject.findStuckCheckSessions({
      pool, staleMs: 600000, maxAutoRetries: 6,
    });
    assert.deepEqual(rows.map((row) => row.id), [1, 2]);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql,
      /cs\.status = 'active'[\s\S]*cs\.source = 'cli_handoff'/,
      'submitted pre-vote handoffs are selected alongside promoted proposals');
    assert.match(queries[0].sql, /COALESCE\(cs\.checks_commit_sha, cs\.handoff_head_sha\) IS NOT NULL/,
      'a fresh proposal draft is not mistaken for a lost check run');
    assert.match(queries[0].sql, /handoff_upload_checked_sha/,
      'an upload awaiting proposal_submit_build stays out of recovery');
    assert.match(queries[0].sql,
      /cs\.check_state = 'pending'[\s\S]*cs\.checks_checked_at IS NULL/,
      'legacy pending rows with no timestamp are recoverable');
    assert.deepEqual(queries[0].params, [600000, 6, 50]);
  } finally { restore(); }
});

test('checkRunOverdue requires a submitted head and treats a missing timestamp as stalled', () => {
  const { subject, restore } = loadRecovery();
  try {
    const now = Date.now();
    assert.equal(subject.checkRunOverdue({
      check_state: 'pending', checks_commit_sha: 'head', checks_checked_at: null,
    }, { now, staleMs: 600000 }), true);
    assert.equal(subject.checkRunOverdue({
      check_state: 'pending', checks_commit_sha: 'head',
      checks_checked_at: new Date(now - 1000),
    }, { now, staleMs: 600000 }), false);
    assert.equal(subject.checkRunOverdue({ check_state: null }, {
      now, staleMs: 600000,
    }), false, 'a draft with no submitted head has no check run to recover');
  } finally { restore(); }
});

test('a deferred verdict is waiting on a conflict, not on a runner: never overdue, never swept', async () => {
  const { subject, restore } = loadRecovery();
  try {
    const now = Date.now();
    // Hours old and still 'pending' — the shape the stale sweep exists to
    // catch — but phase 'deferred' says no run was ever started for it
    // (services/check-admission.js). Re-driving one would only defer again.
    assert.equal(subject.checkRunOverdue({
      check_state: 'pending', check_phase: 'deferred', checks_commit_sha: 'head',
      checks_checked_at: new Date(now - 6 * 3600 * 1000),
    }, { now, staleMs: 600000 }), false);
    assert.equal(subject.checkRunOverdue({
      check_state: 'pending', check_phase: 'deferred', checks_commit_sha: 'head', checks_checked_at: null,
    }, { now, staleMs: 600000 }), false, 'even with no timestamp at all');
    // The same head with a run actually going is judged as before.
    assert.equal(subject.checkRunOverdue({
      check_state: 'pending', check_phase: 'testing', checks_commit_sha: 'head',
      checks_checked_at: new Date(now - 6 * 3600 * 1000),
    }, { now, staleMs: 600000 }), true);

    const queries = [];
    const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
    await subject.findStuckCheckSessions({ pool, staleMs: 600000, maxAutoRetries: 6 });
    assert.match(queries[0].sql, /cs\.check_phase IS DISTINCT FROM 'deferred'/,
      'the pending branch of the sweep leaves deferred rows alone');
  } finally { restore(); }
});

test("rebuildSessionStaging: unparseable repo_url records a 'skipped' verdict (GitHub not configured)", async () => {
  const { subject, skippedCalls, restore } = loadRecovery();
  try {
    const r = await subject.rebuildSessionStaging({
      config: {}, pool: makeRecordingPool(),
      session: { ...SESSION, repo_url: 'not-a-github-url' },
      reason: 'test',
    });
    assert.equal(r, 'skipped');
    assert.equal(skippedCalls.length, 1);
    assert.equal(skippedCalls[0].sessionId, 42);
    assert.match(skippedCalls[0].reason, /GitHub is not configured/);
    assert.equal(skippedCalls[0].commitSha, 'cafe1234', 'stamps the last-known commit');
  } finally { restore(); }
});

test("rebuildSessionStaging: missing GITHUB_BOT_TOKEN records a 'skipped' verdict", async () => {
  const { subject, skippedCalls, restore } = loadRecovery();
  const prev = process.env.GITHUB_BOT_TOKEN;
  delete process.env.GITHUB_BOT_TOKEN;
  try {
    const r = await subject.rebuildSessionStaging({
      config: {}, pool: makeRecordingPool(),
      session: { ...SESSION, repo_url: 'https://github.com/acme/whiteboard' },
      reason: 'test',
    });
    assert.equal(r, 'skipped');
    assert.equal(skippedCalls.length, 1);
    assert.match(skippedCalls[0].reason, /GitHub is not configured/);
  } finally {
    if (prev !== undefined) process.env.GITHUB_BOT_TOKEN = prev;
    restore();
  }
});

test('recordChecksSkipped: writes the verdict, broadcasts checks_ready, re-drives the auto-merge drain', async () => {
  const { subject, skippedCalls, drains, broadcasts, restore } = loadRecovery();
  try {
    await subject.recordChecksSkipped({
      config: {}, pool: makeRecordingPool(), session: { ...SESSION },
      commitSha: 'beef5678', expectedCommitSha: 'cafe1234',
      reason: 'branch has no commits beyond main, so there is nothing to test',
    });
    assert.equal(skippedCalls.length, 1);
    assert.equal(skippedCalls[0].commitSha, 'beef5678');
    assert.equal(skippedCalls[0].expectedCommitSha, 'cafe1234');
    assert.match(skippedCalls[0].reason, /nothing to test/);
    const ev = broadcasts.find((m) => m.event === 'checks_ready');
    assert.ok(ev, 'checks_ready broadcast emitted');
    assert.equal(ev.state, 'skipped');
    assert.equal(ev.sessionId, 42);
    assert.deepEqual(drains, [{ sessionId: 42, state: 'skipped' }],
      'auto-merge drain re-driven with the skipped verdict');
  } finally { restore(); }
});

test('recordStagingBootFailure records the verdict and retires every stale preview pointer', async () => {
  const { subject, errorChecks, restore } = loadRecovery();
  const pool = makeRecordingPool();
  try {
    assert.equal(typeof subject.recordStagingBootFailure, 'function', 'exported for the dev-turn tails');
    await subject.recordStagingBootFailure({
      config: {}, pool, session: { ...SESSION },
      commitHash: 'cafe1234', err: new Error('relation "posts" does not exist'),
    });
    assert.equal(errorChecks.length, 1);
    assert.equal(errorChecks[0].sessionId, 42);
    assert.equal(errorChecks[0].commitSha, 'cafe1234');
    assert.equal(errorChecks[0].result.state, 'error');
    assert.match(errorChecks[0].detail, /does not exist/);
    const retire = pool.queries.find((q) => /SET staging_container_id = NULL/.test(q.sql));
    assert.ok(retire, 'a failed new build cannot leave the prior preview advertised');
    assert.match(retire.sql, /staging_url = NULL/);
    assert.match(retire.sql, /staging_commit_sha = NULL/);
    assert.match(retire.sql, /checks_commit_sha IS NOT DISTINCT FROM \$2::text/,
      'a late failed build cannot clear a newer preview');
    assert.deepEqual(retire.params, [42, 'cafe1234']);
  } finally { restore(); }
});

// ── visuals helpers: the SQL behind the verdicts ─────────────────────────

function loadVisuals() {
  const paths = {
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/visuals'),
  };
  const origLogger = stubModule(paths.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[paths.subject];
  const subject = require('../src/services/visuals');
  const restore = () => {
    if (origLogger) require.cache[paths.logger] = origLogger; else delete require.cache[paths.logger];
    delete require.cache[paths.subject];
  };
  return { subject, restore };
}

test("storeChecksSkipped: writes 'skipped' + reason and clears the failure streak", async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    await subject.storeChecksSkipped(pool, 42, 'cafe1234', 'branch has no commits beyond main, so there is nothing to test');
    assert.equal(pool.queries.length, 1);
    const q = pool.queries[0];
    assert.match(q.sql, /check_state = 'skipped'/);
    assert.match(q.sql, /consecutive_check_failures = 0/);
    assert.match(q.sql, /first_check_failure_at = NULL/);
    assert.match(q.sql, /last_check_failure_at = NULL/);
    assert.match(q.sql, /check_next_retry_at = NULL/);
    assert.match(q.sql, /check_error_notified_at = NULL/);
    assert.match(q.sql, /status IN \('active', 'paused', 'promoted', 'merging'\)/,
      'an archived or merged session cannot regain a terminal checks verdict');
    assert.match(q.sql, /checks_commit_sha IS NOT DISTINCT FROM \$4::text/);
    assert.deepEqual(q.params, [
      'cafe1234', 'branch has no commits beyond main, so there is nothing to test', 42, 'cafe1234',
    ]);
  } finally { restore(); }
});

test('storeChecksSkipped: a null commit degrades to NULL, a missing reason to the fallback line (#3180)', async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    assert.equal(subject.DEFAULT_CHECKS_SKIPPED_REASON, 'there was nothing to test');
    for (const reason of [null, undefined, '', '   ']) {
      await subject.storeChecksSkipped(pool, 42, null, reason);
      assert.deepEqual(pool.queries.at(-1).params, [null, 'there was nothing to test', 42, null],
        `a skipped verdict always says why (reason ${JSON.stringify(reason)})`);
    }
  } finally { restore(); }
});

test('storeChecksSkipped can atomically move a no-commit verdict to the compared base SHA', async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    await subject.storeChecksSkipped(
      pool, 42, 'new-main-sha', 'nothing to test', 'previous-reviewed-sha'
    );
    const q = pool.queries[0];
    assert.deepEqual(q.params, [
      'new-main-sha', 'nothing to test', 42, 'previous-reviewed-sha',
    ]);
  } finally { restore(); }
});

test("setChecksPending returns a 'skipped' row to 'pending' for the next commit (same SQL path)", async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    await subject.setChecksPending(pool, 42, 'feed0042');
    assert.equal(pool.queries.length, 1);
    const q = pool.queries[0];
    assert.match(q.sql, /SET check_state = 'pending'/);
    assert.match(q.sql, /status IN \('active', 'paused', 'promoted', 'merging'\)/,
      'a delayed retry cannot resurrect checks on archived or merged rows');
    // $3 is check_phase and $4 is check_trigger — both NULL when the caller
    // names neither a stage nor a reason.
    assert.deepEqual(q.params, [42, 'feed0042', null, null]);
  } finally { restore(); }
});

test("storeChecks 'error' branch keeps the backoff bookkeeping the compare-throw path relies on", async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    await subject.storeChecks(pool, 42, 'cafe1234', { state: 'error', results: [] },
      'could not compare feat/x with main: boom');
    const q = pool.queries[0];
    assert.match(q.sql, /consecutive_check_failures = consecutive_check_failures \+ 1/);
    assert.match(q.sql, /check_next_retry_at = NOW\(\) \+ make_interval/);
    assert.match(q.sql, /status IN \('active', 'paused', 'promoted', 'merging'\)/,
      'a detached failure cannot mutate a withdrawn session');
    assert.match(q.sql, /checks_commit_sha IS NOT DISTINCT FROM \$3::text/);
    assert.equal(q.params[0], 'error');
    assert.match(String(q.params[4]), /could not compare/);
  } finally { restore(); }
});

test('terminal check writes are discarded after a newer commit owns the session', async () => {
  const { subject, restore } = loadVisuals();
  const pool = {
    async query() { return { rows: [], rowCount: 0 }; },
  };
  try {
    assert.equal(await subject.storeChecks(
      pool, 42, 'old-head', { state: 'passing', results: [] }
    ), false);
    assert.equal(await subject.storeChecksSkipped(
      pool, 42, 'old-head', 'stale no-op'
    ), false);
  } finally { restore(); }
});

// ── #866: imported proposals heal by SHA and narrate where they're visible ──
//
// An imported PR reaches this file the moment its preview is GC'd or lost to a
// restart, and every assumption the heal made about a session was a native
// one: compare `main...<branch_name>` (a fork's head ref isn't in the base
// repo → permanent 'error' verdict), open a PR if none exists (there always is
// one — it's someone else's), and write the breadcrumb to
// chat_session_messages (a surface an imported proposal cannot open).
//
// The compare path itself can't be driven here — rebuildSessionStaging does
// `await import('@octokit/rest')`, which isn't installed in the test tree (see
// the header note), and an ESM dynamic import can't be require.cache-stubbed.
// So the reachable half is asserted behaviourally and the rest as source
// invariants, the same convention as tests/staging-pill-fixture-visibility.js.

// A pool that answers recordStagingBootFailure's streak readback, so the
// notify/post half of the function actually runs.
function makeStreakPool(row) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/SELECT user_id, app_id, pr_number/.test(String(sql))) return { rows: [row] };
      return { rows: [], rowCount: 1 };
    },
  };
}

const STREAK_ROW = { user_id: 3, app_id: 5, pr_number: 9401, consecutive_check_failures: 1, check_error_notified_at: null };

test('boot failure on an IMPORTED proposal posts to the discussion thread, not the dev transcript', async () => {
  const { subject, notes, restore } = loadRecovery();
  const pool = makeStreakPool(STREAK_ROW);
  try {
    await subject.recordStagingBootFailure({
      config: {}, pool,
      session: { ...SESSION, source: 'imported', imported_pr_head_sha: 'abc123', pr_number: 9401 },
      commitHash: 'abc123',
      err: new Error('missing required secret OPENAI_KEY'),
    });
    assert.equal(notes.length, 1, 'exactly one post per failure streak');
    const n = notes[0];
    assert.deepEqual(n.target, { type: 'session', ref: 42 },
      'targets the proposal discussion thread — an imported PR has no dev chat to read');
    assert.match(n.text, /Staging preview failed to start/);
    assert.match(n.text, /missing required secret OPENAI_KEY/, 'names the blocking reason');
    assert.match(n.text, /can't merge yet/, 'connects the failure to the blocked merge');
    assert.equal(n.metadata.checkError, true);
    assert.equal(n.metadata.prNumber, 9401);
    assert.ok(!pool.queries.some((q) => /INSERT INTO chat_session_messages/.test(q.sql)),
      'no row written to the invisible surface');
  } finally { restore(); }
});

test('boot failure on a NATIVE session still writes the dev-chat transcript row', async () => {
  const { subject, notes, restore } = loadRecovery();
  const pool = makeStreakPool(STREAK_ROW);
  try {
    await subject.recordStagingBootFailure({
      config: {}, pool, session: { ...SESSION },
      commitHash: 'cafe1234', err: new Error('port already in use'),
    });
    assert.equal(notes.length, 0, 'native sessions do not post to the group thread');
    const insert = pool.queries.find((q) => /INSERT INTO chat_session_messages/.test(q.sql));
    assert.ok(insert, 'the dev chat is where a native session reads its failures');
    assert.match(String(insert.params[1]), /port already in use/);
  } finally { restore(); }
});

test('a quiet backoff retry narrates nothing, imported or not', async () => {
  const { subject, notes, restore } = loadRecovery();
  const pool = makeStreakPool({ ...STREAK_ROW, consecutive_check_failures: 3, check_error_notified_at: '2026-07-01T00:00:00Z' });
  try {
    await subject.recordStagingBootFailure({
      config: {}, pool, session: { ...SESSION, source: 'imported' },
      commitHash: 'abc123', err: new Error('still broken'),
    });
    assert.equal(notes.length, 0, 'the streak was already announced');
    assert.ok(!pool.queries.some((q) => /UPDATE chat_sessions SET check_error_notified_at/.test(q.sql)),
      'and the stamp is not rewritten');
  } finally { restore(); }
});

// ── source invariants for the compare/PR/breadcrumb branches ────────────

const RECOVERY_SRC = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'src', 'services', 'staging-recovery.js'), 'utf8'
);

test('the heal compares and pins the IMPORTED head sha, never the fork branch name', () => {
  assert.match(RECOVERY_SRC, /const importedHead = imported \? \(session\.imported_pr_head_sha \|\| null\) : null;/,
    'the recorded head sha is the imported identity');
  assert.match(RECOVERY_SRC, /const compareHead = importedHead \|\| session\.branch_name;/,
    'imported → sha, native → branch (a fork head ref is not in this repo)');
  assert.match(RECOVERY_SRC, /base: 'main', head: compareHead/, 'the compare uses it');
  assert.match(RECOVERY_SRC, /const commitHash = importedHead\s*\n\s*\|\|/,
    'and the build is pinned to it, not to the compare tip');
});

test('the heal claims the resolved commit before staging can fail', () => {
  assert.match(
    RECOVERY_SRC,
    /const commitHash = [\s\S]*?await visuals\.setChecksPending\(pool, session\.id, commitHash,[\s\S]*?buildAndDeployStaging\(config, session, app, commitHash\)/,
    'a boot failure must be stored against the same commit the rebuild attempted'
  );
});

test('an imported row with no recorded head sha records a terminal skip', () => {
  assert.match(RECOVERY_SRC, /if \(imported && !importedHead\) \{[\s\S]*?reason: 'imported PR has no recorded head commit, so there is nothing to preview'/,
    'nothing to pin → an explicit gate-passing verdict, not a NULL that the sweeper re-picks forever');
});

test('the heal never opens a PR for an imported or unattended headless proposal', () => {
  assert.match(RECOVERY_SRC, /if \(!session\.pr_number && !imported && !session\.is_headless\)/,
    'only a human-owned native session may gain a draft PR during recovery');
});

test('the rebuilt-preview breadcrumb goes to the surface the proposal can show', () => {
  const idx = RECOVERY_SRC.indexOf("session.source === 'imported'");
  assert.ok(idx > 0, 'the breadcrumb branches on the session kind');
  assert.match(RECOVERY_SRC, /\{ type: 'session', ref: session\.id \}/,
    'imported → the discussion thread');
  assert.match(RECOVERY_SRC, /INSERT INTO chat_session_messages/,
    'native → the dev transcript, unchanged');
});
