// The bell's Unread tab holds still while you read it, and its rows give the
// title the room (polish board #7 and N6, 19 Oct 2026).
//
//   1. #7: the sheet opened on "Unread (1)" from the boot copy, and a few
//      seconds later, with no touch, said "You're all caught up". Every row
//      seen unread while the sheet is open stays listed until it closes (a
//      row read elsewhere is drawn dim); a row the viewer clears still
//      leaves. And the boot read asks for the network's answer.
//   2. N6: the row's chevron is gone, the unread dot sits in the row's left
//      margin, the bookmark lines up with the close disc, and a lone app
//      group does not repeat Mark all read as its own Mark read.
//
// Run with: node --test tests/notifications-held-unread.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SHEET_PATH = 'frontend/src/features/notifications/notifications-sheet.tsx';
const SHEET_SRC = read(SHEET_PATH);

const { agoStamp } = loadTsx('frontend/src/lib/timestamp.ts');
const { createStore } = loadTsx('frontend/src/lib/plain-store.js');

const MIN = 60 * 1000;
const view = (id, overrides = {}) => ({
  id,
  unread: true,
  unreadCls: '',
  time: '4m ago',
  timeTitle: 'Wednesday',
  mb: false,
  metaFlex: false,
  wrap: false,
  icon: '⚠️',
  label: 'Nearing the app limit',
  segments: [{ t: 'strong', v: '40 of 50 apps in use.' }],
  createdAtMs: Date.now() - 4 * MIN,
  who: '',
  appLine: 'Admin',
  ...overrides,
});

