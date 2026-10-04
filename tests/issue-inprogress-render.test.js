// Rendering tests for the issue work-state feature (app-view.js):
//
//   1. issueChipsHtml — the reverse "#N" chip helper (sanitize / dedupe /
//      sort, in-app navigation, no pr_url requirement).
//   2. _issueWorkState / _inProgressChipHtml / _issueInProgress — the seven
//      states (#1112), their precedence, tones and "+N" headcount, plus the
//      chip's clickable-vs-informational variants.
//   3. _renderIssueRow — chip placement, the claim/release button, the
//      topic-head work note (#1112) and the topic-view admin claim list.
//   4. Session cards + proposal cards — reverse chips (live proposals and
//      merged kanban cards go in-app; the merged detail head stays external).
//   5. _bucketDevItems — kanban routing of in-progress issues.
//
// Same harness as tests/archive-proposal-card.test.js: app-view.js is a
// plain browser script, loaded into a vm sandbox with its external
// globals stubbed; assertions run on the returned HTML strings / pure
// bucketing output.
//
// Run with: node --test tests/issue-inprogress-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  cardHtml, hasAction, issueCardHtml, mySessionCardHtml, proposalCardHtml, sharedSessionCardHtml,
} = require('./lib/dev-card-html');
const { api } = require('./lib/dev-card-html');
const { renderToHtml, createElement } = require('./lib/render-tsx');

// ── Rendering one chip ──────────────────────────────────────────────────
//
// `issueChipsHtml` and `_inProgressChipHtml` built strings; #1367's card
// chunk split each into a SPEC (still here, still what this file is about)
// and card/dev-card.tsx's `Badge`, which draws it.
function badgeHtml(b) {
  return b ? renderToHtml(createElement(api().Badge, { b })) : '';
}
function workChipHtml(AppView, issue) {
  return badgeHtml(AppView._inProgressChipSpec(issue));
}


const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView(opts) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: {
      user: { id: 42, username: 'me', canAdminWrite: !!(opts && opts.admin) },
      switchTab: () => {},
    },
    Kudos: { renderButton: () => '', attach: () => {} },
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
  AppView._ghIssuesMeta = { myRemaining: 5 };
  AppView._govProposals = [];
  // AppView.readOnly is a getter over appData.can_collaborate (#621).
  AppView.appData = { slug: 'demo', can_collaborate: !(opts && opts.readOnly) };
  return AppView;
}

const baseIssue = (over) => ({
  number: 3, title: 'Fix the thing', body: '', htmlUrl: 'https://github.com/o/r/issues/3',
  bounty_count: 0, my_bounty: false, created_by_username: 'someone',
  headless: null, in_progress: null, myPrSessionId: null,
  chatCount: 0, lastMessageAt: null, title_fallback: false,
  priority: null, assignee: null, category: null,
  ...over,
});

// ── 1. issueChipsHtml ────────────────────────────────────────────────────

