'use strict';
// #6508: "scrolling the long proposal list on a trackpad, it jerks back up a
// few rows on its own now and then. only on the inbox, other lists are
// smooth" (Maztrilover, 9 Nov 2026).
//
// The inbox re-sorts on its own clock while it is read: a change moving
// stage, a bot reply or a new message rebuilds it (./inbox.ts buildInbox),
// and the browser's own scroll anchoring carried scrollTop with the row it
// had picked as its anchor, which with a trackpad scroll in progress read as
// the list jumping back several rows.
//
// Pinned here:
//   1. which row the list holds: the first one at or below the view's top,
//      with the offset it sits at (a partly hidden row gives a negative one);
//   2. how far a live re-sort moves the scroller to put that row back;
//   3. the wiring: the rows carry `data-inbox-row`, the scroller notes the
//      row it shows and corrects after an order change, and app.css turns
//      the browser's own anchoring off on this scroller alone.
//
// Run with: node --test tests/messages-list-place.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LIST = read('frontend/src/features/messages/index.tsx');
const CSS = read('public/css/app.css');

const { firstRowInView, scrollCorrection } = loadTsx('frontend/src/features/messages/list-place.ts');

const row = (key, top, bottom) => ({ key, top, bottom });

test('firstRowInView takes the first row at or below the view top, with its offset', () => {
  assert.deepEqual(
    firstRowInView([row('a', 12, 61), row('b', 61, 110)], 0),
    { key: 'a', offset: 12 },
  );
  // A row scrolled partly past the top still holds the place, with a
  // negative offset: it is what the reader sees at the top.
  assert.deepEqual(
    firstRowInView([row('a', -20, 40), row('b', 40, 90)], 0),
    { key: 'a', offset: -20 },
  );
  // Rows entirely above the view are skipped.
  assert.deepEqual(
    firstRowInView([row('a', -90, -10), row('b', 0, 40)], 0),
    { key: 'b', offset: 0 },
  );
  // The view's top is a parameter, not always zero.
  assert.deepEqual(
    firstRowInView([row('a', -30, 8), row('b', 18, 60)], 12),
    { key: 'b', offset: 6 },
  );
  assert.equal(firstRowInView([], 0), null);
});

test('scrollCorrection moves the scroller by how far the held row travelled', () => {
  // A re-sort pushed the reader's row 72px down: put it back.
  assert.equal(scrollCorrection({ key: 'a', offset: 0 }, 72, 0), 72);
  // It came back up: follow it up.
  assert.equal(scrollCorrection({ key: 'a', offset: 0 }, -48, 0), -48);
  // Held from a partly hidden row, unchanged: nothing to do.
  assert.equal(scrollCorrection({ key: 'a', offset: -20 }, -20, 0), 0);
  // Nothing held, or the held row is gone (removed, archived, filtered out).
  assert.equal(scrollCorrection(null, 72, 0), 0);
  assert.equal(scrollCorrection({ key: 'a', offset: 0 }, null, 0), 0);
  // Sub-pixel rounding is not a move.
  assert.equal(scrollCorrection({ key: 'a', offset: 0 }, 0.4, 0), 0);
  // The view top is measured in the same coordinates as the row.
  assert.equal(scrollCorrection({ key: 'a', offset: 5 }, 25, 12), 8);
});

test('the list rows carry their inbox key, and the archived ones do not', () => {
  // Every live row kind renders the key it was given.
  assert.equal((LIST.match(/data-inbox-row=\{rowKey\}/g) || []).length, 3);
  // `inboxRow` is the one place that passes it, for all three kinds.
  assert.equal((LIST.match(/rowKey=\{entry\.key\}/g) || []).length, 3);
  // The archived chats' rows are read once per open and never re-sort.
  const archivedCall = LIST.match(/<MayorSessionRow[^>]*key=\{session\.id\}[^>]*\/>/);
  assert.ok(archivedCall, 'the archived list still draws Mayor rows');
  assert.ok(!archivedCall[0].includes('rowKey='), 'the archived rows are not held');
});

test('the scroller notes the row it shows and corrects after an order change', () => {
  assert.ok(LIST.includes("import { firstRowInView, scrollCorrection"), 'the list imports the pure place helpers');
  // The scroller is measured and writes the correction.
  assert.ok(LIST.includes('ref={scrollRef}'));
  assert.ok(LIST.includes('onScroll={readAnchor}'));
  assert.ok(LIST.includes("querySelectorAll<HTMLElement>('[data-inbox-row]')"));
  assert.ok(LIST.includes('anchor.current = firstRowInView(rows, 0)'));
  assert.ok(LIST.includes('el.scrollTop += delta'));
  // At the very top nothing is held, so new rows show there.
  assert.ok(LIST.includes('if (el.scrollTop <= 0) { anchor.current = null; return; }'));
  // The reader moving the list (search, fold, older, archived) drops the hold.
  assert.ok(LIST.includes('lastShape.current === listShape'));
});

test('the browser\'s own anchoring is off on the list, and only there', () => {
  const listRule = CSS.match(/\.messages-list-scroll \{[^}]*\}/);
  assert.ok(listRule, 'the .messages-list-scroll rule exists');
  assert.ok(/overflow-anchor:\s*none/.test(listRule[0]), 'the list does not anchor itself');

  const shared = CSS.match(/\.messages-list-scroll,\s*\n\.messages-thread-scroll \{[^}]*\}/);
  assert.ok(shared, 'the shared scroller rule exists');
  assert.ok(!/overflow-anchor/.test(shared[0]), 'the thread scroller is untouched');
});
