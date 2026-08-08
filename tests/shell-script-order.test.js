// Script and stylesheet ordering in the generated shell document.
//
// Two orderings in public/index.html are load-bearing, and neither is visible
// from any single source file now that the document is assembled by
// frontend/scripts/build-shell.mjs out of src/head.html plus a prerendered
// Shell.tsx. So they are pinned here.
//
// ── 1. The 50 legacy classic scripts ───────────────────────────────────
//
// public/js/** is 53 files of global-scope script with no module system:
// each defines a global (App, Home, AppView, DevChat, AuthScreens, …) and
// several depend on an earlier one already existing. app.js is LAST on
// purpose — it registers its DOMContentLoaded handler after every other
// module's, so App.init() runs after all of them. Reordering the tags
// reorders init, which breaks things that look nothing like a script-order
// bug when they fail.
//
// ── 2. The React entry's position ──────────────────────────────────────
//
// The entry must be a `type="module"` script (therefore deferred) so it
// executes AFTER all 50 classic scripts have defined their globals and
// BEFORE DOMContentLoaded runs their init()s. See frontend/src/main.tsx.
//
// ── 3. The stylesheet cascade ──────────────────────────────────────────
//
// native.css → app.css → tailwind.css, with the compiled utilities LAST.
// tests/tailwind-build.test.js asserts this too and index.html carries a
// runtime probe for it; the note in the head explains what broke (#938) when
// it was last inverted. Asserted again here because this file is now
// generated, and the failure it guards is silent and whole-screen.
//
// Run with: node --test tests/shell-script-order.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { scriptsOf, stylesheetsOf } = require('./helpers/html-tokens');

const ROOT = path.join(__dirname, '..');

const before = fs.readFileSync(path.join(__dirname, 'fixtures', 'pre-migration-index.html'), 'utf8');
const after = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const ENTRY_SRC = '/shell/assets/shell.js';

// Modules added AFTER the chassis swap, which the frozen pre-migration
// fixture cannot know about. They are removed from the comparison below —
// exactly as the React entry is — so this test keeps meaning what it says:
// the 50 pre-migration scripts still load in their original relative order.
// A new module's own position is pinned by its own assertion instead (see
// the nav-link.js check below); do not add one here without doing the same.
const POST_MIGRATION_SRCS = [
  '/js/nav-link.js', // #1036 — the real-anchor / new-tab seam
  '/js/dev-flow-select.js', // #1049 — the dev-flow picker + walkthrough
];

test('every legacy script is loaded, in exactly the pre-migration order', () => {
  const expected = scriptsOf(before).filter((s) => s.src).map((s) => s.src);
  const actual = scriptsOf(after)
    .filter((s) => s.src && s.src !== ENTRY_SRC && !POST_MIGRATION_SRCS.includes(s.src))
    .map((s) => s.src);

  assert.deepEqual(
    actual, expected,
    'the <script src> sequence in public/index.html no longer matches the pre-migration document.\n'
    + 'These are global-scope classic scripts with load-order dependencies (app.js must stay last, '
    + 'so App.init() runs after every other module registers). Fix the order in '
    + 'frontend/src/Shell.tsx / frontend/src/head.html and rebuild.',
  );
});

test('the shell still loads the expected number of legacy scripts', () => {
  // 53 /js/** tags in total: theme.js in the head (it applies the stored
  // theme before first paint) plus 52 at the end of <body>. The count moves
  // whenever main adds a module — it was 48 at the chassis swap, main's
  // mail console and credit-options screens brought it to 50, #1036's
  // nav-link.js made 51, and #1049's dev-flow-select.js makes 52.
  const bodyScripts = scriptsOf(after.slice(after.indexOf('</head>')))
    .filter((s) => s.src && s.src.startsWith('/js/'));
  assert.equal(
    bodyScripts.length, 52,
    `expected the 52 legacy /js/** scripts at the end of <body>, found ${bodyScripts.length}. `
    + 'Adding or removing one is fine, but it also needs a matching SHELL_ASSETS entry in '
    + 'public/sw.js (tests/pwa-shell-wiring.test.js enforces that) — so update this count '
    + 'deliberately rather than loosening the check.',
  );

  const headScripts = scriptsOf(after.slice(0, after.indexOf('</head>')))
    .filter((s) => s.src && s.src.startsWith('/js/'))
    .map((s) => s.src);
  assert.deepEqual(
    headScripts, ['/js/theme.js'],
    'theme.js is the only /js/** script that belongs in the head — it applies the stored theme '
    + 'before first paint, which is what stops a light-mode flash on a dark-mode load.',
  );
});

test('nav-link.js loads ahead of every module that consumes it', () => {
  // Excluded from the fixture comparison above (the frozen pre-migration
  // document predates it), so its position is pinned here instead. #1036:
  // app.js, app-view.js, browse.js, dev-chat.js, home.js and leaderboard.js
  // all reference window.NavLink, and it has no dependencies of its own.
  const srcs = scriptsOf(after).filter((s) => s.src && s.src.startsWith('/js/')).map((s) => s.src);
  const at = srcs.indexOf('/js/nav-link.js');
  assert.notEqual(at, -1, 'the shell must load /js/nav-link.js');
  for (const consumer of ['/js/platform-ui.js', '/js/app.js', '/js/app-view.js',
    '/js/browse.js', '/js/dev-chat.js', '/js/home.js', '/js/leaderboard.js']) {
    const idx = srcs.indexOf(consumer);
    assert.ok(idx === -1 || at < idx,
      `nav-link.js must load before ${consumer}, which reads window.NavLink`);
  }
});

