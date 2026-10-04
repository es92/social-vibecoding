'use strict';

// B7 (decided: "Approve" on a project that is just you). A change on a
// project that is just the viewer's, whose one Yes is the Yes it needs, no
// longer asks them to vote: the status reads "Waiting for your approval",
// the step is "Your approval", the button is one tap, "Approve" (their own
// Yes, which makes it live), and "Don't approve" sits last and red in ⋯, as
// today's No with its line. A group project, a rule asking for more than one
// Yes, or a test account's uncounted vote keeps the vote as it is.
//
// Run with: node --test tests/homeroom-bot-approve-solo.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 42, canAdminWrite: false } },
    Kudos: { renderButton: () => '', attach: () => {}, _ensureCache: () => ({ count: 0 }) },
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
  return AppView;
}

const change = (over) => ({
  id: 7, pr_title: 'Sunday reminder', username: 'homeroom_bot', user_id: 999, status: 'promoted',
  yes_count: 0, no_count: 0, approval_epoch: 3, votes_required: 1, my_vote: null, created_at: '2026-10-01T00:00:00Z', ...over,
});

test('B7: which changes are approved in one tap', () => {
  const AppView = makeAppView();
  AppView.appData = { slug: 'plant-pal', audience: 'solo' };
  assert.equal(AppView._approveSolo(change()), true);
  assert.equal(AppView._approveSolo(change({ votes_required: null })), true, 'no snapshot: one person\'s project needs one');
  assert.equal(AppView._approveSolo(change({ votes_required: 2 })), false, 'a rule asking for two Yes votes keeps the vote');
  assert.equal(AppView._approveSolo(change({ my_vote_uncounted: true })), false, 'a test account\'s vote does not count');
  for (const audience of ['invited', 'open', undefined]) {
    AppView.appData = { slug: 'plant-pal', audience };
    assert.equal(AppView._approveSolo(change()), false, `${audience}: a group votes`);
  }
});

test('B7: the button, the status, the step and ⋯ on a project that is just yours', () => {
  const AppView = makeAppView();
  AppView.appData = { slug: 'plant-pal', audience: 'solo' };
  const [yes, no] = AppView._cardVoteButtonSpecs(change());
  assert.equal(yes.approve, true);
  assert.ok(!('approve' in no));
  const pill = AppView.statusPillState(change());
  assert.equal(pill.label, 'Waiting for your approval');
  assert.equal(pill.dot, true, 'it still says it needs you');
  const summary = AppView._summarizeRequirements(
    [{ key: 'approvals', state: 'waiting', actor: 'group', label: 'Enough approvals' }],
    { hasVoted: false, approveSolo: true },
  );
  assert.equal(summary.headline, 'Waiting for your approval');
  assert.equal(AppView._summarizeRequirements(
    [{ key: 'approvals', state: 'waiting', actor: 'group', label: 'Enough approvals' }], { hasVoted: false },
  ).headline, 'Waiting on your vote', 'a group keeps its words');
  const items = AppView._proposalMenuItems(change(), {});
  const last = items[items.length - 1];
  assert.equal(last.label, 'Don’t approve');
  assert.equal(last.danger, true);
  assert.ok(!AppView._proposalMenuItems(change({ my_vote: 'no' }), {}).some((i) => i.label === 'Don’t approve'), 'once said, not offered again');
  AppView.appData = { slug: 'plant-pal', audience: 'invited' };
  assert.equal(AppView.statusPillState(change({ votes_required: 2 })).label, 'Vote · 0/2');
  assert.ok(!AppView._proposalMenuItems(change(), {}).some((i) => i.label === 'Don’t approve'));
  assert.match(SRC, /const voteStep = AppView\._approveSolo\(item\) \? 'Your approval' : 'Vote';/);
});

test('B7: Approve is one tap, the viewer\'s own Yes, and reads Approved once it is in', () => {
  const { VoteButton } = loadTsx('frontend/src/features/dev-board/card/dev-card.tsx');
  const yes = { key: 'yes', cls: 'gc-vote-btn gc-vote-btn-yes', label: 'Yes (0/1)', act: { fn: 'castVote', args: [7, 'yes', 3] }, solo: true, approve: true };
  const no = { key: 'no', cls: 'gc-vote-btn gc-vote-btn-no', label: 'No (0/1)', act: { fn: 'castVote', args: [7, 'no', 3] } };
  const open = renderToHtml(createElement(VoteButton, { yes, no }));
  assert.match(open, /class="dev-vote-btn dev-vote-btn-approve" data-vote-btn="approve"/);
  assert.match(open, />Approve<\/button>$/);
  assert.ok(!/aria-haspopup/.test(open), 'no picker: nothing to choose between');
  const done = renderToHtml(createElement(VoteButton, { yes: { ...yes, cls: `${yes.cls} gc-vote-active` }, no }));
  assert.match(done, /data-vote-btn="approved"/);
  assert.match(done, /disabled=""/);
  assert.match(done, />Approved<\/button>$/);
  const group = renderToHtml(createElement(VoteButton, { yes: { ...yes, approve: undefined }, no }));
  assert.match(group, /data-vote-btn="open"/, 'a group keeps Vote and its picker');
  const card = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/dev-board/card/dev-card.tsx'), 'utf8');
  assert.match(card, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); send\(yes, null\); \}\}/, 'one tap, no line asked for');
});
