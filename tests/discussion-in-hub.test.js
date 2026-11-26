'use strict';

// #3653: EVERY DISCUSSION PAGE IS ITS COMMUNITY'S DISCUSSION TAB.
//
// A project's channel was a page of its own twice over — `/app/<slug>/dev/
// chat`, full screen, and `#messages/app/<slug>` on the Messages screen — and
// #general (the Homeroom community's channel) opened on the Messages screen
// too. Each had a header and a back button of its own, a level BELOW the
// community whose room it is, and a notification about a message opened
// there. The room is the project page's Discussion tab now (#3491, #3494), so
// every way into it ends there, under the page's coloured header and tabs,
// at the place it named: a reply thread opened beside the room, or a message
// brought into view. Pinned here:
//
//   1. THE TARGET (AppView, executed): what a door named in the room waits
//      for the tab, once, for one project, for a while.
//   2. THE ROUTER (public/js/app.js, executed in a vm): the old addresses —
//      and their reply-thread and message-link forms — are REPLACED by the
//      project page on its Discussion tab; Homeroom's own archived app chat
//      keeps its addresses, even when a cold link reaches it before anything
//      knows it is the archive; #general's address goes to Homeroom's tab
//      once the Messages store knows it is a channel; a door followed on the
//      project page turns the page in place.
//   3. THE STORE (executed): #general found to be a channel on the Messages
//      screen goes to its tab, and the room in the page takes a door's place.
//   4. THE TAB AND THE ROOM (source): the tab takes the target, a project's
//      own channel opens its reply thread in place, the group chat opens a
//      thread there rather than leaving for Messages.
//
// Run with: node --test tests/discussion-in-hub.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP_JS = read('public/js/app.js');
const GROUP_CHAT = read('public/js/group-chat.js');
const PD_PATH = 'frontend/src/features/dev-board/workshop/project-discussion.tsx';
const PD = read(PD_PATH);
const SCREEN = read('frontend/src/features/messages/index.tsx');
const STORE = read('frontend/src/features/messages/store.ts');
const NOTIFICATIONS = read('frontend/src/features/notifications/notifications.js');
const CSS = read('public/css/app.css');
const ORIGIN = 'https://homeroom.test';

// ── 1. The target ────────────────────────────────────────────────────────

function withAppView(fn) {
  const events = [];
  const stored = new Map();
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  const hadEvent = Object.prototype.hasOwnProperty.call(globalThis, 'CustomEvent');
  const wasEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  globalThis.window = {
    addEventListener() {},
    dispatchEvent: (event) => { events.push([event.type, event.detail]); return true; },
    localStorage: { getItem: (k) => (stored.has(k) ? stored.get(k) : null), setItem: (k, v) => stored.set(k, String(v)) },
  };
  delete require.cache[require.resolve('../public/js/app-view.js')];
  const AppView = require('../public/js/app-view.js');
  try {
    return fn(AppView, events, stored);
  } finally {
    if (had) globalThis.window = was; else delete globalThis.window;
    if (hadEvent) globalThis.CustomEvent = wasEvent; else delete globalThis.CustomEvent;
  }
}

