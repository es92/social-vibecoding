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
//      and hands everything it does not show to the top window.
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

test('the panel\'s pages: an app\'s Workshop and work, conversations, agent chats', () => {
  const kinds = {
    'app/notes-ab12/workshop': 'workshop',
    'app/notes-ab12/board': 'workshop',
    'app/notes-ab12/activity': 'workshop',
    'app/notes-ab12/dev': 'workshop',
    'app/notes-ab12/dev/proposals': 'workshop',
    'app/notes-ab12/dev/proposals/12': 'proposal',
    'app/notes-ab12/dev/governance/3': 'proposal',
    'app/notes-ab12/dev/issues/7': 'issue',
    'app/notes-ab12/dev/sessions/new': 'new-change',
    'app/notes-ab12/dev/sessions/41': 'change',
    'app/notes-ab12/dev/shared/41': 'change',
    // #3653: an app's discussion is its project page's Discussion tab, so
    // its old addresses are that page.
    'app/notes-ab12/dev/chat': 'workshop',
    'app/notes-ab12/group-chat': 'workshop',
    'messages/app/notes-ab12': 'workshop',
    'messages/4242': 'thread',
    'messages': 'messages',
    'chat': 'chat',
    'chat/5f0c1d2e-aaaa-bbbb-cccc-000000000001': 'chat',
  };
  for (const [route, kind] of Object.entries(kinds)) {
    const page = R.panelPage(route);
    assert.equal(page && page.kind, kind, route);
    assert.equal(R.embeddedAllows(route), true, `the panel's own document shows ${route}`);
  }
  // Everything else is somewhere the panel does not go.
  for (const route of ['', 'apps', 'apps/notes-ab12', 'workshop', 'profile', 'profile/dana',
    'settings', 'leaderboard', 'admin', 'notifications', 'create',
    'app/notes-ab12', 'app/notes-ab12/app', 'app/notes-ab12/full']) {
    assert.equal(R.panelPage(route), null, `${route || '(home)'} is not a panel page`);
    assert.equal(R.isPanelRoute(route), false);
    assert.equal(R.embeddedAllows(route), false);
  }
});

test('an agent session opens beside the app by either address, climbs to Messages, and titles itself (#2779)', () => {
  // `agent/<id>` is the conversation's own screen; `messages/agent/<id>` is
  // the address Messages links it with. The panel is phone-width, so its
  // document swaps the second for the first in place: one page, one key.
  for (const route of ['agent/7', 'agent/7/changes', 'messages/agent/7']) {
    const page = R.panelPage(route);
    assert.equal(page && page.kind, 'agent', route);
    assert.equal(page.key, 'agent/7', route);
    assert.equal(R.isPanelRoute(route), true, `${route} opens beside the app`);
    assert.equal(R.embeddedAllows(route), true, `the panel's own document shows ${route}`);
    assert.equal(R.parentRoute(route), 'messages', 'Back climbs to the inbox, like any conversation');
  }
  assert.equal(R.samePage('messages/agent/7', 'agent/7'), true, 'the in-place swap is not a navigation');
  assert.equal(R.samePage('agent/7/changes', 'agent/7'), true, 'the drawer is the same page');
  assert.equal(R.samePage('agent/7', 'agent/8'), false);
  // A UUID under messages/agent is a Global Chat thread, which stays out.
  assert.equal(R.isPanelRoute('messages/agent/5f0c1d2e-aaaa-bbbb-cccc-000000000001'), false);
  for (const route of ['agent', 'agent/abc', 'agent/0']) {
    assert.equal(R.panelPage(route), null, `${route} is not a panel page`);
  }
  // Its header names the session, as a conversation's does.
  assert.equal(R.titleFor('agent/7', 'Dark mode for the dev board'), 'Dark mode for the dev board');
  assert.equal(R.titleFor('agent/7', ''), 'Agent session');
  // Expand lands on its desktop home, beside the inbox; every other page as is.
  assert.equal(R.expandRoute('agent/7/changes'), 'messages/agent/7');
  assert.equal(R.expandRoute('messages/agent/7'), 'messages/agent/7');
  assert.equal(R.expandRoute('messages/4242'), 'messages/4242');
  assert.equal(R.expandRoute('app/notes-ab12/dev/sessions/41'), 'app/notes-ab12/dev/sessions/41');
});

