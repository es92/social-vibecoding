// #687 — frontend tests for the "Import Feature from a PR" "+" menu entry:
// the item renders only when can_collaborate && !readOnly, and the prop that
// gates it is fed from appData.can_collaborate by the module that still
// evaluates it. Loads the real public/js/app-view.js into a vm context (so
// the tests can't drift from shipped code) for that derivation, and asserts
// the markup against the component source.
//
// The picker dialog this item opens is tests/dialog-import-pr.test.js — see
// the note at the bottom of this file.
//
// Run with: node --test tests/pr-import-menu.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// ── shared element stub ──────────────────────────────────────────────────
function makeEl() {
  const el = {
    dataset: {},
    style: {},
    textContent: '',
    className: '',
    disabled: false,
    _html: '',
    _classes: new Set(['hidden']),
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    setAttribute: () => {},
    scrollTop: 0,
  };
  el.classList = {
    // Varargs like the real DOM API — _setImportPrBusy adds/removes two
    // classes in one call (#846).
    add: (...cs) => cs.forEach((c) => el._classes.add(c)),
    remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
    contains: (c) => el._classes.has(c),
    toggle: () => false,
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v) => { el._html = v; },
  });
  return el;
}

// ── the menu-item render gate ────────────────────────────────────────────

// Minimal render harness reused from the dev "+" menu tests: capture the
// HTML renderDevView writes into #app-content.
function makeRenderHarness() {
  const content = makeEl();
  const captured = { get html() { return content.innerHTML; } };
  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    Date,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    resolveDevHost: (u) => u,
    App: { user: { id: 1 }, currentApp: 'x', switchTab: () => {} },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: (id) => (id === 'app-content' ? content : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => makeEl(),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VIEW_SRC, sandbox);
  return { AppView: sandbox.window.AppView, captured };
}

const BASE_APP = {
  slug: 'x', name: 'X', status: 'running', self_hosted: false,
  collab_visibility: 'public', view_visibility: 'public',
  can_manage: false, can_collaborate: true,
};

// #1084 chunk G: the "+" menu is a React component now
// (frontend/src/features/dev-board/actions-row.tsx), so there is no innerHTML
// string on #app-content to capture. These tests run with no
// frontend/node_modules — the root install never touches that workspace — so
// the markup is asserted against the component source and the GATE is asserted
// against the module that still evaluates it, the same split
// tests/dev-plus-menu.test.js and tests/standings-screen.test.js use.
const FRAME_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-board', 'actions-row.tsx'),
  'utf8'
);

test('import-pr item renders for a collaborator', () => {
  const start = FRAME_SRC.indexOf('{canCollaborate ? (');
  assert.ok(start !== -1, 'the import-pr row is gated on the canCollaborate prop');
  const end = FRAME_SRC.indexOf(') : null}', start);
  const gated = FRAME_SRC.slice(start, end);
  assert.ok(gated.includes('data-plus="import-pr"'), 'import-pr item present');
  assert.ok(gated.includes('Import Feature from a PR'), 'label present');
  // The group heading is NOT the row's to hide. #1490 gated heading and row
  // together, because import was the group's only action once New change
  // started in Improve; #1900 put File an issue back beside it, ungated, so
  // the group stays populated for every writeable viewer and only the import
  // row is conditional.
  assert.ok(!gated.includes('<PlusMenuHeading'), 'the heading is outside the row gate');
  assert.ok(FRAME_SRC.indexOf('label="Add to the board"') < start,
    'the group heading renders above the gate');
  assert.ok(FRAME_SRC.indexOf('data-plus="issue"') < start,
    'File an issue leads the group, outside the gate');
  assert.ok(FRAME_SRC.indexOf('data-plus="import-pr"') < FRAME_SRC.indexOf('groupKey="settings"'),
    'import-pr renders before the settings group');
  // …and the prop is fed from appData.can_collaborate, read in the module.
  assert.match(
    VIEW_SRC,
    /canCollaborate:\s*!!AppView\.appData\?\.can_collaborate/,
    'renderDevView passes appData.can_collaborate as the canCollaborate prop'
  );
});

test('import-pr item hidden for a non-collaborator', () => {
  // The row exists ONLY inside the canCollaborate branch — nowhere else in the
  // component — so a falsey prop is the whole gate.
  const hits = FRAME_SRC.split('data-plus="import-pr"').length - 1;
  assert.equal(hits, 1, 'exactly one import-pr row, inside the gate');
});

test('import-pr item hidden in read-only mode (can_collaborate === false)', async () => {
  // AppView.readOnly is derived: !!appData && can_collaborate === false. The
  // import-pr item sits inside the !readOnly block AND is gated on
  // can_collaborate, so a read-only viewer never sees it — only Fork. The
  // derivation is still the module's, so it is still checked there.
  const { AppView } = makeRenderHarness();
  AppView.appData = { ...BASE_APP, can_collaborate: false };
  assert.equal(AppView.readOnly, true, 'viewer is read-only');

  const roStart = FRAME_SRC.indexOf('{readOnly ? null : (');
  const roEnd = FRAME_SRC.indexOf('{selfHosted ? null : (', roStart);
  assert.ok(roStart !== -1 && roEnd !== -1, 'the writeable block is gated on readOnly');
  const gated = FRAME_SRC.slice(roStart, roEnd);
  assert.ok(gated.includes('data-plus="import-pr"'), 'read-only hides import-pr');
  assert.ok(FRAME_SRC.slice(roEnd).includes('data-plus="fork"'),
    'read-only viewer still gets Fork');
});

// ── the dialog itself ────────────────────────────────────────────────────
//
// openImportPrModal / _loadImportPrCandidates / submitImportPr and their
// error, freeze and navigation behaviour moved into
// frontend/src/features/dialogs/import-pr.tsx in #1078 chunk I, when the
// dialog became a stateful island. They are covered by
// tests/dialog-import-pr.test.js, which is written against that component the
// way the other converted-screen tests are. What stays here is the '+' menu
// entry that OPENS it, which is still the dev board's and the module's.
