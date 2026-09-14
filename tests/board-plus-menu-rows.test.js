// The board's "+" menu is shaped like the app chip's menu (#1615).
//
// Two lists of destinations hang off the same header, and they were drawn as
// two different kinds of object: the chip's menu is a leading glyph, `gap-3`,
// `px-5` and a 44px row; the "+" menu was a bare title-over-subtitle block
// with `px-3` and no glyph at all.
//
// What this change deliberately does NOT copy is the chip menu's single-line
// row. Every action here has a subtitle that says what it does ("Renames are
// proposals, applied once voted in"), and those lines are why the menu is
// legible; dropping them to match a shape would be a worse menu.
//
// The load-bearing detail is the touch path. `AppView._wirePlusMenu` builds a
// native action sheet from these rows and used to read
// `node.querySelector('span')` for each label — the title only by accident of
// source order. This layout needs a wrapper around the text column, so the
// title is marked `data-plus-title` and the sheet reads that.
//
// Run with: node --test tests/board-plus-menu-rows.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FRAME = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/dev-board/actions-row.tsx'), 'utf8');
const APP_VIEW = fs.readFileSync(path.join(ROOT, 'public/js/app-view.js'), 'utf8');
const CHIP_SHEET = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/app-context/app-context-sheet.tsx'), 'utf8');

test('the row shell borrows the chip menu’s geometry', () => {
  const shell = FRAME.match(/const PLUS_ROW_CLS =[\s\S]*?';/)[0];
  for (const cls of ['flex items-start gap-3', 'px-5', 'min-h-[44px]', 'hover:bg-zinc-50']) {
    assert.ok(shell.includes(cls), `row shell carries ${cls}`);
  }
  // The chip's menu is where those values come from, so they must still be
  // there to have been copied FROM.
  const chipRow = CHIP_SHEET.match(/const ROW = [\s\S]*?';/)[0];
  assert.ok(chipRow.includes('gap-3'));
  assert.ok(chipRow.includes('px-5'));
  assert.ok(chipRow.includes('min-h-[44px]'));
});

test('every action row has a glyph, and every glyph is decoration', () => {
  const menu = FRAME.slice(FRAME.indexOf('id="dev-plus-menu"'));
  const rows = menu.match(/<PlusRow\b/g) || [];
  // Eight calls for seven rows: the members row is written as two, one per
  // label pair, because tests/dev-plus-menu.test.js reads the two branches
  // separately to prove the self-hosted wording never leaks into the other.
  assert.equal(rows.length, 8,
    'issue, import-pr, featured-illustration, members x2, rename, secrets, fork');
  const icons = menu.match(/icon=\{<([A-Za-z]+Icon) className=\{PLUS_ICON_CLS\} aria-hidden="true" \/>\}/g) || [];
  assert.equal(icons.length, 8, 'one glyph per row, all aria-hidden');
  // No <button data-plus> survives outside the shared shell — a hand-written
  // row would miss both the glyph column and the title marker.
  assert.doesNotMatch(menu, /<button\s+data-plus=/);
});

test('the subtitles survive: this is not the chip menu’s one-line row', () => {
  const menu = FRAME.slice(FRAME.indexOf('id="dev-plus-menu"'));
  assert.match(menu, /Renames are proposals, applied once voted in/);
  assert.match(menu, /Report a problem or idea without building it yourself/);
  assert.match(menu, /Your computer &middot; your own tools\. You have already built it/);
  assert.match(menu, /Stand up your own independent copy/);
  assert.match(FRAME, /const PLUS_SUB_CLS = 'block text-xs/);
});

test('the touch action sheet reads the title by name, not by position', () => {
  // The regression this prevents: a glyph or a wrapper arriving before the
  // title would have labelled every sheet row with the wrong text, or ''.
  assert.match(FRAME, /data-plus-title/);
  assert.match(APP_VIEW, /node\.querySelector\('\[data-plus-title\]'\)/);
  // The old positional lookup stays as a fallback, so a row that has not been
  // marked yet still gets a label rather than none.
  const sheet = APP_VIEW.slice(APP_VIEW.indexOf("querySelector('[data-plus-title]')"));
  assert.match(sheet.slice(0, 400), /\|\|\s*node\.querySelector\('span'\)/);
});

test('the secrets row keeps its legacy-owned state leaf inside the title', () => {
  // AppView.refreshDevChatSecretsState writes #dc-secrets-state, so it must
  // stay a node React renders empty and never writes again — and it must stay
  // INSIDE the marked title, or the sheet label would drop the count.
  const secrets = FRAME.slice(FRAME.indexOf('data-plus="secrets"'));
  const row = secrets.slice(0, secrets.indexOf('dividerCls'));
  assert.match(row, /data-plus-title/);
  assert.match(row, /id="dc-secrets-state"/);
  assert.ok(row.indexOf('data-plus-title') < row.indexOf('id="dc-secrets-state"'));
});
