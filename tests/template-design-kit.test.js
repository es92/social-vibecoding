'use strict';

// #3737 (Rec2): the Empty starter, which every new app's first version is
// built from, is a small design system rather than a bare placeholder. The
// taste benchmark judged first versions built from the old starter and
// found low-contrast text in every app, blank or dishonest loading and error
// states, small tap targets and the usual tells. What is pinned here:
//
//   1. COLOUR TOKENS. The shared stylesheet defines a small set of semantic
//      tokens for the light and the dark look, and every text pair they are
//      meant for passes WCAG AA (4.5:1) in both, computed from the values
//      the starter actually renders with the benchmark's own arithmetic.
//      tailwind.config.js names exactly those tokens through theme.extend,
//      so the stock palettes still exist.
//   2. COMPONENTS. A few, on the tokens: 44 px buttons and fields, a list,
//      a card, a sentence-case section label, a 4-step type scale, and the
//      loading, empty and error states.
//   3. THE SCREEN uses only the kit: no hex, no stock palette, no stock
//      size, none of the tells the benchmark's lint counts; and since
//      #4047 it loads no data at all, so it ships no loading, empty or
//      error state and no script of its own.
//   4. CLAUDE.md has a "## Design" section the first build fills in.
//
// Only newly created repositories get this; existing apps keep what they
// have. The rendered page's own measurements (contrast, tap targets) are
// tests/bench-capture-run.test.js, which runs the benchmark's capture.
//
// Run with: node --test tests/template-design-kit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const appTemplates = require('../src/services/app-templates');
const { getTemplateFiles } = require('../src/services/template');
const capture = require('../worker/usernode-bench-capture');

function generate(template = null) {
  return getTemplateFiles('Demo <App>', 'demo-app-abc123', 'postgres://x', null, { template });
}
const file = (files, p) => {
  const found = files.find((f) => f.path === p);
  assert.ok(found, `${p} is generated`);
  return found.content;
};
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── 1. Colour tokens ─────────────────────────────────────────────────────

const TOKENS = ['ground', 'surface', 'raised', 'fg', 'muted', 'line', 'accent', 'on-accent', 'danger', 'on-danger', 'focus'];

