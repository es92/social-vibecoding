// #1945: inside an app, the bar takes the app's tone.
//
// The framed app's bridge reports its opaque page colour to the shell
// (#1581); features/app-frame/app-tone.js turns that into `data-app-tone` on
// <html>, and app.css keys the wallpaper, the sheet edge and the bar's brand
// tokens off it beside `.dark`. This file drives the module directly (it is
// plain JS, like the frame store, for exactly this reason) and pins the wiring
// around it at source level: the effect in the frame host, the theme-change
// re-publish in mount.ts, the CSS selectors, the `?theme=` pin in the head, the
// two screenshot states and their declared checks.
//
// Run with: node --test tests/app-tone.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

async function loadTone() {
  return import(new URL('../frontend/src/features/app-frame/app-tone.js', `file://${__filename}`).href);
}

// A document with just the two nodes the module writes: <html> and the
// theme-color meta.
function fakeDocument({ withMeta = true } = {}) {
  const attrs = new Map();
  const metaAttrs = new Map([['content', '#f4f2e4']]);
  const meta = {
    getAttribute: (k) => (metaAttrs.has(k) ? metaAttrs.get(k) : null),
    setAttribute: (k, v) => metaAttrs.set(k, String(v)),
  };
  return {
    documentElement: {
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      setAttribute: (k, v) => attrs.set(k, String(v)),
      removeAttribute: (k) => attrs.delete(k),
    },
    querySelector: (sel) => (withMeta && sel === 'meta[name="theme-color"]' ? meta : null),
    attrs, meta, metaAttrs,
  };
}

const ON = (background) => ({ slug: 'demo', active: true, background });

// ── the tone itself ──────────────────────────────────────────────────────

test('toneOf splits page colours at the WCAG white-text threshold', async () => {
  const { toneOf, luminanceOf, DARK_LUMINANCE } = await loadTone();
  assert.equal(DARK_LUMINANCE, 0.179);
  // The platform's own two grounds sit far to either side.
  assert.equal(toneOf('#f4f2e4'), 'light');
  assert.equal(toneOf('#0b0d1b'), 'dark');
  // Stock black and white, and the greys either side of the line.
  assert.equal(toneOf('#000000'), 'dark');
  assert.equal(toneOf('#ffffff'), 'light');
  assert.equal(toneOf('#4a4a4a'), 'dark', 'a dark grey reads as dark');
  assert.equal(toneOf('#808080'), 'light', 'mid grey keeps black text, so it is light');
  // Saturated colours: navy is dark, a pale yellow is light, pure blue is dark
  // (blue carries little luminance), pure green is light.
  assert.equal(toneOf('#1a2239'), 'dark');
  assert.equal(toneOf('#fff7c2'), 'light');
  assert.equal(toneOf('#0000ff'), 'dark');
  assert.equal(toneOf('#00ff00'), 'light');
  // Case and whitespace are the bridge's problem, not a reason to fall over.
  assert.equal(toneOf(' #0B0D1B '), 'dark');
  // Luminance is the standard formula.
  assert.ok(Math.abs(luminanceOf('#ffffff') - 1) < 1e-9);
  assert.equal(luminanceOf('#000000'), 0);
});

test('anything that is not an opaque hex colour has no tone', async () => {
  const { toneOf, luminanceOf } = await loadTone();
  for (const bad of ['', null, undefined, '#fff', 'rgb(0,0,0)', '#0b0d1b80', 'black', 12, {}]) {
    assert.equal(toneOf(bad), null, `${JSON.stringify(bad)} has no tone`);
    assert.equal(luminanceOf(bad), null);
  }
});

