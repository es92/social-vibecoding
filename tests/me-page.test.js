// The Me page as the navigation prototype draws it (`scrMe`): the profile
// card, three stat cards, a "More" list whose rows say what is behind them,
// and "Your contributions" — shaped in frontend/src/features/profile/
// profile-store.js and drawn by profile-view.tsx.
//
// Pinned here: what each part SAYS for real data and for missing data, that
// every part of the older, longer Profile still has a home, and that the
// prerender still draws nothing (the island rule: data only from effects).
//
// Run with: node --test tests/me-page.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const STORE = 'frontend/src/features/profile/profile-store.js';
const NOW = Date.parse('2026-09-23T12:00:00Z');

const SUMMARY = {
  merged: 9, apps: 3, kudos: 3, memberSince: '2026-03-04T10:00:00Z',
  challenges: { done: 2, total: 7, season: { id: 3, name: 'Season 3' } },
  contributions: [
    { sessionId: 213, title: 'Messages as a tab', appSlug: 'usernode-2d5619', appName: 'Homeroom', platform: true, mergedAt: '2026-09-20T12:00:00Z', kudos: 4 },
    { sessionId: 188, title: 'CSV export', appSlug: 'recipe box', appName: 'Recipe Box', appIconEmoji: '🍲', mergedAt: '2026-08-01T12:00:00Z', kudos: 0 },
    { sessionId: 140, title: 'Lasso', appSlug: 'whiteboard', appName: 'Whiteboard', appIconUrl: '/app-icons/abc', mergedAt: '2025-06-01T12:00:00Z', kudos: 1 },
  ],
};

test('the three stat cards: merged, kudos, challenges — and a dash, not a zero, without data', () => {
  const { statsView } = loadTsx(STORE);
  assert.deepEqual(statsView(SUMMARY).map((s) => [s.key, s.value, s.label]),
    [['merged', '9', 'merged'], ['kudos', '3', 'kudos'], ['challenges', '2', 'challenges']]);
  assert.deepEqual(statsView(null).map((s) => s.value), ['–', '–', '–'],
    'a read that failed is not a claim of zero');
});

test('the More rows say what is behind them, from the data only', () => {
  const { moreRowsView } = loadTsx(STORE);
  assert.deepEqual(moreRowsView({
    ranking: { season_name: 'Season 3', rank: 3 }, summary: SUMMARY,
    feedback: { sent: 4, counted: 1, reports: [] },
  }), { challenges: 'Season 3 · rank #3 · 2 of 7 done', kudos: '3 received', feedback: '4 sent · 1 counted' });
  // No rank yet (signed-in newcomer): the season and the tally, no invented rank.
  assert.deepEqual(moreRowsView({ ranking: {}, summary: SUMMARY, feedback: { sent: 0, counted: 0, reports: [] } }),
    { challenges: 'Season 3 · 2 of 7 done', kudos: '3 received', feedback: 'Nothing sent yet' });
  // #3186: a feedback read that failed is not a claim that none was sent.
  assert.deepEqual(moreRowsView({ ranking: null, summary: null }), { challenges: null, kudos: null, feedback: null });
});

test('the card\'s one line of facts: @handle, building since, apps', () => {
  const { identityView } = loadTsx(STORE);
  const user = { username: 'evan', displayName: 'Evan S', links: {} };
  const view = identityView({ user, data: { summary: SUMMARY } });
  assert.equal(view.name, 'Evan S');
  // Month names are the runtime locale's; the shape is what is pinned.
  assert.match(view.sub, /^@evan · Building since \S+ 2026 · 3 apps$/);
  const bare = identityView({ user: { username: 'evan' }, data: { summary: { ...SUMMARY, apps: 1 } } });
  assert.equal(bare.name, '@evan');
  assert.match(bare.sub, /^Building since \S+ 2026 · 1 app$/, 'the handle is the headline, so not repeated');
  assert.equal(identityView({ user: { username: 'evan' }, data: null }).sub, null);
});

test('contributions: each a link to its proposal, with its app tile and a readable date', () => {
  const { contributionsView } = loadTsx(STORE);
  const view = contributionsView(SUMMARY, 'evan', NOW);
  assert.equal(view.seeAllHref, '#leaderboard/users/evan');
  assert.deepEqual(view.rows.map((r) => r.href), [
    '#app/usernode-2d5619/dev/proposals/213',
    '#app/recipe%20box/dev/proposals/188',
    '#app/whiteboard/dev/proposals/140',
  ]);
  assert.deepEqual(view.rows.map((r) => r.tile.kind), ['platform', 'emoji', 'image']);
  assert.equal(view.rows[0].meta, 'Homeroom · merged 3 days ago · 4 kudos');
  assert.match(view.rows[1].meta, /^Recipe Box · merged (\S+ 1|1 \S+)$/, 'past a fortnight: month and day, no year this year');
  assert.match(view.rows[2].meta, /^Whiteboard · merged .*2025 · 1 kudos$/, 'and the year once it is not this one');
  assert.doesNotMatch(view.rows[1].meta, /\d+\/\d+\/\d+/, 'never a numeric date that reads differently by region');
  assert.equal(contributionsView(null, 'evan').loaded, false, 'a failed read is told apart from "nothing merged"');
  const unsafe = contributionsView({ contributions: [{ sessionId: 1, appSlug: 'x', appIconUrl: 'javascript:1' }] }, 'evan', NOW);
  assert.equal(unsafe.rows[0].tile.kind, 'letter', 'only the platform\'s own /app-icons/ path is an image');
});