test('issueChipSpecs sanitizes, dedupes, sorts, and navigates in-app', () => {
  const AppView = makeAppView();
  const specs = AppView.issueChipSpecs([9, '2', 9, -1, 'junk', 2.5, 4]);
  // Sorted ascending, deduped, junk dropped.
  // JSON round-trip: the specs come from a vm sandbox, so a bare deepEqual
  // compares across realms and fails on the array's constructor.
  assert.deepEqual(JSON.parse(JSON.stringify(specs.map((c) => c.n))), [2, 4, 9]);
  // Chips are in-app buttons (openTopic), never external links.
  const html = specs.map((b) => badgeHtml(b)).join('');
  assert.match(html, /data-issue-chip="2"/);
  assert.ok(!html.includes('<a '), 'no external anchors');
  // Empty / invalid input renders nothing.
  assert.equal(AppView.issueChipSpecs([]).length, 0);
  assert.equal(AppView.issueChipSpecs(null).length, 0);
  assert.equal(AppView.issueChipSpecs(['x', -3]).length, 0);
  // Optional label prefix (the proposal card's "Closes #N" wording).
  assert.match(badgeHtml(AppView.issueChipSpecs([5], { label: 'Closes' })[0]), /Closes #5/);
});

// ── 2. the work-state chip ───────────────────────────────────────────────
//
// #1112: one chip, seven mutually exclusive states, first match wins in the
// order in_review > working > auto_solving > paused > answer_needed >
// draft_ready > claimed. The old chip said "In progress" for all seven.

// A session as composeInProgress now reports it (`sessions[]`, #1112).
const sess = (over) => ({
  sessionId: 100, username: 'maya', mine: false, status: 'active',
  busy: false, lastActivityAt: '2026-08-12T00:00:00Z',
  ...over,
});

test('_issueInProgress ORs sessions/claims with live headless state', () => {
  const AppView = makeAppView();
  assert.equal(AppView._issueInProgress(baseIssue()), false);
  assert.equal(AppView._issueInProgress(baseIssue({
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], target: null },
  })), true);
  assert.equal(AppView._issueInProgress(baseIssue({ headless: { status: 'generating' } })), true);
  assert.equal(AppView._issueInProgress(baseIssue({ headless: { status: 'ready' } })), true);
  assert.equal(AppView._issueInProgress(baseIssue({ headless: { status: 'failed' } })), false);
});

test('_issueWorkState names each of the seven states with its own tone', () => {
  const AppView = makeAppView();
  const st = (over) => AppView._issueWorkState(baseIssue(over));
  const ip = (over) => ({ count: 1, users: ['maya'], peopleTotal: 1, mine: false, claims: [], sessions: [], target: null, ...over });

  const inReview = st({ in_progress: ip({ sessions: [sess({ status: 'promoted' })] }) });
  assert.equal(inReview.key, 'in_review');
  assert.equal(inReview.label, 'Waiting for approval · maya');
  assert.equal(inReview.tone, 'violet');
  assert.equal(inReview.spinner, false);

  const working = st({ in_progress: ip({ sessions: [sess()] }) });
  assert.equal(working.key, 'working');
  assert.equal(working.label, 'Being worked on · maya');
  assert.equal(working.tone, 'sky');
  assert.equal(working.spinner, false);

  // A turn actually running goes emerald WITH the spinner — the same `busy`
  // the session card paints, so the two surfaces cannot disagree.
  const busy = st({ in_progress: ip({ sessions: [sess({ busy: true })] }) });
  assert.equal(busy.key, 'working');
  assert.equal(busy.tone, 'emerald');
  assert.equal(busy.spinner, true);

  const auto = st({ headless: { status: 'generating' } });
  assert.equal(auto.key, 'auto_solving');
  assert.equal(auto.label, 'Auto-solving…');
  assert.equal(auto.spinner, true);

  const paused = st({ in_progress: ip({ sessions: [sess({ status: 'paused' })] }) });
  assert.equal(paused.key, 'paused');
  assert.equal(paused.label, 'Started · maya', 'the word "paused" is never shown');
  assert.equal(paused.tone, 'zinc');

  const question = st({ headless: { status: 'ready', outcome: 'question' } });
  assert.equal(question.key, 'answer_needed');
  assert.equal(question.label, 'Needs an answer');
  assert.equal(question.tone, 'amber');

  const draft = st({ headless: { status: 'ready', outcome: 'spec' } });
  assert.equal(draft.key, 'draft_ready');
  assert.equal(draft.label, 'Draft ready to review');
  assert.equal(draft.tone, 'amber');

  const claimed = st({
    in_progress: ip({
      count: 0, users: [], sessions: [],
      claims: [{ username: 'maya', userId: 8, mine: false, claimedAt: '2026-08-10T00:00:00Z' }],
    }),
  });
  assert.equal(claimed.key, 'claimed');
  assert.equal(claimed.label, 'Claimed · maya');
  assert.equal(claimed.tone, 'sky');

  // No live signal at all → no state, no chip.
  assert.equal(st({}), null);
});

