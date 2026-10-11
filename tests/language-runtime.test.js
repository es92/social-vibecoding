'use strict';

// The language runtime (frontend/src/lib/i18n) against a fixture language,
// since English is the only one Homeroom ships: on-demand verified packs,
// English for any message a pack lacks, the load → save → activate order, and
// the once-per-device notice when the language was picked automatically.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { englishPlatformI18n } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const {
  SPANISH, browser, catalogFixture, from, runtimeFor, says, until,
} = require('./lib/language-fixture');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const DEVICE_KEY = 'homeroom:language:device';
const NOTICE_KEY = 'homeroom:language:auto-notice';

function setup(t, options = {}) {
  const fixture = catalogFixture(t);
  const { catalogs } = fixture.build();
  const page = browser(t, { root: fixture.root, ...options });
  return { catalogs, page, runtime: runtimeFor(catalogs) };
}

test('the runtime is built from whatever catalogs it is handed', () => {
  // ./lib/language-fixture.js builds every runtime below from this module.
  const { createLanguageRuntime } = loadTsx('frontend/src/lib/i18n/core.ts');
  const empty = createLanguageRuntime({ languages: { en: 'English' }, namespaces: ['core'], english: { core: { hi: 'Hi' } }, manifest: {} });
  assert.equal(empty.t('hi'), 'Hi');
  assert.equal(empty.t('core:missing'), 'missing', 'an id no catalog has is shown as itself, never as nothing');
});

test('English is bundled: it needs no request, and shows no notice', async (t) => {
  const { runtime, page } = setup(t, { deviceLanguages: ['en-GB', 'es'] });
  await runtime.applySessionLanguage(null);
  assert.equal(runtime.getLanguage(), 'en');
  assert.equal(runtime.t('hello', { name: 'Ana' }), 'Hello Ana');
  assert.equal(page.requests.length, 0);
  assert.equal(runtime.getNotice(), null);
});

test('a language downloads its pack once, and no other language is fetched', async (t) => {
  const { runtime, page } = setup(t);
  assert.equal(await runtime.changeLanguage('es'), true);
  assert.equal(runtime.getLanguage(), 'es');
  assert.equal(runtime.t('hello', { name: 'Ana' }), 'Hola Ana');
  assert.equal(runtime.t('items', { count: 1 }), '1 elemento');
  assert.equal(runtime.t('items', { count: 3 }), '3 elementos');
  assert.equal(page.requests.length, 1);
  assert.match(page.requests[0], /^\/locales\/es\.core\.[a-f0-9]{64}\.json$/);
  assert.equal(globalThis.document.documentElement.lang, 'es');
  assert.deepEqual(page.events.map((event) => [event.type, event.detail.language]), [['homeroom:language-changed', 'es']]);
  await runtime.changeLanguage('en');
  await runtime.changeLanguage('es-MX');
  assert.equal(page.requests.length, 1, 'switching back reuses the pack already loaded');
});

test('a message the pack lacks renders in English, one message at a time', async (t) => {
  const { runtime } = setup(t);
  await runtime.changeLanguage('es');
  assert.equal(runtime.t('hello', { name: 'Ana' }), 'Hola Ana');
  assert.equal(runtime.t('onlyEnglish'), 'Not translated yet', 'missing');
  assert.equal(runtime.t('bye'), 'Goodbye', 'translated from wording English no longer uses');
  assert.equal(runtime.htmlText('hello', { name: '<b>Ana</b>' }), 'Hola &lt;b&gt;Ana&lt;/b&gt;');
});

test('a pack whose bytes do not match the build is refused', async (t) => {
  const { runtime, page } = setup(t, { deviceLanguages: ['es-ES'] });
  page.tamper = (bytes) => Buffer.from(bytes.toString('utf8').replace('Hola', 'Hacked'));
  await assert.rejects(runtime.changeLanguage('es'), /does not match this build/);
  assert.equal(runtime.getLanguage(), 'en');
  assert.equal(runtime.t('hello', { name: 'Ana' }), 'Hello Ana');
  // At boot the same failure leaves English on screen rather than nothing.
  await runtime.applySessionLanguage(null);
  assert.equal(runtime.getLanguage(), 'en');
  assert.equal(runtime.getNotice(), null);
  // The failure is not remembered as a finished load.
  page.tamper = null;
  assert.equal(await runtime.changeLanguage('es'), true);
  assert.equal(runtime.t('hello', { name: 'Ana' }), 'Hola Ana');
});

