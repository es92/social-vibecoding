// The Illustration gallery on the challenge template form.
//
// WHAT THIS PINS. The form's Illustration field used to be a <select>; the
// owner asked for tiles an admin clicks, plus a way to add art (2026-09-15).
// Two things about the swap are easy to lose and invisible in a diff of class
// strings:
//
//   - It is still ONE form value. The gallery is a radio group whose checked
//     tile is the stored slug, and a stored slug the gallery does not list
//     (archived, or never drawable in this build) is still shown checked, so
//     an unrelated edit cannot save null over it.
//   - Adding and archiving are write-gated in the render, not only in the
//     handler: a view-only admin gets no Add tile and no Archive buttons.
//
// And one thing that is not about the component at all: the browser cleans an
// SVG against lib/svg-allowlist.ts, which is a mirror of the server's
// allowlist. The last test reads src/services/svg-safety.js as text and fails
// the moment the two lists drift.
//
// Effects do not run under the static renderer, so the list fetch never fires
// here; the uploaded and archived cases go through galleryTiles(), the pure
// function the component renders from.
//
// Run with: node --test tests/illustration-gallery.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const GALLERY = loadTsx('frontend/src/features/admin/topochain/illustration-gallery.tsx');
const { ILLUSTRATIONS } = loadTsx('frontend/src/lib/challenge-illustrations.ts');

const ID = 'admin-topo-tpl-f-illustration';
const HEX = 'a'.repeat(32);
const UPLOADED = `u-${HEX}`;

// Renders with AdminTopochain.canWrite() answering `write`, the way the
// console wires it, then takes the stub away again.
function render(value, { write = true } = {}) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = { AdminTopochain: { canWrite: () => write } };
  try {
    return renderToHtml(createElement(GALLERY.IllustrationGallery, { id: ID, value, onChange() {} }));
  } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
}

// Every radio tile, in order: its value, whether it is checked, whether it is
// the one Tab lands on, and its full markup.
const radiosOf = (html) => [...html.matchAll(/<button[^>]*role="radio"[^>]*>[\s\S]*?<\/button>/g)]
  .map((m) => m[0])
  .filter((b) => /data-illustration="/.test(b))
  .map((b) => ({
    value: b.match(/data-illustration="([^"]*)"/)[1],
    checked: /aria-checked="true"/.test(b),
    tabbable: /tabindex="0"/.test(b),
    html: b,
  }));

test('the gallery is a labelled radio group that keeps the field id', () => {
  const html = render('');
  assert.match(html, new RegExp(`<div id="${ID}" role="radiogroup" aria-label="Illustration"`),
    'the group carries the field id and names itself, so a label element is not needed');
  assert.ok(!/<select/.test(html), 'the dropdown is gone');
});

test('the tiles are (none) then the nine built-ins, in registry order', () => {
  const radios = radiosOf(render(''));
  assert.equal(radios.length, 10, '(none) plus nine built-ins before the list loads');
  assert.equal(radios[0].value, '');
  assert.match(radios[0].html, />\(none\)</, 'the first tile reads (none)');
  assert.deepEqual(radios.slice(1).map((r) => r.value), Object.keys(ILLUSTRATIONS));
  for (const r of radios.slice(1)) {
    assert.ok(r.html.includes(`>${ILLUSTRATIONS[r.value].label}<`), `${r.value} shows its label`);
    const img = r.html.match(/<img[^>]*>/);
    assert.ok(img, `${r.value} draws its art`);
    assert.match(img[0], new RegExp(`src="/illustrations/challenges/${r.value}\\.svg"`));
    assert.match(img[0], /class="home-tone-[a-z]+ h-16 w-16 [^"]*bg-\[var\(--tint-art\)\]/,
      'at 64px, on its own tone read through --tint-art');
  }
  assert.ok(!/<img[^>]*>/.test(radios[0].html), '(none) draws nothing');
});

