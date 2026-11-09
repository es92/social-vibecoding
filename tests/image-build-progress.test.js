'use strict';

// Image build progress. The "build image" step used to sit for minutes with
// nothing inside it. Now:
//   - on kubernetes the kpack Build's pod runs the buildpack lifecycle as
//     init containers, and their own start/finish stamps give each phase's
//     time; the running phase's log is followed for a detail line;
//   - on docker the builder's step counter is read off the build output;
//   - the staging build hands it on at most once a second, and keeps the
//     finished phases in the timings so the checks trace and the ledger can
//     say which phase a slow build spent its time in;
//   - the topic page draws the phases under the image step with the detail.
//
// Run with: node --test tests/image-build-progress.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { message } = require('./lib/platform-i18n');
const kubernetes = require('../src/services/kubernetes');
const docker = require('../src/services/docker');
const visuals = require('../src/services/visuals');
const staging = require('../src/services/staging');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const T = (s) => `2026-09-07T09:00:${String(s).padStart(2, '0')}Z`;
function pod(states) {
  const names = ['prepare', 'analyze', 'detect', 'restore', 'build', 'export'];
  return {
    spec: { initContainers: names.map((name) => ({ name })) },
    status: {
      initContainerStatuses: names.map((name) => ({ name, state: states[name] || { waiting: {} } })),
      containerStatuses: [{ name: 'completion', state: states.completion || { waiting: {} } }],
    },
  };
}

test('buildPhasesFromPod reads the lifecycle off the pod: finished phases with their times, then the running one', () => {
  const p = kubernetes._buildPhasesFromPodForTest(pod({
    prepare: { terminated: { startedAt: T(0), finishedAt: T(4) } },
    analyze: { terminated: { startedAt: T(4), finishedAt: T(6) } },
    detect: { running: { startedAt: T(6) } },
  }));
  assert.equal(p.phase, 'detect');
  assert.deepEqual(p.phases, [{ name: 'prepare', ms: 4000 }, { name: 'analyze', ms: 2000 }]);
  assert.equal(p.runningSince, T(6));
  const scheduled = kubernetes._buildPhasesFromPodForTest(pod({}));
  assert.equal(scheduled.phase, 'prepare', 'nothing running yet reads as the first phase');
  assert.deepEqual(scheduled.phases, []);
  const all = {};
  for (const [i, n] of ['prepare', 'analyze', 'detect', 'restore', 'build', 'export'].entries()) all[n] = { terminated: { startedAt: T(i), finishedAt: T(i + 1) } };
  const done = kubernetes._buildPhasesFromPodForTest(pod({ ...all, completion: { running: { startedAt: T(9) } } }));
  assert.equal(done.phase, 'completion');
  assert.equal(done.phases.length, 6);
  assert.deepEqual(kubernetes._buildPhasesFromPodForTest(null), { phase: null, phases: [], runningSince: null, order: [] });
});

