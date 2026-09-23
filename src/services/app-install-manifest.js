'use strict';

// Per-app home-screen install (#1508): the web app manifest each app gets,
// and the standalone page that carries it.
//
// "Add to Home Screen" reads the manifest of the page you are LOOKING AT, so
// giving an app its own home-screen icon means giving it a document with its
// own `<link rel="manifest">`. That document is deliberately NOT the platform
// shell: swapping the shell's manifest link while an app is open would
// change what the platform's own install points at, and Chrome keys an
// installed web app by manifest id / start_url / scope, so a per-app manifest
// served from the shell with `scope: "/"` would collide with the platform
// PWA. Instead src/routes/app-install.js serves `/app/<slug>/install`, a
// small server-rendered document whose manifest is `/app/<slug>/manifest.
// webmanifest`; `/` and public/manifest.webmanifest are untouched.
//
// Everything in here is pure so the shapes can be tested without HTTP:
//
//   pngDimensions(buf)      width/height from a PNG's IHDR chunk. Chrome only
//                           counts an icon towards installability when its
//                           declared `sizes` is at least 144x144, and the
//                           app_icons table stores bytes with no dimensions.
//   emojiIconDataUrl(text)  the tile for an app with no image icon: its emoji
//                           (or first letter) on a rounded violet square.
//   buildManifest(app, …)   the manifest document.
//   renderInstallPage(…)    the install page, and its sign-in / not-found
//                           variants; every interpolated value goes through
//                           escapeHtml.
//
// The Tailwind stylesheet is compiled from public/index.html, public/js/**
// and frontend/** only, so a page rendered from src/ cannot use utilities: the
// page carries its own inline CSS, in the shell's zinc/violet palette on the
// shell's own grounds (frontend/src/head.html GROUND: #f4f2e4 / #0b0d1b).

