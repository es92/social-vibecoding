// PWA offline-mode (#487) shell wiring: pins the contracts that keep the
// offline boot complete and the manifest installable.
//
//  1. Precache-list sync — every local script/stylesheet referenced by
//     index.html appears in sw.js's SHELL_ASSETS, so a newly-added
//     <script> can't silently break offline boot, AND index.html loads
//     nothing cross-origin at all (Tailwind is compiled into
//     /css/tailwind.css, marked/DOMPurify/qrcodejs are vendored under
//     /vendor/ — so SHELL_ASSETS is the complete render set and a first
//     offline launch can never come up unstyled). (index.html is the single
//     shell document now — the old standalone auth pages are redirect stubs
//     into the SPA's hash routes; fold-auth-pages-into-SPA.)
//  2. Every SHELL_ASSETS entry maps to a source file under public/ or to an
//     explicitly declared image-generated asset (no dead precache entries,
//     which would 404 during install) — AND every /js/** entry is really
//     loaded by index.html. That second direction is new: existence alone let
//     #1038's /js/session-state.js sit precached but rendered by no <script>
//     tag, so window.SessionState was undefined at runtime and ~10 guarded
//     call sites in app.js / app-view.js silently took their fallback. A
//     precache entry no document loads is either a missing tag or a module
//     that should have been deleted; both are bugs, and neither is visible
//     from the forward check in 1.
//  3. manifest.webmanifest is valid and its icon files exist.
//  4. index.html carries the manifest link, theme-color and the offline
//     banner element, and loads the React bundle — which registers the SW
//     and owns the connectivity engine since #1078 retired /js/offline.js.
//  5. static-cache treats sw.js and the manifest as revalidate-every-load
//     shell assets.
//
// Run with: node --test tests/pwa-shell-wiring.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const sw = require('../public/sw.js');
const { MOUNT_ON_REVEAL, interiorHtmlFor } = require('./lib/lazy-interiors');
const IMAGE_GENERATED_ASSETS = new Set([
  '/css/tailwind.css',
  '/shell/assets/shell.js',
]);

function readPublic(rel) {
  return fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
}

// Local script srcs + stylesheet hrefs referenced by an HTML shell page.
function localAssets(html) {
  const out = new Set();
  for (const m of html.matchAll(/<script[^>]+src="(\/[^"]+)"/g)) out.add(m[1]);
  for (const m of html.matchAll(/<link[^>]+href="(\/[^"]+\.css)"/g)) out.add(m[1]);
  return [...out];
}

// Cross-origin scripts / stylesheets referenced by an HTML shell page.
// Expected to be empty — see the invariant test below.
function crossOriginAssets(html) {
  const out = new Set();
  for (const m of html.matchAll(/<script[^>]+src="(https?:\/\/[^"]+)"/g)) out.add(m[1]);
  for (const m of html.matchAll(/<link[^>]+href="(https?:\/\/[^"]+)"/g)) out.add(m[1]);
  return [...out];
}

test('sw.js precaches every local asset index.html loads', () => {
  const html = readPublic('index.html');
  for (const asset of localAssets(html)) {
    assert.ok(
      sw.SHELL_ASSETS.includes(asset),
      `index.html loads ${asset} but sw.js SHELL_ASSETS doesn't precache it`
    );
  }
});

// The invariant that replaced the old CDN_ASSETS sync check: there is no
// third-party origin in the shell's critical path any more, so precaching
// SHELL_ASSETS is sufficient to render offline. Adding a CDN <script> back
// would silently reintroduce an unstyled/degraded offline boot and a
// dependency on someone else's uptime — compile it (npm run build:css) or
// vendor it (npm run vendor:assets) instead.
test('index.html loads no cross-origin scripts or stylesheets', () => {
  const offOrigin = crossOriginAssets(readPublic('index.html'));
  assert.deepEqual(
    offOrigin, [],
    `index.html must load every asset from its own origin; found: ${offOrigin.join(', ')}`
  );
});

// The native kit's demo page is served by this app too, and shares the one
// compiled stylesheet rather than pulling the Tailwind Play CDN.
test('the usernode-native demo page uses the compiled stylesheet, not a CDN', () => {
  const demo = readPublic('usernode-native/v1/demo.html');
  assert.deepEqual(crossOriginAssets(demo), []);
  assert.ok(demo.includes('<link rel="stylesheet" href="/css/tailwind.css">'),
    'demo.html should load the platform\'s compiled Tailwind');
});

