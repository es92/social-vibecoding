'use strict';

// services/fixed-check-sync.js: a promoted proposal whose only blocking
// failures are checks main failed too, and has since fixed, is synced with
// main by the platform, once per head and once per check.
//
// What it is for (9 Oct 2026): the Custom domain check (#4405) failed on
// every proposal because its staging fixture made the wrong account the
// project's manager. The fix (#4576) merged, and about fifteen proposals,
// several approved, stayed red on it, because each preview builds its own
// branch's copy of the fixture. Sync is the owner's button, and nobody
// presses it on the Homeroom bot's proposals.
//
// Run with: node --test tests/fixed-check-sync.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return original;
}

const loggerPath = require.resolve('../src/services/logger');
const logs = [];
stubModule(loggerPath, {
  info: (scope, msg, meta) => logs.push({ level: 'info', msg, meta }),
  warn: (scope, msg, meta) => logs.push({ level: 'warn', msg, meta }),
  error: () => {},
  debug: () => {},
});
const subject = require('../src/services/fixed-check-sync');
const appManifest = require('../src/services/app-manifest');
const { UNIT_CHECK_NAME, UNIT_CHECK_PATH, UNIT_CHECK_INDEX } = require('../src/services/unit-suite-row');

const ROOT = path.join(__dirname, '..');
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

const DOMAIN = {
  name: 'The hub\'s ⋯ menu offers Custom domain in its Settings & rules panel to whoever manages the project (#4405)',
  path: '/?demo=1&ws=status#app/staging-demo-custom-domain/dev',
};
const PICKER = { name: 'Assignee picker opens', path: '/#app/x/dev' };
const UNIT = { name: UNIT_CHECK_NAME, path: UNIT_CHECK_PATH, index: UNIT_CHECK_INDEX };
const key = (c) => appManifest.checkKey(c.name, c.path);

// A row as openVerdicts returns it.
function verdict(id, failing, over = {}) {
  return {
    id, source: 'cli_handoff', check_state: 'failing',
    checks_commit_sha: HEAD, reviewed_head_sha: HEAD,
    fixed_check_sync_head: null, fixed_check_sync_keys: null,
    failing: failing.map((f) => ({ advisory: false, ...f })),
    ...over,
  };
}

// ── select: who is stuck on main's failure ───────────────────────────────

test('9 Oct: proposals failing only a check main now passes, and that fails across them, are picked', () => {
  const rows = [
    verdict(7504, [DOMAIN]),
    verdict(7498, [DOMAIN, UNIT]),
    // Checked while the check was still advisory: evidence it is main's,
    // but its own verdict passed, so it is not stuck on checks.
    verdict(7489, [{ ...DOMAIN, advisory: true }], { check_state: 'passing' }),
  ];
  const { candidates, skipped } = subject.select(rows, new Set([key(DOMAIN)]));
  assert.deepEqual(candidates.map((c) => c.id), [7504, 7498]);
  assert.deepEqual(candidates[0], { id: 7504, head: HEAD, keys: [key(DOMAIN)] });
  assert.deepEqual(candidates[1].keys, [key(DOMAIN)],
    'the unit-suite row neither counts as fixed nor stops the sync: the new run re-tests it');
  assert.deepEqual(skipped, {}, 'a passing verdict is not a candidate and not a skip either');
});

test('a check failing on one proposal alone is that proposal\'s to fix', () => {
  const { candidates, skipped } = subject.select([verdict(1, [DOMAIN])], new Set([key(DOMAIN)]));
  assert.deepEqual(candidates, []);
  assert.deepEqual(skipped, { 1: 'own_failure' });
});

test('nothing is synced while main itself still fails the check', () => {
  // A sync would only copy main's broken fixture again, and spend the one
  // try each check gets.
  const rows = [verdict(1, [DOMAIN]), verdict(2, [DOMAIN])];
  const { candidates, skipped } = subject.select(rows, new Set());
  assert.deepEqual(candidates, []);
  assert.deepEqual(skipped, { 1: 'main_fails', 2: 'main_fails' });
});

test('one failure of its own beside main\'s keeps a proposal for its author', () => {
  const rows = [verdict(1, [DOMAIN, PICKER]), verdict(2, [DOMAIN])];
  const { candidates, skipped } = subject.select(rows, new Set([key(DOMAIN), key(PICKER)]));
  assert.deepEqual(candidates.map((c) => c.id), [2]);
  assert.equal(skipped[1], 'own_failure', 'the picker check fails on it alone');
});

