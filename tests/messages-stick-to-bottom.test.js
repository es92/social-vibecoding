'use strict';
// #3757: "sometimes I'm at the bottom of my chat with homeroom bot dm, I send
// a message, and I don't realize it has a new message because it doesn't
// autoscroll down to the new message, even when I'm at / basically at the
// bottom of the chat."
//
// The conversation decided whether to follow a new message by measuring its
// distance from the bottom AFTER the message was drawn, against 180px. A bot
// reply of a few paragraphs is taller than that on its own, so a reader who
// was exactly at the bottom read as scrolled up and stayed put; and nothing
// followed what grew after the draw (images, link cards, the bot's activity
// cards updating in place).
//
// Three parts:
//   1. isNearBottom, the allowance;
//   2. frontend/src/features/messages/stick-to-bottom.ts, executed against a
//      fake scroller and fake observers: the reply that broke it, late
//      growth, a reader up in history, a linked window; and the hook's
//      lifecycle against a stubbed React;
//   3. the conversation uses it: it decides on where the reader WAS, not on
//      a measurement taken after the draw.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const MODULE = 'frontend/src/features/messages/stick-to-bottom.ts';
const THREAD = fs.readFileSync(path.join(ROOT, 'frontend/src/features/messages/index.tsx'), 'utf8');

// A scroll container as far as the module reads one. scrollTop clamps to the
// content, as a browser's does; `scroll()` is a scroll event.
function fakeScroller({ scrollHeight, clientHeight, scrollTop }) {
  const listeners = new Map();
  let top = scrollTop;
  return {
    nodeType: 1,
    scrollHeight,
    clientHeight,
    children: [],
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn)); },
    listenerCount(type) { return (listeners.get(type) || []).length; },
    scroll() { for (const fn of listeners.get('scroll') || []) fn(); },
  };
}

function fakeObservers() {
  const sizes = { callback: null, observed: new Set(), options: new Map(), disconnected: 0 };
  const rows = { callback: null, target: null, options: null, disconnected: 0 };
  class ResizeObserver {
    constructor(callback) { sizes.callback = callback; }
    observe(target, options) { sizes.observed.add(target); sizes.options.set(target, options); }
    unobserve(target) { sizes.observed.delete(target); }
    disconnect() { sizes.disconnected += 1; sizes.observed.clear(); }
  }
  class MutationObserver {
    constructor(callback) { rows.callback = callback; }
    observe(target, options) { rows.target = target; rows.options = options; }
    disconnect() { rows.disconnected += 1; }
  }
  return { env: { ResizeObserver, MutationObserver }, sizes, rows };
}

// ── 1. The allowance ────────────────────────────────────────────────────

test('isNearBottom: at the bottom, or within about two lines of it', () => {
  const { isNearBottom, STICK_SLACK_PX } = loadTsx(MODULE);
  assert.equal(STICK_SLACK_PX, 120);
  const at = (scrollTop) => isNearBottom({ scrollHeight: 2000, clientHeight: 600, scrollTop });
  assert.equal(at(1400), true, 'exactly at the bottom');
  assert.equal(at(1340), true, 'basically at the bottom');
  assert.equal(at(1280), true, 'the edge of the allowance');
  assert.equal(at(1279), false, 'past it');
  assert.equal(at(600), false, 'reading history');
  assert.equal(isNearBottom({ scrollHeight: 300, clientHeight: 600, scrollTop: 0 }), true, 'nothing to scroll');
  assert.equal(isNearBottom({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1300 }, 40), false, 'a slack of its own');
});

// ── 1b. #5019: the allowance at the top ─────────────────────────────────

test('isNearTop: at the top, or within the load-older allowance of it', () => {
  const { isNearTop, LOAD_OLDER_SLACK_PX } = loadTsx(MODULE);
  assert.equal(LOAD_OLDER_SLACK_PX, 200);
  const at = (scrollTop) => isNearTop({ scrollHeight: 2000, clientHeight: 600, scrollTop });
  assert.equal(at(0), true, 'exactly at the top');
  assert.equal(at(200), true, 'the edge of the allowance');
  assert.equal(at(201), false, 'past it');
  assert.equal(at(1400), false, 'reading the middle');
  assert.equal(isNearTop({ scrollHeight: 2000, clientHeight: 600, scrollTop: 100 }, 40), false, 'a slack of its own');
});