test('the first paint is held while a remembered language loads, and released once it shows', async (t) => {
  // The head's inline hold (frontend/src/head.html) runs before anything
  // paints: it reads the language this device last showed and, unless that
  // was English, hides the body until the runtime has put the language on
  // screen. It always lets go by itself after three seconds.
  const head = read('frontend/src/head.html');
  assert.match(head, /html\.language-pending body \{ visibility: hidden; \}/);
  const hold = head.slice(head.indexOf("localStorage.getItem('homeroom:language:shown')") - 400);
  assert.match(hold, /if \(!shown \|\| shown === 'en'\) return;/, 'English, or nothing remembered, is never held');
  assert.match(hold, /root\.classList\.add\('language-pending'\);\s*setTimeout\(function \(\) \{ root\.classList\.remove\('language-pending'\); \}, 3000\);/);
  assert.ok(head.indexOf("'homeroom:language:shown'") > head.indexOf('window.Theme'), 'after the theme, which paints the ground');

  const { runtime, page } = setup(t);
  const classes = new Set(['language-pending']);
  globalThis.document.documentElement.classList = { remove: (name) => { classes.delete(name); } };
  page.hold = async () => { assert.ok(classes.has('language-pending'), 'still held while the pack loads'); };
  await runtime.changeLanguage('es');
  assert.equal(classes.has('language-pending'), false, 'released once Spanish is on screen');
  assert.equal(page.storage.get('homeroom:language:shown'), 'es', 'the next load holds for Spanish');
  classes.add('language-pending');
  await runtime.changeLanguage('en');
  assert.equal(classes.has('language-pending'), false);
  assert.equal(page.storage.get('homeroom:language:shown'), 'en', 'and the one after holds nothing');
});

test('a change loads, then saves, then switches; a failed save leaves the screen as it was', async (t) => {
  const { runtime, page } = setup(t);
  const order = [];
  const applied = await runtime.changeLanguage('es', async (value) => {
    order.push(`save ${value} after ${page.requests.length} request(s), showing ${runtime.getLanguage()}`);
  });
  assert.equal(applied, true);
  assert.deepEqual(order, ['save es after 1 request(s), showing en']);
  assert.equal(runtime.getLanguage(), 'es');
  assert.equal(runtime.getPreference(), 'es');

  await assert.rejects(runtime.changeLanguage('en', async () => { throw new Error('Failed to save.'); }), /Failed to save\./);
  assert.equal(runtime.getLanguage(), 'es', 'the language did not change');
  assert.equal(runtime.getPreference(), 'es');

  // Two quick choices: the older one saves nothing and reports that it lost.
  const saved = [];
  const slow = runtime.changeLanguage('en', async (value) => { saved.push(value); });
  const fast = runtime.changeLanguage(null, async (value) => { saved.push(value); });
  assert.deepEqual(await Promise.all([slow, fast]), [false, true]);
  assert.deepEqual(saved, [null]);
});

