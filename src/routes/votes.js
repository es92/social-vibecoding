const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const github = require('../services/github');
const githubMock = require('../services/github-mock');
const staging = require('../services/staging');
const docker = require('../services/docker');
const { checkAndResolveConflicts, isResolving } = require('../services/conflict-resolver');
const { sendSystemMessage, pushNotificationToUser } = require('../services/ws');
const { getActiveUserStats, isUserActive } = require('../services/active-users');
const notifications = require('../services/notifications');
const { isAppLocked, hasAdminYesVote } = require('../services/admin-approval');
const events = require('../services/events');
const appAccess = require('../services/app-access');
const appAdmins = require('../services/app-admins');
const { effectiveSessionCaps } = require('../services/session-caps');
const topicAttrs = require('../services/topic-attributes');
const { usesMockGithubForImports } = require('../config');
const { drainGuard } = require('../services/lifecycle');
const { isCliCredentialManagementSession } = require('../services/cli-api-policy');
const {
  reviewedHeadForSession,
  currentVotePredicateSql,
  sameSha,
} = require('../services/pr-vote-revision');

const CLI_CREDENTIAL_MANAGEMENT_ERROR = 'credential_management_not_available_via_cli';

// #687: pick the GitHub client the imported-PR flow talks to. Staging
// previews use the in-memory mock (no GitHub credentials there — see
// usesMockGithubForImports in config.js); production always uses the real
// client. Only the client swaps; the surrounding flow is identical.
function importGithubClient() {
  return usesMockGithubForImports() ? githubMock : github;
}

// Staging-only mock PR proposals for GET /api/apps/:slug/promoted,
// appended only when the request carries ?demo=1 (forwarded from the
// page URL by _demoQS in app-view.js). Sibling of stagingMockIssues in
// routes/issues.js: deliberately long titles (~90-120 chars) so the dev
// card list's progressive title wrapping can be verified on narrow
// screens against a prod-cloned DB. Rows are "[Mock]"-prefixed and use
// ids/PR numbers far above anything real so they can't collide with
// (or be mistaken for) live sessions; user_id 0 matches no viewer, so
// owner-only affordances ("Open session") never render on them. Casting
// a vote on one 404s harmlessly. Strictly a no-op in production.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// `viewer` (the requesting user's username, when known) seeds ONE mock
// proposal's assignee as the viewer's own so the #600 "already voted"
// assignee-dropdown state (name box empty, viewer's pick checked) is
// reviewable on staging via ?demo=1; the rest stay assigned to
// staging-tester with myValue null, so opening their dropdown pre-fills
// the viewer's own username.
function stagingMockProposals(viewer) {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
  // gate = { required, windowEndsAt, contested } — precomputed because mock
  // rows bypass the live `active`/promoted_at gate computation in /promoted.
  const mk = (id, prNumber, title, hours, yes, no, chat, gate = {}) => ({
    id,
    pr_number: prNumber,
    pr_url: null,
    pr_title: title,
    pr_title_fallback: false,
    pr_summary_md: 'This is a sample plain-language summary so testers can see '
      + 'the new explanation that now appears at the top of a proposal — written '
      + 'in everyday words, with no technical jargon.',
    staging_url: null,
    testing_md: null,
    testing_path: null,
    user_id: 0,
    status: 'promoted',
    linked_issues: null,
    username: 'staging-tester',
    created_at: hoursAgo(hours),
    promoted_at: hoursAgo(hours),
    yes_count: yes,
    no_count: no,
    my_vote: null,
    kudos_count: 0,
    my_kudos: false,
    my_kudos_direct: false,
    revert_of_session_id: null,
    // #967: which external coding agent wrote it, for the "built with …"
    // chip. NULL on every native row — the connector-imported mock below is
    // the one that sets it.
    external_agent: null,
    original_pr_number: null,
    original_pr_title: null,
    chat_count: chat,
    last_message_at: chat ? hoursAgo(Math.max(0, hours - 1)) : null,
    visuals: null,
    resolving: false,
    // Dynamic merge-gate fields (span every regime across the mock set).
    votes_required: gate.required ?? Math.max(yes, 1),
    merge_window_ends_at: gate.windowEndsAt ?? null,
    contested: gate.contested ?? false,
    // Auto-takedown (rejection) fields.
    reject_window_ends_at: gate.rejectEndsAt ?? null,
    rejection_armed: gate.rejectionArmed ?? false,
    // #788: ordinary rows are not admins-changing; the three
    // explicit-approval mocks below override this to true.
    requires_explicit_approval: false,
    // #381: console-error check snapshot. Clean by default; the dedicated
    // error mock below overrides these so the warning badge + detail block
    // are reviewable on staging via ?demo=1.
    console_check_state: 'clean',
    console_errors: [],
    console_checked_at: hoursAgo(hours),
    // #47: "CI for proposals" check snapshot. Passing by default; the
    // dedicated failing/pending/error mocks below override these so every
    // checks-badge variant + the per-test detail are reviewable via ?demo=1.
    check_state: 'passing',
    test_results: [
      { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
    ],
    checks_checked_at: hoursAgo(hours),
    // Community-voted priority + assignee + category chips. Populated so
    // the card states are reviewable on staging via ?demo=1.
    priority: { top: 'high', count: 2, myValue: null },
    assignee: { top: 'staging-tester', count: 3, myValue: null },
    category: { top: 'improvement', count: 2, myValue: null },
  });
  const rows = [
    // Unopposed, thin support: threshold met but a multi-day visibility
    // window still running → "Merging in ~2d" countdown pill.
    mk(9000001, 900101,
      '[Mock] Long-title test: rework the proposal card header so the '
      + 'discussion badge and vote tally wrap gracefully on narrow phones',
      3, 2, 0, 4, { required: 2, windowEndsAt: hoursAhead(46) }),
    // Near-majority, no opposition: window almost elapsed → short
    // "Merging in Xh" countdown.
    mk(9000013, 900113,
      '[Mock] Near-majority test: tighten the proposal card spacing on tablet widths',
      20, 5, 0, 3, { required: 3, windowEndsAt: hoursAhead(5) }),
    // Majority reached: no window, would merge immediately in prod.
    // my_vote is set on this one mock (#482) so the kanban "Needs my vote"
    // filter visibly removes a card in the ?demo=1 preview instead of
    // matching every mock proposal.
    { ...mk(9000014, 900114,
      '[Mock] Majority test: bump the vote pill contrast for accessibility',
      6, 6, 0, 2, { required: 5, windowEndsAt: null }), my_vote: 'up' },
    // Lazy consensus: BELOW the eased threshold (1 of 2 yes) but unopposed —
    // the count-based lazy clock is running, so the pill shows the countdown
    // with the tally riding along ("Merging in ~2d · 1/2").
    mk(9000019, 900119,
      '[Mock] Lazy-consensus test: one supporter, nobody objecting — merges when the clock elapses',
      5, 1, 0, 1, { required: 2, windowEndsAt: hoursAhead(67) }),
    // Placeholder title: the LLM was unavailable when this PR was titled,
    // so it carries the fallback template and the "Auto-title pending"
    // chip (pr_title_fallback → _autoTitleChip) is reviewable via ?demo=1.
    {
      ...mk(9000020, 900120, "[Mock] staging-tester's changes",
        4, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(60) }),
      pr_title_fallback: true,
    },
    // One No vote: eased threshold restored, window pushed back out.
    mk(9000002, 900102,
      '[Mock] Long-title test: walk brand-new collaborators through '
      + 'voting, kudos and dev sessions step by step',
      11, 1, 1, 0, { required: 5, windowEndsAt: hoursAhead(120) }),
    // Contested (No >= 1/3): window no longer applies, pure full-majority
    // count gate — no countdown, "Contested" treatment.
    mk(9000015, 900115,
      '[Mock] Contested test: switch the default theme from light to dark',
      8, 4, 3, 5, { required: 6, windowEndsAt: null, contested: true }),
    // #239/#388: a row mid-auto-conflict-resolution so the "Resolving
    // conflicts…" badge is verifiable on staging via ?demo=1 without
    // manufacturing a real merge conflict. Aged to ~10h so that, without
    // the #388 merge-pipeline pin, recency alone would sink it down the
    // list — making the pin (which lifts it near the top) obvious.
    {
      ...mk(9000003, 900103,
        '[Mock] Resolving-state test: add a dark-mode toggle to the settings drawer',
        10, 2, 0, 2, { required: 2, windowEndsAt: hoursAhead(40) }),
      resolving: true,
    },
    // #388: a row in the GitHub merge pipeline ('merging') so the
    // "Merging…" badge — and the top-of-stack pin — are verifiable on
    // staging via ?demo=1. Deliberately the OLDEST mock (~13h) so without
    // the pin it would sort dead last; the pin must lift it to rank 0,
    // above every other proposal.
    {
      ...mk(9000006, 900106,
        '[Mock] Merging-state test: this PR is mid-merge and should pin to the very top',
        13, 4, 0, 5),
      status: 'merging',
    },
    // #388: a row whose automatic conflict resolution failed
    // (merge_conflict_state 'failed') so the "⚠ Conflict resolution
    // failed" badge, the expanded conflicting-file list, and the pin
    // (just below merging + resolving) are verifiable via ?demo=1. Aged
    // ~12h so recency alone wouldn't float it.
    {
      ...mk(9000007, 900107,
        '[Mock] Conflict-failed test: auto-resolve could not finish; owner must fix it',
        12, 3, 1, 2, { required: 5 }),
      merge_conflict_state: 'failed',
      behind_main: 2,
      conflict_files: ['src/app.js', 'public/index.html'],
      conflict_checked_at: hoursAgo(11),
    },
    // #124: a visibility-change proposal (a dapp.json PR opened by the
    // Members & visibility modal) so its self-describing card is
    // reviewable on staging via ?demo=1.
    mk(9000004, 900104,
      '[Mock] Make this app invite-only build, public to view',
      2, 1, 0, 1, { required: 2, windowEndsAt: hoursAhead(60) }),
    // #695: the issue's exact report — an invited-approver row where MORE
    // THAN ONE non-approver has voted and no approver has. The approver-only
    // headline pill ("0 of 1 approvals"), the "+2 advisory" chip, and the
    // "Yes (0✓ +2)" button labels are reviewable via ?demo=1 without
    // hand-seeding an approver roster. (Sibling of 9000023, which shows the
    // single-advisory-vote variant.)
    {
      ...mk(9000025, 900125,
        '[Mock] Approver-mode test: two supporters, but no invited approver has voted yet',
        2, 2, 0, 1, { required: 1 }),
      approval_policy: 'invited',
      approvals_required: 1,
      qualified_yes_count: 0,
      qualified_no_count: 0,
    },
    // Auto-takedown — slim No majority (No just edges ahead of Yes, under the
    // 1/3 keep-alive line): long rejection window → "Rejecting in ~6d".
    mk(9000016, 900116,
      '[Mock] Rejection test: replace the home feed with an infinite-scroll redesign',
      30, 2, 3, 6, { required: 6, rejectEndsAt: hoursAhead(140), rejectionArmed: true }),
    // Auto-takedown — lopsided opposition (No heavily outweighs Yes): short
    // rejection window → "Rejecting in ~Xh".
    mk(9000017, 900117,
      '[Mock] Rejection test: drop dark mode entirely to simplify the theme code',
      18, 1, 6, 4, { required: 6, rejectEndsAt: hoursAhead(7), rejectionArmed: true }),
    // Kept-alive despite No > Yes: Yes fraction >= 1/3 cancels the rejection
    // clock entirely (Contested, not rejected) → normal tally, no countdown.
    mk(9000018, 900118,
      '[Mock] Kept-alive test: add keyboard shortcuts even though some object',
      9, 7, 9, 5, { required: 11, contested: true, rejectionArmed: false }),
    // #788: explicit-approval rows. app_admins is a table this change
    // creates, so a staging clone has none, and no real proposal there
    // touches dapp.json's admins block — without these three the chip,
    // the suppressed countdown and the new help text are unreviewable in
    // any PR preview. All carry merge_window_ends_at: null (the no-timer
    // modifier zeroes the window), which is exactly what makes the
    // countdown disappear.
    //
    // (a) Below threshold. Normally 1 Yes / 0 No with a 3-vote threshold
    // arms lazy consensus and renders "merges in ~3d — silence counts as
    // agreement"; flagged, it renders NO countdown at all.
    {
      ...mk(9000030, 900130,
        '[Mock] Explicit-approval test: add @staging-demo-maintainer as an app admin',
        20, 1, 0, 2, { required: 3 }),
      requires_explicit_approval: true,
    },
    // (b) Threshold met. No visibility window to sit out — it goes
    // straight to "queued to merge shortly" the moment the third Yes
    // lands, instead of starting a multi-day countdown.
    {
      ...mk(9000031, 900131,
        '[Mock] Explicit-approval test: remove an app admin (threshold reached)',
        26, 3, 0, 4, { required: 3 }),
      requires_explicit_approval: true,
    },
    // (c) Rejection still applies. The auto-takedown countdown is
    // untouched by the modifier, so a flagged proposal the group is
    // voting down still shows "Rejecting in ~Xh" and still auto-closes.
    {
      ...mk(9000032, 900132,
        '[Mock] Explicit-approval test: admins change nobody wants (rejecting)',
        22, 0, 3, 3, { required: 3, rejectEndsAt: hoursAhead(9), rejectionArmed: true }),
      requires_explicit_approval: true,
    },
    // #381: a proposal whose staging preview logged console errors, so the
    // amber "⚠ Console errors" badge and the expanded error list in the
    // detail view are reviewable on staging via ?demo=1.
    {
      ...mk(9000005, 900105,
        '[Mock] Console-error test: refactor the feed renderer (logs errors on load)',
        4, 1, 0, 3, { required: 2 }),
      console_check_state: 'errors',
      console_errors: [
        { kind: 'pageerror', message: "TypeError: Cannot read properties of undefined (reading 'map')", source: 'app.js:142' },
        { kind: 'console', message: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)', source: '/api/feed:0' },
      ],
      // #47: same proposal fails its checks — the amber "⚠ Checks failing"
      // badge + the per-test detail (a console-error failure plus a
      // missing-selector failure) are reviewable via ?demo=1, and the gate
      // would block this merge.
      check_state: 'failing',
      // #447: `recheckable` makes the "Re-run checks" button render under
      // ?demo=1 regardless of the viewer's owner/admin status (real rows
      // never carry it). Set on every non-passing checks mock.
      recheckable: true,
      test_results: [
        { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
        {
          name: 'Feed renders', path: '/#/feed', status: 'fail',
          consoleErrors: [
            { kind: 'pageerror', message: "TypeError: Cannot read properties of undefined (reading 'map')", source: 'app.js:142' },
          ],
          failureReason: '1 console error on load',
        },
        {
          name: 'Composer is visible', path: '/#/feed', status: 'fail',
          consoleErrors: [],
          failureReason: 'Expected element ".composer" was not found',
        },
      ],
    },
    // #47: a proposal still running its checks — the grey "Checks running…"
    // spinner badge is reviewable via ?demo=1, and the gate would block the
    // merge until the run reports. #607: the run started ~2 minutes ago
    // (checks_checked_at override), so the detail shows the fresh state —
    // spinner + "Started 2 minutes ago" with NO re-run button (recheckable
    // is set, but the freshness gate hides the escape hatch).
    {
      ...mk(9000008, 900108,
        '[Mock] Checks-pending test: tests are still running on the staging build',
        5, 2, 0, 1),
      check_state: 'pending',
      recheckable: true,
      test_results: [],
      checks_checked_at: hoursAgo(0.03),
    },
    // The two STAGE captions a 'pending' run can render. A checks run has two
    // very differently-sized halves (build + DB clone, then the headless
    // suite) and both used to show one opaque "Checks are still running…", so
    // a mid-flight build was indistinguishable from a wedged one. These two
    // rows are the only way to review both captions in a preview — a real
    // staging clone has no in-flight run to look at. The fixture above keeps
    // check_phase absent on purpose: it is the NULL/legacy-wording case.
    {
      ...mk(9000022, 900122,
        '[Mock] Checks-phase test: preparing the staging preview (build + DB clone)',
        0.06, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(70) }),
      check_state: 'pending',
      check_phase: 'building',
      recheckable: true,
      test_results: [],
      checks_checked_at: hoursAgo(0.02),
    },
    {
      ...mk(9000023, 900123,
        '[Mock] Checks-phase test: running the automated tests against the preview',
        0.06, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(70) }),
      check_state: 'pending',
      check_phase: 'testing',
      recheckable: true,
      test_results: [],
      checks_checked_at: hoursAgo(0.02),
    },
    // #607: a freshly promoted proposal whose first checks run hasn't even
    // stamped 'pending' yet (staging build still going) — NO verdict, NO
    // console snapshot. The grey "Checks starting…" spinner badge + the
    // "Checks are starting…" detail block (with no re-run button, since the
    // row is minutes old) are reviewable via ?demo=1.
    {
      ...mk(9000021, 900121,
        '[Mock] Checks-starting test: just promoted, the first run has not begun yet',
        0.05, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(71) }),
      check_state: null,
      console_check_state: null,
      console_errors: [],
      console_checked_at: null,
      test_results: [],
      checks_checked_at: null,
    },
    // #447: a proposal STUCK in 'pending' — it crossed the vote threshold but
    // its checks have been "running" far longer than any real run takes
    // (checks_checked_at ~2h ago, well past CHECKS_STALE_MS). This is the
    // exact #447 failure: permanently blocked from merging with the old
    // "still running its tests" message. Verifies the stale-pending copy +
    // the "Re-run checks" button (and, on a live server, the boot/sweep
    // reconcile that would re-run it). yes_count is set above any plausible
    // staging majority so the row reads as past-threshold.
    {
      ...mk(9000011, 900111,
        '[Mock] Stuck-checks test: pending past the stale window',
        2, 9, 0, 1),
      check_state: 'pending',
      recheckable: true,
      test_results: [],
    },
    // #47: a proposal whose checks could not run (staging build / capture
    // broke) — the red "⚠ Checks couldn't run" badge is reviewable via
    // ?demo=1, and the gate blocks fail-closed.
    {
      ...mk(9000009, 900109,
        '[Mock] Checks-error test: the staging build or test run itself broke',
        6, 1, 0, 0, { required: 2 }),
      check_state: 'error',
      recheckable: true,
      test_results: [],
    },
    // #461: a proposal whose checks were explicitly SKIPPED (nothing to
    // test — e.g. the branch carries no commits beyond main). The grey
    // non-blocking "Checks skipped" badge + its reason tooltip are
    // reviewable via ?demo=1; the gate treats 'skipped' like 'passing', so
    // with yes_count past any plausible staging majority this row reads as
    // vote-complete and NOT checks-blocked.
    {
      ...mk(9000012, 900112,
        '[Mock] Checks-skipped test: nothing to test for this proposal',
        3, 9, 0, 1),
      check_state: 'skipped',
      check_error_detail: 'branch has no commits beyond main — nothing to test',
      recheckable: true,
      test_results: [],
    },
    // #405: a proposal that PASSED the vote with green checks and is not
    // behind — eligible and queued to merge. Verifies the new green
    // "Passed — merging shortly" badge on the feed card + home strip via
    // ?demo=1. yes_count is set well above any plausible staging majority so
    // the row reliably reads as past-threshold (the vote pill fills green).
    mk(9000010, 900110,
      '[Mock] Ready-to-merge test: votes passed and checks are green — queued to merge',
      4, 9, 0, 3),
    // #646: an "at least N approvals" proposal awaiting its approval —
    // approval_policy/approvals_required drive the clock-free
    // "x of N approvals" pill and the new How-voting-works copy. The raw
    // tally carries an advisory community vote (yes_count 1) while the
    // QUALIFYING count is still 0, so the advisory-vs-approver split is
    // reviewable via ?demo=1.
    {
      ...mk(9000023, 900123,
        '[Mock] Approvals test: needs 1 approval from an invited approver before it merges',
        3, 1, 0, 2, { required: 1, windowEndsAt: null }),
      approval_policy: 'invited',
      approvals_required: 1,
      qualified_yes_count: 0,
      qualified_no_count: 0,
    },
    // #646: the reached counterpart — the approval target is met, so the
    // pill fills green ("2 of 2 approvals") and the help text reads
    // "queued to merge shortly".
    {
      ...mk(9000024, 900124,
        '[Mock] Approvals test: target reached — 2 of 2 approvals, merging shortly',
        5, 3, 0, 1, { required: 2, windowEndsAt: null }),
      approval_policy: 'invited',
      approvals_required: 2,
      qualified_yes_count: 2,
      qualified_no_count: 0,
    },
    // #639: an issue-linked proposal that carries NO attribute votes of its
    // own, so its priority/assignee chips are INHERITED from the origin issue
    // (#900006, seeded medium / maya-builder in the issues feed). This makes
    // the "chips no longer vanish when a task is proposed for voting" fix
    // reviewable on the In-review card via ?demo=1. linked_issues points the
    // card at that mock issue; the inline priority/assignee stand in for what
    // the inheritance query computes (mock rows bypass the DB summarize path).
    {
      ...mk(9000022, 900122,
        '[Mock] Inherited-attrs test: promoted from issue #900006 — chips carry over',
        7, 2, 0, 1, { required: 2, windowEndsAt: hoursAhead(50) }),
      linked_issues: [900006],
      priority: { top: 'medium', count: 2, myValue: null },
      assignee: { top: 'maya-builder', count: 3, myValue: null },
    },
    // #866: the three states of the Preview slot on an IMPORTED proposal.
    //
    // These can't be seeded in the DB the way the imported-PR fixtures in
    // migrate.js are: `staging_building` is derived per request from the
    // in-memory build registry (staging.hasInFlightBuild — deliberately not a
    // persisted column), so a seeded row can only ever render the "no
    // preview" state. Mock rows carry the derived flags explicitly, which is
    // the only way to review all three pills in a staging preview.
    //
    // The fork label lives on the IMPORT PICKER, not the card (mock candidate
    // 9403 in services/github-mock.js is the fork-headed one) — a card has no
    // head-repo of its own to report.
    //
    // (a) Preview ready: the build landed, so the ordinary Preview button
    // renders. The URL is deliberately unroutable — clicking it opens the
    // loader and reports the host as unreachable, which is the point of a
    // mock; the button's presence is what's under review.
    {
      ...mk(9000041, 900141,
        '[Mock] Imported-preview test: preview built — the Preview button is live',
        3, 2, 0, 2, { required: 2, windowEndsAt: hoursAhead(44) }),
      source: 'imported',
      imported_pr_author: 'octo-contributor',
      staging_url: 'https://mock-preview--000000.staging.invalid',
      staging_building: false,
      staging_error: null,
    },
    // (b) Preview building: imported moments ago, the SHA-pinned build is
    // still running. Renders the non-interactive "Preview building…" spinner
    // pill plus the prose note in the detail view, with checks pending
    // because they run against the preview that doesn't exist yet.
    {
      ...mk(9000042, 900142,
        '[Mock] Imported-preview test: preview still building — spinner pill, no button',
        0.08, 0, 0, 0, { required: 2, windowEndsAt: hoursAhead(71) }),
      source: 'imported',
      imported_pr_author: 'octo-contributor',
      staging_url: null,
      staging_building: true,
      staging_error: null,
      check_state: 'pending',
      test_results: [],
      checks_checked_at: hoursAgo(0.05),
    },
    // (c) Preview unavailable: the build failed, so there is nothing to
    // preview and checks can't run. Renders the "Preview unavailable" chip
    // (reason in the tooltip), the amber prose note, and — for a viewer who
    // can act — the "Retry preview" button beside it. check_error_detail
    // carries the same reason the chip shows, exactly as a real error row
    // does (recordStagingBootFailure writes both).
    {
      ...mk(9000043, 900143,
        '[Mock] Imported-preview test: preview failed to build — unavailable chip + retry',
        2, 1, 0, 1, { required: 2 }),
      source: 'imported',
      imported_pr_author: 'octo-contributor',
      staging_url: null,
      staging_building: false,
      staging_error: 'app failed to boot in its staging container: missing required secret DEMO_API_KEY',
      check_state: 'error',
      check_error_detail: 'app failed to boot in its staging container: missing required secret DEMO_API_KEY',
      recheckable: true,
      test_results: [],
    },
    // A proposal submitted through the hosted MCP connector — Claude Code
    // wrote it in the user's own fork, and submit_work carried the testing
    // routes and steps with the import. THREE things only line up on one row:
    // the "built with Claude Code" chip beside the imported badge, a "How to
    // test" panel + "Test this change" deep link on an IMPORTED proposal, and
    // failing checks on work the platform did not build itself.
    //
    // Seeded because a staging clone cannot have one: every imported row in
    // production carries testing_md / testing_path NULL, since until this
    // change nothing on the import path could set them.
    {
      ...mk(9000044, 900144,
        '[Mock] Connector test: imported from Claude Code with testing notes, checks failing',
        7, 2, 0, 2, { required: 3, windowEndsAt: hoursAhead(30) }),
      source: 'imported',
      imported_pr_author: 'staging-tester',
      external_agent: 'claude-code',
      testing_md: '1. Open the board — the new "Snap to grid" toggle sits above the columns.\n'
        + '2. Turn it on and drag a card: it should snap to the nearest column.\n'
        + '3. Reload the page — the toggle keeps its setting.',
      testing_path: '/board?demo-pr=1',
      check_state: 'failing',
      recheckable: true,
      test_results: [
        { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
        {
          name: 'Board shows the snap toggle', path: '/board?demo-pr=1', status: 'fail',
          consoleErrors: [],
          failureReason: 'Expected element ".snap-toggle" was not found',
        },
      ],
    },
    // ── Card-as-pointer revision fixtures ──
    // The composite status pill names ONE reason and its tooltip counts the
    // rest; the detail view enumerates every one. That behaviour needs a row
    // with several reasons at once, which no existing mock has.
    {
      ...mk(9000050, 900150,
        '[Mock] Multi-reason test: behind main AND checks failing AND console errors',
        7, 2, 0, 4, { required: 3 }),
      behind_main: 3,
      console_check_state: 'errors',
      console_errors: [
        { kind: 'pageerror', message: "TypeError: Cannot read properties of null (reading 'id')", source: 'board.js:88' },
        { kind: 'console', message: 'Failed to load resource: 502 (Bad Gateway)', source: '/api/board:0' },
      ],
      check_state: 'failing',
      recheckable: true,
      test_results: [
        { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
        { name: 'Board renders', path: '/#/board', status: 'fail', consoleErrors: [], failureReason: 'expected selector .board not found' },
        { name: 'Settings opens', path: '/#/settings', status: 'fail', consoleErrors: [], failureReason: 'navigation timed out' },
      ],
    },
    // Unset metadata: EVERY other mock carries priority + assignee +
    // category (the mk factory stamps all three), so without this row the
    // "no grey Set-priority / Set-category / Unassigned placeholders" rule
    // is invisible in a preview. The nulls are applied after mk() below.
    mk(9000051, 900151,
      '[Mock] Bare-card test: no priority, no category, nobody assigned',
      9, 1, 0, 0, { required: 2 }),
    // Provenance overload: four facts that used to be four badges competing
    // for the four badge slots, now all on the meta line. Proves the badge
    // cap holds and the provenance still reads.
    {
      ...mk(9000052, 900152, "[Mock] staging-tester's changes",
        6, 2, 0, 2, { required: 3, windowEndsAt: hoursAhead(30) }),
      source: 'imported',
      imported_pr_author: 'octo-contributor',
      external_agent: 'codex',
      pr_title_fallback: true,
      staging_url: 'https://mock-preview.invalid',
    },
  ];
  // Spread the community-voted priority/assignee across a few rows (the mk
  // factory otherwise stamps every proposal high / staging-tester) so the
  // kanban board's Priority and Assignee filters have >1 distinct value to
  // choose from and filtering visibly narrows the board. The assignees mirror
  // the mock issues' (staging-demo-user, maya-builder), so filtering by one of
  // them catches cards across both the issue and proposal columns.
  const attrOverrides = new Map([
    [9000001, { priority: { top: 'medium', count: 2, myValue: null }, assignee: { top: 'staging-demo-user', count: 2, myValue: null }, category: { top: 'improvement', count: 2, myValue: null } }],
    [9000002, { priority: { top: 'low', count: 1, myValue: null }, assignee: { top: 'maya-builder', count: 1, myValue: null }, category: { top: 'design', count: 1, myValue: null } }],
    // #780: a CUSTOM category on a PROPOSAL card too (matching the second
    // demo entry listCategories() appends in staging), so the custom chip is
    // reviewable across both card types and the filter catches both columns.
    [9000013, { priority: { top: 'low', count: 3, myValue: null }, assignee: { top: 'staging-demo-user', count: 1, myValue: null }, category: { top: 'staging demo onboarding', count: 2, myValue: null } }],
  ]);
  for (const row of rows) {
    const o = attrOverrides.get(row.id);
    if (o) { row.priority = o.priority; row.assignee = o.assignee; row.category = o.category; }
  }
  // The deliberately BARE card: mk() stamps all three attributes, so the
  // "unset chips don't render" rule needs one row to opt back out. Kept as
  // an explicit clear rather than a separate factory so a future field added
  // to mk() is visibly missing here too.
  for (const row of rows) {
    if (row.id === 9000051) {
      row.priority = null;
      row.category = null;
      row.assignee = null;
    }
  }
  return rows.map((p) => {
    // #600: seed the FIRST mock proposal's assignee as the viewer's own so
    // opening its dropdown shows the "already voted" state (name box empty,
    // viewer's pick checked). Everyone else stays assigned to staging-tester
    // with myValue null, so their dropdown pre-fills the viewer's username.
    if (viewer && p.id === 9000001) {
      return { ...p, assignee: { top: viewer, count: 2, myValue: viewer } };
    }
    return p;
  });
}

