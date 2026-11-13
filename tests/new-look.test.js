// Tests for the new look, an experiment (Settings › Experimental, off by
// default): the head's window.Skin keeps the choice on the device and sets
// data-skin="brand" on <html> before first paint; app.css draws the look
// from that attribute in light mode only.
//
// Static-assertion style (cf. tests/accessibility-prefs.test.js), plus one
// run of the head module itself against a stub window, so the storage
// contract is pinned by behaviour rather than by spelling.
//
// Run with: node --test tests/new-look.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const headSrc = () => read('frontend', 'src', 'head.html');
const settingsJs = () => read('frontend', 'src', 'features', 'settings', 'settings.js');
const experimentalSrc = () => read('frontend', 'src', 'features', 'settings', 'sections', 'experimental.tsx');

// The Skin module's own source: from its assignment to the end of its IIFE.
function skinModuleSrc() {
  const src = headSrc();
  const start = src.indexOf('window.Skin = (function () {');
  assert.ok(start > 0, 'head.html must assign window.Skin');
  const end = src.indexOf('}());', start);
  assert.ok(end > start, 'the Skin module is one IIFE');
  return src.slice(start, end + '}());'.length);
}

// Runs the module against a stub window/document. `stored` seeds storage;
// `broken` makes every storage call throw, as a locked-down browser does.
function runSkin({ stored = null, broken = false } = {}) {
  const store = new Map(stored === null ? [] : [['homeroom:skin', stored]]);
  const attrs = new Map();
  const listeners = [];
  const localStorage = {
    getItem(k) { if (broken) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { if (broken) throw new Error('blocked'); store.set(k, String(v)); },
    removeItem(k) { if (broken) throw new Error('blocked'); store.delete(k); },
  };
  const window = {
    localStorage,
    addEventListener(type, fn) { if (type === 'storage') listeners.push(fn); },
  };
  const document = {
    documentElement: {
      setAttribute(k, v) { attrs.set(k, String(v)); },
      removeAttribute(k) { attrs.delete(k); },
    },
  };
  vm.runInNewContext(skinModuleSrc(), { window, document });
  return { Skin: window.Skin, store, attrs, listeners };
}

// ── The inline head module ───────────────────────────────────────────────

test('the new look is off by default', () => {
  const { Skin, attrs } = runSkin();
  assert.equal(Skin.get(), 'standard');
  assert.equal(attrs.has('data-skin'), false, 'no stored choice: no data-skin on <html>');
});

test('a stored choice is on <html> as soon as the module runs', () => {
  const { Skin, attrs } = runSkin({ stored: 'brand' });
  assert.equal(Skin.get(), 'brand');
  assert.equal(attrs.get('data-skin'), 'brand');
});

test('set() stores the new look and removes the key for the standard one', () => {
  const { Skin, store, attrs } = runSkin();
  let heard = 0;
  Skin.onChange(() => { heard += 1; });
  Skin.set('brand');
  assert.equal(store.get('homeroom:skin'), 'brand');
  assert.equal(attrs.get('data-skin'), 'brand');
  Skin.set('standard');
  assert.equal(store.has('homeroom:skin'), false, 'the standard look is the absence of the key');
  assert.equal(attrs.has('data-skin'), false);
  assert.equal(heard, 2, 'every set() tells its listeners');
});

test('unknown values read as standard, and a pick applies even with blocked storage', () => {
  assert.equal(runSkin({ stored: 'neon' }).Skin.get(), 'standard');
  const blocked = runSkin({ broken: true });
  assert.equal(blocked.Skin.get(), 'standard');
  assert.doesNotThrow(() => blocked.Skin.set('brand'), 'a blocked write never throws');
  // #6562: the pick is held in memory for the page's life when the browser
  // refuses to store it, so it is not lost.
  assert.equal(blocked.attrs.get('data-skin'), 'brand',
    'a choice that could not be stored still applies');
  assert.equal(blocked.Skin.get(), 'brand', 'and every reader gets it');
});

test('another tab changing the key re-applies it here', () => {
  const { Skin, store, attrs, listeners } = runSkin();
  assert.equal(listeners.length, 1, 'the module listens for storage events');
  store.set('homeroom:skin', 'brand');
  listeners[0]({ key: 'homeroom:skin' });
  assert.equal(attrs.get('data-skin'), 'brand');
  assert.equal(Skin.get(), 'brand');
});

test('the Skin module runs before the first stylesheet', () => {
  const src = headSrc();
  const skinAt = src.indexOf('window.Skin =');
  const cssAt = src.indexOf('<link rel="stylesheet"');
  assert.ok(cssAt > 0 && skinAt > 0 && skinAt < cssAt,
    'window.Skin must apply before any stylesheet reads data-skin');
});

// ── The settings switch ──────────────────────────────────────────────────

test('Settings › Experimental carries the New look switch, last of the switches', () => {
  const src = experimentalSrc();
  assert.match(src, /<SwitchRow id="new-look-enabled">/);
  assert.doesNotMatch(src, /review-flow-enabled/, 'the Needs you switch is gone');
  assert.ok(src.indexOf('id="new-look-enabled"') < src.indexOf('id="settings-local-agents-section"'));
  assert.match(src, /settings:experimental\.newLook\.label/);
  assert.match(src, /settings:experimental\.newLook\.description/);
});

test('settings.js saves and paints the switch through window.Skin', () => {
  const src = settingsJs();
  assert.match(src, /getElementById\('new-look-enabled'\)/);
  assert.match(src, /window\.Skin\?\.set\?\.\(e\.target\.checked \? 'brand' : 'standard'\)/,
    'the change is the save');
  assert.match(src, /window\.Skin\?\.get\?\.\(\) === 'brand'/, 'the pane paints the stored choice');
  assert.match(src, /window\.Skin\?\.onChange\?\.\(/, 'a change in another tab re-paints the switch');
});

test('the switch copy is English source with descriptions', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'settings.json'));
  for (const key of ['experimental.newLook.label', 'experimental.newLook.description']) {
    assert.ok(en[key], `${key} exists`);
    assert.ok(en[key].text.trim(), `${key} has text`);
    assert.ok(en[key].description.trim(), `${key} has a description`);
  }
});