test('a legacy screen is told when the text for the language showing arrives', async (t) => {
  // A legacy module repaints on `homeroom:language-changed`. Its first read of
  // a namespace nobody had opened is English and starts the download; without
  // word of the arrival it would stay "Save" after "Guardar" had loaded.
  const fixture = catalogFixture(t);
  fixture.put('en/settings.json', { save: says('Save') });
  fixture.put('es/settings.json', { save: from('Save', 'Guardar') });
  const { catalogs } = fixture.build();
  const page = browser(t, { root: fixture.root });
  const runtime = runtimeFor(catalogs);
  await runtime.changeLanguage('es');
  assert.deepEqual(page.events.map((event) => [event.type, event.detail.language, event.detail.namespace]),
    [['homeroom:language-changed', 'es', undefined]], 'the switch itself, once');
  page.events.length = 0;

  assert.equal(runtime.t('settings:save'), 'Save');
  await until(() => page.events.length > 0, 'the settings pack');
  assert.deepEqual(page.events.map((event) => [event.type, event.detail.language, event.detail.namespace]),
    [['homeroom:language-changed', 'es', 'settings']]);
  assert.equal(runtime.t('settings:save'), 'Guardar');

  // Packs loaded ahead of a switch are announced by the switch, not one by one.
  const fresh = runtimeFor(catalogs);
  assert.equal(fresh.t('settings:save'), 'Save');
  page.events.length = 0;
  await fresh.changeLanguage('es');
  assert.equal(page.events.length, 1);
  assert.equal(fresh.t('settings:save'), 'Guardar');
});

test('the screen follows the last choice that was saved when a newer one fails to load', async (t) => {
  const fixture = catalogFixture(t, {
    languages: { en: 'English', es: 'Español', fr: 'Français' },
    translations: { es: SPANISH, fr: { bye: from('Goodbye', 'Au revoir') } },
  });
  const { catalogs } = fixture.build();
  const page = browser(t, { root: fixture.root });
  page.unavailable = (url) => url.startsWith('/locales/fr.');
  const runtime = runtimeFor(catalogs);
  await runtime.applySessionLanguage({ id: 7, locale: null });
  const saved = [];
  let finishSave = null;
  const spanish = runtime.changeLanguage('es', (value) => new Promise((resolve) => {
    finishSave = () => { saved.push(value); resolve(); };
  }));
  await until(() => finishSave, 'the Spanish save to begin');
  // French is chosen while Spanish is still being saved, and cannot load.
  await assert.rejects(runtime.changeLanguage('fr', async (value) => { saved.push(value); }), /Language pack unavailable/);
  assert.equal(runtime.getLanguage(), 'en', 'nothing is saved yet, so nothing has changed');
  finishSave();
  assert.equal(await spanish, true, 'Spanish is what was saved, and it is what shows');
  assert.deepEqual(saved, ['es']);
  assert.equal(runtime.getLanguage(), 'es');
  assert.equal(runtime.getPreference(), 'es');
  assert.equal(runtime.t('hello', { name: 'Ana' }), 'Hola Ana');
});

test('the screen follows the last choice that was saved when a newer save fails', async (t) => {
  // The same with the two choices Settings offers today.
  const { runtime } = setup(t, { deviceLanguages: ['en-US'] });
  await runtime.applySessionLanguage({ id: 7, locale: 'es' });
  assert.equal(runtime.getLanguage(), 'es');
  let finishSave = null;
  const english = runtime.changeLanguage('en', () => new Promise((resolve) => { finishSave = resolve; }));
  await until(() => finishSave, 'the English save to begin');
  const auto = runtime.changeLanguage(null, async () => { throw new Error('Failed to save.'); });
  finishSave();
  assert.equal(await english, false, 'a newer choice was on its way when English was saved');
  await assert.rejects(auto, /Failed to save\./);
  assert.equal(runtime.getPreference(), 'en', 'the account holds English, and so does the runtime');
  assert.equal(runtime.getLanguage(), 'en');
});

test('the newest saved choice shows at once, and an older attempt that then fails is not reported', async (t) => {
  const { runtime, page } = setup(t, { deviceLanguages: ['en-US'] });
  await runtime.applySessionLanguage({ id: 7, locale: null });
  let releasePack = null;
  page.hold = () => new Promise((resolve) => { releasePack = resolve; });
  const saved = [];
  const save = async (value) => { saved.push(value); };
  const spanish = runtime.changeLanguage('es', save);
  await until(() => releasePack, 'the Spanish pack request');
  // English is chosen while the Spanish pack is still on its way.
  assert.equal(await runtime.changeLanguage('en', save), true, 'it does not wait on the Spanish pack');
  assert.deepEqual(saved, ['en']);
  assert.equal(runtime.getPreference(), 'en');
  // The Spanish pack then fails. Spanish had been given up: no error, nothing saved.
  page.unavailable = () => true;
  releasePack();
  assert.equal(await spanish, false);
  assert.deepEqual(saved, ['en']);
  assert.deepEqual([runtime.getLanguage(), runtime.getPreference()], ['en', 'en']);
});

