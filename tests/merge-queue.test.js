// The integration queue (#2038), which replaced the two-phase conflict drain.
//
// What survives from the drain and is asserted here:
//   - app-level single-flight, so concurrent triggers coalesce into one pass
//     instead of N parallel worker syncs against the same main;
//   - eligibility, so a worker turn is only ever spent on a proposal the
//     group has actually approved;
//   - the vote tally as the tie-break in the ordering.
//
// What changed and is asserted here:
//   - cheapest-first ordering (effortOf): among approved candidates, the one
//     with the least sync and rebuild in front of it goes first, because
//     every merge puts the rest of the line one further behind;
//   - a sync whose machinery threw backs its candidate off, and a sync
//     already in flight is waited for rather than counted as a failure;
//   - each pass retires the 'integrating' a dead process left on a row.
//   - a proposal that cannot be resolved LEAVES the queue instead of being
//     carried into a second phase, because holding the app's queue open for
//     something only its author can fix blocks every sibling behind it;
//   - no GitHub mergeability polling happens at all. The old path could spend
//     fourteen reads and ~30s asking a lazily-computed field a question the
//     mirror answers exactly, before the call.
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

// A promoted candidate at or above threshold on a 2-active-user app.
function candidate(id, yes, extra = {}) {
  return {
    id, yes_count: yes, no_count: 0,
    promoted_at: new Date(2026, 0, id), created_at: new Date(2026, 0, id),
    requires_explicit_approval: false,
    integration_behind_by: 1, integration_merges_clean: true, check_state: 'passing',
    ...extra,
  };
}

function setup({
  candidates, syncResult = 'clean', budgetError = null, merged = true,
  measurement = { behindBy: 1, mergesClean: true, conflictPaths: [] },
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
}) {
  const events = { syncs: [], merges: [], measures: [], budget: 0, broadcasts: [] };

  const pool = makePool([
    // Honour the query's own exclusions, or the queue would be handed the
    // same candidate forever — which is exactly the spin the production loop
    // now guards against independently.
    [/FROM chat_sessions cs\s+JOIN apps a ON a\.id = cs\.app_id\s+WHERE cs\.app_id/, (p) => {
      const excludeId = p[1];
      const attempted = new Set(p[2] || []);
      return candidates.filter((c) => c.id !== excludeId && !attempted.has(c.id));
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
      return typeof measurement === 'function' ? measurement(session) : measurement;
    },
    readIntegration: () => ({}),
    async setBlockReasons(pool_, id, reasons) {
      events.measures.push({ id, blockReason: (reasons || [])[0], write: reasons || [] });
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
    'src/services/governance.js', 'src/routes/votes.js', 'src/services/merge-queue.js',
  ]) unstub(p);
}

test('an eligible proposal is integrated, then merged', async () => {
  const { queue, events } = setup({ candidates: [candidate(1, 2)] });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1], 'the behind proposal gets exactly one worker sync');
    assert.deepEqual(events.merges, [1]);
  } finally { teardown(); }
});

test('a below-threshold proposal never costs a worker turn', async () => {
  // The queue spends real tokens. Measurement is universal and free; only
  // INTEGRATION is gated on the group having actually approved the change.
  const { queue, events } = setup({ candidates: [candidate(1, 0)] });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [], 'no sync for a proposal nobody approved');
    assert.deepEqual(events.merges, []);
  } finally { teardown(); }
});

test('concurrent triggers for one app coalesce into a single pass', async () => {
  const { queue, events } = setup({ candidates: [candidate(1, 2)] });
  try {
    await Promise.all([queue.enqueue({}, 7), queue.enqueue({}, 7), queue.enqueue({}, 7)]);
    assert.equal(events.syncs.length, 1,
      'three triggers must not become three worker syncs against the same main');
  } finally { teardown(); }
});

test('between candidates that cost the same, the highest-voted goes first', async () => {
  const { queue, events } = setup({ candidates: [candidate(1, 2), candidate(2, 5)] });
  try {
    await queue.enqueue({}, 7);
    assert.equal(events.syncs[0], 2, 'the group’s strongest preference is integrated first');
  } finally { teardown(); }
});

