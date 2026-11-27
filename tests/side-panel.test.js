'use strict';

// #platform-side-panel — the panel BESIDE a running app, on a desktop-width
// window (frontend/src/features/side-panel/).
//
// While an app runs on its App tab, its Workshop, its discussion, a proposal,
// an issue, a change and a conversation open in a panel beside it instead of
// replacing it. The panel is the platform itself, framed at
// `/?panel=1#<route>` in an embedded mode that draws no chrome, and the app's
// own frame is never re-parented, hidden or re-sourced: only #app-view's size
// changes.
//
// What is pinned, and each is a way it can be quietly wrong:
//
//   1. WHICH ADDRESSES GO TO THE PANEL, where Back climbs from each, and what
//      the header row calls them (routes.ts) — the spec's table, run.
//   2. THE ISLAND SHIPS HIDDEN AND FRAMELESS, byte-identical to its first
//      render, or hydration throws on every route.
//   3. THE CONTROLLER keeps the panel's history OUT of the browser's: every
//      page is a navigation inside one frame, Back walks a stack and then
//      climbs, Close keeps the frame, the app leaving drops it, and Expand is
//      one real navigation of the top window.
//   4. THE CHOKEPOINTS refuse a navigation before it lands — a link, a
//      script's location.hash — and only at the moment the panel applies.
//   5. THE PANEL'S DOCUMENT never adds a history entry, never runs an app,
//      hands everything it does not show to the top window, and draws its
//      own page when the comment's picture asks (#4975).
//   6. THE ROUTER (public/js/app.js, run in a vm): openAppTab asks the panel
//      first, the running app leaving drops it, and in the panel's document
//      an App tab is forwarded, never parked, never polled for versions.
//   7. EMBEDDED MODE is decided before the first paint, only for a same-origin
//      frame, and every side effect the top window owns stands down there.
//
// The sources, bundled together through tests/fixtures/side-panel-api.ts (one
// copy of each store, as ./fixtures/parked-strip-api.ts explains):
//
//   frontend/src/features/side-panel/routes.ts       the address table
//   frontend/src/features/side-panel/store.js        the panel's state
//   frontend/src/features/side-panel/side-panel.tsx  the island
//   frontend/src/features/side-panel/controller.ts   the top document's side
//   frontend/src/features/side-panel/embedded.ts     the panel document's side
//   frontend/src/features/side-panel/mount.ts        the seams (read, not run)
//   frontend/src/features/side-panel/index.ts        the island's entry
//   frontend/src/lib/side-panel-mode.ts              "is this the panel?"

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('public/index.html');
const APP_JS = read('public/js/app.js');
const CSS = read('public/css/app.css');
const HEAD = read('frontend/src/head.html');
const SHELL = read('frontend/src/Shell.tsx');
const MAIN = read('frontend/src/main.tsx');

const api = loadTsx('tests/fixtures/side-panel-api.ts');
const R = api.routes;

// ── 1. The address table ─────────────────────────────────────────────────

test('the panel\'s pages: an app\'s work and conversations; its community is known but never the panel\'s', () => {
  const kinds = {
    'app/notes-ab12/workshop': 'workshop',
    'app/notes-ab12/board': 'workshop',
    'app/notes-ab12/activity': 'workshop',
    'app/notes-ab12/dev': 'workshop',
    'app/notes-ab12/dev/proposals': 'workshop',
    'app/notes-ab12/dev/proposals/12': 'proposal',
    'app/notes-ab12/dev/governance/3': 'proposal',
    'app/notes-ab12/dev/issues/7': 'issue',
    // A change's old address is its page's; its old New change address is
    // the top window's, which the router takes to Homeroom bot.
    'app/notes-ab12/dev/sessions/new': 'workshop',
    'app/notes-ab12/dev/sessions/41': 'proposal',
    'app/notes-ab12/dev/shared/41': 'change',
    // #3653: an app's discussion is its project page's Discussion tab, so
    // its old addresses are that page.
    'app/notes-ab12/dev/chat': 'workshop',
    'app/notes-ab12/group-chat': 'workshop',
    'messages/app/notes-ab12': 'workshop',
    'messages/4242': 'thread',
    'messages': 'messages',
  };
  for (const [route, kind] of Object.entries(kinds)) {
    const page = R.panelPage(route);
    assert.equal(page && page.kind, kind, route);
    // 18 Oct 2026: a community's page (and its old discussion addresses) is a
    // place of its own: a link to it leaves the app, full screen, and the
    // panel's document hands it to the top window.
    const community = kind === 'workshop';
    assert.equal(R.isPanelRoute(route), !community && kind !== 'messages', `${route} beside the app`);
    assert.equal(R.embeddedAllows(route), !community, `the panel's own document shows ${route}`);
  }
  // Everything else is somewhere the panel does not go, Global Chat's old
  // addresses included: the top window opens Messages for them. An old agent
  // session's address is the top window's too: the router takes it to
  // Homeroom bot.
  for (const route of ['', 'apps', 'apps/notes-ab12', 'workshop', 'profile', 'profile/dana',
    'settings', 'leaderboard', 'admin', 'notifications', 'create',
    'app/notes-ab12', 'app/notes-ab12/app', 'app/notes-ab12/full',
    'chat', 'chat/5f0c1d2e-aaaa-bbbb-cccc-000000000001', 'agent/7', 'agent/new']) {
    assert.equal(R.panelPage(route), null, `${route || '(home)'} is not a panel page`);
    assert.equal(R.isPanelRoute(route), false);
    assert.equal(R.embeddedAllows(route), false);
  }
});

test('the inbox is where Back climbs to, but a link to it is the Messages TAB and leaves the app', () => {
  assert.equal(R.isPanelRoute('messages'), false, 'the sidebar\'s tabs keep their meaning');
  assert.equal(R.embeddedAllows('messages'), true, 'and the panel\'s own document still shows it');
  for (const route of ['messages/4242', 'app/other-app/dev/proposals/9']) {
    assert.equal(R.isPanelRoute(route), true, `${route} opens beside the app`);
  }
  // A community leaves the app too, like a tab, wherever it is linked from.
  for (const route of ['app/notes-ab12/workshop', 'messages/app/notes-ab12', 'app/notes-ab12/dev/chat']) {
    assert.equal(R.isPanelRoute(route), false, `${route} opens full screen`);
  }
});

test('a `#name` channel reference opens beside the app, and is a pointer, never a page to come back to', () => {
  // #2783: `#messages/channel/<handle>` is what a `#name` in any chat links
  // to; the Messages store replaces it with the channel's own address.
  const page = R.panelPage('messages/channel/general');
  assert.deepEqual(page && { kind: page.kind, key: page.key },
    { kind: 'thread', key: 'messages/channel/general' });
  assert.equal(R.isPanelRoute('messages/channel/general'), true, 'a channel is a conversation');
  assert.equal(R.embeddedAllows('messages/channel/notes'), true);
  assert.equal(R.parentRoute('messages/channel/general'), 'messages');
  assert.equal(R.titleFor('messages/channel/general', ''), 'Messages');
  assert.equal(R.isPointer('messages/channel/general'), true);
  for (const route of ['messages/4242', 'messages/app/notes-ab12', 'messages', 'messages/channel',
    'app/notes-ab12/workshop', '', null]) {
    assert.equal(R.isPointer(route), false, `${route} is a page of its own`);
  }
  // No handle: the store sends it to the inbox, which is the Messages tab.
  assert.equal(R.panelPage('messages/channel').kind, 'messages');
  assert.equal(R.isPanelRoute('messages/channel'), false);
});

test('an app\'s App tab is never the panel\'s: it names the app to hand to the top window', () => {
  assert.equal(R.appTabSlug('app/notes-ab12'), 'notes-ab12');
  assert.equal(R.appTabSlug('app/notes-ab12/app'), 'notes-ab12');
  assert.equal(R.appTabSlug('app/notes-ab12/full'), 'notes-ab12');
  assert.equal(R.appTabSlug('app/notes-ab12/workshop'), null);
  assert.equal(R.appTabSlug('messages/12'), null);
});

test('Back climbs: a message to Messages; a proposal, an issue or a change has nothing above it here', () => {
  // #3653: an app's discussion is its project page, which has nothing above it.
  assert.equal(R.parentRoute('messages/app/notes-ab12'), null);
  assert.equal(R.parentRoute('app/notes-ab12/dev/chat'), null);
  assert.equal(R.samePage('messages/app/notes-ab12/thread/7', 'app/notes-ab12/workshop'), true,
    'the redirect to the page is not a navigation');
  assert.equal(R.samePage('app/notes-ab12/dev/chat', 'app/notes-ab12/workshop'), true);
  assert.equal(R.parentRoute('messages/4242'), 'messages');
  // Its community is never the panel's, and climbing to it would leave the app.
  for (const route of ['app/notes-ab12/dev/proposals/12', 'app/notes-ab12/dev/issues/7',
    'app/notes-ab12/dev/sessions/41', 'app/notes-ab12/dev/sessions/new', 'app/notes-ab12/dev/shared/41']) {
    assert.equal(R.parentRoute(route), null, route);
  }
  assert.equal(R.parentRoute('app/notes-ab12/workshop'), null);
  assert.equal(R.parentRoute('messages'), null);
});

test('the title is the page\'s own header title, except where that would only name the app', () => {
  assert.equal(R.titleFor('messages/4242', 'Design review'), 'Design review');
  assert.equal(R.titleFor('messages/app/notes-ab12', 'Notes'), 'Community', 'a discussion is its project page (#3653)');
  assert.equal(R.titleFor('app/notes-ab12/workshop', 'Notes'), 'Community', 'the project page is titled Community, as the prototype titled it');
  assert.equal(R.titleFor('messages', 'Inbox'), 'Messages', 'and the inbox is Messages');
  assert.equal(R.titleFor('app/notes-ab12/dev/proposals/12', 'Notes'), 'Proposal');
  assert.equal(R.titleFor('app/notes-ab12/dev/issues/7', 'Notes'), 'Request');
  assert.equal(R.titleFor('app/notes-ab12/dev/shared/41', 'Notes'), 'Change');
  assert.equal(R.titleFor('app/notes-ab12/dev/sessions/41', 'Notes'), 'Proposal', 'a change\'s old address is its page');
  // Derived from the route while the document has said nothing yet.
  assert.equal(R.titleFor('app/notes-ab12/workshop', ''), 'Community');
  assert.equal(R.titleFor('messages/4242', ''), 'Messages');
  assert.equal(R.titleFor('messages/app/notes-ab12', ''), 'Community');
});

test('the panel document\'s address keeps the top window\'s query, less its own and the load-scoped ones', () => {
  const url = R.frameUrl('app/notes-ab12/workshop',
    '?demo=1&token=abc&theme=dark&shot=improve&path=%2Fx&return_to=%2Fy&un-native-webview=1&panel=0');
  const parsed = new URL(url, 'https://homeroom.test');
  assert.equal(parsed.pathname, '/');
  assert.equal(parsed.hash, '#app/notes-ab12/workshop');
  assert.equal(parsed.searchParams.get('panel'), '1');
  assert.equal(parsed.searchParams.get('demo'), '1', 'a demo session stays a demo session');
  assert.equal(parsed.searchParams.get('token'), 'abc', 'a staging preview keeps its token');
  assert.equal(parsed.searchParams.get('theme'), 'dark');
  for (const key of ['shot', 'path', 'return_to', 'un-native-webview']) {
    assert.equal(parsed.searchParams.has(key), false, `${key} belongs to the top window's load`);
  }
  assert.equal(R.frameUrl('messages/1', ''), '/?panel=1#messages/1');
});

test('an address\'s route: the fragment wins, a clean app path counts, a fragment query does not', () => {
  assert.equal(R.routeFromUrl('https://h.test/app/x/workshop?panel=1'), 'app/x/workshop');
  assert.equal(R.routeFromUrl('https://h.test/app/x?panel=1#messages/4'), 'messages/4');
  assert.equal(R.routeFromUrl('https://h.test/#app/x/full?path=/t/1'), 'app/x/full');
  assert.equal(R.routeFromUrl('https://h.test/?demo=1'), '');
  assert.equal(R.routeFromUrl('#messages/app/x', 'https://h.test/app/y'), 'messages/app/x');
  assert.equal(R.isShellAddress('https://h.test/app/x', 'https://h.test'), true);
  assert.equal(R.isShellAddress('https://h.test/?q#messages', 'https://h.test'), true);
  assert.equal(R.isShellAddress('https://h.test/api/apps', 'https://h.test'), false);
  assert.equal(R.isShellAddress('https://github.com/x/y', 'https://h.test'), false);
  assert.equal(R.samePage('app/x/workshop', 'app/x/dev'), true, 'a canonical rewrite is the same page');
  assert.equal(R.samePage('app/x/dev/proposals/1', 'app/x/dev/proposals/2'), false);
});

// ── 2. The island ────────────────────────────────────────────────────────