// #194: staging demo rows for the Completed (merged) list, mirroring
// stagingMockProposals. Lets ?demo=1 verify the new clickable Completed
// rows, the chevron/hover affordance, and the 💬 badge against a
// prod-cloned DB. Caveat: these mock rows have NO backing chat_messages,
// so opening one shows an empty (but still postable) thread — useful for
// the card affordance + badge, not for existing-comment display.
function stagingMockMerged() {
  const daysAgo = (d) => new Date(Date.now() - d * 86400 * 1000).toISOString();
  const mk = (id, prNumber, title, days, chat) => ({
    id,
    pr_number: prNumber,
    pr_url: null,
    pr_title: title,
    pr_summary_md: 'This is a sample plain-language summary so testers can see '
      + 'the new explanation at the top of a completed proposal — in everyday '
      + 'words, with no technical jargon.',
    user_id: 0,
    status: 'merged',
    linked_issues: null,
    username: 'staging-tester',
    created_at: daysAgo(days),
    revert_of_session_id: null,
    votes_required: 2,
    active_users_at_merge: 3,
    yes_count: 2,
    no_count: 0,
    my_vote: null,
    kudos_count: 0,
    my_kudos: false,
    my_kudos_direct: false,
    chat_count: chat,
    revert_session_id: null,
    revert_pr_number: null,
    revert_pr_url: null,
    revert_status: null,
    // #381: merged mocks are clean by default (the warning is reviewable on
    // the promoted list); these keep the detail view from reading undefined.
    console_check_state: 'clean',
    console_errors: [],
    console_checked_at: daysAgo(days),
    // #47: a merged proposal passed its checks by definition of the gate.
    check_state: 'passing',
    test_results: [
      { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
    ],
    checks_checked_at: daysAgo(days),
    // Read-only priority + assignee chips persist on completed proposals.
    priority: { top: 'medium', count: 2, myValue: null },
    assignee: { top: 'staging-tester', count: 2, myValue: null },
  });
  // #429: 26 mock rows (> one 20-row page) so the "Load more" pager and
  // the hasMore flag are exercisable in a ?demo=1 staging preview. Each
  // has a distinct created_at (1..26 days ago) so keyset paging orders
  // them deterministically, newest first.
  const titles = [
    'tighten the empty-state copy on the dev forum',
    'bump the chat composer hit area on mobile',
    'fix the dark-mode contrast on vote pills',
    'debounce the proposal search box',
    'add keyboard focus rings to the kebab menu',
    'shorten the merged-PR relative timestamps',
    'collapse long PR summaries behind a toggle',
    'align the kudos count with the avatar row',
    'cache the leaderboard avatars for a session',
    'wrap long usernames in the activity feed',
    'add a copy-link button to merged proposals',
    'fix the sticky header on the issues tab',
    'lazy-load the kanban Done column images',
    'trim trailing whitespace in PR titles',
    'add an empty-state for the Completed list',
    'fix the scroll jump when expanding a thread',
    'show the merge date in the card tooltip',
    'group governance proposals under one header',
    'dim already-voted proposals in the list',
    'add a subtle divider between feed sections',
    'fix the wrap on long linked-issue chips',
    'preload the vote roster on hover',
    'add a “back to top” affordance on long lists',
    'fix the badge alignment on RTL locales',
    'shorten the undo-confirmation copy',
    'add a hover state to the Load more button',
  ];
  // #451: the merged-list counterpart to the #405 "Ready-to-merge" promoted
  // mock — the same shape of proposal (votes passed, checks green) AFTER it
  // auto-merged on its own. Lets a ?demo=1 preview show the before/after of
  // the In-review → Completed transition the auto-merge trigger produces,
  // without staging ever performing a real GitHub merge. Newest row (0 days)
  // so it sorts to the top of the Completed list next to the live demo.
  const autoMerged = mk(
    9100000,
    910100,
    '[Mock] Auto-merged: votes passed and checks turned green — merged automatically (#451)',
    0,
    3
  );
  // #639: a COMPLETED proposal whose chips were inherited from its origin
  // issue (#900006, seeded medium / maya-builder). Confirms priority/assignee
  // stay visible (read-only) in the Done column after "close done", not just
  // while in review — the second half of the reported loss. linked_issues +
  // inline chip values mirror the promoted inherited-attrs mock above.
  const inheritedAttrs = {
    ...mk(9100027, 910127,
      '[Mock] Completed: inherited priority/assignee from issue #900006', 0, 2),
    linked_issues: [900006],
    priority: { top: 'medium', count: 2, myValue: null },
    assignee: { top: 'maya-builder', count: 3, myValue: null },
  };
  // Card-as-pointer revision: a merged proposal that ALREADY has a revert
  // in flight. Its "Undone by PR#…" relationship is a FACT about the change,
  // so it reads on the meta line rather than displacing the Undo action —
  // and Undo itself is correctly absent from the ⋯ menu (undoing an undo
  // would be an infinite loop).
  const undone = {
    ...mk(9100028, 910128,
      '[Mock] Completed: this one was undone — revert already merged', 0, 1),
    revert_session_id: 9100029,
    revert_pr_number: 910129,
    revert_pr_url: null,
    revert_status: 'merged',
  };
  return [autoMerged, inheritedAttrs, undone].concat(titles.map((t, i) => mk(
    9100001 + i,
    910101 + i,
    `[Mock] Completed: ${t}`,
    i + 1,
    // Sprinkle a few discussion counts so the 💬 badge is visible.
    i % 3 === 0 ? 5 : 0
  )));
}

// Staging demo rows for APPLIED close-issue proposals in the Completed
// stream (row_type='close_issue'), so a ?demo=1 preview shows the new
// "Issue close" card interleaved among the merged mocks. One group-vote
// apply and one admin force-apply, exercising both "closed by vote" and
// "closed by admin" meta lines. Ids live outside the merged-mock range so
// the type-scoped de-dup never collides. The payload mirrors what
// maybeApplyCloseIssueProposal stamps (appliedAt/appliedBy + tally
// snapshot); the target is mock issue 900003 from stagingMockIssues.
function stagingMockCompletedCloseIssues() {
  const daysAgo = (d) => new Date(Date.now() - d * 86400 * 1000).toISOString();
  const mk = (id, appliedBy, appliedDays, createdDays, chat) => ({
    row_type: 'close_issue',
    id,
    kind: 'close_issue',
    status: 'closed',
    title: '[Mock] Close issue #900003: "Topic cards overflow on narrow phones"',
    description: '[Mock] Fixed by the responsive rework — the buttons wrap now.',
    payload: {
      issueNumber: 900003,
      issueTitle: '[Mock] Topic cards overflow on narrow phones',
      reason: '[Mock] Fixed by the responsive rework — the buttons wrap now.',
      appliedAt: daysAgo(appliedDays),
      appliedBy,
      upCount: 2,
      required: 2,
      active: 3,
    },
    github_issue_number: null,
    created_by: 0,
    created_by_username: 'staging-tester',
    created_at: daysAgo(createdDays),
    up_count: 2,
    down_count: 0,
    chat_count: chat,
    last_message_at: null,
  });
  return [
    mk(9100060, 'group-vote', 1, 2, 3),
    mk(9100061, 'admin:staging-admin', 4, 5, 0),
  ];
}

// Global ordering for the unified Completed stream: newest created_at
// first; on a timestamp tie PR rows rank before close-issue rows (rank
// pr=1 > close_issue=0 — the same constant ranks the SQL keyset
// predicates encode), then id DESC. Deterministic even across the two
// id sequences (chat_sessions vs issues), which can collide numerically.
const COMPLETED_TYPE_RANK = { pr: 1, close_issue: 0 };
function completedRowCompare(a, b) {
  const ta = Date.parse(a.created_at) || 0;
  const tb = Date.parse(b.created_at) || 0;
  if (tb !== ta) return tb - ta;
  const ra = COMPLETED_TYPE_RANK[a.row_type || 'pr'] ?? 1;
  const rb = COMPLETED_TYPE_RANK[b.row_type || 'pr'] ?? 1;
  if (rb !== ra) return rb - ra;
  return b.id - a.id;
}

// Native proposals used to trust a mutable branch name all the way through
// voting and merge. A branch can move independently of the platform's review
// state, so every approval must be tied to an immutable PR head just like
// imported proposals already are.
//
// Imported proposals deliberately keep imported_pr_head_sha as their source of
// truth; this helper is native-only so their established sync behaviour stays
// unchanged.
function nativeGithubTarget(session) {
  if (!session || session.source === 'imported' || !session.pr_number) return null;
  const [, owner, repo] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo: repo.replace(/\.git$/, '') } : null;
}

async function kickNativeRevisionChecks({ config, pool, session, headSha }) {
  const visuals = require('../services/visuals');
  await visuals.setChecksPending(pool, session.id, headSha, 'building')
    .catch((err) => log.warn('votes', 'Native revision setChecksPending failed (non-fatal)', {
      sessionId: session.id, headSha, err: err.message,
    }));
  try { visuals.notifyChecksPending(session.id, headSha, 'building'); } catch (_) {}

  const prImportSync = require('../services/pr-import-sync');
  prImportSync.rerunChecksForNewHead({
    config,
    pool,
    session,
    newHead: headSha,
  }).catch((err) => log.warn('votes', 'Native revision checks re-run failed', {
    sessionId: session.id, headSha, err: err.message,
  }));
}

// #955: how far back the classifier will follow first parents looking for the
// reviewed revision. Stacked platform syncs are the reason it is more than one
// (a drain can resolve, fail to merge, and resolve again before anything
// reconciles); a small cap keeps a pathological history from costing GitHub
// reads. Anything deeper is treated as an author push — the safe direction.
const MAX_PLATFORM_CHAIN_HOPS = 5;

// True while the platform itself is moving this branch — either a MODE=sync
// worker turn or a conflict-resolver drain. Process-local, same
// single-Node-process assumption the two registries already make.
function platformSyncInFlight(sessionId) {
  try {
    const { getSyncState } = require('../services/sync-main');
    if (getSyncState(sessionId)) return true;
  } catch (_) { /* treat an unavailable registry as "not syncing" */ }
  try {
    if (isResolving(sessionId)) return true;
  } catch (_) { /* same */ }
  return false;
}

// Walk first parents from the live head back towards the reviewed revision,
// requiring EVERY commit on the way to be one the platform recorded pushing
// for this session. Recorded provenance — not the commit's shape — is what
// makes this safe: an author can trivially craft a "merge main" commit whose
// first parent is the reviewed SHA, so trusting shape alone would turn vote
// preservation into a governance bypass.
async function platformPushChain({ session, pool, liveHead, reviewedHead }) {
  const chain = [];
  if (!liveHead) return { platform: false, chain };
  const syncMain = require('../services/sync-main');
  const target = nativeGithubTarget(session);
  let cursor = liveHead;

  for (let hop = 0; hop < MAX_PLATFORM_CHAIN_HOPS; hop++) {
    const record = await syncMain.findPlatformPush(pool, session.id, cursor);
    if (!record) return { platform: false, chain };
    chain.push(record);

    // A row with no pinned revision has no bound votes to protect; a recorded
    // platform push is provenance enough to bind it (see sync-main).
    if (!reviewedHead) return { platform: true, chain };

    let parent = normalizedSha(record.first_parent_sha);
    if (!parent && target && github.isEnabled()) {
      // The parents read can fail at push time; fill it in now so later passes
      // stay a pure DB walk.
      try {
        const parents = await github.getCommitParents(target.owner, target.repo, cursor);
        parent = normalizedSha(parents[0]);
        if (parent) {
          await syncMain.backfillPlatformPushParent(pool, session.id, cursor, parent);
        }
      } catch (err) {
        log.warn('votes', 'Could not read platform-push parents', {
          sessionId: session.id, sha: cursor, err: err.message,
        });
      }
    }
    if (!parent) return { platform: false, chain };
    if (parent === reviewedHead) return { platform: true, chain };
    cursor = parent;
  }
  return { platform: false, chain };
}

// #955: decide WHO moved a native proposal's head before deciding what that
// costs its votes.
//   same            — the pin already describes this commit (case-insensitive).
//   platform_advance— our own sync/conflict-resolution commit, sitting on top
//                     of the reviewed revision: carry the votes across.
//   pending_sync    — the platform is mid-sync and this commit isn't recorded
//                     yet; don't decide at all, ask the caller to retry.
//   author_push     — anything else: the reviewed code changed, clear the tally.
async function classifyNativeHeadMove({ pool, session, liveHead }) {
  const live = normalizedSha(liveHead);
  const reviewed = normalizedSha(session.reviewed_head_sha);
  if (live && reviewed && live === reviewed) return { kind: 'same' };

  const { platform, chain } = await platformPushChain({
    session, pool, liveHead: live, reviewedHead: reviewed,
  });
  if (platform) {
    return {
      kind: 'platform_advance',
      chain,
      // Pure git merges carry their verdict; a Claude-resolved tree does not.
      resolvedTree: chain.some((c) => c.sync_result === 'resolved'),
    };
  }
  if (platformSyncInFlight(session.id)) return { kind: 'pending_sync' };
  return { kind: 'author_push' };
}

