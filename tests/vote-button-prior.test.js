'use strict';

// #1688: a Yes on an earlier version of a proposal asks "Still yes?".
//
// When the author pushes a new version, the votes on the old one stop
// counting but stay on their rows, and /promoted names the viewer's own as
// `my_prior_vote`. The card's vote button then reads "Still yes?" rather
// than "Vote", and one tap carries the earlier Yes onto this version —
// the button's face, its data attribute and its title all say so. Pins:
//
//   1. `_cardVoteButtonSpecs` hands the prior side on with the Yes spec,
//      only while the viewer has no counted vote;
//   2. the rendered button: face, class and `data-vote-btn`;
//   3. a counted vote, or none at all, draws exactly what it drew before.
//
// Run with: node --test tests/vote-button-prior.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { proposalCardHtml } = require('./lib/dev-card-html');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView(userId) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: userId, canAdminWrite: false } },
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>', attach: () => {} },
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
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._mergedCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView.__sandbox = sandbox;
  return AppView;
}

const ME = 42;
// An OPEN vote: more yeses are still needed, so #6505's decided guard leaves
// the pair alone. The #6505 cases below set their own `votes_required`.
const proposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'evan',
  user_id: 999, status: 'promoted', yes_count: 1, no_count: 0, approval_epoch: 3,
  votes_required: 99, created_at: '2026-06-01T00:00:00Z', ...over,
});

test('the model carries the prior side on the Yes spec, only while nothing of the viewer\'s counts', () => {
  const AppView = makeAppView(ME);
  const [yes, no] = AppView._cardVoteButtonSpecs(proposal({ my_vote: null, my_prior_vote: 'yes' }));
  assert.equal(yes.prior, 'yes');
  assert.ok(!('prior' in no), 'the No spec carries nothing extra');
  assert.deepEqual(JSON.parse(JSON.stringify(yes.act)), { fn: 'castVote', args: [7, 'yes', 3] }, 'the same call, same epoch: the server does the carrying');
  const [counted] = AppView._cardVoteButtonSpecs(proposal({ my_vote: 'yes', my_prior_vote: 'yes' }));
  assert.ok(!('prior' in counted), 'a counted vote is not a prior one');
  const [fresh] = AppView._cardVoteButtonSpecs(proposal({ my_vote: null, my_prior_vote: null }));
  assert.ok(!('prior' in fresh));
  const [odd] = AppView._cardVoteButtonSpecs(proposal({ my_vote: null, my_prior_vote: 'maybe' }));
  assert.ok(!('prior' in odd), 'only the two sides');
});

test('the button asks "Still yes?", and says in its title what one tap does', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, proposal({ my_vote: null, my_prior_vote: 'yes' }));
  const btn = html.match(/<button[^>]*class="dev-vote-btn[^"]*"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(btn, 'the one vote button');
  assert.match(btn[0], /class="dev-vote-btn dev-vote-btn-prior"/);
  assert.match(btn[0], /data-vote-btn="prior-yes"/);
  assert.match(btn[0], /title="You said yes to an earlier version\. One tap carries it onto this one\."/);
  assert.match(btn[0], />Still yes\?</);
  assert.doesNotMatch(btn[0], />Vote</);
});

test('a counted vote, or none at all, draws what it always drew', () => {
  const AppView = makeAppView(ME);
  const fresh = proposalCardHtml(AppView, proposal({ my_vote: null }));
  assert.match(fresh, /class="dev-vote-btn" data-vote-btn="open"/);
  assert.match(fresh, />Vote</);
  assert.doesNotMatch(fresh, /Still yes|dev-vote-btn-prior/);
  const voted = proposalCardHtml(AppView, proposal({ my_vote: 'yes', my_prior_vote: 'yes' }));
  assert.match(voted, /class="dev-vote-btn dev-vote-btn-yes" data-vote-btn="yes"/);
  assert.doesNotMatch(voted, /Still yes|dev-vote-btn-prior/);
  const priorNo = proposalCardHtml(AppView, proposal({ my_vote: null, my_prior_vote: 'no' }));
  assert.match(priorNo, /class="dev-vote-btn" data-vote-btn="open"/, 'an earlier No is not asked back: it stopped nothing');
});

