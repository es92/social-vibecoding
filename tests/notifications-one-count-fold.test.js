'use strict';

// #5289, the bell reviewed as navigation: one count, a project's repeats
// folded into one row, two-line subjects and a sheet that fills the phone.
//
//   - ONE COUNT. The bell said 99+, the sheet's Unread tab said (81) and the
//     browser tab's title said (300). All three now print
//     Notifications._badgeTotal() (the account-wide unread, messages
//     included, plus pending invites) through one cap, _badgeText.
//   - FOLDED REPEATS. On Unread, inside one project's group, notifications of
//     one kind that printed one label are one row ("3 changes you voted on
//     are live"); opening it opens the newest and reads them all, clearing it
//     clears them all.
//
// The controller runs from its shipped source in a vm, the sheet renders
// through tests/lib/render-tsx.js, the way tests/notifications-swipe-clear
// does both.
//
// Run with: node --test tests/notifications-one-count-fold.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const SHEET_PATH = 'frontend/src/features/notifications/notifications-sheet.tsx';
const SHEET_SRC = read(SHEET_PATH);
const APP_CSS = read('public/css/app.css');
const { agoStamp } = loadTsx('frontend/src/lib/timestamp.ts');
const { createStore } = loadTsx('frontend/src/lib/plain-store.js');
const CONTROLLER_SRC = read('frontend/src/features/notifications/notifications.js')
  .replace(/^import \{ agoStamp \}.*$/m, '');

const MIN = 60 * 1000;
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * MIN).toISOString();

