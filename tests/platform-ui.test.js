// PlatformUI (public/js/platform-ui.js) — the platform frontend's single
// seam over the hosted usernode-native kit. These tests pin two contracts:
//
//  1. Degraded fallback: with NO kit loaded (window.unNative absent) the
//     wrapper must fall back to console + native dialogs and inert
//     handles — never throw. This is what keeps the platform usable if
//     the kit script fails to load.
//  2. Kit delegation: with a stubbed kit present, calls route through
//     unNative and confirm/prompt map the kit's { button, value } shape
//     onto boolean / string-or-null.
//
// Plus the include-regression tests: index.html must keep referencing
// /usernode-native/v1/ and the settings toggles must keep un-switch.
//
// Run with: node --test tests/platform-ui.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { shellMarkup } = require('./lib/shell-markup');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'platform-ui.js'), 'utf8'
);

function makeSandbox({ kit } = {}) {
  const calls = { alerts: [], confirms: [], prompts: [], logs: [] };
  const sandbox = {
    console: { ...console, log: (...a) => calls.logs.push(a.map(String).join(' ')) },
    document: {
      readyState: 'complete',
      getElementById: () => null,
      addEventListener: () => {},
      createComment: () => ({}),
    },
    MutationObserver: class { observe() {} disconnect() {} },
    MouseEvent: class {},
    alert: (msg) => calls.alerts.push(msg),
    confirm: (msg) => { calls.confirms.push(msg); return true; },
    prompt: (msg, val) => { calls.prompts.push([msg, val]); return 'typed'; },
  };
  if (kit) sandbox.unNative = kit;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { PlatformUI: sandbox.PlatformUI, calls, sandbox };
}

// ── 1. Kit-absent fallback ─────────────────────────────────────────────

test('pull-to-refresh reads the active page offset after its scroller changes', () => {
  let options;
  const { kit } = stubKit();
  kit.attachPullToRefresh = (el, refresh, opts) => { options = opts; return { detach() {} }; };
  const { PlatformUI, sandbox } = makeSandbox({ kit });
  const screen = { scrollTop: 0 };
  PlatformUI.pullToRefresh(screen, async () => {});
  assert.equal(options.getScrollTop(), 0);
  const page = { scrollTop: 420 };
  sandbox.UsernodeBrowserScroll = { scrollElement: () => page };
  assert.equal(options.getScrollTop(), 420, 'a downward swipe mid-page must remain a scroll');
  page.scrollTop = 0;
  assert.equal(options.getScrollTop(), 0, 'refresh arms only once the page reaches the top');
});

// pull-to-refresh under the tabs (evan, 2026-10-01): a project page opts into
// the kit's `pullProperty` and a `topEl` function so its tabs hold still while
// the page under them moves. The seam hands both to the kit untouched, beside
// its own offset reader, and a caller that passes neither gets neither.
test('pull-to-refresh passes the page\'s own kit options through', () => {
  let options;
  const { kit } = stubKit();
  kit.attachPullToRefresh = (el, refresh, opts) => { options = opts; return { detach() {} }; };
  const { PlatformUI } = makeSandbox({ kit });
  const band = {};
  const topEl = () => band;
  PlatformUI.pullToRefresh({ scrollTop: 0 }, async () => {}, { pullProperty: '--dev-ptr-pull', topEl });
  assert.equal(options.pullProperty, '--dev-ptr-pull');
  assert.equal(options.topEl, topEl, 'the function itself, for the kit to ask at every pull');
  assert.equal(typeof options.getScrollTop, 'function');
  PlatformUI.pullToRefresh({ scrollTop: 0 }, async () => {});
  assert.deepEqual(Object.keys(options), ['getScrollTop'], 'Home, Discover and Standings pass nothing new');
});

// #3517: the Workshop's Needs you feed is a snap scroller inside the Dev
// scroller, fitted to the window, so the outer offset is always 0 and a
// swipe down to go back a card was read as a pull: the whole screen slid
// under the refresh puck and the Workshop reloaded. For the length of a
// touch, a scroller between the finger and the pull's own that is not at
// its top keeps the drag, as a native nested scroll view does.
test('pull-to-refresh leaves a downward drag to a nested scroller that is not at its top', () => {
  let options;
  let detached = 0;
  const { kit } = stubKit();
  kit.attachPullToRefresh = (el, refresh, opts) => { options = opts; return { detach() { detached++; }, refresh() {} }; };
  const { PlatformUI } = makeSandbox({ kit });
  const listeners = {};
  const screen = {
    scrollTop: 0,
    parentElement: null,
    contains(n) { for (let el = n; el; el = el.parentElement) if (el === screen) return true; return false; },
    addEventListener(type, fn, opts) { assert.equal(opts.capture, true, `${type} is captured, ahead of the kit's own`); listeners[type] = fn; },
    removeEventListener(type, fn) { if (listeners[type] === fn) delete listeners[type]; },
  };
  const feed = { scrollTop: 630, parentElement: screen };
  const card = { scrollTop: 0, parentElement: feed };
  const handle = PlatformUI.pullToRefresh(screen, async () => {});
  assert.equal(options.getScrollTop(), 0, 'between touches the offset is the page\'s alone');
  listeners.touchstart({ touches: [{}], target: card });
  assert.equal(options.getScrollTop(), 630, 'a finger in a feed past its first card scrolls the feed');
  listeners.touchend({ touches: [] });
  assert.equal(options.getScrollTop(), 0);
  feed.scrollTop = 0;
  listeners.touchstart({ touches: [{}], target: card });
  assert.equal(options.getScrollTop(), 0, 'at the feed\'s top a pull is still a pull');
  const outside = { scrollTop: 900, parentElement: null };
  listeners.touchstart({ touches: [{}], target: outside });
  assert.equal(options.getScrollTop(), 0, 'only what is inside the screen counts');
  assert.equal(typeof handle.refresh, 'function', 'the kit\'s handle is passed through');
  handle.detach();
  assert.equal(detached, 1);
  assert.deepEqual(Object.keys(listeners), [], 'detach takes the touch listeners off too');
});

