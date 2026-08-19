// A topic page opened by DIRECT URL must be as interactive as one reached
// by tapping a card.
//
// The bug: AppView._attrInit() — which installs the DOCUMENT-level click /
// keydown / scroll handlers behind the priority, category and assignee
// chips and behind the "How voting works" popover — was called from the
// CARD-LIST branch of renderDevView(), near the bottom. Every other branch
// (topic, chat, session) returns before reaching it. So pasting, sharing or
// reloading #app/<slug>/dev/proposals/<id> painted a proposal whose chips
// and "?" affordance did nothing at all, while the very same page opened by
// clicking the card on the kanban board worked — because the card list had
// rendered first and installed the handlers as a side effect.
//
// The fix hoists the call above the branches. These tests drive each
// early-returning branch on a FRESH sandbox (so nothing else could have
// installed the handlers) and assert a chip click actually reaches
// _openAttrPopover.
//
// Same vm-context harness as attr-vote-repaint.test.js.
//
// Run with: node --test tests/dev-topic-deep-link-chips.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function fakeEl(extra) {
  const el = {
    innerHTML: '',
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
  };
  el.remove = () => {};
  return Object.assign(el, extra || {});
}

// A document stub that RECORDS its document-level listeners, so a test can
// fire a synthetic click the way a real user's tap would arrive.
function makeSandbox() {
  const listeners = {};
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 }, currentApp: 'puzzlechain-6cf8ff', currentSubTab: 'dev' },
    document: {
      getElementById: (id) => (id === 'app-content' ? fakeEl() : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: (type, fn) => {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      createElement: () => fakeEl(),
      body: { appendChild: () => {} },
    },
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
  return { AppView: sandbox.__AppView, sandbox, listeners };
}

// Stub everything renderDevView reaches EXCEPT _attrInit, which is the
// thing under test.
function stubBranches(AppView, calls) {
  AppView._setSurface = () => {};
  AppView._saveFeedScroll = () => {};
  AppView._renderTopicSubView = async () => { calls.topic = (calls.topic || 0) + 1; };
  AppView._renderChatSubView = () => { calls.chat = (calls.chat || 0) + 1; };
  AppView.renderDevChatTab = async () => { calls.session = (calls.session || 0) + 1; };
}

// Fire a synthetic document click whose target matches `selector`, and
// report whether it reached the handler under test.
function clickMatching(listeners, selector, node) {
  const evt = {
    target: { closest: (sel) => (sel === selector ? node : null) },
    preventDefault: () => {},
    stopPropagation: () => {},
  };
  (listeners.click || []).forEach((fn) => fn(evt));
}

test('deep link to a proposal topic wires the chip handlers (regression)', async () => {
  const { AppView, sandbox, listeners } = makeSandbox();
  const calls = {};
  stubBranches(AppView, calls);

  let opened = null;
  AppView._openAttrPopover = (chip) => { opened = chip; };

  // Exactly what a pasted #app/<slug>/dev/proposals/3431 produces: the
  // topic branch, on a page where the card list has never rendered.
  await AppView.renderDevView('topic', { kind: 'proposal', id: 3431 });

  assert.equal(calls.topic, 1, 'the topic branch still renders');
  assert.equal(AppView._attrInited, true,
    '_attrInit must run before renderDevView branches into the topic view');

  const chip = fakeEl({ dataset: { attrField: 'priority' } });
  clickMatching(listeners, '[data-attr-chip]', chip);
  assert.equal(opened, chip,
    'clicking a priority/category/assignee chip must open its dropdown');
});

test('deep link to a proposal topic wires the "How voting works" popover', async () => {
  const { AppView, listeners } = makeSandbox();
  stubBranches(AppView, {});

  let helpAnchor = null;
  AppView._openVotingHelpPopover = (anchor) => { helpAnchor = anchor; };
  AppView._findTopicItem = () => ({ id: 3431 });

  await AppView.renderDevView('topic', { kind: 'proposal', id: 3431 });

  const btn = fakeEl({});
  clickMatching(listeners, '[data-voting-help]', btn);
  assert.equal(helpAnchor, btn, 'the "?" / "How voting works" affordance must open the popover');
});

test('every early-returning Dev sub-view installs the handlers too', async () => {
  // The topic branch is not special — chat and session return early from
  // the same function, and an issue topic renders the same chips.
  for (const [subTab, ref] of [
    ['topic', { kind: 'issue', id: 42 }],
    ['chat', null],
    ['sessions', 7],
  ]) {
    const { AppView } = makeSandbox();
    stubBranches(AppView, {});
    await AppView.renderDevView(subTab, ref);
    assert.equal(AppView._attrInited, true, `sub-view "${subTab}" must wire the chip handlers`);
  }
});

test('the card list still wires them (the path that always worked)', async () => {
  const { AppView } = makeSandbox();
  stubBranches(AppView, {});
  // The card-list branch paints a lot more DOM than this stub can satisfy;
  // what matters is that _attrInit has already run by the time it starts.
  await AppView.renderDevView('forum', null).catch(() => {});
  assert.equal(AppView._attrInited, true);
});

test('source guard: _attrInit is called from renderDevView above the branches', () => {
  const start = SRC.indexOf('async renderDevView(');
  assert.ok(start > 0, 'renderDevView is still in app-view.js');
  const initAt = SRC.indexOf('AppView._attrInit();', start);
  const firstBranchReturn = SRC.indexOf('await AppView.renderDevChatTab(ref);', start);
  assert.ok(initAt > start, 'renderDevView still calls _attrInit');
  assert.ok(firstBranchReturn > start, 'the session branch is still the first early return');
  assert.ok(initAt < firstBranchReturn,
    '_attrInit must sit ABOVE the first early-returning sub-view branch — '
    + 'below it, deep-linked topic pages get dead chips again');
});
