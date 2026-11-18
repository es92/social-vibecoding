// #439 front-end: AppView.ensureStaging opens the "spinning back up" loader
// and, when the server says `rebuilding`, parks a pending marker that the
// staging_ready / staging_failed WS path (onStagingRebuildResult) resolves —
// opening the NEW url on success or showing the failure in the loader. Also
// guards that a `ready` response opens immediately and a `demo` response
// shows the unavailable copy.
//
// #816 extends this to the thing the user actually complained about: a
// preview that is already live must not be fronted by a screen promising a
// 20–60 second rebuild. The added cases pin that the rebuild copy appears
// ONLY on the `rebuilding` branch, that a server-verified `ready` response
// skips the readiness poll entirely (zero probe fetches) and drives the
// iframe off its own load event, and that the fallback poll keeps its
// tightened schedule and makes no claims about TLS.
//
// app-view.js is a plain browser script (`const AppView = {…}`). We load it
// into a vm context with a DOM stub for the staging overlay elements, spy on
// swapToStaging, and assert on the loader text + which url gets opened.
//
// Run with: node --test tests/ensure-staging-preview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

// Minimal DOM stub: the staging overlay + loader elements ensureStaging
// touches, each recording the bits the assertions read.
function makeDom() {
  const els = {};
  const mk = (id) => {
    const el = {
      id, _text: '', _src: '',
      classList: { _hidden: true, add() { this._hidden = true; }, remove() { this._hidden = false; }, toggle(_c, v) { this._hidden = !!v; } },
      set textContent(v) { this._text = v; }, get textContent() { return this._text; },
      set src(v) { this._src = v; }, get src() { return this._src; },
      set innerHTML(_v) {}, get innerHTML() { return ''; },
      onclick: null, style: {},
      setAttribute() {}, removeAttribute() {},
      querySelector: () => null, querySelectorAll: () => ({ forEach() {} }),
      appendChild() {},
    };
    els[id] = el;
    return el;
  };
  ['staging-overlay', 'staging-iframe', 'staging-back', 'staging-loader',
    'staging-loader-title', 'staging-loader-sub', 'staging-url-label',
    'staging-test-btn', 'staging-retry-btn', 'staging-testing-panel'].forEach(mk);
  return {
    els,
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      createElement: () => mk('tmp-' + Math.random()),
      body: { appendChild() {} },
    },
  };
}

// `stubSwap: false` keeps the REAL swapToStaging so the verified fast path /
// fallback poll can be exercised end to end (#816).
function makeAppView(fetchImpl, { stubSwap = true, uiTelemetry = null } = {}) {
  const dom = makeDom();
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    console,
    relTime: () => 'now',
    App: { user: { id: 1 }, currentTab: 'dev' },
    Kudos: { renderButton: () => '' },
    UITelemetry: uiTelemetry || undefined,
    document: dom.document,
    fetch: fetchImpl,
    alert: () => {},
    // unref'd so a still-pending safety timeout (the iframe load watchdog)
    // can't hold the test process open after its case has passed.
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout, setInterval, clearInterval,
    AbortController, URL,
    // The real swapToStaging normalises the url through dev-host.js and
    // composes the iframe src with the URL API.
    resolveDevHost: (u) => u,
    location: { origin: 'https://platform.example', hostname: 'platform.example' },
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'usernode-2d5619', self_hosted: true };
  AppView._tokenFresh = { slug: AppView.appData.slug, token: 'test-token', at: Date.now() };
  // Spy on swapToStaging — the terminal "open the iframe" step. We don't want
  // its real readiness machinery, just to know it was called and with what.
  const swaps = [];
  if (stubSwap) {
    AppView.swapToStaging = (url, testing, opts) => { swaps.push({ url, testing, opts }); };
  }
  return { AppView, dom, swaps, sandbox };
}

const okJson = (body) => async () => ({ ok: true, json: async () => body });

test('ensureStaging opens immediately when the server says {ready}', async () => {
  const { AppView, dom, swaps } = makeAppView(okJson({ status: 'ready', url: 'https://live.example' }));
  await AppView.ensureStaging(7, 'https://fallback.example', null, {});
  assert.equal(dom.els['staging-overlay'].classList._hidden, false, 'overlay opened');
  assert.equal(swaps.length, 1, 'swapToStaging called once');
  assert.equal(swaps[0].url, 'https://live.example', 'opens the server-returned live url');
  assert.equal(AppView._pendingStagingPreview, null, 'no pending marker on the ready path');
});

test('ensureStaging shows the "spinning back up" loader and waits on {rebuilding}', async () => {
  let requests = 0;
  const { AppView, dom, swaps } = makeAppView(async () => ({
    ok: true,
    json: async () => (++requests === 1
      ? { status: 'rebuilding' }
      : { status: 'ready', url: 'https://rebuilt-NEW.example', verified: true }),
  }));
  const APP = { slug: 'usernode-2d5619', self_hosted: true };
  await AppView.ensureStaging(7, 'https://stale.example', { md: 'do x', path: '/x' }, { app: APP });
  // Loader is up with the rebuild copy (viewer-neutral since #689 — shared
  // sessions route non-owners through this path too); no swap yet.
  assert.match(dom.els['staging-loader-title'].textContent, /spinning the preview back up/i);
  assert.equal(swaps.length, 0, 'does not open until the rebuild resolves');
  assert.ok(AppView._pendingStagingPreview, 'a pending marker is parked');
  assert.equal(AppView._pendingStagingPreview.sessionId, 7);
  assert.equal(AppView._pendingStagingPreview.app, APP, 'the app the open was asked for is parked with it');

  // staging_ready lands → re-verifies through ensure-staging, then opens the
  // NEW url (not the stale fallback).
  await AppView.onStagingRebuildResult(7, { url: 'https://rebuilt-NEW.example' });
  assert.equal(requests, 2, 'rebuild completion is verified before navigation');
  assert.equal(swaps.length, 1, 'opens after the rebuild');
  assert.equal(swaps[0].url, 'https://rebuilt-NEW.example', 'uses the fresh url from staging_ready');
  assert.equal(swaps[0].opts.app, APP, 'carries the original open\'s app');
  assert.deepEqual(swaps[0].testing, { md: 'do x', path: '/x' }, 'carries the testing guidance');
  assert.equal(AppView._pendingStagingPreview, null, 'pending marker cleared');
});

