'use strict';
// Which button on the signed-out pages a sign-up came from: the landing
// notes it in a cookie (frontend/src/features/auth/sign-up-from.ts) and the
// three ways an account is made record it on `user_signed_up`
// (src/services/sign-up-from.js).
//
// Run with: node --test tests/sign-up-from.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const fromServer = require('../src/services/sign-up-from');

const CLIENT = 'frontend/src/features/auth/sign-up-from.ts';
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the page and the server know the same buttons and the same cookie', () => {
  const client = loadTsx(CLIENT);
  assert.deepEqual([...client.SIGN_UP_FROM], [...fromServer.SIGN_UP_FROM]);
  assert.equal(client.SIGN_UP_FROM_COOKIE, fromServer.SIGN_UP_FROM_COOKIE);
  assert.equal(fromServer.SIGN_UP_FROM_COOKIE, 'hr_signup_from');
});

test('only a known button is recorded; anything else records the sign-up as before', () => {
  const { signUpFrom, signUpMetadata } = fromServer;
  const req = (value) => ({ cookies: value === undefined ? {} : { hr_signup_from: value } });
  assert.equal(signUpFrom(req('vote')), 'vote');
  assert.equal(signUpFrom(req('hero')), 'hero');
  assert.equal(signUpFrom(req('<script>')), null);
  assert.equal(signUpFrom(req(['vote'])), null);
  assert.equal(signUpFrom(req()), null);
  assert.equal(signUpFrom({}), null);
  assert.equal(signUpFrom(null), null);
  assert.deepEqual(signUpMetadata(req('vote'), { via: 'email' }), { via: 'email', from: 'vote' });
  // The "Want to join in?" card is gone, and its name with it.
  assert.deepEqual(signUpMetadata(req('join_card'), { via: 'email' }), { via: 'email' });
  assert.deepEqual(signUpMetadata(req('nonsense'), { via: 'google' }), { via: 'google' });
});

test('the cookie is short-lived, first-party and Lax, so a provider\'s callback carries it', () => {
  const src = read(CLIENT);
  assert.match(src, /const MAX_AGE_S = 60 \* 60;/);
  assert.match(src, /document\.cookie = `\$\{SIGN_UP_FROM_COOKIE\}=\$\{from\}; Max-Age=\$\{MAX_AGE_S\}; Path=\/; SameSite=Lax\$\{secure\}`;/);
  // It never throws into a sign-in.
  assert.match(src, /try \{[\s\S]*document\.cookie[\s\S]*\} catch \{/);
});

test('every way an account is made records the sign-up with the button it came from', () => {
  assert.match(read('src/routes/auth.js'),
    /events\.record\(pool, \{ type: events\.EVENT_TYPES\.USER_SIGNED_UP, userId: verified\.userId, metadata: signUpMetadata\(req, \{ via: 'email' \}\) \}\);/);
  assert.match(read('src/routes/sign-in-providers.js'),
    /events\.record\(pool, \{ type: events\.EVENT_TYPES\.USER_SIGNED_UP, userId: result\.userId, metadata: signUpMetadata\(req, \{ via: provider \}\) \}\);/);
  // A phone-made account recorded no sign-up at all before.
  const phone = read('src/routes/phone-auth.js');
  const created = phone.slice(phone.indexOf('if (result.created) {'), phone.indexOf('// A new account whose sheet sent its name'));
  assert.match(created, /events\.record\(pool, \{ type: events\.EVENT_TYPES\.USER_SIGNED_UP, userId: result\.userId, metadata: signUpMetadata\(req, \{ via: 'phone' \}\) \}\);/);
});

test('each button notes itself as its sheet opens', () => {
  const where = {
    // The short story has no button of its own since 13 Nov 2026: `hero` is
    // the same button where the page is drawn in one of the looks.
    'frontend/src/features/auth/story.tsx': ['story', 'story_sign_in'],
    'frontend/src/features/guest/frame/landing-frame.tsx': ['hero'],
    'frontend/src/features/auth/landing.tsx': ['header_sign_in', 'header_sign_up', 'link'],
    // The page about private communities, from either of its two buttons.
    'frontend/src/features/guest/guest-communities.tsx': ['groups'],
  };
  for (const [file, kinds] of Object.entries(where)) {
    const text = read(file);
    for (const from of kinds) assert.match(text, new RegExp(`noteSignUpFrom\\('${from}'\\)`), `${from} in ${file}`);
  }
  const src = read('frontend/src/features/auth/landing.tsx');
  // What the visitor tried on a project's page: Join, Vote, Ask, the chat, Try it.
  assert.match(src, /const askFor = useCallback\(\(i: GuestIntent\) => \{[\s\S]{0,200}noteSignUpFrom\(i\.kind\);/);
  const { SIGN_UP_FROM } = loadTsx(CLIENT);
  for (const kind of ['join', 'vote', 'ask', 'chat', 'use']) assert.ok(SIGN_UP_FROM.includes(kind), kind);
});