test('the inbox is where Back climbs to, but a link to it is the Messages TAB and leaves the app', () => {
  assert.equal(R.isPanelRoute('messages'), false, 'the sidebar\'s tabs keep their meaning');
  assert.equal(R.embeddedAllows('messages'), true, 'and the panel\'s own document still shows it');
  for (const route of ['messages/4242', 'messages/app/notes-ab12', 'chat', 'app/notes-ab12/workshop',
    'app/other-app/dev/proposals/9']) {
    assert.equal(R.isPanelRoute(route), true, `${route} opens beside the app`);
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

test('Back climbs: a message to Messages, a proposal, an issue or a change to the Workshop', () => {
  // #3653: an app's discussion is its project page, which has nothing above it.
  assert.equal(R.parentRoute('messages/app/notes-ab12'), null);
  assert.equal(R.parentRoute('app/notes-ab12/dev/chat'), null);
  assert.equal(R.samePage('messages/app/notes-ab12/thread/7', 'app/notes-ab12/workshop'), true,
    'the redirect to the page is not a navigation');
  assert.equal(R.samePage('app/notes-ab12/dev/chat', 'app/notes-ab12/workshop'), true);
  assert.equal(R.parentRoute('messages/4242'), 'messages');
  assert.equal(R.parentRoute('chat/abc'), 'messages');
  for (const route of ['app/notes-ab12/dev/proposals/12', 'app/notes-ab12/dev/issues/7',
    'app/notes-ab12/dev/sessions/41', 'app/notes-ab12/dev/sessions/new', 'app/notes-ab12/dev/shared/41']) {
    assert.equal(R.parentRoute(route), 'app/notes-ab12/workshop', route);
  }
  assert.equal(R.parentRoute('app/notes-ab12/workshop'), null, 'the lists have nothing above them');
  assert.equal(R.parentRoute('messages'), null);
});

test('the title is the page\'s own header title, except where that would only name the app', () => {
  assert.equal(R.titleFor('messages/4242', 'Design review'), 'Design review');
  assert.equal(R.titleFor('messages/app/notes-ab12', 'Notes'), 'Workshop', 'a discussion is its project page (#3653)');
  assert.equal(R.titleFor('app/notes-ab12/workshop', 'Notes'), 'Workshop', 'the Workshop is the Workshop, as the prototype titles it');
  assert.equal(R.titleFor('messages', 'Inbox'), 'Messages', 'and the inbox is Messages');
  assert.equal(R.titleFor('app/notes-ab12/dev/proposals/12', 'Notes'), 'Proposal');
  assert.equal(R.titleFor('app/notes-ab12/dev/issues/7', 'Notes'), 'Request');
  assert.equal(R.titleFor('app/notes-ab12/dev/sessions/41', 'Notes'), 'Change');
  assert.equal(R.titleFor('app/notes-ab12/dev/sessions/new', 'Notes'), 'New change');
  // Derived from the route while the document has said nothing yet.
  assert.equal(R.titleFor('app/notes-ab12/workshop', ''), 'Workshop');
  assert.equal(R.titleFor('messages/4242', ''), 'Messages');
  assert.equal(R.titleFor('messages/app/notes-ab12', ''), 'Workshop');
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

test('the host ships in every document, hidden, frameless, with Back hidden and the row named', () => {
  const at = HTML.indexOf('<aside id="platform-side-panel"');
  assert.ok(at > 0, 'the panel host is part of the shipped shell');
  const el = HTML.slice(at, HTML.indexOf('</aside>', at) + 8);
  assert.match(el, /^<aside id="platform-side-panel" class="side-panel hidden"/,
    'hidden, with the class a CONSTANT so the hydrating render agrees');
  assert.doesNotMatch(el, /<iframe/, 'no frame until a panel is opened');
  assert.match(el, /<button id="side-panel-back" type="button" aria-label="Back" title="Back" class="hidden /,
    'Back ships hidden (there is nowhere to go yet)');
  assert.match(el, /<h2 id="side-panel-title"[^>]*><\/h2>/, 'the title ships empty');
  assert.match(el, /id="side-panel-expand"[^>]*aria-label="Open full width, leaving the app"[^>]*title="Open full width"/);
  assert.match(el, /id="side-panel-close"[^>]*aria-label="Close panel"/);
  assert.match(el, /d="M14 4h6v6"[\s\S]*d="M20 4l-7 7"[\s\S]*d="M10 20H4v-6"[\s\S]*d="M4 20l7-7"/,
    'Expand wears the outward arrows');
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
  assert.match(loading, /<iframe id="side-panel-frame" title="Side panel" src="\/\?panel=1#messages\/4" class="side-panel-frame"><\/iframe><div id="side-panel-loading"/,
    'the frame is the body\'s first child, transparent while its document boots');
  assert.match(loading, />Design review<\/h2>/);
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
  assert.match(SRC, /useHiddenClass\(backRef, !s\.canBack\)/);
  assert.match(SRC, /key=\{s\.frameKey\}/, 'one element per frame, keyed by its generation alone');
  assert.doesNotMatch(SRC, /gray-|indigo-/);
});

// ── 3 & 4. The controller, driven ────────────────────────────────────────

function topWindow({ width = 1280, app = 'notes-ab12', tab = 'app', chromeless = false,
  visible = true, user = { id: 1 }, native = false, embedded = false } = {}) {
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
    matchMedia: (q) => ({ matches: q === '(min-width: 1024px)' ? width >= 1024 : false }),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    App: {
      user, chromeless, currentApp: app, currentTab: tab,
      _isScreenVisible: (id) => id === 'app-view' && visible,
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
    contentWindow: { UsernodeReact: { sidePanelEmbed: { go: (route, hint) => gone.push([route, hint]) } } },
  };
  api.sidePanelRefs.frame = frame;
  return gone;
}

function cleanup() {
  api._resetForTests();
  delete globalThis.window;
  delete globalThis.document;
}

test('the panel takes a navigation only beside a running app, at desktop width, in the top document', () => {
  const cases = [
    [{}, true, 'an app on its App tab, 1280 wide'],
    [{ width: 1023 }, false, 'below the breakpoint'],
    [{ width: 390 }, false, 'a phone'],
    [{ tab: 'dev' }, false, 'the app\'s own Workshop is on screen, not the app'],
    [{ app: null }, false, 'no app at all'],
    [{ chromeless: true }, false, 'chromeless'],
    [{ visible: false }, false, 'the app view is not on screen'],
    [{ user: null }, false, 'signed out'],
    [{ native: true }, false, 'the native app\'s WebView'],
    [{ embedded: true }, false, 'inside the panel itself'],
  ];
  for (const [opts, expected, why] of cases) {
    topWindow(opts);
    assert.equal(api.canTake(), expected, why);
    assert.equal(api.take('app/notes-ab12/workshop'), expected, `take: ${why}`);
    cleanup();
  }
  topWindow();
  assert.equal(api.take('messages'), false, 'the inbox itself is the Messages tab, never the panel');
  assert.equal(api.take('profile/dana'), false);
  assert.equal(api.sidePanelStore.get().frameSrc, null);
  cleanup();
});

test('opening starts ONE document, and later pages are navigations inside it', () => {
  topWindow();
  assert.equal(api.take('app/notes-ab12/workshop'), true);
  let s = api.sidePanelStore.get();
  assert.equal(s.open, true);
  assert.equal(s.frameSrc, '/?demo=1&panel=1#app/notes-ab12/workshop');
  assert.equal(s.frameKey, 1);
  assert.equal(s.loading, true);
  assert.equal(s.title, 'Workshop', 'titled from the route until the document says');
  assert.equal(s.canBack, false);
  const gone = fakeFrame();
  // A second page asked for while it boots is where it goes once it can.
  api.take('messages/4242');
  assert.deepEqual(gone, [], 'nothing to tell a document that has not booted');
  api.embeddedApi.ready('app/notes-ab12/workshop', 'Workshop');
  assert.deepEqual(gone, [['messages/4242', null]]);
  s = api.sidePanelStore.get();
  assert.equal(s.loading, false);
  assert.equal(s.route, 'messages/4242');
  assert.equal(s.canBack, true, 'the Workshop it was opened on is behind it');
  api.embeddedApi.navigated('messages/4242', 'Design review', false);
  assert.equal(api.sidePanelStore.get().title, 'Design review');
  // Another page: the same frame, navigated.
  api.take('app/notes-ab12/dev/proposals/12');
  assert.deepEqual(gone.at(-1), ['app/notes-ab12/dev/proposals/12', null]);
  assert.equal(api.sidePanelStore.get().frameKey, 1, 'never a second frame');
  assert.equal(api.sidePanelStore.get().title, 'Proposal');
  cleanup();
});

test('Back walks the pages opened in the panel, then climbs to the list, then hides', () => {
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
  assert.deepEqual(gone.at(-1), ['app/notes-ab12/dev/sessions/41', null], 'back to the change');
  assert.equal(api.sidePanelStore.get().title, 'Change');
  assert.equal(api.sidePanelStore.get().canBack, true, 'a change still climbs to its Workshop');
  api.back();
  assert.deepEqual(gone.at(-1), ['app/notes-ab12/workshop', null], 'climbed to the app\'s Workshop');
  assert.equal(api.sidePanelStore.get().canBack, false, 'and nothing is above that');
  const count = gone.length;
  api.back();
  assert.equal(gone.length, count, 'Back with nowhere to go goes nowhere');
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
  assert.deepEqual(gone.at(-1), ['app/notes-ab12/dev/proposals/12', null],
    'back to the proposal the reference was followed from');
  // Opened from the top document too: the pointer is the panel's page until
  // the channel replaces it, and is never kept behind it.
  api.take('messages/channel/notes');
  api.embeddedApi.navigated('messages/app/notes-ab12', 'Notes', false);
  api.take('messages/4242');
  api.back();
  assert.deepEqual(gone.at(-1), ['messages/app/notes-ab12', null]);
  api.back();
  assert.deepEqual(gone.at(-1), ['app/notes-ab12/dev/proposals/12', null],
    'the pointer between them was skipped');
  s = api.sidePanelStore.get();
  assert.equal(s.canBack, true, 'a proposal still climbs to its Workshop');
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
  api.take('app/notes-ab12/workshop');
  s = api.sidePanelStore.get();
  assert.equal(s.open, true);
  assert.equal(s.frameKey, 1, 'the same frame');
  assert.deepEqual(gone.at(-1), ['app/notes-ab12/workshop', null]);
  assert.equal(s.canBack, false, 'a closed panel reopens with no history');
  cleanup();
});

test('the app leaving the screen drops the panel and its frame; staying keeps it', () => {
  topWindow();
  api.take('app/notes-ab12/workshop');
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

test('Expand from an agent session goes to Messages, the conversation beside the inbox (#2779)', () => {
  const { pushed, routed } = topWindow();
  assert.equal(api.take('messages/agent/7'), true, 'a conversation opened beside the running app');
  fakeFrame();
  // The panel's document settles on the phone screen's address, same page.
  api.embeddedApi.ready('agent/7', 'Dark mode for the dev board');
  assert.equal(api.sidePanelStore.get().title, 'Dark mode for the dev board');
  api.expand();
  assert.deepEqual(pushed, ['/?demo=1#messages/agent/7'], 'its desktop home, not the phone screen');
  assert.equal(routed.length, 1);
  assert.equal(api.sidePanelStore.get().frameSrc, null, 'the panel is gone');
  cleanup();
});

test('an unsent agent session opens beside the app with its hint, and becomes the session in place (#2779)', () => {
  // `agent/new` is New change before its first message: a panel page like
  // any conversation, with no row behind it yet.
  for (const route of ['agent/new', 'messages/agent/new']) {
    assert.equal(R.panelPage(route).key, 'agent/new', route);
    assert.equal(R.isPanelRoute(route), true, route);
    assert.equal(R.embeddedAllows(route), true, route);
  }
  assert.equal(R.samePage('agent/new', 'agent/7'), false);
  assert.equal(R.panelPage('agent/newer'), null);

  const { pushed } = topWindow();
  const hint = { agentHint: { slug: 'notes-ab12', entry: 'improve' } };
  assert.equal(api.take('messages/agent/new', hint), true);
  // The first page is the frame's own address: the hint waits for its boot.
  assert.deepEqual(api.embeddedApi.takeBootHint(), hint);
  assert.equal(api.embeddedApi.takeBootHint(), null, 'once');
  fakeFrame();
  api.embeddedApi.ready('agent/new', '');
  // The first message created session 7, and the panel's document replaced
  // its address: the same page settling, not a step Back would undo.
  api.embeddedApi.navigated('agent/7', 'Dark mode', false);
  assert.equal(api.sidePanelStore.get().route, 'agent/7');
  assert.equal(api.sidePanelStore.get().canBack, true, 'Back still climbs to the inbox, and only there');
  api.expand();
  assert.deepEqual(pushed, ['/?demo=1#messages/agent/7'], 'Expand finds the session, not a fresh draft');
  cleanup();
});

test('the page the panel shows is in the top window\'s address, so a reload brings the panel back', () => {
  const { win, flush } = topWindow();
  const address = () => `${win.location.pathname}${win.location.search}`;
  assert.equal(api.take('messages/agent/7'), true);
  assert.equal(address(), '/app/notes-ab12?demo=1&side=messages/agent/7', 'in place, every other parameter kept');
  const gone = fakeFrame();
  api.embeddedApi.ready('agent/7', 'Dark mode');
  api.embeddedApi.navigated('app/notes-ab12/dev/proposals/12', 'Notes', true);
  assert.equal(address(), '/app/notes-ab12?demo=1&side=app/notes-ab12/dev/proposals/12', 'and it follows the panel');
  api.close();
  assert.equal(address(), '/app/notes-ab12?demo=1', 'closed: out of the address');
  assert.equal(gone.length, 0);
  api._resetForTests();

  // A reload: the router reports no app while it boots, then the app comes
  // back on screen with ?side= and the panel opens there.
  win.location = new URL('https://homeroom.test/app/notes-ab12?side=agent/7&demo=1');
  api.appPresence(false);
  assert.equal(win.location.search, '?side=agent/7&demo=1', 'booting past "no app" keeps the note');
  api.appPresence(true);
  flush();
  const s = api.sidePanelStore.get();
  assert.equal(s.open, true);
  assert.equal(s.route, 'agent/7');
  assert.equal(s.frameSrc, '/?demo=1&panel=1#agent/7', 'the panel\'s own document does not inherit the note');
  // Leaving the app takes it out, so a later visit starts without a panel.
  api.appPresence(false);
  assert.equal(address(), '/app/notes-ab12?demo=1');

  // Only a page the panel shows is honoured; anything else is dropped.
  assert.equal(api.sideRouteFrom('?side=settings'), null);
  assert.equal(api.sideRouteFrom('?side=agent%2Fnew'), 'agent/new');
  assert.equal(api.sideRouteFrom('?demo=1'), null);
  cleanup();
});

test('a panel that cannot open where the address asks gives up and cleans the address', () => {
  const { win, flush } = topWindow({ width: 800 });
  win.location = new URL('https://homeroom.test/app/notes-ab12?demo=1&side=agent/7');
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
  assert.equal(click('#app/notes-ab12/workshop', { meta: true }), false, 'a new-tab click is the browser\'s');
  assert.equal(click('#app/notes-ab12/workshop', { target: '_blank' }), false);
  assert.equal(api.sidePanelStore.get().frameSrc, null);
  assert.equal(click('#app/notes-ab12/workshop'), true, 'Go to workshop is caught');
  assert.equal(api.sidePanelStore.get().route, 'app/notes-ab12/workshop');
  assert.equal(click('https://github.com/x/y'), false, 'another site is not ours');
  cleanup();
  topWindow({ width: 800 });
  assert.equal(click('#app/notes-ab12/workshop'), false, 'below the breakpoint the link is followed');
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

test('the panel never runs an app: the running one is asked for nothing, another replaces it', () => {
  const { opened, flush } = topWindow();
  api.embeddedApi.openApp('notes-ab12');
  flush();
  assert.deepEqual(opened, [], 'the app beside the panel is already running');
  api.embeddedApi.openApp('other-app');
  flush();
  assert.deepEqual(opened, [['other-app', 'app']]);
  cleanup();
});

// ── 5. The panel's own document ──────────────────────────────────────────

function panelWindow({ href = 'https://homeroom.test/app/notes-ab12/workshop?panel=1', navigation = false, nested = false } = {}) {
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
            takeBootHint: () => ({ proposalHint: true }),
          },
        },
      },
    },
    App: { _currentRoute: null, _routeFromHash: () => routed.push(url.href) },
    AppView: { _proposalHint: false },
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
const tick = () => new Promise((r) => setTimeout(r, 5));

test('the runtime installs only in the panel\'s document', () => {
  globalThis.document = { documentElement: { classList: { contains: () => false } } };
  assert.equal(api.installEmbeddedRuntime({}), null, 'the top document is left alone');
  delete globalThis.document;
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
    p.runtime.go('app/notes-ab12/dev/sessions/new', { proposalHint: true });
    await tick();
    assert.equal(p.win.AppView._proposalHint, true);
    assert.deepEqual(p.reports.at(-1), ['navigated', 'app/notes-ab12/dev/sessions/new', '', false]);
    assert.deepEqual(p.history.pushes, [], 'New change reuses the same panel');
  } finally {
    delete globalThis.document;
  }
});

test('the panel\'s document adds no history entry, and reports each page to the top', async () => {
  const p = panelWindow();
  assert.equal(p.win.AppView._proposalHint, true, 'the first page\'s hint is in place before the router runs');
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
  p.runtime.go('messages/app/notes-ab12', null);
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
  p.runtime.go('app/notes-ab12/dev/sessions/new', { proposalHint: true });
  assert.equal(p.win.AppView._proposalHint, true, 'the hint is in place before the router runs');
  await tick();
  assert.equal(p.url(), 'https://homeroom.test/app/notes-ab12/dev/sessions/new?panel=1');
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
  return { App: context.App, calls, stored };
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
  App.openAppTab('notes-ab12', 'dev', { subTab: 'sessions', ref: 'new' });
  assert.deepEqual(calls.at(-1), ['take', 'app/notes-ab12/dev/sessions/new']);
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

test('the running app\'s presence reaches the panel from the one place that decides it', async () => {
  const { App, calls } = router();
  await App.navigateToApp('notes-ab12', 'app');
  assert.deepEqual(calls.filter((c) => c[0] === 'presence').at(-1), ['presence', true]);
  App.navigateHome();
  assert.deepEqual(calls.filter((c) => c[0] === 'presence').at(-1), ['presence', false],
    'the header\'s close takes the panel with the app');
  await App.navigateToApp('notes-ab12', 'app');
  App.navigateToMessages();
  assert.deepEqual(calls.filter((c) => c[0] === 'presence').at(-1), ['presence', false], 'so does a tab');
  await App.navigateToApp('notes-ab12', 'app');
  await App.switchTab('dev', null, 'forum');
  assert.deepEqual(calls.filter((c) => c[0] === 'presence').at(-1), ['presence', false],
    'and so does the app\'s own Workshop taking the screen (Expand, on a narrow window)');
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

test('the layout: the app narrows by a margin, above the breakpoint, while the panel is up', () => {
  const desk = CSS.slice(CSS.indexOf('@media (min-width: 1024px) {\n  html[data-side-panel] #app-view {'));
  assert.match(desk, /html\[data-side-panel\] #app-view \{\s*margin-right: var\(--side-panel-w\);\s*min-width: 480px;/);
  assert.match(CSS, /--side-panel-w: clamp\(360px, 36vw, 560px\);/);
  assert.match(CSS, /@media \(max-width: 1023\.98px\) \{[\s\S]{0,300}#platform-side-panel \{\s*display: none;/);
  // Never display:none, never re-parented: nothing in the panel's CSS touches the frame.
  const panelCss = CSS.slice(CSS.indexOf('/* ── #platform-side-panel'));
  assert.doesNotMatch(panelCss, /#app-iframe|#app-frame-host \{[^}]*display/);
  assert.equal(DESKTOP_QUERY_MATCHES(), true);
  function DESKTOP_QUERY_MATCHES() { return api.DESKTOP_QUERY === '(min-width: 1024px)'; }
});

test('the panel\'s document draws no chrome and reserves no room for it', () => {
  const block = CSS.slice(CSS.indexOf('html.in-side-panel :is('));
  for (const id of ['#platform-header', '#platform-tabs', '#platform-rail-peek', '#platform-parked',
    '#chromeless-pill', '#offline-banner', '#mobile-install-banner', '#view-as-non-admin-banner',
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
  const js = SNAPSHOT
    .replace(/export interface [\s\S]*?\n\}\n/g, '')
    .replace(/: Partial<Omit<ShellSnapshot, 'savedAt'>>/g, '')
    .replace(/: ShellSnapshot \| null/g, '')
    .replace(/: ShellSnapshot/g, '')
    .replace(/: boolean/g, '').replace(/: string/g, '').replace(/: void/g, '')
    .replace(/^export /gm, '');
  for (const embedded of [false, true]) {
    const store = {};
    const ctx = {
      Date, JSON,
      window: { localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } } },
      document: { documentElement: { classList: { contains: (c) => embedded && c === 'in-side-panel' } } },
    };
    vm.createContext(ctx);
    vm.runInContext(`${js}\n;globalThis.__api = { saveShellSnapshot };`, ctx);
    ctx.__api.saveShellSnapshot({ title: 'Messages' });
    assert.equal(Object.keys(store).length, embedded ? 0 : 1, embedded ? 'nothing from the panel' : 'the top window writes');
  }
});

test('a completion chimes once: the top window\'s, not the panel\'s copy of the same notification', () => {
  const SRC = read('public/js/dev-alerts.js');
  for (const embedded of [false, true]) {
    const played = [];
    const sandbox = {
      window: {}, console,
      localStorage: { getItem: () => null, setItem() {} },
      document: {
        visibilityState: 'visible',
        documentElement: { classList: { contains: (c) => embedded && c === 'in-side-panel' } },
      },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(SRC, sandbox);
    sandbox.DevAlerts.playDoneTone = () => played.push('tone');
    sandbox.DevAlerts.systemNotify = () => played.push('os');
    sandbox.DevAlerts.onCompletion({ kind: 'session_done' });
    assert.deepEqual(played, embedded ? [] : ['tone'], embedded ? 'silent in the panel' : 'the top window chimes');
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
  // New change is an agent session now (#2779): the agent store's own start
  // asks the panel (sidePanelTakes) before it moves the address, hint and all.
  const IMPROVE = read('frontend/src/features/improve/improve-controller.js');
  const start = IMPROVE.slice(IMPROVE.indexOf('  startSession() {'));
  const body = start.slice(0, start.indexOf('\n  },'));
  assert.match(body, /Improve\._startAgentSession\(\{ slug: improveStore\.get\(\)\.slug, entry: 'improve' \}\);/);
  const AGENT = read('frontend/src/features/agent-session/store.ts');
  const starter = AGENT.slice(AGENT.indexOf('export function startAgentSession('));
  const startBody = starter.slice(0, starter.indexOf('\n}'));
  assert.ok(startBody.indexOf('sidePanelTakes(') > 0
    && startBody.indexOf('sidePanelTakes(') < startBody.indexOf('go(agentSessionAddress('),
    'the agent session asks the panel before it navigates');
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

test('the width\'s rules: 320px of panel and 480px of app at the least, whatever the window', () => {
  const { bounds, clampWidth, MIN_PANEL_W, MIN_APP_W } = api.resize;
  assert.equal(MIN_PANEL_W, 320);
  assert.equal(MIN_APP_W, 480, 'the floor app.css already holds #app-view to beside the panel');
  assert.match(CSS, /html\[data-side-panel\] #app-view \{\s*margin-right: var\(--side-panel-w\);\s*min-width: 480px;/);
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
  const { readStoredWidth, writeStoredWidth, clearStoredWidth, WIDTH_KEY } = api.resize;
  const mem = new Map();
  const store = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  assert.equal(readStoredWidth(store), null, 'nothing chosen: the stylesheet\'s default');
  writeStoredWidth(612.4, store);
  assert.equal(mem.get(WIDTH_KEY), '612');
  assert.equal(readStoredWidth(store), 612);
  clearStoredWidth(store);
  assert.equal(readStoredWidth(store), null, 'a double-click forgets it');
  for (const junk of ['', 'wide', '-4', '0', 'NaN', 'Infinity']) {
    mem.set(WIDTH_KEY, junk);
    assert.equal(readStoredWidth(store), null, `"${junk}" is not a width`);
  }
  const throwing = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  assert.equal(readStoredWidth(throwing), null);
  assert.doesNotThrow(() => writeStoredWidth(500, throwing));
  assert.doesNotThrow(() => clearStoredWidth(throwing));
  assert.equal(readStoredWidth(null), null, 'no storage at all');
});

test('a width is the layout\'s own knob on <html>, and none hands it back to the stylesheet', () => {
  const { applyWidth } = api.resize;
  const props = new Map();
  const root = { style: {
    setProperty: (k, v) => props.set(k, v),
    removeProperty: (k) => props.delete(k),
  } };
  applyWidth(544.2, root);
  assert.equal(props.get('--side-panel-w'), '544px');
  applyWidth(null, root);
  assert.equal(props.has('--side-panel-w'), false);
});

test('the divider drags, takes the keys, resets on a double-click, and lets the frames stand aside while held', () => {
  const SRC = read('frontend/src/features/side-panel/side-panel.tsx');
  const divider = SRC.slice(SRC.indexOf('function SidePanelDivider('));
  assert.match(divider, /setPointerCapture\(e\.pointerId\)/);
  assert.match(divider, /d\.width = set\(d\.startW \+ \(d\.startX - e\.clientX\), false\);/,
    'pinned to the right edge: moving left widens the panel, and nothing is stored mid-drag');
  assert.match(divider, /if \(d\.width != null\) writeStoredWidth\(d\.width\);/,
    'a press that never moved is half of a double-click, not a choice');
  assert.match(divider, /const onDoubleClick = \(\) => \{\s*clearStoredWidth\(\);\s*settle\(\);/);
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.ok(divider.includes(`'${key}'`), key);
  assert.match(divider, /window\.addEventListener\('resize', settle\)/, 'a window that narrows gives the width back');
  const block = CSS.slice(CSS.indexOf('.side-panel-divider {'), CSS.indexOf('.side-panel-head {'));
  assert.match(block, /cursor: col-resize;/);
  assert.match(block, /touch-action: none;/);
  assert.match(block, /html\.side-panel-resizing iframe \{\s*pointer-events: none;/);
});

test('pend plants ?side= for a page the app is about to open beside, and drop takes it back', () => {
  api._resetForTests();
  globalThis.window = {
    location: { search: '', pathname: '/', hash: '', origin: 'https://homeroom.test', href: 'https://homeroom.test/' },
    history: { state: null, replaceState: (_s, _u, url) => {
      const next = new URL(url, 'https://homeroom.test');
      globalThis.window.location.href = next.href;
      globalThis.window.location.search = next.search;
      globalThis.window.location.pathname = next.pathname;
      globalThis.window.location.hash = next.hash;
    } },
    matchMedia: () => ({ matches: true }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.document = { documentElement: { classList: { contains: () => false } } };
  try {
    // A panel page the app the viewer is heading to can stand beside.
    assert.equal(api.SidePanel.pend('agent/7'), true);
    const search = new URL(globalThis.window.location.href, 'https://homeroom.test').search;
    assert.equal(api.sideRouteFrom(search), 'agent/7', 'the route is in ?side=');
    // In place: no history entry (replaceState is the only call a fake
    // history that only carries replaceState can answer).
    assert.equal(api.SidePanel.pend('messages/4242'), true, 'another page overwrites, not appends');
    const again = new URL(globalThis.window.location.href, 'https://homeroom.test').search;
    assert.equal(api.sideRouteFrom(again), 'messages/4242');
    assert.ok(!again.includes('agent%2F7'), 'the earlier page did not survive as a second value');

    // Not a panel page: refused, nothing written.
    api._resetForTests();
    globalThis.window.location.href = 'https://homeroom.test/';
    assert.equal(api.SidePanel.pend('profile/dana'), false);
    assert.equal(api.sideRouteFrom(new URL(globalThis.window.location.href, 'https://homeroom.test').search), null);

    // A navigation that never landed clears the parameter with the caller's
    // clearPending — drop() itself stays untouched for the boot-past-no-app
    // path, which keeps the note until the give-up in restoreFromAddress.
    api._resetForTests();
    globalThis.window.location.href = 'https://homeroom.test/';
    api.SidePanel.pend('agent/7');
    assert.equal(api.sideRouteFrom(new URL(globalThis.window.location.href, 'https://homeroom.test').search), 'agent/7');
    api.SidePanel.clearPending();
    assert.equal(api.sideRouteFrom(new URL(globalThis.window.location.href, 'https://homeroom.test').search), null,
      'the address is clean for the app to open on');
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    api._resetForTests();
  }
});
