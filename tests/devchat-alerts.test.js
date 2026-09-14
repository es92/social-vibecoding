// Tests for the #138 dev-chat completion alerts (chime + OS notification).
//
// Two layers:
//   1. Behavioral — load public/js/dev-alerts.js in a vm sandbox with faked
//      browser globals (window/document/localStorage/AudioContext/
//      Notification/Homeroom) and exercise the real DevAlerts API: the
//      visible→tone / hidden→notify decision, the native vs browser
//      systemNotify branches, the localStorage mute gate, and the tone
//      dedup guard.
//   2. Static wiring — assert the call sites in notifications.js / dev-chat.js
//      / settings.js / index.html exist so the feature can't silently
//      unwire.
//
// Run with: node --test tests/devchat-alerts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { shellMarkup } = require('./lib/shell-markup');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (...p) => fs.readFileSync(path.join(PUBLIC, ...p), 'utf8');
const DEV_ALERTS_SRC = read('js', 'dev-alerts.js');
// #1079 chunk B moved this module into the React bundle (it is the same
// file — see the note at the top of it); only the path changed here.
// #1808: notifications.js has one bundle import now (`agoStamp` from
// lib/timestamp.ts, which gave the rows a stamp with a floor). This harness
// evaluates the shipped source raw in a vm, so it stands in for the bundler:
// the import statement is dropped and the REAL helper is put in the sandbox
// under the same name, so a row's stamp is the one that ships.
const { agoStamp } = require('./lib/render-tsx').loadTsx('frontend/src/lib/timestamp.ts');
const NOTIF_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications.js'), 'utf8')
  .replace(/^import \{ agoStamp \}.*$/m, '');

// Minimal fake DOM element tracking class list, text and attributes for the
// badge tests.
class FakeEl {
  constructor() {
    this.textContent = '';
    this.disabled = false;
    this.dataset = {};
    this.attributes = {};
    this._cls = new Set(['hidden']);
    const self = this;
    this.classList = {
      add: (c) => self._cls.add(c),
      remove: (c) => self._cls.delete(c),
      contains: (c) => self._cls.has(c),
      toggle: () => {},
    };
  }
  get hidden() { return this._cls.has('hidden'); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name] : null;
  }
}

// Load notifications.js in a sandbox and return its Notifications object plus
// the fake bell elements, so _renderBadge's single count can be asserted.
function makeNotifEnv() {
  const elements = {};
  const getEl = (id) => (elements[id] || (elements[id] = new FakeEl()));
  const sandbox = { console, Date, JSON, Math, Set, Map };
  sandbox.window = sandbox;
  // #1610 retired Improve.setSessionBadge along with the split it fed. The
  // controller is still exposed so a stray call would be visible rather than
  // throwing silently past this env; nothing should reach for it.
  sandbox.Improve = {};
  sandbox.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  sandbox.document = {
    title: 'My App',
    getElementById: getEl,
    addEventListener: () => {},
    createElement: () => ({ set textContent(v) { this._t = v; }, get innerHTML() { return this._t || ''; } }),
  };
  sandbox.agoStamp = agoStamp;
  vm.runInNewContext(NOTIF_SRC, sandbox);
  return { Notifications: sandbox.window.Notifications, elements };
}