// Refresh a native proposal's reviewed revision from the live GitHub PR.
// `fresh=false` avoids an unnecessary API read when a caller only needs to
// initialize a legacy row; vote-time callers pass true because the PR may have
// moved since the previous vote.
//
// On a changed revision this function fail-closes first (revision-stamps the
// row, removes only votes for other revisions, and marks checks pending), then
// kicks an exact-SHA staging/check rebuild in the background. The conditional
// UPDATE makes concurrent voters idempotent: only one caller owns the reset,
// while `head_sha IS DISTINCT FROM` preserves any vote already cast on the new
// revision.
//
// #955: that reset is for AUTHOR pushes. The platform's own "sync with main"
// commit changes the branch without changing the patch under review, so it
// advances the pin and carries the votes with it instead.
async function reconcileNativeReviewedHead({ config, pool, session, fresh = false, notify = true }) {
  if (!session || session.source === 'imported') {
    return { enforced: false, headSha: reviewedHeadForSession(session) };
  }
  if (!github.isEnabled()) {
    // Local/mock installations without GitHub keep their existing PR-less
    // behaviour. There is no external mutable branch to protect in that mode.
    return { enforced: false, headSha: session.reviewed_head_sha || null };
  }
  if (!session.repo_url) {
    // PR-less local sessions have no mutable remote head to authorize. A row
    // that claims a GitHub PR but has lost its repository identity must fail
    // closed instead of silently bypassing revision verification.
    if (!session.pr_number) {
      return { enforced: false, headSha: session.reviewed_head_sha || null };
    }
    return {
      enforced: true,
      blocked: true,
      reason: 'This proposal has no GitHub repository to verify.',
    };
  }

  const target = nativeGithubTarget(session);
  if (!target) {
    return {
      enforced: true,
      blocked: true,
      reason: 'This proposal has no valid GitHub pull request to verify.',
    };
  }
  if (!fresh && session.reviewed_head_sha) {
    return { enforced: true, headSha: session.reviewed_head_sha, unchanged: true };
  }

  let pr;
  try {
    pr = await github.getPR(target.owner, target.repo, session.pr_number);
  } catch (err) {
    log.warn('votes', 'Could not verify native proposal head', {
      sessionId: session.id, pr: session.pr_number, err: err.message,
    });
    return {
      enforced: true,
      blocked: true,
      transient: true,
      reason: 'GitHub could not verify the pull request revision. Try again shortly.',
    };
  }

  if (pr?.merged) {
    return {
      enforced: true,
      blocked: true,
      reason: `PR #${session.pr_number} was already merged on GitHub.`,
    };
  }
  if (pr?.state && pr.state !== 'open') {
    return {
      enforced: true,
      blocked: true,
      reason: `PR #${session.pr_number} is not open on GitHub.`,
    };
  }
  const liveHead = pr?.head?.sha || null;
  if (!liveHead || !/^[0-9a-f]{40}$/i.test(liveHead)) {
    return {
      enforced: true,
      blocked: true,
      reason: 'GitHub did not return a valid pull-request head commit.',
    };
  }
  if (sameSha(liveHead, session.reviewed_head_sha)) {
    // Same commit — including a stamp that differs only in letter case. Nothing
    // about the reviewed code changed, so nothing may be cleared.
    return { enforced: true, headSha: liveHead, unchanged: true };
  }

  const oldHead = session.reviewed_head_sha || null;
  const move = await classifyNativeHeadMove({ pool, session, liveHead });

  if (move.kind === 'pending_sync') {
    // The platform is mid-sync and this commit isn't recorded yet: it is either
    // our own push a moment before it lands in the ledger, or a genuine author
    // push. Deciding now could destroy an approval that must survive, so defer
    // — nothing is written, and the next attempt classifies it correctly.
    log.info('votes', 'Head move deferred: platform sync in flight', {
      sessionId: session.id, oldHead, liveHead,
    });
    return {
      enforced: true,
      blocked: true,
      transient: true,
      reason: 'This proposal is being synced with main — try again in a moment.',
    };
  }

  const platformAdvance = move.kind === 'platform_advance';
  // Install the new head and reconcile the approvals in ONE statement. If that
  // half fails, PostgreSQL rolls the head update back too, so a later retry
  // cannot mistake a partially-reconciled row for a clean one.
  //
  // Author push  → delete every approval cast against another revision.
  // Platform sync→ carry the approvals for the previous revision onto the new
  //                one; approvals for any OTHER revision are still stale.
  const { rows: claimed } = await pool.query(
    platformAdvance
      ? `WITH claimed AS (
           UPDATE chat_sessions
              SET reviewed_head_sha = $1, stale_notified_at = NULL
            WHERE id = $2
              AND reviewed_head_sha IS NOT DISTINCT FROM $3::varchar
              AND reviewed_head_sha IS DISTINCT FROM $1
            RETURNING reviewed_head_sha
         ), moved AS (
           UPDATE pr_votes SET head_sha = $1
            WHERE session_id = $2
              AND head_sha IS NOT DISTINCT FROM $3::varchar
              AND EXISTS (SELECT 1 FROM claimed)
            RETURNING 1
         ), deleted AS (
           DELETE FROM pr_votes
            WHERE session_id = $2
              AND head_sha IS DISTINCT FROM $1
              -- disjoint from the moved set on purpose: two data-modifying
              -- CTEs touching one row in a statement is undefined behaviour.
              AND head_sha IS DISTINCT FROM $3::varchar
              AND EXISTS (SELECT 1 FROM claimed)
            RETURNING 1
         )
         SELECT reviewed_head_sha,
                (SELECT COUNT(*)::int FROM moved) AS votes_moved,
                (SELECT COUNT(*)::int FROM deleted) AS votes_deleted
           FROM claimed`
      : `WITH claimed AS (
           UPDATE chat_sessions
              SET reviewed_head_sha = $1, stale_notified_at = NULL
            WHERE id = $2
              AND reviewed_head_sha IS NOT DISTINCT FROM $3::varchar
              AND reviewed_head_sha IS DISTINCT FROM $1
            RETURNING reviewed_head_sha
         ), deleted AS (
           DELETE FROM pr_votes
            WHERE session_id = $2
              AND head_sha IS DISTINCT FROM $1
              AND EXISTS (SELECT 1 FROM claimed)
            RETURNING 1
         )
         SELECT reviewed_head_sha,
                0 AS votes_moved,
                (SELECT COUNT(*)::int FROM deleted) AS votes_deleted
           FROM claimed`,
    [liveHead, session.id, oldHead]
  );

  // Another concurrent verifier may have installed this same revision first.
  // Re-read instead of performing a second vote/check reset. A different value
  // means the PR moved again during our fetch; fail closed and let the caller
  // retry against a fresh snapshot.
  if (!claimed.length) {
    const { rows } = await pool.query(
      `SELECT reviewed_head_sha FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    const storedHead = rows[0]?.reviewed_head_sha || null;
    session.reviewed_head_sha = storedHead;
    if (sameSha(storedHead, liveHead)) {
      return { enforced: true, headSha: liveHead, unchanged: true };
    }
    return {
      enforced: true,
      blocked: true,
      transient: true,
      reason: 'The pull request changed while its revision was being verified. Try again.',
    };
  }

  session.reviewed_head_sha = liveHead;
  const votesDeleted = parseInt(claimed[0]?.votes_deleted, 10) || 0;
  const votesMoved = parseInt(claimed[0]?.votes_moved, 10) || 0;

  // A platform-authored push may already have run checks for this exact head.
  // Preserve that verdict; otherwise invalidate the old result synchronously
  // before launching the exact-SHA rebuild. A pure `clean` platform merge keeps
  // its verdict too (git merged tested main into a tested branch), but a tree
  // Claude edited to resolve conflicts is unverified and must be re-checked.
  const checksCarry = platformAdvance && !move.resolvedTree;
  const needsChecks = !sameSha(session.checks_commit_sha, liveHead) && !checksCarry;
  if (needsChecks) {
    await kickNativeRevisionChecks({ config, pool, session, headSha: liveHead });
  } else if (checksCarry && !sameSha(session.checks_commit_sha, liveHead)) {
    await pool.query(
      `UPDATE chat_sessions SET checks_commit_sha = $1 WHERE id = $2`,
      [liveHead, session.id]
    ).catch((err) => log.warn('votes', 'Carrying checks stamp failed (non-fatal)', {
      sessionId: session.id, headSha: liveHead, err: err.message,
    }));
    session.checks_commit_sha = liveHead;
  }

  if (notify) {
    try {
      const { pushVoteUpdate } = require('../services/ws');
      pushVoteUpdate({
        sessionId: session.id,
        appSlug: session.app_slug || null,
        merged: false,
        headMoved: oldHead != null,
        ...(platformAdvance ? { votesKept: true } : {}),
      });
    } catch (_) { /* ws failures are non-fatal */ }
  }

  if (notify && platformAdvance && votesMoved > 0) {
    // Our own commit, not the author's: say what actually happened instead of
    // asking everyone to re-review code they already approved.
    const label = session.pr_title
      ? `PR #${session.pr_number} — ${session.pr_title}`
      : `PR #${session.pr_number}`;
    const how = move.resolvedTree
      ? 'was synced with main and its merge conflicts were resolved automatically'
      : 'was synced with main';
    const checksNote = move.resolvedTree
      ? ' Its checks are re-running against the new commit and it will merge on its own once they pass.'
      : '';
    await sendSystemMessage(
      pool, session.app_id,
      `${label} ${how} — existing votes were kept (now pinned to commit ${liveHead.slice(0, 8)}).${checksNote}`,
      'system',
      { headChanged: true, votesKept: true, prNumber: session.pr_number, headSha: liveHead },
      { type: 'session', ref: session.id }
    ).catch(() => {});
  } else if (notify && !platformAdvance && (oldHead || votesDeleted > 0)) {
    const label = session.pr_title
      ? `PR #${session.pr_number} — ${session.pr_title}`
      : `PR #${session.pr_number}`;
    const message = oldHead
      ? `${label} was updated on GitHub — earlier votes were cleared, please re-review commit ${liveHead.slice(0, 8)}.`
      : `${label} is now pinned to commit ${liveHead.slice(0, 8)} — earlier unbound votes were cleared, please re-review.`;
    await sendSystemMessage(
      pool, session.app_id, message, 'system',
      { headChanged: !!oldHead, prNumber: session.pr_number, headSha: liveHead },
      { type: 'session', ref: session.id }
    ).catch(() => {});
  }

  log.info('votes', 'Native proposal revision reconciled', {
    sessionId: session.id,
    oldHead,
    newHead: liveHead,
    moveKind: move.kind,
    votesDropped: votesDeleted,
    votesCarried: votesMoved,
    checksReset: needsChecks,
  });
  return {
    enforced: true,
    headSha: liveHead,
    updated: true,
    initialized: oldHead == null,
    changed: oldHead != null,
    votesDropped: votesDeleted,
    votesCarried: votesMoved,
    platformAdvance,
    votesKept: platformAdvance,
  };
}

const SHA40_RE = /^[0-9a-f]{40}$/i;

function normalizedSha(value) {
  return typeof value === 'string' && SHA40_RE.test(value) ? value.toLowerCase() : null;
}

function voteMatchesReviewedRevision(expectedHeadSha, revision) {
  if (!revision?.enforced) return true;
  const expected = normalizedSha(expectedHeadSha);
  const current = normalizedSha(revision.headSha);
  return !!expected && expected === current;
}

// Optional testing metadata on a PR import. Returns the three column values
// the imported session row is created with — all null when the request body
// carries nothing, which is the browser import button's case and leaves that
// path byte-identical to before.
//
// Every rule here is BORROWED, not restated: services/testing-notes.js owns
// what a valid capture route is (validatePath), how many are shot
// (CAPTURE_MAX_PATHS), how the viewport labels are spelled, and how long the
// markdown may be (TESTING_MD_MAX). A second opinion about any of those is a
// bug waiting to happen — the same routes then behave differently depending
// on whether a build turn or a connector submitted them.
function parseImportTesting(body) {
  const none = { testingMd: null, testingPath: null, testingPaths: null };
  if (!body || typeof body !== 'object') return none;
  const notes = require('../services/testing-notes');

  const paths = [];
  const seen = new Set();
  if (Array.isArray(body.testingPaths)) {
    for (const entry of body.testingPaths) {
      const normalized = notes.normalizeStoredPath(entry);
      if (!normalized) continue;
      // normalizeStoredPath deliberately does not re-validate (stored rows
      // were validated at write time); this input never was, so it is.
      const valid = notes.validatePath(normalized.path);
      if (!valid) continue;
      const key = `${normalized.viewport} ${valid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (paths.length < notes.CAPTURE_MAX_PATHS) {
        paths.push({ path: valid, viewport: normalized.viewport });
      }
    }
  }

  let md = typeof body.testingSteps === 'string' ? body.testingSteps.trim() : '';
  if (md.length > notes.TESTING_MD_MAX) md = md.slice(0, notes.TESTING_MD_MAX);

  if (!paths.length && !md) return none;
  return {
    testingMd: md || null,
    // The PRIMARY path, same convention as the block parser: the first entry.
    testingPath: paths.length ? paths[0].path : null,
    testingPaths: paths.length ? paths : null,
  };
}

function revisionChangedVoteResponse(res, headSha, message = null) {
  return res.status(409).json({
    error: message
      || 'This proposal changed since it was shown. Refresh it, review the new revision, then vote again.',
    headChanged: true,
    refreshRequired: true,
    reviewedHeadSha: headSha || null,
  });
}

// Record a native vote only while chat_sessions still points at the revision
// the browser reviewed. SELECT ... FOR UPDATE and the INSERT share one SQL
// statement, so a concurrent head reconciliation either happens before the
// predicate is checked (zero rows) or after the vote is safely written (and
// then removes it as stale). Imported/local rows keep their existing write.
async function recordVote({ pool, session, userId, vote, headSha, revisionEnforced }) {
  if (!revisionEnforced) {
    return pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, head_sha) VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, head_sha = EXCLUDED.head_sha, created_at = NOW()
       RETURNING id`,
      [session.id, userId, vote, headSha]
    );
  }

  return pool.query(
    `WITH current_session AS (
       SELECT id
         FROM chat_sessions
        WHERE id = $1
          AND status IN ('promoted', 'merging')
          AND reviewed_head_sha = $4::varchar
        FOR UPDATE
     )
     INSERT INTO pr_votes (session_id, user_id, vote, head_sha)
     SELECT id, $2, $3, $4 FROM current_session
     ON CONFLICT (session_id, user_id) DO UPDATE
       SET vote = EXCLUDED.vote, head_sha = EXCLUDED.head_sha, created_at = NOW()
     RETURNING id`,
    [session.id, userId, vote, headSha]
  );
}

// The background merge/rejection sweep has no user vote event to refresh a
// native PR first. Give it one shared, testable preparation step: imported PRs
// keep their existing synchronized head, while native PRs are always checked
// live before a governance gate is allowed to count votes.
async function reconcilePromotedSweepHead({ config, pool, session }) {
  if (session?.source === 'imported') {
    return {
      enforced: true,
      imported: true,
      headSha: session.imported_pr_head_sha || null,
    };
  }
  const revision = await reconcileNativeReviewedHead({
    config,
    pool,
    session,
    fresh: true,
  });
  return {
    ...revision,
    headSha: revision.blocked ? null : reviewedHeadForSession(session),
  };
}

// Shared SELECT column list + FROM/JOIN block for a "merged-shaped"
// proposal row. Used by BOTH `GET /api/apps/:slug/merged` (the paginated
// Completed list) and `GET /api/apps/:slug/proposals/:id` (single-row
// fetch-on-demand recovery — see app-view.js _fetchProposalById). Kept as
// ONE fragment so the two endpoints can never drift in row shape: the FE
// card renderer (_renderMergedCard / _renderTopicHead) depends on every
// field below being present. Placeholders: $1 = app_id, $2 = the viewer's
// user id (for the per-viewer my_vote / my_kudos subqueries). Callers
// append their own WHERE / ORDER / LIMIT.
function mergedRowSelect() {
  return `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.pr_summary_md, cs.user_id, cs.status, cs.linked_issues, u.username, cs.created_at,
           cs.revert_of_session_id,
           -- Transcript sharing: true when this proposal's owner published
           -- the dev chat that produced it, so the proposal page can offer
           -- "Read the dev chat". A boolean only — the transcript itself is
           -- served by GET /api/sessions/:id/transcript, which re-checks
           -- both share flags. shared_at survives promotion and merge, so
           -- this stays meaningful on merged rows too (the post-hoc "how
           -- did this change come about?" read).
           (cs.transcript_shared_at IS NOT NULL) AS transcript_shared,
           -- #687 (PR-import): provenance for the "Imported PR" badge +
           -- GitHub-maintained note (kept visible on merged rows too).
           cs.source, cs.imported_pr_author, cs.imported_pr_head_sha,
           cs.reviewed_head_sha,
           -- #967: which external coding agent wrote it, for the "built
           -- with …" chip. Kept on merged rows for the same post-hoc read.
           cs.external_agent,
           -- #381: console-error check snapshot so the warning + detail
           -- block stay visible on a merged proposal for post-hoc review.
           cs.console_check_state, cs.console_errors, cs.console_checked_at,
           -- #47: checks snapshot, kept visible on merged proposals for
           -- post-hoc review (a merged proposal passed, by the gate).
           cs.check_state, cs.test_results, cs.checks_checked_at,
           -- Which half of a 'pending' run is in flight ('building' |
           -- 'testing'), so the checks card names the stage instead of
           -- showing one opaque "still running". NULL = legacy wording.
           cs.check_phase,
           -- Platform-variables pre-merge check (display mirror; the merge
           -- gate re-evaluates live).
           cs.platform_env_state, cs.platform_env_detail,
           -- #237: when checks are in 'error' (staging preview wouldn't boot),
           -- the captured reason powers the "Preview won't boot" badge tooltip.
           cs.check_error_detail,
           -- #58: the vote threshold + active-user count snapshotted at merge
           -- time. The merged-PR pill renders against votes_required (falling
           -- back to the live majority for legacy rows where it's NULL), and a
           -- tooltip surfaces "needed N of M active users at merge time" when
           -- both are present.
           cs.votes_required,
           cs.active_users_at_merge,
           -- Vote tally + per-viewer vote carried through so the group-chat
           -- activity row can keep its "x / y" pill and "You voted X" box
           -- after the PR merges (status='merged'), rather than the controls
           -- vanishing. Mirrors the /promoted subqueries.
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'yes'
               AND ${currentVotePredicateSql('pv', 'cs')}) as yes_count,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'no'
               AND ${currentVotePredicateSql('pv', 'cs')}) as no_count,
           (SELECT pv.vote FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.user_id = $2
               AND ${currentVotePredicateSql('pv', 'cs')}) as my_vote,
           -- kudos_count folds in any issue bounties AWARDED to this PR on
           -- merge (a bounty resolves into kudos credit for the closing PR's
           -- author), so the count matches the leaderboards. my_kudos is
           -- likewise true if the viewer either gave a PR kudos OR pledged a
           -- bounty that was awarded to this PR. my_kudos_direct isolates
           -- the first source — only a direct pr_kudos row is retractable
           -- (DELETE /api/sessions/:id/kudos), so the FE needs to know
           -- which kind of credit it's rendering.
           ((SELECT COUNT(*)::int FROM pr_kudos WHERE session_id = cs.id)
             + (SELECT COUNT(*)::int FROM issue_bounties WHERE awarded_session_id = cs.id AND status = 'awarded')) as kudos_count,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)
                 OR EXISTS(SELECT 1 FROM issue_bounties WHERE awarded_session_id = cs.id AND status = 'awarded' AND giver_user_id = $2)) as my_kudos,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)) as my_kudos_direct,
           -- #194: per-proposal human-message count so the Completed list
           -- renders the same 💬 badge as the active proposals (and signals
           -- which merged proposals have a discussion worth opening). Counts
           -- msg_type='message' only — matching the /promoted subquery — so
           -- dual-posted lifecycle/vote system rows don't inflate the badge.
           (SELECT COUNT(*)::int FROM chat_messages cm
             WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id
               AND cm.msg_type = 'message') as chat_count,
           rv.id        as revert_session_id,
           rv.pr_number as revert_pr_number,
           rv.pr_url    as revert_pr_url,
           rv.status    as revert_status
         FROM chat_sessions cs
         JOIN users u ON cs.user_id = u.id
         LEFT JOIN chat_sessions rv ON rv.revert_of_session_id = cs.id
           AND rv.status IN ('promoted', 'merging', 'merged')`;
}

function voteRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Per-app visibility gate for the session-id-addressed vote routes
  // (promote / vote / votes / undo / admin-merge): collab-level access,
  // 404 on deny. Admins always pass inside the guard.
  router.use('/api/sessions/:id', appAccess.sessionCollabGuard(pool));

  // Promote a session's PR for voting
  // drainGuard (#767): promote/merge kick container work (staging build,
  // production rebuild) that must not be started by a process seconds from
  // exiting — a half-run rebuild leaves the app down until the next heal
  // sweep. 503 here is honest and the client retries against the new
  // container. Read-only vote/undo paths stay ungated.
  router.post('/api/sessions/:id/promote', drainGuard, async (req, res) => {
    try {
      // #183: headless rows are excluded — auto sessions are never
      // promotable themselves; users clone them and propose the clone.
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status = 'active'
           AND cs.is_headless = FALSE`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Active session not found' });
      const session = rows[0];
      const previousReviewedHead = session.reviewed_head_sha || null;

      // Promoted-PR cap: worker-less promoted sessions don't count
      // against the per-user active-session cap (see the create-session
      // cap in routes/sessions.js), so this is the bound that keeps one
      // user from accumulating unlimited open-for-vote PRs (each holding a
      // staging preview and vote-panel attention). Checked before the
      // lazy PR creation below so an over-cap promote doesn't open a
      // PR it then refuses to put up for vote.
      //
      // The ceiling is per-REQUESTER: full platform admins get a raised
      // cap (services/session-caps.js). Never compare against
      // config.maxUserPromotedSessions directly here.
      const caps = effectiveSessionCaps(config, req.user);
      const { rows: promotedRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM chat_sessions
         WHERE user_id = $1 AND status IN ('promoted', 'merging') AND is_headless = FALSE`,
        [req.user.id]
      );
      if (parseInt(promotedRows[0].cnt) >= caps.promotedSessions) {
        return res.status(429).json({
          error: `You already have ${caps.promotedSessions} PRs up for vote. Wait for one to merge, or archive one first.`,
        });
      }

      const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

      // #183 lazy PR creation: sessions cloned from a headless auto run
      // arrive here without a PR (the headless contract defers it). Create
      // it now on THIS session's branch — the clone's, never the auto
      // branch — so the vote has something to merge. applyPrMetadata reads
      // the clone's copied history via gatherSessionContext, so the PR
      // title/body get the full auto-session context.
      //
      // Also runs when a PR exists but pr_title is missing: staging
      // recovery (server.js rebuildSessionStaging) can mint a PR before
      // promotion without a generated title, and a NULL pr_title would
      // otherwise render as "Change by <user>" forever. Backfilling it
      // here updates both GitHub and pr_title/session_title.
      if (!session.pr_number || !session.pr_title) {
        // Distinguish creating a PR (no pr_number → a failure must block
        // promotion) from merely backfilling a missing title on an
        // existing PR (best-effort — never block promotion on it).
        const isBackfill = !!session.pr_number;
        const { rows: msgRows } = await pool.query(
          `SELECT content FROM chat_session_messages
           WHERE session_id = $1 AND role = 'user'
           ORDER BY id DESC LIMIT 1`,
          [session.id]
        );
        const prMetadata = require('../services/pr-metadata');
        let prResult = null;
        let prError = null;
        try {
          prResult = await prMetadata.applyPrMetadata({
            pool, session, repoOwner, repoName,
            userMessage: msgRows[0]?.content || '',
            ccSummary: '',
            username: req.user.username,
            userId: req.user.id,
          });
        } catch (err) {
          prError = err;
          log.warn('votes', 'Lazy PR creation/backfill threw', {
            sessionId: session.id, backfill: isBackfill,
            code: err.code || null, ...github.describeGithubError(err),
          });
        }
        if (!isBackfill && (!prResult || !session.pr_number)) {
          // Refuse to promote PR-less — a vote with nothing to merge is a
          // dead end. Nothing was mutated yet.
          if (prError && prError.code === 'no_commits') {
            // Permanent condition: the branch has no commits on GitHub
            // (typically committed locally but never pushed). "Try again
            // in a moment" would loop forever — tell the truth instead.
            return res.status(409).json({
              error: 'This change has no committed code on its branch yet, so there is nothing to open a pull request for. Re-run your request in the session so it produces and pushes a commit, then propose again.',
            });
          }
          if (prError && prError.code === 'github_unavailable') {
            // GitHub-side outage (2026-07-24: hours of empty-body 500s on
            // POST /pulls only). Retrying immediately or re-running the
            // request in the session cannot help — say so honestly. This
            // message also reaches the Mayor, which stops it from making
            // no-op commits to "fix" a problem that isn't in the change.
            const detail = [
              prError.status ? `HTTP ${prError.status} from GitHub` : 'network error reaching GitHub',
              prError.requestId ? `request id ${prError.requestId}` : null,
            ].filter(Boolean).join(', ');
            return res.status(503).json({
              error: `GitHub is currently failing to create pull requests (${detail}). This is a GitHub-side problem, not this change — the work is safe on its branch. Try proposing again in a few minutes; do not re-run the request or push extra commits.`,
            });
          }
          return res.status(502).json({
            error: 'Could not create the pull request for this change. Please retry; if it keeps failing, re-run your request in the session.',
          });
        }
      }

      // Reconcile the PR's GitHub state before putting it up for vote and
      // capture the immutable head revision this review starts from. The PR
      // head can move outside the vote flow, so failing to read it must
      // fail closed: checks/votes cannot honestly describe an unknown revision.
      // A session that was withdrawn (archived) carries a CLOSED PR —
      // GitHub reports closed PRs as permanently unmergeable, so
      // promoting one without a reopen creates a proposal that can
      // never merge (session 2398 / PR #26: every merge 405'd and the
      // auto-resolver looped still_conflicting forever). Reopen it here;
      // if GitHub refuses (head branch deleted, a newer PR on the same
      // head), refuse the promote with an actionable error instead of
      // minting a doomed proposal.
      let promotedHeadSha = null;
      if (github.isEnabled() && session.repo_url && session.pr_number) {
        const [, owner, repo] = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
        if (!owner || !repo) {
          return res.status(409).json({
            error: 'This proposal has no valid GitHub repository to verify.',
          });
        }
        if (owner && repo) {
          let pr = null;
          try {
            pr = await github.getPR(owner, repo, session.pr_number);
          } catch (err) {
            log.warn('votes', 'Promote PR revision check failed', {
              sessionId: session.id, pr: session.pr_number, err: err.message,
            });
            return res.status(503).json({
              error: 'GitHub could not verify the pull request revision. Try promoting again shortly.',
            });
          }
          if (pr && pr.merged) {
            return res.status(409).json({
              error: `PR #${session.pr_number} was already merged on GitHub — this change has landed, so there is nothing to vote on.`,
            });
          }
          if (pr && pr.state === 'closed') {
            try {
              await github.reopenPR(owner, repo, session.pr_number);
              log.info('votes', 'Reopened closed PR at promote time', {
                sessionId: session.id, pr: session.pr_number,
              });
            } catch (err) {
              log.warn('votes', 'Could not reopen closed PR at promote time', {
                sessionId: session.id, pr: session.pr_number, err: err.message,
              });
              return res.status(409).json({
                error: `This proposal's pull request (#${session.pr_number}) was closed on GitHub and couldn't be reopened — re-propose it as a fresh proposal.`,
              });
            }
          }
          promotedHeadSha = pr?.head?.sha || null;
          if (!promotedHeadSha || !/^[0-9a-f]{40}$/i.test(promotedHeadSha)) {
            return res.status(409).json({
              error: 'GitHub did not return a valid pull-request head commit.',
            });
          }
          if (req.cliHandoffCheckedHead
              && String(promotedHeadSha).toLowerCase()
                !== String(req.cliHandoffCheckedHead).toLowerCase()) {
            // A direct push landed after the CLI-handoff middleware verified
            // the managed branch but before lazy PR creation / this PR read.
            // Keep the session active so the new head can be rebuilt; never
            // open voting on code that did not produce the ready verdict.
            const detail = 'The proposal branch changed after checks. Rebuild the new head locally or from the web Dev session before promoting.';
            await pool.query(
              `UPDATE chat_sessions SET check_state = 'error', check_error_detail = $1
                WHERE id = $2 AND status = 'active' AND source = 'cli_handoff'
                  AND COALESCE(checks_commit_sha, handoff_head_sha)
                      IS NOT DISTINCT FROM $3`,
              [detail, session.id, req.cliHandoffCheckedHead]
            ).catch(() => {});
            return res.status(409).json({
              error: 'branch_head_changed',
              message: detail,
            });
          }

          // Mark PR as ready for review on GitHub. We deliberately DO NOT
          // touch the title here — previously this overwrote the LLM-
          // generated title back to "<user>'s changes" every time a PR
          // was promoted, wiping the more descriptive title.
          try {
            // octokit.request rather than .rest.pulls.update —
            // @octokit/app's installation Octokit is a bare core
            // instance without the rest-endpoint-methods plugin, so
            // .rest is undefined.
            const octokit = await github.getInstallationOctokit(owner);
            await octokit.request(
              'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
              { owner, repo, pull_number: session.pr_number, draft: false }
            );
          } catch (err) {
            log.warn('votes', 'Failed to update PR on GitHub', { err: err.message });
          }
        }
      }

      // promoted_at anchors the stale-PR sweeper's "no interest since"
      // clock; clearing stale_notified_at handles the re-promote case
      // (a previously-stale PR that's proposed again starts fresh).
      const promoted = await pool.query(
        `UPDATE chat_sessions
            SET status = 'promoted', promoted_at = NOW(),
                stale_notified_at = NULL,
                reviewed_head_sha = COALESCE($2, reviewed_head_sha)
          WHERE id = $1 AND status = 'active'`,
        [session.id, promotedHeadSha]
      );
      if (!promoted.rowCount) {
        return res.status(409).json({ error: 'session_state_changed' });
      }
      if (promotedHeadSha) {
        session.reviewed_head_sha = promotedHeadSha;

        // A withdrawn proposal may retain votes from its earlier review.
        // Preserve only votes explicitly cast for this exact revision; this
        // also removes legacy unbound votes while keeping same-head re-promotes
        // stable. The governance gate is head-scoped too, so this cleanup keeps
        // the visible tally aligned with what can actually count.
        const cleared = await pool.query(
          `DELETE FROM pr_votes
            WHERE session_id = $1 AND head_sha IS DISTINCT FROM $2`,
          [session.id, promotedHeadSha]
        );
        if ((cleared.rowCount || 0) > 0) {
          try {
            const { pushVoteUpdate } = require('../services/ws');
            pushVoteUpdate({
              sessionId: session.id,
              appSlug: session.app_slug || null,
              merged: false,
              headMoved: previousReviewedHead != null,
            });
          } catch (_) { /* ws failures are non-fatal */ }
        }

        // If this is a re-promotion on a new commit and an existing preview
        // still describes the old one, invalidate it immediately and rebuild
        // checks against the captured SHA. A proposal without staging is
        // handled by the ordinary post-response build below.
        if (previousReviewedHead !== promotedHeadSha
            && session.staging_url
            && session.checks_commit_sha !== promotedHeadSha) {
          await kickNativeRevisionChecks({
            config, pool, session, headSha: promotedHeadSha,
          });
        }
      }

      // #788: classify the proposal now that it's up for vote — does its
      // diff change dapp.json's `admins` block? A flagged proposal loses
      // the time-based merge paths (no countdown, no silence-is-consent)
      // and can't be force-merged by an app admin. Best-effort and
      // awaited so the first vote-panel render already carries the flag;
      // checkAndMerge re-verifies authoritatively before merging anyway.
      await appAdmins.refreshExplicitApproval(pool, session, session);

      // Post to group chat. Include the PR title when we have one so
      // the feed reads like "evan promoted PR #8 — Add emoji stamp
      // centering fix for voting" instead of the opaque "PR #8 for
      // voting" which gives no hint about what's being voted on.
      const promoLabel = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${req.user.username} promoted ${promoLabel} for voting`,
        'vote',
        // Lets the group-chat client render live vote buttons inline on
        // this activity row (see group-chat.js renderMessageHtml).
        { vote: { sessionId: session.id, prNumber: session.pr_number || null } }
      );
      // Dual-post into the proposal's own thread so the topic discussion
      // carries its lifecycle in context (general chat stays the
      // app-wide entry point).
      await sendSystemMessage(pool, session.app_id,
        `${req.user.username} promoted ${promoLabel} for voting`,
        'vote',
        { vote: { sessionId: session.id, prNumber: session.pr_number || null } },
        { type: 'session', ref: session.id }
      ).catch(() => {});

      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'promoted', sessionId: session.id, appSlug: session.app_slug });
      log.info('votes', 'Session promoted', { sessionId: session.id });
      events.record(pool, {
        type: events.EVENT_TYPES.PR_PROMOTED,
        userId: req.user.id,
        appId: session.app_id,
        sessionId: session.id,
        metadata: { prNumber: session.pr_number || null },
      });
      // #183: return the PR info so the dev-chat staging card can flip
      // its "Changes ready" header to the PR link without a refetch —
      // the promote may have just created the PR lazily.
      res.json({
        ok: true,
        prNumber: session.pr_number || null,
        prUrl: session.pr_url || null,
        prTitle: session.pr_title || null,
      });

      // #183: a clone promoted straight off a headless auto run's pre-built
      // preview may not have its own staging yet (the copied card points at
      // the auto session's URL — same content, since the clone branch was
      // forked from it). Build the clone's own staging from its branch head,
      // fire-and-forget; the Pass-3 heal sweeper in server.js is the backstop.
      if (!session.staging_url) {
        (async () => {
          // Use the exact revision captured before promotion. The fallback
          // exists only for GitHub-disabled local development.
          let commitHash = session.reviewed_head_sha || 'latest';
          if (commitHash === 'latest' && github.isEnabled() && repoOwner && repoName) {
            try {
              const octokit = await github.getInstallationOctokit(repoOwner);
              const { data: ref } = await octokit.request(
                'GET /repos/{owner}/{repo}/git/ref/{+ref}',
                { owner: repoOwner, repo: repoName, ref: `heads/${session.branch_name}` }
              );
              commitHash = ref.object.sha;
            } catch {}
          }
          const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };
          // #607: stamp 'pending' + broadcast before the (minutes-long)
          // staging build so the freshly promoted proposal's card shows
          // "Checks running…" instead of a bare NULL-verdict "Re-run
          // checks" button. captureForSession re-stamps idempotently.
          {
            const visualsService = require('../services/visuals');
            await visualsService.setChecksPending(
              pool, session.id, commitHash === 'latest' ? null : commitHash, 'building'
            ).catch((err) => log.warn('votes', 'promote setChecksPending failed (non-fatal)', {
              sessionId: session.id, err: err.message,
            }));
            visualsService.notifyChecksPending(session.id, commitHash === 'latest' ? null : commitHash, 'building');
          }
          let result;
          try {
            result = await staging.buildAndDeployStaging(config, session, app, commitHash);
          } catch (err) {
            // #461: the proposal is already promoted, so a swallowed build
            // failure would leave check_state NULL — merge-blocked as
            // "still running its tests" with no signal. Record a terminal
            // 'error' verdict (with reason + once-per-streak owner nudge)
            // before surfacing the failure to the outer catch's WARN log.
            const stagingRecovery = require('../services/staging-recovery');
            await stagingRecovery.recordStagingBootFailure({
              config, pool, session,
              commitHash: commitHash === 'latest' ? null : commitHash, err,
            }).catch((e) => log.warn('votes', 'recordStagingBootFailure failed (non-fatal)', {
              sessionId: session.id, err: e.message,
            }));
            throw err;
          }
          await pool.query(
            `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
            [result.containerId, result.stagingUrl, session.id]
          );
          await staging.verifyStagingEdge(session, result.hostname, result.stagingUrl);
          // #195: capture before/after visuals off the fresh preview so
          // headless proposals promoted from clones get media on the vote
          // card + PR body even though the auto session's own staging (and
          // its capture window) may be long gone. Fire-and-forget; the
          // heuristic + all failure handling live inside the service.
          const visualsService = require('../services/visuals');
          visualsService.captureForSession(
            config, session, app, commitHash === 'latest' ? null : commitHash, result
          ).catch((err) => {
            log.warn('votes', 'Post-promote visuals capture failed', { sessionId: session.id, err: err.message });
          });
        })().catch((err) => {
          log.warn('votes', 'Post-promote staging build failed', { sessionId: session.id, err: err.message });
        });
      } else {
        // #461: the preview already exists (e.g. built via the manual
        // deploy-staging button, which historically never ran checks, or
        // inherited from an earlier turn whose capture described an older
        // commit). Kick a recheck NOW when the verdict is missing or
        // describes a different commit than the branch head, instead of
        // leaving the freshly-promoted proposal merge-blocked until a
        // background sweep notices. Fire-and-forget; recheckSessionChecks
        // re-runs against the live container (or rebuilds a dead one) and
        // captureForSession is _inFlight-guarded.
        (async () => {
          let needsKick = !session.check_state;
          if (!needsKick && github.isEnabled() && repoOwner && repoName) {
            try {
              const octokit = await github.getInstallationOctokit(repoOwner);
              const { data: ref } = await octokit.request(
                'GET /repos/{owner}/{repo}/git/ref/{+ref}',
                { owner: repoOwner, repo: repoName, ref: `heads/${session.branch_name}` }
              );
              needsKick = !!ref.object.sha && ref.object.sha !== session.checks_commit_sha;
            } catch {}
          }
          if (!needsKick) return;
          const stagingRecovery = require('../services/staging-recovery');
          await stagingRecovery.recheckSessionChecks({
            config, pool, session, reason: 'promote-kick',
          });
        })().catch((err) => {
          log.warn('votes', 'Promote-time checks kick failed', { sessionId: session.id, err: err.message });
        });
      }

      // Vote-request fan-out. Non-fatal + post-response: the promote
      // itself has already succeeded, so a notification hiccup must not
      // 500 the request. Pings the app's active users + creator +
      // favoriters (minus the proposer) so the right people come vote,
      // and de-dupes per session so a re-promote doesn't re-spam.
      try {
        const notifRows = await notifications.createPrProposedNotifications(pool, {
          appId: session.app_id,
          sessionId: session.id,
          proposerId: req.user.id,
        });
        for (const row of notifRows) {
          pushNotificationToUser(row.user_id, {
            type: 'notification_new',
            notification: notifications.serialize({
              ...row,
              app_slug: session.app_slug,
              app_name: session.app_name,
              pr_title: session.pr_title,
              pr_number: session.pr_number,
              source_username: req.user.username,
            }),
          });
        }
        if (notifRows.length) {
          log.info('votes', 'PR-proposed notifications sent', {
            sessionId: session.id, count: notifRows.length,
          });
        }
      } catch (err) {
        log.warn('votes', 'pr_proposed notify failed', { sessionId: session.id, err: err.message });
      }
    } catch (err) {
      log.error('votes', 'Promote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── #687: import an existing GitHub PR as a proposal ────────────────
  //
  // The three endpoints (candidate list, preview, import) let a collaborator pull an
  // externally-authored PR into the vote flow instead of building it in the
  // platform's AI dev-chat. Preview/candidates are read-only; import creates
  // a `source='imported'` chat_sessions row promoted straight into voting.
  //
  // Parse owner/repo from an app's repo_url, or null.
  const parseRepo = (url) => {
    const [, owner, repo] = (url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    return owner && repo ? { owner, repo } : null;
  };

  // Fire-and-forget: build the imported PR's staging preview pinned to its
  // exact head SHA (Slice 1 clone fix) and run its checks, mirroring the
  // post-promote path so an imported proposal gets a preview + checks verdict
  // like any native one. The implementation lives in services/pr-import-sync
  // (#846) beside its head-change sibling rerunChecksForNewHead, so it is
  // unit-testable; it never throws, so nothing can escape into the request.
  const kickImportedChecks = (session, app, headSha) => {
    const prImportSync = require('../services/pr-import-sync');
    prImportSync.kickImportedChecks({ config, pool, session, app, headSha });
  };

  // Which of this app's PR numbers are already imported and still live/merged
  // (so the picker + import guard don't offer/allow a duplicate). Archived
  // imports are excluded so a withdrawn import can be re-imported.
  const importedPrNumbers = async (appId) => {
    const { rows } = await pool.query(
      `SELECT DISTINCT pr_number FROM chat_sessions
        WHERE app_id = $1 AND source = 'imported' AND pr_number IS NOT NULL
          AND status IN ('promoted', 'merging', 'merged')`,
      [appId]
    );
    return new Set(rows.map((r) => r.pr_number));
  };

  // #866: is this PR headed by a branch that lives in a DIFFERENT repo (a
  // fork)? GitHub answers this by comparing head.repo.full_name against
  // base.repo.full_name; `head.label` ("owner:branch") is the fallback for
  // the case where the fork was deleted and head.repo comes back null.
  //
  // This matters to a reviewer BEFORE they import: a fork-headed PR's branch
  // does not exist in the app's own repo, so the preview is built from
  // refs/pull/<N>/head (see staging.js) and the code being previewed is an
  // outside contributor's, not the group's. Unknown/absent metadata reads as
  // "not a fork" — the label is an extra caution, never a gate, so guessing
  // "fork" from missing data would only cry wolf.
  function prForkInfo(pr, repo) {
    const baseFull = pr?.base?.repo?.full_name
      || (repo ? `${repo.owner}/${repo.repo}` : null);
    let headFull = pr?.head?.repo?.full_name || null;
    if (!headFull && typeof pr?.head?.label === 'string' && pr.head.label.includes(':')) {
      const owner = pr.head.label.split(':')[0];
      const name = baseFull ? baseFull.split('/')[1] : null;
      if (owner && name) headFull = `${owner}/${name}`;
    }
    const fromFork = !!(headFull && baseFull
      && headFull.toLowerCase() !== baseFull.toLowerCase());
    return { fromFork, headRepo: fromFork ? headFull : null };
  }

  // GET candidate PRs to import (open PRs on the app's repo not already
  // imported). Collab access.
  router.get('/api/apps/:slug/pr-import/candidates', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      const repo = parseRepo(app.repo_url);
      const gh = importGithubClient();
      if (!gh.isEnabled() || !repo) return res.json({ candidates: [] });

      const imported = await importedPrNumbers(app.id);
      let pulls = [];
      try {
        pulls = await gh.listOpenPulls(repo.owner, repo.repo);
      } catch (err) {
        log.warn('votes', 'listOpenPulls failed', { slug: req.params.slug, err: err.message });
        return res.json({ candidates: [] });
      }
      const candidates = pulls
        .filter((p) => !imported.has(p.number))
        .map((p) => ({
          number: p.number,
          title: p.title,
          author: p.user?.login || null,
          headBranch: p.head?.ref || null,
          baseBranch: p.base?.ref || null,
          headSha: p.head?.sha || null,
          htmlUrl: p.html_url || null,
          // #866: fork provenance for the picker's "from a fork — …" label.
          ...prForkInfo(p, repo),
        }));
      res.json({ candidates });
    } catch (err) {
      log.error('votes', 'PR-import candidates failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET a read-only preview of a single PR before importing. Collab access.
  router.get('/api/apps/:slug/pr-import/preview', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      const repo = parseRepo(app.repo_url);
      const prNumber = parseInt(req.query.pr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        return res.status(400).json({ error: 'A valid PR number is required' });
      }
      const gh = importGithubClient();
      if (!gh.isEnabled() || !repo) {
        return res.status(409).json({ error: 'GitHub is not configured for this app' });
      }

      let pr;
      try {
        pr = await gh.getPR(repo.owner, repo.repo, prNumber);
      } catch (err) {
        return res.status(404).json({ error: `PR #${prNumber} not found on GitHub` });
      }
      const headSha = pr.head?.sha || null;
      const baseRef = pr.base?.ref || 'main';
      let changedFiles = [];
      try {
        changedFiles = await gh.listChangedFiles(
          repo.owner, repo.repo, `${baseRef}...${headSha || pr.head?.ref}`
        );
      } catch (err) {
        log.warn('votes', 'PR-import preview listChangedFiles failed', { prNumber, err: err.message });
      }
      const imported = await importedPrNumbers(app.id);
      res.json({
        preview: {
          number: pr.number,
          title: pr.title,
          author: pr.user?.login || null,
          state: pr.state,
          headBranch: pr.head?.ref || null,
          baseBranch: baseRef,
          headSha,
          // GitHub's mergeable is true/false/null (null = still computing).
          mergeable: pr.mergeable,
          mergeableState: pr.mergeable_state || null,
          changedFiles,
          changedFileCount: changedFiles.length,
          htmlUrl: pr.html_url || null,
          alreadyImported: imported.has(pr.number),
          // #866: same fork provenance the candidate list carries, so the
          // preview pane can repeat the caution before the import lands.
          ...prForkInfo(pr, repo),
        },
      });
    } catch (err) {
      log.error('votes', 'PR-import preview failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST import a PR as a proposal. Collab access. Creates a promoted
  // `source='imported'` session and kicks its SHA-pinned checks build.
  router.post('/api/apps/:slug/pr-import', drainGuard, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      const repo = parseRepo(app.repo_url);
      const prNumber = parseInt(req.body?.pr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        return res.status(400).json({ error: 'A valid PR number is required' });
      }
      const gh = importGithubClient();
      if (!gh.isEnabled() || !repo) {
        return res.status(409).json({ error: 'GitHub is not configured for this app' });
      }

      // 409 if this PR is already imported and still live/merged.
      const imported = await importedPrNumbers(app.id);
      if (imported.has(prNumber)) {
        return res.status(409).json({ error: `PR #${prNumber} has already been imported.` });
      }

      let pr;
      try {
        pr = await gh.getPR(repo.owner, repo.repo, prNumber);
      } catch (err) {
        return res.status(404).json({ error: `PR #${prNumber} not found on GitHub` });
      }
      if (pr.state !== 'open') {
        return res.status(409).json({ error: `PR #${prNumber} is not open.` });
      }
      const headSha = pr.head?.sha || null;
      const headBranch = pr.head?.ref || null;
      if (!headBranch) {
        return res.status(409).json({ error: 'Could not determine the PR head branch.' });
      }

      // Optional testing metadata (#945 follow-up). A connector submission
      // can carry the same two things a build turn's "==== TESTING ===="
      // block carries — the routes the change is visible on, and how to see
      // it — so an imported proposal gets before/after screenshots of the
      // screen that changed instead of the app's home page.
      //
      // Re-validated here rather than trusted from the caller: the route is
      // reachable by any collaborator, and testing_path is joined onto the
      // staging origin and loaded in the preview iframe. Same validator, same
      // caps as the block parser — services/testing-notes.js owns both.
      // Absent (the browser's import button never sends them) leaves all
      // three columns NULL, exactly as before.
      const importTesting = parseImportTesting(req.body);

      // Create the imported proposal row, promoted straight into voting.
      const { rows: inserted } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status,
            source, imported_pr_head_sha, imported_pr_author, promoted_at, created_at,
            testing_md, testing_path, testing_paths)
         VALUES ($1, $2, $3, $4, $5, $6, 'promoted',
            'imported', $7, $8, NOW(), NOW(),
            $9, $10, $11::jsonb)
         RETURNING id`,
        [
          app.id, req.user.id, headBranch, prNumber, pr.html_url || null,
          pr.title || `PR #${prNumber}`, headSha, pr.user?.login || null,
          importTesting.testingMd, importTesting.testingPath,
          importTesting.testingPaths ? JSON.stringify(importTesting.testingPaths) : null,
        ]
      );
      const sessionId = inserted[0].id;
      const session = {
        id: sessionId, app_id: app.id, app_slug: app.slug, user_id: req.user.id,
        branch_name: headBranch, pr_number: prNumber, pr_title: pr.title || null,
        repo_url: app.repo_url, staging_url: null, source: 'imported',
      };

      // Announce it for voting (group chat + the proposal's own thread),
      // mirroring the native promote path.
      const label = pr.title ? `PR #${prNumber} — ${pr.title}` : `PR #${prNumber}`;
      await sendSystemMessage(pool, app.id,
        `${req.user.username} imported ${label} for voting`,
        'vote',
        { vote: { sessionId, prNumber } }
      ).catch(() => {});
      await sendSystemMessage(pool, app.id,
        `${req.user.username} imported ${label} for voting`,
        'vote',
        { vote: { sessionId, prNumber } },
        { type: 'session', ref: sessionId }
      ).catch(() => {});

      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'promoted', sessionId, appSlug: app.slug });
      try {
        events.record(pool, {
          type: events.EVENT_TYPES.PR_PROMOTED,
          userId: req.user.id, appId: app.id, sessionId,
          metadata: { prNumber, source: 'imported' },
        });
      } catch { /* events are best-effort */ }

      log.info('votes', 'PR imported as proposal', { sessionId, prNumber, appId: app.id });
      res.json({ ok: true, sessionId, prNumber });

      // Kick the SHA-pinned staging build + checks after responding.
      const appForBuild = { id: app.id, slug: app.slug, name: app.name, repo_url: app.repo_url };
      kickImportedChecks(session, appForBuild, headSha);
    } catch (err) {
      log.error('votes', 'PR-import failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #687 Slice 6: mock-control endpoint — simulate the external author
  // pushing a new commit to an imported PR, so a preview reviewer can drive
  // the head-change and merge-409 outcomes live (the sweeper would eventually
  // do the same, but this makes it a click). Mounted always but 404 unless
  // BOTH the master flag and the opt-in mock flag are on, so it can never do
  // anything in production (mock flag default off there). Collab access.
  //   body: { sessionId, mode }
  //     mode 'push-and-sync' (default) — bump the mock head AND run the sync
  //       poller path immediately: tally reset + "please re-review" note +
  //       checks re-run, and imported_pr_head_sha advances to the new head.
  //     mode 'push-only' — bump the mock head but DO NOT sync, leaving
  //       imported_pr_head_sha stale so the next merge attempt hits the
  //       exact-sha 409 (head-moved) path.
  router.post('/api/apps/:slug/pr-import/_mock/advance', async (req, res) => {
    try {
      if (!usesMockGithubForImports()) {
        return res.status(404).json({ error: 'Not found' });
      }
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      const sessionId = parseInt(req.body?.sessionId, 10);
      const mode = req.body?.mode === 'push-only' ? 'push-only' : 'push-and-sync';
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ error: 'A valid sessionId is required' });
      }
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
           FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
          WHERE cs.id = $1 AND cs.app_id = $2 AND cs.source = 'imported'`,
        [sessionId, app.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Imported proposal not found' });
      const session = rows[0];
      if (!session.pr_number) return res.status(409).json({ error: 'Session has no PR number' });

      const newHead = githubMock.bumpHead(session.pr_number);
      let synced = false;
      if (mode !== 'push-only') {
        const prImportSync = require('../services/pr-import-sync');
        const result = await prImportSync.syncImportedProposal({ config, pool, session });
        synced = result === 'updated';
      }
      log.info('votes', 'Mock PR head advanced', { sessionId, prNumber: session.pr_number, mode, newHead, synced });
      res.json({ ok: true, mode, newHead, synced });
    } catch (err) {
      log.error('votes', 'PR-import mock advance failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Cast a vote on a promoted PR
  router.post('/api/sessions/:id/vote', async (req, res) => {
    const { vote } = req.body;
    if (!['yes', 'no'].includes(vote)) {
      return res.status(400).json({ error: 'Vote must be "yes" or "no"' });
    }

    try {
      // Accept votes on 'promoted' OR 'merging' sessions — once a merge
      // has started, a user flipping their vote shouldn't 404. But we
      // only *do* anything with the vote (chat message, merge check) if
      // it actually changed; see below.
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.id as app_id, a.repo_url,
                a.self_hosted as app_self_hosted
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status IN ('promoted', 'merging')`,
        [req.params.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Promoted session not found' });
      const session = sessionRows[0];

      // Verify the live head before recording a native vote. The PR may have
      // moved since the proposal was opened; in that case
      // reconcileNativeReviewedHead advances the reviewed revision,
      // drops only stale-revision votes, invalidates old checks, and this vote
      // is then safely recorded against the new commit.
      const revision = await reconcileNativeReviewedHead({
        config, pool, session, fresh: true,
      });
      if (revision.blocked) {
        return res.status(revision.transient ? 503 : 409).json({ error: revision.reason });
      }

      // A Yes vote can be the operation that applies a value held by a
      // secret-declaration proposal. The generic session vote path stays
      // available for ordinary PRs, but api:access is not credential authority.
      if (isCliCredentialManagementSession(req, session)) {
        return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
      }

      // A click approves the revision that was actually rendered in the
      // voter's browser, not whichever commit happens to be newest by the time
      // this request reaches GitHub. Reconciliation above still advances the
      // proposal and clears stale votes, but a changed/missing browser stamp
      // requires a refresh and a second explicit click.
      if (!voteMatchesReviewedRevision(req.body?.expectedHeadSha, revision)) {
        return revisionChangedVoteResponse(res, revision.headSha);
      }

      // Was this a new vote, or a flip? Distinguishing matters because
      // without this, a user mashing "Yes" would post the same
      // "X voted yes on PR #N" line to group chat every time AND fire a
      // fresh checkAndMerge on every click — which, before the merge
      // concurrency guard, caused 7× parallel GitHub merges + docker
      // rebuilds stepping on each other's tempdirs and container names.
      // The DB upsert itself is still safe (UNIQUE(session_id,user_id))
      // but we avoid the side-effects on a no-op.
      const { rows: prevRows } = await pool.query(
        `SELECT vote, head_sha FROM pr_votes WHERE session_id = $1 AND user_id = $2`,
        [session.id, req.user.id]
      );
      const previousVote = prevRows[0]?.vote || null;
      const voteHeadSha = reviewedHeadForSession(session);
      const unchanged = previousVote === vote
        && (prevRows[0]?.head_sha || null) === voteHeadSha;

      // Stamp every GitHub proposal vote with its reviewed PR head. Imported
      // proposals retain imported_pr_head_sha; native proposals use the new
      // reviewed_head_sha populated above. Governance counts only approvals
      // matching the current revision.
      const recorded = await recordVote({
        pool,
        session,
        userId: req.user.id,
        vote,
        headSha: voteHeadSha,
        revisionEnforced: !!revision.enforced,
      });
      if (revision.enforced && (recorded.rowCount || 0) === 0) {
        // The DB head moved after the GitHub read but before the write lock.
        // Refresh the proposal state, but never transfer this click to it.
        const latest = await reconcileNativeReviewedHead({
          config, pool, session, fresh: true,
        }).catch(() => null);
        return revisionChangedVoteResponse(
          res,
          latest && !latest.blocked ? latest.headSha : reviewedHeadForSession(session),
          'This proposal changed while your vote was being recorded. Refresh it, review the new revision, then vote again.'
        );
      }

      // Any voting activity revives a going-stale PR: clear the warning
      // flag so the stale sweeper restarts its clock instead of archiving.
      if (session.stale_notified_at) {
        await pool.query(
          `UPDATE chat_sessions SET stale_notified_at = NULL WHERE id = $1`,
          [session.id]
        );
      }

      // Auto-dismiss this voter's PR notifications for this session now that
      // the vote is recorded in the DB (i.e. confirmed, not optimistic). Runs
      // before the `unchanged` early-return below so a re-vote still ensures
      // the nudge is cleared, and it's idempotent (clears only unread rows).
      // Non-fatal: a notification hiccup must never 500 a successful vote.
      try {
        const cleared = await notifications.markReadForSession(pool, req.user.id, session.id);
        if (cleared > 0) {
          // Fan out to the voter's OTHER tabs/devices so their unread badge
          // syncs without a manual refresh; the acting tab refreshes itself.
          pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
        }
      } catch (err) {
        log.warn('votes', 'notification auto-dismiss failed', {
          sessionId: session.id, userId: req.user.id, err: err.message,
        });
      }

      if (unchanged) {
        log.debug('votes', 'Vote unchanged, skipping broadcast+merge', {
          sessionId: session.id, userId: req.user.id, vote,
        });
        return res.json({ ok: true, merged: false, unchanged: true });
      }

      const voteLabel = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${req.user.username} voted ${vote} on ${voteLabel}`,
        'vote',
        // Lets the group-chat client render live vote buttons inline on
        // this activity row (see group-chat.js renderMessageHtml).
        { vote: { sessionId: session.id, prNumber: session.pr_number || null } },
        // #194: per-vote activity lands in the proposal's own thread, not
        // general chat — the promote/merge announcements remain the
        // general-chat entry points.
        { type: 'session', ref: session.id }
      );

      // Broadcast the new tally *before* we try to merge, and respond
      // to the voter right away. checkAndMerge can take 30+ seconds on
      // the majority path (GitHub merge + prod rebuild + staging
      // teardown) and blocking on it here meant:
      //   - every other user's vote count sat stale until merge
      //     finished, which looked like "votes don't update live",
      //   - the voter's own UI sat mid-click with a spinning button
      //     while the merge ran, sometimes for the full 30s.
      // The merge itself still runs atomically (checkAndMerge claims
      // the session via 'promoted' → 'merging'), so kicking it into
      // the background doesn't change correctness.
      const { pushVoteUpdate } = require('../services/ws');
      pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: false });
      log.info('votes', 'Vote cast', { sessionId: session.id, vote, userId: req.user.id });

      // Emit only on a real (new or flipped) vote — the `unchanged`
      // no-op already returned above. pr_vote_cast credits the voter;
      // pr_vote_received credits the PR author (when still attributed),
      // so the PR-promotion funnel can measure "got a vote" reach.
      events.record(pool, {
        type: events.EVENT_TYPES.PR_VOTE_CAST,
        userId: req.user.id,
        appId: session.app_id,
        sessionId: session.id,
        metadata: { vote },
      });
      if (session.user_id && session.user_id !== req.user.id) {
        events.record(pool, {
          type: events.EVENT_TYPES.PR_VOTE_RECEIVED,
          userId: session.user_id,
          appId: session.app_id,
          sessionId: session.id,
          metadata: { vote, voterId: req.user.id },
        });
      }
      res.json({ ok: true, merged: false });

      // Kick off the majority check in the background. If it turns
      // into a merge, we send a second broadcast so clients flip the
      // PR out of the vote panel and update the "merged" list.
      checkAndMerge(config, pool, session)
        .then((mergeResult) => {
          if (mergeResult?.merged) {
            pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: true });
          }
        })
        .catch((err) => {
          log.error('votes', 'Background merge failed', { sessionId: session.id, err: err.message });
        });
    } catch (err) {
      log.error('votes', 'Vote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get vote tally for a session. #646: when the app restricts
  // approvals to invited approvers, `approvers` lists the usernames
  // whose votes QUALIFY (the roster, incl. the full-admin fallback) so
  // the FE can tag approver votes; it's absent under the default
  // 'anyone' policy.
  router.get('/api/sessions/:id/votes', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT pv.vote, u.username, pv.user_id
         FROM pr_votes pv
         JOIN users u ON pv.user_id = u.id
         JOIN chat_sessions cs ON cs.id = pv.session_id
         WHERE pv.session_id = $1
           AND ${currentVotePredicateSql('pv', 'cs')}`,
        [req.params.id]
      );

      const yes = rows.filter((r) => r.vote === 'yes');
      const no = rows.filter((r) => r.vote === 'no');

      const out = { yes: yes.map((r) => r.username), no: no.map((r) => r.username) };

      try {
        const { rows: sessRows } = await pool.query(
          'SELECT app_id FROM chat_sessions WHERE id = $1', [req.params.id]
        );
        const appId = sessRows[0]?.app_id;
        if (appId) {
          const governance = require('../services/governance');
          const gov = await governance.getGovernance(pool, appId);
          if (gov.approverPolicy === 'invited') {
            const { ids } = await governance.getApproverSet(pool, appId);
            const idSet = new Set(ids);
            out.approvers = rows.filter((r) => idSet.has(r.user_id)).map((r) => r.username);
          }
        }
      } catch (err) {
        log.warn('votes', 'approver tagging failed (non-fatal)', { err: err.message });
      }

      res.json(out);
    } catch (err) {
      log.error('votes', 'Failed to get votes', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #194: the viewer's own proposals currently open for voting, across
  // all apps — PR proposals (their promoted/merging sessions) plus their
  // open governance (secret_change) proposals. Backs the home screen's
  // "Your proposals" section. Like /api/me/active-sessions, no extra
  // visibility filter is needed: these are the viewer's own rows, so the
  // apps are by construction ones they can collaborate on.
  router.get('/api/me/proposals', async (req, res) => {
    try {
      const { rows: sessions } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.pr_title_fallback, cs.status,
                cs.created_at, cs.promoted_at,
                cs.merge_conflict_state, cs.behind_main,
                cs.check_state, cs.check_error_detail, cs.check_phase,
                cs.requires_explicit_approval,
                -- #866: so the home strip can derive the same
                -- building/unavailable preview state the proposal card
                -- shows (see staging.previewDisplayState below).
                cs.staging_url, cs.source,
                cs.imported_pr_head_sha, cs.reviewed_head_sha,
                a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                    AND ${currentVotePredicateSql('pv', 'cs')}) AS yes_count,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'no'
                    AND ${currentVotePredicateSql('pv', 'cs')}) AS no_count
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
         WHERE cs.user_id = $1 AND cs.status IN ('promoted', 'merging')
           AND cs.is_headless = FALSE
         ORDER BY cs.promoted_at DESC NULLS LAST, cs.created_at DESC`,
        [req.user.id]
      );

      const { rows: governance } = await pool.query(
        `SELECT i.id, i.title, i.kind, i.created_at,
                a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'up') AS up_count,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'down') AS down_count
         FROM issues i JOIN apps a ON a.id = i.app_id
         WHERE i.created_by = $1 AND i.kind = 'secret_change' AND i.status = 'open'
         ORDER BY i.created_at DESC`,
        [req.user.id]
      );

      // Per-app active-user majority (the denominator for the tally
      // pill). One getActiveUserStats call per distinct app, cached in
      // a map — most users have proposals on a handful of apps at most.
      // #646: plus the per-app governance settings + electorate, so the
      // gate matches the app's configured approval mode.
      const governanceSvc = require('../services/governance');
      const appIds = [...new Set([...sessions, ...governance].map((r) => r.app_id))];
      const statsByApp = {};
      const govByApp = {};
      const electorateByApp = {};
      for (const appId of appIds) {
        statsByApp[appId] = await getActiveUserStats(pool, appId);
        govByApp[appId] = await governanceSvc.getGovernance(pool, appId);
        electorateByApp[appId] = await governanceSvc.getElectorate(pool, appId, govByApp[appId]);
      }

      const proposals = [];
      for (const s of sessions) {
        const gov = govByApp[s.app_id];
        const electorate = electorateByApp[s.app_id];
        const q = electorate?.approverIds
          ? await governanceSvc.qualifiedCounts(
            pool, 'pr', s.id, electorate.approverIds, reviewedHeadForSession(s)
          )
          : { yes: s.yes_count, no: s.no_count };
        // Per-row dynamic merge gate + rejection countdown, mirroring
        // /api/apps/:slug/promoted (same anchor: promoted_at || created_at).
        // #788: the stamped flag rides on the row (added to this
        // endpoint's SELECT), so the no-timer modifier applies here
        // without a per-row GitHub call.
        const gate = governanceSvc.computeGate(
          gov, electorate?.active || 1, q.yes, q.no, s.promoted_at || s.created_at, null,
          { explicitApproval: !!s.requires_explicit_approval }
        );
        proposals.push({
          ...s,
          ...require('../services/staging').previewDisplayState(s),
          majority: statsByApp[s.app_id]?.majority || 1,
          activeUsers: statsByApp[s.app_id]?.active || 1,
          votes_required: gate.required,
          merge_window_ends_at: gate.windowEndsAt,
          contested: gate.contested,
          reject_window_ends_at: gate.rejectionEndsAt,
          rejection_armed: gate.rejectionArmed,
          approval_policy: gate.policy,
          approvals_required: gate.approvalsRequired,
          requires_explicit_approval: !!s.requires_explicit_approval,
          qualified_yes_count: gate.qualifiedYes,
          qualified_no_count: gate.qualifiedNo,
        });
      }

      // #405: staging-only demo rows (?demo=1) so the home "Your proposals"
      // strip's canonical merge-lifecycle chips — In vote, Behind, Resolving
      // conflicts…, Checks running…, Passed — merging shortly, Merging… — are
      // all reviewable against a prod-cloned DB. Reuses the same fixtures the
      // proposal feed uses (stagingMockProposals), mapped into this endpoint's
      // shape with a fixed demo majority of 3 so the tally-dependent states
      // (in-vote vs. ready) resolve deterministically regardless of the
      // staging app's live active-user count. Gated on IS_STAGING — a no-op
      // in production.
      if (IS_STAGING && req.query.demo === '1') {
        const have = new Set(proposals.map((p) => p.id));
        const DEMO_MAJORITY = 3;
        const demoRows = stagingMockProposals()
          .filter((m) => (m.status === 'promoted' || m.status === 'merging') && !have.has(m.id))
          .map((m) => ({
            id: m.id,
            pr_number: m.pr_number,
            pr_url: m.pr_url,
            pr_title: m.pr_title,
            status: m.status,
            created_at: m.created_at,
            promoted_at: m.promoted_at,
            merge_conflict_state: m.merge_conflict_state || null,
            behind_main: m.behind_main || 0,
            check_state: m.check_state || null,
            test_results: m.test_results || [],
            checks_checked_at: m.checks_checked_at || null,
            // #866: carry the mock preview state through so the imported-PR
            // fixtures read the same on the home strip as on the card.
            source: m.source || null,
            staging_url: m.staging_url || null,
            staging_building: !!m.staging_building,
            staging_error: m.staging_error || null,
            // #447: demo-only hint that renders the "Re-run checks" button
            // for any ?demo=1 viewer (real rows gate on owner/admin instead).
            recheckable: m.recheckable || false,
            resolving: m.resolving || false,
            app_id: 0,
            app_slug: 'staging-demo',
            app_name: 'Staging demo app',
            yes_count: m.yes_count,
            no_count: m.no_count,
            majority: DEMO_MAJORITY,
            activeUsers: DEMO_MAJORITY,
          }));
        proposals.push(...demoRows);
      }

      const governanceRows = [];
      for (const g of governance) {
        const gov = govByApp[g.app_id];
        const electorate = electorateByApp[g.app_id];
        const q = electorate?.approverIds
          ? await governanceSvc.qualifiedCounts(pool, 'issue', g.id, electorate.approverIds)
          : { yes: g.up_count, no: g.down_count };
        // Governance proposals have no promote step — created_at is the
        // visibility-window anchor. down votes feed both gates.
        const gate = governanceSvc.computeGate(
          gov, electorate?.active || 1, q.yes, q.no, g.created_at
        );
        governanceRows.push({
          ...g,
          majority: statsByApp[g.app_id]?.majority || 1,
          activeUsers: statsByApp[g.app_id]?.active || 1,
          votes_required: gate.required,
          merge_window_ends_at: gate.windowEndsAt,
          contested: gate.contested,
          approval_policy: gate.policy,
          approvals_required: gate.approvalsRequired,
          // #695: qualifying tallies, matching the PR rows above, so the
          // home strip pill counts approver votes only on invited apps.
          qualified_yes_count: gate.qualifiedYes,
          qualified_no_count: gate.qualifiedNo,
        });
      }

      res.json({
        proposals,
        governance: governanceRows,
      });
    } catch (err) {
      log.error('votes', 'Failed to list my proposals', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List promoted sessions (for the vote panel in group chat).
  // View-level (#621): read-only viewers see proposals + tallies;
  // voting itself stays collab-gated on POST /api/sessions/:id/vote.
  router.get('/api/apps/:slug/promoted', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, locked`
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });
      const appRows = [gatedApp];

      const userId = req.user?.id || null;
      // Include 'merging' alongside 'promoted' so the PR stays visible
      // during the GitHub merge + prod rebuild + staging teardown
      // pipeline (~30s). Otherwise the card disappears the instant the
      // majority threshold is crossed and only reappears in the "merged"
      // list at the very end, making it look like the vote was lost.
      const { rows } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.pr_title_fallback, cs.pr_summary_md, cs.staging_url, cs.testing_md, cs.testing_path, cs.user_id, cs.status, cs.linked_issues, u.username, cs.created_at,
           -- #687 (PR-import): provenance so the client can render the
           -- "Imported PR" badge + GitHub-maintained note and hide the
           -- dev-side controls for externally-authored proposals.
           cs.source, cs.imported_pr_author, cs.imported_pr_head_sha,
           cs.reviewed_head_sha,
           -- #967: which external coding agent wrote it, when the proposal
           -- came in through the hosted MCP connector ('claude-code' |
           -- 'codex' | 'external'). NULL for everything else. Drives the
           -- "built with …" chip beside the imported badge.
           cs.external_agent,
           -- #361: persisted merge-conflict snapshot for the card badge +
           -- detail block (state, conflicting file paths, last-checked).
           cs.merge_conflict_state, cs.behind_main, cs.conflict_files, cs.conflict_checked_at,
           -- #381: console-error check snapshot for the "may break the app"
           -- warning badge + detail block (advisory, never gates the vote).
           cs.console_check_state, cs.console_errors, cs.console_checked_at,
           -- #47: "CI for proposals" check snapshot for the checks badge +
           -- per-test detail block. Unlike the console snapshot this GATES
           -- merge (checkAndMerge blocks a non-'passing' proposal).
           cs.check_state, cs.test_results, cs.checks_checked_at,
           -- Which half of a 'pending' run is in flight ('building' |
           -- 'testing'), so the checks card names the stage instead of
           -- showing one opaque "still running". NULL = legacy wording.
           cs.check_phase,
           -- Platform-variables pre-merge check (display mirror; the merge
           -- gate re-evaluates live).
           cs.platform_env_state, cs.platform_env_detail,
           -- #237: captured reason when checks are 'error' (staging preview
           -- failed to boot) — drives the "Preview won't boot" badge tooltip.
           cs.check_error_detail,
           -- #788: does this proposal change dapp.json's admins block? A
           -- flagged row loses the time-based merge paths (the gate below
           -- reports no merge_window_ends_at, so no countdown renders) and
           -- shows the "Explicit approval" chip.
           cs.requires_explicit_approval,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'yes'
               AND ${currentVotePredicateSql('pv', 'cs')}) as yes_count,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'no'
               AND ${currentVotePredicateSql('pv', 'cs')}) as no_count,
           (SELECT pv.vote FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.user_id = $2
               AND ${currentVotePredicateSql('pv', 'cs')}) as my_vote,
           -- Kudos counts piggy-back on this query so the vote panel
           -- doesn't fan out to N extra round-trips per PR card. The
           -- (session_id, giver_user_id) UNIQUE constraint makes EXISTS
           -- a single-index probe; COUNT runs against the per-session
           -- index added in schema.sql.
           -- kudos_count folds in any issue bounties AWARDED to this PR on
           -- merge (a bounty resolves into kudos credit for the closing PR's
           -- author), so the count matches the leaderboards. my_kudos is
           -- likewise true if the viewer either gave a PR kudos OR pledged a
           -- bounty that was awarded to this PR. my_kudos_direct isolates
           -- the first source — only a direct pr_kudos row is retractable
           -- (DELETE /api/sessions/:id/kudos), so the FE needs to know
           -- which kind of credit it's rendering.
           ((SELECT COUNT(*)::int FROM pr_kudos WHERE session_id = cs.id)
             + (SELECT COUNT(*)::int FROM issue_bounties WHERE awarded_session_id = cs.id AND status = 'awarded')) as kudos_count,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)
                 OR EXISTS(SELECT 1 FROM issue_bounties WHERE awarded_session_id = cs.id AND status = 'awarded' AND giver_user_id = $2)) as my_kudos,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)) as my_kudos_direct,
           -- #11: revert_of_session_id is non-null on PRs that are
           -- themselves a git-revert of an earlier merged PR. The
           -- vote panel uses this to render a Revert label
           -- instead of the regular title so voters know what they
           -- are voting on.
           cs.revert_of_session_id,
           orig.pr_number as original_pr_number,
           orig.pr_title  as original_pr_title,
           -- #194: per-proposal thread message count for the chat badge,
           -- plus the latest thread-message timestamp for the forum
           -- feed's activity sort. The partial thread index makes these
           -- index-only probes per row. promoted_at is the proposal's own
           -- activity anchor (falls back to created_at client-side).
           -- chat_count counts human messages only (msg_type='message')
           -- so dual-posted lifecycle/vote system rows don't make the 💬
           -- badge claim a discussion that hasn't happened.
           cs.promoted_at,
           (SELECT COUNT(*)::int FROM chat_messages cm
             WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id
               AND cm.msg_type = 'message') as chat_count,
           (SELECT MAX(cm.created_at) FROM chat_messages cm
             WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id) as last_message_at,
           -- #195/#270: before/after capture artifacts, aggregated to one
           -- jsonb per row. Key is 'kind_index_media' ('before_0_png',
           -- 'after_1_webm', ...) so multiple captured routes
           -- (capture_index) don't collide; the value carries the artifact
           -- id plus the group label / frame / before-fallback flag so the
           -- vote-panel tiles render real path labels and the fell-back
           -- caption. Shaped into the grouped client form below via
           -- visuals.shapeAgg (which also still accepts the legacy
           -- 'kind_media' key and bare-id string values from older rows).
           (SELECT jsonb_object_agg(
                     sv.kind || '_' || sv.capture_index || '_' || sv.media,
                     jsonb_build_object(
                       'id', sv.id,
                       'path', sv.captured_path,
                       'viewport', sv.captured_viewport,
                       'fellBack', sv.before_fell_back))
              FROM session_visuals sv WHERE sv.session_id = cs.id) as visuals_agg
         FROM chat_sessions cs
         JOIN users u ON cs.user_id = u.id
         LEFT JOIN chat_sessions orig ON orig.id = cs.revert_of_session_id
         WHERE cs.app_id = $1 AND cs.status IN ('promoted', 'merging')
         ORDER BY cs.created_at DESC`,
        [appRows[0].id, userId]
      );

      const visualsService = require('../services/visuals');
      const stagingService = require('../services/staging');
      for (const row of rows) {
        row.visuals = visualsService.shapeAgg(row.visuals_agg);
        delete row.visuals_agg;
        // #866: three-state Preview affordance. An imported PR is promoted
        // before its preview finishes building, so `staging_url IS NULL`
        // alone can't tell "building" from "failed" — derive both here
        // (in-memory build map + the captured checks error) rather than
        // persisting a staging_state column that a crash could strand.
        Object.assign(row, stagingService.previewDisplayState(row));
        // #239: surface in-flight auto-conflict-resolution so the vote
        // panel can render a "Resolving conflicts…" badge. Process-local
        // map lookup (no SQL) — authoritative in the single-process
        // platform, and self-healing on every panel refresh.
        row.resolving = isResolving(row.id);
      }

      // Community-voted priority + assigned-person summary per proposal,
      // keyed by session id (target_type='proposal'). Same minimal shape
      // the issue feed attaches; the dropdown lazy-loads the full tally
      // from /api/apps/:slug/topics/proposal/:id/attributes.
      const promotedAttrs = await topicAttrs.summarizeForProposals(
        pool, appRows[0].id,
        rows.map((r) => ({ id: r.id, linked_issues: r.linked_issues })), userId
      );
      for (const row of rows) {
        const s = promotedAttrs.get(row.id) || topicAttrs.emptySummary();
        row.priority = s.priority;
        row.assignee = s.assignee;
        row.category = s.category;
      }

      // Staging-only demo mode (?demo=1): append long-title mock
      // proposals for layout verification. The id check keeps the
      // append idempotent should a mock id ever materialize in the
      // result. See stagingMockProposals above.
      if (IS_STAGING && req.query.demo === '1') {
        const have = new Set(rows.map((r) => r.id));
        rows.push(...stagingMockProposals(req.user?.username).filter((m) => !have.has(m.id)));
      }

      const { active: activeUsers, majority } = await getActiveUserStats(pool, appRows[0].id);
      // Whether the viewer themself counts as active for this app —
      // surfaced on the group-chat dashboard so they can see their
      // own status and (if not counted) understand what to do about
      // it. Cheap query (two EXISTS lookups), runs alongside the
      // existing active-stats query.
      const viewerActive = await isUserActive(pool, appRows[0].id, userId);

      // Per-row dynamic merge gate. The eased threshold and the visibility
      // window both depend on this row's own yes/no counts and open time, so
      // they can't be a single app-level number. Mock rows (?demo=1) already
      // carry precomputed values that bypass the live `active` lookup — leave
      // those untouched.
      //
      // #646: governance-aware. Under the default settings this is the
      // old per-row mergeGate over the raw tallies; under
      // approver_policy='invited' the qualifying counts (approver votes
      // only) are batch-fetched in one query and the electorate is the
      // approver roster; under approvals_required=N the gate is the
      // clock-free "at least N" check. Every live row also carries
      // approval_policy / approvals_required / qualified_* so the vote
      // pill + help text can describe the configured mode.
      const governance = require('../services/governance');
      const gov = await governance.getGovernance(pool, appRows[0].id);
      const electorate = await governance.getElectorate(pool, appRows[0].id, gov);
      let qualifiedByRow = null;
      if (electorate.approverIds) {
        qualifiedByRow = await governance.qualifiedCountsBatch(
          pool, 'pr',
          rows.filter((r) => r.votes_required == null).map((r) => r.id),
          electorate.approverIds
        );
      }
      for (const row of rows) {
        if (row.votes_required != null) continue;
        const q = qualifiedByRow
          ? (qualifiedByRow.get(row.id) || { yes: 0, no: 0 })
          : { yes: row.yes_count, no: row.no_count };
        // #788: the stamped flag rides on the row (chat_sessions.* is
        // selected here), so the no-timer modifier applies with no extra
        // per-row work — a flagged row simply reports no
        // merge_window_ends_at and never renders a countdown.
        const gate = governance.computeGate(
          gov, electorate.active, q.yes, q.no,
          row.promoted_at || row.created_at, null,
          { explicitApproval: !!row.requires_explicit_approval }
        );
        row.votes_required = gate.required;
        row.merge_window_ends_at = gate.windowEndsAt;
        row.contested = gate.contested;
        row.reject_window_ends_at = gate.rejectionEndsAt;
        row.rejection_armed = gate.rejectionArmed;
        row.approval_policy = gate.policy;
        row.approvals_required = gate.approvalsRequired;
        row.requires_explicit_approval = !!row.requires_explicit_approval;
        row.qualified_yes_count = gate.qualifiedYes;
        row.qualified_no_count = gate.qualifiedNo;
      }

      res.json({
        promoted: rows,
        activeUsers,
        majority,
        viewerActive,
        // Surfaced so the vote panel can render the "(locked — also
        // needs an admin yes)" hint on the Open PRs / Rename proposals
        // sections without a second round-trip. See loadVotePanel in
        // public/js/app-view.js.
        locked: !!appRows[0].locked,
        // #646: the app's configured approval settings, for the vote
        // panel context (_proposalsCtx in public/js/app-view.js).
        approverPolicy: gov.approverPolicy,
        approvalsRequired: gov.approvalsRequired,
        // #788: whether the viewer is one of this app's declared admins,
        // so the vote panel can render the "Admin merge" affordance for
        // them without a second round-trip. Server-side gates re-check.
        isAppAdmin: await appAdmins.isAppAdmin(pool, appRows[0].id, req.user?.id),
      });
    } catch (err) {
      log.error('votes', 'Failed to list promoted', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List merged sessions. View-level (#621) — read-only history.
  router.get('/api/apps/:slug/merged', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });
      const appRows = [gatedApp];

      const userId = req.user?.id || null;

      // #429: keyset pagination so the Completed list can reach every
      // merged PR, not just the most-recent page. `limit` defaults to 20
      // (the historical cap) and is clamped to 50. `before` + `before_id`
      // form the cursor — the (created_at, id) of the last row the client
      // already has — and we page strictly older than it. Keyset (not
      // OFFSET) because new merges insert at the top and would otherwise
      // drift the offset. created_at isn't unique, so id is the tiebreaker.
      //
      // The stream now interleaves TWO row types (merged PR sessions and
      // applied close-issue proposals — see below), whose ids come from
      // independent sequences, so the cursor carries a third part:
      // `before_type` ('pr' | 'close_issue', defaulting to 'pr' so older
      // clients keep paging PRs exactly as before). Global order is
      // (created_at DESC, type-rank DESC, id DESC) with rank pr=1 >
      // close_issue=0 — see completedRowCompare.
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 20;
      if (limit > 50) limit = 50;
      const beforeRaw = req.query.before;
      const beforeIdRaw = parseInt(req.query.before_id, 10);
      const before = new Date(beforeRaw);
      // A cursor only applies when BOTH parts parse cleanly; otherwise we
      // ignore it and return the newest page (defensive against malformed
      // query strings).
      const hasCursor = beforeRaw != null && !Number.isNaN(before.getTime())
        && Number.isFinite(beforeIdRaw);
      const isFirstPage = !hasCursor;
      const beforeType = req.query.before_type === 'close_issue' ? 'close_issue' : 'pr';

      // Same kudos subqueries as /promoted so the merged card can show
      // its count + per-viewer "you gave kudos" state without a second
      // round-trip per row. cs.user_id is also surfaced so the FE
      // kudos button can disable itself client-side for self-PRs
      // (server still 403s as authority).
      //
      // #11/#16: surfaces the revert-session metadata (pr_number, status)
      // when one exists — so the UI can render "Undone by PR #N" /
      // "Revert in vote (PR #N)" labels without a per-row round-trip.
      // (Undo is now a single direct action that opens a revert PR, so
      // there are no separate undo-vote tallies to surface.)
      //
      // Per-source keyset predicates against the mixed-type cursor:
      // a cursor sitting on a PR row (rank 1) keeps the historical tuple
      // comparison for PRs; when it sits on a close-issue row (rank 0),
      // every PR at that same timestamp already sorted BEFORE it, so PRs
      // page strictly older (<). The close-issue query mirrors this: at a
      // PR cursor, close rows at the same timestamp sort AFTER it, so
      // they page <= ; at a close cursor they use their own tuple.
      const prCursorSql = !hasCursor ? ''
        : beforeType === 'pr'
          ? 'AND (cs.created_at, cs.id) < ($3, $4)'
          : 'AND cs.created_at < $3';
      const prParams = !hasCursor
        ? [appRows[0].id, userId, limit + 1]
        : beforeType === 'pr'
          ? [appRows[0].id, userId, before.toISOString(), beforeIdRaw, limit + 1]
          : [appRows[0].id, userId, before.toISOString(), limit + 1];
      const { rows: prRows } = await pool.query(
        `${mergedRowSelect()}
         WHERE cs.app_id = $1 AND cs.status = 'merged'
           ${prCursorSql}
         ORDER BY cs.created_at DESC, cs.id DESC
         LIMIT $${prParams.length}`,
        // Fetch limit+1 so an extra row signals there's another page.
        prParams
      );

      // Applied close-issue proposals join the Completed stream: a
      // kind='close_issue' governance row whose vote (or an admin
      // force-apply) actually closed the target carries payload.appliedAt
      // (see maybeApplyCloseIssueProposal). Withdrawn (withdrawnAt) and
      // superseded (supersededAt) rows never carry it, so they stay out.
      // chat_count / last_message_at mirror the open-issues endpoint's
      // governance-thread subqueries so the 💬 badge and activity sort
      // behave identically.
      const closeCursorSql = !hasCursor ? ''
        : beforeType === 'close_issue'
          ? 'AND (i.created_at, i.id) < ($2, $3)'
          : 'AND i.created_at <= $2';
      const closeParams = !hasCursor
        ? [appRows[0].id, limit + 1]
        : beforeType === 'close_issue'
          ? [appRows[0].id, before.toISOString(), beforeIdRaw, limit + 1]
          : [appRows[0].id, before.toISOString(), limit + 1];
      const { rows: closeRows } = await pool.query(
        `SELECT i.id, i.kind, i.title, i.description, i.payload, i.status,
                i.github_issue_number, i.created_by, i.created_at,
                u.username AS created_by_username,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'up') AS up_count,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'down') AS down_count,
                (SELECT COUNT(*)::int FROM chat_messages cm
                  WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id
                    AND cm.msg_type = 'message') AS chat_count,
                (SELECT MAX(cm.created_at) FROM chat_messages cm
                  WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id) AS last_message_at
           FROM issues i
           LEFT JOIN users u ON i.created_by = u.id
          WHERE i.app_id = $1 AND i.kind = 'close_issue' AND i.status = 'closed'
            AND i.payload ? 'appliedAt'
            ${closeCursorSql}
          ORDER BY i.created_at DESC, i.id DESC
          LIMIT $${closeParams.length}`,
        closeParams
      );

      // Merge-sort the two already-sorted sources into one page. Each
      // source fetched limit+1, so the page can never need a row beyond
      // what was fetched; anything left over means another page exists.
      // With a single populated source, keep the DB's ordering verbatim
      // (byte-identical to the pre-close-issue behaviour for PR-only apps).
      const combined = prRows.map((r) => ({ ...r, row_type: 'pr' }))
        .concat(closeRows.map((r) => ({ ...r, row_type: 'close_issue' })));
      if (prRows.length && closeRows.length) combined.sort(completedRowCompare);
      let hasMore = combined.length > limit;
      const rows = combined.slice(0, limit);

      // #433: the Kanban "Done" column header counts merged tasks, but the
      // board only loads the first page (default 20), so its count was
      // pinned at 20 on any app with ≥20 merges. Return the true column
      // total — a cheap COUNT over the same base set the paged query draws
      // from (status='merged' for this app), with NO cursor predicate (the
      // total is the whole column, not the remaining page) and WITHOUT the
      // revert LEFT JOIN (which can multiply rows). Indexed on (app_id,
      // status), so this is far lighter than the per-row subqueries above.
      const { rows: totalRows } = await pool.query(
        `SELECT COUNT(*)::int AS total
           FROM chat_sessions
          WHERE app_id = $1 AND status = 'merged'`,
        [appRows[0].id]
      );
      // Applied close-issue proposals count toward the same Done total —
      // they render in the column. Distinct alias (close_total) so test
      // stubs keyed on the PR count's SQL never double-answer.
      const { rows: closeTotalRows } = await pool.query(
        `SELECT COUNT(*)::int AS close_total
           FROM issues
          WHERE app_id = $1 AND kind = 'close_issue' AND status = 'closed'
            AND payload ? 'appliedAt'`,
        [appRows[0].id]
      );
      let total = (totalRows[0]?.total || 0) + (closeTotalRows[0]?.close_total || 0);

      // Same priority + assigned-person summary on completed proposals, so
      // the read-only chips stay visible after a PR merges. PR rows only —
      // close-issue rows deliberately carry no priority/assignee chips.
      const prPageRows = rows.filter((r) => r.row_type !== 'close_issue');
      const mergedAttrs = await topicAttrs.summarizeForProposals(
        pool, appRows[0].id,
        prPageRows.map((r) => ({ id: r.id, linked_issues: r.linked_issues })), userId
      );
      for (const row of prPageRows) {
        const s = mergedAttrs.get(row.id) || topicAttrs.emptySummary();
        row.priority = s.priority;
        row.assignee = s.assignee;
        row.category = s.category;
      }

      // Staging-only demo mode (?demo=1): prepend mock merged rows so the
      // clickable Completed list + 💬 badge + "Load more" pager are
      // verifiable against a prod-cloned DB. Idempotent by id. The mock
      // rows are gated to the FIRST page only (no cursor) — there are
      // enough of them (#429) to fill a page and force hasMore=true, so a
      // tester can exercise "Load more" without depending on real merged
      // history. See stagingMockMerged above.
      if (IS_STAGING && req.query.demo === '1' && isFirstPage) {
        // De-dup by (type, id) — the two row types draw ids from
        // independent sequences, so a bare id isn't unique in the stream.
        const key = (r) => `${r.row_type || 'pr'}:${r.id}`;
        const have = new Set(rows.map(key));
        const injected = stagingMockMerged().map((m) => ({ ...m, row_type: 'pr' }))
          .concat(stagingMockCompletedCloseIssues())
          .filter((m) => !have.has(key(m)));
        rows.unshift(...injected);
        // Re-sort so the mock close-issue rows interleave among the mock
        // merged PRs by date instead of clumping at the top.
        rows.sort(completedRowCompare);
        if (rows.length > limit) {
          hasMore = true;
          rows.length = limit;
        }
        // The COUNT(*) above can't see the mock rows (they aren't in the
        // DB), so bump the total by however many we injected to keep the
        // demo badge self-consistent with the rows the board renders.
        total += injected.length;
      }

      res.json({ merged: rows, hasMore, total });
    } catch (err) {
      log.error('votes', 'Failed to list merged', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Single-proposal-by-id fetch — the recovery path for opening a
  // proposal whose row isn't in the client's cached lists. The Completed
  // list is keyset-paginated (only the first page lives in client state),
  // so clicking / deep-linking a merged proposal beyond that page would
  // otherwise resolve to nothing and bounce back to the dev forum. The FE
  // (_fetchProposalById) calls this when _findTopicItem() comes up empty.
  //
  // Collab-gated (same as /merged and /promoted) and returns the SAME
  // merged-shaped row via the shared mergedRowSelect() fragment, so the
  // topic header/card renders identically whether the row came from the
  // list or from here. Accepts promoted / merging / merged so a proposal
  // that transitioned status between list-render and click still resolves
  // (active rows are normally fully cached, but this stays robust).
  router.get('/api/apps/:slug/proposals/:id', async (req, res) => {
    try {
      // View-level (#621): read-only viewers can open a proposal's
      // topic view (my_vote resolves to null for them).
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });

      const userId = req.user?.id || null;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(404).json({ error: 'Proposal not found' });

      const { rows } = await pool.query(
        `${mergedRowSelect()}
         WHERE cs.app_id = $1 AND cs.id = $3
           AND cs.status IN ('promoted', 'merging', 'merged')
         LIMIT 1`,
        [gatedApp.id, userId, id]
      );

      let proposal = rows[0] || null;
      if (proposal) {
        // Same read-only priority + assigned-person chips the list rows carry.
        const attrs = await topicAttrs.summarizeForProposals(
          pool, gatedApp.id,
          [{ id: proposal.id, linked_issues: proposal.linked_issues }], userId
        );
        const s = attrs.get(proposal.id) || topicAttrs.emptySummary();
        proposal.priority = s.priority;
        proposal.assignee = s.assignee;
        proposal.category = s.category;
      }

      // Staging demo mode (?demo=1): the mock merged/promoted rows aren't in
      // the DB, so resolve a mock id straight from the generators. This lets
      // a staging tester deep-link a mock Completed proposal that never
      // reached the first page (ids ~9100021+) and confirm it opens on
      // demand. Strictly a no-op in production (gated on IS_STAGING).
      if (!proposal && IS_STAGING && req.query.demo === '1') {
        proposal = stagingMockMerged().find((m) => m.id === id)
          || stagingMockProposals().find((m) => m.id === id)
          || null;
      }

      if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
      res.json({ proposal });
    } catch (err) {
      log.error('votes', 'Failed to get proposal by id', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── #11/#16: undo a merged PR by opening a revert PR ───────────────
  //
  // Undo is symmetric with proposing a forward change: a single click
  // opens a revert PR (clone repo, `git revert <merge_sha>`, push, open
  // PR), inserted as a `promoted` session, which then goes through the
  // SAME merge vote as any other PR. There is no separate "undo vote"
  // gate anymore (#16) — previously undo was double-gated (a majority to
  // open the revert, then a second majority to merge it), which was
  // confusing and redundant. The merge vote on the revert PR is now the
  // single checkpoint, mirroring the forward propose→vote flow.
  //
  // The caller becomes the revert session's owner (user_id) so they
  // "own" the resulting PR for chat / status purposes.
  router.post('/api/sessions/:id/undo', async (req, res) => {
    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.id as app_id, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status = 'merged'`,
        [req.params.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Merged session not found' });
      const session = sessionRows[0];

      // Reverting a secret-declaration PR changes credential configuration
      // through an otherwise-generic session endpoint.
      if (isCliCredentialManagementSession(req, session)) {
        return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
      }

      // Revert PRs are not themselves undoable — would create an endless
      // undo-undo-undo loop. The button is hidden on the client already;
      // this is the server-side enforcement.
      if (session.revert_of_session_id) {
        return res.status(409).json({ error: 'Cannot undo a revert PR' });
      }

      // Block if a revert is already in flight or landed for this merge.
      const { rows: existingRevert } = await pool.query(
        `SELECT id, status, pr_number, pr_url FROM chat_sessions
         WHERE revert_of_session_id = $1 AND status IN ('promoted', 'merging', 'merged')
         ORDER BY id DESC LIMIT 1`,
        [session.id]
      );
      if (existingRevert.length) {
        const rv = existingRevert[0];
        return res.status(409).json({
          error: `A revert PR for this merge already exists (status: ${rv.status})`,
          revertSessionId: rv.id,
          revertPrNumber: rv.pr_number,
          revertPrUrl: rv.pr_url,
        });
      }

      log.info('votes', 'Undo requested — opening revert PR', {
        sessionId: session.id, by: req.user.username,
      });
      // Respond immediately; the revert (clone + git revert + push + PR)
      // runs in the background and announces itself in group chat. The
      // vote panel refreshes via the pushVoteUpdate broadcast below.
      res.json({ ok: true, opening: true });

      const { pushVoteUpdate } = require('../services/ws');
      checkAndOpenRevert(config, pool, session, req.user)
        .then((result) => {
          if (result?.reverted) {
            pushVoteUpdate({
              sessionId: session.id,
              appSlug: session.app_slug,
              merged: false,
              kind: 'undo',
              revertSessionId: result.revertSessionId,
              revertPrNumber: result.revertPrNumber,
            });
          }
        })
        .catch((err) => {
          log.error('votes', 'Background revert failed', { sessionId: session.id, err: err.message });
        });
    } catch (err) {
      log.error('votes', 'Undo failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Admin force-merge ─────────────────────────────────────────────
  //
  // Admin-only escape hatch: merge a promoted PR right now, regardless
  // of vote tally or the locked-app admin-yes gate. Used when an admin
  // is confident the change should ship and doesn't want to wait for
  // the active-user majority. The frontend gates this behind a
  // ConfirmModal so a misclick can't accidentally bypass voting.
  //
  // The actual merge pipeline (atomic 'promoted → merging' claim,
  // GitHub merge, prod rebuild, staging teardown, broadcasts) is the
  // same `checkAndMerge` path the regular vote route uses — we just
  // pass `force: true` to skip the early gates. The chat message
  // distinguishes the override so users see who did it and why a PR
  // landed without the usual tally.
  router.post('/api/sessions/:id/admin-merge', drainGuard, async (req, res) => {
    try {
      // Cheap pre-gate, preserving the old 403-before-404 stance: a
      // caller who can't force-merge ANYWHERE never gets to probe
      // whether a session id exists. #788 widens this from
      // "platform admin" to "platform admin, or an app admin of at
      // least one app" — the per-app check follows once we know which
      // app the session belongs to.
      const adminAppIds = req.user?.canAdminWrite
        ? null
        : await appAdmins.getAdminAppIdsForUser(pool, req.user?.id);
      if (adminAppIds && adminAppIds.size === 0) {
        return res.status(403).json({ error: 'Full admin access required' });
      }

      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.id as app_id, a.repo_url,
                a.self_hosted as app_self_hosted, a.created_by as app_created_by
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status = 'promoted'`,
        [req.params.id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Promoted session not found' });
      }
      const session = rows[0];

      // #788: force-merge is no longer platform-admin-only — an app's
      // own declared admins may force-merge that app's proposals. The
      // one exception is a proposal that changes the admins block
      // itself: letting an app admin force-merge that would be
      // unilateral self-escalation, so it stays platform-admin-only.
      const explicitApproval = !!session.requires_explicit_approval;
      const appForGate = { id: session.app_id, created_by: session.app_created_by };
      if (!(await appAdmins.canForceMerge(pool, appForGate, req.user, { explicitApproval }))) {
        if (explicitApproval && await appAdmins.isAppAdmin(pool, session.app_id, req.user?.id)) {
          return res.status(403).json({
            error: "This proposal changes the app's admins, so it needs explicit approval — only a platform admin can force-merge it",
          });
        }
        return res.status(403).json({ error: 'Full admin access required' });
      }

      // Force-merging this platform-created proposal would apply its held
      // credential value. Keep ordinary admin merges available to the CLI.
      if (isCliCredentialManagementSession(req, session)) {
        return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
      }

      // Respond immediately; the merge itself runs in the background
      // exactly like the regular vote-driven path. Clients refresh via
      // the `pushVoteUpdate` broadcasts emitted by checkAndMerge.
      log.info('votes', 'Admin force-merge requested', {
        sessionId: session.id, by: req.user.username,
      });
      res.json({ ok: true, queued: true });

      checkAndMerge(config, pool, session, { force: true, forceBy: req.user })
        .then((mergeResult) => {
          if (mergeResult?.merged) {
            const { pushVoteUpdate } = require('../services/ws');
            pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: true });
          }
        })
        .catch((err) => {
          log.error('votes', 'Admin force-merge failed', {
            sessionId: session.id, err: err.message,
          });
        });
    } catch (err) {
      log.error('votes', 'Admin force-merge route failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// `options.force` (admin force-merge): skip the vote-count, locked-app
// admin-yes, and behind_main gates entirely and proceed straight to the
// claim+merge pipeline. The atomic `promoted → merging` claim still
// races against any concurrent vote-driven merge, so we won't double-
// merge. `options.forceBy` is the admin user object (id, username) used
// for the "merged by <admin> overriding vote" chat message.
// Resolve open issue bounties for a single closed issue when a PR merges.
//
// A bounty pledged via the Open Issues panel ("Give kudos") flips 'open' →
// 'awarded' and credits the merged PR's author — EXCEPT a bounty whose
// pledger IS that author, which would be self-kudos (the same thing the
// direct PR-kudos give path refuses with a 403; see routes/kudos.js). The
// awardee isn't known until merge, so the self-check lives here: self-pledged
// rows are 'voided' instead — not left 'open', because the issue is now
// closed on GitHub and no later PR will close it again, so an open row would
// linger forever and keep inflating the issue's open-bounty count. Voided
// rows keep awarded_session_id/awarded_at for audit but no awarded_user_id,
// so they earn no leaderboard credit. The pledger's weekly allowance slot is
// still forfeited (no refund) — every pledged bounty consumes a slot.
//
// `IS DISTINCT FROM` keeps a NULL giver (deleted pledger) and a NULL awardee
// (deleted PR author) on the award path. Self-voiding only runs when the PR
// has an author. Returns { awarded, voided } id arrays. Extracted from
// checkAndMerge so the self-bounty guard is unit-testable without driving the
// whole merge pipeline.
async function resolveIssueBounty(pool, { appId, sessionId, awardeeUserId, issueNumber }) {
  const { rows: awarded } = await pool.query(
    `UPDATE issue_bounties
        SET status = 'awarded',
            awarded_session_id = $1,
            awarded_user_id = $2,
            awarded_at = NOW()
      WHERE app_id = $3 AND github_issue_number = $4 AND status = 'open'
        AND giver_user_id IS DISTINCT FROM $2
      RETURNING id`,
    [sessionId, awardeeUserId || null, appId, issueNumber]
  );

  let voided = [];
  if (awardeeUserId) {
    const { rows } = await pool.query(
      `UPDATE issue_bounties
          SET status = 'voided',
              awarded_session_id = $1,
              awarded_at = NOW()
        WHERE app_id = $2 AND github_issue_number = $3 AND status = 'open'
          AND giver_user_id = $4
        RETURNING id`,
      [sessionId, appId, issueNumber, awardeeUserId]
    );
    voided = rows;
  }

  return { awarded, voided };
}

// #687 Slice 4: shared post-merge finalizer. Everything AFTER the
// irreversible github.mergePR call — rebuild production (unless self-hosted),
// stamp apps.main_sha/main_pr_number/last_deploy_at, broadcast
// app_version_changed, teardown staging, pay out bounties, refresh issues,
// transition the session to 'merged', and announce it — factored out so that
// NATIVE and IMPORTED merges run byte-for-byte the same tail. Called from
// inside checkAndMerge's try, so a throw here still lands in that catch, which
// honours the `githubMerged` guard (never roll a GitHub-merged PR back to
// 'promoted') and the merge-debug tracing. Only ever leaves the row in
// 'merged' — a state recoverStuckMerges already understands.
async function finalizeMerge({ config, pool, session, mergeCommitSha, required, activeCount, yesCount, majority, force, forceBy, dstep, dend }) {
    // Rebuild production
    const { rows: appRows } = await pool.query('SELECT * FROM apps WHERE id = $1', [session.app_id]);
    const app = appRows[0];

    // Apply any values this proposal carried for the variables it
    // DECLARES (services/pending-secrets.js — the "+ New variable" panel
    // flow). BEFORE the rebuild, deliberately: a newly `required` child-app
    // secret whose value arrived with the proposal has to be in
    // `app_secrets` before mergeForDeploy() looks for it, or the merge
    // would park the app in `awaiting_secrets` over its own change.
    //
    // Best-effort: the GitHub merge has already happened and can't be
    // rolled back, so a failure here logs and lets the rest of the tail
    // run. The pending row stays claimed either way, and the panel shows
    // the key as unset — recoverable by setting it directly.
    if (app) {
      try {
        const pendingSecrets = require('../services/pending-secrets');
        const { applied } = await pendingSecrets.applyForSession(config, pool, session.id);
        for (const a of applied) {
          if (!a.hadValue) continue;
          dstep({
            phase: 'pending_secrets',
            message: `Applied the value declared with this proposal for ${a.key}.`,
            detail: { key: a.key, scope: a.scope, private: a.private },
          });
          // Say what actually happens next — the platform's env is
          // materialized by its own deploy, a child app's by the rebuild
          // that follows a few lines below.
          const msg = a.scope === 'platform'
            ? `Platform variable "${a.key}" was declared and set by this proposal; takes effect on the platform's next deploy.`
            : `Secret "${a.key}" was declared and set by this proposal; redeploying…`;
          await sendSystemMessage(pool, session.app_id, msg, 'system').catch(() => {});
          await sendSystemMessage(pool, session.app_id, msg, 'system',
            null, { type: 'session', ref: session.id }).catch(() => {});
          if (a.scope === 'platform') {
            events.record(pool, {
              type: events.EVENT_TYPES.PLATFORM_ENV_CHANGED,
              userId: a.userId,
              appId: session.app_id,
              metadata: {
                key: a.key, action: 'set', private: a.private,
                appliedBy: 'declaration-proposal',
              },
            });
          }
        }
      } catch (err) {
        log.error('votes', 'Pending secret-declaration apply failed', {
          sessionId: session.id, err: err.message,
        });
        dstep({
          phase: 'pending_secrets', level: 'warn',
          message: `Couldn't apply the value declared with this proposal: ${err.message}`,
        });
      }
    }

    if (app) {
      let sha = null;
      // SELF-HOSTING.md sub-step 2g (Guard B): for the self-app,
      // there's no platform-managed prod container to rebuild — the
      // host-side deployer (nudged below) rolls the harness through a
      // blue-green rollout when the merge lands on main. Skip
      // rebuildProduction entirely, but keep the app_version_changed
      // broadcast firing so the app's own commit pills refresh.
      // main_sha is refreshed by seedSelfApp() on the next boot, which
      // clients pick up via /api/version.
      if (!app.self_hosted) {
        dstep({ phase: 'prod_rebuild', message: 'Production rebuild started.' });
        const result = await staging.rebuildProduction(config, app);
        sha = result.sha;
        dstep({ phase: 'prod_rebuild', message: `Production rebuild finished${sha ? ` (deployed ${String(sha).slice(0, 9)})` : ''}.`, detail: { sha: sha || null } });
        // Also record the SHA + originating PR so the main app view can
        // show "live on <sha> · PR #<n>" (#21). pr_number comes from the
        // session we just merged; sha is what `rebuildProduction` cloned.
        await pool.query(
          `UPDATE apps SET container_id = $1, main_sha = $2, main_pr_number = $3,
                           last_deploy_at = NOW()
           WHERE id = $4`,
          [result.containerId, sha || null, session.pr_number || null, app.id]
        );
      } else {
        log.info('votes', 'Self-app PR merged; host deployer will roll the harness', {
          appId: app.id, prNumber: session.pr_number,
        });
        // Skip the deployer's ~2-min baseline poll: tell it main just
        // moved so it fetches within seconds. Best-effort by design —
        // if the nudge mount is missing (local dev, pre-deployer host)
        // the baseline poll still delivers the deploy.
        try {
          const { nudgeHostDeployer } = require('../services/deploy-nudge');
          nudgeHostDeployer({ sha: mergeCommitSha, prNumber: session.pr_number });
        } catch (_) { /* never fail a merge over a hint */ }
      }
      // Let every tab watching this app refresh its commit pill without
      // polling. The existing vote_update event already fires on merge
      // but is scoped to vote panel refreshes; a dedicated event keeps
      // the concerns separated and avoids over-broadcasting. Fires for
      // self-hosted too (sha=null): the platform's own row refreshes
      // from /api/version, which has no new SHA to report until the
      // blue-green rollout cuts over.
      try {
        const { broadcastGlobalScoped } = require('../services/ws');
        broadcastGlobalScoped({
          type: 'app_version_changed',
          appSlug: session.app_slug,
          sha: sha || null,
          prNumber: session.pr_number || null,
        }, { appId: session.app_id, appSlug: session.app_slug });
      } catch {}
    }

    // Teardown staging. #851: this is the path that produced the ten known
    // orphans — a swallowed removal failure while the session row was nulled
    // anyway. teardownStaging now reports a leak instead of hiding it, and the
    // trace says so rather than claiming a teardown that didn't happen. The
    // merge itself must not fail over a container that won't die: the row keeps
    // pointing at it and the stale-preview sweeper retries.
    const stagingTeardown = await staging.teardownStaging(session, app)
      .catch((err) => ({ removed: false, leaked: true, error: err.message }));
    if (stagingTeardown && stagingTeardown.leaked) {
      dstep({
        phase: 'staging_teardown',
        message: 'Staging container could not be removed — left for the stale-preview sweeper.',
      });
    } else {
      dstep({ phase: 'staging_teardown', message: 'Staging container torn down.' });
    }

    // #58: snapshot the vote threshold + active-user count in effect at
    // this merge, so the merged-PR pill shows the historical "yes / N"
    // instead of drifting with the live threshold. `required` is the eased
    // dynamic threshold (services/active-users.js → requiredVotes) actually
    // applied to this merge; activeCount comes from getActiveUserStats() at
    // the top of this function. The visibility window is intentionally NOT
    // snapshotted (a merged row just shows its historical count). COALESCE
    // keeps any earlier snapshot (defensive; the promoted→merging claim
    // already guarantees a single merge transition).
    await pool.query(
      `UPDATE chat_sessions SET status = 'merged', merged_at = NOW(),
                                merge_commit_sha = COALESCE($2, merge_commit_sha),
                                votes_required = COALESCE(votes_required, $3),
                                active_users_at_merge = COALESCE(active_users_at_merge, $4)
       WHERE id = $1`,
      [session.id, mergeCommitSha, required, activeCount]
    );

    // pr_merged is the terminal stage of the PR-promotion funnel and the
    // signal behind the "merges over time" growth chart (now exact thanks
    // to merged_at above). Attributed to the PR author (session.user_id),
    // which may be NULL if the author was deleted.
    events.record(pool, {
      type: events.EVENT_TYPES.PR_MERGED,
      userId: session.user_id || null,
      appId: session.app_id,
      sessionId: session.id,
      metadata: {
        prNumber: session.pr_number || null,
        forced: !!force,
        ...(force && forceBy ? { forcedBy: forceBy.username } : {}),
      },
    });

    // Resolve any open issue bounties for the issues this PR closes (declared
    // through the session's linked_issues → `Closes #N` in the PR body).
    // Bounties pledged by OTHER users flip 'open' → 'awarded' and credit this
    // PR's author; a bounty the author pledged on their own resolved issue is
    // 'voided' instead (self-kudos guard — see resolveIssueBounty). Idempotent
    // (only status='open' rows transition, so a later PR closing the same
    // issue finds none) and best-effort — a failure here must never roll back
    // or fail the merge, same as the CC volume teardown below.
    try {
      const linked = Array.isArray(session.linked_issues) ? session.linked_issues : [];
      const seen = new Set();
      for (const raw of linked) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
        seen.add(n);
        const { awarded, voided } = await resolveIssueBounty(pool, {
          appId: session.app_id,
          sessionId: session.id,
          awardeeUserId: session.user_id || null,
          issueNumber: n,
        });
        if (voided.length) {
          log.info('votes', 'Self-bounty voided on merge', {
            sessionId: session.id, issueNumber: n, count: voided.length,
          });
        }
        // Only announce / record genuine awards; a purely self-voided issue
        // produces no "awarded" chat noise or event.
        if (!awarded.length) continue;
        events.record(pool, {
          type: events.EVENT_TYPES.BOUNTY_AWARDED,
          userId: session.user_id || null,
          appId: session.app_id,
          sessionId: session.id,
          metadata: { issueNumber: n, prNumber: session.pr_number || null, count: awarded.length },
        });
        const recipient = session.user_id ? `<@${session.user_id}>` : 'the author';
        const bountyMsg = `Bounty on issue #${n} (${awarded.length} kudos) awarded to ${recipient} — PR #${session.pr_number || session.id} merged`;
        await sendSystemMessage(pool, session.app_id, bountyMsg, 'system').catch(() => {});
        // Dual-post into the proposal's thread (lifecycle in context).
        await sendSystemMessage(pool, session.app_id, bountyMsg, 'system',
          null, { type: 'session', ref: session.id }).catch(() => {});
      }
    } catch (err) {
      log.warn('votes', 'Bounty payout failed', { sessionId: session.id, err: err.message });
    }

    // Keep the "Open Issues" panel honest. A merged PR carrying `Closes #N`
    // has just closed those issues on GitHub, but the panel reads
    // github.fetchPublicIssues (cached, state=open) and nothing else learns
    // the issue closed — so without this the closed issue lingers until the
    // cache TTL expires AND something separately triggers a panel reload.
    // Bust this repo's open-issues cache and broadcast a refresh so every
    // client viewing the app's group chat refetches (App.handleIssueUpdate →
    // AppView.loadVotePanel). Use the same repo_url regex as parseOwnerRepo
    // (routes/issues.js) so the invalidated key matches the cached one.
    // Best-effort and post-merge — a failure here must never fail the merge.
    try {
      const [, ghOwner, ghRepo] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (ghOwner && ghRepo) {
        // #144: record the linked issues as closed BEFORE busting the
        // cache + broadcasting. GitHub's auto-close is async and its
        // anonymous list endpoint lags even further, so the refetch this
        // broadcast triggers can read the issues as still open and
        // re-cache them — the suppression list makes fetchPublicIssues
        // drop them no matter what the list says. Optimistic on purpose:
        // GitHub closes `Closes #N` reliably (just late), and the
        // suppression TTL self-heals the rare case where it doesn't.
        const { sanitizeIssueNumbers } = require('../services/pr-metadata');
        const closedNumbers = sanitizeIssueNumbers(session.linked_issues);
        if (closedNumbers.length) github.noteIssuesClosed(ghOwner, ghRepo, closedNumbers);
        // Auto-resolve any open close-issue proposals targeting the issues
        // this merge closes — their vote is moot now. Same optimism as the
        // suppression above (GitHub closes `Closes #N` reliably, just
        // late); the watcher hook below catches hand-edited `Closes #N`
        // beyond linked_issues. Lazy require to avoid an import cycle;
        // fired-and-forgotten so a failure never fails the merge.
        if (closedNumbers.length) {
          try {
            const { resolveSupersededCloseProposals } = require('./issues');
            resolveSupersededCloseProposals(pool, {
              appId: session.app_id,
              appSlug: session.app_slug,
              numbers: closedNumbers,
              cause: { kind: 'pr-merge', prNumber: session.pr_number || session.id },
            }).catch((err) => log.warn('votes', 'Superseded close-proposal resolve failed', {
              sessionId: session.id, err: err.message,
            }));
          } catch (err) {
            log.warn('votes', 'Superseded close-proposal resolve setup failed', {
              sessionId: session.id, err: err.message,
            });
          }
        }
        github.invalidateIssuesCache(ghOwner, ghRepo);
        const { pushIssueUpdate } = require('../services/ws');
        pushIssueUpdate({
          action: 'github_synced',
          appSlug: session.app_slug,
          appId: session.app_id,
          source: 'pr_merged',
        });
      }
    } catch (err) {
      log.warn('votes', 'Open-issues refresh after merge failed', {
        sessionId: session.id, err: err.message,
      });
    }

    // #135: GitHub closes `Closes #N`-referenced issues itself, but a few
    // seconds AFTER the merge — so the cache bust + refetch above can race
    // it, re-caching the issue as open and leaving the group-chat panel
    // stale for the cache TTL. Watch the referenced issues (PR-body closing
    // keywords ∪ linked_issues) with retry/backoff until GitHub reports
    // them closed, then bust the cache and broadcast the refresh again.
    // Fired-and-forgotten — the polling must never slow down or fail the
    // merge flow, and nothing is ever written to GitHub.
    try {
      if (github.isEnabled() && session.pr_number) {
        const [, wOwner, wRepo] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
        if (wOwner && wRepo) {
          const { watchIssuesClosedAfterMerge } = require('../services/issue-close-watcher');
          watchIssuesClosedAfterMerge({
            owner: wOwner,
            repo: wRepo,
            prNumber: session.pr_number,
            linkedIssues: session.linked_issues,
            appSlug: session.app_slug,
            appId: session.app_id,
            // Lets the watcher auto-resolve close-issue proposals for the
            // numbers it observes closed (incl. hand-edited `Closes #N`).
            pool,
          }).catch((err) => {
            log.warn('votes', 'Post-merge issue-close watch failed', {
              sessionId: session.id, err: err.message,
            });
          });
        }
      }
    } catch (err) {
      log.warn('votes', 'Post-merge issue-close watch setup failed', {
        sessionId: session.id, err: err.message,
      });
    }

    // Chat session is done — no further turns will reference CC memory,
    // so drop the persistent `.claude` volume.
    try {
      const worker = require('../services/worker');
      await worker.destroyCcVolume(session.id);
    } catch (err) {
      log.warn('votes', 'Failed to destroy CC volume', { sessionId: session.id, err: err.message });
    }

    // Announce in group chat, and dual-post into the proposal's own
    // thread so its discussion carries the outcome in context.
    const mergedLabel = session.pr_title
      ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
      : `PR #${session.pr_number || session.id}`;
    const mergedSuffix = force && forceBy
      ? `force-merged by admin ${forceBy.username} (${yesCount}/${activeCount} vote${yesCount === 1 ? '' : 's'} at the time)`
      : `merged and deployed! (${yesCount}/${activeCount} votes)`;
    await sendSystemMessage(pool, session.app_id,
      `${mergedLabel} ${mergedSuffix}`,
      'system'
    );
    await sendSystemMessage(pool, session.app_id,
      `${mergedLabel} ${mergedSuffix}`,
      'system', null, { type: 'session', ref: session.id }
    ).catch(() => {});

    // Cascade: drain the next eligible promoted PR for this app. The
    // app-level drain serializes this with any vote-triggered resolves so
    // only one PR per app resolves+merges at a time. Exclude the session we
    // just merged so it's never re-picked.
    checkAndResolveConflicts(config, { app_id: session.app_id, excludeSessionId: session.id }).catch((err) => {
      log.error('votes', 'Conflict resolution check failed', { err: err.message });
    });

    dstep({ phase: 'merged', message: `Marked session merged${mergeCommitSha ? ` (commit ${String(mergeCommitSha).slice(0, 9)})` : ''}.`, detail: { sha: mergeCommitSha, yesCount, majority } });
    dend('merged', `Merged${force ? ` (force by ${forceBy?.username || 'admin'})` : ''}.`);
    return { merged: true };
}

