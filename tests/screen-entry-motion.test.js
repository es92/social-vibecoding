// The screen-entry motion gate — `App._entryTransition`.
//
// It was drawer-nav-motion.test.js, and the gate had a second job: a
// navigation started from the hamburger drawer got `type: 'none'`, because a
// screen animating in behind a drawer springing out was two motions competing
// (#977). The hamburger is retired and the drawer went with it, so what is
// left is the part that outlived it — every screen entry takes its type from
// ONE place and stamps `data-entered` on the screen it reveals, which is the
// only way a mid-animation state is testable at all.
//
// Run with: node --test tests/screen-entry-motion.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const appJs = read('public/js/app.js');
// #1079 chunk B moved both modules into the React bundle; same files.
const nodePillJs = read('frontend/src/features/header/node-pill.js');
const walletSheetJs = read('frontend/src/features/header/wallet-sheet.js');
const dapp = JSON.parse(read('dapp.json'));

// The App._entryTransition body.
function entryTransition() {
  const at = appJs.indexOf('  _entryTransition(preferred, screenEl, viaTab) {');
  assert.ok(at !== -1, 'App._entryTransition went missing');
  return appJs.slice(at, appJs.indexOf('\n  },', at));
}

// ── The transition gate ────────────────────────────────────────────────



test('the resolved type is stamped on the screen element', () => {
  const fn = entryTransition();
  assert.match(fn, /setAttribute\('data-entered', preferred\)/,
    'the dapp checks assert data-entered — mid-animation state is otherwise untestable');
  assert.match(fn, /screenEl && screenEl\.setAttribute/,
    'a missing/odd screen element must not throw mid-navigation');
});

// ── Every screen entry routes through it ───────────────────────────────

