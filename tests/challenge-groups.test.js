// Challenge group headers (ITERATION 03, "Groups count themselves").
//
// WHAT THIS PINS. A season that gates on setup, or whose challenges carry the
// board's categories, draws the Challenges tab as groups: First challenges while
// setup is unfinished, This week, Always open, Season challenges for anything
// else, and a finished First challenges last (S10 owner decision). Each group is a
// contiguous slice of the ONE flat order the cards' `idx` index into, and its
// header says how far through the group the viewer is and when it closes
// ("1/4 · 3d left", "2/2 done"). A finished group starts collapsed unless
// everything is finished, and the viewer's toggles last for the visit. Under
// a header that carries the clock, the cards and the detail page's meta line
// drop their own deadline, and the page's eyebrow names the group and its
// clock instead. A season without those categories keeps the ungrouped grid.
//
// The real controller runs in a vm with a stub store, as in
// tests/challenge-deep-link.test.js. The pane half renders
// ./challenges-pane.tsx over the descriptors that controller builds.
//
// Run with: node --test tests/challenge-groups.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8');
const PANE_PATH = 'frontend/src/features/leaderboard/challenges-pane.tsx';
const PANE = fs.readFileSync(path.join(root, PANE_PATH), 'utf8');
const PANE_API = 'tests/fixtures/challenges-pane-api.ts';

// A pane over a fixed challenge list, with the event bar stubbed to the real
// one's contract (select() no-ops on the current id). Nothing here waits on
// the network: a fetch that never settles keeps every assertion about the
// synchronous half of each call.
function loadPane({ challenges = [], eventId = 10, event = null, onboarding = null, search = '' } = {}) {
  const subs = [];
  const context = {
    eventId,
    select(id) {
      if (id == null || id === context.eventId) return;
      context.eventId = id;
      context.notify();
    },
    onChange(fn) { subs.push(fn); return () => {}; },
    notify() { for (const fn of subs) fn(context.eventId); },
  };
  if (event) context.selectedEvent = () => event;
  const sandbox = {
    window: { TopochainEventContext: context },
    TopochainEventContext: context,
    console,
    setTimeout,
    clearTimeout,
    location: { hash: '', search },
    // A Web API, not a JavaScript builtin, so a bare vm context lacks it and
    // _maybeShot's lookup would throw into its own catch.
    URLSearchParams,
    fetch: () => new Promise(() => {}),
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'topochain-challenges.js' });

  const pane = sandbox.window.TopochainChallenges;
  const state = { mounted: true, grid: null, detail: null, profile: null };
  const store = { get: () => state, set: (patch) => Object.assign(state, patch) };
  pane._store = store;
  pane._open = true;
  pane._challenges = challenges;
  pane._challengesLoading = false;
  pane._loadedEventId = eventId;
  pane._onboarding = onboarding;
  return { pane, store, context };
}

const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();
const ch = (id, label, extra = {}) => ({ id, card_preview: { label, goal: `Challenge ${id}` }, ...extra });
const DONE = { progress: { done: true } };

// Values copied out of the vm realm, whose arrays and objects deepStrictEqual
// would reject against host literals for their prototypes alone.
const gridOf = (store) => store.get().grid;
const keysOf = (grid) => Array.from(grid.groups, (g) => g.key);
const groupOf = (grid, key) => grid.groups.find((g) => g.key === key);
const idsOf = (pane) => Array.from(pane._ordered(), (c) => c.id);
const headers = (grid) => Object.fromEntries(Array.from(grid.groups,
  (g) => [g.key, { meta: g.meta, allDone: g.allDone, collapsed: g.collapsed }]));
const pageOf = (pane, c) => { pane._detailChallenge = c; return pane.detailView(); };

const MIXED = [
  ch(1, 'PERSISTENT'), ch(2, 'WEEKLY'), ch(3, 'SPOTLIGHT'), ch(4, 'ONBOARDING', DONE),
  ch(5, ' weekly '), ch(6, 'onboarding'), ch(7, 'PERSISTENT'), ch(8, null),
];

// ─── Order ──────────────────────────────────────────────────────────────

