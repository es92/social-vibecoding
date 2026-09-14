// Content pins for the email password-reset UI (login screen recovery
// flow + the #reset-password/<token> magic-link route).
//
// The shell's markup was frozen against a whole-document fixture when this
// was written (#1078 narrowed that to the id/script baselines), so — like
// every post-fixture feature — the reset UI is NOT part of the prerendered
// document. It used to be built at runtime by public/js/auth-screens.js;
// since #1080 chunk C the login screen is a React component and the same two
// blocks are mounted on demand instead (`resetUi` state). Same contract,
// same reason: the id baseline records what the hand-written shell shipped.
// These are source pins in the style of tests/landing-directory.test.js:
// they hold that contract in place so a refactor that silently drops a
// piece fails loudly here.
//
// Run with: node --test tests/password-reset-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// The login screen (and with it both reset views) is React now; the router
// that dispatches to it is still the legacy module until the last chunk.
const LOGIN_TSX = 'frontend/src/features/auth/login.tsx';

// ─── the magic-link route ──────────────────────────────────────────

test('reset-password is a login-screen route with a dispatcher and depth', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /'reset-password':\s*'auth-login-screen'/,
    'route renders on the login screen, like signup');
  assert.match(js, /_resetOnShow/, 'show() dispatches to a reset handler');
  // …and the converted screen supplies that handler.
  assert.match(read(LOGIN_TSX), /_resetOnShow: \(token\?: string\) => live\.current\.resetOnShow\(token\)/,
    'the React screen patches the dispatcher target onto AuthScreens');
});

test('the emailed link format matches the route the front end registers', () => {
  const mail = read('src/services/mail/index.js');
  // Segment style (like #more/<token>) — routeFromHash splits on '/'.
  assert.match(mail, /#reset-password\/\$\{token\}/);
});

// ─── recovery screen: the email-request form ───────────────────────

test('recovery screen builds an email form that posts to the request endpoint', () => {
  const tsx = read(LOGIN_TSX);
  assert.match(tsx, /recovery-email-input/, 'email input exists');
  assert.match(tsx, /\/api\/auth\/password-reset\/request/);
});

test('the request result copy is anti-enumeration (same message either way)', () => {
  const tsx = read(LOGIN_TSX);
  assert.match(tsx, /If that address matches an account/i,
    'success copy must not confirm the account exists');
});

test('the admin fallback is separated and its copy is spaced correctly (#1158)', () => {
  const tsx = read(LOGIN_TSX);
  // The divider marks the admin route as the final alternative below the
  // email flow.
  assert.match(tsx, /id="recovery-admin"[\s\S]{0,1200}?<hr /,
    'a divider opens the admin fallback block');
  // JSX drops a line-ending space, so the separators before the inline
  // elements must live inside string expressions — the shipped copy rendered
  // "atemporary" / "fromSettings" without them.
  assert.match(tsx, /\{'Ask a Homeroom platform admin to issue you a '\}/,
    'explicit space before the "temporary password" span');
  assert.match(tsx, /\{"\. Once you're back in, set a password you choose from "\}/,
    'explicit space before the Settings → Change password link');
});

test('the recovery view is URL-reachable for captures (#1158)', () => {
  // The screenshot-state deep link: login.tsx opens the forgot-password view
  // on ?shot=password-recovery, and app.js boots the anonymous shell for it
  // so the capture session cannot strip #login to the home feed.
  assert.match(read(LOGIN_TSX), /shot === 'password-recovery'/,
    'login screen handles the shot param');
  assert.match(read('public/js/app.js'), /shot !== 'password-recovery'/,
    'the shot boots the anonymous shell like ?shot=anon');
});

test('the stale "no email on file" claim is rewritten once the email path exists', () => {
  const tsx = read(LOGIN_TSX);
  // The frozen markup's lead still carries the pre-email copy; the screen
  // must swap it so the admin path reads as the fallback, not the rule.
  assert.match(tsx, /recovery-admin/, 'admin fallback block is still used');
  assert.match(tsx, /No confirmed email on your account\?/,
    'fallback copy repositions the admin path');
  assert.match(tsx, /resetUi \? ADMIN_LEAD_WITH_EMAIL : ADMIN_LEAD_SHIPPED/,
    'the swap is tied to the same flag that mounts the email form');
});

// ─── the confirm view ──────────────────────────────────────────────

test('the reset view posts token + new password to the confirm endpoint', () => {
  const tsx = read(LOGIN_TSX);
  assert.match(tsx, /\/api\/auth\/password-reset\/confirm/);
  assert.match(tsx, /reset-new-password/, 'new-password input exists');
  assert.match(tsx, /reset-confirm-password/, 'confirm input exists');
});

test('a refused token gets the generic expired-link message with a way back', () => {
  const tsx = read(LOGIN_TSX);
  assert.match(tsx, /invalid or has expired/i);
  assert.match(tsx, /request a new/i, 'points the user back at requesting a fresh link');
});

// ─── frozen-markup contract ────────────────────────────────────────

test('the prerendered document carries no reset-password markup', () => {
  // The real artifact the id baseline covers. Both blocks must arrive from
  // a state change in the browser, never from the shipped HTML.
  const html = read('public/index.html');
  assert.doesNotMatch(html, /reset-password-view|recovery-email-input/,
    'reset UI must be mounted on demand (markup parity contract, step 1)');
  const tsx = read(LOGIN_TSX);
  assert.match(tsx, /const \[resetUi, setResetUi\] = useState\(false\)/,
    'the gate starts closed, so the prerender pass renders neither block');
});
