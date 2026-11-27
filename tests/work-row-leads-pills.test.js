'use strict';

// The one rule (frontend/src/lib/work-state.ts): the stored row gives the
// stage word and the tone on every surface; the live gates add detail under
// it and never change the word.
//
// These are the pills that broke it. A change whose stored row said "Taking
// screenshots" (its tests passed, its before and after shots are still being
// taken, so its vote is not open yet) read "Vote · 0/2" on the board's card,
// in the Workshop's rows and Needs you's facts, and on its line under a
// request, because each read the live vote (AppView.statusPillState) and
// never the row. The change's own header already read the row (_workPill).
//
// Each test hands the surface the row the server sends (tests/lib/
// stored-row.js: the server's own shaping and words) on the board's row as
// the /promoted read attaches it (`work`), runs the real AppView model, and
// reads the real component's markup.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadAppView, plain } = require('./lib/app-view-vm');
const { cardHtml } = require('./lib/dev-card-html');
const { loadTsx, renderToHtml, createElement, renderComponent } = require('./lib/render-tsx');
const { storedRow } = require('./lib/stored-row');

const CHANGES = 'frontend/src/features/dev-board/topic/thread-changes.tsx';
const WORKSHOP = 'frontend/src/features/dev-board/workshop/workshop.tsx';

function appView() {
  const AppView = loadAppView();
  AppView._proposalsCtx = { majority: 2 };
  AppView._visualsOpen = new Set();
  AppView._govProposals = [];
  AppView._voteRoster = {};
  return AppView;
}

const proposal = (over = {}) => ({
  id: 7, pr_number: 4577, pr_title: 'Dark mode toggle', pr_url: 'https://github.com/o/r/pull/4577', status: 'promoted',
  username: 'maya', user_id: 9, created_at: '2026-11-18T09:00:00Z', linked_issues: [], yes_count: 0, no_count: 0,
  votes_required: 2, check_state: 'passing', work: null, ...over,
});

// The rows the derive stores for an open change that is not up for a vote.
const shots = () => storedRow({ stage: 'checking', line: { code: 'shots' } }, { kind: 'change' });
const syncing = () => storedRow({ stage: 'checking', line: { code: 'syncing' } }, { kind: 'change' });
const failing = () => storedRow({ stage: 'checking', line: { code: 'checks_failing', failing: 2 } }, { kind: 'change' });
const upForVote = () => storedRow({ stage: 'up_for_vote', whoseMove: 'group' }, { kind: 'change' });

test('the board\'s card draws the stored row\'s words, and keeps the vote\'s counts behind them', () => {
  const AppView = appView();
  const model = AppView._proposalCardModel(proposal({ work: shots() }));
  assert.equal(model.pill.state.key, 'needs_vote', 'the live vote stays what the change\'s page and its Votes card read');
  assert.equal(model.pill.row.label, 'Taking screenshots');
  assert.equal(model.pill.row.yes, 0);
  assert.equal(model.pill.row.majority, 2, 'the count is the detail it carries');
  const html = cardHtml(plain(model));
  assert.match(html, /Taking screenshots/);
  assert.match(html, /title="Tests passed: only the before and after screenshots are left"/, 'the row\'s second line is the pill\'s title');
  assert.doesNotMatch(html, /Vote · 0\/2/, 'never a vote it is not open for');
  assert.doesNotMatch(html, /dev-status-pill-vote/, 'nor the open vote\'s blue bar');

  // The row tints it: failing tests are the blocked tone, on the pill and the card's spine.
  const bad = cardHtml(plain(AppView._proposalCardModel(proposal({ work: failing(), check_state: 'failing' }))));
  assert.match(bad, /gc-vote-count-blocked/);
  assert.match(bad, /Checking/);

  assert.match(cardHtml(plain(AppView._proposalCardModel(proposal({ work: syncing() })))), /Syncing with main/);

  // Up for a vote, or no row: the vote's own pill, as before.
  for (const work of [upForVote(), null]) {
    const open = AppView._proposalCardModel(proposal({ work }));
    assert.equal(open.pill.row, undefined);
    assert.match(cardHtml(plain(open)), /Vote · 0\/2/);
  }
  // Merged or merging: its own status is newer than any row.
  const merging = AppView._proposalCardModel(proposal({ status: 'merging', work: shots() }));
  assert.equal(merging.pill.row, undefined);
});

