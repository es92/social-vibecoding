// Frontend tests for the gesture-safe modal open path that fixes the
// "Members & approvals does nothing" bug (and its follow-up, "drawer
// closes but no panel").
//
// The bug: a drawer row's click handler reveals a full-screen modal, and on
// a touch device / WebView the tap that opened it can synthesize a trailing
// `click` (~300ms after `touchend`) that lands on the freshly-shown
// [data-modal-backdrop] and dismisses the modal in the same gesture — the
// user saw nothing happen. An earlier fix deferred the reveal to
// requestAnimationFrame, but that frame callback proved unreliable in the
// platform WebView (throttled/dropped), leaving the drawer closed with NO
// panel. The reliable fix, all in AppView:
//   - revealModal(): show the modal SYNCHRONOUSLY + stamp the open time, so
//     the panel always appears.
//   - modalDismissGuarded(): true while within MODAL_GESTURE_GUARD_MS of the
//     open, so the backdrop-dismiss handler ignores the trailing ghost click
//     (this, not the deferral, is what keeps the modal open).
//   - openMembersModal(): no longer returns silently when no app is loaded —
//     it warns and surfaces a message in #members-load-error.
//
// We load the real app-view.js into a vm context (so the tests can't drift
// from shipped code), drive a controllable clock, and assert behaviour. We
// also source-grep app.js so the backdrop handlers can't silently stop
// calling the guard — and settings.js, which must NOT: the
// settings-modal-to-screen conversion made Settings the #settings screen,
// so it has no backdrop and no modal reveal any more.
//
// Run with: node --test tests/members-modal-gesture.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);
const APP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'),
  'utf8'
);
const SETTINGS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'settings.js'),
  'utf8'
);
const MIGRATE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'migrate.js'),
  'utf8'
);
// #1078 chunk I made all nine dialogs stateful islands. Two pieces of the
// story above moved as a result, and this file follows them:
//   - the members dialog's behaviour is in the island's controller now, so
//     the harness folds it back onto window.AppView the way init() does;
//   - the reveal + the openedAt stamp belong to useStaticModal, which does
//     both in ONE layout effect for every dialog — rather than only the open
//     paths that remembered to call AppView.revealModal. That helper stays in
//     app-view.js (the staging compare overlay still uses it) and is still
//     tested here, because the guard semantics are shared by both copies.
const MEMBERS_RAW = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dialogs', 'members-controller.js'),
  'utf8'
);
// Evaluated as an expression rather than a script: the module's own `let
// AppView` is a file-local, and app-view.js declares that name at the vm
// context's top level, so the two would collide in one shared lexical scope.
// The wrapper is the module boundary a bundler gives it in the browser.
const MEMBERS_SRC = `(function () {\n${
  MEMBERS_RAW.replace(/^export \{[^}]*\};$/gm, '').replace(/^export /gm, '')
}\nreturn { init, MembersDialog };\n})()`;
const STATIC_MODAL_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'lib', 'static-modal.ts'),
  'utf8'
);
const USE_DIALOG_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dialogs', 'use-dialog.ts'),
  'utf8'
);

// Minimal DOM element stub: a classList that actually tracks classes, a
// dataset bag, and the text/className fields openMembersModal touches.
function makeEl(initialClasses = []) {
  const set = new Set(initialClasses);
  return {
    dataset: {},
    style: {},
    textContent: '',
    className: [...set].join(' '),
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !set.has(c) : !!on;
        if (want) set.add(c); else set.delete(c);
        return want;
      },
    },
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
  };
}

// Build an AppView in a vm context with a controllable clock.
function makeHarness(elements) {
  const clock = { t: 1_000_000 };
  const warnings = [];
  const els = elements || {};

  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    console: { ...console, warn: (...a) => warnings.push(a), debug: () => {} },
    Date: { now: () => clock.t },
    relTime: () => 'just now',
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    resolveDevHost: (u) => u,
    App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => makeEl(),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({ collaborators: [] }) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Run the file AS-IS — do NOT grab `AppView` via the bareword binding.
  // We deliberately read it back off `window`, so these tests only pass if
  // app-view.js actually exposes `window.AppView = AppView` (the bug that
  // made the drawer handlers' `if (window.AppView)` check fail on device).
  vm.runInContext(VIEW_SRC, sandbox);
  // …then the island's controller, exactly as its init() does in the browser:
  // Object.assign's every MembersDialog method back onto the live AppView, so
  // `AppView.openMembersModal` and friends resolve for the legacy callers.
  vm.runInContext(MEMBERS_SRC, sandbox).init();

  return { AppView: sandbox.window.AppView, clock, warnings, sandbox };
}