// The real shipped handler: settings.js is a classic script with no imports
// that publishes window.Settings, and account.ts is the save it calls.
function settingsPage(t, runtime, page) {
  const classes = new Set(['hidden']);
  const status = {
    textContent: '',
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
  };
  const select = {
    value: '',
    options: [{ value: '' }, { value: 'en' }, { value: 'es' }],
    appendChild(option) { this.options.push(option); },
  };
  const elements = { 'settings-locale': select, 'settings-locale-status': status };
  const noop = () => {};
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, URL, URLSearchParams, Date, Math, Object, Array,
    String, Number, Boolean, RegExp, Error,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.location = { search: '', hash: '', origin: 'http://x', href: 'http://x/' };
  sandbox.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
  sandbox.document = {
    getElementById: (id) => elements[id] || null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop, createElement: () => ({}), readyState: 'complete',
  };
  sandbox.navigator = { userAgent: 'node', onLine: true };
  sandbox.fetch = () => Promise.resolve({ ok: false });
  vm.createContext(sandbox);
  vm.runInContext(read('frontend/src/features/settings/settings.js'), sandbox, { filename: 'settings.js' });

  const { saveAccountLocale } = loadTsx('frontend/src/lib/i18n/account.ts');
  sandbox.PlatformI18n = {
    // The status line's own words come from the real English catalog; the
    // fixture runtime decides which language is chosen and saved.
    ...englishPlatformI18n(),
    changeLanguage: runtime.changeLanguage, languageName: runtime.languageName, saveAccountLocale,
  };
  const posted = [];
  page.api = async (url, init) => {
    assert.equal(url, '/api/me/locale');
    const { locale } = JSON.parse(init.body);
    posted.push(locale);
    return new Response(JSON.stringify({ ok: true, locale }), { headers: { 'Content-Type': 'application/json' } });
  };
  // account.ts keeps window.Settings in step, in the realm it runs in.
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { Settings: sandbox.Settings } });
  t.after(() => {
    if (had) Object.defineProperty(globalThis, 'window', had); else delete globalThis.window;
  });
  return { Settings: sandbox.Settings, select, status, classes, posted };
}

test('Settings reports the newest choice, whatever an older pack request does afterwards', async (t) => {
  const { runtime, page } = setup(t, { deviceLanguages: ['en-US'] });
  await runtime.applySessionLanguage({ id: 7, locale: null });
  const ui = settingsPage(t, runtime, page);
  let releasePack = null;
  page.hold = () => new Promise((resolve) => { releasePack = resolve; });

  // Spanish is chosen, and its pack is still on its way when English is.
  ui.select.value = 'es';
  const spanish = ui.Settings._saveLocale('es');
  await until(() => releasePack, 'the Spanish pack request');
  ui.select.value = 'en';
  await ui.Settings._saveLocale('en');
  const englishIsSaved = (when) => {
    assert.equal(ui.status.textContent, '✓ Saved', when);
    assert.equal(ui.classes.has('hidden'), false, when);
    assert.equal(ui.classes.has('text-red-700'), false, when);
    assert.equal(ui.select.value, 'en', when);
    assert.deepEqual(ui.posted, ['en'], when);
    assert.equal(ui.Settings.state.locale, 'en', when);
    assert.deepEqual([runtime.getLanguage(), runtime.getPreference()], ['en', 'en'], when);
  };
  englishIsSaved('as soon as English is saved');

  // The Spanish request fails afterwards. It was given up already: Settings
  // must not turn the saved choice into "Could not load that language."
  page.unavailable = () => true;
  releasePack();
  await spanish;
  englishIsSaved('after the older request failed');
});

