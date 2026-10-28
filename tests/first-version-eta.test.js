'use strict';

// Newcomer run six (14 Oct 2026): a first version took about 23 minutes from
// Make it to live, so people put the phone down while it built, and its App
// tab only ever said how long it had run ("Building it · 2 min so far"). The
// approved changes for building while you are away:
//
//   1. Time left, not time so far: an estimate from the first versions that
//      went live lately (services/first-version-eta.js), counted down on the
//      build line and under the step under way
//      (frontend/src/features/app-frame/first-version-eta.ts).
//   2. The maker's footer is a promise with a small check: "We’ll notify you
//      when it’s live".
//   3. Live is the default picture once the app has booted, an explicit
//      choice sticks per project, and the live picture fits the phone
//      frame's width (live-switch.tsx, live-band.tsx).
//   4. On the App tab Safari's status strip follows the App tab's own bar,
//      not the hub's teal (public/css/app.css).
//   5. Back from the background, the screen asks the server at once.
//
// tests/first-version-eta-postgres.test.js runs the samples' query on a
// real database.
//
// Run with: node --test tests/first-version-eta.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const eta = require('../src/services/first-version-eta');

const MIN = 60000;
const T0 = Date.parse('2026-10-14T10:00:00Z');
const at = (min) => new Date(T0 + min * MIN).toISOString();

/**
 * A finished first version's records, its steps taking these minutes:
 * screens, build, check (null: no review), test, live.
 */
function row({ screens = 4, build = 9, check = 5, test = 3, live = 1, config = 1, firstLook = true, wait = 0 } = {}) {
  let t = 0;
  const decided = at(t); t += screens;
  const look = at(t); t += build;
  const review = check == null ? null : at(t); t += check || 0;
  const proposal = at(t); t += test;
  const checks = at(t - 0.5); t += wait;
  const merged = at(t); t += live;
  return {
    config_id: config,
    decided_at: decided,
    first_look_at: firstLook ? look : null,
    spec_at: firstLook ? null : look,
    review_at: review,
    proposal_at: proposal,
    checks_at: checks,
    merged_at: merged,
    live_at: at(t),
  };
}

const samples = (rows) => rows.map(eta.sampleOf);

/** The step list, as homeroom-bot-progress.js firstVersionSteps answers it, with `key` under way since `since`. */
function stepsAt(key, since) {
  const keys = ['plan', 'screens', 'build', 'check', 'test', 'live'];
  const i = keys.indexOf(key);
  return keys.map((k, j) => (j < i ? { key: k, state: 'done' } : j === i ? { key: k, state: 'now', ...(since ? { since } : {}) } : { key: k, state: 'next' }));
}

// ── 1. The estimate, on the server ──────────────────────────────────────

test('a finished first version is timed between the records its step list counts from', () => {
  const s = eta.sampleOf(row({ screens: 4, build: 9, check: 5, test: 3, live: 1, config: '7' }));
  assert.deepEqual(s, { configId: 7, steps: { screens: 4 * MIN, build: 9 * MIN, check: 5 * MIN, test: 3 * MIN, live: 1 * MIN } });
  // No first look: the screens end with the build's plan posted.
  assert.equal(eta.sampleOf(row({ firstLook: false, screens: 6 })).steps.screens, 6 * MIN);
  // No review ran: the step took no time, and the build ends at the proposal.
  const unreviewed = eta.sampleOf(row({ check: null, build: 11 }));
  assert.equal(unreviewed.steps.check, 0);
  assert.equal(unreviewed.steps.build, 11 * MIN);
  // A merge long after its checks waited on a person's vote: not a test time.
  assert.equal(eta.sampleOf(row({ wait: 40 })).steps.test, null);
  assert.equal(eta.sampleOf(row({ wait: 2 })).steps.test, 5 * MIN, 'the minute or two it takes to merge on its own counts');
  // A stall of hours is not a duration to expect; a missing record times nothing.
  assert.equal(eta.sampleOf(row({ build: 7 * 60 })).steps.build, null);
  assert.equal(eta.sampleOf({ ...row(), decided_at: null }).steps.screens, null);
  assert.equal(eta.sampleOf({ ...row(), config_id: null }).configId, null);
});