test('a door names its place in the room for the tab, which takes it once, for its project only', () => {
  withAppView((AppView, events, stored) => {
    // #general IS THE DISCUSSION (26 Nov 2026): a message or a thread in
    // #general lands on the Discussion's posts, which open its post.
    AppView._landOnDiscussion('garden-ab12', { threadRootId: '70', focusMessageId: 88 });
    assert.equal(stored.get(`${AppView.WORKSHOP_TAB_KEY}:garden-ab12`), 'posts', 'the page opens on its Discussion');
    assert.deepEqual(events.map((e) => e[0]), ['usernode:workshop-discussion', 'usernode:workshop-tab'],
      'the target is in place before the page is told to turn');
    assert.deepEqual(events[1][1], { slug: 'garden-ab12', tab: 'posts' });
    assert.equal(AppView._peekDiscussionTarget('recipes-cd34'), null, 'another project\'s tab does not take it');
    const t = AppView._takeDiscussionTarget('garden-ab12');
    assert.equal(t.threadRootId, 70);
    assert.equal(t.focusMessageId, 88);
    assert.equal(t.conversationId, null);
    assert.equal(AppView._takeDiscussionTarget('garden-ab12'), null, 'taken once');

    // Ids are the platform's serials or nothing.
    AppView._stashDiscussionTarget('garden-ab12', { threadRootId: 'x', focusMessageId: -3, conversationId: 2 ** 31 });
    const bad = AppView._takeDiscussionTarget('garden-ab12');
    assert.deepEqual([bad.threadRootId, bad.focusMessageId, bad.conversationId], [null, null, null]);

    // A page opened long after the door is not moved by it.
    AppView._stashDiscussionTarget('garden-ab12', { threadRootId: 5 });
    AppView._discussionTarget.at -= AppView.DISCUSSION_TARGET_TTL_MS + 1;
    assert.equal(AppView._takeDiscussionTarget('garden-ab12'), null);

    // The room itself, a topic's place in it, and what the posts hand on
    // (`asChat`) open #general's chat, the same room as one stream.
    for (const [target, tab] of [
      [null, 'discussion'],
      [{ focusMessageId: 9, topicRef: 4 }, 'discussion'],
      [{ threadRootId: 70, asChat: true }, 'discussion'],
      [{ focusMessageId: 9 }, 'posts'],
    ]) {
      events.length = 0;
      AppView._landOnDiscussion('garden-ab12', target);
      assert.deepEqual(events[1][1], { slug: 'garden-ab12', tab }, JSON.stringify(target));
      AppView._takeDiscussionTarget('garden-ab12');
    }
  });
});

// ── 2. The router ────────────────────────────────────────────────────────

const APPS = [
  { slug: 'garden-ab12', name: 'Garden' },
  { slug: 'homeroom-ef56', name: 'Homeroom', self_hosted: true },
];

function fakeElement() {
  const classes = new Set();
  const attrs = new Map();
  return {
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    style: {}, innerHTML: '', textContent: '',
    querySelector: () => null, querySelectorAll: () => [],
    appendChild() {},
    addEventListener() {},
  };
}

