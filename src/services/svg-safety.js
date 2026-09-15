// SVG upload safety: the gate every admin-uploaded challenge illustration
// passes before it is stored (src/routes/topochain/challenge-illustrations.js).
//
// SVG is a document format, not a picture format. It can carry <script>,
// event-handler attributes, <foreignObject> full of HTML, external references
// that fetch or navigate, and DTDs that expand entities without bound. So this
// is a strict ALLOWLIST, and it only ever REJECTS: nothing is stripped or
// rewritten, which means the bytes stored are exactly the bytes that were
// checked. The admin gallery cleans a file in the browser with the vendored
// DOMPurify under the SAME lists (frontend/src/lib/svg-allowlist.ts, pinned by
// tests/illustration-gallery.test.js) before it uploads, so an honest drawing
// arrives already inside them and a refusal here means something slipped past.
//
// The parser below is a deliberately small tokenizer rather than an XML
// library. It does not need to understand SVG, only to prove that a document
// contains nothing outside the lists, and every construct it does not
// recognise is a rejection. SVG is case sensitive, so the lists are matched
// exactly: <SCRIPT> is not <script>, but it is not on the list either. Every
// reason is a short sentence in plain words, because the gallery shows it to
// the admin as the explanation for the refusal.
//
// Serving adds two more layers (the image route's `sandbox` CSP, and cards
// drawing the file through <img>, which never runs script), but neither is a
// reason to loosen this one.
'use strict';

const MAX_SVG_BYTES = 256 * 1024;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
// Real drawings nest a handful of levels; this only bounds pathological input.
const MAX_DEPTH = 64;

// Shapes, grouping, paint servers, clipping and masking, and the two
// accessibility elements. Nothing that holds text to render, references
// another resource (<use>, <image>, <a>), or carries style or script.
const ALLOWED_ELEMENTS = [
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask',
  'title', 'desc',
];

// Geometry and presentation attributes only. No `style` (a CSS parser is a
// second language to police), no `href` or `xlink:href`, no event handlers,
// and no namespace prefix except the two namespace declarations themselves.
const ALLOWED_ATTRIBUTES = [
  'id', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy',
  'width', 'height', 'viewBox', 'preserveAspectRatio', 'points', 'transform',
  'fill', 'fill-rule', 'fill-opacity',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'opacity', 'clip-path', 'clip-rule', 'mask', 'offset', 'stop-color', 'stop-opacity',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'overflow', 'version',
  'xmlns', 'xmlns:xlink',
];

const ELEMENT_SET = new Set(ALLOWED_ELEMENTS);
const ATTRIBUTE_SET = new Set(ALLOWED_ATTRIBUTES);

// ASCII names only. XML allows far more, but nothing on either list needs it,
// and a name this regex cannot read is a malformed tag.
const NAME = /[A-Za-z_][A-Za-z0-9._:-]*/y;
// Unambiguous on purpose: each digit belongs to exactly one quantifier. The
// earlier `[0-9]+\.?[0-9]*` let a dotless run split between two of them in
// O(n) ways, so a failed match backtracked in O(n^2), and a 250 KB viewBox of
// digits held the event loop for most of a minute.
const NUMBER = /^[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/;
// Four numbers fit in far less; this bounds the input before any regex sees it,
// a second guard should the grammar above ever change.
const MAX_VIEWBOX_LENGTH = 256;
// Optional, at the very start only, and UTF-8 or nothing: a document that
// declares another encoding would be decoded by the browser differently from
// how it was read here.
const XML_DECLARATION = /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(["'])1\.[0-9]+\1(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(["'])[uU][tT][fF]-8\2)?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(["'])(?:yes|no)\3)?[ \t\r\n]*\?>$/;
// The five predefined entities and numeric character references. Any other
// `&name;` would need a DTD to mean anything, and DTDs are refused outright.
const REFERENCE = /&(?:(lt|gt|amp|quot|apos)|#([0-9]{1,7})|#x([0-9a-fA-F]{1,6}));/y;
const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
// The one url() a paint or clip attribute may hold: a local fragment.
const LOCAL_URL = /^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/;
// What a browser skips while reading a URL scheme or a CSS token ("java\tscript:").
const IGNORABLE = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u205f\u3000\ufeff]/g;
// Characters XML 1.0 forbids anywhere (NUL is refused earlier, on the bytes).
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;