test('_issueWorkState precedence: first match wins, in the documented order', () => {
  const AppView = makeAppView();
  const st = (over) => AppView._issueWorkState(baseIssue(over)).key;
  const withSess = (sessions, headless, claims) => ({
    in_progress: {
      count: sessions.length, users: sessions.map((s) => s.username), peopleTotal: 1,
      mine: false, claims: claims || [], sessions, target: null,
    },
    headless: headless || null,
  });

  // in_review beats everything else that could be true at once.
  assert.equal(st(withSess(
    [sess({ status: 'promoted' }), sess({ sessionId: 2, status: 'active', busy: true })],
    { status: 'generating' },
    [{ username: 'bob', mine: false }]
  )), 'in_review');
  // working beats an auto-solve run and a claim.
  assert.equal(st(withSess([sess()], { status: 'generating' }, [{ username: 'bob', mine: false }])), 'working');
  // auto_solving beats a paused session.
  assert.equal(st(withSess([sess({ status: 'paused' })], { status: 'generating' })), 'auto_solving');
  // paused beats a finished run and a claim.
  assert.equal(st(withSess([sess({ status: 'paused' })], { status: 'ready', outcome: 'question' })), 'paused');
  // answer_needed beats draft_ready (which is the other `ready` outcome) …
  assert.equal(st(withSess([], { status: 'ready', outcome: 'question' })), 'answer_needed');
  // … and both beat a bare claim.
  assert.equal(st(withSess([], { status: 'ready', outcome: 'code' }, [{ username: 'bob', mine: false }])), 'draft_ready');
  assert.equal(st(withSess([], null, [{ username: 'bob', mine: false }])), 'claimed');
});

test('chip names the viewer as "you" and suffixes the TRUE extra headcount', () => {
  const AppView = makeAppView();
  const chip = (ip) => workChipHtml(AppView, baseIssue({ in_progress: ip }));

  assert.match(chip({
    count: 1, users: ['maya'], peopleTotal: 1, mine: false, claims: [],
    sessions: [sess()], target: null,
  }), /Being worked on · maya/);
  assert.match(chip({
    count: 1, users: ['me'], peopleTotal: 1, mine: true, claims: [],
    sessions: [sess({ username: 'me', mine: true })], target: null,
  }), /Being worked on · you/);
  // Distinct people across sessions AND claims are counted, deduped, and the
  // extra ones ride as "+N" rather than replacing the name.
  assert.match(chip({
    count: 1, users: ['maya'], peopleTotal: 2, mine: false,
    claims: [{ username: 'bob', mine: false }], sessions: [sess()], target: null,
  }), /Being worked on · maya \+1/);
  assert.match(chip({
    count: 1, users: ['maya'], peopleTotal: 1, mine: false,
    claims: [{ username: 'maya', mine: false }], sessions: [sess()], target: null,
  }), /Being worked on · maya</, 'same person claiming AND working counts once');
  // #1112: peopleTotal is the TRUE headcount even when `users` is capped for
  // display, so a five-person issue no longer under-reports as "+2".
  assert.match(chip({
    count: 5, users: ['maya', 'bob', 'cara', 'dan', 'eve'], peopleTotal: 6, mine: false,
    claims: [], sessions: [sess()], target: null,
  }), /Being worked on · maya \+5/);
  // The three bot states name nobody — there is no person at a keyboard.
  const auto = workChipHtml(AppView, baseIssue({ headless: { status: 'generating' } }));
  assert.match(auto, /Auto-solving…/);
  assert.ok(!auto.includes(' · '), 'no name on a bot state');
});

test('the chip is exactly ONE badge carrying its state key', () => {
  const AppView = makeAppView();
  const html = workChipHtml(AppView, baseIssue({
    in_progress: {
      count: 1, users: ['maya'], peopleTotal: 1, mine: false, claims: [],
      sessions: [sess({ status: 'paused' })], target: null,
    },
  }));
  assert.equal((html.match(/dev-badge/g) || []).length, 1, 'one badge, whatever the state');
  assert.match(html, /data-work-state="paused"/);
});