test('a grouped grid runs First challenges, This week, Always open, Season challenges, as slices of one flat order', () => {
  const { pane, store } = loadPane({ challenges: MIXED });
  pane._renderGrid();
  const grid = gridOf(store);
  assert.equal(grid.kind, 'cards');
  assert.deepEqual(keysOf(grid), ['setup', 'week', 'always', 'other']);
  assert.deepEqual(Array.from(grid.groups, (g) => g.heading),
    ['First challenges', 'This week', 'Always open', 'Season challenges'],
    'sentence case in data: the header uppercases with CSS');
  assert.deepEqual(idsOf(pane), [6, 4, 2, 5, 1, 7, 3, 8],
    'the group first, then unfinished, then the organiser’s order');

  const idx = [];
  for (const g of grid.groups) for (const c of g.cards) idx.push(c.idx);
  assert.deepEqual(idx, [0, 1, 2, 3, 4, 5, 6, 7],
    'contiguous slices, strictly increasing, covering every card of _ordered()');
  const ordered = pane._ordered();
  for (const g of grid.groups) {
    for (const c of g.cards) assert.equal(pane._groupOf(ordered[c.idx]).key, g.key, `card ${c.idx} sits in its own group`);
  }
  assert.deepEqual(Array.from(groupOf(grid, 'week').cards, (c) => ordered[c.idx].id), [2, 5],
    'a label is matched trimmed and case-blind');
  assert.equal(grid.notice, undefined, 'no setup gate, no notice');
});

test('the rank rule: First challenges leads while unfinished and goes last once finished', () => {
  const { pane } = loadPane();
  const { ONBOARDING, WEEKLY, PERSISTENT } = pane.GROUPS;
  const ranks = (finished) => [ONBOARDING, WEEKLY, PERSISTENT, pane.OTHER_GROUP]
    .map((g) => pane._groupRankOf(g, finished));
  assert.deepEqual(ranks(false), [0, 1, 2, 3]);
  assert.deepEqual(ranks(true), [4, 1, 2, 3], 'only First challenges moves');
  assert.equal(pane._groupRankOf(null, false), 3, 'no group ranks as Season challenges');
  assert.deepEqual({ ...pane.GROUPS.ONBOARDING }, { key: 'setup', heading: 'First challenges', order: 0 },
    'the key stays `setup`: ids and tests name it');

  // Finished, with an onboarding summary: the server's gate alone decides.
  const setupDone = [ch(1, 'ONBOARDING', DONE), ch(2, 'WEEKLY')];
  assert.equal(pane._setupFinished(setupDone, { unlocked: true }), true);
  assert.equal(pane._setupFinished(setupDone, { unlocked: false }), false, 'locked stays first, even over done cards');
  assert.equal(pane._setupFinished([ch(1, 'ONBOARDING')], { unlocked: true }), true, 'unlocked goes last, even over an open card');
  assert.equal(pane._setupFinished(setupDone, { unlocked: 'yes' }), false, 'only `true` unlocks');
  // Without one: at least one setup card, and every one done.
  assert.equal(pane._setupFinished(setupDone, null), true);
  assert.equal(pane._setupFinished([ch(1, 'ONBOARDING', DONE), ch(3, 'onboarding')], null), false);
  assert.equal(pane._setupFinished([ch(2, 'WEEKLY', DONE)], null), false, 'no setup card is not a finished setup');
  assert.equal(pane._setupFinished([], null), false);
});

test('a finished First challenges moves to the end of the grid; a locked one stays first', () => {
  const challenges = [ch(1, 'PERSISTENT'), ch(2, 'ONBOARDING', DONE), ch(3, 'SPOTLIGHT'), ch(4, 'WEEKLY'), ch(5, 'ONBOARDING', DONE)];
  const plain = loadPane({ challenges });
  plain.pane._renderGrid();
  assert.deepEqual(keysOf(gridOf(plain.store)), ['week', 'always', 'other', 'setup'],
    'every setup card done, no summary: last');
  assert.deepEqual(idsOf(plain.pane), [4, 1, 3, 2, 5], 'still contiguous, still the organiser’s order inside');
  const idx = [];
  for (const g of gridOf(plain.store).groups) for (const c of g.cards) idx.push(c.idx);
  assert.deepEqual(idx, [0, 1, 2, 3, 4], 'the slices still cover the flat order in step');

  const locked = loadPane({ challenges, onboarding: { total: 2, completed: 2, unlocked: false, event_id: 10 } });
  locked.pane._renderGrid();
  assert.deepEqual(keysOf(gridOf(locked.store)), ['setup', 'week', 'always', 'other'], 'the gate still reads locked: first');

  const unlocked = loadPane({
    challenges: [ch(1, 'ONBOARDING'), ch(2, 'WEEKLY')],
    onboarding: { total: 1, completed: 0, unlocked: true, event_id: 10 },
  });
  unlocked.pane._renderGrid();
  assert.deepEqual(keysOf(gridOf(unlocked.store)), ['week', 'setup'], 'the gate reads unlocked: last');
});