test('needsMoreHistory: whether what is drawn fills the scroller', () => {
  const { needsMoreHistory } = loadTsx(MODULE);
  const at = (scrollHeight) => needsMoreHistory({ scrollHeight, clientHeight: 600, scrollTop: 0 });
  assert.equal(at(600), true, 'exactly one screen: nothing to scroll');
  assert.equal(at(750), true, 'within the allowance');
  assert.equal(at(801), false, 'a full screen plus the allowance');
  assert.equal(at(2000), false, 'a long thread');
  assert.equal(needsMoreHistory({ scrollHeight: 750, clientHeight: 600, scrollTop: 0 }, 40), false, 'a slack of its own');
});

// ── 2. The module, executed ─────────────────────────────────────────────

test('a tall reply that lands while the reader is at the bottom is followed', () => {
  const { attachStickToBottom, isNearBottom } = loadTsx(MODULE);
  const { env, sizes } = fakeObservers();
  const el = fakeScroller({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 });
  const pinned = { current: false };
  attachStickToBottom(el, pinned, { current: true }, env);
  el.scroll(); // the reader's own scroll, at the bottom
  assert.equal(pinned.current, true);

  // The bot's reply is drawn: 640px of paragraphs and suggested answers.
  el.scrollHeight += 640;
  assert.equal(isNearBottom(el), false,
    'measured after the draw, the reader looks scrolled up: the check that left them there');
  assert.equal(pinned.current, true, 'where they were before it arrived is what counts');
  sizes.callback();
  assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight, 'the newest line is in view');

  // The reply's activity card fills in after the draw.
  el.scrollHeight += 90;
  sizes.callback();
  assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight, 'late growth is followed too');
});

test('a reader basically at the bottom is followed; one reading history is not moved', () => {
  const { attachStickToBottom } = loadTsx(MODULE);
  const { env, sizes } = fakeObservers();
  const el = fakeScroller({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1350 });
  const pinned = { current: false };
  attachStickToBottom(el, pinned, { current: true }, env);
  el.scroll();
  assert.equal(pinned.current, true, '50px short of the bottom is at the bottom');
  el.scrollHeight += 300;
  sizes.callback();
  assert.equal(el.scrollTop, 1700);

  el.scrollTop = 900; // up to read something
  el.scroll();
  assert.equal(pinned.current, false);
  el.scrollHeight += 640;
  sizes.callback();
  assert.equal(el.scrollTop, 900, 'never yanked down');

  el.scrollTop = el.scrollHeight; // back down
  el.scroll();
  assert.equal(pinned.current, true, 'and followed again once back at the bottom');
});

test('the foot of a linked window is not the present: nothing follows it', () => {
  const { attachStickToBottom } = loadTsx(MODULE);
  const { env, sizes } = fakeObservers();
  const el = fakeScroller({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 });
  const pinned = { current: true };
  const atPresent = { current: false };
  attachStickToBottom(el, pinned, atPresent, env);
  el.scroll();
  assert.equal(pinned.current, false);
  el.scrollHeight += 800; // "Load newer messages"
  sizes.callback();
  assert.equal(el.scrollTop, 1400, 'the reader reads on from where the page ended');
  atPresent.current = true;
  el.scrollTop = el.scrollHeight;
  el.scroll();
  assert.equal(pinned.current, true);
});

