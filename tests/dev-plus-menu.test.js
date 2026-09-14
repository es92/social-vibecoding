// Frontend tests for issue #645: the Dev "+" menu absorbs the hamburger
// drawer's "Members & visibility" entry, and the intermediate "App
// settings" sub-page is dissolved into direct "App display name" /
// "App secrets" items.
//
// We load the real app-view.js / app.js into a vm context (so the tests
// can't drift from shipped code), render the dev card list against stub
// DOM elements, and assert on the produced header markup:
//   - data-plus="members" renders exactly when the old drawer-row gate
//     held (creator/admin, or collaborator of an invite-only app; never
//     for the self-app).
//   - data-plus="rename" / data-plus="secrets" render for every
//     non-read-only viewer; data-plus="settings" is gone.
//   - Read-only viewers still get only "Fork this app".
//   - Old #app/<slug>/dev/settings deep links normalize to the card list.
//
// Run with: node --test tests/dev-plus-menu.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);
const APP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'),
  'utf8'
);
const HTML_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8'
);

// Minimal DOM element stub — enough for renderDevView's card-list branch
// to set innerHTML and for the wiring helpers to no-op past it.
function makeEl() {
  return {
    dataset: {},
    style: {},
    textContent: '',
    className: '',
    innerHTML: '',
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => false,
    },
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    setAttribute: () => {},
    scrollTop: 0,
  };
}

// Load app-view.js in a vm sandbox and return its AppView (off window,
// same as the browser handlers see it).
function makeViewHarness(els = {}) {
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
      getElementById: (id) => (id in els ? els[id] : null),
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
  return sandbox.window.AppView;
}

// ── where the "+" menu's markup lives now (#1084 chunk G) ────────────────
//
// The card list's header bar — caption, view-mode toggle, "+" button and this
// whole dropdown — is a React component since chunk G, so there is no longer an
// innerHTML string on #app-content to capture. The gate the tests below care
// about did NOT move: AppView._plusMenuShowsMembers() is still the predicate,
// and renderDevView still evaluates it and passes the answer down as the
// `showsMembers` prop. So the coverage splits in two, the same way
// tests/standings-screen.test.js split when its tab strip converted:
//
//   * the PREDICATE keeps its vm-context test against the shipped module —
//     that is where the creator/admin/collaborator rule actually lives;
//   * the MARKUP is asserted against the component source, because these tests
//     run with no frontend/node_modules (the root install never touches that
//     workspace), so there is no React to render with.
//
// The seam between the two — that renderDevView computes the predicate and the
// component consumes it — is asserted once, explicitly, below.
const FRAME_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-board', 'actions-row.tsx'),
  'utf8'
);

// The `showsMembers ? … : null` block, so a test can assert on the members row
// without matching text that happens to appear elsewhere in the file.
function membersBlock() {
  const start = FRAME_SRC.indexOf('{showsMembers ? (');
  assert.ok(start !== -1, 'the members row is still gated on the showsMembers prop');
  const end = FRAME_SRC.indexOf('data-plus="rename"', start);
  assert.ok(end !== -1, 'the rename row still follows the members row');
  return FRAME_SRC.slice(start, end);
}

// Which of the two label pairs a `selfHosted` branch renders.
function selfHostedBranch(block) {
  const start = block.indexOf('{selfHosted ? (');
  assert.ok(start !== -1, 'the members row still branches on selfHosted');
  const split = block.indexOf(') : (', start);
  return { whenSelfHosted: block.slice(start, split), otherwise: block.slice(split) };
}

const BASE_APP = {
  slug: 'x',
  name: 'X',
  status: 'running',
  self_hosted: false,
  collab_visibility: 'public',
  view_visibility: 'public',
  can_manage: false,
  can_collaborate: true,
};

// ── the members item obeys the old drawer-row gate ───────────────────────

test('the members item is gated on the predicate, and only on the predicate', () => {
  const block = membersBlock();
  assert.ok(block.includes('data-plus="members"'), 'members item lives inside the gate');
  // The gate is the prop, not a re-derivation of the rule inside the component.
  assert.ok(!FRAME_SRC.includes('can_manage'), 'component does not re-derive the manage rule');
  assert.ok(!FRAME_SRC.includes('collab_visibility'), 'component does not re-derive visibility');
  assert.ok(!FRAME_SRC.includes('approver_policy'), 'component does not re-derive the policy');
  // …and renderDevView is what evaluates it and hands the answer over.
  assert.match(
    VIEW_SRC,
    /showsMembers:\s*AppView\._plusMenuShowsMembers\(\)/,
    'renderDevView passes the predicate result as the showsMembers prop'
  );
});