test('onStagingRebuildResult surfaces a failed rebuild in the loader (no swap)', async () => {
  const { AppView, dom, swaps } = makeAppView(okJson({ status: 'rebuilding' }));
  await AppView.ensureStaging(7, 'https://stale.example', null, {});
  AppView.onStagingRebuildResult(7, { failed: true, error: 'Missing secret: STRIPE_KEY' });
  assert.equal(swaps.length, 0, 'no preview opened on failure');
  assert.match(dom.els['staging-loader-title'].textContent, /couldn|n.t be rebuilt/i, 'failure title shown');
  assert.match(dom.els['staging-loader-sub'].textContent, /STRIPE_KEY/, 'failure reason surfaced');
  assert.equal(AppView._pendingStagingPreview, null, 'pending marker cleared');
});

test('onStagingRebuildResult ignores a result for a different/stale session', async () => {
  const { AppView, swaps } = makeAppView(okJson({ status: 'rebuilding' }));
  await AppView.ensureStaging(7, 'https://stale.example', null, {});
  AppView.onStagingRebuildResult(999, { url: 'https://other.example' });
  assert.equal(swaps.length, 0, 'unrelated session result is a no-op');
  assert.ok(AppView._pendingStagingPreview, 'our pending marker is untouched');
});

test('ensureStaging shows the demo copy and never opens when {unavailable,demo}', async () => {
  const { AppView, dom, swaps } = makeAppView(okJson({ status: 'unavailable', reason: 'demo' }));
  await AppView.ensureStaging(7, 'https://x.example', null, {});
  assert.equal(swaps.length, 0, 'nothing opened in the demo env');
  assert.equal(dom.els['staging-loader-title'].textContent, message('changes:frame.unavailable.title'));
  assert.match(dom.els['staging-loader-sub'].textContent, /demo/i, 'explains it is the demo env');
});

// ── #3413: a failed preview keeps a reachable retry ─────────────────────
//
// The terminal failure states leave the full-screen loader over the page, and
// the card's own "Retry preview" (swapToStagingForSession → ensureStaging) sat
// under it. The loader now carries that same action, labelled for a preview,
// for exactly the viewers the card offers it to (not read-only ones).

test('#3413 a failed rebuild keeps its reason and offers "Retry preview" that re-runs the same open', async () => {
  const bodies = [{ status: 'rebuilding' }, { status: 'ready', url: 'https://rebuilt.example', verified: true }];
  let requests = 0;
  const endpoints = [];
  const { AppView, dom, swaps } = makeAppView(async (url) => {
    endpoints.push(url);
    return { ok: true, json: async () => bodies[requests++] };
  });
  const APP = { slug: 'usernode-2d5619', self_hosted: true };
  await AppView.ensureStaging(7, 'https://stale.example', { md: 'do x', path: '/x' }, { app: APP });
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, true, 'no retry while the rebuild runs');
  AppView.onStagingRebuildResult(7, { failed: true, error: 'Container config error: bad port' });
  assert.match(dom.els['staging-loader-title'].textContent, /couldn|n.t be rebuilt/i, 'failure title stays up');
  assert.match(dom.els['staging-loader-sub'].textContent, /Container config error/, 'failure reason stays up');
  assert.equal(dom.els['staging-loader'].classList._hidden, false);
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, false, 'retry is visible inside the loader');
  assert.equal(dom.els['staging-retry-btn'].textContent, 'Retry preview');

  await AppView._staging()._handlers.onRetry();
  assert.deepEqual(endpoints, ['/api/sessions/7/ensure-staging', '/api/sessions/7/ensure-staging'],
    'retry asks the same collaborator ensure route the card button does');
  assert.equal(swaps.length, 1, 'the retried open resolves normally');
  assert.equal(swaps[0].url, 'https://rebuilt.example');
  assert.equal(swaps[0].opts.app, APP, 'carries the original open arguments');
  assert.deepEqual(swaps[0].testing, { md: 'do x', path: '/x' });
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, true, 'the retry hides once the open restarts');
});

test('#3413 an ensure-staging error and a network error both offer "Retry preview"', async () => {
  for (const fail of ['http', 'network']) {
    let calls = 0;
    const { AppView, dom, swaps } = makeAppView(async () => {
      if (++calls === 1) {
        if (fail === 'network') throw new Error('offline');
        return { ok: false, json: async () => ({ error: 'Staging build failed: invalid container config' }) };
      }
      return { ok: true, json: async () => ({ status: 'ready', url: 'https://live.example', verified: true }) };
    });
    await AppView.ensureStaging(7, '', null, {});
    assert.equal(dom.els['staging-loader-title'].textContent, message('changes:frame.unavailable.title'), fail);
    assert.match(dom.els['staging-loader-sub'].textContent, fail === 'network' ? /network error/i : /invalid container config/, fail);
    assert.equal(dom.els['staging-retry-btn'].classList._hidden, false, fail);
    assert.equal(dom.els['staging-retry-btn'].textContent, 'Retry preview', fail);
    await AppView._staging()._handlers.onRetry();
    assert.equal(calls, 2, fail);
    assert.equal(swaps.length, 1, fail);
  }
});

