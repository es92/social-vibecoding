// "Get a ping when your app is ready?" (#12, decision D10).
//
// The Homeroom iOS app used to ask for the notification permission on the
// first screen of a fresh install: the first-run "Set up your device" sheet,
// opened at session setup, whose only iOS row was the OS notification prompt.
// iOS presents that prompt once, so it was spent before the person had made
// anything worth hearing about, and a tester who said "no" was never asked
// again. D10 moved the ask to the moment it means something: when the
// Homeroom bot starts building a new app, which it will message the person
// about once the first version is ready.
//
// This file pins the new ask end to end:
//
//   1. decidePingAsk, the pure rule: native iOS only, and only while the
//      permission is still undetermined. The settings snapshot's
//      `notificationPermission` wins; an older build's push status is
//      trusted once per device, because a build without push configured
//      reports "not determined" forever.
//   2. NativeChrome.askForPing: an in-app question first (the kit's alert,
//      the surface that stacks over the create dialog), and the OS prompt
//      ONLY after "Notify me". Nothing at all when it may not ask.
//   3. Nothing happens on mount: loading the shell, signing in and
//      rendering the progress view ask nothing, and on iOS session setup no
//      longer opens the "Set up your device" sheet.
//   4. The create dialog calls it once POST /api/apps answers with the
//      bot's chat, and only then.
//
// Run with: node --test tests/create-progress-ping-ask.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const nativeChromeSource = read('public', 'js', 'native-chrome.js');

const PROMPTED = 'sv:ping_ask_prompted';
const IOS = { platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null };
const ANDROID = { platform: 'android', exactAlarmGranted: false, batteryOptDisabled: false };

