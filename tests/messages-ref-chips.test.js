'use strict';

// #3770: `#N` chips in Messages.
//
// The app chat sends a `.gc-ref` press to its activity drawer; Messages has
// no drawer, so a chip there did nothing while app.css still drew it as a
// control (a pointer, an underline on hover), in an emerald that read at
// 1.6:1 on the light sheet. Pinned here:
//
//   1. A message that names its project (a Homeroom bot message carries its
//      request's app) chips `#N` as a real link to that project's request,
//      at the address the server's own cards use; every other chip stays a
//      span, and a `PR#N` is never a link.
//   2. The row hands the bot message's project to the markdown, and a press
//      on a chip records the conversation as where it was opened from, as a
//      shared card does.
//   3. app.css draws a span chip in Messages as text and a link chip as a
//      link, and the issue ink is --state-ok: unchanged in dark, and at least
//      4.5:1 in light on the sheet. The app chat's chips are untouched.
//
// Run with: node --test tests/messages-ref-chips.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const CHANNELS = 'frontend/src/features/messages/channels.ts';
const CSS = read('public/css/app.css');

// ── A DOM just big enough for decorateRefs ──────────────────────────────
// Text nodes, elements and fragments, and a serializer for the assertions.
// No parsing: a test builds the sanitized markup the way marked emits it.

function makeDocument() {
  const doc = {};
  class Node {
    constructor() { this.parentNode = null; this.childNodes = []; this.ownerDocument = doc; }
    appendChild(node) {
      const nodes = node.isFragment ? node.childNodes.splice(0) : [node];
      for (const n of nodes) { n.parentNode = this; this.childNodes.push(n); }
      return node;
    }
    replaceChild(next, old) {
      const nodes = next.isFragment ? next.childNodes.splice(0) : [next];
      const at = this.childNodes.indexOf(old);
      this.childNodes.splice(at, 1, ...nodes);
      for (const n of nodes) n.parentNode = this;
      old.parentNode = null;
    }
  }
  class Text extends Node {
    constructor(value) { super(); this.nodeType = 3; this.nodeValue = String(value); }
  }
  class Fragment extends Node {
    constructor() { super(); this.nodeType = 11; this.isFragment = true; }
  }
  class Element extends Node {
    constructor(tag) { super(); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = []; }
    set className(value) { this.setAttribute('class', value); }
    setAttribute(name, value) {
      const found = this.attrs.find((a) => a[0] === name);
      if (found) found[1] = String(value); else this.attrs.push([name, String(value)]);
    }
    set textContent(value) { this.childNodes = []; this.appendChild(new Text(value)); }
  }
  doc.createElement = (tag) => new Element(tag);
  doc.createTextNode = (value) => new Text(value);
  doc.createDocumentFragment = () => new Fragment();
  return doc;
}

