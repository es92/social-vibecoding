// Card action contract (app-view.js) — the CARD-AS-POINTER budget.
//
// #404 routed every action through one flat .gc-card-actions row and
// DELIBERATELY rejected an overflow menu; the original version of this file
// pinned that by asserting the ABSENCE of gc-overflow-btn / gc-action-menu.
// The card-as-pointer revision REVERSES that decision, so this file now pins
// the opposite contract:
//
//   • at most AppView.ACTION_PRIMARY_MAX (2) text pills on the card face,
//   • one icon-only Preview affordance (kept as an icon so a read-only
//     viewer, who gets no vote buttons, still has a visible affordance),
//   • one ⋯ trigger carrying every demoted action as a descriptor,
//   • and NO ⋯ at all when a card has nothing to demote.
//
// assertNoOverflowMachinery is gone; assertCardActionContract replaces it.
// Permission rules are unchanged — an action only ever MOVED between the card
// face, the ⋯ menu and the detail view, so every per-viewer-role case from
// the original file is preserved, just re-pointed at wherever the action now
// lives.
//
// app-view.js is a plain browser script (`const AppView = {…}`); we load it
// into a vm context, stub the globals it reaches, and assert on the returned
// HTML strings — same harness as archive-proposal-card.test.js.
//
// Run with: node --test tests/card-action-layout.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView(userId, opts) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: userId, canAdminWrite: !!(opts && opts.admin) } },
    // Distinct marker so we can assert the kudos button is present inline.
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>' },
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
  AppView._mergedCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView.__sandbox = sandbox;
  return AppView;
}

const ME = 42;

// How many text pills the card face actually rendered. The overflow trigger
// and the preview icon both carry .gc-vote-btn-icon, so they don't count.
function primaryCount(html) {
  const row = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>/);
  if (!row) return 0;
  const buttons = row[1].match(/<button[^>]*>/g) || [];
  return buttons.filter((b) => !/gc-vote-btn-icon/.test(b)).length;
}

// The ⋯ trigger's registry key, or null when the card rendered no menu.
function menuKeyOf(html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  return m ? m[1] : null;
}

// The descriptor labels the card registered, in order.
function menuLabels(AppView, html) {
  const key = menuKeyOf(html);
  if (!key) return [];
  return (AppView._cardMenus[key] || []).map((it) => it.label);
}

// Does the registered menu carry an item whose label matches, and is it
// actionable (has an `act` closure) unless we expected it disabled?
function menuHas(AppView, html, re, opts) {
  const key = menuKeyOf(html);
  if (!key) return false;
  const it = (AppView._cardMenus[key] || []).find((x) => re.test(x.label));
  if (!it) return false;
  if (opts && opts.disabled) return !!it.disabled;
  return !!it.act;
}

// The card-as-pointer budget: at most 2 text pills, and a ⋯ trigger exactly
// when there is something behind it.
function assertCardActionContract(AppView, html, expect) {
  const e = expect || {};
  const n = primaryCount(html);
  assert.ok(n <= AppView.ACTION_PRIMARY_MAX,
    `at most ${AppView.ACTION_PRIMARY_MAX} text pills on the card face, saw ${n}`);
  if (e.primary !== undefined) {
    assert.equal(n, e.primary, `expected ${e.primary} primary pill(s), saw ${n}`);
  }
  const labels = menuLabels(AppView, html);
  if (e.menu === false) {
    assert.equal(menuKeyOf(html), null, 'no ⋯ trigger when nothing is demoted');
  } else if (e.menu === true) {
    assert.notEqual(menuKeyOf(html), null, '⋯ trigger present');
    assert.ok(labels.length > 0, '⋯ menu carries at least one descriptor');
  }
  if (e.previewIcon !== undefined) {
    const hasIcon = /gc-vote-btn-preview[^>]*gc-vote-btn-icon|gc-vote-btn-icon[^>]*gc-vote-btn-preview/.test(html);
    assert.equal(hasIcon, e.previewIcon,
      e.previewIcon ? 'icon-only Preview affordance present' : 'no Preview affordance');
  }
  // The demoted actions must NOT also sit on the card face.
  assert.doesNotMatch(html, /gc-card-actions[\s\S]*?>Withdraw</, 'Withdraw is not a card pill');
  assert.doesNotMatch(html, /gc-card-actions[\s\S]*?>Admin merge</, 'Admin merge is not a card pill');
}

