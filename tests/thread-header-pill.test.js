'use strict';

// ONE THREAD, ONE HEADER (18 Nov 2026). A request's or a change's page is
// drawn on its own page, in the Workshop's side panel beside the list, and in
// the column beside Homeroom bot's list. It now draws the same header on all
// three, a sticky pill, and no panel draws chrome of its own around it:
//
//   - the sheet's bar (ChangeBar, RequestBar) leads with the project's tile,
//     says the project and the topic on its second line (the card's kicker
//     said them before) and ends with ↗ and × (thread-exits.tsx), which
//     app.css shows only inside a panel;
//   - the Workshop's panel hands those two discs its own close and
//     open-as-page (workshop/side-actions.ts) and draws no sheet or bar;
//   - the bot column puts its own header row away for those pages
//     (`data-thread-pill`) and the page in it paints no ground;
//   - the line between two columns is a grip that drags (lib/split-drag.ts),
//     shown only for a pointer that moved onto it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CHANGE = 'frontend/src/features/dev-board/topic/change-head.tsx';
const REQUEST = 'frontend/src/features/dev-board/topic/request-head.tsx';
const CSS = read('public/css/app.css');
// Loaded before any test fakes a window: the bundles run their module code once.
const { ChangeBar } = loadTsx(CHANGE);
const { RequestBar } = loadTsx(REQUEST);
const EXITS = loadTsx('tests/fixtures/thread-exits-api.ts');

function withProject(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = { AppView: { appData: { slug: 'homeroom-x', name: 'Homeroom', icon_emoji: '🏠', icon_url: null } } };
  try { return fn(); } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
}

const changeView = (patch = {}) => ({
  number: 9200, category: 'Project workflows', author: 'admin', at: null, time: '', timeTitle: '',
  via: null, status: null, votes: {}, testing: {}, shots: null, thanks: false, ...patch,
});