test('sw.js precaches the shell page itself and the manifest, not the stubs', () => {
  for (const must of ['/index.html', '/manifest.webmanifest']) {
    assert.ok(sw.SHELL_ASSETS.includes(must), `SHELL_ASSETS missing ${must}`);
  }
  // The old standalone pages are redirect stubs — precaching them would
  // waste install work and could pin a stale redirect.
  for (const stub of ['/login.html', '/landing.html', '/register.html', '/waiting.html']) {
    assert.ok(!sw.SHELL_ASSETS.includes(stub), `SHELL_ASSETS still precaches stub ${stub}`);
  }
});

// The deployed form of the same invariant. A document generated with a
// GIT_SHA loads every script and stylesheet from /b/<sha>/… (scripts/
// shell-stamp.js), and the worker's precache stores exactly those addresses,
// derived from SHELL_ASSETS by shellAssetUrl(). So: every scoped URL the
// deployed document loads must be the scoped form of a SHELL_ASSETS entry,
// every script and stylesheet must BE scoped (a plain path left behind would
// be revalidated on every load — the cost this scheme removes), and the
// manifest and icons must stay plain.
test('a deployed document loads only build-scoped forms of SHELL_ASSETS', () => {
  const { prefixShellAssetUrls } = require('../scripts/shell-stamp');
  const sha = 'abc1234def5678';
  const deployed = prefixShellAssetUrls(readPublic('index.html'), sha);
  const scoped = new Set(sw.SHELL_ASSETS.map((p) => sw.shellAssetUrl(p, sha)));
  const assets = localAssets(deployed);
  assert.ok(assets.length >= 30, `expected the shell's ~34 assets, saw ${assets.length}`);
  for (const asset of assets) {
    assert.ok(scoped.has(asset), `the deployed document loads ${asset}, which is not the scoped form of any SHELL_ASSETS entry`);
    const parsed = sw.parseBuildScopedPath(asset);
    if (/\.(?:js|css)$/i.test(asset)) {
      assert.ok(parsed && parsed.build === sha, `${asset} should be scoped under /b/${sha}/`);
    } else {
      assert.equal(parsed, null, `${asset} is not a script or stylesheet and must keep its plain URL`);
    }
  }
  assert.ok(assets.some((a) => a === `/b/${sha}/shell/assets/shell.js`), 'the React entry is scoped');
  assert.ok(assets.some((a) => a === `/b/${sha}/js/app.js`), 'the body scripts are scoped');
  assert.ok(!deployed.includes('/b/' + sha + '/manifest.webmanifest'), 'the manifest keeps its URL');
  assert.ok(!deployed.includes('/b/' + sha + '/sw.js'), 'the worker keeps its URL');
});

test('every SHELL_ASSETS entry exists in source or is generated by the image build', () => {
  for (const asset of sw.SHELL_ASSETS) {
    if (IMAGE_GENERATED_ASSETS.has(asset)) continue;
    const file = path.join(PUBLIC, asset.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `SHELL_ASSETS lists ${asset} but ${file} doesn't exist`);
  }
});

// The reverse of the first test. Existence is not enough: a /js/** module can
// be precached, present on disk, and loaded by nothing — which is not a dead
// 404 but a dead MODULE. It costs install bandwidth, it reads as wired when
// anyone greps SHELL_ASSETS, and if its consumers guard on the global it
// publishes (`if (window.Foo)`), the failure is silent forever. That is the
// exact shape of the /js/session-state.js bug: shipped in SHELL_ASSETS by
// #1038, never given a <script> tag in Shell.tsx, so every consumer took its
// fallback path and app-view.js's module-scope onEvent/subscribe registration
// never ran.
//
// Scoped to /js/** deliberately — the rest of SHELL_ASSETS is the document
// itself, the manifest, icons, vendored libs and the compiled stylesheet,
// which are fetched by things other than a <script src>.
test('every precached /js/** module is actually loaded by index.html', () => {
  const loaded = new Set(localAssets(readPublic('index.html')));
  const orphans = sw.SHELL_ASSETS
    .filter((a) => a.startsWith('/js/'))
    .filter((a) => !loaded.has(a));
  assert.deepEqual(
    orphans, [],
    `sw.js precaches ${orphans.join(', ')}, but public/index.html loads no such script.\n`
    + 'Either the <script> tag is missing from frontend/src/Shell.tsx (rebuild with '
    + 'npm run build:shell) or the module is dead and both the file and the SHELL_ASSETS '
    + 'entry should go. A precached module nobody loads publishes no global, and guarded '
    + 'consumers fail silently.',
  );
});

