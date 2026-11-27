// Contracts for the shell's COMPILED Tailwind stylesheet + vendored libs.
//
// Background: public/index.html used to load Tailwind's Play CDN, which
// compiled utilities in the browser on every page load and would generate
// CSS for any class it saw at runtime. Dockerfile now compiles the stylesheet
// in a disposable builder stage for every image and copies only the result
// into the production runtime. public/css/tailwind.css is generated and
// gitignored, never committed.
//
// This file performs the same fresh compile into a temporary directory, then
// pins the properties that make the image-build path safe:
//
//  1. LIFECYCLE — Docker builds the CSS from the checked-out sources, copies
//     it into the runtime after COPY . ., and the source artifact is ignored.
//  2. CONFIG — the platform palette and the hoverOnlyWhenSupported future
//     flag (both formerly inline in index.html) actually reached the output.
//  3. SENTINEL CLASSES — the awkward shapes the shell really uses (arbitrary
//     values, opacity modifiers, dark:/group-hover: variants) are present, so
//     a content-glob regression shows up as a failing test rather than one
//     subtly unstyled badge on one screen.
//  4. WIRING — index.html links the stylesheet AFTER the native kit and
//     app.css (the cascade position the Play CDN's appended <style> had, and
//     which app.css was authored against), references each vendored library,
//     and carries no CDN reference at all.
//  5. WHOLE LITERALS — no class attribute glues an interpolation onto a
//     utility prefix, since the extractor is a regex and cannot see those.
//
// Run with: node --test tests/tailwind-build.test.js
// (Run `npm install` at the repo root first; Tailwind is a dev dependency.)

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUTPUT_FILE = 'public/css/tailwind.css';
const BUILD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-tailwind-test-'));
const CSS_PATH = path.join(BUILD_DIR, 'tailwind.css');
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'scripts', 'build-tailwind.js'), '--output', CSS_PATH,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (err) {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const detail = err.stderr ? String(err.stderr).trim() : err.message;
  throw new Error(`fresh Tailwind compile failed: ${detail}`);
}
after(() => fs.rmSync(BUILD_DIR, { recursive: true, force: true }));

const css = fs.readFileSync(CSS_PATH, 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// Vendored third-party libs, in the load order index.html uses.
const VENDOR_FILES = [
  '/vendor/marked-15.0.12.min.js',
  '/vendor/purify-3.4.17.min.js',
];
// Vendored, but loaded by the screen that needs it, not by a tag in the
// document (request #7165; tests/shell-script-order.test.js ON_DEMAND_SCRIPTS).
const ON_DEMAND_VENDOR_FILES = [
  '/vendor/qrcode-1.0.0.min.js',
];

// The pinned Tailwind browser runtime this platform serves to CHILD APPS
// (the shell itself compiles its own stylesheet and never loads this).
// Its digest is the same one recorded in public/vendor/README.md and pinned
// in scripts/vendor-assets.js, which is what proves the bytes we hand the
// whole fleet are the ones cdn.tailwindcss.com/3.4.17 serves.
const HOSTED_TAILWIND = 'public/usernode-tailwind/v1/tailwind.js';
const HOSTED_TAILWIND_SHA384 = 'igm5BeiBt36UU4gqwWS7imYmelpTsZlQ45FZf+XBn9MuJbn4nQr7yx1yFydocC/K';

test('the build script compiles the current sources without committed artifacts', () => {
  assert.ok(css.length > 20000, `${OUTPUT_FILE} is only ${css.length} bytes`);

  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split(/\r?\n/);
  assert.ok(gitignore.includes('/public/index.html'), 'public/index.html must be gitignored');
  assert.ok(dockerignore.includes('public/index.html'),
    'public/index.html must be excluded from the Docker context');
  assert.ok(gitignore.includes(`/${OUTPUT_FILE}`), `${OUTPUT_FILE} must be gitignored`);
  assert.ok(dockerignore.includes(OUTPUT_FILE), `${OUTPUT_FILE} must be excluded from the Docker context`);
});

test('Dockerfile compiles Tailwind in a builder and copies only the output into runtime', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /FROM node:22.23.4-alpine AS css/, 'needs a named CSS builder stage');
  assert.match(dockerfile, /COPY package\.json package-lock\.json \.\//,
    'the CSS stage should use the lockfile-pinned dependency tree');
  assert.match(dockerfile, /RUN npm ci(?:\s|$)/, 'the CSS stage should install dev dependencies');
  assert.match(dockerfile, /COPY public \.\/public/, 'the CSS stage must scan public sources');
  assert.match(dockerfile, /COPY frontend \.\/frontend/, 'the CSS stage must scan frontend sources');
  assert.match(dockerfile, /RUN npm run build:css/, 'the CSS stage must run the platform compiler');
  assert.match(dockerfile,
    /COPY --from=css \/build\/public\/css\/tailwind\.css \.\/public\/css\/tailwind\.css/,
    'the runtime stage must copy in the generated stylesheet');

  const runtimeCopy = dockerfile.lastIndexOf('COPY . .');
  const generatedCopy = dockerfile.indexOf('COPY --from=css');
  assert.ok(runtimeCopy > -1 && generatedCopy > runtimeCopy,
    'the generated stylesheet must be copied after the source tree');

  const runtime = dockerfile.slice(dockerfile.indexOf('# Stage 3'));
  assert.match(runtime, /RUN npm ci --production/, 'the runtime must remain production-only');
  assert.doesNotMatch(runtime, /npm run build:css/, 'the runtime must not compile assets');
});

