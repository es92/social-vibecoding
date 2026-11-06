const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const { createBrowserScroll, allowsPageScroll, pageScroller, strandedPan, textFocused, panOffset, MOBILE_PAGE_QUERY } =
  loadTsx('frontend/src/lib/browser-scroll.ts');

function fixture() {
  const elements = {};
  const add = (id, hidden = false) => {
    const el = { id, hidden, scrollTop: 0, dataset: {},
      classList: { contains: (name) => name === 'hidden' && el.hidden } };
    return (elements[id] = el);
  };
  const html = { scrollTop: 0, dataset: {}, classList: { contains: () => false } };
  const doc = { documentElement: html, scrollingElement: html, getElementById: (id) => elements[id] || null };
  const win = { navigator: {}, history: { scrollRestoration: 'auto' }, mobile: true, standalone: false, dispatchEvent() {},
    // A live `matches`, as a real MediaQueryList's is: the module keeps the
    // list it was handed and reads it again on every sync.
    matchMedia(q) {
      win.lists += 1;
      return { get matches() { return q === MOBILE_PAGE_QUERY ? win.mobile : win.standalone; } };
    },
    lists: 0 };
  win.self = win.top = win;
  const controller = createBrowserScroll(doc, win);
  const scroll = (top) => { html.scrollTop = top; controller.onScroll({ target: doc }); };
  return { add, doc, win, html, controller, scroll };
}

test('mobile browser pages use the document; native, installed, desktop and embedded shells do not', () => {
  const { doc, win } = fixture();
  assert.equal(allowsPageScroll(win, doc), true);
  win.mobile = false;
  assert.equal(allowsPageScroll(win, doc), false);
  win.mobile = true;
  win.standalone = true;
  assert.equal(allowsPageScroll(win, doc), false);
  win.standalone = false;
  win.navigator.standalone = true;
  assert.equal(allowsPageScroll(win, doc), false);
  win.navigator.standalone = false;
  win.top = {};
  assert.equal(allowsPageScroll(win, doc), false);
  win.top = win;
  doc.documentElement.classList.contains = (name) => name === 'in-native-webview';
  assert.equal(allowsPageScroll(win, doc), false);
});

test('screen positions survive navigation even when hiding a page clamps document scroll', () => {
  const { add, doc, html, controller, scroll } = fixture();
  const home = add('home-screen');
  const profile = add('profile-screen', true);
  controller.sync();
  assert.equal(controller.scrollElement(home), html);
  scroll(640);
  home.hidden = true;
  profile.hidden = false;
  html.scrollTop = 0; // outgoing content is now display:none
  controller.onScroll({ target: doc });
  controller.sync();
  assert.equal(controller.scrollElement(profile), html);
  assert.equal(html.scrollTop, 0);
  scroll(120);
  profile.hidden = true;
  home.hidden = false;
  controller.sync();
  assert.equal(html.scrollTop, 640);
  assert.equal(controller.scrollElement(profile), profile, 'hidden screens never borrow the current page');
});

test('opening a guest app bounds its iframe and returning restores the directory', () => {
  const { add, html, controller, scroll } = fixture();
  add('auth-landing-screen');
  const landing = add('auth-landing-scroll');
  controller.sync();
  scroll(720);
  landing.hidden = true;
  controller.sync();
  assert.equal(html.dataset.browserScroller, undefined);
  assert.equal(html.scrollTop, 0);
  landing.hidden = false;
  controller.sync();
  assert.equal(html.dataset.browserScroller, 'auth-landing-scroll');
  assert.equal(html.scrollTop, 720);
});

test('an anonymous page takes precedence over the cached signed-in screen', () => {
  const { add, doc } = fixture();
  add('home-screen');
  add('auth-landing-screen');
  const landing = add('auth-landing-scroll');
  assert.equal(pageScroller(doc, 'home-screen'), landing);
});

test('the router wins over a still-visible outgoing app during zoom-out', () => {
  const { add, doc } = fixture();
  add('home-screen');
  add('app-view').dataset.appSurface = 'app';
  assert.equal(pageScroller(doc), null);
  assert.equal(pageScroller(doc, 'home-screen').id, 'home-screen');
});

