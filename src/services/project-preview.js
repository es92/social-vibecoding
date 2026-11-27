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
//   landingTags({ origin, canonical })  the same for the front page, signed
//                             out: what Homeroom is, a brand picture, and
//                             the records that name the site and who runs it.
//   withHead(html, tags, title)  the shell document with any page's tags
//                             and exactly that <title>.
//   projectContent(app)       a public project's page in words, for a reader
//                             that runs no JavaScript: its name, what it is
//                             and its address, in a <noscript> block.
//   landingContent(apps)      the same for the front page: what Homeroom is,
//                             and a link to each listed public project.
//   withBody(html, block)     the shell document with that block as the last
//                             thing in its <body>.
//   pictureSize(bytes)        a picture's width and height, read from its
//                             first bytes (PNG, JPEG, GIF, WebP).
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
const embed = require('./project-embed');

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

// The shell document's own description (frontend/src/head.html), one line.
// `withPreview` takes it out before inserting a project's, so the page has
// exactly one. A document from an older build has none, and the removal is
// a no-op.
// The front page's own words, signed out (request 7166). The description is
// head.html's sentence; the title says the same promise with the vote in it,
// where the bare word "Homeroom" told a search result nothing.
const LANDING_TITLE = 'Homeroom: make apps together, one vote at a time';
const LANDING_DESCRIPTION = 'Homeroom is where people make apps together: suggest a change, vote on it, and see it go live.';
// The picture a shared link to the front page shows: the clouds behind the
// landing's own hero (public/brand/README.md). No brand picture is 1200 x 630;
// this is the widest one there is, and its real size is said beside it.
const LANDING_PICTURE = { path: '/brand/sky.webp', width: 1920, height: 1080, type: 'image/webp', alt: 'Homeroom' };
const LANDING_LOGO_PATH = '/brand/homeroom-mark.png';
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;

const SHELL_DESCRIPTION_RE = /[ \t]*<meta name="description" content="Homeroom is where people make apps together: suggest a change, vote on it, and see it go live\.">\n?/;

/**
 * JSON for an inline data block: `<`, `>`, `&` and the two line separators
 * escaped, so no project's name or description can close the tag or break
 * the script. The block is data, never executed.
 */
