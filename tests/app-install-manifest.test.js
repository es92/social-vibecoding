// Per-app home-screen install (#1508), the pure half: the manifest an app
// gets, the icon it declares, and the install page's escaping.
// src/services/app-install-manifest.js has no HTTP in it, so every shape
// here is asserted without a server; tests/app-install-route.test.js covers
// the routes that serve them.
//
// Run with: node --test tests/app-install-manifest.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const m = require('../src/services/app-install-manifest');

const ICON_ID = 'a'.repeat(32);

// A PNG's first 33 bytes: the signature, the IHDR length, the IHDR tag, then
// width and height big-endian. Everything pngDimensions() reads.
function pngHeader(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// ── pngDimensions ────────────────────────────────────────────────────

test('pngDimensions reads width and height off the IHDR chunk', () => {
  assert.deepEqual(m.pngDimensions(pngHeader(192, 192)), { width: 192, height: 192 });
  assert.deepEqual(m.pngDimensions(pngHeader(1024, 768)), { width: 1024, height: 768 });
  // The route reads a 32-byte prefix, so a prefix has to be enough.
  assert.deepEqual(m.pngDimensions(pngHeader(512, 512).subarray(0, 32)), { width: 512, height: 512 });
});

test('pngDimensions is null for anything that is not a PNG header', () => {
  // JPEG magic, then bytes that would parse as a plausible size if the
  // signature were not checked first.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
  assert.equal(m.pngDimensions(jpeg), null);
  assert.equal(m.pngDimensions(Buffer.from('GIF89a' + 'x'.repeat(30), 'latin1')), null);
  // Signature right, chunk tag wrong.
  const noIhdr = pngHeader(10, 10);
  noIhdr.write('IDAT', 12, 'latin1');
  assert.equal(m.pngDimensions(noIhdr), null);
  // Too short to carry the chunk at all.
  assert.equal(m.pngDimensions(pngHeader(10, 10).subarray(0, 20)), null);
  // Zero and out-of-spec sizes are a corrupt header, not a size.
  assert.equal(m.pngDimensions(pngHeader(0, 10)), null);
  assert.equal(m.pngDimensions(pngHeader(10, 0x80000000)), null);
  assert.equal(m.pngDimensions(null), null);
  assert.equal(m.pngDimensions('not a buffer'), null);
});

// ── buildManifest ────────────────────────────────────────────────────

test('an app with a PNG icon gets a manifest keyed to its own clean path', () => {
  const manifest = m.buildManifest(
    { slug: 'recipe-box', name: 'Recipe Box', icon_image_id: ICON_ID, icon_emoji: null },
    { iconDims: { width: 256, height: 256 }, iconType: 'image/png' },
  );
  assert.deepEqual(manifest, {
    id: '/app/recipe-box/full',
    name: 'Recipe Box',
    short_name: 'Recipe Box',
    start_url: '/app/recipe-box/full',
    scope: '/app/recipe-box/',
    display: 'standalone',
    background_color: '#f4f2e4',
    theme_color: '#f4f2e4',
    icons: [
      { src: `/app-icons/${ICON_ID}`, sizes: '256x256', type: 'image/png', purpose: 'any' },
    ],
  });
});

test('the manifest never points at the platform PWA', () => {
  // Chrome keys an installed app by id / start_url / scope. The platform's
  // own manifest has scope "/" and start_url "/"; an app's must not, or the
  // two installs collide.
  const platform = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  const manifest = m.buildManifest({ slug: 'recipe-box', name: 'Recipe Box' });
  assert.notEqual(manifest.start_url, platform.start_url);
  assert.notEqual(manifest.scope, platform.scope);
  assert.ok(manifest.start_url.startsWith(manifest.scope), 'start_url is inside the app scope');
  assert.equal(manifest.background_color, platform.background_color, 'the splash keeps the platform ground');
});

test('a description rides along only when the app has one', () => {
  assert.equal(m.buildManifest({ slug: 'a', name: 'A' }).description, undefined);
  assert.equal(m.buildManifest({ slug: 'a', name: 'A', description: '   ' }).description, undefined);
  assert.equal(m.buildManifest({ slug: 'a', name: 'A', description: ' Keeps recipes. ' }).description, 'Keeps recipes.');
});

test('a non-PNG raster icon is declared with sizes "any" and its stored type', () => {
  const { icons } = m.buildManifest(
    { slug: 'a', name: 'A', icon_image_id: ICON_ID },
    { iconDims: null, iconType: 'image/jpeg' },
  );
  assert.deepEqual(icons, [
    { src: `/app-icons/${ICON_ID}`, sizes: 'any', type: 'image/jpeg', purpose: 'any' },
  ]);
  // Unknown type (the icon header read failed): no type claimed at all.
  const unknown = m.buildManifest({ slug: 'a', name: 'A', icon_image_id: ICON_ID }).icons;
  assert.deepEqual(unknown, [{ src: `/app-icons/${ICON_ID}`, sizes: 'any', purpose: 'any' }]);
});

test('an emoji app gets an SVG tile first and the platform PNGs after it', () => {
  const { icons } = m.buildManifest({ slug: 'a', name: 'Arcade', icon_emoji: '🎮', icon_image_id: null });
  assert.equal(icons.length, 4);
  const [tile, ...rest] = icons;
  assert.equal(tile.type, 'image/svg+xml');
  assert.equal(tile.sizes, 'any');
  assert.equal(tile.purpose, 'any');
  assert.ok(tile.src.startsWith('data:image/svg+xml,'), 'the tile is a data URL');
  const svg = decodeURIComponent(tile.src.slice('data:image/svg+xml,'.length));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes('>🎮</text>'), 'the emoji is the glyph');
  assert.match(svg, /fill="#7c3aed"/, 'on the violet square');
  // The raster fallbacks are exactly the platform's own, so Chrome always
  // sees a PNG with a declared size of at least 144px.
  const platform = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  assert.deepEqual(rest, platform.icons);
  assert.ok(rest.some((i) => i.type === 'image/png' && /^(\d+)x\1$/.test(i.sizes) && parseInt(i.sizes, 10) >= 144));
});

