'use strict';

// Signing in as one flow: the story, the sign-in sheet over it, then "What
// do you want to make?" for an account's first session, whichever way in.
//
//   * The waitlist's "you're in" mail (`/?signup=1&t=<token>`, `/?login=1`)
//     opens the story with the sheet already open (AuthScreens.enter keeps
//     the link, the landing takes it on show), not the sign-in screen: for a
//     new account the address its token names is filled in and the code
//     sent, once per tab, through the sign-in screen's own lookup.
//   * "Sign in with a password" is a step of the sheet, sending the sign-in
//     screen's own exchange (passwordSignIn in features/auth/shared.ts).
//   * A first sign-in through the sheet hands off to the make screen: the
//     sheet leaves over the make screen's wallpaper, then the shell signs in
//     and the make screen is drawn in that same tick, for a new account (its
//     flag) and for one that already existed (the join step, at once).
//
// Effects do not run here (tests/lib/render-tsx.js), so the parts that are
// effects are exported as plain functions and run with stubbed globals, and
// the legacy scripts run in a vm sandbox. The browser is where the movement
// itself was looked at.
//
// Run with: node --test tests/sign-in-sheet-flow.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const AUTH_SCREENS = read('public/js/auth-screens.js');
const GATE = read('frontend/src/features/auth/communities-first-run.js');
const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';
const LANDING = 'frontend/src/features/auth/landing.tsx';
const SHARED = 'frontend/src/features/auth/shared.ts';

// ─── globals the browser would have ─────────────────────────────────────

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** Run `fn` with these globals in place, and put the old ones back after. */
async function withGlobals(globals, fn) {
  const prior = {};
  for (const key of Object.keys(globals)) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: globals[key], configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(globals)) {
      if (prior[key]) Object.defineProperty(globalThis, key, prior[key]);
      else delete globalThis[key];
    }
  }
}

