'use strict';

// A press on the desktop rail is a TAB SWITCH, and it swaps the page in place
// (#2797). And the platform's own row opens on a plain Workshop panel, with no
// ✕ to step out of an app it is not (#2799).
//
// #2797, measured frame by frame on the built shell (1280x900): Discover,
// Home, Workshop and Me each ran the kit's fade-through — a View Transition
// over the whole document, for whose length the header and the rail are
// pinned SNAPSHOT images over a substitute ground. Messages ran none: its
// hashchange re-entry called navigateToMessages a second time 14ms later,
// whose 'none' skipped the pending transition. Messages was also the one tab
// reported as never popping. After this change every rail press resolves to
// 'none', and every captured frame of the header, the rail and the wallpaper
// star behind the bell matched its settled state from the first frame on.
//
// Run with: node --test tests/rail-switch-motion.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function harness({ wide = true, railHidden = false } = {}) {
  const nodes = new Map();
  function element(id) {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set(id === 'home-screen' ? [] : ['hidden']);
    if (id === 'platform-tabs' && !railHidden) classes.delete('hidden');
    const attrs = new Map();
    const el = {
      id,
      classList: {
        add: (v) => classes.add(v),
        remove: (v) => classes.delete(v),
        contains: (v) => classes.has(v),
        toggle(v, on) { if (on) classes.add(v); else classes.delete(v); },
      },
      setAttribute: (n, v) => attrs.set(n, v),
      getAttribute: (n) => attrs.get(n),
      addEventListener() {},
    };
    nodes.set(id, el);
    return el;
  }
  const AppView = { appData: null, launchRecordFor: () => null };
  const context = vm.createContext({
    location: new URL('https://homeroom.test/'), URL, URLSearchParams, console,
    history: { pushState() {}, replaceState() {} },
    document: { title: '', getElementById: element, querySelector: () => null, addEventListener() {} },
    addEventListener() {},
    localStorage: { getItem: () => null },
    matchMedia: (q) => ({ matches: q === '(min-width: 768px)' ? wide : false }),
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
    AppView,
  });
  context.window = context;
  vm.runInContext(read('public/js/app.js'), context);
  return { App: context.App, AppView, element };
}

// ── #2797: a rail press swaps in place ───────────────────────────────────

test('a push into any of the rail\'s five places is a cut on the desktop layout', () => {
  const { App, element } = harness();
  for (const id of ['home-screen', 'browse-screen', 'messages-screen', 'workshop-screen', 'profile-screen']) {
    const screen = element(id);
    assert.equal(App._entryTransition('push', screen), 'none', `${id} is a tab switch`);
    assert.equal(screen.getAttribute('data-entered'), 'none',
      'the stamp is the RESOLVED type, so a check reads what actually ran');
  }
});

test('Home from the rail is a cut too, but backing out of an app still zooms', () => {
  const { App, element } = harness();
  const appView = element('app-view');
  // No app on screen: the kit's zoom-out has no card to shrink and would fall
  // back to a full-page transition, which is the thing a tab press must not run.
  assert.equal(App._entryTransition('zoom-out', appView), 'none');
  // An app's view on screen (its Workshop, rail up): shrinking it into its
  // tile is the way out of an app, not a tab switch.
  appView.classList.remove('hidden');
  assert.equal(App._entryTransition('zoom-out', appView), 'zoom-out');
});

test('everything that is not a rail switch keeps its motion', () => {
  const { App, element } = harness();
  // A drill-in within a tab goes somewhere; it keeps its push.
  for (const id of ['settings-screen', 'leaderboard-screen', 'global-chat-screen', 'admin-screen']) {
    assert.equal(App._entryTransition('push', element(id)), 'push', `${id} is a drill-in`);
  }
  assert.equal(App._entryTransition('zoom-in', element('app-view')), 'zoom-in', 'opening an app still zooms');
});

test('the phone keeps its slide, and so does a route with no rail on screen', () => {
  // The phone's bottom bar is being reworked separately (#2766).
  const phone = harness({ wide: false });
  assert.equal(phone.App._entryTransition('push', phone.element('browse-screen')), 'push');
  // Inside a running app the rail is down; leaving it is not a rail press.
  const inApp = harness({ railHidden: true });
  assert.equal(inApp.App._entryTransition('push', inApp.element('browse-screen')), 'push');
});

test('the rail roots agree with the tab bar\'s own map', () => {
  // TAB_FOR_SCREEN maps every screen to the tab that lights for it; the roots
  // are the screens a tab NAVIGATES to, which is the five whose tab maps to
  // themselves being the first screen listed for it.
  const { App } = harness();
  const nav = read('frontend/src/features/nav/nav-store.js');
  const body = nav.match(/TAB_FOR_SCREEN = Object\.freeze\(\{([\s\S]*?)\}\)/)[1];
  const firstForTab = new Map();
  for (const m of body.matchAll(/'([a-z-]+)': '([a-z]+)'/g)) {
    if (!firstForTab.has(m[2])) firstForTab.set(m[2], m[1]);
  }
  assert.deepEqual([...App._RAIL_ROOTS].sort(), [...firstForTab.values()].sort());
});

// ── #2799: the platform's own Workshop has no ✕ ──────────────────────────

test('the platform\'s own row shows no ✕ on its Workshop', () => {
  const { App, AppView } = harness();
  App.currentApp = 'homeroom';
  App.currentTab = 'dev';
  App.currentSubTab = 'forum';
  // Before its record loads, the launcher's cached row answers — navigateToApp
  // reveals the view (and publishes this slot) before AppView.open resolves.
  AppView.launchRecordFor = (slug) => (slug === 'homeroom' ? { slug, self_hosted: true } : null);
  assert.deepEqual([...App._backSlotFor('app-view')], ['none']);
  // …and once it has, the loaded record does.
  AppView.launchRecordFor = () => null;
  AppView.appData = { slug: 'homeroom', self_hosted: true };
  assert.deepEqual([...App._backSlotFor('app-view')], ['none']);
});

test('any other app keeps its ✕, and a thread keeps its chevron to Messages', () => {
  const { App, AppView } = harness();
  App.currentApp = 'todo';
  App.currentTab = 'dev';
  App.currentSubTab = 'forum';
  AppView.appData = { slug: 'todo', self_hosted: false };
  assert.deepEqual([...App._backSlotFor('app-view')], ['close']);
  // A stale record for a different slug must not decide it.
  AppView.appData = { slug: 'homeroom', self_hosted: true };
  assert.deepEqual([...App._backSlotFor('app-view')], ['close']);
  // The platform's own discussion is still a row of Messages.
  App.currentApp = 'homeroom';
  App.currentSubTab = 'chat';
  assert.deepEqual([...App._backSlotFor('app-view')], ['arrow', '#messages']);
});
