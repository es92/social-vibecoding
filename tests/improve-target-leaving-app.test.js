// The header's Improve button survives the walk back home from an app.
//
// ── The bug ────────────────────────────────────────────────────────────
//
// Improve is the header's STANDING action — it renders on every screen that
// carries a target (frontend/src/features/improve/improve-button.tsx), and on
// the platform screens that target is Homeroom's own self-hosted row,
// published by Home.publishImproveTarget (#1367/#1406). Backing out of an app
// dropped it: the button was there on the app, gone on home, and stayed gone
// for the rest of the visit.
//
// Reported against /app/<slug>/board, and the Board really is where it shows,
// but the cause has nothing to do with that screen. navigateHome hides every
// screen root EXCEPT the app view — `_showOnlyScreen('home-screen',
// ['app-view'])` — because the shrinking card of the kit's zoom-out IS
// #app-view and it has to keep showing the app's content until it lands. So
// for the length of that animation the DOM says the app view is on show while
// the router has already left it, and publishImproveTarget's second gate
// ("not while the app view is on show") rejected:
//
//   * the re-publish navigateHome makes two lines after clearing the app's
//     target, whose entire job is to swap home's in the same frame, and
//   * the publish out of Home.render(), because /api/apps generally answers
//     inside the ~300ms the transition runs.
//
// Nothing publishes after that, so the target stayed null. Leaving from the
// App tab was fine, which is what made it look Board-specific: that path asks
// the kit for `fallback: 'none'`, and 'none' runs fn + after as ONE
// synchronous mutation, so #app-view is already hidden by the time anything
// asks.
//
// ── The fix these pin ──────────────────────────────────────────────────
//
// App._showOnlyScreen records the root it revealed (App._revealedScreen).
// That is the router's answer rather than a paint fact, so it is right from
// the first frame of the transition. The gate keeps both halves and refuses
// only when they agree: the app view is painted AND it is still the revealed
// screen.
//
// Run with: node --test tests/improve-target-leaving-app.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { HOME_SRC } = require('./helpers/home-modules');
const { installGridStore } = require('./helpers/home-grid-store');
const { installAppCard } = require('./helpers/app-card');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const appJs = read('public/js/app.js');

const SELF_ROW = {
  slug: 'usernode-2d5619',
  name: 'Homeroom',
  self_hosted: true,
  can_collaborate: true,
  status: 'running',
  repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
  version: { shortSha: 'abc1234' },
};