// Build a fresh sandbox + DevAlerts instance with configurable environment.
function makeEnv({
  visibility = 'visible',
  isNative = false,
  permission = 'granted',
  audioRunning = true,
  enabled = true,
  fetchResponse = { ok: true, queued: true, delayMs: 10000 },
} = {}) {
  const store = {};
  if (enabled === false) store.devchat_alerts_enabled = '0';

  const calls = { oscillators: 0, expRamps: 0, notifications: [], bridge: [], permissionRequests: 0, timers: [], requests: [] };

  class FakeParam {
    setValueAtTime() {} linearRampToValueAtTime() {}
    exponentialRampToValueAtTime() { calls.expRamps += 1; }
  }
  class FakeNode {
    constructor() { this.gain = new FakeParam(); this.frequency = {}; }
    connect() { return new FakeNode(); }
    start() {} stop() {}
  }
  class FakeAudioContext {
    constructor() { this.state = audioRunning ? 'running' : 'suspended'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() { calls.oscillators += 1; return new FakeNode(); }
    createGain() { return new FakeNode(); }
  }

  const sandbox = { Promise, Date, JSON, Math, console,
    setTimeout: (fn, delay) => calls.timers.push({ fn, delay }),
    fetch: async (url, options) => {
      calls.requests.push({ url, options });
      return { ok: fetchResponse.ok, json: async () => fetchResponse };
    },
  };
  sandbox.window = sandbox;
  sandbox.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  sandbox.document = { get visibilityState() { return visibility; } };
  sandbox.AudioContext = FakeAudioContext;
  sandbox.usernode = { isNative };
  sandbox.Usernode = { postMessage: (s) => calls.bridge.push(s) };
  sandbox.Notification = function Notification(title, opts) {
    calls.notifications.push({ title, opts });
  };
  sandbox.Notification.permission = permission;
  sandbox.Notification.requestPermission = () => { calls.permissionRequests += 1; return Promise.resolve(permission); };

  vm.runInNewContext(DEV_ALERTS_SRC, sandbox);
  return { DevAlerts: sandbox.window.DevAlerts, calls, store };
}

// ── decision: visible → tone, hidden → systemNotify ──────────────────────

test('onCompletion plays the tone (not a notification) when the app is visible', () => {
  const { DevAlerts } = makeEnv({ visibility: 'visible' });
  let tone = 0; let notif = 0;
  DevAlerts.playDoneTone = () => { tone += 1; };
  DevAlerts.systemNotify = () => { notif += 1; };
  DevAlerts.onCompletion({ kind: 'session_done' });
  assert.equal(tone, 1);
  assert.equal(notif, 0);
});

test('onCompletion fires a system notification (not a tone) when the app is hidden', () => {
  const { DevAlerts } = makeEnv({ visibility: 'hidden' });
  let tone = 0; let notif = 0;
  DevAlerts.playDoneTone = () => { tone += 1; };
  DevAlerts.systemNotify = () => { notif += 1; };
  DevAlerts.onCompletion({ kind: 'auto_solve_done' });
  assert.equal(tone, 0);
  assert.equal(notif, 1);
});

test('onCompletion does nothing when the preference is disabled', () => {
  for (const visibility of ['visible', 'hidden']) {
    const { DevAlerts } = makeEnv({ visibility, enabled: false });
    let tone = 0; let notif = 0;
    DevAlerts.playDoneTone = () => { tone += 1; };
    DevAlerts.systemNotify = () => { notif += 1; };
    DevAlerts.onCompletion({ kind: 'session_done' });
    assert.equal(tone, 0, `no tone when disabled (${visibility})`);
    assert.equal(notif, 0, `no notification when disabled (${visibility})`);
  }
});

// ── systemNotify: native vs browser ──────────────────────────────────────

test('systemNotify (native) posts a well-formed notify message over the bridge', () => {
  const { DevAlerts, calls } = makeEnv({ isNative: true });
  DevAlerts.systemNotify({
    kind: 'auto_solve_done', appSlug: 'demo', headlessIssueNumber: 7,
    title: 'Proposal ready', body: 'all done',
  });
  assert.equal(calls.bridge.length, 1);
  const msg = JSON.parse(calls.bridge[0]);
  assert.equal(msg.method, 'notify');
  assert.equal(msg.title, 'Proposal ready');
  assert.equal(msg.body, 'all done');
  assert.equal(msg.route, '#app/demo/dev/issues/7');
  // Native path must not also construct a browser Notification.
  assert.equal(calls.notifications.length, 0);
});

test('active remote delivery suppresses only the duplicate native bridge alert', () => {
  const { DevAlerts, calls } = makeEnv({ isNative: true });
  const info = {
    kind: 'session_done', appSlug: 'demo', sessionId: 9,
    title: 'Session ready', body: 'all done',
  };

  DevAlerts.setRemoteDeliveryActive(true);
  DevAlerts.systemNotify(info);
  assert.equal(calls.bridge.length, 0);

  DevAlerts.setRemoteDeliveryActive(false);
  DevAlerts.systemNotify(info);
  assert.equal(calls.bridge.length, 1);
});

test('systemNotify (browser) constructs a Notification only when permission is granted', () => {
  const granted = makeEnv({ isNative: false, permission: 'granted' });
  granted.DevAlerts.systemNotify({ kind: 'session_done', title: 'Dev session finished', body: 'x', sessionId: 5 });
  assert.equal(granted.calls.notifications.length, 1);
  assert.equal(granted.calls.notifications[0].title, 'Dev session finished');
  assert.equal(granted.calls.bridge.length, 0, 'browser path must not post to the bridge');

  const denied = makeEnv({ isNative: false, permission: 'denied' });
  denied.DevAlerts.systemNotify({ kind: 'session_done', title: 'Dev session finished', body: 'x' });
  assert.equal(denied.calls.notifications.length, 0, 'no Notification when permission denied');
});

// ── mute pref round-trips localStorage and gates the channels ────────────

test('the mute preference round-trips through localStorage (default ON)', () => {
  const { DevAlerts, store } = makeEnv();
  assert.equal(DevAlerts.enabled(), true, 'absent key → enabled');
  DevAlerts.setEnabled(false);
  assert.equal(store.devchat_alerts_enabled, '0');
  assert.equal(DevAlerts.enabled(), false);
  DevAlerts.setEnabled(true);
  assert.equal(store.devchat_alerts_enabled, '1');
  assert.equal(DevAlerts.enabled(), true);
});

test('playDoneTone is gated by the preference and never throws when disabled', () => {
  const { DevAlerts, calls } = makeEnv({ enabled: false, audioRunning: true });
  DevAlerts._unlockAudio();
  DevAlerts.playDoneTone();
  assert.equal(calls.oscillators, 0, 'disabled → silent');
});

// ── tone synthesis + dedup ───────────────────────────────────────────────

test('playDoneTone synthesizes the bell chime once unlocked, and dedups rapid repeats', () => {
  const { DevAlerts, calls } = makeEnv({ audioRunning: true });
  // Locked context: no oscillators yet (context not unlocked → state check).
  // (FakeAudioContext starts 'running' here, but DevAlerts only builds its
  // context inside _unlockAudio.)
  DevAlerts.playDoneTone();
  assert.equal(calls.oscillators, 0, 'no audio before _unlockAudio creates the context');

  DevAlerts._unlockAudio();
  DevAlerts.playDoneTone();
  // Bell timbre = a fundamental + inharmonic partials → multiple oscillators,
  // each with an exponential decay ramp (the ring-out).
  assert.ok(calls.oscillators >= 2, 'bell chime layers multiple partials/oscillators');
  assert.ok(calls.expRamps >= calls.oscillators, 'each partial uses an exponential decay envelope');

  // Immediate second call is suppressed by the dedup guard.
  const oscAfterFirst = calls.oscillators;
  DevAlerts.playDoneTone();
  assert.equal(calls.oscillators, oscAfterFirst, 'rapid repeat deduped within the guard window');
});

test('playDoneTone stays silent while the audio context is still suspended', () => {
  const { DevAlerts, calls } = makeEnv({ audioRunning: false });
  // _unlockAudio resolves resume() async; our fake flips to running only on
  // resume(). Simulate the not-yet-resumed state by checking before resume
  // completes is impractical here, so assert the guard: a suspended context
  // produces no audio. Force suspended by not unlocking.
  DevAlerts.playDoneTone();
  assert.equal(calls.oscillators, 0);
});

// ── static wiring assertions ─────────────────────────────────────────────

test('notifications.js routes completions through DevAlerts.onCompletion', () => {
  const src = NOTIF_SRC;
  assert.match(src, /DevAlerts\.onCompletion\(completionAlertInfo\(notif\)\)/);
  assert.match(src, /function completionAlertInfo\(n\)/);
  // Both completion kinds are covered.
  assert.match(src, /session_done/);
  assert.match(src, /auto_solve_done/);
});

test('dev-chat.js no longer plays the tone directly (chime is arrival-driven)', () => {
  // #1084 chunk G moved this module into the React bundle (same file, new
  // path — see the note at the top of it); only the path changed here.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'), 'utf8',
  );
  // #138: the redundant foreground-tone hook is removed — the chime is now
  // fired solely from Notifications.handleIncoming → DevAlerts.onCompletion
  // on the WS notification's arrival. dev-chat.js must not call playDoneTone.
  assert.doesNotMatch(src, /playDoneTone/, 'dev-chat.js must not ring the chime directly');
  // sendMessage still unlocks audio + requests permission (user gesture).
  assert.match(src, /DevAlerts\._unlockAudio\(\)/);
  assert.match(src, /DevAlerts\.requestNotifyPermission\(\)/);
});