test('Settings ends on what the account holds when the newest choice cannot load', async (t) => {
  const { runtime, page } = setup(t, { deviceLanguages: ['en-US'] });
  await runtime.applySessionLanguage({ id: 7, locale: null });
  const ui = settingsPage(t, runtime, page);
  // English is being saved when Spanish, whose pack cannot load, is chosen.
  let finishSave = null;
  const answer = page.api;
  page.api = async (url, init) => {
    await new Promise((resolve) => { finishSave = resolve; });
    return answer(url, init);
  };
  page.unavailable = () => true;
  ui.select.value = 'en';
  const english = ui.Settings._saveLocale('en');
  await until(() => finishSave, 'the English save to begin');
  ui.select.value = 'es';
  await ui.Settings._saveLocale('es');
  assert.equal(ui.status.textContent, 'Could not load that language. Try again.');
  finishSave();
  await english;
  assert.equal(ui.status.textContent, '✓ Saved', 'English is saved, and that is the last word');
  assert.equal(ui.select.value, 'en');
  assert.deepEqual(ui.posted, ['en']);
  assert.deepEqual([runtime.getLanguage(), runtime.getPreference()], ['en', 'en']);
});

test('a choice still being saved follows its own account, not the next session', async (t) => {
  const { runtime, page } = setup(t, { deviceLanguages: ['en-US'] });
  await runtime.applySessionLanguage({ id: 7, locale: null });
  let finishSave = null;
  const slow = () => new Promise((resolve) => { finishSave = resolve; });

  // The same person's session is confirmed while the save is in flight (the
  // verified boot answer, read before the save): the saved choice still wins.
  const spanish = runtime.changeLanguage('es', slow);
  await until(() => finishSave, 'the Spanish save to begin');
  await runtime.applySessionLanguage({ id: 7, locale: null });
  assert.equal(runtime.getLanguage(), 'en');
  finishSave();
  assert.equal(await spanish, true);
  assert.equal(runtime.getLanguage(), 'es');

  // Signed out before the save lands: that choice belonged to the account.
  finishSave = null;
  const english = runtime.changeLanguage('en', slow);
  await until(() => finishSave, 'the English save to begin');
  await runtime.applySessionLanguage(null);
  const signedOut = [runtime.getLanguage(), runtime.getPreference()];
  finishSave();
  assert.equal(await english, false);
  assert.deepEqual([runtime.getLanguage(), runtime.getPreference()], signedOut);
  assert.equal(page.storage.has(DEVICE_KEY), false, 'and it is not kept as a device choice');
});

test('the notice shows once per device, the first time the language was picked automatically', async (t) => {
  const { catalogs, runtime, page } = setup(t, { deviceLanguages: ['es-MX', 'en'] });
  let told = 0;
  runtime.subscribeNotice(() => { told += 1; });
  await runtime.applySessionLanguage(null);
  assert.equal(runtime.getLanguage(), 'es');
  assert.deepEqual(runtime.getNotice(), { language: 'es', name: 'Español' });
  assert.equal(told, 1);
  assert.equal(page.storage.get(NOTICE_KEY), 'es');
  runtime.dismissNotice();
  assert.equal(runtime.getNotice(), null);
  assert.equal(told, 2);

  // The next visit: still Spanish, and nothing is said about it again.
  const again = runtimeFor(catalogs);
  await again.applySessionLanguage(null);
  assert.equal(again.getLanguage(), 'es');
  assert.equal(again.getNotice(), null);
});

test('a language the person chose is never announced', async (t) => {
  const { runtime, page } = setup(t, { deviceLanguages: ['en-US'] });
  await runtime.applySessionLanguage({ locale: 'es' });
  assert.equal(runtime.getLanguage(), 'es');
  assert.equal(runtime.getNotice(), null);
  assert.equal(page.storage.has(NOTICE_KEY), false, 'the one notice is still unspent');
  assert.equal(runtime.isSignedIn(), true);
});

test('a saved language Homeroom does not ship follows the device, and says so', async (t) => {
  const { runtime } = setup(t, { deviceLanguages: ['es-AR'] });
  await runtime.applySessionLanguage({ locale: 'ja' });
  assert.equal(runtime.getLanguage(), 'es');
  assert.equal(runtime.getPreference(), 'ja', 'the saved preference, which apps still receive, is not rewritten');
  assert.deepEqual(runtime.getNotice(), { language: 'es', name: 'Español' });
});

