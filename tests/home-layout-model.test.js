// frontend/src/features/home/home-layout.js — the pure geometry behind
// free-form home-screen placement. Everything here is a plain function over
// plain data, so it is tested directly with no DOM at all.
//
// ── What THE UI OVERHAUL took out of this file, and out of this suite ──
//
// The model used to place WIDGETS as well as apps: Discover, Challenges and
// Create app were draggable blocks on the same canvas, with per-widget
// footprints from a server registry, per-breakpoint sizes, designed anchor
// cells, content-sized "fit" rows and a lossy reflow between two column
// counts. The overhaul made those three FIXED SECTIONS below the grid, at
// four columns everywhere.
//
// So roughly half of what this file used to guard is gone — not because it
// stopped mattering but because the thing it described stopped existing. What
// remains is the geometry that was always the hard part, and it is unchanged:
// occupancy, displacement, repair and the overflow region never cared what
// kind of item they were moving.
//
// The contracts this file guards now:
//
//   1. HOLES SURVIVE. Nothing re-packs a layout except the overflow region.
//      A drop leaves every other tile exactly where it is.
//   2. ONE COLUMN COUNT, and it agrees with the CSS. The JS lays out against
//      the column count the grid actually renders, or every cell is wrong.
//   3. deriveDefault is reading order — with nothing but apps on the canvas,
//      a default arrangement has nothing to design around.
//   4. repair() is total, and is also the MIGRATION: it drops what is gone,
//      drops the widget items a pre-overhaul layout still carries, pulls
//      tiles out of the retired fifth column, adds what is new, resolves
//      overlaps, and never loses an app.
//   5. place() clamps at the edges, swaps two cells, and displaces rather
//      than refusing.
//   6. The Create tile is DERIVED, never placed: trailingCell puts it straight
//      after the last tile on screen, and createTileCollapsed holds it behind
//      "Show all" when it would add a row to a collapsed grid (#3047).
//
// Run with: node --test tests/home-layout-model.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { LAYOUT_SRC } = require('./helpers/home-modules');

// The module moved into the React bundle with the home screen (#1083 chunk F
// step 4), and frontend/ is `"type": "module"` — so Node reads the file as ESM
// and a plain require() of it yields an empty namespace. Evaluate its text
// instead. Deliberately NOT in a vm context, unlike its sibling home tests:
// the assertions below are deepEqual on returned arrays, and a vm realm's
// Array.prototype is not this one's, so every one of them would fail on
// prototype identity alone. This module imports nothing and touches no DOM
// (`window` is absent, so its publication line no-ops), so the host realm is
// a complete environment for it.
const HomeLayout = new Function(`${LAYOUT_SRC}\n;return HomeLayout;`)();

const INDEX = read('public/index.html');
const ISLAND = read('frontend/src/features/home/index.tsx');
const SW = read('public/sw.js');
const SCHEMA = read('src/db/schema.sql');

const A = (slug, col, row) => ({ type: 'app', slug, col, row });
/** A pre-overhaul stored widget item — only repair() should ever see one. */
const W = (key, col, row) => ({ type: 'widget', key, col, row });
const ids = (layout) => HomeLayout.readingOrder(layout).map(HomeLayout.idOf);

const COLS = 4;

// ── The column count ──────────────────────────────────────────────────

test('one column count, and it matches what the CSS actually renders', () => {
  // It was `4 below 640px, 5 at and above` until THE UI OVERHAUL. Four
  // everywhere is a product decision — a launcher reads as a launcher at
  // phone density, and the desktop grid is width-capped rather than
  // stretched — and it removes a whole second stored layout per viewer.
  assert.equal(HomeLayout.COLS, 4);
  assert.equal(HomeLayout.MAX_ROWS, 8);
  for (const width of [320, 639, 640, 1440]) {
    assert.equal(HomeLayout.columnsForWidth(width), 4, `${width}px is four columns`);
  }
  assert.match(INDEX, /id="app-list"[^>]*\bgrid-cols-4\b/);
  // No second breakpoint on the grid: a `sm:grid-cols-5` here would have the
  // CSS rendering a column the JS never places into.
  assert.doesNotMatch(INDEX, /id="app-list"[^>]*sm:grid-cols-\d/);
  assert.doesNotMatch(INDEX, /id="app-list"[^>]*grid-cols-[5-9]/);
});

