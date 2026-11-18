'use strict';

// #6797: two reads a signed-in page made for nobody.
//   - the 10-second version poll, from a tab nobody is looking at;
//   - the sign-in screens' options, read on every page load although the
//     screens are hidden for somebody signed in.
//
// Run with: node --test tests/boot-quiet-reads.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const APP_JS = read('public/js/app.js');

function sliceMember(src, signature) {
  const start = src.indexOf(`\n  ${signature}`);
  assert.ok(start >= 0, `${signature} is defined`);
  const close = '\n  },';
  return src.slice(start + 1, src.indexOf(close, start) + close.length);
}

test('the version poll stands down in a hidden tab and asks once on the way back', () => {
  const resync = APP_JS.slice(APP_JS.indexOf('App._foregroundResync = () => {'),
    APP_JS.indexOf("document.addEventListener('visibilitychange', App._foregroundResync);"));
  const document = { hidden: false, visibilityState: 'visible' };
  const sandbox = { document, window: {}, loads: 0 };
  vm.createContext(sandbox);
  vm.runInContext(`var App = { _sessionFromSnapshot: false, _versionPollMissed: false,
    loadVersion() { loads += 1; },
    ${sliceMember(APP_JS, '_pollVersion() {')}
  };
  ${resync.slice(0, resync.lastIndexOf('};') + 2)}
  globalThis.__App = App;`, sandbox);
  const App = sandbox.__App;

  App._pollVersion();
  assert.equal(sandbox.loads, 1, 'a tab in view polls as before');

  document.hidden = true; document.visibilityState = 'hidden';
  App._pollVersion(); App._pollVersion(); App._pollVersion();
  assert.equal(sandbox.loads, 1, 'a hidden tab asks nothing');
  App._foregroundResync();
  assert.equal(sandbox.loads, 1, 'and still nothing while it stays hidden');

  document.hidden = false; document.visibilityState = 'visible';
  App._foregroundResync();
  assert.equal(sandbox.loads, 2, 'back in view: one read, at once');
  App._foregroundResync();
  assert.equal(sandbox.loads, 2, 'a second focus event does not ask again');

  assert.match(APP_JS, /setInterval\(App\._pollVersion, 10_000\);/);
  assert.doesNotMatch(APP_JS, /setInterval\(App\.loadVersion, 10_000\)/);
});

test('the sign-in screens read their options when first shown, not on every page load', () => {
  const shared = read('frontend/src/features/auth/waitlist-shared.tsx');
  const hook = shared.slice(shared.indexOf('export function useWaitlistOptions('), shared.indexOf('// Chip classes'));
  assert.match(hook, /export function useWaitlistOptions\(enabled = true\)/, 'every other reader is unchanged');
  assert.match(hook, /if \(!enabled\) return undefined;/);
  assert.match(hook, /\}, \[enabled\]\);/, 'the read starts when the screen is shown');

  const login = read('frontend/src/features/auth/login.tsx');
  assert.ok(login.indexOf('const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.login);')
    < login.indexOf('newAccountsWait(useWaitlistOptions(mounted))'), 'the sign-in screen');
  assert.ok(login.indexOf('newAccountsWait(useWaitlistOptions(mounted))') > 0);

  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.ok(landing.indexOf('const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.landing);')
    < landing.indexOf('const waitlistPayload = useWaitlistOptions(mounted);'), 'the landing');
  assert.ok(landing.indexOf('const waitlistPayload = useWaitlistOptions(mounted);') > 0);
});
