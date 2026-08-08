// #827: "Ask AI" (a private read-only advisor panel) was replaced by
// "✨ Explore in dev chat" — the same card pill now opens the viewer's real
// dev chat with an editable message about the PR pre-filled in the composer
// and NEVER sent.
//
// These tests pin the contract:
//   - the seed text is byte-exact (an unedited send must keep the Mayor in
//     explain-only mode — the closing "don't change any code" line is
//     load-bearing),
//   - an UNUSED chat is reused before a new one is created (sessions cost a
//     branch + one of only 3 slots),
//   - the seed reaches the composer via the per-session draft, written
//     BEFORE navigation (_restoreDraft fills the box on render),
//   - a composer that already holds text is appended to, never clobbered,
//   - DevChat.sendMessage is never called on any path.
//
// app-view.js is a plain browser script (`const AppView = {…}`); we load it
// into a vm context, stub the globals it reaches, and spy on the DevChat /
// App collaborators — same harness as create-proposal-prefill.test.js.
//
// Run with: node --test tests/explore-pr-in-dev-chat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// Fake #dc-input textarea the fallback/focus path can poke at.
function makeInput() {
  return {
    value: '',
    style: {},
    scrollHeight: 40,
    focused: false,
    selection: null,
    focus() { this.focused = true; },
    setSelectionRange(a, b) { this.selection = [a, b]; },
  };
}