test('the host ships in every document, hidden, frameless, named, with only the column\'s own row', () => {
  const at = HTML.indexOf('<aside id="platform-side-panel"');
  assert.ok(at > 0, 'the panel host is part of the shipped shell');
  const el = HTML.slice(at, HTML.indexOf('</aside>', at) + 8);
  assert.match(el, /^<aside id="platform-side-panel" class="side-panel hidden" aria-label="Side panel"/,
    'hidden, with the class a CONSTANT so the hydrating render agrees');
  assert.doesNotMatch(el, /<iframe/, 'no frame until a panel is opened');
  assert.doesNotMatch(el, /data-thread-pill/, 'no page yet, so no pill of its own to step aside for');
  // 18 Nov 2026: the row the panel drew beside a running app (Back, the
  // page's title, Expand, Close) went with that panel.
  assert.doesNotMatch(el, /id="side-panel-(back|title|expand|close)"/);
  assert.match(el, /<button type="button" aria-label="Close panel" title="Close panel" class="side-panel-ai-close /);
  // The first client render is the prerender.
  api._resetForTests();
  const first = renderToHtml(createElement(api.SidePanelIsland, {}));
  assert.equal(first, el, 'the island\'s first render is byte-for-byte the shipped markup');
});

test('an open panel renders ONE frame, at a constant address, with the spinner after it', () => {
  api._resetForTests();
  api.sidePanelStore.set({
    open: true, frameSrc: '/?panel=1#messages/4', frameKey: 3, route: 'messages/4',
    title: 'Design review', canBack: true, loading: true,
  });
  const loading = renderToHtml(createElement(api.SidePanelIsland, {}));
  assert.match(loading, /<iframe id="side-panel-frame" title="Side panel" src="\/\?panel=1#messages\/4" class="side-panel-frame" data-un-keyboard-relay=""><\/iframe><div id="side-panel-loading"/,
    'the frame is the body\'s first child, transparent while its document boots');
  api.sidePanelStore.set({ loading: false, route: 'app/x/dev/proposals/1', title: 'Proposal' });
  const ready = renderToHtml(createElement(api.SidePanelIsland, {}));
  assert.match(ready, /src="\/\?panel=1#messages\/4" class="side-panel-frame side-panel-frame-ready"/,
    'the src does not follow the route: the frame is navigated from inside, never re-sourced');
  api._resetForTests();
});

test('the island is wrapped and placed beside the app view; its seams mount at the entry', () => {
  assert.match(SHELL, /<Island name="AppViewIsland"><AppViewIsland \/><\/Island>[\s\S]*?<Island name="SidePanel"><SidePanel \/><\/Island>/);
  assert.match(MAIN, /import '\.\/features\/side-panel\/mount';/);
  assert.match(SHELL, /import \{ SidePanel \} from '\.\/features\/side-panel';/);
  const MOUNT = read('frontend/src/features/side-panel/mount.ts');
  assert.match(MOUNT, /sidePanelStore\.setFlush\(flushSync\);/,
    'the router hides the panel inside a transition callback, so the update lands synchronously');
  assert.match(MOUNT,
    /if \(isEmbeddedPanel\(\)\) \{\s*const runtime = installEmbeddedRuntime\(window\);[\s\S]*?\} else \{\s*installIntercepts\(window\);/,
    'the runtime in the panel\'s document, the intercepts in the top one, never both');
  assert.match(MOUNT, /document\.documentElement\.toggleAttribute\('data-side-panel', on\);/,
    '<html> is not React-owned: the layout\'s attribute is written directly, from the store');
  const SRC = read('frontend/src/features/side-panel/side-panel.tsx');
  assert.match(SRC, /useHiddenClass\(rootRef, !\(s\.open && !!s\.frameSrc\)\)/);
  assert.doesNotMatch(SRC, /backRef|side-panel-back/, 'no Back of its own: the bot page\'s column has a ×');
  assert.match(SRC, /key=\{s\.frameKey\}/, 'one element per frame, keyed by its generation alone');
  assert.doesNotMatch(SRC, /gray-|indigo-/);
});

// ── 3 & 4. The controller, driven ────────────────────────────────────────

// The top window as the controller sees it. By default the Homeroom bot
// tab's page is up, the one place the panel stands since 18 Nov 2026 (it no
// longer opens beside a running app); `app`, `tab` and `visible` say what the
// app view holds, which no longer decides anything.
function topWindow({ width = 1280, app = 'notes-ab12', tab = 'app', chromeless = false,
  visible = true, user = { id: 1 }, native = false, embedded = false, screen = 'ai-screen' } = {}) {
  const pushed = [];
  const routed = [];
  const opened = [];
  const timers = [];
  const classes = new Set([native ? 'in-native-webview' : null, embedded ? 'in-side-panel' : null].filter(Boolean));
  const win = {
    location: new URL(`https://homeroom.test/app/${app || 'none'}?demo=1`),
    history: {
      state: null,
      pushState: (s, t, url) => pushed.push(url),
      replaceState: (s, t, url) => { win.location = new URL(url, win.location.href); },
    },
    matchMedia: (q) => ({ matches: q === '(min-width: 1024px)' ? width >= 1024
      : q === '(min-width: 768px)' ? width >= 768
        : q === '(min-width: 1180px)' ? width >= 1180 : false }),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    App: {
      user, chromeless, currentApp: app, currentTab: tab,
      _isScreenVisible: (id) => (id === 'app-view' && visible) || (screen !== null && id === screen),
      _rootUrl: (hash) => `/?demo=1${hash || ''}`,
      _routeFromHash: () => routed.push(win.location.href),
      navigateHome: () => routed.push('home'),
      openAppTab: (slug, t) => opened.push([slug, t]),
    },
  };
  globalThis.window = win;
  globalThis.document = { documentElement: { classList: { contains: (c) => classes.has(c) } } };
  return { win, pushed, routed, opened, flush: () => { while (timers.length) timers.shift()(); } };
}

function fakeFrame() {
  const gone = [];
  const frame = {
    contentWindow: { UsernodeReact: { sidePanelEmbed: { go: (route) => gone.push(route) } } },
  };
  api.sidePanelRefs.frame = frame;
  return gone;
}

function cleanup() {
  api._resetForTests();
  delete globalThis.window;
  delete globalThis.document;
}

test('the panel takes a navigation only beside the AI tab\'s page, from 768px, in the top document', () => {
  const app = { screen: null };
  const cases = [
    [{}, true, 'the AI tab\'s page, where it takes the place of the chat docked beside the list'],
    // 1 Nov 2026: the AI tab docks its column from 768px, so the panel takes its place there too.
    [{ width: 1023 }, true, 'the AI tab from 768px, where its column is docked'],
    [{ width: 767 }, false, 'the AI tab on a phone, where nothing is docked'],
    [{ chromeless: true }, false, 'the AI tab, chromeless'],
    [{ screen: 'messages-screen' }, false, 'any other platform screen'],
    // 18 Nov 2026: never beside a running app any more; its link opens the page itself.
    [app, false, 'an app on its App tab, 1280 wide'],
    [{ ...app, width: 390 }, false, 'an app on a phone'],
    [{ user: null }, false, 'signed out'],
    // 1 Nov 2026: iPhone Duo unfolded and held sideways docks the AI tab's
    // column, and a request from its list belongs in Main's place there too.
    [{ native: true, width: 951 }, true, 'the native app\'s WebView, beside the AI tab\'s page'],
    [{ native: true, width: 669 }, false, 'the native app on a phone-width screen, where nothing is docked'],
    [{ embedded: true }, false, 'inside the panel itself'],
  ];
  for (const [opts, expected, why] of cases) {
    topWindow(opts);
    assert.equal(api.canTake(), expected, why);
    assert.equal(api.take('app/notes-ab12/dev/proposals/12'), expected, `take: ${why}`);
    cleanup();
  }
  topWindow();
  assert.equal(api.take('messages'), false, 'the inbox itself is the Messages tab, never the panel');
  assert.equal(api.take('app/notes-ab12/workshop'), false, 'nor is a community: it leaves the page, full screen');
  assert.equal(api.take('messages/app/notes-ab12'), false, 'by its old discussion address too');
  assert.equal(api.take('profile/dana'), false);
  assert.equal(api.sidePanelStore.get().frameSrc, null);
  cleanup();
});

test('opening starts ONE document, and later pages are navigations inside it', () => {
  topWindow();
  assert.equal(api.take('app/notes-ab12/dev/issues/7'), true);
  let s = api.sidePanelStore.get();
  assert.equal(s.open, true);
  assert.equal(s.frameSrc, '/?demo=1&panel=1#app/notes-ab12/dev/issues/7');
  assert.equal(s.frameKey, 1);
  assert.equal(s.loading, true);
  assert.equal(s.title, 'Request', 'titled from the route until the document says');
  assert.equal(s.canBack, false);
  const gone = fakeFrame();
  // A second page asked for while it boots is where it goes once it can.
  api.take('messages/4242');
  assert.deepEqual(gone, [], 'nothing to tell a document that has not booted');
  api.embeddedApi.ready('app/notes-ab12/dev/issues/7', 'Notes');
  assert.deepEqual(gone, ['messages/4242']);
  s = api.sidePanelStore.get();
  assert.equal(s.loading, false);
  assert.equal(s.route, 'messages/4242');
  assert.equal(s.canBack, true, 'the request it was opened on is behind it');
  api.embeddedApi.navigated('messages/4242', 'Design review', false);
  assert.equal(api.sidePanelStore.get().title, 'Design review');
  // Another page: the same frame, navigated.
  api.take('app/notes-ab12/dev/proposals/12');
  assert.deepEqual(gone.at(-1), 'app/notes-ab12/dev/proposals/12');
  assert.equal(api.sidePanelStore.get().frameKey, 1, 'never a second frame');
  assert.equal(api.sidePanelStore.get().title, 'Proposal');
  cleanup();
});

test('Back walks the pages opened in the panel, and a piece of work climbs no further', () => {
  topWindow();
  api.take('app/notes-ab12/dev/sessions/41');
  const gone = fakeFrame();
  api.embeddedApi.ready('app/notes-ab12/dev/sessions/41', 'Notes');
  // The viewer goes somewhere inside the panel: a push.
  api.embeddedApi.navigated('app/notes-ab12/dev/proposals/12', 'Notes', true);
  // A canonical rewrite of the same page is not.
  api.embeddedApi.navigated('app/notes-ab12/dev/proposals/12', 'Notes', true);
  assert.equal(api.sidePanelStore.get().canBack, true);
  api.back();
  assert.deepEqual(gone.at(-1), 'app/notes-ab12/dev/sessions/41', 'back to the change');
  assert.equal(api.sidePanelStore.get().title, 'Proposal', 'its old address is its page');
  assert.equal(api.sidePanelStore.get().canBack, false,
    'nothing above a change here: its community is never the panel\'s');
  const count = gone.length;
  api.back();
  assert.equal(gone.length, count, 'Back with nowhere to go goes nowhere');
  cleanup();
});

// ── #6970: the edge the frame's head card keeps clear of ────────────────

/** A frame whose document root takes the published edge. */
function fakeEdgeFrame() {
  const props = new Map();
  const root = {
    style: {
      getPropertyValue: (n) => (props.has(n) ? props.get(n) : ''),
      setProperty: (n, v) => props.set(n, v),
      removeProperty: (n) => props.delete(n),
    },
  };
  api.sidePanelRefs.frame = { contentDocument: { documentElement: root } };
  return props;
}

/** The top window's <html>, as the strip publishes it. */
function topDocument({ side = null, corner = null, width = 0, dir = '' } = {}) {
  const attrs = {};
  if (side) attrs['data-side-strip'] = side;
  if (corner) attrs['data-side-corner'] = corner;
  const values = {
    '--platform-strip-w': side ? `${width}px` : '',
    '--platform-corner-w': corner ? `${width}px` : '',
  };
  globalThis.document = { documentElement: {
    dir,
    hasAttribute: (n) => Object.prototype.hasOwnProperty.call(attrs, n),
    getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
    style: { getPropertyValue: (n) => values[n] || '', setProperty() {}, removeProperty() {} },
  } };
}

test('the panel document is handed the edge it must keep clear of (#6970)', () => {
  topWindow();
  api.take('app/notes-ab12/dev/issues/7');
  const props = fakeEdgeFrame();
  topDocument();
  api.embeddedApi.ready('app/notes-ab12/dev/issues/7', 'Notes');
  assert.equal(props.has(api.EDGE_PROP), false, 'a browser tab has no system column: nothing written');

  topDocument({ side: 'right', width: 84 });
  api.appPresence(true);
  assert.equal(props.get(api.EDGE_PROP), '84px', 'the Duo held sideways: the column\'s width');

  topDocument({ corner: 'right', width: 52 });
  api.appPresence(true);
  assert.equal(props.get(api.EDGE_PROP), '52px', 'folded: the corner\'s width');

  topDocument({ side: 'right', width: 84, dir: 'rtl' });
  api.appPresence(true);
  assert.equal(props.has(api.EDGE_PROP), false,
    'in Arabic the column is left of the panel: the head card already clears it');
  cleanup();
});

test('the edge is on the frame before its page is shown, and follows the top root (#6970)', () => {
  // One observer per top document, started as the first frame opens.
  const callbacks = [];
  globalThis.MutationObserver = class {
    constructor(cb) { callbacks.push(cb); }
    observe() {}
    disconnect() {}
  };
  topWindow();
  const props = fakeEdgeFrame();
  api.take('app/notes-ab12/dev/issues/7');
  assert.equal(callbacks.length, 1, 'a frame opening starts the one observer');
  topDocument({ side: 'right', width: 84 });
  // A page that arrives while the phone is already folded: the edge is
  // written before the store says the panel is ready, never after.
  let atReady = null;
  const unsubscribe = api.sidePanelStore.subscribe(() => {
    if (!api.sidePanelStore.get().loading && atReady === null) {
      atReady = props.get(api.EDGE_PROP) || null;
    }
  });
  api.embeddedApi.ready('app/notes-ab12/dev/issues/7', 'Notes');
  unsubscribe();
  assert.equal(atReady, '84px', 'shown with the edge already on it');

  // Folded: `watchSideStrip` rewrites the top root, and the observer follows.
  topDocument({ corner: 'right', width: 52 });
  callbacks[0]();
  assert.equal(props.get(api.EDGE_PROP), '52px');

  // Unfolded, held upright: the band is a top inset, which the column's top
  // already sits below, so the frame clears nothing.
  topDocument();
  callbacks[0]();
  assert.equal(props.has(api.EDGE_PROP), false);
  delete globalThis.MutationObserver;
  cleanup();
});

test('Back never lands on a `#name` channel reference, which would only send it on again', () => {
  topWindow();
  api.take('app/notes-ab12/dev/proposals/12');
  const gone = fakeFrame();
  api.embeddedApi.ready('app/notes-ab12/dev/proposals/12', 'Notes');
  // A `#general` in the proposal's thread, followed inside the panel…
  api.embeddedApi.navigated('messages/channel/general', 'Messages', true);
  // …and the store's rewrite to the channel itself, reported late, as a push.
  api.embeddedApi.navigated('messages/88', '#general', true);
  let s = api.sidePanelStore.get();
  assert.equal(s.route, 'messages/88');
  assert.equal(s.title, '#general');
  api.back();
  assert.deepEqual(gone.at(-1), 'app/notes-ab12/dev/proposals/12',
    'back to the proposal the reference was followed from');
  // Opened from the top document too: the pointer is the panel's page until
  // the channel replaces it, and is never kept behind it.
  api.take('messages/channel/design');
  api.embeddedApi.navigated('messages/89', '#design', false);
  api.take('messages/4242');
  api.back();
  assert.deepEqual(gone.at(-1), 'messages/89');
  api.back();
  assert.deepEqual(gone.at(-1), 'app/notes-ab12/dev/proposals/12',
    'the pointer between them was skipped');
  s = api.sidePanelStore.get();
  assert.equal(s.canBack, false, 'and nothing is above the proposal here');
  cleanup();
});

test('Close keeps the frame and forgets the history; reopening navigates it', () => {
  topWindow();
  api.take('messages/4242');
  const gone = fakeFrame();
  api.embeddedApi.ready('messages/4242', 'Design review');
  api.embeddedApi.navigated('messages/4243', 'Standup', true);
  api.close();
  let s = api.sidePanelStore.get();
  assert.equal(s.open, false);
  assert.ok(s.frameSrc, 'the frame stays for a reopen');
  api.take('app/notes-ab12/dev/proposals/12');
  s = api.sidePanelStore.get();
  assert.equal(s.open, true);
  assert.equal(s.frameKey, 1, 'the same frame');
  assert.deepEqual(gone.at(-1), 'app/notes-ab12/dev/proposals/12');
  assert.equal(s.canBack, false, 'a closed panel reopens with no history');
  cleanup();
});

test('the app leaving the screen drops the panel and its frame; staying keeps it', () => {
  topWindow();
  api.take('app/notes-ab12/dev/proposals/12');
  fakeFrame();
  api.appPresence(true);
  assert.ok(api.sidePanelStore.get().frameSrc, 'another app replacing this one keeps the panel');
  api.appPresence(false);
  const s = api.sidePanelStore.get();
  assert.deepEqual({ ...s, frameKey: 0 }, { ...api.INITIAL }, 'back to the shipped state');
  assert.equal(s.frameKey, 1, 'the generation is kept, so a new frame is a new element');
  api.take('messages/1');
  assert.equal(api.sidePanelStore.get().frameKey, 2);
  cleanup();
});

test('Expand is ONE real navigation of the top window, with its own routing, then no panel', () => {
  const { pushed, routed } = topWindow();
  api.take('messages/4242');
  fakeFrame();
  api.embeddedApi.ready('messages/4242', 'Design review');
  api.expand();
  assert.deepEqual(pushed, ['/?demo=1#messages/4242'], 'pushed, as a history entry of its own');
  assert.equal(routed.length, 1, 'and routed once, at once');
  assert.equal(api.sidePanelStore.get().frameSrc, null, 'the panel is gone');
  cleanup();
});

test('Expand from the Homeroom bot column records the bot page as where the page came from (#7079)', () => {
  const { win, pushed } = topWindow();
  win.location = new URL('https://homeroom.test/?demo=1#homeroom-bot/request/notes-ab12/42');
  const seen = [];
  win.Improve = { enterTopicFrom: (href) => seen.push([href, pushed.length]) };
  assert.equal(api.take('app/notes-ab12/dev/issues/42'), true);
  api.expand();
  // Once, with the bot's own address, BEFORE the push: the origin is what the
  // topic route reads as it lands, so a page expanded this way gets the
  // "‹ Homeroom bot" chip (with "‹ Workshop" beside it) instead of a
  // "‹ Workshop" chip back to a place the reader never visited.
  assert.deepEqual(seen, [['#homeroom-bot/request/notes-ab12/42', 0]]);
  assert.deepEqual(pushed, ['/?demo=1#app/notes-ab12/dev/issues/42'], 'the page itself, as Expand opens it');
  cleanup();
});

test('Expand from anywhere but the bot page records no origin, so its back chip is unchanged (#7079)', () => {
  const { win, pushed } = topWindow();
  win.location = new URL('https://homeroom.test/app/notes-ab12?demo=1#app/notes-ab12');
  const seen = [];
  win.Improve = { enterTopicFrom: (href) => seen.push(href) };
  api.take('app/notes-ab12/dev/issues/42');
  api.expand();
  assert.deepEqual(seen, [], 'an app address is not an origin');
  assert.deepEqual(pushed, ['/?demo=1#app/notes-ab12/dev/issues/42']);
  cleanup();
});

test('Go to community opens the hub full width, leaving the app, because no community is the panel\'s', () => {
  // The app menu's row, beside a running app on a desktop, follows its own
  // link: a community's page is never taken for the panel (./routes.ts), so
  // the router's ordinary navigation replaces the app, and the router's leave
  // drops a panel that was open. Its old special case (openFullWidth) is gone.
  topWindow();
  assert.equal(api.take('app/notes-ab12/workshop'), false);
  cleanup();
  assert.equal(api.SidePanel.openFullWidth, undefined, 'nothing on the bridge for it');
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  const at = sheet.indexOf('id="app-menu-row-workshop"');
  const row = sheet.slice(at, sheet.indexOf('GO TO APP DISCUSSION and INVITE TO COMMUNITY', at));
  assert.doesNotMatch(row, /sidePanel/);
  assert.match(row, /onClick=\{\(e\) => openCommunityRow\(e, slug, owed\)\}/);
  const open = sheet.slice(sheet.indexOf('export function openCommunityRow('), sheet.indexOf('function isPlainClick('));
  assert.doesNotMatch(open, /sidePanel/);
  assert.match(open, /followThenDismiss\(e, slug \? `#app\/\$\{encodeURIComponent\(slug\)\}\/workshop` : '#'\);/);
});

test('the page the panel shows is in the top window\'s address, so a reload brings the panel back', () => {
  const { win, flush } = topWindow();
  const address = () => `${win.location.pathname}${win.location.search}`;
  assert.equal(api.take('messages/4242'), true);
  assert.equal(address(), '/app/notes-ab12?demo=1&side=messages/4242', 'in place, every other parameter kept');
  const gone = fakeFrame();
  api.embeddedApi.ready('messages/4242', 'Design review');
  api.embeddedApi.navigated('app/notes-ab12/dev/proposals/12', 'Notes', true);
  assert.equal(address(), '/app/notes-ab12?demo=1&side=app/notes-ab12/dev/proposals/12', 'and it follows the panel');
  api.close();
  assert.equal(address(), '/app/notes-ab12?demo=1', 'closed: out of the address');
  assert.equal(gone.length, 0);
  api._resetForTests();

  // A reload: the router reports no app while it boots, then the app comes
  // back on screen with ?side= and the panel opens there.
  win.location = new URL('https://homeroom.test/app/notes-ab12?side=messages/4242&demo=1');
  api.appPresence(false);
  assert.equal(win.location.search, '?side=messages/4242&demo=1', 'booting past "no app" keeps the note');
  api.appPresence(true);
  flush();
  const s = api.sidePanelStore.get();
  assert.equal(s.open, true);
  assert.equal(s.route, 'messages/4242');
  assert.equal(s.frameSrc, '/?demo=1&panel=1#messages/4242', 'the panel\'s own document does not inherit the note');
  // Leaving the app takes it out, so a later visit starts without a panel.
  api.appPresence(false);
  assert.equal(address(), '/app/notes-ab12?demo=1');

  // Only a page the panel shows is honoured; anything else is dropped.
  assert.equal(api.sideRouteFrom('?side=settings'), null);
  assert.equal(api.sideRouteFrom('?side=messages%2F4242'), 'messages/4242');
  assert.equal(api.sideRouteFrom('?demo=1'), null);
  cleanup();
});

test('a panel that cannot open where the address asks gives up and cleans the address', () => {
  const { win, flush } = topWindow({ width: 700 });
  win.location = new URL('https://homeroom.test/app/notes-ab12?demo=1&side=messages/4242');
  api.appPresence(true);
  for (let i = 0; i < 25; i += 1) flush();
  assert.equal(api.sidePanelStore.get().frameSrc, null, 'a narrow window has no room for it');
  assert.equal(`${win.location.search}`, '?demo=1');
  cleanup();
});

test('a panel link in the top document is refused before the browser follows it', () => {
  topWindow();
  const click = (href, extra = {}) => {
    const anchor = {
      href: new URL(href, 'https://homeroom.test/app/notes-ab12').href,
      target: extra.target || '', hasAttribute: (n) => n === 'download' && !!extra.download,
    };
    const e = {
      defaultPrevented: false, button: 0, metaKey: !!extra.meta, ctrlKey: false, shiftKey: false, altKey: false,
      target: { closest: () => anchor },
      preventDefault() { this.defaultPrevented = true; },
    };
    api.onClickCapture(e);
    return e.defaultPrevented;
  };
  assert.equal(click('#messages'), false, 'a tab root is followed');
  // A community, from the sidebar or any link: followed, full screen.
  assert.equal(click('#app/notes-ab12/workshop'), false, 'a community leaves the page, full screen');
  assert.equal(click('/app/notes-ab12/dev/c/onboarding'), false, 'its channels too');
  assert.equal(click('#app/notes-ab12/dev/proposals/12', { meta: true }), false, 'a new-tab click is the browser\'s');
  assert.equal(click('#app/notes-ab12/dev/proposals/12', { target: '_blank' }), false);
  assert.equal(api.sidePanelStore.get().frameSrc, null);
  assert.equal(click('#app/notes-ab12/dev/proposals/12'), true, 'a proposal is caught');
  assert.equal(api.sidePanelStore.get().route, 'app/notes-ab12/dev/proposals/12');
  assert.equal(click('https://github.com/x/y'), false, 'another site is not ours');
  cleanup();
  topWindow({ width: 700 });
  assert.equal(click('#app/notes-ab12/dev/proposals/12'), false, 'below the breakpoint the link is followed');
  cleanup();
  topWindow({ screen: null });
  assert.equal(click('#app/notes-ab12/dev/proposals/12'), false, 'from a running app the link is followed: it opens the page');
  cleanup();
});

test('the header\'s ✕ leaves the app, even when its href names a panel page', () => {
  // The ✕ goes back to the page the app was opened from (App.closeApp), and
  // its href names that page for a modified click — a thread or a Workshop
  // card as often as not. Caught here, closing the app opened that page
  // BESIDE it instead. The rail's tabs and the ✕ are the ways out (#2854).
  topWindow();
  const click = (id, href) => {
    const anchor = {
      id, href: new URL(href, 'https://homeroom.test/app/notes-ab12').href,
      target: '', hasAttribute: () => false,
    };
    const e = {
      defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      target: { closest: () => anchor },
      preventDefault() { this.defaultPrevented = true; },
    };
    api.onClickCapture(e);
    return e.defaultPrevented;
  };
  assert.equal(click('back-btn', '/#messages/4242'), false, 'the ✕ is left to its own handler');
  assert.equal(click('back-btn', '/app/notes-ab12/dev/proposals/12'), false);
  assert.equal(click('app-menu-row-workshop', '/#app/notes-ab12/workshop'), false,
    'so is the app menu\'s Go to community, which opens the hub full width, as every community link does');
  assert.equal(api.sidePanelStore.get().frameSrc, null, 'and no panel opened');
  assert.equal(click('some-row', '/#messages/4242'), true, 'while any other link to a thread is caught');
  cleanup();
});

test('a script\'s location.hash to a panel page is refused (Navigation API); a traversal never is', () => {
  topWindow();
  const nav = (type, url, extra = {}) => {
    const e = {
      navigationType: type, hashChange: true, cancelable: true, destination: { url },
      canceled: false, preventDefault() { this.canceled = true; }, ...extra,
    };
    api.onNavigate(e);
    return e.canceled;
  };
  assert.equal(nav('traverse', 'https://homeroom.test/#messages/4242'), false,
    'Back to a page you were on before the app is leaving the app');
  assert.equal(nav('push', 'https://homeroom.test/app/notes-ab12#messages', {}), false);
  assert.equal(nav('push', 'https://homeroom.test/app/notes-ab12#messages/4242'), true);
  assert.equal(api.sidePanelStore.get().route, 'messages/4242');
  cleanup();
});

test('the panel never runs an app: it asks the top window, which opens it and leaves the bot\'s page', () => {
  const { opened, flush } = topWindow();
  api.embeddedApi.openApp('notes-ab12');
  flush();
  assert.deepEqual(opened, [['notes-ab12', 'app']], 'no app stands beside the panel any more (18 Nov 2026)');
  api.embeddedApi.openApp('other-app');
  flush();
  assert.deepEqual(opened, [['notes-ab12', 'app'], ['other-app', 'app']]);
  cleanup();
});

test('a page handed up from the panel replaces the top window\'s own entry, never pushes one (#7140)', () => {
  const { win, pushed, routed, flush } = topWindow();
  api.embeddedApi.swap('homeroom-bot/thread/9');
  assert.deepEqual(pushed, [], 'nothing is scheduled as a new entry');
  assert.equal(routed.length, 0, 'routed on the top window\'s own turn');
  flush();
  assert.deepEqual(pushed, [], 'still no history entry of its own');
  assert.equal(win.location.href, 'https://homeroom.test/?demo=1#homeroom-bot/thread/9',
    'the entry on screen is traded for the thread, in place');
  assert.deepEqual(routed, ['https://homeroom.test/?demo=1#homeroom-bot/thread/9'],
    'and the router runs it once');
  cleanup();
});

// ── 5. The panel's own document ──────────────────────────────────────────

function panelWindow({ href = 'https://homeroom.test/app/notes-ab12/workshop?panel=1', navigation = false, nested = false, captureHead = false } = {}) {
  let url = new URL(href);
  const listeners = {};
  const docListeners = {};
  const navListeners = [];
  const reports = [];
  const routed = [];
  const history = {
    state: null,
    pushes: [],
    pushState(s, t, u) { this.pushes.push(String(u)); url = new URL(String(u), url); },
    replaceState(s, t, u) { if (u != null) url = new URL(String(u), url); },
    back() { reports.push(['traversed']); },
    forward() {},
    go() {},
  };
  const fire = (type, ev = { type }) => (listeners[type] || []).slice().forEach((fn) => fn(ev));
  const win = {
    location: {
      get href() { return url.href; },
      get pathname() { return url.pathname; },
      get search() { return url.search; },
      get hash() { return url.hash; },
      get origin() { return url.origin; },
      replace(u) { url = new URL(String(u), url); fire('hashchange'); },
    },
    history,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(ev) { fire(ev.type, ev); return true; },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    queueMicrotask: (fn) => queueMicrotask(fn),
    open: (u) => reports.push(['opened', u]),
    document: {
      addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    },
    parent: {
      UsernodeReact: {
        sidePanel: {
          embedded: {
            ready: (route, title) => reports.push(['ready', route, title]),
            navigated: (route, title, push) => reports.push(['navigated', route, title, push]),
            openApp: (slug) => reports.push(['openApp', slug]),
            leave: (route) => reports.push(['leave', route]),
            back: () => reports.push(['back']),
            swap: (route) => reports.push(['swap', route]),
            // #6608: only when a test reads the head reports, so the existing
            // assertions on `reports.at(-1)` are unchanged.
            ...(captureHead ? { head: (route, head) => reports.push(['head', route, head]) } : {}),
          },
        },
      },
    },
    App: { _currentRoute: null, _routeFromHash: () => routed.push(url.href) },
  };
  if (navigation) {
    win.navigation = { addEventListener: (type, fn) => { if (type === 'navigate') navListeners.push(fn); } };
  }
  // A same-document navigation as the Navigation API announces it: returns
  // whether a listener refused it.
  const navigate = (navigationType, dest) => {
    const e = {
      navigationType, hashChange: true, cancelable: navigationType !== 'traverse',
      destination: { url: new URL(dest, url).href, sameDocument: true },
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
    };
    navListeners.forEach((fn) => fn(e));
    return e.defaultPrevented;
  };
  win.top = nested ? {
    get UsernodeReact() { throw new Error('SecurityError: cross-origin preview host'); },
  } : win.parent;
  const embedded = runHeadCheck({ nested });
  globalThis.document = { documentElement: { classList: { contains: (c) => embedded && c === 'in-side-panel' } } };
  if (typeof globalThis.PopStateEvent === 'undefined') {
    globalThis.PopStateEvent = class { constructor(type, init) { this.type = type; this.state = init && init.state; } };
  }
  const runtime = api.installEmbeddedRuntime(win);
  const boot = () => (docListeners['sv:authed'] || []).forEach((fn) => fn());
  return { win, runtime, reports, routed, history, fire, boot, navigate, url: () => url.href };
}
// The runtime reports from a 0 ms timer, and `go()` (or a refused hash push)
// sets that timer from a microtask, after the page has routed. A 5 ms timer
// started before the microtask ran could fire first when routing took more
// than 4 ms on a loaded machine, and the report was not there yet. Waiting
// for the next turn first lets the runtime's timer be set before this one,
// and timers fire in the order they expire.
const tick = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 5));
};

