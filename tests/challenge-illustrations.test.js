'use strict';

// Challenge illustrations: the registry and the committed files agree, and
// every file is inert artwork.
//
// frontend/src/lib/challenge-illustrations.ts resolves a template's stored
// slug by MEMBERSHIP and builds `/illustrations/challenges/<slug>.svg` from it.
// Nothing at build time checks that the file behind that path exists, so a
// slug added without its artwork ships a broken image on every card that
// picks it, and an artwork committed without a slug is dead weight nobody can
// select. Both directions are pinned here.
//
// The files are served same-origin and drawn through `<img>`, which already
// refuses to run script or fetch from an SVG. They are still checked as though
// they were not: the same bytes open as a document when someone follows the
// URL directly, and a board export is exactly where an editor's metadata, a
// linked font or a stray handler would ride in unnoticed.
//
// The file checks read the registry as TEXT — its slug table is a plain
// object literal whose keys a pattern finds. The resolution checks import it
// through tests/lib/render-tsx.js, because what they pin is behaviour: an
// UPLOADED slug (`u-` plus 32 lowercase hex) derives its path, its tone falls
// back to gray, and anything else resolves to null rather than a guessed URL.
//
// TONES is spelled three times — the registry, Home's featured-illustration
// tones (features/home/panels/ui.tsx) and the server's list — and a tone one
// side accepts that another does not is an upload drawn on the wrong colour.
// The server lists are read as text too, matched on their array literal.
//
// Run with: node --test tests/challenge-illustrations.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = 'frontend/src/lib/challenge-illustrations.ts';
const ASSET_DIR = 'public/illustrations/challenges';
// The nine board artworks sit between 5 and 21 KB. A file several times that
// is an export that embedded something (a raster, a font) rather than paths.
const MAX_BYTES = 64 * 1024;

const REGISTRY = fs.readFileSync(path.join(ROOT, REGISTRY_PATH), 'utf8');

/** The quoted keys of the `ILLUSTRATIONS` object literal, in source order. */
function registrySlugs() {
  const start = REGISTRY.indexOf('export const ILLUSTRATIONS');
  assert.notEqual(start, -1, `${REGISTRY_PATH} no longer exports ILLUSTRATIONS`);
  const end = REGISTRY.indexOf('\n};', start);
  assert.notEqual(end, -1, 'could not find the end of the ILLUSTRATIONS literal');
  const body = REGISTRY.slice(start, end);
  return [...body.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]);
}