test('manifest.webmanifest is valid and installable', () => {
  const manifest = JSON.parse(readPublic('manifest.webmanifest'));
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length > 0);
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2,
    'manifest needs at least two icons');
  for (const icon of manifest.icons) {
    const file = path.join(PUBLIC, icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `manifest icon ${icon.src} doesn't exist`);
    // PNG magic bytes — the generator must have produced real images.
    const head = fs.readFileSync(file).subarray(0, 8);
    assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${icon.src} is not a PNG`);
  }
  const purposes = manifest.icons.map((i) => i.purpose);
  assert.ok(purposes.includes('maskable'), 'manifest needs a maskable icon');
});

// ── What the PRECACHED document paints, vs what a loaded page shows ─────
//
// public/index.html is precached (SHELL_ASSETS above) and served on a 200ms
// deadline, so on most loads it is what the viewer sees FIRST — for the whole
// parse-and-hydrate window, before auth, routing or any fetch has answered.
// Everything it states that the loaded page then contradicts is a visible
// discontinuity, and each of the three below was one.

test('the precached document names the platform, and does not guess a theme', () => {
  const html = readPublic('index.html');
  const head = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'head.html'), 'utf8'
  );

  // 1. THE NAME. Both the tab title and the header chip said "dApps" — the
  //    name this shell carried before the platform had one — until routing
  //    replaced it with "Homeroom". Nothing else in the product says
  //    "dApps": not the manifest, not the header on home, not the landing
  //    page. The neutral starting value and the right one are the same
  //    string, so there is no reason for it to be the wrong one.
  assert.match(head, /<title>Homeroom<\/title>/);
  // Comments stripped: the note in head.html explains the very string it is
  // banning, and prose about a name is not a name.
  const shipped = html.replace(/<!--[\s\S]*?-->/g, ' ');
  assert.doesNotMatch(shipped, /dApps/,
    'the cached document must not name the product something no other surface calls it');
  const store = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'header', 'header-title-store.js'),
    'utf8'
  );
  assert.match(store, /text: 'Homeroom'/,
    "the chip's INITIAL is what the prerender renders — they are one constant");

  // 2. THE THEME. `<html class="dark">` was hardcoded into the artifact, so
  //    the precached document was a DARK document for everybody. The theme is
  //    a per-viewer decision (localStorage, else the OS preference) and the
  //    head-blocking module is the only thing that can make it; an artifact
  //    that asserts one is wrong for every reader that does not run scripts,
  //    and it is the one fact the file cannot know.
  assert.match(html, /<html lang="en">/);
  assert.doesNotMatch(html, /<html[^>]*class="[^"]*dark/);
  // The module still decides, before first paint, exactly as it did.
  assert.match(head, /document\.documentElement\.classList\.add\('dark'\)/);

  // 3. THE LAUNCHER'S SPACE, and what now fills it. The prerendered #app-list
  //    used to be EMPTY: the areas below it slid down two rows when the bundle
  //    hydrated and the grid finally drew its skeleton, and for the whole
  //    parse-and-hydrate window — ~2.2s on a 4x-throttled cold load — the home
  //    screen showed a blank launcher, which does not read as "loading", it
  //    reads as "you have no apps".
  //
  //    The placeholders are in the PRERENDER now (app-grid.tsx renders them
  //    from the INITIAL store, so Node and the first client render produce the
  //    same tree and nothing mismatches). The CSS reservation stays: it is
  //    keyed on the `data-view` app-grid.tsx sets on its first ready render, so
  //    it still holds the height for the states that draw no tiles — a notice,
  //    or a document whose bundle never arrives — and it never pads a loaded
  //    grid, including the empty one a brand new account has.
  assert.match(readPublic('index.html'), /id="app-list"[^>]*>\s*<div class="sr-only" role="status">Loading your apps<\/div>/,
    'the prerendered grid ships the placeholders, not a blank');
  assert.match(readPublic('index.html'), /id="app-list"[\s\S]{0,400}?animate-pulse/,
    'and they pulse, so the first painted frame says the grid is coming');
  assert.doesNotMatch(readPublic('index.html'), /id="app-list"[^>]*data-view=/,
    'and carries no data-view until the grid has rendered once');
  assert.match(readPublic('css/app.css'),
    /#app-list:not\(\[data-view\]\) \{[^}]*min-height: calc\(2 \* var\(--home-cell-h\)\)/);
});

test('index.html wires up the manifest, the banner, and the React bundle', () => {
  const html = readPublic('index.html');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<meta name="theme-color"/);
  assert.match(html, /id="offline-banner"/);
  // The SW used to be registered by <script src="/js/offline.js">. #1078
  // converted the offline banner to a React island and retired that module,
  // so the registration moved into the React bundle — which is the one
  // module script the document loads.
  assert.doesNotMatch(html, /<script[^>]+\/js\/offline\.js/,
    'offline.js was retired in #1078; index.html must not still load it');
  assert.match(html, /<script type="module"[^>]+src="\/shell\/assets\/shell\.js"/,
    'the React bundle (which now registers the SW) must be loaded');
});

test('login.html is a redirect stub with no shell wiring of its own', () => {
  const html = readPublic('login.html');
  assert.match(html, /location\.replace\(/);
  // A stub must not register the SW or load app modules — the SPA it
  // redirects into owns all of that.
  assert.doesNotMatch(html, /offline\.js/);
  assert.doesNotMatch(html, /manifest\.webmanifest/);
});

test('the React bundle registers the service worker at root scope', () => {
  // Source-level, because the built bundle is minified: the registration
  // module is asserted by name, and main.tsx must actually call it. Root
  // scope ('/sw.js', not '/js/sw.js') is what lets the SW control every
  // navigation — a scope regression only shows up as "offline boot stopped
  // working", long after the change.
  const mod = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'service-worker.ts'), 'utf8',
  );
  assert.match(mod, /serviceWorker/);
  assert.match(mod, /register\('\/sw\.js'\)/);

  const entry = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'main.tsx'), 'utf8',
  );
  assert.match(entry, /bootStep\('registerServiceWorker', registerServiceWorker\)/,
    'main.tsx must call registerServiceWorker() — nothing else does — and it '
    + 'goes through bootStep so a throw there cannot abort hydration (#1670)');

  // tests/shell-build.test.js pins the image builder that compiles this entry
  // and copies the resulting bundle into the runtime. There is deliberately
  // no committed shell.js byte fixture to become stale or conflict in Git.
});

test('the offline engine kept window.Offline and its consumers', () => {
  // Six call sites across app.js, app-view.js, home.js and auth-screens.js
  // reach for this global, and app.js's ?shot=offline / ?shot=offline-signin
  // deep links depend on forceOffline() specifically — those captures are the
  // only way the offline UI can be photographed on a working network.
  const mod = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'offline.ts'), 'utf8',
  );
  assert.match(mod, /Offline: OfflineApi \}\)\.Offline = api/,
    'lib/offline.ts must install window.Offline');
  for (const member of ['isOffline', 'nudge', 'forceOffline', 'probe']) {
    assert.ok(mod.includes(member), `window.Offline lost its ${member}() member`);
  }
  // The body class every offline affordance in app.css hangs off, and the
  // event other modules re-render on.
  assert.match(mod, /classList\.toggle\('is-offline'/);
  assert.match(mod, /usernode:offline-change/);
  // /health, uncached — the SW bypasses it so the probe reflects real
  // reachability rather than a cached copy.
  assert.match(mod, /fetch\('\/health', \{ cache: 'no-store' \}\)/);
});

test('sw.js and manifest.webmanifest get the revalidate-every-load header', () => {
  const { shellAssetCacheControl, REVALIDATE } = require('../src/services/static-cache');
  assert.equal(shellAssetCacheControl('/srv/public/sw.js'), REVALIDATE);
  assert.equal(shellAssetCacheControl('/srv/public/manifest.webmanifest'), REVALIDATE);
  // Icons stay on the default policy (they're content-stable PNGs).
  assert.equal(shellAssetCacheControl('/srv/public/icons/icon-192.png'), null);
});

test('offline affordances only gate the anonymous auth screens (#1021)', () => {
  // The auth screens' interiors mount on first reveal (lib/mount-on-reveal.ts),
  // so the prerendered document carries NONE of these affordances — a
  // stronger form of the rule this test has always pinned — and each lives
  // in the interior of the screen that owns it.
  const html = readPublic('index.html');
  assert.equal(html.match(/data-offline-disabled/g), null,
    'data-offline-disabled in the prerendered document — the auth interiors mount on reveal');
  // Both places an offline visitor can land carry an explanation.
  for (const id of ['auth-landing-screen', 'auth-login-screen']) {
    assert.ok(interiorHtmlFor(id).includes('class="offline-only'),
      `the ${id} interior should explain the offline state`);
  }
  // data-offline-disabled greys a control out AND blocks its clicks, so a
  // stray one in the authed shell would silently break a working feature
  // for anyone whose probe is briefly failing. Keep them confined to the
  // auth overlays, whose actions genuinely cannot work offline.
  for (const { id } of MOUNT_ON_REVEAL) {
    if (id === 'auth-landing-screen' || id === 'auth-login-screen') continue;
    assert.equal(interiorHtmlFor(id).match(/data-offline-disabled/g), null,
      `data-offline-disabled in ${id}, outside the two screens that gate on it`);
  }
});

test('the offline state is styled from the committed stylesheet, not inline', () => {
  // body.is-offline is toggled by src/lib/offline.ts and every visual consequence
  // lives in app.css — nothing here depends on a Tailwind utility that
  // would have to be generated for a class name built at runtime.
  const css = readPublic('css/app.css');
  for (const sel of ['body.is-offline', '.offline-only', '[data-offline-disabled]']) {
    assert.ok(css.includes(sel), `app.css has no ${sel} rule`);
  }
});

// ── registerServiceWorker() may never throw ─────────────────────────────
//
// main.tsx calls it at MODULE SCOPE, above
// `flushSync(() => hydrateRoot(document.body, <Shell />))`. So a throw here
// aborts the entry module before hydration starts: React never adopts the
// document, every island stays the empty markup the prerender shipped,
// window.Offline is never installed, and the legacy public/js/** scripts run
// against a shell with no reconciler behind it. The viewer gets a static page
// that paints once and then goes blank when the router reveals an empty
// screen.
//
// The guard that used to stand there was `'serviceWorker' in navigator`,
// which tests for the ATTRIBUTE. WebKit installs the attribute and hands back
// `undefined` — or throws SecurityError off the getter — wherever the worker
// is unavailable to the page: a WKWebView whose host app has not opted its
// domains into WKAppBoundDomains, a WKWebsiteDataStore.nonPersistent() store,
// Safari with site data blocked. Every one of those passed the `in` test and
// then dereferenced undefined on the next line, which is how an iOS-app-only
// blank screen came out of a precache nicety.
//
// Driven rather than grepped: the whole point is that the shapes below are
// the ones a source read looks fine against.
const { loadTsx } = require('./lib/render-tsx');

function withNavigator(value, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { ...value, configurable: true });
  try { return fn(); } finally {
    Object.defineProperty(globalThis, 'navigator', original);
  }
}

/** A container whose register() resolves, recording what it was asked. */
function workingContainer(calls) {
  return {
    register: (scope) => { calls.push(['register', scope]); return Promise.resolve({}); },
    addEventListener: (type) => { calls.push(['addEventListener', type]); },
  };
}

test('registerServiceWorker survives every shape a WebView presents', () => {
  const mod = loadTsx('frontend/src/lib/service-worker.ts');

  // The shape that produced the bug: attribute present, object missing.
  withNavigator({ value: { serviceWorker: undefined } }, () => {
    assert.doesNotThrow(() => mod.registerServiceWorker(),
      'a present-but-undefined navigator.serviceWorker must not take out hydration');
  });

  // WebKit throws SecurityError off the GETTER when site data is blocked.
  withNavigator({ get() { throw new Error('SecurityError'); } }, () => {
    assert.doesNotThrow(() => mod.registerServiceWorker(),
      'a throwing navigator.serviceWorker getter must not take out hydration');
  });

  // Present, but not a container (no register()).
  withNavigator({ value: { serviceWorker: {} } }, () => {
    assert.doesNotThrow(() => mod.registerServiceWorker(),
      'an object without register() must not take out hydration');
  });

  // register() throws SYNCHRONOUSLY — the blocked-storage SecurityError, which
  // the old `.catch()` alone could never see.
  withNavigator({
    value: {
      serviceWorker: {
        register() { throw new Error('SecurityError'); },
        addEventListener() {},
      },
    },
  }, () => {
    assert.doesNotThrow(() => mod.registerServiceWorker(),
      'a synchronous throw from register() must not take out hydration');
  });

  // And the ordinary rejection stays handled, so it raises no unhandled
  // rejection (which Playwright reports as a pageerror, failing every route).
  withNavigator({
    value: {
      serviceWorker: {
        register: () => Promise.reject(new Error('nope')),
        addEventListener() {},
      },
    },
  }, () => {
    assert.doesNotThrow(() => mod.registerServiceWorker());
  });
});

test('registerServiceWorker still registers at root scope when it can', () => {
  const mod = loadTsx('frontend/src/lib/service-worker.ts');
  const calls = [];
  withNavigator({ value: { serviceWorker: workingContainer(calls) } }, () => {
    mod.registerServiceWorker();
  });
  assert.deepStrictEqual(calls, [['addEventListener', 'message'], ['register', '/sw.js']],
    'the api-updated listener is attached, then the worker registers at root scope');
});
