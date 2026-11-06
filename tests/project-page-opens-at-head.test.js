'use strict';

// #3583: "Sometimes the hub tab area looks like this": a project's Hub that
// came up scrolled past its own hero, with the tab strip already pinned over
// it on its band (and that band biting into the coloured header).
//
// The pin itself was right: the page really was scrolled. What scrolled it
// was everything that promised to open a page at its head and did not:
//
//   1. A TAB PRESS and an in-page DOOR scrolled the WINDOW. On a computer (and
//      in the installed app and the native WebView) the project page scrolls
//      inside #dev-forum-scroll, so the new tab opened at the old one's offset:
//      press Hub from halfway down the Workshop and the hub opened scrolled.
//   2. THE PAGE'S SCROLL MEMORY (AppView._saveFeedScroll, for "an item, then
//      Back") put an offset back onto a tab it was not taken on, after a door,
//      and saved one project's offset under the next project's name.
//   3. A DOOR PRESSED FROM ANOTHER SCREEN re-measured the pin while the page
//      was hidden: no box, every edge 0, `0 < 0 + 10`, pinned at rest.
//
// And where the document scrolls at 700px and up (a tablet's browser, a
// window under 768px) the strip pinned at the top of the SCREEN, over the
// header; on a computer it pinned 7px into the header's foot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const AppView = require('../public/js/app-view.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WORKSHOP_PATH = 'frontend/src/features/dev-board/workshop/workshop.tsx';
const WORKSHOP = read(WORKSHOP_PATH);
const APP_VIEW = read('public/js/app-view.js');
const CSS = read('public/css/app.css');

function withWindow(win, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  globalThis.window = win;
  try { return fn(); } finally {
    if (had) globalThis.window = was;
    else delete globalThis.window;
  }
}

test('scrollToHead moves the element that scrolls the page, not only the window', () => {
  const { scrollToHead } = loadTsx(WORKSHOP_PATH);
  const calls = [];
  const feed = { scrollTop: 640 };
  const host = { closest: (sel) => (sel === '#dev-forum-scroll' ? feed : null) };
  withWindow({ scrollTo: (opts) => calls.push(opts) }, () => scrollToHead(host));
  assert.equal(feed.scrollTop, 0, 'the dev frame\'s own scroller goes back to its top');
  assert.deepEqual(calls, [{ top: 0 }], 'and the window too, where the document is what scrolls');

  // A page outside the dev frame, or none at all: the window alone, no throw.
  const loose = { closest: () => null };
  withWindow({ scrollTo: () => {} }, () => scrollToHead(loose));
  withWindow({ scrollTo: () => {} }, () => scrollToHead(null));
  // No window to scroll (a test, a server render) is not an error either.
  scrollToHead(host);
});

test('a tab press and a door both go through it, and a press forgets the old tab\'s offset', () => {
  const openTab = /const openTab = \(next: TabKey\) => \{([\s\S]*?)\n  \};/.exec(WORKSHOP);
  assert.ok(openTab, 'openTab exists');
  assert.match(openTab[1], /callAppView\('_saveFeedScroll', v\.slug, 0\);/);
  assert.match(openTab[1], /scrollToHead\(hostRef\.current\);/);
  const door = WORKSHOP.slice(WORKSHOP.indexOf('const onDoor = (event: Event) => {'));
  const doorBody = door.slice(0, door.indexOf('\n    };'));
  assert.match(doorBody, /setTab\(door\.tab\);[\s\S]*scrollToHead\(hostRef\.current\);/);
  // The window-only call is gone from the page: it is the bug.
  const page = WORKSHOP.slice(WORKSHOP.indexOf('export function DevWorkshop('));
  assert.doesNotMatch(page, /window\.scrollTo/);
});

test('the page says whose it is beside which tab, for AppView to save it under', () => {
  assert.match(WORKSHOP, /className="dev-ws"\s*data-ws-tab=\{tab\}[\s\S]{0,400}?data-ws-slug=\{slug \|\| undefined\}/);
  // Saved under the OUTGOING page's project and tab, read off the page.
  assert.match(APP_VIEW, /const outgoingPage = outgoingFeed\?\.querySelector\?\.\('\.dev-ws\[data-ws-slug\]'\) \|\| null;/);
  assert.match(APP_VIEW, /AppView\._saveFeedScroll\(\s*outgoingPage \? outgoingPage\.getAttribute\('data-ws-slug'\) : App\.currentApp,\s*outgoingScroll\.scrollTop,\s*outgoingPage \? outgoingPage\.getAttribute\('data-ws-tab'\) : null,\s*\);/);
  // Put back only onto the tab the page opens on.
  assert.match(APP_VIEW, /const savedScroll = AppView\._getFeedScroll\(App\.currentApp, AppView\._workshopTab\(\)\);/);
});