test('only the unit suite failing (main not green since), an imported head, a moved head or a head already synced: no sync', () => {
  const passes = new Set([key(DOMAIN)]);
  // Two others failing it, so the check is main's whatever row 1 says.
  const others = [verdict(9, [DOMAIN]), verdict(10, [DOMAIN])];
  for (const [row, why] of [
    [verdict(1, [UNIT]), 'unit_suite_only'],
    [verdict(1, [{ ...UNIT, advisory: true }]), 'nothing_fixed'],
    [verdict(1, [DOMAIN], { source: 'imported' }), 'imported'],
    [verdict(1, [DOMAIN], { reviewed_head_sha: NEW_HEAD }), 'head_moved'],
    [verdict(1, [DOMAIN], { fixed_check_sync_head: HEAD.toUpperCase() }), 'already_tried'],
    [verdict(1, [DOMAIN], { checks_commit_sha: null }), 'no_verdict'],
  ]) {
    const { candidates, skipped } = subject.select([row, ...others], passes);
    assert.deepEqual(candidates.map((c) => c.id), [9, 10], why);
    assert.equal(skipped[1], why);
  }
});

// 10 Oct 2026: five challenge tests failed every weekend until #4648 fixed
// them on main. Two approved Homeroom bot proposals cut before it failed only
// the unit suite on them and stayed red: the rule above needs a named check
// that fails across proposals, and the unit-suite row names none. Main watch
// runs the same suite on main itself, so main green AFTER a proposal's run is
// the evidence instead.
test('a proposal failing only the unit suite is synced once main watch has passed since its run', () => {
  const ran = '2026-10-10T08:46:04.000Z';
  const row = verdict(7629, [UNIT], { checks_checked_at: ran });
  const greenAfter = { passing: true, at: Date.parse('2026-10-10T11:01:15Z') };

  const { candidates } = subject.select([row], new Set(), greenAfter);
  assert.deepEqual(candidates, [{ id: 7629, head: HEAD, keys: [subject.UNIT_KEY] }],
    'synced once, recorded under the unit suite\'s own key');

  for (const [watch, why] of [
    [{ passing: true, at: Date.parse('2026-10-10T08:00:00Z') }, 'green before its run: main has not moved since'],
    [{ passing: false, at: Date.parse('2026-10-10T11:01:15Z') }, 'main is red itself'],
    [null, 'no main watch on this app'],
  ]) {
    const out = subject.select([row], new Set(), watch);
    assert.deepEqual(out.candidates, [], why);
    assert.equal(out.skipped[7629], 'unit_suite_only', why);
  }

  const synced = verdict(7629, [UNIT], {
    checks_checked_at: ran, fixed_check_sync_head: NEW_HEAD, fixed_check_sync_keys: [subject.UNIT_KEY],
  });
  assert.equal(subject.select([synced], new Set(), greenAfter).skipped[7629], 'already_tried',
    'still failing on a head that contains main: the proposal\'s own');

  // A named check of its own beside it is still the author's.
  const mixed = verdict(7630, [UNIT, PICKER], { checks_checked_at: ran });
  assert.equal(subject.select([mixed], new Set([key(PICKER)]), greenAfter).skipped[7630], 'own_failure');
});

