// Swipe to vote on a Needs-you card, on a phone (#3052).
//
// The arithmetic is EXECUTED (tests/lib/render-tsx.js `loadTsx`, the harness
// tests/workshop-ask-stream.test.js uses): where a press picks its axis, how
// far a drag has to go to vote, and which way is which. Those are the rules a
// source scan cannot check, and each one wrong is a gesture that either
// fights the feed's vertical paging or votes on a nudge.
//
// The wiring is pinned from source, like the rest of the Needs-you feed's
// tests (tests/dev-workshop.test.js): the swipe goes through the Vote sheet's
// own `answer()`, and so through castVote, which asks a No for its reason and
// casts nothing when that prompt is dismissed; it is bound only below the
// 700px breakpoint and only on cards the viewer can vote on; and app.css
// keeps the vertical pan, and keeps the card still where motion is unwelcome.
//
// Run with: node --test tests/workshop-swipe-vote.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const swipe = loadTsx('frontend/src/features/dev-board/workshop/swipe-vote.ts');
const {
  SWIPE_LOCK_PX, SWIPE_COMMIT_SHARE, SWIPE_COMMIT_MIN_PX,
  swipeAxis, commitDistance, swipeSide, swipeProgress, swipeVerdict,
} = swipe;

const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const CSS = read('public/css/app.css');

// ── The axis lock ──────────────────────────────────────────────────────

test('a press is still a tap until it has moved the lock distance', () => {
  assert.equal(SWIPE_LOCK_PX, 10);
  assert.equal(swipeAxis(0, 0), null);
  assert.equal(swipeAxis(9, 0), null, 'nine pixels sideways is not a swipe yet');
  assert.equal(swipeAxis(0, -9), null, 'nor nine up');
  assert.equal(swipeAxis(6, 7), null, 'measured as a distance: 6,7 is 9.2px');
  assert.equal(swipeAxis(10, 0), 'x', 'ten is');
});

test('the axis is whichever way the press mostly went, and a tie pages', () => {
  assert.equal(swipeAxis(30, 5), 'x');
  assert.equal(swipeAxis(-30, 5), 'x', 'left counts the same as right');
  assert.equal(swipeAxis(5, -30), 'y', 'an upward drag stays the feed\'s');
  assert.equal(swipeAxis(5, 30), 'y');
  assert.equal(swipeAxis(20, 20), 'y', 'a diagonal keeps doing what it always did');
  assert.equal(swipeAxis(-20, -20), 'y');
  assert.equal(swipeAxis(21, 20), 'x', 'only a drag that is plainly more sideways votes');
});

test('a press with no usable coordinates never locks', () => {
  assert.equal(swipeAxis(NaN, 0), null);
  assert.equal(swipeAxis(0, NaN), null);
});

// ── The threshold ──────────────────────────────────────────────────────

test('the line is 35% of the card, never closer than 96px', () => {
  assert.equal(SWIPE_COMMIT_SHARE, 0.35);
  assert.equal(SWIPE_COMMIT_MIN_PX, 96);
  assert.equal(commitDistance(360), 126, 'a phone card');
  assert.equal(commitDistance(1000), 350);
  assert.equal(commitDistance(200), 96, 'a narrow card does not vote on a nudge');
  assert.equal(commitDistance(0), 96, 'nor does one not laid out yet');
  assert.equal(commitDistance(-5), 96);
  assert.equal(commitDistance(NaN), 96);
});

test('right is yes and left is no, only past the line', () => {
  assert.equal(swipeVerdict(0, 360), null);
  assert.equal(swipeVerdict(125, 360), null, 'a pixel short snaps back');
  assert.equal(swipeVerdict(-125, 360), null);
  assert.equal(swipeVerdict(126, 360), 'yes', 'on the line votes');
  assert.equal(swipeVerdict(-126, 360), 'no');
  assert.equal(swipeVerdict(300, 360), 'yes');
  assert.equal(swipeVerdict(-300, 360), 'no');
  assert.equal(swipeVerdict(NaN, 360), null);
});

test('the side names the hint from the first pixel; the progress fades it in', () => {
  assert.equal(swipeSide(1), 'yes');
  assert.equal(swipeSide(-1), 'no');
  assert.equal(swipeSide(0), null);
  assert.equal(swipeSide(NaN), null);
  assert.equal(swipeProgress(0, 360), 0);
  assert.equal(swipeProgress(63, 360), 0.5, 'halfway to the line');
  assert.equal(swipeProgress(-63, 360), 0.5, 'either way');
  assert.equal(swipeProgress(126, 360), 1, 'full strength exactly where letting go votes');
  assert.equal(swipeProgress(400, 360), 1, 'and no further');
  assert.equal(swipeProgress(NaN, 360), 0);
});

// ── The wiring ─────────────────────────────────────────────────────────

/** The source from `start` up to the first `end` after it. */
function body(src, start, end) {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `${start} is still there`);
  return src.slice(at, src.indexOf(end, at));
}

