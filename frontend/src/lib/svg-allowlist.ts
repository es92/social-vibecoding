/**
 * The SVG allowlist an uploaded challenge illustration is cleaned against in
 * the browser, before it is sent.
 *
 * It is a MIRROR, not a second opinion. The authority is
 * src/services/svg-safety.js (ALLOWED_ELEMENTS / ALLOWED_ATTRIBUTES), which
 * rejects anything outside its lists and never rewrites. Cleaning with the
 * same lists here means a file that survives the browser pass is a file the
 * server will accept, so an admin sees the art they are about to upload rather
 * than a refusal after the fact. tests/illustration-gallery.test.js reads the
 * server module as text and fails when the two drift.
 *
 * Two things about how the admin gallery hands these to DOMPurify, both
 * because the library's defaults are wider than the server:
 *
 *   - No `USE_PROFILES`. A profile REPLACES `ALLOWED_TAGS` and `ALLOWED_ATTR`
 *     with DOMPurify's whole SVG vocabulary (use, image, text, filters), which
 *     is the opposite of what these lists are for.
 *   - `ALLOW_DATA_ATTR` and `ALLOW_ARIA_ATTR` off. Both default to on, and the
 *     server allows neither.
 *
 * Plain string arrays so they print the same as the server's in a diff.
 */

export const SVG_ELEMENTS: readonly string[] = [
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'title', 'desc',
];

export const SVG_ATTRIBUTES: readonly string[] = [
  'id', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy',
  'width', 'height', 'viewBox', 'preserveAspectRatio', 'points', 'transform',
  'fill', 'fill-rule', 'fill-opacity',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'opacity', 'clip-path', 'clip-rule', 'mask',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'overflow', 'version', 'xmlns', 'xmlns:xlink',
];