// 10 Oct 2026, the same evening: #4720 fixed a unit test (TEST_SHARD leaking
// into a nested run) and shipped at 21:26; main watch passed on that release
// at 21:32. Six approved proposals cut before it were re-run after an outage
// and five ended red on that one test at 21:40-21:45. Main had not moved
// since, and nothing was ready to merge, so "green since its run" never came.
// Main green on the tip they are behind is the same evidence: syncOne still
// measures that the proposal is behind main and leaves one level with it.
test('a proposal failing only the unit suite is synced when main watch passed on main\'s tip, whenever its run was', () => {
  const TIP = 'c'.repeat(40);
  const row = verdict(7732, [UNIT], { checks_checked_at: '2026-10-10T21:40:48.000Z' });
  const greenTip = { passing: true, at: Date.parse('2026-10-10T21:32:20Z'), sha: TIP, tip: TIP };

  assert.deepEqual(subject.select([row], new Set(), greenTip).candidates,
    [{ id: 7732, head: HEAD, keys: [`${subject.UNIT_KEY}@${TIP}`] }],
    'recorded with the main it was synced against');
  assert.deepEqual(subject.select([row], new Set(), { ...greenTip, tip: TIP.toUpperCase() }).candidates.map((c) => c.id), [7732],
    'shas compare whatever their case');

  for (const [watch, why] of [
    [{ ...greenTip, tip: 'd'.repeat(40) }, 'main moved past the green commit and is not judged yet'],
    [{ ...greenTip, passing: false }, 'main is red itself'],
    [{ ...greenTip, sha: null }, 'no commit recorded'],
  ]) {
    const out = subject.select([row], new Set(), watch);
    assert.deepEqual(out.candidates, [], why);
    assert.equal(out.skipped[7732], 'unit_suite_only', why);
  }
  const synced = verdict(7732, [UNIT], { fixed_check_sync_head: NEW_HEAD, fixed_check_sync_keys: [subject.unitSyncKey(TIP)] });
  assert.equal(subject.select([synced], new Set(), greenTip).skipped[7732], 'already_tried',
    'once per main: still failing on a head that contains this one, the failure is the proposal\'s own');
  assert.equal(subject.select([synced], new Set(), { ...greenTip, tip: TIP.toUpperCase() }).skipped[7732], 'already_tried',
    'the recorded tip compares whatever its case');
});

// 11 Oct 2026: the translation proposal #4764 failed one unit test that
// pinned the shell to English alone. The sweep synced it onto main as it
// was, before #4767 fixed that test, so its synced head still failed, and
// once-per-proposal skipped it from then on: red with two yes votes and a
// fixed main, and nobody able to press Sync on Homeroom's own proposal. One
// row stands for every test, so failing on a head containing one main says
// nothing about a later main.
test('a proposal failing only the unit suite is synced again once main moves on and is green, at most MAX_UNIT_SYNCS times', () => {
  const OLD_TIP = 'c'.repeat(40);
  const TIP = 'd'.repeat(40);
  const ran = '2026-10-11T14:05:00.000Z';
  const greenTip = { passing: true, at: Date.parse('2026-10-11T19:40:00Z'), sha: TIP, tip: TIP };
  const after = (keys, over = {}) => verdict(7825, [UNIT], {
    checks_checked_at: ran, fixed_check_sync_head: NEW_HEAD, fixed_check_sync_keys: keys, ...over,
  });

  // Synced once before the tip was recorded (a bare key), or with an older main.
  for (const keys of [[subject.UNIT_KEY], [subject.unitSyncKey(OLD_TIP)]]) {
    assert.deepEqual(subject.select([after(keys)], new Set(), greenTip).candidates,
      [{ id: 7825, head: HEAD, keys: [subject.unitSyncKey(TIP)] }], keys[0]);
    assert.deepEqual(subject.select([after(keys)], new Set(), { ...greenTip, sha: OLD_TIP }).candidates.map((c) => c.id), [7825],
      'main watch green since its run is enough, as for the first');
  }

  for (const [watch, why] of [
    [{ ...greenTip, passing: false }, 'main is red itself'],
    [{ ...greenTip, sha: OLD_TIP, at: Date.parse('2026-10-11T13:00:00Z') }, 'green only before its run, on a main it already has'],
  ]) {
    const out = subject.select([after([subject.UNIT_KEY])], new Set(), watch);
    assert.deepEqual(out.candidates, [], why);
    assert.equal(out.skipped[7825], 'unit_suite_only', why);
  }

  assert.equal(subject.select([after([subject.UNIT_KEY])], new Set(), { ...greenTip, tip: null }).skipped[7825], 'already_tried',
    'with no tip, a later main cannot be told from the one it was synced with');

  const used = [subject.UNIT_KEY, subject.unitSyncKey(OLD_TIP), subject.unitSyncKey('e'.repeat(40))];
  assert.equal(used.length, subject.MAX_UNIT_SYNCS);
  assert.equal(subject.select([after(used)], new Set(), greenTip).skipped[7825], 'already_tried',
    'a proposal whose own change breaks a test stops costing runs');
  assert.deepEqual(subject.select([after(used.slice(1))], new Set(), greenTip).candidates.map((c) => c.id), [7825]);

  // A named check's key beside them is not a unit-suite sync.
  const mixed = after([subject.UNIT_KEY, key(DOMAIN), key(PICKER)]);
  assert.deepEqual(subject.select([mixed], new Set(), greenTip).candidates.map((c) => c.id), [7825]);
});