test('Dev feeds scroll the page; parked feeds inside an app or chat do not', () => {
  const { add, doc } = fixture();
  const app = add('app-view');
  const content = add('app-content');
  const feed = add('dev-forum-scroll');
  app.dataset.appSurface = 'platform';
  assert.equal(pageScroller(doc), feed);
  app.dataset.appSurface = 'app';
  assert.equal(pageScroller(doc), null);
  app.dataset.appSurface = 'platform';
  content.hidden = true;
  assert.equal(pageScroller(doc), null);
  content.hidden = false;
  feed.hidden = true;
  assert.equal(pageScroller(doc), null);
});

test('resizing transfers the position between the document and the bounded screen', () => {
  const { add, doc, win, html, controller, scroll } = fixture();
  const home = add('home-screen');
  controller.sync();
  assert.equal(win.history.scrollRestoration, 'manual');
  scroll(320);
  win.mobile = false;
  controller.sync();
  assert.equal(win.history.scrollRestoration, 'auto');
  assert.equal(home.scrollTop, 320);
  assert.equal(controller.scrollElement(home), home);
  home.scrollTop = 160;
  controller.onScroll({ target: home });
  win.mobile = true;
  controller.sync();
  assert.equal(controller.scrollElement(home), doc.scrollingElement);
  assert.equal(html.scrollTop, 160);
});

// ── #2771: a pan the installed app was left with ─────────────────────

function installed() {
  const f = fixture();
  let kb = false;
  f.html.clientHeight = 844;
  f.html.classList.contains = (name) => name === 'un-kb' && kb;
  f.win.standalone = true; // display-mode: standalone — the bounded shell
  f.win.innerHeight = 844;
  f.win.visualViewport = { scale: 1, height: 844 };
  f.win.scrollY = 0;
  f.win.scrollTo = (x, y) => { f.win.scrollY = y; };
  f.setKeyboard = (on) => { kb = on; f.win.visualViewport.height = on ? 500 : 844; };
  return f;
}

test('an installed app puts a stranded document pan back once the keyboard is gone', () => {
  const { add, doc, win, html, controller, setKeyboard } = installed();
  add('home-screen');
  controller.sync();
  assert.equal(html.dataset.browserScroller, undefined, 'installed apps keep the bounded shell');

  // Keyboard up: iOS pans the document to reveal the field. Leave it be.
  setKeyboard(true);
  html.scrollTop = 300;
  controller.onScroll({ target: doc });
  assert.equal(html.scrollTop, 300, 'a pan while the keyboard is up is the browser doing its job');

  // Keyboard down, pan left behind: the tab bar is off the bottom edge.
  setKeyboard(false);
  controller.settle();
  assert.equal(html.scrollTop, 0);
  assert.equal(win.scrollY, 0);

  // Any later stray pan is undone on the scroll that makes it.
  html.scrollTop = 40;
  controller.onScroll({ target: doc });
  assert.equal(html.scrollTop, 0);
});

test('the pan reset never touches a paging document, a zoom, a desktop or a frame', () => {
  const { add, doc, win, html, controller, scroll } = fixture();
  add('home-screen');
  controller.sync();
  assert.equal(html.dataset.browserScroller, 'home-screen');
  scroll(500);
  controller.settle();
  assert.equal(html.scrollTop, 500, 'a mobile browser tab pages the document on purpose');

  const f = installed();
  assert.equal(strandedPan(f.win, f.doc, 120), true);
  assert.equal(strandedPan(f.win, f.doc, 0), false);
  f.win.visualViewport.scale = 2;
  assert.equal(strandedPan(f.win, f.doc, 120), false, 'pinch zoom pans on purpose');
  f.win.visualViewport.scale = 1;
  f.win.mobile = false;
  assert.equal(strandedPan(f.win, f.doc, 120), false, 'desktop is out of scope');
  f.win.mobile = true;
  f.win.top = {};
  assert.equal(strandedPan(f.win, f.doc, 120), false, 'an embedded shell is its parent\'s business');
  f.win.top = f.win;
  f.setKeyboard(true);
  assert.equal(strandedPan(f.win, f.doc, 120), false);
  void doc; void win;
});

// ── #2823: the tabs still moved up after some usage ──────────────────

const field = (type = 'text') => ({ tagName: 'INPUT', type });

