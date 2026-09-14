// The once-per-account welcome on Home (#1561).
//
// A new account lands on a launcher grid of other people's apps with nothing
// on the screen saying what the place is — that the apps are changed by the
// people using them, and that nothing ships without a group vote. Everything
// else on Home assumes you already know.
//
// The two decisions worth pinning are both about NOT asking the server:
//
//   - "first login" is "you have not dismissed this yet". The platform
//     publishes no account creation date to the client, and a rule that
//     needed one would mean a new API field for a banner.
//   - the storage key carries the user id, so two accounts on one device get
//     their own answer and signing out of one does not silence the other.
//
// And the island rule: the strip is always in the document and starts
// `hidden`, because the viewer is not known at prerender time. A first render
// that disagreed would be a hydration mismatch, which console.errors, which
// fails proposal checks.
//
// Run with: node --test tests/home-welcome-banner.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/home/welcome-banner.tsx'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

test('the first render is the hidden strip, with nothing resolved', () => {
  const html = renderComponent(
    'frontend/src/features/home/welcome-banner.tsx', 'WelcomeBanner');
  assert.match(html, /id="home-welcome"/);
  assert.match(html, /class="hidden /, 'hidden until an effect says otherwise');
  assert.match(html, /id="home-welcome-dismiss"/);
  // Visibility rides a ref, never a rendered className — the class attribute
  // must be a constant for the reason lib/legacy-dom.ts explains.
  assert.doesNotMatch(SRC, /className=\{/);
  assert.match(SRC, /useHiddenClass\(ref, !show\)/);
});

test('it is in the built document, above the launcher grid', () => {
  assert.ok(INDEX.includes('id="home-welcome"'), 'prerendered, like the install strip');
  const body = INDEX.slice(INDEX.indexOf('id="home-body"'));
  assert.ok(
    body.indexOf('id="home-welcome"') < body.indexOf('id="app-list"'),
    'a first-time viewer reads it before the grid it explains');
});

test('the dismissal is per account, and never a bare global key', () => {
  assert.match(SRC, /const KEY_PREFIX = 'usernode:home-welcome-dismissed:'/);
  assert.match(SRC, /return userId == null \? null : `\$\{KEY_PREFIX\}\$\{userId\}`/);
  // No user, no banner: there is nobody to welcome, and no key to write under.
  assert.match(SRC, /if \(!key\) return true; \/\/ Nobody to welcome yet\./);
});

test('storage is best-effort, and fails toward showing rather than hiding', () => {
  const read = SRC.slice(SRC.indexOf('function readDismissed'));
  const body = read.slice(0, read.indexOf('\n}'));
  assert.match(body, /catch \{/);
  assert.match(body, /return false;/,
    'storage denied shows the banner rather than silently retiring it');
  // The write is wrapped too; a dismissal that cannot persist still hides it
  // for this visit, because setShow(false) does not depend on the write.
  const dismiss = SRC.slice(SRC.indexOf('const dismiss ='));
  assert.ok(dismiss.indexOf('writeDismissed(userId)') < dismiss.indexOf('setShow(false)'));
});

test('the copy says the two things the screen otherwise does not', () => {
  assert.match(SRC, /built and changed by the people using it/);
  assert.match(SRC, /Nothing ships until the group votes it in\./);
  // No em dash: tests/no-em-dash-in-copy.test.js bans it in shipped copy, and
  // this file is all copy.
  const copy = SRC.slice(SRC.indexOf('Welcome to Homeroom'));
  assert.doesNotMatch(copy.slice(0, 600), /—/);
});
