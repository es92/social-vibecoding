'use strict';

// The Workshop tab comes back to the app Workshop you left (#2776).
//
// The tab is a stack, like every tab in an iOS tab bar: the selector at its
// root, one app's Workshop (its board, a card) above it. Leaving for Messages
// and tapping Workshop again used to drop the stack and land on the selector.
// These tests drive the REAL router in a vm, the way tests/nav-parked-app.test.js
// does, and pin:
//
//   1. COMING BACK RETURNS TO THE VIEW — the exact route, a card included.
//   2. TAPPING THE TAB INSIDE AN APP'S WORKSHOP POPS TO THE SELECTOR, and the
//      selector is then what the tab returns to.
//   3. ONLY WORKSHOP ROUTES ARE REMEMBERED: not the running app (the parked
//      strip's), not the discussion or a change (Messages threads).
//   4. A GONE APP OR CARD FALLS BACK TO THE SELECTOR QUIETLY.
//   5. PERSISTED LIKE THE PARKED APP, and forgotten by the same sweep.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const APP_JS = read('public/js/app.js');

const WHITEBOARD = { slug: 'whiteboard-ab12cd', name: 'Whiteboard', icon_emoji: '🎨', icon_url: null };
const NOTES = { slug: 'notes-ab12', name: 'Notes', icon_emoji: null, icon_url: null };
const CARD = { kind: 'proposal', id: 7 };
const KEY = 'usernode_workshop_view_v1';

function fakeElement() {
  const classes = new Set();
  const attrs = new Map();
  return {
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (n, force) => {
        const on = force === undefined ? !classes.has(n) : !!force;
        if (on) classes.add(n); else classes.delete(n);
        return on;
      },
      contains: (n) => classes.has(n),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    style: {},
    innerHTML: '',
    textContent: '',
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    addEventListener() {},
  };
}