test('#3413 read-only viewers and the demo environment get no retry (mirrors the card)', async () => {
  const ro = makeAppView(async () => ({ ok: true, json: async () => ({ status: 'unavailable', reason: 'missing' }) }));
  await ro.AppView.ensureStaging(7, '', null, { readOnly: true });
  // A stopped preview says so, and who can start it, rather than "unavailable".
  assert.equal(ro.dom.els['staging-loader-title'].textContent, message('changes:frame.notRunning.title'));
  assert.equal(ro.dom.els['staging-loader-sub'].textContent, message('changes:frame.unavailable.missingReader'));
  assert.equal(ro.dom.els['staging-retry-btn'].classList._hidden, true, 'read-only: no retry');

  const demo = makeAppView(okJson({ status: 'unavailable', reason: 'demo' }));
  await demo.AppView.ensureStaging(7, '', null, {});
  assert.equal(demo.dom.els['staging-retry-btn'].classList._hidden, true, 'demo: a retry could only loop');
});

test('#3413 a stale retry (the user moved on) does nothing', async () => {
  let calls = 0;
  const { AppView } = makeAppView(async () => {
    calls++;
    return { ok: false, json: async () => ({ error: 'boom' }) };
  });
  await AppView.ensureStaging(7, '', null, {});
  const staleRetry = AppView._staging()._handlers.onRetry;
  AppView._stagingLoadId++;
  await staleRetry();
  assert.equal(calls, 1, 'no second ensure request from a superseded open');
});

// ── #816: the rebuild estimate is reserved for actual rebuilds ───────────
//
// The reported bug in one assertion: clicking Preview on a live preview
// used to paint "this usually takes 20–60 seconds" BEFORE the server had
// been asked anything, so a sub-second open read as a minute-long wait.

const REBUILD_COPY = /20[–-]60 seconds/;

function loaderText(dom) {
  return `${dom.els['staging-loader-title'].textContent} ${dom.els['staging-loader-sub'].textContent}`;
}

test('#816 the opening state is neutral — no rebuild estimate before the server answers', async () => {
  let loaderWhileInFlight = null;
  const { AppView, dom } = makeAppView(async () => {
    // Sampled at the moment the POST is in flight: this is exactly the
    // screen the user stares at on every single Preview click.
    loaderWhileInFlight = loaderText(dom);
    return { ok: true, json: async () => ({ status: 'ready', url: 'https://live.example', verified: true }) };
  });
  await AppView.ensureStaging(7, null, null, {});
  assert.doesNotMatch(loaderWhileInFlight, REBUILD_COPY, 'no 20–60s promise before we know a rebuild is needed');
  assert.doesNotMatch(loaderWhileInFlight, /paused/i, 'does not claim the preview was paused');
  assert.match(loaderWhileInFlight, /opening preview/i, 'neutral opening copy');
});

test('#816 a verified {ready} opens the iframe with ZERO readiness probes', async () => {
  const calls = [];
  const { AppView, dom } = makeAppView(async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ status: 'ready', url: 'https://live.example', verified: true }) };
  }, { stubSwap: false });

  await AppView.ensureStaging(7, null, null, {});

  assert.deepEqual(calls, ['/api/sessions/7/ensure-staging'],
    'the ensure POST is the only request — the host is never probed');
  assert.equal(dom.els['staging-iframe'].src, 'https://live.example/?demo=1&token=test-token&un-theme=light',
    'self-app iframe pointed at the demo-backed preview immediately');
  assert.doesNotMatch(loaderText(dom), REBUILD_COPY, 'never shows the rebuild estimate');
  assert.equal(dom.els['staging-loader'].classList._hidden, false,
    'spinner stays up across the render instead of leaving a black rectangle');
});

test('#2691 self-app preview keeps its deep link while enabling demo fixtures', async () => {
  const { AppView, dom } = makeAppView(okJson({ status: 'ready' }), { stubSwap: false });
  // The page a change names (`startPath`, services/preview-start.js) is what
  // the first load opens; the dev chat's "Test this change" jump, which
  // opened the testing path instead, is retired with the dev chat.
  await AppView.swapToStaging(
    'https://live.example',
    null,
    { verified: true, startPath: '/?view=kanban#app/usernode-2d5619/dev' }
  );
  assert.equal(
    dom.els['staging-iframe'].src,
    'https://live.example/?view=kanban&demo=1&token=test-token&un-theme=light#app/usernode-2d5619/dev',
    'existing path, query, and hash survive alongside demo mode and authentication'
  );
});

test('#2691 child-app preview keeps its query semantics unchanged', async () => {
  const { AppView, dom } = makeAppView(okJson({ status: 'ready' }), { stubSwap: false });
  AppView.appData.self_hosted = false;
  await AppView.swapToStaging('https://live.example', null, { verified: true });
  assert.equal(dom.els['staging-iframe'].src, 'https://live.example/?token=test-token&un-theme=light');
});

test('#816 a verified {ready,checksRunning} explains the slower first load', async () => {
  const { AppView, dom } = makeAppView(
    okJson({ status: 'ready', url: 'https://live.example', verified: true, checksRunning: true }),
    { stubSwap: false }
  );
  await AppView.ensureStaging(7, null, null, {});
  assert.match(dom.els['staging-loader-sub'].textContent, /automated checks are running/i);
  assert.doesNotMatch(loaderText(dom), /\d+[–-]\d+ seconds/, 'no invented duration');
});

test('#816 the loader clears on the iframe load event, and a stale load id is ignored', async () => {
  const { AppView, dom } = makeAppView(
    okJson({ status: 'ready', url: 'https://live.example', verified: true }),
    { stubSwap: false }
  );
  await AppView.ensureStaging(7, null, null, {});
  const iframe = dom.els['staging-iframe'];
  assert.equal(typeof iframe.onload, 'function', 'the render is actually observed');

  iframe.onload();
  assert.equal(dom.els['staging-loader'].classList._hidden, true, 'spinner cleared once the page painted');

  // A late event from a superseded open must not resurrect the loader.
  await AppView.ensureStaging(7, null, null, {});
  const staleHandler = iframe.onload;
  AppView._stagingLoadId += 1;             // simulate a newer open / a close
  AppView._setStagingLoader(false);
  staleHandler();
  assert.equal(dom.els['staging-loader'].classList._hidden, true, 'stale load event is a no-op');
});

