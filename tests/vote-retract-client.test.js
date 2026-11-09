'use strict';

// The review flow's Undo, the browser half: AppView.retractVote takes the
// viewer's vote back through DELETE /api/sessions/:id/vote with castVote's
// conventions in reverse.
//
//   1. the cached rows lose the vote at once (my_vote → null, its side's
//      count down one), and get it back, with a toast, when the server
//      refuses or the request never arrives;
//   2. it resolves true only once the server confirmed, and a second press
//      while one is out (a vote or an undo) is refused;
//   3. a load already in flight cannot paint the vote back, and the vote's
//      own memories (the saved vote, the first version's) go with it.
//
// The server half is in tests/vote-retract.test.js.
//
// Run with: node --test tests/vote-retract-client.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView() {
  const toasts = [];
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 42 }, currentApp: 'demo-app', currentTab: 'dev', currentSubTab: 'topic' },
    Kudos: { renderButton: () => '', attach: () => {} },
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
    location: { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
    PlatformUI: { toast: (t) => toasts.push(t) },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.__sandbox = sandbox;
  AppView.__toasts = toasts;
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => {};
  return AppView;
}

const votedRow = (over) => ({
  id: 7, pr_number: 700, status: 'promoted', my_vote: 'yes', yes_count: 2, no_count: 1,
  approval_epoch: 3, ...over,
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ── 1. Optimistic, and put back on a refusal ──────────────────────────

test('the vote leaves the cached rows before the request, and the request is a DELETE with the epoch shown', async () => {
  const AppView = makeAppView();
  const pr = votedRow();
  const chat = votedRow();
  AppView._proposals = [pr];
  AppView.voteState = { bySession: { 7: chat } };
  AppView.refreshDevData = () => {};
  const seen = [];
  AppView._repaintDevBody = () => seen.push(`paint:${pr.my_vote}:${pr.yes_count}/${pr.no_count}`);
  const sending = [];
  AppView._publishVoteSending = (key, side) => sending.push([key, side]);
  AppView.__sandbox.fetch = async (url, init) => {
    seen.push(`fetch:${pr.my_vote}:${chat.my_vote}`);
    seen.push([url, init.method, JSON.parse(init.body)]);
    return { ok: true, status: 200, json: async () => ({ ok: true, retracted: true, vote: 'yes' }) };
  };
  assert.equal(await AppView.retractVote(7, 3), true, 'true once the server confirmed');
  assert.deepEqual(seen, [
    'paint:null:1/1',
    'fetch:null:null',
    ['/api/sessions/7/vote', 'DELETE', { expectedEpoch: 3 }],
  ], 'both rows lose the vote, its side loses one, before the round-trip');
  assert.deepEqual([chat.my_vote, chat.yes_count, chat.no_count], [null, 1, 1], 'the chat\'s own row too, counted once');
  assert.deepEqual(sending, [['castVote:7', 'yes'], ['castVote:7', null]],
    'every Vote button for the change is busy until the answer, then clear');
});

test('a No taken back lowers the No count, not the Yes count', async () => {
  const AppView = makeAppView();
  const pr = votedRow({ my_vote: 'no' });
  AppView._proposals = [pr];
  AppView.refreshDevData = () => {};
  AppView.__sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, retracted: true }) });
  assert.equal(await AppView.retractVote(7), true);
  assert.deepEqual([pr.my_vote, pr.yes_count, pr.no_count], [null, 2, 0]);
});

test('a refusal puts the vote back and says the server\'s words, else the catalog\'s', async () => {
  const AppView = makeAppView();
  const pr = votedRow();
  AppView._proposals = [pr];
  const painted = [];
  AppView._repaintDevBody = () => painted.push(`${pr.my_vote}:${pr.yes_count}`);
  AppView.refreshDevData = async () => {};
  AppView.__sandbox.fetch = async () => ({
    ok: false, status: 409,
    json: async () => ({ error: 'This change is no longer open for voting, so your vote stays as it is.', code: 'vote_locked' }),
  });
  assert.equal(await AppView.retractVote(7, 3), false);
  assert.deepEqual(painted, ['null:1', 'yes:2'], 'taken off, then put back');
  assert.deepEqual(AppView.__toasts, ['This change is no longer open for voting, so your vote stays as it is.']);
  assert.equal(AppView._pendingVotes.size, 0, 'a refused undo is not held over later loads');

  AppView.__toasts.length = 0;
  // A refusal without words of its own reads the catalog's.
  AppView.__sandbox.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await AppView.retractVote(7, 3), false);
  assert.deepEqual(AppView.__toasts, [message('changes:vote.toast.undoFailedHttp', { status: 500 })]);
  assert.equal(pr.my_vote, 'yes');
});

test('a refusal naming the current epoch is what the next press sends', async () => {
  const AppView = makeAppView();
  AppView._proposals = [votedRow()];
  AppView.refreshDevData = async () => {};
  const bodies = [];
  let answer = { ok: false, status: 409, json: async () => ({ headChanged: true, approvalEpoch: 4 }) };
  AppView.__sandbox.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return answer; };
  assert.equal(await AppView.retractVote(7, 3), false);
  answer = { ok: true, status: 200, json: async () => ({ ok: true, unchanged: true }) };
  assert.equal(await AppView.retractVote(7, 3), true, 'nothing to take back is still the server saying it is gone');
  assert.deepEqual(bodies, [{ expectedEpoch: 3 }, { expectedEpoch: 4 }]);
});

