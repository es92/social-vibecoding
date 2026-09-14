// External links inside the Homeroom app go out through the bridge (#1312).
//
// The app's webview is bound to the platform's own domains (iOS App-Bound
// Domains — NATIVE-BRIDGE.md): it cannot navigate to github.com or claude.ai
// itself, so a target="_blank" anchor that works in every browser does
// NOTHING there, and neither does window.open. The first round of #1312
// turned the dev-chat walkthrough's scripted buttons into real anchors —
// which fixed mobile browsers and left the app exactly as dead as before.
// The road out of the app is the bridge's openExternal, and nav-link.js now
// routes every external target="_blank" anchor through it with one
// delegated listener.
//
// nav-link.js has no module.exports — it is written against window/document
// — so these tests run it in a vm sandbox with stand-ins for both and drive
// the registered listener directly.
//
// Run with: node --test tests/native-external-links.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const NAV_LINK_SRC = fs.readFileSync(path.join(root, 'public', 'js', 'nav-link.js'), 'utf8');

// Load nav-link.js against a fake window/document and hand back the
// document-level click listeners it registered, keyed by capture flag.
function load({ usernode } = {}) {
  const listeners = [];
  const opened = [];
  const window = {
    location: { href: 'https://sv.example/#app/x/dev', origin: 'https://sv.example' },
    open: (...args) => opened.push(args),
    usernode,
  };
  const document = {
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture: !!capture }),
  };
  vm.runInNewContext(NAV_LINK_SRC, { window, document, URL });
  return { window, listeners, opened, NavLink: window.NavLink };
}

function clickEvent(anchor, over) {
  return Object.assign({
    defaultPrevented: false,
    button: 0,
    prevented: 0,
    preventDefault() { this.prevented += 1; },
    target: {
      closest: (selector) => {
        assert.equal(selector, 'a[target="_blank"]',
          'only _blank anchors are candidates — plain anchors are the SPA\'s own navigation');
        return anchor;
      },
    },
  }, over || {});
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('the external-link listener is registered on capture', () => {
  // Transcript anchors stop propagation so their row handlers don't fire
  // (the session list's PR link does); a bubble listener would be starved
  // by exactly the links this exists for.
  const { listeners } = load();
  const captured = listeners.filter((l) => l.type === 'click' && l.capture);
  assert.equal(captured.length, 1, 'one capture-phase click listener');
});

test('inside the app, an external _blank anchor goes out through openExternal', async () => {
  const calls = [];
  const { listeners, opened } = load({
    usernode: { isNative: true, openExternal: (url) => { calls.push(url); return Promise.resolve(true); } },
  });
  const e = clickEvent({ href: 'https://github.com/usernode-apps/demo/fork' });
  listeners.find((l) => l.capture).fn(e);
  assert.equal(e.prevented, 1, 'the webview must not attempt the navigation itself');
  assert.deepEqual(calls, ['https://github.com/usernode-apps/demo/fork']);
  await tick();
  assert.deepEqual(opened, [], 'no scripted popup rides along with the bridge call');
});

test('an app build without the handler falls back to the popup path', async () => {
  const { listeners, opened } = load({
    usernode: { isNative: true, openExternal: () => Promise.reject(new Error('unsupported')) },
  });
  const e = clickEvent({ href: 'https://claude.ai/code' });
  listeners.find((l) => l.capture).fn(e);
  await tick();
  assert.deepEqual(opened, [['https://claude.ai/code', '_blank', 'noopener']],
    'at worst the tap does what the anchor would have done on its own');
});

test('in a browser the listener never engages', () => {
  // No bridge, or a bridge that reports non-native (desktop, iframes) —
  // the anchor keeps its native new-tab behaviour untouched.
  for (const usernode of [undefined, { isNative: false, openExternal: () => {} }, { isNative: true }]) {
    const { listeners } = load({ usernode });
    const e = clickEvent({ href: 'https://github.com/usernode-apps/demo' });
    listeners.find((l) => l.capture).fn(e);
    assert.equal(e.prevented, 0, 'the browser keeps the activation');
  }
});

test('same-origin and non-http destinations are left alone', () => {
  const { listeners } = load({
    usernode: { isNative: true, openExternal: () => Promise.resolve(true) },
  });
  const fn = listeners.find((l) => l.capture).fn;
  for (const href of ['https://sv.example/#leaderboard', 'mailto:hi@example.org', 'not a url']) {
    const e = clickEvent({ href });
    fn(e);
    assert.equal(e.prevented, 0, `${href} is not an external http(s) trip`);
  }
});

test('modified and already-claimed clicks stay the browser\'s business', () => {
  const { listeners } = load({
    usernode: { isNative: true, openExternal: () => Promise.resolve(true) },
  });
  const fn = listeners.find((l) => l.capture).fn;
  for (const over of [{ metaKey: true }, { ctrlKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    const e = clickEvent({ href: 'https://github.com/usernode-apps/demo' }, over);
    fn(e);
    assert.equal(e.prevented, 0);
  }
});

test('a click that reaches no anchor is ignored', () => {
  const { listeners } = load({
    usernode: { isNative: true, openExternal: () => Promise.resolve(true) },
  });
  const e = clickEvent(null);
  listeners.find((l) => l.capture).fn(e);
  assert.equal(e.prevented, 0);
});
