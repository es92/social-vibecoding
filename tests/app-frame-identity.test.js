// #1085 chunk H, step 2 — THE CORE DELIVERABLE.
//
// `#app-iframe` holds SOMEONE ELSE'S RUNNING APPLICATION. Every other element in
// this shell can be re-created for free; this one cannot. A new element is a new
// document, and a new document throws away whatever the user had inside another
// developer's app — a half-written post, an unsaved form, a game in progress.
// React re-creates a DOM node when its element type changes, its `key` changes,
// or its position among its siblings changes, so making the frame stateful means
// proving that none of those can happen for any state change the shell has.
//
// The issue states the requirement as a test, and this is that test:
//
//   "With the app view open, drive every tab switch, a chromeless enter/exit, a
//    staging-preview open/close and a token refresh, then assert the iframe's
//    contentWindow identity and a monotonically-increasing load counter are
//    unchanged."
//
// It is proved two ways, the same shape as the step-1 rehearsal in
// tests/staging-iframe-identity.test.js:
//
//   1. BEHAVIOURALLY. The real public/js/app-view.js runs in a vm, wired to the
//      REAL React bridge over the REAL store (frontend/src/features/app-frame/*.js
//      — plain JS, no React import, precisely so this test can drive them), and
//      the store drives a FAKE RENDERER that implements exactly the one
//      reconciliation rule the island declares: the frame element is created per
//      `key`, and the key is the app slug and nothing else. So if a code path
//      ever moves the slug when it should not, or unmounts where it should park,
//      the fake renderer hands back a different element and a fresh
//      `contentWindow` — which is precisely what the browser would do.
//   2. STRUCTURALLY. The other half of the guarantee is in the JSX, which this
//      suite cannot render (there is no frontend/node_modules in CI). The island
//      is asserted at source level for every property the fake renderer assumes:
//      one iframe, keyed only by slug, no `src` prop, an unconditional wrapper,
//      the iframe first among its siblings, and constant className strings.
//
// Run with: node --test tests/app-frame-identity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SRC = read('public/js/app-view.js');

const FRAME = read('frontend/src/features/app-frame/app-frame.tsx');
const ISLAND = read('frontend/src/features/app-frame/app-view-island.tsx');
const STORE = read('frontend/src/features/app-frame/app-frame-store.js');
const BRIDGE = read('frontend/src/features/app-frame/app-frame-bridge.js');
const MOUNT = read('frontend/src/features/app-frame/mount.ts');
const MAIN = read('frontend/src/main.tsx');
const SHELL = read('frontend/src/Shell.tsx');

const SLUG = 'usernode-2d5619';
const APP_URL = 'https://usernode-2d5619.example';

// ── the fake iframe ──────────────────────────────────────────────────────
//
// `contentWindow` is replaced on every navigation and `loads` counts them, so a
// reload is caught even in the (impossible-by-construction) case where the
// element object itself were somehow reused across one.
let frameSeq = 0;
function makeIframe() {
  frameSeq += 1;
  const el = {
    id: 'app-iframe',
    tagName: 'IFRAME',
    // Which element generation this is. Two different values for one app is the
    // failure this whole file exists to prevent.
    gen: frameSeq,
    loads: 0,
    _src: '',
    isConnected: true,
    contentWindow: { name: `win-${frameSeq}-0`, postMessage() {} },
    onload: null,
    onerror: null,
    style: { opacity: '0' },
    dataset: {},
    classList: {
      _set: new Set(['w-full', 'h-full', 'border-0']),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, v) { if (v) this._set.add(c); else this._set.delete(c); },
    },
    getAttribute(name) { return name === 'src' ? (el._src || null) : null; },
    setAttribute() {},
    removeAttribute() {},
    remove() { el.isConnected = false; },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 390, height: 700 }),
  };
  Object.defineProperty(el, 'src', {
    get() { return el._src; },
    set(v) {
      el._src = v;
      // A real browser only navigates — and so only replaces contentWindow —
      // for a non-empty src.
      if (v) {
        el.loads += 1;
        el.contentWindow = { name: `win-${el.gen}-${el.loads}`, postMessage() {} };
      }
    },
  });
  return el;
}

// ── the fake renderer ────────────────────────────────────────────────────
//
// Stands in for <AppFrameHost/>. It implements the island's reconciliation
// contract and nothing else:
//
//   * a frame exists iff `slug` is non-empty            (the `{state.slug ? …}`)
//   * the element is re-created iff `slug` CHANGES      (`key={state.slug}`)
//   * `src` is never applied from state                 (there is no src prop)
//   * `active` hides the host; it does not unmount      (useHiddenClass on host)
//
// The structural half of this file asserts the JSX really has those four
// properties, so the two halves together cover the real component.
function attachRenderer(store, refs) {
  const r = {
    el: null, key: null, renders: 0, creates: 0, hostHidden: true,
    history: [],
  };
  const render = () => {
    r.renders += 1;
    const { slug, active, faded, cover } = store.get();
    if (!slug) {
      if (r.el) r.history.push(`unmount:${r.key}`);
      r.key = null;
      r.el = null;
      refs.iframe = null;
    } else {
      if (r.key !== slug) {
        r.key = slug;
        r.el = makeIframe();
        r.creates += 1;
        r.history.push(`create:${slug}`);
      }
      // Rendered props: a style change updates the existing node.
      r.el.style.opacity = faded ? '0' : '1';
      r.el.style.backgroundColor = store.get().background || '';
      refs.iframe = r.el;
    }
    r.hostHidden = !active;
    r.cover = cover;
  };
  store.subscribe(render);
  render();
  return r;
}

