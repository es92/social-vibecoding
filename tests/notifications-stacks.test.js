'use strict';

// #5580: the Unread tab stacks each project's notifications the way the
// lock screen stacks an app's, folds one request's news into one card, and
// opens a card to what happened on its request or proposal.
//
// These tests pin, on the shipped sources:
//
//   1. foldStories: one story's notifications become one card where the
//      newest stood, the bot's included; a person's message, a row with its
//      own buttons and a story of one stay as they were.
//   2. The sheet's markup: a project with several cards is a closed stack
//      (its top card says how many more are under it and opens the stack;
//      the cards under it are the real ones, inert), a story card says its
//      request and count, and only a card about a request or a proposal
//      has a history to open.
//   3. historyLines: the steps in words, newest first, the story's other
//      notifications in their place, the card's own moment left out, and
//      other people's votes in a row as one line naming them in order.
//   4. rowView carries the story fields the fold reads, and the controller
//      reads a card's history from the route.
//
// Run with: node --test tests/notifications-stacks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SHEET_PATH = 'frontend/src/features/notifications/notifications-sheet.tsx';
const STACKS_PATH = 'frontend/src/features/notifications/notification-stacks.tsx';
const STACKS_SRC = read(STACKS_PATH);
const APP_CSS = read('public/css/app.css');
const { createStore } = loadTsx('frontend/src/lib/plain-store.js');
const stacks = loadTsx(STACKS_PATH);

const MIN = 60 * 1000;

const view = (id, overrides = {}) => ({
  id,
  kind: 'voted_change_merged',
  unread: true,
  unreadCls: '',
  time: `${id}m ago`,
  timeTitle: 'Tuesday',
  icon: '🚀',
  label: message('notifications:row.votedMerged.label'),
  segments: [{ t: 'strong', v: `Change ${id}` }],
  createdAtMs: Date.now() - id * MIN,
  who: '',
  appLine: 'Notes',
  appName: 'Notes',
  appId: 5,
  storyKey: null,
  storyRef: null,
  ...overrides,
});
const entry = (v) => ({ type: 'notif', key: `n:${v.id}`, at: v.createdAtMs, view: v });

