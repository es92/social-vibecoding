'use strict';

// An invite's Join with a phone number (#4069's APIs, connected): a private
// member signs up with a phone, so the Join sheet asks for a name and a
// phone first whenever phone sign-in is offered (no username: the handle is
// picked from the name), the code request carries the reCAPTCHA Firebase
// asks a web caller for, an account with no verified phone is not made a
// private member by any of the ways a link is followed, and the waiting room
// lets such an account add one. The joining itself is pinned against
// PostgreSQL in tests/private-member-postgres.test.js, and #4069's own fixes
// (signed-out access, Firebase's error detail, reCAPTCHA) in
// tests/phone-auth-fixes.test.js.
//
// Run with: node --test tests/phone-invite-join.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const phoneAuth = require('../src/services/firebase-phone-auth');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('every way a link is followed asks for the phone while phone sign-in is offered', () => {
  const offered = /requirePhone: phoneAuth\.offered\(config\)/;
  assert.match(read('src/routes/community-invites.js'), offered, 'Join pressed while signed in');
  assert.match(read('src/routes/auth.js'), offered, 'the email code');
  assert.match(read('src/routes/sign-in-providers.js'), offered, 'Apple and Google');
  assert.match(read('src/routes/phone-auth.js'), /redeemCarried\(pool, req, res, result\.userId, \{ requirePhone: true \}\)/);
  const svc = read('src/services/community-invites.js');
  assert.match(svc, /async function redeem\(pool, \{ token, user, browser = null, requirePhone = false \}\)/);
  assert.match(svc, /joinAsPrivateMember\(client, user\.id, redemptionId, \{ requirePhone \}\)/);
  assert.match(svc, /const result = await redeem\(pool, \{ token, user, browser, requirePhone \}\);/);
  // Checked before anything joins them, so a refusal leaves the row queued.
  const join = svc.slice(svc.indexOf('async function joinAsPrivateMember('));
  assert.ok(join.indexOf('user_phone_identities') < join.indexOf('apply_community_invite'));
  assert.match(read('src/middleware/auth.js'), /'\/api\/auth\/oauth\/',[\s\S]{0,400}'\/api\/auth\/phone\/',/);
});