test('the swipe votes through answer(), so a No asks for its reason and a dismissal casts nothing', () => {
  const feed = body(WORKSHOP, 'function NeedsFeed(', '\nfunction GroupStrip(');
  // One vote path. The swipe's commit calls the same `answer` the sheet's
  // Yes and No buttons call, which calls castVote by name off the row.
  assert.match(feed, /commit: \(key, which, settled\) => \{\s*if \(!swipeOk\(key\)\) \{ settled\(\); return; \}\s*answer\(which, settled\);/);
  assert.ok(!/castVote/.test(body(WORKSHOP, 'function useSwipeVote(', '\n/* ── The feed')),
    'the gesture never calls castVote itself');
  assert.ok(!/fetch\(/.test(body(WORKSHOP, 'function useSwipeVote(', '\n/* ── The feed')),
    'nor posts a vote of its own');
  // `settled` lets the held card go once the vote is on its way (the prompt
  // closed with a line) or was not cast (the prompt was dismissed).
  const answer = body(feed, '  const answer = (which', '\n  };\n');
  assert.match(answer, /const onSend = \(\) => \{\s*setSending\([^;]*;\s*if \(settled\) settled\(\);/);
  assert.match(answer, /if \(ok === true\) \{\s*setAnswered\([\s\S]*?\}\s*if \(settled\) settled\(\);\s*\}\);$/);
  // castVote's side: the No's line is asked for first, and a dismissed
  // prompt returns before anything is sent.
  const view = read('public/js/app-view.js');
  const cast = body(view, '  async castVote(sessionId, vote', '\n  },\n');
  const asks = cast.indexOf('_resolveVoteReason(vote, opts)');
  const posts = cast.indexOf('fetch(`/api/sessions/');
  assert.ok(asks > 0 && posts > asks, 'the reason is resolved before the vote is posted');
  assert.match(cast, /if \(reason === false\) \{\s*AppView\._voteInFlight\.delete\(key\);\s*return false;/);
  const ask = body(view, '  async _askVoteReason(vote)', '\n  },\n');
  assert.match(ask, /if \(answer === null\) return no \? false : null;/, 'a dismissed No prompt is `false`: no vote');
  assert.match(ask, /if \(no && !line\) \{[\s\S]*?return false;/, 'and so is an empty line');
});

test('only a card the viewer can vote on, on a phone, takes the gesture', () => {
  const can = body(WORKSHOP, 'function canSwipeVote(', '\n}\n');
  assert.match(can, /row\.kind === 'vote' && !!\(row\.yes && row\.yes\.act\) && !!\(row\.no && row\.no\.act\)/,
    'a proposal whose Yes and No both vote; an issue or a governance row does not');
  const feed = body(WORKSHOP, 'function NeedsFeed(', '\nfunction GroupStrip(');
  assert.match(feed, /swipe=\{!wide && canSwipeVote\(r\) && !answered\[r\.key\]\}/,
    'marked only below the breakpoint, and not once answered here');
  assert.match(feed, /useSwipeVote\(scrollRef, !wide, swipeHandle\);/, 'the listeners are bound only there too');
  assert.match(feed, /const swipeOk = \(key: string\) => !!\(row && row\.key === key && canSwipeVote\(row\)\s*&& !answered\[key\] && !sendingRef\.current\.has\(key\)\);/,
    'and asked again on the press: the card in view, with no vote of its own in flight');
  const hook = body(WORKSHOP, 'function useSwipeVote(', '\n/* ── The feed');
  assert.match(hook, /if \(!enabled \|\| !scroller \|\| typeof window === 'undefined'\) return undefined;/);
  assert.match(hook, /closest<HTMLElement>\('\[data-ws-swipeable\]'\)/);
  assert.match(hook, /if \(!handleRef\.current\.can\(key\)\) return;/);
});

test('an upward drag is let go, and a sideways one never also clicks', () => {
  const hook = body(WORKSHOP, 'function useSwipeVote(', '\n/* ── The feed');
  assert.match(hook, /if \(axis === 'y'\) \{ drag = null; return; \}/, 'the feed keeps its paging');
  // A sideways lock joins the kit's gesture arbiter (PlatformUI.gestures()),
  // the way home.js's long-press does, and yields to a kit recognizer that
  // already owns the finger (the Dev scroller's pull-to-refresh among them).
  assert.match(hook, /const g = gestureArbiter\(\);\s*if \(g && !g\.claim\(e\.pointerType === 'touch' \? 'touch' : e\.pointerId, SWIPE_VOTE_TOKEN\)\) \{ drag = null; return; \}\s*drag\.axis = axis;/);
  assert.match(WORKSHOP, /typeof ui\.gestures === 'function' \? ui\.gestures\(\) : null/);
  assert.match(hook, /scroller\.addEventListener\('pointercancel', onCancel\);/, 'the browser taking the pan resets the card');
  assert.match(hook, /const which = swipeVerdict\(dx, width\);\s*if \(!which\) \{ rest\(el\); return; \}/,
    'short of the line the card snaps back and nothing is sent');
  assert.match(hook, /scroller\.addEventListener\('click', onClick, true\);/);
  assert.match(hook, /if \(axis !== 'x'\) return;\s*swallow = true;/, 'only a sideways drag swallows the click after it');
  assert.match(hook, /e\.pointerType === 'mouse' && e\.button !== 0/, 'a right-click is not a drag');
  // Everything the listeners wrote comes off when they go (a rotation across
  // the breakpoint, the tab closing).
  assert.match(hook, /querySelectorAll<HTMLElement>\('\[data-ws-swipe\], \[data-ws-swiping\]'\)\.forEach\(clear\);/);
});

test('the hints are two aria-hidden stamps, drawn only on a swipeable card', () => {
  const item = body(WORKSHOP, 'const FeedItem = memo(function FeedItem(', '\n});\n');
  assert.match(item, /data-ws-swipeable=\{swipe \? '' : undefined\}/);
  assert.match(item, /\{swipe \? <span className="dev-ws-swipe-hint dev-ws-swipe-yes" aria-hidden="true">Yes<\/span> : null\}/);
  assert.match(item, /\{swipe \? <span className="dev-ws-swipe-hint dev-ws-swipe-no" aria-hidden="true">No<\/span> : null\}/);
  // After the caption, so `.dev-ws-item-title + .dev-ws-item-summary ~
  // .dev-ws-item-caption` (a declared check) still matches.
  assert.ok(item.indexOf('dev-ws-swipe-hint') > item.indexOf('dev-ws-item-caption'));
});

// ── app.css ────────────────────────────────────────────────────────────

test('the card keeps the vertical pan and moves only where motion is welcome', () => {
  const at = CSS.indexOf('/* ── Swipe to vote, on a phone (#3052)');
  assert.ok(at > 0, 'the block states its reason');
  const block = CSS.slice(at, CSS.indexOf('/* ── The picture', at));
  assert.match(block, /@media \(max-width: 699\.98px\) \{[^@]*?\.dev-ws-item\[data-ws-swipeable\] \{ touch-action: pan-y; \}/,
    'pan-y: the feed still pages from a touch that starts on the card');
  assert.match(block, /\.dev-ws-needs-scroll \{ overflow-x: hidden; \}/, 'a card off to one side cannot scroll the feed sideways');
  // The travel and the spring back exist only under no-preference, so with
  // reduced motion the card stays put and only the hint says what a release
  // would do.
  const motion = /@media \(max-width: 699\.98px\) and \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/.exec(block);
  assert.ok(motion, 'a no-preference block');
  assert.match(motion[1], /\.dev-ws-item\[data-ws-swipe\] \{ transform: translateX\(var\(--ws-swipe-x, 0px\)\); \}/);
  assert.match(motion[1], /transition: transform \.26s/);
  const outside = block.replace(motion[0], '');
  assert.ok(!/transform: translateX/.test(outside), 'the card is moved nowhere else');
  assert.ok(!/transition:/.test(outside), 'and nothing animates outside it');
  // No rotation of the card itself: a rotated snap child changes the box
  // the feed's y-snap measures, and the feed would jiggle under the drag.
  assert.ok(!/\.dev-ws-item\[data-ws-swipe\] \{[^}]*rotate/.test(block));
  // The hint's strength follows the drag, faint at most.
  assert.match(block, /\.dev-ws-item\[data-ws-swipe="yes"\] > \.dev-ws-swipe-yes,\n\.dev-ws-item\[data-ws-swipe="no"\] > \.dev-ws-swipe-no \{ opacity: calc\(var\(--ws-swipe-p, 0\) \* \.9\); \}/);
  assert.match(block, /\.dev-ws-swipe-hint \{[^}]*opacity: 0; pointer-events: none;/);
  assert.match(block, /\.dev-ws-item\[data-ws-swiping\] \{ user-select: none; -webkit-user-select: none; \}/,
    'a mouse drag across the summary does not select it');
});

// ── The declared check ─────────────────────────────────────────────────

test('the declared Needs-you anatomy check also pins that a wide window takes no swipe', () => {
  // Folded into an existing check on the same route rather than declared as
  // a new one (dapp.json's check count is pinned and near its ceiling). The
  // checks run at 1280px, above the breakpoint, where no card is swipeable.
  const dapp = JSON.parse(read('dapp.json'));
  const anatomy = dapp.tests.filter((t) => /leads with its title, then the sentence a voter reads/.test(t.name));
  assert.equal(anatomy.length, 1);
  assert.match(anatomy[0].expectSelector, /\[data-ws-item\]\[data-ws-kind="vote"\]:not\(\[data-ws-swipeable\]\) > \.dev-ws-item-title/);
});
