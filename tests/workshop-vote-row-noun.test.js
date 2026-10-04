'use strict';

// #2480: one noun for a vote row across the Workshop's row sheets.
//
// A vote row is a CHANGE everywhere the Workshop talks about it — the item
// summary ("No plain-language summary was written for this change."), the
// Ask sheet's title and its screen-reader label ("Ask about this change") —
// except in the Comments sheet, whose subtitle read "on this proposal". Same
// row, same sheet stack, two words for it, and "proposal" is also the name
// of a different thing on this board (the card in the review lane).
//
// The rule this pins is the vocabulary, not one string: within the Workshop
// sheets, a vote row is a change and an issue is an issue.
//
// Out of scope, deliberately: dev-card.tsx's "Edit this proposal title"
// tooltip. That is the CARD, not a Workshop row sheet, and there the thing
// being edited really is the pull request's title.
//
// Run with: node --test tests/workshop-vote-row-noun.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/dev-board/workshop/workshop.tsx'), 'utf8'
);

test('no Workshop row sheet calls a vote row a proposal', () => {
  const hits = [...SRC.matchAll(/\bthis proposal\b/g)]
    .map((m) => SRC.slice(0, m.index).split('\n').length);
  assert.deepEqual(hits, [],
    `a vote row is a "change" in these sheets; lines: ${hits.join(', ')}`);
});

test('the sheets that name a vote row all say "change"', () => {
  // The Comments sheet subtitle — the one that disagreed.
  assert.match(SRC, /kind === 'vote' \? 'on this change' : 'on this request'/);
  // The two that were already right, kept so the pair cannot drift apart.
  assert.match(SRC, /kind === 'vote' \? 'Ask about this change' : 'Ask about this request'/);
  assert.match(SRC, /Ask about this change<\/label>/);
  assert.match(SRC, /No plain-language summary was written for this change\./);
});

test('an issue row is still an issue', () => {
  assert.match(SRC, /'on this request'/);
  assert.match(SRC, /'Ask about this request'/);
  assert.match(SRC, /This request has no description\./);
});
