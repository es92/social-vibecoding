// Regression guard for the setChecksPending "inconsistent types deduced
// for parameter $2" bug (session 2258 investigation, 2026-07-14).
//
// The UPDATE splices $2 into both an assignment to checks_commit_sha
// (varchar) and IS DISTINCT FROM comparisons (where postgres infers
// text). Without an explicit cast on EVERY occurrence, postgres refuses
// to prepare the statement — "inconsistent types deduced for parameter
// $2: text versus character varying" — and because every call site
// .catch'es this as non-fatal, the pending stamp silently never landed:
// stale 'passing'/'error' verdicts survived into the merge gate while a
// rebuild was in flight, and the failure-streak bookkeeping never reset
// on new commits.
//
// We can't run a real postgres PREPARE in the unit suite, so this pins
// the property that triggers the planner error: every `$2` reference in
// the emitted SQL must carry the same explicit ::text cast.
//
// Run with: node --test tests/set-checks-pending.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const visuals = require('../src/services/visuals');

test('setChecksPending: every $2 occurrence is explicitly cast (uniform type for the planner)', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };

  await visuals.setChecksPending(pool, 42, 'abc123');

  assert.equal(queries.length, 1);
  const { sql, params } = queries[0];

  const occurrences = sql.match(/\$2(::\w+)?/g) || [];
  assert.ok(occurrences.length >= 5, `expected $2 in assignment + 4 CASE clauses, saw ${occurrences.length}`);
  const uncast = occurrences.filter((o) => o === '$2');
  assert.deepEqual(uncast, [],
    'every $2 must carry an explicit cast — a bare $2 next to checks_commit_sha (varchar) ' +
    'plus a text-inferred comparison makes postgres refuse to prepare the statement');
  assert.ok(occurrences.every((o) => o === occurrences[0]),
    `all $2 casts must agree, saw: ${[...new Set(occurrences)].join(', ')}`);

  // $3 (check_phase) is subject to the same planner hazard and carries the
  // same explicit cast; assert it too so a future edit can't reintroduce the
  // bug through the newer parameter.
  const p3 = sql.match(/\$3(::\w+)?/g) || [];
  assert.ok(p3.length >= 1, 'check_phase parameter is present');
  assert.deepEqual(p3.filter((o) => o === '$3'), [],
    'every $3 must carry an explicit cast, for the same reason as $2');

  // $4 (check_trigger, #1144) is the newest parameter spliced into the same
  // statement and carries the cast for the same reason.
  const p4 = sql.match(/\$4(::\w+)?/g) || [];
  assert.ok(p4.length >= 1, 'check_trigger parameter is present');
  assert.deepEqual(p4.filter((o) => o === '$4'), [],
    'every $4 must carry an explicit cast, for the same reason as $2');

  assert.deepEqual(params, [42, 'abc123', null, null]);
  assert.match(sql, /check_state = 'pending'/);
});

test('setChecksPending: null commit sha still passes a typed parameter', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };

  await visuals.setChecksPending(pool, 42, null);
  assert.deepEqual(queries[0].params, [42, null, null, null]);
});

// ── check_phase: which half of the run the card should name ─────────────

test('setChecksPending records the run phase, and the streak CASE arms are untouched by it', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };

  await visuals.setChecksPending(pool, 42, 'abc123', 'building');
  assert.deepEqual(queries[0].params, [42, 'abc123', 'building', null]);

  await visuals.setChecksPending(pool, 42, 'abc123', 'testing');
  assert.deepEqual(queries[1].params, [42, 'abc123', 'testing', null]);

  // The phase is a PLAIN assignment, not another commit-conditional CASE
  // arm: it describes the run happening right now, so a backoff retry of the
  // same commit must still move it from 'building' to 'testing'. The four
  // streak-resetting CASE arms must remain exactly four.
  const { sql } = queries[0];
  assert.match(sql, /check_phase = \$3::text/);
  assert.equal((sql.match(/CASE WHEN checks_commit_sha IS DISTINCT FROM/g) || []).length, 4,
    'the commit-changed CASE arms are unchanged — the phase is not one of them');
});

test('setChecksPending stores an unrecognised or absent phase as NULL', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };

  // A typo or a value from a newer writer must not reach the card, which
  // would render an unknown caption; NULL is the legacy-wording fallback.
  for (const bad of [undefined, null, '', 'BUILDING', 'cloning', 42, {}]) {
    queries.length = 0;
    await visuals.setChecksPending(pool, 42, 'abc123', bad);
    assert.equal(queries[0].params[2], null, `phase ${JSON.stringify(bad)} → NULL`);
  }
});

