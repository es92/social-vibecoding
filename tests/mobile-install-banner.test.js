// The mobile-browser install banner (#1372).
//
// A visitor who opens the platform in a phone browser gets a strip offering
// the native app. Three parts, all pinned here:
//
//   1. GET /api/public/mobile-app — the per-OS store URL, read from
//      `app_version_configs.update_url`. That column already exists and is
//      already admin-editable (admin console -> App version); it is what the
//      native update gate sends a user to, which is the same destination an
//      install banner needs. No new setting, no new table.
//
//      Deliberately NOT a reuse of POST /api/v4/app-version/check: that route
//      calls recordVersionCheck(), so driving it from every web pageview would
//      write a version-check row for a build that does not exist and poison
//      the admin console's seven-day check histogram.
//
//   2. installOffer() — the whole should-we-show-it decision as one pure
//      function, so every suppression rule is testable without a browser.
//
//   3. The island renders its markup hidden on the FIRST render, with no data.
//      AGENTS.md: an island's initial render must emit exactly the empty/hidden
//      markup the shell shipped, because a hydration mismatch console.errors
//      and a console error on any route fails proposal checks.
//
// Run with: node --test tests/mobile-install-banner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');

// ── Harness for the route ───────────────────────────────────────────

function withMockPool(mockPool, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => mockPool },
    loaded: true,
    id: poolModulePath,
    filename: poolModulePath,
    paths: original ? original.paths : [],
  };
  delete require.cache[require.resolve('../src/routes/public-api')];
  try {
    return fn();
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[require.resolve('../src/routes/public-api')];
  }
}

// `rows` is what the app_version_configs SELECT returns. `fail` makes that
// query throw, standing in for a database that is down.
function makeMockPool(rows, { fail = false } = {}) {
  const calls = [];
  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });
    if (/FROM app_version_configs/i.test(s)) {
      if (fail) throw new Error('connection terminated');
      return { rows: rows.map((r) => ({ ...r })) };
    }
    throw new Error(`unhandled mock SQL: ${s.slice(0, 80)}`);
  }
  return { query, calls };
}

async function startTestServer(pool) {
  return withMockPool(pool, async () => {
    const { publicApiRoutes } = require('../src/routes/public-api');
    const app = express();
    app.use(express.json());
    app.use(publicApiRoutes({}));
    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        resolve({
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          close: () => new Promise((r) => server.close(r)),
        });
      });
    });
  });
}

function get(baseUrl, path) {
  return fetch(`${baseUrl}${path}`).then(async (res) => ({
    status: res.status,
    body: await res.json(),
  }));
}

const IOS_URL = 'https://apps.apple.com/app/id123456789';
const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.usernode_labs.usernode';

// ── GET /api/public/mobile-app ──────────────────────────────────────

test('mobile-app: returns the per-OS update_url as the install URL', async () => {
  const srv = await startTestServer(makeMockPool([
    { os: 'ios', update_url: IOS_URL },
    { os: 'android', update_url: PLAY_URL },
  ]));
  try {
    const { status, body } = await get(srv.baseUrl, '/api/public/mobile-app');
    assert.equal(status, 200);
    assert.deepEqual(body, { ios: IOS_URL, android: PLAY_URL });
  } finally { await srv.close(); }
});

test('mobile-app: an OS with no row, or a blank url, is an explicit null', async () => {
  // The live state today: rows may exist for the update gate without anyone
  // having pasted a store URL, because neither listing is published yet.
  const srv = await startTestServer(makeMockPool([
    { os: 'ios', update_url: null },
    { os: 'android', update_url: '   ' },
  ]));
  try {
    const { status, body } = await get(srv.baseUrl, '/api/public/mobile-app');
    assert.equal(status, 200);
    assert.deepEqual(body, { ios: null, android: null });
  } finally { await srv.close(); }
});

