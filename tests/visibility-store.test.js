// The screen-visibility seam between public/js/** and React (#1078).
//
// Once a screen root is a React component, `classList.add('hidden')` from
// public/js/app.js is a write into React-owned DOM that the next render
// reconciles away. So the router publishes `(screenId, visible)` into a shared
// store instead, and the converted region renders its own `hidden` class.
//
// Two things have to hold for that to work, and neither is visible from
// either side alone:
//
//   1. The two implementations of the store — App.Visibility in app.js and
//      frontend/src/lib/visibility-store.ts — must create THE SAME object on
//      window. They are separate because of load order (classic scripts run
//      before the deferred React module, so app.js can publish first), which
//      is exactly the situation where a shape drift would go unnoticed until
//      a screen silently stopped switching.
//   2. `_showOnlyScreen` must keep its pre-seam behaviour for every id that
//      has NOT been converted, including the `keepAlso` escape hatch.
//   3. An UNPUBLISHED converted root must read as whatever its markup shipped
//      with, on both sides of the seam: `App._isScreenVisible` falls back to
//      the DOM, and the island's `useVisibilityHiddenClass(..., shippedVisible)`
//      applies the same default. #home-screen (#1083 chunk F) is the first root
//      where those differ from a flat `false`, and the first that stays
//      unpublished in a steady state.
//
// Run with: node --test tests/visibility-store.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const storeTs = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'lib', 'visibility-store.ts'), 'utf8',
);

// A minimal stand-in for the legacy half: evaluates App.Visibility and the
// two seam helpers against a fake window/document, without booting the other
// 4,500 lines of app.js.
function legacyHalf({ reactOwned = [], elements = {} } = {}) {
  const classLists = {};
  for (const [id, hidden] of Object.entries(elements)) {
    const classes = new Set(hidden ? ['hidden'] : []);
    classLists[id] = {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      _classes: classes,
    };
  }
  const win = {};
  const App = {
    SCREEN_IDS: ['app-view', 'home-screen', 'browse-screen', 'leaderboard-screen',
      'profile-screen', 'admin-screen', 'settings-screen', 'messages-screen',
      'agent-session-screen'],
    REACT_SCREEN_IDS: reactOwned,
    setBackIcon() {},
    Visibility: {
      _store() {
        let store = win.__usernodeVisibility;
        if (!store) {
          store = { visible: Object.create(null), listeners: new Set() };
          win.__usernodeVisibility = store;
        }
        return store;
      },
      publish(id, visible) {
        const store = App.Visibility._store();
        if (store.visible[id] === visible) return;
        store.visible[id] = visible;
        for (const listener of [...store.listeners]) listener();
      },
      read(id) { return App.Visibility._store().visible[id]; },
    },
    _setScreenVisible(id, visible) {
      if (App.REACT_SCREEN_IDS.includes(id)) { App.Visibility.publish(id, visible); return; }
      const el = classLists[id];
      if (el) el.toggle('hidden', !visible);
    },
    _isScreenVisible(id) {
      if (App.REACT_SCREEN_IDS.includes(id)) {
        const published = App.Visibility.read(id);
        if (published !== undefined) return published === true;
      }
      const el = classLists[id];
      return !!el && !el.contains('hidden');
    },
    _showOnlyScreen(revealId, keepAlso) {
      const keep = keepAlso || [];
      for (const id of App.SCREEN_IDS) {
        if (id === revealId || keep.includes(id)) continue;
        App._setScreenVisible(id, false);
      }
      App._setScreenVisible(revealId, true);
      App.setBackIcon('home');
    },
  };
  return {
    App,
    win,
    hidden: (id) => classLists[id].contains('hidden'),
  };
}

test('the two store factories agree on the global key and the object shape', () => {
  // Not a style nit: they are the SAME store at runtime. If app.js wrote
  // `__usernodeVisibility` and React read `__usernodeVisibilityStore`, every
  // publish would land in an object nothing renders from, and the failure
  // would look like "the screen just doesn't switch".
  assert.match(appJs, /window\.__usernodeVisibility/,
    'app.js must publish into window.__usernodeVisibility');
  assert.match(storeTs, /VISIBILITY_STORE_KEY = '__usernodeVisibility'/,
    'the React store must read the same global key app.js writes');

  for (const half of [appJs, storeTs]) {
    assert.match(half, /visible: Object\.create\(null\)/,
      'both halves must create the same null-prototype id→visible map');
    assert.match(half, /listeners: new Set\(\)/,
      'both halves must create the same listener set');
  }
});

test('the legacy half publishes for converted ids and toggles the class otherwise', () => {
  const { App, win, hidden } = legacyHalf({
    reactOwned: ['leaderboard-screen'],
    elements: { 'home-screen': false, 'browse-screen': true, 'leaderboard-screen': false },
  });

  App._setScreenVisible('home-screen', false);
  assert.equal(hidden('home-screen'), true, 'an unconverted root still gets the class');

  App._setScreenVisible('leaderboard-screen', true);
  assert.equal(win.__usernodeVisibility.visible['leaderboard-screen'], true);
  assert.equal(hidden('leaderboard-screen'), false,
    'a converted root must NOT be touched in the DOM — React renders its own class');
});