test('all eleven screen transitions go through App._entryTransition', () => {
  // It was nine, then eight, nine again, Global Chat made ten, and an agent
  // session's own screen (#2779, #agent/<id> on a phone) makes eleven. Notifications and Messages
  // gave one back each when they stopped being screens — a sheet presents over
  // whatever is there, so there is no screen swap to animate and nothing for
  // the gate to type — and the Workshop screen (#workshop) takes one, because
  // it is a root that replaces the screen you were on. "Your proposals"
  // (#5310, #profile/proposals) made twelve, and Global Chat's removal gave
  // its one back: eleven.
  const calls = appJs.match(/PlatformUI\.transition\(/g) || [];
  assert.equal(calls.length, 11,
    `expected 11 PlatformUI.transition call sites in app.js, found ${calls.length} — `
    + 'a new one must route its type through App._entryTransition too');
  const routed = appJs.match(/type: App\._entryTransition\(/g) || [];
  assert.equal(routed.length, 11,
    'every call site must take its type from the gate, or that screen keeps '
    + 'animating over the closing drawer');
});

test('no screen entry still hard-codes its transition type', () => {
  assert.ok(!/type: fromIframe \? 'none' : 'push'/.test(appJs),
    "a bare `type: fromIframe ? 'none' : 'push'` bypasses the gate — that IS the bug");
  assert.ok(!/type: 'zoom-in'/.test(appJs),
    'navigateToApp is reachable from the drawer (the footer fork link), so its '
    + 'zoom must go through the gate as well');
  assert.ok(!/type: 'zoom-out'/.test(appJs),
    'navigateHome routes through the gate too, for one rule everywhere');
});

test('each named screen entry passes its own screen element to the gate', () => {
  // Messages and Notifications are off this list: they are sheets, and a
  // sheet has no screen element for the gate to stamp `data-entered` on.
  for (const nav of ['navigateToLeaderboard', 'navigateToProfile',
    'navigateToBrowse', 'navigateToAdminConsole', 'navigateToSettings',
    'navigateToAgentSession']) {
    const at = appJs.indexOf(`  ${nav}(`);
    assert.ok(at !== -1, `${nav} went missing`);
    const body = appJs.slice(at, appJs.indexOf("getElementById('back-btn')", at));
    assert.match(body, /App\._entryTransition\(fromIframe \? 'none' : 'push', screen\)/,
      `${nav} must hand the gate the screen it is revealing, so data-entered lands on it`);
  }
});

test('the zoom sites keep their split mutation intact under the gate', () => {
  // type:'none' still runs fn() and then opts.after() as one mutation
  // (kit contract), so `after` must remain — dropping it would leave the
  // outgoing screen painted behind the new one. #979 widened the conceal
  // from "just `departing`" to "every screen root" (App._showOnlyScreen),
  // since the _exitX helpers no longer hide their own screens.
  const nav = appJs.slice(appJs.indexOf('async navigateToApp('));
  const zoom = nav.slice(0, nav.indexOf('await AppView.open(slug)'));
  // `viaTab` (#2880, #2881): a Workshop-tab press resolves as a tab switch.
  assert.match(zoom, /App\._entryTransition\('zoom-in', appViewEl, viaTab\)/);
  assert.match(zoom, /after: \(\) => \{ App\._showOnlyScreen\('app-view'\); \}/,
    'the conceal half of the mutation must survive');
  const home = appJs.slice(appJs.indexOf('navigateHome(opts) {'));
  assert.match(home.slice(0, home.indexOf('App.updateHash()')),
    /App\._entryTransition\('zoom-out', av, viaTab\)/);
});

// ── The two native sheets ──────────────────────────────────────────────

// Both rows sat in the hamburger drawer, so each awaited that drawer's exit
// before presenting: a kit sheet cannot open over a kit panel still sliding
// out. The rows are on the Profile SCREEN now — a screen does not need
// dismissing — so the await is gone and the sheet presents directly. What
// must not come back is the await, since there is nothing left to await ON.
test('the Node and Wallet sheets present directly, with nothing to await', () => {
  for (const [name, src, sheet] of [
    ['node-pill.js', nodePillJs, 'NodePill._openSheet()'],
    ['wallet-sheet.js', walletSheetJs, 'WalletSheet._openSheet()'],
  ]) {
    assert.ok(src.includes(sheet), `${name} must present its own sheet`);
    assert.ok(!/HeaderMenu/.test(src),
      `${name} must not reach for a drawer that no longer exists`);
    assert.ok(!/Promise\.resolve\(closed\)/.test(src),
      `${name} must not chain behind a close that never happens`);
  }
});

// "Share app" was a drawer row, then an IMPROVE PANEL row, and is the app
// menu's About pane's now — each move for the same reason, that every line in
// that block is a fact about ONE app and it belongs on the surface scoped to
// one. The rule travelled with it every time: a dialog of its own must not
// fade in across its host surface's exit.
test('the Share dialog opens after its host surface is gone', () => {
  const improve = read('frontend/src/features/improve/improve-controller.js');
  const at = improve.search(/^ {2}share\(\) \{/m);
  assert.ok(at !== -1, 'the Improve controller owns the share action');
  // `?.()` as well as `()`: it reaches AppView off the window, which a
  // vm-sandboxed test may not have published.
  assert.match(improve.slice(at, at + 500),
    /Promise\.resolve\(Improve\.close\(\)\)\.then\(\(\) => \{[\s\S]{0,200}?openShareModal\??\.?\(\)/,
    'the share modal must not fade in across the surface\'s exit');
  // …and close() has to actually REPORT when the surface is gone, or
  // chaining on it resolves a frame after the request rather than after the
  // exit. The Improve panel retired (#2718 review) and this controller
  // presents nothing itself now, so close() is a FORWARD — and the promise
  // is the thing that has to survive the forward, which is what this reads:
  // the owner's own completion promise, or a resolved one when there is no
  // owner, never a bare undefined that `.then` would throw on.
  assert.match(improve, /^ {2}close\(\) \{\n\s+return Improve\._surface\(\)\?\.close\(\) \?\? Promise\.resolve\(\);/m,
    'close() returns the surface owner\'s completion promise');
  const controller = read('frontend/src/lib/sheet-controller.js');
  assert.match(controller, /^ {4}close\(\) \{[\s\S]*?return done;/m,
    'and that owner\'s close resolves after the exit, not a frame after the '
    + 'request');
});

// ── The screenshot-state deep link + its checks ────────────────────────


