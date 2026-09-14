// The integration queue under direct-merge lanes.
//
// #2038's queue integrated ONE approved proposal per pass — a worker sync
// onto current main, a rebuild, a re-run, then the merge — and stopped,
// because each merge put every sibling one further behind. Ten clean
// proposals cost ten syncs and ten full check runs in series.
//
// What is asserted here about the two lanes that replaced that:
//
//   DIRECT LANE — a proposal that merges cleanly with main merges AS IT
//   STANDS, however far behind. Every approved clean candidate is attempted
//   in one pass, cheapest first (effortOf), with no worker turn anywhere.
//   Being behind main is not a field the ordering knows.
//
//   CONFLICT LANE — the only thing that still costs a worker turn is a
//   conflict, and it is worked one at a time, cheapest first, HELD while
//   the direct lane has work in flight (a resolution made against a main
//   about to move is a resolution made twice). Who gets a turn is rule C:
//   approved conflicts now; an unapproved head once per authored head; a
//   fork head or one the AI already failed on, never (the author acts).
//
// What survives from #2038 and is still asserted:
//   - app-level single-flight, so concurrent triggers coalesce;
//   - a sync whose machinery threw backs its candidate off, and a sync
//     already in flight is waited for rather than counted as a failure;
//   - each pass retires the 'integrating' a dead process left on a row;
//   - no GitHub mergeability polling happens anywhere.
//
// Collaborators are stubbed through require.cache, the house pattern, so
// nothing real (GitHub, the worker, docker) spins up.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { mergeGate: realMergeGate } = require('../src/services/active-users');

function stub(relPath, exports) {
  const full = require.resolve(path.join(__dirname, '..', relPath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
  return exports;
}
function unstub(relPath) {
  delete require.cache[require.resolve(path.join(__dirname, '..', relPath))];
}

function makePool(rowsBySql) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of rowsBySql) {
        if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      return { rows: [] };
    },
    issued(re) { return calls.some((c) => re.test(c.sql)); },
  };
}

const HEAD = 'h'.repeat(40);
const MAIN = 'm'.repeat(40);

// A promoted candidate at or above threshold on a 2-active-user app: clean,
// one commit behind, passing checks.
function candidate(id, yes, extra = {}) {
  return {
    id, yes_count: yes, no_count: 0, user_id: 500 + id, source: 'native',
    promoted_at: new Date(2026, 0, id), created_at: new Date(2026, 0, id),
    requires_explicit_approval: false,
    approval_epoch: 0, integration_resolved_epoch: null,
    integration_behind_by: 1, integration_merges_clean: true, integration_conflict_paths: [],
    integration_head_sha: HEAD, integration_main_sha: MAIN, integration_block_reasons: [],
    check_state: 'passing', check_phase: null,
    ...extra,
  };
}
// The same, measured conflicting in `n` files.
function conflicting(id, yes, n = 1, extra = {}) {
  return candidate(id, yes, {
    integration_merges_clean: false,
    integration_conflict_paths: Array.from({ length: n }, (_, i) => `src/f${i}.js`),
    ...extra,
  });
}