test('the runtime installs only in the panel\'s document', () => {
  globalThis.document = { documentElement: { classList: { contains: () => false } } };
  assert.equal(api.installEmbeddedRuntime({}), null, 'the top document is left alone');
  delete globalThis.document;
});

test('the runtime answers the comment\'s picture with this document\'s own page (#4975)', async () => {
  // The drawing module is imported only when a picture is asked for: no
  // comment work loads in a panel that is never screenshotted.
  assert.match(read('frontend/src/features/side-panel/embedded.ts'), /import\('\.\.\/comment-pin\/picture'\)/);
  const p = panelWindow();
  assert.equal(typeof p.runtime.picture, 'function');
  // A panel still booting has nothing settled to draw: null, without
  // touching the page.
  assert.equal(await p.runtime.picture(1), null);
  p.boot();
  await tick();
  assert.equal(p.runtime.isBooted(), true);
  // After boot it draws on this document's own turn (a 0 ms timer), and a
  // draw that fails in this realm — here there is no page to draw — resolves
  // null, never a rejection.
  assert.equal(await p.runtime.picture(1), null);
});

test('the panel keeps one picture draw in flight and shares it', async () => {
  const p = panelWindow();
  p.boot();
  await tick();
  assert.equal(p.runtime.isBooted(), true);
  // Two asks made back to back — a scroll retake landing on a pin, say —
  // share the draw in flight instead of stacking a second capture of the
  // same document while the first is still running.
  const first = p.runtime.picture(1);
  const second = p.runtime.picture(1);
  assert.equal(second, first, 'the second ask shares the draw in flight');
  assert.equal(await first, null);
  // Once settled, the next ask starts a fresh draw.
  const third = p.runtime.picture(1);
  assert.notEqual(third, first, 'a settled draw is not handed out again');
  await third;
});

test('a panel inside Preview reports readiness and navigation to its immediate parent', async () => {
  const p = panelWindow({ nested: true, href: 'https://homeroom.test/?panel=1#messages/app/notes-ab12' });
  try {
    assert.notEqual(p.win.parent, p.win.top, 'Preview is itself framed');
    assert.ok(p.runtime, 'the head check enables the embedded runtime');
    p.boot();
    await tick();
    assert.equal(p.runtime.isBooted(), true);
    assert.deepEqual(p.reports[0], ['ready', 'messages/app/notes-ab12', ''],
      'the Preview can reveal Discussion instead of keeping its loading cover');
    p.runtime.go('app/notes-ab12/dev/proposals/12');
    await tick();
    assert.deepEqual(p.reports.at(-1), ['navigated', 'app/notes-ab12/dev/proposals/12', '', false]);
    assert.deepEqual(p.history.pushes, [], 'the next page reuses the same panel');
  } finally {
    delete globalThis.document;
  }
});

test('the panel\'s document adds no history entry, and reports each page to the top', async () => {
  const p = panelWindow();
  p.boot();
  await tick();
  // No page has titled the header yet: the store's placeholder (the
  // platform's name) is reported as nothing, and the top titles the kind.
  assert.deepEqual(p.reports[0], ['ready', 'app/notes-ab12/workshop', '']);
  // The router pushes (updateHash, a proposal opened from the board)…
  p.win.history.pushState(null, '', '/app/notes-ab12/dev/proposals/12?panel=1');
  assert.deepEqual(p.history.pushes, [], '…and it becomes a replace: no entry in the joint history');
  await tick();
  assert.deepEqual(p.reports.at(-1), ['navigated', 'app/notes-ab12/dev/proposals/12', '', true]);
  // A canonical rewrite is the same page settling.
  p.win.history.replaceState(null, '', '/app/notes-ab12/dev/proposals/12?panel=1');
  await tick();
  assert.equal(p.reports.at(-1)[3], false);
  // A title that loads is a report too.
  api.headerTitleStore.set({ text: 'Notes', subtitle: '' });
  await tick();
  assert.deepEqual(p.reports.at(-1), ['navigated', 'app/notes-ab12/dev/proposals/12', 'Notes', false]);
  api.headerTitleStore.set({ text: 'Homeroom', subtitle: '' });
  // history.back() in here is the panel's Back, never a traversal of the top window.
  p.win.history.back();
  assert.deepEqual(p.reports.at(-1), ['back']);
  assert.ok(!p.reports.some((r) => r[0] === 'traversed'));
  delete globalThis.document;
});

test('the top document sends the panel somewhere by replacing its address and routing it', async () => {
  const p = panelWindow();
  p.boot();
  await tick();
  p.runtime.go('messages/app/notes-ab12');
  // Not inside the top window's call: on this document's own turn, so a
  // relative location.replace() in the router resolves against THIS address
  // (the browser resolves it against the entry document, which inside the
  // call would be the top window — see go() in embedded.ts).
  assert.equal(p.routed.length, 0, 'nothing is routed inside the top window\'s call');
  assert.equal(p.url(), 'https://homeroom.test/app/notes-ab12/workshop?panel=1');
  await tick();
  assert.equal(p.url(), 'https://homeroom.test/?panel=1#messages/app/notes-ab12');
  assert.equal(p.routed.length, 1, 'routed through the router\'s own entry point');
  assert.deepEqual(p.reports.at(-1), ['navigated', 'messages/app/notes-ab12', '', false],
    'the top put it there, so it is already on the top\'s stack');
  p.runtime.go('app/notes-ab12/dev/proposals/12');
  await tick();
  assert.equal(p.url(), 'https://homeroom.test/app/notes-ab12/dev/proposals/12?panel=1');
  delete globalThis.document;
});

test('what the panel does not show goes to the top window, and the address stays on the page', async () => {
  const p = panelWindow({ href: 'https://homeroom.test/?panel=1#messages/4242' });
  assert.equal(p.runtime.forward('profile/dana'), false, 'nothing is forwarded before the first page');
  p.boot();
  await tick();
  assert.equal(p.runtime.forward('messages/4243'), false, 'a panel page is its own');
  // A profile link inside the panel: the hash has already moved.
  p.win.history.replaceState(null, '', '/?panel=1#profile/dana');
  assert.equal(p.runtime.forward('profile/dana'), true);
  assert.deepEqual(p.reports.at(-1), ['leave', 'profile/dana']);
  assert.equal(p.url(), 'https://homeroom.test/?panel=1#messages/4242', 'put back on the page on screen');
  assert.equal(p.runtime.forward('app/other-app'), true);
  assert.deepEqual(p.reports.at(-1), ['openApp', 'other-app'], 'an App tab goes to the running app');
  p.runtime.openApp('notes-ab12');
  assert.deepEqual(p.reports.at(-1), ['openApp', 'notes-ab12']);
  delete globalThis.document;
});

test('a page the panel must not draw is handed to the top window in place, before and after boot (#7140)', async () => {
  const p = panelWindow({ href: 'https://homeroom.test/?panel=1#app/notes-ab12/dev/changes/142' });
  // A frame whose FIRST page is the address to hand up: it moves nothing
  // here, and the hand-off still reaches the top (it is not gated on boot).
  assert.equal(p.runtime.handTop('homeroom-bot/thread/9'), true);
  assert.deepEqual(p.reports.at(-1), ['swap', 'homeroom-bot/thread/9']);
  assert.equal(p.url(), 'https://homeroom.test/?panel=1#app/notes-ab12/dev/changes/142',
    'a document still booting has no settled page to put back');
  p.boot();
  await tick();
  // After boot the document is put back on the page it was showing, then the
  // top is told — never left on an address it is not drawing.
  p.win.history.replaceState(null, '', '/?panel=1#homeroom-bot/thread/9');
  assert.equal(p.runtime.handTop('homeroom-bot/thread/9'), true);
  assert.deepEqual(p.reports.at(-1), ['swap', 'homeroom-bot/thread/9']);
  assert.equal(p.url(), 'https://homeroom.test/?panel=1#app/notes-ab12/dev/changes/142',
    'put back on the page this document was showing');
  // No top panel API at all (the frame opened on its own): nothing moves, and
  // the caller hears that nothing did.
  p.win.parent.UsernodeReact = {};
  assert.equal(p.runtime.handTop('homeroom-bot/thread/9'), false);
  delete globalThis.document;
});

test('a link inside the panel is followed in place, keeping panel=1', async () => {
  const p = panelWindow({ href: 'https://homeroom.test/?panel=1&demo=1#messages' });
  p.boot();
  await tick();
  const click = (href) => {
    const anchor = {
      href: new URL(href, p.url()).href, target: '', hasAttribute: () => false,
    };
    const e = {
      defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      target: { closest: () => anchor }, preventDefault() { this.defaultPrevented = true; },
    };
    (p.win.__clicks ||= []);
    p.fire('click', e);
    return e.defaultPrevented;
  };
  assert.equal(click('#messages/4243'), true);
  assert.equal(p.url(), 'https://homeroom.test/?panel=1&demo=1#messages/4243', 'a replace, not a push');
  await tick();
  assert.deepEqual(p.reports.at(-1), ['navigated', 'messages/4243', '', true]);
  assert.equal(click('/app/notes-ab12/dev/issues/7'), true);
  assert.equal(p.url(), 'https://homeroom.test/app/notes-ab12/dev/issues/7?panel=1&demo=1',
    'a clean path keeps this document\'s query');
  assert.equal(click('https://github.com/x/y'), false, 'another site is the browser\'s');
  delete globalThis.document;
});

