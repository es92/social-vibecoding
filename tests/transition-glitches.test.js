'use strict';

// Things that JUMPED during a transition, found by recording the iOS
// Simulator frame by frame: not slow frames, but items landing in the wrong
// place for a moment and then correcting.
//
//   1. Opening a conversation: the transcript drew full height, then shrank
//      as the header and composer mounted when the detail request answered.
//   2. Closing Edit profile (and the staking sheet, and the illustration
//      editor): the card vanished on the spot and an empty rounded box faded
//      out where it had been.
//   3. Create app, full screen on a phone: with the keyboard up, Home showed
//      through the strip between the form and the keys.
//   4. An app opening: the "Opening…" cover lifted its icon and name when
//      its spinner appeared.
//   5. A field in a dialog: iOS scrolled the page to reveal it, under a
//      fixed dialog, and reported the scroll only once the keyboard had
//      finished moving, so the dialog dipped on the way up and was thrown
//      on the way down.
//
// The keyboard's own jumps are pinned beside the code they live in:
// tests/native-kit.test.js and tests/visual-viewport.test.js. Home's search
// bar gliding away is in tests/home-search-reveal.test.js.
//
// Run with: node --test tests/transition-glitches.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_CSS = read('public/css/app.css');

// ── 1. A conversation opens at its final shape ───────────────────────────

const GROUP = 7;
const LISTED = { id: GROUP, kind: 'group', title: 'Launch crew', membershipStatus: 'member', members: [], canSend: true };

function install({ detail = 'ok' } = {}) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  global.window = {
    location: { hash: '', search: '' },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 390,
    App: { user: { id: 1, username: 'me' } },
    Notifications: { markConversationRead() {}, markConversationThreadRead() {} },
  };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.fetch = async (url, init = {}) => {
    const address = String(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (init.method === 'POST') return json({});
    if (address === `/api/conversations/${GROUP}`) {
      await gate; // the detail answers only when the test says so
      return detail === 'ok'
        ? json({ conversation: { ...LISTED, title: 'Launch crew (detail)' } })
        : json({ error: 'Server error' }, 500);
    }
    if (address.startsWith(`/api/conversations/${GROUP}/messages?`)) return json({ messages: [], next_before: null });
    if (address.startsWith('/api/conversations')) return json({ conversations: [LISTED] });
    return json({ discussions: [] });
  };
  return { answer: () => release() };
}

function uninstall() {
  delete global.window;
  delete global.fetch;
  delete global.localStorage;
}

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };

function snapshotOf(store) {
  let snap = null;
  const Probe = () => { snap = store.useMessagesSnapshot(); return null; };
  renderToHtml(createElement(Probe));
  return snap;
}

test('a listed conversation is active from the first frame, and the detail replaces it', async () => {
  const { answer } = install();
  try {
    const store = loadTsx('frontend/src/features/messages/store.ts');
    await store.loadConversations(true);
    store.route(GROUP, null, null, {});
    await settle();
    let snap = snapshotOf(store);
    assert.equal(snap.loadingThread, true, 'the detail has not answered yet');
    assert.equal(snap.active?.id, GROUP, 'the inbox row stands in, so the header and composer draw now');
    assert.equal(snap.active?.title, 'Launch crew');
    answer();
    await settle();
    snap = snapshotOf(store);
    assert.equal(snap.loadingThread, false);
    assert.equal(snap.active?.title, 'Launch crew (detail)', 'the detail takes over when it lands');
  } finally {
    uninstall();
  }
});

test('a conversation that fails to load drops the stand-in: an error, no header', async () => {
  const { answer } = install({ detail: 'fail' });
  try {
    const store = loadTsx('frontend/src/features/messages/store.ts');
    await store.loadConversations(true);
    store.route(GROUP, null, null, {});
    await settle();
    assert.equal(snapshotOf(store).active?.id, GROUP);
    answer();
    await settle();
    const snap = snapshotOf(store);
    assert.equal(snap.active, null);
    assert.ok(snap.threadError, 'the failure is said');
  } finally {
    uninstall();
  }
});

// ── 2. A closing surface animates its contents, not an empty box ─────────

