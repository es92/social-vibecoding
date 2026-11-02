// frontend/src/features/home/home-panels.js — the home screen's Challenges
// card (#911).
//
// The card sits between the "Your apps" grid and "Featured apps", in its
// OWN static <section id="home-panels"> outside #app-list (the grid's
// innerHTML is replaced on every WS app event and search keystroke, which
// would otherwise destroy the card and its listeners — the same reasoning
// that keeps the home search input outside the grid).
//
// Contracts guarded here:
//
//   1. Reward strings are organiser prose: rendered verbatim, with the
//      single exception that a bare number gets " pts" appended.
//   2. The progress bar clamps and never divides by a zero/NaN target.
//   3. Rows lead with what you have NOT done yet.
//   4. Every row draws the Challenges tab's shared card: a progress rail whose
//      words, fill and aria values are that tab's.
//   5. Organiser text is escaped for BOTH text and attribute contexts —
//      goals land inside aria-label="…", so & < > alone is not enough.
//   6. Signed-out and unloaded sections stay absent. Signed-in sections
//      ignore legacy hidden preferences and show their empty states.
//
// Loads the module in a vm sandbox with the stub DOM idiom of
// tests/home-find-more.test.js — no browser.
//
// Run with: node --test tests/home-panels-render.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { HOME_SRC: HOME, PANELS_SRC: SRC, PANELS_RAW } = require('./helpers/home-modules');
const { installPanelsStore } = require('./helpers/home-grid-store');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const INDEX = read('public/index.html');
const ISLAND = read('frontend/src/features/home/index.tsx');
const SW = read('public/sw.js');
const SCHEMA = read('src/db/schema.sql');
const SETTINGS = read('frontend/src/features/settings/settings.js');
const ROUTE = read('src/routes/home-panels.js');
const CSS = read('public/css/app.css');

