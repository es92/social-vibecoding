// When a merged change of the platform's own app goes live (#4309
// follow-up).
//
// Since #4309 main releases at most once every RELEASE_MIN_GAP_MINUTES (10),
// and a release also takes its image build and its rollout, so a merge into
// Homeroom itself read a bare "Going live" for ten to twenty minutes. Every
// surface now says why and when, in one sentence:
//
//   Merged; goes live in the next release (about 8 minutes)
//   Merged; goes live in the next release (in about a minute)
//   Merged; going live now
//   Merged; waiting for a release
//
// This file pins the two halves that make it: the words
// (frontend/src/lib/release-eta.ts) at each boundary, and the estimate
// (src/services/release-watch.js: estimate, releaseOf, outlook, releasesFor,
// and the run the drift poller records for it). The surfaces are
// tests/release-eta-surfaces.test.js.
//
// Run with: node --test tests/release-eta.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx } = require('./lib/render-tsx');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const logged = [];
stub(require.resolve('../src/services/logger'), {
  info: (...a) => logged.push(['info', ...a]),
  warn: (...a) => logged.push(['warn', ...a]),
  error: (...a) => logged.push(['error', ...a]),
  debug: (...a) => logged.push(['debug', ...a]),
});
stub(require.resolve('../src/services/notifications'), {
  createAppHealthNotification: async () => [],
  hydrateAndPush: async () => {},
});
stub(require.resolve('../src/services/github'), {
  parseGithubUrl: (url) => {
    const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(String(url || ''));
    return m ? { owner: m[1], repo: m[2] } : null;
  },
});

const releaseWatch = require('../src/services/release-watch');
const words = loadTsx('frontend/src/lib/release-eta.ts');

const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-09T18:00:00Z');
const at = (ms) => new Date(ms).toISOString();
const next = (msFromNow) => ({ state: 'next', etaAt: at(NOW + msFromNow) });

// ── The words ────────────────────────────────────────────────────────────

test('the sentence, at each boundary of the estimate', () => {
  const say = (release) => words.releaseSentence(release, NOW);
  assert.equal(say(next(8 * MIN)), 'Merged; goes live in the next release (about 8 minutes)');
  assert.equal(say(next(2 * MIN)), 'Merged; goes live in the next release (about 2 minutes)');
  // Whole minutes, rounded: 90 seconds is two, 89 is one.
  assert.equal(say(next(90 * 1000)), 'Merged; goes live in the next release (about 2 minutes)');
  assert.equal(say(next(89 * 1000)), 'Merged; goes live in the next release (in about a minute)');
  assert.equal(say(next(MIN)), 'Merged; goes live in the next release (in about a minute)');
  // A floor of one: seconds away is still "about a minute", never "0 minutes".
  assert.equal(say(next(20 * 1000)), 'Merged; goes live in the next release (in about a minute)');
  assert.equal(say(next(1)), 'Merged; goes live in the next release (in about a minute)');
  // The estimate reached or passed: going live now, never a negative count.
  assert.equal(say(next(0)), 'Merged; going live now');
  assert.equal(say(next(-5 * MIN)), 'Merged; going live now');
  // The release carrying it is rolling out.
  assert.equal(say({ state: 'rolling', etaAt: null }), 'Merged; going live now');
  // No promise: its release is stuck (the board's banner says why).
  assert.equal(say({ state: 'waiting', etaAt: null }), 'Merged; waiting for a release');
  // Nothing to time it from.
  assert.equal(say({ state: 'next', etaAt: null }), 'Merged; goes live in the next release');
  // Not a release block: the caller keeps its own words.
  for (const junk of [null, undefined, {}, 'next', { state: 'soon', etaAt: at(NOW) }, { state: 'next', etaAt: 'tomorrow' }]) {
    const said = words.releaseSentence(junk, NOW);
    assert.ok(said === null || said === 'Merged; goes live in the next release', JSON.stringify(junk));
  }
  assert.equal(words.releaseSentence(null, NOW), null);
  assert.equal(words.releaseSentence({ state: 'soon' }, NOW), null);
});

