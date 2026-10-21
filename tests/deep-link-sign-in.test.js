'use strict';

// A shared link opened while signed out (#5264): the landing's sign-in sheet,
// titled for where the link leads, over a blurred stand-in for that page, in
// place of the full-page "Sign in" form; signing in lands on the link
// (frontend/src/features/auth/deep-link-sign-in.tsx, landing.tsx,
// AuthScreens.showSignInFor, App.restoreFromHash).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const providers = require('../src/services/sign-in-providers');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MOD = 'frontend/src/features/auth/deep-link-sign-in.tsx';
const lib = () => loadTsx(MOD);

test('the place a link names: a screen, a project, or a page', () => {
  const { deepLinkPlace } = lib();
  assert.deepEqual(deepLinkPlace('#apps'), { kind: 'screen', screen: 'discover' });
  assert.deepEqual(deepLinkPlace('#discover'), { kind: 'screen', screen: 'discover' });
  assert.deepEqual(deepLinkPlace('#apps/demo-app'), { kind: 'screen', screen: 'discover' });
  assert.deepEqual(deepLinkPlace('#messages'), { kind: 'screen', screen: 'messages' });
  assert.deepEqual(deepLinkPlace('#chat/12'), { kind: 'screen', screen: 'messages' });
  assert.deepEqual(deepLinkPlace('#communities'), { kind: 'screen', screen: 'communities' });
  assert.deepEqual(deepLinkPlace('#workshop'), { kind: 'screen', screen: 'communities' });
  assert.deepEqual(deepLinkPlace('#notifications'), { kind: 'screen', screen: 'notifications' });
  assert.deepEqual(deepLinkPlace('#settings/account'), { kind: 'screen', screen: 'settings' });
  assert.deepEqual(deepLinkPlace('#app/demo-app/board'), { kind: 'project', slug: 'demo-app' });
  assert.deepEqual(deepLinkPlace('#app/demo-app/full?path=/t/1'), { kind: 'project', slug: 'demo-app' });
  assert.deepEqual(deepLinkPlace('/app/demo-app/dev?demo=1'), { kind: 'project', slug: 'demo-app' });
  assert.deepEqual(deepLinkPlace('#app/Not%20A%20Slug'), { kind: 'page' });
  assert.deepEqual(deepLinkPlace('#leaderboard'), { kind: 'page' });
  assert.deepEqual(deepLinkPlace('#toString'), { kind: 'page' }, 'only the map\'s own keys');
  assert.deepEqual(deepLinkPlace(''), { kind: 'page' });
});

test('the title names the place, each a whole message', () => {
  const { deepLinkTitle } = lib();
  const t = (id, params) => message(id, params);
  assert.equal(deepLinkTitle({ kind: 'screen', screen: 'discover' }, null, t), 'Sign in to open Discover');
  assert.equal(deepLinkTitle({ kind: 'screen', screen: 'messages' }, null, t), 'Sign in to open Messages');
  assert.equal(deepLinkTitle({ kind: 'screen', screen: 'communities' }, null, t), 'Sign in to open Communities');
  assert.equal(deepLinkTitle({ kind: 'screen', screen: 'notifications' }, null, t), 'Sign in to see your notifications');
  assert.equal(deepLinkTitle({ kind: 'screen', screen: 'settings' }, null, t), 'Sign in to open Settings');
  assert.equal(deepLinkTitle({ kind: 'project', slug: 'run' }, 'Sunday Run Club', t), 'Sign in to open Sunday Run Club');
  assert.equal(deepLinkTitle({ kind: 'project', slug: 'run' }, null, t), 'Sign in to open this project');
  assert.equal(deepLinkTitle({ kind: 'page' }, null, t), 'Sign in to open this page');
});