test('mobile-app: both keys are always present, even with no rows at all', async () => {
  const srv = await startTestServer(makeMockPool([]));
  try {
    const { body } = await get(srv.baseUrl, '/api/public/mobile-app');
    assert.deepEqual(Object.keys(body).sort(), ['android', 'ios']);
    assert.equal(body.ios, null);
    assert.equal(body.android, null);
  } finally { await srv.close(); }
});

test('mobile-app: reads only active configs, and never records a version check', async () => {
  const pool = makeMockPool([{ os: 'ios', update_url: IOS_URL }]);
  const srv = await startTestServer(pool);
  try {
    await get(srv.baseUrl, '/api/public/mobile-app');
    const sql = pool.calls.map((c) => c.sql).join('\n');
    assert.match(sql, /is_active\s*=\s*TRUE/i);
    // An inactive gate row is not an install offer.
    assert.doesNotMatch(sql, /INSERT INTO app_version_checks/i);
  } finally { await srv.close(); }
});

test('mobile-app: a database failure degrades to no offer, not a 500', async () => {
  // The banner is an upsell on an otherwise-working page. Failing the request
  // would surface a console error on every route, which fails proposal checks.
  const srv = await startTestServer(makeMockPool([], { fail: true }));
  try {
    const { status, body } = await get(srv.baseUrl, '/api/public/mobile-app');
    assert.equal(status, 200);
    assert.deepEqual(body, { ios: null, android: null });
  } finally { await srv.close(); }
});

// ── installOffer(): the suppression rules ───────────────────────────

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MAC = IPAD;
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const URLS = { ios: IOS_URL, android: PLAY_URL };

function env(over = {}) {
  return {
    ua: IPHONE,
    maxTouchPoints: 5,
    native: false,
    standalone: false,
    member: true,
    touring: false,
    dismissed: false,
    urls: URLS,
    ...over,
  };
}

test('installOffer: an iPhone browser is offered the App Store URL', () => {
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.deepEqual(installOffer(env()), { kind: 'store', os: 'ios', url: IOS_URL });
});

test('installOffer: an Android browser is offered the Play URL', () => {
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.deepEqual(
    installOffer(env({ ua: ANDROID, maxTouchPoints: 5 })),
    { kind: 'store', os: 'android', url: PLAY_URL },
  );
});

test('installOffer: iPadOS reports itself as a Mac, and is still iOS', () => {
  // iPadOS 13+ ships the desktop Safari UA verbatim. Touch points are the
  // only thing separating it from a real Mac.
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.deepEqual(installOffer(env({ ua: IPAD, maxTouchPoints: 5 })),
    { kind: 'store', os: 'ios', url: IOS_URL });
});

test('installOffer: a desktop Mac and a Windows PC get nothing', () => {
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.equal(installOffer(env({ ua: MAC, maxTouchPoints: 0 })), null);
  assert.equal(installOffer(env({ ua: WINDOWS, maxTouchPoints: 0 })), null);
  // A Windows laptop with a touchscreen is still not a phone.
  assert.equal(installOffer(env({ ua: WINDOWS, maxTouchPoints: 10 })), null);
});

test('installOffer: suppressed inside the native app', () => {
  // The whole point of the banner is to get someone into this app. Showing it
  // to someone already in it is the one unambiguous bug.
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.equal(installOffer(env({ native: true })), null);
});

test('installOffer: suppressed when already installed as a PWA', () => {
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.equal(installOffer(env({ standalone: true })), null);
});

test('#4204: suppressed until the visitor is signed in and let in', () => {
  // The signed-out landing (an invite link's page before Join), the sign-in
  // page and the waiting room: nothing is offered, store listing or not.
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.equal(installOffer(env({ member: false })), null);
  assert.equal(installOffer(env({ member: false, urls: { ios: null, android: null } })), null);
  assert.equal(installOffer(env({ member: false, ua: ANDROID })), null);
  // Once in, the offer is what it was.
  assert.deepEqual(installOffer(env({ urls: { ios: null, android: null } })), { kind: 'a2hs', os: 'ios' });
});

