// The home feed scrolls one way, and CSS does not give you that for free.
//
// ── The bug ────────────────────────────────────────────────────────────
//
// On a phone the home screen could be dragged left and right as well as up
// and down: a swipe sideways slid the whole feed a couple of pixels and
// rubber-banded it back. Two things had to be true at once.
//
//   1. #home-screen is `flex-1 overflow-y-auto` and nothing else, and CSS
//      turns that into a scroller on BOTH axes — `overflow` computes
//      `visible` to `auto` on one axis the moment the other stops being
//      `visible`. So the feed had always been a horizontal scroll container
//      by accident, waiting for something inside it to be a pixel too wide.
//
//   2. On a phone something is. `.un-touch-target` (native.css) grows any
//      control to a 44px hit box with an absolutely positioned ::after
//      CENTRED on it, so the ⋮ that opens an area's menu — `w-4`, 16px, and
//      the last thing in its row — reaches 14px past itself on each side.
//      The section's gutter is `px-3`, i.e. 12px. 12 < 14, so the box landed
//      2px beyond a 390px viewport and the screen measured 392px of
//      scrollWidth.
//
// ── What is pinned, and what is deliberately not ───────────────────────
//
// The FIX is the container: a vertical feed says so, rather than being one
// as long as nothing inside it happens to overhang. That is what these
// assert. The overhang itself is not a bug and is not pinned — it is a hit
// area, it is meant to hang off its control, and clipping costs 2px from the
// outside of a target that still extends 12px past a 16px button on that
// side.
//
// The original hide-menu control is now retired (#1801). The feed must
// still contain horizontal overflow from any remaining or future content.
//
// Run with: node --test tests/home-vertical-scroll-only.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CSS = read('public/css/app.css');
const HOME = read('frontend/src/features/home/index.tsx');

/** A rule's body, by exact selector text (multi-line selectors included). */
function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector.replace(/\n/g, ' ')}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

const FEED = rule('#home-screen,\n#auth-landing-scroll');

// ── The fix ────────────────────────────────────────────────────────────

test('the home feed is not a horizontal scroll container', () => {
  assert.match(FEED, /overflow-x:\s*hidden/,
    '#home-screen and #auth-landing-scroll must state overflow-x, because '
    + 'overflow-y alone silently makes them scrollable sideways too');

  // Not `clip`, and the comment beside it says why: CSS Overflow 3 computes a
  // `clip` beside an `auto` on the other axis to `hidden` anyway, so writing
  // it would be a longer way to say the same thing. If a future edit does
  // reach for it, this is the note that saves the experiment.
  assert.doesNotMatch(FEED, /overflow-x:\s*clip/,
    'clip computes to hidden next to a scrolling axis — it buys nothing here');

  // The y axis is the point of the element and must not be touched.
  assert.doesNotMatch(FEED, /overflow-y:\s*hidden/, 'the feed still scrolls');
  assert.match(FEED, /overscroll-behavior-y:\s*contain/,
    'and it keeps the pull-to-refresh containment it already had');
});

test('the screen root still declares only its vertical scroll in markup', () => {
  // The fix lives in app.css beside the gesture rule it belongs with, not as
  // a utility on the island — so the class list is the one it always was.
  // If someone later adds `overflow-x-hidden` here too, that is fine, but the
  // root must never be left with overflow-y alone and no rule behind it.
  assert.match(HOME, /id="home-screen"[\s\S]{0,120}?overflow-y-auto/,
    '#home-screen is still the y-axis scroller');
});

// The arithmetic test for the former 16px hide-menu control was retired
// with that unused component (#1801). Keep the feed overflow contract above.

// ── …and nothing inside the feed may deny that axis (#1762) ────────────
//
// The rule above makes the feed scroll one way. This is the other half of
// the same claim, and it is the half that was actually broken: a DESCENDANT
// can take the feed's axis away from it. `touch-action` is not a preference
// about which direction an element would like — it is the complete set of
// gestures the browser may run for a touch that STARTS on it, intersected
// down the ancestor chain, so a nested horizontal rail declaring `pan-x`
// denies the vertical pan outright rather than passing it up to #home-screen.
//
// Discover's card rail did exactly that, under a comment asserting the
// opposite ("a VERTICAL drag still reaches the page"). Two rails of ~13rem
// cards is most of the Discover block, so a finger landing on a card could
// not scroll the page at all.

/** Every `touch-action` DECLARATION in app.css, with the selector it is in. */
function touchActionRules() {
  // Comments first, and not as a nicety: this file explains its touch-action
  // rules at length, quoting the values, so a scan over the raw text finds
  // prose and reports it as a rule.
  const src = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf('touch-action:', from);
    if (i < 0) break;
    from = i + 'touch-action:'.length;
    const open = src.lastIndexOf('{', i);
    const end = src.indexOf(';', i);
    if (open < 0 || end < 0) continue;
    // The selector is whatever sits between the previous block and this one's
    // brace — enough to name the rule in a failure message and to tell a
    // `.home-` element from anything else.
    const head = src.slice(0, open);
    const start = Math.max(head.lastIndexOf('}'), head.lastIndexOf('{'));
    const selector = src.slice(start + 1, open).replace(/\s+/g, ' ').trim();
    out.push({ selector, value: src.slice(i + 'touch-action:'.length, end).trim() });
  }
  return out;
}

/** Does this value still let the browser pan the page vertically? */
const allowsPanY = (v) => /\bpan-y\b/.test(v) || v === 'auto' || v === 'manipulation';

test('no rule on a home-feed element denies the vertical pan', () => {
  // The same trap, generalised, so it cannot come back on the next rail.
  // Scoped to `.home-` selectors: the sheets a thousand lines up narrow
  // touch-action deliberately and correctly (the switcher's sheet has no
  // vertical scroller at all), and this is not a claim about them.
  const offenders = touchActionRules()
    .filter((r) => /(^|[\s,>+~])\.home-/.test(r.selector))
    .filter((r) => !allowsPanY(r.value))
    .map((r) => `${r.selector} { touch-action: ${r.value} }`);
  assert.deepEqual(offenders, [],
    'a home-feed element that omits pan-y takes the feed’s own gesture away '
    + 'from every touch that starts on it');
});
