#!/usr/bin/env node
// Generates the platform's home-screen and browser icons from the Homeroom
// mark — the script "H" with its four-point sparkle — drawn black on the
// brand cream. The two paths below are the mark's vectors copied verbatim
// from the brand Figma (file 4kAYqXh9NhpoCU44QwWvYo, frame 1246:179 "A":
// 1246:183 is the H, 1246:184 the sparkle), so the icons are the logo
// itself rather than a redrawing of it. Re-run after changing a layout
// constant:
//
//   node scripts/generate-pwa-icons.js
//
// Each file is framed for the one thing that reads it:
//
//   public/apple-touch-icon.png          180, full-bleed, OPAQUE. iOS prefers
//                                        <link rel="apple-touch-icon"> over the
//                                        manifest, masks it with its own
//                                        rounded square, and fills any
//                                        transparent pixel with black — so no
//                                        pre-rounded corners and no alpha.
//   public/icons/v2/icon-{192,512}.png   manifest `any`: desktop installs and
//                                        Chrome's fallback. A rounded tile.
//   public/icons/v2/icon-maskable-512.png manifest `maskable`: Android masks it
//                                        to a circle, squircle or rounded
//                                        square, so it is full-bleed and the
//                                        mark stays inside the 40%-radius safe
//                                        circle (checked below, not assumed).
//   public/favicon.ico, icons/v2/icon.svg browser tabs; the mark is drawn
//                                        larger because tabs are tiny.
//
// THE ICON DIRECTORY IS VERSIONED. Chrome decides an installed app's icon
// changed by its URL, so new art goes into a new /icons/vN/ directory (and
// the old one is deleted), never over the old files. The two root files keep
// their conventional names: iOS captures the touch icon once, when the app is
// added, so versioning its URL would buy nothing.
//
// Zero dependencies: the paths are filled by a small scanline rasteriser and
// the PNG/ICO containers are written by hand (zlib IDAT + manual chunks).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CREAM = [0xff, 0xfe, 0xea]; // brand cream, the tile
const INK = [0x00, 0x00, 0x00];   // the mark

// Figma node 1246:182's own frame: the mark's bounding box, in its units.
const MARK_W = 377.327;
const MARK_H = 300;
const MARK_PATHS = [
  // 1246:183 — the H.
  'M282.189 0.0184905C293.177 -0.604608 288.538 14.682 287.489 21.4275C285.905 32.2434 284 43.0111 281.788 53.7164L266.215 133.631C261.47 158.905 253.667 190.232 255.815 215.829C256.366 220.783 259.692 230.204 264.084 232.79C284.827 245.01 310.841 225.149 324.219 210.07C326.038 208.023 331.965 199.835 333.65 199.543C340.38 201.027 333.91 209.31 331.86 212.815C313.045 244.972 244.904 303.554 211.715 261.345C195.524 240.754 205.895 198.505 210.475 173.268C204.051 173.857 197.465 175.394 191.045 176.206C180.723 177.511 170.247 178.385 159.87 179.135C159.221 184.031 157.523 191.621 156.553 196.671L148.885 235.802L143.91 262.1C140.066 282.074 141.043 280.208 122.179 287.814C112.216 291.83 101.685 296.154 91.5309 300C89.6438 298.559 88.1998 297.774 88.4988 295.149C89.1308 289.592 90.3422 284.049 91.3923 278.551L98.8461 240.768C102.015 222.82 105.524 204.933 109.372 187.118L109.168 187.156C80.3032 192.726 41.3404 213.558 29.3653 242.87C28.5769 244.8 29.377 248.673 27.985 250.494C24.7479 254.747 19.1217 249.066 16.3538 246.979C-18.4859 220.706 8.61355 179.535 39.32 164.777C43.8661 162.592 48.4964 159.119 53.4817 157.03C73.6383 148.585 95.9044 143.669 117.64 141.63C124.515 122.017 126.011 95.8396 131.239 75.3085C132.63 69.8489 134.25 50.7848 138.789 47.8492C147.904 41.9529 160.588 38.3885 170.677 34.2403C175.511 32.2766 180.441 28.6401 185.528 27.9194C188.438 27.622 189.078 32.8134 188.795 34.7593C187.414 44.2622 184.895 53.5523 183.13 62.9997L168.863 138.998C175.211 138.852 184.739 138.113 191.045 137.184C208.259 133.879 201.647 135.532 217.82 130.139C222.813 102.028 228.072 73.9639 233.597 45.952C234.64 40.3911 237.641 18.3144 239.622 15.0434C240.826 13.0533 242.425 12.0757 244.507 11.1204C248.259 9.39657 252.598 8.66044 256.552 7.47947C265.06 4.94008 273.564 2.13776 282.189 0.0184905Z',
  // 1246:184 — the sparkle.
  'M332.573 79.3281C333.663 79.5987 333.906 79.7041 334.907 80.2198C335.932 81.6536 337.325 89.1733 338.107 91.4574C343.767 108.044 346.465 115.586 364.113 120.729C368.375 121.972 372.864 122.226 376.749 124.279C377.462 125.223 377.329 125.836 377.296 126.998C377.13 127.312 376.932 127.683 376.705 128.109C367.071 132.072 352.546 133.991 345.614 142.885C342.146 147.337 338.123 159.819 336.746 165.5C335.98 168.65 335.684 171.234 333.047 172.978L331.131 172.309C329.028 170.349 327.493 160.796 326.553 157.414C325.682 154.312 324.657 151.256 323.482 148.255C322.967 146.922 321.42 143.093 320.467 142.055C315.509 136.663 307.057 133.292 300.113 131.507C296.633 130.613 293.323 130.111 290.074 128.786C288.765 128.252 288.713 127.821 288.352 126.776C288.551 125.826 288.547 125.392 289.389 124.806C291.164 123.575 294.231 123.021 296.305 122.436C304.132 120.229 312.004 117.815 318.191 112.247C326.565 104.714 327.963 82.6316 332.573 79.3281Z',
];

