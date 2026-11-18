// The sheets' web overlay stays DOWN while the kit presents the surface.
//
// The app-context sheet and the Notifications sheet each pair a full-screen
// dimming overlay with their CSS slide-over: `data-open`
// raises it and `transition: opacity` fades it with the slide. On touch the
// same element is adopted into a kit sheet instead — and the kit brings its
// own backdrop, which fades 1:1 with the drag and the exit spring.
//
// Raising the web overlay there too was the reported "the background snaps"
// bug: the kit's backdrop faded out under a second overlay pinned at full
// opacity, so the scene stayed dimmed through the whole slide-out and only
// un-dimmed after the deferred teardown — a late 200ms fade that reads as a
// snap. (While open, the two 40% backdrops also stacked into an over-dim.)
// The hamburger drawer has always handled this by never raising its overlay
// on the kit path; these tests pin the same rule for the sheets.
//
// The contract: the controllers publish `adopted` beside `open`, and the
// overlay's `data-open` derives from `open && !adopted`. `adopted` is
// published AFTER the present (the store flush is synchronous, so it never
// reaches a paint) because `open` itself must be published BEFORE the present
// — the kit measures the content's height at present time.
//
// Run with: node --test tests/sheet-overlay-kit-adoption.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { runModules, makeStoreStub } = require('./helpers/bundle-module');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SHEET_CONTROLLER = read('frontend/src/lib/sheet-controller.js');