test('the short form, for a line that already says it merged, and the Done column count', () => {
  const short = (release) => words.releaseShort(release, NOW);
  assert.equal(short(next(8 * MIN)), 'Goes live in about 8 minutes');
  assert.equal(short(next(30 * 1000)), 'Goes live in about a minute');
  assert.equal(short(next(-MIN)), 'Going live now');
  assert.equal(short({ state: 'rolling', etaAt: null }), 'Going live now');
  assert.equal(short({ state: 'waiting', etaAt: null }), 'Waiting for a release');
  assert.equal(short({ state: 'next', etaAt: null }), 'Goes live in the next release');
  assert.equal(short(null), null);

  const count = (release, n) => words.releaseCountLine(release, n, NOW);
  assert.equal(count(next(8 * MIN), 2), '2 merged changes go live in the next release (about 8 minutes)');
  assert.equal(count(next(8 * MIN), 1), '1 merged change goes live in the next release (about 8 minutes)');
  assert.equal(count(next(40 * 1000), 3), '3 merged changes go live in the next release (in about a minute)');
  assert.equal(count(next(-MIN), 2), '2 merged changes going live now');
  assert.equal(count({ state: 'waiting', etaAt: null }, 2), '2 merged changes waiting for a release');
  assert.equal(count(null, 2), null);
});

test('minutes and ticking: only an estimate still ahead counts down', () => {
  assert.equal(words.releaseMinutes(next(8 * MIN), NOW), 8);
  assert.equal(words.releaseMinutes(next(10 * 1000), NOW), 1);
  assert.equal(words.releaseMinutes(next(-MIN), NOW), null);
  assert.equal(words.releaseMinutes({ state: 'rolling', etaAt: null }, NOW), null);
  assert.equal(words.releaseMinutes({ state: 'waiting', etaAt: null }, NOW), null);
  assert.equal(words.releaseTicking(next(8 * MIN), NOW), true);
  assert.equal(words.releaseTicking(next(-MIN), NOW), false);
  assert.equal(words.releaseTicking(null, NOW), false);
});

test('the words follow the copy rules: no em dash, no "deploy"', () => {
  const cases = [next(8 * MIN), next(30 * 1000), next(-MIN), { state: 'rolling', etaAt: null }, { state: 'waiting', etaAt: null }, { state: 'next', etaAt: null }];
  for (const release of cases) {
    for (const said of [words.releaseSentence(release, NOW), words.releaseShort(release, NOW), words.releaseCountLine(release, 2, NOW)]) {
      assert.doesNotMatch(said, /\u2014|deploy/i, said);
    }
  }
});

// ── The estimate ─────────────────────────────────────────────────────────

const ETA = (release) => (release && release.etaAt ? Date.parse(release.etaAt) - NOW : null);

test('the gap pending: the running release went out 3 minutes ago, so the next one is 8 minutes off', () => {
  // ready = max(released + gap, merged + build) = max(+7, +4); + rollout.
  const release = releaseWatch.estimate({ releasedAt: at(NOW - 3 * MIN), newestMergedAt: at(NOW - MIN) });
  assert.equal(release.state, 'next');
  assert.equal(ETA(release), 8 * MIN);
  assert.equal(words.releaseSentence(release, NOW), 'Merged; goes live in the next release (about 8 minutes)');
  // The staging demo is exactly this.
  assert.deepEqual(releaseWatch.demoRelease(NOW), release);
  assert.equal(releaseWatch.RELEASE_MIN_GAP_MS, 10 * MIN);
  assert.equal(releaseWatch.RELEASE_BUILD_MS, 5 * MIN);
  assert.equal(releaseWatch.RELEASE_ROLLOUT_MS, MIN);
});