test('every row is watched for size, as rows come and go, and the scroller itself', () => {
  const { attachStickToBottom } = loadTsx(MODULE);
  const { env, sizes, rows } = fakeObservers();
  const el = fakeScroller({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 });
  const first = { nodeType: 1 };
  const second = { nodeType: 1 };
  el.children = [first, second];
  const detach = attachStickToBottom(el, { current: true }, { current: true }, env);
  assert.ok(sizes.observed.has(el), 'the composer or the keyboard taking height');
  assert.ok(sizes.observed.has(first) && sizes.observed.has(second));
  assert.deepEqual(sizes.options.get(first), { box: 'border-box' }, 'a row\'s padding growing counts too');
  assert.equal(rows.target, el);
  assert.deepEqual(rows.options, { childList: true });
  const reply = { nodeType: 1 };
  const text = { nodeType: 3 };
  rows.callback([{ addedNodes: [reply, text], removedNodes: [first] }]);
  assert.ok(sizes.observed.has(reply), 'a new row is watched');
  assert.ok(!sizes.observed.has(text), 'text is not an element');
  assert.ok(!sizes.observed.has(first), 'a removed row is let go');
  assert.equal(el.listenerCount('scroll'), 1);
  detach();
  assert.equal(el.listenerCount('scroll'), 0);
  assert.equal(sizes.disconnected, 1);
  assert.equal(rows.disconnected, 1);
});

test('without ResizeObserver it still tracks the reader, and attaches nothing else', () => {
  const { attachStickToBottom } = loadTsx(MODULE);
  const el = fakeScroller({ scrollHeight: 2000, clientHeight: 600, scrollTop: 200 });
  const pinned = { current: true };
  const detach = attachStickToBottom(el, pinned, { current: true }, {});
  el.scroll();
  assert.equal(pinned.current, false);
  assert.doesNotThrow(detach);
});