test('a short visual viewport is only a keyboard while a text field has focus', () => {
  const f = installed();
  f.add('home-screen');
  f.controller.sync();
  // The keyboard went and iOS never grew the visual viewport back: #2771's
  // guard read that as "keyboard still up" and left the pan for good.
  f.win.visualViewport.height = 500;
  f.doc.activeElement = null;
  f.html.scrollTop = 260;
  f.controller.settle();
  assert.equal(f.html.scrollTop, 0, 'nothing focused, nothing to type into: the pan is stranded');

  // With a field focused the same geometry IS a keyboard, even before the
  // kit's tracker has set `un-kb`.
  f.doc.activeElement = field();
  f.html.scrollTop = 260;
  f.controller.settle();
  assert.equal(f.html.scrollTop, 260, 'a focused field keeps its reveal');
});

test('which focused elements can raise a keyboard', () => {
  const doc = { body: {}, documentElement: {} };
  assert.equal(textFocused({ ...doc, activeElement: null }), false);
  assert.equal(textFocused({ ...doc, activeElement: doc.body }), false);
  assert.equal(textFocused({ ...doc, activeElement: field('text') }), true);
  assert.equal(textFocused({ ...doc, activeElement: field('search') }), true);
  assert.equal(textFocused({ ...doc, activeElement: field('checkbox') }), false);
  assert.equal(textFocused({ ...doc, activeElement: field('button') }), false);
  assert.equal(textFocused({ ...doc, activeElement: { tagName: 'TEXTAREA' } }), true);
  assert.equal(textFocused({ ...doc, activeElement: { tagName: 'DIV', isContentEditable: true } }), true);
  assert.equal(textFocused({ ...doc, activeElement: { tagName: 'IFRAME' } }), true,
    'an app\'s field is focused inside its frame, where this document cannot look');
  assert.equal(textFocused({ ...doc, activeElement: { tagName: 'A' } }), false);
});

test('a pan left on <body> or the visual viewport is found and put back', () => {
  const f = installed();
  f.add('home-screen');
  f.controller.sync();
  f.doc.body = { scrollTop: 0 };
  assert.equal(panOffset(f.win, f.doc), 0);

  f.doc.body.scrollTop = 180;
  assert.equal(panOffset(f.win, f.doc), 180, 'a focus reveal can scroll <body> past overflow: hidden');
  f.controller.settle();
  assert.equal(f.doc.body.scrollTop, 0);

  f.win.visualViewport.offsetTop = 90;
  assert.equal(panOffset(f.win, f.doc), 90, 'the visual viewport sitting below the layout top');
  let reset = false;
  f.win.scrollTo = () => { reset = true; f.win.visualViewport.offsetTop = 0; };
  f.controller.settle();
  assert.equal(reset, true);
  assert.equal(panOffset(f.win, f.doc), 0);
});

test('the reset is re-armed on every moment a stranded pan can surface', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'frontend/src/lib/browser-scroll.ts'), 'utf8');
  for (const [target, event] of [
    ['window.visualViewport?', 'resize'],
    ['window.visualViewport?', 'scroll'],
    ['document', 'focusout'],
    ['document', 'touchend'],
    ['document', 'visibilitychange'],
    ['window', 'pageshow'],
    ['window', 'orientationchange'],
    ['window', 'hashchange'],
    ['window', 'popstate'],
  ]) {
    const re = new RegExp(`${target.replace(/[.?]/g, '\\$&')}\\.addEventListener\\('${event}'`);
    assert.match(src, re, `${target} ${event} settles a stranded pan`);
  }
});

// ── sync() runs after every batch of DOM mutations ─────────────────────
// The observer watches the whole document's childList, so a streamed reply or
// a list repaint runs sync() once per batch. It used to call matchMedia twice
// per run, which parses and evaluates a fresh MediaQueryList each time.

test('sync reuses one MediaQueryList per query, and still follows it', () => {
  const { add, win, html, controller } = fixture();
  add('home-screen');
  for (let i = 0; i < 50; i += 1) controller.sync();
  assert.ok(win.lists <= 2, `built ${win.lists} lists for 50 syncs; one per query is the ceiling`);
  assert.equal(html.dataset.browserScroller, 'home-screen');
  // The list is kept and read again: its live answer still switches the page.
  win.mobile = false;
  controller.sync();
  assert.equal(html.dataset.browserScroller, undefined, 'a desktop width hands the scroll back to the screen');
  assert.ok(win.lists <= 2);
});

test('sync writes history.scrollRestoration only when it changes', () => {
  const { add, win, controller } = fixture();
  add('home-screen');
  let writes = 0;
  let value = win.history.scrollRestoration;
  Object.defineProperty(win.history, 'scrollRestoration', {
    get: () => value,
    set: (next) => { writes += 1; value = next; },
  });
  for (let i = 0; i < 20; i += 1) controller.sync();
  assert.equal(value, 'manual');
  assert.equal(writes, 1, 'one write for twenty syncs that all want the same value');
});