test('the median, not the mean: one slow build does not move it', () => {
  assert.equal(eta.median([3, 1, 2]), 2);
  assert.equal(eta.median([4, 1, 3, 2]), 3, 'even: the middle two, rounded');
  assert.equal(eta.median([]), null);
  assert.equal(eta.median([5, NaN, null]), 5);
  const pool = samples([row({ build: 8 }), row({ build: 9 }), row({ build: 10 }), row({ build: 11 }), row({ build: 90 })]);
  assert.equal(eta.stepMedians(pool).build, 10 * MIN, 'the 90-minute build is one of five');
});

test('the same bot configuration is preferred once it has enough first versions', () => {
  const old = Array.from({ length: 6 }, () => row({ build: 20, config: 1 }));
  const four = Array.from({ length: 4 }, () => row({ build: 6, config: 2 }));
  let pool = eta.poolFor(samples([...old, ...four]), 2);
  assert.equal(pool.sameConfig, false, `${eta.MIN_SAME_CONFIG} needed`);
  assert.equal(pool.samples.length, 10, 'too few of its own: all of them');
  const five = [...four, row({ build: 6, config: 2 })];
  pool = eta.poolFor(samples([...old, ...five]), 2);
  assert.equal(pool.sameConfig, true);
  assert.equal(pool.samples.length, 5);
  assert.equal(eta.stepMedians(pool.samples).build, 6 * MIN);
  assert.equal(eta.poolFor(samples(old), null).sameConfig, false, 'no configuration known: all');
  // And the estimate says which it used.
  const e = eta.estimate(samples([...old, ...five]), { configId: 2, steps: stepsAt('build', at(100)), now: T0 + 101 * MIN });
  assert.equal(e.sameConfig, true);
  assert.equal(e.samples, 5);
  assert.equal(e.stepEtaAt, at(106));
});

test('the estimate counts down from when the step under way began, to its end and to live', () => {
  const pool = samples([row(), row(), row()]);
  // Building since minute 100: 9 to go in the step, then 5 + 3 + 1.
  const e = eta.estimate(pool, { steps: stepsAt('build', at(100)), now: T0 + 103 * MIN });
  assert.deepEqual(e, {
    step: 'build',
    stepEtaAt: at(109),
    etaAt: at(118),
    stepRemainingMs: 6 * MIN,
    remainingMs: 15 * MIN,
    samples: 3,
    sameConfig: false,
  });
  // The same answer later says less: it counts down, it is not re-anchored.
  const later = eta.estimate(pool, { steps: stepsAt('build', at(100)), now: T0 + 108 * MIN });
  assert.equal(later.etaAt, e.etaAt);
  assert.equal(later.remainingMs, 10 * MIN);
  // Past its own end it never goes below zero; the browser says "longer".
  const over = eta.estimate(pool, { steps: stepsAt('build', at(100)), now: T0 + 130 * MIN });
  assert.equal(over.stepRemainingMs, 0);
  assert.equal(over.remainingMs, 0);
  // The screens step counts every step after it; the last counts only itself.
  assert.equal(eta.estimate(pool, { steps: stepsAt('screens', at(0)), now: T0 }).etaAt, at(22));
  assert.equal(eta.estimate(pool, { steps: stepsAt('live', at(50)), now: T0 }).etaAt, at(51));
});

test('no data, no estimate: too few first versions, a step nobody timed, no start, or a plan waiting on its maker', () => {
  const two = samples([row(), row()]);
  assert.equal(eta.estimate(two, { steps: stepsAt('build', at(0)), now: T0 }), null, `fewer than ${eta.MIN_SAMPLES}`);
  assert.equal(eta.estimate([], { steps: stepsAt('build', at(0)), now: T0 }), null);
  const untested = samples([row({ wait: 60 }), row({ wait: 60 }), row()]);
  assert.equal(eta.estimate(untested, { steps: stepsAt('build', at(0)), now: T0 }), null, 'a later step with too little data');
  assert.equal(eta.estimate(untested, { steps: stepsAt('live', at(0)), now: T0 }).step, 'live', 'one it does not need');
  const pool = samples([row(), row(), row()]);
  assert.equal(eta.estimate(pool, { steps: stepsAt('build', null), now: T0 }), null, 'no start to count from');
  assert.equal(eta.estimate(pool, { steps: stepsAt('plan', at(0)), now: T0 }), null, 'its plan waits on a person');
  assert.equal(eta.estimate(pool, { steps: null, now: T0 }), null);
  assert.equal(eta.estimate(pool, { steps: stepsAt('build', 'yesterday'), now: T0 }), null);
});