test('the candidate with the least work in front of it goes first, whatever its tally', async () => {
  // The afternoon #2104 landed, the platform app's line read: a proposal that
  // CONFLICTED with main (an AI resolution turn), then one whose worker could
  // not come up, then one two commits behind with passing checks on its
  // pinned head. Each merge restarts the platform and puts every sibling one
  // further behind, so the order the line is worked in decides how many
  // syncs and rebuilds the whole board costs.
  const head = 'h'.repeat(40);
  const settled = { check_state: 'passing', checks_commit_sha: head, reviewed_head: head };
  const { queue, events } = setup({
    candidates: [
      // Most votes, but conflicts: the most expensive thing the queue does.
      candidate(1, 9, { integration_merges_clean: false, integration_behind_by: 4, ...settled }),
      // Clean, verdict carries, six commits of sync.
      candidate(2, 2, { integration_behind_by: 6, ...settled }),
      // Clean, verdict carries, two commits of sync — the cheapest.
      candidate(3, 2, { integration_behind_by: 2, ...settled }),
      // Already on main but its run is still going: nothing merges before it
      // reports, and a sibling's merge would only supersede that run.
      candidate(4, 7, { integration_behind_by: 0, check_state: 'pending', checks_commit_sha: head, reviewed_head: head }),
    ],
    // Every merge attempt is refused for a reason a person must fix, so the
    // pass visits the whole line and its order is observable.
    mergeResults: {
      1: { merged: false, blockReason: 'approvals' }, 2: { merged: false, blockReason: 'approvals' },
      3: { merged: false, blockReason: 'approvals' }, 4: { merged: false, blockReason: 'approvals' },
    },
    // The mirror agrees with the columns the ordering read.
    measurement: (s) => ({
      behindBy: s.integration_behind_by, mergesClean: s.integration_merges_clean !== false, conflictPaths: [],
    }),
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.merges, [3, 2, 4, 1],
      'cheapest sync first, then the one that needs a rebuild, then the conflict');
    assert.deepEqual(events.syncs, [3, 2, 1], 'the row already on main costs no sync');
  } finally { teardown(); }
});

test('effortOf: the fields, most decisive first', () => {
  const { queue } = setup({ candidates: [] });
  try {
    const head = 'h'.repeat(40);
    const e = (row) => queue.effortOf({ checks_commit_sha: head, reviewed_head: head, ...row });
    // A conflict outranks any amount of drift or rebuilding.
    assert.ok(queue.compareEffort(
      e({ integration_merges_clean: true, integration_behind_by: 40, check_state: 'pending' }),
      e({ integration_merges_clean: false, integration_behind_by: 0, check_state: 'passing' }),
    ) < 0);
    // A verdict that carries outranks a shorter sync that needs the full run.
    assert.ok(queue.compareEffort(
      e({ integration_merges_clean: true, integration_behind_by: 5, check_state: 'passing' }),
      e({ integration_merges_clean: true, integration_behind_by: 1, check_state: 'pending' }),
    ) < 0);
    // 'skipped' is settled too; a verdict on an older commit is not.
    assert.equal(e({ integration_merges_clean: true, check_state: 'skipped' }).rebuild, 0);
    assert.equal(e({ integration_merges_clean: true, check_state: 'passing', checks_commit_sha: 'o'.repeat(40) }).rebuild, 1);
    // Never measured sorts between clean and conflicting, and after any
    // measured drift.
    const unmeasured = e({ integration_merges_clean: null, integration_behind_by: null, check_state: 'passing' });
    assert.equal(unmeasured.conflict, 1);
    assert.equal(unmeasured.behind, Number.MAX_SAFE_INTEGER);
  } finally { teardown(); }
});

test('an unresolvable conflict leaves the queue instead of holding it open', async () => {
  const { queue, events } = setup({
    candidates: [candidate(1, 2), candidate(2, 5)], syncResult: 'conflict',
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2, 1],
      'the blocked proposal must not stop its sibling being attempted');
    assert.deepEqual(events.merges, [], 'neither merges, but both were tried');
    // The queue does NOT restate the conflict. It is derivable by the card
    // from merge_conflict_state, which the sync turn just wrote — and the
    // server only reports what the browser cannot work out for itself.
    assert.ok(events.measures.some((m) => m.blockReason === 'integrating'),
      'it announced it was working on it');
    assert.ok(!events.measures.some((m) => m.blockReason === 'conflict'),
      'and did not duplicate a reason the card derives itself');
  } finally { teardown(); }
});

