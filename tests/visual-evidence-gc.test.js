'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const gc = require('../src/services/visual-evidence-gc');

test('recovery starts settled intent-only proposals once for their current checked head', async () => {
  const head = 'a'.repeat(40);
  const rows = [
    { id: 42, source: 'imported', imported_pr_head_sha: head, checks_commit_sha: head },
    { id: 43, source: 'imported', imported_pr_head_sha: 'b'.repeat(40), checks_commit_sha: head },
    { id: 44, source: 'imported', imported_pr_head_sha: 'short', checks_commit_sha: 'short' },
  ];
  const calls = [];
  let queryText;
  const pool = { query: async (sql) => {
    queryText = String(sql);
    return { rows };
  } };
  const result = await gc.recoverUnstarted({ visualEvidence: { execute: true } }, pool, {
    schedule: async (_config, options) => {
      calls.push(options);
      return { scheduled: true };
    },
  });
  assert.deepEqual(result, { examined: 3, scheduled: 1 });
  assert.deepEqual(calls.map(({ sessionId, headSha, trigger }) => ({ sessionId, headSha, trigger })),
    [{ sessionId: 42, headSha: head, trigger: 'planned-recovery' }]);
  assert.match(queryText, /visual_evidence_run_id IS NULL/);
  assert.match(queryText, /cs\.status IN \('active', 'promoted'\)/);
  assert.match(queryText, /cs\.check_state IN \('passing', 'failing', 'error', 'skipped'\)/);
  assert.match(queryText, /recoveryAttemptAt/);
});

test('recovery also starts an import-time author plan whose checks settled after a restart', async () => {
  const head = 'a'.repeat(40);
  const queries = [];
  const calls = [];
  const pool = { query: async (sql) => {
    queries.push(String(sql));
    return { rows: [{ id: 45, source: 'imported', imported_pr_head_sha: head,
      checks_commit_sha: head }] };
  } };
  const result = await gc.recoverUnstarted({ visualEvidence: { execute: true } }, pool, {
    schedule: async (_config, options) => { calls.push(options); return { scheduled: true }; },
  });
  assert.deepEqual(result, { examined: 1, scheduled: 1 });
  assert.equal(calls[0].sessionId, 45);
  assert.match(queries[0], /LEFT JOIN visual_evidence_runs r ON r\.id = cs\.visual_evidence_run_id/);
  assert.match(queries[0], /r\.state = 'planned' AND r\.author_plan IS NOT NULL/);
  const interrupted = [];
  await gc.recoverInterrupted({ visualEvidence: {} }, { query: async (sql) => {
    interrupted.push(String(sql));
    return { rows: [] };
  } });
  assert.match(interrupted[0], /NOT \(r\.state = 'planned' AND r\.author_plan IS NOT NULL\)/);
});

test('an unlaunchable planned claim is deferred so it cannot starve later claims', async () => {
  const head = 'a'.repeat(40);
  const writes = [];
  const pool = { query: async (sql, params) => {
    if (String(sql).startsWith('SELECT cs.id')) {
      return { rows: [{ id: 42, source: 'imported', imported_pr_head_sha: head, checks_commit_sha: head }] };
    }
    writes.push({ sql: String(sql), params });
    return { rows: [], rowCount: 1 };
  } };
  const result = await gc.recoverUnstarted({ visualEvidence: { execute: true } }, pool, {
    schedule: async () => ({ scheduled: false, reason: 'missing_base' }),
  });
  assert.deepEqual(result, { examined: 1, scheduled: 0 });
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /recoveryAttemptAt/);
  assert.equal(writes[0].params[0], 42);
});