test('createBuild reports each phase as the pod advances, follows the running phase, and keeps the phases on the result', async () => {
  let reads = 0;
  const follows = [];
  const sinks = [];
  let aborted = 0;
  const pods = [
    pod({ prepare: { running: { startedAt: T(0) } } }),
    pod({ prepare: { terminated: { startedAt: T(0), finishedAt: T(3) } }, build: { running: { startedAt: T(5) } },
      analyze: { terminated: { startedAt: T(3), finishedAt: T(4) } }, detect: { terminated: { startedAt: T(4), finishedAt: T(4) } }, restore: { terminated: { startedAt: T(4), finishedAt: T(5) } } }),
  ];
  const finalPod = pod(Object.fromEntries(['prepare', 'analyze', 'detect', 'restore', 'build', 'export'].map((n, i) => [n, { terminated: { startedAt: T(i), finishedAt: T(i + 2) } }])));
  kubernetes._setClientsForTest({
    custom: {
      async createNamespacedCustomObject() {},
      async getNamespacedCustomObject() {
        reads += 1;
        if (reads >= 3) return { status: { podName: 'bp-pod', conditions: [{ type: 'Succeeded', status: 'True' }], latestImage: 'ghcr.io/x/demo@sha256:1' } };
        return { status: { podName: 'bp-pod', conditions: [] } };
      },
    },
    core: {
      async readNamespacedPod({ name, namespace }) {
        assert.equal(name, 'bp-pod'); assert.equal(namespace, 'social-builds');
        return reads >= 3 ? finalPod : pods[Math.min(reads - 1, pods.length - 1)];
      },
    },
    logs: {
      async log(ns, podName, container, sink) {
        follows.push(container); sinks.push(sink);
        return { abort() { aborted += 1; } };
      },
    },
  });
  const seen = [];
  const t = setTimeout;
  // waitForBuild's status poll (BUILD_POLL_MS), shortened so the test does
  // not wait it out for real.
  global.setTimeout = (fn, ms, ...rest) => t(fn, ms === 1000 ? 5 : ms, ...rest);
  try {
    const run = kubernetes.createBuild({ kubernetes: {
      buildNamespace: 'social-builds', buildServiceAccount: 'sa', repositoryPrefix: 'ghcr.io/x', cacheRepositoryPrefix: 'ghcr.io/c',
      builderImage: 'b@sha256:0', nodeVersion: '22.*', activeDeadlineSeconds: 30,
    } }, {
      app: { id: 1, slug: 'demo', repo_url: 'https://github.com/x/demo' }, revision: 'a'.repeat(40), environment: 'staging', sessionId: 9,
      onProgress: (img) => seen.push(img),
    });
    // WAIT for the build follow, do not guess at it. This was a fixed 8ms
    // sleep against a poll loop compressed to 5ms above — two async round
    // trips that an idle machine finishes inside 8ms and a loaded one does
    // not. When it lost, `follows.indexOf('build')` was -1, `sinks[-1]` was
    // undefined, and the write below was skipped by its own `if` guard; the
    // run then failed on the `detail` assertion forty lines later, naming
    // neither the phase that never started nor the line that was never
    // written. The cap is generous because it is a CAP, not a sleep: the
    // happy path returns on the first check and this test got FASTER.
    const until = async (pred, capMs) => {
      const stop = Date.now() + capMs;
      while (!pred() && Date.now() < stop) await new Promise((r) => t(r, 1));
      return pred();
    };
    assert.ok(await until(() => follows.includes('build'), 5000),
      'the build phase is followed before its log line is written');
    // The build phase's log is being followed by now; a line becomes the detail.
    sinks[follows.indexOf('build')].write("\x1b[36m  Running 'npm ci'\x1b[0m\n");
    const result = await run;
    assert.deepEqual(follows, ['prepare', 'build'], 'each running phase is followed once, in turn');
    assert.ok(seen.some((s) => s.phase === 'prepare' && s.phases.length === 0));
    assert.ok(seen.some((s) => s.phase === 'build' && s.phases.map((p) => p.name).join(',') === 'prepare,analyze,detect,restore'));
    assert.ok(seen.some((s) => s.detail === "Running 'npm ci'"), 'ANSI stripped, trimmed');
    assert.equal(result.phases.length, 6, 'the finished lifecycle with its times');
    assert.equal(result.phases[4].ms, 2000);
    assert.ok(aborted >= 1, 'the follow is closed');
  } finally {
    global.setTimeout = t;
    kubernetes._setClientsForTest(null);
  }
});

