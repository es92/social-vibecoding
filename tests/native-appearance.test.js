// The cold-launch white flash, and the two halves that fix it.
//
// The Homeroom Flutter shell paints a launch screen before this document
// exists. It had no way to know what colour to paint: SV's theme lives in
// the WebView's localStorage, the app's in its own SharedPreferences, and
// nothing carried a value between them — so it guessed from the OS and
// painted WHITE for everyone who had picked Dark on a light-mode phone.
//
// Two things had to change on this side, and this file pins both:
//
//   1. `color-scheme`, class-keyed, in the head's critical <style>. A
//      background alone does not settle what the USER AGENT paints — the
//      canvas under the document, the scrollbars, and the default form
//      controls all follow `color-scheme`, and without it they stay light
//      inside a near-black shell.
//   2. `setAppearance`, an additive unprivileged bridge method, so the app
//      opens its NEXT launch in the appearance this document resolved to.
//
// Run with: node --test tests/native-appearance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const headSrc = () => read('frontend', 'src', 'head.html');
const bridgeSrc = () => read('public', 'usernode-bridge', 'v1', 'bridge.js');
const nativeChromeSource = read('public', 'js', 'native-chrome.js');

// Objects that crossed out of the vm realm carry that realm's prototypes,
// so assert.deepEqual sees "same structure, not reference-equal". Same
// helper tests/native-session-handoff.test.js uses for the same reason.
const plain = (value) => JSON.parse(JSON.stringify(value));

// ── 1. color-scheme in the pre-stylesheet paint ──────────────────────────

test('the head declares color-scheme for both grounds', () => {
  const src = headSrc();
  // Both live in the SAME rules as the background they belong to, inside
  // the critical <style>: the whole point is that they are true with no
  // stylesheet loaded at all.
  assert.match(
    src,
    /html\s*\{[^}]*background-color:\s*#f4f2e4[^}]*color-scheme:\s*light[^}]*\}/,
    'the light ground rule must also declare color-scheme: light'
  );
  assert.match(
    src,
    /html\.dark\s*\{[^}]*background-color:\s*#0b0d1b[^}]*color-scheme:\s*dark[^}]*\}/,
    'the dark ground rule must also declare color-scheme: dark'
  );
});

test('color-scheme is keyed off .dark, never delegated to the OS', () => {
  const src = headSrc();
  // `color-scheme: light dark` hands the choice to the OS preference. The
  // shell's Light/Dark override is a CLASS on <html> that no OS preference
  // can see, so the bare two-value form would give a viewer who picks
  // Light on a dark phone dark scrollbars and dark <select> menus on a
  // #f4f2e4 page. This is the regression the rule above prevents.
  assert.doesNotMatch(
    src,
    /color-scheme:\s*(light\s+dark|dark\s+light|normal)\b/,
    'color-scheme must resolve from the .dark class, not from the OS'
  );
});

// ── 2. The bridge wrapper ────────────────────────────────────────────────

test('the hosted bridge exposes setAppearance', () => {
  const src = bridgeSrc();
  assert.match(src, /window\.usernode\.setAppearance\s*=/);
  assert.match(src, /"setAppearance"/, 'it must post the setAppearance method');
  assert.match(src, /_APPEARANCE_TIMEOUT_MS/,
    'the call must race its own timeout, like every other bridge wrapper');
});

test('setAppearance is UNPRIVILEGED', () => {
  const src = bridgeSrc();
  // Deliberate, and the reason it works: the launch it fixes is the one
  // BEFORE sign-in, so a privileged envelope would make it unavailable in
  // exactly the case it exists for. It carries no account state.
  const privileged = /_PRIVILEGED_NATIVE_METHODS\s*=\s*\{([\s\S]*?)\n\s*\};/
    .exec(src);
  assert.ok(privileged, 'the privileged method table must still be findable');
  assert.doesNotMatch(privileged[1], /\bsetAppearance\b/,
    'setAppearance must not be listed as a privileged method');
});