test('the build is the wait when the gap has passed: timed from the merge, or the run\'s own start', () => {
  const released = at(NOW - 30 * MIN);
  // No run read (or none yet): the merge a minute ago, plus the build, plus the rollout.
  assert.equal(ETA(releaseWatch.estimate({ releasedAt: released, newestMergedAt: at(NOW - MIN) })), 5 * MIN);
  // The run is building, started two minutes after the merge (it waited its turn).
  const running = { sha: 'abc', status: 'in_progress', conclusion: null, startedAt: at(NOW + MIN - 2 * MIN), readAt: at(NOW) };
  assert.equal(ETA(releaseWatch.estimate({ releasedAt: released, newestMergedAt: at(NOW - 3 * MIN), run: running })),
    -MIN + 5 * MIN + MIN, 'started a minute ago: four more minutes of build, one of rollout');
  // Still queued when the poller read it: it cannot be built before then plus a build.
  const queued = { sha: 'abc', status: 'queued', conclusion: null, startedAt: null, readAt: at(NOW - MIN) };
  assert.equal(ETA(releaseWatch.estimate({ releasedAt: released, newestMergedAt: at(NOW - 4 * MIN), run: queued })),
    -MIN + 5 * MIN + MIN);
  // It counts down: the same inputs a minute later are a minute closer.
  const release = releaseWatch.estimate({ releasedAt: released, newestMergedAt: at(NOW - MIN) });
  assert.equal(words.releaseSentence(release, NOW), 'Merged; goes live in the next release (about 5 minutes)');
  assert.equal(words.releaseSentence(release, NOW + MIN), 'Merged; goes live in the next release (about 4 minutes)');
});

test('a run that finished green has published: it goes live a rollout after', () => {
  const green = { sha: 'abc', status: 'completed', conclusion: 'success', completedAt: at(NOW - 30 * 1000), readAt: at(NOW) };
  const release = releaseWatch.estimate({ releasedAt: at(NOW - 12 * MIN), newestMergedAt: at(NOW - 9 * MIN), run: green });
  assert.equal(ETA(release), 30 * 1000);
  assert.equal(words.releaseSentence(release, NOW), 'Merged; goes live in the next release (in about a minute)');
  assert.equal(words.releaseSentence(release, NOW + MIN), 'Merged; going live now');
});

test('overdue: past the estimate it says "going live now", not a count that went negative', () => {
  const release = releaseWatch.estimate({ releasedAt: at(NOW - 40 * MIN), newestMergedAt: at(NOW - 20 * MIN) });
  assert.ok(ETA(release) < 0);
  assert.equal(words.releaseSentence(release, NOW), 'Merged; going live now');
});

test('a failed run, or a recorded stall, promises nothing', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'startup_failure']) {
    const red = { sha: 'abc', status: 'completed', conclusion, completedAt: at(NOW - MIN), readAt: at(NOW) };
    assert.deepEqual(releaseWatch.estimate({ releasedAt: at(NOW - 3 * MIN), newestMergedAt: at(NOW - 5 * MIN), run: red }),
      { state: 'waiting', etaAt: null }, conclusion);
  }
  assert.deepEqual(releaseWatch.estimate({ releasedAt: at(NOW - 3 * MIN), newestMergedAt: at(NOW - MIN), stalled: true }),
    { state: 'waiting', etaAt: null });
  // A red run for an older tip says nothing about a merge since: that merge's
  // own run releases it, and is timed from the merge.
  const oldRed = { sha: 'old', status: 'completed', conclusion: 'failure', completedAt: at(NOW - 6 * MIN), readAt: at(NOW - 5 * MIN) };
  const release = releaseWatch.estimate({ releasedAt: at(NOW - 30 * MIN), newestMergedAt: at(NOW - MIN), run: oldRed });
  assert.equal(release.state, 'next');
  assert.equal(ETA(release), 5 * MIN);
});

test('no Actions access (no run recorded): the merge and the gap alone', () => {
  const release = releaseWatch.estimate({ releasedAt: at(NOW - 2 * MIN), newestMergedAt: at(NOW - 2 * MIN), run: null });
  assert.equal(ETA(release), 9 * MIN, 'gap: 8 more minutes, then the rollout');
  // Nothing at all to time it from: no time, still the next release.
  assert.deepEqual(releaseWatch.estimate({}), { state: 'next', etaAt: null });
});

