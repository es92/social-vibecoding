// The "Share your week" card (#6464): which figures it offers, the words it
// sends, and that sharing is a local, read-only action. The card's own
// figures are pinned in tests/profile-activity.test.js; the server's half in
// tests/me-summary.test.js and tests/profile-activity-postgres.test.js.
//
// Run with: node --test tests/profile-week-share.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { message } = require('./lib/platform-i18n');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STORE = 'frontend/src/features/profile/profile-store.js';
const VIEW = 'frontend/src/features/profile/profile-view.tsx';
const SHEET = 'frontend/src/features/profile/week-share-sheet.tsx';
const store = loadTsx(STORE);

const DATES = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
const SUMMARY = {
  activity: {
    days: DATES.map((date, i) => ({ date, seconds: [1500, 0, 2880, 4200, 720, 2100, 1800][i] })),
    appsOpened: 6,
    totalSeconds: 13200,
  },
  week: {
    merged: 2,
    apps: [{ slug: 'usernode-2d5619', name: 'Homeroom' }, { slug: 'notes', name: 'Notes' }],
    challengesDone: 1,
  },
};
const PUBLISHED = {
  published: true,
  moderationDisabled: false,
  profile: { username: 'evan', url: '/#profile/evan' },
};
const ORIGIN = 'https://homeroom.example';

test('the card offers every non-zero figure, in the card\'s own order', () => {
  const view = store.shareWeekView(SUMMARY, null, ORIGIN);
  assert.deepEqual(view.items.map((item) => item.key), ['time', 'apps', 'merged', 'built', 'challenges']);
  assert.equal(view.items[0].label, '3h 40m time in apps');
  assert.equal(view.items[1].label, '6 apps opened');
  assert.equal(view.items[2].label, '2 changes live');
  assert.equal(view.items[3].label, 'Built in: Homeroom, Notes');
  assert.equal(view.items[4].label, '1 challenge done');
});

test('a zero figure is not offered at all', () => {
  const view = store.shareWeekView({
    activity: { days: DATES.map((date) => ({ date, seconds: 0 })), appsOpened: 1, totalSeconds: 0 },
    week: { merged: 0, apps: [], challengesDone: 0 },
  }, null, ORIGIN);
  assert.deepEqual(view.items.map((item) => item.key), ['apps']);
});

test('the address is the public profile\'s page, else the app\'s own, never a page that will not open', () => {
  assert.equal(store.shareWeekView(SUMMARY, PUBLISHED, ORIGIN).link, 'https://homeroom.example/#profile/evan');
  assert.equal(store.shareWeekView(SUMMARY, { ...PUBLISHED, published: false }, ORIGIN).link, ORIGIN,
    'an unpublished profile never links its hidden page: the app\'s address instead');
  assert.equal(store.shareWeekView(SUMMARY, { ...PUBLISHED, moderationDisabled: true }, ORIGIN).link, ORIGIN,
    'a hidden profile is not linked');
  assert.equal(store.shareWeekView(SUMMARY, null, ORIGIN).link, ORIGIN, 'not asked: the app\'s own address');
  assert.equal(store.shareWeekView(SUMMARY, PUBLISHED, '').link, null, 'with no origin there is no address');
});

test('every chosen figure is its own line, each carrying an address', () => {
  const { items, link } = store.shareWeekView(SUMMARY, PUBLISHED, ORIGIN);
  const all = store.shareText(items, items.map((item) => item.key), link);
  assert.equal(all, 'My week on Homeroom:\n'
    + '3h 40m time in apps https://homeroom.example/#profile/evan\n'
    + '6 apps opened https://homeroom.example/#profile/evan\n'
    + '2 changes live https://homeroom.example/#profile/evan\n'
    + 'Built in: Homeroom https://homeroom.example/#app/usernode-2d5619, '
    + 'Notes https://homeroom.example/#app/notes\n'
    + '1 challenge done https://homeroom.example/#profile/evan');
  // Not one line has the plain number on its own: each says where to see it.
  const lines = all.split('\n').slice(1);
  assert.equal(lines.length, items.length);
  for (const line of lines.filter((line) => !line.startsWith('Built in:'))) {
    assert.ok(line.endsWith(` ${link}`), line);
  }
  const built = lines.find((line) => line.startsWith('Built in:'));
  // Each app's own name sits beside its own link, so a reader can tell which
  // link belongs to which app (#6464, as @alfa asked).
  assert.ok(built.includes(`Homeroom ${ORIGIN}/#app/usernode-2d5619`), built);
  assert.ok(built.includes(`Notes ${ORIGIN}/#app/notes`), built);
  const some = store.shareText(items, ['time', 'merged']);
  assert.equal(some, 'My week on Homeroom:\n3h 40m time in apps\n2 changes live',
    'a pure call with no address is the words alone');
  assert.equal(store.shareText(items, new Set(['apps'])), 'My week on Homeroom:\n6 apps opened');
  assert.equal(store.shareText(items, []), '', 'nothing selected says nothing');
});