test('a provider\'s trip comes back to the link, and the server takes only paths on this origin', () => {
  const { deepLinkReturnTo } = lib();
  assert.equal(deepLinkReturnTo('#apps'), '/#apps');
  assert.equal(deepLinkReturnTo('#app/demo-app/board'), '/#app/demo-app/board');
  assert.equal(deepLinkReturnTo('/app/demo-app/board?demo=1'), '/app/demo-app/board');
  assert.equal(deepLinkReturnTo('#'), '/');
  assert.equal(deepLinkReturnTo(''), '/');
  for (const value of ['/', '/#apps', '/#app/demo-app/board', '/app/demo-app/board', '/invite/AAAAAAAAAAAAAAAAAAAAAA']) {
    assert.equal(providers.safeReturnTo(value), value, value);
  }
  for (const value of ['//evil.example', '//evil.example/#apps', 'https://evil.example/', '/\\evil.example',
    'javascript:alert(1)', '/x', '/app/../x', '/app/Demo', '/#', '/#a b', '/#<x>', null, 7]) {
    assert.equal(providers.safeReturnTo(value), '/', String(value));
  }
});

test('the backdrop is a stand-in, hidden from assistive tech, between the story and the sheet', () => {
  const { DeepLinkBackdrop } = lib();
  const html = renderToHtml(createElement(DeepLinkBackdrop));
  assert.match(html, /^<div aria-hidden="true" data-deep-link-backdrop=""/);
  assert.match(html, /fixed inset-0 z-\[45\]/, 'under the sheet (z-50), over the story');
  assert.match(html, /blur-md/);
});

test('the router hands a signed-out deep link to the landing\'s sheet, remembered for after', () => {
  const app = read('public/js/app.js');
  assert.match(app, /AuthScreens\.showSignInFor\(App\._deepLinkTarget\(\)\);/);
  assert.doesNotMatch(app, /AuthScreens\.rememberDeepLink\(App\._deepLinkTarget\(\)\);\s*\n\s*AuthScreens\.show\('login'\);/);
  const screens = read('public/js/auth-screens.js');
  assert.match(screens, /showSignInFor\(fullHash\) \{\s*AuthScreens\.rememberDeepLink\(fullHash\);\s*AuthScreens\._deepLinkSignIn = AuthScreens\._pendingHash \|\| '';\s*AuthScreens\.show\('landing'\);/);
  // finishLogin restores the same remembered link, so the sheet's sign-in lands on it.
  assert.ok(screens.includes("const target = AuthScreens._pendingHash || '';"));
});

test('the landing opens the sheet as it shows, titled for the link, and Close leaves the story', () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /const target = typeof host\?\._deepLinkSignIn === 'string' \? host\._deepLinkSignIn : '';\s*if \(host\) host\._deepLinkSignIn = '';\s*flushSync\(/,
    'read once, in the on-show hook, committed before the screen is revealed');
  assert.match(landing, /\{gate \? <DeepLinkBackdrop \/> : null\}/);
  assert.match(landing, /title=\{deepLinkTitle\(gate\.place, gateProject,/);
  assert.match(landing, /returnTo=\{deepLinkReturnTo\(gate\.target\)\}/);
  assert.match(landing, /onClose=\{closeGate\}/);
  assert.match(landing, /open=\{!gate && !intent && \(sheet === 'start' \|\| sheet === 'signin'\)\}/,
    'the story\'s own sheet stays down under it, and under a project page\'s own sheet');
  assert.match(landing, /const linkedApp = linkedSlug && apps \? apps\.find\(\(a\) => a\.slug === linkedSlug\) \?\? null : null;/,
    'a public project\'s name, from the directory the screen loads anyway');
});

// THE GUEST PAGES TAKE THE LINKS A VISITOR CAN READ (features/guest): a link
// to Discover opens the guest Discover, and a link to a PUBLIC project opens
// its read-only page, with no sheet. The sheet stays for everything else, and
// a project link waits for the directory before either shows.
test('Discover and public project links open the guest pages; the rest keep the sheet', () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /const guestOn = storyOn;/, 'the guest pages ride the story\'s switch');
  assert.match(landing, /const guestProject = guestOn \? linkedApp : null;/);
  assert.match(landing, /const linkPending = guestOn && !!linkedSlug && apps === null && !appsFailed;/);
  assert.match(landing, /const discoverLink = deepPlace\?\.kind === 'screen' && deepPlace\.screen === 'discover';/);
  assert.match(landing, /const gate = deepLink && !\(guestOn && discoverLink\) && !guestProject && !linkPending \? deepLink : null;/);
  assert.match(landing, /setDeepLink\(target \? \{ target, place: deepLinkPlace\(target\) \} : null\);/,
    'the on-show hook keeps the link as it came; what is left for the sheet is derived');
});