// Just enough DOM for adoptKitSurface: nodes that clone, move and carry
// attributes. The element classes are the constructors `leaveSnapshot`
// checks with instanceof.
class Node {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName;
    this.attrs = { ...attrs };
    this.children = [];
    this.parentNode = null;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    };
  }
  cloneNode(deep) {
    const copy = new this.constructor(this.tagName, this.attrs);
    if (deep) this.children.forEach((child) => copy.appendChild(child.cloneNode(true)));
    return copy;
  }
  detach() { if (this.parentNode) this.parentNode.removeChild(this); }
  appendChild(node) { node.detach(); node.parentNode = this; this.children.push(node); return node; }
  insertBefore(node, ref) {
    node.detach();
    node.parentNode = this;
    const at = this.children.indexOf(ref);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    return node;
  }
  removeChild(node) {
    const at = this.children.indexOf(node);
    if (at >= 0) this.children.splice(at, 1);
    node.parentNode = null;
    return node;
  }
  replaceChild(node, old) {
    node.detach();
    const at = this.children.indexOf(old);
    this.children[at] = node;
    node.parentNode = this;
    old.parentNode = null;
    return old;
  }
  querySelectorAll(selector) {
    assert.equal(selector, '*');
    const out = [];
    const walk = (el) => el.children.forEach((child) => { out.push(child); walk(child); });
    walk(this);
    return out;
  }
  contains(node) {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
}
class TextArea extends Node {
  constructor(tagName, attrs) { super(tagName, attrs); this.value = ''; }
}
class Frame extends Node {}

function kitHarness() {
  const log = [];
  const root = new Node('DIV', { id: 'profile-edit-root' });
  const card = root.appendChild(new Node('DIV', { id: 'profile-edit-panel' }));
  const bio = card.appendChild(new TextArea('TEXTAREA', { id: 'profile-bio', name: 'bio', autofocus: '' }));
  bio.value = 'hi';
  const frame = card.appendChild(new Frame('IFRAME', { src: 'https://app.example/' }));
  const shell = new Node('DIV', { class: 'un-modal' });
  global.document = {
    activeElement: null,
    createComment: (label) => new Node('#comment', { label }),
  };
  global.HTMLTextAreaElement = TextArea;
  global.HTMLIFrameElement = Frame;
  global.HTMLSelectElement = class {};
  global.HTMLCanvasElement = class {};
  global.PlatformUI = {
    isTouch: () => true,
    hasKit: () => true,
    modal: (opts) => {
      shell.appendChild(opts.contentEl);
      return {
        el: shell,
        dismiss: () => log.push({ dismissed: true, shellChildren: [...shell.children] }),
      };
    },
  };
  return { log, root, card, bio, frame, shell };
}

function kitTeardown() {
  for (const name of ['document', 'HTMLTextAreaElement', 'HTMLIFrameElement', 'HTMLSelectElement', 'HTMLCanvasElement', 'PlatformUI']) {
    delete global[name];
  }
}

test('release(): the card goes home now, and an inert copy plays the exit', () => {
  const h = kitHarness();
  try {
    const { adoptKitSurface } = loadTsx('frontend/src/lib/kit-surface.ts');
    const adoption = adoptKitSurface({ kind: 'modal', contentEl: h.card, adoptedOn: h.root, home: 'placeholder', gate: 'kit' });
    assert.equal(h.card.parentNode, h.shell, 'presented: the kit holds the card');

    adoption.release();

    assert.equal(h.card.parentNode, h.root, 'home before React removes the tree around it');
    assert.equal(h.root.classList.contains('platform-modal-adopted'), false);
    assert.equal(h.log.length, 1, 'the kit is told once');
    const [copy] = h.log[0].shellChildren;
    assert.ok(copy && copy !== h.card, 'the kit exits over a copy, not an empty shell');
    assert.equal(copy.attrs.inert, '');
    assert.equal(copy.attrs['aria-hidden'], 'true');
    assert.equal(copy.hasAttribute('id'), false, 'no second #profile-edit-panel for getElementById to find');
    const [bioCopy, frameCopy] = copy.children;
    assert.equal(bioCopy.value, 'hi', 'what the viewer last saw, typed text included');
    assert.equal(bioCopy.hasAttribute('name'), false, 'a copied field joins no form');
    assert.equal(bioCopy.hasAttribute('autofocus'), false);
    assert.equal(frameCopy.hasAttribute('src'), false, 'a copied frame loads nothing');
  } finally {
    kitTeardown();
  }
});