function setup({
  candidates, syncResult = 'clean', budgetError = null, merged = true,
  // What the mirror says about a session when the conflict lane re-measures
  // it. Default: agree with the columns the pass read.
  measurement = null,
  // What checkAndMerge answers for each session, when `merged` is not the
  // whole story: id -> result object.
  mergeResults = {},
  // What the worker sync does for a session, when `syncResult` is not the
  // whole story: (id) => result, or throw.
  syncImpl = null,
  // Rows the stale-'integrating' scan at the top of a pass finds.
  staleIntegrating = [],
  // What chat_sessions.active_turn->>'mode' reads for a session: id -> mode.
  activeTurnModes = {},
  // Sessions whose head lives on the author's fork.
  forkHeads = [],
  // Sessions whose pending run the stale sweeper would call overdue.
  overdueRuns = [],
}) {
  const events = {
    syncs: [], merges: [], measures: [], budget: 0, broadcasts: [], reconciles: [], spent: [],
  };
  const forks = new Set(forkHeads);
  const overdue = new Set(overdueRuns);

  const pool = makePool([
    [/FROM chat_sessions cs\s+JOIN apps a ON a\.id = cs\.app_id\s+WHERE cs\.app_id/, (p) => {
      const excludeId = p[1];
      return candidates.filter((c) => c.id !== excludeId);
    }],
    [/SELECT cs\.\*, a\.slug AS app_slug/, (p) => {
      const row = candidates.find((c) => c.id === p[0]);
      return row ? [{
        ...row, app_id: 7, status: 'promoted', app_slug: 'demo',
        repo_url: 'https://github.com/o/r', pr_number: 100 + row.id, branch_name: `b${row.id}`,
      }] : [];
    }],
    [/integration_block_reasons @> '\["integrating"\]'::jsonb/, () => staleIntegrating],
    [/SELECT active_turn->>'mode' AS mode/, (p) => [{ mode: activeTurnModes[p[0]] || null }]],
    [/approval_epoch/, []],
  ]);

  stub('src/db/pool.js', { getPool: () => pool });
  stub('src/services/github.js', { isEnabled: () => true });
  stub('src/services/limits.js', {
    async checkSystemBudget() { events.budget++; return { error: budgetError }; },
  });
  stub('src/services/ws.js', {
    pushVoteUpdate(u) { events.broadcasts.push(u); }, pushSessionUpdate() {}, async sendSystemMessage() {},
  });
  stub('src/services/sync-main.js', {
    async runSyncMain(config, pool_, id) {
      events.syncs.push(id);
      await new Promise((r) => setTimeout(r, 5));
      if (syncImpl) return syncImpl(id);
      return { ok: syncResult !== 'conflict', syncResult, sha: 'a'.repeat(40), pushOk: true };
    },
  });
  stub('src/services/integration.js', {
    async measureDeduped({ session }, opts = {}) {
      events.measures.push({ id: session.id, blockReason: opts.blockReason, opts });
      if (typeof measurement === 'function') return measurement(session);
      if (measurement) return measurement;
      return {
        behindBy: session.integration_behind_by, mergesClean: session.integration_merges_clean,
        conflictPaths: session.integration_conflict_paths || [],
        headSha: session.integration_head_sha, mainSha: session.integration_main_sha,
      };
    },
    readIntegration: () => ({}),
    async setBlockReasons(pool_, id, reasons) {
      events.measures.push({ id, blockReason: (reasons || [])[0], write: reasons || [] });
    },
    async markResolutionSpent(pool_, id) { events.spent.push(id); },
    // The real predicate: the stamp names the approval epoch it was spent in.
    resolutionSpent(s) {
      if (s.integration_resolved_epoch == null) return false;
      return Number(s.integration_resolved_epoch) === Number(s.approval_epoch || 0);
    },
  });
  stub('src/services/governance.js', {
    async getGovernance() { return { approverPolicy: 'anyone', approvalsRequired: null }; },
    async getElectorate() { return { active: 2, approverIds: null }; },
    computeGate(gov, active, yes, no, openedAt, now) {
      return realMergeGate(active, yes, no, openedAt, now || new Date(2027, 0, 1));
    },
    async qualifiedCountsBatch() { return new Map(); },
  });
  stub('src/routes/votes.js', {
    async checkAndMerge(config, pool_, session) {
      events.merges.push(session.id);
      if (mergeResults[session.id]) return mergeResults[session.id];
      return { merged, blockReason: merged ? undefined : 'checks' };
    },
    async reconcileNativeReviewedHead({ session }) {
      events.reconciles.push(session.id);
      return { enforced: true, updated: true };
    },
  });
  stub('src/services/pr-import-sync.js', {
    async reconcileImportedHead({ session }) {
      events.reconciles.push(`imported:${session.id}`);
      return { reconciled: true };
    },
  });
  stub('src/services/proposal-update.js', {
    branchHomeOf: (row) => (forks.has(row.id) ? 'user_fork' : 'app_repo'),
  });
  stub('src/services/staging-recovery.js', {
    checkRunOverdue: (row) => overdue.has(row.id),
    async recheckSessionChecks() {},
  });

  unstub('src/services/merge-queue.js');
  // eslint-disable-next-line global-require
  const queue = require('../src/services/merge-queue');
  return { queue, pool, events };
}