test('dev-flow-select.js loads ahead of the modules that consume it', () => {
  // Excluded from the fixture comparison above for the same reason as
  // nav-link.js, so its position is pinned here. #1049: dev-chat.js owns the
  // state and calls DevFlowSelect.pickerHtml / wizardHtml / wire, and
  // app-view.js pokes DevChat._devFlow from the "+" menu — the module itself
  // has no dependencies at all.
  const srcs = scriptsOf(after).filter((s) => s.src && s.src.startsWith('/js/')).map((s) => s.src);
  const at = srcs.indexOf('/js/dev-flow-select.js');
  assert.notEqual(at, -1, 'the shell must load /js/dev-flow-select.js');
  for (const consumer of ['/js/dev-chat.js', '/js/app-view.js', '/js/app.js']) {
    const idx = srcs.indexOf(consumer);
    assert.ok(idx === -1 || at < idx,
      `dev-flow-select.js must load before ${consumer}, which reads window.DevFlowSelect`);
  }
});

test('app.js is the last legacy script', () => {
  const legacy = scriptsOf(after).filter((s) => s.src && s.src.startsWith('/js/'));
  assert.equal(
    legacy[legacy.length - 1].src, '/js/app.js',
    'app.js must remain the LAST /js/** script: it registers its DOMContentLoaded handler last, '
    + 'which is what makes App.init() run after every other module has initialised.',
  );
});

test('the React entry is a deferred module, and the only one', () => {
  const scripts = scriptsOf(after);
  const modules = scripts.filter((s) => s.type === 'module');

  assert.equal(modules.length, 1, 'there should be exactly one type="module" script — the React entry');
  assert.equal(modules[0].src, ENTRY_SRC, `the module entry should be ${ENTRY_SRC}`);

  for (const s of scripts) {
    if (s.src === ENTRY_SRC) continue;
    assert.notEqual(
      s.type, 'module',
      `${s.src || '<inline>'} must stay a CLASSIC script. Converting a legacy /js/** file to a `
      + 'module would defer it and silently change init order.',
    );
  }
});

test('the React entry loads after every legacy script in document order', () => {
  // Module scripts are deferred, so a module in <head> still executes after
  // in-body classic scripts. Position alone is not the guarantee — being a
  // module is (asserted above) — but the entry must not be somewhere that
  // makes the intent unreadable, e.g. interleaved among the /js/** tags.
  const entryAt = after.indexOf(`src="${ENTRY_SRC}"`);
  const headEnd = after.indexOf('</head>');
  assert.ok(entryAt > -1, 'the React entry is not referenced at all');
  assert.ok(
    entryAt < headEnd,
    'the React entry belongs at the END of <head>: it is deferred, so it runs after the body\'s '
    + 'classic scripts and before DOMContentLoaded, which is the window frontend/src/main.tsx '
    + 'documents. Placing it among the /js/** tags in <body> would obscure that.',
  );
  const lastHeadScript = after.lastIndexOf('<script', headEnd);
  assert.ok(
    after.slice(lastHeadScript, headEnd).includes(ENTRY_SRC),
    'the React entry should be the LAST script in <head>, after the bridge and the vendored libs',
  );
});

test('the stylesheet cascade is native.css → app.css → tailwind.css', () => {
  assert.deepEqual(
    stylesheetsOf(after),
    ['/usernode-native/v1/native.css', '/css/app.css', '/css/tailwind.css'],
    'the compiled utilities must be linked LAST. app.css was written against a cascade where '
    + 'Tailwind wins equal-specificity conflicts; inverting it silently restyles the shell (#938). '
    + 'The head also probes this at runtime and console.errors when it breaks, which fails checks.',
  );
});

test('the head still loads the bridge before anything can use it', () => {
  const head = after.slice(0, after.indexOf('</head>'));
  const bridgeAt = head.indexOf('/usernode-bridge.js');
  const nativeClassAt = head.indexOf('in-native-webview');
  assert.ok(bridgeAt > -1, 'the head must load /usernode-bridge.js');
  assert.ok(
    nativeClassAt > bridgeAt,
    'the inline script that adds .in-native-webview reads window.usernode.isNative, which '
    + '/usernode-bridge.js sets synchronously — it must run after the bridge. Reversing them '
    + 'reintroduces the flash of a duplicated header title inside the Usernode app WebView.',
  );
  assert.ok(
    head.indexOf('/js/theme.js') < bridgeAt,
    'theme.js should keep running first so the stored theme is applied before first paint',
  );
});

test('the document loads nothing cross-origin', () => {
  // tests/tailwind-build.test.js and tests/pwa-shell-wiring.test.js already
  // assert this; repeated here because the document is generated now and a
  // build-time template edit is a new way to break it.
  for (const m of after.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
    assert.ok(
      !/^https?:\/\//.test(m[1]),
      `public/index.html loads an off-origin asset: ${m[1]}. Vendor it under public/vendor/ `
      + '(npm run vendor:assets) or compile it in instead.',
    );
  }
});