test('preview telemetry resolves only after the verified iframe paints', async () => {
  const calls = [];
  const uiTelemetry = {
    attempt(action, context) { calls.push(['attempt', action, context]); return 'preview-attempt-1'; },
    screen(screen, context) { calls.push(['screen', screen, context]); },
    outcome(attemptId, outcome, detail) { calls.push(['outcome', attemptId, outcome, detail]); },
    cancel(attemptId) { calls.push(['cancel', attemptId]); },
    errorCodeFor() { return 'unavailable'; },
  };
  const { AppView, dom } = makeAppView(
    okJson({ status: 'ready', url: 'https://live.example', verified: true }),
    { stubSwap: false, uiTelemetry }
  );
  await AppView.ensureStaging(7, null, null, {});
  assert.equal(calls.filter((call) => call[0] === 'outcome').length, 0,
    'ensure and health success are not yet a painted preview');
  dom.els['staging-iframe'].onload();
  assert.deepEqual(calls.filter((call) => call[0] === 'outcome'), [
    ['outcome', 'preview-attempt-1', 'success', undefined],
  ]);
});

test('rebuild verification carries one preview attempt through to iframe readiness', async () => {
  let ensures = 0;
  const calls = [];
  const uiTelemetry = {
    attempt() { calls.push(['attempt']); return 'preview-rebuild-1'; },
    screen() { calls.push(['screen']); },
    outcome(attemptId, outcome, detail) { calls.push(['outcome', attemptId, outcome, detail]); },
    cancel(attemptId) { calls.push(['cancel', attemptId]); },
    errorCodeFor() { return 'unavailable'; },
  };
  const { AppView, dom } = makeAppView(async (url) => {
    if (url.includes('ensure-staging')) {
      ensures += 1;
      return { ok: true, json: async () => ensures === 1
        ? ({ status: 'rebuilding' })
        : ({ status: 'ready', url: 'https://rebuilt.example', verified: true }) };
    }
    throw new Error(`unexpected request: ${url}`);
  }, { stubSwap: false, uiTelemetry });
  await AppView.ensureStaging(7, null, null, {});
  await AppView.onStagingRebuildResult(7, { url: 'https://rebuilt.example' });
  assert.equal(calls.filter((call) => call[0] === 'attempt').length, 1,
    'the staging_ready verification does not start or finish a second attempt');
  assert.equal(calls.filter((call) => call[0] === 'outcome').length, 0);
  dom.els['staging-iframe'].onload();
  assert.deepEqual(calls.filter((call) => call[0] === 'outcome'), [
    ['outcome', 'preview-rebuild-1', 'success', undefined],
  ]);
});

test('preview iframe navigation failure is a terminal failure, not a success', async () => {
  const calls = [];
  const uiTelemetry = {
    attempt() { return 'preview-error-1'; }, screen() {},
    outcome(attemptId, outcome, detail) { calls.push([attemptId, outcome, detail]); },
    cancel() {}, errorCodeFor() { return 'unavailable'; },
  };
  const { AppView, dom } = makeAppView(
    okJson({ status: 'ready', url: 'https://live.example', verified: true }),
    { stubSwap: false, uiTelemetry }
  );
  await AppView.ensureStaging(7, null, null, {});
  dom.els['staging-iframe'].onerror();
  assert.equal(JSON.stringify(calls), JSON.stringify([
    ['preview-error-1', 'failure', { errorCode: 'unavailable' }],
  ]));
});

test('an invalid ensure response is a classified terminal preview failure', async () => {
  const calls = [];
  const uiTelemetry = {
    attempt() { return 'preview-invalid-1'; }, screen() {},
    outcome(attemptId, outcome, detail) { calls.push([attemptId, outcome, detail]); },
    cancel() {}, errorCodeFor() { return 'unavailable'; },
  };
  const { AppView, dom } = makeAppView(okJson({}), { uiTelemetry });
  await AppView.ensureStaging(7, null, null, {});
  assert.equal(JSON.stringify(calls), JSON.stringify([
    ['preview-invalid-1', 'failure', { errorCode: 'invalid_response' }],
  ]));
  assert.match(dom.els['staging-loader-sub'].textContent, /unexpected response/i);
});

test('#816 an UNVERIFIED {ready} falls back to the readiness poll', async () => {
  const calls = [];
  const { AppView, dom } = makeAppView(async (url) => {
    calls.push(url);
    if (url === '/api/sessions/7/ensure-staging') {
      return { ok: true, json: async () => ({ status: 'ready', url: 'https://live.example', verified: false }) };
    }
    return {}; // the host answers the probe
  }, { stubSwap: false });

  await AppView.ensureStaging(7, null, null, {});
  await new Promise((r) => setTimeout(r, 10)); // let the poll's promise settle

  assert.equal(calls.length, 2, 'the host IS probed when the server could not verify it');
  assert.equal(calls[1], 'https://live.example', 'probes the origin root, not a deep link');
  assert.equal(dom.els['staging-iframe'].src, 'https://live.example/?demo=1&token=test-token&un-theme=light', 'opens the self-app demo once the host answers');
});

test('#816 only the {rebuilding} branch shows the 20–60 second estimate', async () => {
  const ready = makeAppView(okJson({ status: 'ready', url: 'https://live.example', verified: true }), { stubSwap: false });
  await ready.AppView.ensureStaging(7, null, null, {});
  assert.doesNotMatch(loaderText(ready.dom), REBUILD_COPY);

  const rebuilding = makeAppView(okJson({ status: 'rebuilding' }));
  await rebuilding.AppView.ensureStaging(7, null, null, {});
  assert.match(loaderText(rebuilding.dom), REBUILD_COPY,
    'a real rebuild still tells the user how long it takes');
});