test('the apps line names each app beside its own link, never a bare URL', () => {
  const { items } = store.shareWeekView(SUMMARY, PUBLISHED, ORIGIN);
  const built = items.find((item) => item.key === 'built');
  assert.deepEqual(built.apps, [
    { name: 'Homeroom', url: `${ORIGIN}/#app/usernode-2d5619` },
    { name: 'Notes', url: `${ORIGIN}/#app/notes` },
  ]);
  assert.equal(store.shareText(items, ['built'], 'https://homeroom.example/#profile/evan'),
    `My week on Homeroom:\nBuilt in: Homeroom ${ORIGIN}/#app/usernode-2d5619, Notes ${ORIGIN}/#app/notes`);
  // With no origin there is no address, so the names stand alone.
  const offline = store.shareWeekView(SUMMARY, PUBLISHED, '');
  assert.equal(offline.items.find((item) => item.key === 'built').apps, null);
  assert.equal(store.shareText(offline.items, ['built']), 'My week on Homeroom:\nBuilt in: Homeroom, Notes');
});

test('with no published page every line still carries an address', () => {
  const { items, link } = store.shareWeekView(SUMMARY, null, ORIGIN);
  const text = store.shareText(items, items.map((item) => item.key), link);
  const lines = text.split('\n').slice(1);
  assert.equal(lines.length, items.length);
  for (const line of lines.filter((line) => !line.startsWith('Built in:'))) {
    assert.ok(line.endsWith(` ${ORIGIN}`), line);
  }
  const built = lines.find((line) => line.startsWith('Built in:'));
  assert.ok(built.includes(`Homeroom ${ORIGIN}/#app/usernode-2d5619`), built);
  assert.ok(built.includes(`Notes ${ORIGIN}/#app/notes`), built);
});

test('the sheet draws a switch for every figure and the words that will leave', () => {
  const state = {
    open: true,
    user: { username: 'evan', links: {} },
    data: { ranking: {}, summary: SUMMARY, ownerPublicProfile: PUBLISHED },
    sheetOpen: false, publicStatus: '', publishing: false, previewOpen: false,
    weekShareOpen: true,
  };
  const mod = loadTsx(VIEW, {
    stubs: { './profile-store.js': { ...store, profileStore: { get: () => state, subscribe: () => () => {} } } },
  });
  const html = renderToHtml(createElement(mod.ProfileRoot, {}));
  assert.ok(html.includes('id="profile-week-share-sheet"'));
  assert.ok(html.includes(message('profile:weekShare.title')));
  assert.ok(html.includes(message('profile:weekShare.note')));
  assert.equal((html.match(/id="profile-week-share-(time|apps|merged|built|challenges)"/g) || []).length, 5);
  assert.ok(html.includes('id="profile-week-share-copy"'), 'Copy is always offered');
  assert.ok(html.includes(message('profile:weekShare.preview')));
  assert.ok(html.includes('My week on Homeroom:\n3h 40m time in apps'));
});

test('sharing is local: the card sends nothing and records nothing', () => {
  const sheet = read(SHEET);
  assert.ok(!/fetch\(|XMLHttpRequest|\.send\(|api\/me\//.test(sheet), 'no request of any kind');
  assert.match(sheet, /navigator\.share/, 'the device\'s own share menu');
  assert.match(sheet, /navigator\.clipboard\.writeText/, 'and a clipboard copy');
  // The store adds no write either.
  assert.ok(!/POST|PATCH|DELETE/.test(read(STORE).slice(read(STORE).indexOf('export function shareWeekView'))));
});