// #3514: the Discussion tab is the same shape. Its chat (#gc-messages on a
// project, #general's embedded .messages-thread-scroll on Homeroom) opens
// on its newest line, far from its top, inside the same fitted Dev
// scroller, so dragging down to read back slid the page away from the
// header under the refresh puck. The chat keeps that drag now, and a chat
// laid out bottom-up (`flex-direction: column-reverse`, which counts its
// scrollTop DOWN from 0) is read the right way round.
test('pull-to-refresh leaves a downward drag in the Discussion chat to the chat', () => {
  let options;
  const { kit } = stubKit();
  kit.attachPullToRefresh = (el, refresh, opts) => { options = opts; return { detach() {} }; };
  const { PlatformUI, sandbox } = makeSandbox({ kit });
  const styles = new Map();
  sandbox.getComputedStyle = (el) => styles.get(el) || { overflowY: 'visible', flexDirection: 'row' };
  const listeners = {};
  const devScroll = {
    scrollTop: 0,
    parentElement: null,
    contains(n) { for (let el = n; el; el = el.parentElement) if (el === devScroll) return true; return false; },
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener() {},
  };
  // The tab body, taller than the screen only by what it clips: no scroller.
  const pane = { scrollTop: 0, scrollHeight: 700, clientHeight: 700, parentElement: devScroll };
  const chat = { scrollTop: 506, scrollHeight: 1028, clientHeight: 522, parentElement: pane };
  const message = { scrollTop: 0, scrollHeight: 60, clientHeight: 60, parentElement: chat };
  PlatformUI.pullToRefresh(devScroll, async () => {});
  const touch = (target) => listeners.touchstart({ touches: [{}], target });
  touch(message);
  assert.equal(options.getScrollTop(), 506, 'on its newest line, the chat has 506px to scroll back: not a pull');
  chat.scrollTop = 0;
  touch(message);
  assert.equal(options.getScrollTop(), 0, 'read to its first message, the next drag down refreshes');
  // The same chat laid out bottom-up: 0 is its newest line, its first
  // message is at -506.
  styles.set(chat, { overflowY: 'auto', flexDirection: 'column-reverse' });
  touch(message);
  assert.equal(options.getScrollTop(), 506, 'a reversed chat at its bottom is 506px from its top');
  chat.scrollTop = -200;
  assert.equal(options.getScrollTop(), 306);
  chat.scrollTop = -506;
  assert.equal(options.getScrollTop(), 0, 'and at its top a pull is a pull');
  // A reversed box that does not scroll is not a scroller.
  styles.set(chat, { overflowY: 'visible', flexDirection: 'column-reverse' });
  chat.scrollTop = 0;
  assert.equal(options.getScrollTop(), 0);
});

test('kit absent: toast logs to console and returns null', () => {
  const { PlatformUI, calls } = makeSandbox();
  const handle = PlatformUI.toast('Saved');
  assert.equal(handle, null);
  assert.ok(calls.logs.some((l) => l.includes('Saved')));
});

test('kit absent: alert falls back to window.alert', async () => {
  const { PlatformUI, calls } = makeSandbox();
  await PlatformUI.alert({ title: 'Heads up', message: 'Something happened' });
  assert.equal(calls.alerts.length, 1);
  assert.ok(calls.alerts[0].includes('Heads up'));
  assert.ok(calls.alerts[0].includes('Something happened'));
});

test('kit absent: confirm falls back to window.confirm and resolves its boolean', async () => {
  const { PlatformUI, calls } = makeSandbox();
  const ok = await PlatformUI.confirm({ title: 'Delete this app?', danger: true });
  assert.equal(ok, true);
  assert.equal(calls.confirms.length, 1);
});

test('kit absent: prompt falls back to window.prompt', async () => {
  const { PlatformUI, calls } = makeSandbox();
  const v = await PlatformUI.prompt({ title: 'Set KEY', value: 'x' });
  assert.equal(v, 'typed');
  assert.equal(calls.prompts.length, 1);
});

test('kit absent: sheets/panels/modals return null, actionSheet resolves null, gestures null', async () => {
  const { PlatformUI } = makeSandbox();
  assert.equal(PlatformUI.hasKit(), false);
  assert.equal(PlatformUI.isTouch(), false);
  assert.equal(PlatformUI.sheet({}), null);
  // Null is what makes App.HeaderMenu fall back to the legacy CSS
  // slide-over instead of opening nothing.
  assert.equal(PlatformUI.panel({}), null);
  assert.equal(PlatformUI.modal({}), null);
  assert.equal(await PlatformUI.actionSheet({ actions: [] }), null);
  assert.equal(PlatformUI.gestures(), null);
});

test('kit absent: transition still runs the mutation synchronously', () => {
  const { PlatformUI } = makeSandbox();
  let ran = false;
  PlatformUI.transition(() => { ran = true; }, { type: 'push' });
  assert.equal(ran, true);
});

test('kit absent: a zoom transition runs BOTH mutation halves (fn + after), never throws', () => {
  const { PlatformUI } = makeSandbox();
  const order = [];
  PlatformUI.transition(() => order.push('fn'), {
    type: 'zoom-in',
    el: {},
    fromEl: () => null,
    after: () => order.push('after'),
  });
  assert.deepEqual(order, ['fn', 'after']);
  // No `after` is fine too.
  let ran = false;
  assert.doesNotThrow(() => {
    PlatformUI.transition(() => { ran = true; }, { type: 'zoom-out', el: {} });
  });
  assert.equal(ran, true);
});

test('kit absent: swipeActions / pullToRefresh / attachScreenFx are inert, never throw', () => {
  const { PlatformUI } = makeSandbox();
  const s = PlatformUI.swipeActions({}, {});
  const p = PlatformUI.pullToRefresh({}, () => {});
  assert.doesNotThrow(() => { s.detach(); s.close(); p.detach(); });
  assert.doesNotThrow(() => {
    PlatformUI.attachScreenFx('k', {}, {});
    PlatformUI.detachScreenFx('k');
  });
});

// ── 2. Kit delegation ──────────────────────────────────────────────────

function stubKit() {
  const seen = {
    toasts: [], alerts: [], sheets: [], panels: [], modals: [],
    actionSheets: [], transitions: [],
  };
  const kit = {
    platform: 'ios',
    toast: (msg, opts) => { seen.toasts.push([msg, opts]); return { dismiss() {}, el: {} }; },
    alert: (opts) => {
      seen.alerts.push(opts);
      // Simulate the user tapping the LAST (non-cancel) button, typing 'v'.
      const b = (opts.buttons || [{ label: 'OK', style: 'default' }]).slice(-1)[0];
      return Promise.resolve({ button: b, value: opts.field ? 'v' : undefined });
    },
    actionSheet: (opts) => { seen.actionSheets.push(opts); return Promise.resolve(null); },
    presentSheet: (opts) => { seen.sheets.push(opts); return { dismiss() {}, el: {} }; },
    presentPanel: (opts) => { seen.panels.push(opts); return { dismiss() {}, el: {} }; },
    presentModal: (opts) => { seen.modals.push(opts); return { dismiss() {}, el: {} }; },
    transition: (fn, opts) => { seen.transitions.push(opts); fn(); },
    gestures: { claim: () => true, owner: () => null, release: () => {} },
  };
  return { kit, seen };
}

test('kit present: toast delegates to unNative.toast', () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  const h = PlatformUI.toast('Copied');
  assert.ok(h && typeof h.dismiss === 'function');
  assert.equal(seen.toasts.length, 1);
  assert.equal(seen.toasts[0][0], 'Copied');
});

test('kit present: isTouch reflects the kit platform', () => {
  const { kit } = stubKit();
  const touch = makeSandbox({ kit });
  assert.equal(touch.PlatformUI.isTouch(), true);
  kit.platform = 'desktop';
  const desk = makeSandbox({ kit });
  assert.equal(desk.PlatformUI.isTouch(), false);
});

test('kit present: panel delegates to unNative.presentPanel, options untouched', () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  const contentEl = { adopted: true };
  const onDismiss = () => {};
  const h = PlatformUI.panel({ contentEl, side: 'right', onDismiss });
  assert.ok(h && typeof h.dismiss === 'function');
  assert.equal(seen.panels.length, 1);
  // The side is what the hamburger drawer's whole change hinges on, and
  // contentEl is the adoption seam — neither may be rewritten in transit.
  assert.equal(seen.panels[0].side, 'right');
  assert.equal(seen.panels[0].contentEl, contentEl);
  assert.equal(seen.panels[0].onDismiss, onDismiss);
  // A kit that predates presentPanel degrades to the legacy path.
  delete kit.presentPanel;
  const { PlatformUI: P2 } = makeSandbox({ kit });
  assert.equal(P2.panel({ contentEl }), null);
});

