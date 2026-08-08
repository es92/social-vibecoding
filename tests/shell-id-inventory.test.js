// The shell's element-id inventory, pinned.
//
// Every id in public/index.html is an API. public/js/** reaches for them with
// getElementById (57,799 lines of it, none of which the type checker sees),
// public/css/app.css styles some of them, and dapp.json's 227 declared tests
// select against deep chains of them — so a single lost id is a silently
// broken screen plus a blocked merge, and it is by far the most damaging way
// a markup conversion can go wrong.
//
// So: the set of ids the generated document carries must equal the set the
// hand-written one carried, exactly. This is a much narrower check than
// tests/shell-markup-parity.test.js and it is meant to OUTLIVE it — the parity
// fixture gets deleted when step 2 starts converting screens, but ids should
// keep being deliberate for far longer. When a step-2 slice legitimately
// retires an id, move it into RETIRED_IDS below with a reason, in the same
// commit that removes it.
//
// Run with: node --test tests/shell-id-inventory.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { idsOf } = require('./helpers/html-tokens');

const ROOT = path.join(__dirname, '..');

const before = fs.readFileSync(path.join(__dirname, 'fixtures', 'pre-migration-index.html'), 'utf8');
const after = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// Ids a later change deliberately removed, each with the reason. Empty in
// step 1: the chassis swap retires nothing.
const RETIRED_IDS = Object.create(null);

// Ids a later change deliberately added, each with the reason. Empty in
// step 1 for the same reason.
const ADDED_IDS = Object.create(null);

test('the shell still carries every id it had before the React chassis swap', () => {
  const expected = idsOf(before);
  // The fixture tracks main's hand-written markup, so this count moves when
  // main adds a screen — it was 422 at the chassis swap, 428 after merging
  // main (the Seasons rename, the mail console), and 431 after merging main
  // again and folding in the #907 local-agents settings section. It is
  // asserted anyway: a SILENT drop would otherwise make the comparison below
  // vacuous.
  assert.equal(
    expected.length, 431,
    `the pre-migration fixture has ${expected.length} ids, not the expected 431. If you refreshed `
    + 'the fixture from main, update this number in the same commit; if you did not, the fixture '
    + 'has been edited and should be a byte copy of main\'s public/index.html.',
  );

  const actual = new Set(idsOf(after));
  const missing = expected.filter((id) => !actual.has(id) && !(id in RETIRED_IDS));

  assert.deepEqual(
    missing, [],
    `${missing.length} element id(s) disappeared from public/index.html. public/js/** looks these `
    + 'up by getElementById and dapp.json selects on them, so each one is a broken screen. If a '
    + 'removal is intentional, add it to RETIRED_IDS with a reason in the same commit.',
  );
});

test('the shell has not grown ids nobody declared', () => {
  const expected = new Set(idsOf(before));
  const added = [...new Set(idsOf(after))].filter((id) => !expected.has(id) && !(id in ADDED_IDS));
  assert.deepEqual(
    added, [],
    'public/index.html gained element id(s) that the pre-migration markup did not have. A new id '
    + 'is fine, but declare it in ADDED_IDS with a reason so the inventory stays a deliberate list.',
  );
});

// Ids that appear more than once in the hand-written shell. getElementById
// returns the first match, so a duplicate is latent breakage — but these
// predate the React chassis swap and fixing one is a behavioural change to a
// live screen, which a scaffolding-only step must not make. They are pinned
// here so the count can only go DOWN, and so a step-2 slice converting either
// screen has the problem in front of it.
//
//   wallet-status — one in the Settings screen's wallet-link row, one in the
//   anonymous login screen's wallet sign-in block. Only one is ever mounted
//   at a time in practice, which is why this has never bitten.
const KNOWN_DUPLICATE_IDS = { 'wallet-status': 2 };

test('no id is used twice beyond the duplicates that predate this migration', () => {
  const seen = new Map();
  for (const id of idsOf(after)) seen.set(id, (seen.get(id) || 0) + 1);
  const duplicates = Object.fromEntries([...seen.entries()].filter(([, n]) => n > 1));

  assert.deepEqual(
    duplicates, KNOWN_DUPLICATE_IDS,
    'the set of duplicated element ids in public/index.html changed. getElementById returns the '
    + 'first match, so a NEW duplicate silently binds handlers to the wrong element — and JSX '
    + 'makes pasting a subtree easy. If you FIXED one, delete its entry from KNOWN_DUPLICATE_IDS.',
  );
});

test('the known duplicates are still duplicated in the pre-migration fixture', () => {
  // Guards the allow-list: if a duplicate turns out to have been introduced by
  // the conversion rather than inherited, it must not be excused here.
  const seen = new Map();
  for (const id of idsOf(before)) seen.set(id, (seen.get(id) || 0) + 1);
  for (const [id, count] of Object.entries(KNOWN_DUPLICATE_IDS)) {
    assert.equal(
      seen.get(id), count,
      `#${id} is listed as a pre-existing duplicate but the fixture has ${seen.get(id) || 0} of `
      + 'them — so the conversion introduced it, and it needs fixing rather than excusing.',
    );
  }
});

test('the ids the dev-console and staging overlay bind are present', () => {
  // dev-console.js binds these five on DOMContentLoaded. The staging twin in
  // particular lives deep inside #staging-overlay and is easy to lose in a
  // conversion, and its absence only shows up while previewing staging —
  // late, and far from the change that caused it.
  for (const id of [
    'dev-console-btn', 'staging-dev-console-btn', 'dev-console-close',
    'dev-console-clear', 'dev-console-filter', 'dev-console-log',
  ]) {
    assert.ok(after.includes(`id="${id}"`), `public/js/dev-console.js binds #${id}, which is missing`);
  }
});
