// Tests for the platform-level user language preference (issue #757).
//
// Three layers:
//   1. Behavioural: POST /api/me/locale mounted with a stubbed pool —
//      valid tags persist, casing is normalized (pt-br → pt-BR), null/""
//      clears, malformed/oversized input is a 400, unauthenticated is a
//      401 — and /api/auth/me round-trips the value from req.user.
//   2. Source guards on the iframe-token mint (server.js): the SELECT
//      includes the locale column and the signed payload gains a
//      `locale` claim ADDITIVELY — existing claims, secret and expiry
//      pinned unchanged.
//   3. Source guards across the rest of the chain: schema column, auth
//      middleware SELECT/mapping, Settings markup + wiring, and the
//      shell's __usernode_locale handling (the bridge side is pinned in
//      tests/usernode-bridge.test.js).
//
// Run with: node --test tests/user-locale.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Stub the pool BEFORE requiring the routes: record UPDATE calls, return
// empty rows for the incidental /api/auth/me lookups (BYOK key, app count).
const poolMod = require('../src/db/pool');
let calls = [];
poolMod.getPool = () => ({
  async query(sql, params) {
    calls.push({ sql, params });
    return { rows: [] };
  },
});

const { authRoutes } = require('../src/routes/auth');
const { shellMarkup } = require('./lib/shell-markup');
const { message } = require('./lib/platform-i18n');