test('inside a group: unfinished first, then featured, then the organiser’s order; a lift never crosses groups', () => {
  const challenges = [
    ch(1, 'WEEKLY', DONE), ch(2, 'WEEKLY'), ch(3, 'WEEKLY'), ch(4, 'PERSISTENT'), ch(5, 'WEEKLY', { completed: true }),
  ];
  const { pane } = loadPane({ challenges });
  pane._mine = new Map([[1, { id: 1, featured: true }], [3, { id: 3, featured: true }], [4, { id: 4, featured: true }]]);
  assert.deepEqual(idsOf(pane), [3, 2, 1, 5, 4],
    'a featured card leads the unfinished, a featured finished one leads the finished, and Always open stays after This week');
});

test('a card in a later group opens its own challenge', () => {
  const { pane, store } = loadPane({ challenges: MIXED });
  pane._renderGrid();
  const grid = gridOf(store);
  pane._openIdx(groupOf(grid, 'other').cards[1].idx);
  assert.equal(pane._detailChallenge.id, 8);
  assert.equal(store.get().detail.key, '8');
  pane._openIdx(groupOf(grid, 'always').cards[0].idx);
  assert.equal(pane._detailChallenge.id, 1);
});

// ─── The header's words ─────────────────────────────────────────────────

test('each header counts its group and gives its clock', () => {
  const event = { id: 10, name: 'Season 2', ends_at: inHours(143) };
  const { pane, store } = loadPane({
    event,
    challenges: [
      ch(1, 'ONBOARDING', DONE), ch(2, 'ONBOARDING', DONE),
      // Done, and ending soonest: a finished challenge is not the clock.
      ch(3, 'WEEKLY', { ...DONE, effective: { schedule_end: inHours(10) } }),
      ch(4, 'WEEKLY', { effective: { schedule_end: inHours(71) } }),
      // Not open yet, and an organiser-closed step the viewer never finished:
      // neither is open, so neither sets the clock.
      ch(5, 'WEEKLY', { effective: { schedule_start: inHours(5), schedule_end: inHours(20) } }),
      ch(6, 'WEEKLY', { completed: true, progress: { done: false }, effective: { schedule_end: inHours(3) } }),
      ch(7, 'PERSISTENT'), ch(8, 'PERSISTENT'),
      ch(9, 'SPOTLIGHT'),
    ],
  });
  pane._renderGrid();
  assert.deepEqual(headers(gridOf(store)), {
    setup: { meta: '2/2 done', allDone: true, collapsed: true },
    week: { meta: '1/4 · 3d left', allDone: false, collapsed: false },
    always: { meta: '0/2 · no deadline', allDone: false, collapsed: false },
    other: { meta: '0/1 · 6d left', allDone: false, collapsed: false },
  }, 'Always open never borrows the event’s end; Season challenges does');
});

test('First challenges has no clock; This week falls back to the event’s end; Always open counts only its own end', () => {
  const { pane, store, context } = loadPane({
    event: { id: 10, ends_at: inHours(47) },
    challenges: [
      ch(1, 'ONBOARDING', DONE), ch(2, 'ONBOARDING', { effective: { schedule_end: inHours(30) } }), ch(3, 'ONBOARDING'),
      ch(4, 'WEEKLY'), ch(5, 'WEEKLY'),
      ch(6, 'PERSISTENT', { effective: { schedule_end: inHours(5 * 24 - 1) } }), ch(7, 'PERSISTENT'),
    ],
  });
  pane._renderGrid();
  const h = headers(gridOf(store));
  assert.equal(h.setup.meta, '1/3', 'a count and nothing else, even with a dated step');
  assert.equal(h.week.meta, '0/2 · 2d left', 'the selected event’s end');
  assert.equal(h.always.meta, '0/2 · 5d left', 'an organiser’s own end date gives Always open a clock');

  context.selectedEvent = () => ({ id: 10, ends_at: inHours(-2) });
  pane._renderGrid();
  assert.equal(headers(gridOf(store)).week.meta, '0/2 · no deadline', 'an ended event is no clock');
  delete context.selectedEvent;
  pane._renderGrid();
  assert.equal(headers(gridOf(store)).week.meta, '0/2 · no deadline', 'and no event known, none either');
});

// ─── Collapse ───────────────────────────────────────────────────────────