// ── the harness ──────────────────────────────────────────────────────────
async function makeHarness({ offline = false, offlineReady = false } = {}) {
  let offlineNow = offline;
  const storeMod = await import(
    new URL('../frontend/src/features/app-frame/app-frame-store.js', `file://${__filename}`).href
  );
  const bridgeMod = await import(
    new URL('../frontend/src/features/app-frame/app-frame-bridge.js', `file://${__filename}`).href
  );
  const stagingStoreMod = await import(
    new URL('../frontend/src/features/staging/staging-store.js', `file://${__filename}`).href
  );
  const stagingBridgeMod = await import(
    new URL('../frontend/src/features/staging/staging-bridge.js', `file://${__filename}`).href
  );
  // The App tab's placeholder states publish a view model into this store
  // (features/app-frame/app-status.tsx renders it). Plain JS, like the two
  // above, so this harness can hold the real one.
  const statusStoreMod = await import(
    new URL('../frontend/src/features/app-frame/app-status-store.js', `file://${__filename}`).href
  );
  statusStoreMod.appStatusStore.set({ view: null });

  // The stores are module-scope singletons, like the islands they feed: reset
  // them to the prerendered state between cases.
  storeMod.appFrameStore.set({ slug: '', active: false, faded: true, background: '', cover: null });
  storeMod.appFrameRefs.iframe = null;
  stagingStoreMod.stagingStore.set({
    open: false, mode: 'fullscreen', dockRect: null, urlLabel: '',
    loaderVisible: false, loaderTitle: 'Opening preview…', loaderSub: '',
    testBtnHidden: true, testBtnTitle: '', testPanelHidden: true, testHtml: '',
    fsBtnHidden: true, fsBtnText: 'Full screen', fsBtnTitle: '',
  });
  for (const key of Object.keys(stagingStoreMod.stagingHandlers)) {
    stagingStoreMod.stagingHandlers[key] = null;
  }
  const stagingIframe = makeIframe();
  stagingIframe.id = 'staging-iframe';
  stagingStoreMod.stagingRefs.iframe = stagingIframe;

  const renderer = attachRenderer(storeMod.appFrameStore, storeMod.appFrameRefs);

  // The nodes app-view.js legitimately still reads — everything OUTSIDE the
  // React-owned frame host. #app-content is the big one: it is deliberately
  // still a hand-written innerHTML host, and half the point of chunk H is that
  // writes into it no longer touch the frame.
  const outside = {};
  const mkPlain = (id) => {
    const el = {
      id, _text: '', _html: '', onclick: null, isConnected: true,
      style: {}, dataset: {}, attrs: {},
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
        toggle(c, v) { if (v) this._set.add(c); else this._set.delete(c); },
      },
      set textContent(v) { this._text = v; }, get textContent() { return this._text; },
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
      setAttribute(n, v) { this.attrs[n] = String(v); },
      removeAttribute(n) { delete this.attrs[n]; },
      addEventListener() {}, removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild() {}, remove() {},
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 390, height: 700 }),
      scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    };
    outside[id] = el;
    return el;
  };
  ['app-view', 'app-content', 'back-btn', 'dc-staging-panel', 'dev-console-btn'].forEach(mkPlain);

  const asked = [];
  const intervals = [];
  const record = { slug: SLUG, name: 'Homeroom', url: APP_URL, status: 'running', icon: '🛠' };

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    relTime: () => 'now',
    escapeHtml: (s) => String(s),
    App: {
      user: { id: 1 }, currentTab: 'app', currentApp: SLUG,
      _setScreenVisible() {}, switchTab() {},
    },
    Home: { _apps: [record], iconTileFor: () => '<span>🛠</span>' },
    Kudos: { renderButton: () => '' },
    DevChat: { currentSession: null },
    // Mutable, so a case can put the connection back (see setOffline).
    Offline: { isOffline: () => offlineNow },
    document: {
      getElementById(id) {
        // The React-owned frame IS in the document, so a read for it resolves —
        // that is how the safe-area broadcast finds it. Writes are the thing
        // that must not happen, and the last test in this file proves there are
        // none outside the fallback DOM adapter.
        if (id === 'app-iframe') return storeMod.appFrameRefs.iframe;
        if (id === 'staging-iframe') return stagingStoreMod.stagingRefs.iframe;
        if (outside[id]) return outside[id];
        asked.push(id);
        return null;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      createElement: () => mkPlain(`tmp-${asked.length}`),
      body: { appendChild() {} },
      documentElement: { classList: { contains: () => true }, style: {} },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '0px' }),
    fetch: async (url) => ({
      ok: true,
      json: async () => (String(url).includes('/api/iframe-token')
        ? { token: sandbox.__nextToken }
        : { status: 'ready' }),
    }),
    alert: () => {},
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout,
    // Captured, not run: the token refresh is on a 45-minute interval and the
    // test drives its real body directly.
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval() {},
    AbortController,
    URL,
    ResizeObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    resolveDevHost: (u) => u,
    location: { origin: 'https://platform.example', hostname: 'platform.example', href: 'https://platform.example/' },
    innerWidth: 390, innerHeight: 700,
    // A real registry, so `usernode:offline-change` can actually be
    // dispatched — the reconnect ladder that re-mints a token for a frame
    // mounted offline hangs off it.
    _listeners: new Map(),
    addEventListener(type, fn) {
      if (!sandbox._listeners.has(type)) sandbox._listeners.set(type, new Set());
      sandbox._listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { sandbox._listeners.get(type)?.delete(fn); },
    dispatchEvent(ev) {
      for (const fn of [...(sandbox._listeners.get(ev.type) || [])]) fn(ev);
      return true;
    },
    // A real (in-memory) store: the offline-capable-app flag (#487
    // follow-up) round-trips through it, so a stub that forgets every write
    // would make offlineReadyFor() answer false no matter what was recorded.
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); },
    },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t.unref) t.unref(); return t; },
    __nextToken: 'tok-1',
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // THE WIRING UNDER TEST — exactly what main.tsx publishes.
  sandbox.UsernodeReact = {
    appFrame: bridgeMod.appFrameBridge,
    staging: stagingBridgeMod.stagingBridge,
    visualCompare: stagingBridgeMod.visualCompareBridge,
    // The mount half of the placeholder bridge is React's (it mounts a
    // portal); the STORE is the seam, and what this harness is about is
    // which view app-view.js publishes into it.
    appStatus: {
      mount: (_host, view) => statusStoreMod.appStatusStore.set({ view }),
      unmount: () => statusStoreMod.appStatusStore.set({ view: null }),
      clear: () => statusStoreMod.appStatusStore.set({ view: null }),
    },
  };
  if (offlineReady) {
    sandbox.localStorage.setItem(
      'usernode:offline-ready', JSON.stringify({ [SLUG]: Date.now() }),
    );
  }
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { ...record, self_hosted: false };
  // Offline, the mint fetch never lands, so there is no token to attach —
  // holding one here would hide the token-less src the offline mount
  // actually produces.
  AppView.iframeToken = offline ? null : 'tok-1';
  AppView.iframeTokenSlug = offline ? null : SLUG;

  const bridge = bridgeMod.appFrameBridge;
  const baseline = bridge.stats();
  return {
    AppView, bridge, renderer, outside, asked, intervals, sandbox, record,
    store: storeMod.appFrameStore, refs: storeMod.appFrameRefs,
    stagingIframe,
    setOffline: (v) => { offlineNow = !!v; },
    // The bridge's counters are module-scope and cumulative across cases, so
    // every assertion is made against this case's baseline.
    mounts: () => bridge.stats().mounts - baseline.mounts,
    navigations: () => bridge.stats().navigations - baseline.navigations,
    surface: () => outside['app-view'].getAttribute('data-app-surface'),
    /** The placeholder currently published, or null when a frame is up. */
    status: () => statusStoreMod.appStatusStore.get().view,
  };
}