test('exactly the stored value is checked, and it is where Tab lands', () => {
  for (const value of ['', 'useful-feedback']) {
    const radios = radiosOf(render(value));
    assert.deepEqual(radios.filter((r) => r.checked).map((r) => r.value), [value]);
    assert.deepEqual(radios.filter((r) => r.tabbable).map((r) => r.value), [value],
      'a roving tabindex: one tab stop for the whole group');
    const checked = radios.find((r) => r.checked);
    assert.match(checked.html, /ring-violet-500/, 'the selection is ringed');
    assert.match(checked.html, /aria-hidden="true"[^>]*>✓</, 'and carries a check mark, not colour alone');
    assert.match(checked.html, /font-semibold/, 'and a bold label');
  }
});

test('every tile is a real button at least 44px tall with a visible focus ring', () => {
  for (const r of radiosOf(render('try-three-apps'))) {
    assert.match(r.html, /^<button type="button" role="radio"/);
    assert.match(r.html, /min-h-\[44px\]/);
    assert.match(r.html, /focus-visible:outline-violet-500/);
  }
});

test('a stored slug this build cannot draw stays checked, marked Not available', () => {
  const radios = radiosOf(render('retired-art'));
  const kept = radios.find((r) => r.value === 'retired-art');
  assert.ok(kept, 'it is a tile of its own rather than collapsing to (none)');
  assert.ok(kept.checked, 'and the checked one');
  assert.match(kept.html, />retired-art</, 'under its raw value');
  assert.match(kept.html, />Not available</, 'marked');
  assert.ok(!/<img/.test(kept.html), 'with no image guessed for it');
  assert.equal(radios.length, 11);
});

test('an archived upload that is stored stays checked, marked Archived, on its tone', () => {
  const items = [
    { slug: UPLOADED, label: 'Old badge', tone: 'coral', archived: true },
    { slug: `u-${'b'.repeat(32)}`, label: 'New badge', tone: 'teal', archived: false },
  ];
  const tiles = GALLERY.galleryTiles(UPLOADED, items, UPLOADED);
  assert.deepEqual(tiles.map((t) => t.value).slice(10), [`u-${'b'.repeat(32)}`, UPLOADED],
    'live uploads follow the built-ins, and the archived stored one is kept at the end');
  const archived = tiles.find((t) => t.value === UPLOADED);
  assert.equal(archived.marker, 'Archived');
  assert.equal(archived.label, 'Old badge');
  assert.equal(archived.art.src, `/challenge-illustrations/${HEX}`, 'the path is derived from the slug');
  assert.equal(archived.art.toneClass, 'home-tone-coral');

  const notStored = GALLERY.galleryTiles('', items, '');
  assert.ok(!notStored.some((t) => t.value === UPLOADED), 'archived art that is not stored leaves the grid');
});

test('a stored upload is not called unavailable before the list has loaded', () => {
  const radios = radiosOf(render(UPLOADED));
  const kept = radios.find((r) => r.value === UPLOADED);
  assert.ok(kept && kept.checked);
  assert.ok(!/Not available|Archived/.test(kept.html), 'no marker until the list answers');
  const loaded = GALLERY.galleryTiles(UPLOADED, [], UPLOADED);
  assert.equal(loaded.find((t) => t.value === UPLOADED).marker, 'Not available',
    'but once it has and the slug is absent, it is');
});

test('the slug the form opened with survives picking something else', () => {
  const tiles = GALLERY.galleryTiles('try-three-apps', [], 'retired-art');
  assert.ok(tiles.some((t) => t.value === 'retired-art'),
    'arrowing past a kept tile does not make it impossible to pick again');
});

test('the gallery never draws a URL it was handed', () => {
  const items = [{ slug: UPLOADED, label: 'x', tone: 'blue', archived: false, src: 'https://evil.example/a.png' }];
  for (const hostile of ['https://evil.example/art.svg', 'javascript:alert(1)', '../../etc/passwd']) {
    const html = render(hostile);
    for (const [, src] of html.matchAll(/src="([^"]*)"/g)) {
      assert.match(src, /^\/illustrations\/challenges\/[a-z0-9-]+\.svg$/, `only registry paths for ${hostile}`);
    }
  }
  for (const t of GALLERY.galleryTiles('', items)) {
    if (t.art) assert.match(t.art.src, /^\/(illustrations\/challenges\/[a-z0-9-]+\.svg|challenge-illustrations\/[a-f0-9]{32})$/);
  }
});