test('the tone follows the frame store: on screen with a page colour, or nothing', async () => {
  const { toneForState } = await loadTone();
  assert.equal(toneForState(ON('#0b0d1b')), 'dark');
  assert.equal(toneForState(ON('#f4f2e4')), 'light');
  // No opaque ground reported: nothing is known, so the shell's theme stands.
  assert.equal(toneForState(ON('')), null);
  // Parked (the Dev tab over the frame): the app is not what is under the bar.
  assert.equal(toneForState({ slug: 'demo', active: false, background: '#0b0d1b' }), null);
  // Empty store, and the prerendered state.
  assert.equal(toneForState({ slug: '', active: false, background: '' }), null);
  assert.equal(toneForState(null), null);
});

// ── publishing it onto the document ──────────────────────────────────────

test('the tone is the app\'s only while the router shows the app', async () => {
  // The frame stays ACTIVE when the app is left by a tab, the rail or New
  // change: only the ✕ retires it. Keyed on the frame alone, a dark app's
  // tone stayed on <html> and Messages, an agent session or Home drew the
  // dark wallpaper under the light shell's panes.
  const { toneForState, APP_SCREEN } = await loadTone();
  assert.equal(APP_SCREEN, 'app-view');
  assert.equal(toneForState(ON('#0b0d1b'), 'app-view'), 'dark');
  for (const screen of ['messages-screen', 'agent-session-screen', 'home-screen', 'workshop-screen', null]) {
    assert.equal(toneForState(ON('#0b0d1b'), screen), null, `no tone on ${screen}`);
  }
  // No router answer at all keeps the frame's own.
  assert.equal(toneForState(ON('#0b0d1b')), 'dark');
});

test('leaving the app by a tab clears the tone it left on <html>', async () => {
  const { publishAppTone, APP_TONE_ATTR } = await loadTone();
  const doc = fakeDocument();
  let applied = 0;
  const win = { Theme: { apply() { applied += 1; } } };
  const state = ON('#0b0d1b');
  assert.equal(publishAppTone(doc, state, win, false, 'app-view'), 'dark');
  assert.equal(doc.attrs.get(APP_TONE_ATTR), 'dark');
  // The Messages tab: #app-view hidden, the frame untouched and still active.
  assert.equal(publishAppTone(doc, state, win, false, 'messages-screen'), null);
  assert.equal(doc.attrs.has(APP_TONE_ATTR), false);
  assert.equal(applied, 1, 'the theme module takes the meta back');
  // Resume: the app is on screen again, and so is its tone.
  assert.equal(publishAppTone(doc, state, win, false, 'app-view'), 'dark');
  assert.equal(doc.attrs.get(APP_TONE_ATTR), 'dark');
});

