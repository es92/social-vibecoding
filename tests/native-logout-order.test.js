const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settingsSource = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'settings.js'),
  'utf8'
);

// Sign-out is the one flow where ORDER is the whole contract: the private
// native realm closes before the first await, the server revokes authority
// before any native teardown is attempted, and every surface ends on the
// public landing page (#1524) — including the native path, whose old document
// is otherwise forbidden continuation work.
function loadSettings({ nativeTerminal = true, nativeFailure, webOk = true, offlineLogout = false, webFailure, webPending = false } = {}) {
  const order = [];
  const logoutButton = { disabled: false };
  let href = 'https://social.example/#settings';
  const location = {};
  Object.defineProperty(location, 'href', {
    get() { return href; },
    set(value) { order.push('assign-href'); href = value; },
  });
  location.replace = (value) => { order.push('navigate'); href = value; };

  // Every listener the flow registers on the window, so a test can fire one.
  const listeners = [];
  // Every pending timer, so a test can decide whether this document survived
  // the native replacement it asked for.
  const timers = [];
  const stored = new Map();

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      addEventListener() {},
      getElementById(id) {
        return id === 'settings-logout' ? logoutButton : null;
      },
    },
    navigator: {},
    AbortController,
    location,
    history: {
      replaceState(state, title, url) {
        order.push('normalise-address');
        href = url;
      },
    },
    sessionStorage: {
      getItem(key) { return stored.has(key) ? stored.get(key) : null; },
      setItem(key, value) { order.push('notice'); stored.set(key, String(value)); },
      removeItem(key) { stored.delete(key); },
    },
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, options });
    },
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout() {},
    App: {
      _dropCachedSession() { order.push('drop-cached-session'); },
    },
    NativeChrome: {
      async getInfo() {
        return { sessionLifecycleProtocol: 2, capabilities: offlineLogout ? ['logout', 'offlineLogout'] : ['logout'] };
      },
      prepareWebLogout() {
        order.push('close-native-realm');
        return { nativeTerminal };
      },
      commitNativeLogout() {
        order.push('native-terminal');
        return nativeFailure ? Promise.reject(nativeFailure) : Promise.resolve(true);
      },
    },
    PlatformUI: {
      toast(message, options) {
        order.push(/signed out/i.test(message)
          ? 'local-shutdown-error' : 'logout-error');
        assert.equal(options.error, true);
      },
    },
    async fetch(url, options) {
      assert.equal(url, '/api/auth/logout');
      assert.equal(options.method, 'POST');
      order.push('web-session');
      if (webFailure) throw webFailure;
      if (webPending) return new Promise(() => {});
      return { ok: webOk, status: webOk ? 200 : 503 };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(settingsSource, sandbox);
  sandbox.Settings._clearSwApiCache = async () => { order.push('sw-cache'); };
  return {
    sandbox, order, logoutButton, listeners, timers, stored,
    get href() { return href; },
  };
}

test('realm closes synchronously before the first logout await', async () => {
  const loaded = loadSettings({ nativeTerminal: false });

  const logout = loaded.sandbox.Settings.logout();
  assert.deepEqual(loaded.order, ['close-native-realm', 'web-session']);
  await logout;
  assert.deepEqual(loaded.order, [
    'close-native-realm', 'web-session', 'sw-cache', 'drop-cached-session',
    'normalise-address', 'navigate',
  ]);
});

test('web logout and cache cleanup precede terminal protocol-2 logout',
  async () => {
    const loaded = loadSettings({ nativeTerminal: true });

    await loaded.sandbox.Settings.logout();

    assert.deepEqual(loaded.order, [
      'close-native-realm', 'web-session', 'sw-cache', 'drop-cached-session',
      'normalise-address', 'native-terminal',
    ]);
    // No navigation runs before the terminal call — the address is normalised
    // in place, which is what a restored WebView reads back.
    assert.equal(loaded.href, '/',
      'the surviving address boots the anonymous landing screen, not sign-in');
  });

test('native success normalises the address before handing over the WebView',
  async () => {
    const loaded = loadSettings({ nativeTerminal: true });

    await loaded.sandbox.Settings.logout();

    // A same-document History change keeps the executing realm's privileged
    // capability (NATIVE-BRIDGE.md, Trust model), so this is safe to do while
    // the terminal call is still ahead of us.
    assert.equal(loaded.href, '/');
    assert.equal(loaded.order.indexOf('normalise-address') <
      loaded.order.indexOf('native-terminal'), true);
  });

test('native success arms a bounded net in case the WebView is not replaced',
  async () => {
    const loaded = loadSettings({ nativeTerminal: true });

    await loaded.sandbox.Settings.logout();

    // Replacement normally destroys this document, so nothing above fired.
    assert.equal(loaded.order.includes('navigate'), false);
    const net = loaded.timers.find((t) => t.ms === 5000);
    assert.ok(net, 'a safety-net timer is armed after the terminal call');

    net.fn();
    assert.equal(loaded.href, '/',
      'a document that outlives its replacement still lands on the landing page');
  });