function router(start, { platform = null, launchRecords = false, channels = {} } = {}) {
  const location = new URL(start, ORIGIN);
  const entries = [location.href];
  let at = 0;
  const history = {
    state: null,
    get length() { return entries.length; },
    pushState(_s, _t, url) {
      const next = new URL(String(url), location.href);
      entries.splice(at + 1);
      entries.push(next.href);
      at = entries.length - 1;
      location.href = next.href;
    },
    replaceState(_s, _t, url) {
      const next = new URL(String(url), location.href);
      entries[at] = next.href;
      location.href = next.href;
    },
  };
  const calls = [];
  const noop = () => undefined;
  const elements = new Map();
  const context = vm.createContext({
    PlatformI18n: require('./lib/platform-i18n').englishPlatformI18n(),
    location, history, URL, URLSearchParams, console, setTimeout, clearTimeout,
    document: {
      title: '',
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, dispatchEvent() {},
    },
    addEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    PlatformUI: new Proxy({
      transition(fn, o) { fn(); o?.after?.(); },
    }, { get: (t, k) => (k in t ? t[k] : noop) }),
  });
  context.window = context;
  vm.runInContext(APP_JS, context);
  const App = context.App;
  context.PlatformTarget = { slug: () => platform };
  context.UsernodeReact = {
    nav: { setScreen() {}, setViewer() {}, park() {} },
    backButton: { set() {} },
    sidePanel: { appPresence() {} },
    messages: {
      route: (...args) => calls.push(['messages', ...JSON.parse(JSON.stringify(args.slice(0, 2)))]),
      isOpen: () => true, close() {}, syncChrome() {},
      channelHubSlug: (id) => channels[id] || null,
      channelTarget: () => null,
      openChannel() {},
    },
    // #4417: a topic channel's door (features/dev-board/workshop/place-store.ts).
    places: {
      openTopicRef: (slug, ref, target) => calls.push(['topic', slug, ref, JSON.parse(JSON.stringify(target || null))]),
    },
  };
  let target = null;
  const appView = {
    appData: null,
    close() { this.appData = null; },
    launchRecordFor: (slug) => (launchRecords ? APPS.find((r) => r.slug === slug) || null : null),
    open(slug) {
      const rec = APPS.find((r) => r.slug === slug) || null;
      this.appData = rec ? { ...rec } : null;
      return Promise.resolve(!!rec);
    },
    renderDevView: (subTab) => { calls.push(['render', subTab]); return Promise.resolve(); },
    _landOnTab: (slug, tab) => calls.push(['tab', slug, tab]),
    _stashDiscussionTarget: (slug, t) => {
      target = { slug, ...JSON.parse(JSON.stringify(t || {})) };
      calls.push(['target', target]);
    },
    _landOnDiscussion(slug, t) { this._stashDiscussionTarget(slug, t); this._landOnTab(slug, 'discussion'); },
    _peekDiscussionTarget: (slug) => (target && target.slug === slug ? target : null),
    _takeDiscussionTarget: (slug) => { const t = target && target.slug === slug ? target : null; target = null; return t; },
    _onProjectPage: (slug) => location.pathname === `/app/${slug}/workshop` && !location.hash,
    _getViewMode: () => 'workshop',
  };
  context.AppView = new Proxy(appView, { get: (t, k) => (k in t ? t[k] : noop) });
  context.Home = new Proxy({}, { get: () => noop });
  App.bindEvents();
  return {
    App, calls, context,
    route: () => `${location.pathname}${location.search}${location.hash}`,
    entries: () => entries.length,
    settle: async () => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0)); },
    go(address) { history.pushState(null, '', address); App._routeFromHash(); },
  };
}

const of = (calls, kind) => calls.filter((c) => c[0] === kind);

test('a notification\'s reply thread in an app channel opens the project page on Discussion, the thread waiting for it', async () => {
  // Cold: nothing yet knows whether the app is Homeroom's archive.
  const r = router('/#messages/app/garden-ab12/thread/70');
  r.App.restoreFromHash();
  await r.settle();
  assert.equal(r.route(), '/app/garden-ab12/workshop', 'the project page, by its own address');
  assert.equal(r.entries(), 1, 'replaced, not pushed: the old address is no page to come Back to');
  assert.deepEqual(of(r.calls, 'messages'), [], 'never the Messages screen');
  assert.deepEqual(of(r.calls, 'render').map((c) => c[1]), ['forum'], 'the page, never the old full-screen chat');
  assert.deepEqual(of(r.calls, 'tab').at(-1), ['tab', 'garden-ab12', 'discussion']);
  const target = of(r.calls, 'target')[0][1];
  assert.equal(target.slug, 'garden-ab12');
  assert.equal(target.threadRootId, 70);
  assert.equal(r.App.currentSubTab, 'forum');
});

test('known not to be the archive, it goes straight to the page with the message it names', async () => {
  const r = router('/#messages/app/garden-ab12/m/88', { platform: 'homeroom-ef56' });
  r.App.restoreFromHash();
  await r.settle();
  assert.equal(r.route(), '/app/garden-ab12/workshop');
  assert.deepEqual(of(r.calls, 'messages'), []);
  assert.deepEqual(of(r.calls, 'render').map((c) => c[1]), ['forum']);
  const target = of(r.calls, 'target')[0][1];
  assert.equal(target.focusMessageId, 88);
  assert.ok(!target.threadRootId, 'no thread named');
});