test('MAX_COLS narrows to the rendered count, and the schema still admits the old one', () => {
  assert.equal(HomeLayout.MAX_COLS, 4);
  // The CHECK still admits `cols IN (4, 5)` on purpose: a desktop arrangement
  // stored before the change is still READABLE, and repair() pulls anything in
  // the dead fifth column back onto the canvas rather than dropping those
  // apps. Nothing WRITES 5 any more — HomeLayout.COLS is the only source of
  // the number the client sends.
  assert.match(SCHEMA, /CONSTRAINT user_home_layout_cols CHECK \(cols IN \(4, 5\)\)/);
  assert.match(SCHEMA, /CONSTRAINT user_home_layout_col CHECK \(grid_col >= 0 AND grid_col < cols\)/);
});

test('the two-row default counts rows that HOLD apps, not row indices (#1367)', () => {
  const app = (slug, col, row) => ({ type: 'app', slug, col, row });

  // THE COMMON CASE IS UNCHANGED. Apps packed onto rows 0 and 1 bound at 1,
  // which is DEFAULT_ROWS - 1 — byte for byte what the old `row < 2` filter
  // did. This is the property that makes the change safe: it only ever widens
  // the window, and only for layouts the old form got wrong.
  assert.equal(
    HomeLayout.defaultRowBound([app('a', 0, 0), app('b', 1, 0), app('c', 0, 1)], 4),
    1,
  );
  // A sparse canvas is never NARROWER than the naive window, so there are
  // always two rows' worth of empty cells to drop onto.
  assert.equal(HomeLayout.defaultRowBound([], 4), 1);
  assert.equal(HomeLayout.defaultRowBound([app('a', 0, 0)], 4), 1);

  // THE BUG THIS FIXES. Free-form placement lets a viewer leave row 1 empty —
  // holes are the point — and the old filter then showed row 0 alone: a
  // one-row grid with "Show all N apps" under it, which is the two-row default
  // silently becoming a one-row default the moment somebody used the canvas.
  assert.equal(HomeLayout.defaultRowBound([app('a', 0, 0), app('b', 0, 2)], 4), 2);
  assert.equal(HomeLayout.defaultRowBound([app('a', 0, 0), app('b', 0, 5)], 4), 5);
  // It counts OCCUPIED rows, so a layout starting below row 0 still gets two.
  assert.equal(HomeLayout.defaultRowBound([app('a', 0, 3), app('b', 0, 4)], 4), 4);

  // Nothing past the second occupied row is pulled in: three packed rows still
  // bound at 1, so "Show all" keeps something to reveal.
  assert.equal(
    HomeLayout.defaultRowBound([app('a', 0, 0), app('b', 0, 1), app('c', 0, 2)], 4),
    1,
  );

  // Off-canvas overflow items (row >= MAX_ROWS) never count — they render
  // after the template in plain flow and have no row of their own.
  assert.equal(
    HomeLayout.defaultRowBound([app('a', 0, 0), app('b', 0, HomeLayout.MAX_ROWS)], 4),
    1,
  );

  // The renderer bounds INCLUSIVELY on this value, and re-places nothing —
  // widening the window must never move a tile off the cell its owner chose.
  // The Create tile never narrows or widens this window (#3047): it is held
  // behind "Show all" instead — see createTileCollapsed below.
  const HOME = read('frontend/src/features/home/home.js');
  assert.match(HOME, /const rowBound = HomeLayout\.defaultRowBound\(layout, cols, rowBudget\);/);
  assert.doesNotMatch(HOME, /collapsedRowBound/);
  assert.match(HOME, /canvas\.filter\(\(it\) => it\.row <= rowBound\)/);
  assert.match(HOME, /canvas\.some\(\(it\) => it\.row > rowBound\)/);
});

