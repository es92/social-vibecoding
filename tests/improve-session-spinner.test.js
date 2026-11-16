// #1597 — an in-progress change in Improve spins the platform's arc.
//
// The report was about consistency, and it was right: everywhere else on the
// platform that something is happening RIGHT NOW, the same 12px arc turns —
// a proposal running its checks, "Preview building…" on a board card, the
// merge-status badges, the app-launch cover. All of them are `.dc-status-spinner-arc` out
// of public/css/app.css. The Improve row was the one surface that said it a
// different way, by pulsing its tile badge, so a reader who had learned the
// arc everywhere else had to learn a second vocabulary for one list.
//
// What these tests pin is the part a screenshot cannot check:
//
//   1. The arc is the SHARED class, not a second spinner drawn locally. A
//      lookalike would drift the moment app.css retunes the real one.
//   2. It is gated on `busy`. A row that is Ready or Handed off must not
//      turn — a handed-off work order especially, whose agent runs where
//      this side cannot see whether a turn is in flight (#1417).
//   3. The pulse is GONE rather than joined. One fact wants one cue — and
//      #1946/#1947 finished that argument by retiring the tile badge
//      altogether, so the pill is the row's only activity cue now.
//   4. The arc is recoloured to the pill's own ink. The shared class borders
//      in `var(--accent)`, which is blue, and a blue arc in an amber pill is
//      off-palette in both themes.
//
// Source assertions, because the whole thing is a class string: the rendered
// evidence is dapp.json's declared check on the busy mock row, retargeted in
// the same commit.
//
// Run with: node --test tests/improve-session-spinner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ROW_TSX = read('frontend/src/features/improve/session-row.tsx');
const CONTROLLER = read('frontend/src/features/improve/improve-controller.js');
const APP_CSS = read('public/css/app.css');
const MANIFEST = JSON.parse(read('dapp.json'));
const checkCap = require('./lib/check-cap');

/** The `stateOf` table on its own — three branches, one per state. */
function stateOfBody() {
  const start = ROW_TSX.indexOf('function stateOf(');
  assert.ok(start > 0, 'stateOf is where the row decides all of this');
  // `\n}\n`, not `\n}` — the return-type annotation closes with `} {` on its
  // own line, so the looser needle cuts the table off before the first branch.
  const end = ROW_TSX.indexOf('\n}\n', start);
  assert.ok(end > start, 'the table closes at column 0');
  return ROW_TSX.slice(start, end);
}

// ── The arc is the platform's, not a local lookalike ───────────────────