for (const address of ['/app/garden-ab12/dev/chat', '/#app/garden-ab12/dev/chat', '/#app/garden-ab12/group-chat']) {
  test(`the old full-screen channel (${address}) is the project page on its Discussion tab`, async () => {
    const r = router(address);
    r.App.restoreFromHash();
    await r.settle();
    assert.equal(r.route(), '/app/garden-ab12/workshop');
    assert.equal(r.entries(), 1);
    assert.deepEqual(of(r.calls, 'render').map((c) => c[1]), ['forum']);
    assert.deepEqual(of(r.calls, 'tab').at(-1), ['tab', 'garden-ab12', 'discussion']);
  });
}

test('every caller that asks for the app\'s chat gets the page on Discussion: switchTab is the one door', async () => {
  const r = router('/app/garden-ab12/workshop');
  r.App.restoreFromHash();
  await r.settle();
  r.calls.length = 0;
  // A shared spec's notification, the board's discussion row.
  await r.App.openAppTab('garden-ab12', 'dev', { subTab: 'chat' });
  assert.equal(r.route(), '/app/garden-ab12/workshop', 'no second address for the page');
  assert.deepEqual(of(r.calls, 'render').map((c) => c[1]), ['forum']);
  assert.deepEqual(of(r.calls, 'tab').at(-1), ['tab', 'garden-ab12', 'discussion']);
});

test('Homeroom\'s own archived app chat keeps its addresses: it is no project\'s tab', async () => {
  const full = router('/app/homeroom-ef56/dev/chat');
  full.App.restoreFromHash();
  await full.settle();
  assert.equal(full.route(), '/app/homeroom-ef56/dev/chat');
  assert.deepEqual(of(full.calls, 'render').map((c) => c[1]), ['chat'], 'the read-only archive, as before');
  assert.deepEqual(of(full.calls, 'tab'), []);

  const inbox = router('/#messages/app/homeroom-ef56', { platform: 'homeroom-ef56' });
  inbox.App.restoreFromHash();
  await inbox.settle();
  assert.equal(inbox.route(), '/#messages/app/homeroom-ef56');
  assert.deepEqual(of(inbox.calls, 'messages'), [['messages', null, 'homeroom-ef56']]);
});

test('a cold link to the archive, before anything knows it is one, comes back to it once the record says so', async () => {
  const r = router('/#messages/app/homeroom-ef56');
  r.App.restoreFromHash();
  await r.settle();
  assert.equal(r.route(), '/#messages/app/homeroom-ef56', 'back on its own address');
  assert.equal(r.entries(), 1, 'with no entry left behind');
  assert.deepEqual(of(r.calls, 'messages').at(-1), ['messages', null, 'homeroom-ef56']);
  assert.deepEqual(of(r.calls, 'render'), [], 'the project page never drew');
});

test('#general\'s address goes to Homeroom\'s Discussion tab once the store knows it is a channel', async () => {
  const r = router('/#messages/88/thread/41', { platform: 'homeroom-ef56', channels: { 88: 'homeroom-ef56' } });
  r.App.restoreFromHash();
  await r.settle();
  assert.equal(r.route(), '/app/homeroom-ef56/workshop');
  assert.equal(r.entries(), 1);
  assert.deepEqual(of(r.calls, 'messages'), []);
  const target = of(r.calls, 'target')[0][1];
  assert.deepEqual([target.slug, target.conversationId, target.threadRootId], ['homeroom-ef56', 88, 41]);
  // Any other conversation is the Messages screen's, as before.
  const dm = router('/#messages/90', { platform: 'homeroom-ef56', channels: { 88: 'homeroom-ef56' } });
  dm.App.restoreFromHash();
  await dm.settle();
  assert.equal(dm.route(), '/#messages/90');
  assert.deepEqual(of(dm.calls, 'messages'), [['messages', 90, null]]);
});