test('with neither image nor emoji the tile is the first letter of the name', () => {
  const { icons } = m.buildManifest({ slug: 'recipe-box', name: 'recipe box' });
  const svg = decodeURIComponent(icons[0].src.slice('data:image/svg+xml,'.length));
  assert.ok(svg.includes('>R</text>'));
  assert.equal(m.iconGlyph({ name: '' }), '?');
  assert.equal(m.iconGlyph({ name: '   ' }), '?');
  assert.equal(m.iconGlyph({ name: 'x', icon_emoji: ' 🍕 ' }), '🍕');
  // By code point: a name that opens with an emoji is not cut into a lone
  // surrogate, which encodeURIComponent would refuse.
  assert.equal(m.iconGlyph({ name: '🎮 Arcade' }), '🎮');
  assert.ok(decodeURIComponent(m.buildManifest({ slug: 'a', name: '🎮 Arcade' }).icons[0].src).includes('>🎮</text>'));
});

test('a malformed icon id is treated as no image icon', () => {
  const { icons } = m.buildManifest({ slug: 'a', name: 'A', icon_image_id: '../etc/passwd' });
  assert.equal(icons[0].type, 'image/svg+xml');
  assert.ok(!JSON.stringify(icons).includes('passwd'));
});

test('short_name is the name cut to 30 characters, never splitting an emoji', () => {
  const long = 'The Extraordinarily Long Application Name';
  const manifest = m.buildManifest({ slug: 'a', name: long });
  assert.equal(manifest.name, long, 'the full name is kept');
  assert.equal(manifest.short_name, 'The Extraordinarily Long Appli');
  assert.equal(Array.from(manifest.short_name).length, m.SHORT_NAME_MAX);
  // 31 emoji: cutting at 30 UTF-16 units would land inside a surrogate pair.
  const emoji = '🎮'.repeat(31);
  const cut = m.buildManifest({ slug: 'a', name: emoji }).short_name;
  assert.equal(Array.from(cut).length, 30);
  assert.equal(cut, '🎮'.repeat(30));
  // Trailing whitespace left by the cut is dropped.
  assert.equal(m.shortName('a'.repeat(29) + ' b'), 'a'.repeat(29));
  // The slug stands in for a missing name.
  assert.equal(m.buildManifest({ slug: 'no-name', name: '' }).name, 'no-name');
});

// ── Escaping ─────────────────────────────────────────────────────────

test('escapeHtml neutralises every character that can open markup or an attribute', () => {
  assert.equal(m.escapeHtml('<script>alert("x") & \'y\'</script>'),
    '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;');
  assert.equal(m.escapeHtml(null), '');
  assert.equal(m.escapeHtml(undefined), '');
  assert.equal(m.escapeHtml(42), '42');
});

test('the emoji tile escapes its glyph inside the SVG', () => {
  const svg = decodeURIComponent(m.emojiIconDataUrl('<b>&"').slice('data:image/svg+xml,'.length));
  assert.ok(svg.includes('>&lt;b&gt;&amp;&quot;</text>'));
  assert.ok(!svg.includes('<b>'));
  // An empty glyph still draws something.
  assert.ok(decodeURIComponent(m.emojiIconDataUrl('  ')).includes('>?</text>'));
});