function teardown() {
  for (const p of [
    'src/db/pool.js', 'src/services/github.js', 'src/services/limits.js',
    'src/services/ws.js', 'src/services/sync-main.js', 'src/services/integration.js',
    'src/services/governance.js', 'src/routes/votes.js', 'src/services/pr-import-sync.js',
    'src/services/proposal-update.js', 'src/services/staging-recovery.js',
    'src/services/merge-queue.js',
  ]) unstub(p);
}

const writesFor = (events, id) => events.measures.filter((m) => m.id === id && m.write).map((m) => m.write);

// ── Direct lane ─────────────────────────────────────────────────────────

test('an approved proposal that merges cleanly merges as it stands: no worker turn', async () => {
  // One commit behind, clean. GitHub produces the merge commit the sync
  // would have pushed, so the sync is pure cost.
  const { queue, events } = setup({ candidates: [candidate(1, 2)] });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [], 'being behind main is not a reason to sync');
    assert.deepEqual(events.merges, [1]);
    assert.equal(events.budget, 0, 'and nothing was billed to the system budget');
  } finally { teardown(); }
});

test('every approved clean candidate is attempted in one pass, whatever its drift', async () => {
  // The whole point. Three clean approved siblings cost three merge calls
  // and no worker turn — not one merge per pass with a sync in between.
  const { queue, events } = setup({
    candidates: [
      candidate(1, 2, { integration_behind_by: 40 }),
      candidate(2, 5, { integration_behind_by: 0 }),
      candidate(3, 3, { integration_behind_by: 12 }),
    ],
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.merges, [2, 3, 1], 'all three, strongest preference first');
    assert.deepEqual(events.syncs, []);
  } finally { teardown(); }
});

test('a below-threshold clean proposal is neither merged nor synced', async () => {
  const { queue, events } = setup({ candidates: [candidate(1, 0)] });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, []);
    assert.deepEqual(events.merges, [], 'the gate is the group’s, not the queue’s');
  } finally { teardown(); }
});

test('concurrent triggers for one app coalesce into a single pass', async () => {
  const { queue, events } = setup({ candidates: [candidate(1, 2)] });
  try {
    await Promise.all([queue.enqueue({}, 7), queue.enqueue({}, 7), queue.enqueue({}, 7)]);
    assert.equal(events.merges.length, 1,
      'three triggers must not become three merge attempts against the same main');
  } finally { teardown(); }
});

test('direct lane order: a verdict that stands goes before one that needs its run; tally breaks ties', async () => {
  const settled = { check_state: 'passing', checks_commit_sha: HEAD, reviewed_head: HEAD };
  const { queue, events } = setup({
    candidates: [
      // Most votes, but its verdict is about an older commit: the pinned
      // head still needs its ~5 minutes before it can merge.
      candidate(1, 9, { check_state: 'passing', checks_commit_sha: 'o'.repeat(40), reviewed_head: HEAD }),
      candidate(2, 2, { integration_behind_by: 6, ...settled }),
      candidate(3, 5, { integration_behind_by: 2, ...settled }),
    ],
    // Every attempt is refused for a reason a person must fix, so the pass
    // visits the whole line and its order is observable.
    mergeResults: {
      1: { merged: false, blockReason: 'approvals' }, 2: { merged: false, blockReason: 'approvals' },
      3: { merged: false, blockReason: 'approvals' },
    },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.merges, [3, 2, 1], 'settled verdicts first (by tally), then the rebuild');
    assert.deepEqual(events.syncs, []);
  } finally { teardown(); }
});

