// Which screen a cold document SHOWS, before the router has decided.
//
// ── The lie this replaces ──────────────────────────────────────────────
//
// The prerender ships `#home-screen` visible and every other root hidden,
// because a static render has no route to read. public/sw.js then serves that
// document to every navigation it can win, so the home feed was the first
// thing painted on EVERY address — a board deep link, a settings link, a
// signed-out visitor headed for the marketing page.
//
// Measured on a 4x-throttled cold load of `/app/<slug>/board`: home visible at
// 263ms, home's own launcher skeleton filling in at 1744ms, the app view
// finally taking over at 2225ms. Two seconds of watching the wrong page load,
// and the skeleton made it worse — a screen that is visibly working is a
// screen you believe.
//
// ── Why it runs where it runs ──────────────────────────────────────────
//
// At app.js MODULE SCOPE, not on DOMContentLoaded and not after hydration.
// app.js is a classic script at the end of <body> and the React entry is a
// deferred module, so this is the earliest moment the roots exist. The two
// later seams were both measured and both lose: `init()` awaits
// `/api/auth/me` (a 2s budget) before it can route, and hydration itself
// landed at ~2000ms in the same trace. With a slow session endpoint the right
// screen is up at 653ms instead of ~2450ms.
//
// Run with: node --test tests/boot-screen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP = read('public/js/app.js');

/**
 * `App._bootScreenFor` as a callable, lifted out of app.js by source.
 *
 * It is a PURE function of (hash, pathname, signedIn) precisely so it can be
 * exercised rather than pattern-matched: the mapping is the thing that has to
 * be right, and a regex over its source proves only that somebody typed a
 * screen id near a route name.
 */