test('an offset is put back only onto the tab it was taken on', () => {
  AppView._savedFeedScroll = {};
  AppView._savedFeedTab = {};
  AppView._saveFeedScroll('garden', 600, 'all');
  assert.equal(AppView._getFeedScroll('garden', 'all'), 600, 'Back to the same tab lands where you were');
  assert.equal(AppView._getFeedScroll('garden', 'status'), 0, 'the hub does not open at All items\' offset');
  assert.equal(AppView._getFeedScroll('garden'), 600, 'a caller that names no tab keeps the per-slug answer');
  // Saved with no tab (a list with no page in it): any tab may have it.
  AppView._saveFeedScroll('garden', 300);
  assert.equal(AppView._getFeedScroll('garden', 'status'), 300);
  // A zero forgets the tab with the offset.
  AppView._saveFeedScroll('garden', 600, 'all');
  AppView._saveFeedScroll('garden', 0);
  assert.equal(AppView._getFeedScroll('garden', 'all'), 0);
  assert.deepEqual(AppView._savedFeedTab, {});
});

test('a door opens the page at its head: the project\'s offset is forgotten', () => {
  AppView._savedFeedScroll = {};
  AppView._savedFeedTab = {};
  AppView._saveFeedScroll('garden', 480, 'status');
  AppView._saveFeedScroll('orchard', 220, 'status');
  AppView._landOnHub('garden');
  assert.equal(AppView._getFeedScroll('garden', 'status'), 0, 'the hub it opens is at its top');
  assert.equal(AppView._getFeedScroll('orchard', 'status'), 220, 'another project keeps its own');
  AppView._landOnTab('orchard', 'discussion');
  assert.equal(AppView._getFeedScroll('orchard', 'status'), 0);
});

test('a page that is not drawn is not pinned, and coming back into view is heard', () => {
  const hook = WORKSHOP.slice(WORKSHOP.indexOf('function usePinnedStrip('));
  const body = hook.slice(0, hook.indexOf('\n}\n'));
  assert.match(body, /const strip = bar\.getBoundingClientRect\(\);/);
  assert.match(body, /const pinned = strip\.height > 0 && below\.getBoundingClientRect\(\)\.top < strip\.bottom \+ WS_GAP_PX - 0\.5;/,
    'a hidden page reads every edge as 0, and 0 < 0 + 10 is not a pin');
  assert.match(body, /const headPinned = !!pane && !!head && pane\.getBoundingClientRect\(\)\.top < head\.getBoundingClientRect\(\)\.top - 0\.5;/,
    'nor is the head: its pane reads 0 like it, and 0 < 0 - 0.5 is not one either');
  assert.match(body, /new ResizeObserver\(schedule\)/);
  assert.match(body, /seen\?\.observe\(host\);/);
  assert.match(body, /seen\?\.disconnect\(\);/, 'and let go on teardown');
});

