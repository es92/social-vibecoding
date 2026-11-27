'use strict';
// 5 October 2026, iOS Safari, a test account signing out: Settings' button
// said "Log out" while every way in says "Sign in", and searching Settings
// for "Sign out" said "No settings match". The button says Sign out now
// (and the waiting room's with it), its id and the declared checks' selectors
// are like-for-like, and the filter finds it by either name.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const NAV = 'frontend/src/features/settings/settings-nav.tsx';

test('Settings and the waiting room say Sign out, on the same buttons', () => {
  const settings = read('frontend/src/features/settings/index.tsx');
  assert.match(settings, /id="settings-logout"[\s\S]{0,400}?>\s*\{t\('settings:screen\.signOut'\)\}\s*<\/button>/);
  assert.equal(message('settings:screen.signOut'), 'Sign out');
  const waiting = read('frontend/src/features/auth/waiting.tsx');
  assert.match(waiting, /id="waiting-logout"[\s\S]{0,300}?>\s*\{t\('auth:waiting\.signOut'\)\}\s*<\/button>/);
  assert.equal(message('auth:waiting.signOut'), 'Sign out');
  for (const [name, src] of [['settings', settings], ['waiting', waiting]]) {
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, ''), />\s*Log out\s*</, `${name}: no "Log out" left on a button`);
  }
  // What it says when it fails was already "sign out".
  assert.match(read('frontend/src/features/settings/settings.js'), /tr\('settings:signOut\.failed'\)/);
  assert.equal(message('settings:signOut.failed'), 'Could not sign out. Check your connection and try again.');
});

// #3915, iOS: the tap disabled the button and changed nothing you could see,
// so a phone that took a while to shut down looked frozen. It now dims and
// says Signing out… while it runs (tests/native-logout-order.test.js runs
// that), and a failure hands back the markup's own words.
test('a running sign-out looks like one, and a failed one says Sign out again', () => {
  const markup = read('frontend/src/features/settings/index.tsx');
  const at = markup.indexOf('id="settings-logout"');
  const button = markup.slice(at, markup.indexOf('</button>', at));
  assert.match(button, /\bdisabled:opacity-60\b/);
  assert.match(button, />\s*\{t\('settings:screen\.signOut'\)\}\s*$/);
  assert.equal(message('settings:screen.signOut'), 'Sign out');
  const js = read('frontend/src/features/settings/settings.js');
  // The same message id as the markup, so the same words in every language.
  assert.match(js, /const SIGN_OUT_LABEL = 'settings:screen\.signOut';/, 'the same words as the markup');
  assert.match(js, /const SIGNING_OUT_LABEL = 'settings:signOut\.signingOut';/);
  assert.equal(message('settings:signOut.signingOut'), 'Signing out…');
  assert.match(js, /btn\.textContent = tr\(SIGNING_OUT_LABEL\);/);
  assert.match(js, /btn\.textContent = tr\(SIGN_OUT_LABEL\);/);
});