test('docker build lines: the classic step counter and BuildKit stage steps', () => {
  assert.deepEqual(docker.parseDockerBuildLine('Step 4/31 : RUN npm ci --production'), { index: 4, total: 31, phase: null, detail: 'RUN npm ci --production' });
  assert.deepEqual(docker.parseDockerBuildLine('#7 [shell 4/9] RUN npm ci --ignore-scripts'), { index: 4, total: 9, phase: 'shell', detail: 'RUN npm ci --ignore-scripts' });
  assert.deepEqual(docker.parseDockerBuildLine('#12 [stage-2 3/12] COPY . .'), { index: 3, total: 12, phase: 'stage-2', detail: 'COPY . .' });
  assert.deepEqual(docker.parseDockerBuildLine('#3 [internal] load metadata for docker.io/library/node:22-alpine'), { index: null, total: null, phase: 'internal', detail: 'load metadata for docker.io/library/node:22-alpine' });
  assert.equal(docker.parseDockerBuildLine(' ---> Using cache'), null);
  assert.equal(docker.parseDockerBuildLine(''), null);
  const src = read('src/services/docker.js');
  assert.match(src, /if \(promise\.child\.stdout\) attachLineObserver\(promise\.child\.stdout, observe\);\n\s+if \(promise\.child\.stderr\) attachLineObserver\(promise\.child\.stderr, observe\);/);
});

test('the staging build hands image progress on once a second, keeps the last one, and records the phases', async () => {
  const calls = [];
  const savedSet = visuals.setChecksBuildProgress;
  const savedNotify = visuals.notifyChecksBuildProgress;
  visuals.setChecksBuildProgress = async () => true;
  visuals.notifyChecksBuildProgress = (_id, build) => calls.push(build);
  const poolMod = require('../src/db/pool');
  const savedGetPool = poolMod.getPool;
  try {
    const timings = { sourceFetchMs: 1000 };
    const r = staging._makeImageProgressReporterForTest({}, { id: 5 }, timings, Date.now());
    r.report({ phase: 'prepare', phases: [], detail: null });
    r.report({ phase: 'prepare', phases: [], detail: 'Cloning' });
    r.report({ phase: 'analyze', phases: [{ name: 'prepare', ms: 3000 }], detail: null });
    assert.equal(calls.length, 1, 'inside the gap: one flush so far');
    assert.equal(calls[0].step, 'image_build');
    assert.equal(calls[0].image.phase, 'prepare');
    await new Promise((res) => setTimeout(res, 1100));
    assert.equal(calls.length, 2, 'the trailing report is delivered');
    assert.equal(calls[1].image.phase, 'analyze');
    assert.deepEqual(r.last().phases, [{ name: 'prepare', ms: 3000 }]);
    r.close();
  } finally {
    visuals.setChecksBuildProgress = savedSet;
    visuals.notifyChecksBuildProgress = savedNotify;
    poolMod.getPool = savedGetPool;
  }
  const src = read('src/services/staging.js');
  assert.match(src, /onProgress: imageProgress\.report,/);
  assert.match(src, /if \(reportedPhases\) timings\.imagePhases = reportedPhases;/);
  assert.match(read('src/services/application-runtime.js'), /kubernetes\.createBuild\(config, \{ app, revision, environment, sessionId, sourceDir, starterTree, onProgress \}\)/);
  const build = visuals.buildProgressFromTimings({ imageBuildMs: 184000, imagePhases: [{ name: 'restore', ms: 20000 }, { name: 'build', ms: 121000.4 }, { name: 'export', ms: 35000 }] });
  assert.deepEqual(build.steps[0], { key: 'image_build', ms: 184000, phases: [{ name: 'restore', ms: 20000 }, { name: 'build', ms: 121000 }, { name: 'export', ms: 35000 }] });
});

// ── the topic page ──────────────────────────────────────────────────────

const APP_VIEW_SRC = read('public/js/app-view.js');
function makeAppView() {
  const sandbox = {
    console, relTime: () => 'just now',
    App: { user: { id: 1 }, currentTab: 'dev', currentSubTab: 'topic' },
    Kudos: { renderButton: () => '' }, DOMPurify: { sanitize: (s) => s },
    document: { getElementById: () => null, querySelector: () => ({ innerHTML: '' }), querySelectorAll: () => ({ forEach: () => {} }), addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }), body: { appendChild() {} }, hidden: false },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} }, location: { search: '', hash: '' }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/merge-status.js')}\n${read('public/js/session-transcript.js')}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 3, activeUsers: 5, locked: false };
  AppView.appData = { slug: 'app' };
  return AppView;
}
const plain = (o) => JSON.parse(JSON.stringify(o));

