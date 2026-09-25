// Free-form home-screen grid geometry — the pure, testable half of "put your
// apps anywhere". Everything here is a plain function over plain data: no DOM,
// no fetch, no Home state. The drag handlers in home.js call into it and
// persist the result; tests/home-layout-model.test.js exercises it directly.
//
// THE MODEL. A layout is a flat array of app tiles, each at one grid cell:
//     { type: 'app', slug: 'chess', col: 0, row: 0 }
// Every item is 1x1. The `type` survives because it is the wire format the
// server validates and thousands of stored rows carry it.
//
// HOLES ARE THE POINT. Nothing here re-packs a layout to remove gaps except
// the overflow region (which is dense by definition). A drop leaves every
// other tile exactly where it was.
//
// ── What THE UI OVERHAUL removed, and why the model got simpler ────────
//
// This used to place WIDGETS too — Discover, Challenges and Create app were
// draggable blocks on the same canvas, with per-widget footprints looked up
// from a server registry, per-column-count sizes, anchor cells, fit rows and a
// reflow between two breakpoints. The overhaul made those three FIXED SECTIONS
// stacked below the grid (Create has since come back as the grid's trailing
// tile, but DERIVED per paint rather than placed — see trailingCell), so:
//
//   * every item is an app, and every app is 1x1 — no registry, no `sizeOf`
//     table, no `repair()` overlap resolution from a size change;
//   * there is ONE column count, four, at every width — so no per-width
//     layouts and no `reflow()`, which was lossy by construction and existed
//     only because a 5-wide arrangement's holes have no meaningful mapping
//     onto a 4-wide grid;
//   * no fit rows: a row whose height followed a widget's content was a rule
//     about widgets sharing the canvas with tiles, and nothing shares it now.
//
// FOUR COLUMNS EVERYWHERE is a product decision, not a simplification that
// fell out: a launcher reads as a launcher at phone density, and the desktop
// grid is width-capped (see .home-column in app.css) rather than stretched.
'use strict';

