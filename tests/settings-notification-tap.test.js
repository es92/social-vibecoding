// The in-app Settings notification row must never be a dead tap (#1193).
//
// Reported: inside the Homeroom iOS app, tapping the notification row in
// Settings does nothing at all. Two compounding causes, neither of which
// #1192 (which only fixed the FIRST-RUN sheet's ghost click) touched:
//
//   1. The row was a plain <div> with no listener, so tapping it was a
//      no-op by construction. The only control was a small chip rendered
//      underneath — and only when the row read "Not granted". That reading
//      came from `permissions.exactAlarmGranted`, which is meaningless on
//      iOS (there are no exact alarms), so a build reporting it `true`
//      painted "Notifications — Granted" with nothing to tap at all.
//   2. Even when the chip did render, iOS's requestAuthorization presents
//      a dialog ONLY while the permission is un-determined. Once the user
//      has answered once, it resolves immediately and shows nothing — so a
//      screen whose only move is "call requestPermissions and hope" is a
//      tap that does nothing forever, however many times it is pressed.
//
// The decision now lives in two pure functions in native-chrome.js (same
// discipline as the kit's decideBackdropDismiss), so the branch that
// matters — "the app answered, nothing was granted, and the permission is
// STILL un-determined", i.e. no OS prompt was ever presented — is
// verifiable without a WebView.
//
// Run with: node --test tests/settings-notification-tap.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const nativeChromeSource = fs.readFileSync(
  path.join(root, 'public', 'js', 'native-chrome.js'), 'utf8');
const settingsSource = fs.readFileSync(
  path.join(root, 'frontend', 'src', 'features', 'settings', 'settings.js'),
  'utf8');
const bridgeSource = fs.readFileSync(
  path.join(root, 'public', 'usernode-bridge.js'), 'utf8');

// Minimal sandbox: these are pure functions plus one capability probe, so
// nothing here needs a DOM or the kit.
function boot(opts = {}) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class {},
    usernode: opts.usernode === undefined
      ? {
          isNative: true,
          async getBridgeInfo() {
            return opts.bridgeInfo === undefined
              ? { version: 4, capabilities: opts.capabilities ||
                  ['getSettingsState', 'openNotificationSettings'] }
              : opts.bridgeInfo;
          },
        }
      : opts.usernode,
    localStorage: { getItem() { return null; }, setItem() {} },
    document: {
      getElementById() { return null; },
      createElement() { return { style: {}, appendChild() {} }; },
      addEventListener() {},
    },
    addEventListener() {},
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
    setInterval() {},
    fetch() { return Promise.reject(new Error('unexpected fetch')); },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  return sandbox;
}

const IOS_IN_APP = {
  isNative: true,
  hasRequestMethod: true,
  supported: true,
  isAndroid: false,
  canOpenSettings: true,
};

// ── decideNotificationTap ───────────────────────────────────────────────

test('iOS, never asked: the tap opens the OS prompt', () => {
  const { NativeChrome } = boot();
  const plan = NativeChrome.decideNotificationTap({
    ...IOS_IN_APP, pushStatus: 'undetermined',
  });
  assert.equal(plan.verdict, 'request');
});

test('iOS, no status read at all: still ask (an unknown status must not ' +
     'be latched as unsupported — issue #978)', () => {
  const { NativeChrome } = boot();
  const plan = NativeChrome.decideNotificationTap({
    ...IOS_IN_APP, pushStatus: null,
  });
  assert.equal(plan.verdict, 'request');
});

test('iOS, DENIED: never "request" — iOS shows no prompt for a determined ' +
     'permission, so that branch is the dead tap itself', () => {
  const { NativeChrome } = boot();
  const plan = NativeChrome.decideNotificationTap({
    ...IOS_IN_APP, pushStatus: 'denied',
  });
  assert.equal(plan.verdict, 'settings');
  assert.equal(plan.settings, true);
  assert.match(plan.reason, /denied/);
});

test('iOS, denied on a build with no openNotificationSettings: still ' +
     'explains itself, but offers no button that cannot work', () => {
  const { NativeChrome } = boot();
  const plan = NativeChrome.decideNotificationTap({
    ...IOS_IN_APP, pushStatus: 'denied', canOpenSettings: false,
  });
  assert.equal(plan.verdict, 'settings');
  assert.equal(plan.settings, false);
});

