'use strict';

// #2479: the dev board draws six glyphs that carry no information a reader
// needs — two chevrons that mean "this row opens", a caret that duplicates
// `aria-expanded`, two pencils on buttons that are already labelled, and the
// tick marking your own pick. A screen reader announcing them adds noise
// between the row's text and the next row, so each is marked
// `aria-hidden="true"` and the svg leaves the accessibility tree.
//
// The tick is the one that could NOT simply be hidden. It was the ONLY
// signal that an option is your current pick — the row carried that fact in
// `data-attr-opt-mine`, which is a data attribute and reaches no assistive
// technology. Hiding the glyph alone would have deleted the state; the row
// gains `aria-pressed` so the state is announced properly instead of drawn
// only in violet.
//
// Deliberately NOT in the six: the model tick in auto-session-modal.tsx. Its
// parent span is already `aria-hidden` and the real state rides on a
// visually-hidden `<input type="radio" checked>`, so it is out of the tree
// already and its selection is announced by the radio.
//
// Run with: node --test tests/dev-board-decorative-glyphs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const F = {
  attr: 'frontend/src/features/dev-board/attr-popover.tsx',
  frame: 'frontend/src/features/dev-board/board-frame.tsx',
  card: 'frontend/src/features/dev-board/card/dev-card.tsx',
  rows: 'frontend/src/features/dev-board/card/list-rows.tsx',
  head: 'frontend/src/features/dev-board/topic/topic-head.tsx',
  modal: 'frontend/src/features/dev-board/modals/auto-session-modal.tsx',
};

/** The opening tag for the first `<Name` in `src`, across line breaks. */
function openingTag(src, name) {
  const at = src.indexOf(`<${name}`);
  assert.notEqual(at, -1, `${name} should still be rendered`);
  const end = src.indexOf('>', at);
  assert.notEqual(end, -1, `${name} tag should close`);
  return src.slice(at, end + 1);
}

test('the two row chevrons are out of the accessibility tree', () => {
  assert.match(openingTag(read(F.frame), 'ChevronRightIcon'), /aria-hidden="true"/);
  // dev-card's is the exported `Chevron()` helper, the tap-through affordance.
  const card = read(F.card);
  const chevron = card.slice(card.indexOf('export function Chevron('));
  assert.match(openingTag(chevron, 'ChevronRightIcon'), /aria-hidden="true"/);
});

test('the archived caret is hidden — aria-expanded already says it', () => {
  const rows = read(F.rows);
  assert.match(openingTag(rows, 'ChevronRightIcon'), /aria-hidden="true"/);
  assert.match(rows, /aria-expanded=\{open\}/, 'the state stays on the button');
});

test('both edit pencils are hidden, and their buttons keep their labels', () => {
  for (const [key, label] of [[F.card, 'Edit title'], [F.head, 'Edit request']]) {
    const src = read(key);
    assert.match(openingTag(src, 'PencilSquareIcon'), /aria-hidden="true"/);
    assert.ok(src.includes(`aria-label="${label}"`), `${key}: button keeps its name`);
  }
});

test('the "my pick" tick is hidden, and the row announces the state instead', () => {
  const src = read(F.attr);
  assert.match(openingTag(src, 'CheckIcon'), /aria-hidden="true"/);
  // The fact the glyph used to carry, now on the control itself.
  assert.match(src, /aria-pressed=\{!!option\.mine\}/,
    'hiding the tick must not delete "this is your pick"');
});

test('the model tick is left alone — it is already out of the tree', () => {
  const src = read(F.modal);
  const tick = src.indexOf('<CheckIcon');
  assert.notEqual(tick, -1);
  const before = src.slice(0, tick);
  const span = before.lastIndexOf('<span');
  assert.match(before.slice(span), /aria-hidden="true"/,
    'its parent span already hides it');
  assert.match(src, /type="radio"[\s\S]{0,200}checked=\{selected\}/,
    'and the radio is what announces the selection');
});