test('the frame host and the theme listener both read the revealed screen', () => {
  const host = read('frontend/src/features/app-frame/app-frame.tsx');
  assert.match(host, /import \{ navStore \} from '\.\.\/nav\/nav-store\.js';/);
  assert.match(host, /const \{ screen \} = useStoreState\(navStore\)/);
  const mount = read('frontend/src/features/app-frame/mount.ts');
  assert.match(mount, /import \{ navStore \} from '\.\.\/nav\/nav-store\.js';/);
  // The router publishes the revealed screen on every swap, the ✕ included.
  const app = read('public/js/app.js');
  assert.match(app, /window\.UsernodeReact\?\.nav\?\.setScreen\?\.\(\s*screen,/);
});

test('publishAppTone writes the attribute and the theme-color meta, and clears both', async () => {
  const { publishAppTone, APP_TONE_ATTR, TONE_GROUND } = await loadTone();
  assert.equal(APP_TONE_ATTR, 'data-app-tone');
  const doc = fakeDocument();
  let applied = 0;
  const win = { Theme: { apply() { applied += 1; doc.metaAttrs.set('content', 'shell'); } } };

  assert.equal(publishAppTone(doc, ON('#0b0d1b'), win), 'dark');
  assert.equal(doc.attrs.get('data-app-tone'), 'dark');
  assert.equal(doc.metaAttrs.get('content'), TONE_GROUND.dark);

  // Same tone again: idempotent, no writes.
  doc.metaAttrs.set('content', 'untouched');
  assert.equal(publishAppTone(doc, ON('#101010'), win), 'dark');
  assert.equal(doc.metaAttrs.get('content'), 'untouched', 'a repeat of the same tone touches nothing');

  // The app flips to light: attribute and meta follow.
  assert.equal(publishAppTone(doc, ON('#fafafa'), win), 'light');
  assert.equal(doc.attrs.get('data-app-tone'), 'light');
  assert.equal(doc.metaAttrs.get('content'), TONE_GROUND.light);

  // Parked: attribute goes, and the meta is handed back to the theme module.
  assert.equal(publishAppTone(doc, { slug: 'demo', active: false, background: '#fafafa' }, win), null);
  assert.equal(doc.attrs.has('data-app-tone'), false);
  assert.equal(applied, 1);
  assert.equal(doc.metaAttrs.get('content'), 'shell');

  // Clearing an already-clear document is a no-op: the cold page never calls
  // Theme.apply from here.
  assert.equal(publishAppTone(doc, { slug: '', active: false, background: '' }, win), null);
  assert.equal(applied, 1);
});

test('publishAppTone survives a document with no meta, no Theme, or no root', async () => {
  const { publishAppTone } = await loadTone();
  const doc = fakeDocument({ withMeta: false });
  assert.equal(publishAppTone(doc, ON('#0b0d1b'), {}), 'dark');
  assert.equal(doc.attrs.get('data-app-tone'), 'dark');
  assert.equal(publishAppTone(doc, ON(''), {}), null);
  assert.equal(doc.attrs.has('data-app-tone'), false);
  assert.equal(publishAppTone(doc, ON(''), undefined), null);
  assert.equal(publishAppTone({ documentElement: null }, ON('#0b0d1b'), {}), 'dark');
  assert.equal(publishAppTone(null, ON('#0b0d1b'), {}), 'dark');
});

test('force re-asserts the meta after the theme module rewrote it', async () => {
  const { publishAppTone, TONE_GROUND } = await loadTone();
  const doc = fakeDocument();
  publishAppTone(doc, ON('#0b0d1b'), {});
  // Theme.apply() ran (the viewer toggled the shell's mode) and put the
  // shell's colour back on the meta.
  doc.metaAttrs.set('content', '#f4f2e4');
  publishAppTone(doc, ON('#0b0d1b'), {}, true);
  assert.equal(doc.metaAttrs.get('content'), TONE_GROUND.dark);
  // Force with no tone is still just a clear.
  let applied = 0;
  publishAppTone(doc, ON(''), { Theme: { apply() { applied += 1; } } }, true);
  assert.equal(doc.attrs.has('data-app-tone'), false);
  assert.equal(applied, 1);
});

test('the tone grounds match the head module\'s', async () => {
  const { TONE_GROUND } = await loadTone();
  const head = read('frontend/src/head.html');
  const m = /const GROUND = \{ light: '(#[0-9a-f]{6})', dark: '(#[0-9a-f]{6})' \};/.exec(head);
  assert.ok(m, 'head.html declares GROUND');
  assert.deepEqual(TONE_GROUND, { light: m[1], dark: m[2] });
});

// ── the wiring ───────────────────────────────────────────────────────────

test('the frame host publishes the tone from an effect on the store', () => {
  const src = read('frontend/src/features/app-frame/app-frame.tsx');
  assert.match(src, /import \{ publishAppTone \} from '\.\/app-tone\.js';/);
  assert.match(src, /useEffect\(\(\) => \{\s*publishAppTone\(document, state, window, false, screen\);\s*\}, \[state\.slug, state\.active, state\.background, screen\]\);/,
    'a plain useEffect keyed on slug, active and background');
  assert.doesNotMatch(src, /useIsomorphicLayoutEffect\(\(\) => \{\s*publishAppTone/,
    'never a layout effect: the tone is a repaint, and it must not run in the prerender');
});

test('mount.ts re-publishes with force on every theme change', () => {
  const src = read('frontend/src/features/app-frame/mount.ts');
  assert.match(src, /import \{ publishAppTone \} from '\.\/app-tone\.js';/);
  assert.match(src, /Theme\?\.onChange\?\.\(\(\) => \{\s*publishAppTone\(document, appFrameStore\.get\(\), window, true, navStore\.get\(\)\.screen\);/);
});

test('the shipped document carries no tone', () => {
  const { shellMarkup } = require('./lib/shell-markup');
  const html = shellMarkup();
  assert.doesNotMatch(html, /data-app-tone/, 'the prerender never sets it; the effect does, in the browser');
});

test('app.css keys the wallpaper and the bar\'s tokens off the tone beside .dark', () => {
  const css = read('public/css/app.css');
  const ROOTS = 'body:has(:is(#home-screen, #app-view, ';
  // Both dark wallpaper rules (phone and the 640px layer set) fire for the
  // dark shell unless a light app is on screen, and for a dark app always.
  const dark = css.split(`:is(.dark:not([data-app-tone="light"]), [data-app-tone="dark"]) ${ROOTS}`);
  assert.equal(dark.length, 3, 'exactly two dark wallpaper rules take the tone');
  assert.doesNotMatch(css, new RegExp(`\\n\\s*\\.dark ${ROOTS.replace(/[()#.,*+?^$|[\]\\]/g, '\\$&')}`),
    'no dark wallpaper rule is left keyed on .dark alone');
  // The brand tokens and the sheet edge move with the ground, scoped to the
  // bar and the sheet — never to <html>, so the shell's theme stays its own.
  for (const sel of [
    '[data-app-tone="dark"]:not(.dark) #platform-header,\n[data-app-tone="dark"]:not(.dark) #app-frame-host {',
    '.dark[data-app-tone="light"] #platform-header,\n.dark[data-app-tone="light"] #app-frame-host {',
  ]) {
    const at = css.indexOf(sel);
    assert.ok(at > 0, `app.css has ${sel.split('\n')[0]}`);
    const block = css.slice(at, css.indexOf('}', at));
    for (const token of [
      '--brand-ink', '--brand-tint', '--brand-line',
      '--app-sheet-line', '--app-sheet-shadow-near', '--app-sheet-shadow-far',
      // #2704: the ground was repainted page-wide while the ink and the
      // surfaces stayed on the shell's theme, which is what made a toned
      // strip a hybrid rather than a dark one.
      '--text-primary', '--text-secondary', '--text-muted', '--text-faint',
      '--bg-primary', '--bg-secondary', '--border', '--border-light',
    ]) {
      assert.ok(block.includes(token + ':'), `${sel.split('\n')[0]} sets ${token}`);
    }
  }
  // The dark-tone tokens are the .dark values and the light-tone tokens the
  // :root values, so a toned bar is byte-identical to a themed one.
  const value = (block, token) => new RegExp(`${token}: ([^;]+);`).exec(block)[1];
  const darkAt = css.indexOf('\n.dark {');
  const rootBlock = css.slice(0, darkAt);
  const darkBlock = css.slice(darkAt, css.indexOf('\n}', darkAt));
  const toneDark = css.slice(css.indexOf('[data-app-tone="dark"]:not(.dark) #platform-header,'));
  const toneLight = css.slice(css.indexOf('.dark[data-app-tone="light"] #platform-header,'));
  for (const token of [
    '--brand-ink', '--brand-tint', '--brand-line', '--app-sheet-line',
    '--text-primary', '--text-secondary', '--text-muted', '--text-faint',
    '--bg-primary', '--bg-secondary', '--border', '--border-light',
  ]) {
    assert.equal(value(toneDark, token), value(darkBlock, token), `${token} dark tone = .dark`);
    assert.equal(value(toneLight, token), value(rootBlock, token), `${token} light tone = :root`);
  }
  assert.doesNotMatch(css, /\[data-app-tone="dark"\]:not\(\.dark\)\s*\{/, 'nothing is set on <html> itself');
  // The body's own ink is `text-zinc-900 dark:text-zinc-100`, a utility keyed
  // on .dark rather than a token, so it cannot ride the ramp — the tone
  // re-inks it by hand with the literal the theme resolves to, exactly as it
  // does the chip's subtitle.
  assert.match(toneDark.slice(0, 400), /\n  color: #eaeaea;/, 'the dark tone carries the body\'s dark ink');
  assert.match(toneLight.slice(0, 400), /\n  color: #1c1c1e;/, 'the light tone carries the body\'s light ink');
  // .app-icon-tile is the one surface dark mode moves with a CLASS rule
  // (--bg-primary is near-black, so the tile steps UP to --bg-secondary and
  // its ring DOWN to --border) — under a tone that step needs its own twin,
  // or the app's icon stays a white square on the night cover.
  for (const [sel, bg, border] of [
    ['[data-app-tone="dark"]:not(.dark) #app-frame-host .app-icon-tile', '--bg-secondary', '--border'],
    ['.dark[data-app-tone="light"] #app-frame-host .app-icon-tile', '--bg-primary', '--border-light'],
  ]) {
    const at = css.indexOf(sel + ' {');
    assert.ok(at > 0, `app.css has ${sel}`);
    const block = css.slice(at, css.indexOf('}', at));
    assert.match(block, new RegExp(`background-color: var\\(${bg}\\);`), `${sel} faces ${bg}`);
    assert.match(block, new RegExp(`border-color: var\\(${border}\\);`), `${sel} rings ${border}`);
  }
});

test('the sidebar beside the app takes the tone too, with the theme\'s own values', () => {
  // On a desktop the rail stays docked beside a running app, so it is part of
  // the strip around it. With the shell's tokens it drew a pale column (a
  // white half-fill over the toned, night wallpaper) beside a dark bar.
  //
  // A DARK APP under the light shell puts `.dark` on the rail and its parked
  // foot, as on the sheets over a dark app (lib/surface-tone.ts, #2803), so
  // the theme's own dark palette draws them and nothing is restated.
  const surfaces = read('frontend/src/lib/surface-tone.ts');
  assert.match(surfaces, /IN_TREE_SURFACES = \[[^\]]*'platform-tabs', 'platform-parked'\]/);
  // A LIGHT APP under the dark shell carries `:root`'s values, as the bar does.
  const css = read('public/css/app.css');
  const value = (block, token) => new RegExp(`${token}: ([^;]+);`).exec(block)?.[1];
  const rootBlock = css.slice(0, css.indexOf('\n.dark {'));
  const sel = '.dark[data-app-tone="light"] #platform-tabs,\n.dark[data-app-tone="light"] #platform-parked {';
  const at = css.indexOf(sel);
  assert.ok(at > 0, 'app.css carries the light tone onto the rail');
  const block = css.slice(at, css.indexOf('}', at));
  assert.match(block, /\n  color: #1c1c1e;/, 'with the body\'s light ink');
  for (const token of [
    '--text-primary', '--text-secondary', '--text-muted', '--text-faint',
    '--bg-primary', '--bg-secondary', '--border', '--border-light',
    '--app-sheet-line', '--lit-ink', '--lit-tint', '--lit-line', '--accent', '--accent-ink',
  ]) {
    assert.equal(value(block, token), value(rootBlock, token), `${token} is :root's`);
  }
  // The plane fills are declared once per theme (no-glass-one-scheme), so the
  // rail paints :root's two directly, on the desktop.
  for (const [rule, token] of [
    ['.dark[data-app-tone="light"] #platform-tabs {', '--dc-sheet-fill'],
    ['.dark[data-app-tone="light"] #platform-tabs.platform-tabs-peek {', '--dc-sheet-solid'],
  ]) {
    const r = css.indexOf(rule);
    assert.ok(r > 0, rule);
    assert.equal(/background-color: ([^;]+);/.exec(css.slice(r, css.indexOf('}', r)))[1], value(rootBlock, token),
      `${rule} paints :root's ${token}`);
    assert.doesNotMatch(css.slice(css.lastIndexOf('@media (min-width: 768px) {', r), r), /\n\}/, 'on the desktop');
  }
  const tile = css.indexOf('.dark[data-app-tone="light"] :is(#platform-tabs, #platform-parked) .app-icon-tile {');
  assert.ok(tile > 0, 'its tiles take the light face');
  assert.match(css.slice(tile, css.indexOf('}', tile)), /background-color: var\(--bg-primary\);\s*border-color: var\(--border-light\);/);
});

test('the head pins the theme from ?theme= as well as ?shot=', () => {
  const head = read('frontend/src/head.html');
  assert.match(head, /themeParam = params\.get\('theme'\)/);
  assert.match(head, /\(themeParam === 'dark' \|\| themeParam === 'light'\) \? themeParam : null/);
  // `shot` still wins when both name a mode, and nothing is stored either way.
  assert.match(head, /const PINNED = \(shot === 'dark' \|\| shot === 'light'\) \? shot\s*\n\s*: \(themeParam/);
});

test('the two screenshot states mount a frame with the page colour of that tone', () => {
  const appJs = read('public/js/app.js');
  assert.match(appJs, /if \(shot === 'app-tone-dark' \|\| shot === 'app-tone-light'\) \{/);
  assert.match(appJs, /AppView\.showAppToneShot\(tone\)/);
  const view = read('public/js/app-view.js');
  const at = view.indexOf('  showAppToneShot(tone) {');
  assert.ok(at > 0);
  const body = view.slice(at, view.indexOf('\n  },', at));
  assert.match(
    body,
    /frame\.mount\(\{ slug, cover: AppView\._coverDescriptor\(AppView\.appData\), faded: false \}\)/,
    'a pending frame WITH its launch cover (#2704): the cover is the surface whose ink the tone decides',
  );
  assert.match(body, /frame\.setBackground\?\.\(dark \? '#0b0d1b' : '#f4f2e4'\)/, 'the page colour goes through the bridge path');
  assert.doesNotMatch(body, /setSrc|\.src\s*=/, 'no document is loaded behind it');
  assert.match(body, /App\._setScreenVisible\('app-view', true\)/);
  // …and tells the nav store the app is the screen, or the tone (which now
  // needs the router's answer as well as the frame's) would never show.
  assert.match(body, /window\.UsernodeReact\?\.nav\?\.setScreen\?\.\('app-view'\)/);
});

test('dapp.json checks both tones, each under the opposite shell', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const dark = dapp.tests.find((t) => t.path === '/?shot=app-tone-dark');
  const light = dapp.tests.find((t) => t.path === '/?shot=app-tone-light&theme=dark');
  assert.ok(dark && light, 'both checks are declared');
  assert.match(dark.expectSelector, /^html\[data-app-tone="dark"\]:not\(\.dark\) body:has\(#app-frame-host:not\(\.hidden\)/);
  assert.match(light.expectSelector, /^html\.dark\[data-app-tone="light"\] body:has\(#app-frame-host:not\(\.hidden\)/);
  for (const t of [dark, light]) assert.match(t.expectSelector, /#app-iframe\) #platform-header$/);
});

// ── where the tone comes FROM: the app has to load the bridge (#2567) ─────
//
// The mechanism above is only as good as its one input. `toneForState` reads
// `background`, `background` is only ever written by the #1581 report, and
// that report is sent by public/usernode-bridge/v1/bridge.js — so an app that
// does not LOAD the bridge has no tone at all and the bar keeps the viewer's
// theme. That is what #2567 was: the scaffold every new app starts from paints
// a dark page but shipped no bridge tag, so the newest, darkest app on the
// platform was the one guaranteed to sit under a light bar. These tests pin
// the whole chain for that scaffold, because fixing either end alone is silent.

test('a report is the only way a tone is ever known', async () => {
  const { toneForState } = await loadTone();
  // Restating the contract from the consuming end: no report, no tone, at any
  // page colour the app might actually be painting.
  assert.equal(toneForState({ slug: 'demo', active: true, background: '' }), null);
  const bridge = read('public/usernode-bridge/v1/bridge.js');
  assert.match(bridge, /__usernode_background: "changed"/,
    'the bridge is what posts the report');
  // And the shell has no second source to fall back on: nothing but the
  // frame-store background feeds the tone.
  const tone = read('frontend/src/features/app-frame/app-tone.js');
  assert.match(tone, /return toneOf\(state\.background\);/);
});

test('the scaffold every new app starts from loads the bridge', () => {
  const { getTemplateFiles } = require('../src/services/template');
  const files = getTemplateFiles('My App', 'my-app-123', 'pg://x', 'secret');
  const html = files.find((f) => f.path === 'public/index.html');
  assert.ok(html, 'the scaffold ships public/index.html');
  // Comments stripped: the scaffold documents the hosted Tailwind engine by
  // showing its tag, and a commented tag loads nothing.
  const live = html.content.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(live.includes('<script src="/usernode-bridge/v1/bridge.js"></script>'),
    'index.html must load the platform bridge by its relative path');
  // Relative, never a hostname, and never a copy in the repository.
  assert.doesNotMatch(live, /<script[^>]+src="https?:\/\/[^"]*usernode-bridge/,
    'the bridge is loaded from the app\'s own origin, never a platform hostname');
  assert.ok(!files.some((f) => f.path.includes('usernode-bridge')),
    'the bridge is centrally hosted and must never be vendored into a new app');
});

// #3688: the scaffold used to be a dark page whatever the viewer's theme, so
// a viewer on the light shell opening a brand-new app got a dark bar. It
// now follows the viewer's Homeroom theme (tests/new-app-theme.test.js), so
// its ground, and with it the bar's tone, is the viewer's own in both.
test('the scaffold\'s own page colour resolves to the viewer\'s tone, light or dark', async () => {
  const { toneOf, toneForState, publishAppTone, TONE_GROUND } = await loadTone();
  const { getTemplateFiles } = require('../src/services/template');
  const html = getTemplateFiles('My App', 'my-app-123', 'pg://x', 'secret')
    .find((f) => f.path === 'public/index.html').content;
  // <html> paints nothing, so the bridge reads the body: its `bg-ground` is
  // the design kit's ground token (#3737), and the colours below are that
  // token's light and dark values, the grounds a new app actually shows in
  // each theme.
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<body class="min-h-screen bg-ground text-fg">/);
  const css = getTemplateFiles('My App', 'my-app-123', 'pg://x', 'secret')
    .find((f) => f.path === 'styles/tailwind-input.css').content;
  const groundIn = (selector) => {
    const block = new RegExp(`\\n\\s*${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css);
    const [r, g, b] = /--ground:\s*(\d+) (\d+) (\d+);/.exec(block[1]).slice(1).map(Number);
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  };
  const grounds = [['light', groundIn(':root')], ['dark', groundIn('.dark')]];
  assert.deepEqual(grounds, [['light', '#fafaf9'], ['dark', '#0c0a09']]);
  for (const [theme, ground] of grounds) {
    assert.equal(toneOf(ground), theme, `the scaffold's ${theme} page is a ${theme} page`);
    // End to end through the real store shape and the real publisher.
    const state = { slug: 'my-app-123', active: true, background: ground };
    assert.equal(toneForState(state), theme);
    const doc = fakeDocument();
    assert.equal(publishAppTone(doc, state, {}), theme);
    assert.equal(doc.attrs.get('data-app-tone'), theme);
    assert.equal(doc.metaAttrs.get('content'), TONE_GROUND[theme]);
  }
});