// ── 1. THE HEADLINE: the frame survives everything ───────────────────────

test('the app frame is the SAME element and the SAME document across every state change', async () => {
  const h = await makeHarness();
  const { AppView, bridge, renderer } = h;

  // Open the App tab the ordinary way.
  AppView.renderAppTab();
  const el = bridge.frame();
  assert.ok(el, 'the island registered a frame');
  assert.equal(renderer.creates, 1, 'exactly one element created');
  assert.equal(h.mounts(), 1, 'one mount');
  assert.equal(el.loads, 1, 'one document load');
  assert.equal(h.navigations(), 1, 'one navigation');
  assert.equal(el.src, `${APP_URL}/?token=tok-1`, 'src composed through the URL API');
  assert.equal(h.surface(), 'app', '#970: the app surface is asserted');
  assert.equal(renderer.hostHidden, false, 'the frame host is visible');

  const win = el.contentWindow;
  const loads = el.loads;

  // Every step below is a state change that must NOT reload the app.
  const steps = [
    // Tab switches, both directions, three round trips. This is the case the
    // issue names first and the one that used to reload the app every time.
    ['→ Dev', async () => { try { await AppView.renderDevView('forum'); } catch { /* stubs */ } }],
    ['→ App', () => AppView.renderAppTab()],
    ['→ Dev again', async () => { try { await AppView.renderDevView('forum'); } catch { /* stubs */ } }],
    ['→ App again', () => AppView.renderAppTab()],
    ['→ Dev sessions', async () => { try { await AppView.renderDevView('sessions'); } catch { /* stubs */ } }],
    ['→ App third time', () => AppView.renderAppTab()],
    // The surface flag, both values, and a redundant re-assert.
    ['surface → platform', () => AppView._setSurface('platform')],
    ['surface → app', () => AppView._setSurface('app')],
    ['surface → app (no-op)', () => AppView._setSurface('app')],
    // A staging preview opening over the top, and closing again.
    ['staging preview open', () => {
      AppView._tokenFresh = { slug: SLUG, token: 'tok-1', at: Date.now() };
      return AppView.swapToStaging('https://preview.example', null, { verified: true });
    }],
    ['staging docked', () => AppView._setStagingMode('docked')],
    ['staging preview close', () => AppView.closeStagingOverlay()],
    // Park/activate through the seam directly (what App.switchTab reaches).
    ['park', () => AppView._parkAppFrame()],
    ['activate', () => AppView.renderAppTab()],
    // A safe-area re-broadcast (#970) — it reads the frame, it must not move it.
    ['safe-area broadcast', () => AppView.broadcastSafeArea()],
  ];
  for (const [what, run] of steps) {
    await run();
    assert.equal(bridge.frame(), el, `${what}: same element object`);
    assert.equal(renderer.creates, 1, `${what}: no element re-created`);
    assert.equal(el.contentWindow, win, `${what}: same contentWindow — no reload`);
    assert.equal(el.loads, loads, `${what}: load count unchanged`);
    assert.equal(h.mounts(), 1, `${what}: no re-mount`);
    assert.equal(h.navigations(), 1, `${what}: no navigation`);
  }

  // And the frame is still the live, active, app-surfaced frame afterwards.
  assert.equal(renderer.hostHidden, false, 'the host is visible again');
  assert.equal(h.surface(), 'app', 'and the surface flag is back on the app');
  assert.deepEqual(renderer.history, [`create:${SLUG}`],
    'one create, and nothing else, for the whole lifecycle');
});

test('switching to the Dev tab PARKS the frame — hidden host, live document', async () => {
  const h = await makeHarness();
  const { AppView, bridge, renderer } = h;
  AppView.renderAppTab();
  const el = bridge.frame();
  const win = el.contentWindow;

  try { await AppView.renderDevView('forum'); } catch { /* stubs */ }
  assert.equal(bridge.isActive(), false, 'the frame is parked');
  assert.equal(renderer.hostHidden, true, '#app-frame-host is hidden');
  assert.equal(bridge.slug(), SLUG, 'but it still belongs to this app');
  assert.equal(bridge.frame(), el, 'and the element is still there');
  assert.equal(el.contentWindow, win, 'with its document untouched');
  assert.equal(h.surface(), 'platform', 'the Dev surface keeps its clearance');
  // #app-content is what Dev mode takes over. That write is the whole reason
  // the frame had to move out of it.
  assert.equal(h.outside['app-content'].innerHTML.includes('app-iframe'), false,
    'the frame is not in #app-content any more, so a Dev render cannot clobber it');

  AppView.renderAppTab();
  assert.equal(bridge.isActive(), true, 'coming back re-activates it');
  assert.equal(renderer.hostHidden, false, 'the host is visible');
  assert.equal(bridge.frame(), el, 'same element');
  assert.equal(el.contentWindow, win, 'same document — the app never reloaded');
});