let server, base;
let user = null;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(authRoutes({ jwtSecret: 'test-secret' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test.beforeEach(() => {
  calls = [];
  user = { id: 42, username: 'tester', isAdmin: false, appQuota: 0, locale: null };
});

const post = (body) => fetch(`${base}/api/me/locale`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const localeUpdate = () => calls.find((c) => /UPDATE users SET locale/.test(c.sql));

// ── 1. POST /api/me/locale behaviour ────────────────────────────────────

test('401 when not authenticated', async () => {
  user = null;
  const r = await post({ locale: 'id' });
  assert.equal(r.status, 401);
});

test('accepts a plain language tag and persists it', async () => {
  const r = await post({ locale: 'id' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j, { ok: true, locale: 'id' });
  const upd = localeUpdate();
  assert.ok(upd, 'must run the UPDATE');
  assert.deepEqual(upd.params, ['id', 42]);
});

test('normalizes casing: language lowercase, 2-letter region uppercase', async () => {
  for (const [input, expected] of [
    ['pt-br', 'pt-BR'],
    ['EN', 'en'],
    ['ZH-cn', 'zh-CN'],
    ['de-DE', 'de-DE'],
  ]) {
    calls = [];
    const r = await post({ locale: input });
    assert.equal(r.status, 200, `expected 200 for ${input}`);
    const j = await r.json();
    assert.equal(j.locale, expected, `${input} should normalize to ${expected}`);
    assert.equal(localeUpdate().params[0], expected);
  }
});

test('longer subtags (script, variants) pass through un-cased', async () => {
  const r = await post({ locale: 'zh-Hant-TW' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.locale, 'zh-Hant-TW');
});

test('null, empty string, and whitespace clear the preference', async () => {
  for (const cleared of [null, '', '   ']) {
    calls = [];
    const r = await post({ locale: cleared });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j, { ok: true, locale: null });
    assert.deepEqual(localeUpdate().params, [null, 42]);
  }
});

test('missing body clears too (locale undefined)', async () => {
  const r = await post({});
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.locale, null);
});

test('rejects malformed and oversized tags with 400, no UPDATE', async () => {
  for (const bad of [
    'not a locale!',
    'x',              // 1-char language subtag
    'en_US',          // underscore, not hyphen
    '-en',
    'en-',
    'a'.repeat(36),   // over the 35-char cap
    'en-' + 'a'.repeat(9), // 9-char subtag
    123,
    { lang: 'en' },
    true,
  ]) {
    calls = [];
    const r = await post({ locale: bad });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(localeUpdate(), undefined, 'must not touch the DB on invalid input');
  }
});

test('/api/auth/me round-trips the locale from req.user', async () => {
  user.locale = 'pt-BR';
  const r = await fetch(`${base}/api/auth/me`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.user.locale, 'pt-BR');
});

test('/api/auth/me reports null when unset', async () => {
  const r = await fetch(`${base}/api/auth/me`);
  const j = await r.json();
  assert.equal(j.user.locale, null);
});

// ── 2. Iframe-token mint source guards (server.js — guarded code) ───────

test('iframe-token mint selects the locale column alongside the pubkey', () => {
  const src = read('server.js');
  assert.match(src, /SELECT usernode_pubkey, locale, username_provisional_since IS NOT NULL AS provisional\s+FROM users WHERE id = \$1/);
});

test('iframe-token payload gains the locale claim additively', () => {
  const src = read('server.js');
  const mintStart = src.indexOf("app.get('/api/iframe-token'");
  assert.ok(mintStart !== -1, 'mint route must exist');
  const signAt = src.indexOf('signAppIdentityToken', mintStart);
  assert.notStrictEqual(signAt, -1, 'mint must delegate to platform-jwt');
  const mint = src.slice(mintStart, src.indexOf('});', signAt) + 3);
  // New claim present…
  assert.match(mint, /locale: userLocale/);
  // …and every pre-existing claim unchanged across the RSA cutover.
  assert.match(mint, /id: req\.user\.id/);
  assert.match(mint, /username: req\.user\.username/);
  assert.match(mint, /usernode_pubkey: usernodePubkey/);
  // The signing key and the TTL moved into services/platform-jwt.js when
  // the shared config.jwtSecret was retired; the route now names the app
  // it is minting for instead, which is what scopes the audience.
  assert.match(mint, /appId: appRow\.id/);
  assert.ok(!/config\.jwtSecret/.test(src),
    'the retired shared secret must have no reader left in server.js');
  const pj = read('src/services/platform-jwt.js');
  assert.match(pj, /IFRAME_TTL = '1h'/, 'the 1h iframe TTL is preserved');
});

// ── 3. Chain source guards ──────────────────────────────────────────────

test('schema adds the nullable locale column', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS locale VARCHAR\(35\)/);
});

test('auth middleware selects the column and maps req.user.locale', () => {
  const mw = read('src/middleware/auth.js');
  // Both user-row lookups (cookie-session join + staging by-id) carry it.
  assert.match(mw, /u\.locale/, 'session SELECT must include the column');
  // has_platform_access rides the same by-id lookup since the onboarding
  // flow alignment (platform-access gate).
  // The columns between ai_progress_estimate and locale are not this test's
  // business — #1281 added session_bridge_enabled there. What matters is
  // that locale is still selected by the by-id lookup and still arrives
  // beside has_platform_access, so the pattern spans whatever sits between.
  assert.match(mw, /ai_progress_estimate,[\w\s,]*locale, has_platform_access FROM users WHERE id = \$1/);
  assert.match(mw, /locale: rows\[0\]\.locale \|\| null/);
  assert.match(mw, /locale: userRow\.locale \|\| null/);
});

test('/api/auth/me payload exposes locale', () => {
  const src = read('src/routes/auth.js');
  assert.match(src, /locale: req\.user\.locale \?\? null/);
});

test('Settings markup has the Language section', () => {
  const html = shellMarkup();
  assert.match(html, /id="settings-locale"/);
  assert.match(html, /id="settings-locale-status"/);
  assert.match(html, /Auto: use device language/);
});

test('the picker saves through the language runtime, which POSTs /api/me/locale and pushes it live', () => {
  const js = read('frontend/src/features/settings/settings.js');
  assert.match(js, /_renderLanguageSection/);
  const start = js.indexOf('    async _saveLocale(value) {');
  assert.ok(start > -1, '_saveLocale exists');
  const fn = js.slice(start, start + 1800);
  assert.match(fn, /i18n\.changeLanguage\(value \|\| null, async \(next\) => \{/,
    'load, save, then switch: the runtime orders it');
  assert.match(fn, /await i18n\.saveAccountLocale\(next\)/);
  // One save path for Settings and the automatic-language banner.
  const account = read('frontend/src/lib/i18n/account.ts');
  assert.match(account, /fetch\('\/api\/me\/locale'/);
  assert.match(account, /App\.user\.locale = saved/,
    "the shell's cached user answers the bridge's getUserLocale without a re-fetch");
  assert.match(account, /notifyLocaleChanged\?\.\(saved\)/, 'open app iframes hear usernode:locale-changed');
  assert.match(account, /settings\.state\.locale = saved/);
});

test('the Settings picker is offered to everyone, with Auto and the shipped languages', () => {
  // #1556 hid the section from anyone without a saved locale, while the row
  // could not say what it did. It is listed for everyone again; every read
  // path above this line is untouched.
  const js = read('frontend/src/features/settings/settings.js');
  assert.match(js, /\{ key: 'language', label: 'settings:nav\.part\.language', group: 'settings:nav\.group\.preferences' \}/,
    'no capability gate on the registry entry');
  assert.equal(message('settings:nav.part.language'), 'Language');
  assert.equal(message('settings:nav.group.preferences'), 'Preferences');
  const html = shellMarkup();
  assert.match(html, /id="settings-language-section">/, 'the pane ships without an inner hidden');
  const select = html.slice(html.indexOf('id="settings-locale"'));
  const options = [...select.slice(0, select.indexOf('</select>')).matchAll(/<option value="([^"]*)"/g)]
    .map((match) => match[1]);
  // A configured language ships once its translations are filled
  // (scripts/language-packs.js): the build hands the shell only those.
  const packs = require('../scripts/language-packs');
  const { config, report } = packs.collectCatalogs(path.join(__dirname, '..'));
  const shipped = Object.keys(packs.shippedLanguages(config, report));
  assert.deepEqual(options, ['', ...shipped], 'Auto, then exactly the languages Homeroom ships');
  assert.match(read('frontend/src/features/settings/sections/language.tsx'),
    /shippedLanguages\.map\(\(\{ tag, name \}\) => \(/, 'the options are the config, not a second list');
  assert.equal(shipped[0], 'en', 'English always ships, and comes first');
  // #6511: the cache translates Homeroom's own screens, so the intro may not
  // say they are English only; it says why a language may be missing instead.
  const intro = message('settings:language.intro');
  assert.doesNotMatch(intro, /English/, 'the intro does not claim the screens are English only');
  assert.match(intro, /listed once enough of Homeroom has been translated/);
  // A locale saved when the picker listed more stays visible and changeable.
  const start = js.indexOf('    _renderLanguageSection() {');
  const fn = js.slice(start, start + 900);
  assert.doesNotMatch(fn, /settings-language-section/, 'nothing hides the section any more');
  assert.match(fn, /opt\.textContent = window\.PlatformI18n\?\.languageName\?\.\(value\) \|\| value/,
    'a kept choice is listed under its own name');
});

test('shell answers the __usernode_locale family and pushes changes', () => {
  const shell = read('public/js/app-view.js');
  assert.match(shell, /handleLocaleBridgeMessage/);
  assert.match(shell, /__usernode_locale/);
  assert.match(shell, /notifyLocaleChanged/);
  // Source gate: only the shell-owned iframes are answered.
  const fnStart = shell.indexOf('handleLocaleBridgeMessage(e)');
  const fn = shell.slice(fnStart, fnStart + 1500);
  assert.match(fn, /app-iframe/);
  assert.match(fn, /staging-iframe/);
});