function renderSheet({ touch = false, list }) {
  const notificationsStore = createStore({
    saved: [], invites: [], screenList: list, touch, loadingMore: false,
    screenCanLoadMore: false, messagesCanLoadMore: false, loadingOlderMessages: false,
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

// ── 1. #7: held while open ─────────────────────────────────────────────

test('a row read while the sheet is open stays listed; one the viewer clears leaves', () => {
  const { holdUnread, releaseHeld } = loadTsx(SHEET_PATH);
  const sets = { held: new Set(), released: new Set() };
  const listed = (all) => all.filter((v) => v.unread || sets.held.has(v.id)).map((v) => v.id);

  // Opened on the boot copy: two unread.
  let all = [view(1), view(2), view(3, { unread: false })];
  holdUnread(sets, true, all);
  assert.deepEqual(listed(all), [1, 2]);

  // The read on open lands: 1 was read on another device. It stays.
  all = [view(1, { unread: false }), view(2), view(3, { unread: false })];
  holdUnread(sets, true, all);
  assert.deepEqual(listed(all), [1, 2], 'nothing leaves Unread under the eye');

  // A new one arrives while it is open: listed, and held from then on.
  all = [view(4), ...all];
  holdUnread(sets, true, all);
  assert.deepEqual(listed(all), [4, 1, 2]);

  // The viewer clears 2: let go first, then read, and it leaves.
  releaseHeld(sets, [2]);
  holdUnread(sets, true, all);
  all = all.map((v) => (v.id === 2 ? { ...v, unread: false } : v));
  holdUnread(sets, true, all);
  assert.deepEqual(listed(all), [4, 1], 'the swipe, the × and Mark read still take the row away');

  // A clear the server refused puts the row back unread: listed again.
  all = all.map((v) => (v.id === 2 ? { ...v, unread: true } : v));
  holdUnread(sets, true, all);
  assert.deepEqual(listed(all), [4, 1, 2]);

  // Closed: nothing is held, and the next open starts from what is unread.
  holdUnread(sets, false, all);
  assert.equal(sets.held.size, 0);
  assert.equal(sets.released.size, 0);
  holdUnread(sets, true, all);
  assert.deepEqual(listed(all), [4, 2]);
});

test('the sheet lists the held rows, counts the unread ones, and dims what was read', () => {
  const body = SHEET_SRC.slice(SHEET_SRC.indexOf('export function NotificationsSheetView('));
  // #18: plain messages are the Messages tab's, as the bell leaves them out.
  assert.match(body, /const held = useHeldUnread\(open, all\);[\s\S]{0,300}const unread = all\.filter\(\(view\) => held\.listed\(view\) && !view\.plainMessage\);\s*const unreadNow = all\.filter\(\(view\) => view\.unread && !view\.plainMessage\);/);
  // #5289: the tab prints the bell's number, which leaves plain messages out
  // too (_badgeTotal, less messageUnread), so list and count agree.
  assert.match(body, /const unreadCount = snap\.badgeTotal \|\| 0;/, 'the tab says what the bell says');
  assert.match(body, /disabled=\{!unreadNow\.length\}/, 'Mark all read has nothing to do once all of it is read');
  assert.match(body, /held=\{tab === 'unread' && !entry\.view\.unread && !olderShown\}/,
    'dim only on collapsed Unread: on All and in the older rows a read row is an ordinary row');
  assert.match(body, /held\.release\(unread\.map\(\(view\) => view\.id\)\);\s*void controller\(\)\?\.markAllRead\(\);/);
  assert.match(SHEET_SRC, /onRead\?\.\(\);\s*Promise\.resolve\(controller\(\)\?\.markAppRead\(appId\)\)/);
  // #5289: a folded row lets all of its notifications go, and clears them all.
  assert.match(SHEET_SRC, /onRelease\?\.\(groupIds \|\| \[view\.id\]\);\s*void controller\(\)\?\.clearNotification\(view\.id, groupIds \|\| undefined\);/,
    'the × lets the row go before clearing it');
});

test('the boot read asks the service worker for the network\'s answer', async () => {
  const src = read('frontend/src/features/notifications/notifications.js');
  assert.match(src, /if \(window\.App && App\.user\) Notifications\.refresh\(\{ fresh: true \}\);/);
  assert.match(src, /\(\) => Notifications\.refresh\(\{ fresh: true \}\), \{ once: true \}\);/);
  // public/sw.js waits for the network on exactly this cache mode.
  assert.match(read('public/sw.js'), /return cacheMode === 'no-cache' \|\| cacheMode === 'reload';/);

  const calls = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise, setTimeout, clearTimeout, URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    document: {
      title: '', getElementById: () => null, addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }), body: { appendChild: () => {} },
    },
    fetch: async (url, opts) => {
      calls.push([String(url), opts === undefined ? undefined : JSON.parse(JSON.stringify(opts))]);
      return { ok: true, json: async () => ({ notifications: [], unread: 0 }) };
    },
    PlatformUI: { isTouch: () => false },
    App: { user: { id: 1 } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = agoStamp;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(src.replace(/^import \{ agoStamp \}.*$/m, ''), sandbox);
  await sandbox.Notifications.refresh({ fresh: true });
  await sandbox.Notifications.refresh();
  assert.deepEqual(calls, [
    ['/api/notifications?limit=100', { cache: 'no-cache' }],
    ['/api/notifications?limit=100', undefined],
  ], 'only the boot read; the read on open keeps the ordinary deadline');
});

// ── 2. N6: the row ─────────────────────────────────────────────────────

test('the row ends in its bookmark alone, 16px in, and its unread dot sits in the left margin', () => {
  const html = renderSheet({ list: [view(10), view(11, { unread: false })] });
  const row = (id) => html.slice(html.indexOf(`data-notif-id="${id}"`), html.indexOf('</button>', html.indexOf(`data-notif-id="${id}"`)));
  // The dot is the first thing in the row, beside the tile, before the words.
  // #5580: on Unread the row is a card in its project's stack; the dot keeps
  // its place in the card's left margin.
  assert.match(row(10), /^data-notif-id="10" class="notifications-row col-start-1 row-start-1 w-full text-left pl-5 pr-4 [^"]*"><span class="relative flex shrink-0 self-start mt-0\.5"><span class="absolute -left-3 top-1\/2 -translate-y-1\/2 w-2 h-2 rounded-full bg-zinc-900 dark:bg-zinc-100" aria-label="Unread"><\/span>/);
  assert.doesNotMatch(row(11), /aria-label="Unread"/, 'a read row has no dot');
  // No chevron left in a notification row (the Messages footer keeps its own).
  const rowBody = SHEET_SRC.slice(SHEET_SRC.indexOf('function ScreenRow('), SHEET_SRC.indexOf('export function NotificationsSheetView('));
  assert.doesNotMatch(rowBody, /ChevronRightIcon/);
  // The bookmark: on a card (#5580) it takes the time's place at the top
  // right while the pointer is over it; a row of a flat list (All, a search)
  // keeps it 16px from the edge, the close disc's line.
  assert.match(html, /data-notification-save="10" aria-pressed="false" aria-label="[^"]+" class="absolute right-2 top-1\.5 flex h-8 w-8 [^"]*group-hover\/notif:opacity-100 /);
  assert.match(rowBody, /: 'absolute right-4 top-1\/2 -translate-y-1\/2 flex h-9 w-9 items-center justify-center '/);
  assert.match(SHEET_SRC, /id="notifications-sheet-close"[\s\S]{0,40}className=\{'flex h-9 w-9 /,
    'the close disc is the same 36px, in the title row\'s 16px padding');
});

test('one app group says Mark all read once; two groups each keep their Mark read', () => {
  const one = renderSheet({ list: [view(10, { appId: 3, appLine: 'Notes' }), view(11, { appId: 3, appLine: 'Notes' })] });
  assert.match(one, /id="notifications-screen-mark-all"/);
  assert.match(one, /data-notif-app-group="a:3"/);
  assert.doesNotMatch(one, /data-notif-app-read=/, 'the lone group\'s Mark read was Mark all read again');
  const two = renderSheet({ list: [view(10, { appId: 3, appLine: 'Notes' }), view(11, { appId: 4, appLine: 'Polls' })] });
  assert.match(two, /data-notif-app-read="3"/);
  assert.match(two, /data-notif-app-read="4"/);
});