// ── the global the drawer handlers depend on is actually exposed ─────────
//
// The drawer-row handlers in app.js gate on `window.AppView` (and call
// AppView.openMembersModal/openShareModal). app-view.js declares
// `const AppView = {…}`, which in a classic script is NOT a window property,
// so the handlers saw `window.AppView === undefined` and the panels never
// opened ("drawer-row-members CLICK fired → window.AppView MISSING"). These
// tests fail if app-view.js stops assigning window.AppView.

test('app-view.js exposes AppView on window (drawer handlers can reach it)', () => {
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    relTime: () => '', escapeHtml: (s) => s, escapeAttr: (s) => s, resolveDevHost: (u) => u,
    App: { user: { id: 1 } }, Kudos: { renderButton: () => '' }, ConfirmModal: {},
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => ({ forEach() {} }), addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }), body: { appendChild() {} } },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert() {}, addEventListener() {}, localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VIEW_SRC, sandbox);
  vm.runInContext(MEMBERS_SRC, sandbox).init();
  assert.equal(typeof sandbox.window.AppView, 'object', 'window.AppView is set');
  assert.equal(typeof sandbox.window.AppView.openMembersModal, 'function', 'openMembersModal reachable via window.AppView');
  assert.equal(typeof sandbox.window.AppView.openShareModal, 'function', 'openShareModal reachable via window.AppView');
});

test('drawer-row-members handler reaches openMembersModal through the window gate', () => {
  // Reproduce the exact guard the app.js handler uses and prove it now fires.
  const modal = makeEl(['hidden']);
  const h = makeHarness({ 'members-modal': modal });
  // The entry point forwards to the island's controller, which is what
  // reveals the dialog now — so register one and prove the call lands there.
  let islandOpens = 0;
  h.sandbox.UsernodeReact = { dialogs: { members: { open: () => { islandOpens += 1; } } } };
  // `h.AppView` is read off window (see makeHarness) — i.e. what the handler sees.
  let opened = false;
  const realOpen = h.AppView.openMembersModal.bind(h.AppView);
  h.AppView.openMembersModal = () => { opened = true; return realOpen(); };
  // The handler body: `if (window.AppView) AppView.openMembersModal();`
  const win = { AppView: h.AppView };
  if (win.AppView) win.AppView.openMembersModal();
  assert.equal(opened, true, 'handler invoked openMembersModal (window.AppView was truthy)');
  assert.equal(islandOpens, 1, 'and it opened the dialog through the island');
});

// ── revealModal: synchronous reveal + open-time stamp ────────────────────

test('revealModal reveals synchronously (panel always appears) and stamps open time', () => {
  const modal = makeEl(['hidden']);
  const h = makeHarness({ 'members-modal': modal });
  h.AppView.revealModal(modal);
  assert.equal(modal.classList.contains('hidden'), false, 'visible immediately — no frame dependency');
  assert.ok(modal.dataset.openedAt, 'open time stamped');
});

test('revealModal is a safe no-op on a missing element', () => {
  const h = makeHarness({});
  assert.doesNotThrow(() => h.AppView.revealModal(null));
});

// ── modalDismissGuarded: suppress the trailing ghost click ───────────────

test('modalDismissGuarded is true within the guard window, false after', () => {
  const modal = makeEl(['hidden']);
  const h = makeHarness({ 'members-modal': modal });
  const GUARD = h.AppView.MODAL_GESTURE_GUARD_MS;
  assert.ok(GUARD >= 300, 'guard window covers the ~300ms mobile ghost click');

  h.AppView.revealModal(modal);
  // Trailing ghost click arrives within the window → dismiss suppressed.
  h.clock.t += GUARD - 1;
  assert.equal(h.AppView.modalDismissGuarded(modal), true, 'guarded during the window');
  // A genuine later outside-click is allowed through.
  h.clock.t += 2;
  assert.equal(h.AppView.modalDismissGuarded(modal), false, 'not guarded after the window');
});

