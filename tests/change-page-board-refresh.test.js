'use strict';

// #6001: a change open beside the Workshop, or on its own page, caught up
// with its board row only when a live event named it. A board reload (the
// hub's 30 second tick, a burst with no ids, a direct caller) moved the row
// to Going live while the page beside it stayed on "Testing: under a minute
// left" until it was reopened, and a finished release never reached it at
// all. These tests pin the two seams: AppView._refreshOpenChangeFromBoard,
// which hands a moved row to the open page, and
// AppView.refreshOpenChangeForRelease, which a redeploy asks to re-read.
//
// Run with: node --test tests/change-page-board-refresh.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const appJs = read('public/js/app.js');
const appViewJs = read('public/js/app-view.js');

function sliceMember(src, signature) {
  const start = src.indexOf(`\n  ${signature}`);
  assert.ok(start >= 0, `${signature} is defined`);
  const close = '\n  },';
  const end = src.indexOf(close, start);
  return src.slice(start + 1, end + close.length);
}

const promoted = (patch = {}) => ({
  id: 42, status: 'promoted', check_state: 'pending', check_phase: 'preview',
  checks_checked_at: '2026-10-28T10:00:00Z', yes_count: 1,
  deployment_state: null, live_at: null, ...patch,
});
const merged = (patch = {}) => ({
  id: 42, status: 'merged', check_state: 'success', check_phase: null,
  checks_checked_at: '2026-10-28T10:05:00Z', yes_count: 1,
  deployment_state: 'deploying', live_at: null, ...patch,
});