test('the live card\'s band carries the kudos slot the thanks pill lands in; not for a read-only viewer', () => {
  const AppView = makeAppView(ME);
  const model = AppView._proposalCardModel(proposal({ my_vote: null, my_prior_vote: 'yes' }));
  const kudos = (model.actions || []).filter((a) => a.kudos != null);
  assert.equal(kudos.length, 1, 'one slot');
  assert.equal(kudos[0].kudos, 7, 'keyed by the proposal, for _fillKudosHosts');
  const html = proposalCardHtml(AppView, proposal({ my_vote: null, my_prior_vote: 'yes' }));
  assert.match(html, /<div class="gc-card-actions"[^>]*><span class="contents" data-kudos-host="7"><\/span>/);

  AppView.appData = { slug: 'x', can_collaborate: false };
  const ro = AppView._proposalCardModel(proposal({ my_vote: null }));
  assert.equal((ro.actions || []).length, 0, 'a read-only viewer gets neither the vote nor the slot');
  delete AppView.appData;
  const head = AppView._proposalCardModel(proposal({ my_vote: null }), { noNav: true });
  assert.equal((head.actions || []).filter((a) => a.kudos != null).length, 0, 'the detail head lists its own');
});

// #22: the Yes spec also says when the project is just the viewer's
// (`audience` 'solo', from the app's own record, AppView.appData), so the
// picker's optional Yes line is a note rather than "a line for the group".
// The governance pair carries it the same way. The No side carries nothing.
test('#22: on a solo project the Yes spec is marked solo, for proposals and group decisions alike', () => {
  const AppView = makeAppView(ME);
  AppView.appData = { slug: 'plant-pal', can_collaborate: true, audience: 'solo' };
  const [yes, no] = AppView._cardVoteButtonSpecs(proposal({ my_vote: null }));
  assert.equal(yes.solo, true);
  assert.ok(!('solo' in no), 'the No side is worded the same either way');
  assert.equal(yes.prior, undefined, 'and nothing else changes');

  for (const audience of ['invited', 'open', undefined]) {
    AppView.appData = { slug: 'plant-pal', can_collaborate: true, audience };
    const [groupYes] = AppView._cardVoteButtonSpecs(proposal({ my_vote: null }));
    assert.ok(!('solo' in groupYes), `${audience}: a group, or nothing said, keeps "for the group"`);
  }

  AppView.appData = { slug: 'plant-pal', can_collaborate: true, audience: 'solo' };
  AppView._govProposals = [];
  const gov = AppView._govCardModel({
    id: 31, kind: 'rename', title: 'Rename the app', status: 'open', payload: {},
    up_count: 0, down_count: 0, my_vote: null, created_at: '2026-06-01T00:00:00Z', username: 'evan',
  });
  const govYes = (gov.actions || []).find((a) => a.key === 'yes');
  assert.ok(govYes, 'the group decision offers its vote');
  assert.equal(govYes.solo, true);
  assert.ok(!('solo' in (gov.actions || []).find((a) => a.key === 'no')));
  delete AppView.appData;
});

test('a vote spec carries its count beside its label, and the count is exactly what the label\'s parentheses held', () => {
  const AppView = makeAppView(ME);
  // Before the text moved, the card read the count back out of "Yes (N)".
  // The spec now says it once more on its own; in English the two agree.
  const inParens = (label) => (/\(([^)]*)\)\s*$/.exec(label) || [])[1];
  for (const over of [
    { yes_count: 1, no_count: 0 },
    { yes_count: 12, no_count: 3 },
    { yes_count: 3, no_count: 1, qualified_yes_count: 2, qualified_no_count: 0, approval_policy: 'invited' },
    { yes_count: 0, no_count: 0, qualified_yes_count: 0, qualified_no_count: 0, approval_policy: 'invited' },
  ]) {
    const [yes, no] = AppView._cardVoteButtonSpecs(proposal(over));
    assert.equal(yes.tally, inParens(yes.label), yes.label);
    assert.equal(no.tally, inParens(no.label), no.label);
    assert.ok(yes.tally.length > 0);
  }
});

