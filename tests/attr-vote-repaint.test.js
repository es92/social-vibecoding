// #608: priority/assignee votes must repaint EVERY card surface, not just
// the feed. _refreshAttrCards used to touch only #dev-feed /
// #gc-thread-head / #gc-merged, so in the board view (which mounts
// #dev-kanban-board instead) a vote updated the cached item but the visible
// chips stayed stale until a reload. It now delegates to the mode-aware
// _repaintCards() and then re-anchors the open popover to its chip's new
// position — closing it when the chip is no longer rendered (e.g. the card
// dropped off a filtered kanban board).
//
// Same vm-context harness as assignee-avatar-chip.test.js: load app-view.js
// into a sandbox, stub the globals it reaches, spy on the repaint fns.
//
// Run with: node --test tests/attr-vote-repaint.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// A minimal fake DOM node. Extend per test with whatever the code reads.
function fakeEl(extra) {
  const el = {
    innerHTML: '',
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    removed: false,
  };
  el.remove = () => { el.removed = true; };
  return Object.assign(el, extra || {});
}

// A document stub backed by an id → node map plus an optional
// querySelector resolver (used for the [data-attr-chip] lookup).
function fakeDoc(ids, querySelector) {
  return {
    getElementById: (id) => (ids && ids[id]) || null,
    querySelector: querySelector || (() => null),
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    createElement: () => fakeEl(),
    body: { appendChild: () => {} },
  };
}

function makeSandbox() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 }, currentSubTab: 'dev' },
    document: fakeDoc({}),
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    innerWidth: 1000,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, sandbox };
}

test('_refreshAttrCards delegates to the mode-aware _repaintCards (board gap regression)', () => {
  const { AppView } = makeSandbox();
  let devBodyRepaints = 0;
  let topicRepaints = 0;
  AppView._repaintDevBody = () => { devBodyRepaints += 1; };
  AppView._renderTopicHead = () => { topicRepaints += 1; };
  AppView._reanchorAttrPopover = () => {};

  AppView._refreshAttrCards();
  // The old implementation only touched #dev-feed / #gc-merged directly and
  // never went through _repaintDevBody, so the board stayed stale.
  assert.equal(devBodyRepaints, 1);
  assert.equal(topicRepaints, 0); // not on the topic sub-tab
});

test('_refreshAttrCards repaints the topic head only in the topic sub-view', () => {
  const { AppView, sandbox } = makeSandbox();
  let topicRepaints = 0;
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => { topicRepaints += 1; };
  AppView._reanchorAttrPopover = () => {};

  sandbox.App.currentSubTab = 'topic';
  sandbox.document = fakeDoc({ 'gc-thread-head': fakeEl() });
  AppView._refreshAttrCards();
  assert.equal(topicRepaints, 1);

  // Topic sub-tab but no mounted head → no repaint attempt.
  sandbox.document = fakeDoc({});
  AppView._refreshAttrCards();
  assert.equal(topicRepaints, 1);
});

// The repaint used to have two surfaces to reach, and this pair covered the
// one that was easy to forget. The BOARD VIEW MODE has retired — its columns
// are the Workshop's "By stage" pane, rendering the same <DevKanban/> from the
// same published view model — so there is one surface left and the thing worth
// pinning is that a stored preference naming the retired mode still arrives at
// it. The #608 regression itself (a vote must not leave visible chips stale) is
// covered by the two tests above, which assert the delegation directly.
function workshopSandbox(stored) {
  const { AppView, sandbox } = makeSandbox();
  sandbox.localStorage = { getItem: () => stored, setItem: () => {} };
  sandbox.document = fakeDoc({
    'dev-body': fakeEl(),
    'dev-kanban-filterbar': fakeEl(),
    'dev-workshop': fakeEl(),
  });
  const counts = { workshop: 0, board: 0 };
  AppView._rerenderWorkshop = () => { counts.workshop += 1; };
  AppView._repaintKanbanBoard = () => { counts.board += 1; };
  AppView._renderKanbanFilterBar = () => {};
  AppView._rewirePlusMenu = () => {};
  AppView._reanchorCardMenu = () => {};
  AppView._loadKanbanFilters = () => ({});
  AppView._reanchorAttrPopover = () => {};
  return { AppView, counts };
}

test('a stored kanban preference migrates, and the vote repaint reaches the Workshop', () => {
  // A viewer who last left the Dev screen on the Board has 'kanban' stored.
  // RETIRED_VIEW_MODES is what stops them landing on a mode that no longer
  // exists, and the repaint has to follow the MIGRATED mode to the surviving
  // surface rather than the stored string.
  const { AppView, counts } = workshopSandbox('kanban');
  assert.equal(AppView._getViewMode(), 'workshop', 'the stored Board preference migrates');
  AppView._refreshAttrCards();
  assert.equal(counts.workshop, 1);
  assert.equal(counts.board, 0, 'nothing routes to the standalone board surface now');
});