test('the members item keeps both label pairs, branched on self_hosted', () => {
  const { whenSelfHosted, otherwise } = selfHostedBranch(membersBlock());
  assert.ok(whenSelfHosted.includes('Proposal approvals'), 'self-app label is Proposal approvals');
  assert.ok(
    whenSelfHosted.includes('Who approves proposals and how many approvals are needed'),
    'self-app sublabel unchanged'
  );
  assert.ok(!whenSelfHosted.includes('Members &amp; visibility'),
    'self-app does not use the Members label');
  assert.ok(otherwise.includes('Members &amp; visibility'), 'other apps keep the Members label');
  assert.ok(otherwise.includes('Who can build and see this app'), 'sublabel unchanged');
  // The prop feeding that branch is appData.self_hosted, read in the module.
  assert.match(
    VIEW_SRC,
    /selfHosted:\s*!!AppView\.appData\?\.self_hosted/,
    'renderDevView passes appData.self_hosted as the selfHosted prop'
  );
});

test('rename and secrets are ungated — they render for every writeable viewer', () => {
  // Both sit in the `readOnly ? null : (…)` block alongside members, and
  // neither is wrapped in a further condition. The rename row's only
  // conditional is its top border, which depends on whether members rendered
  // above it.
  const start = FRAME_SRC.indexOf('data-plus="rename"');
  const end = FRAME_SRC.indexOf('data-plus="fork"');
  assert.ok(start !== -1 && end !== -1 && start < end, 'rename precedes fork');
  const tail = FRAME_SRC.slice(start, end);
  assert.ok(tail.includes('data-plus="secrets"'), 'secrets renders between rename and fork');
  assert.match(
    tail.slice(0, 300),
    /showsMembers \? PLUS_ROW_DIVIDER_CLS : ''/,
    "rename's divider is the only thing the members gate changes about it"
  );
});

test('_plusMenuShowsMembers mirrors the old drawer-row predicate', () => {
  const AppView = makeViewHarness();
  const cases = [
    [{ ...BASE_APP, can_manage: true }, true],
    [{ ...BASE_APP, collab_visibility: 'private' }, true],
    [{ ...BASE_APP, approver_policy: 'invited' }, true],
    [{ ...BASE_APP, approver_policy: 'invited', can_collaborate: false }, false],
    [{ ...BASE_APP }, false],
    [{ ...BASE_APP, self_hosted: true, can_manage: true }, true],
    [{ ...BASE_APP, self_hosted: true }, false],
    [null, false],
  ];
  for (const [appData, expected] of cases) {
    AppView.appData = appData;
    assert.equal(AppView._plusMenuShowsMembers(), expected,
      `gate for ${JSON.stringify(appData && { m: appData.can_manage, v: appData.collab_visibility, p: appData.approver_policy, s: appData.self_hosted })}`);
  }
});

// ── the App settings nesting is gone; rename/secrets are direct items ────

test('"+" menu has direct rename and secrets items, no App settings entry', () => {
  assert.ok(!FRAME_SRC.includes('data-plus="settings"'), 'nested App settings entry removed');
  assert.ok(FRAME_SRC.includes('data-plus="rename"'), 'rename item present');
  assert.ok(FRAME_SRC.includes('App display name'), 'rename label present');
  assert.ok(FRAME_SRC.includes('data-plus="secrets"'), 'secrets item present');
  assert.ok(FRAME_SRC.includes('id="dc-secrets-state"'),
    'secrets item carries the missing-required state slot for refreshDevChatSecretsState');
  // Fork stays last in the menu.
  assert.ok(FRAME_SRC.indexOf('data-plus="secrets"') < FRAME_SRC.indexOf('data-plus="fork"'),
    'fork renders after secrets');
  // The slot is an EMPTY leaf: refreshDevChatSecretsState writes its
  // textContent, so React must not render a text child there or a re-render
  // would clobber it.
  assert.match(
    FRAME_SRC,
    /id="dc-secrets-state"[\s\S]{0,140}?><\/span>/,
    'the secrets-state slot renders empty for the module to fill'
  );
});