// ── _cardActionsHtml composer (flat, layout-only) ─────────────────────────

test('_cardActionsHtml: legacy array shape still wraps a flat button list', () => {
  const AppView = makeAppView(ME);
  const html = AppView._cardActionsHtml([
    '<button class="gc-vote-btn">A</button>',
    '',
    '<button class="gc-vote-btn">B</button>',
  ]);
  assert.match(html, /^<div class="gc-card-actions">/, 'uses the shared container');
  assert.match(html, />A</);
  assert.match(html, />B</);
});

test('_cardActionsHtml: spec shape caps primaries and appends the preview icon', () => {
  const AppView = makeAppView(ME);
  const html = AppView._cardActionsHtml({
    primary: [
      '<button class="gc-vote-btn">A</button>',
      '',
      '<button class="gc-vote-btn">B</button>',
      '<button class="gc-vote-btn">C</button>',
    ],
    preview: '<button class="gc-vote-btn gc-vote-btn-preview gc-vote-btn-icon">eye</button>',
  });
  assert.match(html, />A</);
  assert.match(html, />B</);
  assert.doesNotMatch(html, />C</, 'the third primary is dropped — it belongs in ⋯');
  assert.equal(primaryCount(html), AppView.ACTION_PRIMARY_MAX);
  // The ⋯ is NOT in the action row any more — it is pinned in the card head.
  assert.equal(menuKeyOf(html), null);
});

test('the ⋯ lives in the card\'s top-right RAIL, not in the action row', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal());
  // The rail is the card's last child: a right-edge column holding the ⋯ at
  // the top and the tap-through chevron centred below it. Sharing one column
  // rather than taking two is what keeps the badge row's width — a separate
  // flex slot for the ⋯ cost 30px of a ~175px row.
  assert.match(html, /dev-card-rail/);
  const rail = html.slice(html.indexOf('dev-card-rail'));
  assert.match(rail, /dev-card-menu-btn/, 'the trigger is inside the rail');
  assert.match(rail, /M9 5l7 7-7 7/, 'and the chevron below it');
  // Never in the action row.
  const actions = html.match(/<div class="gc-card-actions">[\s\S]*?<\/div>/);
  assert.ok(actions && !/data-card-menu/.test(actions[0]),
    'the action row carries only the primaries and the preview icon');
  assert.match(html, /aria-haspopup="true"/);
  assert.match(html, /aria-label="More actions"/);
});

test('_cardContentHtml: no ⋯ when there is nothing to demote', () => {
  const AppView = makeAppView(ME);
  const html = AppView._cardContentHtml({
    headlineHtml: AppView._cardHeadlineHtml('T', 'M'), badges: [], chatCount: 0, menu: [],
  });
  assert.equal(menuKeyOf(html), null);
  const conditioned = AppView._cardContentHtml({
    headlineHtml: '', badges: [], chatCount: null, menu: [null, false, undefined], menuKey: 'k',
  });
  assert.equal(menuKeyOf(conditioned), null);
});

test('_cardActionsHtml: empty / all-falsy input renders nothing', () => {
  const AppView = makeAppView(ME);
  assert.equal(AppView._cardActionsHtml([]), '');
  assert.equal(AppView._cardActionsHtml(['', null, undefined]), '');
  assert.equal(AppView._cardActionsHtml(), '');
  assert.equal(AppView._cardActionsHtml({ primary: [], menu: [] }), '');
});

// ── Issue card ───────────────────────────────────────────────────────────

const baseIssue = (over) => ({ number: 5, title: 'Fix the thing', ...over });