test('a commit id in the document adds no rule to the stylesheet', async () => {
  // Dockerfile.kubernetes compiles this stylesheet against a `dev` document and
  // only then writes the document the build serves, so that a commit which
  // left the frontend alone can reuse the compile (the GIT_SHA note in that
  // file). That is sound only while the two documents give Tailwind the same
  // classes. They differ in exactly two things, the id in
  // <meta name="platform-build"> and the /b/<id> prefix on every local script
  // and stylesheet URL, and the extractor reads those as candidates like any
  // other text. So: compile the tags that differ, both ways, and expect
  // nothing from either. Candidates never span a quote or an angle bracket,
  // which is why the tags alone stand for the whole document.
  const postcss = require('postcss');
  const tailwind = require('tailwindcss');
  const config = require('../tailwind.config.js');
  const stamp = require('../scripts/shell-stamp');
  const inputFile = path.join(ROOT, 'styles', 'tailwind-input.css');
  const input = fs.readFileSync(inputFile, 'utf8');
  const compile = async (raw) => (await postcss([
    tailwind({ ...config, content: [{ raw, extension: 'html' }] }),
  ]).process(input, { from: inputFile })).css;

  // The suite's own document may have been built under an id; take that off
  // first so every variant below starts from the same plain tags.
  const built = stamp.readBuildMeta(indexHtml);
  const plain = built && built !== 'dev' ? indexHtml.split(`/b/${built}`).join('') : indexHtml;
  const tags = plain.match(/<(?:script|link)\b[^>]*?\s(?:src|href)="\/[^"]*"[^>]*>/g) || [];
  assert.ok(tags.length >= 30, `only ${tags.length} local script and stylesheet tags found in index.html`);

  // One real class in every variant: an empty scan makes Tailwind warn, and
  // the second compile shows this comparison can tell a new rule when it sees one.
  const anchor = '<p class="hidden"></p>';
  const nothing = await compile(anchor);
  assert.notEqual(await compile(`${anchor}<p class="flex"></p>`), nothing);
  assert.equal(await compile(`${anchor}\n${tags.join('\n')}`), nothing, 'a plain asset URL compiled to a rule');
  // A full id, the short form, and ids that spell words out of hex letters.
  for (const id of ['0205380668653afb4b844ae55546df26b3d27814', '1234567', 'deadbeef', 'facade0', 'feedface', 'accede0']) {
    const scoped = stamp.prefixShellAssetUrls(tags.join('\n'), id);
    // 27 local scripts and stylesheets are scoped (the shell's 18 classic
    // scripts among them), so a floor of 25 still catches a prefix that
    // stopped applying.
    assert.equal(scoped.split(`/b/${id}/`).length - 1 >= 25, true, `the tags were not scoped for ${id}`);
    assert.equal(await compile(`${anchor}\n${stamp.formatBuildMeta(id)}\n${scoped}`), nothing,
      `the commit id ${id} compiled to a rule: the stylesheet would differ between the document Tailwind `
      + 'scanned and the one the image serves');
  }
});