test('a finished group starts collapsed; when every group is finished none does', () => {
  const some = loadPane({ challenges: [ch(1, 'ONBOARDING', DONE), ch(2, 'WEEKLY')] });
  some.pane._renderGrid();
  assert.deepEqual(Array.from(gridOf(some.store).groups, (g) => [g.key, g.collapsed]),
    [['week', false], ['setup', true]], 'the grid opens on the group holding the next action; a finished First challenges trails it');

  const all = loadPane({ challenges: [ch(1, 'ONBOARDING', DONE), ch(2, 'WEEKLY', DONE)] });
  all.pane._renderGrid();
  assert.deepEqual(Array.from(gridOf(all.store).groups, (g) => [g.key, g.meta, g.collapsed]),
    [['week', '1/1 done', false], ['setup', '1/1 done', false]], 'or the grid would open on headers alone');
});

test('a header tap flips its group as drawn, and the toggle survives a redraw and the detail page', () => {
  const { pane, store } = loadPane({ challenges: [ch(1, 'ONBOARDING', DONE), ch(2, 'WEEKLY')] });
  pane._renderGrid();
  // Keyed, whatever order the groups draw in (a finished First challenges is last).
  const collapsed = () => Object.fromEntries(Array.from(gridOf(store).groups, (g) => [g.key, g.collapsed]));
  pane._toggleGroup('setup');
  assert.deepEqual(collapsed(), { setup: false, week: false }, 'a tap opens a finished group');
  pane._toggleGroup('week');
  assert.deepEqual(collapsed(), { setup: false, week: true }, 'and closes an open one');
  pane._renderGrid();
  assert.deepEqual(collapsed(), { setup: false, week: true }, 'a redraw keeps both');
  pane._openIdx(groupOf(gridOf(store), 'week').cards[0].idx);
  pane._backFromDetail();
  pane._renderGrid();
  assert.deepEqual(collapsed(), { setup: false, week: true }, 'going into a challenge and back up keeps them');
  pane._toggleGroup('setup');
  assert.deepEqual(collapsed(), { setup: true, week: true });
  pane._toggleGroup('nope');
  assert.deepEqual(Object.keys(pane._collapsed).sort(), ['setup', 'week'], 'an unknown key toggles nothing');
});

test('a new visit or another event starts from the defaults; a refresh of the same event keeps the toggles', () => {
  const challenges = [ch(1, 'ONBOARDING', DONE), ch(2, 'WEEKLY')];
  const { pane, store, context } = loadPane({ challenges });
  const land = () => {
    pane._challenges = challenges;
    pane._challengesLoading = false;
    pane._renderGrid();
  };
  const setup = () => groupOf(gridOf(store), 'setup').collapsed;
  pane._open = false;
  pane.open(); // subscribes to the event bar; its own first load never settles
  land();
  pane._toggleGroup('setup');
  assert.equal(setup(), false);

  pane.loadChallenges(); // pull-to-refresh: the same event
  land();
  assert.equal(setup(), false, 'a refresh keeps the viewer’s toggle');

  context.select(11);
  assert.equal(Object.keys(pane._collapsed).length, 0, 'another event forgets it');
  context.select(10);
  land();
  assert.equal(setup(), true, 'and draws the default again');

  pane._toggleGroup('setup');
  assert.equal(setup(), false);
  pane.close();
  pane.open();
  land();
  assert.equal(setup(), true, 'a new visit starts from the defaults');
});

// ─── The clock leaves the cards and the page ────────────────────────────

test('a header with a clock takes the deadline off its cards and the page; First challenges keeps the card’s', () => {
  const event = { id: 10, name: 'Season 2', ends_at: inHours(71) };
  const challenges = [ch(1, 'ONBOARDING'), ch(2, 'WEEKLY'), ch(3, 'PERSISTENT'), ch(4, 'SPOTLIGHT')];
  const { pane, store } = loadPane({ challenges, event });
  pane._renderGrid();
  const grid = gridOf(store);
  assert.deepEqual(Array.from(grid.groups, (g) => [g.key, g.cards[0].deadline]),
    [['setup', '3d left'], ['week', null], ['always', null], ['other', null]]);

  const page = (c) => { const d = pageOf(pane, c); return [d.eyebrow, d.deadline]; };
  assert.deepEqual(page(challenges[1]), ['This week · 3d left', null], 'the group and its clock, composed once');
  assert.deepEqual(page(challenges[2]), ['Always open', null], '"no deadline" is not a clock for the eyebrow');
  assert.deepEqual(page(challenges[3]), ['Season challenges · 3d left', null]);
  assert.deepEqual(page(challenges[0]), ['First challenges', '3d left'], 'First challenges has no clock, so its page keeps the deadline');

  pane._openIdx(groupOf(grid, 'week').cards[0].idx);
  assert.equal(store.get().detail.eyebrow, 'This week · 3d left', 'the published descriptor says the same');

  const finished = loadPane({ challenges: [ch(5, 'WEEKLY', DONE), ch(6, 'ONBOARDING')], event });
  const d = pageOf(finished.pane, finished.pane._challenges[0]);
  assert.deepEqual([d.eyebrow, d.deadline], ['This week', null], 'a finished group has no clock to give');
});