function renderSheet({ list, touch = false }) {
  const notificationsStore = createStore({
    saved: [], invites: [], screenList: list, touch, loadingMore: false, screenCanLoadMore: false, badgeTotal: list.length,
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

// ── 1. the fold ─────────────────────────────────────────────────────────

test('one request\'s notifications fold into one card where the newest stood', () => {
  const story = { storyKey: 'r:5:5580', storyRef: { number: 5580, title: 'Plant shelf' } };
  const out = stacks.foldStories([
    entry(view(1, { ...story, kind: 'build_live', conversation: true, bot: true, label: 'Live' })),
    entry(view(2)),
    entry(view(3, { ...story, kind: 'issue_mention', label: 'Mentioned you' })),
    entry(view(4, { ...story, kind: 'build_ready', conversation: true, bot: true, label: 'Ready to try' })),
  ]);
  assert.deepEqual(out.map((e) => e.view.id), [1, 2], 'the story where its newest stood, and the row about nothing else');
  const card = out[0].view;
  assert.deepEqual(card.groupIds, [1, 3, 4], 'it opens and clears every notification it is, newest first');
  assert.equal(card.count, 3);
  assert.equal(card.groupLabelled, true, 'its meta line says the count, so no pill says it again');
  assert.deepEqual(card.story.members.map((m) => m.id), [1, 3, 4]);
  assert.equal(card.label, 'Live', 'drawn as its newest notification');
});

test('a person speaking, a row with buttons and a story of one stay as they were', () => {
  const key = { storyKey: 's:5:77' };
  const out = stacks.foldStories([
    entry(view(1, { ...key, kind: 'conversation_message', conversation: true })),
    entry(view(2, { ...key, kind: 'conversation_message', conversation: true })),
    entry(view(3, { ...key, kind: 'pr_recheck', actions: [{ key: 'still_yes', label: 'Still yes' }] })),
    entry(view(4, { ...key, kind: 'pr_recheck', actions: [{ key: 'still_yes', label: 'Still yes' }] })),
    entry(view(5, { storyKey: 'r:5:9' })),
  ]);
  assert.deepEqual(out.map((e) => e.view.id), [1, 2, 3, 4, 5]);
  assert.ok(out.every((e) => !e.view.story && !e.view.groupIds));
});

// ── 2. the sheet ────────────────────────────────────────────────────────

test('a project with several cards is a closed stack: its newest card on top, the rest under it', () => {
  const html = renderSheet({ list: [view(1), view(2, { kind: 'pr_proposed', label: 'New change' }), view(3, { kind: 'check_failed', label: 'Testing couldn\'t run' })] });
  assert.match(html, /<div class="notifications-stack" data-notif-stack="a:5" data-stack-closed="" data-stack-depth="2"><div class="flex items-center gap-2 px-4 pt-4 pb-1\.5" data-notif-app-group="a:5">/,
    'the heading stays the stack\'s first child, so the cards are its siblings');
  // The top card says how many are under it, and tapping it opens the stack.
  assert.match(html, /data-stack-top=""><button data-notif-id="1" class="notifications-row [^"]*" aria-expanded="false">/);
  assert.ok(html.includes(message('notifications:stack.more', { count: 2 })));
  assert.equal(message('notifications:stack.more', { count: 2 }), '2 more notifications');
  // The cards under it are the real cards, out of reach until it opens.
  assert.match(html, /data-stack-behind="1" inert="" aria-hidden="true"><button data-notif-id="2"/);
  assert.match(html, /data-stack-behind="2" inert="" aria-hidden="true"><button data-notif-id="3"/);
  // A closed stack has nothing to fold back.
  assert.doesNotMatch(html, /data-notif-stack-less/);
  // Each card is the shell's card; the time sits at its top right.
  assert.match(html, /class="notifications-row-slot group\/notif relative notifications-card grid grid-cols-1 rounded-\[20px\] bg-white dark:bg-zinc-900 /);
  assert.match(html, /<span class="flex-1 min-w-0 truncate">[^<]+<\/span><time title="Tuesday" class="shrink-0[^"]*">1m ago<\/time>/);
});

test('a project with one card has nothing to stack', () => {
  const html = renderSheet({ list: [view(1), view(2, { appId: 6, appName: 'Polls', appLine: 'Polls' })] });
  assert.match(html, /data-notif-stack="a:5"><div [^>]*data-notif-app-group="a:5">/);
  assert.doesNotMatch(html, /data-stack-closed|data-stack-top|data-stack-behind|aria-expanded="false"/);
  // Under its project's name the card does not say the name again.
  assert.doesNotMatch(html, /<span class="block text-xs text-zinc-500 truncate">Notes<\/span>/);
});

test('a story card says its request and how many notifications it is, and clears them all', () => {
  const story = { storyKey: 'r:5:5580', storyRef: { number: 5580, title: 'Plant shelf' } };
  const html = renderSheet({
    list: [
      view(1, { ...story, kind: 'build_live', conversation: true, bot: true, botMoment: true, label: 'Live', segments: [{ t: 'strong', v: 'Plant shelf' }] }),
      view(2, { ...story, kind: 'build_ready', conversation: true, bot: true, botMoment: true, label: 'Ready to try', segments: [{ t: 'strong', v: 'Plant shelf' }] }),
      view(3, { appId: 6, appName: 'Polls', appLine: 'Polls' }),
    ],
  });
  assert.match(html, /<button data-notif-id="1" data-notif-group-size="2"/);
  assert.ok(html.includes('#5580 · 2 notifications'));
  assert.equal(message('notifications:story.meta', { number: 5580, count: 2 }), '#5580 · 2 notifications');
  assert.match(html, /data-notification-clear="1" aria-label="Clear 2 notifications"/);
  assert.doesNotMatch(html, /data-notification-save="1"/, 'a save is one notification\'s');
  // Alone in its project it is not stacked, so it has its history to open.
  assert.match(html, /<button type="button" data-notif-history="1" aria-expanded="false" aria-label="Show what happened" class="[^"]*un-touch-target"/);
  assert.doesNotMatch(html, /data-notif-history="3"/, 'a card about no request or proposal has none');
  assert.doesNotMatch(html, /data-notif-history-list/, 'closed until asked for');
});

test('a fold by kind is several things, not one story: no history', () => {
  const html = renderSheet({ list: [view(1, { storyKey: 's:5:1' }), view(2, { storyKey: 's:5:2' })] });
  assert.match(html, /<button data-notif-id="1" data-notif-group-size="2"/);
  assert.doesNotMatch(html, /data-notif-history=/);
});

test('on a phone a card\'s Save is in its swipe, and pressing and holding opens its history', () => {
  const html = renderSheet({ touch: true, list: [view(1, { storyKey: 's:5:1', storyRef: { number: 41, title: 'x' } })] });
  assert.doesNotMatch(html, /data-notification-save=/, 'no hover on a phone: the swipe has Save');
  assert.doesNotMatch(html, /data-notification-clear=/);
  assert.match(html, /<div data-notif-swipe="true" class="[^"]*"><button data-notif-id="1"[\s\S]*?<\/button><button type="button" data-notif-history="1"/,
    'the chevron rides on the card the swipe moves');
  const sheet = read(SHEET_PATH);
  assert.match(sheet, /timer: setTimeout\(\(\) => \{\s*press\.current = null;\s*heldAt\.current = Date\.now\(\);\s*setHistoryOpen\(\(was\) => !was\);\s*\}, 450\)/);
  assert.match(sheet, /if \(Date\.now\(\) - heldAt\.current < 700\) return;/, 'the lift after a hold is not a tap');
});

test('the closed stack\'s cards sit under its top card in CSS, and the motion respects reduced motion', () => {
  assert.match(APP_CSS, /\.notifications-stack\[data-stack-closed\] > \[data-stack-behind\] \{[^}]*position: absolute;[^}]*top: calc\(var\(--stack-top, 0px\) \+ 8px\);[^}]*height: var\(--stack-h, 0px\);[^}]*pointer-events: none;/);
  assert.match(APP_CSS, /\.notifications-stack \.notifications-row-slot \.notifications-row::after \{ content: none; \}/,
    'cards are surfaces of their own: no hairline between them');
  assert.match(APP_CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*\.notifications-stack > \.notifications-row-slot,/);
  assert.match(STACKS_SRC, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
});

// ── 3. the history's lines ──────────────────────────────────────────────

test('a history in words: newest first, the story\'s other notifications in place, the card\'s own moment left out', () => {
  const t = englishPlatformI18n().t;
  const now = Date.now();
  const iso = (minutesAgo) => new Date(now - minutesAgo * MIN).toISOString();
  const lead = view(1, { kind: 'build_live', createdAtMs: now - 1 * MIN, label: 'Live' });
  const ready = view(2, { kind: 'build_ready', createdAtMs: now - 25 * MIN, label: 'Ready to try', unread: false, segments: [{ t: 'strong', v: 'Plant shelf' }] });
  const card = { ...lead, story: { members: [lead, ready] } };
  const lines = stacks.historyLines(card, [
    { at: iso(1.5), kind: 'live' },
    { at: iso(10), kind: 'vote', actor: 'cy', vote: 'yes' },
    { at: iso(12), kind: 'vote', actor: 'ben', vote: 'yes' },
    { at: iso(14), kind: 'vote', actor: 'me', vote: 'yes' },
    { at: iso(26), kind: 'updated' },
    { at: iso(40), kind: 'comment', actor: 'ben', words: 'Works on my phone.' },
    { at: iso(70), kind: 'proposed', actor: 'homeroom_bot' },
    { at: iso(120), kind: 'asked', actor: 'me' },
  ], t, 'me');
  assert.deepEqual(lines.map((l) => l.what), [
    '2 yes votes', 'You voted yes', 'Ready to try', 'Updated', '@ben commented', 'Homeroom bot put it up for a vote', 'You asked for it',
  ], 'its going live is the card itself');
  assert.equal(lines[0].words, '@ben, @cy', 'the voters in the order they voted');
  assert.deepEqual(lines[2].notification, { id: 2, unread: false }, 'one of the story\'s notifications opens on its own');
  assert.equal(lines[2].words, 'Plant shelf');
  assert.equal(lines[4].words, 'Works on my phone.');
});

// ── 4. the data ─────────────────────────────────────────────────────────

let controller = null;
function loadController() {
  if (controller) return controller;
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.PlatformI18n = englishPlatformI18n();
  loadTsx('frontend/src/features/notifications/notifications.js');
  controller = globalThis.window.Notifications;
  return controller;
}

test('rowView carries the story a row is about', () => {
  const N = loadController();
  const now = new Date().toISOString();
  const [bot, mention, plain, dm] = N._screenViews([
    {
      id: 1, kind: 'build_live', appId: 3, appName: 'Notes', conversationId: 9, sourceUsername: 'homeroom_bot',
      detail: 'hrbot2:{"m":"live","a":"Notes","t":"Plant shelf","i":5580}', storyIssueNumber: 5580, readAt: null, createdAt: now,
    },
    {
      id: 2, kind: 'mention', appId: 3, appName: 'Notes', sourceUsername: 'ben', messageContent: '@me look',
      storySessionId: 41, storyIssueNumber: null, storyPrNumber: 5590, storyTitle: 'Plant shelf, home', readAt: null, createdAt: now,
    },
    { id: 3, kind: 'platform_limit', appId: null, detail: 'apps_warn:40:50', readAt: null, createdAt: now },
    { id: 4, kind: 'conversation_message', appId: null, conversationId: 8, sourceUsername: 'ben', messageContent: 'hi', readAt: null, createdAt: now },
  ]);
  assert.equal(bot.storyKey, 'r:3:5580');
  assert.deepEqual(bot.storyRef, { number: 5580, title: 'Plant shelf' });
  assert.equal(bot.appName, 'Notes');
  assert.equal(bot.plainMessage, false, 'the bot\'s news about a project is the bell\'s');
  assert.equal(mention.storyKey, 's:3:41', 'a proposal\'s story when no request is known');
  assert.deepEqual(mention.storyRef, { number: 5590, title: 'Plant shelf, home' });
  assert.equal(plain.storyKey, null);
  assert.equal(dm.plainMessage, true, 'a person\'s message stays the Messages tab\'s');
});

test('the controller reads a card\'s history from the route, and a failed read is null', async () => {
  const N = loadController();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.location = globalThis.location || { search: '' };
  try {
    globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, json: async () => ({ steps: [{ kind: 'live', at: 'x' }] }) }; };
    assert.deepEqual(await N.loadHistory(990214), { steps: [{ kind: 'live', at: 'x' }] });
    assert.match(calls[0], /^\/api\/notifications\/990214\/history/);
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    assert.equal(await N.loadHistory(5), null);
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    assert.equal(await N.loadHistory(5), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the catalog holds the new entries, each with a description', () => {
  const catalog = JSON.parse(read('frontend/locales/en/notifications.json'));
  const used = new Set([...read(SHEET_PATH).matchAll(/'notifications:((?:stack|story|history|row\.swipe)[\w.]*)'/g),
    ...STACKS_SRC.matchAll(/'notifications:((?:stack|story|history)[\w.]*)'/g)].map((m) => m[1]));
  assert.ok(used.size > 20, 'the new copy is requested by whole literals');
  for (const id of used) {
    const entryOf = catalog[id] || catalog[`${id}_other`];
    assert.ok(entryOf, `${id} is in the catalog`);
    assert.ok(entryOf.description, `${id} has a description`);
  }
});
