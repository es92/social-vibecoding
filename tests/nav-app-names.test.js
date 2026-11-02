'use strict';

// A project's name is kept with its slug (offline test, 2 Nov 2026).
//
// With the internet off, the Resume strip above the tab bar read
// "neighbourhood-swap-08832e" with an "N" tile where it had read
// "Neighbourhood Swap". The app had been opened while offline: neither the
// app view's own read nor the launcher's list had loaded, so the router
// captured it with its slug as the name, and parking that capture wrote over
// the name this device already had, in the strip AND in the apps you left.
// Nothing parks an app again until you open it and leave it, so the slug
// stayed after the network came back, and on the next cold start.
//
// What is pinned (frontend/src/features/nav/app-names.ts):
//   1. A STAND-IN NEVER REPLACES A NAME. The bridge's writers (park, running)
//      name a slug-only capture from what the device remembers: the community
//      list, the strips' own apps, the apps you left and the pins.
//   2. A NAME OF ITS OWN ALWAYS WINS: it is the record the router just read.
//   3. NOTHING REMEMBERED, NOTHING INVENTED: the slug still names a handle
//      nobody ever named.
//   4. AN ENTRY ALREADY STORED BY ITS SLUG is drawn by its name as soon as a
//      store knows it (both strips), and is never read from storage during a
//      render.
//   5. THE ROUTER asks the bridge (`knownApp`) for the App tab's header when
//      no list of apps has loaded (tests/nav-parked-app.test.js drives it).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NAMES = read('frontend/src/features/nav/app-names.ts');
const MOUNT = read('frontend/src/features/nav/mount.ts');

const SLUG = 'neighbourhood-swap-08832e';
const NAMED = { slug: SLUG, name: 'Neighbourhood Swap', iconUrl: null, iconEmoji: '🔁' };
const BY_SLUG = { slug: SLUG, name: SLUG, iconUrl: null, iconEmoji: null };

// A fresh bridge over a fake window with working storage, as the browser has
// it after a viewer is named. `fetch` is left out, so reading the pins from
// the account is a no-op.
function bridge() {
  const storage = new Map();
  const prev = global.window;
  global.window = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
  };
  const api = loadTsx('tests/fixtures/app-names-api.ts');
  const nav = global.window.UsernodeReact.nav;
  const restore = () => {
    if (prev === undefined) delete global.window;
    else global.window = prev;
  };
  const stored = (key) => JSON.parse(storage.get(key) || 'null');
  return { api, nav, storage, stored, restore };
}

test('THE REGRESSION: an app parked by its slug keeps the name it was left with', () => {
  const { api, nav, stored, restore } = bridge();
  try {
    nav.setViewer('ana');
    // Online: opened, named, and left. The strip and the apps you left say so.
    nav.park(NAMED);
    assert.equal(api.parkedStore.get().app.name, 'Neighbourhood Swap');
    // Offline: opened again. Going in clears the strip; the router captures
    // the app with no record behind it, so its name is its slug.
    nav.park(null);
    nav.running(BY_SLUG);
    assert.equal(api.runningAppStore.get().app.name, 'Neighbourhood Swap',
      'the app on screen is named from what the device remembers');
    nav.running(null);
    // …and leaving parks that capture.
    nav.park(BY_SLUG);
    assert.deepEqual({ ...api.parkedStore.get().app }, NAMED,
      'the strip keeps the name and the artwork, not the slug');
    assert.equal(stored(api.PARKED_KEY).name, 'Neighbourhood Swap',
      'in storage too, so a cold start offline draws the name');
    const recents = stored(api.RECENT_APPS_KEY);
    assert.equal(recents.apps[0].slug, SLUG);
    assert.equal(recents.apps[0].name, 'Neighbourhood Swap', 'and so do the apps you left');
  } finally {
    restore();
  }
});

test('the community list names a slug the strips never held', () => {
  const { api, nav, stored, restore } = bridge();
  try {
    nav.setViewer('ana');
    api.communityScopeStore.set({
      info: { [SLUG]: { slug: SLUG, name: 'Neighbourhood Swap', iconUrl: '/app-icons/swap', iconEmoji: null, iconColor: null } },
    });
    nav.park(BY_SLUG);
    assert.equal(api.parkedStore.get().app.name, 'Neighbourhood Swap');
    assert.equal(api.parkedStore.get().app.iconUrl, '/app-icons/swap', 'with its icon');
    assert.equal(stored(api.PARKED_KEY).name, 'Neighbourhood Swap');
  } finally {
    restore();
  }
});

