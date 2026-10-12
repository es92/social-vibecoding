'use strict';

// "Signing you in…": the plain screen over the story while Get started
// spends a "You're in" mail's one-time sign-in
// (frontend/src/features/auth/landing.tsx SigningIn, over the sheet's `link`
// step in frontend/src/features/auth/sign-in-sheet.tsx).
//
// Onboarding run, 12 Oct 2026, iPhone Safari: while the link signed in, the
// story stayed up with the address under "Welcome to Homeroom", and then the
// Welcome sheet opened over it. The request: the Homeroom logo, a spinner and
// "Signing you in…" for that moment, plain, and only for that moment.
//
// Effects do not run here (tests/lib/render-tsx.js), so the decision is a
// plain function (linkSigningIn) and the wiring is read from the sources.
//
// Run with: node --test tests/landing-signing-in.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';
const LANDING = 'frontend/src/features/auth/landing.tsx';

test('the screen is up while the link is spent, and every way that ends takes it down', () => {
  const { linkSigningIn } = loadTsx(SHEET);
  const spending = { open: true, step: 'link', closing: false, error: null, failure: null };
  assert.equal(linkSigningIn(spending), true, 'Get started, the link being spent');
  // A link that signed straight in stays on its step while the shell takes
  // over, so the screen stays until the next one is drawn.
  // Spent: Welcome. Refused or failed: the code it falls back to, or the
  // email step when the token names no address.
  for (const step of ['account', 'code', 'email']) {
    assert.equal(linkSigningIn({ ...spending, step }), false, step);
  }
  // An error that leaves the step where it is (offline, a code that could
  // not be sent, the network): the sheet that says so, not a spinner.
  assert.equal(linkSigningIn({ ...spending, error: 'You are offline' }), false, 'an error');
  // A session the shell could not confirm: its notice and Retry.
  assert.equal(linkSigningIn({ ...spending, failure: { code: 'network-error' } }), false, 'no session');
  // Escape, or the sheet closed.
  assert.equal(linkSigningIn({ ...spending, closing: true }), false, 'on its way down');
  assert.equal(linkSigningIn({ ...spending, open: false }), false, 'closed');
});

test('the sheet says when the moment starts and ends, and stays down under the screen', () => {
  const src = read(SHEET);
  assert.match(src, /const signingIn = linkSigningIn\(\{ open, step, closing, error, failure: completion\.failure \}\);/);
  // True as it starts; false as it ends, and if the sheet goes first.
  assert.match(src, /if \(!signingIn \|\| !onSigningIn\) return undefined;\s+onSigningIn\(true\);\s+return \(\) => onSigningIn\(false\);\s+\}, \[signingIn, onSigningIn\]\);/);
  // Held, the panel and its dim stay down, so the step after the link comes
  // up as the screen goes.
  assert.match(src, /const up = shown && !held;/);
  assert.match(src, /: up \? 'translate-y-0 md:-translate-x-1\/2 md:-translate-y-1\/2' : 'translate-y-full md:-translate-x-1\/2 md:-translate-y-1\/2';/);
  assert.match(src, /bg-black\/40 transition-opacity duration-200 motion-reduce:transition-none \$\{up \? 'opacity-100' : 'opacity-0'\}/);
  // Nothing else opens the sheet held: the default is the sheet as it was.
  assert.match(src, /onSigningIn, held = false, beforeFinish,/);
  // The sheet's own words for the step stay, for a spend that runs long.
  assert.match(src, /step === 'link' \? t\('auth:signInSheet\.link\.title'\)/);
});

test('the story shows it over Get started\'s sheet only, and never for longer than its limit', () => {
  const src = read(LANDING);
  const { SIGNING_IN_MAX_MS } = loadTsx(LANDING);
  assert.equal(SIGNING_IN_MAX_MS, 20000);
  // Told by the story's sheet, the one that carries the link; the invite's
  // Join sheet carries none and says nothing.
  assert.match(src, /releaseSignIn=\{sheet === 'start' \? release\?\.signIn \?\? null : null\}\s+beforeFinish=\{startedFromStory\}\s+onClose=\{closeSheet\}\s+primaryClass=\{PRIMARY_PILL\}\s+onSigningIn=\{setSigningIn\}\s+held=\{signingInShown\}\s+\/>/);
  assert.equal((src.match(/onSigningIn=/g) || []).length, 1, 'one sheet tells it');
  assert.match(src, /const signingInShown = signingIn && !signingInOverdue && storyOn && sheet === 'start';/);
  assert.match(src, /\{signingInShown \? <SigningIn \/> : null\}/);
  // A spend that has not answered gives way to the sheet as it stands, with
  // its ✕: a stalled request never strands anyone on the spinner.
  assert.match(src, /setSigningInOverdue\(false\);\s+if \(!signingIn\) return undefined;\s+const timer = window\.setTimeout\(\(\) => setSigningInOverdue\(true\), SIGNING_IN_MAX_MS\);\s+return \(\) => window\.clearTimeout\(timer\);\s+\}, \[signingIn\]\);/);
  // Rendered nothing until then: the interior's first commit is unchanged.
  assert.match(src, /const \[signingIn, setSigningIn\] = useState\(false\);/);
  // The story still waits for Get started (Evan, 10 Oct 2026): the link is
  // spent on the tap, never on load.
  assert.match(src, /if \(link\.route !== 'signup'\) setSheet\('signin'\);/);
});

test('it is plain: the logotype, a spinner and "Signing you in…", on the landing\'s ground', () => {
  assert.equal(message('auth:landing.signingIn'), 'Signing you in…');
  const html = renderComponent(LANDING, 'SigningIn', {});
  assert.match(html, /^<div data-landing-signing-in="" role="status" class="fixed inset-0 z-\[60\] flex touch-none flex-col items-center justify-center px-4 text-center" style="background:var\(--home-wallpaper\)">/);
  // The logotype, inked as everywhere (#4382), and silent: the line says it.
  assert.match(html, /<svg class="h-8 w-auto text-zinc-950 dark:text-white" fill="currentColor" viewBox="0 0 1236\.9 319\.2" aria-hidden="true">/);
  // The spinner turns, except for reduced motion.
  assert.match(html, /<svg class="mt-8 h-6 w-6 animate-spin motion-reduce:animate-none text-zinc-500 dark:text-zinc-400"[^>]*aria-hidden="true"/);
  assert.match(html, /<p class="mt-3 text-\[15px\] leading-5 text-zinc-500 dark:text-zinc-400">Signing you in…<\/p><\/div>$/);
  // Nothing else: no address (the Welcome sheet says it), no button.
  assert.doesNotMatch(html, /@|<button|<a /);
  assert.equal((html.match(/<svg/g) || []).length, 2);
});