function safeJson(value) {
  return JSON.stringify(value).replace(new RegExp('[<>&\\u2028\\u2029]', 'g'),
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The day a project was made (YYYY-MM-DD), or null when it cannot be read. */
function createdDay(app) {
  const t = Date.parse(app && app.created_at ? app.created_at : '');
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
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

/**
 * A picture's width and height from its header, or null when they cannot be
 * read. Reads the first bytes only and decodes nothing, so it also answers
 * for the kinds `coverPng` cannot draw (JPEG, WebP, GIF).
 */
function pictureSize(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : null;
  if (!b || b.length < 24) return null;
  const sized = (width, height) => (width > 0 && height > 0 ? { width, height } : null);
  if (b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') {
    return sized(b.readUInt32BE(16), b.readUInt32BE(20));
  }
  if (b.toString('latin1', 0, 3) === 'GIF') return sized(b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' && b.length >= 30) {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return sized(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (kind === 'VP8X') return sized(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segments to the frame header, which holds the size.
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      if (marker === 0xff) { at += 1; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return sized(b.readUInt16BE(at + 7), b.readUInt16BE(at + 5));
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      at += 2 + b.readUInt16BE(at + 2);
    }
  }
  return null;
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
 * the card a small one. `imageSize`: that icon's width and height when the
 * server could read them (pictureSize), said beside it as the cover's are.
 * `player`: whether the project can be used in a post
 * on X (services/project-embed.js embedFor), which makes X's card a frame
 * around its embed page, with the picture as the still before it plays and
 * where X runs no players. X shows no player without a picture.
 */
function previewTags(app, origin, { cover = true, player = false, imageSize = null, canonical = null } = {}) {
  // Where the page is listed: the platform's configured origin when the
  // caller has one (as landingTags), else the origin the pictures use.
  const home = ORIGIN_RE.test(String(canonical || '')) ? canonical : origin;
  const address = pageUrl(home, app.slug);
  const title = app.name || app.slug;
  const description = descriptionOf(app);
  const image = cover ? `${origin}${coverPath(app.slug)}` : (app.icon_url ? `${origin}${app.icon_url}` : null);
  const playable = Boolean(player && image);
  const card = playable ? 'player' : (cover ? 'summary_large_image' : 'summary');
  const tags = [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Homeroom">',
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    `<meta property="og:url" content="${escapeAttr(address)}">`,
    // One address per project for a search engine: the page's clean path,
    // whichever way it was reached (Discover's cards, a share, the sitemap).
    `<link rel="canonical" href="${escapeAttr(address)}">`,
    `<meta name="description" content="${escapeAttr(description)}">`,
    `<meta name="twitter:card" content="${card}">`,
    `<meta name="twitter:title" content="${escapeAttr(title)}">`,
    `<meta name="twitter:description" content="${escapeAttr(description)}">`,
  ];
  if (playable) {
    tags.push(
      `<meta name="twitter:image" content="${escapeAttr(image)}">`,
      `<meta name="twitter:player" content="${escapeAttr(`${origin}${embed.embedPath(app.slug)}`)}">`,
      `<meta name="twitter:player:width" content="${embed.PLAYER_WIDTH}">`,
      `<meta name="twitter:player:height" content="${embed.PLAYER_HEIGHT}">`,
    );
  }
  if (image) {
    tags.push(`<meta property="og:image" content="${escapeAttr(image)}">`);
    const size = cover ? { width: WIDTH, height: HEIGHT } : imageSize;
    if (size && Number.isInteger(size.width) && Number.isInteger(size.height) && size.width > 0 && size.height > 0) {
      tags.push(`<meta property="og:image:width" content="${size.width}">`, `<meta property="og:image:height" content="${size.height}">`);
    }
    tags.push(`<meta property="og:image:alt" content="${escapeAttr(`${title} on Homeroom`)}">`);
  }
  // A hidden record for a search engine: what the project is, where it is,
  // and the day it was made on Homeroom. Inline and same-origin: a data
  // block, never an outside script.
  const root = `${home}/`;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: title,
    description,
    url: address,
  };
  const made = createdDay(app);
  if (made) data.dateCreated = made;
  if (image) data.image = image;
  data.isPartOf = { '@type': 'WebSite', name: 'Homeroom', url: root };
  data.publisher = { '@type': 'Organization', name: 'Homeroom', url: root };
  tags.push(`<script type="application/ld+json">${safeJson(data)}</script>`);
  return tags.join('\n');
}

/**
 * The head tags for the front page as somebody signed out gets it: what
 * Homeroom is, for a search result and for a link pasted into a chat.
 *
 * `canonical` is the platform's CONFIGURED origin (app-identity-env.js
 * platformOrigin) or null: the page's one address and its og:url come from
 * it alone, never from the request's Host, so a forged Host cannot name
 * another site as this page (the rule search-robots.js shellCanonicalLink
 * keeps for the Link header). A staging copy and a server with no configured
 * address pass null and get neither. `origin` is where the pictures are
 * fetched from when there is no configured origin (the request's own, as a
 * project's cover uses); with neither, the tags carry words only.
 */
function landingTags({ origin = null, canonical = null } = {}) {
  const own = ORIGIN_RE.test(String(canonical || '')) ? canonical : null;
  const base = own || (ORIGIN_RE.test(String(origin || '')) ? origin : null);
  const tags = [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Homeroom">',
    `<meta property="og:title" content="${escapeAttr(LANDING_TITLE)}">`,
    `<meta property="og:description" content="${escapeAttr(LANDING_DESCRIPTION)}">`,
  ];
  if (own) {
    tags.push(
      `<meta property="og:url" content="${escapeAttr(`${own}/`)}">`,
      `<link rel="canonical" href="${escapeAttr(`${own}/`)}">`,
    );
  }
  tags.push(
    `<meta name="description" content="${escapeAttr(LANDING_DESCRIPTION)}">`,
    `<meta name="twitter:card" content="${base ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeAttr(LANDING_TITLE)}">`,
    `<meta name="twitter:description" content="${escapeAttr(LANDING_DESCRIPTION)}">`,
  );
  if (!base) return tags.join('\n');
  const image = `${base}${LANDING_PICTURE.path}`;
  tags.push(
    `<meta name="twitter:image" content="${escapeAttr(image)}">`,
    `<meta name="twitter:image:alt" content="${escapeAttr(LANDING_PICTURE.alt)}">`,
    `<meta property="og:image" content="${escapeAttr(image)}">`,
    `<meta property="og:image:type" content="${LANDING_PICTURE.type}">`,
    `<meta property="og:image:width" content="${LANDING_PICTURE.width}">`,
    `<meta property="og:image:height" content="${LANDING_PICTURE.height}">`,
    `<meta property="og:image:alt" content="${escapeAttr(LANDING_PICTURE.alt)}">`,
  );
  // The records a search engine reads for the site's name and who runs it:
  // the two a project's page already points at (isPartOf, publisher).
  const root = `${base}/`;
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${root}#website`,
        name: 'Homeroom',
        url: root,
        description: LANDING_DESCRIPTION,
        publisher: { '@id': `${root}#organization` },
      },
      {
        '@type': 'Organization',
        '@id': `${root}#organization`,
        name: 'Homeroom',
        url: root,
        logo: `${base}${LANDING_LOGO_PATH}`,
      },
    ],
  };
  tags.push(`<script type="application/ld+json">${safeJson(data)}</script>`);
  return tags.join('\n');
}