test('Switch to English: the notice goes, and the choice holds on this device', async (t) => {
  const { catalogs, runtime, page } = setup(t, { deviceLanguages: ['es-MX'] });
  await runtime.applySessionLanguage(null);
  assert.ok(runtime.getNotice());
  // Signed out there is no account to save to: the device keeps it.
  assert.equal(await runtime.changeLanguage('en'), true);
  assert.equal(runtime.getLanguage(), 'en');
  assert.equal(runtime.getNotice(), null);
  assert.equal(page.storage.get(DEVICE_KEY), 'en');

  const nextVisit = runtimeFor(catalogs);
  await nextVisit.applySessionLanguage(null);
  assert.equal(nextVisit.getLanguage(), 'en', 'the device choice outranks the device languages');
  // Signing in to an account set to Auto keeps what this device was told.
  await nextVisit.applySessionLanguage({ locale: null });
  assert.equal(nextVisit.getLanguage(), 'en');
  // An account choice replaces the device one: Auto means the device again.
  assert.equal(await nextVisit.changeLanguage(null, async () => {}), true);
  assert.equal(page.storage.has(DEVICE_KEY), false);
  assert.equal(nextVisit.getLanguage(), 'es');
});

test('RichMessage keeps a whole sentence together and renders a parameter as text', async (t) => {
  const { runtime } = setup(t);
  const { RichMessage, Message } = loadTsx('frontend/src/lib/i18n/react.tsx', { stubs: { './runtime': runtime } });
  const legal = () => renderToHtml(createElement(RichMessage, {
    id: 'legal', values: { name: '<0>Ana</0>' }, components: [createElement('a', { href: '/terms' })],
  }));
  assert.equal(legal(), 'Read <a href="/terms">the terms</a>, &lt;0&gt;Ana&lt;/0&gt;.');
  assert.equal(renderToHtml(createElement(Message, { id: 'core:hello', values: { name: 'Ana' } })), 'Hello Ana');
  await runtime.changeLanguage('es');
  assert.equal(legal(), 'Lee <a href="/terms">los términos</a>, &lt;0&gt;Ana&lt;/0&gt;.');
  assert.equal(renderToHtml(createElement(Message, { id: 'onlyEnglish' })), 'Not translated yet');
});

// The shell's real catalogs, not a fixture: what it offers is what the
// translation step's proposals have merged, so this holds whether a language
// has passed the coverage bar yet or not (it pinned "English only" until the
// first translations did, PR #4764).
test("the shell's own runtime offers what its packs ship, English first; a language none ships stays English, with no pack and no notice", async (t) => {
  const page = browser(t, { root: ROOT, deviceLanguages: ['ja'] });
  const shell = loadTsx('frontend/src/lib/i18n/runtime.ts');
  const generated = JSON.parse(read('frontend/src/lib/i18n/catalogs.generated.json'));
  assert.deepEqual(shell.shippedLanguages, Object.entries(generated.languages).map(([tag, name]) => ({ tag, name })));
  assert.deepEqual(shell.shippedLanguages[0], { tag: 'en', name: 'English' });
  assert.ok(!shell.shippedLanguages.some((l) => l.tag === 'ja'), 'Japanese is not a configured language');
  await shell.applySessionLanguage(null);
  await shell.applySessionLanguage({ locale: 'ja' });
  assert.equal(shell.getLanguage(), 'en');
  assert.equal(shell.getNotice(), null);
  assert.equal(page.requests.length, 0);
  assert.equal(shell.t('language.notice.showing', { language: 'Español' }), 'Showing Homeroom in Español');
  assert.equal(shell.languageName('ja'), '日本語', 'a kept choice is listed by its own name');
  for (const name of ['t', 'htmlText', 'languageName', 'getLanguage', 'changeLanguage', 'applySessionLanguage', 'saveAccountLocale']) {
    assert.equal(typeof globalThis.PlatformI18n[name], 'function', `PlatformI18n.${name}`);
  }
  t.after(() => { delete globalThis.PlatformI18n; });
});