async function checkAndMerge(config, pool, session, options = {}) {
  // `options.autoResolve` (default true): when a merge is blocked by a
  // conflict / behind-main, kick off the worker-based auto-resolver
  // (sync with main + retry). The resolver re-invokes checkAndMerge with
  // autoResolve:false so its own conflict paths don't re-trigger the
  // resolver — this bounds the resolve+retry to a single cycle.
  const { force = false, forceBy = null, autoResolve = true } = options;

  // Legacy native rows may predate reviewed_head_sha. Establish their live
  // GitHub revision before looking at votes (and clear any unbound legacy
  // approvals); all newly promoted rows already carry the value. We do not
  // refetch an existing stamp here because the exact-SHA merge below is the
  // final race guard, while every interactive vote performs a fresh read.
  const revision = await reconcileNativeReviewedHead({
    config, pool, session, fresh: false,
  });
  if (revision.blocked) {
    log.warn('votes', 'Merge blocked: native proposal revision unavailable', {
      sessionId: session.id, reason: revision.reason,
    });
    return {
      merged: false,
      revisionBlocked: true,
      transient: !!revision.transient,
      error: revision.reason,
    };
  }
  // #955: a revision the PLATFORM advanced (its own sync/conflict-resolution
  // commit, sitting on the reviewed head) kept its approvals, so there is no
  // review to return to — carry on and let the real gates decide. The pin now
  // matches the live head, which is exactly what the merge needs.
  if (revision.updated && !revision.votesKept) {
    // No approval predating the first immutable stamp may merge. A force
    // request also returns to review here; a second explicit request can merge
    // the now-pinned revision if that is still intended.
    return {
      merged: false,
      headMoved: !!revision.changed,
      reviewReset: true,
      reviewedHeadSha: revision.headSha,
    };
  }

  // The proposal's "opened for voting" anchor is promoted_at (falls back to
  // created_at defensively). All gates derive from one snapshot.
  //
  // #646: the gate is now governance-aware (services/governance.js).
  // Under the default settings this is bit-for-bit the old
  // getActiveUserStats + pr_votes counts + mergeGate; under
  // approver_policy='invited' only approver votes count (and the
  // electorate is the approver roster); under approvals_required=N the
  // proposal is mergeable as soon as it has N qualifying yes votes,
  // with every clock (window / lazy / rejection) off.
  const openedAt = session.promoted_at || session.created_at || null;
  const governance = require('../services/governance');

  // #788: does this proposal change dapp.json's `admins` block? This is
  // the AUTHORITATIVE check — the stamped column can be stale (a push
  // that raced its own stamp), so we re-diff against the live head here,
  // right before the gate.
  //
  // Fail-open on a GitHub transport error: fall back to the stored
  // column, and treat NULL as false. Failing closed would wedge EVERY
  // merge on the platform during a GitHub outage, and the highest-risk
  // path (a manifest PR opened by the platform itself) is stamped at
  // creation time, so the stale-and-outage case is vanishingly narrow.
  let explicitApproval = !!session.requires_explicit_approval;
  let explicitApprovalSource = 'stored';
  let explicitApprovalDetail = null;
  try {
    const detected = await appAdmins.detectAdminsChange(session, {
      headRef: appAdmins.headRefForSession(session),
    });
    // An INDETERMINATE result (no head ref / GitHub off / unparseable
    // repo / no merge base) keeps the stored flag — only a real diff
    // may overwrite it.
    if (detected.determinate) {
      explicitApproval = detected.changed;
      explicitApprovalSource = 'live';
      explicitApprovalDetail = {
        from: detected.from, to: detected.to, mergeBaseSha: detected.mergeBaseSha,
      };
      if (detected.changed !== !!session.requires_explicit_approval) {
        // The flip itself is worth a trace: a below-threshold clear
        // returns before any merge_debug_run opens, so without this
        // line a disappearing chip has no server-side explanation.
        log.info('votes', 'Explicit-approval flag overwritten by live check', {
          sessionId: session.id, stored: !!session.requires_explicit_approval,
          live: detected.changed, from: detected.from, to: detected.to,
          mergeBaseSha: detected.mergeBaseSha,
        });
        await appAdmins.stampExplicitApproval(pool, session.id, detected.changed);
      }
    }
  } catch (err) {
    log.warn('votes', 'Explicit-approval re-verify failed; using stored flag', {
      sessionId: session.id, stored: explicitApproval, err: err.message,
    });
  }

  const gate = await governance.governedGate(pool, session.app_id, {
    kind: 'pr', id: session.id, openedAt, explicitApproval,
    // Every GitHub PR proposal counts only approvals cast against its current
    // reviewed revision. Imported rows keep their existing source field;
    // native rows use reviewed_head_sha.
    headSha: reviewedHeadForSession(session),
  });
  const yesCount = gate.qualifiedYes;
  const noCount = gate.qualifiedNo;
  const activeCount = gate.activeCount;
  const majority = Math.floor(activeCount / 2) + 1;
  const required = gate.required;

  // Admin /debug capture. We deliberately do NOT open a run for the
  // common "not enough votes yet" early-return below — that fires on every
  // sub-threshold vote and would bury the interesting attempts. A run opens
  // only once a merge actually has a shot (majority reached, or a
  // force-merge), so the /debug list reads as real merge attempts — the
  // ones that either merge or get blocked. When the conflict-resolver
  // re-enters us (autoResolve:false) it passes its own run id so the retry
  // merge nests under the resolution run instead of spawning a duplicate.
  const md = require('../services/merge-debug');
  let debugRunId = options.debugRunId || null;
  const ownDebugRun = !debugRunId;
  const startDebugIfNeeded = async () => {
    if (ownDebugRun && debugRunId == null) {
      debugRunId = await md.startRun(pool, {
        appId: session.app_id, sessionId: session.id, prNumber: session.pr_number || null,
        kind: 'merge', trigger: force ? 'force' : 'vote',
      });
    }
  };
  const dstep = (o) => md.step(pool, debugRunId, o);
  // Only the run's owner stamps its terminal status; a passed-in run id
  // belongs to the resolver, which ends it itself.
  const dend = (status, summary) => { if (ownDebugRun) md.endRun(pool, debugRunId, { status, summary }); };

  if (!force) {
    // Merge paths (services/active-users.js → mergeGate):
    //   A. Threshold: eased Yes threshold met AND visibility window elapsed.
    //   B. Lazy consensus: below threshold, but Yes strictly leads with no
    //      contest and the lazy merge clock has elapsed — silence is consent.
    if (!gate.mergeable) {
      // A clock is running (threshold-met visibility window, or an armed
      // lazy-consensus window) — stay 'promoted' (don't claim the merge) so
      // the proposal keeps gathering votes; the next vote after the window,
      // or the stale-PR sweeper pass, re-attempts the merge.
      if ((gate.thresholdMet || gate.lazyArmed) && !gate.windowElapsed) {
        log.info('votes', 'Merge clock running; deferring merge', {
          sessionId: session.id, yesCount, noCount, required,
          lazyArmed: gate.lazyArmed,
          windowMs: gate.windowMs, windowEndsAt: gate.windowEndsAt,
        });
        return {
          merged: false, yesCount, needed: required,
          windowEndsAt: gate.windowEndsAt, waitingForWindow: true,
        };
      }
      // No clock at all: not enough support (or contested / No leading).
      return { merged: false, yesCount, needed: required, windowEndsAt: gate.windowEndsAt };
    }

    await startDebugIfNeeded();
    if (explicitApproval) {
      dstep({
        phase: 'gate:explicit_approval',
        message: `Proposal changes dapp.json's admins block (${explicitApprovalSource} check) — time-based merge paths are off: no visibility window, no lazy consensus. The app's normal threshold still applies.`,
        detail: {
          explicitApproval: true, source: explicitApprovalSource, mode: gate.mode,
          ...(explicitApprovalDetail || {}),
        },
      });
    }
    dstep({
      phase: 'gate:majority',
      message: gate.mode === 'at_least'
        ? `Approval target reached: ${yesCount} qualifying approval${yesCount === 1 ? '' : 's'} (needed at least ${required}${gate.policy === 'invited' ? ' from invited approvers' : ''}).`
        : gate.thresholdMet
          ? `Vote threshold reached: ${yesCount} yes votes (needed ${required}) with the visibility window elapsed.`
          : `Lazy-consensus window elapsed: ${yesCount} yes vote${yesCount === 1 ? '' : 's'} (threshold ${required}) with no opposition — silence is consent.`,
      detail: { yesCount, required, majority, noCount, activeCount, lazyArmed: gate.lazyArmed, mode: gate.mode, policy: gate.policy },
    });

    // Locked apps additionally require at least one admin yes vote (see
    // services/admin-approval.js + the apps.locked column). The active-user
    // majority gate above still has to pass — the admin yes is an extra
    // condition, not a replacement. Toggled via the home-card lock icon
    // (admin-only); see POST /api/apps/:slug/lock in routes/apps.js.
    if (await isAppLocked(pool, session.app_id)) {
      const adminYes = await hasAdminYesVote(
        pool, session.id, reviewedHeadForSession(session)
      );
      if (!adminYes) {
        log.info('votes', 'Threshold + window met but app is locked; awaiting admin yes', {
          sessionId: session.id, yesCount, required,
        });
        dstep({ phase: 'gate:lock', level: 'warn', message: 'App is locked and has no admin yes vote yet — merge blocked.', detail: { locked: true, adminYes: false } });
        dend('blocked', 'Blocked — locked app awaiting an admin yes vote.');
        return { merged: false, yesCount, needed: required, awaitingAdmin: true };
      }
      dstep({ phase: 'gate:lock', message: 'App is locked — admin yes vote present.', detail: { locked: true, adminYes: true } });
    } else {
      dstep({ phase: 'gate:lock', message: 'App is not locked — no admin-yes requirement.' });
    }

    // #8: refuse the merge if the branch is behind origin/main. We don't
    // auto-spawn a sync turn from here because:
    //   1. Charging the sync to the voter who happened to push us over
    //      the threshold is unfair — the cost should land on the
    //      session owner who controls the branch.
    //   2. Auto-spawning would add ~30-90s latency to the merge with no
    //      visible feedback to the voter who triggered it.
    // Instead, surface in group chat that the owner needs to click
    // "Sync with main" in their dev-chat. The next yes vote will
    // re-attempt the merge, which succeeds once behind_main=0.
    if ((session.behind_main || 0) > 0) {
      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      const behindMsg = `${label} is ${session.behind_main} commit${session.behind_main === 1 ? '' : 's'} behind main — syncing automatically and will retry the merge. ${owner}: you can also resolve it from the session's dev-chat.`;
      await sendSystemMessage(pool, session.app_id, behindMsg, 'system');
      // Dual-post into the proposal's thread (lifecycle in context).
      await sendSystemMessage(pool, session.app_id, behindMsg, 'system',
        null, { type: 'session', ref: session.id }).catch(() => {});
      log.info('votes', 'Merge blocked: branch behind main', {
        sessionId: session.id, behind: session.behind_main,
      });
      dstep({ phase: 'gate:behind_main', level: 'warn', message: `Branch is ${session.behind_main} commit(s) behind main — auto-sync queued, merge deferred.`, detail: { behind: session.behind_main } });
      dend('conflict_resolving', 'Behind main — auto-sync queued; see the conflict-resolution run.');
      // Auto-heal: sync the branch with main (worker git-merge +
      // Claude-on-markers) and retry the merge. The PR keeps its votes
      // because the sync push doesn't go through the vote-resetting
      // dev-turn path. Fire-and-forget so the voter's request returns
      // immediately.
      if (autoResolve) {
        // Funnel through the app-level drain so this vote-triggered resolve
        // is serialized with any other in-flight resolve for the app —
        // only one proposal per app resolves+merges at a time, highest-
        // voted first (this PR is eligible, so it's in that queue).
        checkAndResolveConflicts(config, { app_id: session.app_id }).catch((err) => {
          log.error('votes', 'Auto-resolve (behind_main) failed', {
            sessionId: session.id, err: err.message,
          });
        });
      }
      return { merged: false, yesCount, needed: required, behindMain: session.behind_main };
    }

    // #47: "CI for proposals" gate. A proposal merges only when its
    // automated tests (the dapp.json `tests` suite, run against the staging
    // build by services/visuals.js — see check_state) are PASSING — or,
    // since #461, explicitly SKIPPED (there was genuinely nothing to test:
    // branch level with main, or no GitHub wired up). Anything else blocks
    // fail-closed: 'failing' (a test broke), 'pending' (the check is still
    // running, or a fresh commit reset it and the rebuild hasn't reported
    // yet), 'error' ("couldn't run"), or NULL (never checked). This is the
    // answer to "everything got super broken" (#47).
    // Re-read fresh: the in-memory `session` row can predate the latest
    // build's verdict. Admin force-merge bypasses (skipped under !force).
    const { rows: checkRows } = await pool.query(
      `SELECT check_state, test_results, checks_checked_at,
              check_error_detail, checks_commit_sha
         FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    const nativeReviewedHead = session.source === 'imported'
      ? null
      : (session.reviewed_head_sha || null);
    const returnedChecksSha = checkRows[0]?.checks_commit_sha;
    const checksRevisionMismatch = !!nativeReviewedHead
      // `undefined` exists only in narrow unit-test row adapters that predate
      // the selected column; PostgreSQL returns null for a real unset value.
      && returnedChecksSha !== undefined
      && returnedChecksSha !== nativeReviewedHead;
    // A green verdict for an older commit is not a green verdict for the
    // reviewed code. Treat it as pending and rebuild exactly the pinned SHA.
    const checkState = checksRevisionMismatch
      ? 'pending'
      : (checkRows[0]?.check_state || null);
    if (checkState !== 'passing' && checkState !== 'skipped') {
      // #447: when a vote reaches threshold but the checks are NULL or stuck
      // 'pending' past the stale window, kick a recheck right now rather than
      // waiting for the periodic sweep — so a legitimately-passing PR clears
      // its block on the next vote instead of sitting indefinitely. The
      // recheck rebuilds staging if the preview is gone, else re-runs the
      // tests against the live container. Fire-and-forget; the gate still
      // blocks this attempt (the verdict isn't ready yet).
      const CHECKS_STALE_MS = parseInt(process.env.CHECKS_STALE_MS || String(10 * 60 * 1000), 10);
      const checkedAt = checkRows[0]?.checks_checked_at
        ? new Date(checkRows[0].checks_checked_at).getTime()
        : 0;
      const stalePending = checkState === null
        || (checkState === 'pending' && (Date.now() - checkedAt) > CHECKS_STALE_MS);
      if (checksRevisionMismatch) {
        await kickNativeRevisionChecks({
          config, pool, session, headSha: nativeReviewedHead,
        });
      } else if (stalePending) {
        const stagingRecovery = require('../services/staging-recovery');
        stagingRecovery.recheckSessionChecks({
          config, pool, session, reason: 'stale-pending-vote-kick',
        }).catch((err) => {
          log.warn('votes', 'Stale-pending recheck kick failed', {
            sessionId: session.id, err: err.message,
          });
        });
      }
      const failingCount = Array.isArray(checkRows[0]?.test_results)
        ? checkRows[0].test_results.filter((r) => r && r.status !== 'pass').length
        : 0;
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      // #237: for the 'error' state, surface the captured reason (usually a
      // staging preview that crashed on boot, e.g. a bad migration/seed) so
      // the block isn't an unexplained dead-end — the owner can act on it.
      const errorDetail = checkState === 'error' ? (checkRows[0]?.check_error_detail || null) : null;
      const reason = checkState === 'failing'
        ? `has ${failingCount || 'failing'} test${failingCount === 1 ? '' : 's'} failing`
        : checkState === 'error'
          ? (errorDetail
            ? `couldn't run its tests — its staging preview failed to start (${errorDetail})`
            : "couldn't run its tests")
          : 'is still running its tests';
      const blockMsg = `${label} reached the vote threshold but ${reason} — merge is blocked until checks pass. The proposal's tests re-run automatically when its owner pushes a fix.`;
      await sendSystemMessage(pool, session.app_id, blockMsg, 'system').catch(() => {});
      await sendSystemMessage(pool, session.app_id, blockMsg, 'system',
        null, { type: 'session', ref: session.id }).catch(() => {});
      log.info('votes', 'Merge blocked: checks not passing', {
        sessionId: session.id, checkState, failingCount,
        checksRevisionMismatch,
      });
      dstep({ phase: 'gate:checks', level: 'warn', message: `Merge blocked: checks not passing (state = ${checkState || 'pending'}${failingCount ? `, ${failingCount} failing` : ''}).`, detail: { checkState: checkState || 'pending', failingCount, checksRevisionMismatch } });
      dend('blocked', 'Blocked — votes reached but checks must pass first.');
      return {
        merged: false, yesCount, needed: required,
        checksBlocked: true, checkState: checkState || 'pending', failingCount,
        checksRevisionMismatch,
      };
    }
    dstep({ phase: 'gate:checks', message: `Checks gate: state = ${checkState}.`, detail: { checkState } });

    // Platform-variables gate. A self-app proposal that ADDS a required
    // `platform_env` declaration with no value set would deploy the
    // platform into a crash-loop, so it blocks here.
    //
    // Evaluated LIVE rather than read from platform_env_state. The stored
    // column exists for display; trusting it here would mean an admin who
    // sets the missing value has to wait for a staging rebuild before the
    // merge unblocks, which is absurd for a change that has nothing to do
    // with the build. Setting the value and voting again is enough.
    //
    // Fails open on everything indeterminate (see the service) — a GitHub
    // hiccup must not freeze every platform merge. Admin force-merge
    // bypasses along with the rest of this block.
    const platformEnvCheck = require('../services/platform-env-check');
    const { rows: gateAppRows } = await pool.query(
      'SELECT id, repo_url, self_hosted FROM apps WHERE id = $1',
      [session.app_id]
    );
    const gateApp = gateAppRows[0] || null;
    if (gateApp && gateApp.self_hosted) {
      const envVerdict = await platformEnvCheck.resolvePlatformEnvCheck({
        pool, app: gateApp, session,
      });
      // Persist what we just computed so the Checks card agrees with the
      // gate rather than showing an older verdict.
      await platformEnvCheck.storePlatformEnvCheck(pool, session.id, envVerdict);

      if (envVerdict.state === 'failing') {
        const label = session.pr_title
          ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
          : `PR #${session.pr_number || session.id}`;
        const blockMsg = platformEnvCheck.describeBlock(envVerdict.detail, label);
        await sendSystemMessage(pool, session.app_id, blockMsg, 'system').catch(() => {});
        await sendSystemMessage(pool, session.app_id, blockMsg, 'system',
          null, { type: 'session', ref: session.id }).catch(() => {});
        log.info('votes', 'Merge blocked: platform variables unset', {
          sessionId: session.id, missing: envVerdict.detail.missing.map((m) => m.key),
        });
        dstep({
          phase: 'gate:platform-env', level: 'warn',
          message: `Merge blocked: ${envVerdict.detail.missing.length} platform variable(s) declared but not set.`,
          detail: envVerdict.detail,
        });
        dend('blocked', 'Blocked — a new platform variable has no value set.');
        return {
          merged: false, yesCount, needed: required,
          platformEnvBlocked: true,
          platformEnvMissing: envVerdict.detail.missing.map((m) => m.key),
        };
      }
      dstep({
        phase: 'gate:platform-env',
        message: `Platform-variables gate: ${envVerdict.state}.`,
        detail: { state: envVerdict.state, reason: envVerdict.detail.reason },
      });
    }
  }
  // For admin force-merge we deliberately skip the behind_main pre-check
  // — GitHub will still reject the merge if there's a real conflict,
  // and the catch-block below surfaces that the same way it does for
  // votes. Admins overriding the vote can decide whether to push the
  // branch sync themselves.

  // Majority reached. Try to claim the merge by atomically flipping
  // status 'promoted' → 'merging'. Only one concurrent caller will
  // win this; everyone else bails out. This guards against the
  // previous bug where hammering "Yes" fired N parallel merge+rebuild
  // pipelines that stomped on each other (GitHub lock, /tmp/usernode-
  // rebuild-* git clone races, duplicate `docker run --name ...`, etc).
  // Force-merge skips the gate block above, so its run opens here.
  await startDebugIfNeeded();
  if (force) {
    dstep({ phase: 'gate:majority', message: `Force-merge by ${forceBy?.username || 'an admin'} — bypassing the vote/checks gates.`, detail: { yesCount, majority, forced: true } });
  }

  const { rows: claim } = await pool.query(
    `UPDATE chat_sessions SET status = 'merging'
     WHERE id = $1 AND status = 'promoted'
     RETURNING id`,
    [session.id]
  );
  if (!claim.length) {
    log.info('votes', 'Merge already claimed by another request, skipping', {
      sessionId: session.id,
    });
    dstep({ phase: 'claim', message: 'Merge already claimed by another request — skipping.' });
    dend('noop', 'Another request is already merging this proposal.');
    return { merged: false, inProgress: true };
  }
  dstep({ phase: 'claim', message: 'Claimed merge (promoted → merging).' });

  // Broadcast the 'merging' transition so every client refreshes its
  // vote panel and re-renders the PR as "Merging…" — rather than having
  // it silently disappear between the vote and the eventual 'merged'
  // state (30s+ on the majority path). `merged:false` here means "still
  // in flight"; the final `merged:true` broadcast fires below after the
  // GitHub merge + prod rebuild + staging teardown finish.
  //
  // `selfHosted` rides along as a cheap, honest fact about the merge:
  // whether this proposal deploys the platform itself. It used to arm
  // the platform-wide "Platform updating…" banner, which was removed in
  // #1015 — blue-green deploys (#1008) keep the live color serving
  // through a platform redeploy, so there is no downtime to announce
  // and no reason for a client to pause writes. No client branches on
  // the flag today; it stays on the payload for admin/debug parity and
  // any future surface that wants to distinguish a platform merge.
  const { pushVoteUpdate } = require('../services/ws');
  pushVoteUpdate({
    sessionId: session.id,
    appSlug: session.app_slug,
    merged: false,
    merging: true,
    selfHosted: !!session.app_self_hosted,
  });

  log.info('votes',
    force ? 'Admin force-merge invoked, merging' : 'Majority reached, merging',
    {
      sessionId: session.id, yesCount, needed: required,
      ...(force && forceBy ? { forcedBy: forceBy.username } : {}),
    });

  let mergeCommitSha = null;
  // Tracks whether the irreversible GitHub merge has already happened. Once
  // it has, a failure in any LATER step (prod rebuild, staging teardown,
  // bounty payout, …) must NOT roll the session back to 'promoted' — the PR
  // is merged on GitHub and re-opening it for voting is the bug behind
  // "merged PRs still show up for voting" (the rebuild can keep failing —
  // e.g. a newly-required secret with no production value — yet the merge is
  // done). See the catch block below.
  let githubMerged = false;

  try {
    // Merge PR on GitHub
    // Pin every GitHub merge to the exact reviewed commit so GitHub refuses
    // (409) if the head moved. Imported staging previews still use their
    // existing in-memory mock; native proposals always use the real client.
    const isImported = session.source === 'imported';
    const useMockMerge = isImported && usesMockGithubForImports();
    const mergeClient = useMockMerge ? githubMock : github;
    if ((mergeClient.isEnabled() || useMockMerge) && session.repo_url && session.pr_number) {
      const [, owner, repo] = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (owner && repo) {
        const pinnedSha = reviewedHeadForSession(session);
        dstep({ phase: 'github_merge', message: `Calling GitHub merge for PR #${session.pr_number}…`, detail: { owner, repo, pinnedSha, mock: useMockMerge } });
        let mergeData;
        try {
          mergeData = await mergeClient.mergePR(owner, repo, session.pr_number, pinnedSha);
        } catch (err) {
          // Head moved between the review and the merge. Do NOT error the proposal: release
          // the 'merging' claim back to 'promoted' so the row stays recoverable
          // (recoverStuckMerges understands both states). Imported proposals
          // retain their existing sync-poller recovery; native proposals reset
          // immediately below. Return a distinct { headMoved } outcome;
          // nothing merged.
          if (err && err.headMoved) {
            let nativeRefresh = null;
            if (!isImported) {
              nativeRefresh = await reconcileNativeReviewedHead({
                config, pool, session, fresh: true, notify: false,
              }).catch((syncErr) => {
                log.warn('votes', 'Native head-moved reconciliation failed', {
                  sessionId: session.id, err: syncErr.message,
                });
                return null;
              });

              // GitHub also uses 409 for an ordinary merge conflict. If a
              // fresh read says the native PR is still on the exact pinned
              // SHA, this was not a revision change; route it through the
              // existing conflict recovery path instead of clearing review.
              if (!nativeRefresh?.blocked && nativeRefresh?.headSha === pinnedSha) {
                err.headMoved = false;
                err.status = 405;
                throw err;
              }

              // A 409 plus an unverifiable revision is ambiguous. Release the
              // claim and fail closed without claiming either a head move or a
              // merge conflict; a later vote/sweep can retry the live read.
              if (!nativeRefresh || nativeRefresh.blocked || !nativeRefresh.headSha) {
                await pool.query(
                  `UPDATE chat_sessions SET status = 'promoted' WHERE id = $1 AND status = 'merging'`,
                  [session.id]
                ).catch(() => {});
                try {
                  const { pushVoteUpdate } = require('../services/ws');
                  // merging:false + merged:false is the terminal "attempt
                  // ended, no deploy coming" shape — clients un-latch the
                  // self-app "Platform updating…" banner off it (see
                  // handleVoteUpdate). Every terminal broadcast must carry
                  // merging:false or self-app tabs stay read-only waiting
                  // for a SHA flip that never comes.
                  pushVoteUpdate({
                    sessionId: session.id, appSlug: session.app_slug,
                    merged: false, merging: false,
                    selfHosted: !!session.app_self_hosted,
                  });
                } catch (_) { /* ws failures non-fatal */ }
                const reason = nativeRefresh?.reason
                  || 'GitHub could not verify the pull request revision after refusing the merge.';
                await sendSystemMessage(pool, session.app_id,
                  `PR #${session.pr_number} was not merged because its current GitHub revision could not be verified. Please retry after GitHub is reachable.`,
                  'system', null, { type: 'session', ref: session.id }
                ).catch(() => {});
                dstep({
                  phase: 'github_merge', level: 'warn',
                  message: 'GitHub refused the merge and the live native revision could not be verified.',
                  detail: { revisionBlocked: true, pinnedSha, reason },
                });
                dend('deferred', 'Merge deferred — current GitHub revision could not be verified.');
                return {
                  merged: false,
                  revisionBlocked: true,
                  transient: !!nativeRefresh?.transient,
                  error: reason,
                };
              }
            }
            await pool.query(
              `UPDATE chat_sessions SET status = 'promoted' WHERE id = $1 AND status = 'merging'`,
              [session.id]
            ).catch(() => {});
            try {
              const { pushVoteUpdate } = require('../services/ws');
              // merging:false ends the merge attempt for clients: the
              // merging:true broadcast above armed the self-app "Platform
              // updating…" banner, and no deploy — hence no SHA flip —
              // follows an aborted merge. A head move is deliberately NOT
              // flagged mergeFailed; the client un-latches off the
              // merging:false + merged:false shape itself.
              pushVoteUpdate({
                sessionId: session.id, appSlug: session.app_slug,
                merged: false, merging: false, headMoved: true,
                selfHosted: !!session.app_self_hosted,
              });
            } catch (_) { /* ws failures non-fatal */ }
            // #955: the head may have moved because the PLATFORM synced this
            // branch with main. Those approvals survived the refresh, so this
            // is a re-pin and an immediate retry — not a return to review.
            const votesKept = !isImported && !!nativeRefresh?.votesKept;
            const movedLabel = session.pr_title
              ? `PR #${session.pr_number} — ${session.pr_title}`
              : `PR #${session.pr_number}`;
            const movedMessage = isImported
              ? `${movedLabel} wasn't merged — the PR was updated on GitHub since the vote, so GitHub declined to merge the older commit. It'll be re-checked against the new commit and can merge again once it passes.`
              : votesKept
                ? `${movedLabel} wasn't merged on this attempt — it had just been synced with main, so the merge is now pinned to commit ${String(nativeRefresh.headSha).slice(0, 8)}. Existing votes were kept and the merge retries automatically.`
                : `${movedLabel} wasn't merged — its GitHub head changed after review. Earlier-revision votes were cleared and the new commit is being checked; please re-review it.`;
            await sendSystemMessage(pool, session.app_id,
              movedMessage,
              'system', null, { type: 'session', ref: session.id }
            ).catch(() => {});
            dstep({ phase: 'github_merge', level: 'warn', message: isImported
              ? 'GitHub refused the merge: the PR head moved since the reviewed commit. Released the merge claim; the sync poller will pick up the new head.'
              : votesKept
                ? 'GitHub refused the merge: the pinned commit was superseded by the platform\'s own sync. Re-pinned to it with votes intact and re-queued the merge.'
                : 'GitHub refused the merge: the native PR head moved since review. Released the merge claim and reset the proposal to the new revision.', detail: { headMoved: true, votesKept, pinnedSha, refreshedHeadSha: nativeRefresh?.headSha || null } });
            dend('deferred', isImported
              ? 'Head moved since the reviewed commit — deferred to the sync poller.'
              : votesKept
                ? 'Superseded by the platform\'s own sync commit — re-queued with votes intact.'
                : 'Head moved since review — returned to review on the new commit.');
            if (votesKept) {
              // Re-drive the app drain so the merge is re-attempted against the
              // corrected pin instead of waiting for the hourly sweeper. It
              // cannot loop: the pin now equals the live head, so the retry
              // either merges or blocks on a real gate (usually checks).
              checkAndResolveConflicts(config, { app_id: session.app_id }).catch((e) => {
                log.warn('votes', 'Post-sync merge re-kick failed', {
                  sessionId: session.id, err: e.message,
                });
              });
            }
            return {
              merged: false, headMoved: true, needed: required, yesCount,
              ...(votesKept ? { votesKept: true } : {}),
              ...(nativeRefresh?.headSha ? { reviewedHeadSha: nativeRefresh.headSha } : {}),
            };
          }
          throw err;
        }
        // #11: capture the squash-merge commit SHA so future vote-to-undo
        // can `git revert <sha>` against main. The Octokit `pulls.merge`
        // response shape is { sha, merged: true, message }.
        mergeCommitSha = mergeData?.sha || null;
        githubMerged = true;
        dstep({ phase: 'github_merge', message: `GitHub merged PR #${session.pr_number}${mergeCommitSha ? ` as commit ${String(mergeCommitSha).slice(0, 9)}` : ''}.`, detail: { sha: mergeCommitSha } });
      }
    } else {
      dstep({ phase: 'github_merge', message: 'GitHub not enabled or PR-less — skipping the GitHub merge call.' });
    }

    // #687 Slice 4: run the shared post-merge finalizer. Both native and
    // imported merges converge here after the (only-difference) github.mergePR
    // call above, so the deploy/teardown/announce tail is byte-for-byte
    // identical for both. A throw inside still lands in this try's catch,
    // which honours the githubMerged guard and the merge-debug tracing.
    return await finalizeMerge({
      config, pool, session,
      mergeCommitSha, required, activeCount, yesCount, majority,
      force, forceBy, dstep, dend,
    });
  } catch (err) {
    log.error('votes', 'Merge failed', { sessionId: session.id, err: err.message, githubMerged });
    dstep({ phase: 'merge_error', level: 'error', message: `Merge step threw: ${err.message}`, detail: { githubMerged, status: err.status || null } });

    // The GitHub merge is irreversible. If it already succeeded and a
    // LATER step threw (most commonly `staging.rebuildProduction` — e.g. a
    // PR that introduces a new required secret with no production value
    // raises MissingSecretsError, or two sibling rebuilds race on the
    // container name), the PR *is* merged. Rolling the session back to
    // 'promoted' here is exactly what left whiteboard PRs #41/#44/#52/#54
    // showing "up for voting" forever: `GET /api/apps/:slug/promoted`
    // returns `status IN ('promoted','merging')`, and any "retry" merge
    // 405s because GitHub has nothing left to merge. Instead, record the
    // merge and surface the deploy failure separately so an operator can
    // fix the cause and re-run the rebuild ("Check for updates" / drift
    // poller). The pre-merge conflict/behind_main handling further down is
    // premised on the merge NOT having happened, so we return early.
    if (githubMerged) {
      await pool.query(
        `UPDATE chat_sessions
            SET status = 'merged',
                merged_at = COALESCE(merged_at, NOW()),
                merge_commit_sha = COALESCE(merge_commit_sha, $2),
                votes_required = COALESCE(votes_required, $3),
                active_users_at_merge = COALESCE(active_users_at_merge, $4)
          WHERE id = $1 AND status IN ('merging', 'merged')`,
        [session.id, mergeCommitSha, required, activeCount]
      ).catch((e) => log.error('votes',
        'Failed to mark session merged after post-merge error', {
          sessionId: session.id, err: e.message,
        }));

      const failLabel = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${failLabel} merged on GitHub, but the production deploy failed: ${err.message}. ` +
        `The change is on main; an operator can retry the deploy once the cause is resolved.`,
        'system'
      ).catch(() => {});

      try {
        const { pushVoteUpdate } = require('../services/ws');
        pushVoteUpdate({
          sessionId: session.id,
          appSlug: session.app_slug,
          merged: true,
          merging: false,
          deployFailed: true,
          selfHosted: !!session.app_self_hosted,
        });
      } catch (_) { /* ws failures non-fatal */ }

      dstep({ phase: 'merged', level: 'warn', message: `PR merged on GitHub but the production deploy failed: ${err.message}`, detail: { deployFailed: true } });
      dend('merged', 'Merged on GitHub; production deploy failed (operator retry needed).');
      return { merged: true, deployFailed: true, error: err.message };
    }

    // GitHub merge did NOT happen (conflict, auth, transient API error).
    // Release the 'merging' claim so a subsequent vote (or retry) can
    // try again. Without this the session would be stuck in 'merging'
    // forever on any transient failure.
    await pool.query(
      `UPDATE chat_sessions SET status = 'promoted'
       WHERE id = $1 AND status = 'merging'`,
      [session.id]
    ).catch(() => {});

    // #9: detect GitHub's "merge conflict" rejection specifically.
    // Octokit returns status 405 with a message containing "merge
    // conflict" or "not mergeable" when `pulls.merge` is called on
    // an unmergeable PR. Computed before the mergeFailed broadcast
    // below so the broadcast can flag whether the auto-resolver is
    // about to kick in (#239).
    const msg = String(err.message || '').toLowerCase();
    const isConflict =
      err.status === 405 ||
      msg.includes('merge conflict') ||
      msg.includes('not mergeable') ||
      msg.includes('pull request is not mergeable');

    // A 405 on a CLOSED PR is not a merge conflict — GitHub reports
    // closed PRs as permanently unmergeable ('dirty'), so handing this
    // to the auto-resolver spins forever (session 2398 / PR #26:
    // withdraw closed the PR, re-promote never reopened it, every merge
    // 405'd and every resolve ended still_conflicting). Distinguish the
    // two with one PR GET: closed-unmerged → reopen and fall through to
    // the normal conflict handling; reopen refused → terminal pr_closed
    // (off the vote panel, honest group-chat message, no resolver). A
    // transient GET failure falls through to the conflict path unchanged.
    if (isConflict && github.isEnabled() && session.repo_url && session.pr_number) {
      const [, prOwner, prRepo] = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      let prState = null;
      if (prOwner && prRepo) {
        try {
          prState = await github.getPR(prOwner, prRepo, session.pr_number);
        } catch (e) {
          log.warn('votes', 'PR state check after merge 405 failed', {
            sessionId: session.id, pr: session.pr_number, err: e.message,
          });
        }
      }
      if (prState && prState.state === 'closed' && !prState.merged) {
        try {
          await github.reopenPR(prOwner, prRepo, session.pr_number);
          dstep({ phase: 'reopened_closed_pr', message: `PR #${session.pr_number} was closed on GitHub — reopened it; continuing with the normal conflict handling.` });
        } catch (reopenErr) {
          const closedLabel = session.pr_title
            ? `PR #${session.pr_number} — ${session.pr_title}`
            : `PR #${session.pr_number}`;
          // Drop out of 'promoted' so no vote/sweep re-picks a proposal
          // whose PR can never merge. 'paused' keeps the branch + CC
          // memory restorable; the owner can re-propose from dev-chat.
          await pool.query(
            `UPDATE chat_sessions SET status = 'paused'
             WHERE id = $1 AND status = 'promoted'`,
            [session.id]
          ).catch(() => {});
          await sendSystemMessage(pool, session.app_id,
            `${closedLabel} is closed on GitHub and couldn't be reopened — it has been taken off the vote panel. Re-propose it from the session's dev-chat.`,
            'system'
          ).catch(() => {});
          try {
            const { pushVoteUpdate, pushSessionUpdate } = require('../services/ws');
            // Un-latch clients (the merging:true broadcast above armed
            // banners) and refresh session lists off the pause.
            pushVoteUpdate({
              sessionId: session.id,
              appSlug: session.app_slug,
              merged: false,
              merging: false,
              mergeFailed: true,
              resolving: false,
              selfHosted: !!session.app_self_hosted,
            });
            pushSessionUpdate({ action: 'paused', sessionId: session.id, appSlug: session.app_slug });
          } catch (_) { /* ws failures non-fatal */ }
          dstep({
            phase: 'pr_closed', level: 'error',
            message: `PR #${session.pr_number} is closed on GitHub and couldn't be reopened: ${reopenErr.message}`,
            detail: {},
          });
          dend('pr_closed', `PR #${session.pr_number} is closed on GitHub (reopen failed).`);
          return { merged: false, error: err.message, conflict: false, prClosed: true };
        }
      }
    }

    // Terminal counter-event to the `merging:true` broadcast above: this
    // merge attempt is over and nothing merged. Every client surface
    // that advanced to "Merging…" needs it to fall back — the vote
    // panel, the session header pill, the proposal's own state badge —
    // so the shape (`merging:false` + `merged:false`) is the contract,
    // not an optimization. (It also un-latched the platform-wide
    // "Platform updating…" banner until #1015 removed it.)
    //
    // #239: `resolving` rides along when the failure is a conflict AND
    // the auto-resolver is about to be fired below, so the proposal's
    // badge reads "Resolving conflicts…" rather than a bare failure
    // while the resolver spends 1–2 minutes fixing the branch. The
    // resolver's own start broadcast can lag by a few seconds
    // (pollMergeable runs first), so this flag closes the gap.
    try {
      const { pushVoteUpdate } = require('../services/ws');
      pushVoteUpdate({
        sessionId: session.id,
        appSlug: session.app_slug,
        merged: false,
        merging: false,
        mergeFailed: true,
        resolving: isConflict && autoResolve,
        selfHosted: !!session.app_self_hosted,
      });
    } catch (_) { /* ws failures non-fatal */ }

    // The pre-merge gate in checkAndMerge catches
    // the common case (our recorded behind_main > 0), but races
    // (another PR merging in the window between our last sync and
    // the vote crossing threshold) can slip past it. When that
    // happens, our local behind_main is stale (= 0) but the branch
    // really is behind main, so we:
    //   1. Bump behind_main to at least 1 so the dev-chat banner
    //      reappears for the owner. The next worker turn will
    //      recompute the exact count.
    //   2. Broadcast session_update(behind_main) so any open dev-chat
    //      banner refreshes in place.
    //   3. Post a tailored group-chat message that matches the
    //      pre-merge gate's wording, so the user knows it's a
    //      "owner needs to click Sync" situation rather than a
    //      mysterious GitHub blowup.
    if (isConflict) {
      try {
        const { rows: bumpRows } = await pool.query(
          `UPDATE chat_sessions
             SET behind_main = GREATEST(behind_main, 1),
                 -- #361: a real merge-time conflict — reflect it on the
                 -- card immediately (conflict_files fills in on the next
                 -- sync, which captures the --diff-filter=U set).
                 merge_conflict_state = 'conflict',
                 conflict_checked_at = NOW()
           WHERE id = $1 RETURNING behind_main`,
          [session.id]
        );
        const newBehind = bumpRows[0]?.behind_main || 1;
        try {
          const { pushSessionUpdate } = require('../services/ws');
          pushSessionUpdate({
            action: 'behind_main',
            sessionId: session.id,
            appSlug: session.app_slug,
            behindMain: newBehind,
          });
        } catch (_) { /* ws failures non-fatal */ }
      } catch (_) { /* DB bump failures non-fatal — chat msg still goes out */ }

      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      // Honest wording: the auto-resolver drain only picks up proposals
      // that are vote-eligible to merge, so "syncing automatically" was a
      // false promise for anything below the gate. On the FORCED path the
      // resolve really is about to run (dispatched directly below), so the
      // message can promise it; otherwise lead with the creator's "Sync
      // with main", which is the path that always works.
      await sendSystemMessage(pool, session.app_id,
        (force && autoResolve)
          ? `${label} hit a conflict with main during an admin merge — resolving the conflict automatically and retrying the merge.`
          : `${label} hit a conflict with main during a merge attempt. ${owner}: finish the merge by running "Sync with main" from the session's dev-chat. (Auto-resolution retries only when the proposal is eligible to merge on votes.)`,
        'system'
      );
      // Auto-heal the conflict the same way the behind_main gate does.
      // autoResolve guards against the resolver's own retry re-entering
      // this path (it calls checkAndMerge with autoResolve:false).
      if (autoResolve) {
        if (force) {
          // Force-carry-through: an admin explicitly asked for this merge,
          // so the recovery must not be handed to the gate-filtered app
          // drain (which re-applies the vote check the admin just bypassed
          // and skips anything below threshold — the "starts auto merging,
          // then nothing" dead end). Resolve THIS session directly — same
          // worker sync the owner's "Sync with main" runs — and retry the
          // merge with the force intent preserved.
          const { resolveAndMaybeRetry } = require('../services/conflict-resolver');
          resolveAndMaybeRetry(config, { sessionId: session.id }, {
            mergeOnly: false, force: true, forceBy, trigger: 'force',
          }).catch((e) => {
            log.error('votes', 'Auto-resolve (forced merge conflict) failed', {
              sessionId: session.id, err: e.message,
            });
          });
        } else {
          // Same app-level drain as the behind_main path — serialized,
          // one-proposal-at-a-time-per-app resolution.
          checkAndResolveConflicts(config, { app_id: session.app_id }).catch((e) => {
            log.error('votes', 'Auto-resolve (merge conflict) failed', {
              sessionId: session.id, err: e.message,
            });
          });
        }
      }
    } else {
      await sendSystemMessage(pool, session.app_id,
        `Failed to merge PR #${session.pr_number || session.id}: ${err.message}`,
        'system'
      );
    }
    if (isConflict) {
      dstep({
        phase: 'conflict_detected', level: 'warn',
        message: 'GitHub rejected the merge as a conflict — '
          + (!autoResolve ? 'auto-resolver not run (resolver re-entry).'
            : force ? 'per-session resolver dispatched directly with the force intent preserved.'
              : 'auto-resolver queued.'),
        detail: { autoResolve, forced: !!force },
      });
      dend(autoResolve ? 'conflict_resolving' : 'conflict_failed', 'Merge conflict at GitHub.');
    } else {
      dend('error', `Merge failed: ${err.message}`);
    }
    return { merged: false, error: err.message, conflict: isConflict };
  }
}

