// iOS notification-permission trigger reliability (first-run sheet).
//
// On iOS the ONLY automatic trigger for the OS notification prompt is the
// first-run "Set up your device" sheet (its "Allow notifications" button
// calls usernode.requestPermissions()). The sheet used to be guarded by a
// single unconditional one-shot localStorage marker, and several paths set
// that marker WITHOUT the OS prompt ever having been presented:
//
//   - a degraded UI kit (PlatformUI.sheet() → null) still marked done;
//   - earlier app/shell versions that reported "nothing to ask" on iOS
//     marked done, and the marker survives app updates in the WebView;
//   - a dismissed (possibly stacked, #1068) sheet marked done even though
//     the user never tapped "Allow notifications".
//
// iOS can distinguish "never asked" from "denied" through the social-push
// state (permissionStatus: notDetermined vs denied). While the permission
// is still un-prompted, suppressing the ask forever is wrong — the sheet
// must be offered again (once per launch). A determined status (granted
// or denied) keeps the marker authoritative, and Android is unchanged.
//
// Run with: node --test tests/first-run-permissions-ios-prompt.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const nativeChromeSource = fs.readFileSync(
  path.join(root, 'public', 'js', 'native-chrome.js'), 'utf8');

// The sheet must reach signed-out users too: the OS notification prompt
// (and the Android alarm/battery asks) are device-level, not
// account-level, so entering the anonymous shell is also a trigger.

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

// Boot native-chrome.js in a sandbox and return handles for driving
// maybeShowFirstRunPermissions under different device states.
function boot(opts) {
  const sheets = [];
  const stored = { ...(opts.stored || {}) };
  const capabilities = opts.capabilities ||
    ['getSettingsState', 'getSocialPushState'];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    App: { user: opts.user !== undefined ? opts.user : { id: 'u1' } },
    unNative: opts.unNative !== undefined ? opts.unNative
      : { toast() {}, platform: opts.kitPlatform || 'ios' },
    usernode: {
      isNative: true,
      async getBridgeInfo() { return { version: 5, capabilities }; },
      async getSettingsState() { return { permissions: opts.permissions }; },
      async getSocialPushState() {
        if (opts.socialPushState === undefined) return null;
        return opts.socialPushState;
      },
      async requestPermissions() {
        return { granted: false, permissions: opts.permissions };
      },
      async openBatterySettings() { return true; },
    },
    PlatformUI: {
      sheet(sheetOpts) {
        if (opts.kitSheetUnavailable) return null;
        const handle = {
          dismissed: false,
          dismiss() {
            handle.dismissed = true;
            if (sheetOpts.onDismiss) sheetOpts.onDismiss();
          },
        };
        sheetOpts.handle = handle;
        sheets.push(sheetOpts);
        return handle;
      },
    },
    localStorage: {
      getItem(key) { return Object.hasOwn(stored, key) ? stored[key] : null; },
      setItem(key, value) { stored[key] = String(value); },
    },
    document: {
      getElementById() { return null; },
      createElement(tag) { return fakeNode(tag); },
      addEventListener() {},
    },
    addEventListener() {},
    dispatchEvent() {},
    // Real, REF'D timers. An unref'd timer here starves the grant-recheck
    // loop (native-chrome's only setTimeout, bounded at 4 iterations): the
    // test awaits a promise the timer resolves, node sees nothing keeping
    // the event loop alive, and the whole file dies with "Promise
    // resolution is still pending but the event loop has already resolved"
    // — cancelling every later test in the file with it.
    setTimeout, clearTimeout,
    setInterval() {},
    fetch() { return Promise.reject(new Error('unexpected fetch')); },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  return { sandbox, sheets, stored };
}

function findButton(node, text) {
  if (node.tag === 'button' && node.textContent === text) return node;
  for (const child of node.children || []) {
    const found = findButton(child, text);
    if (found) return found;
  }
  return null;
}

const MARKER = 'sv:onboarding_permissions_done';
const IOS_UNPROMPTED = {
  enabled: false,
  permissionStatus: 'notDetermined',
  registrationStatus: 'unregistered',
  deliveryActive: false,
};