test('an exhausted system budget skips the sync and records why', async () => {
  const { queue, events } = setup({
    candidates: [candidate(1, 2)], budgetError: 'system token budget exhausted',
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [], 'no worker turn is dispatched over the cap');
    assert.ok(events.measures.some((m) => m.blockReason === 'budget'),
      'the card should say the platform is out of budget, not that nothing is wrong');
  } finally { teardown(); }
});

test('a proposal already on main skips straight to the merge', async () => {
  const { queue, events } = setup({
    candidates: [candidate(1, 2, { integration_behind_by: 0 })],
    measurement: { behindBy: 0, mergesClean: true, conflictPaths: [] },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [], 'nothing to integrate, so nothing to spend');
    assert.deepEqual(events.merges, [1]);
  } finally { teardown(); }
});

// ── #2100 / #2095 ─────────────────────────────────────────────────────

test('a pass stops after a merge: the siblings are re-measured against the NEW main', async () => {
  // Carrying on was the thundering herd: one merge, then every sibling
  // synced and rebuilt in a row, each to be synced and rebuilt again once
  // the next one landed. finalizeMerge re-kicks the queue; that fresh pass
  // sees the moved main.
  const { queue, events } = setup({ candidates: [candidate(1, 2), candidate(2, 5), candidate(3, 3)] });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2], 'exactly one worker turn per landed merge');
    assert.deepEqual(events.merges, [2]);
  } finally { teardown(); }
});

test('a pass stops while a check run is in flight for the current candidate', async () => {
  // Nothing merges before that run reports, and the checks finalizer
  // enqueues the app the moment it does. Syncing the next candidate now
  // would only put it behind whatever this one merges.
  const { queue, events } = setup({
    candidates: [candidate(1, 2), candidate(2, 5)],
    mergeResults: { 2: { merged: false, blockReason: 'checks', checkState: 'pending' } },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2]);
    assert.deepEqual(events.merges, [2]);
  } finally { teardown(); }
});

test('a candidate refused for a reason a person must fix does not stop the pass', async () => {
  const { queue, events } = setup({
    candidates: [candidate(1, 2), candidate(2, 5)],
    mergeResults: {
      2: { merged: false, blockReason: 'checks', checkState: 'failing' },
      1: { merged: false, blockReason: 'approvals' },
    },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2, 1], 'the sibling still gets its turn');
    assert.deepEqual(events.merges, [2, 1]);
  } finally { teardown(); }
});

test('a locked app with no admin yes is not worth a worker turn', async () => {
  // The lock gate is the admin's say-so; integrating ahead of it spends
  // tokens on a change that may never merge, and the admin's own vote
  // enqueues the app when it lands.
  const { queue, events } = setup({
    candidates: [
      candidate(1, 2, { app_locked: true, admin_yes: false }),
      candidate(2, 5, { app_locked: true, admin_yes: true }),
    ],
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2], 'only the admin-approved one is integrated');
  } finally { teardown(); }
});

test('checks that failed against the pinned commit are not worth a worker turn either', async () => {
  const head = 'h'.repeat(40);
  const { queue, events } = setup({
    candidates: [
      // Failing on THIS commit: a merge of main into it changes nothing.
      candidate(1, 5, { check_state: 'failing', checks_commit_sha: head, reviewed_head: head }),
      // Failing on an OLDER commit: the pinned head still needs its rebuild,
      // which the checks gate kicks — so the sync goes ahead.
      candidate(2, 4, { check_state: 'failing', checks_commit_sha: 'o'.repeat(40), reviewed_head: head }),
      candidate(3, 3, { check_state: 'error', checks_commit_sha: head, reviewed_head: head }),
    ],
    mergeResults: { 2: { merged: false, blockReason: 'checks', checkState: 'pending' } },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2]);
  } finally { teardown(); }
});