test('the compiled stylesheet is substantial, not a stub', () => {
  // ~1100 distinct class tokens across the shell compile to tens of KB. A
  // near-empty file means the content globs matched nothing (e.g. a moved
  // public/js) — which would otherwise present as a totally unstyled app.
  assert.ok(css.length > 20000, `${OUTPUT_FILE} is only ${css.length} bytes — content globs likely matched nothing`);
  assert.ok(/\.dark\b/.test(css), 'expected darkMode:"class" output (.dark selectors)');
});

test('the platform palette reached the output', () => {
  // Tailwind emits palette colours as space-separated rgb triplets so the
  // opacity modifier can slot in: `rgb(11 11 12/var(--tw-bg-opacity,1))`.
  //
  // These four moved in the widget-language reskin, which is what this guard
  // is FOR: the scale keys `zinc`/`violet` are unchanged (see the long note in
  // tailwind.config.js on why they keep their names while their hues moved),
  // so nothing about a call site would reveal an accidental revert to the old
  // violet-tinted ramp. Pinning the hex is the only thing that would.
  const triplets = {
    'zinc-950 (#0b0b0c) — the dark page ground': '11 11 12',
    'zinc-100 (#eaeaea) — the light page ground cards float on': '234 234 234',
    // Corrected from the eyedropped #0a7cff: white on that is 3.93:1, so every
    // primary button in the product was a control you could see and a label
    // you could not quite read — and the same hex as INK on white failed
    // identically. #0a6ee0 clears both at 4.86. See the note beside --accent
    // in public/css/app.css.
    'violet-600 (#0a6ee0) — the accent': '10 110 224',
    'violet-400 (#5aa9ff) — the dark-mode accent': '90 169 255',
  };
  for (const [name, rgb] of Object.entries(triplets)) {
    assert.ok(css.includes(rgb), `expected platform palette colour ${name} → rgb(${rgb}) in ${OUTPUT_FILE}`);
  }
  // And the stock ramp it replaces is absent — proof `theme.extend.colors`
  // actually applied rather than the defaults silently winning.
  assert.ok(!css.includes('rgb(9 9 11'), 'stock Tailwind zinc-950 (#09090b) leaked in — is the palette override wired up?');
  // And the pre-reskin ramp is gone, not merely shadowed.
  assert.ok(!css.includes('124 58 237'), 'the pre-reskin violet accent (#7c3aed) is still compiled in');
  // The accent ramp is closed across ALL shades, not just the four the
  // pre-reskin config pinned. 280 call sites use violet-50/-100/-200/-300/
  // -800/-900/-950; while they were unpinned they rendered STOCK Tailwind
  // violet, which against a blue accent reads as stray purple.
  assert.ok(!css.includes('245 243 255'), 'stock Tailwind violet-50 (#f5f3ff) leaked in — is the accent ramp closed across every shade?');
});

test('future.hoverOnlyWhenSupported is compiled in', () => {
  // Without the flag, hover: utilities emit bare :hover rules, which stick
  // after taps on touch screens (the reason the flag was set originally).
  assert.match(css, /@media\s*\(hover:\s*hover\)/,
    'expected hover: utilities to be wrapped in an @media (hover: hover) guard');
});