test('kit present: confirm maps the tapped button onto a boolean', async () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  const ok = await PlatformUI.confirm({ title: 'Withdraw?', confirmLabel: 'Withdraw', danger: true });
  assert.equal(ok, true); // stub taps the last (destructive) button
  const buttons = seen.alerts[0].buttons;
  assert.equal(buttons[0].style, 'cancel');
  assert.equal(buttons[1].style, 'destructive');
  assert.equal(buttons[1].label, 'Withdraw');
});

test('kit present: confirm resolves false when the cancel button is tapped', async () => {
  const { kit } = stubKit();
  kit.alert = (opts) => Promise.resolve({ button: opts.buttons[0] }); // cancel
  const { PlatformUI } = makeSandbox({ kit });
  assert.equal(await PlatformUI.confirm({ title: 'Sure?' }), false);
});

test('kit present: prompt returns the field value on OK, null on cancel', async () => {
  const { kit } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  assert.equal(await PlatformUI.prompt({ title: 'Set KEY' }), 'v');
  kit.alert = (opts) => Promise.resolve({ button: opts.buttons[0], value: 'v' });
  const { PlatformUI: P2 } = makeSandbox({ kit });
  assert.equal(await P2.prompt({ title: 'Set KEY' }), null);
});

test('kit present: prompt submits on Enter and passes an optional length cap (QA 2026-09-24 Q14)', async () => {
  const { kit } = stubKit();
  let seen = null;
  kit.alert = (opts) => { seen = opts; return Promise.resolve({ button: opts.buttons[1], value: 'Launch crew' }); };
  const { PlatformUI } = makeSandbox({ kit });
  assert.equal(await PlatformUI.prompt({ title: 'Rename group', value: 'Old', maxLength: 80 }), 'Launch crew');
  assert.deepEqual({ ...seen.field }, { placeholder: '', value: 'Old', submitOnEnter: true, maxLength: 80 });
  await PlatformUI.prompt({ title: 'Set KEY' });
  assert.equal('maxLength' in seen.field, false, 'no cap unless one is asked for');
});

test('kit present: transition forwards the type and runs the mutation', () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  let ran = false;
  PlatformUI.transition(() => { ran = true; }, { type: 'pop' });
  assert.equal(ran, true);
  assert.deepEqual(seen.transitions[0], { type: 'pop' });
});

test('kit present: zoom opts (el, fromEl, fallback, after, outEl) forward to unNative untouched', () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  const el = { screen: true };
  const fromEl = () => null;
  const after = () => {};
  const outEl = { outgoingScreen: true };
  const opts = { type: 'zoom-in', el, fromEl, fallback: 'push', after, outEl };
  PlatformUI.transition(() => {}, opts);
  assert.equal(seen.transitions[0], opts, 'the opts object passes through by reference');
  assert.equal(seen.transitions[0].el, el);
  assert.equal(seen.transitions[0].fromEl, fromEl);
  assert.equal(seen.transitions[0].after, after);
  assert.equal(seen.transitions[0].fallback, 'push');
  assert.equal(seen.transitions[0].outEl, outEl,
    'outEl (#764: destination measured with the outgoing screen hidden) forwards untouched');
});

// The kit pins a zooming screen as a fixed card at z-index 9960 over its whole
// box. #app-view's box runs under the desktop rail, so an app opening beside
// the rail covered it until the zoom ended. The zooming screen says so for
// exactly as long as it is pinned, and app.css lifts the docked rail over it.
test('a zooming screen carries data-zooming until its after runs, exactly once', () => {
  const attrs = new Map();
  const el = {
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
  };
  let held = null;
  const { kit } = stubKit();
  kit.transition = (fn, opts) => { fn(); held = opts; };
  const { PlatformUI } = makeSandbox({ kit });
  let afters = 0;
  const seenDuring = [];
  PlatformUI.transition(() => seenDuring.push(attrs.has('data-zooming')), {
    type: 'zoom-in', el, after: () => { afters += 1; seenDuring.push(attrs.has('data-zooming')); },
  });
  assert.equal(attrs.has('data-zooming'), true, 'on while the card is pinned');
  held.after();
  assert.equal(attrs.has('data-zooming'), false, 'gone once the kit runs after');
  assert.equal(afters, 1, "the caller's own after still runs, once");
  assert.deepEqual(seenDuring, [true, false], 'set before fn, cleared before the caller\'s after');
  // A push, or a zoom whose el is not an element, is untouched.
  const plain = { type: 'push', after() {} };
  PlatformUI.transition(() => {}, plain);
  assert.equal(held, plain);
});

test('app.css lifts the docked rail over a zooming app, on the desktop only', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const rule = 'body:has(#app-view[data-zooming]) :is(#platform-tabs, #platform-parked, #platform-section-column):not(.hidden) {';
  const at = css.indexOf(rule);
  assert.ok(at > 0, 'the rule is there');
  assert.match(css.slice(at, css.indexOf('}', at)), /z-index: 9961;/,
    'over the kit\'s pinned card (9960), under its sheets (9990 and up)');
  const open = css.lastIndexOf('@media (min-width: 768px) {', at);
  assert.ok(open > 0);
  assert.doesNotMatch(css.slice(open, at), /\n\}/, 'inside the desktop breakpoint');
});

// ── 3. Include regressions ─────────────────────────────────────────────

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('index.html loads the hosted kit (css + js) and platform-ui.js', () => {
  assert.ok(INDEX.includes('/usernode-native/v1/native.css'), 'kit stylesheet include dropped');
  assert.ok(INDEX.includes('/usernode-native/v1/native.js'), 'kit script include dropped');
  assert.ok(INDEX.includes('/js/platform-ui.js'), 'PlatformUI wrapper include dropped');
});

test('index.html viewport meta carries viewport-fit=cover (kit safe-area contract)', () => {
  const meta = INDEX.match(/<meta name="viewport"[^>]*>/)[0];
  assert.ok(meta.includes('viewport-fit=cover'), meta);
});

test('settings toggles are kit switches (un-switch)', () => {
  for (const id of ['view-as-non-admin', 'dev-console-always-show', 'devchat-alerts-toggle', 'ai-progress-estimate']) {
    const m = shellMarkup().match(new RegExp(`<input id="${id}"[^>]*>`));
    assert.ok(m, `missing settings checkbox #${id}`);
    assert.ok(m[0].includes('un-switch'), `#${id} lost its un-switch class`);
  }
});

