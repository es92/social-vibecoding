// The "This week" card on your own profile (#5626): what it says for a week
// of time in apps, for none and for a failed read, and that it is yours alone.
// The server's half is in tests/me-summary.test.js, and its SQL runs in
// tests/profile-activity-postgres.test.js.
//
// Run with: node --test tests/profile-activity.test.js
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
const store = loadTsx(STORE);

// 2026-11-05 is a Thursday, so the week runs Friday to Thursday.
const DATES = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
const week = (minutes, appsOpened = 2) => {
  const days = DATES.map((date, i) => ({ date, seconds: minutes[i] * 60 }));
  return { activity: { days, appsOpened, totalSeconds: days.reduce((n, d) => n + d.seconds, 0) } };
};
const WEEK = week([25, 0, 48, 70, 12, 35, 30], 6);

function render(data) {
  const state = {
    open: true, data, user: { username: 'evan', links: {} },
    sheetOpen: false, publicStatus: '', publishing: false, previewOpen: false,
  };
  const mod = loadTsx(VIEW, {
    stubs: { './profile-store.js': { ...store, profileStore: { get: () => state, subscribe: () => () => {} } } },
  });
  return renderToHtml(createElement(mod.ProfileRoot, {}));
}

test('a failed read leaves the card out: a zero would be a claim', () => {
  assert.equal(store.activityView(null), null);
  assert.equal(store.activityView({ merged: 1 }), null, 'a summary with no activity');
  assert.equal(store.activityView({ activity: { totalSeconds: 3 } }), null, 'no days');
});

test('a week with nothing to show says so once', () => {
  assert.deepEqual(store.activityView(week([0, 0, 0, 0, 0, 0, 0], 0)), { empty: true });
});

test('a week reads as its total, its apps and seven days, today last', () => {
  const view = store.activityView(WEEK);
  assert.equal(view.time, message('profile:activity.hours', { hours: 3, minutes: 40 }));
  assert.equal(view.time, '3h 40m');
  assert.equal(view.apps, '6');
  assert.equal(view.appsLabel, 'apps opened');
  assert.deepEqual(view.days.map((d) => d.key), DATES);
  assert.deepEqual(view.days.map((d) => d.today), [false, false, false, false, false, false, true]);
  assert.deepEqual(view.days.map((d) => d.label), ['Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu']);
  assert.equal(view.days[3].spoken, 'Monday: 1h 10m');
  assert.equal(view.days[1].spoken, 'Saturday: no time');
});

test('bars are against the busiest day, a zero is no bar, and only the busiest is labelled', () => {
  const { days } = store.activityView(WEEK);
  assert.deepEqual(days.map((d) => d.heightPct), [36, 0, 69, 100, 17, 50, 43]);
  assert.deepEqual(days.map((d) => d.zero), [false, true, false, false, false, false, false]);
  assert.deepEqual(days.filter((d) => d.peakLabel).map((d) => d.key), ['2026-11-02']);
  // A very short day still reads as a bar.
  const small = store.activityView(week([0, 0, 0, 600, 0, 0, 1])).days;
  assert.equal(small[6].heightPct, 6);
});

test('durations are short and honest', () => {
  const total = (seconds) => store.activityView({
    activity: { days: DATES.map((date, i) => ({ date, seconds: i === 0 ? seconds : 0 })), totalSeconds: seconds, appsOpened: 1 },
  }).time;
  assert.equal(total(20), message('profile:activity.underMinute'));
  assert.equal(total(45 * 60), '45m');
  assert.equal(total(3 * 3600 + 40 * 60 + 59), '3h 40m');
  assert.equal(total(2 * 3600), '2h 0m');
});

test('apps opened with no time keeps the apps figure and draws no empty chart', () => {
  const view = store.activityView(week([0, 0, 0, 0, 0, 0, 0], 1));
  assert.equal(view.empty, false);
  assert.equal(view.time, null);
  assert.equal(view.apps, '1');
  assert.equal(view.appsLabel, 'app opened');
  assert.deepEqual(view.days, []);
});

// ─── The week's accomplishments and Share (#6464) ───────────────────────

const WEEK_WORK = { ...WEEK, week: { merged: 2, apps: [{ slug: 'notes', name: 'Notes' }], challengesDone: 1 } };

test('live changes and completed challenges are figures of the same week', () => {
  const view = store.activityView(WEEK_WORK);
  assert.equal(view.empty, false);
  assert.equal(view.merged, '2');
  assert.equal(view.mergedLabel, 'changes live');
  assert.equal(view.challenges, '1');
  assert.equal(view.challengesLabel, 'challenge done');
  assert.equal(view.canShare, true, 'there is something to share');
});