test('a request that never arrives puts the vote back and says so', async () => {
  const AppView = makeAppView();
  const pr = votedRow();
  AppView._proposals = [pr];
  AppView.refreshDevData = () => {};
  AppView.__sandbox.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await AppView.retractVote(7, 3), false);
  assert.deepEqual([pr.my_vote, pr.yes_count], ['yes', 2]);
  assert.deepEqual(AppView.__toasts, [message('changes:vote.toast.undoNotSent')]);
  assert.equal(AppView._voteInFlight.size, 0, 'the change is free for the next press');
});

// ── 2. One request per change, shared with castVote ───────────────────

test('a second press while a vote or an undo is out is refused, and no request is sent', async () => {
  const AppView = makeAppView();
  AppView._proposals = [votedRow()];
  AppView.refreshDevData = () => {};
  const gate = deferred();
  let calls = 0;
  AppView.__sandbox.fetch = async () => { calls += 1; await gate.promise; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const first = AppView.retractVote(7, 3);
  assert.equal(await AppView.retractVote(7, 3), false, 'a second undo');
  assert.equal(await AppView.castVote(7, 'yes', 3, { reason: null }), false, 'a vote racing the undo');
  gate.resolve();
  assert.equal(await first, true);
  assert.equal(calls, 1);
});

// ── 3. Nothing paints the vote back ───────────────────────────────────

test('a load already in flight cannot paint the vote back, and the vote\'s memories go with it', async () => {
  const AppView = makeAppView();
  const pr = votedRow();
  AppView._proposals = [pr];
  const refresh = deferred();
  AppView.refreshDevData = () => refresh.promise;
  const saved = [];
  AppView._publishVoteSaved = (id, vote, epoch) => saved.push([id, vote, epoch]);
  AppView.__sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, retracted: true }) });
  // This page cast the Yes earlier: it is remembered as the viewer's own.
  AppView._noteOwnVote(7, 'yes');
  assert.equal(await AppView.retractVote(7, 3), true);

  const stale = votedRow();
  AppView._overlayPendingVote(stale);
  assert.deepEqual([stale.my_vote, stale.yes_count], [null, 1], 'the pre-undo row does not bring the vote back');
  assert.equal(AppView._ownVotes.has(7), false, 'nothing of theirs fills a later row');
  assert.deepEqual(saved, [[7, null, 3]], 'the saved-vote publication hears it is gone');

  refresh.resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(AppView._pendingVotes.size, 0, 'released once the post-undo read lands');
  const fresh = votedRow({ my_vote: null, yes_count: 1 });
  AppView._overlayPendingVote(fresh);
  assert.deepEqual([fresh.my_vote, fresh.yes_count], [null, 1], 'a fresh row is left as the server drew it');
});

test('_applyVoteToRow takes a vote back without counting a side', () => {
  const AppView = makeAppView();
  const row = votedRow({ my_vote: 'yes', yes_count: 0 });
  AppView._applyVoteToRow(row, null);
  assert.deepEqual([row.my_vote, row.yes_count, row.no_count], [null, 0, 1], 'never below zero, No untouched');
  const none = { my_vote: undefined, yes_count: 1, no_count: 1 };
  AppView._applyVoteToRow(none, null);
  assert.deepEqual([none.yes_count, none.no_count], [1, 1], 'no vote to take back moves no count');
});

// ── 4. #6477: the figure every screen draws drops at once ─────────────

test('a counted Yes taken back lowers the qualified figure at once, not only after a reload', async () => {
  const AppView = makeAppView();
  const pr = votedRow({ qualified_yes_count: 6, qualified_no_count: 2 });
  AppView._proposals = [pr];
  AppView.refreshDevData = () => {};
  AppView.__sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, retracted: true }) });
  assert.equal(await AppView.retractVote(7), true);
  assert.deepEqual([pr.qualified_yes_count, pr.qualified_no_count], [5, 2], 'the Yes figure falls by one, and only it');
});

test('a counted No taken back lowers the qualified No, and never raises the Yes', async () => {
  const AppView = makeAppView();
  const pr = votedRow({ my_vote: 'no', qualified_yes_count: 6, qualified_no_count: 2 });
  AppView._proposals = [pr];
  AppView.refreshDevData = () => {};
  AppView.__sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, retracted: true }) });
  assert.equal(await AppView.retractVote(7), true);
  assert.deepEqual([pr.qualified_yes_count, pr.qualified_no_count], [6, 1]);
});

test('an advisory or uncounted vote taken back leaves the qualified figure alone', async () => {
  for (const flag of ['my_vote_uncounted', 'my_vote_advisory']) {
    const AppView = makeAppView();
    const pr = votedRow({ qualified_yes_count: 6, [flag]: true });
    AppView._proposals = [pr];
    AppView.refreshDevData = () => {};
    AppView.__sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, retracted: true }) });
    assert.equal(await AppView.retractVote(7), true);
    assert.equal(pr.qualified_yes_count, 6, `${flag}: it never raised the figure, so it does not lower it`);
  }
});

test('a refusal, or a request that never arrives, puts the qualified figure back with the vote', async () => {
  const answers = [
    async () => ({ ok: false, status: 409, json: async () => ({ code: 'vote_locked', error: 'No.' }) }),
    async () => { throw new TypeError('Failed to fetch'); },
  ];
  for (const answer of answers) {
    const AppView = makeAppView();
    const pr = votedRow({ qualified_yes_count: 6 });
    AppView._proposals = [pr];
    AppView.refreshDevData = async () => {};
    AppView.__sandbox.fetch = answer;
    assert.equal(await AppView.retractVote(7), false);
    assert.deepEqual([pr.my_vote, pr.qualified_yes_count], ['yes', 6], 'the rollback restores both counts');
  }
});