// ─── Ungrouped ──────────────────────────────────────────────────────────

test('a season without the board’s categories keeps the ungrouped grid: open, then Completed, deadlines on the cards', () => {
  const event = { id: 10, ends_at: inHours(71) };
  const challenges = [
    ch(1, 'SPOTLIGHT', { completed: true }), ch(2, 'SPOTLIGHT'), { id: 3, completed: false, card_preview: { goal: 'No label' } },
  ];
  const { pane, store } = loadPane({ challenges, event });
  pane._renderGrid();
  const grid = gridOf(store);
  assert.deepEqual(Array.from(grid.groups, (g) => [g.key, g.heading]), [['open', null], ['done', 'Completed']]);
  for (const g of grid.groups) {
    assert.equal('meta' in g, false, 'no header words');
    assert.equal('collapsed' in g, false, 'and nothing to collapse');
  }
  assert.deepEqual(idsOf(pane), [2, 3, 1]);
  assert.equal(grid.groups[0].cards[0].deadline, '3d left', 'the card keeps its deadline');
  assert.deepEqual({ ...grid.progress }, { done: 1, total: 3, caption: 'done' });
  const d = pageOf(pane, challenges[1]);
  assert.deepEqual([d.eyebrow, d.deadline], ['SPOTLIGHT', '3d left'], 'the page keeps the category and the deadline');
  pane._detailChallenge = null;
  pane._toggleGroup('open');
  assert.equal(store.get().grid, grid, 'a toggle on an ungrouped grid redraws nothing');
  assert.equal(Object.keys(pane._collapsed).length, 0);
});

// ─── Progress ───────────────────────────────────────────────────────────

test('while setup gates the rest the progress is the First challenges group’s own; unlocked it is the event’s', () => {
  const { pane, store } = loadPane({
    event: { id: 10, name: 'Season 2' },
    challenges: [ch(1, 'ONBOARDING', DONE), ch(2, 'ONBOARDING')],
    onboarding: { total: 2, completed: 1, unlocked: false, event_id: 10 },
  });
  pane._renderGrid();
  let grid = gridOf(store);
  assert.deepEqual({ ...grid.progress }, { done: 1, total: 2, caption: 'done in First challenges' });
  assert.deepEqual(headers(grid), { setup: { meta: '1/2', allDone: false, collapsed: false } });
  // 2026-10-01: what a new account finishes is its Getting started list.
  assert.equal(grid.notice, 'Finish Getting started to unlock the rest of the season.');
  assert.equal(grid.onboardingEventId, null, 'the setup cards are here');
  assert.equal(grid.lockedCount, 0, 'a payload without hidden_count locks nothing it can count');

  pane._onboarding = { total: 2, completed: 1, unlocked: false, event_id: 10, hidden_count: 6 };
  pane._renderGrid();
  assert.equal(gridOf(store).lockedCount, 6, 'the server’s hidden count, while the gate is closed');
  for (const hidden_count of [null, 'x', undefined]) {
    pane._onboarding = { total: 2, completed: 1, unlocked: false, event_id: 10, hidden_count };
    pane._renderGrid();
    assert.equal(gridOf(store).lockedCount, 0, `${String(hidden_count)}: guarded to 0`);
  }

  pane._onboarding = { total: 2, completed: 2, unlocked: true, event_id: 10 };
  pane._challenges = [ch(3, 'WEEKLY'), ch(1, 'ONBOARDING', DONE), ch(2, 'ONBOARDING', DONE)];
  pane._renderGrid();
  grid = gridOf(store);
  // QA 2026-09-24 Q17: the tab's tally names its scope as an event, since
  // Home's and the profile's "done in Season 2" count the whole season.
  assert.deepEqual({ ...grid.progress }, { done: 2, total: 3, caption: 'done in this event · Season 2' },
    'the tally counts finished cards across groups, not a finished tail of the grid');
  assert.deepEqual(keysOf(grid), ['week', 'setup'], 'the finished First challenges follows what is left to do');
  assert.equal('notice' in grid, false, 'unlocked, there is no notice');
  assert.equal('lockedCount' in grid, false, 'unlocked, nothing is hidden and there is no count');

  pane._onboarding = { total: 3, completed: 0, unlocked: false, event_id: 9 };
  pane._challenges = [ch(4, 'WEEKLY')];
  pane._renderGrid();
  assert.equal(gridOf(store).onboardingEventId, 9, 'a locked event without setup cards points back to them');
});

