'use strict';

// services/main-watch — the safety net under direct merges.
//
// Proposals merge as they stand once approved and clean, so nobody has run
// the checks against the merged tree AS A WHOLE. After each merge the repo's
// unit suite runs once on the merge commit; red pauses the app's merges
// until a fix lands or an admin resumes them. Every write is compare-and-
// swap on the merge sha, so a slow run for an older merge cannot overwrite
// the verdict for a newer one.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.NODE_ENV = 'test';
delete process.env.MAIN_WATCH_ENABLED;

// The two lazily-required collaborators, stubbed before main-watch can load
// them: the group message and the queue kick are the observable outcomes.
const posted = [];
const enqueued = [];
require.cache[require.resolve('../src/services/ws')] = {
  id: 'ws', filename: 'ws', loaded: true,
  exports: {
    sendSystemMessage: async (pool, appId, content) => { posted.push({ appId, content }); },
    pushSessionUpdate: () => {},
  },
};
require.cache[require.resolve('../src/services/merge-queue')] = {
  id: 'merge-queue', filename: 'merge-queue', loaded: true,
  exports: { enqueue: (config, appId) => { enqueued.push(appId); } },
};

const unitSuite = require('../src/services/unit-suite');
const mainWatch = require('../src/services/main-watch');

const SHA = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const APP = { id: 12, slug: 'demo', repo_url: 'https://github.com/org/demo' };
const config = { workerRuntime: 'docker' };