test('#4204: the island asks only once there is a platform viewer', () => {
  // The fetch and the member flag both wait on the authed shell, so an
  // anonymous document never requests /api/public/mobile-app, and a sign-in
  // without a reload (sv:authed) still turns the strip on.
  const src = fs.readFileSync(
    path.join(ROOT, 'frontend/src/features/mobile-install/install-banner.tsx'), 'utf8');
  assert.match(src, /from '\.\.\/\.\.\/lib\/platform-viewer'/);
  const gate = src.indexOf('whenPlatformViewer(');
  assert.ok(gate > 0, 'the island waits for a platform viewer');
  assert.ok(src.indexOf("fetch('/api/public/mobile-app')") > gate,
    'the store-listing fetch runs inside the viewer gate');
  assert.match(src, /member: member && hasPlatformViewer\(\)/);
});

// ── Not over the first-session tour (#4899) ─────────────────────────

test('#4899: held while a first-session tour is on screen, offered again as it ends', () => {
  // Onboarding run, 12 Oct 2026: right after a first app was made the strip
  // came up on Home and stayed pinned through the whole tour, over its cards
  // and the app. Held, not dismissed: the same visitor is offered it the
  // moment the tour is over.
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.equal(installOffer(env({ touring: true })), null, 'a store listing is held');
  assert.equal(installOffer(env({ touring: true, urls: { ios: null, android: null } })), null,
    'so is the home-screen offer, the line the run saw');
  assert.equal(installOffer(env({ touring: true, ua: ANDROID })), null);
  assert.deepEqual(installOffer(env({ touring: false })), { kind: 'store', os: 'ios', url: IOS_URL });
  assert.deepEqual(installOffer(env({ touring: false, urls: { ios: null, android: null } })),
    { kind: 'a2hs', os: 'ios' });
  // The other suppressions are untouched by it.
  assert.equal(installOffer(env({ touring: false, member: false })), null, '#4204 still holds');
  assert.equal(installOffer(env({ touring: false, dismissed: true })), null);
});

test('#4899: the island reads the tour\'s own flag, and asks again when it changes', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'frontend/src/features/mobile-install/install-banner.tsx'), 'utf8');
  // The flag the first-session Tour sets while it is mounted
  // (tests/first-session.test.js pins that side), read reactively, so the
  // strip comes up as the tour ends without a reload.
  assert.match(src, /import \{ useTourRunning \} from '\.\.\/first-session\/tour-running';/);
  assert.match(src, /const touring = useTourRunning\(\);/);
  const call = src.slice(src.indexOf('setOffer(installOffer({'));
  assert.match(call.slice(0, call.indexOf('}));')), /\n\s+touring,\n/);
  assert.match(src, /\}, \[urls, dismissed, member, privateMember, tab, touring\]\);/);
  // That decision is an effect, a render behind the flag, so the strip and the
  // body's room for it read the flag too: down in the frame the tour comes up.
  assert.match(src, /const up = !!offer && !touring;\n\n  useHiddenClass\(ref, !up\);/);
  assert.match(src, /body\.classList\.toggle\(BODY_CLASS, up\);\n[^\n]*\n  \}, \[up\]\);/);
  // Nobody who never takes a tour is held: the flag is false until a Tour
  // mounts, and the Tour puts it back as it unmounts.
  const tour = loadTsx('frontend/src/features/first-session/tour-running.ts');
  assert.equal(tour.tourRunning(), false);
  // The mark menu's home-screen row is a menu somebody opened, not the strip.
  const hook = fs.readFileSync(
    path.join(ROOT, 'frontend/src/features/mobile-install/home-screen-offer.ts'), 'utf8');
  assert.match(hook, /touring: false,/);
});