test('a payload with no sessions[] still renders a state', () => {
  // An older cached /github-issues response (or a fixture written before
  // #1112) carries count/users but no per-session detail.
  const AppView = makeAppView();
  const st = AppView._issueWorkState(baseIssue({
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], target: null },
  }));
  assert.equal(st.key, 'working');
  assert.equal(st.label, 'Being worked on · maya');
});

test('chip is a button when a target exists, a plain span otherwise', () => {
  const AppView = makeAppView();
  const linked = workChipHtml(AppView, baseIssue({
    in_progress: {
      count: 1, users: ['maya'], mine: false, claims: [],
      target: { kind: 'proposal', sessionId: 88 },
    },
  }));
  assert.match(linked, /<button/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(AppView._inProgressChipSpec(baseIssue({
      in_progress: {
        count: 1, users: ['maya'], mine: false, claims: [],
        target: { kind: 'proposal', sessionId: 88 },
      },
    })).act)),
    { fn: 'openInProgressTarget', args: ['proposal', 88] });

  const plain = workChipHtml(AppView, baseIssue({
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], target: null },
  }));
  assert.match(plain, /<span/);
  assert.ok(!plain.includes('openInProgressTarget'));

  // Headless-only status renders the informational chip (its row's own
  // auto-solve buttons navigate).
  const headlessOnly = workChipHtml(AppView, baseIssue({
    headless: { status: 'generating' },
  }));
  assert.match(headlessOnly, /<span/);
  assert.match(headlessOnly, /Auto-solving…/);
  assert.match(headlessOnly, /auto-solve/i);
});

test('openInProgressTarget always opens the lifecycle-aware change page', () => {
  const AppView = makeAppView();
  const calls = [];
  AppView.openTopic = (kind, id) => calls.push(['topic', kind, id]);
  AppView.openInProgressTarget('proposal', 5);
  AppView.openInProgressTarget('session-shared', 6);
  AppView.openInProgressTarget('session-own', 7);
  assert.deepEqual(calls, [
    ['topic', 'proposal', 5],
    ['topic', 'proposal', 6],
    ['topic', 'proposal', 7],
  ]);
  // Bad input is a no-op.
  AppView.openInProgressTarget('proposal', 'junk');
  assert.equal(calls.length, 3);
});

// ── 3. the issue row: chip + claim button + admin list ──────────────────

// The claim toggle spent one release as a ⋯ descriptor and is back on the card
// FACE, as a pill in the reserved action band: the four-band card gives every
// row an action band, and claiming is what a reader does with an issue before
// any code exists. The CHIP is unaffected — it stays one of the four badge
// slots, an at-a-glance state rather than an action.
//
// So the label is read off the action band, and the ⋯ must NOT also carry it.
function claimLabels(AppView, html) {
  const row = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>/);
  const labels = row
    ? (row[1].match(/>(?:Claim this issue|Release my claim)</g) || []).map((s) => s.slice(1, -1))
    : [];
  const m = html.match(/data-card-menu="([^"]+)"/);
  const inMenu = m
    ? (AppView._cardMenus[m[1]] || []).map((it) => it.label)
      .filter((l) => /claim/i.test(l))
    : [];
  // join(), not deepEqual: _cardMenus is built inside the vm realm, so a
  // cross-realm array fails deepStrictEqual on its prototype alone.
  assert.equal(inMenu.join('|'), '', 'the promoted toggle is not duplicated in ⋯');
  return labels;
}

test('issue row renders the chip and offers "Claim this issue" when the viewer holds no claim', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(baseIssue({
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], sessions: [sess()], target: null },
  }));
  const html = cardHtml(model);
  assert.match(html, /Being worked on · maya/);
  assert.equal(claimLabels(AppView, html).join('|'), 'Claim this issue');
  // #1112: the label no longer promises progress, and no longer repeats the
  // phrase the chip uses for six other states.
  assert.ok(!html.includes('Mark in progress'));
});

