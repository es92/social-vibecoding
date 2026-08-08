// Tests for the proposal-card Withdraw control (app-view.js
// _renderProposalCard / _renderGovCard). A proposer-only Withdraw button
// must render on your OWN live (status:'promoted') proposals, beside
// "Open session", and must NOT render on someone else's proposal or on a
// merged/merging card. Governance cards get the equivalent creator-only
// Withdraw button.
//
// app-view.js is a plain browser script (`const AppView = {…}`) that
// defines its own escapeHtml/etc. We load its source into a vm context,
// stub the external globals it reaches (App, Kudos, relTime, window,
// document), expose AppView, and assert on the returned HTML string.
//
// Run with: node --test tests/archive-proposal-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView(userId, opts) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: userId, canAdminWrite: !!(opts && opts.admin) } },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView.__sandbox = sandbox;
  return AppView;
}

const ME = 42;

// Withdraw and "Explore in dev chat" were card pills; the card-as-pointer
// budget demoted both into the ⋯ menu, whose descriptors live in
// AppView._cardMenus keyed by the trigger's data-card-menu.
function menuLabels(AppView, html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  if (!m) return [];
  return (AppView._cardMenus[m[1]] || []).map((it) => it.label);
}
function menuHas(AppView, html, re) {
  return menuLabels(AppView, html).some((l) => re.test(l));
}
const baseProposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'me',
  user_id: ME, status: 'promoted', created_at: '2026-06-01T00:00:00Z',
  ...over,
});

test('my own promoted proposal renders the Withdraw control', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal());
  assert.ok(menuHas(AppView, html, /^Withdraw$/), 'Withdraw offered from ⋯');
  // The descriptor's label is the wording, not the markup — the ⋯ rows are
  // built from descriptors so the same list can render as a dropdown or as a
  // touch action sheet.
  assert.ok(!menuHas(AppView, html, /Archive/), 'proposal card never says Archive');
  assert.ok(menuHas(AppView, html, /Open session/), 'Open session still offered');
});

test("someone else's promoted proposal does NOT render Withdraw", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ user_id: 999 }));
  assert.ok(!menuHas(AppView, html, /^Withdraw$/), 'not the proposer — no Withdraw');
  assert.ok(!menuHas(AppView, html, /Open session/), 'not the proposer — no Open session');
});

test('my merged proposal does NOT render Withdraw', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ status: 'merged' }));
  assert.ok(!menuHas(AppView, html, /^Withdraw$/), 'merged card has no Withdraw');
});

test('my merging proposal does NOT render Withdraw', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ status: 'merging' }));
  assert.ok(!menuHas(AppView, html, /^Withdraw$/), 'merging card has no Withdraw');
});

// Rename and visibility PRs are ordinary promoted chat_sessions rows, so
// the owner-scoped Withdraw button renders on them too.
test('my own rename PR proposal renders Withdraw', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ pr_title: 'Rename to "Cooler App"' }));
  assert.ok(menuHas(AppView, html, /^Withdraw$/), 'rename PR shows Withdraw in ⋯');
});

// #313/#827: the card-level "Explore in dev chat" button renders on
// proposals the viewer does NOT own (where there's no "Open session"), and is
// omitted on the viewer's own cards.
test("someone else's proposal renders the Explore-in-dev-chat card button", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ user_id: 999 }));
  assert.ok(menuHas(AppView, html, /Explore in dev chat/), 'Explore offered from ⋯ on a foreign proposal');
  assert.equal(html.match(/data-card-menu="([^"]+)"/)[1], 'proposal:7', 'menu keyed by the proposal id');
});

test('my own proposal does NOT render the Explore-in-dev-chat card button', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal());
  assert.ok(!menuHas(AppView, html, /Explore in dev chat/), 'own card has none (Open session covers it)');
});

test("someone else's merged proposal renders the Explore-in-dev-chat button", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ user_id: 999, status: 'merged' }));
  assert.ok(menuHas(AppView, html, /Explore in dev chat/), 'Explore offered from ⋯ on a foreign merged card');
});