/** A fetch that answers from `routes` (url → [status, body]) and records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const answer = typeof routes === 'function' ? routes(url, init) : routes[url];
    if (answer instanceof Error) throw answer;
    const [status, body] = answer || [404, {}];
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

// ─── the mail's link ────────────────────────────────────────────────────

function enterHarness({ search, hash = '' }) {
  const location = { search, hash, pathname: '/', origin: 'https://homeroom.example', href: `/${search}${hash}` };
  const replaced = [];
  let restored = 0;
  const element = { classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, style: {} };
  const sandbox = {
    URL, URLSearchParams, AbortController, console, location,
    setTimeout() { return 1; }, clearTimeout() {},
    history: { replaceState(_s, _t, url) { replaced.push(url); location.href = url; } },
    document: {
      addEventListener() {}, getElementById: () => element, querySelector: () => element,
      querySelectorAll: () => [], body: element, documentElement: element,
    },
    addEventListener() {},
    App: { restoreFromHash() { restored += 1; } },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(AUTH_SCREENS, sandbox);
  sandbox.AuthScreens.enter();
  return { auth: sandbox.AuthScreens, replaced, restored: () => restored };
}

test('the "you\'re in" link for a new account opens the story, its token kept for the sheet', () => {
  const { auth, replaced, restored } = enterHarness({ search: '?signup=1&t=AbC_def-123456' });
  assert.deepEqual(JSON.parse(JSON.stringify(auth._releaseLink)), { route: 'signup', token: 'AbC_def-123456', signIn: null });
  // The story's own address: no #signup (the sign-in screen), and the token
  // out of the address bar.
  assert.deepEqual(replaced, ['/']);
  assert.equal(restored(), 1, 'then the router shows what that address is: the landing');
});

test('the link for an account that exists opens the story at Sign in, with no token', () => {
  const { auth, replaced } = enterHarness({ search: '?login=1&t=AbC_def-123456' });
  assert.deepEqual(JSON.parse(JSON.stringify(auth._releaseLink)), { route: 'login', token: null, signIn: null });
  assert.deepEqual(replaced, ['/']);
});

test('a token that is not one is dropped, and the other links are as they were', () => {
  assert.equal(enterHarness({ search: '?signup=1&t=no' }).auth._releaseLink.token, null);
  const bad = enterHarness({ search: '?signup=1&t=%3Cscript%3E' });
  assert.deepEqual(JSON.parse(JSON.stringify(bad.auth._releaseLink)), { route: 'signup', token: null, signIn: null });
  // The status mail still lands on the waitlist's code step.
  const status = enterHarness({ search: '?status=1' });
  assert.equal(status.auth._releaseLink, null);
  assert.deepEqual(status.replaced, ['/#waitlist?confirm=1']);
  // A fragment still outranks the query.
  const hashed = enterHarness({ search: '?signup=1', hash: '#login' });
  assert.equal(hashed.auth._releaseLink, null);
  assert.deepEqual(hashed.replaced, []);
});

test('the link\'s one-time sign-in (#4594) is kept for the sheet, off the address, and only for a new account', () => {
  const key = 'K'.repeat(43);
  const { auth, replaced } = enterHarness({ search: `?signup=1&t=AbC_def-123456&key=${key}` });
  assert.deepEqual(JSON.parse(JSON.stringify(auth._releaseLink)), { route: 'signup', token: 'AbC_def-123456', signIn: key });
  assert.deepEqual(replaced, ['/'], 'the key leaves the address bar');
  assert.equal(enterHarness({ search: `?login=1&key=${key}` }).auth._releaseLink.signIn, null);
  assert.equal(enterHarness({ search: '?signup=1&key=short' }).auth._releaseLink.signIn, null);
});

test('the landing takes the link on show and opens the sheet at its step', () => {
  const src = read(LANDING);
  const onShow = src.slice(src.indexOf('const landingOnShow = useCallback(() => {'), src.indexOf('}, [loadLandingApps, refreshHeader, runAnonBackShot, st]);'));
  assert.match(onShow, /const link = takeReleaseLink\(\);\s+if \(link\) \{\s+noteSignInBegun\(\);\s+setRelease\(link\);\s+setResume\(null\);\s+setSheet\(link\.route === 'signup' \? 'start' : 'signin'\);/);
  // Get started's sheet carries the token; Sign in's never does.
  assert.match(src, /releaseToken=\{sheet === 'start' \? release\?\.token \?\? null : null\}/);
  assert.match(src, /releaseSignIn=\{sheet === 'start' \? release\?\.signIn \?\? null : null\}/);
  // The story switched off: the sign-in screen, as the link always opened,
  // with the token handed on for it.
  assert.match(src, /if \(!release \|\| waitlistPayload\?\.story_landing !== false\) return;\s+if \(release\.token\) keepReleaseLink\(release\);\s+setRelease\(null\);\s+setSheet\(null\);\s+location\.hash = `#\$\{release\.route\}`;/);
  assert.match(read('frontend/src/features/auth/login.tsx'),
    /const t = new URLSearchParams\(location\.search\)\.get\('t'\) \|\| takeReleaseLink\(\)\?\.token \|\| null;/);
});

test('the link is taken once, and only a well-formed one', async () => {
  const shared = loadTsx(SHARED);
  const host = { _releaseLink: { route: 'signup', token: 'AbC_def-123456' } };
  await withGlobals({ window: { AuthScreens: host } }, () => {
    assert.deepEqual(shared.takeReleaseLink(), { route: 'signup', token: 'AbC_def-123456', signIn: null });
    assert.equal(shared.takeReleaseLink(), null, 'read once');
    shared.keepReleaseLink({ route: 'signup', token: 'AbC_def-123456' });
    assert.equal(shared.takeReleaseLink().token, 'AbC_def-123456', 'handed on to the sign-in screen');
    host._releaseLink = { route: 'admin', token: 'AbC_def-123456' };
    assert.equal(shared.takeReleaseLink(), null);
    host._releaseLink = { route: 'signup', token: 'x' };
    assert.deepEqual(shared.takeReleaseLink(), { route: 'signup', token: null, signIn: null });
    host._releaseLink = { route: 'signup', token: null, signIn: 'K'.repeat(43) };
    assert.equal(shared.takeReleaseLink().signIn, 'K'.repeat(43));
    host._releaseLink = { route: 'login', token: null, signIn: 'K'.repeat(43) };
    assert.equal(shared.takeReleaseLink().signIn, null, 'only a new account\'s link signs in');
  });
});

test('the sheet spends the one-time sign-in with a POST, and anything but a spend falls back (#4594)', async () => {
  const sheet = loadTsx(SHEET);
  const key = 'K'.repeat(43);
  const fetch = fakeFetch((url, init) => {
    if (url !== '/api/auth/release-link') return [404, {}];
    const { token } = JSON.parse(init.body);
    if (token === key) return [200, { ok: true, next: 'set-password', email: 'ada@example.com', needsUsername: true, suggestedUsername: 'ada' }];
    if (token === 'S'.repeat(43)) return [200, { ok: true, next: 'signed-in', email: 'ada@example.com', user: {} }];
    return [422, { error: 'This sign-in link has expired or was already used.', code: 'invalid_release_link' }];
  });
  await withGlobals({ window: {}, sessionStorage: memoryStorage(), fetch }, async () => {
    assert.deepEqual(await sheet.spendReleaseLink(key), { next: 'set-password', email: 'ada@example.com', needsUsername: true, suggestedUsername: 'ada' });
    assert.equal((await sheet.spendReleaseLink('S'.repeat(43))).next, 'signed-in');
    assert.equal(await sheet.spendReleaseLink('U'.repeat(43)), null, 'expired, used or unknown: the fallback');
  });
  assert.ok(fetch.calls.every((c) => c.init.method === 'POST'), 'never a GET');
  const src = read(SHEET);
  // Spent: "Welcome <address>" over the account step; refused: the prefill and the code.
  assert.match(src, /if \(!spent\) \{ prefill\(\); return; \}/);
  assert.match(src, /setWelcome\(spent\.email\);\s+setNeedsUsername\(spent\.needsUsername\);\s+setSuggestedUsername\(spent\.suggestedUsername\);\s+setCooldownUntil\(0\);\s+setStep\('account'\);/);
  assert.match(src, /welcome \? t\('auth:signInSheet\.account\.welcome', \{ email: welcome \}\) : t\('auth:signInSheet\.account\.title'\)/);
  assert.equal(message('auth:signInSheet.account.welcome', { email: 'ada@example.com' }), 'Welcome ada@example.com');
  assert.equal(message('auth:signInSheet.account.title'), 'Finish your account');
});

test('the account step\'s password is optional (#4595)', () => {
  const src = read(SHEET);
  assert.match(src, /data-sign-in-sheet-skip-password=""[^>]*onClick=\{\(\) => \{ void finishAccount\(true\); \}\}>\{t\('auth:signInSheet\.account\.skip'\)\}<\/button>/);
  assert.equal(message('auth:signInSheet.account.skip'), 'Skip for now');
  // Skipped, or the field empty: no password in the request.
  assert.match(src, /\.\.\.\(password \? \{ password \} : \{\}\),/);
  assert.match(src, /if \(password && password\.length < 8\) \{ setError\(translate\('auth:signInSheet\.account\.passwordTooShort'\)\); return; \}/);
  // Asked once (Evan, 10 Oct 2026): no "Password again", and so no
  // confirmation sent; a mistyped one is reset by email. The field shows
  // what was typed on request instead (the shared PasswordInput's toggle).
  assert.doesNotMatch(src, /Password again|passwordConfirmation|confirmField|signInSheet\.account\.confirmLabel/);
  assert.match(src, /<PasswordInput ref=\{passwordField\} id="sign-in-sheet-password" autoComplete="new-password"/);
});

test('the sheet fills in the token\'s address and sends the code once per tab, through the sign-in screen\'s lookup', async () => {
  const sheet = loadTsx(SHEET);
  const session = memoryStorage();
  const fetch = fakeFetch({
    '/api/public/waitlist/more/AbC_def-123456': [200, { email: ' Ada@Example.com ' }],
    '/api/public/waitlist/more/Gone_token_000': [404, { error: 'Not found' }],
  });
  await withGlobals({ window: {}, sessionStorage: session, fetch }, async () => {
    const now = Date.now();
    assert.deepEqual(await sheet.releaseArrival('AbC_def-123456', now), { address: 'ada@example.com', send: true });
    // Recorded before the send, on the sign-in screen's own key.
    const record = JSON.parse(session.map.get('usernode.signup.otp.v1'));
    assert.equal(record.email, 'ada@example.com');
    // A reload in the same tab goes straight to the code, with what is left
    // of the minute the server holds a second code back.
    const again = await sheet.releaseArrival('AbC_def-123456', record.sentAt + 20_000);
    assert.deepEqual(again, { address: 'ada@example.com', send: false, cooldownUntil: record.sentAt + 60_000 });
    const later = await sheet.releaseArrival('AbC_def-123456', record.sentAt + 90_000);
    assert.equal(later.cooldownUntil, 0, 'a lapsed wait offers the resend');
    // A token that names nothing leaves the email step to be filled in.
    assert.equal(await sheet.releaseArrival('Gone_token_000', now), null);
  });
  assert.deepEqual(fetch.calls.map((c) => c.url).slice(0, 2), [
    '/api/public/waitlist/more/AbC_def-123456', '/api/public/waitlist/more/AbC_def-123456',
  ]);
  // The send itself is the sheet's own code request, and the sign-in screen
  // keeps doing the same for its link: one lookup, one record, two callers.
  const src = read(SHEET);
  assert.match(src, /void releaseArrival\(releaseToken\)\.then\(arrive\);/);
  assert.match(src, /function arrive\(arrival: ReleaseArrival \| null\) \{[\s\S]{0,400}void requestCode\(arrival\.address\);/);
  assert.match(src, /import \{ inviteEmailFromToken, readAutoSend, writeAutoSend \} from '\.\/login';/);
  assert.match(src, /fetch\('\/api\/auth\/otp\/request',/);
});

// ─── the password step ──────────────────────────────────────────────────

test('the password step sends the sign-in screen\'s exchange, and says what it refuses with', async () => {
  const shared = loadTsx(SHARED);
  const ok = fakeFetch({ '/api/auth/login': [200, { user: { id: 7, username: 'ada' } }] });
  await withGlobals({ window: {}, fetch: ok }, async () => {
    assert.deepEqual(await shared.passwordSignIn('ada@example.com', 'correct horse'), { ok: true });
  });
  assert.equal(ok.calls[0].url, '/api/auth/login');
  assert.equal(ok.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(ok.calls[0].init.body), { username: 'ada@example.com', password: 'correct horse' });

  const refused = fakeFetch({ '/api/auth/login': [401, { error: 'Invalid credentials' }] });
  await withGlobals({ window: {}, fetch: refused }, async () => {
    assert.deepEqual(await shared.passwordSignIn('ada', 'nope'), { ok: false, error: 'Invalid credentials', details: null });
  });
  const bare = fakeFetch({ '/api/auth/login': [429, {}] });
  await withGlobals({ window: {}, fetch: bare }, async () => {
    assert.equal((await shared.passwordSignIn('ada', 'x')).error, 'Login failed');
  });
  const offline = fakeFetch(() => new TypeError('Failed to fetch'));
  await withGlobals({ window: {}, fetch: offline }, async () => {
    assert.equal((await shared.passwordSignIn('ada', 'x')).error, 'Network error');
  });
  // Inside an app build that cannot prepare a secure session: the screen's
  // own sentence, before anything is sent.
  const unsent = fakeFetch({});
  await withGlobals({ window: { usernode: { isNative: true } }, fetch: unsent }, async () => {
    assert.match((await shared.passwordSignIn('ada', 'x')).error, /must be updated for secure sign-in/);
  });
  assert.equal(unsent.calls.length, 0);

  // Both the screen and the sheet send it through here, and neither has a
  // copy of its own.
  const login = read('frontend/src/features/auth/login.tsx');
  const sheet = read(SHEET);
  assert.match(login, /const result = await passwordSignIn\(username\.current\?\.value\.trim\(\) \|\| '', password\.current\?\.value \|\| ''\);/);
  assert.match(sheet, /const result = await passwordSignIn\(\s+\(identifierField\.current\?\.value \|\| ''\)\.trim\(\),\s+currentPasswordField\.current\?\.value \|\| '',\s+\);/);
  for (const [name, src] of [['login.tsx', login], ['sign-in-sheet.tsx', sheet]]) {
    assert.doesNotMatch(src, /['`]\/api\/auth\/login['`]/, `${name} sends no login of its own`);
  }
});

test('the password step is the sheet\'s: the link opens it, and Forgot password still reaches the reset', () => {
  const src = read(SHEET);
  assert.match(src, /type Step = 'choose' \| 'email' \| 'code' \| 'account' \| 'username' \| 'password' \| 'phone' \| 'phone-code';/);
  assert.match(src, /data-sign-in-sheet-password=""\s+onClick=\{\(e\) => \{ e\.preventDefault\(\); setError\(null\); setDetails\(null\); setStep\('password'\); \}\}/);
  assert.match(src, /<label htmlFor="sign-in-sheet-identifier" className=\{LABEL\}>\{t\('auth:signInSheet\.password\.identifierLabel'\)\}<\/label>/);
  assert.equal(message('auth:signInSheet.password.identifierLabel'), 'Username or email');
  assert.match(src, /<PasswordInput ref=\{currentPasswordField\} id="sign-in-sheet-current-password" name="password" required autoComplete="current-password"/);
  assert.match(src, /<a href="#login\/forgot" onClick=\{\(\) => \{ if \(followInvite\) rememberInviteJoin\(\); onClose\(\); \}\} className=\{QUIET\}>\{t\('auth:signInSheet\.password\.forgot'\)\}<\/a>/);
  assert.equal(message('auth:signInSheet.password.forgot'), 'Forgot password?');
  // Join pressed on an invite, then a password: the shell follows the link
  // without asking a second time, as it did from the sign-in screen.
  assert.match(src, /if \(followInvite\) rememberInviteJoin\(\);\s+await finish\('existing'\);/);
  // A right code for a password account moves to this step with the address.
  assert.match(src, /identifierPrefill\.current = email;\s+setStep\('password'\);/);
  // A session the shell cannot confirm says so in the sheet, as on the screen.
  assert.match(src, /<SessionConfirmationNotice completion=\{completion\} \/>/);
  assert.match(src, /<NativeLoginDetailsLink details=\{details\} \/>/);
});

test('each way into the sheet says only what is true for it', () => {
  const { SignInSheet, firstStepLine } = loadTsx(SHEET);
  // The first step is the title, the field, the button and what sits under it
  // (#4037, the owner's 7 Oct ruling): the terms alone where the sheet makes
  // an account; the way to a password, then the terms, where it is for an
  // account somebody has.
  assert.equal(firstStepLine('invite'), 'terms');
  assert.equal(firstStepLine('story'), 'terms');
  assert.equal(firstStepLine('signin'), 'password');
  assert.equal(firstStepLine('invite', true), 'password');
  const render = (from, title) => renderToHtml(createElement(SignInSheet, {
    open: true, title, from, onClose() {}, primaryClass: 'pill',
  }));
  const signin = render('signin', 'Sign in');
  const start = render('story', 'Make your account');
  const join = render('invite', 'Join Sunday Run Club');
  const BUTTON = /<button type="submit"[^>]*>Send code<\/button>/;
  // Sign in: the button, the password link, the terms, and nothing after the form.
  assert.match(signin, new RegExp(`${BUTTON.source}<p[^>]*><a href="#login" data-sign-in-sheet-password=""[^>]*>Sign in with a password</a></p><p[^>]*>By continuing, you agree to Homeroom&#x27;s terms\\.</p></form></div></div>`),
    'Sign in: the link right under the button, then the terms');
  // Make your account and Join: the button, then the terms, and nothing after.
  for (const html of [start, join]) {
    assert.match(html, new RegExp(`${BUTTON.source}<p[^>]*>By continuing, you agree to Homeroom&#x27;s terms\\.</p></form></div></div>`));
    assert.doesNotMatch(html, /Sign in with a password|New to Homeroom|This makes your account|Already have an account|Welcome back/);
  }
  // Nothing the story's two sheets say is a dash.
  for (const html of [signin, start, join]) assert.doesNotMatch(html, /—/);
  // #4037: no sheet has a line under its title, the title says it, and no
  // empty paragraph is left where the line was: the title, then the field.
  for (const html of [signin, start, join]) {
    assert.match(html, /<\/button><\/div><form/, 'the title row, then the email step');
    assert.doesNotMatch(html, /<p class="mt-1 text-\[15px\] leading-snug/);
  }
  for (const html of [start, join]) assert.equal(html.match(/<p[\s>]/g).length, 1, 'the terms alone under the button');
  assert.equal(signin.match(/<p[\s>]/g).length, 2, 'the password link and the terms');
  const landing = read(LANDING);
  assert.doesNotMatch(landing, /It takes a minute|Welcome back|Sign in or make an account/);
  // No line under any title, the phone's join included (#4326 trimmed its copy).
  assert.doesNotMatch(landing, /\bintro=/);
  assert.doesNotMatch(landing, /No app, no password/);
});

// ─── the way out to the make screen ─────────────────────────────────────

test('a new account from the sheet, the mail\'s included, gets the make screen and hands off to it', async () => {
  const { startedFromStory } = loadTsx(LANDING);
  const session = memoryStorage();
  const fetch = fakeFetch({ '/api/me/first-session/started': [200, { ok: true }] });
  const order = [];
  const handOff = async () => { order.push('hand-off'); };
  await withGlobals({ window: {}, sessionStorage: session, fetch }, async () => {
    await startedFromStory('new', handOff);
  });
  assert.equal(session.getItem('usernode:first-session:make'), '1', 'the island opens it as the shell signs in');
  assert.deepEqual(fetch.calls.map((c) => [c.url, c.init.method]), [['/api/me/first-session/started', 'POST']]);
  assert.deepEqual(order, ['hand-off']);
  // The mail's sheet is the story's own, with this as its beforeFinish.
  const src = read(LANDING);
  assert.match(src, /releaseToken=\{sheet === 'start' \? release\?\.token \?\? null : null\}\s+releaseSignIn=\{sheet === 'start' \? release\?\.signIn \?\? null : null\}\s+beforeFinish=\{startedFromStory\}/);
});

test('a first sign-in to an account that already existed, the password step\'s included, hands off too', async () => {
  const { startedFromStory } = loadTsx(LANDING);
  const asked = [];
  const due = (user) => { asked.push(user); return user.id === 7; };
  for (const [user, handsOff] of [[{ id: 7 }, true], [{ id: 8 }, false]]) {
    const session = memoryStorage();
    const fetch = fakeFetch({ '/api/auth/me': [200, { user }] });
    let handedOff = false;
    await withGlobals({ window: { CommunitiesFirstRun: { firstSessionNow: due } }, sessionStorage: session, fetch }, async () => {
      await startedFromStory('existing', async () => { handedOff = true; });
    });
    assert.equal(handedOff, handsOff, `user ${user.id}`);
    // The session read, past the worker, and nothing recorded or flagged
    // here: the join step opens it and records it as signed in.
    assert.deepEqual(fetch.calls.map((c) => [c.url, c.init.cache]), [['/api/auth/me', 'no-store']]);
    assert.equal(session.getItem('usernode:first-session:make'), null);
  }
  assert.deepEqual(asked.map((u) => u.id), [7, 8], 'the join step answers, not a copy of its rule');
  // A session read that fails is a sign-in like any other.
  const failed = fakeFetch({ '/api/auth/me': [500, {}] });
  let handedOff = false;
  await withGlobals({ window: { CommunitiesFirstRun: { firstSessionNow: () => true } }, sessionStorage: memoryStorage(), fetch: failed }, async () => {
    await startedFromStory('existing', async () => { handedOff = true; });
  });
  assert.equal(handedOff, false);
});

/** communities-first-run.js in a sandbox, waiting for the shell's start. */
function joinStepHarness({ user, pathname = '/', search = '' }) {
  const authed = [];
  const made = [];
  const fetches = [];
  const window = {
    App: {
      user: null,
      _inviteTokenFromPath: (p) => (/^\/invite\/[A-Za-z0-9_-]{22}$/.test(p) ? p.slice(8) : null),
    },
    UsernodeReact: { firstSession: { make() { made.push('make'); return true; } } },
  };
  const document = {
    addEventListener(type, fn) { if (type === 'sv:authed') authed.push(fn); },
    documentElement: { classList: { contains: () => false } },
  };
  const sandbox = {
    window, document, console, URLSearchParams,
    location: { search, pathname },
    setTimeout: (fn) => { fn(); return 1; },
    fetch: async (url, init) => { fetches.push([url, init && init.body ? JSON.parse(init.body) : null]); return { ok: true, json: async () => ({ communities: [] }) }; },
  };
  vm.runInNewContext(GATE, sandbox);
  return {
    gate: window.CommunitiesFirstRun,
    made,
    fetches,
    // The shell's start: App.user set, then `sv:authed`, synchronously.
    signIn() {
      window.App.user = user;
      const pending = authed.map((fn) => fn());
      return { madeInTheSameTick: made.length > 0, settled: Promise.all(pending) };
    },
  };
}