test('a rollout-interrupted run is retried on its current head, a bounded number of times', async () => {
  const head = 'a'.repeat(40);
  const newer = 'b'.repeat(40);
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [
      { run_id: '1'.repeat(32), head_sha: head, id: 42, source: 'imported',
        imported_pr_head_sha: head, checks_commit_sha: head },
      // A newer commit owns this proposal; its own checks start evidence.
      { run_id: '2'.repeat(32), head_sha: head, id: 43, source: 'imported',
        imported_pr_head_sha: newer, checks_commit_sha: newer },
      // Someone else retried it first: the rerun is refused and skipped.
      { run_id: '3'.repeat(32), head_sha: head, id: 44, source: 'native',
        reviewed_head_sha: head, checks_commit_sha: head },
    ] };
  } };
  const reruns = [];
  const schedules = [];
  const result = await gc.retryInterrupted({ visualEvidence: { execute: true } }, pool, {
    stateService: {
      rerunSameHead: async (_pool, runId, options) => {
        reruns.push({ runId, trigger: options.trigger });
        if (runId === '3'.repeat(32)) {
          throw Object.assign(new Error('owner changed'), { code: 'stale_evidence_operation' });
        }
        return { id: '9'.repeat(32), head_sha: head, state: 'planned' };
      },
    },
    schedule: async (_config, options) => { schedules.push(options); return { scheduled: true }; },
  });
  assert.deepEqual(result, { examined: 3, scheduled: 1 });
  assert.deepEqual(reruns, [
    { runId: '1'.repeat(32), trigger: 'interrupted-retry' },
    { runId: '3'.repeat(32), trigger: 'interrupted-retry' },
  ]);
  assert.deepEqual(schedules.map(({ sessionId, headSha, trigger }) => ({ sessionId, headSha, trigger })),
    [{ sessionId: 42, headSha: head, trigger: 'interrupted-retry' }]);
  const { sql, params } = queries[0];
  assert.match(sql, /r\.failure_code = 'evidence_run_interrupted'/);
  assert.match(sql, /JOIN visual_evidence_runs r ON r\.id = cs\.visual_evidence_run_id/);
  assert.match(sql, /cs\.status NOT IN \('merged', 'archived'\)/);
  assert.match(sql, /prior\.trigger = \$3\) < \$4/);
  assert.deepEqual(params.slice(2), ['interrupted-retry', gc.MAX_INTERRUPTED_RETRIES]);
  assert.equal(gc.MAX_INTERRUPTED_RETRIES, 2);

  const disabled = await gc.retryInterrupted({ visualEvidence: { execute: false } }, {
    query: async () => { throw new Error('must not query while evidence is disabled'); },
  });
  assert.deepEqual(disabled, { examined: 0, scheduled: 0 });
});

test('recovery releases an abandoned current run while preserving longer grace for pre-heartbeat builds', async () => {
  const id = 'a'.repeat(32);
  const queries = [];
  const transitions = [];
  const pool = { query: async (sql, values) => {
    queries.push({ sql: String(sql), values });
    if (String(sql).includes("r.state IN ('planned','provisioning'")) {
      return { rows: [{ id, current_run_id: id, app_slug: 'demo' }] };
    }
    return { rows: [], rowCount: 1 };
  } };
  const result = await gc.recoverInterrupted({ visualEvidence: { maxRunMs: 120_000 } }, pool, {
    cleanup: async () => [],
    stateService: { transitionRun: async (_pool, runId, next, patch) => {
      transitions.push({ runId, next, patch });
    } },
  });
  assert.deepEqual(result, { examined: 1, failed: 1, cancelled: 0, cleanupRetried: 0 });
  assert.deepEqual(queries[0].values, [120_000, 20, gc.LEGACY_RUN_GRACE_MS]);
  assert.match(queries[0].sql, /trace_summary.*\? 'progress'/s);
  assert.deepEqual(transitions.map(({ runId, next, patch }) =>
    ({ runId, next, code: patch.failureCode, minIdleMs: patch.recoveryMinIdleMs })),
  [{ runId: id, next: 'failed', code: 'evidence_run_interrupted', minIdleMs: gc.LEGACY_RUN_GRACE_MS }]);
  assert.ok(queries.some(({ sql }) => sql.includes("'{cleanupComplete}'")));
});