function load() {
  const calls = [];
  const badge = { textContent: '', classList: { add() {}, remove() {} }, setAttribute() {} };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    document: {
      title: 'Homeroom',
      getElementById: (id) => (id === 'notifications-badge' ? badge : null),
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
    },
    fetch: async (url, opts) => {
      calls.push(['fetch', String(url), JSON.parse(opts.body)]);
      return { ok: true, json: async () => ({ unread: 0, cleared: 1 }) };
    },
    PlatformUI: { isTouch: () => false, toast: (text) => calls.push(['toast', text]) },
    GroupChat: { reconcileDotsFromNotifications: () => {} },
    App: { user: { id: 1 } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = agoStamp;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(CONTROLLER_SRC, sandbox);
  const N = sandbox.Notifications;
  N._store = createStore({ screenList: null, sessionUnreadIds: [], badgeTotal: 0 });
  return { N, calls, badge, sandbox };
}

// ── one count ───────────────────────────────────────────────────────────

test('the bell, the browser tab and the sheet print one number through one cap', () => {
  const { N, badge, sandbox } = load();
  N.items = [];
  N.invites = [{ appId: 1 }];
  N.unread = 299;
  N._renderBadge();
  assert.equal(badge.textContent, '99+');
  assert.equal(sandbox.document.title, '(99+) Homeroom', 'the title says what the bell says');
  assert.equal(N._store.get().badgeTotal, 300, 'the sheet gets the bell\'s own number');

  N.unread = 3;
  N._renderBadge();
  assert.equal(badge.textContent, '4', 'invites count, as they always did on the bell');
  assert.equal(sandbox.document.title, '(4) Homeroom', 'a capped prefix is replaced, not stacked');
  assert.equal(N._store.get().badgeTotal, 4);

  N.unread = 0;
  N.invites = [];
  N._renderBadge();
  assert.equal(sandbox.document.title, 'Homeroom');
});

test('the Unread tab reads the bell\'s number, not the rows it has paged in', () => {
  assert.match(SHEET_SRC, /const unreadCount = snap\.badgeTotal \|\| 0;/);
  assert.doesNotMatch(SHEET_SRC, /unread\.reduce\(/);
  assert.equal(message('notifications:sheet.tab.unreadCountCapped'), 'Unread (99+)');
  const html = renderSheet({ list: [], badgeTotal: 300 });
  assert.match(html, /id="notifications-tab-unread"[^>]*>Unread \(99\+\)</);
  assert.match(renderSheet({ list: [], badgeTotal: 7 }), /id="notifications-tab-unread"[^>]*>Unread \(7\)</);
});

// ── a project's repeats fold ────────────────────────────────────────────

const view = (id, overrides = {}) => ({
  id,
  kind: 'voted_change_merged',
  unread: true,
  unreadCls: '',
  time: '4m ago',
  timeTitle: 'Wednesday',
  mb: false,
  metaFlex: false,
  wrap: false,
  icon: '🚀',
  label: message('notifications:row.votedMerged.label'),
  segments: [{ t: 'strong', v: `Change ${id}` }],
  createdAtMs: Date.now() - id * MIN,
  who: '',
  appLine: 'Notes',
  appId: 5,
  ...overrides,
});

function renderSheet({ list, badgeTotal = 0, touch = false }) {
  const notificationsStore = createStore({
    saved: [], invites: [], screenList: list, touch, loadingMore: false,
    screenCanLoadMore: false, badgeTotal,
  });
  const notificationsSheetStore = createStore({ open: true, adopted: false });
  const mod = loadTsx(SHEET_PATH, {
    stubs: {
      './notifications-store.js': { notificationsStore },
      './notifications-sheet-store.js': { notificationsSheetStore },
    },
  });
  return renderToHtml(createElement(mod.NotificationsSheetView));
}

test('three of one kind in one project are one row that says how many', () => {
  const html = renderSheet({
    list: [
      view(1),
      view(2, { kind: 'pr_proposed', label: message('notifications:row.proposed.label') }),
      view(3),
      view(4),
      view(5, { appId: 6, appLine: 'Tasks' }),
    ],
  });
  assert.equal(message('notifications:row.group.votedMerged', { count: 3 }), '3 changes you voted on are live');
  // Drawn as its newest member, where that one stood, with the group's size.
  assert.match(html, /<button data-notif-id="1" data-notif-group-size="3"/);
  assert.doesNotMatch(html, /data-notif-id="3"|data-notif-id="4"/, 'the older two are inside it');
  assert.ok(html.includes('3 changes you voted on are live'));
  assert.ok(html.includes('Change 1'), 'the subject is the newest one\'s');
  // The label says the number, so the count pill does not say it again.
  assert.doesNotMatch(html, /aria-label="3 notifications"/);
  // Clearing it names them all; a save is one notification's, so no bookmark.
  assert.match(html, /data-notification-clear="1" aria-label="Clear 3 notifications"/);
  assert.doesNotMatch(html, /data-notification-save="1"/);
  // Another kind in the same project, and the same kind in another project,
  // stay rows of their own.
  assert.match(html, /<button data-notif-id="2" class=/);
  assert.match(html, /data-notif-app-group="a:6"[\s\S]*<button data-notif-id="5" class=/);
});

test('a kind without words of its own keeps its label and shows the count', () => {
  const html = renderSheet({
    list: [view(1, { kind: 'app_health', label: 'App problem' }), view(2, { kind: 'app_health', label: 'App problem' })],
  });
  assert.match(html, /<button data-notif-id="1" data-notif-group-size="2"/);
  assert.match(html, /aria-label="2 notifications"/);
});

test('people, rows with buttons and rows with no project never fold', () => {
  const chat = (id) => view(id, { kind: 'conversation_message', conversation: true, label: 'Ada' });
  const ask = (id) => view(id, {
    kind: 'pr_recheck', label: 'Still good?', actions: [{ key: 'still_yes', label: 'Still yes', primary: true }],
  });
  const html = renderSheet({
    list: [chat(1), chat(2), ask(3), ask(4), view(5, { appId: null }), view(6, { appId: null })],
  });
  assert.doesNotMatch(html, /data-notif-group-size/);
  for (const id of [1, 2, 3, 4, 5, 6]) assert.match(html, new RegExp(`data-notif-id="${id}"`));
});

test('All stays the archive: nothing folds there', () => {
  assert.match(SHEET_SRC, /const groupedUnread = tab === 'unread' && !olderShown;/);
  // #5580: a project's stories fold first (one request's news is one card),
  // #6441: the requests that went live close together are one row next, so
  // the fold by kind cannot split them; then what is left folds by kind.
  assert.match(SHEET_SRC, /if \(group\.appId != null\) group\.entries = foldRepeats\(foldLive\(foldStories\(group\.entries\), t\), t\);/);
});

test('opening a folded row opens the newest and reads them all', async () => {
  const { N, calls } = load();
  N.items = [
    { id: 30, kind: 'voted_change_merged', appId: 5, createdAt: at(1), readAt: null },
    { id: 20, kind: 'voted_change_merged', appId: 5, createdAt: at(2), readAt: null },
    { id: 10, kind: 'voted_change_merged', appId: 5, createdAt: at(3), readAt: null },
  ];
  N.unread = 3;
  const opened = [];
  N._onItemClick = (id) => { opened.push(id); };
  N.openGroupRow(30, [30, 20, 10]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, [30], 'the row opens the one it is drawn as');
  // 21 Oct 2026: the opened one and the rest in one request, so no second
  // request can race it for the count.
  const posts = calls.filter((c) => c[0] === 'fetch').map((c) => c[2]);
  assert.deepEqual(posts, [{ ids: [30, 20, 10] }], 'all of them read in one request');
  assert.ok(N.items.every((n) => n.readAt));
});

test('clearing a folded row clears every member', async () => {
  const { N, calls } = load();
  N.items = [
    { id: 30, kind: 'voted_change_merged', appId: 5, createdAt: at(1), readAt: null },
    { id: 25, kind: 'pr_proposed', appId: 5, createdAt: at(2), readAt: null },
    { id: 20, kind: 'voted_change_merged', appId: 5, createdAt: at(3), readAt: null },
  ];
  N.unread = 3;
  assert.equal(await N.clearNotification(30, [30, 20]), true);
  const posts = calls.filter((c) => c[0] === 'fetch').map((c) => c[2]);
  assert.deepEqual(posts, [{ ids: [30, 20] }], 'each member once, in one request, and nothing else');
  assert.equal(N.items.find((n) => n.id === 25).readAt, null);
});

// ── two lines, and the whole phone ──────────────────────────────────────

test('a subject runs to two lines before it is cut', () => {
  // #6506: the unread subject is the strong one; a read subject is the same
  // shape in regular weight and the softer ink.
  assert.match(SHEET_SRC, /'block text-sm font-semibold text-zinc-900 dark:text-zinc-100 line-clamp-2 break-words'/);
  assert.match(SHEET_SRC, /'block text-sm font-normal text-zinc-700 dark:text-zinc-300 line-clamp-2 break-words'/);
});

test('on a phone the sheet is the screen\'s height, not two thirds', () => {
  assert.doesNotMatch(APP_CSS, /66dvh/);
  // #6813: the top gap now has a floor (the Duo cover has no status bar at
  // the top), and the keyboard's height comes out of the sheet's own.
  assert.match(APP_CSS, /\.platform-sheet-adopted#notifications-sheet \{\s*height: calc\(100dvh - max\(env\(safe-area-inset-top, 0px\), 12px\)/);
  const bell = APP_CSS.slice(APP_CSS.indexOf('.platform-sheet-adopted#notifications-sheet {'));
  assert.match(bell.slice(0, bell.indexOf('!important')),
    /var\(--un-kb-inset, 0px\)/,
    'a sheet the kit stands on the keyboard must leave the keyboard out of its height');
  assert.match(APP_CSS, /height: calc\(100dvh - env\(safe-area-inset-top, 0px\) - 0\.75rem\);/);
});

// ── #6441: "went live" is one row ───────────────────────────────────────

const liveRow = (id, minutesAgo, overrides = {}) => ({
  ...view(id, overrides),
  kind: 'build_live',
  label: message('notifications:row.bot.label.live'),
  segments: [{ t: 'strong', v: `Request ${id}` }],
  storyKey: `issue:${id}`,
  storyRef: { number: 100 + id, title: `Request ${id}` },
  createdAtMs: Date.now() - minutesAgo * MIN,
  ...overrides,
});

test('three requests that went live within an hour are one row with three items', () => {
  const html = renderSheet({ list: [liveRow(1, 2), liveRow(2, 4), liveRow(3, 6)] });
  // One row where the newest stood, standing for all three.
  assert.match(html, /data-notif-id="1"/);
  assert.doesNotMatch(html, /data-notif-id="2"|data-notif-id="3"/, 'the other two are inside it');
  // Its subject says how many, and each request is a line of its own.
  assert.ok(html.includes('3 of your requests went live'));
  assert.match(html, /data-notif-live-item="1"[^>]*>#101 · Request 1</);
  assert.match(html, /data-notif-live-item="2"[^>]*>#102 · Request 2</);
  assert.match(html, /data-notif-live-item="3"[^>]*>#103 · Request 3</);
  // Still the app's own word for it on the kind line.
  assert.ok(html.includes('Live'));
  // The label carries the number, so no count pill says it twice.
  assert.doesNotMatch(html, /aria-label="3 notifications"/);
});

test('a "went live" two hours older stays a row of its own', () => {
  const html = renderSheet({ list: [liveRow(1, 2), liveRow(2, 4), liveRow(4, 150)] });
  // The two close together are one row...
  assert.equal((html.match(/2 of your requests went live/g) || []).length, 1);
  // ...and the older one is not in it.
  assert.match(html, /data-notif-id="4"/);
  assert.doesNotMatch(html, /data-notif-live-item="4"/);
});

test('another project\'s "went live" is not folded in', () => {
  const html = renderSheet({
    list: [liveRow(1, 2), liveRow(2, 4), liveRow(5, 3, { appId: 6, appLine: 'Tasks' })],
  });
  assert.equal((html.match(/2 of your requests went live/g) || []).length, 1, 'two in Notes fold');
  // ...and the other project's live row is a row of its own in its own group.
  assert.match(html, /data-notif-app-group="a:6"[\s\S]*data-notif-id="5"/);
});

test('a "went live" inside a request\'s own story card is not folded out of it', () => {
  // One request's news (a mention, then its going live) is that request's
  // card (#5580): folding the live line again would hide the story.
  const mention = (id, minutesAgo) => view(id, {
    kind: 'issue_mention', label: 'Mentioned you', storyKey: 'issue:9',
    storyRef: { number: 109, title: 'Request 9' }, createdAtMs: Date.now() - minutesAgo * MIN,
  });
  const html = renderSheet({
    list: [
      mention(1, 1), mention(2, 2),
      liveRow(3, 3, { storyKey: 'issue:9', storyRef: { number: 109, title: 'Request 9' } }),
    ],
  });
  assert.equal((html.match(/of your requests went live/g) || []).length, 0, 'no live fold here');
  assert.doesNotMatch(html, /data-notif-live-item/);
});