// ── #3565: the bottom of a paged document bounces again ─────────────────
// "On mobile Safari, if already scrolled to the bottom of the page, cannot
// scroll down more to make the address bar shrink." Safari tucks its toolbar
// away when a drag moves the page, and at the end of a page only the rubber
// band can move. app.css's `html, body { overscroll-behavior-y: none }`
// (#737, written for the bounded shell) came along when #1518 made the
// document the scroller, and on <html> it switched that band off at both
// ends. The top must keep it off for the kit's pull-to-refresh, so the page
// is marked once it is PAST_TOP_PX below its top, and only the mark lets a
// phone's viewport bounce.

const { PAST_TOP_PX } = loadTsx('frontend/src/lib/browser-scroll.ts');
const marked = (html) => html.dataset.browserPastTop !== undefined;

test('#3565: the paged document is marked from PAST_TOP_PX below its top, and only while it pages', () => {
  assert.equal(PAST_TOP_PX, 64);
  const { add, doc, win, html, controller, scroll } = fixture();
  const home = add('home-screen');
  const profile = add('profile-screen', true);
  controller.sync();
  assert.equal(marked(html), false, 'a page that opens at its top is not marked');
  scroll(PAST_TOP_PX - 1);
  assert.equal(marked(html), false, 'one pixel short of the margin is still the top');
  scroll(PAST_TOP_PX);
  assert.equal(marked(html), true);
  assert.equal(html.dataset.browserPastTop, '', 'a bare attribute, which is what app.css selects on');
  scroll(900);
  assert.equal(marked(html), true, 'the foot of a long page is marked');
  // A drag back up loses the mark short of the top, so a pull that starts
  // at the top meets the rule it always did.
  scroll(PAST_TOP_PX - 1);
  assert.equal(marked(html), false);
  scroll(0);
  assert.equal(marked(html), false);

  // A route that restores a remembered offset is marked without a scroll
  // event, and one that restores the top is cleared the same way.
  scroll(640);
  home.hidden = true;
  profile.hidden = false;
  html.scrollTop = 0; // outgoing content is now display:none
  controller.onScroll({ target: doc });
  controller.sync();
  assert.equal(html.scrollTop, 0);
  assert.equal(marked(html), false, 'Discover opens at its own top');
  profile.hidden = true;
  home.hidden = false;
  controller.sync();
  assert.equal(html.scrollTop, 640);
  assert.equal(marked(html), true, 'Home comes back at 640, marked');

  // Leaving the paged layout (a desktop width, the installed app) clears it.
  win.mobile = false;
  controller.sync();
  assert.equal(html.dataset.browserScroller, undefined);
  assert.equal(marked(html), false, 'the bounded shell is never marked');
  win.mobile = true;
  controller.sync();
  assert.equal(marked(html), true, 'and paging again marks it from where it is');
});

test('#3565: only the mark gives the viewport back its bounce, on a phone, and never at the top', () => {
  const CSS = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'public/css/app.css'), 'utf8');
  // The rule it overrides is still there, unchanged: the bounded shell and
  // the top of every paged document keep `none`.
  assert.match(CSS, /html, body \{\s*height: 100dvh;\s*overflow: hidden;[\s\S]*?overscroll-behavior-y: none;\s*\}/);
  assert.match(CSS, /@media \(pointer: coarse\) \{\n  html\[data-browser-scroller\]\[data-browser-past-top\],\n  html\[data-browser-scroller\]\[data-browser-past-top\] body \{\n    overscroll-behavior-y: contain;\n  \}\n\}/,
    'a phone\'s viewport bounces only while the paged document is marked, and `contain`, not `auto`, keeps Chrome\'s refresh off');
  // No other rule touches the overscroll of a paged document's root or body:
  // an unmarked override would hand the top edge to the browser's bounce and
  // refresh, under the kit's pull.
  const rules = [...CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter(([, sel, body]) => /data-browser-scroller/.test(sel) && /overscroll-behavior/.test(body));
  assert.equal(rules.length, 1, rules.map(([, sel]) => sel.trim()).join(' | '));
  assert.match(rules[0][1], /\[data-browser-past-top\]/);
});
