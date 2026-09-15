// SVG upload safety (src/services/svg-safety.js): the allowlist every
// admin-uploaded challenge illustration passes before it is stored.
//
// Two halves. The acceptance half proves the gate lets real drawings through:
// every built-in illustration committed under public/illustrations/challenges/
// must pass untouched, as must a gradient painted with fill="url(#g)", or an
// admin could not upload a file shaped like the art already shipping. The
// attack half is a corpus of the ways an SVG carries script, reaches outside
// itself, or expands without bound, and each must be refused with a reason an
// admin can read. The validator only rejects, never rewrites, so "refused" is
// the whole contract; there is no cleaned output to inspect.
//
// Run with: node --test tests/svg-safety.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateSvg, ALLOWED_ELEMENTS, ALLOWED_ATTRIBUTES, MAX_SVG_BYTES,
} = require('../src/services/svg-safety');

const BUILT_IN_DIR = path.join(__dirname, '..', 'public', 'illustrations', 'challenges');
const OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">';
const wrap = (inner) => `${OPEN}${inner}</svg>`;
const check = (text) => validateSvg(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'));

function refused(text, reason, label) {
  const verdict = check(text);
  assert.equal(verdict.ok, false, `${label} must be refused`);
  assert.match(verdict.reason, reason, `${label}: ${verdict.reason}`);
  return verdict.reason;
}

// ─── Acceptance ─────────────────────────────────────────────────────────

test('all nine built-in challenge illustrations pass untouched', () => {
  const files = fs.readdirSync(BUILT_IN_DIR).filter((f) => f.endsWith('.svg'));
  assert.equal(files.length, 9, 'the nine committed drawings');
  for (const file of files) {
    assert.deepEqual(validateSvg(fs.readFileSync(path.join(BUILT_IN_DIR, file))), { ok: true }, file);
  }
});

test('a gradient painted with fill="url(#g)" passes, and so do the ordinary shapes of an export', () => {
  const gradient = wrap(
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">'
    + '<stop offset="0" stop-color="#ffcc00" stop-opacity="1"/><stop offset="1" stop-color="#ff6600"/>'
    + '</linearGradient></defs><rect width="64" height="64" rx="8" fill="url(#g)"/>'
  );
  assert.deepEqual(check(gradient), { ok: true });

  const exported = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
    + '<!-- Generator: a drawing tool -->\n'
    + '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1"\n'
    + "\tviewBox='0 0 64 64' width=\"64\" height=\"64\">\n"
    + '  <title>A &amp; B &#233;</title><desc>Two shapes</desc>\n'
    + '  <clipPath id="c"><circle cx="32" cy="32" r="30"/></clipPath>\n'
    + '  <g clip-path="url(#c)" transform="translate(1 2) rotate(3)" opacity="0.9">\n'
    + '    <path d="M0 0L64 64" stroke="#000" stroke-width="2" stroke-linecap="round"/>\n'
    + '    <polygon points="1,2 3,4 5,6" fill-rule="evenodd"/>\n'
    + '  </g>\n'
    + '</svg>\n';
  assert.deepEqual(check(exported), { ok: true });

  // A leading byte order mark is what several editors write; the browser drops
  // it too.
  assert.deepEqual(check(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(wrap(''))])), { ok: true });
  // A `>` inside a quoted value is legal XML and inert.
  assert.deepEqual(check(wrap('<rect id="a>b" width="1" height="1"/>')), { ok: true });
});

// ─── Attack corpus ──────────────────────────────────────────────────────

test('script and event handlers are refused, in any case spelling', () => {
  refused(wrap('<script>alert(1)</script>'), /<script> element is not allowed/, '<script>');
  refused(wrap('<SCRIPT>alert(1)</SCRIPT>'), /<SCRIPT> element is not allowed/, '<SCRIPT>');
  refused(wrap('<Script/>'), /element is not allowed/, '<Script>');
  refused(wrap('<svg:script/>'), /element is not allowed/, 'a prefixed script');
  refused(OPEN.replace('>', ' onload="alert(1)">') + '</svg>', /Event handler attributes such as onload/, 'onload=');
  refused(wrap('<rect onclick="alert(1)" width="1"/>'), /Event handler attributes such as onclick/, 'onclick=');
  refused(wrap('<rect ONCLICK="alert(1)"/>'), /Event handler attributes/, 'ONCLICK=');
});