test('DevAlerts.TEST_DELAY_MS is a whole number of seconds (clean countdown)', () => {
  const { DevAlerts } = makeEnv();
  assert.equal(typeof DevAlerts.TEST_DELAY_MS, 'number');
  assert.equal(DevAlerts.TEST_DELAY_MS % 1000, 0, 'delay must be an integer number of seconds');
});

test('settings.js runs a ticking countdown for the test-alert button', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'settings.js'), 'utf8');
  // A real interval that rewrites the status text each second, plus cleanup.
  assert.match(src, /setInterval\(/);
  assert.match(src, /_clearAlertsTestCountdown/);
  assert.match(src, /Alert in \$\{remaining\}s/);
  // Cleared on modal close so a countdown can't outlive the panel.
  const close = src.slice(src.indexOf('close() {'), src.indexOf('close() {') + 300);
  assert.match(close, /_clearAlertsTestCountdown\(\)/);
});

test('settings.js wires the toggle and the test-alert button', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'settings.js'), 'utf8');
  assert.match(src, /devchat-alerts-toggle/);
  assert.match(src, /DevAlerts\.setEnabled\(/);
  assert.match(src, /devchat-alerts-test/);
  assert.match(src, /DevAlerts\.testAlert\(\)/);
});

// ── one bell, one count (#1610) ──────────────────────────────────────────