// ── #816: the fallback poll's schedule + copy ────────────────────────────

test('#816 the readiness poll starts immediately and backs off 300/600/1200/2000', () => {
  const { AppView } = makeAppView(okJson({}));
  // Spread: the array is built inside the vm realm, so its prototype isn't
  // this realm's Array and a strict deep-equal would fail on identical values.
  assert.deepEqual([...AppView.STAGING_POLL_BACKOFF_MS], [300, 600, 1200],
    'tight early retries — a live preview answers in tens of ms');
  assert.equal(AppView.STAGING_POLL_BACKOFF_MAX_MS, 2000, 'ceiling');
  assert.equal(AppView.STAGING_POLL_ATTEMPT_TIMEOUT_MS, 5000, 'per-attempt cut-off');
  assert.equal(AppView.STAGING_IFRAME_LOAD_TIMEOUT_MS, 20000, 'iframe safety net');

  const schedule = [0, 1, 2, 3, 4, 9].map((i) => AppView._stagingPollBackoffMs(i));
  assert.deepEqual(schedule, [300, 600, 1200, 2000, 2000, 2000], 'escalates then holds at the ceiling');
});

test('#816 the readiness poll retries on the tightened schedule', async () => {
  const sleeps = [];
  let attempts = 0;
  const { AppView, sandbox } = makeAppView(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('not answering yet');
    return {};
  }, { stubSwap: false });
  // Record the waits without actually sleeping through them.
  sandbox.setTimeout = (fn, ms) => { sleeps.push(ms); return setTimeout(fn, 0); };

  const started = Date.now();
  const ready = await AppView._waitForStagingReady('https://live.example', AppView._stagingLoadId);
  assert.equal(ready, true, 'resolves once the host answers');
  assert.equal(attempts, 3, 'first attempt fires immediately, then retries');
  // The abort timers are registered alongside the sleeps; keep only the waits.
  const waits = sleeps.filter((ms) => ms !== AppView.STAGING_POLL_ATTEMPT_TIMEOUT_MS);
  assert.deepEqual(waits, [300, 600], 'two failures cost 0.9s, not the old 5s');
  assert.ok(Date.now() - started < 1000, 'no fixed multi-second floor on the fast path');
});

test('#816 no loader copy anywhere claims a TLS certificate is being issued', async () => {
  const { AppView, dom } = makeAppView(async () => { throw new Error('down'); }, { stubSwap: false });
  // Kick the poll once so it paints its initial state, then abandon it.
  AppView._waitForStagingReady('https://dead.example', AppView._stagingLoadId);
  await new Promise((r) => setTimeout(r, 5));
  AppView._stagingLoadId += 1;

  const text = loaderText(dom);
  assert.match(text, /waiting for the preview/i, 'says what is actually happening');
  for (const dead of [/TLS/i, /certificate/i, /provisioning/i, /certificate authority/i]) {
    assert.doesNotMatch(text, dead, `stale premise removed: ${dead}`);
  }
  // And the markup default must not reintroduce it before JS runs.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const loaderBlock = html.slice(html.indexOf('id="staging-loader"'), html.indexOf('id="staging-loader"') + 700);
  assert.doesNotMatch(loaderBlock, /TLS certificate/i, 'index.html default copy is neutral too');
});

// #1993: drive the real token mint and frame assignment together. Existing
// readiness cases above start with a fresh cached token; these deliberately
// exercise missing, delayed, expired, and failed credentials.
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const tokenResponse = (token) => ({ ok: true, json: async () => ({ token }) });
const readyResponse = () => ({ ok: true, json: async () => ({ status: 'ready', verified: true, url: 'https://live.example' }) });

function authHarness(fetchImpl) {
  const h = makeAppView(fetchImpl, { stubSwap: false });
  h.AppView._tokenFresh = null;
  return h;
}

test('#1993 preview joins a delayed initial mint and never navigates without its token', async () => {
  const response = deferred();
  let mints = 0;
  const { AppView, dom } = authHarness(async (url) => {
    if (url.includes('/iframe-token')) { mints++; return response.promise; }
    return readyResponse();
  });
  const initial = AppView.refreshToken('usernode-2d5619');
  const opening = AppView.ensureStaging(7, null, null, {});
  await tick();
  assert.equal(mints, 1, 'joins the in-flight request started by Dev navigation');
  assert.equal(dom.els['staging-iframe'].src, '', 'no tokenless navigation');
  assert.match(dom.els['staging-loader-title'].textContent, /signing in/i);
  response.resolve(tokenResponse('joined-token'));
  await Promise.all([initial, opening]);
  assert.equal(dom.els['staging-iframe'].src, 'https://live.example/?demo=1&token=joined-token&un-theme=light');
});

test('#1993 failed token request exposes a retry that obtains a new token', async () => {
  let mints = 0;
  const { AppView, dom } = authHarness(async () => {
    mints++;
    return mints === 1 ? { ok: false } : tokenResponse('retry-token');
  });
  await AppView.swapToStaging('https://live.example', null, { verified: true });
  assert.equal(dom.els['staging-iframe'].src, '');
  assert.match(dom.els['staging-loader-title'].textContent, /could not sign in/i);
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, false);
  assert.equal(dom.els['staging-retry-btn'].textContent, 'Retry sign-in', '#3413: the sign-in path keeps its label');
  await AppView._staging()._handlers.onRetry();
  assert.equal(mints, 2);
  assert.equal(dom.els['staging-iframe'].src, 'https://live.example/?demo=1&token=retry-token&un-theme=light');
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, true);
});