// ── The app.css rules ────────────────────────────────────────────────────

// The new look's block: from its heading to the end of the sheet.
// The sheet before the new look, less the one other block that may name its
// faces: the website's look on the signed-out pages, every rule of which is
// under #auth-landing-screen (tests/guest-discover.test.js holds that).
function outsideBothLooks() {
  const css = read('public', 'css', 'app.css');
  const before = css.slice(0, css.indexOf('/* ── THE NEW LOOK, AN EXPERIMENT'));
  const a = before.indexOf("/* ── THE WEBSITE'S LOOK ON THE SIGNED-OUT PAGES");
  const end = "/* the website's look on the signed-out pages: end */";
  const b = before.indexOf(end);
  assert.ok(a > 0 && b > a, 'the signed-out pages\' look is one block between its two marks');
  return before.slice(0, a) + before.slice(b + end.length);
}

function lookBlock() {
  const css = read('public', 'css', 'app.css');
  const at = css.indexOf('/* ── THE NEW LOOK, AN EXPERIMENT');
  assert.ok(at > 0, 'app.css carries the new look block');
  return css.slice(at);
}

test('every rule of the new look is scoped to the flag, in light mode only', () => {
  // A media query only narrows where a rule applies, so its wrapper is
  // dropped and the rules inside it are read like the others.
  const block = lookBlock().replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
  const rules = block.split('}').map((r) => r.trim()).filter(Boolean);
  let selectors = 0;
  for (const rule of rules) {
    const head = rule.slice(0, rule.indexOf('{')).trim();
    if (!head || head === '@font-face') continue;
    for (const sel of head.split(',').map((s) => s.trim())) {
      selectors += 1;
      assert.ok(
        sel.startsWith('html[data-skin="brand"]:not(.dark):not([data-app-tone="dark"])'),
        `"${sel}" must start from the flag, outside dark mode and dark apps`,
      );
    }
  }
  assert.ok(selectors > 10, 'the block is read whole');
});

test('the block lives last and redeclares none of the counted wallpaper tokens', () => {
  const css = read('public', 'css', 'app.css');
  const block = lookBlock();
  assert.ok(css.trimEnd().endsWith(block.trimEnd()), 'appended at the very end of app.css');
  for (const token of ['--home-washes:', '--home-wallpaper:', '--dc-sheet-fill:', '--dc-frost:']) {
    assert.ok(!block.includes(token), `${token} is counted elsewhere and must not be redeclared here`);
  }
});