// #11/#16: undo helper. Called from the /undo route. Opens a revert PR
// for a merged session (clone, `git revert <merge_sha>`, push, open PR)
// and inserts a `promoted` chat_sessions row for it that then goes
// through the normal merge vote. As of #16 there's no undo-vote gate —
// the merge vote on the revert PR is the single checkpoint.
//
// `decider` is the user who requested the undo — becomes the revert
// session's user_id so they own the resulting PR in dev-chat.
async function checkAndOpenRevert(config, pool, session, decider) {
  // #16: opening a revert is now a direct action (like proposing a
  // forward change) — there's no separate undo-vote gate to clear. We
  // still read activeCount/majority so the announcement can tell users
  // how many votes the revert PR will need to actually land. The
  // locked-app admin-yes gate is NOT applied here: it's a merge-time
  // control and is enforced when the revert PR's own merge vote is
  // tallied (checkAndMerge), exactly like a forward proposal.
  const { active: activeCount, majority } = await getActiveUserStats(pool, session.app_id);

  // Atomic claim — race-safe against parallel undo requests. We mark
  // the original session with revert_of_session_id = its own id as a
  // sentinel "claimed" value; the real revert session id swaps in
  // below once we have it. The WHERE NULL guarantees only one caller
  // wins this transition.
  const { rows: claim } = await pool.query(
    `UPDATE chat_sessions SET revert_of_session_id = id
     WHERE id = $1 AND revert_of_session_id IS NULL
     RETURNING id`,
    [session.id]
  );
  if (!claim.length) {
    log.info('votes', 'Revert already claimed by another request, skipping', {
      sessionId: session.id,
    });
    return { reverted: false, inProgress: true };
  }

  // Sanity precondition: we need a merge SHA to revert. For pre-#11
  // merged rows the column is NULL because mergePR's response wasn't
  // captured at the time. GitHub still knows the SHA via pulls.get —
  // try to backfill on demand, persist for next time, and proceed.
  // Only fall through to the manual-revert message if GitHub can't
  // help either (auth disabled, repo gone, PR never actually merged,
  // etc.).
  if (!session.merge_commit_sha) {
    let backfilledSha = null;
    let backfillReason = 'unknown';
    if (!github.isEnabled()) {
      backfillReason = 'GitHub auth not configured on this deployment';
    } else if (!session.repo_url) {
      backfillReason = 'session has no repo_url';
    } else if (!session.pr_number) {
      backfillReason = 'session has no pr_number';
    } else {
      const bm = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!bm) {
        backfillReason = `unparseable repo_url ${session.repo_url}`;
      } else {
        const [, bOwner, bRepo] = bm;
        try {
          // Use octokit.request rather than octokit.rest.pulls.get —
          // @octokit/app's installation octokit is a bare @octokit/core
          // instance and does not include the rest-endpoint-methods
          // plugin, so .rest is undefined.
          const octokit = await github.getInstallationOctokit(bOwner);
          const { data: pr } = await octokit.request(
            'GET /repos/{owner}/{repo}/pulls/{pull_number}',
            { owner: bOwner, repo: bRepo, pull_number: session.pr_number }
          );
          if (pr.merged && pr.merge_commit_sha) {
            await pool.query(
              `UPDATE chat_sessions SET merge_commit_sha = $2
               WHERE id = $1 AND merge_commit_sha IS NULL`,
              [session.id, pr.merge_commit_sha]
            );
            session.merge_commit_sha = pr.merge_commit_sha;
            backfilledSha = pr.merge_commit_sha;
            log.info('votes', 'Backfilled merge_commit_sha from GitHub', {
              sessionId: session.id, prNumber: session.pr_number,
              sha: pr.merge_commit_sha,
            });
          } else {
            backfillReason = pr.merged
              ? 'GitHub returned a merged PR with no merge_commit_sha'
              : 'GitHub says this PR is not merged';
          }
        } catch (err) {
          backfillReason = `GitHub lookup failed: ${err.message}`;
          log.warn('votes', 'merge_commit_sha backfill from GitHub failed', {
            sessionId: session.id, prNumber: session.pr_number, err: err.message,
          });
        }
      }
    }

    if (!backfilledSha) {
      await pool.query(
        `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
        [session.id]
      ).catch(() => {});
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `Couldn't auto-revert ${label}: ${backfillReason}. Please open the revert PR manually.`,
        'system'
      );
      return { reverted: false, error: 'no merge_commit_sha', backfillReason };
    }
  }
  if (!session.repo_url) {
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    return { reverted: false, error: 'no repo_url' };
  }

  const m = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) {
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    return { reverted: false, error: 'unparseable repo_url' };
  }
  const [, repoOwner, repoName] = m;

  log.info('votes', 'Opening revert PR', {
    sessionId: session.id, needed: majority, requestedBy: decider.username,
  });

  let revertInfo;
  try {
    revertInfo = await createRevertPR({
      session,
      mergeSha: session.merge_commit_sha,
      repoOwner,
      repoName,
      deciderUsername: decider.username,
    });
  } catch (err) {
    // Release the claim so a future vote can retry. Most common
    // failure here is `git revert` conflict — surface it clearly.
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    log.error('votes', 'Revert PR creation failed', { sessionId: session.id, err: err.message });
    const label = session.pr_title
      ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
      : `PR #${session.pr_number || session.id}`;
    await sendSystemMessage(pool, session.app_id,
      `Couldn't auto-revert ${label}: ${err.message}. ` +
      `Most likely later commits depend on it. Please open the revert PR manually.`,
      'system'
    );
    return { reverted: false, error: err.message };
  }

  // Insert the revert session row. status=promoted means it lands
  // directly in the vote panel ready for a second checkpoint vote.
  const { rows: revertRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_number, pr_url, pr_title,
        status, revert_of_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'promoted', $7)
     RETURNING id`,
    [
      session.app_id, decider.id, revertInfo.branch,
      revertInfo.prNumber, revertInfo.prUrl, revertInfo.prTitle,
      session.id,
    ]
  );
  const revertSessionId = revertRows[0].id;

  // Patch the original's revert_of_session_id pointer to actually
  // point at the revert session (was set to its own id as a claim
  // sentinel above). Now `revert_of_session_id IS NOT NULL` on the
  // original correctly identifies "has a revert in flight".
  await pool.query(
    `UPDATE chat_sessions SET revert_of_session_id = $1 WHERE id = $2`,
    [revertSessionId, session.id]
  );

  // Announce in group chat so the new revert PR shows up in the vote
  // panel with context. Tag the original PR # for breadcrumbs.
  const label = session.pr_title
    ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
    : `PR #${session.pr_number || session.id}`;
  await sendSystemMessage(pool, session.app_id,
    `${decider.username} proposed undoing ${label}. Opened revert PR #${revertInfo.prNumber} — needs ${majority}/${activeCount} votes to land.`,
    'system'
  );

  return {
    reverted: true,
    revertSessionId,
    revertPrNumber: revertInfo.prNumber,
    revertPrUrl: revertInfo.prUrl,
  };
}