test('main watch\'s verdict carries the commit it judged and main\'s tip', async () => {
  const TIP = 'c'.repeat(40);
  let sql = null;
  const pool = { query: async (q) => {
    sql = q;
    return { rows: [{ main_check_state: 'passing', main_check_at: '2026-10-10T21:32:20Z', main_check_sha: TIP, main_sha: TIP }] };
  } };
  assert.deepEqual(await subject.mainWatchVerdict(pool, 5),
    { passing: true, at: Date.parse('2026-10-10T21:32:20Z'), sha: TIP, tip: TIP });
  assert.match(sql, /SELECT main_check_state, main_check_at, main_check_sha, main_sha FROM apps WHERE id = \$1/);
});

test('a check a proposal was already synced for is never a reason to sync it again', () => {
  // It contains a main that passes the check and still fails it: its own.
  const rows = [
    verdict(1, [DOMAIN], { fixed_check_sync_head: NEW_HEAD, fixed_check_sync_keys: [key(DOMAIN)] }),
    verdict(2, [DOMAIN]),
  ];
  const { candidates, skipped } = subject.select(rows, new Set([key(DOMAIN)]));
  assert.deepEqual(candidates.map((c) => c.id), [2]);
  assert.equal(skipped[1], 'already_tried');
});

// ── syncOne: measure, claim, sync, start the new head's run ─────────────

function fullRow(over = {}) {
  return {
    id: 7504, status: 'promoted', source: 'cli_handoff', check_state: 'failing',
    branch_name: 'dev/homeroom_bot-homeroom-bot-4571-fix',
    repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
    app_slug: 'usernode-2d5619', checks_commit_sha: HEAD, behind_main: 0,
    ...over,
  };
}