test('sentinel classes used by the shell are present', () => {
  // Escaped forms as they appear in compiled CSS selectors.
  const sentinels = [
    // Arbitrary values (admin badges, mobile touch targets, modal heights).
    'text-\\[0\\.65rem\\]',
    'text-\\[11px\\]',
    'min-h-\\[44px\\]',
    'max-h-\\[70vh\\]',
    // `max-w-[85vw]` was here and is gone with its only caller — the
    // hamburger drawer's panel. A sentinel for a utility nothing uses stops
    // proving the extractor works and starts proving it compiles dead CSS.
    'min-w-\\[1\\.1rem\\]',
    // Opacity-modifier colours (status chips, focus rings).
    'bg-emerald-500\\/15',
    'ring-violet-500\\/40',
    // Plain palette utilities.
    'bg-violet-600',
    'text-zinc-400',
    'bg-zinc-950',
    // Variants: dark mode, hover, stacked dark+hover, focus, disabled,
    // responsive — each one used by real markup in the shell.
    'dark\\:bg-zinc-900:is(.dark *)',
    'hover\\:bg-violet-500',
    'dark\\:hover\\:bg-zinc-800',
    'focus\\:ring-violet-500',
    'disabled\\:opacity-60',
    'sm\\:col-span-2',
  ];
  for (const sentinel of sentinels) {
    assert.ok(css.includes(sentinel), `expected compiled utility for ${sentinel} in ${OUTPUT_FILE}`);
  }
});

// Cascade contract. The Play CDN did NOT inject its <style> where its
// <script> tag sat: it compiled asynchronously and then called
// `document.head.append(...)`, so the generated stylesheet always landed at
// the END of <head> — after native.css and app.css. Utilities therefore won
// every equal-specificity tie against those two, and both were authored
// against exactly that cascade.
//
// The first cut of the compiled build linked /css/tailwind.css at the TOP of
// <head> on the (wrong) assumption that the CDN injected there, which
// inverted every one of those ties. Measured in a real browser against a
// probe page reproducing the old head order, `.attr-chip` on the dev screen
// went from 10.4px/500/tinted to 16px/400/transparent, because app.css's
// `.attr-chip { font: inherit; background: none }` started outranking
// `text-[0.65rem] font-medium bg-zinc-500/10` — that is what broke the
// "Set priority" / "Set category" / "Unassigned" chips.
//
// So: the compiled stylesheet must be linked LAST.
test('index.html links the compiled stylesheet AFTER the kit and app.css', () => {
  const tailwindAt = indexHtml.indexOf('<link rel="stylesheet" href="/css/tailwind.css">');
  const kitAt = indexHtml.indexOf('href="/usernode-native/v1/native.css"');
  const appAt = indexHtml.indexOf('href="/css/app.css"');
  assert.ok(tailwindAt > -1, 'index.html must link /css/tailwind.css');
  assert.ok(kitAt > -1 && appAt > -1, 'index.html must still link the kit and app.css');
  assert.ok(tailwindAt > kitAt, '/css/tailwind.css must be linked AFTER the native kit stylesheet');
  assert.ok(tailwindAt > appAt, '/css/tailwind.css must be linked AFTER /css/app.css');
});

// The usernode-native demo page loads the same compiled stylesheet beside the
// kit's own CSS and needs the identical ordering for the identical reason.
test('the native-kit demo page links the compiled stylesheet after native.css', () => {
  const demo = fs.readFileSync(
    path.join(ROOT, 'public', 'usernode-native', 'v1', 'demo.html'), 'utf8');
  const tailwindAt = demo.indexOf('href="/css/tailwind.css"');
  const kitAt = demo.indexOf('href="./native.css"');
  assert.ok(tailwindAt > -1 && kitAt > -1, 'demo.html must link both stylesheets');
  assert.ok(tailwindAt > kitAt, '/css/tailwind.css must be linked AFTER ./native.css in demo.html');
});