// Layout: the mark's width as a share of the tile, centred on its bounding
// box. The tile corner radius is a share of the tile's side.
const MARK_SHARE = { tile: 0.68, maskable: 0.60, favicon: 0.78 };
const TILE_RADIUS = 0.18;
// W3C maskable safe zone: a circle of radius 0.4 × the icon's side.
const SAFE_RADIUS = 0.4;

// ── Geometry ────────────────────────────────────────────────────────────

// Flatten one SVG path (absolute M/L/C/Z only — all Figma emits here) into
// closed polygons in mark units.
function flattenPath(d) {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi);
  const polys = [];
  let poly = null;
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      poly = [[num(), num()]];
      polys.push(poly);
    } else if (cmd === 'L') {
      poly.push([num(), num()]);
    } else if (cmd === 'C') {
      const [x0, y0] = poly[poly.length - 1];
      const x1 = num(); const y1 = num();
      const x2 = num(); const y2 = num();
      const x3 = num(); const y3 = num();
      const STEPS = 24;
      for (let s = 1; s <= STEPS; s++) {
        const t = s / STEPS;
        const mt = 1 - t;
        poly.push([
          mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
          mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3,
        ]);
      }
    } else if (cmd === 'Z' || cmd === 'z') {
      poly = null;
    } else {
      throw new Error(`generate-pwa-icons: unsupported path command ${cmd}`);
    }
  }
  return polys;
}

const MARK_POLYS = MARK_PATHS.flatMap(flattenPath);

// The mark's polygons placed on a `size`-pixel tile at `share` of its width.
function placedEdges(size, share) {
  const scale = (size * share) / MARK_W;
  const ox = (size - MARK_W * scale) / 2;
  const oy = (size - MARK_H * scale) / 2;
  const edges = [];
  for (const poly of MARK_POLYS) {
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      if (a[1] === b[1]) continue;
      edges.push({
        x0: ox + a[0] * scale, y0: oy + a[1] * scale,
        x1: ox + b[0] * scale, y1: oy + b[1] * scale,
        dir: b[1] > a[1] ? 1 : -1,
      });
    }
  }
  return edges;
}

// Mark coverage per pixel (0..1), nonzero winding, SS×SS supersampling.
function markCoverage(size, share) {
  const SS = 4;
  const cov = new Float32Array(size * size);
  const edges = placedEdges(size, share);
  for (let row = 0; row < size * SS; row++) {
    const y = (row + 0.5) / SS;
    const hits = [];
    for (const e of edges) {
      const lo = Math.min(e.y0, e.y1);
      const hi = Math.max(e.y0, e.y1);
      if (y < lo || y >= hi) continue;
      hits.push({ x: e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dir: e.dir });
    }
    hits.sort((p, q) => p.x - q.x);
    let winding = 0;
    for (let h = 0; h < hits.length - 1; h++) {
      winding += hits[h].dir;
      if (winding === 0) continue;
      // Sub-sample columns whose centres fall inside [hits[h].x, hits[h+1].x).
      const first = Math.max(0, Math.ceil(hits[h].x * SS - 0.5));
      const last = Math.min(size * SS - 1, Math.ceil(hits[h + 1].x * SS - 0.5) - 1);
      const py = Math.floor(row / SS);
      for (let col = first; col <= last; col++) {
        cov[py * size + Math.floor(col / SS)] += 1 / (SS * SS);
      }
    }
  }
  return cov;
}