// ── check_trigger (#1144): why this run is happening ────────────────────

test('setChecksPending records the trigger, and only from the known vocabulary', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };

  for (const trigger of visuals.CHECK_TRIGGERS) {
    queries.length = 0;
    await visuals.setChecksPending(pool, 42, 'abc123', 'building', trigger);
    assert.equal(queries[0].params[3], trigger, `trigger ${trigger} round-trips`);
  }

  // Same reasoning as the phase: an unrecognised value would render no caption
  // anyway, so it is stored as NULL rather than kept as a mystery string that
  // a later reader might try to interpret.
  for (const bad of [undefined, null, '', 'COMMIT-PUSH', 'capture', 42, {}]) {
    queries.length = 0;
    await visuals.setChecksPending(pool, 42, 'abc123', 'building', bad);
    assert.equal(queries[0].params[3], null, `trigger ${JSON.stringify(bad)} → NULL`);
  }

  // Display-only, like check_phase: a plain assignment, never a gate input.
  assert.match(queries[0].sql, /check_trigger = \$4::text/);
});

test('a terminal verdict clears the phase so a settled card never shows a stage', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };

  await visuals.storeChecks(pool, 42, 'abc123', { state: 'passing', results: [] });
  assert.match(queries[0].sql, /check_phase = NULL/);

  queries.length = 0;
  await visuals.storeChecks(pool, 42, 'abc123', { state: 'error', results: [] }, 'boom');
  assert.match(queries[0].sql, /check_phase = NULL/);

  queries.length = 0;
  await visuals.storeChecksSkipped(pool, 42, 'abc123', 'nothing to test');
  assert.match(queries[0].sql, /check_phase = NULL/);
});

// ── check_phase 'deferred': a preview without a verdict ─────────────────

test("'deferred' is a known phase, so the pending stamp can name it", async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
  await visuals.setChecksPending(pool, 42, 'abc123', 'deferred', 'proposal-open');
  assert.deepEqual(queries[0].params, [42, 'abc123', 'deferred', 'proposal-open']);
});

test('the deferral stamp keeps the verdict pending, names the phase, and is pinned to the head it judged', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; } };

  const stamped = await visuals.storeChecksDeferred(pool, 42, 'abc123',
    'Checks wait until this proposal merges cleanly with main');
  assert.equal(stamped, true);
  const { sql, params } = queries[0];
  // Not a verdict: 'pending' stays, so the checks gate still holds the merge
  // and the vote-time kick can start the real run once the head is clean.
  assert.match(sql, /check_state = 'pending'/);
  assert.match(sql, /check_phase = 'deferred'/);
  // No retry is scheduled and no half-finished progress is left behind for
  // the card to animate: nothing is running.
  assert.match(sql, /check_next_retry_at = NULL/);
  assert.match(sql, /checks_progress = NULL/);
  // The same commit guard as storeChecks: a stamp about a head the row has
  // since left is discarded, not written over the new head's run.
  assert.match(sql, /checks_commit_sha IS NULL OR \$2::text IS NULL OR checks_commit_sha = \$2::text/);
  assert.match(sql, /status IN \('active', 'paused', 'promoted', 'merging'\)/);
  assert.deepEqual(params, [42, 'abc123', 'Checks wait until this proposal merges cleanly with main']);

  // A guard miss reports false so the caller logs a discard, not a notify.
  const miss = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.equal(await visuals.storeChecksDeferred(miss, 42, 'abc123'), false);
});

test("'conflict-resolved' is a known trigger: the run that judges a head the platform just made clean", async () => {
  assert.ok(visuals.CHECK_TRIGGERS.has('conflict-resolved'));
});

test('the rolling-deploy console snapshot is bound to the same live commit', async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const stored = await visuals.storeConsoleCheck(
    pool, 42, { state: 'clean', errors: [] }, 'abc123'
  );
  assert.equal(stored, true);
  assert.match(queries[0].sql,
    /status IN \('active', 'paused', 'promoted', 'merging'\)/);
  assert.match(queries[0].sql,
    /checks_commit_sha IS NOT DISTINCT FROM \$4::text/);
  assert.deepEqual(queries[0].params, ['clean', '[]', 42, 'abc123']);
});