test('the declared check that reads the button\'s words reads Sign out; the selectors are unchanged', () => {
  const manifest = JSON.parse(read('dapp.json'));
  const checks = manifest.tests.filter((t) => /#settings-logout/.test(t.expectSelector || ''));
  // Three until #5281 moved the Admin row's check (which reached the button
  // through its sibling chain) to Me.
  assert.ok(checks.length >= 2);
  const worded = checks.filter((t) => t.expectText);
  assert.deepEqual(worded.map((t) => t.expectText), ['Sign out']);
  assert.equal(worded[0].name, 'Settings\' Sign out is a danger-tinted pill under the sections');
  assert.equal(worded[0].expectSelector, '#settings-footer #settings-logout.rounded-full');
  for (const t of manifest.tests) assert.notEqual(t.expectText, 'Log out');
});

test('matchesSignOut: either name, any order of typing, three letters at least', () => {
  const { matchesSignOut, SIGN_OUT_WORDS } = loadTsx(NAV);
  assert.ok(SIGN_OUT_WORDS.includes('logout') && SIGN_OUT_WORDS.includes('signout'));
  for (const q of ['Sign out', 'sign', 'SIGN OUT', 'log out', 'Logout', 'log', 'sign off', 'signout', 'out', '  sign   out ']) {
    assert.equal(matchesSignOut(q), true, q);
  }
  for (const q of ['', 's', 'si', 'password', 'sign in', 'theme', 'outside', 'logs']) {
    assert.equal(matchesSignOut(q), false, q);
  }
});

// The phone's menu, run with the query a viewer typed (the field's state)
// and the descriptor settings.js publishes.
function menuWith(query) {
  const real = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  const descriptor = {
    desktop: [{ name: 'Account', first: true, items: [{ key: 'account', label: 'Account', active: true, className: 'x', terms: 'account', parts: [{ key: 'password', label: 'Password', terms: 'password sign in login security' }] }] }],
    mobile: [{ name: 'Account', items: [{ key: 'account', label: 'Account', terms: 'account', parts: [{ key: 'password', label: 'Password', terms: 'password sign in login security' }] }] }],
    visit: 1,
  };
  const React = {
    ...real,
    useState: () => [query, () => {}],
    useEffect() {},
    useSyncExternalStore: (subscribe, get) => get(),
  };
  const nav = loadTsx(NAV, {
    stubs: {
      react: React,
      './settings-nav-store.js': { settingsNavStore: { get: () => descriptor, subscribe: () => () => {} } },
      // Called outside React's renderer: the English text, not the hook.
      '../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t },
    },
  });
  return { mobile: nav.SettingsMobileMenu(), desktop: nav.SettingsNavDesktop() };
}

// The "No settings match" line (the NoMatch component, drawn as its element).
const noMatch = (n) => typeof n.type === 'function' && n.type.name === 'NoMatch';

function find(node, test, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, test, out)); return out; }
  if (node.props && test(node)) out.push(node);
  if (node.props) find(node.props.children, test, out);
  return out;
}

test('searching Settings for Sign out (or Log out) finds it, and choosing it presses the one button', () => {
  for (const query of ['Sign out', 'log out']) {
    const { mobile, desktop } = menuWith(query);
    const row = find(mobile, (n) => n.props['data-settings-sign-out'] !== undefined)[0];
    assert.ok(row, `${query}: a Sign out row on the phone`);
    assert.equal(row.props.title, 'Sign out');
    assert.equal(row.props.chevron, false, 'an action, not a page');
    assert.equal(find(mobile, noMatch).length, 0, 'not "No settings match"');
    const hit = find(desktop, (n) => n.props['data-settings-sign-out'] !== undefined)[0];
    assert.ok(hit, `${query}: and in the sidebar`);
    // The sidebar's hit is the shared row too: its title is in the red.
    assert.equal(hit.props.title, 'Sign out');
    assert.match(hit.props.titleClassName, /text-red-700/, 'in the button\'s own red');
  }
  // "sign" also finds Password (sign in), first; Sign out comes after the pages.
  const { mobile } = menuWith('sign');
  const rows = find(mobile, (n) => n.props['data-settings-nav'] !== undefined || n.props['data-settings-sign-out'] !== undefined);
  assert.deepEqual(rows.map((n) => n.props['data-settings-nav'] || 'sign-out'), ['account', 'sign-out']);
  // Nothing else that matches still says so.
  const none = menuWith('zebra').mobile;
  assert.equal(find(none, noMatch).length, 1);
  assert.equal(find(none, (n) => n.props['data-settings-sign-out'] !== undefined).length, 0);

  // Choosing it presses #settings-logout, whose handler settings.js binds:
  // no second way of signing out.
  const src = read(NAV);
  assert.match(src, /function signOut\(setQuery: \(q: string\) => void\) \{\s*setQuery\(''\);\s*\(document\.getElementById\('settings-logout'\) as HTMLButtonElement \| null\)\?\.click\(\);\s*\}/);
  assert.match(src, /\} else if \(e\.key === 'Enter' && signOutHit\) \{\s*\/\/[^\n]*\n\s*e\.preventDefault\(\);\s*signOut\(setQuery\);/,
    'Enter presses it when it is the only hit; a page still comes first');
  assert.match(src, /if \(e\.key === 'Enter' && hits\[0\]\)/);
});

test('the prerendered hosts are unchanged: empty until settings.js publishes', () => {
  const html = renderComponent(NAV, 'SettingsMobileMenu', {});
  assert.equal(html, '<div id="settings-mobile-menu-host" class="lg:hidden"></div>');
});
