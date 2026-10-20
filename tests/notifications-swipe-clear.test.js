'use strict';

// Clearing a notification without opening it (#3538): a swipe on a phone, the
// × on a hovered row at a desk.
//
// The request asked for the iOS lock screen's swipe-to-clear in the bell's
// sheet, and for whatever macOS does at a desk. Decided with the requester:
//
//   1. "Clear" is the meaning `readAt` already has. One notification is
//      marked read through the existing `POST /api/notifications/read`
//      `{ id }`, so the row leaves Unread and stays in All without its dot.
//      No new server state, nothing deleted.
//   2. At a desk, a small round × on the row's corner while the pointer is
//      over it, as macOS Notification Center draws it. It is a real button
//      beside the row, reachable from the keyboard, and never the row's own
//      click.
//   3. Only unread rows offer it, on every tab they render on.
//
// Three layers are pinned here. The controller's clear is RUN, in a vm over
// the shipped notifications.js, because what it promises is behaviour: the
// optimistic step, the one-id request per notification the row stands for,
// and the put-back when the server refuses. The sheet's markup is RENDERED
// through tests/lib/render-tsx.js, because where the × sits relative to the
// row is structure a regex over JSX cannot see. The swipe's wiring runs in an
// effect, which a static render never runs, so that part is read off the
// source (and was checked in a touch-emulated browser, where the kit's tray
// lives).
//
// Run with: node --test tests/notifications-swipe-clear.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const SHEET_PATH = 'frontend/src/features/notifications/notifications-sheet.tsx';
const SHEET_SRC = read(SHEET_PATH);
const APP_CSS = read('public/css/app.css');
const dapp = JSON.parse(read('dapp.json'));

// notifications.js has one bundle import (`agoStamp`, lib/timestamp.ts). The
// vm evaluates the shipped source raw, so the import line is dropped and the
// real helper is put in the sandbox under its name, the way
// tests/notifications-sheet-dismiss-on-nav.test.js does it.
const { agoStamp } = loadTsx('frontend/src/lib/timestamp.ts');
const { createStore } = loadTsx('frontend/src/lib/plain-store.js');
const CONTROLLER_SRC = read('frontend/src/features/notifications/notifications.js')
  .replace(/^import \{ agoStamp \}.*$/m, '');

const MIN = 60 * 1000;
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * MIN).toISOString();