// #1045: the exception to "own cards have none". An imported proposal has no
// platform-owned dev session, so #687 hides "Open session" on it — which
// left the owner of a PR they imported with no AI affordance at all.
test('my own IMPORTED proposal DOES render the Explore-in-dev-chat button (#1045)', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ source: 'imported' }));
  assert.match(html, /gc-explore-chat-btn/, 'Explore pill present on my imported proposal');
  assert.match(html, /data-proposal-id="7"/, 'wired to the proposal id');
  assert.doesNotMatch(html, /openProposalSession/,
    'still no Open session — an imported PR has no dev session (#687)');
  assert.match(html, /withdrawProposal\(7\)/, 'Withdraw is unaffected');
});

// #321/#827: the topic detail view (_renderTopicHead) shows exactly ONE AI
// affordance — the card's gc-explore-chat-btn PILL, wired here because the
// head has no delegated handler. The old standalone #proposal-ask-ai button
// is gone entirely: it was the governance-only entry point into the retired
// advisor panel, and governance proposals get no replacement (#827).
function makeTopicHarness(viewerId) {
  const els = {};
  const opened = [];
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: viewerId } },
    Kudos: { renderButton: () => '', attach: () => {} },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({ aiEnabled: true }) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  // Keep AI availability synchronous and configured so the wiring path runs
  // without hitting fetch.
  AppView._ensureAiAvailability = () => Promise.resolve(true);
  // Spy on the opener the pill should reach (the real one navigates away).
  AppView.exploreProposalInDevChat = (...a) => { opened.push(a); };
  return { AppView, els, opened };
}

// A fake #gc-thread-head whose innerHTML setter records the HTML and exposes
// a stub button node for the pill so we can probe click wiring.
function fakeHead() {
  const btnStub = () => ({
    disabled: false,
    title: '',
    classList: { add: () => {}, remove: () => {} },
    _click: null,
    addEventListener(ev, fn) { if (ev === 'click') this._click = fn; },
  });
  return {
    _html: '',
    _pill: null,
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = v;
      this._pill = /gc-explore-chat-btn/.test(v) ? btnStub() : null;
    },
    querySelector(sel) {
      if (sel === '.gc-explore-chat-btn') return this._pill;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.gc-explore-chat-btn') return this._pill ? [this._pill] : [];
      return [];
    },
  };
}

test("topic head for another user's proposal wires the pill to the dev chat", () => {
  const { AppView, els, opened } = makeTopicHarness(ME);
  const head = fakeHead();
  els['gc-thread-head'] = head;
  AppView._devTopic = { kind: 'proposal', id: 7 };
  AppView._findTopicItem = () => baseProposal({ user_id: 999 });

  AppView._renderTopicHead();

  assert.match(head._html, /gc-explore-chat-btn/, 'the pill is present');
  assert.doesNotMatch(head._html, /id="proposal-ask-ai"/, 'the retired standalone is gone');
  assert.ok(head._pill && typeof head._pill._click === 'function', 'pill click is wired');
  head._pill._click();
  assert.deepEqual(opened, [[7, head._pill]],
    'pill click reaches exploreProposalInDevChat with the id and the button node');
});

test("topic head for the viewer's OWN proposal shows no AI button", () => {
  // #348: owners reach the Mayor via "Open session" on their own PR, so the
  // detail view shows no pill (matching the card behaviour from #313).
  const { AppView, els } = makeTopicHarness(ME);
  const head = fakeHead();
  els['gc-thread-head'] = head;
  AppView._devTopic = { kind: 'proposal', id: 7 };
  AppView._findTopicItem = () => baseProposal({ user_id: ME });

  AppView._renderTopicHead();

  assert.doesNotMatch(head._html, /id="proposal-ask-ai"/, 'no standalone button');
  assert.doesNotMatch(head._html, /gc-explore-chat-btn/, 'no card pill on own proposal');
});

test("topic head for the viewer's OWN IMPORTED proposal wires the pill (#1045)", () => {
  // The head has no delegated handler, so it must both PAINT the pill and
  // bind it — a head whose gate disagrees with the card leaves an inert
  // button. This is the case that regressed: mine && imported.
  const { AppView, els, opened } = makeTopicHarness(ME);
  const head = fakeHead();
  els['gc-thread-head'] = head;
  AppView._devTopic = { kind: 'proposal', id: 7 };
  AppView._findTopicItem = () => baseProposal({ user_id: ME, source: 'imported' });

  AppView._renderTopicHead();

  assert.match(head._html, /gc-explore-chat-btn/, 'the pill is present on my imported proposal');
  assert.doesNotMatch(head._html, /openProposalSession/, 'still no Open session (#687)');
  assert.ok(head._pill && typeof head._pill._click === 'function', 'pill click is wired');
  head._pill._click();
  assert.deepEqual(opened, [[7, head._pill]],
    'pill click reaches exploreProposalInDevChat with the id and the button node');
});