test('the image step shows its phases and the running phase\'s line while building', () => {
  const AppView = makeAppView();
  const view = AppView._checksProgressView({ checks_progress: { build: {
    step: 'image_build', startedAt: 'x', steps: [{ key: 'source_fetch', ms: 2000 }],
    image: { phase: 'build', phases: [{ name: 'prepare', ms: 3000 }, { name: 'analyze', ms: 1000 }, { name: 'detect', ms: 500 }, { name: 'restore', ms: 20000 }], detail: "Running 'npm ci'" },
  } } });
  assert.equal(view.build.sentence, "Preview build: branch fetched (2s), now building the preview image (running the buildpacks: Running 'npm ci').");
  assert.equal(view.sub, "build: building the preview image (running the buildpacks: Running 'npm ci')");
  const img = plain(view.bar.build[1]);
  assert.equal(img.key, 'image_build');
  assert.deepEqual(img.phases.map((p) => [p.name, p.state, p.ms]), [
    ['prepare', 'done', 3000], ['analyze', 'done', 1000], ['detect', 'done', 500], ['restore', 'done', 20000], ['build', 'now', null], ['export', 'todo', null],
  ]);
  assert.equal(img.detail, "Running 'npm ci'");
  // docker's counter reads as a step of N.
  const dk = AppView._imageProgressView({ phase: 'shell', index: 4, total: 9, detail: 'RUN npm ci' });
  // What it is doing is a whole sentence of its own, not words slotted into another.
  assert.equal(dk.doing.copy.sub, 'changes:progress.build.sub.imageStepInDetail');
  assert.equal(message(dk.doing.copy.sub, dk.doing.values), 'build: building the preview image (step 4 of 9 in shell: RUN npm ci)');
  assert.deepEqual(plain(dk.phases).map((p) => [p.name, p.state]), [['shell', 'now']], 'no invented lifecycle for a stage list it was not given');
});

test('a runtime that reports no phases gets no phase row invented for it', () => {
  // The bug this pins: `names.every(...)` is TRUE for an empty list, so an
  // empty phase report was read as "these are all lifecycle names" and the
  // whole buildpack lifecycle was drawn as pending. This deployment builds
  // previews with docker, which reports a step COUNTER and no phases, so the
  // topic page showed "analyze detect restore build export" during a build
  // where none of those was running.
  const AppView = makeAppView();
  const plain = (o) => JSON.parse(JSON.stringify(o));
  // The exact payload a docker build reported live (proposal 3888).
  const docker = AppView._imageProgressView({ index: 6, phase: null, total: 36, detail: 'COPY frontend ./frontend' });
  assert.deepEqual(plain(docker.phases), [], 'no phases were reported, so none are drawn');
  assert.deepEqual(plain(docker.bar), { ran: 6, expected: 36 }, 'a counter is a fraction, so it draws as a bar');
  assert.equal(docker.doing.copy.sub, 'changes:progress.build.sub.imageStepDetail');
  assert.equal(message(docker.doing.copy.sub, docker.doing.values), 'build: building the preview image (step 6 of 36: COPY frontend ./frontend)');
  // Nothing at all reported: still no invented row.
  assert.deepEqual(plain(AppView._imageProgressView({}).phases), []);
  assert.equal(AppView._imageProgressView({}).bar, null);
  // A REAL lifecycle report still gets its ordering and its pending tail.
  const bp = AppView._imageProgressView({
    phase: 'build',
    phases: [{ name: 'prepare', ms: 3000 }, { name: 'analyze', ms: 1000 }, { name: 'detect', ms: 500 }, { name: 'restore', ms: 20000 }],
    detail: "Running 'npm ci'",
  });
  assert.deepEqual(plain(bp.phases).map((x) => [x.name, x.state]), [
    ['prepare', 'done'], ['analyze', 'done'], ['detect', 'done'], ['restore', 'done'], ['build', 'now'], ['export', 'todo'],
  ]);
  assert.equal(bp.bar, null, 'a lifecycle has no counter to draw a bar from');
});