// Clone the repo to a tmpdir, branch off main, `git revert <sha>`,
// push, open a PR. Returns { branch, prNumber, prUrl, prTitle }.
// Throws on revert conflict or network errors; caller surfaces the
// failure to chat.
async function createRevertPR({ session, mergeSha, repoOwner, repoName, deciderUsername }) {
  const token = process.env.GITHUB_BOT_TOKEN;
  if (!token) throw new Error('GITHUB_BOT_TOKEN not set');

  const cloneUrl = `https://x-access-token:${token}@github.com/${repoOwner}/${repoName}.git`;
  const tmpDir = `/tmp/usernode-revert-${session.id}-${Date.now()}`;
  // Branch naming pattern: revert/<original-branch>-<timestamp>. The
  // timestamp suffix avoids collisions if a prior revert attempt left
  // a stale branch on the remote.
  const safeBase = (session.branch_name || `pr-${session.pr_number || session.id}`).replace(/[^a-zA-Z0-9._/-]/g, '-');
  const revertBranch = `revert/${safeBase}-${Date.now()}`;

  try {
    // Full clone — we need history reaching back to the merge SHA, so
    // the rebuildProduction shallow-clone pattern doesn't apply here.
    await docker.execFileAsync('git', ['clone', cloneUrl, tmpDir], { timeout: 180000 });

    // Committer identity for the revert commit. Matches the
    // usernode-bot convention used elsewhere.
    await docker.execFileAsync('git', ['-C', tmpDir, 'config', 'user.name', 'usernode-bot']);
    await docker.execFileAsync('git', ['-C', tmpDir, 'config', 'user.email', 'usernode-bot@users.noreply.github.com']);

    // Branch off the current main. main has already been updated by
    // the original merge + any subsequent merges by the time we get
    // here, so this is the "current" main.
    await docker.execFileAsync('git', ['-C', tmpDir, 'checkout', '-b', revertBranch], { timeout: 10000 });

    // `git revert --no-edit <sha>` — squash merges produce single-parent
    // commits, so no `-m 1` needed. If the revert conflicts (later
    // commits depend on this one), git exits non-zero and the docker
    // helper rejects.
    try {
      await docker.execFileAsync('git', ['-C', tmpDir, 'revert', '--no-edit', mergeSha], { timeout: 30000 });
    } catch (revertErr) {
      // Clean up the conflicted state inside the tmp dir for hygiene
      // (best-effort), then surface a tight error.
      await docker.execFileAsync('git', ['-C', tmpDir, 'revert', '--abort']).catch(() => {});
      const m = String(revertErr.message || '').toLowerCase();
      if (m.includes('conflict')) {
        throw new Error('Revert produced merge conflicts');
      }
      throw new Error(`git revert failed: ${revertErr.message.slice(0, 200)}`);
    }

    await docker.execFileAsync('git', ['-C', tmpDir, 'push', '-u', 'origin', revertBranch], { timeout: 60000 });

    const origLabel = session.pr_title
      ? `${session.pr_title} (PR #${session.pr_number || session.id})`
      : `PR #${session.pr_number || session.id}`;
    const prTitle = `Revert: ${session.pr_title || `PR #${session.pr_number || session.id}`}`.slice(0, 200);
    const prBody =
      `Automated revert of ${origLabel}.\n\n` +
      `Undo vote reached majority on the original PR; deciding vote cast by \`${deciderUsername}\`. ` +
      `This PR still needs a regular merge vote to land — vote in the app's group chat panel.\n\n` +
      `Reverts commit ${mergeSha}.`;

    const prData = await github.createPR(repoOwner, repoName, {
      branch: revertBranch,
      title: prTitle,
      body: prBody,
    });

    return {
      branch: revertBranch,
      prNumber: prData.number,
      prUrl: prData.html_url,
      prTitle,
    };
  } finally {
    await docker.execFileAsync('rm', ['-rf', tmpDir]).catch(() => {});
  }
}

// checkAndMerge is exported (in addition to voteRoutes) so the
// auto-conflict-resolver can re-attempt a merge for an already-approved
// PR after it syncs cleanly with main. Consumers should lazy-require
// this module from inside a function to avoid the votes <-> conflict-
// resolver circular-require load-order trap.
// createRevertPR is exported for tests (tests/github-mention-safety.test.js
// asserts its PR body never carries a live @mention).
module.exports = {
  voteRoutes,
  checkAndMerge,
  resolveIssueBounty,
  createRevertPR,
  finalizeMerge,
  // Focused revision-safety tests exercise the reconciliation without
  // driving the full HTTP router.
  reconcileNativeReviewedHead,
  reconcilePromotedSweepHead,
  classifyNativeHeadMove,
  reviewedHeadForSession,
  voteMatchesReviewedRevision,
  // Connector-submitted testing metadata on an import, unit-tested directly.
  parseImportTesting,
  recordVote,
};