test('the row bound widens to the viewport budget, and never below two', () => {
  const app = (slug, col, row) => ({ type: 'app', slug, col, row });
  const packed = [
    app('a', 0, 0), app('b', 0, 1), app('c', 0, 2), app('d', 0, 3), app('e', 0, 4),
  ];

  // The default argument IS the two-row contract: omitting it and passing
  // DEFAULT_ROWS have to agree, or the viewport budget would be changing
  // behaviour for callers that never asked for one.
  assert.equal(
    HomeLayout.defaultRowBound(packed, 4),
    HomeLayout.defaultRowBound(packed, 4, HomeLayout.DEFAULT_ROWS),
  );

  // A taller screen buys whole rows: four occupied rows asked for bounds at
  // index 3, and "Show all" still has row 4 to reveal.
  assert.equal(HomeLayout.defaultRowBound(packed, 4, 3), 2);
  assert.equal(HomeLayout.defaultRowBound(packed, 4, 4), 3);

  // It still counts rows that HOLD apps rather than row indices, so a hole
  // widens the window exactly as it does at the two-row floor.
  assert.equal(
    HomeLayout.defaultRowBound([app('a', 0, 0), app('b', 0, 2), app('c', 0, 5)], 4, 3),
    5,
  );

  // NARROWING IS NOT ON OFFER. A budget below the contract — a garbage value,
  // a screen measured mid-transition at nearly zero height — floors at two
  // rows rather than collapsing the launcher to one.
  for (const bad of [1, 0, -3, NaN, null, undefined, 'two']) {
    assert.equal(
      HomeLayout.defaultRowBound(packed, 4, bad),
      HomeLayout.defaultRowBound(packed, 4),
      `a budget of ${String(bad)} floors at DEFAULT_ROWS`,
    );
  }

  // A sparse canvas still offers the budget's worth of empty cells to drop on.
  assert.equal(HomeLayout.defaultRowBound([], 4, 4), 3);
});