function makeSandbox(panelIds) {
  const panels = Object.fromEntries(panelIds.map((id) => [
    id,
    { id, contains: (el) => !!el && el.__inPanel === id },
  ]));
  const sandbox = {
    console,
    Promise,
    setTimeout,
    clearTimeout,
    location: { search: '' },
    URLSearchParams,
    document: {
      activeElement: null,
      getElementById: (id) => panels[id] || null,
      addEventListener: () => {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

// A kit-surface stub for the TOUCH branch: the present succeeds, and
// `dismiss()` runs the caller's onDismiss synchronously — the exit spring's
// terminal state, which is all the controllers observe. `atPresent` snapshots
// the store the moment the kit takes the element, so the tests can assert the
// publish-before-present ordering AND that `adopted` is not yet up then.
function touchKitSurface(store, log) {
  return {
    adoptKitSurface: (opts) => {
      log.push(['present', opts.kind, { ...store.state }]);
      return {
        kind: opts.kind,
        contentEl: opts.contentEl,
        restore: () => {},
        dismiss: () => {
          log.push(['kit-dismiss']);
          opts.onDismiss();
        },
      };
    },
  };
}

const DESKTOP = { adoptKitSurface: () => null };

// ── the shared chassis (app-context, notifications, messages) ────────────

function loadSheetController(kitSurface) {
  const store = makeStoreStub({ open: false, adopted: false });
  const log = [];
  const sandbox = makeSandbox(['test-sheet']);
  // lib/back-stack.ts, as a recorder: each claim, and how it was handed back.
  const back = { claims: [], releases: [] };
  runModules(sandbox, [['sheet-controller.js', SHEET_CONTROLLER]], {
    imports: {
      './kit-surface': typeof kitSurface === 'function'
        ? kitSurface(store, log)
        : kitSurface,
      './back-stack': {
        pushDismissible: (close) => {
          back.claims.push(close);
          return (options) => back.releases.push(options || {});
        },
      },
    },
    tail: 'window.__make = createSheetController;',
  });
  const controller = sandbox.__make({ elementId: 'test-sheet', store });
  return { controller, store, log, back, sandbox };
}

test('touch: adopted is published with open, and the present sees open first', () => {
  const { controller, store, log } = loadSheetController(touchKitSurface);
  controller.open();
  const present = log.find((c) => c[0] === 'present');
  assert.ok(present, 'the kit surface presented');
  assert.equal(present[2].open, true, 'open is published BEFORE the present');
  assert.equal(present[2].adopted, false, 'adopted is not up yet at present time');
  assert.deepEqual(
    { open: store.state.open, adopted: store.state.adopted },
    { open: true, adopted: true },
    'after open() the store says adopted, so the web overlay stays down',
  );
});

test('touch: the kit teardown clears open AND adopted together', () => {
  const { controller, store } = loadSheetController(touchKitSurface);
  controller.open();
  controller.close();
  assert.deepEqual(
    { open: store.state.open, adopted: store.state.adopted },
    { open: false, adopted: false },
  );
});

test('desktop: adopted never rises, so the overlay fades with the CSS slide', () => {
  const { controller, store } = loadSheetController(DESKTOP);
  controller.open();
  assert.equal(store.state.open, true);
  assert.equal(store.state.adopted, false,
    'the CSS slide-over is the presentation, and the overlay is its dim');
  controller.close();
  assert.equal(store.state.open, false);
  assert.equal(store.state.adopted, false);
});

// ── the back button closes a sheet (QA 2026-09-24 Q16) ──────────────────
//
// Back walked the history UNDER an open sheet: the bell's sheet stayed up
// while Discover turned into Home behind it, and the Homeroom menu closed and
// took the page with it. A sheet claims the next press through the same
// lib/back-stack.ts the dialogs use, for as long as it is open.

for (const [label, kit] of [['touch', touchKitSurface], ['desktop', DESKTOP]]) {
  test(`${label}: an open sheet claims Back, and Back closes it`, () => {
    const { controller, store, back } = loadSheetController(kit);
    controller.open();
    assert.equal(back.claims.length, 1, 'one claim per presentation');
    controller.open();
    assert.equal(back.claims.length, 1, 'not a second one for the sheet already up');

    // The press itself: back-stack pops the claim and runs it.
    assert.equal(back.claims[0](), true, 'the press is consumed');
    assert.equal(store.state.open, false, 'and the sheet is closed by it');
    assert.equal(back.releases.length, 0,
      'a press already spent the record, so nothing is handed back');
  });

  test(`${label}: closing another way hands the claim back as a navigating release`, () => {
    // Most closes here are the first half of a navigation written in the same
    // task (a row, a link), so the record must not be spent under it.
    const { controller, back } = loadSheetController(kit);
    controller.open();
    controller.close();
    assert.deepEqual(back.releases.map((o) => o.navigating), [true]);
    controller.open();
    controller.dismissForNav();
    assert.deepEqual(back.releases.map((o) => o.navigating), [true, true]);
    assert.equal(back.claims.length, 2, 'and the next open claims again');
  });
}

test('touch: a swipe the kit reports hands the claim back too', () => {
  const log = [];
  let onDismiss = null;
  const kit = () => ({
    adoptKitSurface: (opts) => {
      onDismiss = opts.onDismiss;
      log.push('present');
      return { kind: opts.kind, contentEl: opts.contentEl, restore() {}, dismiss() { opts.onDismiss(); } };
    },
  });
  const { controller, store, back } = loadSheetController(kit);
  controller.open();
  onDismiss();
  assert.equal(store.state.open, false);
  assert.equal(back.releases.length, 1, 'the swipe did not leave a claim behind');
});

// ── the Improve panel had its own copy of the chassis, and retired ──────
//
// Two tests stood here, driving `Improve.open()` / `Improve.close()` through
// a stubbed kit-surface to pin that `platform-sheet-adopted` rose with the
// present and fell with the teardown. The panel predated
// lib/sheet-controller.js and adopted its root directly, which is why it
// needed its own pair.
//
// It retired (#2718 review) — its two actions, its build notice and its view
// strip are rows of the app-context sheet now — and with it went the
// `adoptKitSurface` call, the sandbox that loaded the controller, and the
// `open`/`adopted` flags it published. What those tests asserted is asserted
// of the app-context sheet above, through the shared chassis both surfaces
// now use, so nothing lost coverage: the rule moved to the one place that
// implements it.

// ── the overlays actually read the flag ──────────────────────────────────

test('every sheet overlay derives data-open from open && !adopted', () => {
  const overlays = [
    // #improve-overlay was the third; it retired with its panel (see above).
    ['frontend/src/features/app-context/app-context-sheet.tsx', 'apps-switcher-overlay'],
    ['frontend/src/features/notifications/notifications-sheet.tsx', 'notifications-sheet-overlay'],
  ];
  for (const [file, id] of overlays) {
    const src = read(file);
    assert.ok(src.includes(`id="${id}"`), `${file} renders #${id}`);
    // The overlay's raise condition, exactly: an overlay gated on `open`
    // alone would pin the dim at full opacity through the kit's exit spring.
    assert.match(
      src,
      /\{\.\.\.\(open && !adopted \? \{ 'data-open': '' \} : \{\}\)\}/,
      `${file}'s overlay stays down while the kit presents the surface`,
    );
  }
});

// ── #6813: opening a sheet puts away the keyboard of a field behind it ──
//
// iOS keeps focus on a text field when a button is tapped, so opening the
// bell while typing left the keyboard up; the kit rides every sheet on the
// keyboard, so the sheet came up with its title, tabs, search and close above
// the top of the screen. `open()` now blurs a focused TEXT field outside the
// sheet — never one inside it (the sheet's own search) and never a button,
// menu or checkbox, so a sheet opened from another keeps that control.

/** A focusable stand-in for a DOM element, recording its blurs. */
function element(over = {}) {
  return {
    tagName: 'DIV',
    blurred: 0,
    blur() { this.blurred += 1; },
    getAttribute: () => null,
    ...over,
  };
}

test('#6813: a focused text field outside the sheet loses focus when it opens', () => {
  const { controller, sandbox } = loadSheetController(DESKTOP);
  const textarea = element({ tagName: 'TEXTAREA' });
  sandbox.document.activeElement = textarea;
  controller.open();
  assert.equal(textarea.blurred, 1, 'the keyboard goes away with the focus');
});

test('#6813: a text input and editable text behind the sheet are blurred too', () => {
  const input = element({ tagName: 'INPUT', getAttribute: (n) => (n === 'type' ? 'search' : null) });
  const { controller, sandbox } = loadSheetController(DESKTOP);
  sandbox.document.activeElement = input;
  controller.open();
  assert.equal(input.blurred, 1);

  const editable = element({ isContentEditable: true });
  const second = loadSheetController(DESKTOP);
  second.sandbox.document.activeElement = editable;
  second.controller.open();
  assert.equal(editable.blurred, 1, 'a contenteditable holds a keyboard up too');
});

test('#6813: a field inside the sheet keeps its focus', () => {
  const { controller, sandbox } = loadSheetController(DESKTOP);
  const search = element({ tagName: 'INPUT', __inPanel: 'test-sheet' });
  sandbox.document.activeElement = search;
  controller.open();
  assert.equal(search.blurred, 0,
    'the sheet\'s own search box is the one field it must not take focus from');
});

test('#6813: a button, menu or checkbox behind the sheet is left alone', () => {
  for (const [tagName, type] of [
    ['BUTTON', null],
    ['INPUT', 'checkbox'],
    ['INPUT', 'radio'],
    ['INPUT', 'range'],
    ['SELECT', null],
  ]) {
    const { controller, sandbox } = loadSheetController(DESKTOP);
    const el = element({
      tagName,
      getAttribute: (n) => (n === 'type' ? type : null),
    });
    sandbox.document.activeElement = el;
    controller.open();
    assert.equal(el.blurred, 0, `${tagName}[${type || ''}] is not holding a keyboard up`);
  }
});

// ── handed back, out of sight (onboarding run three, 12 Oct 2026) ───────
//
// The Homeroom menu's bottom sheet stood again at its open place for 190ms
// after the kit's exit had taken it away (the recording's frames show the
// web sheet, no grabber). A node homed on <body> goes back there with
// REHOMED_CLASS, which app.css keeps out of sight, until its next adoption
// starts, so a refused one still shows the web presentation.
test('kit-surface: a node the kit hands back to <body> stays out of sight until it is presented again', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/lib/kit-surface.ts'), 'utf8');
  assert.match(src, /export const REHOMED_CLASS = 'platform-surface-rehomed';/);
  assert.match(src, /\} else if \(presented\) \{\s+contentEl\.classList\.add\(REHOMED_CLASS\);\s+document\.body\.appendChild\(contentEl\);/);
  // Let go first thing, before any gate can refuse the adoption.
  const fn = src.slice(src.indexOf('export function adoptKitSurface('));
  assert.ok(fn.indexOf('options.contentEl.classList.remove(REHOMED_CLASS);') < fn.indexOf('const ui = kit();'));
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');
  assert.match(css, /\.platform-surface-rehomed \{\s+visibility: hidden !important;\s+transition: none !important;\s+\}/);
});