test('issue card: ONE state-driven primary; kudos / claim / close move to ⋯', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderIssueRow(baseIssue());
  assert.match(html, /gc-card-actions/, 'shared action row present');
  // The single primary for a never-started issue.
  assert.match(html, /createPrForIssue\(5\)[^>]*>Create proposal</);
  assertCardActionContract(AppView, html, { primary: 1, menu: true, previewIcon: false });
  // Generating a headless proposal spends the viewer's credits, so it is a
  // chosen ⋯ action rather than the card's most prominent button.
  assert.ok(menuHas(AppView, html, /^Generate proposal$/), 'Generate proposal in ⋯');
  assert.ok(menuHas(AppView, html, /Pledge kudos/), 'Pledge kudos in ⋯');
  assert.ok(menuHas(AppView, html, /Mark in progress/), 'Mark in progress in ⋯');
  assert.ok(menuHas(AppView, html, /Propose to close/), 'Propose to close in ⋯');
  assert.ok(menuHas(AppView, html, /Set priority/), 'Set priority… in ⋯');
  // …and none of them on the card face.
  assert.doesNotMatch(html, /giveIssueBounty/, 'no kudos pill');
  assert.doesNotMatch(html, /markIssueInProgress/, 'no claim pill');
  assert.doesNotMatch(html, /promptCloseIssue/, 'no close pill');
});

test('issue card: a ready headless run IS the primary, replacing Create proposal', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderIssueRow(baseIssue({
    headless: { status: 'ready', outcome: 'spec', sessionId: 90 },
  }));
  assert.match(html, /startFromAutoSession\(90\)[^>]*>Review spec/, 'contextual ready label is the primary');
  assert.doesNotMatch(html, /createPrForIssue/, 'Create proposal is superseded, not stacked beside it');
  assertCardActionContract(AppView, html, { primary: 1, menu: true });
  assert.ok(menuHas(AppView, html, /Pledge kudos/), 'kudos still reachable, from ⋯');
});

test('issue card: a question outcome folds TWO competing pills into one primary', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderIssueRow(baseIssue({
    headless: { status: 'ready', outcome: 'question', sessionId: 91 },
  }));
  // Previously this row rendered the clone action AND a second "Generate
  // proposal" pill side by side. Now: one "Answer & regenerate" primary,
  // with the re-run in ⋯.
  assert.match(html, /Answer &amp; regenerate/, 'single folded primary');
  assertCardActionContract(AppView, html, { primary: 1, menu: true });
  assert.ok(menuHas(AppView, html, /^Generate proposal$/), 're-run reachable from ⋯');
});

test('issue card: a run the viewer already cloned offers no competing re-run', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderIssueRow(baseIssue({
    headless: { status: 'ready', outcome: 'question', sessionId: 91, mySessionId: 92 },
  }));
  assert.match(html, /goToAutoSessionClone\(92\)[^>]*>Go to session</);
  assert.ok(!menuHas(AppView, html, /^Generate proposal$/),
    'no re-run beside "Go to session" — the proposal already exists (#150)');
});

test('issue card: a generating run disables the primary and hides Generate', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderIssueRow(baseIssue({
    headless: { status: 'generating', sessionId: 93 },
  }));
  assert.match(html, /disabled[^>]*>Generating proposal/);
  assert.ok(!menuHas(AppView, html, /^Generate proposal$/), 'nothing to generate while one runs');
});

test('issue card: read-only viewer gets no primary, keeps a read-safe ⋯', () => {
  const AppView = makeAppView(ME);
  AppView.appData = { slug: 'x', can_collaborate: false };
  const html = AppView._renderIssueRow(baseIssue({ htmlUrl: 'https://github.com/o/r/issues/5' }));
  assertCardActionContract(AppView, html, { primary: 0, menu: true });
  // join(), not deepEqual: the vm context has its own Array prototype, so
  // deepStrictEqual on a cross-realm array fails on the prototype alone.
  assert.equal(menuLabels(AppView, html).join('|'), 'Open on GitHub',
    'only the read-safe row survives for a read-only viewer');
  AppView.appData = null;
});

// ── Proposal card ──────────────────────────────────────────────────────────

const baseProposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'me',
  user_id: 999, status: 'promoted', yes_count: 0, no_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});

test('proposal card: Yes/No are the two primaries and keep their colours', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal());
  assert.match(html, /gc-vote-btn-yes[^>]*castVote\(7, 'yes'\)/);
  assert.match(html, /gc-vote-btn-no[^>]*castVote\(7, 'no'\)/);
  assertCardActionContract(AppView, html, { primary: 2, menu: true });
});

