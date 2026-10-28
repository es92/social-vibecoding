'use strict';

// Three shell stylesheet rules that cost a phone smoothness (public/css/app.css):
//
//   - Home's app tiles flashed the kit's :active scale + dim on every flick
//     that started on one; they take the #1928 hold-back.
//   - A Messages row kept its hover tint after a tap on a touch screen (WebKit
//     keeps :hover on the last element tapped).
//   - The dev chat pane smooth-scrolled every programmatic follow-to-bottom,
//     so each streamed write restarted an animation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const CSS = read('public/css/app.css');
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

// Every top-level `@media <query> { ... }` block, brace-balanced.
function mediaBlocks(css, query) {
  const out = [];
  const re = new RegExp(`@media ${query.replace(/[()]/g, '\\$&')}\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out;
}

// Rules outside every @media block.
const TOP_LEVEL = RULES.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');

test('Home\'s app tiles hold their press back on touch, like the Workshop rows (#1928)', () => {
  const grid = read('frontend/src/features/home/app-grid.tsx');
  assert.match(grid, /className=\{`app-card app-card-draggable/, 'the tile is .app-card');
  assert.match(grid, /\n\s*role="button"\n/, 'and role="button", which the kit presses');
  const block = mediaBlocks(RULES, '(hover: none)').find((b) => /\.app-card\[role="button"\]:active/.test(b));
  assert.ok(block, 'a touch-only block names the tile\'s press');
  assert.match(block, /\.app-card\[role="button"\]:active \{\s*transition: transform 0s linear 120ms, filter 0s linear 120ms;\s*\}/,
    'the kit\'s scale and dim engage after 120ms, with no easing');
  assert.doesNotMatch(TOP_LEVEL, /\.app-card\[role="button"\]:active/, 'a mouse keeps the instant press');
});

test('a Messages row tints on hover only where a pointer can hover', () => {
  assert.doesNotMatch(TOP_LEVEL, /\.messages-conversation-row:hover\s*[,{]/,
    'no unconditional hover tint for WebKit to leave stuck after a tap');
  const hover = mediaBlocks(RULES, '(hover: hover)').find((b) => /\.messages-conversation-row:hover \{/.test(b));
  assert.ok(hover, 'the tint lives in a (hover: hover) block');
  assert.match(hover, /\.messages-conversation-row:hover \{ background: var\(--messages-selected\); \}/);
  assert.match(TOP_LEVEL, /\.messages-conversation-active \{ background: var\(--messages-selected\); \}/,
    'the open conversation is marked everywhere');
});

test('the dev chat pane does not smooth-scroll its own follow-to-bottom', () => {
  assert.doesNotMatch(RULES, /\.dc-messages-container\s*\{[^}]*scroll-behavior/,
    'every programmatic scrollTop write would restart a smooth scroll');
});
