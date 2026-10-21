'use strict';

// A shared project link's preview: what a chat app (iMessage, WhatsApp,
// Slack, X) draws when somebody pastes `/app/<slug>`, the address Share
// copies for a public project (21 Oct 2026 review: a shared link is the
// real landing page, and every one previewed as the bare word "Homeroom").
//
//   previewTags(app, origin)  the head tags for a public project's page: its
//                             name, what it is, its address and its cover.
//   withPreview(html, app, origin)  the shell document with those tags,
//                             and its <title> named for the project.
//   coverPng(app, icon)       the cover, 1200 x 630: the project's colour
//                             with its icon in the middle, the picture its
//                             Discover card shows. No words in it; the chat
//                             app draws the title and description.
//
// Only a project the public directory lists (public-app-directory.js) gets
// any of this; every other address is the shell as `app.get('*')` serves it,
// so a link to a private project discloses nothing.

const { PNG } = require('pngjs');
const emojiTile = require('./emoji-tile');

const WIDTH = 1200;
const HEIGHT = 630;
const TILE = 300;
const RADIUS = 66;
const SHADOW = 36;
const SHADOW_DROP = 10;
const SHADOW_ALPHA = 0.28;
// A count shows only from the cards' minimum (guest-data.ts MIN_MEMBERS):
// a small one reads as a project nobody uses.
const MIN_MEMBERS = 25;
// The client's fallbacks (frontend/src/lib/community-color.ts): a project
// with no icon at all takes its name's swatch, anything else unreadable the
// graphite.
const SWATCHES = ['#5b7553', '#c0532f', '#6fb3a8', '#4a6fa5', '#8a5a83', '#b08344'];
const GRAPHITE = '#2a2e34';

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A name's swatch, picked as the client picks it (FNV-1a, then mixed). */
function swatchFor(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16;
  return SWATCHES[(h >>> 0) % SWATCHES.length];
}

function hexOf([r, g, b]) {
  return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * An icon's colour from its pixels: the average of its coloured ones (not
 * near-grey, not near-white or near-black), or null when too few are
 * coloured to lend a hue. A plainer reading than the client's, close enough
 * for a link's picture.
 */
function colorFromPixels(png) {
  let n = 0; let r = 0; let g = 0; let b = 0; let opaque = 0;
  for (let i = 0; i + 3 < png.data.length; i += 4) {
    if (png.data[i + 3] < 128) continue;
    opaque += 1;
    const pr = png.data[i]; const pg = png.data[i + 1]; const pb = png.data[i + 2];
    const max = Math.max(pr, pg, pb); const min = Math.min(pr, pg, pb);
    if (max - min < 40 || max < 50 || min > 235) continue;
    n += 1; r += pr; g += pg; b += pb;
  }
  if (!n || n / Math.max(1, opaque) < 0.03) return null;
  return hexOf([r / n, g / n, b / n]);
}

/** The icon, decoded, when it can be drawn: a PNG file, or an emoji with a picture. */
function iconPicture(app, icon) {
  if (icon && /png/i.test(icon.contentType || '') && icon.data) {
    try { return PNG.sync.read(icon.data); } catch { return null; }
  }
  if (app.icon_emoji) {
    const tile = emojiTile.tilePng({ emoji: app.icon_emoji, color: '#ffffff' });
    if (tile) {
      try { return PNG.sync.read(tile); } catch { return null; }
    }
  }
  return null;
}

/** The cover's colour: the one the project set, else its icon's, else its name's swatch. */
function coverColor(app, picture) {
  const set = emojiTile.parseColor(app.icon_color);
  if (set) return set;
  const read = picture ? colorFromPixels(picture) : null;
  return emojiTile.parseColor(read || (app.icon_url || app.icon_emoji ? GRAPHITE : swatchFor(app.slug || '')));
}

/** Whether `coverPng` can draw this project's icon (else the link uses the icon itself). */
function canDrawCover(app, icon) {
  return !!iconPicture(app, icon);
}

// Bilinear sample of `src` at (x, y) in its own pixels.
function sample(src, x, y) {
  const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(y)));
  const x1 = Math.min(src.width - 1, x0 + 1);
  const y1 = Math.min(src.height - 1, y0 + 1);
  const fx = x - x0; const fy = y - y0;
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c += 1) {
    const at = (px, py) => src.data[(py * src.width + px) * 4 + c];
    const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
    const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
  return out;
}

// How far (x, y) is outside a TILE x TILE square with RADIUS corners; 0 or
// less inside it.
function roundedDistance(x, y) {
  const cx = x < RADIUS ? RADIUS : x > TILE - RADIUS ? TILE - RADIUS : x;
  const cy = y < RADIUS ? RADIUS : y > TILE - RADIUS ? TILE - RADIUS : y;
  return Math.hypot(x - cx, y - cy) - RADIUS;
}

// How much of the tile covers pixel (x, y): 0 outside, 1 inside, a soft
// edge of one pixel.
function cornerCover(x, y) {
  return Math.max(0, Math.min(1, 0.5 - roundedDistance(x, y)));
}