test('a chromeless enter/exit navigates the SAME element', async () => {
  const h = await makeHarness();
  const { AppView, bridge, renderer } = h;
  AppView.renderAppTab();
  const el = bridge.frame();
  assert.equal(el.loads, 1);

  // #743: a chromeless deep link is a genuine navigation — the url really does
  // change — but it must be an imperative src write on the element that is
  // already there, not a re-render.
  AppView.pendingInnerPath = '/settings?tab=profile';
  AppView.renderAppTab();
  assert.equal(bridge.frame(), el, 'entering chromeless keeps the element');
  assert.equal(renderer.creates, 1, 'nothing re-created');
  assert.equal(h.mounts(), 1, 'the mount is the same mount');
  assert.equal(el.loads, 2, 'one navigation to the inner path');
  assert.match(el.src, /\/settings\?tab=profile&token=tok-1$/,
    'inner path composed against the app origin, token appended via searchParams');

  AppView.pendingInnerPath = null;
  AppView.renderAppTab();
  assert.equal(bridge.frame(), el, 'leaving chromeless keeps the element');
  assert.equal(renderer.creates, 1, 'still nothing re-created');
  assert.equal(el.loads, 3, 'one navigation back to the root');
  assert.equal(el.src, `${APP_URL}/?token=tok-1`, 'back at the app root');

  // A render that would build the same url it is already on does nothing at all.
  const win = el.contentWindow;
  AppView.renderAppTab();
  assert.equal(el.loads, 3, 'a repeat render is not a navigation');
  assert.equal(el.contentWindow, win, 'same document');

  // And a hostile inner path can never point the frame off the app's origin.
  AppView.pendingInnerPath = '/\\evil.example/steal';
  AppView.renderAppTab();
  assert.equal(bridge.frame(), el, 'same element');
  assert.equal(new URL(el.src).origin, new URL(APP_URL).origin,
    'a path that escapes the app origin falls back to the app root');
});

test('a token refresh re-points the SAME element — parked or not', async () => {
  const h = await makeHarness();
  const { AppView, bridge, renderer, intervals, sandbox } = h;
  AppView.renderAppTab();
  const el = bridge.frame();
  assert.equal(el.loads, 1);

  AppView.startTokenRefresh();
  assert.equal(intervals.length, 1, 'the refresh is armed');
  assert.equal(intervals[0].ms, AppView.TOKEN_REFRESH_MS, 'on the 45-minute interval');

  // Run the REAL interval body with a freshly minted token.
  sandbox.__nextToken = 'tok-2';
  AppView._tokenFresh = null;
  await intervals[0].fn();
  assert.equal(bridge.frame(), el, 'the element is the same object');
  assert.equal(renderer.creates, 1, 'nothing re-created');
  assert.equal(h.mounts(), 1, 'no re-mount');
  assert.equal(el.loads, 2, 'exactly one further navigation');
  assert.match(el.src, /token=tok-2$/, 'now carrying the refreshed token');

  // A parked frame must refresh too: its app is still running, and a parked app
  // whose token expired is an app whose API calls start failing.
  AppView._parkAppFrame();
  assert.equal(bridge.isActive(), false, 'parked');
  sandbox.__nextToken = 'tok-3';
  AppView._tokenFresh = null;
  await intervals[0].fn();
  assert.equal(bridge.frame(), el, 'still the same element');
  assert.equal(el.loads, 3, 'the parked frame was refreshed');
  assert.match(el.src, /token=tok-3$/, 'with the newest token');

  // With no frame at all the refresh writes nothing.
  AppView._unmountAppFrame();
  sandbox.__nextToken = 'tok-4';
  AppView._tokenFresh = null;
  await intervals[0].fn();
  assert.equal(bridge.frame(), null, 'no frame to write to');
  assert.equal(el.loads, 3, 'and no navigation was performed on the dropped element');

  // The audience guard: a token minted for another app is never attached.
  AppView.iframeToken = 'tok-x';
  AppView.iframeTokenSlug = 'someone-elses-app';
  assert.equal(AppView.tokenForSlug(SLUG), null, 'a foreign-audience token is not reused');
});

test('the #931 eager launch is adopted, not rebuilt, and its cover fades off the live frame', async () => {
  const h = await makeHarness();
  const { AppView, bridge, renderer } = h;

  // A prewarmed token, so beginLaunch assigns src in the same tick as the tap.
  AppView._tokenFresh = { slug: SLUG, token: 'tok-1', at: Date.now() };
  assert.equal(AppView.beginLaunch(SLUG, 'app'), true, 'the eager launch took over');
  const el = bridge.frame();
  assert.ok(el, 'the frame exists before the zoom paints');
  assert.equal(el.loads, 1, 'the document request went out on the tap');
  assert.equal(el.style.opacity, '0', 'behind the cover');
  assert.ok(bridge.hasCover(), 'the launch cover is up');
  assert.equal(renderer.cover.name, 'Homeroom', 'showing the app name, raw (React escapes it)');
  assert.equal(renderer.cover.note, 'Opening…', 'and the neutral note');
  assert.equal(h.surface(), 'app', '#970 flipped on the launch');

  // The 500ms rung.
  AppView._appFrame().coverSpinner(true);
  assert.equal(renderer.cover.spinner, true, 'the spinner rung writes state, not DOM');
  assert.equal(bridge.frame(), el, 'and does not touch the frame');

  // The reveal: cross-fade on the live element.
  el.onload();
  assert.equal(el.style.opacity, '1', 'the frame faded in');
  assert.equal(renderer.cover.out, true, 'the cover is fading out');
  assert.equal(bridge.frame(), el, 'the same element throughout');
  assert.equal(el.loads, 1, 'the reveal is not a load');

  // The one-shot adoption: renderAppTab must take this frame, not rebuild it.
  const win = el.contentWindow;
  AppView.renderAppTab();
  assert.equal(bridge.frame(), el, 'renderAppTab adopted the launch frame');
  assert.equal(renderer.creates, 1, 'exactly one element for the whole open');
  assert.equal(el.loads, 1, 'exactly one document load for the whole open');
  assert.equal(el.contentWindow, win, 'same document');
  assert.equal(h.surface(), 'app', 'the adopt path re-asserts the surface');

  // The offer is one-shot, but the standing keep rule covers every later render.
  assert.equal(AppView._launchAdopt, null, 'the adoption offer was consumed');
  AppView.renderAppTab();
  assert.equal(el.loads, 1, 'and a second render still keeps the frame');
});