test('proposal card: read-only viewer keeps the icon Preview and loses Yes/No', () => {
  const AppView = makeAppView(ME);
  AppView.appData = { slug: 'x', can_collaborate: false };
  const html = AppView._renderProposalCard(baseProposal({ staging_url: 'https://stg.example' }));
  assert.doesNotMatch(html, /castVote/, 'no vote buttons for a read-only viewer');
  // The whole reason Preview is an icon: without it this card would carry no
  // visible affordance at all for someone who cannot vote.
  assertCardActionContract(AppView, html, { primary: 0, previewIcon: true });
  assert.match(html, /aria-label="Open preview"/, 'the icon has a real accessible name');
  AppView.appData = null;
});

test('proposal card (admin, not author): Admin merge / kudos / Explore all in ⋯', () => {
  const AppView = makeAppView(ME, { admin: true });
  const html = AppView._renderProposalCard(baseProposal({ staging_url: 'https://stg.example' }));
  assert.match(html, /swapToStagingForSession\(7/, 'Preview present, as the icon');
  assertCardActionContract(AppView, html, { primary: 2, menu: true, previewIcon: true });
  assert.ok(menuHas(AppView, html, /Admin merge/), 'Admin merge in ⋯');
  assert.ok(menuHas(AppView, html, /kudos/i), 'kudos in ⋯');
  assert.ok(menuHas(AppView, html, /Explore in dev chat/), 'Explore in dev chat in ⋯');
  assert.doesNotMatch(html, /gc-explore-chat-btn/, 'no Explore pill on the card face');
});

test('proposal card (author): Open session + Withdraw move to ⋯', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ user_id: ME }));
  assert.ok(menuHas(AppView, html, /Open session/), 'Open session in ⋯');
  assert.ok(menuHas(AppView, html, /Withdraw/), 'Withdraw in ⋯');
  assert.ok(!menuHas(AppView, html, /Explore in dev chat/),
    'owners reach the Mayor via Open session, so no Explore row on their own PR');
  assertCardActionContract(AppView, html, { primary: 2, menu: true });
});

// #1045: the owner of an IMPORTED proposal gets Withdraw + Explore instead
// of Withdraw + Open session (there is no dev session to open), and that
// row must still lay out inline like every other.
test('proposal card (author of an imported PR): Withdraw + Explore render inline', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ user_id: ME, source: 'imported' }));
  assert.match(html, /withdrawProposal\(7\)/, 'Withdraw present');
  assert.match(html, /gc-explore-chat-btn/, 'Explore in dev chat present');
  assert.doesNotMatch(html, /openProposalSession/, 'no dev session behind an imported PR');
  assert.match(html, /gc-card-actions/, 'shared action row present');
  assertNoOverflowMachinery(html);
});

// ── Governance card ──────────────────────────────────────────────────────

const baseGov = (over) => ({
  id: 11, kind: 'secret_change', title: 'Set API key', up_count: 0, down_count: 0,
  created_by: 999, created_at: '2026-06-01T00:00:00Z', ...over,
});

test('gov card: Yes/No are the primaries, Admin merge + Withdraw go to ⋯', () => {
  const AppView = makeAppView(ME, { admin: true });
  const html = AppView._renderGovCard(baseGov({ created_by: ME }));
  assert.match(html, /castIssueVote\(11, 'up'\)/);
  assert.match(html, /castIssueVote\(11, 'down'\)/);
  assertCardActionContract(AppView, html, { primary: 2, menu: true });
  assert.ok(menuHas(AppView, html, /Admin merge/), 'Admin merge in ⋯');
  assert.ok(menuHas(AppView, html, /Withdraw/), 'Withdraw in ⋯');
});

test('gov card: a settled row renders the frozen pill and NO ⋯', () => {
  const AppView = makeAppView(ME, { admin: true });
  const html = AppView._renderGovCard(baseGov({
    status: 'applied', payload: { issueNumber: 5, appliedAt: '2026-06-02T00:00:00Z', required: 3 },
    kind: 'close_issue',
  }));
  assert.doesNotMatch(html, /castIssueVote/, 'the vote is history');
  assertCardActionContract(AppView, html, { primary: 0, menu: false });
});