test('issue row swaps to "Release my claim" when the viewer holds a claim', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(baseIssue({
    in_progress: {
      count: 0, users: [], mine: true, sessions: [],
      claims: [{ username: 'me', userId: 42, mine: true }], target: null,
    },
  }));
  const html = cardHtml(model);
  assert.equal(claimLabels(AppView, html).join('|'), 'Release my claim',
    'the viewer can only clear their OWN claim from here');
});

test('other users\' claims never block the viewer\'s own claim button', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(baseIssue({
    in_progress: {
      count: 0, users: [], mine: false, sessions: [],
      claims: [{ username: 'maya', userId: 8, mine: false }], target: null,
    },
  }));
  const html = cardHtml(model);
  // Claims are per-user and never exclusive.
  assert.equal(claimLabels(AppView, html).join('|'), 'Claim this issue');
});

test('read-only viewers see the chip but no action buttons', () => {
  const AppView = makeAppView({ readOnly: true });
  const model = AppView._issueCardModel(baseIssue({
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], sessions: [sess()], target: null },
  }));
  const html = cardHtml(model);
  assert.match(html, /Being worked on · maya/);
  assert.ok(!html.includes('Claim this issue'));
});

test('admin claim list renders in the topic view (noNav) only, for write-admins only', () => {
  const withClaims = {
    in_progress: {
      count: 0, users: [], mine: false, sessions: [],
      claims: [{ username: 'maya', userId: 8, mine: false }], target: null,
    },
  };
  const admin = makeAppView({ admin: true });
  const topicModel = admin._issueCardModel(baseIssue(withClaims), { noNav: true });
  const topicHtml = cardHtml(topicModel);
  assert.match(topicHtml, /Claims:/);
  assert.ok(!topicHtml.includes('In-progress claims:'), '#1112 dropped the redundant prefix');
  assert.ok(hasAction(topicModel, 'clearIssueClaim', 3, 8), 'each claim clears itself');
  // Feed variant: no admin list even for admins.
  const feedHtml = issueCardHtml(admin, baseIssue(withClaims));
  assert.ok(!feedHtml.includes('Claims:'));
  // Non-admin topic view: no list.
  const user = makeAppView();
  const userTopic = issueCardHtml(user, baseIssue(withClaims), { noNav: true });
  assert.ok(!userTopic.includes('Claims:'));
});

// #1112: the chip names the state; the topic head explains it in a sentence,
// including the date the mark clears itself — the question the old chip left
// a reader with ("is anyone actually on this?").
test('the topic head prints a plain dated work note; the feed card does not', () => {
  const AppView = makeAppView();
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
  const issue = baseIssue({
    in_progress: {
      count: 1, users: ['maya'], peopleTotal: 1, mine: false, claims: [],
      sessions: [sess({ status: 'paused', lastActivityAt: fiveDaysAgo })],
      target: null,
    },
  });
  const topicModel = AppView._issueCardModel(issue, { noNav: true });
  const topic = cardHtml(topicModel);
  const note = topic.match(/data-work-note="paused"[^>]*>([^<]*)</);
  assert.ok(note, 'the head carries a [data-work-note]');
  assert.match(note[1], /maya started work on this and last worked on it 5 days ago/);
  assert.match(note[1], /clears itself on/);
  // The self-clear date is the paused window past the last activity, not today.
  const clears = new Date(Date.now() + 2 * 86400000).toLocaleDateString();
  assert.ok(note[1].includes(clears), `note names ${clears}: ${note[1]}`);
  // Dense feed cards have no room; the chip's tooltip carries the same text.
  const feedModel = AppView._issueCardModel(issue);
  const feed = cardHtml(feedModel);
  assert.ok(!feed.includes('data-work-note'));
  assert.match(feed, /title="[^"]*last worked on it 5 days ago/);
});

