'use strict';

// #2431: an issue says which proposal closed it — or is working on it.
//
// A closed issue's page named no cause: no PR, no proposal, nothing. And an
// issue with work in flight named no change either, so the only way from the
// issue to the work was to go back to the board and look for it.
//
// The link was never missing, only unread: `chat_sessions.linked_issues` (the
// Mayor's addresses_issues, which also writes the PR body's "Closes #N") and
// `created_from_issue_number`. services/issue-proposal-ref.js resolves them
// for a whole list of numbers in ONE query, so the board pays once and not
// per card, and both issue routes hand the answer to the same renderer.
//
// What this file pins, in three layers:
//   1. the resolution — which of several linked changes is THE one, which
//      ones the viewer is allowed to be pointed at, and none at all.
//   2. the wording, which is the half the server deliberately does not
//      judge: a merged change CLOSED a closed issue but has only ADDRESSED
//      one still open.
//   3. the rendered row — heading, chip, title, in-app link — and its
//      absence when nothing links the issue.
//
// Run with: node --test tests/issue-proposal-ref.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { resolveIssueProposalRefs } = require('../src/services/issue-proposal-ref');
const { IN_PROGRESS_PAUSED_WINDOW_DAYS } = require('../src/services/issue-progress');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

// ─── the resolution ───────────────────────────────────────────────

/** One chat_sessions row in the shape the resolver's query returns. */
const sessionRow = (over) => ({
  id: 5001,
  status: 'merged',
  user_id: 9,
  shared_at: null,
  pr_number: 2431,
  pr_url: 'https://github.com/o/r/pull/2431',
  linked_issues: [142],
  created_from_issue_number: null,
  last_activity_at: '2026-09-10T00:00:00Z',
  created_at: '2026-09-01T00:00:00Z',
  title: 'A closed issue says which proposal closed it',
  ...over,
});

/** A pool stub that answers the resolver's single query. */
function poolOf(rows) {
  const seen = [];
  return {
    seen,
    query: async (sql, params) => {
      seen.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return { rows };
    },
  };
}

test('the merged change wins, and the state names the proposal lifecycle', async () => {
  const pool = poolOf([
    sessionRow({ id: 4001, status: 'active', shared_at: '2026-09-12T00:00:00Z', pr_number: null }),
    sessionRow({ id: 5001, status: 'merged' }),
    sessionRow({ id: 4500, status: 'promoted' }),
  ]);
  const refs = await resolveIssueProposalRefs(pool, 7, [142], 42);
  assert.deepEqual(refs.get(142), {
    sessionId: 5001,
    state: 'merged',
    prNumber: 2431,
    prUrl: 'https://github.com/o/r/pull/2431',
    title: 'A closed issue says which proposal closed it',
  }, 'the record of what happened outranks work still in flight');
  assert.equal(pool.seen.length, 1, 'one query for the whole list — never one per card');

  // Review beats a live chat; a live chat is the last resort.
  const review = await resolveIssueProposalRefs(
    poolOf([
      sessionRow({ id: 4001, status: 'active', shared_at: '2026-09-12T00:00:00Z' }),
      sessionRow({ id: 4500, status: 'promoted' }),
    ]), 7, [142], 42
  );
  assert.equal(review.get(142).state, 'review');
  assert.equal(review.get(142).sessionId, 4500);

  const underway = await resolveIssueProposalRefs(
    poolOf([sessionRow({ id: 4001, status: 'paused', shared_at: '2026-09-12T00:00:00Z' })]),
    7, [142], 42
  );
  assert.equal(underway.get(142).state, 'underway');
});

test('a session started FROM an issue counts, even with no declared links', async () => {
  // The start-work button records created_from_issue_number; the Mayor's
  // linked_issues arrives later (or never, on a chat that stayed a chat).
  // Either one is a real link and both resolve.
  const pool = poolOf([sessionRow({
    status: 'active', shared_at: '2026-09-12T00:00:00Z',
    linked_issues: [], created_from_issue_number: 142,
  })]);
  const refs = await resolveIssueProposalRefs(pool, 7, [142], 42);
  assert.equal(refs.get(142).state, 'underway');
});