test('an unpublished id reads as undefined, not false', () => {
  // The distinction is load-bearing: a converted region falls back to the
  // visibility its prerendered markup shipped with when nothing has published
  // yet. Defaulting to `false` would hide it on the hydrating render and
  // produce a mismatch, which console.errors and fails proposal checks.
  const { App } = legacyHalf({
    reactOwned: ['settings-screen'],
    elements: { 'settings-screen': true },
  });
  assert.equal(App.Visibility.read('settings-screen'), undefined);
  // And the read-side helper answers with the markup, which for this root
  // means hidden. Same answer as before the fallback existed — see the
  // shipped-visible case below for where the two diverge.
  assert.equal(App._isScreenVisible('settings-screen'), false);
});

test('publish notifies subscribers, and only on a real change', () => {
  const { App, win } = legacyHalf({ reactOwned: ['admin-screen'] });
  let calls = 0;
  App.Visibility._store().listeners.add(() => { calls += 1; });

  App.Visibility.publish('admin-screen', true);
  assert.equal(calls, 1);
  App.Visibility.publish('admin-screen', true);
  assert.equal(calls, 1, 'republishing the same value must not re-render every subscriber');
  App.Visibility.publish('admin-screen', false);
  assert.equal(calls, 2);
  assert.equal(win.__usernodeVisibility.visible['admin-screen'], false);
});

test('_showOnlyScreen is unchanged for unconverted screens, keepAlso included', () => {
  const elements = {
    'app-view': true,
    'home-screen': true,
    'browse-screen': false,
    'leaderboard-screen': false,
    'profile-screen': false,
    'admin-screen': false,
    'settings-screen': false,
    'messages-screen': false,
    'agent-session-screen': false,
  };
  const { App, hidden } = legacyHalf({ elements });

  App._showOnlyScreen('home-screen', ['app-view']);
  assert.equal(hidden('home-screen'), false, 'the revealed root is shown');
  // keepAlso means "leave it alone", NOT "reveal it" — #app-view was hidden
  // going in and must stay that way. The zoom-out close path depends on this.
  assert.equal(hidden('app-view'), true);
  for (const id of ['browse-screen', 'leaderboard-screen', 'profile-screen',
    'admin-screen', 'settings-screen', 'messages-screen', 'agent-session-screen']) {
    assert.equal(hidden(id), true, `${id} should have been hidden`);
  }
});

test('_departingScreen-style reads see converted and unconverted roots alike', () => {
  const { App } = legacyHalf({
    reactOwned: ['settings-screen'],
    elements: { 'home-screen': false, 'settings-screen': true },
  });
  assert.equal(App._isScreenVisible('home-screen'), true);
  assert.equal(App._isScreenVisible('settings-screen'), false,
    'a converted root that ships hidden stays hidden until something publishes it');
  App.Visibility.publish('settings-screen', true);
  assert.equal(App._isScreenVisible('settings-screen'), true);
  App.Visibility.publish('settings-screen', false);
  assert.equal(App._isScreenVisible('settings-screen'), false,
    'once published, the store wins over the markup in both directions');
});

test('an unpublished converted root that SHIPS VISIBLE reads as visible', () => {
  // #home-screen, the case #1083 chunk F introduced. Every converted root
  // before it shipped hidden, so "nobody published" and "the DOM says hidden"
  // gave the same answer and the fallback was invisible. Home ships visible
  // AND reaches a steady state where nothing has published: the no-hash
  // branch of restoreFromHash is already-on-home, so it calls Home.load()
  // without a screen swap. Answering `false` there would switch off every
  // `_isScreenVisible('home-screen')` guard — the WS app-event grid
  // refreshes, build-log.js, notifications.js — on a plain "/" boot.
  const { App } = legacyHalf({
    reactOwned: ['home-screen'],
    elements: { 'home-screen': false },
  });
  assert.equal(App.Visibility.read('home-screen'), undefined,
    'the precondition: a "/" boot never publishes home');
  assert.equal(App._isScreenVisible('home-screen'), true);

  // The island renders its `hidden` class from the same store with the same
  // shipped-visible default, so the two halves cannot disagree here.
  assert.match(storeTs, /useVisibilityHiddenClass/,
    'the React half must expose the hook that applies that same default');
  assert.match(
    fs.readFileSync(
      path.join(ROOT, 'frontend', 'src', 'features', 'home', 'index.tsx'), 'utf8',
    ),
    /useVisibilityHiddenClass\(\s*screenRef,\s*'home-screen',\s*true\s*\)/,
    'the home island must pass shippedVisible=true, matching the DOM fallback',
  );
});

test('app.js routes its screen swaps through the seam, not raw classList', () => {
  // The regression this catches is a new call site added later that reaches
  // for the class directly — it would work perfectly until the day that
  // screen is converted, and then fail in a way that points nowhere near it.
  const SCREEN_IDS = ['app-view', 'home-screen', 'browse-screen', 'leaderboard-screen',
    'profile-screen', 'admin-screen', 'settings-screen', 'messages-screen',
    'agent-session-screen'];
  const offenders = [];
  const lines = appJs.split('\n');
  lines.forEach((line, i) => {
    for (const id of SCREEN_IDS) {
      if (!line.includes(`getElementById('${id}')`)) continue;
      if (!/classList\s*\.\s*(add|remove|toggle|contains)\(\s*'hidden'/.test(line)) continue;
      offenders.push(`public/js/app.js:${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(
    offenders, [],
    'these lines toggle or read `hidden` on a screen root directly. Use '
    + 'App._setScreenVisible / App._isScreenVisible so the call keeps working once that root '
    + 'is React-owned:\n  ' + offenders.join('\n  '),
  );
});