test('the work note adds an "Also:" clause when more than one thing applies', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(baseIssue({
    in_progress: {
      count: 1, users: ['maya'], peopleTotal: 2, mine: false,
      claims: [{ username: 'bob', userId: 8, mine: false }],
      sessions: [sess({ status: 'paused' })], target: null,
    },
  }), { noNav: true });
  const html = cardHtml(model);
  const note = html.match(/data-work-note="paused"[^>]*>([^<]*)</);
  assert.match(note[1], /Also: claimed by bob\./);
});

test('no live signal → no chip and no work note', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(baseIssue(), { noNav: true });
  const html = cardHtml(model);
  assert.ok(!html.includes('data-work-note'));
  assert.ok(!html.includes('data-work-state'));
});

// ── 4. reverse chips on session + proposal cards ─────────────────────────

const baseSession = (over) => ({
  id: 12, session_title: 'My session', pr_title: null, branch_name: 'dev/x',
  status: 'active', pr_number: null, staging_url: null, shared_at: null,
  linked_issues: [], busy: false, chat_count: 0,
  ...over,
});

test('own session card renders "#N" chips from linked_issues', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const model = AppView._mySessionCardModel(baseSession({ linked_issues: [7, 4] }));
  const html = cardHtml(model);
  const order = [...html.matchAll(/data-issue-chip="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [4, 7]);
  // No chips when the session links nothing.
  const emptyModel = AppView._mySessionCardModel(baseSession());
  const empty = cardHtml(emptyModel);
  assert.ok(!empty.includes('data-issue-chip'));
});

test('shared session card renders "#N" chips from linked_issues', () => {
  const AppView = makeAppView();
  const model = AppView._sharedSessionCardModel(baseSession({
    username: 'maya', linked_issues: [11], can_preview: false,
  }));
  const html = cardHtml(model);
  assert.match(html, /data-issue-chip="11"/);
});

const baseProposal = (over) => ({
  id: 9, pr_number: 900, pr_title: 'A change', username: 'maya', user_id: 8,
  status: 'promoted', pr_url: 'https://github.com/o/r/pull/900',
  linked_issues: [6], chat_count: 0, created_at: '2026-06-12T00:00:00Z',
  visuals: null, my_vote: null,
  ...over,
});

test('LIVE proposal card links "Closes #N" to the in-app issue topic', () => {
  const AppView = makeAppView();
  const model = AppView._proposalCardModel(baseProposal());
  const html = cardHtml(model);
  assert.match(html, /data-issue-chip="6"/);
  assert.match(html, /Closes #6/);
  assert.ok(hasAction(model, 'openTopic', 'issue', 6), 'and opens the topic in-app');
  assert.ok(!html.includes('github.com/o/r/issues/6'), 'no external issue link on live cards');
});

test('MERGED proposal detail head keeps the external GitHub "Closed #N" links', () => {
  const AppView = makeAppView();
  const model = AppView._proposalCardModel(baseProposal({ status: 'merged' }));
  const html = cardHtml(model);
  assert.ok(!html.includes('data-issue-chip'), 'merged cards do not use in-app chips');
  assert.match(html, /github\.com\/o\/r\/issues\/6/);
  assert.match(html, /Closed #6/);
});

test('MERGED kanban card opens "Closed #N" in the Homeroom issue topic', () => {
  const AppView = makeAppView();
  const model = AppView._mergedCardModel(baseProposal({ status: 'merged' }), 1);
  const html = cardHtml(model);
  assert.match(html, /data-issue-chip="6"/);
  assert.match(html, /Closed #6/);
  assert.match(html, /bg-emerald-500\/10/, 'keeps the completed-card tone');
  assert.ok(hasAction(model, 'openTopic', 'issue', 6), 'opens the issue topic in-app');
  assert.ok(!html.includes('github.com/o/r/issues/6'), 'no external issue link on the kanban card');
});

// ── 5. kanban routing ────────────────────────────────────────────────────

test('_bucketDevItems routes in-progress issues (sessions, claims, headless) to the In-progress column', () => {
  const AppView = makeAppView();
  const plain = baseIssue({ number: 1 });
  const viaSessions = baseIssue({
    number: 2,
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], target: null },
  });
  const viaClaim = baseIssue({
    number: 3,
    in_progress: { count: 0, users: [], mine: false, claims: [{ username: 'bob', userId: 5, mine: false }], target: null },
  });
  const viaHeadless = baseIssue({ number: 4, headless: { status: 'generating' } });
  const behindProposal = baseIssue({
    number: 5,
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], target: { kind: 'proposal', sessionId: 77 } },
  });

  const buckets = AppView._bucketDevItems({
    issues: [plain, viaSessions, viaClaim, viaHeadless, behindProposal],
    proposals: [{ id: 77, status: 'promoted', linked_issues: [5] }],
    gov: [], merged: [], mySessions: [], sharedSessions: [],
  });

  // Array.from re-realms the vm-created arrays — deepEqual under
  // assert/strict compares prototypes, and cross-realm Array fails it.
  assert.deepEqual(Array.from(buckets.issues, (i) => i.number), [1], 'only the plain issue stays');
  const inProgressNums = Array.from(buckets.inProgress)
    .filter((x) => x.kind === 'issue')
    .map((x) => x.item.number)
    .sort((a, b) => a - b);
  // #1251: the issue an open promoted proposal addresses is In progress
  // too — it used to be dropped from both issue columns, which left it
  // visible in the list feed but findable nowhere on the board.
  assert.deepEqual(inProgressNums, [2, 3, 4, 5]);
});