test('effortOf: the fields, most decisive first — and drift is not one of them', () => {
  const { queue } = setup({ candidates: [] });
  try {
    const e = (row) => queue.effortOf({ checks_commit_sha: HEAD, reviewed_head: HEAD, ...row });
    // A conflict outranks any amount of rebuilding.
    assert.ok(queue.compareEffort(
      e({ integration_merges_clean: true, check_state: 'pending' }),
      e({ integration_merges_clean: false, check_state: 'passing' }),
    ) < 0);
    // A verdict that carries outranks one that needs the full run.
    assert.ok(queue.compareEffort(
      e({ integration_merges_clean: true, check_state: 'passing' }),
      e({ integration_merges_clean: true, check_state: 'pending' }),
    ) < 0);
    // 'skipped' is settled too; a verdict on an older commit is not.
    assert.equal(e({ integration_merges_clean: true, check_state: 'skipped' }).rebuild, 0);
    assert.equal(e({ integration_merges_clean: true, check_state: 'passing', checks_commit_sha: 'o'.repeat(40) }).rebuild, 1);
    // Never measured sorts between clean and conflicting.
    assert.equal(e({ integration_merges_clean: null, check_state: 'passing' }).conflict, 1);
    // Being behind main costs nothing and is not a field.
    const far = e({ integration_merges_clean: true, integration_behind_by: 400, check_state: 'passing' });
    const near = e({ integration_merges_clean: true, integration_behind_by: 0, check_state: 'passing' });
    assert.equal(queue.compareEffort(far, near), 0);
    assert.equal('behind' in far, false);
    // Among conflicts, the smaller one is cheaper.
    assert.ok(queue.compareEffort(
      e({ integration_merges_clean: false, integration_conflict_paths: ['a'], check_state: 'passing' }),
      e({ integration_merges_clean: false, integration_conflict_paths: ['a', 'b', 'c'], check_state: 'passing' }),
    ) < 0);
  } finally { teardown(); }
});

test('a run in flight for the pinned head is waited for, not merged around', async () => {
  // Its finalizer enqueues the app when it reports. A deferred row is NOT
  // in flight (nothing was started for it), and an overdue one belongs to
  // the sweeper — both are attempted, and checkAndMerge kicks their run.
  const pending = { check_state: 'pending', checks_commit_sha: HEAD, reviewed_head: HEAD };
  const { queue, events } = setup({
    candidates: [
      candidate(1, 5, pending),
      candidate(2, 4, { ...pending, check_phase: 'deferred' }),
      candidate(3, 3, pending),
    ],
    overdueRuns: [3],
    mergeResults: {
      2: { merged: false, blockReason: 'checks', checkState: 'pending' },
      3: { merged: false, blockReason: 'checks', checkState: 'pending' },
    },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.merges, [2, 3], 'the live run is left alone; deferred and overdue are attempted');
  } finally { teardown(); }
});

test('a locked app with no admin yes is not attempted; with one, it is', async () => {
  const { queue, events } = setup({
    candidates: [
      candidate(1, 2, { app_locked: true, admin_yes: false }),
      candidate(2, 5, { app_locked: true, admin_yes: true }),
    ],
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.merges, [2], 'the lock gate is exactly the admin’s say-so');
  } finally { teardown(); }
});

test('checks that failed against the pinned commit are not attempted; on an older commit they are', async () => {
  const { queue, events } = setup({
    candidates: [
      // Failing on THIS commit: only the author can change that.
      candidate(1, 5, { check_state: 'failing', checks_commit_sha: HEAD, reviewed_head: HEAD }),
      // Failing on an OLDER commit: the pinned head still needs its run,
      // which the checks gate kicks.
      candidate(2, 4, { check_state: 'failing', checks_commit_sha: 'o'.repeat(40), reviewed_head: HEAD }),
      candidate(3, 3, { check_state: 'error', checks_commit_sha: HEAD, reviewed_head: HEAD }),
    ],
    mergeResults: { 2: { merged: false, blockReason: 'checks', checkState: 'pending' } },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.merges, [2]);
  } finally { teardown(); }
});

