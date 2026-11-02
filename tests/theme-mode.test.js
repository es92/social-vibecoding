// Tests for the Light / Dark / System theme mode selector (#256).
//
// Static-assertion style (cf. tests/spec-sections.test.js,
// tests/app-conventions.test.js): read the shipped source files and assert
// the wiring is present, so the feature can't silently regress.
//
// Run with: node --test tests/theme-mode.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shellMarkup } = require('./lib/shell-markup');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (...p) => fs.readFileSync(path.join(PUBLIC, ...p), 'utf8');

// #1079 chunk B: public/js/theme.js is gone. The module is an INLINE
// head-blocking <script> in frontend/src/head.html now, which is also where
// the old duplicate three-line no-flash guard used to sit — the module ends by
// calling apply(), so it is the guard. It could not move into the React bundle
// with the rest of chunk B: that bundle is deferred, and deciding "is this page
// dark" after the document parses means a visible light-to-dark repaint on
// every load. The assertions below are unchanged; only their source is.
const themeSrc = () => fs.readFileSync(path.join(ROOT, 'frontend/src/head.html'), 'utf8');

// login.html / register.html dropped: they're redirect stubs into the
// SPA's hash routes now (fold-auth-pages-into-SPA) — the in-SPA auth
// screens live inside index.html, which stays themed.
//
// admin.html / dashboard.html / status.html dropped for the same reason by
// #860: the seven standalone admin pages are #admin console sections now,
// and those files are redirect stubs with no theme bootstrap of their own.
// index.html is the one document left that needs one.
const THEMED_PAGES = [
  'index.html',
];

// ── Theme module contract ────────────────────────────────────────────────

test('the inline head module exposes the Theme API', () => {
  const src = themeSrc();
  assert.match(src, /window\.Theme\s*=/, 'theme.js must assign window.Theme');
  for (const fn of ['get', 'set', 'apply', 'onChange']) {
    assert.match(src, new RegExp(`function ${fn}\\b`), `theme.js must define ${fn}()`);
  }
});