const HomeLayout = {
  // The canvas. Mirrors MAX_COLS / MAX_ROWS in src/routes/home-layout.js and
  // the CHECK constraints on user_home_layout.
  //
  // MAX_COLS was 5 (the desktop breakpoint) and is 4 at every width now. The
  // server CHECK still permits 5, deliberately: a stored desktop arrangement
  // written before the change is still readable, and repair() pulls anything
  // in the dead fifth column back onto the canvas rather than dropping it.
  MAX_COLS: 4,
  MAX_ROWS: 8,

  // The DEFAULT number of rows the grid shows: two, which is eight apps. More
  // than that and the grid grows — the cap is on what is shown BY DEFAULT, not
  // on what a viewer may have (see MAX_ROWS above, and the overflow region).
  DEFAULT_ROWS: 2,

  // One column count, at every width. MUST stay in step with #app-list's
  // `grid-cols-4` in the shell — a mismatch would have the JS laying out
  // against a column count the CSS isn't rendering.
  // tests/home-layout-model.test.js greps both files.
  COLS: 4,

  // Kept as a function, and kept taking a width, because every caller reads
  // like `columnsForWidth(window.innerWidth)` and the answer being constant is
  // the POINT rather than an accident to inline away.
  columnsForWidth() {
    return HomeLayout.COLS;
  },




  // An item's footprint. Always 1x1 — every item is an app tile now.
  //
  // Kept as a function rather than inlined `[1, 1]` at a dozen call sites:
  // occupancy(), fits(), firstFreeCell(), place() and repair() are all written
  // against a footprint, and that generality is what made the widget
  // retirement a deletion rather than a rewrite. `cols` is still accepted for
  // the same reason the parameter list of columnsForWidth is.
  sizeOf() {
    return [1, 1];
  },

  // Stable identity for an item, used for dedupe and for "is this the same
  // thing I picked up".
  idOf(item) {
    if (!item) return '';
    return `app:${item.slug}`;
  },



  // ── Blank rows (#975) ──────────────────────────────────────────────
  //
  // A row with NOTHING in it draws at half a cell on a phone. Same
  // containment as fit rows above, and for the same reason: this is a pixel
  // height Home.render() writes into one grid track, nothing more. The model
  // still answers in whole cells, occupancy/place/repair/reflow are untouched,
  // and no stored position is rewritten on any device.
  //
  // HOLES ARE STILL THE POINT. This does not re-pack, collapse or tidy
  // anything — the empty row stays exactly where the viewer left it and stays
  // a cell they can drop into. It simply stops reserving a whole tile's worth
  // of vertical space to do it, which is what keeps the two fixed sections
  // below the grid from being pushed down by a viewer's deliberate gaps.
  //
  // A row qualifies iff it is ON the emitted template (0 <= row <=
  // lastOccupiedRow) and NO on-canvas item overlaps it.
  //
  //   * "no item overlaps it" is why a PARTLY empty row does not qualify. A
  //     row holding one tile and three gaps is a full row — the tile in it
  //     needs its whole cell, caption lane included.
  //   * bounding at lastOccupiedRow is what keeps the TRAILING rows out.
  //     They are not in the template at all (the grid ends at the last placed
  //     item), so naming them could only push rowTemplate into declaring the
  //     whole eight-row canvas — the very thing that would pad a three-app
  //     home screen out with a tail of empty tracks.
  blankRows(layout, cols) {
    // The PHONE_COLS gate that used to open this function is gone with the
    // second breakpoint: there is one column count now, so the rule that was
    // phone-only is simply the rule.
    const rows = new Set();
    const last = HomeLayout.lastOccupiedRow(layout, cols);
    if (last < 0) return rows;
    const occupied = new Set();
    for (const item of layout || []) {
      if (!item || item.row >= HomeLayout.MAX_ROWS) continue; // overflow, off-canvas
      const [, h] = HomeLayout.sizeOf(item, cols);
      for (let dy = 0; dy < h; dy++) occupied.add(item.row + dy);
    }
    for (let row = 0; row <= last; row++) {
      if (!occupied.has(row)) rows.add(row);
    }
    return rows;
  },

  // The last row any ON-CANVAS item occupies, or -1 for an empty canvas.
  // Home.render() uses it to emit exactly that many track entries: declaring
  // all eight would give the grid an explicit eight rows and pad a
  // three-app home screen out to ~950px, where today the implicit grid
  // simply ends at the last placed item.
  lastOccupiedRow(layout, cols) {
    let last = -1;
    for (const item of layout || []) {
      if (!item || item.row >= HomeLayout.MAX_ROWS) continue;
      const [, h] = HomeLayout.sizeOf(item, cols);
      const bottom = Math.min(item.row + h - 1, HomeLayout.MAX_ROWS - 1);
      if (bottom > last) last = bottom;
    }
    return last;
  },

  // ── The collapsed grid's row bound (#1367) ─────────────────────────
  //
  // Home.render() shows a COLLAPSED grid by default and offers "Show all N
  // apps" to reveal the rest. This answers the one question that view has to
  // ask: what is the LAST row index it may draw?
  //
  // The naive answer — `DEFAULT_ROWS - 1`, i.e. rows 0 and 1 — is what it used
  // to use, and it is wrong for exactly the layouts free-form placement makes
  // possible. A viewer whose apps sit on rows 0 and 2 (a hole on row 1, which
  // HOLES ARE THE POINT explicitly allows) got a collapsed grid holding ONE
  // row of tiles and a "Show all" button: the two-row default silently became
  // a one-row default the moment somebody used the feature the canvas exists
  // for.
  //
  // `rows` — how many rows the caller wants shown — defaults to DEFAULT_ROWS
  // and is passed in by Home.render() as the VIEWPORT's answer instead
  // (Home.visibleRowBudget): two rows is the floor everywhere, and a screen
  // with room for three or four in its first two-thirds shows them rather
  // than parking the rest behind a button it did not need. Nothing else about
  // this function changes — it still widens a window over cells the viewer
  // chose, and still re-places nothing.
  //
  // So the bound is "far enough down to include `rows` rows that
  // actually HOLD something", never less than the naive answer. Two
  // properties matter:
  //
  //   * NOTHING IS RE-PLACED. Every tile keeps the exact cell the viewer put
  //     it in — this widens the window, it does not compact anything into it.
  //     That is what keeps a drag inside a collapsed grid landing on the cell
  //     the pointer is actually over.
  //   * The holes it pulls in cost half a row each, not a whole one:
  //     blankRows() already sizes an empty row at var(--home-blank-row-h).
  //
  // In the common case — apps packed onto rows 0 and 1 — this returns 1, byte
  // for byte the old behaviour.
  defaultRowBound(layout, cols, rows) {
    // A caller that asks for fewer than the two-row contract gets the two-row
    // contract: this widens the default window, it never narrows it.
    const want = Math.max(HomeLayout.DEFAULT_ROWS, Math.trunc(Number(rows)) || 0);
    const occupied = new Set();
    for (const item of layout || []) {
      if (!item || item.row >= HomeLayout.MAX_ROWS) continue;
      const [, h] = HomeLayout.sizeOf(item, cols);
      for (let dy = 0; dy < h; dy++) {
        const row = item.row + dy;
        if (row < HomeLayout.MAX_ROWS) occupied.add(row);
      }
    }
    // Never narrower than the naive window, so a sparse canvas still offers
    // the requested rows' worth of empty cells a viewer can drop onto.
    let bound = want - 1;
    let seen = 0;
    for (const row of [...occupied].sort((a, b) => a - b)) {
      seen += 1;
      if (seen >= want) {
        if (row > bound) bound = row;
        break;
      }
    }
    return bound;
  },

  // ── Occupancy ──────────────────────────────────────────────────────
  //
  // A Set of "col,row" strings. Built fresh per query rather than cached:
  // the layouts are at most ~40 items, and a stale cache during a drag is a
  // far worse bug than the arithmetic is expensive.
  occupancy(layout, cols, exceptId) {
    const taken = new Set();
    for (const item of layout || []) {
      if (exceptId && HomeLayout.idOf(item) === exceptId) continue;
      if (item.row >= HomeLayout.MAX_ROWS) continue; // overflow, off-canvas
      const [w, h] = HomeLayout.sizeOf(item, cols);
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) taken.add(`${item.col + dx},${item.row + dy}`);
      }
    }
    return taken;
  },

  // Does a w x h rectangle at (col,row) fit on the canvas and touch nothing?
  fits(taken, col, row, w, h, cols) {
    if (col < 0 || row < 0) return false;
    if (col + w > cols || row + h > HomeLayout.MAX_ROWS) return false;
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        if (taken.has(`${col + dx},${row + dy}`)) return false;
      }
    }
    return true;
  },

  // First free rectangle in READING ORDER (left-to-right, top-to-bottom).
  // Returns { col, row } or null when the canvas has no room — the caller
  // then puts the item in the overflow region rather than dropping it.
  firstFreeCell(layout, size, cols, exceptId) {
    const taken = HomeLayout.occupancy(layout, cols, exceptId);
    const [w, h] = size;
    for (let row = 0; row <= HomeLayout.MAX_ROWS - h; row++) {
      for (let col = 0; col <= cols - w; col++) {
        if (HomeLayout.fits(taken, col, row, w, h, cols)) return { col, row };
      }
    }
    return null;
  },

  // Reading-order sort: row first, then column. The canonical traversal for
  // everything that has to be deterministic across clients (reflow, repair,
  // overflow packing).
  readingOrder(layout) {
    return (layout || []).slice().sort((a, b) => (
      a.row !== b.row ? a.row - b.row : a.col - b.col
    ));
  },

  // ── Deriving a layout ──────────────────────────────────────────────


  // The arrangement for an account that has never dragged anything: the
  // App tiles in flow order, packed into reading order.
  //
  // This used to place the three WIDGETS first, at designed anchor cells, and
  // then fill around them — packing apps first and slotting widgets into the
  // gaps had put them wherever the app count happened to leave room, so two
  // accounts with different numbers of apps got different-looking home
  // screens. THE UI OVERHAUL made those fixed sections BELOW the grid,
  // which settles the question completely: there is nothing on the canvas but
  // apps, so a default arrangement is simply the reading order.
  deriveDefault({ apps, cols }) {
    const layout = [];
    for (const slug of apps || []) {
      const spot = HomeLayout.firstFreeCell(layout, [1, 1], cols);
      // No room on the canvas → overflow (rows at/after MAX_ROWS), packed
      // densely by overflowItems() at render time.
      layout.push(spot
        ? { type: 'app', slug, col: spot.col, row: spot.row }
        : { type: 'app', slug, col: 0, row: HomeLayout.MAX_ROWS });
    }
    return layout;
  },



  // ── Repair ─────────────────────────────────────────────────────────

  // Reconcile a stored layout against what actually exists right now:
  //   * drop items whose app is gone — and every WIDGET item, which is how a
  //     layout stored before THE UI OVERHAUL is migrated: the three widgets
  //     are fixed sections below the grid now, so a saved cell for one is a
  //     hole to reclaim rather than a tile to keep,
  //   * ADD anything present but unplaced (a newly added app) at the first
  //     free cell,
  //   * pull anything OUT OF BOUNDS back onto the canvas. This is the other
  //     half of the migration: the grid was five columns wide on desktop and
  //     is four everywhere now, so a stored arrangement can carry tiles in a
  //     column that no longer exists. Re-placing them is what stops those
  //     apps silently vanishing off the right-hand edge,
  //   * resolve overlaps, keeping the earlier item in reading order and
  //     re-placing the later one,
  //   * push anything that no longer fits into the overflow region.
  //
  // Returns { layout, changed }. `changed` is what the caller uses to decide
  // whether to persist; a clean load must write nothing.
  repair(layout, cols, present) {
    const wanted = new Set(present || []);
    const seen = new Set();
    const out = [];
    let changed = false;

    for (const item of HomeLayout.readingOrder(layout)) {
      // A stored widget item is from before the overhaul. Dropping it here
      // rather than in a migration is deliberate: repair() already runs on
      // every load and already knows how to reclaim the space, and a viewer
      // who never opens the home screen never pays for a rewrite.
      if (item && item.type === 'widget') { changed = true; continue; }
      const id = HomeLayout.idOf(item);
      if (!wanted.has(id) || seen.has(id)) { changed = true; continue; }
      seen.add(id);
      const size = HomeLayout.sizeOf(item, cols);
      const taken = HomeLayout.occupancy(out, cols);
      const inBounds = item.col >= 0 && item.row >= 0
        && item.col + size[0] <= cols && item.row + size[1] <= HomeLayout.MAX_ROWS;
      if (inBounds && HomeLayout.fits(taken, item.col, item.row, size[0], size[1], cols)) {
        out.push({ ...item });
        continue;
      }
      // Overlapping or out of bounds: re-place it. Reading order means the
      // item that was already there wins, which is the least surprising
      // resolution — the thing nearer the top-left holds still.
      const spot = HomeLayout.firstFreeCell(out, size, cols);
      out.push(spot
        ? { ...item, col: spot.col, row: spot.row }
        : { ...item, col: 0, row: HomeLayout.MAX_ROWS });
      changed = true;
    }

    // Anything present but never placed — a newly added app, or one whose
    // stored cell was a widget's and got reclaimed above.
    for (const id of wanted) {
      if (seen.has(id)) continue;
      const item = { type: 'app', slug: id.slice(4) };
      const size = HomeLayout.sizeOf(item, cols);
      const spot = HomeLayout.firstFreeCell(out, size, cols);
      out.push(spot
        ? { ...item, col: spot.col, row: spot.row }
        : { ...item, col: 0, row: HomeLayout.MAX_ROWS });
      changed = true;
    }

    return { layout: out, changed };
  },

  // ── The drop rule ──────────────────────────────────────────────────

  // Do two rectangles overlap at all?
  _overlaps(a, b) {
    return a.col < b.col + b.w && b.col < a.col + a.w
      && a.row < b.row + b.h && b.row < a.row + a.h;
  },

  // The item's rectangle at this column count.
  _rectOf(item, cols) {
    const [w, h] = HomeLayout.sizeOf(item, cols);
    return { col: item.col, row: item.row, w, h };
  },

  // First free spot for `size` INSIDE `region`, in reading order, or null.
  // Used to prefer the cells the dragged item just vacated when pushing an
  // occupant out of the way — which is what makes a same-size collision read
  // as a straight swap rather than a trip to the top-left corner.
  _fitWithin(region, size, taken, cols) {
    const [w, h] = size;
    for (let row = region.row; row <= region.row + region.h - h; row++) {
      for (let col = region.col; col <= region.col + region.w - w; col++) {
        if (HomeLayout.fits(taken, col, row, w, h, cols)) return { col, row };
      }
    }
    return null;
  },

  // Can `item` land with its top-left at (col,row)? Clamped first, so a drag
  // toward an edge reports the nudged-inward position rather than "no".
  //
  // Essentially everything on the canvas is a legal target now: an occupied
  // one DISPLACES its occupants rather than refusing the drop (see place).
  // That is what lets the drag overlay tint every cell the finger crosses,
  // and it is why this is a thin wrapper rather than its own predicate — the
  // highlight the user sees and the drop that commits must be the same
  // decision, or the grid lies about where a release will land.
  canPlace(layout, item, col, row, cols) {
    return HomeLayout.place(layout, item, col, row, cols) !== null;
  },

  // Apply a drop. Returns a NEW layout array, or null only when the item
  // isn't in the layout at all (nothing to move).
  //
  // DISPLACEMENT, not swap-or-refuse. Whatever sits in the target rectangle
  // is pushed out of the way; the dragged item takes the spot. Each displaced
  // occupant goes, in reading order:
  //
  //   1. into the cells the dragged item just VACATED — so the two tiles
  //      exchange places, which is the least surprising outcome and matches
  //      what a home screen does;
  //   2. otherwise the first free rectangle in reading order;
  //   3. otherwise the overflow region below the canvas, which is never a
  //      dropped tile.
  //
  // What it deliberately does NOT do is re-pack the grid. Only items whose
  // footprint actually intersects the target move at all — every other item,
  // and every intentional hole, is left exactly as it was. That is the whole
  // difference between this and the flow reorder it replaced.
  //
  // The dragged item's own footprint is excluded from the occupancy test, so
  // an item may be dropped at ANY position overlapping where it already is
  // (nudged one cell over, say), which a naive "target must be empty" rule
  // rejects outright.
  place(layout, item, col, row, cols) {
    const id = HomeLayout.idOf(item);
    const [w, h] = HomeLayout.sizeOf(item, cols);
    const c = Math.max(0, Math.min(Number(col), cols - w));
    const r = Math.max(0, Math.min(Number(row), HomeLayout.MAX_ROWS - h));
    if (!Number.isFinite(c) || !Number.isFinite(r)) return null;

    const current = (layout || []).find((it) => HomeLayout.idOf(it) === id);
    if (!current) return null;

    const vacated = HomeLayout._rectOf(current, cols);
    const target = { col: c, row: r, w, h };
    const others = (layout || []).filter((it) => HomeLayout.idOf(it) !== id);

    // Only what the target rectangle actually touches is disturbed. Overflow
    // items are off-canvas and can never be in the way.
    const displaced = HomeLayout.readingOrder(others.filter((it) => (
      it.row < HomeLayout.MAX_ROWS && HomeLayout._overlaps(HomeLayout._rectOf(it, cols), target)
    )));
    const displacedIds = new Set(displaced.map(HomeLayout.idOf));

    // Resolve each displaced occupant against a working set that already
    // holds the dragged item at its new spot, so nothing lands under it.
    // Untouched items keep their exact cells — holes included.
    const settled = others.filter((it) => !displacedIds.has(HomeLayout.idOf(it)));
    settled.push({ ...current, col: c, row: r });
    const moves = new Map([[id, { col: c, row: r }]]);

    for (const d of displaced) {
      const size = HomeLayout.sizeOf(d, cols);
      const taken = HomeLayout.occupancy(settled, cols);
      const spot = HomeLayout._fitWithin(vacated, size, taken, cols)
        || HomeLayout.firstFreeCell(settled, size, cols)
        || { col: 0, row: HomeLayout.MAX_ROWS };
      settled.push({ ...d, col: spot.col, row: spot.row });
      moves.set(HomeLayout.idOf(d), spot);
    }

    // Rebuilt in the INPUT's array order. Nothing downstream depends on it
    // (reflow / repair / toWire all sort by reading order), but a drop that
    // silently reshuffled the array would be a trap for anything that ever
    // does.
    return (layout || []).map((it) => {
      const spot = moves.get(HomeLayout.idOf(it));
      return spot ? { ...it, col: spot.col, row: spot.row } : it;
    });
  },

  // ── Overflow ───────────────────────────────────────────────────────

  // Items parked at/after MAX_ROWS. They render below the canvas in plain
  // flow (dense, no holes) and can be dragged back up whenever space frees.
  // The 8-row cap bounds free PLACEMENT, never how many apps you may have —
  // stranding a tile would be far worse than an extra row.
  overflowItems(layout) {
    return HomeLayout.readingOrder(
      (layout || []).filter((it) => it.row >= HomeLayout.MAX_ROWS)
    );
  },

  // Items on the canvas proper.
  canvasItems(layout) {
    return HomeLayout.readingOrder(
      (layout || []).filter((it) => it.row < HomeLayout.MAX_ROWS)
    );
  },

  // ── The Create tile's cell ─────────────────────────────────────────
  //
  // The launcher ENDS with a dashed "Create an app" tile (the prototype's
  // scrHome: `.tile.create`, the grid's last child). It is not an ITEM of
  // this model, and that is the whole design: it is never stored, never
  // dragged, never displaced and never persisted. Its cell is DERIVED on
  // every paint as the one straight after the last tile in reading order, so
  // it follows the grid instead of holding a place in it:
  //
  //   * a drop onto the cell it is drawn in is an ordinary drop onto an empty
  //     cell — the model has nothing there — and the next paint moves the
  //     tile along behind the app that landed;
  //   * a hole the viewer left earlier in the grid stays a hole. The tile
  //     goes after the LAST tile, never into the first gap.
  //
  // `items` is what the caller is about to DRAW (the collapsed grid's shown
  // rows, or the whole canvas), so "last" means last on screen. Overflow
  // items are ignored here: they have no cell, and a caller drawing them
  // flows the tile after them instead. An empty canvas answers (0, 0).
  // Pure — unit-tested in tests/home-layout-model.test.js.
  trailingCell(items, cols) {
    let last = null;
    for (const item of items || []) {
      if (!item || item.row >= HomeLayout.MAX_ROWS) continue;
      if (!last || item.row > last.row || (item.row === last.row && item.col > last.col)) {
        last = item;
      }
    }
    if (!last) return { col: 0, row: 0 };
    const [w, h] = HomeLayout.sizeOf(last, cols);
    const col = last.col + w;
    return col < cols ? { col, row: last.row } : { col: 0, row: last.row + h };
  },

  // Whether a COLLAPSED grid holds the Create tile back (#3047).
  //
  // The tile follows the last tile shown (trailingCell). When that last shown
  // row is FULL, the tile would start a row of its own — one past what the
  // collapsed grid shows: a third row under a two-row launcher of eight apps,
  // and on a phone that pushed "Show all N apps" and the Discover heading
  // under the tab bar. The budget exists precisely to keep the sections below
  // within reach (Home.visibleRowBudget).
  //
  // So the tile goes behind "Show all N apps" instead, exactly like an app
  // past the bound: the collapsed grid never draws a row for the tile alone,
  // and the expanded grid ends with it as always. It is never traded for a
  // row of apps (the rule this replaced), and it never hides when it fits
  // beside the last tile shown.
  //
  // `shown` is what the caller is about to draw and `bound` the last row
  // index the collapsed window may draw (defaultRowBound). An empty `shown`
  // never holds it back: an empty launcher's tile flows after the
  // "No apps added yet" note and must always be there.
  // Pure — unit-tested in tests/home-layout-model.test.js.
  createTileCollapsed(shown, cols, bound) {
    const onCanvas = (shown || []).filter((it) => it && it.row < HomeLayout.MAX_ROWS);
    if (!onCanvas.length) return false;
    return HomeLayout.trailingCell(onCanvas, cols).row > bound;
  },

  // The wire shape for PUT /api/home-layout: canvas items only (the server's
  // CHECK constraint rejects row >= MAX_ROWS, and an overflow item has no
  // placement worth remembering — it comes back from the same derivation
  // next load).
  toWire(layout) {
    return HomeLayout.canvasItems(layout).map((it) => (
      { type: 'app', slug: it.slug, col: it.col, row: it.row }
    ));
  },
};

// Browser global, guarded because the SSG prerender pass evaluates the home
// island's whole module graph in Node, where there is no `window` (#1083 chunk
// F step 4 moved this file into the React bundle).
//
// It stays for its two readers, home.js and home-panels.js, which reach
// `HomeLayout` as a bare identifier rather than importing it — 40 call sites
// between them. Being in the same bundle does NOT make those resolve
// lexically: each file is a module with its own scope, and the bundler
// minifies this object's local name away (it is `_e` in the shipped
// shell.js). `window.HomeLayout` is the binding all 40 reads actually find,
// exactly as it was when all three were classic scripts. No classic script
// outside this trio reads it.
//
// The `module.exports` twin that used to sit here is gone: frontend/ is
// `"type": "module"`, so Node reads this file as ESM and the guard could never
// fire. tests/home-layout-model.test.js evaluates the source with
// `new Function` instead — host realm, not a vm context, because its
// assertions are deepEqual over arrays and a vm's own Array.prototype makes
// those fail on reference identity alone.
if (typeof window !== 'undefined') window.HomeLayout = HomeLayout;