test('a pass does not stop after a merge: the next candidate is measured by its own gate', async () => {
  // #2038 stopped after one merge because the next candidate needed a sync
  // against the new main. Nothing here needs a sync; checkAndMerge measures
  // each head against the main of the moment, and GitHub's exact-sha merge
  // is the guard behind that.
  const { queue, events } = setup({
    candidates: [candidate(1, 2), candidate(2, 5), candidate(3, 3)],
    mergeResults: { 2: { merged: true }, 3: { merged: true }, 1: { merged: true } },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.merges, [2, 3, 1]);
    const told = events.broadcasts.filter((b) => b.merged).map((b) => b.sessionId);
    assert.deepEqual(told, [2, 3, 1], 'each merge is announced');
  } finally { teardown(); }
});

// ── Conflict lane ───────────────────────────────────────────────────────

test('an approved conflict gets a resolution turn, then the new head is measured, re-pinned and merged', async () => {
  const { queue, events } = setup({ candidates: [conflicting(1, 2)] });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1], 'exactly one worker turn');
    assert.equal(events.budget, 1, 'billed to the system budget');
    assert.deepEqual(writesFor(events, 1), [['integrating'], []],
      'announced, then cleared again before the row is handed to the merge attempt');
    const remeasure = events.measures.filter((m) => m.id === 1 && m.opts).pop();
    assert.deepEqual(remeasure.opts.blockReasons, [],
      'the post-resolution measurement does not carry the stale reason forward');
    assert.deepEqual(events.reconciles, [1], 'the pushed head becomes the reviewed revision and gets its run');
    assert.deepEqual(events.merges, [1]);
    const last = events.broadcasts.filter((b) => b.sessionId === 1 && 'integrating' in b).pop();
    assert.equal(last.integrating, false, 'the card is told the sync is over');
  } finally { teardown(); }
});

test('the conflict lane holds while the direct lane has work in flight', async () => {
  // A resolution made against a main that is about to move is a resolution
  // made twice. The run's finalizer re-kicks the queue when it reports.
  const { queue, events } = setup({
    candidates: [
      candidate(1, 5, { check_state: 'pending', checks_commit_sha: HEAD, reviewed_head: HEAD }),
      conflicting(2, 2),
    ],
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.merges, [], 'the live run is waited for');
    assert.deepEqual(events.syncs, [], 'and no resolution is started under it');
  } finally { teardown(); }
});

test('a direct attempt that stopped at a pending run also holds the conflict lane', async () => {
  const { queue, events } = setup({
    candidates: [candidate(1, 5, { check_state: 'passing', checks_commit_sha: 'o'.repeat(40), reviewed_head: HEAD }), conflicting(2, 2)],
    mergeResults: { 1: { merged: false, blockReason: 'checks', checkState: 'pending' } },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.merges, [1], 'attempted; its gate kicked the run');
    assert.deepEqual(events.syncs, [], 'the resolution waits for that run to report');
  } finally { teardown(); }
});

test('a direct attempt refused for a reason a person must fix does not hold the conflict lane', async () => {
  const { queue, events } = setup({
    candidates: [candidate(1, 5), conflicting(2, 2)],
    mergeResults: { 1: { merged: false, blockReason: 'approvals' } },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.merges, [1, 2]);
    assert.deepEqual(events.syncs, [2], 'nothing is about to move main, so the resolution goes');
  } finally { teardown(); }
});

test('conflicts are resolved one at a time: approved first, then the smaller conflict, then tally', async () => {
  const { queue, events } = setup({
    candidates: [
      conflicting(1, 2, 3),           // approved, three files
      conflicting(2, 5, 1),           // approved, one file — cheapest approved
      conflicting(3, 0, 1),           // not approved, first conflict of its head
    ],
    mergeResults: { 2: { merged: false, blockReason: 'approvals' } },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2], 'one resolution per pass; the rest wait for the next trigger');
  } finally { teardown(); }
});