// ─── The pane ───────────────────────────────────────────────────────────

test('the pane draws a grouped grid’s header as a disclosure over its own grid', () => {
  assert.match(PANE, /import \{ GroupHeader \} from '\.\/group-header';/, 'the shared header, not a copy');
  assert.match(PANE, /controlsId=\{`tc-se-group-\$\{g\.key\}`\}/);
  assert.match(PANE, /<div id=\{`tc-se-group-\$\{g\.key\}`\}/, 'the grid the header controls carries that id');
  assert.match(PANE, /expanded=\{!g\.collapsed\}/);
  assert.match(PANE, /onToggle=\{\(\) => controller\(\)\?\._toggleGroup\(g\.key\)\}/,
    'the tap is the controller’s: the collapse state lives with the rest of the grid’s decisions');
  assert.match(PANE, /hidden=\{!!g\.collapsed\}/, 'a collapsed grid keeps its cards, hidden');
  assert.match(PANE, /className=\{g\.collapsed \? `hidden \$\{GRID\}` : GRID\}/,
    'and the class hides it, which the attribute cannot over `grid`');
  assert.match(PANE, /\{g\.heading \? <div className=\{GROUP_HEADING\}>\{g\.heading\}<\/div> : null\}/,
    'an ungrouped grid keeps its subheading');
  // Code only: the pane's header comment names `{' '}` to explain its absence.
  const code = PANE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  assert.doesNotMatch(code, /\{' '\}/, 'no whitespace child: the meta string arrives composed');
  assert.equal(typeof loadTsx(PANE_PATH).ChallengesPane, 'function', 'and the pane still compiles');
});

test('the pane renders each header as a disclosure over the grid it names, with the chevron for its state', () => {
  const { pane, store } = loadPane({
    challenges: [ch(1, 'ONBOARDING', DONE), ch(2, 'WEEKLY'), ch(3, 'WEEKLY', DONE)],
    onboarding: { total: 1, completed: 1, unlocked: true, event_id: 10 },
  });
  pane._renderGrid();
  const grid = JSON.parse(JSON.stringify(gridOf(store)));
  assert.deepEqual(grid.groups.map((g) => [g.key, g.collapsed]), [['week', false], ['setup', true]],
    'a finished First challenges goes last and starts collapsed, after the group holding the next action');

  const api = loadTsx(PANE_API);
  api.topochainChallengesStore.set({ mounted: true, grid, detail: null, profile: null });
  const html = renderToHtml(createElement(api.ChallengesPane));
  const rows = [...html.matchAll(/<h3 class="([^"]*)"><button ([^>]*)>([\s\S]*?)<\/button><\/h3>/g)];
  assert.equal(rows.length, 2, 'one header per group, each a button inside its heading');
  // An icon's drawing without its <svg> wrapper, whose attributes carry the
  // caller's class.
  const drawing = (Icon) => renderToHtml(createElement(Icon)).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  assert.notEqual(drawing(api.ChevronUpIcon), drawing(api.ChevronDownIcon));

  for (const [key, expanded, cards] of [['setup', false, 1], ['week', true, 2]]) {
    const row = rows.find((r) => r[2].includes(`aria-controls="tc-se-group-${key}"`));
    assert.ok(row, `the ${key} header names its grid`);
    assert.match(row[2], /^type="button" /, 'a real button, which a form cannot submit');
    assert.match(row[2], new RegExp(`aria-expanded="${expanded}"`));
    const shown = expanded ? api.ChevronUpIcon : api.ChevronDownIcon;
    const other = expanded ? api.ChevronDownIcon : api.ChevronUpIcon;
    assert.ok(row[3].includes(drawing(shown)), `${key}: chevron ${expanded ? 'up while expanded' : 'down while collapsed'}`);
    assert.ok(!row[3].includes(drawing(other)), `${key}: and only that one`);

    const open = expanded
      ? new RegExp(`<div id="tc-se-group-${key}" class="grid [^"]*">`)
      : new RegExp(`<div id="tc-se-group-${key}" class="hidden grid [^"]*" hidden="">`);
    const at = html.search(open);
    assert.ok(at !== -1, `${key}: the controlled grid exists, ${expanded ? 'shown' : 'hidden by attribute and class'}`);
    const next = html.indexOf('<h3', at);
    const body = html.slice(at, next === -1 ? html.length : next);
    assert.equal((body.match(/\btc-se-card\b/g) || []).length, cards, `${key}: its cards are rendered inside it`);

    // The name wins the row's width: at 320px "Season challenges" beside
    // "0/2 · no deadline" does not fit, and the meta is what gives way.
    assert.match(row[3], /^<span class="[^"]*\bshrink-0\b[^"]*">/, `${key}: the name keeps its width`);
    const meta = row[3].match(/<span class="([^"]*)"><span class="([^"]*)">\d+\/\d+/);
    assert.ok(meta, `${key}: the meta renders`);
    assert.match(meta[2], /\btruncate\b/, `${key}: the meta truncates`);
    assert.doesNotMatch(meta[1], /\bshrink-0\b/, `${key}: and its end of the row can shrink`);
  }
});