test('releaseOf: a release rolling out now carries what merged before it', () => {
  const view = {
    stalled: false, rolling: true, rollingLate: false,
    through: { at: NOW - 6 * MIN, id: 40 }, releasedAt: NOW - MIN, newestMergedAt: NOW - 30 * 1000, run: null,
  };
  assert.deepEqual(releaseWatch.releaseOf(view, { mergedAt: at(NOW - 8 * MIN), id: 38 }), { state: 'rolling', etaAt: null });
  assert.deepEqual(releaseWatch.releaseOf(view, { mergedAt: at(NOW - 6 * MIN), id: 40 }), { state: 'rolling', etaAt: null });
  // Merged after the release's commit: the release after it, the gap from this one.
  const later = releaseWatch.releaseOf(view, { mergedAt: at(NOW - 30 * 1000), id: 41 });
  assert.equal(later.state, 'next');
  assert.equal(Date.parse(later.etaAt) - NOW, -MIN + 10 * MIN + MIN);
  // A release no merge made (a direct push): what merged before its migration.
  const pushed = { ...view, through: null };
  assert.equal(releaseWatch.releaseOf(pushed, { mergedAt: at(NOW - 2 * MIN), id: 41 }).state, 'rolling');
  assert.equal(releaseWatch.releaseOf(pushed, { mergedAt: at(NOW - 30 * 1000), id: 42 }).state, 'next');
  // Rolling for longer than a rollout takes: no promise.
  assert.deepEqual(releaseWatch.releaseOf({ ...view, rollingLate: true }, { mergedAt: at(NOW - 8 * MIN), id: 38 }),
    { state: 'waiting', etaAt: null });
  assert.equal(releaseWatch.releaseOf(null, { mergedAt: at(NOW), id: 1 }), null);
});

// ── Reading it: once per process, never from GitHub ──────────────────────

const RUNNING = '741b8f75b9ce10a3c10cb60f4a0f72e5c48bd24c';
const INCOMING = '7817d05e0169594c5ad3affea1afd5af51521a5c';