test('HTML islands, style, and anything that references another resource are refused', () => {
  refused(wrap('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'),
    /<foreignObject> element is not allowed/, '<foreignObject>');
  refused(wrap('<style>rect{fill:url(http://evil.example/x)}</style>'), /<style> element is not allowed/, '<style>');
  refused(wrap('<rect style="fill:red"/>'), /style attribute is not allowed/, 'style=');
  refused(wrap('<use href="#a"/>'), /<use> element is not allowed/, '<use>');
  refused(wrap('<image href="https://evil.example/x.png"/>'), /<image> element is not allowed/, '<image>');
  refused(wrap('<a href="https://evil.example/"><rect/></a>'), /<a> element is not allowed/, '<a>');
  refused(wrap('<rect href="#x"/>'), /href attribute is not allowed/, 'href="#x"');
  refused(wrap('<rect href="https://evil.example/"/>'), /href attribute is not allowed/, 'external href');
  refused(wrap('<rect xlink:href="https://evil.example/"/>'), /xlink:href attribute is not allowed/, 'xlink:href');
  refused(wrap('<rect xlink:href="#x"/>'), /xlink:href attribute is not allowed/, 'xlink:href="#x"');
  refused(wrap('<rect xml:space="preserve"/>'), /xml:space attribute is not allowed/, 'another prefix');
});