test('theme.js implements the localStorage.theme storage contract', () => {
  const src = themeSrc();
  // 'light' / 'dark' stored explicitly; system removes the key.
  assert.match(src, /setItem\(\s*KEY/, 'set() must persist the key for light/dark');
  assert.match(src, /removeItem\(\s*KEY/, 'set() must remove the key for system');
  assert.match(src, /try\s*\{/, 'localStorage access must be wrapped in try/catch');
});

test('theme.js defines the three modes', () => {
  const src = themeSrc();
  for (const mode of ['light', 'dark', 'system']) {
    assert.ok(src.includes(`'${mode}'`), `theme.js must reference the '${mode}' mode`);
  }
});

test('the ground is painted before any stylesheet, and the chrome follows the theme', () => {
  // THE BACKGROUND SHOWN BEFORE THE PAGE LOADS DID NOT MATCH THE PAGE.
  //
  // Two halves, both fixed here because both have to be true with NOTHING
  // loaded yet:
  //
  //   * the page ground is a Tailwind utility on <body>, and the compiled
  //     stylesheet is the LAST resource in this head — so every load painted
  //     the browser's default white first, which a service-worker-served
  //     shell makes more visible rather than less. An inline rule on <html>
  //     states the same two colours with no stylesheet at all.
  //   * `theme-color` was pinned to the dark ground for everybody, so a
  //     light-mode viewer got a black band above a light page in the
  //     address bar, the iOS status strip, the rubber-band area and a
  //     standalone install's window ground.
  //
  // `color-scheme` joined these two rules afterwards, for the third thing
  // that has to be true with nothing loaded: the USER AGENT's own palette —
  // the canvas under the document, the scrollbars, the default form
  // controls. Same rules, same two selectors, because it answers the same
  // question. tests/native-appearance.test.js pins that half, including
  // that it is keyed off `.dark` rather than delegated to the OS; these two
  // assertions still own the ground colours themselves.
  const src = themeSrc();
  assert.match(src, /html \{ background-color: #f4f2e4; color-scheme: light; \}/,
    'the light ground is painted with no stylesheet loaded');
  assert.match(src, /html\.dark \{ background-color: #0b0d1b; color-scheme: dark; \}/,
    'and the dark one, keyed off the class apply() has just written');
  // Written from the RESOLVED theme, not left to a prefers-color-scheme meta
  // pair: the shell's own Light/Dark override is a class on <html> that no
  // media query can see, so a viewer who picks Light on a dark OS has to get
  // the light chrome.
  assert.match(src, /const GROUND = \{ light: '#f4f2e4', dark: '#0b0d1b' \};/);
  const apply = src.slice(src.indexOf('function apply()'), src.indexOf('function set('));
  assert.match(apply, /meta\[name="theme-color"\]/,
    'apply() owns the chrome colour');
  assert.match(apply, /wantDark \? GROUND\.dark : GROUND\.light/,
    'and picks it from the same resolved boolean that writes the class');
  // The meta has to be PARSED by the time apply() runs — it is head-blocking
  // and runs during parse, so a tag further down the head would not be found.
  assert.ok(src.indexOf('name="theme-color"') < src.indexOf('window.Theme'),
    'the theme-color meta must precede the module that rewrites it');
});

test('theme.js registers prefers-color-scheme and storage listeners', () => {
  const src = themeSrc();
  assert.match(
    src,
    /matchMedia\(\s*'\(prefers-color-scheme: dark\)'\s*\)\.addEventListener\(\s*'change'/,
    'theme.js must listen for OS colour-scheme changes',
  );
  assert.match(
    src,
    /addEventListener\(\s*'storage'/,
    'theme.js must listen for cross-tab storage changes',
  );
});

// ── Per-page includes + no-flash guard ───────────────────────────────────

for (const page of THEMED_PAGES) {
  test(`${page} carries the theme module inline, before any stylesheet`, () => {
    const src = read(page);
    assert.ok(!src.includes('src="/js/theme.js"'),
      `${page} must not load a second copy from a classic tag`);
    const themeAt = src.indexOf('window.Theme =');
    assert.ok(themeAt > 0, `${page} must inline the theme module in <head>`);
    // Head-blocking and ahead of the stylesheets: the class it puts on <html>
    // has to be there before the first style that reads it is applied.
    const cssAt = src.indexOf('<link rel="stylesheet"');
    assert.ok(cssAt > 0 && themeAt < cssAt,
      `${page}'s theme module must run before the first stylesheet link`);
  });

  test(`${page} carries the inline no-flash guard`, () => {
    const src = read(page);
    // The module IS the guard: it ends by calling apply(), inline in <head>.
    const themeAt = src.indexOf('window.Theme =');
    const applyAt = src.indexOf('apply();\n', themeAt);
    assert.ok(applyAt > themeAt,
      `${page}'s inline theme module must call apply() before first paint`);
    assert.ok(src.includes("const KEY = 'theme'"),
      `${page} must contain the localStorage 'theme' storage contract`);
  });
}

// ── Control markup (index.html) ──────────────────────────────────────────

// The theme selector has moved twice. It was the LAST row of the hamburger
// drawer; the header slim-down promoted it to the FIRST thing in that drawer's
// body; THE UI OVERHAUL took it out of the drawer entirely and made it the
// first SETTING. A live control that changes how the whole product looks is
// not navigation, and the drawer is navigation plus notifications now.
//
// Position is the whole point of each of those moves, so it stays pinned —
// only to a different container.
test('the theme control lives in its own Settings section', () => {
  const src = shellMarkup();
  const pane = src.indexOf('data-settings-section="theme"');
  const track = src.indexOf('id="drawer-theme-track"');
  assert.ok(pane !== -1, 'the theme settings pane is missing');
  assert.ok(track !== -1, 'drawer-theme-track missing');
  assert.ok(track > pane, 'the track lives inside the theme settings pane');
  // …and there is only ONE of it. Two copies would be two owners of the
  // highlight. It used to
  // be worth checking the hamburger drawer specifically; the drawer is
  // retired, so the honest check is that the track appears once anywhere.
  assert.equal(src.indexOf('id="drawer-theme-track"', track + 1), -1,
    'exactly one theme track in the document');
  assert.equal(src.indexOf('id="drawer-row-theme"'), -1,
    'the drawer row that wrapped it is retired');
});

// The track's id did NOT change with the move: app.css keys the segmented
// track off it. The caret's two ids are retired (overnight UI audit D10,
// recorded in tests/shell-id-inventory.test.js RETIRED_IDS).
test('the moved control keeps the id app.css draws it with, and no caret', () => {
  const src = shellMarkup();
  assert.ok(src.includes('id="drawer-theme-track"'), '#drawer-theme-track survived the move');
  for (const id of ['drawer-theme-caret-track', 'drawer-theme-caret']) {
    assert.ok(!src.includes(`id="${id}"`), `#${id} is gone (audit D10)`);
  }
});

// THE UI OVERHAUL made Theme the first setting and the default section. The
// settings restructure made Account the default page (Profile leads it) and
// gave Theme the head of the Appearance page, in Preferences. #5285 moved
// the developer console's switch and the admin preview to a Developer page,
// so Appearance is the theme and the desktop sidebar switch alone.
test('theme leads the Appearance page in Preferences', () => {
  const settings = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'settings.js'),
    'utf8',
  );
  const list = settings.slice(settings.indexOf('SECTIONS: ['), settings.indexOf('    PAGES: {'));
  const lines = list.split('\n').filter((l) => l.includes("page: 'theme'"));
  // The registry holds message ids; the English catalog holds the words.
  assert.match(lines[0] || '', /\{ key: 'theme', label: 'settings:nav\.part\.theme', group: 'settings:nav\.group\.preferences', page: 'theme' \}/,
    'theme is the first part of its page');
  assert.equal(message('settings:nav.part.theme'), 'Theme');
  assert.equal(message('settings:nav.group.preferences'), 'Preferences');
  assert.match(settings, /theme: 'settings:nav\.page\.theme',/);
  assert.equal(message('settings:nav.page.theme'), 'Appearance', 'and that page is labelled Appearance');
  assert.doesNotMatch(settings, /DEFAULT_SECTION: 'theme'/,
    'a bare #settings opens Account now, not Theme');
});

test('index.html exposes the three data-theme-mode buttons', () => {
  const src = shellMarkup();
  for (const mode of ['light', 'dark', 'system']) {
    assert.ok(
      src.includes(`data-theme-mode="${mode}"`),
      `index.html must have a data-theme-mode="${mode}" button`,
    );
  }
});

test('the three modes render as a labelled radiogroup of segments', () => {
  const src = shellMarkup();
  const track = src.match(/<div id="drawer-theme-track"[^>]*>/);
  assert.ok(track, 'drawer-theme-track missing');
  assert.match(track[0], /role="radiogroup"/, 'the segmented track is a radiogroup');
  assert.match(track[0], /aria-label="Theme"/, 'the radiogroup is labelled');
  // Each segment is a radio, so a screen reader announces "2 of 3"
  // rather than three unrelated buttons.
  for (const mode of ['light', 'dark', 'system']) {
    const btn = src.match(new RegExp(`<button[^>]*data-theme-mode="${mode}"[^>]*>`));
    assert.ok(btn, `segment button for ${mode} missing`);
    assert.match(btn[0], /role="radio"/, `${mode} segment carries role=radio`);
    assert.match(btn[0], /class="theme-seg /, `${mode} segment carries the .theme-seg class`);
  }
});

// ── The segmented control's wiring ───────────────────────────────────────
//
// #1079 chunk B made #header-menu-panel a React island and the theme segments
// the one genuinely stateful thing inside it: App.HeaderMenu's
// _renderThemeButtons is now ThemeControl in
// frontend/src/features/header/header-menu.tsx, and app.js no longer touches
// the control at all. Same three contracts, read from the component.

const themeControlSrc = () => fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'sections', 'theme.tsx'),
  'utf8',
);

test('the theme control wires Theme.get / Theme.set', () => {
  const src = themeControlSrc();
  assert.match(src, /window\.Theme\?\.get\?\.\(\)/, 'the control must read Theme.get()');
  assert.match(src, /window\.Theme\?\.set\?\.\(next\)/, 'and call Theme.set()');
  assert.match(src, /window\.Theme\?\.onChange\?\.\(sync\)/,
    'a storage/OS-driven change in another tab must re-highlight here too');
  // The legacy renderer must be gone from BOTH sides, or two owners write the
  // same nodes — which is the failure the migration rule exists to prevent.
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(!/_renderThemeButtons/.test(appSrc),
    'app.js must not still render the segments');
});

test('the control marks the chosen segment, and draws no caret', () => {
  const src = themeControlSrc();
  const at = src.indexOf('function ThemeControl()');
  assert.ok(at !== -1, 'ThemeControl located');
  const body = src.slice(at, src.indexOf('export function ThemeSection()', at));
  assert.match(body, /theme-seg-active/,
    'the active segment is marked with a class, not inline utility toggles');
  assert.doesNotMatch(body, /theme-caret|drawer-theme-caret/, 'audit D10: no caret, and nothing positions one');
  // Hydration equality: the shipped markup has no active segment, so the
  // first render must produce exactly that.
  assert.match(body, /useState<ThemeMode \| null>\(null\)/,
    'reading Theme.get() during render would mismatch the prerendered markup');
});

// #5285: the chosen segment was a white face on the light track, white on
// zinc-100, and hardly showed. It wears the lit tokens now (the palette's
// "where you are"), which every theme defines. The caret that pointed at it
// is gone (audit D10): the lit segment is the whole answer.
test('the chosen segment wears the lit tokens, and app.css draws no caret', () => {
  const css = read('css', 'app.css');
  const rule = /\.theme-seg\.theme-seg-active \{([^}]*)\}/.exec(css);
  assert.ok(rule, '.theme-seg.theme-seg-active rule located');
  assert.match(rule[1], /background:\s*var\(--lit-tint\)/, 'filled with the lit tint');
  assert.match(rule[1], /color:\s*var\(--lit-ink\)/, 'labelled in the lit ink');
  assert.match(rule[1], /box-shadow:\s*inset 0 0 0 1px var\(--lit-line\)/, 'ringed by the lit line');
  assert.doesNotMatch(rule[1], /var\(--bg-primary\)/, 'no longer the page colour, which vanished on light');
  assert.doesNotMatch(css, /drawer-theme-caret|--theme-caret-index/, 'no caret rules left');
});

test('the Suggest form\'s destination picker draws no caret either', () => {
  const form = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'features', 'dialogs', 'feedback.tsx'), 'utf8');
  const controller = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'features', 'dialogs', 'feedback-controller.js'), 'utf8');
  assert.doesNotMatch(form, /feedback-caret/);
  assert.doesNotMatch(controller, /feedback-caret|feedbackCaret/);
});

test('the theme button click handler does NOT close the drawer', () => {
  const src = themeControlSrc();
  // Isolate the theme-button click handler and assert it sets the mode
  // without the HeaderMenu.close() that every navigation row uses.
  const setIdx = src.indexOf('window.Theme?.set?.(next)');
  assert.ok(setIdx !== -1, 'Theme.set call not found');
  const region = src.slice(setIdx, setIdx + 200);
  assert.ok(
    !region.includes('HeaderMenu.close()'),
    'theme selection must keep the drawer open (no HeaderMenu.close())',
  );
  // The segments are <button>s, not anchors, so the panel's delegated
  // a[href] close handler can never see them either.
  const at = src.indexOf('function ThemeControl()');
  const body = src.slice(at, src.indexOf('export function ThemeSection()', at));
  assert.ok(!/<a\b/.test(body),
    'an anchor here would be closed by the drawer\'s delegated link handler');
});