test('the strip pins at the header\'s foot, whichever element scrolls the page', () => {
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(wide, 'the wide-screen block exists');
  const decls = wide[1].replace(/\/\*[\s\S]*?\*\//g, '');
  // The dev frame's scroller: the header's foot, MEASURED (#3726), so an
  // in-flow strip between the header and the frame cannot pull the band off
  // it; 7px is the fallback for the frame before the first measurement.
  assert.match(decls, /\n  #dev-workshop \{ --ws-pin-top: var\(--dev-ws-head-foot, 7px\); \}/);
  // The document: the header's own height (Discover's search bar measured
  // the same until One Home, #6361, retired it).
  assert.match(decls, /html\[data-browser-scroller="dev-forum-scroll"\] #dev-workshop \{\s*--ws-pin-top: calc\(var\(--browser-banner-h\) \+ var\(--platform-header-h\) \+ var\(--platform-safe-top\)\);\s*\}/);
  // The strip, its band under 768px (where it rests, tucked), and the head.
  const rail = /\n  \.dev-ws-tabs \{([\s\S]*?)\n  \}/.exec(decls);
  assert.match(rail[1], /top: var\(--ws-pin-top, 0px\);/);
  assert.doesNotMatch(rail[1], /\btop: 0;/);
  assert.match(decls, /@media \(max-width: 767\.98px\) \{\s*\.dev-ws-tabs\.dev-ws-band \{ top: calc\(var\(--ws-pin-top, 0px\) - 15px\); \}\s*\}/);
  assert.match(decls, /#dev-workshop \.dev-ws-pane-head \{\s*top: calc\(var\(--ws-pin-top, 0px\) \+ var\(--dev-ws-head-top, 0px\)\);/);
  // A phone keeps its own offset (#3522), now measured from the same foot.
  const phone = /@media \(max-width: 699\.98px\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)*#dev-workshop \{ --ws-band-top: calc\(var\(--dev-ws-head-foot, 7px\) - 17px\); \}([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(phone, 'the phone block is where it was');
  assert.doesNotMatch(phone[0], /--ws-pin-top/);
});

test('#3726: the band pins to the header\'s MEASURED foot, so in-flow chrome cannot open a gap', () => {
  // THE BUG. "Community hub tabs can still separate from header sometimes in
  // some kinds of scrolling down." Every sticky offset on the page is an
  // offset from the scrollport top, and the header's foot was a literal 7px
  // below it — true only while nothing sits between the header and the frame.
  // The "View as non-admin" reminder (and any strip that is not fixed) is
  // in-flow chrome there: it moved #dev-forum-scroll's top down while the
  // header stayed, so the band rested below the foot and a gap opened over
  // the cards. Measured at 1280px with a 40px strip: a 33px gap.
  //
  // The fix measures the foot in the scrollport's own frame and publishes it
  // as a custom property; app.css's offsets consume it, keeping their
  // literals as the fallback and their own arithmetic for the document-scroll
  // case (where the property is absent).
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(wide, 'the wide-screen block exists');
  const decls = wide[1].replace(/\/\*[\s\S]*?\*\//g, '');
  // The measured foot is what the pin offset reads, and the strip, band and
  // head all derive from it, so they cannot disagree.
  assert.match(decls, /#dev-workshop \{ --ws-pin-top: var\(--dev-ws-head-foot, 7px\); \}/);
  assert.match(decls, /@media \(max-width: 767\.98px\) \{\s*\.dev-ws-tabs\.dev-ws-band \{ top: calc\(var\(--ws-pin-top, 0px\) - 15px\); \}\s*\}/);
  assert.match(decls, /#dev-workshop \.dev-ws-pane-head \{\s*top: calc\(var\(--ws-pin-top, 0px\) \+ var\(--dev-ws-head-top, 0px\)\);/);
  // The hook measures it: the first scrolling ancestor's top, from the
  // header's own bottom (NEGATIVE when the frame starts below the header).
  const hook = WORKSHOP.slice(WORKSHOP.indexOf('function usePinnedStrip('));
  const body = hook.slice(0, hook.indexOf('\n}\n'));
  assert.match(body, /const foot = headerFoot\(host\);/);
  assert.match(body, /Math\.round\(foot\)/);
  assert.match(body, /cssHost\.style\.setProperty\(HEAD_FOOT_PROP/);
  assert.match(body, /cssHost\.style\.removeProperty\(HEAD_FOOT_PROP\)/, 'dropped where the document scrolls, so the CSS fallback takes over');
  // It asks the live layout which box scrolls, not the shell: the nearest
  // scrolling ancestor in the dev frame is #dev-forum-scroll.
  assert.match(WORKSHOP, /function headerFoot\(host: HTMLElement\): number \| null \{/);
  assert.match(WORKSHOP, /header\.getBoundingClientRect\(\)\.bottom - n\.getBoundingClientRect\(\)\.top/);
  assert.match(WORKSHOP, /const oy = getComputedStyle\(n\)\.overflowY;/);
  assert.match(WORKSHOP, /const HEAD_FOOT_PROP = '--dev-ws-head-foot';/);
  // And it is written on #dev-workshop, where app.css declares the offsets: a
  // custom property inherits DOWN, so a value on `.dev-ws` would resolve to
  // the fallback instead.
  assert.match(WORKSHOP, /function offsetHost\(host: HTMLElement\): HTMLElement \{/);
  assert.match(WORKSHOP, /host\.closest\('#dev-workshop'\)/);
});
