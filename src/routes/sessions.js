'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const llm = require('../services/llm');
const github = require('../services/github');
const prSync = require('../services/pr-sync-operation');
const proposalUpdate = require('../services/proposal-update');
const prMetadata = require('../services/pr-metadata');
const previewClock = require('../services/preview-clock');
const previewStart = require('../services/preview-start');
const proposalDescriptionEdit = require('../services/proposal-description-edit');
const staging = require('../services/staging');
const topicAttrs = require('../services/topic-attributes');
const { planRecordSql } = require('../services/request-specs');
const codeMissing = require('../services/code-missing');
const visuals = require('../services/visuals');
const sessionCost = require('../services/session-cost');
const docker = require('../services/docker');
const applicationRuntime = require('../services/application-runtime');
const worker = require('../services/worker');
const agentTurn = require('../services/agent-turn');
const codexOpenRouter = require('../agents/codex-openrouter');
const { MIN_MAX_OUTPUT_TOKENS } = require('../../worker/build-codex-model-catalog');
const workerProgress = require('../services/worker-progress');
const sessionLifecycle = require('../services/session-lifecycle');
const stagingRecovery = require('../services/staging-recovery');
const previewWorkflow = require('../services/preview-workflow');
const { drainGuard } = require('../services/lifecycle');
const unitSuiteRow = require('../services/unit-suite-row');
const repoRef = require('../services/repo-ref');
const specHtml = require('../services/spec-html');
const limits = require('../services/limits');
const { effectiveSessionCaps } = require('../services/session-caps');
const journeyEvents = require('../services/journey-events');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

// Imported pull requests are proposal-shaped work before they are promoted:
// their GitHub description, testing notes, check run and community attributes
// already exist, even though their lifecycle status is still active/paused.
// The ordinary session list deliberately stays lightweight and private, so
// enrich only imported Underway rows in a second, id-scoped read after the
// owner/shared visibility query has selected which rows the viewer may see.
// The opened detail uses the same public projection for any visible change;
// `all` is set only AFTER the per-session privacy gate, never on a board list.
//
// `results` (#6793) is the SELECT fragment for the check results: the stored
// column by default, or a list's own form (list-test-results.js
// resultsSelect), which Postgres trims before anything is sent.
async function enrichImportedUnderwaySessions(pool, sessions, viewerUserId, { all = false, results = 'cs.test_results' } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const ids = list
    .filter((s) => s && (all || (s.source === 'imported'
      && (s.status === 'active' || s.status === 'paused'))))
    .map((s) => Number(s.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return list;

  const { rows } = await pool.query(
    `SELECT cs.id, cs.app_id, cs.pr_number, cs.pr_url, cs.pr_title,
            cs.pr_title_fallback, cs.pr_summary_md, cs.pr_summary_stale, cs.pr_body, cs.branch_name,
            cs.staging_url, cs.testing_md, cs.testing_path, cs.testing_paths,
            cs.user_id, cs.status, cs.linked_issues, u.username, cs.created_at,
            cs.source, cs.imported_pr_author, cs.imported_pr_head_repo,
            cs.imported_pr_head_sha, cs.reviewed_head_sha, cs.handoff_head_sha,
            cs.external_agent,
            cs.merge_conflict_state, cs.behind_main, cs.conflict_files,
            cs.conflict_checked_at, cs.console_check_state, cs.console_errors,
            cs.console_checked_at, cs.check_state, ${results},
            cs.checks_checked_at, cs.checks_commit_sha, cs.checks_base_sha,
            cs.checks_base_verdict, cs.checks_base_behind_by,
            cs.mergeability, cs.mergeability_files,
            cs.mergeability_files_complete, cs.freshness_main_sha,
            cs.freshness_merge_base_sha, cs.freshness_behind_by,
            cs.freshness_ahead_by, cs.freshness_checked_at,
            cs.freshness_error, cs.check_phase, cs.check_trigger, cs.checks_progress,
            cs.platform_env_state, cs.platform_env_detail,
            cs.check_error_detail, cs.requires_explicit_approval,
            cs.imported_pr_base_ref, cs.waits_for_session_id,
            (SELECT jsonb_build_object('id', w.id, 'prNumber', w.pr_number, 'title', w.pr_title, 'status', w.status)
               FROM chat_sessions w WHERE w.id = cs.waits_for_session_id) AS waits_for,
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
               FROM session_visuals sv WHERE sv.session_id = cs.id) AS visuals_agg
       FROM chat_sessions cs
       JOIN users u ON u.id = cs.user_id
      WHERE cs.id = ANY($1::int[])
        AND ($2::boolean OR (cs.source = 'imported'
        AND cs.status IN ('active', 'paused')))`,
    [ids, all]
  );
  // The list form's fields; the unit suite's own row is the server's alone.
  listTestResults.unpackListed(rows);
  for (const row of rows) delete row.test_results_unit_row;

  const rowsByApp = new Map();
  for (const row of rows) {
    if (!rowsByApp.has(row.app_id)) rowsByApp.set(row.app_id, []);
    rowsByApp.get(row.app_id).push(row);
  }

  const attrsById = new Map();
  for (const [appId, appRows] of rowsByApp) {
    const summaries = await topicAttrs.summarizeForProposals(
      pool,
      appId,
      appRows.map((row) => ({ id: row.id, linked_issues: row.linked_issues })),
      viewerUserId || null
    );
    for (const row of appRows) {
      attrsById.set(row.id, summaries.get(row.id) || topicAttrs.emptySummary());
    }
  }

  const detailsById = new Map();
  for (const row of rows) {
    const attrs = attrsById.get(row.id) || topicAttrs.emptySummary();
    const detail = {
      ...row,
      visuals: visuals.shapeAgg(row.visuals_agg, visualHeadForSession(row)),
      ...staging.previewDisplayState(row),
      priority: attrs.priority,
      assignee: attrs.assignee,
      category: attrs.category,
    };
    delete detail.app_id;
    delete detail.visuals_agg;
    detailsById.set(row.id, detail);
  }

  return list.map((session) => {
    const detail = detailsById.get(session.id);
    return detail ? { ...session, ...detail } : session;
  });
}

const { getActiveUserStats } = require('../services/active-users');
const appAccess = require('../services/app-access');
const listTestResults = require('../services/list-test-results');
const communities = require('../services/communities');
// #1417: the viewer's open connector work orders, read for the Improve
// panel alongside their sessions. Owns external_agent_tasks, so the query
// lives there rather than being restated here.
const { listOpenWorkOrders } = require('../services/external-agent-tasks');
// #945: Homeroom-side issue / proposal discussion threads as agent
// context. Every loader here degrades to an empty result, so a failed
// lookup drops the block rather than failing the turn.
const threadContext = require('../services/thread-context');
const {
  visualHeadForSession,
  countedVotePredicateSql,
} = require('../services/pr-vote-revision');
const notifications = require('../services/notifications');
// A sync with main is the proposal machine's (src/workflow/proposal/,
// branch.sync: services/sync-main.js runSyncWork); the routes ask for one.
const syncMainSvc = require('../services/sync-main');
const { persistBehindMain } = syncMainSvc;

// Track sessions with active coding workers. The Set lives in a
// shared module so services/sync-main.js writes to the same instance
// these routes and server.js's drain logic read.
const {
  activeWorkers,
  beginSessionOperation,
  getActiveWorkerCount,
  isSessionBusy,
  isSessionBusyAnywhere,
  busySessionsAnywhere,
} = require('../services/active-workers');
const { workedOnSql } = require('../workflow/session-work.ts');
const sessionState = require('../services/session-state');
const turnLifecycle = require('../services/turn-lifecycle');
const turnEffects = require('../services/turn-effects');

// Who may read a session's checks, details and live status: its owner, an
// admin, anyone while its owner has shared it and it is still underway, and
// anyone once it is a proposal up for a vote (or merging/merged). `session`
// needs `user_id`, `status` and `shared_at`.
function canViewSession(session, user) {
  if (!session || !user) return false;
  return session.user_id === user.id || !!user.isAdmin
    || (!!session.shared_at && ['active', 'paused'].includes(session.status))
    || ['promoted', 'merging', 'merged'].includes(session.status);
}

// A session that will not change again, for the session list's `?recent=N`.
const FINISHED_SESSION_STATUSES = new Set(['merged', 'archived']);
// `?recent=N` as a count of finished rows to keep: 1..200, or null to list
// them all.
function recentFinishedLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 200);
}

const { isCliCredentialManagementSession } = require('../services/cli-api-policy');
// #937: pure local stop policy and pre-dispatch gates. Confirmation belongs to the
// conductor's interrupt machine.
const stopPolicy = require('../services/stop-policy');

const CLI_CREDENTIAL_MANAGEMENT_ERROR = 'credential_management_not_available_via_cli';
const MANUAL_SESSION_TITLE_MAX = 256;

// #1038: identifies THIS platform process to the client's session-state
// store. Live busy state is in-process memory (see services/session-state),
// so a restart or a blue-green cutover invalidates every override a client
// is holding. Shipping the boot time on each reconcile lets the client
// notice the swap and clear its state instead of showing a phantom spinner
// for a turn that died with the old process.
const PROCESS_BOOT_ID = String(Date.now());

// #1378: per-session stop handles live in a shared leaf service, where the
// detached-turn recovery path (services/turn-recovery.js) registers one. See
// services/stop-registry.js for the handle shape and for the production
// failure that moved it out of this module. It also owns the
// sessionState.setPhaseResolver wiring that used to sit here.
const stopRegistry = require('../services/stop-registry');

// Coalesces repeated Preview clicks (the ensure-staging route below) while
// one is still handing the rebuild to the preview machine, which builds it
// once whoever asks. Only this process's clicks; cleared when the hand-off
// settles.
const ensureStagingInFlight = new Set();

// #447: coalesces repeat clicks on the manual "Re-run checks" route below
// while one is still handing the recheck to the preview machine (which joins
// a run already going). Cleared when the hand-off settles.
const recheckInFlight = new Set();

// ── Staging mock data ──────────────────────────────────────────────────
function stagingMockOwnSession(userId, appSlug) {
  return {
    id: 990101, branch_name: 'mock/my-session', pr_number: null,
    preview_placeholder: true,
    user_id: userId,
    pr_url: null, pr_title: null,
    session_title: '[Mock] Your in-progress session',
    // Reverse "#N" issue chip demo on the own-session card: links
    // to mock issue 900002, which stagingMockIssues serves.
    status: 'active', linked_issues: [900002], shared_at: null,
    created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    last_activity_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    app_slug: appSlug, app_name: 'Homeroom', busy: false,
    // #1959: this one is WAITING ON ITS OWNER — a spec that ended
    // with open questions — so the Improve panel's "Ready for your
    // input" pill is reviewable in a preview, right under the busy
    // row's "Working"; every other idle mock row reads plain
    // "Ready". Hand-set, like `busy` on 990102: the mocks are
    // appended after the map that computes the real verdict.
    awaiting_input: true,
  };
}

// One source for the display-only rows in the list and their detail reads.
function stagingMockOwnSessions(userId, appSlug) {
  return [
  stagingMockOwnSession(userId, appSlug),
  // Card-as-pointer revision: a PRIVATE session that already has a
  // PR, so the muted/draft shell renders WITH the icon Preview
  // affordance beside its ⋯. Both other private rows have
  // pr_number: null, so without this one the muted-plus-preview
  // combination is unreviewable in a preview.
  {
    id: 990107, branch_name: 'mock/my-session-private-pr', pr_number: 990107,
    pr_url: null, pr_title: null,
    session_title: '[Mock] Your private session with a preview',
    status: 'active', linked_issues: [900011], shared_at: null,
    created_at: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    last_activity_at: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
    app_slug: appSlug, app_name: 'Homeroom', busy: false,
  },
  // Busy own session — exercises the "working…" state (spinner tag
  // beside the title, which the single-row shell keeps uncrushed).
  {
    id: 990102, branch_name: 'mock/my-session-busy', pr_number: null,
    pr_url: null, pr_title: null,
    session_title: '[Mock] Busy own session with a fairly long title to verify the working-state layout',
    status: 'active', linked_issues: [], shared_at: null,
    created_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    last_activity_at: new Date().toISOString(),
    app_slug: appSlug, app_name: 'Homeroom', busy: true,
  },
  // Visible (shared) own session — renders below the archived
  // toggle under the "Visible to everyone." caption, with the
  // Preview (#689: pr_number set) + Open discussion + Hide buttons.
  {
    id: 990103, branch_name: 'mock/my-session-visible', pr_number: 990103,
    pr_url: 'https://github.com/Usernode-Labs/social-vibecoding/pull/990103', pr_title: null,
    session_title: '[Mock] Your visible session',
    status: 'active', linked_issues: [],
    shared_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    last_activity_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    app_slug: appSlug, app_name: 'Homeroom', busy: false,
  },
  // A second visible own session, with no PR link (the mock notifications
  // in routes/notifications.js open it).
  {
    id: 990104, branch_name: 'mock/my-session-visible-2', pr_number: 990104,
    pr_url: null, pr_title: null,
    session_title: '[Mock] Your second visible session',
    status: 'active', linked_issues: [],
    shared_at: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    created_at: new Date(Date.now() - 70 * 60 * 1000).toISOString(),
    last_activity_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    app_slug: appSlug, app_name: 'Homeroom', busy: false,
  },
  // #747: promoted own session whose id matches the first mock
  // proposal (stagingMockProposals in votes.js), which the
  // /api/me/proposals demo block also returns — so the work
  // drawer's de-dup is reviewable via ?demo=1: this row must
  // render under "Your proposals" only, never "Your sessions".
  {
    id: 9000001, branch_name: 'mock/my-promoted-session', pr_number: 900101,
    pr_url: null,
    pr_title: '[Mock] Promoted session — must NOT appear under Your sessions',
    session_title: '[Mock] Promoted session — must NOT appear under Your sessions',
    status: 'promoted', linked_issues: [], shared_at: null,
    created_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    last_activity_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    app_slug: appSlug, app_name: 'Homeroom', busy: false,
  },
  // A proposal-in-vote row so the dev drawer's violet "Proposed"
  // card state is reviewable in a demo preview. Unlike 9000001
  // above, this id is deliberately NOT in the mock proposals list,
  // so it renders in the session list (the "proposals fetch
  // failed" fallback the work drawer documents) — which is exactly
  // the card the promoted-cap copy talks about. Appended AFTER
  // totals like every other mock, so the "(x/y)" numerator stays
  // honest and the denominators come from `caps` below.
  {
    id: 990105, branch_name: 'mock/my-proposal-in-vote', pr_number: 990105,
    pr_url: null, pr_title: '[Mock] Proposal up for vote',
    session_title: '[Mock] Proposal up for vote',
    status: 'promoted', linked_issues: [], shared_at: null,
    created_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
    last_activity_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    app_slug: appSlug, app_name: 'Homeroom', busy: false,
  },
  // #1808: the row PAST the relative form's seven-day floor. Every
  // other mock here is minutes or hours old, so the session rows'
  // stamp read "5m ago" on all of them and the branch that prints a
  // real date was unreachable in a preview. A session parked a
  // fortnight ago is also the case the old code got worst: it
  // bucketed at thirty days and then months, so this row read "0mo
  // ago" once and "5mo ago" later, neither of which is a day.
  {
    id: 990108, branch_name: 'mock/my-session-stale', pr_number: null,
    pr_url: null, pr_title: null,
    session_title: '[Mock] Your session from a couple of weeks ago',
    status: 'active', linked_issues: [], shared_at: null,
    created_at: new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString(),
    last_activity_at: new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString(),
    app_slug: appSlug, app_name: 'Homeroom', busy: false,
  },
  // #6042: one mock per new pill state, so the Messages agents list shows
  // the lifecycle in a demo preview — failing checks (with the count the
  // payload's summary carries), checks running, and a merged change saying
  // Live. All three sit INSIDE the five slots the agents list shows (2–4
  // minutes, under the needs-you row's five), because a state a preview
  // folds behind "N older chats" is a state a reviewer cannot see; the same
  // arithmetic the 6-minute work order above documents. Fake 99xxxx ids,
  // read-only and obviously fake, like every mock here. They start at 990112:
  // 990109 is the archived-session mock's id further down this route, and
  // 990110/990111 are the sessionIds the notifications demo rows point at —
  // one number names one mock (tests/staging-demo-id-ranges.test.js).
  {
    id: 990112, branch_name: 'mock/my-session-checks-failing', pr_number: 990112,
    pr_url: null, pr_title: '[Mock] Change with failing checks',
    session_title: '[Mock] Change with failing checks',
    status: 'active', linked_issues: [], shared_at: null,
    check_state: 'failing', check_phase: null,
    failing_checks: { total: 2, blocking: 2, rows: [] },
    created_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    last_activity_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    app_slug: appSlug, app_name: 'Homeroom', busy: false,
  },
  {
    id: 990113, branch_name: 'mock/my-session-checks-running', pr_number: null,
    pr_url: null, pr_title: null,
    session_title: '[Mock] Change whose checks are running',
    status: 'active', linked_issues: [], shared_at: null,
    check_state: 'pending', check_phase: 'testing',
    created_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    last_activity_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    app_slug: appSlug, app_name: 'Homeroom', busy: false,
  },
  {
    id: 990114, branch_name: 'mock/my-session-merged', pr_number: 990114,
    pr_url: null, pr_title: '[Mock] Merged change',
    session_title: '[Mock] Change that went live',
    status: 'merged', linked_issues: [], shared_at: null,
    merged_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    created_at: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
    last_activity_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    app_slug: appSlug, app_name: 'Homeroom', busy: false,
  }
].map((sample) => ({ ...sample, preview_placeholder: true }));
}

function stagingMockSharedSessions() {
  return [
          {
            id: 990001, session_title: '[Mock] Busy shared session — spinner state',
            pr_title: null, branch_name: 'mock/shared-busy', status: 'active',
            // Reverse "#N" issue chip demo: links to mock issue 900001,
            // which stagingMockIssues serves, so the round trip works.
            linked_issues: [900001],
            staging_url: null, can_preview: false, user_id: 0, username: 'staging-demo-user',
            shared_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            last_activity_at: new Date().toISOString(),
            chat_count: 0, last_message_at: null, busy: true,
          },
          {
            id: 990002, session_title: '[Mock] Paused shared session with a preview',
            pr_title: null, pr_number: 990002,
            pr_url: 'https://github.com/Usernode-Labs/social-vibecoding/pull/990002',
            branch_name: 'mock/shared-preview', status: 'paused',
            linked_issues: [],
            staging_url: 'https://example.invalid', can_preview: true, user_id: 0, username: 'staging-demo-user',
            shared_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
            created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
            last_activity_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
            chat_count: 3, last_message_at: new Date().toISOString(), busy: false,
          },
          // #689: preview asleep (staging GC'd the container) but the
          // branch has pushed changes — the pill still renders and routes
          // through ensure-staging. Clicking it in a demo 404s (fake id)
          // into the "could not be rebuilt" loader, same as 990002.
          //
          // Worth knowing: this row modelled a state a REAL share-only
          // session could not be in. `can_preview: true` with no
          // staging_url was reachable only for a session with a pull
          // request, because the derivation above was `pr_number IS NOT
          // NULL` — so the demo board showed a rebuild affordance that the
          // thing it demonstrates never got. The fixture was right and the
          // derivation was wrong; the derivation now also reads
          // checks_commit_sha, and this row is honest.
          {
            id: 990003, session_title: '[Mock] Shared session, preview asleep (rebuild on click)',
            pr_title: null, branch_name: 'mock/shared-preview-asleep', status: 'paused',
            linked_issues: [],
            staging_url: null, can_preview: true, user_id: 0, username: 'staging-demo-user',
            shared_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
            created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
            last_activity_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            chat_count: 1, last_message_at: new Date().toISOString(), busy: false,
          }
  ];
}

// (#1012) Read-only mock spec version for the group-chat spec panel.
// Request-time only, never persisted, and a strict no-op outside staging — the caller gates on
// USERNODE_ENV === 'staging' && ?demo=1 AND on the real lookup finding
// nothing, so a genuine row always wins.
//
// Why it's needed: chat_session_specs is staging:private, so a
// prod-cloned staging DB has ZERO spec content while chat_messages (and
// therefore the cloned spec_share cards in group chat) IS copied. Without
// this, every "View full spec" in a staging preview renders the 404 error
// branch and the panel's real layout — including its copy button — can't
// be reviewed.
//
// The document follows the platform's two-half spec convention (both
// marker headings), as a real spec does, so the panel draws what a real
// spec would and a reviewer can confirm that "Copy markdown" yields the
// WHOLE document.
const STAGING_MOCK_SPEC_MD = [
  '# [Mock] Readable cards on narrow screens',
  '',
  'Staging demo spec — the cards get a two-row layout so the title stops being crushed.',
  '',
  '## User-facing changes',
  '',
  '- Each card shows its title on its own line.',
  '- The action buttons wrap underneath instead of squeezing the title.',
  '',
  '## Technical implementation',
  '',
  '- Split the card renderer into a title row and an actions row.',
  '- The actions row wraps at narrow widths; no change above 640px.',
  '',
].join('\n');

function stagingMockSpecVersion(version) {
  return {
    version,
    content: STAGING_MOCK_SPEC_MD,
    built_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    commit_sha: null,
    pr_number: 9301,
    shared_to_group_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
  };
}

// Same #1012 convention, for the version-LIST endpoint (GET /spec): a
// prod-cloned staging DB has zero chat_session_specs rows, so a reviewer
// opening a session's spec panel would always hit the empty state. The
// mock list is what a NON-OWNER would see after the shared-visibility
// filter: two shared versions with a gap where an unshared v2 would sit,
// so the non-contiguous dropdown (the filter's visible effect) is
// exercised too. Request-time only, never persisted, and reached only
// when the real lookup found nothing.
function stagingMockSpecList() {
  const meta = (v) => ({
    version: v.version,
    built_at: v.built_at,
    commit_sha: v.commit_sha,
    pr_number: v.pr_number,
    shared_to_group_at: v.shared_to_group_at,
    char_count: v.content.length,
  });
  const latest = stagingMockSpecVersion(3);
  const older = stagingMockSpecVersion(1);
  return { spec: latest.content, versions: [meta(latest), meta(older)] };
}

// The single source of truth for "is this frozen spec version visible to
// a viewer who does not own the session?" — shared to the app's group
// chat, privately shared with this exact viewer (#86), or shared into a
// conversation the viewer is an active member of (excluding blocked
// direct pairs). Interpolated (never parameterised) into both spec read
// routes — GET /api/sessions/:id/spec and GET /api/sessions/:id/specs/
// :version — so the list gate and the content gate cannot drift apart.
// `specAlias` is the chat_session_specs alias in the caller's query and
// `viewerParam` the $n placeholder carrying req.user.id.
function specVersionSharedVisibilitySql(specAlias, viewerParam) {
  return `(${specAlias}.shared_to_group_at IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM chat_session_spec_user_shares us
                   WHERE us.session_id = ${specAlias}.session_id
                     AND us.version = ${specAlias}.version
                     AND us.recipient_id = ${viewerParam}
                ) OR EXISTS (
                  SELECT 1
                    FROM chat_session_spec_conversation_shares scs
                    JOIN conversations shared_conversation
                      ON shared_conversation.id = scs.conversation_id
                     AND shared_conversation.status = 'active'
                    JOIN conversation_members cm
                      ON cm.conversation_id = scs.conversation_id
                   WHERE scs.session_id = ${specAlias}.session_id
                     AND scs.version = ${specAlias}.version
                     AND cm.user_id = ${viewerParam}
                     AND cm.status = 'member'
                     AND NOT EXISTS (
                       SELECT 1
                         FROM conversations direct_conversation
                         JOIN conversation_direct_pairs direct_pair
                           ON direct_pair.conversation_id = direct_conversation.id
                         JOIN user_blocks direct_block
                           ON (direct_block.blocker_id = direct_pair.user_low_id
                               AND direct_block.blocked_user_id = direct_pair.user_high_id)
                            OR (direct_block.blocker_id = direct_pair.user_high_id
                               AND direct_block.blocked_user_id = direct_pair.user_low_id)
                        WHERE direct_conversation.id = scs.conversation_id
                          AND direct_conversation.kind = 'direct'
                     )
                ))`;
}