test('iOS, already granted: says so rather than calling a method that ' +
     'resolves instantly and shows nothing', () => {
  const { NativeChrome } = boot();
  const plan = NativeChrome.decideNotificationTap({
    ...IOS_IN_APP, pushStatus: 'granted',
  });
  assert.equal(plan.verdict, 'already');
});

test('Android is unchanged: the snapshot is the answer, so always ask', () => {
  const { NativeChrome } = boot();
  for (const pushStatus of ['denied', 'granted', 'undetermined', null]) {
    const plan = NativeChrome.decideNotificationTap({
      ...IOS_IN_APP, isAndroid: true, pushStatus,
    });
    assert.equal(plan.verdict, 'request', `android/${pushStatus}`);
  }
});

test('outside the app, or with no requestPermissions: a named reason, not ' +
     'a silent return', () => {
  const { NativeChrome } = boot();
  const off = NativeChrome.decideNotificationTap({
    ...IOS_IN_APP, isNative: false, pushStatus: 'undetermined',
  });
  assert.equal(off.verdict, 'no-bridge');
  assert.match(off.reason, /Homeroom app/);
  const noMethod = NativeChrome.decideNotificationTap({
    ...IOS_IN_APP, hasRequestMethod: false, pushStatus: 'undetermined',
  });
  assert.equal(noMethod.verdict, 'no-bridge');
  assert.match(noMethod.reason, /requestPermissions/);
});

test('a build that positively advertises no requestPermissions is ' +
     'unsupported; an INCONCLUSIVE probe still asks', () => {
  const { NativeChrome } = boot();
  assert.equal(NativeChrome.decideNotificationTap({
    ...IOS_IN_APP, supported: false, pushStatus: 'undetermined',
  }).verdict, 'unsupported');
  assert.equal(NativeChrome.decideNotificationTap({
    ...IOS_IN_APP, supported: null, pushStatus: 'undetermined',
  }).verdict, 'request');
});

test('an empty state object is a dead end with a reason, never a throw', () => {
  const { NativeChrome } = boot();
  assert.equal(NativeChrome.decideNotificationTap().verdict, 'no-bridge');
  assert.equal(NativeChrome.decideNotificationTap({}).verdict, 'no-bridge');
});

// ── decideNotificationOutcome ───────────────────────────────────────────

test('the reported bug, after the fact: the app answered, nothing was ' +
     'granted, and the permission is STILL un-determined — no OS prompt ' +
     'was ever presented', () => {
  const { NativeChrome } = boot();
  const out = NativeChrome.decideNotificationOutcome({
    isAndroid: false, granted: false, pushStatus: 'undetermined',
    canOpenSettings: true,
  });
  assert.equal(out.verdict, 'silent');
  assert.equal(out.settings, true);
  assert.match(out.reason, /un-determined/);
});

test('a grant is a grant', () => {
  const { NativeChrome } = boot();
  assert.equal(NativeChrome.decideNotificationOutcome({
    isAndroid: false, granted: true, pushStatus: 'granted',
  }).verdict, 'granted');
});

test('answered and denied points at the OS settings page, not at another ' +
     'request that would show nothing', () => {
  const { NativeChrome } = boot();
  const out = NativeChrome.decideNotificationOutcome({
    isAndroid: false, granted: false, pushStatus: 'denied',
    canOpenSettings: true,
  });
  assert.equal(out.verdict, 'settings');
});

test('Android declines are plain declines', () => {
  const { NativeChrome } = boot();
  const out = NativeChrome.decideNotificationOutcome({
    isAndroid: true, granted: false, pushStatus: null,
  });
  assert.equal(out.verdict, 'declined');
  assert.equal(out.settings, false);
});

// ── the capability probe ────────────────────────────────────────────────

test('supports() is tri-state: a degraded probe answers null, never false', async () => {
  assert.equal(await boot({
    capabilities: ['openNotificationSettings'],
  }).NativeChrome.supports('openNotificationSettings'), true);
  assert.equal(await boot({
    capabilities: ['getSettingsState'],
  }).NativeChrome.supports('openNotificationSettings'), false);
  assert.equal(await boot({
    bridgeInfo: { version: 4, capabilities: [], degraded: true },
  }).NativeChrome.supports('openNotificationSettings'), null);
  assert.equal(await boot({
    bridgeInfo: { version: 4, capabilities: [] },
  }).NativeChrome.supports('openNotificationSettings'), null);
  assert.equal(await boot({ usernode: null })
    .NativeChrome.supports('openNotificationSettings'), null);
});