function makeHarness({
  input = null,
  coarsePointer = false,
  drafts = {},
  createReturns = { id: 77 },
} = {}) {
  const calls = {
    createSession: [],
    setDraft: [],
    sendMessage: [],
    switchTab: [],
    toast: [],
    refreshCaches: 0,
    order: [],
  };
  const sandbox = {
    console,
    relTime: () => 'just now',
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    PlatformUI: { toast: (m) => { calls.toast.push(m); } },
    document: {
      getElementById: (id) => (id === 'dc-input' ? input : null),
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
    App: {
      user: { id: 42 },
      switchTab: async (...args) => {
        calls.order.push('switchTab');
        calls.switchTab.push(args);
      },
    },
    DevChat: {
      createSession: async (...args) => {
        calls.createSession.push(args);
        return createReturns;
      },
      _drafts: { ...drafts },
      _getDraft(sessionId) { return this._drafts[sessionId] || ''; },
      _setDraft(sessionId, value) {
        calls.order.push('setDraft');
        calls.setDraft.push([sessionId, value]);
        this._drafts[sessionId] = value;
      },
      sendMessage: (...args) => { calls.sendMessage.push(args); },
      _isCoarsePointer: () => coarsePointer,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'test-app' };
  // _refreshSessionCaches hits three endpoints; the tests set _mySessions
  // directly, so stub it and just record that the flow re-grounds first.
  AppView._refreshSessionCaches = async () => { calls.refreshCaches++; };
  AppView._mySessions = [];
  AppView._proposals = [];
  AppView._merged = [];
  return { AppView, calls, sandbox };
}

// A promoted proposal by someone else, as cached from GET /promoted.
const PR = {
  id: 7,
  pr_number: 9300,
  pr_url: 'https://github.com/acme/app/pull/9300',
  pr_title: 'Adjust kanban breakpoint to 640px',
  username: 'alice',
  user_id: 999,
  status: 'promoted',
  linked_issues: [822],
};

// The exact seed is pinned byte-for-byte: the closing sentence is what keeps
// an unedited send in explain-only mode instead of dispatching the agent.
const TAIL =
  'Please read it and explain in plain terms what it changes, how it works, '
  + "and anything risky or worth checking. Just explain it for now — don't "
  + 'change any code or open a PR.';

const EXPECTED_SEED =
  'Let\'s explore PR #9300 in this app — "Adjust kanban breakpoint to 640px" by alice.\n'
  + 'PR link: https://github.com/acme/app/pull/9300\n'
  + 'Linked issues: #822.\n\n'
  + TAIL;

// An unused chat: no PR pushed, no title, not mid-turn, and NO MESSAGES.
// last_activity_at === created_at is what /api/me/active-sessions reports for
// an empty session (it is GREATEST(created_at, MAX(message.created_at))).
const T0 = '2026-07-28T10:00:00.000Z';
const CLEAN = {
  id: 5, pr_number: null, session_title: null, status: 'active', busy: false,
  created_at: T0, last_activity_at: T0,
};

// ── Seed wording ───────────────────────────────────────────────────────────

test('seed: full row renders number, title, author, link and linked issues', () => {
  const { AppView } = makeHarness();
  assert.equal(AppView._exploreSeed(PR), EXPECTED_SEED);
});

test('seed: a merged proposal says so, so the reply does not talk about voting', () => {
  const { AppView } = makeHarness();
  const seed = AppView._exploreSeed({ ...PR, status: 'merged' });
  assert.equal(
    seed,
    'Let\'s explore PR #9300 in this app — "Adjust kanban breakpoint to 640px" by alice.\n'
    + 'PR link: https://github.com/acme/app/pull/9300\n'
    + 'Linked issues: #822.\n'
    + 'This proposal is already merged.\n\n'
    + TAIL
  );
});

test('seed: a merging proposal gets its own status line', () => {
  const { AppView } = makeHarness();
  assert.match(AppView._exploreSeed({ ...PR, status: 'merging' }),
    /^.*\nThis proposal is currently being merged\.\n\n/s);
});

test('seed: title-only row drops every optional line', () => {
  const { AppView } = makeHarness();
  assert.equal(
    AppView._exploreSeed({ id: 8, pr_title: 'Tidy empty states' }),
    'Let\'s explore the proposal "Tidy empty states" in this app.\n\n' + TAIL
  );
});

test('seed: non-integer linked_issues entries are dropped', () => {
  const { AppView } = makeHarness();
  const seed = AppView._exploreSeed({ ...PR, linked_issues: [822, null, 'x', 91] });
  assert.match(seed, /^.*Linked issues: #822, #91\.$/m);
});

// ── Session choice ─────────────────────────────────────────────────────────

test('_isUnusedChat: emptiness comes from the timestamps, not the title', () => {
  const { AppView } = makeHarness();
  assert.equal(AppView._isUnusedChat(CLEAN), true);
  assert.equal(AppView._isUnusedChat({ ...CLEAN, pr_number: 7 }), false, 'pushed work');
  assert.equal(AppView._isUnusedChat({ ...CLEAN, session_title: 'x' }), false, 'titled');
  assert.equal(AppView._isUnusedChat({ ...CLEAN, busy: true }), false, 'first turn mid-run');
  assert.equal(
    AppView._isUnusedChat({ ...CLEAN, last_activity_at: '2026-07-28T10:00:01.000Z' }),
    false, 'has messages — even one second of activity disqualifies it'
  );
  // A row with no timestamps at all can't be proven empty, so don't reuse it.
  assert.equal(AppView._isUnusedChat({ id: 5 }), false, 'unknown → not reusable');
  assert.equal(AppView._isUnusedChat(null), false);
});

test('reuses an UNUSED chat instead of creating one', async () => {
  const { AppView, calls } = makeHarness();
  AppView._proposals = [PR];
  AppView._mySessions = [CLEAN];

  await AppView.exploreProposalInDevChat(7);

  assert.equal(calls.refreshCaches, 1, 'session state re-grounded before choosing');
  assert.equal(calls.createSession.length, 0, 'no throwaway session created');
  assert.deepEqual(calls.setDraft, [[5, EXPECTED_SEED]], 'draft keyed to the reused chat');
  assert.deepEqual(calls.switchTab, [['dev', 5, 'sessions']], 'navigates to that chat');
  assert.equal(calls.sendMessage.length, 0, 'sendMessage is NEVER called');
});

test('draft is stashed BEFORE navigating so _restoreDraft finds it', async () => {
  const { AppView, calls } = makeHarness();
  AppView._proposals = [PR];
  AppView._mySessions = [CLEAN];

  await AppView.exploreProposalInDevChat(7);

  assert.deepEqual(calls.order, ['setDraft', 'switchTab']);
});

test('a chat with a pushed PR, a title, or a live turn is not reused', async () => {
  for (const dirty of [
    { ...CLEAN, pr_number: 41 },
    { ...CLEAN, session_title: 'Fix the header' },
    { ...CLEAN, busy: true },
    // Messages exist but titling never ran (no LLM key on this deployment) —
    // the emptiness check catches what a NULL session_title waves through.
    { ...CLEAN, last_activity_at: '2026-07-28T11:30:00.000Z' },
  ]) {
    const { AppView, calls } = makeHarness();
    AppView._proposals = [PR];
    AppView._mySessions = [dirty];

    await AppView.exploreProposalInDevChat(7);

    assert.deepEqual(calls.createSession, [['test-app']],
      'a fresh chat is created with no issue number (created_from_issue_number stays NULL)');
    assert.deepEqual(calls.setDraft, [[77, EXPECTED_SEED]], 'draft lands on the new chat');
    assert.deepEqual(calls.switchTab, [['dev', 77, 'sessions']]);
    assert.equal(calls.sendMessage.length, 0);
  }
});

test('picks the most recent unused chat when several exist', async () => {
  const { AppView, calls } = makeHarness();
  AppView._proposals = [PR];
  // _mySessions arrives newest-activity-first from _refreshSessionCaches.
  AppView._mySessions = [
    { ...CLEAN, id: 9, pr_number: 41 },
    { ...CLEAN, id: 6, status: 'paused' },
    { ...CLEAN, id: 3 },
  ];

  await AppView.exploreProposalInDevChat(7);

  assert.deepEqual(calls.setDraft, [[6, EXPECTED_SEED]]);
});

test('cap fallback: refused creation lands the message in the newest chat + a toast', async () => {
  const { AppView, calls } = makeHarness({ createReturns: null });
  AppView._proposals = [PR];
  AppView._mySessions = [
    { ...CLEAN, id: 9, pr_number: 41, session_title: 'Live work' },
    { ...CLEAN, id: 8, pr_number: 42, session_title: 'Older work', status: 'paused' },
  ];

  await AppView.exploreProposalInDevChat(7);

  assert.deepEqual(calls.createSession, [['test-app']], 'creation was attempted first');
  assert.deepEqual(calls.setDraft, [[9, EXPECTED_SEED]], 'newest existing chat receives it');
  assert.deepEqual(calls.switchTab, [['dev', 9, 'sessions']]);
  assert.equal(calls.toast.length, 1, 'the user is told where the message went');
  assert.match(calls.toast[0], /most recent dev chat/);
  assert.equal(calls.sendMessage.length, 0);
});

test('refused creation with no existing chat at all: no draft, no navigation, no throw', async () => {
  const { AppView, calls } = makeHarness({ createReturns: null });
  AppView._proposals = [PR];
  AppView._mySessions = [];

  await AppView.exploreProposalInDevChat(7);

  assert.deepEqual(calls.createSession, [['test-app']]);
  assert.equal(calls.setDraft.length, 0, "createSession's own toast stands");
  assert.equal(calls.switchTab.length, 0);
  assert.equal(calls.toast.length, 0, 'no second, confusing toast');
});

// ── Draft composition ──────────────────────────────────────────────────────

test('existing composer text is preserved and the seed appended below it', async () => {
  const { AppView, calls } = makeHarness({ drafts: { 5: 'also make the header sticky' } });
  AppView._proposals = [PR];
  AppView._mySessions = [CLEAN];

  await AppView.exploreProposalInDevChat(7);

  assert.deepEqual(calls.setDraft,
    [[5, `also make the header sticky\n\n${EXPECTED_SEED}`]]);
});

test('a double-tap does not stack the same seed twice', async () => {
  const { AppView, calls } = makeHarness({ drafts: { 5: EXPECTED_SEED } });
  AppView._proposals = [PR];
  AppView._mySessions = [CLEAN];

  await AppView.exploreProposalInDevChat(7);

  assert.deepEqual(calls.setDraft, [[5, EXPECTED_SEED]], 'draft left byte-identical');
});

// ── Composer fallback + focus ──────────────────────────────────────────────

test('fallback fills an empty composer and focuses on fine pointers', async () => {
  const input = makeInput();
  const { AppView } = makeHarness({ input, coarsePointer: false });
  AppView._proposals = [PR];
  AppView._mySessions = [CLEAN];

  await AppView.exploreProposalInDevChat(7);

  assert.equal(input.value, EXPECTED_SEED, 'empty box gets the seed directly');
  assert.equal(input.focused, true);
  assert.deepEqual(input.selection, [EXPECTED_SEED.length, EXPECTED_SEED.length],
    'cursor parked at the end');
});

test('fallback never clobbers a box _restoreDraft already filled', async () => {
  const input = makeInput();
  input.value = 'already restored by _restoreDraft';
  const { AppView } = makeHarness({ input });
  AppView._proposals = [PR];
  AppView._mySessions = [CLEAN];

  await AppView.exploreProposalInDevChat(7);

  assert.equal(input.value, 'already restored by _restoreDraft');
  assert.equal(input.focused, true);
});

test('no focus on coarse-pointer (touch) devices — #568', async () => {
  const input = makeInput();
  const { AppView } = makeHarness({ input, coarsePointer: true });
  AppView._proposals = [PR];
  AppView._mySessions = [CLEAN];

  await AppView.exploreProposalInDevChat(7);

  assert.equal(input.value, EXPECTED_SEED, 'box still filled');
  assert.equal(input.focused, false, 'would pop the on-screen keyboard');
});

// ── Row resolution + button guard ──────────────────────────────────────────

test('resolves a merged row from the Completed cache, skipping close-issue rows', async () => {
  const { AppView, calls } = makeHarness();
  AppView._mySessions = [CLEAN];
  // An issues.id can collide with a session id — the close_issue row must
  // never be mistaken for the merged PR proposal.
  AppView._merged = [
    { id: 7, row_type: 'close_issue', pr_title: 'Close #12' },
    { ...PR, status: 'merged' },
  ];

  await AppView.exploreProposalInDevChat(7);

  assert.equal(calls.setDraft.length, 1);
  assert.match(calls.setDraft[0][1], /^Let's explore PR #9300 /);
  assert.match(calls.setDraft[0][1], /This proposal is already merged\./);
});

test('an unknown proposal id is a quiet no-op', async () => {
  const { AppView, calls } = makeHarness();
  AppView._proposals = [PR];
  AppView._mySessions = [CLEAN];

  await AppView.exploreProposalInDevChat(4242);

  assert.equal(calls.refreshCaches, 0, 'nothing is fetched for a row we cannot resolve');
  assert.equal(calls.setDraft.length, 0);
  assert.equal(calls.switchTab.length, 0);
});

test('the clicked button is disabled for the duration and re-enabled after', async () => {
  const seen = [];
  const btn = { get disabled() { return this._d; }, set disabled(v) { this._d = v; seen.push(v); }, _d: false };
  const { AppView, sandbox } = makeHarness();
  AppView._proposals = [PR];
  AppView._mySessions = [CLEAN];
  sandbox.App.switchTab = async () => { seen.push(`disabled-during-nav:${btn.disabled}`); };

  await AppView.exploreProposalInDevChat(7, btn);

  assert.deepEqual(seen, [true, 'disabled-during-nav:true', false],
    'disabled before the async work, re-enabled in the finally');
});

// ── Card / topic-head rendering ────────────────────────────────────────────

test('the card pill carries the class, the proposal id and the label', () => {
  const { AppView } = makeHarness();
  const html = AppView._exploreChatBtnHtml(PR);
  assert.match(html, /gc-explore-chat-btn/);
  assert.match(html, /data-proposal-id="7"/);
  assert.match(html, /Explore in dev chat/);
});

test('read-only viewers get no pill — the dev chat is collab-gated (#621)', () => {
  const { AppView } = makeHarness();
  // AppView.readOnly is a getter over appData.can_collaborate (#621).
  AppView.appData = { slug: 'test-app', can_collaborate: false };
  assert.equal(AppView._exploreChatBtnHtml(PR), '');
});

// ── _showExplorePill — the one shared gate (#1045) ─────────────────────────
//
// Three render sites (the feed/board card, the Completed card, the topic
// head) used to re-derive `!mine` independently. They now all call this, so
// the truth table is pinned in one place. ME is the viewer (App.user.id is
// 42 in the harness); 999 is somebody else.
const ME_ID = 42;
const OTHER_ID = 999;

test('_showExplorePill: foreign proposals get the pill, native or imported', () => {
  const { AppView } = makeHarness();
  assert.equal(AppView._showExplorePill({ id: 1, user_id: OTHER_ID }), true,
    "someone else's native proposal — unchanged from #313");
  assert.equal(
    AppView._showExplorePill({ id: 1, user_id: OTHER_ID, source: 'imported' }), true,
    "someone else's imported proposal"
  );
});

test('_showExplorePill: your own NATIVE proposal still gets none (#313/#348)', () => {
  const { AppView } = makeHarness();
  assert.equal(AppView._showExplorePill({ id: 1, user_id: ME_ID }), false,
    'Open session is the better door to the same dev chat');
  assert.equal(
    AppView._showExplorePill({ id: 1, user_id: ME_ID, source: 'maintenance' }), false,
    'a native provenance marker is not an import'
  );
});

test('_showExplorePill: your own IMPORTED proposal DOES get one (#1045)', () => {
  const { AppView } = makeHarness();
  // The reported hole: sessionBtn is (mine && !imported) and the pill used
  // to be (!mine), so an owner of an imported PR got neither.
  assert.equal(
    AppView._showExplorePill({ id: 1, user_id: ME_ID, source: 'imported' }), true,
    'no dev session exists for it, so the pill is the only AI affordance'
  );
  assert.equal(
    AppView._showExplorePill({
      id: 1, user_id: ME_ID, source: 'imported', external_agent: 'claude-code',
    }),
    true,
    'a connector-authored proposal is an imported row too'
  );
  assert.equal(
    AppView._showExplorePill({ id: 1, user_id: ME_ID, source: 'imported', status: 'merged' }),
    true,
    'merged imported proposals stay explorable on the Completed list'
  );
});

test('_showExplorePill: governance and close-issue rows never get one (#827)', () => {
  const { AppView } = makeHarness();
  // A dev chat cannot act on a rename / secret change / close-issue vote.
  assert.equal(
    AppView._showExplorePill({ id: 5, kind: 'secret_change', created_by: OTHER_ID }), false,
    'governance rows carry `kind`; PR-proposal rows do not'
  );
  assert.equal(
    AppView._showExplorePill({ id: 5, row_type: 'close_issue', kind: 'close_issue' }), false,
    'an applied close-issue row in the Completed stream'
  );
  assert.equal(AppView._showExplorePill(null), false, 'a missing row is a quiet false');
});

test('_showExplorePill does NOT own the read-only rule — _exploreChatBtnHtml does', () => {
  const { AppView } = makeHarness();
  AppView.appData = { slug: 'test-app', can_collaborate: false };
  // Deliberate: the collab gate stays in exactly one place (#621), so the
  // predicate answers "does this ROW deserve a pill" and nothing else.
  assert.equal(AppView._showExplorePill({ id: 1, user_id: OTHER_ID }), true);
  assert.equal(AppView._exploreChatBtnHtml({ id: 1, user_id: OTHER_ID }), '',
    'the rendered pill is still empty for a read-only viewer');
});

// ── The rule as the cards actually render it (#1045) ───────────────────────

// _renderProposalCard / _renderMergedCard need the two render caches the
// dev view normally fills.
function cardHarness() {
  const { AppView } = makeHarness();
  AppView._proposalsCtx = { majority: 1 };
  AppView._mergedCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  return AppView;
}

const MY_IMPORT = {
  id: 7, pr_number: 9300, pr_url: 'https://github.com/acme/app/pull/9300',
  pr_title: 'Adjust kanban breakpoint to 640px', username: 'me', user_id: ME_ID,
  status: 'promoted', source: 'imported', imported_pr_author: 'octo-contributor',
  created_at: '2026-06-01T00:00:00Z',
};

// Cards are pointers now: Explore / Open session / Withdraw are ⋯ rows, not
// inline pills, so the rule below is read off the registered descriptors in
// AppView._cardMenus keyed by the trigger's data-card-menu — same helpers the
// archive-proposal-card and card-action-layout suites use.
function menuLabels(AppView, html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  if (!m) return [];
  return (AppView._cardMenus[m[1]] || []).map((it) => it.label);
}
function menuHas(AppView, html, re) {
  return menuLabels(AppView, html).some((l) => re.test(l));
}

test('proposal card: my own IMPORTED proposal offers Explore and no Open session', () => {
  const AppView = cardHarness();
  const html = AppView._renderProposalCard(MY_IMPORT);
  assert.ok(menuHas(AppView, html, /Explore in dev chat/),
    'Explore is the owner\'s only AI affordance here');
  assert.equal(html.match(/data-card-menu="([^"]+)"/)[1], 'proposal:7',
    'menu keyed by the proposal id');
  assert.ok(!menuHas(AppView, html, /Open session/),
    'an imported PR has no dev session to open (#687) — that rule is untouched');
  assert.ok(menuHas(AppView, html, /^Withdraw$/), 'Withdraw is untouched too');
});

test('proposal card: my own NATIVE proposal is unchanged — Open session, no Explore', () => {
  const AppView = cardHarness();
  const html = AppView._renderProposalCard({ ...MY_IMPORT, source: undefined, imported_pr_author: undefined });
  assert.ok(!menuHas(AppView, html, /Explore in dev chat/), 'Open session covers the owner');
  assert.ok(menuHas(AppView, html, /Open session/));
});

test('merged card: my own IMPORTED completed proposal offers Explore', () => {
  const AppView = cardHarness();
  const html = AppView._renderMergedCard({ ...MY_IMPORT, status: 'merged' }, 1);
  assert.ok(menuHas(AppView, html, /Explore in dev chat/));
  assert.equal(html.match(/data-card-menu="([^"]+)"/)[1], 'merged:7',
    'the Completed list keys its menu on the merged card, not the live proposal');
});

test('merged card: my own NATIVE completed proposal still offers no Explore', () => {
  const AppView = cardHarness();
  const html = AppView._renderMergedCard(
    { ...MY_IMPORT, source: undefined, imported_pr_author: undefined, status: 'merged' }, 1
  );
  assert.ok(!menuHas(AppView, html, /Explore in dev chat/));
});