test('recovery retries cleanup left unfinished by a process exit', async () => {
  const id = 'b'.repeat(32);
  const queries = [];
  let cleaned = 0;
  const pool = { query: async (sql) => {
    queries.push(String(sql));
    if (String(sql).includes("r.state IN ('failed','cancelled')")) {
      return { rows: [{ id, app_slug: 'demo' }] };
    }
    return { rows: [], rowCount: 1 };
  } };
  const result = await gc.recoverInterrupted({ visualEvidence: {} }, pool, {
    cleanup: async () => { cleaned += 1; return []; },
  });
  assert.deepEqual(result, { examined: 0, failed: 0, cancelled: 0, cleanupRetried: 1 });
  assert.equal(cleaned, 1);
  assert.ok(queries.some((sql) => sql.includes("'{cleanupComplete}'")));
});

test('recovery leaves a renewed current run and its resources untouched', async () => {
  const id = 'c'.repeat(32);
  let cleanupCalls = 0;
  const pool = { query: async (sql) => ({
    rows: String(sql).includes("r.state IN ('planned','provisioning'")
      ? [{ id, current_run_id: id, app_slug: 'demo', trace_summary: { progress: { phase: 'build_revisions' } } }]
      : [],
  }) };
  const result = await gc.recoverInterrupted({ visualEvidence: { maxRunMs: 720_000 } }, pool, {
    stateService: { transitionRun: async () => { throw Object.assign(new Error('renewed'), { code: 'evidence_run_active' }); } },
    cleanup: async () => { cleanupCalls += 1; return []; },
  });
  assert.deepEqual(result, { examined: 1, failed: 0, cancelled: 0, cleanupRetried: 0 });
  assert.equal(cleanupCalls, 0);
});

test('superseded recovery fences terminalization to its old owner and idle threshold', async () => {
  const id = 'd'.repeat(32);
  const statements = [];
  const pool = { query: async (sql, values) => {
    statements.push({ sql: String(sql), values });
    if (String(sql).includes("r.state IN ('planned','provisioning'")) {
      return { rows: [{ id, current_run_id: 'e'.repeat(32), app_slug: 'demo' }] };
    }
    return { rows: [], rowCount: 0 };
  } };
  const result = await gc.recoverInterrupted({ visualEvidence: { maxRunMs: 720_000 } }, pool, {
    cleanup: async () => { throw new Error('row was no longer stale'); },
  });
  assert.deepEqual(result, { examined: 1, failed: 0, cancelled: 0, cleanupRetried: 0 });
  const update = statements.find(({ sql }) => sql.includes("SET state = 'cancelled'"));
  assert.deepEqual(update.values, [300_000, gc.LEGACY_RUN_GRACE_MS, id]);
  assert.match(update.sql, /s\.visual_evidence_run_id IS DISTINCT FROM r\.id/);
  assert.match(update.sql, /r\.updated_at < NOW\(\)/);
});

test('retention uses configured windows and never deletes the current session-owned run', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rowCount: 0, rows: [] };
    },
  };
  await gc.prune(pool, {
    visualEvidence: { failedArtifactRetentionHours: 6, failedMetadataRetentionDays: 45 },
  });
  assert.deepEqual(calls.map((call) => call.params[0]), [6, gc.ROLLBACK_MEDIA_DAYS, 45]);
  assert.match(calls[2].sql, /NOT EXISTS[\s\S]*visual_evidence_run_id = r\.id/);
});

test('orphan checkout sweep removes only old, inactive, tightly named evidence directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-evidence-gc-test-'));
  try {
    const active = 'usernode-evidence-aaaaaaaa-active';
    const orphan = 'usernode-evidence-bbbbbbbb-orphan';
    const unrelated = 'usernode-evidence-bad';
    await Promise.all([active, orphan, unrelated].map((name) => fs.mkdir(path.join(root, name))));
    const old = new Date(Date.now() - 120_000);
    await Promise.all([active, orphan, unrelated].map((name) => fs.utimes(path.join(root, name), old, old)));
    const pool = { query: async () => ({ rows: [{ id: 'aaaaaaaa' + '0'.repeat(24) }] }) };
    const result = await gc.sweepOrphanCheckouts(pool, { maxAgeMs: 60_000, tmpDir: root });
    assert.equal(result.removed, 1);
    assert.deepEqual((await fs.readdir(root)).sort(), [active, unrelated].sort());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