test('the busy row draws the shared arc, by the shared class name', () => {
  assert.match(ROW_TSX, /className="dc-status-icon dc-status-spinner-arc"/,
    'both classes: dc-status-icon sizes the 14px box, the arc draws in it');
  // And it is a real class with real keyframes behind it, not a name that
  // resolves to nothing.
  assert.match(APP_CSS, /\.dc-status-spinner-arc\s*\{/);
  assert.match(APP_CSS, /@keyframes dc-spin/);
});

test('nothing here re-implements the spinner', () => {
  assert.doesNotMatch(ROW_TSX, /@keyframes|animate-spin|<svg/,
    'a second spinner drifts from app.css the first time the real one is tuned');
});

// ── It turns only while a turn is in flight ────────────────────────────

test('the spinner is gated on the busy state alone', () => {
  const body = stateOfBody();
  assert.equal((body.match(/spinner: true/g) || []).length, 1,
    'exactly one branch spins');
  // #6042 grew the table from three states to the change's whole lifecycle
  // (Waiting for approval, Going live, Live, the two failing shapes, Testing
  // and Ready), and every non-busy branch says `spinner: false` explicitly —
  // on this row the arc means an AI turn, and no lifecycle state may borrow
  // it.
  assert.equal((body.match(/spinner: false/g) || []).length, 9,
    'and every other branch says so explicitly rather than leaving it undefined');

  // The `spinner: true` must be the branch guarded by session.busy — the
  // first one — not whichever branch happens to be listed first.
  const busyBranch = body.slice(body.indexOf('if (session.busy)'),
    body.indexOf("if (session.kind === 'task')"));
  assert.match(busyBranch, /label: t\('agent:menu\.row\.state\.working'\)/);
  assert.equal(message('agent:menu.row.state.working'), 'Working');
  assert.match(busyBranch, /spinner: true/);

  const taskBranch = body.slice(body.indexOf("if (session.kind === 'task')"));
  assert.equal(message('agent:menu.row.state.handedOff'), 'Handed off');
  assert.match(taskBranch, /label: t\('agent:menu\.row\.state\.handedOff'\)[\s\S]{0,200}?spinner: false/,
    'a work order runs on the user own machine; an arc turning here would '
    + 'claim a liveness this side has no way to observe (#1417)');
});

test('the row renders the arc behind that flag, not unconditionally', () => {
  assert.match(ROW_TSX,
    /\{state\.spinner \? \([\s\S]{0,240}?dc-status-spinner-arc[\s\S]{0,120}?\) : null\}/,
    'a Ready row must show no spinner at all');
});

test('what counts as busy is untouched', () => {
  // The change is presentational. If the states that mean "in flight" moved
  // with it, the check on the mock busy row would still pass while every
  // real row said something different.
  assert.match(CONTROLLER, /BUSY_STATES = new Set\(\['running', 'starting', 'queued'\]\)/);
  assert.match(CONTROLLER, /busy: false/,
    'and a work order is still never busy (#1417)');
});

// ── One fact, one cue ──────────────────────────────────────────────────

test('the tile badge gave up its pulse, and then the badge itself (#1946)', () => {
  const body = stateOfBody();
  assert.doesNotMatch(ROW_TSX, /animate-pulse/,
    'the motion is the pill spinner now; two cues for one fact is the thing '
    + '#1610 already removed from the button that opens this panel');
  // #1597 kept the badge's amber "because it is what makes a column of tiles
  // scannable". App feedback triage 2026-09-10 read the same dot the other
  // way round (rows 39a/39b): the emerald half never meant work at all, and
  // the amber half repeated the pill beside it without a word. The state
  // table has no badge left to colour; what the row renders in its place is
  // tests/improve-session-activity.test.js.
  assert.doesNotMatch(body, /badge:/,
    'the state is the pill\'s alone (#1946, #1947)');
});

// ── The arc takes the pill's ink ───────────────────────────────────────

test('the spinner is recoloured to the pill rather than left accent-blue', () => {
  assert.match(ROW_TSX, /\[&>\.dc-status-spinner-arc\]:border-current/,
    'one literal covers every state and both themes');
  assert.match(ROW_TSX, /\[&>\.dc-status-spinner-arc\]:border-e-transparent/,
    'border-current would otherwise close the ring and stop it reading as an arc');
  // The base class really is accent-coloured, which is why the override has
  // to exist at all.
  const rule = APP_CSS.slice(APP_CSS.indexOf('.dc-status-spinner-arc {'));
  assert.match(rule.slice(0, 300), /border:\s*2px solid var\(--accent\)/);
});

test('the pill lays its two children out like the platform\'s other one', () => {
  const pill = ROW_TSX.slice(ROW_TSX.indexOf('const PILL_BASE'));
  assert.match(pill.slice(0, 400), /inline-flex items-center gap-1/,
    'gap-1 is the 4px .gc-checks-running-badge puts between the same arc and '
    + 'the same 11px semibold label');
  assert.match(APP_CSS, /\.gc-checks-running-badge[\s\S]{0,200}?gap:\s*4px/);
});

// ── The declared check follows the markup ──────────────────────────────

test('the busy-row check left with Messages\' Agents list, and the manifest keeps its floor', () => {
  // The SURFACE moved and the check moved with it (#2718 review): these rows
  // were the Improve panel's, and with the panel retired they were the
  // notifications sheet's Agents tab; #2815 folded that tab into the bell's
  // Messages filter, and #5289 took that filter out, so the busy row was
  // checked on the Messages screen's Agents list. That list left Messages
  // (16 Nov 2026) and no shell screen draws the row now, so its check went
  // with it: the arc is pinned by the renders above.
  const busy = MANIFEST.tests.filter((t) =>
    /\[data-inbox-session="s990102"\]/.test(t.expectSelector || ''));
  assert.equal(busy.length, 0, 'no check selects the retired Messages slot');
  assert.ok(!MANIFEST.tests.some((t) => /\.animate-pulse/.test(t.expectSelector || '') && /data-improve-row/.test(t.expectSelector || '')),
    'and none came back on the pulse the arc replaced');

  // This used to be `MANIFEST.tests.length <= 459` — the manifest's size on
  // the day #1597 was written, standing in for "near the ceiling, so add
  // nothing". An absolute count cannot say "THIS change adds none": every
  // later proposal that declares a check breaks it, whoever wrote it, and
  // the manifest passed 459 almost immediately. It has been red on main —
  // and therefore on every proposal opened since — rather than catching
  // anything.
  //
  // The ceiling concern is real and belongs here, so it is stated as the
  // arithmetic the MAX_DECLARED_TESTS note in services/app-manifest.js
  // actually documents: the manifest keeps 20 slots clear of the cap, and
  // crossing that floor is what makes the reader drop checks silently. That
  // is stable against other people's work, and tests/checks-budget.test.js
  // asserts the consequence (ceilingDropped === 0) from the other side.
  //
  // What to do at the floor is stated once, for this guard and the other two
  // (tests/lib/check-cap.js): fold first, then raise the cap in the same
  // proposal. This one used to call the raise a coupled change while its
  // twin said to make it, and the exact pin said nothing.
  checkCap.assertFloor(MANIFEST.tests.length);
});
