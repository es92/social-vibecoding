// "Add to Home Screen" for one app (#1508), and where it lives (#2320).
//
// Per-app home-screen install has three parts: the manifest and the page
// (tests/app-install-manifest.test.js, tests/app-install-route.test.js), the
// server mount that puts them in front of the SPA catch-all, and the item that
// is the only way a person finds the page. #1508 put that item in the app
// chip's sheet, which only knows the app you are already inside; #2320 moved
// it to the app's own hold / right-click menu (Home.menuItemsFor), which is
// also what the app's details page renders. Pinned here:
//
//  - the chip's sheet no longer renders the row, with or without a current
//    app;
//  - detectInstallHost lives in mobile-install/environment.ts beside the two
//    facts it combines, and says `none` off a phone;
//  - the card menu offers `install` only on a phone or in the native app, not
//    for the inert ?demo=1 tiles, and not beside the native widget/launcher
//    pin, so the menu never carries two look-alike items;
//  - it opens /app/<slug>/install the way the host needs: the native bridge's
//    openExternal (window.open as the fallback), a new window from a
//    standalone shell, a same-tab navigation everywhere else;
//  - server.js mounts the routes after authMiddleware and before the
//    catch-all, and dapp.json declares the check that renders the page.
//
// Run with: node --test tests/app-install-sheet-row.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { installAppCard } = require('./helpers/app-card');
const { installGridStore } = require('./helpers/home-grid-store');
const { HOME_RAW, HOME_SRC, LAYOUT_SRC } = require('./helpers/home-modules');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SHEET = read('frontend/src/features/app-context/app-context-sheet.tsx');
const SERVER = read('server.js');

const ui = loadTsx('tests/fixtures/app-context-sheet-api.ts');
const initialImprove = { ...ui.improveStore.get() };
const renderSheet = (patch) => {
  ui.improveStore.set({ ...initialImprove, ...patch });
  try {
    return renderToHtml(createElement(ui.AppsSwitcherSheet));
  } finally {
    ui.improveStore.set(initialImprove);
  }
};

// ── Not in the chip's sheet any more ────────────────────────────────

test('the app chip menu renders no Add to Home Screen row, with or without an app', () => {
  for (const slug of [null, 'recipe-box']) {
    const html = renderSheet({ slug });
    assert.doesNotMatch(html, /app-context-add-to-home/);
    assert.doesNotMatch(html, /Add to Home Screen/);
    assert.doesNotMatch(html, /\/install"/);
    // The app's own rows are untouched by its absence.
    assert.match(html, /id="app-menu-row-about"/);
  }
  assert.doesNotMatch(SHEET, /AddToHomeScreenRow|detectInstallHost/);
});

// #2718 put a home-screen SENTENCE in the sheet's About pane. The navigation
// prototype draws it as a ROW ("Add to home screen", beside Share and Fork),
// and the row it now is, is not the one #2320 moved out of this sheet coming
// back: that was a per-app install built INTO the chip's sheet. About is the
// app's page as a pop-up, so its row is the item the app's page already has —
// Home.menuItemsFor's `install`, taken by key and run as is — and never a
// second copy of the install address. Not the native pin
// (`add-to-homescreen`): its result is Home's widget strip, off screen from
// About, so the tap looked like nothing; Discover's page leaves it out too. For Homeroom, which
// IS this page's PWA, it is still the OS's own steps in words, because there
// is no install API to call (iOS Safari has none and Android's
// `beforeinstallprompt` fires when Chrome decides it should).
test('About\'s home-screen row is the app page\'s own item, or the OS\'s steps for Homeroom', () => {
  const about = read('frontend/src/features/app-context/about-pane.tsx');
  assert.match(about, /items\.find\(\(i\) => i && i\.key === 'install'\)/,
    'the app\'s row is the card menu\'s install item, found by key');
  assert.doesNotMatch(about, /'add-to-homescreen'/, 'not the native widget pin');
  assert.match(about, /menuItemsFor\(row\)/, 'from the list the app\'s page renders');
  assert.match(about, /A2HS_STEPS/,
    'the platform\'s sentence is the one ../mobile-install/detect.ts already wrote');
  assert.doesNotMatch(about, /app-context-add-to-home|\/install['"`]/,
    'and no install address of its own: the one address is home.js\'s');
});

// ── Whether the device has a home screen ────────────────────────────

function withHost({ window: win, ua = '', touch = 0 }, fn) {
  const savedWindow = globalThis.window;
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    globalThis.window = { navigator: {}, matchMedia: () => ({ matches: false }), ...win };
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: ua, maxTouchPoints: touch }, configurable: true, writable: true,
    });
    return fn();
  } finally {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    else delete globalThis.navigator;
  }
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