const GROUND = '#f4f2e4';
const GROUND_DARK = '#0b0d1b';
const SHORT_NAME_MAX = 30;
const DESCRIPTION_MAX = 300;
const ICON_ID_RE = /^[a-f0-9]{32}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The platform's own raster icons, appended when an app has no image icon:
// the emoji tile is an SVG, and Chrome wants at least one PNG (or WebP) with
// a declared size of 144px or more before it treats a manifest as
// installable. Same three entries as public/manifest.webmanifest.
const PLATFORM_ICONS = Object.freeze([
  Object.freeze({ src: '/icons/v2/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }),
  Object.freeze({ src: '/icons/v2/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }),
  Object.freeze({ src: '/icons/v2/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }),
]);

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Width and height of a PNG, read straight off its IHDR chunk, or null for
 * anything that is not a PNG (or is too short to carry one). The chunk is
 * fixed by the format: 8 signature bytes, a 4-byte length, the "IHDR" tag,
 * then width and height as big-endian 32-bit integers at bytes 16..24.
 */
function pngDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  // The spec caps both at 2^31 - 1; anything else is a corrupt header.
  if (width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff) return null;
  return { width, height };
}

/** The app's tile glyph: its emoji, else the first letter of its name. */
function iconGlyph(app) {
  const emoji = typeof app?.icon_emoji === 'string' ? app.icon_emoji.trim() : '';
  if (emoji) return emoji;
  // Same fallback the home tiles draw (frontend/src/features/apps/app-card.js),
  // by code point rather than charAt: a name that opens with an emoji would
  // otherwise yield a lone surrogate, which no data URL can carry.
  const first = Array.from(String(app?.name || '').trim())[0];
  return first ? first.toUpperCase() : '?';
}

/**
 * An SVG icon as a data: URL — `text` centred on a rounded violet square.
 * Percent-encoded rather than base64 so the emoji survives verbatim and the
 * result stays readable in the manifest.
 */
function emojiIconDataUrl(text) {
  const glyph = String(text == null ? '' : text).trim() || '?';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">'
    + '<rect width="512" height="512" rx="112" fill="#7c3aed"/>'
    + '<text x="256" y="256" text-anchor="middle" dominant-baseline="central" '
    + 'font-family="-apple-system, BlinkMacSystemFont, \'Segoe UI Emoji\', \'Apple Color Emoji\', '
    + '\'Noto Color Emoji\', sans-serif" font-size="300" font-weight="700" fill="#ffffff">'
    + escapeHtml(glyph)
    + '</text></svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** `name`, cut to the 30 characters Chrome and iOS show under a tile. */
function shortName(name) {
  const chars = Array.from(String(name || '').trim());
  if (chars.length <= SHORT_NAME_MAX) return chars.join('');
  return chars.slice(0, SHORT_NAME_MAX).join('').trim();
}

function appIconId(app) {
  const id = app?.icon_image_id;
  return typeof id === 'string' && ICON_ID_RE.test(id) ? id : null;
}

/**
 * The manifest's `icons` list.
 *
 *   image icon, PNG with known dimensions  → the image, with its real sizes
 *   image icon, anything else              → the image, `sizes: "any"`
 *   no image icon                          → the emoji/letter SVG tile, then
 *                                            the platform's PNGs so Chrome
 *                                            has a raster it will accept
 *
 * `iconDims` is what pngDimensions() read for the stored bytes (null when
 * they are not a PNG), `iconType` the stored content type.
 */
function manifestIcons(app, { iconDims = null, iconType = null } = {}) {
  const id = appIconId(app);
  if (id) {
    const src = `/app-icons/${id}`;
    if (iconDims && iconDims.width > 0 && iconDims.height > 0) {
      return [{ src, sizes: `${iconDims.width}x${iconDims.height}`, type: 'image/png', purpose: 'any' }];
    }
    const icon = { src, sizes: 'any' };
    if (typeof iconType === 'string' && iconType) icon.type = iconType;
    icon.purpose = 'any';
    return [icon];
  }
  return [
    { src: emojiIconDataUrl(iconGlyph(app)), sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ...PLATFORM_ICONS.map((icon) => ({ ...icon })),
  ];
}

/**
 * The manifest for one app.
 *
 * `id`, `start_url` and `scope` are what keep an installed app distinct from
 * the platform PWA and from every other app: Chrome keys an installation by
 * id, and the scope is the app's own clean-path prefix, so a launch opens the
 * chromeless `/app/<slug>/full` view and stays inside the app's routes.
 *
 * @param {{ slug: string, name?: string, description?: string,
 *           icon_emoji?: string|null, icon_image_id?: string|null }} app
 * @param {{ iconDims?: {width:number,height:number}|null, iconType?: string|null }} [opts]
 */
function buildManifest(app, opts = {}) {
  const slug = encodeURIComponent(String(app.slug || ''));
  const name = String(app.name || '').trim() || String(app.slug || '');
  const manifest = {
    id: `/app/${slug}/full`,
    name,
    short_name: shortName(name),
  };
  const description = typeof app.description === 'string' ? app.description.trim() : '';
  if (description) manifest.description = Array.from(description).slice(0, DESCRIPTION_MAX).join('');
  manifest.start_url = `/app/${slug}/full`;
  manifest.scope = `/app/${slug}/`;
  manifest.display = 'standalone';
  manifest.background_color = GROUND;
  manifest.theme_color = GROUND;
  manifest.icons = manifestIcons(app, opts);
  return manifest;
}

// ── The page ──────────────────────────────────────────────────────────

const PAGE_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { background: ${GROUND}; }
  body {
    margin: 0; min-height: 100vh; min-height: 100dvh;
    padding: 32px 16px calc(32px + env(safe-area-inset-bottom, 0px));
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${GROUND}; color: #18181b; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 26rem; margin: 0 auto; text-align: center; }
  .icon {
    width: 96px; height: 96px; margin: 8px auto 20px; border-radius: 22px;
    overflow: hidden; display: flex; align-items: center; justify-content: center;
    background: #7c3aed; color: #fff; font-size: 52px; font-weight: 700; line-height: 1;
    box-shadow: 0 1px 2px rgba(24, 24, 27, 0.12), 0 0 0 1px rgba(24, 24, 27, 0.08);
  }
  .icon img { width: 100%; height: 100%; object-fit: cover; display: block; }
  h1 { font-size: 1.5rem; margin: 0 0 8px; font-weight: 700; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  p { margin: 0 0 12px; }
  .lead { color: #52525b; font-size: 1rem; }
  .steps { margin: 24px 0 0; padding: 20px 16px; border-radius: 16px; background: #fff;
    border: 1px solid #e4e4e7; font-size: 1rem; }
  .steps p:last-child { margin-bottom: 0; }
  .glyph { display: inline-block; vertical-align: -0.15em; width: 1.1em; height: 1.1em; }
  .btn {
    display: inline-block; margin: 8px 0 4px; padding: 12px 24px; min-height: 44px;
    border-radius: 999px; border: 0; background: #7c3aed; color: #fff;
    font: inherit; font-weight: 600; text-decoration: none; cursor: pointer;
  }
  .btn:hover { background: #6d28d9; }
  .url {
    display: block; margin: 8px 0 12px; padding: 10px 12px; border-radius: 10px;
    background: #f4f4f5; border: 1px solid #e4e4e7; color: #3f3f46;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem;
    overflow-wrap: anywhere; text-align: left;
  }
  .back { margin-top: 28px; font-size: 0.95rem; }
  a { color: #6d28d9; }
  @media (prefers-color-scheme: dark) {
    html, body { background: ${GROUND_DARK}; color: #f4f4f5; }
    .lead { color: #a1a1aa; }
    .steps { background: #18181b; border-color: #27272a; }
    .url { background: #27272a; border-color: #3f3f46; color: #d4d4d8; }
    .btn { background: #8b5cf6; }
    .btn:hover { background: #7c3aed; }
    a { color: #a78bfa; }
    .icon { box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12); }
  }
`;

// The Share glyph iOS puts in its toolbar, drawn inline so the step can point
// at the button by its picture as well as its name.
const SHARE_GLYPH = '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 3v13M7 8l5-5 5 5M5 12v7a1 1 0 001 1h12a1 1 0 001-1v-7"/></svg>';

// Picks the instructions for this browser. Classic syntax on purpose: it
// runs on whatever phone browser opened the page, and a console error on any
// route fails the platform's own proposal checks. Facts about the app come
// off the root's data-* attributes rather than being interpolated into the
// script, so nothing here is ever a script-context escape.
const PAGE_SCRIPT = `
(function () {
  var root = document.getElementById('app-install');
  if (!root) return;
  function el(id) { return document.getElementById(id); }
  function show(id) { var node = el(id); if (node) node.hidden = false; }
  var ua = navigator.userAgent || '';
  var touch = navigator.maxTouchPoints || 0;
  var standalone = false;
  try {
    standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || navigator.standalone === true;
  } catch (e) { standalone = false; }
  var ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touch > 1);
  var android = /Android/i.test(ua);

  if (standalone) { show('install-standalone'); return; }
  if (ios) { show('install-ios'); return; }

  if (android) {
    show('install-android');
    var deferred = null;
    var button = el('install-button');
    var hint = el('install-hint');
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      deferred = event;
      if (button) button.hidden = false;
      if (hint) hint.hidden = true;
    });
    window.addEventListener('appinstalled', function () {
      deferred = null;
      if (button) button.hidden = true;
      if (hint) {
        hint.textContent = root.getAttribute('data-name') + ' is on your home screen now.';
        hint.hidden = false;
      }
    });
    if (button) {
      button.addEventListener('click', function () {
        if (!deferred) return;
        var prompt = deferred;
        deferred = null;
        button.hidden = true;
        try {
          prompt.prompt();
          if (prompt.userChoice && prompt.userChoice.then) {
            prompt.userChoice.then(function (choice) {
              if (choice && choice.outcome === 'accepted') return;
              if (hint) hint.hidden = false;
            }, function () { if (hint) hint.hidden = false; });
          }
        } catch (e) {
          if (hint) hint.hidden = false;
        }
      });
    }
    return;
  }

  show('install-desktop');
  var pageUrl = location.origin + location.pathname;
  var urlNode = el('install-url');
  if (urlNode) urlNode.textContent = pageUrl;
  var copy = el('install-copy');
  if (copy) {
    var idle = copy.textContent;
    var done = function () {
      copy.textContent = 'Copied';
      setTimeout(function () { copy.textContent = idle; }, 2000);
    };
    var select = function () {
      try {
        var range = document.createRange();
        range.selectNodeContents(urlNode);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (e) { /* nothing to select */ }
    };
    copy.addEventListener('click', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pageUrl).then(done, select);
      } else {
        select();
      }
    });
  }
})();
`;

function layout({ title, head = '', body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<meta name="theme-color" content="${GROUND}">
${head}<style>${PAGE_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * The install page for an app the viewer can see.
 *
 * @param {{ slug: string, name?: string, icon_emoji?: string|null,
 *           icon_image_id?: string|null }} app
 * @param {{ iconUrl?: string|null }} [opts]  the raster icon to offer iOS as
 *        the apple-touch-icon; the app's own /app-icons/<id> when it has one.
 */
function renderInstallPage(app, { iconUrl = null } = {}) {
  const slug = encodeURIComponent(String(app.slug || ''));
  const rawName = String(app.name || '').trim() || String(app.slug || '');
  const name = escapeHtml(rawName);
  const imageId = appIconId(app);
  const touchIcon = escapeHtml(iconUrl || (imageId ? `/app-icons/${imageId}` : '/apple-touch-icon.png'));
  const tile = imageId
    ? `<img src="/app-icons/${imageId}" alt="" draggable="false">`
    : `<span aria-hidden="true">${escapeHtml(iconGlyph(app))}</span>`;

  const head = `<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${name}">
<link rel="manifest" href="/app/${slug}/manifest.webmanifest" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="${touchIcon}">
<link rel="icon" href="${touchIcon}">
`;

  const body = `<main id="app-install" data-slug="${slug}" data-name="${name}">
  <div class="icon">${tile}</div>
  <h1>${name}</h1>
  <p class="lead">Add ${name} to your home screen to open it like an app.</p>
  <section id="install-ios" class="steps" hidden>
    <p>Tap the Share button ${SHARE_GLYPH}, then Add to Home Screen.</p>
    <p class="lead">If Add to Home Screen is not in the list, open this page in Safari first.</p>
  </section>
  <section id="install-android" class="steps" hidden>
    <button id="install-button" type="button" class="btn" hidden>Install</button>
    <p id="install-hint">Open the browser menu and tap Add to Home screen.</p>
  </section>
  <section id="install-desktop" class="steps" hidden>
    <p>Open this page on your phone.</p>
    <code id="install-url" class="url"></code>
    <button id="install-copy" type="button" class="btn">Copy link</button>
  </section>
  <section id="install-standalone" class="steps" hidden>
    <p>${name} is already on your home screen.</p>
    <a class="btn" href="/app/${slug}/full">Open</a>
  </section>
  <noscript><p class="steps">Open the browser menu and tap Add to Home screen.</p></noscript>
  <p class="back"><a href="/app/${slug}">Back to ${name}</a></p>
</main>
<script>${PAGE_SCRIPT}</script>`;

  return layout({ title: rawName, head, body });
}

/**
 * The page for a visitor with no session. It names the app only by its slug
 * (the row was never looked up, so nothing about a private app is disclosed)
 * and sends them into the shell's own `/app/<slug>` route, which handles
 * login and continues to the app.
 */
function renderSignInPage(slug) {
  const safeSlug = encodeURIComponent(String(slug || ''));
  const body = `<main id="app-install-signin">
  <div class="icon"><img src="/icons/v2/icon-192.png" alt="" draggable="false"></div>
  <h1>Sign in to Homeroom first</h1>
  <p class="lead">Sign in to Homeroom, then come back here to add this app to your home screen.</p>
  <p><a class="btn" href="/app/${safeSlug}">Open the app</a></p>
</main>`;
  return layout({ title: 'Sign in to Homeroom', body });
}

/** Same existence-hiding 404 the shell's own app routes give a denied slug. */
function renderNotFoundPage() {
  const body = `<main id="app-install-missing">
  <div class="icon"><img src="/icons/v2/icon-192.png" alt="" draggable="false"></div>
  <h1>App not found</h1>
  <p class="lead">There is no app here, or it is not shared with you.</p>
  <p><a class="btn" href="/">Back to Homeroom</a></p>
</main>`;
  return layout({ title: 'App not found', body });
}

module.exports = {
  GROUND,
  PLATFORM_ICONS,
  SHORT_NAME_MAX,
  escapeHtml,
  pngDimensions,
  iconGlyph,
  emojiIconDataUrl,
  shortName,
  manifestIcons,
  buildManifest,
  renderInstallPage,
  renderSignInPage,
  renderNotFoundPage,
};