test('a change\'s line under a request wears the row\'s pill, never "Vote · 0/2"', () => {
  const AppView = appView();
  AppView._placedCategoryFor = () => null;
  AppView._categoryMeta = () => null;
  const item = { type: 'change', id: 7, number: 4577, title: 'Dark mode toggle', status: 'promoted', state: 'review', replies: 0, by: 'maya', at: '2026-11-18T09:00:00Z' };
  const line = (work) => {
    const pr = proposal({ work });
    const card = AppView._proposalCardModel(pr, { noNav: true });
    const v = plain(AppView._changeThreadView('proposal', pr, card, { hero: {} }));
    return renderComponent(CHANGES, 'ChangeLine', { item, view: { card: plain(card), v, body: {}, row: pr } });
  };
  const held = line(shots());
  assert.match(held, /Taking screenshots/);
  assert.doesNotMatch(held, /Vote · 0\/2/);
  assert.match(held, /data-thread-change-status="needs_vote"/, 'the attribute stays the live vote\'s key');
  // A blocked state is the one tag, plain (dev-card.tsx ChangeTag): no red tone of its own.
  assert.match(line(failing()), /data-state-tag="plain" class="one-tag one-tag-plain"/);
  assert.match(line(upForVote()), /Vote · 0\/2/, 'up for a vote: the vote\'s own pill');
  assert.match(line(null), /Vote · 0\/2/);
});

test('the card\'s spine follows the pill it draws: the row\'s tone, never the open vote\'s blue while the vote is not open', () => {
  const AppView = appView();
  const { edgeFor } = loadTsx('frontend/src/features/dev-board/card/dev-card.tsx');
  const edge = (pr) => edgeFor(plain(AppView._proposalCardModel(pr)));
  assert.equal(edge(proposal({ work: upForVote() })), 'vote', 'up for a vote: the open vote\'s edge');
  assert.equal(edge(proposal({ work: null })), 'vote', 'no row: as before');
  assert.equal(edge(proposal({ work: shots() })), 'progress', 'its screenshots are being taken: still in hand');
  assert.equal(edge(proposal({ work: failing(), check_state: 'failing' })), 'blocked');
  assert.match(cardHtml(plain(AppView._proposalCardModel(proposal({ work: shots() })))), /data-edge="progress"/);
});

test('a competing change folded under the ballot wears its row\'s pill too', () => {
  const AppView = appView();
  AppView._placedCategoryFor = () => null;
  AppView._categoryMeta = () => null;
  const item = { type: 'change', id: 7, number: 4577, title: 'Dark mode toggle', status: 'promoted', state: 'review', replies: 0, by: 'maya', at: '2026-11-18T09:00:00Z' };
  const folded = (work, open = false) => {
    const pr = proposal({ work });
    const card = AppView._proposalCardModel(pr, { noNav: true });
    const v = plain(AppView._changeThreadView('proposal', pr, card, { hero: {} }));
    return renderComponent(CHANGES, 'FoldedChange', {
      item, i: 1, view: { card: plain(card), v, body: {}, row: pr }, plan: null, request: 12, open, onToggle: () => {},
    });
  };
  const held = folded(shots());
  assert.match(held, /data-thread-fold="shut"/);
  assert.match(held, /Change B/, 'named by its letter on the ballot');
  assert.match(held, /Taking screenshots/);
  assert.doesNotMatch(held, /Vote · 0\/2/, 'never a vote it is not open for');
  assert.match(held, /data-thread-change-status="needs_vote"/, 'the attribute stays the live vote\'s key');
  assert.match(folded(syncing()), /Syncing with main/);
  assert.match(folded(failing()), /data-state-tag="plain" class="one-tag one-tag-plain"/);
  assert.match(folded(upForVote()), /Vote · 0\/2/, 'up for a vote: the vote\'s own pill');
  assert.match(folded(null), /Vote · 0\/2/);
});