test('the invite\'s Join sheet starts with a phone number when the server offers it', () => {
  const { SignInSheet, phoneE164 } = loadTsx(SHEET);
  const render = (props) => renderToHtml(createElement(SignInSheet, {
    open: true, title: 'Join Best brunch spots', intro: '',
    from: 'invite', followInvite: true, onClose() {}, primaryClass: 'pill', ...props,
  }));
  const phone = render({ phone: true, providers: ['apple', 'google'] });
  assert.match(phone, /data-sign-in-sheet="phone"/);
  assert.match(phone, /<label for="sign-in-sheet-name"[^>]*>Your name<\/label>/);
  assert.match(phone, /<label for="sign-in-sheet-phone"[^>]*>Phone number<\/label>/);
  assert.ok(phone.indexOf('sign-in-sheet-name') < phone.indexOf('sign-in-sheet-phone"'), 'the name first, as the canvas draws it');
  // No lead, no line about who sees the number, no separate reCAPTCHA line (#4207).
  assert.doesNotMatch(phone, /No app, no password|sees your|never your number|This is protected by reCAPTCHA|data-sign-in-sheet-recaptcha/);
  assert.doesNotMatch(phone, /<p class="mt-1 text-\[15px\]/, 'an empty lead draws no paragraph');
  assert.doesNotMatch(phone, /username/i, 'no username is asked for');
  assert.match(phone, /id="sign-in-sheet-phone"[^>]*type="tel"[^>]*autoComplete="tel"|id="sign-in-sheet-phone"[^>]*type="tel"/);
  assert.match(phone, />Text me a code</);
  assert.match(phone, /Already on Homeroom\? <a href="#login" data-sign-in-sheet-other-ways=""[^>]*>Sign in another way<\/a>/);
  // Google's notice, for the badge the sheet hides, is its own quieter line
  // under the terms (#4379).
  assert.match(phone, /data-terms-notice="recaptcha"[^>]*>By continuing, you agree to Homeroom&#x27;s (<!-- -->)?terms(<!-- -->)?\.<\/p><p data-recaptcha-line=""[^>]*class="[^"]*text-\[12px\][^"]*text-zinc-400[^"]*">Protected by reCAPTCHA · Google (<!-- -->)?<a href="https:\/\/policies\.google\.com\/privacy"[^>]*>Privacy<\/a>(<!-- -->)? · (<!-- -->)?<a href="https:\/\/policies\.google\.com\/terms"[^>]*>Terms<\/a><\/p>/);
  assert.doesNotMatch(phone, /Privacy Policy|Terms of Service|\(reCAPTCHA\)/);
  assert.doesNotMatch(phone, /Continue with Apple|Sign in with a password|This makes your account/, 'the other ways are one tap away, not first');
  assert.doesNotMatch(phone, /—/);
  // Without the offer it is the sheet it was.
  const before = render({ phone: false, providers: [], intro: 'Sign in or make an account with your email. It takes a minute.' });
  assert.match(before, /data-sign-in-sheet="email"/);
  assert.doesNotMatch(before, /Phone number|Your name|reCAPTCHA|Join with your phone/);

  // The number goes as the server takes it; no country code is guessed.
  assert.equal(phoneE164('+1 (415) 555-0123'), '+14155550123');
  assert.equal(phoneE164('+44 20 7946 0958'), '+442079460958');
  assert.equal(phoneE164('+1.415.555.0123'), '+14155550123');
  assert.equal(phoneE164('4155550123'), null);
  assert.equal(phoneE164('+0 415'), null);
  assert.equal(phoneE164(''), null);
});

test('the sheet\'s phone steps: the code, then the username on the phone\'s own route', () => {
  const src = read(SHEET);
  assert.match(src, /const firstStep: Step = phone \? 'phone' : otherWays;/);
  assert.match(src, /const recaptchaToken = await phoneRecaptchaToken\(\);\s+const res = await fetch\('\/api\/auth\/phone\/request'/);
  assert.match(src, /body: JSON\.stringify\(\{ phoneNumber: value, \.\.\.\(recaptchaToken \? \{ recaptchaToken \} : \{\}\) \}\)/);
  const verify = src.slice(src.indexOf('const verifyPhone = useCallback'), src.indexOf('const finishAccount = useCallback'));
  assert.match(verify, /fetchSessionMint\('\/api\/auth\/phone\/verify'/);
  assert.match(verify, /sessionInfo: phoneSession\.current,\s+code,\s+\.\.\.\(phoneName\.current \? \{ name: phoneName\.current \} : \{\}\),\s+\.\.\.\(followInvite \? \{ followInvite: true \} : \{\}\),/);
  assert.match(src, /if \(!name\) \{ setError\('Enter your name\.'\);/);
  assert.match(verify, /if \(data\.next === 'signed-in'\) \{\s+await finish\(data\.created === true \? 'new' : 'existing'\);/);
  assert.match(verify, /setUsernameVia\('phone'\);\s+setStep\('username'\);/);
  assert.match(src, /fetchSessionMint\(usernameVia === 'phone' \? '\/api\/auth\/phone\/finish' : '\/api\/auth\/oauth\/finish'/);
  assert.match(src, /'Check your texts'/);
  assert.match(src, /`We sent a 6-digit code to the number ending \$\{phoneNumber\.slice\(-4\)\}\.`/);
  assert.match(src, /The code fills itself in on most phones\./);
  // The landing hands the offer to the invite's sheet only.
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /const phoneSignIn = waitlistPayload\?\.phone_sign_in === true;/);
  assert.equal((landing.match(/phone=\{phoneSignIn\}/g) || []).length, 1);
  assert.ok(landing.indexOf('phone={phoneSignIn}') < landing.indexOf('{storyOn ? (\n        <SignInSheet'));
  assert.match(read('frontend/src/features/auth/waitlist-shared.tsx'), /phone_sign_in\?: boolean;/);
});

test('one tap on a step\'s main button submits with the keyboard up (#4214)', () => {
  // iPhone Safari: the press blurred the field, the sheet rode down with the
  // keys before the click, and the click landed on nothing. The main buttons
  // keep the field focused through the press, as the composers' Send does.
  const { HOLD_FIELD_FOCUS, SignInSheet } = loadTsx(SHEET);
  let prevented = 0;
  HOLD_FIELD_FOCUS.onMouseDown({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1, 'the press moves no focus');
  assert.deepEqual(Object.keys(HOLD_FIELD_FOCUS), ['onMouseDown'], 'only the mousedown: a pointerdown or touch default still taps');
  const src = read(SHEET);
  const submits = src.match(/<button type="submit"[^>]*>/g) || [];
  assert.ok(submits.length >= 7, 'every step has its main button');
  for (const tag of submits) assert.match(tag, /\{\.\.\.HOLD_FIELD_FOCUS\}/, tag);
  const html = renderToHtml(createElement(SignInSheet, {
    open: true, title: 'Join Best brunch spots', intro: '', from: 'invite', followInvite: true,
    phone: true, onClose() {}, primaryClass: 'pill',
  }));
  assert.match(html, /<button type="submit"[^>]*>Text me a code<\/button>/);
  // Google's notice is in the fine print on both steps that run reCAPTCHA
  // (the code step's "Send a new code" asks again), and on no other.
  assert.match(src, /<TermsNotice className="mt-3" recaptcha=\{step === 'phone' \|\| step === 'phone-code' \? RECAPTCHA_LINE : null\} \/>/);
  const email = renderToHtml(createElement(SignInSheet, {
    open: true, title: 'Sign in', intro: 'x', from: 'signin', onClose() {}, primaryClass: 'pill',
  }));
  assert.match(email, /By continuing, you agree to Homeroom/);
  assert.doesNotMatch(email, /reCAPTCHA|policies\.google\.com/);
});

test('Google\'s script loads only for a phone code, never with the shell', () => {
  const src = read('frontend/src/features/auth/recaptcha.ts');
  assert.match(src, /const SCRIPT_SRC = 'https:\/\/www\.google\.com\/recaptcha\/api\.js\?render=explicit';/);
  assert.match(src, /fetch\('\/api\/auth\/phone\/recaptcha'/);
  assert.match(src, /size: 'invisible',\s+badge: 'inline',/);
  assert.doesNotMatch(read('frontend/src/head.html'), /recaptcha/i);
  // Only the phone screens reach for it: the sheet and the waiting room's card.
  const users = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(tsx?|jsx?)$/.test(entry.name) && /from '\.\/recaptcha'|features\/auth\/recaptcha/.test(read(rel))) users.push(rel);
    }
  };
  walk('frontend/src');
  assert.deepEqual(users.sort(), [
    path.join('frontend/src/features/auth/add-phone.tsx'),
    path.join('frontend/src/features/auth/sign-in-sheet.tsx'),
  ]);
});

test('a new phone account gives a name: verify finishes it, with a provisional handle picked from the name', () => {
  const { handlesFromName } = require('../src/services/usernames');
  assert.deepEqual(handlesFromName('Lina Park', 1), ['lina_park']);
  assert.deepEqual(handlesFromName('José Álvarez', 1), ['jose_alvarez']);
  assert.match(handlesFromName('Lina', 2)[1], /^lina_[0-9]{3,4}$/, 'then digits, for when it is taken');
  assert.deepEqual(handlesFromName('Al', 1), ['al_member'], 'too short alone');
  assert.deepEqual(handlesFromName('李小龙', 1), ['member'], 'nothing foldable');
  assert.match(handlesFromName('Homeroom Fan', 1)[0], /^member_[0-9]{3,4}$/, 'never a reserved prefix');
  for (const h of handlesFromName('O\'Brien-Smith the Third of Many Names', 4)) assert.match(h, /^[a-z0-9_]{3,32}$/);
  assert.equal(phoneAuth.cleanName('  Lina   Park '), 'Lina Park');
  assert.equal(phoneAuth.cleanName(''), null);
  assert.equal(phoneAuth.cleanName('x'.repeat(41)), null, 'the profile\'s 40');
  assert.equal(phoneAuth.cleanName('a\u0007b'), null);
  const routes = read('src/routes/phone-auth.js');
  const verify = routes.slice(routes.indexOf("router.post('/api/auth/phone/verify'"), routes.indexOf("router.post('/api/auth/phone/finish'"));
  assert.match(verify, /const name = result\.next === 'username' && !invite\?\.public\s+\? phoneAuth\.cleanName\(req\.body\?\.name\) : null;/);
  assert.match(verify, /phoneAuth\.finishWithName\(pool, \{ signupToken: result\.signupToken, name, createSession \}\)/);
  assert.ok(verify.indexOf('finishWithName') > verify.indexOf('redeemCarried'), 'the link is followed by the account first');
  assert.ok(verify.indexOf('finishWithName') < verify.indexOf("privateCookie(res, 'hr_phone_signup'"), 'before any username step');
});

test('a signed-in account adds a phone through routes the waiting room can reach', async () => {
  const routes = read('src/routes/phone-auth.js');
  // Limiters first, then the same-origin check (tests/same-site-browser.test.js).
  // A test number skips the text buckets (tests/phone-test-numbers.test.js).
  assert.match(routes, /router\.post\(\s+'\/api\/auth\/phone-link\/request',\s+requireOffered,\s+unlessTestNumber\(phoneOtpRequestLimiter\),\s+unlessTestNumber\(phoneOtpRequestPhoneLimiter\),\s+sameOriginBrowserOnly,\s+signedIn,/);
  assert.match(routes, /router\.post\(\s+'\/api\/auth\/phone-link\/verify',\s+requireOffered,\s+phoneVerifyLimiter,\s+sameOriginBrowserOnly,\s+signedIn,/);
  assert.match(routes, /const linked = await phoneAuth\.linkPhone\(pool, claims, req\.user\.id\);\s+const joined = await communityInvites\.joinQueued\(pool, req\.user\.id\);/);
  // Under /api/auth/, which the platform-access gate leaves open to a waiting
  // account, and outside the pre-login /api/auth/phone/, so the session is read.
  const auth = read('src/middleware/auth.js');
  assert.match(auth, /const GATE_OPEN_PATHS = \[[\s\S]*?'\/api\/auth\/',/);
  assert.equal('/api/auth/phone-link/verify'.startsWith('/api/auth/phone/'), false);
  // Signed out, with the offer off, it answers its own gate.
  const { authMiddleware } = require('../src/middleware/auth');
  const { phoneAuthRoutes } = require('../src/routes/phone-auth');
  const app = express();
  app.use(express.json());
  app.use(authMiddleware({ databaseUrl: 'postgres://nobody@127.0.0.1:1/none' }));
  app.use(phoneAuthRoutes({ firebasePhoneAuthEnabled: false }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/auth/phone-link/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401, 'no session: the session middleware answers, not the phone route');
  });
});

test('the waiting room: a queued group can be joined now by adding a phone, and lands in its app', () => {
  const { AddPhoneCard } = loadTsx('frontend/src/features/auth/add-phone.tsx');
  const card = renderToHtml(createElement(AddPhoneCard, { groups: ['Best brunch spots'], onJoined() {} }));
  assert.match(card, /data-add-phone="phone"/);
  assert.match(card, />Join Best brunch spots now</);
  assert.match(card, /Add your phone number and you’re in, no waiting\. The group sees your name, never your number\./);
  assert.match(card, /<label for="add-phone-number"[^>]*>Phone number<\/label>/);
  assert.match(card, />Text me a code</);
  assert.match(card, /data-sign-in-sheet-recaptcha=""[^>]*>Protected by reCAPTCHA · Google (<!-- -->)?<a href="https:\/\/policies\.google\.com\/privacy"[^>]*>Privacy<\/a>(<!-- -->)? · (<!-- -->)?<a href="https:\/\/policies\.google\.com\/terms"[^>]*>Terms<\/a><\/p>/);
  assert.doesNotMatch(card, /This is protected by reCAPTCHA|Privacy Policy|Terms of Service/);
  assert.doesNotMatch(card, /—/);
  const two = renderToHtml(createElement(AddPhoneCard, { groups: ['A', 'B'], onJoined() {} }));
  assert.match(two, />Join them now</);
  const src = read('frontend/src/features/auth/add-phone.tsx');
  // The phone and code forms share a slot: each is keyed, or React reuses the
  // number's <input> as the Code field and the number shows up in it (#4143).
  assert.match(src, /<form key="phone" /);
  assert.match(src, /<form key="code" /);
  assert.match(src, /fetch\('\/api\/auth\/phone-link\/request'/);
  assert.match(src, /fetch\('\/api\/auth\/phone-link\/verify'/);
  const waiting = read('frontend/src/features/auth/waiting.tsx');
  assert.match(waiting, /setPhoneOffered\(options\?\.phone_sign_in === true\);/);
  assert.match(waiting, /\{phoneOffered && queued\.length \? \(\s+<AddPhoneCard groups=\{queued\.map\(\(q\) => q\.name\)\} onJoined=\{onJoined\} \/>/);
  assert.match(waiting, /if \(host && joined\[0\]\?\.slug\) host\._pendingHash = `\/app\/\$\{joined\[0\]\.slug\}`;\s+void check\(\);/);
  // deepLinkUrl takes that app path as it is.
  assert.match(read('public/js/auth-screens.js'), /if \(value\.startsWith\('\/app\/'\)\) return value;/);
});

test('a provisional handle: private groups see it, public places ask for a username first', () => {
  // A public community's invite asks no name: the username step follows the code.
  const { SignInSheet } = loadTsx(SHEET);
  const pub = renderToHtml(createElement(SignInSheet, {
    open: true, title: 'Join Open garden', intro: '',
    from: 'invite', followInvite: true, phone: true, askName: false, onClose() {}, primaryClass: 'pill',
  }));
  assert.match(pub, /<label for="sign-in-sheet-phone"/);
  assert.doesNotMatch(pub, /sign-in-sheet-name|Your name/);
  assert.doesNotMatch(pub, /Nobody sees your number/);
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /askName=\{!invite!\.project!\.public\}/);
  assert.doesNotMatch(landing, /\bintro=/, 'no line under the title, the phone join included');
  assert.doesNotMatch(landing, /No app, no password/);
  assert.match(read('src/routes/phone-auth.js'), /const name = result\.next === 'username' && !invite\?\.public\s+\? phoneAuth\.cleanName\(req\.body\?\.name\) : null;/);
  assert.match(read('src/services/firebase-phone-auth.js'), /username_provisional_since = NOW\(\),/);

  // Every place a handle would go public refuses a provisional one.
  const server = read('server.js');
  assert.match(server, /if \(provisionalHandle && appRow\.view_visibility === 'public'\) \{\s+return res\.status\(409\)\.json\(usernames\.USERNAME_REQUIRED\);/);
  assert.match(read('src/services/edge-gate.js'), /if \(publicApp && user\.provisional === true\) return null;/);
  assert.match(read('src/services/edge-gate.js'), /mintIdentity\(pool, vis\.appId, identityFor, \{ publicApp: !vis\.viewPrivate \}\)/);
  assert.match(read('src/routes/apps.js'), /if \(app\.view_visibility === 'public' && await usernames\.isProvisional\(pool, req\.user\.id\)\) \{\s+return res\.status\(409\)\.json\(usernames\.USERNAME_REQUIRED\);/);
  const svc = read('src/services/community-invites.js');
  assert.match(svc, /if \(invite\.view_visibility === 'public'\s+&& await require\('\.\/usernames'\)\.isProvisional\(client, user\.id\)\) \{\s+await client\.query\('ROLLBACK'\);\s+return \{ ok: false, status: 409, reason: 'username_required' \};/);
  assert.match(read('src/routes/community-invites.js'), /if \(result\.reason === 'username_required'\) \{\s+return res\.status\(409\)\.json\(\{ \.\.\.require\('\.\.\/services\/usernames'\)\.USERNAME_REQUIRED, reason: result\.reason \}\);/);
  const { USERNAME_REQUIRED } = require('../src/services/usernames');
  assert.equal(USERNAME_REQUIRED.code, 'username_required');
  assert.match(USERNAME_REQUIRED.error, /Public places show your username, not your name\./);
  // The choice replaces it once, without a ledger row or a cooldown.
  const profile = read('src/routes/profile.js');
  assert.match(profile, /const result = provisional\s+\? await usernames\.replaceProvisionalUsername\(pool, req\.user\.id, next\)\s+: await usernames\.chooseFirstUsername\(pool, req\.user\.id, next\);/);
  assert.match(read('src/routes/auth.js'), /\(u\.username_provisional_since IS NOT NULL\) AS username_provisional,/);

  // The shell asks before a public app, and on a refused public join.
  const app = read('public/js/app.js');
  assert.match(app, /if \(App\.user\?\.usernameProvisional && !opts\?\.usernameChecked\) \{\s+return App\._navigateAfterUsername\(slug, tab, ref, subTab\);/);
  assert.match(app, /if \(!\(await App\._usernameBeforePublic\(slug\)\)\) \{[\s\S]{0,200}return App\.navigateToApp\(slug, tab, ref, subTab, \{ usernameChecked: true \}\);/);
  assert.match(app, /if \(audience !== 'open'\) return true;\s+return !!\(await window\.UsernameFirstRun\?\.askForPublic\?\.\(\)\);/);
  assert.match(app, /await window\.UsernameFirstRun\.publicRetry\(redeem\)/);
  assert.match(read('frontend/src/features/home/home.js'), /const res = desired && retry \? await retry\(write\) : await write\(\);/);
  assert.match(read('frontend/src/features/dev-board/workshop/invite-offer.ts'), /if \(result\.reason === 'username_required'\) \{/);
  const gate = read('frontend/src/features/auth/username-first-run.js');
  assert.match(gate, /forPublic \? 'Pick a username' : 'Choose your username'/);
  assert.match(gate, /'Public apps show this, not your name\. Letters, numbers and '/);
  assert.match(gate, /'Not now'\);/);
  assert.match(gate, /sheet = PlatformUI\.modal\(\{ contentEl: panel, dismissible: forPublic, onDismiss \}\);/);
  assert.match(gate, /if \(body\.code !== 'username_required'\) return res;/);
});
