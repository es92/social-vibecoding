'use strict';

// The ✕ in a running app's strip returns to the page the app was opened from.
//
// The prototype draws the platform UNDER a running app, and its close button
// takes the app away to reveal that page as it was (leaveApp / renderDesktop
// in the nav prototype; spec §9). The ✕ went Home instead — or to #workshop
// when that screen was the origin — so an app opened from a message thread
// through Recents or the parked strip closed onto Home. It also PUSHED Home
// over the app's entry, so Back from Home reopened the app.
//
// App.closeApp TRAVERSES back to the origin's own history entry. What that
// buys, and what is pinned below by driving the REAL router in a vm over a
// model of the window's joint session history:
//
//   1. the exact page comes back — a thread, the app's Workshop card, Me —
//      through the path Back takes, so the screen is the kept-alive one;
//   2. the app's entry is left FORWARD of the page, so Back from there goes
//      where it went before the app was opened, not back into the app;
//   3. entries the app's FRAME wrote are crossed, never rewound (the
//      Navigation API lists only this document's entries);
//   4. only Home's return zooms the app back into its tile;
//   5. a cold deep link, with nowhere to return, goes Home in place;
//   6. without the Navigation API, the captured origin stands in.
//
// Run with: node --test tests/app-close-origin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const APP_JS = read('public/js/app.js');
const ORIGIN = 'https://homeroom.test';

// A window's joint session history: this document's own entries, and the ones
// a FRAMED document's navigations add — history.length counts those, the
// Navigation API does not list them, and traversing from the top crosses them.
function makeHistory(start, { navigationApi = true, onTopTraversal, previousDocument = false }) {
  const location = new URL(start, ORIGIN);
  const joint = [];
  if (previousDocument) joint.push({ url: `${ORIGIN}/#messages/1`, key: 'old', frame: false, oldDoc: true });
  joint.push({ url: location.href, key: 'e0', frame: false });
  let at = joint.length - 1;
  let keys = 1;
  const topAt = (i) => { for (let j = i; j >= 0; j -= 1) if (!joint[j].frame) return j; return 0; };
  const moveTo = (i) => {
    const from = topAt(at);
    at = i;
    const to = topAt(at);
    location.href = joint[to].url;
    if (to !== from) onTopTraversal();
  };
  const history = {
    state: null,
    get length() { return joint.length; },
    pushState(_s, _t, url) {
      joint.splice(at + 1);
      joint.push({ url: new URL(url, location.href).href, key: `e${keys++}`, frame: false });
      at = joint.length - 1;
      location.href = joint[at].url;
    },
    replaceState(_s, _t, url) {
      const i = topAt(at);
      joint[i] = { ...joint[i], url: new URL(url, location.href).href };
      location.href = joint[i].url;
    },
    back() { history.go(-1); },
    go(n) { const i = at + n; if (i >= 0 && i < joint.length) moveTo(i); },
  };
  const tops = () => joint.map((e, i) => ({ e, i })).filter((x) => !x.e.frame);
  const navigation = navigationApi ? {
    entries() {
      return tops().map((x, index) => ({
        key: x.e.key, url: x.e.url, index, sameDocument: !x.e.oldDoc,
      }));
    },
    get currentEntry() {
      const me = topAt(at);
      return this.entries()[tops().findIndex((x) => x.i === me)];
    },
    traverseTo(key) {
      const i = joint.findIndex((e) => e.key === key && !e.frame);
      if (i < 0) {
        const no = Promise.reject(new Error('InvalidStateError'));
        return { committed: no, finished: no };
      }
      moveTo(i);
      return { committed: Promise.resolve(), finished: Promise.resolve() };
    },
  } : undefined;
  return {
    location, history, navigation, joint,
    get at() { return at; },
    // The app's frame navigating inside the window's history.
    frameNavigates() {
      joint.splice(at + 1);
      joint.push({ url: joint[topAt(at)].url, key: `f${keys++}`, frame: true });
      at = joint.length - 1;
    },
    route: () => `${location.pathname}${location.search}${location.hash}`,
    top: () => joint[topAt(at)],
  };
}