test('header and app view carry safe-area classes', () => {
  assert.ok(/<header id="platform-header"[^>]*un-safe-top/.test(INDEX));
  // #970: the bottom inset is SURFACE-DEPENDENT now, so #app-view must NOT
  // carry a blanket `un-safe-bottom`. That class reserved the
  // home-indicator strip for every surface inside #app-content — the
  // running app's iframe included — which is what left apps cut off short
  // of a phone's rounded bottom edge. The `data-app-surface` attribute
  // (AppView._setSurface) plus the app.css rules replace it; the default
  // is `platform` so a first paint before any render is well-defined.
  //
  // The follow-up moved the inset off #app-view entirely: the surface
  // rules publish the `--platform-safe-bottom` TOKEN (real value on a
  // platform surface, 0px on an app one) and the padding itself lives on
  // each inner scroller / composer bar, so Dev mode paints edge to edge
  // like the app surface. tests/app-safe-area.test.js and
  // tests/platform-safe-bottom.test.js pin that contract; here we only
  // check the surface hook still exists for app.css to key on.
  assert.ok(!/<div id="app-view"[^>]*un-safe-bottom/.test(INDEX),
    '#app-view must not reserve the bottom inset for the app frame (#970)');
  assert.ok(/<div id="app-view"[^>]*data-app-surface="platform"/.test(INDEX),
    '#app-view needs the surface flag, defaulting to platform');
  assert.ok(
    read('public/css/app.css').includes('#app-view[data-app-surface="platform"]'),
    'app.css must carry the platform-surface rule'
  );
});

test('neither the bottom tab bar nor the header switch ships', () => {
  // Two retirements, one test. The full-width bottom #app-tabs bar went first
  // (replaced by the header's App/Dev switch); THE UI OVERHAUL then retired
  // the switch too. An app is just an app now — Dev is a destination the
  // Improve panel links to, not a mode the header toggles between.
  assert.ok(!INDEX.includes('id="app-tabs"'), 'the #app-tabs nav still ships');
  assert.ok(!INDEX.includes('class="app-tab'), 'an .app-tab button still ships');
  assert.ok(!INDEX.includes('id="app-mode-switch"'), 'the header switch still ships');
  assert.ok(!/class="[^"]*app-mode-seg/.test(INDEX), 'an orphan segment still ships');
});

test('the right group is the bell and the mark, in that order, after the title', () => {
  const header = INDEX.slice(
    INDEX.indexOf('id="platform-header"'),
    INDEX.indexOf('</header>')
  );
  // Same requirement the switch had, then #improve-btn, and for the same
  // reason: the header layout code measures the title's right side group
  // through a ref on that div, so a control moved out of it stops counting
  // towards the clearance the centering measurement needs.
  assert.ok(header.includes('id="platform-mark-btn"'), 'the mark is outside the header');
  assert.ok(
    header.indexOf('id="platform-mark-btn"') > header.indexOf('id="header-title"'),
    'the mark must sit after the title, in the right group'
  );
  // #2718 RETIRED #improve-btn. The bar inside an app is that app's — its
  // close button, its tile, its name — plus the platform's signature in the
  // corner and one alert; a third control that is neither made the right
  // group read as a toolbar. The pill's panel is a row of the mark's menu now
  // (#app-menu-row-improve), so nothing it did was dropped.
  assert.ok(!header.includes('id="improve-btn"'), 'the Improve pill is retired');
  assert.ok(
    header.indexOf('id="notifications-btn"') < header.indexOf('id="platform-mark-btn"'),
    'the alert reads inward from the edge; the corner goes to the control '
    + 'that never moves'
  );
  // Streamlined Concept: the hamburger moved to the LEFT group, mirroring
  // the drawer it opens, so it now PRECEDES the title.
  assert.ok(
    header.indexOf('id="header-menu-btn"') < header.indexOf('id="header-title"'),
    'the hamburger leads the bar, before the title'
  );
});

test('the Improve row is retired; what it led to is in the menu', () => {
  // THE ROW WAS A TAP TO REACH A TAP. It shipped hidden, revealed itself when
  // a target was published, and opened a drawer whose whole remaining content
  // was two buttons — the sessions under them had already moved to the
  // Workshop earlier in this issue. #2718's review removed the drawer, which
  // leaves the row leading nowhere: the buttons are in the menu itself.
  assert.ok(!INDEX.includes('id="app-menu-row-improve"'),
    'the row that opened the drawer is retired');
  assert.ok(!INDEX.includes('id="improve-btn-glyph"'),
    'and the three-state glyph it carried went with it — the states it drew '
    + 'are the mark\'s dots below, which are on screen without a tap');

  // What is there instead, and NOT hidden: the menu is already behind a tap,
  // so a row inside it was never the place a cue could be read from.
  const band = INDEX.match(/<div id="improve-quick-actions"[\s\S]*?<\/div>/);
  assert.ok(band, 'missing #improve-quick-actions');
  assert.ok(band[0].includes('id="improve-row-feedback"'), 'Suggest an improvement is the band\'s button');
  // New change was Build it now under Agent chats (UI overhaul, B8); the
  // section left for Messages whole (#4729), so the band's one button is
  // Suggest an improvement and nothing of theirs is drawn at all.
  assert.ok(!band[0].includes('id="improve-row-new-session"'), 'and alone in it');
  assert.ok(!INDEX.includes('id="app-menu-sessions"') && !INDEX.includes('id="improve-row-new-session"'),
    'no agent entries in the prerender');
  assert.doesNotMatch(read('frontend/src/features/app-context/app-context-sheet.tsx'),
    /app-menu-sessions|improve-row-new-session/,
    'and none after mount either: Messages\' Agents list is their home');
  assert.ok(!/\bhidden\b/.test(band[0].slice(0, band[0].indexOf('>'))),
    'the band itself ships visible');

  // The two dots the pill wore are on the mark, which is on screen on every
  // route — a live cue inside a closed menu is not a cue. They have now
  // outlived both the pill that wore them and the row that inherited them.
  const mark = INDEX.match(/<button id="platform-mark-btn"[\s\S]*?<\/button>/)[0];
  assert.ok(mark.includes('id="feedback-queue-dot"'), 'the outbox dot is on the mark');
  assert.ok(mark.includes('id="improve-working-dot"'), 'and so is the working pulse');
});