function load({ respond } = {}) {
  const calls = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    document: {
      title: '',
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
    },
    fetch: async (url, opts) => {
      calls.push(['fetch', String(url), JSON.parse(opts.body)]);
      return respond ? respond(JSON.parse(opts.body), calls) : {
        ok: true, json: async () => ({ unread: 0, cleared: 1 }),
      };
    },
    PlatformUI: { isTouch: () => true, toast: (message) => calls.push(['toast', message]) },
    GroupChat: { reconcileDotsFromNotifications: () => calls.push(['dots']) },
    App: { user: { id: 1 } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = agoStamp;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(CONTROLLER_SRC, sandbox);
  const N = sandbox.Notifications;
  N._store = createStore({ screenList: null, sessionUnreadIds: [] });
  // What the sheet would draw: each row's id, starred while unread, with its
  // count when it is a collapse. Array.from brings the vm realm's array into
  // this one, so deepEqual compares values rather than prototypes.
  const rows = () => Array.from(N._store.get().screenList || [],
    (view) => `${view.id}${view.count ? `x${view.count}` : ''}${view.unread ? '*' : ''}`);
  return { N, calls, rows };
}

const feed = () => [
  // A conversation run: two unread messages, drawn as ONE row (id 12, x2).
  { id: 12, kind: 'conversation_message', conversationId: 7, sourceUsername: 'ada', createdAt: at(2), readAt: null },
  { id: 11, kind: 'conversation_message', conversationId: 7, sourceUsername: 'ada', createdAt: at(3), readAt: null },
  { id: 10, kind: 'platform_limit', detail: 'apps_warn:40:50', createdAt: at(8), readAt: null },
  { id: 9, kind: 'app_quota_changed', detail: '2:4', createdAt: at(30), readAt: at(20) },
];

// ── the controller ──────────────────────────────────────────────────────

test('clearing a row marks it read through the one-id endpoint, at once', async () => {
  const { N, calls, rows } = load({
    respond: async () => ({ ok: true, json: async () => ({ unread: 2, cleared: 1 }) }),
  });
  N.items = feed();
  N.unread = 3;
  N._renderList();
  assert.deepEqual(rows(), ['12x2*', '10*', '9']);

  const pending = N.clearNotification(10);
  // Before the server answers: the row is read, the count is down and the
  // sheet has been drawn from that. A swipe has already taken the row off the
  // screen, so nothing may wait for the round trip.
  assert.deepEqual(rows(), ['12x2*', '10', '9'], 'the row stops being unread in the same tick');
  assert.equal(N.unread, 2);
  assert.ok(calls.some((c) => c[0] === 'dots'), 'an open chat reconciles its dots');

  assert.equal(await pending, true);
  const posts = calls.filter((c) => c[0] === 'fetch');
  assert.deepEqual(posts, [['fetch', '/api/notifications/read', { id: 10 }]],
    'exactly the existing single-id request, nothing new on the server');
  assert.equal(N.unread, 2, 'and the server\'s own count is adopted');
  assert.ok(!calls.some((c) => c[0] === 'toast'), 'a clear that worked says nothing');
});

test('a collapsed conversation row clears every notification it stands for', async () => {
  const { N, calls, rows } = load({
    respond: async () => ({ ok: true, json: async () => ({ unread: 1, cleared: 1 }) }),
  });
  N.items = feed();
  N.unread = 3;
  N._renderList();

  await N.clearNotification(12);
  // Clearing only the newest would split the run and leave an unread row
  // for the older message exactly where the cleared one was.
  assert.deepEqual(rows(), ['12x2', '10*', '9'], 'the run is read as a whole, and still one row');
  const ids = calls.filter((c) => c[0] === 'fetch').map((c) => c[2].id).sort();
  assert.deepEqual(ids, [11, 12], 'one single-id request per member');
  assert.equal(N.unread, 1);
});

test('a refused clear is put back, the count goes back up, and a toast says so', async () => {
  const { N, calls, rows } = load({
    respond: async () => ({ ok: false, status: 500, json: async () => ({ error: 'x' }) }),
  });
  N.items = feed();
  N.unread = 3;
  N._renderList();

  const ok = await N.clearNotification(12);
  assert.equal(ok, false);
  assert.deepEqual(rows(), ['12x2*', '10*', '9'], 'both members are unread again, one row');
  assert.equal(N.unread, 3, 'the optimistic decrement is undone');
  assert.deepEqual(calls.filter((c) => c[0] === 'toast'),
    [['toast', 'Couldn’t clear this notification. Try again.']]);
});

test('a network failure is a refusal too', async () => {
  const { N, rows } = load({ respond: async () => { throw new Error('offline'); } });
  N.items = feed();
  N.unread = 3;
  N._renderList();
  assert.equal(await N.clearNotification(10), false);
  assert.deepEqual(rows(), ['12x2*', '10*', '9']);
  assert.equal(N.unread, 3);
});

test('a refresh that lands mid-clear is the truth, and nothing is put back over it', async () => {
  let release = null;
  const { N, rows } = load({
    respond: () => new Promise((resolve) => { release = resolve; }),
  });
  N.items = feed();
  N.unread = 3;
  N._renderList();
  const pending = N.clearNotification(10);
  // The server's own rows arrive while the request is out (another tab
  // cleared it, say): `items` is replaced wholesale.
  N.items = feed().map((n) => (n.id === 10 ? { ...n, readAt: at(0) } : n));
  N.unread = 2;
  release({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await pending, false);
  assert.deepEqual(rows(), ['12x2*', '10', '9'], 'the refreshed row is not flipped back');
  assert.equal(N.unread, 2, 'and the refreshed count stands');
});

test('a row with nothing left to clear asks nothing, and is redrawn from the truth', async () => {
  const { N, calls, rows } = load();
  N.items = feed();
  N.unread = 3;
  N._store.set({ screenList: [] });
  assert.equal(await N.clearNotification(9), true, 'a read row is already clear');
  assert.equal(await N.clearNotification(404), true, 'an unknown one has nothing to clear');
  assert.ok(!calls.some((c) => c[0] === 'fetch'));
  // A full swipe has taken the row out of the document before the handler
  // runs; only a fresh render puts the list back the way the store says.
  assert.deepEqual(rows(), ['12x2*', '10*', '9']);
});

test('the row click keeps its path, and the path now says whether it worked', () => {
  const body = CONTROLLER_SRC.slice(CONTROLLER_SRC.indexOf('  async _markOneRead(id) {'),
    CONTROLLER_SRC.indexOf('  async clearNotification(id, groupIds) {'));
  assert.match(body, /body: JSON\.stringify\(\{ id \}\)/);
  assert.match(body, /if \(!res\.ok\) return false;/);
  assert.match(body, /return true;\n/);
  const clear = CONTROLLER_SRC.slice(CONTROLLER_SRC.indexOf('  async clearNotification(id, groupIds) {'),
    CONTROLLER_SRC.indexOf('  _rowMembers(id) {'));
  assert.ok(clear.length > 0, 'clearNotification found');
  // #5289: a folded row hands its other members' ids over, and each one's
  // own row members are cleared with it, once each.
  assert.match(clear, /const ids = \[id, \.\.\.\(Array\.isArray\(groupIds\) \? groupIds : \[\]\)\];/);
  assert.match(clear, /ids\.flatMap\(\(rowId\) => Notifications\._rowMembers\(rowId\)\)/);
  assert.match(clear, /members\.map\(\(n\) => Notifications\._markOneRead\(n\.id\)\)/,
    'the clear reuses the click\'s request and reconcile instead of a second copy');
  assert.match(CONTROLLER_SRC, /_rowMembers\(id\) \{[\s\S]{0,300}collapseConversationRuns\(items\.slice\(at\)\)/,
    'and finds what a row stands for with the rule the sheet drew it with');
});

// ── the sheet ───────────────────────────────────────────────────────────

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

function renderSheet({ touch, list }) {
  const notificationsStore = createStore({
    saved: [], invites: [], screenList: list, touch, loadingMore: false,
    screenCanLoadMore: false,
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

test('at a desk an unread row carries its ×, beside the row and never inside it', () => {
  const html = renderSheet({
    touch: false,
    list: [
      view(10),
      view(20, { actions: [{ key: 'still_yes', label: 'Still yes', primary: true }] }),
    ],
  });
  // #5580: on Unread a row is a card in its project's stack, and the slot
  // is the card (its classes say so), so the slot is found by what opens it.
  const slot = (id) => {
    const m = new RegExp(`<div class="notifications-row-slot group/notif relative[^"]*"[^>]*><button data-notif-id="${id}"`).exec(html);
    return m ? html.slice(m.index, html.indexOf('</svg></button>', html.indexOf('data-notification-clear', m.index))) : null;
  };
  const plain = slot(10);
  assert.ok(plain, 'the plain row sits first in a slot of its own');
  // The row is a <button>, so a second button inside it would be invalid
  // markup and would take the row's click. The × follows the row's close,
  // and on a card it sits on the card's corner.
  assert.match(plain,
    /<\/button><button type="button" data-notification-clear="10" aria-label="Clear notification" class="absolute -left-1\.5 -top-1\.5 z-\[2\] /);
  assert.equal((plain.match(/data-notification-clear/g) || []).length, 1);
  // Hidden and untouchable until the slot is hovered or holds keyboard focus.
  assert.match(plain, /pointer-events-none opacity-0 transition-opacity /);
  assert.match(plain, /group-hover\/notif:pointer-events-auto group-hover\/notif:opacity-100 /);
  assert.match(plain, /group-has-\[:focus-visible\]\/notif:pointer-events-auto group-has-\[:focus-visible\]\/notif:opacity-100 /);

  // The row with its own action ("Still yes") is a <div>; its × is the same.
  assert.match(html,
    /<div class="notifications-row-slot group\/notif relative[^"]*"[^>]*><div data-notif-id="20"[\s\S]*?Still yes<\/button>(?:<\/div>)+<button type="button" data-notification-clear="20"/);
});

test('on touch there is no × at all: the swipe is the way to clear', () => {
  const html = renderSheet({ touch: true, list: [view(10)] });
  // #4769: on touch the row sits in a swipe host the kit holds, so a swipe
  // translates everything on it together; the slot keeps that host as its
  // only child. Desktop keeps the flat slot (pinned above), which is what
  // dapp.json's selectors read. #5580: on Unread the host is the card's
  // surface (it is what slides), and the slot only rounds the kit's wrap.
  assert.match(html, /<div class="notifications-row-slot group\/notif relative notifications-card rounded-\[20px\]"><div data-notif-swipe="true" class="rounded-\[20px\] bg-white dark:bg-zinc-900 [^"]* relative grid grid-cols-1"><button data-notif-id="10"/);
  // A card's save is the swipe's first button on a phone (no hover there to
  // show it), so the card draws no bookmark of its own.
  assert.doesNotMatch(html, /data-notification-save="10"/);
  assert.match(SHEET_SRC, /const swipe = ui\.swipeActions\(el, \{ actions: cardSave \? \[save, clear\] : \[clear\] \}\);/);
  assert.match(SHEET_SRC, /label: t\(view\.saved \? 'notifications:row\.swipeUnsave' : 'notifications:row\.swipeSave'\)/);
  assert.doesNotMatch(html, /data-notification-clear/,
    'no hover on a phone, and an invisible target on a tile corner would clear by accident');
});

test('only an unread row offers a clear', () => {
  assert.match(SHEET_SRC, /const clearable = view\.unread;/);
  assert.match(SHEET_SRC, /\{clearable && !touch \? \(\s*<button\s+type="button"\s+data-notification-clear=\{view\.id\}/);
  assert.match(SHEET_SRC, /if \(!clearable \|\| !touch \|\| !el \|\| !ui\?\.swipeActions\) return undefined;/);
});

test('the swipe is the kit\'s, neutral, and a full swipe only where the row leaves', () => {
  const effect = SHEET_SRC.slice(SHEET_SRC.indexOf('if (!clearable || !touch || !el || !ui?.swipeActions) return undefined;'),
    SHEET_SRC.indexOf("}, [clearable, touch, removes, shape, view.id, groupIds?.join(','), t, onRelease, cardSave, view.saved]);"));
  assert.ok(effect.length > 0, 'the swipe effect found');
  assert.match(effect, /label: t\('notifications:row\.clear'\)/);
  assert.equal(message('notifications:row.clear'), 'Clear');
  // The kit's full swipe belongs to its destructive action and takes the row
  // out of the document. On Unread that is what happens to a cleared row; on
  // Messages and All the row stays, so the swipe only reveals the button.
  assert.match(effect, /destructive: removes,/);
  assert.match(SHEET_SRC, /removes=\{tab === 'unread'\}/);
  // Grey, not the kit's destructive red: clearing deletes nothing.
  assert.match(effect, /color: 'var\(--un-action-neutral\)'/);
  // Polish #7: the row is let go of first (useHeldUnread), so a cleared row
  // still leaves Unread while the rows read elsewhere stay listed.
  // #5289: a folded row lets go of, and clears, every notification it is.
  assert.match(effect, /handler: \(\) => \{\s*onRelease\?\.\(groupIds \|\| \[view\.id\]\);\s*void controller\(\)\?\.clearNotification\(view\.id, groupIds \|\| undefined\);\s*\}/);
  assert.match(SHEET_SRC, /return \(\) => swipe\.detach\(\);\n {2}\}, \[clearable, touch, removes, shape, view\.id, groupIds\?\.join\(','\), t, onRelease, cardSave, view\.saved\]\);/,
    'detached when the row stops being clearable, changes tab, shape or group, or its save changes');
});

test('the slot is what React places, and it is keyed on what the kit holds', () => {
  // The kit moves the row it is handed into a wrap of its own, and a full
  // swipe takes that wrap out of the document. The row therefore lives in a
  // slot React places; a row whose read state or shape changes is a new slot,
  // dropped whole rather than having its row swapped out from under the kit.
  assert.match(SHEET_SRC,
    /<div\s+key=\{`\$\{clearable \? 'unread' : 'read'\}:\$\{shape\}\$\{groupIds \? ':group' : ''\}`\}\s+className=\{slotCls\}/);
  // Polish #7: a row read while the sheet is open stays on Unread, dim.
  // #5580: a card's slot is the card at a desk; on touch the swipe host is.
  assert.match(SHEET_SRC, /const slotCls = 'notifications-row-slot group\/notif relative'\n\s+\+ \(card \? \(touch \? ' notifications-card rounded-\[20px\]' : ' notifications-card grid grid-cols-1 ' \+ CARD_SURFACE\) : ''\)\n\s+\+ \(held \? ' opacity-60' : ''\);/);
  // #4769: the kit must hold whichever node translates — the row itself on
  // desktop, the swipe host (row + bookmark) on touch — so the rows hand it
  // over only off touch, and the host hands itself over on touch.
  assert.equal((SHEET_SRC.match(/ref=\{touch \? undefined : setRow\}/g) || []).length, 2,
    'both row shapes hand the kit the row on desktop');
  assert.equal((SHEET_SRC.match(/<div ref=\{setRow\} data-notif-swipe/g) || []).length, 1,
    'on touch the swipe host is the node the kit holds');
});

test('the × is its own click, and keyboard focus has somewhere to go after it', () => {
  const handler = SHEET_SRC.slice(SHEET_SRC.indexOf('data-notification-clear={view.id}'),
    SHEET_SRC.indexOf('<XIcon aria-hidden="true" className="h-3 w-3"'));
  assert.match(handler, /event\.stopPropagation\(\);/);
  assert.match(handler, /void controller\(\)\?\.clearNotification\(view\.id, groupIds \|\| undefined\);/);
  assert.doesNotMatch(handler, /_onItemClick/, 'the × never opens the row');
  // A keyboard-made click (detail 0) moves focus off the × it just removed:
  // to the row if it stayed, else its neighbour, else the sheet's close.
  assert.match(handler, /const fromKeyboard = event\.detail === 0;/);
  assert.match(handler, /requestAnimationFrame\(\(\) => refocusAfterClear\(sheet, view\.id, neighbourId\)\)/);
  assert.match(SHEET_SRC, /function refocusAfterClear\([\s\S]{0,700}#notifications-sheet-close/);
});

test('the hairline between rows follows the slot', () => {
  assert.match(APP_CSS, /\.notifications-row-slot \.notifications-row::after \{ content: none; \}/);
  assert.match(APP_CSS, /\.notifications-row-slot:not\(:last-child\) \.notifications-row::after \{\s*content: '';/);
  assert.match(APP_CSS, /\.dark \.notifications-row-slot:not\(:last-child\) \.notifications-row::after \{ background: rgba\(255, 255, 255, 0\.08\); \}/);
});

test('a declared check sees the ×, and a folded row\'s × names the group', () => {
  const has = (fragment) => dapp.tests.some((t) => (t.expectSelector || '').includes(fragment));
  // Folded into an existing check on the same route rather than taking a
  // slot (the fold-first rule in services/app-manifest.js). The checks run
  // at 1280x800, where the kit reports a desktop and the × is rendered.
  // #5289: 990201 folds with 990205 ("2 sessions finished"), so the plain
  // row this pins is 990211, and the folded one names both.
  assert.ok(has('.notifications-row-slot > [data-notif-id="990211"] + button[data-notification-clear="990211"][aria-label="Clear notification"]'));
  assert.ok(has('.notifications-row-slot > [data-notif-id="990201"] + button[data-notification-clear="990201"][aria-label="Clear 2 notifications"]'));
  assert.ok(!has('#notifications-all-messages'));
});
