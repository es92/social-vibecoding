'use strict';

// Signing in as one flow: the story, the sign-in sheet over it, then "What
// do you want to make?" for an account's first session, whichever way in.
//
//   * The waitlist's "you're in" mail (`/?signup=1&t=<token>`, `/?login=1`)
//     opens the story, not the sign-in screen (AuthScreens.enter keeps the
//     link, the landing takes it on show). A new account's link is spent as
//     the page opens (tests/release-link-straight-flow.test.js); otherwise
//     Get started's sheet spends it, or fills in the address its token names
//     and sends the code, once per tab, through the sign-in screen's own
//     lookup. An existing account's opens the Sign in sheet.
//   * "Sign in with a password" is a step of the sheet, sending the sign-in
//     screen's own exchange (passwordSignIn in features/auth/shared.ts).
//   * A first sign-in through the sheet hands off to the make screen: the
//     sheet stays up, busy, until the session is confirmed (#4892), then
//     leaves over the make screen's wallpaper, then the shell signs in and
//     the make screen is drawn in that same tick, for a new account (its
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

test('the landing takes the link on show: Sign in opens at once, a new account\'s is checked before anything is spent', () => {
  const src = read(LANDING);
  const onShow = src.slice(src.indexOf('const landingOnShow = useCallback(() => {'), src.indexOf('}, [loadLandingApps, refreshHeader, runAnonBackShot, st]);'));
  // Evan, 12 Oct 2026: a new account's link puts "Signing you in…" up at
  // once while it is checked (tests/release-link-straight-flow.test.js); no
  // sheet opens for it. An existing account's opens Sign in.
  assert.match(onShow, /const link = takeReleaseLink\(\);\s+if \(link\) \{\s+noteSignInBegun\(\);\s+flushSync\(\(\) => \{\s+setRelease\(link\);\s+setResume\(null\);\s+setHolding\(straightLink\(link\)\);\s+if \(link\.route !== 'signup'\) setSheet\('signin'\);/);
  assert.doesNotMatch(onShow, /spendReleaseLink/);
  // The one Continue it opens is an old #waitlist link's (#5261), and never
  // over a release link.
  assert.equal((onShow.match(/setSheet\('start'\)/g) || []).length, 1);
  assert.match(onShow, /if \(takeStartSheet\(\) && !link\) \{\s+flushSync\(\(\) => \{ setResume\(null\); setSheet\('start'\); \}\);/);
  assert.match(src, /onStart=\{\(\) => setSheet\('start'\)\}/);
  // Get started's sheet carries the token; Sign in's never does. The
  // one-time sign-in too, unless the landing already found it used.
  assert.match(src, /releaseToken=\{sheet === 'start' \? release\?\.token \?\? null : null\}/);
  assert.match(src, /releaseSignIn=\{sheet === 'start' && !releaseUsed \? release\?\.signIn \?\? null : null\}/);
  // The story switched off: the sign-in screen, as the link always opened,
  // with the token handed on for it.
  // Nothing was spent on load for it, and "Signing you in…" goes too.
  assert.match(src, /if \(!release \|\| waitlistPayload\?\.story_landing !== false\) return;\s+if \(release\.token\) keepReleaseLink\(release\);\s+setRelease\(null\);\s+setSheet\(null\);\s+setHolding\(false\);\s+location\.hash = `#\$\{release\.route\}`;/);
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

test('a code field says it is a one-time code, in every way a browser reads (Evan, 10 Oct 2026)', () => {
  // On iPhone the sheet's code field read as a password to the OS.
  const shared = read('frontend/src/features/auth/shared.ts');
  const block = /export const ONE_TIME_CODE_FIELD = \{([\s\S]*?)\} as const;/.exec(shared)[1];
  for (const attr of ["type: 'text'", "name: 'one-time-code'", "inputMode: 'numeric'", "pattern: '[0-9]*'",
    "autoComplete: 'one-time-code'", "autoCapitalize: 'none'", "autoCorrect: 'off'", 'spellCheck: false']) {
    assert.ok(block.includes(attr), attr);
  }
  const src = read(SHEET);
  for (const id of ['sign-in-sheet-code', 'sign-in-sheet-phone-code']) {
    assert.match(src, new RegExp(`id="${id}" \\{\\.\\.\\.ONE_TIME_CODE_FIELD\\} enterKeyHint="go" maxLength=\\{6\\}`), id);
  }
  assert.doesNotMatch(src, /type="password"[^>]*one-time-code|one-time-code[^>]*type="password"/);
});

test('the code is six boxes over one real field, and the sixth digit sends it (#5253)', () => {
  const { codeDigits, CODE_LENGTH } = loadTsx(SHEET);
  assert.equal(CODE_LENGTH, 6);
  // A paste or the keyboard's suggestion fills all six, whatever surrounds the digits.
  assert.equal(codeDigits('583914'), '583914');
  assert.equal(codeDigits('583 914'), '583914');
  assert.equal(codeDigits('Code: 583914.'), '583914');
  assert.equal(codeDigits('58391412'), '583914');
  assert.equal(codeDigits('ab'), '');
  const src = read(SHEET);
  // One real field still carries the one-time-code attributes; the boxes are drawn from it and hidden from readers.
  assert.match(src, /<div className="grid grid-cols-6 gap-2" aria-hidden="true">/);
  assert.match(src, /id="sign-in-sheet-code" \{\.\.\.ONE_TIME_CODE_FIELD\} enterKeyHint="go" maxLength=\{6\} onInput=\{\(e\) => onCodeInput\(e\.currentTarget\.value\)\}/);
  // The sixth digit sends it, once per code.
  assert.match(src, /if \(digits\.length === CODE_LENGTH && digits !== autoSent\.current && !busy\) \{\s+autoSent\.current = digits;\s+void verify\(\);/);
  // No Continue to press on the code step any more.
  const step = src.slice(src.indexOf("{step === 'code' ? ("), src.indexOf("{step === 'password' ? ("));
  assert.doesNotMatch(step, /type="submit"/);
  assert.match(step, /<RichMessage id="auth:signInSheet\.code\.sentTo" values=\{\{ email \}\}/);
  assert.equal(message('auth:signInSheet.code.sentTo', { email: 'ada@example.com' }), 'Sent to <0>ada@example.com</0> · <1>Change</1>');
  assert.equal(message('auth:signInSheet.code.checkSpam'), 'Nothing? Check spam.');
  assert.equal(message('auth:signInSheet.code.title'), 'Enter the code we emailed');
});

test('the code step opens the address\'s own mail (#5253)', () => {
  const { mailAppFor } = loadTsx(SHEET);
  const gmail = mailAppFor('Ada@Gmail.com');
  assert.equal(gmail.name, 'Gmail');
  assert.equal(gmail.url, 'https://mail.google.com/mail/?authuser=Ada%40Gmail.com#search/in%3Aanywhere+newer_than%3A1h');
  assert.equal(mailAppFor('ada@googlemail.com').name, 'Gmail');
  assert.equal(mailAppFor('ada@hotmail.com').name, 'Outlook');
  assert.equal(mailAppFor('ada@yahoo.co.uk').name, 'Yahoo Mail');
  assert.equal(mailAppFor('ada@icloud.com').name, 'iCloud Mail');
  assert.equal(mailAppFor('ada@proton.me').name, 'Proton Mail');
  // A work or school address has no inbox to guess at: no button.
  assert.equal(mailAppFor('ada@usernodelabs.org'), null);
  assert.equal(mailAppFor('not an address'), null);
  assert.equal(message('auth:signInSheet.code.openMail', { app: 'Gmail' }), 'Open Gmail');
  // No counted steps over the title: no bar, and no "Step X of 3" (#5615).
  assert.doesNotMatch(read(SHEET), /data-sign-in-sheet-progress/);
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
    assert.equal(await sheet.spendReleaseLink('U'.repeat(43)), 'refused', 'expired, used or unknown: the fallback, and it says why');
  });
  const broken = fakeFetch(() => [500, { error: 'Internal server error' }]);
  await withGlobals({ window: {}, sessionStorage: memoryStorage(), fetch: broken }, async () => {
    assert.equal(await sheet.spendReleaseLink(key), null, 'a server error is no refusal: the fallback, with no reason given');
  });
  assert.ok(fetch.calls.every((c) => c.init.method === 'POST'), 'never a GET');
  const src = read(SHEET);
  // Spent: "Welcome <address>" over the account step; refused: the prefill and the code.
  assert.match(src, /if \(spent === 'refused'\) setLinkRefused\(true\);\s+if \(!spent \|\| spent === 'refused'\) \{ prefill\(\); return; \}/);
  // While it is spent: "Signing you in…", not the email step and its Send
  // code button (Evan, 10 Oct 2026: the first open showed that step first).
  assert.match(src, /setStep\(releaseSignIn \? 'link' : 'email'\);/);
  assert.match(src, /step === 'link' \? t\('auth:signInSheet\.link\.title'\)/);
  assert.equal(message('auth:signInSheet.link.title'), 'Signing you in from your email\u2026');
  // Closed and opened again (Get started again, Evan, 10 Oct 2026): the link
  // signs in from the email again, not the code step. The sheet forgets the
  // link it spent when it closes, and the story keeps the link when the
  // sheet closes; the server takes the same link again while the account
  // it started is not set up (tests/release-link-postgres.test.js).
  assert.match(src, /if \(!open\) \{ setShown\(false\); setLeaving\(false\); setClosing\(false\); releaseSeen\.current = null; return undefined; \}/);
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /const closeSheet = useCallback\(\(\) => \{ setSheet\(null\); setResume\(null\); setSignUpWith\(null\); \}, \[\]\);/);
  assert.doesNotMatch(landing, /setRelease\(null\); \}, \[\]\)/);
  // Refused, the code step says why a code came instead.
  // Otherwise "Sent to <address> · Change" says it (#5253).
  assert.match(src, /linkRefused \? t\('auth:signInSheet\.code\.leadLinkUsed', \{ email \}\) : ''/);
  assert.equal(message('auth:signInSheet.code.leadLinkUsed', { email: 'ada@example.com' }),
    'That sign-in link was already used or has expired, so we sent a 6-digit code to ada@example.com instead. It expires in 10 minutes.');
  assert.match(src, /setLinkRefused\(false\); setStep\('email'\);/, 'another address is a plain code again');
  assert.match(src, /setWelcome\(spent\.email\);\s+setNeedsUsername\(spent\.needsUsername\);\s+setSuggestedUsername\(spent\.suggestedUsername\);\s+setCooldownUntil\(0\);\s+setStep\('account'\);/);
  assert.match(src, /welcome \? t\('auth:signInSheet\.account\.welcome', \{ email: welcome \}\) : t\('auth:signInSheet\.account\.title'\)/);
  assert.equal(message('auth:signInSheet.account.welcome', { email: 'ada@example.com' }), 'Welcome ada@example.com');
  assert.equal(message('auth:signInSheet.account.title'), 'Finish your account');
});

test('the account step asks for no password, and says how they sign in (#4891)', () => {
  const src = read(SHEET);
  // The password was optional (#4595), and still one more decision at the
  // very first step. The step is the username and nothing else: no field,
  // no "Skip for now", no confirmation, and no password in the request.
  const step = src.slice(src.indexOf("{step === 'account' ? ("), src.indexOf('</form>', src.indexOf("{step === 'account' ? (")));
  assert.ok(step.length > 0, 'the account step renders');
  assert.doesNotMatch(step, /PasswordInput|new-password|id="sign-in-sheet-password"/);
  assert.doesNotMatch(src, /passwordField|accountStepFields|signInSheet\.account\.password|signInSheet\.account\.skip|finishAccount\(true\)/);
  // The request is `saveAccount`, which the full-page Welcome sends too
  // (frontend/src/features/auth/welcome-page.tsx).
  const finishAccount = src.slice(src.indexOf('const finishAccount = useCallback'), src.indexOf('const signInWithPassword = useCallback'));
  assert.match(finishAccount, /const saved = await saveAccount\(handle\);/);
  const saveAccount = src.slice(src.indexOf('export async function saveAccount('), src.indexOf('export function linkSigningIn('));
  assert.match(saveAccount, /fetchSessionMint\('\/api\/auth\/otp\/set-password', \{/);
  assert.match(saveAccount, /body: JSON\.stringify\(\{\s*\.\.\.\(handle \? \{ username: handle \} : \{\}\),\s*\}\),/);
  for (const body of [finishAccount, saveAccount]) {
    assert.doesNotMatch(body, /\{ password \}|\bpassword:|passwordConfirmation|passwordField/);
  }
  // The username is the step's one field, so its Return goes.
  assert.match(step, /<input ref=\{usernameField\} id="sign-in-sheet-username" defaultValue=\{suggestedUsername\} autoComplete="username" enterKeyHint="go" className=\{INPUT\}/);
  // In the password's place, how they sign in and where a password is
  // added, under the button since #5255, so the field's own line is free.
  assert.ok(step.indexOf('data-sign-in-sheet-code-note') > step.indexOf('<button type="submit"'), 'the note sits under the button');
  assert.match(step, /<p data-sign-in-sheet-code-note="" className="text-\[13px\] text-zinc-500 dark:text-zinc-400">\{t\('auth:signInSheet\.account\.codeNote'\)\}<\/p>/);
  assert.equal(message('auth:signInSheet.account.codeNote'),
    'You sign in with a code we email you. You can add a password later in Settings.');
  assert.equal(message('auth:signInSheet.account.leadWithUsername'), 'Pick a username. It is public on Homeroom.');
  assert.doesNotMatch(message('auth:signInSheet.account.leadWithUsername'), /password/i);
  // Settings is really where it is offered (tests/settings-screen.test.js).
  assert.equal(message('settings:password.titleAdd'), 'Add a password');
});

test('the username step wears an @, says live whether the name is free, and shows how others see it (#5255)', async () => {
  const { checkUsername, USERNAME_CHECK_MS } = loadTsx(SHEET);
  const free = fakeFetch(() => [200, { ok: true, available: true }]);
  await withGlobals({ fetch: free }, async () => {
    assert.deepEqual(await checkUsername(' ada_l '), { state: 'available' });
  });
  assert.equal(free.calls[0].url, '/api/auth/username-available?username=ada_l');
  const taken = fakeFetch(() => [200, { ok: true, available: false, error: 'That username is taken.' }]);
  await withGlobals({ fetch: taken }, async () => {
    assert.deepEqual(await checkUsername('ada'), { state: 'taken', error: 'That username is taken.' });
  });
  // Empty, throttled or offline: the field says nothing, and Create my account still answers.
  const none = fakeFetch({});
  await withGlobals({ fetch: none }, async () => {
    assert.deepEqual(await checkUsername('  '), { state: 'idle' });
  });
  assert.equal(none.calls.length, 0);
  const throttled = fakeFetch(() => [429, { error: 'Too many username checks.' }]);
  await withGlobals({ fetch: throttled }, async () => {
    assert.deepEqual(await checkUsername('ada'), { state: 'idle' });
  });
  const offline = fakeFetch(() => new Error('offline'));
  await withGlobals({ fetch: offline }, async () => {
    assert.deepEqual(await checkUsername('ada'), { state: 'idle' });
  });
  assert.ok(USERNAME_CHECK_MS >= 200 && USERNAME_CHECK_MS <= 600, 'asked once typing pauses');
  const src = read(SHEET);
  const step = src.slice(src.indexOf("{step === 'account' ? ("), src.indexOf('</form>', src.indexOf("{step === 'account' ? (")));
  assert.match(step, /<span aria-hidden="true" className="text-\[17px\] text-zinc-500 dark:text-zinc-400">@<\/span>/);
  assert.match(step, /onInput=\{\(e\) => setHandleDraft\(e\.currentTarget\.value\)\}/);
  assert.match(step, /data-sign-in-sheet-username-check="available"/);
  assert.match(step, /data-sign-in-sheet-username-preview=""/);
  assert.match(step, /needsUsername \? t\('auth:signInSheet\.account\.create'\) : t\('auth:signInSheet\.account\.submit'\)/);
  assert.equal(message('auth:signInSheet.account.create'), 'Create my account');
  assert.equal(message('auth:signInSheet.account.available'), '✓ Available');
  assert.equal(message('auth:signInSheet.account.rules'), '3 to 32 letters, numbers or _');
  assert.equal(message('auth:signInSheet.account.previewLabel'), 'How others see you');
  assert.equal(message('auth:signInSheet.account.titleUsername'), 'Pick your username');
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

test('the password step is the sheet\'s: the link opens it, and Forgot password opens the reset in the sheet', () => {
  const src = read(SHEET);
  assert.match(src, /type Step = 'choose' \| 'email' \| 'code' \| 'account' \| 'username' \| 'password' \| 'forgot' \| 'phone' \| 'phone-code' \| 'link';/);
  assert.match(src, /data-sign-in-sheet-password=""\s+onClick=\{\(e\) => \{ e\.preventDefault\(\); setError\(null\); setDetails\(null\); setStep\('password'\); \}\}/);
  assert.match(src, /<label htmlFor="sign-in-sheet-identifier" className=\{LABEL\}>\{t\('auth:signInSheet\.password\.identifierLabel'\)\}<\/label>/);
  assert.equal(message('auth:signInSheet.password.identifierLabel'), 'Username or email');
  assert.match(src, /<PasswordInput ref=\{currentPasswordField\} id="sign-in-sheet-current-password" name="password" required autoComplete="current-password"/);
  // #5258: the reset opens in the sheet, not on the sign-in screen's own page.
  assert.match(src, /data-sign-in-sheet-forgot="" className=\{QUIET\} onClick=\{\(\) => \{ typedIdentifier\.current = \(identifierField\.current\?\.value \|\| ''\)\.trim\(\); toStep\('forgot'\); \}\}>/);
  assert.doesNotMatch(src, /href="#login\/forgot"/);
  assert.equal(message('auth:signInSheet.password.forgot'), 'Forgot password?');
  // #5616: picking Password is choosing how to sign in, so the step has no
  // "Other ways to continue" back to Apple and Google; closing the sheet does
  // that. Without the Email code | Password switch, the email code is the one
  // other way, and the link goes straight to that step.
  assert.doesNotMatch(src, /signInSheet\.password\.otherWays/);
  const passwordAt = src.indexOf("{step === 'password' ? (");
  const passwordForm = src.slice(passwordAt, src.indexOf("{step === 'forgot' ? (", passwordAt));
  assert.doesNotMatch(passwordForm, /otherWays/);
  assert.match(passwordForm, /\{!methodSwitch \? \(\s+<button type="button" className=\{QUIET\} onClick=\{\(\) => toStep\('email'\)\}>\s+\{t\('auth:signInSheet\.password\.useEmailCode'\)\}/);
  assert.match(passwordForm, /data-sign-in-sheet-forgot=""/);
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
  // (#4037, the owner's 7 Oct ruling): the terms alone where the sheet only
  // makes an account (an invite's Join); the way to a password, then the
  // terms, where it may be for an account somebody has: Sign in, and the
  // story's one Continue (#5251), which has no Sign in beside it any more.
  assert.equal(firstStepLine('invite'), 'terms');
  assert.equal(firstStepLine('story'), 'password');
  assert.equal(firstStepLine('signin'), 'password');
  assert.equal(firstStepLine('invite', true), 'password');
  const render = (from, title) => renderToHtml(createElement(SignInSheet, {
    open: true, title, from, onClose() {}, primaryClass: 'pill',
  }));
  const signin = render('signin', 'Sign in');
  const start = render('story', 'Continue to Homeroom');
  const join = render('invite', 'Join Sunday Run Club');
  const BUTTON = /<button type="submit"[^>]*>Send code<\/button>/;
  // Sign in and Continue: the Email code | Password switch over the field
  // (#5258, where the link under the button was), then the button, and
  // nothing after the form: sending a code makes no account, so no terms
  // (#5257; the code step says them).
  for (const html of [signin, start]) {
    assert.match(html, /<div role="radiogroup" aria-label="How to sign in" data-sign-in-sheet-method=""[^>]*><button type="button" role="radio" aria-checked="true" data-sign-in-sheet-method-email=""[^>]*>Email code<\/button><button type="button" role="radio" aria-checked="false" data-sign-in-sheet-method-password=""[^>]*>Password<\/button><\/div><form/);
    assert.match(html, new RegExp(`${BUTTON.source}</form></div></div>`), 'nothing under the button');
    assert.doesNotMatch(html, /By continuing|data-sign-in-sheet-password=|Use a password/);
    assert.doesNotMatch(html, /New to Homeroom|This makes your account|Already have an account|Welcome back/);
  }
  // Join: the button, then the terms, and nothing after.
  assert.match(join, new RegExp(`${BUTTON.source}<p[^>]*>By continuing, you agree to Homeroom&#x27;s terms and acknowledge the privacy notice\\.</p></form></div></div>`));
  assert.doesNotMatch(join, /Use a password|data-sign-in-sheet-method|New to Homeroom|This makes your account|Already have an account|Welcome back/);
  // Nothing the story's two sheets say is a dash.
  for (const html of [signin, start, join]) assert.doesNotMatch(html, /—/);
  // #4037: no sheet has a line under its title, the title says it, and no
  // empty paragraph is left where the line was: the title, then the field.
  for (const html of [signin, start, join]) {
    assert.match(html, /<\/button><\/div>(<div role="radiogroup"[^]*?<\/div>)?<form/, 'the title row, then the email step');
    assert.doesNotMatch(html, /<p class="mt-1 text-\[15px\] leading-snug/);
  }
  assert.equal(join.match(/<p[\s>]/g).length, 1, 'the terms alone under the button');
  for (const html of [signin, start]) assert.equal((html.match(/<p[\s>]/g) || []).length, 0, 'no line under the button, the switch above');
  const landing = read(LANDING);
  assert.doesNotMatch(landing, /It takes a minute|Welcome back|Sign in or make an account/);
  // No line under any title, the phone's join included (#4326 trimmed its copy).
  assert.doesNotMatch(landing, /\bintro=/);
  assert.doesNotMatch(landing, /No app, no password/);
});

test('the first step with Apple and Google: the terms under them, then the email, then the password (#5257)', () => {
  const { SignInSheet } = loadTsx(SHEET);
  const render = (from) => renderToHtml(createElement(SignInSheet, {
    open: true, title: 'Continue to Homeroom', from, providers: ['google', 'apple'], onClose() {}, primaryClass: 'pill',
  }));
  for (const from of ['story', 'signin']) {
    const html = render(from);
    assert.match(html, /data-sign-in-sheet="choose"/);
    const at = (re) => html.search(re);
    const order = [
      at(/data-sign-in-provider="google"/), at(/data-sign-in-provider="apple"/),
      at(/By continuing, you agree to Homeroom&#x27;s terms and acknowledge the privacy notice\./), at(/data-sign-in-sheet-or=""/),
      at(/id="sign-in-sheet-email"/), at(/data-sign-in-provider="email"/), at(/data-sign-in-sheet-password=""/),
    ];
    for (const i of order) assert.ok(i > 0, `${from}: every part is there`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${from}: in that order`);
    // The email is sent from here: a form, its button the submit.
    assert.match(html, /<button type="submit" data-sign-in-provider="email"[^>]*>Continue with email<\/button><\/form>/);
    assert.equal((html.match(/By continuing/g) || []).length, 1, `${from}: the terms once`);
    assert.match(html, />Use a password<\/a>/);
  }
  // An invite's Join only makes an account: its terms, and no password.
  const join = render('invite');
  assert.match(join, /By continuing, you agree/);
  assert.doesNotMatch(join, /Use a password|data-sign-in-sheet-password=/);
  assert.equal(message('auth:signInSheet.withPassword'), 'Use a password');
  assert.match(message('auth:signInSheet.resume.passwordRequired'), /"Use a password"/);
  assert.match(message('auth:signInSheet.resume.adminPasswordRequired'), /"Use a password"/);
});

test('Email code | Password is one switch, and the password and reset steps say no terms (#5258)', () => {
  const { hasMethodSwitch, stepSaysTerms } = loadTsx(SHEET);
  // Where the sheet may be for an account somebody has: both halves carry it.
  for (const from of ['signin', 'story']) {
    assert.equal(hasMethodSwitch('email', from), true);
    assert.equal(hasMethodSwitch('password', from), true);
    for (const step of ['choose', 'code', 'forgot', 'account', 'phone']) assert.equal(hasMethodSwitch(step, from), false);
  }
  assert.equal(hasMethodSwitch('email', 'invite', true), true, 'the other ways after an invite\'s phone step');
  // An invite's Join only makes an account: no password half to switch to.
  assert.equal(hasMethodSwitch('email', 'invite'), false);
  assert.equal(hasMethodSwitch('password', 'invite'), false);
  // Neither step makes an account, so neither asks for the terms; every step that can still does.
  assert.equal(stepSaysTerms('password'), false);
  assert.equal(stepSaysTerms('forgot'), false);
  for (const step of ['code', 'account', 'username', 'phone', 'phone-code']) assert.equal(stepSaysTerms(step), true);
  const src = read(SHEET);
  assert.match(src, /\{step === 'choose' \|\| step === 'email' \|\| !stepSaysTerms\(step\) \? null : \(/);
  assert.equal(message('auth:signInSheet.method.emailCode'), 'Email code');
  assert.equal(message('auth:signInSheet.method.password'), 'Password');
});

test('the reset step asks the sign-in screen\'s reset, and says the same whether or not the address matched', async () => {
  const { requestPasswordReset } = loadTsx(SHEET);
  const ok = fakeFetch({ '/api/auth/password-reset/request': [200, { ok: true }] });
  await withGlobals({ fetch: ok }, async () => {
    assert.deepEqual(await requestPasswordReset(' ada@example.com '), { ok: true });
  });
  assert.deepEqual(ok.calls.map((c) => [c.url, c.init.method]), [['/api/auth/password-reset/request', 'POST']]);
  assert.deepEqual(JSON.parse(ok.calls[0].init.body), { email: 'ada@example.com' });
  // Not an address: nothing is sent.
  const none = fakeFetch({});
  await withGlobals({ fetch: none }, async () => {
    assert.deepEqual(await requestPasswordReset('ada'), { ok: false, error: message('auth:signInSheet.forgot.emailMissing') });
  });
  assert.equal(none.calls.length, 0);
  const refused = fakeFetch({ '/api/auth/password-reset/request': [429, { error: 'Too many requests' }] });
  await withGlobals({ fetch: refused }, async () => {
    assert.deepEqual(await requestPasswordReset('ada@example.com'), { ok: false, error: 'Too many requests' });
  });
  const offline = fakeFetch(() => new Error('offline'));
  await withGlobals({ fetch: offline }, async () => {
    assert.deepEqual(await requestPasswordReset('ada@example.com'), { ok: false, error: message('auth:signInSheet.networkError') });
  });
  // The sheet's step: its field, its button, the same wording as the screen's, and the way back.
  const src = read(SHEET);
  assert.match(src, /<input ref=\{resetField\} id="sign-in-sheet-reset-email" type="email" autoComplete="email"/);
  assert.equal(message('auth:signInSheet.forgot.sent'), message('auth:login.emailReset.sent'));
});

test('the reset has one way back, a way in with a code, and the support note only once a link went (#5259)', () => {
  const src = read(SHEET);
  // One "‹ Sign in", above the title, carrying the typed username back.
  assert.match(src, /\{step === 'forgot' \? \(\s+<button type="button" data-sign-in-sheet-forgot-back="" className=\{`\$\{QUIET\} mt-2 -ml-1 flex items-center gap-0\.5`\} onClick=\{\(\) => \{ identifierPrefill\.current = typedIdentifier\.current; toStep\('password'\); \}\}>\s+<ChevronLeftIcon/);
  assert.equal(src.match(/data-sign-in-sheet-forgot-back=""/g).length, 1, 'one way back, not two');
  assert.equal(message('auth:signInSheet.forgot.back'), 'Sign in');
  const step = src.slice(src.indexOf("{step === 'forgot' ? (\n          <form"), src.indexOf("{step === 'account' ? ("));
  // Beside the reset button: the email code, with the address carried over.
  assert.match(step, /data-sign-in-sheet-forgot-code="" className=\{MAIL_BUTTON\} onClick=\{\(\) => \{ const typed = \(resetField\.current\?\.value \|\| ''\)\.trim\(\); if \(typed\.includes\('@'\)\) setEmail\(typed\.toLowerCase\(\)\); toStep\('email'\); \}\}/);
  assert.ok(step.indexOf('data-sign-in-sheet-forgot-code') > step.indexOf('<button type="submit"'), 'right under the reset button');
  assert.equal(message('auth:signInSheet.forgot.withCode'), 'Sign in with a code instead');
  // The support note waits for a sent link: nobody has a problem before then.
  assert.match(step, /\{resetSent \? \(\s+<p data-sign-in-sheet-reset-support=""/);
  assert.match(message('auth:signInSheet.forgot.support'), /^Nothing arrived\? Check spam\./);
  assert.match(message('auth:signInSheet.forgot.lead'), /sign in with a code/);
});

// ─── the way out to the make screen ─────────────────────────────────────

test('a new account from the sheet, the mail\'s included, gets the make screen and hands off to it', async () => {
  const { startedFromStory } = loadTsx(LANDING);
  const session = memoryStorage();
  const fetch = fakeFetch({ '/api/me/first-session/started': [200, { ok: true }] });
  let toMake;
  await withGlobals({ window: {}, sessionStorage: session, fetch }, async () => {
    toMake = await startedFromStory('new');
  });
  assert.equal(session.getItem('usernode:first-session:make'), '1', 'the island opens it as the shell signs in');
  // Recorded before it answers, so before the shell starts and the join
  // step's own record (`via: 'sign_in'`) can land first.
  assert.deepEqual(fetch.calls.map((c) => [c.url, c.init.method]), [['/api/me/first-session/started', 'POST']]);
  assert.equal(toMake, true, 'the sheet hands off to the make screen');
  // A record that fails still hands off: the make screen is the flag's.
  const failed = fakeFetch(() => new Error('offline'));
  await withGlobals({ window: {}, sessionStorage: memoryStorage(), fetch: failed }, async () => {
    toMake = await startedFromStory('new');
  });
  assert.equal(toMake, true);
  // The mail's sheet is the story's own, with this as its beforeFinish, and
  // so is the full-page Welcome it hands the account to.
  const src = read(LANDING);
  assert.match(src, /releaseToken=\{sheet === 'start' \? release\?\.token \?\? null : null\}\s+releaseSignIn=\{sheet === 'start' && !releaseUsed \? release\?\.signIn \?\? null : null\}\s+linkUsed=\{sheet === 'start' && releaseUsed\}\s+onAccount=\{sheet === 'start' && release\?\.route === 'signup' \? toWelcome : undefined\}\s+beforeFinish=\{startedFromStory\}/);
  assert.match(src, /\{welcome \? <WelcomePage account=\{welcome\} beforeFinish=\{startedFromStory\} \/> : null\}/);
});

test('a first sign-in to an account that already existed, the password step\'s included, hands off too', async () => {
  const { startedFromStory } = loadTsx(LANDING);
  const asked = [];
  const due = (user) => { asked.push(user); return user.id === 7; };
  for (const [user, handsOff] of [[{ id: 7 }, true], [{ id: 8 }, false]]) {
    const session = memoryStorage();
    const fetch = fakeFetch({ '/api/auth/me': [200, { user }] });
    let handedOff;
    await withGlobals({ window: { CommunitiesFirstRun: { firstSessionNow: due } }, sessionStorage: session, fetch }, async () => {
      handedOff = await startedFromStory('existing');
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
  let handedOff;
  await withGlobals({ window: { CommunitiesFirstRun: { firstSessionNow: () => true } }, sessionStorage: memoryStorage(), fetch: failed }, async () => {
    handedOff = await startedFromStory('existing');
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
  // The sheet goes only once the shell is ready to draw the make screen
  // (#4892), and the shell signs in once it has gone; a failure keeps it up.
  assert.match(sheet, /const toMake = \(await beforeFinish\?\.\(kind\)\) === true;\s+const opened = await confirmSession\(toMake \? handOff : undefined\);\s+if \(!opened\) setLeaving\(false\);/);
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

// ─── held until the make screen is ready to draw (#4892) ───────────────
//
// Onboarding run, 12 Oct 2026 (iPhone 17 simulator, iOS 26.5 Safari): after
// Continue on the "Welcome <address>" sheet a blank page showed before
// "What do you want to make?". The sheet left before the session read, and
// the bare wallpaper stood there for as long as the read took.

/** AuthScreens.finishLogin in a sandbox, recording what it does in order. */
function finishHarness({ user = { id: 7, hasPlatformAccess: true }, status = 200, move = false } = {}) {
  const order = [];
  const location = { search: '', hash: '#landing', pathname: '/', origin: 'https://homeroom.example', href: '/#landing' };
  const element = { classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, style: {} };
  const sandbox = {
    URL, URLSearchParams, AbortController, console, location,
    setTimeout() { return 1; }, clearTimeout() {},
    history: { replaceState() {} },
    document: {
      addEventListener() {}, getElementById: () => element, querySelector: () => element,
      querySelectorAll: () => [], body: element, documentElement: element,
    },
    addEventListener() {},
    App: {
      clearSessionSnapshot() {},
      saveSessionSnapshot() {},
      enterAuthed(u) { order.push(`shell:${u.id}`); },
      _askLiveBuild() { return Promise.resolve(null); },
      _moveToLiveShell() {
        order.push('live-build');
        return move === 'reload' ? new Promise(() => {}) : Promise.resolve(false);
      },
    },
    fetch(url) {
      order.push(`read:${url}`);
      return Promise.resolve({ ok: status < 400, status, json: async () => ({ user }) });
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(AUTH_SCREENS, sandbox);
  return { auth: sandbox.AuthScreens, order, beforeShell: async () => { order.push('hand-off'); } };
}

test('bound for the make screen, the sheet stays up through the session read and hands off just before the shell starts (#4892)', async () => {
  const h = finishHarness();
  assert.equal(await h.auth.finishLogin({ beforeShell: h.beforeShell }), null);
  assert.deepEqual(h.order, ['read:/api/auth/me', 'live-build', 'hand-off', 'shell:7'],
    'the read and the build check first, then the sheet goes, then the shell draws the make screen');
  // Every other sign-in starts the shell as it always has.
  const plain = finishHarness();
  assert.equal(await plain.auth.finishLogin(), null);
  assert.deepEqual(plain.order, ['read:/api/auth/me', 'live-build', 'shell:7']);
  // A hand-off that throws keeps nobody out.
  const broken = finishHarness();
  assert.equal(await broken.auth.finishLogin({ beforeShell: async () => { throw new Error('gone'); } }), null);
  assert.deepEqual(broken.order, ['read:/api/auth/me', 'live-build', 'shell:7']);

  // The sheet asks for it only when its screen said the make screen comes,
  // and passes it through the confirmation to finishLogin.
  const sheet = read(SHEET);
  const finish = sheet.slice(sheet.indexOf('const finish = useCallback('), sheet.indexOf('finishRef.current = finish;'));
  assert.doesNotMatch(finish, /await handOff\(\)|beforeFinish\?\.\(kind, handOff\)/, 'never before the session read');
  assert.match(read('frontend/src/features/auth/session-confirmation.tsx'),
    /const finishLogin = useCallback\(\(beforeShell\?: \(\) => Promise<void>\): Promise<boolean> => \{[\s\S]{0,200}const result = await confirmSession\(beforeShell\);/);
  const shared = loadTsx(SHARED);
  const seen = [];
  const host = { finishLogin: async (opts) => { seen.push(opts); return null; } };
  const beforeShell = async () => {};
  await withGlobals({ window: { AuthScreens: host } }, async () => {
    assert.equal(await shared.finishLogin(beforeShell), null);
    assert.equal(await shared.finishLogin(), null);
  });
  assert.equal(seen[0].beforeShell, beforeShell);
  assert.equal(seen[1], undefined, 'the other sign-ins call it as before');
});

test('the sheet does not hand off when the make screen is not coming next: a refused session, a reload, the waiting room', async () => {
  // Refused: the sheet stays, with the notice, and nothing is drawn.
  const refused = finishHarness({ status: 401 });
  assert.equal((await refused.auth.finishLogin({ beforeShell: refused.beforeShell })).code, 'session-rejected');
  assert.deepEqual(refused.order, ['read:/api/auth/me']);
  // Behind the live build: the page reloads with the sheet still up and
  // busy; the new page draws the make screen as it starts.
  const reload = finishHarness({ move: 'reload' });
  void reload.auth.finishLogin({ beforeShell: reload.beforeShell });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reload.order, ['read:/api/auth/me', 'live-build']);
  // Still waiting for access: the waiting room, not the make screen.
  const waiting = finishHarness({ user: { id: 7, hasPlatformAccess: false } });
  assert.equal(await waiting.auth.finishLogin({ beforeShell: waiting.beforeShell }), null);
  assert.deepEqual(waiting.order, ['read:/api/auth/me', 'shell:7']);
});

test('Continue shows a spinner while it finishes, beside "Finishing…" (#4892)', () => {
  const sheet = read(SHEET);
  assert.match(sheet, /function FinishingSpinner\(\) \{\s+return <SpinnerArcIcon className="mr-2 h-\[18px\] w-\[18px\] shrink-0 animate-spin" aria-hidden="true" \/>;/);
  // The Welcome step's Continue and a provider's username step's, the two
  // that finish a new account and may hand off to the make screen.
  for (const step of ['account', 'username']) {
    // The account step's says "Create my account" when it makes the account with its username (#5255).
    const done = step === 'account'
      ? "needsUsername \\? t\\('auth:signInSheet\\.account\\.create'\\) : t\\('auth:signInSheet\\.account\\.submit'\\)"
      : `t\\('auth:signInSheet\\.${step}\\.submit'\\)`;
    assert.match(sheet, new RegExp(`\\{busy \\? <><FinishingSpinner />\\{t\\('auth:signInSheet\\.${step}\\.finishing'\\)\\}</> : ${done}\\}</button>`), step);
    assert.equal(message(`auth:signInSheet.${step}.submit`), 'Continue');
    assert.equal(message(`auth:signInSheet.${step}.finishing`), 'Finishing…');
  }
  // Busy through the whole wait: the account is saved, then `finish` (the
  // session read and the hand-off) is awaited before the button frees.
  assert.match(sheet, /await finish\('new'\);\s+\} catch \(err\) \{\s+setError\(sessionMintFailureMessage\(err\)\);\s+\} finally \{\s+setBusy\(false\);/);
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