function selfPool({ self = {}, pending = [], carried = false, boundary = null, fail = false } = {}) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      sql = String(sql);
      queries.push({ sql, params });
      if (fail) throw new Error('connection refused');
      if (/FROM apps a\s+LEFT JOIN LATERAL/.test(sql)) {
        return { rows: [{ id: 1, main_sha: RUNNING, last_deploy_at: new Date(NOW - 3 * MIN), release_stall: null,
          release_run: null, newest_at: new Date(NOW - MIN), ...self }] };
      }
      if (/cs\.id = ANY\(\$1::int\[\]\)/.test(sql)) {
        // The SQL keeps only merged, not live, self-hosted changes.
        assert.match(sql, /cs\.status = 'merged' AND cs\.live_at IS NULL AND a\.self_hosted = TRUE/);
        return { rows: pending.filter((p) => params[0].includes(p.id)) };
      }
      if (/FROM chat_sessions recorded/.test(sql)) return { rows: carried ? [{ '?column?': 1 }] : [] };
      if (/LOWER\(merge_commit_sha\) = LOWER\(\$2\)/.test(sql)) return { rows: boundary ? [boundary] : [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('releasesFor: only the merged, not-live changes of the platform\'s own app get one', async () => {
  releaseWatch._forTest.resetOutlook();
  const pool = selfPool({ pending: [{ id: 7, merged_at: new Date(NOW - MIN) }] });
  const out = await releaseWatch.releasesFor(pool, [7, 8, '7', 0, null, 'x'], { now: NOW, runningSha: RUNNING });
  assert.deepEqual([...out.keys()], [7]);
  assert.deepEqual(out.get(7), { state: 'next', etaAt: at(NOW + 8 * MIN) });
  const changes = pool.queries.find((q) => /cs\.id = ANY/.test(q.sql));
  assert.deepEqual(changes.params, [[7, 8]], 'ids are whole and once each');

  // None asked for: no read at all.
  const quiet = selfPool();
  assert.equal((await releaseWatch.releasesFor(quiet, [], { now: NOW })).size, 0);
  assert.equal(quiet.queries.length, 0);
  // None of them waiting for a release (a child app's, or still merging): no outlook read.
  releaseWatch._forTest.resetOutlook();
  const none = selfPool();
  assert.equal((await releaseWatch.releasesFor(none, [9], { now: NOW, runningSha: RUNNING })).size, 0);
  assert.equal(none.queries.filter((q) => /FROM apps a/.test(q.sql)).length, 0);
  // A read that fails is no answer, never a throw.
  assert.equal((await releaseWatch.releasesFor(selfPool({ fail: true }), [7], { now: NOW })).size, 0);
});

test('outlook: the self-hosted row read once per process every 15 seconds, whoever asks', async () => {
  releaseWatch._forTest.resetOutlook();
  const pool = selfPool();
  const a = await releaseWatch.outlook(pool, { now: NOW, runningSha: RUNNING });
  const b = await releaseWatch.outlook(pool, { now: NOW + 14 * 1000, runningSha: RUNNING });
  assert.equal(a, b);
  assert.equal(pool.queries.length, 1);
  await releaseWatch.outlook(pool, { now: NOW + releaseWatch._forTest.OUTLOOK_TTL_MS, runningSha: RUNNING });
  assert.equal(pool.queries.length, 2, 'read again once it is 15 seconds old');
  assert.deepEqual({ ...a, run: a.run }, {
    appId: 1, stalled: false, rolling: false, rollingLate: false, through: null,
    releasedAt: NOW - 3 * MIN, newestMergedAt: NOW - MIN, run: null,
  });
});

test('outlook: a recorded stall is waiting, unless the running build already carries it', async () => {
  const stall = { sha: INCOMING, kind: 'workflow_failed', since: at(NOW - 5 * MIN), detectedAt: at(NOW - 4 * MIN) };
  releaseWatch._forTest.resetOutlook();
  let view = await releaseWatch.outlook(selfPool({ self: { release_stall: stall } }), { now: NOW, runningSha: RUNNING });
  assert.equal(view.stalled, true);
  assert.deepEqual(releaseWatch.releaseOf(view, { mergedAt: at(NOW - MIN), id: 1 }), { state: 'waiting', etaAt: null });
  releaseWatch._forTest.resetOutlook();
  view = await releaseWatch.outlook(selfPool({ self: { release_stall: stall }, carried: true }), { now: NOW, runningSha: RUNNING });
  assert.equal(view.stalled, false);
});

test('outlook: a newer release whose migration ran (main_sha) is rolling out until this build is it', async () => {
  releaseWatch._forTest.resetOutlook();
  const pool = selfPool({ self: { main_sha: INCOMING, last_deploy_at: new Date(NOW - MIN) }, boundary: { id: 40, at: new Date(NOW - 6 * MIN) } });
  const view = await releaseWatch.outlook(pool, { now: NOW, runningSha: RUNNING });
  assert.equal(view.rolling, true);
  assert.equal(view.rollingLate, false);
  assert.deepEqual(view.through, { at: NOW - 6 * MIN, id: 40 });
  const order = pool.queries.find((q) => /LOWER\(merge_commit_sha\)/.test(q.sql));
  assert.deepEqual(order.params, [1, INCOMING]);
  // The new build answering: nothing is rolling.
  releaseWatch._forTest.resetOutlook();
  assert.equal((await releaseWatch.outlook(selfPool({ self: { main_sha: INCOMING } }), { now: NOW, runningSha: INCOMING })).rolling, false);
  // Rolling for longer than any rollout takes.
  releaseWatch._forTest.resetOutlook();
  const late = await releaseWatch.outlook(selfPool({ self: { main_sha: INCOMING, last_deploy_at: new Date(NOW - 11 * MIN) } }),
    { now: NOW, runningSha: RUNNING });
  assert.equal(late.rollingLate, true);
});

test('outlook: the run the poller recorded is read back, as JSONB or as text', async () => {
  const run = { sha: INCOMING, status: 'in_progress', conclusion: null, startedAt: at(NOW - 2 * MIN), completedAt: null, readAt: at(NOW - MIN) };
  for (const stored of [run, JSON.stringify(run)]) {
    releaseWatch._forTest.resetOutlook();
    const view = await releaseWatch.outlook(selfPool({ self: { release_run: stored, last_deploy_at: new Date(NOW - 20 * MIN), newest_at: new Date(NOW - 3 * MIN) } }),
      { now: NOW, runningSha: RUNNING });
    assert.deepEqual(view.run, run);
    // Started two minutes ago: three more minutes of build and one of rollout.
    assert.equal(ETA(releaseWatch.releaseOf(view, { mergedAt: at(NOW - 3 * MIN), id: 5 })), 4 * MIN);
  }
});

// ── The drift poller records the run it already reads ────────────────────

function actions(run) {
  return {
    rest: { actions: {
      listWorkflowRunsForRepo: async () => ({
        data: { workflow_runs: run ? [{ id: 1, name: 'Build Kubernetes images', path: releaseWatch.WORKFLOW_PATH, html_url: 'https://github.com/x/y/actions/runs/1', ...run }] : [] },
      }),
    } },
  };
}

function writePool() {
  const queries = [];
  return { queries, query: async (sql, params) => { queries.push({ sql: String(sql), params }); return { rows: [], rowCount: 1 }; } };
}

const SELF = {
  id: 10, slug: 'usernode-2d5619', self_hosted: true, main_sha: RUNNING,
  repo_url: 'https://github.com/Usernode-Labs/social-vibecoding', release_stall: null, release_run: null,
};
const HEAD = { sha: INCOMING, committedAt: at(NOW - 2 * MIN), subject: 'Say when the next release goes live (#4600)' };

test('observe records the release run for main\'s tip on every read; none read, none written', async () => {
  releaseWatch._forTest.resetFirstSeen();
  const pool = writePool();
  await releaseWatch.observe({}, pool, SELF, HEAD, {
    now: NOW, octokit: actions({ status: 'in_progress', conclusion: null, run_started_at: at(NOW - MIN) }),
  });
  const write = pool.queries.find((q) => /SET release_run = \$1 WHERE id = \$2/.test(q.sql));
  assert.ok(write, 'the run is recorded');
  assert.deepEqual(JSON.parse(write.params[0]), {
    sha: INCOMING, status: 'in_progress', conclusion: null, startedAt: at(NOW - MIN), completedAt: null, readAt: at(NOW),
  });
  assert.equal(write.params[1], 10);

  // No run listed (a token that cannot read Actions): nothing to record, and
  // nothing written over an empty column.
  const none = writePool();
  await releaseWatch.observe({}, none, SELF, HEAD, { now: NOW, octokit: actions(null) });
  assert.equal(none.queries.filter((q) => /release_run/.test(q.sql)).length, 0);
  // ...but a stale record is cleared.
  const stale = writePool();
  await releaseWatch.observe({}, stale, { ...SELF, release_run: { sha: 'x', readAt: at(NOW - 9 * MIN) } }, HEAD, { now: NOW, octokit: actions(null) });
  assert.deepEqual(stale.queries.find((q) => /SET release_run = \$1/.test(q.sql)).params, [null, 10]);
  // No GitHub client at all: nothing read, nothing written.
  const offline = writePool();
  await releaseWatch.observe({}, offline, SELF, HEAD, { now: NOW, octokit: null });
  assert.equal(offline.queries.filter((q) => /release_run/.test(q.sql)).length, 0);
});

test('converged clears the recorded run with the stall', async () => {
  const pool = writePool();
  await releaseWatch.converged({}, pool, { ...SELF, main_sha: INCOMING, release_run: { sha: INCOMING, readAt: at(NOW) } });
  assert.ok(pool.queries.some((q) => /SET release_run = NULL WHERE id = \$1 AND release_run IS NOT NULL/.test(q.sql)));
  const quiet = writePool();
  await releaseWatch.converged({}, quiet, { ...SELF, main_sha: INCOMING });
  assert.equal(quiet.queries.length, 0, 'nothing recorded, nothing written');
});

test('the drift poller reads the column the watch clears', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'services', 'main-drift-poller.js'), 'utf8');
  assert.match(src, /SELECT id, slug, repo_url, main_sha, self_hosted, release_stall, release_run,/);
  const schema = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE apps ADD COLUMN IF NOT EXISTS release_run JSONB;/);
});
