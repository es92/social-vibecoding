// #1524 — signing out always ends on the PUBLIC LANDING page.
//
// ── What was wrong ─────────────────────────────────────────────────────
//
// A regular browser was already right: Settings.logout finished with a hard
// navigation to '/', which boots the anonymous shell on the landing screen.
// Three other surfaces were not.
//
//  1. The Homeroom mobile app's sign-out ends in a TERMINAL native call that
//     replaces the WebView, and the old document is forbidden continuation
//     work — so the address was deliberately left wherever it was, e.g.
//     `/#settings`. Anything that restores that WebView at that address
//     (Activity recreation, state restoration, a reload) re-enters
//     restoreFromHash with a hash, which is a DEEP LINK: remembered, and
//     answered with the bare sign-in form instead of the landing page.
//  2. When that terminal call FAILS — an app too old for semantic protocol 2,
//     a degraded bridge — server authority was already revoked but nothing
//     navigated at all. The user was left on a signed-in-looking Settings
//     screen under a red toast.
//  3. `location.href = '/'` PUSHES a history entry, so Back could restore the
//     signed-in document whole out of the BFCache.
//
// …and on every surface only the session snapshot was cleared, while
// main.tsx re-applies the remembered shell snapshot unconditionally at boot —
// so the landing page could wear the previous session's header title and
// Improve button.
//
// Ordering (realm close → server revocation → native teardown) is pinned
// separately, and in an executable sandbox, by tests/native-logout-order
// .test.js. This file pins the DESTINATION and the pieces that carry it.
//
// Run with: node --test tests/logout-landing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP = read('public/js/app.js');
const SETTINGS = read('frontend/src/features/settings/settings.js');
const WAITING = read('frontend/src/features/auth/waiting.tsx');

/** Slice one `name() { … }` object method out of a source file. */
function method(src, name) {
  const at = src.search(new RegExp(`^  (?:async )?${name}\\(\\) \\{$`, 'm'));
  assert.ok(at > -1, `${name} not found`);
  return src.slice(at, src.indexOf('\n  },', at) + 5);
}

// ── Why the address has to be normalised at all ────────────────────────