const REASON = {
  malformed: 'A tag is malformed.',
  truncated: 'The file ends in the middle of a tag.',
  unclosed: 'The file ends before every element is closed.',
  root: 'The file must start with an <svg> element.',
  trailing: 'Nothing may follow the closing </svg> tag.',
  comment: 'A comment is not closed properly or contains a double hyphen.',
  reference: 'Only the five standard XML entities and numeric character references are allowed.',
  unquoted: 'Every attribute needs a quoted value.',
};

const reject = (reason) => ({ ok: false, reason });
// Names in a reason are already limited to NAME's characters; this bounds length.
const shown = (name) => (name.length > 40 ? `${name.slice(0, 40)}...` : name);
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

function isXmlChar(cp) {
  return cp === 0x9 || cp === 0xa || cp === 0xd
    || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

// `text` with its references expanded, or null when one is not allowed.
function decodeReferences(text) {
  let out = '';
  let i = 0;
  for (;;) {
    const amp = text.indexOf('&', i);
    if (amp === -1) return out + text.slice(i);
    out += text.slice(i, amp);
    REFERENCE.lastIndex = amp;
    const m = REFERENCE.exec(text);
    if (!m) return null;
    if (m[1]) {
      out += NAMED[m[1]];
    } else {
      const cp = m[2] ? parseInt(m[2], 10) : parseInt(m[3], 16);
      if (!isXmlChar(cp)) return null;
      out += String.fromCodePoint(cp);
    }
    i = REFERENCE.lastIndex;
  }
}

// Why one attribute's value is refused, or null. Checked on the DECODED value,
// so `&#106;avascript:` is read the way the browser will read it.
function valueProblem(name, raw) {
  if (raw.includes('<')) return `The ${name} attribute contains a < character.`;
  const value = decodeReferences(raw);
  if (value === null) return REASON.reference;
  const folded = value.replace(IGNORABLE, '').toLowerCase();
  if (folded.includes('<')) return `The ${name} attribute contains a < character.`;
  // A CSS escape can spell url( or expression( without writing either.
  if (folded.includes('\\')) return `The ${name} attribute contains a backslash.`;
  if (folded.includes('javascript:') || folded.includes('vbscript:') || folded.includes('data:')) {
    return `The ${name} attribute contains a script or data URL.`;
  }
  if (folded.includes('expression(')) return `The ${name} attribute contains a CSS expression.`;
  // image-set() takes its URL as a quoted string, not url(, and `mask` is the
  // CSS mask shorthand, which accepts an image. `-webkit-image-set(` contains
  // the same substring.
  if (folded.includes('image-set(')) return `The ${name} attribute may not load another image.`;
  if (folded.includes('url(') && !LOCAL_URL.test(value.trim())) {
    return `The ${name} attribute may only use url(#id) to point at something in the same file.`;
  }
  // No attribute on the list needs a quoted string, and every CSS function that
  // takes a URL as a string needs one, so a quote closes that door whatever the
  // function is called. Checked after url( so url('#x') keeps its own reason.
  if (value.includes("'") || value.includes('"')) return `The ${name} attribute contains a quotation mark.`;
  return null;
}

function isViewBox(value) {
  if (typeof value !== 'string' || value.length > MAX_VIEWBOX_LENGTH) return false;
  const parts = value.trim().split(/[ \t\r\n,]+/);
  return parts.length === 4 && parts.every((p) => NUMBER.test(p))
    && Number(parts[2]) > 0 && Number(parts[3]) > 0;
}

function parse(s) {
  const n = s.length;
  const stack = [];
  let sawRoot = false;
  let i = 0;

  if (s.startsWith('<?xml') && n > 5 && isSpace(s[5])) {
    const end = s.indexOf('?>');
    if (end === -1 || !XML_DECLARATION.test(s.slice(0, end + 2))) {
      return reject('The XML declaration is malformed or names an encoding other than UTF-8.');
    }
    i = end + 2;
  }

  while (i < n) {
    const lt = s.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const chunk = s.slice(i, textEnd);
      if (stack.length === 0) {
        // Outside the root only whitespace is allowed, before it or after it.
        if (!/^[ \t\r\n]*$/.test(chunk)) return reject(sawRoot ? REASON.trailing : REASON.root);
      } else {
        if (chunk.includes(']]>')) return reject(REASON.malformed);
        if (decodeReferences(chunk) === null) return reject(REASON.reference);
      }
    }
    if (lt === -1) break;
    i = lt;
    // Once the root has closed, nothing else may start: not a comment, not a
    // second root, not a processing instruction.
    if (sawRoot && stack.length === 0) return reject(REASON.trailing);

    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end === -1) return reject(REASON.comment);
      const body = s.slice(i + 4, end);
      if (body.includes('--') || body.endsWith('-')) return reject(REASON.comment);
      i = end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', i)) return reject('CDATA sections are not allowed.');
    if (s.startsWith('<!', i)) return reject('DOCTYPE and ENTITY declarations are not allowed.');
    if (s.startsWith('<?', i)) return reject('Processing instructions such as xml-stylesheet are not allowed.');

    if (s.startsWith('</', i)) {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(s);
      if (!m) return reject(REASON.malformed);
      let j = NAME.lastIndex;
      while (j < n && isSpace(s[j])) j++;
      if (j >= n) return reject(REASON.truncated);
      if (s[j] !== '>') return reject(REASON.malformed);
      if (stack.pop() !== m[0]) return reject(`The </${shown(m[0])}> closing tag does not match an open element.`);
      i = j + 1;
      continue;
    }

    NAME.lastIndex = i + 1;
    const m = NAME.exec(s);
    if (!m) return reject(REASON.malformed);
    const name = m[0];
    if (!sawRoot && name !== 'svg') return reject(REASON.root);
    if (!ELEMENT_SET.has(name)) return reject(`The <${shown(name)}> element is not allowed.`);

    let j = NAME.lastIndex;
    const attributes = new Map();
    let selfClosing = false;
    for (;;) {
      const gap = j;
      while (j < n && isSpace(s[j])) j++;
      if (j >= n) return reject(REASON.truncated);
      if (s[j] === '>') { j++; break; }
      if (s[j] === '/') {
        if (j + 1 >= n) return reject(REASON.truncated);
        if (s[j + 1] !== '>') return reject(REASON.malformed);
        j += 2;
        selfClosing = true;
        break;
      }
      // XML requires whitespace between the name and each attribute.
      if (j === gap) return reject(REASON.malformed);
      NAME.lastIndex = j;
      const a = NAME.exec(s);
      if (!a) return reject(REASON.malformed);
      const attr = a[0];
      j = NAME.lastIndex;
      while (j < n && isSpace(s[j])) j++;
      if (j >= n) return reject(REASON.truncated);
      if (s[j] !== '=') return reject(REASON.unquoted);
      j++;
      while (j < n && isSpace(s[j])) j++;
      if (j >= n) return reject(REASON.truncated);
      const quote = s[j];
      if (quote !== '"' && quote !== "'") return reject(REASON.unquoted);
      const close = s.indexOf(quote, j + 1);
      if (close === -1) return reject(REASON.truncated);
      const raw = s.slice(j + 1, close);
      j = close + 1;

      if (/^on/i.test(attr)) return reject(`Event handler attributes such as ${shown(attr)} are not allowed.`);
      if (!ATTRIBUTE_SET.has(attr)) return reject(`The ${shown(attr)} attribute is not allowed.`);
      if (attributes.has(attr)) return reject(`The ${attr} attribute appears twice on one element.`);
      const problem = valueProblem(attr, raw);
      if (problem) return reject(problem);
      attributes.set(attr, decodeReferences(raw));
    }

    if (attributes.has('xmlns') && attributes.get('xmlns') !== SVG_NAMESPACE) {
      return reject('Every element must stay in the SVG namespace.');
    }
    if (attributes.has('xmlns:xlink') && attributes.get('xmlns:xlink') !== XLINK_NAMESPACE) {
      return reject('The xmlns:xlink attribute must name the XLink namespace.');
    }
    if (!sawRoot) {
      if (attributes.get('xmlns') !== SVG_NAMESPACE) return reject('The <svg> element must declare the SVG namespace.');
      if (!isViewBox(attributes.get('viewBox'))) return reject('The <svg> element needs a viewBox of four numbers.');
      sawRoot = true;
    }
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) return reject('The SVG nests elements too deeply.');
      stack.push(name);
    }
    i = j;
  }

  if (!sawRoot) return reject(REASON.root);
  if (stack.length) return reject(REASON.unclosed);
  return { ok: true };
}

/**
 * Whether `buffer` is an SVG this platform will store and serve.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateSvg(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return reject('The file is empty.');
  if (buffer.length > MAX_SVG_BYTES) return reject('SVG files must be 256 KB or smaller.');
  if (buffer.includes(0)) return reject('The file contains a NUL byte.');
  let text;
  try {
    // The default decoder drops one leading byte order mark, which is fine:
    // the browser does the same.
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return reject('The file is not valid UTF-8 text.');
  }
  if (CONTROL.test(text)) return reject('The file contains control characters.');
  return parse(text);
}

module.exports = { validateSvg, ALLOWED_ELEMENTS, ALLOWED_ATTRIBUTES, MAX_SVG_BYTES };