test('the plain vote pill says so in a field, so nothing has to recognise its English word', () => {
  const AppView = makeAppView(ME);
  const states = [
    proposal({ my_vote: null }), proposal({ my_vote: 'yes' }), proposal({ status: 'merged' }),
    proposal({ my_vote: null, yes_count: 0 }), proposal({ my_vote: null, approval_policy: 'invited', qualified_yes_count: 0 }),
  ].map((p) => AppView.statusPillState(p)).filter(Boolean);
  assert.ok(states.some((s) => s.plainVote), 'a proposal the viewer has not voted on shows the plain vote pill');
  for (const s of states) {
    // The old test was /^Vote\b/ on the label; the field is true for exactly those labels.
    assert.equal(!!s.plainVote, /^Vote\b/.test(s.label || ''), `${s.key}: ${s.label}`);
  }
});


// #6505: once the yes votes its rule asks for are in, the card offers no
// vote at all — the request's "felt like I could un-merge it by accident".
// The pair is REMOVED, not greyed: every site that draws the Vote button
// (the card, the change's page, a request's change section, the project's
// Needs you) reads this one pair.
test('#6505: the vote pair is gone once the yes votes the rule asks for are in', () => {
  const AppView = makeAppView(ME);
  assert.equal(AppView._cardVoteButtonSpecs(proposal({ yes_count: 3, votes_required: 3 })).length, 0,
    'at the threshold: no Yes, no No');
  assert.equal(AppView._cardVoteButtonSpecs(proposal({ yes_count: 4, votes_required: 3 })).length, 0,
    'over it is decided too');
  const short = AppView._cardVoteButtonSpecs(proposal({ yes_count: 2, votes_required: 3 }));
  assert.equal(short.map((b) => b.key).join(','), 'yes,no', 'one short still asks');
});

test('#6505: a decided countdown, and an approvals count, lose the pair as well', () => {
  const AppView = makeAppView(ME);
  const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
  assert.equal(AppView._cardVoteButtonSpecs(proposal({
    yes_count: 3, votes_required: 3, merge_window_ends_at: hoursAhead(2),
  })).length, 0, 'counting down to go live is decided');
  assert.equal(AppView._cardVoteButtonSpecs(proposal({
    yes_count: 2, approvals_required: 2,
  })).length, 0, 'approvals mode: its own n is the rule');
});

test('#6505: an unwon countdown, a contested change and one being set aside keep their pair', () => {
  const AppView = makeAppView(ME);
  const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
  const keys = (p) => AppView._cardVoteButtonSpecs(p).map((b) => b.key);
  // Leads, but below its majority: still a vote to win.
  assert.equal(keys(proposal({ yes_count: 1, votes_required: 3, merge_window_ends_at: hoursAhead(2) })).join(','), 'yes,no');
  // Contested: another vote can still change how it ends.
  assert.equal(keys(proposal({ yes_count: 3, votes_required: 3, contested: true })).join(','), 'yes,no');
  // Armed rejection window: same reason, the other way.
  assert.equal(keys(proposal({
    yes_count: 3, votes_required: 3, rejection_armed: true, reject_window_ends_at: hoursAhead(2),
  })).join(','), 'yes,no');
});

test('#6505: the member floor keeps the pair while the other member\'s yes is missing', () => {
  const AppView = makeAppView(ME);
  const keys = (p) => AppView._cardVoteButtonSpecs(p).map((b) => b.key);
  const floor = {
    yes_count: 3, votes_required: 3,
    requires_explicit_approval: true, needs_other_member_yes: true, other_member_yes_count: 0,
  };
  assert.equal(keys(proposal(floor)).join(','), 'yes,no', 'the yes it waits on is still a vote to cast');
  assert.equal(keys(proposal({ ...floor, other_member_yes_count: 1 })).length, 0,
    'once that yes is in, the vote is decided');
});