test('the preview image builds with BuildKit, and falls back rather than failing the fleet', async () => {
  // The classic builder runs the Dockerfile's two independent stages one
  // after the other; BuildKit runs them together. The risk of the swap is a
  // daemon that cannot do it — which must cost one retry, not every preview.
  const cp = require('child_process');
  const util = require('node:util');
  const cpPath = require.resolve('child_process');
  const dockerPath = require.resolve('../src/services/docker');
  const origCp = require.cache[cpPath];
  const origDocker = require.cache[dockerPath];
  const calls = [];
  let failFirstWith = null;
  const fakeExecFile = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, buildkit: (opts.env || {}).DOCKER_BUILDKIT });
    const child = { stdout: null, stderr: null };
    const p = (calls.length === 1 && failFirstWith)
      ? Promise.reject(Object.assign(new Error('build failed'), { stderr: failFirstWith }))
      : Promise.resolve({ stdout: '', stderr: '' });
    p.child = child;
    return p;
  };
  fakeExecFile[util.promisify.custom] = fakeExecFile;
  require.cache[cpPath] = {
    id: cpPath, filename: cpPath, loaded: true, paths: [], exports: { ...cp, execFile: fakeExecFile },
  };
  delete require.cache[dockerPath];
  try {
    const docker = require(dockerPath);
    // Default: BuildKit, with plain progress so the output stays parseable.
    const out = await docker.buildImage('/ctx', 'img:1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].buildkit, '1');
    assert.ok(calls[0].args.includes('--progress=plain'), 'the redrawing renderer would blind the step observer');
    assert.equal(out.buildKit, true);

    // A BROKEN DOCKERFILE is not a builder problem: it must fail once.
    // Ordered before the fallback because the refusal below is remembered.
    calls.length = 0;
    failFirstWith = 'ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code 1';
    await assert.rejects(docker.buildImage('/ctx', 'img:2'), (err) => {
      assert.equal(err.buildFailed, true, 'still carries the diagnosable tail');
      return true;
    });
    assert.equal(calls.length, 1, 'a failing build is never built twice');

    // A daemon without buildx: ONE retry on the classic builder. This is
    // the message docker actually prints, word for word. The first version
    // of this test asserted a sentence nobody had observed, so the matcher
    // and the test agreed with each other and not with docker, and every
    // preview on a host without buildx failed outright.
    calls.length = 0;
    failFirstWith = 'ERROR: BuildKit is enabled but the buildx component is missing or broken.';
    const fell = await docker.buildImage('/ctx', 'img:3');
    assert.equal(calls.length, 2, 'retried once');
    assert.deepEqual(calls.map((c) => c.buildkit), ['1', '0']);
    assert.ok(!calls[1].args.includes('--progress=plain'), 'the classic builder is not given a BuildKit flag');
    assert.equal(fell.buildKit, false);

    // And it is remembered: the next image goes straight to the classic
    // builder rather than paying the refusal again.
    calls.length = 0;
    failFirstWith = null;
    const after = await docker.buildImage('/ctx', 'img:4');
    assert.equal(calls.length, 1, 'no second refusal');
    assert.deepEqual(calls.map((c) => c.buildkit), ['0']);
    assert.equal(after.buildKit, false);

    // The refusal wordings, and the failures that are NOT one.
    for (const stderr of [
      'ERROR: BuildKit is enabled but the buildx component is missing or broken.',
      'ERROR: BuildKit is enabled but the buildkit component is inoperable',
      "docker: 'buildx' is not a docker command.",
      'buildkit not supported by daemon',
    ]) assert.equal(docker.buildKitUnavailable({ stderr }), true, stderr);
    assert.equal(docker.buildKitUnavailable({ stderr: 'npm ERR! code ELIFECYCLE' }), false);
    assert.equal(docker.buildKitUnavailable({ stderr: 'ERROR: failed to solve: npm ci exit code 1' }), false);
    assert.equal(docker.buildKitUnavailable({}), false);
  } finally {
    if (origCp) require.cache[cpPath] = origCp; else delete require.cache[cpPath];
    delete require.cache[dockerPath];
    if (origDocker) require.cache[dockerPath] = origDocker;
  }
});