/** { light: { name: {r,g,b,a} }, dark: {...} } from the stylesheet's :root and .dark blocks. */
function tokensOf(css) {
  const body = stripComments(css);
  const block = (selector) => {
    const m = new RegExp(`(?:^|\\n)\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(body);
    assert.ok(m, `the stylesheet sets the tokens on ${selector}`);
    const out = {};
    for (const [, name, value] of m[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      const channels = value.trim().split(/\s+/).map(Number);
      assert.equal(channels.length, 3, `--${name} is "R G B"`);
      assert.ok(channels.every((c) => Number.isInteger(c) && c >= 0 && c <= 255), `--${name}: ${value}`);
      out[name] = { r: channels[0], g: channels[1], b: channels[2], a: 1 };
    }
    return out;
  };
  return { light: block(':root'), dark: block('.dark') };
}

// [text, background, minimum]: what each token is meant to be read on.
// Text is WCAG AA for body text; the focus ring is a non-text indicator
// (WCAG 1.4.11, 3:1) against what it is drawn on.
const PAIRS = [
  ['fg', 'ground', 4.5], ['fg', 'surface', 4.5], ['fg', 'raised', 4.5],
  ['muted', 'ground', 4.5], ['muted', 'surface', 4.5], ['muted', 'raised', 4.5],
  ['accent', 'ground', 4.5], ['accent', 'surface', 4.5],
  ['danger', 'ground', 4.5], ['danger', 'surface', 4.5],
  ['on-accent', 'accent', 4.5], ['on-danger', 'danger', 4.5],
  ['focus', 'ground', 3], ['focus', 'surface', 3],
];

test('the starter defines the colour tokens once, for both looks, as channels rather than hex', () => {
  const css = file(generate(), 'styles/tailwind-input.css');
  const looks = tokensOf(css);
  for (const look of ['light', 'dark']) {
    assert.deepEqual(Object.keys(looks[look]).sort(), [...TOKENS].sort(), `${look}: exactly the kit's tokens`);
  }
  assert.ok(css.indexOf('@tailwind utilities;') < css.indexOf(':root'), 'after the three @tailwind lines');
  assert.match(css, /@layer base \{\s*:root \{/, 'in the base layer, so it is always in the build');
  assert.match(css, /Re-theme the app HERE: change the values, keep the names\./, 'the one place to re-theme');
  // A tell the benchmark counts, and what the rule asks the app not to write.
  assert.doesNotMatch(stripComments(css), /#[0-9a-f]{3,8}\b/i, 'no hex literal');
});

test('G02: the page clears the phone\'s bottom bar, from the inset the bridge forwards', () => {
  // Overnight audit, 2 Nov 2026: in the Homeroom app on Android the
  // starter's last line sat under the system navigation bar. The frame runs
  // to the foot of the screen by design (app.css, the surface contract), and
  // a frame has no env() of its own, so the page pads by the bridge's inset.
  const css = file(generate(), 'styles/tailwind-input.css');
  const base = css.slice(css.indexOf('@layer base {'), css.indexOf('@layer components {'));
  assert.match(base, /\n  body \{\n    padding-bottom: var\(--un-safe-inset-bottom, env\(safe-area-inset-bottom, 0px\)\);\n  \}/);
});

test('every text pair the tokens are meant for passes WCAG AA in both looks', () => {
  const math = capture.colorMath();
  const looks = tokensOf(file(generate(), 'styles/tailwind-input.css'));
  const failures = [];
  for (const look of ['light', 'dark']) {
    for (const [fg, bg, need] of PAIRS) {
      const ratio = math.ratio(looks[look][fg], looks[look][bg]);
      if (!(ratio >= need)) failures.push(`${look}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${need}:1`);
    }
  }
  assert.deepEqual(failures, []);
  // The arithmetic is the benchmark's, and it is right.
  assert.equal(Math.round(math.ratio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }) * 100) / 100, 21);
  assert.equal(Math.round(math.ratio({ r: 118, g: 118, b: 118 }, { r: 255, g: 255, b: 255 }) * 100) / 100, 4.54);
});

test('the pair check catches a palette that regresses', () => {
  const math = capture.colorMath();
  const css = file(generate(), 'styles/tailwind-input.css').replace(/--muted: [\d ]+;/, '--muted: 161 161 170;');
  const looks = tokensOf(css);
  assert.ok(math.ratio(looks.light.muted, looks.light.surface) < 4.5, 'a pale grey helper text on white is caught');
});

/** The generated tailwind.config.js, evaluated as the app's build would. */
function configOf(files) {
  const mod = { exports: {} };
  vm.runInNewContext(file(files, 'tailwind.config.js'), { module: mod, exports: mod.exports });
  return mod.exports;
}

test('tailwind.config.js names the tokens through theme.extend, so the stock palettes stay', () => {
  const files = generate();
  const cfg = configOf(files);
  assert.equal(cfg.darkMode, 'class', 'dark stays the class the theme script sets');
  assert.equal(cfg.theme.colors, undefined, 'extends the palette rather than replacing it');
  assert.deepEqual(Object.keys(cfg.theme.extend.colors).sort(), [...TOKENS].sort());
  for (const name of TOKENS) {
    assert.equal(cfg.theme.extend.colors[name], `rgb(var(--${name}) / <alpha-value>)`, name);
  }
  // A four-step type scale, by name.
  const sizes = cfg.theme.extend.fontSize;
  assert.deepEqual(Object.keys(sizes), ['small', 'body', 'heading', 'title']);
  const px = Object.values(sizes).map(([size]) => parseFloat(size) * 16);
  assert.deepEqual(px, [...px].sort((a, b) => a - b), 'smallest to largest');
  assert.ok(px[0] >= 14, 'the smallest is still readable on a phone');
});

// ── 2. Components ────────────────────────────────────────────────────────

/** The @apply list of each component rule in the stylesheet: { '.btn-primary': 'inline-flex ...' }. */
function componentsOf(css) {
  const layer = stripComments(css).split('@layer components {')[1];
  assert.ok(layer, 'a components layer');
  const out = {};
  for (const [, selectors, body] of layer.matchAll(/([.\w\s,-]+)\{\s*@apply ([^;]+);\s*\}/g)) {
    for (const sel of selectors.split(',').map((s) => s.trim()).filter(Boolean)) {
      out[sel] = `${out[sel] || ''} ${body.replace(/\s+/g, ' ')}`.trim();
    }
  }
  return out;
}

test('the component layer: 44 px controls, a list, a card, a label, and the three states', () => {
  const css = file(generate(), 'styles/tailwind-input.css');
  const c = componentsOf(css);
  assert.deepEqual(Object.keys(c).sort(), ['.btn-primary', '.btn-secondary', '.card', '.field', '.list', '.list-row',
    '.page-column', '.section-label', '.skeleton', '.state-empty', '.state-error'].sort());
  // App bench run 193: desktop layouts stretched across the window, and
  // loading states shaped unlike the rows they stood for.
  assert.match(c['.page-column'], /^mx-auto w-full max-w-2xl$/, 'one centred column');
  assert.match(css.replace(/\s+/g, ' '), /loading: the content's own shape, never a blank: the same list and rows at their height, with \.skeleton bars where their text goes, so nothing moves when the data arrives;/);
  for (const sel of ['.btn-primary', '.btn-secondary']) {
    assert.match(c[sel], /\bmin-h-11\b/, `${sel}: 44 px tall`);
    assert.match(c[sel], /\bmin-w-11\b/, `${sel}: and wide`);
    assert.match(c[sel], /focus-visible:ring-focus/, `${sel}: a visible focus ring`);
  }
  assert.match(c['.btn-primary'], /\bbg-accent\b.*\btext-on-accent\b/);
  assert.match(c['.field'], /\bmin-h-11\b/, 'fields are 44 px tall');
  assert.match(c['.list-row'], /\bmin-h-11\b/);
  assert.match(c['.section-label'], /\btext-small\b/);
  assert.doesNotMatch(c['.section-label'], /uppercase|tracking-/, 'sentence case, never an eyebrow');
  assert.match(c['.skeleton'], /motion-safe:animate-pulse/, 'still under reduced motion');
  assert.match(css, /Never put a card inside a card or a \.list\./);
  assert.match(css, /Never show the empty state while loading or for a failure\./);
  // Every utility a component applies is a token or a layout utility: no
  // stock palette, no hex.
  for (const [sel, list] of Object.entries(c)) {
    assert.doesNotMatch(list, STOCK_COLOUR, `${sel} uses tokens only`);
  }
  // `hidden` wins over a component's display, so el.hidden = true always hides.
  assert.match(css, /\[hidden\]:where\(:not\(\[hidden="until-found"\]\)\) \{\s*display: none !important;/);
});

test('the kit compiles: tokens in both looks, components only when used', (t) => {
  const pkg = require.resolve('tailwindcss/package.json', { paths: [path.join(__dirname, '..')] });
  const cli = path.join(path.dirname(pkg), 'lib', 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-kit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of generate()) {
    if (!/^(public\/|styles\/|tailwind\.config\.js$)/.test(f.path)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), f.content);
  }
  require('node:child_process').execFileSync(process.execPath,
    [cli, '-c', 'tailwind.config.js', '-i', 'styles/tailwind-input.css', '-o', 'out.css'], { cwd: dir, stdio: 'ignore' });
  const out = fs.readFileSync(path.join(dir, 'out.css'), 'utf8');
  assert.match(out, /:root \{\s*--ground: 250 250 249;/);
  assert.match(out, /\.dark \{\s*--ground: 12 10 9;/);
  assert.match(out, /\.bg-ground \{\s*--tw-bg-opacity: 1;\s*background-color: rgb\(var\(--ground\) \/ var\(--tw-bg-opacity, 1\)\);/);
  assert.match(out, /\.text-title \{\s*font-size: 1\.75rem;/);
  // #4047: the starter screen shows the card alone, so the build ships only
  // it; the rest of the kit stays in the input stylesheet (pinned above) and
  // compiles when the real app's screens use those components.
  assert.match(out, /\.card \{/);
  for (const sel of ['.page-column', '.btn-primary', '.btn-secondary', '.field', '.list', '.list-row',
    '.section-label', '.skeleton', '.state-empty', '.state-error']) {
    assert.doesNotMatch(out, new RegExp(`${sel.replace(/\./g, '\\.')} \\{`),
      `${sel} is unused, so it is not shipped`);
  }
});

// ── 3. The screen ────────────────────────────────────────────────────────

const STOCK_HUES = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const STOCK_COLOUR = new RegExp(`(?<![\\w-])(?:[\\w-]+:)*(?:bg|text|border|ring|ring-offset|divide|outline|from|via|to|fill|stroke|placeholder|caret|accent|decoration|shadow)-(?:(?:${STOCK_HUES})-\\d+|white|black)(?![\\w-])`);

test('the starter screen uses only the kit: tokens, the type scale, no raw hex', () => {
  const html = file(generate(), 'public/index.html');
  const body = stripComments(html.slice(html.indexOf('<body')));
  const classes = [...body.matchAll(/class="([^"]*)"|className = '([^']*)'/g)].flatMap((m) => (m[1] || m[2]).split(/\s+/));
  assert.ok(classes.length > 40, 'the screen was read');
  assert.deepEqual(classes.filter((c) => STOCK_COLOUR.test(c)), [], 'no stock palette colour');
  assert.deepEqual(classes.filter((c) => /^(?:[\w-]+:)*text-(?:(?:xs|sm|base|lg|[2-9]?xl)$|\[)/.test(c)), [],
    'no stock or arbitrary text size: the four-step scale only');
  assert.deepEqual(classes.filter((c) => /^(?:[\w-]+:)*dark:/.test(c)), [], 'the tokens carry both looks');
  assert.doesNotMatch(body, /(?<![\w&%])#[0-9a-f]{3,8}\b/i, 'no hex in the markup or its script');
  assert.match(body, /<body class="min-h-screen bg-ground text-fg">/);
});

test('the benchmark\'s tells lint finds nothing in a new app\'s source', () => {
  const tells = capture.lintTells(generate().map((f) => ({ path: f.path, text: f.content })));
  assert.ok(tells.files >= 3, 'index.html, the stylesheet and the Tailwind config are read');
  assert.equal(tells.emojiIcons.count, 0);
  assert.equal(tells.uppercaseEyebrows.count, 0, JSON.stringify(tells.uppercaseEyebrows.samples));
  assert.equal(tells.arbitraryTextSizes.count, 0);
  assert.equal(tells.hexColours.count, 0, JSON.stringify(tells.hexColours.values));
});

// The leaderboard's honest-states test (#3737) ran the demo script against
// a stand-in DOM. #4047 removed the Press! demo and with it the screen's
// only data load, so there is nothing left to run: the screen is static
// markup. The state components stay in the kit's stylesheet (pinned above)
// for the real app's first screens, and CLAUDE.md's design rules and the
// platform conventions carry the honest-states requirement to them.
test('the starter screen loads no data, so it ships no states and no script', () => {
  const html = file(generate(), 'public/index.html');
  const body = html.slice(html.indexOf('<body'));
  assert.doesNotMatch(body, /<script/, 'the body is static markup only; the head keeps the bridge, theme and forwarder scripts');
  assert.doesNotMatch(body, /fetch\(|leaderboard|press-btn|Press!/, 'no demo endpoints, ids or fetching left');
  assert.match(body, /usernode-starter-notice@1/, 'the sentinel block survives');
});

// ── 4. CLAUDE.md's design record ─────────────────────────────────────────

test('the starter\'s CLAUDE.md has a short "## Design" section the first build fills in', () => {
  const claude = file(generate(), 'CLAUDE.md');
  const start = claude.indexOf('\n## Design\n');
  assert.ok(start !== -1, 'a "## Design" section');
  assert.ok(claude.indexOf('## About Demo <App>') < start && start < claude.indexOf('## App-specific conventions'),
    'app-specific, after About');
  const section = claude.slice(start, claude.indexOf('## App-specific conventions'));
  const flat = section.replace(/\s+/g, ' ');
  // The slots.
  assert.match(flat, /\*\*Palette:\*\* _\(name the accent, any second colour and the neutrals/);
  assert.match(flat, /\*\*Signature element:\*\* _\(/);
  assert.match(flat, /\*\*Type scale:\*\* `text-title`, `text-heading`, `text-body`, `text-small`/);
  assert.match(flat, /\*\*One fixed look:\*\* _\(only for an app drawn as its own scene/);
  // The rules.
  assert.match(flat, /never a raw hex value or a stock palette class/);
  assert.match(flat, /Tap targets are at least 44 px/);
  assert.match(flat, /honest loading, empty and error states\. Never show the empty state while loading or after a failure; an error says what failed, what still works, and offers Retry\. Loading has the content's own shape \(its rows, with `skeleton` bars for their text\)\./);
  assert.match(flat, /Each screen sits in `page-column`, one centred column on a wide window\./);
  assert.match(flat, /Seed obviously fake staging demo data so the populated screen can be seen \("Staging mock data" in the platform conventions\)\./);
  assert.match(flat, /No cards in cards, no uppercase eyebrows, no emoji as icons\./);
  // Run five (13 Oct 2026, fix 7): a blank lavender square in the header.
  assert.match(flat, /A header that shows the app's own mark shows the project's icon there \(the emoji in `dapp\.json`'s `icon` block\) or no mark at all: never an empty tile, and never `brand\/icon\.png`, which the app does not serve\./);
  assert.match(flat, /The kit is in `styles\/tailwind-input\.css`/);
  assert.ok(section.trim().split('\n').length <= 40, 'short: the long form belongs in a design skill');
  assert.doesNotMatch(section, /—/, 'no em dashes: the agent copies the voice it is given');
  // The notes above it say the kit is not placeholder, and where a fixed look goes.
  assert.match(claude.replace(/\s+/g, ' '), /The design kit is not placeholder either: build the real app with it, and fill in "## Design" below\./);
  assert.match(claude.replace(/\s+/g, ' '), /both looks \(the design kit's colour tokens carry both\), unless one fixed look is the point of this app, like a game's own scene; then say so under "## Design" below\./);
});

test('a ready-made app is built on the kit too, and its notes say so', () => {
  // Evan, 8 October 2026: the ready-made apps (services/app-templates.js)
  // are drawn with the kit, so their notes carry the same "## Design"
  // section, filled in by the first change that gives one a look of its own.
  for (const id of appTemplates.READY_IDS) {
    const claude = file(generate(id), 'CLAUDE.md');
    assert.match(claude, /\n## Design\n/, id);
    const flat = claude.replace(/\s+/g, ' ');
    assert.match(flat, /The screen is built from the design kit, which is not placeholder either: keep building with it, and fill in "## Design" below with the first change that gives this app a look of its own\./, id);
    assert.match(flat, /both looks \(the design kit's colour tokens carry both\), unless one fixed look is the point of this app, like a game's own scene; then say so under "## Design" below\./, id);
    assert.ok(claude.indexOf('## About Demo') < claude.indexOf('\n## Design\n'), `${id}: app-specific, after About`);
  }
});
