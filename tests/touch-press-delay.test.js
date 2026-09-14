// Cards do not flash a pressed state while the board is scrolled (#1928).
//
// On a touch screen every scroll begins as a touch on some card, and the
// press treatments (the dev board's --dev-press fill, the native kit's
// scale + brightness dim on role="button") engaged instantly — so flicking
// down the board lit up whichever card the finger landed on. The fix holds
// the press back ~120ms on `(hover: none)` devices only: a scroll clears
// :active inside that window and nothing is drawn, a tap still tints.
//
// Pinned here, against public/css/app.css:
//   - the delay lives in a `(hover: none)` block, so desktop keeps the
//     instant press the rule above it was written for;
//   - it covers all three properties the press changes — background-color
//     (our fill), transform and filter (the kit's) — or one of them still
//     flashes;
//   - it reaches the folded row, the open card, and every role="button" card
//     in the board's scroll container (the session rows);
//   - the instant desktop press rule is still there, untouched.
//
// Run with: node --test tests/touch-press-delay.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

// Every top-level `@media (hover: none) { ... }` block, brace-balanced.
function hoverNoneBlocks(css) {
  const out = [];
  const re = /@media \(hover: none\)\s*\{/g;
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

const pressBlock = hoverNoneBlocks(CSS).find((b) => /:active/.test(b) && /120ms/.test(b));

test('a touch-only block delays the card press', () => {
  assert.ok(pressBlock, 'an @media (hover: none) block carries the delayed :active transition');
});

test('the delay covers the fill, the scale and the dim', () => {
  const t = /transition:\s*([^;]+);/.exec(pressBlock);
  assert.ok(t, 'the block sets a transition');
  for (const prop of ['background-color', 'transform', 'filter']) {
    assert.match(t[1], new RegExp(`${prop} 0s linear 120ms`),
      `${prop} engages after the delay, with no easing`);
  }
});

test('it reaches the folded row, the open card and the board\'s role="button" cards', () => {
  assert.match(pressBlock, /\.dev-ws-row:active:not\(:has\(/);
  assert.match(pressBlock, /\.dev-ws-rowwrap-open \.gc-vote-item:active:not\(:has\(/);
  assert.match(pressBlock, /#dev-forum-scroll \[role="button"\]:active/);
  // The :has() exclusion lists name button:active on purpose; strip them
  // before asking whether a bare `button:active` selector was delayed.
  const selectors = pressBlock.replace(/:not\(:has\([\s\S]*?\)\)/g, '');
  assert.doesNotMatch(selectors, /(^|,)\s*button:active/,
    'real buttons keep their instant press');
});

test('desktop keeps the instant press', () => {
  // Outside any media query, the press rule still says `transition: none`.
  const outside = CSS.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  assert.match(outside,
    /\.dev-ws-rowwrap-open \.gc-vote-item:active:not\(:has\([\s\S]*?\)\) \{\s*background: var\(--dev-press\);[\s\S]*?transition: none;\s*\}/);
});
