// #386 gave the red affordance to 'failed' (an auto-resolve ran and gave
// up). The silent-merge-failure fix extends it to 'conflict': that state is
// written ONLY when a real merge attempt 405s at GitHub, and the
// auto-resolver drain only picks up vote-eligible proposals — so below the
// gate (or on an admin force-merge) nothing would ever retry and the old
// neutral "Behind main" badge was a false promise. 'conflict' now renders
// red ("Merge failed — conflict") with creator-must-finish guidance; while
// the resolver IS actively working, the 'resolving' state outranks it so
// the card shows progress instead of a stale failure.
//
// app-view.js and home.js are plain browser scripts (`const X = {…}`).
// We load each source into a vm context, stub the globals they reach,
// expose the object, and assert on the returned HTML string.
//
// Run with: node --test tests/proposal-conflict-affordance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { mergeConflictHtml, mergeabilityHtml, proposalCardHtml } = require('./lib/dev-card-html');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);
// #405: the proposal card derives its merge-state badge from
// window.MergeStatus, so load it into the sandbox first (mirrors the real page
// load order in index.html).
const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'),
  'utf8'
);

function makeAppView(userId) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: userId } },
    Kudos: { renderButton: () => '' },
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
  vm.runInContext(`${MERGE_STATUS_SRC}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  return AppView;
}

const ME = 42;
// check_state 'passing' keeps these rows on the conflict/behind rungs under
// test — with NO verdict recorded the #607 "Checks starting…" rung would
// outrank behind, same as 'pending' does.
const baseProposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'me',
  user_id: ME, status: 'promoted', created_at: '2026-06-01T00:00:00Z',
  check_state: 'passing', test_results: [],
  ...over,
});

// ── Proposal card badge ────────────────────────────────────────────────

test("card: a 'conflict' snapshot (merge attempt failed) shows a red 'GitHub refused the merge' tag", () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({
    merge_conflict_state: 'conflict',
    conflict_files: ['src/app.js', 'public/index.html'],
    behind_main: 2,
  }));
  assert.match(html, /<span class="dev-badge [^"]*red[^"]*"[^>]*>GitHub refused the merge<\/span>/,
    'the tag names the conflict after a real attempt');
  assert.match(html, /creator needs to finish the merge/, 'tooltip names the way out');
  assert.doesNotMatch(html, /gc-vote-count-blocked/, 'the bar is the vote');
  // "Outranks" was a rule the BAR needed, because it had one slot. Tags have
  // no such scarcity: both facts are true, so both are drawn, worst first.
  assert.match(html, /Behind main · 2/, 'the softer fact is no longer suppressed');
  assert.ok(html.indexOf('GitHub refused the merge') < html.indexOf('Behind main'), 'worst first');
  assert.doesNotMatch(html, /Needs manual resolution/, "the 'failed' affordance stays distinct");
});

test("card: a 'conflict' snapshot with the resolver in flight shows 'Resolving conflicts automatically…' instead", () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({
    merge_conflict_state: 'conflict',
    behind_main: 2,
    resolving: true,
  }));
  assert.match(html, /Resolving conflicts automatically…/, 'in-flight resolve outranks the failure badge');
  assert.doesNotMatch(html, /Merge failed — conflict/, 'no stale failure while progress is being made');
});

test("card: a 'failed' snapshot shows a red 'Needs manual resolution' tag", () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({
    merge_conflict_state: 'failed',
    conflict_files: ['src/server.js'],
    behind_main: 1,
  }));
  assert.match(html, /<span class="dev-badge [^"]*red[^"]*"[^>]*>Needs manual resolution<\/span>/,
    'the tag names the failed auto-resolve');
  assert.doesNotMatch(html, /gc-vote-count-blocked/, 'the bar is the vote');
  assert.match(html, /Behind main · 1/, 'and the behind fact is drawn too, after it');
  assert.ok(html.indexOf('Needs manual resolution') < html.indexOf('Behind main'));
});

test("card: a plain 'behind' snapshot still shows the amber Behind badge", () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({
    merge_conflict_state: 'behind',
    behind_main: 3,
  }));
  assert.match(html, /Behind main · 3/, 'behind badge unaffected by the change');
  assert.doesNotMatch(html, /⚠ Conflict/, 'no conflict affordance for a behind-only proposal');
});

// ── Proposal detail block ──────────────────────────────────────────────

test("detail: a 'conflict' snapshot renders the merge-failed detail box naming the creator", () => {
  const AppView = makeAppView(ME);
  const html = mergeConflictHtml(AppView, baseProposal({
    merge_conflict_state: 'conflict',
    conflict_files: ['src/app.js'],
    conflict_checked_at: '2026-06-01T00:00:00Z',
  }));
  assert.match(html, /A merge was attempted, but this proposal conflicts with main\./, 'merge-failed heading present');
  assert.match(html, /src\/app\.js/, 'lists the conflicting files');
  assert.match(html, /me<\/span> needs to finish the merge/, 'names the creator as the one who must act');
  assert.match(html, /Sync with main/, 'points at the dev-chat sync action');
});

// Task 153: the way out depends on WHERE THE HEAD LIVES, not on the state
// that asked. A connector submission is mirrored into the app repository, so
// its author has no dev-chat and no "Sync with main" — the branch is revised
// where it was written and submitted again. A hand-opened pull request from a
// fork is the one case the platform cannot sync at all, and the copy says so.
const mirrorProposal = (over) => baseProposal({
  source: 'imported',
  branch_name: 'usernode/from-me-t31-cafe',
  imported_pr_head_repo: 'acme/demo',
  repo_url: 'https://github.com/acme/demo',
  ...over,
});
const forkProposal = (over) => mirrorProposal({
  branch_name: 'feature/dark-mode',
  imported_pr_head_repo: 'me/demo',
  ...over,
});

// _headHome can only compare repositories it was sent. /promoted is the row
// the proposal card renders from, and until #2100 it did not carry the head
// repo at all — so every imported branch whose name was not in the
// connector's `usernode/from-…` namespace was called a fork, and the card
// told the group "the author must update this branch in their fork" about a
// branch in the app's own repository that the platform syncs itself.
test('head home: the /promoted row carries the head repo the comparison needs', () => {
  const votesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8');
  const start = votesSrc.indexOf("router.get('/api/apps/:slug/promoted'");
  assert.ok(start > 0, 'the promoted route exists');
  const select = votesSrc.slice(start, votesSrc.indexOf('FROM chat_sessions cs', start));
  assert.match(select, /\bcs\.imported_pr_head_repo\b/,
    'the card cannot tell a fork from an app-repo branch without the head repo');

  // And with it on the row, an app-repo branch under any name is app_repo.
  const AppView = makeAppView(ME);
  AppView.appData = { repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' };
  assert.equal(AppView._headHome({
    source: 'imported', branch_name: 'fix/imported-head-sync-votes',
    imported_pr_head_repo: 'Usernode-Labs/social-vibecoding',
  }), 'app_repo');
});

test('head home: a mirrored connector head is app_repo, a fork head is user_fork, a native row is app_repo', () => {
  const AppView = makeAppView(ME);
  assert.equal(AppView._headHome(baseProposal({})), 'app_repo');
  assert.equal(AppView._headHome(mirrorProposal({})), 'app_repo');
  assert.equal(AppView._headHome(forkProposal({})), 'user_fork');
  // Without a head repo on the row (imported before the column existed), the
  // platform's own branch namespace decides — same fallback as the server.
  assert.equal(AppView._headHome(mirrorProposal({ imported_pr_head_repo: null, repo_url: null })), 'app_repo');
  assert.equal(AppView._headHome(forkProposal({ imported_pr_head_repo: null, repo_url: null })), 'user_fork');
  // The app's own repo URL is the fallback comparison when the row has none.
  AppView.appData = { repo_url: 'https://github.com/acme/demo.git' };
  assert.equal(AppView._headHome(mirrorProposal({ repo_url: null, branch_name: 'odd/name' })), 'app_repo');
  assert.equal(AppView._headHome(forkProposal({ repo_url: null, branch_name: 'usernode/from-x' })), 'user_fork',
    'the recorded head repo outranks the branch name');
});

test("detail: a mirrored proposal's conflict box never sends its author to a dev-chat", () => {
  const AppView = makeAppView(ME);
  for (const state of ['conflict', 'failed']) {
    const html = mergeConflictHtml(AppView, mirrorProposal({
      merge_conflict_state: state,
      conflict_files: ['src/app.js'],
    }));
    assert.doesNotMatch(html, /Sync with main/, `${state}: no dev-chat action for a mirrored head`);
    assert.doesNotMatch(html, /dev-chat/, `${state}: no dev-chat at all`);
    assert.match(html, /submit it again as an update to this proposal/, `${state}: the way out is a resubmission`);
    assert.match(html, /me<\/span>/, `${state}: names the creator`);
  }
  const conflict = mergeConflictHtml(AppView, mirrorProposal({ merge_conflict_state: 'conflict' }));
  assert.match(conflict, /Homeroom keeps this branch itself/, 'says the platform can sync it');
  const failed = mergeConflictHtml(AppView, mirrorProposal({ merge_conflict_state: 'failed' }));
  assert.match(failed, /me<\/span> needs to bring the branch up to date/, 'after a failed resolve the author acts');
});

test("detail: a fork-homed proposal's conflict box says the platform cannot sync it", () => {
  const AppView = makeAppView(ME);
  const html = mergeConflictHtml(AppView, forkProposal({
    merge_conflict_state: 'failed',
    conflict_files: ['src/app.js'],
  }));
  assert.match(html, /own fork, which Homeroom cannot write to/);
  assert.match(html, /me<\/span> needs to merge main into the branch and push it/);
  assert.match(html, /the proposal follows the push/);
  assert.doesNotMatch(html, /Sync with main/);
});

test('pill: the block reason for an imported proposal carries the same remedy', () => {
  const AppView = makeAppView(ME);
  const mirror = AppView.blockReasons(mirrorProposal({ merge_conflict_state: 'conflict' }));
  assert.equal(mirror[0].key, 'merge_conflict');
  assert.match(mirror[0].detail, /Homeroom keeps this branch itself/);
  assert.doesNotMatch(mirror[0].detail, /dev session/);
  const fork = AppView.blockReasons(forkProposal({ merge_conflict_state: 'failed' }));
  assert.equal(fork[0].key, 'conflict_failed');
  assert.match(fork[0].detail, /cannot write to/);
  // A native row keeps the sentence the pill has always carried.
  const native = AppView.blockReasons(baseProposal({ merge_conflict_state: 'conflict' }));
  assert.match(native[0].detail, /Its creator needs to finish the merge from their dev session/);
});

test("detail: a 'conflict' snapshot with the resolver in flight renders nothing (progress badge covers it)", () => {
  const AppView = makeAppView(ME);
  const html = mergeConflictHtml(AppView, baseProposal({
    merge_conflict_state: 'conflict',
    conflict_files: ['src/app.js'],
    resolving: true,
  }));
  assert.equal(html, '', 'no stale failure box while a resolve is actively running');
});

test("detail: a 'failed' snapshot renders the red 'resolution failed' detail box", () => {
  const AppView = makeAppView(ME);
  const html = mergeConflictHtml(AppView, baseProposal({
    merge_conflict_state: 'failed',
    conflict_files: ['src/server.js'],
    conflict_checked_at: '2026-06-01T00:00:00Z',
  }));
  assert.match(html, /Automatic conflict resolution failed\./, 'failed heading present');
  assert.match(html, /src\/server\.js/, 'lists the conflicting files');
  assert.match(html, /Sync with main/, 'keeps the manual-resolve guidance');
});

// A "Cog-drawer compact badge" block used to sit here, asserting that the SAME
// MergeStatus.badgeHtml string reached the header cog drawer's proposal rows —
// the section that had itself moved there from the home screen's "Your
// proposals" strip.
//
// THE UI OVERHAUL retired that drawer: its session list is the Improve panel's,
// scoped to the app on screen, and its pinned "Needs attention" rows are
// ordinary notifications in the merged hamburger. The card and detail
// assertions above are the whole surface now, and MergeStatus is still the one
// owner of the badge across every one of them.

// ── #1442: the conflict nobody has attempted yet ───────────────────────
//
// Everything above is about merge_conflict_state, which is written only when
// a real merge attempt failed. Proposal 3590 never got that far: the gate
// only attempts a merge once a proposal already looks mergeable, so for the
// entire time it was unmergeable it showed green checks and no conflict at
// all. `mergeability` is GitHub's PREDICTION, measured while the votes are
// still coming in, and these lock the two apart.

const FRESH = (over) => ({
  checkedAt: '2026-06-02T00:00:00Z',
  mainSha: 'a'.repeat(40),
  mergeBaseSha: 'b'.repeat(40),
  behindBy: 8, aheadBy: 3,
  mergeability: 'conflict',
  mergeabilityFiles: ['dapp.json', 'src/routes/votes.js'],
  mergeabilityFilesComplete: true,
  checksRanOnBase: null, checksBaseVerdict: 'current', checksBaseBehindBy: 0,
  error: null,
  ...over,
});

test('detail: a predicted conflict renders its own box, distinct from the attempted one', () => {
  const AppView = makeAppView(ME);
  const html = mergeabilityHtml(AppView, baseProposal({ freshness: FRESH() }));
  assert.match(html, /no longer merges into main on its own/, 'names the prediction, not an attempt');
  assert.match(html, /Changed on both sides:/);
  assert.match(html, /dapp\.json/);
  assert.match(html, /src\/routes\/votes\.js/);
  assert.match(html, /Some of those may still merge cleanly/,
    'the file list is an upper bound and says so');
  // The platform resolves a conflict itself now (once unasked, then once the
  // vote passes), so the creator is offered the faster way out, not handed
  // the only one.
  assert.match(html, /The platform resolves it automatically/);
  assert.match(html, /me<\/span> can also bring it up to date sooner/, 'names the creator');
  assert.match(html, /Sync with main/, 'points at the way out');
  assert.doesNotMatch(html, /needs to bring it up to date/, 'not the creator\'s job alone');
  assert.doesNotMatch(html, /A merge was attempted/, 'no attempt has been made');
});

test('detail: the remedy follows the conflict lane\'s own verdict on the head', () => {
  const AppView = makeAppView(ME);
  const withLane = (reasons) => mergeabilityHtml(AppView, baseProposal({
    freshness: FRESH(), integration: { blockReasons: reasons, mergesClean: false },
  }));
  // Spent its one pre-approval resolution: the vote is what unlocks the next.
  const waiting = withLane(['awaiting_approval']);
  assert.match(waiting, /resolves it once the vote passes/);
  assert.match(waiting, /me<\/span> can bring it up to date sooner/);
  // The lane tried and gave up: now it IS the creator's job, and says so.
  const gaveUp = withLane(['unresolvable']);
  assert.match(gaveUp, /tried to resolve it and could not/);
  assert.match(gaveUp, /me<\/span> needs to bring it up to date/);
  // In flight: nothing to do, and no instruction to do it.
  const working = withLane(['integrating']);
  assert.match(working, /resolving it now/);
  assert.doesNotMatch(working, /Sync with main/);
  // The pill's plain-text detail carries the same answer.
  const text = (reasons) => AppView._conflictRemedy(
    baseProposal({ freshness: FRESH(), integration: { blockReasons: reasons } }), 'predicted'
  ).text;
  assert.match(text(['unresolvable']), /^The platform tried to resolve it and could not\. me needs to bring it up to date/);
  assert.match(text([]), /^The platform resolves it automatically\. me can also/);
});

test('detail: a capped file list is described as a sample', () => {
  const AppView = makeAppView(ME);
  const html = mergeabilityHtml(AppView, baseProposal({
    freshness: FRESH({ mergeabilityFilesComplete: false }),
  }));
  assert.match(html, /That is a sample of the files/);
});

test('detail: a predicted conflict with no located files still explains itself', () => {
  const AppView = makeAppView(ME);
  const html = mergeabilityHtml(AppView, baseProposal({
    freshness: FRESH({ mergeabilityFiles: [], mergeabilityFilesComplete: null }),
  }));
  assert.match(html, /no longer merges into main on its own/);
  assert.doesNotMatch(html, /Changed on both sides/, 'no empty list header');
});

test('detail: an ATTEMPTED merge failure outranks the prediction', () => {
  const AppView = makeAppView(ME);
  const pr = baseProposal({
    merge_conflict_state: 'conflict',
    conflict_files: ['src/app.js'],
    freshness: FRESH(),
  });
  assert.equal(mergeabilityHtml(AppView, pr), '', 'the prediction stands down');
  assert.match(mergeConflictHtml(AppView, pr), /A merge was attempted/,
    'and the record of the real attempt is what renders');
});

test('detail: a resolve in flight silences the prediction too', () => {
  const AppView = makeAppView(ME);
  assert.equal(
    mergeabilityHtml(AppView, baseProposal({ resolving: true, freshness: FRESH() })),
    '',
    'no stale conflict box while a resolve is actively running'
  );
});

test("detail: 'clean' and 'unknown' render nothing", () => {
  const AppView = makeAppView(ME);
  for (const m of ['clean', 'unknown', null]) {
    assert.equal(
      mergeabilityHtml(AppView, baseProposal({ freshness: FRESH({ mergeability: m }) })),
      '',
      `${m} is not a conflict`
    );
  }
});

test('detail: flat columns are read when the nested block is absent', () => {
  // The votes routes serialize both — the nested `freshness` block and the
  // raw columns — and older cached rows in the client only have the columns.
  const AppView = makeAppView(ME);
  const html = mergeabilityHtml(AppView, baseProposal({
    mergeability: 'conflict',
    mergeability_files: ['src/db/schema.sql'],
    mergeability_files_complete: true,
  }));
  assert.match(html, /no longer merges into main on its own/);
  assert.match(html, /src\/db\/schema\.sql/);
});

test('card: a predicted conflict is a red tag, and the tally is untouched', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({ freshness: FRESH() }));
  assert.match(html, /<span class="dev-badge [^"]*red[^"]*"[^>]*>Conflicts with main · 2 files<\/span>/,
    'the tag names it and counts the files');
  assert.doesNotMatch(html, /gc-vote-count-blocked/, 'the bar is the vote, not the conflict');
  // The predicted conflict brings a "behind main" with it; both are drawn.
  assert.match(html, /<span class="dev-badge [^"]*amber[^"]*"[^>]*>Behind main · \d+<\/span>/);
});

test('card: the attempted-merge pill still wins over the predicted one', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({
    merge_conflict_state: 'conflict', freshness: FRESH(),
  }));
  assert.match(html, /GitHub refused the merge/);
  assert.doesNotMatch(html, /Conflicts with main/, 'one conflict pill, and it is the real one');
});