test('rule C: an unapproved head gets one resolution per authored head, then waits for the vote', async () => {
  const row = conflicting(1, 0);
  const { queue, events } = setup({ candidates: [row] });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1], 'first conflict of this head: resolved so voters review a mergeable head');
    assert.deepEqual(events.spent, [1], 'and the resolution is stamped when it is DISPATCHED');
    assert.deepEqual(events.reconciles, [1], 'the new head is pinned and its run started');
    assert.deepEqual(events.merges, [], 'no merge attempt: the group has not said yes');

    // The stamp landed; the head conflicts again (a sibling merged).
    row.integration_resolved_epoch = 0;
    events.syncs.length = 0;
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [], 'no second turn on the platform’s dime');
    assert.ok(writesFor(events, 1).some((w) => w.includes('awaiting_approval')),
      'the card says the vote is what it is waiting for');

    // The author pushes: a new authored head, a new epoch, its own one chance.
    row.approval_epoch = 1;
    row.integration_head_sha = 'n'.repeat(40);
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1]);
  } finally { teardown(); }
});

test('rule C: approval admits a head whose pre-approval resolution was already spent', async () => {
  const { queue, events } = setup({
    candidates: [conflicting(1, 2, 1, { integration_resolved_epoch: 0 })],
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1], 'the group said yes; the platform’s job is to land it');
    assert.deepEqual(events.spent, [], 'nothing to stamp: this is not the pre-approval resolution');
  } finally { teardown(); }
});

test('a head on the author’s fork is never resolved by the platform', async () => {
  const { queue, events } = setup({ candidates: [conflicting(1, 5)], forkHeads: [1] });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [], 'there is nowhere to push a resolution');
    assert.ok(writesFor(events, 1).some((w) => w.includes('fork_head')), 'the author is told it is theirs');
  } finally { teardown(); }
});

test('a conflict the AI could not resolve is not asked again until the head or main moves', async () => {
  const row = conflicting(1, 2);
  const { queue, events } = setup({ candidates: [row], syncResult: 'conflict' });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1]);
    assert.deepEqual(events.merges, [], 'nothing to merge');
    assert.ok(events.measures.some((m) => m.blockReason === 'integrating'), 'it announced it was working on it');
    assert.ok(writesFor(events, 1).some((w) => w.includes('unresolvable')), 'and then that it could not');

    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1], 'the same question is not asked twice at the same price');

    // Main moved: it is a new question.
    row.integration_main_sha = 'x'.repeat(40);
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1, 1]);
  } finally { teardown(); }
});

test('failing checks on the pinned head are not worth a resolution either', async () => {
  const { queue, events } = setup({
    candidates: [conflicting(1, 5, 1, { check_state: 'failing', checks_commit_sha: HEAD, reviewed_head: HEAD })],
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [], 'the author has to push anyway; that push gets its own chance');
  } finally { teardown(); }
});

