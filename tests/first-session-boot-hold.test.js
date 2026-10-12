// "What do you want to make?" across a sign-in that reloads, with no Home first.
//
// Evan, 10 Oct 2026, iPhone, from the waitlist's "You're in" mail: after
// choosing a username, Home flashed before the make screen. The story's sheet
// hands a new account to the make screen in one tick when the page stays put
// (features/first-session openMake, from `sv:authed`). But a sign-in on a
// page older than the live build reloads onto it first
// (AuthScreens.finishLogin -> App._moveToLiveShell), and the new document's
// prerendered markup is Home, painted before any script runs; with the
// session snapshot cleared by the sign-in, the boot then waited on
// /api/auth/me and showed the landing too. Reproduced in a browser by forcing
// that reload: Home's skeleton, then the landing, then the make screen.
//
// Two changes, pinned here:
//   1. finishLogin keeps the session it just confirmed before it reloads, so
//      the new page starts from the snapshot and draws the make screen in
//      the tick it boots.
//   2. A head-blocking script holds the body hidden (the page ground shows)
//      while the make flag is set, and the shell lifts the hold once it has
//      drawn its first screen, or boots signed out or into the waiting room.
//
// Run with: node --test tests/first-session-boot-hold.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const HEAD = read('frontend/src/head.html');
const APP = read('public/js/app.js');
const AUTH_SCREENS = read('public/js/auth-screens.js');
const FIRST_SESSION = read('frontend/src/features/first-session/index.tsx');
const LANDING = read('frontend/src/features/auth/landing.tsx');

const MAKE_FLAG = /const MAKE_FLAG = '([^']+)';/.exec(FIRST_SESSION)[1];
const SNAPSHOT_KEY = /SESSION_SNAPSHOT_KEY: '([^']+)',/.exec(APP)[1];