test('every unread kind lands on the bell, sessions included', () => {
  const { Notifications, elements } = makeNotifEnv();
  Notifications.items = [
    { id: 1, kind: 'session_done', readAt: null },
    { id: 2, kind: 'auto_solve_done', readAt: null },
    { id: 3, kind: 'mention', readAt: null },
    { id: 4, kind: 'kudos', readAt: '2020-01-01T00:00:00Z' }, // read → ignored
  ];
  Notifications.unread = 3; // the three unread above
  Notifications.invites = [{ appId: 9 }];
  Notifications._renderBadge();

  const bell = elements['notifications-badge'];
  // 3 unread + 1 pending invite. Nothing is subtracted: the split that used
  // to take the session kinds out of this number put them on a control that
  // could not clear them, which is the bug #1610 fixed.
  assert.equal(bell.textContent, '4', 'bell = every unread + invites');
  assert.equal(bell.hidden, false);
  assert.equal(Number(bell.textContent), Notifications.unread + Notifications.invites.length);
  // The session_done subset rides along as an attribute so a declared check
  // can prove the badge is up BECAUSE work finished.
  assert.equal(bell.attributes['data-session-done'], '1');
});

test('nothing is published to the Improve button any more', () => {
  const { Notifications, elements } = makeNotifEnv();
  Notifications.items = [{ id: 1, kind: 'session_done', readAt: null }];
  Notifications.unread = 1;
  Notifications.invites = [];
  Notifications._renderBadge();
  // A finished session raises the BELL, alone.
  assert.equal(elements['notifications-badge'].textContent, '1');
  assert.equal(elements['notifications-badge'].hidden, false);
  assert.ok(!('notifications-badge-ai' in elements),
    'the retired green badge must not be resolved by id');
  assert.ok(!/window\.Improve\.setSessionBadge/.test(NOTIF_SRC),
    'the publish onto #improve-btn is gone from the module');
});

test('the bell count falls to zero and hides', () => {
  const { Notifications, elements } = makeNotifEnv();
  Notifications.items = [{ id: 1, kind: 'session_done', readAt: '2020-01-01T00:00:00Z' }];
  Notifications.unread = 0;
  Notifications.invites = [];
  Notifications._renderBadge();
  assert.equal(elements['notifications-badge'].hidden, true);
  assert.equal(elements['notifications-badge'].attributes['data-session-done'], '0');
});