// The locked placeholder and the unlock note, AFTER the challenges (owner
// decision 2026-09-15). The placeholder's second line is the unlock note, so
// a pane that draws the placeholder draws no separate note; a locked event
// without a count (an older server) still gets the note, now below the cards.
test('while locked the pane draws the placeholder after the last grid instead of the note; without a count, the note', () => {
  const api = loadTsx(PANE_API);
  const render = (onboarding) => {
    const { pane, store } = loadPane({ challenges: [ch(1, 'ONBOARDING', DONE), ch(2, 'ONBOARDING')], onboarding });
    pane._renderGrid();
    api.topochainChallengesStore.set({ mounted: true, grid: JSON.parse(JSON.stringify(gridOf(store))), detail: null, profile: null });
    return renderToHtml(createElement(api.ChallengesPane));
  };
  const afterLastCard = (html, at) => {
    const lastCard = html.lastIndexOf('tc-se-card');
    return at > lastCard && at > html.indexOf('id="tc-se-group-setup"');
  };

  const locked = render({ total: 2, completed: 1, unlocked: false, event_id: 10, hidden_count: 6 });
  // The wrapper carries GRID as well as the gap: outside a grid the card
  // stretched across every column of a wide pane and read as a banner.
  const gridClass = PANE.match(/const GRID = '([^']+)';/)[1];
  const wrapper = `<div class="mt-3 ${gridClass}"><div class="`;
  const placeholder = locked.indexOf(wrapper);
  assert.ok(placeholder !== -1, 'the dashed placeholder, in a wrapper at the grid’s gap that is itself a GRID');
  assert.match(locked.slice(placeholder + wrapper.length).split('"')[0], /\bborder-dashed\b/,
    'the wrapper’s child is the dashed card, one column wide');
  assert.match(PANE, /<div className=\{`mt-3 \$\{GRID\}`\}>\s*<LockedChallengesCard /,
    'the source names the shared GRID constant, not a copy of its classes');
  assert.ok(afterLastCard(locked, placeholder), 'after the First challenges grid and its cards');
  // 2026-10-01: the words name the Getting started list on Home (only a new
  // account is gated, and the tour counts too), not "setup", and the second
  // line names the first few of what it hides when the server sends them.
  assert.match(locked, />6 challenges unlock after Getting started</);
  assert.match(locked, />Finish Getting started on Home to see them</, 'without names, what to do');
  assert.doesNotMatch(locked, /role="status"/, 'its first line is the note, so the note is not repeated');
  assert.doesNotMatch(locked, /unlock the rest of the season/);
  assert.ok(locked.indexOf('id="tc-se-challenge-summary"') < locked.indexOf('tc-se-card'), 'the progress still leads');

  const named = render({
    total: 2, completed: 1, unlocked: false, event_id: 10, hidden_count: 6,
    hidden_names: ['Make your first proposal', 'Invite a friend'],
  });
  assert.match(named, />Make your first proposal, Invite a friend and 4 more</);

  const one = render({ total: 2, completed: 1, unlocked: false, event_id: 10, hidden_count: 1 });
  assert.match(one, />1 challenge unlocks after Getting started</);

  const uncounted = render({ total: 2, completed: 1, unlocked: false, event_id: 10 });
  assert.doesNotMatch(uncounted, /border-dashed/, 'no count, no placeholder');
  const note = uncounted.search(/<p class="mt-3 [^"]*" role="status">Finish Getting started to unlock the rest of the season\.<\/p>/);
  assert.ok(note !== -1, 'the note, with its text and role');
  assert.ok(afterLastCard(uncounted, note), 'below the challenges, not above them');

  const unlocked = render({ total: 2, completed: 2, unlocked: true, event_id: 10, hidden_count: 6 });
  assert.doesNotMatch(unlocked, /border-dashed/, 'unlocked, nothing is hidden');
  assert.doesNotMatch(unlocked, /role="status"/, 'and there is no notice to draw');
  assert.doesNotMatch(unlocked, /are unlocked|unlock the rest/, 'the retired unlocked notice is gone');
});