// A pool that answers the three statements main-watch issues, and records
// them. `claim` is what the CTE's prev block returns; `verdictRows` is the
// row count of the CAS write.
function fakePool({ claim = { was_state: null, was_sha: null }, verdictRows = 1, resumeRow = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/main_check_state = 'running'/.test(sql)) return { rows: [claim], rowCount: 1 };
      if (/SET main_check_state = \$3/.test(sql)) return { rows: [], rowCount: verdictRows };
      if (/SET main_check_resumed_sha = main_check_sha/.test(sql)) {
        return { rows: resumeRow ? [resumeRow] : [], rowCount: resumeRow ? 1 : 0 };
      }
      if (/SELECT main_check_state/.test(sql)) return { rows: [claim.row || {}], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

function stubSuite(fn) {
  const real = unitSuite.maybeRunUnitSuite;
  const calls = [];
  unitSuite.maybeRunUnitSuite = async (args) => { calls.push(args); return fn(args); };
  return { calls, restore: () => { unitSuite.maybeRunUnitSuite = real; } };
}

const pass = { row: { status: 'pass', failureReason: '', summary: { tests: 40, pass: 40, fail: 0 } } };
const fail = (reason) => ({ row: { status: 'fail', failureReason: reason, summary: { tests: 40, pass: 39, fail: 1 } } });

test.beforeEach(() => { posted.length = 0; enqueued.length = 0; });

test('describe: paused means red at a sha the admin has not resumed', () => {
  assert.deepEqual(mainWatch.describe(null), {
    state: null, sha: null, at: null, detail: null, resumedSha: null, paused: false,
  });
  const red = mainWatch.describe({ main_check_state: 'failing', main_check_sha: SHA, main_check_at: '2026-09-14T10:00:00Z' });
  assert.equal(red.paused, true);
  assert.equal(red.at, '2026-09-14T10:00:00.000Z');
  // Resumed for THIS sha: not paused. Case is not a difference.
  assert.equal(mainWatch.describe({ main_check_state: 'failing', main_check_sha: SHA, main_check_resumed_sha: SHA.toUpperCase() }).paused, false);
  // Resumed for an OLDER sha: a new red is a new question, paused again.
  assert.equal(mainWatch.describe({ main_check_state: 'failing', main_check_sha: SHA, main_check_resumed_sha: OLD }).paused, true);
  // Running, passing, error, skipped: none of them pause anything.
  for (const state of ['running', 'passing', 'error', 'skipped']) {
    assert.equal(mainWatch.describe({ main_check_state: state, main_check_sha: SHA }).paused, false, state);
  }
});

test('classify: only a verdict ABOUT the code can pause merges', () => {
  assert.equal(mainWatch.classify(null).state, 'skipped');
  assert.equal(mainWatch.classify({ row: null }).state, 'skipped');
  assert.equal(mainWatch.classify(pass).state, 'passing');
  assert.equal(mainWatch.classify(fail('1 of 40 tests failed: merge-queue › direct lane')).state, 'failing');
  // A run that could not happen says nothing about main.
  assert.equal(mainWatch.classify(fail('Suite setup failed: npm ci exited 1')).state, 'error');
  assert.equal(mainWatch.classify(fail('Suite run exceeded 20 minutes')).state, 'error');
  assert.deepEqual(mainWatch.classify(pass).detail, { summary: pass.row.summary });
});

test('afterMerge: a green run records passing and tells nobody', async () => {
  const pool = fakePool();
  const suite = stubSuite(async () => pass);
  try {
    const out = await mainWatch.afterMerge(config, pool, { app: APP, session: { id: 3, pr_number: 41 }, mergeSha: SHA });
    assert.equal(out.state, 'passing');
    assert.equal(out.sha, SHA);
    // The run is named for the app, not a session, so a session's own
    // cleanup cannot take it down; and it runs the merge commit itself.
    assert.equal(suite.calls[0].sessionId, 'main-12');
    assert.equal(suite.calls[0].ref, SHA);
    assert.equal(suite.calls[0].repoOwner, 'org');
    assert.equal(suite.calls[0].repoName, 'demo');
    assert.equal(suite.calls[0].prNumber, null, 'not a PR run');
    // Claim, then CAS write for the same sha.
    assert.match(pool.calls[0].sql, /main_check_state = 'running', main_check_sha = \$2/);
    assert.deepEqual(pool.calls[0].params.slice(0, 2), [12, SHA]);
    assert.match(pool.calls[1].sql, /WHERE id = \$1 AND main_check_sha = \$2/);
    assert.deepEqual(pool.calls[1].params.slice(0, 3), [12, SHA, 'passing']);
    assert.equal(posted.length, 0, 'green is the common case; nobody is told');
    assert.equal(enqueued.length, 0);
  } finally { suite.restore(); }
});

test('afterMerge: a red run pauses merges and says so in the group', async () => {
  const pool = fakePool();
  const suite = stubSuite(async () => fail('1 of 40 tests failed: votes › tally'));
  try {
    const out = await mainWatch.afterMerge(config, pool, { app: APP, session: { id: 3, pr_number: 41 }, mergeSha: SHA });
    assert.equal(out.state, 'failing');
    assert.deepEqual(pool.calls[1].params.slice(0, 3), [12, SHA, 'failing']);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].appId, 12);
    assert.match(posted[0].content, /main's unit suite is failing after PR #41 merged \(ccccccc\)/);
    assert.match(posted[0].content, /1 of 40 tests failed: votes › tally/);
    assert.match(posted[0].content, /paused until a fix lands or an admin resumes them/);
    assert.equal(enqueued.length, 0, 'red kicks nothing');
  } finally { suite.restore(); }
});

test('afterMerge: green after red announces the recovery and lets the queue go', async () => {
  const pool = fakePool({ claim: { was_state: 'failing', was_sha: OLD } });
  const suite = stubSuite(async () => pass);
  try {
    await mainWatch.afterMerge(config, pool, { app: APP, session: { id: 4, pr_number: 42 }, mergeSha: SHA });
    assert.equal(posted.length, 1);
    assert.match(posted[0].content, /green again after PR #42 merged \(ccccccc\)\. Merges resume\./);
    assert.deepEqual(enqueued, [12], 'whatever was approved during the pause can merge now');
  } finally { suite.restore(); }
});

test('afterMerge: a verdict for a superseded merge is discarded, not written', async () => {
  // A newer merge re-claimed the row while this run was going: the CAS
  // write matches no row, and the stale verdict must not become the answer.
  const pool = fakePool({ verdictRows: 0 });
  const suite = stubSuite(async () => fail('boom'));
  try {
    const out = await mainWatch.afterMerge(config, pool, { app: APP, mergeSha: OLD });
    assert.equal(out, null);
    assert.equal(posted.length, 0, 'a discarded verdict pauses nothing and tells nobody');
  } finally { suite.restore(); }
});

test('afterMerge: a run that could not happen records error and pauses nothing', async () => {
  const pool = fakePool();
  const suite = stubSuite(async () => { throw new Error('docker daemon unreachable'); });
  try {
    const out = await mainWatch.afterMerge(config, pool, { app: APP, mergeSha: SHA });
    assert.equal(out.state, 'error');
    assert.match(out.detail.failureReason, /docker daemon unreachable/);
    assert.equal(posted.length, 0);
    assert.equal(mainWatch.describe({ main_check_state: 'error', main_check_sha: SHA }).paused, false);
  } finally { suite.restore(); }
});

test('afterMerge: nothing runs without a repo, a sha, or the switch on', async () => {
  const pool = fakePool();
  const suite = stubSuite(async () => pass);
  try {
    assert.equal(await mainWatch.afterMerge(config, pool, { app: { id: 1, repo_url: 'not-github' }, mergeSha: SHA }), null);
    assert.equal(await mainWatch.afterMerge(config, pool, { app: APP, mergeSha: null }), null);
    assert.equal(await mainWatch.afterMerge(config, null, { app: APP, mergeSha: SHA }), null);
    process.env.MAIN_WATCH_ENABLED = '0';
    try {
      assert.equal(mainWatch.isEnabled(), false);
      assert.equal(await mainWatch.afterMerge(config, pool, { app: APP, mergeSha: SHA }), null);
    } finally { delete process.env.MAIN_WATCH_ENABLED; }
    assert.equal(suite.calls.length, 0);
    assert.equal(pool.calls.length, 0, 'no claim is written for a run that will not happen');
  } finally { suite.restore(); }
});

test('resume: stamps the current red sha, tells the group, and kicks the queue', async () => {
  const row = { main_check_state: 'failing', main_check_sha: SHA, main_check_at: new Date(), main_check_detail: {}, main_check_resumed_sha: SHA };
  const pool = fakePool({ resumeRow: row });
  const out = await mainWatch.resume(config, pool, 12, { by: { username: 'evan' } });
  assert.equal(out.paused, false, 'resumed for this sha');
  assert.equal(out.resumedSha, SHA);
  assert.match(pool.calls[0].sql, /WHERE id = \$1 AND main_check_state = 'failing' AND main_check_sha IS NOT NULL/);
  assert.equal(posted.length, 1);
  assert.match(posted[0].content, /^evan resumed merges while main's unit suite is failing \(ccccccc\)/);
  assert.deepEqual(enqueued, [12]);
});

test('resume: nothing to resume when main is not red', async () => {
  const pool = fakePool({ resumeRow: null });
  assert.equal(await mainWatch.resume(config, pool, 12, { by: { username: 'evan' } }), null);
  assert.equal(posted.length, 0);
  assert.equal(enqueued.length, 0);
});

test('mergePause: an unreadable row does not wedge every merge on the app', async () => {
  const pool = { query: async () => { throw new Error('connection reset'); } };
  const out = await mainWatch.mergePause(pool, 12);
  assert.equal(out.paused, false);
  assert.match(out.error, /connection reset/);
  assert.deepEqual(await mainWatch.mergePause(null, 12), { paused: false, state: null });
});

test('the route and the gate read the same module', () => {
  // The admin resume route and checkAndMerge's main_healthy gate both go
  // through main-watch; pin the file so a rename cannot leave one behind.
  const fs = require('node:fs');
  const apps = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'apps.js'), 'utf8');
  const votes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8');
  assert.match(apps, /main-check\/resume/);
  assert.match(apps, /mainWatch\.resume\(/);
  assert.match(votes, /mergePause\(/);
  assert.match(votes, /afterMerge\(/);
});