test('a DIFFERENT app is a different frame — slug is the key, and it is honoured', async () => {
  const h = await makeHarness();
  const { AppView, bridge, renderer } = h;
  AppView.renderAppTab();
  const first = bridge.frame();

  // Opening another app must NOT reuse the document: that would hand one app's
  // frame to another origin.
  AppView.appData = { slug: 'other-app', url: 'https://other-app.example', status: 'running' };
  AppView.iframeToken = 'tok-o';
  AppView.iframeTokenSlug = 'other-app';
  AppView.renderAppTab();
  const second = bridge.frame();
  assert.notEqual(second, first, 'a different app gets a different element');
  assert.equal(renderer.creates, 2, 'exactly one new element');
  assert.equal(h.mounts(), 2, 'and one new mount');
  assert.equal(second.loads, 1, 'loaded once');
  assert.match(second.src, /^https:\/\/other-app\.example\/\?token=tok-o$/, 'at its own origin');
  assert.deepEqual(renderer.history, [`create:${SLUG}`, 'create:other-app'],
    'two creates, one per app');
});

test('leaving the app drops the frame; a non-running app never gets one', async () => {
  const h = await makeHarness();
  const { AppView, bridge, renderer } = h;
  AppView.renderAppTab();
  assert.ok(bridge.frame(), 'mounted');
  AppView._issueStateSource = { name: 'the frame WindowProxy' };

  AppView._unmountAppFrame();
  assert.equal(bridge.frame(), null, 'the element is gone');
  assert.equal(bridge.slug(), '', 'and so is the slug');
  assert.equal(bridge.isActive(), false, 'nothing is active');
  assert.equal(AppView._issueStateSource, null,
    '#685: the announcement dies with the WindowProxy that made it');
  assert.equal(renderer.hostHidden, true, 'the host is hidden');

  // A status placeholder drops the frame rather than parking it: there is no
  // running app behind it worth keeping.
  AppView.renderAppTab();
  assert.ok(bridge.frame(), 'remounted');
  AppView.appData = { slug: SLUG, status: 'creating', url: null };
  AppView.renderAppTab();
  assert.equal(bridge.frame(), null, 'the creating placeholder has no frame');
  assert.equal(h.surface(), 'platform', 'and keeps the platform clearance');
  assert.match(h.status().message, /spinning up/, 'the placeholder is published');
});

// ── canEagerLaunch is a PREDICATE ────────────────────────────────────────
//
// It answers "would an eager launch mount the same frame renderAppTab would
// build?", and it answers no far more often than yes: a demo card, a
// self-hosted app, a non-app tab, and every app that is not running. It used
// to tear down the interim React roots that own `#app-content` on its way to
// that answer, which was invisible while the App tab's placeholders were
// hand-written innerHTML — `unmountAllLegacyPortals` cannot touch those.
//
// #1085 chunk H made the placeholders a portal, and the side effect became a
// blank App tab on exactly the apps the predicate refuses: `renderAppTab`
// painted "App failed to start · View build log", `beginLaunch` asked the
// predicate milliseconds later, and the answer arrived with the placeholder
// already swept away. A declared check reported the build-log button missing
// from a page that had rendered it.

test('asking whether an app can eager-launch does not disturb the placeholder', async () => {
  const h = await makeHarness();
  const { AppView, bridge } = h;

  for (const status of ['error', 'creating', 'awaiting_secrets']) {
    // Both sources say the app is not running: `renderAppTab` reads
    // `appData`, `canEagerLaunch` reads the HOME list record.
    h.sandbox.Home._apps[0].status = status;
    h.sandbox.Home._apps[0].url = null;
    AppView.appData = { slug: SLUG, status, url: null, lastFailure: { reason: 'boom' } };
    AppView.renderAppTab();
    const painted = h.status();
    assert.ok(painted, `${status}: the placeholder is published`);

    // The answer is no for every one of these — there is no running app to
    // launch onto — and asking must not cost the surface that IS on screen.
    assert.equal(AppView.canEagerLaunch(SLUG, 'app'), false, `${status}: no eager launch`);
    assert.equal(h.status(), painted, `${status}: the placeholder survives the question`);
    assert.equal(bridge.frame(), null, `${status}: and no frame appears`);
  }
});

test('a refused beginLaunch leaves the screen exactly as it found it', async () => {
  const h = await makeHarness();
  const { AppView } = h;

  h.sandbox.Home._apps[0].status = 'error';
  h.sandbox.Home._apps[0].url = null;
  AppView.appData = { slug: SLUG, status: 'error', url: null, lastFailure: { reason: 'boom' } };
  AppView.renderAppTab();
  const painted = h.status();

  assert.equal(AppView.beginLaunch(SLUG, 'app'), false, 'nothing to launch onto');
  assert.equal(h.status(), painted, 'the placeholder is still the one on screen');
});