function fakeNode(tag) {
  const node = {
    tag,
    className: '',
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

/**
 * Boot public/js/native-chrome.js in a sandbox.
 *
 * opts: {
 *   native (default true), kit ({ platform } | null), capabilities,
 *   permissions (the settings snapshot's `permissions`, or null for an
 *     unreadable snapshot), pushState (getSocialPushState's answer),
 *   answer ('notify' | 'not-now' | 'manual'), hasKit (default true),
 *   requestResult, storage (a Map, to share one device across documents),
 *   bp (block-production state, for the Android first-run contrast),
 * }
 */
function boot(opts = {}) {
  const calls = {
    confirm: [], requestPermissions: 0, settingsReads: 0, pushReads: 0,
    sheets: 0, pushKicks: 0, errors: [],
  };
  const storage = opts.storage || new Map();
  const permissions = opts.permissions === undefined
    ? { ...IOS, notificationPermission: 'notDetermined' }
    : opts.permissions;
  const capabilities = opts.capabilities ||
    ['getSettingsState', 'getSocialPushState', 'requestPermissions'];
  let tap = null;
  const sandbox = {
    console: { log() {}, warn() {}, error(...args) { calls.errors.push(args); } },
    crypto: webcrypto,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    App: { user: null },
    unNative: opts.kit === undefined ? { platform: 'ios', toast() {} } : opts.kit,
    PlatformUI: {
      hasKit() { return opts.hasKit !== false; },
      confirm(o) {
        calls.confirm.push(o);
        if (opts.answer === 'manual') return new Promise((resolve) => { tap = resolve; });
        return Promise.resolve(opts.answer !== 'not-now');
      },
      sheet() { calls.sheets += 1; return { dismiss() {} }; },
    },
    SocialPush: { getState() { calls.pushKicks += 1; } },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    document: {
      visibilityState: 'visible',
      getElementById() { return null; },
      createElement(tag) { return fakeNode(tag); },
      addEventListener() {},
      removeEventListener() {},
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    // Real, REF'D timers: the grant settle polls on one, and an unref'd
    // timer lets node end the event loop under a pending await (the note in
    // tests/first-run-permissions-ios-prompt.test.js).
    setTimeout,
    clearTimeout,
    setInterval() { return 0; },
    async fetch(url, init) {
      if (url === '/challenges-api/bp/state') {
        return { ok: true, async json() {
          return { success: true, data: opts.bp || { bp_requested: true, bp_released: false } };
        } };
      }
      if (url === '/api/v4/mobile/auth/native-establish-handoff') {
        const body = JSON.parse(init.body);
        return { ok: true, async json() {
          return { success: true, data: {
            protocol: 2, attemptId: body.attemptId, desiredRuntime: 'running',
          } };
        } };
      }
      throw new Error('unexpected fetch ' + url);
    },
  };
  sandbox.usernode = opts.native === false ? { isNative: false } : {
    isNative: true,
    async getBridgeInfo() {
      return { version: 5, sessionLifecycleProtocol: 2, capabilities };
    },
    async getSettingsState() {
      calls.settingsReads += 1;
      return permissions ? { permissions } : null;
    },
    async getSocialPushState() {
      calls.pushReads += 1;
      return opts.pushState === undefined ? null : opts.pushState;
    },
    async requestPermissions() {
      calls.requestPermissions += 1;
      return opts.requestResult || {
        granted: true,
        permissions: { ...permissions, notificationPermission: 'authorized' },
      };
    },
    async establishNativeSession() {
      return { identity: { participantId: String(sandbox.App.user.id) } };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  sandbox.NativeChrome._FIRST_RUN_RECHECK_MS = 1;
  return {
    sandbox,
    calls,
    storage,
    NativeChrome: sandbox.NativeChrome,
    tap(answer) { tap(answer); },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// ── 1. The rule ────────────────────────────────────────────────────────

test('decidePingAsk: native iOS, undetermined, and nothing else', () => {
  const { NativeChrome } = boot();
  const decide = (over) => NativeChrome.decidePingAsk({
    isNative: true, hasRequestMethod: true, platform: 'ios', supported: true,
    notificationPermission: 'notDetermined', pushStatus: null, promptedBefore: false,
    ...over,
  }).verdict;

  assert.equal(decide({}), 'ask');
  assert.equal(decide({ isNative: false }), 'skip', 'a browser has no OS prompt to offer');
  assert.equal(decide({ hasRequestMethod: false }), 'skip');
  assert.equal(decide({ platform: 'android' }), 'skip',
    'Android: requestPermissions() is the alarm permission there, and the '
    + '"Set up your device" sheet already asks for notifications');
  assert.equal(decide({ platform: null }), 'skip', 'an unknown platform is not iOS');
  assert.equal(decide({ supported: false }), 'skip',
    'a build that positively lacks requestPermissions');
  assert.equal(decide({ supported: null }), 'ask',
    'an inconclusive probe is not "unsupported" (#978)');
  assert.equal(NativeChrome.decidePingAsk({}).verdict, 'skip',
    'an empty state is a skip, never a throw');
  assert.equal(NativeChrome.decidePingAsk().verdict, 'skip');
});

test('decidePingAsk: a determined permission is never asked for', () => {
  const { NativeChrome } = boot();
  const decide = (notificationPermission, extra = {}) => NativeChrome.decidePingAsk({
    isNative: true, hasRequestMethod: true, platform: 'ios', supported: true,
    notificationPermission, ...extra,
  });
  for (const spelling of ['notDetermined', 'not_determined', 'undetermined']) {
    assert.equal(decide(spelling).verdict, 'ask', spelling);
  }
  const denied = decide('denied');
  assert.equal(denied.verdict, 'skip',
    'iOS shows no prompt once denied, so "Notify me" would do nothing; the '
    + 'Settings row is the way back');
  assert.match(denied.reason, /denied/);
  assert.equal(decide('authorized').verdict, 'skip', 'already allowed');
  assert.equal(decide('provisional').verdict, 'skip', 'quietly allowed is allowed');
  // The snapshot's own read is authoritative: it beats the push state and
  // the once-per-device marker in both directions.
  assert.equal(decide('denied', { pushStatus: 'undetermined' }).verdict, 'skip');
  assert.equal(decide('notDetermined', { pushStatus: 'denied', promptedBefore: true }).verdict,
    'ask');
});

test('decidePingAsk: an older build\'s push status is trusted once per device', () => {
  const { NativeChrome } = boot();
  const decide = (pushStatus, promptedBefore) => NativeChrome.decidePingAsk({
    isNative: true, hasRequestMethod: true, platform: 'ios', supported: true,
    notificationPermission: undefined, pushStatus, promptedBefore,
  }).verdict;
  assert.equal(decide('undetermined', false), 'ask');
  assert.equal(decide('undetermined', true), 'skip',
    'a build without push configured says "not determined" forever: after '
    + 'one ask on this device it cannot be believed');
  assert.equal(decide('denied', false), 'skip');
  assert.equal(decide('granted', false), 'skip');
  assert.equal(decide(null, false), 'skip',
    'no readable status: show nothing rather than a button that may do nothing');
});

// ── 2. The ask ─────────────────────────────────────────────────────────

test('iOS, undetermined: the in-app question appears, and the OS prompt '
  + 'waits for "Notify me"', async () => {
  const h = boot({ answer: 'manual' });
  const asking = h.NativeChrome.askForPing({ reason: 'app-building' });
  for (let i = 0; i < 20 && h.calls.confirm.length === 0; i++) await settle();

  assert.equal(h.calls.confirm.length, 1, 'the question is on screen');
  const ask = h.calls.confirm[0];
  assert.equal(ask.title, 'Get a ping when your app is ready?');
  assert.equal(ask.confirmLabel, 'Notify me');
  assert.equal(ask.cancelLabel, 'Not now');
  assert.ok(!/—/.test(JSON.stringify(ask)), 'no em dash in the copy');
  assert.equal(h.calls.requestPermissions, 0,
    'nothing has asked the OS while the person is still reading');

  h.tap(true);
  const result = await asking;
  assert.equal(h.calls.requestPermissions, 1, 'the tap, and only the tap, asks the OS');
  assert.equal(result.outcome, 'notify');
  assert.equal(result.granted, true);
  assert.equal(h.calls.pushKicks, 1, 'a grant starts push registration now');
  assert.equal(h.storage.get(PROMPTED), '1', 'the device records that it was asked');
});

test('"Not now" asks the OS nothing, and is not asked again this session', async () => {
  const h = boot({ answer: 'not-now' });
  const first = await h.NativeChrome.askForPing({ reason: 'app-building' });
  assert.equal(first.outcome, 'not-now');
  assert.equal(h.calls.requestPermissions, 0);
  assert.equal(h.storage.get(PROMPTED), undefined,
    'a decline in our own question leaves the OS prompt unspent');

  const second = await h.NativeChrome.askForPing({ reason: 'app-building' });
  assert.equal(second.shown, false);
  assert.equal(h.calls.confirm.length, 1, 'a second app in the same sitting is no new reason');
});

test('denied or already allowed: nothing appears, nothing is requested', async () => {
  for (const notificationPermission of ['denied', 'authorized']) {
    const h = boot({ permissions: { ...IOS, notificationPermission } });
    const result = await h.NativeChrome.askForPing({ reason: 'app-building' });
    assert.equal(result.shown, false, notificationPermission);
    assert.equal(h.calls.confirm.length, 0, `${notificationPermission}: no question`);
    assert.equal(h.calls.requestPermissions, 0, `${notificationPermission}: no OS prompt`);
  }
});

test('outside the app, and on Android, nothing appears and nothing is read', async () => {
  const browser = boot({ native: false });
  assert.equal((await browser.NativeChrome.askForPing({ reason: 'app-building' })).shown, false);
  assert.equal(browser.calls.confirm.length, 0);

  const android = boot({
    kit: { platform: 'android', toast() {} },
    permissions: { ...ANDROID, notificationPermission: 'notDetermined' },
  });
  assert.equal((await android.NativeChrome.askForPing({ reason: 'app-building' })).shown, false);
  assert.equal(android.calls.confirm.length, 0);
  assert.equal(android.calls.requestPermissions, 0,
    'requestPermissions() is the exact-alarm page on Android');
  assert.equal(android.calls.settingsReads, 0, 'the kit already said no');

  // A kit that cannot tell: the snapshot's own platform decides.
  const unsure = boot({
    kit: { platform: 'desktop', toast() {} },
    permissions: { ...ANDROID, notificationPermission: 'notDetermined' },
  });
  assert.equal((await unsure.NativeChrome.askForPing({ reason: 'app-building' })).shown, false);
  assert.equal(unsure.calls.confirm.length, 0);
});

test('an older build: the push status decides, once per device', async () => {
  const storage = new Map();
  const older = { ...IOS }; // no notificationPermission field
  const pushState = { enabled: false, permissionStatus: 'notDetermined',
    registrationStatus: 'unregistered', deliveryActive: false };
  const first = boot({ storage, permissions: older, pushState,
    requestResult: { granted: false, permissions: older } });
  const result = await first.NativeChrome.askForPing({ reason: 'app-building' });
  assert.equal(result.shown, true);
  assert.equal(first.calls.requestPermissions, 1);

  // Same device, next document: this build still says "not determined",
  // which it would say forever without push configured.
  const again = boot({ storage, permissions: older, pushState });
  assert.equal((await again.NativeChrome.askForPing({ reason: 'app-building' })).shown, false);
  assert.equal(again.calls.confirm.length, 0);

  // A build that reports the real permission is believed whatever the
  // marker says.
  const newer = boot({ storage, permissions: { ...IOS, notificationPermission: 'notDetermined' } });
  assert.equal((await newer.NativeChrome.askForPing({ reason: 'app-building' })).shown, true);
});

test('an unreadable permission shows nothing', async () => {
  const unreadable = boot({ permissions: null, pushState: null });
  assert.equal((await unreadable.NativeChrome.askForPing({ reason: 'app-building' })).shown, false);
  assert.equal(unreadable.calls.confirm.length, 0);

  const noPush = boot({ permissions: { ...IOS }, capabilities: ['getSettingsState', 'requestPermissions'] });
  assert.equal((await noPush.NativeChrome.askForPing({ reason: 'app-building' })).shown, false);
});

test('no kit, no question: never the browser\'s own confirm()', async () => {
  const h = boot({ hasKit: false });
  assert.equal((await h.NativeChrome.askForPing({ reason: 'app-building' })).shown, false);
  assert.equal(h.calls.confirm.length, 0);
  assert.equal(h.calls.requestPermissions, 0);
});

test('an unknown reason asks nothing, and a failed request never throws', async () => {
  const h = boot();
  const unknown = await h.NativeChrome.askForPing({ reason: 'whatever' });
  assert.equal(unknown.shown, false);
  assert.equal(h.calls.confirm.length, 0);

  const failing = boot();
  failing.sandbox.usernode.requestPermissions = async () => {
    throw new Error('requestPermissions is not supported by this app build');
  };
  const result = await failing.NativeChrome.askForPing({ reason: 'app-building' });
  assert.equal(result.outcome, 'notify');
  assert.equal(result.granted, false);
  assert.deepEqual(failing.calls.errors, [], 'console.warn at most: a console.error fails proposal checks');
});

test('how the ask is answered is measured: allowed, refused, "Not now", or failed', async () => {
  const answered = async (opts, prepare) => {
    const h = boot(opts);
    const seen = [];
    h.sandbox.UITelemetry = {
      attempt(action, detail) { seen.push(['attempt', action, detail.screen]); return 'a1'; },
      outcome(id, outcome, detail) { seen.push(['outcome', id, outcome, (detail && detail.errorCode) || null]); return true; },
    };
    if (prepare) prepare(h);
    await h.NativeChrome.askForPing({ reason: 'app-building' });
    return seen;
  };
  const asked = ['attempt', 'push_permission', 'ping_ask'];
  assert.deepEqual(await answered({}), [asked, ['outcome', 'a1', 'success', null]]);
  assert.deepEqual(await answered({ answer: 'not-now' }), [asked, ['outcome', 'a1', 'cancelled', null]]);
  assert.deepEqual(await answered({
    requestResult: { granted: false, permissions: { ...IOS, notificationPermission: 'denied' } },
  }), [asked, ['outcome', 'a1', 'failure', 'access_denied']]);
  assert.deepEqual(await answered({}, (h) => {
    h.sandbox.usernode.requestPermissions = async () => { throw new Error('not supported'); };
  }), [asked, ['outcome', 'a1', 'failure', 'unknown']]);
  assert.deepEqual(await answered({ permissions: { ...IOS, notificationPermission: 'denied' } }), [],
    'nothing is measured when nothing is asked');
});

// ── 3. Nothing happens on mount ────────────────────────────────────────

test('loading the shell asks nothing', async () => {
  const h = boot();
  await settle();
  assert.equal(h.calls.confirm.length, 0);
  assert.equal(h.calls.requestPermissions, 0);
  assert.equal(h.calls.sheets, 0);
});

test('iOS: session setup no longer opens the "Set up your device" sheet', async () => {
  const h = boot({ capabilities: [
    'getSettingsState', 'getSocialPushState', 'requestPermissions', 'establishNativeSession',
  ] });
  h.sandbox.App.user = { id: 41 };
  const result = await h.NativeChrome.establishCurrentSession();
  assert.ok(result, 'the native session was established');
  if (h.NativeChrome._firstRunPromise) await h.NativeChrome._firstRunPromise;
  await settle();
  assert.equal(h.calls.sheets, 0, 'no sheet on the first screen of a fresh install');
  assert.equal(h.calls.confirm.length, 0, 'and no stand-in question either');
  assert.equal(h.calls.requestPermissions, 0, 'the OS prompt stays unspent');
  assert.equal(h.calls.settingsReads, 0, 'nothing is even read to decide that');

  // The contrast that proves the trigger ran: Android still gets its sheet.
  const android = boot({
    kit: { platform: 'android', toast() {} },
    capabilities: ['getSettingsState', 'establishNativeSession'],
    permissions: ANDROID,
  });
  android.sandbox.App.user = { id: 41 };
  await android.NativeChrome.establishCurrentSession();
  if (android.NativeChrome._firstRunPromise) await android.NativeChrome._firstRunPromise;
  await settle();
  assert.equal(android.calls.sheets, 1, 'Android session setup is unchanged');
});

test('rendering the progress view asks nothing', () => {
  let asked = 0;
  const previous = globalThis.window;
  globalThis.window = { NativeChrome: { askForPing() { asked += 1; return Promise.resolve(); } } };
  try {
    const { CreateProgress } = loadTsx('frontend/src/features/dialogs/create-progress.tsx');
    for (const status of ['creating', 'running', 'error']) {
      renderToHtml(createElement(CreateProgress, {
        appName: 'Plant Pal',
        mode: 'new',
        surface: 'pane',
        progress: { slug: 'plant-pal', status, phase: null, url: null,
          errorReason: null, missingSecrets: null },
        openLabel: 'Open my chat with Homeroom bot',
        onOpenApp() {}, onRetry() {}, onSetSecrets() {}, onClose() {},
      }));
    }
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
  assert.equal(asked, 0, 'the ask belongs to the Create answer, not to a render');
});

// ── 4. The call site: the made screen ──────────────────────────────────
//
// The create dialog that asked right after its POST is retired. Every new
// project, from the first session and from Create, lands on the made screen
// (frontend/src/features/first-session/made.tsx), drawn the moment POST
// /api/apps answers, and that screen asks for a project the bot builds.

test('the made screen asks once, for a project the Homeroom bot is building', () => {
  const src = read('frontend', 'src', 'features', 'first-session', 'made.tsx');
  assert.equal(src.split('askForPingWhileBotBuilds(').length - 1, 1, 'exactly one call site');
  // botBuilds is the POST's answer: the bot's chat, which it has only when it builds.
  assert.match(src, /const botBuilds = made\.conversationId != null;/);
  assert.match(src, /useEffect\(\(\) => \{ if \(botBuilds\) askForPingWhileBotBuilds\(\); \}, \[botBuilds\]\);/,
    'once per made screen, and only when the bot builds it (D10)');
  assert.equal(require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'frontend/src/features/dialogs/create-app.tsx')), false,
    'the retired dialog is not a second call site');
});

test('the door passes a reason native-chrome.js has copy for, and never throws', async () => {
  const { askForPingWhileBotBuilds, PING_ASK_REASON } =
    loadTsx('frontend/src/features/dialogs/ping-ask.ts');
  const { NativeChrome } = boot();
  assert.ok(Object.hasOwn(NativeChrome._PING_ASK_COPY, PING_ASK_REASON),
    `"${PING_ASK_REASON}" is a key of _PING_ASK_COPY`);

  const previous = globalThis.window;
  const warn = console.warn;
  const seen = [];
  console.warn = () => {};
  try {
    globalThis.window = { NativeChrome: { askForPing(o) { seen.push(o); return Promise.resolve(); } } };
    askForPingWhileBotBuilds();
    assert.deepEqual(seen, [{ reason: PING_ASK_REASON }]);

    globalThis.window = { NativeChrome: { askForPing() { throw new Error('boom'); } } };
    assert.doesNotThrow(() => askForPingWhileBotBuilds());
    globalThis.window = { NativeChrome: { askForPing() { return Promise.reject(new Error('boom')); } } };
    assert.doesNotThrow(() => askForPingWhileBotBuilds());
    globalThis.window = {};
    assert.doesNotThrow(() => askForPingWhileBotBuilds(), 'an old bundle without the method');
    await settle();
  } finally {
    console.warn = warn;
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