test("'integrating' is cleared the moment the sync is over, whatever the merge attempt decides", async () => {
  // checkAndMerge only clears it on a successful claim, so a row whose merge
  // then stopped at approvals kept a card that said "syncing with main"
  // long after the sync had finished — the UI half of #2100.
  const { queue, events } = setup({
    candidates: [candidate(1, 2)],
    mergeResults: { 1: { merged: false, blockReason: 'approvals' } },
  });
  try {
    await queue.enqueue({}, 7);
    const writes = events.measures.filter((m) => m.id === 1 && m.write).map((m) => m.write);
    assert.deepEqual(writes, [['integrating'], []],
      'announced, then cleared again — before the row is handed to the merge attempt');
    const remeasure = events.measures.filter((m) => m.id === 1 && m.opts).pop();
    assert.deepEqual(remeasure.opts.blockReasons, [],
      'and the post-sync measurement does not carry the stale reason forward');
    assert.deepEqual(events.merges, [1]);
    const last = events.broadcasts.filter((b) => b.sessionId === 1 && 'integrating' in b).pop();
    assert.equal(last.integrating, false, 'the card is told the sync is over');
  } finally { teardown(); }
});

test('a sync whose machinery threw backs its candidate off; the rest of the line moves', async () => {
  // #2102's worker could not mount its volume. Every pass sat through the
  // warm-ready timeout to find that out again, with every sibling behind it.
  const failing = new Error('worker warm-ready timeout');
  const { queue, events } = setup({
    candidates: [candidate(1, 5), candidate(2, 2)],
    syncImpl: (id) => {
      if (id === 1) throw failing;
      return { ok: true, syncResult: 'clean', sha: 'a'.repeat(40), pushOk: true };
    },
    mergeResults: { 2: { merged: false, blockReason: 'approvals' } },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1, 2], 'the failure did not stop the sibling being tried');
    const writes = events.measures.filter((m) => m.id === 1 && m.write).map((m) => m.write);
    assert.deepEqual(writes, [['integrating'], []], 'the flag does not outlive the failed turn');

    const remaining = queue.syncBackoffRemaining(1);
    assert.ok(remaining > 0 && remaining <= 2 * 60 * 1000, `first failure: two minutes, got ${remaining}`);

    // The very next trigger — a vote, the sweep, the cascade of a sibling's
    // merge — does not pay for the same timeout again.
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
  let now = 1_000_000;
  const { queue, events } = setup({
    candidates: [candidate(1, 2)],
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
  // proposal. The worker refuses the second dispatch — and that refusal used
  // to be logged as "sync turn threw", clear 'integrating' under a live
  // sync, and send the pass on to sync the next sibling.
  const { queue, events } = setup({
    candidates: [candidate(1, 5), candidate(2, 2)],
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
    const writes = events.measures.filter((m) => m.id === 1 && m.write).map((m) => m.write);
    assert.deepEqual(writes, [['integrating']], 'the row IS integrating; the flag stands');
    assert.equal(queue.syncBackoffRemaining(1), 0, 'and nothing is held against it');
  } finally { teardown(); }
});

test("someone else's turn in flight on the branch is left to finish; the line moves on", async () => {
  // The same refusal from the worker, but the durable record says the turn
  // is a build — the author is working in the dev chat. Not integrating,
  // not broken.
  const { queue, events } = setup({
    candidates: [candidate(1, 5), candidate(2, 2)],
    syncImpl: (id) => {
      if (id === 1) throw inFlightGuard(1);
      return { ok: true, syncResult: 'clean', sha: 'a'.repeat(40), pushOk: true };
    },
    activeTurnModes: { 1: 'build' },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1, 2], 'the sibling is tried');
    const writes = events.measures.filter((m) => m.id === 1 && m.write).map((m) => m.write);
    assert.deepEqual(writes, [['integrating'], []], "the row is not integrating, so it does not say so");
    assert.equal(queue.syncBackoffRemaining(1), 0, 'and nothing is held against it');
  } finally { teardown(); }
});

test("a pass first retires the 'integrating' a dead process left behind", async () => {
  // Three restarts in an afternoon left six cards saying "bringing up to
  // date with main" with one sync running. A row whose durable turn record
  // is a sync is excluded by the query itself (it is about to be resumed);
  // one this process is integrating right now is excluded here.
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
  // The deleted loops were the single largest source of latency in the old
  // path: up to fourteen reads and ~30s of sleeping per cycle.
  const { queue } = setup({ candidates: [candidate(1, 2)] });
  try {
    const github = require('../src/services/github');
    assert.equal(typeof github.getOctokit, 'undefined',
      'the stub exposes no octokit, so any polling attempt would throw');
    await queue.enqueue({}, 7);
  } finally { teardown(); }
});
