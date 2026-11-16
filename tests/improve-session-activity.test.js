// #1946 + #1947 — a change row says WORK, not lifecycle, and says it once.
//
// App feedback triage 2026-09-10 filed the Improve panel's corner badge twice,
// once per colour, because it was one indicator with two readings:
//
//   row 39a  "Replace static green dot with active work indicator."
//   row 39b  "Clarify misleading yellow dot status." — remove the yellow
//            session dot, show "sessions actively thinking" some other way,
//            "pairs with triage row 39a's activity indicator".
//
// The dot was the 12px badge on each row's 32px app tile: emerald on every
// idle row (a success colour for NOT working, which never moved and never
// meant activity), amber on a running one — 8px from a pill that was already
// saying `Working` in a word, in the same amber, with the platform's arc
// turning in it.
//
// So the badge is retired and the pill is the row's one activity indicator.
// It is the indicator 39a asked for: #1958 wired it to the live session store
// (`SessionState.isBusy`), so it follows the turn boundary's push rather than
// whatever the last /api/me/active-sessions answer happened to say — actual
// work activity, not a lifecycle. And it is how 39b's "actively thinking"
// reads now: the arc, plus the word beside it that a screen reader gets.
//
// Rendered, not grepped — the point is what a row puts on screen in each
// state. tests/improve-session-spinner.test.js (#1597) owns the arc's class
// and gating; tests/improve-ready-for-input.test.js (#1959) owns the words.
//
// Run with: node --test tests/improve-session-activity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ROW_TSX = read('frontend/src/features/improve/session-row.tsx');
const CONTROLLER = read('frontend/src/features/improve/improve-controller.js');
const MANIFEST = JSON.parse(read('dapp.json'));

const { SessionRow } = loadTsx('frontend/src/features/improve/session-row.tsx');

const VIEW = {
  key: 's5', kind: 'session', id: 5, appSlug: 'demo', appName: 'Demo app',
  icon: { kind: 'letter', letter: 'D' }, title: 'Draft the spec',
  href: '#app/demo/dev/proposals/5', status: null, busy: false, awaitingInput: false,
  lastActivityAt: '2026-09-10T10:05:00.000Z',
};

const row = (view) => renderToHtml(createElement(SessionRow, {
  session: view, showApp: false, onNavigate() {},
}));

/**
 * The retired badge, as markup rather than as a class name: a small round
 * element cut out of the tile with a border in the panel's surface colour.
 * Matching the SHAPE and not just `bg-emerald-500` is deliberate — the ask
 * was to stop saying state with a dot, so the same dot in a different colour
 * would have to fail this too.
 */
const CORNER_DOT = /h-3 w-3 rounded-full|rounded-full[^"]*border-2|border-2[^"]*rounded-full/;

// ── 39a: no static dot, in any state ───────────────────────────────────

test('an idle row carries no dot at all — nothing on it is solid green', () => {
  const html = row(VIEW);
  assert.doesNotMatch(html, CORNER_DOT, 'the tile corner is empty');
  assert.doesNotMatch(html, /bg-emerald-500(?!\/)/,
    'the only emerald left is the pill\'s own /15 tint, which comes with a word');
  assert.doesNotMatch(html, /absolute/,
    'and nothing is positioned against the tile any more');
  assert.match(html, /Ready/, 'the state is still said — in the pill, in words');
});

test('a row waiting on its owner is no different in shape', () => {
  const html = row({ ...VIEW, awaitingInput: true });
  assert.doesNotMatch(html, CORNER_DOT);
  // QA 2026-09-24 Q29: the waiting pill reads "Needs you" (it was "Ready
  // for your input", which squeezed the title in a Messages row).
  assert.match(html, /Needs you/);
});

test('a handed-off work order lost its outlined dot too (#1417)', () => {
  const html = row({ ...VIEW, key: 't7', kind: 'task', id: 7, href: '#app/demo/dev/issues/7' });
  assert.doesNotMatch(html, CORNER_DOT);
  assert.doesNotMatch(html, /ring-zinc-400/, 'the ringed badge went with the rest');
  assert.match(html, /Handed off/);
});

// ── 39b: "actively thinking" is the arc and the word ───────────────────

test('a session mid-turn draws the activity indicator, with its label', () => {
  const html = row({ ...VIEW, busy: true });
  assert.match(html, /<span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true">/,
    'the platform\'s shared arc, and decorative — the word is what is read');
  assert.match(html, /Working/, 'the accessible label for the same fact');
  // The arc is INSIDE the pill, so the two are one indicator rather than a
  // spinner that happens to sit near a word.
  assert.match(html, /rounded-full[^>]*>\s*<span class="dc-status-icon dc-status-spinner-arc"/);
});

test('and no yellow dot beside it', () => {
  const html = row({ ...VIEW, busy: true });
  assert.doesNotMatch(html, CORNER_DOT);
  assert.doesNotMatch(html, /bg-amber-400(?!\/)/,
    'the pill\'s /20 tint is the only amber; the solid dot is gone');
});

// ── The indicator is live, which is the whole of 39a ───────────────────

test('what the pill reads is the live session store, not the last payload', () => {
  // #1958's seam, asserted here because it is what makes the surviving
  // indicator an ACTIVITY indicator rather than a second lifecycle colour.
  assert.match(CONTROLLER, /live\.isBusy\(session\.id, fallback\)/);
  assert.match(ROW_TSX, /\{state\.spinner \?/, 'and the row draws it off that flag');
});

// ── The tile went back to answering "which app" ────────────────────────

test('the tile still shows the app, and is no longer a positioning context', () => {
  assert.match(row(VIEW), /<span class="text-sm font-semibold leading-none[^"]*">D<\/span>/,
    'the letter fallback still renders inside the tile');
  const tile = ROW_TSX.slice(ROW_TSX.indexOf('function AppTile('));
  assert.doesNotMatch(tile.slice(0, 600), /relative/,
    'the wrapper existed for the badge; the badge is gone');
  assert.doesNotMatch(tile.slice(0, 600), /stateOf\(/,
    'and the tile no longer asks what state the row is in');
});

// ── The declared checks follow the markup ──────────────────────────────

test('the mock rows left the declared checks with Messages\' Agents list (16 Nov 2026)', () => {
  // #5289 checked the two mock rows on the Messages screen's Agents list, by
  // their inbox slot, once the bell's Messages filter went. Messages lists
  // conversations alone now, so no shell screen draws this row and no check
  // can open it: the badge's absence is pinned by the renders above, not by
  // a declared check that would select nothing. The manifest's total is
  // pinned in ONE place, tests/dev-board-fold.test.js, with its changelog.
  const onMessages = MANIFEST.tests.filter((t) => /\[data-inbox-session|\[data-improve-row/.test(t.expectSelector || ''));
  assert.deepEqual(onMessages.map((t) => t.name), [], 'no check selects the retired Messages slot or its row');
});