test('offline shows the placeholder and drops the frame — for an app with no worker of its own', async () => {
  const h = await makeHarness({ offline: true });
  const { AppView, bridge } = h;
  AppView.renderAppTab();
  assert.equal(bridge.frame(), null, 'no cross-origin frame while offline');
  assert.match(h.status().message, /needs a connection/, 'placeholder instead');
  assert.equal(h.surface(), 'platform', 'platform surface');
  assert.equal(AppView.canEagerLaunch(SLUG, 'app'), false, 'and no eager launch either');
});

// ── #487 follow-up: an app that brought its own service worker ───────────
//
// The placeholder above was applied to EVERY app, including ones that
// precache their own shell on their own origin. For those the frame is
// exactly what should be mounted: the document comes out of the app's own
// worker cache, and refusing to create the iframe was the only thing
// preventing the offline support the app had already built from running.

test('offline MOUNTS the frame for an app that announced its own service worker', async () => {
  const h = await makeHarness({ offline: true, offlineReady: true });
  const { AppView, bridge } = h;
  AppView.renderAppTab();

  const el = bridge.frame();
  assert.ok(el, 'the offline-capable app gets its frame');
  assert.equal(h.status(), null, 'and no placeholder');
  assert.equal(h.surface(), 'app', 'the app surface, not the platform one');
  // No mint is possible offline, so the app boots token-less and recovers
  // its identity from its own storage (that is the app-side contract).
  assert.equal(el.src, `${APP_URL}/`, 'src carries no token offline');
  assert.equal(el.loads, 1, 'exactly one document load');
  assert.equal(AppView.canEagerLaunch(SLUG, 'app'), true, 'eager launch is allowed too');
});

test('coming back online re-mints and reloads a frame that was mounted token-less', async () => {
  const h = await makeHarness({ offline: true, offlineReady: true });
  const { AppView, bridge, sandbox } = h;
  AppView.renderAppTab();
  const el = bridge.frame();
  assert.equal(el.src, `${APP_URL}/`, 'token-less to begin with');

  // The connection returns. Offline.isOffline() flips and the shell's own
  // `usernode:offline-change` event fires — the same signal the placeholder
  // path has always used to re-render.
  h.setOffline(false);
  sandbox.__nextToken = 'tok-2';
  sandbox.dispatchEvent({ type: 'usernode:offline-change', detail: { offline: false } });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(bridge.frame().src, `${APP_URL}/?token=tok-2`,
    'the app is reloaded with a token so its API calls stop 401-ing');
  assert.equal(bridge.frame().loads, 2, 'one deliberate reload, not a loop');
});

test('only the mounted production frame can mark an app offline-capable', async () => {
  const h = await makeHarness();
  const { AppView, bridge, sandbox } = h;
  AppView.renderAppTab();
  const win = bridge.frame().contentWindow;

  assert.equal(AppView.offlineReadyFor(SLUG), false, 'nothing recorded yet');

  // A frame that is not the app frame (a staging preview runs unmerged
  // code) must not be able to speak for the production app.
  AppView.handleOfflineReadyMessage({
    source: h.stagingIframe.contentWindow, data: { __usernode_offline_ready: 'ready' },
  });
  assert.equal(AppView.offlineReadyFor(SLUG), false, 'the staging frame is ignored');

  AppView.handleOfflineReadyMessage({ source: win, data: { __usernode_offline_ready: 'ready' } });
  assert.equal(AppView.offlineReadyFor(SLUG), true, 'the production frame is believed');

  // An app that loses its worker stops being opened offline.
  AppView.handleOfflineReadyMessage({ source: win, data: { __usernode_offline_ready: 'not-ready' } });
  assert.equal(AppView.offlineReadyFor(SLUG), false, 'withdrawn again');

  // And the flag does not survive a session ending.
  AppView.handleOfflineReadyMessage({ source: win, data: { __usernode_offline_ready: 'ready' } });
  AppView.clearOfflineReady();
  assert.equal(AppView.offlineReadyFor(SLUG), false, 'cleared with the session');
  assert.equal(sandbox.localStorage.getItem('usernode:offline-ready'), null, 'and the key is gone');
});

test('the offline-app screenshot states are self-contained — no running app required', async () => {
  // The two dapp.json checks added with #1356 named a real slug and asserted
  // on the App tab. The checks environment has no guarantee of a running app
  // with a live origin behind the preview, so renderAppTab reached NEITHER
  // branch and both checks failed — including the one for the behaviour the
  // change did not touch. These states are synthesised now; this pins that.
  const h = await makeHarness({ offline: true });
  const { AppView, bridge } = h;

  AppView.showOfflineAppShot(true);
  assert.ok(bridge.frame(), 'the ready state mounts a frame');
  assert.equal(h.surface(), 'app', 'on the app surface');
  assert.equal(bridge.frame().src, 'https://platform.example/health',
    "pointed at the shell's own /health, not a fabricated cross-origin app");
  assert.equal(h.status(), null, 'and no placeholder underneath it');

  AppView.showOfflineAppShot(false);
  assert.equal(bridge.frame(), null, 'the blocked state drops the frame again');
  assert.match(h.status().message, /needs a connection/,
    'and paints the placeholder the unchanged path still produces');
  assert.equal(h.surface(), 'platform', 'back on the platform surface');
});

test('an offline-ready record older than its TTL is not trusted', async () => {
  const h = await makeHarness({ offline: true });
  const { AppView, bridge, sandbox } = h;
  sandbox.localStorage.setItem('usernode:offline-ready', JSON.stringify({
    [SLUG]: Date.now() - (AppView.OFFLINE_READY_TTL_MS + 1000),
  }));
  assert.equal(AppView.offlineReadyFor(SLUG), false, 'expired');
  AppView.renderAppTab();
  assert.equal(bridge.frame(), null, 'so it gets the placeholder, not a dead frame');
});