test('a stored PM preference resolves to the Workshop, and repaints it', () => {
  // THE UI OVERHAUL retired the PM view, and it resolved to the Board — which
  // has since retired in turn. Both hops live in RETIRED_VIEW_MODES, so 'pm'
  // lands on the one mode left instead of reading as "my setting was
  // forgotten" two cuts running.
  const { AppView, counts } = workshopSandbox('pm');
  assert.equal(AppView._getViewMode(), 'workshop');
  AppView._refreshAttrCards();
  assert.equal(counts.workshop, 1);
  assert.equal(counts.board, 0);
});

test('re-anchor: the open popover snaps under its chip\'s new position', () => {
  const { AppView, sandbox } = makeSandbox();
  AppView._repaintCards = () => {};
  AppView._attrPopover = { field: 'assignee', targetType: 'issue', targetRef: 5, slug: 'x' };

  const pop = fakeEl();
  const chip = fakeEl({ getBoundingClientRect: () => ({ bottom: 100, left: 50 }) });
  let seenSelector = null;
  sandbox.document = fakeDoc({ 'attr-popover': pop }, (sel) => {
    seenSelector = sel;
    return chip;
  });

  AppView._refreshAttrCards();
  // Looked up by the popover's own field/target identifiers.
  assert.match(seenSelector, /data-attr-chip/);
  assert.match(seenSelector, /data-attr-field="assignee"/);
  assert.match(seenSelector, /data-attr-target-type="issue"/);
  assert.match(seenSelector, /data-attr-target-ref="5"/);
  // Same clamped math _openAttrPopover uses: top = bottom + 4, left as-is.
  assert.equal(pop.style.position, 'fixed');
  assert.equal(pop.style.top, '104px');
  assert.equal(pop.style.left, '50px');
  assert.equal(pop.removed, false);
  assert.ok(AppView._attrPopover);
});

test('re-anchor: left edge clamps to the viewport like the initial open', () => {
  const { AppView, sandbox } = makeSandbox();
  AppView._repaintCards = () => {};
  AppView._attrPopover = { field: 'priority', targetType: 'proposal', targetRef: 7, slug: 'x' };

  const pop = fakeEl();
  const chip = fakeEl({ getBoundingClientRect: () => ({ bottom: 20, left: 990 }) });
  sandbox.document = fakeDoc({ 'attr-popover': pop }, () => chip);

  AppView._refreshAttrCards();
  // innerWidth 1000 → clamped to 1000 - 240 = 760.
  assert.equal(pop.style.left, '760px');
});

test('re-anchor: popover closes when its chip is no longer rendered', () => {
  const { AppView, sandbox } = makeSandbox();
  AppView._repaintCards = () => {};
  AppView._attrPopover = { field: 'priority', targetType: 'issue', targetRef: 9, slug: 'x' };

  const pop = fakeEl();
  sandbox.document = fakeDoc({ 'attr-popover': pop }, () => null);

  AppView._refreshAttrCards();
  assert.equal(pop.removed, true);
  assert.equal(AppView._attrPopover, null);
});

test('re-anchor: no-op when no popover is open', () => {
  const { AppView, sandbox } = makeSandbox();
  AppView._repaintCards = () => {};
  AppView._attrPopover = null;
  let queried = false;
  sandbox.document = fakeDoc({}, () => { queried = true; return null; });

  AppView._refreshAttrCards();
  assert.equal(queried, false);
});

test('an unset imported Underway attribute anchors to its session card', () => {
  const { AppView, sandbox } = makeSandbox();
  const card = fakeEl({ getBoundingClientRect: () => ({ bottom: 80, left: 30 }) });
  const selectors = [];
  sandbox.document = fakeDoc({}, (selector) => {
    selectors.push(selector);
    return selector.includes('data-shared-session-row') ? card : null;
  });

  const anchor = AppView._attrAnchorFor('assignee', 'proposal', 88);
  assert.equal(selectors.length, 2);
  assert.match(selectors[1], /data-proposal-row="88"/);
  assert.match(selectors[1], /data-shared-session-row="88"/);
  assert.equal(anchor.dataset.attrTargetType, 'proposal');
  assert.equal(anchor.dataset.attrTargetRef, '88');
  assert.equal(anchor.getBoundingClientRect().left, 30);
});

test('an imported Underway attribute vote updates the session cache before repaint', () => {
  const { AppView } = makeSandbox();
  const mine = { id: 88, source: 'imported', assignee: null };
  AppView._proposals = [];
  AppView._merged = [];
  AppView._mySessions = [mine];
  AppView._sharedSessions = [];

  AppView._applyAttrSummary('proposal', 88, 'assignee', {
    options: [{ value: 'bruno', count: 2 }],
    myValue: 'bruno',
  });
  assert.equal(mine.assignee.top, 'bruno');
  assert.equal(mine.assignee.count, 2);
  assert.equal(mine.assignee.myValue, 'bruno');
});