// Every class name in the shell must be a COMPLETE literal in source: the
// extractor is a regex over source text, so `'bg-' + tone + '-500'` compiles
// to nothing and renders unstyled. Conditionals must pick whole strings out
// of a map/ternary. This scans the same files the content globs do and fails
// on a class attribute that glues an interpolation to a class-name fragment.
test('no Tailwind class name is assembled from fragments at runtime', () => {
  const scanned = [
    path.join(ROOT, 'public', 'index.html'),
    path.join(ROOT, 'public', 'usernode-native', 'v1', 'demo.html'),
  ];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) scanned.push(p);
    }
  })(path.join(ROOT, 'public', 'js'));

  // A Tailwind utility prefix glued directly to an interpolation, e.g.
  // class="bg-${tone}-500" or class="${size}:hidden". App-defined hook
  // classes (`gc-vote-btn-yes${...}`) are fine — they're styled by app.css,
  // not compiled — so only the known utility prefixes are flagged.
  const UTILITY = '(?:bg|text|border|ring|shadow|from|via|to|w|h|min-w|min-h|max-w|max-h'
    + '|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|grid-cols|grid-rows|col-span|row-span'
    + '|space-x|space-y|rounded|opacity|z|inset|translate|scale|rotate|leading|tracking'
    + '|font|basis|order|duration|delay|divide|fill|stroke|blur|line-clamp|animate)';
  const glued = new RegExp(`\\b${UTILITY}-\\$\\{`);
  const offenders = [];
  for (const file of scanned) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/class=(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
      const value = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
      if (glued.test(value)) offenders.push(`${path.relative(ROOT, file)}: ${value.slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, [],
    'these class attributes build a utility name from fragments, which the '
    + 'compiler cannot see — pick whole class strings out of a map or ternary');
});

test('index.html loads nothing from a CDN and has no inline config left', () => {
  // Scoped to ASSET-loading tags: not the whole file (the comments recording
  // what these tags replaced would trip it) and not <a href>, since outbound
  // hyperlinks to third parties are entirely fine — it's fetched subresources
  // that must be same-origin.
  for (const m of indexHtml.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
    assert.ok(!/^https?:\/\//.test(m[1]), `index.html still loads an off-origin asset: ${m[1]}`);
  }
  assert.ok(!/tailwind\.config\s*=/.test(indexHtml),
    'the inline tailwind.config must live in tailwind.config.js — an inline one is dead code now');
});

test('every vendored library is referenced and present on disk', () => {
  for (const rel of VENDOR_FILES) {
    assert.ok(indexHtml.includes(`src="${rel}"`), `index.html should load ${rel}`);
    const file = path.join(ROOT, 'public', rel.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `${rel} is referenced but ${file} doesn't exist — run \`npm run vendor:assets\``);
    assert.ok(fs.statSync(file).size > 1000, `${rel} looks truncated`);
  }
  for (const rel of ON_DEMAND_VENDOR_FILES) {
    assert.ok(!indexHtml.includes(`src="${rel}"`), `index.html should not load ${rel} at boot`);
    const file = path.join(ROOT, 'public', rel.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `${file} doesn't exist — run \`npm run vendor:assets\``);
    assert.ok(fs.statSync(file).size > 1000, `${rel} looks truncated`);
  }
  // Provenance for the SRI hashes the same-origin tags can no longer carry.
  const readme = path.join(ROOT, 'public', 'vendor', 'README.md');
  assert.ok(fs.existsSync(readme), 'public/vendor/README.md (provenance) is missing');
  const provenance = fs.readFileSync(readme, 'utf8');
  for (const rel of [...VENDOR_FILES, ...ON_DEMAND_VENDOR_FILES]) {
    assert.ok(provenance.includes(path.basename(rel)), `README.md should record provenance for ${rel}`);
  }
});

// The vendored bytes are what the browser actually runs, and dropping the
// `integrity` attributes means nothing verifies them at load time any more.
// This is the replacement check: the file on disk must hash to the digest
// its own provenance row claims. It catches a hand-patched vendored library,
// a half-finished version bump, and a README that has drifted away from the
// bytes beside it (which is exactly how this file first went stale — the
// generator was edited after it had already been run).
test('each vendored library matches the sha384 recorded in its provenance row', () => {
  const provenance = fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'README.md'), 'utf8');
  for (const rel of [...VENDOR_FILES, ...ON_DEMAND_VENDOR_FILES]) {
    const name = path.basename(rel);
    // Row shape: | `file` | `pkg` | version | `src path` | `sha384` | size |
    const row = provenance.split('\n').find((l) => l.startsWith(`| \`${name}\``));
    assert.ok(row, `README.md has no provenance row for ${name}`);
    const digest = row.split('|')[5].trim().replace(/`/g, '');
    assert.match(digest, /^[A-Za-z0-9+/]{60,}={0,2}$/, `${name}: provenance row has no sha384 digest`);
    const actual = crypto.createHash('sha384')
      .update(fs.readFileSync(path.join(ROOT, 'public', rel.replace(/^\//, ''))))
      .digest('base64');
    assert.equal(actual, digest,
      `${name} does not match its recorded sha384 — re-run \`npm run vendor:assets\` `
      + '(or, if the file was edited by hand, restore it: vendored copies are verbatim upstream)');
  }
});