test('a never-opened modal is not guarded (no false dismiss-suppression)', () => {
  const modal = makeEl(['hidden']);
  const h = makeHarness({ 'members-modal': modal });
  assert.equal(h.AppView.modalDismissGuarded(modal), false);
});

// ── open-and-stays-visible: the end-to-end gesture story ─────────────────

test('opened members modal is visible immediately and survives the ghost click', () => {
  // The end-to-end story is unchanged; the reveal moved one layer up. The
  // island's open() stamps openedAt and drops `hidden` in one layout effect
  // (useStaticModal), so this asserts the two halves separately: the entry
  // point reaches the island, and a reveal stamped now suppresses the ghost
  // click for the whole guard window.
  const modal = makeEl(['hidden']);
  const loadError = makeEl([]);
  const h = makeHarness({ 'members-modal': modal, 'members-load-error': loadError });
  let openedThroughIsland = false;
  h.sandbox.UsernodeReact = {
    dialogs: {
      members: {
        open: () => {
          openedThroughIsland = true;
          h.AppView.revealModal(modal); // what useStaticModal's effect does
        },
      },
    },
  };

  h.AppView.appData = { collab_visibility: 'public', view_visibility: 'public', can_manage: true };
  h.AppView.openMembersModal();
  assert.equal(openedThroughIsland, true, 'the entry point opened the island');
  assert.equal(modal.classList.contains('hidden'), false, 'panel visible right after open (no rAF wait)');

  // Simulate the backdrop-dismiss handler's guard check on the ghost click.
  h.clock.t += 50; // well within the guard window
  const wouldDismiss = !h.AppView.modalDismissGuarded(modal);
  assert.equal(wouldDismiss, false, 'ghost click is suppressed → modal stays open');
  assert.equal(modal.classList.contains('hidden'), false, 'still visible');
});

test('the share entry point opens through the island too', () => {
  // Share became a real component in #1078 chunk I; `AppView.openShareModal`
  // survives only as the forward the drawer row and the app-view header call
  // by name, so what is left to pin is that the forward still lands.
  const h = makeHarness({});
  let opens = 0;
  h.sandbox.UsernodeReact = { dialogs: { share: { open: () => { opens += 1; } } } };
  h.AppView.appData = { url: 'https://demo.example' };
  h.AppView.openShareModal();
  assert.equal(opens, 1, 'share opened through the island');
  // …and is a safe no-op before hydration registers one.
  h.sandbox.UsernodeReact = undefined;
  assert.doesNotThrow(() => h.AppView.openShareModal());
});

// ── silent-guard replacement: no app loaded surfaces feedback ────────────

test('opening with no app shows a message instead of doing nothing', () => {
  const modal = makeEl(['hidden']);
  const loadError = makeEl([]);
  const h = makeHarness({ 'members-modal': modal, 'members-load-error': loadError });

  h.AppView.appData = null;
  // With no island registered the entry point falls through to the load half
  // directly, which is also what the island calls back into from onOpen.
  h.AppView.openMembersModal();

  assert.equal(h.warnings.length, 1, 'logged a console.warn for diagnosis');
  assert.match(loadError.textContent, /loading/i, 'surfaced a one-line message');
  assert.match(loadError.className, /text-red-400/, 'shown as an error');
});

test('opening is a hard no-op only when the modal element is absent', () => {
  const h = makeHarness({}); // no #members-modal
  h.AppView.appData = null;
  assert.doesNotThrow(() => h.AppView.openMembersModal());
});

// ── source wiring: handlers actually consult the guard ───────────────────