test('gov card: non-admin non-creator sees only yes/no, and no ⋯ at all', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderGovCard(baseGov());
  assert.match(html, /castIssueVote\(11, 'up'\)/);
  assert.ok(!menuHas(AppView, html, /Admin merge/), 'no admin merge for non-admin');
  assert.ok(!menuHas(AppView, html, /Withdraw/), 'no withdraw for non-creator');
  // Nothing to demote → no dead ⋯ button.
  assertCardActionContract(AppView, html, { primary: 2, menu: false });
});

// ── Merged card ────────────────────────────────────────────────────────────

const baseMerged = (over) => ({
  id: 8, pr_number: 800, pr_title: 'Ship it', username: 'someone', user_id: 999,
  status: 'merged', yes_count: 3, no_count: 1, chat_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});

test('merged card: no text actions; Undo / kudos / Explore all in ⋯', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderMergedCard(baseMerged({ my_vote: 'yes' }), 1);
  // The "You voted X" box is gone from the card face — the pill's tooltip
  // and the detail view's vote roster carry that now.
  assert.doesNotMatch(html, /gc-vote-voted-box/, 'no "You voted X" box on the board');
  assertCardActionContract(AppView, html, { primary: 0, menu: true });
  assert.ok(menuHas(AppView, html, /Undo/), 'Undo in ⋯');
  assert.ok(menuHas(AppView, html, /kudos/i), 'kudos in ⋯');
  assert.ok(menuHas(AppView, html, /Explore in dev chat/), 'Explore in dev chat in ⋯');
});

test('merged card: revert status reads on the META LINE, not as an action', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderMergedCard(baseMerged({
    revert_session_id: 9, revert_status: 'merged', revert_pr_number: 900,
  }), 1);
  assert.match(html, /dev-card-headline-meta[\s\S]*?Undone by PR#900/,
    'the revert relationship is a FACT about the change, so it lives in the meta line');
  assert.ok(!menuHas(AppView, html, /^Undo$/), 'no Undo once a revert exists');
});

// ── voteButtonsHtml: group-chat collapsed-vote path unchanged ──────────────

test('voteButtonsHtml: collapseVoted returns the read-only "You voted X" box', () => {
  const AppView = makeAppView(ME);
  const yes = AppView.voteButtonsHtml(baseProposal({ my_vote: 'yes' }), { collapseVoted: true });
  assert.match(yes, /gc-vote-voted-box gc-vote-voted-box-yes/);
  assert.match(yes, />You voted Yes</);
  // A non-promoted PR with no vote collapses to nothing.
  const none = AppView.voteButtonsHtml(baseProposal({ status: 'merged' }), { collapseVoted: true });
  assert.equal(none, '');
});

test('voteButtonsHtml: full set concatenates Preview/Yes/No/Admin (group-chat row)', () => {
  const AppView = makeAppView(ME, { admin: true });
  const html = AppView.voteButtonsHtml(baseProposal({ staging_url: 'https://stg' }));
  assert.match(html, /swapToStagingForSession/, 'Preview');
  assert.match(html, /castVote\(7, 'yes'\)/, 'Yes');
  assert.match(html, /castVote\(7, 'no'\)/, 'No');
  assert.match(html, /castAdminMerge\(7\)/, 'Admin merge');
});

test('native vote controls and request carry the exact rendered revision', async () => {
  const AppView = makeAppView(ME);
  const head = 'a'.repeat(40);
  const html = AppView.voteButtonsHtml(baseProposal({ reviewed_head_sha: head }));
  assert.match(html, new RegExp(`castVote\\(7, 'yes', '${head}'\\)`));
  assert.match(html, new RegExp(`castVote\\(7, 'no', '${head}'\\)`));
  const importedHtml = AppView.voteButtonsHtml(baseProposal({
    source: 'imported', reviewed_head_sha: head, imported_pr_head_sha: 'b'.repeat(40),
  }));
  assert.doesNotMatch(importedHtml, new RegExp(head),
    'imported proposals keep their established imported-head vote flow');

  let request = null;
  AppView.__sandbox.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await AppView.castVote(7, 'yes', head);
  assert.equal(request.url, '/api/sessions/7/vote');
  assert.deepEqual(JSON.parse(request.options.body), {
    vote: 'yes', expectedHeadSha: head,
  });
});