// ── 6. #17: the Homeroom bot on the request ──────────────────────────────
//
// `issue.bot` ({ what: 'reading' | 'building', since }) is the bot's work on
// the request, from /github-issues. The bot is never `in_progress` (its
// sessions are synthetic, left out on purpose), so before this state a
// request it was building read as nobody's: "Unassigned", Start work, and a
// Claim that told the bot to step back mid-build.

const building = (over) => ({ what: 'building', since: new Date(Date.now() - 20 * 60000).toISOString(), ...over });

test('#17: a request the bot is on is in progress, in its own state, naming nobody', () => {
  const AppView = makeAppView();
  assert.equal(AppView._issueInProgress(baseIssue({ bot: building() })), true, 'underway, not offered to whoever passes');

  const st = AppView._issueWorkState(baseIssue({ bot: building() }));
  assert.equal(st.key, 'bot');
  assert.equal(st.label, 'Homeroom bot is building this');
  assert.equal(st.spinner, true, 'it is working this minute');
  assert.equal(st.tone, 'sky');
  assert.equal(st.who, null, 'there is no person to name');
  assert.match(st.note, /^The Homeroom bot started building this request 20 minutes ago, so nobody needs to claim it\.$/);

  const reading = AppView._issueWorkState(baseIssue({ bot: building({ what: 'reading' }) }));
  assert.equal(reading.label, 'Homeroom bot is reading this');
  assert.match(reading.note, /^The Homeroom bot started reading this request/);

  const chip = workChipHtml(AppView, baseIssue({ bot: building() }));
  assert.match(chip, /<span[^>]*data-work-state="bot"/, 'an informational chip');
  assert.match(chip, /Homeroom bot is building this/);
  assert.ok(!chip.includes(' · '), 'no name on a bot state');
});

test('#17: precedence: a person in review or at work outranks the bot; the bot outranks the rest', () => {
  const AppView = makeAppView();
  const st = (over) => AppView._issueWorkState(baseIssue({ bot: building(), ...over }));
  const ip = (over) => ({ count: 1, users: ['maya'], peopleTotal: 1, mine: false, claims: [], sessions: [], target: null, ...over });
  assert.equal(st({ in_progress: ip({ sessions: [sess({ status: 'promoted' })] }) }).key, 'in_review');
  const working = st({ in_progress: ip({ sessions: [sess()] }) });
  assert.equal(working.key, 'working');
  assert.match(working.note, /Also: the Homeroom bot is building it\./, 'the note still says the bot is on it');
  assert.equal(st({ headless: { status: 'generating' } }).key, 'bot');
  assert.equal(st({ in_progress: ip({ sessions: [sess({ status: 'paused' })] }) }).key, 'bot');
  assert.equal(st({
    in_progress: ip({ count: 0, users: [], claims: [{ username: 'bob', userId: 8, mine: false }] }),
  }).key, 'bot');
});

