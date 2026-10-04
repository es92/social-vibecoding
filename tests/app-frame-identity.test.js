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
const POLICY = read('frontend/src/features/app-frame/app-frame-policy.js');
const ISLAND = read('frontend/src/features/app-frame/app-view-island.tsx');
const STORE = read('frontend/src/features/app-frame/app-frame-store.js');
const BRIDGE = read('frontend/src/features/app-frame/app-frame-bridge.js');
const MOUNT = read('frontend/src/features/app-frame/mount.ts');
const MAIN = read('frontend/src/main.tsx');
const SHELL = read('frontend/src/Shell.tsx');
const DAPP = JSON.parse(read('dapp.json'));

const SLUG = 'usernode-2d5619';
const APP_URL = 'https://usernode-2d5619.example';

// ── the fake iframe ──────────────────────────────────────────────────────
//
// `contentWindow` is replaced on every navigation and `loads` counts them, so a
// reload is caught even in the (impossible-by-construction) case where the
// element object itself were somehow reused across one.
let frameSeq = 0;
function makeIframe({ platformOrigin = 'https://platform.example' } = {}) {
  frameSeq += 1;
  const el = {
    id: 'app-iframe',
    tagName: 'IFRAME',
    // Which element generation this is. Two different values for one app is the
    // failure this whole file exists to prevent.
    gen: frameSeq,
    loads: 0,
    _src: '',
    _sandbox: '',
    navigationSandboxes: [],
    isConnected: true,
    ownerDocument: { defaultView: { location: { origin: platformOrigin } } },
    contentWindow: { name: `win-${frameSeq}-0`, posted: [], postMessage(m) { this.posted.push(m); } },
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
    getAttribute(name) {
      if (name === 'src') return el._src || null;
      if (name === 'sandbox') return el._sandbox;
      return null;
    },
    setAttribute(name, value) {
      if (name === 'sandbox') el._sandbox = String(value);
    },
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
        el.navigationSandboxes.push(el._sandbox);
        el.loads += 1;
        el.contentWindow = { name: `win-${el.gen}-${el.loads}`, posted: [], postMessage(m) { this.posted.push(m); } };
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
function attachRenderer(store, refs, policy) {
  const r = {
    el: null, key: null, renders: 0, creates: 0, hostHidden: true,
    history: [],
    // #2902: every live element by slug — the mounted one and the kept ones.
    els: new Map(),
  };
  const render = () => {
    r.renders += 1;
    const state = store.get();
    const { slug, active, faded, sandboxReady, cover } = state;
    const kept = state.kept || [];
    const live = [...kept.map((k) => k.slug), ...(slug ? [slug] : [])];
    // A key that leaves the live set is unmounted: its element is gone.
    for (const [key, el] of [...r.els]) {
      if (live.includes(key)) continue;
      r.els.delete(key);
      el.isConnected = false;
      if (refs.kept && refs.kept[key] === el) delete refs.kept[key];
      r.history.push(`unmount:${key}`);
    }
    // A key that joins it is created — and ONLY then.
    for (const key of live) {
      if (r.els.has(key)) continue;
      r.els.set(key, makeIframe());
      r.creates += 1;
      r.history.push(`create:${key}`);
    }
    for (const k of kept) {
      const el = r.els.get(k.slug);
      el.id = '';
      el.kept = true;
      el.setAttribute('sandbox', k.sandboxReady ? policy.APP_FRAME_SANDBOX : policy.PENDING_FRAME_SANDBOX);
      if (refs.kept) refs.kept[k.slug] = el;
    }
    if (!slug) {
      r.key = null;
      r.el = null;
      refs.iframe = null;
    } else {
      r.key = slug;
      r.el = r.els.get(slug);
      r.el.id = 'app-iframe';
      r.el.kept = false;
      if (refs.kept && refs.kept[slug] === r.el) delete refs.kept[slug];
      // Rendered props: a style change updates the existing node.
      r.el.style.opacity = faded ? '0' : '1';
      r.el.style.backgroundColor = state.background || '';
      r.el.setAttribute(
        'sandbox',
        sandboxReady ? policy.APP_FRAME_SANDBOX : policy.PENDING_FRAME_SANDBOX
      );
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
  const policyMod = await import(
    new URL('../frontend/src/features/app-frame/app-frame-policy.js', `file://${__filename}`).href
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
  storeMod.appFrameStore.set({
    slug: '', active: false, faded: true, background: '', sandboxReady: false, cover: null,
    seq: 0, navigatedAt: 0, build: '', stale: false, kept: [],
  });
  storeMod.appFrameRefs.iframe = null;
  storeMod.appFrameRefs.kept = {};
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

  const renderer = attachRenderer(storeMod.appFrameStore, storeMod.appFrameRefs, policyMod);

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
    fetch: async (url) => sandbox.__fetch(url),
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
  sandbox.__fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/api/iframe-token')
      ? { token: sandbox.__nextToken }
      : { status: 'ready' }),
  });
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
  assert.equal(el.src, `${APP_URL}/?token=tok-1&un-theme=dark`, 'src composed through the URL API');
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
    // #3257: a theme toggle reaches the app over the bridge. The url a render
    // would build now carries the other `un-theme`, and that must not read as
    // a new url: App → Dev → App after a toggle keeps the document.
    ['theme → light', () => {
      h.sandbox.document.documentElement.classList.contains = () => false;
      AppView.broadcastTheme();
    }],
    ['→ Dev after the toggle', async () => { try { await AppView.renderDevView('forum'); } catch { /* stubs */ } }],
    ['→ App after the toggle', () => AppView.renderAppTab()],
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
  assert.match(el.src, /\/settings\?tab=profile&token=tok-1&un-theme=dark$/,
    'inner path composed against the app origin, token appended via searchParams');

  AppView.pendingInnerPath = null;
  AppView.renderAppTab();
  assert.equal(bridge.frame(), el, 'leaving chromeless keeps the element');
  assert.equal(renderer.creates, 1, 'still nothing re-created');
  assert.equal(el.loads, 3, 'one navigation back to the root');
  assert.equal(el.src, `${APP_URL}/?token=tok-1&un-theme=dark`, 'back at the app root');

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
  assert.match(el.src, /token=tok-2&un-theme=dark$/, 'now carrying the refreshed token');

  // A parked frame must refresh too: its app is still running, and a parked app
  // whose token expired is an app whose API calls start failing.
  AppView._parkAppFrame();
  assert.equal(bridge.isActive(), false, 'parked');
  sandbox.__nextToken = 'tok-3';
  AppView._tokenFresh = null;
  await intervals[0].fn();
  assert.equal(bridge.frame(), el, 'still the same element');
  assert.equal(el.loads, 3, 'the parked frame was refreshed');
  assert.match(el.src, /token=tok-3&un-theme=dark$/, 'with the newest token');

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
  assert.match(second.src, /^https:\/\/other-app\.example\/\?token=tok-o&un-theme=dark$/, 'at its own origin');
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
  assert.notEqual(AppView._statusPollTimer, null,
    'and one HTTP recovery is armed in case the terminal WebSocket event was missed');
  AppView._stopStatusPolling();
});

test('#2154: a running event that beats the first detail response clears the spinner', async () => {
  const h = await makeHarness();
  const { AppView, sandbox } = h;
  AppView.appData = null;
  AppView.prefetchDevData = () => {};
  AppView.startActivityTracking = () => {};
  AppView.startTokenRefresh = () => {};

  let releaseDetail;
  const detail = new Promise((resolve) => { releaseDetail = resolve; });
  sandbox.__fetch = async (url) => {
    if (String(url).includes('/api/iframe-token')) {
      return { ok: true, json: async () => ({ token: 'tok-1' }) };
    }
    if (String(url).split('?')[0] === `/api/apps/${SLUG}`) return detail;
    return { ok: true, json: async () => ({ status: 'ready' }) };
  };

  const opening = AppView.open(SLUG);
  AppView._rememberPendingAppStatus({
    slug: SLUG, status: 'running', url: APP_URL,
  });
  releaseDetail({
    ok: true,
    json: async () => ({ app: { slug: SLUG, name: 'Homeroom', status: 'creating', url: null } }),
  });
  await opening;

  assert.equal(AppView.appData.status, 'running', 'the newer terminal event wins');
  assert.equal(AppView.appData.url, APP_URL, 'the live app URL comes with it');
  AppView.renderAppTab();
  assert.equal(h.status(), null, 'the stale spinning-up placeholder is not painted');
  assert.ok(h.bridge.frame(), 'the live app frame is mounted without a page refresh');
});

test('#2154: a new creating phase invalidates a terminal event from an earlier attempt', async () => {
  const h = await makeHarness();
  const { AppView } = h;
  AppView._rememberPendingAppStatus({ slug: SLUG, status: 'error', errorReason: 'old failure' });
  AppView._rememberPendingAppStatus({ slug: SLUG, status: 'creating', phase: 'build' });

  const detail = { slug: SLUG, status: 'creating', url: null };
  assert.equal(AppView._applyPendingAppStatus(detail), detail,
    'retry progress clears the obsolete terminal event');
});

// ── #15: a first version being built mounts no frame ─────────────────────
//
// While the Homeroom bot builds a project's first version from its
// description, the running app is the starter its repo was scaffolded with.
// The App tab says what is happening instead, BEFORE any frame mounts, and
// mounts the app once it is built or once the viewer asks for the starter.

const BUILDING = { building: true, mine: true, step: 4, of: 7, stepName: 'Build it', creator: 'ada', ready: false, question: false, conversationId: 9 };

test('#15: a first version being built shows its screen, not the starter, and drops a launched frame', async () => {
  const h = await makeHarness();
  const { AppView, bridge } = h;

  // The Home tile's eager launch mounts the starter off the cached list
  // record, which knows nothing of the first version…
  AppView._tokenFresh = { slug: SLUG, token: 'tok-1', at: Date.now() };
  assert.equal(AppView.beginLaunch(SLUG, 'app'), true);
  assert.ok(bridge.frame(), 'launched');
  // …and the detail record does: the render drops it rather than adopting it.
  AppView.appData = { ...h.record, self_hosted: false, first_version: { ...BUILDING } };
  AppView.renderAppTab();
  assert.equal(bridge.frame(), null, 'no frame while it is being built');
  assert.equal(AppView._launchAdopt, null, 'and the launch offer is retired with it');
  assert.equal(h.surface(), 'platform', 'a platform screen keeps the clearance');
  const shown = h.status();
  assert.equal(shown.message, 'Homeroom is being built from your description');
  assert.deepEqual([...shown.lines], ['Step 4 of 7: Build it', 'We’ll message you when it’s ready.']);
  assert.equal(shown.action.key, 'botChat');
  assert.notEqual(AppView._firstVersionTimer, null, 'one recheck is armed while it is up');

  // Rendering again keeps the one timer.
  const timer = AppView._firstVersionTimer;
  AppView.renderAppTab();
  assert.equal(AppView._firstVersionTimer, timer);

  // "Show the starter for now": the app, framed as usual.
  AppView.showStarter(SLUG);
  assert.ok(bridge.frame(), 'the starter is framed');
  assert.equal(h.status(), null, 'the screen is gone');
  assert.equal(h.surface(), 'app');
  assert.equal(AppView._firstVersionTimer, null, 'nothing is re-asked once the viewer chose the app');
  AppView._starterShown.delete(SLUG);
});

test('#15: once it is built, the next render mounts the app', async () => {
  const h = await makeHarness();
  const { AppView, bridge } = h;
  AppView.appData = { ...h.record, self_hosted: false, first_version: { ...BUILDING } };
  AppView.renderAppTab();
  assert.equal(bridge.frame(), null);
  AppView.appData = { ...h.record, self_hosted: false, first_version: null };
  AppView.renderAppTab();
  assert.ok(bridge.frame(), 'mounted');
  assert.equal(h.status(), null);
  assert.equal(AppView._firstVersionTimer, null, 'and the recheck stops');
  // So does a placeholder of another kind, and leaving the app.
  AppView.appData = { ...h.record, self_hosted: false, first_version: { ...BUILDING } };
  AppView.renderAppTab();
  assert.notEqual(AppView._firstVersionTimer, null);
  AppView.appData = { slug: SLUG, status: 'error', url: null, first_version: { ...BUILDING } };
  AppView.renderAppTab();
  assert.equal(AppView._firstVersionTimer, null);
  assert.equal(h.status().message, 'App failed to start');
  const close = SRC.slice(SRC.indexOf('  close() {'), SRC.indexOf('AppView.appData = null;', SRC.indexOf('  close() {')));
  assert.match(close, /AppView\._stopFirstVersionWatch\(\);/);
});

test('#15: the first-version screenshot state is self-contained, and mounts no frame', async () => {
  const h = await makeHarness();
  const { AppView, bridge } = h;
  AppView.renderAppTab();
  assert.ok(bridge.frame(), 'an app was up');
  AppView.showFirstVersionShot();
  assert.equal(bridge.frame(), null, 'the shot drops it, and loads nothing of its own');
  assert.equal(h.surface(), 'platform');
  const shown = h.status();
  assert.equal(shown.message, 'Plant Pal is being built from your description');
  assert.deepEqual([...shown.lines], ['Step 4 of 7: Build it', 'We’ll message you when it’s ready.']);
  assert.equal(shown.action.key, 'botChat');
  assert.equal(shown.secondary.key, 'starter');
  assert.equal(AppView.appData.url, null, 'no address, so the starter never frames anything');
  const appJs = read('public/js/app.js');
  const routeShots = appJs.slice(appJs.indexOf('  _applyRouteShots() {'), appJs.indexOf('\n  },', appJs.indexOf('  _applyRouteShots() {')));
  assert.match(routeShots, /App\._applyFirstVersionShot\(\);/, 'reached as ?shot=first-version');
  // B6: and `?shot=first-version-plan`, the same screen while its plan waits.
  assert.match(appJs, /if \(shot !== 'first-version' && shot !== 'first-version-plan'\) return;\s*try \{\s*if \(typeof AppView !== 'undefined'\) AppView\.showFirstVersionShot\(shot === 'first-version-plan'\);/);
  AppView.showFirstVersionShot(true);
  const planned = h.status();
  assert.deepEqual([...planned.lines], ['Step 3 of 7: Write a plan'], 'the card says what comes next');
  assert.equal(planned.action, null, 'Change something is the way into the chat');
  assert.equal(planned.plan.bullets.length, 3);
  assert.deepEqual([...planned.plan.questions[0].answers], ['In the app', 'Phone alert']);
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

test('a same-origin app address is never eagerly launched or framed', async () => {
  const h = await makeHarness();
  const { AppView, bridge } = h;
  const unsafe = 'https://platform.example/app';

  h.sandbox.Home._apps[0].url = unsafe;
  AppView.appData = { ...AppView.appData, url: unsafe };
  assert.equal(AppView.canEagerLaunch(SLUG, 'app'), false,
    'the cached launch path fails closed before mounting');

  AppView.renderAppTab();
  assert.equal(bridge.frame(), null, 'the detailed render also mounts no frame');
  assert.deepEqual(JSON.parse(JSON.stringify(h.status())), {
    dot: 'error',
    message: 'This app cannot open safely.',
    detail: 'Its address is not isolated from Homeroom.',
    action: null,
  });
  assert.equal(h.surface(), 'platform', 'the error stays on the platform surface');
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
  assert.equal(el.src, `${APP_URL}/?un-theme=dark`, 'src carries no token offline');
  assert.equal(el.loads, 1, 'exactly one document load');
  assert.equal(AppView.canEagerLaunch(SLUG, 'app'), true, 'eager launch is allowed too');
});

test('coming back online re-mints and reloads a frame that was mounted token-less', async () => {
  const h = await makeHarness({ offline: true, offlineReady: true });
  const { AppView, bridge, sandbox } = h;
  AppView.renderAppTab();
  const el = bridge.frame();
  assert.equal(el.src, `${APP_URL}/?un-theme=dark`, 'token-less to begin with');

  // The connection returns. Offline.isOffline() flips and the shell's own
  // `usernode:offline-change` event fires — the same signal the placeholder
  // path has always used to re-render.
  h.setOffline(false);
  sandbox.__nextToken = 'tok-2';
  sandbox.dispatchEvent({ type: 'usernode:offline-change', detail: { offline: false } });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(bridge.frame().src, `${APP_URL}/?token=tok-2&un-theme=dark`,
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
  assert.equal(bridge.frame().getAttribute('src'), null,
    'the self-contained fixture does not navigate to the platform origin');
  assert.equal(bridge.frame().getAttribute('sandbox'), '',
    'its blank document stays fully restricted');
  assert.equal(h.status(), null, 'and no placeholder underneath it');

  AppView.showOfflineAppShot(false);
  assert.equal(bridge.frame(), null, 'the blocked state drops the frame again');
  assert.match(h.status().message, /needs a connection/,
    'and paints the placeholder the unchanged path still produces');
  assert.equal(h.surface(), 'platform', 'back on the platform surface');
});

test('#2154: the settled launch screenshot reproduces the status/detail race', async () => {
  const h = await makeHarness();
  const { AppView, bridge } = h;

  AppView.showSettledLaunchShot();

  assert.equal(AppView.appData.status, 'running', 'the pending terminal event wins');
  assert.equal(AppView._pendingAppStatus['staging-demo-status-race'], undefined,
    'the synthetic pending event is consumed just like open() consumes it');
  assert.equal(h.status(), null, 'no spinning-up placeholder remains');
  assert.ok(bridge.frame(), 'the resolved state mounts a live frame');
  assert.equal(bridge.frame().getAttribute('src'), null,
    'the synthetic state does not navigate to the platform origin');
  assert.equal(bridge.frame().getAttribute('sandbox'), '',
    'its blank document stays fully restricted');

  const declaredCheck = DAPP.tests.find((check) =>
    check.path === '/?shot=app-launching&settle=1');
  assert.equal(declaredCheck?.expectSelector, '#app-iframe[sandbox=""]:not([src])',
    'the staging check requires the same source-less, fully restricted frame');
});

test('the app-frame URL policy allows only absolute cross-origin HTTP(S) targets', async () => {
  const policy = await import(
    new URL('../frontend/src/features/app-frame/app-frame-policy.js', `file://${__filename}`).href
  );
  const platform = 'https://platform.example';

  assert.equal(policy.isSafeAppFrameSrc(APP_URL, platform), true);
  assert.equal(policy.isSafeAppFrameSrc('http://localhost:4100/app', 'http://localhost:3000'), true,
    'a distinct local-development port is a distinct origin');
  for (const src of [
    'https://platform.example/app',
    '/relative-app',
    'data:text/html,hello',
    'javascript:void(0)',
    'not a url',
    '',
  ]) {
    assert.equal(policy.isSafeAppFrameSrc(src, platform), false, `${src || '(empty)'} is refused`);
  }
  assert.equal(policy.isSafeAppFrameSrc(APP_URL, ''), false, 'a missing platform origin fails closed');
});

test('the bridge restricts the blank frame, then enables the app sandbox before navigation', async () => {
  const h = await makeHarness();
  const fullSandbox = 'allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock';

  h.bridge.mount({ slug: SLUG, faded: false });
  const frame = h.bridge.frame();
  assert.equal(frame.getAttribute('sandbox'), '', 'the pending blank frame grants no permissions');
  assert.equal(h.store.get().sandboxReady, false);

  assert.equal(h.bridge.setSrc(APP_URL), true);
  assert.equal(frame.getAttribute('sandbox'), fullSandbox);
  assert.deepEqual(frame.navigationSandboxes, [fullSandbox],
    'the full sandbox was present at the instant the document navigation began');
  assert.equal(h.store.get().sandboxReady, true);

  const loads = frame.loads;
  assert.equal(h.bridge.setSrc('https://platform.example/app'), false,
    'a same-origin target is refused at the final bridge boundary');
  assert.equal(frame.loads, loads, 'the refused target did not navigate');
  assert.equal(frame.src, APP_URL, 'and the safe app document remains in place');

  h.bridge.park();
  h.bridge.activate();
  assert.equal(h.bridge.frame(), frame, 'parking still preserves the element');
  assert.equal(frame.getAttribute('sandbox'), fullSandbox, 'and its navigable sandbox state');

  h.bridge.mount({ slug: 'another-app', faded: false });
  assert.notEqual(h.bridge.frame(), frame, 'a different app still receives a new element');
  assert.equal(h.bridge.frame().getAttribute('sandbox'), '',
    'the next app starts from the restricted pending state again');
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
  storeMod.appFrameStore.set({
    slug: '', active: false, faded: true, background: '', sandboxReady: false, cover: null,
    seq: 0, navigatedAt: 0, kept: [],
  });
  storeMod.appFrameRefs.iframe = null;
  storeMod.appFrameRefs.kept = {};

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

  // The ONE key in the file is `key={slug}`, on <AppFrame/>: each live frame's
  // own app (#2902 renders the kept ones beside the mounted one).
  const keys = FRAME.match(/\bkey=\{[^}]*\}/g) || [];
  assert.deepEqual(keys, ['key={slug}'],
    'slug is the only key — a different app is a different frame, nothing else is');
  // Mounted or kept is an ATTRIBUTE change on the same element, never a
  // different element: the id goes to the mounted frame alone, and a kept one
  // is inert and hidden from assistive tech.
  assert.match(tag, /id=\{active \? 'app-iframe' : undefined\}/, 'only the mounted frame is #app-iframe');
  assert.match(tag, /inert=\{!active\}/, 'a kept frame is inert — no focus, no clicks');
  assert.match(tag, /aria-hidden=\{active \? undefined : 'true'\}/, 'and out of the accessibility tree');
  assert.match(tag, /tabIndex=\{active \? undefined : -1\}/, 'and out of the tab order');
  assert.match(body, /const cover = active \? state\.cover : null;/, 'the cover is the mounted frame\'s alone');

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
  assert.ok(wrapper < host.indexOf('{liveFrames(state).map('),
    'and it is OUTSIDE the list that mounts the frames');
  assert.match(host, /\{liveFrames\(state\)\.map\(\(slug\) => <AppFrame key=\{slug\} slug=\{slug\} \/>\)\}/,
    'a frame exists for each live app: the mounted one and the kept ones (#2902)');
  // In CREATION order, which never changes for a frame's life: a frame is only
  // ever appended or removed, never moved — and moving an iframe reloads it.
  const order = FRAME.slice(FRAME.indexOf('function liveFrames('));
  assert.match(order.slice(0, 600), /sort\(\(a, b\) => a\.seq - b\.seq\)/,
    'frames are ordered by their creation seq, not by recency');
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
  assert.match(store, /sandboxReady: false,/, 'the pending blank frame grants no permissions');
  assert.match(store, /cover: null,/, 'and no cover');
  assert.match(POLICY, /PENDING_FRAME_SANDBOX = ''/, 'the pending sandbox is fully restricted');
  assert.match(POLICY,
    /APP_FRAME_SANDBOX =[\s\S]*allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock/,
    'the navigated app keeps the established capability contract');
  assert.match(FRAME,
    /sandbox=\{look\.sandboxReady \? APP_FRAME_SANDBOX : PENDING_FRAME_SANDBOX\}/,
    'React owns the two-phase sandbox attribute');
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
    // QA 2026-09-24 Q20: the plain render names the frame after the app.
    "frame.mount({ slug: appData.slug, faded: false, title: appData.name || '' })", // plain render
    // Imperative navigation, stamped with the build it loads (WP2).
    'frame.setSrc(iframeSrc, { granted: AppView._grantedNow(), build: AppView.buildFor(appData.slug) })',
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
  // Closing the app RETIRES it (#2902) — kept loaded, hidden — from the
  // zoom-out's `after` callback, so the shrinking card keeps showing the app
  // until it lands.
  const appJs = read('public/js/app.js');
  assert.ok(appJs.includes('AppView._retireAppFrame();'),
    'closeApp retires the frame when the app is actually left');
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

// ── 3. KEPT ALIVE (#2902) ────────────────────────────────────────────────
//
// The last few apps opened stay loaded in hidden frames, so Resume shows an
// app exactly as it was left. Everything above still holds for the MOUNTED
// frame; these cases prove the kept ones are the same elements and the same
// documents when they come back, and that the list is least-recently-used.

function openApp(h, slug, { innerPath = null, sha = null } = {}) {
  h.AppView.appData = {
    slug, name: slug, url: `https://${slug}.example`, status: 'running', self_hosted: false,
    // The commit the app is on, as the detail payload carries it (WP2).
    ...(sha ? { main_sha: sha } : {}),
  };
  h.AppView.iframeToken = `tok-${slug}-${h.bridge.stats().navigations}`;
  h.AppView.iframeTokenSlug = slug;
  h.AppView.pendingInnerPath = innerPath;
  h.AppView.renderAppTab();
  return h.bridge.frame();
}

test('#2902: resuming a kept app is the SAME element and the SAME document, as it was left', async () => {
  const h = await makeHarness();
  const a = openApp(h, 'app-a');
  const win = a.contentWindow;
  const loads = a.loads;
  win.typed = 'half a sentence';
  const b = openApp(h, 'app-b');
  const c = openApp(h, 'app-c');
  assert.notEqual(b, a);
  assert.notEqual(c, b);
  assert.deepEqual(h.bridge.liveSlugs(), ['app-c', 'app-b', 'app-a'],
    'three apps loaded: the mounted one, then the kept ones, most recent first');
  assert.equal(a.kept, true, 'app-a is kept, not dropped');
  assert.equal(a.id, '', 'and is no longer #app-iframe — the shell believes no message from it');
  assert.deepEqual(win.posted.at(-1), { __usernode_visibility: 'hidden' },
    'a kept document is told it is hidden, so the bridge pauses its media');

  const creates = h.renderer.creates;
  const navigations = h.navigations();
  const back = openApp(h, 'app-a');
  assert.equal(back, a, 'the very element');
  assert.equal(back.contentWindow, win, 'the very document');
  assert.equal(back.contentWindow.typed, 'half a sentence', 'with what the user left in it');
  assert.equal(back.loads, loads, 'no reload');
  assert.equal(h.navigations(), navigations, 'no navigation at all');
  assert.equal(h.renderer.creates, creates, 'no element created');
  assert.equal(back.id, 'app-iframe', 'it is the mounted frame again');
  assert.equal(h.store.get().cover, null, 'with no launch cover over it');
  assert.deepEqual(win.posted.at(-1), { __usernode_visibility: 'visible' });
  assert.equal(h.surface(), 'app');
});

test('#2902: the keep-alive list is least-recently-used, three apps deep', async () => {
  const h = await makeHarness();
  openApp(h, 'app-a');
  openApp(h, 'app-b');
  openApp(h, 'app-c');
  openApp(h, 'app-a'); // resumed: now the most recent
  openApp(h, 'app-d');
  assert.deepEqual(h.bridge.liveSlugs(), ['app-d', 'app-a', 'app-c'],
    'opening a fourth lets the least recently used (app-b) go, not the resumed app-a');
  assert.ok(h.renderer.history.includes('unmount:app-b'), 'app-b\'s frame is gone');

  // Opening one more than the limit, with no resume in between, drops the oldest.
  const g = await makeHarness();
  const a = openApp(g, 'app-a');
  openApp(g, 'app-b');
  openApp(g, 'app-c');
  openApp(g, 'app-d');
  assert.deepEqual(g.bridge.liveSlugs(), ['app-d', 'app-c', 'app-b']);
  assert.equal(a.isConnected, false, 'app-a was evicted');
  const again = openApp(g, 'app-a');
  assert.notEqual(again, a, 'and reopening it is a fresh frame');
  assert.equal(again.loads, 1, 'that loads');
});

test('#2902: backing out to Home keeps the app loaded; reopening it resumes', async () => {
  const h = await makeHarness();
  const a = openApp(h, 'app-a');
  const win = a.contentWindow;
  h.AppView._retireAppFrame();
  assert.equal(h.bridge.slug(), '', 'nothing is mounted');
  assert.equal(h.renderer.hostHidden, true);
  assert.deepEqual(h.bridge.liveSlugs(), ['app-a'], 'but app-a is still loaded');
  assert.equal(a.isConnected, true);
  // The eager launch from its tile resumes it instead of covering and reloading.
  h.sandbox.Home._apps = [{ slug: 'app-a', name: 'A', url: 'https://app-a.example', status: 'running' }];
  const navigations = h.navigations();
  assert.equal(h.AppView.beginLaunch('app-a'), true);
  assert.equal(h.bridge.frame(), a);
  assert.equal(a.contentWindow, win);
  assert.equal(h.navigations(), navigations, 'no navigation');
  assert.equal(h.store.get().cover, null, 'no cover');
  // …and the render that follows adopts it, even though the src it would build
  // carries a newer token than the one the document booted with.
  h.AppView.iframeToken = 'a-newer-token';
  h.AppView.iframeTokenSlug = 'app-a';
  h.AppView.renderAppTab();
  assert.equal(h.bridge.frame(), a);
  assert.equal(h.navigations(), navigations, 'still no navigation');
});

test('#2902: a stale kept document, or a deep link into it, reloads rather than resumes', async () => {
  const h = await makeHarness();
  const a = openApp(h, 'app-a');
  openApp(h, 'app-b');
  // Older than the token refresh period: its token is due a refresh, and a
  // refresh is a reload anyway.
  h.store.set((s) => ({
    ...s,
    kept: s.kept.map((k) => ({ ...k, navigatedAt: Date.now() - h.AppView.TOKEN_REFRESH_MS - 1 })),
  }));
  const loads = a.loads;
  const back = openApp(h, 'app-a');
  assert.equal(back, a, 'the element is reused');
  assert.equal(back.loads, loads + 1, 'but its document is reloaded');

  // A deep link into a kept app is somewhere to go: it navigates.
  openApp(h, 'app-b');
  const deep = openApp(h, 'app-a', { innerPath: '/thread/7' });
  assert.equal(deep, a);
  assert.equal(deep.loads, loads + 2, 'the deep link navigates the kept frame');
});

test('#2902: a new build, a placeholder and a sign-out each let frames go', async () => {
  const h = await makeHarness();
  openApp(h, 'app-a');
  const b = openApp(h, 'app-b');
  // A build landed for kept app-a: its hidden document is the old build.
  assert.equal(h.AppView.evictKeptApp('app-a'), true);
  assert.deepEqual(h.bridge.liveSlugs(), ['app-b']);
  // The app on screen is not evicted from under the viewer, nor reloaded…
  const loads = b.loads;
  assert.equal(h.AppView.evictKeptApp('app-b'), false);
  assert.deepEqual(h.bridge.liveSlugs(), ['app-b']);
  assert.equal(h.bridge.frame(), b);
  assert.equal(b.loads, loads);
  // …but it is the old build now, so leaving it lets it go (WP2, below).
  openApp(h, 'app-c');
  assert.deepEqual(h.bridge.liveSlugs(), ['app-c'], 'app-b was not kept');

  // A placeholder drops the mounted frame but not the kept ones.
  openApp(h, 'app-d');
  h.AppView._unmountAppFrame();
  assert.deepEqual(h.bridge.liveSlugs(), ['app-c']);

  // Sign-out drops everything.
  openApp(h, 'app-e');
  h.AppView.evictAllAppFrames();
  assert.deepEqual(h.bridge.liveSlugs(), []);
  assert.equal(h.bridge.frame(), null);
});

// ── 4. A NEW BUILD LANDS (WP2, issue #1) ─────────────────────────────────
//
// A kept frame is a whole document of the build that was live when it loaded.
// When a new build lands, every way back into the app has to load the new
// one, or the person who just approved a change opens their app and finds
// the old version, until they force-quit Homeroom. The redeploy broadcasts
// are driven through the REAL handlers in app.js, lifted into this harness,
// so what is asserted is what a socket event actually does to the frames.

/** App.handleAppRedeployStatus and App.handleAppVersionChanged, run for real. */
function withBuildHandlers(h, { currentApp } = {}) {
  const APP_JS = read('public/js/app.js');
  const methods = ['handleAppRedeployStatus', 'handleAppVersionChanged'].map((name) => {
    const start = APP_JS.indexOf(`  ${name}(data) {`);
    assert.ok(start > 0, `app.js has ${name}`);
    return APP_JS.slice(start, APP_JS.indexOf('\n  },\n', start) + 4);
  });
  const offers = [];
  h.sandbox.App.currentApp = currentApp;
  h.sandbox.App._isScreenVisible = () => false;
  h.sandbox.Improve = { update: (patch) => offers.push(JSON.parse(JSON.stringify(patch))) };
  vm.runInContext(`Object.assign(App, {\n${methods.join(',\n')}\n});`, h.sandbox);
  const App = h.sandbox.App;
  return {
    offers,
    landed: (slug, sha) => {
      App.handleAppRedeployStatus({ appSlug: slug, deploying: false, toSha: sha });
      App.handleAppVersionChanged({ appSlug: slug, sha });
    },
  };
}

test('WP2: a build that lands while the app is parked behind its Workshop loads on Open app', async () => {
  const h = await makeHarness();
  const { landed, offers } = withBuildHandlers(h, { currentApp: 'app-a' });
  const a = openApp(h, 'app-a');
  const win = a.contentWindow;
  // App → its Workshop: the frame is parked, the router still has the app
  // open. This is where "✓ Deployed" is watched.
  h.AppView._parkAppFrame();
  landed('app-a', 'sha-new');
  assert.deepEqual(h.bridge.liveSlugs(), [], 'the parked old build is let go');
  assert.deepEqual(offers, [{ deploying: false, appUpdateReady: false }],
    'and nothing is offered to reload: the next open loads the new build anyway');
  // Open app is switchTab('app'), which renders the App tab.
  const navigations = h.navigations();
  h.AppView.renderAppTab();
  const fresh = h.bridge.frame();
  assert.equal(h.navigations(), navigations + 1, 'Open app loads the app');
  assert.notEqual(fresh.contentWindow, win, 'a new document, not the old build');
  assert.equal(h.store.get().build, 'sha-new', 'stamped with the build it loaded');
});

test('WP2: the same, with the frame kept from an earlier visit and the Workshop opened from Home', async () => {
  const h = await makeHarness();
  const { landed } = withBuildHandlers(h);
  const a = openApp(h, 'app-a');
  h.AppView._retireAppFrame();
  assert.deepEqual(h.bridge.liveSlugs(), ['app-a'], 'kept, hidden, from the last visit');
  // The Workshop, opened from Home: the router's current app, and no frame
  // mounted. Before WP2 this was exactly the case the old guard skipped.
  h.sandbox.App.currentApp = 'app-a';
  landed('app-a', 'sha-new');
  assert.deepEqual(h.bridge.liveSlugs(), []);
  assert.equal(a.isConnected, false);
  const navigations = h.navigations();
  const back = openApp(h, 'app-a');
  assert.notEqual(back, a, 'a fresh frame…');
  assert.equal(back.loads, 1, '…that loads');
  assert.equal(h.navigations(), navigations + 1);
});

test('WP2: a build that lands while the app is on screen keeps it until it is closed, then opens fresh', async () => {
  const h = await makeHarness();
  const { landed, offers } = withBuildHandlers(h, { currentApp: 'app-a' });
  const a = openApp(h, 'app-a');
  const win = a.contentWindow;
  const loads = a.loads;
  win.typed = 'half a sentence';
  landed('app-a', 'sha-new');
  // D3: the viewer keeps their document, and the Improve offer stays.
  assert.equal(h.bridge.frame(), a);
  assert.equal(a.contentWindow, win, 'not reloaded from under the viewer');
  assert.equal(a.loads, loads);
  assert.deepEqual(offers, [{ deploying: false, appUpdateReady: true }],
    'the update-ready offer is made, and not withdrawn by the version event');
  // A render while it is on screen leaves it alone too: no auto-reload.
  h.AppView.renderAppTab();
  assert.equal(a.loads, loads, 'a re-render on screen is not an open');
  assert.equal(h.store.get().stale, true);

  // Closing it lets it go rather than keeping the old build…
  h.AppView._retireAppFrame();
  assert.deepEqual(h.bridge.liveSlugs(), [], 'not kept');
  assert.equal(a.isConnected, false);
  // …so the next open, from its tile, is fresh.
  h.sandbox.Home._apps = [{ slug: 'app-a', name: 'A', url: 'https://app-a.example', status: 'running' }];
  h.AppView._tokenFresh = { slug: 'app-a', token: 'tok-fresh', at: Date.now() };
  assert.equal(h.AppView.beginLaunch('app-a'), true);
  const back = h.bridge.frame();
  assert.notEqual(back, a);
  assert.equal(back.loads, 1, 'the new build loads');
  assert.equal(h.store.get().stale, false);
});

test('WP2: on screen when it landed, then to its Workshop and back, is the next open', async () => {
  const h = await makeHarness();
  const { landed } = withBuildHandlers(h, { currentApp: 'app-a' });
  const a = openApp(h, 'app-a');
  const loads = a.loads;
  landed('app-a', 'sha-new');
  // App → Workshop: parked, not left. It stays mounted.
  h.AppView._parkAppFrame();
  assert.deepEqual(h.bridge.liveSlugs(), ['app-a']);
  // Workshop → App: the same element, navigated to the new build.
  h.AppView.renderAppTab();
  assert.equal(h.bridge.frame(), a, 'the element is reused');
  assert.equal(a.loads, loads + 1, 'and loads the new build');
  assert.equal(h.store.get().stale, false, 'which is no longer stale');
  assert.equal(h.store.get().build, 'sha-new');
  // So leaving it now keeps it, like any other app.
  h.AppView._retireAppFrame();
  assert.deepEqual(h.bridge.liveSlugs(), ['app-a']);
});

test('WP2: a kept frame of another build reloads instead of resuming, even with every event missed', async () => {
  const h = await makeHarness();
  const a = openApp(h, 'app-a', { sha: 'sha-1' });
  assert.equal(h.store.get().build, 'sha-1', 'a load is stamped with its build');
  openApp(h, 'app-b');
  assert.equal(h.store.get().kept.find((k) => k.slug === 'app-a').build, 'sha-1',
    'and the stamp is kept with the frame');
  // The phone slept through the redeploy: no event let app-a go. Its record
  // now names a newer build.
  const loads = a.loads;
  const back = openApp(h, 'app-a', { sha: 'sha-2' });
  assert.equal(back, a, 'the element is reused');
  assert.equal(back.loads, loads + 1, 'but the old build is reloaded, not resumed');
  assert.equal(h.store.get().build, 'sha-2');

  // From its Home tile, the launcher's cached row is what says so.
  h.AppView._retireAppFrame();
  h.sandbox.Home._apps = [{
    slug: 'app-a', name: 'A', url: 'https://app-a.example', status: 'running',
    version: { sha: 'sha-3' },
  }];
  h.AppView._tokenFresh = { slug: 'app-a', token: 'tok-fresh', at: Date.now() };
  assert.equal(h.AppView.beginLaunch('app-a'), true);
  assert.equal(h.bridge.frame(), a);
  assert.equal(a.loads, loads + 2, 'the tile reloads it too');
  assert.equal(h.store.get().build, 'sha-3');

  // The same build resumes as before, and an UNKNOWN build on either side is
  // not a reason to throw the document away: only a known mismatch is.
  h.AppView._retireAppFrame();
  assert.equal(h.AppView.beginLaunch('app-a'), true);
  assert.equal(a.loads, loads + 2, 'same build: resumed');
  openApp(h, 'app-b');
  h.sandbox.Home._apps = [];
  assert.equal(openApp(h, 'app-a').loads, loads + 2, 'no build known now: resumed');
  const c = openApp(h, 'app-c');
  openApp(h, 'app-b');
  assert.equal(openApp(h, 'app-c', { sha: 'sha-9' }).loads, c.loads, 'no build stamped: resumed');
});

test('WP2: the version event names the build, over a list read before it was written', async () => {
  const h = await makeHarness();
  const { landed } = withBuildHandlers(h);
  // The Home list re-read on the redeploy's end event is fetched before
  // apps.main_sha is written, so it still names the old build.
  const stale = [{
    slug: 'app-a', name: 'A', url: 'https://app-a.example', status: 'running',
    version: { sha: 'sha-old' },
  }];
  h.sandbox.Home._apps = stale;
  h.AppView.appData = null;
  landed('app-a', 'sha-new');
  assert.equal(h.AppView.buildFor('app-a'), 'sha-new', 'the event wins over the list it beat');
  // A list that has moved on since is newer than the event.
  h.sandbox.Home._apps = [{ ...stale[0], version: { sha: 'sha-newer' } }];
  assert.equal(h.AppView.buildFor('app-a'), 'sha-newer');
  // A frame opened in between is stamped with the build that is live, so it
  // resumes once the list catches up.
  h.sandbox.Home._apps = stale;
  h.AppView._tokenFresh = { slug: 'app-a', token: 'tok-fresh', at: Date.now() };
  assert.equal(h.AppView.beginLaunch('app-a'), true);
  const a = h.bridge.frame();
  assert.equal(h.store.get().build, 'sha-new');
  h.AppView._retireAppFrame();
  h.sandbox.Home._apps = [{ ...stale[0], version: { sha: 'sha-new' } }];
  const loads = a.loads;
  assert.equal(h.AppView.beginLaunch('app-a'), true);
  assert.equal(h.bridge.frame(), a);
  assert.equal(a.loads, loads, 'resumed: it is the build that is live');
  // Sign-out forgets what it was told.
  h.AppView.evictAllAppFrames();
  h.AppView.appData = null;
  h.sandbox.Home._apps = stale;
  assert.equal(h.AppView.buildFor('app-a'), 'sha-old');
});

test('#2902: a small device keeps one app fewer', async () => {
  const { KEEP_ALIVE_LIMIT, keepAliveLimit, liveAppSlugs } = await import(
    new URL('../frontend/src/features/app-frame/app-frame-store.js', `file://${__filename}`).href
  );
  assert.equal(KEEP_ALIVE_LIMIT, 3);
  assert.equal(keepAliveLimit({}), 3, 'no report: the full three');
  assert.equal(keepAliveLimit({ deviceMemory: 8 }), 3);
  assert.equal(keepAliveLimit({ deviceMemory: 2 }), 2, 'a 2 GiB phone keeps two');
  assert.deepEqual(
    liveAppSlugs({ slug: 'x', kept: [{ slug: 'y' }, { slug: 'z' }] }),
    ['x', 'y', 'z'],
  );
  assert.deepEqual(liveAppSlugs({ slug: '', kept: [{ slug: 'y' }] }), ['y']);
});

test('#2902: the green dot reads the frame store, on Home tiles and Recents rows', () => {
  const live = read('frontend/src/features/app-frame/live-apps.tsx');
  assert.match(live, /liveAppSlugs\(useStoreState\(appFrameStore\)\)/,
    'the dot is derived from the frames actually loaded');
  const grid = read('frontend/src/features/home/app-grid.tsx');
  assert.match(grid, /live=\{live\.includes\(item\.app\.slug\)\}/);
  assert.match(grid, /\{live \? <LiveAppDot className="app-card-live-dot" \/> : null\}/);
  const recents = read('frontend/src/features/nav/recents-list.tsx');
  assert.match(recents, /live=\{!!item\.app && live\.includes\(item\.app\.slug\)\}/);
  assert.match(recents, /\{live \? <LiveAppDot className="platform-recent-live" \/> : null\}/);
  const css = read('public/css/app.css');
  assert.match(css, /\.app-launch-host > iframe\[data-kept\] \{[\s\S]{0,200}visibility: hidden;/,
    'a kept frame keeps its box and is hidden by visibility, not display');
});

test('#2902: the shared bridge pauses a hidden app\'s media and resumes what it paused', () => {
  const bridge = read('public/usernode-bridge/v1/bridge.js');
  const block = bridge.slice(bridge.indexOf('__USERNODE_VISIBILITY_BEGIN__'),
    bridge.indexOf('__USERNODE_VISIBILITY_END__'));
  assert.ok(block.length > 0, 'the visibility block is in the bridge');
  assert.match(block, /if \(e\.source !== window\.parent\) return;/, 'only the shell may say so');
  assert.match(block, /querySelectorAll\("audio, video"\)/);
  assert.match(block, /usernode:visibility-changed/);
  assert.equal(read('public/usernode-bridge.js'), bridge, 'both bridge copies agree');
});