test('Geist loads from our own origin by an absolute path, and only for the new look', () => {
  const block = lookBlock();
  assert.match(block, /@font-face\s*\{[^}]*font-family:\s*'Geist'[^}]*url\('\/fonts\/geist\/Geist-Variable\.woff2'\)/,
    'the face points at the self-hosted file by an absolute, same-origin path');
  // Nothing else names the family (the Brand kit look, which also set it, was
  // retired on 12 Nov 2026), but for the signed-out pages (13 Nov 2026): the
  // guest Discover and the page about private communities are drawn in the
  // website's look, in these same faces, by rules under #auth-landing-screen
  // only. So a signed-in browser without the new look still never matches a
  // rule that names Geist, and never downloads the file.
  assert.ok(!/Geist/.test(outsideBothLooks()), 'nothing outside the new look and the signed-out pages\' look names Geist');
});

test('/fonts/ is a public static prefix, like /vendor/', () => {
  const auth = read('src', 'middleware', 'auth.js');
  const m = auth.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m && /'\/fonts\/'/.test(m[1]), 'signed-out screens fetch the font too');
});

// ── The typeface ─────────────────────────────────────────────────────────

test('Geist is served from our own origin with its licence beside it', () => {
  const dir = path.join(ROOT, 'public', 'fonts', 'geist');
  assert.ok(fs.statSync(path.join(dir, 'Geist-Variable.woff2')).size > 10_000, 'the font file is committed');
  assert.match(read('public', 'fonts', 'geist', 'LICENSE.txt'), /SIL Open Font License/,
    'the OFL travels with the font');
});

test('Geist Mono and Young Serif load from our own origin, with their licences beside them', () => {
  const block = lookBlock();
  for (const [family, file] of [
    ['Geist Mono', '/fonts/geist-mono/GeistMono-Variable.woff2'],
    ['Young Serif', '/fonts/young-serif/young-serif-latin-400-normal.woff2'],
  ]) {
    const face = new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*'${family}'[^}]*url\\('${file.replace(/[.]/g, '\\.')}'\\)`);
    assert.match(block, face, `${family} points at the self-hosted file by an absolute, same-origin path`);
    assert.ok(fs.statSync(path.join(ROOT, 'public', file)).size > 10_000, `${file} is committed`);
    const licence = path.join(ROOT, 'public', path.dirname(file), 'LICENSE.txt');
    assert.match(fs.readFileSync(licence, 'utf8'), /SIL Open Font License/, `the OFL travels with ${family}`);
  }
  // …nor Young Serif, the signed-out pages' look apart (see Geist, above).
  assert.ok(!/Young Serif/.test(outsideBothLooks()), 'nothing outside the new look and the signed-out pages\' look names Young Serif');
});

test("a community's header keeps its own colour in the new look", () => {
  const block = lookBlock().replace(/\/\*[\s\S]*?\*\//g, '');
  const heads = block.split('}').map((r) => r.slice(0, r.indexOf('{')).trim()).filter((h) => h.includes('#platform-header'));
  assert.ok(heads.length >= 2, 'the top-level bar is restyled');
  for (const head of heads) {
    for (const sel of head.split(',').map((x) => x.trim()).filter((x) => x.includes('#platform-header'))) {
      if (/#platform-header h1/.test(sel) && !/#platform-header#platform-header/.test(sel)) continue; // the title rule only skips the header
      assert.match(sel, /:not\(\[data-community-tint\]\)/, `"${sel}" must leave a project's bar its community's colour`);
    }
  }
});

test('the empty-state figures are committed beside their provenance, and drawn only by the new look', () => {
  for (const name of ['phone.png', 'log.png']) {
    assert.ok(fs.statSync(path.join(ROOT, 'public', 'illustrations', 'people', name)).size > 2_000, `${name} is committed`);
    assert.match(lookBlock(), new RegExp(`url\\('/illustrations/people/${name.replace('.', '\\.')}'\\)`), `${name} is drawn by the new look by an absolute path`);
  }
  assert.match(read('public', 'illustrations', 'people', 'README.md'), /onhomeroom\.com/, 'where the figures come from');
  const css = read('public', 'css', 'app.css');
  const before = css.slice(0, css.indexOf('/* ── THE NEW LOOK, AN EXPERIMENT'));
  assert.ok(!before.includes('/illustrations/people/'), 'nothing outside the new look loads them');
});
