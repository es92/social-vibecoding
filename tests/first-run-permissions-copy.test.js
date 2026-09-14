// Platform-accurate permission copy (iOS wording fix) — the first-run
// "Set up your device" sheet and the Settings → Homeroom app permission
// rows must describe what each OS actually prompts for:
//
//  - Android: the exact-alarm permission (plus battery optimization) so
//    the node can produce blocks at exact slot times. Copy unchanged.
//  - iOS: the native requestPermissions() maps to the NOTIFICATION
//    permission, and v4 disabled iOS block production outright
//    (NATIVE-BRIDGE.md). So the sheet must not promise background block
//    production or label the row "Alarm permissions" — it asks for
//    notifications and says so.
//
// Run with: node --test tests/first-run-permissions-copy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const nativeChromeSource = fs.readFileSync(
  path.join(root, 'public', 'js', 'native-chrome.js'), 'utf8');
const settingsJs = fs.readFileSync(
  path.join(root, 'frontend', 'src', 'features', 'settings', 'settings.js'), 'utf8');

// Minimal DOM node: enough for the el()/appendChild/textContent usage in
// maybeShowFirstRunPermissions. Setting textContent clears children,
// mirroring the real DOM (render() relies on that to re-render).
function fakeNode(tag) {
  const node = {
    tag,
    className: '',
    disabled: false,
    children: [],
    listeners: {},
    _text: '',
    appendChild(child) { node.children.push(child); return child; },
    addEventListener(type, fn) { node.listeners[type] = fn; },
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._text; },
    set(value) { node._text = value == null ? '' : String(value); node.children = []; },
  });
  return node;
}

function allText(node) {
  return [node.textContent, ...node.children.map(allText)].join(' ');
}

async function showFirstRunSheet(permissions) {
  const sheets = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    App: { user: { id: 'u1' } },
    usernode: {
      isNative: true,
      async getBridgeInfo() {
        return { version: 4, capabilities: ['getSettingsState'] };
      },
      async getSettingsState() { return { permissions }; },
      async requestPermissions() { return { granted: false, permissions }; },
      async openBatterySettings() { return true; },
    },
    PlatformUI: {
      sheet(opts) {
        sheets.push(opts);
        return { dismiss() { if (opts.onDismiss) opts.onDismiss(); } };
      },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: {
      getElementById() { return null; },
      createElement(tag) { return fakeNode(tag); },
      addEventListener() {},
    },
    addEventListener() {},
    dispatchEvent() {},
    setTimeout(fn, delay) {
      const t = setTimeout(fn, delay);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    clearTimeout,
    setInterval() {},
    fetch() { return Promise.reject(new Error('unexpected fetch')); },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1, 'the first-run sheet was shown once');
  return allText(sheets[0].contentEl);
}

test('iOS first-run sheet asks for notifications, not alarms or blocks', async () => {
  const text = await showFirstRunSheet({
    platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null,
  });
  assert.match(text, /Notifications/,
    'the iOS status row is labeled Notifications');
  assert.doesNotMatch(text, /Alarm permissions/,
    'the misleading "Alarm permissions" label is gone on iOS');
  assert.doesNotMatch(text, /produce blocks|exact slot times/,
    'iOS copy must not promise background block production (off since v4)');
  assert.match(text, /notif/i,
    'the iOS body copy explains the notification permission');
  assert.match(text, /Allow notifications/,
    'the iOS grant button says what the OS will actually ask');
  assert.doesNotMatch(text, /Battery optimization/,
    'iOS never shows the Android battery row');
});

test('Android first-run sheet keeps the exact-alarm + battery copy', async () => {
  const text = await showFirstRunSheet({
    platform: 'android', exactAlarmGranted: false, batteryOptDisabled: false,
  });
  assert.match(text, /Exact alarms/);
  assert.match(text, /Battery optimization/);
  assert.match(text, /produce blocks/,
    'Android copy still explains block production');
  assert.match(text, /exact slot times/);
});

test('settings device-permissions section is platform-accurate', () => {
  assert.ok(!settingsJs.includes('Alarm permissions'),
    'settings.js must not label the iOS row "Alarm permissions"');
  assert.match(settingsJs, /isAndroid \? 'Exact alarms' : 'Notifications'/,
    'the row label switches to Notifications on iOS');
  // The section description must be platform-gated too: the
  // block-production pitch is Android-only, iOS explains notifications.
  const desc = /isAndroid\s*\n?\s*\? 'Block production needs the app to wake your device at exact slot times\.'\s*\n?\s*: '[^']*[Nn]otif[^']*'/;
  assert.match(settingsJs, desc,
    'the section description is gated on isAndroid');
});

test('native-chrome.js carries no "Alarm permissions" wording anywhere', () => {
  assert.ok(!nativeChromeSource.includes('Alarm permissions'));
});