test('detectInstallHost is exported from the environment module and reads the device', () => {
  const env = loadTsx('frontend/src/features/mobile-install/environment.ts');
  assert.equal(typeof env.detectInstallHost, 'function');
  const host = (opts) => withHost(opts, () => env.detectInstallHost());

  assert.equal(host({ ua: MAC }), 'none', 'a laptop has no home screen');
  assert.equal(host({ ua: IPHONE }), 'browser');
  assert.equal(host({ ua: ANDROID }), 'browser');
  assert.equal(host({ ua: MAC, touch: 5 }), 'browser', 'an iPad reports a Mac UA, with touch points');
  assert.equal(host({ ua: IPHONE, window: { matchMedia: () => ({ matches: true }) } }), 'standalone');
  assert.equal(host({ ua: IPHONE, window: { navigator: { standalone: true } } }), 'standalone',
    'iOS Safari reports standalone on navigator');
  assert.equal(host({ ua: MAC, window: { usernode: { isNative: true } } }), 'native',
    'the native app counts as a phone, whatever its UA says');
});

// ── In the app's hold / right-click menu ────────────────────────────

function makeHomeEnv(installHost) {
  const calls = [];
  const sandbox = {
    console,
    App: { user: { id: 42 } },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      createElement: () => ({ textContent: '', innerHTML: '' }),
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL,
    location: {
      search: '', hash: '', origin: 'https://sv.test',
      assign: (href) => calls.push(['assign', href]),
    },
    open: (...args) => { calls.push(['open', ...args]); return null; },
    addEventListener: () => {},
    removeEventListener: () => {},
    // What the stripped `import { detectInstallHost }` line would have bound.
    detectInstallHost: () => installHost,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  installAppCard(sandbox);
  installGridStore(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, sandbox, calls };
}

const app = (over) => ({
  id: 1, slug: 'recipe-box', name: 'Recipe Box', status: 'running', created_by: 999,
  ...over,
});
const keys = (items) => Array.from(items, (i) => i.key);
const installItem = (Home, over) => Home.menuItemsFor(app(over)).find((i) => i.key === 'install');

test('home.js takes detectInstallHost from the environment module', () => {
  assert.match(HOME_RAW, /^import \{ detectInstallHost \} from '\.\.\/mobile-install\/environment';$/m);
});

test('the card menu offers install on a phone or in the native app, never off one', () => {
  for (const host of ['native', 'standalone', 'browser']) {
    const { Home } = makeHomeEnv(host);
    const item = installItem(Home);
    assert.ok(item, `offered for host ${host}`);
    assert.equal(item.label, 'Add to Home Screen');
    assert.doesNotMatch(`${item.label}${item.title || ''}`, /—/, 'no em dash in the copy');
  }
  const { Home } = makeHomeEnv('none');
  assert.equal(installItem(Home), undefined, 'a laptop gets nothing');
});

test('it sits after Notifications, and not for demo tiles or slugless rows', () => {
  const { Home } = makeHomeEnv('browser');
  const order = keys(Home.menuItemsFor(app()));
  assert.equal(order.indexOf('install'), order.indexOf('notifications') + 1);
  assert.equal(installItem(Home, { demo: true }), undefined, '?demo=1 tiles have no install page');
  assert.equal(installItem(Home, { slug: null }), undefined);
});

test('never beside the native pin, which is the same idea in the native app', () => {
  const { Home } = makeHomeEnv('native');
  Home._shortcutSupport = { mechanism: 'pinned-shortcut' };
  // A "Your apps" app that is running gets the pin, so no install item.
  const yours = keys(Home.menuItemsFor(app({ is_favorited: true })));
  assert.ok(yours.includes('add-to-homescreen'));
  assert.ok(!yours.includes('install'));
  // A directory app gets no pin, so install is the way onto the home screen.
  const other = keys(Home.menuItemsFor(app()));
  assert.ok(!other.includes('add-to-homescreen'));
  assert.ok(other.includes('install'));
  // An unsupported bridge offers no pin either.
  Home._shortcutSupport = { mechanism: 'unsupported' };
  assert.ok(keys(Home.menuItemsFor(app({ is_favorited: true }))).includes('install'));
});

test('run opens the install page the way the host needs', async () => {
  // A browser: an ordinary same-tab navigation, slug escaped.
  let env = makeHomeEnv('browser');
  installItem(env.Home, { slug: 'a b' }).run();
  assert.deepEqual(env.calls, [['assign', '/app/a%20b/install']]);

  // An installed platform PWA: a browser window of its own.
  env = makeHomeEnv('standalone');
  installItem(env.Home).run();
  assert.deepEqual(env.calls, [['open', '/app/recipe-box/install', '_blank', 'noopener']]);

  // Native: the bridge, with an absolute URL.
  env = makeHomeEnv('native');
  const opened = [];
  env.sandbox.usernode = { isNative: true, openExternal: async (url) => { opened.push(url); } };
  installItem(env.Home).run();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(opened, ['https://sv.test/app/recipe-box/install']);
  assert.deepEqual(env.calls, [], 'no window.open when the bridge takes it');

  // Native, the bridge refuses: window.open is the fallback.
  env = makeHomeEnv('native');
  env.sandbox.usernode = { isNative: true, openExternal: async () => { throw new Error('nope'); } };
  installItem(env.Home).run();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(env.calls, [['open', 'https://sv.test/app/recipe-box/install', '_blank', 'noopener']]);

  // Native, an app build without the handler: the same fallback.
  env = makeHomeEnv('native');
  env.sandbox.usernode = { isNative: true };
  installItem(env.Home).run();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(env.calls, [['open', 'https://sv.test/app/recipe-box/install', '_blank', 'noopener']]);
});

// ── Shared helpers, not copies ──────────────────────────────────────

test('the environment helpers are shared with the install banner, not copied', () => {
  const banner = read('frontend/src/features/mobile-install/install-banner.tsx');
  assert.match(banner, /import \{ isNativeApp, isStandalone \} from '\.\/environment';/);
  assert.doesNotMatch(banner, /function isStandalone\(/);
  assert.doesNotMatch(banner, /function isNativeApp\(/);

  const env = loadTsx('frontend/src/features/mobile-install/environment.ts');
  const saved = globalThis.window;
  try {
    globalThis.window = { matchMedia: () => ({ matches: false }), navigator: {} };
    assert.equal(env.isStandalone(), false);
    assert.equal(env.isNativeApp(), false);
    globalThis.window.navigator.standalone = true;
    assert.equal(env.isStandalone(), true, 'iOS Safari reports it on navigator');
    globalThis.window = { matchMedia: () => ({ matches: true }), navigator: {}, usernode: { isNative: true } };
    assert.equal(env.isStandalone(), true);
    assert.equal(env.isNativeApp(), true);
    globalThis.window = { matchMedia: () => { throw new Error('no media'); }, navigator: {}, usernode: { isNative: 'yes' } };
    assert.equal(env.isStandalone(), false, 'a throwing matchMedia is not standalone');
    assert.equal(env.isNativeApp(), false, 'only a real true counts');
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
});

// ── The server side the item depends on ─────────────────────────────

test('server.js mounts the install routes after authMiddleware and before the SPA catch-all', () => {
  assert.match(SERVER, /const \{ appInstallRoutes \} = require\('\.\/src\/routes\/app-install'\);/);
  const mount = SERVER.indexOf('app.use(appInstallRoutes(config));');
  assert.ok(mount !== -1, 'the routes are mounted');
  assert.ok(SERVER.indexOf('app.use(authMiddleware(config));') < mount, 'req.user has to be resolved first');
  assert.ok(mount < SERVER.indexOf("app.get('*', (req, res)"), 'or the catch-all serves index.html for the page');
});

test('dapp.json declares the check that renders the install page', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const hit = dapp.tests.find((t) => t.path === '/app/staging-demo-admins/install');
  assert.ok(hit, 'a declared check opens the seeded app\'s install page');
  assert.equal(hit.expectSelector, '#app-install');
});