/**
 * The shell document with a page's tags in its head and exactly `title` as
 * its <title>. The shell's own description comes out, so the page has the
 * one its tags carry.
 */
function withHead(html, tags, title) {
  const at = html.indexOf('</head>');
  if (at === -1) return html;
  const named = html
    .replace('<title>Homeroom</title>', () => `<title>${escapeAttr(title)}</title>`)
    .replace(SHELL_DESCRIPTION_RE, '');
  const end = named.indexOf('</head>');
  return `${named.slice(0, end)}${tags}\n${named.slice(end)}`;
}

/** The shell document with the project's tags in its head and its name in the title. */
function withPreview(html, tags, title) {
  return withHead(html, tags, `${title} · Homeroom`);
}

// ── The page in words, for a reader that runs no JavaScript (request 7166) ──
// The served document is the app's shell for every address: the landing's
// story and a project's page are drawn by the client, so a link previewer, an
// AI crawler or a search engine that runs no script got a head and an empty
// page. These two blocks say in the body what the head's tags already say.
//
// They are <noscript>, so a browser that runs scripts never builds their
// elements: it keeps the block's inside as inert text, and the page a person
// sees is unchanged. That is also why the heading is an <h1>: the shell
// serves none of its own (tests/shell-build.test.js, PR #7192: a screen names
// itself once it is drawn), so this is the page's one top-level heading for a
// reader without scripts, and no heading at all for a reader with them.
//
// Every value is escaped, and the links are paths on this origin, made from
// the slug alone: nothing here reads the request's Host.

/** How many projects the front page links to: a page of links, not the whole directory. */
const LANDING_LINKS_MAX = 50;

/** A project's page path on this origin. */
function pagePath(slug) { return `/app/${encodeURIComponent(slug)}`; }

/**
 * A public project's page in words: its name as the heading, the sentence
 * its description tag carries (descriptionOf), and its address. Only ever
 * called for a project the public directory lists.
 */
function projectContent(app) {
  const title = app.name || app.slug;
  return [
    '<noscript>',
    `<h1>${escapeAttr(title)}</h1>`,
    `<p>${escapeAttr(descriptionOf(app))}</p>`,
    `<p><a href="${escapeAttr(pagePath(app.slug))}">Open ${escapeAttr(title)}</a></p>`,
    '<p><a href="/">Homeroom</a></p>',
    '</noscript>',
  ].join('');
}

/**
 * The front page in words: the title and the description its head carries,
 * then a link to each project in `apps`, at most LANDING_LINKS_MAX. `apps`
 * is the caller's list of public projects worth finding (the sitemap's own
 * list, routes/project-preview.js listedProjects); with none, the list and
 * its heading are left out.
 */
function landingContent(apps = []) {
  const links = (Array.isArray(apps) ? apps : [])
    .filter((app) => app && app.slug)
    .slice(0, LANDING_LINKS_MAX)
    .map((app) => `<li><a href="${escapeAttr(pagePath(app.slug))}">${escapeAttr(app.name || app.slug)}</a></li>`);
  return [
    '<noscript>',
    `<h1>${escapeAttr(LANDING_TITLE)}</h1>`,
    `<p>${escapeAttr(LANDING_DESCRIPTION)}</p>`,
    links.length ? `<h2>Public projects on Homeroom</h2><ul>${links.join('')}</ul>` : '',
    '</noscript>',
  ].join('');
}

/**
 * The shell document with `block` as the last thing in its <body>. Last, and
 * with no space around it, on purpose: the client hydrates the body's
 * children as the shell rendered them (frontend/scripts/build-shell.mjs), and
 * an element after the last of them is left alone, where one before or
 * between them would be a mismatch.
 */
function withBody(html, block) {
  const at = html.lastIndexOf('</body>');
  if (at === -1 || !block) return html;
  return `${html.slice(0, at)}${block}${html.slice(at)}`;
}

module.exports = {
  previewTags,
  withPreview,
  landingTags,
  withHead,
  projectContent,
  landingContent,
  withBody,
  LANDING_LINKS_MAX,
  pictureSize,
  LANDING_TITLE,
  LANDING_DESCRIPTION,
  LANDING_PICTURE,
  SHELL_DESCRIPTION_RE,
  createdDay,
  coverPng,
  canDrawCover,
  descriptionOf,
  colorFromPixels,
  swatchFor,
  coverPath,
  pageUrl,
  WIDTH,
  HEIGHT,
};