test('#1993 a timed-out token request can be retried and does not hold the single-flight slot', async () => {
  let attempts = 0;
  const h = authHarness(async (_url, { signal }) => {
    if (++attempts > 1) return tokenResponse('after-timeout');
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  h.AppView.TOKEN_REQUEST_TIMEOUT_MS = 5;
  // Keep the short deadline referenced; the shared harness normally unrefs timers.
  h.sandbox.setTimeout = setTimeout;
  await h.AppView.swapToStaging('https://live.example', null, { verified: true });
  assert.equal(h.dom.els['staging-iframe'].src, '');
  await h.AppView._staging()._handlers.onRetry();
  assert.equal(h.dom.els['staging-iframe'].src, 'https://live.example/?demo=1&token=after-timeout&un-theme=light');
  h.AppView.closeStagingOverlay();
});

test('#1993 read-only previews verify without requesting a rebuild', async () => {
  const calls = [];
  const { AppView, dom } = authHarness(async (url) => {
    calls.push(url);
    if (url.includes('preview-status')) {
      return { ok: true, json: async () => ({ status: 'ready', verified: true, url: 'https://live.example' }) };
    }
    return tokenResponse('reader-token');
  });
  AppView.appData.can_collaborate = false;
  await AppView.ensureStaging(7, 'https://live.example', null, {});
  assert.deepEqual(calls, [
    '/api/sessions/7/preview-status',
    '/api/iframe-token?app=usernode-2d5619',
  ]);
  assert.equal(dom.els['staging-iframe'].src, 'https://live.example/?demo=1&token=reader-token&un-theme=light');
});

test('#1993 rebuild completion acquires authentication before navigating', async () => {
  const calls = [];
  const { AppView, dom } = authHarness(async (url) => {
    calls.push(url);
    if (url.includes('ensure-staging')) {
      const ensureCalls = calls.filter((item) => item.includes('ensure-staging')).length;
      return { ok: true, json: async () => ensureCalls === 1
        ? ({ status: 'rebuilding' })
        : ({ status: 'ready', verified: true, url: 'https://rebuilt.example' }) };
    }
    return tokenResponse('rebuilt-token');
  });
  await AppView.ensureStaging(7, null, null, {});
  assert.equal(dom.els['staging-iframe'].src, '');
  await AppView.onStagingRebuildResult(7, { url: 'https://rebuilt.example' });
  assert.equal(dom.els['staging-iframe'].src, 'https://rebuilt.example/?demo=1&token=rebuilt-token&un-theme=light');
  assert.ok(calls.includes('/api/iframe-token?app=usernode-2d5619'));
});

for (const action of ['close', 'switch app', 'new preview']) {
  test(`#1993 ${action} cancels an older token completion`, async () => {
    const response = deferred();
    const { AppView, dom } = authHarness(async () => response.promise);
    const opening = AppView.swapToStaging('https://old.example', null, { verified: true });
    await tick();
    let newer;
    if (action === 'close') AppView.closeStagingOverlay();
    if (action === 'switch app') AppView.appData = { slug: 'other-app' };
    if (action === 'new preview') newer = AppView.swapToStaging('https://new.example', null, { verified: true });
    response.resolve(tokenResponse('late-token'));
    await Promise.all([opening, newer]);
    assert.equal(dom.els['staging-iframe'].src, action === 'new preview' ? 'https://new.example/?demo=1&token=late-token&un-theme=light' : '');
  });
}

test('#1993 app switch during ensure-staging cannot open the old URL under the new identity', async () => {
  const response = deferred();
  const { AppView, dom } = authHarness(async () => response.promise);
  const opening = AppView.ensureStaging(7, null, null, {});
  AppView.appData = { slug: 'other-app' };
  response.resolve(readyResponse());
  await opening;
  assert.equal(dom.els['staging-iframe'].src, '');
});

test('#1993 app switch during rebuild ignores the old completion', async () => {
  const { AppView, dom } = authHarness(async () => ({ ok: true, json: async () => ({ status: 'rebuilding' }) }));
  await AppView.ensureStaging(7, null, null, {});
  AppView.appData = { slug: 'other-app' };
  await AppView.onStagingRebuildResult(7, { url: 'https://old.example' });
  assert.equal(dom.els['staging-iframe'].src, '');
});

test('#1993 ignores another app’s cached token and an expired fresh-cache entry', async () => {
  for (const cached of [
    { slug: 'other-app', at: Date.now() },
    { slug: 'usernode-2d5619', at: Date.now() - 61_000 },
  ]) {
    const h = authHarness(async (url) => {
      assert.equal(url, '/api/iframe-token?app=usernode-2d5619');
      return tokenResponse('correct-token');
    });
    h.AppView._tokenFresh = { ...cached, token: 'wrong-token' };
    h.AppView.iframeToken = 'wrong-token';
    h.AppView.iframeTokenSlug = 'other-app';
    await h.AppView.swapToStaging('https://live.example', null, { verified: true });
    assert.equal(h.dom.els['staging-iframe'].src, 'https://live.example/?demo=1&token=correct-token&un-theme=light');
  }
});

test('#1993 token remains on the preview origin with a hostile testing path', async () => {
  const h = authHarness(async () => tokenResponse('private-token'));
  h.AppView.appData.self_hosted = false;
  await h.AppView.swapToStaging('https://live.example', { path: '/\\attacker.example/path' },
    { verified: true, startPath: '/\\attacker.example/path' });
  assert.equal(h.dom.els['staging-iframe'].src, 'https://live.example/?token=private-token&un-theme=light');
});

// ── The preview bar's title (first-session run, 4 October 2026) ─────────
//
// Try it on the Homeroom bot's ready card opened a group's preview whose bar
// read "‹ Back to session" beside the raw staging address
// ("https://flat-4b-chores-e98ecd--s62…"). The card hands over only the
// app's slug, so the name has to come from the ensure answer.

const PREVIEW_URL = 'https://flat-4b-chores-e98ecd--s62.onhomeroom.com';

test('a preview opened from a slug alone is titled with the app name the server sends', async () => {
  const { AppView, dom } = authHarness(async (url) => {
    if (url.includes('/iframe-token')) return tokenResponse('t');
    return {
      ok: true,
      json: async () => ({ status: 'ready', verified: true, url: PREVIEW_URL, appName: 'Flat 4B Chores' }),
    };
  });
  AppView.appData = null;
  await AppView.ensureStaging(62, null, null, { readOnly: false, app: { slug: 'flat-4b-chores-e98ecd' } });
  const title = dom.els['staging-url-label'].textContent;
  assert.equal(title, 'Flat 4B Chores · Preview');
  assert.doesNotMatch(title, /https?:|onhomeroom|--s\d/, 'never the staging address');
  assert.equal(dom.els['staging-iframe'].src.startsWith(PREVIEW_URL), true, 'the preview still opens');
});

test('without a server name the title falls back to the open app, then to plain Preview', async () => {
  const { AppView, dom } = makeAppView(okJson({ status: 'ready' }), { stubSwap: false });
  AppView.appData = { slug: 'usernode-2d5619', self_hosted: true, name: 'Homeroom' };
  await AppView.swapToStaging('https://live.example', null, { verified: true });
  assert.equal(dom.els['staging-url-label'].textContent, 'Homeroom · Preview');

  // A caller's record for a DIFFERENT app never borrows the open app's name.
  assert.equal(AppView._stagingTitle({ slug: 'someone-else' }), 'Preview');
  assert.equal(AppView._stagingTitle({ slug: 'x', name: '  Chores  ' }), 'Chores · Preview');
  assert.equal(AppView._stagingTitle(null, 'Flat 4B Chores'), 'Flat 4B Chores · Preview');
  assert.equal(AppView._stagingTitle(null, '   '), 'Preview');
  assert.equal(AppView._stagingTitle(null), 'Preview');
});

test('the preview bar says Back, not Back to session, and its title is not set in a URL face', () => {
  const overlay = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'staging', 'staging-overlay.tsx'), 'utf8');
  const back = overlay.match(/<button\s+id="staging-back"[\s\S]*?<\/button>/);
  assert.ok(back, '#staging-back keeps its id');
  // Nov 2026: one round control. In the whole window it is Back (a chevron,
  // named Back); docked in a column or the side panel it is the × that
  // closes the preview. app.css shows the glyph for the placement.
  assert.match(back[0], /aria-label=\{exitLabel\}/);
  assert.match(back[0], /<ChevronLeftIcon className="staging-exit-back /);
  assert.match(back[0], /<XIcon className="staging-exit-close /);
  assert.match(overlay, /const exitLabel = docked \? t\('devchat:staging\.close'\) : t\('core:common\.back'\);/);
  assert.equal(message('core:common.back'), 'Back');
  assert.equal(message('devchat:staging.close'), 'Close preview');
  assert.doesNotMatch(back[0], /Back to session/);
  const label = overlay.match(/<span id="staging-url-label" className="([^"]*)"/);
  assert.ok(label, '#staging-url-label keeps its id');
  assert.doesNotMatch(label[1], /font-mono/, 'a name, not an address');
  // Nothing hands the bar a raw address any more.
  assert.doesNotMatch(SRC, /setUrlLabel\((?:resolved|'https?:)/);
});

// ── #6077: a preview stuck loading offers the retry, not "close and reopen" ──
//
// The trap these pin: swapToStaging takes a load id of its own, so
// ensureStaging's `retry` closure no-ops by the time the iframe is loading. A
// button wired to it would be drawn and do nothing, which is why the loading
// states get `opts.reopen`, guarded by the swap's own id, and why these press
// the button and count the requests rather than only look at it.

const SLOW_REBUILD_MS = 180000;

// Holds the two give-up timers for the test to fire by hand, however late.
function holdGiveUpTimers(sandbox) {
  const real = sandbox.setTimeout;
  const held = { rebuild: [], iframe: [] };
  sandbox.setTimeout = (fn, ms) => {
    if (ms === SLOW_REBUILD_MS) { held.rebuild.push(fn); return 0; }
    if (ms === sandbox.__AppView.STAGING_IFRAME_LOAD_TIMEOUT_MS) { held.iframe.push(fn); return 0; }
    return real(fn, ms);
  };
  return held;
}

function assertOffersRetry(dom, id) {
  assert.equal(dom.els['staging-loader-title'].textContent, message('changes:frame.loader.slow'));
  assert.equal(dom.els['staging-loader-sub'].textContent, message(id));
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, false, 'the button is up');
  assert.equal(dom.els['staging-retry-btn'].textContent, message('changes:frame.loader.retryPreview'));
}

function assertOffersNoRetry(dom, id) {
  assert.equal(dom.els['staging-loader-sub'].textContent, message(id));
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, true, 'no button');
}

test('#6077 where the button is up the copy has stopped saying close and reopen; without one it still does', () => {
  for (const id of ['slowRebuild', 'slowLoadFailed', 'slowStillLoading']) {
    assert.match(message(`changes:frame.loader.${id}`), /Close this and click Preview again/, id);
    assert.doesNotMatch(message(`changes:frame.loader.${id}Retry`), /Close|click Preview/i, `${id}Retry`);
  }
});

test('#6077 a rebuild past its give-up time offers a retry that asks about the same session again', async () => {
  const bodies = [{ status: 'rebuilding' }, { status: 'rebuilding' }];
  const endpoints = [];
  const { AppView, dom, sandbox } = makeAppView(async (url) => {
    endpoints.push(url);
    return { ok: true, json: async () => bodies.shift() };
  });
  const held = holdGiveUpTimers(sandbox);
  await AppView.ensureStaging(7, 'https://stale.example', null, {});
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, true, 'no retry before it is stuck');

  held.rebuild[0]();
  assertOffersRetry(dom, 'changes:frame.loader.slowRebuildRetry');
  assert.ok(AppView._pendingStagingPreview, 'a rebuild that finishes after this still opens by itself');

  await AppView._staging()._handlers.onRetry();
  assert.deepEqual(endpoints, ['/api/sessions/7/ensure-staging', '/api/sessions/7/ensure-staging']);
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, true, 'the wait starts over');
  assert.equal(dom.els['staging-loader-title'].textContent, message('changes:frame.loader.rebuilding'));

  // The first wait's timer goes off late: it speaks for an older load.
  held.rebuild[0]();
  assert.equal(dom.els['staging-loader-title'].textContent, message('changes:frame.loader.rebuilding'));
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, true, 'a stale timer offers nothing');
  assert.equal(held.rebuild.length, 2);
  held.rebuild[1]();
  assertOffersRetry(dom, 'changes:frame.loader.slowRebuildRetry');
});