test('a door followed on the project page turns it in place, with no address of its own', async () => {
  const r = router('/app/garden-ab12/workshop', { platform: 'homeroom-ef56', channels: { 88: 'homeroom-ef56' } });
  r.App.restoreFromHash();
  await r.settle();
  r.App._revealedScreen = 'app-view';
  r.App._isScreenVisible = (id) => id === 'app-view';
  r.calls.length = 0;
  assert.equal(r.App._discussionInPlace('#messages/app/garden-ab12/thread/70'), true);
  assert.deepEqual(of(r.calls, 'tab'), [['tab', 'garden-ab12', 'discussion']]);
  assert.equal(of(r.calls, 'target')[0][1].threadRootId, 70);
  assert.equal(r.route(), '/app/garden-ab12/workshop');
  // Another project's room, or #general, is not this page's.
  assert.equal(r.App._discussionInPlace('#messages/app/recipes-cd34'), false);
  assert.equal(r.App._discussionInPlace('#messages/88/m/5'), false);
  assert.equal(r.App._discussionInPlace('#messages/90'), false);
});

// #4417 follow-up: a notification's address for a TOPIC channel's message,
// or for a reply in one of its reply threads, is that channel's door, with
// the place in it the address names, as #general's own address is. On the
// project page already on screen it turns the page in place, with no address
// of its own (App._topicInPlace), as #general's does (App._discussionInPlace).
test('a topic channel\'s address opens that channel, at the message or the reply thread it names', async () => {
  for (const [address, target] of [
    ['/#messages/app/garden-ab12/c/12/m/88', { focusMessageId: 88 }],
    ['/#messages/app/garden-ab12/c/12/thread/70', { threadRootId: 70 }],
    ['/#messages/app/garden-ab12/c/12/thread/70/m/90', { threadRootId: 70, focusMessageId: 90 }],
    ['/#messages/app/garden-ab12/c/12', {}],
  ]) {
    const r = router(address, { platform: 'homeroom-ef56' });
    r.App.restoreFromHash();
    await r.settle();
    assert.deepEqual(of(r.calls, 'topic'), [['topic', 'garden-ab12', 12, target]], address);
    assert.deepEqual(of(r.calls, 'messages'), [], 'never the Messages screen');
    assert.deepEqual(of(r.calls, 'target'), [], 'never #general\'s place');
  }
});

test('a topic channel\'s door followed on its project page turns it in place, with no address of its own', async () => {
  const r = router('/app/garden-ab12/workshop', { platform: 'homeroom-ef56' });
  r.App.restoreFromHash();
  await r.settle();
  r.App._isScreenVisible = (id) => id === 'app-view';
  r.calls.length = 0;
  assert.equal(r.App._discussionInPlace('#messages/app/garden-ab12/c/12/m/88'), true);
  assert.deepEqual(of(r.calls, 'topic'), [['topic', 'garden-ab12', 12, { focusMessageId: 88 }]]);
  assert.equal(r.route(), '/app/garden-ab12/workshop');
  // Another project's topic, or a page not on screen, is the router's.
  assert.equal(r.App._discussionInPlace('#messages/app/recipes-cd34/c/12/m/88'), false);
  r.App._isScreenVisible = () => false;
  assert.equal(r.App._discussionInPlace('#messages/app/garden-ab12/c/12/m/88'), false);
  assert.equal(of(r.calls, 'topic').length, 1);
});

// ── 3. The store ─────────────────────────────────────────────────────────

const GENERAL = 7;

function installStore({ platform = 'homeroom-ef56', hash = `#messages/${GENERAL}/m/41` } = {}) {
  const doors = [];
  global.window = {
    location: { hash, search: '' },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    App: {
      user: { id: 1, username: 'me' },
      setHeaderTitle() {}, setBackIcon() {},
      // The real door replaces the address with the project page's.
      openDiscussionInHub: (slug, target) => {
        doors.push(JSON.parse(JSON.stringify([slug, target])));
        window.location.hash = '';
      },
    },
    PlatformTarget: { slug: () => platform, onSlug: () => () => {} },
    Notifications: { markConversationRead() {}, markConversationThreadRead() {} },
  };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.history = { replaceState() {} };
  global.fetch = async (url) => {
    const address = String(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    const room = { id: GENERAL, kind: 'channel', title: 'general', channelKey: 'general', membershipStatus: 'member', members: [], memberCount: 3, canSend: true };
    if (address === `/api/conversations/${GENERAL}`) return json({ conversation: room });
    if (address.startsWith(`/api/conversations/${GENERAL}/messages`)) {
      return json({ messages: [{ id: 41, conversationId: GENERAL, sender: { id: 2, username: 'ada' }, content: 'hi', createdAt: '2026-10-01T10:00:00Z' }], next_before: null, next_after: null, focus: { messageId: 41, threadRootId: null } });
    }
    if (address.startsWith('/api/conversations')) return json({ conversations: [room] });
    return json({ discussions: [] });
  };
  return doors;
}

function uninstallStore() {
  delete global.window;
  delete global.fetch;
  delete global.localStorage;
  delete global.history;
}

const settleStore = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };

test('#general opened on the Messages screen goes to its tab as soon as the store learns it is a channel', async () => {
  const doors = installStore();
  try {
    const store = loadTsx('frontend/src/features/messages/store.ts');
    assert.equal(store.channelHubSlug(GENERAL), null, 'nothing known yet');
    store.route(GENERAL, null, { focusMessageId: 41 });
    await settleStore();
    assert.deepEqual(doors, [['homeroom-ef56', { conversationId: GENERAL, threadRootId: null, focusMessageId: 41 }]],
      'the message the address named goes with it');
    assert.equal(store.channelHubSlug(GENERAL), 'homeroom-ef56');
    assert.equal(store.channelTarget('general'), `#messages/${GENERAL}`, 'a `#general` reference is followed at once');
  } finally {
    uninstallStore();
  }
});

test('...but not before the platform\'s slug is known, nor for a viewer its page is not served to', async () => {
  for (const platform of [null, 'homeroom-ef56']) {
    const doors = installStore({ platform });
    try {
      if (platform) window.PlatformTarget.known = () => ({ restricted: true });
      const store = loadTsx('frontend/src/features/messages/store.ts');
      store.route(GENERAL, null, {});
      await settleStore();
      assert.deepEqual(doors, [], platform ? 'restricted: the room stays here' : 'no slug: the room stays here');
      assert.equal(store.channelHubSlug(GENERAL), null);
    } finally {
      uninstallStore();
    }
  }
});

test('the room in the page takes a door\'s place: a reply thread, or a message', async () => {
  installStore({ hash: '' });
  try {
    window.location.pathname = '/app/homeroom-ef56/workshop';
    const store = loadTsx('frontend/src/features/messages/store.ts');
    store.embed(GENERAL, { threadRootId: 41, focusMessageId: null });
    await settleStore();
    const route = () => {
      let r = null;
      const Probe = () => { r = store.useMessagesSnapshot().route; return null; };
      renderToHtml(createElement(Probe));
      return r;
    };
    let snap = route();
    assert.equal(snap.embedded, true);
    assert.equal(snap.open, false, 'Messages is not open');
    assert.equal(snap.threadRootId, 41, 'the thread is open beside the room');
    // A second door while the room is up moves it in place.
    store.embed(GENERAL, { threadRootId: null, focusMessageId: 41 });
    await settleStore();
    snap = route();
    assert.equal(snap.embedded, true);
    assert.equal(snap.focusMessageId, 41);
    assert.equal(window.location.hash, '', 'the page keeps its address');
  } finally {
    uninstallStore();
  }
});

// ── 4. The tab and the room ──────────────────────────────────────────────