function html(node) {
  if (node.nodeType === 3) return node.nodeValue.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const inner = node.childNodes.map(html).join('');
  if (node.isFragment || node.root) return inner;
  const tag = node.tagName.toLowerCase();
  const attrs = node.attrs.map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`).join('');
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/** A message body as marked hands it over: a paragraph, a code span, and a link. */
function body(doc, text) {
  const root = doc.createElement('div');
  root.root = true;
  const p = doc.createElement('p');
  p.appendChild(doc.createTextNode(text));
  const code = doc.createElement('code');
  code.appendChild(doc.createTextNode('#3'));
  const a = doc.createElement('a');
  a.setAttribute('href', 'https://example.test/');
  a.appendChild(doc.createTextNode('#4'));
  p.appendChild(code);
  p.appendChild(a);
  root.appendChild(p);
  return root;
}

// ── 1. The chips ────────────────────────────────────────────────────────

test('in a message that names its project, #N is a link to that project\'s request; PR#N and every other chip are not', () => {
  const { decorateRefs, issueRefHref } = loadTsx(CHANNELS);
  assert.equal(issueRefHref('ear-trainer-9aee0d', '14'), '#app/ear-trainer-9aee0d/dev/issues/14',
    'the address the server\'s object cards give a request');
  assert.equal(issueRefHref('ear trainer', '007'), '#app/ear%20trainer/dev/issues/7');

  const doc = makeDocument();
  const bot = body(doc, 'Filed as #14, beside PR#9 and @ada. ');
  decorateRefs(bot, new Set(), 'ada', 'ear-trainer-9aee0d');
  assert.equal(html(bot),
    '<p>Filed as <a href="#app/ear-trainer-9aee0d/dev/issues/14" class="gc-ref gc-ref-issue" data-ref-type="issue" data-ref-number="14">#14</a>, '
    + 'beside <span class="gc-ref gc-ref-pr" data-ref-type="pr" data-ref-number="9">PR#9</span> and '
    + '<a class="gc-mention gc-mention-self" href="#leaderboard/users/ada" data-mention="ada">@ada</a>. <code>#3</code><a href="https://example.test/">#4</a></p>',
    'a real link, the chip\'s classes and data kept; a PR stays text; code and links are left alone');

  const person = body(doc, 'see #14');
  decorateRefs(person, new Set(), 'ada');
  assert.match(html(person), /<p>see <span class="gc-ref gc-ref-issue" data-ref-type="issue" data-ref-number="14">#14<\/span>/,
    'with no project named, the chip names the ref without pretending to navigate');
  const none = body(doc, 'see #14');
  decorateRefs(none, new Set(), 'ada', null);
  assert.doesNotMatch(html(none), /<a href="#app/);
});

test('#4029: @name is a link to the person\'s page in Messages; Homeroom bot\'s stays text', () => {
  const { decorateRefs, personHref } = loadTsx(CHANNELS);
  assert.equal(personHref('ada'), '#leaderboard/users/ada', 'the address a project\'s contributors open');
  const doc = makeDocument();
  const msg = body(doc, 'ping @bob, @Homeroom bot and @homeroom_bot ');
  decorateRefs(msg, new Set(), 'ada');
  const out = html(msg);
  assert.match(out, /<a class="gc-mention" href="#leaderboard\/users\/bob" data-mention="bob">@bob<\/a>/);
  assert.match(out, /<span class="gc-mention">@Homeroom bot<\/span>/);
  assert.match(out, /<span class="gc-mention">@homeroom_bot<\/span>/);
  assert.match(out, /<code>#3<\/code><a href="https:\/\/example\.test\/">#4<\/a>/, 'code and links are left alone');
});

// ── 2. Where the project comes from, and where a press records ──────────

test('the row hands a bot message\'s project to its markdown, and a chip press records where it was opened from', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /<MessageMarkdown content=\{message\.content\} channels=\{channels\} appSlug=\{botMeta\(message\)\?\.appSlug\} requestColors=\{!!botMeta\(message\)\} \/>/,
    'only the bot\'s own message (botMeta reads it off a bot sender only), whose request numbers wear their tag colour');
  assert.match(read('frontend/src/features/messages/bot-question.tsx'),
    /export function botMeta\(message: ConversationMessage\): HomeroomBotMeta \| null \{\s*if \(!message\.sender\.bot\) return null;/);

  const format = read('frontend/src/features/messages/format.tsx');
  const fn = format.slice(format.indexOf('export function MessageMarkdown('), format.indexOf('\n}\n', format.indexOf('export function MessageMarkdown(')));
  assert.match(fn, /decorateRefs\(root, channels \|\| NO_CHANNELS, me, appSlug\);[\s\S]*?return root\.innerHTML;\s*\}, \[content, channels, appSlug, requestColors\]\);/,
    'the chips are rebuilt when the project changes, or whether they wear their request colours');
  assert.match(fn, /const chip = \(event\.target as Element \| null\)\?\.closest\?\.\('a\.gc-ref\[href\]'\);/);
  assert.match(fn, /\n    recordObjectOrigin\(event, href\);\n  \};/, 'any chip it does not handle in place (#4241) records its origin');
  assert.match(fn, /onClick=\{appSlug \? openRef : undefined\} dangerouslySetInnerHTML=\{inner\}/,
    'no handler on a message that names no project');
});

// ── 3. How they are drawn ───────────────────────────────────────────────

function hex(value) {
  const h = value.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const over = (rgb, alpha, ground) => rgb.map((c, i) => Math.round(c * alpha + ground[i] * (1 - alpha)));
const token = (block, name) => {
  const m = block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(m, `${name} is a hex token`);
  return m[1];
};

test('in Messages a chip with nowhere to go is drawn as text, a link chip as a link, and the issue ink reads in light', () => {
  assert.match(CSS, /\.messages-markdown span\.gc-ref \{ cursor: auto; \}/);
  assert.match(CSS, /@media \(hover: hover\) \{\s*\.messages-markdown a\.gc-ref:hover \{ text-decoration: underline; \}\s*\.messages-markdown span\.gc-ref:hover \{ filter: none; text-decoration: none; \}\s*\}/);
  assert.match(CSS, /\.messages-markdown a\.gc-ref \{ text-decoration: none; \}/, 'not the underline a markdown link wears');
  // The app chat's chips keep their pointer: its drawer opens from them.
  assert.match(CSS, /\.gc-ref \{\s*display: inline-flex;[^}]*cursor: pointer;/);

  // The ink is --state-ok, which in dark IS the chip's own emerald: dark is unchanged.
  assert.match(CSS, /\.messages-markdown \.gc-ref-issue \{ color: var\(--state-ok\); \}/);
  const light = CSS.slice(CSS.indexOf('--state-ok:'), CSS.indexOf('--state-ok:') + 40);
  const dark = CSS.slice(CSS.lastIndexOf('--state-ok:'), CSS.lastIndexOf('--state-ok:') + 40);
  assert.deepEqual(hex(token(dark, '--state-ok')), [52, 211, 153], 'rgb(52, 211, 153), the emerald .gc-ref-issue draws');
  assert.match(CSS, /\.gc-ref-issue \{\s*color: rgb\(52, 211, 153\);\s*background: rgba\(16, 185, 129, 0\.12\);/);

  // In light, on a lighter wash, the green reads at AA on the sheet and on white.
  const wash = CSS.match(/html:not\(\.dark\) \.messages-markdown \.gc-ref-issue \{ background: rgba\(16, 185, 129, ([0-9.]+)\); \}/);
  assert.ok(wash, 'the wash is lightened in light only');
  const ink = hex(token(light, '--state-ok'));
  for (const ground of [token(CSS, '--dc-sheet-solid'), '#ffffff']) {
    const chip = over([16, 185, 129], Number(wash[1]), hex(ground));
    assert.ok(contrast(ink, chip) >= 4.5, `${contrast(ink, chip).toFixed(2)}:1 on ${ground}`);
  }
});