test('the notice is a React island that says it in the picked language and offers English in English', () => {
  const notice = read('frontend/src/features/shell/language-notice.tsx');
  assert.match(notice, /useSyncExternalStore\(subscribeNotice, getNotice, \(\) => null\)/,
    'the prerendered document and the hydrating render hold nothing');
  assert.match(notice, /if \(!notice\) return null;/);
  assert.match(notice, /t\('core:language\.notice\.showing', \{ language: notice\.name \}\)/);
  assert.match(notice, /i18n\.getFixedT\('en', 'core'\)\('core:language\.notice\.switchToEnglish'\)/,
    'the way back is readable by someone who cannot read the picked language');
  assert.match(notice, /lang="en"/);
  assert.match(notice, /aria-label=\{t\('core:language\.notice\.dismiss'\)\}/);
  const shell = read('frontend/src/Shell.tsx');
  assert.match(shell, /<Island name="LanguageNotice"><LanguageNotice \/><\/Island>/);
  // It stays in view until answered: fixed above the tab bar, where a toast
  // rests, over the sign-in screens (z-40) and under the drawer (z-50).
  const css = read('public/css/app.css');
  const rule = css.slice(css.indexOf('\n#language-notice {'), css.indexOf('}', css.indexOf('\n#language-notice {')));
  assert.match(rule, /position: fixed;/);
  assert.match(rule, /bottom: calc\(16px \+ max\(var\(--language-notice-inset, var\(--platform-tabs-h, 0px\)\), var\(--platform-safe-bottom, 0px\)\)\);/);
  assert.match(rule, /z-index: 45;/);
  assert.match(notice, /'--language-notice-inset': `\$\{inset\}px`/, 'a composer above the bar is cleared too');
  assert.match(css, /#view-as-non-admin-banner, #language-notice, #platform-side-panel\) \{\n {2}display: none !important;/,
    'the side panel shows none of the shell chrome, this included');
  assert.match(read('frontend/src/main.tsx'), /import '\.\/lib\/i18n\/runtime';\nimport \{ Shell \} from '\.\/Shell';/,
    'the runtime is loaded before the shell renders');
  assert.match(read('public/js/app.js'), /void globalThis\.PlatformI18n\?\.applySessionLanguage\?\.\(null\);/,
    'the sign-in screens follow the device, without waiting on it');
});

test('Switch to English saves to the account when signed in, and to the device when not', () => {
  const runtime = read('frontend/src/lib/i18n/runtime.ts');
  assert.match(runtime, /changeLanguage\('en', runtime\.isSignedIn\(\)\s+\? async \(value\) => \{ await saveAccountLocale\(value\); \}\s+: undefined\)/);
});

// The server's translation cache (GET /api/languages, src/services/
// language-cache.js) can offer a language this build's catalogs do not ship,
// and newer packs for one they do. The runtime takes its list and checks
// every pack it names against the hash the list gave, as it checks a build's.
function liveSetup(t, options = {}) {
  const fixture = catalogFixture(t);
  const { catalogs } = fixture.build();
  const page = browser(t, { root: fixture.root, ...options });
  // This build ships English only; the cache has the Spanish, served under
  // /locales/live/ like the server serves it.
  const englishOnly = { ...catalogs, languages: { en: 'English' }, manifest: {} };
  const live = { languages: catalogs.languages, manifest: {} };
  for (const [language, packs] of Object.entries(catalogs.manifest)) {
    live.manifest[language] = {};
    for (const [namespace, entry] of Object.entries(packs)) {
      const name = entry.url.split('/').pop();
      fs.mkdirSync(path.join(fixture.root, 'public/locales/live'), { recursive: true });
      fs.copyFileSync(path.join(fixture.root, 'public', entry.url), path.join(fixture.root, 'public/locales/live', name));
      live.manifest[language][namespace] = { url: `/locales/live/${name}`, hash: entry.hash };
    }
  }
  return { page, live, runtime: runtimeFor(englishOnly) };
}