// #4479: the plan a change was built from, as its page's plan card names it:
// the newest version this viewer may read (the owner, every version; anyone
// else, one shared with them), or null. Through the ONE visibility fragment
// above, so the card never offers a Read that GET /specs/:version refuses.
async function changePlanFor(pool, sessionId, ownerId, viewerId) {
  const { rows } = await pool.query(
    `SELECT s.version, s.built_at
       FROM chat_session_specs s
      WHERE s.session_id = $1
        AND ($2::int = $3::int OR ${specVersionSharedVisibilitySql('s', '$3')})
      ORDER BY s.version DESC
      LIMIT 1`,
    [sessionId, ownerId ?? null, viewerId ?? null]
  );
  return rows[0] ? { version: Number(rows[0].version), at: rows[0].built_at } : null;
}

// The same plan for every change on a board list (/promoted, /merged), by
// changePlanFor's rule, in one read. The change page draws from the board's
// row first, and its plan card used to be inserted when the page's own read
// answered, pushing its votes and shots down (polish board #14). Best-effort:
// a failed read leaves the rows as they were, and the page's own read still
// brings the card.
async function attachChangePlans(pool, rows, viewerId) {
  const list = (rows || []).filter((r) => r && (r.row_type || 'pr') === 'pr'
    && Number.isSafeInteger(Number(r.id)) && Number(r.id) > 0);
  if (!list.length) return;
  try {
    const { rows: found } = await pool.query(
      `SELECT DISTINCT ON (s.session_id) s.session_id, s.version, s.built_at
         FROM chat_session_specs s
         JOIN chat_sessions owner_session ON owner_session.id = s.session_id
        WHERE s.session_id = ANY($1::int[])
          AND (owner_session.user_id = $2::int OR ${specVersionSharedVisibilitySql('s', '$2')})
        ORDER BY s.session_id, s.version DESC`,
      [list.map((r) => Number(r.id)), viewerId ?? null]
    );
    const byId = new Map(found.map((p) => [Number(p.session_id), { version: Number(p.version), at: p.built_at }]));
    for (const r of list) r.plan = byId.get(Number(r.id)) || null;
  } catch (err) {
    log.warn('sessions', 'Could not read the plans for a board list', { message: err.message });
  }
}

// getActiveWorkerCount is imported from services/active-workers and
// re-exported at the bottom of this module (server.js imports it here).

// Daily LLM-spend caps used to live as hardcoded constants here. They
// now live in the platform_settings table (admin-tunable) and are read
// via src/services/limits.js with a 10s in-process cache. Per-user
// overrides come from users.daily_limit_cents.

// How many failing checks a summary names before it says how many more there are.
const FAILING_CHECKS_MAX = 12;

// The failing checks as DATA rather than prose, capped the same way.
//
// #1766: a coding agent fixing a change is told exactly which checks fail,
// with names, paths and reasons; the person watching the card once got only
// a number. So the board renders these same rows, and every reader derives
// them from this one function: an agent and a human reading different
// answers about the same run is the failure this shape prevents.
//
// Both caps bend for the repo unit suite's row. It is ONE row standing for
// every failing unit test, and its reason is the only place the fix turn
// learns which test files to run. The row is appended after the browser
// checks, so behind twelve failing ones the row cap dropped it, and 300
// characters of its reason held a few test names and no file — a fix turn
// then re-ran the whole suite to find the rest. So it leads, where the row
// cap cannot reach it, and keeps the whole reason unit-suite.js already
// bounded.
function summarizeFailingChecks(checkState, testResults, max = FAILING_CHECKS_MAX) {
  if (checkState !== 'failing') return { total: 0, blocking: 0, rows: [] };
  // A unit suite that never reached `npm test` names no failing test, and
  // a fix turn handed it would go looking for one.
  const all = (Array.isArray(testResults) ? testResults : [])
    .filter((r) => r && r.status !== 'pass' && !unitSuiteRow.isNotRunRow(r));
  const failing = [
    ...all.filter(unitSuiteRow.isUnitSuiteRow),
    ...all.filter((r) => !unitSuiteRow.isUnitSuiteRow(r)),
  ];
  return {
    total: failing.length,
    // Advisory rows report but do not block, so a reviewer counting them as
    // reasons the merge is held up would be reading a blocker that is not
    // one. Same distinction MergeStatus.lifecycle already draws for the pill.
    blocking: failing.filter((r) => !r.advisory).length,
    rows: failing.slice(0, max).map((r) => ({
      name: String(r.name || 'unnamed check').slice(0, 160),
      path: String(r.path || '').slice(0, 160) || null,
      reason: String(r.failureReason || 'failed')
        .slice(0, unitSuiteRow.isUnitSuiteRow(r) ? unitSuiteRow.FAILURE_DETAIL_MAX : 300),
      advisory: !!r.advisory,
      consoleError: Array.isArray(r.consoleErrors) && r.consoleErrors[0]
        ? String(r.consoleErrors[0].message || '').slice(0, 200)
        : null,
      // #3978: the unit-suite row's first failing-test excerpt — the
      // assertion message and expected/actual, which the grouped reason
      // above deliberately does not carry. One test, tightly clipped; the
      // rest is what a re-run of the named files prints.
      excerpt: unitSuiteRow.isUnitSuiteRow(r)
        && Array.isArray(r.failureDetails) && r.failureDetails[0] && r.failureDetails[0].excerpt
        ? String(r.failureDetails[0].excerpt).replace(/\s+/g, ' ').slice(0, 400)
        : null,
    })),
  };
}

// Build the inline spec-preview snippet (F8): cap length but cut on a
// whitespace boundary so we don't slice through a word or an inline
// markdown construct, then append an ellipsis.
function buildSpecPreview(content, max = 400) {
  const text = typeof content === 'string' ? content : '';
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const bound = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  if (bound > max * 0.8) cut = cut.slice(0, bound);
  return `${cut}…`;
}

// Unwrap a whole-document ```markdown fence a scout/spec-author LLM sometimes
// emits around the entire spec (see src/services/spec-format.js for the why
// and the conservative rules). Re-exported below so existing importers and
// tests can keep requiring it from this module.
const { stripSpecWrapperFence } = require('../services/spec-format');

// #3699: what a spec author's final message is stored as. A markdown spec is
// its fence-stripped text, as it always was. An HTML spec is stored as its
// markdown copy (`text`), which is what every reader of spec text gets and so
// what `ccText` means at each capture site, beside the document (`html`).
function captureSpecOutput(raw) {
  const { markdown, html } = specHtml.normalizeSpecOutput(stripSpecWrapperFence(String(raw || '').trim()));
  return { text: String(markdown || '').trim(), html: html || null };
}

// #27: freeze the current spec content as a new immutable version in
// chat_session_specs and return its version number. Every spec mutation
// (scout) calls this and tags its inline spec
// preview card with the returned version, so clicking an OLDER card
// opens exactly the content it represented — instead of always falling
// back to the latest spec. Since #69 retired the manual "Save version"
// route, this and the native CLI proposal-handoff route are the only writers
// of new rows in chat_session_specs;
// it uses MAX(version)+1. Ordinary callers remain best-effort; durable scout
// publication passes required:true so the version and its receipt/card roll
// back together instead of committing a partially replayable outcome.
async function snapshotSessionSpec(pool, sessionId, content, { required = false, html = null } = {}) {
  try {
    // #3699: content_html is the version's HTML document when it was written
    // as one; content is then its markdown copy.
    const { rows } = await pool.query(
      `INSERT INTO chat_session_specs (session_id, version, content, content_html)
       VALUES ($1, COALESCE((SELECT MAX(version) FROM chat_session_specs WHERE session_id = $1), 0) + 1, $2, $3)
       RETURNING version`,
      [sessionId, content, html || null]
    );
    return rows[0].version;
  } catch (err) {
    log.warn('sessions', 'Failed to snapshot spec version', { err: err.message, sessionId });
    if (required) throw err;
    return null;
  }
}

// Publish a completed scout's three database effects as one receipt-backed
// transaction: latest spec, immutable version, and the transcript card. A
// crash after commit can then replay the receipt without creating another
// version or row. Legacy records without a stable turn id retain their
// historical best-effort path.
async function persistScoutPublication({
  pool,
  sessionId,
  turnId = null,
  content,
  // #3699: the spec's HTML document when it was written as one; `content` is
  // then its markdown copy (captureSpecOutput).
  contentHtml = null,
  hadSpec = false,
  recovered = false,
  agentBackend = null,
  agentModel = null,
}) {
  const ccText = String(content || '').trim();
  if (!ccText) throw new Error('persistScoutPublication: spec content required');
  const lineCount = ccText.split('\n').length;
  const scoutText = hadSpec
    ? `Scout revised the plan (now ${lineCount} lines).`
    : `Scout drafted a ${lineCount}-line plan from the codebase.`;
  let html = typeof contentHtml === 'string' && contentHtml.trim() ? contentHtml.trim() : null;
  if (html) {
    // #3699: which stylesheet the screens draw with depends on the app
    // (spec-html.js, stampSpecStyles); an app that cannot be read gets the
    // native kit alone, the choice that never borrows the shell's styles.
    let app = null;
    try {
      const { rows } = await pool.query(
        'SELECT a.slug, a.self_hosted FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1',
        [sessionId],
      );
      app = rows[0] || null;
    } catch (err) {
      log.warn('sessions', 'Could not read the app of an HTML spec', { sessionId, err: err.message });
    }
    html = specHtml.stampSpecStyles(html, specHtml.specStylesFor(app));
  }
  const persist = async (client, { requiredSnapshot }) => {
    await client.query(
      'UPDATE chat_sessions SET spec_md = $1, spec_html = $3 WHERE id = $2',
      [ccText, sessionId, html],
    );
    const specVersion = await snapshotSessionSpec(
      client,
      sessionId,
      ccText,
      { required: requiredSnapshot, html },
    );
    const metadata = {
      specPreview: buildSpecPreview(ccText),
      specLines: lineCount,
      scoutOutput: ccText,
      specVersion,
      ...(html ? { specFormat: 'html' } : {}),
      ...(recovered ? { recovered: true } : {}),
      ...(agentBackend ? { agentBackend, agentModel: agentModel || null } : {}),
    };
    await client.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [sessionId, scoutText, JSON.stringify(metadata)],
    );
    return { scoutText, metadata, lineCount, specVersion, hadSpec: !!hadSpec };
  };

  if (turnId) {
    const receipt = await turnEffects.runDbEffect({
      pool,
      turnId,
      effectKey: turnEffects.EFFECT_KEYS.SCOUT_SPEC_PUBLICATION,
      sessionId,
      run: (client) => persist(client, { requiredSnapshot: true }),
    });
    return { applied: receipt.applied, ...(receipt.value || {}) };
  }

  const value = await persist(pool, { requiredSnapshot: false });
  return { applied: true, ...value };
}

// Resume a paused session of the user's: the body of POST
// /api/sessions/:id/resume, shared with the sync-main route, which resumes a
// paused session by itself ("paused" is bookkeeping the user never has to
// manage). Ownership is checked first, then
// the global cap (another user's idle session may be paused), then the user's
// own cap (their least recently used session is paused). Returns { ok: true }
// or { ok: false, status, error, code? }: code 'not_decided' (a 503) when the
// machine did not decide in time, which sendResumeRefusal answers with
// Retry-After.
async function resumePausedSession({ pool, config, user, sessionId }) {
  // Ownership FIRST: everything below is platform-wide bookkeeping (the
  // global cap can pause a third party's idle session, the per-user one one
  // of the requester's own), and none of it may run for a request that was
  // going to 404 anyway.
  const { rows: ownRows } = await pool.query(
    'SELECT id, app_id, status FROM chat_sessions WHERE id = $1 AND user_id = $2',
    [sessionId, user.id]
  );
  const own = ownRows[0];
  if (!own || own.status !== 'paused') return { ok: false, status: 404, error: 'Session not found or not paused' };

  // The proposal machine resumes it under the caps, counted under locks
  // (the owner's row, the platform's slots): over one, it is refused, and a
  // session to pause for it is asked to, once per cap, before it asks again.
  // The per-user cap counts only 'active' sessions (#193); its ceiling is
  // per-requester (full admins get a raised cap: services/session-caps.js).
  // The global one is the session limit (services/session-limit.js).
  const caps = effectiveSessionCaps(config, user);
  const cap = {
    user: caps.activeSessions,
    global: await require('../services/session-limit').effective(pool, config),
  };
  const platform = require('../workflow/platform.ts');
  const tried = new Set();
  for (;;) {
    const out = await platform.resumeProposal({
      sessionId: Number(sessionId), appId: own.app_id, from: 'paused', userId: user.id, caps: cap, source: { kind: 'route', name: 'resume' },
    });
    if (out.status === 'accepted' || out.status === 'replayed') break;
    // Not applied in time: past its deadline the machine refuses it, so the
    // session is still paused.
    if (out.status === 'pending' || out.reason === 'expired') return RESUME_NOT_DECIDED;
    const reason = out.reason;
    if (reason === 'already_active') break;
    if (reason === 'global_cap' && !tried.has(reason)) {
      tried.add(reason);
      const { freed, notDecided } = await sessionLifecycle.freeGlobalSlot({ pool, graceMs: config && config.sessionPressureGraceMs, excludeSessionId: sessionId });
      if (freed) continue;
      if (notDecided) return RESUME_NOT_DECIDED;
      await sessionLifecycle.recordCapacityRefusal(pool, { cap: 'global', path: 'resume', userId: user.id });
      return { ok: false, status: 429, error: sessionLifecycle.PLATFORM_AT_CAPACITY };
    }
    if (reason === 'user_cap' && !tried.has(reason)) {
      tried.add(reason);
      if (!config.sessionLruOnResume) {
        sessionLifecycle.recordCapacityRefusal(pool, { cap: 'user', path: 'resume', userId: user.id });
        return { ok: false, status: 429, error: `You already have ${caps.activeSessions} sessions in progress. Try again when one of them finishes.` };
      }
      // LRU: their least recently active session nobody works on is paused
      // to free a slot (never one up for a vote).
      const { freed, notDecided } = await sessionLifecycle.freeUserSlot({
        pool, userId: user.id, excludeSessionId: sessionId, includeHeadless: true,
      });
      if (freed) continue;
      if (notDecided) return RESUME_NOT_DECIDED;
      sessionLifecycle.recordCapacityRefusal(pool, { cap: 'user', path: 'resume', userId: user.id });
      return { ok: false, status: 429, error: sessionLifecycle.USER_SLOTS_BUSY };
    }
    if (reason === 'global_cap') return { ok: false, status: 429, error: sessionLifecycle.PLATFORM_AT_CAPACITY };
    if (reason === 'user_cap') return { ok: false, status: 429, error: sessionLifecycle.USER_SLOTS_BUSY };
    return { ok: false, status: 404, error: 'Session not found or not paused' };
  }
  log.info('sessions', 'Session resumed', { sessionId });

  // #8: if the resumed session is behind main, kick off a silent
  // sync in the background. The HTTP response returns immediately
  // (the UI doesn't wait for the sync to complete) — drift
  // accounting is best-effort and the change's screens update
  // via the session_update WS event when it lands. We
  // run this only when the session has a known positive drift
  // count from a prior turn; sessions that never ran a turn
  // have behind_main=0.
  // How far behind main it is: the mirror's measurement when there is one,
  // else the last turn's count.
  const { rows: driftRows } = await pool.query(
    'SELECT COALESCE(integration_behind_by, behind_main) AS behind FROM chat_sessions WHERE id = $1',
    [sessionId]
  );
  // Not for a change whose branch did not come across from GitHub
  // (services/code-missing.js): there is nothing to merge main into.
  if ((driftRows[0]?.behind || 0) > 0
      && await codeMissing.branchGone(pool, { id: Number(sessionId) }) === true) {
    log.info('sessions', 'Sync-on-resume skipped: the change\'s branch did not come across from GitHub', { sessionId });
  } else if ((driftRows[0]?.behind || 0) > 0) {
    // Asked of the proposal machine, not waited for: the sync is its work,
    // and a refusal (somebody working on it) is logged. The user clicking
    // "Sync with main" later asks again with the answer in front of them.
    require('../workflow/platform.ts').requestSync({
      sessionId: Number(sessionId), appId: own.app_id, reason: 'resume', userId: user.id,
      source: { kind: 'route', name: 'resume' },
    }).then((out) => {
      if (out.status === 'rejected') log.info('sessions', 'Sync-on-resume not started', { sessionId, reason: out.reason });
    }).catch((err) => {
      log.warn('sessions', 'Background sync-on-resume failed', { sessionId, err: err.message });
    });
  }
  return { ok: true };
}

// A resume Homeroom has not decided yet (the machine slow or restarting):
// the session is still paused, and asking again may resume it.
const RESUME_NOT_DECIDED = Object.freeze({
  ok: false, status: 503, code: 'not_decided',
  error: 'Homeroom has not decided on resuming this session yet. Try again in a few seconds.',
});

// Answers a resumePausedSession refusal: its status and error, and for one
// not decided yet its code and Retry-After.
function sendResumeRefusal(res, resumed) {
  if (resumed.code === 'not_decided') return sessionLifecycle.answerNotDecided(res, resumed.error);
  return res.status(resumed.status).json({ error: resumed.error });
}

function sessionRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // #1038: the notifier needs a pool to resolve a touched session's app /
  // owner / share state before it can decide who a `session_state` event
  // goes to. It has no config of its own, so hand it the one this router
  // already built.
  sessionState.setPool(pool);

  // Per-app visibility gate for every session-id-addressed route below
  // (/api/sessions/:id/...): resolves the session's app and requires
  // collab-level access. 404 on deny so private apps' sessions aren't
  // enumerable; missing sessions fall through to each route's own 404.
  router.use('/api/sessions/:id', appAccess.sessionCollabGuard(pool));

  // Reader-facing description, shared by the menu editor and MCP. Reading
  // just this resource avoids downloading the author's private build chat.
  router.get('/api/sessions/:id/description', async (req, res) => {
    const id = /^[1-9]\d{0,9}$/.test(String(req.params.id)) ? Number(req.params.id) : 0;
    if (!id || id > 2147483647) return res.status(404).json({ error: 'Change not found.' });
    try {
      const session = await proposalDescriptionEdit.readEditable(pool, id, req.user.id);
      if (!session) return res.status(404).json({ error: 'Change not found or no longer editable.' });
      return res.json(proposalDescriptionEdit.snapshot(session));
    } catch (err) {
      log.warn('sessions', 'Description read failed', { sessionId: id, message: err.message });
      return res.status(500).json({ error: 'Could not load the description.' });
    }
  });

  router.patch('/api/sessions/:id/description', drainGuard, async (req, res) => {
    const id = /^[1-9]\d{0,9}$/.test(String(req.params.id)) ? Number(req.params.id) : 0;
    if (!id || id > 2147483647) return res.status(404).json({ error: 'Change not found.' });
    let input;
    try { input = proposalDescriptionEdit.parseEdit(req.body); }
    catch (err) { return res.status(400).json({ error: 'invalid_request', message: err.message }); }
    try {
      const result = await proposalDescriptionEdit.edit({ pool, sessionId: id, userId: req.user.id, input });
      if (result.status === 200) {
        try {
          require('../services/ws').pushSessionUpdate({
            action: 'description_updated', sessionId: id,
            appId: result.session.app_id, appSlug: result.session.app_slug,
          });
        } catch (err) {
          log.warn('sessions', 'Description broadcast failed', { sessionId: id, message: err.message });
        }
      }
      return res.status(result.status).json(result.body);
    } catch (err) {
      log.warn('sessions', 'Description edit failed', { sessionId: id, message: err.message });
      return res.status(500).json({ error: 'Could not save the description. Your draft has been kept.' });
    }
  });

  // PATCH /api/sessions/:id/linked-issues (#2028)
  //
  // A proposal's issue links used to be writable only as a side effect of
  // creating it or dispatching another coding turn. This is the direct seam
  // used by the React proposal detail and the hosted connector after the
  // proposal/PR already exists.
  //
  // Owner-scoped for automated callers, with the platform's full write admin
  // as the browser/API repair hatch. A connector token can belong to an
  // admin too, so `connectorClientId` keeps that stronger privilege out of
  // this narrowly delegated tool.
  // The app-level collab gate above runs first; the 404 below deliberately
  // hides whether a foreign proposal id exists. Deltas preserve links added
  // by another tab/agent after the caller last read the proposal, and removal
  // wins when a number is present in both arrays.
  router.patch('/api/sessions/:id/linked-issues', drainGuard, async (req, res) => {
    const sessionId = /^[1-9]\d{0,9}$/.test(String(req.params.id || ''))
      ? Number(req.params.id) : null;
    if (!sessionId || sessionId > 2147483647) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'invalid_request', message: 'Body must be an object.' });
    }
    const unsupported = Object.keys(body).filter((key) => !['addIssues', 'removeIssues'].includes(key));
    if (unsupported.length) {
      return res.status(400).json({
        error: 'invalid_request', message: `Unsupported field: ${unsupported[0]}.`,
      });
    }
    const parseNumbers = (value, label) => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 50) {
        throw new Error(`${label} must be an array of at most 50 issue numbers.`);
      }
      const unique = [];
      for (const raw of value) {
        if (!Number.isSafeInteger(raw) || raw <= 0 || raw > 2147483647) {
          throw new Error(`${label} must contain positive integers up to 2147483647.`);
        }
        if (!unique.includes(raw)) unique.push(raw);
      }
      return unique;
    };

    let addIssues;
    let removeIssues;
    try {
      addIssues = parseNumbers(body.addIssues, 'addIssues');
      removeIssues = parseNumbers(body.removeIssues, 'removeIssues');
    } catch (err) {
      return res.status(400).json({ error: 'invalid_request', message: err.message });
    }
    if (!addIssues.length && !removeIssues.length) {
      return res.status(400).json({
        error: 'invalid_request', message: 'Add or remove at least one issue number.',
      });
    }

    try {
      // Serialize against submit_work's proposal update too: both can project
      // metadata into the same live PR body, and the later GitHub write must
      // never restore the earlier one's stale closing block.
      const outcome = await proposalUpdate.withProposalLock(pool, sessionId, async () => {
        const { rows } = await pool.query(
          `SELECT cs.*, a.slug AS app_slug, a.repo_url
             FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
            WHERE cs.id = $1`,
          [sessionId]
        );
        const session = rows[0] || null;
        const owner = session && Number(session.user_id) === Number(req.user.id);
        const browserAdmin = session && !req.connectorClientId && req.user.canAdminWrite;
        if (!session || (!owner && !browserAdmin)) {
          return { response: { status: 404, body: { error: 'Session not found' } } };
        }

        const nextLinks = prMetadata.applyIssueDeclarations(
          session.linked_issues, addIssues, removeIssues
        );
        if (nextLinks.length > 50) {
          return { response: { status: 400, body: {
            error: 'invalid_request', message: 'A proposal can link at most 50 issues.',
          } } };
        }
        // On GitHub for the platform repository the body is a conductor's
        // to write (services/pr-sync-operation.js), and it takes this lock
        // itself: the links are stored here, the body asked for below.
        if (prSync.onConductor(session.repo_url)) {
          const stored = await proposalUpdate.storeLinkedIssues({ pool, session, addIssues, removeIssues });
          const skipped = proposalUpdate.linkedIssuesSkipped(session);
          return {
            session,
            result: { ...stored, prBodyUpdated: false, prBodyStatus: skipped || 'no_pr' },
            project: !skipped,
            admin: !owner,
          };
        }
        const repo = repoRef.ownerRepo(session.repo_url);
        const result = await proposalUpdate.updateLinkedIssues({
          pool,
          gh: github,
          session,
          owner: repo && repo.owner,
          repo: repo && repo.repo,
          addIssues,
          removeIssues,
        });
        return { session, result };
      });

      if (outcome.response) {
        return res.status(outcome.response.status).json(outcome.response.body);
      }
      const { session, result } = outcome;
      if (outcome.project) {
        const projected = await prSync.ask({
          appId: session.app_id, userId: req.user.id, sessionId, write: 'issues',
          addIssues, removeIssues, ...(outcome.admin ? { admin: true } : {}),
        });
        if (projected.ok) {
          result.prBodyUpdated = !!projected.prBodyUpdated;
          result.prBodyStatus = projected.prBodyStatus || 'github_unavailable';
        } else {
          // The links are stored; the body is still owed, as when GitHub
          // could not take it, and asking again with the same deltas makes it.
          result.prBodyStatus = 'github_unavailable';
          log.warn('sessions', 'Linked issues stored; the pull request body was not updated', {
            sessionId, status: projected.status || null, error: projected.error || null,
          });
        }
      }

      if (result.changed) {
        try {
          const { pushIssueUpdate } = require('../services/ws');
          pushIssueUpdate({
            action: 'updated', source: 'linked_issues', sessionId,
            appId: session.app_id, appSlug: session.app_slug,
          });
        } catch (err) {
          log.warn('sessions', 'linked-issues broadcast failed', {
            sessionId, err: err.message,
          });
        }
      }
      return res.json({
        ok: true,
        proposalId: sessionId,
        appSlug: session.app_slug,
        linkedIssues: result.linkedIssues,
        addedIssues: result.addedIssues,
        removedIssues: result.removedIssues,
        changed: result.changed,
        prBodyUpdated: result.prBodyUpdated,
        prBodyStatus: result.prBodyStatus,
      });
    } catch (err) {
      log.error('sessions', 'Failed to update linked issues', { sessionId, message: err.message });
      return res.status(500).json({ error: 'Could not update linked issues' });
    }
  });

  // PATCH /api/sessions/:id/title (#2327)
  //
  // Rename the author's own native change throughout its open lifecycle:
  // Underway (active/paused) and In review (promoted/merging). The
  // display title and proposed PR title move together: before a PR exists,
  // `proposed_pr_title` is what pr-metadata will use when it creates one;
  // after a managed PR exists, the local proposal title moves immediately
  // and GitHub is a best-effort mirror. Imported PR titles stay with their
  // external author, and headless rows (unattended runs of the past, bench
  // previews) are not renamed.
  //
  // The app-level collab gate above runs first. The UPDATE repeats the
  // narrower author/lifecycle/source checks atomically and returns the same
  // 404 for every miss so a foreign private session cannot be enumerated.
  router.patch('/api/sessions/:id/title', drainGuard, async (req, res) => {
    const sessionId = /^[1-9]\d{0,9}$/.test(String(req.params.id || ''))
      ? Number(req.params.id) : null;
    if (!sessionId || sessionId > 2147483647) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const rawTitle = req.body?.title;
    const title = typeof rawTitle === 'string'
      ? rawTitle.replace(/\s+/g, ' ').trim()
      : '';
    if (!title) return res.status(400).json({ error: 'Title required' });
    if (title.length > MANUAL_SESSION_TITLE_MAX) {
      return res.status(400).json({
        error: `Title too long (max ${MANUAL_SESSION_TITLE_MAX} chars)`,
      });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE chat_sessions cs
            SET session_title = $1::text,
                proposed_pr_title = $1::text,
                pr_title = CASE WHEN cs.pr_number IS NULL THEN cs.pr_title ELSE $1::text END,
                pr_title_fallback = CASE
                  WHEN cs.pr_number IS NULL THEN cs.pr_title_fallback ELSE FALSE END
           FROM apps a
          WHERE cs.id = $2 AND cs.user_id = $3 AND a.id = cs.app_id
            AND cs.status IN ('active', 'paused', 'promoted', 'merging')
            AND cs.is_headless = FALSE
            AND cs.source IS DISTINCT FROM 'imported'
          RETURNING cs.id, cs.app_id, a.slug AS app_slug, a.repo_url,
                    cs.pr_number, cs.pr_title, cs.session_title,
                    cs.proposed_pr_title`,
        [title, sessionId, req.user.id]
      );
      const session = rows[0];
      if (!session) return res.status(404).json({ error: 'Session not found' });

      let githubUpdated = false;
      if (session.pr_number && prSync.onConductor(session.repo_url)) {
        // GitHub's copy of the platform repository's pull request is a
        // conductor's to write (services/pr-sync-operation.js), from the
        // title stored above; it says whether GitHub took it.
        const renamed = await prSync.ask({ appId: session.app_id, userId: req.user.id, sessionId, write: 'title' });
        githubUpdated = renamed.ok === true && renamed.githubUpdated === true;
        if (!renamed.ok) {
          log.warn('sessions', 'Proposal title saved; its GitHub rename was not made', {
            sessionId, prNumber: session.pr_number, status: renamed.status || null, error: renamed.error || null,
          });
        }
      } else if (session.pr_number) {
        const fullRepo = proposalUpdate.repoNameFromUrl(session.repo_url);
        if (fullRepo) {
          const [owner, repo] = fullRepo.split('/');
          try {
            await github.updatePR(owner, repo, Number(session.pr_number), { title });
            githubUpdated = true;
          } catch (err) {
            // The panel already has the author's rename. GitHub is a
            // cosmetic mirror and a transient outage must not roll it back.
            log.warn('sessions', 'Proposal title saved but GitHub rename failed', {
              sessionId, prNumber: session.pr_number, message: err.message,
            });
          }
        }
      }

      try {
        const { pushSessionUpdate } = require('../services/ws');
        pushSessionUpdate({
          action: 'titled', sessionId, appId: session.app_id,
          appSlug: session.app_slug, sessionTitle: title,
        });
      } catch (err) {
        log.warn('sessions', 'Proposal title broadcast failed', {
          sessionId, message: err.message,
        });
      }

      return res.json({
        ok: true,
        proposalId: sessionId,
        title,
        prTitle: session.pr_number ? title : null,
        githubUpdated,
      });
    } catch (err) {
      log.error('sessions', 'Proposal title update failed', {
        sessionId, message: err.message,
      });
      return res.status(500).json({ error: 'Could not update the title' });
    }
  });

  // GET /api/me/active-sessions
  //   Cross-app view of the current user's non-archived sessions,
  //   each annotated with whether a CC turn is in flight right now.
  //   Read by the Dev board's In progress area (the viewer's own cards)
  //   and by the Improve rows in Messages and the bell.
  //
  //   "busy" comes from the same in-process state the per-session
  //   /status endpoint uses: activeWorkers (chat handler's in-flight
  //   window) OR worker.isInFlight (warm-registry exec flag). The
  //   container-status fallback is intentionally NOT used here, for
  //   the same warm-CC reason described in /api/sessions/:id/status.
  //
  //   The result includes paused sessions too: they are still the
  //   viewer's work in progress.
  //
  //   "totals" lets the caller render the (x/y) header without a
  //   second pass through the array:
  //     - active   = 'active'-status sessions only — the set counting
  //                  against the per-user slot cap (#193). Promoted
  //                  sessions no longer count (they're un-pausable while
  //                  their PR is up for vote).
  //     - promoted = 'promoted'-status sessions (PR in a merge vote;
  //                  violet in the UI, exempt from the per-user cap)
  //     - paused   = paused-status sessions (no warm worker)
  //     - busy     = subset of active+promoted where CC is mid-turn right now
  //     - total    = active + promoted + paused (every non-archived row
  //                  we returned)
  //
  //   #6042: a caller that opts in with include_merged=1 ALSO receives
  //   merging/merged rows (bounded to the recent window in the WHERE), and
  //   those count none of active/promoted/paused — a merged change holds no
  //   slot — while `total` stays every row returned. The only opt-in caller
  //   was the Improve controller, whose rows showed the change's lifecycle,
  //   until Messages' Agents section went (16 Nov 2026); no screen sends it
  //   now, and the dev tab's fetch sends no flag.
  //   "caps" carries the DENOMINATORS for that header — the viewer's own
  //   effective per-user ceilings ({ activeSessions, promotedSessions }),
  //   which are higher for full platform admins (services/session-caps.js).
  //   The client used to hardcode "/3", which silently lied the moment an
  //   operator retuned MAX_USER_SESSIONS; shipping the real numbers here
  //   keeps display and enforcement from drifting. Always present, incl.
  //   on the ?demo=1 path.
  router.get('/api/me/active-sessions', async (req, res) => {
    try {
      await require('../services/staging-review-session').ensure(pool, config, req.user);
      // Imported PRs have no worker of their own. Keep them out of callers that
      // use this endpoint as a cross-app worker/session list; the Dev board
      // opts in so it can render the owner's imported In-progress cards.
      const includeImported = req.query.include_imported === '1';
      // #5379: source='settings' rows are the manifest proposals the platform
      // writes itself (rename, visibility, governance, admins, secret-declare,
      // who-decides, topics). No agent conversation backs them, so the agent
      // lists leave them out by default; the connector's proposal views opt
      // back in with include_settings=1, alongside include_imported above.
      const includeSettings = req.query.include_settings === '1';
      // #6042: merged and merging changes ride along so a change's row can
      // say Live instead of vanishing the moment its change merges. Bounded
      // to the recent window in the WHERE clause (seven days, the week
      // Messages' Agents list showed while it listed changes), and never
      // counted against the viewer's session caps — see the totals reducer
      // below. The dev tab's own fetch sends no flag and sees none.
      const includeMerged = req.query.include_merged === '1';
      // #6410: a plan a person posted is a planning record with no branch
      // (request-specs.js), not a conversation with an agent. No agent runs
      // in it, so it is not an agent chat and holds no slot; the plan is on
      // its request's page. Once a build gives it a branch it is real work
      // and lists as usual. The WHERE carries the shared definition below,
      // the same rule the other session reads use.
      // last_activity_at = the newest message in the session's thread,
      // falling back to the session's own creation time. The dev tab's
      // card list sorts session rows by this ("most recent activity"),
      // not by creation order.
      //
      // The app's artwork rides along for the Improve panel's leading tile.
      // NOT `a.icon_url` — no such column: the table stores `icon_image_id`
      // and the server builds the path, as routes/apps.js does. And the note
      // is here rather than a `--` comment in the query, which reaches
      // scripts/check-sql.js as one flattened line that eats the statement.
      //
      // `source` is carried so a caller can tell where a proposal's head lives
      // (#1054) — an imported pull request usually follows a branch in its
      // author's own fork, everything else a branch only the platform can
      // write — without a second read per row. `imported_pr_head_repo` and
      // `a.repo_url` are carried with it because "usually" is not good enough
      // (#1196): the connector's mirror rung imports a pull request whose head
      // is a branch in the APP repository, and only comparing the two repos
      // separates that from a genuine fork.
      const { rows } = await pool.query(
        `SELECT cs.id, cs.user_id, cs.branch_name, cs.pr_number, cs.pr_url, cs.pr_title,
                cs.session_title, cs.proposed_pr_title, cs.status, cs.linked_issues, cs.shared_at,
                cs.created_at, cs.source,
                cs.staging_url, cs.imported_pr_author, cs.imported_pr_head_repo,
                cs.imported_pr_head_sha, cs.reviewed_head_sha, a.repo_url,
                cs.check_state, cs.check_phase, cs.check_error_detail,
                -- #6793: only what this list reads. The checks that did not
                -- pass, and only for a failing run (summarizeFailingChecks);
                -- the plan, only where sessionAwaitsInput would read it.
                CASE WHEN cs.check_state = 'failing' AND jsonb_typeof(cs.test_results) = 'array'
                     THEN (SELECT COALESCE(jsonb_agg(e.v ORDER BY e.n)
                                    FILTER (WHERE (e.v->>'status' = 'pass') IS NOT TRUE), '[]'::jsonb)
                             FROM jsonb_array_elements(cs.test_results) WITH ORDINALITY AS e(v, n))
                     ELSE '[]'::jsonb END AS failing_results,
                CASE WHEN lt.role = 'assistant' AND lt.asks IS NOT TRUE AND cs.pr_number IS NULL
                     THEN cs.spec_md END AS spec_md,
                cs.agent_backend, cs.agent_model, cs.external_agent, cs.build_venue,
                GREATEST(cs.created_at, COALESCE(m.last_message_at, cs.created_at)) AS last_activity_at,
                lt.role AS last_turn_role, lt.asks AS last_turn_asks,
                a.slug AS app_slug, a.name AS app_name,
                a.icon_emoji AS app_icon_emoji,
                CASE WHEN a.icon_image_id IS NOT NULL
                     THEN '/app-icons/' || a.icon_image_id END AS app_icon_url,
                -- Worked on by any process (session-work.ts workedOnSql).
                ${workedOnSql()} AS worked_on
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         LEFT JOIN LATERAL (
           SELECT MAX(created_at) AS last_message_at
           FROM chat_session_messages
           WHERE session_id = cs.id
         ) m ON TRUE
         LEFT JOIN LATERAL (
           SELECT role,
                  jsonb_array_length(COALESCE(metadata->'suggestions', '[]'::jsonb)) > 0 AS asks
           FROM chat_session_messages
           WHERE session_id = cs.id AND role IN ('user', 'assistant')
           ORDER BY id DESC
           LIMIT 1
         ) lt ON TRUE
         WHERE cs.user_id = $1
           AND (cs.status IN ('active', 'promoted', 'paused')
                -- #6042: the recent merge history, for the Live pill — see
                -- includeMerged above.
                OR ($4::boolean AND cs.status IN ('merging', 'merged')
                    AND COALESCE(cs.merged_at, cs.created_at) >= now() - interval '7 days'))
           AND cs.is_headless = FALSE
           AND ($2::boolean OR cs.source IS DISTINCT FROM 'imported')
           AND ($3::boolean OR cs.source IS DISTINCT FROM 'settings')
           AND NOT ${planRecordSql('cs')}
         ORDER BY last_activity_at DESC`,
        [req.user.id, includeImported, includeSettings, includeMerged]
      );
      // #1196: the same login /api/sessions/:id carries, read once for the
      // whole list rather than per row. It is what makes "can you push this
      // proposal's head" the answer the update path will actually give.
      const viewerLogin = rows.some((s) => s.source === 'imported')
        ? (await require('../services/github-link').linkStatus(pool, req.user.id)).login || null
        : null;
      let sessions = rows.map((s) => {
        const live = workerProgress.get(s.id);
        // #1959: the three columns selected for sessionAwaitsInput stop here.
        // The verdict is one boolean; the spec body is the thing the per-app
        // list refuses to put in a list payload (#894), and the last-turn
        // pair is meaningless without the rule that reads it.
        const {
          spec_md: specMd, last_turn_role: lastTurnRole, last_turn_asks: lastTurnAsks, worked_on: workedOn, ...row
        } = s;
        return {
          ...row,
          ...(s.source === 'imported' ? { viewer_github_login: viewerLogin } : {}),
          busy: workedOn === true || isSessionBusy(s.id),
          awaiting_input: sessionAwaitsInput({
            lastTurnRole, lastTurnAsks, prNumber: s.pr_number, specMd,
          }),
          // Keep the pinned snake_case fields untouched. Camel-case fields
          // describe the runtime actually producing progress right now, so a
          // Codex-pinned session delegated to local Claude has an honest busy
          // tooltip without changing what its next platform turn will use.
          ...(live?.backend
            ? { agentBackend: live.backend, agentModel: live.model || null }
            : {}),
        };
      });
      sessions = await enrichImportedUnderwaySessions(pool, sessions, req.user.id, {
        results: listTestResults.resultsSelect(req, 'cs'),
      });
      // #6042: a merging or merged row holds no slot — the caps count work
      // that can be paused or withdrawn, and a merged change is neither —
      // so the reduce names them explicitly instead of letting the `else`
      // spend an `active` slot on them. `total` stays every row returned.
      const totals = sessions.reduce(
        (acc, s) => {
          if (s.status === 'paused') acc.paused += 1;
          else if (s.status === 'promoted') acc.promoted += 1;
          else if (s.status !== 'merging' && s.status !== 'merged') acc.active += 1;
          if (s.busy) acc.busy += 1;
          return acc;
        },
        { active: 0, promoted: 0, paused: 0, busy: 0 }
      );
      totals.total = sessions.length;
      // Staging-only demo row (?demo=1): a mock own session so the Dev
      // board's pinned block (caption + "Make visible" button) renders
      // for ANY viewer in a demo preview — the real seeded sessions
      // belong to the first admin only. Appended AFTER totals so the
      // "(x/y)" headers stay honest; fake 99xxxx id whose writes still 404
      // server-side. Its read-only detail projection exists so declared
      // checks can open the full change page without a console-erroring 404.
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        sessions.push(...stagingMockOwnSessions(req.user.id, config.selfAppSlug));
      }
      // #1417: the work the viewer has handed to a coding agent through the
      // connector, which is NOT in chat_sessions and never will be until the
      // agent shares or submits it. Carried on this endpoint rather than a
      // new one because the Improve panel already makes exactly one call
      // here, and a second round trip to say "and three of your own things
      // are also in flight" is a round trip the panel does not need.
      //
      // Deliberately NOT folded into `sessions`, and NOT counted in
      // `totals`: those numbers are the per-user session budget the caps
      // above are the denominators for, and a work order costs the platform
      // no worker, no container and no branch. Putting it there would report
      // a slot as spent that nobody can free by pausing anything.
      const externalTasks = await listOpenWorkOrders(pool, req.user.id);
      // Staging-only demo row (?demo=1), same convention as the mock
      // sessions above: external_agent_tasks is `staging:private`, so a
      // staging clone has NO rows at all and this list is empty for every
      // reviewer. Without a fixture the whole feature is unreviewable in a
      // preview and undeclarable as a check. Read-only and obviously fake.
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        externalTasks.push({
          id: 990201,
          issue_number: 900002,
          title: '[Mock] Work handed to a coding agent',
          branch_name: 'usernode/mock-issue-900002',
          agent: 'claude-code',
          // #5289: six minutes, between the mock sessions at five and eight,
          // so the row is inside the five Messages' agents list shows before
          // "N older chats" (at twelve it tied the fifth session for the
          // last slot) — the declared checks read it there.
          created_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
          app_slug: config.selfAppSlug,
          app_name: 'Homeroom',
          // The demo row carries an icon too, or the ONE work-order row a
          // preview can show is the one row whose tile falls back to a letter
          // — which is exactly the state a reviewer would read as the bug.
          app_icon_emoji: '\u{1F6E0}\u{FE0F}',
        });
      }
      // Per-viewer denominators for the "(x/y)" header — full admins get
      // the raised caps. Cheap (pure function on req.user, no query).
      // #1766: name the failing checks, and drop the raw results.
      //
      // The card could already say "Checks failing · 3"; it could not say
      // WHICH three, so the owner's only route to that was reading
      // test_results out of the API by hand. Meanwhile the coding agent has
      // been handed the full list, with reasons, in its prompt.
      //
      // Bounded on purpose: test_results holds a row per declared check (500+
      // today) and this endpoint is polled. summarizeFailingChecks caps the
      // rows and carries the totals separately, so the card can say "3 of 528
      // failing" and list the first few without the feed growing with the
      // manifest.
      //
      // IMPORTED rows keep the raw column, because they already had it:
      // enrichImportedUnderwaySessions has been sending it for them since
      // they became proposal-shaped, and me-active-sessions.test.js pins it.
      // Dropping it there would be a silent breaking change to an existing
      // contract in the name of a new one. Everything else selected it only
      // so this summary could be built, so it goes back off the wire.
      for (const row of sessions) {
        if (!row) continue;
        // #6793: summarised from the failing rows the query kept (with their
        // excerpts), which then go back off the wire.
        const summary = summarizeFailingChecks(row.check_state, row.failing_results);
        delete row.failing_results;
        if (row.source !== 'imported') delete row.test_results;
        if (summary.total) row.failing_checks = summary;
      }
      // `?results=failing` (services/list-test-results.js): the imported rows
      // above keep their raw results by contract; the shell's list form trims
      // those to the failures too.
      res.json({
        sessions: listTestResults.forListing(req, sessions),
        totals, externalTasks, caps: effectiveSessionCaps(config, req.user),
      });
    } catch (err) {
      log.error('sessions', 'Failed to list active sessions', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/me/session-state[?app=<slug>]
  //   #1038: the reconcile snapshot behind the live `session_state`
  //   WebSocket events. Every "we might have missed something" path on the
  //   client — WS reconnect, a tab returning to the foreground, the slow
  //   safety tick — funnels through this one endpoint, so there is a single
  //   place to reason about convergence.
  //
  //   Deliberately tiny: ids plus flags, no titles, no PR metadata. It
  //   replaces the fast-path role of /api/me/active-sessions +
  //   /shared-sessions + /github-issues for keeping spinners honest, and is
  //   cheap enough to call on every foreground.
  //
  //   Only NON-IDLE rows are returned (sessionState.isIdleState) — absence
  //   means idle. That is what lets the client clear a phantom spinner: it
  //   replaces its whole override set from this response rather than
  //   merging into it.
  //
  //   `bootId` is this platform process's start time. A client that sees a
  //   new value drops every override it holds, which is what unsticks the
  //   UI after a restart or a blue-green cutover (in-memory busy state does
  //   not survive either).
  //
  //   Scope mirrors the surfaces the state feeds:
  //     - always: the viewer's own non-archived sessions;
  //     - with ?app=<slug>, and only behind the same view-level gate
  //       /api/apps/:slug/shared-sessions uses: that app's explicitly
  //       shared sessions, which render on everyone's board.
  router.get('/api/me/session-state', async (req, res) => {
    try {
      const appSlug = typeof req.query.app === 'string' ? req.query.app : null;

      // One row per candidate session. Kept narrow on purpose: the live
      // predicate below decides what is actually reported, so this only has
      // to be a superset of "could plausibly be non-idle right now".
      const { rows: mine } = await pool.query(
        `SELECT cs.id, cs.status,
                (cs.shared_at IS NOT NULL) AS shared,
                cs.app_id, cs.user_id, a.slug AS app_slug
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
          WHERE cs.user_id = $1
            AND cs.status IN ('active', 'promoted', 'paused')`,
        [req.user.id]
      );

      let visible = [];
      if (appSlug) {
        // Same view-level gate as /api/apps/:slug/shared-sessions (#621):
        // shared rows are metadata-only, so a read-only viewer may see
        // them. A denied / unknown slug simply contributes nothing —
        // the viewer's own rows above are unaffected.
        const app = await appAccess.getAppForUser(
          pool, appSlug, req.user, 'view', appAccess.ACCESS_COLUMNS
        ).catch(() => null);
        if (app) {
          const { rows } = await pool.query(
            `SELECT cs.id, cs.status,
                    (cs.shared_at IS NOT NULL) AS shared,
                    cs.app_id, cs.user_id, a.slug AS app_slug
               FROM chat_sessions cs
               JOIN apps a ON a.id = cs.app_id
              WHERE cs.app_id = $1
                AND cs.status IN ('active', 'promoted', 'paused')
                AND cs.shared_at IS NOT NULL`,
            [app.id]
          );
          visible = rows;
        }
      }

      // Busy for every process: a turn another process runs is busy here
      // too (the workflow's records: session-work.ts workedOnSql). The phase
      // and a pending stop are this process's own to tell.
      const working = await busySessionsAnywhere([...mine, ...visible].map((r) => r.id), { pool });
      const byId = new Map();
      for (const row of [...mine, ...visible]) {
        if (byId.has(row.id)) continue;
        const live = sessionState.liveState(row.id);
        const payload = sessionState.buildPayload(
          row.id, row, { ...live, busy: live.busy || working.has(Number(row.id)) }
        );
        if (sessionState.isIdleState(payload)) continue;
        byId.set(row.id, {
          id: payload.sessionId,
          appSlug: payload.appSlug,
          // Whose session it is, so the Homeroom mark's working indicator
          // can count the viewer's own work only (SessionState.anyActiveFor).
          userId: payload.userId,
          busy: payload.busy,
          phase: payload.phase,
          stopping: payload.stopping,
          status: payload.status,
        });
      }

      const sessions = [...byId.values()];

      // Staging-only demo rows (?demo=1): the sibling endpoints seed mock
      // BUSY cards (the own-session spinner from /api/me/active-sessions,
      // the shared-session spinner from /shared-sessions). Those
      // ids have no in-memory state, so without this block the very first
      // reconcile would report them idle and wipe every demo spinner off
      // the board. Read-only, and a strict no-op in production.
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        sessions.push(
          {
            // The viewer's own mock busy session, so the demo's Homeroom
            // mark shows its working indicator (SessionState.anyActiveFor).
            id: 990102, appSlug: config.selfAppSlug, userId: req.user.id, busy: true, phase: 'cc',
            stopping: false, status: 'active',
          },
          {
            id: 990001, appSlug: config.selfAppSlug, busy: true, phase: 'cc',
            stopping: false, status: 'active',
          }
        );
      }

      res.json({ bootId: PROCESS_BOOT_ID, at: Date.now(), sessions });
    } catch (err) {
      log.error('sessions', 'Failed to build session-state snapshot', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List sessions for an app (user's own)
  router.get('/api/apps/:slug/sessions', async (req, res) => {
    try {
      // View-level (#621): the query below is owner-scoped, so a
      // read-only viewer just gets an empty list instead of a 404.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      const appRows = [app];
      await require('../services/staging-review-session').ensure(pool, config, req.user, { ...app, slug: req.params.slug });

      // agent_backend / agent_model / source / external_agent: the VENUE a
      // session is building in. Every one of these columns has existed for
      // as long as the feature that writes it, but no list payload carried
      // any of them, so every session card said the same thing no matter
      // where the turns actually ran — and a user whose OpenRouter default
      // had silently fallen back to Claude had no way to see it from the
      // board. Four scalars; no new endpoint, no new column.
      //
      // The pair matters as a pair: `source='imported'` and
      // `external_agent` are what let the card tell "this is building on
      // Homeroom" apart from "this arrived from somewhere else", which is
      // the distinction a bare agent_backend cannot make — an imported row
      // has a defaulted agent_backend that no turn ever ran through.
      const { rows } = await pool.query(
        `SELECT id, branch_name, pr_number, pr_url, pr_title, session_title, proposed_pr_title, staging_url, status, linked_issues, behind_main, shared_at, created_at,
                agent_backend, agent_model, source, external_agent, build_venue,
                -- The same derivation the shared-session list uses, so the
                -- owner's own card and everyone else's card agree about
                -- whether a slept preview can be woken. Without it
                -- _cardPreviewSpec fell back to pr_number, which is null for
                -- a share-only session and left the owner with no affordance
                -- at all once the idle GC nulled staging_url.
                -- #2069: and checks_commit_sha was the same kind of proxy,
                -- null for the same reason. A shared draft has no pull
                -- request AND no checks gate, so both halves were absent
                -- exactly where the comment above says the affordance is
                -- needed. shared_at asks about THIS session instead of a
                -- neighbouring subsystem: the share route verifies a pushed
                -- branch and stamps it at creation, so it is direct evidence
                -- that there is a commit to build.
                (pr_number IS NOT NULL OR checks_commit_sha IS NOT NULL
                   OR shared_at IS NOT NULL)
                  AS can_preview
         FROM chat_sessions
         WHERE app_id = $1 AND user_id = $2 AND is_headless = FALSE
           AND ($3::text IS NULL OR status = $3)
         ORDER BY created_at DESC`,
        // `?status=archived`: the Workshop reads this list only for its
        // "Show archived" rows, and a prolific author's whole history is
        // over a thousand merged rows it discarded on arrival (700 KB on
        // production). Only that one status is accepted; without it the
        // whole list is answered, as it always was.
        [appRows[0].id, req.user.id, req.query.status === 'archived' ? 'archived' : null]
      );

      // `?recent=N`: every session still under way, and only the N newest
      // finished (merged or archived) ones, with a count of the rest. The dev
      // chat's own list asks for it: a prolific author's history on the
      // platform app is over a thousand finished rows (1,015 merged and 97
      // archived, 693 KB on production), re-read on every open of a change
      // and every session event while it is on screen. "Show older" reads
      // the whole list again. Without the parameter it is answered whole.
      const recent = req.query.status === 'archived' ? null : recentFinishedLimit(req.query.recent);
      let listed = rows;
      let olderFinished = 0;
      if (recent) {
        let finished = 0;
        listed = rows.filter((s) => {
          if (!FINISHED_SESSION_STATUSES.has(s.status)) return true;
          finished += 1;
          return finished <= recent;
        });
        olderFinished = rows.length - listed.length;
      }

      // `warm` = a worker container currently exists for the session. The
      // session list uses it to decide whether a promoted row still has a
      // worker to free (and the create-session cap counts the same thing).
      const warmIds = new Set(worker.warmRegistrySnapshot().map((w) => w.sessionId));
      for (const s of listed) s.warm = warmIds.has(s.id);

      // Staging-only demo row (?demo=1): a mock archived session so the
      // "Show archived" toggle — the anchor the visible-sessions group
      // renders beneath — is present for any demo viewer. Same read-only
      // 99xxxx convention as the other mocks (Unarchive 404s server-side),
      // with an id of its own: 990104 is the chat-shared session mock.
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        listed.push({
          id: 990109, branch_name: 'mock/archived-session', pr_number: null,
          pr_url: null, pr_title: null,
          session_title: '[Mock] Archived session',
          staging_url: null, status: 'archived', linked_issues: [],
          behind_main: false, shared_at: null, has_spec: false,
          created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          warm: false,
        });
      }

      res.json({ sessions: listed, ...(recent ? { older_finished: olderFinished } : {}) });
    } catch (err) {
      log.error('sessions', 'Failed to list sessions', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/apps/:slug/shared-sessions
  //   Every user's explicitly-shared (shared_at IS NOT NULL) in-flight
  //   sessions on this app — the rows the Dev board renders at the
  //   bottom of everyone's "In progress" area. Ordinary sessions remain
  //   deliberately metadata-only: no pr_url / cc_session_id / anything
  //   that reaches the owner's private work, which stays owner-scoped by
  //   authorization, not just by missing UI. Imported PR rows are enriched after this privacy
  //   query with the proposal metadata that is already group-visible on
  //   promotion; their GitHub description/checks/attributes exist while
  //   Underway and should not disappear merely because voting has not begun.
  //   staging_url IS included (same exposure /promoted already grants
  //   proposals) so viewers get a Preview affordance,
  //   plus a derived can_preview boolean — "the branch has pushed
  //   changes" — so the card can offer an on-demand rebuild via
  //   ensure-staging even after the idle staging GC has nulled staging_url.
  //   PR number and URL are public GitHub metadata once the author shares a
  //   session. Keep the change's private work details scoped.
  //
  //   That boolean was `pr_number IS NOT NULL` (#689), which was a fine
  //   proxy while every shared session was a proposal in waiting. It is
  //   not one for a session shared with `share: true`: that lands in the
  //   in-progress area with a preview and NO pull request, so pr_number
  //   is null, can_preview was false, and the card offered nothing at all
  //   the moment the preview went to sleep — to its own author as much as
  //   to anyone else. Meanwhile POST /api/sessions/:id/ensure-staging has
  //   authorized exactly this case all along ("Explicitly-shared sessions
  //   … get the same member-wide access"): the server said yes and the
  //   affordance never asked.
  //
  //   checks_commit_sha is the durable half of the answer. It records the
  //   commit a checks run described, so it is only ever set once a real
  //   commit on this branch has been built — and unlike staging_url,
  //   staging_image_ref and staging_build_ref, teardownStaging does not
  //   clear it. It survives exactly the event that used to strand the
  //   card.
  //   chat_count / last_message_at mirror the /promoted subqueries: the
  //   discussion thread is the same chat_messages ('session', id) key
  //   the proposal card will inherit on promotion. linked_issues IS
  //   included — issue numbers are group-visible data (the issue list
  //   itself is view-level), and the card renders them as "#N" chips
  //   linking to each issue's in-app discussion.
  //   check_state / check_phase are the same review-state metadata the
  //   promoted feed exposes. They let an ordinary explicitly shared
  //   Underway card say that its preview is building, tests are running, or
  //   checks have finished without exposing the test result payload or
  //   error detail. Imported rows receive those full details in the scoped
  //   enrichment described above.
  router.get('/api/apps/:slug/shared-sessions', async (req, res) => {
    try {
      // View-level (#621): explicitly-shared rows are metadata-only by
      // design, so read-only viewers may see them.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const { rows } = await pool.query(
        `SELECT cs.id, cs.session_title, cs.pr_title, cs.pr_number, cs.pr_url,
                cs.branch_name, cs.status,
                cs.staging_url,
                -- #2069, as above: a shared draft has neither a pull request
                -- nor a checks run, and shared_at is the session's own
                -- evidence that a verified branch was pushed.
                (cs.pr_number IS NOT NULL OR cs.checks_commit_sha IS NOT NULL
                   OR cs.shared_at IS NOT NULL)
                  AS can_preview,
                cs.linked_issues, cs.source, cs.imported_pr_author,
                cs.agent_backend, cs.agent_model, cs.external_agent, cs.build_venue,
                cs.check_state, cs.check_phase,
                cs.user_id, COALESCE(u.username, 'Deleted user') AS username, cs.shared_at, cs.created_at,
                GREATEST(cs.created_at, COALESCE(m.last_message_at, cs.created_at)) AS last_activity_at,
                (SELECT COUNT(*)::int FROM chat_messages cm
                  WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id
                    AND cm.msg_type = 'message') AS chat_count,
                (SELECT MAX(cm.created_at) FROM chat_messages cm
                  WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id) AS last_message_at,
                -- Worked on by any process (session-work.ts workedOnSql).
                ${workedOnSql()} AS worked_on
         FROM chat_sessions cs
         LEFT JOIN users u ON u.id = cs.user_id
         LEFT JOIN LATERAL (
           SELECT MAX(created_at) AS last_message_at
           FROM chat_session_messages
           WHERE session_id = cs.id
         ) m ON TRUE
         WHERE cs.app_id = $1 AND cs.shared_at IS NOT NULL
           AND cs.status IN ('active', 'paused') AND cs.is_headless = FALSE
         ORDER BY cs.shared_at ASC`,
        [app.id]
      );
      let sessions = rows.map(({ worked_on: workedOn, ...s }) => ({
        ...s,
        busy: workedOn === true || isSessionBusy(s.id),
      }));
      sessions = await enrichImportedUnderwaySessions(pool, sessions, req.user?.id || null, {
        results: listTestResults.resultsSelect(req, 'cs'),
      });

      // Staging-only demo rows (?demo=1): read-only visual states a boot
      // seed can't hold live (busy spinner, Preview pill). Fake ids in the
      // 99xxxx range and user_id 0 so they can never collide with the
      // viewer or a real session; opening their discussion just shows an
      // empty thread (validateThread rejects posts on nonexistent rows).
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        sessions.push(...stagingMockSharedSessions());
      }

      // `?results=failing`: the shell's list form (services/list-test-results.js).
      res.json({ sessions: listTestResults.forListing(req, sessions) });
    } catch (err) {
      log.error('sessions', 'Failed to list shared sessions', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #6284: a person lets the Homeroom bot try once more at a change it
  // stopped fixing on its own. The requester or an admin may; one grant buys
  // exactly one more round.
  router.post('/api/apps/:slug/changes/:id/let-it-try-again', drainGuard, communities.requireSessionMembership(pool), sameOriginBrowserOnly, async (req, res) => {
    const id = /^[1-9]\d{0,9}$/.test(String(req.params.id)) ? Number(req.params.id) : 0;
    if (!id) return res.status(404).json({ error: 'Change not found' });
    try {
      const { rows } = await pool.query(
        `SELECT cs.id FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
          WHERE cs.id = $1 AND a.slug = $2`,
        [id, req.params.slug],
      );
      if (!rows.length) return res.status(404).json({ error: 'Change not found' });
      const grants = require('../services/homeroom-bot-retry-grants');
      const out = await grants.grant(pool, { sessionId: id, user: req.user });
      if (!out.ok) {
        if (out.why === 'not_allowed') return res.status(403).json({ error: 'not_allowed' });
        // #6776: the sentence says what is true: already queued and where,
        // queued again, or why it cannot be.
        return res.status(409).json({ error: grants.grantRefusalText(out.why, out), why: out.why });
      }
      return res.json({ granted: true, requeued: !!out.requeued, said: grants.grantDoneText(out) });
    } catch (err) {
      log.error('sessions', 'Could not let the bot try again', { message: err.message });
      return res.status(500).json({ error: 'Could not let it try again' });
    }
  });

  // Check results are fetched on demand, separately from the private
  // transcript and the lightweight board feed. The app view gate above still
  // applies; sharing a session exposes these results, never its messages.
  router.get(['/api/sessions/:id/checks', '/api/sessions/:id/details'], async (req, res) => {
    try {
      if (req.path.endsWith('/details') && process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        const mock = stagingMockSharedSessions().find((s) => s.id === Number(req.params.id))
          || stagingMockOwnSessions(req.user.id, config.selfAppSlug).find((s) => s.id === Number(req.params.id));
        if (mock) {
          return res.set('Cache-Control', 'no-store').json({
            session: { ...mock, checks_estimate: require('../services/checks-estimate').DEMO_ESTIMATE },
          });
        }
      }
      const { rows } = await pool.query(
        `SELECT cs.id, cs.user_id, cs.status, cs.shared_at, cs.session_title, cs.pr_title,
                cs.check_state, cs.check_phase, cs.check_trigger,
                cs.check_error_detail, cs.checks_checked_at, cs.checks_commit_sha,
                cs.checks_progress, cs.test_results, cs.checks_base_sha,
                cs.checks_base_verdict, cs.checks_base_behind_by,
                cs.source, cs.imported_pr_head_sha, cs.reviewed_head_sha,
                cs.shots_state, cs.shots_run_id,
                cs.shots_detail, cs.shots_updated_at,
                cs.close_reason,
                cs.app_id, a.slug AS app_slug
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
          WHERE cs.id = $1`,
        [parseInt(req.params.id, 10)]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const session = rows[0];
      if (!canViewSession(session, req.user)) return res.status(404).json({ error: 'Session not found' });
      const detail = req.path.endsWith('/details')
        ? (await enrichImportedUnderwaySessions(pool, [session], req.user.id, { all: true }))[0]
        : session;
      if (req.path.endsWith('/details')) {
        detail.busy = await isSessionBusyAnywhere(Number(session.id), { pool });
        // #2371: the author reviews a change before submitting it, and before
        // then its only description is the spec. Read separately and only for
        // the owner of an underway change, so the shared projection above
        // never carries it (#894).
        if (session.user_id === req.user.id && ['active', 'paused'].includes(session.status)) {
          const { rows: specs } = await pool.query('SELECT spec_md FROM chat_sessions WHERE id = $1', [session.id]);
          detail.spec_md = specs[0]?.spec_md || null;
        }
        detail.plan = await changePlanFor(pool, session.id, session.user_id, req.user.id).catch(() => null);
        if (detail.source === 'cli_handoff') {
          const { rows: handoffs } = await pool.query(`SELECT handoff_head_sha, handoff_uploaded_sha, handoff_upload_checked_sha, handoff_base_sha FROM chat_sessions WHERE id = $1`, [session.id]);
          const proposal = require('./proposal-handoff').publicSessionStatus({ ...detail, ...handoffs[0] });
          detail.proposal_state = proposal.revisionState || proposal.state;
        }
        detail.shots = config.shots?.present
          ? await require('../services/shots-view')
            .getForSession(pool, detail, detail.app_slug, { viewer: req.user })
          : null;
        // An update from this version's original, as the proposal read
        // carries it (services/upstream-offers.js changeView); null otherwise.
        detail.upstream = await require('../services/upstream-offers').changeView(pool, session.id);
      }
      // #6122: both reads a pending run is shown through carry the usual
      // time (the checks panel reads /checks; the change page reads /details,
      // which keeps its estimate whether or not a run is pending).
      if (req.path.endsWith('/details') || session.check_state === 'pending') {
        detail.checks_estimate = await require('../services/checks-estimate').forApp(pool, session.app_id);
      }
      // #6234: Homeroom bot fixing its own change's failing checks, for the
      // change page's Testing card (services/homeroom-bot-progress.js
      // changeBotFix); null for any change of a person's.
      if (req.path.endsWith('/details')) {
        detail.bot_fix = await require('../services/homeroom-bot-progress')
          .changeBotFix(pool, session.id, { viewer: req.user }).catch(() => null);
        // #6116: what it has cost so far at list price, for its author or an
        // admin only (services/session-cost.js).
        detail.cost_total_cents = await sessionCost.sessionCostForViewer(pool, session, req.user);
      }
      // `?results=failing`: the change page's own read, which lists passing
      // checks only when their fold is opened (services/list-test-results.js).
      res.set('Cache-Control', 'no-store').json({ session: listTestResults.forItem(req, detail) });
    } catch (err) {
      log.error('sessions', 'Failed to read check results', { message: err.message });
      res.status(500).json({ error: 'Could not load check results' });
    }
  });

  // A failed run's checks in plain words (services/checks-explanation.js),
  // for the Testing card on the change's page and the top of its Checks
  // step. Read by the same rule as the check results it is written from
  // (the route above): whoever may read those may read this. `lang` is the
  // language the page is showing. `explanation` is null when there is none
  // to give, and the page keeps the failure's own words. A staging ?demo=1
  // mock carries its own, so the page can be reviewed without a model.
  router.get('/api/sessions/:id/checks-explanation', async (req, res) => {
    const id = /^[1-9]\d{0,9}$/.test(String(req.params.id)) ? Number(req.params.id) : 0;
    if (!id || id > 2147483647) return res.status(404).json({ error: 'Session not found' });
    try {
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        const mock = stagingMockSharedSessions().find((s) => s.id === id)
          || stagingMockOwnSessions(req.user.id, config.selfAppSlug).find((s) => s.id === id)
          || require('./votes').stagingMockProposalFor(id, req.user);
        if (mock) {
          return res.set('Cache-Control', 'no-store')
            .json({ explanation: mock.checks_explanation || null, runAt: mock.checks_checked_at || null });
        }
      }
      const { rows } = await pool.query(
        `SELECT id, user_id, status, shared_at, app_id, check_state, checks_checked_at, test_results
           FROM chat_sessions
          WHERE id = $1`,
        [id]
      );
      const session = rows[0];
      if (!session || !canViewSession(session, req.user)) return res.status(404).json({ error: 'Session not found' });
      // #6288: what main is already failing, so the sentence does not blame
      // this change for a test that fails on main through no fault of its
      // own. The same verdict the change page's Testing card reads.
      const main = await require('../services/main-watch').mergePause(pool, session.app_id);
      const explanation = await require('../services/checks-explanation')
        .explain(pool, session, { language: req.query.lang || (req.user && req.user.locale), main });
      return res.set('Cache-Control', 'no-store').json({ explanation, runAt: session.checks_checked_at });
    } catch (err) {
      log.error('sessions', 'Failed to explain failing checks', { message: err.message });
      return res.status(500).json({ error: 'Could not explain the failing checks' });
    }
  });

  // Get session with message history
  //
  // Owner OR admin. The app-level `sessionCollabGuard` above already ran.
  // Read-only, so plain `isAdmin` is the gate — a view-only admin qualifies.
  //
  // Concretely this is what made a fifth of the declared proposal checks
  // fail: the check suite signs as `usernode-capture-admin` (a view-only
  // admin), every staging chat_sessions fixture is owned by the FIRST
  // admin instead, and each deep link into one 404'd — a console error on
  // the route, which fails the check whatever it was asserting.
  router.get('/api/sessions/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                    AND ${countedVotePredicateSql('pv', 'cs')}) AS yes_count,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'no'
                    AND ${countedVotePredicateSql('pv', 'cs')}) AS no_count,
                -- The member floor (services/governance.js applyNoTimerMerge):
                -- Yes votes from someone other than the author, read only for
                -- a proposal flagged for explicit approval.
                CASE WHEN cs.requires_explicit_approval THEN
                  (SELECT COUNT(*)::int FROM pr_votes pv
                    WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                      AND pv.user_id IS DISTINCT FROM cs.user_id
                      AND ${countedVotePredicateSql('pv', 'cs')})
                END AS other_yes_count,
                -- #1258: the upstream commit this proposal's branch started
                -- from. It is not a column on the session — it lives on the
                -- job that produced the branch — and a coding agent that
                -- arrives on a branch somebody else cut has no other way to
                -- learn it. Without it, a wrong base is caught at submit_work
                -- as base_mismatch, after the change is written.
                --
                -- Two producers, in preference order: the connector's
                -- external_agent_tasks row, then the guided hand-off's own
                -- column. Earliest task wins — a proposal revised through a
                -- second task is still diffed against the base its branch was
                -- originally cut from, which is the number the group votes on.
                --
                -- external_agent_tasks is staging:private, so this reads NULL
                -- on a staging clone. That is the honest answer there, and the
                -- connector reports it as null rather than guessing.
                COALESCE(
                  (SELECT t.base_sha FROM external_agent_tasks t
                    WHERE t.session_id = cs.id
                    ORDER BY t.created_at, t.id
                    LIMIT 1),
                  cs.handoff_base_sha
                ) AS base_sha,
                -- When the merge queue tries this change again after GitHub
                -- held its merge back (services/integration.js HELD_UNTIL_SQL).
                ${require('../services/integration').HELD_UNTIL_SQL} AS merge_held_until,
                -- #6563: when Homeroom last tried it, and first met this hold.
                ${require('../services/integration').HELD_AT_SQL} AS merge_held_at,
                ${require('../services/integration').HELD_SINCE_SQL} AS merge_held_since
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND (cs.user_id = $2 OR $3::boolean)`,
        [req.params.id, req.user.id, !!req.user?.isAdmin]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });

      // #1196: whether this caller can push the proposal's head is not a
      // property of the row on its own. For a head that lives in somebody's
      // fork it is the comparison services/proposal-update.js's
      // `advanceForkHead` makes when a revision arrives — that fork's owner
      // against the GitHub account linked to the CALLER's profile — so the
      // login is carried here and readers report what submit_work will
      // actually do instead of approximating it. Imported rows only: a native
      // proposal's head is a branch in the app repository by definition, and
      // nobody can push that.
      if (rows[0].source === 'imported') {
        const link = await require('../services/github-link').linkStatus(pool, req.user.id);
        rows[0].viewer_github_login = link && link.linked ? link.login : null;
      }

      // #405: the session view's merge-lifecycle pill needs the vote tally to
      // resolve the In-vote / "Passed — merging shortly" states exactly as
      // the proposal feed card does. yes_count/no_count come from the query
      // above; majority is the app's live active-user threshold. Best-effort
      // — a stats hiccup just leaves the pill on the tally-free states.
      try {
        const stats = await getActiveUserStats(pool, rows[0].app_id);
        rows[0].majority = stats?.majority || 1;
        rows[0].active_users = stats?.active || 1;
      } catch { rows[0].majority = rows[0].majority || 1; }

      // #695: governance-aware gate fields, mirroring /promoted, so the
      // session header pill resolves In-vote / "Passed — merging shortly"
      // from the QUALIFYING tally (approver votes only under
      // approver_policy='invited') instead of the raw all-voters counts.
      // Raw yes_count/no_count stay in the payload — the FE derives the
      // advisory (non-approver) surplus as raw − qualified. Best-effort,
      // same as the stats block above.
      if (['promoted', 'merging', 'merged'].includes(rows[0].status)) {
        try {
          const governanceSvc = require('../services/governance');
          const gov = await governanceSvc.getGovernance(pool, rows[0].app_id);
          const electorate = await governanceSvc.getElectorate(pool, rows[0].app_id, gov);
          // #788: a flagged proposal has no merge clock and waits for a Yes
          // from someone other than its author, so the header pill says
          // that rather than "merging shortly".
          const flagged = !!rows[0].requires_explicit_approval;
          rows[0].first_version = await require('../services/first-version-rule').isFirstVersion(pool, rows[0].id);
          const q = electorate.approverIds
            ? await governanceSvc.qualifiedCounts(
              pool, 'pr', rows[0].id, electorate.approverIds,
              flagged ? { authorId: rows[0].user_id ?? null } : undefined
            )
            : { yes: rows[0].yes_count, no: rows[0].no_count, otherYes: rows[0].other_yes_count };
          const gate = governanceSvc.computeGate(
            gov, electorate.active, q.yes, q.no, rows[0].promoted_at || rows[0].created_at, null,
            {
              explicitApproval: flagged,
              otherYes: q.otherYes,
              memberCount: flagged
                ? await governanceSvc.communityMemberCount(pool, rows[0].app_id) : undefined,
              // #4666: who voted, on a project with rules of its own.
              ...(gov.rules ? governanceSvc.rulesGateOpts(
                await governanceSvc.rulesContext(pool, rows[0].app_id, gov, 'pr', [rows[0].id]),
                rows[0].id, rows[0].user_id ?? null, rows[0].explicit_approval_reason || null
              ) : {}),
              // 13 Oct 2026, D1: a project's first version needs no vote.
              firstVersion: rows[0].first_version,
            }
          );
          rows[0].votes_required = gate.required;
          rows[0].merge_window_ends_at = gate.windowEndsAt;
          rows[0].approval_policy = gate.policy;
          rows[0].approvals_required = gate.approvalsRequired;
          rows[0].qualified_yes_count = gate.qualifiedYes;
          rows[0].qualified_no_count = gate.qualifiedNo;
          Object.assign(rows[0], governanceSvc.explicitApprovalRowFields(rows[0], gate));
          if (gate.mode === 'rules') Object.assign(rows[0], governanceSvc.ruleRowFields(gate));
        } catch { /* pill falls back to the raw tallies */ }
        // B10a: a project that is just you reads "Waiting for your approval"
        // where a group's reads "Waiting for approval" (MergeStatus.lifecycle).
        try {
          const membership = await communities.getMembership(pool, { id: rows[0].app_id }, req.user.id);
          rows[0].app_audience = membership ? membership.audience : null;
        } catch { /* the pill keeps the group's words */ }
        delete rows[0].other_yes_count;
      }

      // A GET on this route is NOT by itself evidence that the user opened
      // the session: screens refetch it programmatically. The notification
      // dismissal below therefore needs the caller to SAY that a person
      // opened it: `?opened=1`. Machine refetches omit it and are
      // side-effect free apart from the activity bump.
      const userOpened = req.query.opened === '1';

      // Viewing a session counts as activity so the auto-pause sweeper
      // doesn't pause a session the user is actively reading. Fire-and-
      // forget — the view shouldn't block on this write, and a missed
      // bump just means the next open re-marks it. This one stays on every
      // fetch: a session being polled by its owner's open tab is in use.
      //
      // OWNER ONLY. It is a statement about the owner's attention, which is
      // not true when the admin read above is what resolved this row: an
      // admin (or the check suite) glancing at a session must not keep it
      // awake.
      if (rows[0].user_id === req.user.id) {
        pool.query(
          'UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1',
          [req.params.id]
        ).catch((err) => log.warn('sessions', 'activity bump on view failed', { err: err.message }));
      }

      // #161 auto-dismiss: a user opening the session is the canonical
      // "user saw it" signal — resolve any unread session_done rows for
      // it, even when the user navigated here on their own rather than via
      // the notification. Fire-and-forget; cross-tab badge sync on change.
      if (userOpened) {
        notifications.markReadForAction(pool, req.user.id, 'session_opened', rows[0].id)
          .then((cleared) => {
            if (cleared > 0) {
              const { pushNotificationToUser } = require('../services/ws');
              pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
            }
          })
          .catch((err) => log.warn('sessions', 'session_opened dismiss failed', { err: err.message }));
      }

      const { rows: messages } = await pool.query(
        `SELECT id, role, content, model, token_count, cost_cents, metadata, created_at
         FROM chat_session_messages
         WHERE session_id = $1
         ORDER BY id ASC`,
        [req.params.id]
      );

      // #195: attach the session's stored before/after capture ids so the
      // staging card can render its visual tiles on history reload (the
      // live path delivers the same shape via the visuals_ready event).
      // Best-effort — a visuals hiccup must not break opening the session.
      const session = rows[0];
      // Its code did not come across when Homeroom moved off GitHub
      // (services/code-missing.js): a proposal's pull request branch, or a
      // change underway's own branch when it predates its app's move. Read as
      // the lists read it (cached a minute), so a branch pushed back clears
      // it by itself; the turns and the sync read it live before they run.
      session.code_missing = await codeMissing.forSession(pool, session);
      // #1650: a managed local handoff cannot be proposed merely because it
      // is active. Its exact submitted head must have live staging and a
      // terminal passing verdict, and the in-memory build/check/capture gates
      // matter too. Publish the SAME state the CLI status endpoint and
      // promotion preflight compute so the Changes ready card can disable its
      // action before a doomed request. Ordinary Dev sessions deliberately do
      // not get this field: their promote path may still build on demand.
      if (session.source === 'cli_handoff') {
        const proposal = require('./proposal-handoff').publicSessionStatus(session);
        session.proposal_state = proposal.revisionState || proposal.state;
      }
      try {
        session.visuals = await visuals.getForSession(
          pool, session.id, visualHeadForSession(session)
        );
      } catch { session.visuals = null; }
      try {
        session.shots = config.shots?.present
          ? await require('../services/shots-view')
            .getForSession(pool, session, session.app_slug, { viewer: req.user })
          : null;
      } catch { session.shots = null; }
      // #3249: the meter's "this change $X" — what this change has cost so
      // far. Best-effort like the two above: `null` hides the figure.
      try {
        session.cost_total_cents = await sessionCost.sessionCostCents(pool, session.id);
      } catch { session.cost_total_cents = null; }

      // #1442: opening a promoted proposal is the one moment its freshness
      // numbers are about to be READ by a person deciding how to vote, so
      // this is where they are worth re-measuring. TTL-gated (60s) and
      // single-flighted per session in the service. While the leader's own
      // measurement of this head is under three minutes old it answers, for
      // no GitHub request; otherwise a refresh costs four to seven, at most
      // once a minute. Never throws, and the refreshed block is folded onto
      // the row that is about to be serialized so the response carries the
      // number it just measured rather than the one it read a moment earlier.
      if (session.status === 'promoted' && session.repo_url) {
        try {
          const freshnessSvc = require('../services/proposal-freshness');
          const written = await freshnessSvc.refreshFreshnessDeduped(
            { gh: require('../services/github'), pool }, session
          );
          if (written && !written.skipped) {
            session.freshness_checked_at = written.checkedAt;
            session.freshness_main_sha = written.mainSha;
            session.freshness_merge_base_sha = written.mergeBaseSha;
            session.freshness_behind_by = written.behindBy;
            session.freshness_ahead_by = written.aheadBy;
            session.mergeability = written.mergeability;
            session.mergeability_files = written.mergeabilityFiles;
            session.mergeability_files_complete = written.mergeabilityFilesComplete;
            session.checks_base_verdict = written.checksBaseVerdict;
            session.checks_base_behind_by = written.checksBaseBehindBy;
            session.freshness_error = written.error;
            if (written.behindBy != null) session.behind_main = Math.max(0, written.behindBy);
          }
        } catch (err) {
          log.warn('sessions', 'freshness refresh failed', { sessionId: session.id, err: err.message });
        }
      }
      session.freshness = require('../services/proposal-freshness').readFreshness(session);
      // The server's own merge answers ride along, as the board card gets
      // them (#2038): the header pill reads the same blockReasons, including
      // a merge GitHub held back (github_busy / github_refused) and when the
      // queue tries it again (merge_held_until, the queue's own record).
      session.integration = require('../services/integration').readIntegration(session);

      res.json({ session, messages });
    } catch (err) {
      log.error('sessions', 'Failed to get session', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Archive a session. Reversible: tears down staging + worker and closes
  // the PR, but KEEPS the CC volume + branch so /unarchive can restore it
  // within the retention window (a background GC purges the volume only
  // after ARCHIVED_RETENTION_MS). Use the service so the stale-PR sweeper
  // archives the exact same way.
  router.post('/api/sessions/:id/archive', sameOriginBrowserOnly, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);

      // Archiving a declaration proposal discards its held encrypted value.
      // Look up only the caller's own row so this check creates no session-id
      // oracle; the lifecycle service retains its authoritative owner check.
      if (req.cliAuthenticated) {
        const { rows } = await pool.query(
          'SELECT branch_name FROM chat_sessions WHERE id = $1 AND user_id = $2',
          [sessionId, req.user.id]
        );
        if (isCliCredentialManagementSession(req, rows[0])) {
          return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
        }
      }

      const { rows: [own] } = await pool.query(
        'SELECT status FROM chat_sessions WHERE id = $1 AND user_id = $2', [sessionId, req.user.id]);
      if (!own || !['active', 'paused', 'promoted'].includes(own.status)) {
        return res.status(404).json({ error: 'Session not found or already archived' });
      }

      // Release any in-flight bookkeeping first (archiving mid-turn).
      if (activeWorkers.has(sessionId)) {
        activeWorkers.delete(sessionId);
        workerProgress.clear(sessionId);
      }

      const { archived } = await sessionLifecycle.archiveSession({
        pool, sessionId, userId: req.user.id, username: req.user.username, reason: 'manual', from: own.status,
      });
      if (!archived) return res.status(404).json({ error: 'Session not found or already archived' });
      res.json({ ok: true });
    } catch (err) {
      log.error('sessions', 'Archive failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/unpromote (#3114)
  //   Move the caller's own proposal from "In review" back to "Underway"
  //   without closing its pull request: votes are voided, the merge path can
  //   no longer claim it, and a later promote puts it up for a fresh vote.
  //   Owner-scoped like /archive. All the safety lives in
  //   sessionLifecycle.unpromoteSession's single guarded UPDATE.
  router.post('/api/sessions/:id/unpromote', sameOriginBrowserOnly, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({ error: 'Bad session id' });
      }
      const result = await sessionLifecycle.unpromoteSession({
        pool, sessionId, userId: req.user.id, actorUsername: req.user.username,
      });
      if (result.ok) {
        return res.json({ ok: true, status: result.status, ...(result.already ? { alreadyUnderway: true } : {}) });
      }
      switch (result.code) {
        case 'not_found':
          return res.status(404).json({ error: 'Proposal not found' });
        case 'forbidden':
          return res.status(403).json({ error: 'Only the proposer can move this proposal back to Underway' });
        case 'merging':
          return res.status(409).json({ error: 'This proposal is already merging, so it can no longer be moved back to Underway.' });
        case 'busy':
          return res.status(409).json({ error: 'A build is running on this change. Wait for it to finish, then move it back to Underway.' });
        case 'pending_secret':
          return res.status(409).json({ error: 'This proposal holds a secret value that is discarded when it leaves review. Withdraw it instead if you want to stop it.' });
        case 'not_decided':
          return sessionLifecycle.answerNotDecided(res,
            'Homeroom has not decided on moving this proposal back to Underway yet, so it is still in review. Try again in a few seconds.');
        default:
          return res.status(409).json({ error: 'This proposal is no longer in review.' });
      }
    } catch (err) {
      log.error('sessions', 'Unpromote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/unarchive
  //   Reverse an archive (within the retention window). Restores the
  //   session to 'paused' and best-effort reopens the PR; reopening it in
  //   the UI then auto-resumes via the normal path. If the CC volume was
  //   already GC'd (cc_purged), the restore still works but Claude starts
  //   fresh — we surface that so the UI can warn.
  router.post('/api/sessions/:id/unarchive', sameOriginBrowserOnly, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      if (req.cliAuthenticated) {
        const { rows } = await pool.query(
          'SELECT branch_name FROM chat_sessions WHERE id = $1 AND user_id = $2',
          [sessionId, req.user.id]
        );
        if (isCliCredentialManagementSession(req, rows[0])) {
          return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
        }
      }
      const { unarchived, ccPurged, busy, notDecided } = await sessionLifecycle.unarchiveSession({
        pool, sessionId, userId: req.user.id,
      });
      if (notDecided) {
        return sessionLifecycle.answerNotDecided(res,
          'Homeroom has not decided on reopening this session yet, so it is still closed. Try again in a few seconds.');
      }
      if (busy) return res.status(503).json({ error: 'The session is still being closed. Try again shortly.' });
      if (!unarchived) return res.status(404).json({ error: 'Session not found or not archived' });
      // Its pull request is reopened by the proposal machine's own work,
      // after this answer.
      res.json({ ok: true, ccPurged: !!ccPurged });
    } catch (err) {
      log.error('sessions', 'Unarchive failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/share | /unshare
  //   Toggle a session's "visible to everyone" flag (chat_sessions.
  //   shared_at — see schema.sql). Owner-scoped like archive/unarchive;
  //   headless rows excluded. Allowed on active/paused/promoted rows
  //   (promoted is a display no-op — the proposal card already shows —
  //   but keeps the flag for a later un-promote). Share is idempotent
  //   and keeps the ORIGINAL shared_at (COALESCE) so re-sharing doesn't
  //   jump the card to the bottom of other users' In progress area.
  //   Both broadcast a session_update so open Dev boards refresh live.
  router.post('/api/sessions/:id/share', sameOriginBrowserOnly, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const { rows } = await pool.query(
        `UPDATE chat_sessions cs
            SET shared_at = COALESCE(cs.shared_at, NOW())
           FROM apps a
          WHERE cs.id = $1 AND cs.user_id = $2 AND cs.is_headless = FALSE
            AND cs.status IN ('active', 'paused', 'promoted')
            AND a.id = cs.app_id
          RETURNING cs.id, cs.shared_at,
                    a.id AS app_id, a.slug AS app_slug`,
        [sessionId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'shared', sessionId, appId: rows[0].app_id, appSlug: rows[0].app_slug });
      res.json({
        ok: true,
        shared_at: rows[0].shared_at,
      });
    } catch (err) {
      log.error('sessions', 'Share failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Unshare clears BOTH stamps: transcript_shared_at is the mark a
  // transcript published in the past carries, which account deletion still
  // reads (services/account-deletion.js), and a private session keeps none.
  router.post('/api/sessions/:id/unshare', sameOriginBrowserOnly, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const { rows } = await pool.query(
        `UPDATE chat_sessions cs SET shared_at = NULL, transcript_shared_at = NULL
           FROM apps a
          WHERE cs.id = $1 AND cs.user_id = $2 AND cs.is_headless = FALSE
            AND a.id = cs.app_id
          RETURNING cs.id, a.id AS app_id, a.slug AS app_slug`,
        [sessionId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'unshared', sessionId, appId: rows[0].app_id, appSlug: rows[0].app_slug });
      res.json({ ok: true });
    } catch (err) {
      log.error('sessions', 'Unshare failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/resume
  //   Flips a paused session back to 'active'. The CC volume is still on
  //   disk, so its next turn picks up where it left off.
  //
  //   Cap handling:
  //     - Global cap: refuse if the platform-wide active+promoted count
  //       is already at maxGlobalSessions (a flood of simultaneous
  //       resumes shouldn't blow past the concurrency ceiling).
  //     - Per-user cap: if the user is already at maxUserSessions, the
  //       default (sessionLruOnResume) is to auto-pause their least-
  //       recently-active session to make room, so reopening always
  //       works. Set SESSION_LRU_ON_RESUME=false to keep the old hard
  //       429. If every other session is mid-turn (can't be paused), we
  //       fall back to a 429.
  //   We deliberately do NOT pre-spawn the worker here; first-turn lazy
  //   boot is what every other path uses.
  router.post('/api/sessions/:id/resume', sameOriginBrowserOnly, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const resumed = await resumePausedSession({ pool, config, user: req.user, sessionId });
      if (!resumed.ok) return sendResumeRefusal(res, resumed);
      res.json({ ok: true });
    } catch (err) {
      log.error('sessions', 'Resume failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #8: POST /api/sessions/:id/sync-main
  //   Merge origin/main into the session's branch. Runs a worker turn
  //   in MODE=sync (see worker/run-cc.sh). Clean merges are
  //   commit+push only (no CC, no LLM spend); conflicts dispatch CC
  //   with a resolution-only prompt and abort cleanly if CC can't
  //   resolve.
  //
  //   Owner-only. Returns the syncResult so the UI can route messaging:
  //     already_synced — nothing to do
  //     clean          — merged + pushed without LLM
  //     resolved       — CC resolved conflicts; merged + pushed
  //     conflict       — CC couldn't resolve; merge aborted, no push
  router.post('/api/sessions/:id/sync-main', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    if (Number.isNaN(sessionId)) return res.status(400).json({ error: 'Bad session id' });

    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2`,
        [sessionId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      let session = rows[0];
      // A paused session is resumed for the user, as a message to it is:
      // paused is bookkeeping, never a step anybody is asked to take first.
      if (session.status === 'paused') {
        const resumed = await resumePausedSession({ pool, config, user: req.user, sessionId });
        if (!resumed.ok) return sendResumeRefusal(res, resumed);
        session = { ...session, status: 'active' };
      }
      if (!['active', 'promoted'].includes(session.status)) {
        return res.status(409).json({
          error: `This ${session.status === 'archived' ? 'session is archived' : 'change is closed'}. Restore it first.`,
        });
      }

      // The proposal machine decides whether it may run (nobody else
      // working on it, not being merged) and runs it; this waits for it. A
      // sync already under way is joined.
      const platform = require('../workflow/platform.ts');
      let out = await platform.requestSync({
        sessionId, appId: session.app_id, reason: 'person', userId: req.user.id, wait: true,
        source: { kind: 'route', name: 'sync-main' },
      });
      if (out.status === 'rejected' && out.reason === 'in_progress') {
        const running = await platform.syncUnderWay(sessionId);
        const i = running ? await platform.waitForSync(sessionId, running.n) : null;
        out = { ...out, status: 'accepted', lastSync: i };
      }
      if (out.status === 'rejected') {
        const busy = out.reason === 'busy';
        return res.status(409).json({
          error: busy ? 'Claude is still working in this session. Wait for the turn to finish before syncing.'
            : out.reason === 'merging' ? 'This change is being merged.'
              : `This change can't be synced now (${out.reason}).`,
          ...(busy ? { busy: true } : {}),
        });
      }
      // Not ended within the wait (or ended by a close or a merge): still
      // under way as far as this answer knows, never "done".
      const done = out.status === 'pending' ? null : out.lastSync;
      if (!done) return res.status(202).json({ ok: false, pending: true, message: 'The sync with main is still running.' });
      // Its branch did not come across from GitHub: nothing ran.
      if (done.outcome === codeMissing.CODE) {
        return res.status(409).json({ error: done.message || codeMissing.BRANCH_GONE, code: codeMissing.CODE });
      }
      if (done.outcome === 'error' || done.outcome === 'over_budget' || done.outcome === 'gone') {
        return res.status(done.outcome === 'gone' ? 409 : 500).json({ error: done.message || 'Sync with main failed' });
      }
      const syncResult = done.outcome === 'unresolvable' ? 'conflict' : done.outcome === 'not_pushed' ? 'clean' : done.outcome;
      res.json({
        ok: done.outcome !== 'unresolvable', syncResult, sha: done.sha || null, pushOk: done.pushOk ?? done.outcome !== 'not_pushed',
        behind: done.behind || 0, conflictFiles: done.conflictFiles || [], message: done.message,
      });
    } catch (err) {
      log.error('sessions', 'sync-main failed', { sessionId, err: err.message });
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // ===== Spec stage endpoints =====
  //
  // The session has a working buffer (chat_sessions.spec_md, overwritten
  // by each plan a run writes) and an append-only history of
  // immutable numbered versions in chat_session_specs.
  // A version is frozen on every spec mutation (#27, via
  // snapshotSessionSpec), so spec_md is always byte-identical to the
  // latest version. Numbered versions (v1…vN) are the single spec
  // surface the plan viewer presents; spec_md is kept purely as the
  // live-draft buffer the next plan revises against and as a theme signal
  // for PR metadata.
  //
  // Read-only fetch returning the latest spec content plus metadata for
  // every visible version so the viewer can populate its version
  // selector without a second round-trip; full content of older versions
  // comes from GET /specs/:version below.
  //
  // Access rule (mirrors GET /specs/:version, which this list feeds):
  //   - Owner: the live draft (spec_md, == the latest version's content)
  //     plus ALL frozen versions — drafts stay private until shared.
  //   - Anyone else (admins included — sharing is the explicit act that
  //     makes a spec visible, same rule as the single-version gate):
  //     only versions matching specVersionSharedVisibilitySql, with
  //     `spec` set to the newest VISIBLE version's content — never
  //     spec_md, which can be ahead of the last shared version. Zero
  //     visible versions keeps today's 404, so nothing new is revealed
  //     about sessions whose specs were never shared.
  router.get('/api/sessions/:id/spec', async (req, res) => {
    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.user_id, cs.spec_md, cs.spec_html
         FROM chat_sessions cs
         WHERE cs.id = $1`,
        [req.params.id]
      );

      // #3699: `html` is the latest version's HTML document when it was
      // written as one; `spec` is then its markdown copy.
      if (sessionRows.length && sessionRows[0].user_id === req.user.id) {
        const { rows: versions } = await pool.query(
          `SELECT version, built_at, commit_sha, pr_number, shared_to_group_at,
                  LENGTH(content) AS char_count
           FROM chat_session_specs
           WHERE session_id = $1
           ORDER BY version DESC`,
          [req.params.id]
        );
        return res.json({
          spec: sessionRows[0].spec_md || '',
          html: sessionRows[0].spec_html || null,
          versions,
        });
      }

      if (sessionRows.length) {
        // Non-owner: shared versions only. `content` rides along so the
        // newest visible version can serve as `spec` without a second
        // query, then is stripped from the metadata rows.
        const { rows } = await pool.query(
          `SELECT version, built_at, commit_sha, pr_number, shared_to_group_at,
                  LENGTH(content) AS char_count, content, content_html
           FROM chat_session_specs s
           WHERE s.session_id = $1
             AND ${specVersionSharedVisibilitySql('s', '$2')}
           ORDER BY version DESC`,
          [req.params.id, req.user.id]
        );
        if (rows.length) {
          return res.json({
            spec: rows[0].content || '',
            html: rows[0].content_html || null,
            versions: rows.map(({ content, content_html: _html, ...meta }) => meta),
          });
        }
      }

      // (#1012) Staging-only demo fallback (?demo=1): chat_session_specs
      // is staging:private, so a non-owner's spec panel has nothing real
      // to list in a preview. Read-path only, gated on staging + the
      // explicit demo flag, and reached only when no real data matched —
      // production and any real spec are untouched.
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        return res.json(stagingMockSpecList());
      }

      return res.status(404).json({ error: 'Session not found' });
    } catch (err) {
      log.error('sessions', 'Failed to get spec', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Fetch a frozen historical version verbatim. The spec viewer uses
  // this when the user picks an older version from the dropdown.
  // (User hand-edits via PUT /spec were dropped — the Mayor /
  // dispatch_scout writes the live draft and the user only ever views
  // the result. Old sessions that already have frozen versions in
  // chat_session_specs keep their browseable history through this
  // endpoint and the share endpoint below.)
  //
  // Access rule:
  //   - Owner of the originating session: every version (saved drafts
  //     are private until explicitly shared).
  //   - Anyone else (any authed user): only versions where
  //     shared_to_group_at IS NOT NULL — i.e. the spec was explicitly
  //     posted into the app's group chat, while its owner could do that.
  //     The group-chat read endpoint has no membership gate, so every
  //     logged-in user can already see such a share card; the body of
  //     the spec should be reachable too, otherwise the "View full spec"
  //     affordance on the card 404s for everyone except the original
  //     sharer (#6).
  //   - (#86) A user the owner privately shared this exact version
  //     with, while that was offered — the
  //     chat_session_spec_user_shares row is the authorization source
  //     of truth, scoped to (session, version, recipient).
  // The non-owner arm lives in specVersionSharedVisibilitySql, shared
  // verbatim with the version-list route (GET /spec) above so the two
  // gates cannot drift.
  router.get('/api/sessions/:id/specs/:version', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const version = parseInt(req.params.version, 10);
    if (Number.isNaN(sessionId) || Number.isNaN(version)) {
      return res.status(400).json({ error: 'Bad id/version' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT s.version, s.content, s.content_html, s.built_at, s.commit_sha, s.pr_number, s.shared_to_group_at
         FROM chat_session_specs s
         JOIN chat_sessions cs ON cs.id = s.session_id
         WHERE s.session_id = $1
           AND s.version = $2
           AND (cs.user_id = $3 OR ${specVersionSharedVisibilitySql('s', '$3')})`,
        [sessionId, version, req.user.id]
      );
      if (!rows.length) {
        // (#1012) Staging-only demo fallback (?demo=1): chat_session_specs
        // is staging:private, so cloned group-chat spec cards have nothing
        // to load. Read-path only, gated on staging + the explicit demo
        // flag, and reached only when no real row matched — production and
        // any real spec are untouched.
        if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
          return res.json({ spec: stagingMockSpecVersion(version) });
        }
        return res.status(404).json({ error: 'Plan version not found' });
      }
      res.json({ spec: rows[0] });
    } catch (err) {
      log.error('sessions', 'Failed to get spec version', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Check if a session has an active worker + get latest progress
  router.get('/api/sessions/:id/status', async (req, res) => {
    const sessionId = parseInt(req.params.id);
    // "busy" = something is working on this session right now, in any
    // process. We deliberately do NOT key on `containerStatus === 'running'`
    // here: the worker container stays running between dispatches, so a
    // running container only means "the wrapper is sleep-looping", not "a
    // coding agent is busy".
    const busy = await isSessionBusyAnywhere(sessionId, { pool });

    // Same visibility rule as /checks and /details: the progress log and
    // spend below are the session's own, so a caller who may not see the
    // session gets the same 404 as for a missing one.
    let mayReadCost = false;
    let mergeStatus = null;
    try {
      const { rows: seen } = Number.isNaN(sessionId) ? { rows: [] } : await pool.query(
        'SELECT user_id, status, shared_at FROM chat_sessions WHERE id = $1',
        [sessionId]
      );
      if (!canViewSession(seen[0], req.user)) return res.status(404).json({ error: 'Session not found' });
      // Narrower than seeing the session: what a change cost is for its author
      // and admins, the rule GET /api/sessions/:id applies to the same figure.
      mayReadCost = seen[0].user_id === req.user.id || !!req.user.isAdmin;
      mergeStatus = seen[0].status || null;
    } catch (err) {
      log.warn('sessions', 'Status visibility lookup failed', { sessionId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }

    let progress = [];
    let progressAgentBackend = null;
    let progressAgentModel = null;
    try {
      const { rows } = await pool.query(
        `SELECT metadata FROM chat_session_messages
         WHERE session_id = $1 AND role = 'system' AND metadata->>'progressLog' IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        [sessionId]
      );
      if (rows[0]?.metadata?.progressLog) {
        progress = rows[0].metadata.progressLog;
        progressAgentBackend = rows[0].metadata.agentBackend || null;
        progressAgentModel = rows[0].metadata.agentModel || null;
      }
    } catch {}
    // During bootstrap the latest durable row can still belong to the prior
    // turn. An in-memory entry, when it has a backend, is necessarily the
    // current run and therefore wins for identity.
    // Fall back to the durable row only before current progress has begun.
    const liveProgress = workerProgress.get(sessionId);
    if (liveProgress?.backend) {
      progressAgentBackend = liveProgress.backend;
      progressAgentModel = liveProgress.model || null;
    }

    // The phase of a turn this process follows ('cc' for one being
    // recovered), or null.
    const stopHandleNow = stopRegistry.get(sessionId);
    const phase = stopHandleNow?.phase || null;

    // #1378: whether POST /stop can actually do anything for this session.
    //
    // `busy` and "stoppable" are NOT the same fact, and conflating them is
    // what produced the reported bug. `busy` is true for anything holding
    // the session — an adopted turn, a handoff pipeline, a proposal
    // handoff — while only a turn with a stop handle (or a durable
    // active_turn still in a recoverable phase, which the recovery path
    // will register a handle for) can be stopped.
    let durableTurn = null;
    try {
      durableTurn = await turnLifecycle.loadActiveTurn(pool, sessionId);
    } catch {}
    const durableRecoverable = !!durableTurn
      && turnLifecycle.RECOVERABLE_PHASES.has(turnLifecycle.phaseOf(durableTurn));
    const stoppable = !!stopHandleNow || durableRecoverable;

    // #889: a stop has been requested for this turn but it hasn't unwound
    // yet.
    //
    // #1378: falls back to the durable stamp. A stop asked for just before a
    // restart lives on the turn record, not in this process's memory.
    const durableStop = turnLifecycle.stopRequestOf(durableTurn);
    const stopping = stopHandleNow ? !!stopHandleNow.stopped : !!durableStop;

    // #4533: what the running turn is and since when, off its record, for
    // get_change: a busy change said nothing of what held it (PR #4533's
    // checks fix waited an hour behind one). Its mode ('build', 'scout',
    // 'sync', 'shots'), or the Homeroom bot's follow-up (its record names
    // the bot's look as its owner: 'homeroom_bot_follow_up').
    let turn = null;
    if (durableTurn) {
      const own = turnLifecycle.ownerOf(durableTurn);
      turn = {
        startedAt: durableTurn.startedAt || null,
        kind: own?.machine === 'bot-request' ? 'homeroom_bot_follow_up' : (durableTurn.mode || null),
      };
    }

    // #937: WHEN the stop was requested. Null whenever no stop is pending.
    const stopRequestedAt = stopHandleNow
      ? (stopHandleNow.stopRequestedAt || null)
      : (durableStop?.atMs || null);

    // #239: whether the merge queue's conflict lane currently has a resolve
    // in flight for this session. The client's "resolving merge
    // conflicts" banner used to poll this as its reload-recovery and
    // missed-WS-event safety net; that banner was retired in #962, so
    // no client reads this today. Kept as a cheap, honest fact about
    // the session for admin/debug tooling and future surfaces — the
    // per-proposal badge derives the same state from the WS
    // `resolving` broadcasts + the merge_conflict_state snapshot.
    const sync = await syncMainSvc.getSyncState(pool, sessionId);

    // #3249: the change's running cost total, idle or busy.
    // Its author and admins only (mayReadCost above): anyone else who may
    // view the session gets no such field, and the read does not run. `null`
    // when the read failed.
    let costTotalCents = null;
    if (mayReadCost) {
      try {
        costTotalCents = await sessionCost.sessionCostCents(pool, sessionId);
      } catch (err) {
        log.warn('sessions', 'Session cost read failed', { sessionId, err: err.message });
      }
    }

    // #252: in-flight sync-with-main state ({ phase, startedAt } | null).
    // Keys: busy, progress, phase, stopping, stopRequestedAt, stoppable,
    // turn ({ startedAt, kind } | null, #4533), costTotalCents
    // (the change's cost so far in cents | null, #3249; author and admins only,
    // absent for anyone else)
    // (+ resolving, sync, status).
    // `stopRequestedAt` is epoch ms | null (#937).
    res.json({
      busy, progress, phase, stopping, stopRequestedAt, stoppable, turn,
      // The running turn's share of the same figure, under the same rule.
      spend: busy && mayReadCost ? workerProgress.get(sessionId)?.spend || null : null,
      agentBackend: progressAgentBackend,
      agentModel: progressAgentModel,
      resolving: !!sync && sync.reason === 'conflict',
      sync,
      status: mergeStatus,
      ...(mayReadCost ? { costTotalCents } : {}),
    });
  });

  // Stop the turn running on a change (#28): the machine whose work runs
  // it hears the Stop, and a turn no machine holds is stopped in its worker.
  router.post('/api/sessions/:id/stop', sameOriginBrowserOnly, async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    if (Number.isNaN(sessionId)) return res.status(400).json({ error: 'Bad session id' });
    try {
      const result = await requestSessionStop({
        pool, sessionId, user: req.user, force: req.body?.force === true,
      });
      return res.status(result.status).json(result.body);
    } catch (err) {
      log.error('sessions', 'Stop failed', { sessionId, message: err.message });
      return res.status(err.httpStatus || 503).json({ error: err.httpStatus ? err.message : 'Could not confirm that the agent stopped. Retry Stop.', code: err.httpStatus ? err.code : 'stop_unconfirmed' });
    }
  });

  // Get current user's budget
  router.get('/api/budget', async (req, res) => {
    // Staging mock data: the out-of-credits state (red meter + the
    // three-route credits banner + the in-chat card) is unreachable on a
    // staging preview without actually burning a real weekly allowance, so
    // a reviewer would only ever see the healthy state. ?demo=1 fabricates
    // an exhausted snapshot without touching the database — same idiom as
    // GET /api/me/ai-budget (routes/auth.js) and GET /api/me/cli-tokens.
    // Strictly a no-op in production. `demo: true` marks the fabricated
    // snapshot.
    if (process.env.USERNODE_ENV === 'staging'
        && (req.query.demo === '1' || req.query.demo === 'weekly-out')) {
      // #2571: there is one allowance and one window now, so the two demo
      // spellings answer with the same fixture — ?demo=weekly-out is kept
      // only so existing review links and declared checks keep working.
      // The reset instant is computed inline rather than through the
      // weeklyResetAt() helper the real branch below uses: this branch must
      // stay provably free of any service call (tests/budget-demo.test.js
      // pins that), and next Monday 00:00 UTC is the same two lines either
      // way.
      const weekReset = new Date();
      weekReset.setUTCDate(weekReset.getUTCDate() + (((8 - weekReset.getUTCDay()) % 7) || 7));
      weekReset.setUTCHours(0, 0, 0, 0);
      return res.json({
        spentCents: 5000,
        limitCents: 5000,
        remainingCents: 0,
        creditPolicy: 'legacy',
        tier: 'legacy',
        limitSource: 'default',
        verificationRequired: false,
        entitlementAvailable: true,
        tierLimitCents: 1000,
        globalSpentCents: 4000,
        globalLimitCents: 100000,
        byokSpentCents: 0,
        aiEnabled: true,
        resetsAt: weekReset.toISOString(),
        lowBalancePct: 80,
        // #1788 stated which window these three figures describe; #2571
        // leaves only one answer.
        capWindow: 'weekly',
        windowLabel: 'This week',
        resetLabel: 'Monday 00:00 UTC',
        dailyApplies: false,
        dailyLimitCents: 2500,
        dailySpentCents: 900,
        weeklyApplies: true,
        weeklyLimitCents: 5000,
        weeklySpentCents: 5000,
        demo: true,
      });
    }
    try {
      const snapshot = await limits.getBudgetSnapshot(pool, req.user.id);
      const globalLimit = await limits.getGlobalLimitCents(pool);
      const { rows: globalRows } = await pool.query(
        'SELECT COALESCE(SUM(total_cost_cents), 0) AS total FROM llm_usage WHERE date = CURRENT_DATE'
      );
      const globalSpent = parseFloat(globalRows[0]?.total || 0);
      // #297: surface AI availability so client chrome (a proposal's
      // Explore pills) can disable itself with a tooltip when there's
      // no usable LLM path — the platform key is unset AND the user has
      // no BYOK key on file.
      const userApiKey = await limits.loadUserApiKey(pool, req.user.id, config.dataEncryptionKey);
      res.json({
        ...snapshot,
        // #593: the two figures the composer's meter has to state out loud
        // — what is left, and when it comes back. Both were derivable from
        // the pair above plus a hardcoded "midnight UTC" on the client,
        // which is how the reset boundary ended up living in three places.
        globalSpentCents: globalSpent,
        globalLimitCents: globalLimit,
        // Keep the route's established spelling while the shared snapshot
        // uses `byokCents` internally.
        byokSpentCents: snapshot.byokCents,
        // Availability means a provider exists, not that this request has
        // allowance headroom. Keep the Explore entry points open so their
        // locked-tier UI can explain how to connect an identity.
        aiEnabled: llm.isEnabled() || !!userApiKey,
      });
    } catch (err) {
      log.error('sessions', 'Budget check failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  async function loadPreviewSession(sessionId) {
    const { rows } = await pool.query(
      `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
        WHERE cs.id = $1`,
      [sessionId]
    );
    return rows[0] || null;
  }

  function mayOpenPreview(session, userId, { mutate = false } = {}) {
    const isOwner = session.user_id === userId;
    const voteBacked = session.status === 'promoted' || session.status === 'merging';
    const shared = !!session.shared_at;
    // Reads use the router's view-level guard and may inspect a public vote
    // or explicitly shared session. A rebuild remains collab-gated by the
    // method-aware router guard; this predicate only scopes the row itself.
    return isOwner || voteBacked || shared || (!mutate && session.status === 'merged');
  }

  // One authoritative answer for both the owner's ensure-and-rebuild POST
  // and a read-only reviewer's status GET. A stored URL is only a pointer;
  // it is not evidence that the submitted revision is still what the runtime
  // serves. Verify revision/env/liveness, app health, then the public edge in
  // that order before anybody is allowed to navigate an iframe (#2328).
  async function inspectPreview(session, { repairDockerAlias = false } = {}) {
    const headSha = stagingRecovery.recheckHeadSha(session);
    if (await stagingRecovery.stagingNeedsRebuild(session, { config, headSha })) {
      return { status: 'missing' };
    }
    // Asleep (#6157, services/preview-sleep.js): not missing, since its
    // image, database and address are all there, and not ready, since it has
    // no pod. The route wakes it. One out of date was answered missing above,
    // and is rebuilt rather than woken.
    if (require('../services/preview-sleep').isAsleep(session)) return { status: 'asleep' };

    const stagingName = `usernode-staging-${session.app_slug}--${session.id}`;
    const runtimeKind = session.staging_runtime_kind || applicationRuntime.mode(config);
    if (repairDockerAlias && runtimeKind === 'docker') {
      await docker.ensureNetworkAlias(
        stagingName,
        applicationRuntime.dnsAlias({ environment: 'staging', sessionId: session.id })
      ).catch(() => false);
    }

    const healthy = await applicationRuntime.probeHealth(config, {
      runtimeKind,
      runtimeName: session.staging_runtime_name || (runtimeKind === 'docker' ? stagingName : null),
    }, { timeoutMs: 3000 }).catch(() => false);
    if (!healthy) {
      log.warn('sessions', 'preview runtime is live but did not answer its healthcheck', {
        sessionId: session.id, appSlug: session.app_slug,
      });
      return { status: 'unavailable', reason: 'unhealthy' };
    }

    let edgeRequired = false;
    let hostname = null;
    try {
      const url = new URL(session.staging_url);
      edgeRequired = url.protocol === 'https:';
      hostname = url.hostname;
    } catch (_) {
      return { status: 'unavailable', reason: 'edge' };
    }
    if (edgeRequired) {
      const edge = await staging.verifyStagingEdge(session, hostname, session.staging_url)
        .catch(() => ({ ok: false }));
      if (!edge?.ok) return { status: 'unavailable', reason: 'edge' };
    }

    return {
      status: 'ready', url: session.staging_url, verified: true,
      checksRunning: session.check_state === 'pending',
      // The preview bar's title ("Flat 4B Chores · Preview"). A caller that
      // opens a preview from a slug alone (the bot's ready card, an agent
      // session) has no name to show; this answer does.
      appName: session.app_name || null,
      // A change that only shows at certain times declares the moment to see
      // it at (services/preview-clock.js). Try it opens the preview there and
      // the bar says so. Absent when nothing is declared.
      ...previewClock.previewAnswer(session),
      // The page the change is about (services/preview-start.js): the first
      // declared shots start path, else the testing deep link. Try it opens
      // the preview there instead of the first screen. Absent when neither
      // names one, so those answers stay byte-identical.
      ...previewStart.previewAnswer(session),
    };
  }

  // A sleeping preview opened from Homeroom (#6157): woken in the background,
  // behind the same "spinning back up" loader a rebuild shows. Once it serves,
  // `staging_awake` tells the loader to open it (it asks ensure-staging again,
  // which verifies it as ever). One that does not wake is handed to the
  // preview machine as lost, which rebuilds it, and the loader waits for that
  // build's staging_ready or staging_failed instead; for a read-only reviewer
  // (`rebuild: false`) it is reported as failed, since their route never
  // rebuilds.
  function wakeAndTell(session, requesterId, { rebuild = true } = {}) {
    const sessionId = Number(session.id);
    const previewSleep = require('../services/preview-sleep');
    const { broadcastGlobal } = require('../services/ws');
    previewSleep.wake(config, pool, sessionId, { reason: 'preview-click' })
      .then((out) => {
        if (out.status === 'woke' || out.status === 'awake') {
          broadcastGlobal({ type: 'session_event', sessionId, event: 'staging_awake', url: out.url || session.staging_url });
          return null;
        }
        log.warn('sessions', 'A sleeping preview did not wake', { sessionId, status: out.status, detail: out.detail, rebuild });
        if (!rebuild) {
          broadcastGlobal({
            type: 'session_event', sessionId, event: 'staging_failed',
            error: 'This preview was asleep and did not wake up. A collaborator can rebuild it.',
            errorName: 'PreviewAsleep', missingKeys: [],
          });
          return null;
        }
        return stagingRecovery.rebuildSessionStaging({ config, pool, session, reason: 'preview-click', requesterId });
      })
      .catch((err) => {
        const { errMsg, errName, missingKeys } = describeStagingFailure(err);
        log.error('sessions', 'A sleeping preview could not be woken or rebuilt', { sessionId, errName, err: errMsg });
        broadcastGlobal({
          type: 'session_event', sessionId, event: 'staging_failed', error: errMsg, errorName: errName, missingKeys,
        });
      });
  }

  // Read-only twin of ensure-staging. A reviewer who cannot trigger a build
  // still gets the same health/revision/edge gate instead of opening the
  // last stored URL directly. It never repairs or rebuilds. It does wake a
  // sleeping preview (#6157): that is what its direct link does for anyone
  // who opens it, and nothing is rebuilt.
  router.get('/api/sessions/:id/preview-status', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const session = await loadPreviewSession(sessionId);
      if (!session || !mayOpenPreview(session, req.user.id)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (process.env.USERNODE_ENV === 'staging') {
        return res.json({ status: 'unavailable', reason: 'demo' });
      }
      const result = await inspectPreview(session);
      if (result.status === 'asleep') {
        require('../services/preview-sleep').touchActivity(pool, session.id);
        wakeAndTell(session, req.user.id, { rebuild: false });
        return res.json({ status: 'rebuilding', waking: true });
      }
      // The admin Journey's creation path: a preview answered as ready is
      // a preview opened, once per viewer per change. Never awaited.
      if (result.status === 'ready') journeyEvents.notePreviewOpened(pool, { sessionId: session.id, viewerId: req.user.id });
      return res.json(result.status === 'missing'
        ? { status: 'unavailable', reason: 'missing' }
        : result);
    } catch (err) {
      log.error('sessions', 'preview-status error', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // On-demand staging restore (#439). The Preview button calls this before
  // opening the overlay. When the preview is already live we tell the
  // client to open it as-is; when it was torn down (idle GC, lost
  // container) we kick off a rebuild from the branch's latest commit and
  // let rebuildSessionStaging's existing `staging_ready` broadcast drive
  // the front end's "spinning back up" loader to completion.
  //
  // The sessionCollabGuard above already gates this to app members; the
  // ownership check below scopes WHO may trigger a rebuild.
  router.post('/api/sessions/:id/ensure-staging', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const session = await loadPreviewSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      // Authorize: the session owner always; for promoted/merging sessions
      // (whose preview backs a group vote) any app member who passed the
      // collab guard may trigger a rebuild, matching the vote panel showing
      // them the Preview button. Explicitly-shared sessions (shared_at set
      // — their card shows everyone a Preview button too) get the same
      // member-wide access.
      if (!mayOpenPreview(session, req.user.id, { mutate: true })) {
        return res.status(403).json({ error: 'Not allowed' });
      }

      // Staging containers have no Docker socket (SELF-HOSTING.md Phase 2g)
      // and cannot build nested previews. Short-circuit so a Preview click
      // inside a staging preview of this platform shows a friendly message
      // instead of spinning forever on a rebuild that can never run.
      if (process.env.USERNODE_ENV === 'staging') {
        return res.json({ status: 'unavailable', reason: 'demo' });
      }

      // Somebody opened it: a preview in use does not go to sleep (#6157).
      require('../services/preview-sleep').touchActivity(pool, session.id);
      // A missing/stale runtime rebuilds. A present but unhealthy one is
      // reported honestly and left alone: one failed bounded probe is not a
      // reason to churn the app or its database, but it is a reason not to
      // navigate the reviewer to stale/current/error content.
      const inspected = await inspectPreview(session, { repairDockerAlias: true });
      // As in preview-status: a ready answer is a preview opened. A rebuild
      // is not, until the client asks again once it is up.
      if (inspected.status === 'ready') journeyEvents.notePreviewOpened(pool, { sessionId: session.id, viewerId: req.user.id });
      // Asleep: scaled back up, no rebuild and no checks run again (#6157).
      if (inspected.status === 'asleep') {
        wakeAndTell(session, req.user.id);
        return res.json({ status: 'rebuilding', waking: true });
      }
      if (inspected.status !== 'missing') return res.json(inspected);

      // Dedup concurrent clicks: at most one rebuild per session in flight.
      if (ensureStagingInFlight.has(sessionId)) {
        return res.json({ status: 'rebuilding' });
      }
      ensureStagingInFlight.add(sessionId);
      res.json({ status: 'rebuilding' });

      // Fire-and-forget. On success rebuildSessionStaging broadcasts
      // `staging_ready` with the preview URL, which the front end opens. The
      // URL is stable per session (services/caddy.js stagingHostname), so the
      // rebuilt preview is the SAME origin the reviewer opened before, with
      // that visit's service worker still installed. On a no-op ('skipped' —
      // branch not ahead of main) or a build failure (missing secrets, docker
      // error) we broadcast `staging_failed` so the loader surfaces a concrete
      // reason.
      const { broadcastGlobal } = require('../services/ws');
      stagingRecovery.rebuildSessionStaging({ config, pool, session, reason: 'preview-click', requesterId: req.user.id })
        .then((result) => {
          if (result === 'skipped') {
            broadcastGlobal({
              type: 'session_event', sessionId,
              event: 'staging_failed',
              error: 'This branch has no changes to preview yet.',
              errorName: 'NothingToPreview',
              missingKeys: [],
            });
          }
        })
        .catch((err) => {
          const { errMsg, errName, missingKeys } = describeStagingFailure(err);
          log.error('sessions', 'ensure-staging rebuild failed', {
            sessionId, errName, err: errMsg, missingKeys,
          });
          broadcastGlobal({
            type: 'session_event', sessionId,
            event: 'staging_failed',
            error: errMsg, errorName: errName, missingKeys,
          });
        })
        .finally(() => {
          ensureStagingInFlight.delete(sessionId);
        });
    } catch (err) {
      log.error('sessions', 'ensure-staging error', { message: err.message });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #447: manual "Re-run checks" for a proposal whose automated checks are
  // stuck. Before this the only way out of a stuck 'pending'/NULL verdict was
  // the owner pushing a brand-new commit — useless for an already-correct PR
  // whose build succeeded — or an admin force-merge that skips checks
  // entirely. This re-runs the checks: rebuild staging if the preview is
  // gone, else re-run against the live container. Progress flows through the
  // existing checks_ready / staging_ready broadcasts so the badge updates in
  // place. Owner + admins only.
  router.post('/api/sessions/:id/recheck', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1`,
        [sessionId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const session = rows[0];

      // Pausing stops coding; explicit verification of existing work remains open.
      if (!['active', 'paused', 'promoted'].includes(session.status)) {
        return res.status(409).json({
          error: 'proposal_closed',
          message: `This proposal is ${session.status || 'no longer open'}, so its checks cannot be re-run.`,
        });
      }

      // Owner or admin only — re-running checks costs a staging build +
      // headless run, so it's not opened to every collaborator (deferred).
      // NB: req.user is the camelCase shape from middleware/auth.js —
      // `is_admin` doesn't exist on it, and checking it meant admins were
      // 403'd on every proposal they didn't own (surfaced by the campaign
      // dashboard, whose sessions belong to usernode-platform). Rechecks
      // mutate check state and cost a build, so gate on canAdminWrite
      // (excludes read-only admins), matching the dashboard's CAN_WRITE.
      const isOwner = session.user_id === req.user.id;
      if (!isOwner && !req.user?.canAdminWrite) {
        return res.status(403).json({ error: 'Not allowed' });
      }

      // Staging containers can't build nested previews (no Docker socket),
      // so a recheck can never run inside a staging preview of the platform.
      if (process.env.USERNODE_ENV === 'staging') {
        return res.json({ status: 'unavailable', reason: 'demo' });
      }

      // From this press on the head is owed a unit suite that really runs
      // (services/unit-suite-reuse.js): whichever run answers it, the one it
      // is folded into below or its own, copies no earlier pass, and a
      // verdict that carries a copied pass is not stored. Durable, and set
      // before any of the answers below.
      // On the head the request is for, read from the row now: a promoted
      // proposal's reviewed head, not a checks pin an older run left.
      const requestedHead = await stagingRecovery.requestedRecheckHead(pool, session);
      await require('../services/unit-suite-reuse').markFreshOwed(pool, {
        sessionId, commitSha: requestedHead,
      });

      // Coalesce repeat clicks.
      if (recheckInFlight.has(sessionId)) {
        return res.json({ status: 'running' });
      }
      // A turn or an operation holds the session (a local proposal
      // submission among them): its own pipeline is the run the user is
      // asking for. A build or checks run going is the preview machine's,
      // which joins a recheck to it (or replaces it when its inputs changed).
      //
      // Folded into what holds the session, the head is still owed a unit
      // suite that really runs (services/unit-suite-reuse.js): a verdict
      // stored before this press no longer stands for it, so the preview
      // machine stamps it pending (and merge-blocked) until one does
      // (RecheckFolded), and starts the owed run once nobody works on the
      // session if nothing has answered it (its ChecksDue).
      if (await isSessionBusyAnywhere(sessionId, { pool })) {
        if (requestedHead) {
          await require('../workflow/platform.ts').recheckFolded({
            sessionId: Number(session.id), appId: Number(session.app_id), head: String(requestedHead).toLowerCase(),
          }).catch((err) => {
            log.warn('sessions', 'Could not stamp a folded recheck pending', { sessionId, err: err.message });
          });
        }
        return res.json({ status: 'running' });
      }
      recheckInFlight.add(sessionId);

      res.json({ status: 'running', checkState: 'pending' });

      // Fire-and-forget: the preview machine rebuilds the preview when it is
      // missing (the rebuild re-runs the checks) or re-runs the checks against
      // the live one, and stamps and announces the pending state itself.
      stagingRecovery.recheckSessionChecks({ config, pool, session, reason: 'manual-recheck' })
        .catch((err) => {
          log.error('sessions', 'manual recheck failed', { sessionId, err: err.message });
        })
        .finally(() => {
          recheckInFlight.delete(sessionId);
        });
    } catch (err) {
      log.error('sessions', 'recheck error', { message: err.message });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// #150: the seed message a run on a request starts from (the Homeroom
// bot's reads and builds): the issue plus its comments, so answers the
// reporter left as comments are visible to the run. Comments authored by
// the platform bot are tagged so the model recognizes its own earlier
// clarifying questions vs. the reporter's answers. Each comment body is
// truncated and only the most recent
// HEADLESS_SEED_MAX_COMMENTS are kept (with an omission marker), so a
// chatty thread can't blow up the model's context. Exported for tests.
const HEADLESS_SEED_MAX_COMMENTS = 20;
const HEADLESS_SEED_COMMENT_MAX_CHARS = 2000;
function buildHeadlessSeed(issueNumber, issue, comments, botUsername, threadMessages = []) {
  const title = issue ? issue.title : '';
  const body = issue && issue.body ? `\n\n${issue.body}` : '';
  let seed = `Please work on GitHub issue #${issueNumber}: "${title}".${body}`;

  const list = Array.isArray(comments) ? comments : [];
  const thread = Array.isArray(threadMessages) ? threadMessages : [];
  // Nothing on either surface → the seed stays exactly what it has always
  // been (pinned by tests/headless-clarify.test.js).
  if (!list.length && !thread.length) return seed;

  // GitHub comments keep their own most-recent-N cap and per-comment clip;
  // the Homeroom half arrives already clipped by thread-context.
  const kept = list.slice(-HEADLESS_SEED_MAX_COMMENTS);
  const clippedGithub = kept.map((c) => ({
    author: (c.author || 'unknown').toString(),
    body: (c.body || '').toString().length > HEADLESS_SEED_COMMENT_MAX_CHARS
      ? `${(c.body || '').toString().slice(0, HEADLESS_SEED_COMMENT_MAX_CHARS)}… [truncated]`
      : (c.body || '').toString(),
    createdAt: c.createdAt || '',
  }));

  // Inside the same UNTRUSTED DATA warning a person's own session reads its
  // discussion under (buildDiscussionPromptBlock): anyone can comment, on
  // GitHub too, and the Homeroom bot builds from this seed.
  seed += threadContext.buildDiscussionPromptBlock({
    issueBlock: threadContext.buildIssueDiscussionBlock({
      issueNumber,
      githubComments: clippedGithub,
      threadMessages: thread,
      botUsername,
      truncated: list.length > kept.length,
    }),
  });
  return seed;
}

// #178/#196: does the spec still carry a blocking "Questions" section after
// the scout's investigation? Keys on ATX headings whose text begins with
// "Question(s)" / "Open question(s)" — the exact section name the base
// prompt and scout prompt mandate for blockers — then INSPECTS the section
// body: a heading whose body is empty or only a "nothing here" marker
// ("None", "N/A", …) is NOT a blocker, so a scout's habitual
// "### Questions\nNone" no longer parks the run for a human. Only a section
// with real residual content (a list item or sentence) blocks. A false
// positive merely downgrades a buildable spec to a posted-questions
// round-trip; a false negative reproduces the old park-for-human behavior.
// Exported for tests.
//
// Recognized "nothing here" markers (case-insensitive, tolerating trailing
// punctuation and a short trailing clause like "None — resolved from code.").
const QUESTIONS_EMPTY_MARKER_RE = /^(?:none|n\/a|na|no\s+open\s+questions|no\s+questions|no\s+blocking\s+questions|none\s+blocking|nothing\s+blocking)\b/i;

function specHasBlockingQuestions(specMd) {
  const text = specMd || '';
  // Match a Questions-style ATX heading, capturing its level (# count) so we
  // can find where its section ends (next same-or-higher-level heading).
  const headingRe = /^(#{1,6})\s*(?:open\s+)?questions?\b[^\n]*$/gim;
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    const level = m[1].length;
    const bodyStart = m.index + m[0].length;
    // Find the next heading whose level is <= this section's level (a sibling
    // or higher heading); deeper sub-headings stay part of the section.
    const rest = text.slice(bodyStart);
    const stopRe = /^(#{1,6})\s/gm;
    let stop;
    let bodyEnd = rest.length;
    while ((stop = stopRe.exec(rest)) !== null) {
      if (stop[1].length <= level) { bodyEnd = stop.index; break; }
    }
    const body = rest.slice(0, bodyEnd);
    if (questionsBodyHasContent(body)) return true;
  }
  return false;
}

// Strip markdown noise from a Questions section body and decide whether it
// carries a real question (vs. empty or a "None"-style marker).
function questionsBodyHasContent(body) {
  const cleaned = (body || '')
    .split('\n')
    .map((line) => line
      // drop leading list/quote markers
      .replace(/^\s*(?:[-*>]\s*)+/, '')
      // drop emphasis underscores/asterisks anywhere
      .replace(/[_*]/g, '')
      .trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .trim();
  if (!cleaned) return false;
  if (QUESTIONS_EMPTY_MARKER_RE.test(cleaned)) return false;
  return true;
}

// #1959: is a session WAITING ON ITS OWNER? The one verdict behind the
// Improve panel's "Ready for your input" pill (GET /api/me/active-sessions
// ships it as `awaiting_input`), so the panel never claims a session needs
// input when nothing in it is asking.
//
// The transcript already knows. Two things in it are a question the user
// has not answered, and the row ends up here only if the LAST conversational
// row (user or assistant) is the assistant's: once the owner has replied it is their turn that is
// pending, not the assistant's question.
//
//   1. ANSWER CHIPS. The assistant asked with suggest_answers (#32) and the
//      chips are still on screen — `metadata.suggestions` on that last row.
//   2. A SPEC WITH OPEN QUESTIONS. The scout drafted a spec whose Questions
//      section still has content (specHasBlockingQuestions). Only while nothing has been
//      built from it: a session with a pull request is past its spec, which
//      is the precedence fallbackKindForTurn already gives a PR over a spec,
//      and without it a spec built despite its questions would read as
//      waiting for the rest of the session's life.
//
// A turn in flight is never waiting on anyone; the client gates on its live
// busy state, so this only has to be right for an idle row.
function sessionAwaitsInput({ lastTurnRole, lastTurnAsks, prNumber, specMd }) {
  if (lastTurnRole !== 'assistant') return false;
  if (lastTurnAsks === true) return true;
  if (prNumber) return false;
  return specHasBlockingQuestions(specMd);
}

// #1378: the "…and here is what it had already committed" clause of a stop.
//
// Stopping a turn discards work in progress, but not necessarily ALL of it:
// the agent may have committed and pushed before the stop landed. Saying
// only "Stopped." there is actively misleading, because the user's branch
// has moved and re-sending the same request buys them a duplicate run.
//
// Extracted so the RECOVERED path can say the same thing as the live one.
// A recovered turn reaches this from the durable tail milestones
// (active_turn.tail.sha / .pushOk, written by markTurnTail) rather than
// from an in-memory exec result, and those carry no commit COUNT — hence
// `ahead: null` meaning "a commit landed, quantity unknown". A NUMERIC
// ahead is authoritative and 0 means nothing landed, which preserves the
// live path's behaviour exactly (an absent `ahead` there has always read
// as "nothing landed", so that caller passes `?? 0`, not null).
function describeStoppedLanding({ sha = null, ahead = null, pushOk = false } = {}) {
  if (!sha) return '';
  if (ahead != null && !(ahead > 0)) return '';
  const what = ahead != null
    ? `${ahead} change${ahead === 1 ? '' : 's'}`
    : 'changes';
  return `, but it had already committed ${what} to the branch`
    + ` (${String(sha).slice(0, 8)}${pushOk ? ', pushed' : ', not pushed'});`
    + ' no pull request was opened';
}

// The SAME facts describeStoppedLanding renders as a clause, kept as data.
// The sentence stays the record — a notification, a plain-text export and a
// shared transcript all show prose — but a reader should not have to
// parse the prose back out to draw a commit count, and a stop that
// landed commits is the one turn outcome the transcript most needs to state
// precisely. `ahead: null` means "a commit landed, quantity unknown" here
// exactly as it does above; it surfaces as a countless chip rather than as
// a wrong number. `headline` is the sentence WITHOUT the landed clause, so
// the row can put the facts in chips beside it instead of saying them twice.
function stopLandingMeta({ headline, sha = null, ahead = null, pushOk = false } = {}) {
  const landed = !!sha && (ahead == null || ahead > 0);
  return {
    headline,
    commits: landed ? (ahead == null ? null : ahead) : 0,
    sha: landed ? String(sha).slice(0, 8) : null,
    pushOk: landed ? pushOk === true : false,
  };
}

// A missing Codex provider thread can be retried once while the original
// process is still alive: its stop state, prompt hand-off and exact dispatch
// boundary are all observable there. After a platform restart that boundary
// is ambiguous. Recovery therefore never creates or re-dispatches a paid
// attempt. It converts the durable record into a terminal tail and asks the
// user to retry explicitly; the ordinary shared settlement below then closes
// the existing ledger attempt exactly once.
async function resumeRecoveredCodexFreshRetry({ pool, session, activeTurn, result }) {
  if (activeTurn?.backend !== 'codex_openrouter') return null;
  const legacyRetryPhase = activeTurn.phase === 'retry_pending'
    || activeTurn.phase === 'retry_dispatch_pending';
  if (result?.agentRetryFresh !== true && !legacyRetryPhase) return null;

  const message = 'The saved OpenRouter model context became unavailable during a platform restart. '
    + 'For safety, no automatic retry was dispatched; retry this turn to start fresh.';
  const patch = {
    retryFresh: false,
    recoveryFailure: 'restart_retry_requires_user',
    tail: {
      ...((activeTurn.tail && typeof activeTurn.tail === 'object') ? activeTurn.tail : {}),
      sha: activeTurn.tail?.sha || result?.sha || null,
      pushOk: activeTurn.tail?.pushOk === true || result?.pushOk === true,
    },
  };

  const transition = await turnLifecycle.markTailPending(pool, {
    sessionId: session.id,
    turnId: activeTurn.turnId || null,
    journal: activeTurn.turnId ? null : activeTurn.journal,
    turnUuid: activeTurn.turnUuid || null,
    patch,
  });
  const recoveredTurn = transition.activeTurn || {
    ...activeTurn,
    phase: turnLifecycle.PHASE_TAIL_PENDING,
    ...patch,
  };
  return {
    result: {
      ...result,
      resultSeen: true,
      execExitSeen: true,
      exitCode: result?.exitCode && result.exitCode !== 0 ? result.exitCode : 1,
      agentExit: result?.agentExit && result.agentExit !== 0 ? result.agentExit : 1,
      agentRetryFresh: false,
      ccIsError: true,
      fatalError: message,
    },
    activeTurn: recoveredTurn,
  };
}

// #2118: USD to fractional cents at six decimal dollars, the precision the
// ledger's own estimate is read at, so the composer's meter and the reply
// row never disagree with agent_turns.
function codexCostCents(usd) {
  return Math.round(usd * 1e6) / 1e4;
}

// ── Shared per-attempt Codex dispatch (plan 7) ─────────────────────────
// Encapsulates the logical-turn + per-attempt accounting for BOTH the
// scout and build call sites so a retry cannot be merged into the prior
// attempt's ledger row (one physical Codex invocation = one attempt) and
// a retry never reuses a terminal turnUuid. `dispatchOnce(attemptNumber)`
// is provided by the caller and must itself call worker.execInWorker with
// the attempt's turnUuid/logicalTurnId/attemptNumber.
async function runCodexAttemptLoop({
  pool, session, userId, config, isCodexSession, turnModel,
  resumeThreadId, resolveRuntime, dispatchOnce, retryPredicate,
  sendStatus, waitForStopped, prepareRetry, classifyAttemptStatus,
  containerName, mode = 'build', telemetryComponent = null,
  // #6602: whose row startCodexAttempt locks and whose turn it is. The
  // ledger row's user_id stays `userId` (the account whose key pays), so a
  // turn Homeroom bot runs on somebody else's change names its author here.
  sessionOwnerId = null,
  // The work item that runs the turn, when workflow work started it: on
  // every attempt's record (startCodexAttempt) and handed to the dispatch
  // (execInWorker's `owner`).
  owner = null,
}) {
  // One logical turn id per coding-tool invocation (plan 7.1); attempt 1
  // gets attempt_number=1, a retry gets attempt_number=2.
  const logicalTurnId = crypto.randomUUID();
  const runtimeContext = await resolveRuntime();
  if (runtimeContext?.error) return { error: runtimeContext.error, logicalTurnId };
  if (!runtimeContext) return null; // Claude turn — caller handles it.

  // #2118: what the turn cost, as the ledger recorded it. completeCodexAttempt
  // already estimates each attempt from its immutable pricing snapshot
  // (agent_turns.estimated_cost_usd); this sums those over the logical turn
  // and is where the figure becomes visible: published on the session's
  // in-memory progress entry so the /status poll's `spend` carries it while
  // the session is busy (the channel Claude Code's live tracker feeds), and
  // returned so the caller can send the usage receipt and persist it on the
  // reply. Null until an attempt reports a finite estimate: an unpriced
  // model stays unknown, never a false zero.
  let estimatedCostUsd = null;
  const completeAttempt = async (attempt, result, status, err) => {
    const providerFailure = codexOpenRouter.providerFailureDiagnostics(result);
    const completion = await agentTurn.completeCodexAttempt({
      pool,
      turnUuid: attempt.turnUuid,
      status,
      threadId: result?.agentThreadId || null,
      usageTotal: agentTurn.usageTotalFromResult(result
        ? { ...result, agentHarness: runtimeContext.agentHarness }
        : result),
      usageScope: agentTurn.usageScopeForHarness(runtimeContext.agentHarness),
      // The upstream provider OpenRouter named for the turn's requests, when
      // the Claude Code listener saw one (worker.js observeCodingProviderResult).
      routedProvider: result?.routedProvider || null,
      // Run seven (14 Oct 2026): and every one it used, with how many of its
      // requests left the shortlist, for the row's metadata.
      routedProviders: result?.routedProviders || null,
      shortlistFallbacks: result?.shortlistFallbacks ?? null,
      telemetryComponent: result?.providerDispatched === true
        ? (telemetryComponent
          || (mode === 'scout' ? 'coding_agent_scout' : 'coding_agent_build'))
        : null,
      telemetryMetrics: result || null,
      errorCode: err
        ? agentTurn.classifyErrorCode(err)
        : result?.agentRetryFresh ? 'resume_thread_missing'
          // #2676: a classified OpenRouter refusal is a real ledger code.
          // Without this the row's error_code stayed NULL on every provider
          // failure, so errorClassByCode had nothing to read and the turn's
          // telemetry error_class fell back to a shapeless 'provider'.
          : codexLedgerErrorCode(result),
      errorDetail: providerFailure ? JSON.stringify(providerFailure)
        : err ? agentTurn.sanitizeError(err) : null,
    });
    const attemptUsd = completion?.estimatedCost?.estimatedCostUsd;
    if (typeof attemptUsd === 'number' && Number.isFinite(attemptUsd)) {
      estimatedCostUsd = (estimatedCostUsd || 0) + attemptUsd;
      workerProgress.setSpend(session.id, {
        costCents: codexCostCents(estimatedCostUsd),
        estimated: true,
      });
    }
  };

  let lastResult = null;
  let lastError = null;
  let attemptNumber = 0;
  // A thread the runtime refused to resume (it was written by the other CLI,
  // #3296) stays refused even though the caller read it off the session row.
  let attemptResumeThreadId = runtimeContext.resumeThreadDropped
    ? null
    : (resumeThreadId ?? runtimeContext.resumeThreadId ?? null);
  let allowRetryPendingForAttempt = false;
  // #2676: null means "use the runtime's own ceiling". A max_tokens refusal
  // sets it for attempt two so the retry asks for a reply the account can
  // actually pay for.
  let attemptModelMetadata = null;
  const statusFor = ({ result = null, error = null, failed = false } = {}) => {
    const fallback = failed || error ? 'failed' : 'completed';
    if (typeof classifyAttemptStatus !== 'function') return fallback;
    const classified = classifyAttemptStatus({ result, error, failed });
    return ['completed', 'failed', 'cancelled'].includes(classified)
      ? classified
      : fallback;
  };
  for (;;) {
    attemptNumber += 1;
    let attempt;
    try {
      attempt = await agentTurn.startCodexAttempt({
        pool, session, userId, logicalTurnId, attemptNumber,
        model: runtimeContext.agentModel,
        reasoningEffort: runtimeContext.agentReasoningEffort,
        resumeThreadId: attemptResumeThreadId,
        runtimeContext,
        allowRetryPending: allowRetryPendingForAttempt,
        mode,
        owner,
        ...(sessionOwnerId ? { sessionOwnerId } : {}),
        telemetryComponent: telemetryComponent
          || (mode === 'scout' ? 'coding_agent_scout' : 'coding_agent_build'),
      });
    } catch (startErr) {
      // plan 8.5 (Commit 6): a stale-version/busy race surfaces as a
      // structured code so the caller can tell the user the agent context
      // changed under it (no paid dispatch with stale credentials/model).
      if (startErr?.code === 'agent_context_changed') {
        return { error: 'agent_context_changed', errorDetail: agentTurn.sanitizeError(startErr), logicalTurnId };
      }
      if (startErr?.code === 'session_busy') {
        return { error: 'session_busy', errorDetail: agentTurn.sanitizeError(startErr), logicalTurnId };
      }
      return { error: 'ledger_start_failed', errorDetail: agentTurn.sanitizeError(startErr), logicalTurnId };
    }

    let dispatchResult;
    try {
      dispatchResult = await dispatchOnce({
        ...runtimeContext,
        // After the spread on purpose: a clamped retry overrides the ceiling
        // the runtime resolved for attempt one (#2676).
        ...(attemptModelMetadata ? { agentModelMetadata: attemptModelMetadata } : {}),
        // execInWorker consumes resumeSessionId; resumeThreadId is also
        // overridden so custom dispatchers never observe the stale value.
        resumeThreadId: attemptResumeThreadId,
        resumeSessionId: attemptResumeThreadId,
        turnUuid: attempt.turnUuid,
        logicalTurnId,
        attemptNumber,
        journalPath: attempt.journal,
        // A same-process missing-thread retry leaves attempt one in
        // tail_pending until startCodexAttempt atomically installs attempt
        // two's dispatch intent. Persistence stays mandatory at this boundary.
        requireActiveTurnPersistence: allowRetryPendingForAttempt,
        ...(owner ? { owner } : {}),
      });
    } catch (err) {
      lastError = err;
      // The runner already ended; publication/persistence is still owned by
      // its journal. Recovery settles the actual usage and result, without a
      // second paid attempt or a false provider-failure ledger entry.
      if (err?.retainActiveTurn) throw err;
      const observedResult = err?.turnResult || null;
      await completeAttempt(attempt, observedResult, statusFor({
        result: observedResult,
        error: err,
        failed: true,
      }), err);
      throw err;
    }

    lastResult = dispatchResult;
    lastError = null;
    const failed = !!(lastResult?.fatalError || lastResult?.ccIsError
      || (lastResult?.agentExit != null && lastResult?.agentExit !== 0)
      || (lastResult?.exitCode != null && lastResult?.exitCode !== 0));
    // Keep ledger completion outside the dispatch catch. If this required
    // write fails, retrying it with `result = null` would erase the usage we
    // just observed and falsely terminalize the attempt as an empty failure.
    await completeAttempt(attempt, lastResult, statusFor({ result: lastResult, failed }));

    // A stale resume is a runner-to-host retry request for every Codex
    // turn. Markerless headless retries remain caller-controlled. Attempt
    // 1 is ALREADY terminal before attempt 2 starts.
    const retryFresh = lastResult?.agentRetryFresh === true;
    // OpenRouter reports how many output tokens this key can cover. Retry
    // once below that allowance; the refusal does not prove account balance.
    const clampRetry = retryFresh || !failed ? null : codexMaxTokensRetry(lastResult);
    const retryRequested = retryFresh || !!clampRetry
      || (typeof retryPredicate === 'function' && retryPredicate(lastResult));
    if (!retryRequested) break;
    // Guard against spinning: exactly one retry.
    if (attemptNumber >= 2) break;
    if (typeof sendStatus === 'function') {
      const status = retryFresh
        ? 'The saved OpenRouter model context is unavailable, retrying fresh once…'
        : clampRetry
          ? 'OpenRouter rejected the reply limit. Retrying once with a smaller reply limit…'
          : 'The coding step failed unexpectedly, retrying once…';
      try { await sendStatus(status); } catch {}
    }
    if (!retryFresh && typeof waitForStopped === 'function') {
      try { await waitForStopped(session.id, containerName); } catch {}
    }
    // Retry preparation is also the last stop boundary before attempt two.
    // A callback returns false when a user stop landed during the status /
    // wait / durable-state transition; in that case do not create another
    // ledger row and, most importantly, do not launch another paid request.
    if (typeof prepareRetry === 'function') {
      const prepared = await prepareRetry({
        retryFresh,
        attempt,
        logicalTurnId,
        attemptNumber,
        result: lastResult,
      });
      if (prepared === false) break;
    }
    if (retryFresh) attemptResumeThreadId = null;
    if (clampRetry) {
      attemptModelMetadata = {
        ...(runtimeContext.agentModelMetadata || {}),
        maxOutputTokens: clampRetry.clamped,
      };
    }
    allowRetryPendingForAttempt = retryFresh;
  }
  return { result: lastResult, error: lastError, logicalTurnId, estimatedCostUsd };
}

// Retry once at 80% of the reported allowance, leaving room for a changed
// prompt or balance. Respect the catalog floor and never increase the cap
// actually sent: a contradictory refusal needs diagnosis, not a larger bill.
function codexMaxTokensRetry(result, stopHandle) {
  if (!result) return null;
  if (stopHandle && stopHandle.stopped) return null;
  if (result.agentErrorCode !== 'insufficient_credits_max_tokens') return null;
  if (result.providerRequest?.limitSource === 'openrouter_in_flight_budget') return null;
  const affordable = Number(result.affordableOutputTokens);
  if (!Number.isFinite(affordable) || affordable < MIN_MAX_OUTPUT_TOKENS) return null;
  const clamped = Math.max(MIN_MAX_OUTPUT_TOKENS, Math.floor(affordable * 0.8));
  const sent = result.providerRequest?.maxOutputTokens;
  if (Number.isSafeInteger(sent) && clamped >= sent) return null;
  return { clamped };
}

// #2676: both credit codes land on the ledger's own `insufficient_credits`,
// which is the code errorClassByCode bills as 'billing'.
const CODEX_LEDGER_ERROR_CODES = {
  insufficient_credits: 'insufficient_credits',
  insufficient_credits_max_tokens: 'insufficient_credits',
  rate_limited: 'rate_limited',
  credential_failure: 'credential_failure',
};
function codexLedgerErrorCode(result) {
  // 17 Oct 2026: a turn whose worker went from under it (OOM-killed, its
  // container gone) is the worker's failure, not the provider's: without a
  // code its row read error_class 'provider'. Why is in its telemetry
  // (markerless_cause).
  if (result?.markerlessCause) return 'worker_lost';
  return CODEX_LEDGER_ERROR_CODES[result?.agentErrorCode] || null;
}

// A person's Stop of the turn on a change (POST /api/sessions/:id/stop). The
// caller receives an HTTP-shaped result with common ownership, durable
// intent and confirmation.
async function requestSessionStop({ pool, sessionId, user, force = false, expectedTurnId = null }) {
    // #1378: owner OR an admin who is allowed to WRITE. GET
    // /api/sessions/:id is admin-readable and GET .../status has no
    // ownership guard at all, so an admin could already watch someone
    // else's runaway turn — but this route was owner-only, so their stop
    // came back 404 and the client rendered "Couldn't stop the agent". An
    // admin who can see a turn burning platform capacity must be able to
    // end it.
    //
    // Deliberately `canAdminWrite` and not `isAdmin`: the latter includes
    // view-only admins, and killing someone's in-flight turn is a
    // privileged mutation (same gate middleware/admin.js uses).
    const stopAsAdmin = user?.canAdminWrite === true;
    try {
      let { rows } = await pool.query(
        `SELECT id, user_id FROM chat_sessions WHERE id = $1 AND (user_id = $2 OR $3::boolean)`,
        [sessionId, user.id, stopAsAdmin]
      );
      // Homeroom bot parity (P5): the bot's build of a request may also be
      // stopped by whoever asked for it, or by its project's owner
      // (services/homeroom-bot-steer.js mayStopBotBuild).
      if (!rows.length && await require('../services/homeroom-bot-steer').mayStopBotBuild(pool, sessionId, user)) {
        ({ rows } = await pool.query('SELECT id, user_id FROM chat_sessions WHERE id = $1', [sessionId]));
      }
      if (!rows.length) return { status: 404, body: { error: 'Session not found' } };
      if (rows[0].user_id !== user.id) {
        log.info('sessions', 'Admin stopping another user\'s turn', {
          sessionId, by: user.username, ownerId: rows[0].user_id,
        });
      }
    } catch (err) {
      log.error('sessions', 'Stop session lookup failed', { message: err.message });
      return { status: 500, body: { error: 'Internal server error' } };
    }

    // A turn the platform runs on this session (a sync with main, the shots
    // agent, the Homeroom bot's build, read or fix), starting or running,
    // in whichever process: the Stop is an event to the machine whose work
    // runs it, which records it as stopped by this person, ends its work
    // and stops that turn (Q1 of the bot-loop step). No bus forward and no
    // stop handle: the machine's instance is where it lands, the turn
    // being spun up included.
    const platform = require('../workflow/platform.ts');
    const owned = await platform.stopWorkflowTurn({ sessionId: Number(sessionId), by: user.username, expectedTurnId });
    if (owned) return owned;

    // #937: `{ force: true }` is offered after a normal stop has visibly
    // failed to land (its 40s rung). Strictly second-order: it is only
    // honoured once a stop is already pending for this turn.
    const forceRequested = force === true;

    // What is left is a turn no machine's work holds: one being recovered
    // (services/turn-recovery.js), whose handle is in the process following
    // it, and the durable path below (the stamp, and the kill inside the
    // worker), which reaches a turn from any process.
    const capturedTurn = await turnLifecycle.loadActiveTurn(pool, sessionId);
    const expectedJob = {
      active: !!capturedTurn, turnId: turnLifecycle.turnIdentity(capturedTurn), journal: capturedTurn?.journal || null,
    };
    const handle = stopRegistry.get(sessionId);
    if (expectedTurnId) {
      if (turnLifecycle.turnIdentity(capturedTurn) !== expectedTurnId) {
        return { status: 409, body: { error: 'The running job changed. Refresh its status before stopping it.', code: 'turn_changed' } };
      }
    }
    const action = stopPolicy.classifyStopRequest({ handle, force: forceRequested });

    if (action === 'no_active_turn') {
      const durable = capturedTurn;
      if (durable && turnLifecycle.RECOVERABLE_PHASES.has(turnLifecycle.phaseOf(durable))) {
        if (turnLifecycle.turnIdentity(durable) || durable.journal) {
          const marked = await turnLifecycle.markStopRequested(pool, {
            sessionId, turnId: turnLifecycle.turnIdentity(durable), journal: durable.journal, by: user.username,
          });
          if (turnLifecycle.turnIdentity(marked.activeTurn) !== turnLifecycle.turnIdentity(durable)) {
            return { status: 409, body: { error: 'The running job changed. Try Stop again.', code: 'turn_changed' } };
          }
        }
        // A different process may own the journal consumer. The durable
        // request survives its restart; signalling the worker ends the job,
        // and only its normal cleanup/recovery releases the busy record.
        worker.noteStopPending(sessionId, user.username);
        await requestOrdinaryStop(sessionId, user, { expectedTurnId, expectedJob });
        return { status: 202, body: { stopped: true, stopping: true } };
      }
      // #1378: this used to return silently, which is why the production
      // report had nothing to go on — the click landed, the server said
      // "nothing to stop", and the only trace was the user watching a turn
      // keep running. Log the disagreement between what the client can see
      // (`busy`) and what this process holds (`handle`), because that gap
      // IS the bug class: a turn adopted by another process, or one whose
      // handle was cleared while the tail is still unwinding.
      let hasDurableTurn = false;
      try {
        hasDurableTurn = !!(await turnLifecycle.loadActiveTurn(pool, sessionId));
      } catch {}
      log.warn('sessions', 'Stop request had no active turn', {
        sessionId,
        busy: isSessionBusy(sessionId),
        hasDurableTurn,
        by: user.username,
      });
      return { status: 200, body: {
        ok: true, stopped: false, reason: 'no active turn', hasDurableTurn,
      } };
    }
    if (action === 'force_orphan') {
      // The turn already ended, but its bookkeeping may not have — this is
      // how a client whose turn died without unwinding gets it cleaned up.
      await requestForceStop(sessionId, user, null, { expectedTurnId, expectedJob });
      return { status: 200, body: { ok: true, stopped: true, forced: true, phase: null } };
    }
    if (action === 'force_without_stop') {
      return { status: 409, body: {
        ok: false, stopped: false, reason: 'no stop pending',
      } };
    }

    handle.stopped = true;
    handle.stoppedBy = user.username;
    // Spin-up gates must see the intent before aborting or awaiting admission.
    if (stopRegistry.get(sessionId) === handle) worker.noteStopPending(sessionId, user.username);
    // #937: stamped once, on the FIRST stop for this turn, so the client's
    // escalation ladder survives a reload (GET /status serves it) and a
    // repeat POST — the 15s retry — doesn't reset the user's clock.
    if (!handle.stopRequestedAt) handle.stopRequestedAt = Date.now();
    log.info('sessions', 'Stop requested', {
      sessionId,
      phase: handle.phase,
      by: user.username,
      ccRunning: handle.phase === 'cc',
      hasWorker: !!handle.workerName,
      forced: forceRequested,
    });

    // #889: announce the stop on every channel BEFORE any of the work
    // below. The turn's own `send` fans this out to the global WS broadcast,
    // so every tab of the session's owner (not just the one that clicked)
    // hears "stopping" immediately instead of waiting for the turn to
    // unwind. It's a synchronous broadcast, so nothing here waits on it.
    try {
      handle.send?.('stopping', {
        by: user.username,
        phase: handle.phase,
        // #937: lets a tab that joins (or reloads) mid-stop rebuild the
        // escalation ladder at the right rung instead of restarting it.
        stopRequestedAt: handle.stopRequestedAt,
      });
    } catch {}

    // #1378: the same intent, recorded durably on the turn record.
    //
    // The in-memory stamp above is the fast path and is what ends the turn
    // in every ordinary case. It cannot survive this process, though, and a
    // blue-green cutover landing in the same second as the click would take
    // it: the version that adopts the turn would resume it, narrate an
    // interruption the user had already asked for, and — on an api-error
    // tail — retry it. buildRecoveryStopHandle (turn-recovery.js) reads this stamp
    // at adopt time and seeds the recovered turn's handle from it, which is
    // what closes that window.
    //
    // It also leaves the only durable trace a pending stop has ever had:
    // this incident was diagnosed with no record in the log OR the database
    // that a stop had been asked for at all.
    //
    // Best-effort. The stamp is a compare-and-set against the turn identity
    // and is a quiet no-op for a legacy row with neither a turnId nor a
    // journal; none of that is a reason to refuse a stop the handle can
    // already honour, so a failure here only warns.
    try {
      const durableTurn = capturedTurn;
      if (durableTurn && (durableTurn.turnId || durableTurn.journal)) {
        await turnLifecycle.markStopRequested(pool, {
          sessionId,
          turnId: durableTurn.turnId || null,
          journal: durableTurn.journal || null,
          by: user.username,
        });
      }
    } catch (err) {
      log.warn('sessions', 'Durable stop stamp failed', {
        sessionId, err: err.message,
      });
    }

    if (action === 'force') {
      // The conductor confirms termination; the web never kills or evicts.
      try { handle.abort.abort(); } catch {}
      await requestForceStop(sessionId, user, handle, { expectedTurnId, expectedJob });
      return { status: 200, body: { ok: true, stopped: true, forced: true, phase: handle.phase } };
    }

    // Cancel the local stream before waiting for admission.
    try { handle.abort.abort(); } catch {}
    try {
      await requestOrdinaryStop(sessionId, user, { expectedTurnId, expectedJob });
    } catch (err) {
      // The captured turn is already stopped. A replacement record is
      // fenced out; its own dispatcher handles a Stop crossing spin-up.
      if (err.code !== 'turn_changed') throw err;
    }

    return { status: 200, body: { ok: true, stopped: true, phase: handle.phase } };
}

// Only admission is awaited. Confirmation's timer and attempts are durable;
// the owning turn still unwinds and releases its own record and local hold.
async function requestOrdinaryStop(sessionId, user, { expectedTurnId = null, expectedJob } = {}) {
  await require('../workflow/platform.ts').requestWorkerInterrupt({ sessionId, userId: user.id, strategy: 'turn', expectedTurnId, expectedJob });
}

// A force stop's runtime effects are the conductor's. The originating
// process only releases the exact local handle once termination is confirmed.
async function requestForceStop(sessionId, user, handle, { expectedTurnId = null, expectedJob } = {}) {
  const generation = activeWorkers.generation(sessionId);
  worker.noteStopPending(sessionId, user.username);
  await require('../workflow/platform.ts').requestWorkerStop({ sessionId, userId: user.id, expectedTurnId, expectedJob });
  const current = stopRegistry.get(sessionId);
  if (current === handle || (!current && !handle)) {
    activeWorkers.deleteIf(sessionId, generation);
    stopRegistry.deleteIf(sessionId, handle);
    try { handle?.send?.('stopped', { phase: handle.phase, by: user.username, forced: true }); handle?.send?.('done', {}); } catch {}
  }
}

function describeStagingFailure(stagingErr) {
  let fix;
  let missingKeys = [];
  if (stagingErr instanceof staging.PrivateSecretMissingStagingDefaultError) {
    missingKeys = stagingErr.missingKeys || [];
    fix =
      `The PR's \`dapp.json\` declares ${missingKeys.length === 1 ? 'a secret' : 'secrets'} ` +
      `[${missingKeys.join(', ')}] as \`required\` + \`private\` (or the legacy alias \`sensitive: true\`), ` +
      `but with no \`staging_default\` (or \`default\`). Private secrets are intentionally NOT ` +
      `propagated from prod into staging clones, so without a manifest fallback the staging ` +
      `build refuses to start. ` +
      `\n\nFix: add \`"staging_default": "<value>"\` to each ${missingKeys.length === 1 ? 'entry' : 'entry'} in \`dapp.json\`. ` +
      `If the app's code degrades gracefully when the secret is unset, use the empty string \`""\`. ` +
      `For paid services use a vendor sandbox key (e.g. a mapping API's test key). ` +
      `Never copy the prod value into \`staging_default\`. ` +
      `See \`app-conventions.md\` "Public vs private secrets" for the full rubric. ` +
      `\n\nThe agent can apply this fix directly: dispatch \`dispatch_claude_code\` with a prompt ` +
      `like "edit dapp.json so each of [${missingKeys.join(', ')}] has staging_default set to <chosen value>".`;
  } else if (stagingErr instanceof staging.MissingSecretsError) {
    missingKeys = stagingErr.missingSecrets || [];
    fix =
      `The PR's \`dapp.json\` declares ${missingKeys.length === 1 ? 'a required secret' : 'required secrets'} ` +
      `[${missingKeys.join(', ')}] that ${missingKeys.length === 1 ? 'has' : 'have'} no stored value in this ` +
      `app's secret store, and no \`default\` in the manifest. ` +
      `\n\nFix: an admin needs to set ${missingKeys.length === 1 ? 'this value' : 'these values'} in the platform UI ` +
      `(Settings → Secrets) before staging can build. The agent CANNOT fix this from code — ` +
      `secret values are intentionally not committed to source. ` +
      `If a manifest \`default\` is appropriate (i.e. the value is genuinely public), the agent can ` +
      `instead add it to \`dapp.json\` via \`dispatch_claude_code\`.`;
  } else {
    fix =
      `Underlying error: ${(stagingErr && stagingErr.message) || String(stagingErr)}. ` +
      `This is most likely an infrastructure or build-time failure (Docker build, network, ` +
      `image cache, etc.) rather than a manifest issue. The agent can suggest the user retry, ` +
      `inspect platform logs, or — if the build error message implicates the dapp's own code — ` +
      `dispatch \`dispatch_claude_code\` to investigate.`;
  }

  // Defensive: if buildAndDeployStaging ever returned null/undefined
  // without throwing (it shouldn't — its contract is throw-or-return-
  // result), stagingErr would be null here. Coerce so callers still emit
  // a meaningful event instead of NPE'ing.
  const errMsg = (stagingErr && stagingErr.message) || 'Unknown staging failure (no error thrown but no result returned)';
  const errName = (stagingErr && stagingErr.name) || 'Error';
  return { fix, missingKeys, errMsg, errName };
}

// ── Steps of a recovered build turn's tail ─────────────────────────────
//
// services/turn-recovery.js finalizeRecoveredTurn ends a build turn whose
// process went, and a restart can land between any two of its steps, so a
// tail run again repeats only what the one before it had not finished.

// The staging outcome card ("Staging deployed!" / "Staging build failed"),
// written once per durable turn. The card, its tail checkpoint and the
// receipt commit together, under one receipt key: a restart after the card
// was written finds the receipt and writes no second one. `turnId` null (a
// legacy record) writes the row without a receipt. `tailIdentity` names the
// held record the checkpoint merges into (turnLifecycle.cleanupArgs), or is
// null when there is none. Resolves { applied, outcome, metadata, failure,
// checkpoint }: what the receipt holds when it was already written.
async function publishStagingOutcome({
  pool, sessionId, turnId = null, tailIdentity = null,
  outcome, metadata, failure = null,
}) {
  // 'building': the preview machine (WF_PREVIEWS_ENABLED) builds it; the
  // card says so, and its Preview button comes with the machine's
  // staging_ready.
  const succeeded = outcome === 'success' || outcome === 'building';
  const content = outcome === 'building' ? 'Building staging preview...'
    : succeeded ? 'Staging deployed!' : 'Staging build failed';
  const checkpoint = succeeded
    ? { stagingPublished: true }
    : { stagingPublished: true, stagingFailed: failure || { errMsg: metadata?.error || 'Staging build failed' } };
  const persist = async (client) => {
    await client.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [sessionId, content, JSON.stringify(metadata || {})],
    );
    if (tailIdentity) {
      await turnLifecycle.mergeTailMilestones(client, {
        sessionId, ...tailIdentity, milestones: checkpoint,
      });
    }
    return { outcome, metadata, failure, checkpoint };
  };
  if (!turnId) return { applied: true, content, ...(await persist(pool)) };
  const receipt = await turnEffects.runDbEffect({
    pool,
    turnId,
    effectKey: turnEffects.EFFECT_KEYS.RECOVERED_STAGING_PUBLICATION,
    sessionId,
    run: persist,
  });
  return {
    applied: receipt.applied,
    content,
    ...(receipt.value || { outcome, metadata, failure, checkpoint }),
  };
}

// A promoted proposal's new commit, once its preview is up: the votes cast
// on the old version stop counting (retired, not deleted: services/
// vote-revision.js), dapp.json's admins are re-read, and the proposal's own
// thread is told. The caller stamps its votesResetFor milestone BEFORE
// calling, so a resumed tail never re-announces a reset. The line goes to
// the proposal's thread and nowhere else: a platform line names its thread
// or is not written (ws.sendSystemMessage writes nothing without one).
async function retireVotesForNewCommit({ pool, session, sessionId = session.id, commitHash }) {
  // #788: the new commit may have added or removed a name in dapp.json's
  // `admins` block. Best-effort (swallows GitHub failures) and re-verified
  // authoritatively in evaluateMergeGate.
  await require('../services/app-admins').refreshExplicitApproval(pool, session, session);
  const { sendSystemMessage, pushVoteUpdate } = require('../services/ws');
  return require('../services/vote-revision').retireAndRecheck(
    pool, { ...session, id: sessionId }, commitHash,
    {
      announce: async ({ retired: dropped }) => {
        pushVoteUpdate({ sessionId, appSlug: session.app_slug, merged: false });
        const resetMsg = `An update was pushed to PR #${session.pr_number || sessionId} (commit ${commitHash.substring(0, 8)}). Earlier votes were on the old version, so take another look.`;
        await sendSystemMessage(pool, session.app_id, resetMsg, 'system',
          null, { type: 'session', ref: sessionId }).catch(() => {});
        log.info('sessions', 'Retired PR votes after new commit', {
          sessionId, commitHash: commitHash.substring(0, 8), votesRetired: dropped,
        });
      },
    },
  );
}

module.exports = { requestSessionStop, changePlanFor, attachChangePlans, canViewSession, summarizeFailingChecks, describeStoppedLanding, stopLandingMeta, runCodexAttemptLoop, resumeRecoveredCodexFreshRetry, sessionRoutes, getActiveWorkerCount, persistBehindMain, buildSpecPreview, stripSpecWrapperFence, captureSpecOutput, snapshotSessionSpec, persistScoutPublication, describeStagingFailure, publishStagingOutcome, retireVotesForNewCommit, buildHeadlessSeed, specHasBlockingQuestions, codexMaxTokensRetry, resumePausedSession };
// #4524: the topic page's fast open asks GET /api/apps/:slug/proposals/:id
// for its item beside the board load, and production serves an active or
// paused session there when it is the viewer's own or shared. The demo rows
// the generators above make live only in the session lists' responses, so
// the single proposal route resolves them through these same generators
// (see its staging fallback in routes/votes.js).
module.exports.stagingMockOwnSessions = stagingMockOwnSessions;
module.exports.stagingMockSharedSessions = stagingMockSharedSessions;