test('release() after the node is already home leaves nothing behind', () => {
  const h = kitHarness();
  try {
    const { adoptKitSurface } = loadTsx('frontend/src/lib/kit-surface.ts');
    const adoption = adoptKitSurface({ kind: 'modal', contentEl: h.card, adoptedOn: h.root, home: 'placeholder', gate: 'kit' });
    adoption.restore();
    adoption.release();
    assert.deepEqual(h.log[0].shellChildren, [], 'no copy of a card that already left');
    assert.equal(h.card.parentNode, h.root);
  } finally {
    kitTeardown();
  }
});

test('the three unmounting surfaces close with release(); the dialogs keep dismiss-only', () => {
  for (const file of [
    'frontend/src/features/profile/profile-edit-sheet.tsx',
    'frontend/src/features/profile/staking-sheet.tsx',
    'frontend/src/features/apps/featured-illustration-editor.tsx',
  ]) {
    const src = read(file);
    assert.match(src, /\.release\(\);/, `${file} releases`);
    assert.doesNotMatch(src, /\.restore\(\);\s*(adoption|handle)\.dismiss\(\);/, `${file} no longer empties the shell before its exit`);
  }
  // useStaticModal's ordinary close stays dismiss-only: its card is put home
  // by onDismiss at the END of the exit (static-modal.ts, "THE CARD RIDES
  // THE EXIT").
  const staticModal = read('frontend/src/lib/static-modal.ts');
  assert.match(staticModal, /pendingExitRef\.current = adoption;\s*adoption\.dismiss\(\);/);
});

// ── 3. Full-screen Create app has nothing behind it ──────────────────────

