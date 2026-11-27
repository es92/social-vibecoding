// #6810: a reply box that grows keeps the newest message above it.
//
// The composer sits below the transcript, so its height is the transcript's
// loss. The old measuring collapsed the box to one row on EVERY keystroke: for
// that instant the scroller was taller by the box's extra lines, a scroller at
// its bottom could not stay there (the browser pulled it back), and the height
// written back left the scroller the size it was — so the resize observer that
// follows a thread saw nothing, the scroll handler read the gap, and past
// THREAD_FOLLOW_PX the thread stopped following. One line was hidden at two
// lines of reply, two at three, and the newest message stayed covered.
//
// These tests drive the real measuring (frontend/src/lib/use-auto-grow.ts) and
// the group chat's composer (public/js/group-chat.js) against a fake scroller
// that clamps its scrollTop as a browser does and runs its resize observers
// and scroll events a frame at a time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const { fitToContent, onlyInserted, useAutoGrow } = loadTsx('frontend/src/lib/use-auto-grow.ts');

const LINE = 22; // one line of the composer
const CAP = 140; // GroupChat._COMPOSER_MAX_PX
const VIEWPORT = 600; // the column the transcript and the composer share

/** One composer line per newline: a stand-in for a real wrap. */
const countLines = (value) => Math.max(1, value.split('\n').length);

/**
 * A textarea that lays out like one: `height: auto` is one row. Every write to
 * its height and every `scrollHeight` read forces the layout (`onLayout`),
 * which is where a browser clamps a scroller its box change left too far down.
 */
function composer({ id = '' } = {}) {
  let value = '';
  let height = LINE;
  let auto = false;
  let writes = 0;
  const api = {
    onLayout: () => {},
    get height() { return height; },
    get writes() { return writes; },
  };
  const el = {
    id,
    style: {
      get height() { return auto ? 'auto' : `${height}px`; },
      set height(next) {
        writes += 1;
        if (next === 'auto') { auto = true; height = LINE; } else {
          auto = false;
          height = Number.parseFloat(next) || 0;
        }
        api.onLayout();
      },
    },
    get value() { return value; },
    set value(next) { value = String(next); },
    get scrollHeight() { api.onLayout(); return countLines(value) * LINE; },
    get clientHeight() { return height; },
  };
  return Object.assign(api, { el, set(next) { value = next; } });
}

/**
 * A transcript beside a composer. Its box is the column less the composer, and
 * it clamps `scrollTop` the way a browser does when its box changes size.
 * `frame()` runs what the browser does after a keystroke: clamp, then the
 * resize observers (which fire only when an observed size changed, as real
 * ones do), then the scroll events.
 */
function transcript(box, { content = 2000 } = {}) {
  let top = 0;
  let contentHeight = content;
  const scrolls = [];
  const observers = [];
  const sizeOf = (target) => `${target.clientHeight}:${target.scrollHeight}`;
  class ResizeObserver {
    constructor(fn) { this.fn = fn; this.sizes = new Map(); observers.push(this); }
    observe(target) { this.sizes.set(target, sizeOf(target)); }
  }
  const el = {
    id: 'gc-thread-scroll',
    children: [],
    get scrollHeight() { return contentHeight; },
    get clientHeight() { return VIEWPORT - box.height; },
    get scrollTop() {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (top > max) top = max;
      return top;
    },
    set scrollTop(next) {
      top = Math.max(0, Math.min(next, Math.max(0, el.scrollHeight - el.clientHeight)));
    },
    addEventListener(type, fn) { if (type === 'scroll') scrolls.push(fn); },
    scrollTo(at) { el.scrollTop = at; fireScroll(); },
    gap() { return el.scrollHeight - el.scrollTop - el.clientHeight; },
    grow(px) { contentHeight += px; },
  };
  const fireScroll = () => { for (const fn of scrolls) fn(); };
  // A layout while the composer is changing size clamps the scroller.
  box.onLayout = () => { void el.scrollTop; };
  let reported = 0;
  const frame = () => {
    void el.scrollTop; // the clamp a smaller box causes
    let resized = false;
    for (const observer of observers) {
      let changed = false;
      for (const [target, was] of observer.sizes) {
        const now = sizeOf(target);
        if (now === was) continue;
        observer.sizes.set(target, now);
        changed = true;
      }
      if (!changed) continue;
      resized = true;
      observer.fn();
    }
    if (resized || top !== reported) { reported = top; fireScroll(); }
  };
  return { el, frame, ResizeObserver, get top() { return top; } };
}

// ── The measuring itself ────────────────────────────────────────────────

test('#6810: a keystroke that does not wrap leaves the gap at 0', () => {
  const box = composer();
  const scroll = transcript(box);
  box.set('hello\nworld');
  fitToContent(box.el, box.el.value, { max: CAP, scroller: scroll.el });
  scroll.el.scrollTo(scroll.el.scrollHeight);
  assert.equal(scroll.el.gap(), 0, 'at its bottom beside a two-line composer');

  box.set('hello\nworldx');
  fitToContent(box.el, box.el.value, { max: CAP, scroller: scroll.el });
  scroll.frame();
  assert.equal(box.el.style.height, `${2 * LINE}px`);
  assert.equal(scroll.el.gap(), 0, 'still at its bottom');
});