// ── the wiring the screen depends on ────────────────────────────────────

test('the bridge exposes openNotificationSettings, capability-gated and ' +
     'on the fast probe timeout rather than the 120s permission one', () => {
  assert.match(bridgeSource, /window\.usernode\.openNotificationSettings\s*=/);
  const start = bridgeSource.indexOf('window.usernode.openNotificationSettings =');
  const body = bridgeSource.slice(start, start + 1600);
  assert.match(body, /_CHROME_PROBE_TIMEOUT_MS/);
  assert.match(body, /usernodeKind = "unsupported"/);
  // #978: an inconclusive probe must still call through.
  assert.match(body, /degraded !== true/);
  assert.match(body, /caps\.length > 0/);
  assert.match(bridgeSource, /"openNotificationSettings"/);
});

test('the settings row is a real control, not an inert div', () => {
  assert.match(settingsSource, /id: 'settings-notif-row'/);
  // #1079: the row's model carries an ACTION, and the component renders a
  // <button> only when one is present — so an inert row is inert by
  // construction rather than by remembering to omit a listener.
  assert.match(settingsSource, /action: '_requestUsernodePermissions'/);
  const ui = fs.readFileSync(path.join(root, 'frontend', 'src', 'features',
    'settings', 'sections', 'usernode-ui.tsx'), 'utf8');
  assert.match(ui, /if \(!row\.action\) \{[\s\S]{0,140}<div id=\{row\.id\}/,
    'no action means a div, never a button that does nothing');
  assert.match(ui, /onClick=\{\(\) => run\(row\.action as string\)\}/);
});

test('the row reads the real iOS push permission BEFORE it renders, not ' +
     'only after a request has settled', () => {
  assert.match(settingsSource, /_probeUnNotifPermission\(token\)/);
  assert.match(settingsSource, /nc\.iosPushPermissionStatus\(\)/);
});

test('every dead end leaves a console error AND a visible notice', () => {
  assert.match(settingsSource,
    /console\.error\(\s*`\[settings\] notification permission dead end/);
  const start = settingsSource.indexOf('_unNotifDeadEnd(kind, opts) {');
  assert.ok(start !== -1, '_unNotifDeadEnd exists');
  const body = settingsSource.slice(start, start + 700);
  assert.match(body, /console\.error/);
  assert.match(body, /_unNotifNotice = \{/);
  // The tap acknowledges itself before anything can block, too.
  assert.match(settingsSource, /Opening the notification prompt…/);
});

test('the screen never renders an Open notification settings button the ' +
     'app cannot honour', () => {
  // #1079: the gate is the view model's; the component renders the button
  // only when it is set.
  assert.match(settingsSource,
    /settings: !!\(n\.settings && this\._unCanOpenNotifSettings === true\)/);
  const tsx = fs.readFileSync(path.join(root, 'frontend', 'src', 'features',
    'settings', 'sections', 'usernode.tsx'), 'utf8');
  assert.match(tsx, /b\.notice\.settings \? \(/,
    'the button renders only behind that gate');
});

test('a native side that never answers surfaces well inside the bridge’s ' +
     'own two-minute permission ceiling', () => {
  assert.match(settingsSource, /_UN_NATIVE_ANSWER_MS: (\d+)/);
  const ms = Number(/_UN_NATIVE_ANSWER_MS: (\d+)/.exec(settingsSource)[1]);
  assert.ok(ms > 0 && ms <= 30000, `expected a short ceiling, got ${ms}`);
  assert.match(settingsSource, /usernodeNoAnswer/);
});

test('the notifications route is covered by a dapp check with the row ' +
     'present', () => {
  const dapp = JSON.parse(
    fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));
  const hits = (dapp.tests || []).filter((t) =>
    typeof t.path === 'string' && t.path.includes('usernodedemo=ios'));
  assert.ok(hits.length >= 1, 'a check drives the settings notifications route');
  assert.ok(hits.some((t) => (t.expectSelector || '').includes('settings-notif-row')),
    'and asserts the row itself');
});