// A Home in a vm, with the two things publishImproveTarget reads stubbed: the
// Improve controller it publishes into, and the App surface whose route and
// screen state are its gates.
function makeHome({ currentApp = null, appViewPainted = false,
  revealedScreen = null, apps = [SELF_ROW], appsLoaded = true } = {}) {
  const published = [];
  const store = {};
  const sandbox = {
    console,
    App: {
      user: { id: 1 },
      currentApp,
      _revealedScreen: revealedScreen,
      _isScreenVisible: (id) => (id === 'app-view' ? appViewPainted : !appViewPainted),
    },
    Improve: { setTarget: (t) => published.push(t) },
    PlatformUI: { toast: () => {} },
    HomeLayout: null,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: {
      createElement: () => ({ style: {}, textContent: '', innerHTML: '' }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({ apps: [] }) }),
    location: { search: '', origin: 'https://sv.test', hash: '' },
    URL,
    URLSearchParams,
    JSON,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    addEventListener: () => {},
    navigator: { userAgent: 'node' },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  installGridStore(sandbox);
  installAppCard(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__HOME = Home;`, sandbox);
  const Home = sandbox.__HOME;
  Home._apps = apps;
  Home._appsLoaded = appsLoaded;
  return { Home, published, sandbox };
}

// ── The gate ───────────────────────────────────────────────────────────

test('an OPEN app keeps its own target — both halves of the gate agree', () => {
  const { Home, published } = makeHome({
    currentApp: 'whiteboard-ab12cd',
    appViewPainted: true,
    revealedScreen: 'app-view',
  });
  Home.publishImproveTarget();
  assert.deepEqual(published, [],
    'publishing over an open app would make the header describe the wrong thing');
});

test('a repaint mid-zoom-IN does not publish over the app being opened', () => {
  // navigateToApp sets App.currentApp synchronously and reveals #app-view
  // inside the transition callback, so _showOnlyScreen('app-view') has not
  // run yet. The route is what answers here.
  const { Home, published } = makeHome({
    currentApp: 'whiteboard-ab12cd',
    appViewPainted: true,
    revealedScreen: 'home-screen',
  });
  Home.publishImproveTarget();
  assert.deepEqual(published, [], 'the currentApp half still covers the entry window');
});

test('THE REGRESSION: leaving an app publishes home\'s target while the '
  + 'zoom-out still paints #app-view', () => {
  // Exactly the state navigateHome is in when it re-publishes: the route has
  // let go of the app, _showOnlyScreen has revealed home, and #app-view is
  // painted on purpose because it is the card being shrunk.
  const { Home, published } = makeHome({
    currentApp: null,
    appViewPainted: true,
    revealedScreen: 'home-screen',
  });
  Home.publishImproveTarget();
  assert.equal(published.length, 1,
    'the header\'s standing action must not wait for the animation to end');
  assert.equal(published[0].kind, 'platform');
  assert.equal(published[0].slug, SELF_ROW.slug);
});

test('and it is still refused while the app view is BOTH painted and current',
  () => {
    // The half-way state navigateHome passes through: AppView.close() clears
    // the app's target before _showOnlyScreen runs. Refusing here is harmless
    // — the explicit re-publish two lines later is the one that lands — and it
    // keeps the gate honest for any other caller.
    const { Home, published } = makeHome({
      currentApp: null,
      appViewPainted: true,
      revealedScreen: 'app-view',
    });
    Home.publishImproveTarget();
    assert.deepEqual(published, []);
  });

test('every other platform screen still publishes (#1406)', () => {
  const { Home, published } = makeHome({
    currentApp: null,
    appViewPainted: false,
    revealedScreen: 'settings-screen',
  });
  Home.publishImproveTarget();
  assert.equal(published.length, 1, 'settings/profile/browse keep the button');
  assert.equal(published[0].kind, 'platform');
});

test('a viewer who is not served the self-hosted row gets no button', () => {
  const { Home, published } = makeHome({
    revealedScreen: 'home-screen',
    apps: [{ slug: 'whiteboard-ab12cd', name: 'Whiteboard' }],
  });
  Home.publishImproveTarget();
  assert.deepEqual(published, [],
    'the row is resolved from the list the viewer was actually served');
});

// ── The other half, in app.js ──────────────────────────────────────────

test('_showOnlyScreen records the root it revealed', () => {
  const at = appJs.indexOf('  _showOnlyScreen(revealId, keepAlso) {');
  assert.ok(at !== -1, '_showOnlyScreen went missing');
  const body = appJs.slice(at, appJs.indexOf('\n  },', at));
  assert.match(body, /App\._revealedScreen = revealId;/,
    'the one choke point every screen entry passes through is where the '
    + 'router\'s own answer is recorded');
  assert.match(appJs, /^ {2}_revealedScreen: null,$/m,
    'and it is declared, so a read before the first swap is not undefined');
});

test('navigateHome keeps #app-view painted, which is why the router has to answer',
  () => {
    const at = appJs.indexOf('  navigateHome() {');
    const body = appJs.slice(at, appJs.indexOf('\n  },', at));
    assert.match(body, /App\._showOnlyScreen\('home-screen', \['app-view'\]\)/,
      'the shrinking card is #app-view — it stays painted for the zoom-out');
    // Order still matters: clear the app's target, then republish home's.
    assert.match(body,
      /App\.ImproveStatus\.setAppOpen\(false\);[\s\S]{0,900}Home\.publishImproveTarget\(\)/,
      'and the republish comes after the clear, so nothing inherits the '
      + 'closed app\'s facts');
    assert.ok(body.indexOf("App._showOnlyScreen('home-screen', ['app-view'])")
      < body.indexOf('Home.publishImproveTarget()'),
      'the reveal must land before the republish, or the gate reads the app '
      + 'view as still current');
  });