test('the group header row has the cards’ 24px corners', () => {
  const api = loadTsx(PANE_API);
  const { pane, store } = loadPane({ challenges: [ch(1, 'ONBOARDING')], onboarding: { total: 1, completed: 0, unlocked: false, event_id: 10 } });
  pane._renderGrid();
  api.topochainChallengesStore.set({ mounted: true, grid: JSON.parse(JSON.stringify(gridOf(store))), detail: null, profile: null });
  const row = renderToHtml(createElement(api.ChallengesPane)).match(/<h3 class="[^"]*"><button type="button" class="([^"]*)"/);
  assert.ok(row, 'the header renders');
  const cls = row[1].split(' ');
  assert.ok(cls.includes('rounded-3xl') && !cls.includes('rounded-2xl'));
});

// ─── Screenshot state ───────────────────────────────────────────────────

test('?shot=challenge-detail opens the first unfinished card, not a leading First challenges group’s first', () => {
  const opened = [];
  const { pane } = loadPane({
    search: '?shot=challenge-detail',
    challenges: [ch(1, 'ONBOARDING', DONE), ch(2, 'ONBOARDING', DONE), ch(3, 'PERSISTENT'), ch(4, 'WEEKLY')],
    onboarding: { total: 2, completed: 2, unlocked: true, event_id: 10 },
  });
  pane.openChallengeDetail = (c) => opened.push(c.id);
  pane._renderGrid();
  assert.deepEqual(idsOf(pane), [4, 3, 1, 2], 'the finished First challenges group goes last');
  assert.deepEqual(opened, [4], 'the capture opens the next action, in a group that is not collapsed');
  pane._renderGrid();
  assert.deepEqual(opened, [4], 'once per page load');

  const gated = [];
  const lead = loadPane({
    search: '?shot=challenge-detail',
    challenges: [ch(1, 'ONBOARDING', DONE), ch(2, 'ONBOARDING', DONE), ch(4, 'WEEKLY')],
    onboarding: { total: 2, completed: 2, unlocked: false, event_id: 10 },
  });
  lead.pane.openChallengeDetail = (c) => gated.push(c.id);
  lead.pane._renderGrid();
  assert.deepEqual(idsOf(lead.pane), [1, 2, 4], 'a gate that still reads locked keeps its done cards first');
  assert.deepEqual(gated, [4], 'so the capture looks the next action up rather than taking ordered[0]');

  const finished = [];
  const all = loadPane({
    search: '?shot=challenge-detail',
    challenges: [ch(5, 'WEEKLY', DONE), ch(6, 'PERSISTENT', DONE)],
  });
  all.pane.openChallengeDetail = (c) => finished.push(c.id);
  all.pane._renderGrid();
  assert.deepEqual(finished, [5], 'with nothing left to do it opens the first card');

  const none = [];
  const plain = loadPane({ challenges: [ch(7, 'WEEKLY')] });
  plain.pane.openChallengeDetail = (c) => none.push(c.id);
  plain.pane._renderGrid();
  assert.deepEqual(none, [], 'without the param a real user’s grid opens nothing');
});

// ─── Unnamed rows (#2394) ───────────────────────────────────────────────

test('a challenge entry or profile the server could not name reads "Anonymous"', () => {
  const { pane } = loadPane({ challenges: [ch(1, 'WEEKLY')] });
  pane._breakdown = {
    entries: [
      { user_id: 4, display_name: 'dav***@***.com', points: 150, rate: null, is_non_podium: false },
      { user_id: 9, display_name: null, points: 1, rate: null, is_non_podium: false },
    ],
    has_more: false,
  };
  const rows = pageOf(pane, pane._challenges[0]).entries.rows;
  assert.equal(rows[0].name, 'dav***@***.com', 'a named entry is untouched');
  assert.equal(rows[1].name, 'Anonymous', 'an unnamed one is not a bare points figure');

  pane._profileUserId = 9;
  pane._profile = { display_name: null, activities: [] };
  assert.equal(pane.profileView().name, 'Anonymous', 'nor is the profile it opens');
});
