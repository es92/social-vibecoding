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
const { govCardHtml, proposalCardHtml, topicHeadHtml } = require('./lib/dev-card-html');

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
  const html = proposalCardHtml(AppView, baseProposal());
  assert.ok(menuHas(AppView, html, /^Withdraw$/), 'Withdraw offered from ⋯');
  // The descriptor's label is the wording, not the markup — the ⋯ rows are
  // built from descriptors so the same list can render as a dropdown or as a
  // touch action sheet.
  assert.ok(!menuHas(AppView, html, /Archive/), 'proposal card never says Archive');
  assert.ok(menuHas(AppView, html, /Open session/), 'Open session still offered');
});

test("someone else's promoted proposal does NOT render Withdraw", () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({ user_id: 999 }));
  assert.ok(!menuHas(AppView, html, /^Withdraw$/), 'not the proposer — no Withdraw');
  assert.ok(!menuHas(AppView, html, /Open session/), 'not the proposer — no Open session');
});

test('my merged proposal does NOT render Withdraw', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({ status: 'merged' }));
  assert.ok(!menuHas(AppView, html, /^Withdraw$/), 'merged card has no Withdraw');
});

test('my merging proposal does NOT render Withdraw', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({ status: 'merging' }));
  assert.ok(!menuHas(AppView, html, /^Withdraw$/), 'merging card has no Withdraw');
});

// Rename and visibility PRs are ordinary promoted chat_sessions rows, so
// the owner-scoped Withdraw button renders on them too.
test('my own rename PR proposal renders Withdraw', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({ pr_title: 'Rename to "Cooler App"' }));
  assert.ok(menuHas(AppView, html, /^Withdraw$/), 'rename PR shows Withdraw in ⋯');
});

// #313/#827: "Explore in dev chat" is offered on proposals the viewer does
// NOT own (where there's no "Open session"), and omitted on their own cards.
// #1787 round four moved it back off the face and into ⋯: it is a door to a
// side conversation ABOUT the proposal rather than one of the things you do
// to it, and at ~170px it was the widest pill on the card, pushing Vote or
// Withdraw into the fold it should have been in itself.
test("someone else's proposal offers Explore-in-dev-chat from ⋯", () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({ user_id: 999 }));
  assert.ok(menuHas(AppView, html, /Explore in a coding agent/),
    'Explore offered from ⋯ on a foreign proposal');
  assert.ok(!html.includes('gc-explore-chat-btn'), 'and not as a pill on the face, so never both');
  assert.equal(html.match(/data-card-menu="([^"]+)"/)[1], 'proposal:7', 'menu keyed by the proposal id');
});

test('my own proposal does NOT render the Explore-in-dev-chat card button', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal());
  assert.ok(!menuHas(AppView, html, /Explore in a coding agent/), 'own card has none (Open session covers it)');
});

test("someone else's merged proposal renders the Explore-in-dev-chat button", () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({ user_id: 999, status: 'merged' }));
  assert.ok(menuHas(AppView, html, /Explore in a coding agent/), 'Explore offered from ⋯ on a foreign merged card');
});

// #1045: the exception to "own cards have none". An imported proposal has no
// platform-owned dev session, so #687 hides "Open session" on it — which
// left the owner of a PR they imported with no AI affordance at all.
test('my own IMPORTED proposal DOES render the Explore-in-dev-chat button (#1045)', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({ source: 'imported' }));
  assert.ok(menuHas(AppView, html, /Explore in a coding agent/),
    'Explore offered from ⋯ on my imported proposal');
  assert.doesNotMatch(html, /openProposalSession/,
    'still no Open session — an imported PR has no dev session (#687)');
  assert.ok(menuHas(AppView, html, /^Withdraw$/), 'Withdraw is unaffected — a ⋯ row like any own live PR');
});

// #321/#827: the topic detail view (_renderTopicHead) shows exactly ONE AI
// affordance — the card's gc-explore-chat-btn PILL. The old standalone
// #proposal-ask-ai button is gone entirely: it was the governance-only
// entry point into the retired advisor panel, and governance proposals get
// no replacement (#827).
//
// #1367's topic chunk turned the head into a React island, so
// `_renderTopicHead` publishes a view model instead of assigning innerHTML
// and binding the pill by hand. The harness below captures that publish and
// renders it, which is strictly more than the string version could check:
// the pill's WIRING is in the model, so "painted but inert" is now visible
// as a missing `explore` field rather than only as a missing listener.
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
  // The head mounts through the devBoard bridge; capture what it publishes.
  const published = [];
  sandbox.UsernodeReact = {
    devBoard: {
      mountTopicHead: () => {},
      publishTopicHead: (state) => { published.push(state); },
      publishAiEnabled: () => {},
    },
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
  // The head's markup, from the last publish — the two halves composed
  // exactly as the store composes them at runtime.
  const headHtml = () => {
    const last = published[published.length - 1];
    return last ? topicHeadHtml(JSON.parse(JSON.stringify(last.card)),
      JSON.parse(JSON.stringify(last.body))) : '';
  };
  return { AppView, els, opened, published, headHtml };
}

