// #3566: every page bounces, however little it holds.
//
// "Should be able to over scroll on home page down, doesn't feel as native
// because can't." #3591 (#3565) gave the foot of a page the document scrolls
// in a phone browser its bounce back, and All communities still had none:
// that screen is not one the document pages (browser-scroll.ts PAGES), so it
// scrolls itself, in the phone browser and the installed app alike, and iOS
// rubber-bands a scroller only when it has something to scroll. Measured at
// 390x664 (iPhone agent, touch): #workshop-screen 572/572 in the browser and
// 620/620 installed (scrollHeight/clientHeight), #profile-proposals-screen the
// same, the Messages list 457/457. After the rule below, 573/572, 621/620 and
// 458/457, and an upward touch drag moves each by its pixel (0 before).
//
// The mechanism is #3544's for a project's short tabs (community-hub.test.js):
// a 1px box hung 1px below the scroller's bottom edge. A page opts in with
// `data-page-bounce` on its scroller. This file holds the shell's screen
// roots (App.SCREEN_IDS) against that attribute, so a new screen root either
// carries it or is named in EXEMPT below with the reason it does not.
//
// Run with: node --test tests/page-overscroll.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CSS = read('public/css/app.css');
const APP_JS = read('public/js/app.js');

// Screen roots that do not carry the attribute themselves, and why.
const EXEMPT = {
  'app-view': 'A project page scrolls in #dev-forum-scroll, which #3544 gives its pixel for the growing tabs (Hub, Workshop); Needs you and Discussion are fitted on purpose and scroll inside. A running app is somebody else\'s document.',
  'messages-screen': 'The root is `overflow: hidden`; the list scrolls in .messages-list-scroll, which carries the attribute (asserted below). A thread is a chat.',
  'agent-session-screen': 'A chat with an agent: the transcript opens on its newest line and stays there. It is not a page.',
};

function screenIds() {
  const m = APP_JS.match(/SCREEN_IDS:\s*\[([^\]]*)\]/);
  assert.ok(m, 'App.SCREEN_IDS is where app.js lists the screen roots');
  return [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}
const SOURCES = walk(path.join(ROOT, 'frontend', 'src')).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

// The whole JSX opening tag around `marker`: back to its `<name`, forward to
// the `>` that closes it outside any `{ … }` expression or string.
function openingTag(text, at) {
  const start = text.lastIndexOf('<', at);
  let depth = 0;
  let quote = null;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function tagsWith(marker) {
  const found = [];
  for (const { file, text } of SOURCES) {
    let at = text.indexOf(marker);
    while (at !== -1) {
      const tag = openingTag(text, at);
      if (tag) found.push({ file: path.relative(ROOT, file), tag });
      at = text.indexOf(marker, at + marker.length);
    }
  }
  return found;
}

test('#3566: every screen root is a page that bounces, or says why it is not', () => {
  const ids = screenIds();
  assert.ok(ids.length >= 10 && ids.includes('workshop-screen') && ids.includes('home-screen'),
    `the enumeration is not vacuous: ${ids.join(', ')}`);
  const missing = [];
  for (const id of ids) {
    if (EXEMPT[id]) continue;
    const tags = tagsWith(`id="${id}"`);
    if (!tags.length) { missing.push(`${id}: no component renders it`); continue; }
    for (const { file, tag } of tags) {
      if (!/\sdata-page-bounce=""/.test(tag)) missing.push(`${id} (${file})`);
    }
  }
  assert.deepEqual(missing, [],
    'a screen root without `data-page-bounce` does not rubber-band while it is short (app.css, "EVERY PAGE BOUNCES"). '
    + 'Add the attribute, or name the root in EXEMPT with the reason it is not a page:\n  ' + missing.join('\n  '));
  for (const id of Object.keys(EXEMPT)) {
    assert.ok(ids.includes(id), `EXEMPT names ${id}, which is no longer a screen root: drop it`);
  }
});

test('#3566: All communities and the Messages list carry the attribute', () => {
  // All communities is the screen the report named; the Messages list is the
  // one page that scrolls inside its root rather than as it.
  const workshop = tagsWith('id="workshop-screen"');
  assert.equal(workshop.length, 1);
  assert.match(workshop[0].tag, /data-page-bounce=""/);
  const list = tagsWith('className="messages-list-scroll platform-safe-scroll"');
  assert.equal(list.length, 1, 'one Messages list');
  assert.match(list[0].tag, /data-page-bounce=""/);
  assert.equal(list[0].file, path.join('frontend', 'src', 'features', 'messages', 'index.tsx'));
});

test('#3566: the pixel is hung below the scroller, on a touch screen, only where the scroller is the page', () => {
  const block = CSS.match(/@media \(pointer: coarse\) \{\s*html:not\(\[data-browser-scroller\]\) \[data-page-bounce\] \{[\s\S]*?\n\}\n/);
  assert.ok(block, 'the rule sits in a (pointer: coarse) block, scoped to html:not([data-browser-scroller])');
  const rule = block[0];
  assert.match(rule, /html:not\(\[data-browser-scroller\]\) \[data-page-bounce\] \{\s*position: relative;\s*\}/,
    'the scroller is the containing block (the Messages list was not one)');
  const after = rule.match(/html:not\(\[data-browser-scroller\]\) \[data-page-bounce\]::after \{([^}]*)\}/);
  assert.ok(after, 'the ::after carries the pixel');
  assert.match(after[1], /content: '';/);
  assert.match(after[1], /position: absolute;/);
  assert.match(after[1], /bottom: -1px;/, 'one pixel BELOW the bottom edge: that is the range');
  assert.match(after[1], /height: 1px;/);
  assert.match(after[1], /pointer-events: none;/);
  assert.doesNotMatch(after[1], /:has/, 'the main rule must not depend on :has(), or an engine without it drops the whole thing');
  // The Communities Needs you feed is fitted to the screen on purpose (#3516).
  assert.match(rule, /\[data-page-bounce\]:has\(\[data-workshop-pane="needs"\]\)::after \{\s*content: none;\s*\}/);
});

test('#3566: the paged document keeps #3591\'s foot and none of this pixel', () => {
  // When the document pages a screen (data-browser-scroller), its bounce is
  // #3591's `data-browser-past-top`; the pixel would only lengthen the page.
  assert.match(CSS, /html\[data-browser-scroller\]\[data-browser-past-top\],\s*html\[data-browser-scroller\]\[data-browser-past-top\] body \{\s*overscroll-behavior-y: contain;/);
  assert.doesNotMatch(CSS, /html\[data-browser-scroller\][^{]*\[data-page-bounce\][^{]*::after/);
});