function assetFiles() {
  const dir = path.join(ROOT, ASSET_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.svg')).sort();
}

test('the registry lists slugs, each in the shape the server accepts', () => {
  const slugs = registrySlugs();
  assert.ok(slugs.length > 0, 'no slugs found in the ILLUSTRATIONS literal');
  assert.equal(new Set(slugs).size, slugs.length, 'a slug is listed twice');
  for (const slug of slugs) {
    assert.match(slug, /^[a-z0-9][a-z0-9-]{0,63}$/, `${slug} is not a valid illustration slug`);
  }
});

test('every registry slug has its artwork committed', () => {
  const files = new Set(assetFiles());
  for (const slug of registrySlugs()) {
    assert.ok(files.has(`${slug}.svg`),
      `${ASSET_DIR}/${slug}.svg is missing — a template picking ${slug} would render a broken image`);
  }
});

test('every committed artwork is a registry slug', () => {
  const slugs = new Set(registrySlugs());
  for (const name of assetFiles()) {
    const slug = name.slice(0, -'.svg'.length);
    assert.ok(slugs.has(slug),
      `${ASSET_DIR}/${name} is not in ILLUSTRATIONS, so no template can select it`);
  }
  for (const name of fs.readdirSync(path.join(ROOT, ASSET_DIR))) {
    assert.ok(name.endsWith('.svg'), `${ASSET_DIR}/${name} is not an .svg — only the artworks live here`);
  }
});

test('each artwork is a 64x64 SVG document and nothing more', () => {
  const files = assetFiles();
  assert.ok(files.length > 0, `no artwork found under ${ASSET_DIR}`);
  for (const name of files) {
    const rel = `${ASSET_DIR}/${name}`;
    const buf = fs.readFileSync(path.join(ROOT, rel));
    assert.ok(buf.length < MAX_BYTES, `${rel} is ${buf.length} bytes, over the ${MAX_BYTES}-byte cap`);
    const svg = buf.toString('utf8');

    const root = /^\s*(?:<\?xml[^>]*\?>\s*)?(<svg\b[^>]*>)/.exec(svg);
    assert.ok(root, `${rel} does not start with an <svg> root element`);
    assert.match(root[1], /\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${rel} root has no SVG namespace`);
    assert.match(root[1], /\sviewBox="0 0 64 64"/, `${rel} root is not viewBox="0 0 64 64"`);
    assert.match(svg, /<\/svg>\s*$/, `${rel} does not end with </svg>`);

    assert.ok(!/<script/i.test(svg), `${rel} contains a <script>`);
    assert.ok(!/<foreignObject/i.test(svg), `${rel} contains a <foreignObject>`);
    assert.ok(!/\son\w+\s*=/i.test(svg), `${rel} carries an event-handler attribute`);
    for (const m of svg.matchAll(/\s(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
      assert.match(m[1], /^#[\w.-]+$/, `${rel} links to ${m[1]} — only a local #fragment is allowed`);
    }
    for (const m of svg.matchAll(/url\(\s*["']?([^)"']*)/gi)) {
      assert.match(m[1], /^#[\w.-]+$/, `${rel} references url(${m[1]}) — only a local #fragment is allowed`);
    }
  }
});

test('the registry carries no inline artwork', () => {
  // tests/shell-icon-set.test.js reads frontend/src/** as source text, comments
  // included, and treats either spelling as an inline glyph.
  assert.ok(!REGISTRY.includes('<svg'), `${REGISTRY_PATH} contains the literal <svg`);
  assert.ok(!REGISTRY.includes(' d="M'), `${REGISTRY_PATH} contains inline path data`);
});

// ── Uploaded art and tones ────────────────────────────────────────────

const Registry = loadTsx(REGISTRY_PATH);
const HEX = '0123456789abcdef0123456789abcdef';

test('an uploaded slug resolves to its derived path, on its tone', () => {
  const art = Registry.resolveIllustration(`u-${HEX}`, 'teal');
  assert.deepEqual({ ...art }, {
    slug: `u-${HEX}`, label: '', tone: 'teal', toneClass: 'home-tone-teal',
    src: `/challenge-illustrations/${HEX}`, uploaded: true,
  });
  for (const tone of Registry.TONES) {
    assert.equal(Registry.resolveIllustration(`u-${HEX}`, tone).toneClass, `home-tone-${tone}`, `${tone} is honoured`);
  }
});

test('an uploaded slug without a known tone falls back to gray', () => {
  for (const tone of [undefined, null, '', 'magenta', 'Teal', 'home-tone-teal', 7, {}]) {
    const art = Registry.resolveIllustration(`u-${HEX}`, tone);
    assert.equal(art.tone, 'gray', `${String(tone)}: gray`);
    assert.equal(art.toneClass, 'home-tone-gray');
    assert.equal(art.src, `/challenge-illustrations/${HEX}`, 'and still draws');
  }
});

test('a built-in keeps its own tone and static path whatever tone is passed', () => {
  const art = Registry.resolveIllustration('useful-feedback', 'teal');
  assert.equal(art.tone, 'orange');
  assert.equal(art.src, '/illustrations/challenges/useful-feedback.svg');
  assert.equal(art.uploaded, false);
  assert.deepEqual(Registry.builtInIllustrations().map((a) => a.slug), registrySlugs(),
    'the gallery’s built-ins are the table, in order');
});

test('a malformed or unknown slug resolves to null, never a path', () => {
  const BAD = [
    'u-XYZ', `u-${HEX.slice(1)}`, `u-${HEX}0`, `u-${HEX.toUpperCase()}`, `U-${HEX}`, 'u-',
    `u-../${HEX}`, `../u-${HEX}`, `u-${HEX}/`, `u-${HEX}.svg`, `u-${HEX.slice(0, 31)}g`,
    '../../etc/passwd', 'not-in-the-registry', 'Useful-Feedback', '', null, undefined, 42,
  ];
  for (const slug of BAD) {
    assert.equal(Registry.resolveIllustration(slug, 'teal'), null, `${String(slug)} draws nothing`);
  }
});

/** The quoted strings of the first `TONES = [ ... ]` array literal in `src`. */
function tonesLiteral(src) {
  const m = /\bTONES\s*=\s*\[([\s\S]*?)\]/.exec(src);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
}

test('TONES agree across the registry, Home and the server', () => {
  const client = [...Registry.TONES];
  assert.equal(client.length, 12, 'twelve harmonic tones');
  assert.deepEqual(tonesLiteral(REGISTRY), client, 'the text literal is what the module exports');
  for (const tone of client) {
    assert.equal(Registry.TONE_CLASS[tone], `home-tone-${tone}`, `${tone} has its complete class literal`);
    assert.ok(Registry.isTone(tone));
  }

  const home = fs.readFileSync(path.join(ROOT, 'frontend/src/features/home/panels/ui.tsx'), 'utf8');
  assert.deepEqual(tonesLiteral(home), client, 'features/home/panels/ui.tsx TONES');

  const appIllustrations = fs.readFileSync(path.join(ROOT, 'src/routes/app-illustrations.js'), 'utf8');
  assert.deepEqual(tonesLiteral(appIllustrations), client, 'src/routes/app-illustrations.js TONES');

  // The upload routes validate the tone an admin picks. They either spell the
  // list or take it from app-illustrations.js; both are the same list then.
  // They ship in the same change, so their absence fails rather than skips.
  const uploadRoutes = path.join(ROOT, 'src/routes/topochain/challenge-illustrations.js');
  assert.ok(fs.existsSync(uploadRoutes), 'src/routes/topochain/challenge-illustrations.js exists');
  const routes = fs.readFileSync(uploadRoutes, 'utf8');
  const own = tonesLiteral(routes);
  if (own) {
    assert.deepEqual(own, client, 'src/routes/topochain/challenge-illustrations.js TONES');
  } else {
    assert.match(routes, /\bTONES\b[\s\S]*require\(['"]\.\.\/app-illustrations(?:\.js)?['"]\)|require\(['"]\.\.\/app-illustrations(?:\.js)?['"]\)[\s\S]*\bTONES\b/,
      'the upload routes spell no TONES literal, so they must take the list from app-illustrations.js');
  }
});