// Just enough React for one hook: refs that persist across renders, effects
// run after a "commit" when their deps change, cleanups on change and unmount.
function fakeReact() {
  let slots = [];
  let i = 0;
  const pending = [];
  const effect = (fn, deps) => {
    const k = i++;
    const prev = slots[k];
    const changed = !prev || !deps || !prev.deps || deps.some((d, j) => d !== prev.deps[j]);
    if (!prev) slots[k] = { deps, cleanup: null };
    if (changed) pending.push(() => {
      if (slots[k].cleanup) slots[k].cleanup();
      slots[k].deps = deps;
      const c = fn();
      slots[k].cleanup = typeof c === 'function' ? c : null;
    });
  };
  const React = {
    useRef(init) {
      const k = i++;
      if (!slots[k]) slots[k] = { current: init };
      return slots[k];
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
  return {
    React,
    render(hook) { i = 0; const out = hook(); pending.splice(0).forEach((run) => run()); return out; },
    unmount() { slots.forEach((s) => s && s.cleanup && s.cleanup()); slots = []; },
  };
}

test('useStickToBottom follows the scroller React draws, and the present with it', () => {
  const r = fakeReact();
  const { useStickToBottom } = loadTsx(MODULE, { stubs: { react: r.React } });
  const ref = { current: null };
  let present = true;
  const use = () => useStickToBottom(ref, present);
  const pinned = r.render(use); // no conversation yet
  assert.equal(pinned.current, true, 'a conversation opens on its newest line');
  const first = fakeScroller({ scrollHeight: 2000, clientHeight: 600, scrollTop: 0 });
  ref.current = first;
  r.render(use);
  assert.equal(first.listenerCount('scroll'), 1);
  r.render(use);
  assert.equal(first.listenerCount('scroll'), 1, 'no re-attach while the node is the same');
  first.scroll();
  assert.equal(pinned.current, false);
  first.scrollTop = 1400;
  present = false; // a linked window
  r.render(use);
  first.scroll();
  assert.equal(pinned.current, false, 'the hook passes the present through');
  present = true;
  r.render(use);
  first.scroll();
  assert.equal(pinned.current, true);
  const second = fakeScroller({ scrollHeight: 900, clientHeight: 600, scrollTop: 0 });
  ref.current = second;
  r.render(use);
  assert.equal(first.listenerCount('scroll'), 0, 'the old node is let go');
  assert.equal(second.listenerCount('scroll'), 1);
  r.unmount();
  assert.equal(second.listenerCount('scroll'), 0, 'unmount detaches');
});

// ── 3. The conversation uses it ─────────────────────────────────────────

test('the conversation follows a reader who was at the bottom before the message arrived', () => {
  assert.match(THREAD, /import \{ centreInScroller, isNearTop, needsMoreHistory, useStickToBottom \} from '\.\/stick-to-bottom';/);
  assert.match(THREAD, /const pinned = useStickToBottom\(scroller, !snap\.nextAfter\);/,
    'the thread scroller is watched, and a linked window is not the present');
  assert.match(THREAD, /if \(previousLast\.current === null \|\| sentNow \|\| pinned\.current\) \{\s*(?:\/\/[^\n]*\n\s*)*pinned\.current = sentNow \|\| !snap\.nextAfter;\s*el\.scrollTop = el\.scrollHeight;/,
    'the first draw, a send from a linked window, or a reader who was at the bottom');
  assert.doesNotMatch(THREAD, /el\.scrollHeight - el\.scrollTop - el\.clientHeight\) < 180/,
    'no distance measured after the new rows are drawn');
  // Decided in a layout effect: before paint, and before a scroll event can
  // report the grown content.
  assert.match(THREAD, /useIsomorphicLayoutEffect\(\(\) => \{\s*const el = scroller\.current;\s*const lastMessage = snap\.messages\.at\(-1\);/);
  assert.match(THREAD, /previousLast\.current = null; initialScroll\.current = null; pinned\.current = true;/,
    'another conversation opens at its newest line');
  assert.match(THREAD, /shownFocus\.current = focusId;\s*previousLast\.current = last;\s*pinned\.current = false;/,
    'a message link lands on its message, and late growth does not take it to the bottom');
  assert.equal(message('messages:thread.jumpToPresent'), 'Jump to present');
  assert.match(THREAD, /onClick=\{\(\) => \{ pinned\.current = true; jumpToPresent\(\); \}\}>\{t\('messages:thread\.jumpToPresent'\)\}</);
});

// ── 4. #4511: your own send follows you only from the bottom ────────────

test('#4511: the reader\'s own send moves them only when they were at the bottom, or in a linked window', () => {
  assert.match(THREAD, /const sentNow = !!lastMessage\?\.pending && last !== previousLast\.current && fromWindow;/,
    'a send while scrolled up in the present no longer jumps');
  assert.match(THREAD, /const fromWindow = wasWindow\.current \|\| !!snap\.nextAfter;\s*wasWindow\.current = !!snap\.nextAfter;/,
    'store.send takes a linked window to the present, and that send opens at the newest line');
  assert.match(THREAD, /pinned\.current = true; wasWindow\.current = false;/, 'another conversation starts afresh');
});

test('#4511/#4513: a Messages reply thread follows only a pinned reader, and holds the bottom as the composer grows', () => {
  const panel = THREAD.slice(THREAD.indexOf('function ReplyThreadPanel('), THREAD.indexOf('function AppReplyThreadPanel('));
  assert.ok(panel.length > 1000);
  assert.match(panel, /const pinned = useStickToBottom\(scroller, true\);/);
  assert.match(panel, /useIsomorphicLayoutEffect\(\(\) => \{ pinned\.current = true; \}, \[conversationId, rootId\]\);/,
    'a thread opens at its newest reply');
  assert.match(panel, /if \(el && n !== count\.current && pinned\.current\) el\.scrollTop = el\.scrollHeight;/);
  assert.doesNotMatch(panel, /requestAnimationFrame\(\(\) => \{ el\.scrollTop = el\.scrollHeight; \}\)/,
    'no unconditional jump on every reply');
});

test('B19 follow-up: a reply thread opens at its first unread reply, with the New line, else at its newest', () => {
  const panel = THREAD.slice(THREAD.indexOf('function ReplyThreadPanel('), THREAD.indexOf('function AppReplyThreadPanel('));
  // Where it opens: the conversation's own rule, on the thread's first unread reply.
  assert.match(panel, /const firstUnread = thread && !thread\.loading \? thread\.firstUnreadId \?\? null : null;/);
  assert.match(panel, /const opening = openingScrollTop\(\{ lineTop: lineTopIn\(el, line\), scrollHeight: el\.scrollHeight, clientHeight: el\.clientHeight \}\);\s*el\.scrollTop = opening\.top;\s*pinned\.current = opening\.pinned;/);
  // Once per open, and never over a message the thread was opened at.
  assert.match(panel, /if \(!el \|\| !thread \|\| thread\.loading \|\| openedAt\.current === key\) return;/);
  assert.match(panel, /if \(!firstUnread \|\| !line \|\| snap\.threadFocusId \|\| snap\.route\.focusMessageId\) return;/,
    'nothing unread: it stays at its newest reply');
  // The New line, once, above that reply.
  assert.match(panel, /const line = firstUnread && message\.id === firstUnread\s*\? <NewMessagesDivider key="unread-line" ref=\{unreadLine\} \/> : null;/);
  // The opening effect runs after the one that follows new replies to the bottom.
  assert.ok(panel.indexOf('el.scrollTop = el.scrollHeight;') < panel.indexOf('el.scrollTop = opening.top;'));
  // Taken from the first page, and kept through a re-read while it is open.
  const store = fs.readFileSync(path.join(__dirname, '../frontend/src/features/messages/store.ts'), 'utf8');
  assert.match(store, /firstUnreadId: same && current && current\.firstUnreadId !== undefined \? current\.firstUnreadId : page\.firstUnreadId,/);
  const api = fs.readFileSync(path.join(__dirname, '../frontend/src/features/messages/api.ts'), 'utf8');
  assert.match(api, /firstUnreadId: strictId\(pick\(record\(pick\(data, 'read'\)\), 'firstUnreadId', 'first_unread_id'\)\),/);
});

// ── 5. #5050: a message link moves its own scroller, never the screen ───

test('#5050: centreInScroller centres a row by scrolling its scroller alone, clamped to the content', () => {
  const { centreInScroller } = loadTsx(MODULE);
  // The transcript: 600px tall, 2000px of rows, its top 100px down the page.
  const scroller = (scrollTop) => {
    const calls = [];
    return {
      calls, scrollTop, scrollHeight: 2000, clientHeight: 600,
      getBoundingClientRect: () => ({ top: 100, height: 600 }),
      scrollTo: (options) => calls.push(options),
    };
  };
  const row = (top) => ({ getBoundingClientRect: () => ({ top, height: 80 }) });

  const middle = scroller(400);
  centreInScroller(middle, row(600));
  assert.deepEqual(middle.calls, [{ top: 640, behavior: 'auto' }], 'row 900px into the content, centred: 900 - (600 - 80) / 2');

  const last = scroller(1400);
  centreInScroller(last, row(620), 'smooth');
  assert.deepEqual(last.calls, [{ top: 1400, behavior: 'smooth' }],
    'a row near the bottom cannot be centred: the scroller stops at its end, and nothing else is asked to make up the rest');

  const first = scroller(0);
  centreInScroller(first, row(110));
  assert.deepEqual(first.calls, [{ top: 0, behavior: 'auto' }], 'nor above its start');
});

test('#5050: Messages centres a linked message in its own scroller, never with scrollIntoView', () => {
  const REF_CARDS = fs.readFileSync(path.join(ROOT, 'frontend/src/features/messages/ref-cards.tsx'), 'utf8');
  assert.doesNotMatch(THREAD, /scrollIntoView\(\{ block: 'center' \}\)/,
    'scrollIntoView scrolls #messages-screen too, which left the layout 85px up');
  assert.equal(THREAD.match(/requestAnimationFrame\(\(\) => centreInScroller\(el, row\)\);/g).length, 2,
    'the conversation and the reply thread each centre in their own scroller');
  assert.match(REF_CARDS, /const scroller = card\.closest<HTMLElement>\('\.messages-thread-scroll'\);\s*if \(scroller\) centreInScroller\(scroller, card, still \? 'auto' : 'smooth'\);/);
  assert.doesNotMatch(REF_CARDS, /block: 'center'/);
});