test('#6810: a backspace that does not unwrap leaves the gap at 0', () => {
  const box = composer();
  const scroll = transcript(box);
  box.set('hello\nworld');
  fitToContent(box.el, box.el.value, { max: CAP, scroller: scroll.el });
  scroll.el.scrollTo(scroll.el.scrollHeight);
  const writes = box.writes;

  box.set('hello\nworl');
  fitToContent(box.el, box.el.value, { max: CAP, scroller: scroll.el });
  scroll.frame();
  assert.ok(box.writes > writes, 'a deletion still collapses and measures');
  assert.equal(box.el.style.height, `${2 * LINE}px`);
  assert.equal(scroll.el.gap(), 0, 'the collapse put the scroller back at its bottom');
});

test('#6810: the height never passes the cap, and nothing is written once there', () => {
  const box = composer();
  const scroll = transcript(box);
  let text = 'a';
  box.set(text);
  fitToContent(box.el, text, { max: CAP, scroller: scroll.el });
  scroll.el.scrollTo(scroll.el.scrollHeight);
  for (let i = 0; i < 12; i += 1) {
    text += '\nmore';
    box.set(text);
    fitToContent(box.el, text, { max: CAP, scroller: scroll.el });
    scroll.frame();
    assert.ok(Number.parseFloat(box.el.style.height) <= CAP, 'capped at 140px');
  }
  assert.equal(box.el.style.height, `${CAP}px`);
  // At the cap: one read, no write, so no layout and no scroll event.
  const writes = box.writes;
  box.set(`${text}\nand more`);
  fitToContent(box.el, box.el.value, { max: CAP, scroller: scroll.el });
  assert.equal(box.writes, writes, 'no write past the cap');
  assert.equal(box.el.style.height, `${CAP}px`);
});

test('#6810: a reader up in the history is not moved by a collapse', () => {
  const box = composer();
  const scroll = transcript(box);
  box.set('hello\nworld');
  fitToContent(box.el, box.el.value, { scroller: scroll.el });
  scroll.el.scrollTo(400);
  assert.ok(scroll.el.gap() > 1);

  box.set('hello\nworl');
  fitToContent(box.el, box.el.value, { scroller: scroll.el });
  assert.equal(scroll.top, 400, 'their place is kept');
});

test('the global the classic scripts read is the measuring above', () => {
  assert.equal(typeof useAutoGrow, 'function');
  assert.equal(onlyInserted('a', 'ab'), true);
  assert.equal(onlyInserted('ab', 'a'), false);
  const source = read('frontend/src/lib/use-auto-grow.ts');
  assert.match(source, /UsernodeAutoGrow/, 'published as a window global');
});

// ── A project chat's thread, in a sandbox ───────────────────────────────
//
// One message box (27 Nov 2026): a request's, a change's or a decision's
// thread box is Messages' own (features/group-chat/composer.tsx renders
// MessageBox with the thread's scroller), which measures through
// useAutoGrow, that is `fitToContent` with the scroller. The following is
// still the module's (`_attachThreadFollow`), so the two are driven together.

function bootGroupChat() {
  const input = composer({ id: 'gc-thread-input' });
  const scroll = transcript(input);
  const sandbox = {
    window: {},
    URLSearchParams,
    location: { search: '' },
    ResizeObserver: scroll.ResizeObserver,
    App: { user: { id: 7, username: 'evan' } },
    document: {
      getElementById: (id) => {
        if (id === 'gc-thread-scroll') return scroll.el;
        if (id === 'gc-thread-input') return input.el;
        return null;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc._attachThreadFollow(scroll.el);
  // The reader is at the newest line.
  scroll.el.scrollTo(scroll.el.scrollHeight);
  // What the box does on every change of its words.
  const grow = () => fitToContent(input.el, input.el.value, { scroller: scroll.el });
  return { gc, input, scroll, grow };
}

test('the thread box measures with its transcript\'s scroller', () => {
  assert.match(read('frontend/src/features/group-chat/composer.tsx'), /return <MessageBox place=\{place\} scroller=\{scroller\} \/>;/);
  assert.match(read('frontend/src/features/group-chat/thread-shell.tsx'), /<Composer \{\.\.\.props\} scroller=\{scroll\} \/>/);
  assert.match(read('frontend/src/features/messages/composer.tsx'), /useAutoGrow\(inputRef, value, scroller\);/);
});

test('#6810: typing a long reply leaves the thread following its newest line', () => {
  const h = bootGroupChat();
  assert.equal(h.gc._threadPinned, true, 'starts at the newest line');
  let text = 'the plan is right';
  h.input.set(text);
  h.grow();
  h.scroll.frame();
  for (let i = 0; i < 10; i += 1) {
    text += '\nand one more line';
    h.input.set(text);
    h.grow();
    h.scroll.frame();
    assert.equal(h.scroll.el.gap(), 0, `line ${i + 1}: the newest message stays above the box`);
    assert.equal(h.gc._threadPinned, true, `line ${i + 1}: still following`);
  }
  // A message that arrives while typing is still followed.
  h.scroll.el.grow(LINE * 3);
  h.scroll.frame();
  assert.equal(h.scroll.el.gap(), 0, 'the new message is followed');
});

test('#6810: a backspace in a thread keeps the newest message in view', () => {
  const h = bootGroupChat();
  h.input.set('one\ntwo\nthree');
  h.grow();
  h.scroll.frame();
  h.input.set('one\ntwo\nthre');
  h.grow();
  h.scroll.frame();
  assert.equal(h.scroll.el.gap(), 0);
  assert.equal(h.gc._threadPinned, true);
});