test('#4899: the first render is the same hidden strip whether or not a tour runs', () => {
  // The flag only feeds effects (the offer, the hidden class, the body's
  // class), so the markup the prerender shipped is what hydration draws in
  // either case.
  const tour = loadTsx('frontend/src/features/first-session/tour-running.ts');
  const render = () => renderComponent(
    'frontend/src/features/mobile-install/install-banner.tsx',
    'MobileInstallBanner',
  );
  const idle = render();
  tour.setTourRunning(true);
  try {
    const touring = render();
    assert.equal(touring, idle);
    assert.match(touring, /class="hidden /);
  } finally {
    tour.setTourRunning(false);
  }
});

test('installOffer: suppressed once dismissed', () => {
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.equal(installOffer(env({ dismissed: true })), null);
});

test('installOffer: no listing for that OS falls back to the home screen (#1513)', () => {
  // It used to return null, and the strip stayed inert. That was right while
  // the only thing it could say was "get the app on the App Store", and wrong
  // once you notice the platform is already an installable PWA: the manifest
  // and the service worker were never waiting on a store review.
  //
  // The per-OS rule is what matters and it is unchanged in substance: an
  // Android visitor is never handed the iOS URL. They are offered the home
  // screen instead of nothing.
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.deepEqual(
    installOffer(env({ ua: ANDROID, urls: { ios: IOS_URL, android: null } })),
    { kind: 'a2hs', os: 'android' },
  );
  assert.deepEqual(
    installOffer(env({ ua: IPHONE, urls: { ios: IOS_URL, android: null } })),
    { kind: 'store', os: 'ios', url: IOS_URL },
  );
  // Neither listing published — production's state today — is an offer on
  // both, and it names no store.
  assert.deepEqual(
    installOffer(env({ ua: IPHONE, urls: { ios: null, android: null } })),
    { kind: 'a2hs', os: 'ios' },
  );
});

test('installOffer: suppressed before the URLs have loaded', () => {
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.equal(installOffer(env({ urls: null })), null);
});

test('installOffer: only http(s) destinations are offered', () => {
  // update_url is admin-supplied free text. It is rendered as an anchor href,
  // so a javascript: value would be a self-inflicted XSS on every mobile page.
  //
  // A refused URL is now the same case as no URL: the home-screen offer, which
  // has no href at all. What must never happen is the bad value reaching a
  // `store` offer, since that is the only branch that becomes an anchor.
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'itms-apps://x', '  ']) {
    const offer = installOffer(env({ urls: { ios: bad, android: null } }));
    assert.deepEqual(
      offer, { kind: 'a2hs', os: 'ios' },
      `expected ${JSON.stringify(bad)} to be refused as an install URL`,
    );
    assert.equal(offer.url, undefined, 'a refused URL never reaches an href');
  }
});

// ── A beta is not "the app" (#1515) ─────────────────────────────────

const TESTFLIGHT_URL = 'https://testflight.apple.com/join/abc123';

test('#1515: a TestFlight invite is not offered as the app', () => {
  // `update_url` is one field feeding two consumers. The native update gate
  // is right to follow a TestFlight link: it is talking to somebody who
  // already installed that build. This strip is talking to a stranger, and
  // "join a beta, install TestFlight, accept an invite" is a different offer
  // from the one a button marked Get appears to make.
  //
  // Since #1513 the answer is the home-screen install rather than an empty
  // strip, which is the better one: the stranger still gets a real way to
  // install, and it is the path that works on this platform today.
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.deepEqual(
    installOffer(env({ urls: { ios: TESTFLIGHT_URL, android: null } })),
    { kind: 'a2hs', os: 'ios' },
    'an iPhone visitor is offered the home screen rather than a beta');
  // The other OS is unaffected: the two listings are independent.
  assert.deepEqual(
    installOffer(env({ ua: ANDROID, urls: { ios: TESTFLIGHT_URL, android: PLAY_URL } })),
    { kind: 'store', os: 'android', url: PLAY_URL });
});

test('#1515: a real App Store listing is still offered', () => {
  // The suppression must be narrow. This is the state the request is waiting
  // for, and it has to keep working the day it arrives.
  const { installOffer } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.deepEqual(
    installOffer(env({ urls: { ios: IOS_URL, android: null } })),
    { kind: 'store', os: 'ios', url: IOS_URL });
});

