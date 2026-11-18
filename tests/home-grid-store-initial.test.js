// The vm harness's copy of the grid store's initial state must not drift.
//
// tests/helpers/home-grid-store.js transcribes INITIAL_GRID because the real
// one lives in TypeScript (frontend/src/features/home/grid-store.ts) and the
// vm sandboxes run classic script text — there is nothing to import it from.
// A transcription is a second source of truth, and the failure it invites is
// silent: a field added to the real store but not to the copy simply reads
// `undefined` inside every home test, so `Home.render()` publishes it, nobody
// asserts on it, and the harness keeps passing while the thing it models has
// moved on.
//
// So pin the pair. This parses the literal out of the TypeScript source rather
// than evaluating it: the file is a module with type-only exports around it,
// and the object itself is plain JSON-shaped data.
//
// Run with: node --test tests/home-grid-store-initial.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  INITIAL_GRID, INITIAL_CHROME, INITIAL_PANELS,
} = require('./helpers/home-grid-store');

const FEATURE_DIR = path.join(__dirname, '..', 'frontend', 'src', 'features', 'home');
const STORE_PATH = path.join(FEATURE_DIR, 'grid-store.ts');
const CHROME_PATH = path.join(FEATURE_DIR, 'chrome-store.ts');
const PANELS_PATH = path.join(FEATURE_DIR, 'panels-store.ts');

test('the harness mirrors INITIAL_GRID exactly', () => {
  const src = fs.readFileSync(STORE_PATH, 'utf8');
  const m = src.match(/export const INITIAL_GRID: HomeGridState = \{([\s\S]*?)\n\};/);
  assert.ok(m, 'INITIAL_GRID is no longer declared the way this test reads it —'
    + ' update the pattern here rather than deleting the guard');

  // `key: value,` per line, values being the JSON-ish literals the store holds.
  const real = {};
  for (const line of m[1].split('\n')) {
    const kv = line.trim().match(/^([A-Za-z_$][\w$]*):\s*(.+?),?$/);
    if (!kv) continue;
    real[kv[1]] = JSON.parse(
      kv[2].replace(/'/g, '"').replace(/,$/, ''),
    );
  }

  assert.deepEqual(real, INITIAL_GRID,
    'tests/helpers/home-grid-store.js has drifted from grid-store.ts —'
    + ' every home test that calls Home.render() is running against a stale shape');
});

test('the initial state renders NOTHING, which is the prerendered markup', () => {
  // The hydration contract (AGENTS.md): an island's first render must emit
  // exactly the markup the hand-written shell shipped, and #app-list shipped
  // empty. `ready: false` with no items is what makes that true — a mismatch
  // here is a console error on the home route, and a console error on any
  // route fails proposal checks.
  assert.equal(INITIAL_GRID.ready, false);
  assert.deepEqual(INITIAL_GRID.items, []);
  assert.equal(INITIAL_GRID.rowTemplate, '');
  assert.equal(INITIAL_GRID.resultsHeading, null);
  assert.equal(INITIAL_GRID.emptyQuery, null);
  assert.equal(INITIAL_GRID.query, '', 'the grid has judged no words before its first render');
  assert.equal(INITIAL_GRID.notice, null);
  // …and no Create tile. It is data-placed (after the last tile), so drawing
  // it before the first Home.render() would add a child the prerendered
  // #app-list does not have.
  assert.equal(INITIAL_GRID.create, null);
  // …and edit mode (#4669) is off: the wiggle, the remove buttons and the
  // "Done" link are a state a long press enters, never something the shipped
  // document already shows.
  assert.equal(INITIAL_GRID.editing, false);
});

// ── The SECOND home store ─────────────────────────────────────────────
//
// `Home.render()` pushes two view models on one pass: the launcher canvas
// (above) and the two hosts outside it — "Show all N apps" and the iOS widget
// strip. They are separate stores because the canvas model is deliberately not
// pushed mid-drag and those two have nothing to do with that guard, so they get
// the same transcription and the same pin.
//
// INITIAL_CHROME is NESTED, so this parses the literal rather than reading it
// line by line: bare keys quoted, single quotes doubled, trailing commas
// dropped, then JSON.parse. Anything the store's initial value could hold is
// JSON-shaped by construction — a plain store may only carry serialisable data.
function parseLiteral(text) {
  return JSON.parse(
    text
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
      .replace(/,(\s*[}\]])/g, '$1'),
  );
}

test('the harness mirrors INITIAL_CHROME exactly', () => {
  const src = fs.readFileSync(CHROME_PATH, 'utf8');
  const m = src.match(/export const INITIAL_CHROME: HomeChromeState = (\{[\s\S]*?\n\});/);
  assert.ok(m, 'INITIAL_CHROME is no longer declared the way this test reads it —'
    + ' update the pattern here rather than deleting the guard');
  assert.deepEqual(parseLiteral(m[1]), INITIAL_CHROME,
    'tests/helpers/home-grid-store.js has drifted from chrome-store.ts —'
    + ' every home test that calls Home.render() is running against a stale shape');
});

test('the initial chrome renders the two EMPTY hosts the shell shipped', () => {
  // Same hydration contract as the grid: `#home-apps-more` and
  // `#home-widget-strip-section` both ship hidden and empty in the prerendered
  // document, so the first client render has to agree — a mismatch here is a
  // console error on #home, and a console error on any route fails proposal
  // checks.
  assert.equal(INITIAL_CHROME.moreCount, 0, '0 is what keeps the expander hidden');
  assert.equal(INITIAL_CHROME.strip.active, false,
    'the strip is iOS-in-app only; every other platform never activates it');
  assert.equal(INITIAL_CHROME.strip.helpVisible, false);
  assert.deepEqual(INITIAL_CHROME.strip.tiles, []);
});

// ── The THIRD home store ──────────────────────────────────────────────
//
// home-panels.js's, and a separate one for a separate module's paint:
// `HomePanels.render()` is called from `Home.render()` but also on its own —
// an expand toggle, an optimistic hide — and the two blocks below the grid
// have nothing to do with the launcher canvas above them.

test('the harness mirrors INITIAL_PANELS exactly', () => {
  const src = fs.readFileSync(PANELS_PATH, 'utf8');
  const m = src.match(/export const INITIAL_PANELS: HomePanelsState = (\{[\s\S]*?\n\});/);
  assert.ok(m, 'INITIAL_PANELS is no longer declared the way this test reads it —'
    + ' update the pattern here rather than deleting the guard');
  assert.deepEqual(parseLiteral(m[1]), INITIAL_PANELS,
    'tests/helpers/home-grid-store.js has drifted from panels-store.ts');
});

test('the initial panels render the EMPTY, UN-hidden Challenges host', () => {
  // The other two stores ship their hosts hidden; this one does not, and the
  // difference is real rather than an oversight. The hand-written shell shipped
  // `<section class="px-3 pb-3">` with no `hidden`, so that is what the
  // prerendered document contains and what the first client render has to
  // agree with. `painted: false` is what defers the class: it separates "no
  // render has happened yet" from "this render decided there is nothing to
  // show", and without it the very first paint would add `hidden` and mismatch.
  assert.equal(INITIAL_PANELS.painted, false);
  // Discover's host went with Home's Discover lane (One Home, #6361).
  assert.equal('discover' in INITIAL_PANELS, false);
  assert.equal(INITIAL_PANELS.challenges, null);
  // Create left this store with its section: it is the grid's trailing tile,
  // and its model rides INITIAL_GRID.create above.
  assert.equal('create' in INITIAL_PANELS, false);
});