test('the tab takes the target and opens a project\'s own reply thread in place', () => {
  const { takeDiscussionTarget } = loadTsx(PD_PATH, { stubs: { '../../messages': { EmbeddedConversation: () => null, AppReplyThreadPane: () => null } } });
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  globalThis.window = { AppView: { _takeDiscussionTarget: (slug) => (slug === 'garden-ab12' ? { threadRootId: 70, focusMessageId: 0 } : null) } };
  try {
    assert.deepEqual(takeDiscussionTarget('garden-ab12'), { threadRootId: 70, focusMessageId: null, conversationId: null });
    assert.equal(takeDiscussionTarget('recipes-cd34'), null);
  } finally {
    if (had) globalThis.window = was; else delete globalThis.window;
  }
  // Taken once the page knows which room it is, and again for a door
  // followed while the tab is up.
  assert.match(PD, /window\.addEventListener\('usernode:workshop-discussion', onTarget\);/);
  assert.match(PD, /GroupChat\?\.revealMessage\?\.\(slug, target\.focusMessageId\)/);
  assert.match(PD, /setThread\(\(cur\) => \(\{ rootId, key: \(cur\?\.key \|\| 0\) \+ 1 \}\)\)/);
  assert.match(PD, /<EmbeddedConversation conversationId=\{room\} active=\{onShow\} at=\{roomAt\} \/>/);
  // The pane is Messages' own, closed in place rather than by an address.
  assert.match(PD, /<AppReplyThreadPane[\s\S]*?onClick=\{\(\) => setThread\(null\)\}/);
  assert.match(SCREEN, /export function AppReplyThreadPane\(/);
  assert.match(SCREEN, /function AppReplyThreadPanel[\s\S]*?<AppReplyThreadPane/, 'Messages draws the same pane');
  // The host's class string never changes; only the section says a thread is up.
  assert.match(PD, /<div ref=\{host\} className="dev-ws-discussion-host" \/>/);
  assert.match(PD, /className=\{`dev-ws-discussion dev-ws-general-channel\$\{thread \? ' dev-ws-discussion-threaded' : ''\}`\}/);
  assert.match(CSS, /\.dev-ws-discussion-threaded > \.messages-reply-pane \{ margin: 0; \}/);
  assert.match(CSS, /\.messages-layout,\s*\.dev-ws-discussion,[\s\S]*?\.side-panel-head,\s*#ai-screen \.ai-askbar \{/, 'the pane\'s surface tokens reach the tab (the AI tab\'s Ask bar, and the column\'s heading, #6431)');
});

test('the group chat opens a reply thread in the page it is on, not in Messages', () => {
  const open = GROUP_CHAT.slice(GROUP_CHAT.indexOf('  openReplyThread(id) {'), GROUP_CHAT.indexOf('  isReplyThreadOpen(id) {'));
  assert.match(open, /if \(GroupChat\._openThreadInPage\(slug, id\)\) return;\s*location\.hash = `#messages\/app\//);
  assert.match(open, /closest\('\[data-ws-discussion\]'\)/);
  // #4417 follow-up: named for the topic whose channel the pane shows (none: #general).
  assert.match(open, /AppView\._stashDiscussionTarget\(slug, \{ threadRootId: Number\(rootId\), topicRef: GroupChat\._channelRef\(\) \}\)/);
  // A message link to a reply opens its thread there too.
  const reveal = GROUP_CHAT.slice(GROUP_CHAT.indexOf('  _applyPendingReveal(attempt = 0) {'), GROUP_CHAT.indexOf('  restoreScroll() {'));
  assert.equal((reveal.match(/_openThreadInPage\(/g) || []).length, 2);
  // And the tab names its room the way Messages' pane does, so a reveal lands at once.
  assert.match(PD, /data-discussion-app=\{slug\}/);
});

test('the bell still uses the room\'s address, which the page takes; the store turns a page already open', () => {
  assert.match(NOTIFICATIONS, /messages\.openDiscussion\(slug\)/);
  // 1 Nov 2026: after the chat with Homeroom bot, which is its tab's by either address.
  assert.match(STORE, /export function openAddress\(href: string\): void \{\s*if \([^\n]*\) return;[\s\S]{0,420}if \(botTab\) \{ goBotAddress\(botTab\); return; \}\s*if \(turnsPageInPlace\(href\)\) return;\s*if \(sidePanelTakes\(href\)\) return;/);
  assert.match(STORE, /const target = `#messages\/app\/\$\{encodeURIComponent\(safe\)\}`;\s*if \(turnsPageInPlace\(target\)\) return;/);
});