test('a script\'s hash push is refused and replayed as a replace; the store\'s own replace is the page settling', async () => {
  const p = panelWindow({ href: 'https://homeroom.test/?panel=1#app/notes-ab12/dev/proposals/12', navigation: true });
  p.boot();
  await tick();
  // `location.hash = '#messages/channel/general'` — a `#general` in the thread.
  assert.equal(p.navigate('push', '#messages/channel/general'), true, 'refused: it would be an entry');
  await tick();
  assert.equal(p.url(), 'https://homeroom.test/?panel=1#messages/channel/general');
  assert.deepEqual(p.reports.at(-1), ['navigated', 'messages/channel/general', '', true]);
  // The Messages store's `location.replace('#messages/88')` once it knows the
  // room: let through, and NOT a second page — Back from #general must not
  // land on the reference that only sends it here again.
  assert.equal(p.navigate('replace', '#messages/88'), false, 'a replace is let through');
  p.win.location.replace('#messages/88');
  await tick();
  assert.deepEqual(p.reports.at(-1), ['navigated', 'messages/88', '', false]);
  assert.equal(p.navigate('traverse', '#messages'), false, 'and a traversal is never touched');
  delete globalThis.document;
});

test('without the Navigation API an unannounced hash change is taken for a push', async () => {
  // Where a script's `location.hash = …` cannot be refused, it arrives only as
  // a hashchange, and the viewer did go somewhere.
  const p = panelWindow({ href: 'https://homeroom.test/?panel=1#messages/4242' });
  p.boot();
  await tick();
  p.win.location.replace('#messages/4243');
  await tick();
  assert.deepEqual(p.reports.at(-1), ['navigated', 'messages/4243', '', true]);
  delete globalThis.document;
});

// ── 6. The router, run in a vm ───────────────────────────────────────────

