// #2365: a closed issue still opens from the proposals that link it.
//
// _ghIssues holds OPEN issues only, so `#app/<slug>/dev/issues/<n>` for the
// issue a merged proposal closed missed _findItem and bounced to the board.
// The topic view now fetches that one issue (GET /github-issues/:number)
// into _topicIssue, the issue twin of _topicGov. This file covers:
//   1. _fetchIssueByNumber caches the row; _findItem resolves it, keyed by
//      number AND app, after the live list.
//   2. openTopic drops it; a miss or an answer for an app the view left
//      leaves the cache alone.
//   3. A closed issue's page offers no work: no Start work, no claim, no
//      kudos pledge, no Propose to close — and says Closed instead.
//
// Same vm harness as gov-fetch-on-demand.test.js.
//
// Run with: node --test tests/closed-issue-topic.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView({ fetchImpl } = {}) {
  const sandbox = {
    console,
    URLSearchParams,
    location: { search: '' },
    App: { user: { id: 1, username: 'me' }, currentApp: 'demo', switchTab() {} },
    Kudos: { renderButton: () => '' },
    PlatformUI: { toast() {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({}) })),
    requestAnimationFrame: (fn) => fn(),
    alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo' };
  AppView._ghIssues = [];
  AppView._govProposals = [];
  return { AppView, sandbox };
}

// Shaped like GET /api/apps/:slug/github-issues/:number answers it.
const closedIssue = (over) => ({
  number: 1069,
  title: 'Toggle resets after refresh',
  body: 'Steps.',
  labels: [],
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-09T00:00:00Z',
  htmlUrl: 'https://github.com/o/r/issues/1069',
  user: 'someone',
  state: 'closed',
  closedAt: '2026-06-09T00:00:00Z',
  bounty_count: 0,
  my_bounty: false,
  created_by_username: 'someone',
  headless: null,
  in_progress: null,
  myPrSessionId: null,
  chatCount: 2,
  lastMessageAt: null,
  title_fallback: false,
  priority: { top: null, count: 0, myValue: null },
  assignee: { top: null, count: 0, myValue: null },
  category: { top: null, count: 0, myValue: null },
  ...over,
});

test('_fetchIssueByNumber caches a closed issue and _findItem resolves it', async () => {
  const row = closedIssue();
  let seen = null;
  const { AppView } = makeAppView({
    fetchImpl: async (url) => {
      seen = url;
      return { ok: true, json: async () => ({ issue: row }) };
    },
  });
  const out = await AppView._fetchIssueByNumber(1069);
  assert.match(seen, /\/api\/apps\/demo\/github-issues\/1069$/, 'hits the single-issue endpoint');
  assert.equal(out, row);
  AppView._devTopic = { kind: 'issue', id: 1069 };
  assert.equal(AppView._findTopicItem(), row, 'resolved via _topicIssue');

  // The live list still wins when it holds the number.
  const live = closedIssue({ state: 'open', title: 'live copy' });
  AppView._ghIssues = [live];
  assert.equal(AppView._findItem('issue', 1069), live);
});

test('_topicIssue never resolves for another number or another app', async () => {
  const { AppView } = makeAppView({
    fetchImpl: async () => ({ ok: true, json: async () => ({ issue: closedIssue() }) }),
  });
  await AppView._fetchIssueByNumber(1069);
  assert.equal(AppView._findItem('issue', 1070), null, 'keyed by number');
  AppView.appData = { slug: 'other-app' };
  assert.equal(AppView._findItem('issue', 1069), null, 'issue numbers repeat across apps');
});

test('_fetchIssueByNumber leaves the cache alone on a miss or after the app changed', async () => {
  let respond = async () => ({ ok: false, status: 404, json: async () => ({ error: 'Issue not found' }) });
  const { AppView } = makeAppView({ fetchImpl: (...a) => respond(...a) });
  assert.equal(await AppView._fetchIssueByNumber(1069), null);
  assert.equal(AppView._topicIssue, null, 'untouched on a 404');

  respond = async () => {
    AppView.appData = { slug: 'other-app' }; // navigated away mid-fetch
    return { ok: true, json: async () => ({ issue: closedIssue() }) };
  };
  assert.equal(await AppView._fetchIssueByNumber(1069), null);
  assert.equal(AppView._topicIssue, null, 'a stale app answer is dropped');
});

test('openTopic clears a previously cached issue', () => {
  const { AppView } = makeAppView();
  AppView._topicIssue = closedIssue();
  AppView._topicIssueSlug = 'demo';
  AppView.openTopic('issue', 12);
  assert.equal(AppView._topicIssue, null);
  assert.equal(AppView._topicIssueSlug, null);
});

test('a closed issue page offers no claim, kudos, close or start-work actions', () => {
  const { AppView } = makeAppView();
  const issue = closedIssue();

  const detail = AppView._detailActionsView('issue', issue);
  const pillKeys = detail ? detail.pills.map((p) => p.key) : [];
  for (const key of ['claim', 'bounty', 'close']) {
    assert.ok(!pillKeys.includes(key), `no ${key} pill on the detail view`);
  }

  for (const noNav of [true, false]) {
    const card = AppView._issueCardModel(issue, { noNav });
    assert.equal(card.actions.length, 0, `no card actions (noNav=${noNav})`);
    const menuLabels = (AppView._cardMenus[card.rail.menuKey] || []).map((m) => m.label);
    for (const label of ['Pledge kudos', 'Claim this issue', 'Propose to close', 'Start more work']) {
      assert.ok(!menuLabels.includes(label), `no "${label}" menu row (noNav=${noNav})`);
    }
    assert.ok(menuLabels.includes('Share to…'), 'sharing it still works');
    assert.deepEqual([...card.badges.map((b) => b.label)], ['Closed'], 'says Closed, and nothing to vote on');
    assert.equal(card.title.edit, undefined, 'no title edit on a closed issue');
  }

  // The whole topic screen, as _renderTopicHead publishes it: the card's one
  // action line folds the detail pills in, so it is empty too, and the
  // comments section still loads.
  const view = AppView._topicViewFor('issue', issue);
  assert.equal(view.card.actions.length, 0, 'no actions on the topic card');
  assert.equal(view.body.comments, true, 'the GitHub comment thread still renders');

  // …while the same issue open keeps every one of them.
  const open = closedIssue({ state: 'open', closedAt: null });
  const openKeys = AppView._detailActionsView('issue', open).pills.map((p) => p.key);
  for (const key of ['claim', 'bounty', 'close']) assert.ok(openKeys.includes(key), `open issue keeps ${key}`);
  const openCard = AppView._issueCardModel(open, { noNav: true });
  assert.ok(openCard.actions.some((a) => a.label === 'Build it yourself'), 'open issue keeps Build it yourself (B8)');
  assert.ok(!openCard.badges.some((b) => b.label === 'Closed'));
});

test('a proposal’s issue chip takes the cached closed issue’s title', () => {
  const { AppView } = makeAppView();
  AppView._topicIssue = closedIssue();
  AppView._topicIssueSlug = 'demo';
  const body = { details: { ledger: [], linked: [] } };
  const card = { rail: {}, meta: [] };
  AppView._completeChangeView({ id: 5, status: 'merged', linked_issues: [1069, 7] }, card, body);
  assert.equal(body.issues[0].title, 'Toggle resets after refresh');
  assert.equal(body.issues[1].title, 'Issue #7');
});