test('read-only viewers get only Fork in the "+" menu', () => {
  // Everything except Fork sits inside `readOnly ? null : (…)`.
  const start = FRAME_SRC.indexOf('{readOnly ? null : (');
  const end = FRAME_SRC.indexOf('{selfHosted ? null : (', start);
  assert.ok(start !== -1 && end !== -1 && start < end,
    'the writeable block is gated on readOnly and closes before the fork row'
  );
  const gated = FRAME_SRC.slice(start, end);
  for (const item of ['issue', 'import-pr', 'members', 'rename', 'secrets']) {
    assert.ok(gated.includes(`data-plus="${item}"`), `${item} item is inside the readOnly gate`);
  }
  assert.ok(!gated.includes('data-plus="fork"'), 'fork is NOT inside the readOnly gate');
  assert.ok(FRAME_SRC.slice(end).includes('data-plus="fork"'), 'fork item still present');
  // Read-only also swaps the "+" button's tooltip and, on the self-app,
  // hides the button outright.
  assert.ok(FRAME_SRC.includes("? 'Fork this app'"), 'read-only tooltip preserved');
  // Tolerant of layout classes between 'relative' and the gate: #1440 added
  // `ml-auto` here and broke a version of this that pinned the exact string.
  // What this test protects is the readOnly && selfHosted gate, not the
  // flex utilities beside it.
  assert.match(
    FRAME_SRC,
    /relative[^`$]*\$\{readOnly && selfHosted \? 'hidden' : ''\}/,
    'the "+" button is hidden for a read-only viewer of the self-app'
  );
  assert.match(
    VIEW_SRC,
    /readOnly:\s*!!AppView\.readOnly/,
    'renderDevView passes AppView.readOnly as the readOnly prop'
  );
});

// ── the settings sub-page and its routing are gone ───────────────────────

test('old dev/settings deep links normalize to the dev card list', () => {
  const sandbox = {
    console,
    URLSearchParams,
    location: { search: '', hash: '', pathname: '/' },
    document: { getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => ({ forEach: () => {} }) },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox);
  const App = sandbox.window.App;
  // Field-by-field (the vm realm's Object.prototype differs, so
  // deepStrictEqual would reject an otherwise-identical object).
  const norm = App._normalizeTab('dev', null, 'settings');
  assert.equal(norm.tab, 'dev', 'stays on the dev tab');
  assert.equal(norm.subTab, 'forum', 'dev/settings falls through to the card list');
  assert.equal(norm.ref, null, 'no deep-link payload');
});

test('app.js no longer parses, writes, or screens the dev/settings hash', () => {
  assert.ok(!APP_SRC.includes("sec === 'settings'"), 'hash parse branch removed');
  assert.ok(!APP_SRC.includes('dev/settings`'), 'updateHash never emits dev/settings');
  const subScreens = APP_SRC.match(/const SUB_SCREENS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(subScreens, 'SUB_SCREENS set still declared');
  assert.ok(!subScreens[1].includes("'settings'"), "SUB_SCREENS no longer lists 'settings'");
});

test('the settings sub-page renderer is gone from app-view.js', () => {
  assert.ok(!VIEW_SRC.includes('_renderSettingsView'), 'renderer removed');
  assert.ok(!VIEW_SRC.includes("subTab === 'settings'"), 'renderDevView settings branch removed');
});

// ── the hamburger drawer row is fully removed ────────────────────────────

test('index.html has no Members & visibility drawer row', () => {
  assert.ok(!HTML_SRC.includes('id="drawer-row-members"'), 'drawer row markup removed');
});

test('app.js no longer wires or gates the drawer members row', () => {
  assert.ok(!APP_SRC.includes("getElementById('drawer-row-members')"), 'all drawer-row-members lookups removed');
});

test('the ?shot=plus-menu hook waits for a button that now arrives late', () => {
  // It was one setTimeout(300) and a `?.click()`. That was sound while
  // #dev-plus-btn lived in the frame's chrome, which mounts with
  // #app-content — the button existed long before 300ms.
  //
  // The button moved into the Workshop's pane, and #dev-workshop is created
  // by _repaintDevBody AFTER _loadDevFeed's fetches. At 300ms it may not
  // exist, and optional chaining on a missing node does nothing SILENTLY: the
  // capture shot a board with no menu and the declared check read "text not
  // found". That is how this reached a gate rather than a test.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
  const i = src.indexOf("if (shot === 'plus-menu')");
  assert.ok(i > 0, 'the hook exists');
  const block = src.slice(i, src.indexOf("if (shot === 'card-menu')", i));
  assert.match(block, /setInterval\(/, 'it retries rather than firing once');
  assert.ok(!/setTimeout\(/.test(block), 'and no single-shot timeout is left');
  // Bounded, so a capture that never gets a button stops trying.
  assert.match(block, /tries \+= 1\) > \d+/, 'the window is bounded');
  // Re-asserted across repaints: each dismisses an open menu by design, so
  // stopping at the first success would leave the shot empty.
  assert.match(block, /dev-plus-menu[\s\S]{0,200}classList\.contains\('hidden'\)/,
    'it re-opens a menu a repaint dismissed');
  // ...and a human's first real gesture ends it, so a person following one of
  // these links does not get a menu put back under them.
  assert.match(block, /e\.isTrusted\) done\(\)/);
});