test('#6077 the rebuild that lands after the give-up copy still opens, and the button goes with the copy', async () => {
  let requests = 0;
  const { AppView, dom, swaps, sandbox } = makeAppView(async () => ({
    ok: true,
    json: async () => (++requests === 1
      ? { status: 'rebuilding' }
      : { status: 'ready', url: 'https://rebuilt.example', verified: true }),
  }));
  const held = holdGiveUpTimers(sandbox);
  await AppView.ensureStaging(7, 'https://stale.example', null, {});
  held.rebuild[0]();
  await AppView.onStagingRebuildResult(7, { url: 'https://rebuilt.example' });
  assert.equal(swaps.length, 1);
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, true);
});

test('#6077 a read-only viewer stuck on a waking preview keeps the old advice and gets no button', async () => {
  const { AppView, dom, sandbox } = makeAppView(okJson({ status: 'rebuilding', waking: true }));
  const held = holdGiveUpTimers(sandbox);
  await AppView.ensureStaging(7, '', null, { readOnly: true });
  held.rebuild[0]();
  assertOffersNoRetry(dom, 'changes:frame.loader.slowRebuild');
});

test('#6077 a page that fails or hangs offers a retry that really re-runs the same open', async () => {
  for (const stuck of ['error', 'timeout']) {
    const endpoints = [];
    const { AppView, dom, sandbox } = makeAppView(async (url) => {
      endpoints.push(url);
      return { ok: true, json: async () => ({ status: 'ready', url: 'https://live.example', verified: true, startPath: '/x' }) };
    }, { stubSwap: false });
    const held = holdGiveUpTimers(sandbox);
    await AppView.ensureStaging(7, 'https://fallback.example', { md: 'do x', path: '/x' }, {});
    const firstLoad = AppView._stagingLoadId;
    if (stuck === 'error') dom.els['staging-iframe'].onerror();
    else held.iframe[0]();
    assertOffersRetry(dom, stuck === 'error'
      ? 'changes:frame.loader.slowLoadFailedRetry'
      : 'changes:frame.loader.slowStillLoadingRetry');

    await AppView._staging()._handlers.onRetry();
    assert.deepEqual(endpoints, ['/api/sessions/7/ensure-staging', '/api/sessions/7/ensure-staging'], stuck);
    assert.ok(AppView._stagingLoadId > firstLoad, `${stuck}: a new load`);
    assert.equal(dom.els['staging-retry-btn'].classList._hidden, true, `${stuck}: the button goes`);
    assert.match(dom.els['staging-iframe'].src, /^https:\/\/live\.example\/.*x/, `${stuck}: the same deep link`);
  }
});