test('a head that is clean again sheds the conflict lane’s reasons', async () => {
  const { queue, events } = setup({
    candidates: [candidate(1, 0, { integration_block_reasons: ['awaiting_approval'] })],
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(writesFor(events, 1), [[]], 'nothing is holding it now but the vote itself');
  } finally { teardown(); }
});

test('conflictAdmission, as the merge gate and the card read it', () => {
  const { queue } = setup({ candidates: [] });
  try {
    // `approved` is the line's own field (the governance gate), not a column.
    const a = (row) => queue.conflictAdmission(row);
    assert.deepEqual(a({ ...conflicting(1, 2), approved: true }), { admit: true, reason: 'approved' });
    assert.deepEqual(a({ ...conflicting(2, 0), approved: false }), { admit: true, reason: 'first_conflict' });
    assert.deepEqual(a({ ...conflicting(3, 0), approved: false, integration_resolved_epoch: 0 }),
      { admit: false, reason: 'awaiting_approval' });
    assert.deepEqual(a({ ...conflicting(4, 2), approved: true, integration_resolved_epoch: 0 }),
      { admit: true, reason: 'approved' });
    // Under a lock the admin is the approver still to come, so the one
    // pre-approval resolution applies; spent, the card names the lock.
    assert.deepEqual(a({ ...conflicting(5, 2), approved: true, app_locked: true, admin_yes: false }),
      { admit: true, reason: 'first_conflict' });
    assert.deepEqual(a({ ...conflicting(5, 2), approved: true, app_locked: true, admin_yes: false, integration_resolved_epoch: 0 }),
      { admit: false, reason: 'lock' });
    queue.noteResolutionGaveUp(6, HEAD, MAIN);
    assert.deepEqual(a({ ...conflicting(6, 2), approved: true }), { admit: false, reason: 'unresolvable' });
    assert.deepEqual(a({ ...conflicting(6, 2), approved: true, integration_head_sha: 'n'.repeat(40) }),
      { admit: true, reason: 'approved' }, 'a moved head is a new question');
  } finally { teardown(); }
});

test('an exhausted system budget skips the resolution and records why', async () => {
  const { queue, events } = setup({
    candidates: [conflicting(1, 2)], budgetError: 'system token budget exhausted',
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [], 'no worker turn is dispatched over the cap');
    assert.ok(events.measures.some((m) => m.blockReason === 'budget'),
      'the card should say the platform is out of budget, not that nothing is wrong');
  } finally { teardown(); }
});

test('a conflict that measures clean by the time its turn comes goes to the merge instead', async () => {
  // The columns are a sweep old; a sibling's merge (or the author's push)
  // changed the answer. The mirror is asked before any turn is spent.
  const { queue, events } = setup({
    candidates: [conflicting(1, 2)],
    measurement: { behindBy: 3, mergesClean: true, conflictPaths: [], headSha: HEAD, mainSha: MAIN },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [], 'nothing to resolve');
    assert.deepEqual(events.merges, [1]);
  } finally { teardown(); }
});

test('an imported proposal’s resolved head is reconciled by the import path', async () => {
  const { queue, events } = setup({ candidates: [conflicting(1, 2, 1, { source: 'imported' })] });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1]);
    assert.deepEqual(events.reconciles, ['imported:1']);
  } finally { teardown(); }
});

// ── Sync failures ───────────────────────────────────────────────────────

test('a sync whose machinery threw backs its candidate off; the rest of the line moves', async () => {
  // #2102's worker could not mount its volume. Every pass sat through the
  // warm-ready timeout to find that out again, with every sibling behind it.
  const failing = new Error('worker warm-ready timeout');
  const { queue, events } = setup({
    candidates: [conflicting(1, 5), conflicting(2, 2)],
    syncImpl: (id) => {
      if (id === 1) throw failing;
      return { ok: true, syncResult: 'clean', sha: 'a'.repeat(40), pushOk: true };
    },
    mergeResults: { 2: { merged: false, blockReason: 'approvals' } },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1, 2], 'the failure did not stop the sibling being tried');
    assert.deepEqual(writesFor(events, 1), [['integrating'], []], 'the flag does not outlive the failed turn');

    const remaining = queue.syncBackoffRemaining(1);
    assert.ok(remaining > 0 && remaining <= 2 * 60 * 1000, `first failure: two minutes, got ${remaining}`);

    // The very next trigger does not pay for the same timeout again.
    events.syncs.length = 0;
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2], 'the backed-off candidate is skipped, not retried');

    // Once the window is over it is tried again, and the wait doubles.
    queue._syncBackoff.get(1).until = Date.now() - 1;
    events.syncs.length = 0;
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1, 2]);
    assert.equal(queue._syncBackoff.get(1).failures, 2);
    assert.ok(queue.syncBackoffRemaining(1) > 2 * 60 * 1000, 'doubled');
  } finally { teardown(); }
});