test('every dialog backdrop consults the shared dismiss guard', () => {
  // The per-modal backdrop handlers app.js used to carry are one shared rule
  // now: useDialog hands every dialog root the same backdropProps, which
  // consults static-modal.ts's isDismissGuarded before closing. That is why
  // app.js no longer names the guard at all.
  assert.doesNotMatch(APP_SRC, /modalDismissGuarded\(/,
    'the per-dialog backdrop handlers moved into useDialog');
  assert.match(STATIC_MODAL_SRC, /export function isDismissGuarded\(/,
    'the guard is exported from the seam');
  assert.match(USE_DIALOG_SRC, /isDismissGuarded\(/,
    'and the shared backdropProps consults it');
  // #6475: a tap on the dialog, or within a finger's width of its edge, is
  // not an outside press either, and a press inside the card released on the
  // backdrop no longer closes the dialog.
  assert.match(USE_DIALOG_SRC, /nearRect\(/,
    'the shared backdropProps also applies the near-edge rule');
  assert.match(USE_DIALOG_SRC, /onPointerDown:/,
    'and records where the press that led to the click began');
  // Settings is NOT in this set: the settings-modal-to-screen conversion
  // turned it into the #settings screen, so it has no backdrop to guard.
  // tests/settings-screen.test.js pins that it stays that way.
  assert.doesNotMatch(SETTINGS_SRC, /modalDismissGuarded\(/,
    'settings is a screen now — no backdrop dismissal to guard');
});

test('every dialog reveals through the shared synchronous seam', () => {
  // One reveal for all nine dialogs, in useStaticModal's layout effect: stamp
  // openedAt, drop `hidden`, lift the card. It must NOT depend on
  // requestAnimationFrame — the WebView dropped that frame and left the panel
  // closed, which is the bug at the top of this file.
  //
  // The slice is the OPEN branch: the close branch below it now legitimately
  // waits (the phone sheet's slide-out, #4554) before it hides, and that wait
  // is not a reveal dependency.
  const effect = STATIC_MODAL_SRC.slice(
    STATIC_MODAL_SRC.indexOf('    if (open) {'),
    STATIC_MODAL_SRC.indexOf('    } else {', STATIC_MODAL_SRC.indexOf('    if (open) {')),
  );
  assert.ok(effect, 'found the reveal effect');
  assert.doesNotMatch(effect, /requestAnimationFrame|setTimeout/,
    'reveal is synchronous, no frame/timer dependency');
  assert.match(effect, /dataset\.openedAt = String\(Date\.now\(\)\)/, 'stamps the open time');
  assert.match(effect, /classList\.remove\('hidden'\)/, 'removes hidden synchronously');
  assert.match(STATIC_MODAL_SRC, /useIsomorphicLayoutEffect\(\(\) => \{/,
    'in a LAYOUT effect — a passive one paints the hidden state for a frame');
  assert.doesNotMatch(SETTINGS_SRC, /AppView\.revealModal\(/,
    'settings no longer reveals as a modal');

  // app-view.js keeps its own copy: the staging visual-compare overlay is not
  // one of the nine dialogs and still reveals through it. Same semantics.
  const revealBody = (VIEW_SRC.match(/revealModal\(modal\)\s*\{([\s\S]*?)\n  \},/) || [])[1] || '';
  assert.ok(revealBody, 'revealModal body found');
  assert.doesNotMatch(revealBody, /requestAnimationFrame|setTimeout/, 'reveal is synchronous, no frame/timer dependency');
  assert.match(revealBody, /classList\.remove\('hidden'\)/, 'reveal removes hidden synchronously');
  // The members dialog must not reveal then bail silently with no app.
  assert.doesNotMatch(
    MEMBERS_SRC,
    /_load\([^)]*\)\s*\{\s*const appData = AppView\.appData;\s*if \(!appData\) return;/,
    'the silent early-return guard is gone',
  );
});

// ── staging seed: invite-only demo app with collaborators ────────────────

test('staging seeds an invite-only demo app with members and a pending invite', () => {
  assert.match(MIGRATE_SRC, /seedStagingMembersPanel/, 'seed function defined + called');
  assert.match(MIGRATE_SRC, /staging-demo-private-app/, 'private demo app slug seeded');
  assert.match(MIGRATE_SRC, /collab_visibility, view_visibility[\s\S]*'private', 'private'/, 'app is invite-only');
  assert.match(MIGRATE_SRC, /900010, 900020, 'member'/, 'an accepted collaborator is seeded');
  assert.match(MIGRATE_SRC, /900010, 900021, 'invited'/, 'a pending invite is seeded');
  const fnBody = MIGRATE_SRC.slice(MIGRATE_SRC.indexOf('async function seedStagingMembersPanel'));
  assert.match(fnBody, /USERNODE_ENV !== 'staging'\) return;/, 'strict no-op outside staging');
  assert.match(fnBody, /ON CONFLICT/, 'idempotent inserts');
});
