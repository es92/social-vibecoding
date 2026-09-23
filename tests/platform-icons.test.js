// The platform's home-screen and browser icons (scripts/generate-pwa-icons.js).
//
// What this pins is what each reader of an icon needs, because every one of
// them fails quietly — the phone just shows a worse picture:
//
//   - iOS takes <link rel="apple-touch-icon"> over the manifest and paints
//     transparent pixels black, so the touch icon is its own opaque 180px
//     file (RGB, no alpha channel at all).
//   - Android masks the `maskable` icon to its launcher shape, so that one is
//     full-bleed and opaque too.
//   - Chrome judges an installed app's icon changed by its URL, so the
//     manifest icons live in a versioned /icons/vN/ directory.
//   - The auth gate answers every non-public path with a 302 to the root, so
//     the two conventional root files must be on its public list.
//   - The per-app install page falls back to the platform icons, and keeps
//     its own copy of the list, which must not drift from the manifest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
const head = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'head.html'), 'utf8');

// Width, height and colour type straight off a PNG's IHDR chunk.
function pngHeader(file) {
  const buf = fs.readFileSync(file);
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    `${path.relative(ROOT, file)} is not a PNG`);
  assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}
const RGB = 2;

test('every manifest icon exists at the size it declares, in a versioned directory', () => {
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\/icons\/v\d+\//,
      `${icon.src}: new art goes in a new /icons/vN/ directory so installed apps notice it`);
    const [w, h] = icon.sizes.split('x').map(Number);
    const { width, height } = pngHeader(path.join(PUBLIC, icon.src));
    assert.deepEqual([width, height], [w, h], `${icon.src} declares ${icon.sizes}`);
    assert.equal(icon.type, 'image/png');
  }
});

test('the manifest carries separate any and maskable icons, at 192 and 512', () => {
  const by = (purpose, sizes) => manifest.icons.find((i) => i.purpose === purpose && i.sizes === sizes);
  assert.ok(by('any', '192x192'), 'Chrome installability wants a 192 any icon');
  assert.ok(by('any', '512x512'), 'and a 512 one');
  const maskable = by('maskable', '512x512');
  assert.ok(maskable, 'Android launchers mask the maskable icon');
  assert.ok(manifest.icons.every((i) => !/\s/.test(i.purpose)),
    '"any maskable" in one entry pads one use or crops the other');
  assert.equal(pngHeader(path.join(PUBLIC, maskable.src)).colorType, RGB,
    'the maskable icon is full-bleed: the launcher cuts the shape, not its alpha');
});

test('the head links an opaque 180px touch icon, an ICO and an SVG favicon', () => {
  assert.match(head, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.match(head, /<link rel="icon" href="\/favicon\.ico" sizes="32x32">/);
  assert.match(head, /<link rel="icon" href="\/icons\/v\d+\/icon\.svg" type="image\/svg\+xml">/);

  const touch = pngHeader(path.join(PUBLIC, 'apple-touch-icon.png'));
  assert.deepEqual([touch.width, touch.height], [180, 180]);
  assert.equal(touch.colorType, RGB, 'no alpha channel: iOS turns transparent pixels black');

  const svgHref = head.match(/href="(\/icons\/v\d+\/icon\.svg)"/)[1];
  const svg = fs.readFileSync(path.join(PUBLIC, svgHref), 'utf8');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512">/);
  assert.equal((svg.match(/<path /g) || []).length, 2, 'the H and the sparkle');
});

test('favicon.ico is an icon directory of PNG entries', () => {
  const buf = fs.readFileSync(path.join(PUBLIC, 'favicon.ico'));
  assert.equal(buf.readUInt16LE(0), 0);
  assert.equal(buf.readUInt16LE(2), 1, 'type 1 = icon');
  const count = buf.readUInt16LE(4);
  const sizes = [];
  for (let k = 0; k < count; k++) {
    const o = 6 + k * 16;
    const offset = buf.readUInt32LE(o + 12);
    assert.deepEqual([...buf.subarray(offset, offset + 4)], [0x89, 0x50, 0x4e, 0x47]);
    sizes.push(buf[o] || 256);
  }
  assert.ok(sizes.includes(16) && sizes.includes(32), `tab sizes present (got ${sizes})`);
});

test('the root icon files are public, and nothing broader was opened with them', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'middleware', 'auth.js'), 'utf8');
  const entries = [...src.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)]
    .map((x) => x[1]);
  assert.ok(entries.includes('/favicon.ico'));
  assert.ok(entries.includes('/apple-touch-icon.png'));
  assert.ok(!entries.includes('/') && !entries.includes('/favicon') && !entries.includes('/apple'),
    'whole file names only — the middleware matches by prefix');
});

test('the per-app install page borrows exactly the manifest\'s icons', () => {
  const { buildManifest, renderInstallPage } = require('../src/services/app-install-manifest');
  const borrowed = buildManifest({ slug: 'arcade', name: 'Arcade', icon_emoji: '🎮' }).icons.slice(1);
  assert.deepEqual(borrowed, manifest.icons);
  const page = renderInstallPage({ slug: 'arcade', name: 'Arcade', icon_emoji: '🎮' });
  assert.match(page, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
});

test('nothing still points at the retired unversioned icons', () => {
  assert.ok(!fs.existsSync(path.join(PUBLIC, 'icons', 'icon-192.png')), 'old files are deleted');
  const sw = require('../public/sw.js');
  for (const icon of manifest.icons) {
    assert.ok(sw.SHELL_ASSETS.includes(icon.src), `sw.js precaches ${icon.src}`);
  }
  assert.ok(!sw.SHELL_ASSETS.some((p) => /^\/icons\/icon-/.test(p)), 'and not the old ones');
});