test('the Add tile and its file chooser exist only for an admin who can write', () => {
  const writable = render('');
  assert.match(writable, new RegExp(`<button id="${ID}-add" type="button"`), 'Add illustration is offered');
  assert.match(writable, />Add illustration</);
  assert.match(writable, /<input[^>]*type="file"[^>]*accept="image\/png,image\/webp,image\/svg\+xml"/,
    'the chooser takes PNG, WebP and SVG');

  const readOnly = render('', { write: false });
  assert.ok(!readOnly.includes(`${ID}-add`), 'no Add tile for a view-only admin');
  assert.ok(!/type="file"/.test(readOnly), 'and no file input');
  assert.equal(radiosOf(readOnly).length, 10, 'but the same tiles to pick from');
});

test('no raw SVG markup reaches the page', () => {
  for (const value of ['', 'block-production', 'retired-art', UPLOADED]) {
    assert.ok(!/<svg/i.test(render(value)), `nothing inline for ${JSON.stringify(value)}`);
  }
});

test('the source takes the gate from the console and cleans with the mirrored lists', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'frontend/src/features/admin/topochain/illustration-gallery.tsx'), 'utf8');
  assert.match(src, /const canWrite = \(\) => !!topo\(\)\?\.canWrite\(\);/);
  for (const handler of ['const chooseFile = async', 'const upload = async', 'const archive = async']) {
    const body = src.slice(src.indexOf(handler), src.indexOf(handler) + 200);
    assert.match(body, /!canWrite\(\)/, `${handler} refuses a view-only admin`);
  }
  assert.match(src, /ALLOWED_TAGS: \[\.\.\.SVG_ELEMENTS\]/);
  assert.match(src, /ALLOWED_ATTR: \[\.\.\.SVG_ATTRIBUTES\]/);
  assert.match(src, /ALLOW_DATA_ATTR: false/);
  assert.match(src, /ALLOW_ARIA_ATTR: false/);
  assert.ok(!/USE_PROFILES/.test(src.replace(/^\s*\/\/.*$/gm, '')),
    'no profile: DOMPurify would replace the allowlist with its whole SVG vocabulary');
  assert.ok(!/@\/components\/ui/.test(src), 'the console does not reach for shell primitives');
});

// The server module's array literal for `name`, as a sorted list of strings.
function serverList(src, name) {
  const at = src.search(new RegExp(`\\b${name}\\s*=`));
  assert.ok(at !== -1, `svg-safety.js declares ${name}`);
  const open = src.indexOf('[', at);
  let depth = 0;
  let close = open;
  for (; close < src.length; close += 1) {
    if (src[close] === '[') depth += 1;
    else if (src[close] === ']' && --depth === 0) break;
  }
  const body = src.slice(open + 1, close).replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)]
    .flatMap((m) => (m[1] ?? m[2] ?? m[3]).split(/\s+/))
    .filter(Boolean)
    .sort();
}

test('the browser allowlist is an exact mirror of the server allowlist', () => {
  // The server validator ships in the same change, so a missing file is a
  // failure here, never a skip: a parity check that can quietly stand down is
  // how the two lists drift.
  const serverPath = path.join(ROOT, 'src/services/svg-safety.js');
  assert.ok(fs.existsSync(serverPath), 'src/services/svg-safety.js exists');
  const server = fs.readFileSync(serverPath, 'utf8');
  const client = loadTsx('frontend/src/lib/svg-allowlist.ts');
  assert.deepEqual([...client.SVG_ELEMENTS].sort(), serverList(server, 'ALLOWED_ELEMENTS'),
    'lib/svg-allowlist.ts SVG_ELEMENTS matches ALLOWED_ELEMENTS');
  assert.deepEqual([...client.SVG_ATTRIBUTES].sort(), serverList(server, 'ALLOWED_ATTRIBUTES'),
    'lib/svg-allowlist.ts SVG_ATTRIBUTES matches ALLOWED_ATTRIBUTES');
});