function fakeElement() {
  const classes = new Set();
  const attrs = new Map();
  const listeners = new Map();
  return {
    classList: {
      add: (...n) => n.forEach((c) => classes.add(c)),
      remove: (...n) => n.forEach((c) => classes.delete(c)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    listeners,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    style: {}, innerHTML: '', textContent: '',
    querySelector: () => null, querySelectorAll: () => [],
    appendChild() {},
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
}

const APPS = [
  { slug: 'garden-ab12', name: 'Garden' },
  { slug: 'recipes-cd34', name: 'Recipes' },
];

function router(start, opts = {}) {
  const elements = new Map();
  const transitions = [];
  const parks = [];
  const slots = [];
  const presence = [];
  let App = null;
  const h = makeHistory(start, { ...opts, onTopTraversal: () => App._routeFromHash() });
  const noop = () => undefined;
  const context = vm.createContext({
    PlatformI18n: require('./lib/platform-i18n').englishPlatformI18n(),
    location: h.location, history: h.history, URL, URLSearchParams, console, setTimeout, clearTimeout,
    document: {
      title: '',
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, dispatchEvent() {},
    },
    addEventListener() {},
    // "Keep sidebar open in apps" OFF: on a desktop the rail otherwise stays
    // beside a running app and its corner is the sidebar toggle, not the ✕
    // (tests/nav-rail-pinned.test.js). This is the ✕ a phone always has.
    localStorage: {
      getItem: (k) => (k === 'usernode:rail-pinned' ? '0' : null), setItem() {}, removeItem() {},
    },
    PlatformUI: new Proxy({
      transition(fn, o) {
        transitions.push(o?.type || 'none');
        fn();
        o?.after?.();
      },
    }, { get: (t, k) => (k in t ? t[k] : noop) }),
  });
  if (opts.navigationApi !== false) context.navigation = h.navigation;
  context.window = context;
  vm.runInContext(APP_JS, context);
  App = context.App;
  context.UsernodeReact = {
    nav: { setScreen() {}, setViewer() {}, park: (app) => parks.push(app) },
    backButton: { set: (mode, href) => slots.push([mode, href]) },
    sidePanel: { appPresence: (on) => presence.push(on) },
    messages: { route() {}, isOpen: () => true, close() {}, syncChrome() {} },
  };
  const appView = {
    appData: null,
    close() { this.appData = null; },
    launchRecordFor: (slug) => APPS.find((r) => r.slug === slug) || null,
    open(slug) {
      const rec = APPS.find((r) => r.slug === slug) || null;
      this.appData = rec ? { ...rec } : null;
      return Promise.resolve(!!rec);
    },
    renderDevView: () => Promise.resolve(),
  };
  context.AppView = new Proxy(appView, { get: (t, k) => (k in t ? t[k] : noop) });
  context.Home = new Proxy({}, { get: () => noop });
  App.bindEvents();
  const back = context.document.getElementById('back-btn');
  return {
    App, h, transitions, parks, slots, presence,
    // A plain click on the header's back slot, as the anchor's own handler sees it.
    clickClose() {
      back.setAttribute('href', slots.length ? slots[slots.length - 1][1] : '/');
      back.listeners.get('click')({ currentTarget: back, preventDefault() {} });
    },
    lastSlot: () => slots[slots.length - 1],
    settle: () => new Promise((r) => setTimeout(r, 0)),
    // A link or a tab: the address moves, then the router follows it.
    go(address) {
      h.history.pushState(null, '', address);
      App._routeFromHash();
    },
  };
}

async function boot(r) {
  r.App.restoreFromHash();
  await r.settle();
}

test('the ✕ returns to the thread the app was opened from, and leaves the app forward of it', async () => {
  const r = router('/');
  await boot(r);
  r.go('/#messages/4243');
  const thread = r.h.at;
  // Recents and the parked strip's Resume both open an app this way.
  await r.App.openAppTab('garden-ab12', 'app');
  assert.equal(r.h.route(), '/app/garden-ab12');
  assert.deepEqual(r.lastSlot(), ['close', '/#messages/4243'],
    'the ✕, naming the page it goes back to');
  r.transitions.length = 0;
  r.clickClose();
  assert.equal(r.h.route(), '/#messages/4243', 'back on the thread');
  assert.equal(r.App._revealedScreen, 'messages-screen');
  assert.equal(r.App.currentApp, null);
  assert.equal(r.h.at, thread, 'by TRAVERSING to the thread\'s own entry…');
  assert.equal(r.h.joint[thread + 1].url, `${ORIGIN}/app/garden-ab12`,
    '…so the app\'s entry is forward of it rather than under a new one');
  assert.deepEqual(r.transitions, ['none'], 'the ordinary way back from an app, not a zoom');
  assert.equal(r.parks.at(-1)?.name, 'Garden', 'leaving still parks it (#2791)');
  assert.equal(r.presence.at(-1), false, 'and the side panel beside it goes with it (#2854)');
  // Back from the thread goes where it went before the app was opened.
  r.h.history.back();
  assert.equal(r.h.at, thread - 1);
  assert.equal(r.h.route(), '/', 'Home, where the reader was before the thread');
  assert.equal(r.App.currentApp, null, 'not back into the app just closed');
});

test('from Home it zooms back into its tile — the one screen that has one', async () => {
  const r = router('/');
  await boot(r);
  await r.App.navigateToApp('garden-ab12');
  r.transitions.length = 0;
  r.clickClose();
  assert.equal(r.h.route(), '/');
  assert.equal(r.App._revealedScreen, 'home-screen');
  assert.deepEqual(r.transitions, ['zoom-out'], 'navigateHome shrinks the app into its tile');
});

test('an app resumed from a card in its own Workshop closes back onto that card', async () => {
  const r = router('/app/garden-ab12/dev/proposals/12');
  await boot(r);
  assert.equal(r.App.currentTab, 'dev');
  // The Workshop has no ✕ of its own (#2740 review).
  assert.equal(r.lastSlot()[0], 'none');
  // The parked strip's Resume (or a Recents row) switches the open app's tab.
  await r.App.openAppTab('garden-ab12', 'app');
  assert.equal(r.h.route(), '/app/garden-ab12');
  assert.deepEqual(r.lastSlot(), ['close', '/app/garden-ab12/dev/proposals/12']);
  r.clickClose();
  await r.settle();
  assert.equal(r.h.route(), '/app/garden-ab12/dev/proposals/12');
  assert.equal(r.App.currentTab, 'dev');
  assert.equal(r.App.currentSubTab, 'topic', 'the card, not the board');
});

test('an app opened from inside another closes to the page under both', async () => {
  const r = router('/#profile');
  await boot(r);
  await r.App.openAppTab('garden-ab12', 'app');
  await r.App.openAppTab('recipes-cd34', 'app');
  assert.deepEqual(r.lastSlot(), ['close', '/#profile']);
  r.clickClose();
  assert.equal(r.h.route(), '/#profile');
  assert.equal(r.App._revealedScreen, 'profile-screen');
});

test('what the app\'s frame wrote into history is crossed, not rewound', async () => {
  const r = router('/#profile');
  await boot(r);
  const list = r.h.at;
  await r.App.openAppTab('garden-ab12', 'app');
  r.h.frameNavigates();
  r.h.frameNavigates();
  assert.equal(r.h.history.length, list + 4, 'history counts the frame\'s entries…');
  r.clickClose();
  assert.equal(r.h.route(), '/#profile', '…and the ✕ still lands on the page, where history.back() would have rewound the frame');
  assert.equal(r.h.at, list);
  assert.equal(r.App.currentApp, null);
});

test('a cold deep link has nowhere to return: Home, in place of the app\'s entry', async () => {
  const r = router('/app/garden-ab12');
  await boot(r);
  assert.equal(r.App.currentTab, 'app');
  assert.deepEqual(r.lastSlot(), ['close', '/'], 'the ✕ names Home');
  r.clickClose();
  assert.equal(r.h.route(), '/');
  assert.equal(r.App._revealedScreen, 'home-screen');
  assert.equal(r.h.history.length, 1, 'REPLACED: Back does not bounce into the app');
});

test('an entry from a previous load is a full navigation away, not the page underneath', async () => {
  const r = router('/app/garden-ab12', { previousDocument: true });
  await boot(r);
  assert.deepEqual(r.lastSlot(), ['close', '/']);
  r.clickClose();
  assert.equal(r.h.route(), '/');
});

// ── Without the Navigation API ───────────────────────────────────────────

test('without the Navigation API, going back when nothing has been added since', async () => {
  const r = router('/#messages/4243', { navigationApi: false });
  await boot(r);
  const thread = r.h.at;
  await r.App.openAppTab('garden-ab12', 'app');
  assert.deepEqual(r.lastSlot(), ['close', '/#messages/4243'], 'the captured origin names it');
  r.clickClose();
  assert.equal(r.h.route(), '/#messages/4243');
  assert.equal(r.h.at, thread, 'history.back(): the app\'s entry is forward of the thread');
  assert.equal(r.App._revealedScreen, 'messages-screen');
});

test('without the Navigation API, and the frame has written history: straight to the origin', async () => {
  const r = router('/#messages/4243', { navigationApi: false });
  await boot(r);
  await r.App.openAppTab('garden-ab12', 'app');
  r.h.frameNavigates();
  r.clickClose();
  // Back could only rewind the frame here; the origin is known, so go there.
  assert.equal(r.h.route(), '/#messages/4243');
  assert.equal(r.App._revealedScreen, 'messages-screen');
  assert.equal(r.App.currentApp, null);
});

test('without the Navigation API, a cold deep link still goes Home in place', async () => {
  const r = router('/app/garden-ab12', { navigationApi: false });
  await boot(r);
  r.clickClose();
  assert.equal(r.h.route(), '/');
  assert.equal(r.h.history.length, 1);
});

test('the origin is noted before the app\'s entry is written, and never from a restore', async () => {
  const r = router('/#messages/4243', { navigationApi: false });
  await boot(r);
  await r.App.openAppTab('garden-ab12', 'app');
  assert.equal(r.App._appReturn.url, '/#messages/4243');
  assert.equal(r.App._appReturn.depth, r.h.history.length, 'pinned once the push has landed');
  // Leaving by any other route forgets it with the visit.
  r.go('/#workshop');
  assert.equal(r.App._appReturn, null);
  // Back into the app is the ROUTER restoring an address: nothing of ours
  // to name, so nothing is noted.
  r.h.history.back();
  assert.equal(r.App.currentApp, 'garden-ab12');
  assert.equal(r.App._appReturn, null);
});