test('the bridge refuses to act on a frame it does not own', async () => {
  const storeMod = await import(
    new URL('../frontend/src/features/app-frame/app-frame-store.js', `file://${__filename}`).href
  );
  const bridgeMod = await import(
    new URL('../frontend/src/features/app-frame/app-frame-bridge.js', `file://${__filename}`).href
  );
  const bridge = bridgeMod.appFrameBridge;
  storeMod.appFrameStore.set({ slug: '', active: false, faded: true, cover: null });
  storeMod.appFrameRefs.iframe = null;

  assert.equal(bridge.frame(), null, 'no element before the island mounts');
  assert.equal(bridge.hasFrame(), false);
  assert.equal(bridge.setSrc('https://x.example'), false,
    'a src write with no registered element is refused, not queued onto the document');
  assert.equal(bridge.setOnLoad(() => {}), false, 'nor is a load handler installed');
  assert.equal(bridge.mount({ slug: '' }), false, 'a slugless mount is refused');
  assert.equal(bridge.keeps({ slug: SLUG, src: 'https://x.example' }), false,
    'and nothing is "kept" when there is nothing there');
  assert.equal(bridge.activate(), false, 'activating an empty host is a no-op');
  bridge.park();
  bridge.unmount();
  bridge.dropCover();
  bridge.coverNote('x');
  bridge.coverSpinner(true); // none of these may throw
});

// ── 2. STRUCTURAL: what makes React keep the element ─────────────────────

test('the island renders one iframe, keyed only by slug, with no src prop', () => {
  // From the rendered JSX only — the header comment discusses `<iframe>` and
  // `key` at length.
  const body = FRAME.slice(FRAME.indexOf('const AppFrame = memo('));
  const open = body.indexOf('<iframe');
  assert.ok(open !== -1, 'the island renders the iframe');
  const tag = body.slice(open, body.indexOf('>', open) + 1);
  assert.ok(!/\bkey=/.test(tag), 'no key on the element itself');
  assert.ok(!/\bsrc=/.test(tag), 'no src prop — a re-applied src prop is a reload');
  assert.match(tag, /ref=\{iframeRef\}/, 'src is assigned imperatively through this ref');
  assert.match(tag, /className="w-full h-full border-0"/, 'a constant className string');
  assert.equal(body.split('<iframe').length - 1, 1,
    'exactly one iframe element — no second element a branch could swap in');

  // The ONE key in the file is `key={state.slug}`, on <AppFrame/>.
  const keys = FRAME.match(/\bkey=\{[^}]*\}/g) || [];
  assert.deepEqual(keys, ['key={state.slug}'],
    'slug is the only key — a different app is a different frame, nothing else is');

  // The iframe is the first child of the fragment and the cover trails it, so
  // the cover coming and going can never move the iframe's position.
  const frag = body.slice(body.indexOf('return ('));
  assert.ok(frag.indexOf('<iframe') < frag.indexOf('<LaunchCover'),
    'the iframe precedes the cover');
  assert.ok(frag.indexOf('{cover ?') > frag.indexOf('<iframe'),
    'the only conditional in the subtree is AFTER the iframe');
});

test('the wrapper above the frame is unconditional, and parking hides rather than unmounts', () => {
  const host = FRAME.slice(FRAME.indexOf('export function AppFrameHost'));
  // The `position: relative` parent — the role #app-content's own
  // `position: relative` used to play — is rendered outside the conditional, so
  // the frame's parent node is the same node for the document's lifetime.
  const wrapper = host.indexOf('<div className="app-launch-host w-full h-full">');
  assert.ok(wrapper !== -1, 'the launch host wrapper is rendered');
  assert.ok(wrapper < host.indexOf('{state.slug ?'),
    'and it is OUTSIDE the conditional that mounts the frame');
  assert.match(host, /\{state\.slug \? <AppFrame key=\{state\.slug\} slug=\{state\.slug\} \/> : null\}/,
    'the frame exists iff there is a slug');
  // `active` must not gate the frame's existence: parking is a class toggle.
  assert.match(host, /useHiddenClass\(hostRef, !state\.active\)/,
    'parking hides the host through a ref');
  assert.ok(!/state\.active \?/.test(host),
    'active never appears in a conditional that renders elements');
  assert.ok(!/className=\{/.test(ISLAND), 'the #app-view island has only constant classNames');
  // The frame host is a SIBLING of #app-content, which stays a hand-written
  // innerHTML host: that split is what keeps a Dev render off the frame.
  assert.match(ISLAND, /id="app-content"/, '#app-content is still rendered');
  assert.match(ISLAND, /<AppFrameHost \/>/, 'with the frame host beside it');
  assert.ok(ISLAND.indexOf('id="app-content"') < ISLAND.indexOf('<AppFrameHost />'),
    'in that order — #app-content first, as in the shipped markup');
  assert.match(ISLAND, /data-app-surface="platform"/, '#970 ships the platform surface');
});

test('`src` is not state, and the store starts from the prerendered markup', () => {
  const store = STORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bsrc\b\s*:/.test(store), 'the store has no src field');
  // The initial values ARE the prerendered document (no #app-iframe existed in
  // index.html at all); anything else is a hydration mismatch, which
  // console.errors and fails proposal checks.
  assert.match(store, /slug: '',/, 'no frame ships');
  assert.match(store, /active: false,/, 'the host ships hidden');
  assert.match(store, /faded: true,/, 'the #931 cross-fade starts faded');
  assert.match(store, /cover: null,/, 'and no cover');
  // Exactly one place in the whole chain assigns src.
  const srcWrites = BRIDGE.match(/el\.src = /g) || [];
  assert.equal(srcWrites.length, 1, 'exactly one src assignment: setSrc');
  assert.match(BRIDGE, /appFrameRefs\.iframe/, 'and it goes through the registered ref');
  assert.ok(!/document\.getElementById/.test(BRIDGE),
    'the bridge never reaches for the element by id — only the ref React published');
});