test('topic head for a governance proposal has NO AI button at all (#827)', () => {
  // A dev chat can't act on a rename / secret change / close-issue vote, so
  // the governance-only standalone button was dropped with no replacement.
  const { AppView, els } = makeTopicHarness(ME);
  const head = fakeHead();
  els['gc-thread-head'] = head;
  AppView._devTopic = { kind: 'gov', id: 5 };
  AppView._findTopicItem = () => ({
    id: 5, kind: 'gov', title: 'Adopt a code of conduct',
    created_by_username: 'someone', created_at: '2026-06-01T00:00:00Z',
    up_count: 0, down_count: 0, chat_count: 0,
  });

  AppView._renderTopicHead();

  assert.doesNotMatch(head._html, /id="proposal-ask-ai"/, 'standalone Ask AI removed');
  assert.doesNotMatch(head._html, /gc-explore-chat-btn/, 'gov cards have no Explore pill');
});

test('withdrawProposal POSTs to the archive endpoint and reloads the feed', async () => {
  const AppView = makeAppView(ME);
  let posted = null;
  let reloaded = false;
  AppView._proposals = [baseProposal()];
  // fetch/ConfirmModal are resolved against the sandbox global at call
  // time, so patching them post-load drives the real handler.
  AppView.__sandbox.fetch = async (url, init) => {
    posted = { url, method: init && init.method };
    return { ok: true, json: async () => ({}) };
  };
  AppView.__sandbox.ConfirmModal = { show: async () => true };
  AppView._loadDevFeed = async () => { reloaded = true; };
  await AppView.withdrawProposal(7);
  assert.equal(posted.url, '/api/sessions/7/archive', 'POSTs to the owner-scoped archive endpoint');
  assert.equal(posted.method, 'POST');
  assert.equal(reloaded, true, 'feed reloaded on success');
});

test('withdrawProposal does nothing when the confirm is cancelled', async () => {
  const AppView = makeAppView(ME);
  let posted = false;
  AppView._proposals = [baseProposal()];
  AppView.__sandbox.fetch = async () => { posted = true; return { ok: true, json: async () => ({}) }; };
  AppView.__sandbox.ConfirmModal = { show: async () => false };
  AppView._loadDevFeed = async () => {};
  await AppView.withdrawProposal(7);
  assert.equal(posted, false, 'cancelled confirm — no POST');
});

// ---- Governance card Withdraw -------------------------------------------

const baseGov = (over) => ({
  id: 31, kind: 'secret_change', title: 'Set secret API_KEY',
  created_by: ME, created_by_username: 'me', status: 'open',
  payload: { action: 'set', key: 'API_KEY' },
  up_count: 1, down_count: 0,
  created_at: '2026-06-01T00:00:00Z',
  ...over,
});

test('my own governance proposal renders a creator-only Withdraw button', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderGovCard(baseGov());
  assert.ok(menuHas(AppView, html, /^Withdraw$/), 'Withdraw offered from ⋯');
});

test("someone else's governance proposal does NOT render Withdraw", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderGovCard(baseGov({ created_by: 999 }));
  assert.ok(!menuHas(AppView, html, /^Withdraw$/), 'not the creator — no Withdraw');
});

test('withdrawGovProposal POSTs to the gated close endpoint and reloads', async () => {
  const AppView = makeAppView(ME);
  let posted = null;
  let reloaded = false;
  AppView.__sandbox.fetch = async (url, init) => {
    posted = { url, method: init && init.method };
    return { ok: true, json: async () => ({}) };
  };
  AppView.__sandbox.ConfirmModal = { show: async () => true };
  AppView._loadDevFeed = async () => { reloaded = true; };
  await AppView.withdrawGovProposal(31);
  assert.equal(posted.url, '/api/issues/31/close', 'POSTs to the creator-gated close/withdraw endpoint');
  assert.equal(posted.method, 'POST');
  assert.equal(reloaded, true, 'feed reloaded on success');
});