test('#1515: isBetaInvite tests the HOST, and nothing else', () => {
  const { isBetaInvite } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.equal(isBetaInvite(TESTFLIGHT_URL), true);
  assert.equal(isBetaInvite('https://TestFlight.Apple.Com/join/x'), true, 'case-insensitive');
  // An unrecognised host is somebody's real listing on a domain this has not
  // heard of. Refusing it would hide a working offer, so it is not refused.
  assert.equal(isBetaInvite(IOS_URL), false);
  assert.equal(isBetaInvite(PLAY_URL), false);
  assert.equal(isBetaInvite('https://apps.example.invalid/beta/testflight'), false,
    'the word in a path is not the host');
  assert.equal(isBetaInvite('not a url'), false);
});

// ── storeLabel(): what the strip calls the destination ──────────────

test('storeLabel: a TestFlight invite is not called the App Store', () => {
  // The value published for iOS today IS a TestFlight link, so this is the
  // live case, not a hypothetical: saying "the App Store" while opening a
  // beta invite tells the visitor something untrue about what they join.
  const { storeLabel } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  // storeLabel answers with the strip's whole line, as a message id.
  assert.equal(message(storeLabel('ios', 'https://testflight.apple.com/join/H9puE1gu')), 'Get the app on TestFlight');
});

test('storeLabel: real store listings get their store name', () => {
  const { storeLabel } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.equal(message(storeLabel('ios', IOS_URL)), 'Get the app on the App Store');
  assert.equal(message(storeLabel('android', PLAY_URL)), 'Get the app on Google Play');
});

test('storeLabel: an unrecognised or unparseable URL falls back to the platform store', () => {
  // update_url is one free-text field and nobody is asked what kind of link
  // it is, so an enterprise or self-hosted destination must still read sanely.
  const { storeLabel } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.equal(message(storeLabel('android', 'https://downloads.example.com/usernode.apk')), 'Get the app on Google Play');
  assert.equal(message(storeLabel('ios', 'not a url')), 'Get the app on the App Store');
});

// ── The island's first render ───────────────────────────────────────

test('island: first render is the hidden strip, with no data and no store link', () => {
  const html = renderComponent(
    'frontend/src/features/mobile-install/install-banner.tsx',
    'MobileInstallBanner',
  );

  // Present (the id inventory in tests/shell-id-inventory.test.js requires an
  // ADDED_ID to really be in the built document) …
  assert.match(html, /id="mobile-install-banner"/);
  // … and hidden, with no href, because no fetch has resolved yet.
  assert.match(html, /class="hidden /);
  assert.doesNotMatch(html, /https:\/\/apps\.apple\.com/);
  assert.doesNotMatch(html, /https:\/\/play\.google\.com/);
  // …and names no destination, because none is known yet.
  assert.doesNotMatch(html, /App Store|Google Play|TestFlight/);
});

// ── The home-screen offer (#1513) ───────────────────────────────────

test('#1513: the a2hs steps are instructions, one per OS, and name no store', () => {
  const { A2HS_STEPS, STORE_LABEL } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.deepEqual(Object.keys(A2HS_STEPS).sort(), ['android', 'ios']);
  // iOS Safari exposes no install API and Android's beforeinstallprompt is
  // not guaranteed to fire, so both are directions to a menu item.
  assert.match(message(A2HS_STEPS.ios), /Share.*Add to Home Screen/i);
  assert.match(message(A2HS_STEPS.android), /menu.*Add to Home screen/i);
  for (const os of ['ios', 'android']) {
    // STORE_LABEL is the strip's whole line now ("Get the app on Google
    // Play"), so the store's name is what follows "on".
    const store = message(STORE_LABEL[os]).replace(/^Get the app on (the )?/, '');
    assert.ok(store && !message(A2HS_STEPS[os]).includes(store),
      'the home-screen path must not name a store');
  }
});

test('#1513: the control is a button when there is nowhere to link to', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'frontend/src/features/mobile-install/install-banner.tsx'), 'utf8');
  const branch = src.slice(src.indexOf("offer && offer.kind === 'a2hs' ?"));
  const button = branch.slice(0, branch.indexOf('</Button>'));
  // Composed from the shell's own primary button rather than hand-written, so
  // a restyle reaches it (tests/shell-primitive-adoption.test.js enforces the
  // rule; this pins that THIS control obeys it).
  assert.match(button, /<Button/);
  assert.match(button, /variant="default"/);
  assert.match(button, /ink="solid"/);
  assert.doesNotMatch(button, /bg-violet-600/, 'the fill comes from the variant');
  assert.match(button, /id="mobile-install-open"/);
  assert.match(button, /type="button"/);
  assert.match(button, /aria-haspopup="dialog"/,
    'it opens the steps sheet, so it says so');
  assert.match(button, /aria-expanded=\{stepsOpen\}/);
  assert.doesNotMatch(button, /href=/, 'there is no destination');
  // The store branch keeps its anchor and its safe rel.
  const anchorBranch = src.slice(src.indexOf('<a\n          id="mobile-install-open"'));
  assert.match(anchorBranch.slice(0, 400), /rel="noopener noreferrer"/);
});