function makePool({ current = fullRow(), claimWins = true } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/FROM chat_sessions cs JOIN apps a/.test(text)) return { rows: current ? [current] : [] };
      if (/SET fixed_check_sync_head = \$2/.test(text)) {
        return claimWins ? { rows: [{ id: params[0] }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function makeDeps({
  measured = { headSha: HEAD, behindBy: 5, mergesClean: true },
  busy = false,
  integrating = false,
  syncResult = { ok: true, syncResult: 'clean', pushOk: true, sha: NEW_HEAD },
} = {}) {
  const calls = { measure: [], sync: [], reconcile: [] };
  const deps = {
    integration: {
      measure: async ({ session }, options) => {
        calls.measure.push({ session, options });
        return measured;
      },
    },
    syncMain: {
      runSyncMain: async (config, pool, id, opts) => { calls.sync.push({ id, opts }); return syncResult; },
    },
    activeWorkers: { isSessionBusy: () => busy },
    mergeQueue: { isIntegratingSession: () => integrating },
    votes: () => ({
      reconcileNativeReviewedHead: async (args) => { calls.reconcile.push(args); return {}; },
    }),
  };
  return { deps, calls };
}

const CANDIDATE = { id: 7504, head: HEAD, keys: [key(DOMAIN)] };

test('a stuck proposal is claimed, synced as the platform, and its new head run, keeping its votes', async () => {
  const pool = makePool();
  const { deps, calls } = makeDeps();
  const out = await subject.syncOne({ config: { c: 1 }, pool, candidate: CANDIDATE }, deps);
  assert.deepEqual(out, { synced: true, why: null, sha: NEW_HEAD });
  const claim = pool.queries.find((q) => /SET fixed_check_sync_head = \$2/.test(q.sql));
  assert.ok(claim, 'the head and the checks are claimed before the sync');
  assert.match(claim.sql, /fixed_check_sync_head IS DISTINCT FROM \$2/, 'once per head');
  assert.match(claim.sql, /LOWER\(checks_commit_sha\) = \$2/, 'only while the row still describes that head');
  assert.match(claim.sql, /status = 'promoted' AND check_state = 'failing'/);
  assert.deepEqual(claim.params, [7504, HEAD, [key(DOMAIN)]]);
  assert.equal(calls.sync.length, 1);
  assert.equal(calls.sync[0].opts.trigger, 'fixed_on_main');
  assert.equal(calls.sync[0].opts.sessionRow.behind_main, 5, 'the measured count, so the sync narrates');
  assert.equal(calls.reconcile.length, 1, 'the merge queue\'s own follow-up: re-pin and run');
  assert.equal(calls.reconcile[0].notify, false);
  const claimAt = pool.queries.indexOf(claim);
  assert.ok(claimAt > 0, 'measured first, then claimed');
});

test('busy, integrating, level with main, conflicting or claimed elsewhere: nothing is synced', async () => {
  for (const [opts, poolOpts, why] of [
    [{ busy: true }, {}, 'busy'],
    [{ integrating: true }, {}, 'integrating'],
    [{ measured: { headSha: HEAD, behindBy: 0, mergesClean: true } }, {}, 'level'],
    [{ measured: { headSha: HEAD, behindBy: 3, mergesClean: false } }, {}, 'conflict'],
    [{ measured: { headSha: NEW_HEAD, behindBy: 3, mergesClean: true } }, {}, 'head_moved'],
    [{ measured: { error: 'mirror down' } }, {}, 'unmeasured'],
    [{}, { claimWins: false }, 'claimed'],
    [{}, { current: fullRow({ checks_commit_sha: NEW_HEAD }) }, 'head_moved'],
    [{}, { current: fullRow({ status: 'merged' }) }, 'gone'],
  ]) {
    const { deps, calls } = makeDeps(opts);
    const out = await subject.syncOne({ config: {}, pool: makePool(poolOpts), candidate: CANDIDATE }, deps);
    assert.deepEqual(out, { synced: false, why }, why);
    assert.equal(calls.sync.length, 0, `${why}: no sync`);
  }
});

test('a sync that pushes nothing reports it and starts no run', async () => {
  const { deps, calls } = makeDeps({ syncResult: { syncResult: 'conflict', pushOk: false } });
  const out = await subject.syncOne({ config: {}, pool: makePool(), candidate: CANDIDATE }, deps);
  assert.deepEqual(out, { synced: false, why: 'conflict' });
  assert.equal(calls.reconcile.length, 0);
});

// ── syncBeforeHandOff: the Homeroom bot's one sync before a person ───────
// PR #4851 sat red from 12 Oct, 18 yes votes waiting, on a test #4843 had
// fixed on main: the bot's fix turn found it was not the change's, handed it
// to a person, and main watch never read green, so nothing synced it.

// The pool syncOne reads, plus the keys a proposal's syncs left on it.
function handOffPool({ keys = null, ...rest } = {}) {
  const pool = makePool(rest);
  const query = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (/SELECT fixed_check_sync_keys FROM chat_sessions/.test(String(sql))) {
      pool.queries.push({ sql: String(sql), params });
      return { rows: rest.current === null ? [] : [{ fixed_check_sync_keys: keys }] };
    }
    return query(sql, params);
  };
  return pool;
}

test('before the bot hands red checks to a person, its proposal is synced with main once, through the same claim', async () => {
  const pool = handOffPool({ keys: [key(DOMAIN)] });
  const { deps, calls } = makeDeps();
  const out = await subject.syncBeforeHandOff({ config: { c: 1 }, pool, sessionId: 7504, head: HEAD.toUpperCase() }, deps);
  assert.deepEqual(out, { synced: true, why: null, sha: NEW_HEAD });
  const claim = pool.queries.find((q) => /SET fixed_check_sync_head = \$2/.test(q.sql));
  assert.deepEqual(claim.params, [7504, HEAD, [subject.BOT_HANDOFF_KEY]],
    'claimed on the head the sweep claims, so the two never both sync it; a sweep\'s key is no reason not to');
  assert.equal(calls.sync[0].opts.trigger, 'bot_handoff');
  assert.equal(calls.reconcile.length, 1, 'its new head is run, keeping its votes');
});

test('once per proposal, never while off, and only what syncOne would sync', async () => {
  const { deps, calls } = makeDeps();
  const tried = handOffPool({ keys: [subject.BOT_HANDOFF_KEY] });
  assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: tried, sessionId: 7504, head: HEAD }, deps),
    { synced: false, why: 'already_tried' }, 'a check still red on a head that contains main is handed over');
  assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: handOffPool({ current: null }), sessionId: 7504, head: HEAD }, deps),
    { synced: false, why: 'gone' });
  assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: handOffPool(), sessionId: 7504, head: null }, deps),
    { synced: false, why: 'no_verdict' });
  const level = makeDeps({ measured: { headSha: HEAD, behindBy: 0, mergesClean: true } });
  assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: handOffPool(), sessionId: 7504, head: HEAD }, level.deps),
    { synced: false, why: 'level' }, 'a change level with main has nothing to gain');
  const conflict = makeDeps({ measured: { headSha: HEAD, behindBy: 182, mergesClean: false } });
  assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: handOffPool(), sessionId: 7504, head: HEAD }, conflict.deps),
    { synced: false, why: 'conflict' }, 'a conflict is a person\'s to resolve');
  const down = { async query() { throw new Error('db down'); } };
  assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: down, sessionId: 7504, head: HEAD }, deps),
    { synced: false, why: 'threw' }, 'never throws');
  const before = process.env.FIXED_CHECK_SYNC_ENABLED;
  try {
    process.env.FIXED_CHECK_SYNC_ENABLED = '0';
    assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: handOffPool(), sessionId: 7504, head: HEAD }, deps),
      { synced: false, why: 'disabled' });
  } finally {
    if (before === undefined) delete process.env.FIXED_CHECK_SYNC_ENABLED;
    else process.env.FIXED_CHECK_SYNC_ENABLED = before;
  }
  assert.equal(calls.sync.length, 0, 'none of those synced anything');
});