// public/js/app.js in a vm. History moves the address, so the router reads
// back what it wrote; storage is a Map so persistence can be inspected.
// PlatformUI.transition runs the reveal and `after` synchronously.
function router({ catalog = [WHITEBOARD, NOTES], appsLoaded = true, storage = new Map(), phone = false } = {}) {
  const errors = [];
  const noop = () => undefined;
  const elements = new Map();
  const context = vm.createContext({
    PlatformI18n: require('./lib/platform-i18n').englishPlatformI18n(),
    URL, URLSearchParams, setTimeout, clearTimeout,
    console: { ...console, error: (...a) => errors.push(a) },
    document: {
      title: '',
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      dispatchEvent() {},
    },
    addEventListener() {},
    // A desktop unless `phone` (no matchMedia reads as the desktop).
    ...(phone ? { matchMedia: () => ({ matches: false, addEventListener() {} }) } : {}),
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    PlatformUI: {
      transition(fn, opts) {
        fn();
        opts?.after?.();
      },
    },
  });
  context.location = new URL('https://homeroom.test/');
  const move = (url) => { context.location = new URL(url, context.location.href); };
  context.history = { pushState: (_s, _t, url) => move(url), replaceState: (_s, _t, url) => move(url), state: null };
  context.window = context;
  vm.runInContext(APP_JS, context);
  context.UsernodeReact = {
    nav: { setScreen() {}, setViewer() {}, park() {} },
    backButton: { set() {} },
  };
  const appView = {
    appData: null,
    close() { this.appData = null; },
    launchRecordFor: (slug) => catalog.find((r) => r.slug === slug) || null,
    open(slug) {
      const rec = catalog.find((r) => r.slug === slug) || null;
      this.appData = rec ? { ...rec } : null;
      return Promise.resolve(!!rec);
    },
  };
  context.AppView = new Proxy(appView, { get: (t, k) => (k in t ? t[k] : noop) });
  context.Home = new Proxy({ _apps: catalog, _appsLoaded: appsLoaded }, {
    get: (t, k) => (k in t ? t[k] : noop),
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { App: context.App, context, storage, errors, settle };
}

// Into an app's Workshop from the selector, and onto a card.
async function onCard(r) {
  r.App.navigateToWorkshop();
  await r.App.navigateToApp(WHITEBOARD.slug, 'dev', null, null);
  await r.App.switchTab('dev', CARD, 'topic');
  assert.equal(r.context.location.pathname, '/app/whiteboard-ab12cd/dev/proposals/7');
}

test('coming back to the Workshop tab returns to the card you left', async () => {
  const r = await router();
  await onCard(r);
  r.App.navigateToMessages();
  assert.equal(r.App.currentApp, null, 'you left the app for Messages');
  assert.equal(r.App.resumeWorkshopView(), true, 'the tab takes over its own navigation');
  await r.settle();
  assert.equal(r.App.currentApp, WHITEBOARD.slug);
  assert.equal(r.App.currentTab, 'dev');
  assert.equal(r.App.currentSubTab, 'topic', 'the card, not the app\'s board');
  assert.equal(r.context.location.pathname, '/app/whiteboard-ab12cd/dev/proposals/7');
  assert.deepEqual(r.errors, []);
});

test('the board you left comes back too, and from any tab', async () => {
  for (const leave of ['navigateHome', 'navigateToBrowse', 'navigateToMessages', 'navigateToProfile']) {
    const r = router();
    r.App.navigateToWorkshop();
    await r.App.navigateToApp(NOTES.slug, 'dev', null, null);
    r.App[leave]();
    assert.equal(r.App.resumeWorkshopView(), true, `${leave}: back to the app's Workshop`);
    await r.settle();
    assert.equal(r.App.currentApp, NOTES.slug, `${leave}: in Notes`);
    assert.match(r.context.location.pathname, /^\/app\/notes-ab12\/(workshop|board)$/);
  }
});

test('tapping the tab inside an app\'s Workshop pops to the selector, which it then remembers', async () => {
  const r = router();
  await onCard(r);
  assert.equal(r.App.resumeWorkshopView(), false,
    'the tab\'s own #workshop navigation goes ahead: pop to root');
  r.App.navigateToWorkshop();
  assert.equal(r.App.currentApp, null);
  assert.equal(r.storage.has(KEY), false, 'the selector is now the view you left');
  r.App.navigateToMessages();
  assert.equal(r.App.resumeWorkshopView(), false, 'so coming back lands on the selector');
});

test('on the selector the tab stays put', async () => {
  const r = router();
  r.App.navigateToWorkshop();
  assert.equal(r.App.resumeWorkshopView(), false);
});

test('the running app and a change are not Workshop views; the discussion is its project page', async () => {
  // On a phone, where the running app covers the bar. (On a desktop the rail
  // stays beside it and the tab follows it: the next test.)
  const r = router({ phone: true });
  await r.App.navigateToApp(WHITEBOARD.slug, 'app');
  assert.equal(r.storage.has(KEY), false, 'the running app is the parked strip\'s');
  await r.App.switchTab('dev', 42, 'sessions');
  assert.equal(r.storage.has(KEY), false, 'a change is a Messages thread');
  // #3653: the app's discussion is its project page's Discussion tab, so
  // asking for it is the project page, which the Workshop tab reopens.
  await r.App.switchTab('dev', null, 'chat');
  assert.deepEqual(JSON.parse(r.storage.get(KEY)),
    { slug: WHITEBOARD.slug, path: '/app/whiteboard-ab12cd/workshop' });
});

test('on a desktop the tab follows the running app beside the rail, to its Workshop', async () => {
  // The Communities tab is on screen next to the app there, so it names the
  // app's community and a press goes to that app's Workshop.
  const r = router();
  await onCard(r);
  await r.App.navigateToApp(NOTES.slug, 'app');
  assert.deepEqual(JSON.parse(r.storage.get(KEY)),
    { slug: NOTES.slug, path: `/app/${NOTES.slug}/workshop` });
  // Back in an app whose card you were reading, that card is kept.
  await onCard(r);
  await r.App.navigateToApp(WHITEBOARD.slug, 'app');
  assert.deepEqual(JSON.parse(r.storage.get(KEY)),
    { slug: WHITEBOARD.slug, path: '/app/whiteboard-ab12cd/dev/proposals/7' });
});

test('the view is persisted, so it survives a reload', async () => {
  const storage = new Map();
  const first = router({ storage });
  await onCard(first);
  assert.deepEqual(JSON.parse(storage.get(KEY)),
    { slug: WHITEBOARD.slug, path: '/app/whiteboard-ab12cd/dev/proposals/7' });
  const again = router({ storage });
  again.App.navigateHome();
  assert.equal(again.App.resumeWorkshopView(), true);
  await again.settle();
  assert.equal(again.App.currentSubTab, 'topic');
});

test('an app that is gone falls back to the selector, quietly', async () => {
  const storage = new Map([[KEY, JSON.stringify({ slug: 'deleted-app', path: '/app/deleted-app/workshop' })]]);
  const r = router({ storage });
  r.App.navigateHome();
  assert.equal(r.App.resumeWorkshopView(), false, 'the tab goes to #workshop as it always did');
  assert.equal(storage.has(KEY), false, 'and the view is forgotten');
  assert.equal(r.App.currentApp, null, 'no request for the app was made');
  assert.deepEqual(r.errors, []);
});

test('a card that is gone falls back to the selector, quietly', async () => {
  const r = router();
  await onCard(r);
  r.App.navigateToMessages();
  r.App.resumeWorkshopView();
  await r.settle();
  // What the topic view does when the card does not resolve.
  assert.equal(r.App._abandonWorkshopResume(), true);
  assert.equal(r.App.currentApp, null);
  assert.equal(r.App._inWorkshop, true, 'on the selector');
  assert.equal(r.context.location.hash, '#communities');
  assert.equal(r.storage.has(KEY), false);
  assert.deepEqual(r.errors, []);
  const view = read('public/js/app-view.js');
  const miss = view.slice(view.indexOf('if (!ok || !AppView._findTopicItem()) {'));
  assert.match(miss.slice(0, miss.indexOf('App.switchTab(\'dev\');')),
    /if \(App\._abandonWorkshopResume\?\.\(\)\) return;\s*if \(ref\.kind === 'gov'/,
    'before the governance toast, so the fallback says nothing');
});

test('a card missing on an ordinary visit still falls back to the board', async () => {
  const r = router();
  await onCard(r);
  assert.equal(r.App._abandonWorkshopResume(), false, 'only a resume is diverted');
});

test('the session sweep forgets the Workshop view', async () => {
  const r = router();
  await onCard(r);
  assert.equal(r.storage.has(KEY), true);
  r.App._dropCachedSession();
  assert.equal(r.storage.has(KEY), false, 'the next account is not taken into this one\'s app');
});

test('the Workshop tab asks the router before its href runs', () => {
  const TAB = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(TAB, /key === 'workshop' \? onWorkshopClick/);
  const fn = TAB.slice(TAB.indexOf('function onWorkshopClick('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /isNativeClick\?\.\(event\)\) return;/, 'a modified click is left alone');
  assert.match(body, /if \(app\?\.resumeWorkshopView\?\.\(\)\) event\.preventDefault\(\);/,
    'and the href runs unless the router took over');
});