// The head's hold script, the one inline block that reads the make flag.
function holdScript() {
  const blocks = [...HEAD.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const hold = blocks.filter((b) => b.includes('first-session-boot'));
  assert.equal(hold.length, 1, 'one inline script adds the hold');
  return hold[0];
}

// `saved` is the browser's saved session (App.SESSION_SNAPSHOT_KEY): one is
// there unless a case says otherwise, and `null` stands for none.
function runHold(flag, { search = '', hash = '', saved = '{"user":{"id":7}}', blocked = false } = {}) {
  const classes = new Set();
  const timers = [];
  const sandbox = {
    URLSearchParams,
    location: { search, hash },
    sessionStorage: { getItem: (k) => (k === MAKE_FLAG ? flag : null) },
    localStorage: { getItem: (k) => { if (blocked) throw new Error('blocked'); return k === SNAPSHOT_KEY ? saved : null; } },
    document: { documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
  };
  vm.runInNewContext(holdScript(), sandbox);
  return { classes, timers };
}

test('the head holds the body only while the make flag is set, with a floor', () => {
  // The same key the story's sheet sets and the first session reads.
  assert.ok(LANDING.includes(`sessionStorage.setItem('${MAKE_FLAG}', '1')`), 'the sheet sets the flag');
  assert.ok(holdScript().includes(`sessionStorage.getItem('${MAKE_FLAG}') === '1'`), 'the head reads the same key');

  const held = runHold('1');
  assert.deepEqual([...held.classes], ['first-session-boot']);
  assert.equal(held.timers.length, 1);
  assert.equal(held.timers[0].ms, 8000, 'whatever happens, the page shows within 8 seconds');
  held.timers[0].fn();
  assert.equal(held.classes.size, 0, 'the floor lifts it');

  for (const flag of [null, '0', '']) {
    const free = runHold(flag);
    assert.equal(free.classes.size, 0, `no hold for ${JSON.stringify(flag)}`);
    assert.equal(free.timers.length, 0);
  }

  // A "You're in" mail's link opens signed out on the landing (Evan, 10 Oct
  // 2026: from the phone app, Home showed first): held too, on either of the
  // two shapes sendWaitlistReleaseMail writes, and only on those.
  const MAIL = read('src/services/mail/index.js');
  assert.match(MAIL, /`\$\{PRODUCTION_ORIGIN\}\/\?login=1`/);
  assert.match(MAIL, /`\$\{PRODUCTION_ORIGIN\}\/\?signup=1/);
  for (const search of ['?signup=1&t=abc&key=def', '?signup=1', '?login=1']) {
    assert.deepEqual([...runHold(null, { search }).classes], ['first-session-boot'], search);
  }
  for (const [search, hash] of [['', ''], ['?shot=dark', ''], ['?signup=1', '#login']]) {
    assert.equal(runHold(null, { search, hash }).classes.size, 0, `${search}${hash}: no hold`);
  }

  // Inline, beside the page ground, so it holds with no stylesheet at all.
  const style = /<style>([\s\S]*?)<\/style>/.exec(HEAD)[1];
  assert.match(style, /html\.first-session-boot body \{ visibility: hidden; \}/);
  // Head-blocking, after the theme block that must run first.
  assert.ok(HEAD.indexOf('window.Theme') < HEAD.indexOf("classList.add('first-session-boot')"));
});

// Evan, 10 Oct 2026: refreshing the signed-out welcome page showed Home's
// skeleton before it. A browser with no saved session is signed out (never
// signed in here, or signed out since, which clears it), so its first screen
// is the landing: held on the page ground until the shell draws it. One that
// was signed in keeps the skeleton, since Home is what comes.
test('no saved session holds the body too: the landing, not Home\'s skeleton, is next', () => {
  assert.equal(SNAPSHOT_KEY, 'usernode.session.v1');
  assert.ok(holdScript().includes(`localStorage.getItem('${SNAPSHOT_KEY}')`), 'the head reads the key the shell writes');
  assert.match(APP, /clearSessionSnapshot\(\) \{\s+try \{ localStorage\.removeItem\(App\.SESSION_SNAPSHOT_KEY\); \}/);
  const signedOut = runHold(null, { saved: null });
  assert.deepEqual([...signedOut.classes], ['first-session-boot']);
  assert.equal(signedOut.timers[0].ms, 8000, 'with the same floor');
  assert.equal(runHold(null, { saved: null, search: '?shot=dark', hash: '#login' }).classes.size, 1, 'whatever the address');
  assert.equal(runHold(null).classes.size, 0, 'a browser that was signed in keeps the skeleton');
  assert.equal(runHold(null, { blocked: true }).classes.size, 0, 'storage blocked: nothing known, nothing held');
  // The signed-out boot lifts it once the landing is drawn.
  assert.match(APP, /if \(window\.AuthScreens\) AuthScreens\.enter\(\);\s+App\._liftFirstSessionBoot\(\);/);
});

test('the shell lifts the hold at every way its boot ends', () => {
  assert.match(APP, /_liftFirstSessionBoot\(\) \{\s+try \{ document\.documentElement\.classList\.remove\('first-session-boot'\); \}/);
  // Signed in: after `sv:authed`, whose listeners draw the make screen in
  // this same tick, before anything paints.
  assert.match(APP, /document\.dispatchEvent\(new CustomEvent\('sv:authed', \{\s+detail: \{ user: App\.user \},\s+\}\)\);\s+(?:\/\/[^\n]*\n\s+)*App\._liftFirstSessionBoot\(\);\s+App\.restoreFromHash\(\);/);
  // The waiting room, a second enterAuthed, and a signed-out boot.
  assert.match(APP, /AuthScreens\.showWaiting\(\);\s+App\._liftFirstSessionBoot\(\);\s+return;/);
  assert.match(APP, /if \(App\._authedBooted\) \{\s+App\.restoreFromHash\(\);\s+App\._liftFirstSessionBoot\(\);\s+return;/);
  assert.match(APP, /if \(window\.AuthScreens\) AuthScreens\.enter\(\);\s+App\._liftFirstSessionBoot\(\);/);
});

test('a sign-in that reloads onto the live build keeps the session it confirmed', () => {
  const fn = AUTH_SCREENS.slice(AUTH_SCREENS.indexOf('    async finishLogin(opts) {'));
  const body = fn.slice(0, fn.indexOf('\n    },'));
  // Saved before the reload, so the new page boots from it.
  assert.match(body, /try \{ App\.saveSessionSnapshot\?\.\(user\); \} catch \(_\) \{\}\s+await App\._moveToLiveShell\('signed-in', liveShell\);/);
  // Still only after /api/auth/me answered for this user, and never for a
  // sign-in that returns to another document or into the waiting room.
  assert.ok(body.indexOf("fetch('/api/auth/me'") < body.indexOf('App.saveSessionSnapshot?.(user)'));
  assert.ok(body.indexOf('if (returnTo) {') < body.indexOf('App.saveSessionSnapshot?.(user)'));
  assert.ok(body.indexOf('if (user.hasPlatformAccess === false) {') < body.indexOf('App.saveSessionSnapshot?.(user)'));
});