// The create dialog's full-screen layouts (an opaque backdrop, no lift
// shadow, the status bar's band as a border) are retired with it. Create
// opens "What do you want to make?", which is its own full-screen surface
// on the wallpaper (tests/first-session-make.test.js pins its bar and the
// status bar's inset).
test('Create\'s screen covers the whole page in its own ground, and the dialog\'s layouts are gone', () => {
  const make = read('frontend/src/features/first-session/make.tsx');
  assert.match(make, /className="platform-kb-surface fixed inset-0 z-\[9000\] flex flex-col /);
  assert.match(make, /style=\{\{ background: 'var\(--home-wallpaper, #f4f2e4\)' \}\}/);
  assert.doesNotMatch(APP_CSS, /#create-card|--create-modal-/);
});

// ── 4. The launch cover holds room for its spinner ───────────────────────

test('the launch spinner keeps its box while hidden, so the cover does not lift at 500ms', () => {
  const rule = /\.app-launch-cover-spinner\.hidden \{\s*display: block;\s*visibility: hidden;\s*animation: none;\s*\}/;
  assert.match(APP_CSS, rule);
  // Both renderers start it hidden, and reveal it by dropping the class.
  assert.match(read('public/js/app-view.js'), /class="dc-status-spinner-arc app-launch-cover-spinner hidden"/);
  assert.match(read('frontend/src/features/app-frame/app-frame.tsx'), /'dc-status-spinner-arc app-launch-cover-spinner hidden'/);
});

// ── 5. A modal's field takes focus without the page pan ──────────────────
//
// The kit's own code, run in a vm: the section from MODAL_SETTLE_MS to
// presentModal, with the pure helpers it calls taken from the kit's node
// export.

const vm = require('node:vm');
const NATIVE_JS = read('public/usernode-native/v1/native.js');
const { physics } = require('../public/usernode-native/v1/native.js');

function modalFocusHarness() {
  const start = NATIVE_JS.indexOf('  var MODAL_SETTLE_MS');
  const end = NATIVE_JS.indexOf('  // presentModal(', start);
  assert.ok(start > 0 && end > start, 'the modal field focus section exists');
  const listeners = {};
  const scrolls = [];
  const card = {
    nodeType: 1,
    scrollTop: 0, scrollHeight: 900, clientHeight: 345,
    contains: (el) => el === field || el === card,
    getBoundingClientRect: () => ({ top: 16, bottom: 361 }),
    addEventListener: (type, fn, opts) => { listeners[type] = { fn, opts }; },
    removeEventListener: (type) => { delete listeners[type]; },
    scrollTo: (opts) => { scrolls.push({ top: opts.top, behavior: opts.behavior }); },
  };
  const focusCalls = [];
  const field = {
    nodeType: 1, tagName: 'TEXTAREA', type: 'textarea',
    closest: () => field,
    focus: (opts) => { focusCalls.push(opts); ctx.document.activeElement = field; },
    getBoundingClientRect: () => ({ top: 420, bottom: 560 }),
  };
  const timers = [];
  const frames = [];
  const ctx = vm.createContext({
    window: { visualViewport: {} },
    document: { activeElement: null },
    platform: 'ios',
    prefersReducedMotion: false,
    kbInset: 0,
    kbWatchers: [],
    KB_TAP_SLOP: 8,
    gestures: { owner: () => null },
    isTextEntryField: physics.isTextEntryField,
    revealScrollDelta: physics.revealScrollDelta,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
    requestAnimationFrame: (fn) => { frames.push(fn); },
  });
  vm.runInContext(NATIVE_JS.slice(start, end), ctx);
  const detach = ctx.attachModalFieldFocus(card);
  const tap = (target = field, { move = 0 } = {}) => {
    let prevented = false;
    listeners.touchstart.fn({ touches: [{ clientX: 100, clientY: 450 }] });
    if (move) listeners.touchmove.fn({ touches: [{ clientX: 100, clientY: 450 + move }] });
    listeners.touchend.fn({ target, touches: [], cancelable: true, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { ctx, card, field, listeners, focusCalls, scrolls, timers, frames, tap, detach };
}

test('a tap on a modal field focuses it with preventScroll, and the native reveal is taken', () => {
  const h = modalFocusHarness();
  assert.equal(h.listeners.touchend.opts.passive, false, 'non-passive, for exactly this preventDefault');
  assert.equal(h.tap(), true, 'the click, native focus and native reveal are cancelled');
  assert.equal(h.focusCalls.length, 1);
  assert.equal(h.focusCalls[0].preventScroll, true, 'so iOS has nothing to pan the page for');
});

test('the field is revealed inside the card once the card has its keyboard height', () => {
  const h = modalFocusHarness();
  h.tap();
  assert.equal(h.ctx.kbWatchers.length, 1, 'waiting for the inset');
  h.ctx.kbInset = 337;
  h.ctx.kbWatchers.slice().forEach((fn) => fn(337));
  assert.equal(h.ctx.kbWatchers.length, 0, 'one inset is enough');
  const settle = h.timers.find((t) => t.ms === 280);
  assert.ok(settle, 'after the card\'s 250ms ease');
  settle.fn();
  // Card 16–361, margin 12: the field's bottom (560) is 211px below 349.
  assert.equal(h.scrolls.length, 1);
  assert.equal(h.scrolls[0].top, 211);
  assert.equal(h.scrolls[0].behavior, 'smooth');
});

test('the focused field, a drag, and anything but a text field keep native behaviour', () => {
  const h = modalFocusHarness();
  assert.equal(h.tap(h.field, { move: 20 }), false, 'a drag that ends on a field scrolls, it is not a tap');
  const button = { nodeType: 1, tagName: 'BUTTON', closest: () => null };
  assert.equal(h.tap(button), false, 'a button is untouched');
  h.tap();
  h.ctx.kbInset = 337;
  assert.equal(h.tap(), false, 'a field with its keyboard up keeps its native caret and selection');
});

test('a field focused from code has its first tap taken too, once', () => {
  // A dialog that focuses its first field: iOS raises the keyboard on the
  // tap, not the focus, and pans the page to the field as it does.
  const h = modalFocusHarness();
  let blurred = 0;
  h.field.blur = () => { blurred += 1; };
  h.ctx.document.activeElement = h.field;
  assert.equal(h.tap(), true, 'refocused inside the tap, without the scroll');
  assert.equal(blurred, 1);
  assert.equal(h.focusCalls[0].preventScroll, true);
  // A hardware keyboard reports no inset: every later tap places the caret.
  assert.equal(h.tap(), false);
  assert.equal(blurred, 1);
});

test('dismiss detaches the listeners and any wait for the inset', () => {
  const h = modalFocusHarness();
  h.tap();
  h.detach();
  assert.equal(h.ctx.kbWatchers.length, 0);
  assert.equal(h.listeners.touchend, undefined);
  assert.match(NATIVE_JS, /var detachFieldFocus = attachModalFieldFocus\(card\);/);
  assert.match(NATIVE_JS, /closed = true;\s*detachFieldFocus\(\);/);
});