test('BuildKit can be turned off without a code change', () => {
  const src = read('src/services/docker.js');
  assert.match(src, /const v = String\(process\.env\.STAGING_BUILDKIT \?\? '1'\)/);
  assert.match(src, /DOCKER_BUILDKIT: useBuildKit \? '1' : '0'/);
  // BuildKit's own step format is the one the observer already reads.
  assert.deepEqual(require('../src/services/docker').parseDockerBuildLine('#7 [shell 4/9] RUN npm ci --ignore-scripts'),
    { index: 4, total: 9, phase: 'shell', detail: 'RUN npm ci --ignore-scripts' });
});

test('the five-step pipeline draws as a segmented bar', () => {
  const tsx = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(tsx, /className="dev-ledger-build-bar"/);
  assert.match(tsx, /data-build-progress=\{`\$\{doneCount\}\/\$\{steps\.length\}`\}/);
  assert.match(tsx, /<span key=\{s\.key\} className=\{`dev-ledger-build-seg is-\$\{s\.state\}`\} data-step=\{s\.key\} \/>/);
  assert.match(tsx, /const doneCount = steps\.filter\(\(s\) => s\.state === 'done'\)\.length;/);
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-ledger-build-seg \{[^}]*flex: 1 1 0;/, 'equal widths: a position, not a prediction');
  assert.match(css, /\.dev-ledger-build-seg\.is-done \{ background: var\(--dc-ok, #16a34a\); \}/);
  assert.match(css, /\.dev-ledger-build-seg\.is-now \{[^}]*animation:/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\n\s+\.dev-ledger-build-seg\.is-now \{ animation: none; \}/);
});

test('the build rows separate their labels with real text, not only a flex gap', () => {
  const tsx = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  // A separator that exists only in CSS is invisible to a copy, a screen
  // reader, and any render that arrives before the stylesheet.
  assert.match(tsx, /\{i > 0 \? <span className="dev-ledger-build-sep"> · <\/span> : null\}/);
  assert.equal((tsx.match(/dev-ledger-build-sep/g) || []).length, 2, 'both the step row and the phase row');
  assert.match(read('public/css/app.css'), /\.dev-ledger-build-sep \{ opacity: 0\.45; \}/);
});

test('a docker build records which step cost the time', async () => {
  // "image build: 3m 4s" is not a diagnosis. A step's cost is the gap
  // between its line and the next one's, so the slowest few name themselves.
  let clock = 1000;
  const timings = {};
  const saved = { set: visuals.setChecksBuildProgress, notify: visuals.notifyChecksBuildProgress };
  visuals.setChecksBuildProgress = async () => true;
  visuals.notifyChecksBuildProgress = () => {};
  try {
    const r = staging._makeImageProgressReporterForTest({}, { id: 5 }, timings, clock, () => clock);
    const step = (index, detail, ms) => { r.report({ index, total: 36, detail }); clock += ms; };
    step(1, 'FROM node:22-alpine AS shell', 500);
    step(2, 'COPY frontend/package.json frontend/package-lock.json ./', 1000);
    step(3, 'RUN npm ci --ignore-scripts', 61000);
    step(4, 'COPY frontend ./frontend', 2000);
    step(5, 'RUN node frontend/scripts/build-shell.mjs', 34000);
    step(6, 'RUN npm ci --production', 45000);
    r.close();
    const slow = r.slowestSteps();
    assert.deepEqual(slow.map((x) => x.name), [
      'RUN npm ci --ignore-scripts', 'COPY frontend ./frontend', 'RUN node frontend/scripts/build…', 'RUN npm ci --production',
    ], 'the slowest four, back in the order they ran');
    assert.deepEqual(slow.map((x) => x.ms), [61000, 2000, 34000, 45000]);
    // A long instruction is truncated to stay a label.
    assert.equal(staging._imageStepLabelForTest('RUN npm ci --no-audit --no-fund --loglevel=error', 3).length, 32);
    assert.equal(staging._imageStepLabelForTest('', 7), 'step 7');
    // Nothing counted (the kpack path) reports nothing rather than an empty row.
    const empty = staging._makeImageProgressReporterForTest({}, { id: 6 }, {}, clock, () => clock);
    empty.close();
    assert.equal(empty.slowestSteps(), null);
  } finally {
    visuals.setChecksBuildProgress = saved.set;
    visuals.notifyChecksBuildProgress = saved.notify;
  }
  const src = read('src/services/staging.js');
  assert.match(src, /const countedSteps = reportedPhases \? null : imageProgress\.slowestSteps\(\);/);
  assert.match(src, /else if \(countedSteps && countedSteps\.length\) timings\.imagePhases = countedSteps;/);
});

test('the finished image step names its phases so a slow build says where the time went', () => {
  const AppView = makeAppView();
  const view = AppView._checksProgressView({ checks_progress: { ran: 1, passed: 1, failed: 0, expected: 5, build: {
    step: 'done', totalMs: 200000,
    steps: [{ key: 'source_fetch', ms: 2000 }, { key: 'image_build', ms: 184000, phases: [{ name: 'restore', ms: 20000 }, { name: 'build', ms: 121000 }, { name: 'export', ms: 35000 }] }, { key: 'clone', ms: 2000, via: 'template' }, { key: 'health', ms: 7000 }],
  } } });
  assert.equal(view.build.sentence, 'Preview built in 3m 20s: branch fetched (2s), image built (3m 4s: restore 20s, build 2m 1s, export 35s), database cloned from template (2s), preview started (7s).');
  const img = plain(view.bar.build[1]);
  assert.deepEqual(img.phases.map((p) => [p.name, p.state, p.ms]), [['restore', 'done', 20000], ['build', 'done', 121000], ['export', 'done', 35000]]);
  const tsx = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(tsx, /className="dev-ledger-build-phases" data-image-phase=\{nowPhase \? nowPhase\.name : 'done'\}/);
  assert.match(tsx, /\{withPhases\.detail \? <span className="dev-ledger-build-detail">\{withPhases\.detail\}<\/span> : null\}/);
  assert.match(read('frontend/src/features/dev-board/topic/model.ts'), /phases\?: LedgerBuildPhase\[\] \| null;/);
  assert.match(read('public/css/app.css'), /\.dev-ledger-build-detail \{/);
});

test('the standalone image keeps the Docker CLI and pins the patched Buildx binary', () => {
  const source = read('Dockerfile');
  assert.match(source, /FROM docker:29\.9\.2-cli AS docker-tools/);
  assert.match(source, /FROM docker\/buildx-bin:0\.39\.0-rc1@sha256:a765b549a3ac9bc905152f4387c2f03763930a9b08020b9c3eae1c9d3290f559 AS buildx-tools/);
  assert.match(source, /COPY --from=docker-tools \/usr\/local\/bin\/docker \/usr\/local\/bin\/docker/);
  assert.match(source, /COPY --from=buildx-tools \/buildx \/usr\/local\/libexec\/docker\/cli-plugins\/docker-buildx/);
  assert.doesNotMatch(source, /^RUN apk add[^\n]*docker-cli/m, 'do not also ship the older Go binaries');
});