test('iOS: a stale done-marker does not suppress the sheet while the OS ' +
     'prompt has never been shown', async () => {
  const { sandbox, sheets } = boot({
    stored: { [MARKER]: '1' },
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
    socialPushState: IOS_UNPROMPTED,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1,
    'an un-prompted iOS device gets the sheet despite the marker');
});

test('iOS: marker plus a DENIED permission stays suppressed (the user ' +
     'already answered the OS prompt)', async () => {
  const { sandbox, sheets } = boot({
    stored: { [MARKER]: '1' },
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
    socialPushState: { ...IOS_UNPROMPTED, permissionStatus: 'denied' },
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 0);
});

test('iOS: marker plus an authorized permission stays suppressed', async () => {
  const { sandbox, sheets } = boot({
    stored: { [MARKER]: '1' },
    permissions: { platform: 'ios', exactAlarmGranted: true, batteryOptDisabled: null },
    socialPushState: { ...IOS_UNPROMPTED, permissionStatus: 'authorized' },
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 0);
});

test('iOS: the sheet shows even when the settings snapshot claims ' +
     'exactAlarmGranted while the push permission is un-prompted', async () => {
  // Defends against native builds where the alarm boolean does not map to
  // the notification permission (there are no exact alarms on iOS).
  const { sandbox, sheets } = boot({
    permissions: { platform: 'ios', exactAlarmGranted: true, batteryOptDisabled: null },
    socialPushState: IOS_UNPROMPTED,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1);
});

test('iOS: without the social-push capability the boolean fallback still ' +
     'shows the sheet on a fresh device', async () => {
  const { sandbox, sheets } = boot({
    capabilities: ['getSettingsState'],
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1);
});

test('a degraded kit (sheet unavailable) must NOT burn the one-shot ' +
     'marker — nothing was shown', async () => {
  const { sandbox, sheets, stored } = boot({
    kitSheetUnavailable: true,
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
    socialPushState: IOS_UNPROMPTED,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 0);
  assert.notEqual(stored[MARKER], '1',
    'a launch that presented nothing must leave the next launch its chance');
});

test('concurrent and repeat triggers in one document present exactly one ' +
     'sheet', async () => {
  const { sandbox, sheets } = boot({
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
    socialPushState: IOS_UNPROMPTED,
  });
  await Promise.all([
    sandbox.NativeChrome.maybeShowFirstRunPermissions(),
    sandbox.NativeChrome.maybeShowFirstRunPermissions(),
  ]);
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1,
    'the sv:session/auth-status trigger storm must not stack sheets');
});

test('Android: the marker still suppresses the sheet with no bridge ' +
     'reads', async () => {
  let settingsReads = 0;
  const { sandbox, sheets } = boot({
    stored: { [MARKER]: '1' },
    kitPlatform: 'android',
    permissions: { platform: 'android', exactAlarmGranted: false, batteryOptDisabled: false },
  });
  const inner = sandbox.usernode.getSettingsState;
  sandbox.usernode.getSettingsState = async () => { settingsReads += 1; return inner(); };
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 0);
  assert.equal(settingsReads, 0,
    'a marked Android device keeps the instant-return fast path');
});

const IOS_PERMS = {
  platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null,
};

test('iOS: granting from the sheet closes it, even when the native status ' +
     'read still lags behind the OS dialog', async () => {
  const { sandbox, sheets, stored } = boot({
    permissions: IOS_PERMS,
    socialPushState: IOS_UNPROMPTED, // stays stale after the grant
  });
  sandbox.usernode.requestPermissions = async () => ({
    granted: true,
    permissions: { ...IOS_PERMS, exactAlarmGranted: true },
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  const allow = findButton(sheets[0].contentEl, 'Allow notifications');
  assert.ok(allow, 'the sheet renders the Allow notifications button');
  await allow.listeners.click();
  assert.equal(sheets[0].handle.dismissed, true,
    'a successful grant closes the sheet');
  assert.equal(stored[MARKER], '1',
    'closing on grant records first-run done');
});

test('iOS: a requestPermissions that resolves before the user answers ' +
     'still closes once the status settles to granted', async () => {
  const { sandbox, sheets } = boot({ permissions: IOS_PERMS });
  let reads = 0;
  sandbox.usernode.getSocialPushState = async () => {
    reads += 1;
    return {
      ...IOS_UNPROMPTED,
      permissionStatus: reads >= 3 ? 'authorized' : 'notDetermined',
    };
  };
  sandbox.usernode.requestPermissions = async () => ({
    granted: false, permissions: IOS_PERMS,
  });
  sandbox.NativeChrome._FIRST_RUN_RECHECK_MS = 1;
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  const allow = findButton(sheets[0].contentEl, 'Allow notifications');
  await allow.listeners.click();
  assert.equal(sheets[0].handle.dismissed, true,
    'the settled granted status closes the sheet');
});

test('iOS: a denial keeps the sheet open, un-granted, and unmarked', async () => {
  const { sandbox, sheets, stored } = boot({
    permissions: IOS_PERMS,
    socialPushState: IOS_UNPROMPTED,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  sandbox.usernode.getSocialPushState = async () => ({
    ...IOS_UNPROMPTED, permissionStatus: 'denied',
  });
  sandbox.usernode.requestPermissions = async () => ({
    granted: false, permissions: IOS_PERMS,
  });
  const allow = findButton(sheets[0].contentEl, 'Allow notifications');
  await allow.listeners.click();
  assert.equal(sheets[0].handle.dismissed, false);
  assert.ok(findButton(sheets[0].contentEl, 'Skip for now'),
    'the dismiss affordance is still there');
  assert.notEqual(stored[MARKER], '1');
});

test('anonymous: native session stays closed while device permissions remain available',
  async () => {
  const { sandbox, sheets } = boot({
    user: null,
    capabilities: ['getSettingsState', 'getSocialPushState'],
    permissions: { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null },
    socialPushState: IOS_UNPROMPTED,
  });
  const admitted = await sandbox.NativeChrome.enterAnonymous();
  assert.equal(admitted, false, 'anonymous pages never receive session authority');
  // Anonymous entry fires the device-only sheet itself — wait for that run, without
  // calling maybeShowFirstRunPermissions() here (that would mask a
  // missing trigger).
  if (sandbox.NativeChrome._firstRunPromise) {
    await sandbox.NativeChrome._firstRunPromise;
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sheets.length, 1,
    'anonymous entry must still trigger device-only permissions');
});

test('Android: an unmarked device still gets the sheet', async () => {
  const { sandbox, sheets } = boot({
    kitPlatform: 'android',
    permissions: { platform: 'android', exactAlarmGranted: false, batteryOptDisabled: false },
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1);
});

// ── The sheet must survive its own opening tap ─────────────────────────
//
// A tap that presents an overlay leaves a synthesized click behind
// ~300ms later, and it lands on the backdrop that tap just put on screen.
// The kit now refuses that click (decideBackdropDismiss in
// public/usernode-native/v1/native.js), but this marker is one-shot and
// silences the iOS notification prompt FOREVER, so it must not depend on
// the kit alone: a dismissal nobody could have read, from a user who
// pressed nothing on the sheet, is not an answer.

test('a dismissal too fast to have been read leaves the marker unwritten', async () => {
  const { sandbox, sheets, stored } = boot({
    permissions: IOS_PERMS,
    socialPushState: IOS_UNPROMPTED,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  // The ghost: nothing on the sheet was touched, and it arrives at once.
  sheets[0].handle.dismiss();
  assert.notEqual(stored[MARKER], '1',
    'a ghost-click dismissal must not burn the one-shot iOS prompt');
});

test('a dismissal the user could have read records first-run done', async () => {
  const { sandbox, sheets, stored } = boot({
    permissions: IOS_PERMS,
    socialPushState: IOS_UNPROMPTED,
  });
  sandbox.NativeChrome._FIRST_RUN_MIN_SEEN_MS = 5;
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  await new Promise((resolve) => setTimeout(resolve, 20));
  sheets[0].handle.dismiss();
  assert.equal(stored[MARKER], '1',
    'a real "not now" is still an answer and still one-shot');
});

test('pressing Skip records first-run done however fast it happens', async () => {
  // Interaction, not elapsed time, is what makes a dismissal an answer —
  // otherwise the guard would eat a decisive tap made in under 450ms.
  const { sandbox, sheets, stored } = boot({
    permissions: IOS_PERMS,
    socialPushState: IOS_UNPROMPTED,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  const skip = findButton(sheets[0].contentEl, 'Skip for now');
  assert.ok(skip, 'the sheet renders its dismiss affordance');
  skip.listeners.click();
  assert.equal(stored[MARKER], '1');
});

// ── Completing the grant (shared with Settings → Homeroom app) ─────────

test('settleIosPushGrant polls past a lagging status and kicks push registration', async () => {
  const { sandbox } = boot({ permissions: IOS_PERMS });
  let reads = 0;
  sandbox.usernode.getSocialPushState = async () => {
    reads += 1;
    return {
      ...IOS_UNPROMPTED,
      permissionStatus: reads >= 3 ? 'authorized' : 'notDetermined',
    };
  };
  sandbox.NativeChrome._FIRST_RUN_RECHECK_MS = 1;
  let kicked = 0;
  sandbox.SocialPush = { getState() { kicked += 1; } };
  // requestPermissions resolved with granted:false — the OS dialog had not
  // been answered yet. The settled status is the answer, not that flag.
  const settled = await sandbox.NativeChrome.settleIosPushGrant(false);
  assert.equal(settled.granted, true);
  assert.equal(settled.status, 'granted');
  assert.equal(kicked, 1,
    'a fresh grant starts push registration now, not on the next app resume');
});

test('settleIosPushGrant reports a denial and starts no registration', async () => {
  const { sandbox } = boot({ permissions: IOS_PERMS });
  sandbox.usernode.getSocialPushState = async () => ({
    ...IOS_UNPROMPTED, permissionStatus: 'denied',
  });
  let kicked = 0;
  sandbox.SocialPush = { getState() { kicked += 1; } };
  const settled = await sandbox.NativeChrome.settleIosPushGrant(true);
  assert.equal(settled.granted, false, 'a determined denial beats the grant flag');
  assert.equal(settled.status, 'denied');
  assert.equal(kicked, 0);
});

test('Settings’ Allow notifications completes the grant the same way', () => {
  // The Settings row used to be a bare
  // _unApply(usernode.requestPermissions()) — one read, no polling, no
  // SocialPush kick — so on iOS it repainted "Not granted" moments after a
  // real grant. Both screens go through settleIosPushGrant now.
  const settingsJs = fs.readFileSync(
    path.join(root, 'frontend', 'src', 'features', 'settings', 'settings.js'), 'utf8');
  assert.match(settingsJs, /_unRequestPermissions\(isAndroid\)/,
    'the button routes through the completing path');
  const at = settingsJs.indexOf('async _unRequestPermissions(');
  assert.ok(at > -1, 'settings.js defines _unRequestPermissions');
  const fn = settingsJs.slice(at, settingsJs.indexOf('\n    // Awaits a bridge setter', at));
  assert.match(fn, /settleIosPushGrant/,
    'iOS grants settle through the shared native-chrome helper');
  // #1079: the row is a component driven by a published model, so repainting
  // from the settled answer IS the publish.
  assert.match(fn, /_publishUsernode\(\)/,
    'the row repaints from the settled answer');
  assert.ok(!/_unApply\(window\.usernode\.requestPermissions\(\)\)/.test(settingsJs),
    'the old single-read path must not survive anywhere');
});

// ── ?shot=notif-permissions dispatches its ghost click synchronously ───────
//
// presentSheet appends the sheet/backdrop and wires the guard before it
// returns. Dispatch there, while the opening gesture's ghost window is true
// by construction; deferring to a timer or frame makes a headless/background
// scheduler part of the assertion and has made unrelated proposals go red.

test('the ghost click targets the synchronously presented sheet', () => {
  const app = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const shot = app.slice(app.indexOf('  _applyNotifPermissionsShot() {'));
  const body = shot.slice(0, shot.indexOf('\n  },'));

  assert.doesNotMatch(body, /requestAnimationFrame|performance\.now/,
    'no scheduler decides whether the synthetic ghost lands in time');
  const presentAt = body.indexOf('const sheet = NativeChrome.presentPermissionsSheet');
  const backdropAt = body.indexOf("const backdrop = document.querySelector('.un-backdrop')");
  const clickAt = body.indexOf('backdrop.click()');
  const markerAt = body.indexOf(
    "sheet.el.setAttribute('data-un-ghost-click', 'dispatched')");
  assert.ok(presentAt >= 0 && presentAt < backdropAt && backdropAt < clickAt && clickAt < markerAt,
    'present, dispatch, and mark happen synchronously in that order');
  assert.match(body, /if \(!backdrop\) return;/,
    'a missing backdrop cannot produce a false-positive marker');
  assert.doesNotMatch(body, /document\.querySelector\('\.un-sheet'\)/,
    'the marker belongs to the exact returned sheet');
});