// ── sweep: every app, at most MAX_SYNCS_PER_PASS ─────────────────────────

test('a sweep syncs at most MAX_SYNCS_PER_PASS and never throws', async () => {
  const ids = [1, 2, 3, 4, 5, 6];
  const pool = {
    async query(sql, params) {
      const text = String(sql);
      if (/SELECT DISTINCT app_id/.test(text)) return { rows: [{ app_id: 12 }] };
      if (/WITH recent AS/.test(text)) return { rows: [{ ...DOMAIN, status: 'pass' }] };
      if (/WHERE cs.app_id = \$1 AND cs.status = 'promoted'/.test(text)) {
        return { rows: ids.map((id) => verdict(id, [DOMAIN])) };
      }
      if (/FROM chat_sessions cs JOIN apps a/.test(text)) return { rows: [fullRow({ id: params[0] })] };
      if (/SET fixed_check_sync_head/.test(text)) return { rows: [{ id: params[0] }] };
      return { rows: [] };
    },
  };
  const { deps, calls } = makeDeps();
  const out = await subject.sweep({ config: {}, pool }, deps);
  assert.equal(out.candidates, 6);
  assert.deepEqual(out.synced, [1, 2, 3, 4]);
  assert.equal(calls.sync.length, subject.MAX_SYNCS_PER_PASS);

  const broken = { async query() { throw new Error('connection terminated'); } };
  assert.deepEqual(await subject.sweep({ config: {}, pool: broken }, deps),
    { apps: 0, candidates: 0, synced: [], skipped: {} });
});

// ── wiring ───────────────────────────────────────────────────────────────

test('the leader starts the sweep and shutdown stops it', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const leader = server.slice(server.indexOf('async function becomeLeader('));
  assert.match(leader.slice(0, leader.indexOf('\n}\n')),
    /require\('\.\/src\/services\/fixed-check-sync'\)\.start\(config, getPool\(config\)\)/,
    'leader-only, beside the other sweeps');
  assert.match(server, /const fixedCheckSyncStop = require\('\.\/src\/services\/fixed-check-sync'\)\.stop\(\);/);
  assert.match(server, /Promise\.all\(\[[^\]]*fixedCheckSyncStop[^\]]*\]\)/, 'and the pool waits for its pass');
});

test('the schema carries the claim columns', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS fixed_check_sync_head TEXT;/);
  assert.match(schema, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS fixed_check_sync_keys TEXT\[\];/);
});

test('FIXED_CHECK_SYNC_ENABLED=0 turns it off', () => {
  const before = process.env.FIXED_CHECK_SYNC_ENABLED;
  try {
    process.env.FIXED_CHECK_SYNC_ENABLED = '0';
    assert.equal(subject.isEnabled(), false);
    delete process.env.FIXED_CHECK_SYNC_ENABLED;
    assert.equal(subject.isEnabled(), true);
  } finally {
    if (before === undefined) delete process.env.FIXED_CHECK_SYNC_ENABLED;
    else process.env.FIXED_CHECK_SYNC_ENABLED = before;
  }
});