// Rounded-square tile coverage for one pixel, SS×SS supersampling.
function tileCoverage(size, px, py) {
  const SS = 4;
  const r = TILE_RADIUS;
  let n = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = (px + (sx + 0.5) / SS) / size;
      const y = (py + (sy + 0.5) / SS) / size;
      const nx = Math.min(x, 1 - x);
      const ny = Math.min(y, 1 - y);
      if (nx >= r || ny >= r || Math.hypot(r - nx, r - ny) <= r) n++;
    }
  }
  return n / (SS * SS);
}

// ── Rendering ───────────────────────────────────────────────────────────

// `rounded` draws the tile as a rounded square with transparent corners
// (RGBA); otherwise the tile is the full, opaque square (RGB).
function render(size, { share, rounded }) {
  const cov = markCoverage(size, share);
  const channels = rounded ? 4 : 3;
  const px = Buffer.alloc(size * size * channels);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const ink = Math.min(1, cov[i]);
      const o = i * channels;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(CREAM[c] + (INK[c] - CREAM[c]) * ink);
      if (rounded) px[o + 3] = Math.round(tileCoverage(size, x, y) * 255);
    }
  }
  return { size, channels, px, cov };
}

// Refuse to write a maskable icon whose ink leaves the safe circle.
function assertInsideSafeZone({ size, cov }) {
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (cov[y * size + x] <= 0) continue;
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c) / size;
      if (r > SAFE_RADIUS) {
        throw new Error(`generate-pwa-icons: maskable ink at radius ${r.toFixed(3)} leaves the ${SAFE_RADIUS} safe zone`);
      }
    }
  }
}

// ── Containers ──────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng({ size, channels, px }) {
  const stride = size * channels;
  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // RGBA : RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// An ICO whose entries are PNGs (supported by every browser that reads ICO).
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, k) => {
    const o = k * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4);  // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

// The tab icon as SVG: the same tile, radius and placement, with the Figma
// paths inlined, so it stays sharp at any pixel density.
function faviconSvg() {
  const S = 512;
  const scale = (S * MARK_SHARE.favicon) / MARK_W;
  const ox = (S - MARK_W * scale) / 2;
  const oy = (S - MARK_H * scale) / 2;
  const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const r = +(S * TILE_RADIUS).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">`
    + `<rect width="${S}" height="${S}" rx="${r}" fill="${hex(CREAM)}"/>`
    + `<g transform="translate(${+ox.toFixed(3)} ${+oy.toFixed(3)}) scale(${+scale.toFixed(6)})" fill="${hex(INK)}">`
    + MARK_PATHS.map((d) => `<path d="${d}"/>`).join('')
    + '</g></svg>\n';
}

// ── Output ──────────────────────────────────────────────────────────────

const PUBLIC = path.join(__dirname, '..', 'public');
const ICON_DIR = path.join(PUBLIC, 'icons', 'v2');

function write(rel, data) {
  const file = path.join(PUBLIC, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`wrote public/${rel}`);
}

if (require.main === module) {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  write('apple-touch-icon.png', encodePng(render(180, { share: MARK_SHARE.tile, rounded: false })));
  write('icons/v2/icon-192.png', encodePng(render(192, { share: MARK_SHARE.tile, rounded: true })));
  write('icons/v2/icon-512.png', encodePng(render(512, { share: MARK_SHARE.tile, rounded: true })));
  const maskable = render(512, { share: MARK_SHARE.maskable, rounded: false });
  assertInsideSafeZone(maskable);
  write('icons/v2/icon-maskable-512.png', encodePng(maskable));
  write('favicon.ico', encodeIco([16, 32, 48].map((size) => ({
    size, data: encodePng(render(size, { share: MARK_SHARE.favicon, rounded: true })),
  }))));
  write('icons/v2/icon.svg', faviconSvg());
}
