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

// The three fixed section hosts render() writes into, keyed the way it looks
// them up. `slots` is still the parameter name every test passes: THE UI
// OVERHAUL changed WHERE a block renders, not what it renders, so the hosts
// are the same stub under a different id.
const SECTION_HOST_IDS = {
  discover: 'home-discover-section',
  challenges: 'home-challenges-section',
  create: 'home-create-section',
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
const PANEL_SOURCES = ['ui', 'challenges', 'discover', 'create', 'sections']
  .map((n) => [`panels/${n}.tsx`, read(`frontend/src/features/home/panels/${n}.tsx`)]);
const PANELS_TSX = PANEL_SOURCES.map(([, src]) => src).join('\n');
const challengesSrc = () => PANEL_SOURCES.find(([n]) => n.endsWith('challenges.tsx'))[1];
const SECTION_VIEWS = {
  discover: 'DiscoverSectionView',
  challenges: 'ChallengesSectionView',
  create: 'CreateSectionView',
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

// The first challenge card and everything after it, up to the footer — the
// card markup without the season progress above it or the controls below it.
const cardOf = (html) => {
  const from = html.indexOf('home-challenge-card');
  const to = html.indexOf('home-panel-footer', from);
  return html.slice(from, to > from ? to : undefined);
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
const MARKER_TITLES = { discover: 'Discover', create: 'Create app' };

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
  const hosts = ['discover', 'challenges', 'create'].map(makeSlot);
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
  const rows = [
    challenge({ id: 1, progress: { done: true, current: null, target: null } }),
    challenge({ id: 2 }),
    challenge({ id: 3, progress: { done: true, current: null, target: null } }),
    challenge({ id: 4 }),
  ];
  assert.deepEqual(HP.orderRows(rows).map((c) => c.id), [2, 4, 1, 3]);
  assert.deepEqual(rows.map((c) => c.id), [1, 2, 3, 4], 'input is not mutated');
});

// ── summaryLine ───────────────────────────────────────────────────

test('summaryLine: the points clause only appears when it can be honest', () => {
  const { HP } = makeHomePanels();
  assert.equal(HP.summaryLine(panel({ total: 5, done: 2, points_remaining: 4300 })),
    '2 of 5 · 4,300 pts left');
  assert.equal(HP.summaryLine(panel({ total: 5, done: 2, points_remaining: null })),
    '2 of 5');
  assert.equal(HP.summaryLine(panel({ total: 3, done: 3, points_remaining: 0 })),
    '3 of 3', 'nothing left to earn drops the clause');
});

// ── visibleSlots ──────────────────────────────────────────────────
//
// The height cap buys exactly ROW_SLOTS 40px rows. Overflow spends the
// LAST slot on the "See all N" link rather than adding a row, so the
// budget is the same whether or not there is overflow.

test('visibleSlots: everything fits, no link row', () => {
  const { HP } = makeHomePanels();
  const four = Array.from({ length: 4 }, (_, i) => challenge({ id: i + 1 }));
  const out = HP.visibleSlots(panel({ total: 4, challenges: four }));
  assert.equal(out.rows.length, 4);
  assert.equal(out.link, false);
  assert.equal(out.total, 4);
});

test('visibleSlots: overflow keeps all four row slots — the footer owns it', () => {
  const { HP } = makeHomePanels();
  const four = Array.from({ length: 4 }, (_, i) => challenge({ id: i + 1 }));
  const out = HP.visibleSlots(panel({ total: 9, challenges: four }));
  // The overflow affordance moved OUT of the row list into the footer's
  // expand toggle, so a fourth challenge is no longer sacrificed for it.
  assert.equal(out.rows.length, 4);
  assert.equal(out.link, false, 'no row slot is spent on overflow any more');
  assert.equal(out.total, 9, 'the footer label carries the TRUE total');
  assert.ok(out.rows.length <= HP.ROW_SLOTS);
});

test('visibleSlots: not-done rows win the slots when the cap trims', () => {
  const { HP } = makeHomePanels();
  const rows = [
    challenge({ id: 1, progress: { done: true, current: null, target: null } }),
    challenge({ id: 2 }),
    challenge({ id: 3 }),
    challenge({ id: 4 }),
    challenge({ id: 5 }),
  ];
  const out = HP.visibleSlots(panel({ total: 7, challenges: rows }));
  assert.deepEqual(out.rows.map((c) => c.id), [2, 3, 4, 5],
    'the actionable rows survive; the finished one is what gets dropped');
});

test('visibleSlots: expanded draws every row the server sent', () => {
  const { HP } = makeHomePanels();
  const nine = Array.from({ length: 9 }, (_, i) => challenge({ id: i + 1 }));
  HP._expanded.challenges = true;
  const out = HP.visibleSlots(panel({ total: 9, challenges: nine, expanded: true }));
  assert.equal(out.rows.length, 9, 'the row cap does not apply when expanded');
  assert.equal(out.expanded, true);
});

test('visibleSlots: tolerates an empty/absent challenge list', () => {
  const { HP } = makeHomePanels();
  // Field-by-field, not deepEqual: the module runs in a vm realm, so its
  // objects have a different Object.prototype and strict deepEqual rejects
  // them as "same structure but not reference-equal".
  const empty = HP.visibleSlots(panel({ total: 0, challenges: [] }));
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.link, false);
  assert.equal(empty.total, 0);
  assert.equal(HP.visibleSlots({}).rows.length, 0);
  assert.equal(HP.visibleSlots({}).link, false);
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
  const p = panel({
    done: 1,
    challenges: [challenge({
      progress: { done: true, current: null, target: null },
      earned_points: 250,
    })],
  });
  const card = cardOf(renderWith({ registry: [], hidden: [], panels: [p] }).html);
  assert.match(card, /aria-valuetext="Done"/);
  assert.match(card, /bg-emerald-500\/10 text-emerald-700 dark:text-emerald-400/, 'the green done rail');
  assert.match(card, /text-emerald-700 dark:text-emerald-400">Earned 250 pts<\/span>/,
    'and the meta line says it in emerald ink');
  assert.match(card, />Earned 250 pts</, 'the chip says what was earned, not what is on offer');
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

test('every open card says how long it has left; the season progress does not repeat it', () => {
  // Until deadline bands group the cards by when they end, the line under
  // each title carries it: the challenge's own end when it has one, else the
  // season's. A finished challenge has nothing to count down to.
  const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();
  const { html } = renderWith({
    registry: [], hidden: [],
    panels: [panel({
      season: { id: 1, name: 'Season 1', ends_at: inHours(71) },
      total: 3,
      challenges: [
        challenge({ id: 1 }),
        challenge({ id: 2, goal: 'Share the announcement', ends_at: inHours(23) }),
        challenge({ id: 3, goal: 'Say hello', progress: { done: true, current: null, target: null } }),
      ],
    })],
  });
  const progress = html.slice(html.indexOf('home-panel-season'), html.indexOf('home-challenge-card'));
  assert.doesNotMatch(progress, /\d+[dh] left/, 'the season progress carries no deadline');
  const cardById = (id) => {
    const at = html.indexOf(`data-challenge-id="${id}"`);
    assert.ok(at > 0, `card ${id} renders`);
    const next = html.indexOf('home-challenge-card', at);
    return html.slice(at, next > at ? next : html.indexOf('home-panel-footer', at));
  };
  assert.match(cardById(1),
    /<span class="shrink-0 text-zinc-500 dark:text-zinc-400">3d left<\/span><span aria-hidden="true"[^>]*>·<\/span><span class="[^"]*text-amber-800[^"]*">250 pts<\/span>/,
    'the season end, beside the reward, on a challenge with no end of its own');
  assert.match(cardById(2), />23h left</, 'a challenge’s own earlier end wins');
  assert.doesNotMatch(cardById(3), /\d+[dh] left/, 'nothing to count down on a finished challenge');

  // The same words as the Challenges tab (TopochainChallenges._timeLeft).
  const { HP } = makeHomePanels({ slots: [] });
  for (const [h, want] of [
    [0.2, '1h left'], [7.5, '8h left'], [23, '23h left'], [23.5, '1d left'],
    [25, '2d left'], [71, '3d left'], [5 * 24 - 1, '5d left'], [-1, null],
  ]) {
    assert.equal(HP.timeLeft(inHours(h)), want, `${h}h`);
  }
  assert.equal(HP.timeLeft('not a date'), null);
  assert.equal(HP.timeLeft(null), null);
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

test('a challenge the expanded list carries while not open shows no countdown', () => {
  const { HP } = makeHomePanels({ slots: [] });
  const ends = new Date(Date.now() + 71 * 3600000).toISOString();
  const p = panel({ season: { id: 1, name: 'Season 1', ends_at: ends } });
  assert.equal(HP.challengeRowView(challenge(), p).deadline, '3d left', 'open: the season end');
  assert.equal(HP.challengeRowView(challenge({ open: false }), p).deadline, null,
    'organiser-closed or outside its window: no "3d left" on a challenge nobody can do');
});

test('the season progress names its scope, and leaves deadlines to the cards', () => {
  const ends = new Date(Date.now() + 71 * 3600000).toISOString();
  const { HP } = makeHomePanels({ slots: [] });
  const allDone = HP.challengesView(panel({
    season: { id: 1, name: 'Season 1', ends_at: ends },
    total: 1, done: 1,
    challenges: [challenge({ progress: { done: true, current: null, target: null } })],
  }));
  assert.deepEqual({ ...allDone.season }, { done: 1, total: 1, caption: 'done in Season 1' },
    'every card finished: still just the tally, no "3d left" moved onto it');
  const open = HP.challengesView(panel({ season: { id: 1, name: 'Season 1', ends_at: ends } }));
  assert.equal(open.season.caption, 'done in Season 1');
  assert.equal(open.rows[0].deadline, '3d left', 'the card says the deadline');
  const unnamed = HP.challengesView(panel({ season: { id: 1, name: '' } }));
  assert.equal(unnamed.season.caption, 'done', 'no name, no scope words');
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
  }))), { state: 'done', stateLabel: 'Done', fill: 1, earned: 'Earned 250 pts' });
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

test('a numeric challenge at full target reads Done on a green rail', () => {
  const { html } = renderWith({
    registry: [], hidden: [],
    panels: [panel({
      done: 1,
      challenges: [challenge({
        goal: 'Vote on five proposals',
        metric: { kind: 'count', label: 'Proposals voted', target: 5 },
        progress: { done: true, current: 5, target: 5 },
        earned_points: 900,
      })],
    })],
  });
  const card = cardOf(html);
  assert.match(card, /aria-valuetext="Done"/);
  assert.match(card, /aria-valuenow="100"/);
  assert.match(card, />Earned 900 pts</);
  assert.doesNotMatch(card, />5\/5</, "finished reads the tab's word, not a count");
});

test("Home draws the Challenges tab's card, not a card of its own", () => {
  const src = challengesSrc();
  assert.match(src, /import \{ ChallengeCard \} from '\.\.\/\.\.\/leaderboard\/challenge-card'/);
  assert.match(src, /<ChallengeCard[\s\S]*?className="home-challenge-card"/);
  const card = cardOf(renderWith({ registry: [], hidden: [], panels: [panel()] }).html);
  assert.match(card, /^home-challenge-card flex items-center gap-3 bg-white dark:bg-zinc-900 rounded-2xl/);
  assert.match(card, /h-20 w-20 rounded-2xl/, "the tab's 80px tile");
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
  assert.doesNotMatch(html, /<a href=/, 'still no per-challenge Start button');
  assert.doesNotMatch(html, /example\.invalid/);
});

test('render: a registry illustration takes the kind icon’s place in the tile', () => {
  const withArt = (illustration) => cardOf(renderWith({
    registry: [], hidden: [],
    panels: [panel({ challenges: [challenge({ icon: '🐞', illustration })] })],
  }).html);
  const card = withArt('useful-feedback');
  assert.match(card, /<img src="\/illustrations\/challenges\/useful-feedback\.svg" alt="" draggable="false" class="object-contain"\/>/,
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
  assert.ok(onTone.includes(`<img src="/challenge-illustrations/${HEX}" alt="" draggable="false" class="object-contain"/>`),
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

test('render: the footer carries the expand toggle and the way out', () => {
  const four = Array.from({ length: 4 }, (_, i) => challenge({ id: i + 1 }));
  const { html } = renderWith({
    registry: [], hidden: [], panels: [panel({ total: 8, challenges: four })],
  }, AT_DESKTOP);
  // Overflow now lives in the FOOTER, so all four row slots stay
  // challenges — the label carries the true total.
  assert.match(html, /home-panel-footer/);
  assert.match(html, /home-panel-expand[^>]*data-panel-key="challenges"/);
  assert.match(html, /See all 8 challenges/);
  // Counted by `data-challenge-id` and by the card class rather than by
  // `home-panel-row`: a challenge is a card now, and that class belongs to the
  // 56px divided row it replaced. It survives on the EMPTY state's one note
  // line, which is still a row, so counting it here would have counted a
  // different thing in the two branches.
  assert.equal((html.match(/home-challenge-card/g) || []).length, 4);
  assert.equal((html.match(/data-challenge-id/g) || []).length, 4);
  assert.doesNotMatch(html, /home-panel-more/, 'the old link ROW is gone');
  // And the separate way out, bottom right. It NAMES its destination — the
  // Challenges TAB, which is not where the title bar's leaderboard link goes
  // (#980), so neither label may say only "leaderboard" or only "open".
  assert.match(html, /home-panel-open[^>]*title="Go to the Challenges tab on the Leaderboard screen"/);
  assert.match(html, /home-panel-open[^>]*aria-label="Open challenges"/);
  assert.doesNotMatch(html, />Open<\/span>/, 'the bare "Open" label is gone');
  assert.match(html, /aria-expanded="false"/);
});

// ── The toggle only appears when it has something to reveal (#1824) ──
//
// It used to render whenever the block had any rows, so a season with three
// challenges drew "See all 3 challenges" underneath all three of them: a
// label that was false and a click that refetched the same list. The payload
// carries `all_total` — how many rows an expansion would DRAW, finished and
// out-of-window challenges included — precisely so the client can tell a
// full-but-short list from a short list with more behind it.

test('#1824: a block already showing every challenge draws no expand toggle', () => {
  const three = Array.from({ length: 3 }, (_, i) => challenge({ id: i + 1 }));
  const { html, HP } = renderWith({
    registry: [], hidden: [],
    panels: [panel({ total: 3, all_total: 3, challenges: three })],
  }, AT_DESKTOP);
  assert.equal((html.match(/data-challenge-id/g) || []).length, 3);
  assert.doesNotMatch(html, /home-panel-expand/, 'no toggle');
  assert.doesNotMatch(html, /See all 3 challenges/, 'and no false label');
  // The footer itself stays — it still carries the way out to the Challenges
  // tab — and with only that child it seats it right rather than letting it
  // drift to the left edge where the toggle used to be.
  assert.match(html, /home-panel-footer[^"]*justify-end/);
  assert.doesNotMatch(html, /home-panel-footer[^"]*justify-between/);
  assert.match(html, /home-panel-open[^>]*aria-label="Open challenges"/);
  // The view says so in one field, so a renderer cannot re-derive it wrong.
  const view = HP.challengesView(panel({ total: 3, all_total: 3, challenges: three }));
  assert.equal(view.expandable, false);
  assert.equal(view.allTotal, 3);
});

test('#1824: the toggle stays when the list is truncated, or has finished rows behind it', () => {
  const four = Array.from({ length: 4 }, (_, i) => challenge({ id: i + 1 }));
  // Truncated: eight open, four drawn.
  const cut = renderWith({
    registry: [], hidden: [],
    panels: [panel({ total: 8, all_total: 8, challenges: four })],
  }, AT_DESKTOP);
  assert.match(cut.html, /home-panel-expand[^>]*data-panel-key="challenges"/);
  assert.match(cut.html, /See all 8 challenges/);
  assert.match(cut.html, /home-panel-footer[^"]*justify-between/);

  // Not truncated, but the season has finished challenges an expansion
  // reveals — `total` alone would have hidden the toggle and taken the only
  // door to them off the home screen.
  const three = Array.from({ length: 3 }, (_, i) => challenge({ id: i + 1 }));
  const behind = renderWith({
    registry: [], hidden: [],
    panels: [panel({ total: 3, all_total: 5, challenges: three })],
  }, AT_DESKTOP);
  assert.match(behind.html, /home-panel-expand[^>]*data-panel-key="challenges"/);
  assert.match(behind.html, /See all 3 challenges/, 'the label still counts the OPEN ones');
});

test('#1824: a payload with no all_total falls back to `total`', () => {
  const { HP } = makeHomePanels();
  // A client running from a cache written before the field existed.
  const three = Array.from({ length: 3 }, (_, i) => challenge({ id: i + 1 }));
  assert.equal(HP.challengesView(panel({ total: 3, challenges: three })).expandable, false);
  assert.equal(HP.challengesView(panel({ total: 9, challenges: three })).expandable, true,
    'more open than are drawn is still an expansion, field or no field');
  // And a nonsense value never shrinks the answer below what `total` proves.
  assert.equal(HP.challengesView(panel({ total: 9, all_total: 'wat', challenges: three })).allTotal, 9);
});

test('#1824: an expanded block always keeps its way back', () => {
  const { HP } = makeHomePanels();
  const three = Array.from({ length: 3 }, (_, i) => challenge({ id: i + 1 }));
  HP._expanded.challenges = true;
  // Expanded and nothing more to show: the toggle is the only "Show less"
  // there is, so it must render regardless of the count.
  const view = HP.challengesView(panel({ total: 3, all_total: 3, challenges: three }));
  assert.equal(view.expanded, true);
  assert.equal(view.expandable, true);
});

test('render: expanded lifts the cap, shows everything, and flips the toggle', () => {
  const nine = Array.from({ length: 9 }, (_, i) => challenge({ id: i + 1 }));
  const hosts = ['challenges'].map(makeSlot);
  const { HP, sandbox } = makeHomePanels({ slots: hosts });
  HP._data = { registry: [], hidden: [], panels: [panel({ total: 9, challenges: nine })] };
  HP._expanded.challenges = true;
  HP.render();
  const html = paintHosts(sandbox, hosts);
  assert.match(html, /home-panel--expanded/, 'the class app.css hangs max-height: none on');
  assert.equal((html.match(/data-challenge-id/g) || []).length, 9,
    'every row the server sent, past the four-slot budget');
  assert.match(html, /Show less/, 'the same control collapses it');
  assert.match(html, /aria-expanded="true"/);
});

test('expanding stops the rows list clipping, and there is no cap left to lift', () => {
  const css = read('public/css/app.css');
  // The rows list must stop clipping, or a list longer than the flex layout
  // budgeted for would be cut instead of drawn.
  assert.match(css, /\.home-panel--expanded \.home-panel-rows \{[^}]*overflow:\s*visible/);
  assert.match(css, /\.home-panel-footer \{/);
  // `.home-panel--expanded { max-height: none }` lifted --home-panel-max-h.
  // Both went when the block became a SECTION that grows to its content —
  // there is no ceiling to lift, and the collapsed size is bounded by the
  // markup (visibleSlots draws at most ROW_SLOTS rows) instead.
  assert.doesNotMatch(css, /\.home-panel--expanded \{/);
  assert.doesNotMatch(css, /--home-panel-max-h:/);
});

test('render: the heading names its area — the counter is the season progress', () => {
  const { html } = renderWith({
    registry: [], hidden: [], panels: [panel({ total: 6, done: 1, points_remaining: 3900 })],
  });
  // The label and the controls are the SECTION HEADING's. The block's title bar
  // held them until the title moved out to become that heading; what was left
  // was a strip of card with one shrink-0 link floating at the right of it, so
  // the controls followed the title out and the card opens on its own content.
  assert.match(html, /home-area-label/);
  assert.match(html, /Challenges/);
  // The ⋮ followed the title out too, and then LEFT: the homescreen design's
  // area rows are label + link and nothing else, so no heading renders it now
  // and hiding is retired. Nothing may bring it back into the card either.
  assert.doesNotMatch(html, /home-panel-menu/, 'no ⋮ anywhere in the block');

  // THE COUNTER IS NOT. "· 1 of 6 · 3,900 pts left" rode here at 12px —
  // shrunk from the label's own size because at 15px it ellipsised
  // "Challenges" on a phone, in a heading that also carries a link and the ⋮.
  // It is the season progress inside the card now ("1/6 done in Season 1"
  // over six segments), the first thing in the block rather than a footnote
  // above it, and the same component the Challenges tab opens on.
  const heading = html.match(/<h2 class="home-area-label[\s\S]*?<\/h2>/)[0];
  assert.doesNotMatch(heading, /1 of 6/, 'no counter left in the heading');
  assert.doesNotMatch(heading, /3,900/);
  const progress = html.slice(html.indexOf('home-panel-season'), html.indexOf('home-panel-body'));
  assert.match(progress, />1\/6<\/span><span[^>]*>done in Season 1</, 'the figure and its scope');
  assert.match(progress, /role="meter"[^>]*aria-label="1 of 6 done in Season 1"/);
  assert.equal((progress.match(/h-\[5px\]/g) || []).length, 6, 'one segment per challenge');
  assert.equal((progress.match(/bg-violet-700/g) || []).length, 1, 'one of them filled');
  // The ring and its two lines went with it: no points lead, no arc.
  assert.doesNotMatch(progress, /pts left|stroke-dasharray/);
});

test('the season progress: nothing filled at zero, and setup is its own scope', () => {
  const zero = renderWith({
    registry: [], hidden: [], panels: [panel({ total: 6, done: 0, points_remaining: 3900 })],
  }).html;
  assert.match(zero, /home-panel-season/);
  assert.match(zero, />0\/6</);
  const zeroBar = zero.slice(zero.indexOf('home-panel-season'), zero.indexOf('home-panel-body'));
  assert.doesNotMatch(zeroBar, /bg-violet-700/, 'a season nobody has started draws no fill');

  // While setup gates the rest, the block holds only setup's challenges, so
  // the progress counts those and the gate line under it stays short.
  const gated = renderWith({
    registry: [], hidden: [],
    panels: [panel({ total: 3, done: 0, onboarding: { total: 3, completed: 1, unlocked: false, event_id: 1 } })],
  }).html;
  assert.match(gated, />1\/3<\/span><span[^>]*>done in Get started</);
  assert.match(gated, />Finish these to unlock persistent and weekly challenges\.</);
  assert.doesNotMatch(gated, /onboarding challenges completed/, 'the count is not said twice');
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

  // Data not loaded yet — absent, never a skeleton flash.
  const unloaded = renderWith(null);
  assert.equal(blocksOf(unloaded.html), '');

});

// #947 reversed the admin-only empty box. It is now a COMPACT block that
// every viewer gets: a widget that silently vanishes between seasons leaves
// the viewer unable to tell "nothing is running" from "this broke", and the
// compact block is not the full-size empty box the old comment argued
// against (it is ~68px — title bar plus one line, no footer).
test('render: the empty state renders for EVERY viewer, compact and footer-less', () => {
  const empty = panel({ total: 0, done: 0, challenges: [] });
  for (const isAdmin of [false, true]) {
    const out = renderWith({ registry: [], hidden: [], panels: [empty] },
      { user: { id: 1, isAdmin } });
    const who = isAdmin ? 'admin' : 'member';
    assert.match(out.html, /No challenges are running right now/,
      `${who}: the block says why it is quiet`);
    assert.ok(!out.host('challenges')._classes.has('hidden'), `${who}: section shown`);
    // Exactly one row, and no footer: nothing to expand, nothing to count.
    assert.equal((out.html.match(/home-panel-row\b/g) || []).length, 1, `${who}: one line`);
    assert.doesNotMatch(out.html, /home-panel-footer/, `${who}: no footer`);
    // The ⋮ sits at the right edge of the SECTION HEADING, same as the
    // populated branch — the label takes the row (`flex-1`) and the controls
    // are what is left at the end of it.
    assert.match(out.html, /home-area-label[^"]*flex items-center/, `${who}: the heading is a row`);
    assert.match(out.html, /min-w-0 flex-1 truncate[^>]*>Challenges/, `${who}: the label takes it`);
    assert.match(out.html, /data-rows="0"/, `${who}: stamped`);
    assert.doesNotMatch(out.html, /data-fill/,
      `${who}: no standings preview, so no stamp counting its rows`);
  }
});

// The empty payload must not leave the expand flag set: ensureLoaded() would
// keep sending ?expand=challenges, which asks for the season's FINISHED
// challenges and would repopulate a block that should read as quiet.
test('render: an empty payload clears the in-place expanded flag', () => {
  const hosts = ['challenges'].map(makeSlot);
  const { HP, sandbox } = makeHomePanels({ slots: hosts });
  HP._expanded.challenges = true;
  HP._data = {
    registry: [], hidden: [],
    panels: [panel({ total: 0, done: 0, challenges: [] })],
  };
  HP.render();
  assert.equal(HP._expanded.challenges, false);
  assert.match(paintHosts(sandbox, hosts), /No challenges are running right now/);
});

test('render: stale hidden metadata cannot suppress fixed sections (#1801)', () => {
  const registry = [
    { key: 'challenges', title: 'Challenges' },
    { key: 'discover', title: 'Discover' },
    { key: 'create', title: 'Create app' },
  ];
  // An old server omitted hidden panels from its payload. The new client
  // still renders their empty/marker state rather than removing the sections.
  for (const panels of [[], [panel()]]) {
    const out = renderWith({ registry, hidden: ['challenges', 'create'], panels },
      { home: { canCreate: () => false } });
    for (const key of ['challenges', 'discover', 'create']) {
      assert.ok(!out.host(key)._classes.has('hidden'), `${key} remains visible`);
      assert.match(out.host(key).innerHTML, new RegExp(`data-panel="${key}"`));
    }
    assert.match(out.host('challenges').innerHTML,
      panels.length ? /Report a reproducible bug/ : /No challenges are running right now/);
    assert.match(out.host('create').innerHTML, /data-create-enabled="false"/);
  }
});

// ── Container shape: one bordered block PER SECTION ───────────────
//
// The core of the per-block-container requirement: each of the three areas
// is its own bordered article in its own host, never rows inside one shared
// card. THE UI OVERHAUL is what made all three renderable at once — before
// it, only `challenges` built a payload, so the multi-block case had to be
// staged with a hypothetical second widget.

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
  // Discover has none at all, because its cards are the surface.
  for (const key of ['discover', 'challenges']) {
    const host = out.host(key);
    assert.equal((host.innerHTML.match(/<article class="home-panel[ "]/g) || []).length, 1,
      `${key}: one block`);
    assert.equal((host.innerHTML.match(/home-area-label/g) || []).length, 1,
      `${key}: its OWN label row`);
    assert.ok(!host._classes.has('hidden'), `${key}: shown`);
  }
  const create = out.host('create');
  assert.equal((create.innerHTML.match(/home-create-widget/g) || []).length, 1);
  assert.ok(!create._classes.has('hidden'), 'create: shown');

  // Siblings, in the ORDER the sections are declared in — the whole point of
  // the fixed stack. Discover, then Challenges, then Create.
  assert.deepEqual(out.hosts.map((h) => h.dataset.panelSlot),
    ['discover', 'challenges', 'create']);
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
  assert.match(card, /class="truncate text-base font-medium[^"]*">Produce Every Block - June 2026</, 'the goal truncates');
  assert.doesNotMatch(card, /<p /, 'and there is no task line to wrap');
  assert.match(card, /<span class="relative min-w-0 truncate">543\/720 Blocks produced<\/span>/, 'the rail label truncates');
  assert.match(card, /<span class="min-w-0 truncate font-medium text-amber-800 dark:text-amber-300">Up to 6,500 pts<\/span>/,
    'the reward truncates on the meta line');
  assert.doesNotMatch(card, /flex-wrap/, 'and no row on the card wraps');
});

test('the title bar and the footer controls are single-line too', () => {
  const data = {
    registry: [], hidden: [],
    panels: [panel({ total: 9, done: 2, points_remaining: 24300 })],
  };
  const { html } = renderWith(data, AT_DESKTOP);
  // The heading is the area's NAME and nothing else. It carried the counter
  // after a separator, shrunk to 12px because at the label's own size a
  // "· 2 of 9 · 24,300 pts left" ellipsised "Challenges" on a phone — and the
  // heading still had a link and the ⋮ after that. The counter is the season
  // progress inside the card now, so the label has the row to itself and needs no
  // caption slot to keep off its own name.
  assert.match(html, /min-w-0 flex-1 truncate[^>]*>Challenges<\/span>/);
  assert.doesNotMatch(html, /whitespace-nowrap text-\[12px\]"> · /,
    'no counter appended to the area label');
  // The season progress says it instead, on one line that truncates rather
  // than wraps.
  assert.match(html, /home-panel-season[\s\S]*?>2\/9<\/span><span class="min-w-0 truncate[^"]*">done in Season 1</);
  // The bar carries the way out (#968, now the leaderboard link of #980).
  // Nothing competes with it for the row any more — the summary that used to
  // is one level up — but it stays shrink-0 and nowrap: the label used to
  // shorten to "Leaderboard" in the one-cell phone shape, and a section's bar
  // fits the full one at every width, so _leaderboardLink takes no flag.
  assert.match(html, /home-panel-lb-browse shrink-0[^"]*whitespace-nowrap/);
  // #1916: the heading link reads "Open challenges" now, like the footer's.
  assert.match(html, /home-panel-lb-browse[^>]*>\s*<span class="whitespace-nowrap">Open challenges<\/span>/);
  // Both footer labels — the expand toggle and the "Open challenges" button.
  // Neither may wrap: the footer is a fixed-height flex row, so a wrap would
  // be clipped exactly like a wrapped row.
  assert.match(html, /<span class="whitespace-nowrap">See all 9 challenges<\/span>/);
  assert.match(html, /<span class="whitespace-nowrap">Open challenges<\/span>/);
  assert.match(html, /home-panel-expand[^>]*whitespace-nowrap/);
  assert.match(html, /home-panel-open[^>]*whitespace-nowrap/);
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

// The create block is on EVERY home screen. Quota decides whether it is
// tappable, never whether it exists — this is the regression guard for the
// old "absent for non-creators" behaviour.
test('the create block renders regardless of app quota', () => {
  for (const canCreateApps of [true, false]) {
    const out = renderWith(
      { registry: [{ key: 'create', title: 'Create app', removable: true }],
        hidden: [], panels: [] },
      { home: { canCreate: () => canCreateApps, CREATE_DISABLED_HINT: 'hint' } });
    const host = out.host('create');
    assert.ok(!host._classes.has('hidden'), `quota=${canCreateApps}: shown`);
    assert.match(host.innerHTML, new RegExp(`data-create-enabled="${canCreateApps}"`),
      `quota=${canCreateApps}: the state is the DIFFERENCE, not the presence`);
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
// collapsed size is bounded by the MARKUP — visibleSlots() draws at most
// ROW_SLOTS challenge rows and the footer's "See all N" is the way past them.
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
  // The collapsed block a viewer actually gets — the season progress, four
  // challenge rows and the footer — is what a re-introduced 16rem cap would
  // start cutting into. Two lines per row made it taller, not shorter, so the
  // cap is further out of the question than it was.
  const rowPx = parseFloat(css.match(/--home-panel-row-h:\s*([\d.]+)rem/)[1]) * 16;
  const footerPx = parseFloat(
    css.match(/\.home-panel-footer \{[^}]*min-height:\s*([\d.]+)rem/)[1]) * 16;
  const rowSlots = Number(SRC.match(/ROW_SLOTS:\s*(\d+)/)[1]);
  const collapsed = 2 + rowSlots * rowPx + footerPx + 1;
  assert.ok(collapsed > 160,
    `the collapsed block is ${collapsed}px, and a 16rem cap is a ceiling on it`);
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
  // …and the two label lanes are FIXED heights in app.css, so a one-line
  // and a two-line title produce identically sized tiles.
  const titleRule = CSS.match(/\.app-card-title \{[^}]*\}/)[0];
  assert.match(titleRule, /height:\s*1\.625rem/, 'the title lane is exactly two lines');
  assert.match(titleRule, /line-height:\s*0\.8125rem/);
  assert.match(titleRule, /-webkit-line-clamp:\s*2/, 'long names ellipsise at two lines');
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

// THE FOUR AREAS, in the shell's own markup and in this order: Your apps,
// Discover, Challenges, Create app. That order is the whole shape of the
// screen, so it is pinned against the built document rather than left to the
// island's source.
test('index.html stacks the three section hosts below the grid, in order', () => {
  const grid = INDEX.indexOf('id="app-list"');
  assert.ok(grid > 0, 'the launcher grid is there');
  const at = (id) => INDEX.indexOf(`id="${id}"`);
  const order = ['home-discover-section', 'home-challenges-section', 'home-create-section'];
  let prev = grid;
  for (const id of order) {
    const here = at(id);
    assert.ok(here > 0, `${id} is in the document`);
    assert.ok(here > prev, `${id} sits below what precedes it`);
    prev = here;
  }
  // Outside the grid, or its wholesale re-render would destroy all three.
  assert.ok(INDEX.indexOf('id="app-list"', 0) < at('home-discover-section'));
  assert.doesNotMatch(INDEX.slice(grid, at('home-discover-section')), /<\/section>[\s\S]*<div id="app-list"/);

  // Each host names the block it is for, which is what the dapp.json checks
  // and the screenshot assertions select on.
  for (const key of ['discover', 'challenges', 'create']) {
    assert.match(INDEX, new RegExp(`data-panel-slot="${key}"`), `${key} host is named`);
  }

  // #home-panels — the widgets' stacked FALLBACK host — is gone with the
  // placement it existed for. It caught the moment before the first grid
  // paint and the active-search view, because a widget that lived IN the grid
  // vanished whenever the grid did; the three sections never do.
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
    // decision now (PanelShell's `plate` — Challenges takes the translucent
    // one, Discover none at all), and this test is about the article being the
    // block rather than about which surface it wears.
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
  assert.match(html, /Browse all apps/, 'and the browse control is always there');
  assert.doesNotMatch(html, /Nothing to discover/);

  // With Home genuinely absent it still renders — the note, not a crash.
  const bare = renderBlock('discover').html;
  assert.match(bare, /Nothing to discover right now/);
  assert.match(bare, /Browse all apps/);
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

test('Discover’s degenerate states: cards, or the note — never both', () => {
  // Featured only: just the lane.
  const featuredOnly = renderDiscover({ popularApps: () => [] });
  assert.match(featuredOnly, /data-slug="alpha"/);
  assert.doesNotMatch(featuredOnly, /home-discover-divider/);
  assert.doesNotMatch(featuredOnly, /Nothing to discover/);

  // Popular only — the reporter's case: everything curated is already theirs.
  // With two rails this drew the note ON TOP of six perfectly good cards.
  // One lane makes that a contradiction, so the cards are the whole answer.
  const popularOnly = renderDiscover({ featuredApps: () => [] });
  assert.doesNotMatch(popularOnly, /Nothing to discover/);
  assert.match(popularOnly, /data-slug="pop"/);
  assert.match(popularOnly, /home-discover-rail/);

  // Neither: the note, and nothing else.
  const neither = renderDiscover({ featuredApps: () => [], popularApps: () => [] });
  assert.match(neither, /Nothing to discover right now/);
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

test('the Create widget reads the viewer’s quota through Home', () => {
  const enabled = renderBlock('create', { home: { canCreate: () => true } }).html;
  assert.match(enabled, /data-create-enabled="true"/);
  assert.doesNotMatch(enabled, /aria-disabled/);

  const locked = renderBlock('create', { home: { canCreate: () => false } }).html;
  assert.match(locked, /data-create-enabled="false"/);
  assert.doesNotMatch(locked, /aria-disabled/,
    'the locked tile still has an available action: opening quota details');
  assert.doesNotMatch(locked, /\sdisabled[=\s>]/, 'never the disabled ATTRIBUTE');
});

// ONE shape. The block used to be 4x1 below 640px and 1x1 at/above it
// (PANEL_REGISTRY `sizes`), so its CONTENT flipped at the same breakpoint:
// icon beside label in the full-width phone row, icon above label in the
// single desktop cell. THE UI OVERHAUL made it a full-width section at every
// width, so only the row shape is left — the stacked variant existed for a
// ~150px cell that no longer exists.
test('the Create block lays out as a row at every width', () => {
  const { html } = renderBlock('create', { home: { canCreate: () => true } });
  const btn = html.match(/class="home-create-btn[^"]*"/)[0];
  assert.match(btn, /\bflex-row\b/, 'icon beside label');
  assert.doesNotMatch(btn, /\bsm:flex-col\b/, 'and never stacked again at 640px');
  assert.match(btn, /\bitems-center\b/);
  assert.match(btn, /\bjustify-center\b/);
  // The label keeps the wide row's size at every width now, rather than
  // stepping down for the cell.
  assert.match(html, /home-create-label[^"]*\btext-sm\b/);
  assert.doesNotMatch(html, /home-create-label[^"]*sm:text-xs/);
  // `h-full` went with the rectangle: there is nothing to fill, so the block
  // is as tall as its own padding.
  assert.doesNotMatch(btn, /\bh-full\b/);
});

// The state has to end up on the HOST. The widget stamps it on markup that
// is painted INSIDE the [data-panel-slot] host, so a selector written the
// way the spec describes it — and the way the dapp.json checks and the
// screenshot assertions write it —
// `[data-panel-slot="create"][data-create-enabled="true"]` asks for both
// attributes on ONE element and matched nothing at all.
test('the create state reaches the [data-panel-slot] host as well as the block', () => {
  const enabled = renderBlock('create', { home: { canCreate: () => true } });
  assert.equal(enabled.host.getAttribute('data-create-enabled'), 'true',
    'the host carries the state the checks select on');
  assert.match(enabled.host.innerHTML, /class="home-create-btn/);
  assert.match(enabled.host.innerHTML, /data-create-enabled="true"/,
    'and so does the block — one selector reaches either');

  const locked = renderBlock('create', { home: { canCreate: () => false } });
  assert.equal(locked.host.getAttribute('data-create-enabled'), 'false');

  // A block with no such state leaves its host clean rather than carrying an
  // attribute nothing set.
  const challenges = renderWith(
    { registry: [], hidden: [], panels: [panel({ total: 0, challenges: [] })] },
  ).host('challenges');
  assert.equal(challenges.hasAttribute('data-create-enabled'), false);
});

// The three selectors the checks actually run, asserted against the exact
// strings in dapp.json so a markup change and the check can't drift apart.
test('dapp.json’s home-widget checks describe markup this module emits', () => {
  const declared = JSON.parse(read('dapp.json')).tests || [];
  const find = (frag) => declared.find((t) => (t.expectSelector || '').includes(frag));

  const create = find('[data-panel-slot="create"][data-create-enabled="true"]');
  assert.ok(create, 'the enabled-create check is declared');
  assert.match(create.expectSelector, /\.home-create-btn/);
  assert.match(renderBlock('create', { home: { canCreate: () => true } }).html,
    /class="home-create-btn/);

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
  assert.equal(discover.expectText, 'Browse all apps');
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
  assert.match(css, /\.home-discover-card \{[^}]*width: 9\.5rem/);

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
// tests/home-panels-api.test.js). `.home-panel-lb-browse` — the heading's link
// — is a different thing and stays.

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

test('the block draws all four rows, its footer and its toggle — at any width', () => {
  const four = Array.from({ length: 4 }, (_, i) => challenge({ id: i + 1 }));
  const { html } = renderWith({
    registry: [], hidden: [], panels: [panel({ total: 8, challenges: four })],
  });
  assert.equal((html.match(/data-challenge-id/g) || []).length, 4);
  assert.match(html, /data-rows="4"/, 'data-rows reports what is DRAWN');
  assert.match(html, /home-panel-footer/);
  assert.match(html, /home-panel-expand[^>]*data-panel-key="challenges"/);
  assert.match(html, /See all 8 challenges/);
  assert.match(html, /home-panel-open[^>]*aria-label="Open challenges"/,
    'the footer keeps the Challenges-tab door');
  // The leaderboard link (#980) with the LONG label — the compact
  // "Leaderboard" existed only for the one-cell bar. It is in the SECTION
  // HEADING now, which is where every block's chrome went when the title
  // left the card (the ⋮ that once followed it is gone).
  assert.match(html, /home-area-label[\s\S]*?home-panel-lb-browse[\s\S]*?<\/h2>/,
    'inside the heading');
  // #1916: "Open challenges" with a trailing chevron, landing on the
  // Leaderboard screen's Challenges tab — the area's name, not a different
  // thing's.
  assert.match(html, /home-panel-lb-browse[^>]*title="Go to the Challenges tab on the Leaderboard screen"/);
  assert.match(html, /home-panel-lb-browse[^>]*aria-label="Open challenges"/);
  assert.match(html, /home-panel-lb-browse[^>]*>\s*<span class="whitespace-nowrap">Open challenges<\/span>\s*<svg/,
    'the label is followed by the chevron');
  assert.doesNotMatch(html, /Open leaderboard/, 'the old label is gone');
  const [, ui] = PANEL_SOURCES.find(([n]) => n.endsWith('ui.tsx'));
  assert.match(ui, /home-panel-lb-browse[\s\S]{0,700}?goToChallenges\?\.\(\)/,
    'and that control is wired to the Challenges tab');
  assert.doesNotMatch(ui, /'Leaderboard' : 'Open leaderboard'/,
    'the two-label branch went with the shape that needed the short one');
});

test('the empty state is one note row, and nothing else', () => {
  const { html } = renderWith({
    registry: [], hidden: [],
    panels: [panel({ total: 0, done: 0, challenges: [] })],
  });
  assert.match(html, /No challenges are running right now/, 'it still says why');
  assert.match(html, /data-rows="0"/);
  // The standings preview that used to fill this state is removed, so the
  // between-seasons card is that one line. Its way to the board is the
  // section heading's link, which renders in this branch like every other.
  assert.doesNotMatch(html, /home-panel-lb-row|home-panel-lb-open|data-fill/);
  assert.match(html, /home-panel-lb-browse/, 'the heading still links to the screen');
  // Still no expand toggle — there is nothing to expand.
  assert.doesNotMatch(html, /home-panel-expand/);
});

test('an expansion is honoured at every width now', () => {
  // `_expanded` is per-visit CLIENT state and survives a resize. The phone
  // branch had to IGNORE it: a lifted height cap in a 116px cell would have
  // painted an expanded season over the app tiles below. A section grows.
  const nine = Array.from({ length: 9 }, (_, i) => challenge({ id: i + 1 }));
  const slot = makeSlot('challenges');
  const { HP, sandbox } = makeHomePanels({ slots: [slot] });
  HP._expanded.challenges = true;
  HP._data = { registry: [], hidden: [], panels: [panel({ total: 9, challenges: nine })] };
  HP.render();
  const html = paintHosts(sandbox, [slot]);
  assert.match(html, /home-panel--expanded/,
    'the class app.css hangs max-height: none on');
  assert.equal((html.match(/data-challenge-id/g) || []).length, 9);
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
  assert.equal((ui.match(/goToChallenges\?\.\(\)/g) || []).length, 1,
    'only the empty state still goes to the list (the bar link lives in ui.tsx)');
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