// The pill beside a request's number (thread-model.ts requestPill), drawn by
// its bar (request-head.tsx RequestBar), from the request's own stored row
// as the page hands it on (normalized, with whose it is).
test('the request\'s bar pill is its row\'s word and tone, whatever its thread\'s changes say', () => {
  const { storedChange } = require('./lib/stored-row');
  const { message } = require('./lib/platform-i18n');
  const { requestPill, threadLayout } = loadTsx('frontend/src/features/dev-board/topic/thread-model.ts');
  const { normalizeWorkState } = loadTsx('frontend/src/lib/work-state.ts');
  const thread = (items) => threadLayout({
    thread: { id: 3, number: 12, kind: 'work', lead: 'request', title: null, state: 'open' },
    items: [{ type: 'request', id: 11, number: 12, title: 'Dark mode', status: 'open', replies: 0 }, ...items],
    follow: null,
  }, { type: 'request', id: 12 });
  const review = { type: 'change', id: 51, number: 8, title: 'Dark mode toggle', status: 'promoted', state: 'review', replies: 0, closes: [12] };
  const pillOf = (items, sent) => requestPill(thread(items), normalizeWorkState(sent), message, sent.mine !== false);
  const bar = (pill) => renderComponent('frontend/src/features/dev-board/topic/request-head.tsx', 'RequestBar', {
    r: { number: 12, title: 'Dark mode', status: { closed: false, stage: 'built' }, category: null, menuKey: null }, pill,
  });

  // Homeroom bot gave up fixing its change's tests; the change's vote is not
  // open, so the thread's items said nothing at all.
  const failingChange = storedChange({ checks: { state: 'failing', phase: 'done', failing: 2 } });
  const stopped = pillOf([{ ...review, voteOpen: false }], storedRow({ stage: 'stopped', reason: 'fix_stopped', change: failingChange }));
  assert.equal(stopped.key, 'stopped');
  assert.equal(stopped.label, message('core:work.reason.fixStopped'));
  assert.equal(stopped.tone, 'blocked');
  const drawn = bar(stopped);
  assert.match(drawn, /data-request-status="stopped"/);
  assert.match(drawn, /data-state-tag="plain" class="one-tag one-tag-plain"/, 'the one tag, plain: its words say it stopped');
  assert.ok(drawn.includes(message('core:work.reason.fixStopped')), drawn);

  // Its screenshots are being taken: the row's word, its line on hover.
  const shotsRow = storedRow({ stage: 'checking', line: { code: 'shots' }, change: storedChange() });
  const taking = pillOf([{ ...review, voteOpen: false }], shotsRow);
  assert.equal(taking.label, 'Taking screenshots');
  assert.equal(taking.tone, 'progress');
  assert.equal(taking.spinner, true);
  assert.equal(taking.title, message(shotsRow.words.line.id, shotsRow.words.line.values));
  assert.match(bar(taking), /title="Tests passed: only the before and after screenshots are left"/);

  // Homeroom bot is to read it first, while somebody's change is underway:
  // never "Being built" from the thread's items.
  const queued = storedRow({ stage: 'reading', line: { code: 'queued', place: 2 } });
  const reading = pillOf([{ ...review, status: 'active', state: 'underway', ready: false }], queued);
  assert.equal(reading.key, 'reading');
  assert.equal(reading.label, message(queued.words.stage.id, queued.words.stage.values));
  assert.equal(reading.spinner, undefined);
  assert.doesNotMatch(bar(reading), /Being built/);

  // Waiting on its requester, read by somebody else: their wording.
  const asked = storedRow({ stage: 'waiting_for_you', why: 'question', whoseMove: 'requester', change: storedChange({ voteOpen: true }) }, { mine: false });
  assert.equal(pillOf([review], asked).label, message('core:work.whyOthers.question'));
  assert.equal(pillOf([review], { ...asked, mine: true }).label, message('core:work.why.question'));

  // Up for a vote between two changes: the row's word, the ballot on hover.
  const vote = storedRow({ stage: 'up_for_vote', whoseMove: 'group', change: storedChange({ voteOpen: true }) });
  const ballot = pillOf([review, { ...review, id: 52, number: 9 }], vote);
  assert.equal(ballot.key, 'choosing');
  assert.equal(ballot.label, 'Up for a vote');
  assert.match(ballot.title, /Pick one/);
  assert.equal(pillOf([review], vote).key, 'vote');

  // Building, and a build waiting its turn, as before.
  assert.equal(pillOf([], storedRow({ stage: 'building', whoseMove: 'bot' })).label, 'Building');
  const waits = pillOf([], storedRow({ stage: 'building', line: { code: 'queued', place: 1 } }));
  assert.equal(waits.key, 'ready_to_build');
  assert.equal(waits.tone, 'neutral');

  // Nothing built yet and nothing in its thread: no pill. A vote to close it
  // is its own vote, no stage of its work, and keeps its pill.
  const waiting = storedRow({ stage: 'reading', line: { code: 'waiting' } });
  assert.equal(pillOf([], waiting), null);
  const close = { type: 'close', id: 5, number: null, title: 'Close #12', status: 'open', replies: 0, folded: [], target: 12 };
  assert.equal(pillOf([close], waiting).key, 'close');
  // Closed: nothing; and with no row (an older server), the thread's items.
  assert.equal(requestPill(thread([review]), 'closed', message), null);
  assert.equal(requestPill(thread([review]), null, message).label, 'Up for a vote');
});