test('a reference is only ever offered when its page can actually be opened', async () => {
  // Owner-scoped rows: a stranger's private chat has no page for this
  // viewer, so pointing at it would be a dead link. Same rule the
  // in-progress chip's target follows.
  const priv = [sessionRow({ id: 4001, status: 'active', user_id: 9, shared_at: null })];
  assert.equal((await resolveIssueProposalRefs(poolOf(priv), 7, [142], 42)).has(142), false);
  assert.equal((await resolveIssueProposalRefs(poolOf(priv), 7, [142], 9)).get(142).sessionId, 4001,
    'its owner can open it');
  const shared = [sessionRow({ id: 4001, status: 'active', shared_at: '2026-09-12T00:00:00Z' })];
  assert.equal((await resolveIssueProposalRefs(poolOf(shared), 7, [142], 42)).get(142).sessionId, 4001,
    'so can anyone, once it is shared with the group');

  // Proposed work is public whoever is looking.
  for (const status of ['promoted', 'merging', 'merged']) {
    const rows = [sessionRow({ status, user_id: 9, shared_at: null })];
    assert.equal((await resolveIssueProposalRefs(poolOf(rows), 7, [142], 42)).has(142), true, status);
  }
});

test('an issue nothing links is ABSENT, not a row saying so', async () => {
  // An empty map, not a placeholder: "no proposal known" would be a claim
  // about GitHub's timeline that this resolver never made.
  const refs = await resolveIssueProposalRefs(poolOf([sessionRow({ linked_issues: [999] })]), 7, [142], 42);
  assert.equal(refs.has(142), false);
  assert.equal(refs.size, 0);
});

test('the query is bounded by app, excludes headless runs, and ages paused rows out', async () => {
  const pool = poolOf([]);
  await resolveIssueProposalRefs(pool, 7, [142, 143], 42);
  const { sql, params } = pool.seen[0];
  assert.match(sql, /cs\.app_id = \$1/);
  assert.match(sql, /cs\.is_headless = FALSE/);
  assert.match(sql, /cs\.linked_issues && \$2::int\[\]/);
  assert.match(sql, /cs\.created_from_issue_number = ANY\(\$2::int\[\]\)/);
  assert.deepEqual(params[1], [142, 143]);
  assert.equal(params[2], IN_PROGRESS_PAUSED_WINDOW_DAYS,
    'the same window the in-progress rules use — one definition of an abandoned chat');
});

test('no pool, no app or no numbers answers empty without asking the database', async () => {
  assert.equal((await resolveIssueProposalRefs(null, 7, [142], 42)).size, 0);
  const pool = poolOf([]);
  assert.equal((await resolveIssueProposalRefs(pool, null, [142], 42)).size, 0);
  assert.equal((await resolveIssueProposalRefs(pool, 7, [], 42)).size, 0);
  assert.equal((await resolveIssueProposalRefs(pool, 7, [0, -1, 1.5], 42)).size, 0);
  assert.equal(pool.seen.length, 0);
});

// ─── the wording, and the rendered row ────────────────────────────

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 42, username: 'me' }, currentApp: 'demo', switchTab() {} },
    Kudos: { renderButton: () => '' },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    location: { search: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo' };
  AppView._ghIssues = [];
  AppView._govProposals = [];
  return AppView;
}

const addressed = (over) => ({
  sessionId: 5001,
  state: 'merged',
  prNumber: 2431,
  prUrl: 'https://github.com/o/r/pull/2431',
  title: 'A closed issue says which proposal closed it',
  ...over,
});

// Shaped like GET /api/apps/:slug/github-issues/:number answers it.
const issueRow = (over) => ({
  number: 142,
  title: 'Toggle resets after refresh',
  body: 'Steps.',
  labels: [],
  createdAt: '2026-06-01T00:00:00Z',
  htmlUrl: 'https://github.com/o/r/issues/142',
  user: 'someone',
  state: 'closed',
  closedAt: '2026-06-09T00:00:00Z',
  bounty_count: 0,
  my_bounty: false,
  created_by_username: 'someone',
  headless: null,
  in_progress: null,
  myPrSessionId: null,
  addressed_by: addressed(),
  chatCount: 0,
  lastMessageAt: null,
  title_fallback: false,
  priority: { top: null, count: 0, myValue: null },
  assignee: { top: null, count: 0, myValue: null },
  category: { top: null, count: 0, myValue: null },
  ...over,
});