// A minimal #home-panels element the module can paint into, so render()
// can be exercised end to end and its output inspected.
function makeSection() {
  return {
    innerHTML: '',
    _classes: new Set(['hidden']),
    classList: {
      toggle: (c, on) => {
        if (on) makeSection._last._classes.add(c);
        else makeSection._last._classes.delete(c);
      },
      // The slot path clears and hides the section before painting the
      // hosts, so both spellings have to exist on the stub.
      add: (c) => makeSection._last._classes.add(c),
      remove: (c) => makeSection._last._classes.delete(c),
      contains: (c) => makeSection._last._classes.has(c),
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
}

// A `[data-panel-slot]` host.
//
// It used to be a stub the module PAINTED INTO: render() assigned its
// innerHTML, toggled `hidden` on it and mirrored the block's state attributes
// up onto it. The host is ./panels/sections.tsx's own markup now, so this is a
// RECORD of one instead — `paintHosts` renders the section component for the
// state render() pushed and fills these fields in from the result, which keeps
// every assertion below reading the same three things it always read
// (innerHTML, the class list, the stamped attributes) while what produces them
// has moved.
function makeSlot(key) {
  const attrs = { 'data-panel-slot': key };
  const classes = new Set(['hidden']);
  const slot = {
    dataset: { panelSlot: key },
    innerHTML: '',
    attrs,
    _classes: classes,
    classList: {
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    setAttribute: (n, v) => { attrs[n] = v; },
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n) => n in attrs,
    removeAttribute: (n) => { delete attrs[n]; },
    // Good enough for the lookups _stampState does: find the inner element
    // carrying one of the state attributes, reading it out of the HTML.
    // Attribute-selector shaped rather than hard-coded to one name, so a
    // new entry in HomePanels.STATE_ATTRS is covered the day it lands.
    querySelector: (sel) => {
      const attr = /^\[([a-z-]+)\]$/.exec(sel);
      if (!attr) return null;
      const m = new RegExp(`${attr[1]}="([^"]*)"`).exec(slot.innerHTML);
      return m ? { getAttribute: () => m[1] } : null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  return slot;
}

// The fixed section hosts render() writes into, keyed the way it looks them
// up. `slots` is still the parameter name every test passes: THE UI OVERHAUL
// changed WHERE a block renders, not what it renders, so the hosts are the
// same stub under a different id. There were three; Create app became the
// launcher grid's trailing tile (tests/home-create-tile.test.js).
const SECTION_HOST_IDS = {
  discover: 'home-discover-section',
  challenges: 'home-challenges-section',
};

function makeHomePanels({
  user = { id: 1, isAdmin: false }, search = '', home = null, slots = null,
} = {}) {
  const section = makeSection();
  makeSection._last = section;
  // Map each supplied host onto the id render() will resolve it by.
  const hosts = new Map();
  for (const slot of slots || []) {
    const key = slot.dataset && slot.dataset.panelSlot;
    if (key && SECTION_HOST_IDS[key]) hosts.set(SECTION_HOST_IDS[key], slot);
  }
  const sandbox = {
    console,
    App: { user },
    // Only when a test asks for it — the default keeps every existing test
    // exercising the module with no Home on the window, exactly as before.
    ...(home ? { Home: home } : {}),
    document: {
      getElementById: (id) => hosts.get(id) || (id === 'home-panels' ? section : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    setTimeout, clearTimeout,
    URLSearchParams,
    location: { search, hash: '' },
    Date,
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  // home-panels.js imports its view-model store; ./helpers/home-modules strips
  // the line so the source runs as classic script text, and this supplies the
  // binding it would have made.
  installPanelsStore(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__HP = HomePanels;`, sandbox);
  return { HP: sandbox.__HP, section, sandbox };
}

// ── What render() pushed, as the markup the browser gets ──────────────
//
// `HomePanels.render()` computes three view models; ./panels/sections.tsx
// renders each host from them. This runs the second half against the first, so
// the tests below still assert on real markup produced by the real components
// rather than on a description of it.
const SECTIONS = 'frontend/src/features/home/panels/sections.tsx';
// The renderers, as text, for the handful of assertions that are about the
// SOURCE rather than the output (a class that must be written as a literal, a
// helper that must be reached through Home).
const PANEL_SOURCES = ['ui', 'challenges', 'discover', 'sections']
  .map((n) => [`panels/${n}.tsx`, read(`frontend/src/features/home/panels/${n}.tsx`)]);
const PANELS_TSX = PANEL_SOURCES.map(([, src]) => src).join('\n');
const challengesSrc = () => PANEL_SOURCES.find(([n]) => n.endsWith('challenges.tsx'))[1];
const SECTION_VIEWS = {
  discover: 'DiscoverSectionView',
  challenges: 'ChallengesSectionView',
};

function paintHosts(sandbox, hosts) {
  const mod = loadTsx(SECTIONS);
  const state = sandbox.panelsStore.get();
  for (const host of hosts) {
    const key = host.dataset.panelSlot;
    const html = renderToHtml(createElement(mod[SECTION_VIEWS[key]], state));
    const openEnd = html.indexOf('>') + 1;
    const open = html.slice(0, openEnd);
    host.innerHTML = html.slice(openEnd, html.lastIndexOf('</section>'));
    for (const name of Object.keys(host.attrs)) delete host.attrs[name];
    for (const m of open.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) host.attrs[m[1]] = m[2];
    host._classes.clear();
    for (const c of (host.attrs.class || '').split(/\s+/)) if (c) host._classes.add(c);
  }
  return hosts.map((h) => h.innerHTML).join('');
}

const challenge = (over = {}) => ({
  id: 1,
  label: 'COMMUNITY',
  goal: 'Report a reproducible bug',
  task: 'Find and file a reproducible bug report.',
  reward: '250 pts',
  cta: null,
  metric: null,
  progress: { done: false, current: null, target: null },
  earned_points: 0,
  ...over,
});

// The first challenge card and everything after it: the card markup without
// the heading above it.
const cardOf = (html) => html.slice(html.indexOf('home-challenge-card'));
// The first card alone, up to where the next one starts.
const firstCardOf = (html) => {
  const card = cardOf(html);
  const next = card.indexOf('home-challenge-card', 1);
  return next < 0 ? card : card.slice(0, next);
};

const panel = (over = {}) => ({
  key: 'challenges',
  title: 'Challenges',
  season: { id: 1, name: 'Season 1' },
  total: 1,
  done: 0,
  points_remaining: null,
  challenges: [challenge()],
  ...over,
});

// Render every section and hand back what they painted, joined.
//
// This used to read one node — #home-panels, the stacked fallback host below
// the grid. THE UI OVERHAUL replaced that host with three fixed section hosts
// and render() paints each directly, so "what the widgets rendered" is the
// three concatenated. Every assertion below is a substring or shape check
// over that text, so joining is faithful: it is the same markup, from the same
// renderers, in the same order.
// One block, end to end: a registry entry is all `panelFor` needs for the two
// MARKER widgets (discover and create build no server payload), so this covers
// the same ground `HP.renderDiscoverPanel({key})` covered before the renderers
// moved — with the real render() and the real component in between.
const MARKER_TITLES = { discover: 'Discover' };

function renderBlock(key, opts = {}) {
  const host = makeSlot(key);
  const { HP, sandbox } = makeHomePanels({ ...opts, slots: [host] });
  HP._data = {
    registry: [{ key, title: MARKER_TITLES[key], removable: key !== 'discover' }],
    hidden: [],
    panels: [],
  };
  HP.render();
  const html = paintHosts(sandbox, [host]);
  return { html, host, HP, sandbox };
}

function renderWith(data, opts = {}) {
  const hosts = ['discover', 'challenges'].map(makeSlot);
  const { HP, section, sandbox } = makeHomePanels({ ...opts, slots: hosts });
  HP._data = data;
  HP.render();
  const html = paintHosts(sandbox, hosts);
  return {
    HP,
    html,
    hosts,
    host: (key) => hosts.find((h) => h.dataset.panelSlot === key),
    section,
    sandbox,
    // Re-paint the SAME hosts, so a test can assert on what a second render
    // left behind (an optimistic hide that failed, say).
    rerender() {
      HP.render();
      return paintHosts(sandbox, hosts);
    },
  };
}

// The FIVE-COLUMN width, for the shape that only exists there (#968): the
// footer with its expand toggle, the four-row budget, expansion itself. The
// harness has no innerWidth, so the column count is injected the way the
// module actually reads it — through Home.currentCols() — which is also what
// the in-grid helpers below do. Without it, currentCols() falls back to the
// PHONE shape, which is the deliberately-safe default for an unknown width.
const AT_DESKTOP = { home: { currentCols: () => 5 } };

// ── formatReward ──────────────────────────────────────────────────

test('formatReward: organiser prose verbatim, a bare number gets "pts"', () => {
  const { HP } = makeHomePanels();
  assert.equal(HP.formatReward('1500'), '1500 pts');
  assert.equal(HP.formatReward('6,500'), '6,500 pts');
  assert.equal(HP.formatReward('300 pts'), '300 pts');
  assert.equal(HP.formatReward('Up to 6,500 pts'), 'Up to 6,500 pts');
  assert.equal(HP.formatReward('½ of your final credits'), '½ of your final credits');
  assert.equal(HP.formatReward('Unlocks future rewards'), 'Unlocks future rewards');
  assert.equal(HP.formatReward(null), '');
  assert.equal(HP.formatReward('  '), '');
});

// ── progressPercent ───────────────────────────────────────────────

test('progressPercent: clamped, and safe against a zero/NaN target', () => {
  const { HP } = makeHomePanels();
  assert.equal(HP.progressPercent(0, 8), 0);
  assert.equal(HP.progressPercent(3, 8), 38);
  assert.equal(HP.progressPercent(8, 8), 100);
  assert.equal(HP.progressPercent(99, 8), 100, 'never wider than the track');
  assert.equal(HP.progressPercent(3, 0), 0);
  assert.equal(HP.progressPercent(3, null), 0);
  assert.equal(HP.progressPercent(NaN, 8), 0);
  assert.equal(HP.progressPercent(-2, 8), 0);
});

// ── orderRows ─────────────────────────────────────────────────────

test('orderRows: not-done rows come first, stably', () => {
  const { HP } = makeHomePanels();
  const done = { done: true, current: null, target: null };
  const rows = [
    challenge({ id: 1, progress: done }),
    challenge({ id: 2 }),
    challenge({ id: 3, progress: done }),
    challenge({ id: 4 }),
  ];
  assert.deepEqual([...HP.orderRows(rows)].map((c) => c.id), [2, 4, 1, 3]);
  assert.deepEqual(rows.map((c) => c.id), [1, 2, 3, 4], 'input is not mutated');
});

// The tab's not-done key (_isDone) is the viewer's own progress on every card:
// the tab's public list carries it on every card now, and Home's rows always
// did. A row without progress falls back to the organiser's flag, as on the
// tab. This key used to read the organiser's flag outside First challenges, which
// is never set on an open challenge, so a card the viewer had finished kept
// its place (#2490).
test("orderRows: done is the viewer's own progress on every card, as on the tab", () => {
  const { HP } = makeHomePanels();
  const done = { done: true, current: null, target: null };
  assert.equal(HP.orderDone(challenge({ label: 'ONBOARDING', progress: done })), true);
  assert.equal(HP.orderDone(challenge({ label: 'WEEKLY', progress: done })), true,
    'a card the viewer finished sinks outside First challenges too');
  assert.equal(HP.orderDone(challenge({ label: 'WEEKLY', completed: true })), false,
    "the viewer's progress decides over the organiser flag when the row carries it");
  const bare = { id: 9, label: 'WEEKLY', completed: true };
  assert.equal(HP.orderDone(bare), true, 'a row without progress falls back to the organiser flag');
  assert.equal(HP.orderDone({ ...bare, completed: 'yes' }), false, 'only a real true');
  assert.equal(HP.orderDone(challenge({ progress: { done: 1 } })), false, 'only a real true');
  assert.equal(HP.orderDone(null), false);

  const rows = [
    challenge({ id: 1, label: 'WEEKLY', display_order: 0, progress: done }),
    challenge({ id: 2, label: 'WEEKLY', display_order: 1 }),
    challenge({ id: 3, label: 'ONBOARDING', display_order: 0, progress: done }),
    challenge({ id: 4, label: 'ONBOARDING', display_order: 1 }),
  ];
  assert.deepEqual([...HP.orderRows(rows)].map((c) => c.id), [4, 3, 2, 1],
    'every group sinks its finished card: First challenges, and This week too');
});

// S10 (owner decision, 2026-09-15): Home's block is the Challenges tab's list
// in the tab's order (TopochainChallenges._ordered). The group first, by the
// shared rank rule; then unfinished; then organiser-featured; then the tab's
// public list order, display_order then id.
test('orderRows: the Challenges tab order, group, unfinished, featured, then display order and id', () => {
  const { HP } = makeHomePanels();
  const done = { done: true, current: null, target: null };
  const rows = [
    challenge({ id: 7, label: 'COMMUNITY', display_order: 1 }),
    challenge({ id: 6, label: 'PERSISTENT', display_order: 5 }),
    challenge({ id: 5, label: 'PERSISTENT', display_order: 2, progress: done }),
    challenge({ id: 4, label: 'PERSISTENT', display_order: 9, featured: true }),
    challenge({ id: 3, label: 'WEEKLY', display_order: 3 }),
    challenge({ id: 2, label: 'WEEKLY', display_order: 3 }),
    challenge({ id: 1, label: 'ONBOARDING', display_order: 8 }),
  ];
  const ids = (list, onboarding) => [...HP.orderRows(list, onboarding)].map((c) => c.id);
  assert.deepEqual(ids(rows), [1, 2, 3, 4, 6, 5, 7],
    'First challenges unfinished leads; This week by display order then id; Always open lifts the '
    + 'featured card, then display order, then the finished card; Season challenges last');
  assert.deepEqual(ids(rows, { unlocked: true }), [2, 3, 4, 6, 5, 7, 1],
    'the gate says setup is finished: First challenges goes last');
  const allSetupDone = rows.map((c) => (c.id === 1 ? { ...c, progress: done } : c));
  assert.deepEqual(ids(allSetupDone), [2, 3, 4, 6, 5, 7, 1],
    'no summary: every setup card done finishes First challenges');
  assert.deepEqual(ids(allSetupDone, { unlocked: false }), [1, 2, 3, 4, 6, 5, 7],
    'a summary wins over the cards: still locked, still first');

  // A payload without display_order on every row (the staging demo, an old
  // cache) keeps the server's sequence for that last key.
  const noOrder = [
    challenge({ id: 9, label: 'WEEKLY' }),
    challenge({ id: 8, label: 'WEEKLY', display_order: 1 }),
  ];
  assert.deepEqual(ids(noOrder), [9, 8]);
});

test('the rank rule is named on HomePanels, as the tab names its own', () => {
  const { HP } = makeHomePanels();
  const G = HP.CHALLENGE_GROUPS;
  assert.deepEqual(
    [G.ONBOARDING, G.WEEKLY, G.PERSISTENT, HP.OTHER_GROUP].map((g) => g.key),
    ['setup', 'week', 'always', 'other'], 'the keys do not change');
  assert.deepEqual(
    [G.ONBOARDING, G.WEEKLY, G.PERSISTENT, HP.OTHER_GROUP].map((g) => g.heading),
    [undefined, undefined, undefined, undefined],
    'no headings: Home draws no group headers any more (the Semi design)');
  for (const [group, finished, want] of [
    [G.ONBOARDING, false, 0], [G.WEEKLY, false, 1], [G.PERSISTENT, false, 2], [HP.OTHER_GROUP, false, 3],
    [G.ONBOARDING, true, 4], [G.WEEKLY, true, 1], [G.PERSISTENT, true, 2], [HP.OTHER_GROUP, true, 3],
  ]) {
    assert.equal(HP.groupRankOf(group, finished), want, `${group.key}, finished ${finished}`);
  }

  const done = { done: true, current: null, target: null };
  const setupOpen = challenge({ id: 1, label: 'ONBOARDING' });
  const setupDone = challenge({ id: 2, label: 'ONBOARDING', progress: done });
  const week = challenge({ id: 3, label: 'WEEKLY', progress: done });
  assert.equal(HP.setupFinished([setupOpen], { unlocked: true }), true, 'the gate decides');
  assert.equal(HP.setupFinished([setupDone], { unlocked: false }), false);
  assert.equal(HP.setupFinished([setupDone], { unlocked: 'yes' }), false, 'only a real true');
  assert.equal(HP.setupFinished([setupDone, setupOpen]), false, 'no summary: one open setup card');
  assert.equal(HP.setupFinished([setupDone, week]), true, 'no summary: every setup card done');
  assert.equal(HP.setupFinished([week]), false, 'no setup card at all is not finished');
  assert.equal(HP.setupFinished(null), false);
});

// ── What the block holds, and what it is called (the Semi design) ─────
//
// 2026-10-16, owner-approved. The block is named by what it holds: "First
// challenges" while any First challenge (ONBOARDING) is unfinished, "Next
// challenges" (at most three, furthest along first) once they are done, and
// "Challenges" over one line when nothing is open. No season, no points
// total, no counts, no group headers and no deadline anywhere.

const DONE = { done: true, current: null, target: null };
const ids = (view) => [...view.rows].map((r) => r.id);

test('First challenges: every one of them while any is unfinished, done ones in place', () => {
  const { HP } = makeHomePanels({ slots: [] });
  const first = (id, over = {}) => challenge({ id, label: 'ONBOARDING', display_order: id, goal: `First ${id}`, ...over });
  const view = HP.challengesView(panel({
    challenges: [
      // The server's sequence is not the admin's: the view puts them back.
      first(3), first(1, { progress: DONE }), first(4), first(2, { progress: DONE }),
      challenge({ id: 5, label: 'WEEKLY', display_order: 5 }),
      challenge({ id: 6, label: 'PERSISTENT', display_order: 6 }),
    ],
  }));
  assert.equal(view.mode, 'first');
  assert.equal(view.heading, 'First challenges');
  assert.equal(view.seeAll, true);
  assert.equal(view.note, null);
  assert.deepEqual(ids(view), ['1', '2', '3', '4'],
    "the admin's order, the finished ones keeping their seats; nothing else yet");
  assert.deepEqual([...view.rows].map((r) => r.stateLabel), ['Done', 'Done', 'Not started', 'Not started']);

  // No display_order on every row (the staging demo, an older cache): the
  // server's sequence, still with the done ones in place.
  const noOrder = HP.challengesView(panel({
    challenges: [challenge({ id: 9, label: 'ONBOARDING', progress: DONE }), challenge({ id: 8, label: 'onboarding ' })],
  }));
  assert.deepEqual(ids(noOrder), ['9', '8']);

  // An older server's gate summary still decides, as on the tab.
  const gated = HP.challengesView(panel({
    onboarding: { unlocked: true },
    challenges: [first(1), challenge({ id: 5, label: 'WEEKLY' })],
  }));
  assert.equal(gated.mode, 'next', 'unlocked: past the First challenges');
  for (const gone of ['locked', 'lockedCount', 'lockedNames', 'onboardingNote', 'groups', 'season',
    'summary', 'total', 'allTotal', 'expandable', 'expanded']) {
    assert.equal(gone in view, false, `no ${gone} on the view`);
  }
  for (const gone of ['gettingStartedOnHome', 'lockedOnboarding']) {
    assert.equal(gone in HP, false, `HomePanels.${gone} went with the card`);
  }
});

test('Next challenges: at most three open ones, in the Challenges tab\'s order whatever the progress (polish N11)', () => {
  const { HP } = makeHomePanels({ slots: [] });
  assert.equal(HP.NEXT_SLOTS, 3);
  const counted = (id, current, target, over = {}) => challenge({
    id, display_order: id,
    metric: { kind: 'count', label: 'apps', target },
    progress: { done: false, current, target },
    ...over,
  });
  const view = HP.challengesView(panel({
    challenges: [
      challenge({ id: 1, label: 'ONBOARDING', display_order: 0, progress: DONE }),
      challenge({ id: 2, label: 'WEEKLY', display_order: 2 }),
      counted(3, 1, 4, { label: 'PERSISTENT' }),
      challenge({ id: 4, label: 'PERSISTENT', display_order: 4, earned_points: 50 }),
      counted(5, 2, 3, { label: 'COMMUNITY' }),
      counted(6, 0, 5, { label: 'WEEKLY' }),
      challenge({ id: 7, label: 'WEEKLY', display_order: 7, progress: DONE }),
      challenge({ id: 8, label: 'PERSISTENT', display_order: 8, open: false, earned_points: 10 }),
    ],
  }));
  assert.equal(view.mode, 'next');
  assert.equal(view.heading, 'Next challenges');
  assert.equal(view.seeAll, true);
  assert.deepEqual(ids(view), ['2', '6', '3'],
    'This week first, then Always open, in the tab\'s order; '
    + 'never a finished, a First or a not-open challenge');
  // Progress moving (the boot copy, then the fresh read) moves nothing.
  const later = HP.challengesView(panel({
    challenges: [
      challenge({ id: 1, label: 'ONBOARDING', display_order: 0, progress: DONE }),
      challenge({ id: 2, label: 'WEEKLY', display_order: 2 }),
      counted(3, 3, 4, { label: 'PERSISTENT' }),
      challenge({ id: 4, label: 'PERSISTENT', display_order: 4, earned_points: 50 }),
      counted(5, 2, 3, { label: 'COMMUNITY' }),
      counted(6, 4, 5, { label: 'WEEKLY' }),
      challenge({ id: 7, label: 'WEEKLY', display_order: 7, progress: DONE }),
      challenge({ id: 8, label: 'PERSISTENT', display_order: 8, open: false, earned_points: 10 }),
    ],
  }));
  assert.deepEqual(ids(later), ids(view), 'the same three, in the same places, after a step on two of them');

  // Ties keep the Challenges tab's order (orderRows): This week first.
  const fresh = HP.challengesView(panel({
    challenges: [
      challenge({ id: 1, label: 'COMMUNITY', display_order: 1 }),
      challenge({ id: 2, label: 'PERSISTENT', display_order: 2 }),
      challenge({ id: 3, label: 'WEEKLY', display_order: 3 }),
      challenge({ id: 4, label: 'PERSISTENT', display_order: 4 }),
    ],
  }));
  assert.deepEqual(ids(fresh), ['3', '2', '4'], 'nobody has started any: the tab\'s order, cut to three');

  const two = HP.challengesView(panel({ challenges: [challenge({ id: 1 }), challenge({ id: 2 })] }));
  assert.deepEqual(ids(two), ['1', '2'], 'fewer than three: all of them, no filler');
});

// #2490 still holds: a finished card never takes the place of one to do.
test("#2490: the block shows what is left to do, not This week's finished cards", () => {
  const { HP } = makeHomePanels({ slots: [] });
  const view = HP.challengesView(panel({
    onboarding: { total: 0, completed: 0, unlocked: true },
    challenges: [
      challenge({ id: 76, label: 'PERSISTENT', display_order: 2 }),
      challenge({ id: 77, label: 'PERSISTENT', display_order: 3 }),
      challenge({ id: 78, label: 'PERSISTENT', display_order: 4 }),
      challenge({ id: 79, label: 'WEEKLY', display_order: 5 }),
      challenge({ id: 74, label: 'ONBOARDING', display_order: 0, progress: DONE }),
      challenge({ id: 80, label: 'WEEKLY', display_order: 6, progress: DONE }),
      challenge({ id: 81, label: 'WEEKLY', display_order: 7, progress: DONE }),
    ],
  }));
  assert.deepEqual(ids(view), ['79', '76', '77'], 'three to do, and no finished card');
});

test('nothing open: "All done for this week" when the weekly ones are done', () => {
  const { HP } = makeHomePanels({ slots: [] });
  const view = HP.challengesView(panel({
    challenges: [
      challenge({ id: 1, label: 'ONBOARDING', progress: DONE }),
      challenge({ id: 2, label: 'WEEKLY', progress: DONE }),
      challenge({ id: 3, label: 'WEEKLY', progress: DONE }),
      challenge({ id: 4, label: 'weekly', progress: DONE }),
      challenge({ id: 5, label: 'PERSISTENT', progress: DONE }),
    ],
  }));
  assert.equal(view.mode, 'done');
  assert.equal(view.heading, 'Challenges');
  assert.equal(view.seeAll, true, 'the finished ones are still a tap away');
  assert.equal(view.rows.length, 0);
  assert.deepEqual({ ...view.note },
    { title: 'All done for this week', text: '3 challenges start again on Monday.' });
  const one = HP.challengesView(panel({ challenges: [challenge({ id: 2, label: 'WEEKLY', progress: DONE })] }));
  assert.equal(one.note.text, '1 challenge starts again on Monday.', 'the count is a plural pair');
  // A weekly challenge still open is something to do next, not "all done".
  const open = HP.challengesView(panel({
    challenges: [challenge({ id: 2, label: 'WEEKLY', progress: DONE }), challenge({ id: 3, label: 'WEEKLY' })],
  }));
  assert.equal(open.mode, 'next');
});

test('nothing open: "No challenges right now" otherwise, with no See all', () => {
  const { HP } = makeHomePanels({ slots: [] });
  for (const [why, challenges] of [
    ['nothing running', []],
    ['no list at all', undefined],
    ['everything done, none weekly', [challenge({ id: 1, label: 'PERSISTENT', progress: DONE })]],
    ['only a not-open challenge', [challenge({ id: 1, open: false })]],
  ]) {
    const view = HP.challengesView(panel({ total: 0, challenges }));
    assert.equal(view.mode, 'none', why);
    assert.equal(view.heading, 'Challenges', why);
    assert.equal(view.seeAll, false, `${why}: nothing behind a See all`);
    assert.deepEqual({ ...view.note }, { title: 'No challenges right now', text: 'New ones will show up here.' }, why);
  }
});

test('the block reads no season, no points total and no clock off the payload', () => {
  const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();
  const { HP } = makeHomePanels({ slots: [] });
  const view = HP.challengesView(panel({
    season: { id: 1, name: 'Season 1', ends_at: inHours(71) },
    total: 6, done: 2, all_total: 15, all_done: 4, points_total: 2000, points_earned: 1000,
    points_remaining: 3900,
    challenges: [
      challenge({ id: 1, label: 'ONBOARDING', ends_at: inHours(5) }),
      challenge({ id: 2, label: 'WEEKLY', ends_at: inHours(23) }),
    ],
  }));
  assert.equal(JSON.stringify(view).match(/\d+[dh] left|Season 1|2,000|3,900|of 15/), null,
    'nothing from the season, its points or its clocks reaches the view');
  for (const row of view.rows) {
    assert.equal('deadline' in row, false, 'a row carries no deadline');
    assert.equal('group' in row, false, 'and no group header key');
  }
  for (const gone of ['seasonView', 'summaryLine', 'timeLeft', 'endsOf', 'weekEnd', 'challengeGroups',
    'visibleSlots', 'toggleExpanded', 'ROW_SLOTS', 'DONE_GROUP', '_expanded']) {
    assert.equal(HP[gone], undefined, `HomePanels.${gone} is retired`);
  }
  assert.doesNotMatch(SRC, /params\.set\('expand'/, 'the fetch no longer asks for an expanded list');
});

// The three This week challenges count by the week, so a counted rail says
// so. A yes-or-no one keeps its words: there is no count to put a week on.
test('a This week challenge says "this week" on a counted rail, and only there', () => {
  const { HP } = makeHomePanels({ slots: [] });
  const weekly = (over) => HP.challengeRowView(challenge({ label: 'WEEKLY', ...over }));
  assert.equal(weekly({
    metric: { kind: 'count', label: 'apps tried', target: 3 },
    progress: { done: false, current: 2, target: 3 },
  }).stateLabel, '2/3 apps tried this week');
  assert.equal(weekly({
    metric: { kind: 'count', label: '', target: 3 },
    progress: { done: false, current: 0, target: 3 },
  }).stateLabel, '0/3 this week');
  assert.equal(weekly({}).stateLabel, 'Not started', 'yes-or-no: no invented count');
  assert.equal(weekly({ earned_points: 20 }).stateLabel, 'Started');
  assert.equal(weekly({ progress: DONE }).stateLabel, 'Done');
  assert.equal(HP.challengeRowView(challenge({
    label: 'PERSISTENT',
    metric: { kind: 'count', label: 'joined', target: 3 },
    progress: { done: false, current: 1, target: 3 },
  })).stateLabel, '1/3 joined', 'any other challenge counts as before');
});

// ── Rendering ─────────────────────────────────────────────────────

test('render: a yes-or-no challenge reads Not started on the shared rail, with no count', () => {
  // ONE CARD ON BOTH SURFACES. The block draws the Challenges tab's card, so a
  // challenge nobody has credited reads exactly what that tab says about it.
  const { html } = renderWith({ registry: [], hidden: [], panels: [panel()] });
  const card = cardOf(html);
  assert.match(card, /role="progressbar"/, 'every card has the rail, yes-or-no ones included');
  assert.match(card, /aria-valuetext="Not started"/);
  assert.match(card, /<span class="relative min-w-0 truncate">Not started<\/span>/);
  assert.doesNotMatch(card, />0\/1</, 'a yes-or-no challenge carries no count');
  assert.match(card, />250 pts</);
  assert.match(html, /Report a reproducible bug/);
});

test('render: a done row reads Done and says what the viewer earned', () => {
  // A finished card is drawn in First challenges, where the done ones keep
  // their seats while another is still to do.
  const p = panel({
    challenges: [challenge({
      label: 'ONBOARDING',
      progress: { done: true, current: null, target: null },
      earned_points: 250,
    }), challenge({ id: 2, label: 'ONBOARDING' })],
  });
  const card = firstCardOf(renderWith({ registry: [], hidden: [], panels: [p] }).html);
  assert.match(card, /data-challenge-state="done"/);
  assert.doesNotMatch(card, /role="progressbar"/, 'a finished card is one line, with no rail (#4563)');
  assert.match(card, /<span class="sr-only">Done<\/span>/, 'it still says Done to a screen reader');
  assert.match(card, /text-emerald-700 dark:text-emerald-400">250 pts<\/span>/,
    'and says what was earned in emerald ink');
  assert.match(card, />250 pts</, 'the chip says what was earned, not what is on offer');
  assert.doesNotMatch(card, /home-panel-glyph/, 'the old filled ✓ disc is retired');
});

test('render: a numeric row gets the count on the rail with truthful aria values', () => {
  const p = panel({
    challenges: [challenge({
      metric: { kind: 'count', label: 'Apps tested', target: 8 },
      progress: { done: false, current: 3, target: 8 },
    })],
  });
  const card = cardOf(renderWith({ registry: [], hidden: [], panels: [p] }).html);
  assert.match(card, /role="progressbar"/);
  assert.match(card, /aria-valuemin="0"/);
  assert.match(card, /aria-valuemax="100"/);
  assert.match(card, /aria-valuenow="38"/);
  assert.match(card, /aria-valuetext="3\/8 Apps tested"/, 'the spoken value is the visible count');
  assert.match(card, /aria-label="Report a reproducible bug: 3\/8 Apps tested"/);
  assert.match(card, /style="width:max\(0\.375rem, 38%\)"/, 'the fill is drawn at the same fraction');
  assert.match(card, />3\/8 Apps tested</);
});

test('render: a counted row at zero shows its count and a stub of bar, not Not started', () => {
  // Evan's "0/3" capsule: a challenge with steps reads as a track not yet
  // run, so it is told apart from a yes-or-no challenge before anyone starts.
  const p = panel({
    challenges: [challenge({
      metric: { kind: 'count', label: 'Kudos', target: 5 },
      progress: { done: false, current: 0, target: 5 },
    })],
  });
  const card = cardOf(renderWith({ registry: [], hidden: [], panels: [p] }).html);
  assert.match(card, /aria-valuetext="0\/5 Kudos"/);
  assert.match(card, /aria-valuenow="0"/);
  assert.match(card, /style="width:0\.375rem"/, 'the stub: a track with nothing run yet');
  assert.match(card, />0\/5 Kudos</, 'the count is shown from zero');
  assert.doesNotMatch(card, />Not started</);
});

// ── The bar's breathing room ──────────────────────────────────────
//
// The bar used to be centred-text-with-a-bar-jammed-underneath: half a
// pixel of line-box clearance above it, three pixels to the row divider
// below. The first fix was a LANE — a 14px strip reserved along the bottom of
// every row in the panel, which the text was padded clear of — because the
// height cap only had ~16px to give.
//
// The cap is gone (a section grows to its content), so the second fix is the
// one the first could not afford: a second LINE. The lane, its three tokens
// and the bar geometry derived from them are retired with it.

test('the retired pill, capsule and category well leave nothing behind', () => {
  // Stripped of comments: the note that replaced these rules names them.
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of ['.home-challenge-pill', '.home-challenge-meter', '--home-meter-floor',
    '.home-challenge-art', '.home-challenge-card {']) {
    assert.ok(!css.includes(rule), `app.css still declares ${rule}`);
  }
  const src = challengesSrc();
  for (const gone of ['home-challenge-pill', 'home-panel-glyph', 'home-challenge-art',
    'home-panel-bar-track', 'tintOf', 'title={row']) {
    assert.ok(!src.includes(gone), `challenges.tsx still carries ${gone}`);
  }
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'scripts/measure-meter-zero.mjs')),
    'the script that measured the capsule went with it');
});

test('a target of one is a yes-or-no on Home too: words, no count, no bar', () => {
  const { HP } = makeHomePanels({ slots: [] });
  const row = HP.challengeRowView(challenge({
    metric: { kind: 'count', label: 'Votes', target: 1 },
    progress: { done: false, current: 0, target: 1 },
  }));
  assert.equal(row.stateLabel, 'Not started');
  assert.equal(row.counted, false);
});

test('render: no season progress, no points total, no group header and no clock', () => {
  const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();
  const { html } = renderWith({
    registry: [], hidden: [],
    panels: [panel({
      season: { id: 1, name: 'Season 1', ends_at: inHours(71) },
      total: 6, done: 1, all_total: 6, all_done: 1, points_total: 2000, points_earned: 500,
      points_remaining: 1500,
      challenges: [
        challenge({ id: 1, label: 'ONBOARDING', ends_at: inHours(5) }),
        challenge({ id: 2, label: 'ONBOARDING', progress: DONE }),
        challenge({ id: 3, label: 'WEEKLY' }),
        challenge({ id: 4, label: 'PERSISTENT' }),
      ],
    })],
  });
  assert.doesNotMatch(html, /home-panel-season|role="meter"/, 'no season progress line or bar');
  assert.doesNotMatch(html, /Season 1|done in|1\/6|of 6/, 'no season name and no "N of M done"');
  assert.doesNotMatch(html, /2,000|1,500|pts left/, 'no points total');
  assert.doesNotMatch(html, /<h3/, 'no group headers');
  assert.doesNotMatch(html, /home-challenge-done-head|>This week<|>Always open<|>Season challenges<|>Done<\/span><\/div><\/h3>/);
  assert.doesNotMatch(html, /\d+[dh] left|no deadline/, 'no deadline or countdown anywhere');
  assert.equal((html.match(/data-challenge-id/g) || []).length, 2, 'the two First challenges, nothing else');
  const src = challengesSrc();
  assert.doesNotMatch(src, /from '\.\.\/\.\.\/leaderboard\/(group-header|season-progress)'/,
    'neither GroupHeader nor SeasonProgress is imported any more');
});

test('the lane is gone, and a row carries the rail instead of a meter', () => {
  // COMMENTS STRIPPED. The rules that replaced the lane explain it by name —
  // that is the point of them — so a raw grep would find the very tokens this
  // test exists to prove are gone. What must not come back is a DECLARATION.
  const css = read('public/css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /--home-panel-meter-lane/);
  assert.doesNotMatch(css, /--home-panel-bar-h/);
  assert.doesNotMatch(css, /--home-panel-bar-gap/);
  assert.doesNotMatch(css, /\.home-panel-rows--metered/);
  assert.doesNotMatch(css, /\.home-panel-bar-track \{/);
  assert.match(css, /--home-panel-row-h:\s*3\.5rem/);

  const { HP } = makeHomePanels({ slots: [] });
  const view = HP.challengesView(panel({
    challenges: [
      challenge({ id: 1 }),
      challenge({
        id: 2,
        metric: { kind: 'count', label: 'Kudos', target: 5 },
        progress: { done: false, current: 2, target: 5 },
      }),
    ],
  }));
  assert.equal(view.metered, undefined, 'the flag is retired, not merely unset');
  assert.ok(view.rows.every((r) => r.meter === undefined), 'no row carries the retired meter');
  const byId = (id) => view.rows.find((r) => r.id === id);
  assert.equal(byId('1').stateLabel, 'Not started');
  assert.equal(byId('2').stateLabel, '2/5 Kudos');
  assert.equal(byId('2').fill, 0.4);
});

test("a row carries the Challenges tab's rail descriptor", () => {
  const { HP } = makeHomePanels({ slots: [] });
  const pick = (r) => ({ state: r.state, stateLabel: r.stateLabel, fill: r.fill, earned: r.earned });
  assert.deepEqual(pick(HP.challengeRowView(challenge())),
    { state: 'new', stateLabel: 'Not started', fill: 0, earned: null });
  assert.deepEqual(pick(HP.challengeRowView(challenge({
    progress: { done: true, current: null, target: null }, earned_points: 250,
  }))), { state: 'done', stateLabel: 'Done', fill: 1, earned: '250 pts' });
  // Block production reads the viewer's snapshot count server-side, so the
  // board's own "180/500 blocks" is reachable here.
  assert.deepEqual(pick(HP.challengeRowView(challenge({
    metric: { kind: 'blocks_produced', label: 'blocks', target: 500 },
    progress: { done: false, current: 180, target: 500 },
  }))), { state: 'progress', stateLabel: '180/500 blocks', fill: 0.36, earned: null });
  const row = HP.challengeRowView(challenge({ reward: '1500', icon: ' 🐞 ' }));
  assert.equal(row.reward, '1500 pts', 'the same reward rule as the tab');
  assert.equal(row.icon, '🐞');
  assert.equal(row.illustration, null, 'no illustration on a row whose template names none');
  assert.equal(HP.challengeRowView(challenge({ illustration: 'useful-feedback' })).illustration, 'useful-feedback');
  for (const bad of ['../icons/x', 'Useful-Feedback', '', 7]) {
    assert.equal(HP.challengeRowView(challenge({ illustration: bad })).illustration, null,
      `${String(bad)}: the row carries a slug-shaped string or null, as the tab does`);
  }
  assert.equal(row.illustrationTone, null, 'no tone on a row whose template names no upload');
  assert.equal(HP.challengeRowView(challenge({ illustration_tone: 'teal' })).illustrationTone, 'teal');
  for (const bad of ['Teal', 'home-tone-teal', 'ab', '', 7, null]) {
    assert.equal(HP.challengeRowView(challenge({ illustration_tone: bad })).illustrationTone, null,
      `${String(bad)}: the row carries a tone-shaped word or null, as the tab does`);
  }
  assert.equal(row.task, undefined, 'no task on the row: the card is title and rail only');
  assert.equal(row.tip, undefined, 'and no tooltip field');
  assert.equal(row.label, undefined, 'no category: the tile never shows it');
});

test('a numeric challenge at full target is a finished line, not a count (#4563)', () => {
  const { html } = renderWith({
    registry: [], hidden: [],
    panels: [panel({
      challenges: [challenge({
        label: 'ONBOARDING',
        goal: 'Vote on five proposals',
        metric: { kind: 'count', label: 'Proposals voted', target: 5 },
        progress: { done: true, current: 5, target: 5 },
        earned_points: 900,
      }), challenge({ id: 2, label: 'ONBOARDING' })],
    })],
  });
  const card = firstCardOf(html);
  assert.match(card, /data-challenge-state="done"/);
  assert.doesNotMatch(card, /role="progressbar"/, 'no rail on a finished card');
  assert.match(card, /<span class="sr-only">Done<\/span>/);
  assert.match(card, /text-emerald-700 dark:text-emerald-400">900 pts</);
  assert.doesNotMatch(card, />5\/5</, "finished reads the tab's word, not a count");
});

test("Home draws the Challenges tab's card, not a card of its own", () => {
  const src = challengesSrc();
  assert.match(src, /import \{ ChallengeCard \} from '\.\.\/\.\.\/leaderboard\/challenge-card'/);
  assert.match(src, /<ChallengeCard[\s\S]*?className="home-challenge-card"/);
  const card = cardOf(renderWith({ registry: [], hidden: [], panels: [panel()] }).html);
  // S8: the card's corners are 24px and the tile's 11px, concentric inside
  // the card's 12px padding and 1px border.
  assert.match(card, /^home-challenge-card flex items-center gap-3 bg-white dark:bg-zinc-900 rounded-3xl/);
  assert.match(card, /h-20 w-20 [^"]*rounded-\[0\.6875rem\]"/, "the tab's 80px tile");
  assert.match(card, /data-challenge-id="1"/);
});

test('render: the card shows the kind icon and the title, never the task, the category or a CTA', () => {
  const p = panel({
    challenges: [challenge({
      label: 'COMMUNITY',
      icon: '🐞',
      task: 'Find and file a reproducible bug report.',
      cta: { label: 'Start', link: 'https://example.invalid/go' },
    })],
  });
  const { html } = renderWith({ registry: [], hidden: [], panels: [p] });
  const card = cardOf(html);
  assert.match(card, /<span class="text-\[2\.5rem\] leading-none">🐞<\/span>/, 'the kind icon sits in the tile');
  assert.doesNotMatch(card, />COMMUNITY</, 'the category never does ("ONBOARDI / NG" was the old well)');
  assert.doesNotMatch(card, /Find and file a reproducible bug report/,
    'no description on the card: the title and the rail are the whole card');
  assert.doesNotMatch(card, /\btitle="/, 'and no tooltip either: a phone has no hover');
  assert.doesNotMatch(card, /<a href=/, 'still no per-challenge Start button');
  assert.doesNotMatch(html, /example\.invalid/);
});

test('render: a registry illustration takes the kind icon’s place in the tile', () => {
  const withArt = (illustration) => cardOf(renderWith({
    registry: [], hidden: [],
    panels: [panel({ challenges: [challenge({ icon: '🐞', illustration })] })],
  }).html);
  const card = withArt('useful-feedback');
  assert.match(card, /<img src="\/illustrations\/challenges\/useful-feedback\.svg" alt="" width="64" height="64" decoding="sync" draggable="false" class="object-contain"\/>/,
    'the artwork, from the same-origin static path');
  assert.match(card, /home-tone-orange bg-\[var\(--tint-art\)\] dark:bg-\[var\(--tint-art\)\]/, 'on its pale tone');
  assert.doesNotMatch(card, /🐞/, 'in place of the kind icon');
  for (const slug of [null, 'not-in-the-registry']) {
    const plain = withArt(slug);
    assert.match(plain, /<span class="text-\[2\.5rem\] leading-none">🐞<\/span>/, `${slug}: the kind icon stays`);
    assert.doesNotMatch(plain, /<img/, `${slug}: and no artwork is guessed`);
  }

  // An admin upload: the path derived from the `u-` slug, on the payload tone,
  // or gray when the payload has none.
  const HEX = '00112233445566778899aabbccddeeff';
  const uploadedCard = (tone) => cardOf(renderWith({
    registry: [], hidden: [],
    panels: [panel({ challenges: [challenge({ icon: '🐞', illustration: `u-${HEX}`, illustration_tone: tone })] })],
  }).html);
  const onTone = uploadedCard('yellow');
  assert.ok(onTone.includes(`<img src="/challenge-illustrations/${HEX}" alt="" width="64" height="64" decoding="sync" draggable="false" class="object-contain"/>`),
    'the upload, from its derived path');
  assert.match(onTone, /home-tone-yellow bg-\[var\(--tint-art\)\] dark:bg-\[var\(--tint-art\)\]/, 'on the payload tone');
  assert.doesNotMatch(onTone, /🐞/, 'in place of the kind icon');
  assert.match(uploadedCard(undefined), /home-tone-gray bg-\[var\(--tint-art\)\]/, 'without a tone, on gray');
});

test('render: organiser text is escaped in text AND attribute contexts', () => {
  const p = panel({
    challenges: [challenge({
      goal: 'Break "out" of <it> & \'quote\'',
      metric: { kind: 'count', label: 'x', target: 4 },
      progress: { done: false, current: 1, target: 4 },
    })],
  });
  const { html } = renderWith({ registry: [], hidden: [], panels: [p] });
  // The CONTRACT is unchanged and still the point: a goal lands in text nodes
  // (the row's label), in `title="…"` and in `aria-label="…"`, so & < > alone
  // was never enough — an unescaped `"` would break out and inject attributes.
  // `HomePanels.esc` did it by hand; React does it by construction, and spells
  // the apostrophe `&#x27;` where esc() spelled it `&#39;`.
  assert.doesNotMatch(html, /aria-label="[^"]*"out"/, 'no raw quote inside an attribute');
  assert.match(html, /&quot;out&quot;/);
  assert.match(html, /&lt;it&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&#x27;quote&#x27;/);
  // …in the attribute as well as the text, which is the half a text-only
  // escape would pass.
  assert.match(html, /aria-label="[^"]*&quot;out&quot;[^"]*"/, 'the rail label is escaped');
});

// ── The heading names what the block holds, and carries "See all" ─────

// The Challenges section's heading; Discover's, which renders first, carries
// #home-browse-btn.
const headingOf = (html) => [...html.matchAll(/<h2 class="home-area-label[\s\S]*?<\/h2>/g)]
  .map((m) => m[0]).find((h) => !h.includes('home-browse-btn'));
const SEE_ALL = /<a href="#leaderboard\/challenges" class="home-panel-see-all [^"]*" aria-label="See all challenges"><span class="whitespace-nowrap">See all<\/span><\/a>/;

test('render: the heading says First, Next or Challenges, with See all beside it', () => {
  const heading = (challenges) => headingOf(renderWith({
    registry: [], hidden: [], panels: [panel({ challenges })],
  }).host('challenges').innerHTML);

  const first = heading([challenge({ id: 1, label: 'ONBOARDING' }), challenge({ id: 2, label: 'WEEKLY' })]);
  assert.match(first, /<span class="min-w-0 flex-1 truncate whitespace-nowrap[^"]*">First challenges<\/span>/);
  assert.match(first, SEE_ALL, 'a real link to the Challenges tab, at the right of the heading');

  const next = heading([challenge({ id: 1, label: 'ONBOARDING', progress: DONE }), challenge({ id: 2, label: 'WEEKLY' })]);
  assert.match(next, />Next challenges<\/span>/);
  assert.match(next, SEE_ALL);

  const allDone = heading([challenge({ id: 2, label: 'WEEKLY', progress: DONE })]);
  assert.match(allDone, />Challenges<\/span>/);
  assert.match(allDone, SEE_ALL, 'all done for this week: the finished ones are still a tap away');

  const none = heading([]);
  assert.match(none, />Challenges<\/span>/);
  assert.doesNotMatch(none, /home-panel-see-all|See all/, 'No challenges right now: no See all');
});

test('render: See all replaces "Open challenges" and the in-place toggle', () => {
  const five = Array.from({ length: 5 }, (_, i) => challenge({ id: i + 1 }));
  const { html } = renderWith({ registry: [], hidden: [], panels: [panel({ total: 8, all_total: 9, challenges: five })] });
  assert.equal((html.match(/data-challenge-id/g) || []).length, 3, 'three Next challenges, whatever the season holds');
  assert.match(html, /data-rows="3"/, 'data-rows reports what is DRAWN');
  assert.equal((html.match(/home-panel-see-all/g) || []).length, 1, 'one way out, in the heading');
  assert.doesNotMatch(html, /home-panel-lb-browse|Open challenges/, '"Open challenges" is gone');
  assert.doesNotMatch(html, /home-panel-footer|home-panel-expand|home-panel--expanded|See all \d|Show less|aria-expanded/,
    'and so is the footer with its expand toggle');
  const [, ui] = PANEL_SOURCES.find(([n]) => n.endsWith('ui.tsx'));
  assert.doesNotMatch(ui, /export function (LeaderboardLink|PanelFooter)\b/);
  assert.doesNotMatch(ui, /ChevronDownIcon/, 'the toggle\'s chevron went with it');
});

// Prerender safety: the section is prerendered with no view, and the first
// client render must agree with that document. The heading's element is the
// same in every state; before a view exists it holds "Challenges" invisible
// (#10: the words used to switch to "Next challenges" as the view landed)
// with no link, which is what the prerender holds too. The skeleton under it
// is tests/home-first-paint.test.js's.
test('the heading is the prerender\'s own until the data lands', () => {
  const mod = loadTsx(SECTIONS);
  const before = renderToHtml(createElement(mod.ChallengesSectionView, { painted: false, discover: null, challenges: null }));
  assert.match(before, /^<section id="home-challenges-section" data-panel-slot="challenges" class="home-section-pending px-3 pb-3">/,
    'not hidden before the first paint');
  assert.match(headingOf(before), /><span class="invisible">Challenges<\/span><\/span><\/h2>$/,
    'the constant label, its words held, and no link');
  assert.doesNotMatch(before, /home-panel-see-all|<article/);
  const [, sections] = PANEL_SOURCES.find(([n]) => n.endsWith('sections.tsx'));
  assert.match(sections,
    /label=\{challenges \? challenges\.heading : t\('home:challenges\.heading'\)\}\s*action=\{challenges\?\.seeAll \? <SeeAllLink \/> : null\}/,
    'the content-named heading and its link follow the view, and fall back to the prerender\'s values');
  assert.equal(message('home:challenges.heading'), 'Challenges');
});

// #4635 (evan): no Getting started card on top of Home; a new account's First
// challenges are ordinary `.home-challenge-card`s in this block. The Semi
// design names the block by them while any is unfinished.
test('a new account\'s First challenges are .home-challenge-card under "First challenges", never locked', () => {
  const first = (id, over = {}) => challenge({ id, label: 'ONBOARDING', display_order: id, goal: `First ${id}`, ...over });
  const p = panel({
    total: 6, done: 1, all_total: 6, all_done: 1,
    // What a server before #4635 sent a new account. It changes nothing now.
    onboarding: { total: 4, completed: 1, unlocked: false, event_id: 1, hidden_count: 2,
      hidden_names: ['Make your first proposal', 'Invite a friend'] },
    challenges: [
      first(1, { progress: DONE }), first(2), first(3), first(4),
      challenge({ id: 5, label: 'WEEKLY', display_order: 5 }),
      challenge({ id: 6, label: 'PERSISTENT', display_order: 6 }),
    ],
  });
  const { html } = renderWith({ registry: [], hidden: [], panels: [p] });
  assert.doesNotMatch(html, /home-challenge-locked/, 'no locked placeholder');
  assert.doesNotMatch(html, /Getting started/, 'the words are gone from Home');
  assert.doesNotMatch(html, /unlock/i, 'nothing is locked, so nothing unlocks');
  assert.match(headingOf(html), />First challenges<\/span>/);
  const ids = [...html.matchAll(/home-challenge-card[^>]*data-challenge-id="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['1', '2', '3', '4'], 'all four, in the admin\'s order, the done one in place');
  assert.match(html, /data-rows="4"/, 'real cards, counted as such');
  // Tapping one opens it on the Challenges tab like any other card.
  assert.match(challengesSrc(), /onClick=\{\(\) => panels\(\)\?\.goToChallenge\?\.\(row\.eventId, row\.id\)\}/);
  assert.doesNotMatch(challengesSrc(), /LockedChallengesCard|onboardingNote|view\.locked/);
});

// The area LABEL is the section's own, not the block's (see SectionHeading in
// panels/ui.tsx), so it is always in the host's markup — what "nothing at all"
// means is that no BLOCK is drawn and the host carries `hidden`, which takes
// the label down with it. Anything else here would be a label over a gap.
const blocksOf = (html) => html.replace(/<h2 class="home-area-label[\s\S]*?<\/h2>/g, '');

test('render: nothing at all when signed out or unloaded', () => {
  // Signed out. Every host stays blockless AND hidden — an empty <section>
  // with its px-3 pb-3 padding would still be a gap in the stack.
  const out = renderWith({ registry: [], hidden: [], panels: [panel()] },
    { user: null });
  assert.equal(blocksOf(out.html), '');
  for (const host of out.hosts) {
    assert.ok(host._classes.has('hidden'), `${host.dataset.panelSlot} host hidden`);
  }

  // Data not loaded yet: no block, and not hidden either. The section holds
  // its skeleton at the height this device last drew it (#10,
  // tests/home-first-paint.test.js): hiding it and showing it again when the
  // data landed was the jump.
  const unloaded = renderWith(null);
  assert.doesNotMatch(unloaded.html, /<article/);
  for (const host of unloaded.hosts) {
    assert.ok(!host._classes.has('hidden'), `${host.dataset.panelSlot} host not hidden while it waits`);
  }

  // Answered with nothing (a failed read keeps no copy): absent and hidden.
  const failed = renderWith(null);
  failed.HP._answered = true;
  failed.rerender();
  assert.equal(blocksOf(failed.rerender()), '');
  for (const host of failed.hosts) {
    assert.ok(host._classes.has('hidden'), `${host.dataset.panelSlot} host hidden once the read failed`);
  }

});

// #947 reversed the admin-only empty box: every viewer gets the block, and
// with nothing open it says why in ONE line, a card with a title and a
// sentence (the Semi design). A block that silently vanished would leave the
// viewer unable to tell "nothing to do" from "this broke".
test('render: the one-line card renders for EVERY viewer, with no footer', () => {
  const empty = panel({ total: 0, done: 0, challenges: [] });
  for (const isAdmin of [false, true]) {
    const out = renderWith({ registry: [], hidden: [], panels: [empty] },
      { user: { id: 1, isAdmin } });
    const who = isAdmin ? 'admin' : 'member';
    assert.match(out.html,
      /<div class="home-panel-rows home-panel-row home-challenges-note [^"]*"><p class="truncate text-\[15px\] font-\[650\][^"]*">No challenges right now<\/p><p class="truncate text-\[13px\][^"]*text-zinc-500[^"]*">New ones will show up here\.<\/p><\/div>/,
      `${who}: the block says why it is quiet, 15 over 13`);
    assert.ok(!out.host('challenges')._classes.has('hidden'), `${who}: section shown`);
    assert.equal((out.html.match(/home-panel-row\b/g) || []).length, 1, `${who}: one line`);
    assert.doesNotMatch(out.html, /home-panel-footer/, `${who}: no footer`);
    assert.match(out.html, /home-area-label[^"]*flex items-center/, `${who}: the heading is a row`);
    assert.match(out.html, /min-w-0 flex-1 truncate[^>]*>Challenges/, `${who}: the label takes it`);
    assert.match(out.html, /data-rows="0"/, `${who}: stamped`);
    assert.doesNotMatch(out.host('challenges').innerHTML, /<button|<a /, `${who}: a statement, and no link`);
  }
  const allDone = renderWith({
    registry: [], hidden: [],
    panels: [panel({ challenges: [1, 2, 3].map((id) => challenge({ id, label: 'WEEKLY', progress: DONE })) })],
  }).html;
  assert.match(allDone, />All done for this week<\/p><p[^>]*>3 challenges start again on Monday\.<\/p>/);
  assert.match(allDone, /data-rows="0"/);
  assert.doesNotMatch(allDone, /data-challenge-id/, 'one line, no cards');
});

test('render: stale hidden metadata cannot suppress fixed sections (#1801)', () => {
  const registry = [
    { key: 'challenges', title: 'Challenges' },
    { key: 'discover', title: 'Discover' },
    { key: 'create', title: 'Create app' },
  ];
  // An old server omitted hidden panels from its payload. The new client
  // still renders their empty/marker state rather than removing the sections.
  // (The registry's `create` marker rides along and is simply not asked for:
  // Create is the launcher grid's trailing tile now, not a panel.)
  for (const panels of [[], [panel()]]) {
    const out = renderWith({ registry, hidden: ['challenges', 'create'], panels },
      { home: { canCreate: () => false } });
    for (const key of ['challenges', 'discover']) {
      assert.ok(!out.host(key)._classes.has('hidden'), `${key} remains visible`);
      assert.match(out.host(key).innerHTML, new RegExp(`data-panel="${key}"`));
    }
    assert.match(out.host('challenges').innerHTML,
      panels.length ? /Report a reproducible bug/ : /No challenges right now/);
    assert.doesNotMatch(out.html, /data-create-enabled/, 'no create block among the panels');
  }
});

// ── A new account sees Challenges (2026-10-05) ────────────────────
//
// #3847 hid this block for an account's first seven days (`firstWeek` on
// GET /api/auth/me). Evan reversed it after his own first session: a
// brand-new account expected Challenges on Home, with its First challenges.
// Since #4635 there is no Getting started card for any account, so the block
// draws those challenges itself for every one of them, and never a locked
// card in their place.

const NEW_ACCOUNT_DATA = () => ({
  registry: [{ key: 'challenges', title: 'Challenges' }, { key: 'discover', title: 'Discover' }],
  hidden: [],
  panels: [panel({
    total: 2,
    onboarding: { total: 2, completed: 1, unlocked: false, event_id: 1, hidden_count: 6, hidden_names: ['Make your first proposal'] },
    challenges: [
      challenge({ id: 1, goal: 'Join a community', label: 'ONBOARDING', display_order: 0, progress: { done: true, current: null, target: null } }),
      challenge({ id: 2, goal: 'Try an app', label: 'ONBOARDING', display_order: 1 }),
    ],
  })],
});

test('a brand-new account sees Challenges, whatever its age, with its First challenges', () => {
  // A cached session that still says `showGettingStarted: true` (from before
  // #4635) changes nothing: there is no card to defer to.
  for (const user of [{ id: 7, isAdmin: false, firstWeek: true }, { id: 7, isAdmin: false },
    { id: 7, showGettingStarted: false }, { id: 7, showGettingStarted: true }]) {
    const out = renderWith(NEW_ACCOUNT_DATA(), { user });
    const host = out.host('challenges');
    assert.ok(!host._classes.has('hidden'), `shown for ${JSON.stringify(user)}`);
    assert.match(host.innerHTML, /home-challenge-card[\s\S]*Try an app/, 'the First challenges, drawn in the block');
    assert.match(host.innerHTML, /Join a community/, 'done ones under Done');
    assert.doesNotMatch(host.innerHTML, /home-challenge-locked/, `no locked card for ${JSON.stringify(user)}`);
    assert.doesNotMatch(host.innerHTML, /Getting started/, 'and no gate line under them');
  }
});

test('nothing about an account\'s age hides the block, and /api/auth/me says nothing about it', () => {
  assert.doesNotMatch(PANELS_RAW, /inFirstWeek|firstWeek ===/);
  assert.match(PANELS_RAW, /challenges: viewFor\('challenges', HomePanels\.challengesView\),/);
  // Nor does the session: the block no longer asks whether a Getting started
  // card is on Home (#4635), so it has no repaint to wait for when the
  // verified session lands.
  assert.doesNotMatch(PANELS_RAW, /showGettingStarted|gettingStartedOnHome|lockedOnboarding/);
  assert.doesNotMatch(PANELS_RAW, /addEventListener\('sv:session'/);
  const auth = read('src/routes/auth.js');
  assert.doesNotMatch(auth, /first_week|firstWeek/);
  assert.doesNotMatch(auth, /showGettingStarted|show_getting_started/);
});

// ── Container shape: one bordered block PER SECTION ───────────────
//
// The core of the per-block-container requirement: each area is its own
// bordered article in its own host, never rows inside one shared card. THE UI
// OVERHAUL is what made them all renderable at once — before it, only
// `challenges` built a payload, so the multi-block case had to be staged with
// a hypothetical second widget.

test('render: each panel is its own bordered article, in its own host', () => {
  const all = {
    registry: [
      { key: 'discover', title: 'Discover', removable: false },
      { key: 'challenges', title: 'Challenges', removable: true },
      { key: 'create', title: 'Create app', removable: true },
    ],
    hidden: [],
    panels: [
      panel(),
      // A key no renderer knows. renderPanel dispatches on key, so an unknown
      // one renders nothing rather than throwing — that's the degradation
      // path when the server ships a panel the client predates. It also has
      // no host of its own, which is the second half of the same guard.
      { key: 'future-widget', title: 'Rank', total: 1, done: 0, challenges: [] },
    ],
  };
  const out = renderWith(all, { home: { canCreate: () => true } });
  assert.doesNotMatch(out.html, /Rank/, 'an unknown panel key is skipped, not thrown on');

  // Every host draws, and each draws exactly ONE block — never one shared
  // card, never two stacked in the same section. Each is an <article> under
  // its own section label; what they sit ON now differs by block (see
  // PanelShell's `plate`), so this counts the article and not its plate:
  // Discover and Challenges have none at all, because their cards are the
  // surface.
  for (const key of ['discover', 'challenges']) {
    const host = out.host(key);
    assert.equal((host.innerHTML.match(/<article class="home-panel[ "]/g) || []).length, 1,
      `${key}: one block`);
    assert.equal((host.innerHTML.match(/home-area-label/g) || []).length, 1,
      `${key}: its OWN label row`);
    assert.ok(!host._classes.has('hidden'), `${key}: shown`);
  }
  // The registry's `create` marker builds nothing here: Create is the
  // launcher grid's trailing tile (tests/home-create-tile.test.js).
  assert.doesNotMatch(out.html, /home-create/, 'no create block among the panels');

  // Siblings, in the ORDER the sections are declared in — the whole point of
  // the fixed stack. Discover, then Challenges.
  assert.deepEqual(out.hosts.map((h) => h.dataset.panelSlot),
    ['discover', 'challenges']);
  assert.equal((out.html.match(/<article/g) || []).length, 2);
  const first = out.html.indexOf('</article>');
  const second = out.html.indexOf('<article', first);
  assert.ok(first > 0 && second > first, 'blocks are siblings, not nested');

  // No stack WRAPPER: each block is a direct child of its own <section>, so
  // there is nothing left for a space-y-2 to space.
  assert.doesNotMatch(out.html, /class="space-y-2"/);
});

// ── Strictly one line per row ──────────────────────────────────────
//
// The row is a FIXED height, which means a wrap is invisible in a
// screenshot: the second line overflows the box and gets clipped by the
// panel. So the constraint has to be pinned in the markup, not eyeballed.
// Every text node in a row is either `truncate` (which carries
// white-space: nowrap) or explicitly `whitespace-nowrap`, and the row
// itself declares nowrap so future children inherit it.

test('every text node in a row is single-line — no wrapping anywhere', () => {
  const p = panel({
    total: 9,
    challenges: [challenge({
      // Real production strings: multi-word goal AND multi-word prose
      // reward, the combination that wraps first.
      goal: 'Produce Every Block - June 2026',
      reward: 'Up to 6,500 pts',
      metric: { kind: 'count', label: 'Blocks produced', target: 720 },
      progress: { done: false, current: 543, target: 720 },
    })],
  });
  const { html } = renderWith({ registry: [], hidden: [], panels: [p] });

  // Every text-bearing element on the card opts out of wrapping: the title,
  // the meta line's reward and the rail's label. Nothing on the card wraps,
  // not even as a row: the reward rides the meta line and the rail is alone.
  const card = cardOf(html);
  assert.match(card, /class="[^"]*\btruncate\b[^"]*">Produce Every Block - June 2026</, 'the goal truncates');
  assert.doesNotMatch(card, /<p /, 'and there is no task line to wrap');
  assert.match(card, /<span class="relative min-w-0 truncate">543\/720 Blocks produced<\/span>/, 'the rail label truncates');
  assert.match(card, /class="[^"]*\btruncate\b[^"]*">Up to 6,500 pts</, 'the reward truncates');
  assert.doesNotMatch(card, /flex-wrap/, 'and no row on the card wraps');
});

test('the heading and its link are single-line too', () => {
  const data = {
    registry: [], hidden: [],
    panels: [panel({ total: 9, done: 2, points_remaining: 24300 })],
  };
  const { html } = renderWith(data);
  // The heading is the block's NAME and its one link. No counter rides it
  // (the season progress and its points are gone from Home altogether), and
  // the name truncates rather than wraps beside the link on a 320px phone.
  const heading = headingOf(html);
  assert.match(heading, /min-w-0 flex-1 truncate whitespace-nowrap[^"]*">Next challenges<\/span>/);
  assert.doesNotMatch(heading, /24,300|2 of 9| · /, 'no counter appended to the label');
  assert.match(heading, /home-panel-see-all shrink-0[^"]*whitespace-nowrap/, 'the link never shrinks or wraps');
  assert.match(heading, /<span class="whitespace-nowrap">See all<\/span><\/a>/, 'and has no chevron, as Discover\'s See all has none');
});

test('the row declares nowrap and clips, so a wrap cannot ship unnoticed', () => {
  const css = read('public/css/app.css');
  const rowRule = css.match(/\.home-panel-row \{[^}]*\}/)[0];
  assert.match(rowRule, /white-space:\s*nowrap/,
    'declared on the row so every child inherits it');
  assert.match(rowRule, /overflow:\s*hidden/,
    'a chip that still overflows is clipped, not spilled onto the next row');
});

// ── The placement is gone ─────────────────────────────────────────
//
// Each block used to be a real item of #app-list: a multi-cell tile the
// viewer could drop anywhere on the launcher canvas, with a per-breakpoint
// footprint table and a persisted cell. THE UI OVERHAUL replaced all of it
// with three fixed sections in a fixed order — so what these pin is that the
// machinery is really gone, on both sides, rather than left half-wired.

test('the placement membership API is gone from the module', () => {
  const { HP } = makeHomePanels();
  HP._data = {
    registry: [
      { key: 'challenges', title: 'Challenges', removable: true },
      { key: 'discover', title: 'Discover', removable: false },
      { key: 'create', title: 'Create app', removable: true },
    ],
    hidden: [],
    panels: [panel()],
  };
  // `gridSlotKeys()` answered "which widgets does HomeLayout have to place
  // for this viewer", and `hasLayoutRegistry()` told home.js the footprints
  // had arrived so a derived layout was safe to persist. Nothing is placed
  // now and nothing waits on a registry, so both are dead weight — as is
  // `renderAll()`, which joined the blocks into the retired #home-panels
  // stack, and `setPosition()`, which wrote a widget's cell.
  for (const dead of ['gridSlotKeys', 'hasLayoutRegistry', 'setPosition', 'renderAll']) {
    assert.equal(typeof HP[dead], 'undefined', `${dead} should be gone`);
  }
  // The registry itself STAYS — it is still what says a block exists at all,
  // which is how the marker blocks (`discover`, `create`, which build no
  // payload) render.
  assert.ok(HP.panelFor('discover'), 'the registry still makes a marker renderable');
});

// The create entry is on EVERY home screen, and quota decides its treatment,
// never whether it exists — the regression guard for the old "absent for
// non-creators" behaviour now lives with the tile, in
// tests/home-create-tile.test.js.
test('the panels no longer build a create block, whatever the quota', () => {
  // Create is the launcher grid's trailing tile now (the prototype's
  // scrHome), placed and painted with the app tiles — tests/home-create-tile
  // .test.js pins that it is there for every account. What is left to pin
  // here is the other half: the server registry's `create` marker, which a
  // cached older shell still renders its section from, draws nothing in this
  // module, so the page can never carry two Create entries.
  for (const canCreateApps of [true, false]) {
    const out = renderWith(
      { registry: [{ key: 'create', title: 'Create app', removable: true }],
        hidden: [], panels: [] },
      { home: { canCreate: () => canCreateApps, CREATE_DISABLED_HINT: 'hint' } });
    assert.doesNotMatch(out.html, /data-create-enabled|home-create/,
      `quota=${canCreateApps}: no create block among the panels`);
    const state = out.sandbox.panelsStore.get();
    assert.equal('create' in state, false, 'and no create field in the model');
  }
  // Nothing in the server registry may consult a viewer's quota either.
  const registrySrc = ROUTE.match(/const PANEL_REGISTRY = \[[\s\S]*?\n\];/)[0];
  assert.doesNotMatch(registrySrc, /canCreateApps|app_quota|quota/i,
    'the registry takes no viewer argument — presence is never permission-gated');
});

// A fixed section still renders when an old response omits its payload.
test('panelFor prefers a built payload and falls back to the registry', () => {
  const { HP } = makeHomePanels();
  HP._data = {
    registry: [
      { key: 'challenges', title: 'Challenges', removable: true },
      { key: 'create', title: 'Create app', removable: true },
    ],
    hidden: ['challenges'],
    panels: [],
  };
  assert.equal(HP.panelFor('challenges').title, 'Challenges', 'legacy hidden metadata is ignored');
  assert.equal(HP.panelFor('create').title, 'Create app', 'marker widget still renders');
  assert.equal(HP.panelFor('nope'), null, 'unknown key renders nothing');
});

test('home.js places every item at an explicit cell, with no flow fallback', () => {
  // Placement is DATA now: home.js hands each item a `{col,row,w,h}` and
  // app-grid.tsx spells the cell. `overflow` is the one case with no cell —
  // items past the 8-row canvas flow, rather than being stranded.
  assert.match(HOME, /const placement = overflow \? null : \{ col: item\.col, row: item\.row, w, h \}/);

  // The cell is written as an ATTRIBUTE, and that is load-bearing. React sets
  // styles through the CSSOM one longhand at a time, and `grid-column` +
  // `grid-row` together cover all four longhands of `grid-area` — so the
  // browser re-serializes the block as the SHORTHAND and the text `grid-row`
  // vanishes from the attribute. dapp.json's declared check for placed tiles
  // selects on `.app-card[data-yours="true"][style*="grid-row"]`, so a
  // `style` prop would break it invisibly: the tiles land in the right cells
  // and the check reports "selector not found".
  const GRID_TSX = fs.readFileSync(path.join(
    __dirname, '..', 'frontend', 'src', 'features', 'home', 'app-grid.tsx'), 'utf8');
  assert.match(GRID_TSX, /grid-column:\$\{p\.col \+ 1\}\/span \$\{p\.w\};grid-row:\$\{p\.row \+ 1\}\/span \$\{p\.h\}/);
  assert.match(GRID_TSX, /el\.setAttribute\('style', style\)/);
  assert.doesNotMatch(GRID_TSX, /style=\{style\}/,
    'the style prop would go back through the CSSOM and fold the shorthand');
  const check = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8')).tests || [])
    .find((t) => /\[style\*="grid-row"\]/.test(t.expectSelector || ''));
  assert.ok(check, 'and the declared check that depends on it is still there');
  // ONE layout array, and it is app tiles all the way down now.
  assert.match(HOME, /HomeLayout\.canvasItems\(layout\)/);
  assert.match(HOME, /HomeLayout\.overflowItems\(layout\)/);
  // The widget HOST the renderer used to plant in a cell is gone — the three
  // sections are in the shell's own markup, outside #app-list.
  assert.doesNotMatch(HOME, /data-panel-slot="\$\{escapeHtml\(item\.key\)\}"/);
  // Class-shaped, not the bare name: the comment explaining what the branch
  // used to resolve is the one mention that should survive.
  assert.doesNotMatch(HOME, /class="home-panel-slot|'\.home-panel-slot'/);
});

test('the placement recognizer owns the grid, and the flow reorder is gone', () => {
  assert.match(HOME, /unNative\.attachGridPlacement\(listEl, \{/);
  // App tiles ALONE are draggable now: a fixed section has no cell to move
  // to, and `.home-panel-slot` went with the hosts that carried it.
  assert.match(HOME, /itemSelector: '\.app-card\[data-yours\]:not\(\[data-demo\]\)'/);
  assert.doesNotMatch(HOME, /data-create-enabled[^\n]*itemSelector/);
  // The flow model and its persistence are gone in their entirety. Matched
  // as DEFINITIONS / call sites rather than as bare names, so the comments
  // that explain why each was removed don't trip the guard.
  for (const dead of [
    /unNative\.attachReorder\(listEl/,
    /^  _onKitCardDrop\(/m,
    /^  classifyCardDrop\(/m,
    /^  buildYoursOrder\(/m,
    /^  _syncPanelSlotPosition\(/m,
    /^  _onCardPointerDown\(/m,
    /fetch\('\/api\/favorites\/order'/,
    /HomePanels\?\.setPosition/,
    // …and the widget half of the placement, retired by THE UI OVERHAUL.
    /HomePanels\?\.gridSlotKeys/,
    /HomePanels\?\.hasLayoutRegistry/,
  ]) {
    assert.doesNotMatch(HOME, dead, `${dead} should be gone from home.js`);
  }
});

test('a drop writes the whole width through PUT /api/home-layout', () => {
  const place = HOME.match(/_onGridPlace\(el, cell, cols\) \{[\s\S]*?\n {2}\},/)[0];
  assert.match(place, /HomeLayout\.place\(/);
  assert.match(place, /if \(!next\) return;/, 'an illegal drop persists nothing');
  assert.match(place, /_rerenderPending = true/, 'repaint is deferred to onSettle');
  assert.match(place, /_persistLayout\(cols, next\)/);
  const persist = HOME.match(/async _persistLayout\(cols, layout\) \{[\s\S]*?\n {2}\},/)[0];
  assert.match(persist, /'\/api\/home-layout'/);
  assert.match(persist, /method: 'PUT'/);
  assert.match(persist, /HomeLayout\.toWire\(layout\)/);
  // A failed write reverts to server truth rather than leaving the grid
  // showing an arrangement that was never saved.
  assert.match(persist, /_ensureLayoutLoaded\(\{ force: true \}\)/);
});

// A derivation is not a claim: visiting at a width you have never dragged at
// must not silently write a layout for it, or a phone visit would overwrite
// the arrangement the viewer made on their laptop.
test('only a stored layout is repaired in place; a derivation is not persisted', () => {
  const cur = HOME.match(/currentLayout\(cols\) \{[\s\S]*?\n {2}\},/)[0];
  // A pre-overhaul DESKTOP arrangement lived under '5'. Seeding from it is
  // what stops four columns everywhere reading as "my home screen was reset".
  assert.match(cur, /Home\._layouts\['5'\]/, 'the retired 5-column width seeds it');
  assert.match(cur, /HomeLayout\.deriveDefault\(/, 'reading order is the last resort');
  // The `widgetsReady` gate went with the widgets: it existed because a
  // layout load that beat /api/home-panels saw an empty widget list and would
  // have persisted a repair erasing the viewer's widget cells. Nothing on the
  // canvas depends on a second endpoint any more.
  assert.doesNotMatch(cur, /const widgetsReady|hasLayoutRegistry\?\.\(\)/);
  assert.match(cur, /if \(changed && Array\.isArray\(stored\) && stored\.length\)/,
    'only a stored width is repaired in place');
});

test('the drag overlay draws the whole canvas and doubles as the hit-test', () => {
  const show = HOME.match(/_showGridOverlay\(listEl, cols, liftedEl\) \{[\s\S]*?\n {2}\},/)[0];
  assert.match(show, /HomeLayout\.MAX_ROWS/, 'every row of the canvas, not just the used ones');
  assert.match(show, /data-cell="\$\{col\},\$\{row\}"/);
  // The cells ARE the hit-test surface — that is why the overlay is real DOM.
  assert.match(HOME, /closest\('\[data-cell\]'\)/);
  // The layer never eats taps; the cells re-enable them.
  assert.match(CSS, /\.home-grid-overlay \{[^}]*pointer-events: none/);
  assert.match(CSS, /\.home-grid-cell \{[^}]*pointer-events: auto/);
  // Tiles paint above it. App tiles ALONE, since THE UI OVERHAUL: the widget
  // hosts that shared these two selectors are fixed sections outside the grid.
  assert.match(CSS, /#app-list > \.app-card \{[^}]*z-index: 1/);

  // ...and are TRANSPARENT TO HIT-TESTING for the duration of a lift. This is
  // the regression guard for the bug that made occupied cells undroppable:
  // the overlay's cells sit below the tiles, so with tiles still taking
  // pointer events elementFromPoint returned a TILE for every occupied cell,
  // cellFromPoint returned null, and both "drop onto another app" and "move a
  // widget over its own footprint" silently sprang back.
  assert.match(CSS,
    /#app-list\.un-reordering > \.app-card \{[^}]*pointer-events: none/);
  // The gap between cells belongs to no cell, so each one's hit area bleeds
  // into it — otherwise a pointer resting on a seam resolves to nothing.
  assert.match(CSS, /\.home-grid-cell::before \{[^}]*inset: -4px/);
});

// #4738 capped the My apps area at 48rem and centred it so a few apps
// grouped closer on a wide window; #4861 removed the cap — the narrower
// block read as odder than wide spacing, sitting inside the width of the
// search bar above and the sections below (evan). The overlay — inside
// #app-list, inset by the same padding, sized by the same engine — was
// never touched by either, and still lines up with zero arithmetic.
test('the My apps area spans the full home column on wide windows, overlay untouched (#4861)', () => {
  const wide = CSS.slice(CSS.indexOf('@media (min-width: 640px) {\n  .home-grid-overlay'),
    CSS.indexOf('\n}\n', CSS.indexOf('.home-grid-overlay {\n    /* #app-list')));
  // No width cap on the area, of any kind: the grid runs to the same edges
  // as the search bar above it and Discover communities below.
  assert.doesNotMatch(wide, /#home-apps-section[^{]*\{[^}]*max-width/);
  assert.doesNotMatch(wide, /#home-apps-section[^{]*\{[^}]*margin-inline/);
  // The overlay's inset and gap are unchanged: it is inset by #app-list's
  // own padding, so any drift here is a jump at the end of the drop glide.
  const overlay = wide.match(/\.home-grid-overlay \{[^}]*\}/)[0];
  assert.match(overlay, /inset: 0\.5rem 0\.75rem 0\.75rem;/);
  assert.match(overlay, /gap: 0\.5rem;/);
});

// Gesture-only and account-dependent surfaces are invisible to the
// before/after captures and to every declared check, so they need URLs.
test('the overlay and both create-quota treatments are URL-reachable', () => {
  assert.match(HOME, /shot !== 'home-grid'/);
  // Re-painted on EVERY render, unlike ?shot=card-menu's once-only flag: the
  // grid's innerHTML is replaced whenever a payload lands, which wipes the
  // overlay with it. An overlay is idempotent decoration; a menu is not.
  assert.doesNotMatch(HOME, /_shotGridDone/);
  assert.match(HOME, /if \(Home\._dragActive\) return; \/\/ a real gesture owns the overlay/);
  // It also sets .un-reordering, so the link renders the state the CSS keys
  // the tiles' pointer-events:none off — making the hit-test regression
  // (occupied cells undroppable) visible from a URL rather than only from a
  // real gesture nothing can navigate to.
  assert.match(HOME, /listEl\.classList\.add\('un-reordering'\)/);
  const canCreate = HOME.match(/canCreate\(\) \{[\s\S]*?\n {2}\},/)[0];
  assert.match(canCreate, /shot === 'create-enabled'/);
  assert.match(canCreate, /shot === 'create-disabled'/);
  // Pure UI state: neither link writes anything or is env-gated, so the
  // production "before" side works the moment this ships.
  assert.doesNotMatch(canCreate, /fetch|IS_STAGING/);
});

// ── The title bar is not a handle any more ────────────────────────
//
// It was one, and the affordance was spread over three files: `select-none`
// and a "Drag to move this widget" tooltip in the markup, `cursor: grab` /
// `grabbing` in app.css, and a pointerdown guard in _wire that stopped a
// press on any control inside the block from arming the grid's recognizer
// (which listened on #app-list and saw the event by bubbling). THE UI
// OVERHAUL fixed the blocks into sections outside #app-list, so none of it
// can work — and a bar that advertises a drag it cannot do is worse than one
// that says nothing.

test('the bar no longer advertises a drag it cannot do', () => {
  const { html } = renderWith({ registry: [], hidden: [], panels: [panel()] });
  assert.doesNotMatch(html, /title="Drag to move this widget"/);
  assert.doesNotMatch(html, /home-panel-bar[^>]*select-none/);
  // The ⠿ grip went two rounds earlier, and must not come back with the
  // gesture gone: it would advertise the same lie in a different glyph.
  assert.doesNotMatch(html, /⠿/);
  assert.doesNotMatch(html, /home-panel-grip/);
});

test('the grab cursor is gone from app.css, and stays gone', () => {
  const css = read('public/css/app.css');
  // Declaration-shaped: the comment recording what was removed, and why, is
  // the one mention that should survive.
  assert.doesNotMatch(css, /cursor:\s*grab(bing)?;/,
    'nothing on this screen is grabbable by its title bar any more');
  // The bar itself is GONE — its title became the section's label and its
  // controls followed — so the `user-select: none` that kept a double-click
  // from selecting "CHALLENGES · 1 of 6" has nothing left to guard.
  assert.doesNotMatch(css, /\.home-panel-bar \{/);
  // A control is still a control, in the row the bar became.
  assert.match(css, /\.home-area-label button \{[^}]*cursor:\s*pointer/);
});

test('the block wires no drag recognizer of its own', () => {
  // This used to read `_wire`, whose `pointerdown` guard on
  // `.home-panel button` was the thing being checked for: the blocks were grid
  // items, the recognizer listened on #app-list, and the event bubbles — so
  // stopping it AT the button was what kept a press on ⋮ from arming a drag.
  // The guard went with the placement, `_wire` went with the conversion, and
  // what is left to guard is that nothing has crept back into EITHER half.
  for (const [name, src] of [['home-panels.js', SRC], ...PANEL_SOURCES]) {
    assert.doesNotMatch(src, /'pointerdown'|onPointerDown/,
      `${name}: no recognizer can see these sections, so nothing listens for one`);
    // (HTML5 `draggable={false}` on an <img> is the opposite of a recognizer —
    // it suppresses the browser's own drag — so it is not what this guards.)
    assert.doesNotMatch(src, /attach(Reorder|GridPlacement)\(|draggable=\{true\}|'dragstart'/,
      `${name}: and none was bolted on to replace what was removed`);
  }
});

// ── Retired visibility controls (#1801) ─────────────────────────────

test('retired hide controls and their client mutation code are absent', () => {
  const { html, HP } = renderWith({ registry: [], hidden: [], panels: [panel()] });
  assert.doesNotMatch(html, /home-panel-menu|home-panel-hide/);
  for (const method of ['setHidden', 'openMenu', 'menuItems', 'isRemovable']) {
    assert.equal(HP[method], undefined, `${method} retired`);
  }
  const [, ui] = PANEL_SOURCES.find(([n]) => n.endsWith('ui.tsx'));
  assert.doesNotMatch(ui, /PanelMenuButton|Widget options/);
});

// ── Height cap ────────────────────────────────────────────────────

// THE HEIGHT CAP IS GONE, and this is the regression guard for putting one
// back. `--home-panel-max-h` (two app-grid cells plus the gap, 16rem) with
// .home-panel-rows' overflow: hidden made a block CLIP inside the rectangle
// it occupied on the launcher canvas. A section has no rectangle, and the
// size is bounded by the MARKUP — HomePanels.challengesView draws a short
// pick, and "See all" goes to the Challenges tab for the rest.
//
// Re-introducing it would clip the block a viewer actually gets: four
// challenge rows plus the chrome is already past the 256px the cap allowed.
test('the block sizes to its content — no height cap to clip it', () => {
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /--home-panel-max-h:/);
  const panelRule = css.match(/\.home-panel \{[^}]*\}/)[0];
  assert.doesNotMatch(panelRule, /max-height/);
  assert.match(panelRule, /flex-direction:\s*column/);
  // Uniform rows are what make the slot budgets exact, and the height is a
  // variable so the budget comment beside them has one number to check.
  assert.match(css.match(/\.home-panel-row \{[^}]*\}/)[0],
    /height:\s*var\(--home-panel-row-h\)/);
  assert.match(css, /--home-panel-row-h:\s*3\.5rem/);
  // What bounds the block is the MARKUP: every First challenge (the admin
  // sets four), or at most NEXT_SLOTS Next ones, each a card taller than a
  // row. A re-introduced 16rem cap would cut into four of them.
  const rowPx = parseFloat(css.match(/--home-panel-row-h:\s*([\d.]+)rem/)[1]) * 16;
  const nextSlots = Number(SRC.match(/NEXT_SLOTS:\s*(\d+)/)[1]);
  assert.equal(nextSlots, 3);
  const firstBlock = 4 * rowPx;
  assert.ok(firstBlock > 160,
    `four First challenges are past ${firstBlock}px, and a 16rem cap is a ceiling on them`);
  // No runtime measurement — #922 deleted that mechanism for the width
  // axis and app.css says not to bring it back.
  assert.doesNotMatch(HOME, /alignSections|--home-section-indent/);
});

// The width cap is GONE. It was --home-panel-max-w, half of .home-column
// (512px of 1024px), and it was right while a block was a WIDGET sharing the
// launcher canvas with app icons: a challenges row is one short line plus two
// small chips, and stretching it to 1024px left a lonely reward chip pinned
// to the far right. These are the screen's AREAS now, stacked under a
// full-width app grid, and a half-width Discover under it reads as a
// rendering fault rather than as restraint.
test('the blocks span the whole column — no half-width cap', () => {
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /--home-panel-max-w:|var\(--home-panel-max-w\)/);
  assert.doesNotMatch(css.match(/\.home-panel \{[^}]*\}/)[0], /max-width/);
  // The column above them is the one width bound, and it is unchanged.
  assert.match(css.match(/\.home-column \{[^}]*\}/)[0], /max-width:\s*64rem/);
  // Still left-aligned, and never centred by auto side margins: the blocks'
  // left edge lines up with the grid's first column above them.
  assert.doesNotMatch(css.match(/\.home-panel \{[^}]*\}/)[0], /margin(-left|-right)?:\s*auto/);
});

// The drag slot's own rules went with it: a max-width so the lift ghost
// matched the widget's real width, and a no-margin rule (a margin adds to a
// grid item's OUTER height, so a row-span-2 slot would have demanded
// 14rem + margin from two 6.75rem rows and stretched every card sharing
// them). Nothing spans rows any more.
test('the grid host and its row-spanning rules are gone', () => {
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /^\.home-panel-slot[\s,{]/m);
  // Rule-shaped and anchored: the comments recording what each rule did, and
  // why it went, are the mentions that should survive.
  assert.doesNotMatch(css, /^#app-list[^{;\n]*\.home-panel-slot[^{;\n]*\{/m);
  // What STAYS is the app tiles' own top-alignment: rows are a fixed height
  // whenever tiles alone define them, so this is a no-op today — and it is
  // still the rule that keeps a card from stretching to a track that is NOT a
  // tile row, which the half-cell blank rows of #975 still are.
  assert.match(css, /#app-list > \.app-card \{[^}]*align-self:\s*start/);
});

test('the cell height still matches the app tile it is derived from', () => {
  // p-3 (0.75rem x 2) + 3.5rem icon + 0.375rem gap + 1.625rem name (two
  // 13px lines, #951) + 0.75rem caption lane = 7.75rem per cell; two cells
  // + the grid's 0.5rem gap = 16rem — the figure the retired height cap was
  // derived from. --home-cell-h still drives the grid's rows and the drag
  // overlay's cells, which is why both sides are pinned here.
  const card = HOME.match(/<div class="app-card app-card-draggable[^"]*"/)[0];
  assert.match(card, /\bp-3\b/, 'app tile padding feeds the 1.5rem term');
  assert.match(card, /\bgap-1\.5\b/, 'app tile gap feeds the 0.375rem term');
  assert.match(HOME, /class="app-icon-tile w-14 h-14/, 'icon feeds the 3.5rem term');
  assert.match(HOME, /class="app-card-title"/, 'name feeds the 1.625rem term');
  // …and the two label lanes measure their design size in app.css, so a
  // one-line and a two-line title produce identically sized tiles. The
  // title lane is a MIN-height since #3661, not a fixed height: a device
  // that renders the font larger (Android text scaling / font boosting)
  // must grow the box with its text instead of clipping the second line
  // mid-glyph, so the line-height is unitless and the height is a floor.
  const titleRule = CSS.match(/\.app-card-title \{[^}]*\}/)[0];
  assert.match(titleRule, /min-height:\s*1\.625rem/, 'the title lane is two lines at the design size, and a floor when the font renders larger');
  assert.doesNotMatch(titleRule, /(?<!min-)height:\s*1\.625rem/, 'the title lane is not a fixed height — that clipped inflated text (#3661)');
  assert.match(titleRule, /line-height:\s*1\.18\s*;/, 'the line height is unitless so it tracks the font');
  assert.doesNotMatch(titleRule, /line-height:\s*0\.8125rem/);
  assert.match(titleRule, /-webkit-line-clamp:\s*2/, 'long names ellipsise at two lines');
  // #5195: 11px on 13px lines again. #4934's step up to 12px/14px cut most
  // names after a few letters on a phone's four columns; the two-line lane
  // (26px) is the term the desktop cell's 124px adds up to.
  assert.match(titleRule, /font-size:\s*0\.6875rem/, 'the label is 11px (#5195)');
  assert.match(CSS, /--home-cell-h: 7\.75rem/, 'the desktop cell adds up the terms above');
  assert.match(CSS.match(/\.app-card-status \{[^}]*\}/)[0], /line-height:\s*0\.75rem/);
  // THE CAPTION LANE IS LOAD-BEARING. The status dot is gone from the tile
  // face, so this line is a tile's only status signal — and rows are a
  // fixed height, so a caption with no budget paints over the tile below
  // instead of growing its own row.
  assert.match(HOME, /warningHtml = statusLabel/);
  assert.match(CSS, /THE CAPTION LANE IS NOT OPTIONAL/);
  const grid = INDEX.match(/<div id="app-list"[^>]*>/)[0];
  assert.match(grid, /\bsm:gap-2\b/, 'the grid gap feeds the between-rows 0.5rem term');
  // The phone variant tightens the tile and shrinks the cell in step —
  // and the tightening has to OUT-SPECIFY Tailwind's own p-3 utility,
  // since tailwind.css is linked after app.css (see the rule's comment).
  assert.match(grid, /\bp-2\b/);
  assert.match(CSS, /\.app-card\.app-card:not\(\.home-discover-card\) \{ padding: 0\.5rem; \}/);
  assert.match(CSS, /--home-cell-h: 7\.25rem/);
  // …and the phone cap override is GONE with the cap itself (#968 introduced
  // it: a block's phone footprint was a single grid row, so a two-cell cap
  // would have let an oversized text size paint the article over the app
  // tiles below it). The blocks are sections outside the grid now — they
  // overlap nothing and they size to their own content.
  assert.doesNotMatch(CSS, /--home-panel-max-h:/);
});

// ── Source pins ───────────────────────────────────────────────────

// THE THREE AREAS, in the shell's own markup and in this order: Your apps
// (whose grid ends with the Create tile), Discover, Challenges. That order is
// the whole shape of the screen, so it is pinned against the built document
// rather than left to the island's source.
test('index.html stacks the two section hosts below the grid, in order', () => {
  const grid = INDEX.indexOf('id="app-list"');
  assert.ok(grid > 0, 'the launcher grid is there');
  const at = (id) => INDEX.indexOf(`id="${id}"`);
  const order = ['home-discover-section', 'home-challenges-section'];
  let prev = grid;
  for (const id of order) {
    const here = at(id);
    assert.ok(here > 0, `${id} is in the document`);
    assert.ok(here > prev, `${id} sits below what precedes it`);
    prev = here;
  }
  // Outside the grid, or its wholesale re-render would destroy them.
  assert.ok(INDEX.indexOf('id="app-list"', 0) < at('home-discover-section'));
  assert.doesNotMatch(INDEX.slice(grid, at('home-discover-section')), /<\/section>[\s\S]*<div id="app-list"/);

  // Each host names the block it is for, which is what the dapp.json checks
  // and the screenshot assertions select on.
  for (const key of ['discover', 'challenges']) {
    assert.match(INDEX, new RegExp(`data-panel-slot="${key}"`), `${key} host is named`);
  }
  // The third, #home-create-section, is retired: Create is the launcher grid's
  // trailing tile, drawn on the first grid paint and so absent from the
  // prerender (tests/home-create-tile.test.js).
  assert.equal(at('home-create-section'), -1);

  // #home-panels — the widgets' stacked FALLBACK host — is gone with the
  // placement it existed for. It caught the moment before the first grid
  // paint and the active-search view, because a widget that lived IN the grid
  // vanished whenever the grid did; the sections never do.
  assert.equal(INDEX.indexOf('id="home-panels"'), -1);
  // …as are the two trailing sections THOSE replaced, two rounds ago.
  assert.equal(INDEX.indexOf('id="home-find-more"'), -1);
  assert.equal(INDEX.indexOf('id="home-featured-list"'), -1);
  assert.equal(INDEX.indexOf('id="home-create-body"'), -1);
});

// #922 centred the whole feed in a 1024px .home-column and DELETED the
// per-box .home-section-block bound (plus Home.alignSections). Each block
// has to follow that convention: a plain full-width child, no per-box
// width cap — a re-introduced wrapper would render these boxes narrower
// than the "Featured apps" card below them.
test('each block is a full-width child of the section, not separately bounded', () => {
  const populated = renderWith({ registry: [], hidden: [], panels: [panel()] }).html;
  const empty = renderWith(
    { registry: [], hidden: [], panels: [panel({ total: 0, done: 0, challenges: [] })] }
  ).html;
  for (const [name, html] of [['populated', populated], ['empty state', empty]]) {
    assert.doesNotMatch(html, /home-section-block/,
      `${name}: the column is the only width cap now`);
    // The block IS the article — no wrapper. The heading is a SIBLING of it,
    // not a box around it: one block per section since the widgets became
    // fixed areas, so the label has exactly one thing to name.
    //
    // Matched WITHOUT naming the plate: what an article sits on is a per-block
    // decision (PanelShell's `plate`: Discover and Challenges wear none), and
    // this test is about the article being the block rather than about which
    // surface it wears. The next test pins what Challenges wears.
    assert.match(html, /<article class="home-panel[ "]/,
      `${name}: the block is the article itself`);
    assert.doesNotMatch(html, /home-panel-bar[^-]/,
      `${name}: no control bar inside the block — the heading carries them`);
    assert.match(html, /<\/h2><article class="home-panel[ "]/,
      `${name}: the label is the block's immediate previous sibling`);
  }
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /\.home-section-block\b/, 'the class really is gone');
});

// The ITERATION 03 board's Home screen draws Challenges straight on the page
// ground: the cards in one column, aligned with the section heading, with no
// plate, border or rule. It used to wear a translucent plate
// (`.home-challenges-plate`, PanelShell's retired 'soft') with hairlines, and
// every band inside was inset to the plate's padding.
test('Challenges sits on the page ground: no plate, no divider, no inset', () => {
  const populated = renderWith({ registry: [], hidden: [], panels: [panel()] }).html;
  const empty = renderWith(
    { registry: [], hidden: [], panels: [panel({ total: 0, done: 0, challenges: [] })] }
  ).html;
  for (const [name, html] of [['populated', populated], ['empty state', empty]]) {
    const article = html.match(/<article class="([^"]*)"[^>]*data-panel="challenges"/);
    assert.ok(article, `${name}: the Challenges article renders`);
    assert.equal(article[1], 'home-panel', `${name}: the article carries no plate class`);
    assert.doesNotMatch(html, /home-challenges-plate/, `${name}: the translucent plate is gone`);
    assert.doesNotMatch(article[0], /home-panel-card/, `${name}: and it did not become the white card`);
    assert.match(html, /<div class="home-panel-body pt-2">/, `${name}: the body is not inset`);
  }
  // The one line is a card of its own, white like the challenge cards, which
  // starts at the heading's edge; its text is padded inside it.
  assert.match(empty, /class="home-panel-rows home-panel-row home-challenges-note [^"]*rounded-\[1\.25rem\] bg-white px-4 dark:bg-zinc-900"/);

  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /\.home-challenges-plate\s*\{/, 'no plate rule, light');
  assert.doesNotMatch(css, /\.dark \.home-challenges-plate/, 'no plate rule, dark');
  assert.doesNotMatch(css, /\.home-panel-season::after\s*\{/, 'no hairline under the season progress');
  assert.doesNotMatch(css, /^\.home-panel-footer[\s{:]/m, 'no footer rule: the footer is gone');
  assert.doesNotMatch(css, /^\.home-panel--expanded/m, 'and no expanded rule');

  const ui = read('frontend/src/features/home/panels/ui.tsx');
  assert.match(ui, /plate\?: 'card' \| 'none';/, "PanelShell's 'soft' plate is retired");
});

test('the module is evaluated before home.js and precached with the bundle', () => {
  // This used to read two <script src> positions out of public/index.html.
  // #1083 chunk F step 4 moved both modules into the React bundle, so the
  // order is the home island's import list and the precached asset is the
  // bundle entry. The contract is the same one: home.js calls into HomePanels.
  const panels = ISLAND.indexOf("'./home-panels.js'");
  const home = ISLAND.indexOf("'./home.js'");
  assert.ok(panels > 0 && home > 0);
  assert.ok(panels < home, 'home.js calls into HomePanels');
  assert.match(SW, /'\/shell\/assets\/shell\.js'/);
  // ...and the retired tag is gone from both halves, not just one.
  assert.doesNotMatch(INDEX, /\/js\/home-panels\.js/);
  assert.doesNotMatch(SW, /\/js\/home-panels\.js/);
});

test('home.js loads the panels once per TTL and paints them on every render', () => {
  assert.match(HOME, /HomePanels\?\.ensureLoaded\(\)/);
  assert.match(HOME, /HomePanels\?\.render\(\)/);
});

// The "Home screen widgets" settings section is GONE. It was a list of
// checkboxes for showing or hiding each widget — an affordance that only made
// sense while the blocks were optional furniture a viewer arranged. They are
// three fixed areas of the screen now, in a fixed order, so there is nothing
// to toggle or dismiss (#1801).
test('Settings no longer offers the Home screen widgets section', () => {
  // Code-shaped, not the bare name: the comment recording what was removed
  // (and why the endpoint stayed) is the one mention that should survive.
  assert.doesNotMatch(SETTINGS, /key: 'home-panels'/);
  assert.doesNotMatch(SETTINGS, /^\s{4}_renderHomePanelsSection\(/m);
  assert.doesNotMatch(SETTINGS, /^\s{4}async _saveHomePanelVisibility\(/m);
  assert.doesNotMatch(SETTINGS, /settings-home-panels-list/);
  assert.equal(INDEX.indexOf('data-settings-section="home-panels"'), -1);
  assert.equal(INDEX.indexOf('id="settings-home-panels-list"'), -1);
  // The retired preference has no remaining API reads or writes.
  assert.doesNotMatch(ROUTE.replace(/^\s*\/\/.*$/gm, ''), /home_panels_hidden/);
});



// ── The widgets can actually SEE Home ─────────────────────────────────
//
// home-panels.js reads the Home module through `window.Home && …` — the
// same defensive shape it uses for `window.App`. `const Home = {…}` at the
// top of a script lands in the global LEXICAL scope, which is NOT `window`,
// so unless home.js publishes itself every one of those guards takes the
// "not loaded" branch — silently, forever. That shipped: the Discover widget
// always drew its empty-state note instead of the curated tiles, and the
// Create widget always drew LOCKED regardless of quota.
//
// Nothing threw and nothing logged, which is exactly why it needs a test.
//
// #1083 chunk F step 4 moved both modules into the React bundle, where the
// hazard is IDENTICAL but the publication is now conditional
// (`if (typeof window !== 'undefined')`, for the prerender pass) — so the
// corpus below has to cover the bundle's feature modules as well as the
// classic scripts, or this test would go quiet the moment a publisher moved.

test('every window.<global> the widgets read is actually published', () => {
  // Derive the list from the source rather than hard-coding it, so a NEW
  // `window.Whatever` guard added later is covered the day it lands.
  const referenced = new Set(
    Array.from(SRC.matchAll(/\bwindow\.([A-Z][A-Za-z0-9_]*)/g), (m) => m[1])
  );
  assert.ok(referenced.has('Home'), 'the module does read window.Home');

  // Every browser module the shell ships — the remaining classic scripts AND
  // the bundle's feature modules — so the publisher can be anywhere.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(js|ts|tsx)$/.test(e.name) ? [full] : [];
  });
  const shell = [
    ...walk(path.join(__dirname, '..', 'public', 'js')),
    ...walk(path.join(__dirname, '..', 'frontend', 'src')),
  ].map((full) => fs.readFileSync(full, 'utf8')).join('\n');

  for (const name of referenced) {
    assert.match(shell, new RegExp(`window\\.${name}\\s*=`),
      `home-panels.js guards on window.${name}, but nothing assigns it — `
      + 'that guard can only ever take the "missing" branch');
  }
});

test('the Discover widget renders the curated cards when Home is reachable', () => {
  const featured = [
    { slug: 'alpha', name: 'Alpha', icon_emoji: '🅰', featured: true },
    { slug: 'beta', name: 'Beta', featured: true },
  ];
  const { html } = renderBlock('discover', {
    home: { featuredApps: () => featured, isYours: () => false, _apps: featured },
  });
  assert.match(html, /home-discover-rail/, 'the card rail, not the empty note');
  // `.app-card` and `data-slug` are the contract with Home._wireDiscoveryCards
  // and with dapp.json's own Discover check, so they survive the redesign
  // whatever the card looks like. `home-discover-tile` does NOT: it named a
  // 40px tile in a grid, and a class that says "tile" on a 152px card is a
  // name the next reader has to disbelieve.
  assert.match(html, /class="app-card home-discover-card [^"]*" data-slug="alpha"/);
  assert.doesNotMatch(html, /home-discover-tile\b/, 'the grid tile is retired, not renamed in place');
  assert.match(html, /id="home-browse-btn"[\s\S]*?>See all<\/span>/, 'and the browse control is always there');
  assert.doesNotMatch(html, /No communities to suggest/);

  // With Home genuinely absent it still renders — the note, not a crash.
  const bare = renderBlock('discover').html;
  assert.match(bare, /No communities to suggest right now/);
  assert.match(bare, /id="home-browse-btn"[\s\S]*?>See all<\/span>/);
});

// ── #1567: the badge ticks from the CACHE, in the same paint ─────────
//
// The add is optimistic: toggleAdded flips is_favorited on the app object Home
// already holds and calls Home.render(), which ends by re-rendering the
// panels. Nothing refetches in between, so `added` has to be read from those
// flags at paint time. A tile view that captured its own copy would leave the
// + badge unticked until the next load, which is the reload complaint the fix
// exists to remove.
test('discoverTileView.added follows the cached flags, with no refetch (#1567)', () => {
  const alpha = { slug: 'alpha', name: 'Alpha', featured: true, is_favorited: false };
  // The real predicate, spelled out: this is Home.isYours, which is the whole
  // of what the badge and "Your apps" agree on.
  const yours = (a) => !!(a && ((a.is_collaborator && !a.your_apps_hidden) || a.is_favorited));
  const { HP, host, sandbox } = renderBlock('discover', {
    home: {
      featuredApps: () => [alpha], popularApps: () => [], isYours: yours, _apps: [alpha],
    },
  });
  assert.match(host.innerHTML, /data-slug="alpha"/);
  assert.match(host.innerHTML, /data-added="false"/, 'not added yet');

  let fetches = 0;
  sandbox.fetch = async () => { fetches += 1; return { ok: false, json: async () => ({}) }; };

  // Exactly what toggleAdded does to the cached object before it paints, and
  // nothing else — no reload, no new payload.
  alpha.is_favorited = true;
  HP.render();
  const painted = paintHosts(sandbox, [host]);
  assert.match(painted, /data-added="true"/, 'the ✓ lands in the very next paint');
  assert.doesNotMatch(painted, /data-added="false"/);
  assert.equal(fetches, 0, 'read from the cache, never from the server');

  // And back: removing is the same write in reverse, so the badge is a
  // function of the flags rather than a one-way latch.
  alpha.is_favorited = false;
  HP.render();
  assert.match(paintHosts(sandbox, [host]), /data-added="false"/);
  assert.equal(fetches, 0);
});

// ── #4937: the pill follows what the viewer already is ───────────────
//
// The corner control is one labelled pill with three jobs, picked by what the
// viewer already is: not a member, the real join; a member with the app on
// Home, the quiet "Joined"; a member whose app is not on Home yet, a plain
// "Add". `joined` is read from the same cached flags `added` is, through
// Home.isJoined, and the facts line fills in only where the app declares no
// description of its own.
test('the Discover card carries data-join, the three pill states and the fallback facts line (#4937)', () => {
  const alpha = { slug: 'alpha', name: 'Alpha', featured: true, active_users: 12 };
  const beta = { slug: 'beta', name: 'Beta', featured: true, manifest_snapshot: { description: 'Its own sentence.' } };
  const gamma = { slug: 'gamma', name: 'Gamma', featured: true, is_member: true, is_favorited: true };
  const delta = { slug: 'delta', name: 'Delta', featured: true, is_member: true };
  const html = renderDiscover({
    featuredApps: () => [alpha, beta, gamma, delta],
    popularApps: () => [],
    isYours: (a) => !!a.is_favorited,
    isJoined: (a) => !!a.is_member,
    // The real line, spelled out. What composes it is unit-tested in
    // home-find-more.test.js against the real Home.discoverMetaLine.
    discoverMetaLine: (a) => (a.slug === 'alpha' ? '12 users · Updated 3d ago' : null),
  });

  // Not a member: the real join, offered by name.
  assert.match(html, /class="card-add-btn [^"]*" data-slug="alpha" data-added="false" data-join="join"/);
  assert.match(html, /aria-label="Join Alpha"/);
  assert.match(html, />Join<\/span>/);
  assert.match(html, /home-discover-facts[^>]*>12 users · Updated 3d ago</,
    'the facts line stands in where the app declares no description');

  // A description wins: the facts line does not repeat under it.
  assert.match(html, />Its own sentence.</);
  assert.equal((html.match(/home-discover-facts/g) || []).length, 1,
    'exactly one card drew the facts line');

  // A member whose app is on Home: the quiet "Joined", pressed, in grey.
  assert.match(html, /data-slug="gamma" data-added="true" data-join="joined" aria-pressed="true"/);
  assert.match(html, /aria-label="Joined Gamma"/);
  assert.match(html, />Joined<\/span>/);
  assert.match(html, /class="card-add-btn [^"]*border-transparent[^"]*" data-slug="gamma"/,
    'the joined pill is the quiet grey, not the violet action');

  // A member whose app is NOT on Home yet: a plain pin to My apps.
  assert.match(html, /data-slug="delta" data-added="false" data-join="add"/);
  assert.match(html, /aria-label="Add Delta to My apps"/);
  assert.match(html, />Add<\/span>/);

  // The pill's own name is still a pill's; the card keeps its own.
  assert.match(html, /class="home-discover-name /);
  assert.doesNotMatch(html, /home-discover-name[^>]*\btruncate\b/,
    'the name wraps to two lines instead of cutting mid-word');

  // The two-line clamp and the repointed preview overrides live in app.css.
  const rule = CSS.match(/\.home-discover-name \{[^}]*\}/)[0];
  assert.match(rule, /-webkit-line-clamp:\s*2/, 'the name ellipsises at two lines');
  assert.match(rule, /overflow-wrap:\s*anywhere/, 'a run without spaces wraps instead of overflowing');
  assert.match(CSS, /\.card-add-btn:not\(\[data-join="joined"\]\)/,
    'the preview themes recolour the join and add pill, not the quiet joined one');
  assert.doesNotMatch(CSS, /card-add-btn\[data-added="false"\]/,
    'the old added-only override is gone with the round badge');
});

// ── Discover: ONE shape, at every width ───────────────────────────────
//
// It used to be two (#949). The widget's grid footprint was asymmetric — 4x1
// on a phone, 2x2 on desktop — so the content followed: a phone got the
// curated lane and nothing else, because the second lane would not fit the
// one row it owned. THE UI OVERHAUL made Discover a fixed full-width section,
// so both lanes render everywhere, and the `Home.currentCols()` stub these
// tests used to pick a side no longer decides anything.

const discoverHome = (over = {}) => ({
  featuredApps: () => [{ slug: 'alpha', name: 'Alpha', featured: true }],
  popularApps: () => [{ slug: 'pop', name: 'Popular One', active_users: 9 }],
  isYours: () => false,
  _apps: [],
  ...over,
});

const renderDiscover = (over) => renderBlock('discover', { home: discoverHome(over) }).html;

test('Discover draws ONE lane, curated cards first, with no sub-group label', () => {
  const html = renderDiscover();
  assert.match(html, /data-slug="pop"/, 'the popular apps still render');
  assert.match(html, /data-slug="alpha"/, 'and the curated ones lead');
  // The ORDER is the part that survives the merge: what an admin chose to
  // feature first, then what everyone else is actually using.
  assert.ok(html.indexOf('data-slug="alpha"') < html.indexOf('data-slug="pop"'));

  // ...as ONE continuous set of cards. Discover is a single category, so
  // nothing names a sub-group and nothing draws a seam between them.
  assert.doesNotMatch(html, /home-discover-divider/, 'no caption row');
  assert.doesNotMatch(html, /home-discover-popular/, 'and no second lane to name');
  assert.doesNotMatch(html, />Popular</);
  assert.equal((html.match(/home-discover-lane/g) || []).length, 1,
    'exactly one lane in the block');

  // Nothing in either half consults the column count any more — the whole
  // reason the module's own currentCols() helper is gone.
  assert.doesNotMatch(SRC, /discoverView[\s\S]{0,900}currentCols/);
  assert.doesNotMatch(PANELS_TSX, /currentCols/);
});

test('Discover draws no chrome of its own; its control is in the section heading', () => {
  const html = renderDiscover();
  assert.doesNotMatch(html, /home-panel-footer/);
  assert.doesNotMatch(html, /home-panel-bar[^-]/, 'and no bar — the card is one lane');
  // The button sits in the heading, after the label (the ⋮ that used to
  // follow it is gone). Discover has ONE destination, so it belongs beside the
  // area's name rather than in 27px of chrome above two lanes.
  assert.match(html, /home-area-label[\s\S]*?id="home-browse-btn"[\s\S]*?<\/h2>/,
    'browse sits after the label, inside the heading');
  // ...and in the empty branch too — it is THE discovery path.
  const empty = renderDiscover({ featuredApps: () => [], popularApps: () => [] });
  assert.match(empty, /home-area-label[\s\S]*?id="home-browse-btn"/);
});

// #4184: the home section's heading is "Discover communities". Only the
// heading: the tab bar's "Discover", the link beside it and the panel
// registry's title keep their words.
test('the Discover section is headed Discover communities; the page and the link keep theirs', () => {
  const heading = renderDiscover().match(/<h2 class="home-area-label[\s\S]*?<\/h2>/)[0];
  assert.match(heading, /<span class="min-w-0 flex-1 truncate[^"]*">Discover communities<\/span>/,
    'the label truncates rather than wraps at 320px, beside the link');
  // Polish N3: the link is "See all", as Challenges' is, not an "apps"
  // beside a heading that says communities.
  assert.match(heading, /aria-label="See all communities"[^>]*><span class="whitespace-nowrap">See all<\/span>/);
  // #6019: on a phone Discover is a page, not a tab, and this section is its
  // door; the desktop rail keeps a Discover tab (29 Oct 2026), which app.css
  // hides below 768px.
  const bar = fs.readFileSync(path.join(__dirname, '../frontend/src/features/nav/tab-bar.tsx'), 'utf8');
  assert.match(bar, /key: 'discover' as const, label: 'core:tabs\.discover', href: '#apps'/);
  const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /@media \(max-width: 767\.98px\) \{\n  #platform-tab-discover \{ display: none; \}/);
  assert.equal(message('core:tabs.discover'), 'Discover');
});

test('Discover’s degenerate states: cards, or the note — never both', () => {
  // Featured only: just the lane.
  const featuredOnly = renderDiscover({ popularApps: () => [] });
  assert.match(featuredOnly, /data-slug="alpha"/);
  assert.doesNotMatch(featuredOnly, /home-discover-divider/);
  assert.doesNotMatch(featuredOnly, /No communities to suggest/);

  // Popular only — the reporter's case: everything curated is already theirs.
  // With two rails this drew the note ON TOP of six perfectly good cards.
  // One lane makes that a contradiction, so the cards are the whole answer.
  const popularOnly = renderDiscover({ featuredApps: () => [] });
  assert.doesNotMatch(popularOnly, /No communities to suggest/);
  assert.match(popularOnly, /data-slug="pop"/);
  assert.match(popularOnly, /home-discover-rail/);

  // Neither: the note, and nothing else.
  const neither = renderDiscover({ featuredApps: () => [], popularApps: () => [] });
  assert.match(neither, /No communities to suggest right now/);
  assert.doesNotMatch(neither, /home-discover-rail/);
  assert.doesNotMatch(neither, /home-discover-tiles/);
  assert.doesNotMatch(neither, /home-discover-divider/);
});

// The two halves are derived independently — popularApps excludes `featured`
// today, but one lane is where a double-listing would show as the SAME CARD
// TWICE rather than as one card per rail, so the renderer dedupes.
test('a slug in both halves is drawn once', () => {
  const dupe = renderDiscover({
    popularApps: () => [{ slug: 'alpha', name: 'Alpha', active_users: 9 }],
  });
  assert.equal(
    (dupe.match(/class="app-card home-discover-card[^"]*" data-slug="alpha"/g) || []).length,
    1,
  );
});

test('Discover stamps both lane counts, and render() mirrors them onto the host', () => {
  assert.match(renderDiscover(), /data-featured="1"/);
  assert.match(renderDiscover(), /data-popular="1"/);
  const empty = renderDiscover({ featuredApps: () => [], popularApps: () => [] });
  assert.match(empty, /data-featured="0"/);
  assert.match(empty, /data-popular="0"/);

  // The checks select on [data-panel-slot="discover"][data-featured="0"], so
  // the value has to reach the HOST, not just the article inside it. It used
  // to get there by a mirroring pass over the painted markup; the host and the
  // block render from one view model now, so a value that reaches one reaches
  // both by construction — which is what this pins.
  const { host } = renderBlock('discover', {
    home: discoverHome({ featuredApps: () => [], popularApps: () => [] }),
  });
  assert.equal(host.getAttribute('data-featured'), '0');
  assert.equal(host.getAttribute('data-popular'), '0');

  // A block that stamps neither leaves its host clean rather than carrying an
  // attribute nothing set.
  const challenges = renderWith(
    { registry: [], hidden: [], panels: [panel({ total: 0, challenges: [] })] },
  ).host('challenges');
  assert.equal(challenges.hasAttribute('data-featured'), false);
});

// A lane whose tiles were never wired looks IDENTICAL in a screenshot while
// every tap and every + badge in it is dead — so this is asserted on the
// source, which is where the singular querySelector bug would live.
test('every discovery lane is handed to Home._wireDiscoveryCards', () => {
  // `_wire` used to sweep `querySelectorAll('.home-discover-tiles')`, and the
  // singular form was the bug this guarded: it would bind the featured lane
  // and leave Popular inert. The lane is a COMPONENT now, so the sweep is
  // structural — one `<Lane/>` per rendered lane, each binding its own element
  // from its own effect — and there is no selector left to get wrong.
  const [, discoverSrc] = PANEL_SOURCES.find(([n]) => n.endsWith('discover.tsx'));
  const lane = discoverSrc.slice(discoverSrc.indexOf('function Lane('));
  assert.match(lane, /useEffect\([\s\S]{0,200}?_wireDiscoveryCards\?\.\(el\)/,
    'the lane binds its own element');
  // And there is exactly ONE call site now: the merge retired the second
  // rail, which retires the whole class of bug this used to guard.
  assert.equal((discoverSrc.match(/<Lane\b/g) || []).length, 1);
  assert.doesNotMatch(discoverSrc, /querySelector/,
    'nothing reaches across the lane boundary to find tiles');
});

// The Create block's three tests lived here — its quota treatment, its row
// shape at every width, and its state mirrored onto the section host. The
// block became the launcher grid's trailing tile (the prototype's scrHome),
// one element carrying both `data-panel-slot` and `data-create-enabled`, and
// its tests moved with it: tests/home-create-tile.test.js.

// The selectors the checks actually run, asserted against the exact strings
// in dapp.json so a markup change and the check can't drift apart. (The
// Create checks moved to the grid's trailing tile, and are pinned against it
// in tests/home-create-tile.test.js.)
test('dapp.json’s home-widget checks describe markup this module emits', () => {
  const declared = JSON.parse(read('dapp.json')).tests || [];
  const find = (frag) => declared.find((t) => (t.expectSelector || '').includes(frag));

  // ONE Discover check covers the populated widget (#949). It requires BOTH
  // halves to be non-empty via the mirrored stamps, then asserts the block
  // drew them as one lane — so it is stronger than the old second-rail
  // selector it replaced: that one proved the popular apps painted, this one
  // proves they painted with nothing separating them from the curated ones.
  const discover = find('[data-panel-slot="discover"]:not([data-featured="0"])');
  assert.ok(discover, 'the discover check is declared');
  for (const cls of ['home-panel', 'home-discover-rail', 'app-card']) {
    assert.ok(discover.expectSelector.includes(cls), cls);
  }
  assert.equal(discover.expectText, 'See all');
  const desktop = renderDiscover();
  assert.ok(desktop.includes('home-discover-rail') && desktop.includes('app-card'),
    'and this module emits both classes that selector chains');
  // The tile-face invariant rides along on this selector rather than having
  // a check of its own — it dates from when the manifest parsed only the
  // first MAX_TESTS entries and a slot was a real cost. #1019 runs every
  // declared check, so a separate entry would be free now; folding it in is
  // still the tighter assertion (one navigation proves both), so it stays.
  assert.match(discover.expectSelector, /:not\(:has\(\.users-badge\)\)/);
  // The check is the merge's own guard: the block draws the cards, and
  // neither a caption row nor a second lane comes back beside them.
  assert.match(discover.expectSelector, /:not\(:has\(\.home-discover-divider\)\)/);
  assert.match(discover.expectSelector, /:not\(:has\(\.home-discover-lane ~ \.home-discover-lane\)\)/);
  const desktopLanes = (desktop.match(/home-discover-lane/g) || []).length;
  assert.equal(desktopLanes, 1, 'and the block really does draw one');
  assert.doesNotMatch(desktop, /users-badge/,
    'a discovery tile states popularity by its rank, not by a badge');

  // The empty state's check selects on the mirrored host attribute plus the
  // browse control, and asserts the note's own copy.
  const bare = find('[data-panel-slot="discover"][data-featured="0"][data-popular="0"]');
  assert.ok(bare, 'the empty-state check is declared');
  assert.match(bare.path, /shot=discover-empty/, 'reached by the deep link, not by luck');
  assert.match(bare.expectSelector, /\.home-panel-browse/);
  const emptyHtml = renderDiscover({ featuredApps: () => [], popularApps: () => [] });
  assert.ok(emptyHtml.includes('data-featured="0"'), 'the widget stamps it');
  assert.ok(emptyHtml.includes('home-panel-browse'), 'and still offers the browse control');
  assert.ok(emptyHtml.includes(bare.expectText), `the note says "${bare.expectText}"`);
});

// The rail's geometry, derived by hand in app.css and pinned here exactly as
// that comment instructs — a value moved on one side without the other
// mis-sizes the cards silently.
test('the Discover rail is a fixed-width row that bleeds to both screen edges', () => {
  const css = read('public/css/app.css');
  // A GRID OF SIX TRACKS IS GONE, and with it the whole cell budget this test
  // used to be about. The lane was six 40px icon tiles fitted to one grid
  // cell on a phone and two on desktop; the block is a section that grows to
  // its content, and the design draws a horizontal rail of cards. So the
  // sums, `--lane-tracks`, the icon-wrapper cap and the .app-card padding
  // override all went with the grid that needed them.
  // Rule-shaped and anchored, like the other retirement assertions in this
  // file: what should survive is the COMMENT recording what each rule did and
  // why it went, so only a rule at the start of a line counts as the thing
  // coming back.
  assert.doesNotMatch(css, /^\.home-discover-tiles[\s,{]/m,
    'the tile grid and its track arithmetic are retired');
  assert.doesNotMatch(css, /^\s*--lane-tracks:/m,
    'no track count to keep in step with a lane cap');
  assert.doesNotMatch(PANELS_TSX, /'--lane-tracks'/, 'and nothing sets one');

  // A CARD IS A FIXED WIDTH, not a flexed one: cards that flexed would resize
  // as a lane's count changed, and the rail's whole affordance is that the row
  // continues past the edge at a constant rhythm.
  assert.match(css, /\.home-discover-card \{[^}]*flex: 0 0 auto/);
  assert.match(css, /\.home-discover-card \{[^}]*width: 11\.25rem/);
  // …and the art block grew with it (#6012), keeping its ratio: 180 × 120 / 152.
  assert.match(css, /\.home-discover-art \{[^}]*height: 8\.875rem/);

  // IT BLEEDS. The negative inline margin cancels the section's px-3 gutter so
  // the first card starts on the text's left edge and the last runs off the
  // right — a card cut by the edge is what says there are more. The padding
  // puts the first card back on the text edge; the two must move together.
  assert.match(css, /\.home-discover-rail \{[^}]*margin-inline: -0\.75rem/);
  assert.match(css, /\.home-discover-rail \{[^}]*padding-inline: 0\.75rem/);
  // …and the snap position has to agree with that padding. Without it
  // `scroll-snap-align: start` snaps the first card to the scrollport edge,
  // and iOS applies the snap on layout: the rail arrived pre-scrolled with the
  // first card stuck to the screen edge instead of on the keyline.
  assert.match(css, /\.home-discover-rail \{[^}]*scroll-padding-inline: 0\.75rem/);
  // The ART IS FULL BLEED. The phone launcher tightens `.app-card` padding,
  // and the Discover card carries `.app-card` as its wiring contract, so that
  // rule has to exclude it or the illustration sits inset in a frame of tint.
  assert.match(css, /\.app-card\.app-card:not\(\.home-discover-card\) \{ padding: 0\.5rem; \}/);
  assert.doesNotMatch(css, /\.app-card\.app-card \{/);
  // #home-screen states `overflow-x: hidden` (pinned by
  // tests/home-vertical-scroll-only.test.js), which is what clips that
  // overhang instead of letting it widen the feed.
  assert.match(css, /#home-screen[\s\S]{0,400}?overflow-x:\s*hidden/);

  // `pan-x`, for the same reason the switcher's app rail carries it: without
  // it a diagonal drag starting here is claimed by the vertical feed and the
  // rail never moves. A vertical drag still reaches the page, because the
  // browser only takes the axis this element declares.
  assert.match(css, /\.home-discover-rail \{[^}]*touch-action: pan-x/);
  assert.match(css, /\.home-discover-rail \{[^}]*overflow-x: auto/);

  // The lane cap and the rail agree on how many cards can exist. The rail
  // scrolls, so this is no longer a fitting constraint — but a cap that drifts
  // far from what a viewer will ever swipe to is a payload nobody reads.
  assert.match(HOME, /FEATURED_LIMIT: 6/);
  assert.match(HOME, /POPULAR_LIMIT: 6/);

  // No ceiling either lane could be clipped by.
  assert.doesNotMatch(css, /--home-panel-max-h:/);
});

// ── THE STANDINGS PREVIEW IS REMOVED ──────────────────────────────
//
// The Challenges block used to draw a second list under the challenge rows:
// the head of the Topochain standings plus the viewer's own row, on the same
// 40px geometry so the two lined up, with its own hairline label and its own
// footer control. Thirteen tests covered its composition, its em dashes, its
// score formatting and its two boards; they are gone with it.
//
// The reason is what it did to the card, not to any of that: two labelled
// lists with two different tap destinations inside one area called Challenges
// made the reader work out which one they were looking at before they could
// read either. The standings are a screen, and this section's heading carries
// the one tap to it — in every branch, including the between-seasons one where
// the block draws a single line. `FillView`, `fillView`, `FillFooter`,
// FILL_SLOTS, the `data-fill` stamp and `.home-panel-fill*` / `.home-panel-lb-row`
// went together, as did the server's two board queries (see
// tests/home-panels-api.test.js). The heading's own link, "Open challenges"
// (`.home-panel-lb-browse`), was a different thing; it is "See all" now.

// ── The phone shape (#968) is gone ────────────────────────────────
//
// It was a whole second rendering of the Challenges block, and everything in
// it was a concession to ONE 116px grid cell: two rows instead of four, no
// footer (its 27px WAS the second row), the way out moved into the title bar,
// no leaderboard fill, a shortened "Leaderboard" label, and `_expanded`
// forcibly ignored because a lifted height cap in a one-cell footprint would
// have dropped an expanded season on top of the app tiles below.
//
// THE UI OVERHAUL made the block a full-width section that sizes to its own
// content, so there is no cell to fit into and the full shape is right at
// every width. What used to be the desktop-only rendering is now simply the
// rendering — which is what these assert, at no particular width.

test('the block draws the same pick at any width, and nothing expands', () => {
  const five = Array.from({ length: 5 }, (_, i) => challenge({ id: i + 1 }));
  for (const opts of [{}, AT_DESKTOP]) {
    const { html } = renderWith({ registry: [], hidden: [], panels: [panel({ total: 8, challenges: five })] }, opts);
    assert.equal((html.match(/data-challenge-id/g) || []).length, 3);
    assert.match(html, /data-rows="3"/, 'data-rows reports what is DRAWN');
    assert.match(headingOf(html), SEE_ALL, 'the way out is in the heading');
    assert.doesNotMatch(html, /home-panel-footer|home-panel-expand|home-panel--expanded/);
  }
});

test('the empty state is one note row, and nothing else', () => {
  const { html } = renderWith({
    registry: [], hidden: [],
    panels: [panel({ total: 0, done: 0, challenges: [] })],
  });
  assert.match(html, /No challenges right now/, 'it still says why');
  assert.match(html, /data-rows="0"/);
  assert.doesNotMatch(html, /home-panel-lb-row|home-panel-lb-open|data-fill/);
  assert.doesNotMatch(html, /home-panel-see-all|home-panel-lb-browse/,
    'nothing to see behind a link: no See all in this state');
  assert.doesNotMatch(html, /home-panel-expand/);
});

// The per-cell BUDGETS the phone shape was designed against went with it:
// `PHONE_ROW_SLOTS` (two rows against a 116px cell), the registry `sizes`
// footprint table that made the cell one cell, `FIT_ROW_FLOOR` (the smallest
// block the widget ever drew, reserved as a grid row's floor) and the
// `.home-panel--fit` hook that released the block from its slot's stretch.
// What is left is the collapsed CEILING, which is the same at every width.
test('the per-cell budgets and their hooks are gone', () => {
  const css = read('public/css/app.css');
  // Code-shaped (anchored at the start of a line), so the comments that
  // record what was removed, and why, survive.
  assert.doesNotMatch(SRC, /^\s*PHONE_ROW_SLOTS:/m);
  assert.doesNotMatch(SRC, /'home-panel--fit'/);
  assert.doesNotMatch(css, /^\s*\.home-panel--fit\s*\{/m);
  assert.doesNotMatch(HOME, /FIT_ROW_FLOOR/);
  // The registry keeps the blocks and their titles; the per-breakpoint
  // footprint each one claimed is what went.
  assert.doesNotMatch(ROUTE, /sizes:/);

  // …and so is the collapsed CEILING, which was the last thing in this file
  // still sized against a grid rectangle. See 'the block sizes to its content'
  // above for why re-introducing it would clip the standings preview.
  assert.doesNotMatch(css, /--home-panel-max-h:/);
});

test('app.css: the body wrapper carries the budget’s geometry', () => {
  const css = read('public/css/app.css');
  // The body takes the article's remaining height and clips...
  const body = css.match(/\.home-panel-body \{[^}]*\}/)[0];
  assert.match(body, /flex:\s*1 1 auto/);
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /overflow:\s*hidden/);
  // ...and the rows list holds its natural height inside it.
  assert.match(css, /\.home-panel-body > \.home-panel-rows \{[^}]*flex:\s*0 0 auto/);
  // The standings preview that shared this wrapper is removed, and so are its
  // two rules — a `.home-panel-fill` left behind would be a lane reserved for
  // a list nothing draws.
  assert.doesNotMatch(css, /\.home-panel-fill[ .{]/);
});

test('a Home challenge card opens that challenge’s page on the Challenges tab, not the list', () => {
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const read = (p) => fs.readFileSync(pathMod.join(__dirname, '..', p), 'utf8');
  const ui = read('frontend/src/features/home/panels/challenges.tsx');
  assert.match(ui, /data-challenge-id=\{row\.id\}\s*onClick=\{\(\) => panels\(\)\?\.goToChallenge\?\.\(row\.eventId, row\.id\)\}/,
    'each card deep-links to its own challenge');
  assert.equal((ui.match(/goToChallenges\?\.\(\)/g) || []).length, 0,
    'nothing in the block goes to the list: "See all" is a real link in the heading (ui.tsx)');
  const panels = read('frontend/src/features/home/home-panels.js');
  const fn = panels.slice(panels.indexOf('  goToChallenge(eventId, challengeId) {'));
  assert.ok(fn.length > 0, 'goToChallenge is defined');
  assert.match(fn, /location\.hash = `#leaderboard\/challenges\/\$\{ev\}\/\$\{ch\}`;/,
    'the Challenges tab’s own deep link, which the router resolves');
  assert.match(fn.slice(0, fn.indexOf('location.hash')), /HomePanels\.goToChallenges\(\);/,
    'a row without an event id falls back to the list');
  assert.match(panels, /eventId: Number\.isSafeInteger\(eventId\) && eventId > 0 \? eventId : null,/,
    'the row view carries the event id from the payload');
});

// #2989 (#1918) made the between-seasons line a real <button> to the
// Challenges tab. The Semi design draws it as a statement instead ("No
// challenges right now" / "All done for this week"), and the way to the tab
// is "See all": a real link, so it is focusable, announced as a link and
// Enter-activatable natively, with a name that starts with its visible words.
test('#2989: the way to the Challenges tab is a keyboard-reachable link', () => {
  const { html } = renderWith({ registry: [], hidden: [], panels: [panel()] });
  assert.match(headingOf(html), SEE_ALL);
  assert.equal(message('home:challenges.seeAll.label'), 'See all challenges');
  assert.ok(message('home:challenges.seeAll.label').startsWith(message('home:challenges.seeAll.text')),
    'the accessible name starts with the visible text');
  const empty = renderWith({ registry: [], hidden: [], panels: [panel({ total: 0, challenges: [] })] }).html;
  const block = empty.slice(empty.indexOf('data-panel="challenges"'));
  assert.doesNotMatch(block, /<button|role="button"|cursor-pointer/, 'the one line is not a control with nowhere to go');
});