test('the install page escapes the name everywhere it is interpolated', () => {
  const html = m.renderInstallPage({
    slug: 'tom-jerry', name: 'Tom & Jerry <3 "cheese"', icon_emoji: '🧀', icon_image_id: null,
  });
  assert.ok(!html.includes('<3'), 'the raw name never reaches the markup');
  assert.ok(!html.includes('"cheese"'), 'nor an attribute');
  const escaped = 'Tom &amp; Jerry &lt;3 &quot;cheese&quot;';
  assert.ok(html.includes(`<title>${escaped}</title>`));
  assert.ok(html.includes(`<meta name="apple-mobile-web-app-title" content="${escaped}">`));
  assert.ok(html.includes(`data-name="${escaped}"`));
  assert.ok(html.includes(`<h1>${escaped}</h1>`));
  assert.ok(html.includes(`Add ${escaped} to your home screen to open it like an app.`));
  assert.ok(html.includes(`Back to ${escaped}</a>`));
});

test('the install page carries its own manifest link, icons and instructions', () => {
  const html = m.renderInstallPage(
    { slug: 'recipe-box', name: 'Recipe Box', icon_image_id: ICON_ID, icon_emoji: null },
    { iconUrl: `/app-icons/${ICON_ID}` },
  );
  assert.ok(html.includes('<main id="app-install"'));
  assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'));
  assert.ok(html.includes('<meta name="theme-color" content="#f4f2e4">'));
  assert.ok(html.includes('<meta name="apple-mobile-web-app-capable" content="yes">'));
  assert.ok(html.includes('<link rel="manifest" href="/app/recipe-box/manifest.webmanifest" crossorigin="use-credentials">'));
  assert.ok(html.includes(`<link rel="apple-touch-icon" href="/app-icons/${ICON_ID}">`));
  assert.ok(html.includes(`<img src="/app-icons/${ICON_ID}" alt=""`), 'the tile is the app icon');
  // No stylesheet or script is loaded from anywhere: src/ is not a Tailwind
  // content source, so the page is self-contained.
  assert.doesNotMatch(html, /<link rel="stylesheet"/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  // The four instruction states, all present and all hidden until the
  // inline script picks one.
  for (const id of ['install-ios', 'install-android', 'install-desktop', 'install-standalone']) {
    assert.match(html, new RegExp(`<section id="${id}" class="steps" hidden>`), `#${id} ships hidden`);
  }
  assert.ok(html.includes('Tap the Share button'), 'iOS: the share sheet steps');
  assert.ok(html.includes('then Add to Home Screen.'));
  assert.ok(html.includes('<button id="install-button" type="button" class="btn" hidden>Install</button>'), 'Android: the prompt button, hidden until beforeinstallprompt');
  assert.ok(html.includes('Open the browser menu and tap Add to Home screen.'), 'Android: the fallback text');
  assert.ok(html.includes('Open this page on your phone.'), 'desktop: hand it to a phone');
  assert.ok(html.includes('<button id="install-copy" type="button" class="btn">Copy link</button>'));
  assert.ok(html.includes('Recipe Box is already on your home screen.'), 'standalone: already there');
  assert.ok(html.includes('<a class="btn" href="/app/recipe-box/full">Open</a>'));
  assert.ok(html.includes('<a href="/app/recipe-box">Back to Recipe Box</a>'));
  assert.match(html, /beforeinstallprompt/, 'the script wires the install prompt');
  assert.match(html, /display-mode: standalone/, 'and detects a standalone launch');
});

test('an app without an image icon draws its emoji and offers iOS the platform icon', () => {
  const html = m.renderInstallPage({ slug: 'arcade', name: 'Arcade', icon_emoji: '🎮', icon_image_id: null });
  assert.ok(html.includes('<div class="icon"><span aria-hidden="true">🎮</span></div>'));
  assert.ok(html.includes('<link rel="apple-touch-icon" href="/apple-touch-icon.png">'));
  assert.doesNotMatch(html, /app-icons\//);
});

test('the sign-in variant names no app and sends the visitor through the shell', () => {
  const html = m.renderSignInPage('recipe-box');
  assert.ok(html.includes('id="app-install-signin"'));
  assert.ok(!html.includes('id="app-install"'), 'it is not the install page');
  assert.match(html, /Sign in to Homeroom/);
  assert.ok(html.includes('href="/app/recipe-box"'), 'the shell handles login and continues');
  assert.doesNotMatch(html, /manifest\.webmanifest/, 'no manifest link without an app');
  const missing = m.renderNotFoundPage();
  assert.match(missing, /App not found/);
  assert.ok(!missing.includes('id="app-install"'));
});

test('user-facing copy carries no em dash', () => {
  const pages = [
    m.renderInstallPage({ slug: 'a', name: 'A', icon_emoji: '🎮' }),
    m.renderSignInPage('a'),
    m.renderNotFoundPage(),
  ];
  for (const html of pages) {
    const text = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '');
    assert.doesNotMatch(text, /—|&mdash;|&#8212;/);
  }
});
