// Install the launcher grid's view-model store into a vm sandbox.
//
// #1191 converted `#app-list` to React: `Home.render()` no longer assigns
// innerHTML, it pushes a plain view model into
// frontend/src/features/home/grid-store.ts, which features/home/app-grid.tsx
// renders. home.js reaches that store by `import`, and ./home-modules strips
// every import line so the source can run as classic script text in a vm — so
// any test that CALLS Home.render() has to supply the binding the import would
// have made, exactly as installAppCard(sandbox) already does for the shared
// card builders.
//
// This installs the REAL store rather than a spy: lib/plain-store.js is a few
// lines of dependency-free JavaScript, and running the shipped implementation
// means a test asserting on `gridStore.get()` is asserting on the same
// merge/notify semantics the browser gets — including the "a patch that
// changes nothing does not notify" rule, which is what keeps a no-op render
// from waking React.
//
// The store's own module is TypeScript, so its INITIAL value is transcribed
// here rather than parsed out of it. tests/home-grid-store-initial.test.js
// pins the two against each other, so a field added there without one here
// fails loudly instead of silently reading undefined.
//
// The home screen has TWO of these stores and `Home.render()` pushes both on
// the same pass, so both are installed here. `chromeStore` holds the two hosts
// OUTSIDE the launcher canvas — "Show all N apps" and the iOS widget strip —
// which is why it is a separate store and not another field on the grid: the
// grid model is deliberately not pushed mid-drag (see grid-store.ts), and
// those two have nothing to do with that guard.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLAIN_STORE_PATH = path.join(
  __dirname, '..', '..', 'frontend', 'src', 'lib', 'plain-store.js'
);

// Classic-script form: `export` stripped, same shape as the AdminUI registry
// eval in tests/admin-ui-registry.test.js and installAppCard's app-card.js.
const PLAIN_STORE_SRC = fs.readFileSync(PLAIN_STORE_PATH, 'utf8')
  .replace(/^export\s+/gm, '');

/** Mirrors INITIAL_GRID in frontend/src/features/home/grid-store.ts. */
const INITIAL_GRID = {
  ready: false,
  view: 'grid',
  rowTemplate: '',
  items: [],
  resultsHeading: null,
  emptyQuery: null,
  notice: null,
  create: null,
  editing: false,
};

/** Mirrors INITIAL_CHROME in frontend/src/features/home/chrome-store.ts. */
const INITIAL_CHROME = {
  moreCount: 0,
  strip: { active: false, helpVisible: false, tiles: [] },
};

/**
 * Declares `gridStore` and `chromeStore` in the sandbox's global lexical scope
 * — the same scope home.js resolves them against once its import lines are
 * stripped.
 *
 * Returns the grid store, which is what every caller written before the second
 * store existed expects. The chrome store is read off the sandbox itself
 * (`sandbox.chromeStore`) by the handful of tests that assert on it.
 */
function installGridStore(sandbox) {
  vm.runInContext(
    `${PLAIN_STORE_SRC}`
    + `\n;var gridStore = createStore(${JSON.stringify(INITIAL_GRID)});`
    + `\n;var chromeStore = createStore(${JSON.stringify(INITIAL_CHROME)});`,
    sandbox,
  );
  return sandbox.gridStore;
}

/** Mirrors INITIAL_PANELS in frontend/src/features/home/panels-store.ts. */
const INITIAL_PANELS = {
  painted: false,
  challenges: null,
};

/**
 * The same for home-panels.js, which imports its own store.
 *
 * A THIRD store rather than a field on either of the others, because it is a
 * different module's paint: `HomePanels.render()` is called from
 * `Home.render()` but also on its own (an expand toggle, an optimistic hide),
 * and the blocks have nothing to do with the launcher canvas.
 */
function installPanelsStore(sandbox) {
  vm.runInContext(
    `${PLAIN_STORE_SRC}\n;var panelsStore = createStore(${JSON.stringify(INITIAL_PANELS)});`,
    sandbox,
  );
  return sandbox.panelsStore;
}

module.exports = {
  installGridStore, installPanelsStore,
  INITIAL_GRID, INITIAL_CHROME, INITIAL_PANELS, PLAIN_STORE_SRC,
};