// Same guarantee for the runtime we serve to every child app, and it matters
// more here: this file is fetched from a URL rather than copied out of
// node_modules, so a truncated download or an upstream swap would otherwise
// be invisible. The digest is asserted against a literal in this file (not
// just the README) so both the artifact and its provenance must move together.
test('the hosted Tailwind runtime matches its pinned digest', () => {
  const file = path.join(ROOT, HOSTED_TAILWIND);
  assert.ok(fs.existsSync(file),
    `${HOSTED_TAILWIND} is missing — run \`npm run vendor:assets\` (it fetches this one over the network)`);
  const bytes = fs.readFileSync(file);
  const actual = crypto.createHash('sha384').update(bytes).digest('base64');
  assert.equal(actual, HOSTED_TAILWIND_SHA384,
    `${HOSTED_TAILWIND} does not match the pinned Tailwind 3.4.17 digest. `
    + 'Re-run `npm run vendor:assets`; do not update the digest without checking why upstream moved.');

  // Verbatim upstream: the bundle reads the inline tailwind.config an app
  // sets beside the tag, which is what makes a CDN swap behaviour-identical.
  assert.ok(bytes.includes('tailwind.config'), 'the runtime should still read the inline tailwind.config global');

  const provenance = fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'README.md'), 'utf8');
  assert.ok(provenance.includes('/usernode-tailwind/v1/tailwind.js'),
    'README.md should record where the hosted runtime is served');
  assert.ok(provenance.includes(HOSTED_TAILWIND_SHA384),
    'README.md should record the hosted runtime digest');
});

// The auth gate runs before express.static, so a path that isn't allowlisted
// gets a redirect-to-root HTML body where a script was expected. Child apps
// fetch this cross-origin with no platform session, so the whole app would
// render unstyled. /vendor/ hit exactly this during the shell work.
test('the hosted Tailwind path is publicly fetchable', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'middleware', 'auth.js'), 'utf8');
  const block = src.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(block, 'PUBLIC_PATHS array found');
  const entries = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(entries.includes('/usernode-tailwind/'),
    'PUBLIC_PATHS must allowlist /usernode-tailwind/ so apps can load it without a session');

  // Tests (this one and tests/history.test.js) read this array by regex, so a
  // quoted string inside a COMMENT is indistinguishable from a real entry.
  // Apostrophes in prose already produce such fragments; they are harmless
  // because they are not paths. What must never appear is a fragment that
  // reads as an over-broad prefix — a bare "/" would make every route look
  // public to any check built on this parse.
  const pathLike = entries.filter((e) => e.startsWith('/'));
  assert.ok(!pathLike.includes('/'),
    'a quoted bare "/" in PUBLIC_PATHS (entry or comment) reads as an allowlist of every route');
  assert.ok(pathLike.length >= 10, 'expected the real path entries to parse out of PUBLIC_PATHS');
});

test('vendored tags carry no integrity/crossorigin attributes', () => {
  // SRI is meaningless same-origin, and a stale hash would break the shell.
  for (const m of indexHtml.matchAll(/<script[^>]+src="\/vendor\/[^"]+"[^>]*>/g)) {
    assert.ok(!/integrity=/.test(m[0]), `same-origin vendor tag should not carry integrity: ${m[0]}`);
    assert.ok(!/crossorigin=/.test(m[0]), `same-origin vendor tag should not carry crossorigin: ${m[0]}`);
  }
});