test('the page renders the four parts in the prototype\'s order', () => {
  const state = {
    open: true,
    data: { ranking: { season_name: 'Season 3', rank: 3 }, summary: SUMMARY, ownerPublicProfile: null },
    user: { username: 'evan', links: {} },
    sheetOpen: false, publicStatus: '', publishing: false, previewOpen: false,
  };
  const real = loadTsx(STORE);
  const mod = loadTsx('frontend/src/features/profile/profile-view.tsx', {
    stubs: { './profile-store.js': { ...real, profileStore: { get: () => state, subscribe: () => () => {} } } },
  });
  const html = renderToHtml(createElement(mod.ProfileRoot, {}));
  const order = ['id="profile-identity-card"', 'id="profile-stats"', 'id="profile-more"', 'id="profile-contributions"']
    .map((needle) => html.indexOf(needle));
  assert.ok(order.every((i) => i >= 0), 'all four parts render');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'card, stats, More, contributions');
  assert.match(html, /id="profile-edit-btn"/);
  assert.match(html, /data-contribution="213"/);
  assert.ok(!/Log out|profile-row-admin|data-completed-challenge|Points breakdown/.test(html),
    'nothing that moved elsewhere is drawn twice');
});

test('Me sits in the Workshop tab\'s frame, and its labels on the rows\' edge (#2832)', () => {
  const state = {
    open: true,
    data: { ranking: { season_name: 'Season 3', rank: 3 }, summary: SUMMARY, ownerPublicProfile: null },
    user: { username: 'evan', links: {} },
    sheetOpen: false, publicStatus: '', publishing: false, previewOpen: false,
  };
  const real = loadTsx(STORE);
  const view = loadTsx('frontend/src/features/profile/profile-view.tsx', {
    stubs: { './profile-store.js': { ...real, profileStore: { get: () => state, subscribe: () => () => {} } } },
  });
  // The screen root: rendered with the view stubbed out, so this reads the
  // column's own classes and nothing the store draws inside it.
  const screen = loadTsx('frontend/src/features/profile/index.tsx', {
    stubs: { './profile-view': { ProfileRoot: () => null }, './mount': {} },
  });
  const rootHtml = renderToHtml(createElement(screen.ProfileScreen, {}));
  const rootClass = (rootHtml.match(/id="profile-root" class="([^"]*)"/) || [])[1];
  assert.ok(rootClass, '#profile-root renders');
  const classes = rootClass.split(/\s+/);
  // Workshop's column: the same width, and the same 8px notch + 12px of air.
  const workshop = read('frontend/src/features/workshop/index.tsx');
  assert.match(workshop, /className="max-w-2xl mx-auto pb-8"/, 'Workshop\'s column is still the reference');
  assert.match(workshop, /className="px-4 pt-5 pb-2 /, 'and its first element still steps down pt-5');
  for (const cls of ['max-w-2xl', 'mx-auto', 'px-4', 'pt-5', 'pb-8']) {
    assert.ok(classes.includes(cls), `#profile-root carries ${cls}`);
  }
  assert.ok(!classes.includes('max-w-3xl') && !classes.includes('p-4'),
    'not the wider column, nor the p-4 that left the card 8px under the bar');

  // Both section labels are SectionHeader at its own px-4 — on the rows'
  // content edge, as Settings and Discover set theirs — not the px-1 that
  // sat them 12px left of the cards' rows.
  const html = renderToHtml(createElement(view.ProfileRoot, {}));
  const headings = [...html.matchAll(/<h2 class="([^"]*)">(More|Your contributions)<\/h2>/g)];
  assert.deepEqual(headings.map((m) => m[2]), ['More', 'Your contributions']);
  for (const [, cls, label] of headings) {
    const list = cls.split(/\s+/);
    assert.ok(list.includes('px-4') && !list.includes('px-1'), `"${label}" sits on the rows' edge: ${cls}`);
  }
  const seeAll = (html.match(/id="profile-contributions-all"[^>]*class="([^"]*)"/) || [])[1]
    || (html.match(/class="([^"]*)"[^>]*id="profile-contributions-all"/) || [])[1];
  assert.ok(seeAll && seeAll.split(/\s+/).includes('px-4'), '"See all" takes the same inset from the right');
});

test('every part of the older Profile has a home', () => {
  // points, rank, breakdown, token → the Challenges tab's standing card
  const standing = read('frontend/src/features/leaderboard/your-standing.tsx');
  assert.match(standing, /Points by event/);
  assert.match(standing, /Token allocation/);
  assert.match(read('frontend/src/features/leaderboard/challenges-pane.tsx'), /<YourStanding \/>/);
  // public-profile publishing → the Edit profile sheet
  const sheet = read('frontend/src/features/profile/profile-edit-sheet.tsx');
  assert.match(sheet, /id="public-profile-controls"/);
  assert.match(sheet, /Profile\._setPublished\(!published\)/);
  assert.match(sheet, /Copy public link/);
  // Admin & moderation, node / wallet / staking → Settings; Log out already there
  const rows = read('frontend/src/features/settings/account-rows.tsx');
  for (const needle of ['id="settings-row-admin"', '<NodePillRow />', '<WalletRow />', '<StakingRow />']) {
    assert.ok(rows.includes(needle), needle);
  }
  assert.match(read('frontend/src/features/settings/index.tsx'), /id="settings-logout"/);
  // completions → counted on Me, listed on the Challenges tab
  assert.match(read(STORE), /summary\.challenges && summary\.challenges\.done/);
});

// #2787: "Publish profile" took five rows and a four-line footnote on a phone
// and never said what publishing meant. It is one switch row now, with the
// state spelled out underneath, and everything else behind a tap.
function renderPublicGroup(owner, extra = {}) {
  const real = loadTsx(STORE);
  const ProfileStub = {
    _user: () => ({ username: 'evan', links: {} }),
    _setPublished: () => {}, togglePreview: () => {}, copyPublicLink: () => {},
    _dismissSheet: () => {}, MAX_DISPLAY_NAME: 50, MAX_BIO: 280,
  };
  const mod = loadTsx('frontend/src/features/profile/profile-edit-sheet.tsx', {
    stubs: { './profile.js': { Profile: ProfileStub } },
  });
  const controls = real.publicControlsView({ data: { ownerPublicProfile: owner } });
  const html = renderToHtml(createElement(mod.ProfileEditSheet, {
    avatarUrl: null, initial: 'E', publicControls: controls, ...extra,
  }));
  const start = html.indexOf('id="public-profile-controls"');
  const end = html.indexOf('Verified social accounts');
  assert.ok(start >= 0 && end > start, 'the Public page group renders before social accounts');
  return html.slice(start, end);
}

test('Public page is one switch row that says what it means (#2787)', () => {
  const off = renderPublicGroup({ published: false, profile: { username: 'evan' } });
  assert.match(off, /<input[^>]*type="checkbox"[^>]*class="un-switch[^"]*"/, 'a switch, not a Publish button');
  assert.match(off, /id="public-profile-publish"/);
  assert.doesNotMatch(off, /<input[^>]*checked/, 'off while private');
  assert.match(off, />Public profile</);
  assert.match(off, /Off: your profile has no public link/);
  assert.doesNotMatch(off, /Copy public link|Open public page/, 'no link actions for a page nobody can open');
  assert.match(off, /What&#x27;s on it|What’s on it|What's on it/);
  assert.doesNotMatch(off, /Homeroom-hosted photo/, 'the field list waits behind the disclosure');
  assert.ok((off.match(/un-group-row/g) || []).length === 2, 'two rows while private');

  const on = renderPublicGroup({ published: true, profile: { username: 'evan', url: '/profile/evan' } });
  assert.match(on, /<input[^>]*checked/, 'on while published');
  assert.match(on, /On: anyone with the link can view it, no account needed/);
  assert.match(on, /href="\/profile\/evan"[^>]*>Open public page/);
  assert.match(on, /Copy public link/);

  const hidden = renderPublicGroup({ published: true, moderationDisabled: true, profile: { username: 'evan' } });
  assert.match(hidden, /Hidden by moderation/);
  assert.match(hidden, /public page stays unavailable/);
});

test('the disclosure holds the field list and the preview card (#2787)', () => {
  const open = renderPublicGroup(
    { published: false, profile: { username: 'evan', displayName: 'Evan' } },
    { previewOpen: true },
  );
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /Homeroom-hosted photo/);
  assert.match(open, /id="public-profile-card"/);
  const closed = renderPublicGroup({ published: false, profile: { username: 'evan' } });
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /id="public-profile-card"/);
});

test('the prerender draws nothing: the Me screen\'s data only ever arrives from effects', () => {
  const real = loadTsx(STORE);
  assert.deepEqual(real.buildProfileView(real.profileStore.get()), { kind: 'empty' });
  const rows = loadTsx('frontend/src/features/settings/account-rows.tsx');
  assert.equal(renderToHtml(createElement(rows.SettingsAccountRows, {})), '',
    'Settings\' account block renders nothing until mounted, so its footer hydrates as shipped');
});