test('the heading needs the ISSUE state, which is why the server does not word it', () => {
  const AppView = makeAppView();
  const heading = (over) => AppView._issueProposalRefView(issueRow(over)).heading;
  assert.equal(heading({}), 'Closed by');
  assert.equal(heading({ state: 'open', closedAt: null }), 'Addressed by',
    'a merged change on an issue still open has not closed it');
  assert.equal(heading({ state: 'open', closedAt: null, addressed_by: addressed({ state: 'review' }) }),
    'Waiting for approval');
  assert.equal(heading({ state: 'open', closedAt: null, addressed_by: addressed({ state: 'underway' }) }),
    'Work underway');
});

test('the reference links the proposal page in-app, and names the PR', () => {
  const AppView = makeAppView();
  const ref = AppView._issueProposalRefView(issueRow());
  assert.equal(ref.href, '#app/demo/dev/proposals/5001',
    'the proposal page, not the GitHub URL — the resolver only ever returns rows that have one');
  assert.equal(ref.label, '#2431');
  assert.equal(ref.title, 'A closed issue says which proposal closed it');

  // A change that has no PR yet is still a change worth pointing at.
  const early = AppView._issueProposalRefView(issueRow({
    addressed_by: addressed({ state: 'underway', prNumber: null, prUrl: null, title: null }),
  }));
  assert.equal(early.label, 'Change');
  assert.equal(early.title, 'Change 5001');
});

test('an issue with nothing linked carries no reference at all', () => {
  const AppView = makeAppView();
  assert.equal(AppView._issueProposalRefView(issueRow({ addressed_by: null })), null);
  assert.equal(AppView._issueProposalRefView(issueRow({ addressed_by: { sessionId: null } })), null);
  assert.equal(AppView._issueProposalRefView(null), null);
  assert.equal(AppView._topicViewFor('issue', issueRow({ addressed_by: null })).body.addressedBy, null);
});

test('the issue topic page renders the reference as a navigable row', () => {
  const AppView = makeAppView();
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const render = (over) => {
    const issue = issueRow(over);
    const v = AppView._topicViewFor('issue', issue);
    return renderToHtml(createElement(ChangeDetail, { ...v, item: issue }));
  };

  const closed = render({});
  assert.match(closed, /class="dev-topic-h">Closed by</);
  assert.match(closed, /href="#app\/demo\/dev\/proposals\/5001"/);
  assert.match(closed, /data-addressed-by="5001"/);
  assert.ok(closed.includes('#2431'), 'the PR number is the identity chip');
  assert.ok(closed.includes('A closed issue says which proposal closed it'));
  // The mirror of a proposal's "Addresses issues" box, drawn from the same
  // box, row and chip — no second styling vocabulary for one reference.
  assert.match(closed, /class="dev-change-issues"/);
  assert.match(closed, /rounded-full bg-violet-500\/10/);
  assert.match(closed, /class="gc-event-box dev-issue-ref"/,
    'the row is the Discussion’s event box, the number where the glyph goes');

  const underway = render({
    state: 'open', closedAt: null,
    addressed_by: addressed({ state: 'underway', title: 'Fix the toggle' }),
  });
  assert.match(underway, /class="dev-topic-h">Work underway</);
  assert.ok(underway.includes('Fix the toggle'));

  // Nothing linked: no box, no heading, no empty placeholder.
  const bare = render({ addressed_by: null });
  assert.ok(!bare.includes('dev-change-issues'));
  for (const label of ['Closed by', 'Addressed by', 'In review', 'Work underway']) {
    assert.ok(!bare.includes(`>${label}<`), label);
  }
  // …and the rest of the issue page is untouched by its absence.
  assert.match(bare, /id="dev-issue-comments"/);
  assert.ok(bare.includes('About this issue'));
});

test('a proposal title from the API is escaped, never rendered as markup', () => {
  const AppView = makeAppView();
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const issue = issueRow({ addressed_by: addressed({ title: '<img src=x onerror=alert(1)>' }) });
  const v = AppView._topicViewFor('issue', issue);
  const html = renderToHtml(createElement(ChangeDetail, { ...v, item: issue }));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img src=x'));
});