test('dev-alerts.js still loads before notifications, and index.html ships the settings UI', () => {
  const html = shellMarkup();
  // #1079 chunk B moved notifications.js into the React bundle, so this is no
  // longer two classic tags to order. The guarantee got STRONGER rather than
  // weaker: /shell/assets/shell.js is a module (deferred), so everything it
  // imports runs after every classic /js/** tag has executed. What still has to
  // hold is that dev-alerts.js is one of those classic tags — if it ever moved
  // into the bundle too, the relative order would stop being decided for us.
  const alertsIdx = html.indexOf('src="/js/dev-alerts.js"');
  const bundleIdx = html.indexOf('src="/shell/assets/shell.js"');
  assert.ok(alertsIdx > 0, 'dev-alerts.js script tag present');
  assert.ok(bundleIdx > 0, 'the React shell bundle is what carries notifications.js now');
  assert.ok(!html.includes('src="/js/notifications.js"'),
    'a surviving classic tag would load a second copy of the module');
  assert.match(html, /id="devchat-alerts-toggle"/);
  assert.match(html, /id="devchat-alerts-test"/);
  // #1610: the completed-task count is the bell's, and the Improve button
  // keeps only a live working pulse.
  assert.match(html, /id="notifications-badge"[^>]*data-session-done="0"/);
  assert.ok(!html.includes('id="notifications-badge-ai"'),
    'the green count on #improve-btn is retired');
});

test('test alert queues on the server before the optional foreground chime', async () => {
  const { DevAlerts, calls } = makeEnv();
  const result = await DevAlerts.testAlert();
  assert.equal(result.queued, true);
  assert.equal(calls.requests[0].url, '/api/me/test-alert');
  assert.equal(calls.requests[0].options.method, 'POST');
  assert.equal(calls.requests[0].options.credentials, 'same-origin');
  assert.equal(calls.timers[0].delay, 10000);
  assert.equal(calls.oscillators, 0);
  calls.timers[0].fn();
  assert.ok(calls.oscillators > 0);
});

test('native background tests never post duplicate local alerts, with remote state on or off', async () => {
  for (const active of [true, false]) {
    const { DevAlerts, calls } = makeEnv({ isNative: true, visibility: 'hidden' });
    DevAlerts.setRemoteDeliveryActive(active);
    await DevAlerts.testAlert();
    calls.timers[0].fn();
    assert.equal(calls.requests.length, 1);
    assert.equal(calls.bridge.length, 0);
    assert.equal(calls.oscillators, 0);
  }
});

test('a live background browser still previews the alert without an eligible phone', async () => {
  const { DevAlerts, calls } = makeEnv({ visibility: 'hidden',
    fetchResponse: { ok: true, queued: false, reason: 'no_eligible_device', delayMs: 10000 } });
  const result = await DevAlerts.testAlert();
  assert.equal(result.queued, false);
  calls.timers[0].fn();
  assert.equal(calls.notifications[0].title, 'Homeroom test alert');
  assert.equal(DevAlerts._routeFor({ kind: 'test_alert' }), '#settings/alerts');
});

test('queue errors reject without scheduling a success preview', async () => {
  const { DevAlerts, calls } = makeEnv({ fetchResponse: { ok: false, error: 'Please wait a minute' } });
  await assert.rejects(DevAlerts.testAlert(), /Please wait a minute/);
  assert.equal(calls.timers.length, 0);
});

test('settings reports queue outcomes and never turns a countdown into a delivery claim', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/features/settings/settings.js'), 'utf8');
  const start = src.indexOf("      const alertsTest = document.getElementById('devchat-alerts-test');");
  const end = src.indexOf('// Account-level remote-push categories', start);
  for (const [result, expected] of [
    [{ queued: true, delayMs: 10000 }, /queued for delivery/],
    [{ queued: false, reason: 'preference_disabled', delayMs: 10000 }, /Enable Developer sessions/],
    [{ queued: false, reason: 'no_eligible_device', delayMs: 10000 }, /Sign in on your phone/],
    [new Error('Please wait a minute'), /Please wait a minute/],
  ]) {
    const button = new FakeEl();
    const status = new FakeEl();
    let handler;
    let tick;
    button.addEventListener = (_event, fn) => { handler = fn; };
    const sandbox = {
      document: { getElementById: (id) => id === 'devchat-alerts-test' ? button : status },
      DevAlerts: { testAlert: async () => { if (result instanceof Error) throw result; return result; } },
      setInterval: (fn) => { tick = fn; return 1; },
      _clearAlertsTestCountdown() {},
    };
    sandbox.window = sandbox;
    vm.runInNewContext(src.slice(start, end), sandbox);
    await handler();
    if (tick) for (let i = 0; i < 10; i += 1) tick();
    assert.match(status.textContent, expected);
    assert.doesNotMatch(status.textContent, /Sent\.|successfully delivered/i);
    assert.equal(button.disabled, false);
  }
});
