// #827: "Ask AI" (a private read-only advisor panel) was replaced by
// "✨ Explore in dev chat" — the card pill opens a conversation with an
// editable message about the PR pre-filled in the composer and NEVER sent.
// #2779: that conversation is an unsent agent session focused on the
// proposal; classic dev chats are no longer created (or reused) for it.
//
// These tests pin the contract:
//   - the seed text is byte-exact (an unedited send must keep the Mayor in
//     explain-only mode — the closing "don't change any code" line is
//     load-bearing),
//   - the seed rides to the agent session as the hint's `message`, with the
//     app and the proposal as its focus,
//   - no classic session is created, drafted into or navigated to.
//
// app-view.js is a plain browser script (`const AppView = {…}`); we load it
// into a vm context, stub the globals it reaches, and spy on the agent
// session controller — same harness as create-proposal-prefill.test.js.
//
// Run with: node --test tests/explore-pr-in-dev-chat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { mergedCardHtml, proposalCardHtml } = require('./lib/dev-card-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeHarness(options = {}) {
  const { coarsePointer = false, drafts = {} } = options;
  const calls = {
    createSession: [],
    setDraft: [],
    sendMessage: [],
    switchTab: [],
    toast: [],
    refreshCaches: 0,
    order: [],
    started: [],
  };
  const sandbox = {
    console,
    relTime: () => 'just now',
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    PlatformUI: { toast: (m) => { calls.toast.push(m); } },
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
    UsernodeReact: { agentSession: { start: (hint) => { calls.started.push(hint); } } },
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
        return { id: 77 };
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
  + "and anything risky or worth checking. Just explain it for now, don't "
  + 'change any code or open a PR.';

const EXPECTED_SEED =
  'Let\'s explore PR #9300 in this app: "Adjust kanban breakpoint to 640px" by alice.\n'
  + 'PR link: https://github.com/acme/app/pull/9300\n'
  + 'Linked issues: #822.\n\n'
  + TAIL;

// An unused classic chat: no PR pushed, no title, not mid-turn, and no
// messages. Explore reused one like it before #2779; it must not now.
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
    'Let\'s explore PR #9300 in this app: "Adjust kanban breakpoint to 640px" by alice.\n'
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

// ── Where it opens (#2779) ─────────────────────────────────────────────────

test('opens an unsent agent session on the proposal, carrying the seed', () => {
  const { AppView, calls } = makeHarness();
  AppView._proposals = [PR];
  AppView._mySessions = [CLEAN];

  AppView.exploreProposalInDevChat(7);

  assert.equal(calls.started.length, 1);
  assert.deepEqual({ ...calls.started[0] }, {
    slug: 'test-app', proposalId: 7, entry: 'proposal', message: EXPECTED_SEED,
  });
  assert.equal(calls.createSession.length, 0, 'no classic session is created');
  assert.equal(calls.setDraft.length, 0, 'nor is an existing one drafted into, unused or not');
  assert.equal(calls.switchTab.length, 0);
  assert.equal(calls.refreshCaches, 0, 'nothing is fetched to choose a session');
  assert.equal(calls.sendMessage.length, 0, 'nothing is ever sent');
});

test('resolves a merged row from the Completed cache, skipping close-issue rows', () => {
  const { AppView, calls } = makeHarness();
  // An issues.id can collide with a session id — the close_issue row must
  // never be mistaken for the merged PR proposal.
  AppView._merged = [
    { id: 7, row_type: 'close_issue', pr_title: 'Close #12' },
    { ...PR, status: 'merged' },
  ];

  AppView.exploreProposalInDevChat(7);

  assert.match(calls.started[0].message, /^Let's explore PR #9300 /);
  assert.match(calls.started[0].message, /This proposal is already merged\./);
});

test('a proposal no cache holds still opens the conversation, without a message', () => {
  const { AppView, calls } = makeHarness();
  AppView._proposals = [PR];

  AppView.exploreProposalInDevChat(4242);

  assert.deepEqual({ ...calls.started[0] }, { slug: 'test-app', proposalId: 4242, entry: 'proposal' });
});

test('no app on screen, or no id: a quiet no-op', () => {
  const { AppView, calls } = makeHarness();
  AppView.exploreProposalInDevChat('nope');
  AppView.appData = null;
  AppView.exploreProposalInDevChat(7);
  assert.equal(calls.started.length, 0);
});

// ── Card / topic-head rendering ────────────────────────────────────────────

test('the card pill carries the class, the proposal id and the label', () => {
  const { AppView } = makeHarness();
  const html = AppView._exploreChatBtnHtml(PR);
  assert.match(html, /gc-explore-chat-btn/);
  assert.match(html, /data-proposal-id="7"/);
  assert.match(html, /Explore in a coding agent/);
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

// The card-as-pointer revision demoted most card actions into the ⋯ menu,
// whose descriptors live in AppView._cardMenus keyed by the trigger's
// data-card-menu — so "does this card offer X" is a registry question, not
// a markup one, for everything except the face pills.
function menuLabels(AppView, html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  if (!m) return [];
  return (AppView._cardMenus[m[1]] || []).map((it) => it.label);
}
function menuHas(AppView, html, re) {
  return menuLabels(AppView, html).some((l) => re.test(l));
}

const MY_IMPORT = {
  id: 7, pr_number: 9300, pr_url: 'https://github.com/acme/app/pull/9300',
  pr_title: 'Adjust kanban breakpoint to 640px', username: 'me', user_id: ME_ID,
  status: 'promoted', source: 'imported', imported_pr_author: 'octo-contributor',
  created_at: '2026-06-01T00:00:00Z',
};

test('proposal card: my own IMPORTED proposal offers Explore from ⋯, and no Open session', () => {
  const AppView = cardHarness();
  const html = proposalCardHtml(AppView, MY_IMPORT);
  // #1787 round four put Explore back in ⋯ on cards; _showExplorePill's rule
  // about WHO is offered it (#1045) is untouched, only WHERE.
  assert.ok(menuHas(AppView, html, /Explore in a coding agent/),
    'the ⋯ row is the owner\'s only AI affordance here');
  assert.ok(!html.includes('gc-explore-chat-btn'), 'and not also a face pill');
  assert.ok(!menuHas(AppView, html, /Open session/),
    'an imported PR has no dev session to open (#687) — that rule is untouched');
  assert.ok(menuHas(AppView, html, /^Withdraw$/), 'Withdraw is untouched too — now a ⋯ row');
});

test('proposal card: my own NATIVE proposal is unchanged — Open session, no pill', () => {
  const AppView = cardHarness();
  const html = proposalCardHtml(AppView, { ...MY_IMPORT, source: undefined, imported_pr_author: undefined });
  assert.doesNotMatch(html, /gc-explore-chat-btn/, 'no pill on the face');
  assert.ok(!menuHas(AppView, html, /Explore in a coding agent/), 'and no ⋯ row either');
  assert.ok(menuHas(AppView, html, /Open session/), 'Open session is the ⋯ door to the same chat');
});

test('merged card: my own IMPORTED completed proposal renders the pill', () => {
  const AppView = cardHarness();
  const html = mergedCardHtml(AppView, { ...MY_IMPORT, status: 'merged' }, 1);
  // On a merged card the action band belongs to kudos, so Explore is a ⋯ row.
  assert.ok(menuHas(AppView, html, /Explore in a coding agent/),
    'Explore offered from ⋯ on my own imported completed proposal');
});

test('merged card: my own NATIVE completed proposal still renders no pill', () => {
  const AppView = cardHarness();
  const html = mergedCardHtml(AppView, 
    { ...MY_IMPORT, source: undefined, imported_pr_author: undefined, status: 'merged' }, 1
  );
  assert.doesNotMatch(html, /gc-explore-chat-btn/);
  assert.ok(!menuHas(AppView, html, /Explore in a coding agent/), 'no ⋯ row on my own native merged PR');
});

// ── The availability probe forwards ?demo=1 ─────────────────────────────────
//
// Staging previews run without the platform LLM key (it's on the
// platform-secrets denylist), so the real branch of GET /api/budget answers
// aiEnabled:false there and _applyExploreChatAvailability rewrites every
// Explore button's title to "AI chat isn't configured…" one fetch round-trip
// after the board paints. The card-menu dapp.json check matches on
// title^="Open a dev chat…", so before demo forwarding it was a race against
// that rewrite (~50ms window). The demo branch answers aiEnabled:true, which
// keeps demo-preview chrome in its configured state — same idiom as every
// other _demoQS() forward on this view.

function probeHarness(search, budget) {
  const h = makeHarness();
  // _demoQS reads location.search through URLSearchParams — a Node global,
  // not a JS intrinsic, so the vm context doesn't have it by default.
  h.sandbox.URLSearchParams = URLSearchParams;
  h.sandbox.location = { search, hash: '' };
  h.calls.fetched = [];
  h.sandbox.fetch = async (url) => {
    h.calls.fetched.push(String(url));
    return { ok: true, json: async () => budget };
  };
  return h;
}

test('availability probe: ?demo=1 pages hit the demo branch of /api/budget', async () => {
  const { AppView, calls } = probeHarness('?demo=1', { aiEnabled: true, demo: true });
  assert.equal(await AppView._ensureAiAvailability(), true);
  assert.deepEqual(calls.fetched, ['/api/budget?demo=1'],
    'the probe forwards ?demo=1 like every other demo-aware fetch');
});

test('availability probe: production pages fetch /api/budget unadorned', async () => {
  const { AppView, calls } = probeHarness('', { aiEnabled: false });
  assert.equal(await AppView._ensureAiAvailability(), false,
    'a real aiEnabled:false still disables the pill outside demo mode');
  assert.deepEqual(calls.fetched, ['/api/budget']);
});