test('the visible row budget is measured from the screen, floored and capped', () => {
  const HOME = read('frontend/src/features/home/home.js');
  // Two-thirds of the screen, as a named constant rather than a number in the
  // middle of render().
  assert.match(HOME, /APPS_VIEWPORT_FRACTION: 2 \/ 3,/);
  // Floored at the two-row contract and capped by the canvas itself, so no
  // measurement can strand a tile or draw a row the model does not have.
  assert.match(
    HOME,
    /Math\.max\(floor, Math\.min\(HomeLayout\.MAX_ROWS, rows\)\)/,
  );
  // Measured against the row's OWN geometry (the computed track and gap), not
  // against what the grid currently draws — a budget read back from its own
  // output could never grow.
  assert.match(HOME, /cs\.gridAutoRows/);
  assert.match(HOME, /cs\.rowGap/);
  // The grid's offset inside the scroller's CONTENT, less the parked search
  // bar: the answer must not change as the viewer scrolls.
  assert.match(HOME, /screen\.scrollTop/);
  assert.match(HOME, /- resting;/);
  // A resize is the one thing that changes the budget, and it re-renders only
  // when a WHOLE row's worth of it changed.
  assert.match(HOME, /addEventListener\('resize'/);
  assert.match(HOME, /if \(Home\.visibleRowBudget\(\) === Home\._rowBudget\) return;/);
  // …and never mid-drag, the same deferral load() and render() take.
  assert.match(HOME, /if \(Home\._dragActive\) return;/);
});

test('two rows by default — a cap on what is shown, not on what exists', () => {
  assert.equal(HomeLayout.DEFAULT_ROWS, 2);
  // The canvas is still eight rows deep, so a drag can still place a tile on
  // any of them and nothing is stranded.
  assert.ok(HomeLayout.MAX_ROWS > HomeLayout.DEFAULT_ROWS);
  // The island documents why: two fixed sections sit under this grid, and
  // an eight-row canvas would push them off the bottom of a phone. Each host
  // is rendered by its own component since #1191, so the ids live one file
  // down — the island mounts the two, and the sections carry the hosts.
  const SECTIONS = read('frontend/src/features/home/panels/sections.tsx');
  for (const key of ['Discover', 'Challenges']) {
    assert.match(ISLAND, new RegExp(`<${key}Section />`), `the island mounts ${key}`);
  }
  assert.match(SECTIONS, /home-discover-section/);
  assert.match(SECTIONS, /home-challenges-section/);
  // Create is not a third section any more: it is the grid's trailing tile
  // (tests/home-create-tile.test.js), so nothing mounts or hosts it here.
  assert.doesNotMatch(ISLAND, /<CreateSection \/>/);
  assert.doesNotMatch(SECTIONS, /home-create-section"|id="home-create-section|'home-create-section'/);
});

// ── The Create tile's cell (the prototype's scrHome) ──────────────────
//
// The launcher ends with "Create an app". It is not a layout ITEM — nothing
// stores, drags or displaces it — so its cell is a pure function of what the
// grid draws: the one straight after the last tile, in reading order.

test('trailingCell: straight after the last tile, wrapping at the fourth column', () => {
  const app = (slug, col, row) => ({ type: 'app', slug, col, row });
  assert.deepEqual(HomeLayout.trailingCell([], 4), { col: 0, row: 0 },
    'an empty canvas starts the tile at the first cell');
  assert.deepEqual(HomeLayout.trailingCell([app('a', 0, 0)], 4), { col: 1, row: 0 });
  assert.deepEqual(
    HomeLayout.trailingCell([app('a', 0, 0), app('b', 1, 0), app('c', 2, 0), app('d', 3, 0)], 4),
    { col: 0, row: 1 },
    'a full row sends it to the next one',
  );
  // Reading order, not array order: the model's array is never sorted for it.
  assert.deepEqual(
    HomeLayout.trailingCell([app('late', 1, 2), app('early', 3, 0), app('mid', 0, 1)], 4),
    { col: 2, row: 2 },
  );
});

test('trailingCell: a hole earlier in the grid stays a hole', () => {
  const app = (slug, col, row) => ({ type: 'app', slug, col, row });
  // Holes are the point of the canvas (see place()), and the tile goes after
  // the LAST tile rather than into the first gap: filling a gap the viewer left
  // would read as the grid rearranging itself.
  assert.deepEqual(HomeLayout.trailingCell([app('a', 0, 0), app('b', 3, 2)], 4), { col: 0, row: 3 });
  assert.deepEqual(HomeLayout.trailingCell([app('a', 0, 0), app('b', 1, 2)], 4), { col: 2, row: 2 });
  // Overflow items have no cell, so they never decide where the tile goes (the
  // renderer flows the tile after them instead).
  assert.deepEqual(
    HomeLayout.trailingCell([app('a', 1, 0), app('o', 0, HomeLayout.MAX_ROWS)], 4),
    { col: 2, row: 0 },
  );
  // Pure: it reads the array it is handed and changes nothing in it.
  const layout = [app('b', 2, 1), app('a', 0, 0)];
  const before = JSON.stringify(layout);
  HomeLayout.trailingCell(layout, 4);
  assert.equal(JSON.stringify(layout), before);
});

test('createTileCollapsed: the tile goes behind "Show all" rather than start a row (#3047)', () => {
  const packed = (n) => Array.from({ length: n }, (_, i) => (
    { type: 'app', slug: `a${i}`, col: i % 4, row: Math.floor(i / 4) }
  ));
  const shownOf = (layout, bound) => layout.filter((it) => it.row <= bound);

  // Eight apps on the two-row floor: rows 0-1 are full, so the tile would
  // start a third row. It is held back — the issue's exact case.
  const eight = packed(8);
  const b8 = HomeLayout.defaultRowBound(eight, 4, 2);
  assert.equal(b8, 1);
  assert.equal(HomeLayout.createTileCollapsed(shownOf(eight, b8), 4, b8), true);

  // Seven apps: the tile fits beside the seventh, inside two rows.
  const seven = packed(7);
  assert.equal(HomeLayout.createTileCollapsed(shownOf(seven, 1), 4, 1), false);

  // Seventeen apps, two rows shown: the tile goes behind "Show all" with them.
  const seventeen = packed(17);
  assert.equal(HomeLayout.createTileCollapsed(shownOf(seventeen, 1), 4, 1), true);

  // A taller budget: the same rule — never a row for the tile alone, and no
  // row of apps is traded for it (the bound is defaultRowBound's, unchanged).
  const b4 = HomeLayout.defaultRowBound(seventeen, 4, 4);
  assert.equal(b4, 3);
  assert.equal(HomeLayout.createTileCollapsed(shownOf(seventeen, b4), 4, b4), true);
  // …and a budget with room left for its row shows it.
  const eight3 = HomeLayout.defaultRowBound(eight, 4, 3);
  assert.equal(eight3, 2);
  assert.equal(HomeLayout.createTileCollapsed(shownOf(eight, eight3), 4, eight3), false);

  // A hole: apps on rows 0 and 2 widen the window to row 2; a full row 2
  // still pushes the tile to row 3, past it.
  const holey = [
    { type: 'app', slug: 'x', col: 0, row: 0 },
    ...[0, 1, 2, 3].map((c) => ({ type: 'app', slug: `r${c}`, col: c, row: 2 })),
  ];
  const bh = HomeLayout.defaultRowBound(holey, 4, 2);
  assert.equal(bh, 2);
  assert.equal(HomeLayout.createTileCollapsed(holey, 4, bh), true);

  // An empty launcher always shows it (after the "No apps added yet" note).
  assert.equal(HomeLayout.createTileCollapsed([], 4, 1), false);
  assert.equal(HomeLayout.createTileCollapsed(null, 4, 1), false);

  // Pure: nothing is re-placed.
  const before = JSON.stringify(eight);
  HomeLayout.createTileCollapsed(eight, 4, 1);
  assert.equal(JSON.stringify(eight), before);
  assert.doesNotMatch(LAYOUT_SRC, /collapsedRowBound/);
});

test('the module is evaluated before its consumers, and precached', () => {
  // home.js reads HomeLayout as a bare identifier, so the import order in the
  // island is load-bearing.
  const layoutAt = ISLAND.indexOf("import './home-layout.js'");
  const homeAt = ISLAND.indexOf("import './home.js'");
  assert.ok(layoutAt > -1 && homeAt > layoutAt,
    'home-layout.js must be imported before home.js');
  assert.match(SW, /shell\.js/, 'the bundle carrying it is precached');
});

// ── Footprints ────────────────────────────────────────────────────────

test('every item is 1x1 — there are no footprints left to look up', () => {
  assert.deepEqual(HomeLayout.sizeOf(A('a', 0, 0), COLS), [1, 1]);
  // sizeOf survives as a function rather than an inlined [1, 1] because
  // occupancy/fits/firstFreeCell/place/repair are all written against a
  // footprint — which is what made the widget retirement a deletion rather
  // than a rewrite. It answers the same for anything it is handed.
  assert.deepEqual(HomeLayout.sizeOf(W('challenges', 0, 0), COLS), [1, 1]);
  assert.deepEqual(HomeLayout.sizeOf(null, COLS), [1, 1]);
});

test('idOf identifies an app by slug', () => {
  assert.equal(HomeLayout.idOf(A('chess', 0, 0)), 'app:chess');
  assert.equal(HomeLayout.idOf(null), '');
});

// ── Blank rows (#975) ─────────────────────────────────────────────────

test('an empty row between tiles is half a cell', () => {
  // The rule used to be phone-only (PHONE_COLS gated it), because at five
  // columns a row was shared between widgets and app icons and a short row
  // left a notch beside its neighbours. Nothing shares a row now.
  const layout = [A('a', 0, 0), A('b', 0, 2)];
  assert.deepEqual([...HomeLayout.blankRows(layout, COLS)], [1]);
});

test('blank rows stop at the last occupied row — trailing rows are not tracks', () => {
  // Naming a trailing row would push rowTemplate into declaring the whole
  // eight-row canvas, and an explicit track exists whether or not anything is
  // in it: a three-app home screen would grow a tail of empty tiles.
  const layout = [A('a', 0, 0), A('b', 0, 2)];
  const blank = HomeLayout.blankRows(layout, COLS);
  for (const row of [3, 4, 5, 6, 7]) {
    assert.ok(!blank.has(row), `row ${row} is past the content`);
  }
});

test('a PARTLY empty row is not blank — the tile in it needs its whole cell', () => {
  const layout = [A('a', 0, 0), A('b', 3, 1), A('c', 0, 2)];
  assert.ok(!HomeLayout.blankRows(layout, COLS).has(1));
});

test('an empty canvas has no blank rows — there is no template at all', () => {
  assert.equal(HomeLayout.blankRows([], COLS).size, 0);
  assert.equal(HomeLayout.lastOccupiedRow([], COLS), -1);
});

test('an overflow item is off-canvas and cannot make a row blank', () => {
  const layout = [A('a', 0, 0), A('x', 0, 8)];
  assert.equal(HomeLayout.lastOccupiedRow(layout, COLS), 0);
  assert.equal(HomeLayout.blankRows(layout, COLS).size, 0);
});

// ── deriveDefault ─────────────────────────────────────────────────────

test('deriveDefault is reading order, four to a row', () => {
  // With nothing but apps on the canvas a default arrangement has nothing to
  // design around: the anchor cells, the widgets-go-down-first rule and the
  // "two accounts with different app counts get the same home screen"
  // guarantee were all about the three blocks that are sections now.
  const layout = HomeLayout.deriveDefault({
    apps: ['a', 'b', 'c', 'd', 'e'], cols: COLS,
  });
  assert.deepEqual(
    layout.map((it) => [it.slug, it.col, it.row]),
    [['a', 0, 0], ['b', 1, 0], ['c', 2, 0], ['d', 3, 0], ['e', 0, 1]]
  );
  assertNoOverlap(layout, COLS);
});

test('deriveDefault overflows rather than dropping an app', () => {
  const apps = Array.from({ length: 40 }, (_, i) => `a${i}`);
  const layout = HomeLayout.deriveDefault({ apps, cols: COLS });
  assert.equal(layout.length, 40, 'every app is placed somewhere');
  // 4 x 8 = 32 on the canvas; the rest go to the overflow region.
  assert.equal(HomeLayout.canvasItems(layout).length, 32);
  assert.equal(HomeLayout.overflowItems(layout).length, 8);
});

test('deriveDefault tolerates a missing app list', () => {
  assert.deepEqual(HomeLayout.deriveDefault({ cols: COLS }), []);
});

// ── repair, which is also the migration ───────────────────────────────

test('repair drops what is gone and adds what is new', () => {
  const stored = [A('a', 0, 0), A('gone', 1, 0)];
  const { layout, changed } = HomeLayout.repair(stored, COLS, ['app:a', 'app:new']);
  assert.ok(changed);
  assert.deepEqual(ids(layout), ['app:a', 'app:new']);
  assertNoOverlap(layout, COLS);
});

test('repair is a no-op on a clean layout — a plain load writes nothing', () => {
  const stored = [A('a', 0, 0), A('b', 2, 3)];
  const { layout, changed } = HomeLayout.repair(stored, COLS, ['app:a', 'app:b']);
  assert.equal(changed, false, 'a clean load must not persist');
  assert.deepEqual(layout.map((it) => [it.slug, it.col, it.row]),
    [['a', 0, 0], ['b', 2, 3]], 'and must not move anything');
});

test('repair drops a pre-overhaul widget item and reclaims its cell', () => {
  // The migration, done lazily: repair() already runs on every load and
  // already knows how to reclaim space, so a viewer who never opens the home
  // screen never pays for a rewrite.
  const stored = [W('challenges', 0, 0), A('a', 1, 0)];
  const { layout, changed } = HomeLayout.repair(stored, COLS, ['app:a']);
  assert.ok(changed, 'dropping the widget is a change worth persisting');
  assert.deepEqual(ids(layout), ['app:a']);
  assert.deepEqual([layout[0].col, layout[0].row], [1, 0],
    'the surviving tile does NOT move — holes are still the point');
});

test('repair rescues a tile stranded in the retired fifth column', () => {
  // The other half of the migration. A desktop arrangement written before the
  // change can carry col 4, which no longer exists; dropping it would make
  // those apps silently vanish off the right-hand edge.
  const stored = [A('a', 0, 0), A('far', 4, 0)];
  const { layout, changed } = HomeLayout.repair(stored, COLS, ['app:a', 'app:far']);
  assert.ok(changed);
  assert.deepEqual(ids(layout).sort(), ['app:a', 'app:far']);
  for (const item of layout) {
    assert.ok(item.col < COLS, `${item.slug} is on the canvas`);
  }
});

test('repair dedupes and resolves an overlap, earliest in reading order winning', () => {
  const stored = [A('a', 0, 0), A('a', 2, 0), A('b', 0, 0)];
  const { layout, changed } = HomeLayout.repair(stored, COLS, ['app:a', 'app:b']);
  assert.ok(changed);
  assert.equal(layout.length, 2);
  assert.deepEqual([layout[0].slug, layout[0].col, layout[0].row], ['a', 0, 0],
    'the thing nearer the top-left holds still');
  assertNoOverlap(layout, COLS);
});

test('repair overflows rather than losing an app when the canvas is full', () => {
  const stored = Array.from({ length: 32 }, (_, i) => A(`a${i}`, i % 4, Math.floor(i / 4)));
  const present = stored.map((it) => `app:${it.slug}`).concat('app:extra');
  const { layout } = HomeLayout.repair(stored, COLS, present);
  assert.equal(layout.length, 33, 'nothing is lost');
  assert.equal(HomeLayout.overflowItems(layout).length, 1);
});

// ── place ─────────────────────────────────────────────────────────────

test('place moves an item into a free cell and touches nothing else', () => {
  const layout = [A('a', 0, 0), A('b', 2, 2)];
  const next = HomeLayout.place(layout, layout[0], 3, 1, COLS);
  assert.deepEqual([next[0].col, next[0].row], [3, 1]);
  assert.deepEqual([next[1].col, next[1].row], [2, 2], 'b did not move');
});

test('place swaps two single cells', () => {
  const layout = [A('a', 0, 0), A('b', 1, 0)];
  const next = HomeLayout.place(layout, layout[0], 1, 0, COLS);
  const by = Object.fromEntries(next.map((it) => [it.slug, [it.col, it.row]]));
  assert.deepEqual(by.a, [1, 0]);
  assert.deepEqual(by.b, [0, 0], 'the occupant takes the vacated cell');
});

test('place displaces the occupant rather than refusing', () => {
  // Displacement, not swap-or-refuse: whatever sits in the target is pushed
  // out of the way and the dragged tile takes the spot.
  const layout = [A('a', 0, 0), A('b', 1, 0), A('c', 0, 1)];
  const next = HomeLayout.place(layout, layout[0], 1, 0, COLS);
  assertNoOverlap(next, COLS);
  const by = Object.fromEntries(next.map((it) => [it.slug, [it.col, it.row]]));
  assert.deepEqual(by.a, [1, 0]);
  assert.deepEqual(by.c, [0, 1], 'an uninvolved tile is untouched');
});

test('place preserves holes and every untouched item', () => {
  const layout = [A('a', 0, 0), A('b', 3, 3), A('c', 1, 5)];
  const next = HomeLayout.place(layout, layout[0], 2, 0, COLS);
  const by = Object.fromEntries(next.map((it) => [it.slug, [it.col, it.row]]));
  assert.deepEqual(by.b, [3, 3]);
  assert.deepEqual(by.c, [1, 5]);
  // Rows 1, 2 and 4 stay empty — that is the difference between this and the
  // flow reorder it replaced.
  assert.deepEqual([...HomeLayout.blankRows(next, COLS)].sort(), [1, 2, 4]);
});

test('place allows a target overlapping the item’s own cell', () => {
  const layout = [A('a', 1, 1)];
  assert.equal(HomeLayout.canPlace(layout, layout[0], 1, 1, COLS), true);
  const next = HomeLayout.place(layout, layout[0], 1, 1, COLS);
  assert.deepEqual([next[0].col, next[0].row], [1, 1]);
});

test('place refuses only an item that is not in the layout', () => {
  const layout = [A('a', 0, 0)];
  assert.equal(HomeLayout.place(layout, A('ghost', 0, 0), 2, 2, COLS), null);
  assert.equal(HomeLayout.canPlace(layout, A('ghost', 0, 0), 2, 2, COLS), false);
});

test('place clamps at the right and bottom edges instead of refusing', () => {
  const layout = [A('a', 0, 0)];
  const right = HomeLayout.place(layout, layout[0], 9, 0, COLS);
  assert.deepEqual([right[0].col, right[0].row], [3, 0], 'flush against the last column');
  const bottom = HomeLayout.place(layout, layout[0], 0, 99, COLS);
  assert.deepEqual([bottom[0].col, bottom[0].row], [0, 7], 'flush against the last row');
  assert.equal(HomeLayout.canPlace(layout, layout[0], 9, 0, COLS), true,
    'canPlace is the same rule, so the highlight and the drop agree');
});

// ── Overflow and the wire shape ───────────────────────────────────────

test('overflow is dense, separate, and excluded from the wire payload', () => {
  const layout = [A('a', 0, 0), A('x', 0, 8), A('y', 1, 8)];
  assert.equal(HomeLayout.canvasItems(layout).length, 1);
  assert.equal(HomeLayout.overflowItems(layout).length, 2);
  // The server's CHECK rejects row >= 8, and an overflow item has no
  // placement worth remembering — it comes back from the same derivation.
  const wire = HomeLayout.toWire(layout);
  assert.equal(wire.length, 1);
  assert.deepEqual(wire[0], { type: 'app', slug: 'a', col: 0, row: 0 });
  assert.match(SCHEMA, /CONSTRAINT user_home_layout_row CHECK \(grid_row >= 0 AND grid_row < 8\)/);
});

test('toWire emits the shape the route parses, in reading order', () => {
  const wire = HomeLayout.toWire([A('b', 2, 1), A('a', 0, 0)]);
  assert.deepEqual(wire, [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 2, row: 1 },
  ]);
});