test('setAppOpen publishes the Improve target instead of toggling a switch', () => {
  // #1079 chunk B moved it into the React bundle; app.js keeps a forwarder.
  // It is ImproveStatus in the improve feature now — both of its publishers
  // are about the Improve button, not about any drawer. THE UI OVERHAUL kept
  // that lifecycle and changed only what it publishes — one call already
  // covers openApp, navigateHome, AppView.close() and every other-screen
  // navigation, which is why the header control still rides it.
  const src = read('frontend/src/features/improve/improve-status.js');
  const fn = src.slice(src.indexOf('setAppOpen(open) {'), src.indexOf('refreshDeployDot() {'));
  assert.ok(!fn.includes("getElementById('app-mode-switch')"),
    'the retired switch must not still be toggled here');
  assert.ok(fn.includes('Improve?.setTarget'), fn);
  assert.ok(fn.includes('setTarget(null)'),
    'closing an app must clear the target, or the button outlives its subject');
  // Unlike the switch it replaced, the self-hosted platform row is NOT
  // excluded: everything Improve offers works on it, opened like any other
  // app.
  assert.ok(fn.includes('self_hosted'), 'the platform row is still classified');
  assert.ok(!/self_hosted[\s\S]{0,120}classList\.toggle\('hidden'/.test(fn),
    'the platform row must no longer be hidden out of the header');
});

test('home publishes the PLATFORM Improve target, from render and not only on return', () => {
  // #1367 put an Improve button on the home screen, scoped to the platform's
  // own self-hosted row — "improve Homeroom itself".
  //
  // THE UI OVERHAUL shipped that once and reverted it, and this test pins the
  // shape of the fix rather than just the feature. The reverted version
  // re-targeted the platform row on the RETURN paths only (App._improveHome),
  // so a cold boot at `/` never published one: the button appeared after
  // backing out of an app and vanished on refresh, which read as a stale
  // leftover of the app just closed. What makes it consistent now is that the
  // publish lives in Home.render() — the call every path funnels through —
  // with navigateHome only RE-publishing so the swap is same-frame.
  const src = read('public/js/app.js');
  const home = read('frontend/src/features/home/home.js');

  // 1. The publisher is Home's, and it is called from render(). This is the
  //    property the first attempt lacked; without it the rest is cosmetic.
  assert.ok(home.includes('publishImproveTarget()'),
    'Home must own the platform target publisher');
  const renderStart = home.indexOf('  render() {');
  const render = home.slice(renderStart, home.indexOf('\n  },', renderStart));
  assert.ok(render.includes('Home.publishImproveTarget();'),
    'render() must publish the target — the one call a cold boot, a WS repaint '
    + 'and the return from an app all reach');

  // 2. It is the platform's own row, resolved from the list the viewer was
  //    actually served — never a hardcoded slug, which would both rot and
  //    leak the row's existence to non-admins the API hides it from.
  const pubStart = home.indexOf('  publishImproveTarget() {');
  const publish = home.slice(pubStart, home.indexOf('\n  },', pubStart));
  // The target's SHAPE is one builder now, shared with the row
  // ../app-context/platform-target.js fetches on a cold load of another tab —
  // two copies of it would be two descriptions of one row that drift.
  const fnBody = (name) => {
    const at = home.indexOf(`  ${name}(`);
    return at < 0 ? '' : home.slice(at, home.indexOf('\n  },', at));
  };
  const builder = fnBody('_platformTargetFrom');
  const platformFallback = fnBody('_publishPlatformFallback');
  assert.ok(/self_hosted/.test(publish),
    'the target is found by the self_hosted flag on the served apps list');
  assert.ok(publish.includes('Home._platformTargetFrom(self)'),
    'and built by the one builder');
  assert.ok(builder.includes("kind: 'platform'"),
    'and published as the platform kind, not as an ordinary app');
  for (const [name, body] of [['publishImproveTarget', publish], ['_platformTargetFrom', builder],
    ['_publishPlatformFallback', platformFallback]]) {
    assert.ok(!/slug:\s*['"]usernode/.test(body), `never a hardcoded platform slug (${name})`);
  }

  // 3. Both gates, and what #1406 changed about the second one.
  //
  //    The first is unchanged: publishing while an app is open would overwrite
  //    that app's own target, so the header button would describe the wrong
  //    thing.
  //
  //    The second used to require HOME specifically, which is precisely why
  //    the improve button and the view selector vanished on settings, profile
  //    and messages. Those screens now call this too, so the gate asks the
  //    question that actually matters — is an app on screen — rather than
  //    naming the one screen that used to be allowed.
  assert.ok(publish.includes('currentApp'),
    'must not publish while an app is open');
  assert.ok(publish.includes("_isScreenVisible('app-view')"),
    'and not while the app view is on show — the other half of the same guard');
  assert.ok(!publish.includes("!App._isScreenVisible('home-screen')"),
    'but no longer refuses every screen that is not home');

  // 4. navigateHome still CLEARS the app's target first, then republishes
  //    home's — in that order, so nothing inherits the closed app's facts.
  const navStart = src.indexOf('navigateHome(opts) {');
  const nav = src.slice(navStart, src.indexOf('after: () => {', navStart));
  assert.ok(/App\.ImproveStatus\.setAppOpen\(false\);[\s\S]{0,900}Home\.publishImproveTarget\(\)/.test(nav),
    'navigateHome must clear the app target before republishing home\'s');
  // The retired helper stays retired: the publish belongs to Home, and a
  // second copy in app.js is how the return-path-only bug got in.
  assert.ok(!src.includes('_improveHome'),
    'the old return-path-only helper must not come back');

  // The restoreFromHash unrecognised-hash fallback lands on home too, and a
  // lingering APP target there is the same bug in a different door. It clears
  // and then calls Home.load(), whose render() publishes home's own.
  const fallbackIdx = src.indexOf("App._showOnlyScreen('home-screen');");
  const fallback = src.slice(fallbackIdx, src.indexOf('Home.load();', fallbackIdx));
  assert.ok(fallback.includes('App.ImproveStatus.setAppOpen(false);'),
    'the hash-fallback home landing must clear the app target too');

  // 5. …AND IT DOES NOT WAIT FOR /api/apps.
  //
  // Everything above resolves the row out of that payload, which is the boot's
  // slowest request — so for as long as it took, the header's standing action
  // was simply MISSING, on home and on every other platform screen (they all
  // reach here through _enterScreenChrome). That is the "the Improve button
  // shows up a few seconds late" report: not a stale button, an absent one.
  //
  // The fix is a remembered copy, published while the payload is still on its
  // way and overwritten by the real one the moment it lands. Two properties
  // make it safe rather than merely fast, and both are asserted here: it is
  // written only from a SUCCESSFUL publish (so it can only exist in a profile
  // already served the row, and cannot leak its existence to a viewer the API
  // hides it from), and it is only READ while `_appsLoaded` is false (so once
  // the list is here, the list is the truth — including the truth that this
  // viewer gets no row).
  assert.ok(publish.includes('Home._publishPlatformFallback()'),
    'no row in the list: the fallback decides');
  assert.ok(platformFallback.includes('Home._cachedImproveTarget()'),
    'a cold boot publishes the remembered target rather than nothing');
  assert.ok(/if \(Home\._appsLoaded\) \{[\s\S]*?return;\s*\}\s*const cached = Home\._cachedImproveTarget\(\);/.test(platformFallback),
    'and only while the apps payload has not arrived');
  assert.ok(publish.includes('Home._rememberImproveTarget(target)'),
    'the cache is written from the real publish, not from the cache read');
  assert.ok(!/_rememberImproveTarget\(Home\._restrictedPlatformTarget/.test(platformFallback),
    'and never from the restricted target, which is no row at all');

  // 6. …AND HOME IS NOT THE ONLY DOOR (bug: an untargeted menu on a cold
  //    load of any tab but Home). A first visit that lands on #messages,
  //    #workshop, #profile or #settings never loads the list and has no
  //    remembered copy, so the menu said "THIS APP" over a Go to workshop to
  //    `#`. The fallback now asks ../app-context/platform-target.js to find
  //    the row on its own, and publishes what it found through the same
  //    gates. Through `window.PlatformTarget`, because a dozen tests run this
  //    file as a classic script where an import line is stripped.
  assert.match(platformFallback, /const resolver = window\.PlatformTarget;/);
  assert.match(platformFallback, /const known = resolver\?\.known\?\.\(\);[\s\S]{0,160}window\.Improve\.setTarget\(known\)/,
    'a target the resolver already found is published');
  assert.match(platformFallback, /resolver\?\.resolve\?\.\(\);\s*$/,
    'and with neither list, cache nor answer, it is asked for');
  // 7. A LOADED LIST WITHOUT THE ROW is a viewer not served it
  //    (SELF_APP_PUBLIC_VOTING off, not an admin). That used to publish
  //    nothing, for good; it publishes Homeroom's restricted target now, so
  //    the menu is Homeroom's with the rows that would 404 hidden.
  assert.match(platformFallback,
    /if \(Home\._appsLoaded\) \{[\s\S]{0,400}Home\._restrictedPlatformTarget\(slug\)/,
    'not served: the restricted Homeroom target, not no target');
  // load() is the single-flight gate; the load itself is _loadOnce().
  const loadStart = home.indexOf('  async _loadOnce() {');
  const load = home.slice(loadStart, home.indexOf('\n  },', loadStart));
  assert.ok(load.includes('Home.publishImproveTarget();'),
    'load() publishes before its own fetch — render() does not run until it lands');
  // Session residue, cleared with the rest of it: the next account may not be
  // served the self-hosted row at all.
  assert.ok(/_dropCachedSession\(\)[\s\S]{0,900}Home\.IMPROVE_TARGET_KEY/.test(src),
    'the remembered target is dropped with the session');
});

// ── #1367: the App/Feed/Kanban toggle, and what it replaced ──────────

test('the menu\'s action leads it, shaped like the pill that used to open it', () => {
  // ../improve/actions.tsx is where these live since the panel retired
  // (#2718 review). They stayed in the Improve feature rather than moving
  // into the menu's own file, because they are the Improve feature's
  // controls and read its store whatever surface draws them — so everything
  // this test has ever asserted about them reads the same source, one
  // directory along.
  const panel = read('frontend/src/features/improve/actions.tsx');

  // Feedback and New change, as TWO BUTTONS. They shipped as three equal
  // thirds of one recessed well with hairline dividers — Share was the third
  // — and two things undid that. Share left for the footer (it is a fact
  // ABOUT the app, so it belongs with "View on GitHub"), and a divided well
  // of two is not a group, it is a control with a seam down the middle. The
  // well also read as a SEGMENTED CONTROL, which is exactly what the view
  // strip immediately below it now is, so the panel opened with two identical
  // shapes meaning two different kinds of thing.
  assert.match(panel, /id="improve-quick-actions"/, 'the band exists');
  assert.ok(!/divide-x divide-zinc-950\/5/.test(panel),
    'and is no longer one divided well');
  // TWO AGAIN (#2718 review). #2718 made "Give feedback" the app menu's lead
  // ROW, on the reading that it is what somebody who is NOT a developer of
  // this app wants while this panel assumes you are. True of the reader, and
  // it cost the action its shape: a filled button that says what it does
  // became the first of eight rows in a place you go to navigate.
  //
  // It is still in exactly ONE place, with ONE handler — which is what this
  // pair of assertions has always been about.
  assert.match(panel, /id="improve-row-feedback"/, 'feedback is here');
  assert.match(panel, /Improve\.giveFeedback\(\)/, 'with its handler');
  // The ID, not the word: the menu's note still NAMES the id it handed back,
  // which is the explanation a reader of that file needs and not a second
  // element claiming it.
  assert.ok(!read('frontend/src/features/app-context/app-context-sheet.tsx')
    .includes('id="improve-row-feedback"'), 'and not in two places');
  // New change left the menu with its Agent chats section (#4729); it is
  // Messages' "+" choice now, which starts an agent session the same way.
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.ok(!sheet.includes('id="improve-row-new-session"'), 'the menu carries no New change row');
  assert.match(read('frontend/src/features/messages/index.tsx'),
    /startAgentSession\(\{ entry: 'messages' \}\)/, 'Messages\' + starts it');
  // The BAND stays, and it is the same element: `#improve-quick-actions`
  // was a direct child of `#improve-body` and is a direct child of the
  // menu's sheet now. dapp.json's band-order check used to select the four
  // bands of the panel; with three of the four retired it selects this one
  // where it now sits. One button in a `flex-1 basis-0` well simply spans
  // it, which is what a lone action should do — that is what a viewer who
  // may not write sees, since New change is hidden for them.

  // The shape is #improve-btn's, the pill that used to open this panel.
  // #2718 retired that button and the shape stays: it is the platform's
  // ordinary primary control, and this was never copying the button so much
  // as agreeing with it.
  //
  // THE FILL IS THE SOLID ONE. It spent a round at `bg-violet-500/10` — a
  // tenth opacity, chosen so a solid pill would not sit under #improve-btn's
  // own and compete with the button that opened the panel. At that opacity it
  // became the palest thing in a panel of real surfaces: the control the
  // panel EXISTS for read closer to disabled than to actionable. That worry
  // was always the smaller cost — the button was in the header, outside the
  // panel and behind its backdrop once it was up — and since #2718 there is
  // no second filled pill to compete with at all.
  assert.match(panel, /rounded-full text-sm font-semibold/,
    'and the action is that pill shape');
  assert.match(panel, /const ACTION_FILL =\n\s+'bg-violet-600 hover:bg-violet-500 text-white';/,
    'wearing the platform\'s ordinary primary fill');
  assert.ok(!/ACTION_PRIMARY/.test(panel),
    'there is no primary-and-secondary pair here any more');
  assert.ok(!/\bprimary\b/.test(panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'and no call site marks one of them as the primary');

  // Share moved to the footer beside the repository link (#1443), and both
  // moved on to the menu's About pane (#2718) — which is the same argument
  // one level further: they are the app as something you POINT OTHER PEOPLE
  // AT, and About is the surface named for facts about it. Same ids, same
  // canShare gate, same dialog.
  const aboutPane = read('frontend/src/features/app-context/about-pane.tsx');
  assert.match(aboutPane, /id="improve-row-share"/, 'Share survives');
  assert.match(aboutPane, /Improve\?\.share\?\.\(\)/, 'with the same handler');
  // THE DESIGN'S ORDER NOW (nav-prototype.html, About's MORE): Share leads,
  // and View on GitHub — the design's "Source code" — follows it.
  assert.ok(aboutPane.indexOf('id="improve-row-share"') < aboutPane.indexOf('id="improve-row-github"'),
    'Share leads, View on GitHub follows, in the design\'s order');
  // An app's Share is still gated on canShare — a live address to hand over;
  // Homeroom always has one, so its Share always shows (./about-pane.tsx).
  assert.match(aboutPane, /const showShare = platform \|\| canShare;/, 'still gated on canShare for an app');
  assert.doesNotMatch(panel, /id="improve-row-share"/, 'and not in two places');

  // Everything else left: the view toggle is the view STRIP now.
  assert.ok(!/id="improve-row-kanban"/.test(panel), 'the Kanban ROW is retired');
  assert.ok(!/id="improve-row-feed"/.test(panel), 'the Feed ROW is retired');
  assert.ok(!/ImproveViewToggle/.test(panel), 'no view-toggle copy survives');
});

test("the Board owns the view control; the header's label is the chip", () => {
  const header = read('frontend/src/features/header/platform-header.tsx');
  const frame = read('frontend/src/features/dev-board/board-frame.tsx');

  // #1443: navigation between the app's views is the chip's menu — the chip
  // is the header's label on EVERY screen, not only inside an app. Kanban vs
  // Feed is not navigation at all: it is one place drawn two ways, so it sits
  // under the Improve panel's Board row and the frame draws no view control.
  assert.ok(!/ImproveViewToggle/.test(header),
    'the header renders no view-toggle copy');
  // #2718 took the chip back apart. The label is a NAME again — the menu it
  // used to open listed every platform destination, and the tab bar carries
  // those now — and the menu got its own button at the other end of the bar.
  assert.match(header, /<HeaderTitle titleRef=\{titleRef\} \/>/,
    "the header's label is a name, not a control");
  assert.match(header, /<PlatformMark \/>/,
    'the menu has its own button');
  assert.ok(!/id="dev-view-toggle"/.test(frame),
    'the Board draws no view tab strip above its cards');
  const frameCode = frame
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/matchMedia|innerWidth/.test(frameCode),
    'the frame must not measure the viewport');

  // THE VIEWS ARE A ROW NOW, NOT A SEGMENTED CONTROL (#2761). The App |
  // Workshop strip was the one control in a menu of rows; the owner asked for
  // a plain "Go to workshop" row and nothing in place of the App segment —
  // the parked app on the bar (#2762) is the way back to a running app. So the
  // strip's module is retired rather than left with no caller.
  const menu = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'frontend/src/features/improve/view-tabs.tsx')),
    'the strip module is retired, not orphaned');
  assert.ok(!/<AppViewTabs/.test(menu), 'and the menu no longer renders it');
  assert.match(menu, /id="app-menu-row-workshop"\s+dataContextRow="workshop"/,
    'the row still names its destination with data-context-row');
  const controller = read('frontend/src/features/improve/improve-controller.js');
  // #1406 widened where this segment is reachable from. It used to be true
  // that "no app open" meant "already home", because every other screen
  // cleared the target and unrendered the control — so a no-op was correct.
  // Those screens keep the control now, so the guard has to be the home screen
  // itself; left as it was, clicking Home from Settings would have done
  // nothing at all.
  assert.match(controller, /_isScreenVisible\('home-screen'\)/,
    'openApp() asks whether it is ALREADY home, not whether an app is open');
  assert.match(controller, /if \(!onHome\) window\.App\.navigateHome\(\);/,
    'and navigates home from anywhere that is not home');

  // Which HALF of the app is on screen is still published from the single
  // place App.currentTab is assigned. The header's right slot no longer reads
  // it — Improve is unconditional there now — but the session LIFECYCLE PILL
  // is gated on exactly this pair, so the publish stays load-bearing.
  const appJs = read('public/js/app.js');
  assert.match(appJs, /App\.currentTab = tab;[\s\S]{0,600}window\.Improve\?\.setTab\(tab, App\.currentSubTab\)/,
    'switchTab must publish the active tab AND sub-tab — the header status '
    + 'pill is gated on being on a session');

  // THE RIGHT SLOT IS NOT CONTEXTUAL — and since #2718 it is not a slot at
  // all. Improve used to swap into an eye on the Dev screens and into an
  // eye/pencil pair on a session with a preview, which meant the action
  // people reach for most both moved and, on a session with no preview yet,
  // disappeared. It stopped swapping, then it left the bar: it is a row of
  // the app's own menu, rendered from the target alone.
  const headerSrc = read('frontend/src/features/header/platform-header.tsx');
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  // #2718's review then removed the row altogether. It had been narrowed
  // from `target` to `target === 'app'` — "Improve Homeroom" beside Settings
  // and Admin is a different offer from the one it makes inside an app — but
  // what it opened was the drawer, and the drawer is gone. The two things
  // the drawer held are the menu's own controls now, and they are NOT
  // narrowed to an app: on Home they act on Homeroom, which is what the
  // request asked for in as many words. The part that always mattered holds
  // either way — the target, never the route.
  assert.ok(!sheet.includes('id="app-menu-row-improve"'),
    'the row that opened the drawer is retired');
  assert.match(sheet, /<ImproveQuickActions \/>/,
    'and the menu carries the two actions directly');
  const quick = read('frontend/src/features/improve/actions.tsx');
  assert.ok(!/target ===/.test(quick) && !/selfHosted/.test(quick),
    'unconditionally — they act on the platform as readily as on an app');
  assert.doesNotMatch(sheet, /tab === 'dev'/, 'and not from the route');
  for (const gone of ['app-eye-btn', 'session-build-btn', 'EyeIcon', 'PencilSparklesIcon']) {
    assert.ok(!headerSrc.includes(gone), `the ${gone} half of the swap left the header`);
    assert.ok(!sheet.includes(gone), `and did not follow Improve into the menu`);
  }
  // It went to the session strip, beside the name of the change it acts on.
  const strip = read('frontend/src/features/dev-chat/session-header.tsx');
  assert.match(strip, /id="dc-mode-switch"/, 'the strip draws the doing<->seeing switch');
  assert.match(strip, /swapToStagingForSession/,
    'and the eye there opens that preview, the one preview affordance');
  // #2069 narrowed the gate rather than removing it: a session with nothing
  // to preview still draws no switch, but "nothing to preview" no longer
  // means "no live URL" — ensure-staging can build one from the branch.
  assert.match(strip, /if \(!hasPreview\)/,
    'a session with nothing to preview draws no switch — the gate moved with it');
  assert.match(strip, /const hasPreview = !!previewUrl \|\| !!previewBuildable;/,
    'and "nothing to preview" counts a preview that could be built');
});

test('the menu is actions, navigation and the app\'s options — one scroller', () => {
  // FOUR BANDS BECAME THREE AND A LIST. The Improve panel's were the quick
  // actions, the app's views, the work in flight and a reference footer; the
  // work moved to the Workshop earlier in this issue and the footer's facts
  // moved to About, which left a drawer holding two buttons. #2718's review
  // retired it, so what is left sits above the menu's own list: the update
  // notice, the two actions, the view strip, then `#switcher-nav`.
  const panel = read('frontend/src/features/improve/actions.tsx');
  const html = read('public/index.html');

  // THE ONE SCROLLER, unchanged as a RULE and only moved: everything above
  // `#switcher-nav` is `shrink-0`, so it stays on screen at any height and
  // the list flexes and scrolls inside itself. One rule, no measurement.
  const sheetAt = html.indexOf('id="apps-switcher-sheet"');
  assert.match(html.slice(sheetAt, html.indexOf('>', sheetAt)), /flex flex-col/,
    'the sheet is the column flex');

  const scrollAt = html.indexOf('id="switcher-nav"');
  const scrollTag = html.slice(scrollAt, html.indexOf('>', scrollAt));
  assert.match(scrollTag, /overflow-y-auto/, 'the options list is the scroller');
  assert.match(scrollTag, /flex-1/, 'and takes the free space');
  assert.match(scrollTag, /min-h-0/, 'and may shrink below its content');

  const actionsAt = html.indexOf('id="improve-quick-actions"');
  assert.match(html.slice(actionsAt, html.indexOf('>', actionsAt)), /\bshrink-0\b/,
    'the quick-action band keeps its height');
  assert.ok(!html.includes('id="improve-views"'), 'no view strip between them (#2761)');
  assert.ok(actionsAt < scrollAt, 'the actions, then the scroller');
  // THE WORKSHOP ROW IS IN THE PRERENDER, which is the hydration rule and
  // not a layout one: it renders whether or not a target has been published,
  // so the child count cannot change when the classic writers publish one. A
  // `slug ? … : null` there is React #418 — see the note at its call site.
  const rowAt = html.indexOf('id="app-menu-row-workshop"');
  assert.ok(rowAt > scrollAt, 'the row ships rendered inside the list, not gated on a slug');

  // THE UPDATE NOTICE IS THE FOOTER'S ONE SURVIVOR, and it moved to the TOP
  // of the band: it is the only one of the footer's facts that is news. It
  // is conditional — three states and nothing at all when idle — so it is
  // asserted in the source rather than the prerender.
  assert.match(panel, /id="improve-update-note"/, 'a note while a build is in flight');
  assert.match(panel, /id="improve-update-ready"/, 'and the reload once one is ready');
  assert.match(panel, /versionState === 'downloading'/,
    'the note distinguishes the download from the build that preceded it');

  // WHAT DID NOT COME WITH IT. #1431 dissolved the footer and rehomed each
  // fact separately; #1443 brought it back, because the sum of those moves
  // meant leaving the app to read facts about the app you were standing in.
  // #2718 gives those facts a NAME instead — the menu's About pane — which
  // is the home #1443 was reaching for without one.
  assert.doesNotMatch(panel, /id="improve-row-github"|id="improve-row-share"/,
    'the outward-facing facts are About\'s');
  const about = read('frontend/src/features/app-context/about-pane.tsx');
  assert.match(about, /id="improve-row-github"/, 'and About is where they went');
  assert.match(about, /id="improve-row-share"/);
  // The revisions went back to Settings' About pane, which is the screen you
  // consult rather than act from (tests/header-status-pane.test.js pins
  // where they landed). The question people were reading them for was never
  // "which SHA" — it was "is something happening, and is there a new version
  // yet", which is what the notice above answers directly.
  assert.ok(!panel.includes('id="improve-row-version"'),
    "the app's version row is Settings' now");
  assert.ok(!panel.includes('id="drawer-row-platform-version"'),
    'and so is the platform build');
  assert.ok(!panel.includes('<NativeAppVersionRow />'),
    'and the native app version');
  // Fork lineage did NOT come back: #browse-detail-fork on the app's own page
  // is the better home, because lineage is a fact about an app.
  assert.ok(!panel.includes('id="drawer-row-app-fork"'),
    'fork lineage stays on the app detail page');
});

test('app.css drops the tab-bar rules, and the surface it draws is the menu', () => {
  const css = read('public/css/app.css');
  assert.ok(!/^\.app-tab\b/m.test(css), '.app-tab rules still present');
  // The .app-mode-seg rules went with the switch itself.
  assert.ok(!css.includes('.app-mode-seg'), 'orphan App/Dev segment rules survive');

  // THE IMPROVE PANEL WAS THE SUBJECT HERE: desktop side panel, mobile bottom
  // sheet, one element and two idioms, working in a mobile browser with no
  // native kit loaded. It retired (#2718 review) and every rule that drew it
  // left this stylesheet — which is the half worth pinning, because a
  // retirement that leaves its CSS behind is the residue nobody finds.
  assert.ok(!css.includes('#improve-panel'), 'no rule still draws the retired panel');
  assert.ok(!css.includes('#improve-overlay'), 'nor its backdrop');
  assert.ok(!css.includes('.improve-panel-transition'), 'nor its slide');

  // The requirement it existed for did not retire with it: the surface those
  // controls are on is a dropdown at `sm` and up and a bottom sheet below,
  // and it has to work with no kit too.
  assert.ok(css.includes('#apps-switcher-sheet'), 'the menu has chrome');
  assert.ok(css.includes('#apps-switcher-sheet[data-open]'), 'and something presents it');
  const phone = css.indexOf('@media (max-width: 639px) {\n  #apps-switcher-sheet {');
  assert.ok(phone > 0, 'below sm it must state its own geometry');
  assert.match(css.slice(phone, css.indexOf('\n}\n', phone)), /transform: translateY\(100%\)/,
    'and come up from the bottom rather than in from the side');
});

for (const kind of ['sheet', 'panel', 'modal']) {
  test(`${kind}: decoration lasts through exit and cleans up before the caller restores content`, () => {
    const { kit, seen } = stubKit();
    const { PlatformUI, sandbox } = makeSandbox({ kit });
    const events = [];
    sandbox.UsernodeReact = { decorateOverlay(el) {
      assert.ok(el);
      events.push('decorate');
      return () => events.push('cleanup');
    } };
    const opts = { contentEl: {}, onDismiss() { events.push('restore'); } };
    const handle = PlatformUI[kind](opts);
    assert.equal(seen[kind + 's'][0].contentEl, opts.contentEl);
    handle.dismiss();
    assert.deepEqual(events, ['decorate'], 'requesting dismissal does not remove the dim');
    seen[kind + 's'][0].onDismiss();
    assert.deepEqual(events, ['decorate', 'cleanup', 'restore']);
  });
}

// QA 2026-09-24 Q28: a toast rests ABOVE the bottom chrome. The kit reads
// `--un-toast-inset-bottom`; app.css gives it the tab bar's height, and
// PlatformUI.toast measures a composer (every composer block wears
// `.platform-safe-bar`) and sets the var on the live toast.
test('QA 2026-09-24 Q28: toast clears the tab bar and a composer pinned to the foot', () => {
  const rect = (top, bottom, width = 390) => ({ top, bottom, width, height: bottom - top });
  const els = [
    { r: rect(787, 844) },            // #platform-tabs on a phone
    { r: rect(716, 844) },            // the issue thread's composer block, reaching the edge
    { r: rect(52, 844, 224) },        // a panel whose top is in the upper half: content, not a bar
    { r: rect(0, 0, 0) },             // hidden
    { r: rect(900, 960) },            // translated off-screen
  ].map(({ r }) => ({ getBoundingClientRect: () => r }));
  const { kit } = stubKit();
  const style = {};
  kit.toast = () => ({ dismiss() {}, el: { style: { setProperty: (k, v) => { style[k] = v; }, removeProperty: (k) => { delete style[k]; } } } });
  const { PlatformUI, sandbox } = makeSandbox({ kit });
  sandbox.innerHeight = 844;
  let asked = null;
  sandbox.document.querySelectorAll = (sel) => { asked = sel; return els; };
  assert.equal(PlatformUI.toastClearance(), 128, 'the composer block is the taller of the two');
  assert.equal(asked, '#platform-tabs, .platform-safe-bar');
  PlatformUI.toast('Cannot verify the issue right now.');
  assert.equal(style['--un-toast-inset-bottom'], '128px');
  sandbox.document.querySelectorAll = () => [];
  PlatformUI.toast('Copied');
  assert.equal(style['--un-toast-inset-bottom'], undefined, 'nothing at the foot: the stylesheet default');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  assert.match(css, /\.un-toast \{\n  --un-toast-inset-bottom: var\(--platform-tabs-h, 0px\);\n\}/,
    'with no measurement, the tab bar\'s height');
});