// ── The "How" sheet (#4400) ─────────────────────────────────────────

test('#4400: How opens a sheet; the strip keeps its line and its button', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'frontend/src/features/mobile-install/install-banner.tsx'), 'utf8');
  // The strip no longer swaps its second line for the steps, nor its button
  // for "Got it": the sheet has both.
  assert.doesNotMatch(src, /A2HS_STEPS/);
  assert.doesNotMatch(src, /showSteps/);
  assert.doesNotMatch(src, /'Got it'/);
  assert.match(src, /: t\('agent:install\.banner\.addToHomeScreen'\)\}/);
  assert.equal(message('agent:install.banner.addToHomeScreen'), 'Add it to your home screen');
  assert.match(src, /onClick=\{\(\) => setStepsOpen\(true\)\}/);
  // Closing the sheet only closes the sheet: the banner's dismissal stays the ✕'s.
  assert.match(src, /<InstallStepsSheet os=\{offer\.os\} onClose=\{\(\) => setStepsOpen\(false\)\} \/>/);
  // Only ever mounted after a tap, so the prerendered strip is unchanged.
  assert.match(src, /useState\(false\);\n\n  \/\/ The fetch is skipped/);
});

test('#4400: the steps are numbered lines per OS, the first naming its control', () => {
  const { A2HS_STEP_LIST, STORE_LABEL } = loadTsx('frontend/src/features/mobile-install/detect.ts');
  assert.deepEqual(Object.keys(A2HS_STEP_LIST).sort(), ['android', 'ios']);
  assert.deepEqual(A2HS_STEP_LIST.ios.map((s) => message(s.text)), [
    "Tap Share in Safari's toolbar",
    'Choose Add to Home Screen',
    'Open Homeroom from its icon',
  ]);
  assert.equal(A2HS_STEP_LIST.ios[0].glyph, 'share');
  assert.equal(A2HS_STEP_LIST.android.length, 3);
  assert.equal(A2HS_STEP_LIST.android[0].glyph, 'menu');
  assert.match(message(A2HS_STEP_LIST.android[1].text), /Add to Home screen/);
  for (const os of ['ios', 'android']) {
    for (const step of A2HS_STEP_LIST[os]) {
      const store = message(STORE_LABEL[os]).replace(/^Get the app on (the )?/, '');
      assert.ok(store && !message(step.text).includes(store), 'the home-screen path must not name a store');
    }
  }
});