test('an anonymous deep link answers with sign-in, only a bare / lands', () => {
  // The branch the leftover `#settings` address falls into. This is the whole
  // reason the native path normalises before handing over the WebView: the
  // router cannot tell "signed out at /#settings" from "guest following a
  // link to /#settings", and it is right not to.
  const at = APP.indexOf('        if (!App.user) {');
  assert.ok(at > -1, 'the anonymous branch of restoreFromHash must exist');
  const anon = APP.slice(at, APP.indexOf('\n        if (App.user) {', at));

  assert.match(anon, /if \(!hash \|\| authRoute === 'waiting'\) \{\s*\n\s*AuthScreens\.show\('landing'\);/,
    'no fragment and no app path is the ONLY thing that reaches landing');
  assert.match(anon, /AuthScreens\.rememberDeepLink\(App\._deepLinkTarget\(\)\);\s*\n\s*AuthScreens\.show\('login'\);/,
    'every other address is remembered and answered with the sign-in form');
  // `hash` falls back to the clean app pathname above this branch, so a
  // sign-out from inside `/app/<slug>` is the same case.
  assert.match(APP, /let hash = rawHash\s*\n\s*\? \(qIdx === -1 \? rawHash : rawHash\.slice\(0, qIdx\)\)\s*\n\s*: pathRoute;/);
});

// ── Settings.logout: one destination, four surfaces ────────────────────

test('the landing URL is a bare /, not the router\'s _rootUrl', () => {
  assert.match(SETTINGS, /const LANDING_URL = '\/';/,
    "a bare '/' so a leftover ?shot= / ?signup= query cannot outlive the "
    + 'sign-out either');
  const logout = SETTINGS.slice(SETTINGS.indexOf('    async logout() {'));
  const body = logout.slice(0, logout.indexOf('\n    },'));
  assert.doesNotMatch(body, /_rootUrl/);
});

test('every exit from logout is a REPLACE, never a pushed entry', () => {
  const logout = SETTINGS.slice(SETTINGS.indexOf('    async logout() {'));
  const body = logout.slice(0, logout.indexOf('\n    },'));
  assert.doesNotMatch(body, /location\.href\s*=/,
    'an assigned href pushes an entry, and Back then restores the '
    + 'signed-in document out of the BFCache');
  assert.match(body, /window\.location\.replace\(LANDING_URL\)/);
});

test('the address is normalised in place before the terminal native call', () => {
  const logout = SETTINGS.slice(SETTINGS.indexOf('    async logout() {'));
  const body = logout.slice(0, logout.indexOf('\n    },'));
  const replaceStateAt = body.indexOf('history?.replaceState?.(null, \'\', LANDING_URL)');
  const revokeAt = body.indexOf("fetch('/api/auth/logout'");
  const terminalAt = body.indexOf('commitNativeLogout()');
  assert.ok(replaceStateAt > -1, 'replaceState must run');
  // AFTER the revocation: a logout that failed must leave the address still
  // describing the screen the user is looking at.
  assert.ok(replaceStateAt > revokeAt, 'normalise after server revocation');
  // …and BEFORE the hand-off, because the hand-off is terminal.
  assert.ok(replaceStateAt < terminalAt, 'normalise before the native call');
});

test('a BFCache restore of the signed-out document navigates away again', () => {
  const logout = SETTINGS.slice(SETTINGS.indexOf('    async logout() {'));
  const body = logout.slice(0, logout.indexOf('\n    },'));
  assert.match(body, /addEventListener\('pageshow'/);
  assert.match(body, /if \(event && event\.persisted\) window\.location\.replace\(LANDING_URL\);/);
  assert.match(body, /\{ once: true \}/, 'this document is on its way out either way');
});

test('the session residue goes with the session, not just the snapshot', () => {
  const logout = SETTINGS.slice(SETTINGS.indexOf('    async logout() {'));
  const body = logout.slice(0, logout.indexOf('\n    },'));
  // _dropCachedSession is the wider sweep: snapshot + shell snapshot +
  // Improve target + SW API cache + offline-ready markers. main.tsx applies
  // the shell snapshot unconditionally at boot, before the session is known.
  assert.match(body, /window\.App\?\._dropCachedSession\?\.\(\)/);
  assert.doesNotMatch(body, /clearSessionSnapshot/);
  assert.match(APP, /_dropCachedSession\(\) \{\s*\n\s*App\.clearSessionSnapshot\(\);/,
    'and it still starts by clearing the snapshot itself');
});

test('a native shutdown that never lands is bounded, not permanent', () => {
  assert.match(SETTINGS, /const NATIVE_LOGOUT_SAFETY_MS = 5000;/);
  const logout = SETTINGS.slice(SETTINGS.indexOf('    async logout() {'));
  const body = logout.slice(0, logout.indexOf('\n    },'));
  assert.match(body, /setTimeout\(\(\) => \{\s*\n\s*window\.location\.replace\(LANDING_URL\);\s*\n\s*\}, NATIVE_LOGOUT_SAFETY_MS\)/);
});

// ── The advisory that has to survive a navigation ──────────────────────

test('the two files agree on the one-shot advisory key', () => {
  const inSettings = SETTINGS.match(/const LOGOUT_NOTICE_KEY = '([^']+)';/);
  const inApp = APP.match(/LOGOUT_NOTICE_KEY: '([^']+)',/);
  assert.ok(inSettings && inApp, 'both sides declare the key');
  assert.equal(inSettings[1], inApp[1]);
  assert.equal(inSettings[1], 'sv:logout_notice');
});

test('the advisory copy is unchanged, and carries no em dash', () => {
  const copy = SETTINGS.match(/const NATIVE_SHUTDOWN_NOTICE =\s*\n\s*'([^']+)';/);
  assert.ok(copy, 'the advisory is a named constant');
  assert.equal(copy[1],
    'Signed out. Close and reopen the app to finish shutting down Homeroom.');
  // User-facing copy: no em dash in any encoding.
  const logout = SETTINGS.slice(SETTINGS.indexOf('    async logout() {'));
  const scopes = [
    SETTINGS.slice(SETTINGS.indexOf('  const LANDING_URL'),
      SETTINGS.indexOf('  const Settings = {')),
    logout.slice(0, logout.indexOf('\n    },')),
  ];
  for (const src of scopes) {
    const strings = src.match(/'[^'\n]*(\u2014|&mdash;|&#8212;|\\u2014)[^'\n]*'/g) || [];
    assert.deepEqual(strings, []);
  }
});

test('the advisory is written only where there is something to say', () => {
  const logout = SETTINGS.slice(SETTINGS.indexOf('    async logout() {'));
  const body = logout.slice(0, logout.indexOf('\n    },'));
  const writes = body.match(/setItem\?\.\(LOGOUT_NOTICE_KEY/g) || [];
  assert.equal(writes.length, 1, 'exactly one path has an advisory to hand on');
  // …and it is the native-failure path, which is also the only path that
  // still needs the user to do something.
  const failure = body.slice(body.indexOf('}, (error) => {'));
  assert.match(failure, /sessionStorage\?\.setItem\?\.\(LOGOUT_NOTICE_KEY, NATIVE_SHUTDOWN_NOTICE\)/);
  assert.match(failure, /window\.location\.replace\(LANDING_URL\)/);
});

// ── …and the anonymous boot that picks it up ───────────────────────────

test('enterAnonymous drains the advisory after the auth screens are up', () => {
  const body = method(APP, 'enterAnonymous');
  const enterAt = body.indexOf('AuthScreens.enter()');
  const drainAt = body.indexOf('App._drainLogoutNotice()');
  assert.ok(enterAt > -1 && drainAt > -1, 'both calls are present');
  assert.ok(drainAt > enterAt,
    'the toast must land on the landing page the user was just sent to');
});

/** `App._drainLogoutNotice` as a callable, lifted out of app.js by source. */
function drainIn(stored) {
  const toasts = [];
  const sandbox = {
    App: { LOGOUT_NOTICE_KEY: 'sv:logout_notice' },
    PlatformUI: { toast(message, opts) { toasts.push({ message, opts }); } },
    sessionStorage: stored && {
      getItem: (k) => (stored.has(k) ? stored.get(k) : null),
      removeItem: (k) => stored.delete(k),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`Object.assign(App, {${method(APP, '_drainLogoutNotice')}});`, sandbox);
  return { run: () => sandbox.App._drainLogoutNotice(), toasts };
}

test('the advisory is shown exactly once, then it is gone', () => {
  const stored = new Map([['sv:logout_notice', 'Signed out. Close and reopen.']]);
  const drain = drainIn(stored);

  drain.run();
  // Field-by-field: the objects are minted inside the vm realm, so they are
  // never reference-equal to a literal built out here.
  assert.equal(drain.toasts.length, 1);
  assert.equal(drain.toasts[0].message, 'Signed out. Close and reopen.');
  assert.equal(drain.toasts[0].opts.error, true);
  assert.equal(stored.has('sv:logout_notice'), false,
    'removed before it is shown, so a later anonymous boot stays silent');

  drain.run();
  assert.equal(drain.toasts.length, 1);
});

test('an ordinary anonymous boot says nothing, and neither does one with no storage', () => {
  const quiet = drainIn(new Map());
  quiet.run();
  assert.deepEqual(quiet.toasts, []);

  // Private mode / a sandboxed frame: no sessionStorage at all.
  const none = drainIn(null);
  assert.doesNotThrow(() => none.run());
  assert.deepEqual(none.toasts, []);
});

// ── The waiting room's own fallback ────────────────────────────────────

test('the waiting room falls back to the same destination and the same sweep', () => {
  // It only runs when the Settings chunk is unreachable, which is exactly
  // when it must not diverge.
  const at = WAITING.indexOf('const onLogout =');
  const body = WAITING.slice(at, WAITING.indexOf('\n  }, [stopWaitingPoll]);', at));
  assert.match(body, /w\.App\?\._dropCachedSession\?\.\(\)/);
  assert.match(body, /window\.location\.replace\('\/'\)/);
  assert.doesNotMatch(body, /window\.location\.href\s*=/);
  assert.doesNotMatch(body, /clearSessionSnapshot/);
});