/**
 * The cover, as PNG bytes: the project's colour, with its icon on a rounded
 * tile in the middle, on a white ground where the icon is see-through.
 * Null when its icon cannot be drawn (a JPEG, WebP or GIF file: the server
 * has no decoder for those).
 */
function coverPng(app, icon) {
  const picture = iconPicture(app, icon);
  if (!picture) return null;
  const [br, bg, bb] = coverColor(app, picture);
  const out = new PNG({ width: WIDTH, height: HEIGHT });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = br; out.data[i + 1] = bg; out.data[i + 2] = bb; out.data[i + 3] = 255;
  }
  const left = Math.round((WIDTH - TILE) / 2);
  const top = Math.round((HEIGHT - TILE) / 2);
  // A soft shadow under the tile, as the cards' covers draw it, so an icon
  // whose own ground is the cover's colour still reads as a tile.
  for (let y = -SHADOW; y < TILE + SHADOW + SHADOW_DROP; y += 1) {
    for (let x = -SHADOW; x < TILE + SHADOW; x += 1) {
      const d = roundedDistance(x + 0.5, y + 0.5 - SHADOW_DROP);
      if (d <= 0 || d >= SHADOW) continue;
      const shade = SHADOW_ALPHA * (1 - d / SHADOW) ** 2;
      const o = ((top + y) * WIDTH + left + x) * 4;
      if (o < 0 || o >= out.data.length) continue;
      out.data[o] = Math.round(br * (1 - shade));
      out.data[o + 1] = Math.round(bg * (1 - shade));
      out.data[o + 2] = Math.round(bb * (1 - shade));
    }
  }
  const sx = picture.width / TILE;
  const sy = picture.height / TILE;
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const cover = cornerCover(x + 0.5, y + 0.5);
      if (!cover) continue;
      const [r, g, b, a] = sample(picture, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
      // The icon over white, then the tile over the cover's colour.
      const ia = a / 255;
      const tr = r * ia + 255 * (1 - ia);
      const tg = g * ia + 255 * (1 - ia);
      const tb = b * ia + 255 * (1 - ia);
      const o = ((top + y) * WIDTH + left + x) * 4;
      out.data[o] = Math.round(tr * cover + br * (1 - cover));
      out.data[o + 1] = Math.round(tg * cover + bg * (1 - cover));
      out.data[o + 2] = Math.round(tb * cover + bb * (1 - cover));
    }
  }
  return PNG.sync.write(out, { colorType: 2 });
}

/** What the link says the project is: its own words, and its members once there are enough to say. */
function descriptionOf(app) {
  const own = app.description ? String(app.description).trim() : '';
  const members = Number(app.member_count) || 0;
  const together = members >= MIN_MEMBERS
    ? `${members} members are making it together on Homeroom.`
    : 'Made together on Homeroom.';
  return own ? `${own}${/[.!?…]$/.test(own) ? '' : '.'} ${together}` : together;
}

/** The address of a project's page, and of its cover. */
function pageUrl(origin, slug) { return `${origin}/app/${encodeURIComponent(slug)}`; }
function coverPath(slug) { return `/api/public/apps/${encodeURIComponent(slug)}/cover.png`; }

/**
 * The head tags for a public project's page. `cover`: whether the cover can
 * be drawn (canDrawCover); without it the picture is the project's icon, and
 * the card a small one.
 */
function previewTags(app, origin, { cover = true } = {}) {
  const title = app.name || app.slug;
  const description = descriptionOf(app);
  const image = cover ? `${origin}${coverPath(app.slug)}` : (app.icon_url ? `${origin}${app.icon_url}` : null);
  const tags = [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Homeroom">',
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    `<meta property="og:url" content="${escapeAttr(pageUrl(origin, app.slug))}">`,
    `<meta name="description" content="${escapeAttr(description)}">`,
    `<meta name="twitter:card" content="${cover ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeAttr(title)}">`,
    `<meta name="twitter:description" content="${escapeAttr(description)}">`,
  ];
  if (image) {
    tags.push(`<meta property="og:image" content="${escapeAttr(image)}">`);
    if (cover) {
      tags.push(`<meta property="og:image:width" content="${WIDTH}">`, `<meta property="og:image:height" content="${HEIGHT}">`);
    }
    tags.push(`<meta property="og:image:alt" content="${escapeAttr(`${title} on Homeroom`)}">`);
  }
  return tags.join('\n');
}

/** The shell document with the project's tags in its head and its name in the title. */
function withPreview(html, tags, title) {
  const at = html.indexOf('</head>');
  if (at === -1) return html;
  const named = html.replace('<title>Homeroom</title>', `<title>${escapeAttr(title)} · Homeroom</title>`);
  const end = named.indexOf('</head>');
  return `${named.slice(0, end)}${tags}\n${named.slice(end)}`;
}

module.exports = {
  previewTags,
  withPreview,
  coverPng,
  canDrawCover,
  descriptionOf,
  colorFromPixels,
  swatchFor,
  coverPath,
  WIDTH,
  HEIGHT,
};