test('a language only the server\'s cache has is offered once its list arrives, and a session that wants it shows it', async (t) => {
  const { page, live, runtime } = liveSetup(t);
  assert.deepEqual(runtime.getLanguages(), [{ tag: 'en', name: 'English' }]);
  await runtime.applySessionLanguage({ id: 1, locale: 'es' });
  assert.equal(runtime.getLanguage(), 'en', 'nothing ships it yet');
  let heard = 0;
  runtime.subscribeLanguages(() => { heard += 1; });
  assert.equal(runtime.setLiveCatalogs(live), true);
  assert.equal(heard, 1);
  assert.deepEqual(runtime.getLanguages(), [{ tag: 'en', name: 'English' }, { tag: 'es', name: 'Español' }]);
  assert.ok(page.events.some((event) => event.type === 'homeroom:languages-changed'));
  await until(() => runtime.getLanguage() === 'es', 'the session to show Spanish');
  assert.equal(runtime.t('hello', { name: 'Ana' }), 'Hola Ana');
  assert.match(page.requests[0], /^\/locales\/live\/es\.core\.[a-f0-9]{64}\.json$/);
});

test('a list the runtime cannot trust is refused, and the build\'s languages stand', (t) => {
  const { live, runtime } = liveSetup(t);
  const entry = live.manifest.es.core;
  const broken = [
    null,
    { languages: live.languages },
    { ...live, manifest: { es: { core: { ...entry, url: 'https://elsewhere.example/es.json' } } } },
    { ...live, manifest: { es: { core: { ...entry, hash: 'nope' } } } },
    { ...live, manifest: { es: {} } },
  ];
  for (const value of broken) assert.equal(runtime.setLiveCatalogs(value), false, JSON.stringify(value)?.slice(0, 80));
  assert.deepEqual(runtime.getLanguages(), [{ tag: 'en', name: 'English' }]);
});

test('a session waits a moment for the list rather than show English and switch', async (t) => {
  const { page, live, runtime } = liveSetup(t);
  runtime.waitForLive(new Promise((resolve) => { setTimeout(() => { runtime.setLiveCatalogs(live); resolve(); }, 30); }));
  await runtime.applySessionLanguage({ id: 1, locale: 'es' });
  assert.equal(runtime.getLanguage(), 'es');
  const switches = page.events.filter((event) => event.type === 'homeroom:language-changed' && !event.detail.namespace);
  assert.deepEqual(switches.map((event) => event.detail.language), ['es'], 'straight to Spanish, never English first');
});

test('somebody whose first language ships never waits for the list', async (t) => {
  const { live, runtime } = liveSetup(t, { deviceLanguages: ['en-US', 'es'] });
  runtime.waitForLive(new Promise(() => {}));
  const started = Date.now();
  await runtime.applySessionLanguage({ id: 1, locale: null });
  assert.equal(runtime.getLanguage(), 'en');
  assert.ok(Date.now() - started < 500, 'English shipped, so nothing waited on the list');
  assert.equal(runtime.setLiveCatalogs(live), true);
  assert.equal(runtime.getLanguage(), 'en', 'and the list arriving changes nothing for them');
});

test('the shell asks for the list once it boots, and Settings lists what it adds', () => {
  const runtime = read('frontend/src/lib/i18n/runtime.ts');
  assert.match(runtime, /fetch\('\/api\/languages', \{ credentials: 'same-origin', signal: controller\.signal, redirect: 'error' \}\)/);
  assert.match(runtime, /runtime\.waitForLive\(loadLiveLanguages\(\)\);/);
  assert.match(runtime, /applySessionLanguage, saveAccountLocale, getLanguages,\n\};/, 'legacy modules read the list too');
  const settings = read('frontend/src/features/settings/settings.js');
  assert.match(settings, /for \(const \{ tag, name \} of window\.PlatformI18n\?\.getLanguages\?\.\(\) \|\| \[\]\) \{/);
  assert.match(settings, /document\.addEventListener\('homeroom:languages-changed', \(\) => \{\n\s+if \(!Settings\._open\) return;\n\s+try \{ Settings\._renderLanguageSection\(\); \}/,
    'a list that arrives while Settings is open is listed there');
});
