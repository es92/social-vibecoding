// #3800: the Votes card says the vote in words: the tally, when a running
// countdown ends, and how the viewer stands. A percentage appears only under
// a rule that is a percentage of its people.
//
// Run with: node --test tests/change-vote-facts.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const rules = require('../src/services/governance-rules');
const governance = require('../src/services/governance');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function appView({ user = { id: 42, username: 'maya' }, activeUsers = 9, audience = 'open' } = {}) {
  const c = {
    console, App: { user, currentApp: 'usernode-2d5619', currentTab: 'dev', _appUrl: () => '#' },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
    PlatformI18n: englishPlatformI18n(),
  };
  c.window = c;
  vm.createContext(c);
  for (const p of ['public/js/merge-status.js', 'public/js/app-view.js']) vm.runInContext(read(p), c);
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'usernode-2d5619', can_collaborate: true, audience };
  c.av._proposalsCtx = { majority: 2, activeUsers, locked: false };
  c.av._ghIssues = [];
  return c.av;
}

const ROW = {
  id: 700, user_id: 7, username: 'evan', status: 'promoted', source: 'native', pr_number: 700,
  pr_title: 'A change', pr_summary_md: 'Words.', linked_issues: [], yes_count: 2, no_count: 1,
  votes_required: 5, created_at: '2026-10-09T17:00:00Z', check_state: 'passing', test_results: [],
};
const facts = (av, row) => JSON.parse(JSON.stringify(av._changeVotesView({ ...ROW, ...row }, null).facts ?? null));
const fact = (list, key) => (list || []).find((f) => f.key === key) || null;
const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
const pair = (first, second) => message('changes:facts.pair', { first, second });

test('the tally is one line of words, and a zero says nothing', () => {
  const av = appView();
  assert.equal(fact(facts(av, {}), 'tally').text, pair(pair(
    message('changes:page.votes.facts.yes', { count: 2 }),
    message('changes:page.votes.facts.no', { count: 1 }),
  ), message('changes:page.votes.facts.waiting', { count: 6 })));
  assert.equal(fact(facts(av, {}), 'tally').text, '2 yes · 1 no · 6 waiting');
  assert.equal(fact(facts(av, { no_count: 0 }), 'tally').text, '2 yes · 7 waiting');
  assert.equal(fact(facts(appView({ activeUsers: 3 }), {}), 'tally').text, '2 yes · 1 no');
  assert.equal(fact(facts(appView({ activeUsers: 1 }), { yes_count: 0, no_count: 0 }), 'tally'), null);
});

test('only the approvers wait where only they count, and only once they are known', () => {
  const av = appView();
  const invited = { approval_policy: 'invited', qualified_yes_count: 1, qualified_no_count: 0, yes_count: 4 };
  assert.equal(fact(facts(av, invited), 'tally').text, '1 yes');
  av._voteRoster[700] = { phase: 'ready', approvers: 3, yesNames: [] };
  assert.equal(fact(facts(av, invited), 'tally').text, '1 yes · 2 waiting');
});

test('a rules project waits on the people its rule counts, not on every member', () => {
  const av = appView({ activeUsers: 30 });
  const row = {
    approval_mode: 'rules', approval_rule: { kind: 'atLeast', n: 2, electorate: 4, authorYes: false },
    yes_count: 1, no_count: 0,
  };
  assert.equal(fact(facts(av, row), 'tally').text, '1 yes · 3 waiting');
});

test('a tally let in by another rule still counts everybody who voted', () => {
  const av = appView({ activeUsers: 30 });
  const row = {
    approval_mode: 'rules', approval_passed_by: 'creator',
    approval_rule: { kind: 'atLeast', n: 1, electorate: 1, authorYes: false },
    qualified_yes_count: 1, qualified_no_count: 0, yes_count: 3, no_count: 0,
  };
  assert.equal(fact(facts(av, row), 'tally').text, '3 yes');
});