test('script and data URLs, CSS expressions and non-local url() are refused, however they are spelled', () => {
  refused(wrap('<rect fill="javascript:alert(1)"/>'), /script or data URL/, 'javascript:');
  refused(wrap('<rect fill="JavaScript:alert(1)"/>'), /script or data URL/, 'mixed-case javascript:');
  refused(wrap('<rect fill="java&#9;script:alert(1)"/>'), /script or data URL/, 'a tab inside the scheme');
  refused(wrap('<rect fill="&#106;avascript:alert(1)"/>'), /script or data URL/, 'a numeric reference');
  refused(wrap('<rect fill="&#x6A;avascript:alert(1)"/>'), /script or data URL/, 'a hex reference');
  refused(wrap('<rect fill="data:image/svg+xml;base64,PHN2Zy8+"/>'), /script or data URL/, 'data:');
  refused(wrap('<rect fill="expression(alert(1))"/>'), /CSS expression/, 'expression(');
  refused(wrap('<rect fill="url(http://evil.example/x)"/>'), /only use url\(#id\)/, 'url(http...)');
  refused(wrap('<rect fill="URL(https://evil.example/x)"/>'), /only use url\(#id\)/, 'URL(https...)');
  refused(wrap('<rect fill="url(//evil.example/x#g)"/>'), /only use url\(#id\)/, 'protocol-relative url()');
  // Quoting variants of an otherwise local reference: not the one exact form.
  refused(wrap("<rect fill=\"url('#x')\"/>"), /only use url\(#id\)/, "url('#x')");
  refused(wrap('<rect fill="url(&quot;#x&quot;)"/>'), /only use url\(#id\)/, 'url("#x")');
  refused(wrap('<rect fill=\'url("#x")\'/>'), /only use url\(#id\)/, 'url("#x") in single quotes');
  refused(wrap('<rect fill="url( #x )"/>'), /only use url\(#id\)/, 'url( #x )');
  refused(wrap('<rect fill="url(#x) red"/>'), /only use url\(#id\)/, 'url(#x) with a fallback');
  refused(wrap('<rect fill="\\75 rl(http://evil.example/x)"/>'), /backslash/, 'a CSS escape spelling url(');
  refused(wrap('<rect id="a&lt;b"/>'), /< character/, 'an encoded <');
});

test('image-set() and quoted strings are refused: a mask can fetch an image without writing url(', () => {
  // CSS image-set() takes its URL as a quoted string, so `mask` (the CSS mask
  // shorthand, which accepts an image) could reach another origin with no url(
  // in sight. The -webkit- spelling contains the same substring.
  refused(wrap(`<rect width="10" height="10" mask="image-set('http://x/y.png' 1x)"/>`),
    /may not load another image/, 'image-set()');
  refused(wrap(`<rect width="10" height="10" mask="-webkit-image-set('http://x/y.png' 1x)"/>`),
    /may not load another image/, '-webkit-image-set()');
  refused(wrap('<rect width="10" height="10" mask="image-set(&quot;http://x/y.png&quot; 1x)"/>'),
    /may not load another image/, 'image-set() with &quot; quotes');
  refused(wrap('<rect width="10" height="10" mask="IMAGE-SET(\'http://x/y.png\' 1x)"/>'),
    /may not load another image/, 'upper-case IMAGE-SET()');
  // No allowed attribute needs a quoted string, and every CSS function that
  // takes a URL as a string needs one, so a quote is refused on its own too.
  refused(wrap(`<rect width="10" height="10" mask="src('http://x/y.png')"/>`), /quotation mark/, "src('...')");
  refused(wrap('<rect width="10" height="10" fill="&quot;red&quot;"/>'), /quotation mark/, 'an encoded quote');
});

test('DTDs, entities, CDATA and processing instructions are refused (XXE, billion laughs, stylesheets)', () => {
  const xxe = '<?xml version="1.0"?>\n<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n'
    + wrap('<title>&xxe;</title>');
  refused(xxe, /DOCTYPE and ENTITY declarations are not allowed/, 'XXE');

  let laughs = '<!DOCTYPE lolz [<!ENTITY lol "lol">';
  for (let i = 1; i <= 9; i++) laughs += `<!ENTITY lol${i} "${`&lol${i - 1 || ''};`.repeat(10)}">`;
  laughs += ']>';
  refused(laughs + wrap('<title>&lol9;</title>'), /DOCTYPE and ENTITY declarations are not allowed/, 'billion laughs');

  refused('<!doctype svg>' + wrap(''), /DOCTYPE and ENTITY/, 'a lower-case doctype');
  refused(wrap('<!ENTITY x "y">'), /DOCTYPE and ENTITY/, 'an ENTITY inside the root');
  refused(wrap('<title>&xxe;</title>'), /five standard XML entities/, 'an undeclared entity reference');
  refused(wrap('<title>&#0;</title>'), /five standard XML entities/, 'a reference to NUL');
  refused(wrap('<title><![CDATA[<script>alert(1)</script>]]></title>'), /CDATA sections are not allowed/, 'CDATA');
  refused('<?xml-stylesheet type="text/css" href="https://evil.example/x.css"?>\n' + wrap(''),
    /Processing instructions/, '<?xml-stylesheet?>');
  refused(wrap('<?php echo 1; ?>'), /Processing instructions/, 'a PI inside the root');
  refused(' <?xml version="1.0"?>' + wrap(''), /Processing instructions/, 'a declaration that is not first');
  refused('<?xml version="1.0" encoding="UTF-16"?>' + wrap(''), /XML declaration/, 'a non-UTF-8 declaration');
});

test('the root must be an <svg> in the SVG namespace with a viewBox', () => {
  refused('<html><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/></body></html>',
    /must start with an <svg> element/, 'an HTML root');
  refused('<SVG xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></SVG>', /must start with an <svg>/, '<SVG>');
  refused('plain text', /must start with an <svg>/, 'not markup at all');
  refused('<svg viewBox="0 0 1 1"></svg>', /declare the SVG namespace/, 'no namespace');
  refused('<svg xmlns="http://www.w3.org/1999/xhtml" viewBox="0 0 1 1"></svg>', /SVG namespace/, 'the XHTML namespace');
  refused(wrap('<g xmlns="http://www.w3.org/1999/xhtml"></g>'), /SVG namespace/, 'a nested namespace switch');
  refused('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://evil.example/"></svg>',
    /XLink namespace/, 'a wrong xlink namespace');
  refused('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>', /viewBox of four numbers/, 'no viewBox');
  refused('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64"></svg>', /viewBox/, 'three numbers');
  refused('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 64"></svg>', /viewBox/, 'a zero width');
  refused('<svg xmlns="http://www.w3.org/2000/svg" viewbox="0 0 64 64"></svg>', /viewbox attribute is not allowed/,
    'a lower-case viewbox');
});

test('a pathological viewBox is refused at once, not after seconds of regex backtracking', () => {
  // A run of digits with no dot once split between two quantifiers in O(n)
  // ways, so a failing match cost O(n^2): 250,000 digits held the event loop
  // for about 40 seconds, and the upload route runs this synchronously.
  const digits = '1'.repeat(250000);
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${digits}x 0 1 1"></svg>`;
  assert.ok(Buffer.byteLength(doc) <= MAX_SVG_BYTES, 'inside the size limit, so only the viewBox check stops it');
  const started = performance.now();
  refused(doc, /viewBox of four numbers/, 'a 250,000-digit viewBox');
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `refused in ${elapsed.toFixed(0)} ms`);

  // The same shape under the length cap still exercises the number grammar.
  const shortRun = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${'1'.repeat(200)}x 0 1 1"></svg>`;
  refused(shortRun, /viewBox of four numbers/, 'a 200-digit viewBox part');
  // And the ordinary number spellings still parse.
  for (const box of ['0 0 64 64', '-1.5 .5 1e2 10.', '0,0,1E+1,2.25', '+0 -0 0.5 5']) {
    assert.deepEqual(check(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"></svg>`), { ok: true }, box);
  }
});

test('nothing may follow the root, and the document must be well formed', () => {
  refused(wrap('') + '<script>alert(1)</script>', /Nothing may follow/, 'a script after the root');
  refused(wrap('') + '<!-- trailing -->', /Nothing may follow/, 'a comment after the root');
  refused(wrap('') + 'text', /Nothing may follow/, 'text after the root');
  refused(wrap('') + wrap(''), /Nothing may follow/, 'a second root');
  refused(OPEN.replace('>', '/>') + '<script/>', /Nothing may follow/, 'content after a self-closed root');
  refused(wrap('<rect width="1" width="2"/>'), /width attribute appears twice/, 'a duplicated attribute');
  refused(wrap('<rect width/>'), /quoted value/, 'an attribute without a value');
  refused(wrap('<rect width=1/>'), /quoted value/, 'an unquoted value');
  refused(wrap('<rect width="1"height="2"/>'), /malformed/, 'no whitespace between attributes');
  refused(wrap('< rect/>'), /malformed/, 'whitespace after <');
  refused(wrap('<g></g x="1">'), /malformed/, 'attributes on a closing tag');
  refused(wrap('<g>'), /does not match an open element/, 'an unclosed <g>');
  refused(OPEN + '<g>', /ends before every element is closed/, 'a missing </svg>');
  refused('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1', /ends in the middle of a tag/, 'a cut-off tag');
  refused(wrap('<rect fill="#000/>'), /ends in the middle of a tag/, 'an unterminated value');
  refused(wrap('<title>]]></title>'), /malformed/, 'a stray ]]>');
  refused(wrap('<!-- a -- b -->'), /comment/, 'a double hyphen in a comment');
  refused(wrap('<!-- unterminated'), /comment/, 'an unterminated comment');
  refused(wrap('<g>'.repeat(70) + '</g>'.repeat(70)), /nests elements too deeply/, 'pathological nesting');
});

test('the bytes themselves: NUL, invalid UTF-8, control characters, size', () => {
  refused(Buffer.from(wrap('<title>a\0b</title>')), /NUL byte/, 'a NUL byte');
  refused(Buffer.concat([Buffer.from(OPEN), Buffer.from([0xc3, 0x28]), Buffer.from('</svg>')]), /not valid UTF-8/,
    'an invalid UTF-8 sequence');
  refused(Buffer.concat([Buffer.from(OPEN), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('</svg>')]), /not valid UTF-8/,
    'an encoded surrogate');
  refused(Buffer.from(wrap('<title>a\x01b</title>')), /control characters/, 'a C0 control character');
  refused(Buffer.alloc(0), /empty/, 'an empty file');

  const filler = '<title>' + 'a'.repeat(MAX_SVG_BYTES) + '</title>';
  refused(wrap(filler), /256 KB or smaller/, 'a file over 256 KB');
  const atLimit = wrap('<title>' + 'a'.repeat(MAX_SVG_BYTES - Buffer.byteLength(wrap('<title></title>'))) + '</title>');
  assert.equal(Buffer.byteLength(atLimit), MAX_SVG_BYTES);
  assert.deepEqual(check(atLimit), { ok: true }, 'exactly 256 KB is allowed');
  assert.equal(validateSvg('not a buffer').ok, false);
});

test('every reason is a short plain sentence, and the lists are exact and case sensitive', () => {
  const reasons = [
    check(wrap('<script/>')).reason,
    check('<!DOCTYPE x>').reason,
    check(wrap('<rect fill="url(http://x)"/>')).reason,
    check(Buffer.from([0xff])).reason,
  ];
  for (const reason of reasons) {
    assert.ok(reason.length < 120, reason);
    assert.match(reason, /\.$/, 'ends as a sentence');
    assert.doesNotMatch(reason, new RegExp(String.fromCharCode(0x2014)), 'no em dash in copy an admin reads');
  }

  assert.equal(ALLOWED_ELEMENTS.length, 17);
  assert.equal(ALLOWED_ATTRIBUTES.length, 46);
  for (const name of ['script', 'style', 'foreignObject', 'use', 'image', 'a', 'text', 'animate', 'set', 'iframe']) {
    assert.ok(!ALLOWED_ELEMENTS.includes(name), `<${name}> stays off the list`);
  }
  for (const name of ['style', 'href', 'xlink:href', 'onload', 'class', 'xml:space', 'filter']) {
    assert.ok(!ALLOWED_ATTRIBUTES.includes(name), `${name} stays off the list`);
  }
  assert.ok(ALLOWED_ELEMENTS.includes('linearGradient') && !ALLOWED_ELEMENTS.includes('lineargradient'));
});