test('a name of its own always wins, and nothing remembered leaves the slug', () => {
  const { api, nav, restore } = bridge();
  try {
    nav.setViewer('ana');
    nav.park(NAMED);
    // A rename, read by the app view: the record is the newer word.
    nav.park({ slug: SLUG, name: 'Swap Shop', iconUrl: null, iconEmoji: null });
    assert.equal(api.parkedStore.get().app.name, 'Swap Shop');
    // An app this device never named is still offered, by its slug.
    nav.park({ slug: 'whiteboard-ab12cd' });
    assert.equal(api.parkedStore.get().app.name, 'whiteboard-ab12cd');
    // A blank or slug-shaped community entry is not a name either
    // (community-scope's describe() starts an entry with name = slug).
    api.communityScopeStore.set({ info: { 'notes-ff00': { slug: 'notes-ff00', name: 'notes-ff00' } } });
    nav.park({ slug: 'notes-ff00', name: '' });
    assert.equal(api.parkedStore.get().app.name, 'notes-ff00');
  } finally {
    restore();
  }
});

test('the rule, as a pure function', () => {
  const { api, restore } = bridge();
  try {
    assert.equal(api.hasOwnName(NAMED), true);
    assert.equal(api.hasOwnName(BY_SLUG), false);
    assert.equal(api.hasOwnName({ slug: SLUG, name: '  ' }), false);
    assert.equal(api.hasOwnName(null), false);
    const sources = {
      info: { [SLUG]: { name: SLUG } },
      lists: [[null, BY_SLUG], [{ slug: SLUG, name: 'From recents', iconUrl: null, iconEmoji: null }], [NAMED]],
    };
    assert.equal(api.knownFace(SLUG, sources).name, 'From recents',
      'the first source with a name of its own answers');
    assert.equal(api.knownFace('other', sources), null);
    assert.equal(api.withKnownName(NAMED, sources), NAMED, 'a named app is returned as it is');
    assert.equal(api.withKnownName(null, sources), null);
  } finally {
    restore();
  }
});

test('the strips draw a slug-only entry by the name a store knows', () => {
  const { api, restore } = bridge();
  const before = {
    parked: api.parkedStore.get().app,
    running: api.runningAppStore.get().app,
  };
  try {
    api.parkedStore.set({ app: BY_SLUG });
    const unnamed = renderToHtml(createElement(api.ParkedStrip, {}));
    assert.match(unnamed, new RegExp(`platform-parked-name">${SLUG}<`),
      'with nothing remembered, the slug still names the handle');
    api.communityScopeStore.set({
      info: { [SLUG]: { slug: SLUG, name: 'Neighbourhood Swap', iconUrl: null, iconEmoji: null, iconColor: null } },
    });
    const strip = renderToHtml(createElement(api.ParkedStrip, {}));
    assert.match(strip, /platform-parked-name">Neighbourhood Swap</);
    assert.match(strip, /aria-label="Forget Neighbourhood Swap"/);
    assert.match(strip, new RegExp(`href="/app/${SLUG}"`), 'still resumes by its slug');
    assert.doesNotMatch(strip, new RegExp(`>${SLUG}<`));
    // iPhone Duo's side strip: the app on screen and the one you left.
    api.runningAppStore.set({ app: { ...BY_SLUG, slug: 'book-club-d10610', name: 'book-club-d10610' } });
    api.recentAppsStore.set({ apps: [{ slug: 'book-club-d10610', name: 'Book Club', iconUrl: null, iconEmoji: null, at: '' }] });
    const side = renderToHtml(createElement(api.SideApps, {}));
    assert.match(side, /aria-label="Book Club"/, 'the app on screen, by the name you left it with');
    assert.match(side, /aria-label="Resume Neighbourhood Swap"/, 'the app you left, by its name');
  } finally {
    api.parkedStore.set({ app: before.parked });
    api.runningAppStore.set({ app: before.running });
    restore();
  }
});

test('the wiring: every writer names its capture, the router can ask, and no render reads storage', () => {
  assert.match(MOUNT, /import \{ knownApp, withKnownName \} from '\.\/app-names';/);
  const park = MOUNT.slice(MOUNT.indexOf('    park(app: {'), MOUNT.indexOf('    running(app: {'));
  assert.match(park, /const parked = app && app\.slug \? withKnownName\(\{/);
  assert.ok(park.indexOf('withKnownName(') < park.indexOf('rememberRecentApp('),
    'named BEFORE the apps you left are written, or the slug replaces the name there');
  assert.match(park, /if \(parked\) rememberRecentApp\(parked, navStore\.get\(\)\.viewer\);\s*setParked\(parked\);/);
  assert.match(MOUNT, /setRunningApp\(app && app\.slug \? withKnownName\(\{/);
  assert.match(MOUNT, /knownApp\(slug: string\) \{\s*return knownApp\(slug\);\s*\}/);
  assert.match(read('frontend/src/features/nav/parked-strip.tsx'), /const named = useNamedApp\(shown\);/);
  assert.match(read('frontend/src/features/nav/side-apps.tsx'),
    /const parked = useNamedApp\(useStoreState\(parkedStore\)\.app as StripApp \| null\);/);
  // Memory only: the strips call this while rendering.
  assert.doesNotMatch(NAMES, /localStorage|readParked|readRecentApps|readPinnedApps/);
});