test('a percentage shows only under a percentage rule, as a share of its people', () => {
  const av = appView();
  const percent = (kind) => ({
    approval_mode: 'rules', approval_rule: { kind, n: 60, electorate: 8, authorYes: false }, yes_count: 2, no_count: 1,
  });
  for (const kind of ['percentOfActive', 'percentOfEveryone']) {
    assert.equal(fact(facts(av, percent(kind)), 'tally').text, `2 yes · 1 no · 5 waiting · ${
      message('changes:page.votes.facts.approval', { share: 25, needed: 60 })}`);
  }
  for (const kind of ['atLeast', 'majority']) {
    assert.doesNotMatch(fact(facts(av, percent(kind)), 'tally').text, /%/);
  }
  // The rule most projects have, and the two old columns: no percentage.
  assert.doesNotMatch(fact(facts(av, {}), 'tally').text, /%/);
  assert.doesNotMatch(fact(facts(av, { approvals_required: 2 }), 'tally').text, /%/);
});

test('the row names the rule the card counts for, and its electorate', () => {
  const gate = (rulesList, active, voters) => rules.evaluateRules({
    value: { rules: rulesList },
    facts: { creatorId: 1, memberCount: 10, membersActive: active, adminIds: [], groups: new Map(), activeIds: null },
    voters, counts: { yes: 0, no: 0 }, openedAt: null, now: null, noTimers: false, memberFloor: null,
    mergeGate: () => ({ required: 2, mergeable: false, thresholdMet: false }),
    applyNoTimerMerge: (g) => g,
    atLeastGate: (need) => ({ required: need, mergeable: false, thresholdMet: false }),
  });
  const none = { yes: new Set(), no: new Set() };
  assert.equal(gate([{ group: 'members', kind: 'percentOfActive', n: 50 }], 4, none).shown.electorate, 4);
  assert.equal(gate([{ group: 'members', kind: 'percentOfEveryone', n: 50 }], 4, none).shown.electorate, 10);
  assert.equal(gate([{ group: 'members', kind: 'majority', n: null }], 4, none).shown.electorate, 4);
  // Proposing is no yes (11 Nov 2026), so the rule says nothing about one.
  assert.equal('authorYes' in gate([{ group: 'members', kind: 'atLeast', n: 2 }], 4, none).shown, false);
  assert.deepEqual(governance.ruleRowFields({ mode: 'rules', shownRule: { kind: 'atLeast', n: 1, electorate: 1 } }).approval_rule,
    { kind: 'atLeast', n: 1, electorate: 1 });
  assert.deepEqual(governance.ruleRowFields({ mode: 'default' }), {});
});

test('it says when a running countdown ends, and nothing without one', () => {
  const av = appView();
  const merge = inHours(30);
  const ends = (at) => message('changes:page.votes.facts.ends', {
    when: new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(at)),
  });
  const onMerge = fact(facts(av, { merge_window_ends_at: merge }), 'ends');
  assert.equal(onMerge.text.replace(/\s/g, ' '), ends(merge).replace(/\s/g, ' '));
  const reject = inHours(7);
  const onReject = fact(facts(av, { reject_window_ends_at: reject, rejection_armed: true, yes_count: 1, no_count: 6 }), 'ends');
  assert.equal(onReject.text.replace(/\s/g, ' '), ends(reject).replace(/\s/g, ' '));
  assert.equal(fact(facts(av, {}), 'ends'), null);
  assert.equal(fact(facts(av, { contested: true, merge_window_ends_at: merge }), 'ends'), null);
});