// A fake #gc-thread-head. It is a MOUNT HOST now rather than an innerHTML
// sink — `_fillKudosHosts` is the only thing that still reads inside it.
function fakeHead() {
  return {
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

/** The `explore` pill's session id, from the published model. */
function explorePillId(state) {
  const a = state && state.body && state.body.actions;
  const pill = a && a.pills.find((p) => p.explore != null);
  return pill ? pill.explore : null;
}

test("topic head for another user's proposal puts Explore on the card's band, not in More", () => {
  const { AppView, els, published, headHtml } = makeTopicHarness(ME);
  els['gc-thread-head'] = fakeHead();
  AppView._devTopic = { kind: 'proposal', id: 7 };
  AppView._findTopicItem = () => baseProposal({ user_id: 999 });

  AppView._renderTopicHead();

  const html = headHtml();
  // The change page's band carries what a reader most often does next,
  // Explore first (card/dev-card.tsx draws the `explore` action as the
  // gc-explore-chat-btn pill), so the ⋯ menu no longer repeats it.
  assert.match(html, /gc-explore-chat-btn[^>]*data-proposal-id="7"/, 'Explore is a pill on the band');
  const menu = AppView._cardMenus[published.at(-1).card.rail.menuKey];
  assert.equal(menu.filter((a) => a.icon === 'explore').length, 0, 'and is not repeated in ⋯');
  const band = published.at(-1).card.actions.find((a) => a.explore != null);
  assert.equal(band && band.explore, 7, 'the band pill carries the session it opens');
  assert.doesNotMatch(html, /id="proposal-ask-ai"/, 'the retired standalone is gone');
  assert.equal(explorePillId(published[published.length - 1]), 7,
    'the pill carries the session it opens — a painted-but-inert pill is a '
    + 'missing field here, not a missing listener');
});

test("topic head for the viewer's OWN proposal shows no AI button", () => {
  // #348: owners reach the Mayor via "Open session" on their own PR, so the
  // detail view shows no pill (matching the card behaviour from #313).
  const { AppView, els, published, headHtml } = makeTopicHarness(ME);
  els['gc-thread-head'] = fakeHead();
  AppView._devTopic = { kind: 'proposal', id: 7 };
  AppView._findTopicItem = () => baseProposal({ user_id: ME });

  AppView._renderTopicHead();

  const html = headHtml();
  assert.ok(html, 'the head did paint — the assertions below are not vacuous');
  assert.doesNotMatch(html, /id="proposal-ask-ai"/, 'no standalone button');
  assert.doesNotMatch(html, /gc-explore-chat-btn/, 'no card pill on own proposal');
  assert.equal(explorePillId(published[published.length - 1]), null);
});

test("topic head for the viewer's OWN IMPORTED proposal puts Explore on the band (#1045)", () => {
  // The head has no delegated handler, so it must both PAINT the pill and
  // bind it — a head whose gate disagrees with the card leaves an inert
  // button. This is the case that regressed: mine && imported.
  const { AppView, els, published, headHtml } = makeTopicHarness(ME);
  els['gc-thread-head'] = fakeHead();
  AppView._devTopic = { kind: 'proposal', id: 7 };
  AppView._findTopicItem = () => baseProposal({ user_id: ME, source: 'imported' });

  AppView._renderTopicHead();

  const last = published[published.length - 1];
  assert.match(headHtml(), /gc-explore-chat-btn[^>]*data-proposal-id="7"/, 'Explore is a pill on the band');
  assert.equal(AppView._cardMenus[last.card.rail.menuKey].filter((a) => a.icon === 'explore').length, 0,
    'and is not repeated in ⋯');
  assert.equal((last.card.actions.find((a) => a.explore != null) || {}).explore, 7, 'the band pill is wired');
  assert.ok(!last.body.actions.pills.some((p) => p.key === 'session'),
    'still no Open session (#687)');
  assert.equal(explorePillId(last), 7, 'and the pill knows which session to open');
});

test('topic head for a governance proposal has NO AI button at all (#827)', () => {
  // A dev chat can't act on a rename / secret change / close-issue vote, so
  // the governance-only standalone button was dropped with no replacement.
  const { AppView, els, headHtml } = makeTopicHarness(ME);
  els['gc-thread-head'] = fakeHead();
  AppView._devTopic = { kind: 'gov', id: 5 };
  AppView._findTopicItem = () => ({
    id: 5, kind: 'gov', title: 'Adopt a code of conduct',
    created_by_username: 'someone', created_at: '2026-06-01T00:00:00Z',
    up_count: 0, down_count: 0, chat_count: 0,
  });

  AppView._renderTopicHead();

  const html = headHtml();
  assert.match(html, /Adopt a code of conduct/, 'the head did paint the gov card');
  assert.doesNotMatch(html, /id="proposal-ask-ai"/, 'standalone Ask AI removed');
  assert.doesNotMatch(html, /gc-explore-chat-btn/, 'gov cards have no Explore pill');
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
  const html = govCardHtml(AppView, baseGov());
  assert.ok(menuHas(AppView, html, /^Withdraw$/), 'Withdraw offered from ⋯');
});

test("someone else's governance proposal does NOT render Withdraw", () => {
  const AppView = makeAppView(ME);
  const html = govCardHtml(AppView, baseGov({ created_by: 999 }));
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