test('the seam is published before hydration and writes flush synchronously', () => {
  assert.match(MAIN, /import '\.\/features\/app-frame\/mount';/, 'main.tsx imports the seam');
  assert.ok(
    MAIN.indexOf("import './features/app-frame/mount';") < MAIN.indexOf('hydrateRoot('),
    'published before hydration — beginLaunch may run on the very first tap'
  );
  assert.match(MOUNT, /if \(typeof window !== 'undefined'\) \{/, 'guarded for the SSG pass');
  assert.match(MOUNT, /bridge\.appFrame = appFrameBridge;/, 'published as UsernodeReact.appFrame');
  // flushSync, because beginLaunch reads the element back on its next line.
  assert.match(MOUNT, /appFrameStore\.setFlush\(flushSync\);/, 'frame writes flush synchronously');
  assert.match(SHELL, /<AppViewIsland \/>/, '<Shell/> renders the app-view island');
});

test('the legacy module never writes into the React-owned frame', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // The fallback DOM adapter is the one place allowed to build the frame by
  // hand: it is what runs where the bundle is not (the node-side render tests,
  // a browser whose bundle failed to load), and there it is the sole writer.
  const from = code.indexOf('_appFrameDom: {');
  const to = code.indexOf('_parkAppFrame() {');
  assert.ok(from !== -1 && to > from, 'the fallback adapter is where the split expects it');
  const adapter = code.slice(from, to);
  // The `?shot=app-launching` screenshot state is the other deliberate
  // exception: it paints a PINNED, FRAMELESS cover of its own into #app-content
  // (there is no app behind it — a React frame would try to load a real origin),
  // and it unmounts the React frame first so the two can never overlap.
  const shotFrom = code.indexOf('showLaunchCoverShot() {');
  const shotTo = code.indexOf('renderAppTab() {');
  assert.ok(shotFrom !== -1 && shotTo > shotFrom, 'the shot path is where the split expects it');
  const shot = code.slice(shotFrom, shotTo);
  assert.ok(shot.includes('AppView._unmountAppFrame();'),
    'the shot drops the React frame before painting its own cover');
  const outside = code.slice(0, from) + code.slice(to, shotFrom) + code.slice(shotTo);

  assert.ok(adapter.includes("_el('app-iframe')"), 'the adapter resolves the frame itself');

  // Outside it, every #app-iframe lookup must be a READ: a contentWindow
  // comparison for an inbound postMessage, or the safe-area rect.
  for (const m of outside.matchAll(/getElementById\('app-iframe'\)([\s\S]{0,160})/g)) {
    assert.ok(
      /contentWindow|getBoundingClientRect/.test(m[1]),
      `every #app-iframe lookup outside the adapter must be a read, got: ${m[1].slice(0, 80)}`
    );
  }
  // No id-based lookup of the cover's nodes outside those two either.
  for (const id of ['app-launch-cover', 'app-launch-cover-note', 'app-launch-cover-spinner']) {
    const hits = (outside.match(new RegExp(`getElementById\\('${id}'\\)`, 'g')) || []).length;
    assert.equal(hits, 0, `no getElementById('${id}') outside the adapter and the shot path`);
  }
  // And nothing hand-builds an app iframe any more: the only mention of the
  // markup helper outside the adapter is its own definition. (The shot path
  // renders a cover with no frame at all.)
  const builders = (outside.match(/_appIframeHtml\(/g) || []);
  assert.equal(builders.length, 1,
    'the only remaining hand-built iframe is the one in _appIframeHtml itself');
  assert.ok(!shot.includes('_appIframeHtml('), 'and the shot mounts no frame');
});

test('every path that owned #app-content goes through the frame seam', () => {
  // The seam is the single call site; these are the verbs, and each one must be
  // reached from the module rather than open-coded.
  for (const call of [
    'AppView._appFrame()',            // the adopt-or-fall-back resolver
    'frame.mount({ slug, cover: AppView._coverDescriptor(rec), faded: true })', // #931 launch
    'frame.mount({ slug: appData.slug, faded: false })',                        // plain render
    'frame.setSrc(iframeSrc)',        // imperative navigation
    'frame.setOnLoad(',               // one slot, not a stacking listener
    'AppView._parkAppFrame()',        // Dev tab
    'AppView._unmountAppFrame()',     // leaving the app
    'frame.keeps({ slug: appData.slug, src: iframeSrc })',  // the standing keep rule
  ]) {
    assert.ok(SRC.includes(call), `app-view.js calls ${call}`);
  }
  // Dev mode parks; it must never unmount, or the tab switch is a reload again.
  const dev = SRC.slice(SRC.indexOf('async renderDevView('), SRC.indexOf('_devForumScroll'));
  assert.ok(dev.includes('AppView._parkAppFrame();'), 'renderDevView parks the frame');
  assert.ok(!dev.includes('AppView._unmountAppFrame();'), 'and never drops it');
  // Closing the app does drop it — from the zoom-out's `after` callback, so the
  // shrinking card keeps showing the app until it lands.
  const appJs = read('public/js/app.js');
  assert.ok(appJs.includes('AppView._unmountAppFrame();'),
    'closeApp drops the frame when the app is actually left');
});

test('background updates preserve the app frame and clear when another app opens', async () => {
  const h = await makeHarness();
  h.bridge.mount({ slug: SLUG, faded: false });
  h.bridge.setSrc(APP_URL);
  const frame = h.bridge.frame();
  const win = frame.contentWindow;
  const loads = frame.loads;
  h.AppView.handleBackgroundBridgeMessage({ source: win,
    data: { __usernode_background: 'changed', color: '#0a0d14' } });
  assert.equal(h.renderer.el.style.backgroundColor, '#0a0d14');
  h.bridge.park(); h.bridge.activate();
  h.bridge.mount({ slug: SLUG, faded: false });
  assert.equal(h.bridge.frame(), frame);
  assert.equal(frame.contentWindow, win);
  assert.equal(frame.loads, loads);
  assert.equal(h.store.get().background, '#0a0d14');
  h.bridge.mount({ slug: 'another-app', faded: false });
  assert.equal(h.store.get().background, '');
  h.AppView.handleBackgroundBridgeMessage({ source: win,
    data: { __usernode_background: 'changed', color: '#0a0d14' } });
  assert.equal(h.store.get().background, '', 'a departed app cannot paint the next frame');
});