test('a zero accomplishment says nothing, and a week with none of them still reads empty', () => {
  const zero = store.activityView({ ...WEEK, week: { merged: 0, apps: [], challengesDone: 0 } });
  assert.equal(zero.merged, null);
  assert.equal(zero.mergedLabel, null);
  assert.equal(zero.challenges, null);
  assert.deepEqual(store.activityView(week([0, 0, 0, 0, 0, 0, 0], 0)), { empty: true },
    'no time, no apps, nothing live and no challenge is still one quiet line');
});

test('work with no time in apps shows its figures without an empty chart', () => {
  const view = store.activityView({
    ...week([0, 0, 0, 0, 0, 0, 0], 0),
    week: { merged: 2, apps: [{ slug: 'notes', name: 'Notes' }], challengesDone: 1 },
  });
  assert.equal(view.empty, false);
  assert.equal(view.time, null);
  assert.deepEqual(view.days, []);
  assert.equal(view.merged, '2');
  assert.equal(view.challenges, '1');
});

test('the card carries a Share action only when it has something to share', () => {
  const full = render({ ranking: {}, summary: WEEK_WORK, ownerPublicProfile: null });
  assert.ok(full.includes('id="profile-activity-share"'));
  const empty = render({ ranking: {}, summary: week([0, 0, 0, 0, 0, 0, 0], 0), ownerPublicProfile: null });
  assert.ok(!empty.includes('id="profile-activity-share"'), 'the one quiet line has nothing to share');
  assert.ok(!render({ ranking: {}, summary: null, ownerPublicProfile: null }).includes('id="profile-activity-share"'));
});

test('your own profile draws the card under the stat cards, before Your work', () => {
  const html = render({ ranking: {}, summary: { merged: 2, ...WEEK }, ownerPublicProfile: null });
  const stats = html.indexOf('id="profile-stats"');
  const card = html.indexOf('id="profile-activity"');
  const work = html.indexOf('id="profile-work"');
  assert.ok(stats >= 0 && stats < card && card < work);
  const section = html.slice(card, work);
  assert.ok(section.includes(message('profile:activity.title')));
  assert.ok(section.includes(message('profile:activity.timeLabel')));
  assert.ok(section.includes(message('profile:activity.note')));
  assert.match(section, new RegExp(`aria-label="${message('profile:activity.chartLabel')}"`));
  assert.equal((section.match(/data-activity-day=/g) || []).length, 7);
  assert.ok(section.includes('<span class="sr-only">Monday: 1h 10m</span>'));
  assert.ok(section.includes('style="height:64px"'), 'the busiest day fills the plot');
  assert.ok(section.includes('bg-[color:var(--lit-ink)]'));
});

test('an empty week is one quiet line, and a failed read is no card', () => {
  const empty = render({ ranking: {}, summary: week([0, 0, 0, 0, 0, 0, 0], 0), ownerPublicProfile: null });
  const section = empty.slice(empty.indexOf('id="profile-activity"'), empty.indexOf('id="profile-work"'));
  assert.ok(section.includes(message('profile:activity.empty')));
  assert.ok(!section.includes('data-activity-day'));
  assert.ok(!section.includes(message('profile:activity.note')));
  assert.ok(!render({ ranking: {}, summary: null, ownerPublicProfile: null }).includes('id="profile-activity"'));
});

test('another person\'s profile never draws it, even with a summary in the state', () => {
  const data = { publicProfile: { username: 'ada', display_name: 'Ada' }, summary: WEEK };
  const view = store.buildProfileView({ open: true, data, user: { id: 1, username: 'evan' } });
  assert.equal(view.kind, 'public');
  assert.ok(!('activity' in view), 'the public view has no such part');
  assert.ok(!render(data).includes('id="profile-activity"'));
});

test('another person\'s profile is never served it', () => {
  // The public read's whole source: no table, no shape, no field of the card.
  const route = read('src/routes/profiles.js');
  assert.ok(!/app_activity|dapp_opened|shapeActivity|totalSeconds|appsOpened/.test(route));
  // Its one route is the session user's, and takes no one's name.
  const profile = read('src/routes/profile.js');
  assert.match(profile, /router\.get\('\/api\/me\/summary', requireUser,/);
  assert.match(profile, /pool\.query\(SUMMARY_ACTIVITY_DAYS_SQL, \[req\.user\.id\]\)/);
  assert.match(profile, /pool\.query\(SUMMARY_ACTIVITY_APPS_SQL, \[req\.user\.id\]\)/);
  // The client asks for it on the own branch only: the public load names the
  // person's public read, and no other caller asks for the summary.
  const client = read('frontend/src/features/profile/profile.js');
  assert.equal((client.match(/\/api\/me\/summary\$\{demo\}/g) || []).length, 1);
});