const FIRST = { id: 7, hasPlatformAccess: true, needsCommunitiesChoice: true, storyFirstSession: true, needsUsernameChoice: false };

test('the join step opens the make screen in the same tick the shell starts, for a first sign-in with nothing before it', async () => {
  const run = joinStepHarness({ user: { ...FIRST } });
  const { madeInTheSameTick, settled } = run.signIn();
  assert.equal(madeInTheSameTick, true, 'drawn before the browser paints Home');
  await settled;
  assert.deepEqual(run.made, ['make'], 'once');
  // Recorded behind it, as signed in, and the join screen never fetched.
  assert.deepEqual(run.fetches, [['/api/me/first-session/started', { via: 'sign_in' }]]);
  // The island draws it synchronously when asked from here.
  assert.match(read('frontend/src/features/first-session/index.tsx'),
    /make\(\): boolean \{\s+try \{ sessionStorage\.removeItem\(MAKE_FLAG\); \} catch \{[^}]*\}\s+openMake\(setMode, true\);/);
});

test('it still waits when something must come first, and answers the sheet the same way', async () => {
  // A username to choose first: the gate asks, then the make screen (as before).
  const named = joinStepHarness({ user: { ...FIRST, needsUsernameChoice: true } });
  assert.equal(named.signIn().madeInTheSameTick, false);
  // An invite bringing them in is followed first.
  const invited = joinStepHarness({ user: { ...FIRST }, pathname: '/invite/AAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(invited.signIn().madeInTheSameTick, false);
  // Not a first session, or the story switched off: no make screen at all.
  for (const user of [{ ...FIRST, needsCommunitiesChoice: false }, { ...FIRST, storyFirstSession: false }]) {
    const run = joinStepHarness({ user });
    assert.equal(run.signIn().madeInTheSameTick, false);
  }

  const { gate } = joinStepHarness({ user: { ...FIRST } });
  assert.equal(gate.firstSessionNow({ ...FIRST }), true);
  assert.equal(gate.firstSessionNow({ ...FIRST, hasPlatformAccess: false }), false, 'the waiting room comes first');
  assert.equal(gate.firstSessionNow({ ...FIRST, needsUsernameChoice: true }), false);
  assert.equal(gate.firstSessionNow({ ...FIRST, storyFirstSession: false }), false);
  assert.equal(gate.firstSessionNow({ ...FIRST, needsCommunitiesChoice: false }), false);
  assert.equal(gate.firstSessionNow(null), false);
  // The sheet asks this very function (through shared.ts), so the hand-off
  // and the make screen cannot disagree.
  assert.match(read(SHARED), /return legacy\(\)\.CommunitiesFirstRun\?\.firstSessionNow\?\.\(data\?\.user\) === true;/);
});

test('the movement: the sheet leaves over the make screen\'s ground, then the make screen rises, compositor-only', () => {
  const sheet = read(SHEET);
  // The cover paints the wallpaper the make screen stands on, over the same box.
  assert.match(sheet, /data-sign-in-sheet-cover=""/);
  assert.match(sheet, /style=\{\{ background: 'var\(--home-wallpaper\)' \}\}/);
  assert.match(read('frontend/src/features/first-session/make.tsx'), /style=\{\{ background: 'var\(--home-wallpaper, #f4f2e4\)' \}\}/);
  // The shell signs in only once the sheet has gone; a failure brings it back.
  assert.match(sheet, /await beforeFinish\?\.\(kind, handOff\);\s+const opened = await confirmSession\(\);\s+if \(!opened\) setLeaving\(false\);/);
  assert.match(sheet, /const ms = prefersReducedMotion\(\) \? 0 : HAND_OFF_MS;/);
  const make = read('frontend/src/features/first-session/make.tsx');
  assert.match(make, /const ARRIVING = 'translate-y-6 opacity-0 transition-\[transform,opacity\] duration-300 ease-out motion-reduce:transition-none';/);
  assert.match(make, /requestAnimationFrame\(\(\) => setArrived\(true\)\)/);
  // Transform and opacity only, never a delay (it would hold the movement
  // off the compositor on iOS), and none of it under reduced motion.
  for (const [name, src] of [['sheet', sheet], ['make', make]]) {
    assert.doesNotMatch(src, /\bdelay-\d|transition-delay|animation-delay/, `${name}: no delay`);
    assert.doesNotMatch(src, /transition-(all|\[(?:[^\]]*(?:width|height|top|left)[^\]]*)\])/, `${name}: nothing that lays out`);
  }
  assert.match(sheet, /transition-\[transform,opacity\] duration-200 ease-out motion-reduce:transition-none/);
  assert.equal((sheet.match(/motion-reduce:transition-none/g) || []).length >= 4, true);
});