test('the finished first versions are read once per ten minutes, and a failed read says nothing', async () => {
  let reads = 0;
  const rows = [row(), row(), row()];
  const pool = {
    async query(sql, params) {
      if (sql === eta.SAMPLES_SQL) {
        reads += 1;
        assert.deepEqual(params, [eta.WINDOW_DAYS, eta.MAX_SAMPLES]);
        return { rows };
      }
      if (sql === eta.CURRENT_CONFIG_SQL) return { rows: [{ id: 1 }] };
      if (sql === eta.RUN_CONFIG_SQL) {
        assert.deepEqual(params, [5]);
        return { rows: [{ config_id: null }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const steps = stepsAt('build', new Date(Date.now() - 3 * MIN).toISOString());
  const first = await eta.estimateFor(pool, 5, steps);
  assert.equal(first.step, 'build');
  assert.ok(Math.abs(first.remainingMs - 15 * MIN) < 5000, String(first.remainingMs));
  await eta.estimateFor(pool, 5, steps);
  assert.equal(reads, 1, 'cached');
  await eta.samplesFor(pool, Date.now() + eta.CACHE_MS + 1);
  assert.equal(reads, 2, 'read again once it is old');
  // Nothing to estimate: nothing is read.
  const quiet = { query: async () => { throw new Error('read'); } };
  assert.equal(await eta.estimateFor(quiet, 5, stepsAt('plan', at(0))), null);
  // A read that fails: no estimate, and no throw.
  const broken = { query: async () => { throw new Error('connection lost'); } };
  assert.equal(await eta.estimateFor(broken, 5, steps), null);
  eta.forget(pool);
  eta.forget(broken);
});

test('the App tab\'s record carries it while it is built or tested, from its own steps', () => {
  const route = read('src/routes/apps.js');
  assert.match(route, /const estimate = state\.line === 'building' \|\| state\.line === 'testing'\s+\? await require\('\.\.\/services\/first-version-eta'\)\.estimateFor\(pool, appRow\.id, state\.steps\)\s+: null;/);
  assert.match(route, /\.\.\.\(Array\.isArray\(state\.steps\) \? \{ steps: state\.steps \} : \{\}\),\s+\.\.\.\(estimate \? \{ estimate \} : \{\}\),/);
  const view = read('public/js/app-view.js');
  assert.match(view, /const estimate = fv\.estimate && typeof fv\.estimate === 'object' \? fv\.estimate : null;/);
  assert.match(view, /\.\.\.\(steps \? \{ steps \} : \{\}\),\s+\.\.\.\(estimate \? \{ estimate \} : \{\}\),/);
  // Cheap: one query over a capped window, by its indexes, cached per process.
  assert.match(eta.SAMPLES_SQL, /LIMIT \$2::int$/);
  assert.match(eta.SAMPLES_SQL, /cs\.live_at > NOW\(\) - make_interval\(days => \$1::int\)/);
  assert.equal(eta.CACHE_MS, 10 * 60 * 1000);
});

// ── 1. The estimate, on the screen ──────────────────────────────────────

const client = () => loadTsx('frontend/src/features/app-frame/first-version-eta.ts');

test('the screen counts down in whole minutes, never "0", and says plainly when it runs long', () => {
  const m = client();
  const now = T0;
  const e = { step: 'build', stepEtaAt: new Date(now + 12 * MIN + 10000).toISOString(), etaAt: new Date(now + 15 * MIN + 10000).toISOString() };
  assert.deepEqual(m.estimateOf({ ...e, samples: 9, sameConfig: true, remainingMs: 1 }), e, 'cleaned to what the screen reads');
  assert.equal(m.leftNote(e, now), 'about 15 min left');
  assert.equal(m.leftNote(e, now, { step: true }), 'about 12 min left');
  // Run seven: the step under way says no time of its own while it is
  // within its usual time (the line says the one time on the screen).
  assert.equal(m.stepOverrunNote(e, 'build', now), null);
  assert.equal(m.stepOverrunNote(e, 'build', now + 12 * MIN + 10000), 'taking a little longer than usual');
  assert.equal(m.stepOverrunNote(e, 'check', now + 13 * MIN), null, 'only under the step it is for');
  assert.equal(m.stepOverrunNote(null, 'build', now + 13 * MIN), null);
  assert.equal('stepLeftNote' in m, false, 'no step counts down beside the line');
  // Counting down.
  assert.equal(m.leftNote(e, now + 5 * MIN), 'about 10 min left');
  assert.equal(m.leftNote(e, now + 11 * MIN + 50000, { step: true }), 'about 1 min left', 'the last minute is not "0"');
  assert.equal(m.minutesLeft(now + 20000, now), 1);
  assert.equal(m.minutesLeft(now + 14.4 * MIN, now), 14);
  assert.equal(m.minutesLeft(now + 14.6 * MIN, now), 15);
  // Past the step's own estimate: never frozen at 0 or below it. The step
  // says it is taking longer; the line (run seven) goes on counting the
  // later steps' usual time, as if the step under way ended now: 3 minutes.
  for (const later of [now + 12 * MIN + 10000, now + 13 * MIN, now + 60 * MIN]) {
    assert.equal(m.leftNote(e, later), 'about 3 min left');
    assert.equal(m.liveAt(e, later), later + 3 * MIN);
    assert.equal(m.leftNote(e, later, { step: true }), 'taking a little longer than usual');
  }
  assert.equal(m.liveAt(e, now), Date.parse(e.etaAt), 'within the step: the estimate\'s own');
  // No later step left to count (under a minute): only then the line says it.
  const last = { step: 'live', stepEtaAt: new Date(now + 2 * MIN).toISOString(), etaAt: new Date(now + 2 * MIN + 50000).toISOString() };
  assert.equal(m.leftNote(last, now), 'about 3 min left');
  assert.equal(m.leftNote(last, now + 2 * MIN), 'taking a little longer than usual');
  assert.equal(m.liveAt(last, now + 2 * MIN), null);
  const oneMore = { ...last, etaAt: new Date(now + 3 * MIN).toISOString() };
  assert.equal(m.leftNote(oneMore, now + 40 * MIN), 'about 1 min left', 'a later step of a minute is still counted');
  // No estimate: nothing about time left.
  assert.equal(m.leftNote(null, now), null);
  for (const bad of [null, 'soon', {}, { ...e, step: 'nap' }, { ...e, etaAt: 'later' }, { ...e, etaAt: new Date(now).toISOString() }]) {
    assert.equal(m.estimateOf(bad), null, JSON.stringify(bad));
  }
  assert.equal(m.countsDown('building'), true);
  assert.equal(m.countsDown('testing'), true);
  for (const line of ['planning', 'plan', 'ready', 'live', null]) assert.equal(m.countsDown(line), false, String(line));
  // Without a stage named: what it adds and the time left, else the usual.
  assert.equal(m.plainLineNote('Adding the tier rows', null, 'about 15 min left'), 'Adding the tier rows · about 15 min left');
  assert.equal(m.plainLineNote(null, 'usually 10 to 25 min', 'about 15 min left'), 'about 15 min left', 'the estimate replaces the usual');
  assert.equal(m.plainLineNote(null, 'usually 10 to 25 min', null), 'usually 10 to 25 min');
  assert.equal(m.plainLineNote('Adding the tier rows', 'usually 10 to 25 min', null), 'Adding the tier rows');
});

test('the line says the time left in place of the time so far, and the step under way says no time beside it', () => {
  const { phaseLine } = loadTsx('frontend/src/features/first-session/build-line.tsx');
  const now = Date.parse(at(10));
  assert.deepEqual(phaseLine('building', { key: 'building', since: at(3) }, now, null, 'about 15 min left'), { words: 'Building it', note: 'about 15 min left' });
  assert.deepEqual(phaseLine('building', { key: 'building', since: at(3) }, now, 'Adding the ballot bar', 'about 15 min left'),
    { words: 'Building it', note: 'Adding the ballot bar · about 15 min left' });
  assert.deepEqual(phaseLine('building', { key: 'building', since: at(3) }, now), { words: 'Building it', note: '7 min so far' }, 'no estimate: as before');
  const { stepNote } = loadTsx('frontend/src/features/app-frame/first-version-steps.tsx');
  const e = { step: 'check', stepEtaAt: new Date(now + 12 * MIN + 10000).toISOString(), etaAt: new Date(now + 15 * MIN + 10000).toISOString() };
  // Run seven (ONE TIME PER SCREEN): with an estimate the line says the
  // time to live, and the step under way its words only.
  assert.equal(stepNote({ key: 'check', state: 'now', since: at(5) }, now, { phase: { key: 'checking', round: 1, rounds: 2 }, estimate: e }), 'Round 1 of 2');
  assert.equal(stepNote({ key: 'check', state: 'now', since: at(5) }, now, { estimate: e }), null);
  // Past its usual end, it says so.
  const over = now + 13 * MIN;
  assert.equal(stepNote({ key: 'check', state: 'now', since: at(5) }, over, { phase: { key: 'checking', round: 1, rounds: 2 }, estimate: e }), 'Round 1 of 2 · taking a little longer than usual');
  assert.equal(stepNote({ key: 'check', state: 'now', since: at(5) }, over, { estimate: e }), 'taking a little longer than usual');
  assert.equal(stepNote({ key: 'check', state: 'now', since: at(5) }, now, { phase: { key: 'checking', round: 1, rounds: 2 } }), 'Round 1 of 2 · 5 min so far', 'no estimate: as before');
  assert.equal(stepNote({ key: 'build', state: 'now', since: at(5) }, over, { estimate: e }), null, 'an estimate for another step is not this one\'s, and the line has the time');
  assert.equal(stepNote({ key: 'build', state: 'now', since: at(5) }, now, { phase: { key: 'writing' }, estimate: { ...e, step: 'build' } }), 'Working out the details');
  assert.equal(stepNote({ key: 'test', state: 'next' }, now, { estimate: e }), null);
  assert.equal(stepNote({ key: 'screens', state: 'done', minutes: 2 }, now, { estimate: e }), '2 min');
});

// The App tab, as public/js/app-view.js answers it and app-status.tsx draws it.
function makeAppView({ fetchImpl = null, documentImpl = null } = {}) {
  const listeners = new Map();
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentApp: null, currentTab: null },
    document: documentImpl || {
      visibilityState: 'visible',
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: (type, fn) => listeners.set(`doc:${type}`, fn),
      removeEventListener: (type, fn) => { if (listeners.get(`doc:${type}`) === fn) listeners.delete(`doc:${type}`); },
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: (...args) => (fetchImpl ? fetchImpl(...args) : Promise.resolve({ ok: true, json: async () => ({}) })),
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval,
    clearInterval,
    addEventListener: (type, fn) => listeners.set(`win:${type}`, fn),
    removeEventListener: (type, fn) => { if (listeners.get(`win:${type}`) === fn) listeners.delete(`win:${type}`); },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, sandbox, listeners };
}

let statusApi = null;
function html(view) {
  statusApi = statusApi || loadTsx('tests/fixtures/app-status-api.ts');
  statusApi.appStatusStore.set({ view });
  return renderToHtml(createElement(statusApi.AppStatus));
}

function building(fv = {}, app = {}) {
  return {
    slug: 'club-votes', name: 'Club Votes', icon_emoji: '🗳️', description: 'Vote on what the club does next', status: 'running',
    url: 'https://club-votes.example.test', ...app,
    first_version: { building: true, mine: true, step: 4, of: 7, line: 'building', creator: 'ada', ready: false, question: false, conversationId: 42, ...fv },
  };
}

test('on the App tab: "Building it · about 15 min left", and the step under way says no second time', () => {
  const { AppView } = makeAppView();
  const now = Date.now();
  const since = new Date(now - 3 * MIN).toISOString();
  const estimate = { step: 'build', stepEtaAt: new Date(now + 12 * MIN + 20000).toISOString(), etaAt: new Date(now + 15 * MIN + 20000).toISOString(), samples: 9, sameConfig: true };
  const fv = { phase: { key: 'building', since }, steps: stepsAt('build', since), estimate };
  const view = JSON.parse(JSON.stringify(AppView._appStatusView(building(fv))));
  assert.deepEqual(view.estimate, estimate);
  const out = html(view);
  assert.match(out, /data-build-line="building"[^>]*>.*<span class="truncate">Building it · about 15 min left<\/span>/);
  // Run seven: one time on the screen, the line's.
  assert.match(out, /data-step="build" data-step-state="now"[\s\S]*?>Building</);
  assert.equal((out.match(/min left/g) || []).length, 1, 'the line\'s only');
  assert.doesNotMatch(out, /so far|about 12 min left/);
  // Testing too, with no stage named on the line.
  const tested = { phase: { key: 'testing', since }, steps: stepsAt('test', since), estimate: { ...estimate, step: 'test' } };
  const testing = html(JSON.parse(JSON.stringify(AppView._appStatusView(building({ ...tested, line: 'testing', step: 5 })))));
  assert.match(testing, /<span class="truncate">Testing it · about 15 min left<\/span>/);
  assert.equal((testing.match(/min left/g) || []).length, 1, 'the line\'s only');
  // A member's "usually 10 to 25 min" gives way to it.
  const member = { mine: false, conversationId: null, member: true, creator: 'ada', phase: null, steps: null, estimate };
  assert.match(html(JSON.parse(JSON.stringify(AppView._appStatusView(building(member))))), /<span class="truncate">Building it · about 15 min left<\/span>/);
});

test('on the App tab: past its estimate it says so; without one it says the time so far, as before', () => {
  const { AppView } = makeAppView();
  const now = Date.now();
  const since = new Date(now - 20 * MIN).toISOString();
  const late = { step: 'build', stepEtaAt: new Date(now - MIN).toISOString(), etaAt: new Date(now + 8 * MIN).toISOString() };
  const fv = { phase: { key: 'building', since }, steps: stepsAt('build', since) };
  const over = html(JSON.parse(JSON.stringify(AppView._appStatusView(building({ ...fv, estimate: late })))));
  // Run seven: the step says it runs long; the line goes on counting the
  // later steps' usual 9 minutes, as if the build ended now.
  assert.match(over, /<span class="truncate">Building it · about 9 min left<\/span>/);
  assert.match(over, /data-step="build" data-step-state="now"[\s\S]*?>taking a little longer than usual</);
  assert.equal((over.match(/longer than usual/g) || []).length, 1, 'the step\'s only');
  assert.doesNotMatch(over, /-\d+ min|\b0 min/);
  // The last step past its own: no later step to count, so the line says it too.
  const lastLate = { step: 'test', stepEtaAt: new Date(now - MIN).toISOString(), etaAt: new Date(now - MIN + 30000).toISOString() };
  const tested = { phase: { key: 'testing', since }, steps: stepsAt('test', since), estimate: lastLate, line: 'testing', step: 5 };
  const longer = html(JSON.parse(JSON.stringify(AppView._appStatusView(building(tested)))));
  assert.match(longer, /<span class="truncate">Testing it · taking a little longer than usual<\/span>/);
  assert.doesNotMatch(longer, /min left/);
  const none = html(JSON.parse(JSON.stringify(AppView._appStatusView(building(fv)))));
  assert.match(none, /<span class="truncate">Building it · 20 min so far<\/span>/);
  assert.doesNotMatch(none, /min left|longer than usual/);
  // Ready to try: nothing counts down.
  const ready = AppView._appStatusView(building({ ...fv, line: 'ready', estimate: late }));
  assert.doesNotMatch(html(JSON.parse(JSON.stringify(ready))), /longer than usual|min left/);
});

test('the words are whole catalog entries, with descriptions and no em dash', () => {
  const onboarding = JSON.parse(read('frontend/locales/en/onboarding.json'));
  assert.equal(onboarding['buildLine.left_one'].text, 'about {{count}} min left');
  assert.equal(onboarding['buildLine.left_other'].text, 'about {{count}} min left');
  assert.equal(onboarding['buildLine.longer'].text, 'taking a little longer than usual');
  const changes = JSON.parse(read('frontend/locales/en/changes.json'));
  assert.equal(changes['firstVersion.notifyWhenLive'].text, 'We’ll notify you when it’s live');
  for (const entry of [onboarding['buildLine.left_one'], onboarding['buildLine.left_other'], onboarding['buildLine.longer'], changes['firstVersion.notifyWhenLive']]) {
    assert.ok(entry.description.length > 60, entry.text);
    assert.doesNotMatch(`${entry.text} ${entry.description}`, /\u2014/);
  }
});

// ── 2. The footer: a promise, with a small check ────────────────────────

test('the maker\'s footer promises the notification, beside a small check; a member keeps the line, with the promise under it', () => {
  const { AppView } = makeAppView();
  const mine = JSON.parse(JSON.stringify(AppView._appStatusView(building())));
  assert.equal(mine.promise, 'We’ll notify you when it’s live');
  assert.equal('lines' in mine, false, '"It opens here when it’s ready." is gone for them');
  const out = html(mine);
  assert.match(out, /<p data-app-first-version-promise=""[^>]*><svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><span>We’ll notify you when it’s live<\/span><\/p>/);
  assert.doesNotMatch(out, /It opens here when it’s ready/);
  assert.doesNotMatch(out.slice(out.indexOf('data-app-first-version-promise')), /violet-|--accent|bg-/, 'quiet: nothing done is filled');
  // Since 21 Oct 2026 a member is told when it opens too (#4396:
  // project_opened, src/services/project-opened.js): they keep the line,
  // with the promise under it and the notification ask (`ask`).
  const member = JSON.parse(JSON.stringify(AppView._appStatusView(building({ mine: false, conversationId: null, member: true }))));
  assert.equal(member.promise, 'We’ll notify you when it’s live');
  assert.deepEqual(member.lines, ['It opens here when it’s ready.']);
  assert.equal(member.ask, 'project_opens');
  assert.match(read('src/services/homeroom-bot-dm.js'), /require\('\.\/project-opened'\)\.oweTold\(db,/);
  // Its maker is the one Homeroom bot tells it is live, in the bell.
  const dm = read('src/services/homeroom-bot-dm.js');
  assert.match(dm, /live: 'build_live',/);
  assert.match(read('src/services/notifications.js'), /'build_live',/);
});

// ── 3. Live, the default once it has frames, fitted to the frame ────────

test('the live picture fits the phone frame\'s width, as the real screens do: nothing is cut off', () => {
  const band = loadTsx('frontend/src/features/app-frame/live-band.tsx');
  const fit = band.fitRecording({ width: 390, height: 760 });
  // The frame is 125 × 270.
  assert.ok(Math.abs(fit.width * fit.scale - 125) < 1e-9, 'the page\'s whole width, edge to edge');
  assert.ok(Math.abs(fit.scale - 125 / 390) < 1e-9);
  // The real screens: a 390 × 844 picture, object-cover in the same frame.
  const cover = Math.max(125 / 390, 270 / 844);
  assert.ok(Math.abs(fit.scale - cover) < 1e-9, 'the same scale as "Real screen · 1 min ago"');
  assert.ok(fit.height * fit.scale >= 270, 'and as tall as the frame: no strip under it');
  assert.ok(fit.height * fit.scale < 271);
  // It was scaled to the frame's height: 139px of page in a 125px frame.
  assert.ok(390 * (270 / 760) > 125 + 13);
  // A recording of another width fits by its own.
  const wide = band.fitRecording({ width: 430, height: 932 });
  assert.ok(Math.abs(wide.width * wide.scale - 125) < 1e-9);
  assert.equal(band.fitRecording({ width: 0, height: NaN }).width, 390, 'no size yet: the watcher\'s');
  const src = read('frontend/src/features/app-frame/live-band.tsx');
  assert.doesNotMatch(src, /OFFSET_X|FRAME\.height \/ REC\.height/);
  assert.match(src, /style=\{\{ left: 0, width: fit\.width, height: fit\.height, transform: `scale\(\$\{fit\.scale\}\)` \}\}/);
  assert.match(src, /replayer\.on\('resize', \(size\) => \{/);
});

// ── 4. The status strip ─────────────────────────────────────────────────

test('on the App tab and the other screens the document does not scroll, the bar is sticky at the top in an iOS browser tab, so Safari takes its colour, not the hub\'s', () => {
  const css = read('public/css/app.css');
  const block = css.slice(css.indexOf('/* …AND ON THE APP TAB, WHERE THE PAGE IS NOT THE SCROLLER'));
  const rule = block.slice(block.indexOf('*/') + 2, block.indexOf('}') + 1);
  const scope = 'html\\.un-ios\\.web-browser-chrome:not\\(\\[data-community-tint\\]\\):not\\(\\[data-browser-scroller\\]\\)';
  assert.match(rule, new RegExp(`^\\s*${scope} body:has\\(:is\\(([^)]*)\\):not\\(\\.hidden\\)\\) #platform-header,\\s+${scope} body:has\\(#app-view:not\\(\\.hidden\\)\\[data-app-surface="platform"\\]\\) #platform-header \\{\\s+position: sticky;\\s+top: 0;\\s+\\}$`));
  // Run seven (14 Oct 2026): from the hub to Messages the strip stayed teal
  // too. Every other glass-bar route the document does not scroll gets the
  // same sticky bar; none of them is a page scroller (browser-scroll.ts PAGES).
  const sticky = /body:has\(:is\(([^)]*)\):not\(\.hidden\)\) #platform-header,/.exec(rule)[1].split(',').map((id) => id.trim());
  assert.deepEqual(sticky, ['#messages-screen', '#workshop-screen', '#agent-session-screen', '#profile-proposals-screen']);
  const scroll = read('frontend/src/lib/browser-scroll.ts');
  const pages = JSON.parse(/const PAGES = (\[[^\]]*\]);/.exec(scroll)[1].replace(/'/g, '"'));
  assert.deepEqual(pages, ['home-screen', 'browse-screen', 'leaderboard-screen', 'profile-screen', 'settings-screen']);
  const glass = /THE STRIP OVER THE BAR FOLLOWS IT HOME[\s\S]*?body:has\(:is\(([^)]*)\):not\(\.hidden\)\) #platform-header,/.exec(css)[1].split(',').map((id) => id.trim());
  assert.deepEqual(glass.filter((id) => !pages.includes(id.slice(1))), sticky, 'every opaque-ground route that is not a page scroller, and only those');
  // Its ground is the opaque one the strip takes (run three's rule), and the
  // hub keeps its tinted, sticky bar: the strip turns teal there again.
  assert.match(css, /html\.un-ios\.web-browser-chrome:not\(\[data-community-tint\]\) body:has\(#app-view:not\(\.hidden\)\[data-app-surface="platform"\]\) #platform-header \{\s+background-color: var\(--dc-sheet-solid\);\s+\}/);
  assert.match(css, /html\[data-community-tint\] body:has\(#app-view:not\(\.hidden\)\) #platform-header \{[^}]*background-color: var\(--community-tint\);/);
  assert.match(css, /html\[data-browser-scroller\] :is\(#platform-header, #landing-header\) \{\s+position: sticky;/);
  // The App tab is a scroller-less platform page: pageScroller answers only
  // the project's own pages there.
  assert.match(read('frontend/src/lib/browser-scroll.ts'), /return appView\.dataset\.appSurface === 'platform' && visible\('app-content'\)\s+\? visible\('dev-forum-scroll'\) : null;/);
});

// ── 5. Back from the background ─────────────────────────────────────────

test('back from the background, the first version\'s screen asks the server at once, not on its next tick', async () => {
  const calls = [];
  const answer = building({ live: true });
  const { AppView, sandbox, listeners } = makeAppView({
    fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({ app: answer }) }; },
  });
  const app = building();
  sandbox.App.currentApp = 'club-votes';
  sandbox.App.currentTab = 'app';
  AppView.appData = app;
  AppView.renderAppTab = () => {};
  AppView._watchFirstVersion(app);
  assert.equal(typeof listeners.get('doc:visibilitychange'), 'function', 'listening while the watch is armed');
  assert.equal(typeof listeners.get('win:pageshow'), 'function');
  // Hidden: nothing is asked.
  sandbox.document.visibilityState = 'hidden';
  listeners.get('doc:visibilitychange')();
  assert.equal(calls.length, 0);
  // A page's first pageshow is its load, not a return.
  listeners.get('win:pageshow')({ type: 'pageshow', persisted: false });
  assert.equal(calls.length, 0);
  // Visible again: asked now, past every cache.
  sandbox.document.visibilityState = 'visible';
  await listeners.get('doc:visibilitychange')({ type: 'visibilitychange' });
  assert.deepEqual(calls, ['/api/apps/club-votes?status_recheck=1&manifest=summary']);
  assert.equal(AppView.appData, answer, 'the newer record, with Live, is the screen\'s');
  // Off the screen, the listener goes with the watch.
  AppView._stopFirstVersionWatch();
  assert.equal(listeners.has('doc:visibilitychange'), false);
  assert.equal(listeners.has('win:pageshow'), false);
});