test('#17: the card: a disabled "Homeroom bot is building…" and no Claim, on the face or in ⋯', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(baseIssue({ bot: building() }));
  const html = cardHtml(model);
  assert.match(html, /disabled[^>]*>Homeroom bot is building…</, 'the primary waits, like a run in flight');
  assert.ok(!hasAction(model, 'chooseIssueWork'), 'no Start work: a second session would build it twice');
  assert.equal(claimLabels(AppView, html).join('|'), '', 'nothing to claim');
  assert.ok(!hasAction(model, 'markIssueInProgress'));
  assert.equal(model.actions.length, 1, 'the one disabled primary');
  assert.match(cardHtml(AppView._issueCardModel(baseIssue({ bot: building({ what: 'reading' }) }))),
    /disabled[^>]*>Homeroom bot is reading…</);

  // A claim the viewer already holds can still be let go.
  const mine = AppView._issueCardModel(baseIssue({
    bot: building(),
    in_progress: { count: 0, users: [], mine: true, sessions: [], claims: [{ username: 'me', userId: 42, mine: true }], target: null },
  }));
  assert.equal(claimLabels(AppView, cardHtml(mine)).join('|'), 'Release my claim');

  // Where the face does not carry the toggle, the ⋯ row follows the same rule.
  const rows = (issue) => Array.from(AppView._issueMenuItems(issue, { progressOnFace: false }), (it) => it.label);
  assert.ok(!rows(baseIssue({ bot: building() })).includes('Claim this issue'));
  assert.ok(rows(baseIssue()).includes('Claim this issue'), 'and comes back once the bot is done');
});

test('#17: the request page says so in a sentence and offers no Claim in its actions', () => {
  const AppView = makeAppView();
  const issue = baseIssue({ bot: building() });
  const head = cardHtml(AppView._issueCardModel(issue, { noNav: true }));
  const note = head.match(/data-work-note="bot"[^>]*>([^<]*)</);
  assert.ok(note, 'the head carries the bot work note');
  assert.match(note[1], /The Homeroom bot started building this request/);
  assert.match(head, /disabled[^>]*>Homeroom bot is building…</);

  const keys = (item) => Array.from(AppView._detailActionsView('issue', item).pills, (p) => p.key);
  assert.ok(!keys(issue).includes('claim'), 'no Claim this issue while the bot builds it');
  assert.ok(keys(issue).includes('bounty') && keys(issue).includes('close'), 'the rest of the list stays');
  assert.ok(keys(baseIssue()).includes('claim'), 'an ordinary request still offers it');
  const held = baseIssue({
    bot: building(),
    in_progress: { count: 0, users: [], mine: true, sessions: [], claims: [{ username: 'me', userId: 42, mine: true }], target: null },
  });
  const release = AppView._detailActionsView('issue', held).pills.find((p) => p.key === 'claim');
  assert.equal(release && release.label, 'Release my claim');
});

test('#17: the bot\'s request sits in In progress on the board', () => {
  const AppView = makeAppView();
  const buckets = AppView._bucketDevItems({
    issues: [baseIssue({ number: 1 }), baseIssue({ number: 2, bot: building() })],
    proposals: [], gov: [], merged: [], mySessions: [], sharedSessions: [],
  });
  assert.deepEqual(Array.from(buckets.issues, (i) => i.number), [1]);
  assert.deepEqual(Array.from(buckets.inProgress, (x) => x.item.number), [2]);
});