test('#4400: the sheet shows a title, one card of steps and a full-width Got it', () => {
  const mod = loadTsx('frontend/src/features/mobile-install/install-steps-sheet.tsx');
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const html = renderToHtml(createElement(mod.InstallStepsContent, { os: 'ios', onClose() {} }));
  assert.match(html, /id="mobile-install-steps-title"[^>]*>Add Homeroom to your home screen</);
  assert.match(html, /id="mobile-install-steps-close"[^>]*aria-label="Close"/);
  // The card is the shell's GroupedList: 20px, one hairline, white.
  assert.match(html, /rounded-\[20px\] shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\] bg-white/);
  const items = [...html.matchAll(/<li /g)];
  assert.equal(items.length, 3);
  assert.match(html, /Tap Share in Safari&#x27;s toolbar/);
  assert.ok(html.indexOf('Tap Share') < html.indexOf('Choose Add to Home Screen'));
  assert.ok(html.indexOf('Choose Add to Home Screen') < html.indexOf('Open Homeroom from its icon'));
  // The share glyph rides the first step only.
  assert.equal((html.match(/<li [\s\S]*?<\/li>/g) || []).filter((li) => li.includes('<svg')).length, 1);
  // "Got it" is the shell's primary Button, full width.
  assert.match(html, /<button[^>]*id="mobile-install-steps-done"[^>]*class="[^"]*w-full[^"]*bg-violet-600[^"]*"[^>]*>Got it<\/button>/);

  const android = renderToHtml(createElement(mod.InstallStepsContent, { os: 'android', onClose() {} }));
  assert.match(android, /data-a2hs-os="android"/);
  assert.match(android, /Choose Add to Home screen/);
});

test('#4400: the sheet is presented through the kit sheet seam, and back closes it', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'frontend/src/features/mobile-install/install-steps-sheet.tsx'), 'utf8');
  assert.match(src, /adoptKitSurface\(\{\s*kind: 'sheet'/);
  assert.match(src, /createPortal\(/);
  assert.match(src, /pushDismissible\(/);
  assert.match(src, /role="dialog"/);
  assert.match(src, /aria-modal="true"/);
  // Without the kit: a sheet from the floor, over a scrim, above the strip (z-59).
  assert.match(src, /'fixed inset-0 z-\[70\] bg-black\/60 flex items-end justify-center'/);
  // The panel the kit adopts keeps one class string, or React would erase the
  // kit's `platform-sheet-adopted` on the re-render that adoption causes.
  assert.match(src, /id="mobile-install-steps"[\s\S]*?className="w-full max-w-md rounded-t-\[20px\]/);
});

test('#1513: the first render is still the hidden, offer-less strip', () => {
  // The island rule: no data at first render, so the prerender matches.
  const html = renderComponent(
    'frontend/src/features/mobile-install/install-banner.tsx',
    'MobileInstallBanner',
  );
  assert.match(html, /class="hidden /);
  assert.doesNotMatch(html, /Add it to your home screen/);
  assert.doesNotMatch(html, /Add to Home Screen\./);
  // `offer === null` is the "Get the app" placeholder, unchanged.
  assert.match(html, /Get the app/);
});

// ── The dismissal's lifetime ────────────────────────────────────────

test('#1514: the dismissal is session-scoped, and does not read the old forever key', () => {
  // The × used to write localStorage, which retired the offer on that device
  // permanently — including for everyone who tapped it before any store
  // listing existed. sessionStorage keeps it down for the tab (refreshes
  // included) and lets the next visit ask once more.
  //
  // Asserted on the source because the storage decision is not observable in
  // a rendered string: the strip's first render is hidden either way.
  const src = fs.readFileSync(
    path.join(ROOT, 'frontend/src/features/mobile-install/install-banner.tsx'), 'utf8');
  assert.match(src, /sessionStorage\.getItem\(DISMISS_KEY\)/);
  assert.match(src, /sessionStorage\.setItem\(DISMISS_KEY, '1'\)/);
  // Prose in the doc comment still names the retired store, so this looks for
  // a CALL rather than the word.
  assert.doesNotMatch(src, /localStorage\s*\.\s*(get|set)Item/,
    'reading the retired localStorage entry would pin exactly the people this frees');
});