test('backoff: doubles from two minutes to a half-hour ceiling, and a completed sync clears it', async () => {
  const now = 1_000_000;
  const { queue, events } = setup({
    candidates: [conflicting(1, 2)],
    mergeResults: { 1: { merged: false, blockReason: 'approvals' } },
  });
  try {
    const waits = [];
    for (let i = 0; i < 6; i++) {
      const e = queue.noteSyncFailure(1, new Error('down'), now);
      waits.push(e.until - now);
    }
    assert.deepEqual(waits.map((w) => w / 60000), [2, 4, 8, 16, 30, 30]);
    assert.equal(queue.syncBackoffRemaining(1, now + 30 * 60000), 0, 'an expired window reads as none');
    assert.equal(queue._syncBackoff.get(1).failures, 6,
      'but the count stays, so a candidate that keeps failing does not start again from two minutes');

    queue._syncBackoff.get(1).until = Date.now() - 1;
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1]);
    assert.equal(queue._syncBackoff.has(1), false,
      'a sync that ran to an answer is proof the machinery works');
  } finally { teardown(); }
});

const inFlightGuard = (id) => Object.assign(
  new Error(`execInWorker: a turn is already in flight for session ${id}`), { code: 'TURN_IN_FLIGHT' }
);

test('a sync already in flight for the candidate is a wait, not a failure', async () => {
  // After a restart, the process resumes the interrupted sync turn from its
  // journal a few seconds before the startup drain asks for the same
  // proposal. The worker refuses the second dispatch.
  const { queue, events } = setup({
    candidates: [conflicting(1, 5), conflicting(2, 2)],
    syncImpl: (id) => {
      if (id === 1) throw inFlightGuard(1);
      return { ok: true, syncResult: 'clean', sha: 'a'.repeat(40), pushOk: true };
    },
    activeTurnModes: { 1: 'sync' },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1], 'the pass stops: the running sync hands back to the queue');
    assert.deepEqual(events.merges, []);
    assert.deepEqual(writesFor(events, 1), [['integrating']], 'the row IS integrating; the flag stands');
    assert.equal(queue.syncBackoffRemaining(1), 0, 'and nothing is held against it');
  } finally { teardown(); }
});

test("someone else's turn in flight on the branch is left to finish; the line moves on", async () => {
  const { queue, events } = setup({
    candidates: [conflicting(1, 5), conflicting(2, 2)],
    syncImpl: (id) => {
      if (id === 1) throw inFlightGuard(1);
      return { ok: true, syncResult: 'clean', sha: 'a'.repeat(40), pushOk: true };
    },
    activeTurnModes: { 1: 'build' },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1, 2], 'the sibling is tried');
    assert.deepEqual(writesFor(events, 1), [['integrating'], []], 'the row is not integrating, so it does not say so');
    assert.equal(queue.syncBackoffRemaining(1), 0, 'and nothing is held against it');
  } finally { teardown(); }
});

// ── Housekeeping ────────────────────────────────────────────────────────

test("a pass first retires the 'integrating' a dead process left behind", async () => {
  const { queue, events, pool } = setup({
    candidates: [],
    staleIntegrating: [
      { id: 41, integration_block_reasons: ['integrating'] },
      { id: 42, integration_block_reasons: ['integrating', 'budget'] },
    ],
  });
  try {
    await queue.enqueue({}, 7);
    const writes = events.measures.filter((m) => m.write).map((m) => [m.id, m.write]);
    assert.deepEqual(writes, [[41, []], [42, ['budget']]], 'only the stale word goes; other reasons stay');
    const told = events.broadcasts.filter((b) => b.integrating === false).map((b) => b.sessionId);
    assert.deepEqual(told, [41, 42]);
    assert.ok(events.broadcasts.every((b) => b.appId === 7), 'scoped to the app');
    const scan = pool.calls.find((c) => /integration_block_reasons @>/.test(c.sql));
    assert.match(scan.sql, /active_turn->>'mode', ''\) <> 'sync'/,
      'a row the previous process was syncing when it died keeps its flag for the resume');
  } finally { teardown(); }
});

test('no GitHub mergeability polling happens anywhere in a pass', async () => {
  const { queue } = setup({ candidates: [candidate(1, 2), conflicting(2, 3)] });
  try {
    const github = require('../src/services/github');
    assert.equal(typeof github.getOctokit, 'undefined',
      'the stub exposes no octokit, so any polling attempt would throw');
    await queue.enqueue({}, 7);
  } finally { teardown(); }
});
