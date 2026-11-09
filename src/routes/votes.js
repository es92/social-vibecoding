const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const { connectionExhaustionMessage } = require('../db/connection-census');
const { ROLLOUT_RETRY_DETAIL } = require('../services/staging-recovery');
const { governanceVoteLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');
const github = require('../services/github');
const githubMock = require('../services/github-mock');
const docker = require('../services/docker');
const gitChild = require('../services/git-child');
const durableSteps = require('../services/durable-steps');
const { sendSystemMessage, pushNotificationToUser } = require('../services/ws');
const { getActiveUserStats, isUserActive } = require('../services/active-users');
const notifications = require('../services/notifications');
const { isAppLocked, hasAdminYesVote } = require('../services/admin-approval');
const events = require('../services/events');
const appAccess = require('../services/app-access');
const listTestResults = require('../services/list-test-results');
const communities = require('../services/communities');
const appAdmins = require('../services/app-admins');
const { effectiveSessionCaps } = require('../services/session-caps');
const topicAttrs = require('../services/topic-attributes');
const limits = require('../services/limits');
const { weekStartUtc } = require('../services/leaderboard-users');
const { usesMockGithubForImports } = require('../config');
const { drainGuard } = require('../services/lifecycle');
const inflightWork = require('../services/inflight-work');
const { isCliCredentialManagementSession } = require('../services/cli-api-policy');
const visibleChangesContract = require('../services/visible-changes');
const diagramContract = require('../services/diagram');
const proposalTouches = require('../services/proposal-touches');
const shotsState = require('../services/shots-state');
const shotsView = require('../services/shots-view');
const summaryFreshness = require('../services/summary-freshness');
const homeroomCommits = require('../services/homeroom-commits');
const proposalDelivery = require('../services/proposal-delivery');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const { updateComingSql, sessionChecksOnHead } = require('../services/homeroom-bot-progress');
const challengeScorer = require('../services/topochain/challenge-scorer');
const { botRequestedBySql } = require('../services/bot-requested-by');
const { firstVersionSql, isFirstVersion } = require('../services/first-version-rule');
const repoRef = require('../services/repo-ref');
const prBase = require('../workflow/rules/pr-base.ts');
const codeMissing = require('../services/code-missing');
const {
  reviewedHeadForSession,
  visualHeadForSession,
  currentVotePredicateSql,
  countedVotePredicateSql,
  sameSha,
} = require('../services/pr-vote-revision');

const CLI_CREDENTIAL_MANAGEMENT_ERROR = 'credential_management_not_available_via_cli';
const SHOTS_GATE_STATES = new Set(['verified', 'not_required', 'overridden']);

// Shots enforcement is deliberately scoped to proposals that have entered
// the v2 contract. Historical proposals with no declaration keep their old
// voting lifecycle; a proposal whose detail says shots are required must
// have before/after shots for the exact current head. People look at
// whether those shots show the declared change. The artifact route
// independently enforces the same revision fence.
function shotsGateForSession(config, session) {
  if (!config?.shots?.enforce) return { applies: false, allowed: true, state: null };
  const detail = session?.shots_detail;
  if (!detail || typeof detail !== 'object') return { applies: false, allowed: true, state: null };
  const required = detail.required !== false;
  const shotsState = session.shots_state || detail.state || 'planned';
  const currentHead = visualHeadForSession(session);
  const recordedHead = detail.headSha || null;
  const exactHead = !!currentHead && !!recordedHead && sameSha(currentHead, recordedHead);
  if (!required && shotsState === 'not_required' && exactHead) {
    return { applies: true, allowed: true, state: shotsState, currentHead, recordedHead };
  }
  const allowed = exactHead && SHOTS_GATE_STATES.has(shotsState);
  const reason = !exactHead
    ? 'The before & after shots have not been taken for the proposal’s current commit.'
    : shotsState === 'failed'
      ? (detail.failureReason || 'The before & after shots could not be taken; take them again, or an app administrator can waive them.')
      : `The before & after shots are ${String(shotsState).replace(/_/g, ' ')}.`;
  return { applies: true, allowed, state: shotsState, currentHead, recordedHead, reason };
}

async function readShotsGate(config, pool, session) {
  if (!config?.shots?.enforce) return shotsGateForSession(config, session);
  const { rows } = await pool.query(
    `SELECT source, imported_pr_head_sha, reviewed_head_sha,
            shots_state, shots_detail
       FROM chat_sessions WHERE id = $1`,
    [session.id]
  );
  return shotsGateForSession(config, { ...session, ...(rows[0] || {}) });
}

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
// #4313: a ?demo=1 Needs-you card's own page ("Open card"), so the read
// that opens it is answered rather than refused. The mock rows' shape, with
// the card's own words, no tally and nobody's chips: a demo card names no
// real people. Null for any id that is not one of the feed's demo cards on
// that card's own project.
function stagingDemoNeedsProposal(id, slug) {
  const { DEMO_NEEDS_FEED, isDemoNeedsProposal } = require('./workshop-overview');
  if (!isDemoNeedsProposal(id)) return null;
  const card = DEMO_NEEDS_FEED.find((it) => it.kind === 'proposal' && it.id === id);
  if (!card || card.app.slug !== slug) return null;
  const base = stagingMockProposals()[0];
  return {
    ...base,
    id, pr_number: null, pr_title: card.title, pr_summary_md: card.summary, pr_body: null,
    username: card.author || null, user_id: 0,
    created_at: card.at, promoted_at: card.at, approval_epoch: card.epoch,
    yes_count: card.yes || 0, no_count: card.no || 0, my_vote: null,
    chat_count: 0, last_message_at: null, votes_required: 1,
    priority: null, assignee: null, category: null,
  };
}

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
      + 'the new explanation that now appears at the top of a proposal, written '
      + 'in everyday words, with no technical jargon.',
    // The technical half, so a reviewer can see BOTH sections of the About
    // sheet on ?demo=1 rather than only the labelled one. Obviously fake and
    // deliberately written in the register the summary above must not use —
    // the contrast between the two is the thing being reviewed.
    pr_body: '## What changed\n\n- `renderTopicHead` now emits the summary '
      + 'behind its own label\n- `parseImportSummary` bounds the field at 600 '
      + 'characters\n\nSee `src/routes/votes.js` for the import path.',
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
    // #788: ordinary rows are not flagged; the three explicit-approval
    // mocks below override these.
    requires_explicit_approval: false,
    explicit_approval_reason: null,
    needs_other_member_yes: false,
    other_member_yes_count: null,
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
    // #1442: the freshness snapshot. Measured-and-clean by default, which
    // is what the great majority of real promoted proposals look like, so
    // adding these columns does not make every existing fixture render an
    // "unknown" caption. The four dedicated fixtures below override them so
    // each of the three states this issue is about is reviewable via
    // ?demo=1 rather than only reachable by waiting for main to move.
    mergeability: 'clean',
    mergeability_files: [],
    mergeability_files_complete: true,
    checks_base_sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    checks_base_verdict: 'current',
    checks_base_behind_by: 0,
    freshness_main_sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    freshness_merge_base_sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    freshness_behind_by: 0,
    freshness_ahead_by: 1,
    freshness_checked_at: hoursAgo(0),
    freshness_error: null,
    // Community-voted priority + assignee + category chips. Populated so
    // the card states are reviewable on staging via ?demo=1.
    priority: { top: 'high', count: 2, myValue: null },
    assignee: { top: 'staging-tester', count: 3, myValue: null },
    category: { top: 'improvement', count: 2, myValue: null },
  });
  // The four build steps every mock run shares: the live fifth-step row
  // (9000028 below) draws them under "Preparing the staging preview…", and
  // the finished shape a verdict keeps (#2170, applied after the literals)
  // sums them to "built in 20s". A fresh array per call, so no row can
  // mutate another's.
  const mockBuildSteps = () => [
    { key: 'source_fetch', ms: 2555 },
    { key: 'image_build', ms: 5372, phases: [
      { name: 'FROM docker.io/library/node:22-…', ms: 212 },
      { name: 'COPY . .', ms: 276 },
      { name: 'COPY --from=css /build/public/c…', ms: 3708 },
    ] },
    { key: 'clone', ms: 2426, via: 'template' },
    { key: 'health', ms: 9585 },
  ];
  const rows = [
    // Unopposed, thin support: threshold met but a multi-day visibility
    // window still running → "Goes live in ~2d" countdown pill.
    mk(9000001, 900101,
      '[Mock] Long-title test: rework the proposal card header so the '
      + 'discussion badge and vote tally wrap gracefully on narrow phones',
      3, 2, 0, 4, { required: 2, windowEndsAt: hoursAhead(46) }),
    // Near-majority, no opposition: window almost elapsed → short
    // "Goes live in Xh" countdown.
    // #1251: the only mock proposal that declares a linked issue. 900017 is
    // a mock issue nothing else touches, so this pair is what makes the
    // board's "an issue with an open proposal is still on the board"
    // behaviour visible in a ?demo=1 preview — the issue renders in In
    // progress, this card in In review, and the report prints it once.
    { ...mk(9000013, 900113,
      '[Mock] Near-majority test: tighten the proposal card spacing on tablet widths',
      20, 5, 0, 3, { required: 3, windowEndsAt: hoursAhead(5) }),
    linked_issues: [900017] },
    // Majority reached: no window, would merge immediately in prod.
    // my_vote is set on this one mock (#482) so the kanban "Waiting on you"
    // filter visibly removes a card in the ?demo=1 preview instead of
    // matching every mock proposal.
    { ...mk(9000014, 900114,
      '[Mock] Majority test: bump the vote pill contrast for accessibility',
      6, 6, 0, 2, { required: 5, windowEndsAt: null }), my_vote: 'up' },
    // Lazy consensus: BELOW the eased threshold (1 of 2 yes) but unopposed —
    // the count-based lazy clock is running, so the pill shows the countdown
    // with the tally riding along ("Goes live in ~2d · 1/2").
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
    // A change with a description and no short summary, and no plan: its
    // page folds the description under the line that says so ("The
    // current description is below.") rather than pointing at a Details
    // section the page does not draw.
    {
      ...mk(9000096, 900196,
        '[Mock] No-summary test: a description but no short summary yet',
        3, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(62) }),
      pr_summary_md: null,
    },
    // #1688: the viewer said yes to an EARLIER version of this one, and the
    // author has since pushed a new one. Their vote is on the row but no
    // longer counted, so the card's button asks "Still yes?" instead of
    // "Vote" — reviewable on staging via ?demo=1.
    {
      ...mk(9000039, 900139,
        '[Mock] Re-confirm test: you said yes to an earlier version of this proposal',
        30, 0, 0, 2, { required: 2, windowEndsAt: null }),
      my_prior_vote: 'yes',
    },
    // Test accounts: the viewer is a test account and a real person made the
    // app, so their vote is recorded but not counted, and the vote picker
    // says "Test account: this vote won't count." — reviewable on staging via
    // ?demo=1 without signing in as one.
    {
      ...mk(9000040, 900140,
        '[Mock] Test-account vote: your vote here is recorded but will not count',
        8, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(64) }),
      my_vote_uncounted: true,
    },
    // #4747: an advisory vote — the viewer is not one of the people who
    // decide here (an invited project's approvers are), so their vote is
    // recorded and shown but does not decide this one, and the vote picker
    // says so. Reviewable on staging via ?demo=1.
    {
      ...mk(9000047, 900147,
        '[Mock] Advisory vote: only approvers decide this one',
        6, 0, 0, 1, { required: 2, windowEndsAt: hoursAhead(66) }),
      approval_policy: 'invited',
      my_vote_advisory: true,
    },
    // One No vote: eased threshold restored, window pushed back out.
    {
      ...mk(9000002, 900102,
        '[Mock] Long-title test: walk brand-new collaborators through '
        + 'voting, kudos and dev sessions step by step',
        11, 1, 1, 0, { required: 5, windowEndsAt: hoursAhead(120) }),
      // The description changed after this summary was written. Keep its
      // useful words beside a freshness note on the ?demo=1 proposal page.
      pr_summary_md: 'Makes vote buttons easier to read on long proposal titles.',
      pr_summary_previous_md: 'Makes vote buttons easier to read on long proposal titles.',
      pr_summary_stale: true,
      pr_body: '## What changed\n\nThe proposal now covers the newer revision.',
    },
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
    // 1/3 keep-alive line): long rejection window → "Set aside in ~6d".
    // It also carries a cost, the one state a viewer of a demo row cannot reach
    // otherwise: a real figure goes to its author and admins only (#6116).
    {
      ...mk(9000016, 900116,
        '[Mock] Rejection test: replace the home feed with an infinite-scroll redesign',
        30, 2, 3, 6, { required: 6, rejectEndsAt: hoursAhead(140), rejectionArmed: true }),
      cost_total_cents: 124,
    },
    // Auto-takedown — lopsided opposition (No heavily outweighs Yes): short
    // rejection window → "Set aside in ~Xh".
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
      explicit_approval_reason: 'admins',
      needs_other_member_yes: true,
      other_member_yes_count: 0,
    },
    // (b) Threshold met. No visibility window to sit out — it goes
    // straight to "queued to merge shortly" the moment the third Yes
    // lands, instead of starting a multi-day countdown.
    {
      ...mk(9000031, 900131,
        '[Mock] Explicit-approval test: remove an app admin (threshold reached)',
        26, 3, 0, 4, { required: 3 }),
      requires_explicit_approval: true,
      explicit_approval_reason: 'admins',
      needs_other_member_yes: true,
      other_member_yes_count: 2,
    },
    // (c) Rejection still applies. The auto-takedown countdown is
    // untouched by the modifier, so a flagged proposal the group is
    // voting down still shows "Set aside in ~Xh" and still auto-closes.
    {
      ...mk(9000032, 900132,
        '[Mock] Explicit-approval test: admins change nobody wants (rejecting)',
        22, 0, 3, 3, { required: 3, rejectEndsAt: hoursAhead(9), rejectionArmed: true }),
      requires_explicit_approval: true,
      explicit_approval_reason: 'admins',
      needs_other_member_yes: true,
      other_member_yes_count: 0,
    },
    // (d) Threshold met, floor not (#3826). All three Yes votes are the
    // author's, so the tally reads full while the member floor is still
    // unmet: the card says "Needs another member's Yes" (a viewer who has
    // voted) or "Needs your Yes" (one who has not), instead of a bare
    // "3 / 3" that reads as passed. No window, like (a) and (b).
    {
      ...mk(9000095, 900195,
        '[Mock] Explicit-approval test: votes all in, waiting on another member (floor unmet)',
        21, 3, 0, 2, { required: 3 }),
      requires_explicit_approval: true,
      explicit_approval_reason: 'visibility',
      needs_other_member_yes: true,
      other_member_yes_count: 0,
    },
    // ── #1442 freshness fixtures ───────────────────────────────────────
    //
    // The three states the issue is about, each of which used to be
    // invisible on a promoted proposal because nothing re-measured it. They
    // exist as fixtures because none of them can be reached in a preview by
    // clicking: they need main to move underneath a proposal that is already
    // waiting for votes.
    //
    // (a) Behind main but still merging cleanly. This is the mild case, and
    // the one the old card got LOUDEST about — being behind used to render
    // an amber "Behind main · N" block reason, which meant the pill said
    // "attention" for something that resolves itself. It is now a plain
    // caption and the vote tally stays visible.
    {
      ...mk(9000033, 900133,
        '[Mock] Freshness test: eight commits behind main, still merges cleanly',
        6, 2, 0, 3, { required: 3, windowEndsAt: hoursAhead(20) }),
      behind_main: 8,
      freshness_behind_by: 8,
      freshness_main_sha: 'bbbb2222cccc3333dddd4444eeee5555ffff6666',
      freshness_merge_base_sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      mergeability: 'clean',
    },
    // (b) The issue's own proposal: behind main AND predicted to conflict.
    // The seven paths are the ones `git merge-tree` reported for PR #1431,
    // so the conflicting-file list renders at a realistic length. This is a
    // PREDICTION, which is why it sets `mergeability` and NOT
    // merge_conflict_state — nothing has attempted a merge, so the
    // merge queue must not read this row as a conflict to resolve.
    {
      ...mk(9000034, 900134,
        '[Mock] Freshness test: conflicts with main in seven files',
        9, 3, 0, 5, { required: 4 }),
      behind_main: 8,
      freshness_behind_by: 8,
      freshness_main_sha: 'bbbb2222cccc3333dddd4444eeee5555ffff6666',
      freshness_merge_base_sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      mergeability: 'conflict',
      mergeability_files: [
        'public/js/app-view.js',
        'public/js/merge-status.js',
        'src/routes/votes.js',
        'src/services/mcp-tools.js',
        'src/services/visuals.js',
        'src/db/schema.sql',
        'dapp.json',
      ],
      mergeability_files_complete: true,
    },
    // (e) #2038: the three states the SERVER now names, rather than the
    // browser guessing from a precedence table. Each carries its own
    // measuredAt, because the card says how old the answer is — a number
    // stated without its age is a claim about the present that a cache
    // cannot support, and that was the whole shape of the "the UI is out of
    // sync" reports.
    {
      ...mk(9000081, 900181,
        '[Mock] #2038: the votes are in, the checks are still running',
        4, 3, 0, 3, { required: 3 }),
      integration_measured_at: new Date(Date.now() - 40 * 1000).toISOString(),
      integration_behind_by: 0,
      integration_merges_clean: true,
      check_state: 'pending',
    },
    {
      ...mk(9000082, 900182,
        '[Mock] #2038: approved, and being brought up to date with main',
        5, 3, 0, 3, { required: 3 }),
      integration_measured_at: new Date(Date.now() - 5 * 1000).toISOString(),
      integration_behind_by: 6,
      integration_merges_clean: true,
      integration_block_reasons: ['integrating'],
    },
    {
      ...mk(9000083, 900183,
        '[Mock] #2038: GitHub refused the merge, measured ten minutes ago',
        7, 3, 0, 3, { required: 3 }),
      integration_measured_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      integration_behind_by: 12,
      integration_merges_clean: false,
      integration_conflict_paths: ['src/routes/votes.js', 'public/js/merge-status.js'],
      // Derived by the card from this column, not restated by the server.
      merge_conflict_state: 'conflict',
    },
    // (f) #2061: what a proposal still NEEDS, rather than only what is
    // currently wrong with it. Each carries a merge_requirements record in
    // exactly the shape the merge gate writes, so the card's checklist — and
    // the three declared checks over it — are reviewable on ?demo=1 without
    // manufacturing a locked app or an unset platform variable.
    //
    // The four differ in WHO is waiting, which is the axis the whole feature
    // turns on: the card opens itself only for the person who can act.
    {
      ...mk(9000091, 900191,
        '[Mock] #2061: nothing needs you — being brought up to date',
        3, 3, 0, 2, { required: 3 }),
      merge_requirements: {
        context: { explicitApproval: false, locked: false, selfHosted: true },
        evaluated: [
          { key: 'approvals', state: 'done', detail: { note: '3 of 3' } },
          { key: 'integration', state: 'active', detail: { behindBy: 2, note: '2 commits behind, so the platform is merging main in' } },
        ],
      },
      merge_requirements_at: new Date(Date.now() - 20 * 1000).toISOString(),
    },
    {
      ...mk(9000092, 900192,
        '[Mock] #2061: waiting on an admin, because this app is locked',
        6, 4, 0, 3, { required: 3 }),
      merge_requirements: {
        context: { explicitApproval: false, locked: true, selfHosted: false },
        evaluated: [
          { key: 'approvals', state: 'done', detail: { note: '4 of 3' } },
          { key: 'admin_yes', state: 'waiting', detail: { note: 'This app is locked, so an admin has to vote yes as well' } },
        ],
      },
      merge_requirements_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    },
    {
      ...mk(9000093, 900193,
        '[Mock] #2061: waiting on the author — checks are failing',
        5, 3, 0, 4, { required: 3 }),
      check_state: 'failing',
      // The preview its failing checks ran on, so the Testing card's "Open
      // the page it checked" link is reviewable on ?demo=1 (the URL is
      // deliberately unroutable, like the other mock previews).
      staging_url: 'https://mock-preview.invalid',
      // What the model writes for this run (services/checks-explanation.js),
      // served by the ?demo=1 branch of GET /api/sessions/:id/checks-explanation.
      // The expected-versus-found shape the prompt asks for: the words the
      // check looked for beside the words the page showed.
      checks_explanation: 'The sample page should say “is blocked at ‘Audit all three lockfiles’”, but it only says “Release blocked”.',
      // #3978: the failing rows carry their diagnosis, and the unit-suite
      // row carries its per-test excerpts, so the "Why it failed" fold on
      // this route shows what a real failing proposal shows. Kept in the
      // shape services/unit-suite.js shapes and the connector reads.
      test_results: [
        {
          name: 'Kudos totals survive a rename', path: '/dev', status: 'fail',
          failureReason: 'Expected element "[data-kudos-total]" was not found',
          consoleErrors: [],
        },
        {
          name: 'The board folds on a narrow screen', path: '/dev', status: 'fail',
          failureReason: '1 console error on load',
          consoleErrors: [
            { kind: 'pageerror', message: 'TypeError: Cannot read properties of undefined (reading \'rows\')', source: 'dev-kanban.tsx' },
          ],
        },
        // Two green rows with something to say (services/check-signals.js):
        // one failed in a burst at the start of the run and passed all three
        // retries (often the environment, never proof of it), and one this proposal
        // adds that held only on a fresh load after its address change.
        {
          name: 'The board opens on the Workshop', path: '/dev', status: 'pass',
          runs: 4, passes: 3, fails: 1, flakyRun: true, passedOnRetry: true, retryClass: 'early_burst',
          failureReason: '', consoleErrors: [],
        },
        {
          name: 'Kudos totals open on the leaderboard tab', path: '/#leaderboard/kudos', status: 'pass',
          cohortFallback: { waitMs: 12400, ms: 17800 }, authored: true,
          failureReason: '', consoleErrors: [],
        },
        {
          index: -3,
          name: 'Repo unit suite (npm test) passes', path: 'package.json', status: 'fail',
          advisory: false, consoleErrors: [],
          failureReason: 'tests/kudos-totals.test.js (3): kudos totals survive a rename | # tests 20913 | # pass 20910 | # fail 3 | # cancelled 0',
          failureDetails: [
            {
              file: 'tests/kudos-totals.test.js',
              test: 'kudos totals survive a rename',
              excerpt: [
                "    error: 'expected 42 to equal 41',",
                "    code: 'ERR_ASSERTION',",
                "    actual: 42,",
                "    expected: 41,",
                "    failureType: 'testCodeFailure',",
                '    stack: |',
                "      AssertionError [ERR_ASSERTION]: expected 42 to equal 41",
                '          at Test.<anonymous> (tests/kudos-totals.test.js:88:5)',
                '  — stdout just before the failure —',
                'renaming @mara → @mara-renamed: kudos rows moved 3',
                'recount after rename: total=42 (expected 41)',
              ].join('\n'),
            }, {
              file: 'tests/kudos-totals.test.js',
              test: 'the kudos figure hides when a rename removes every row',
              excerpt: [
                "  location: '/tmp/tmp.fixture/tests/kudos-totals.test.js:104:1'",
                "  error: 'expected 0 to equal null',",
                "  code: 'ERR_ASSERTION',",
                '  stack: |',
                '      AssertionError [ERR_ASSERTION]: expected 0 to equal null',
              ].join('\n'),
            }, {
              file: 'tests/kudos-totals.test.js',
              test: 'a rename keeps the leaderboard order',
              excerpt: [
                "  location: '/tmp/tmp.fixture/tests/kudos-totals.test.js:141:1'",
                "  error: 'expected [ 3, 2, 1 ] to deeply equal [ 3, 1, 2 ]',",
                "  code: 'ERR_ASSERTION',",
                '  stack: |',
                '      AssertionError [ERR_ASSERTION]: expected [ 3, 2, 1 ] to deeply equal [ 3, 1, 2 ]',
              ].join('\n'),
            },
          ],
        },
      ],
      merge_requirements: {
        context: { explicitApproval: false, locked: false, selfHosted: false },
        evaluated: [
          { key: 'approvals', state: 'done', detail: { note: '3 of 3' } },
          { key: 'integration', state: 'done', detail: { note: 'level with main, merges cleanly' } },
          { key: 'checks', state: 'blocked', detail: { checkState: 'failing', failingCount: 3, note: '3 failing. They re-run on the next push' } },
        ],
      },
      merge_requirements_at: new Date(Date.now() - 90 * 1000).toISOString(),
    },
    {
      ...mk(9000094, 900194,
        '[Mock] #2061: everything cleared, merging now',
        2, 3, 0, 1, { required: 3 }),
      merge_requirements: {
        context: { explicitApproval: false, locked: false, selfHosted: false },
        evaluated: [
          { key: 'approvals', state: 'done', detail: { note: '3 of 3' } },
          { key: 'integration', state: 'done', detail: { note: 'level with main, merges cleanly' } },
          { key: 'checks', state: 'done', detail: { checkState: 'passing' } },
          { key: 'github', state: 'done', detail: { note: 'merged' } },
        ],
      },
      merge_requirements_at: new Date(Date.now() - 8 * 1000).toISOString(),
    },
    // (c) Checks passed, against a base main has since moved past. The
    // verdict is real and the tests did pass; what they passed against is no
    // longer what this would merge into. Soft on purpose: it is a caveat on
    // a green result, not a failure, so it never blocks the vote.
    {
      ...mk(9000035, 900135,
        '[Mock] Freshness test: checks passed on a base main has moved past',
        14, 2, 0, 2, { required: 3, windowEndsAt: hoursAhead(30) }),
      checks_base_sha: '1111aaaa2222bbbb3333cccc4444dddd5555eeee',
      checks_base_verdict: 'superseded',
      checks_base_behind_by: 12,
      freshness_main_sha: 'bbbb2222cccc3333dddd4444eeee5555ffff6666',
      behind_main: 3,
      freshness_behind_by: 3,
    },
    // (d) Nothing measured yet, plus a recorded failure. GitHub answers
    // `mergeable: null` while it computes a merge, and the whole point of
    // the nullable columns is that this reads as "not measured" rather than
    // as "clean" — a fixture exists so the unknown wording is reviewable
    // instead of only appearing during a GitHub outage.
    {
      ...mk(9000036, 900136,
        '[Mock] Freshness test: freshness not measured yet (GitHub unreachable)',
        1, 1, 0, 0, { required: 3 }),
      mergeability: 'unknown',
      mergeability_files: [],
      mergeability_files_complete: null,
      checks_base_verdict: 'unknown',
      checks_base_behind_by: null,
      freshness_behind_by: null,
      freshness_ahead_by: null,
      freshness_main_sha: null,
      freshness_merge_base_sha: null,
      freshness_error: 'Could not read the repository from GitHub (request failed).',
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
    // check_phase absent on purpose: it is the NULL/legacy-wording case, and
    // it carries no check_trigger either — the pre-#1144 rows that predate the
    // column render with no "why is this running" caption at all.
    //
    // #1144: check_trigger is the other half of the pending detail. A run that
    // the platform started for itself (a boot reconcile, a stuck sweep) used to
    // be indistinguishable from one the author asked for, which is exactly the
    // confusion that made re-runs look like flakes. These two rows carry the
    // two ends of that range — an author's commit, and a platform restart.
    {
      ...mk(9000022, 900122,
        '[Mock] Checks-phase test: preparing the staging preview (build + DB clone)',
        0.06, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(70) }),
      check_state: 'pending',
      check_phase: 'building',
      check_trigger: 'commit-push',
      recheckable: true,
      test_results: [],
      checks_checked_at: hoursAgo(0.02),
    },
    {
      // 9000026, not 9000023: the "at least N approvals" fixture further
      // down already owns 9000023, and a duplicate id meant this row won the
      // render — an approvals proposal that permanently showed
      // "Checks running…" instead of its approvals pill.
      ...mk(9000026, 900126,
        '[Mock] Checks-phase test: running the automated tests against the preview',
        0.06, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(70) }),
      check_state: 'pending',
      check_phase: 'testing',
      check_trigger: 'stuck-sweep',
      recheckable: true,
      test_results: [],
      checks_checked_at: hoursAgo(0.02),
      // #4452: a run part way through its checks, so the change page's one
      // testing bar (the build done, the checks about a third of the way)
      // and its time left are reviewable via ?demo=1.
      checks_progress: {
        ran: 284, passed: 284, failed: 0, expected: 840,
        unit: { phase: 'running', ran: 6900, passed: 6900, failed: 0, skipped: 0, expected: 19240, done: false },
        build: {
          step: 'done',
          steps: [...mockBuildSteps(), { key: 'prepare_checks', ms: 3011 }],
          totalMs: 19964,
        },
        updatedAt: hoursAgo(0.01),
      },
    },
    // The fifth build step. The container is up (four steps done, 20s) but
    // the run is parked behind an earlier capture on the same proposal —
    // the state the card used to spend minutes in reading "4/4" under
    // "Preparing the staging preview…". The step row names the wait; the
    // only way to review it, since a real preview has no queued run to show.
    {
      ...mk(9000028, 900128,
        '[Mock] Checks-phase test: preview built, waiting behind an earlier run',
        0.06, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(70) }),
      check_state: 'pending',
      check_phase: 'building',
      check_trigger: 'pr-import',
      recheckable: true,
      test_results: [],
      checks_checked_at: hoursAgo(0.02),
      checks_progress: {
        build: {
          step: 'prepare_checks',
          queued: true,
          startedAt: hoursAgo(0.015),
          steps: mockBuildSteps(),
          totalMs: 19964,
        },
        updatedAt: hoursAgo(0.015),
      },
    },
    // The wait between the halves: the preview is built and the run is in
    // the checks queue, two runs ahead of it (services/checks-queue.js). A
    // real preview only shows this under load, so this row is how the
    // "Waiting for a checks slot" wording is reviewable.
    {
      ...mk(9000054, 900154,
        '[Mock] Checks-phase test: preview built, waiting for a checks slot',
        0.06, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(70) }),
      check_state: 'pending',
      check_phase: 'queued',
      check_trigger: 'commit-push',
      recheckable: true,
      test_results: [],
      checks_checked_at: hoursAgo(0.05),
      checks_progress: {
        build: {
          step: 'done',
          steps: [...mockBuildSteps(), { key: 'prepare_checks', ms: 2140 }],
          totalMs: 19964,
        },
        queue: { ahead: 2, since: hoursAgo(0.05) },
      },
    },
    // #4502: a reproducible deferred Testing card. A real conflict can be
    // resolved before a reviewer opens the preview; this explicitly synthetic
    // row exists only in the existing staging ?demo=1 feed and detail route.
    {
      ...mk(9000055, 900155,
        '[Mock] Checks deferred: preview ready, waiting for conflicts to clear',
        0.06, 1, 0, 0, { required: 2, windowEndsAt: hoursAhead(70) }),
      check_state: 'pending',
      check_phase: 'deferred',
      check_trigger: 'commit-push',
      test_results: [],
      checks_checked_at: hoursAgo(0.05),
      integration_merges_clean: false,
      integration_behind_by: 2,
      integration_conflict_paths: ['example/change.js'],
      integration_measured_at: hoursAgo(0.05),
      mergeability: 'conflict',
      mergeability_files: ['example/change.js'],
      mergeability_files_complete: true,
      checks_progress: {
        build: { step: 'done', steps: mockBuildSteps(), totalMs: 19964 },
      },
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
    // #1771: the same red badge, for the one cause that is NOT the author's
    // to fix. A staging preview starved of Postgres connections used to
    // record its 500s as assertion failures against the diff; it is an
    // 'error' with an attribution sentence now, and this row is how that
    // sentence is reviewable in a preview. The detail comes from the
    // function that writes the real ones, so the fixture cannot drift from
    // the copy an author actually sees.
    {
      ...mk(9000045, 900145,
        '[Mock] Checks-error test: the preview was starved of database connections',
        4, 1, 0, 1, { required: 2 }),
      check_state: 'error',
      check_error_detail: connectionExhaustionMessage(
        { max: 100, used: 98 }, { where: 'ran its checks' }
      ),
      recheckable: true,
      test_results: [],
    },
    // The other red badge that is not the author's to fix: a run that
    // overlapped a platform rollout and came back red was stored as 'error'
    // and runs again on its own (#3828). Nothing writes that any more, but
    // rows stored before still read this way until they run again, so this
    // row keeps the sentence reviewable. It reads the constant those rows
    // carry, so the copy cannot drift.
    {
      ...mk(9000046, 900146,
        '[Mock] Checks-error test: the checks ran while Homeroom was updating',
        4, 1, 0, 1, { required: 2 }),
      check_state: 'error',
      check_error_detail: ROLLOUT_RETRY_DETAIL,
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
      check_error_detail: 'branch has no commits beyond main, so there is nothing to test',
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
      ...mk(9000027, 900127,
        '[Mock] Inherited-attrs test: promoted from issue #900006 — chips carry over',
        7, 2, 0, 1, { required: 2, windowEndsAt: hoursAhead(50) }),
      linked_issues: [900006],
      priority: { top: 'medium', count: 2, myValue: null },
      assignee: { top: 'maya-builder', count: 3, myValue: null },
    },
    // #866: the three states of the Preview slot on an IMPORTED proposal.
    //
    // Mock rows carry the derived flags explicitly (staging.previewDisplayState
    // derives `staging_building` from the row's checks phase), which is the
    // simplest way to review all three pills in a staging preview.
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
    // does (the preview machine's prepareFailed writes both).
    {
      ...mk(9000043, 900143,
        '[Mock] Imported-preview test: preview failed to build — unavailable chip + retry',
        2, 1, 0, 1, { required: 3 }),
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
      testing_md: '1. Open the board. The new "Snap to grid" toggle sits above the columns.\n'
        + '2. Turn it on and drag a card: it should snap to the nearest column.\n'
        + '3. Reload the page. The toggle keeps its setting.',
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
    // A row with several reasons at once, which no other mock has. It was
    // added when the status bar named ONE reason and counted the rest in a
    // tooltip; it proves the opposite now — the bar is the vote, and every
    // reason is its own tag, colour-coded by whether it blocks the merge. The
    // three here are deliberately one hard and two soft, so a preview shows
    // both tints beside a live tally.
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
    // Band overload: the worst case for the four-band card, in one row. A
    // title long enough to need a THIRD line (so the two-line clamp is
    // visibly doing something), a long meta line, all four metadata chips,
    // two linked issues AND the widest action set a card can carry (Yes / No
    // / Explore / Preview) — so a preview shows whether any band clips a
    // pill through the middle rather than dropping the surplus row whole.
    // Every other mock exercises one band; this one loads all four at once.
    {
      ...mk(9000053, 900153,
        '[Mock] Band-overload test: a deliberately enormous proposal title that runs '
        + 'well past two lines in a kanban column so the clamp, the reserved band '
        + 'heights and the pill clipping can all be judged on one card',
        2, 2, 1, 7, { required: 4, windowEndsAt: hoursAhead(28) }),
      linked_issues: [900004, 900005],
      staging_url: 'https://mock-preview.invalid',
      priority: { top: 'high', count: 4, myValue: null },
      assignee: { top: 'maya-builder', count: 2, myValue: null },
      category: { top: 'staging demo onboarding', count: 3, myValue: null },
    },
    // #4490: the picture a change shows when it has no before & after
    // shots, reviewable on staging via ?demo=1 (Needs you, and the change's
    // own page). The first carries its author's diagram, a rename; the second
    // none, so it shows "What it touches", drawn from its files, and says
    // nothing on screen changes. Newest of the mocks, so they lead the feed.
    {
      ...mk(9000490, 900490,
        '[Mock] Diagram test: rename "spec" to "plan" everywhere people read it',
        0.2, 1, 0, 0, { required: 3, windowEndsAt: null }),
      pr_summary_md: 'Everywhere you used to see "spec" in the app, such as chat cards, buttons, requests, '
        + 'notifications, sharing and Settings, it now says "plan".',
      diagram: {
        version: 1, kind: 'rename', from: 'spec', to: 'plan',
        places: ['Chat cards', 'Buttons', 'Requests', 'Notifications', 'Sharing', 'Settings'],
        note: 'Only the words change. Layout and behaviour stay the same.',
      },
      diagram_source: 'author',
    },
    {
      ...mk(9000491, 900491,
        '[Mock] What-it-touches test: retry brief database hiccups while shots copies are set up',
        0.3, 1, 0, 0, { required: 3, windowEndsAt: null }),
      pr_summary_md: 'Before & after shots no longer fail when the database blinks for a moment while '
        + 'their copies are being made.',
      shots_detail: { intent: { version: 1, impact: 'none', rationale: 'A retry inside the shots set-up; nothing on screen changes.', stories: [] } },
      touches: {
        version: 1,
        files: 3,
        areas: [
          { key: 'screens', label: 'Screens', files: 0, lines: 0 },
          { key: 'server', label: 'Server', files: 2, lines: 64 },
          { key: 'database', label: 'Database', files: 0, lines: 0 },
          { key: 'tests', label: 'Tests', files: 1, lines: 38 },
          { key: 'docs', label: 'Docs', files: 0, lines: 0 },
          { key: 'other', label: 'Other', files: 0, lines: 0 },
        ],
      },
    },
    // #4490: a change nobody sees, drawn from its author's Mermaid text.
    {
      ...mk(9000492, 900492,
        '[Mock] Mermaid test: retry a copy that hiccups before the shots are taken',
        0.4, 0, 0, 0, { required: 3, windowEndsAt: null }),
      pr_summary_md: 'A shots copy that fails for a moment is tried again up to three times before the run gives up.',
      shots_detail: { intent: { version: 1, impact: 'none', rationale: 'A retry inside the shots set-up; nothing on screen changes.', stories: [] } },
      diagram: {
        version: 1,
        kind: 'mermaid',
        source: 'flowchart TD\n  A[Copy database] --> B{Hiccup?}\n  B -- no --> C[Take shots]\n  B -- yes --> D[Retry up to 3 times]\n  D --> B\n  D -- still failing --> E[Report failure]',
      },
      diagram_source: 'author',
    },
    // #4772: two changes OWNED by the viewer (ownDemoProposals), for the
    // Workshop's sections of their work: one up for a vote with its checks
    // passing (Yours, up for a vote), and one whose checks fail, which waits
    // on its author for a fix (Waiting on you). Without an owner they are
    // ordinary mocks nobody owns.
    mk(9000493, 900493,
      '[Mock] Your change up for a vote: show the meeting date on each book',
      0.5, 1, 0, 0, { required: 3, windowEndsAt: null }),
    {
      ...mk(9000494, 900494,
        '[Mock] Your change needs a fix: its checks are failing',
        0.6, 0, 0, 0, { required: 3, windowEndsAt: null }),
      check_state: 'failing',
      // The app's own tests failed on one test, so its page says what went
      // wrong in plain words and offers its author Fix it, which needs the
      // build conversation the change was made in (990804 is the staging
      // fixture's, migrate.js seedStagingAgentFailingChecks). The sentence
      // is what the model writes for such a run (services/
      // checks-explanation.js), served by the ?demo=1 branch of
      // GET /api/sessions/:id/checks-explanation, since a preview has none.
      agent_session_id: 990804,
      checks_explanation: 'Every message the app shows needs a Spanish version, and this one doesn’t have one yet: “Pick a date, or choose I don’t remember.”',
      test_results: [
        { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [] },
        {
          index: -3,
          name: 'Repo unit suite (npm test) passes', path: 'package.json', status: 'fail',
          advisory: false, consoleErrors: [],
          failureReason: 'tests/i18n.test.js (1): every message the server can send has a Spanish wording | # tests 26 | # pass 25 | # fail 1 | # cancelled 0',
          failureDetails: [
            {
              file: 'tests/i18n.test.js',
              test: 'every message the server can send has a Spanish wording',
              excerpt: [
                '  duration_ms: 0.905959',
                "  type: 'test'",
                "  location: '/tmp/tmp.p7vv74EHLR/tests/i18n.test.js:133:1'",
                "  failureType: 'testCodeFailure'",
                "  error: \"Spanish for: Pick a date, or choose I don't remember.\"",
                "  code: 'ERR_ASSERTION'",
                "  name: 'AssertionError'",
                '  expected: true',
                "  operator: '=='",
                '  stack: |-',
                '    /tmp/tmp.p7vv74EHLR/tests/i18n.test.js:142:12',
                '    Set.forEach (<anonymous>)',
              ].join('\n'),
            },
          ],
        },
      ],
    },
    // #6006: a third change OWNED by the viewer, which a coding agent
    // submitted for them, up for a vote with its checks passing. Proposing it
    // that way was not their yes, so it waits on them (Waiting on you, "Needs
    // your Yes") rather than moving on without them.
    {
      ...mk(9000495, 900495,
        '[Mock] Your change from Claude Code: waiting for your Yes',
        0.4, 0, 0, 0, { required: 3, windowEndsAt: null }),
      external_agent: 'claude-code',
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
  // #2170: the run's cost survives its verdict — storeChecks reduces the
  // live progress to the finished build and the checks' wall clock instead
  // of dropping it — so every mock that HAS a verdict carries the shape a
  // real passed or failed row does, and the ledger's "built in 20s ·
  // checked in 4m 12s" line is reviewable via ?demo=1. Applied after the
  // literals, like the attribute overrides above, because mk() cannot
  // stamp it without leaking into the pending mocks: a run in flight keeps
  // its live shape (9000028) or has none, exactly as a real one would.
  for (const row of rows) {
    if ((row.check_state === 'passing' || row.check_state === 'failing') && row.checks_progress === undefined) {
      row.checks_progress = {
        build: { step: 'done', steps: [...mockBuildSteps(), { key: 'prepare_checks', ms: 3011 }], totalMs: 19964 },
        checksMs: 252000,
      };
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

// #4772: the ?demo=1 mocks the viewer owns (`user`, { id, username }, when
// known), so the Workshop's sections of their work are reviewable: one up
// for a vote, one that needs their fix, and (#6006) one a coding agent
// submitted that waits for their Yes. Without a user they stay mocks nobody
// owns.
const OWN_DEMO_PROPOSALS = new Set([9000493, 9000494, 9000495]);
function ownDemoProposals(rows, user) {
  if (!user || user.id == null || !user.username) return rows;
  return rows.map((row) => (OWN_DEMO_PROPOSALS.has(row.id)
    ? { ...row, user_id: user.id, username: user.username } : row));
}

// One ?demo=1 proposal, as `user` reads it, or null: for a route outside
// this file that answers for a mock (sessions.js's checks explanation).
function stagingMockProposalFor(id, user) {
  return ownDemoProposals(stagingMockProposals(user && user.username), user).find((m) => m.id === id) || null;
}

// The ?demo=1 merged change that waits for the platform's next release.
const DEMO_GOING_LIVE_ID = 9100035;
// ?demo=1: a merge stuck behind a red release run (annotateDeploymentState's
// release_block), in the words the lockfile gate writes.
const DEMO_RELEASE_BLOCKED_ID = 9100038;
const DEMO_RELEASE_BLOCK = Object.freeze({
  job: 'Audit all three lockfiles',
  step: 'Run node scripts/security-audit.js',
  reason: 'example-package@1.0.0: GHSA-demo-demo-demo (staging demo)',
  runUrl: null,
});

// #194: staging demo rows for the Completed (merged) list, mirroring
// stagingMockProposals. Lets ?demo=1 verify the new clickable Completed
// rows, the chevron/hover affordance, and the 💬 badge against a
// prod-cloned DB. Caveat: these mock rows have NO backing chat_messages,
// so opening one shows an empty (but still postable) thread — useful for
// the card affordance + badge, not for existing-comment display.
function stagingMockMerged(viewer) {
  const daysAgo = (d) => new Date(Date.now() - d * 86400 * 1000).toISOString();
  const mk = (id, prNumber, title, days, chat) => ({
    id,
    pr_number: prNumber,
    pr_url: null,
    pr_title: title,
    pr_summary_md: 'This is a sample plain-language summary so testers can see '
      + 'the new explanation at the top of a completed proposal, in everyday '
      + 'words, with no technical jargon.',
    user_id: 0,
    status: 'merged',
    linked_issues: null,
    username: 'staging-tester',
    created_at: daysAgo(days),
    // #1264: mocks merge the moment they were created — good enough for
    // reviewing the report's "Merged <date>" label and monthly strip.
    merged_at: daysAgo(days),
    promoted_at: daysAgo(days),
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
  // #4505: an owned merged outcome for the existing staging demo. One
  // labelled mock belongs to the signed-in viewer, so catch-up can show
  // "yours" after it leaves ongoing work. Both list and detail use the same
  // owner; without a complete viewer the historical sample author remains.
  if (viewer?.id != null && viewer.username) {
    autoMerged.user_id = viewer.id;
    autoMerged.username = viewer.username;
  }
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
  // #1264: older completed rows (~35–150 days) so the report's
  // "Completed by month" strip shows several distinct months in a ?demo=1
  // preview instead of one bar. A little kudos variety rides along so the
  // report's new "N kudos" meta is reviewable too.
  const older = [
    [9100030, 910130, '[Mock] Completed: rework the onboarding checklist', 35, 2],
    [9100031, 910131, '[Mock] Completed: ship the notification digest', 70, 0],
    [9100032, 910132, '[Mock] Completed: split settings into sections', 110, 3],
    [9100033, 910133, '[Mock] Completed: first pass at the activity feed', 150, 0],
  ].map(([id, pr, title, days, kudos]) => ({
    ...mk(id, pr, title, days, 0),
    kudos_count: kudos,
  }));
  // #1264: a LEGACY completed row — merged before merged_at existed, so it
  // carries no merge time. Keeps the report's "Started <date>" fallback and
  // its conditional disclaimer reviewable in a preview.
  const legacy = {
    ...mk(9100034, 910134,
      '[Mock] Completed: legacy change with no recorded merge time', 95, 0),
    merged_at: null,
  };
  // A change merged into Homeroom itself a minute ago and not live yet: it
  // goes live with the next release, which the gap puts eight minutes off
  // (release-watch.js demoRelease). Its page says so where anyone can read
  // it, "Merged; goes live in the next release (about 8 minutes)". The
  // /merged demo block and the by-id read give it that release.
  // 9100035 is DEMO_GOING_LIVE_ID, spelled out: this builder runs on its own
  // (tests/staging-demo-id-ranges.test.js).
  const goingLive = {
    ...mk(9100035, 910135,
      '[Mock] Going-live test: merged into Homeroom, live with the next release', 0, 0),
    merged_at: new Date(Date.now() - 60 * 1000).toISOString(),
    live_at: null,
  };
  // #4715: the same going-live state, OWNED by the viewer, so Your work
  // shows the merged row that stays there until the release lands — the
  // ownership the auto-merged mock already takes (#4505). Outside the
  // 9100000-9100034 deployed-mock range like 9100035, so `live_at: null`
  // is what draws its "Going live" pill; it carries no release of its own.
  const mineGoingLive = {
    ...mk(9100036, 910136,
      '[Mock] Going-live test: your own change, still going live in Your work', 0, 0),
    merged_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    live_at: null,
  };
  if (viewer?.id != null && viewer.username) {
    mineGoingLive.user_id = viewer.id;
    mineGoingLive.username = viewer.username;
  }
  // A change merged into Homeroom whose release run failed a step: its card
  // says "Release blocked" and its page names the step and the reason. The
  // /merged demo block and the by-id read give it DEMO_RELEASE_BLOCK.
  // 9100038 is DEMO_RELEASE_BLOCKED_ID, spelled out for the same reason as
  // 9100035 above.
  const releaseBlocked = {
    ...mk(9100038, 910138,
      '[Mock] Release-blocked test: merged into Homeroom, its release failed a security check', 0, 0),
    merged_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    live_at: null,
  };
  return [autoMerged, goingLive, mineGoingLive, releaseBlocked, inheritedAttrs, undone].concat(titles.map((t, i) => mk(
    9100001 + i,
    910101 + i,
    `[Mock] Completed: ${t}`,
    i + 1,
    // Sprinkle a few discussion counts so the 💬 badge is visible.
    i % 3 === 0 ? 5 : 0
  ))).concat(older, [legacy]);
}

// Staging demo rows for APPLIED close-issue proposals in the Completed
// stream (row_type='close_issue'), so a ?demo=1 preview shows the new
// "Issue close" card interleaved among the merged mocks. One group-vote
// apply and one admin force-apply, exercising both "closed by vote" and
// "closed by admin" meta lines. Ids live outside the merged-mock range so
// the type-scoped de-dup never collides. The payload mirrors what the
// governance machine stamps on a close-issue apply (appliedAt/appliedBy +
// tally snapshot); the target is mock issue 900003 from stagingMockIssues.
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
    // The tally the target issue carried while open — a closed task keeps
    // its priority/assignee/category chips in the Done column. Baked in
    // because mock rows are injected after the real rows' summarize pass.
    priority: { top: 'high', count: 2, myValue: null },
    assignee: { top: 'maya-builder', count: 2, myValue: null },
    category: { top: 'bug', count: 1, myValue: null },
  });
  return [
    mk(9100060, 'group-vote', 1, 2, 3),
    mk(9100061, 'admin:staging-admin', 4, 5, 0),
    // (#1115) A DELIBERATELY OLD applied close proposal. The mocks are only
    // injected on the demo stream's FIRST page and the merged mocks span
    // up to ~150 days (#1264 extended them for the report's monthly strip),
    // so a 400-day-old row can never appear in any /merged page — making it
    // reachable ONLY through GET /api/apps/:slug/governance/:id.
    // That is exactly the regression this mock exists to test: before the
    // by-id recovery path, deep-linking it bounced back to the board.
    mk(9100062, 'group-vote', 400, 402, 4),
  ];
}

// Global ordering for the unified Completed stream: newest completion
// first; on a timestamp tie PR rows rank before close-issue rows (rank
// pr=1 > close_issue=0 — the same constant ranks the SQL keyset
// predicates encode), then id DESC. Deterministic even across the two
// id sequences (chat_sessions vs issues), which can collide numerically.
const COMPLETED_TYPE_RANK = { pr: 1, close_issue: 0 };
function completedAt(row) {
  return row.completed_at || row.merged_at || row.payload?.appliedAt || row.closed_at || row.created_at;
}
function completedRowCompare(a, b) {
  const ta = new Date(completedAt(a)).getTime() || 0;
  const tb = new Date(completedAt(b)).getTime() || 0;
  if (tb !== ta) return tb - ta;
  const ra = COMPLETED_TYPE_RANK[a.row_type || 'pr'] ?? 1;
  const rb = COMPLETED_TYPE_RANK[b.row_type || 'pr'] ?? 1;
  if (rb !== ra) return rb - ra;
  return b.id - a.id;
}

function normalizedSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

function deploymentOrder(row) {
  const at = Date.parse(row?.merged_at || row?.created_at || '');
  return {
    at: Number.isFinite(at) ? at : 0,
    id: Number(row?.id) || 0,
  };
}

function isAfterDeploymentBoundary(row, boundary) {
  const candidate = deploymentOrder(row);
  const live = deploymentOrder(boundary);
  return candidate.at > live.at || (candidate.at === live.at && candidate.id > live.id);
}

// Deployment is deliberately a derived view of a merged proposal, not a
// second persisted lifecycle. Child apps require runtime revision evidence:
// a GitHub merge can succeed even when its production rebuild fails. The
// platform app has its own external release path; apps.main_sha is the build
// answering this request there. Match that SHA
// to the exact merged session across the WHOLE history (not just this page),
// then classify rows by their merge order. If old data cannot establish that
// boundary, leave the honest `unknown` fallback for the client to render as
// “Merged”.
async function annotateDeploymentState(config, pool, app, rows) {
  if (!app?.self_hosted) {
    return proposalDelivery.annotateChild(config, pool, app, rows);
  }

  const prRows = rows.filter((row) => (row.row_type || 'pr') === 'pr' && row.status === 'merged');
  const runningSha = normalizedSha(app?.main_sha);

  if (!runningSha) {
    for (const row of prRows) row.deployment_state = 'unknown';
    return {
      state: 'unknown', runningSha: null, liveSessionId: null,
      livePrNumber: null, pendingCount: null,
    };
  }

  const { rows: boundaryRows } = await pool.query(
    `SELECT live.id, live.pr_number, live.pr_title, live.merge_commit_sha,
            live.merged_at, live.created_at,
            (SELECT COUNT(*)::int
               FROM chat_sessions newer
              WHERE newer.app_id = live.app_id AND newer.status = 'merged'
                AND (COALESCE(newer.merged_at, newer.created_at), newer.id)
                    > (COALESCE(live.merged_at, live.created_at), live.id)) AS pending_count
       FROM chat_sessions live
      WHERE live.app_id = $1 AND live.status = 'merged'
        AND LOWER(live.merge_commit_sha) = LOWER($2)
      ORDER BY COALESCE(live.merged_at, live.created_at) DESC, live.id DESC
      LIMIT 1`,
    [app.id, runningSha]
  );
  const boundary = boundaryRows[0] || null;
  if (!boundary) {
    for (const row of prRows) row.deployment_state = 'unknown';
    return {
      state: 'unknown', runningSha, liveSessionId: null,
      livePrNumber: null, pendingCount: null,
    };
  }

  const releaseWatch = require('../services/release-watch');
  let stall = releaseWatch.describe(app, runningSha);
  // Several merges, one release: the record can name a commit that never
  // ran by itself and is already inside the running build. Resolved, though
  // the poller has not cleared it yet; the column says no stall.
  if (stall.stalled && await releaseWatch.carriedBy(pool, app.id, stall.sha, runningSha)) {
    stall = releaseWatch.describe(null);
  }
  const stalledSha = stall.stalled ? normalizedSha(stall.sha) : null;
  // A red release run blocks every merge it would have carried, not only
  // the commit it ran on: each change merged after the live build and up
  // to that commit is stuck behind it, and says why (release_block). The
  // commit's own row orders the rest; on a page that does not hold it, its
  // commit time does (the drift poller records it as `since`).
  const blockedBy = stall.stalled && stall.kind === 'workflow_failed' ? stall : null;
  const stalledRow = stalledSha ? prRows.find((row) => normalizedSha(row.merge_commit_sha) === stalledSha) : null;
  const stalledAt = Date.parse(stall.since || '');
  const heldBack = (row) => {
    if (!blockedBy) return false;
    if (stalledRow) return !isAfterDeploymentBoundary(row, stalledRow);
    const at = deploymentOrder(row).at;
    return Number.isFinite(stalledAt) && at > 0 && at <= stalledAt;
  };
  // #6233: production carrying a build is not the whole answer any more. A
  // release replaces its servers one at a time, and for Homeroom itself
  // main_sha moves before the rollout (the migration Job writes it), so a
  // row the boundary carries is Live only once its rollout finished:
  // chat_sessions.live_at, which the merge machine stamps when the
  // platform-rollout job reports the Deployment complete. A rolled-back
  // release clears it again (merge-followups' RolledBack), so the change
  // goes back to Going live. Rows merged before live tracking began keep the
  // reading they always had.
  const setting = (await pool.query(
    `SELECT value AS tracked_since FROM platform_settings WHERE key = 'platform_live_tracked_since'`)).rows[0];
  const trackedSince = setting?.tracked_since ? Date.parse(setting.tracked_since) : NaN;
  const tracked = (row) => Number.isFinite(trackedSince) && deploymentOrder(row).at >= trackedSince;
  for (const row of prRows) {
    const carried = !isAfterDeploymentBoundary(row, boundary);
    if (carried && (row.live_at || !tracked(row))) {
      row.deployment_state = 'deployed';
    } else if ((stalledSha && normalizedSha(row.merge_commit_sha) === stalledSha) || heldBack(row)) {
      row.deployment_state = 'stalled';
      if (blockedBy) {
        row.release_block = {
          job: blockedBy.failedJob, step: blockedBy.failedStep, reason: blockedBy.failedReason, runUrl: blockedBy.runUrl,
        };
      }
    } else {
      row.deployment_state = 'deploying';
    }
  }

  // When each change still going live does: the next release, worded by
  // the board as "Merged; goes live in the next release (about 8 minutes)"
  // (services/release-watch.js). The newest one's is the column's.
  const deploying = prRows.filter((row) => row.deployment_state === 'deploying');
  let newest = null;
  if (deploying.length) {
    const view = await releaseWatch.outlook(pool);
    for (const row of deploying) {
      const release = releaseWatch.releaseOf(view, { mergedAt: row.merged_at || row.created_at, id: row.id });
      if (!release) continue;
      row.release = release;
      if (!newest || !isAfterDeploymentBoundary(newest, row)) newest = row;
    }
  }

  const pendingCount = Math.max(0, Number(boundary.pending_count) || 0);
  return {
    state: pendingCount > 0 ? (stall.stalled ? 'stalled' : 'deploying') : 'deployed',
    runningSha,
    liveSessionId: Number(boundary.id) || null,
    livePrNumber: Number(boundary.pr_number) || null,
    pendingCount,
    ...(stall.stalled ? { stall } : {}),
    ...(pendingCount > 0 && !stall.stalled && newest ? { release: newest.release } : {}),
  };
}

// The preview machine builds and checks a native proposal's reviewed head.
async function kickNativeRevisionChecks({ config, pool, session, headSha }) {
  void config;
  await require('../services/preview-workflow').revision({
    pool, session, head: headSha, source: 'reviewed-head', trigger: 'commit-push',
  });
}

// Imported PRs use their GitHub head as the reviewed revision; the preview
// machine builds and checks it. The merge gate independently compares the
// verdict SHA, so an older green result never authorizes this head.
async function kickImportedRevisionChecks({ config, pool, session, headSha }) {
  void config;
  await require('../services/preview-workflow').revision({
    pool, session, head: headSha, source: 'imported', trigger: 'pr-import',
  });
}

const SHA40_RE = /^[0-9a-f]{40}$/i;

function normalizedSha(value) {
  return typeof value === 'string' && SHA40_RE.test(value) ? value.toLowerCase() : null;
}

// #2038 — what a head move costs a proposal's approvals.
//
// This replaced a provenance ledger: session_platform_pushes, a five-hop
// first-parent walk, a three-way classifier keyed on recorded pushes, a
// "platform sync in flight, ask me later" race state, and a fail-closed
// branch for when GitHub would not say who a commit's parents were. All of
// that existed to tell the platform's own sync commit from an author's push,
// and it had to be built on recorded provenance because a commit's SHAPE can
// be forged — anyone can craft a merge whose first parent is the reviewed sha.
//
// services/integration.js answers the same question by REDOING the merge and
// comparing trees. Nothing to record, nothing to walk, nothing to forge, and
// no network: the mirror already has both commits.
//
// The outcome is spent in one place — the approval epoch. A mechanical merge
// does not touch it, so the approvals keep counting with nothing carried or
// advanced. Anything authored bumps it, and every tally in the platform stops
// counting the old votes in the same statement.
//
// `fresh` (#2619): this reads the branch tip out of the repo mirror, and the
// mirror coalesces one fetch per repository. A caller that has just PUSHED and
// is reading its own write back has to opt out of that, or it joins a fetch
// older than the push and is told the head did not move. Pass it whenever the
// push and this call are in the same request; leave it off for the sweeps and
// read paths, which have nothing of their own to see.
//
// `offline` (#2782): answer from the row alone — every early return above the
// mirror read is unchanged, and a GitHub-backed row reports its STORED head
// and epoch with `deferred: true` instead of fetching. The vote route uses it:
// a vote is bound to the epoch the voter was shown (see recordVote), so the
// live read that decides whether that epoch still describes the branch can
// run after the response rather than in front of it. That read was a full
// `git fetch` queued behind every other fetch of the repository — and a cold
// clone after a restart — on the path of every Yes.
//
// `notify: false` (#3411) silences the broadcast and the notice for a move
// that keeps the approvals, which is all the merge queue's re-pin ever
// expects. It does NOT silence a move that retires votes people cast: that
// notice is posted in the proposal's own thread either way, because without
// it the Discussion keeps "Voted yes" while the tally drops to 0 with nothing
// saying why. A caller that writes its own line about the cleared votes (the
// merge's head-moved 409) passes `announceClearedVotes: false`. Only the
// caller whose conditional UPDATE claims the move reaches the notice, so two
// paths reconciling the same push cannot both post it.
function workflowPlatform() {
  return require('../workflow/platform.ts');
}
const moveAccepted = (out) => !!out && (out.status === 'accepted' || out.status === 'replayed');

// The proposal machine did not move the head: another verifier installed a
// revision while this one was reading (re-read rather than reset a second
// time), or the proposal has left review for good, or the answer is late.
async function refusedMove(pool, session, liveHead, out) {
  const { rows } = await pool.query(
    `SELECT reviewed_head_sha, approval_epoch, pr_summary_md, pr_summary_stale, status
       FROM chat_sessions WHERE id = $1`,
    [session.id]
  );
  const row = rows[0] || {};
  session.reviewed_head_sha = row.reviewed_head_sha || null;
  session.approval_epoch = row.approval_epoch;
  session.pr_summary_md = row.pr_summary_md || null;
  session.pr_summary_stale = !!row.pr_summary_stale;
  const epoch = parseInt(row.approval_epoch, 10);
  if (sameSha(session.reviewed_head_sha, liveHead)) {
    return { enforced: true, headSha: liveHead, epoch: Number.isFinite(epoch) ? epoch : 0, unchanged: true };
  }
  if (out?.status === 'rejected' && out.reason === 'closed') {
    return { enforced: true, blocked: true, reason: 'This proposal is no longer open.' };
  }
  return {
    enforced: true, blocked: true, transient: true,
    reason: 'The proposal changed while its revision was being verified. Try again.',
  };
}

async function reconcileNativeReviewedHead({
  config, pool, session, fresh = false, notify = true, deferChecks = false,
  offline = false, announceClearedVotes = true, madeBy = null,
}) {
  const integration = require('../services/integration');
  const mirror = require('../services/repo-mirror');

  const epochOf = (s) => {
    const n = parseInt(s?.approval_epoch, 10);
    return Number.isFinite(n) ? n : 0;
  };

  if (!session || session.source === 'imported') {
    return { enforced: false, headSha: reviewedHeadForSession(session), epoch: epochOf(session) };
  }
  if (!github.isEnabled()) {
    // Local/mock installations keep their PR-less behaviour: there is no
    // external mutable branch to protect.
    return { enforced: false, headSha: session.reviewed_head_sha || null, epoch: epochOf(session) };
  }
  if (!session.repo_url) {
    // No repository identity at all. A row that claims a pull request but has
    // lost its repository cannot be verified and must not merge on an
    // unverified head — this is the one case that still fails closed, because
    // there is nothing to fail open TO.
    if (!session.pr_number) {
      return { enforced: false, headSha: session.reviewed_head_sha || null, epoch: epochOf(session) };
    }
    return {
      enforced: true, blocked: true,
      reason: 'This proposal has no repository to verify.',
    };
  }
  if (!session.branch_name) {
    // A repository but no recorded branch: legacy rows, and imported
    // proposals whose head lives on the author's fork where the mirror cannot
    // see it. The head cannot be resolved locally, so leave the revision as it
    // stands — the exact-sha merge remains the guard. Same reasoning as the
    // unreadable-mirror path below.
    return {
      enforced: true, headSha: session.reviewed_head_sha || null,
      epoch: epochOf(session), unchanged: true, measurementUnavailable: true,
    };
  }

  const parsed = integration._parseRepo(session.repo_url);
  if (!parsed) {
    return {
      enforced: true, blocked: true,
      reason: 'This proposal has no valid repository to verify.',
    };
  }

  const oldHead = normalizedSha(session.reviewed_head_sha);
  if (offline) {
    return {
      enforced: true, headSha: oldHead, epoch: epochOf(session),
      unchanged: true, deferred: true,
    };
  }
  let dir; let liveHead; let mainSha;
  try {
    dir = await mirror.ensureMirror(parsed.owner, parsed.repo, {
      refs: [oldHead, normalizedSha(session.checks_commit_sha)].filter(Boolean),
      // #2619: `fresh` was accepted here and then never used — seven call
      // sites asked for a re-read and silently got whatever fetch happened
      // to be in flight. It is the callers that have just PUSHED who need
      // it (proposal-update's two, merge-queue, cli-handoff-sync): without
      // it their reconcile reads the pre-push tip, concludes the head did
      // not move, and leaves the tally and the verdict on the old commit.
      fresh,
    });
    mainSha = await mirror.defaultBranchSha(dir);
    liveHead = await mirror.resolveBranch(dir, session.branch_name);
  } catch (err) {
    // Fail OPEN, deliberately, and this is the one place in the merge path
    // where that is the safe direction.
    //
    // The mirror is a cache of a repository, not the authority on it. The
    // authority is the exact-sha merge the proposal machine asks GitHub for, which
    // pins to the revision recorded here: if the head has moved and this
    // read did not notice, GitHub refuses the merge with a 409 and the
    // proposal comes straight back round to be reconciled properly. Nothing
    // can be merged on the strength of a head we failed to check.
    //
    // Failing closed, by contrast, would block every vote and every merge on
    // every app behind one unreachable git host — the same wedge the
    // explicit-approval check documents avoiding for a GitHub outage. A
    // proposal nobody can vote on is a worse outcome than a merge attempt
    // that GitHub declines.
    log.warn('votes', 'Mirror unreadable; leaving the reviewed revision as it stands', {
      sessionId: session.id, err: err.message,
    });
    return {
      enforced: true, headSha: oldHead, epoch: epochOf(session),
      unchanged: true, measurementUnavailable: true,
    };
  }

  if (!liveHead) {
    // The branch is not in the mirror: deleted, renamed, never pushed, or an
    // imported head that lives on a fork. Not a head move, and nothing here
    // may clear approvals over an absence. Same fail-open reasoning as above.
    //
    // On the git host, with main there, a proposal with a pull request whose
    // branch is not is one whose code did not come across from GitHub
    // (services/code-missing.js). That is said once, as `codeMissing`, for
    // the callers to stand down on: the merge gate refuses with the reason,
    // the review sweep and a vote ask for no merge. It stays that way every
    // pass until the branch is pushed back, so it is not logged as news.
    const missing = !!(mainSha && session.pr_number && repoRef.isHosted(session.repo_url));
    if (!missing) {
      log.info('votes', 'Branch not present in the mirror; revision left as it stands', {
        sessionId: session.id, branch: session.branch_name,
      });
    }
    return {
      enforced: true, headSha: oldHead, epoch: epochOf(session),
      unchanged: true, measurementUnavailable: true,
      ...(missing ? { codeMissing: true } : {}),
    };
  }
  if (sameSha(liveHead, oldHead)) {
    return { enforced: true, headSha: liveHead, epoch: epochOf(session), unchanged: true };
  }

  // A row with no pin yet is being bound for the first time. Pre-#872
  // semantics counted its unbound votes anyway, so binding costs nothing and
  // must not clear anything. The proposal machine writes it (Q3), and tells
  // the shots machine the head moved.
  if (!oldHead) {
    const bound = await workflowPlatform().moveReviewHead({
      sessionId: session.id, appId: session.app_id, column: 'reviewed', from: null, to: liveHead, keepVotes: true,
      reason: 'bound',
    });
    if (!moveAccepted(bound)) return refusedMove(pool, session, liveHead, bound);
    session.reviewed_head_sha = liveHead;
    // #3344: an author summary recorded for this very head stays fresh.
    session.pr_summary_stale = typeof bound.reply?.prSummaryStale === 'boolean'
      ? bound.reply.prSummaryStale
      : (session.pr_summary_stale || !!session.pr_summary_md);
    return {
      enforced: true, headSha: liveHead, epoch: epochOf(session),
      updated: true, initialized: true, changed: false, kind: 'initialized',
    };
  }

  const move = await integration.classifyHeadMove(dir, {
    approvedHead: oldHead, newHead: liveHead, mainSha,
  });

  // 'resolved' keeps the approvals — the bytes that differ from the
  // mechanical attempt all lie in files git itself could not merge, so the
  // resolution is bounded by the conflict — but the tree is one nobody has
  // tested, so its checks are always re-run below.
  const keepsApprovals = move.kind === 'mechanical' || move.kind === 'resolved';

  // Run four (13 Oct 2026): who made the move, and whether it was only one of
  // the bot's fix rounds, read from the commits it added
  // (services/homeroom-commits.js). Decided here, by whichever caller claims
  // the move, rather than by the dozen callers each passing `madeBy`: one
  // that passed none used to say a bot's push "was updated on GitHub". An
  // unreadable answer is neither, which says what this said before.
  let made = { madeByHomeroom: false, fixOnly: false };
  let commits = null;
  try {
    commits = await mirror.commitsBetween(dir, oldHead, liveHead);
    made = homeroomCommits.classify(commits);
  } catch (_) { /* fail open: a person's update, as before */ }

  // #6287: a catch-up with main changes nothing the change does, so it keeps
  // the description as the fix round below does. It is a move that keeps the
  // votes (mechanical or resolved) and adds no commit of the change's own; an
  // unreadable list (null) is not a catch-up.
  const catchUp = keepsApprovals && Array.isArray(commits) && commits.length === 0;

  // One move, the proposal machine's (Q3): the head installed and, unless the
  // move kept the approvals, the epoch moved on, in one statement, so a crash
  // can never leave a row whose approvals describe neither the old code nor
  // the new. It is refused if another verifier installed a revision while
  // this one was reading (the head it read is no longer the row's), or the
  // proposal has closed or merged meanwhile. A fix round leaves the
  // description as it stands: it changes how the change works, not what it
  // does (summary-freshness.js). A catch-up with main is kept for the same
  // reason: it changes nothing the change does.
  const moved = await workflowPlatform().moveReviewHead({
    sessionId: session.id, appId: session.app_id, column: 'reviewed', from: oldHead, to: liveHead,
    keepVotes: keepsApprovals, fixOnly: made.fixOnly || catchUp, reason: move.kind,
  });

  if (!moveAccepted(moved)) return refusedMove(pool, session, liveHead, moved);

  const epoch = parseInt(moved.reply?.epoch, 10);
  session.reviewed_head_sha = liveHead;
  session.approval_epoch = epoch;
  session.pr_summary_stale = typeof moved.reply?.prSummaryStale === 'boolean'
    ? moved.reply.prSummaryStale
    : (made.fixOnly || catchUp ? !!session.pr_summary_stale : (session.pr_summary_stale || !!session.pr_summary_md));

  // Checks policy follows who wrote the tree. A mechanical merge is pure git
  // over a tested branch and a tested main, so the verdict carries. Anything
  // else is an unverified tree and is re-checked against this exact commit.
  //
  // Only a SETTLED verdict about the OLD head can carry. The merge queue
  // supersedes any run in flight before it moves the branch (#1728), so a
  // 'pending' stamp here describes a run that will never report; carrying
  // it onto the new head would leave the row 'pending' with nothing building
  // until the stale sweeper noticed ten minutes later — the exact dead wait
  // #1728 measured. 'error' is a preview that did not boot, which a rebuild
  // against the merged commit is the right way to find out about. And only a
  // GREEN verdict carries (#2693): a settled failure used to ride along on
  // the premise that a merge of main does not change what the author must
  // fix — false exactly when main is what fixes it (a red base repaired, a
  // test main mended). The merged tree is the only thing that can turn that
  // verdict green and nobody has tested it, so it is re-checked. Same rule as
  // CARRIABLE_CHECK_STATES on the imported path (services/pr-import-sync.js).
  const checksCarry = move.kind === 'mechanical'
    && sameSha(session.checks_commit_sha, oldHead)
    && ['passing', 'skipped'].includes(session.check_state);
  const needsChecks = !sameSha(session.checks_commit_sha, liveHead) && !checksCarry;
  // The preview machine decides both: it carries a green verdict of the old
  // head, else checks the new one. A deferred caller hands off the build
  // itself once its own pins are written.
  if (checksCarry || (needsChecks && !deferChecks)) {
    await require('../services/preview-workflow').revision({ pool, session, head: liveHead, source: 'reviewed-head',
      trigger: 'commit-push', carryFrom: checksCarry ? oldHead : null });
  }
  if (checksCarry) session.checks_commit_sha = liveHead;

  // A silent caller still announces votes it retired — only when there were
  // any: an epoch bump over a proposal nobody had voted on clears nothing.
  let clearedVotes = false;
  if (!notify && !keepsApprovals && announceClearedVotes) {
    const { rows: retired } = await pool.query(
      'SELECT 1 FROM pr_votes WHERE session_id = $1 AND approval_epoch = $2 LIMIT 1',
      [session.id, epoch - 1]
    ).catch(() => ({ rows: [] }));
    clearedVotes = retired.length > 0;
  }

  if (notify || clearedVotes) {
    try {
      const { pushVoteUpdate } = require('../services/ws');
      pushVoteUpdate({
        sessionId: session.id,
        appSlug: session.app_slug || null,
        merged: false,
        headMoved: true,
        ...(keepsApprovals ? { votesKept: true } : {}),
      });
    } catch (_) { /* ws failures are non-fatal */ }

    const label = session.pr_title
      ? `PR #${session.pr_number}: ${session.pr_title}`
      : `PR #${session.pr_number}`;
    const message = move.kind === 'mechanical'
      ? `${label} was brought up to date with main. Nothing in the proposal changed, so its votes still stand.`
      : move.kind === 'resolved'
        ? `${label} was brought up to date with main and ${move.conflictPaths?.length || 'its'} conflicting file${move.conflictPaths?.length === 1 ? '' : 's'} were resolved automatically. The votes still stand; its checks are re-running against the merged code and it will merge on its own once they pass.`
        : move.kind === 'unknown'
          ? `${label} moved to a commit the platform could not verify (${move.reason}). Earlier votes were cleared, so please re-review commit ${liveHead.slice(0, 8)}.`
          // An update Homeroom made (the bot's, or one sent through Homeroom:
          // its caller's `madeBy`, else its own commits say so) is said in the
          // change's own discussion in one line, the only note about its
          // votes: no "on GitHub", no pull request number.
          : madeBy || made.madeByHomeroom
            ? 'Updated. Earlier votes were cleared, so take another look.'
            : `${label} was updated on GitHub. Earlier votes were cleared, so please re-review commit ${liveHead.slice(0, 8)}.`;
    await sendSystemMessage(
      pool, session.app_id, message, 'system',
      { headChanged: true, votesKept: keepsApprovals, prNumber: session.pr_number, headSha: liveHead },
      { type: 'session', ref: session.id }
    ).catch(() => {});
  }

  log.info('votes', 'Proposal revision reconciled', {
    sessionId: session.id, oldHead, newHead: liveHead,
    moveKind: move.kind, keepsApprovals, epoch, checksReset: needsChecks,
    madeByHomeroom: made.madeByHomeroom, fixOnly: made.fixOnly,
  });

  return {
    enforced: true,
    headSha: liveHead,
    epoch,
    updated: true,
    changed: true,
    kind: move.kind,
    votesKept: keepsApprovals,
    // The green verdict about the old head now stands for this one, so
    // nothing rebuilds. services/proposal-update.js reports that to the
    // author instead of a rebuild that is not happening.
    checksCarry,
    checksDeferred: needsChecks && deferChecks,
  };
}

/**
 * Is the vote the browser is casting a vote on the proposal it was shown?
 *
 * The old guard compared the rendered COMMIT to the live head and rejected
 * any difference. That cost a voter their click on every platform sync —
 * including the ones the platform had just certified changed nothing — because
 * the comparison could not tell "this is different code" from "this is the
 * same code, rebased". An epoch can: it only moves when somebody writes bytes
 * that were not already approved.
 *
 * An absent stamp is accepted. A client that sends no epoch is voting on
 * whatever is current, which is the pre-#872 behaviour and is safe now that
 * the epoch — not the vote's own revision — is what decides whether it counts.
 */
function voteMatchesApprovalEpoch(expectedEpoch, revision) {
  if (!revision?.enforced) return true;
  if (expectedEpoch === undefined || expectedEpoch === null || expectedEpoch === '') return true;
  const expected = parseInt(expectedEpoch, 10);
  if (!Number.isFinite(expected)) return true;
  const current = parseInt(revision.epoch, 10);
  if (!Number.isFinite(current)) return true;
  return expected === current;
}

// Optional testing metadata on a PR import. Returns the three column values
// the imported session row is created with — all null when the request body
// carries nothing, which is the browser import button's case and leaves that
// path byte-identical to before.
//
// Every rule is BORROWED, not restated: services/testing-notes.js's
// `parseSubmitted` owns what a valid capture route is, how many are shot, how
// the viewport labels are spelled and how long the markdown may be. It is
// shared with the UPDATE path (#1199), which is the point — the same routes
// must not behave differently depending on whether an import or an update
// submitted them. Only the three COLUMNS are kept: an import writes all three
// on INSERT either way, so `provided` carries no extra meaning on this path,
// and the rejected-entry list (#1214) is reported to the submitter by the
// connector that shaped the routes rather than written to a column here.
function parseImportTesting(body) {
  const {
    testingMd, testingPath, testingPaths,
  } = require('../services/testing-notes').parseSubmitted(body);
  return { testingMd, testingPath, testingPaths };
}

// Structured shots intent supplied by coding agents. There is deliberately
// no markdown fallback: one strict parser owns the contract at every process
// boundary, and an omitted value preserves browser imports exactly as before.
function parseImportVisibleChanges(body) {
  const declared = visibleChangesContract.declaredChanges(body);
  if (declared === undefined) return undefined;
  return visibleChangesContract.parseIntent(declared);
}

// Keep internal failures opaque, but name the import boundary a caller can
// act on. The connector turns these fields into an `import_failed` response,
// so an agent can retry the SAME open pull request instead of manufacturing a
// fresh one without knowing whether parsing, persistence, or the shots failed.
function prImportFailureBody(err) {
  if (err?.prImportStage === 'visible_changes') {
    return {
      error: 'PR import failed while recording the visible changes.',
      stage: 'visible_changes',
      field: 'visibleChanges',
      retryable: true,
    };
  }
  return { error: 'Internal server error' };
}

// The linked-issue set an import may carry (#1217). Bounded and sanitized by
// pr-metadata's own helper — the one that renders `Closes #N` — so the column
// and the PR body can never disagree about what counts as a linked issue.
// The cap matches the local-agent handoff route's.
const MAX_IMPORT_LINKED_ISSUES = 50;

function parseImportLinkedIssues(body) {
  const { sanitizeIssueNumbers } = require('../services/pr-metadata');
  return sanitizeIssueNumbers(body && body.linkedIssues).slice(0, MAX_IMPORT_LINKED_ISSUES);
}

// The plain-language summary an import may carry (the About sheet's user-facing
// half). On-platform sessions get one from llm.generatePrMetadata; an imported
// or connector-submitted PR had no way to supply one at all, so those proposals
// rendered the technical description as their only content — which is what the
// two-section About sheet exists to avoid.
//
// Bounded, because it is the body text a voter reads FIRST. An agent that
// pastes its whole PR body here would collapse the two sections back into one,
// so the cap is deliberately much smaller than the description's: a few
// sentences, not a document. Truncation is silent for the same reason the
// testing note's is — one over-long field must not cost somebody their whole
// submission — and the field is optional, so an omitted one behaves exactly as
// before rather than inventing a summary nobody wrote.
const MAX_IMPORT_SUMMARY = 600;

function parseImportSummary(body) {
  const raw = body && typeof body.summary === 'string' ? body.summary : '';
  const trimmed = raw.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_IMPORT_SUMMARY);
}

function revisionChangedVoteResponse(res, headSha, message = null, epoch = null) {
  return res.status(409).json({
    error: message
      || 'This proposal changed since it was shown. Refresh it, review the new revision, then vote again.',
    headChanged: true,
    refreshRequired: true,
    reviewedHeadSha: headSha || null,
    // #2038: the client re-arms its buttons from this instead of refetching
    // and hoping. A rejection that does not say what the current epoch IS
    // leaves an impatient second click carrying the same stale stamp — which
    // is how one head move produced two identical rejections.
    approvalEpoch: epoch == null ? null : parseInt(epoch, 10),
  });
}

// Record a vote, stamped with the epoch it was cast under.
//
// The epoch is read INSIDE the statement (`SELECT ... FOR UPDATE`) rather
// than passed in, so a reconciliation racing this write either lands first —
// and the vote is stamped with the new epoch, which is correct, because the
// voter is voting on whatever the reconciliation decided — or lands after,
// against a row this statement already holds a lock on. There is no window in
// which a vote is written carrying an epoch that never existed.
//
// head_sha is still recorded. It no longer decides anything, but it is the
// only record of which commit a person was looking at when they approved,
// and that is worth keeping.
// The longest line a vote may carry (#1688; src/workflow/rules/vote-reason.ts).
const { VOTE_REASON_MAX } = require('../workflow/rules/vote-reason.ts');

// The one-line reason on a vote, normalised: whitespace collapsed, empty
// becomes null (no line), anything else trimmed. `{ error }` when the line is
// not a string or runs past the cap — the caller answers 400 with it.
function normalizeVoteReason(raw) {
  if (raw == null) return { reason: null };
  if (typeof raw !== 'string') return { error: 'Reason must be a string' };
  const reason = raw.replace(/\s+/g, ' ').trim();
  if (!reason) return { reason: null };
  if (reason.length > VOTE_REASON_MAX) {
    return { error: `Reason must be ${VOTE_REASON_MAX} characters or fewer` };
  }
  return { reason };
}

// The reason column on the upsert (#1688). A line that arrives replaces the
// old one. When none arrives, the earlier line is KEPT if the person is
// re-casting the same side — that is what carries a Yes, and its sentence,
// onto a proposal's next version with one tap — and dropped on a flip, where
// the old sentence argued for the other side.
const VOTE_REASON_UPSERT_SQL = `reason = CASE
             WHEN EXCLUDED.reason IS NOT NULL THEN EXCLUDED.reason
             WHEN pr_votes.vote = EXCLUDED.vote THEN pr_votes.reason
             ELSE NULL END`;

// `expectedEpoch` (#2782) is the epoch the voter's screen was drawn at. When
// it is given, the row lock and the comparison are the same statement: a vote
// is written only if the proposal is STILL at that epoch, so a reconciliation
// that cleared approvals between the page load and the click refuses the vote
// instead of silently moving it onto code the voter has not seen. That is what
// lets the vote route skip the live GitHub read in front of this write — the
// binding no longer depends on the read having happened first.
function parseExpectedEpoch(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// A vote on one of the Homeroom bot's changes is told to its bot-change
// machine (src/workflow/bot-change/: its requester's tray reads again, and a
// yes is said in the request's thread) in the vote's own statement, so a
// restart after the commit loses nothing. `vote` is 'retracted' for one taken
// back. Only a change the machine follows has an instance: any other vote
// tells nobody. The machine and its key are rules/bot-notes.ts BOT_CHANGE and
// botChangeKey.
// Each value is SQL: a parameter or a column of `from`, a row source the
// statement already has.
const botChangeVotedSql = ({ from = null, sessionId, voterId, voter, vote, epoch }) => `
  INSERT INTO wf_events (machine, key, app_id, type, payload, source, actor, request_key, caused_by)
  SELECT wi.machine, wi.key, wi.app_id, 'Voted',
         jsonb_build_object('sessionId', ${sessionId}, 'voterId', ${voterId}, 'voter', ${voter}, 'vote', ${vote}, 'epoch', ${epoch}),
         '{"kind":"route","name":"vote"}'::jsonb, NULL, 'voted:' || gen_random_uuid(), NULL
    FROM ${from ? `${from}, ` : ''}wf_instances wi
   WHERE wi.machine = 'bot-change' AND wi.key = 'session:' || ${sessionId}
  RETURNING id`;

async function recordVote({
  pool, session, userId, vote, headSha, revisionEnforced, reason = null, expectedEpoch = null, voter = null,
}) {
  // One statement for every proposal, an imported one's included (bug 5):
  // the row is locked and must be up for a vote, so a vote racing an
  // unpromote either lands before it (and is voided with the epoch it
  // bumps) or finds the proposal Underway and is refused. The stamp is the
  // epoch read under that lock. An epoch the voter's screen was drawn at
  // (#2782) is held to when the revision is enforced. The bot's change
  // machine hears it in the same statement (botChangeVotedSql).
  return pool.query(
    `WITH current_session AS (
       SELECT id, approval_epoch
         FROM chat_sessions
        WHERE id = $1
          AND status IN ('promoted', 'merging')
        FOR UPDATE
     ),
     v AS (
     INSERT INTO pr_votes (session_id, user_id, vote, head_sha, approval_epoch, reason)
     SELECT id, $2, $3, $4, approval_epoch, $5 FROM current_session
      WHERE $6::integer IS NULL OR approval_epoch = $6::integer
     ON CONFLICT (session_id, user_id) DO UPDATE
       SET vote = EXCLUDED.vote, head_sha = EXCLUDED.head_sha,
           approval_epoch = EXCLUDED.approval_epoch, created_at = NOW(),
           ${VOTE_REASON_UPSERT_SQL}
     RETURNING id, reason, session_id, approval_epoch
     ),
     told AS (${botChangeVotedSql({ from: 'v', sessionId: 'v.session_id', voterId: '$2::int', voter: '$7::text', vote: '$3::text', epoch: 'v.approval_epoch' })})
     SELECT v.id, v.reason, (SELECT pg_notify('wf_events', 'bot-change') FROM told LIMIT 1) IS NOT NULL AS told
       FROM v`,
    [session.id, userId, vote, headSha, reason, revisionEnforced ? parseExpectedEpoch(expectedEpoch) : null, voter]
  );
}

// Take a vote back (DELETE /api/sessions/:id/vote, the review flow's Undo).
//
// In one transaction, under the same row lock recordVote takes and the
// proposal machine reads its facts under (workflow/proposal/facts.ts
// readRow), so a retraction is ordered against a vote and against a merge
// claim: a claim that lands first leaves the proposal 'merging' here and the
// vote stays; one that lands after counts the votes without this one. The
// DELETE is its own statement after the lock so it reads the votes as they
// are once the lock is held (a vote committed while this waited is seen).
//
// Only while the proposal is still up for a vote ('promoted'); only the vote
// that counts now (the current epoch's: a vote on an earlier version is
// already not counted, and its row is what names the voter as asked back,
// #1688); and, when the client says which epoch it was shown, only at that
// epoch. Resolves { found, status, epoch, vote, reason }: `vote` is the side
// taken back, null when nothing was removed.
async function retractVote({ pool, sessionId, userId, expectedEpoch = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [locked] = [] } = await client.query(
      'SELECT status, approval_epoch FROM chat_sessions WHERE id = $1 FOR UPDATE',
      [sessionId]
    );
    if (!locked) {
      await client.query('ROLLBACK');
      return { found: false };
    }
    const epoch = locked.approval_epoch == null ? null : parseInt(locked.approval_epoch, 10);
    const out = { found: true, status: locked.status, epoch, vote: null, reason: null };
    const expected = parseExpectedEpoch(expectedEpoch);
    if (locked.status !== 'promoted' || (expected != null && expected !== epoch)) {
      await client.query('ROLLBACK');
      return out;
    }
    const { rows: [removed] = [] } = await client.query(
      `DELETE FROM pr_votes pv
        USING chat_sessions cs
        WHERE pv.session_id = $1 AND pv.user_id = $2
          AND cs.id = pv.session_id
          AND pv.approval_epoch = cs.approval_epoch
        RETURNING pv.vote, pv.reason, cs.user_id AS author_id`,
      [sessionId, userId]
    );
    // #6477: the author took their own vote back on this version, so proposing
    // stops counting as their yes (governance-rules.ts). Only the author's own
    // retraction marks it, and a later vote or a new version (an epoch bump)
    // makes the stamp stale on its own.
    if (removed && parseInt(removed.author_id, 10) === userId) {
      await client.query(
        `UPDATE chat_sessions SET author_yes_withdrawn_epoch = approval_epoch
          WHERE id = $1 AND user_id = $2`,
        [sessionId, userId]
      );
    }
    // Whoever asked the bot for this change reads their card again, so it
    // names who it waits on now (no "approved it" line: there is no vote).
    if (removed) {
      await client.query(
        `WITH told AS (${botChangeVotedSql({ sessionId: '$1::int', voterId: '$2::int', voter: 'NULL::text', vote: "'retracted'", epoch: '$3::int' })})
         SELECT (SELECT pg_notify('wf_events', 'bot-change') FROM told LIMIT 1)`,
        [sessionId, userId, epoch || 0]
      );
    }
    await client.query('COMMIT');
    if (removed) {
      out.vote = removed.vote;
      out.reason = removed.reason || null;
    }
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// What a retraction is answered when the vote can no longer move: the
// proposal is being merged, has merged, or left review.
const VOTE_LOCKED_MESSAGE = 'This change is no longer open for voting, so your vote stays as it is.';

// After a vote has been answered (#2782): the fresh GitHub read the route used
// to await, then the app's merge queue is asked to look at the proposal. The
// order matters — the merge gate's own reconcile is a non-fresh one that
// joins any fetch already in flight, and it relies on "every interactive vote
// performs a fresh read". Running that read here, before it, keeps the
// guarantee; it just no longer sits between the click and the answer. A
// release drains it (the in-flight registry); a crash in between loses only
// the ask, and the proposal's review check asks again within the hour for
// any proposal whose gate is met.
//
// A read that finds an authored push bumps the epoch, retiring the vote just
// recorded along with every other vote on the old code, posts the "please
// re-review" line and pushes `headMoved` to every client — so the voter sees
// their vote cleared rather than silently counted. A read that fails is
// logged and the merge check still runs: the exact-sha merge is the guard
// against a head nobody verified, as it is on every other path.
async function settleVoteInBackground({ config, pool, session, revision }) {
  if (revision?.deferred) {
    try {
      const live = await reconcileNativeReviewedHead({ config, pool, session, fresh: true });
      if (live?.updated && !live.votesKept) {
        // The approvals were just cleared; there is nothing to count.
        return { merged: false, headMoved: !!live.changed, reviewReset: true };
      }
      // Its code is not on the git host (services/code-missing.js): the vote
      // is recorded, and no merge is asked for, as there is nothing to merge.
      if (live?.codeMissing) return { merged: false, codeMissing: true };
    } catch (err) {
      log.warn('votes', 'Post-vote revision read failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      });
    }
  }
  await require('../workflow/platform.ts').wantMerge({ appId: session.app_id, sessionId: session.id, reason: 'vote' });
  return { asked: true };
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
  return `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.pr_summary_md, cs.pr_summary_stale, cs.pr_body, cs.user_id, cs.status, cs.linked_issues, cs.merge_commit_sha, COALESCE(u.username, 'Deleted user') AS username, cs.created_at,
           -- #1264: the exact merge time (and the promotion time beside it)
           -- so the progress report can date completed work by when it
           -- actually landed instead of when it was started. NULL on rows
           -- merged before the column existed — consumers must keep the
           -- created_at fallback forever.
           cs.merged_at, cs.promoted_at, cs.shared_at, cs.session_title,
           -- When production first ran it; NULL while a merge is still going
           -- live (the merge-followups workflow machine), so the card says so.
           cs.live_at,
           COALESCE(cs.merged_at, cs.created_at) AS completed_at,
           cs.revert_of_session_id,
           -- A change that went live inside another one
           -- (workflow/merge-followups/facts.ts): the change that carried it, for
           -- its page's "Live, included in #8".
           cs.included_in_session_id,
           inc.pr_number AS included_in_pr_number,
           inc.pr_title  AS included_in_pr_title,
           -- #2779: the agent session the change was started from. Only its
           -- id: the conversation itself answers to its owner alone.
           cs.agent_session_id,
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
           -- #6521: which commit the last verdict describes, so the page can
           -- tell a pass on an older version from a pass on this one
           -- (services/homeroom-bot-progress.js sessionChecksOnHead).
           cs.checks_commit_sha,
           -- Where it merges, and the change it waits for (src/workflow/
           -- rules/pr-base.ts): the change page reads its row from here, so
           -- its "Waits for #N" follows a retarget without the board's list.
           cs.imported_pr_base_ref, cs.waits_for_session_id,
           (SELECT jsonb_build_object('id', w.id, 'prNumber', w.pr_number, 'title', w.pr_title, 'status', w.status)
              FROM chat_sessions w WHERE w.id = cs.waits_for_session_id) AS waits_for,
           cs.shots_state, cs.shots_run_id,
           cs.shots_detail, cs.shots_updated_at,
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
           cs.check_trigger,
           cs.checks_progress,
           -- Platform-variables pre-merge check (display mirror; the merge
           -- gate re-evaluates live).
           cs.platform_env_state, cs.platform_env_detail,
           -- #237: when checks are in 'error' (staging preview wouldn't boot),
           -- the captured reason powers the "Preview won't boot" badge tooltip.
           cs.check_error_detail,
            cs.check_error_platform, cs.consecutive_check_failures, cs.first_check_failure_at,
           -- #58: the vote threshold + active-user count snapshotted at merge
           -- time. The merged-PR pill renders against votes_required (falling
           -- back to the live majority for legacy rows where it's NULL), and a
           -- tooltip surfaces "needed N of M active users at merge time" when
           -- both are present.
           cs.votes_required,
           cs.active_users_at_merge,
           -- #788: the explicit-approval flag and its reason. The proposal
           -- page refetches a live row through this select and merges it
           -- into the board's copy key-wise, so a row without them read as
           -- unflagged after every vote and the lock went missing.
           cs.requires_explicit_approval, cs.explicit_approval_reason,
           -- The member floor: Yes votes from someone other than the
           -- author, read only for a flagged row that is still open.
           CASE WHEN cs.requires_explicit_approval AND cs.status IN ('promoted', 'merging') THEN
             (SELECT COUNT(*)::int FROM pr_votes pv
               WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                 AND pv.user_id IS DISTINCT FROM cs.user_id
                 AND ${countedVotePredicateSql('pv', 'cs')})
           END AS other_yes_count,
           -- Vote tally + per-viewer vote carried through so the group-chat
           -- activity row can keep its "x / y" pill and "You voted X" box
           -- after the PR merges (status='merged'), rather than the controls
           -- vanishing. Mirrors the /promoted subqueries.
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'yes'
               AND ${countedVotePredicateSql('pv', 'cs')}) as yes_count,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'no'
               AND ${countedVotePredicateSql('pv', 'cs')}) as no_count,
           (SELECT pv.vote FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.user_id = $2
               AND ${currentVotePredicateSql('pv', 'cs')}) as my_vote,
           -- #6282: an update on its way. The Votes card says so and holds
           -- its Vote button until it lands (AppView._changeVotesView).
           ${updateComingSql('cs')} AS update_coming,
           -- #6287: the viewer's vote on an EARLIER version — still on their
           -- row, no longer counted. The change's page, its request's page,
           -- the pinned Votes card and the side panel all read this row, so
           -- their Vote button asks "Still yes?" from it (as the Workshop
           -- card already does from /promoted). Mirrors the /promoted
           -- subquery below.
           (SELECT pv.vote FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.user_id = $2
               AND NOT COALESCE(${currentVotePredicateSql('pv', 'cs')}, FALSE)) as my_prior_vote,
           -- #4715: whose ask a merged bot change was (#4538's rule, the
           -- shared fragment), so Your work can keep the viewer's own
           -- going-live change after it merges. Both callers bind the
           -- viewer as $2; a guest gets FALSE.
           COALESCE(${botRequestedBySql('cs', '$2')}, FALSE) AS requested_by_me,
           -- Test accounts (D1): the viewer is a test account and a real
           -- person made this app, so their vote is recorded and shown but
           -- not counted. The vote picker says so in one line.
           NOT counts_toward_outcome($2, cs.app_id) AS my_vote_uncounted,
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
           rv.status    as revert_status,
           -- An admin's force merge (services/merge-requirements.js
           -- FORCE_SQL): the change page reads its own row from here, so its
           -- Votes card can say the force skips the vote, and the force an
           -- authored push dropped when none is held now.
           ${require('../services/merge-requirements').FORCE_SQL} AS merge_force,
           ${require('../services/merge-requirements').FORCE_DROPPED_SQL} AS merge_force_dropped
         FROM chat_sessions cs
         LEFT JOIN users u ON cs.user_id = u.id
         LEFT JOIN chat_sessions rv ON rv.revert_of_session_id = cs.id
           AND rv.status IN ('promoted', 'merging', 'merged')
         LEFT JOIN chat_sessions inc ON inc.id = cs.included_in_session_id`;
}

// #3893: whether a promote was sent by the owner's own agent with a bearer
// token: the local Homeroom CLI's proposal_promote, or a connector's
// promote_change and submit_work `propose: true`. cli-auth.js sets
// req.cliAuthenticated for those two token kinds only, never for a browser
// session. A delegated grant is the platform's own agent session, whose
// conversation already tells its owner, and the Homeroom bot promotes
// in-process as itself; neither counts.
function promotedByOwnersAgent(req) {
  return req.cliAuthenticated === true && !req.mcpDelegation
    && !(req.user && req.user.is_synthetic);
}

function voteRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Per-app visibility gate for the session-id-addressed vote routes
  // (promote / vote / votes / undo / admin-merge): collab-level access,
  // 404 on deny. Admins always pass inside the guard.
  router.use('/api/sessions/:id', appAccess.sessionCollabGuard(pool));
  // Proposing, voting and undoing a merge are for the community's members
  // (services/communities.js). Mounted per route rather than beside the
  // collab guard: the guard covers every session write, and building a
  // change, archiving one or giving kudos stay open to anyone who may
  // collaborate. A 403 `join_required` is what lets the client offer Join
  // in place of the refusal.
  const requireMembership = communities.requireSessionMembership(pool);
  // Importing a pull request is starting a change, by another road.
  const requireAppMembership = communities.requireAppMembership(pool);

  // Promote a session's PR for voting
  // drainGuard (#767): promote/merge kick container work (staging build,
  // production rebuild) that must not be started by a process seconds from
  // exiting — a half-run rebuild leaves the app down until the next heal
  // sweep. 503 here is honest and the client retries against the new
  // container. Undo is gated the same way: it is not a read, it clones,
  // pushes and opens a revert PR in the background.
  router.post('/api/sessions/:id/promote', drainGuard, requireMembership, sameOriginBrowserOnly, async (req, res) => {
    try {
      // #183: headless rows are excluded — auto sessions are never
      // promotable themselves; users clone them and propose the clone.
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status IN ('active', 'paused')
           AND cs.is_headless = FALSE`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Active session not found' });
      const session = rows[0];
      // A native preflight may have started while active. If the owner paused
      // it during that request, require a fresh explicit submission. Paused
      // submissions themselves never resume a worker or consume an active slot.
      if (req.cliHandoffStatus && req.cliHandoffStatus !== session.status) {
        return res.status(409).json({ error: 'session_state_changed' });
      }

      // The pull request as GitHub shows it now, when the proposal has one:
      // the proposal machine refuses one already merged, an imported one
      // closed or kept as a draft by its author. A read, not an effect:
      // everything GitHub is asked to do (open, reopen, mark ready) is the
      // machine's work, once the proposal is claimed for review (R4).
      let pr = null;
      if (github.isEnabled() && session.repo_url && session.pr_number) {
        const { owner, repo } = repoRef.ownerRepo(session.repo_url) || {};
        if (!owner || !repo) {
          return res.status(409).json({ error: 'This proposal has no valid repository to verify.' });
        }
        try {
          const live = await github.getPR(owner, repo.replace(/\.git$/, ''), session.pr_number);
          pr = { state: live?.state === 'closed' ? 'closed' : 'open', draft: !!live?.draft, merged: !!live?.merged,
            head: /^[0-9a-f]{40}$/i.test(String(live?.head?.sha || '')) ? live.head.sha : null,
            // Where it would merge, when that is not its repository's
            // default branch: an import based on a branch that is no open
            // change's is refused (rules/pr-base.ts).
            base: prBase.otherBase(live) };
        } catch (err) {
          log.warn('votes', 'Promote PR revision check failed', {
            sessionId: session.id, pr: session.pr_number, err: err.message,
          });
          return res.status(503).json({
            error: 'GitHub could not verify the pull request revision. Try promoting again shortly.',
          });
        }
      }

      // Promoted-PR cap: the bound that keeps one user from accumulating
      // unlimited open-for-vote PRs, per REQUESTER (full platform admins get a
      // raised cap, the Homeroom bot its own: services/session-caps.js). The
      // machine counts it under a lock on the owner, so two promotes at once
      // cannot both squeeze under it (R5).
      const caps = effectiveSessionCaps(config, req.user);
      const reply = await require('../workflow/platform.ts').promoteProposal({
        sessionId: session.id, appId: session.app_id, userId: req.user.id, username: req.user.username,
        from: session.status, cap: caps.promotedSessions, pr,
        expectedHead: req.cliHandoffCheckedHead || null,
        // #3893: work an agent put up for its owner tells them so.
        viaAgent: promotedByOwnersAgent(req),
        ownOperation: req.cliHandoffOperation || null,
        // The Homeroom bot's own promote, a step of its build, waits for
        // GitHub's answer longer than a person's click does.
        ...(req.user && req.user.is_synthetic ? { waitMs: 120000 } : {}),
      });
      if (reply.status === 200) log.info('votes', 'Session promoted', { sessionId: session.id });
      return res.status(reply.status).json(reply.body);
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
  // a shared `source='imported'` In-progress row. Automated submission paths
  // may explicitly request the historical straight-to-vote result.
  //
  // Parse owner/repo from an app's repo_url, or null.
  const parseRepo = (url) => repoRef.ownerRepo(url);

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
          AND status IN ('active', 'promoted', 'merging', 'merged')`,
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

  // A failed getPR on the import paths (#4817). Only GitHub's own 404 means
  // the pull request does not exist; a rate limit, a timeout or a bad token
  // is GitHub being unreachable, and saying "not found" for those sent people
  // looking for a typo in a PR number that was right.
  function sendGetPrFailure(res, err, prNumber, slug) {
    if (err && err.status === 404) {
      return res.status(404).json({ error: `PR #${prNumber} not found on GitHub` });
    }
    log.warn('votes', 'PR-import getPR failed', { slug, prNumber, status: err?.status, err: err?.message });
    return res.status(502).json({ error: `Could not reach GitHub to read PR #${prNumber}. Please try again.` });
  }

  // GET candidate PRs to import (open PRs on the app's repo not already
  // imported). Collab access.
  router.get('/api/apps/:slug/pr-import/candidates', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      const repo = parseRepo(app.repo_url);
      const gh = importGithubClient();
      // #4817: "nothing to import because GitHub is off" and "GitHub could
      // not be read" are different answers from "no open pull requests", so
      // each gets its own shape: `configured: false` here, a 502 below.
      if (!gh.isEnabled() || !repo) return res.json({ candidates: [], configured: false });

      const imported = await importedPrNumbers(app.id);
      let pulls = [];
      try {
        pulls = await gh.listOpenPulls(repo.owner, repo.repo);
      } catch (err) {
        log.warn('votes', 'listOpenPulls failed', { slug: req.params.slug, err: err.message });
        return res.status(502).json({ error: 'Could not load open pull requests from GitHub. Please try again.' });
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
      res.json({ candidates, configured: true });
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
        return sendGetPrFailure(res, err, prNumber, req.params.slug);
      }
      const headSha = pr.head?.sha || null;
      const baseRef = pr.base?.ref || 'main';
      const baseSha = shotsState.validSha(pr.base?.sha) ? pr.base.sha : null;
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
          baseSha,
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

  // POST import a PR. Collab access. Creates a shared In-progress
  // `source='imported'` session by default and kicks its SHA-pinned checks
  // build; trusted automated callers can request `promote: true`.
  router.post('/api/apps/:slug/pr-import', drainGuard, requireAppMembership, async (req, res) => {
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
        return sendGetPrFailure(res, err, prNumber, req.params.slug);
      }
      if (pr.state !== 'open') {
        return res.status(409).json({ error: `PR #${prNumber} is not open.` });
      }
      const headSha = pr.head?.sha || null;
      // GitHub returns the immutable commit at the PR's base side. Persist it
      // with the imported proposal so the shots never have to reconstruct the
      // pair later from a moving default branch.
      const baseSha = shotsState.validSha(pr.base?.sha) ? pr.base.sha : null;
      const headBranch = pr.head?.ref || null;
      if (!headBranch) {
        return res.status(409).json({ error: 'Could not determine the PR head branch.' });
      }
      // WHICH REPOSITORY that branch is in (#1196). An imported PR usually
      // comes from the author's fork, but not always: the connector's mirror
      // rung copies a verified fork branch into THIS repository and opens a
      // same-repo pull request, and a proposal whose head only the platform
      // bot can write has to be reported — and advanced — as such. Recorded
      // once, here, because it is a fact about the pull request that never
      // changes while it is open; `branchHomeOf` reads it.
      const headRepoFullName = pr.head?.repo?.full_name || null;
      // WHERE it merges (src/workflow/rules/pr-base.ts): main (the
      // repository's default branch: null here), or the branch of another
      // open change it is stacked on, which it then waits for. Any other base
      // is refused when it is put up for a vote.
      const baseRef = prBase.otherBase(pr);

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
      // A replay plan from an older agent is ignored: before/after
      // shots are taken by the shots agent from the declared changes.
      let importVisibleChanges;
      try {
        importVisibleChanges = parseImportVisibleChanges(req.body);
      } catch (err) {
        return res.status(400).json({
          error: err.code || 'invalid_visible_changes',
          message: err.message,
        });
      }
      // The request this pull request implements (#1217). A submission
      // prepared from a request knows its number — prepare_work records it,
      // and the work order prints it — but it stopped at the task, so a
      // proposal built FROM a request was linked to it nowhere the platform
      // could act on: no `Closes #N` for GitHub to honour on merge, nothing
      // for the post-merge close watcher to expect, and no "in progress"
      // chip on the request it came from.
      //
      // Sanitized here rather than trusted, like the testing metadata beside
      // it: same validator the PR-body producer uses, and the browser's own
      // import button sends none, which leaves the column at the empty array
      // it defaulted to before.
      const importLinkedIssues = parseImportLinkedIssues(req.body);
      const importSummary = parseImportSummary(req.body);
      const promote = req.body?.promote === true;
      const initialStatus = 'active';

      // Every import joins the shared In-progress board first. Automated
      // submission paths may go straight to a vote with `promote: true`: the
      // proposal machine is asked in the import's own transaction, and puts
      // it up for a vote the way the promote route does (under the owner's
      // cap, never a draft its author keeps: bugs 10, 11).
      const importClient = await pool.connect();
      let inserted;
      let shotsResult = null;
      let promoteEvent = null;
      try {
        await importClient.query('BEGIN');
        const waitsFor = (await prBase.readBaseOwner(importClient, { appId: app.id, sessionId: null, base: baseRef })).open;
        ({ rows: inserted } = await importClient.query(
          `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status,
            source, imported_pr_head_sha, handoff_base_sha,
            imported_pr_author, imported_pr_head_repo, imported_pr_base_ref, waits_for_session_id,
            promoted_at, shared_at, created_at,
            testing_md, testing_path, testing_paths, linked_issues, pr_body,
            pr_summary_md, pr_summary_source, pr_summary_source_head_sha,
            pr_summary_source_body_hash, pr_summary_applied_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text,
            'imported', $8::text, $9, $10, $11, $19, $20,
            NULL, NOW(),
            NOW(), $12, $13, $14::jsonb, $15, $16, $17,
            CASE WHEN $17::text IS NULL THEN NULL ELSE 'author' END,
            CASE WHEN $17::text IS NULL THEN NULL ELSE $8::text END,
            CASE WHEN $17::text IS NULL THEN NULL ELSE $18 END,
            CASE WHEN $17::text IS NULL THEN NULL ELSE 0 END)
           RETURNING id, status`,
          [
            app.id, req.user.id, headBranch, prNumber, pr.html_url || null,
            pr.title || `PR #${prNumber}`, initialStatus,
            headSha, baseSha, pr.user?.login || null, headRepoFullName,
            importTesting.testingMd, importTesting.testingPath,
            importTesting.testingPaths ? JSON.stringify(importTesting.testingPaths) : null,
            // Always an array, never null: the column is INTEGER[] NOT NULL
            // DEFAULT '{}', so an import with no request writes the empty
            // array the omitted column used to default to — byte-identical to
            // the row this route wrote before the field existed.
            importLinkedIssues,
            // #1333. The imported PR's body, mirrored on the way in. The route
            // already holds `pr`, so this costs no extra GitHub call and the
            // proposal reports a description from its very first read.
            pr.body || null,
            // The user-facing half of the About sheet. Null when the submitter
            // sent none: the platform does not generate one here, so a proposal
            // without it renders exactly as it did before this field existed.
            importSummary,
            summaryFreshness.bodyHash(pr.body || null),
            baseRef, waitsFor ? waitsFor.id : null,
          ]
        ));
        await topicAttrs.selfAssignProposal(
          importClient, app.id, inserted[0].id, req.user
        );
        if (config.shots?.collect && importVisibleChanges) {
          try {
            shotsResult = await shotsState.recordIntentInTransaction(
              importClient,
              inserted[0].id,
              importVisibleChanges,
              shotsState.validSha(headSha) ? { headSha, pin: 'imported' } : {}
            );
          } catch (err) {
            // This transaction owns `importClient`; recordIntent must neither
            // reconnect nor release it. Preserve a safe boundary marker for
            // the outer HTTP error without exposing the database exception.
            if (err && typeof err === 'object') {
              err.prImportStage = 'visible_changes';
              err.prImportField = 'visibleChanges';
            }
            throw err;
          }
        }
        if (promote) {
          promoteEvent = await require('../workflow/platform.ts').promoteInTransaction({
            sessionId: inserted[0].id, appId: app.id, userId: req.user.id, username: req.user.username, from: 'active',
            cap: effectiveSessionCaps(config, req.user).promotedSessions,
            pr: { state: pr.state, draft: !!pr.draft, merged: !!pr.merged, head: headSha, base: baseRef },
            expectedHead: headSha, db: importClient, source: { kind: 'route', name: 'pr-import' },
          });
        }
        await importClient.query('COMMIT');
      } catch (err) {
        await importClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        importClient.release();
      }
      const sessionId = inserted[0].id;
      // A straight-to-vote import: answered once it is up for a vote (or
      // refused), within about twenty seconds; past them it is being put up.
      const promoted = promoteEvent != null
        ? await require('../workflow/platform.ts').promoteCommitted(promoteEvent, {
          sessionId, cap: effectiveSessionCaps(config, req.user).promotedSessions,
        })
        : null;
      const status = promoted?.status === 200 ? 'promoted' : initialStatus;
      const session = {
        id: sessionId, app_id: app.id, app_slug: app.slug, user_id: req.user.id,
        branch_name: headBranch, pr_number: prNumber, pr_title: pr.title || null,
        pr_body: pr.body || null,
        repo_url: app.repo_url, staging_url: null, source: 'imported',
        status, imported_pr_head_sha: headSha,
        handoff_base_sha: baseSha,
        imported_pr_head_repo: headRepoFullName,
        // #1330: the capture reads its routes off THIS object — the INSERT
        // above is not what it consults. kickImportedChecks hands this literal
        // to visuals.captureForSession, which derives both `pathDefaulted` and
        // `capturePaths` from `session.testing_paths` / `session.testing_path`.
        // Leaving them off meant EVERY connector submission's before/after pair
        // was shot on the app's home page, however carefully its `testingPaths`
        // named the screen that changed — and `submit_work` still echoed the
        // routes back as accepted, because they genuinely were: the row had
        // them all along. That is also why only the FIRST capture was wrong.
        // syncImportedProposal re-captures from a session loaded with
        // `SELECT cs.*`, so a later re-shoot used the routes; the one the
        // voters actually look at never did.
        testing_md: importTesting.testingMd,
        testing_path: importTesting.testingPath,
        testing_paths: importTesting.testingPaths,
        shots_state: shotsResult?.state || null,
        shots_run_id: shotsResult?.runId || null,
        shots_detail: shotsResult?.detail || null,
      };

      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'imported', sessionId, appSlug: app.slug });

      log.info('votes', 'PR imported', { sessionId, prNumber, appId: app.id, status });
      const visibleChangesSubmission = require('../services/proposal-update').visibleChangesSubmissionFields(
        shotsResult || {
          state: null,
          accepted: false,
          rejected: !!importVisibleChanges,
          required: false,
          nextStep: importVisibleChanges
            ? 'shots_collection_disabled'
            : 'none',
        }
      );
      res.json({
        ok: true,
        sessionId,
        prNumber,
        status,
        // Asked to go straight to a vote and it did not (yet): why, as the
        // promote route would have answered.
        ...(promoted && promoted.status !== 200
          ? { promote: { status: promoted.status, ...(promoted.body || {}) } } : {}),
        ...visibleChangesSubmission,
      });

      // Kick the SHA-pinned staging build + checks after responding.
      const appForBuild = { id: app.id, slug: app.slug, name: app.name, repo_url: app.repo_url };
      kickImportedChecks(session, appForBuild, headSha);
    } catch (err) {
      log.error('votes', 'PR-import failed', {
        message: err.message,
        stage: err?.prImportStage || null,
        field: err?.prImportField || null,
      });
      res.status(500).json(prImportFailureBody(err));
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
  // #2525: rate-limited because a CHANGED vote posts a system line into the
  // proposal's thread and notifies; flipping yes/no is the spam shape.
  router.post('/api/sessions/:id/vote', governanceVoteLimiter, requireMembership, async (req, res) => {
    const { vote } = req.body;
    if (!['yes', 'no'].includes(vote)) {
      return res.status(400).json({ error: 'Vote must be "yes" or "no"' });
    }
    // #1688: the sentence behind the vote. Optional on a Yes; a No without
    // one is refused further down, once the voter's earlier row is known.
    const normalized = normalizeVoteReason(req.body?.reason);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const reason = normalized.reason;

    try {
      // Accept votes on 'promoted' OR 'merging' sessions — once a merge
      // has started, a user flipping their vote shouldn't 404. But we
      // only *do* anything with the vote (chat message, merge check) if
      // it actually changed; see below.
      const { rows: sessionRows } = await pool.query(
      `SELECT cs.*, a.slug as app_slug, a.repo_url,
                a.self_hosted as app_self_hosted
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status IN ('promoted', 'merging')`,
        [req.params.id]
      );
      if (!sessionRows.length) {
        // #6101: the change merged (or left review) since the list this
        // voter was looking at was read. Say which it is, so the client can
        // close the vote instead of putting its Yes and No back.
        const { rows: latestRows } = await pool.query(
          `SELECT status, merged_at FROM chat_sessions WHERE id = $1`,
          [req.params.id]
        ).catch(() => ({ rows: [] }));
        const latest = latestRows[0] || null;
        return res.status(404).json({
          error: 'Promoted session not found',
          code: 'not_up_for_vote',
          ...(latest ? { status: latest.merged_at ? 'merged' : latest.status } : {}),
        });
      }
      const session = sessionRows[0];
      // A private member does not vote on a public app (communities.js).
      const privateRefusal = await communities.privateVoteRefusal(pool, session.app_id, req.user?.id);
      if (privateRefusal) return res.status(403).json(privateRefusal);
      // A public app's vote counts from a verified account (communities.js).
      const identityRefusal = await communities.identityVoteRefusal(pool, session.app_id, req.user?.id);
      if (identityRefusal) return res.status(403).json(identityRefusal);

      // #2782: the revision as the ROW has it — no GitHub round-trip. This
      // used to be a fresh reconcile, which meant a full `git fetch` of the
      // app's repository (queued behind any other fetch of it, and a cold
      // clone after a restart) in front of every vote: the "sometimes a Yes
      // takes ages to register" report.
      //
      // Nothing the fetch protected depends on it being HERE:
      //   - The vote is bound to the epoch the voter was shown, atomically,
      //     inside recordVote's row lock. A click on a proposal whose
      //     approvals were already cleared is refused below, as before.
      //   - A push the platform has not noticed yet leaves the epoch where
      //     it was, so the vote is stamped with the epoch describing the code
      //     the voter reviewed. The fresh reconcile run right after the
      //     response (settleVoteInBackground) finds the push and, if it was
      //     authored, bumps the epoch — which retires this vote with every
      //     other one on the old code. A mechanical sync keeps it, exactly as
      //     the in-request read would have.
      //   - The merge itself never trusted this read: the merge gate
      //     reconciles again, re-checks the shots gate at the exact
      //     head, and merges only the pinned sha.
      const revision = await reconcileNativeReviewedHead({
        config, pool, session, offline: true,
      });
      if (revision.blocked) {
        return res.status(revision.transient ? 503 : 409).json({ error: revision.reason });
      }

      const shotsGate = await readShotsGate(config, pool, session);
      if (shotsGate.applies && !shotsGate.allowed) {
        return res.status(409).json({
          error: 'shots_required',
          message: shotsGate.reason,
          shotsState: shotsGate.state,
        });
      }

      // A Yes vote can be the operation that applies a value held by a
      // secret-declaration proposal. The generic session vote path stays
      // available for ordinary PRs, but api:access is not credential authority.
      if (isCliCredentialManagementSession(req, session)) {
        return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
      }

      // A click approves the PROPOSAL the voter was shown, which is not the
      // same claim as "the commit the voter was shown". The old guard compared
      // commits and so rejected this click on every platform sync — including
      // the ones reconciliation had just certified changed nothing, which is
      // how a vote-preserving merge still cost somebody their vote (#2038).
      // The epoch only moves when bytes nobody approved were written.
      if (!voteMatchesApprovalEpoch(req.body?.expectedEpoch, revision)) {
        return revisionChangedVoteResponse(res, revision.headSha, null, revision.epoch);
      }

      // Was this a new vote, or a flip? Distinguishing matters because
      // without this, a user mashing "Yes" would post the same
      // "X voted yes on PR #N" line to group chat every time AND fire a
      // fresh merge gate on every click — which, before the merge
      // concurrency guard, caused 7× parallel GitHub merges + docker
      // rebuilds stepping on each other's tempdirs and container names.
      // The DB upsert itself is still safe (UNIQUE(session_id,user_id))
      // but we avoid the side-effects on a no-op.
      const { rows: prevRows } = await pool.query(
        `SELECT pv.vote, pv.reason, pv.approval_epoch, cs.approval_epoch AS current_epoch
           FROM pr_votes pv JOIN chat_sessions cs ON cs.id = pv.session_id
          WHERE pv.session_id = $1 AND pv.user_id = $2`,
        [session.id, req.user.id]
      );
      const previousVote = prevRows[0]?.vote || null;
      const previousReason = prevRows[0]?.reason || null;
      const voteHeadSha = reviewedHeadForSession(session);
      // #2038: "unchanged" means the same person voting the same way on the
      // same PROPOSAL. Keying it on the commit made a re-vote after a
      // mechanical sync look like a change, re-posting to group chat and
      // re-entering the merge gate for a click that moved nothing.
      const sameSide = previousVote === vote
        && prevRows[0]?.approval_epoch != null
        && prevRows[0].approval_epoch === prevRows[0].current_epoch;
      const unchanged = sameSide && (reason === null || reason === previousReason);
      // Same side, new words (#1688): the row is updated and the roster
      // re-reads it, but nothing is announced or re-counted — the vote did
      // not move.
      const reasonOnly = sameSide && !unchanged;

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
        reason,
        expectedEpoch: req.body?.expectedEpoch,
        voter: req.user.username || null,
      });
      // The line the row now carries: the one sent, or the earlier one the
      // upsert kept for a same-side re-cast (a Yes carried onto a new
      // version brings its sentence along).
      const recordedReason = recorded?.rows?.[0]?.reason ?? reason ?? null;
      if (revision.enforced && (recorded.rowCount || 0) === 0) {
        // The epoch moved (or the proposal left review) between the read
        // above and the write lock. Never transfer this click to the new
        // revision; answer with the epoch it is at now so the next click can
        // land without waiting on a refetch (#2038).
        const { rows: latestRows } = await pool.query(
          `SELECT reviewed_head_sha, approval_epoch FROM chat_sessions WHERE id = $1`,
          [session.id]
        ).catch(() => ({ rows: [] }));
        const latest = latestRows[0] || null;
        return revisionChangedVoteResponse(
          res,
          latest?.reviewed_head_sha || reviewedHeadForSession(session),
          'This proposal changed while your vote was being recorded. Refresh it, review the new revision, then vote again.',
          latest ? latest.approval_epoch : null
        );
      }
      if ((recorded.rowCount || 0) === 0) {
        // It left review between the read above and the write lock (an
        // imported proposal moved back to Underway, withdrawn): no vote.
        // #6101: answer with where the change is now, so the client closes
        // the vote rather than restoring it, and says why it did not count.
        const { rows: latestRows } = await pool.query(
          `SELECT status, merged_at FROM chat_sessions WHERE id = $1`,
          [session.id]
        ).catch(() => ({ rows: [] }));
        const latest = latestRows[0] || null;
        return res.status(409).json({
          error: 'This proposal is no longer up for a vote.',
          code: 'not_up_for_vote',
          ...(latest ? { status: latest.merged_at ? 'merged' : latest.status } : {}),
        });
      }

      // A vote revives a going-stale proposal: the proposal machine's review
      // check reads the newest vote under its lock, and a vote since the
      // warning clears it rather than closing the proposal (R2).

      // Auto-dismiss this voter's PR notifications for this session now that
      // the vote is recorded in the DB (i.e. confirmed, not optimistic). Runs
      // before the `unchanged` early-return below so a re-vote still ensures
      // the nudge is cleared, and it's idempotent (clears only unread rows).
      // Non-fatal: a notification hiccup must never 500 a successful vote.
      try {
        let cleared = await notifications.markReadForSession(pool, req.user.id, session.id);
        // 5 October (Page Turners): and a "Waiting for your approval" digest
        // with nothing left waiting on them, this being the last one. On its
        // own: a digest that could not be read never loses the push above.
        try {
          const settled = await notifications.settleVoteDigests?.(pool, { userIds: [req.user.id] });
          cleared += Array.isArray(settled) ? settled.length : 0;
        } catch (err) {
          log.warn('votes', 'Settling the voter\'s digests failed', { sessionId: session.id, err: err.message });
        }
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
      // B7: a Yes settles the "ready to try" card Homeroom bot sent this
      // voter about the change, on every device, and the card says what
      // happens next. The answer carries that too (`goesLive`), so the card
      // that was tapped says it at once rather than when the update lands.
      // One query when the voter has no such card. Never throws.
      const goesLive = vote === 'yes'
        ? await require('../services/homeroom-bot-dm').noteApproved(pool, session.id, req.user.id)
        : null;
      // And a proposal whose code did not come across from GitHub
      // (services/code-missing.js): the vote is recorded and counted, and
      // every answer to it says it cannot go live until the code is back.
      // Read from what this process already knows of the branches, never a
      // git read in front of the answer (#2782); the background settle asks
      // for no merge either way once its own read finds the branch missing.
      const codeMissingNote = await codeMissing.forSession(pool, session, { waitMs: 0 })
        ? { codeMissing: true, message: codeMissing.VOTE_NOTE } : {};
      const readyCard = { ...(goesLive ? { goesLive } : {}), ...codeMissingNote };

      if (unchanged) {
        log.debug('votes', 'Vote unchanged, skipping broadcast+merge', {
          sessionId: session.id, userId: req.user.id, vote,
        });
        return res.json({ ok: true, merged: false, unchanged: true, ...readyCard });
      }
      // #3977: a No's line on Homeroom bot's own change, while it is up for
      // a vote, goes to the bot as this voter's reply in the change's
      // discussion, and its follow-up is queued first to fix what the line
      // says (homeroom-bot-dm.js voteLineFor / voteLineTarget). Nothing for
      // a Yes, a No re-cast with the same words (returned above), or a
      // change that is not the bot's (one indexed read). Never throws.
      const botDm = require('../services/homeroom-bot-dm');
      const botLine = botDm.voteLineFor({ vote, reason: recordedReason, unchanged });
      const botTarget = botLine ? await botDm.voteLineTarget(pool, { sessionId: session.id }) : null;
      const handToBot = async () => (botTarget
        ? !!(await botDm.handVoteLine(pool, { user: req.user, target: botTarget, line: botLine }))?.ok
        : false);
      if (reasonOnly) {
        // #1688: the same vote with new words. The roster and the proposer's
        // notification read the row live, so a tally push is all the
        // clients need; no line is re-posted and no merge is re-checked.
        // #3977: new words on a No on the bot's change reach the bot.
        await handToBot();
        const { pushVoteUpdate: pushReason } = require('../services/ws');
        pushReason({ sessionId: session.id, appSlug: session.app_slug, merged: false });
        log.debug('votes', 'Vote reason updated', { sessionId: session.id, userId: req.user.id });
        return res.json({ ok: true, merged: false, unchanged: false, reasonUpdated: true, ...readyCard });
      }
      // 5 Oct: whoever asked Homeroom bot for this change reads their ready
      // card again, so it says who it still waits on now, and a yes is said
      // in the request's thread too: the bot's change machine heard the vote
      // in its own statement (recordVote).

      const voteLabel = session.pr_title
        ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;

      // #1374: tell the author somebody voted. Reached only on a real vote,
      // because the `unchanged` branch above already returned — and the
      // producer additionally de-dupes per (voter, session), so flipping a
      // vote back and forth is not a way to ping somebody repeatedly.
      //
      // Best-effort: a vote is recorded whether or not its notification is.
      try {
        notifications.createProposalVoteNotification?.(pool, {
          userId: session.user_id,
          appId: session.app_id,
          sessionId: session.id,
          voterId: req.user.id,
          vote,
        })?.then((created) => Promise.all(
          created.map((row) => notifications.hydrateAndPush(pool, row))
        ))?.catch((err) => log.error('votes',
          'Vote notification failed', { sessionId: session.id, err: err.message }));
      } catch (err) {
        log.error('votes', 'Vote notification threw', { sessionId: session.id, err: err.message });
      }

      // #1688: with a line, the row is the person's sentence rather than
      // their tally — the thread it lands in is the proposal's own, so the
      // PR label it used to repeat is the thread's title. Without one, the
      // line reads exactly as before.
      // #3977: a line handed to Homeroom bot is already in the thread, as
      // the voter's own reply just above this row, so the row leaves it out
      // and the discussion shows it once. Handed first, so it is there
      // whichever way the hand-off goes.
      const shownReason = (await handToBot()) ? null : recordedReason;
      const voteLine = shownReason
        ? `${req.user.username} voted ${vote}: “${shownReason}”`
        : `${req.user.username} voted ${vote} on ${voteLabel}`;
      await sendSystemMessage(pool, session.app_id,
        voteLine,
        'vote',
        // Lets the group-chat client render live vote buttons inline on
        // this activity row (see group-chat.js renderMessageHtml).
        { vote: { sessionId: session.id, prNumber: session.pr_number || null, reason: shownReason } },
        // #194: per-vote activity lands in the proposal's own thread, not
        // general chat — the promote/merge announcements remain the
        // general-chat entry points.
        { type: 'session', ref: session.id }
      );

      // Broadcast the new tally *before* the merge is asked for, and
      // respond to the voter right away: the merge is the app's merge
      // queue's (src/workflow/merge-queue/), which tells every client
      // when the proposal merges.
      const { pushVoteUpdate } = require('../services/ws');
      pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: false });
      log.info('votes', 'Vote cast', { sessionId: session.id, vote, userId: req.user.id });

      // #1688: a No is the one vote that can make a proposal contested. When
      // it does, the proposal's thread gets its script — once per version
      // (services/conversation-prompt.js). Never in the vote's way.
      if (vote === 'no') {
        require('../services/conversation-prompt').promptIfContested(pool, session)
          .then((r) => { if (r.prompted) log.info('votes', 'Conversation prompt posted', { sessionId: session.id, epoch: r.epoch }); })
          .catch((err) => log.warn('votes', 'Conversation prompt failed (non-fatal)', {
            sessionId: session.id, err: err.message,
          }));
      }

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
      // "Vote on a change" counts this vote now, not on the rule's next pass
      // (#3569; challengeScorer.scoreOnVote), so somebody who votes and goes
      // back to Home finds the step done. On a real vote only, the same gate
      // every side effect above has: a same-side re-cast returned earlier and
      // moved nothing, and the schedule counts the rare one that matters.
      // Never throws, so the vote answers the same either way.
      await challengeScorer.scoreOnVote(pool, config);
      res.json({ ok: true, merged: false, ...readyCard });

      // The live head read the response no longer waits on, then the ask
      // for a merge. Held in the in-flight registry so a shutdown's drain
      // lets it finish.
      inflightWork.track('vote-settle', settleVoteInBackground({ config, pool, session, revision }))
        .catch((err) => {
          log.error('votes', 'Background merge failed', { sessionId: session.id, err: err.message });
        });
    } catch (err) {
      log.error('votes', 'Vote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Take your vote back (the review flow's Undo). The same gates as casting
  // one: the shared vote limiter (a vote and its undo are one act, and a
  // scripted vote/undo loop is the flip loop the limiter exists for), the
  // membership gate, and the router's collab guard.
  //
  //   body (optional): { expectedEpoch } — the epoch the voter's screen was
  //   drawn at, as on a cast; also read from ?expectedEpoch=.
  //
  //   200 { ok, retracted: true, merged: false, vote, readyReopened? }
  //   200 { ok, unchanged: true }  — no vote of theirs counts now
  //   404 — no such change
  //   409 { code: 'vote_locked' } — no longer up for a vote (being merged,
  //       merged, closed, archived, or not proposed)
  //   409 { headChanged, approvalEpoch } — the change moved on since it was
  //       shown (revisionChangedVoteResponse)
  //
  // Not refused for identity or for a private member on a public project
  // (the cast route's identity/privacy refusals): those decide whose vote
  // may COUNT, and taking a vote back only ever removes one. Never asks for
  // a merge: whatever a retraction unblocks (a No taken back), the merge
  // queue's own sweep finds.
  router.delete('/api/sessions/:id/vote', governanceVoteLimiter, requireMembership, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const sessionId = parseInt(req.params.id, 10);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ error: 'Invalid session id' });
    }
    const expectedEpoch = req.body?.expectedEpoch ?? req.query?.expectedEpoch ?? null;
    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.app_id, cs.user_id, cs.status, cs.pr_number, cs.pr_title, cs.branch_name,
                cs.source, cs.reviewed_head_sha, cs.imported_pr_head_sha, a.slug AS app_slug
           FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
          WHERE cs.id = $1`,
        [sessionId]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Session not found' });
      const session = sessionRows[0];
      // The cast route's rule, kept: the CLI does not act on a proposal that
      // declares a secret, in either direction.
      if (isCliCredentialManagementSession(req, session)) {
        return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
      }

      const result = await retractVote({ pool, sessionId, userId: req.user.id, expectedEpoch });
      if (!result.found) return res.status(404).json({ error: 'Session not found' });
      if (result.status !== 'promoted') {
        return res.status(409).json({ error: VOTE_LOCKED_MESSAGE, code: 'vote_locked' });
      }
      const expected = parseExpectedEpoch(expectedEpoch);
      if (expected != null && expected !== result.epoch) {
        return revisionChangedVoteResponse(res, reviewedHeadForSession(session), null, result.epoch);
      }
      if (!result.vote) {
        log.debug('votes', 'Nothing to retract', { sessionId, userId: req.user.id });
        return res.json({ ok: true, unchanged: true });
      }

      // The author's "voted yes" no longer says something true.
      try {
        const cleared = await notifications.withdrawProposalVoteNotification?.(pool, {
          sessionId, voterId: req.user.id,
        });
        for (const userId of cleared || []) pushNotificationToUser(userId, { type: 'notifications_changed' });
      } catch (err) {
        log.warn('votes', 'Withdrawing the vote notification failed', { sessionId, err: err.message });
      }

      // B7 in reverse: a Yes taken back reopens the "ready to try" cards it
      // settled, so they offer Approve again. Never throws.
      const botDm = require('../services/homeroom-bot-dm');
      const reopened = result.vote === 'yes'
        ? await botDm.noteApprovalWithdrawn(pool, sessionId, req.user.id)
        : 0;
      const readyCard = reopened ? { readyReopened: true } : {};
      // Whoever asked the bot for this change reads their card again: the
      // bot's change machine heard the retraction in its own transaction.

      // The vote's own line stays in the proposal's thread, as a flip's
      // earlier line does; this line says it no longer stands.
      const voteLabel = session.pr_title
        ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${req.user.username} took back their vote on ${voteLabel}`,
        'system',
        { voteRetracted: { sessionId, prNumber: session.pr_number || null, vote: result.vote } },
        { type: 'session', ref: sessionId }
      );

      const { pushVoteUpdate } = require('../services/ws');
      pushVoteUpdate({ sessionId, appSlug: session.app_slug, merged: false });

      events.record(pool, {
        type: events.EVENT_TYPES.PR_VOTE_RETRACTED,
        userId: req.user.id,
        appId: session.app_id,
        sessionId,
        metadata: { vote: result.vote },
      });
      log.info('votes', 'Vote retracted', { sessionId, vote: result.vote, userId: req.user.id });
      return res.json({ ok: true, retracted: true, merged: false, vote: result.vote, ...readyCard });
    } catch (err) {
      log.error('votes', 'Vote retraction failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get vote tally for a session. #646: when the app restricts
  // approvals to invited approvers, `approvers` lists the usernames
  // whose votes QUALIFY (the roster, incl. the full-admin fallback) so
  // the FE can tag approver votes; it's absent under the default
  // 'anyone' policy.
  router.get('/api/sessions/:id/votes', async (req, res) => {
    try {
      // Every row, with whether it still counts: the ones from an earlier
      // version are the people the page names as asked back (#1688), so
      // they are read here rather than filtered out in SQL.
      const { rows: allRows } = await pool.query(
        `SELECT pv.vote, pv.reason, u.username, pv.user_id,
                ${currentVotePredicateSql('pv', 'cs')} AS current
         FROM pr_votes pv
         JOIN users u ON pv.user_id = u.id
         JOIN chat_sessions cs ON cs.id = pv.session_id
         WHERE pv.session_id = $1
         ORDER BY pv.created_at ASC, pv.id ASC`,
        [req.params.id]
      );
      const rows = allRows.filter((r) => r.current === true);
      const earlierRows = allRows.filter((r) => r.current !== true);

      const yes = rows.filter((r) => r.vote === 'yes');
      const no = rows.filter((r) => r.vote === 'no');

      const out = {
        yes: yes.map((r) => r.username),
        no: no.map((r) => r.username),
        // #1688: the sentence each counted vote carries, in vote order.
        reasons: rows.filter((r) => r.reason)
          .map((r) => ({ username: r.username, vote: r.vote, reason: r.reason })),
        // Votes cast on an earlier version of the proposal — still on the
        // row, no longer counted, their owners asked to take another look.
        earlier: {
          yes: earlierRows.filter((r) => r.vote === 'yes').map((r) => r.username),
          no: earlierRows.filter((r) => r.vote === 'no').map((r) => r.username),
        },
      };

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
                cs.check_state, cs.check_error_detail, cs.check_phase, cs.check_trigger, cs.checks_progress,
                -- #1442: the same freshness cache /promoted reads, so the
                -- home strip's pill and the proposal card cannot disagree
                -- about whether a proposal is ready to merge.
                cs.checks_base_sha, cs.checks_base_verdict, cs.checks_base_behind_by,
                cs.mergeability, cs.mergeability_files, cs.mergeability_files_complete,
                cs.freshness_behind_by, cs.freshness_checked_at,
                cs.requires_explicit_approval, cs.explicit_approval_reason,
                -- The member floor: Yes votes from someone other than the
                -- author, read only for a flagged row.
                CASE WHEN cs.requires_explicit_approval THEN
                  (SELECT COUNT(*)::int FROM pr_votes pv
                    WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                      AND pv.user_id IS DISTINCT FROM cs.user_id
                      AND ${countedVotePredicateSql('pv', 'cs')})
                END AS other_yes_count,
                -- #866: so the home strip can derive the same
                -- building/unavailable preview state the proposal card
                -- shows (see staging.previewDisplayState below).
                cs.staging_url, cs.source,
                cs.imported_pr_head_sha, cs.reviewed_head_sha,
                a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                    AND ${countedVotePredicateSql('pv', 'cs')}) AS yes_count,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'no'
                    AND ${countedVotePredicateSql('pv', 'cs')}) AS no_count
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
         WHERE cs.user_id = $1 AND cs.status IN ('promoted', 'merging')
           AND cs.is_headless = FALSE
         ORDER BY cs.promoted_at DESC NULLS LAST, cs.created_at DESC`,
        [req.user.id]
      );

      const { rows: governance } = await pool.query(
        `SELECT i.id, i.title, i.kind, i.created_at, i.created_by,
                a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
                a.self_hosted AS app_self_hosted,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'up' AND counts_toward_outcome(user_id, i.app_id)) AS up_count,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'down' AND counts_toward_outcome(user_id, i.app_id)) AS down_count,
                -- The member floor: a secret-change request is always flagged.
                (SELECT COUNT(*)::int FROM issue_votes
                  WHERE issue_id = i.id AND vote = 'up'
                    AND user_id IS DISTINCT FROM i.created_by
                    AND counts_toward_outcome(user_id, i.app_id)) AS other_up_count
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
      // The member floor's community size, read only for an app with a
      // flagged proposal (or a secret-change request, which is always one).
      const membersByApp = {};
      const floorApps = new Set([
        ...sessions.filter((r) => r.requires_explicit_approval).map((r) => r.app_id),
        ...governance.map((r) => r.app_id),
      ]);
      // #4666: who voted, on the projects with rules of their own.
      const rulesByApp = {};
      const issueRulesByApp = {};
      for (const appId of appIds) {
        statsByApp[appId] = await getActiveUserStats(pool, appId);
        govByApp[appId] = await governanceSvc.getGovernance(pool, appId);
        electorateByApp[appId] = await governanceSvc.getElectorate(pool, appId, govByApp[appId]);
        if (floorApps.has(appId)) {
          membersByApp[appId] = await governanceSvc.communityMemberCount(pool, appId);
        }
        if (govByApp[appId].rules) {
          rulesByApp[appId] = await governanceSvc.rulesContext(pool, appId, govByApp[appId], 'pr',
            sessions.filter((r) => r.app_id === appId).map((r) => r.id));
          issueRulesByApp[appId] = await governanceSvc.rulesContext(pool, appId, govByApp[appId], 'issue',
            governance.filter((r) => r.app_id === appId).map((r) => r.id));
        }
      }

      const proposals = [];
      // #5803: an admin's lone No arms the week-long takedown, and #5947 an
      // approver's its shorter one; the card's countdown must show the clock
      // the proposal machine acts on.
      const loneNoBySession = await governanceSvc.loneNoTimes(pool, sessions.map((s) => s.id));
      for (const s of sessions) {
        const gov = govByApp[s.app_id];
        const electorate = electorateByApp[s.app_id];
        const q = electorate?.approverIds
          ? await governanceSvc.qualifiedCounts(
            pool, 'pr', s.id, electorate.approverIds,
            s.requires_explicit_approval ? { authorId: s.user_id ?? null } : undefined
          )
          : { yes: s.yes_count, no: s.no_count, otherYes: s.other_yes_count };
        // Per-row dynamic merge gate + rejection countdown, mirroring
        // /api/apps/:slug/promoted (same anchor: promoted_at || created_at).
        // #788: the stamped flag rides on the row (added to this
        // endpoint's SELECT), so the no-timer modifier applies here
        // without a per-row GitHub call — and with it the member floor.
        const gate = governanceSvc.computeGate(
          gov, electorate?.active || 1, q.yes, q.no, s.promoted_at || s.created_at, null,
          {
            explicitApproval: !!s.requires_explicit_approval,
            otherYes: q.otherYes,
            memberCount: membersByApp[s.app_id],
            ...loneNoBySession.get(Number(s.id)),
            // These are the viewer's own proposals: they are the author.
            ...(rulesByApp[s.app_id] ? governanceSvc.rulesGateOpts(rulesByApp[s.app_id], s.id, req.user.id, s.explicit_approval_reason || null) : {}),
          }
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
          ...governanceSvc.explicitApprovalRowFields(s, gate),
          ...(gate.mode === 'rules' ? governanceSvc.ruleRowFields(gate) : {}),
          qualified_yes_count: gate.qualifiedYes,
          qualified_no_count: gate.qualifiedNo,
        });
        delete proposals[proposals.length - 1].other_yes_count;
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
            // #1442: the freshness fixtures carry through here too, so the
            // home strip's pill can be reviewed against the same three
            // states the proposal card renders.
            mergeability: m.mergeability || null,
            mergeability_files: m.mergeability_files || [],
            mergeability_files_complete: m.mergeability_files_complete == null
              ? null : m.mergeability_files_complete,
            checks_base_sha: m.checks_base_sha || null,
            checks_base_verdict: m.checks_base_verdict || null,
            checks_base_behind_by: m.checks_base_behind_by == null ? null : m.checks_base_behind_by,
            freshness_behind_by: m.freshness_behind_by == null ? null : m.freshness_behind_by,
            freshness_checked_at: m.freshness_checked_at || null,
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
          ? await governanceSvc.qualifiedCounts(
            pool, 'issue', g.id, electorate.approverIds, { authorId: g.created_by ?? null }
          )
          : { yes: g.up_count, no: g.down_count, otherYes: g.other_up_count };
        // Governance proposals have no promote step — created_at is the
        // visibility-window anchor. down votes feed both gates. A
        // secret-change request carries a value, so it is flagged: no
        // timer, and a Yes from another member (services/governance.js).
        const gate = governanceSvc.computeGate(
          gov, electorate?.active || 1, q.yes, q.no, g.created_at, null,
          {
            explicitApproval: true, otherYes: q.otherYes, memberCount: membersByApp[g.app_id],
            ...(issueRulesByApp[g.app_id] ? governanceSvc.rulesGateOpts(issueRulesByApp[g.app_id], g.id, g.created_by ?? null, 'secrets') : {}),
          }
        );
        const { other_up_count: _otherUp, app_self_hosted: selfHosted, ...rest } = g;
        governanceRows.push({
          ...rest,
          ...governanceSvc.explicitApprovalRowFields({
            requires_explicit_approval: true,
            explicit_approval_reason: require('../services/explicit-approval').secretChangeReason(selfHosted),
          }, gate),
          majority: statsByApp[g.app_id]?.majority || 1,
          activeUsers: statsByApp[g.app_id]?.active || 1,
          votes_required: gate.required,
          merge_window_ends_at: gate.windowEndsAt,
          contested: gate.contested,
          approval_policy: gate.policy,
          approvals_required: gate.approvalsRequired,
          ...(gate.mode === 'rules' ? governanceSvc.ruleRowFields(gate) : {}),
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
        pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, locked, repo_url`
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });
      const appRows = [gatedApp];

      const userId = req.user?.id || null;
      // The queue's own retry time for a merge GitHub held back (see
      // HELD_UNTIL_SQL in services/integration.js), read beside
      // integration_block_reasons, which carries the reason it explains.
      const heldUntilSql = require('../services/integration').HELD_UNTIL_SQL;
      // An admin's force merge, from the proposal machine's instance state
      // (services/merge-requirements.js FORCE_SQL), so the card can say it is
      // queued, which step it waits on, and that it skips the vote.
      const { FORCE_SQL: forceSql, FORCE_DROPPED_SQL: forceDroppedSql } = require('../services/merge-requirements');
      // Include 'merging' alongside 'promoted' so the PR stays visible
      // during the GitHub merge + prod rebuild + staging teardown
      // pipeline (~30s). Otherwise the card disappears the instant the
      // majority threshold is crossed and only reappears in the "merged"
      // list at the very end, making it look like the vote was lost.
      const { rows } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.pr_title_fallback, cs.pr_summary_md, cs.pr_summary_stale, cs.pr_body, cs.staging_url, cs.testing_md, cs.testing_path, cs.user_id, cs.status, cs.linked_issues, COALESCE(u.username, 'Deleted user') AS username, cs.created_at,
           cs.shots_state, cs.shots_run_id,
           cs.shots_detail, cs.shots_updated_at,
           -- #4490: the card's picture when it has no shots: the author's
           -- diagram, and "What it touches" for the head it was read at.
           cs.pr_diagram, cs.pr_diagram_source, cs.pr_touches, cs.pr_touches_sha,
           -- #2779: the agent session the change was started from. Only its
           -- id, as mergedRowSelect carries it for a merged row: the
           -- conversation itself answers to its owner alone. This list was
           -- the one copy of a change without it, so the owner's door on a
           -- change up for a vote led to its dev session instead (#3712).
           cs.agent_session_id,
           -- #687 (PR-import): provenance so the client can render the
           -- "Imported PR" badge + GitHub-maintained note and hide the
           -- dev-side controls for externally-authored proposals.
           cs.source, cs.imported_pr_author, cs.imported_pr_head_sha,
           cs.reviewed_head_sha,
           -- Where the imported head lives. The card decides from it (against
           -- the app's repo_url it already has) whether the platform syncs
           -- this branch itself or only the author can — without it the
           -- browser fell back to a branch-name guess and told the group
           -- "the author must update this branch in their fork" about a
           -- branch in the app's own repository (#2100).
           cs.imported_pr_head_repo,
           -- Where it merges, and the change it waits for when it is
           -- stacked on that change's branch (src/workflow/rules/pr-base.ts):
           -- the card's "Waits for #N" and the change page's notice.
           cs.imported_pr_base_ref, cs.waits_for_session_id,
           (SELECT jsonb_build_object('id', w.id, 'prNumber', w.pr_number, 'title', w.pr_title, 'status', w.status)
              FROM chat_sessions w WHERE w.id = cs.waits_for_session_id) AS waits_for,
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
           -- merge (the merge gate blocks a non-'passing' proposal).
           cs.check_state, cs.test_results, cs.checks_checked_at,
           cs.checks_commit_sha,
           -- #1442: the freshness cache. behind_main above is now written
           -- THROUGH from freshness_behind_by, so it and these agree; the
           -- rest are the answers nothing used to re-derive once a proposal
           -- was promoted — whether it still merges cleanly, and whether the
           -- base its checks passed against is still on main. All nullable:
           -- NULL is "not measured", which the card reads as unknown rather
           -- than as a claim.
           cs.checks_base_sha, cs.checks_base_verdict, cs.checks_base_behind_by,
           cs.mergeability, cs.mergeability_files, cs.mergeability_files_complete,
           cs.freshness_main_sha, cs.freshness_merge_base_sha,
           cs.freshness_behind_by, cs.freshness_ahead_by,
           cs.freshness_checked_at, cs.freshness_error,
           -- #2038: the single integration record, and the epoch a vote is
           -- pinned to. The card reads these; the six groups above are kept
           -- written-through for one release so nothing that still reads
           -- them breaks mid-rollout.
           cs.integration_measured_at, cs.integration_head_sha, cs.integration_main_sha,
           cs.integration_base_sha, cs.integration_behind_by, cs.integration_ahead_by,
           cs.integration_merges_clean, cs.integration_conflict_paths,
           cs.integration_merged_tree, cs.integration_checks_base_current,
           cs.integration_block_reasons, cs.integration_error,
           -- When the queue tries this change again after GitHub held its
           -- merge back (services/integration.js HELD_UNTIL_SQL).
           ${heldUntilSql} AS merge_held_until,
           ${forceSql} AS merge_force,
           ${forceDroppedSql} AS merge_force_dropped,
           cs.approval_epoch,
           -- #2061: the recording of what the merge gate last did, which the
           -- card turns into "what this still needs before it merges".
           cs.merge_requirements, cs.merge_requirements_at,
           -- Which half of a 'pending' run is in flight ('building' |
           -- 'testing'), so the checks card names the stage instead of
           -- showing one opaque "still running". NULL = legacy wording.
           cs.check_phase,
           cs.check_trigger,
           cs.checks_progress,
           -- Platform-variables pre-merge check (display mirror; the merge
           -- gate re-evaluates live).
           cs.platform_env_state, cs.platform_env_detail,
           -- #237: captured reason when checks are 'error' (staging preview
           -- failed to boot) — drives the "Preview won't boot" badge tooltip.
           cs.check_error_detail,
           -- #5054: an 'error' that is the platform's fault and still runs
           -- again on its own reads as in progress (merge-requirements).
           cs.check_error_platform, cs.consecutive_check_failures, cs.first_check_failure_at,
           -- #788: does this proposal change a protected dapp.json block
           -- (admins, governance, visibility, platform_env, secrets)? A
           -- flagged row loses the time-based merge paths (the gate below
           -- reports no merge_window_ends_at, so no countdown renders),
           -- needs a Yes from another member, and shows the lock.
           cs.requires_explicit_approval, cs.explicit_approval_reason,
           -- The member floor: Yes votes from someone other than the
           -- author, read only for a flagged row.
           CASE WHEN cs.requires_explicit_approval THEN
             (SELECT COUNT(*)::int FROM pr_votes pv
               WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                 AND pv.user_id IS DISTINCT FROM cs.user_id
                 AND ${countedVotePredicateSql('pv', 'cs')})
           END AS other_yes_count,
           -- #3234: the electorate the vote opened with (display only).
           cs.active_users_at_promote,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'yes'
               AND ${countedVotePredicateSql('pv', 'cs')}) as yes_count,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'no'
               AND ${countedVotePredicateSql('pv', 'cs')}) as no_count,
           (SELECT pv.vote FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.user_id = $2
               AND ${currentVotePredicateSql('pv', 'cs')}) as my_vote,
           -- #6282: an update on its way. The Votes card says so and holds
           -- its Vote button until it lands (AppView._changeVotesView).
           ${updateComingSql('cs')} AS update_coming,
           -- #4538: this change was built by Homeroom bot from a request
           -- made for the viewer, so their Workshop lists it in Your work.
           -- The bot stays the row's author; this only says whose ask it
           -- was (the shared fragment, services/bot-requested-by.js).
           COALESCE(${botRequestedBySql('cs', '$2')}, FALSE) AS requested_by_me,
           -- 13 Oct 2026, D1: the project's first version, which goes live
           -- without a vote once it passes its checks (the gate waives the
           -- vote below; the card says so instead of asking for one).
           ${firstVersionSql('cs')} AS first_version,
           -- Test accounts (D1): the viewer is a test account and a real
           -- person made this app, so their vote is recorded and shown but
           -- not counted. The vote picker says so in one line.
           NOT counts_toward_outcome($2, cs.app_id) AS my_vote_uncounted,
           -- #1688: the viewer's vote on an EARLIER version — still on their
           -- row, no longer counted. The card asks "Still yes?" from it.
           (SELECT pv.vote FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.user_id = $2
               AND NOT COALESCE(${currentVotePredicateSql('pv', 'cs')}, FALSE)) as my_prior_vote,
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
                       'commit', sv.commit_hash,
                       'scenarioId', sv.scenario_id,
                       'scenarioFingerprint', sv.scenario_fingerprint,
                       'fellBack', sv.before_fell_back))
              FROM session_visuals sv WHERE sv.session_id = cs.id) as visuals_agg
         FROM chat_sessions cs
         LEFT JOIN users u ON cs.user_id = u.id
         LEFT JOIN chat_sessions orig ON orig.id = cs.revert_of_session_id
         WHERE cs.app_id = $1 AND cs.status IN ('promoted', 'merging')
         ORDER BY cs.created_at DESC`,
        [appRows[0].id, userId]
      );

      const visualsService = require('../services/visuals');
      const stagingService = require('../services/staging');
      for (const row of rows) {
        row.visuals = visualsService.shapeAgg(
          row.visuals_agg, visualHeadForSession(row)
        );
        delete row.visuals_agg;
        // #866: three-state Preview affordance. An imported PR is promoted
        // before its preview finishes building, so `staging_url IS NULL`
        // alone can't tell "building" from "failed" — derive both here
        // (in-memory build map + the captured checks error) rather than
        // persisting a staging_state column that a crash could strand.
        Object.assign(row, stagingService.previewDisplayState(row));
        // #239: an automatic conflict resolution under way, so the vote
        // panel can render a "Resolving conflicts…" badge: the proposal
        // machine's sync, projected as the row's `integrating` reason.
        row.resolving = Array.isArray(row.integration_block_reasons)
          && row.integration_block_reasons.includes('integrating');
      }
      const shotsBySession = config.shots?.present
        ? await shotsView.getForSessions(pool, rows, req.params.slug, { viewer: req.user })
        : new Map();
      for (const row of rows) row.shots = shotsBySession.get(Number(row.id)) || null;

      // A proposal whose branch is not on the git host: its code did not
      // come across when Homeroom moved off GitHub (services/code-missing.js).
      // Derived on every read, one query and one cached branch list for the
      // whole panel, so pushing the branch back clears it with nothing to
      // undo. The card says "Code missing" (AppView.blockReasons).
      const missing = await codeMissing.missingIds(pool, rows.map((row) => ({
        id: row.id, app_id: gatedApp.id, pr_number: row.pr_number, status: row.status, repo_url: gatedApp.repo_url,
      })));
      for (const row of rows) row.code_missing = missing.has(Number(row.id));

      // #4490: the picture a card falls back to. The diagram is the
      // author's, validated again on the way out; "What it touches" is
      // shown only for the head it was read at, and a moved head is read
      // again in the background for the next view. Not for a head whose
      // code is missing (no head is no read): there is nothing on the git
      // host to read, and the read warned on every view.
      proposalTouches.scheduleRefresh(pool, rows.map((row) => ({
        id: row.id, repo_url: gatedApp.repo_url, pr_touches_sha: row.pr_touches_sha,
        head: row.code_missing ? null : visualHeadForSession(row),
      })));
      for (const row of rows) {
        row.diagram = diagramContract.storedDiagram(row.pr_diagram);
        row.diagram_source = row.diagram ? (row.pr_diagram_source || 'author') : null;
        const head = visualHeadForSession(row);
        row.touches = head && row.pr_touches_sha === head ? proposalTouches.storedTouches(row.pr_touches) : null;
        delete row.pr_diagram; delete row.pr_diagram_source; delete row.pr_touches; delete row.pr_touches_sha;
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
      const demoMode = IS_STAGING && req.query.demo === '1';
      if (demoMode) {
        const have = new Set(rows.map((r) => r.id));
        rows.push(...ownDemoProposals(stagingMockProposals(req.user?.username), req.user).filter((m) => !have.has(m.id)));
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
      // The member floor's community size: one read per panel, and only
      // when a live row is flagged.
      const memberCount = rows.some((r) => r.votes_required == null && r.requires_explicit_approval)
        ? await governance.communityMemberCount(pool, appRows[0].id)
        : undefined;
      // #4666: who voted, on a project with rules of its own.
      const rulesCtx = gov.rules
        ? await governance.rulesContext(pool, appRows[0].id, gov, 'pr',
          rows.filter((r) => r.votes_required == null).map((r) => r.id))
        : null;
      // #5803 / #5947: the admin-No and approver-No clocks each row's card
      // shows, one query for the whole panel.
      const loneNoByRow = await governance.loneNoTimes(pool,
        rows.filter((r) => r.votes_required == null).map((r) => r.id));
      for (const row of rows) {
        if (row.votes_required != null) continue;
        const q = qualifiedByRow
          ? (qualifiedByRow.get(row.id) || { yes: 0, no: 0, otherYes: 0 })
          : { yes: row.yes_count, no: row.no_count, otherYes: row.other_yes_count };
        // #788: the stamped flag rides on the row (chat_sessions.* is
        // selected here), so the no-timer modifier applies with no extra
        // per-row work — a flagged row simply reports no
        // merge_window_ends_at and never renders a countdown — and the
        // member floor with it.
        const gate = governance.computeGate(
          gov, electorate.active, q.yes, q.no,
          row.promoted_at || row.created_at, null,
          {
            explicitApproval: !!row.requires_explicit_approval,
            otherYes: q.otherYes,
            memberCount,
            ...loneNoByRow.get(Number(row.id)),
            ...(rulesCtx ? governance.rulesGateOpts(rulesCtx, row.id, row.user_id ?? null, row.explicit_approval_reason || null) : {}),
            firstVersion: row.first_version === true,
          }
        );
        row.votes_required = gate.required;
        row.merge_window_ends_at = gate.windowEndsAt;
        row.contested = gate.contested;
        row.reject_window_ends_at = gate.rejectionEndsAt;
        row.rejection_armed = gate.rejectionArmed;
        row.approval_policy = gate.policy;
        row.approvals_required = gate.approvalsRequired;
        // #4747: whether this viewer's vote decides, or is advisory — an
        // invited project's non-approver, or someone outside every group a
        // rules project's rule names. The picker and the vote rows say so.
        row.my_vote_advisory = !!userId
          && row.my_vote_uncounted !== true
          && !governance.viewerDecides(gov, {
            approverIds: electorate.approverIds,
            facts: rulesCtx ? rulesCtx.facts : null,
            explicitApproval: !!row.requires_explicit_approval,
            explicitReason: row.explicit_approval_reason || null,
          }, userId);
        Object.assign(row, governance.explicitApprovalRowFields(row, gate));
        if (gate.mode === 'rules') Object.assign(row, governance.ruleRowFields(gate));
        delete row.other_yes_count;
        row.qualified_yes_count = gate.qualifiedYes;
        row.qualified_no_count = gate.qualifiedNo;
        // #3234: display only — the threshold as it stood when voting opened.
        row.votes_required_at_promote = governance.requiredAtPromote(
          gov, row.active_users_at_promote, q.no
        );
      }

      // #1442: the freshness snapshot also rides as a nested camelCase block
      // for API consumers (the connector's get_proposal shapes from the same
      // vocabulary). The flat snake_case columns stay exactly where they were
      // — public/js/app-view.js reads those — so this is additive on both
      // sides rather than a rename anything has to follow.
      // The app's main, as services/main-watch.js last saw it. One read per
      // panel, not per row: a red main pauses every merge on the app, and
      // the provisional ledger below names that step off these columns.
      const mainCheck = await require('../services/main-watch').mergePause(pool, appRows[0].id);
      // And, for the platform's own app, a merged commit that has not become
      // the running release (services/release-watch.js). Only that row ever
      // carries one, so a child app's panel does not pay the read; the board
      // banner draws it.
      const releaseWatch = require('../services/release-watch');
      const releaseStall = appRows[0].self_hosted
        ? await releaseWatch.readStall(pool, appRows[0].id)
        : releaseWatch.describe(null);
      {
        const freshnessSvc = require('../services/proposal-freshness');
        const integrationSvc = require('../services/integration');
        const requirementsSvc = require('../services/merge-requirements');
        for (const row of rows) {
          row.freshness = freshnessSvc.readFreshness(row);
          // #6521: whether the last verdict describes this version, the same
          // rule the thread list and the merge gate use.
          row.checks_on_head = sessionChecksOnHead(row);
          // #2038: the one answer the card actually renders, carrying its own
          // measuredAt so it can say how old it is instead of implying it is
          // live. `blockReason` rides along so the card stops re-deriving a
          // guess from a thirteen-state precedence table — the gate knows
          // which rung refused and now says so.
          row.integration = integrationSvc.readIntegration(row);
          row.shotsEnforced = !!config.shots?.enforce
            && !!(row.shots_detail && typeof row.shots_detail === 'object');
          // #2061: the whole ordered list of what is still required, rather
          // than only what is currently wrong. The card's tags say the second;
          // nothing said the first, so two of the seven gates had no UI at all.
          row.mergeRequirements = requirementsSvc.readRequirements({
            ...row,
            shotsEnforced: row.shotsEnforced,
            app_main_check_state: mainCheck.state,
            app_main_check_sha: mainCheck.sha,
            app_main_check_resumed_sha: mainCheck.resumedSha,
            // The pause is its own fact (main_check_paused_sha), and a red
            // names its test; the ledger says both rather than re-deriving.
            app_main_check_paused: mainCheck.paused,
            app_main_check_paused_sha: mainCheck.pausedSha,
            app_main_check_confirming: mainCheck.confirming,
            app_main_check_failing_test: mainCheck.failingTest,
          });
        }
      }

      // #4479 / polish board #14: the plan each change was built from, so its
      // page draws the plan card with everything else (sessions.js).
      await require('./sessions').attachChangePlans(pool, rows, userId);
      res.json({
        // `?results=failing`: the shell's list form (services/list-test-results.js).
        promoted: listTestResults.forListing(req, rows),
        // services/main-watch.js: the unit suite's verdict on the last
        // merge commit, and whether it is pausing this app's merges.
        mainCheck,
        // services/release-watch.js: a merged self-app commit that is not
        // the running release. `stalled: false` everywhere but there.
        releaseStall,
        activeUsers,
        majority,
        viewerActive,
        // Surfaced so the vote panel can render the "(locked — also
        // needs an admin yes)" hint on the Open PRs / Rename proposals
        // sections without a second round-trip. See loadVotePanel in
        // public/js/app-view.js.
        //
        // FORCED OPEN IN DEMO MODE, staging only. A locked app legitimately
        // suppresses every DERIVED vote state on the client — a
        // threshold-met proposal there is waiting on an admin's Yes, not
        // being applied, so _derivedGovApplying / _govMergeDue in
        // app-view.js return nothing rather than promise a merge that isn't
        // happening. The mock rows exist precisely to show those states,
        // and they carry precomputed gate fields for the same reason (see
        // stagingMockProposals / stagingMockGovernance): a prod-cloned
        // staging DB brings the real app row with it, and the platform's own
        // app row is locked, so ?demo=1 rendered every mock as a plain
        // waiting card and the states were unreviewable. Only this
        // fixture-preview mode lies; the ordinary staging board still
        // reports the clone's real lock state, hint and notice included.
        locked: !!appRows[0].locked && !demoMode,
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
        pool, req.params.slug, req.user, 'view',
        `${appAccess.ACCESS_COLUMNS}, repo_url, runtime_kind, runtime_name,
         main_sha, main_pr_number, last_failure, release_stall, deploy_state, deploy_started_at, deploy_from_sha`
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });
      const appRows = [gatedApp];

      const userId = req.user?.id || null;

      // #429: keyset pagination so the Completed list can reach every
      // merged PR, not just the most-recent page. `limit` defaults to 20
      // (the historical cap) and is clamped to 50. `before_completed_at` + `before_id`
      // form the cursor — the (completed_at, id) of the last row the client
      // already has — and we page strictly older than it. Keyset (not
      // OFFSET) because new merges insert at the top and would otherwise
      // drift the offset. completed_at isn't unique, so id is the tiebreaker.
      //
      // The stream now interleaves TWO row types (merged PR sessions and
      // applied close-issue proposals — see below), whose ids come from
      // independent sequences, so the cursor carries a third part:
      // `before_type` ('pr' | 'close_issue', defaulting to 'pr' so older
      // clients can still omit the row type). Global order is
      // (completed_at DESC, type-rank DESC, id DESC) with rank pr=1 >
      // close_issue=0 — see completedRowCompare.
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 20;
      if (limit > 50) limit = 50;
      const beforeRaw = req.query.before_completed_at ?? req.query.before;
      const beforeIdRaw = parseInt(req.query.before_id, 10);
      let before = new Date(beforeRaw);
      // A cursor only applies when BOTH parts parse cleanly; otherwise we
      // ignore it and return the newest page (defensive against malformed
      // query strings).
      const hasCursor = beforeRaw != null && !Number.isNaN(before.getTime())
        && Number.isFinite(beforeIdRaw);
      const isFirstPage = !hasCursor;
      const beforeType = req.query.before_type === 'close_issue' ? 'close_issue' : 'pr';

      // Older open tabs send the row's creation date in `before`. Resolve
      // that row within this app so a recent merge of old work cannot skip
      // pages. New clients send completion time explicitly and need no lookup.
      if (hasCursor && req.query.before_completed_at == null) {
        const cursorParams = [appRows[0].id, beforeIdRaw];
        const { rows: cursorRows } = beforeType === 'pr'
          ? await pool.query(
            `SELECT COALESCE(merged_at, created_at) AS completed_at
               FROM chat_sessions WHERE app_id = $1 AND id = $2 AND status = 'merged'`, cursorParams)
          : await pool.query(
            `SELECT COALESCE((payload->>'appliedAt')::timestamptz, created_at) AS completed_at
               FROM issues WHERE app_id = $1 AND id = $2
                 AND kind = 'close_issue' AND status = 'closed' AND payload ? 'appliedAt'`, cursorParams);
        const resolved = new Date(cursorRows[0]?.completed_at);
        if (!Number.isNaN(resolved.getTime())) before = resolved;
      }

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
          ? 'AND (COALESCE(cs.merged_at, cs.created_at), cs.id) < ($3, $4)'
          : 'AND COALESCE(cs.merged_at, cs.created_at) < $3';
      const prParams = !hasCursor
        ? [appRows[0].id, userId, limit + 1]
        : beforeType === 'pr'
          ? [appRows[0].id, userId, before.toISOString(), beforeIdRaw, limit + 1]
          : [appRows[0].id, userId, before.toISOString(), limit + 1];
      const { rows: prRows } = await pool.query(
        `${mergedRowSelect()}
         WHERE cs.app_id = $1 AND cs.status = 'merged'
           ${prCursorSql}
         ORDER BY COALESCE(cs.merged_at, cs.created_at) DESC, cs.id DESC
         LIMIT $${prParams.length}`,
        // Fetch limit+1 so an extra row signals there's another page.
        prParams
      );
      const mergedShots = config.shots?.present
        ? await shotsView.getForSessions(pool, prRows, req.params.slug, { viewer: req.user })
        : new Map();
      for (const row of prRows) {
        row.shots = mergedShots.get(Number(row.id)) || null;
      }

      // Applied close-issue proposals join the Completed stream: a
      // kind='close_issue' governance row whose vote (or an admin
      // force-apply) actually closed the target carries payload.appliedAt
      // (the governance machine's apply). Withdrawn (withdrawnAt) and
      // superseded (supersededAt) rows never carry it, so they stay out.
      // chat_count / last_message_at mirror the open-issues endpoint's
      // governance-thread subqueries so the 💬 badge and activity sort
      // behave identically.
      const closeCursorSql = !hasCursor ? ''
        : beforeType === 'close_issue'
          ? "AND (COALESCE((i.payload->>'appliedAt')::timestamptz, i.created_at), i.id) < ($2, $3)"
          : "AND COALESCE((i.payload->>'appliedAt')::timestamptz, i.created_at) <= $2";
      const closeParams = !hasCursor
        ? [appRows[0].id, limit + 1]
        : beforeType === 'close_issue'
          ? [appRows[0].id, before.toISOString(), beforeIdRaw, limit + 1]
          : [appRows[0].id, before.toISOString(), limit + 1];
      const { rows: closeRows } = await pool.query(
        `SELECT i.id, i.kind, i.title, i.description, i.payload, i.status,
                i.github_issue_number, i.created_by, i.created_at,
                COALESCE((i.payload->>'appliedAt')::timestamptz, i.created_at) AS completed_at,
                u.username AS created_by_username,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'up' AND counts_toward_outcome(user_id, i.app_id)) AS up_count,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'down' AND counts_toward_outcome(user_id, i.app_id)) AS down_count,
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
          ORDER BY COALESCE((i.payload->>'appliedAt')::timestamptz, i.created_at) DESC, i.id DESC
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

      // #1922: what shipped this week and the week before, counted over the
      // WHOLE history. The Workshop's "shipped this week" used to count the
      // loaded page, so on any week with more merges than a page holds it
      // could only say "20+". Same rows and same timestamp as the client's
      // count (public/js/app-view.js `mergedAtOf`: a PR's merged_at, falling
      // back to created_at; an applied close-issue proposal's created_at), so
      // the two agree wherever both can see everything. First page only — it
      // is a fact about the column, not about the page being fetched. Plain
      // aliases on purpose: test stubs key on `AS total` and `cs.status`.
      //
      // #2176: "this week" is the CALENDAR week, Monday 00:00 UTC to now,
      // and "the week before" the whole seven days ahead of that Monday —
      // not a trailing 7-day window, which read as a rolling total that
      // moved every day. Same Monday the digest weeks and the kudos
      // allowance use (weekStartUtc, which mirrors date_trunc('week')).
      let shipped = null;
      if (isFirstPage) {
        const weekStart = `${weekStartUtc()}T00:00:00Z`;
        const { rows: shippedRows } = await pool.query(
          `SELECT COUNT(*) FILTER (WHERE t >= $2::timestamptz)::int AS shipped_week,
                  COUNT(*) FILTER (WHERE t < $2::timestamptz
                                     AND t >= $2::timestamptz - interval '7 days')::int AS shipped_prev_week
             FROM (
               SELECT COALESCE(merged_at, created_at) AS t
                 FROM chat_sessions
                WHERE app_id = $1 AND status = 'merged' AND live_at IS NOT NULL
               UNION ALL
               SELECT created_at AS t
                 FROM issues
                WHERE app_id = $1 AND kind = 'close_issue' AND status = 'closed'
                  AND payload ? 'appliedAt'
             ) shipped_rows`,
          [appRows[0].id, weekStart]
        );
        const week = Number(shippedRows[0]?.shipped_week);
        const prevWeek = Number(shippedRows[0]?.shipped_prev_week);
        if (Number.isFinite(week) && Number.isFinite(prevWeek)) shipped = { week, prevWeek };
      }

      // Same priority + assigned-person summary on completed proposals, so
      // the read-only chips stay visible after a PR merges.
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

      // Close-issue rows carry the CLOSED ISSUE's own tally, keyed by the
      // target issue number from the proposal payload. Attribute votes are
      // never deleted when an issue closes, so a task moved to Done keeps
      // the priority / assignee / category it accumulated while open — the
      // chips just have to keep reading them (they used to be dropped here
      // on purpose, which made moving a task to Done look like it wiped
      // those fields).
      const closePageRows = rows.filter((r) => r.row_type === 'close_issue');
      const closeIssueRef = (r) => {
        const n = parseInt(r.payload && r.payload.issueNumber, 10);
        return Number.isInteger(n) && n > 0 ? n : null;
      };
      const closeAttrs = await topicAttrs.summarizeForTargets(
        pool, appRows[0].id, 'issue',
        closePageRows.map(closeIssueRef).filter((n) => n != null), userId
      );
      for (const row of closePageRows) {
        const ref = closeIssueRef(row);
        const s = (ref != null && closeAttrs.get(ref)) || topicAttrs.emptySummary();
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
        const injected = stagingMockMerged(req.user).map((m) => ({ ...m, row_type: 'pr' }))
          .concat(stagingMockCompletedCloseIssues())
          .filter((m) => !have.has(key(m)));
        // #1788: make room for the mocks BEFORE merging them in, rather than
        // letting them compete with real history for the page.
        //
        // The old order was unshift, sort newest-first, then truncate to
        // `limit`. That trims the mocks like anything else, and these rows are
        // dated in DAYS — 9100060 is two days old — so they only survived
        // while fewer than `limit` real completed rows were newer than them.
        // On a day with 63 merges they fell off page one entirely, and since
        // the mocks are first-page-only by design they then appeared nowhere.
        //
        // That is what made the "A task moved to Done keeps its chips" check
        // look flaky: it was failing whenever the platform had been busy, so
        // its recorded flake rate rose with our own merge rate and it began
        // blocking unrelated proposals.
        //
        // Reserving the slots is the fix rather than re-dating the mocks to a
        // few hours old: that would work today and rot again at a higher merge
        // rate, and it would fight #1264, which spread these deliberately over
        // ~150 days so the report's monthly strip has something to draw.
        if (rows.length + injected.length > limit) {
          hasMore = true;
          rows.length = Math.max(0, limit - injected.length);
        }
        rows.unshift(...injected);
        // Re-sort so the mock close-issue rows interleave among the mock
        // merged PRs by date instead of clumping at the top.
        rows.sort(completedRowCompare);
        // The COUNT(*) above can't see the mock rows (they aren't in the
        // DB), so bump the total by however many we injected to keep the
        // demo badge self-consistent with the rows the board renders.
        total += injected.length;
        // Same for the week counts (#1922), with the client's timestamp rule
        // and the same calendar-week bounds as the query above (#2176).
        if (shipped) {
          const weekStartMs = Date.parse(`${weekStartUtc()}T00:00:00Z`);
          const WEEK = 7 * 86400000;
          for (const m of injected) {
            const t = new Date(m.merged_at || m.closed_at || m.created_at).getTime();
            if (!Number.isFinite(t)) continue;
            if (t >= weekStartMs) shipped.week += 1;
            else if (t >= weekStartMs - WEEK) shipped.prevWeek += 1;
          }
        }
      }

      for (const row of rows) row.completed_at = completedAt(row);
      let deployment = await annotateDeploymentState(config, pool, appRows[0], rows);
      // A proposal preview runs the platform app from the proposal head, so
      // its boot-time main_sha has no merged-session match. Give ?demo=1
      // deterministic child-delivery fixtures for the Done-column cues;
      // these mock rows have no real merge commits or running child app.
      if (IS_STAGING && req.query.demo === '1' && isFirstPage) {
        const demoRows = rows.filter((row) => row.row_type === 'pr'
          && Number(row.id) >= 9100000 && Number(row.id) <= 9100034);
        for (const row of demoRows) row.deployment_state = 'deployed';
        const pendingDemo = demoRows.find((row) => Number(row.id) === 9100000);
        if (pendingDemo) {
          pendingDemo.deployment_state = 'pending';
          pendingDemo.deployment_kind = 'child';
        }
        const failedDemo = demoRows.find((row) => Number(row.id) === 9100001);
        if (failedDemo) {
          failedDemo.deployment_state = 'failed';
          failedDemo.deployment_kind = 'child';
        }
        const unknownDemo = demoRows.find((row) => Number(row.id) === 9100002);
        if (unknownDemo) {
          unknownDemo.deployment_state = 'unknown';
          unknownDemo.deployment_kind = 'child';
        }
        // The platform's own merge waiting for its next release.
        const goingLiveDemo = rows.find((row) => row.row_type === 'pr' && Number(row.id) === DEMO_GOING_LIVE_ID);
        if (goingLiveDemo) {
          goingLiveDemo.deployment_state = 'deploying';
          goingLiveDemo.release = require('../services/release-watch').demoRelease();
        }
        const blockedDemo = rows.find((row) => row.row_type === 'pr' && Number(row.id) === DEMO_RELEASE_BLOCKED_ID);
        if (blockedDemo) {
          blockedDemo.deployment_state = 'stalled';
          blockedDemo.release_block = { ...DEMO_RELEASE_BLOCK };
        }
        deployment = {
          kind: 'child', state: 'pending',
          runningSha: 'dddddddddddddddddddddddddddddddddddddddd',
          liveSessionId: null, livePrNumber: null, pendingCount: null,
        };
      }

      // The plan each change was built from (see /promoted above).
      await require('./sessions').attachChangePlans(pool, rows, userId);
      res.json({
        // `?results=failing`: the shell's list form (services/list-test-results.js).
        merged: listTestResults.forListing(req, rows),
        hasMore, total, deployment, ...(shipped ? { shipped } : {}),
      });
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
  // #4367: a change's address is its pull request's number
  // (`/app/<slug>/dev/changes/<N>`, the "Change #N" on screen), and the page
  // still opens by session id. This turns the one into the other, under the
  // same view gate and visibility rule as the read below, so a number it
  // answers is one that read serves. Several sessions can name one PR; the
  // one that reached a vote wins, then the newest.
  router.get('/api/apps/:slug/changes/:number', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });
      const number = /^\d{1,9}$/.test(String(req.params.number))
        ? parseInt(req.params.number, 10) : NaN;
      if (!(number > 0)) return res.status(404).json({ error: 'Change not found' });
      const { rows } = await pool.query(
        `SELECT cs.id FROM chat_sessions cs
         WHERE cs.app_id = $1 AND cs.pr_number = $3
           AND (cs.status IN ('promoted', 'merging', 'merged')
             OR (cs.status IN ('active', 'paused')
               AND (cs.user_id = $2 OR cs.shared_at IS NOT NULL)))
         ORDER BY (cs.status IN ('promoted', 'merging', 'merged')) DESC, cs.id DESC
         LIMIT 1`,
        [gatedApp.id, req.user?.id || null, number]
      );
      let sessionId = rows[0] ? rows[0].id : null;
      // Staging demo mode: the by-id read's mock rows, by their PR number.
      if (!sessionId && IS_STAGING && req.query.demo === '1') {
        const mock = stagingMockMerged(req.user).concat(stagingMockProposals())
          .find((m) => Number(m.pr_number) === number);
        sessionId = mock ? mock.id : null;
      }
      if (!sessionId) return res.status(404).json({ error: 'Change not found' });
      res.json({ sessionId, prNumber: number });
    } catch (err) {
      log.error('votes', 'Failed to resolve change', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/apps/:slug/proposals/:id', async (req, res) => {
    try {
      // View-level (#621): read-only viewers can open a proposal's
      // topic view (my_vote resolves to null for them). `repo_url` for
      // whether its code is on the git host (services/code-missing.js).
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });

      const userId = req.user?.id || null;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(404).json({ error: 'Proposal not found' });

      const { rows } = await pool.query(
        `${mergedRowSelect()}
         WHERE cs.app_id = $1 AND cs.id = $3
           AND (cs.status IN ('promoted', 'merging', 'merged')
             OR (cs.status IN ('active', 'paused')
               AND (cs.user_id = $2 OR cs.shared_at IS NOT NULL)))
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
        proposal.shots = config.shots?.present
          ? await shotsView.getForSession(pool, proposal, req.params.slug, { viewer: req.user })
          : null;
        // #4490: the author's diagram, which leads the change's page.
        const drawn = await pool.query(
          'SELECT pr_diagram, pr_diagram_source FROM chat_sessions WHERE id = $1', [proposal.id]
        ).catch(() => ({ rows: [] }));
        proposal.diagram = diagramContract.storedDiagram(drawn.rows[0] && drawn.rows[0].pr_diagram);
        proposal.diagram_source = proposal.diagram ? (drawn.rows[0].pr_diagram_source || 'author') : null;
        // #4452: how long testing usually takes here, for the change page's
        // one testing bar and its time left (services/checks-estimate.js).
        proposal.checks_estimate = await require('../services/checks-estimate').forApp(pool, gatedApp.id);
        // #6234: Homeroom bot fixing its own change's failing checks, for the
        // Testing card (services/homeroom-bot-progress.js changeBotFix);
        // null for any change of a person's.
        proposal.bot_fix = await require('../services/homeroom-bot-progress')
          .changeBotFix(pool, proposal.id, { viewer: req.user }).catch(() => null);
        // #6116: what it has cost so far at list price, for its author or an
        // admin only, as the dev chat's meter (services/session-cost.js).
        proposal.cost_total_cents = await require('../services/session-cost')
          .sessionCostForViewer(pool, proposal, req.user);
        // #4479: the plan it was built from, for the page's plan card.
        proposal.plan = await require('./sessions')
          .changePlanFor(pool, proposal.id, proposal.user_id, userId).catch(() => null);
        // Its code did not come across from GitHub (services/code-missing.js):
        // the page's notice and the card's "Code missing", read as the list
        // reads it. Always written, as the board merges this read into its
        // held row key by key.
        proposal.code_missing = await codeMissing.forSession(pool, {
          ...proposal, app_id: gatedApp.id, repo_url: gatedApp.repo_url,
        });
        // An update from this version's original (services/upstream-offers.js):
        // what it brings, what it does here, and where it stands, for the
        // change page's From <original> card. Null for any other change.
        proposal.upstream = await require('../services/upstream-offers').changeView(pool, proposal.id);
        // #6140: what its Preview reads (AppView._cardPreviewSpec), on a change
        // still up for a vote. A request's page draws a change from this read
        // alone, with no board row under it, so without these its Testing card
        // had no Try it. The fields /promoted carries, with its own derivation
        // of building and failed; can_preview is the one the session lists
        // use, so a preview gone to sleep can be woken. Never while it builds:
        // _cardPreviewSpec offers a rebuild before it says "building". A
        // merged row keeps its shape: its page offers the live app instead.
        if (proposal.status === 'promoted' || proposal.status === 'merging') {
          const { rows: [preview] } = await pool.query(
            `SELECT staging_url, testing_md, testing_path,
                    (pr_number IS NOT NULL OR checks_commit_sha IS NOT NULL
                       OR shared_at IS NOT NULL) AS can_preview
               FROM chat_sessions WHERE id = $1`,
            [proposal.id]
          );
          proposal.staging_url = preview?.staging_url || null;
          proposal.testing_md = preview?.testing_md || null;
          proposal.testing_path = preview?.testing_path || null;
          Object.assign(proposal, require('../services/staging').previewDisplayState(proposal));
          proposal.can_preview = !!preview?.can_preview && !proposal.staging_building;
        }
      }

      // #3669: the proposal page's own read must carry the same per-row
      // governance fields the list rows do. AppView._refreshTopicLive
      // refetches THIS endpoint right after a vote and merges the response
      // into the held board row key-wise, so a response without
      // qualified_* / votes_required left the pre-vote pill standing
      // ("0 of 1 approval") until a full board reload. Promoted/merging
      // rows get the identical enrichment /promoted applies; merged rows
      // keep their historical snapshot, and active rows have no vote to
      // describe.
      if (proposal && (proposal.status === 'promoted' || proposal.status === 'merging')
        && proposal.votes_required == null) {
        const governance = require('../services/governance');
        const gov = await governance.getGovernance(pool, gatedApp.id);
        const electorate = await governance.getElectorate(pool, gatedApp.id, gov);
        const flagged = !!proposal.requires_explicit_approval;
        const rulesCtx = gov.rules
          ? await governance.rulesContext(pool, gatedApp.id, gov, 'pr', [proposal.id])
          : null;
        const q = electorate.approverIds
          ? await governance.qualifiedCounts(
            pool, 'pr', proposal.id, electorate.approverIds,
            flagged ? { authorId: proposal.user_id ?? null } : undefined
          )
          : { yes: proposal.yes_count, no: proposal.no_count, otherYes: proposal.other_yes_count };
        // 13 Oct 2026, D1: the project's first version, whose vote the gate
        // waives; the change page says it goes live without one.
        proposal.first_version = await isFirstVersion(pool, proposal.id);
        // #5803 / #5947: the clock an admin's or approver's lone No arms, for
        // the page's pill.
        const loneNoByProposal = await governance.loneNoTimes(pool, [proposal.id]);
        const gate = governance.computeGate(
          gov, electorate.active, q.yes, q.no,
          proposal.promoted_at || proposal.created_at, null,
          {
            explicitApproval: flagged,
            otherYes: q.otherYes,
            memberCount: flagged
              ? await governance.communityMemberCount(pool, gatedApp.id) : undefined,
            ...loneNoByProposal.get(Number(proposal.id)),
            // #4666: who voted, on a project with rules of its own.
            ...(rulesCtx ? governance.rulesGateOpts(
              rulesCtx,
              proposal.id, proposal.user_id ?? null, proposal.explicit_approval_reason || null
            ) : {}),
            firstVersion: proposal.first_version,
          }
        );
        proposal.votes_required = gate.required;
        proposal.merge_window_ends_at = gate.windowEndsAt;
        proposal.contested = gate.contested;
        proposal.reject_window_ends_at = gate.rejectionEndsAt;
        proposal.rejection_armed = gate.rejectionArmed;
        proposal.approval_policy = gate.policy;
        proposal.approvals_required = gate.approvalsRequired;
        // #4747, same field the /promoted rows carry. Always written: the
        // board merges this response into its held row key by key, so a
        // missing key would leave a stale advisory value behind.
        proposal.my_vote_advisory = !!userId
          && proposal.my_vote_uncounted !== true
          && !governance.viewerDecides(gov, {
            approverIds: electorate.approverIds,
            facts: rulesCtx ? rulesCtx.facts : null,
            explicitApproval: flagged,
            explicitReason: proposal.explicit_approval_reason || null,
          }, userId);
        Object.assign(proposal, governance.explicitApprovalRowFields(proposal, gate));
        if (gate.mode === 'rules') Object.assign(proposal, governance.ruleRowFields(gate));
        proposal.qualified_yes_count = gate.qualifiedYes;
        proposal.qualified_no_count = gate.qualifiedNo;
        // #3234: display only — the threshold as it stood when voting opened.
        proposal.votes_required_at_promote = governance.requiredAtPromote(
          gov, proposal.active_users_at_promote, q.no
        );

        // The ledger too (services/merge-requirements.js): the card's
        // "Waiting on the group" line reads the merge gate's recording,
        // which a vote does not supersede — withLiveApprovals reconciles
        // its waiting approvals step against the columns just attached.
        const mainCheck = await require('../services/main-watch').mergePause(pool, gatedApp.id);
        // #6521: always written: the board merges this response into its
        // held row key by key, and the page reads it on its Tested card.
        proposal.checks_on_head = sessionChecksOnHead(proposal);
        proposal.freshness = require('../services/proposal-freshness').readFreshness(proposal);
        proposal.integration = require('../services/integration').readIntegration(proposal);
        proposal.shotsEnforced = !!config.shots?.enforce
          && !!(proposal.shots_detail && typeof proposal.shots_detail === 'object');
        proposal.mergeRequirements = require('../services/merge-requirements').readRequirements({
          ...proposal,
          shotsEnforced: proposal.shotsEnforced,
          app_main_check_state: mainCheck.state,
          app_main_check_sha: mainCheck.sha,
          app_main_check_resumed_sha: mainCheck.resumedSha,
          // The pause is its own fact (main_check_paused_sha), and a red
          // names its test; the ledger says both rather than re-deriving.
          app_main_check_paused: mainCheck.paused,
          app_main_check_paused_sha: mainCheck.pausedSha,
          app_main_check_confirming: mainCheck.confirming,
          app_main_check_failing_test: mainCheck.failingTest,
        });
      }

      // Staging demo mode (?demo=1): the mock merged/promoted rows aren't in
      // the DB, so resolve a mock id straight from the generators. This lets
      // a staging tester deep-link a mock Completed proposal that never
      // reached the first page (ids ~9100021+) and confirm it opens on
      // demand. Strictly a no-op in production (gated on IS_STAGING).
      //
      // #4524: the topic page's fast open fires this read beside the board
      // load, so it also lands here for the mock OWN and SHARED sessions the
      // session lists append — ids the DB will never hold. Production's SQL
      // above serves those states (an active or paused session the viewer
      // owns or that is shared), so the demo generators answer them the same
      // way; a 404 in the network log is a console error, which fails every
      // declared check on the route.
      if (!proposal && IS_STAGING && req.query.demo === '1') {
        const sessionMocks = require('./sessions');
        proposal = stagingMockMerged(req.user).find((m) => m.id === id)
          || ownDemoProposals(stagingMockProposals(), req.user).find((m) => m.id === id)
          || stagingDemoNeedsProposal(id, req.params.slug)
          || sessionMocks.stagingMockSharedSessions().find((m) => m.id === id)
          || sessionMocks.stagingMockOwnSessions(req.user?.id, config.selfAppSlug).find((m) => m.id === id)
          || null;
      }

      if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
      if (IS_STAGING && req.query.demo === '1' && proposal.checks_estimate == null) {
        proposal = { ...proposal, checks_estimate: require('../services/checks-estimate').DEMO_ESTIMATE };
      }
      // #5064: a merge of the platform's own app opened on its own (a link
      // from the bell or Home, beyond the board's first page) gets the
      // board's deployment_state too, so its page says "going live" until
      // the running build carries it rather than reading a live_at the old
      // merge path stamped at once. A child app's keeps its words.
      if (proposal.status === 'merged' && proposal.deployment_state == null && gatedApp.self_hosted
          && !(IS_STAGING && req.query.demo === '1')) {
        const { rows: [selfApp] } = await pool.query(
          'SELECT id, slug, self_hosted, main_sha, release_stall FROM apps WHERE id = $1', [gatedApp.id]);
        if (selfApp) {
          const row = { ...proposal };
          await annotateDeploymentState(config, pool, selfApp, [row]);
          proposal = row;
        }
      }
      // Merged into the platform's own app and not live yet: when the next
      // release carries it (services/release-watch.js), which the page says
      // as "Merged; goes live in the next release (about 8 minutes)". A
      // child app's merge goes live with its own deploy and keeps its words.
      if (IS_STAGING && req.query.demo === '1' && Number(proposal.id) === DEMO_RELEASE_BLOCKED_ID) {
        proposal = { ...proposal, deployment_state: 'stalled', live_at: null, release_block: { ...DEMO_RELEASE_BLOCK } };
      }
      // A change stuck behind a red release has no estimate: its page says
      // what blocked it instead (release_block).
      if (proposal.status === 'merged' && proposal.live_at === null && !proposal.release
          && proposal.deployment_state !== 'stalled') {
        const releaseWatch = require('../services/release-watch');
        if (IS_STAGING && req.query.demo === '1' && Number(proposal.id) === DEMO_GOING_LIVE_ID) {
          proposal = { ...proposal, release: releaseWatch.demoRelease() };
        } else if (gatedApp.self_hosted) {
          const release = releaseWatch.releaseOf(await releaseWatch.outlook(pool), {
            mergedAt: proposal.merged_at || proposal.created_at, id: proposal.id,
          });
          if (release) proposal = { ...proposal, release };
        }
      }
      // `?results=failing`: the proposal page's own read, which lists passing
      // checks only when their fold is opened (services/list-test-results.js).
      res.json({ proposal: listTestResults.forItem(req, proposal) });
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
  //
  // Undo is a write, not a read: it clones the repo, pushes a branch, opens
  // a PR and inserts a promoted session owned by the caller. So it takes
  // the same gates as promote. drainGuard keeps a process about to exit
  // from starting that background work, and requireMembership keeps it to
  // the community's members: on a public community the collab guard above
  // lets every signed-in person through, and only membership stops a
  // passer-by from putting a revert up for a vote. A non-member's 403
  // `join_required` becomes the Join prompt in the client's fetch wrapper
  // (frontend/src/lib/join-required.ts), which sends the undo again on a yes.
  router.post('/api/sessions/:id/undo', drainGuard, requireMembership, sameOriginBrowserOnly, async (req, res) => {
    try {
      const { rows: sessionRows } = await pool.query(
      `SELECT cs.*, a.slug as app_slug, a.repo_url
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

      // A change that went live inside another one has no merge of its own
      // to revert: its merge commit is the carrying change's, and reverting
      // that would undo the carrying change too. The button is hidden on the
      // client; undoing the carrying change is the way.
      if (session.included_in_session_id) {
        return res.status(409).json({
          error: 'This change went live as part of another change. Undo that change instead.',
          includedInSessionId: Number(session.included_in_session_id),
        });
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
      // The revert (clone + git revert + push + PR) is a conductor's
      // platform operation (services/revert-operation.js), recorded before
      // the answer so a restart still opens it; it announces itself in
      // group chat and refreshes the vote panel (pushVoteUpdate) when done.
      await require('../services/platform-operations').append(pool, {
        op: 'revert.open', appId: session.app_id, userId: req.user.id, input: { sessionId: session.id },
      });
      res.json({ ok: true, opening: true });
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
  // The merge is the same one a vote asks for (the app's merge queue,
  // then the proposal machine's claim and GitHub's merge), forced: the
  // vote and checks gates are skipped, shots are not, and the force lasts
  // through a conflict resolution until it merges (M4). The chat message
  // distinguishes the override so users see who did it and why a PR
  // landed without the usual tally.
  router.post('/api/sessions/:id/admin-merge', drainGuard, sameOriginBrowserOnly, async (req, res) => {
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
      `SELECT cs.*, a.slug as app_slug, a.repo_url,
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
      // one exception is a proposal flagged for explicit approval (it
      // changes the admins, the approval rules, who can see the app, its
      // platform settings or its keys): letting an app admin force-merge
      // that would skip the other member's Yes it exists to ask for, so
      // it stays platform-admin-only.
      const explicitApproval = !!session.requires_explicit_approval;
      const appForGate = { id: session.app_id, created_by: session.app_created_by };
      if (!(await appAdmins.canForceMerge(pool, appForGate, req.user, { explicitApproval }))) {
        if (explicitApproval && await appAdmins.isAppAdmin(pool, session.app_id, req.user?.id)) {
          return res.status(403).json({
            error: `${require('../services/explicit-approval').reasonSentence(session.explicit_approval_reason)} Only a platform admin can merge it without that vote.`,
          });
        }
        return res.status(403).json({ error: 'Full admin access required' });
      }

      // Force-merging this platform-created proposal would apply its held
      // credential value. Keep ordinary admin merges available to the CLI.
      if (isCliCredentialManagementSession(req, session)) {
        return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
      }

      // Force bypasses the vote/check gates, not the shots audit. Refuse
      // before returning `queued:true`; otherwise the UI would report a merge
      // that the background task is guaranteed not to perform. An app admin
      // can use the dedicated reasoned override endpoint, then retry.
      const shotsGate = await readShotsGate(config, pool, session);
      if (shotsGate.applies && !shotsGate.allowed) {
        return res.status(409).json({
          error: 'shots_required',
          message: shotsGate.reason,
          shotsState: shotsGate.state,
        });
      }

      // Nothing to merge: its code did not come across from GitHub
      // (services/code-missing.js). Refused here, in its own words, rather
      // than answered `queued` for a merge the gate is sure to refuse.
      if (await codeMissing.forSession(pool, session)) {
        return res.status(409).json({ error: codeMissing.MERGE_REFUSAL, code: codeMissing.CODE });
      }

      log.info('votes', 'Admin force-merge requested', {
        sessionId: session.id, by: req.user.username,
      });
      const platform = require('../workflow/platform.ts');
      // One force at a time. A second one would overwrite the first and ask
      // the queue again without saying so, which is why it is refused here
      // (two tabs can both reach this route) and by the client before it.
      const before = await platform.proposalInstance(session.id).catch(() => null);
      if (before?.data?.force) {
        return res.status(409).json({
          error: 'already_queued',
          message: 'An admin merge is already queued for this change.',
          force: before.data.force,
        });
      }
      const out = await platform.forceMerge({
        sessionId: session.id, appId: session.app_id, from: session.status, userId: req.user.id, username: req.user.username,
      });
      if (out.status === 'rejected') {
        const reason = out.reason || 'not_in_review';
        // A bare reason told the admin nothing on screen; each one is said in
        // words here.
        const message = {
          in_progress: 'This change is already merging.',
          not_in_review: 'This change is no longer up for a vote.',
        }[reason] || null;
        return res.status(reason === 'not_authorized' ? 403 : 409).json({ error: reason, ...(message ? { message } : {}) });
      }
      const after = await platform.proposalInstance(session.id).catch(() => null);
      res.json({ ok: true, queued: true, force: after?.data?.force || null });
    } catch (err) {
      log.error('votes', 'Admin force-merge route failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// The merge gate (the proposal machine's `merge.gate` work): everything a
// proposal must satisfy before GitHub is asked to merge it, measured now,
// with what it needs from outside the database (the live revision, the
// protected-settings check, the mirror's merge, the platform variables).
// It decides nothing: a proposal it finds ready is claimed by the proposal
// machine, which reads every deciding input again under the proposal's lock
// (src/workflow/proposal/facts.ts). What it finds is written for the card
// (merge_requirements) and, where somebody has to act, said in the thread.
//
// `options.force` (an admin's force merge): the vote, the lock's admin Yes
// and every gate after them are skipped; shots are not.
async function evaluateMergeGate(config, pool, session, options = {}) {
  const { force = false, forceBy = null } = options;
  // A red main lets through only a head level with main, merging clean and
  // green on its own tree: the claim reads the pause again, and this says
  // whether this head is one of those.
  let mainPassThrough = false;

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
  // Its branch is not on the git host: the code did not come across when
  // Homeroom moved off GitHub (services/code-missing.js). There is nothing to
  // merge, forced or not, so the gate refuses with that reason before it
  // diffs a head that is not there (the explicit-approval re-verify below)
  // or asks for a merge. Its votes stand; the proposal machine tells the
  // queue `code_missing`, and nothing is logged, as it is the same every pass
  // until the branch is pushed back.
  if (revision.codeMissing) {
    return {
      merged: false,
      codeMissing: true,
      blockReason: codeMissing.CODE,
      error: codeMissing.MERGE_REFUSAL,
    };
  }
  // Its pull request is based on another change's branch, or on a branch no
  // open change has (src/workflow/rules/pr-base.ts): nothing about it is
  // measured, forced or not, until it targets main. The queue keeps it out
  // of its line; this is the gate saying so to an ask that came anyway.
  if (session.source === 'imported' && !prBase.onMain(session.imported_pr_base_ref)) {
    return {
      merged: false,
      blockReason: session.waits_for_session_id ? 'waits_for_parent' : 'base_not_main',
      error: `Its pull request is based on ${String(session.imported_pr_base_ref).slice(0, 200)}, not main.`,
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

  // The imported twin of the step above. An imported proposal's pin used to
  // advance only when the sync poller's next getPR noticed the head had
  // moved — so when the merge queue had just pushed a sync commit onto the
  // branch, the merge below was offered the PRE-sync commit, GitHub refused
  // it (409), the group was told "the PR was updated on GitHub", and when
  // the poller did catch up it read the platform's own commit as an author
  // push and cleared the votes (#2100, #2095). Re-pinning from the mirror
  // here, with the same classifier the native path uses, is what makes that
  // loop unreachable. Checks are deferred to the checks gate below, which
  // rebuilds exactly the pinned head when the verdict's commit does not
  // match. A head on the author's fork is left to the poller, as before;
  // the exact-sha merge remains the guard for it.
  if (session.source === 'imported') {
    const importedRevision = await require('../services/pr-import-sync').reconcileImportedHead({
      config, pool, session, checks: 'defer',
    });
    if (importedRevision.reconciled && importedRevision.changed && !importedRevision.votesKept) {
      return {
        merged: false,
        headMoved: true,
        reviewReset: true,
        reviewedHeadSha: importedRevision.headSha,
      };
    }
  }

  // Force merge bypasses voting/checks by design, but it does not manufacture
  // before & after shots. An administrator who intentionally accepts missing
  // shots must use the audited override endpoint first.
  if (force && config?.shots?.enforce) {
    const shotsGate = await readShotsGate(config, pool, session);
    if (shotsGate.applies && !shotsGate.allowed) {
      return {
        merged: false,
        blockReason: 'shots',
        shotsBlocked: true,
        shotsState: shotsGate.state,
        error: shotsGate.reason,
      };
    }
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

  // #788: does this proposal change a protected dapp.json block (admins,
  // governance, visibility, platform_env, secrets)? This is
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
  let explicitApprovalReason = session.explicit_approval_reason || null;
  let explicitApprovalSource = 'stored';
  let explicitApprovalDetail = null;
  try {
    const detected = await appAdmins.detectExplicitApprovalChange(session, {
      headRef: appAdmins.headRefForSession(session),
    });
    // An INDETERMINATE result (no head ref / GitHub off / unparseable
    // repo / no merge base) keeps the stored flag — only a real diff
    // may overwrite it.
    if (detected.determinate) {
      explicitApproval = detected.changed;
      explicitApprovalReason = detected.reason;
      explicitApprovalSource = 'live';
      explicitApprovalDetail = {
        reasons: detected.reasons,
        from: detected.from, to: detected.to, mergeBaseSha: detected.mergeBaseSha,
      };
      // A row that carries its reason and names a different one (a branch
      // that went on to change another block) is re-stamped too; a thin
      // row without the column is not, or every check would rewrite it.
      const reasonMoved = detected.changed
        && Object.prototype.hasOwnProperty.call(session, 'explicit_approval_reason')
        && detected.reason !== (session.explicit_approval_reason || null);
      if (detected.changed !== !!session.requires_explicit_approval || reasonMoved) {
        // The flip itself is worth a trace: a below-threshold clear
        // returns before any merge_debug_run opens, so without this
        // line a disappearing chip has no server-side explanation.
        log.info('votes', 'Explicit-approval flag overwritten by live check', {
          sessionId: session.id, stored: !!session.requires_explicit_approval,
          live: detected.changed, reasons: detected.reasons,
          from: detected.from, to: detected.to,
          mergeBaseSha: detected.mergeBaseSha,
        });
        await appAdmins.stampExplicitApproval(pool, session.id, detected.changed, detected.reason);
      }
    }
  } catch (err) {
    // A head whose code is not on the git host (services/code-missing.js)
    // keeps the stored flag without a warning: it fails the same way every
    // pass until the branch is pushed back.
    if (!codeMissing.isError(err)) {
      log.warn('votes', 'Explicit-approval re-verify failed; using stored flag', {
        sessionId: session.id, stored: explicitApproval, err: err.message,
      });
    }
  }
  if (!explicitApproval) explicitApprovalReason = null;

  // What the gate below is about: the head and the approval epoch the row
  // has now. The merge's claim names both, and the proposal machine reads
  // the gate again under its lock (R1): a vote, an unpromote or a head move
  // committed after this read is never merged past.
  const { rows: [gatedAt] = [] } = await pool.query(
    `SELECT approval_epoch, CASE WHEN source = 'imported' THEN imported_pr_head_sha ELSE reviewed_head_sha END AS head
       FROM chat_sessions WHERE id = $1`, [session.id]);
  const gate = await governance.governedGate(pool, session.app_id, {
    kind: 'pr', id: session.id, openedAt, explicitApproval,
    // #4666: on a project with rules, a change to who decides goes by the
    // creator's yes or the group's real votes; a change to its keys by its
    // own rule. The reason the live check found says which.
    explicitReason: explicitApprovalReason,
    // The member floor's author: someone else has to say Yes to a flagged
    // proposal (services/governance.js applyNoTimerMerge).
    authorId: session.user_id ?? null,
    // #2038: scoped by approval epoch inside the gate. No revision is passed,
    // because a proposal's commit changes for reasons that say nothing about
    // whether its approvals still describe it.
    // Read uncached: the proposal machine's merge.gate work decides from it
    // in whichever process runs it (the claim reads it again under its lock).
    fresh: true,
  });
  // The member floor, when it is what stands between this proposal and the
  // merge: the votes are there, but none of them is from someone other than
  // the author. Reported as its own step rather than as missing votes.
  const floorWaiting = !!(gate.memberFloor && gate.memberFloor.applies && !gate.memberFloor.met);
  const explicitApprovalCopy = require('../services/explicit-approval');
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
  // ones that either merge or get blocked. A caller that already has a run
  // passes its id (debugRunId) so these steps nest under it.
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

  // #2061 — the same run, recorded for the CARD rather than for an admin
  // reading merge_debug_steps. `gateTrace` marks ride beside the dstep() calls below
  // so the two cannot describe different runs; services/merge-requirements.js
  // holds the static gate order and turns this recording into the list a voter
  // sees. Purely descriptive: `gateSave` never gates anything, and it is
  // deliberately swallowed — a proposal must not fail to merge because its
  // explanation could not be written down.
  const requirements = require('../services/merge-requirements');
  const gateTrace = requirements.trace();
  const gateSave = () => requirements.store(pool, session.id, gateTrace).catch(() => {});
  // A run is a statement about one (reviewed head, approval epoch). Stamping
  // both lets readRequirements tell a recording about THIS proposal from one
  // about the proposal it used to be — after a head move released the claim,
  // or an epoch bump cleared the approvals it counted — and fall back to the
  // live columns instead of a "merging now" that stopped being true.
  gateTrace.context({
    headSha: reviewedHeadForSession(session) || null,
    approvalEpoch: Number.isFinite(parseInt(session.approval_epoch, 10))
      ? parseInt(session.approval_epoch, 10) : 0,
    shotsEnforced: !!config?.shots?.enforce
      && !!session.shots_detail,
  });

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
        gateTrace.context({ explicitApproval, locked: null, selfHosted: null })
          .stop('approvals', 'waiting', {
            yesCount, required, windowEndsAt: gate.windowEndsAt,
            note: `${yesCount} of ${required}, or it merges on its own once the window closes`,
          });
        gateSave();
        return {
          merged: false, yesCount, needed: required,
          windowEndsAt: gate.windowEndsAt, waitingForWindow: true,
        };
      }
      // The votes are in, but only from the author: the member floor holds
      // it. Its own step, so the card names what is missing.
      if (explicitApproval && gate.thresholdMet && floorWaiting) {
        log.info('votes', 'Threshold met but no Yes from another member yet; deferring merge', {
          sessionId: session.id, yesCount, required, reason: explicitApprovalReason,
        });
        gateTrace.context({ explicitApproval, memberFloor: true, locked: null, selfHosted: null })
          .pass('approvals', { yesCount, required, note: `${yesCount} of ${required}` })
          .stop('explicit', 'waiting', {
            reason: explicitApprovalReason,
            otherYes: gate.memberFloor.otherYes,
            note: explicitApprovalCopy.reasonSentence(explicitApprovalReason),
          });
        gateSave();
        return {
          merged: false, yesCount, needed: required, windowEndsAt: gate.windowEndsAt,
          awaitingOtherMember: true,
        };
      }
      // No clock at all: not enough support (or contested / No leading).
      gateTrace.context({
        explicitApproval,
        memberFloor: explicitApproval ? !!gate.memberFloor?.applies : null,
        locked: null,
        selfHosted: null,
      })
        .stop('approvals', 'waiting', {
          yesCount, required,
          note: `${yesCount} of ${required}`,
        });
      gateSave();
      return { merged: false, yesCount, needed: required, windowEndsAt: gate.windowEndsAt };
    }

    await startDebugIfNeeded();
    if (explicitApproval) {
      const floor = gate.memberFloor;
      dstep({
        phase: 'gate:explicit_approval',
        message: `Proposal changes a protected dapp.json block (${explicitApprovalReason || 'unknown'}; ${explicitApprovalSource} check). Time-based merge paths are off: no visibility window, no lazy consensus. The app's normal threshold still applies, ${floor && floor.applies
          ? `and it has ${floor.otherYes} Yes vote${floor.otherYes === 1 ? '' : 's'} from someone other than the author.`
          : 'and the community has one member, so the author\'s Yes is enough.'}`,
        detail: {
          explicitApproval: true, reason: explicitApprovalReason,
          source: explicitApprovalSource, mode: gate.mode,
          memberFloor: floor || null,
          ...(explicitApprovalDetail || {}),
        },
      });
    }
    dstep({
      phase: 'gate:majority',
      // 13 Oct 2026, D1: a project's first version goes live without a vote
      // (governance-gate.ts applyFirstVersion); every gate below still holds.
      message: gate.firstVersion
        ? `First version of the project: no vote needed (${yesCount} yes, ${noCount} no so far). The gates after this one still apply.`
        : gate.mode === 'at_least'
          ? `Approval target reached: ${yesCount} qualifying approval${yesCount === 1 ? '' : 's'} (needed at least ${required}${gate.policy === 'invited' ? ' from invited approvers' : ''}).`
          : gate.thresholdMet
            ? `Vote threshold reached: ${yesCount} yes votes (needed ${required}) with the visibility window elapsed.`
            : `Lazy-consensus window elapsed: ${yesCount} yes vote${yesCount === 1 ? '' : 's'} (threshold ${required}) with no opposition, so silence is consent.`,
      detail: {
        yesCount, required, majority, noCount, activeCount, lazyArmed: gate.lazyArmed, mode: gate.mode, policy: gate.policy,
        ...(gate.firstVersion ? { firstVersion: true } : {}),
      },
    });
    gateTrace.context({
      explicitApproval,
      memberFloor: explicitApproval ? !!gate.memberFloor?.applies : null,
    })
      .pass('approvals', {
        yesCount, required,
        note: gate.firstVersion ? 'first version, no vote needed' : `${yesCount} of ${required}`,
        ...(gate.firstVersion ? { firstVersion: true } : {}),
      });
    if (explicitApproval) {
      gateTrace.pass('explicit', {
        source: explicitApprovalSource,
        reason: explicitApprovalReason,
        otherYes: gate.memberFloor ? gate.memberFloor.otherYes : null,
      });
    }

    // Locked apps additionally require at least one admin yes vote (see
    // services/admin-approval.js + the apps.locked column). The active-user
    // majority gate above still has to pass — the admin yes is an extra
    // condition, not a replacement. Toggled via the home-card lock icon
    // (admin-only); see POST /api/apps/:slug/lock in routes/apps.js.
    if (await isAppLocked(pool, session.app_id)) {
      // Epoch-scoped, like every other tally: an admin's yes survives the
      // platform's own sync exactly as the group's approvals do.
      const adminYes = await hasAdminYesVote(pool, session.id);
      if (!adminYes) {
        log.info('votes', 'Threshold + window met but app is locked; awaiting admin yes', {
          sessionId: session.id, yesCount, required,
        });
        dstep({ phase: 'gate:lock', level: 'warn', message: 'App is locked and has no admin yes vote yet, so the merge is blocked.', detail: { locked: true, adminYes: false } });
        gateTrace.context({ locked: true }).stop('admin_yes', 'waiting', {
          note: 'This app is locked, so an admin has to vote yes as well',
        });
        gateSave();
        dend('blocked', 'Blocked: locked app awaiting an admin yes vote.');
        return { merged: false, yesCount, needed: required, awaitingAdmin: true };
      }
      dstep({ phase: 'gate:lock', message: 'App is locked, and an admin yes vote is present.', detail: { locked: true, adminYes: true } });
      gateTrace.context({ locked: true }).pass('admin_yes');
    } else {
      dstep({ phase: 'gate:lock', message: 'App is not locked, so there is no admin-yes requirement.' });
      // Not applicable rather than satisfied: an admin-approval row on an
      // unlocked app is noise, and the count should read 4 of 4, not 4 of 5.
      gateTrace.context({ locked: false });
    }

    // #2038 — the integration gate.
    //
    // This replaced a behind-main gate that blocked the merge, posted
    // "syncing automatically", and queued a drain that only ever touched
    // proposals ALREADY eligible to merge — so for anything below threshold
    // the message was a promise nobody was keeping, and the proposal sat
    // drifting with no actor at all. That was #2038's F2.
    //
    // Under direct-merge lanes (the merge-queue machine, src/workflow/merge-queue/) the gate asks one
    // question: does this head merge cleanly with main RIGHT NOW? Clean
    // merges as it stands, however far behind. A conflict is refused and
    // handed to the conflict lane, whose resolution pushes a new head that
    // comes back through here on its own.
    //
    // Measured, not remembered: the old gate read session.behind_main off a
    // row that could be hours old, and a cached 0 let a genuinely-behind
    // proposal through to a 405 that nobody expected.
    const integrationSvc = require('../services/integration');
    const measured = await integrationSvc.measureDeduped(
      { pool, session }, { force: true }
    ).catch((err) => {
      // A measurement that cannot run must not block a merge: the exact-sha
      // merge is still the real guard, and GitHub refuses anything genuinely
      // unmergeable. Failing closed here would wedge every merge on the
      // platform behind a git hiccup.
      log.warn('votes', 'Integration measurement failed; not blocking the merge', {
        sessionId: session.id, err: err.message,
      });
      return { behindBy: null, mergesClean: null, conflictPaths: [] };
    });

    if (measured.mergesClean === false) {
      // A real conflict, from a real merge — not GitHub's lazily-computed
      // guess, and the paths are the ones git could not resolve rather than
      // the superset the old prediction had to settle for.
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      const n = (measured.conflictPaths || []).length;
      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      // Who resolves it, in the words the card uses: the conflict lane's
      // verdict on this head, read off the row (the merge-queue machine
      // writes it; services/merge-requirements.js reads it). The approvals
      // gate has passed, so an 'awaiting_approval' left from before the
      // vote is stale here and is not repeated.
      const step = requirements.integrationStep({
        ...session,
        integration_merges_clean: false,
        integration_behind_by: measured.behindBy,
        integration_conflict_paths: measured.conflictPaths || [],
        integration_block_reasons: (Array.isArray(session.integration_block_reasons)
          ? session.integration_block_reasons : []).filter((r) => r !== 'awaiting_approval'),
      });
      const msg = `${label} conflicts with main in ${n} file${n === 1 ? '' : 's'}`
        + `${n ? ` (${measured.conflictPaths.slice(0, 5).join(', ')}${n > 5 ? ', …' : ''})` : ''}. `
        + (step.actor === 'author' && /checks are failing/.test(step.note || '')
          ? `Its checks are failing too, so the platform waits for ${owner} to fix them before it resolves the conflict.`
          : step.actor === 'author' && /checks could not run/.test(step.note || '')
          ? 'Its checks could not run either; once they are re-run and pass, the platform resolves the conflict.'
          : step.actor === 'author'
          ? `The platform cannot resolve this one; ${owner} needs to resolve it from the session's dev-chat.`
          : `The platform will try to resolve it automatically; if it can't, ${owner} needs to resolve it from the session's dev-chat.`);
      await sendSystemMessage(pool, session.app_id, msg, 'system',
        null, { type: 'session', ref: session.id }).catch(() => {});
      dstep({
        phase: 'gate:integration', level: 'warn',
        message: `Conflicts with main in ${n} file(s); ${step.actor === 'author' ? 'the author has to resolve it' : 'handed to the conflict lane'}.`,
        detail: { conflictPaths: measured.conflictPaths, behindBy: measured.behindBy, actor: step.actor },
      });
      gateTrace.stop('integration', step.state, {
        conflictPaths: measured.conflictPaths, behindBy: measured.behindBy,
        actor: step.actor, note: step.note,
      });
      gateSave();
      dend('conflict_resolving', 'Conflicts with main: queued for integration.');
      // 'conflict' is derivable by the browser from the columns it already
      // reads, so the server does not restate it. The app's merge queue
      // hears the refusal and takes the head to its conflict lane.
      return {
        merged: false, yesCount, needed: required,
        blockReason: 'conflict', conflictPaths: measured.conflictPaths,
      };
    }

    // Being behind main is not a reason to refuse. A head that merges
    // cleanly merges as it stands — GitHub produces the same merge commit
    // the platform's own sync would have pushed, without the worker turn,
    // the rebuild and the re-run that used to precede it (and that put
    // every sibling one further behind per merge). The measurement is
    // still recorded; the card shows it as information, not as a step.
    // The tree that results is judged afterwards, as a whole, by
    // services/main-watch.js — the main_healthy gate below.
    const behind = measured.behindBy || 0;
    dstep({
      phase: 'gate:integration',
      message: behind
        ? `Merges cleanly with main (${behind} commit${behind === 1 ? '' : 's'} behind; merging as it stands).`
        : 'Level with main, merges cleanly.',
      detail: { behindBy: measured.behindBy, mergesClean: measured.mergesClean },
    });
    gateTrace.pass('integration', {
      behindBy: measured.behindBy,
      note: behind
        ? `${behind} commit${behind === 1 ? '' : 's'} behind main; merges as it stands`
        : 'level with main',
    });

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
              check_error_detail, checks_commit_sha, check_phase,
              check_error_platform, consecutive_check_failures, first_check_failure_at,
              unit_suite_fresh_sha
         FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    // A person asked for this head's checks again and its unit suite has not
    // run since: a verdict whose unit-suite row was copied from an earlier
    // pass (services/unit-suite-reuse.js) is not the one they asked for, so
    // the head reads as not yet checked until the suite really runs.
    const freshSuiteOwed = require('../services/unit-suite-row').freshSuiteOwed(checkRows[0]);
    // A verdict deferred while the head conflicted (check_phase 'deferred',
    // services/check-admission.js). The integration gate just measured this
    // head clean, so the run that judges it can start now. The measurement
    // that flipped it told the preview machine in its own statement
    // (integration.measure); this covers a head deferred after that flip
    // (its run reported 'deferred' once the head already merged cleanly), so
    // a merge attempt never waits on it. The machine joins a second kick for
    // the same head, so a double kick costs nothing.
    const checksDeferred = checkRows[0]?.check_state === 'pending'
      && checkRows[0]?.check_phase === 'deferred';
    // A run waiting for a checks slot (services/checks-queue.js): built, in
    // line, and started by the queue, so no kick is owed however long it
    // has waited.
    const checksQueued = checkRows[0]?.check_state === 'pending'
      && checkRows[0]?.check_phase === 'queued';
    if (checksDeferred && measured.mergesClean === true) {
      const stagingRecovery = require('../services/staging-recovery');
      stagingRecovery.recheckSessionChecks({
        config, pool, session, reason: 'conflict-resolved',
      }).catch((err) => {
        log.warn('votes', 'Deferred-checks kick failed', {
          sessionId: session.id, err: err.message,
        });
      });
    }
    const reviewedHead = reviewedHeadForSession(session);
    const returnedChecksSha = checkRows[0]?.checks_commit_sha;
    const checksRevisionMismatch = !!reviewedHead
      // `undefined` exists only in narrow unit-test row adapters that predate
      // the selected column; PostgreSQL returns null for a real unset value.
      && returnedChecksSha !== undefined
      && !sameSha(returnedChecksSha, reviewedHead);
    // A green verdict for an older commit is not a green verdict for the
    // reviewed code. Treat it as pending and rebuild exactly the pinned SHA.
    const checkState = checksRevisionMismatch || freshSuiteOwed
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
      // A deferred row is not stale: nothing was started for it, so nothing
      // is overdue, and the kick above (or the hook) owns its next run.
      const stalePending = !checksDeferred && !checksQueued && (checkState === null
        || (checkState === 'pending' && (Date.now() - checkedAt) > CHECKS_STALE_MS));
      if (checksRevisionMismatch) {
        if (session.source === 'imported') {
          await kickImportedRevisionChecks({
            config, pool, session, headSha: reviewedHead,
          });
        } else {
          await kickNativeRevisionChecks({
            config, pool, session, headSha: reviewedHead,
          });
        }
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
        ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      // #237: for the 'error' state, surface the captured reason (usually a
      // staging preview that crashed on boot, e.g. a bad migration/seed) so
      // the block isn't an unexplained dead-end — the owner can act on it.
      const errorDetail = checkState === 'error' ? (checkRows[0]?.check_error_detail || null) : null;
      // A red run that overlapped a platform rollout used to be recorded as
      // an 'error' the stuck-checks reconcile runs again (#3828). Nothing
      // writes it now; rows stored before still run again and read so.
      const rolloutRetry = errorDetail === require('../services/staging-recovery').ROLLOUT_RETRY_DETAIL;
      // An 'error' because the repo unit suite could not run: its preview
      // started fine, so the sentence must not blame it.
      const unitNotRun = checkState === 'error'
        && !!require('../services/unit-suite-row').notRunError({ ...checkRows[0], check_state: checkState });
      // #5054: an 'error' that is the platform's fault (a check Job refused,
      // a test Pod that never started) and that the error lane still runs
      // again on its own needs nobody, like a rollout retry.
      const platformRetry = checkState === 'error' && checkRows[0]?.check_error_platform === true
        && require('../services/staging-recovery').errorWithinAutoRetries(checkRows[0]);
      const reason = checkState === 'failing'
        ? `has ${failingCount || 'failing'} test${failingCount === 1 ? '' : 's'} failing`
        : checkState === 'error'
          ? (rolloutRetry
            ? 'ran its tests while Homeroom was updating, so they will run again on their own'
            : platformRetry
              ? `couldn't start its checks, so they will run again on their own (${errorDetail})`
            : unitNotRun
              ? `couldn't run its unit suite, so its checks have no verdict yet (${errorDetail})`
              : errorDetail
                ? `couldn't run its tests, because its staging preview failed to start (${errorDetail})`
                : "couldn't run its tests")
          : checksQueued ? 'is waiting for a checks slot' : 'is still running its tests';
      // A first version had no vote to reach (governance-gate.ts
      // applyFirstVersion): it says what it does wait for.
      const blockMsg = gate.firstVersion
        ? `${label} is the project's first version, which goes live without a vote, but ${reason}. It goes live once its checks pass.`
        : `${label} reached the vote threshold but ${reason}. Merge is blocked until checks pass.`;
      // Said once. This gate runs on every vote and every check re-run, and
      // it used to post the same sentence each time — eight copies on one
      // topic thread. If the latest system line in this proposal's thread
      // already says exactly this, there is nothing new to say.
      const alreadySaid = await pool.query(
        `SELECT content FROM chat_messages
          WHERE app_id = $1 AND msg_type = 'system'
            AND thread_type = 'session' AND thread_ref = $2
          ORDER BY id DESC LIMIT 1`,
        [session.app_id, session.id]
      ).then((r) => !!(r.rows[0] && r.rows[0].content === blockMsg)).catch(() => false);
      if (!alreadySaid) {
        await sendSystemMessage(pool, session.app_id, blockMsg, 'system',
          null, { type: 'session', ref: session.id }).catch(() => {});
      }
      log.info('votes', 'Merge blocked: checks not passing', {
        sessionId: session.id, checkState, failingCount,
        checksRevisionMismatch,
      });
      dstep({ phase: 'gate:checks', level: 'warn', message: `Merge blocked: checks not passing (state = ${checkState || 'pending'}${failingCount ? `, ${failingCount} failing` : ''}).`, detail: { checkState: checkState || 'pending', failingCount, checksRevisionMismatch } });
      // 'pending' is in flight and needs nobody; 'failing' and 'error' need
      // the author. The card tones them differently for exactly that reason.
      // A rollout retry, or a platform fault the error lane still runs again,
      // is an 'error' that needs nobody either.
      gateTrace.stop('checks',
        ((checkState === 'failing' || checkState === 'error') && !rolloutRetry && !platformRetry) ? 'blocked' : 'active',
        {
          checkState: checkState || 'pending', failingCount,
          note: checkState === 'failing'
            ? `${failingCount || 'some'} failing. They re-run on the next push`
            : rolloutRetry
              ? 'they ran while Homeroom was updating and will run again'
              : platformRetry
                ? 'the checks could not start, so they will run again'
              : unitNotRun
                ? 'the unit suite could not run, so there is no verdict yet'
                : checkState === 'error'
                  ? 'the staging preview could not start, so the tests could not run'
                  : checksDeferred
                    ? 'waited for the head to merge cleanly; running now'
                    : checksQueued
                      ? 'waiting for a checks slot; they start on their own'
                      : 'still running',
        });
      gateSave();
      dend('blocked', 'Blocked: votes reached, but checks must pass first.');
      return {
        merged: false, yesCount, needed: required, blockReason: 'checks',
        checksBlocked: true, checkState: checkState || 'pending', failingCount,
        checksRevisionMismatch,
      };
    }
    dstep({ phase: 'gate:checks', message: `Checks gate: state = ${checkState}.`, detail: { checkState } });
    gateTrace.pass('checks', { checkState });

    // #2380: when enforcement is enabled, a required shots run is an
    // exact-head merge gate. This is not pixel-regression approval: the hard
    // replay and relevance reviewer have already done their bounded jobs.
    // `overridden` is accepted only because the override endpoint records an
    // app-admin identity and a visible reason.
    const shotsGate = await readShotsGate(config, pool, session);
    if (shotsGate.applies && !shotsGate.allowed) {
      dstep({
        phase: 'gate:shots', level: 'warn',
        message: `Merge blocked: ${shotsGate.reason}`,
        detail: { state: shotsGate.state, currentHead: shotsGate.currentHead, recordedHead: shotsGate.recordedHead },
      });
      gateTrace.stop('shots', shotsGate.state === 'failed' ? 'blocked' : 'active', {
        state: shotsGate.state,
        note: shotsGate.reason,
      });
      gateSave();
      dend('blocked', 'Blocked: exact-revision before & after shots is not ready.');
      return {
        merged: false, yesCount, needed: required,
        blockReason: 'shots', shotsBlocked: true,
        shotsState: shotsGate.state,
      };
    }
    if (shotsGate.applies) {
      dstep({
        phase: 'gate:shots',
        message: `Before & after shots gate: state = ${shotsGate.state}.`,
        detail: { state: shotsGate.state, headSha: shotsGate.currentHead },
      });
      gateTrace.pass('shots', { state: shotsGate.state });
    }

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
          ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
          : `PR #${session.pr_number || session.id}`;
        const blockMsg = platformEnvCheck.describeBlock(envVerdict.detail, label);
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
        gateTrace.context({ selfHosted: true }).stop('platform_env', 'waiting', {
          missing: envVerdict.detail.missing.map((m) => m.key),
          note: `${envVerdict.detail.missing.length} variable${envVerdict.detail.missing.length === 1 ? '' : 's'} declared with no value set`,
        });
        gateSave();
        dend('blocked', 'Blocked: a new platform variable has no value set.');
        return {
          merged: false, yesCount, needed: required, blockReason: 'platform_env',
          platformEnvBlocked: true,
          platformEnvMissing: envVerdict.detail.missing.map((m) => m.key),
        };
      }
      dstep({
        phase: 'gate:platform-env',
        message: `Platform-variables gate: ${envVerdict.state}.`,
        detail: { state: envVerdict.state, reason: envVerdict.detail.reason },
      });
      gateTrace.context({ selfHosted: true }).pass('platform_env', { state: envVerdict.state });
    } else {
      // Not a self-hosted app, so the gate does not exist for it — omitted
      // from the list rather than shown as satisfied.
      gateTrace.context({ selfHosted: false });
    }

    // Main-health gate (services/main-watch.js). Every merge lands a tree
    // nobody ran the checks against as a whole, so the repo's unit suite
    // runs once more on each merge commit, and a red result pauses the
    // app's merges — whatever this proposal's own checks said — until a
    // fix lands or an admin resumes them. This is the app's state rather
    // than the proposal's, which is why it is the last thing asked before
    // GitHub: nothing about the proposal changes it, and nothing the author
    // does clears it.
    //
    // With one exception, and it is what the pause is FOR. The pause holds
    // back merges whose tree nobody has tested — a head checked against an
    // older main lands a tree the red could be hiding in. A head that is
    // level with main, merges clean, and whose own checks (the same unit
    // suite) passed on this exact tree lands exactly the tree that was
    // tested: it is not hiding anything, it is the fix candidate, and its
    // own post-merge run re-tests main. It goes.
    const mainWatch = require('../services/main-watch');
    const mainHealth = await mainWatch.mergePause(pool, session.app_id);
    if (mainHealth.paused) {
      // The red commit the pause is ABOUT — not the one a newer merge may be
      // re-testing right now, which is what main_check_sha says meanwhile.
      const redSha = mainHealth.pausedSha || mainHealth.sha;
      const since = redSha ? String(redSha).slice(0, 7) : 'the last merge';
      const culprit = mainHealth.failingTest ? ` (${mainHealth.failingTest})` : '';
      const what = mainHealth.confirming
        ? `main's unit suite failed once since ${since}${culprit} and is being re-run to confirm`
        : `main's unit suite is failing since ${since}${culprit}`;
      const levelAndGreen = measured.behindBy === 0 && measured.mergesClean === true
        && checkState === 'passing' && require('../services/unit-suite').passedIn(checkRows[0]?.test_results);
      if (!levelAndGreen) {
        dstep({
          phase: 'gate:main_healthy', level: 'warn',
          message: `Merge blocked: ${what}; merges for this app are paused.`,
          detail: {
            sha: mainHealth.sha, at: mainHealth.at, confirming: mainHealth.confirming,
            failingTest: mainHealth.failingTest,
            behindBy: measured.behindBy, mergesClean: measured.mergesClean, checkState,
          },
        });
        // A first red being re-run is in flight, not an admin's turn: no
        // control is offered until it is confirmed (merge-requirements.js
        // mainStep says the same off the live columns).
        gateTrace.stop('main_healthy', mainHealth.confirming ? 'active' : 'blocked', {
          sha: mainHealth.sha,
          paused: true,
          confirming: mainHealth.confirming,
          actor: mainHealth.confirming ? 'auto' : 'admin',
          note: `${what}; merges are paused until a fix lands or an admin resumes them`,
        });
        gateSave();
        dend('blocked', 'Blocked: main is red, merges paused.');
        return {
          merged: false, yesCount, needed: required, blockReason: 'main_failing',
          mainCheck: mainHealth,
        };
      }
      mainPassThrough = true;
      dstep({
        phase: 'gate:main_healthy',
        message: `Main's unit suite is red (since ${since}), but this head is level with main and its own checks passed on this exact tree; merging it re-tests main.`,
        detail: { sha: mainHealth.sha, confirming: mainHealth.confirming, passThrough: 'level_and_green' },
      });
      gateTrace.pass('main_healthy', {
        state: mainHealth.state,
        sha: mainHealth.sha,
        passThrough: 'level_and_green',
        note: `${what}; this head is level with main and its own checks passed on this exact tree, so it merges and re-tests main`,
      });
    } else {
      dstep({
        phase: 'gate:main_healthy',
        message: mainHealth.state
          ? `Main's unit suite: ${mainHealth.state}${(mainHealth.state === 'failing' || mainHealth.state === 'confirming') ? ' (an admin resumed merges)' : ''}.`
          : 'Main has not been watched yet for this app.',
        detail: { state: mainHealth.state, sha: mainHealth.sha },
      });
      gateTrace.pass('main_healthy', {
        state: mainHealth.state,
        note: mainHealth.state === 'passing' ? 'main is green'
          : (mainHealth.state === 'failing' || mainHealth.state === 'confirming') ? 'main is red, but an admin resumed merges'
            : mainHealth.state === 'running' ? 'main is being checked after the last merge'
              : 'no verdict about main yet',
      });
    }
  }
  // Ready: the claim is the proposal machine's, under its lock.
  await startDebugIfNeeded();
  if (force) {
    dstep({ phase: 'gate:majority', message: `Force-merge by ${forceBy?.username || 'an admin'}, bypassing the vote/checks gates.`, detail: { yesCount, majority, forced: true } });
  }
  gateTrace.stop('github', 'active', { note: 'merging now' });
  gateSave();
  dend('merging', `Gate passed${force ? ` (force by ${forceBy?.username || 'admin'})` : ''}; the proposal machine claims and merges it.`);
  return {
    ready: true,
    head: gatedAt && /^[0-9a-f]{40}$/i.test(String(gatedAt.head || '')) ? String(gatedAt.head).toLowerCase() : null,
    epoch: Number.isInteger(Number(gatedAt?.approval_epoch)) ? Number(gatedAt.approval_epoch) : 0,
    explicitApproval, explicitReason: explicitApprovalReason,
    mainPassThrough,
    tally: { yes: yesCount, required, active: activeCount },
  };
}

function sessionLabel(session) {
  return session.pr_title ? `PR #${session.pr_number}: ${session.pr_title}` : `PR #${session.pr_number}`;
}

// What a merge refusal was about, from GitHub's answer and the pull request
// as it stands now (null when GitHub could not be read).
function refusalKind(err, pr) {
  const msg = String((err && err.message) || '').toLowerCase();
  // GitHub is still finishing an earlier merge of this pull request (it holds
  // the merge lock until that finishes, or until the request it made times
  // out). Not a refusal of the head: the attempt asks again.
  if (/merge already in progress/.test(msg)) return 'github_busy';
  if (pr && pr.draft === true) return 'draft';
  if (/base branch was modified/.test(msg)) return 'base_moved';
  if (pr && (pr.mergeable === false || pr.mergeable_state === 'dirty')) return 'conflict';
  if (/merge conflict/.test(msg)) return 'conflict';
  if (pr && pr.mergeable_state === 'blocked') return 'blocked';
  if (/not mergeable/.test(msg) && (!pr || pr.mergeable == null)) return 'conflict';
  return 'blocked';
}

/**
 * Pure (#6546): what a `blocked` refusal says about GitHub's required status
 * checks (main's branch protection), from GitHub's own words: 'pending' while
 * they are still running or have not reported ("3 of 6 required status
 * checks are in progress", "… is expected"), 'failing' once any failed ("3 of
 * 7 required status checks have not succeeded: 1 expected and 2 failing"),
 * null for a refusal about anything else. A count that only says "have not
 * succeeded" is read as failing: nothing in it says they are still running.
 */
function githubChecksOf(message) {
  const msg = String(message || '').toLowerCase();
  if (!/required status checks?\b/.test(msg)) return null;
  if (/\bfail(?:ing|ed|ure)?\b|\berror(?:ed)?\b|\bcancell?ed\b|\btimed out\b/.test(msg)) return 'failing';
  if (/in progress|\bexpected\b|\bpending\b|\bqueued\b|\bwaiting\b/.test(msg)) return 'pending';
  if (/have not succeeded|has not succeeded/.test(msg)) return 'failing';
  return null;
}

// The GitHub half of a merge (the proposal machine's `merge.attempt` work):
// GitHub is asked to merge the pull request at exactly `head`, and the answer
// is one named outcome:
//   merged     { sha, mergedAt?, observed? }
//   head_moved { votesKept, reviewedHeadSha, message }  the branch moved since the vote
//   unverified { message }        a 409 whose revision GitHub would not confirm
//   reopened   {}                 closed on GitHub, reopened: it can be merged again
//   closed     { message }        closed on GitHub, and could not be reopened
//   refused    { kind, message }  conflict | draft | blocked | base_moved | base_not_main | github_busy
// An import is only ever merged into main (src/workflow/rules/pr-base.ts):
// its pull request's base is read before GitHub is asked, one based on any
// other branch is refused, and every `merged` names the branch it went into
// when that is not main. A native proposal's pull request is Homeroom's own,
// opened against main (services/github.js createPR), and is merged as ever.
// It never asks twice: once it has asked (its checkpoint), a retry reads the
// pull request first, so a lost answer is observed rather than misread as a
// refusal (merge trace bug 1). An error that is no answer from GitHub (the
// network, a 5xx, its rate limit) is thrown: the work is tried again,
// observing first. An answer that a merge is "already in progress" is GitHub
// still busy, not a refusal: the pull request is re-read and the merge asked
// again a couple of times inside the attempt (BUSY_RETRIES), then the queue
// is left to try again later.
const BUSY_RETRY_MS = 20 * 1000;
const BUSY_RETRIES = 2;

async function attemptMerge(config, pool, sessionId, {
  head, resumeFrom = null, checkpoint = async () => {},
  // The busy back-off's clock; tests pass one that returns at once.
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const { rows: [session] = [] } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.self_hosted AS app_self_hosted
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`, [sessionId]);
  if (!session) return { outcome: 'gone' };
  const isImported = session.source === 'imported';
  const useMockMerge = isImported && usesMockGithubForImports();
  const client = useMockMerge ? githubMock : github;
  if (!session.repo_url || !session.pr_number) {
    // No repository or no pull request (a local stack): nothing to ask.
    return { outcome: 'merged', sha: null, noGithub: true };
  }
  // A repository with a pull request is never merged without being asked:
  // one on the git host is merged by Homeroom (services/native-merge.js);
  // one on GitHub (the platform's own) needs GitHub through the App, which
  // may be paused, not configured or not installed, and then it is refused,
  // not reported merged.
  const onGitHost = require('../services/repo-ref').isHosted(session.repo_url);
  if (!onGitHost && !useMockMerge && (!client.isEnabled() || require('../services/github-pause').codeChangesPaused(session.repo_url))) {
    return {
      outcome: 'refused', kind: 'blocked',
      message: `${sessionLabel(session)} was not merged: code changes on GitHub are paused. It is tried again when GitHub is back.`,
    };
  }
  // GitHub is there and the proposal has a pull request: a repository this
  // cannot read is a refusal, never a merge nobody asked GitHub for.
  const { owner, repo } = repoRef.ownerRepo(session.repo_url) || {};
  if (!owner || !repo) {
    return { outcome: 'refused', kind: 'blocked', message: `${sessionLabel(session)} was not merged: its repository address (${String(session.repo_url).slice(0, 200)}) could not be read.` };
  }
  const pinned = head || reviewedHeadForSession(session) || null;
  const label = sessionLabel(session);
  const readPr = () => client.getPR(owner, repo, session.pr_number).catch(() => null);
  const refused = (err, pr) => {
    const kind = refusalKind(err, pr);
    const said = String((err && err.message) || '').slice(0, 300);
    const owner_ = session.user_id ? `<@${session.user_id}>` : 'the session owner';
    // #6546: GitHub's required checks (main's branch protection), told apart
    // from any other plain refusal. Both are tried again on the queue's clock
    // (proposal machine REFUSAL_RETRY_MS); a failing one is also brought up
    // to date with main once, which runs them again on today's main.
    const githubChecks = kind === 'blocked' ? githubChecksOf(said) : null;
    const message = kind === 'conflict'
      ? `${label} hit a conflict with main during a merge attempt. Homeroom resolves it automatically when it can; if it can't, ${owner_} can run "Sync with main" from the session's dev-chat.`
      : kind === 'draft'
        ? `${label} wasn't merged: it is a draft on GitHub. Its author has to mark it ready for review, and it merges then.`
        : kind === 'base_moved'
          ? `${label} wasn't merged on this attempt: main moved while GitHub was merging it. It is tried again.`
          : kind === 'github_busy'
            ? `${label} wasn't merged yet: GitHub said a merge of it was already in progress. It is tried again in a few minutes.`
            : githubChecks === 'pending'
              ? `${label} wasn't merged yet: GitHub's required checks on it are still running. Homeroom tries again every few minutes and merges it once they pass.`
              : githubChecks === 'failing'
                ? `${label} wasn't merged: GitHub's required checks on it failed (${said}). Homeroom brings it up to date with main once, which runs them again, and tries again every few minutes.`
                : `${label} wasn't merged: GitHub refused it (${said || 'no reason given'}). It is tried again in a few minutes.`;
    return { outcome: 'refused', kind, message, githubMessage: said || null, ...(githubChecks ? { githubChecks } : {}) };
  };
  const unanswered = (err) => !err || !Number.isInteger(err.status) || err.status >= 500 || err.status === 429;
  // The branch an import's merge went into, when that is not main (the
  // machine records only a merge into main).
  const baseOf = (ref) => (isImported && ref ? { base: ref } : {});
  // GitHub's hourly limit used up (a 403 or a 429 saying no requests are
  // left) or its secondary limit (Retry-After): it did not merge, and it is
  // not a refusal of this head. The proposal goes back to review with
  // nothing remembered against it, and the queue's next look asks again.
  const githubBudget = require('../services/github-budget');
  const throttled = (err) => githubBudget.isRateLimitError(err) || githubBudget.isSecondaryRateLimitError(err);
  const limited = (err) => ({ outcome: 'rate_limited', message: githubBudget.rateLimitNotice(err) || null });

  if (resumeFrom && resumeFrom.asked) {
    // It asked before, and never heard: GitHub says what happened.
    let pr;
    try {
      pr = await client.getPR(owner, repo, session.pr_number);
    } catch (err) {
      if (err && (err.status === 404 || err.status === 410)) return { outcome: 'closed', message: `${label} is gone from GitHub.` };
      throw err;
    }
    if (pr && pr.merged) {
      return { outcome: 'merged', sha: pr.merge_commit_sha || null, mergedAt: pr.merged_at || null, observed: true, ...baseOf(prBase.otherBase(pr)) };
    }
  }

  // Where GitHub would merge an import. On 28 Oct 2026 #5957, based on
  // #5956's branch, was merged there and recorded merged. Its row learns the
  // base it read, so the card and the queue say it waits from now on.
  let base = null;
  if (isImported) {
    try {
      base = prBase.otherBase(await client.getPR(owner, repo, session.pr_number));
    } catch (err) {
      if (throttled(err)) return limited(err);
      if (codeMissing.isError(err)) {
        return { outcome: 'refused', kind: 'blocked', codeMissing: true, message: `${label} wasn't merged. ${codeMissing.REASON}` };
      }
      if (err && (err.status === 404 || err.status === 410)) return { outcome: 'closed', message: `${label} is gone from GitHub.` };
      throw err;
    }
  }
  if (!prBase.onMain(base)) {
    await prBase.recordBase(pool, { sessionId: session.id, appId: session.app_id, base, waited: session.waits_for_session_id ?? null }).catch(() => {});
    return {
      outcome: 'refused', kind: 'base_not_main', base,
      message: `${label} wasn't merged: its pull request is based on ${String(base).slice(0, 200)}, not main. It merges once it targets main.`,
    };
  }
  await checkpoint({ asked: true });

  const merge = async () => {
    const data = await client.mergePR(owner, repo, session.pr_number, pinned);
    return { outcome: 'merged', sha: (data && data.sha) || null, ...baseOf(base) };
  };
  // GitHub is still finishing an earlier merge of this pull request ("Merge
  // already in progress"), not refusing this one. The pull request is read
  // again first, since the earlier try may have landed; otherwise the merge
  // is asked again after a short wait, at most BUSY_RETRIES times, and the
  // queue is left to try again later if GitHub is still busy after that.
  const busy = (err) => /merge already in progress/i.test(String((err && err.message) || ''));
  const observedMerge = (pr) => ({
    outcome: 'merged', sha: pr.merge_commit_sha || null, mergedAt: pr.merged_at || null,
    observed: true, ...baseOf(pr.base ? prBase.otherBase(pr) : base),
  });
  const reopenOrClosed = async () => {
    try {
      await client.reopenPR(owner, repo, session.pr_number);
      return { outcome: 'reopened' };
    } catch (reopenErr) {
      // Only GitHub's refusal is "closed for good": no answer is asked again.
      if (throttled(reopenErr)) return limited(reopenErr);
      if (unanswered(reopenErr)) throw reopenErr;
      return { outcome: 'closed', message: `PR #${session.pr_number} is closed on GitHub and couldn't be reopened: ${reopenErr.message}` };
    }
  };
  const handle = async (err) => {
    if (throttled(err)) return limited(err);
    // The branch is not on the git host (services/code-missing.js; the gate
    // refuses this first, so only a branch deleted since reaches here). Its
    // own reason, as a refusal of this head, never read as a conflict for the
    // queue to resolve.
    if (codeMissing.isError(err)) {
      return { outcome: 'refused', kind: 'blocked', codeMissing: true, message: `${label} wasn't merged. ${codeMissing.REASON}` };
    }
    if (busy(err)) {
      const said = String((err && err.message) || '').slice(0, 300);
      for (let i = 0; i < BUSY_RETRIES; i++) {
        await wait(BUSY_RETRY_MS);
        const pr = await readPr();
        if (pr && pr.merged) return observedMerge(pr);
        if (pr && pr.state === 'closed') return reopenOrClosed();
        try {
          return await merge();
        } catch (again) {
          // Another busy answer loops; anything else is handled as it would
          // be from the first ask.
          if (!busy(again)) return handle(again);
        }
      }
      return {
        outcome: 'refused', kind: 'github_busy', githubMessage: said || null,
        message: `${label} wasn't merged yet: GitHub said a merge of it was already in progress. It is tried again in a few minutes.`,
      };
    }
    if (err && err.headMoved) {
      // GitHub answers 409 for a moved head and for a merge it will not make:
      // a fresh read of the branch says which.
      if (isImported) {
        const refresh = await require('../services/pr-import-sync').reconcileImportedHead({
          config, pool, session, checks: 'defer', notify: false,
        });
        if (refresh.reconciled && !refresh.changed && sameSha(refresh.headSha, pinned)) return refused(err, await readPr());
        const moved = refresh.reconciled && refresh.changed ? refresh : null;
        return {
          outcome: 'head_moved', votesKept: !!moved?.votesKept, reviewedHeadSha: moved?.headSha || null,
          message: !moved
            ? `${label} wasn't merged, because the PR was updated on GitHub since the vote, so GitHub declined to merge the older commit. It'll be re-checked against the new commit and can merge again once it passes.`
            : moved.votesKept
              ? `${label} wasn't merged on this attempt: it had just been synced with main, so the merge is now pinned to commit ${String(moved.headSha).slice(0, 8)}. Existing votes were kept and the merge retries automatically.`
              : `${label} wasn't merged, because its GitHub head changed after review. Earlier-revision votes were cleared and the new commit is being checked; please re-review it.`,
        };
      }
      // The line the machine writes says the votes were cleared, so the
      // reconciler does not say it a second time (#3411).
      const refresh = await reconcileNativeReviewedHead({
        config, pool, session, fresh: true, notify: false, announceClearedVotes: false,
      }).catch(() => null);
      if (refresh && !refresh.blocked && refresh.headSha === pinned) return refused(err, await readPr());
      if (!refresh || refresh.blocked || !refresh.headSha) {
        return {
          outcome: 'unverified',
          message: `${label} was not merged because its current GitHub revision could not be verified. Please retry after GitHub is reachable.`,
        };
      }
      return {
        outcome: 'head_moved', votesKept: !!refresh.votesKept, reviewedHeadSha: refresh.headSha,
        message: refresh.votesKept
          ? `${label} wasn't merged on this attempt: it had just been synced with main, so the merge is now pinned to commit ${String(refresh.headSha).slice(0, 8)}. Existing votes were kept and the merge retries automatically.`
          : `${label} wasn't merged, because its GitHub head changed after review. Earlier-revision votes were cleared and the new commit is being checked; please re-review it.`,
      };
    }
    if (unanswered(err)) throw err;
    const pr = await readPr();
    if (pr && pr.merged) return observedMerge(pr);
    if (pr && pr.state === 'closed') return reopenOrClosed();
    // A draft of ours goes up for review again and is merged once more; an
    // imported one is its author's to mark ready.
    if (pr && pr.draft === true && !isImported && typeof client.markPrReadyForReview === 'function') {
      try {
        await client.markPrReadyForReview(owner, repo, session.pr_number, pr);
        return await merge();
      } catch (again) {
        if (throttled(again)) return limited(again);
        if (!again?.headMoved && unanswered(again)) throw again;
        return refused(again, await readPr());
      }
    }
    return refused(err, pr);
  };
  try {
    return await merge();
  } catch (err) {
    return handle(err);
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
async function checkAndOpenRevert(config, pool, session, decider, { steps = durableSteps.none() } = {}) {
  // #16: opening a revert is now a direct action (like proposing a
  // forward change) — there's no separate undo-vote gate to clear. We
  // still read activeCount/majority so the announcement can tell users
  // how many votes the revert PR will need to actually land. The
  // locked-app admin-yes gate is NOT applied here: it's a merge-time
  // control and is enforced when the revert PR's own merge vote is
  // tallied (the merge gate), exactly like a forward proposal.
  const { active: activeCount, majority } = await getActiveUserStats(pool, session.app_id);

  // Atomic claim — race-safe against parallel undo requests. We mark
  // the original session with revert_of_session_id = its own id as a
  // sentinel "claimed" value; the real revert session id swaps in
  // below once we have it. The WHERE NULL guarantees only one caller
  // wins this transition.
  // Kept as a step: a retry of this very request is still the claim's
  // holder, not a second request finding it taken. `claiming` is kept before
  // the claim is made, so a retry whose earlier try made it but went before
  // recording that adopts its own sentinel instead of reading it as
  // another's: one Undo of a change runs at a time (a conductor's platform
  // operation, single-flight per change), so the sentinel can be no other's.
  if (steps.active && !steps.has('claim')) await steps.set('claiming', true);
  const claimed = await steps.once('claim', async () => {
    const { rows: claim } = await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = id
       WHERE id = $1 AND revert_of_session_id IS NULL
       RETURNING id`,
      [session.id]
    );
    if (claim.length) return true;
    if (!steps.active || !steps.resumed || !steps.has('claiming')) return false;
    const { rows: [own] } = await pool.query(
      'SELECT 1 FROM chat_sessions WHERE id = $1 AND revert_of_session_id = id', [session.id]);
    return !!own;
  });
  if (!claimed) {
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
      const bm = repoRef.ownerRepo(session.repo_url);
      if (!bm) {
        backfillReason = `unparseable repo_url ${session.repo_url}`;
      } else {
        const { owner: bOwner, repo: bRepo } = bm;
        try {
          // The pull request on whichever host (services/github.js getPR:
          // a native one on the git host, GitHub's for the platform).
          const pr = await github.getPR(bOwner, bRepo, session.pr_number);
          if (pr.merged && pr.merge_commit_sha) {
            // Not on a row the merge-followups machine holds while it is
            // on: the column is the machine's (it recorded the merge as it
            // saw it); the revert reads the sha from here all the same.
            await pool.query(
              `UPDATE chat_sessions SET merge_commit_sha = $2
               WHERE id = $1 AND merge_commit_sha IS NULL
                 AND NOT wf_holds('merge-followups', 'session:' || $1::text)`,
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
        ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `Couldn't auto-revert ${label}: ${backfillReason}. Please open the revert PR manually.`,
        'system', null, { type: 'session', ref: session.id }
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

  // Either host: createRevertPR opens a hosted repository's revert natively.
  const parsedRepo = repoRef.ownerRepo(session.repo_url);
  if (!parsedRepo) {
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    return { reverted: false, error: 'unparseable repo_url' };
  }
  const { owner: repoOwner, repo: repoName } = parsedRepo;

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
      steps,
    });
  } catch (err) {
    // A host failure is tried again from the last finished step while tries
    // are left (a conductor's platform operation, services/revert-operation.js):
    // the claim stays, and the retry finds its own branch pushed or PR open.
    // A conflict, or the last try, ends it here.
    const conflict = /Revert produced merge conflicts|git revert failed/.test(String(err.message || ''));
    if (steps.active && steps.triesLeft > 0 && !conflict) throw err;
    // Release the claim so a future vote can retry. Most common
    // failure here is `git revert` conflict — surface it clearly.
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    log.error('votes', 'Revert PR creation failed', { sessionId: session.id, err: err.message });
    const label = session.pr_title
      ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
      : `PR #${session.pr_number || session.id}`;
    await sendSystemMessage(pool, session.app_id,
      `Couldn't auto-revert ${label}: ${err.message}. ` +
      `Most likely later commits depend on it. Please open the revert PR manually.`,
      'system', null, { type: 'session', ref: session.id }
    );
    return { reverted: false, error: err.message };
  }

  // Insert the revert session row. status=promoted means it lands
  // directly in the vote panel ready for a second checkpoint vote.
  // One an earlier, unconfirmed try inserted for this PR is that try's.
  const revertSessionId = await steps.once('revert-session', async () => {
    const { rows: [found] } = await pool.query(
      `SELECT id FROM chat_sessions WHERE revert_of_session_id = $1 AND pr_number = $2 AND branch_name = $3`,
      [session.id, revertInfo.prNumber, revertInfo.branch]
    );
    if (found) return found.id;
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
    return revertRows[0].id;
  });
  // (Born in review: its insert enrolled it in the proposal machine,
  // schema.sql wf_enrol_proposal.)
  await topicAttrs.selfAssignProposal(
    pool, session.app_id, revertSessionId, decider
  );

  // Patch the original's revert_of_session_id pointer to actually
  // point at the revert session (was set to its own id as a claim
  // sentinel above). Now `revert_of_session_id IS NOT NULL` on the
  // original correctly identifies "has a revert in flight".
  await pool.query(
    `UPDATE chat_sessions SET revert_of_session_id = $1 WHERE id = $2`,
    [revertSessionId, session.id]
  );

  // Say so in the undone proposal's own thread, the breadcrumb from it to
  // the revert PR (a channel carries no activity: ws.sendSystemMessage).
  const label = session.pr_title
    ? `PR #${session.pr_number || session.id}: ${session.pr_title}`
    : `PR #${session.pr_number || session.id}`;
  await steps.once('announced', () => sendSystemMessage(pool, session.app_id,
    `${decider.username} proposed undoing ${label}. Opened revert PR #${revertInfo.prNumber}, which needs ${majority}/${activeCount} votes to land.`,
    'system', null, { type: 'session', ref: session.id }
  ).then(() => true));

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
// What a revert proposal says, on either host.
function revertText(session, mergeSha, deciderUsername) {
  const origLabel = session.pr_title
    ? `${session.pr_title} (PR #${session.pr_number || session.id})`
    : `PR #${session.pr_number || session.id}`;
  const prTitle = `Revert: ${session.pr_title || `PR #${session.pr_number || session.id}`}`.slice(0, 200);
  const prBody =
    `Automated revert of ${origLabel}.\n\n` +
    `Undo vote reached majority on the original PR; deciding vote cast by \`${deciderUsername}\`. ` +
    `This PR still needs a regular merge vote to land. Vote in the app's group chat panel.\n\n` +
    `Reverts commit ${mergeSha}.`;
  return { prTitle, prBody };
}

// A repository on Homeroom's git host: the revert is made on the app's
// mirror and pushed to a new branch as the service account
// (services/hosted-git.js revertOnto); its proposal is a native pull
// request. No clone, no token in a URL.
async function pushHostedRevert({ mergeSha, repoOwner, repoName, revertBranch, prTitle }) {
  await require('../services/hosted-git').revertOnto(repoOwner, repoName, mergeSha, {
    branch: revertBranch, message: `${prTitle}\n\nThis reverts commit ${mergeSha}.`,
  });
}

// On GitHub (the platform's own repository): as the GitHub App, with an
// installation token made for this revert (services/github.js "Who
// Homeroom is on GitHub"); refused for any other owner. The token is never
// in argv, the clone's URL or its config: only the clone and the push are
// handed it, through git's credential helper, and no git child here holds
// any other secret of this process (services/git-child.js).
async function pushGithubRevert({ session, mergeSha, repoOwner, repoName, revertBranch }) {
  const token = await github.getInstallationToken(repoOwner);
  const credential = { username: 'x-access-token', token };

  const cloneUrl = `https://github.com/${repoOwner}/${repoName}.git`;
  // git's HOME beside the clone, never inside it.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `usernode-revert-${session.id}-`));
  const tmpDir = path.join(root, 'repo');
  const git = (args, { auth = false, ...opts } = {}) => {
    const child = gitChild.invocation(args, { home: root, credential: auth ? credential : null });
    return docker.execFileAsync('git', child.args, { ...opts, env: child.env });
  };

  try {
    // Full clone — we need history reaching back to the merge SHA, so
    // the deployProduction shallow-clone pattern doesn't apply here.
    await git(['clone', cloneUrl, tmpDir], { auth: true, timeout: 180000 });

    // Committer identity for the revert commit: Homeroom's one identity
    // (services/commit-identity.js), as on the git host.
    const author = require('../services/commit-identity').homeroomAuthor();
    await git(['-C', tmpDir, 'config', 'user.name', author.name]);
    await git(['-C', tmpDir, 'config', 'user.email', author.email]);

    // Branch off the current main. main has already been updated by
    // the original merge + any subsequent merges by the time we get
    // here, so this is the "current" main.
    await git(['-C', tmpDir, 'checkout', '-b', revertBranch], { timeout: 10000 });

    // `git revert --no-edit <sha>` — squash merges produce single-parent
    // commits, so no `-m 1` needed. If the revert conflicts (later
    // commits depend on this one), git exits non-zero and the docker
    // helper rejects.
    try {
      await git(['-C', tmpDir, 'revert', '--no-edit', mergeSha], { timeout: 30000 });
    } catch (revertErr) {
      // Clean up the conflicted state inside the tmp dir for hygiene
      // (best-effort), then surface a tight error.
      await git(['-C', tmpDir, 'revert', '--abort']).catch(() => {});
      const m = String(revertErr.message || '').toLowerCase();
      if (m.includes('conflict')) {
        throw new Error('Revert produced merge conflicts');
      }
      throw new Error(`git revert failed: ${revertErr.message.slice(0, 200)}`);
    }

    await git(['-C', tmpDir, 'push', '-u', 'origin', revertBranch], { auth: true, timeout: 60000 });
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// Branch off main, revert <sha>, push, open a PR, on either host.
// Returns { branch, prNumber, prUrl, prTitle }. Throws on revert conflict
// or network errors; the caller surfaces the failure to chat. Each write is
// kept as a step (a conductor's platform operation, services/
// revert-operation.js): a retry finds its own branch pushed or PR open.
async function createRevertPR({ session, mergeSha, repoOwner, repoName, deciderUsername, steps = durableSteps.none() }) {
  // Branch naming pattern: revert/<original-branch>-<timestamp>. The
  // timestamp suffix avoids collisions if a prior revert attempt left
  // a stale branch on the remote.
  const safeBase = (session.branch_name || `pr-${session.pr_number || session.id}`).replace(/[^a-zA-Z0-9._/-]/g, '-');
  const revertBranch = await steps.once('revert-branch', () => `revert/${safeBase}-${Date.now()}`);
  const { prTitle, prBody } = revertText(session, mergeSha, deciderUsername);
  const hosted = require('../services/repo-ref').hostOfOwner(repoOwner) === 'git_host';
  await steps.once('revert-pushed', async () => {
    if (steps.active && await github.getBranchSha(repoOwner, repoName, revertBranch).catch(() => null)) return true;
    if (hosted) await pushHostedRevert({ mergeSha, repoOwner, repoName, revertBranch, prTitle });
    else await pushGithubRevert({ session, mergeSha, repoOwner, repoName, revertBranch });
    return true;
  });
  const prData = await steps.once('revert-pr', async () => {
    const open = steps.active ? await github.findOpenPrByBranch(repoOwner, repoName, revertBranch).catch(() => null) : null;
    const pr = open || await github.createPR(repoOwner, repoName, { branch: revertBranch, title: prTitle, body: prBody });
    return { number: pr.number, html_url: pr.html_url };
  });
  return { branch: revertBranch, prNumber: prData.number, prUrl: prData.html_url, prTitle };
}

// evaluateMergeGate and attemptMerge are the proposal machine's merge work
// (src/workflow/proposal/services.ts merge.gate, merge.attempt).
// createRevertPR is exported for tests (tests/github-mention-safety.test.js
// asserts its PR body never carries a live @mention).
module.exports = {
  voteRoutes,
  stagingMockProposalFor,
  evaluateMergeGate,
  attemptMerge,
  refusalKind,
  githubChecksOf,
  createRevertPR,
  checkAndOpenRevert,
  // Focused revision-safety tests exercise the reconciliation without
  // driving the full HTTP router.
  reconcileNativeReviewedHead,
  reconcilePromotedSweepHead,
  reviewedHeadForSession,
  voteMatchesApprovalEpoch,
  // Connector-submitted testing metadata on an import, unit-tested directly.
  parseImportTesting,
  parseImportVisibleChanges,
  prImportFailureBody,
  shotsGateForSession,
  readShotsGate,
  // The request an imported pull request implements (#1217), likewise.
  parseImportLinkedIssues,
  parseImportSummary,
  MAX_IMPORT_SUMMARY,
  MAX_IMPORT_LINKED_ISSUES,
  recordVote,
  retractVote,
  parseExpectedEpoch,
  settleVoteInBackground,
  // #1688: the line on a vote and the names at merge, unit-tested directly.
  normalizeVoteReason,
  VOTE_REASON_MAX,
  // (#1115) The applied-close demo rows live here because they belong to the
  // Completed stream, but GET /api/apps/:slug/governance/:id in issues.js has
  // to resolve them too for a ?demo=1 deep link. Exported for that handler's
  // lazy require (issues.js requires this from inside the function, matching
  // the direction this module already uses for './issues').
  stagingMockCompletedCloseIssues,
};