test('a change\'s bar is the head: the project\'s tile first, "Change #N", its title, the project and topic, ⋯, then ↗ and ×', () => {
  const html = withProject(() => renderToHtml(createElement(ChangeBar, { v: changeView(), menuKey: 'change:17' })));
  assert.match(html, /^<header class="messages-thread-header"><span class="app-icon-tile dev-thread-bar-tile"[^>]*aria-hidden="true">/,
    'the tile leads the header');
  // 19 Nov 2026: "Change #N" is the small line's; the title is the change's
  // own, its number until it has one.
  assert.match(html, /<div class="min-w-0 flex-1 dev-thread-bar-text"><div class="flex min-w-0 items-center gap-2"><div class="messages-thread-kicker min-w-0" data-change-kicker="">Change #9200<\/div><\/div>/);
  assert.match(html, /<div class="messages-thread-name min-w-0"><span class="dev-thread-bar-title">Change #9200<\/span><\/div>/);
  assert.match(html, /<div class="messages-thread-sub" data-change-category="">Homeroom · Project workflows<\/div>/,
    'the project, then the topic, which app.css puts on the small line');
  // ⋯ stays a direct child of the header (a declared check selects on it), and
  // the two discs end the row after it.
  assert.match(html, /<button type="button" class="messages-thread-action dev-card-menu-btn" data-card-menu="change:17"[\s\S]*?<\/button><span class="dev-thread-exits" data-thread-exits="">/);
  assert.match(html, new RegExp(`data-thread-exit="expand" aria-label="${message('project:sidePanel.openAsPage')}"`));
  assert.match(html, new RegExp(`data-thread-exit="close" aria-label="${message('core:common.close')}"`));
  // With no topic, the project alone, and no category attribute.
  const bare = withProject(() => renderToHtml(createElement(ChangeBar, { v: changeView({ category: null }), menuKey: '' })));
  assert.match(bare, /<div class="messages-thread-sub">Homeroom<\/div>/);
  assert.doesNotMatch(bare, /data-change-category/);
});

test('a request\'s bar is the same head, its name kept beside its category for the checks that select on it', () => {
  const r = {
    number: 9107, title: 'Staging demo: a request', category: 'Project workflows', menuKey: null,
    status: { closed: false, stage: 'asked' },
  };
  const html = withProject(() => renderToHtml(createElement(RequestBar, { r, pill: null, threadMenu: true })));
  assert.match(html, /^<header class="messages-thread-header"><span class="app-icon-tile dev-thread-bar-tile"/);
  assert.match(html, /<div class="min-w-0 flex-1 dev-thread-bar-text"><div class="messages-thread-kicker" data-request-kicker="">/);
  // #6081: the title the page shows, translated when the reader asked.
  const shown = withProject(() => renderToHtml(createElement(RequestBar, { r, pill: null, title: 'Demo de staging : une demande' })));
  assert.match(shown, /dev-request-bar-title">Demo de staging : une demande<\/div>/);
  assert.match(html, /<div class="messages-thread-kicker" data-request-kicker="">Request #9107<\/div>/);
  assert.match(html, /<div class="messages-thread-name line-clamp-2 dev-request-bar-title">Staging demo: a request<\/div><div class="messages-thread-sub" data-request-category="">Homeroom · Project workflows<\/div>/);
  assert.match(html, /<span class="dev-thread-exits" data-thread-exits="">/);
});

test('the discs do what the panel they are in offers: the Workshop\'s own actions, or the top window\'s panel', () => {
  const { act } = EXITS;
  const ws = EXITS;
  const calls = [];
  ws.setWorkshopSideActions({ close: () => calls.push('ws-close'), openFull: () => calls.push('ws-full') });
  const inWorkshop = { currentTarget: { closest: (sel) => (sel === '.dev-ws-side' ? {} : null) } };
  act(inWorkshop, 'expand');
  act(inWorkshop, 'close');
  assert.deepEqual(calls, ['ws-full', 'ws-close']);
  ws.setWorkshopSideActions(null);

  // In the column beside the bot's list: the panel's own document, same
  // origin, asking the top window's controller.
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { documentElement: { classList: { contains: (c) => c === 'in-side-panel' } } };
  globalThis.window = { parent: { UsernodeReact: { sidePanel: { close: () => calls.push('top-close'), expand: () => calls.push('top-expand') } } } };
  try {
    const inColumn = { currentTarget: { closest: () => null } };
    act(inColumn, 'expand');
    act(inColumn, 'close');
  } finally {
    if (had) globalThis.document = prevDoc; else delete globalThis.document;
    globalThis.window = prevWin;
    if (prevWin === undefined) delete globalThis.window;
  }
  assert.deepEqual(calls.slice(2), ['top-expand', 'top-close']);
});

test('the Workshop\'s panel offers the pill its actions while open, and draws a handle on its edge', () => {
  const src = read('frontend/src/features/dev-board/workshop/side-panel.tsx');
  assert.match(src, /setWorkshopSideActions\(\{ close: onClose, openFull \}\);\s+return \(\) => setWorkshopSideActions\(null\);/);
  assert.match(src, /<SideDivider \/>\s+<div className="dev-ws-side-bar">/, 'the handle is the panel\'s first child');
  assert.match(src, /role="separator"[\s\S]{0,80}aria-orientation="vertical"/);
  assert.match(src, /const LIST_W_KEY = 'homeroom:ws-side-list-w';/, 'the width is kept for the next visit');
});

test('the bot column steps its header aside for a request\'s or a change\'s page, never for a decision\'s', () => {
  const src = read('frontend/src/features/side-panel/side-panel.tsx');
  assert.match(src, /const ownPill = s\.route && \/\\\/dev\\\/\(issues\|changes\|proposals\|sessions\)\\\/\\d\+\/\.test\(s\.route\) \? '' : undefined;/);
  assert.match(src, /data-thread-pill=\{ownPill\}/);
  assert.match(CSS, /html:is\(:not\(\[data-skin\]\), \[data-skin="brand"\]\) body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel\[data-thread-pill\] > \.side-panel-head \{ display: none; \}/,
    'only under the looks whose page draws the pill: the frame\'s looks keep the column\'s row and its ×');
  // 19 Nov 2026: and the column starts on the list's top line in the
  // standard look too, so the head card stands level with the bot's own.
  assert.match(CSS, /@media \(min-width: 768px\) \{\s+html:not\(\[data-skin\]\) body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel\[data-thread-pill\] \{\s+top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\) \+ var\(--platform-safe-top, 0px\) \+ \.5rem\);/);
});

test('app.css: the head floats over the scroller, the panels draw no sheet, the card starts at its words', () => {
  const at = CSS.indexOf('ONE THREAD, ONE HEADER (18 Nov 2026)');
  assert.ok(at > 0);
  assert.ok(at < CSS.indexOf('/* looks:begin'), 'outside the generated looks section');
  const block = CSS.slice(at);
  assert.match(block, /#dev-topic-thread \.dev-request:has\(\.dev-thread-card\) \.dev-request-bar \{\s+display: block !important;\s+position: absolute;/);
  // 19 Nov 2026: a card, the cards' 20px corners and edge, its tile and ⋯
  // level at the top, where the capsule was a pill with a drop shadow.
  assert.match(block, /\.dev-request-bar \.messages-thread-header \{\s+pointer-events: auto;\s+display: flex;\s+align-items: flex-start;[\s\S]{0,140}border-radius: 20px;\s+background: var\(--thread-card-solid, var\(--dc-sheet-solid\)\);\s+box-shadow: var\(--thread-card-edge, inset 0 0 0 1px var\(--app-sheet-line\)\);\n\}/);
  assert.doesNotMatch(block.slice(0, block.indexOf('THE VOTE FOLDS INTO THE HEADER')), /border-radius: 999px;\s+background: var\(--thread-card-solid/, 'no capsule');
  // The scroller starts under the head's measured height (thread-head-fit.ts).
  assert.match(block, /--pill-h: var\(--thread-head-h, 104px\);/);
  assert.match(block, /:is\(\.dev-ws-side, \.in-side-panel body\) \.dev-request:has\(\.dev-thread-card\) \{ --pill-top: 0px; \}/,
    'in a panel the head starts on the column\'s top line');
  // The title in two lines, the small line over it, a request's and a change's alike.
  assert.match(block, /#gc-thread-bar :is\(\.messages-thread-name\.dev-request-bar-title, \.dev-thread-bar-title\) \{\s+display: -webkit-box;\s+-webkit-box-orient: vertical;\s+-webkit-line-clamp: 2;/);
  assert.match(block, /\.dev-thread-bar-text > \.messages-thread-sub \{ grid-row: 1; grid-column: 1; \}/);
  assert.match(block, /\.dev-thread-bar-text > \.messages-thread-name \{ grid-row: 2; grid-column: 1 \/ -1; \}/);
  // ⋯ is the one disc; ↗ and × are plain after a thin line.
  assert.match(block, /\.dev-request-bar \.messages-thread-action \{[^}]*background: transparent;\s+box-shadow: none;/);
  assert.match(block, /\.dev-request-bar \.messages-thread-action\[data-card-menu\] \{ box-shadow: inset 0 0 0 1px var\(--app-sheet-line\); \}/);
  assert.match(block, /\.messages-thread-header > \[data-card-menu\] \+ \.dev-thread-exits::before \{/);
  // Scrolled, it tightens to one line of title over the small line.
  assert.match(block, /\.dev-request\[data-thread-head-tight\]:has\(\.dev-thread-card\) #gc-thread-bar :is\(\.messages-thread-name\.dev-request-bar-title, \.dev-thread-bar-title\) \{ -webkit-line-clamp: 1; \}/);
  // The card does not say the title again, except while it is being edited.
  assert.match(block, /\.dev-request:has\(\.dev-thread-card\) \.dev-thread-card > div > \.dev-request-title:not\(:has\(input\)\) \{ display: none; \}/);
  assert.match(block, /\.dev-request-scroll \{\s+padding-top: var\(--pill-under\) !important;\s+scroll-padding-top: var\(--pill-under\);/);
  assert.match(block, /\.dev-request:has\(\.dev-thread-card\) \.dev-thread-kicker \{ display: none; \}/);
  assert.match(block, /:is\(\.dev-ws-side, html\.in-side-panel\.side-panel-beside-ai\) \.dev-thread-exits \{ display: inline-flex; \}/,
    'the discs show only in a panel');
  assert.match(block, /html:is\(:not\(\[data-skin\]\), \[data-skin="brand"\]\) \.dev-ws-side \{\s+background: transparent;\s+box-shadow: none;/);
  assert.match(block, /\.dev-ws-side:has\(\.dev-thread-card\) > \.dev-ws-side-bar \{ display: none; \}/);
});

test('app.css: the cards go under the pill and under the reply box, and no further', () => {
  const at = CSS.indexOf('THE CARDS GO UNDER THE PILL AND UNDER THE REPLY BOX');
  assert.ok(at > 0);
  const block = CSS.slice(at, at + 6000);
  // The top: cut past the head's upper corners, on the id so the looks' own fade
  // (`html[data-skin] … #gc-thread-scroll`) no longer wins in the brand look.
  assert.match(block, /\.dev-request:has\(\.dev-thread-card\) #gc-thread-scroll \{\n  --pill-cut: calc\(var\(--pill-top\) \+ 24px\);\n  -webkit-mask-image: linear-gradient\(to bottom, transparent var\(--pill-cut\), #000 var\(--pill-cut\)\), linear-gradient\(#000, #000\);/);
  assert.doesNotMatch(block, /transparent 4px/, 'no fade across the gap over the pill');
  // The foot: the strip under the reply box shows across the cards' column,
  // the whole scroller less the timeline's (20 Nov 2026: it stopped 12px
  // short of the cards' edges, with the box).
  assert.match(block, /mask-size: 100% calc\(100% - var\(--composer-tuck, 0px\)\), calc\(100% - var\(--composer-end, 0px\)\) var\(--composer-tuck, 0px\);/);
  assert.match(block, /mask-position: 0 0, calc\(var\(--composer-end, 0px\) \* \(1 - var\(--rtl-sign\)\) \/ 2\) 100%;/);
  // The reply box is as wide as the cards over it: the bar has no side padding.
  assert.match(block, /#dev-topic-thread \.dev-request:has\(\.dev-thread-card\) \.dev-request-sheet > \.messages-composer \{ padding-inline: 0; \}/);
  // The scroller runs on under the card by its corner radius.
  assert.match(CSS, /\.messages-composer-card \{\n  border-radius: 22px;/, 'the tuck is the card\'s corner radius');
  assert.match(block, /\.dev-request-sheet:has\(> \.chat-status:empty \+ \.messages-composer > \.messages-composer-card\):not\(:has\(> \.messages-composer > :is\(#gc-thread-reply-preview:not\(\.hidden\), \.dc-attach-error:not\(\.hidden\), \.dc-attach-strip:not\(:empty\)\)\)\) > #gc-thread-scroll \{\n  --composer-tuck: 22px;\n  margin-bottom: calc\(-1 \* var\(--composer-tuck\)\);\n\}/);
  // The newest reply ends 12px over the box, plus the tuck, by a spacer: WebKit
  // leaves a grid scroller's end padding out of what it scrolls, and the wide
  // page's scroller is the two-column grid.
  assert.match(block, /#dev-topic-thread \.dev-request:has\(\.dev-thread-card\) #gc-thread-scroll \{ padding-bottom: 0 !important; \}/);
  assert.match(block, /#dev-topic-thread \.dev-request:has\(\.dev-thread-card\) #gc-thread-scroll::after \{\n  content: "";\n  display: block;\n  grid-column: 1 \/ -1;\n  height: calc\(12px \+ var\(--composer-tuck, 0px\)\);\n\}/);
  assert.doesNotMatch(block, /> #gc-thread-scroll \{[^}]*padding-bottom: calc/, 'no end padding for WebKit to drop');
  // On a wide page the reply box ends where the card does, before the timeline.
  assert.match(CSS, /--thread-rail-gap: 20px;\n[\s\S]{0,200}--composer-end: calc\(var\(--thread-rail-w\) \+ var\(--thread-rail-gap\)\);/);
});

test('app.css: the Workshop panel covers the list below 1760px only while a plan is open beside the page', () => {
  assert.match(CSS, /@media \(max-width: 1759px\) \{\s+body:has\(\.dev-ws-side-body > #gc-spec-side-panel\.gc-spec-side-panel-open\) #dev-workshop:has\(> \.dev-ws\[data-ws-side-open\]\) \{ margin-inline-start: 0; max-width: none; \}/);
  assert.doesNotMatch(CSS, /@media \(max-width: 1759px\) \{\s+#dev-workshop:has/, 'not whenever the window is under 1760px');
});

test('app.css: the halves layout draws its edge only while the detail is open', () => {
  assert.match(CSS, /\.gc-tab-body:has\(> #gc-spec-side-panel\.gc-spec-side-panel-open\[data-detail="halves"\]\) > #dev-topic-thread,/);
  assert.doesNotMatch(CSS, /\.gc-tab-body:has\(> #gc-spec-side-panel\[data-detail="halves"\]\) > #dev-topic-thread,/);
});

test('the grip shows for a pointer that moved onto the line, never one the line arrived under, and at rest on touch', () => {
  assert.match(CSS, /@media \(hover: hover\) \{\s+:is\(\.split-handle\[data-armed\], \.side-panel-divider\):hover::before \{ opacity: \.5; \}/);
  assert.match(CSS, /@media \(pointer: coarse\) \{\s+:is\(\.split-handle, \.side-panel-divider\)::before \{ opacity: \.5; \}/);
  const { armOnMove } = loadTsx('frontend/src/lib/split-drag.ts');
  const listeners = {};
  const attrs = new Set();
  const el = {
    addEventListener: (t, fn) => { listeners[t] = fn; },
    removeEventListener: (t) => { delete listeners[t]; },
    setAttribute: (n) => attrs.add(n),
    removeAttribute: (n) => attrs.delete(n),
  };
  const off = armOnMove(el);
  listeners.pointermove({ movementX: 0, movementY: 0 });
  assert.equal(attrs.has('data-armed'), false, 'the browser\'s own re-hover after a layout reports no movement');
  listeners.pointermove({ movementX: 3, movementY: 0 });
  assert.equal(attrs.has('data-armed'), true);
  listeners.pointerleave();
  assert.equal(attrs.has('data-armed'), false);
  off();
  assert.deepEqual(Object.keys(listeners), []);
});

test('a drag moves the line from the width the column had, towards whichever side the column is on', () => {
  const lib = loadTsx('frontend/src/lib/split-drag.ts');
  const listeners = {};
  const classes = new Set();
  const prevDoc = globalThis.document;
  globalThis.document = { documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) }, dir: 'ltr', getAttribute: () => 'ltr' } };
  try {
    const el = { addEventListener: (t, fn) => { listeners[t] = fn; }, removeEventListener: (t) => { delete listeners[t]; }, setPointerCapture() {} };
    const widths = [];
    let done = 0;
    lib.startSplitDrag({ button: 0, clientX: 500, pointerId: 1, currentTarget: el, preventDefault() {} },
      { start: () => 300, apply: (px) => widths.push(px), done: () => { done += 1; } });
    assert.ok(classes.has('side-panel-resizing'), 'held: frames stand aside, nothing selects');
    listeners.pointermove({ clientX: 540 });
    listeners.pointerup();
    assert.deepEqual(widths, [340]);
    assert.equal(done, 1);
    assert.ok(!classes.has('side-panel-resizing'));
    // The timeline is on the far side of its line: moving towards it widens it.
    lib.startSplitDrag({ button: 0, clientX: 500, pointerId: 1, currentTarget: el, preventDefault() {} },
      { start: () => 332, apply: (px) => widths.push(px), done: () => {}, trailing: true });
    listeners.pointermove({ clientX: 460 });
    listeners.pointerup();
    assert.equal(widths.at(-1), 372);
  } finally {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
  }
});

test('the head measures itself while full and tightens once the thread scrolls (thread-head-fit.ts)', () => {
  const { fitThreadHead, HEAD_TIGHT_AFTER_PX, HEAD_OPEN_BELOW_PX } = loadTsx('frontend/src/features/dev-board/topic/thread-head-fit.ts');
  assert.equal(HEAD_TIGHT_AFTER_PX, 24);
  assert.equal(HEAD_OPEN_BELOW_PX, 8);
  const props = new Map();
  const attrs = new Set();
  const listeners = {};
  const scroller = {
    scrollTop: 0,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: (type) => { delete listeners[type]; },
  };
  const page = {
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
    toggleAttribute: (name, on) => { if (on) attrs.add(name); else attrs.delete(name); },
    removeAttribute: (name) => attrs.delete(name),
    querySelector: (sel) => (sel === ':scope > .dev-request-sheet > .dev-request-scroll' ? scroller : null),
  };
  let height = 102;
  const fades = [];
  const words = { animate: (frames) => fades.push(frames) };
  const head = {
    closest: (sel) => (sel === '.dev-request' ? page : null),
    getBoundingClientRect: () => ({ height }),
    querySelector: (sel) => (sel === '.dev-thread-bar-text' ? words : null),
  };
  const undo = fitThreadHead(head);
  assert.equal(props.get('--thread-head-h'), '102px', 'the scroller starts under the full head');
  assert.equal(attrs.has('data-thread-head-tight'), false);
  scroller.scrollTop = 30;
  listeners.scroll();
  assert.equal(attrs.has('data-thread-head-tight'), true, 'scrolled: the head tightens');
  assert.equal(fades.length, 1, 'its words come up into the new layout');
  // 20 Nov 2026: a few pixels back over the line does not open it again.
  scroller.scrollTop = 20;
  listeners.scroll();
  scroller.scrollTop = 10;
  listeners.scroll();
  assert.equal(attrs.has('data-thread-head-tight'), true, 'still tight short of the top');
  assert.equal(fades.length, 1);
  scroller.scrollTop = 4;
  listeners.scroll();
  assert.equal(attrs.has('data-thread-head-tight'), false, 'back at the top: full again');
  assert.equal(fades.length, 2);
  scroller.scrollTop = 20;
  listeners.scroll();
  assert.equal(attrs.has('data-thread-head-tight'), false, 'and full until past the tighten line again');
  undo();
  assert.equal(props.has('--thread-head-h'), false);
  assert.deepEqual(Object.keys(listeners), [], 'the scroll listener goes with it');
  // Outside a thread page it touches nothing.
  height = 0;
  const noop = fitThreadHead({ closest: () => null, getBoundingClientRect: () => ({ height }) });
  assert.equal(typeof noop, 'function');
  // Both bars fit their head, only where they draw it (not under a frame look).
  for (const file of [CHANGE, REQUEST]) {
    const src = read(file);
    assert.match(src, /const head = useRef<HTMLElement>\(null\);\s+useThreadHeadFit\(head, !frame\);/);
    assert.match(src, /<header ref=\{head\} className="messages-thread-header">/);
  }
});

test('the head eases between its sizes and is measured only once it has settled (20 Nov 2026)', async () => {
  const at = CSS.indexOf('THE HEAD EASES (20 Nov 2026)');
  assert.ok(at > 0);
  const block = CSS.slice(at, at + 3000);
  assert.match(block, /#dev-topic-thread \.dev-request:has\(\.dev-thread-card\) \.dev-thread-bar-tile \{ transition: width 180ms ease, height 180ms ease, border-radius 180ms ease, font-size 180ms ease; \}/);
  assert.match(block, /\.dev-request:has\(\.dev-thread-card\) > \.dev-request-back \{ transition: top 180ms ease; \}/, 'the way back stays level with the tile');
  assert.match(CSS, /\.dev-request-bar > \.messages-thread-header \{ transition: border-radius 180ms ease, padding 180ms ease, box-shadow 180ms ease; \}/);

  const { fitThreadHead } = loadTsx('frontend/src/features/dev-board/topic/thread-head-fit.ts');
  const props = new Map();
  const scroller = { scrollTop: 0, addEventListener() {}, removeEventListener() {} };
  const page = {
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
    toggleAttribute() {},
    removeAttribute() {},
    querySelector: () => scroller,
  };
  let height = 78;
  let easing = [];
  const head = {
    closest: () => page,
    getBoundingClientRect: () => ({ height }),
    querySelector: () => null,
    getAnimations: () => easing,
  };
  const prevRO = globalThis.ResizeObserver;
  let observed = null;
  globalThis.ResizeObserver = class { constructor(fn) { observed = fn; } observe() {} disconnect() {} };
  try {
    const undo = fitThreadHead(head);
    assert.equal(props.get('--thread-head-h'), '78px');
    // Mid-ease: an in-between height is never written.
    let done;
    easing = [{ finished: new Promise((r) => { done = r; }) }];
    height = 64;
    observed();
    observed();
    assert.equal(props.get('--thread-head-h'), '78px', 'not while it eases');
    // Settled: measured once, at its own size.
    easing = [];
    height = 80;
    done();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(props.get('--thread-head-h'), '80px', 'measured once it has settled');
    undo();
  } finally {
    if (prevRO === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = prevRO;
  }
});

test('a private thread with the bot draws the same head: the lock line over its name in two lines, ⋯ the one disc', () => {
  const scope = 'html:is(:not([data-skin]), [data-skin="brand"]) #ai-screen .messages-layout[data-bot-threads] > .messages-reply-pane[data-bot-sheet]';
  const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(CSS, new RegExp(`${esc(scope)} > \\.messages-thread-header \\{\\s+flex: 0 0 auto;\\s+align-items: flex-start;\\s+gap: 12px;\\s+padding: 14px 12px 14px 16px;`));
  assert.match(CSS, new RegExp(`${esc(scope)} > \\.messages-thread-header \\[data-reply-avatar\\] > \\* \\{ width: 48px; height: 48px; \\}`), 'the face at the tile\'s size');
  assert.match(CSS, new RegExp(`${esc(scope)} > \\.messages-thread-header \\[data-private-thread-sub\\] \\{\\s+order: -1;`), 'the lock line is the small line over the name');
  assert.match(CSS, new RegExp(`${esc(scope)} > \\.messages-thread-header \\[data-reply-title\\] \\{\\s+display: -webkit-box;\\s+-webkit-box-orient: vertical;\\s+-webkit-line-clamp: 2;[^}]*font-size: 20px;\\s+line-height: 26px;`));
  assert.match(CSS, new RegExp(`${esc(scope)} > \\.messages-thread-header \\.messages-thread-action \\{[^}]*background: transparent;\\s+box-shadow: none;`));
  assert.match(CSS, new RegExp(`${esc(scope)} > \\.messages-thread-header :is\\(\\[data-private-thread-menu\\] > \\.messages-thread-action, \\.messages-thread-preview\\) \\{ box-shadow: inset 0 0 0 1px var\\(--app-sheet-line\\); \\}`));
  assert.match(CSS, new RegExp(`${esc(scope)} > \\.messages-thread-header > :is\\(\\[data-private-thread-menu\\], \\.messages-thread-preview\\) \\+ \\[data-reply-close\\]::before \\{`), 'a thin line before ×');
});