test('closed by its ✕, its dim or Escape, the sheet goes down the way it came up before it is dropped', () => {
  const sheet = read(SHEET);
  // The ✕ and the dim both take `close`, which is the slide down, not the
  // parent's drop (that unmounted it in one frame: iOS app, 5 Oct 2026).
  assert.match(sheet, /const close = leaving \? undefined : requestClose;/);
  assert.equal((sheet.match(/onClick=\{close\}/g) || []).length, 2);
  assert.match(sheet, /if \(e\.key === 'Escape'\) requestClose\(\);/);
  // Down first (the panel's translate-y-full and the dim's fade ride `shown`),
  // then the parent's onClose once that has had its time; at once with
  // reduced motion. The keys go down with it.
  assert.match(sheet, /export const CLOSE_MS = 240;/);
  assert.match(sheet, /if \(active && panelRef\.current\?\.contains\(active\)\) active\.blur\(\);\s+if \(prefersReducedMotion\(\)\) \{ onClose\(\); return; \}\s+setClosing\(true\);\s+setShown\(false\);\s+closeTimer\.current = window\.setTimeout\(\(\) => \{ closeTimer\.current = null; onClose\(\); \}, CLOSE_MS\);/);
  // A second tap on the fading dim is the same close, not a second timer.
  assert.match(sheet, /if \(closeTimer\.current != null\) return;/);
  assert.match(sheet, /data-sign-in-sheet-closing=\{closing \? '' : undefined\}/);
});