test('setAppearance normalises its arguments', () => {
  const src = bridgeSrc();
  // The app must never have to re-resolve `system`, and must never be
  // handed a colour it cannot parse.
  assert.match(src, /scheme\s*===\s*"dark"\s*\?\s*"dark"\s*:\s*"light"/,
    'scheme must be forced to the resolved two-value form');
  assert.match(src, /\^#\[0-9a-fA-F\]\{6\}\$/,
    'background must be validated as #rrggbb before it is forwarded');
});

// ── 3. The publisher ─────────────────────────────────────────────────────

function loadNativeChrome({
  dark = false,
  background = 'rgb(11, 13, 27)',
  capabilities = ['setAppearance'],
  getBridgeInfoImpl,
  setAppearanceImpl,
} = {}) {
  const calls = { setAppearance: [], bridgeInfo: 0 };
  const themeListeners = [];
  const classList = new Set(dark ? ['dark'] : []);
  const usernode = {
    isNative: true,
    async getBridgeInfo() {
      calls.bridgeInfo += 1;
      return getBridgeInfoImpl
        ? getBridgeInfoImpl(calls.bridgeInfo)
        : { version: 4, capabilities };
    },
    async setAppearance(appearance) {
      calls.setAppearance.push(appearance);
      if (setAppearanceImpl) return setAppearanceImpl(appearance);
      return true;
    },
  };
  const documentElement = {
    classList: {
      contains: (name) => classList.has(name),
      add: (name) => classList.add(name),
      delete: (name) => classList.delete(name),
    },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class { constructor(type, init) {
      this.type = type; this.detail = init && init.detail;
    } },
    App: { user: null },
    usernode,
    Theme: {
      onChange(fn) { themeListeners.push(fn); },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    getComputedStyle: () => ({ backgroundColor: background }),
    document: {
      documentElement,
      visibilityState: 'visible',
      getElementById() { return null; },
      createElement() { return {}; },
      addEventListener() {},
    },
    addEventListener() {},
    dispatchEvent() {},
    setTimeout(fn, delay) {
      const timer = setTimeout(fn, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return timer;
    },
    clearTimeout,
    setInterval() { return 0; },
    async fetch() { throw new Error('no network in this test'); },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  return {
    calls,
    NativeChrome: sandbox.NativeChrome,
    // init() published on load. One macrotask boundary drains the whole
    // microtask queue, so awaiting this settles that boot publish and every
    // continuation it queued — tests then reason from a settled state
    // instead of racing it.
    ready: new Promise((resolve) => setImmediate(resolve)),
    setDark(on) {
      if (on) classList.add('dark'); else classList.delete('dark');
    },
    setBackground(value) { background = value; },
    fireThemeChange() { themeListeners.forEach((fn) => fn()); },
  };
}

test('the resolved appearance is read back off the document', async () => {
  const dark = loadNativeChrome({ dark: true, background: 'rgb(11, 13, 27)' });
  await dark.ready;
  assert.deepEqual(plain(dark.calls.setAppearance), [
    { scheme: 'dark', background: '#0b0d1b' },
  ]);

  // Reading the ground back off the rendered document — rather than
  // repeating the two hex literals a third time — is what keeps this in
  // step with the head's critical <style> when either colour changes.
  const light = loadNativeChrome({ dark: false, background: 'rgb(244, 242, 228)' });
  await light.ready;
  assert.deepEqual(plain(light.calls.setAppearance), [
    { scheme: 'light', background: '#f4f2e4' },
  ]);
});

test('it publishes on boot and on every theme change', async () => {
  const harness = loadNativeChrome({ dark: false, background: 'rgb(244, 242, 228)' });
  // The boot publish IS the first one — nothing else has to call it.
  await harness.ready;
  assert.equal(harness.calls.setAppearance.length, 1);

  harness.setDark(true);
  harness.setBackground('rgb(11, 13, 27)');
  harness.fireThemeChange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls.setAppearance.length, 2);
  assert.equal(harness.calls.setAppearance[1].scheme, 'dark');
});

test('re-publishing an unchanged appearance is a no-op', async () => {
  // The producer contract says the call is idempotent and last-write-wins;
  // re-sending a value it already holds must not make the launch colour
  // flicker, so we do not send it at all.
  const harness = loadNativeChrome({ dark: true });
  await harness.ready;
  await harness.NativeChrome.publishAppearance();
  await harness.NativeChrome.publishAppearance();
  assert.equal(harness.calls.setAppearance.length, 1);
});

test('a build without the capability is never called', async () => {
  const harness = loadNativeChrome({ capabilities: ['completeLogin'] });
  await harness.ready;
  const published = await harness.NativeChrome.publishAppearance();
  assert.equal(published, false);
  assert.deepEqual(plain(harness.calls.setAppearance), []);
});

test('a DEGRADED probe is inconclusive, not a latched "unsupported"', async () => {
  // Issue #978's rule, and the reason it is here too: one cold-start
  // hiccup must not disable the publish for the rest of the document.
  // A degraded probe means "don't know" — the next attempt must re-probe.
  let probes = 0;
  const harness = loadNativeChrome({
    getBridgeInfoImpl: () => {
      probes += 1;
      return probes === 1
        ? { version: 0, capabilities: [], degraded: true }
        : { version: 4, capabilities: ['setAppearance'] };
    },
  });
  // The BOOT publish is the one that hits the degraded probe.
  await harness.ready;
  assert.deepEqual(plain(harness.calls.setAppearance), []);

  // Re-probed, not latched: the next attempt gets the real answer.
  assert.equal(await harness.NativeChrome.publishAppearance(), true);
  assert.equal(harness.calls.setAppearance.length, 1);
});

test('a rejected publish warns and never throws into the caller', async () => {
  // An app build that drops the unknown method times out here. That is the
  // EXPECTED answer on an older shell, not an error — and console.error
  // would fail the proposal checks on every route.
  const harness = loadNativeChrome({
    setAppearanceImpl: () => Promise.reject(
      new Error('setAppearance is not supported by this app build')
    ),
  });
  await harness.ready;
  assert.equal(await harness.NativeChrome.publishAppearance(), false);
});

test('publishing is not gated on the login handoff', () => {
  // The launch this fixes is the one before sign-in, and the appearance
  // has no account in it. Wiring it behind `sv:session` would mean an
  // anonymous install never publishes and never gets a themed launch.
  const init = /\n\s*init\(\)\s*\{[\s\S]*?\n\s*\},\n\s*\};/.exec(
    nativeChromeSource
  );
  assert.ok(init, 'init() must still be findable');
  const body = init[0];
  const publishAt = body.indexOf('_initAppearancePublish');
  const sessionEstablishmentAt = body.indexOf('establishCurrentSession');
  assert.ok(publishAt !== -1, 'init() must wire the appearance publish');
  assert.ok(sessionEstablishmentAt !== -1,
    'init() must still establish the native session');
  assert.ok(publishAt < sessionEstablishmentAt,
    'the appearance publish must not sit behind native session establishment');
});

// ── 4. The contract both repos read ──────────────────────────────────────

test('NATIVE-BRIDGE.md carries the producer contract', () => {
  const doc = read('NATIVE-BRIDGE.md');
  assert.match(doc, /### Appearance \(additive; `setAppearance`\)/);
  assert.match(doc, /`setAppearance\(\{ scheme, background \}\)`/);
  // The two requirements a producer gets wrong first: reading the stored
  // value too late (which trades a white flash for a light-to-dark
  // repaint), and re-resolving `system` itself.
  assert.match(doc, /Read it synchronously on the launch path/);
  assert.match(doc, /never the\n  tri-state stored mode/);
  // And the capability list, which is how SV feature-detects it.
  assert.match(doc, /- `setAppearance`: the shell remembers the appearance/);
});