test('web-only logout replaces the entry after clearing the web session',
  async () => {
    const loaded = loadSettings({ nativeTerminal: false });

    await loaded.sandbox.Settings.logout();

    assert.deepEqual(loaded.order, [
      'close-native-realm', 'web-session', 'sw-cache', 'drop-cached-session',
      'normalise-address', 'navigate',
    ]);
    assert.equal(loaded.href, '/');
    // location.replace, never an href assignment: a pushed entry lets Back
    // restore the signed-in document.
    assert.equal(loaded.order.includes('assign-href'), false);
  });

test('a signed-out document restored from the BFCache navigates away again',
  async () => {
    const loaded = loadSettings({ nativeTerminal: false });

    await loaded.sandbox.Settings.logout();

    const guard = loaded.listeners.filter((l) => l.type === 'pageshow');
    assert.equal(guard.length, 1);
    assert.equal(guard[0].options.once, true);

    // A fresh load is not a restore, and must not be navigated.
    loaded.order.length = 0;
    guard[0].handler({ persisted: false });
    assert.deepEqual(loaded.order, []);

    guard[0].handler({ persisted: true });
    assert.deepEqual(loaded.order, ['navigate']);
    assert.equal(loaded.href, '/');
  });

test('native terminal failure lands on the landing page with an advisory', async () => {
  const loaded = loadSettings({
    nativeFailure: new Error('app update required'),
  });

  assert.equal(await loaded.sandbox.Settings.logout(), false);
  assert.deepEqual(loaded.order, [
    'close-native-realm', 'web-session', 'sw-cache', 'drop-cached-session',
    'normalise-address', 'native-terminal', 'notice', 'navigate',
  ]);
  // The button stays disabled: server authority is revoked and this document
  // is on its way out.
  assert.equal(loaded.logoutButton.disabled, true);
  assert.equal(loaded.href, '/');
  // The toast would not survive the navigation, so the advisory is handed to
  // the anonymous boot instead (App._drainLogoutNotice reads it once).
  assert.equal(loaded.stored.get('sv:logout_notice'),
    'Signed out. Close and reopen the app to finish shutting down Homeroom.');
});

test('a successful sign-out leaves no advisory for the anonymous boot',
  async () => {
    const loaded = loadSettings({ nativeTerminal: true });

    await loaded.sandbox.Settings.logout();

    assert.equal(loaded.stored.has('sv:logout_notice'), false);
    assert.equal(loaded.order.includes('notice'), false);
  });

test('failed web logout leaves native terminal untouched and the page in place',
  async () => {
    const loaded = loadSettings({ webOk: false });

    assert.equal(await loaded.sandbox.Settings.logout(), false);
    assert.deepEqual(loaded.order, [
      'close-native-realm', 'web-session', 'logout-error',
    ]);
    assert.equal(loaded.logoutButton.disabled, false);
    // Nothing was revoked, so the address still describes the screen the user
    // is looking at.
    assert.equal(loaded.href, 'https://social.example/#settings');
    assert.equal(loaded.stored.has('sv:logout_notice'), false);
  });

for (const failure of [{ webOk: false }, { webFailure: new TypeError('offline') }]) {
  test(`capable phone signs out locally after ${failure.webFailure ? 'network failure' : 'HTTP failure'}`, async () => {
    const loaded = loadSettings({ offlineLogout: true, ...failure });
    assert.equal(await loaded.sandbox.Settings.logout(), true);
    assert.deepEqual(loaded.order, [
      'close-native-realm', 'web-session', 'sw-cache', 'drop-cached-session',
      'normalise-address', 'native-terminal',
    ]);
    assert.equal(loaded.stored.has('sv:logout_notice'), false);
  });
}

test('a hung API cannot hold a capable phone logout indefinitely', async () => {
  const loaded = loadSettings({ offlineLogout: true, webPending: true });
  const pending = loaded.sandbox.Settings.logout();
  await new Promise(setImmediate);
  const deadline = loaded.timers.find((timer) => timer.ms === 2000);
  assert.ok(deadline);
  deadline.fn();
  assert.equal(await pending, true);
  assert.ok(loaded.order.includes('native-terminal'));
});

test('failed local cleanup after network failure does not claim logout or reload', async () => {
  const loaded = loadSettings({
    offlineLogout: true, webOk: false, nativeFailure: new Error('cookie deletion failed'),
  });
  assert.equal(await loaded.sandbox.Settings.logout(), false);
  assert.equal(loaded.order.includes('navigate'), false);
  assert.equal(loaded.order.includes('notice'), false);
  assert.equal(loaded.logoutButton.disabled, false);
});