function bootScreenFor() {
  const at = APP.indexOf('App._bootScreenFor = function');
  assert.ok(at > -1, 'App._bootScreenFor not found');
  const src = APP.slice(at, APP.indexOf('\n};', at) + 3);
  const sandbox = { App: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.App._bootScreenFor;
}

// ── Signed in ──────────────────────────────────────────────────────────

test('a signed-in address resolves to the root it lands on', () => {
  const f = bootScreenFor();
  for (const [hash, expected] of [
    ['#app/demo-app/board', 'app-view'],
    ['#app/demo-app/activity', 'app-view'],
    ['#app/demo-app/dev/sessions/12', 'app-view'],
    ['#apps', 'browse-screen'],
    ['#apps/demo-app', 'browse-screen'],
    ['#settings', 'settings-screen'],
    ['#settings/notifications', 'settings-screen'],
    ['#admin', 'admin-screen'],
    ['#messages', 'messages-screen'],
    // Global Chat's old address, removed with it: the inbox opens.
    ['#chat/95df0790-4873-43cc-9608-728f3349da50', 'messages-screen'],
    ['#leaderboard', 'leaderboard-screen'],
  ]) {
    assert.equal(f(hash, '/', true), expected, `${hash} → ${expected}`);
  }
});

test('home and anything unrecognised leave the prerender alone', () => {
  const f = bootScreenFor();
  // null means "do nothing", and the prerender already shows home. An address
  // this has not heard of gets today's behaviour rather than an invented guess.
  assert.equal(f('', '/', true), null, 'the bare root is home');
  assert.equal(f('#', '/', true), null);
  assert.equal(f('#nonsense/deep/path', '/', true), null);
  // #notifications is a SHEET presented over whatever screen you are on, and
  // on a cold boot that screen is home. Revealing a root for it would be wrong.
  assert.equal(f('#notifications', '/', true), null);
});

test('a clean /app/<slug> path counts, not just the fragment', () => {
  // The router reads both spellings (`_appRouteFromPath`), and the clean path
  // is what an app address normalises to — so a reload of an open app arrives
  // with no fragment at all.
  const f = bootScreenFor();
  assert.equal(f('', '/app/demo-app', true), 'app-view');
  assert.equal(f('', '/app/demo-app/board', true), 'app-view');
  assert.equal(f('', '/apps', true), null, '/apps is not an app route');
  assert.equal(f('', '/app/', true), null, 'a slugless /app/ names no app');
});

// ── Signed out ─────────────────────────────────────────────────────────

test('signed out, the anonymous shell outranks the route', () => {
  const f = bootScreenFor();
  // A signed-out DEEP LINK lands on the landing screen, which opens its
  // sign-in sheet titled for the link (AuthScreens.showSignInFor, #5264).
  // It used to land on the full-page sign-in form. An app PATH counts too:
  // the board deep link once showed no screen at all.
  assert.equal(f('#app/demo-app/board', '/', false), 'auth-landing-screen');
  assert.equal(f('#settings', '/', false), 'auth-landing-screen');
  assert.equal(f('', '/app/demo-app', false), 'auth-landing-screen');
  // …and the bare root does land on the marketing page.
  assert.equal(f('', '/', false), 'auth-landing-screen');
  // 'waiting' with no session is nobody's queue: the router sends it to
  // landing, so this does too.
  assert.equal(f('#waiting', '/', false), 'auth-landing-screen');
  // The auth screens themselves resolve to themselves.
  assert.equal(f('#login', '/', false), 'auth-login-screen');
  assert.equal(f('#signup', '/', false), 'auth-login-screen');
  assert.equal(f('#register/CODE', '/', false), 'auth-register-screen');
  // A bare #waitlist opens Continue on the landing (#5261); check your
  // status is the waitlist screen.
  assert.equal(f('#waitlist', '/', false), 'auth-landing-screen');
  assert.equal(f('#waitlist?confirm=1', '/', false), 'auth-waitlist-screen');
});

test('a public profile is the one address that answers the same either way', () => {
  const f = bootScreenFor();
  assert.equal(f('#profile/someone', '/', false), 'profile-screen',
    'no session needed to read a public profile');
  assert.equal(f('#profile/someone', '/', true), 'profile-screen');
  // The viewer's OWN profile is a signed-in screen, and signed out it is a
  // deep link like any other.
  assert.equal(f('#profile', '/', true), 'profile-screen');
  assert.equal(f('#profile', '/', false), 'auth-landing-screen');
});

// ── How it is applied ──────────────────────────────────────────────────

test('it runs at module scope, guarded, and writes BOTH owners', () => {
  // Module scope: the whole win is being earlier than DOMContentLoaded, which
  // is where App.init() — and its awaited /api/auth/me — begins.
  const call = APP.indexOf('App._applyBootScreen();');
  const hook = APP.indexOf("document.addEventListener('DOMContentLoaded'");
  assert.ok(call > -1 && hook > -1 && call < hook,
    'the call sits at module scope, ahead of the DOMContentLoaded hook — being '
    + 'earlier than App.init() is the entire win');
  assert.match(APP, /typeof document\.getElementById === 'function'/,
    'guarded: a dozen harnesses run this file as a script against a stub '
    + 'document, and a throw here would take App down with it');

  const at = APP.indexOf('App._revealBootScreen = function');
  assert.ok(at > -1, 'App._revealBootScreen not found');
  const body = APP.slice(at, APP.indexOf('\n};', at));
  // BOTH halves, and this is the load-bearing part. Publishing alone leaves
  // React rendering `hidden` over a document that still says visible, which is
  // a hydration mismatch — a console error, which fails proposal checks.
  // Writing the class alone is a write into React-owned DOM that the first
  // render reconciles away.
  assert.match(body, /App\.Visibility\.publish\(id, visible\)/, 'it publishes…');
  assert.match(body, /classList\.toggle\('hidden', !visible\)/, '…and writes the class');
  assert.match(body, /REACT_SCREEN_IDS\.includes\(id\)/,
    'the publish is for the converted roots; the class is for every root');
});

test('the snapshot read is a boolean question, never an identity one', () => {
  const at = APP.indexOf('App._applyBootScreen = function');
  const body = APP.slice(at, APP.indexOf('\n};', at));
  assert.match(body, /!!App\.readSessionSnapshot\(\)/,
    'coerced at the call site: it asks whether this device was signed in, '
    + 'never who as — the cookie stays the sole credential');
  assert.ok(!/isAdmin|hasPlatformAccess/.test(body),
    'no privilege is derived from it');
});