// The members under test run for real; only the things they call are faked.
function harness({
  topic = { kind: 'proposal', id: 42 }, inPanel = true, subTab = 'forum',
  proposals = [], mergedRows = [], findItem = null, onLoad = null,
} = {}) {
  const events = [];
  const paints = [];
  const loads = [];
  const sandbox = {
    App: {
      currentTab: 'dev',
      currentSubTab: subTab,
      _announceRefreshIntent: () => {},
    },
    AppView: {
      appData: { slug: 'demo' },
      _devDataReady: true,
      _devTopic: topic,
      _devTopicInPanel: inPanel,
      _topicProposal: null,
      _proposals: proposals,
      _mySessions: [],
      _sharedSessions: [],
      _merged: mergedRows,
      _renderTopicHead: () => { paints.push(1); },
      _findTopicItem: () => (findItem ? findItem(sandbox.AppView) : null),
      _loadDevFeed: (opts) => {
        loads.push(opts);
        if (onLoad) onLoad(sandbox.AppView, opts);
        return Promise.resolve(true);
      },
      _loadDevData: () => Promise.resolve(true),
      _refreshTopicOnDemandRow: () => Promise.resolve(true),
      _partsForLive: () => new Set(['merged']),
      _liveTouchesVotes: () => true,
      _invalidateVoteRoster: () => {},
      _loadVoteRoster: () => Promise.resolve(true),
    },
    window: {
      dispatchEvent: (event) => { events.push(event.detail); return true; },
    },
    document: { hidden: false },
    CustomEvent: class {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    Set,
    Promise,
    Number,
    Object,
  };
  vm.createContext(sandbox);
  for (const signature of [
    '_topicRowFor(sessionId) {',
    '_forwardChangePatch(sessionId, patch) {',
    '_tellChangePage(detail) {',
    '_refreshOpenChangeFromBoard() {',
    'refreshOpenChangeForRelease(slug) {',
    'refreshHubLive({ whole = false } = {}) {',
    'refreshDevData(kind, live = null) {',
  ]) {
    vm.runInContext(`Object.assign(AppView, {\n${sliceMember(appViewJs, signature)}});`, sandbox);
  }
  return {
    events, paints, loads, AppView: sandbox.AppView,
    call: (name, ...args) => sandbox.AppView[name](...args),
  };
}

test('#6001: a board reload that moves the open change hands it the row and repaints', async () => {
  const h = harness({ proposals: [promoted()] });
  // The tick that saw it waiting on its checks: the first look only records.
  await h.call('refreshHubLive');
  assert.equal(h.events.length, 0, 'nothing to tell yet: the page is already showing this');
  assert.equal(h.paints.length, 0, 'and nothing to repaint');

  // The vote passed, the row merged and the board's next tick reads Done.
  h.AppView._proposals = [];
  h.AppView._merged = [merged()];
  await h.call('refreshHubLive');

  assert.equal(h.events.length, 1, 'the open page is told once');
  assert.equal(h.events[0].id, 42);
  assert.equal(h.events[0].patch.status, 'merged', 'with the row the board just read');
  assert.equal(h.events[0].patch.deployment_state, 'deploying');
  assert.equal(h.paints.length, 1, 'and the head is repainted from the fresh row');
});

test('#6001: a quiet reload that moved nothing redraws nothing', async () => {
  const h = harness({ proposals: [promoted()] });
  await h.call('refreshHubLive');
  await h.call('refreshHubLive');
  await h.call('refreshHubLive', { whole: true });
  assert.equal(h.events.length, 0, 'no event for a row that did not move');
  assert.equal(h.paints.length, 0, 'and no repaint either');
});

test('#6001: off the page nothing is sent', async () => {
  const closed = harness({ proposals: [promoted()], inPanel: false });
  await closed.call('refreshHubLive');
  closed.AppView._proposals = [];
  closed.AppView._merged = [merged()];
  await closed.call('refreshHubLive');
  assert.equal(closed.events.length, 0, 'the panel is closed: nobody is looking');
  assert.equal(closed.paints.length, 0);

  const issue = harness({ topic: { kind: 'issue', id: 7 }, proposals: [promoted()] });
  await issue.call('refreshHubLive');
  issue.AppView._proposals = [];
  issue.AppView._merged = [merged()];
  await issue.call('refreshHubLive');
  assert.equal(issue.events.length, 0, 'an issue is not a change page');
  assert.equal(issue.paints.length, 0);
});

test('#6001: a burst behind the board reaches the open change after its feed load', async () => {
  const h = harness({
    proposals: [promoted()],
    onLoad: (AppView) => {
      AppView._proposals = [];
      AppView._merged = [merged()];
    },
  });
  h.call('_refreshOpenChangeFromBoard');
  assert.equal(h.events.length, 0, 'the opened panel records before it is told anything');
  await h.call('refreshDevData', 'vote', { kinds: new Set(['vote']), ids: null, merged: true });
  assert.equal(h.events.length, 1, 'the forum burst tells the page once it has read the board');
  assert.equal(h.events[0].patch.status, 'merged');
  assert.equal(h.paints.length, 1);
});

test('#6001: a finished release re-reads the open merged change', () => {
  const row = merged();
  const h = harness({ findItem: () => row });
  assert.equal(h.call('refreshOpenChangeForRelease', 'demo'), true);
  assert.deepEqual(h.events, [42], 'a bare id: the page re-reads its own row');
  assert.equal(h.paints.length, 1, 'and the head repaints');

  assert.equal(h.call('refreshOpenChangeForRelease', 'another-app'), false,
    'another app\'s build is another app\'s news');
  assert.equal(h.events.length, 1);

  const waiting = harness({ findItem: () => promoted() });
  assert.equal(waiting.call('refreshOpenChangeForRelease', 'demo'), false,
    'a change that has not merged is not waiting on a release');
  assert.equal(waiting.events.length, 0);

  const closed = harness({ findItem: () => row, inPanel: false });
  assert.equal(closed.call('refreshOpenChangeForRelease', 'demo'), false,
    'closed panel, and not on its page');
});

test('#6001: both redeploy handlers ask the open change to catch up', () => {
  const redeploy = appJs.slice(appJs.indexOf('  handleAppRedeployStatus(data) {'));
  const endEvent = redeploy.slice(redeploy.indexOf('if (!data.deploying'),
    redeploy.indexOf('\n  },'));
  assert.match(endEvent, /AppView\.refreshOpenChangeForRelease\?\.\(slug\)/,
    'the end of a deploy refreshes the change that was going live');
  assert.doesNotMatch(redeploy.slice(0, redeploy.indexOf('if (!data.deploying')),
    /refreshOpenChangeForRelease/,
    'the start of one does not: nothing has landed yet');

  const version = appJs.slice(appJs.indexOf('  handleAppVersionChanged(data) {'),
    appJs.indexOf('\n  },', appJs.indexOf('  handleAppVersionChanged(data) {')));
  assert.match(version, /AppView\.refreshOpenChangeForRelease\?\.\(slug\)/,
    'a written version means the release finished too');
});

// #6490: the request page reads a change again when its status moves
// (promoted → merged). Without `fresh`, the service worker can answer with the
// copy it saved before the merge, which still says the change is up for a vote.
test('#6490: a change read again after its status moved asks past the service worker', () => {
  const src = read('frontend/src/features/dev-board/topic/thread-changes.tsx');
  const start = src.indexOf('function useChangeViews');
  assert.ok(start >= 0, 'useChangeViews is defined');
  const hook = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(hook, /const seen = useRef<Record<number, string>>\(\{\}\)/, 'each change’s last status is remembered');
  assert.match(hook, /before !== undefined && before !== item\.status/, 'a moved status is recognised');
  assert.match(hook, /readChangeDetail\([\s\S]*?\{ fresh \}\)/, 'and that read skips the saved copy');
});