// ── The retired surface, asserted gone ────────────────────────────────

test('the widget-placement machinery is really gone, not merely unused', () => {
  // Every one of these described a widget on the launcher canvas. Leaving any
  // of them behind would invite a future edit to "restore" placement, which
  // the four-area design has to refuse.
  for (const name of ['setRegistry', 'isRemovable', 'fitRows', 'reflow',
    '_homeCellFor']) {
    assert.equal(typeof HomeLayout[name], 'undefined', `${name} is retired`);
  }
  for (const name of ['WIDGET_HOME_CELLS', 'WIDGET_HOME_ORDER', 'FIT_KEYS',
    'PHONE_COLS', 'BREAKPOINT_PX']) {
    assert.equal(HomeLayout[name], undefined, `${name} is retired`);
  }
});

// Every cell covered by at most one item's footprint.
function assertNoOverlap(layout, cols) {
  const seen = new Set();
  for (const item of layout) {
    if (item.row >= HomeLayout.MAX_ROWS) continue;
    const [w, h] = HomeLayout.sizeOf(item, cols);
    assert.ok(item.col + w <= cols, `${HomeLayout.idOf(item)} fits horizontally`);
    assert.ok(item.row + h <= HomeLayout.MAX_ROWS, `${HomeLayout.idOf(item)} fits vertically`);
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        const cell = `${item.col + dx},${item.row + dy}`;
        assert.ok(!seen.has(cell), `${cell} claimed twice`);
        seen.add(cell);
      }
    }
  }
}