test('#6077 a stale iframe timer offers nothing, and a press from an older load does nothing', async () => {
  let requests = 0;
  const { AppView, dom, sandbox } = makeAppView(async () => {
    requests++;
    return { ok: true, json: async () => ({ status: 'ready', url: 'https://live.example', verified: true }) };
  }, { stubSwap: false });
  const held = holdGiveUpTimers(sandbox);
  await AppView.ensureStaging(7, null, null, {});
  held.iframe[0]();
  const olderPress = AppView._staging()._handlers.onRetry;

  await olderPress();
  assert.equal(requests, 2);
  const title = dom.els['staging-loader-title'].textContent;
  held.iframe[0]();
  assert.equal(dom.els['staging-loader-title'].textContent, title, 'the older load speaks no more');
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, true);

  await olderPress();
  assert.equal(requests, 2, 'pressing the older load\'s button asks nothing');

  // Backing out is the other way a load goes old.
  held.iframe[1]();
  const closed = AppView._staging()._handlers.onRetry;
  AppView._stagingLoadId++;
  await closed();
  assert.equal(requests, 2);
});

test('#6077 a page that finishes loading after the give-up copy takes the button down', async () => {
  const { AppView, dom, sandbox } = makeAppView(
    okJson({ status: 'ready', url: 'https://live.example', verified: true }), { stubSwap: false });
  const held = holdGiveUpTimers(sandbox);
  await AppView.ensureStaging(7, null, null, {});
  held.iframe[0]();
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, false);
  dom.els['staging-iframe'].onload();
  assert.equal(dom.els['staging-loader'].classList._hidden, true);
  assert.equal(dom.els['staging-retry-btn'].classList._hidden, true);
});

test('#6077 with no way back the stuck page keeps the old advice: a reader, and a direct open with no session', async () => {
  const reader = makeAppView(
    okJson({ status: 'ready', url: 'https://live.example', verified: true }), { stubSwap: false });
  await reader.AppView.ensureStaging(7, null, null, { readOnly: true });
  reader.dom.els['staging-iframe'].onerror();
  assertOffersNoRetry(reader.dom, 'changes:frame.loader.slowLoadFailed');

  const direct = makeAppView(okJson({}), { stubSwap: false });
  const held = holdGiveUpTimers(direct.sandbox);
  await direct.AppView.swapToStaging('https://live.example', null, { verified: true });
  held.iframe[0]();
  assertOffersNoRetry(direct.dom, 'changes:frame.loader.slowStillLoading');
});