test('the viewer reads their own vote, or that it is wanted', () => {
  const av = appView();
  assert.deepEqual(fact(facts(av, {}), 'mine'), { key: 'mine', ask: true, text: message('changes:page.votes.facts.notVoted') });
  assert.deepEqual(fact(facts(av, { my_vote: 'yes' }), 'mine'), { key: 'mine', text: message('changes:page.votes.facts.youSaidYes') });
  assert.deepEqual(fact(facts(av, { my_vote: 'no' }), 'mine'), { key: 'mine', text: message('changes:page.votes.facts.youSaidNo') });
  // A vote on an earlier version: the card's note words it.
  assert.equal(fact(facts(av, { my_prior_vote: 'yes' }), 'mine'), null);
  // The card asks for no vote while an update is on its way.
  assert.equal(fact(facts(av, { update_coming: true }), 'mine'), null);
  assert.equal(fact(facts(appView({ user: null }), {}), 'mine'), null);
  const ro = appView();
  ro.appData.can_collaborate = false;
  assert.equal(fact(facts(ro, {}), 'mine'), null);
});

test('a proposer is asked for their vote like anyone: proposing is not a yes', () => {
  const av = appView();
  const rule = { kind: 'atLeast', n: 2, electorate: 4 };
  const own = fact(facts(av, { approval_mode: 'rules', approval_rule: rule, user_id: 42 }), 'mine');
  assert.equal(own.ask, true);
  assert.equal(own.text, message('changes:page.votes.facts.notVoted'));
  assert.equal(fact(facts(av, { approval_mode: 'rules', approval_rule: rule }), 'mine').ask, true);
});

test('settled cards, a first version and a project that is only yours keep their own words', () => {
  const av = appView();
  for (const row of [{ status: 'merged' }, { status: 'closed' }, { status: 'active' }, { first_version: true }]) {
    assert.equal(facts(av, row), null, JSON.stringify(row));
  }
  assert.equal(facts(appView({ audience: 'solo' }), { user_id: 42, yes_count: 0, no_count: 0, votes_required: 1 }), null);
});

test('the demo row the shots open reaches every line', () => {
  const av = appView();
  const source = read('src/routes/votes.js');
  assert.match(source, /mk\(9000016, 900116,\s+'[^']+',\s+30, 2, 3, 6, \{ required: 6, rejectEndsAt: hoursAhead\(140\), rejectionArmed: true \}\)/);
  const list = facts(av, {
    id: 9000016, yes_count: 2, no_count: 3, votes_required: 6, my_vote: null,
    reject_window_ends_at: inHours(140), rejection_armed: true,
  });
  assert.deepEqual(list.map((f) => f.key), ['tally', 'ends', 'mine']);
  assert.equal(list[0].text, '2 yes · 3 no · 4 waiting');
});

test('the card draws the lines under its bar and keeps its Vote button where checks find it', () => {
  const { GateCard } = loadTsx('frontend/src/features/dev-board/topic/change-head.tsx');
  const g = {
    name: 'Votes', figure: 'Needs 3 more yes', tone: 'ask', done: false, label: 'x', note: ['A line.'],
    segments: [{ weight: 1, pct: 0, state: 'moving' }],
    facts: [{ key: 'tally', text: '2 yes · 1 no' }, { key: 'mine', ask: true, text: 'You haven’t voted.' }],
  };
  const action = createElement('button', { className: 'dev-vote-btn' }, 'Vote');
  const html = renderToHtml(createElement(GateCard, { which: 'votes', g, action, id: 7 }));
  assert.match(html, /data-change-vote-fact="tally"[^>]*>2 yes · 1 no</);
  assert.match(html, /data-change-vote-fact="mine" data-ask="true"[^>]*>You haven’t voted\.</);
  assert.ok(html.indexOf('dev-change-gate-act') < html.indexOf('dev-change-gate-facts'));
  assert.ok(html.indexOf('dev-change-gate-facts') < html.indexOf('dev-change-gate-note'));
  assert.doesNotMatch(html, /gc-merge-countdown/);
  // #6419: one card now, so its lines are drawn wherever it is, stuck or not.
  assert.match(html, /data-change-gate="votes"/);
});