function fakeElement() {
  const classes = new Set();
  const attrs = new Map();
  return {
    classList: {
      add: (...n) => n.forEach((x) => classes.add(x)),
      remove: (...n) => n.forEach((x) => classes.delete(x)),
      toggle: (n, force) => { const on = force === undefined ? !classes.has(n) : !!force; if (on) classes.add(n); else classes.delete(n); return on; },
      contains: (n) => classes.has(n),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    style: {}, innerHTML: '', textContent: '',
    querySelector: () => null, querySelectorAll: () => [], appendChild() {}, addEventListener() {},
  };
}

function router({ embedded = false, takes = true } = {}) {
  const calls = [];
  const stored = [];
  const elements = new Map();
  const noop = () => undefined;
  const root = fakeElement();
  if (embedded) root.classList.add('in-side-panel');
  const context = vm.createContext({
    PlatformI18n: require('./lib/platform-i18n').englishPlatformI18n(),
    location: new URL('https://homeroom.test/'),
    history: { pushState() {}, replaceState() {}, state: null },
    URL, URLSearchParams, console, setTimeout, clearTimeout,
    fetch: (u) => { calls.push(['fetch', u]); return Promise.resolve({ ok: false }); },
    document: {
      title: '',
      documentElement: root,
      getElementById: (id) => { if (!elements.has(id)) elements.set(id, fakeElement()); return elements.get(id); },
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, dispatchEvent() {},
    },
    addEventListener() {},
    localStorage: { getItem: () => null, setItem: (k) => stored.push(k), removeItem() {} },
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
  });
  context.window = context;
  vm.runInContext(APP_JS, context);
  context.UsernodeReact = {
    nav: { setScreen() {}, setViewer() {}, park: (a) => calls.push(['park', a && a.slug]) },
    backButton: { set() {} },
    sidePanel: {
      take: (route) => { calls.push(['take', route]); return takes; },
      appPresence: (inApp) => calls.push(['presence', inApp]),
    },
    sidePanelEmbed: {
      forward: (route) => { calls.push(['forward', route]); return true; },
      openApp: (slug) => calls.push(['openApp', slug]),
      handTop: (route) => { calls.push(['handTop', route]); return true; },
    },
  };
  const appView = {
    appData: null,
    close() { this.appData = null; },
    launchRecordFor: () => ({ slug: 'notes-ab12', name: 'Notes', status: 'running' }),
    open(slug) { this.appData = { slug, name: 'Notes', status: 'running' }; return Promise.resolve(true); },
    beginLaunch: (slug) => calls.push(['beginLaunch', slug]),
    renderAppTab: () => calls.push(['renderAppTab']),
    renderDevView: (sub) => { calls.push(['renderDevView', sub]); return Promise.resolve(); },
  };
  context.AppView = new Proxy(appView, { get: (t, k) => (k in t ? t[k] : noop) });
  context.Home = new Proxy({}, { get: () => noop });
  return { App: context.App, calls, stored, context };
}

test('the router asks the panel first for a Workshop page, and only for a Workshop page', async () => {
  const { App, calls } = router();
  assert.equal(App.embeddedPanel, false);
  await App.navigateToApp('notes-ab12', 'app');
  const openApp = calls.length;
  const took = App.openAppTab('notes-ab12', 'dev', { subTab: 'topic', ref: { kind: 'proposal', id: 12 } });
  assert.equal(took, true);
  assert.deepEqual(calls.slice(openApp), [['take', 'app/notes-ab12/dev/proposals/12']],
    'a notification\'s proposal went to the panel, and nothing else happened');
  assert.equal(App.currentTab, 'app', 'the app is still the screen');
  App.openAppTab('notes-ab12', 'dev', { subTab: 'chat' });
  assert.deepEqual(calls.at(-1), ['take', 'app/notes-ab12/dev/chat']);
  App.openAppTab('notes-ab12', 'dev', { subTab: 'issues', ref: null });
  assert.deepEqual(calls.at(-1), ['take', 'app/notes-ab12/workshop']);
  const before = calls.filter((c) => c[0] === 'take').length;
  App.openAppTab('notes-ab12', 'app');
  assert.equal(calls.filter((c) => c[0] === 'take').length, before, 'the App tab never asks');
});

test('when the panel declines, openAppTab navigates exactly as before', async () => {
  const { App, calls } = router({ takes: false });
  await App.navigateToApp('notes-ab12', 'app');
  await App.openAppTab('notes-ab12', 'dev', { subTab: 'topic', ref: { kind: 'proposal', id: 12 } });
  assert.deepEqual(calls.filter((c) => c[0] === 'take'), [['take', 'app/notes-ab12/dev/proposals/12']]);
  assert.equal(App.currentTab, 'dev');
  assert.equal(App.currentSubTab, 'topic');
});

test('the bot page\'s presence reaches the panel from the one place that decides it, and an app never keeps it', async () => {
  // 18 Nov 2026: the panel no longer stands beside a running app, so an app
  // coming on screen takes it away like any other screen does.
  const { App, calls } = router();
  await App.navigateToApp('notes-ab12', 'app');
  assert.deepEqual(calls.filter((c) => c[0] === 'presence').at(-1), ['presence', false],
    'an app on its App tab drops the panel');
  App.navigateToMessages();
  assert.deepEqual(calls.filter((c) => c[0] === 'presence').at(-1), ['presence', false], 'so does a tab');
  assert.match(read('public/js/app.js'),
    /window\.UsernodeReact\?\.sidePanel\?\.appPresence\?\.\(screen === 'ai-screen' && !App\.chromeless\);/,
    'only the Homeroom bot tab\'s page keeps it');
});

test('in the panel\'s document the router never runs, parks or polls, and forwards what is not its own', async () => {
  const { App, calls } = router({ embedded: true });
  assert.equal(App.embeddedPanel, true);
  const result = await App.navigateToApp('notes-ab12');
  assert.equal(result, false);
  assert.deepEqual(calls.filter((c) => c[0] === 'beginLaunch'), [], 'no app frame is ever started, or warmed');
  assert.deepEqual(calls.at(-1), ['openApp', 'notes-ab12'], 'the App tab went to the running app');
  assert.equal(App.currentApp, null);
  // A Workshop page is its own.
  await App.navigateToApp('notes-ab12', 'dev', null, 'forum');
  assert.equal(App.currentApp, 'notes-ab12');
  assert.equal(App.currentTab, 'dev');
  const n = calls.length;
  assert.equal(await App.switchTab('app'), false);
  assert.deepEqual(calls.slice(n), [['openApp', 'notes-ab12']], 'the App tab is forwarded, not rendered');
  assert.equal(App.openAppTab('other-app', 'app'), false);
  assert.deepEqual(calls.at(-1), ['openApp', 'other-app']);
  assert.ok(!calls.some((c) => c[0] === 'park'), 'nothing is ever parked from in here');
  assert.ok(!calls.some((c) => c[0] === 'presence'), 'and it never reports the app beside it');
  assert.ok(!calls.some((c) => c[0] === 'take'), 'and never opens a panel of its own');
  await App.loadVersion();
  assert.ok(!calls.some((c) => c[0] === 'fetch' && c[1] === '/api/version'),
    'no version poll: the top window owns updates and the one-shot reload latch');
  assert.equal(App._reloadPrefetchedShellIfSafe('abc', { force: true }), false);
  // Home, and any address not the panel's, are the top window's.
  App.navigateHome();
  assert.deepEqual(calls.at(-1), ['forward', '']);
});

test('in the panel\'s document the bot page is handed to the top window, never drawn there (#7140)', () => {
  const { App, calls, context } = router({ embedded: true });
  calls.length = 0;
  App.navigateToAi();
  assert.deepEqual(calls, [['handTop', 'homeroom-bot']],
    'the page itself when no thread is named, and nothing else happens here');
  assert.ok(!App._inAi, 'the frame reveals no AI screen: its own list is never drawn');
  calls.length = 0;
  context.location.hash = '#homeroom-bot/thread/9';
  App.navigateToAi();
  assert.deepEqual(calls, [['handTop', 'homeroom-bot/thread/9']],
    'a thread address is handed up as it is, so the top opens that thread');
  assert.ok(!App._inAi, 'and the frame still draws nothing');
});

test('the Workshop tab\'s memory (#2776) is the top window\'s: the panel\'s pages never write it', async () => {
  const top = router();
  await top.App.navigateToApp('notes-ab12', 'dev', null, 'forum');
  assert.ok(top.stored.includes('usernode_workshop_view_v1'),
    'the top window remembers the Workshop view it shows (so the check below can fail)');
  const panel = router({ embedded: true });
  await panel.App.navigateToApp('notes-ab12', 'dev', null, 'forum');
  assert.equal(panel.App.currentTab, 'dev', 'the panel shows the Workshop…');
  assert.ok(!panel.stored.includes('usernode_workshop_view_v1'),
    '…and leaves the tab\'s memory, in storage it shares with the top window, alone');
});

test('the router consults the panel\'s document before routing an address', () => {
  const at = APP_JS.indexOf('  restoreFromHash() {');
  const body = APP_JS.slice(at, APP_JS.indexOf('  _validateInnerPath(p) {'));
  const forward = body.indexOf('window.UsernodeReact?.sidePanelEmbed?.forward?.(hash)');
  assert.ok(forward > 0, 'restoreFromHash asks the runtime');
  assert.ok(forward < body.indexOf('if (!hash) {'), 'before the first screen is chosen');
  assert.ok(forward > body.indexOf('AuthScreens.routeFromHash(hash)'), 'and after the signed-out routing');
  // The bar is down in there, and the parked strip is never written.
  assert.match(APP_JS, /App\.embeddedPanel \? false : !!screen && !App\.chromeless && \(!inApp \|\| railPinned\),/);
  assert.match(APP_JS, /_syncParkedApp\(inApp\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*if \(App\.embeddedPanel\) return;/);
});

// ── 7. Embedded mode: decided early, only when framed, and quiet ─────────

function runHeadCheck({ search = '?panel=1', framed = true, sameOrigin = true, nested = false } = {}) {
  const start = HEAD.indexOf('var inSidePanel = false;');
  const end = HEAD.indexOf("if (inSidePanel) document.documentElement.classList.add('in-side-panel');");
  assert.ok(start > 0 && end > start, 'the check is in the head-blocking script');
  const code = HEAD.slice(start, end) + "if (inSidePanel) document.documentElement.classList.add('in-side-panel');";
  const classes = new Set();
  const win = { location: { search, origin: 'https://homeroom.test' } };
  const parent = framed ? {
    get location() {
      if (!sameOrigin) throw new Error('SecurityError: cross-origin');
      return { origin: 'https://homeroom.test' };
    },
  } : win;
  win.parent = parent;
  win.top = nested ? {
    get location() { throw new Error('SecurityError: cross-origin preview host'); },
  } : parent;
  const context = vm.createContext({
    window: win, URLSearchParams,
    document: { documentElement: { classList: { add: (c) => classes.add(c) } } },
  });
  vm.runInContext(code, context);
  return classes.has('in-side-panel');
}

test('embedded mode needs panel=1 AND a same-origin parent, including inside Preview', () => {
  assert.equal(runHeadCheck(), true, 'the panel\'s frame');
  assert.equal(runHeadCheck({ framed: false }), false, 'a ?panel=1 address opened in a tab of its own');
  assert.equal(runHeadCheck({ sameOrigin: false }), false, 'framed by another site');
  assert.equal(runHeadCheck({ nested: true }), true, 'same-origin panel inside a cross-origin Preview host');
  assert.equal(runHeadCheck({ nested: true, sameOrigin: false }), false, 'a foreign immediate parent is still refused');
  assert.equal(runHeadCheck({ search: '?demo=1' }), false, 'no panel=1');
  const block = HEAD.slice(HEAD.indexOf('var inSidePanel = false;') - 2000, HEAD.indexOf('var inSidePanel = false;'));
  assert.match(block, /before the first\s*(?:\/\/\s*)?paint/i, 'decided before the first paint');
});

test('the layout: no app makes room for the panel; it is drawn beside the bot\'s page from 768px', () => {
  // 18 Nov 2026: #app-view no longer narrows by the panel's width, since the
  // panel no longer stands beside a running app.
  assert.doesNotMatch(CSS, /html\[data-side-panel\] #app-view \{/);
  assert.match(CSS, /--side-panel-w: clamp\(360px, 36vw, 560px\);/);
  // 1 Nov 2026: beside the AI tab's page it is drawn from 768px (its column).
  assert.match(CSS, /@media \(max-width: 1023\.98px\) \{[\s\S]{0,400}body:not\(:has\(#ai-screen:not\(\.hidden\)\)\) #platform-side-panel \{\s*display: none;/);
  assert.match(CSS, /@media \(max-width: 767\.98px\) \{\s*#platform-side-panel \{\s*display: none;/);
  // Never display:none, never re-parented: nothing in the panel's CSS touches the frame.
  const panelCss = CSS.slice(CSS.indexOf('/* ── #platform-side-panel'));
  assert.doesNotMatch(panelCss, /#app-iframe|#app-frame-host \{[^}]*display/);
  assert.equal(api.BESIDE_AI_QUERY, '(min-width: 768px)');
  assert.doesNotMatch(read('frontend/src/features/side-panel/controller.ts'), /DESKTOP_QUERY/, 'the beside-an-app breakpoint is gone');
});

test('the panel\'s document draws no chrome and reserves no room for it', () => {
  const block = CSS.slice(CSS.indexOf('html.in-side-panel :is('));
  for (const id of ['#platform-header', '#platform-tabs', '#platform-rail-peek', '#platform-parked',
    // The header's connection status replaced the offline strip.
    '#chromeless-pill', '#connection-status', '#mobile-install-banner', '#view-as-non-admin-banner',
    '#platform-side-panel']) {
    assert.ok(block.slice(0, block.indexOf('{')).includes(id), `${id} is hidden in the panel`);
  }
  assert.match(block, /html\.in-side-panel \{\s*[^}]*--platform-header-h: 0px;/);
  assert.match(block, /--platform-tabs-h: 0px !important;/);
  assert.match(block, /--platform-rail-w: 0px !important;/);
});

test('what the top window owns stands down in the panel\'s document', () => {
  // The remembered header (next cold boot would paint the panel's page).
  const snap = read('frontend/src/lib/shell-snapshot.ts');
  assert.match(snap, /export function saveShellSnapshot[\s\S]{0,400}if \(!isBrowser\(\) \|\| inSidePanel\(\)\) return;/);
  assert.match(snap, /export function clearShellSnapshot\(\): void \{\s*if \(!isBrowser\(\) \|\| inSidePanel\(\)\) return;/);
  assert.match(read('frontend/src/lib/shell-snapshot-apply.ts'), /if \(isEmbeddedPanel\(\)\) return;/);
  // The service worker (registered by the top window).
  assert.match(read('frontend/src/lib/service-worker.ts'), /if \(isEmbeddedPanel\(\)\) return;\s*container\.register\('\/sw\.js', \{ updateViaCache: 'none' \}\)/);
  // A frame's history entries are the top's: no dismiss records.
  assert.match(read('frontend/src/lib/back-stack.ts'), /if \(typeof window !== 'undefined' && !isEmbeddedPanel\(\)\) \{\s*shared = createBackStack\(window\);/);
  // The first-run gates and the tour (the top window presents them, once).
  assert.match(read('frontend/src/features/auth/username-first-run.js'), /classList\?\.contains\('in-side-panel'\)\) \{\s*UsernameFirstRun\._resolve\(\);/);
  assert.match(read('frontend/src/features/settings/terms-first-run.js'), /classList\?\.contains\('in-side-panel'\)\) \{\s*TermsFirstRun\._resolve\(\);/);
  assert.match(read('frontend/src/features/home/tour/index.tsx'), /function isDeterministicRoute\(\): boolean \{\s*if \(isEmbeddedPanel\(\)\) return true;/);
  // The device's app history and the install offer.
  assert.match(read('frontend/src/features/app-context/app-recency.ts'), /if \(!slug \|\| isEmbeddedPanel\(\)\) return;/);
  assert.match(read('frontend/src/features/mobile-install/install-banner.tsx'), /\|\| isEmbeddedPanel\(\)\) return undefined;/);
  // A session that ended: the top window shows the sign-in, not a form in the
  // panel — after the boot read is settled, so nothing in here waits on it.
  const anon = APP_JS.slice(APP_JS.indexOf('  async enterAnonymous() {'));
  const body = anon.slice(0, anon.indexOf('\n  },'));
  const settled = body.indexOf('App._publishBootSession({ signedOut: true });');
  const reload = body.search(/if \(App\.embeddedPanel\) \{\s*try \{ window\.top\.location\.reload\(\); \}[^\n]*\n\s*return;/);
  assert.ok(settled > 0 && reload > settled, 'the boot read is settled, then the top window reloads');
  assert.ok(reload < body.indexOf('AuthScreens.enter()'), 'and no second sign-in screen is drawn in the panel');
});

test('the shell snapshot really is not written from the panel\'s document', () => {
  const SNAPSHOT = read('frontend/src/lib/shell-snapshot.ts');
  const { readApiCacheScope } = require('./lib/render-tsx').loadTsx('frontend/src/lib/api-cache-identity.ts');
  const js = SNAPSHOT
    .replace(/^import .* from ['"].*['"];\n/gm, '')
    .replace(/export interface [\s\S]*?\n\}\n/g, '')
    .replace(/: Partial<Omit<ShellSnapshot, 'savedAt'>>/g, '')
    .replace(/: ShellSnapshot \| null/g, '')
    .replace(/: ShellSnapshot/g, '')
    .replace(/: boolean/g, '').replace(/: string/g, '').replace(/: void/g, '')
    .replace(/^export /gm, '');
  for (const embedded of [false, true]) {
    const store = {};
    const ctx = {
      Date, JSON, readApiCacheScope,
      window: { localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } } },
      document: { cookie: '__Host-usernode_api_scope=' + 'a'.repeat(64),
        documentElement: { classList: { contains: (c) => embedded && c === 'in-side-panel' } } },
    };
    vm.createContext(ctx);
    vm.runInContext(`${js}\n;globalThis.__api = { saveShellSnapshot };`, ctx);
    ctx.__api.saveShellSnapshot({ title: 'Messages' });
    assert.equal(Object.keys(store).length, embedded ? 0 : 1, embedded ? 'nothing from the panel' : 'the top window writes');
  }
});

test('the JS entry points ask the panel before they navigate', () => {
  const STORE = read('frontend/src/features/messages/store.ts');
  for (const fn of ['open', 'openDiscussion']) {
    const body = STORE.slice(STORE.indexOf(`export function ${fn}(`));
    const upTo = body.slice(0, body.indexOf('\n}'));
    assert.ok(upTo.indexOf('if (sidePanelTakes(target)) return;') > 0, `${fn} asks the panel`);
    assert.ok(upTo.indexOf('if (sidePanelTakes(target)) return;') < upTo.indexOf('window.location.hash = target'),
      `${fn} asks before it moves the address`);
  }
  const open = APP_JS.slice(APP_JS.indexOf('  openAppTab(slug, tab, opts) {'));
  assert.ok(open.indexOf('const inPanel = App._openAppTabInPanel(slug, tab, opts);') > 0
    && open.indexOf('App._openAppTabInPanel(') < open.indexOf('App.setChromeless(false);'),
    'openAppTab asks before it clears chromeless (the panel never opens beside a chromeless app)');
  const helper = APP_JS.slice(APP_JS.indexOf('  _openAppTabInPanel(slug, tab, opts) {'));
  assert.match(helper.slice(0, helper.indexOf('\n  },')),
    /if \(panelRoute && window\.UsernodeReact\?\.sidePanel\?\.take\?\.\(panelRoute\)\) return true;/);
});

// ── 8. The divider (#2886) ───────────────────────────────────────────────

test('the divider ships on the panel\'s left edge as a focusable vertical separator, with no value yet', () => {
  const at = HTML.indexOf('<aside id="platform-side-panel"');
  const el = HTML.slice(at, HTML.indexOf('</aside>', at));
  assert.match(el, /^<aside id="platform-side-panel" class="side-panel hidden"[^>]*><div id="side-panel-divider" class="side-panel-divider" role="separator" aria-orientation="vertical" aria-controls="platform-side-panel" aria-label="Resize panel" title="[^"]*" tabindex="0"><\/div><div class="side-panel-head/,
    'the aside\'s first child, before the header row');
  assert.doesNotMatch(el, /aria-valuenow|aria-valuemin|aria-valuemax/,
    'the width is read in an effect: the prerender and first client render carry none');
  const SRC = read('frontend/src/features/side-panel/side-panel.tsx');
  // Storage is read only inside an effect/handler, never in render.
  const divider = SRC.slice(SRC.indexOf('function SidePanelDivider('));
  const beforeReturn = divider.slice(0, divider.indexOf('\n  return ('));
  assert.match(beforeReturn, /useEffect\(\(\) => \{\s*settle\(\);/);
  assert.doesNotMatch(divider.slice(divider.indexOf('\n  return (')), /readStoredWidth|localStorage/);
});

test('with a detail beside the page it holds, the panel\'s edge is that column\'s edge (#6394)', () => {
  const SRC = read('frontend/src/features/side-panel/side-panel.tsx');
  // The AI page writes this store while the panel is the middle column of
  // three; the panel's own island reads it and hands the divider the
  // thread's width key, its probe and the preview to watch.
  assert.match(SRC, /import \{ panelEdgeStore \} from '\.\/edge-store';/);
  assert.match(SRC, /const edges = useStoreState\(panelEdgeStore\);\s+const edge = edges\.slot;/);
  assert.match(SRC, /<SidePanelDivider\s+panelRef=\{rootRef\}\s+shown=\{s\.open && !!s\.frameSrc\}\s+widthKey=\{edge\?\.widthKey\}\s+probe=\{edge\?\.probe\}\s+watch=\{edge\?\.watch\}\s+collapsed=\{snap\?\.collapsed\}\s+onCollapse=\{snap\?\.onCollapse\}\s+onRestore=\{snap\?\.onRestore\}\s+\/>/,
    'passing undefined leaves the divider on its own defaults');
  // The store starts empty, so the island\'s first render is the prerender.
  const { panelEdgeStore } = loadTsx('frontend/src/features/side-panel/edge-store.ts');
  assert.equal(panelEdgeStore.get().slot, null);
  assert.equal(panelEdgeStore.get().snap, null, '#6973: no one-pane wiring until a page is the column');
  // Its edge is drawn where the panel begins, as the thread\'s is in three.
  assert.match(CSS, /body:has\(#ai-screen\[data-ai-preview="three"\]:not\(\.hidden\)\) #side-panel-divider \{\n\s+--divider-at: calc\(var\(--ai-col-w\) \+ var\(--ai-preview-w\) \+ var\(--ai-edge, 0px\)\);\n\}/);
  assert.match(CSS, /body:has\(#ai-screen:is\(\[data-ai-preview="three"\], \[data-ai-preview="halves"\]\):not\(\.hidden\)\) \.side-panel \{\n\s+width: var\(--ai-col-w\);\n\s+inset-inline-end: calc\(var\(--ai-preview-w\) \+ var\(--ai-edge, 0px\)\);\n\}/);
});

test('the probe: beside an app, the app\'s left edge; beside the AI tab\'s page, the docked rail\'s', () => {
  const { probeLayout } = api.resize;
  const el = (box, classes = []) => ({ getBoundingClientRect: () => box, classList: { contains: (c) => classes.includes(c) } });
  const win = (els) => ({ innerWidth: 1280, document: { getElementById: (id) => els[id] || null } });
  const rail = el({ left: 0, right: 212, width: 212 });
  assert.deepEqual(probeLayout(win({ 'app-view': el({ left: 76, width: 1204 }), 'platform-tabs': rail })), { innerWidth: 1280, appLeft: 76, rightInset: 0, neighbourMin: 480 },
    'an app on screen answers for itself, as before');
  assert.deepEqual(probeLayout(win({ 'app-view': el({ left: 0, width: 0 }), 'platform-tabs': rail })), { innerWidth: 1280, appLeft: 212, rightInset: 0, neighbourMin: 480 },
    'no app on screen: the rail is what sits left of the page');
  assert.deepEqual(probeLayout(win({ 'app-view': el({ left: 0, width: 0 }), 'platform-tabs': el({ left: 0, right: 212, width: 212 }, ['platform-tabs-peek']) })),
    { innerWidth: 1280, appLeft: 0, rightInset: 0, neighbourMin: 480 }, 'a peeking rail takes no width');
  assert.deepEqual(probeLayout(win({})), { innerWidth: 1280, appLeft: 0, rightInset: 0, neighbourMin: 480 });
});

test('beside the bot page on an iPhone Duo held sideways: the list\'s floor, and the column left out', () => {
  // 1 Nov 2026: Main runs under the Duo's 84px column of system chrome, and
  // the drag measured its box, column and all, so the first 84px of a drag
  // moved nothing; and it kept the app's 480px beside the list, which the
  // stylesheet lets go to 280.
  const { probeLayout, bounds, shownWidth, clampWidth } = api.resize;
  const vars = { '--platform-strip-w': '84px', '--ai-list-min': '280px' };
  const ai = { getBoundingClientRect: () => ({ left: 0, width: 867 }), classList: { contains: () => false } };
  const win = {
    innerWidth: 951,
    getComputedStyle: () => ({ getPropertyValue: (name) => vars[name] || '' }),
    document: {
      body: {},
      documentElement: { getAttribute: (name) => (name === 'data-side-strip' ? 'right' : null) },
      getElementById: (id) => (id === 'ai-screen' ? ai : null),
    },
  };
  const probe = probeLayout(win);
  assert.deepEqual(probe, { innerWidth: 951, appLeft: 0, rightInset: 84, neighbourMin: 280 });
  // 951 less the column and the list's 280: Main may take 587px.
  assert.deepEqual({ ...bounds(probe) }, { min: 320, max: 587 });
  // Main drawn from x 396 to the screen's edge is 471px wide as chosen, not 555.
  assert.equal(shownWidth(396, probe), 471);
  assert.equal(clampWidth(shownWidth(396, probe) + 100, bounds(probe)), 571, 'a 100px drag left gives 100px');
  // Hidden, the bot page sets nothing: the app's floor, and no column on the left edge.
  const hidden = { ...ai, classList: { contains: (c) => c === 'hidden' } };
  win.document.getElementById = (id) => (id === 'ai-screen' ? hidden : null);
  assert.equal(probeLayout(win).neighbourMin, 480);
});

test('a list floor written in rem is read in pixels, against the root font size (#6495)', () => {
  // `--ai-list-min` now resolves from the shared `--list-pane-w` (22rem), and
  // getComputedStyle hands a custom property back as the substituted token
  // stream, not pixels: read as a bare number it was 22, so the drag's floor
  // was 22px. At the normal 16px root, 22rem is the inbox's 352px.
  const { probeLayout } = api.resize;
  const vars = { '--ai-list-min': '22rem' };
  const ai = { getBoundingClientRect: () => ({ left: 0, width: 868 }), classList: { contains: () => false } };
  const win = {
    innerWidth: 1280,
    getComputedStyle: () => ({ getPropertyValue: (name) => vars[name] || '', fontSize: '16px' }),
    document: {
      body: {},
      documentElement: { getAttribute: () => null },
      getElementById: (id) => (id === 'ai-screen' ? ai : null),
    },
  };
  assert.equal(probeLayout(win).neighbourMin, 352, '22rem at a 16px root is 352px');
  // A root with larger text gives the rem more pixels, as it does on screen.
  assert.equal(probeLayout({ ...win, getComputedStyle: () => ({ getPropertyValue: (name) => vars[name] || '', fontSize: '20px' }) }).neighbourMin, 440);
  // A px floor still parses as it always has, root size and all.
  assert.equal(probeLayout({ ...win, getComputedStyle: () => ({ getPropertyValue: () => '280px', fontSize: '20px' }) }).neighbourMin, 280);
});

test('beside the bot page\'s list the column takes the spare room: a drag stops where the list is 42rem (24 Nov 2026)', () => {
  // With the sidebar folded at 1720px the room is 1656px, and the list
  // beside the column is held to 42rem (672px). Dragged to 715px the column
  // left the list's side 941px for a 672px list: a band of about 135px each
  // side of it. app.css floors the column at the room less the list's 42rem
  // (`--ai-list-max`), and the divider reads the same figure.
  const { probeLayout, bounds, storedBounds, clampWidth, MIN_PANEL_W } = api.resize;
  const vars = { '--ai-list-min': '22rem', '--ai-list-max': '42rem' };
  const ai = { getBoundingClientRect: () => ({ left: 0, width: 1656 }), classList: { contains: () => false } };
  const rail = { getBoundingClientRect: () => ({ left: 0, right: 64, width: 64 }), classList: { contains: () => false } };
  const win = {
    innerWidth: 1720,
    getComputedStyle: () => ({ getPropertyValue: (name) => vars[name] || '', fontSize: '16px' }),
    document: {
      body: {},
      documentElement: { getAttribute: () => null },
      getElementById: (id) => (id === 'ai-screen' ? ai : id === 'platform-tabs' ? rail : null),
    },
  };
  const probe = probeLayout(win);
  assert.equal(probe.floor, 1656 - 672, 'the room less the list\'s 42rem');
  assert.deepEqual({ ...bounds(probe) }, { min: 984, max: 1304 }, 'a drag stops at the floor; the list keeps its own 22rem floor');
  assert.equal(clampWidth(715, bounds(probe)), 984, 'dragged to 715px, the column stops at 984px');
  // A width stored before is applied as stored: the stylesheet raises it on
  // screen, and a preview's columns, which read the column's width, read it
  // as chosen. The store is never rewritten.
  assert.deepEqual({ ...storedBounds(probe) }, { min: MIN_PANEL_W, max: 1304 });
  assert.equal(clampWidth(715, storedBounds(probe)), 715);
  // Unfolded (212px of rail) the floor is lower, and below 42rem of room it
  // is the column's own 320px.
  rail.getBoundingClientRect = () => ({ left: 0, right: 212, width: 212 });
  assert.equal(probeLayout(win).floor, 1508 - 672);
  assert.equal(probeLayout({ ...win, innerWidth: 900 }).floor, MIN_PANEL_W);
  // Where the stylesheet declares no list measure (a preview's columns, the
  // frame's looks, a phone, another page) there is no floor, as before.
  delete vars['--ai-list-max'];
  assert.equal('floor' in probeLayout(win), false);
  assert.deepEqual({ ...bounds(probeLayout(win)) }, { min: MIN_PANEL_W, max: 1508 - 352 });
});

test('the width\'s rules: 320px of panel and 480px of app at the least, whatever the window', () => {
  const { bounds, clampWidth, MIN_PANEL_W, MIN_APP_W } = api.resize;
  assert.equal(MIN_PANEL_W, 320);
  assert.equal(MIN_APP_W, 480, 'the floor kept for whatever stands left of the panel');
  // A 1440px window with the app flush left: up to 960px of panel.
  assert.deepEqual({ ...bounds({ innerWidth: 1440, appLeft: 0 }) }, { min: 320, max: 960 });
  // A rail to the left of the app comes out of the panel's room, not the app's.
  assert.deepEqual({ ...bounds({ innerWidth: 1440, appLeft: 240 }) }, { min: 320, max: 720 });
  // A window too narrow for both never inverts the range.
  assert.deepEqual({ ...bounds({ innerWidth: 700, appLeft: 0 }) }, { min: 320, max: 320 });
  const b = bounds({ innerWidth: 1440, appLeft: 0 });
  assert.equal(clampWidth(100, b), 320);
  assert.equal(clampWidth(5000, b), 960);
  assert.equal(clampWidth(Number.POSITIVE_INFINITY, b), 960, 'End');
  assert.equal(clampWidth(540.6, b), 541);
});

test('the chosen width is this device\'s, and storage that fails is simply the default', () => {
  const { readStoredWidth, writeStoredWidth, clearStoredWidth, WIDTH_KEY, AI_MAIN_WIDTH_KEY } = api.resize;
  const mem = new Map();
  const store = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  assert.equal(WIDTH_KEY, 'usernode_side_panel_w_v1');
  assert.equal(AI_MAIN_WIDTH_KEY, 'usernode_ai_main_w_v1', 'Main Chat has a key of its own (3 Nov 2026)');
  assert.equal(readStoredWidth(store), null, 'nothing chosen: the stylesheet\'s default');
  writeStoredWidth(612.4, store);
  assert.equal(mem.get(WIDTH_KEY), '612');
  assert.equal(readStoredWidth(store), 612);
  assert.equal(readStoredWidth(store, AI_MAIN_WIDTH_KEY), null, 'a panel width is not Main\'s');
  writeStoredWidth(533.2, store, AI_MAIN_WIDTH_KEY);
  assert.equal(mem.get(AI_MAIN_WIDTH_KEY), '533');
  assert.equal(readStoredWidth(store, AI_MAIN_WIDTH_KEY), 533);
  assert.equal(readStoredWidth(store), 612, 'and Main\'s width is not the panel\'s');
  clearStoredWidth(store, AI_MAIN_WIDTH_KEY);
  assert.equal(readStoredWidth(store, AI_MAIN_WIDTH_KEY), null, 'a double-click on Main\'s edge forgets only Main\'s width');
  assert.equal(readStoredWidth(store), 612, 'the panel beside an app keeps its own');
  clearStoredWidth(store);
  assert.equal(readStoredWidth(store), null, 'a double-click forgets it');
  for (const junk of ['', 'wide', '-4', '0', 'NaN', 'Infinity']) {
    mem.set(WIDTH_KEY, junk);
    assert.equal(readStoredWidth(store), null, `"${junk}" is not a width`);
    mem.set(AI_MAIN_WIDTH_KEY, junk);
    assert.equal(readStoredWidth(store, AI_MAIN_WIDTH_KEY), null, `"${junk}" is not Main's width either`);
  }
  const throwing = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  assert.equal(readStoredWidth(throwing), null);
  assert.equal(readStoredWidth(throwing, AI_MAIN_WIDTH_KEY), null);
  assert.doesNotThrow(() => writeStoredWidth(500, throwing));
  assert.doesNotThrow(() => writeStoredWidth(500, throwing, AI_MAIN_WIDTH_KEY));
  assert.doesNotThrow(() => clearStoredWidth(throwing));
  assert.doesNotThrow(() => clearStoredWidth(throwing, AI_MAIN_WIDTH_KEY));
  assert.equal(readStoredWidth(null), null, 'no storage at all');
  assert.equal(readStoredWidth(null, AI_MAIN_WIDTH_KEY), null);
});

test('a width is the layout\'s own knob on <html>, and none hands it back to the stylesheet', () => {
  const { applyWidth, AI_MAIN_WIDTH_KEY } = api.resize;
  const props = new Map();
  const root = { style: {
    setProperty: (k, v) => props.set(k, v),
    removeProperty: (k) => props.delete(k),
  } };
  applyWidth(544.2, root);
  assert.equal(props.get('--side-panel-w'), '544px');
  assert.equal(props.has('--ai-main-chosen-w'), false, 'the panel\'s edge does not size Main');
  applyWidth(688.6, root, AI_MAIN_WIDTH_KEY);
  assert.equal(props.get('--ai-main-chosen-w'), '689px');
  assert.equal(props.get('--side-panel-w'), '544px', 'and Main\'s edge leaves the panel\'s width alone');
  applyWidth(null, root, AI_MAIN_WIDTH_KEY);
  assert.equal(props.has('--ai-main-chosen-w'), false, 'Main goes back to the room its list leaves');
  assert.equal(props.get('--side-panel-w'), '544px');
  applyWidth(null, root);
  assert.equal(props.has('--side-panel-w'), false);
});

test('with a preview open both edges are handles: their own keys, every column\'s floor, the thread measured to the preview (#6359)', () => {
  const { applyWidth, bounds, shownWidth, clampWidth, AI_MAIN_WIDTH_KEY, AI_PREVIEW_COLUMN_WIDTH_KEY, AI_PREVIEW_WIDTH_KEY } = api.resize;
  assert.equal(new Set([AI_MAIN_WIDTH_KEY, AI_PREVIEW_COLUMN_WIDTH_KEY, AI_PREVIEW_WIDTH_KEY]).size, 3, 'three widths, three keys');
  const props = new Map();
  const root = { style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } };
  applyWidth(400, root, AI_PREVIEW_COLUMN_WIDTH_KEY);
  applyWidth(700, root, AI_PREVIEW_WIDTH_KEY);
  assert.deepEqual([...props], [['--ai-col-chosen-w', '400px'], ['--ai-preview-chosen-w', '700px']],
    'neither touches Main\'s width');
  // A 1600px window with a 72px rail: the list keeps 480px.
  // The preview's edge keeps the list's floor and the thread's (480 + 320).
  const preview = { innerWidth: 1600, appLeft: 72, neighbourMin: 480 + 320, selfMin: 360 };
  assert.deepEqual({ ...bounds(preview) }, { min: 360, max: 728 });
  assert.equal(shownWidth(900, preview), 700, 'the preview runs to the window\'s edge');
  // The thread's edge keeps the list's floor and the preview as it is drawn
  // (480 + 468, ai/index.tsx threadProbe), the room app.css leaves the
  // thread: 1600 - 212 (the rail) - 480 - 468 = 440px, where the column stops.
  // Its width runs to where the preview begins, not to the window's edge.
  const thread = { innerWidth: 1600, appLeft: 212, neighbourMin: 480 + 468, endAt: 1600 - 468 };
  assert.deepEqual({ ...bounds(thread) }, { min: 320, max: 440 });
  assert.equal(shownWidth(1132 - 400, thread), 400);
  assert.equal(clampWidth(shownWidth(732, thread) + 100, bounds(thread)), 440, 'End and a drag stop where the column does');
  assert.equal(clampWidth(0, bounds(preview)), 360, 'Home: the preview\'s own floor, not the panel\'s');
});

test('the bot page is what makes an edge Main Chat\'s, and a hidden page is not', () => {
  const { aiPageUp } = api.resize;
  const el = (classes = []) => ({ classList: { contains: (c) => classes.includes(c) } });
  const doc = (node) => ({ getElementById: (id) => (id === 'ai-screen' ? node : null) });
  assert.equal(aiPageUp(doc(el())), true);
  assert.equal(aiPageUp(doc(el(['hidden']))), false);
  assert.equal(aiPageUp(doc(null)), false, 'another screen up: the side panel\'s own width');
  assert.equal(aiPageUp({ getElementById() { throw new Error('no document'); } }), false);
});

test('the divider drags, takes the keys, resets on a double-click, and lets the frames stand aside while held', () => {
  const SRC = read('frontend/src/features/side-panel/side-panel.tsx');
  const divider = SRC.slice(SRC.indexOf('function SidePanelDivider('));
  assert.match(divider, /setPointerCapture\(e\.pointerId\)/);
  // #6963: the raw width is read first, so a drag can go past the floor and
  // become the list's being hidden; what is applied is still clamped.
  assert.match(divider, /const raw = d\.startW \+ \(d\.startX - e\.clientX\) \* dirSign\(\);/,
    'pinned to the right edge: moving left widens the panel, and nothing is stored mid-drag');
  assert.match(divider, /d\.width = set\(raw, false\);/, 'the drag itself is still clamped');
  // 3 Nov 2026: this edge sets its own column's width — Main Chat's while the
  // bot page is up, the side panel's everywhere else — resolved at each use.
  assert.match(divider, /const resolveKey = useCallback\(\s*\(\) => widthKey \?\? \(aiPageUp\(\) \? AI_MAIN_WIDTH_KEY : WIDTH_KEY\),/,
    'the bot page up, the same handle is Main Chat\'s, under Main\'s key');
  assert.match(divider, /const stored = readStoredWidth\(undefined, key\);/);
  // 24 Nov 2026: a stored width is applied as stored, held to the window;
  // a floor the stylesheet keeps (the bot page's column) raises it there.
  assert.match(divider, /applyWidth\(stored == null \? null : clampWidth\(stored, storedBounds\(probe\)\), undefined, key\);/);
  assert.match(divider, /applyWidth\(next, undefined, key\);/);
  assert.match(divider, /if \(persist\) writeStoredWidth\(next, undefined, key\);/);
  assert.match(divider, /if \(d\.width != null && !d\.collapsed\) writeStoredWidth\(d\.width, undefined, resolveKey\(\)\);/,
    'a press that never moved is half of a double-click, not a choice, and a hidden list chose no width');
  assert.match(divider, /const onDoubleClick = \(\) => \{[^}]*clearStoredWidth\(undefined, resolveKey\(\)\);\s*settle\(\);/);
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.ok(divider.includes(`'${key}'`), key);
  assert.match(divider, /window\.addEventListener\('resize', settle\)/, 'a window that narrows gives the width back');
  const block = CSS.slice(CSS.indexOf('.side-panel-divider {'), CSS.indexOf('.side-panel-head {'));
  assert.match(block, /cursor: col-resize;/);
  assert.match(block, /touch-action: none;/);
  assert.match(block, /html\.side-panel-resizing iframe \{\s*pointer-events: none;/);
});

test('on a touch screen the divider is a handle you can see and hit', () => {
  // iPhone Duo, 1 Nov 2026: the bar shows only under a pointer, which a
  // finger never hovers over, and 10px is narrower than a fingertip.
  const at = CSS.indexOf('@media (pointer: coarse) {\n  .side-panel-divider { --divider-w: 24px; }');
  assert.ok(at > 0, 'a 24px handle with a coarse pointer');
  const block = CSS.slice(at, CSS.indexOf('\n}\n', at));
  assert.match(block, /\.side-panel-divider::before \{[^}]*content: "";[^}]*inset-inline-start: calc\(50% - 2px\);[^}]*height: 40px;[^}]*border-radius: 999px;[^}]*opacity: \.5;/,
    'a grip drawn at rest, on the line');
  // The grip is the whole mark under a finger: the full-height bar is a
  // pointer's hover cue, and beside the grip it read as a second divider.
  assert.match(block, /\.side-panel-divider::after \{ display: none; \}/);
  assert.match(block, /html\.side-panel-resizing \.side-panel-divider::before \{ opacity: \.85; \}/, 'the grip darkens while held');
  // A tap leaves iOS holding :hover, so the bar lights on hover only where
  // the pointer can hover.
  assert.match(CSS, /@media \(hover: hover\) \{\n  \.side-panel-divider:hover::after \{ opacity: \.45; \}\n\}/);
  assert.doesNotMatch(CSS, /\n\.side-panel-divider:hover::after,/);
});

test('the divider is drawn on the line between the two halves, not inside the panel', () => {
  // iPhone Duo, 1 Nov 2026: inside the panel, which clips its corner, the
  // handle sat on the panel's side of the gutter beside the bot's list.
  // Fixed, it escapes that clip while staying the panel's child.
  const rule = CSS.slice(CSS.indexOf('.side-panel-divider {\n'), CSS.indexOf('\n}\n', CSS.indexOf('.side-panel-divider {\n')));
  assert.match(rule, /--divider-w: 10px;/, 'a mouse keeps the 10px edge');
  assert.match(rule, /position: fixed;/);
  assert.match(rule, /inset-inline-end: calc\(var\(--divider-at, var\(--side-panel-w\)\) - var\(--divider-w\) \/ 2\);/,
    'centred on the line; beside an app the line is the panel\'s own edge');
  assert.match(CSS, /body:has\(#ai-screen:not\(\.hidden\)\) :is\(#side-panel-divider, #ai-main-divider\) \{\s*--divider-at: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\)\);/,
    'beside the bot\'s list, on the pane\'s own edge');
  // #6447: below 1024px the list's 16px gutter is the gap you see between the
  // two sheets, so the handle sits in the middle of it, 8px toward the list.
  // A desktop alone keeps the pane's edge.
  // With the list hidden there is no list to move towards (24 Nov 2026).
  assert.match(CSS, /@media \(max-width: 1023\.98px\) \{\s*body:has\(#ai-screen:not\(\.hidden\):not\(\[data-ai-list-closed\]\)\) :is\(#side-panel-divider, #ai-main-divider\) \{\s*--divider-at: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\) \+ 8px\);\s*\}\s*\}/,
    'a narrow window centres the handle in the gap between the two cards');
  assert.match(CSS, /\.side-panel-divider::after \{[^}]*inset-inline-start: calc\(50% - 1\.5px\);/, 'the bar on the line too');
  // #6397: below the pane's 28px rounded top corner, not beside the curve.
  assert.match(CSS, /body:has\(#ai-screen:not\(\.hidden\)\) :is\(#side-panel-divider, #ai-main-divider\)::after \{\s*top: 1\.75rem;\s*\}/,
    'the bar starts where the pane\'s corner ends');
});

test('beside the bot page the column\'s heading links the item to its own page, and ⋯ copies it', () => {
  const SRC = read('frontend/src/features/side-panel/side-panel.tsx');
  // The words "Request #N" are the link: the same page Expand opens.
  assert.match(SRC, /const link = pageLinkFor\(route\);/);
  assert.match(SRC, /href=\{link\}/);
  assert.match(SRC, /try \{ \(window as any\)\.Improve\?\.enterTopicFrom\?\.\(window\.location\.hash\); \} catch \{ \/\* the page as it opens \*\/ \}\s+controller\.expand\(\);/);
  // A modified press or a middle one gives the real address, as a link does.
  assert.match(SRC, /if \(e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey\) return;/);
  // ⋯ › Copy link copies the item's own page, not the tab's address.
  assert.match(SRC, /<PanelMore route=\{s\.route\} \/>/);
  assert.match(SRC, /data-side-panel-copy-link=""/);
  assert.match(SRC, /copyToClipboard\(window\.location\.origin \+ link, t\('agent:sidePanel\.linkCopied'\)\)/);
  assert.match(SRC, /aria-label=\{t\('agent:sidePanel\.moreLabel'\)\}/);
  // The catalog says it, in English, with tag 1 as the item's page.
  const agent = JSON.parse(read('frontend/locales/en/agent.json'));
  for (const [key, text] of [
    ['sidePanel.where.request', '<0>{{project}}</0> · <1>Request #{{number}}</1>'],
    ['sidePanel.where.change', '<0>{{project}}</0> · <1>Change #{{number}}</1>'],
    ['sidePanel.where.decision', '<0>{{project}}</0> · <1>Decision</1>'],
  ]) assert.equal(agent[key].text, text, key);
  assert.equal(agent['sidePanel.moreLabel'].text, 'More actions');
  assert.equal(agent['sidePanel.menu.copyLink'].text, 'Copy link');
  assert.equal(agent['sidePanel.linkCopied'].text, 'Link copied');
  // #6380: Open in workshop is the menu's second row, under Copy link, only
  // for a project's own request, change or decision, and it asks the
  // controller to open it there.
  assert.equal(agent['sidePanel.menu.openInWorkshop'].text, 'Open in workshop');
  const menu = SRC.slice(SRC.indexOf('data-side-panel-copy-link=""'), SRC.indexOf('</div>\n      ) : null}\n    </div>'));
  assert.match(menu, /data-side-panel-open-workshop=""/);
  assert.ok(menu.indexOf('data-side-panel-copy-link') < menu.indexOf('data-side-panel-open-workshop'),
    'the new row comes after Copy link');
  assert.match(menu, /\{route && workshopItemOf\(route\) \? \(/);
  assert.match(menu, /controller\.openInWorkshop\(\)/);
  // The ⋯ is in the row only beside the bot page, and at its end.
  assert.match(CSS, /\.side-panel-head > :is\(\.side-panel-ai-close, \.side-panel-place, \.side-panel-more\) \{ display: none; \}/);
  assert.match(CSS, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel :is\(\.side-panel-ai-close, \.side-panel-place, \.side-panel-more\) \{ display: inline-flex; \}/);
  assert.match(CSS, /\.side-panel-more \{[^}]*margin-inline-start: auto;[^}]*align-self: center;/);
  // The item's page link is what the heading draws; a page with none is plain words.
  api._resetForTests();
  api.sidePanelStore.set({
    open: true, frameSrc: '/?panel=1#app/x/dev/issues/6214', frameKey: 1,
    route: 'app/x/dev/issues/6214', title: 'Request', canBack: false, loading: false,
  });
  const html = renderToHtml(createElement(api.SidePanelIsland, {}));
  assert.match(html, /href="\/app\/x\/dev\/issues\/6214">Request #6214<\/a>/);
  assert.match(html, /aria-haspopup="menu" aria-expanded="false"/, 'the ⋯ opens a menu, closed at first');
  api._resetForTests();
});

// ── #6431: one header beside the bot page — the page's pill and its rows ──

const PILL_BUILDING = {
  tier: 2, key: 'building', label: 'Being built', tone: 'progress',
  yes: 0, no: 0, majority: 1, advisory: 0, lock: false,
};

/** A panel open on `route`, booted, publishing `head`. */
function besideBot(route, head) {
  api._resetForTests();
  api.sidePanelStore.set({ open: true, frameSrc: `/?panel=1#${route}`, frameKey: 1, loading: false });
  api.embeddedApi.ready(route, 'Notes');
  if (head) api.embeddedApi.head(route, head);
}

test('the head store starts empty and takes, and clears, a page\'s head (#6431)', () => {
  // The panel document's head store starts null, and the first thing that
  // ever happens to it is the page publishing an object. createStore's
  // change detection read the key off that null state and threw, so the
  // pill and the page's rows never reached the column: running the app with
  // a request in the panel logged "Cannot read properties of null (reading
  // 'kind')" at the store's set, and the page's bar had already gone.
  api.panelHeadStore.set(null);
  assert.equal(api.panelHeadStore.get(), null);
  api.panelHeadStore.set({ kind: 'request', pill: PILL_BUILDING, menuKey: 'request:6431' });
  assert.equal(api.panelHeadStore.get().kind, 'request');
  assert.equal(api.panelHeadStore.get().pill.key, 'building');
  assert.equal(api.panelHeadStore.get().menuKey, 'request:6431');
  // And it is cleared the same way: null REPLACES the state rather than
  // merging into a no-op copy of it, or the page's pill would outlive it.
  api.panelHeadStore.set(null);
  assert.equal(api.panelHeadStore.get(), null);
  // A store with an object state keeps the merge contract every other
  // plain-store user relies on.
  api.panelHeadStore.set({ kind: 'change', pill: null, menuKey: 'detail:proposal:9' });
  assert.equal(api.panelHeadStore.get().kind, 'change');
  api.panelHeadStore.set(null);
});

test('beside the bot page the column\'s heading carries the page\'s own status pill (#6431)', () => {
  const SRC = read('frontend/src/features/side-panel/side-panel.tsx');
  const HEAD = read('frontend/src/features/side-panel/head-store.ts');
  // The page publishes it from its bar, and only inside a panel's own
  // document: the full page and the Workshop's side panel are the top
  // document, where the page keeps its own bar and publishes nothing.
  assert.match(HEAD, /if \(!isEmbeddedPanel\(\)\) return undefined;/);
  assert.match(HEAD, /panelHeadStore\.set\(\{ kind: head\.kind, pill, menuKey: head\.menuKey, title, route: route \|\| null \}\);/);
  assert.match(HEAD, /return \(\) => \{ panelHeadStore\.set\(null\); \};/, 'and takes it back when the page goes');
  // The heading draws the page's own pill, only while it is THAT page's.
  assert.match(SRC, /const pill = head && head\.pill && samePage\(head\.route, route\) \? head\.pill : null;/);
  assert.match(SRC, /data-side-panel-status=\{pill\.key\}/);
  assert.match(SRC, /<ChangeTag s=\{pill\} \/>/, 'the page\'s own pill, the one tag it wears there');

  // A request open beside it: its pill follows "Request #6431".
  besideBot('app/x/dev/issues/6431', { kind: 'request', pill: PILL_BUILDING, menuKey: 'request:6431' });
  let html = renderToHtml(createElement(api.SidePanelIsland, {}));
  assert.match(html, /data-side-panel-status="building"/);
  assert.match(html, />Being built</);
  assert.ok(html.indexOf('Request #6431') < html.indexOf('data-side-panel-status="building"'),
    'after the number, on the heading\'s second line');

  // The work moves on: the page publishes the new pill and the heading draws it.
  api.embeddedApi.head('app/x/dev/issues/6431', {
    kind: 'request', pill: { ...PILL_BUILDING, key: 'checks', label: 'Checking' }, menuKey: 'request:6431',
  });
  html = renderToHtml(createElement(api.SidePanelIsland, {}));
  assert.match(html, /data-side-panel-status="checks"/);
  assert.match(html, />Checking</);
  assert.doesNotMatch(html, /data-side-panel-status="building"/, 'the old one is gone, not added to');

  // A change's page the same way.
  api.embeddedApi.head('app/x/dev/issues/6431', {
    kind: 'change', pill: { ...PILL_BUILDING, key: 'voting', label: 'Vote · 1/2' }, menuKey: 'detail:proposal:9',
  });
  assert.match(renderToHtml(createElement(api.SidePanelIsland, {})), /data-side-panel-status="voting"/);

  // A page with no status, and a head that is not this page's, draw no pill.
  api.embeddedApi.head('app/x/dev/issues/6431', { kind: 'change', pill: null, menuKey: 'detail:proposal:9' });
  assert.doesNotMatch(renderToHtml(createElement(api.SidePanelIsland, {})), /data-side-panel-status/);
  api.embeddedApi.head('app/x/dev/changes/6430', { kind: 'request', pill: PILL_BUILDING, menuKey: 'request:6430' });
  assert.doesNotMatch(renderToHtml(createElement(api.SidePanelIsland, {})), /data-side-panel-status/,
    'one page\'s pill never shows on the next');
  api._resetForTests();
});

test('beside the bot page the heading draws the title the page published, and only while it is that page\'s (#7120)', () => {
  const SRC = read('frontend/src/features/side-panel/side-panel.tsx');
  // The page's head carries the title its own bar draws; the heading takes it
  // only for a request's head on THIS page, and falls back to what it drew
  // before otherwise.
  assert.match(SRC, /const title = \(head && head\.kind === 'request' && head\.title && samePage\(head\.route, route\) \? head\.title : null\)/);

  besideBot('app/x/dev/issues/6431', {
    kind: 'request', pill: PILL_BUILDING, menuKey: 'request:6431', title: 'Close: Fix the panel',
  });
  let html = renderToHtml(createElement(api.SidePanelIsland, {}));
  assert.match(html, /side-panel-place-title truncate">Close: Fix the panel</);

  // A page that draws its plain title publishes none, and the column reads
  // the title it always did.
  api.embeddedApi.head('app/x/dev/issues/6431', { kind: 'request', pill: PILL_BUILDING, menuKey: 'request:6431' });
  html = renderToHtml(createElement(api.SidePanelIsland, {}));
  assert.match(html, /side-panel-place-title truncate">Request</);

  // A head from another page never titles this one.
  api.embeddedApi.head('app/x/dev/changes/6430', {
    kind: 'request', pill: PILL_BUILDING, menuKey: 'request:6430', title: 'Close: Some other page',
  });
  html = renderToHtml(createElement(api.SidePanelIsland, {}));
  assert.match(html, /side-panel-place-title truncate">Request</);
  api._resetForTests();
});

test('a page\'s status pill is reported only for the route it was published on (#6608)', async () => {
  api.panelHeadStore.set(null);
  const p = panelWindow({ href: 'https://homeroom.test/app/a/dev/changes/12?panel=1', captureHead: true });
  try {
    p.boot();
    await tick();
    const own = { kind: 'change', pill: PILL_BUILDING, menuKey: 'detail:proposal:12', route: 'app/a/dev/changes/12' };
    api.panelHeadStore.set(own);
    await tick();
    assert.deepEqual(p.reports.at(-1), ['head', 'app/a/dev/changes/12', own], 'the page\'s own head is reported');

    // The viewer switches the panel to another project's change. No head for
    // the new route yet: the top document gets none, not the old page's.
    p.win.history.replaceState(null, '', '/app/b/dev/changes/44?panel=1');
    await tick();
    assert.deepEqual(p.reports.at(-1), ['head', 'app/b/dev/changes/44', null]);

    // A bar still mounted from the page the viewer left publishes again after
    // the route changed. It carries the route it was DRAWN for, so `flush`
    // still reports none for the new route instead of adopting its pill.
    api.panelHeadStore.set({ ...own, pill: { ...PILL_BUILDING, key: 'going', label: 'Going live' } });
    await tick();
    assert.deepEqual(p.reports.at(-1), ['head', 'app/b/dev/changes/44', null],
      'a late publish for the old page never becomes the new page\'s pill');

    // The new page publishes its own head: that is the one reported.
    const next = { kind: 'change', pill: PILL_BUILDING, menuKey: 'detail:proposal:44', route: 'app/b/dev/changes/44' };
    api.panelHeadStore.set(next);
    await tick();
    assert.deepEqual(p.reports.at(-1), ['head', 'app/b/dev/changes/44', next]);
  } finally {
    api.panelHeadStore.set(null);
    delete globalThis.document;
  }
});

test('the column\'s ⋯ lists the page\'s rows after its own, and runs them in the page (#6431)', async () => {
  const SRC = read('frontend/src/features/side-panel/side-panel.tsx');
  // Copy link, Open in workshop, a divider, then the page's rows — read when
  // the menu opens, and run in the panel's document.
  const menu = SRC.slice(SRC.indexOf('data-side-panel-copy-link=""'), SRC.indexOf('\n      ) : null}\n    </div>'));
  assert.ok(menu.indexOf('data-side-panel-copy-link') < menu.indexOf('side-panel-menu-sep'),
    'the divider comes after Copy link');
  assert.ok(menu.indexOf('data-side-panel-open-workshop') < menu.indexOf('side-panel-menu-sep'),
    'and after Open in workshop');
  assert.match(menu, /data-side-panel-page-row=\{row\.index\}/);
  assert.match(menu, /controller\.runPanelMenuRow\(row\.index, row\.label, e\.nativeEvent\)/);
  assert.match(SRC, /setRows\(controller\.panelMenuRows\(\)\);/, 'read from the page as the menu opens');

  // The page's own ⋯ list, read off its AppView: a row that changed since the
  // menu opened (Notify me become Mute) says so the next time it opens.
  let following = false;
  const list = () => [
    { label: 'Build it with your own Claude Code', icon: 'generate', act: () => {} },
    { label: following ? 'Mute' : 'Notify me', title: 'Follow this thread', act: () => { following = true; } },
    { label: 'Details', act: null },
  ];
  const av = {
    _cardMenuItems: () => list(),
    _cardMenuRowItem: (all, idx, label) => {
      const at = all[idx];
      if (label == null || (at && at.label === label)) return at;
      return all.find((x) => x.label === label) || at;
    },
  };
  besideBot('app/x/dev/issues/6431', { kind: 'request', pill: PILL_BUILDING, menuKey: 'request:6431' });
  api.sidePanelRefs.frame = { contentWindow: { AppView: av } };
  assert.deepEqual(api.SidePanel.panelMenuRows().map((r) => r.label),
    ['Build it with your own Claude Code', 'Notify me', 'Details'], 'the rows the page\'s ⋯ would show');
  assert.equal(api.SidePanel.panelMenuRows()[2].disabled, true, 'a row with no action is unavailable here too');
  assert.equal(api.SidePanel.panelMenuRows()[1].title, 'Follow this thread', 'its tooltip comes with it');
  api.SidePanel.runPanelMenuRow(1, 'Notify me');
  // #6988: the row runs on the next frame, after the column's menu has
  // closed, so a row that opens a dialog in the page is not swallowed by the
  // menu's own click dispatch.
  assert.equal(following, false, 'not inside the menu row\'s click');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(following, true, 'the row ran in the page');
  assert.equal(api.SidePanel.panelMenuRows()[1].label, 'Mute', 'and the next opening says Mute');
  // #7000: the page's ⋯ now opens with a Copy link row. The column keeps its
  // own Copy link above the divider, so it drops the page's and each row that
  // stays keeps its position in the page's full list, where it is run.
  av._cardMenuItems = () => [
    { label: 'Copy link', copyLink: true, act: () => {} },
    { label: 'Build it with your own Claude Code', act: () => {} },
    { label: 'Notify me', act: () => {} },
  ];
  assert.deepEqual(api.SidePanel.panelMenuRows().map((r) => r.label),
    ['Build it with your own Claude Code', 'Notify me'], 'the page\'s copy row is left out');
  assert.deepEqual(api.SidePanel.panelMenuRows().map((r) => r.index), [1, 2],
    'each row still names its place in the page\'s list');
  // A page with no ⋯ key of its own, and one whose head is another page's,
  // list nothing.
  api.embeddedApi.head('app/x/dev/issues/6431', { kind: 'change', pill: null, menuKey: null });
  assert.deepEqual(api.SidePanel.panelMenuRows(), []);
  api.embeddedApi.head('app/x/dev/changes/6430', { kind: 'request', pill: PILL_BUILDING, menuKey: 'request:6430' });
  assert.deepEqual(api.SidePanel.panelMenuRows(), [], 'a head for another page lists nothing here');
  api.sidePanelRefs.frame = null;
  api._resetForTests();
});

test('#6988: the column\'s ⋯ runs Propose to close from the frame, opening its dialog', async () => {
  const opened = [];
  const list = () => [
    { label: 'Reply to Homeroom bot', act: () => opened.push('reply') },
    { label: 'Propose to close', act: () => opened.push('close') },
  ];
  const av = {
    _cardMenuItems: () => list(),
    _cardMenuRowItem: (all, idx, label) => all.find((x) => x.label === label) || all[idx],
    promptCloseIssue: (n) => opened.push(`close:${n}`),
  };
  besideBot('app/x/dev/issues/37', { kind: 'request', pill: PILL_BUILDING, menuKey: 'request:37' });
  api.sidePanelRefs.frame = { contentWindow: { AppView: av } };
  // The menu's index is stale (a filtered row shifted), but the label names
  // the row that was pressed.
  api.SidePanel.runPanelMenuRow(1, 'Reply to Homeroom bot');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(opened, ['reply'], 'the row the label named, not its neighbour');
  api.SidePanel.runPanelMenuRow(1, 'Propose to close');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(opened, ['reply', 'close'], 'Propose to close ran in the page');
  api.sidePanelRefs.frame = null;
  api._resetForTests();
});

test('the column\'s ⋯ menu is a solid sheet above the page, in both looks (#6431)', () => {
  // The menu is drawn in the shell's own document, where Messages' surface
  // tokens are not declared (they live on .messages-layout,
  // .dev-ws-discussion, .dev-request and #ai-screen .ai-askbar). Its fill and
  // hover resolved to nothing, so the page's rows showed straight through it
  // under its shadow (Evan, 6 Nov 2026: "overlapping weirdly... fully
  // transparent"). The wrapper declares the same pair, opaque in each look,
  // and stacks above the panel's body.
  const rule = (sel) => {
    const at = CSS.indexOf(`${sel} {`);
    assert.ok(at >= 0, `${sel} is drawn`);
    return CSS.slice(at, CSS.indexOf('}', at) + 1);
  };
  const more = rule('.side-panel-more');
  assert.match(more, /position: relative;/, 'the wrapper is the menu\'s anchor');
  assert.match(more, /z-index: 2;/, 'and its layer, above the panel\'s body');
  // The heading is in the lists that declare Messages' tokens, so the menu's
  // fill (and the ⋯ button's hover step) is the opaque one Messages draws.
  const tokens = (start) => CSS.slice(CSS.indexOf(start), CSS.indexOf('}', CSS.indexOf(start)));
  const light = tokens('.messages-layout,');
  assert.match(light, /\.side-panel-head,/);
  assert.match(light, /--messages-surface: #ffffff;/, 'the menu\'s fill, light');
  assert.match(light, /--messages-surface-2: var\(--bg-secondary\);/, 'and its hover step');
  const dark = tokens('.dark .messages-layout,');
  assert.match(dark, /\.dark \.side-panel-head,/);
  assert.match(dark, /--messages-surface: var\(--dc-raised\);/, 'the menu\'s fill, dark');
  assert.match(dark, /--messages-surface-2: #3a3a3c;/, 'and its hover step');
  // A hairline on top of the base rule's lift, so it reads as a sheet over the
  // page rather than a hole in it. The menu itself is still Messages' absolute
  // layer, and its base rule still paints the surface declared above.
  assert.match(rule('.side-panel-more .messages-thread-menu'),
    /box-shadow: 0 12px 30px rgba\(0, 0, 0, \.18\), inset 0 0 0 1px var\(--messages-hair\);/);
  const base = rule('.messages-thread-menu');
  assert.match(base, /position: absolute;/);
  assert.match(base, /z-index: 30;/);
  // #6765: the menu is also drawn on the bot page's thread rows, under none
  // of those token hosts, so its fill and hover carry their own fallbacks
  // (white and --bg-secondary in light, --dc-raised and #3a3a3c in dark) and
  // never resolve to nothing there. A host that declares the tokens wins,
  // because a fallback is used only when the variable is unset.
  assert.match(base, /background: var\(--messages-surface, #ffffff\);/,
    'the menu\'s fill has a light fallback');
  assert.match(rule('.messages-thread-menu button:hover'),
    /background: var\(--messages-surface-2, var\(--bg-secondary\)\);/,
    'and its hover step a light fallback');
  assert.match(rule('.dark .messages-thread-menu'),
    /background: var\(--messages-surface, var\(--dc-raised\)\);/,
    'the menu\'s fill has a dark fallback');
  assert.match(rule('.dark .messages-thread-menu button:hover'),
    /background: var\(--messages-surface-2, #3a3a3c\);/,
    'and its hover step a dark fallback');
});

test('a new page, a new frame and leaving drop the head with the title (#6431)', () => {
  besideBot('app/x/dev/issues/6431', { kind: 'request', pill: PILL_BUILDING, menuKey: 'request:6431' });
  assert.equal(api.sidePanelStore.get().head.pill.key, 'building');

  api.open('app/x/dev/issues/6432', null);
  assert.equal(api.sidePanelStore.get().head, null, 'a new page is a new heading');

  api.embeddedApi.head('app/x/dev/issues/6432', { kind: 'request', pill: PILL_BUILDING, menuKey: 'request:6432' });
  api.open('app/x/dev/issues/6432', null);
  assert.equal(api.sidePanelStore.get().head.pill.key, 'building', "the same page settling keeps it");

  api.drop();
  assert.equal(api.sidePanelStore.get().head, null, 'and leaving drops it with the frame');
  assert.equal(api.INITIAL.head, null, 'the prerender has none');
  api._resetForTests();
});

// ── #6380: Open in workshop, from the column to the project's Workshop ──

test('workshopItemOf names the project and the item a route opens there (#6380)', () => {
  const cases = [
    ['app/notes-ab12/dev/issues/6214', { slug: 'notes-ab12', ref: { kind: 'issue', id: 6214 } }],
    ['app/notes-ab12/dev/proposals/12', { slug: 'notes-ab12', ref: { kind: 'proposal', id: 12 } }],
    ['app/notes-ab12/dev/sessions/12', { slug: 'notes-ab12', ref: { kind: 'proposal', id: 12 } }],
    ['app/notes-ab12/dev/shared/12', { slug: 'notes-ab12', ref: { kind: 'proposal', id: 12 } }],
    ['app/notes-ab12/dev/governance/5', { slug: 'notes-ab12', ref: { kind: 'gov', id: 5 } }],
    ['app/notes-ab12/dev/changes/6362', { slug: 'notes-ab12', pr: 6362 }],
    // An app's discussion's old per-change address is a change (panelPage).
    ['app/notes-ab12/individual-chat/12', { slug: 'notes-ab12', ref: { kind: 'proposal', id: 12 } }],
  ];
  for (const [route, want] of cases) assert.deepEqual(R.workshopItemOf(route), want, route);
  // No item a project page shows: the Workshop itself, its list addresses,
  // the old New change address, conversations, an old agent session's
  // address, and nothing at all.
  for (const route of [
    'app/notes-ab12/workshop', 'app/notes-ab12', 'app/notes-ab12/board',
    'app/notes-ab12/dev', 'app/notes-ab12/dev/sessions', 'app/notes-ab12/dev/sessions/new',
    'app/notes-ab12/dev/chat', 'app/notes-ab12/dev/issues', 'app/notes-ab12/dev/issues/0',
    'messages/4242', 'messages/app/notes-ab12', 'messages/agent/7', 'agent/7',
    'individual-chat/12', '', null, undefined,
  ]) assert.equal(R.workshopItemOf(route), null, String(route));
});

test('the stash for the Workshop is taken once, for its project, and only while it is fresh (#6380)', async () => {
  const P = api.panelTarget;
  const fired = [];
  globalThis.window = { dispatchEvent: (e) => fired.push(e.type) };
  P._resetWorkshopPanelTarget();
  // Nothing waiting: nothing opened.
  assert.equal(await P.takeWorkshopPanelItem('notes-ab12'), null);
  // Another project's Workshop does not take it, and leaves it waiting.
  P.stashWorkshopPanelItem('notes-ab12', { ref: { kind: 'issue', id: 6214 } });
  assert.deepEqual(fired, ['usernode:workshop-panel-target'], 'a page already up is told');
  assert.equal(await P.takeWorkshopPanelItem('other-app'), null);
  assert.deepEqual(await P.takeWorkshopPanelItem('notes-ab12'), { kind: 'issue', id: 6214 });
  assert.equal(await P.takeWorkshopPanelItem('notes-ab12'), null, 'taken once');
  // A stash older than the TTL is ignored, so a later visit is not moved by it.
  const now = Date.now;
  try {
    P.stashWorkshopPanelItem('notes-ab12', { ref: { kind: 'proposal', id: 12 } });
    Date.now = () => now() + P.WORKSHOP_PANEL_TTL_MS + 1;
    assert.equal(await P.takeWorkshopPanelItem('notes-ab12'), null);
  } finally {
    Date.now = now;
  }
  // A change by its pull request number is resolved to its session, and a
  // failed read opens nothing.
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return String(url).includes('/changes/6362')
      ? { ok: true, json: async () => ({ sessionId: 12 }) }
      : { ok: false, json: async () => ({}) };
  };
  try {
    P.stashWorkshopPanelItem('notes-ab12', { pr: 6362 });
    assert.deepEqual(await P.takeWorkshopPanelItem('notes-ab12'), { kind: 'proposal', id: 12 });
    assert.equal(asked[0], '/api/apps/notes-ab12/changes/6362');
    P.stashWorkshopPanelItem('notes-ab12', { pr: 1 });
    assert.equal(await P.takeWorkshopPanelItem('notes-ab12'), null);
  } finally {
    delete globalThis.fetch;
    P._resetWorkshopPanelTarget();
  }
});

test('Open in workshop leaves the item for the Workshop and opens it, and on a narrow window opens the page (#6380)', async () => {
  // Wide: the item is stashed, the project's Workshop tab is chosen, its
  // route is navigated to, and the column goes.
  const wide = topWindow({ width: 1280 });
  api.take('app/notes-ab12/dev/issues/6214');
  fakeFrame();
  api.embeddedApi.ready('app/notes-ab12/dev/issues/6214', 'A request');
  let landed = null;
  wide.win.AppView = { _landOnTab: (slug, tab) => { landed = [slug, tab]; } };
  api.openInWorkshop();
  assert.deepEqual(landed, ['notes-ab12', 'workshop'], 'the Workshop place, before the navigation');
  assert.deepEqual(wide.pushed, ['/?demo=1#app/notes-ab12/workshop']);
  assert.equal(wide.routed.length, 1);
  assert.equal(api.sidePanelStore.get().frameSrc, null, 'the column is gone');
  assert.deepEqual(await api.panelTarget.takeWorkshopPanelItem('notes-ab12'),
    { kind: 'issue', id: 6214 }, 'waiting for the Workshop');
  cleanup();

  // Narrow: no panel beside the Workshop list, so it opens the item's page.
  const narrow = topWindow({ width: 900, app: null, visible: false, screen: 'ai-screen' });
  assert.equal(api.take('app/notes-ab12/dev/changes/6362'), true, 'the column beside the bot\'s list');
  fakeFrame();
  api.embeddedApi.ready('app/notes-ab12/dev/changes/6362', 'A change');
  narrow.win.AppView = { _landOnTab: () => { throw new Error('not a Workshop navigation'); } };
  api.openInWorkshop();
  assert.deepEqual(narrow.pushed, ['/?demo=1#app/notes-ab12/dev/changes/6362'], 'the page, as Expand opens it');
  assert.equal(await api.panelTarget.takeWorkshopPanelItem('notes-ab12'), null, 'nothing stashed');
  cleanup();

  // A page that is not a project's item (a private thread, no page at all)
  // opens nothing at all.
  const thread = topWindow();
  api.take('messages/4242');
  fakeFrame();
  api.embeddedApi.ready('messages/4242', 'A thread');
  api.openInWorkshop();
  assert.deepEqual(thread.pushed, []);
  assert.equal(api.sidePanelStore.get().route, 'messages/4242', 'the column stays where it was');
  cleanup();
});

// ── 9. Dragging the edge to the edge (#6963) ─────────────────────────────
//
// On the bot page the divider's neighbour is the thread list. Dragged past the
// list's floor it stops being a width and becomes a choice: the list hides,
// the thread takes the room, and the same edge (or the head's button, in
// features/ai/list-closed) brings it back. The choice is this device's,
// beside the width.

test('the list hidden is this device\'s choice, stored beside the width', () => {
  const { readListClosed, writeListClosed, AI_LIST_CLOSED_KEY, SNAP_PX } = api.resize;
  const mem = new Map();
  const store = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  assert.equal(AI_LIST_CLOSED_KEY, 'usernode_ai_list_closed_v1');
  assert.equal(SNAP_PX, 48, 'the distance past the floor that hides the list');
  assert.equal(readListClosed(store), false, 'nothing chosen: the split, as today');
  writeListClosed(true, store);
  assert.equal(mem.get(AI_LIST_CLOSED_KEY), '1');
  assert.equal(readListClosed(store), true);
  writeListClosed(false, store);
  assert.equal(mem.has(AI_LIST_CLOSED_KEY), false, 'a split is the default, so nothing is kept');
  assert.equal(readListClosed(store), false);
  const throwing = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  assert.equal(readListClosed(throwing), false);
  assert.doesNotThrow(() => writeListClosed(true, throwing));
  assert.doesNotThrow(() => writeListClosed(false, throwing));
  assert.equal(readListClosed(null), false, 'no storage at all');
});

test('pulling the list back opens it at the width last chosen, never a sliver', () => {
  const { reopenWidth, bounds } = api.resize;
  const b = bounds({ innerWidth: 1440, appLeft: 0 });
  assert.equal(reopenWidth(null, b), null, 'nothing chosen: the stylesheet\'s own split');
  assert.equal(reopenWidth(120, b), 320, 'narrower than the pane may be: its floor');
  assert.equal(reopenWidth(612, b), 612, 'the width that was left');
  assert.equal(reopenWidth(5000, b), 960, 'and never wider than this window allows');
});

test('the chart: a drag past the list\'s floor hides it, and back out brings it back', () => {
  const { SidePanelDivider } = loadTsx('frontend/src/features/side-panel/side-panel.tsx');
  const inRender = (fn) => { let out; const Probe = () => { out = fn(); return null; }; require('./lib/render-tsx').renderToHtml(require('./lib/render-tsx').createElement(Probe)); return out; };

  const width = 1280;
  let paneLeft = 480;            // the pane is 800 wide here; 1000 at its floor
  const neighbourMin = 280;      // the list's floor (--ai-list-min below 1024px)
  const props = new Map();
  const mem = new Map();
  const classes = new Set();
  const doc = {
    documentElement: {
      dir: 'ltr',
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
    },
    body: null,
    getElementById: () => null,
  };
  globalThis.window = {
    innerWidth: width,
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    },
    document: doc,
  };
  globalThis.document = doc;
  const panel = { getBoundingClientRect: () => ({ left: paneLeft, right: width, width: width - paneLeft }) };
  const panelRef = { current: panel };
  const measure = () => ({ innerWidth: width, appLeft: 0, neighbourMin });
  // The floor here: a 1280px room less the list's 280px, so 1000 is as wide as
  // the pane goes before the list's floor is passed.
  const maxW = 1000;

  const calls = [];
  const draw = (collapsed) => inRender(() => SidePanelDivider({
    panelRef, shown: true, id: 'ai-main-divider', controls: 'ai-main-pane',
    widthKey: api.resize.AI_MAIN_WIDTH_KEY, probe: measure,
    collapsed, onCollapse: () => calls.push('collapse'), onRestore: () => calls.push('restore'),
  }));

  const target = { setPointerCapture() {}, releasePointerCapture() {} };
  const down = (x) => ({ button: 0, pointerId: 1, clientX: x, preventDefault() {}, currentTarget: target });
  const move = (x) => ({ pointerId: 1, clientX: x, currentTarget: target });
  const up = (x) => ({ pointerId: 1, clientX: x, currentTarget: target });
  const key = (k) => ({ key: k, shiftKey: false, preventDefault() {} });

  // A little past the floor is still the floor: the drag clamps, as it did.
  let el = draw(false);
  el.props.onPointerDown(down(500));
  el.props.onPointerMove(move(300));           // raw 1000 + 0: at the floor
  props.delete('--ai-main-chosen-w');
  el.props.onPointerMove(move(260));           // raw 1040: 40 past, not 48
  assert.deepEqual(calls, [], 'inside the snap distance the list stays, and the drag stops at its floor');
  assert.equal(props.get('--ai-main-chosen-w'), '1000px');
  el.props.onPointerUp(up(260));

  // Past it by SNAP_PX, the list hides.
  el.props.onPointerDown(down(500));
  el.props.onPointerMove(move(200));           // raw 1100, 100 past
  assert.deepEqual(calls, ['collapse'], 'the list snaps away past its floor');
  assert.equal(props.get('--ai-main-chosen-w'), '1000px', 'a hidden list chose no width');
  const chosenBefore = mem.get(api.resize.AI_MAIN_WIDTH_KEY);
  el.props.onPointerUp(up(200));
  assert.equal(mem.get(api.resize.AI_MAIN_WIDTH_KEY), chosenBefore, 'and none is written');

  // The same drag back out brings it back at the width last chosen.
  mem.set(api.resize.AI_MAIN_WIDTH_KEY, '620');
  props.delete('--ai-main-chosen-w');
  const draw2 = calls.length;
  el = draw(true);
  el.props.onPointerDown(down(200));
  el.props.onPointerMove(move(230));           // 30 back out: not yet
  assert.equal(calls.length, draw2, 'backing out starts at SNAP_PX');
  el.props.onPointerMove(move(260));           // 60 back out
  assert.deepEqual(calls.slice(draw2), ['restore'], 'and brings the list back');
  assert.equal(props.get('--ai-main-chosen-w'), '620px', 'at the width last chosen, not a sliver');

  // The keyboard: one widening press at the floor hides it, and the opposite
  // arrow brings it back.
  // At its floor: the pane is as wide as it goes before the list's is passed.
  paneLeft = 280;
  calls.length = 0;
  el = draw(false);
  el.props.onKeyDown(key('ArrowLeft'));
  assert.deepEqual(calls, ['collapse'], 'Left at the list\'s floor hides it');
  el = draw(true);
  el.props.onKeyDown(key('ArrowLeft'));
  assert.deepEqual(calls, ['collapse'], 'the widening arrow does nothing while hidden');
  el.props.onKeyDown(key('ArrowRight'));
  assert.deepEqual(calls, ['collapse', 'restore'], 'Right brings it back');
  assert.equal(el.props['aria-valuetext'], 'Thread list hidden', 'a screen reader hears the list is hidden');
  assert.equal(draw(false).props['aria-valuetext'], undefined, 'and nothing while it is shown');

  // A double-click resets the split and brings the list back too.
  calls.length = 0;
  draw(true).props.onDoubleClick();
  assert.deepEqual(calls, ['restore']);

  // With no callbacks the edge is the panel's own width, clamped exactly as
  // before this existed (the side panel beside a running app).
  calls.length = 0;
  el = inRender(() => SidePanelDivider({ panelRef, shown: true, id: 'side-panel-divider', controls: 'platform-side-panel', widthKey: api.resize.WIDTH_KEY, probe: measure }));
  assert.equal(el.props.onCollapse, undefined);
  el.props.onPointerDown(down(500));
  el.props.onPointerMove(move(100));
  assert.equal(props.get('--side-panel-w'), '1000px', 'still clamped at the list\'s floor');
  assert.equal(calls.length, 0);

  delete globalThis.window;
  delete globalThis.document;
});

test('beside a preview, pulling the list back opens the thread inside the three columns it returns to (24 Nov 2026)', () => {
  // With the list put away beside a preview, the thread and the preview are
  // in halves; the list's return makes three columns again. The width the
  // thread reopens at is read once that is drawn (flushSync), so it is the
  // width last chosen, not one squeezed into the halves the drag left.
  const { SidePanelDivider } = loadTsx('frontend/src/features/side-panel/side-panel.tsx');
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const inRender = (fn) => { let out; const Probe = () => { out = fn(); return null; }; renderToHtml(createElement(Probe)); return out; };
  const width = 1720;
  const props = new Map();
  const mem = new Map([[api.resize.AI_PREVIEW_COLUMN_WIDTH_KEY, '420']]);
  const doc = {
    documentElement: {
      dir: 'ltr',
      classList: { add() {}, remove() {}, contains: () => false },
      style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
    },
    body: null,
    getElementById: () => null,
  };
  globalThis.window = {
    innerWidth: width,
    localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
    document: doc,
  };
  globalThis.document = doc;
  // Halves: the preview is half of the 1476px room, so beside a 480px list
  // the thread would have no room at all. Three columns: a 556px preview.
  let three = false;
  const measure = () => {
    const preview = three ? 556 : 738;
    return { innerWidth: width, appLeft: 244, neighbourMin: 480 + preview, endAt: width - preview };
  };
  const panel = { getBoundingClientRect: () => ({ left: 244, right: width - 738, width: 738 }) };
  const calls = [];
  const el = inRender(() => SidePanelDivider({
    panelRef: { current: panel }, shown: true, id: 'ai-main-divider', controls: 'ai-main-pane',
    widthKey: api.resize.AI_PREVIEW_COLUMN_WIDTH_KEY, probe: measure,
    collapsed: true,
    onCollapse: () => calls.push('collapse'),
    onRestore: () => { calls.push('restore'); three = true; },
  }));
  const target = { setPointerCapture() {}, releasePointerCapture() {} };
  el.props.onPointerDown({ button: 0, pointerId: 1, clientX: 244, preventDefault() {}, currentTarget: target });
  el.props.onPointerMove({ pointerId: 1, clientX: 300, currentTarget: target });
  assert.deepEqual(calls, ['restore'], 'back out past the snap distance');
  assert.equal(props.get('--ai-col-chosen-w'), '420px', 'the thread reopens at the width last chosen');
  el.props.onPointerUp({ pointerId: 1, clientX: 300, currentTarget: target });
  assert.equal(mem.get(api.resize.AI_PREVIEW_COLUMN_WIDTH_KEY), '420', 'and that is the width kept');
  delete globalThis.window;
  delete globalThis.document;
  const src = read('frontend/src/features/side-panel/side-panel.tsx');
  assert.match(src, /import \{ flushSync \} from 'react-dom';/);
  assert.match(src, /flushSync\(\(\) => \{ onRestore\?\.\(\); \}\);\s+const key = resolveKey\(\);\s+const back = bounds\(measure\(\)\);\s+const next = reopenWidth\(readStoredWidth\(undefined, key\), back\);/,
    'the room is read after the list is drawn back');
});

test('beside a request, change or decision page the same edge hides the list, and the frame is told (#6973)', () => {
  // The page in the panel is another document: it cannot read the list store,
  // so the controller marks its <html> (LIST_HIDDEN_CLASS) and app.css shows
  // the page's own list button from that class. Its press comes back through
  // the bridge as SidePanel.showList().
  const classes = new Set();
  const root = {
    classList: {
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
  };
  topWindow();
  api.sidePanelRefs.frame = { contentDocument: { documentElement: root } };
  const { setListClosed, setDocked, isListClosed } = api.listClosed;

  // Hidden, but no page docked: the frame is told nothing.
  setDocked(false);
  setListClosed(true);
  api.appPresence(true);
  assert.equal(isListClosed(), true);
  assert.equal(classes.has(api.LIST_HIDDEN_CLASS), false, 'no split, so no button on the page');

  // A page is the column: the class follows the choice.
  setDocked(true);
  api.appPresence(true);
  assert.equal(classes.has(api.BESIDE_AI_CLASS), true, 'the page knows it is beside the bot page');
  assert.equal(classes.has(api.LIST_HIDDEN_CLASS), true, 'and that the list is hidden');

  // The page's button, through the bridge, brings the list back.
  assert.equal(typeof api.SidePanel.showList, 'function');
  api.SidePanel.showList();
  assert.equal(isListClosed(), false);
  api.appPresence(true);
  assert.equal(classes.has(api.LIST_HIDDEN_CLASS), false, 'the class goes with the list');

  // The bot page leaves: nothing is marked, even with the choice still hidden.
  setListClosed(true);
  topWindow({ screen: null });
  api.sidePanelRefs.frame = { contentDocument: { documentElement: root } };
  api.appPresence(true);
  assert.equal(classes.has(api.LIST_HIDDEN_CLASS), false, 'not beside the bot page');

  const controller = read('frontend/src/features/side-panel/controller.ts');
  assert.match(controller, /export const LIST_HIDDEN_CLASS = 'side-panel-list-hidden';/);
  assert.match(controller, /subscribeListClosed\(markBeside\)/, 'the frame is re-marked when the list hides or comes back');
  assert.match(controller, /export function showList\(\): void \{\s+setListClosed\(false\);\s+\}/);
  assert.match(controller, /showList,/);
  cleanup();
});

test('the page\'s list button is the same one a private thread draws, and only a panel with the list hidden shows it (#6973)', () => {
  const exits = read('frontend/src/features/dev-board/topic/thread-exits.tsx');
  assert.match(exits, /export function ThreadShowList\(\): ReactNode \{/);
  assert.match(exits, /className="messages-thread-action messages-thread-back dev-thread-show-list"\s+data-thread-show-list=""\s+aria-label=\{t\('project:sidePanel\.showList'\)\}/,
    'the round list button, named by its tooltip');
  assert.match(exits, /onClick=\{\(\) => topPanel\(\)\?\.showList\?\.\(\)\}/,
    'pressing it asks the top document\'s panel controller');
  for (const file of ['request-head.tsx', 'change-head.tsx']) {
    const src = read(`frontend/src/features/dev-board/topic/${file}`);
    assert.match(src, /import \{ ThreadExits, ThreadShowList \} from '\.\/thread-exits';/);
    assert.match(src, /<ThreadHeadCard\s+lead=\{<ThreadShowList \/>\}/,
      `${file}: first in the head, before the tile`);
  }
  assert.match(read('frontend/src/features/side-panel/side-panel.tsx'),
    /\{showList \? \(\s+<button\s+type="button"\s+className="messages-thread-action messages-thread-back side-panel-show-list"[\s\S]*?onClick=\{\(\) => controller\.showList\(\)\}/,
    'a decision\'s page keeps the column\'s row, so the button is there too');
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-thread-show-list \{ display: none; \}/);
  assert.match(css, /html\.in-side-panel\.side-panel-beside-ai\.side-panel-list-hidden \.dev-thread-show-list \{ display: inline-flex; \}/,
    'shown only in the panel, with the list hidden');
});
