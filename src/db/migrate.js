const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getPool } = require('./pool');
const log = require('../services/logger');
const appManifest = require('../services/app-manifest');
const dbManager = require('../services/db-manager');
const { encrypt } = require('../services/secrets');
// #1037: the draft-card row copy lives with the service that writes real
// drafts, so the staging fixture can't drift from what production emits.
const issueDraftSvc = require('../services/issue-draft');
const { reindexAfterHostMove } = require('./reindex-after-host-move');
// Read by seedStagingPlatformMail's at-the-ceiling fixture, so the number
// of seeded sends tracks the rule instead of restating it.
const mailRateLimit = require('../services/mail/rate-limit');

async function migrate(config) {
  const startedAt = Date.now();
  const timings = {};
  let phaseStartedAt = startedAt;
  const finishPhase = (name) => {
    const finishedAt = Date.now();
    timings[name] = finishedAt - phaseStartedAt;
    phaseStartedAt = finishedAt;
  };
  const pool = getPool(config);

  const schema = fs.readFileSync(
    path.join(__dirname, 'schema.sql'),
    'utf-8'
  );

  // #687 (PR-import, Slice 1): READ-ONLY pre-flight guard. Run BEFORE the
  // schema apply so we abort the boot cleanly (before any DDL) if the
  // invariant the PR-import feature is about to rely on is already
  // violated in this database. Read-and-throw only — it never mutates.
  await auditDuplicatePrSessions(pool);
  finishPhase('preflightMs');

  log.info('db', 'Running migrations...');
  await applySchemaWithLockRetry(pool, schema);
  log.info('db', 'Schema up to date');
  finishPhase('schemaMs');

  // One-off after the 2026-09 database host move: rows written before the
  // move were no longer findable through their unique text indexes (the
  // MCP connector's registered client was the first casualty). Runs BEFORE
  // every seed below because they look rows up by text key and insert when
  // nothing comes back — against a broken index that manufactures
  // duplicates. Marker-guarded; see src/db/reindex-after-host-move.js.
  await reindexAfterHostMove(pool);
  finishPhase('reindexMs');

  await seedAdmin(pool, config);
  await seedCaptureUser(pool);
  await seedCaptureAdminUser(pool);
  // Must run BEFORE every staging fixture — a dozen of them own rows via a
  // hard-coded created_by = 900001. See seedStagingDemoUser.
  await seedStagingDemoUser(pool);
  await seedStagingAdminDetailsUser(pool);
  await seedStagingSupportUser(pool);
  await seedStagingDuplicateUser(pool);
  await seedSelfApp(pool, config);
  finishPhase('coreSeedMs');
  await seedStagingNotifications(pool, config);
  // #1130: must run AFTER seedStagingNotifications — its delivery rows hang
  // off a notification id that seeder owns.
  await seedStagingPushDeliveries(pool, config);
  await seedStagingAdminConsoleData(pool);
  await seedStagingEnvProposal(pool, config);
  await seedStagingMergedPrs(pool, config);
  // Must run AFTER seedStagingMergedPrs — its snapshot dates are chosen
  // so the merged fixtures straddle the newest one (reporting-period).
  await seedStagingReportSnapshots(pool, config);
  await seedStagingMyOpenPr(pool, config);
  await seedStagingImportedPrProposal(pool, config);
  await seedStagingChecksAdvisoryCard(pool, config);
  await seedStagingExternalAgentProposal(pool, config);
  await seedStagingRestartEligibleMerge(pool, config);
  await seedStagingOtherUserProposal(pool, config);
  await seedStagingTopicScrollThreads(pool, config);
  await seedStagingArchiveProposalFixtures(pool, config);
  await seedStagingActiveSessions(pool, config);
  await seedStagingStartScreenSession(pool, config);
  await seedStagingAgentSession(pool, config);
  await seedStagingSavedDrafts(pool, config);
  await seedStagingDraftDelete(pool, config);
  await seedStagingVenueLine(pool, config);
  await seedStagingDevFlowWizard(pool, config);
  await seedStagingSessionOptions(pool, config);
  await seedStagingNoBranchSession(pool, config);
  await seedStagingSharedSession(pool, config);
  // #945: must run AFTER seedStagingSharedSession — the proposal-thread
  // half hangs off that fixture's session id.
  await seedStagingDiscussionContext(pool, config);
  // Must run AFTER seedStagingSharedSession — it forks that fixture's rows.
  await seedStagingForkedChat(pool, config);
  await seedStagingCcProgressRun(pool, config);
  await seedStagingTranscriptShowcase(pool, config);
  await seedStagingQuestionnaire(pool, config);
  await seedStagingCcEstimateRun(pool, config);
  await seedStagingCcCohortRuns(pool, config);
  await seedStagingPlatformIssueDrafts(pool, config);
  await seedStagingDemoAppCard(pool);
  // Must run AFTER seedStagingDemoAppCard — it focuses the demo app row.
  await seedStagingAgentOpenAppSession(pool, config);
  await seedStagingLandingDirectory(pool);
  await seedStagingFailedApp(pool, config);
  await seedStagingForkLineage(pool, config);
  // After the fork fixtures: it switches one of them into demo mode.
  await seedStagingDemoMode(pool);
  await seedStagingMembersPanel(pool);
  await seedStagingUserDirectory(pool);
  await seedStagingApproverPanel(pool);
  await seedStagingAppAdminsPanel(pool);
  await seedStagingReadonlyDevTab(pool);
  await seedStagingQuietDiscussion(pool);
  await seedStagingYourApps(pool, config);
  await seedStagingBrowseCardBranches(pool, config);
  // #1383: must run AFTER seedStagingBrowseCardBranches (it ranks that
  // fixture's four apps) and AFTER seedStagingMergedPrs, which owns the
  // self-app's merged history.
  await seedStagingAppSortSignals(pool);
  // Must run AFTER seedStagingYourApps — it features that fixture's apps.
  await seedStagingFeaturedApps(pool);
  await seedStagingAppQuotaUsers(pool);
  // Must run AFTER seedStagingYourApps (it references those demo apps) and
  // AFTER seedStagingAppQuotaUsers (it seeds the zero-quota fixture's grid).
  await seedStagingHomeLayout(pool, config);
  await seedStagingViewOnlyAdmin(pool);
  await seedStagingWalletUsers(pool);
  await seedStagingEmailCodeAccounts(pool);
  await seedStagingPublicApiContributors(pool);
  await seedStagingVisuals(pool);
  await seedStagingLeaderboardProfile(pool);
  await seedStagingQaSession(pool, config);
  await seedStagingCloneQuestionSuggestions(pool, config);
  await seedStagingCloneSpecPills(pool, config);
  await seedStagingRestartRecoveredPills(pool, config);
  await seedStagingGeneralChannel(pool);
  await seedStagingQuickReplyFallback(pool, config);
  await seedStagingChatAttachments(pool, config);
  await seedStagingGroupChatAttachments(pool, config);
  await seedStagingAppFiles(pool);
  await seedStagingSpecViewerSessions(pool, config);
  // Must run AFTER seedStagingDemoUser — the fixture session is owned by
  // the demo user so the check viewer exercises the NON-owner spec panel.
  await seedStagingSharedSpecPanelSession(pool, config);
  await seedStagingDemoProposal(pool, config);
  await seedStagingSpecUserShareFixtures(pool, config);
  await seedStagingHeadlessFixtures(pool, config);
  await seedStagingSyncActivity(pool, config);
  await seedStagingBootstrapFailure(pool, config);
  await seedStagingChatEditFixtures(pool, config);
  await seedStagingLlmUsage(pool);
  await seedStagingWeeklyCaps(pool);
  await seedStagingSpendDistribution(pool);
  await seedStagingCapReached(pool, config);
  await seedStagingAppCapApps(pool, config);
  await seedStagingSystemTokenUsage(pool);
  await seedStagingDashboardAdminSplit(pool);
  await seedStagingAnalyticsCharts(pool);
  await seedStagingTopicAttributes(pool, config);
  await seedStagingSubmittedFeatures(pool, config);
  await seedStagingDbExports(pool);
  // After the proposal seeds above: the platform-env fixture stamps a
  // failing verdict onto an existing staging proposal.
  await seedStagingPlatformEnv(pool, config);
  await seedStagingTopochain(pool, config);
  // Must run AFTER seedStagingTopochain (it decorates the same three viewer
  // identities) and AFTER seedStagingLeaderboardProfile (it decorates that
  // seed's 900001 / 900002 fixture accounts).
  await seedStagingProfileCustomization(pool, config);
  await seedStagingPlatformMail(pool);
  finishPhase('stagingFixturesMs');
  await sweepInterruptedDbExports(pool);
  await backfillEvents(pool);
  await backfillVotesRequired(pool);
  // Must run BEFORE backfillOrphanedSpecDrafts: unwrapping spec_md after that
  // freezes a wrapped version would leave the frozen copy wrapped while the
  // live buffer is clean, churning a new version on every boot.
  await backfillFenceWrappedSpecs(pool);
  await backfillOrphanedSpecDrafts(pool);
  await backfillLinkedIssuesFromPrBodies(pool);
  await backfillProposalIssuerAssignments(pool);
  await backfillUsernameChoiceForEmailHandles(pool);
  await migrateWaitlistCountryCodes(pool);
  await revokeLegacyGithubGrants(pool, config);
  await failOrphanedHeadlessRuns(pool);
  await migrateAppDbsToPerRole(pool, config);
  finishPhase('maintenanceMs');
  timings.totalMs = Date.now() - startedAt;
  log.info('db', 'Migration phases complete', timings);
  return timings;
}

// Proposal authorship predates proposal-level assignee votes, so existing
// open work may have an owner but no assignment. Seed only genuinely missing
// proposal fields: any explicit proposal-level vote wins, even when it names
// somebody other than the issuer. Headless work is sponsored rather than
// issued by its user_id, and maintenance proposals belong to the platform,
// so neither is assigned by this human-work backfill.
async function backfillProposalIssuerAssignments(pool) {
  const result = await pool.query(
    `INSERT INTO topic_attribute_votes
       (app_id, target_type, target_ref, field, value, user_id)
     SELECT cs.app_id, 'proposal', cs.id, 'assignee', BTRIM(u.username), cs.user_id
       FROM chat_sessions cs
       JOIN users u ON u.id = cs.user_id
      WHERE cs.status IN ('active', 'paused', 'promoted', 'merging')
        AND cs.is_headless = FALSE
        AND cs.source IS DISTINCT FROM 'maintenance'
        AND NULLIF(BTRIM(u.username), '') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM topic_attribute_votes tav
           WHERE tav.app_id = cs.app_id
             AND tav.target_type = 'proposal'
             AND tav.target_ref = cs.id
             AND tav.field = 'assignee'
        )
     ON CONFLICT (app_id, target_type, target_ref, field, user_id) DO NOTHING`
  );
  if (result.rowCount) {
    log.info('db', 'Backfilled proposal issuer assignments', { count: result.rowCount });
  }
  return result.rowCount || 0;
}

// #2563: accounts email sign-up gave their own address as a handle get the
// same first-run "choose your username" step at their next sign-in.
//
// The match is `LOWER(username) = LOWER(email)` — an exact identity between
// two columns of the same row, not a "does this look like an email address"
// shape test. A member who registered the handle `ada.lovelace` through the
// activation-code route is not touched by it, and neither is one whose
// address happens to contain their handle.
//
// Safe to re-run on every boot, which is what makes it a backfill rather
// than a one-shot: choosing a handle clears the flag AND makes the username
// stop matching the email, so a completed account can never be re-flagged.
async function backfillUsernameChoiceForEmailHandles(pool) {
  const result = await pool.query(
    `UPDATE users
        SET needs_username_choice = TRUE
      WHERE needs_username_choice = FALSE
        AND email IS NOT NULL
        AND LOWER(username) = LOWER(email)`
  );
  if (result.rowCount) {
    log.info('db', 'Flagged email-as-username accounts for a username choice', {
      count: result.rowCount,
    });
  }
  return result.rowCount || 0;
}

// The schema apply is dozens of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` /
// `CREATE INDEX IF NOT EXISTS` statements; each needs a brief ACCESS
// EXCLUSIVE lock on its table even when it turns out to be a no-op. A
// concurrent pg_dump of this same database — every staging-preview build of
// the self-app runs one, via `docker exec` inside the usernode-db container,
// where it survives the platform container being recreated mid-deploy —
// holds ACCESS SHARE on every table for its whole multi-minute duration
// (~10 GB as of 2026-07). A bare `pool.query(schema)` queues behind it
// silently until the deploy's 120s health gate expires and rolls the deploy
// back with no diagnostics (2026-07-30 incident, Actions run 30578204174).
//
// lock_timeout bounds only lock *acquisition* waits, never statement
// runtime, so a legitimately slow DDL (a new index on a big table) is
// unaffected. On timeout Postgres raises 55P03; we log every active session
// on the database (the blocker is visible there — pg_dump shows up under
// application_name) and retry. Dumps always finish, so waiting in bounded,
// observable slices strictly dominates one unbounded invisible wait.
//
// The statements are idempotent, so a mid-script timeout is safe to rerun:
// the simple-query protocol runs the whole multi-statement string in one
// implicit transaction, and a failure rolls all of it back.
const SCHEMA_LOCK_TIMEOUT = '10s';
const SCHEMA_APPLY_RETRIES = 25; // × (10s timeout + 3s delay) ≈ 5.4 min cap
const SCHEMA_RETRY_DELAY_MS = 3000;

async function applySchemaWithLockRetry(pool, schema) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(`SET lock_timeout = '${SCHEMA_LOCK_TIMEOUT}'`);
      await client.query(schema);
      return;
    } catch (err) {
      if (err.code !== '55P03' || attempt >= SCHEMA_APPLY_RETRIES) throw err;
      log.warn('db', 'Schema apply blocked on a table lock; retrying', {
        attempt, maxAttempts: SCHEMA_APPLY_RETRIES,
        lockTimeout: SCHEMA_LOCK_TIMEOUT,
      });
      await logSchemaApplyBlockers(pool);
      await new Promise((resolve) => setTimeout(resolve, SCHEMA_RETRY_DELAY_MS));
    } finally {
      // Destroy rather than release: the session-level lock_timeout must
      // not leak back into the shared pool.
      client.release(true);
    }
  }
}

// Best-effort visibility into WHO we were queued behind. Logged once per
// blocked attempt so a stuck deploy's container logs answer "waiting on
// what?" directly instead of requiring a live pg_stat_activity session.
async function logSchemaApplyBlockers(pool) {
  try {
    const { rows } = await pool.query(`
      SELECT pid, usename, application_name, state, wait_event_type,
             (now() - query_start)::text AS running_for,
             left(query, 160) AS query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state IS DISTINCT FROM 'idle'
      ORDER BY query_start ASC
      LIMIT 10
    `);
    log.warn('db', 'Active sessions on this database during schema-apply lock wait', {
      sessions: rows,
    });
  } catch (err) {
    log.warn('db', 'Could not inspect schema-apply blockers', { message: err.message });
  }
}

// #687 (PR-import, Slice 1): READ-ONLY boot audit. The PR-import feature
// treats (app_id, pr_number) as unique for imported proposals — the Slice 2
// import route rejects a duplicate, and a partial UNIQUE index is planned
// once imported rows exist. Before we commit to that invariant we verify it
// holds in THIS database today, and abort the boot loudly if it doesn't so
// nobody enables the feature on top of conflicting rows.
//
// Guardrails (this function is one of the two explicitly-approved migrate.js
// edits): it is strictly READ-AND-THROW — no INSERT/UPDATE/DELETE, no DDL,
// no backfill. It runs BEFORE the schema apply, so on a brand-new database
// the chat_sessions table doesn't exist yet; the to_regclass check makes it
// a clean no-op in that case rather than erroring on a missing relation.
// A production run of the same query returned zero rows, so this is a silent
// pass on the real boot; it only ever fires if data drifts into conflict.
//
// SCOPE — imported rows only, and only LIVE ones (see the status filter
// below). The invariant PR-import relies on (and any future partial UNIQUE
// index must encode the same way) is `(app_id, pr_number) WHERE source =
// 'imported' AND status IN ('promoted','merging','merged')`.
// NATIVE sessions can legitimately share an (app_id, pr_number)
// — most concretely, the staging seed fixtures deliberately reuse fake PR
// numbers across different native fixtures, which a broad audit would (and
// did) abort staging boot on, the very environment this feature is meant to
// be testable in. The `source = 'imported'` (with the source column NULL for
// every native/legacy row) filter keeps the prod result identical (zero — no
// imported rows exist yet) while only ever guarding the rows the invariant
// actually covers. The to_regclass guard also covers pre-Slice-1 databases
// where the `source` column doesn't exist yet: the schema apply that follows
// adds it, and a fresh DB skips entirely above.
async function auditDuplicatePrSessions(pool) {
  // Fresh DB: the table is created by the schema apply that follows, so
  // there's nothing to audit yet. Skip cleanly.
  const { rows: exists } = await pool.query(
    `SELECT to_regclass('public.chat_sessions') AS reg`
  );
  if (!exists[0] || exists[0].reg === null) {
    log.info('db', 'PR-import audit skipped — chat_sessions not created yet (fresh DB)');
    return;
  }

  // The `source` column is added by the schema apply that runs AFTER this
  // audit. On a pre-Slice-1 database it won't exist yet; since no imported
  // rows can exist without it, there's nothing to audit — skip cleanly.
  const { rows: col } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'chat_sessions'
        AND column_name = 'source'`
  );
  if (!col.length) {
    log.info('db', 'PR-import audit skipped — source column not present yet (pre-Slice-1 DB)');
    return;
  }

  // STATUS SCOPE — live rows only, mirroring the import guard
  // (importedPrNumbers in routes/votes.js): "Archived imports are excluded
  // so a withdrawn import can be re-imported." That re-import is a
  // documented, supported flow, and it leaves the withdrawn session behind
  // with its pr_number intact. An audit that counted ALL imported rows
  // (as this one originally did) turned that legitimate flow into a boot
  // abort: withdraw #1075 → reopen → re-import created sessions [3193
  // archived, 3195 merged], and the next deploy's fresh container refused
  // to boot until the archived row was manually healed — with the fix for
  // the audit itself stuck behind the very deploy it was blocking. The
  // invariant PR-import actually relies on is "at most one LIVE session
  // claims a PR", so that is exactly what we audit.
  const { rows } = await pool.query(
    `SELECT app_id, pr_number, array_agg(id ORDER BY id) AS session_ids, COUNT(*)
       FROM chat_sessions
      WHERE pr_number IS NOT NULL AND source = 'imported'
        AND status IN ('active', 'promoted', 'merging', 'merged')
      GROUP BY app_id, pr_number
     HAVING COUNT(*) > 1`
  );

  if (rows.length > 0) {
    const detail = rows.map(
      (r) => `app_id=${r.app_id} pr_number=${r.pr_number} sessions=[${(r.session_ids || []).join(', ')}]`
    );
    log.error('db', 'PR-import audit FAILED — duplicate (app_id, pr_number) sessions found', {
      conflicts: rows.length,
      detail,
    });
    throw new Error(
      `PR-import boot audit: ${rows.length} duplicate (app_id, pr_number) group(s) in ` +
      `chat_sessions violate the uniqueness invariant PR-import relies on. ` +
      `Resolve the conflicting sessions before booting. ` +
      `Conflicts: ${detail.join('; ')}`
    );
  }

  log.info('db', 'PR-import audit passed — no duplicate (app_id, pr_number) sessions');
}

// #155: headless runs interrupted by a restart used to be blanket-failed
// here because the loop lived entirely in the dead process. They are now
// resumable: runHeadlessSession checkpoints its position in
// chat_sessions.headless_step ('planning' / 'cc_running' / 'wrapping'),
// and resumeHeadlessRuns (src/routes/sessions.js, called from server.js
// boot after worker adoption) carries any 'generating' row forward from
// that checkpoint — marking 'failed' only the rows it explicitly gives
// up on. The sweep below is narrowed to rows with NO checkpoint, i.e.
// runs started before the step machine existed; those genuinely cannot
// be resumed. Idempotent; no-ops when nothing is stuck.
async function failOrphanedHeadlessRuns(pool) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE chat_sessions SET headless_status = 'failed'
        WHERE is_headless = TRUE AND headless_status = 'generating'
          AND headless_step IS NULL`
    );
    if (rowCount > 0) {
      log.info('db', 'Marked unresumable (pre-step-machine) headless runs as failed', { count: rowCount });
    }
  } catch (err) {
    log.warn('db', 'Failed to reset orphaned headless runs', { err: err.message });
  }
}

// Forward-only, idempotent: hand back every GitHub OAuth token this platform
// used to hold for a user, then clear the column.
//
// The GitHub link used to request the classic `public_repo` scope so the
// platform could fork an app's repo into the user's account on their behalf.
// GitHub describes that scope on its consent screen as read/write access to
// code on EVERY public repository the user can reach — enormously more than
// "make one fork". The fork is now made by the user's own coding agent and
// the link is identity-only (services/github-link), so any stored token is
// both unused and an unnecessary liability.
//
// Simply nulling the column would not be enough: classic OAuth
// authorizations are CUMULATIVE, so a user who once granted `public_repo`
// keeps that grant listed under github.com/settings/applications even after
// re-authorizing with no scope — the only way to actually give it back is
// DELETE /applications/{client_id}/grant, which needs the token we are about
// to destroy. So: revoke first (best-effort, bounded), then NULL regardless
// of whether GitHub answered. `github_login` / `github_linked_at` are
// preserved, so those users stay linked and never see a re-consent prompt.
//
// Runs at most once per deployment in practice (the column is empty
// afterwards, and nothing writes it again). A missing OAuth app, an
// undecryptable value or a GitHub outage all still end with the column
// cleared — leaving a token behind on a failure would mean retrying forever
// while continuing to hold the credential.
const LEGACY_GITHUB_TOKEN_BATCH = 500;

async function revokeLegacyGithubGrants(pool, config) {
  const githubLink = require('../services/github-link');
  const { decrypt } = require('../services/secrets');

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT id, github_oauth_token_enc
         FROM users
        WHERE github_oauth_token_enc IS NOT NULL
        ORDER BY id
        LIMIT $1`,
      [LEGACY_GITHUB_TOKEN_BATCH]
    ));
  } catch (err) {
    // Pre-schema database or a transient read failure: nothing to do, and
    // never a reason to fail boot.
    log.warn('db', 'Legacy GitHub token sweep skipped', { err: err.message });
    return;
  }
  if (!rows.length) return;

  const canRevoke = githubLink.isEnabled(config);
  let revoked = 0;
  let failed = 0;
  for (const row of rows) {
    let token = null;
    try {
      token = decrypt(row.github_oauth_token_enc, config.dataEncryptionKey);
    } catch {
      token = null;
    }
    if (canRevoke && token) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await githubLink.revokeCredential(config, token, 'grant');
      if (ok) revoked += 1; else failed += 1;
    } else {
      failed += 1;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        'UPDATE users SET github_oauth_token_enc = NULL WHERE id = $1',
        [row.id]
      );
    } catch (err) {
      log.warn('db', 'Legacy GitHub token clear failed', { userId: row.id, err: err.message });
    }
  }
  log.info('db', 'Legacy GitHub OAuth tokens revoked and cleared', {
    considered: rows.length, revoked, notRevoked: failed, oauthAppConfigured: canRevoke,
  });
}

// One-shot, idempotent backfill that recovers chat_sessions.linked_issues for
// PRs whose bodies carry GitHub closing keywords (Closes/Fixes/Resolves #N)
// but predate the #75/#79 linkage plumbing — so the "Closes #N" pills (#80/#82)
// render on historical PR cards instead of only on brand-new sessions.
//
// PR bodies aren't stored locally, so we fetch each candidate once from GitHub
// (owner/repo resolved from apps.repo_url) and parse the closing keywords. To
// avoid re-fetching every boot, each processed session is flagged via
// chat_sessions.linked_issues_backfilled — including the ones whose body had
// no keywords (so they're not retried forever). A PR we couldn't fetch (network
// blip, deleted repo, perms) is left UNflagged so a later boot retries it; the
// set is bounded so that self-heals without churn.
//
// Best-effort throughout: every fetch/update is individually guarded and a
// failure never aborts boot. Sessions that already have linked_issues are
// excluded by the query (cheap, no network) and need no flag.
// ── One-time: namespace the retired waitlist region pseudo-codes ───────
//
// The waitlist country picker was ~50 curated codes in six region buckets,
// five of which ended in an "Elsewhere in <region>" catch-all that stored a
// pseudo-code: EU, LA, AF, ME, AP. It is the complete ISO 3166-1 list now
// (src/services/countries.js), and three of those five letters pairs are
// REAL countries in it — LA is Laos, AF is Afghanistan, ME is Montenegro.
// Left alone, a past "somewhere in Latin America" answer and a future Laos
// signup would be the same two characters in the same column.
//
// So the stored values are namespaced to `X-EU` … `X-AP`. Nobody's answer is
// discarded or reinterpreted: it still means the region they picked, and the
// admin screen still shows it (countryLabel renders "Elsewhere in Latin
// America (region)"). The new picker cannot produce these values — the field
// is capped at two characters — so `X-*` can only ever mean "chose a region
// on the old form".
//
// Guarded by a platform_settings marker, in the same style as
// `onboarding_gate_grandfathered` in schema.sql, because this runs on every
// boot. The guard is what makes it correct rather than merely idempotent: at
// the moment it first runs, every `EU`/`LA`/… in the column is by definition
// a pre-ISO-list answer, because the new picker ships in this same deploy.
// After that a genuine `LA` means Laos and must never be rewritten.
async function migrateWaitlistCountryCodes(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM platform_settings WHERE key = 'waitlist_country_iso_migrated'`
    );
    if (rows.length) return;

    const res = await pool.query(
      `UPDATE waitlist_signups
          SET answers = jsonb_set(answers, '{country}',
                                  to_jsonb('X-' || (answers->>'country')))
        WHERE answers ? 'country'
          AND answers->>'country' IN ('EU', 'LA', 'AF', 'ME', 'AP')`
    );

    await pool.query(
      `INSERT INTO platform_settings (key, value, description) VALUES
         ('waitlist_country_iso_migrated', 'true',
          'Marker: the one-time rewrite of the retired waitlist region pseudo-codes (EU/LA/AF/ME/AP) to their namespaced X- form has run. Do not delete — deleting re-runs the rewrite, and after the ISO 3166-1 picker shipped those same letters mean Laos, Afghanistan and Montenegro.')
       ON CONFLICT (key) DO NOTHING`
    );

    if (res.rowCount) {
      log.info('db', 'Namespaced retired waitlist region codes', { rows: res.rowCount });
    }
  } catch (err) {
    log.warn('db', 'waitlist country-code migration skipped', { err: err.message });
  }
}

async function backfillLinkedIssuesFromPrBodies(pool) {
  const github = require('../services/github');
  const prMetadata = require('../services/pr-metadata');

  if (typeof github.isEnabled === 'function' && !github.isEnabled()) {
    log.debug('db', 'linked-issues backfill skipped (github disabled)');
    return;
  }

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT cs.id, cs.pr_number, a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON a.id = cs.app_id
        WHERE cs.pr_number IS NOT NULL
          AND cs.linked_issues_backfilled = false
          AND COALESCE(array_length(cs.linked_issues, 1), 0) = 0`
    ));
  } catch (err) {
    log.warn('db', 'linked-issues backfill skipped (query failed)', { err: err.message });
    return;
  }
  if (!rows.length) {
    log.debug('db', 'No PRs need linked-issues backfill');
    return;
  }

  let scanned = 0;
  let populated = 0;
  for (const row of rows) {
    const [, owner, repo] = (row.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!owner || !repo) continue; // can't resolve repo → leave unflagged

    let body;
    try {
      const pr = await github.getPR(owner, repo, row.pr_number);
      body = pr && pr.body ? String(pr.body) : '';
    } catch (err) {
      // Leave unflagged so a later boot retries; bounded by the candidate set.
      log.debug('db', 'linked-issues backfill: PR fetch failed', {
        sessionId: row.id, repo: `${owner}/${repo}`, pr: row.pr_number, err: err.message,
      });
      continue;
    }
    scanned++;

    const issues = prMetadata.parseClosingKeywords(body);
    try {
      if (issues.length) {
        await pool.query(
          `UPDATE chat_sessions SET linked_issues = $1, linked_issues_backfilled = true WHERE id = $2`,
          [issues, row.id]
        );
        populated++;
      } else {
        await pool.query(
          `UPDATE chat_sessions SET linked_issues_backfilled = true WHERE id = $1`,
          [row.id]
        );
      }
    } catch (err) {
      log.warn('db', 'linked-issues backfill: update failed', { sessionId: row.id, err: err.message });
    }
  }

  if (scanned) {
    log.info('db', 'Backfilled linked issues from PR bodies', {
      candidates: rows.length, scanned, populated,
    });
  } else {
    log.debug('db', 'linked-issues backfill: no PRs successfully scanned this pass', {
      candidates: rows.length,
    });
  }
}

// One-shot, idempotent backfill that unwraps specs a scout/spec-author LLM
// stored fully enclosed in a single ```markdown … ``` fence — which made the
// whole spec render as one big code block instead of formatted markdown
// (session 153; 11 sessions at time of writing). The conservative unwrap can't
// be expressed in pure SQL, so we read the spec rows, run each through
// stripSpecWrapperFence(), and write back only the ones that actually change.
// Covers BOTH the live buffer (chat_sessions.spec_md — what the viewer shows
// as "latest") and the frozen history (chat_session_specs.content — what older
// version cards open). Row counts here are tiny (≈ one per session), so a full
// scan is cheaper than escaping a backtick LIKE prefilter and is robust to
// leading whitespace.
//
// Idempotent by construction: once unwrapped, a value no longer opens with a
// strippable wrapper, so stripSpecWrapperFence() returns it unchanged and no
// UPDATE fires on subsequent boots.
async function backfillFenceWrappedSpecs(pool) {
  const { stripSpecWrapperFence } = require('../services/spec-format');
  let liveFixed = 0;
  let versionFixed = 0;
  try {
    const { rows: live } = await pool.query(
      `SELECT id, spec_md FROM chat_sessions
        WHERE spec_md IS NOT NULL AND length(btrim(spec_md)) > 0`
    );
    for (const row of live) {
      const unwrapped = stripSpecWrapperFence(row.spec_md);
      if (unwrapped !== row.spec_md) {
        await pool.query('UPDATE chat_sessions SET spec_md = $1 WHERE id = $2', [unwrapped, row.id]);
        liveFixed++;
      }
    }

    const { rows: versions } = await pool.query(
      `SELECT session_id, version, content FROM chat_session_specs
        WHERE content IS NOT NULL AND length(btrim(content)) > 0`
    );
    for (const row of versions) {
      const unwrapped = stripSpecWrapperFence(row.content);
      if (unwrapped !== row.content) {
        await pool.query(
          'UPDATE chat_session_specs SET content = $1 WHERE session_id = $2 AND version = $3',
          [unwrapped, row.session_id, row.version]
        );
        versionFixed++;
      }
    }
  } catch (err) {
    log.warn('db', 'fence-wrapped spec backfill skipped (query failed)', { err: err.message });
    return;
  }

  if (liveFixed || versionFixed) {
    log.info('db', 'Unwrapped fence-wrapped specs', { liveFixed, versionFixed });
  } else {
    log.debug('db', 'No fence-wrapped specs to backfill');
  }
}

// #69: one-shot, idempotent backfill that freezes any orphaned live spec
// buffer as a numbered version. Background: the dev-chat spec viewer used
// to surface chat_sessions.spec_md as a separate "Draft (live)" entry,
// distinct from the numbered versions in chat_session_specs. #69 removes
// that draft surface — numbered versions (v1…vN) become the only spec
// the viewer shows. For sessions created after #27 (auto-snapshot on
// every spec mutation) spec_md is always byte-identical to the latest
// version, so nothing is lost. But PRE-#27 sessions could have edited
// spec_md after the last manual "Save version", leaving the live buffer
// newer than any frozen version — that content would become unreachable
// once the draft view is gone.
//
// This snapshots each such session's current spec_md as MAX(version)+1 so
// every session's latest content is reachable as a numbered version, then
// the default-to-latest viewer shows it. Forward-only (insert-only, no
// drops/renames) per the platform self-edit rule.
//
// Idempotent by construction: after one run each affected session's latest
// version content equals spec_md, so the `latest.content <> cs.spec_md`
// guard excludes it on every subsequent boot — a normal boot inserts
// nothing.
async function backfillOrphanedSpecDrafts(pool) {
  let res;
  try {
    res = await pool.query(
      `INSERT INTO chat_session_specs (session_id, version, content)
         SELECT cs.id, COALESCE(latest.max_version, 0) + 1, cs.spec_md
           FROM chat_sessions cs
           LEFT JOIN LATERAL (
             SELECT version AS max_version, content
               FROM chat_session_specs s
              WHERE s.session_id = cs.id
              ORDER BY version DESC
              LIMIT 1
           ) latest ON TRUE
          WHERE cs.spec_md IS NOT NULL
            AND length(btrim(cs.spec_md)) > 0
            AND (latest.content IS NULL OR latest.content <> cs.spec_md)`
    );
  } catch (err) {
    // Never abort boot over a backfill; the ALTERs in schema.sql run first
    // so the columns/table exist, but stay defensive regardless.
    log.warn('db', 'orphaned spec draft backfill skipped (query failed)', { err: err.message });
    return;
  }

  if (res.rowCount) {
    log.info('db', 'Froze orphaned live spec drafts as numbered versions', {
      inserted: res.rowCount,
    });
  } else {
    log.debug('db', 'No orphaned live spec drafts to backfill');
  }
}

// #58: one-shot, idempotent backfill of votes_required / active_users_at_merge
// for merged PRs that predate those columns. The at-merge vote threshold is
// computed live (services/active-users.js) and was never persisted, so the
// only historical record of "how many votes were required when this PR
// merged" is the free-text merge announcement posted to group chat by
// routes/votes.js checkAndMerge():
//
//   "PR #<ref> ... merged and deployed! (<yes>/<active> votes)"
//   "PR #<ref> ... force-merged by admin <name> (<yes>/<active> vote(s) at the time)"
//
// We parse the "(yes/active)" figure out of that message, take <active> as the
// at-merge active-user count, and reconstruct the threshold as
// floor(active/2)+1 — exactly getActiveUserStats()'s majority formula.
//
// Idempotent by construction: only rows with votes_required IS NULL are
// considered, and each fill is COALESCE-guarded, so a normal boot (already
// snapshotted, or already backfilled) scans nothing or no-ops. Rows whose
// announcement can't be found/parsed stay NULL and keep the live-majority
// fallback in the UI — non-regressive.
async function backfillVotesRequired(pool) {
  let sessions;
  try {
    ({ rows: sessions } = await pool.query(
      `SELECT id, app_id, pr_number FROM chat_sessions
        WHERE status = 'merged' AND votes_required IS NULL`
    ));
  } catch (err) {
    // e.g. the column doesn't exist yet on a partial/older schema — the
    // ALTER in schema.sql should have run first, but never abort boot here.
    log.warn('db', 'votes_required backfill skipped (query failed)', { err: err.message });
    return;
  }

  if (!sessions.length) {
    log.debug('db', 'No merged rows need votes_required backfill');
    return;
  }

  log.info('db', 'Backfilling votes_required for merged PRs...', {
    candidates: sessions.length,
  });

  let filled = 0;
  for (const s of sessions) {
    // The announcement label uses `pr_number || session.id` as the PR ref.
    const ref = s.pr_number || s.id;
    try {
      // Find the merge announcement for this PR. The word-boundary regex
      // (`(^|[^0-9])PR #<ref>([^0-9]|$)`) stops "PR #1" from matching
      // "PR #12", and the two LIKEs restrict to merge/force-merge lines
      // (promote / vote / revert messages also mention the PR ref but
      // carry neither phrase).
      const { rows: msgs } = await pool.query(
        `SELECT content FROM chat_messages
          WHERE app_id = $1 AND msg_type = 'system'
            AND content ~ $2
            AND (content LIKE '%merged and deployed!%'
                 OR content LIKE '%force-merged by admin%')
          ORDER BY created_at DESC
          LIMIT 1`,
        [s.app_id, `(^|[^0-9])PR #${ref}([^0-9]|$)`]
      );
      if (!msgs.length) continue;

      const m = /\((\d+)\s*\/\s*(\d+)\s+vote/.exec(msgs[0].content);
      if (!m) continue;
      const activeAtMerge = parseInt(m[2], 10);
      if (!Number.isFinite(activeAtMerge) || activeAtMerge < 1) continue;
      const votesRequired = Math.floor(activeAtMerge / 2) + 1;

      await pool.query(
        `UPDATE chat_sessions
            SET votes_required = COALESCE(votes_required, $2),
                active_users_at_merge = COALESCE(active_users_at_merge, $3)
          WHERE id = $1`,
        [s.id, votesRequired, activeAtMerge]
      );
      filled += 1;
    } catch (err) {
      // One bad row must not abort the backfill or boot.
      log.warn('db', 'votes_required backfill row failed', {
        sessionId: s.id, err: err.message,
      });
    }
  }

  log.info('db', 'votes_required backfill complete', {
    filled, scanned: sessions.length,
  });
}

// One-shot backfill of the append-only `events` analytics log from the
// existing domain tables. The events table (schema.sql) is the long-term
// source of truth behind the admin /dashboard, but it only starts
// accumulating rows once the action-site emitters (src/services/events.js
// callers) ship. Without a backfill, every growth / retention / funnel
// chart would show a cliff at the deploy boundary. This synthesizes the
// historical rows from the timestamps already recorded elsewhere so the
// curves are continuous.
//
// Idempotent by construction: it no-ops the moment the table holds any
// row, so a normal boot (events already populated, by backfill or by live
// emission) skips it entirely. It only ever runs against a genuinely
// empty table — i.e. the first boot after this migration lands.
async function backfillEvents(pool) {
  const { rows } = await pool.query(
    'SELECT NOT EXISTS (SELECT 1 FROM events LIMIT 1) AS empty'
  );
  if (!rows[0]?.empty) {
    log.debug('db', 'events table already populated; skipping backfill');
    return;
  }

  log.info('db', 'Backfilling events log from existing tables...');

  // Each statement maps one domain table to one event_type. created_at is
  // the best available historical timestamp for that action. app_activity
  // only has day granularity (DATE), which is exactly what the retention /
  // active-day signals need. pr_merged uses merged_at when present (rows
  // merged after this migration) and falls back to promoted_at/created_at
  // for older rows that never recorded a merge time.
  const statements = [
    `INSERT INTO events (user_id, event_type, created_at)
       SELECT id, 'user_signed_up', created_at FROM users`,

    `INSERT INTO events (user_id, app_id, event_type, created_at)
       SELECT created_by, id, 'app_created', created_at
       FROM apps WHERE created_by IS NOT NULL`,

    `INSERT INTO events (user_id, app_id, event_type, created_at, metadata)
       SELECT user_id, app_id, 'dapp_active_day', date::timestamptz,
              jsonb_build_object('secondsSpent', seconds_spent)
       FROM app_activity WHERE user_id IS NOT NULL`,

    `INSERT INTO events (user_id, app_id, event_type, created_at)
       SELECT user_id, app_id, 'chat_message_sent', created_at
       FROM chat_messages WHERE user_id IS NOT NULL`,

    `INSERT INTO events (user_id, app_id, session_id, event_type, created_at)
       SELECT u.id, cs.app_id, cs.id, 'dev_session_started', cs.created_at
       FROM chat_sessions cs JOIN users u ON u.id = cs.user_id`,

    `INSERT INTO events (user_id, app_id, session_id, event_type, created_at)
       SELECT cs.user_id, cs.app_id, cs.id, 'pr_opened', cs.created_at
       FROM chat_sessions cs WHERE cs.pr_number IS NOT NULL`,

    `INSERT INTO events (user_id, app_id, session_id, event_type, created_at)
       SELECT cs.user_id, cs.app_id, cs.id, 'pr_promoted', cs.promoted_at
       FROM chat_sessions cs WHERE cs.promoted_at IS NOT NULL`,

    `INSERT INTO events (user_id, app_id, session_id, event_type, created_at)
       SELECT cs.user_id, cs.app_id, cs.id, 'pr_merged',
              COALESCE(cs.merged_at, cs.promoted_at, cs.created_at)
       FROM chat_sessions cs WHERE cs.status = 'merged'`,

    `INSERT INTO events (user_id, session_id, app_id, event_type, created_at)
       SELECT pv.user_id, pv.session_id, cs.app_id, 'pr_vote_cast', pv.created_at
       FROM pr_votes pv JOIN chat_sessions cs ON cs.id = pv.session_id`,

    `INSERT INTO events (user_id, session_id, app_id, event_type, created_at)
       SELECT pk.giver_user_id, pk.session_id, cs.app_id, 'kudos_given', pk.created_at
       FROM pr_kudos pk JOIN chat_sessions cs ON cs.id = pk.session_id`,

    `INSERT INTO events (user_id, app_id, event_type, created_at)
       SELECT user_id, app_id, 'app_favorited', created_at FROM app_favorites`,
  ];

  let total = 0;
  for (const sql of statements) {
    try {
      const res = await pool.query(sql);
      total += res.rowCount || 0;
    } catch (err) {
      // A single source table hiccup must not abort boot — log and keep
      // going so the rest of the backfill (and the server) still come up.
      log.warn('db', 'events backfill statement failed', { err: err.message });
    }
  }

  log.info('db', 'Events backfill complete', { inserted: total });
}

async function seedAdmin(pool, config) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE username = $1',
    [config.adminUsername]
  );

  if (rows.length === 0) {
    const hash = await bcrypt.hash(config.adminPassword, 12);
    await pool.query(
      'INSERT INTO users (username, password, is_admin) VALUES ($1, $2, TRUE)',
      [config.adminUsername, hash]
    );
    log.info('db', 'Admin user created', { username: config.adminUsername });
  } else {
    log.debug('db', 'Admin user already exists');
  }
}

// Dedicated identity for the before/after screenshot pipeline (#195 fix).
// services/visuals.js signs capture requests as this user so screenshots
// show the real, logged-in app instead of the login screen. An ordinary
// non-admin account (is_admin/can_create_apps both FALSE) because the
// resulting artifacts are public (unauthenticated /visuals/:id route +
// GitHub PR bodies) — it must never see admin-only UI or anyone's
// personal data. The password is a bcrypt hash of 32 random bytes that
// are immediately discarded, so the account can never log in
// interactively; visuals.js authenticates it by minting a JWT / session
// row directly. Idempotent: keyed on the unique username; a rerun repairs
// platform access without rotating the random password hash.
async function seedCaptureUser(pool) {
  try {
    const { rows } = await pool.query(
      'SELECT id, has_platform_access FROM users WHERE username = $1',
      ['usernode-capture']
    );
    if (rows.length) {
      // This non-interactive identity has to pass the platform access gate
      // in a staging clone. Otherwise every signed visual capture lands on
      // the waitlist and its authenticated API requests fail with 403.
      if (!rows[0].has_platform_access) {
        await pool.query(
          `UPDATE users SET has_platform_access = TRUE,
             platform_access_granted_at = COALESCE(platform_access_granted_at, NOW())
           WHERE id = $1`,
          [rows[0].id]
        );
      }
      log.debug('db', 'Capture user already exists');
      return;
    }
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    await pool.query(
      `INSERT INTO users (username, password, is_admin, can_create_apps,
         has_platform_access, platform_access_granted_at)
       VALUES ($1, $2, FALSE, FALSE, TRUE, NOW())
       ON CONFLICT (username) DO UPDATE SET
         has_platform_access = TRUE,
         platform_access_granted_at = COALESCE(users.platform_access_granted_at, NOW())`,
      ['usernode-capture', hash]
    );
    log.info('db', 'Capture user created', { username: 'usernode-capture' });
  } catch (err) {
    // Best-effort: a missing capture user only degrades screenshots back
    // to today's unauthenticated behaviour — never abort boot over it.
    log.warn('db', 'Capture user seed failed', { err: err.message });
  }
}

// Dedicated identity for the proposal-checks ASSERTION suite (#47 fix).
// services/visuals.js signs the per-test navigations as this user so the
// admin-only check routes (/admin, /dashboard) render their gated content
// instead of "Admin access required" — the two declared admin checks
// failed for every proposal otherwise (they ran as the non-admin
// usernode-capture above).
//
// A VIEW-ONLY admin (is_admin = TRUE, admin_readonly = TRUE): it can SEE
// admin reads (adminMiddleware lets any admin through GETs) but is blocked
// from every mutating route (requireAdminWrite → 403), so a leaked token
// can never change platform state. Unlike usernode-capture this identity
// signs NO public artifact — test frames are pass/fail + console errors,
// never a published image — so granting it admin visibility leaks nothing.
// can_create_apps stays FALSE; the discarded-random-bytes bcrypt password
// blocks interactive login (visuals.js mints a JWT directly). Idempotent:
// keyed on the unique username, DO NOTHING on conflict. Runs unconditionally
// on boot so the platform (prod) DB has it for token minting; the staging
// clone inherits the row from prod, same as usernode-capture.
async function seedCaptureAdminUser(pool) {
  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      ['usernode-capture-admin']
    );
    if (rows.length) {
      log.debug('db', 'Capture admin user already exists');
      return;
    }
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    await pool.query(
      `INSERT INTO users (username, password, is_admin, admin_readonly, can_create_apps)
       VALUES ($1, $2, TRUE, TRUE, FALSE)
       ON CONFLICT (username) DO NOTHING`,
      ['usernode-capture-admin', hash]
    );
    log.info('db', 'Capture admin user created', { username: 'usernode-capture-admin' });
  } catch (err) {
    // Best-effort: a missing capture-admin user only degrades the admin
    // check routes back to today's non-admin behaviour — never abort boot.
    log.warn('db', 'Capture admin user seed failed', { err: err.message });
  }
}

// The one canonical `staging-demo-user` row, at its hard-coded id 900001.
//
// Roughly a dozen staging fixtures below own their demo apps with a
// literal `created_by = 900001` and re-assert the user with
// `INSERT INTO users (id, username, password) VALUES (900001,
// 'staging-demo-user', …) ON CONFLICT DO NOTHING`. That is only
// self-healing if 900001 is where the username actually lands.
//
// It wasn't. `seedStagingSharedSession` ran first and created the same
// username with a SERIAL id, so on a fresh clone every later fixed-id
// insert hit the username's unique index, did nothing, and each app row
// pointing at 900001 then died on `apps_created_by_fkey`. Each seed
// catches its own error and only warns, so a first boot silently lost
// six whole fixture blocks — the home "Your apps" tiles, the errored-app
// tile, fork lineage, the members and approver panels — and the checks
// asserting them failed on screens nobody had touched. (A staging clone
// starts from prod, where no `staging-demo%` user exists, so "first
// boot" is every boot.)
//
// Claiming the id here, before any fixture runs, makes the existing
// lookups correct instead of rewriting a dozen call sites: the shared
// session's `SELECT id FROM users WHERE username = 'staging-demo-user'`
// now finds 900001, and every fixed-id insert is a genuine no-op.
//
// Password is the same plain marker string the fixtures use — bcrypt
// compares against a non-hash always fail, so the account cannot be
// logged into. Idempotent, and strictly a no-op outside staging.
async function seedStagingDemoUser(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (id, username, password, is_admin, can_create_apps)
       VALUES (900001, 'staging-demo-user', 'staging-demo-not-a-login', FALSE, FALSE)
       ON CONFLICT DO NOTHING`
    );
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE username = $1', ['staging-demo-user']
    );
    const id = rows[0]?.id;
    if (String(id) !== '900001') {
      // Only reachable on a DB that booted the broken ordering earlier and
      // is being re-used rather than re-cloned. Re-pointing the id would
      // have to cascade through every FK, so say so loudly instead of
      // letting six fixture blocks fail one by one further down.
      log.warn('db', 'Staging demo user is not at its hard-coded id 900001', {
        id: id ?? null,
        hint: 're-clone the staging database; fixed-id fixtures will FK-fail',
      });
      return;
    }
    log.info('db', 'Staging demo user seeded', { id: 900001 });
  } catch (err) {
    log.warn('db', 'Staging demo user seeding failed', { message: err.message });
  }
}

// One fully populated account for the admin Users details view
// (#admin/users/900301): programme identifiers, a location, a pending app
// slot request, a weekly cap override, a linked wallet and one GitHub proof,
// so every card of the view has something to show. It deliberately has no
// company OpenRouter key, events, onchain accounts or leaderboard standing,
// so those cards render their empty states. Same rules as the demo user
// above: fixed id, cannot log in, idempotent, a no-op outside staging.
async function seedStagingAdminDetailsUser(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (id, username, password, is_admin, can_create_apps,
                          email, telegram, display_name, country, city,
                          app_quota, app_quota_requested_at, weekly_limit_cents, usernode_pubkey)
       VALUES (900301, 'staging-demo-admin-details', 'staging-demo-not-a-login', FALSE, FALSE,
               'staging-demo-admin-details@example.invalid', 'staging_demo_details',
               'Staging demo details user', 'FR', 'Staging demo city',
               2, NOW(), 500, 'ut1stagingdemodetails0000000001')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO user_social_identities (user_id, provider, provider_subject, handle)
       SELECT 900301, 'github', '900301900301', 'staging-demo-details'
        WHERE EXISTS (SELECT 1 FROM users WHERE id = 900301 AND username = 'staging-demo-admin-details')
       ON CONFLICT DO NOTHING`
    );
    log.info('db', 'Staging admin details user seeded', { id: 900301 });
  } catch (err) {
    log.warn('db', 'Staging admin details user seeding failed', { message: err.message });
  }
}

// Support screen (#admin/support/900302): one fake participant with enough
// history that every Support card has something to show. Points in a running
// and an ended event from several sources (automatic scoring, admin, a
// support adjustment), one leaderboard snapshot older than the ledger so the
// "differs from the ledger" hint renders, an enrollment, an onchain account,
// kudos both ways, a username change, and one support action.
//
// Every row belongs to fake 9003xx identities, never the viewer, and nothing
// here is a signal the Support routes decide anything from. Fixed ids and
// ON CONFLICT DO NOTHING keep it idempotent; strictly a no-op outside staging.
async function seedStagingSupportUser(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (id, username, password, is_admin, can_create_apps,
                          email, telegram, display_name, usernode_pubkey)
       VALUES (900302, 'staging-demo-support', 'staging-demo-not-a-login', FALSE, FALSE,
               'staging-demo-support@example.invalid', 'staging_demo_support',
               'Staging demo support user', 'ut1stagingdemosupport00000000001')
       ON CONFLICT DO NOTHING`
    );
    const owned = await pool.query(
      `SELECT 1 FROM users WHERE id = 900302 AND username = 'staging-demo-support'`
    );
    if (!owned.rowCount) return;
    await pool.query(
      `INSERT INTO username_history (id, user_id, username, changed_at)
       VALUES (900302, 900302, 'staging-demo-support-old', NOW() - INTERVAL '40 days')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO seasons (id, name, starts_at, ends_at, created_at, updated_at)
       VALUES (900302, 'Staging demo season', NOW() - INTERVAL '60 days', NOW() + INTERVAL '30 days', NOW(), NOW())
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO season_events (id, name, starts_at, ends_at, scoring_formula, season_id, created_at, updated_at)
       VALUES (900302, 'Staging demo running event', NOW() - INTERVAL '10 days', NOW() + INTERVAL '20 days', '{}'::jsonb, 900302, NOW(), NOW()),
              (900303, 'Staging demo ended event', NOW() - INTERVAL '60 days', NOW() - INTERVAL '30 days', '{}'::jsonb, 900302, NOW(), NOW())
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO challenge_templates (id, category, goal, task, reward, created_at, updated_at)
       VALUES (900302, 'staging', 'Staging demo: try 3 apps', 'Open three apps.', '200 points', NOW(), NOW())
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO challenges (id, season_event_id, challenge_template_id, goal, display_order, created_at, updated_at)
       VALUES (900302, 900302, 900302, 'Staging demo: try 3 apps', 0, NOW(), NOW()),
              (900303, 900303, 900302, 'Staging demo: invite a friend', 0, NOW(), NOW())
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO user_enrollments (id, user_id, season_id, season_event_id, registered_at, created_at)
       VALUES (900302, 900302, 900302, NULL, NOW() - INTERVAL '50 days', NOW())
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO onchain_accounts (id, amount, identity_uid, address, public_key, secret_key, tier,
                                     registration_code, season_id, season_event_id, user_id, is_used, used_at, created_at)
       VALUES (900302, 0, 'staging-demo-support', 'ut1stagingdemosupportaccount0000001', 'staging-demo-public-key',
               'staging-not-a-secret', 'standard', 'staging-demo-support-code', 900302, 900302, 900302,
               TRUE, NOW() - INTERVAL '9 days', NOW())
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO support_actions (id, actor_user_id, target_user_id, action, reason, payload, created_at)
       VALUES (900302, 900001, 900302, 'points_adjustment',
               'Staging demo: missed points for a scanner outage',
               '{"points": 50, "season_event_id": 900302, "challenge_id": 900302, "ticket": "STAGING-1", "activity_id": 900305}'::jsonb,
               NOW() - INTERVAL '2 days')
       ON CONFLICT DO NOTHING`
    );
    const activities = [
      [900302, 900302, 900302, 'challenge_completed', 200, 'challenge_scorer', null, '8 days'],
      [900303, 900302, 900302, 'challenge_completed', 100, 'scanner', null, '6 days'],
      [900304, 900302, 900302, 'manual', 25, 'admin_ui', null, '5 days'],
      [900305, 900302, 900302, 'support_adjustment', 50, 'support_adjustment',
        { support_action_id: 900302, reason: 'Staging demo: missed points for a scanner outage', ticket: 'STAGING-1' }, '2 days'],
      [900306, 900302, 900302, 'challenge_completed', 75, 'challenge_scorer', null, '1 day'],
      [900307, 900303, 900303, 'challenge_completed', 300, 'challenge_scorer', null, '45 days'],
      [900308, 900303, 900303, 'manual', -20, 'admin_ui', null, '40 days'],
      [900309, 900303, 900303, 'import', 40, 'import', null, '35 days'],
    ];
    for (const [id, eventId, challengeId, type, points, source, metadata, ago] of activities) {
      await pool.query(
        `INSERT INTO user_activities (id, user_id, season_event_id, challenge_id, activity_type, points,
                                      description, metadata, activity_at, source, created_at, updated_at)
         VALUES ($1, 900302, $2, $3, $4, $5, 'Staging demo activity', $6::jsonb,
                 NOW() - $7::interval, $8, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [id, eventId, challengeId, type, points, metadata ? JSON.stringify(metadata) : null, ago, source]
      );
    }
    // The running event's snapshot predates the last two entries, so the
    // leaderboard (325) trails the ledger (450) until the next refresh.
    await pool.query(
      `INSERT INTO leaderboard_snapshots (id, season_event_id, user_id, rank, total_points, snapshot_at, season_id, created_at)
       VALUES (900302, 900302, 900302, 4, 325, NOW() - INTERVAL '3 days', 900302, NOW()),
              (900303, 900303, 900302, 2, 320, NOW() - INTERVAL '30 days', 900302, NOW())
       ON CONFLICT DO NOTHING`
    );
    const app = await pool.query(
      `SELECT id FROM apps WHERE view_visibility = 'public' ORDER BY id LIMIT 1`
    );
    const appId = app.rows[0]?.id || null;
    if (appId) {
      await pool.query(
        `INSERT INTO chat_sessions (id, app_id, user_id, pr_number, pr_title, status)
         VALUES (900302, $1, 900302, 900302, 'Staging demo: support user proposal', 'archived'),
                (900303, $1, 900301, 900303, 'Staging demo: another proposal', 'archived')
         ON CONFLICT DO NOTHING`,
        [appId]
      );
      await pool.query(
        `INSERT INTO pr_kudos (session_id, giver_user_id, week_start, created_at)
         SELECT s.sid, s.giver, date_trunc('week', NOW())::date, NOW() - INTERVAL '1 day'
           FROM (VALUES (900302, 900301), (900303, 900302)) AS s(sid, giver)
          WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = s.sid)
            AND EXISTS (SELECT 1 FROM users WHERE id = s.giver)
         ON CONFLICT (session_id, giver_user_id) DO NOTHING`
      );
    }
    const hasEvents = await pool.query(
      `SELECT 1 FROM events WHERE user_id = 900302 AND metadata->>'staging_demo' = 'support' LIMIT 1`
    );
    if (!hasEvents.rowCount) {
      const rows = [
        ['app_created', '12 days'], ['chat_message_sent', '4 days'], ['dapp_active_day', '3 days'],
        ['pr_opened', '7 days'], ['pr_vote_cast', '2 days'], ['dev_session_started', '7 days'],
      ];
      for (const [type, ago] of rows) {
        await pool.query(
          `INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
           VALUES (900302, $1, $2, '{"staging_demo": "support"}'::jsonb, NOW() - $3::interval)`,
          [appId, type, ago]
        );
      }
    }
    log.info('db', 'Staging support user seeded', { id: 900302 });
  } catch (err) {
    log.warn('db', 'Staging support user seeding failed', { message: err.message });
  }
}

// "Deduplicate user" (#admin/users/900301 -> Deduplicate user): a second,
// fake account for the same fake person as 900301, so a full admin testing a
// preview has an obvious pair to merge. A little activity so the side-by-side
// counts and "rows that will move" are not all zero. Fixed id, ON CONFLICT /
// existence guards, strictly a no-op outside staging. Nothing reads it.
async function seedStagingDuplicateUser(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (id, username, password, is_admin, can_create_apps, email, display_name)
       VALUES (900310, 'staging-demo-admin-details-dup', 'staging-demo-not-a-login', FALSE, FALSE,
               'staging-demo-admin-details-dup@example.invalid', 'Staging demo details user')
       ON CONFLICT DO NOTHING`
    );
    const owned = await pool.query(
      `SELECT 1 FROM users WHERE id = 900310 AND username = 'staging-demo-admin-details-dup'`
    );
    if (!owned.rowCount) return;
    const hasEvents = await pool.query(
      `SELECT 1 FROM events WHERE user_id = 900310 AND metadata->>'staging_demo' = 'duplicate' LIMIT 1`
    );
    if (!hasEvents.rowCount) {
      for (const [type, ago] of [['app_created', '20 days'], ['chat_message_sent', '6 days'], ['dapp_active_day', '2 days']]) {
        await pool.query(
          `INSERT INTO events (user_id, event_type, metadata, created_at)
           VALUES (900310, $1, '{"staging_demo": "duplicate"}'::jsonb, NOW() - $2::interval)`,
          [type, ago]
        );
      }
    }
    log.info('db', 'Staging duplicate user seeded', { id: 900310 });
  } catch (err) {
    log.warn('db', 'Staging duplicate user seeding failed', { message: err.message });
  }
}

// #2783: a few obviously-fake lines in #general, so the staging preview of
// the Messages channels section opens on a room with something in it.
//
// `conversations` and its message table are staging:private, so a clone
// starts with the room (schema.sql recreates it on every boot) and no
// history. Two fake speakers of their own, never the viewer: the checks read
// the room as the view-only check user, and seeding THAT user's words would
// fabricate the thing being checked. Idempotent through the messages'
// idempotency keys; strictly a no-op outside staging.
async function seedStagingGeneralChannel(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES (902783, 'staging-demo-general-ada', 'staging-demo-not-a-login'),
              (902784, 'staging-demo-general-lin', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    const room = await pool.query(
      `SELECT id FROM conversations WHERE channel_key = 'general' AND kind = 'channel'`
    );
    const roomId = room.rows[0]?.id;
    if (!roomId) return;
    await pool.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, responded_at, joined_at)
       SELECT $1, u.id, 'member', 'member', NOW(), NOW()
         FROM users u WHERE u.id IN (902783, 902784)
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [roomId]
    );
    const lines = [
      [902783, 'staging-general-1', 'Staging demo: welcome to #general, the room everybody is in.', '3 hours'],
      [902783, 'staging-general-2', 'Staging demo: consecutive lines from one person group under one name.', '2 hours 59 minutes'],
      [902784, 'staging-general-3', 'Staging demo: and a reference to issue #1 still reads as an issue.', '2 hours'],
    ];
    for (const [sender, key, content, ago] of lines) {
      await pool.query(
        `INSERT INTO conversation_messages
           (conversation_id, sender_id, content, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, NOW() - $5::interval)
         ON CONFLICT (conversation_id, sender_id, idempotency_key)
           WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL
         DO NOTHING`,
        [roomId, sender, content, key, ago]
      );
    }
    log.info('db', 'Staging #general fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging #general seeding failed', { message: err.message });
  }
}

// Declared dapp.json checks are authenticated as this exact view-only user
// (services/visuals.js), not as the first administrator in the database.
// Owner-scoped staging fixtures must therefore resolve their owner by
// username: production clones can contain older admins with lower ids, and
// choosing one of those makes every fixed /dev/sessions/:id check return 404.
async function getStagingCheckViewer(pool, label) {
  const { rows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      WHERE username = $1
      LIMIT 1`,
    ['usernode-capture-admin']
  );
  if (!rows.length) {
    log.warn('db', `${label} skipped: proposal-check viewer missing`, {
      username: 'usernode-capture-admin',
    });
    return null;
  }
  return rows[0];
}

// SELF-HOSTING.md sub-step 2f: ensure a single row in `apps` exists
// for the platform itself, with self_hosted=TRUE. Idempotent — runs every
// boot. Two roles:
//
//   1. Refresh main_sha + last_deploy_at on every boot. The build's
//      GIT_SHA arg flows through docker-compose.yml as process.env.GIT_SHA,
//      so a new deploy that successfully boots updates the row to point
//      at the new commit. Before this seed runs the row may show the
//      previous SHA (between merge and new container start), which is
//      what the Phase 3 banner uses to detect "platform updated".
//
//   2. Refresh manifest_snapshot from the local dapp.json so the
//      Settings → Secrets UI for the self-app row shows the keys the
//      *currently running* code declares — no clone/round-trip needed.
//      Child apps populate this column from the freshly-cloned working
//      tree on every deploy; the self-app reads it from disk for the
//      same reason.
//
// The row's container_id is hard-pinned to 'usernode' (the docker compose
// service name). Settings → Secrets UI logic also branches on
// app.self_hosted to make the self-app read-only (Phase 2h), so we
// don't accidentally store secrets that won't take effect (the platform
// reads its env from .env written by deploy.yml, not from app_secrets).
async function seedSelfApp(pool, config) {
  // Read the local dapp.json once; missing/unparseable → empty manifest
  // (appManifest.read handles both gracefully). The path resolves to the
  // repo root regardless of how the harness was launched.
  const repoRoot = path.join(__dirname, '..', '..');
  const manifest = appManifest.read(repoRoot);

  const sha = process.env.GIT_SHA || null;
  const manifestJson = JSON.stringify(manifest);

  // Single UPSERT keyed on slug. Insert covers fresh-DB; the DO UPDATE
  // covers every subsequent boot so main_sha and manifest_snapshot
  // reflect the running build. The insert seeds name='Homeroom'; the
  // DO UPDATE deliberately does NOT touch name — the reconcile below is
  // the single place the self-app display name is resolved from
  // dapp.json (so a merged self-app rename PR actually applies on the
  // post-deploy reboot, same as child apps do in rebuildProduction).
  const { rows: selfRows } = await pool.query(
    `INSERT INTO apps
       (name, slug, repo_url, container_id, status, self_hosted,
        main_sha, last_deploy_at, manifest_snapshot)
     VALUES
       ('Homeroom', $1, $2, 'usernode', 'running', TRUE,
        $3, NOW(), $4::jsonb)
     ON CONFLICT (slug) DO UPDATE SET
       repo_url          = EXCLUDED.repo_url,
       container_id      = EXCLUDED.container_id,
       status            = EXCLUDED.status,
       self_hosted       = TRUE,
       main_sha          = COALESCE(EXCLUDED.main_sha, apps.main_sha),
       last_deploy_at    = NOW(),
       manifest_snapshot = EXCLUDED.manifest_snapshot
     RETURNING id, slug, name`,
    [
      config.selfAppSlug,
      config.platformRepoUrl,
      sha,
      manifestJson,
    ]
  );

  // dapp.json's top-level `name` takes precedence over the platform name.
  // Best-effort — a rename hiccup must not fail boot/migration.
  if (selfRows.length) {
    await appManifest.reconcileAppName(pool, selfRows[0], manifest)
      .catch((err) => log.warn('db', 'Self-app name reconcile failed', { err: err.message }));
    // Same deal for the manifest's `icon` block — the self-app deploys
    // via GitHub Actions, so this boot-time reconcile is where its
    // homescreen icon (and icon removals) actually apply. The running
    // repo root stands in for the clone dir when the icon is an image.
    await appManifest.reconcileAppIcon(pool, selfRows[0], manifest, repoRoot)
      .catch((err) => log.warn('db', 'Self-app icon reconcile failed', { err: err.message }));
    // And the `governance` block (issue #646). The self-app deploys via
    // GitHub Actions (rebuildProduction never runs for it), so this
    // boot-time reconcile is where a merged governance-change PR's
    // proposal-approval settings actually apply.
    await appManifest.reconcileAppGovernance(pool, selfRows[0], manifest)
      .catch((err) => log.warn('db', 'Self-app governance reconcile failed', { err: err.message }));
    // And the `platform_env` block: the declarations cache that backs the
    // admin console's Platform variables section and the pre-merge check.
    // Only the self-app has one — a child dapp's manifest may carry the
    // block but nothing reads it, because a child's env comes from
    // app_secrets. Values are never touched here, only declarations.
    await appManifest.reconcilePlatformEnv(pool, selfRows[0].id, manifest.platform_env)
      .catch((err) => log.warn('db', 'Self-app platform_env reconcile failed', { err: err.message }));
  }

  log.info('db', 'Self-app row seeded', {
    slug: config.selfAppSlug,
    sha: sha ? sha.slice(0, 7) : '(none)',
    secretsDeclared: manifest.secrets.length,
    platformEnvDeclared: (manifest.platform_env || []).length,
  });
}

// Admin & moderation console fixtures (#818). The SPA admin page's
// Activation-codes section and the Overview LLM-spend card read tables
// that are table-level `staging:private` (activation_codes, llm_usage) and
// therefore arrive EMPTY in staging clones — without seeds both surfaces
// render only their empty states in every PR preview. Seed a tiny,
// obviously-fake set: one available + one used code (both row states plus
// the delete affordance), and a couple of small llm_usage rows for today
// so the spend card shows a non-zero total. Users are the existing staging
// rows (same "first users" convention as seedStagingNotifications).
// Idempotent: codes key on the UNIQUE code value, usage rows on
// UNIQUE(user_id, date). Strictly a no-op outside staging.
async function seedStagingAdminConsoleData(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const { rows: userRows } = await pool.query(
      'SELECT id FROM users ORDER BY is_admin DESC, id ASC LIMIT 2'
    );
    if (!userRows.length) {
      log.warn('db', 'Admin-console staging fixtures skipped: no users');
      return;
    }
    const first = userRows[0];
    const second = userRows[1] || null;

    await pool.query(
      `INSERT INTO activation_codes (code)
       VALUES ('STAGING-DEMO-UNUSED')
       ON CONFLICT (code) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO activation_codes (code, used_by, used_at)
       VALUES ('STAGING-DEMO-USED', $1, NOW() - INTERVAL '1 day')
       ON CONFLICT (code) DO NOTHING`,
      [first.id]
    );

    // ON CONFLICT DO NOTHING keeps any spend already recorded today (e.g.
    // by an earlier boot) intact. Separate statements so a single-user
    // staging DB can't hit the same conflict target twice in one insert.
    await pool.query(
      `INSERT INTO llm_usage (user_id, date, total_cost_cents)
       VALUES ($1, CURRENT_DATE, 123)
       ON CONFLICT (user_id, date) DO NOTHING`,
      [first.id]
    );
    if (second) {
      await pool.query(
        `INSERT INTO llm_usage (user_id, date, total_cost_cents)
         VALUES ($1, CURRENT_DATE, 42)
         ON CONFLICT (user_id, date) DO NOTHING`,
        [second.id]
      );
    }
    log.info('db', 'Admin-console staging fixtures seeded');
  } catch (err) {
    log.warn('db', 'Admin-console staging fixtures failed', { message: err.message });
  }
}

// Email-code sign-in fixtures (issue #1586). Verifying an email code now
// branches on the account's credential state, and none of those states are
// reachable in a staging preview by clicking: `mobile_otp_codes` is
// table-level `staging:private` (so it arrives EMPTY) and `users.password` is
// scrubbed in the clone, so no cloned account has a password anybody knows.
// Seed three obviously-fake accounts, one per branch a tester can drive from
// the sign-in screen:
//
//   staging-code-signin@usernode.test  password set + email confirmed
//                                      → THE FIX: a code signs you straight in
//   staging-code-setup@usernode.test   no password yet
//                                      → the unchanged password-setup step,
//                                        which also stamps the confirmation
//   staging-code-legacy@usernode.test  password set, email NEVER confirmed
//                                      → routed to the password form instead
//
// The two password-bearing accounts share one documented literal,
// `staging-code-password`, so a tester can also sign in the ordinary way and
// compare. `has_platform_access` is TRUE on all three or signing in lands on
// the waitlist instead of the platform.
//
// Staging mail is the log-only transport, so the tester reads the code out of
// the platform log rather than a mailbox.
//
// Idempotent via fixed ids + ON CONFLICT DO NOTHING, and the credential states
// are RE-PINNED on every boot: completing the flow mutates them by design
// (setup gains a password, legacy would gain a confirmation), so without the
// pin each fixture is testable exactly once per staging database. Strictly a
// no-op outside staging.
async function seedStagingEmailCodeAccounts(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    const knownHash = await bcrypt.hash('staging-code-password', 12);
    const unusableHash = await bcrypt.hash(
      crypto.randomBytes(32).toString('hex'),
      12
    );

    await pool.query(
      `INSERT INTO users
         (id, username, password, email, email_confirmed, email_confirmed_at,
          password_set, is_admin, has_platform_access)
       VALUES
         (900130, 'staging-code-signin@usernode.test', $1,
          'staging-code-signin@usernode.test', TRUE, NOW(), TRUE, FALSE, TRUE),
         (900131, 'staging-code-setup@usernode.test', $2,
          'staging-code-setup@usernode.test', FALSE, NULL, FALSE, FALSE, TRUE),
         (900132, 'staging-code-legacy@usernode.test', $1,
          'staging-code-legacy@usernode.test', FALSE, NULL, TRUE, FALSE, TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [knownHash, unusableHash]
    );

    await pool.query(
      `UPDATE users
          SET password = $1, email_confirmed = TRUE, email_confirmed_at = NOW(),
              password_set = TRUE, has_platform_access = TRUE
        WHERE id = 900130`,
      [knownHash]
    );
    await pool.query(
      `UPDATE users
          SET password = $1, email_confirmed = FALSE, email_confirmed_at = NULL,
              password_set = FALSE, has_platform_access = TRUE
        WHERE id = 900131`,
      [unusableHash]
    );
    await pool.query(
      `UPDATE users
          SET password = $1, email_confirmed = FALSE, email_confirmed_at = NULL,
              password_set = TRUE, has_platform_access = TRUE
        WHERE id = 900132`,
      [knownHash]
    );
    // A previous run of the flow may have left a continuation behind; drop it
    // so each fixture starts from the state its branch describes.
    await pool.query(
      'DELETE FROM web_signup_sessions WHERE user_id IN (900130, 900131, 900132)'
    );

    log.info('db', 'Staging email-code sign-in fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging email-code sign-in fixtures seeding failed', {
      message: err.message,
    });
  }
}

// Platform-variables fixtures. `platform_env_values` is table-level
// `staging:private`, so a staging clone arrives with ZERO values — the
// platform app's Platform variables panel (its "+" menu → the app-secrets
// modal) would render nothing but its empty state in every PR preview, and
// the "set / unset / private / orphaned" row states (the whole point of
// the screen) would be unreviewable. Declarations DO survive the clone
// (they're a copy of a public committed file), so only values need
// seeding — plus one extra declaration that is deliberately
// required-and-unset, because that state is what the pre-merge check
// blocks on and it can't otherwise be demonstrated without breaking the
// real manifest.
//
// The "deploy-managed" row state needs no fixture: those rows are
// synthesized in routes/apps.js from the manifest's `secrets` block, which
// travels with the cloned manifest_snapshot.
//
// Four rows covering every state the UI renders:
//   STAGING_DEMO_PUBLIC_URL   — set, non-private (value shown in full)
//   STAGING_DEMO_SECRET_TOKEN — set, private (never displayed at all — a
//                               private row keeps NO last-4, on the
//                               grounds that 4 characters of a token is
//                               still 4 characters of a token)
//   STAGING_DEMO_REQUIRED     — declared required, NO value (blocks merge)
//   STAGING_DEMO_ORPHAN       — value with no declaration (removed from
//                               dapp.json but deliberately kept)
// Plus one proposal stamped platform_env_state='failing' so the Checks
// card's platform-env row has something to show.
//
// The two seeded declarations are transient by design: the next boot's
// reconcilePlatformEnv() deletes anything absent from dapp.json, and this
// seed (which runs after it) puts them straight back. Strictly a no-op
// outside staging.
async function seedStagingPlatformEnv(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  if (!config.dataEncryptionKey) {
    log.warn('db', 'Platform-env staging fixtures skipped: no data-encryption key to encrypt with');
    return;
  }
  try {
    const { rows: appRows } = await pool.query(
      'SELECT id FROM apps WHERE slug = $1',
      [config.selfAppSlug]
    );
    const appId = appRows[0]?.id;
    if (!appId) {
      log.warn('db', 'Platform-env staging fixtures skipped: self-app row missing', {
        slug: config.selfAppSlug,
      });
      return;
    }
    const { rows: userRows } = await pool.query(
      'SELECT id FROM users ORDER BY is_admin DESC, id ASC LIMIT 1'
    );
    const updatedBy = userRows[0]?.id || null;

    // Declarations: the required-but-unset one, and the two that carry
    // values. STAGING_DEMO_ORPHAN gets no declaration — that IS its state.
    const decls = [
      ['STAGING_DEMO_PUBLIC_URL', 'Demo: a non-private platform variable. Safe to display in full.', false, false, 'Staging demo'],
      ['STAGING_DEMO_SECRET_TOKEN', 'Demo: a private platform variable. Its value is never returned by the API at all — not even the last 4 characters.', false, true, 'Staging demo'],
      ['STAGING_DEMO_REQUIRED', 'Demo: declared required with no value set — this is the state that blocks a merge.', true, false, 'Staging demo'],
    ];
    for (const [key, description, required, isPrivate, grouping] of decls) {
      await pool.query(
        `INSERT INTO platform_env_declarations
           (app_id, key, description, required, private, grouping, unwritable)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE)
         ON CONFLICT (app_id, key) DO NOTHING`,
        [appId, key, description, required, isPrivate, grouping]
      );
    }

    const values = [
      ['STAGING_DEMO_PUBLIC_URL', 'https://demo.staging.invalid/hook', false],
      ['STAGING_DEMO_SECRET_TOKEN', 'sk-staging-demo-0000-9f3a', true],
      ['STAGING_DEMO_ORPHAN', 'left-behind-after-removal', false],
    ];
    for (const [key, value, isPrivate] of values) {
      await pool.query(
        `INSERT INTO platform_env_values
           (app_id, key, value_enc, value_last4, private, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '2 days')
         ON CONFLICT (app_id, key) DO NOTHING`,
        [appId, key, encrypt(value, config.dataEncryptionKey),
          isPrivate ? null : value.slice(-4), isPrivate, updatedBy]
      );
    }

    // ── Declaration proposals in flight (pending_secret_declarations) ──
    //
    // The table is brand new AND staging:private, so a clone starts empty
    // and the panel's three new row states would be unreviewable in every
    // PR preview. Each fixture is bound to a live (promoted) self-app
    // session, because listLive() only returns rows whose proposal is
    // still in flight — without one the rows are correctly invisible.
    const { rows: liveSess } = await pool.query(
      `SELECT id FROM chat_sessions
        WHERE app_id = $1 AND status IN ('promoted', 'merging')
        ORDER BY id DESC LIMIT 1`,
      [appId]
    );
    const sessionId = liveSess[0]?.id || null;
    if (!sessionId) {
      log.info('db', 'Platform-env pending fixtures skipped: no live self-app proposal');
    } else {
      // Three rows, one per visual:
      //   STAGING_DEMO_PROPOSED         — up for vote, value included
      //                                   (non-private → shows a last-4)
      //   STAGING_DEMO_PROPOSED_PRIVATE — up for vote, private value (no
      //                                   preview of any kind)
      //   STAGING_DEMO_ADMIN_SET        — an admin already stored the
      //                                   value, declaration still voting
      //                                   (value_enc NULL + applied stamp,
      //                                   plus the real value row below)
      const pendings = [
        ['STAGING_DEMO_PROPOSED', {
          description: 'Demo: a variable proposed from the panel, with its value riding along.',
          required: false, private: false, default: null, staging_default: null, group: 'Staging demo',
        }, 'https://demo.proposed.invalid/hook'],
        ['STAGING_DEMO_PROPOSED_PRIVATE', {
          description: 'Demo: a proposed PRIVATE variable — its value is never previewed, not even the last 4 characters.',
          required: true, private: true, default: null, staging_default: null, group: 'Staging demo',
        }, 'sk-staging-demo-proposed-4d1c'],
        ['STAGING_DEMO_ADMIN_SET', {
          description: 'Demo: an admin set the value outright; the declaration is still up for vote.',
          required: false, private: false, default: null, staging_default: null, group: 'Staging demo',
        }, null],
      ];
      for (const [key, declaration, value] of pendings) {
        const isPrivate = !!declaration.private;
        await pool.query(
          `INSERT INTO pending_secret_declarations
             (app_id, session_id, scope, key, declaration, value_enc, value_last4,
              value_applied_at, status, created_by, created_at)
           SELECT $1, $2, 'platform', $3::varchar, $4::jsonb, $5, $6, $7, 'pending', $8,
                  NOW() - INTERVAL '3 hours'
            WHERE NOT EXISTS (
              SELECT 1 FROM pending_secret_declarations
               WHERE app_id = $1 AND key = $3::varchar AND status = 'pending')`,
          [
            appId, sessionId, key, JSON.stringify(declaration),
            value ? encrypt(value, config.dataEncryptionKey) : null,
            value && !isPrivate ? value.slice(-4) : null,
            value ? null : new Date(),
            updatedBy,
          ]
        );
      }
      // The value row that makes STAGING_DEMO_ADMIN_SET's "value set ·
      // declaration up for vote" state real rather than just labelled.
      await pool.query(
        `INSERT INTO platform_env_values
           (app_id, key, value_enc, value_last4, private, updated_by, updated_at)
         VALUES ($1, 'STAGING_DEMO_ADMIN_SET', $2, $3, FALSE, $4, NOW() - INTERVAL '3 hours')
         ON CONFLICT (app_id, key) DO NOTHING`,
        [appId, encrypt('set-by-an-admin-before-the-vote', config.dataEncryptionKey), 'vote', updatedBy]
      );

      // A child-app pending row too, so the app-scope variant of the row
      // (and its staging_default field) is reviewable. Skipped silently
      // when the clone has no child app with a live proposal.
      const { rows: childRows } = await pool.query(
        `SELECT cs.id AS session_id, cs.app_id
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
          WHERE a.self_hosted = FALSE AND cs.status IN ('promoted', 'merging')
          ORDER BY cs.id DESC LIMIT 1`
      );
      if (childRows.length) {
        await pool.query(
          `INSERT INTO pending_secret_declarations
             (app_id, session_id, scope, key, declaration, value_enc, value_last4,
              status, created_by, created_at)
           SELECT $1, $2, 'app', 'STAGING_DEMO_APP_TOKEN', $3::jsonb, $4, $5,
                  'pending', $6, NOW() - INTERVAL '2 hours'
            WHERE NOT EXISTS (
              SELECT 1 FROM pending_secret_declarations
               WHERE app_id = $1 AND key = 'STAGING_DEMO_APP_TOKEN' AND status = 'pending')`,
          [
            childRows[0].app_id, childRows[0].session_id,
            JSON.stringify({
              description: 'Demo: an app secret proposed from the panel, with a staging fallback committed.',
              required: true,
              private: true,
              default: null,
              staging_default: 'staging-demo-token',
              group: 'General',
            }),
            encrypt('prod-demo-token-9a2f', config.dataEncryptionKey),
            null,
            updatedBy,
          ]
        );
      }
    }

    // Give the Checks card a failing platform-env verdict to render. Any
    // open/promoted self-app proposal will do; only stamp one that has no
    // verdict yet so a real evaluation in the preview isn't overwritten.
    await pool.query(
      `UPDATE chat_sessions
          SET platform_env_state = 'failing',
              platform_env_detail = $1::jsonb
        WHERE id = (
          SELECT id FROM chat_sessions
           WHERE app_id = $2
             AND status IN ('open', 'promoted')
             AND platform_env_state IS NULL
           ORDER BY id DESC
           LIMIT 1
        )`,
      [
        JSON.stringify({
          missing: [{
            key: 'STAGING_DEMO_REQUIRED',
            required: true,
            description: 'Demo: declared required with no value set — this is the state that blocks a merge.',
          }],
          added: ['STAGING_DEMO_REQUIRED'],
          removed: [],
          pendingValues: [],
          reason: 'This proposal adds 1 required platform variable that has no value set.',
        }),
        appId,
      ]
    );

    // …and a PASSING verdict whose value rides along with the proposal, so
    // the Checks card's "carries its value with this proposal" line is
    // reviewable too. A different session from the failing one above (that
    // one now has a verdict, so `platform_env_state IS NULL` skips it).
    await pool.query(
      `UPDATE chat_sessions
          SET platform_env_state = 'passing',
              platform_env_detail = $1::jsonb
        WHERE id = (
          SELECT id FROM chat_sessions
           WHERE app_id = $2
             AND status IN ('open', 'promoted')
             AND platform_env_state IS NULL
           ORDER BY id DESC
           LIMIT 1
        )`,
      [
        JSON.stringify({
          missing: [],
          added: ['STAGING_DEMO_PROPOSED'],
          removed: [],
          pendingValues: ['STAGING_DEMO_PROPOSED'],
          reason: 'This proposal adds 1 platform variable and carries its value, applied when it merges.',
        }),
        appId,
      ]
    );

    log.info('db', 'Platform-env staging fixtures seeded');
  } catch (err) {
    log.warn('db', 'Platform-env staging fixtures failed', { message: err.message });
  }
}

// Boot sweep for the database-export audit log. A row is written BEFORE
// the dump is spawned and only reaches a terminal status when the stream
// resolves — so a process killed mid-export (deploy cutover: the usernode
// service has stop_grace_period: 10s; OOM; hard crash) leaves the row
// stuck in `requested` or `streaming` forever. Nothing else can ever
// resolve those rows: the in-memory single-flight guard and the child
// process both died with the old process. Flip them to `interrupted` at
// boot so the admin console's history never shows a phantom in-flight
// export. NOT staging-gated — this is a production correctness sweep.
async function sweepInterruptedDbExports(pool) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE db_exports
          SET status = 'interrupted',
              finished_at = COALESCE(finished_at, NOW()),
              error = COALESCE(error, 'platform restarted while the export was in flight')
        WHERE status IN ('requested', 'streaming')`
    );
    if (rowCount) {
      log.warn('db', 'Marked stale database exports interrupted', { count: rowCount });
    }
  } catch (err) {
    log.warn('db', 'Database-export sweep failed', { message: err.message });
  }
}

// `db_exports` is BOTH brand new and tagged staging:private, so a staging
// clone starts with an empty table and the export-history UI would render
// as a bare "no exports yet" line — untestable in a preview, especially
// since the export button itself is (deliberately) disabled there. Seed
// one obviously-fake row per visual state. Fake IPs come from 203.0.113.0/24
// (RFC 5737 documentation range) so no row can be mistaken for a real one.
async function seedStagingDbExports(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM db_exports WHERE username LIKE 'Staging demo%' LIMIT 1`
    );
    if (existing.length) return;

    const { rows: userRows } = await pool.query(
      'SELECT id FROM users ORDER BY is_admin DESC, id ASC LIMIT 1'
    );
    if (!userRows.length) {
      log.warn('db', 'Database-export staging fixtures skipped: no users');
      return;
    }
    const adminId = userRows[0].id;
    const dbName = 'staging_demo_platform_db';

    await pool.query(
      `INSERT INTO db_exports
         (user_id, username, db_name, status, denied_reason, ip, user_agent,
          bytes_sent, requested_at, started_at, finished_at, error)
       VALUES
         ($1, 'Staging demo admin', $2, 'completed', NULL, '203.0.113.10',
          'Staging demo browser', 188743680,
          NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days',
          NOW() - INTERVAL '2 days' + INTERVAL '40 seconds', NULL),
         ($1, 'Staging demo admin', $2, 'failed', NULL, '203.0.113.10',
          'Staging demo browser', 0,
          NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day',
          NOW() - INTERVAL '1 day' + INTERVAL '3 seconds',
          'Staging demo failure — pg_dump exited 1'),
         ($1, 'Staging demo admin', $2, 'denied', 'bad_password', '203.0.113.22',
          'Staging demo browser', 0,
          NOW() - INTERVAL '5 hours', NULL, NOW() - INTERVAL '5 hours', NULL),
         ($1, 'Staging demo admin', $2, 'cancelled', NULL, '203.0.113.10',
          'Staging demo browser', 4194304,
          NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour',
          NOW() - INTERVAL '1 hour' + INTERVAL '12 seconds', NULL)`,
      [adminId, dbName]
    );
    log.info('db', 'Database-export staging fixtures seeded');
  } catch (err) {
    log.warn('db', 'Database-export staging fixtures failed', { message: err.message });
  }
}

// Staging clones intentionally TRUNCATE table-level `staging:private`
// tables, including `notifications`, so production social data never leaks
// into a preview. For the platform self-app, that made notification UI work
// hard to test in staging. Seed a tiny, synthetic set after the privacy pass
// has already run. Idempotent on restart: every row is keyed off fixture
// message/session content and checked before insert.
async function seedStagingNotifications(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 2`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging notification fixtures skipped: no users');
    return;
  }

  const target = userRows.find((u) => u.is_admin) || userRows[0];
  const source = userRows.find((u) => u.id !== target.id) || target;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging notification fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const messageIds = {};
  for (const [key, content] of Object.entries({
    mention: `[staging fixture] Mention notification for @${target.username}`,
    reply: '[staging fixture] Reply notification target message',
    reaction: '[staging fixture] Reaction notification target message',
  })) {
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_messages WHERE app_id = $1 AND content = $2 LIMIT 1',
      [appId, content]
    );
    if (existing.length) {
      messageIds[key] = existing[0].id;
      continue;
    }
    const { rows } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at)
       VALUES ($1, $2, $3, 'message', NOW() - ($4::int * INTERVAL '1 minute'))
       RETURNING id`,
      [appId, source.id, content, key === 'mention' ? 18 : key === 'reply' ? 16 : 14]
    );
    messageIds[key] = rows[0].id;
  }

  const fixtureBranch = 'staging-fixture/notifications';
  let sessionId;
  const { rows: sessionRows } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (sessionRows.length) {
    sessionId = sessionRows[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, status, created_at)
       VALUES
         ($1, $2, $3, 9001, 'Staging fixture PR for notification testing', 'promoted',
          NOW() - INTERVAL '12 minutes')
       RETURNING id`,
      [appId, source.id, fixtureBranch]
    );
    sessionId = rows[0].id;
  }

  // #138: give the fixture session a headless issue number so the
  // auto_solve_done row below renders "issue #9042" and deep-links to the
  // Issues tab. Idempotent (only fills when unset).
  await pool.query(
    `UPDATE chat_sessions
        SET headless_issue_number = COALESCE(headless_issue_number, 9042)
      WHERE id = $1`,
    [sessionId]
  );

  const fixtures = [
    { kind: 'mention', chatMessageId: messageIds.mention, sourceUserId: source.id, minutesAgo: 11 },
    { kind: 'reply', chatMessageId: messageIds.reply, sourceUserId: source.id, minutesAgo: 10 },
    {
      kind: 'reaction',
      chatMessageId: messageIds.reaction,
      sourceUserId: source.id,
      detail: '👀',
      minutesAgo: 9,
    },
    { kind: 'pr_proposed', sessionId, sourceUserId: source.id, minutesAgo: 8 },
    { kind: 'stale_pr', sessionId, sourceUserId: null, minutesAgo: 7 },
    {
      kind: 'kudos',
      sessionId,
      sourceUserId: source.id,
      readAt: true,
      minutesAgo: 6,
    },
    // #138: two UNREAD AI-completion fixtures so the bell's distinct green
    // badge shows "2" on staging load — one interactive dev-session
    // completion and one headless proposal run. Both are system-generated
    // (no source user) and deep-link into the dev tab when clicked.
    { kind: 'session_done', sessionId, sourceUserId: null, minutesAgo: 5 },
    { kind: 'auto_solve_done', sessionId, sourceUserId: null, detail: 'code', minutesAgo: 4 },
    // #646: approver-invite badge/history row. The actionable pinned
    // Invites card is driven by the app_approvers 'invited' row seeded
    // below, this notification is the badge bump + history entry.
    { kind: 'approver_invite', sourceUserId: source.id, minutesAgo: 3 },
  ];

  // #646: pending approver invite for the target admin, so the drawer's
  // pinned Invites section shows the new approver-invite card (Accept /
  // Decline) on staging. Idempotent; accepting/declining in a preview
  // just mutates the staging clone.
  await pool.query(
    `INSERT INTO app_approvers (app_id, user_id, status, invited_by)
     VALUES ($1, $2, 'invited', $3)
     ON CONFLICT (app_id, user_id) DO NOTHING`,
    [appId, target.id, source.id]
  );

  let inserted = 0;
  for (const f of fixtures) {
    const { rows: existing } = await pool.query(
      `SELECT id FROM notifications
        WHERE user_id = $1
          AND app_id = $2
          AND kind = $3
          AND COALESCE(chat_message_id, -1) = COALESCE($4::int, -1)
          AND COALESCE(session_id, -1) = COALESCE($5::int, -1)
        LIMIT 1`,
      [target.id, appId, f.kind, f.chatMessageId || null, f.sessionId || null]
    );
    if (existing.length) continue;

    await pool.query(
      `INSERT INTO notifications
         (user_id, app_id, chat_message_id, session_id, source_user_id,
          kind, detail, read_at, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7,
          CASE WHEN $8::boolean THEN NOW() - INTERVAL '1 minute' ELSE NULL END,
          NOW() - ($9::int * INTERVAL '1 minute'))`,
      [
        target.id,
        appId,
        f.chatMessageId || null,
        f.sessionId || null,
        f.sourceUserId,
        f.kind,
        f.detail || null,
        !!f.readAt,
        f.minutesAgo,
      ]
    );
    inserted++;
  }

  // Multi-app fixtures (#84 grouping): the self-app block above gives ONE
  // app with many notifications; here we add a few OTHER apps so the
  // grouped/collapsed view has realistic multi-app data to render. The
  // first other app gets two notifications (a collapsible multi-item
  // group); the remaining ones get a single notification each (which the
  // UI renders as a plain leaf row). Same idempotency pattern as above:
  // fixture chat-message content + the notification's (kind, message)
  // tuple are checked before every insert.
  const { rows: otherApps } = await pool.query(
    `SELECT id, slug, name FROM apps
      WHERE slug <> $1
      ORDER BY id ASC
      LIMIT 3`,
    [config.selfAppSlug]
  );

  let multiAppInserted = 0;
  for (let i = 0; i < otherApps.length; i++) {
    const app = otherApps[i];
    const appName = app.name || app.slug;
    // First other app: an over-the-limit group (>GROUP_LEAF_CAP, which is
    // 10 in the drawer) so the inline "Show more" pagination control is
    // exercised. Mixed read/unread so unread-first ordering is visible
    // too. Each row gets unique content -> a distinct fixture chat message
    // -> a distinct (kind, chat_message_id) idempotency key, so reboots
    // never duplicate or drift. Others: one notification each -> a single
    // leaf row.
    let specs;
    if (i === 0) {
      specs = [];
      for (let k = 0; k < 15; k++) {
        specs.push({
          kind: k % 2 === 0 ? 'mention' : 'reply',
          content: `[staging fixture] ${appName} pagination row ${k + 1} for @${target.username}`,
          minutesAgo: 20 - k,   // staggered, newest-first
          readAt: k % 3 === 0,  // ~1/3 read, rest unread
        });
      }
    } else {
      specs = [
        { kind: 'mention', content: `[staging fixture] @${target.username} mentioned in ${appName}`, minutesAgo: 5 - i },
      ];
    }

    for (const spec of specs) {
      // Upsert the fixture chat message this notification points at, so
      // the dropdown row renders a real snippet + a working deep link.
      let chatMessageId;
      const { rows: existingMsg } = await pool.query(
        'SELECT id FROM chat_messages WHERE app_id = $1 AND content = $2 LIMIT 1',
        [app.id, spec.content]
      );
      if (existingMsg.length) {
        chatMessageId = existingMsg[0].id;
      } else {
        const { rows } = await pool.query(
          `INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at)
           VALUES ($1, $2, $3, 'message', NOW() - ($4::int * INTERVAL '1 minute'))
           RETURNING id`,
          [app.id, source.id, spec.content, spec.minutesAgo + 1]
        );
        chatMessageId = rows[0].id;
      }

      const { rows: existingNotif } = await pool.query(
        `SELECT id FROM notifications
          WHERE user_id = $1
            AND app_id = $2
            AND kind = $3
            AND COALESCE(chat_message_id, -1) = COALESCE($4::int, -1)
          LIMIT 1`,
        [target.id, app.id, spec.kind, chatMessageId]
      );
      if (existingNotif.length) continue;

      await pool.query(
        `INSERT INTO notifications
           (user_id, app_id, chat_message_id, source_user_id, kind, read_at, created_at)
         VALUES
           ($1, $2, $3, $4, $5,
            CASE WHEN $6::boolean THEN NOW() - INTERVAL '1 minute' ELSE NULL END,
            NOW() - ($7::int * INTERVAL '1 minute'))`,
        [target.id, app.id, chatMessageId, source.id, spec.kind, !!spec.readAt, spec.minutesAgo]
      );
      multiAppInserted++;
    }
  }

  // Backlog fixtures (#279): the "Show older notifications" footer only
  // appears when the first /api/notifications page returns a full 100
  // rows (hasMore). The fixtures above total only ~20-25, so the footer
  // — and the pagination it drives — would never render in a staging
  // preview. Seed a deep backlog under the self-app so the target user
  // comfortably clears the 100-row first page. All older than the
  // fixtures above (so they sort to the bottom) and marked read so the
  // unread badge stays realistic. Idempotent: each backlog row hangs off
  // a fixture chat message whose content carries its index, and both
  // inserts skip rows that already exist (NOT EXISTS), so reboots neither
  // duplicate nor drift. Two set-based statements, not 200 round-trips.
  const BACKLOG_COUNT = 110;
  const backlogPrefix = '[staging fixture] backlog notification';
  const backlogLike = `${backlogPrefix} #%`;

  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at)
     SELECT $1, $2, $3 || ' #' || g, 'message', NOW() - ((100 + g) * INTERVAL '1 minute')
       FROM generate_series(1, $4) AS g
      WHERE NOT EXISTS (
        SELECT 1 FROM chat_messages m
         WHERE m.app_id = $1 AND m.content = $3 || ' #' || g
      )`,
    [appId, source.id, backlogPrefix, BACKLOG_COUNT]
  );

  const { rowCount: backlogInserted } = await pool.query(
    `INSERT INTO notifications
       (user_id, app_id, chat_message_id, source_user_id, kind, read_at, created_at)
     SELECT $1, $2, m.id, $3,
            CASE WHEN m.id % 2 = 0 THEN 'mention' ELSE 'reply' END,
            NOW() - INTERVAL '1 minute',
            m.created_at
       FROM chat_messages m
      WHERE m.app_id = $2
        AND m.content LIKE $4
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.user_id = $1 AND n.chat_message_id = m.id
        )`,
    [target.id, appId, source.id, backlogLike]
  );

  log.info('db', 'Staging notification fixtures seeded', {
    targetUser: target.username,
    inserted,
    multiAppInserted,
    backlogInserted,
    otherApps: otherApps.length,
  });
}

// #1130: staging fixtures for the mobile-push delivery tables, so the admin
// SQL console has something to SELECT the moment they become queryable.
//
// The issue that widened the console's scope was an admin trying to debug
// push delivery and being told the tables "are not available in this
// console". They are now — with `mobile_push_registrations`'s encrypted
// destination and lookup hash masked at the GRANT level — but on a fresh
// staging preview all three tables are EMPTY: they are table-level
// `staging:private`, so cloneDatabase TRUNCATEs them, and staging never
// registers a real device. A reviewer clicking `mobile_push_deliveries` in
// the schema browser would draft a perfectly valid SELECT and get zero
// rows, which looks identical to the bug. These three rows make the
// widening visible.
//
// INERT BY CONSTRUCTION: the fixture uses its own `environment` value
// ('staging-fixture'), never `config.mobilePushEnvironment`. So
// mobile-push.js's synchronizeDeploymentState leaves the registration
// alone (it only DELETEs registrations for the CONFIGURED environment on a
// project change) and its cross-environment sweeps are no-ops here — they
// force send_enabled=FALSE (already false) and cancel only 'pending'/
// 'sending' deliveries (these are 'sent' and 'dead'). The push worker
// claims 'pending' rows only, so it never touches these either. No real
// device, no real FCM token, nothing sendable.
//
// Idempotent: every insert is ON CONFLICT DO NOTHING against a real unique
// constraint, and the two delivery rows are keyed by the fixed
// (notification_id, environment, installation_id) triple.
async function seedStagingPushDeliveries(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging push-delivery fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  // `mobile_push_deliveries.notification_id` is a NOT NULL FK, so the
  // fixture hangs off a notification that already exists. Lowest id on the
  // self-app: seedStagingNotifications runs immediately before this and is
  // itself idempotent, so that id is stable across reboots — which is what
  // keeps the deliveries' ON CONFLICT key stable too.
  const { rows: notificationRows } = await pool.query(
    `SELECT id, user_id FROM notifications
      WHERE app_id = $1
      ORDER BY id ASC
      LIMIT 1`,
    [appId]
  );
  if (!notificationRows.length) {
    log.warn('db', 'Staging push-delivery fixtures skipped: no notification to attach to');
    return;
  }
  const notificationId = notificationRows[0].id;
  const userId = notificationRows[0].user_id;

  const ENVIRONMENT = 'staging-fixture';
  const LIVE_INSTALLATION = '11300000-0000-4000-8000-000000000001';
  const GONE_INSTALLATION = '11300000-0000-4000-8000-000000000002';

  // Obviously fake, and both masked in the console anyway: `registration_hash`
  // still has to satisfy the table's `^[0-9a-f]{64}$` CHECK, and
  // `registration_enc` its non-blank one. Neither is a real FCM token and
  // neither decrypts to anything.
  const REGISTRATION_HASH = '11300000'.repeat(8);
  const REGISTRATION_ENC = 'staging-fixture-not-a-real-push-registration';

  await pool.query(
    `INSERT INTO mobile_push_registrations
       (user_id, native_session_credential_reference, environment,
        installation_id, provider, registration_hash,
        registration_enc, platform, permission_status, session_expires_at,
        last_seen_at)
     SELECT c.user_id::integer, c.credential_reference, $2, $3::uuid, 'fcm', $4, $5,
            'android', 'authorized', c.expires_at,
            NOW() - INTERVAL '20 minutes'
       FROM native_session_credentials c
      WHERE c.user_id = $1
        AND c.state = 'valid'
        AND c.expires_at > NOW()
      ORDER BY c.created_at DESC
      LIMIT 1
     ON CONFLICT (environment, installation_id) DO NOTHING`,
    [userId, ENVIRONMENT, LIVE_INSTALLATION, REGISTRATION_HASH, REGISTRATION_ENC]
  );

  // One delivered row and one that exhausted its retries, because the
  // status/attempts/last_error_code triple is the whole reason an admin
  // opens this table. The 'dead' row deliberately has registration_id NULL
  // (the device's registration was already reaped, which is the real-world
  // shape of an UNREGISTERED failure) so the console's joined template
  // exercises its LEFT JOIN against a missing registration too.
  await pool.query(
    `INSERT INTO mobile_push_deliveries
       (notification_id, registration_id, environment, installation_id,
        status, attempts, available_at, expires_at, sent_at, last_error_code,
        created_at, updated_at)
     SELECT $1, r.id, $2::varchar, $3::uuid,
            'sent', 1,
            NOW() - INTERVAL '19 minutes', NOW() + INTERVAL '5 hours',
            NOW() - INTERVAL '19 minutes', NULL,
            NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '19 minutes'
       FROM mobile_push_registrations r
      WHERE r.environment = $2::varchar AND r.installation_id = $3::uuid
     ON CONFLICT (notification_id, environment, installation_id) DO NOTHING`,
    [notificationId, ENVIRONMENT, LIVE_INSTALLATION]
  );

  await pool.query(
    `INSERT INTO mobile_push_deliveries
       (notification_id, registration_id, environment, installation_id,
        status, attempts, available_at, expires_at, sent_at, last_error_code,
        created_at, updated_at)
     VALUES
       ($1, NULL, $2, $3::uuid,
        'dead', 5,
        NOW() - INTERVAL '15 minutes', NOW() - INTERVAL '10 minutes',
        NULL, 'UNREGISTERED',
        NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '15 minutes')
     ON CONFLICT (notification_id, environment, installation_id) DO NOTHING`,
    [notificationId, ENVIRONMENT, GONE_INSTALLATION]
  );

  // The deployment-state row the console's joined template and the schema
  // browser both make more legible. send_enabled FALSE (and so
  // send_not_before NULL, per the table's own CHECK) — nothing about this
  // fixture can cause a send.
  await pool.query(
    `INSERT INTO mobile_push_deployment_state
       (environment, firebase_project_id, send_enabled, send_not_before)
     VALUES ($1, 'staging-fixture-firebase-project', FALSE, NULL)
     ON CONFLICT (environment) DO NOTHING`,
    [ENVIRONMENT]
  );

  log.info('db', 'Staging push-delivery fixtures seeded', {
    environment: ENVIRONMENT,
    notificationId,
  });
}

// Staging fixtures for multi-line messages + message editing. Both behaviors
// are otherwise invisible on a fresh staging preview (a multi-line message
// needs someone to have typed one; the "edited" marker needs a row with
// edited_at set). Seeds two obviously-fake messages on the self-app:
//   1. a multi-line message (embedded newlines + a blank line) to verify
//      white-space: pre-wrap rendering.
//   2. an already-edited message (edited_at after created_at) to verify the
//      "edited" marker and its full-timestamp tooltip.
// Idempotent: keyed on (app_id, content) like seedStagingNotifications, so a
// rebuild doesn't duplicate. Strictly a staging no-op in production.
async function seedStagingChatEditFixtures(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: userRows } = await pool.query(
    `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging chat-edit fixtures skipped: no users');
    return;
  }
  const author = userRows[0];

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging chat-edit fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  // 1) Multi-line message (pre-wrap rendering). Blank line between
  //    paragraphs is intentional — it must survive to the rendered row.
  const multiline = [
    '[staging fixture] Multi-line message:',
    '• first point',
    '• second point',
    '',
    'A closing paragraph after a blank line.',
  ].join('\n');

  // 2) Already-edited message (shows the "edited" marker + tooltip).
  const edited = '[staging fixture] This message was edited — hover the “edited” marker by the timestamp to see when.';

  // 3) #328: markdown demo. Exercises the full supported subset in one body —
  //    bold/italic/strikethrough, inline + fenced code, a bullet list, an
  //    https link — alongside an @mention and PR#/#N refs (which must still
  //    decorate atop the rendered markdown), plus an inert <script> tag and a
  //    javascript: link to confirm sanitization renders them harmless. Stored
  //    as raw markdown source; formatting is applied only on display.
  const markdown = [
    `[staging fixture] Markdown demo for @${author.username}:`,
    '',
    'Shows **bold**, *italic*, ~~strikethrough~~ and `inline code`.',
    '',
    '- first bullet',
    '- second bullet with a [link](https://example.com)',
    '',
    'A fenced code block:',
    '```',
    'function hi() { return 42; }',
    '```',
    '',
    'Refs stay clickable atop markdown: see PR#1 and issue #1.',
    '',
    'Safety check (must render inert): <script>alert(1)</script> and [bad](javascript:alert(2)).',
  ].join('\n');

  let inserted = 0;
  for (const fixture of [
    { content: multiline, createdMinutesAgo: 8, editedMinutesAgo: null },
    { content: edited, createdMinutesAgo: 7, editedMinutesAgo: 5 },
    { content: markdown, createdMinutesAgo: 6, editedMinutesAgo: null },
  ]) {
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_messages WHERE app_id = $1 AND content = $2 LIMIT 1',
      [appId, fixture.content]
    );
    if (existing.length) continue;
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at, edited_at)
       VALUES ($1, $2, $3, 'message',
               NOW() - ($4::int * INTERVAL '1 minute'),
               CASE WHEN $5::int IS NULL THEN NULL
                    ELSE NOW() - ($5::int * INTERVAL '1 minute') END)`,
      [appId, author.id, fixture.content, fixture.createdMinutesAgo, fixture.editedMinutesAgo]
    );
    inserted++;
  }

  if (inserted) {
    log.info('db', 'Seeded staging chat-edit/multiline fixtures', { appId, inserted });
  }
}

// Staging fixture for the "Environment variables" vote-panel section
// (#131). The backing `issues` table is public (copied to staging with
// rows), but no open secret_change proposal usually exists in prod, so
// the section would render empty on every preview. Seed one synthetic
// open proposal for the self-app — payload shaped exactly like the
// create path in routes/issues.js, including a real `valueEnc`
// ciphertext (encrypted with this environment's own data-encryption key
// — in staging that's the committed non-secret constant from
// config.stagingDataKey(), so this fixture is never confusable with prod
// ciphertext) so vote-through-majority / admin-apply work end-to-end.
// github_issue_number stays NULL: the fixture has no GitHub twin, which
// also means the kudos button is (correctly) omitted on its row.
// Idempotent on restart: keyed off the fixture title, any status — a
// proposal applied/closed during testing doesn't resurrect on the next
// boot.
//
// The key is STAGING_DEMO_PUBLIC_URL, which seedStagingPlatformEnv() also
// declares and sets. That pairing is deliberate: because this is the
// SELF-hosted app, voting the fixture through exercises the platform-env
// apply branch (write via the platform-env DAO, no rebuildProduction) and
// the reviewer can see the change land on the matching row in the Platform
// variables panel. A key nothing declares would still apply, but as an
// orphan row — a worse demo of the normal case.
async function seedStagingEnvProposal(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  if (!config.dataEncryptionKey) {
    log.warn('db', 'Staging env-proposal fixture skipped: no data-encryption key to encrypt with');
    return;
  }

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging env-proposal fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 2`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging env-proposal fixture skipped: no users');
    return;
  }
  const creator = userRows[0];
  const secondVoter = userRows[1] || null;

  // Title matches what routes/issues.js generates for a real proposal,
  // and doubles as the idempotency key.
  const fixtureKey = 'STAGING_DEMO_PUBLIC_URL';
  const fixtureTitle = `Set secret "${fixtureKey}"`;
  const { rows: existing } = await pool.query(
    'SELECT id FROM issues WHERE app_id = $1 AND title = $2 LIMIT 1',
    [appId, fixtureTitle]
  );

  let issueId;
  if (existing.length) {
    issueId = existing[0].id;
  } else {
    const demoValue = 'https://demo.staging.invalid/hook-v2';
    const payload = {
      key: fixtureKey,
      action: 'set',
      valueEnc: encrypt(demoValue, config.dataEncryptionKey),
      valueLast4: demoValue.slice(-4),
      private: false,
      sensitive: false,
    };
    const { rows } = await pool.query(
      `INSERT INTO issues
         (app_id, github_issue_number, title, description, kind, payload, created_by, status, created_at)
       VALUES
         ($1, NULL, $2, $3, 'secret_change', $4, $5, 'open', NOW() - INTERVAL '30 minutes')
       RETURNING id`,
      [
        appId,
        fixtureTitle,
        `[staging fixture] ${creator.username} (via Homeroom) proposed setting the env var "${fixtureKey}". `
          + 'Auto-applies when a majority of active users vote up; the value reaches the platform on its next deploy.',
        JSON.stringify(payload),
        creator.id,
      ]
    );
    issueId = rows[0].id;
  }

  // A couple of votes so the tally pill renders a partial fill (one up
  // stripe, one down stripe when a second user exists). UNIQUE
  // (issue_id, user_id) + DO NOTHING keeps reboots and real re-votes
  // cast during testing intact.
  await pool.query(
    `INSERT INTO issue_votes (issue_id, user_id, vote, created_at)
     VALUES ($1, $2, 'up', NOW() - INTERVAL '25 minutes')
     ON CONFLICT (issue_id, user_id) DO NOTHING`,
    [issueId, creator.id]
  );
  if (secondVoter) {
    await pool.query(
      `INSERT INTO issue_votes (issue_id, user_id, vote, created_at)
       VALUES ($1, $2, 'down', NOW() - INTERVAL '20 minutes')
       ON CONFLICT (issue_id, user_id) DO NOTHING`,
      [issueId, secondVoter.id]
    );
  }

  log.info('db', 'Staging env-proposal fixture seeded', {
    issueId,
    creator: creator.username,
    voters: secondVoter ? 2 : 1,
  });
}

// Staging fixture for the Merged section's show-more toggle (#149). The
// self-app's prod DB usually has only a handful of merged sessions copied
// into staging, and a fresh staging clone of a young app may have fewer
// than the 4+ needed for the "Show N more" / "Show less" footer to render
// at all. Seed 8 synthetic merged PRs (varied titles, authors, timestamps)
// so the collapsed-to-3 default plus the toggle are exercisable on every
// preview. Idempotent on restart: each row is keyed off its unique
// `staging-fixture/merged-pr-N` branch name and checked before insert;
// pr_votes ride on UNIQUE(session_id, user_id) + DO NOTHING.
async function seedStagingMergedPrs(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging merged-PR fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: users } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 3`
  );
  if (!users.length) {
    log.warn('db', 'Staging merged-PR fixtures skipped: no users');
    return;
  }

  // Varied titles/ages so the list reads like real history. hoursAgo
  // staggers created_at (the /merged sort key) across ~a week, newest
  // first; authorIdx rotates rows across the available users (mod the
  // actual user count below). PR numbers sit in the same synthetic 9xxx
  // range as the notifications fixture so they can't shadow real PRs.
  const fixtures = [
    { title: 'Fix vote pill overflow on narrow screens', hoursAgo: 3 },
    { title: 'Add keyboard shortcuts for panel navigation', hoursAgo: 9 },
    { title: 'Debounce group-chat scroll handler', hoursAgo: 26 },
    { title: 'Improve dark-mode contrast on merged rows', hoursAgo: 50 },
    { title: 'Cache app icons in localStorage', hoursAgo: 74 },
    { title: 'Show relative timestamps in activity feed', hoursAgo: 98 },
    { title: 'Refactor kudos button into shared helper', hoursAgo: 122 },
    { title: 'Tidy empty states across dashboard tiles', hoursAgo: 150 },
  ];

  let inserted = 0;
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const branch = `staging-fixture/merged-pr-${i + 1}`;
    const author = users[i % users.length];

    let sessionId;
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch]
    );
    if (existing.length) {
      sessionId = existing[0].id;
    } else {
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status,
            votes_required, active_users_at_merge, created_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, 'merged', $7, $8,
            NOW() - ($9::int * INTERVAL '1 hour'))
         RETURNING id`,
        [appId, author.id, branch, 9100 + i, `[staging fixture] ${f.title}`,
         'In plain terms: this completed change improves the app for everyone who uses it, with no extra steps needed on your part.',
         Math.max(1, Math.ceil(users.length / 2)), users.length, f.hoursAgo]
      );
      sessionId = rows[0].id;
      inserted++;
    }

    // A yes-vote or two per PR so the tally pill renders a realistic
    // fill instead of 0/N on every fixture row.
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
       VALUES ($1, $2, 'yes', NOW() - ($3::int * INTERVAL '1 hour'))
       ON CONFLICT (session_id, user_id) DO NOTHING`,
      [sessionId, author.id, f.hoursAgo + 1]
    );
    const secondVoter = users[(i + 1) % users.length];
    if (secondVoter.id !== author.id) {
      await pool.query(
        `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
         VALUES ($1, $2, 'yes', NOW() - ($3::int * INTERVAL '1 hour'))
         ON CONFLICT (session_id, user_id) DO NOTHING`,
        [sessionId, secondVoter.id, f.hoursAgo + 1]
      );
    }
  }

  log.info('db', 'Staging merged-PR fixtures seeded', {
    appId,
    total: fixtures.length,
    inserted,
  });
}

// Locked report snapshots for the Reporting tab (reporting-period). The
// period dropdown's previous-report entries and its "Since last report"
// default are invisible without rows in app_report_snapshots, so seed
// two on the self-app: one ~30 days old and one ~3 days old. The merged
// fixtures above span ~6 days, so the 3-day snapshot visibly splits the
// Done section when a tester picks "Since last report". The recent row
// carries ai_json (exercising the previousReport input path) and a share
// token (keeping the Shared tag reviewable); marker class
// staging-fixture-report in the html is the idempotence check.
async function seedStagingReportSnapshots(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging report-snapshot fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: existing } = await pool.query(
    `SELECT 1 FROM app_report_snapshots
      WHERE app_id = $1 AND html LIKE '%staging-fixture-report%'
      LIMIT 1`,
    [appId]
  );
  if (existing.length) return;

  const { rows: users } = await pool.query(
    'SELECT id FROM users ORDER BY is_admin DESC, id ASC LIMIT 1'
  );
  const lockedBy = users[0]?.id || null;

  const doc = (label) => '<!doctype html>\n'
    + '<html lang="en"><head><meta charset="utf-8"><title>[staging fixture] '
    + label
    + '</title></head><body><div class="staging-fixture-report">'
    + '<h1>[staging fixture] ' + label + '</h1>'
    + '<p>A locked staging demo report. Real locked reports carry the full '
    + 'standalone progress document.</p>'
    + '</div></body></html>\n';

  const fixtures = [
    {
      label: 'Progress report — a month ago',
      daysAgo: 30,
      ai: {
        narrative: 'Staging demo narrative: a month ago the app was mid-build, with the first fixtures landing.',
        highlights: ['Staging demo highlight: the first fixture rows shipped.'],
        risks: [],
        owners: [],
        model: 'claude-haiku-4-5',
        generatedAt: null,
        periodStart: null,
      },
      token: null,
    },
    {
      label: 'Progress report — a few days ago',
      daysAgo: 3,
      ai: {
        narrative: 'Staging demo narrative: steady momentum this week — several fixture changes merged and more are queued for review.',
        highlights: [
          'Staging demo highlight: several fixture improvements merged.',
          'Staging demo highlight: review queue stayed short.',
        ],
        risks: [],
        owners: [],
        model: 'claude-haiku-4-5',
        generatedAt: null,
        periodStart: null,
      },
      // Fixed 32-hex token: obviously fake, satisfies the /reports/:token
      // format, and the idempotence check above prevents re-insert races
      // with the UNIQUE constraint.
      token: '00abcdef00abcdef00abcdef00abcdef',
    },
  ];

  for (const f of fixtures) {
    await pool.query(
      `INSERT INTO app_report_snapshots
         (app_id, html, ai_json, locked_by, locked_at, share_token, shared_at)
       VALUES
         ($1, $2, $3::jsonb, $4, NOW() - ($5::int * INTERVAL '1 day'), $6,
          CASE WHEN $6::varchar IS NULL THEN NULL
               ELSE NOW() - ($5::int * INTERVAL '1 day') END)`,
      [appId, doc(f.label), JSON.stringify(f.ai), lockedBy, f.daysAgo, f.token]
    );
  }

  log.info('db', 'Staging report-snapshot fixtures seeded', {
    appId,
    total: fixtures.length,
  });
}

// Fixtures for the home screen's "Your active sessions" section.
// chat_sessions is staging:private (schema-only in staging), so without
// these the section would be invisible to testers. The section is
// viewer-own-only, so every fixture row belongs to the user the tester
// logs in as — the first admin, same target-user selection as the
// notifications fixture above. Branches sit in the staging-fixture/
// namespace and titles carry the [staging fixture] prefix so the rows
// can't be mistaken for real work. Note the rows are 'active'-status and
// therefore count against the per-user slot cap (#193) on staging — the
// auto-pause sweeper reclaims them after its idle threshold, and a
// tester can pause them manually from the dev tab if they need a slot.
async function seedStagingActiveSessions(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging active-session fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging active-session fixtures skipped: no users');
    return;
  }
  const owner = userRows[0];

  // Staggered ages make the recency ordering visible; the last row has
  // no PR yet so the section's branch-name fallback renders too. PR
  // numbers sit in the synthetic 9xxx range shared with the other
  // fixtures so they can't shadow real PRs.
  const fixtures = [
    { title: 'Staging demo: refine onboarding copy', prNumber: 9201, minutesAgo: 10 },
    { title: 'Staging demo: polish empty states', prNumber: 9202, minutesAgo: 120 },
    { title: null, prNumber: null, minutesAgo: 1440 },
  ];

  let inserted = 0;
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const branch = `staging-fixture/active-session-${i + 1}`;
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch]
    );
    if (existing.length) continue;
    await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, status, created_at)
       VALUES
         ($1, $2, $3, $4, $5, 'active', NOW() - ($6::int * INTERVAL '1 minute'))`,
      [appId, owner.id, branch, f.prNumber,
       f.title ? `[staging fixture] ${f.title}` : null, f.minutesAgo]
    );
    inserted++;
  }

  log.info('db', 'Staging active-session fixtures seeded', {
    appId,
    owner: owner.username,
    total: fixtures.length,
    inserted,
  });
}

// #785: the dev session START screen — a freshly created session with no
// messages yet, where the starter suggestion pills (DevChat
// STARTER_QUICK_REPLIES, incl. the open-issues question) are the only
// content above the composer. chat_sessions is staging:private, so a
// preview has no session to open at all, and every OTHER session fixture
// seeds messages — which is exactly what REPLACES the starter pills. Hence
// a dedicated message-less row, owned by the tester (first admin, same
// selection as the fixtures above) so GET /api/sessions/:id resolves it.
//
// Its id is EXPLICIT so the screen has a stable URL for the dapp.json test
// and the before/after screenshots (/#app/<self-slug>/dev/sessions/990401).
// 99xxxx is the same fake-id range the ?demo=1 mock rows in
// routes/sessions.js use, three orders of magnitude above the live id
// sequence, so the SERIAL can't grow into it inside a staging clone.
// Idempotent on the id; strict no-op in production.
const STAGING_START_SCREEN_SESSION_ID = 990401;

async function seedStagingStartScreenSession(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging start-screen session fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const owner = await getStagingCheckViewer(pool, 'Staging start-screen session fixture');
  if (!owner) return;

  // pr_number stays NULL so the header renders its "New change" state,
  // like a real session before its first build. No chat_session_messages
  // rows at all — that emptiness IS the fixture.
  const { rowCount } = await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_title, session_title, status, created_at, last_activity_at)
     VALUES ($1, $2, $3, 'staging-fixture/start-screen', NULL,
             '[staging fixture] Brand-new session — start screen', 'active',
             NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes')
     ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [STAGING_START_SCREEN_SESSION_ID, appId, owner.id]
  );

  log.info('db', 'Staging start-screen session fixture seeded', {
    appId,
    owner: owner.username,
    sessionId: STAGING_START_SCREEN_SESSION_ID,
    inserted: rowCount,
  });
}

// #2779: an agent session for the declared checks to open.
//
// A conversation with the Mayor, owned by the check viewer, focused on the
// platform app, with one change started from it and one confirmation card
// still waiting: the four things the conversation screen draws that a
// staging clone has none of (agent_sessions, agent_session_actions and
// chat_sessions are all staging:private). Checks load it at #agent/990801,
// #agent/990801/changes and #messages/agent/990801.
//
// The change also carries what a coding agent leaves in the conversation:
// a scout run on Codex, the spec it drafted (two saved versions, so the spec
// viewer has one to switch to) and a build run with its summary. They are the
// rows the platform writes for a real run, content and metadata alike, so
// the screen folds them exactly as it folds a real one.
//
// The card can never run: its sealed input is a placeholder that fails the
// fingerprint check, so a Confirm pressed on staging reports that it could
// not go through. Its expiry is pushed forward on every boot so the card
// stays pending for as long as the preview lives. The transcript rows are
// written once. The viewer's agent-sessions flag is NOT turned on, so every
// classic flow the other checks load is unchanged.
//
// Idempotent on the ids; strict no-op in production.
const STAGING_AGENT_SESSION_ID = 990801;
const STAGING_AGENT_CHANGE_ID = 990802;
const STAGING_AGENT_CARD_ID = '99080100-0000-4000-8000-000000000001';
// In the two halves every scout spec is written in (routes/sessions.js), so
// the viewer shows its User-facing and Technical tabs.
const STAGING_AGENT_SPEC = [
  '# Dark mode for the dev board',
  '',
  'A toggle in the dev board header switches the board between light and dark.',
  '',
  '## User-facing changes',
  '- A sun and moon toggle sits beside the view switcher at the top of the dev board.',
  '- Tapping it switches the board between light and dark, and the board remembers your choice.',
  '',
  '## Technical implementation',
  '- Add the toggle beside the view switcher.',
  '- Keep the choice per viewer.',
  '- Reuse the platform theme tokens; no new colours.',
].join('\n');

// The rows a scout run and a build run write on the change, in order.
function stagingAgentRunRows() {
  const codex = { agentBackend: 'codex_openrouter', agentModel: 'z-ai/glm-5.3-flash' };
  return [
    ['system', 'Scouting the repo for context (z-ai/glm-5.3-flash)...', codex],
    ['system', 'Scout reading the codebase...', codex],
    ['system', 'Claude Code progress', { progressLog: ['Reading the dev board header', 'Reading the theme tokens', 'Drafting the spec'], ...codex }],
    ['system', `Scout drafted a ${STAGING_AGENT_SPEC.split('\n').length}-line spec from the codebase.`, {
      specPreview: STAGING_AGENT_SPEC.slice(0, 200), specLines: STAGING_AGENT_SPEC.split('\n').length,
      scoutOutput: STAGING_AGENT_SPEC, specVersion: 2, durationMs: 81000, ...codex,
    }],
    ['system', 'Starting OpenRouter (z-ai/glm-5.3-flash)...', codex],
    ['system', 'OpenRouter is running...', codex],
    ['system', 'Claude Code progress', { progressLog: ['Editing the dev board header', 'Adding the theme toggle', 'Running the tests'], ...codex }],
    ['system', 'OpenRouter finished', {
      ccOutput: 'Added a dark mode toggle to the dev board header:\n- it switches the board between light and dark\n- the choice is kept per viewer',
      ccOutcome: 'success', durationMs: 242000, ...codex,
    }],
  ];
}

async function seedStagingAgentRuns(pool) {
  await pool.query(
    `INSERT INTO chat_session_specs (session_id, version, content, built_at)
     VALUES ($1, 1, $2, NOW() - INTERVAL '4 minutes'), ($1, 2, $3, NOW() - INTERVAL '3 minutes')
     ON CONFLICT (session_id, version) DO UPDATE SET content = EXCLUDED.content`,
    [STAGING_AGENT_CHANGE_ID, '# Dark mode for the dev board\n\nFirst draft: a toggle in the header.', STAGING_AGENT_SPEC]
  );
  await pool.query('UPDATE chat_sessions SET spec_md = $2 WHERE id = $1', [STAGING_AGENT_CHANGE_ID, STAGING_AGENT_SPEC]);
  const { rows } = await pool.query(
    `SELECT 1 FROM chat_session_messages WHERE session_id = $1 AND metadata ? 'specVersion' LIMIT 1`,
    [STAGING_AGENT_CHANGE_ID]
  );
  if (rows.length) return;
  const runRows = stagingAgentRunRows();
  for (const [index, [role, content, metadata]] of runRows.entries()) {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW() - make_interval(secs => $6))`,
      [STAGING_AGENT_CHANGE_ID, STAGING_AGENT_SESSION_ID, role, content, JSON.stringify(metadata),
        230 - index * 5]
    );
  }
}

async function seedStagingAgentSession(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const { rows: appRows } = await pool.query('SELECT id, name FROM apps WHERE slug = $1', [config.selfAppSlug]);
  const app = appRows[0];
  if (!app) {
    log.warn('db', 'Staging agent-session fixture skipped: self-app row missing', { slug: config.selfAppSlug });
    return;
  }
  const owner = await getStagingCheckViewer(pool, 'Staging agent-session fixture');
  if (!owner) return;

  await pool.query(
    `INSERT INTO agent_sessions (id, user_id, title, title_source, status, focus_app_id, focus_context,
                                 last_activity_at, created_at)
     VALUES ($1, $2, '[staging fixture] Dark mode for the dev board', 'manual', 'open', $3,
             '{"entry":"improve"}'::jsonb, NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '5 minutes')
     ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, status = 'open', archived_at = NULL,
                                    focus_app_id = EXCLUDED.focus_app_id`,
    [STAGING_AGENT_SESSION_ID, owner.id, app.id]
  );
  await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, session_title, status, agent_session_id, created_at, last_activity_at)
     VALUES ($1, $2, $3, 'staging-fixture/agent-session', '[staging fixture] Dark mode toggle', 'active', $4,
             NOW() - INTERVAL '4 minutes', NOW() - INTERVAL '3 minutes')
     ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, agent_session_id = EXCLUDED.agent_session_id`,
    [STAGING_AGENT_CHANGE_ID, app.id, owner.id, STAGING_AGENT_SESSION_ID]
  );
  await pool.query('UPDATE agent_sessions SET active_change_id = $2 WHERE id = $1', [STAGING_AGENT_SESSION_ID, STAGING_AGENT_CHANGE_ID]);
  // #3180: its checks were skipped, with the reason a real skip records, so
  // the staging card and the changes drawer say "Checks skipped" and why.
  // Put back on every boot, as the card's expiry is.
  await pool.query(
    `UPDATE chat_sessions SET check_state = 'skipped', check_error_detail = $2, test_results = '[]'::jsonb
      WHERE id = $1`,
    [STAGING_AGENT_CHANGE_ID, 'branch has no commits beyond main, so there is nothing to test']
  );

  const card = {
    id: STAGING_AGENT_CARD_ID,
    toolName: 'promote_change',
    title: 'Put the change up for the group vote',
    input: { changeId: STAGING_AGENT_CHANGE_ID },
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  };
  await pool.query(
    `INSERT INTO agent_session_actions (id, agent_session_id, user_id, tool_name, sealed_input, input_hash,
                                        status, expires_at, created_at)
     VALUES ($1, $2, $3, 'promote_change', '{"version":1,"ciphertext":"staging-fixture"}'::jsonb, $4,
             'pending', NOW() + INTERVAL '30 days', NOW() - INTERVAL '1 minute')
     ON CONFLICT (id) DO UPDATE SET status = 'pending', result = NULL, decided_at = NULL,
                                    expires_at = EXCLUDED.expires_at, created_at = EXCLUDED.created_at`,
    [STAGING_AGENT_CARD_ID, STAGING_AGENT_SESSION_ID, owner.id, '0'.repeat(64)]
  );

  const { rows: existing } = await pool.query(
    'SELECT 1 FROM chat_session_messages WHERE agent_session_id = $1 LIMIT 1',
    [STAGING_AGENT_SESSION_ID]
  );
  if (!existing.length) {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata, created_at)
       VALUES (NULL, $1, 'user', 'Add a dark mode toggle to the dev board.', '{}'::jsonb, NOW() - INTERVAL '5 minutes'),
              (NULL, $1, 'system', $2, '{"agentSessionEvent":"change_started"}'::jsonb, NOW() - INTERVAL '4 minutes')`,
      [STAGING_AGENT_SESSION_ID, `Started a change on ${app.name || 'Homeroom'}: Dark mode toggle`]
    );
    await seedStagingAgentRuns(pool);
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata, created_at)
       VALUES ($2, $1, 'assistant', 'The change is built. When the preview looks right, confirm the card and I will put it up for the vote.',
               $3::jsonb, NOW() - INTERVAL '3 minutes')`,
      [STAGING_AGENT_SESSION_ID, STAGING_AGENT_CHANGE_ID, JSON.stringify({ confirmations: [card] })]
    );
  } else {
    // A preview seeded before the runs were: add them (after the rows it has).
    await seedStagingAgentRuns(pool);
    // Keep the card's shown expiry in step with the row's.
    await pool.query(
      `UPDATE chat_session_messages SET metadata = $2::jsonb
        WHERE agent_session_id = $1 AND role = 'assistant' AND metadata ? 'confirmations'`,
      [STAGING_AGENT_SESSION_ID, JSON.stringify({ confirmations: [card] })]
    );
  }
  await seedStagingAgentBuilds(pool);
  await seedStagingAgentComposer(pool, owner.id);
  log.info('db', 'Staging agent-session fixture seeded', {
    owner: owner.username, agentSessionId: STAGING_AGENT_SESSION_ID, changeId: STAGING_AGENT_CHANGE_ID,
  });
}

// #2779 follow-up ("Open app"): a SECOND agent-session fixture, this one
// focused on an ordinary app rather than the platform's own. The first
// fixture (990801) is focused on the self-app, where the new button hides —
// so a check that proves the button renders needs a conversation the button
// targets. The rows are tiny: one user message the title comes from, no
// change (the button opens the app itself, not a change on it). Same rules
// as its sibling: owned by the check viewer, idempotent on the id, and a
// strict no-op outside staging.
const STAGING_AGENT_OPEN_APP_SESSION_ID = 990803;
const STAGING_OPEN_APP_SLUG = 'staging-demo-app';

async function seedStagingAgentOpenAppSession(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const { rows: appRows } = await pool.query(
    'SELECT id, name FROM apps WHERE slug = $1',
    [STAGING_OPEN_APP_SLUG]
  );
  const app = appRows[0];
  if (!app) {
    log.warn('db', 'Staging agent-session open-app fixture skipped: demo app row missing',
      { slug: STAGING_OPEN_APP_SLUG });
    return;
  }
  const owner = await getStagingCheckViewer(pool, 'Staging agent-session open-app fixture');
  if (!owner) return;

  await pool.query(
    `INSERT INTO agent_sessions (id, user_id, title, title_source, status, focus_app_id, focus_context,
                                 last_activity_at, created_at)
     VALUES ($1, $2, $3, 'auto', 'open', $4, '{"entry":"improve"}'::jsonb,
             NOW() - INTERVAL '8 minutes', NOW() - INTERVAL '12 minutes')
     ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, status = 'open', archived_at = NULL,
                                    focus_app_id = EXCLUDED.focus_app_id`,
    [STAGING_AGENT_OPEN_APP_SESSION_ID, owner.id, '[staging fixture] Notes: welcome thread', app.id]
  );
  const { rows: existing } = await pool.query(
    'SELECT 1 FROM chat_session_messages WHERE agent_session_id = $1 LIMIT 1',
    [STAGING_AGENT_OPEN_APP_SESSION_ID]
  );
  if (!existing.length) {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata, created_at)
       VALUES (NULL, $1, 'user', 'Staging demo: open the app beside this chat.', '{}'::jsonb, NOW() - INTERVAL '12 minutes'),
              (NULL, $1, 'assistant', 'Staging demo reply: the "Open app" button in the bar opens the app this conversation is about, with the chat docked beside it.', '{}'::jsonb, NOW() - INTERVAL '11 minutes')`,
      [STAGING_AGENT_OPEN_APP_SESSION_ID]
    );
  }
  log.info('db', 'Staging agent-session open-app fixture seeded', {
    owner: owner.username, agentSessionId: STAGING_AGENT_OPEN_APP_SESSION_ID,
  });
}

// The change's staging builds, as cards (#2779 follow-up): one that failed,
// then one that deployed, written as a real build writes them, so the
// conversation shows a superseded card and a live one. The address is a
// fixture's (.invalid never resolves): Open preview asks the platform for
// this change's preview, which says it is not running. Added once, and to a
// preview seeded before this.
const STAGING_AGENT_PREVIEW_URL = 'https://staging-fixture-preview.invalid';

async function seedStagingAgentBuilds(pool) {
  const { rows } = await pool.query(
    `SELECT 1 FROM chat_session_messages
      WHERE session_id = $1 AND (metadata ? 'stagingUrl' OR metadata ? 'stagingFailed')
      LIMIT 1`,
    [STAGING_AGENT_CHANGE_ID]
  );
  if (rows.length) return;
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata, created_at)
     VALUES ($1, $2, 'system', 'Staging build failed', $3::jsonb, NOW() - INTERVAL '170 seconds'),
            ($1, $2, 'system', 'Staging deployed!', $4::jsonb, NOW() - INTERVAL '165 seconds')`,
    [
      STAGING_AGENT_CHANGE_ID,
      STAGING_AGENT_SESSION_ID,
      JSON.stringify({ stagingFailed: true, changesReady: true, error: 'npm ci exited with code 1 (staging fixture)', prNumber: null }),
      JSON.stringify({ stagingUrl: STAGING_AGENT_PREVIEW_URL, prNumber: null }),
    ]
  );
}

// What the composer and the Mayor's replies show (#2779 follow-up): one saved
// draft, so the list above the message box has a row (sending it would start
// a real turn, so a check only reads it), and what the Mayor's reply cost, so
// its "reply $0.012" label has a figure. Both idempotent.
const STAGING_AGENT_DRAFT_ID = 'dstagingfixture1';

async function seedStagingAgentComposer(pool, ownerId) {
  await pool.query(
    `INSERT INTO agent_session_drafts (agent_session_id, user_id, draft_id, content, saved_at)
     VALUES ($1, $2, $3, $4, NOW() - INTERVAL '2 minutes')
     ON CONFLICT (agent_session_id, draft_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [STAGING_AGENT_SESSION_ID, ownerId, STAGING_AGENT_DRAFT_ID, 'Also keep the choice when I switch devices.']
  );
  await pool.query(
    `UPDATE chat_session_messages SET cost_cents = 1.2
      WHERE agent_session_id = $1 AND role = 'assistant' AND COALESCE(cost_cents, 0) = 0`,
    [STAGING_AGENT_SESSION_ID]
  );
}

// #1350: a session with NO BRANCH at all.
//
// Until #1350 this state was unreachable — POST /api/apps/:slug/sessions
// minted the branch and called github.createBranch before it returned, so
// every row in chat_sessions had a branch_name from the moment it existed.
// The branch is minted on the session's FIRST TURN now, which means an
// untouched session legitimately has none, and several surfaces say
// something different because of it:
//
//   • the own-tools launchpad prints the "start new work" instructions
//     instead of the "continue this branch" ones (public/js/launchpad.js)
//   • the web hand-off wizard carries the same banner above it
//   • the local-CLI card drops "same branch" from its promise
//     (public/js/session-options.js)
//
// None of that is visible without a branchless row to point at, and a
// staging clone has none: chat_sessions is staging:private, so the table
// arrives empty and every other fixture here seeds a branch. Hence this
// one, which is 990401's twin in every respect EXCEPT branch_name — same
// owner, same emptiness, same 'active' status — so a reviewer comparing
// /dev/sessions/990401 with /dev/sessions/990411 sees the branch, and only
// the branch, as the difference.
//
// No chat_session_messages rows: a session with a message has had a turn,
// and a session that has had a turn has a branch. The emptiness is not
// decoration here, it is what makes the row honest.
//
// Idempotent on the id; strict no-op in production.
const STAGING_NO_BRANCH_SESSION_ID = 990411;

async function seedStagingNoBranchSession(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging no-branch session fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const owner = await getStagingCheckViewer(pool, 'Staging no-branch session fixture');
  if (!owner) return;

  const { rowCount } = await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_title, session_title, status, created_at, last_activity_at)
     VALUES ($1, $2, $3, NULL, NULL,
             '[staging fixture] No branch yet, nothing has run', 'active',
             NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '3 minutes')
     ON CONFLICT (id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       session_title = EXCLUDED.session_title,
       status = EXCLUDED.status,
       branch_name = NULL`,
    [STAGING_NO_BRANCH_SESSION_ID, appId, owner.id]
  );

  log.info('db', 'Staging no-branch session fixture seeded', {
    appId,
    owner: owner.username,
    sessionId: STAGING_NO_BRANCH_SESSION_ID,
    inserted: rowCount,
  });
}

// #940: saved dev-chat drafts now live in `chat_session_drafts`, which is
// staging:private — so a staging clone ships it EMPTY and the DB-backed
// path would be invisible to a reviewer. This fixture gives it a URL: a
// message-less session carrying two seeded drafts, so
// /#app/<self-slug>/dev/sessions/990402 renders the list straight from the
// database, with no `?shot` param involved.
//
// A DEDICATED session rather than drafts on 990401 on purpose: that row's
// emptiness IS its fixture (see above), and four dapp.json checks plus its
// before/after screenshots point at it.
//
// Id is explicit and in the same 99xxxx fake-id range as its neighbours
// (990001-990003, 990101-990105, 990401), three orders of magnitude above
// the live SERIAL so a staging clone can't grow into it. The draft copy
// matches DevChat._DEMO_SAVED_DRAFTS so the DB-backed list and the
// `?shot=drafts` demo paint read identically. Idempotent on both ids;
// strict no-op in production.
const STAGING_SAVED_DRAFTS_SESSION_ID = 990402;

const STAGING_SAVED_DRAFTS = [
  { id: 'stagingdraft1', text: 'Staging demo draft: also make the header sticky when scrolling.', minutesAgo: 6 },
  { id: 'stagingdraft2', text: 'Staging demo draft: rename the "Submit" button to "Publish".', minutesAgo: 5 },
];

async function seedStagingSavedDrafts(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging saved-drafts fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const owner = await getStagingCheckViewer(pool, 'Staging saved-drafts fixture');
  if (!owner) return;

  const { rowCount } = await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_title, session_title, status, created_at, last_activity_at)
     VALUES ($1, $2, $3, 'staging-fixture/saved-drafts', NULL,
             '[staging fixture] Session with saved drafts', 'active',
             NOW() - INTERVAL '8 minutes', NOW() - INTERVAL '4 minutes')
     ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [STAGING_SAVED_DRAFTS_SESSION_ID, appId, owner.id]
  );

  let drafts = 0;
  for (const d of STAGING_SAVED_DRAFTS) {
    const { rowCount: added } = await pool.query(
      `INSERT INTO chat_session_drafts (session_id, user_id, draft_id, content, saved_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'))
       ON CONFLICT (session_id, draft_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [STAGING_SAVED_DRAFTS_SESSION_ID, owner.id, d.id, d.text, d.minutesAgo]
    );
    drafts += added;
  }

  log.info('db', 'Staging saved-drafts fixture seeded', {
    appId,
    owner: owner.username,
    sessionId: STAGING_SAVED_DRAFTS_SESSION_ID,
    sessionInserted: rowCount,
    draftsInserted: drafts,
  });
}

// #1960: the fixture the DELETE check trashes from.
//
// A dedicated session, and the reason is the same one 990402 gives for not
// living on 990401: this check is DESTRUCTIVE. `?shot=draft-delete` really
// trashes `dropthisdraft` through the real handler, the real route and the
// real table, because a delete that only pretends to happen cannot catch a
// delete that comes back. Putting that on 990402 would empty the fixture
// whose two rows another check asserts by text, and check order is not
// something a proposal gets to choose.
//
// Idempotent on retry as well as on reboot: the shot deletes ONE KNOWN ID,
// so a second run finds it already gone and the surviving row is the same
// either way. The two texts are deliberately self-describing, because the
// only thing the check can see is which of them is on screen.
//
// 990414 continues the 9904xx dev-session block (990401-990413 are taken).
const STAGING_DRAFT_DELETE_SESSION_ID = 990414;

const STAGING_DRAFT_DELETE_DRAFTS = [
  { id: 'dropthisdraft', text: 'Staging demo draft: the one this check trashes.', minutesAgo: 6 },
  { id: 'keepthisdraft', text: 'Staging demo draft: the one that is still here afterwards.', minutesAgo: 5 },
];

async function seedStagingDraftDelete(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging draft-delete fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const owner = await getStagingCheckViewer(pool, 'Staging draft-delete fixture');
  if (!owner) return;

  const { rowCount } = await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_title, session_title, status, created_at, last_activity_at)
     VALUES ($1, $2, $3, 'staging-fixture/draft-delete', NULL,
             '[staging fixture] Trashing a saved draft', 'active',
             NOW() - INTERVAL '8 minutes', NOW() - INTERVAL '4 minutes')
     ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [STAGING_DRAFT_DELETE_SESSION_ID, appId, owner.id]
  );

  let drafts = 0;
  for (const d of STAGING_DRAFT_DELETE_DRAFTS) {
    const { rowCount: added } = await pool.query(
      `INSERT INTO chat_session_drafts (session_id, user_id, draft_id, content, saved_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'))
       ON CONFLICT (session_id, draft_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [STAGING_DRAFT_DELETE_SESSION_ID, owner.id, d.id, d.text, d.minutesAgo]
    );
    drafts += added;
  }

  log.info('db', 'Staging draft-delete fixture seeded', {
    appId,
    owner: owner.username,
    sessionId: STAGING_DRAFT_DELETE_SESSION_ID,
    sessionInserted: rowCount,
    draftsInserted: drafts,
  });
}

// #1049 / #1086: the venue line above the composer, and the walkthrough
// behind one of its answers.
//
// 990403 used to seed the PICKER — the card that asked "how do you want to
// build this change?" at the top of every untouched session. The picker is
// gone; the venue is stated on the composer instead, always, and changed
// from a sheet. So the fixture keeps its id and its shape and now shows
// the statement rather than the question. Its two siblings exist because
// the interesting part of that statement is the venues a reviewer cannot
// reach by hand on a staging clone.
//
//   990403 — /#app/<self-slug>/dev/sessions/990403
//            the line in its ordinary state: Homeroom · Claude, the
//            default nobody chose, now said out loud.
//   990409 — /#app/<self-slug>/dev/sessions/990409
//            Homeroom · OpenRouter — a pinned backend with a model, which
//            is also the one venue that renders the model row underneath.
//   990410 — /#app/<self-slug>/dev/sessions/990410
//            the same session AFTER a silent fallback: the saved default
//            was OpenRouter, the deployment could not honour it, and the
//            note under the line says so. Seeded through the session's
//            own columns, so it needs no failing credential.
//   990404 — /#app/<self-slug>/dev/sessions/990404?demo=1
//            the five-step walkthrough, resumed from a real open
//            external_agent_tasks row. `?demo=1` is what unlocks
//            GET /api/apps/:slug/dev-flow/status's staging fixture (the
//            #555 convention), so the steps render against a linked
//            account, a ready fork and a branch not yet pushed.
//
// All are message-less `active` sessions with no PR: that is the state the
// composer's line is read in, and the one state the walkthrough still
// renders in. They exist for the same reason the drafts fixture does —
// external_agent_tasks is staging:private and a staging clone has no
// GitHub OAuth app, so a reviewer opening a fresh session can review
// nothing.
//
// Ids stay in the 99xxxx fake range beside their neighbours (990401,
// 990402). Idempotent on the session ids and on the task's request_key;
// a strict no-op outside staging.
const STAGING_VENUE_LINE_SESSION_ID = 990403;
const STAGING_DEV_FLOW_WIZARD_SESSION_ID = 990404;
const STAGING_VENUE_OPENROUTER_SESSION_ID = 990409;
const STAGING_VENUE_FALLBACK_SESSION_ID = 990410;
const STAGING_DEV_FLOW_BRANCH = 'usernode/staging-fixture-1049';
const STAGING_DEV_FLOW_BASE_SHA = '0123456789abcdef0123456789abcdef01234567';

// Same self-app + proposal-check viewer resolution the sibling session
// fixtures use, so GET /api/sessions/<id> (owner-scoped) resolves for the
// identity that actually opens every declared check.
async function devFlowFixtureContext(pool, config, label) {
  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', `${label} skipped: self-app row missing`, { slug: config.selfAppSlug });
    return null;
  }
  const owner = await getStagingCheckViewer(pool, label);
  return owner ? { appId, owner } : null;
}

async function seedStagingVenueLine(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const ctx = await devFlowFixtureContext(pool, config, 'Staging venue-line fixture');
  if (!ctx) return;

  // The venue is read off the session's own columns (build-venues.js's
  // currentVenue precedence), so each row IS its fixture: leave the backend
  // defaulted for Homeroom · Claude, pin it for Homeroom · OpenRouter. The
  // third row is the OpenRouter DEFAULT that could not be honoured, which
  // is why it is seeded as a claude_code session — landing somewhere the
  // default did not name is the whole point of it. The note that explains
  // that is a creation-moment fact rather than a column, so it is reached
  // with ?shot=venue-fallback (see DevChat._shotVenueFallbackReason).
  const rows = [
    {
      id: STAGING_VENUE_LINE_SESSION_ID,
      branch: 'staging-fixture/venue-usernode-claude',
      title: '[staging fixture] Venue line — Homeroom · Claude',
      backend: 'claude_code',
      model: null,
    },
    {
      id: STAGING_VENUE_OPENROUTER_SESSION_ID,
      branch: 'staging-fixture/venue-usernode-openrouter',
      title: '[staging fixture] Venue line — Homeroom · OpenRouter',
      backend: 'codex_openrouter',
      model: 'openai/gpt-5.3-codex',
    },
    {
      id: STAGING_VENUE_FALLBACK_SESSION_ID,
      branch: 'staging-fixture/venue-fallback',
      title: '[staging fixture] Venue line — fell back to Claude',
      backend: 'claude_code',
      model: null,
    },
  ];

  let inserted = 0;
  for (const row of rows) {
    const { rowCount } = await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_title, session_title,
          agent_backend, agent_model, status, created_at, last_activity_at)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, 'active',
               NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '3 minutes')
       ON CONFLICT (id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         agent_backend = EXCLUDED.agent_backend,
         agent_model = EXCLUDED.agent_model`,
      [row.id, ctx.appId, ctx.owner.id, row.branch, row.title, row.backend, row.model]
    );
    inserted += rowCount;
  }

  // The venue sheet offers the two web hand-offs against a saved
  // preference, and the walkthrough fixture next door needs that null to
  // still mean "not yet answered". Clearing it keeps both readable: the
  // line above says Homeroom · Claude because nothing else was chosen,
  // which is the exact silence #1086 is about.
  await pool.query(
    'UPDATE users SET dev_flow_preference = NULL WHERE id = $1',
    [ctx.owner.id]
  );

  log.info('db', 'Staging venue-line fixture seeded', {
    appId: ctx.appId,
    owner: ctx.owner.username,
    sessionIds: rows.map((r) => r.id),
    inserted,
  });
}

async function seedStagingDevFlowWizard(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const ctx = await devFlowFixtureContext(pool, config, 'Staging dev-flow wizard fixture');
  if (!ctx) return;

  const { rowCount } = await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_title, session_title, status, created_at, last_activity_at)
     VALUES ($1, $2, $3, 'staging-fixture/dev-flow-wizard', NULL,
             '[staging fixture] Claude Code walkthrough', 'active',
             NOW() - INTERVAL '9 minutes', NOW() - INTERVAL '2 minutes')
     ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [STAGING_DEV_FLOW_WIZARD_SESSION_ID, ctx.appId, ctx.owner.id]
  );

  // One OPEN work order, matching demoStatus() in routes/dev-flow.js field
  // for field — the branch, the base commit and the fake fork login — so
  // the fixture row and the ?demo=1 status payload describe the same piece
  // of work rather than two different ones. client_id carries the picked
  // agent exactly as the browser flow records it.
  //
  // Keyed on request_key: that is the column prepare_work dedupes on, so a
  // re-run adopts this row instead of minting a second.
  let taskInserted = 0;
  const { rows: existingTask } = await pool.query(
    `SELECT id FROM external_agent_tasks
      WHERE app_id = $1 AND request_key = $2
      LIMIT 1`,
    [ctx.appId, 'brief:stagingfixture']
  );
  if (existingTask.length) {
    await pool.query(
      'UPDATE external_agent_tasks SET user_id = $1, session_id = $2 WHERE id = $3',
      [ctx.owner.id, STAGING_DEV_FLOW_WIZARD_SESSION_ID, existingTask[0].id]
    );
  } else {
    const { rowCount: added } = await pool.query(
      `INSERT INTO external_agent_tasks
         (user_id, app_id, issue_number, fork_owner, fork_repo, branch_name,
          base_sha, brief, client_id, status, request_key, session_id,
          created_at, expires_at)
       VALUES ($1, $2, NULL, 'octo-contributor', $3, $4, $5,
               'Add a dark-mode toggle to the settings screen.',
               'usernode-web:claude-code', 'open', 'brief:stagingfixture', $6,
               NOW() - INTERVAL '8 minutes', NOW() + INTERVAL '14 days')
       ON CONFLICT DO NOTHING`,
      [
        ctx.owner.id, ctx.appId, config.selfAppSlug, STAGING_DEV_FLOW_BRANCH,
        STAGING_DEV_FLOW_BASE_SHA, STAGING_DEV_FLOW_WIZARD_SESSION_ID,
      ]
    );
    taskInserted = added;
  }
  log.info('db', 'Staging dev-flow wizard fixture seeded', {
    appId: ctx.appId,
    owner: ctx.owner.username,
    sessionId: STAGING_DEV_FLOW_WIZARD_SESSION_ID,
    sessionInserted: rowCount,
    taskInserted,
  });
}

// #1055: a session to open the composer's "session and billing options"
// menu in. An `active` session with no PR, exactly like its 990403/990404
// neighbours — the menu hangs off the composer, which every open session
// has, so the only thing this fixture supplies is a session id a reviewer
// (and the dapp.json checks) can deep-link to without first creating one.
//
//   990405 — /#app/<self-slug>/dev/sessions/990405?demo=1&shot=session-options
//            the menu itself, open. `?demo=1` is what makes GET
//            /api/auth/me report a saved key (routes/auth.js, request-time
//            and staging-only), so the API-key row renders its "Change your
//            API key (…7f2c)" branch rather than the unset one — both
//            branches are reachable, the unset one by dropping `demo=1`.
//   990405 — …?demo=1&shot=session-options-instructions
//            the "run this session on your computer" card, with the
//            commands interpolated for THIS session id.
//
// Id stays in the 99xxxx fake range beside its neighbours. Idempotent on
// the session id; a strict no-op outside staging.
const STAGING_SESSION_OPTIONS_SESSION_ID = 990405;

// #1071: the other two hand-off states the same menu can be in. The web rows
// read "Continue this session" / "Continue this proposal" / "Start new work"
// depending only on the session's status, and a reviewer cannot check three
// states from one row — so there is one fixture per state, all three otherwise
// identical to 990405 so the difference on screen is the difference in copy.
//
//   990406 — promoted, with a PR number: "Continue this proposal with …"
//   990407 — paused:                     "Continue this session with …",
//                                        with the paused-specific tooltip
//   990408 — archived:                   "Start new work with …"
//
// Each gets its OWN branch name: branch_name is how several fixtures key
// themselves and two rows claiming one branch would be a lie about the repo.
const STAGING_SESSION_OPTIONS_PROMOTED_ID = 990406;
const STAGING_SESSION_OPTIONS_PAUSED_ID = 990407;
const STAGING_SESSION_OPTIONS_ARCHIVED_ID = 990408;

async function seedStagingSessionOptions(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const ctx = await devFlowFixtureContext(pool, config, 'Staging session-options fixture');
  if (!ctx) return;

  const { rowCount } = await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_title, session_title, status, created_at, last_activity_at)
     VALUES ($1, $2, $3, 'staging-fixture/session-options', NULL,
             '[staging fixture] Session and billing options', 'active',
             NOW() - INTERVAL '6 minutes', NOW() - INTERVAL '1 minute')
     ON CONFLICT (id) DO NOTHING`,
    [STAGING_SESSION_OPTIONS_SESSION_ID, ctx.appId, ctx.owner.id]
  );

  // A promoted row needs a pr_number to be a believable proposal, and the
  // 9xxx range is the fake-PR range the other staging fixtures already use.
  const { rowCount: promoted } = await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_number, pr_title, session_title, status,
        created_at, last_activity_at)
     VALUES ($1, $2, $3, 'staging-fixture/session-options-promoted', 9406,
             '[staging fixture] Options menu, up for a vote',
             '[staging fixture] Options menu, up for a vote', 'promoted',
             NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '3 minutes')
     ON CONFLICT (id) DO NOTHING`,
    [STAGING_SESSION_OPTIONS_PROMOTED_ID, ctx.appId, ctx.owner.id]
  );

  // #1602: give the promoted session the persisted row that owns the
  // Changes-ready card. The stable deep link now shows the post-proposal
  // action in its durable, disabled state instead of requiring a reviewer to
  // create and promote a real change. The content predicate keeps the seed
  // idempotent even though message ids are generated by the table.
  await pool.query(
    `INSERT INTO chat_session_messages
       (session_id, role, content, metadata, created_at)
     SELECT $1, 'system', $2, $3::jsonb, NOW() - INTERVAL '35 minutes'
      WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM chat_session_messages
           WHERE session_id = $1 AND content = $2
        )`,
    [
      STAGING_SESSION_OPTIONS_PROMOTED_ID,
      'Staging demo: this change has already been proposed to the group.',
      JSON.stringify({ changesReady: true, prNumber: 9406 }),
    ]
  );

  const { rowCount: paused } = await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_title, session_title, status, created_at, last_activity_at)
     VALUES ($1, $2, $3, 'staging-fixture/session-options-paused', NULL,
             '[staging fixture] Session and billing options, paused', 'paused',
             NOW() - INTERVAL '2 hours', NOW() - INTERVAL '30 minutes')
     ON CONFLICT (id) DO NOTHING`,
    [STAGING_SESSION_OPTIONS_PAUSED_ID, ctx.appId, ctx.owner.id]
  );

  const { rowCount: archived } = await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_title, session_title, status, created_at, last_activity_at)
     VALUES ($1, $2, $3, 'staging-fixture/session-options-archived', NULL,
             '[staging fixture] Session and billing options, archived', 'archived',
             NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days')
     ON CONFLICT (id) DO NOTHING`,
    [STAGING_SESSION_OPTIONS_ARCHIVED_ID, ctx.appId, ctx.owner.id]
  );

  log.info('db', 'Staging session-options fixture seeded', {
    appId: ctx.appId,
    owner: ctx.owner.username,
    sessionId: STAGING_SESSION_OPTIONS_SESSION_ID,
    inserted: rowCount,
    promotedInserted: promoted,
    pausedInserted: paused,
    archivedInserted: archived,
  });
}

// Fixture for the Dev board's shared-session cards: a session owned by a
// synthetic OTHER user with shared_at set, so it renders at the bottom of
// every tester's "In progress" area (chat_sessions is staging:private, so
// nothing real is ever copied over). It is a REAL row — unlike the ?demo=1
// mock rows in routes/sessions.js — so validateThread accepts posts on its
// discussion thread and the comment flow works end-to-end. A couple of
// seeded thread messages make the 💬 badge non-zero on first load.
// Idempotent: session keyed on its fixture branch name, thread messages on
// (app_id, content) — same pattern as the notification fixtures above.
async function seedStagingSharedSession(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging shared-session fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  // Synthetic owner — never a real user. Random discarded password so the
  // account can't log in (same posture as the capture users).
  let demoUserId;
  const { rows: demoRows } = await pool.query(
    'SELECT id FROM users WHERE username = $1',
    ['staging-demo-user']
  );
  if (demoRows.length) {
    demoUserId = demoRows[0].id;
  } else {
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, is_admin, can_create_apps)
       VALUES ('staging-demo-user', $1, FALSE, FALSE)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [hash]
    );
    demoUserId = rows[0]?.id;
    if (!demoUserId) {
      const { rows: again } = await pool.query(
        'SELECT id FROM users WHERE username = $1', ['staging-demo-user']
      );
      demoUserId = again[0]?.id;
    }
  }
  if (!demoUserId) {
    log.warn('db', 'Staging shared-session fixture skipped: demo user missing');
    return;
  }

  const fixtureBranch = 'staging-fixture/shared-session';
  let sessionId;
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (existing.length) {
    sessionId = existing[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, session_title, status, shared_at,
          transcript_shared_at, created_at)
       VALUES
         ($1, $2, $3, 9301, 'Staging demo shared session', 'paused',
          NOW() - INTERVAL '45 minutes', NOW() - INTERVAL '40 minutes',
          NOW() - INTERVAL '2 hours')
       RETURNING id`,
      [appId, demoUserId, fixtureBranch]
    );
    sessionId = rows[0].id;
  }

  // The transcript itself. Without these rows the "Read the dev chat"
  // section on the fixture's topic page would expand to an empty box —
  // chat_session_messages for a session created by THIS seed obviously
  // doesn't come across in the prod DB clone.
  //
  // The set deliberately includes rows the sanitiser must STRIP (a ccLog
  // row, a platformIssueDraft card, per-message cost_cents) so a tester can
  // confirm on staging that they don't render, and one attachment row so
  // the name-only chip path is reviewable. Idempotent per row on
  // (session_id, content).
  const transcriptRows = [
    {
      role: 'user', mins: 118, model: null,
      content: '[staging fixture] The session cards get cramped on my phone — the title ends up squeezed against the buttons. Can we fix that?',
      metadata: { attachments: [{ id: 'b'.repeat(32), filename: 'cramped-card.png', kind: 'image', sizeBytes: 48210 }] },
    },
    {
      role: 'assistant', mins: 117, model: 'claude-opus-5', cost: 3.1,
      content: "[staging fixture] Agreed — the action buttons are fixed-width, so they crush the title at narrow widths. I'll split the card into a title row and an actions row that wraps.",
      metadata: {},
    },
    {
      role: 'system', mins: 116, model: null,
      content: 'Claude Code is running',
      metadata: { progressLog: [
        'Reading public/js/app-view.js',
        'Editing _renderMySessionCard',
        'Adding tests/session-card-layout.test.js cases',
        'Running node --test tests/session-card-layout.test.js',
      ] },
    },
    {
      role: 'system', mins: 112, model: null,
      content: 'Claude Code log',
      // MUST NOT render in the read-only view (raw agent stderr).
      metadata: { ccLog: '[staging fixture] raw stderr — a reader must never see this line' },
    },
    {
      role: 'system', mins: 111, model: null,
      content: 'Spec drafted',
      metadata: {
        specPreview: '# [staging fixture] Readable session cards on narrow screens\n\n- Two-row card layout\n- Actions wrap instead of crushing the title\n',
        specVersion: 1, specLines: 4,
      },
    },
    {
      role: 'system', mins: 105, model: null,
      content: 'Changes ready',
      metadata: {
        changesReady: true, prNumber: 9301, ccOutcome: 'success', durationMs: 246000,
        ccOutput: '[staging fixture] Split the session card into a title row and a wrapping actions row; added layout tests.',
      },
    },
    {
      role: 'system', mins: 104, model: null,
      content: 'The AI suggests reporting this to the platform',
      // MUST NOT render in the read-only view (owner-only action card).
      metadata: { platformIssueDraft: { body: '[staging fixture] draft report a reader must never see', status: 'pending' } },
    },
    {
      role: 'user', mins: 100, model: null,
      content: '[staging fixture] Looks good. Do the buttons keep their order when they wrap?',
      metadata: { suggestions: ['[staging fixture] leaked suggestion chip'] },
    },
    {
      role: 'assistant', mins: 99, model: 'claude-opus-5', cost: 1.8,
      content: '[staging fixture] Yes — they wrap in source order, so Preview stays first and Archive stays last.',
      metadata: {},
    },
  ];
  let transcriptInserted = 0;
  for (const row of transcriptRows) {
    const { rows: existingMsg } = await pool.query(
      'SELECT id FROM chat_session_messages WHERE session_id = $1 AND content = $2 LIMIT 1',
      [sessionId, row.content]
    );
    if (existingMsg.length) continue;
    await pool.query(
      `INSERT INTO chat_session_messages
         (session_id, role, content, model, cost_cents, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW() - (($7::int) * INTERVAL '1 minute'))`,
      [sessionId, row.role, row.content, row.model, row.cost || 0,
       JSON.stringify(row.metadata || {}), row.mins]
    );
    transcriptInserted++;
  }

  // Ensure the flag survives a tester having unshared it in an earlier
  // preview boot only when the row was JUST created — an existing row's
  // shared_at is left alone so testing the Hide flow sticks per build.
  let threadInserted = 0;
  for (const [i, content] of [
    '[staging fixture] Shared-session comment: nice direction — does this cover the mobile layout too?',
    '[staging fixture] Shared-session comment: yes, testing that next.',
  ].entries()) {
    const { rows: msgExisting } = await pool.query(
      'SELECT id FROM chat_messages WHERE app_id = $1 AND content = $2 LIMIT 1',
      [appId, content]
    );
    if (msgExisting.length) continue;
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
       VALUES ($1, $2, $3, 'message', 'session', $4, NOW() - (($5::int) * INTERVAL '1 minute'))`,
      [appId, demoUserId, content, sessionId, 40 - i * 5]
    );
    threadInserted++;
  }

  log.info('db', 'Staging shared-session fixture seeded', {
    appId, sessionId, threadInserted, transcriptInserted,
  });
}

// Fork fixture: the RESULT of "Fork this chat" on the shared-session
// fixture above, owned by the staging admin so a tester can open it in
// their own dev chat. Reviewable without running a real fork (which needs a
// free session slot, a live branch and a GitHub round trip).
//
// What it exercises: the greyed inherited-history styling and the
// collapsed-by-default agent disclosures (both keyed off
// metadata.inheritedFrom by DevChat._markInheritedMessages /
// _ccDefaultOpen), plus the fork follow-up copy — including its
// load-bearing "I don't have the agent's memory of that work" caveat.
//
// Copies are SANITISED here exactly as the fork route does, so the fixture
// can't demonstrate a leak the real path wouldn't produce. Idempotent on
// the fixture branch name.
async function seedStagingForkedChat(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging forked-chat fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  // The source is the shared-session fixture seeded above.
  const { rows: srcRows } = await pool.query(
    `SELECT cs.id, cs.session_title, cs.spec_md, u.username AS owner_username
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND cs.branch_name = $2 LIMIT 1`,
    [appId, 'staging-fixture/shared-session']
  );
  if (!srcRows.length) {
    log.warn('db', 'Staging forked-chat fixture skipped: shared-session fixture missing');
    return;
  }
  const src = srcRows[0];

  // Owned by the staging admin (first admin, else lowest id) so the tester
  // can actually open it — a fork belongs to the person who made it.
  const { rows: userRows } = await pool.query(
    `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging forked-chat fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const fixtureBranch = 'staging-fixture/forked-chat';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (existing.length) return;

  const { rows: forkRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, session_title, status, spec_md,
        cloned_from_session_id, created_at)
     VALUES ($1, $2, $3, $4, 'paused', $5, $6, NOW() - INTERVAL '20 minutes')
     RETURNING id`,
    // Title matches what POST /fork actually produces (the source's own
    // title, verbatim) — a fixture that invented a nicer name would
    // misrepresent the real output.
    [appId, owner.id, fixtureBranch,
     src.session_title || 'Forked dev chat', src.spec_md || '', src.id]
  );
  const forkId = forkRows[0].id;

  const { rows: srcMessages } = await pool.query(
    `SELECT id, role, content, model, metadata FROM chat_session_messages
      WHERE session_id = $1 ORDER BY id ASC`,
    [src.id]
  );
  const transcriptShare = require('../services/transcript-share');
  let copied = 0;
  for (const raw of srcMessages) {
    const clean = transcriptShare.sanitizeTranscriptMessage(raw);
    if (!clean) continue;
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, model, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW() - INTERVAL '20 minutes')`,
      [forkId, clean.role, clean.content, clean.model || null,
       JSON.stringify({ ...(clean.metadata || {}), inheritedFrom: src.id })]
    );
    copied++;
  }

  // The follow-up, built by the SAME function the fork route uses, so the
  // fixture can never show copy the real path doesn't produce. Deliberately
  // carries NO inheritedFrom — it belongs to the fork, and it's the boundary
  // the inherited/own history styling renders against.
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'assistant', $2, '{}'::jsonb, NOW() - INTERVAL '19 minutes')`,
    [forkId, transcriptShare.buildForkFollowUpMessage(src)]
  );

  log.info('db', 'Staging forked-chat fixture seeded', {
    appId, forkId, src: src.id, copied, owner: owner.username,
  });
}

// #50: progress-indicator fixture. The live elapsed ticker only renders
// during a real Claude Code run, but everything persisted — the merged
// "Claude Code is running…" + progress-log rendering, the step counter,
// the activity snippet derived from the log, and the reload-safe
// "(took 4m 12s)" suffix from durationMs metadata — is reviewable from a
// seeded session. Seed one dev-chat session for the staging admin whose
// timeline replays a finished CC run. Idempotent on restart: keyed off
// the fixture branch name; if the session exists, nothing is re-inserted.
async function seedStagingCcProgressRun(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging CC-progress fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging CC-progress fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const fixtureBranch = 'staging-fixture/cc-progress-run';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (existing.length) return;

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, status, created_at)
     VALUES
       ($1, $2, $3, '[staging fixture] Progress indicator demo run', 'active',
        NOW() - INTERVAL '40 minutes')
     RETURNING id`,
    [appId, owner.id, fixtureBranch]
  );
  const sessionId = sessionRows[0].id;

  // Representative progress log mirroring the vocabulary worker.js emits
  // (phase markers, tool_use labels, ⎿ results, a thinking line) so the
  // summary helpers have realistic input: 12 action lines → "12 steps".
  const progressLog = [
    '[refresh]',
    '[claude (mode build)]',
    '… Planning the change before touching any files',
    'Reading public/js/dev-chat.js',
    '  ⎿ Read: 3152 lines',
    'Reading public/css/app.css',
    '  ⎿ Read: 1287 lines',
    '$ grep -n "cc_progress" public/js/dev-chat.js',
    '  ⎿ 6 lines',
    'Reading src/routes/sessions.js',
    '  ⎿ Read: 4522 lines',
    '… The status line needs an elapsed span plus a live activity snippet',
    'Editing public/js/dev-chat.js',
    '  ⎿ Edit: ok',
    'Editing public/js/dev-chat.js',
    '  ⎿ Edit: ok',
    'Writing public/js/cc-progress-summary.js',
    '  ⎿ Write: ok',
    'Editing public/css/app.css',
    '  ⎿ Edit: ok',
    'Editing public/index.html',
    '  ⎿ Edit: ok',
    '$ node --test tests/cc-progress-summary.test.js',
    '  ⎿ 14 lines',
    'Reading public/js/dev-chat.js',
    '  ⎿ Read: 240 lines',
    '$ git add -A && git commit -m "Add progress indicator for Claude Code runs"',
    '  ⎿ 3 lines',
    '[commit]',
    '[push]',
    // Terminal marker (run-cc.sh emits it after the push) so the seeded
    // finished run's collapsed card shows "Finished", not a frozen
    // "Pushing" — reviewable in staging without triggering a real turn.
    '[done]',
  ];

  const ccOutput = [
    '[staging fixture] Added a progress indicator for Claude Code runs:',
    '',
    '- Live elapsed timer on every in-progress status line.',
    '- Activity snippet + step counter in the running summary.',
    '- Persisted run durations on finished statuses.',
  ].join('\n');

  // #358: a no-op outcome demo so QA can see the non-success card, which is
  // visually distinct from the green "Claude Code finished" card and never
  // shows the [CODING AGENT COMPLETED] marker. The ccOutcome:'no_changes'
  // discriminator is what makes the harness fold this into the Mayor's
  // context under a non-completed label rather than a fake completion.
  const ccNoOpOutput = [
    '[staging fixture] I reviewed the relevant files but the requested',
    'behaviour was already in place — nothing needed changing, so no commit',
    'was made.',
  ].join('\n');

  // Timeline order matters: the dev-chat pairing pre-pass attaches the
  // 'Claude Code progress' row to the nearest PRECEDING "Claude Code is
  // running" status, so insert status → progress → finished with
  // ascending timestamps.
  const messages = [
    { role: 'user', content: '[staging fixture] Please add a progress indicator for Claude Code runs.', metadata: {}, minutesAgo: 39 },
    { role: 'system', content: 'Spinning up coding agent (Claude Sonnet 5)...', metadata: {}, minutesAgo: 38 },
    { role: 'system', content: 'Claude Code is running...', metadata: {}, minutesAgo: 38 },
    { role: 'system', content: 'Claude Code progress', metadata: { progressLog }, minutesAgo: 38 },
    { role: 'system', content: 'Claude Code finished', metadata: { ccOutput, ccOutcome: 'success', durationMs: 252000 }, minutesAgo: 34 },
    { role: 'user', content: '[staging fixture] Make sure the elapsed timer never disappears.', metadata: {}, minutesAgo: 33 },
    { role: 'system', content: 'Spinning up coding agent (Claude Sonnet 5)...', metadata: {}, minutesAgo: 32 },
    { role: 'system', content: 'Claude Code is running...', metadata: {}, minutesAgo: 32 },
    { role: 'system', content: 'Claude Code made no changes', metadata: { ccOutput: ccNoOpOutput, ccOutcome: 'no_changes', durationMs: 41000 }, minutesAgo: 31 },
  ];

  for (const m of messages) {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'))`,
      [sessionId, m.role, m.content, JSON.stringify(m.metadata), m.minutesAgo]
    );
  }

  log.info('db', 'Staging CC-progress fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}

// The dev chat's own vocabulary, staged as ONE conversation.
//
// The individual fixtures above each isolate a single element — a progress
// run, an estimate, a cohort hint, an issue draft. That is right for
// regression review and wrong for judging how the screen READS: a transcript
// is a sequence, and the question "does a failure stand out from the ticks
// above it" cannot be answered by a session that contains only a failure.
//
// So this one is deliberately a whole conversation, in order: a request, the
// thinking ladder, a reply, a coding run that finished, the Changes-ready card
// with its before/after strip, a second turn the user STOPS after it has
// already committed, and a third that FAILS. The last two are the pair worth
// seeing together — a stop the user chose reads as neutral facts, a failure
// reads as red — and neither can be judged from a fixture holding only one.
//
// The questionnaire is not here: it renders only on the LAST non-system row
// of a session, so it cannot follow anything. It has its own fixture below.
//
// Its id is explicit so the route is stable for dapp.json and for the
// before/after screenshots. 990412 continues the 9904xx dev-session block
// (990401-990411 are taken).
const STAGING_TRANSCRIPT_SESSION_ID = 990412;

async function seedStagingTranscriptShowcase(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging transcript fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const owner = await getStagingCheckViewer(pool, 'Staging transcript fixture');
  if (!owner) return;

  const stagingUrl = 'https://usernode-2d5619--s990412.example.invalid';
  const { rowCount } = await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_number, pr_title, pr_url, session_title,
        status, staging_url, created_at, last_activity_at)
     VALUES ($1, $2, $3, 'staging-fixture/transcript-showcase', 4242,
             '[staging fixture] Say how long a proposal has been waiting',
             'https://github.com/example/example/pull/4242',
             '[staging fixture] Say how long a proposal has been waiting',
             'active', $4,
             NOW() - INTERVAL '26 minutes', NOW() - INTERVAL '3 minutes')
     ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [STAGING_TRANSCRIPT_SESSION_ID, appId, owner.id, stagingUrl]
  );

  const { rows: already } = await pool.query(
    'SELECT 1 FROM chat_session_messages WHERE session_id = $1 LIMIT 1',
    [STAGING_TRANSCRIPT_SESSION_ID]
  );

  if (!already.length) {
    // Same vocabulary worker.js emits, so the summary helpers get realistic
    // input rather than prose that happens to look like a log.
    const progressLog = [
      '[refresh]',
      '[claude (mode build)]',
      '… Finding where a proposal card decides what to show under its title',
      'Reading frontend/src/features/dev-board/card/dev-card.tsx',
      '  ⎿ Read: 412 lines',
      '$ grep -rn "votesRequired" src/services',
      '  ⎿ 7 lines',
      'Reading src/services/merge-status.js',
      '  ⎿ Read: 268 lines',
      '… The wait is measured from the promotion, not from the session',
      'Editing src/services/merge-status.js',
      '  ⎿ Edit: ok',
      'Editing frontend/src/features/dev-board/card/dev-card.tsx',
      '  ⎿ Edit: ok',
      '$ node --test tests/merge-status.test.js',
      '  ⎿ 11 lines',
      '[commit]',
      '[push]',
      '[done]',
    ];

    const ccOutput = [
      '**Changed**',
      '',
      '- `src/services/merge-status.js` — `waitingSince(pr)`, measured from the',
      '  promotion rather than from when the session was created.',
      '- `dev-card.tsx` — one line under the title on a proposal that is in vote',
      '  and has no votes yet.',
      '',
      '**Not changed**',
      '',
      '- Merged and closed cards. The wait has an answer there and it is not news.',
    ].join('\n');

    // The failure is the point of the second turn: `turnError` is what the
    // transcript reads to draw it as a failure rather than as another ✓ row.
    // The text is a real producer's — routes/sessions.js's catch-all — so the
    // fixture cannot drift into copy the product does not write.
    const messages = [
      { role: 'user', content: '[staging fixture] Can a proposal card say how long it has been waiting for its first vote?', metadata: {}, minutesAgo: 26 },
      { role: 'system', content: 'Thinking about your request...', metadata: {}, minutesAgo: 26 },
      { role: 'system', content: 'Reading the repo\u2019s GitHub issues', metadata: {}, minutesAgo: 25 },
      { role: 'assistant', content: 'Yes — and it is a smaller change than it sounds. `merge-status.js` already derives the lifecycle for every card, so the wait is one more field on the same object rather than a new query. I will measure it from the promotion, not from when the session was created: a change can sit in a session for days before anyone is asked to vote on it.', model: 'claude-opus-5', metadata: { costCents: 3 }, minutesAgo: 25 },
      { role: 'system', content: 'Spinning up coding agent (Claude Opus 5)...', metadata: {}, minutesAgo: 24 },
      { role: 'system', content: 'Claude Code is running...', metadata: {}, minutesAgo: 24 },
      { role: 'system', content: 'Claude Code progress', metadata: { progressLog }, minutesAgo: 24 },
      { role: 'system', content: 'Claude Code finished', metadata: { ccOutput, ccOutcome: 'success', durationMs: 268000 }, minutesAgo: 20 },
      { role: 'system', content: 'Changes ready', metadata: { changesReady: true, stagingUrl, prNumber: 4242, prUrl: 'https://github.com/example/example/pull/4242' }, minutesAgo: 19 },
      { role: 'user', content: '[staging fixture] Round it to the nearest hour past a day.', metadata: {}, minutesAgo: 12 },
      { role: 'system', content: 'Spinning up coding agent (Claude Opus 5)...', metadata: {}, minutesAgo: 12 },
      // A STOP THAT LANDED. `content` is the sentence the server writes;
      // `stopLanding` is the same landing as data, which is what draws the
      // chips. Both, because the sentence is still what a notification and a
      // plain-text export show — see stopLandingMeta in routes/sessions.js.
      {
        role: 'system',
        content: `Claude Code stopped by @${owner.username}, but it had already committed 2 changes to the branch (7c41ab90, pushed); no pull request was opened.`,
        metadata: {
          durationMs: 74000,
          stopLanding: {
            headline: `Claude Code stopped by @${owner.username}`,
            commits: 2, sha: '7c41ab90', pushOk: true,
          },
        },
        minutesAgo: 11,
      },
      { role: 'user', content: '[staging fixture] Fine, go ahead and finish it.', metadata: {}, minutesAgo: 4 },
      { role: 'system', content: 'This turn failed: the coding agent exited before writing a result. Send your message again to retry.', metadata: { turnError: true }, minutesAgo: 3 },
    ];

    for (const m of messages) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, model, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW() - ($6::int * INTERVAL '1 minute'))`,
        [STAGING_TRANSCRIPT_SESSION_ID, m.role, m.content, m.model || null,
         JSON.stringify(m.metadata), m.minutesAgo]
      );
    }
  }

  // …and the captures the Changes-ready card carries. FOUR groups, chosen so
  // the strip has to answer every question it can be asked: an ordinary pair,
  // a phone-viewport pair, a route with no production version (after-only),
  // and one whose "before" fell back to the home page. Only the first is
  // visible without opening "All 4 screens", which is the arrangement under
  // review.
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const vis = [
    { id: '9'.repeat(31) + '0', kind: 'before', idx: 0, path: '/' },
    { id: '9'.repeat(31) + '1', kind: 'after', idx: 0, path: '/' },
    { id: '9'.repeat(31) + '2', kind: 'before', idx: 1, path: '/', viewport: 'mobile' },
    { id: '9'.repeat(31) + '3', kind: 'after', idx: 1, path: '/', viewport: 'mobile' },
    { id: '9'.repeat(31) + '4', kind: 'after', idx: 2, path: '/waiting' },
    { id: '9'.repeat(31) + '5', kind: 'before', idx: 3, path: '/settings', fellBack: true },
    { id: '9'.repeat(31) + '6', kind: 'after', idx: 3, path: '/settings' },
  ];
  for (const r of vis) {
    await pool.query(
      `INSERT INTO session_visuals
         (id, session_id, commit_hash, kind, media, content_type, data,
          captured_path, capture_index, captured_viewport, before_fell_back)
       SELECT $1, $2, NULL, $3, 'png', 'image/png', $4, $5, $6, $7, $8
        WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $2)
       ON CONFLICT (id) DO NOTHING`,
      [r.id, STAGING_TRANSCRIPT_SESSION_ID, r.kind, PNG_1X1, r.path, r.idx,
       r.viewport || null, !!r.fellBack]
    );
  }

  log.info('db', 'Staging transcript fixture seeded', {
    appId, owner: owner.username,
    sessionId: STAGING_TRANSCRIPT_SESSION_ID,
    inserted: rowCount,
  });
}

// The questionnaire, staged on its own route.
//
// It cannot live in the showcase above: the chips render only on the LAST
// non-system row of an interactive session, so anything after them hides
// them. Hence a second session whose whole point is to END on the question.
//
// TWO groups on purpose, because the interesting behaviour is the difference
// between them. The first is ordinary chips and carries the escape hatch —
// the last chip in the row, which opens a one-line input scoped to that
// question instead of sending the reader to the composer to do a form's job.
// The second is answers that are all bare numbers sharing one unit, which is
// not a set of choices at all; it draws as a stepper with the first answer as
// its suggestion. Past one question neither sends on tap: they select, and a
// shared Send answers row commits both at once.
//
// 990413 continues the 9904xx dev-session block.
const STAGING_QUESTIONNAIRE_SESSION_ID = 990413;

async function seedStagingQuestionnaire(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging questionnaire fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const owner = await getStagingCheckViewer(pool, 'Staging questionnaire fixture');
  if (!owner) return;

  const { rowCount } = await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, session_title, pr_title,
        status, created_at, last_activity_at)
     VALUES ($1, $2, $3, 'staging-fixture/questionnaire',
             '[staging fixture] Flag a proposal that has gone quiet',
             '[staging fixture] Flag a proposal that has gone quiet',
             'active', NOW() - INTERVAL '9 minutes', NOW() - INTERVAL '8 minutes')
     ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [STAGING_QUESTIONNAIRE_SESSION_ID, appId, owner.id]
  );

  const { rows: already } = await pool.query(
    'SELECT 1 FROM chat_session_messages WHERE session_id = $1 LIMIT 1',
    [STAGING_QUESTIONNAIRE_SESSION_ID]
  );
  if (already.length) return;

  // The prose and the chips say the same thing, which is the product's own
  // arrangement: the sentence is what a shared transcript and a plain-text
  // export show, and the chips are how you answer without typing.
  const assistantContent = 'Two things I need before I dispatch anything:\n\n'
    + '1. Where should the flag show? (suggested: on the proposal card)\n'
    + '2. How long is "gone quiet"? (suggested: 3 days)';
  const suggestions = [
    {
      question: 'Where should the flag show?',
      answers: ['On the proposal card', 'In the session header', 'Both'],
    },
    {
      question: 'How long is "gone quiet"?',
      answers: ['3 days', '5 days', '7 days'],
    },
  ];

  const messages = [
    {
      role: 'user',
      content: '[staging fixture] Flag a proposal that has gone quiet.',
      metadata: {}, minutesAgo: 9,
    },
    {
      role: 'assistant', model: 'claude-opus-5',
      content: assistantContent,
      metadata: { suggestions, costCents: 2 }, minutesAgo: 8,
    },
  ];
  for (const m of messages) {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, model, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - ($6::int * INTERVAL '1 minute'))`,
      [STAGING_QUESTIONNAIRE_SESSION_ID, m.role, m.content, m.model || null,
       JSON.stringify(m.metadata), m.minutesAgo]
    );
  }

  log.info('db', 'Staging questionnaire fixture seeded', {
    appId, owner: owner.username,
    sessionId: STAGING_QUESTIONNAIRE_SESSION_ID,
    inserted: rowCount,
  });
}

// #286: AI-progress-estimate fixture. The '✦ AI guess' span only renders
// on an *active* "Claude Code is running…" line that carries an estimate,
// and real estimates are emitted live over SSE (never persisted), so the
// finished-run fixture above can never show one. Seed one dev-chat session
// whose newest system row is an active running line carrying persisted
// estimate metadata ({ text, remainingSeconds }), paired with a progress
// row so the merged disclosure summary (and its estimate span) renders.
// dev-chat.js hydrates msg._estimate / _estimateRemaining from
// metadata.estimate on load (mirroring the live cc_estimate path), so the
// guess shows on reload without a worker running — which is exactly what
// makes the mobile-visibility fix reviewable on a narrow viewport.
// chat_sessions is staging:private, so this is invisible without seeding.
// Idempotent on the fixture branch name; strict no-op in production.
async function seedStagingCcEstimateRun(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging CC-estimate fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging CC-estimate fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const fixtureBranch = 'staging-fixture/cc-progress-estimate';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (existing.length) return;

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, status, created_at)
     VALUES
       ($1, $2, $3, '[staging fixture] AI progress estimate demo run', 'active',
        NOW() - INTERVAL '3 minutes')
     RETURNING id`,
    [appId, owner.id, fixtureBranch]
  );
  const sessionId = sessionRows[0].id;

  // A short in-flight progress log so the running line renders as the
  // disclosure summary (the estimate span lives on that summary).
  const progressLog = [
    '[refresh]',
    '[claude (mode build)]',
    '… Planning the change before touching any files',
    'Reading public/js/dev-chat.js',
    '  ⎿ Read: 3160 lines',
    'Reading public/css/app.css',
    '  ⎿ Read: 1290 lines',
    'Editing public/css/app.css',
    '  ⎿ Edit: ok',
  ];

  // Timeline order matters: the dev-chat pairing pre-pass attaches the
  // 'Claude Code progress' row to the nearest PRECEDING active running
  // status, so insert status → progress with ascending timestamps and
  // NO terminal row (so the running line stays `_active`). The estimate
  // metadata rides on the running line — that's the row that becomes
  // `_active` and whose `_estimate` the summary reads.
  const messages = [
    { role: 'user', content: '[staging fixture] Please add the new route handler.', metadata: {}, minutesAgo: 3 },
    { role: 'system', content: 'Spinning up coding agent (Claude Sonnet 5)...', metadata: {}, minutesAgo: 2 },
    {
      role: 'system',
      content: 'Claude Code is running...',
      // #359: a low remainingSeconds so a reviewer opening the seeded run
      // watches the live count-down tick down and cross into "due now" within
      // ~½m (the count-down re-anchors from load time — see dev-chat hydration).
      metadata: { estimate: { text: 'wiring up the new route', remainingSeconds: 35 } },
      minutesAgo: 2,
    },
    { role: 'system', content: 'Claude Code progress', metadata: { progressLog }, minutesAgo: 2 },
  ];

  for (const m of messages) {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'))`,
      [sessionId, m.role, m.content, JSON.stringify(m.metadata), m.minutesAgo]
    );
  }

  log.info('db', 'Staging CC-estimate fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}

// #906: estimator-OFF side-slot fixture. The progress line's muted side slot
// only renders on an ACTIVE coding-run row paired with a progress row, and
// its two interesting states are ten and thirty minutes in — none of which a
// reviewer can produce on demand. seedStagingCcEstimateRun above always
// carries metadata.estimate, so it only ever exercises the estimator-ON path.
// These two runs carry NO estimate metadata, which is what the overwhelming
// majority of users see:
//
//   short  ~5 min elapsed  → the slot is EMPTY (this is the whole point of
//                            #906: no range, no computed guess, nothing)
//   long   ~12 min elapsed → "· running longer than most — about 1 in 5 runs
//                            do", the one note that survives the change
//
// chat_sessions is staging:private, so this is invisible without seeding.
// Idempotent on the fixture branch names; strict no-op in production.
async function seedStagingCcCohortRuns(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging CC-cohort fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const owner = await getStagingCheckViewer(pool, 'Staging CC-cohort fixture');
  if (!owner) return;

  const baseLog = [
    '[refresh]',
    '[claude (mode build)]',
    '… Working out which file owns the progress readout',
    'Reading public/js/cc-progress-summary.js',
    '  ⎿ Read: 187 lines',
    'Editing public/js/cc-progress-summary.js',
    '  ⎿ Edit: ok',
  ];

  // FIXED ids (the 9008xx convention seedStagingRestartRecoveredPills uses):
  // the dev-chat route embeds the session id, so a stable id is what lets the
  // dapp.json tests and the TESTING block point at these screens across
  // staging rebuilds.
  //
  // `minutesAgo` is the run's age AT SEED TIME, and a still-running fixture
  // only gets older: runCohortHint reads the live clock, so each of these
  // rows drifts UP through the hint's buckets ('' → past 10 min → past 30
  // min) for as long as the deployment lives. The long-run fixture is
  // therefore seeded well INSIDE the terminal bucket rather than just over
  // the 10-minute line — 12 minutes read correctly for eighteen minutes
  // after a deploy and then silently became a different screen than the one
  // its dapp.json check names.
  const runs = [
    {
      id: 900810,
      branch: 'staging-fixture/cc-cohort-short',
      title: '[staging fixture] Estimator off, 5 minutes in — empty side slot',
      minutesAgo: 5,
      progressLog: baseLog,
    },
    {
      id: 900811,
      branch: 'staging-fixture/cc-cohort-long',
      title: '[staging fixture] Estimator off, 40 minutes in — long-run note',
      minutesAgo: 40,
      progressLog: baseLog.concat([
        '$ npm test',
        '  ⎿ 3168 tests, 2858 passing',
        'Editing tests/cc-progress-summary.test.js',
        '  ⎿ Edit: ok',
      ]),
    },
    {
      // #1378: the not-stoppable screen. A turn adopted after a platform
      // restart is genuinely running but has no in-process stop handle, so
      // /status reports `stoppable: false` and the composer paints a muted
      // spinner instead of a red Stop the server could not honour. There is
      // no way for a tester to produce that state on demand — it needs a
      // restart landing mid-turn — so it is seeded.
      //
      // The branch SUFFIX is the contract: stagingCohortFixtureSessions() in
      // src/routes/sessions.js keys this fixture's stoppability off
      // `-unstoppable`, so renaming the branch silently turns the screen
      // back into an ordinary stoppable one and its dapp.json check with it.
      id: 900812,
      branch: 'staging-fixture/cc-cohort-unstoppable',
      title: '[staging fixture] Busy with platform work — Stop not offered',
      minutesAgo: 8,
      progressLog: baseLog,
    },
  ];

  for (const run of runs) {
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, run.branch]
    );
    if (existing.length) {
      await pool.query(
        `UPDATE chat_sessions
            SET user_id = $1, status = 'active', last_activity_at = NOW()
          WHERE id = $2`,
        [owner.id, existing[0].id]
      );
      continue;
    }

    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_title, status, created_at, last_activity_at)
       VALUES
         ($1, $2, $3, $4, $5, 'active',
          NOW() - ($6::int * INTERVAL '1 minute'), NOW())`,
      [run.id, appId, owner.id, run.branch, run.title, run.minutesAgo + 1]
    );
    const sessionId = run.id;

    // Same ordering contract as seedStagingCcEstimateRun: the dev-chat
    // pairing pre-pass attaches the 'Claude Code progress' row to the nearest
    // PRECEDING active running status, so insert status → progress with
    // ascending timestamps and NO terminal row (or the running line will not
    // stay `_active` and the whole row renders as finished). The RUNNING
    // ROW's created_at is what the ticker measures elapsed from — not the
    // session's — so its minutesAgo is what selects the cohort string.
    // Deliberately no metadata.estimate anywhere: that is the fixture.
    const messages = [
      {
        role: 'user',
        content: '[staging fixture] Please tidy up the progress readout.',
        metadata: {},
        minutesAgo: run.minutesAgo + 1,
      },
      // An assistant reply is REQUIRED, not decoration: the boot-time
      // unanswered-turn sweep (src/services/recovery-pills.js) appends an
      // "I didn't get to reply to that" breadcrumb to any session whose user
      // message never got one — and because that breadcrumb is a newer
      // non-artefact system row, it would steal the `_active` flag from the
      // running line and the fixture would render as a finished run.
      {
        role: 'assistant',
        content: 'On it — starting a build run now.',
        metadata: {},
        minutesAgo: run.minutesAgo + 1,
      },
      {
        role: 'system',
        content: 'Spinning up coding agent (Claude Sonnet 5)...',
        metadata: {},
        minutesAgo: run.minutesAgo,
      },
      {
        role: 'system',
        content: 'Claude Code is running...',
        metadata: {},
        minutesAgo: run.minutesAgo,
      },
      {
        role: 'system',
        content: 'Claude Code progress',
        metadata: { progressLog: run.progressLog },
        minutesAgo: run.minutesAgo,
      },
    ];

    for (const m of messages) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'))`,
        [sessionId, m.role, m.content, JSON.stringify(m.metadata), m.minutesAgo]
      );
    }

    log.info('db', 'Staging CC-cohort fixture seeded', {
      appId,
      owner: owner.username,
      sessionId,
      branch: run.branch,
    });
  }
}

// #699: issue-report draft-card fixture. The card appears when a build
// agent escalates via usernode-report-platform-issue, or (#1037) when the
// Mayor answers an explicit "create an issue for this" — neither of which
// a tester can trigger on demand — so seed one dev-chat session whose
// timeline carries every card shape: a long (>300-char) PENDING draft
// that must show the "Show full report" expand toggle, a short pending
// draft that must NOT, a FILED draft (fake issueUrl/issueNumber) proving
// resolved cards stay expandable, and (#1037) a user-requested
// APP-targeted pending draft carrying the "Issue draft — <app>" header
// and the "File issue" button, preceded by the user message that produced
// it. The first three deliberately carry NO `target`, proving legacy rows
// still render as platform-destined.
// chat_sessions is staging:private, so this is invisible without seeding.
// Idempotent on the fixture branch name; strict no-op in production.
// Testers should use Dismiss (not confirm) on the pending cards — confirm
// would attempt a real GitHub call.
async function seedStagingPlatformIssueDrafts(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging platform-issue-draft fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging platform-issue-draft fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  // #1037: re-keyed so a staging clone that already carries the v1
  // fixture re-seeds and picks up the new app-targeted card.
  const fixtureBranch = 'staging-fixture/platform-issue-drafts-v2';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (existing.length) return;

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, status, created_at)
     VALUES
       ($1, $2, $3, '[staging fixture] Platform report cards demo', 'active',
        NOW() - INTERVAL '50 minutes')
     RETURNING id`,
    [appId, owner.id, fixtureBranch]
  );
  const sessionId = sessionRows[0].id;

  // ~1,500 chars — well past the 300-char preview clip, with a distinctive
  // closing line so a tester can confirm they reached the end of the text.
  const longBody = [
    '[staging fixture] What is broken: the shared bridge intermittently fails',
    'to resolve usernode.getNodeAddress() inside the native mobile WebView',
    'when the app is reopened from the background. The promise neither',
    'resolves nor rejects, so every flow that waits on a wallet address',
    'hangs on a spinner until the user force-closes the app.',
    '',
    'How to reproduce: open any wallet-connected app inside the Homeroom',
    'mobile app, background it for at least ten minutes, then reopen it and',
    'tap a flow that reads the node address. On iOS the WebView appears to',
    'suspend the bridge message channel; queued postMessage calls made',
    'before resume are silently dropped, and the bridge never re-issues',
    'them. Desktop browsers are unaffected, which is why this reads as a',
    'platform-level WebView lifecycle problem rather than an app bug.',
    '',
    'What the app needs: either the bridge should detect a resumed WebView',
    'and replay (or reject) in-flight calls so apps can retry, or it should',
    'expose a lifecycle event apps can listen to. Any app-side workaround',
    'would just be a timeout guessing at the platform state, which the',
    'conventions say to escalate instead of faking.',
    '',
    'Which app/flow hit it: the demo wallet flow in this fixture session.',
    'END OF STAGING DEMO REPORT — if you can read this line, the full',
    'report text is visible.',
  ].join('\n');

  const shortBody =
    '[staging fixture] The staging preview banner overlaps the app\'s own '
    + 'fixed header on narrow phones. Short report — no expand toggle.';

  const filedBody = [
    '[staging fixture] The checks gate reports "still running" forever when',
    'a declared test navigates to a route that redirects off-origin. The',
    'headless runner follows the redirect, the origin check rejects it, and',
    'the run is never marked finished, so the proposal stays blocked with no',
    'error surfaced to the user. Reproduce by declaring a dapp.json test',
    'whose path 302s to an external URL and pushing any proposal. Expected:',
    'the run fails fast with a clear "off-origin redirect" message instead',
    'of hanging the merge gate. This body is intentionally longer than the',
    'preview clip so the resolved (already-filed) card also demonstrates the',
    'expandable full-report view for text a user may want to re-read after',
    'the fact. END OF STAGING DEMO REPORT — full text visible.',
  ].join(' ');

  // #1037: an APP-targeted body — a bug in the app itself, not in the
  // platform — so the card's destination copy is obviously different from
  // the three platform cards above.
  const appTargetBody = [
    '[staging fixture] The leaderboard keeps showing the previous round\'s',
    'scores after a new round settles. Reproduce: finish a round on the demo',
    'screen, then open Leaderboard — the top row still shows the score from',
    'the round before, and a manual refresh corrects it. Expected: the',
    'leaderboard reflects the settled round without a refresh. Filed against',
    'this app\'s own repo rather than the platform, since nothing outside the',
    'app is involved. END OF STAGING DEMO REPORT — full text visible.',
  ].join(' ');

  const drafts = [
    {
      minutesAgo: 45,
      draft: {
        title: 'Staging demo: bridge calls hang after WebView resume',
        body: longBody,
        status: 'pending',
        appSlug: 'staging-demo-app',
        appName: 'Staging demo app',
      },
    },
    {
      minutesAgo: 40,
      draft: {
        title: 'Staging demo: preview banner overlaps fixed headers',
        body: shortBody,
        status: 'pending',
        appSlug: 'staging-demo-app',
        appName: 'Staging demo app',
      },
    },
    {
      minutesAgo: 35,
      draft: {
        title: 'Staging demo: checks gate hangs on off-origin redirects',
        body: filedBody,
        status: 'filed',
        appSlug: 'staging-demo-app',
        appName: 'Staging demo app',
        issueUrl: 'https://github.com/example/staging-demo/issues/9001',
        issueNumber: 9001,
      },
    },
    // #1037: the user-requested, APP-targeted card. Carries `target`,
    // `source` and the fulfilment status line, so a tester sees the
    // "Issue draft — <app>" header and the "File issue" button next to
    // the three legacy platform cards above.
    {
      minutesAgo: 25,
      content: issueDraftSvc.CONTENT_USER,
      draft: {
        title: 'Staging demo: leaderboard shows stale scores after a round',
        body: appTargetBody,
        status: 'pending',
        target: 'app',
        source: 'user_request',
        owner: 'example',
        repo: 'staging-demo',
        appSlug: 'staging-demo-app',
        appName: 'Staging demo app',
      },
    },
  ];

  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'user', $2, '{}', NOW() - INTERVAL '48 minutes')`,
    [sessionId, '[staging fixture] Please wire the wallet flow into the demo screen.']
  );
  // #1037: the request that produces the app-targeted card below, so the
  // new conversational entry point reads end-to-end in the timeline.
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'user', $2, '{}', NOW() - INTERVAL '26 minutes')`,
    [sessionId, '[staging fixture] create an issue for the stale leaderboard scores']
  );
  for (const d of drafts) {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
       VALUES ($1, 'system', $2, $3, NOW() - ($4::int * INTERVAL '1 minute'))`,
      [
        sessionId,
        d.content || issueDraftSvc.CONTENT_AGENT,
        JSON.stringify({ platformIssueDraft: d.draft }),
        d.minutesAgo,
      ]
    );
  }

  log.info('db', 'Staging platform-issue-draft fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}

// Sync-with-main activity fixture (issue: make sync emit session-native
// activity). Triggering a real merge against cloned data isn't possible
// in staging (there's no divergent git branch to merge), so we seed one
// dev-chat session that (a) shows the "Sync with main" banner via
// behind_main > 0 and (b) carries a representative *completed* sync
// activity in its timeline: the opening status row, a "Claude Code
// progress" row whose progressLog holds the illustrative fetch/merge/push
// lines, and the terminal "Merged main cleanly" row — exactly the rows a
// real clean sync emits. A matching SYNC_MAIN events row is recorded too.
// All ids sit in the 900xxx synthetic range and the title carries the
// "Staging demo" prefix so the row can't be mistaken for real work.
// chat_sessions is staging:private, so this is invisible without seeding.
// Strict no-op in production.
async function seedStagingSyncActivity(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    const { rows: appRows } = await pool.query(
      'SELECT id FROM apps WHERE slug = $1',
      [config.selfAppSlug]
    );
    const appId = appRows[0]?.id;
    if (!appId) {
      log.warn('db', 'Staging sync-activity fixture skipped: self-app row missing', {
        slug: config.selfAppSlug,
      });
      return;
    }

    const { rows: userRows } = await pool.query(
      `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 1`
    );
    if (!userRows.length) {
      log.warn('db', 'Staging sync-activity fixture skipped: no users');
      return;
    }
    const owner = userRows[0];

    const SESSION_ID = 900050;
    const sha = 'a1b2c3d';

    // Idempotent: re-runs on every staging boot. The session row carries
    // behind_main = 2 so the banner shows "behind main"; ON CONFLICT keeps
    // the boot path a no-op after the first seed.
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_title, status, behind_main, created_at)
       VALUES
         ($1, $2, $3, 'staging-demo/sync-activity',
          '[staging fixture] Sync-with-main activity demo', 'active', 2, NOW())
       ON CONFLICT (id) DO UPDATE SET behind_main = 2`,
      [SESSION_ID, appId, owner.id]
    );

    // Only seed the timeline rows once (keyed off whether the terminal
    // row already exists) so re-runs don't pile up duplicate activity.
    const { rows: existingMsgs } = await pool.query(
      `SELECT 1 FROM chat_session_messages
        WHERE session_id = $1 AND metadata->'syncMain' IS NOT NULL LIMIT 1`,
      [SESSION_ID]
    );
    if (!existingMsgs.length) {
      // Opening status — pairs with the progress row below via
      // ACTIVE_CC_STATUS_RE on the frontend.
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', 'Syncing with main…', '{}'::jsonb)`,
        [SESSION_ID]
      );
      // The collapsible progress log with a few illustrative lines.
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', 'Claude Code progress', $2)`,
        [SESSION_ID, JSON.stringify({
          progressLog: ['Fetching main…', 'Merging origin/main…', 'Pushing…'],
        })]
      );
      // Terminal outcome row.
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [SESSION_ID,
         `Merged main cleanly. Pushed ${sha}.`,
         JSON.stringify({ syncMain: { syncResult: 'clean', behind: 2, sha, pushOk: true } })]
      );
      // Matching analytics row.
      await pool.query(
        `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
         VALUES ($1, $2, $3, 'sync_main', $4::jsonb)`,
        [owner.id, appId, SESSION_ID,
         JSON.stringify({ syncResult: 'clean', behind: 2, sha, pushOk: true, trigger: 'manual' })]
      );
    }

    // Fable 5 fallback-notice fixture: one persisted system row (the
    // in-chat notice the fallback detection emits) plus its matching
    // analytics event, so the notice rendering is reviewable in staging —
    // a real classifier fallback can't be triggered on demand. Keyed off
    // its own metadata marker so it seeds exactly once, independent of
    // the sync rows above.
    const { rows: fallbackRows } = await pool.query(
      `SELECT 1 FROM chat_session_messages
        WHERE session_id = $1 AND metadata->'modelFallback' IS NOT NULL LIMIT 1`,
      [SESSION_ID]
    );
    if (!fallbackRows.length) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [SESSION_ID,
         'Fable 5.1 declined part of this request (safety classifier: cyber) — it was completed by Opus 5.',
         JSON.stringify({ modelFallback: { requested: 'claude-fable-5-1', served: 'claude-opus-5', category: 'cyber' } })]
      );
      await pool.query(
        `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
         VALUES ($1, $2, $3, 'model_fallback', $4::jsonb)`,
        [owner.id, appId, SESSION_ID,
         JSON.stringify({ requested: 'claude-fable-5-1', served: 'claude-opus-5', category: 'cyber', source: 'staging-seed' })]
      );
    }

    log.info('db', 'Staging sync-activity fixture seeded', {
      appId, owner: owner.username, sessionId: SESSION_ID,
    });
  } catch (err) {
    log.warn('db', 'Staging sync-activity seeding failed', { message: err.message });
  }
}

// Worker-bootstrap failure fixture. A cold worker that never reaches
// warm-ready now reports WHY — git's own stderr rides after the marker
// prefix, and describeTurnError turns it into a card that says the
// branch is untouched (see src/routes/sessions.js). None of that is
// reachable on demand in staging: it needs a clone to actually fail
// inside a container, so the only way a tester can see the new card is
// to seed the rows a real failure would have persisted.
//
// Two rows, one per branch worth reviewing: the RETRYABLE clone failure
// (the production case — three sessions on 2026-09-02 died this way and
// all the user ever saw was the words "clone failed") and the
// DETERMINISTIC checkout failure, whose card says retrying will not
// help. Both carry the same metadata a real dispatch writes, so they
// render as agent status rows rather than plain system text.
//
// Keyed off its own metadata marker so it seeds exactly once. Strict
// no-op in production.
async function seedStagingBootstrapFailure(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    const { rows: appRows } = await pool.query(
      'SELECT id FROM apps WHERE slug = $1',
      [config.selfAppSlug]
    );
    const appId = appRows[0]?.id;
    if (!appId) {
      log.warn('db', 'Staging bootstrap-failure fixture skipped: self-app row missing', {
        slug: config.selfAppSlug,
      });
      return;
    }

    const { rows: userRows } = await pool.query(
      `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 1`
    );
    if (!userRows.length) {
      log.warn('db', 'Staging bootstrap-failure fixture skipped: no users');
      return;
    }
    const owner = userRows[0];

    const SESSION_ID = 900051;

    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_title, status, created_at)
       VALUES
         ($1, $2, $3, 'staging-demo/bootstrap-failure',
          '[staging fixture] Worker bootstrap failure cards', 'active', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [SESSION_ID, appId, owner.id]
    );

    const { rows: existing } = await pool.query(
      `SELECT 1 FROM chat_session_messages
        WHERE session_id = $1 AND metadata->'bootstrapFailure' IS NOT NULL LIMIT 1`,
      [SESSION_ID]
    );
    if (!existing.length) {
      const agentMeta = { agentBackend: 'claude_code', agentModel: 'claude-opus-5' };

      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'user', $2, '{}'::jsonb)`,
        [SESSION_ID, 'Staging demo: add a dark-mode toggle to the settings screen.']
      );
      // Retryable branch. The detail is a real transient clone failure —
      // the platform retried three times before giving up, which the card
      // says so nobody re-runs it hoping for a different answer.
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [SESSION_ID,
         'Setting up the coding agent failed while cloning the repository, so the agent never started and no code was changed.'
           + ' Git reported: fatal: unable to access \'https://github.com/Usernode-Labs/social-vibecoding.git/\': Could not resolve host: github.com'
           + ' The platform already retried this a few times, so if it keeps happening the repository or the network is genuinely unreachable rather than briefly flaky.',
         JSON.stringify({
           ...agentMeta,
           durationMs: 4212,
           bootstrapFailure: { phase: 'clone', attempts: 3, retryable: true, source: 'staging-seed' },
         })]
      );
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'user', $2, '{}'::jsonb)`,
        [SESSION_ID, 'Staging demo: try that again.']
      );
      // Deterministic branch. One attempt, no retry, different advice.
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [SESSION_ID,
         'Setting up the coding agent failed while checking out this session\'s branch, so the agent never started and no code was changed.'
           + ' Git reported: fatal: a branch named \'staging-demo/bootstrap-failure\' already exists'
           + ' Retrying will not help until the branch problem is resolved.',
         JSON.stringify({
           ...agentMeta,
           durationMs: 3980,
           bootstrapFailure: { phase: 'checkout', attempts: 1, retryable: false, source: 'staging-seed' },
         })]
      );
    }

    log.info('db', 'Staging bootstrap-failure fixture seeded', {
      appId, owner: owner.username, sessionId: SESSION_ID,
    });
  } catch (err) {
    log.warn('db', 'Staging bootstrap-failure seeding failed', { message: err.message });
  }
}

// Fixtures for the home-card activity chips (#57): one dedicated demo
// app whose card exercises all three chips at once. chat_sessions is
// staging:private (schema-only in staging), so without seeded sessions
// the "to vote" / "in dev" chips would read zero on every card; the
// demo issue guarantees the issues chip is non-zero on a card testers
// can find by name. Explicit IDs sit in the 900xxx range so they can't
// collide with cloned prod rows, every row carries the "Staging demo"
// prefix per the mock-data convention, and ON CONFLICT DO NOTHING
// keeps the re-run-on-every-boot path idempotent. The demo user's
// password is a plain marker string — bcrypt.compare against a
// non-hash always fails, so the account can't be logged into.
async function seedStagingDemoAppCard(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES (900001, 'staging-demo-user', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, view_visibility, created_by)
       VALUES (900001, 'Staging demo app', 'staging-demo-app', 'running', 'public', 900001)
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status, promoted_at)
       VALUES
         (900001, 900001, 900001, 'staging-demo/promoted-pr', 900001,
          'Staging demo PR — awaiting votes', 'promoted', NOW()),
         (900002, 900001, 900001, 'staging-demo-branch', NULL, NULL, 'active', NULL)
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO issues (id, app_id, title, description, created_by, status)
       VALUES (900001, 900001, 'Staging demo issue',
               'Staging demo issue so the home-card issues chip has a row to count.',
               900001, 'open')
       ON CONFLICT DO NOTHING`
    );
    log.info('db', 'Staging demo app-card fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging demo app-card seeding failed', { message: err.message });
  }
}

// Fixtures for the anonymous landing directory (GET /api/public/apps).
// The pre-sign-in page is the first thing a logged-out visitor sees, and a
// fresh staging DB has no public running apps at all — so the grid renders
// empty and neither the open-tile zoom nor the gated-tile signup detour can
// be exercised. This seeds ONE open tile and ONE gated tile so both branches
// of the `requires_login` mapping are visible side by side, plus a little
// app_activity so the open tile's active-users badge is nonzero.
//
// The far-future anon_shell_checked_at is load-bearing: src/services/
// shell-probe.js re-probes every running public app whose check is stale
// (NULL, older than an hour, or predating last_deploy_at), and these
// fixtures have no container behind them — a plain NOW() stamp would be
// overwritten with 'unknown' (→ gated) inside one 5-minute sweep and the
// open tile would silently flip. Stamping a year out keeps both fixtures
// pinned to the classification seeded here.
//
// Ids sit in the 9001xx range so they clear cloned prod rows and the other
// 900xxx demo fixtures; names carry the "[Mock]" prefix per the mock-data
// convention; ON CONFLICT DO NOTHING keeps the every-boot re-run idempotent.
// Strictly a no-op outside staging.
async function seedStagingLandingDirectory(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    // Owner + a couple of visitors. Non-loginable: bcrypt.compare against a
    // plain marker string always fails, so these accounts can't be signed in.
    const OWNER_ID = 900100;
    const VISITOR_IDS = [900101, 900102, 900103];
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES ($1, 'staging-landing-user', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`,
      [OWNER_ID]
    );
    for (const id of VISITOR_IDS) {
      await pool.query(
        `INSERT INTO users (id, username, password)
         VALUES ($1, $2, 'staging-demo-not-a-login')
         ON CONFLICT DO NOTHING`,
        [id, `staging-landing-visitor-${id}`]
      );
    }

    const OPEN_APP_ID = 900100;
    const GATED_APP_ID = 900101;
    await pool.query(
      `INSERT INTO apps
         (id, name, slug, status, view_visibility, created_by,
          icon_emoji, last_deploy_at, anon_shell, anon_shell_checked_at)
       VALUES
         ($1, '[Mock] Open demo app', 'staging-landing-open',
          'running', 'public', $3, '🛝',
          NOW() - INTERVAL '2 days', 'public', NOW() + INTERVAL '1 year'),
         ($2, '[Mock] Gated demo app', 'staging-landing-gated',
          'running', 'public', $3, '🔒',
          NOW() - INTERVAL '3 days', 'gated', NOW() + INTERVAL '1 year')
       ON CONFLICT DO NOTHING`,
      [OPEN_APP_ID, GATED_APP_ID, OWNER_ID]
    );

    // Re-stamp on every boot: ON CONFLICT above skips rows that already
    // exist, and the probe may have clobbered the classification of a
    // fixture seeded by an earlier deploy.
    await pool.query(
      `UPDATE apps
          SET anon_shell = CASE WHEN id = $1 THEN 'public' ELSE 'gated' END,
              anon_shell_checked_at = NOW() + INTERVAL '1 year'
        WHERE id IN ($1, $2)`,
      [OPEN_APP_ID, GATED_APP_ID]
    );

    // Active-users badge: the public list counts distinct users with a
    // >=60s session in the recent window, so give the open tile three and
    // the gated tile one.
    const activity = [
      { appId: OPEN_APP_ID, userId: VISITOR_IDS[0], secs: 900, daysAgo: 1 },
      { appId: OPEN_APP_ID, userId: VISITOR_IDS[1], secs: 420, daysAgo: 2 },
      { appId: OPEN_APP_ID, userId: VISITOR_IDS[2], secs: 180, daysAgo: 4 },
      { appId: GATED_APP_ID, userId: VISITOR_IDS[0], secs: 240, daysAgo: 3 },
    ];
    for (const a of activity) {
      await pool.query(
        `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
         VALUES ($1, $2, $3, CURRENT_DATE - ($4::int))
         ON CONFLICT (app_id, user_id, date) DO NOTHING`,
        [a.appId, a.userId, a.secs, a.daysAgo]
      );
    }

    log.info('db', 'Staging landing-directory fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging landing-directory seeding failed', { message: err.message });
  }
}

// #562: fixtures for the cross-app "submitted features" admin API
// (GET /api/admin/submitted-features). A fresh staging DB has no
// general issues, so the ranked-by-votes list would render empty and be
// impossible to review. This seeds several kind='general' issues spread
// across THREE demo apps with DISTINCT up-vote tallies (7/5/3/1) so the
// `up_count DESC` ordering and the cross-app interleaving are both
// visible, plus a nonzero down-count on one row, one CLOSED feature and
// one COMPLETED (shipped) feature so the `?status=all` / `?status=closed`
// / `?status=completed` paths (#565) all render non-empty. It also
// inserts two governance rows (secret_change / close_issue) that MUST NOT
// appear in the endpoint, so the kind filter is exercised. All ids sit in
// the 9056xxx range to clear cloned prod rows and the other 900xxx demo
// fixtures; every title carries the "[Mock]" / "Staging demo" prefix; and
// ON CONFLICT DO NOTHING keeps the every-boot re-run idempotent. Strictly
// a no-op outside staging.
async function seedStagingSubmittedFeatures(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    // A small pool of demo voters (non-loginable — bcrypt.compare against a
    // non-hash always fails). Ids in the 9056xxx range.
    const voterIds = [9056001, 9056002, 9056003, 9056004, 9056005, 9056006, 9056007];
    for (const id of voterIds) {
      await pool.query(
        `INSERT INTO users (id, username, password)
         VALUES ($1, $2, 'staging-demo-not-a-login')
         ON CONFLICT DO NOTHING`,
        [id, `staging-demo-voter-${id}`]
      );
    }
    const authorId = voterIds[0];

    // Three demo apps so the cross-app list has something to interleave.
    const apps = [
      { id: 9056001, name: 'Staging demo — Alpha', slug: 'staging-demo-alpha' },
      { id: 9056002, name: 'Staging demo — Beta', slug: 'staging-demo-beta' },
      { id: 9056003, name: 'Staging demo — Gamma', slug: 'staging-demo-gamma' },
    ];
    for (const a of apps) {
      await pool.query(
        `INSERT INTO apps (id, name, slug, status, view_visibility, created_by)
         VALUES ($1, $2, $3, 'running', 'public', $4)
         ON CONFLICT DO NOTHING`,
        [a.id, a.name, a.slug, authorId]
      );
    }

    // Features: distinct up-counts across apps so ordering is obvious.
    // `up`/`down` say how many of the demo voters up/down-vote each row.
    const features = [
      { id: 9056101, app: 9056001, kind: 'general', status: 'open',
        title: '[Mock] Add a dark-mode toggle to the header', up: 7, down: 1 },
      { id: 9056102, app: 9056002, kind: 'general', status: 'open',
        title: '[Mock] Keyboard shortcuts for voting (Y/N)', up: 5, down: 0 },
      { id: 9056103, app: 9056003, kind: 'general', status: 'open',
        title: '[Mock] Export the leaderboard as CSV', up: 3, down: 2 },
      { id: 9056104, app: 9056001, kind: 'general', status: 'open',
        title: '[Mock] Remember scroll position on the feed', up: 1, down: 0 },
      { id: 9056105, app: 9056002, kind: 'general', status: 'closed',
        title: '[Mock] (shipped) Show avatars on kanban cards', up: 4, down: 0 },
      // A COMPLETED (shipped) feature so the Completed filter + "Shipped"
      // badge are reviewable in staging (#565). status='completed' is a
      // distinct state from open/closed and only surfaces under the
      // Completed or All filters. Up-count (6) is distinct from the others
      // so ordering stays legible.
      { id: 9056108, app: 9056001, kind: 'general', status: 'completed',
        title: '[Mock] (shipped) Inline image paste in chat', up: 6, down: 0 },
      // Governance rows — MUST be excluded by the kind filter.
      { id: 9056106, app: 9056001, kind: 'secret_change', status: 'open',
        title: '[Mock] Set FEATURE_FLAG to "on"', up: 6, down: 0 },
      { id: 9056107, app: 9056003, kind: 'close_issue', status: 'open',
        title: '[Mock] Close issue #900001', up: 6, down: 0 },
    ];

    for (const f of features) {
      await pool.query(
        `INSERT INTO issues (id, app_id, title, description, kind, created_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [f.id, f.app, f.title,
          'Staging demo submitted feature for the cross-app admin API (#562).',
          f.kind, authorId, f.status]
      );
      // Up-votes from the first `up` voters, down-votes from the next `down`.
      for (let i = 0; i < f.up && i < voterIds.length; i++) {
        await pool.query(
          `INSERT INTO issue_votes (issue_id, user_id, vote)
           VALUES ($1, $2, 'up')
           ON CONFLICT (issue_id, user_id) DO NOTHING`,
          [f.id, voterIds[i]]
        );
      }
      for (let i = f.up; i < f.up + f.down && i < voterIds.length; i++) {
        await pool.query(
          `INSERT INTO issue_votes (issue_id, user_id, vote)
           VALUES ($1, $2, 'down')
           ON CONFLICT (issue_id, user_id) DO NOTHING`,
          [f.id, voterIds[i]]
        );
      }
    }
    log.info('db', 'Staging submitted-features fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging submitted-features seeding failed', { message: err.message });
  }
}

// Fixture for the build-failure log panel (#416): one obviously-fake
// errored app whose last_failure carries a realistic healthcheck
// failure record, so the "View build log" menu item / panel and the
// app-tab error screen are exercisable in staging without provisioning
// a real failing import. Owned by the demo user (900001); admins (the
// capture user included) pass the involved-user gate and see the log.
// The synthetic slug is the stable key. That matters on a long-lived clone:
// fixed numeric ids can collide with newer production rows, while the
// obvious `staging-demo-*` slug cannot. The slug upsert also repairs an older
// fixture row in place on every preview boot.
async function seedStagingFailedApp(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (username, password)
       VALUES ('staging-demo-user', 'staging-demo-not-a-login')
       ON CONFLICT (username) DO NOTHING`
    );
    const logLines = [
      '# Staging demo build log — synthetic fixture for the build-log panel',
      '> staging-demo-failed-app@1.0.0 start',
      '> node server.js',
      '',
      'node:internal/modules/cjs/loader:1145',
      '  throw err;',
      '  ^',
      '',
      "Error: Cannot find module './lib/dapp-server'",
      'Require stack:',
      '- /app/server.js',
      '    at Module._resolveFilename (node:internal/modules/cjs/loader:1142:15)',
      '    at Module._load (node:internal/modules/cjs/loader:983:27)',
      '    at Module.require (node:internal/modules/cjs/loader:1230:19)',
      '    at require (node:internal/modules/helpers:179:18)',
      '    at Object.<anonymous> (/app/server.js:6:22)',
      '    at Module._compile (node:internal/modules/cjs/loader:1368:14)',
      '    at Module._extensions..js (node:internal/modules/cjs/loader:1426:10)',
      '    at Module.load (node:internal/modules/cjs/loader:1205:32)',
      '    at Module._load (node:internal/modules/cjs/loader:1021:12)',
      '    at Function.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:142:12) {',
      "  code: 'MODULE_NOT_FOUND',",
      "  requireStack: [ '/app/server.js' ]",
      '}',
      '',
      'Node.js v20.11.1',
      '',
      '(container restarted by --restart unless-stopped, same crash repeats)',
      "Error: Cannot find module './lib/dapp-server'",
      "  code: 'MODULE_NOT_FOUND'",
    ].join('\n');
    const lastFailure = {
      stage: 'healthcheck',
      reason: "[exited (exit=1)] Error: Cannot find module './lib/dapp-server'",
      log: logLines,
      at: new Date().toISOString(),
      sha: null,
    };
    await pool.query(
      `INSERT INTO apps (name, slug, status, view_visibility, created_by, retry_count, last_failure)
       SELECT 'Staging demo failed app', 'staging-demo-failed-app', 'error', 'public',
              id, 0, $1::jsonb
         FROM users WHERE username = 'staging-demo-user'
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name,
             status = EXCLUDED.status,
             view_visibility = EXCLUDED.view_visibility,
             created_by = EXCLUDED.created_by,
             retry_count = EXCLUDED.retry_count,
             last_failure = EXCLUDED.last_failure`,
      [JSON.stringify(lastFailure)]
    );
    const { rows: viewerRows } = await pool.query(
      'SELECT id FROM users WHERE username = ANY($1::text[])',
      [[config.adminUsername, 'usernode-capture', 'usernode-capture-admin'].filter(Boolean)]
    );
    for (const { id: viewerId } of viewerRows) {
      await pool.query(
        `INSERT INTO app_favorites (app_id, user_id, sort_order)
         SELECT id, $1, 2 FROM apps WHERE slug = 'staging-demo-failed-app'
         ON CONFLICT (app_id, user_id) DO UPDATE
           SET hidden = FALSE, sort_order = EXCLUDED.sort_order`,
        [viewerId]
      );
    }
    log.info('db', 'Staging failed-app fixture seeded', { viewers: viewerRows.length });
  } catch (err) {
    log.warn('db', 'Staging failed-app seeding failed', { message: err.message });
  }
}

// Fixtures for the "Fork an entire dapp" lineage badge/tag. Three
// obviously-fake public app rows so the new UI is exercisable in staging
// without running real fork provisioning (which needs Docker + a GitHub
// PAT the staging container doesn't have):
//   1. a forkable TARGET (no lineage) — gives the Fork dialog a source;
//   2. a live-name demo FORK whose forked_from references the target by
//      id/slug (NO name stored) — proves the serializer resolves the
//      source's current name and renders the amber "Forked from …" label
//      + home-tile ⑂ tag with a working link;
//   3. an ORPHAN fork whose forked_from points at a non-existent source —
//      proves the "<deleted>" fallback + inert (non-link) label.
// The obvious `staging-demo-*` slugs are the stable keys. Numeric ids are
// allocated by the clone so production growth cannot silently suppress one
// of these rows; slug upserts repair older fixture rows on every boot.
async function seedStagingForkLineage(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (username, password)
       VALUES ('staging-demo-user', 'staging-demo-not-a-login')
       ON CONFLICT (username) DO NOTHING`
    );
    // 1. Forkable target.
    await pool.query(
      `INSERT INTO apps (name, slug, status, view_visibility, created_by)
       SELECT 'Staging demo forkable app', 'staging-demo-forkable', 'running', 'public', id
         FROM users WHERE username = 'staging-demo-user'
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name,
             status = EXCLUDED.status,
             view_visibility = EXCLUDED.view_visibility,
             created_by = EXCLUDED.created_by`
    );
    // 2. Live-name demo fork (reference-only forked_from → the target).
    await pool.query(
      `INSERT INTO apps (name, slug, status, view_visibility, created_by, forked_from)
       SELECT 'Staging demo fork', 'staging-demo-fork', 'running', 'public', owner.id,
              jsonb_build_object('appId', source.id, 'slug', source.slug)
         FROM users owner
         JOIN apps source ON source.slug = 'staging-demo-forkable'
        WHERE owner.username = 'staging-demo-user'
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name,
             status = EXCLUDED.status,
             view_visibility = EXCLUDED.view_visibility,
             created_by = EXCLUDED.created_by,
             forked_from = EXCLUDED.forked_from`
    );
    // 3. Orphan fork (source id deliberately does not exist → "<deleted>").
    await pool.query(
      `INSERT INTO apps (name, slug, status, view_visibility, created_by, forked_from)
       SELECT 'Staging demo fork (orphan)', 'staging-demo-fork-orphan', 'running', 'public', id,
              '{"appId": 2147483647, "slug": "staging-demo-missing"}'::jsonb
         FROM users WHERE username = 'staging-demo-user'
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name,
             status = EXCLUDED.status,
             view_visibility = EXCLUDED.view_visibility,
             created_by = EXCLUDED.created_by,
             forked_from = EXCLUDED.forked_from`
    );
    const { rows: viewerRows } = await pool.query(
      'SELECT id FROM users WHERE username = ANY($1::text[])',
      [[config.adminUsername, 'usernode-capture', 'usernode-capture-admin'].filter(Boolean)]
    );
    for (const { id: viewerId } of viewerRows) {
      await pool.query(
        `INSERT INTO app_favorites (app_id, user_id, sort_order)
         SELECT id, $1, 1 FROM apps WHERE slug = 'staging-demo-fork'
         ON CONFLICT (app_id, user_id) DO UPDATE
           SET hidden = FALSE, sort_order = EXCLUDED.sort_order`,
        [viewerId]
      );
    }
    log.info('db', 'Staging fork-lineage fixtures seeded', { viewers: viewerRows.length });
  } catch (err) {
    log.warn('db', 'Staging fork-lineage seeding failed', { message: err.message });
  }
}

// Demo mode on the fork fixture, so the App settings dialog's demo-mode
// notice (frontend/src/features/dialogs/app-settings.tsx) has something to
// render in a preview: `staging-demo-forkable` gets a synthetic partner and
// the switch on. The SOURCE fixture, not the fork: demo mode masks an app's
// fork lineage (routes/apps.js attachForkLineage), and the Browse check on
// `staging-demo-fork` pins that fork's "Forked from" line. The partner is a real users row with the same no-login posture
// as every fixture identity, with is_synthetic on top so the session
// middleware refuses it before the password ever would. No base sha and no
// GitHub in staging, so the demo endpoints themselves answer 409 here; only
// the marking is exercised, which is the part a check can see.
async function seedStagingDemoMode(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (username, password, is_admin, can_create_apps, is_synthetic)
       VALUES ('staging_demo_partner', 'staging-demo-not-a-login', FALSE, FALSE, TRUE)
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`
    );
    await pool.query(
      `UPDATE apps
          SET demo_mode = TRUE,
              demo_partner_id = (SELECT id FROM users WHERE username = 'staging_demo_partner')
        WHERE slug = 'staging-demo-forkable'`
    );
  } catch (err) {
    log.warn('db', 'Staging demo-mode fixture skipped', { err: err.message });
  }
}

// Fixtures for the Members & visibility panel. The public demo app above
// renders the visibility toggles but NOT the collaborator list (that
// section only shows for an invite-only app). To demonstrate the member
// list + invite typeahead — and so the panel-opens fix has data behind it —
// seed a private (collab_visibility='private') app owned by the demo user
// with two collaborators: one accepted member and one pending invite.
// app_collaborators is NOT staging:private (membership must survive into
// clones), but a freshly seeded private app has no extra members until we
// add them here. IDs sit in the 900xxx range, rows carry the "Staging demo"
// prefix, and ON CONFLICT DO NOTHING keeps the every-boot re-run idempotent.
// Sentinel passwords mean the fixture accounts can never log in.
async function seedStagingMembersPanel(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    // Demo collaborator accounts (alongside staging-demo-user/900001, which
    // owns the private app below and is its creator-member).
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES
         (900020, 'staging-demo-collab',   'staging-demo-not-a-login'),
         (900021, 'staging-demo-invitee',  'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    // Invite-only app: both build + view private (collab-private may keep a
    // public view, but private/private is the clearest demo and satisfies
    // the collab-public⇒view-public invariant).
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES (900010, 'Staging demo private app', 'staging-demo-private-app', 'running',
               'private', 'private', 900001)
       ON CONFLICT DO NOTHING`
    );
    // Membership rows: creator as accepted member, one extra accepted
    // member (removable), and one pending invite (renders the "invited"
    // tag + a "Revoke" control).
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
       VALUES
         (900010, 900001, 'member',  900001, NOW()),
         (900010, 900020, 'member',  900001, NOW()),
         (900010, 900021, 'invited', 900001, NULL)
       ON CONFLICT (app_id, user_id) DO NOTHING`
    );
    log.info('db', 'Staging members-panel fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging members-panel seeding failed', { message: err.message });
  }
}

// Fixtures for the user directory (#1195). A fresh staging container's
// users table holds only the handful of accounts the other seeds create,
// none of which share a prefix — so a typeahead over it returns one row
// and demonstrates nothing, and the case-collision branch is unreachable.
//
// Three groups, all in the 9000xx range with sentinel passwords that can
// never log in:
//   • twelve 'staging-demo-car*' handles — a common prefix with enough
//     rows that BOTH clamp points are demonstrable: limit=4 shows
//     has_more with room to spare, and the DEFAULT limit of 10 also
//     truncates (12 > 10), so the untouched-limit typeahead path shows
//     has_more: true too (#1213).
//   • 'staging-demo-Nova' / 'staging-demo-nova' — a real case collision.
//     users.username is UNIQUE but case-SENSITIVE, and before #2296
//     registration normalized nothing, so a legacy pair like this exists
//     in production (Drea/drea). Looking up 'staging-demo-NOVA' matches
//     neither exactly and returns the lower id with ambiguous: true.
//     The users_reject_case_variant_username trigger now refuses a NEW
//     pair, so this one is written in its own transaction with that
//     trigger switched off — the same shape the legacy row has, which is
//     what the fixture exists to reproduce. It is its own statement so a
//     failure here cannot take the other directory fixtures down with it.
//   • 'staging-demo-a_b_test' — a handle containing a LIKE
//     metacharacter, so the escapeLike path is visible from a preview:
//     searching 'staging-demo-a_b' must return exactly this row, not
//     every 'staging-demo-a?b…' shape an unescaped underscore would
//     match.
// ON CONFLICT DO NOTHING keeps the every-boot re-run idempotent.
async function seedStagingUserDirectory(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES
         (900060, 'staging-demo-carla',    'staging-demo-not-a-login'),
         (900061, 'staging-demo-carlos',   'staging-demo-not-a-login'),
         (900062, 'staging-demo-carmen',   'staging-demo-not-a-login'),
         (900063, 'staging-demo-carter',   'staging-demo-not-a-login'),
         (900064, 'staging-demo-cargo-bot','staging-demo-not-a-login'),
         (900067, 'staging-demo-caramel',  'staging-demo-not-a-login'),
         (900068, 'staging-demo-carbon',   'staging-demo-not-a-login'),
         (900069, 'staging-demo-cardio',   'staging-demo-not-a-login'),
         (900073, 'staging-demo-carina',   'staging-demo-not-a-login'),
         (900074, 'staging-demo-carnival', 'staging-demo-not-a-login'),
         (900075, 'staging-demo-carol',    'staging-demo-not-a-login'),
         (900076, 'staging-demo-carwash',  'staging-demo-not-a-login'),
         (900077, 'staging-demo-a_b_test', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    log.info('db', 'Staging user-directory fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging user-directory seeding failed', { message: err.message });
  }

  // The legacy case-collision pair. DISABLE TRIGGER inside the transaction
  // is invisible to every other session: the ACCESS EXCLUSIVE lock it takes
  // on `users` is held until COMMIT, when the trigger is already back on.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE users DISABLE TRIGGER users_reject_case_variant_username');
    await client.query(
      `INSERT INTO users (id, username, password)
       VALUES
         (900065, 'staging-demo-Nova', 'staging-demo-not-a-login'),
         (900066, 'staging-demo-nova', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    await client.query('ALTER TABLE users ENABLE TRIGGER users_reject_case_variant_username');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.warn('db', 'Staging user-directory case-collision seeding failed', { message: err.message });
  } finally {
    client.release();
  }
}

// Fixtures for the reworked Approvers section in the Members &
// visibility panel: under the default 'anyone' policy the section is
// hidden while the roster is empty (any ordinary prod-cloned app demos
// that for free) and shows a dormant-roster note when leftover rows
// exist; under 'invited' it renders with the admin-fallback empty-state
// copy when empty. Seeds two demo apps owned by staging-demo-user
// (900001, from seedStagingDemoAppCard, which runs first):
//   - 900011 'anyone' policy + one member + one pending invite → the
//     dormant-roster branch (note + Revoke control). Carries a fake
//     repo_url so the governance pills are enabled and the
//     "Invited approvers" tap reveals the Initial-approvers step.
//   - 900012 'invited' policy + one member → the normal invited-mode
//     roster; the merge gate reads the same rows.
// app_approvers is NOT staging:private (rows must survive into clones),
// but these fixture apps are created empty here, so their rosters are
// seeded too. Ids in the free 9000xx ranges; idempotent via fixed ids +
// ON CONFLICT DO NOTHING; strictly a no-op outside staging.
async function seedStagingApproverPanel(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES
         (900025, 'staging-demo-approver',         'staging-demo-not-a-login'),
         (900026, 'staging-demo-approver-invitee', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility,
                         created_by, approver_policy, repo_url)
       VALUES
         (900011, 'Staging demo dormant approvers', 'staging-demo-dormant-approvers', 'running',
          'public', 'public', 900001, 'anyone', 'https://github.com/staging-demo/dormant-approvers'),
         (900012, 'Staging demo invited approvers', 'staging-demo-invited-approvers', 'running',
          'public', 'public', 900001, 'invited', 'https://github.com/staging-demo/invited-approvers')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO app_approvers (app_id, user_id, status, invited_by, accepted_at)
       VALUES
         (900011, 900025, 'member',  900001, NOW()),
         (900011, 900026, 'invited', 900001, NULL),
         (900012, 900025, 'member',  900001, NOW())
       ON CONFLICT (app_id, user_id) DO NOTHING`
    );
    log.info('db', 'Staging approver-panel fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging approver-panel seeding failed', { message: err.message });
  }
}

// Fixtures for the Members modal's App-admins editor (#788 follow-up:
// propose-a-PR editing). app_admins + apps.admin_usernames are empty in
// every staging clone (prod declares no per-app admins yet), so without
// these the new editor renders a blank roster in every PR review. Two
// demo apps:
//   - 'staging-demo-admins': a populated roster exercising resolved
//     rows AND a declared-but-unregistered name in one screen, with a
//     plausible repo_url so the editor renders enabled;
//   - 'staging-demo-admins-pending': a roster plus an OPEN admins
//     proposal (requires_explicit_approval stamped) so the
//     "already up for vote" state and the Explicit-approval chip are
//     reviewable without opening a real PR.
// Owned by the seed's own staging-demo-admin (900090) rather than the
// shared staging-demo-user/900001 — originally to dodge the fresh-clone
// FK failure that seedStagingDemoUser now fixes at the source, and kept
// because these two apps are about an admin roster, not the demo user's
// portfolio. The logged-in admin tester's canAdminWrite grants the
// manager view regardless of creator. Idempotent (fixed 9000xx ids + ON CONFLICT DO
// NOTHING), obviously fake, strictly a no-op outside staging.
async function seedStagingAppAdminsPanel(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES
         (900090, 'staging-demo-admin',      'staging-demo-not-a-login'),
         (900091, 'staging-demo-maintainer', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility,
                         created_by, repo_url, admin_usernames)
       VALUES
         (900090, 'Staging demo admin roster', 'staging-demo-admins', 'running',
          'public', 'public', 900090, 'https://github.com/staging-demo/staging-demo-admins',
          ARRAY['staging-demo-admin','staging-demo-maintainer','staging-demo-unregistered']),
         (900091, 'Staging demo admins pending', 'staging-demo-admins-pending', 'running',
          'public', 'public', 900090, 'https://github.com/staging-demo/staging-demo-admins-pending',
          ARRAY['staging-demo-admin'])
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO app_admins (app_id, user_id)
       VALUES (900090, 900090), (900090, 900091), (900091, 900090)
       ON CONFLICT (app_id, user_id) DO NOTHING`
    );
    // The open admins proposal on the pending app — branch prefix
    // 'admins/' is what findAdminsPr keys on, and the explicit-approval
    // stamp is what renders the amber chip + disables the timers.
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_url, pr_title, status,
          promoted_at, created_at, requires_explicit_approval, explicit_approval_reason)
       VALUES (900091, 900091, 900090, 'admins/staging-demo-admins-pending-1', 900091,
               'https://github.com/staging-demo/staging-demo-admins-pending/pull/900091',
               'Staging demo: change app admins', 'promoted',
               NOW() - INTERVAL '1 hour', NOW() - INTERVAL '2 hours', TRUE, 'admins')
       ON CONFLICT DO NOTHING`
    );
    log.info('db', 'Staging app-admins panel fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging app-admins panel seeding failed', { message: err.message });
  }
}

// #621: fixtures for read-only Dev tab access. A collab-private but
// VIEW-PUBLIC app the staging tester is NOT a collaborator on, so a
// non-admin account sees its Dev tab in read-only mode (admins bypass
// every gate, so testing needs a non-admin login). Seeds the app, its
// builder-member owner, a few general-chat messages, one open issue and
// one promoted proposal with a vote so the feed, chat history and tally
// all render non-empty. Ids in the free 90008x range; idempotent via
// explicit ids + ON CONFLICT DO NOTHING; strictly a no-op outside
// staging.
async function seedStagingReadonlyDevTab(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES (900080, 'staging-demo-builder', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES (900080, 'Staging demo read-only app', 'staging-demo-readonly', 'running',
               'private', 'public', 900080)
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
       VALUES (900080, 900080, 'member', 900080, NOW())
       ON CONFLICT (app_id, user_id) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO chat_messages (id, app_id, user_id, content, msg_type, created_at)
       VALUES
         (900080, 900080, 900080, 'Staging demo: welcome to the read-only demo app''s group chat.', 'message', NOW() - INTERVAL '30 minutes'),
         (900081, 900080, 900080, 'Staging demo: non-collaborators can read this history but the composer is replaced with a notice.', 'message', NOW() - INTERVAL '20 minutes'),
         (900082, 900080, 900080, 'Staging demo: the proposal below shows its tally without vote buttons for read-only viewers.', 'message', NOW() - INTERVAL '10 minutes')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO issues (id, app_id, title, description, created_by, status)
       VALUES (900080, 900080, 'Staging demo read-only issue',
               'Staging demo issue — visible to read-only viewers, with no vote buttons.',
               900080, 'open')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status, promoted_at, created_at)
       VALUES (900080, 900080, 900080, 'staging-demo/readonly-proposal', 900080,
               'Staging demo read-only proposal — tally visible, voting hidden', 'promoted',
               NOW() - INTERVAL '1 hour', NOW() - INTERVAL '2 hours')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote)
       VALUES (900080, 900080, 'yes')
       ON CONFLICT (session_id, user_id) DO NOTHING`
    );
    log.info('db', 'Staging read-only dev-tab fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging read-only dev-tab seeding failed', { message: err.message });
  }
}

// A QUIET app for the general chat's proposal events and quiet card
// (features/group-chat/proposal-event.tsx, quiet-card.tsx): an app whose
// Discussion holds nothing but the platform's own notices and not one message
// from a person. The general chat draws only two of those notices — a
// proposal put up for a vote and a proposal merged — so the rows below are
// two settled submissions with their merges, two notices of other kinds that
// the chat must NOT draw, and one submission whose vote is still open. The
// declared checks read the open one as a message from its proposer with a
// box that links to the proposal, a merge as a message from the app, and the
// quiet card after them. The platform app's own staging transcript cannot
// serve here: its fixtures seed dozens of human rows, which is exactly what
// makes the card go away.
//
// The open submission carries the metadata tag the live promote path writes,
// so `GroupChat._eventHref` links it and `_votePhase` resolves it out of
// /promoted; the two settled ones carry none, the shape of a row that
// predates the tag, so their PR numbers come out of the wording alone.
// Read-only viewers see the same rows. Ids in the free 90011x range;
// idempotent via explicit ids + ON CONFLICT DO NOTHING; a no-op outside
// staging.
async function seedStagingQuietDiscussion(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES (900110, 'staging-demo-quiet-builder', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES (900110, 'Staging demo quiet app', 'staging-demo-quiet', 'running',
               'private', 'public', 900110)
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
       VALUES (900110, 900110, 'member', 900110, NOW())
       ON CONFLICT (app_id, user_id) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status, promoted_at, created_at)
       VALUES (900110, 900110, 900110, 'staging-demo/quiet-open-proposal', 900110,
               'Staging demo: a proposal that is still up for a vote', 'promoted',
               NOW() - INTERVAL '1 hour', NOW() - INTERVAL '2 hours')
       ON CONFLICT DO NOTHING`
    );
    // The general stream (thread_type NULL), oldest first, worded like the
    // platform's own lines (routes/votes.js) with "Staging demo" in each so
    // nobody mistakes one for history.
    await pool.query(
      `INSERT INTO chat_messages (id, app_id, user_id, content, msg_type, metadata, created_at)
       VALUES
         (900111, 900110, NULL,
          'staging-demo-quiet-builder promoted PR #900107: Staging demo: the first change for voting',
          'vote', '{}', NOW() - INTERVAL '3 hours'),
         (900112, 900110, NULL,
          'Staging demo: the first change is live (PR #900107). Thanks to everyone who voted (1/1 votes)',
          'system', '{}', NOW() - INTERVAL '2 hours 40 minutes'),
         (900113, 900110, NULL,
          'staging-demo-quiet-builder promoted PR #900108: Staging demo: the second change for voting',
          'vote', '{}', NOW() - INTERVAL '2 hours'),
         (900114, 900110, NULL,
          'Staging demo: issue #900110 closed by group vote (1/1)',
          'system', '{}', NOW() - INTERVAL '1 hour 50 minutes'),
         (900115, 900110, NULL,
          'Staging demo: the second change is live (PR #900108). Thanks to everyone who voted (1/1 votes)',
          'system', '{}', NOW() - INTERVAL '1 hour 40 minutes'),
         (900116, 900110, NULL,
          'Staging demo: PR #900109: an earlier change reached the vote threshold but is still running its tests. Merge is blocked until checks pass.',
          'system', '{}', NOW() - INTERVAL '1 hour 10 minutes'),
         (900117, 900110, NULL,
          'staging-demo-quiet-builder promoted PR #900110: Staging demo: a proposal that is still up for a vote for voting',
          'vote', '{"vote": {"sessionId": 900110, "prNumber": 900110}}', NOW() - INTERVAL '30 minutes')
       ON CONFLICT DO NOTHING`
    );
    log.info('db', 'Staging quiet-discussion fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging quiet-discussion seeding failed', { message: err.message });
  }
}

// Fixtures for the home screen's "Your apps" section + search bar
// (homepage restructure). The section is the union of membership
// (app_collaborators status='member') and manual favorites
// (app_favorites), keyed to the VIEWER — and the staging tester logs
// in as the admin account seedAdmin creates, whose personal rows won't
// exist in a fresh clone. Seed both inclusion paths for that account:
//   - a membership row on 'Staging demo app' (from
//     seedStagingDemoAppCard above) → the automatic path;
//   - a favorite row (with sort_order) on a demo app the admin is NOT
//     a member of → the manual "Add to Your apps" path + ordering.
// Also seed a handful of extra running public apps with distinct,
// searchable names so the search bar has something to filter and the
// denser multi-column grid actually wraps. They upsert by their obviously
// fake slugs instead of collision-prone ids, and are a strict no-op outside
// staging.
async function seedStagingYourApps(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (username, password)
       VALUES ('staging-demo-user', 'staging-demo-not-a-login')
       ON CONFLICT (username) DO NOTHING`
    );
    // Searchable demo apps, owned by the existing staging-demo-user. They
    // must exist before the favorite row below references one of them.
    await pool.query(
      `INSERT INTO apps (name, slug, status, view_visibility, created_by)
       SELECT fixture.name, fixture.slug, 'running', 'public', owner.id
         FROM (VALUES
           ('Staging demo Chess Arena',  'staging-demo-chess-arena'),
           ('Staging demo Puzzle Chain', 'staging-demo-puzzle-chain'),
           ('Staging demo Word Garden',  'staging-demo-word-garden'),
           ('Staging demo Pixel Racer',  'staging-demo-pixel-racer')
         ) AS fixture(name, slug)
         CROSS JOIN users owner
        WHERE owner.username = 'staging-demo-user'
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name,
             status = EXCLUDED.status,
             view_visibility = EXCLUDED.view_visibility,
             created_by = EXCLUDED.created_by`
    );

    // Grant the rows to every identity a tester's eyes look through:
    // the interactive admin login (config.adminUsername), plus the two
    // capture identities — screenshots sign as usernode-capture and
    // the proposal-checks suite signs as usernode-capture-admin (see
    // services/visuals.js) — so the section renders in the before/
    // after shots and the declared dapp.json test alike.
    const { rows: viewerRows } = await pool.query(
      'SELECT id FROM users WHERE username = ANY($1::text[])',
      [[config.adminUsername, 'usernode-capture', 'usernode-capture-admin']]
    );
    for (const { id: viewerId } of viewerRows) {
      // Automatic-membership path: viewer is a member of the demo app.
      await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
         SELECT id, $1, 'member', $1, NOW()
           FROM apps WHERE slug = 'staging-demo-app'
         ON CONFLICT (app_id, user_id) DO NOTHING`,
        [viewerId]
      );
      // Manual-favorite path: viewer added Chess Arena (not a member).
      await pool.query(
        `INSERT INTO app_favorites (app_id, user_id, sort_order)
         SELECT id, $1, 0 FROM apps WHERE slug = 'staging-demo-chess-arena'
         ON CONFLICT (app_id, user_id) DO UPDATE
           SET hidden = FALSE, sort_order = EXCLUDED.sort_order`,
        [viewerId]
      );
      // The fork-lineage fixture (900031, from seedStagingForkLineage
      // above) too, for the same reason and by the same path: home only
      // paints tiles it considers "yours" — membership or favorite —
      // plus the featured row, and 900031 is owned by staging-demo-user
      // and isn't featured, so the "forked from …" lineage tag had
      // nothing to render on and its dapp.json check asserted against a
      // tile that was never on the page. Favoriting is the lightest way
      // in: it needs no collaborator row on an app the tester doesn't
      // own, and it leaves 900032 (the orphan-source variant) off the
      // home screen, which is right — its state belongs to the app page.
      await pool.query(
        `INSERT INTO app_favorites (app_id, user_id, sort_order)
         SELECT 900031, $1, 1
         WHERE EXISTS (SELECT 1 FROM apps WHERE id = 900031)
         ON CONFLICT (app_id, user_id) DO NOTHING`,
        [viewerId]
      );
    }
    log.info('db', 'Staging your-apps fixtures seeded', { viewers: viewerRows.length });
  } catch (err) {
    log.warn('db', 'Staging your-apps seeding failed', { message: err.message });
  }
}

// Fixtures for the two Tier-A surfaces #1120 slice 6 converts: the browse
// list/detail (features/apps/browse.js + app-card.js) and the notifications
// drawer's pinned Invites card (features/notifications/notifications.js).
//
// Most of what that slice needs is already on this file — seedStaging-
// Notifications seeds nine kinds plus a pending APPROVER invite,
// seedStagingYourApps seeds four searchable apps, seedStagingTopochain seeds
// two seasons with standings and challenges. Two gaps are real, and both are
// gaps in BRANCH coverage rather than in row count:
//
//   1. `AppCard.iconTileFor` picks image > emoji > first-letter, and stamps
//      the choice on the tile as `data-icon`. Nothing PERSISTED exercises
//      the image or emoji arm — routes/apps.js's demoIconApps() covers them,
//      but that is request-time injection behind `?demo=1`, so it never
//      reaches the browse list a converted component actually renders, and
//      its rows carry `demo: true` (inert, excluded from the kit drag).
//      Seeded here: one app per arm, plus a fourth that is `anon_shell =
//      'gated'` so the requires-login chip has a row of its own.
//   2. The Invites card renders collaborator and approver invites through
//      the same component with different verbs. Only the approver arm was
//      seeded, so half of it has never rendered in a preview.
//
// Conventions as elsewhere in this file: fixed ids in an obviously-fake
// range (9002xx here, clear of the 9000xx/9001xx blocks above), names
// prefixed 'Staging demo app —', a sentinel non-bcrypt password on the
// owner so it can never be signed in, ON CONFLICT DO NOTHING throughout,
// best-effort try/catch so a fixture bug never blocks boot, and a strict
// no-op outside staging.
//
// The `anon_shell_checked_at` on the gated row is stamped a year out for
// the reason seedStagingLandingDirectory documents: services/shell-probe.js
// re-probes stale public running apps, and these have no container behind
// them, so a NOW() stamp would be rewritten to 'unknown' within one sweep.
async function seedStagingBrowseCardBranches(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  // The same 1×1-ish PNG routes/apps.js serves to the ?demo=1 rows, stored
  // as a real app_icons blob so /app-icons/:id resolves — the client is
  // given an icon_url either way, and this makes the persisted path real.
  //
  // The id MUST match /^[a-f0-9]{32}$/: src/routes/app-icons.js rejects
  // anything else with a 404 BEFORE it queries, so a readable id like
  // 'stagingdemocardicon01' inserts fine, is handed to the client as an
  // icon_url fine, and then 404s on every screen that renders the app
  // list — which is a console error on nearly every route.
  const ICON_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAYAAAByDd+UAAAAg0lEQVR42r3NuRGAMAwEQNdFbXRAIVRHAyQwDmB4/MjS3QUbb5qn7VBKymxddl2YM1l4ZZLwmdHDb0YNSxktrGWUsJXBw14GDS0ZLLRmkHAkC4ejWSj0ZO7Qm7nCSDYcRrOhEJGZQ1RmCpFZN0RnzZCRVUNWVgyZ2S9kZ69Qkd2hKstOLPva44BQr+EAAAAASUVORK5CYII=',
    'base64'
  );

  const APPS = [
    { id: 900201, slug: 'staging-demo-card-image',  name: 'Staging demo app — image icon',
      iconId: 'facade00facade00facade00facade01', emoji: null,  anonShell: 'public' },
    { id: 900202, slug: 'staging-demo-card-emoji',  name: 'Staging demo app — emoji icon',
      iconId: null, emoji: '🧩', anonShell: 'public' },
    { id: 900203, slug: 'staging-demo-card-gated',  name: 'Staging demo app — account required',
      iconId: null, emoji: null,  anonShell: 'gated' },
    { id: 900204, slug: 'staging-demo-card-letter', name: 'Staging demo app — letter tile',
      iconId: null, emoji: null,  anonShell: 'public' },
  ];

  try {
    const { rows: ownerRows } = await pool.query(
      'SELECT id FROM users WHERE username = $1', ['staging-demo-user']
    );
    const ownerId = ownerRows[0]?.id;
    if (!ownerId) {
      log.warn('db', 'Staging browse-card fixtures skipped: staging-demo-user missing');
      return;
    }

    for (const app of APPS) {
      await pool.query(
        `INSERT INTO apps
           (id, name, slug, status, view_visibility, created_by,
            icon_emoji, last_deploy_at, anon_shell, anon_shell_checked_at)
         VALUES ($1, $2, $3, 'running', 'public', $4, $5,
                 NOW() - INTERVAL '1 day', $6, NOW() + INTERVAL '1 year')
         ON CONFLICT (id) DO NOTHING`,
        [app.id, app.name, app.slug, ownerId, app.emoji, app.anonShell]
      );
      // Re-stamp for the same reason the landing fixtures do: ON CONFLICT
      // skips a row an earlier boot created, and the probe may have
      // reclassified it since.
      await pool.query(
        `UPDATE apps SET anon_shell = $2, anon_shell_checked_at = NOW() + INTERVAL '1 year'
          WHERE id = $1`,
        [app.id, app.anonShell]
      );
      if (!app.iconId) continue;
      // app_icons.app_id is UNIQUE — one icon per app — so an icon this seed
      // wrote under a DIFFERENT id on an earlier boot blocks the insert below
      // and takes the whole seed down with it. Staging's database outlives its
      // deploys, so that is the ordinary case whenever the id changes, not a
      // hypothetical.
      await pool.query(
        'DELETE FROM app_icons WHERE app_id = $1 AND id <> $2', [app.id, app.iconId]
      );
      await pool.query(
        `INSERT INTO app_icons (id, app_id, content_type, data, sha256)
         VALUES ($1, $2, 'image/png', $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [app.iconId, app.id, ICON_PNG,
          crypto.createHash('sha256').update(ICON_PNG).digest('hex')]
      );
      await pool.query(
        'UPDATE apps SET icon_image_id = $2 WHERE id = $1', [app.id, app.iconId]
      );
    }

    // The same viewer set seedStagingYourApps grants to: the interactive
    // admin login plus the two capture identities, so the fixtures are in
    // the before/after screenshots and in the declared dapp.json checks.
    const { rows: viewerRows } = await pool.query(
      'SELECT id FROM users WHERE username = ANY($1::text[])',
      [[config.adminUsername, 'usernode-capture', 'usernode-capture-admin']]
    );
    for (const { id: viewerId } of viewerRows) {
      for (const app of APPS) {
        await pool.query(
          `INSERT INTO app_favorites (app_id, user_id, sort_order)
           SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM apps WHERE id = $1)
           ON CONFLICT (app_id, user_id) DO NOTHING`,
          [app.id, viewerId, 10 + APPS.indexOf(app)]
        );
      }
      // Gap 2: the collaborator arm of the Invites card. Status 'invited'
      // grants no access — it is exactly the pending row the card offers
      // Accept / Decline on — and the notification beside it is the badge
      // bump plus the history entry, matching how seedStagingNotifications
      // pairs the two for the approver arm.
      await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, invited_by)
         VALUES (900201, $1, 'invited', $2)
         ON CONFLICT (app_id, user_id) DO NOTHING`,
        [viewerId, ownerId]
      );
      await pool.query(
        `INSERT INTO notifications
           (user_id, app_id, source_user_id, kind, created_at)
         SELECT $1, 900201, $2, 'collab_invite', NOW() - INTERVAL '2 minutes'
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications
             WHERE user_id = $1 AND app_id = 900201 AND kind = 'collab_invite')`,
        [viewerId, ownerId]
      );
    }
    log.info('db', 'Staging browse-card fixtures seeded', { viewers: viewerRows.length });
  } catch (err) {
    log.warn('db', 'Staging browse-card seeding failed', { message: err.message });
  }
}

// Sort signals for the #apps directory's Sort control (#1383).
//
// `chat_sessions` is `staging:private` — the clone gets the SCHEMA and none
// of the rows — so merged-proposal counts are ZERO for every app in every
// preview, on which four of the five orders are indistinguishable from each
// other and from the fifth. The declared checks and the before/after captures
// would all be shot against a list nothing had ranked.
//
// So this gives the four browse-card fixture apps (900201-900204, from
// seedStagingBrowseCardBranches) four deliberately DIFFERENT development
// histories, and stamps their ages to match:
//
//   900201  image   the workhorse       — most merged in 30d, 2nd newest
//   900202  emoji   deep but dormant    — most merged all-time, nothing recent
//   900203  gated   brand new and busy  — newest, a couple of fresh merges
//   900204  letter  neither             — old, quiet, never merged anything
//
// which puts a different row on top under every order. The rows carry an
// EXPLICIT merged_at: it was added by a later ALTER TABLE, so the older
// seedStagingMergedPrs fixtures leave it NULL and /api/apps has to
// COALESCE to created_at — this fixture exercises the populated arm.
//
// Fake identities only (owned by staging-demo-user, never the viewer),
// idempotent on (app_id, branch_name), try/catch so a fixture bug can't
// block boot, strict no-op outside staging.
async function seedStagingAppSortSignals(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  // hoursAgo per merged proposal; the app's own age and last deploy beside it.
  const PROFILES = [
    {
      appId: 900201, createdDaysAgo: 200, deployedDaysAgo: 1,
      merged: [2, 30, 5 * 24, 11 * 24, 19 * 24, 27 * 24, 120 * 24, 150 * 24, 190 * 24],
    },
    {
      appId: 900202, createdDaysAgo: 400, deployedDaysAgo: 60,
      merged: [60, 95, 130, 170, 200, 240, 275, 300, 320, 340, 355, 365, 372, 380]
        .map((d) => d * 24),
    },
    { appId: 900203, createdDaysAgo: 2, deployedDaysAgo: 0, merged: [6, 30] },
    { appId: 900204, createdDaysAgo: 300, deployedDaysAgo: 250, merged: [] },
  ];

  try {
    const { rows: ownerRows } = await pool.query(
      'SELECT id FROM users WHERE username = $1', ['staging-demo-user']
    );
    const ownerId = ownerRows[0]?.id;
    if (!ownerId) {
      log.warn('db', 'Staging sort-signal fixtures skipped: staging-demo-user missing');
      return;
    }

    let inserted = 0;
    for (const p of PROFILES) {
      // The fixture apps are all created within milliseconds of each other on
      // the boot that first seeds them, so "Newest" could not tell them apart
      // without this. Re-stamped every boot (rather than ON CONFLICT skipped)
      // so the ages stay relative to now, the way the browse-card seed
      // re-stamps anon_shell for its own reason.
      const { rowCount } = await pool.query(
        `UPDATE apps
            SET created_at = NOW() - ($2::int * INTERVAL '1 day'),
                last_deploy_at = NOW() - ($3::int * INTERVAL '1 day')
          WHERE id = $1`,
        [p.appId, p.createdDaysAgo, p.deployedDaysAgo]
      );
      if (!rowCount) continue; // browse-card fixtures absent — nothing to rank

      for (let i = 0; i < p.merged.length; i++) {
        const hoursAgo = p.merged[i];
        const branch = `staging-fixture/sort-signal-${p.appId}-${i + 1}`;
        const { rows: existing } = await pool.query(
          'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
          [p.appId, branch]
        );
        if (existing.length) continue;
        await pool.query(
          `INSERT INTO chat_sessions
             (app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md,
              status, votes_required, created_at, merged_at)
           VALUES
             ($1, $2, $3, $4, $5, $6, 'merged', 1,
              NOW() - ($7::int * INTERVAL '1 hour'),
              NOW() - ($7::int * INTERVAL '1 hour'))`,
          [p.appId, ownerId, branch, 9300 + (p.appId - 900200) * 20 + i,
            `[staging fixture] Accepted community change ${i + 1}`,
            'In plain terms: a completed change the community voted in.',
            hoursAgo]
        );
        inserted++;
      }
    }
    log.info('db', 'Staging app sort-signal fixtures seeded', { inserted });
  } catch (err) {
    log.warn('db', 'Staging sort-signal seeding failed', { message: err.message });
  }
}

// Free-form home-screen layouts. `user_home_layout` is created by this
// change, so it does NOT exist in the production database a staging clone
// starts from — every PR preview would render the DERIVED default, which is
// byte-for-byte today's flow arrangement, and the whole feature would be
// invisible to a reviewer.
//
// The seeded layouts are deliberately HOLE-BEARING: gaps in row 0 and row 3
// at both widths. Those gaps ARE the feature — an arrangement no ordering
// can express — so a before/after screenshot that doesn't show one has
// nothing to say. Chess Arena sits alone in the top-left with empty cells
// beside it and Pixel Racer alone at the far end of the same row.
//
// The `create` widget is seeded for every identity UNCONDITIONALLY, matching
// the rule that it is on every home screen regardless of app quota. That
// includes staging-demo-quota-zero (900021, seeded by
// seedStagingAppQuotaUsers), whose home screen shows the DISABLED variant —
// though nobody can sign in as it (sentinel password), so the reviewable
// path for that state is the ?shot=create-disabled deep link, not this row.
//
// Idempotent: skipped per user when they already have any layout row, so a
// reviewer's own drags survive the container rebuild on the next push.
async function seedStagingHomeLayout(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  // slug → cell, per column count. Widgets are `widget:<key>`.
  const LAYOUT_5 = [
    ['app:staging-demo-chess-arena', 0, 0],
    ['app:staging-demo-pixel-racer', 4, 0],
    ['widget:discover', 0, 1],
    ['widget:challenges', 3, 1],
    ['app:staging-demo-puzzle-chain', 0, 3],
    ['app:staging-demo-word-garden', 3, 3],
    ['widget:create', 4, 4],
  ];
  const LAYOUT_4 = [
    ['app:staging-demo-chess-arena', 0, 0],
    ['app:staging-demo-pixel-racer', 3, 0],
    ['widget:discover', 0, 1],
    ['app:staging-demo-puzzle-chain', 0, 3],
    ['app:staging-demo-word-garden', 3, 3],
    ['widget:challenges', 0, 4],
    ['widget:create', 3, 6],
  ];

  try {
    const cells = [[5, LAYOUT_5], [4, LAYOUT_4]].flatMap(([cols, layout]) =>
      layout.map(([id, col, row]) => ({
        cols, item_type: id.startsWith('widget:') ? 'widget' : 'app',
        item_key: id.slice(id.indexOf(':') + 1), grid_col: col, grid_row: row,
      })));
    const { rows: inserted } = await pool.query(
      `INSERT INTO user_home_layout (user_id, cols, item_type, widget_key, app_id, grid_col, grid_row)
       SELECT u.id, cell.cols, cell.item_type,
              CASE WHEN cell.item_type = 'widget' THEN cell.item_key END,
              a.id, cell.grid_col, cell.grid_row
         FROM users u
         CROSS JOIN jsonb_to_recordset($2::jsonb)
           AS cell(cols int, item_type text, item_key text, grid_col int, grid_row int)
         LEFT JOIN apps a ON cell.item_type = 'app' AND a.slug = cell.item_key
        WHERE u.username = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM user_home_layout existing WHERE existing.user_id = u.id)
          AND (cell.item_type = 'widget' OR a.id IS NOT NULL)
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
      [[config.adminUsername, 'usernode-capture', 'usernode-capture-admin', 'staging-demo-quota-zero'],
        JSON.stringify(cells)]
    );
    log.info('db', 'Staging home layouts seeded', { viewers: new Set(inserted.map(row => row.user_id)).size });
  } catch (err) {
    log.warn('db', 'Staging home-layout seeding failed', { message: err.message });
  }
}

// Home screen's Discover row + the #admin/featured-apps section. Append the
// synthetic apps created by seedStagingYourApps, even when the clone already
// has a featured list: those real apps may not have working reviews yet.
// Preserve their ordering and review state. Only the synthetic fixtures are
// certified here, and ON CONFLICT keeps their positions on subsequent boots.
//
// Chess Arena is deliberately NOT a candidate: seedStagingYourApps
// favorites it for every capture identity, so leaving it out exercises the
// "already in Your apps → left out of the featured row" branch. The browse
// screen still lists it, with a ✓ badge.
//
// created_by is NULL — seeds must never reference real users.
// Strictly a no-op outside staging.
async function seedStagingFeaturedApps(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    // #1523: explicitly synthetic fixtures for captures and the reversible
    // Discover-add check. Never certify a production-cloned app as tested.
    await pool.query(
      `UPDATE apps SET icon_emoji = '🧩',
         main_sha = '0000000000000000000000000000000000000001',
         directory_review_status = 'working', directory_reviewed_at = NOW(),
         directory_reviewed_sha = '0000000000000000000000000000000000000001'
       WHERE slug IN ('staging-demo-puzzle-chain', 'staging-demo-word-garden',
                      'staging-demo-pixel-racer')
         AND created_by = (SELECT id FROM users WHERE username = 'staging-demo-user')
         AND directory_review_status = 'unreviewed'`
    );
    const { rows: candidates } = await pool.query(
      `SELECT id FROM apps
        WHERE slug IN ('staging-demo-puzzle-chain', 'staging-demo-word-garden',
                       'staging-demo-pixel-racer')
          AND created_by = (SELECT id FROM users WHERE username = 'staging-demo-user')
          AND directory_review_status = 'working'
        ORDER BY id ASC`
    );
    for (const candidate of candidates) {
      // ON CONFLICT keeps this idempotent across the per-push container
      // rebuilds that re-run this whole file.
      await pool.query(
        `INSERT INTO featured_apps (app_id, sort_order, created_by)
         SELECT $1, COALESCE(MAX(sort_order), -1) + 1, NULL FROM featured_apps
         ON CONFLICT (app_id) DO NOTHING`,
        [candidate.id]
      );
    }
    log.info('db', 'Staging featured-apps fixtures seeded', { rows: candidates.length });
  } catch (err) {
    log.warn('db', 'Staging featured-apps seeding failed', { message: err.message });
  }
}

// Per-user app-quota fixtures. The admin Users list is a data-dependent
// rows UI, so staging needs users spanning the quota states to exercise
// the inline quota edit, the "N used" indicator, and the bulk "Set all"
// button. We guarantee three states:
//   - AT quota   → reuse staging-demo-user (900001), who already owns the
//                  demo app (900001) from seedStagingDemoAppCard above:
//                  quota 1 with 1 live app = at the limit (create blocked,
//                  affordance hidden).
//   - CAN create → a fresh fixture user with quota 5 and 0 apps.
//   - CANNOT     → a fresh fixture user with quota 0 and 0 apps.
// Obviously-fake usernames + non-login passwords; fixed high ids + explicit
// quota writes make it idempotent, and the whole thing is a strict no-op
// outside staging.
async function seedStagingAppQuotaUsers(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    // CAN-create and CANNOT-create fixture users. Sentinel passwords mean
    // these accounts can never log in interactively. The third account has a
    // deliberately long username (#424 follow-up) so the admin Users list's
    // full-username rendering (no ellipsis, wraps cleanly) is verifiable in a
    // staging preview — cloned prod usernames may all be short.
    await pool.query(
      `INSERT INTO users (id, username, password, app_quota)
       VALUES
         (900020, 'staging-demo-quota-ok',   '!staging-fixture-no-login!', 5),
         (900021, 'staging-demo-quota-zero', '!staging-fixture-no-login!', 0),
         (900024, 'staging-demo-very-long-username-overflow-check-0000000000', '!staging-fixture-no-login!', 3)
       ON CONFLICT (id) DO NOTHING`
    );

    // Pin the quotas explicitly so reboots keep the intended states even if a
    // tester edited them, and so staging-demo-user lands "at limit" (quota 1,
    // owns the 1 live demo app from seedStagingDemoAppCard).
    await pool.query('UPDATE users SET app_quota = 1 WHERE id = 900001');
    await pool.query('UPDATE users SET app_quota = 5 WHERE id = 900020');
    await pool.query('UPDATE users SET app_quota = 0 WHERE id = 900021');
    await pool.query('UPDATE users SET app_quota = 3 WHERE id = 900024');

    log.info('db', 'Staging app-quota fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging app-quota fixtures seeding failed', { message: err.message });
  }
}

// View-only admin role fixtures (issue #311). The admin user list and its
// three-way role selector are row-rendering, data-dependent UI. Staging
// clones preserve prod `users` rows, but prod may contain NO view-only
// admin, so the new read-only treatment and the third selector option
// wouldn't be demonstrable. Seed one obviously-fake account as a view-only
// admin (is_admin = TRUE, admin_readonly = TRUE) so a staging reviewer sees
// the three roles side-by-side in /admin. The existing seeded admin stays a
// FULL admin (untouched), preserving the last-full-admin invariant. Strict
// no-op outside staging; idempotent via fixed id + ON CONFLICT and a pinned
// UPDATE on reboot.
async function seedStagingViewOnlyAdmin(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    // Sentinel password means this account can never log in interactively.
    await pool.query(
      `INSERT INTO users (id, username, password, is_admin, admin_readonly)
       VALUES (900030, 'staging-demo-view-admin', '!staging-fixture-no-login!', TRUE, TRUE)
       ON CONFLICT (id) DO NOTHING`
    );
    // Pin the role explicitly so a reboot (or a tester flipping it) restores
    // the intended view-only state.
    await pool.query(
      'UPDATE users SET is_admin = TRUE, admin_readonly = TRUE WHERE id = 900030'
    );

    log.info('db', 'Staging view-only admin fixture seeded');
  } catch (err) {
    log.warn('db', 'Staging view-only admin fixture seeding failed', { message: err.message });
  }
}

// Linked-wallet fixtures (issue #422). The admin Users list now shows each
// user's linked Homeroom wallet and lets a full admin edit it inline. The
// wallet column (users.usernode_pubkey) is NOT staging-scrubbed, so cloned
// prod rows keep their addresses — but to demonstrate every path
// deterministically (display, the "none" placeholder, and the
// already-linked 409 + reassign flow) we seed an obviously-fake pair: one
// account WITH a wallet and one WITHOUT. A reviewer can then type the
// linked account's address into the unlinked one to trigger the reassign
// confirmation. Sentinel passwords mean neither can log in interactively.
// Idempotent via fixed ids + ON CONFLICT and pinned UPDATEs on reboot;
// strict no-op outside staging.
async function seedStagingWalletUsers(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (id, username, password, usernode_pubkey)
       VALUES
         (900022, 'staging-demo-wallet-linked', '!staging-fixture-no-login!', 'ut1stagingdemowalletlinked000000000000001'),
         (900023, 'staging-demo-wallet-none',   '!staging-fixture-no-login!', NULL)
       ON CONFLICT (id) DO NOTHING`
    );
    // Pin the wallet states explicitly so a reboot (or a tester editing
    // them) restores the intended linked / unlinked pair.
    await pool.query(
      `UPDATE users SET usernode_pubkey = 'ut1stagingdemowalletlinked000000000000001'
       WHERE id = 900022`
    );
    await pool.query('UPDATE users SET usernode_pubkey = NULL WHERE id = 900023');

    log.info('db', 'Staging wallet fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging wallet fixtures seeding failed', { message: err.message });
  }
}

// Fixtures for the public read-only apps + contributors API
// (src/routes/public-api.js, GET /api/public/apps). The endpoint lists
// view-public apps with an embedded contributor list (creator + accepted
// members + merged-PR authors). `apps`, `users`, and `app_collaborators`
// are NOT staging:private (they survive cloning), but `chat_sessions` IS
// (schema-only, always empty in a clone), so the merged-PR contributor
// branch has nothing to surface without seeding. Seed a self-contained set
// in the 9007x id range so the route can be exercised deterministically:
//   - 3 obviously-fake users: a creator + member with linked wallets, and a
//     merged-PR author with NO wallet (so the null-address path shows).
//   - 2 view-public apps, one collab-public and one collab-private, so both
//     "build" visibility statuses appear in the list (both are listed,
//     since only VIEW visibility gates listing).
//   - app_collaborators member rows + a merged chat_sessions row, so the
//     contributor union spans all three sources (and the merged author is
//     NOT a member — proving the union goes beyond membership).
// Idempotent via fixed ids + ON CONFLICT DO NOTHING; sentinel passwords mean
// none can log in; strict no-op outside staging.
async function seedStagingPublicApiContributors(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (id, username, password, usernode_pubkey)
       VALUES
         (900070, 'staging-demo-api-creator', '!staging-fixture-no-login!', 'ut1stagingdemoapicreator0000000000000001'),
         (900071, 'staging-demo-api-merger',  '!staging-fixture-no-login!', NULL),
         (900072, 'staging-demo-api-member',  '!staging-fixture-no-login!', 'ut1stagingdemoapimember00000000000000001')
       ON CONFLICT (id) DO NOTHING`
    );
    // Two view-public apps: one anyone can build (collab public), one
    // invite-only to build (collab private). Both appear in the public list
    // because only view_visibility gates listing.
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES
         (900070, 'Staging demo public API app', 'staging-demo-public-api-app', 'running',
          'public',  'public', 900070),
         (900071, 'Staging demo collab-private app', 'staging-demo-public-api-collab-private', 'running',
          'private', 'public', 900070)
       ON CONFLICT (id) DO NOTHING`
    );
    // Members: creator is a member of both (the creator-always-a-member
    // invariant); the extra member joins the collab-public app.
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
       VALUES
         (900070, 900070, 'member', 900070, NOW()),
         (900070, 900072, 'member', 900070, NOW()),
         (900071, 900070, 'member', 900070, NOW())
       ON CONFLICT (app_id, user_id) DO NOTHING`
    );
    // A merged proposal authored by the merger, who is NOT a member — so it
    // surfaces ONLY via the merged-PR branch of the contributor union.
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status, merged_at)
       VALUES
         (900070, 900070, 900071, 'staging-demo/public-api-merged-pr', 900070,
          'Staging demo merged PR — public API contributor', 'merged', NOW())
       ON CONFLICT (id) DO NOTHING`
    );
    log.info('db', 'Staging public-api contributor fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging public-api contributor seeding failed', { message: err.message });
  }
}

// (#270) Fixtures for the multi-route before/after gallery. The grouped
// gallery renders one labelled before/after row per captured route, but
// session_visuals is staging:private (schema-only in staging, always
// empty) so without seeding every proposal's "Show before/after" panel is
// blank in a staging preview. Attaches to the promoted demo session
// (900001) seeded by seedStagingDemoAppCard above — so it shows up on the
// Staging demo app's proposals/vote panel — with TWO capture groups
// (capture_index 0 -> '/', 1 -> '/board'), each carrying a before.png +
// after.png so the grouped gallery renders multiple labelled rows. Tiny
// 1x1 inline PNG bytes are enough — the test is layout, not content.
// Idempotent via fixed 32-hex ids + ON CONFLICT DO NOTHING, obviously
// fake, and a strict no-op outside staging.
async function seedStagingVisuals(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  // 1x1 transparent PNG — valid image bytes for the <img>/embed surfaces
  // and the <video> poster.
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  // Tiny placeholder webm: enough to exercise the comparison overlay's
  // <video> branch (#353). It isn't a decodable clip — the point is that
  // the renderer picks the webm and falls back to the PNG poster — so QA
  // can confirm the video tile/column renders without a real recording.
  const WEBM_PLACEHOLDER = Buffer.from(
    'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAAR',
    'base64'
  );
  const CT = { png: 'image/png', webm: 'video/webm', gif: 'image/gif' };
  const DEMO_SESSION_ID = 900001;
  // 32-hex ids (match the /^[a-f0-9]{32}$/ token the renderers validate).
  // Group 2 (#353) uses a self-app hash deep-link path so the captured
  // path label + the hash-route normalisation are visible/testable in
  // staging, and carries a webm (+ PNG poster) per side so the comparison
  // overlay's video branch is exercised too.
  const SELF_APP_DEEP_PATH = '/app/social-vibecoding/dev/proposals/900301';
  // Group 3 (#768) re-captures '/board' with captured_viewport 'mobile' so
  // the "(mobile)" group label is visible/testable in staging.
  // Group 1's before row carries before_fell_back so the '"Before" shows
  // the home page' caption is visible/testable; group 4 is after-only so
  // the 'New page — no production version to compare' caption renders.
  const rows = [
    { id: 'a'.repeat(32), kind: 'before', media: 'png',  idx: 0, path: '/' },
    { id: 'b'.repeat(32), kind: 'after',  media: 'png',  idx: 0, path: '/' },
    { id: 'c'.repeat(32), kind: 'before', media: 'png',  idx: 1, path: '/board', fellBack: true },
    { id: 'd'.repeat(32), kind: 'after',  media: 'png',  idx: 1, path: '/board' },
    { id: 'e'.repeat(32), kind: 'before', media: 'png',  idx: 2, path: SELF_APP_DEEP_PATH },
    { id: 'f'.repeat(32), kind: 'before', media: 'webm', idx: 2, path: SELF_APP_DEEP_PATH },
    { id: '0'.repeat(32), kind: 'after',  media: 'png',  idx: 2, path: SELF_APP_DEEP_PATH },
    { id: '1'.repeat(32), kind: 'after',  media: 'webm', idx: 2, path: SELF_APP_DEEP_PATH },
    { id: '2'.repeat(32), kind: 'before', media: 'png',  idx: 3, path: '/board', viewport: 'mobile' },
    { id: '3'.repeat(32), kind: 'after',  media: 'png',  idx: 3, path: '/board', viewport: 'mobile' },
    { id: '4'.repeat(32), kind: 'after',  media: 'png',  idx: 4, path: '/settings' },
  ];

  try {
    // Point the demo session's testing_paths at the captured routes so the
    // persisted annotation matches the seeded capture groups. Mixes the
    // legacy string form with the #768 { path, viewport } object form so
    // the stored-row back-compat path stays exercised in staging.
    await pool.query(
      `UPDATE chat_sessions SET testing_paths = $1::jsonb
         WHERE id = $2 AND testing_paths IS NULL`,
      [JSON.stringify(['/', '/board', SELF_APP_DEEP_PATH, { path: '/board', viewport: 'mobile' }]), DEMO_SESSION_ID]
    );
    for (const r of rows) {
      const data = r.media === 'webm' ? WEBM_PLACEHOLDER : PNG_1X1;
      await pool.query(
        `INSERT INTO session_visuals
           (id, session_id, commit_hash, kind, media, content_type, data, captured_path, capture_index, captured_viewport, before_fell_back)
         SELECT $1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10
          WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $2)
         ON CONFLICT (id) DO NOTHING`,
        [r.id, DEMO_SESSION_ID, r.kind, r.media, CT[r.media], data, r.path, r.idx, r.viewport || null, !!r.fellBack]
      );
    }
    // Give the promoted demo session a 'partial' capture outcome so the
    // proposal card's capture-state surfaces render against it (its group 1
    // before row is a fell-back shot and group 4 is after-only).
    await pool.query(
      `UPDATE chat_sessions
          SET capture_state = 'partial',
              capture_detail = $1::jsonb,
              captured_at = NOW()
        WHERE id = $2 AND capture_state IS NULL`,
      [JSON.stringify({
        media: true,
        pathDefaulted: false,
        prodRunning: true,
        paths: ['/', '/board', SELF_APP_DEEP_PATH],
        failures: [{ kind: 'after', media: 'webm', reason: 'Staging demo — screencast failed' }],
        droppedOverCap: [],
        beforeFellBack: [1],
        reason: 'Staging demo — one recording failed, stills stored',
      }), DEMO_SESSION_ID]
    );
    log.info('db', 'Staging multi-path visuals fixtures seeded', { sessionId: DEMO_SESSION_ID });
  } catch (err) {
    log.warn('db', 'Staging visuals seeding failed', { message: err.message });
  }

  await seedStagingGalleryProposals(pool);
}

// Fixtures for the admin before/after gallery (/gallery). The gallery lists
// MERGED proposals with a non-null merged_at, so the promoted demo session
// above never appears there — and session_visuals is staging:private (always
// empty in staging), so without this the page renders "no merged proposals"
// in every preview.
//
// Seeds four merged demo proposals across TWO OWN apps (so the app filter has
// something to switch between), spread over several days of merged_at so the
// newest-first ordering and the keyset cursor are both genuinely exercised,
// and between them covering every problem filter and every capture-state
// chip the page renders:
//   900101  complete desktop + mobile pair set        → 'captured'
//   900102  stills only, no recording                 → 'partial'  (missing_recording)
//   900103  after-only at the root, before fell back  → 'partial'  (missing_before + root_only + before_fell_back)
//   900104  no artifacts at all                       → 'console_only' (failed_or_skipped)
// Idempotent via fixed ids + ON CONFLICT DO NOTHING, obviously fake, and a
// strict no-op outside staging.
//
// Owner resolution: the canonical fake user 'staging-demo-user' is created
// earlier with a SERIAL id, so its id is NOT predictable — the older fixtures
// that assume it lands on 900001 silently lose their INSERT to the username
// unique index and then fail their apps FK. This seed therefore resolves the
// owner by USERNAME in the insert itself and creates its own apps, so it
// stands up regardless of what id that user got.
async function seedStagingGalleryProposals(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const WEBM_PLACEHOLDER = Buffer.from(
    'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAAR',
    'base64'
  );
  const CT = { png: 'image/png', webm: 'video/webm', gif: 'image/gif' };
  // Own apps (ids outside every existing fixture's range) so the gallery
  // stands up independently of the older demo-app fixtures.
  const DEMO_APP_ID = 900106;
  const DEMO_APP_2_ID = 900107;
  const OWNER_USERNAME = 'staging-demo-user';

  // id, day offset (older = larger), title, capture_state, detail, artifacts
  const proposals = [
    {
      id: 900101, appId: DEMO_APP_ID, pr: 900101, days: 1,
      title: 'Staging demo — complete before/after set',
      state: 'captured',
      detail: { media: true, pathDefaulted: false, prodRunning: true, paths: ['/board'], failures: [], droppedOverCap: [], beforeFellBack: [] },
      paths: [{ path: '/board', viewport: null }, { path: '/board', viewport: 'mobile' }],
      artifacts: [
        { kind: 'before', media: 'png', idx: 0, path: '/board' },
        { kind: 'before', media: 'webm', idx: 0, path: '/board' },
        { kind: 'after', media: 'png', idx: 0, path: '/board' },
        { kind: 'after', media: 'webm', idx: 0, path: '/board' },
        { kind: 'before', media: 'png', idx: 1, path: '/board', viewport: 'mobile' },
        { kind: 'after', media: 'png', idx: 1, path: '/board', viewport: 'mobile' },
      ],
    },
    {
      id: 900102, appId: DEMO_APP_ID, pr: 900102, days: 3,
      title: 'Staging demo — stills only, recording failed',
      state: 'partial',
      detail: {
        media: true, pathDefaulted: false, prodRunning: true, paths: ['/settings'],
        failures: [{ kind: 'after', media: 'webm', reason: 'Staging demo — over-cap 9000000 bytes' }],
        droppedOverCap: [{ kind: 'after', media: 'webm', index: 0, bytes: 9000000 }],
        beforeFellBack: [],
        reason: 'Staging demo — recording exceeded the size cap',
      },
      paths: [{ path: '/settings', viewport: null }],
      artifacts: [
        { kind: 'before', media: 'png', idx: 0, path: '/settings' },
        { kind: 'after', media: 'png', idx: 0, path: '/settings' },
      ],
    },
    {
      id: 900103, appId: DEMO_APP_2_ID, pr: 900103, days: 5,
      title: 'Staging demo — new page, before fell back to home',
      state: 'partial',
      detail: {
        media: true, pathDefaulted: true, prodRunning: true, paths: ['/'],
        failures: [], droppedOverCap: [], beforeFellBack: [0],
        reason: 'Staging demo — no testing path emitted, shot the front page',
      },
      paths: [{ path: '/', viewport: null }],
      artifacts: [
        // A fell-back before on group 0, and an after-only group 1 so both
        // honest captions render on one card.
        { kind: 'before', media: 'png', idx: 0, path: '/', fellBack: true },
        { kind: 'after', media: 'png', idx: 0, path: '/' },
        { kind: 'after', media: 'png', idx: 1, path: '/' },
      ],
    },
    {
      // No "before" rows AT ALL — the missing_before filter is session-level,
      // so a proposal that merely has one after-only GROUP doesn't match it.
      id: 900105, appId: DEMO_APP_2_ID, pr: 900105, days: 6,
      title: 'Staging demo — brand new page, no production version',
      state: 'partial',
      detail: {
        media: true, pathDefaulted: false, prodRunning: false, paths: ['/whats-new'],
        failures: [], droppedOverCap: [], beforeFellBack: [],
        reason: 'Staging demo — production container was not running, no "before" leg',
      },
      paths: [{ path: '/whats-new', viewport: null }],
      artifacts: [
        { kind: 'after', media: 'png', idx: 0, path: '/whats-new' },
        { kind: 'after', media: 'png', idx: 1, path: '/whats-new', viewport: 'mobile' },
      ],
    },
    {
      id: 900104, appId: DEMO_APP_2_ID, pr: 900104, days: 7,
      title: 'Staging demo — backend-only change, no screenshots',
      state: 'console_only',
      detail: {
        media: false, pathDefaulted: false, prodRunning: true, paths: ['/'],
        failures: [], droppedOverCap: [], beforeFellBack: [],
        reason: 'No frontend files in commit range — console/tests-only run',
      },
      paths: [{ path: '/', viewport: null }],
      artifacts: [],
    },
  ];

  try {
    // Two own apps so the gallery's app filter has something to switch
    // between. created_by resolves the fake owner by USERNAME (see above) —
    // the SELECT yields no row if that user somehow doesn't exist, which
    // makes this a clean no-op instead of an FK error.
    for (const [id, name, slug] of [
      [DEMO_APP_ID, 'Staging demo gallery app', 'staging-demo-gallery-app'],
      [DEMO_APP_2_ID, 'Staging demo gallery app two', 'staging-demo-gallery-app-two'],
    ]) {
      // status 'awaiting_secrets', NOT 'running': these apps have no
      // container, and services/app-heal.js sweeps every status='running'
      // app every 60s — leaving them 'running' makes it log a heal ERROR
      // per app per minute for the life of the staging preview. The gallery
      // only needs the row to exist for its JOIN, so an inert status is
      // strictly better here.
      await pool.query(
        `INSERT INTO apps (id, name, slug, status, view_visibility, created_by)
         SELECT $1, $2, $3, 'awaiting_secrets', 'public', u.id
           FROM users u WHERE u.username = $4
         ON CONFLICT DO NOTHING`,
        [id, name, slug, OWNER_USERNAME]
      );
    }

    for (const p of proposals) {
      await pool.query(
        `INSERT INTO chat_sessions
           (id, app_id, user_id, branch_name, pr_number, pr_title, status,
            promoted_at, merged_at, testing_paths, capture_state, capture_detail, captured_at)
         SELECT $1, $2, u.id, $3, $4, $5, 'merged',
                NOW() - ($6 || ' days')::interval - interval '1 hour',
                NOW() - ($6 || ' days')::interval,
                $7::jsonb, $8, $9::jsonb, NOW() - ($6 || ' days')::interval
           FROM users u
          WHERE u.username = $10
            AND EXISTS (SELECT 1 FROM apps WHERE id = $2)
         ON CONFLICT (id) DO NOTHING`,
        [p.id, p.appId, `staging-demo/gallery-${p.id}`, p.pr, p.title,
          String(p.days), JSON.stringify(p.paths), p.state, JSON.stringify(p.detail),
          OWNER_USERNAME]
      );

      for (let i = 0; i < p.artifacts.length; i++) {
        const a = p.artifacts[i];
        // Deterministic 32-hex id per (session, artifact) so the seed is
        // idempotent across container rebuilds.
        const id = (`${p.id}`.padStart(8, '0') + `${i}`.padStart(2, '0')).padEnd(32, 'a');
        await pool.query(
          `INSERT INTO session_visuals
             (id, session_id, commit_hash, kind, media, content_type, data,
              captured_path, capture_index, captured_viewport, shot_status, before_fell_back)
           SELECT $1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, 200, $10
            WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $2)
           ON CONFLICT (id) DO NOTHING`,
          [id, p.id, a.kind, a.media, CT[a.media],
            a.media === 'webm' ? WEBM_PLACEHOLDER : PNG_1X1,
            a.path, a.idx, a.viewport || null, !!a.fellBack]
        );
      }
    }
    log.info('db', 'Staging gallery fixtures seeded', { proposals: proposals.length });
  } catch (err) {
    log.warn('db', 'Staging gallery seeding failed', { message: err.message });
  }
}

// (#60) Fixtures for the leaderboard user-profile drill-in. The profile
// view lists a user's PROPOSED PRs (chat_sessions) with kudos counts
// (pr_kudos) — both staging:private tables, so without seeding the view
// is empty for every user in staging. Seeds two obviously-fake users
// (never reference real ones) at high fixed ids, a handful of sessions
// covering each status badge the view renders (merged / open / merging
// / closed), and kudos from the second user so counts are non-zero and
// @staging-demo-author ranks visibly on the Top users tab. Idempotent
// via ON CONFLICT DO NOTHING on the fixed ids; strictly a no-op outside
// staging.
async function seedStagingLeaderboardProfile(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    `SELECT id FROM apps WHERE view_visibility = 'public' ORDER BY id LIMIT 1`
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging leaderboard-profile fixtures skipped: no public app');
    return;
  }

  // Password is a non-bcrypt sentinel — these accounts can never log in.
  const AUTHOR_ID = 900001;
  const GIVER_ID = 900002;
  await pool.query(
    `INSERT INTO users (id, username, password)
     VALUES ($1, 'staging-demo-author', '!staging-fixture-no-login!'),
            ($2, 'staging-demo-giver',  '!staging-fixture-no-login!')
     ON CONFLICT DO NOTHING`,
    [AUTHOR_ID, GIVER_ID]
  );

  // One session per status the profile renders a badge for. created_at
  // is staggered so the newest-first ordering is visible; merged_at /
  // promoted_at follow what the real lifecycle would have written. The
  // archived row keeps promoted_at set — that's what makes it a CLOSED
  // PR (proposed, then abandoned) rather than a private draft, which
  // the profile endpoint excludes. pr_url present on the merged row so
  // the external GitHub icon renders on at least one fixture.
  const sessions = [
    { id: 9000201, pr: 900301, status: 'merged', hoursAgo: 6,
      title: '[Mock] Staging demo PR — merged: tidy profile chips',
      promoted: true, merged: true, url: true },
    { id: 9000202, pr: 900302, status: 'promoted', hoursAgo: 30,
      title: '[Mock] Staging demo PR — open for vote: dark-mode polish',
      promoted: true, merged: false, url: false },
    { id: 9000203, pr: 900303, status: 'merging', hoursAgo: 54,
      title: '[Mock] Staging demo PR — merging: debounce search box',
      promoted: true, merged: false, url: false },
    { id: 9000204, pr: 900304, status: 'archived', hoursAgo: 80,
      title: '[Mock] Staging demo PR — closed without merging',
      promoted: true, merged: false, url: false },
  ];
  for (const s of sessions) {
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, pr_url,
          status, created_at, promoted_at, merged_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8,
          NOW() - ($9::int * INTERVAL '1 hour'),
          CASE WHEN $10 THEN NOW() - ($9::int * INTERVAL '1 hour') END,
          CASE WHEN $11 THEN NOW() - (($9 - 1)::int * INTERVAL '1 hour') END)
       ON CONFLICT (id) DO NOTHING`,
      [s.id, appId, AUTHOR_ID, `staging-fixture/profile-pr-${s.id}`,
       s.pr, s.title,
       s.url ? `https://github.com/usernode-staging/demo/pull/${s.pr}` : null,
       s.status, s.hoursAgo, s.promoted, s.merged]
    );
  }

  // Kudos from the giver on the merged + open PRs: non-zero per-row
  // counts, and merged credit so the author scores on Top users.
  for (const sessionId of [9000201, 9000202]) {
    await pool.query(
      `INSERT INTO pr_kudos (session_id, giver_user_id, week_start, created_at)
       SELECT $1, $2, date_trunc('week', NOW() AT TIME ZONE 'UTC')::date, NOW()
        WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $1)
       ON CONFLICT (session_id, giver_user_id) DO NOTHING`,
      [sessionId, GIVER_ID]
    );
  }

  // Issues filed by the same two leaderboard users so the Top-users tab's
  // new "N issues" chip is non-zero and differs between rows. created_at
  // is a mix of this-week and older so the all-time and This-week windows
  // show different counts: author = 3 all-time / 2 this week, giver = 1 in
  // both. github_issue_number stays NULL (in-app proposals need no twin);
  // kind/status take their table defaults. Idempotent on the fixed ids.
  const demoIssues = [
    { id: 9003001, by: AUTHOR_ID, daysAgo: 1,
      title: '[Mock] Staging demo issue — persist dark-mode toggle' },
    { id: 9003002, by: AUTHOR_ID, daysAgo: 3,
      title: '[Mock] Staging demo issue — keyboard shortcut for voting' },
    { id: 9003003, by: AUTHOR_ID, daysAgo: 20,
      title: '[Mock] Staging demo issue — topic cards overflow on phones' },
    { id: 9003004, by: GIVER_ID, daysAgo: 2,
      title: '[Mock] Staging demo issue — debounce the search box' },
  ];
  for (const it of demoIssues) {
    await pool.query(
      `INSERT INTO issues (id, app_id, title, description, created_by, created_at)
       VALUES ($1, $2, $3,
               'Staging demo issue so the Top-users leaderboard issues chip has rows to count.',
               $4, NOW() - ($5::int * INTERVAL '1 day'))
       ON CONFLICT (id) DO NOTHING`,
      [it.id, appId, it.title, it.by, it.daysAgo]
    );
  }

  // app_activity so the Top-users "active on N apps" chip / the API's
  // active_apps field is non-empty and DIFFERS between the two fixture users.
  // "Active on an app" = ever >=60s in a day on it AND a visit within the last
  // 10 days (the active-users.js definition). We pick the first two public,
  // non-self-hosted apps:
  //   - author: qualifying (120s) + recent on BOTH apps → active_apps has 2.
  //   - giver:  qualifying + recent on the FIRST app, plus a recent-but-never-
  //             >=60s (30s) row on the second → that second app is correctly
  //             EXCLUDED, exercising the "ever-qualified" gate, not just presence.
  const { rows: activeAppRows } = await pool.query(
    `SELECT id FROM apps
       WHERE view_visibility = 'public' AND self_hosted = FALSE
       ORDER BY id LIMIT 2`
  );
  const appA = activeAppRows[0]?.id;
  const appB = activeAppRows[1]?.id;
  // Each (app_id, user_id, date) pair is unique; spread rows across distinct
  // recent dates so a same-day UNIQUE collision can't drop a qualifying row.
  const activityRows = [];
  if (appA) {
    activityRows.push({ appId: appA, userId: AUTHOR_ID, secs: 120, daysAgo: 1 });
    activityRows.push({ appId: appA, userId: GIVER_ID, secs: 120, daysAgo: 2 });
  }
  if (appB) {
    activityRows.push({ appId: appB, userId: AUTHOR_ID, secs: 120, daysAgo: 1 });
    // Recent but never >=60s → giver is NOT active on appB.
    activityRows.push({ appId: appB, userId: GIVER_ID, secs: 30, daysAgo: 2 });
  }
  for (const a of activityRows) {
    await pool.query(
      `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
       VALUES ($1, $2, $3, CURRENT_DATE - ($4::int))
       ON CONFLICT (app_id, user_id, date) DO NOTHING`,
      [a.appId, a.userId, a.secs, a.daysAgo]
    );
  }

  log.info('db', 'Staging leaderboard-profile fixtures seeded', { appId, appA, appB });
}

// LLM-spend fixtures for the admin dashboard's Daily-spend and
// Spend-by-builder charts. `llm_usage` is staging:private (copied
// schema-only → empty in staging), so without this both charts render
// "Not enough data yet." We attach 30 days of spend to a handful of
// existing seeded users, admins FIRST, so the "Include admin users"
// checkbox visibly changes the totals. Each user gets a distinct mix of
// platform-key spend (total_cost_cents) and user-key/BYOK spend
// (byok_cost_cents) so all three toggle modes — and the builder ranking
// per mode — differ. Idempotent via ON CONFLICT (user_id, date).
async function seedStagingLlmUsage(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: users } = await pool.query(
    `SELECT id, is_admin FROM users ORDER BY is_admin DESC, id ASC LIMIT 6`
  );
  if (!users.length) {
    log.warn('db', 'Staging llm_usage fixtures skipped: no users');
    return;
  }

  // Per-user spend profile. Cycle platform-only / byok-only / both so the
  // toggles tell different stories; platform base descends with index
  // while byok base ascends, so the two rankings genuinely disagree.
  const profiles = users.map((user, i) => ({
    user_id: user.id, ordinal: i,
    platform_base: i % 3 === 1 ? 0 : (users.length - i) * 6 + 4,
    byok_base: i % 3 === 0 ? 0 : (i + 1) * 5 + 3,
  }));
  await pool.query(
    `INSERT INTO llm_usage (user_id, date, total_cost_cents, byok_cost_cents)
     SELECT p.user_id, CURRENT_DATE - g,
            (p.platform_base * (0.5 + (g % 5) * 0.12))::numeric(10,4),
            (p.byok_base * (0.5 + ((g + 2) % 5) * 0.12))::numeric(10,4)
       FROM jsonb_to_recordset($1::jsonb) AS p(user_id int, ordinal int, platform_base numeric, byok_base numeric)
       CROSS JOIN generate_series(0, 29) g
      ORDER BY p.ordinal, g
     ON CONFLICT (user_id, date) DO NOTHING`,
    [JSON.stringify(profiles)]
  );

  log.info('db', 'Staging llm_usage fixtures seeded', { users: users.length });
}

// #1788: weekly-cap fixtures for the admin Users list and the Limits
// panel. Two facts make them necessary on a preview:
//   1. llm_usage is staging:private (schema-only clone → empty), so the
//      new "spent this week" figure on every user row would read $0.00
//      and a reviewer could not tell that from a broken query.
//   2. users.weekly_limit_cents is brand new, so no cloned row carries a
//      per-user weekly override and the new "Weekly $" control would only
//      ever show its blank "default" state.
// Two obviously-fake users cover the two interesting cap combinations —
// weekly-only (daily switched off with a 0) and weekly-off (a 0 weekly
// beside a live daily cap) — with week-to-date spend attached so the
// weekly figure is visibly larger than the daily one. Fixed ids +
// ON CONFLICT DO NOTHING, so re-running on every container boot is a
// no-op; strictly a no-op outside staging; fake identities only, never
// the account that opened the preview.
async function seedStagingWeeklyCaps(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    const fixtures = [
      // Daily off (0), weekly $12.50 — the weekly cap is the only ceiling.
      { id: 9300021, name: 'staging-demo-weekly-only', daily: 0, weekly: 1250 },
      // Weekly off (0), daily $20 — today's behaviour, stated explicitly.
      { id: 9300022, name: 'staging-demo-weekly-off', daily: 2000, weekly: 0 },
    ];

    for (const f of fixtures) {
      // Sentinel password → never an interactive login.
      await pool.query(
        `INSERT INTO users (id, username, password, daily_limit_cents, weekly_limit_cents)
         VALUES ($1, $2, '!staging-fixture-no-login!', $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [f.id, f.name, f.daily, f.weekly]
      );
      // Pin the caps on reboot so a tester who edits them in the console
      // gets the intended pair back on the next container build.
      await pool.query(
        'UPDATE users SET daily_limit_cents = $2, weekly_limit_cents = $3 WHERE id = $1',
        [f.id, f.daily, f.weekly]
      );
      // Week-to-date spend: one row per day since Monday, so the row's
      // "this week" figure is several times its "today" figure and the two
      // are visibly different numbers rather than the same one twice.
      await pool.query(
        `INSERT INTO llm_usage (user_id, date, total_cost_cents, byok_cost_cents)
         SELECT $1, d::date, 37.5, 0
           FROM generate_series(
                  date_trunc('week', CURRENT_DATE)::date,
                  CURRENT_DATE,
                  INTERVAL '1 day'
                ) d
         ON CONFLICT (user_id, date) DO NOTHING`,
        [f.id]
      );
    }

    log.info('db', 'Staging weekly-cap fixtures seeded', { users: fixtures.length });
  } catch (err) {
    log.warn('db', 'Staging weekly-cap seeding failed', { message: err.message });
  }
}

// Daily spend distribution fixtures (the seven-bucket stacked chart on
// /dashboard). The chart counts users per platform-spend bucket per day,
// with the $20+ tier split into "capped" (no usable own key) vs "kept going
// on own key". Two staging facts force a dedicated seed:
//   1. llm_usage is staging:private (schema-only clone → empty), so there is
//      no per-day spend to bucket at all without seeding it here.
//   2. users.anthropic_key_enc is a staging:private COLUMN (scrubbed to NULL
//      on clone), so the "has own key" branch would never populate from real
//      users — the $20+/own-key segment would always be empty.
// We create obviously-fake users (staging-demo-spend-*) at fixed high ids,
// give a subset a non-null anthropic_key_enc sentinel so the own-key branch
// lights up, and write 30 days of llm_usage spanning every bucket. A couple
// are is_admin so the "Include admin users" toggle visibly changes the bars.
// Idempotent (fixed ids + ON CONFLICT DO NOTHING); strict no-op outside
// staging; never references real users.
async function seedStagingSpendDistribution(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    // 10 fake users. `tier` decides the daily platform-spend band each lands
    // in; `key` marks who has a configured own key (drives the $20+ split);
    // two are admins. Spend is varied by day in SQL so the stacks shift.
    //   tier 0 → no spend (stays in the $0 bucket)
    //   tier 1 → $0.01–$5     tier 2 → $5–$10     tier 3 → $10–$15
    //   tier 4 → $15–$19.99
    //   tier 5 → $20+ (capped — no own key)
    //   tier 6 → $20+ (own key)
    const fixtures = [
      { id: 9300001, name: 'staging-demo-spend-zero-a',   tier: 0, key: false, admin: false },
      { id: 9300002, name: 'staging-demo-spend-zero-b',   tier: 0, key: false, admin: false },
      { id: 9300003, name: 'staging-demo-spend-low',      tier: 1, key: false, admin: false },
      { id: 9300004, name: 'staging-demo-spend-mid',      tier: 2, key: false, admin: false },
      { id: 9300005, name: 'staging-demo-spend-high',     tier: 3, key: false, admin: false },
      { id: 9300006, name: 'staging-demo-spend-higher',   tier: 4, key: false, admin: false },
      { id: 9300007, name: 'staging-demo-spend-capped',   tier: 5, key: false, admin: false },
      { id: 9300008, name: 'staging-demo-spend-ownkey',   tier: 6, key: true,  admin: false },
      { id: 9300009, name: 'staging-demo-spend-admin-cap',tier: 5, key: false, admin: true },
      { id: 9300010, name: 'staging-demo-spend-admin-key',tier: 6, key: true,  admin: true },
    ];

    const records = fixtures.map(f => ({
      id: f.id, name: f.name, admin: f.admin,
      key_enc: f.key ? 'v1:staging-demo-fake-key' : null,
      key_last4: f.key ? 'demo' : null,
      base: { 1: 250, 2: 750, 3: 1250, 4: 1750, 5: 2200, 6: 2500 }[f.tier] || 0,
      tier: f.tier,
    }));
    // Sentinel passwords/keys are non-loginable and carry no real secret.
    await pool.query(
      `INSERT INTO users (id, username, password, is_admin, anthropic_key_enc, anthropic_key_last4)
       SELECT f.id, f.name, '!staging-fixture-no-login!', f.admin, f.key_enc, f.key_last4
         FROM jsonb_to_recordset($1::jsonb) AS f(id int, name text, admin boolean, key_enc text, key_last4 text)
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(records)]
    );
    // Re-pin roles/keys, and only backdate signups that are too recent.
    await pool.query(
      `UPDATE users u SET is_admin = f.admin, anthropic_key_enc = f.key_enc,
              anthropic_key_last4 = f.key_last4,
              created_at = CASE WHEN u.created_at > NOW() - INTERVAL '45 days'
                                THEN NOW() - INTERVAL '45 days' ELSE u.created_at END
         FROM jsonb_to_recordset($1::jsonb) AS f(id int, admin boolean, key_enc text, key_last4 text)
        WHERE u.id = f.id`,
      [JSON.stringify(records)]
    );
    await pool.query(
      `INSERT INTO llm_usage (user_id, date, total_cost_cents, byok_cost_cents)
       SELECT f.id, CURRENT_DATE - g,
              LEAST(f.base + (g % 5) * 10, CASE WHEN f.tier = 4 THEN 1999 ELSE f.base + 40 END)::numeric(10,4),
              (CASE WHEN f.tier = 6 THEN 800 + (g % 5) * 40 ELSE 0 END)::numeric(10,4)
         FROM jsonb_to_recordset($1::jsonb) AS f(id int, base int, tier int)
         CROSS JOIN generate_series(0, 29) g
        WHERE f.tier <> 0
        ORDER BY f.id, g
       ON CONFLICT (user_id, date) DO NOTHING`,
      [JSON.stringify(records)]
    );

    log.info('db', 'Staging spend-distribution fixtures seeded', { users: fixtures.length });
  } catch (err) {
    log.warn('db', 'Staging spend-distribution seeding failed', { message: err.message });
  }
}

// #370: make the token/spend cap reproducible in a staging preview so a
// tester can verify that hitting the cap on send no longer wipes the
// composer text. Three idempotent, staging-only steps against the
// tester's own login (the admin / first user — the account staging
// previews sign in as):
//   1. Pin their per-user daily limit to 1¢ (users.daily_limit_cents).
//   2. Ensure today's recorded spend is well over that (≥ 50¢), so
//      limits.checkBudget reports "Daily limit reached" → the chat POST
//      returns 429 { error } on the very next send.
//   3. Seed a clearly-named ACTIVE dev session on the self-app for them
//      to type into.
// The result: opening that session, typing a message and pressing Send
// bounces with the cap notice while the typed text stays in the box.
// Strictly a no-op outside staging; only this ephemeral PR preview's DB
// is touched (never prod).
async function seedStagingCapReached(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging cap-reached fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging cap-reached fixture skipped: no users');
    return;
  }
  const tester = userRows[0];

  // 1. Pin the per-user daily cap to 1¢.
  await pool.query(
    'UPDATE users SET daily_limit_cents = 1 WHERE id = $1',
    [tester.id]
  );

  // 2. Guarantee today's spend exceeds the 1¢ cap (raise-only, so the
  //    dashboard's own llm_usage fixtures aren't reduced on re-runs).
  //    byok_notice_at is deliberately left unstamped (#1088): a tester
  //    with their own key on this preview should still see the
  //    once-per-day switchover notice the first time it fires.
  await pool.query(
    `INSERT INTO llm_usage (user_id, date, total_cost_cents)
     VALUES ($1, CURRENT_DATE, 50)
     ON CONFLICT (user_id, date)
       DO UPDATE SET total_cost_cents = GREATEST(llm_usage.total_cost_cents, 50)`,
    [tester.id]
  );

  // 3. An active dev session to type into, named so the testing steps
  //    can reference it. Idempotent via branch-name lookup.
  const branch = 'staging-fixture/token-cap';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (!existing.length) {
    await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, session_title, status, created_at)
       VALUES ($1, $2, $3, $4, 'active', NOW() - INTERVAL '2 minutes')`,
      [appId, tester.id, branch,
       '[staging fixture] Token cap — your text is preserved']
    );
  }

  log.info('db', 'Staging cap-reached fixture seeded', {
    appId, tester: tester.username,
  });
}

// Seed ~29 synthetic non-errored app rows so the server-wide MAX_APPS
// cap (default 30; src/config.js -> src/routes/apps.js) is observable on
// a staging clone. With 29 fixture apps a tester can create one more
// (reaching the cap) and then watch the next non-admin create attempt
// get the "This server is at its app limit (30)…" message. Errored apps
// don't count toward the cap, so every fixture is status 'deployed'.
// Idempotent: rows are keyed off a fixed slug prefix and checked before
// insert. Tagged "[staging fixture]" so they're never mistaken for real
// apps. Strictly a no-op outside staging.
async function seedStagingAppCapApps(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  // How close to the cap to fill. One below MAX_APPS so a tester can
  // create exactly one app to hit the wall, without pre-tripping it.
  const target = Math.max(0, (config.maxApps || 30) - 1);
  if (target <= 0) {
    log.info('db', 'Staging app-cap fixtures skipped (cap disabled or <= 1)');
    return;
  }

  // Attribute the fixtures to some existing user (FK is ON DELETE SET
  // NULL, so a null creator is fine too, but a real id keeps them
  // realistic on the home cards).
  const { rows: userRows } = await pool.query(
    'SELECT id FROM users ORDER BY is_admin DESC, id ASC LIMIT 1'
  );
  const creatorId = userRows[0]?.id ?? null;

  // Count apps that ALREADY count toward the cap (non-errored, including
  // the self-app row) so we top up to `target` rather than blindly
  // inserting `target` extra rows on top of real data.
  const { rows: liveRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM apps WHERE status <> 'error'`
  );
  const live = liveRows[0].n;

  let inserted = 0;
  for (let i = 1; i <= target; i++) {
    if (live + inserted >= target) break;
    const slug = `staging-fixture-cap-app-${String(i).padStart(2, '0')}`;
    const { rows: existing } = await pool.query(
      'SELECT id FROM apps WHERE slug = $1 LIMIT 1',
      [slug]
    );
    if (existing.length) continue;
    await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, created_at)
       VALUES ($1, $2, 'deployed', $3, NOW() - ($4::int * INTERVAL '1 minute'))`,
      [`[staging fixture] Cap filler app ${i}`, slug, creatorId, i]
    );
    inserted++;
  }

  log.info('db', 'Staging app-cap fixtures seeded', {
    target, liveBefore: live, inserted,
  });
}

// #361: seed ~30 days of system-token spend so the dashboard's Daily
// spend chart renders its new cyan "System tokens" segment and the
// "System tokens today: $X.XX / $25.00" readout has real data. A modest
// daily figure (a few hundred cents) tapering down, staying under the
// $25 cap most days and brushing it on one or two so the readout looks
// realistic. Idempotent via ON CONFLICT (date); a no-op outside staging.
async function seedStagingSystemTokenUsage(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  // Cost (cents) per day-offset g (0 = today). Base ~480¢ ($4.80) tapering
  // with a wobble; two recent days near the $25 cap (2300–2450¢).
  await pool.query(
    `INSERT INTO system_token_usage (date, cost_cents)
     SELECT CURRENT_DATE - g,
            CASE
              WHEN g = 0 THEN 2310
              WHEN g = 3 THEN 2440
              ELSE GREATEST(60, 480 - g * 9 + (g % 4) * 70)
            END::numeric(10,4)
       FROM generate_series(0, 29) g
     ON CONFLICT (date) DO NOTHING`
  );
  log.info('db', 'Staging system_token_usage fixtures seeded');
}

// Admin-attributed footprint for the dashboard's amber admin-split charts
// (#341). The colour split (Funnels, Growth, Engagement tiers, Top builders)
// is only visible when staging holds an ADMIN user whose recent activity
// overlaps the existing non-admin demo data. seedStagingLlmUsage already
// gives admins spend (so Daily spend / Spend-by-builder show the amber
// outline + tooltip breakout immediately); this fills the rest by giving the
// seeded view-only admin (900030, is_admin = TRUE) a small, recent footprint:
//   - two dev sessions, one promoted (~2wks ago), one merged (~1wk ago)
//     → Funnels admin segment, Growth promoted/merged admin, Top builders bar
//   - a few app_activity days + matching dapp_active_day / pr_promoted events
//     → Funnels "opened/returned" admin segment, Engagement DAU/WAU admin
//   - one kudos given → Funnels "engaged socially" admin segment
// With "Include admin users" ticked every admin-split chart then renders a
// non-zero amber segment beside the non-admin demo data. Idempotent (fixed
// 9000xx ids + ON CONFLICT), [staging fixture]-tagged, a no-op outside staging.
async function seedStagingDashboardAdminSplit(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const ADMIN_ID = 900030; // staging-demo-view-admin (seeded earlier, is_admin)
  try {
    const { rows: adminRows } = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND is_admin', [ADMIN_ID]
    );
    if (!adminRows.length) {
      log.warn('db', 'Staging dashboard admin-split skipped: admin user missing');
      return;
    }

    const { rows: appRows } = await pool.query(
      `SELECT id FROM apps
         WHERE COALESCE(self_hosted, FALSE) = FALSE AND status <> 'deleted'
         ORDER BY id LIMIT 1`
    );
    const appId = appRows[0]?.id;
    if (!appId) {
      log.warn('db', 'Staging dashboard admin-split skipped: no public app');
      return;
    }

    // Two admin dev sessions: one promoted, one merged, dated within the
    // last couple of weeks so they fall inside the 12-week growth/engagement
    // windows. chat_sessions is staging:private → seeded here.
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status,
          created_at, promoted_at, merged_at)
       VALUES
         (9000401, $1, $2, 'staging-fixture/admin-split-promoted', 900401,
          '[staging fixture] Staging demo admin PR — promoted',
          'promoted', NOW() - INTERVAL '15 days', NOW() - INTERVAL '14 days', NULL),
         (9000402, $1, $2, 'staging-fixture/admin-split-merged', 900402,
          '[staging fixture] Staging demo admin PR — merged',
          'merged', NOW() - INTERVAL '9 days', NOW() - INTERVAL '8 days', NOW() - INTERVAL '7 days')
       ON CONFLICT (id) DO NOTHING`,
      [appId, ADMIN_ID]
    );

    // app_activity across 4 distinct recent days → Funnels opened/returned
    // admin segment + Engagement WAU (>= 2 days in the trailing 2 weeks).
    await pool.query(
      `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
       SELECT $1, $2, 120, CURRENT_DATE - g
         FROM generate_series(1, 4) g
       ON CONFLICT (app_id, user_id, date) DO NOTHING`,
      [appId, ADMIN_ID]
    );

    // Explicit events so the admin amber shows in Engagement tiers even when
    // the one-shot events backfill already ran on a prior boot of this
    // container: 4 dapp_active_day days (>= 2 → WAU) + a pr_promoted (→ DAU).
    await pool.query(
      `INSERT INTO events (id, user_id, app_id, event_type, created_at)
       SELECT 90004100 + g, $2, $1, 'dapp_active_day', NOW() - (g || ' days')::interval
         FROM generate_series(1, 4) g
       ON CONFLICT (id) DO NOTHING`,
      [appId, ADMIN_ID]
    );
    await pool.query(
      `INSERT INTO events (id, user_id, app_id, session_id, event_type, created_at)
       VALUES (90004110, $2, $1, 9000401, 'pr_promoted', NOW() - INTERVAL '14 days')
       ON CONFLICT (id) DO NOTHING`,
      [appId, ADMIN_ID]
    );

    // One kudos given by the admin → Funnels "engaged socially" admin segment.
    await pool.query(
      `INSERT INTO pr_kudos (session_id, giver_user_id, week_start, created_at)
       SELECT 9000402, $1, date_trunc('week', NOW() AT TIME ZONE 'UTC')::date, NOW()
        WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = 9000402)
       ON CONFLICT (session_id, giver_user_id) DO NOTHING`,
      [ADMIN_ID]
    );

    // Admin LLM spend across 6 recent days (inside the 30-day Daily spend
    // window) → the new amber admin segment on Daily spend in all three
    // toggle modes, plus the Spend-by-builder admin outline (bonus). Both
    // platform (total_cost_cents) and user-key (byok_cost_cents) costs are
    // non-zero so Platform / User key / Both modes each show the amber.
    // llm_usage is staging:private and UNIQUE(user_id, date) → ON CONFLICT.
    await pool.query(
      `INSERT INTO llm_usage (user_id, date, total_cost_cents, byok_cost_cents)
       SELECT $1, CURRENT_DATE - g, 40 + g * 6, 15 + g * 3
         FROM generate_series(1, 6) g
       ON CONFLICT (user_id, date) DO NOTHING`,
      [ADMIN_ID]
    );

    log.info('db', 'Staging dashboard admin-split fixtures seeded', { appId });
  } catch (err) {
    log.warn('db', 'Staging dashboard admin-split seeding failed', { message: err.message });
  }
}

// Fixtures for the dashboard's General-users and Power-users sections.
// Both read empty on a fresh/cloned staging DB (the General-users daily
// charts need spread-out activity; the Power-users charts read the events
// log, and chat_sessions/events fixtures don't survive into staging), so
// seed:
//   - Six fixture users whose created_at spans several signup weeks → a
//     non-trivial retention triangle (both alignment views).
//   - app_activity across many days per user, distinct strides, so the
//     General-users DAU line varies day-to-day and the 7/30-day rolling
//     WAU/MAU windows are fully backed.
//   - Power-user events (dapp_active_day >=3/week + three developer actions —
//     kudos/vote/proposal — per qualifying week) across the trailing four
//     weeks, with each user qualifying in a different number of weeks so the
//     L4 stacked bar shows distinct 1/4…4/4 buckets and the rolling
//     power-user WAU is non-zero.
// High synthetic ids + ON CONFLICT DO NOTHING keep it idempotent across the
// every-boot re-run; a strict no-op outside staging.
async function seedStagingAnalyticsCharts(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    const { rows: appRows } = await pool.query(
      `SELECT id FROM apps
         WHERE COALESCE(self_hosted, FALSE) = FALSE AND status <> 'deleted'
         ORDER BY id LIMIT 1`
    );
    const appId = appRows[0]?.id;
    if (!appId) {
      log.warn('db', 'Staging analytics-charts skipped: no public app');
      return;
    }

    // Fixture users across several signup weeks. Sentinel password → no login.
    const users = [
      { id: 900060, createdDaysAgo: 38, stride: 2 },
      { id: 900061, createdDaysAgo: 31, stride: 3 },
      { id: 900062, createdDaysAgo: 24, stride: 2 },
      { id: 900063, createdDaysAgo: 17, stride: 3 },
      { id: 900064, createdDaysAgo: 10, stride: 2 },
      { id: 900065, createdDaysAgo: 4,  stride: 1 },
    ];
    await pool.query(
      `INSERT INTO users (id, username, password, created_at)
       SELECT u.id, 'staging-demo-analytics-' || u.id, '!staging-fixture-no-login!',
              NOW() - (u."createdDaysAgo" * INTERVAL '1 day')
         FROM jsonb_to_recordset($1::jsonb) AS u(id int, "createdDaysAgo" int)
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(users)]
    );
    await pool.query(
      `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
       SELECT $1, u.id, 120, CURRENT_DATE - g
         FROM jsonb_to_recordset($2::jsonb) AS u(id int, "createdDaysAgo" int, stride int)
         CROSS JOIN LATERAL generate_series(1, u."createdDaysAgo", u.stride) g
        ORDER BY u.id, g
       ON CONFLICT (app_id, user_id, date) DO NOTHING`,
      [appId, JSON.stringify(users)]
    );

    // Power-user events. Per qualifying week: 3 dapp_active_day events (>=3
    // "uses") + 3 developer actions (>=3). Week w (days ago) spans
    // [7w+1, 7w+7].
    const weekDappDays = [[1, 2, 3], [8, 9, 10], [15, 16, 17], [22, 23, 24]];
    const weekDevDays = [[2, 3, 4], [9, 10, 11], [16, 17, 18], [23, 24, 25]];
    const devTypes = ['kudos_given', 'pr_vote_cast', 'pr_promoted'];
    // Trailing weeks each user qualifies in (1..4) → distinct L4 buckets.
    const qualWeeks = [
      { id: 900060, weeks: 4 },
      { id: 900061, weeks: 3 },
      { id: 900062, weeks: 2 },
      { id: 900063, weeks: 1 },
    ];
    let evId = 90006000;
    const events = [];
    for (const q of qualWeeks) {
      for (let w = 0; w < q.weeks; w++) {
        for (const d of weekDappDays[w]) {
          events.push({ id: evId++, user_id: q.id, event_type: 'dapp_active_day', days_ago: d });
        }
        for (let i = 0; i < weekDevDays[w].length; i++) {
          events.push({ id: evId++, user_id: q.id, event_type: devTypes[i % devTypes.length], days_ago: weekDevDays[w][i] });
        }
      }
    }
    await pool.query(
      `INSERT INTO events (id, user_id, app_id, event_type, created_at)
       SELECT e.id, e.user_id, $1, e.event_type, NOW() - (e.days_ago * INTERVAL '1 day')
         FROM jsonb_to_recordset($2::jsonb) AS e(id int, user_id int, event_type text, days_ago int)
       ON CONFLICT (id) DO NOTHING`,
      [appId, JSON.stringify(events)]
    );

    log.info('db', 'Staging analytics-charts fixtures seeded', { appId });
  } catch (err) {
    log.warn('db', 'Staging analytics-charts seeding failed', { message: err.message });
  }
}

// Q/A-mode fixture (#32): one demo dev-chat session whose latest Mayor
// turn asks two numbered clarifying questions and carries a matching
// metadata.suggestions payload, so a tester can see and tap the
// suggested-answer chips without burning a live LLM call.
// chat_sessions / chat_session_messages are staging:private (copied
// schema-only into staging), hence the seed. Same owner selection as
// the other session fixtures — the user the tester logs in as.
// Idempotent via the branch-name existence check.
async function seedStagingQaSession(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging Q/A fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging Q/A fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const branch = 'staging-fixture/qa-suggestions';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (existing.length) return;

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, status, created_at)
     VALUES
       ($1, $2, $3, $4, 'active', NOW() - INTERVAL '30 minutes')
     RETURNING id`,
    [appId, owner.id, branch, '[staging fixture] Staging demo: Q/A suggested answers']
  );
  const sessionId = sessionRows[0].id;

  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, created_at)
     VALUES ($1, 'user', $2, NOW() - INTERVAL '29 minutes')`,
    [sessionId, 'Make the header nicer']
  );

  const assistantContent = 'Happy to! Two quick questions before I dispatch anything:\n\n'
    + '1. Which header — the platform-wide top bar, or the app view header? (suggested: the platform-wide top bar)\n'
    + '2. What does "nicer" mean here — tidier spacing, or a bolder visual refresh? (suggested: tidier spacing)';
  const suggestions = [
    {
      question: 'Which header?',
      answers: ['The platform-wide top bar', 'The app view header'],
    },
    {
      question: 'What does "nicer" mean?',
      answers: ['Tidier spacing', 'A bolder visual refresh'],
    },
  ];
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'assistant', $2, $3, NOW() - INTERVAL '28 minutes')`,
    [sessionId, assistantContent, JSON.stringify({ suggestions })]
  );

  log.info('db', 'Staging Q/A fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}

// #945: discussion-thread context for the bots. The threads themselves
// (chat_messages) ARE staging-copied, but chat_sessions is
// staging:private and truncated — so the fixture proposal sessions this
// file seeds land with no Discussion thread at all, and the
// proposal-thread half of the feature is unobservable on a staging
// preview. This seeds both halves of what a bot now reads:
//
//   * a proposal thread (thread_type='session') on the shared-session
//     fixture, with messages from two different people;
//   * an issue thread (thread_type='issue') on fixture issue #42 — the
//     same number seedStagingCloneQuestionSuggestions' seed message
//     names — one message shaped like numbered answers to the bot's
//     clarifying questions;
//   * one 'vote' row and one 'system' row in the same threads, which the
//     loader must EXCLUDE, so a tester can confirm the bot cites the
//     human messages and not the lifecycle noise.
//
// Every message is prefixed "[staging fixture]" so it is recognisable
// verbatim when the Mayor quotes it back. Idempotent on the first
// message's content; a strict no-op outside staging.
async function seedStagingDiscussionContext(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging discussion-context fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const MARKER = '[staging fixture] Can this also cover the mobile header?';
  const { rows: already } = await pool.query(
    `SELECT 1 FROM chat_messages WHERE app_id = $1 AND content = $2 LIMIT 1`,
    [appId, MARKER]
  );
  if (already.length) return;

  // Two distinct voices so the rendered block shows real attribution.
  // The first-admin row is the same owner the other session fixtures
  // use; 'staging-demo-user' is the synthetic account seeded by
  // seedStagingSharedSession (which runs earlier).
  const { rows: adminRows } = await pool.query(
    `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 1`
  );
  if (!adminRows.length) {
    log.warn('db', 'Staging discussion-context fixture skipped: no users');
    return;
  }
  const admin = adminRows[0];
  const { rows: demoRows } = await pool.query(
    'SELECT id FROM users WHERE username = $1', ['staging-demo-user']
  );
  // Fall back to the admin when the shared-session fixture didn't run —
  // attribution is less interesting then, but the block still renders.
  const other = demoRows[0]?.id || admin.id;

  // The proposal thread hangs off the shared-session fixture's id
  // (thread_ref for thread_type='session' IS chat_sessions.id).
  const { rows: sessionRows } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, 'staging-fixture/shared-session']
  );
  const sessionId = sessionRows[0]?.id || null;

  const insert = (userId, content, msgType, thread, mins) => pool.query(
    `INSERT INTO chat_messages
       (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, created_at)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, NOW() - ($7 || ' minutes')::INTERVAL)`,
    [appId, userId, content, msgType, thread.type, thread.ref, String(mins)]
  );

  if (sessionId) {
    // Offsets sit AFTER seedStagingSharedSession's own two thread
    // comments (-40 / -35 min) so the rendered block reads in one clean
    // chronological run — the loader orders by id, the way the group-chat
    // UI does, and a fixture whose ids and timestamps disagree would show
    // the model a jumbled thread.
    const t = { type: 'session', ref: sessionId };
    await insert(admin.id, MARKER, 'message', t, 30);
    await insert(other,
      '[staging fixture] Agreed on the mobile header. One worry: the wider cards push the vote buttons below the fold on a phone — worth checking before this merges.',
      'message', t, 24);
    await insert(admin.id,
      '[staging fixture] Good catch — let\'s keep the vote row pinned above the fold and only wrap the title.',
      'message', t, 18);
    // Lifecycle noise the thread loader must skip.
    await insert(null, 'staging-demo-user voted yes on PR #9301 — Staging demo shared session', 'vote', t, 12);
    await insert(null, 'Staging demo: a system activity row in the proposal thread', 'system', t, 10);
  } else {
    log.warn('db', 'Staging discussion-context fixture: shared-session row missing, seeded issue thread only');
  }

  // The issue thread. #42 is the issue the clone-question fixture's seed
  // message names, so a tester can follow one number across both.
  const issueThread = { type: 'issue', ref: 42 };
  await insert(admin.id,
    '[staging fixture] Two more things while you\'re in here: the header should stay readable in dark mode, and the change should not touch the desktop layout.',
    'message', issueThread, 55);
  await insert(other,
    '[staging fixture] Answers to your questions:\n1. The app view header, not the platform top bar.\n2. "Nicer" means tidier spacing — no visual refresh.\n3. Yes, ship it behind no flag.',
    'message', issueThread, 48);
  await insert(null, 'Staging demo: a system activity row in the issue thread', 'system', issueThread, 45);

  log.info('db', 'Seeded staging discussion-context fixture', { appId, sessionId, issueNumber: 42 });
}

// #32: reproduces the "session cloned from an auto run that ended in
// questions" shape so a tester can verify the suggested-answer chips
// render under the FOLLOW-UP message (the last row) without a live LLM
// run. An ordinary active, non-headless session with, in order:
//   1. a user seed message (the issue text),
//   2. an assistant message holding the clarifying questions WITH
//      metadata.suggestions (the cloned question turn), and
//   3. an assistant follow-up message — text in the spirit of
//      buildHeadlessFollowUpMessage's question branch — ALSO carrying the
//      same metadata.suggestions.
// The chips must appear under the follow-up (row 3), confirming Defect 2
// (Part B's forwarding) is fixed. chat_sessions / chat_session_messages
// are staging:private, hence the seed. Owner is the first-admin selection
// shared with the other session fixtures; idempotent via branch name.
async function seedStagingCloneQuestionSuggestions(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging clone-question fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging clone-question fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const branch = 'staging-fixture/clone-question-suggestions';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (existing.length) return;

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, status, created_at)
     VALUES
       ($1, $2, $3, $4, 'active', NOW() - INTERVAL '20 minutes')
     RETURNING id`,
    [appId, owner.id, branch, '[staging fixture] Staging demo: chips on a cloned auto-question session']
  );
  const sessionId = sessionRows[0].id;

  // Reuse the two-question shape from seedStagingQaSession.
  const suggestions = [
    {
      question: 'Which header?',
      answers: ['The platform-wide top bar', 'The app view header'],
    },
    {
      question: 'What does "nicer" mean?',
      answers: ['Tidier spacing', 'A bolder visual refresh'],
    },
  ];

  // 1. The issue text the auto session worked from.
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, created_at)
     VALUES ($1, 'user', $2, NOW() - INTERVAL '19 minutes')`,
    [sessionId, 'Please work on GitHub issue #42: "Make the header nicer".']
  );

  // 2. The cloned question turn — clarifying questions WITH suggestions.
  const questionContent = 'Two quick questions before I can proceed:\n\n'
    + '1. Which header — the platform-wide top bar, or the app view header? (suggested: the platform-wide top bar)\n'
    + '2. What does "nicer" mean here — tidier spacing, or a bolder visual refresh? (suggested: tidier spacing)';
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'assistant', $2, $3, NOW() - INTERVAL '18 minutes')`,
    [sessionId, questionContent, JSON.stringify({ suggestions })]
  );

  // 3. The appended follow-up — last row, carrying the SAME suggestions so
  // the chips render under it (the thing Part B fixes).
  const followUpContent =
    'This session was cloned from an auto session that ran unattended on GitHub issue #42. '
    + "You're on your own branch (forked from the auto session's, so its commits carry over).\n\n"
    + 'Where things stand: the auto session ran into something that needs a human decision — '
    + 'see its questions above (the same questions were also posted as a comment on the GitHub '
    + "issue). Answer here and we'll continue from where it left off.";
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'assistant', $2, $3, NOW() - INTERVAL '17 minutes')`,
    [sessionId, followUpContent, JSON.stringify({ suggestions })]
  );

  log.info('db', 'Staging clone-question fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}


// #330: a cloned-from-auto session whose auto run ended in a SPEC outcome.
// The appended follow-up message (the last row) carries metadata.quickReplies
// so the above-box pill bar renders next-step pills (a whole-spec "Build the
// spec" plus this run's own specifics) — the bug this fixes was that bar being
// empty. Sibling of seedStagingCloneQuestionSuggestions (that one covers the
// chips/question path; this one the pills/spec path). chat_sessions /
// chat_session_messages are staging:private (schema-only in staging), hence
// the seed. Idempotent via the branch-name existence check.
async function seedStagingCloneSpecPills(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging clone-spec-pills fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging clone-spec-pills fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const branch = 'staging-fixture/clone-spec-pills';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (existing.length) return;

  // Carry a spec so the follow-up's "open the spec viewer" line is truthful;
  // headless_outcome 'spec' matches what the clone handler keys pills off.
  const specMd = '## User-facing changes\n\nStaging demo spec for the cloned auto proposal.\n\n'
    + '## Technical implementation\n\nStaging demo: no real change — fixture for the pill bar.';
  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, status, spec_md, cloned_from_session_id,
        is_headless, headless_outcome, headless_issue_number, created_at)
     VALUES
       ($1, $2, $3, $4, 'active', $5, NULL, FALSE, 'spec', 42, NOW() - INTERVAL '15 minutes')
     RETURNING id`,
    [appId, owner.id, branch, '[staging fixture] Staging demo: pills on a cloned auto-spec session', specMd]
  );
  const sessionId = sessionRows[0].id;

  // 1. The issue text the auto session worked from.
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, created_at)
     VALUES ($1, 'user', $2, NOW() - INTERVAL '14 minutes')`,
    [sessionId, 'Please work on GitHub issue #42: "Make the header nicer".']
  );

  // 2. The appended follow-up — last row, carrying the SPEC-outcome pills so
  // the above-box pill bar renders (the thing #330 fixes).
  //
  // #1001: these used to be the fixed triple ('Build it' / 'Revise the spec' /
  // 'What will this change?'), which production showed 92 sessions opening on
  // even though each auto run had produced a specific plan. The clone handler
  // now asks the Mayor to author them from the auto run's own output, with the
  // fixed set only as the fallback — so the fixture carries a set naming the
  // issue and the spec, matching what the live path now produces.
  //
  // #1046: the build pill names the WHOLE spec. It used to read "Build the
  // nicer header" — a component out of a plan that covered more than that,
  // which reads as "build only that bit". The other two stay specific.
  const quickReplies = [
    'Build the spec',
    'What does the plan for #42 change?',
    'Revise the spec first',
  ];
  const followUpContent =
    'This session was cloned from an auto session that ran unattended on GitHub issue #42. '
    + "You're on your own branch (forked from the auto session's, so its commits carry over).\n\n"
    + 'Where things stand: the auto session investigated the repo and drafted a spec — open the '
    + "spec viewer to review it. When you're happy with it, tell me to build it and I'll dispatch "
    + 'the coding agent.';
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'assistant', $2, $3, NOW() - INTERVAL '13 minutes')`,
    [sessionId, followUpContent, JSON.stringify({
      quickReplies, quickRepliesSource: 'enforced',
    })]
  );

  log.info('db', 'Staging clone-spec-pills fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}

// #894: the four shapes the per-turn pill fallback has to get right. Every
// one of these sessions ends on an assistant row with NO metadata.quickReplies
// — exactly what a Mayor turn that skipped suggest_replies leaves behind — so
// what renders above the composer is the CLIENT fallback
// (DevChat._fallbackQuickReplies), not seeded pills. That makes them a live
// check of the fallback itself rather than of the seed.
//
// Two seeding details exist to keep that true, both learned the hard way:
//
//   Dated ~30 DAYS old — restoreMissingQuickReplies (server.js) sweeps
//   sessions active within the last 7 days on every boot and would
//   otherwise write derived pills onto these very rows, leaving the
//   fixtures testing the sweep instead of the fallback. Ageing them out is
//   also the honest shape: an old chat reopened is exactly the population
//   whose rows predate the per-turn guarantee.
//
//   Seeded 'promoted', not 'active' — the session sweeper auto-pauses any
//   'active' session idle for SESSION_AUTOPAUSE_IDLE_MS (5 min by default)
//   and a paused session is non-interactive, so its pill bar is hidden
//   entirely. 'promoted' is exempt from auto-pause (pauseSession only
//   demotes 'active') while still counting as interactive client-side, so
//   these stay inspectable for the life of the container. Same status the
//   notifications / my-open-pr / behind-main fixtures already use.
//
// chat_sessions / chat_session_messages are staging:private (schema-only in
// staging), hence the seed. Sibling of seedStagingCloneSpecPills /
// seedStagingRestartRecoveredPills; idempotent via the branch-name checks.
async function seedStagingQuickReplyFallback(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging quick-reply-fallback fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const owner = await getStagingCheckViewer(pool, 'Staging quick-reply-fallback fixtures');
  if (!owner) return;

  const specMd = '## User-facing changes\n\nStaging demo spec for the pill-fallback fixture.\n\n'
    + '## Technical implementation\n\nStaging demo: no real change — fixture for the pill bar.';

  // Each fixture: a FIXED id (the 9000xx convention other seeds use — the
  // dev-chat route embeds the session id, so a stable id is what lets the
  // dapp.json tests and the TESTING block point at these screens across
  // staging rebuilds), the session columns that drive the fallback choice,
  // and the conversation. The LAST row is always an assistant reply with
  // empty metadata (or, for the chips case, suggestions-only metadata).
  const fixtures = [
    {
      id: 900801,
      branch: 'staging-fixture/fallback-after-build',
      title: '[staging fixture] Staging demo: pills fall back after a build',
      prNumber: 4242,
      specMd,
      // Expect: 'Propose it to the group' / 'Make a tweak' / 'What did it change?'
      rows: [
        ['user', 'Sort the leaderboard by score.', {}, 12],
        ['system', 'PR #4242 created', { prNumber: 4242 }, 11],
        ['assistant', 'Done — the change is on the branch and the staging preview is rebuilt.', {}, 10],
      ],
    },
    {
      id: 900802,
      branch: 'staging-fixture/fallback-after-spec',
      title: '[staging fixture] Staging demo: pills fall back after a spec',
      prNumber: null,
      specMd,
      // Expect: 'Build the spec' / 'Revise the spec' / 'What will this change?'
      rows: [
        ['user', 'Plan out a dark mode toggle before we build anything.', {}, 12],
        ['assistant', 'The scout drafted the spec — it\'s in the spec viewer.', {}, 10],
      ],
    },
    {
      id: 900803,
      branch: 'staging-fixture/fallback-plain-chat',
      title: '[staging fixture] Staging demo: pills fall back on a plain chat reply',
      prNumber: null,
      // chat_sessions.spec_md is NOT NULL — '' is how "no spec yet" is
      // spelled, and it's what the fallback's hasSpec check reads.
      specMd: '',
      // Expect: 'Make a change' / 'What issues are open right now?' / "What's the current state?"
      rows: [
        ['user', 'How does the voting threshold work?', {}, 12],
        ['assistant', 'A proposal merges once it clears the app\'s approval threshold — '
          + 'either enough yes votes, or the merge countdown running out with no opposition.', {}, 10],
      ],
    },
    {
      id: 900804,
      branch: 'staging-fixture/fallback-suppressed-by-chips',
      title: '[staging fixture] Staging demo: answer chips keep the pill bar empty',
      prNumber: null,
      specMd: '',
      // Expect: NO pills above the box — the inline answer chips own this
      // turn. #1001 preserves this exclusion exactly: a clarifying-question
      // turn is asked for no pills at all, not even by the forced retry.
      rows: [
        ['user', 'Make the header better.', {}, 12],
        ['assistant', '1. Which header — the app shell or the dev chat?', {
          suggestions: [{
            question: 'Which header?',
            answers: ['The app shell header', 'The dev chat header', 'Both'],
          }],
        }, 10],
      ],
    },
    // ── #1001 fixtures ────────────────────────────────────────────────
    //
    // The four above all demonstrate the FALLBACK — a reply with no pills of
    // its own, filled in from a fixed list. These three demonstrate the
    // change: pills the assistant authored about the actual conversation, and
    // the row shapes the three non-fallback sources produce. They exist so a
    // reviewer can see the before/after side by side in one staging preview
    // rather than having to run a live turn.
    {
      id: 900805,
      branch: 'staging-fixture/pills-assistant-authored',
      title: '[staging fixture] Staging demo: assistant-authored pills after a build',
      prNumber: 4243,
      specMd,
      // Expect: pills that NAME the change — only the middle one is generic.
      // This is the composition rule QUICK_REPLY_RULES_TEXT asks for.
      rows: [
        ['user', 'Make the leaderboard open on the Season 1 standings by default.', {}, 14],
        ['system', 'PR #4243 created', { prNumber: 4243 }, 13],
        ['assistant', 'The leaderboard now defaults to the Season 1 season-type event on both '
          + 'the client and the server default-pick rule, so a deep link with no event lands there.', {
          quickReplies: ['Preview the Season 1 default', 'Propose it to the group', 'Also fix the sub-event tabs'],
          quickRepliesSource: 'model',
        }, 12],
      ],
    },
    {
      id: 900806,
      branch: 'staging-fixture/pills-after-forced-retry',
      title: '[staging fixture] Staging demo: pills after a forced retry',
      prNumber: null,
      specMd,
      // Expect: pills indistinguishable from the 'model' row above. That IS
      // the point — an enforced set renders identically, so the user never
      // sees which rung produced it; only the telemetry column differs.
      rows: [
        ['user', 'Plan how avatar uploads should work before building anything.', {}, 14],
        ['assistant', 'The scout drafted a spec for avatar uploads — it adds a user_avatars '
          + 'table and a crop step, and it\'s in the spec viewer now.', {
          // #1046: post-spec, so the build pill is the whole-spec literal
          // and the other two carry this spec's specifics. Its dapp.json
          // check asserts the 'Build the spec' pill renders.
          quickReplies: ['Build the spec', 'Drop the crop step from the plan', 'What does this add to the database?'],
          quickRepliesSource: 'enforced',
        }, 12],
      ],
    },
    {
      id: 900807,
      branch: 'staging-fixture/pills-dispatch-preamble',
      title: '[staging fixture] Staging demo: pills on a dispatch preamble',
      prNumber: 4244,
      specMd,
      // Expect: the WRAP-UP's pills above the box, not the preamble's. Both
      // rows carry pills now (#1001 stopped discarding a preamble's), and
      // recency decides — the client's backward scan finds the newest
      // pill-bearing row first. The preamble's set only ever surfaces if the
      // turn dies before the wrap-up lands, which is exactly why it's kept.
      rows: [
        ['user', 'Fix the blank rows on the phone home screen.', {}, 16],
        ['assistant', 'I\'ll have the coding agent make blank interior rows render at half height.', {
          quickReplies: ['How\'s the home-screen fix going?', 'Stop this build'],
          quickRepliesSource: 'enforced',
          quickRepliesPreamble: true,
        }, 15],
        ['system', 'PR #4244 created', { prNumber: 4244 }, 13],
        ['assistant', 'Blank interior rows on the phone home screen now render at half height '
          + '(58px vs 116px), so the default arrangement no longer leaves a dead band.', {
          quickReplies: ['Preview the half-height rows', 'Propose it to the group', 'Now tighten the tile labels'],
          quickRepliesSource: 'model',
        }, 12],
      ],
    },
  ];

  for (const fixture of fixtures) {
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, fixture.branch]
    );
    if (existing.length) {
      await pool.query('UPDATE chat_sessions SET user_id = $1 WHERE id = $2', [owner.id, existing[0].id]);
      continue;
    }

    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status, spec_md, is_headless,
          created_at, last_activity_at, promoted_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, 'promoted', $7, FALSE,
          NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')`,
      [fixture.id, appId, owner.id, fixture.branch, fixture.prNumber, fixture.title, fixture.specMd]
    );
    const sessionId = fixture.id;

    for (const [role, content, metadata, agoMinutes] of fixture.rows) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, $2, $3, $4, NOW() - INTERVAL '30 days' - make_interval(mins => $5::int))`,
        [sessionId, role, content, JSON.stringify(metadata), agoMinutes]
      );
    }

    log.info('db', 'Staging quick-reply-fallback fixture seeded', {
      appId, owner: owner.username, sessionId, branch: fixture.branch,
    });
  }
}


// #786: the two restart-recovery shapes whose pill bar used to come back
// empty. Both fixtures end on a `system` breadcrumb carrying
// metadata.quickReplies — the thing #786 adds — with pill-less system rows
// in between, so they also exercise the client's backward scan skipping
// those. chat_sessions / chat_session_messages are staging:private
// (schema-only in staging), hence the seed. Sibling of
// seedStagingCloneSpecPills; idempotent via the branch-name checks.
//
//   1. restart-recovered-pills  — a build turn recovered after a restart:
//      commit pushed, PR opened, staging rebuilt. #896: the transcript is
//      now indistinguishable from a normal turn's — ordinary card labels
//      and a real Mayor wrap-up carrying the pills on an assistant row
//      (the recovery re-issues phase 2 rather than dropping a breadcrumb),
//      so the fixture exercises the ASSISTANT-row pill source.
//   2. restart-unanswered-pills — a Mayor turn killed mid-stream before it
//      persisted any reply: the boot-time backfill sweep posts the
//      missed-reply breadcrumb, whose first pill is the user's own message
//      handed back for one-tap resending.
//
// Both rows are seeded SHARED (shared_at set), unlike seedStagingCloneSpecPills.
// The Dev board's own-session block comes from GET /api/me/active-sessions,
// which is strictly `cs.user_id = req.user.id` — so a fixture owned by the
// first admin is invisible to every other viewer, including the view-only
// `usernode-capture-admin` identity that signs the proposal-checks
// navigations (services/visuals.js selectCaptureTokens). The dapp.json
// checks asserting these two titles failed for exactly that reason. Shared
// rows also come back from GET /api/apps/:slug/shared-sessions, which is
// app-scoped, so the cards render for anyone opening the Dev board while
// the owner still gets the full dev chat (those endpoints stay
// owner-scoped by design). Same posture as seedStagingSharedSession.
async function seedStagingRestartRecoveredPills(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging restart-recovered-pills fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const owner = await getStagingCheckViewer(pool, 'Staging restart-recovered-pills fixture');
  if (!owner) return;

  // These ids are declared deep links. Adopt rows from an older staging
  // boot before the branch-name guards below decide they are already seeded.
  await pool.query(
    `UPDATE chat_sessions
        SET user_id = $1
      WHERE id = ANY($2::bigint[])`,
    [owner.id, [900820, 900821, 900822]]
  );

  const userAsk = 'Make the leaderboard sort by score';

  // ── Fixture 1: recovered build turn ─────────────────────────────────
  // #896: -v2 because the seed is idempotent on its branch name — without
  // a new name, staging rows seeded under the old (restart-worded)
  // transcript would never be refreshed to the new shape.
  const recoveredBranch = 'staging-fixture/restart-recovered-pills-v2';
  const { rows: existingRecovered } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, recoveredBranch]
  );
  if (!existingRecovered.length) {
    const specMd = '## User-facing changes\n\nStaging demo spec for the recovered build turn.\n\n'
      + '## Technical implementation\n\nStaging demo: no real change — fixture for the pill bar.';
    const { rows: sessionRows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, status, spec_md, is_headless,
          shared_at, created_at)
       VALUES
         ($1, $2, $3, 12, $4, 'active', $5, FALSE,
          NOW() - INTERVAL '24 minutes', NOW() - INTERVAL '25 minutes')
       RETURNING id`,
      [appId, owner.id, recoveredBranch, '[staging fixture] Staging demo: pills after a recovered build turn', specMd]
    );
    const sessionId = sessionRows[0].id;

    const rows = [
      // The ask, then the Mayor's dispatch preamble. The preamble
      // deliberately has NO pills: resolveQuickReplies drops a phase-1
      // suggest_replies call whenever a dispatch co-occurs.
      ['user', userAsk, {}, '24 minutes'],
      ['assistant', "I'll have the coding agent sort the leaderboard by score.", {}, '24 minutes'],
      ['system', 'Claude Code is running...', {
        progressLog: [
          '[claude (mode build)]',
          'Reading public/js/leaderboard.js',
          '  ⎿ Read: 210 lines',
          'Editing public/js/leaderboard.js',
          '  ⎿ Edit: ok',
          '[commit]',
          '[push]',
          '[done]',
        ],
      }, '23 minutes'],
      // The agent's own summary card, exactly as a live turn writes it.
      ['system', 'Claude Code finished', {
        ccOutput: 'Sorted the leaderboard rows by score descending, with a name tiebreak, '
          + 'and kept the existing rank badges in sync.',
        ccOutcome: 'success',
        durationMs: 214000,
        recovered: true,
      }, '23 minutes'],
      ['system', 'PR #12 created', { prNumber: 12, recovered: true }, '22 minutes'],
      ['system', 'Staging deployed!', {
        stagingUrl: 'https://staging-demo.invalid/leaderboard',
        changesReady: true,
        prNumber: 12,
        prUrl: 'https://github.invalid/staging-demo/pull/12',
        recovered: true,
      }, '21 minutes'],
      // #896: the Mayor wrap-up the recovery now re-issues — a normal
      // assistant row, and the turn's pill source.
      ['assistant', 'Sorted the leaderboard by score — highest first, with ties broken by name. '
        + "Preview it, or propose it to the group when you're happy with it.", {
        quickReplies: ['Propose it to the group', 'Make a tweak', 'What did it change?'],
        recovered: true,
      }, '20 minutes'],
    ];
    for (const [role, content, metadata, ago] of rows) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, $2, $3, $4, NOW() - make_interval(mins => $5::int))`,
        [sessionId, role, content, JSON.stringify(metadata), parseInt(ago, 10)]
      );
    }
    log.info('db', 'Staging restart-recovered-pills fixture seeded', {
      appId, owner: owner.username, sessionId,
    });
  }

  // ── Fixture 2: Mayor turn killed before it replied ──────────────────
  // #896: -v2 for the same reason as fixture 1 — the breadcrumb wording
  // changed, and the seed only runs when its branch name is absent.
  const unansweredBranch = 'staging-fixture/restart-unanswered-pills-v2';
  const { rows: existingUnanswered } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, unansweredBranch]
  );
  if (!existingUnanswered.length) {
    const { rows: sessionRows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_title, status, is_headless, shared_at, created_at)
       VALUES
         ($1, $2, $3, $4, 'active', FALSE,
          NOW() - INTERVAL '14 minutes', NOW() - INTERVAL '15 minutes')
       RETURNING id`,
      [appId, owner.id, unansweredBranch,
        '[staging fixture] Staging demo: pills after an interrupted reply']
    );
    const sessionId = sessionRows[0].id;

    const rows = [
      ['user', userAsk, {}, '14 minutes'],
      // The status row the killed turn left behind.
      ['system', 'Thinking about your request...', {}, '14 minutes'],
      // What the boot-time backfill sweep posts: the honest note plus the
      // user's own message as a resend pill.
      ["system", "I didn't get to reply to that — send your message again.", {
        quickReplies: [userAsk, "What's the current state?"],
        recovered: true,
        recoveredReason: 'unanswered',
      }, '13 minutes'],
    ];
    for (const [role, content, metadata, ago] of rows) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, $2, $3, $4, NOW() - make_interval(mins => $5::int))`,
        [sessionId, role, content, JSON.stringify(metadata), parseInt(ago, 10)]
      );
    }
    log.info('db', 'Staging restart-unanswered-pills fixture seeded', {
      appId, owner: owner.username, sessionId,
    });
  }

  // ── Fixture 3: build turn whose TAIL was interrupted, then finished ──
  //
  // The "after" shape of the tail-recovery change, and the reason it
  // exists: a turn's post-agent tail (PR → preview → cards → wrap-up) used
  // to die with the process that was running it, leaving a transcript whose
  // last word was "Building staging preview..." forever. Now the record
  // survives the restart, the tail resumes, and the rows below the
  // interrupted point land with `recovered: true`.
  //
  // Read the transcript top to bottom: the agent's work, the PR, the
  // interrupted build line, and then the three rows the resumed tail
  // supplied. chat_sessions and chat_session_messages are both
  // staging:private, so without this seed none of it is visible in a
  // preview.
  // FIXED id (the 9008xx convention above): the dev-chat route embeds the
  // session id, so a stable one is what lets a dapp.json test open this
  // transcript directly instead of only asserting its card title.
  //
  // All three fixtures below seed `last_activity_at = NOW()` while their
  // MESSAGE timestamps stay in the past. That split is deliberate: the
  // transcript needs a natural shape, but a session whose activity clock is
  // older than the auto-pause window (5 min) gets paused on the first sweep,
  // and a paused session renders neither the quick-reply pills nor the
  // "Propose to group" button — which is most of what these fixtures exist
  // to show.
  const tailBranch = 'staging-fixture/restart-recovered-tail';
  const { rows: existingTail } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, tailBranch]
  );
  if (!existingTail.length) {
    const sessionId = 900820;
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status, is_headless,
          shared_at, created_at, last_activity_at)
       VALUES
         ($1, $2, $3, $4, 34, $5, 'active', FALSE,
          NOW() - INTERVAL '11 minutes', NOW() - INTERVAL '12 minutes', NOW())`,
      [sessionId, appId, owner.id, tailBranch,
        '[staging fixture] Staging demo: a turn that finished itself after an update']
    );

    const rows = [
      ['user', 'Sort the leaderboard by score', {}, '12 minutes'],
      ['assistant', "I'll have the coding agent sort the leaderboard by score.", {}, '12 minutes'],
      ['system', 'Claude Code is running...', {
        progressLog: [
          '[claude (mode build)]',
          'Reading public/js/leaderboard.js',
          '  ⎿ Read: 210 lines',
          'Editing public/js/leaderboard.js',
          '  ⎿ Edit: ok',
          '[commit]',
          '[push]',
          '[done]',
        ],
      }, '11 minutes'],
      // Everything up to here landed before the interruption.
      ['system', 'PR #34 created', { prNumber: 34 }, '11 minutes'],
      // The row the transcript used to end on, forever.
      ['system', 'Building staging preview...', { stagingBuild: 'running' }, '10 minutes'],
      // ...and what the resumed tail then supplied. `recovered: true` is
      // the audit marker on every recovery-written row.
      ['system', 'Claude Code finished', {
        ccOutput: 'Sorted the leaderboard rows by score descending, with a name tiebreak, '
          + 'and kept the existing rank badges in sync.',
        ccOutcome: 'success',
        durationMs: 214000,
        recovered: true,
      }, '6 minutes'],
      ['system', 'Staging deployed!', {
        stagingUrl: 'https://staging-demo.invalid/leaderboard',
        changesReady: true,
        prNumber: 34,
        prUrl: 'https://github.invalid/staging-demo/pull/34',
        recovered: true,
      }, '5 minutes'],
      ['assistant', 'Sorted the leaderboard by score — highest first, with ties broken by name. '
        + "Preview it, or propose it to the group when you're happy with it.", {
        quickReplies: ['Propose it to the group', 'Make a tweak', 'What did it change?'],
        recovered: true,
      }, '5 minutes'],
    ];
    for (const [role, content, metadata, ago] of rows) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, $2, $3, $4, NOW() - make_interval(mins => $5::int))`,
        [sessionId, role, content, JSON.stringify(metadata), parseInt(ago, 10)]
      );
    }
    log.info('db', 'Staging restart-recovered-tail fixture seeded', {
      appId, owner: owner.username, sessionId,
    });
  }

  // ── Fixture 4: background preview rebuild still running ─────────────
  //
  // Pins the in-progress row a self-healing rebuild now posts before it
  // starts (services/staging-recovery.js announceRebuildStarted). It is
  // deliberately the LAST row in this transcript — that is the state the
  // client's _activateTrailingStagingBuild spinner pass is for, and the
  // state that used to be five minutes of total silence.
  const rebuildBranch = 'staging-fixture/staging-rebuild-running';
  const { rows: existingRebuild } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, rebuildBranch]
  );
  if (!existingRebuild.length) {
    const sessionId = 900821;
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status, is_headless,
          shared_at, created_at, last_activity_at)
       VALUES
         ($1, $2, $3, $4, 35, $5, 'active', FALSE,
          NOW() - INTERVAL '8 minutes', NOW() - INTERVAL '9 minutes', NOW())`,
      [sessionId, appId, owner.id, rebuildBranch,
        '[staging fixture] Staging demo: preview rebuilding in the background']
    );

    const rows = [
      ['user', 'Add a compact mode to the leaderboard', {}, '9 minutes'],
      ['assistant', "I'll have the coding agent add a compact leaderboard mode.", {}, '9 minutes'],
      ['system', 'Claude Code finished', {
        ccOutput: 'Added a compact row density toggle to the leaderboard header.',
        ccOutcome: 'success',
        durationMs: 178000,
      }, '8 minutes'],
      ['system', 'PR #35 created', { prNumber: 35 }, '8 minutes'],
      // The rebuild the platform started on its own. No row follows it,
      // so the client spins this one.
      ['system', 'Building staging preview...', {
        stagingBuild: 'running',
        prNumber: 35,
        recovered: true,
      }, '2 minutes'],
    ];
    for (const [role, content, metadata, ago] of rows) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, $2, $3, $4, NOW() - make_interval(mins => $5::int))`,
        [sessionId, role, content, JSON.stringify(metadata), parseInt(ago, 10)]
      );
    }
    log.info('db', 'Staging staging-rebuild-running fixture seeded', {
      appId, owner: owner.username, sessionId,
    });
  }

  // ── Fixture 5: unresumable turn whose code nonetheless landed ────────
  //
  // The honest-wording case. When a tail cannot be resumed at all (the
  // agent's container is gone) but its commit is already on GitHub, the
  // breadcrumb reports what landed instead of the blanket "send your
  // request again" — which would send the user to redo pushed work, and is
  // exactly what produced a duplicate build turn in the incident that
  // motivated this. Pairs with code_done pills, not retry pills.
  const landedBranch = 'staging-fixture/restart-code-landed';
  const { rows: existingLanded } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, landedBranch]
  );
  if (!existingLanded.length) {
    const sessionId = 900822;
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status, is_headless,
          shared_at, created_at, last_activity_at)
       VALUES
         ($1, $2, $3, $4, 36, $5, 'active', FALSE,
          NOW() - INTERVAL '6 minutes', NOW() - INTERVAL '7 minutes', NOW())`,
      [sessionId, appId, owner.id, landedBranch,
        '[staging fixture] Staging demo: changes landed, preview rebuilding']
    );

    const rows = [
      ['user', 'Show each player\'s rank change since yesterday', {}, '7 minutes'],
      ['assistant', "I'll have the coding agent add a rank-change indicator.", {}, '7 minutes'],
      ['system', 'Claude Code is running...', {
        progressLog: [
          '[claude (mode build)]',
          'Editing public/js/leaderboard.js',
          '  ⎿ Edit: ok',
          '[commit]',
          '[push]',
          '[interrupted]',
        ],
      }, '6 minutes'],
      // Built by recoveryPills.buildCodeLandedBreadcrumb — keep the two in
      // sync (isCodeLandedBreadcrumb is the matcher that pins the wording).
      ['system', 'Your changes are committed and pushed to PR #36 — rebuilding the preview now.', {
        quickReplies: ['Propose it to the group', 'Make a tweak', 'What did it change?'],
        recovered: true,
        recoveredReason: 'tail_worker_gone',
        prNumber: 36,
      }, '6 minutes'],
    ];
    for (const [role, content, metadata, ago] of rows) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, $2, $3, $4, NOW() - make_interval(mins => $5::int))`,
        [sessionId, role, content, JSON.stringify(metadata), parseInt(ago, 10)]
      );
    }
    log.info('db', 'Staging restart-code-landed fixture seeded', {
      appId, owner: owner.username, sessionId,
    });
  }
}


// Dev-chat attachment fixture (#450). chat_sessions /
// chat_session_messages / chat_session_attachments are all
// staging:private (schema-only in staging), so without this seed the
// attachment UI — the thumbnail + file chip inside a sent user bubble,
// the full-size image open, the text-file download, and the zip/binary
// kind badges — would be invisible on a staging preview. One fixture
// session owned by the first admin (the user the tester logs in as)
// carrying a user message with one tiny PNG, one small text file, one
// real 2-entry zip (with its validateZip manifest in meta), and one
// tiny .ico binary, plus an assistant reply so the conversation reads
// naturally. Idempotent via the branch-name existence check;
// attachment ids are fixed 32-hex constants with ON CONFLICT DO
// NOTHING.
async function seedStagingChatAttachments(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging chat-attachments fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging chat-attachments fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const branch = 'staging-fixture/chat-attachments';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (existing.length) return;

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, session_title, status, created_at)
     VALUES ($1, $2, $3, $4, 'active', NOW() - INTERVAL '10 minutes')
     RETURNING id`,
    [appId, owner.id, branch, '[staging fixture] Staging demo: message with attachments']
  );
  const sessionId = sessionRows[0].id;

  // Fixed ids (32-hex) so re-seeding after a partial run stays clean.
  const pngId = 'a11ac4e5fabc4450a11ac4e5fabc4450';
  const txtId = 'b22bd5f60bcd5450b22bd5f60bcd5450';
  const zipId = 'c33ce6071cde5450c33ce6071cde5450';
  const icoId = 'd44df7182def5450d44df7182def5450';

  // 1×1 red PNG — a real, valid image so the thumbnail and the
  // full-size open both work against the serving route.
  const pngData = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const txtData = Buffer.from(
    'Staging demo notes\n\nThis text file was attached to a dev-chat message so the\nattachment chip and its download can be tested in staging.\n',
    'utf8'
  );
  // Real stored-method zip (2 entries under reference/) — passes
  // validateZip and extracts cleanly, so the ZIP chip badge, the "N
  // files" label, and the download all work. Its meta below is the
  // exact validateZip manifest for these bytes.
  const zipData = Buffer.from(
    'UEsDBBQAAAAAAAAAAACVZ0MwTwAAAE8AAAATAAAAcmVmZXJlbmNlL1JFQURNRS5tZFN0YWdpbmcgZGVtbyByZWZlcmVuY2UgcHJvamVjdAoKU2VlZGVkIHNvIHRoZSB6aXAgYXR0YWNobWVudCBjaGlwIGlzIHRlc3RhYmxlLgpQSwMEFAAAAAAAAAAAAIrMSx8nAAAAJwAAABIAAAByZWZlcmVuY2UvaW5kZXguanNjb25zb2xlLmxvZygic3RhZ2luZyBkZW1vIHJlZmVyZW5jZSIpOwpQSwECFAAUAAAAAAAAAAAAlWdDME8AAABPAAAAEwAAAAAAAAAAAAAAAAAAAAAAcmVmZXJlbmNlL1JFQURNRS5tZFBLAQIUABQAAAAAAAAAAACKzEsfJwAAACcAAAASAAAAAAAAAAAAAAAAAIAAAAByZWZlcmVuY2UvaW5kZXguanNQSwUGAAAAAAIAAgCBAAAA1wAAAAAA',
    'base64'
  );
  const zipMeta = { entryCount: 2, uncompressedBytes: 118, topLevel: ['reference/'] };
  // Tiny 1×1 32-bit ICO — classifies as 'binary' (pass-through kind).
  const icoData = Buffer.from(
    'AAABAAEAAQEAAAEAIAAwAAAAFgAAACgAAAABAAAAAgAAAAEAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/RET/AAAAAA==',
    'base64'
  );

  const { rows: msgRows } = await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'user', $2, $3, NOW() - INTERVAL '9 minutes')
     RETURNING id`,
    [
      sessionId,
      'Here\'s a mockup screenshot, my notes, a reference project zip, and the favicon — can you match the header color to the mockup?',
      JSON.stringify({
        attachments: [
          { id: pngId, kind: 'image', filename: 'staging-demo-mockup.png', contentType: 'image/png', sizeBytes: pngData.length },
          { id: txtId, kind: 'text', filename: 'staging-demo-notes.txt', contentType: 'text/plain', sizeBytes: txtData.length },
          { id: zipId, kind: 'zip', filename: 'staging-demo-reference.zip', contentType: 'application/zip', sizeBytes: zipData.length, meta: zipMeta },
          { id: icoId, kind: 'binary', filename: 'staging-demo-icon.ico', contentType: 'application/octet-stream', sizeBytes: icoData.length },
        ],
      }),
    ]
  );
  const messageId = msgRows[0].id;

  await pool.query(
    `INSERT INTO chat_session_attachments
       (id, session_id, message_id, user_id, kind, filename, content_type, size_bytes, meta, data, created_at)
     VALUES
       ($1, $2, $3, $4, 'image', 'staging-demo-mockup.png', 'image/png', $5, NULL, $6, NOW() - INTERVAL '9 minutes'),
       ($7, $2, $3, $4, 'text', 'staging-demo-notes.txt', 'text/plain', $8, NULL, $9, NOW() - INTERVAL '9 minutes'),
       ($10, $2, $3, $4, 'zip', 'staging-demo-reference.zip', 'application/zip', $11, $12, $13, NOW() - INTERVAL '9 minutes'),
       ($14, $2, $3, $4, 'binary', 'staging-demo-icon.ico', 'application/octet-stream', $15, NULL, $16, NOW() - INTERVAL '9 minutes')
     ON CONFLICT (id) DO NOTHING`,
    [pngId, sessionId, messageId, owner.id, pngData.length, pngData,
     txtId, txtData.length, txtData,
     zipId, zipData.length, JSON.stringify(zipMeta), zipData,
     icoId, icoData.length, icoData]
  );

  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, created_at)
     VALUES ($1, 'assistant', $2, NOW() - INTERVAL '8 minutes')`,
    [sessionId, 'Got it — I can see the mockup and your notes, and the reference zip (2 files) and favicon will be handed to the coding agent when we build. Tell me when you want me to start.']
  );

  log.info('db', 'Staging chat-attachments fixture seeded', {
    appId, owner: owner.username, sessionId,
  });
}


// Minimal PNG encoder for the group-chat attachment fixture below: a
// W×H violet-gradient truecolor PNG built with zlib + a local CRC32 —
// keeps a visible-size demo image out of the source as a base64 blob.
function buildFixturePng(width, height) {
  const zlib = require('zlib');
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // filter byte 0 + RGB
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = 124 + Math.floor((60 * x) / width);
      row[2 + x * 3] = 58 + Math.floor((40 * y) / height);
      row[3 + x * 3] = 237;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}


// Group-chat attachment fixture (#694). chat_message_attachments is
// staging:private (schema-only in staging) while chat_messages itself is
// staging-copied — so without this seed the group-chat attachment UI
// (inline image thumbnail, the markdown chip + side-panel viewer, the
// sandboxed HTML Preview, the download chips, and the file-only bubble
// with its "📎 filename" quote fallback) would only be exercisable
// against rows whose bytes 404 in the clone. Two seeded messages on the
// self-app's general chat, authored by the first admin (the user the
// tester logs in as): one with a caption plus a tiny PNG + notes.md +
// demo.html (whose inline <script> mutates the DOM — proves the
// sandboxed preview runs scripts), and one file-only message (empty
// content) carrying a text file. Idempotent via the fixed-attachment-id
// existence check; attachment inserts are ON CONFLICT DO NOTHING.
// App file-storage fixture (#752). app_files is staging:private
// (schema-only in clones), so seed one obviously-fake public image
// metadata row against the staging demo app (seedStagingDemoAppCard
// runs earlier and provides users/apps id 900001). Exercises the
// GET /app-files/:id metadata path and the quota/usage sums in a
// self-app staging preview; the object-store hop itself is absent
// there by design (staging platform containers hold no MinIO
// credentials), so serving the fixture id yields the 503/404
// degrade path rather than bytes — exactly what a preview can test.
async function seedStagingAppFiles(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    // Resolve by slug (not a hard-coded id) so the fixture still lands
    // when the demo-app seeder was skipped; fall back to any app row.
    const { rows: appRows } = await pool.query(
      `SELECT id FROM apps ORDER BY (slug = 'staging-demo-app') DESC, id LIMIT 1`
    );
    const appId = appRows[0]?.id;
    if (!appId) {
      log.warn('db', 'Staging app-files fixture skipped: no app row to attach to');
      return;
    }
    const { rows: userRows } = await pool.query(
      `SELECT id FROM users ORDER BY (username = 'staging-demo-user') DESC, id LIMIT 1`
    );
    await pool.query(
      `INSERT INTO app_files (id, app_id, user_id, filename, content_type, size_bytes, visibility, staging)
       VALUES ('facade00facade00facade00facade00', $1, $2,
               'staging-demo-photo.png', 'image/png', 2048, 'public', FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [appId, userRows[0]?.id ?? null]
    );
    log.info('db', 'Staging app-files fixture seeded', { appId });
  } catch (err) {
    log.warn('db', 'Staging app-files seeding failed', { message: err.message });
  }
}

async function seedStagingGroupChatAttachments(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging group-chat-attachments fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging group-chat-attachments fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  // Fixed ids (32-hex) — doubles as the idempotency check.
  const pngId = 'e55e08293ef05694e55e08293ef05694';
  const mdId = 'f66f19304f015694f66f19304f015694';
  const htmlId = 'a77a20415a125694a77a20415a125694';
  const txtId = 'b88b31526b235694b88b31526b235694';
  const { rows: existing } = await pool.query(
    'SELECT 1 FROM chat_message_attachments WHERE id = $1 LIMIT 1',
    [pngId]
  );
  if (existing.length) return;

  // 96×64 violet-gradient PNG, generated in code (no giant base64
  // literal) — big enough that the inline thumbnail is actually visible
  // in the bubble (a 1×1 pixel renders invisibly small).
  const pngData = buildFixturePng(96, 64);
  const mdData = Buffer.from(
    '# Staging demo notes\n\nThis markdown file was attached to a group-chat message.\n\n- Click the chip to open this rendered view\n- Use the arrow to download the raw file\n\n```js\nconsole.log("markdown code fences render too");\n```\n',
    'utf8'
  );
  const htmlData = Buffer.from(
    '<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>Staging demo HTML attachment</title></head>\n<body>\n<h1>Staging demo HTML attachment</h1>\n<p id="status">If scripts were blocked, this line would not change.</p>\n<script>document.getElementById("status").textContent = "Sandboxed script ran — this page is walled off from the platform.";</script>\n</body>\n</html>\n',
    'utf8'
  );
  const txtData = Buffer.from(
    'Staging demo file-only message\n\nThis text file was sent with no message text, so the bubble\nrenders attachments only and quoting it shows the file name.\n',
    'utf8'
  );

  const atts1 = [
    { id: pngId, kind: 'image', filename: 'staging-demo-screenshot.png', contentType: 'image/png', data: pngData },
    { id: mdId, kind: 'markdown', filename: 'staging-demo-notes.md', contentType: 'text/markdown', data: mdData },
    { id: htmlId, kind: 'html', filename: 'staging-demo-page.html', contentType: 'text/html', data: htmlData },
  ];
  const { rows: msg1Rows } = await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, created_at)
     VALUES ($1, $2, $3, 'message', $4, NOW() - INTERVAL '7 minutes')
     RETURNING id`,
    [
      appId, owner.id,
      'Staging demo: a screenshot, my notes, and a standalone HTML page — try the image, the markdown viewer, and the sandboxed Preview.',
      JSON.stringify({
        attachments: atts1.map((a) => ({
          id: a.id, kind: a.kind, filename: a.filename, sizeBytes: a.data.length,
        })),
      }),
    ]
  );
  const msg1Id = msg1Rows[0].id;

  const { rows: msg2Rows } = await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, created_at)
     VALUES ($1, $2, '', 'message', $3, NOW() - INTERVAL '6 minutes')
     RETURNING id`,
    [
      appId, owner.id,
      JSON.stringify({
        attachments: [
          { id: txtId, kind: 'text', filename: 'staging-demo-file-only.txt', sizeBytes: txtData.length },
        ],
      }),
    ]
  );
  const msg2Id = msg2Rows[0].id;

  await pool.query(
    `INSERT INTO chat_message_attachments
       (id, app_id, message_id, user_id, kind, filename, content_type, size_bytes, meta, data, created_at)
     VALUES
       ($1, $2, $3, $4, 'image', 'staging-demo-screenshot.png', 'image/png', $5, NULL, $6, NOW() - INTERVAL '7 minutes'),
       ($7, $2, $3, $4, 'markdown', 'staging-demo-notes.md', 'text/markdown', $8, NULL, $9, NOW() - INTERVAL '7 minutes'),
       ($10, $2, $3, $4, 'html', 'staging-demo-page.html', 'text/html', $11, NULL, $12, NOW() - INTERVAL '7 minutes'),
       ($13, $2, $14, $4, 'text', 'staging-demo-file-only.txt', 'text/plain', $15, NULL, $16, NOW() - INTERVAL '6 minutes')
     ON CONFLICT (id) DO NOTHING`,
    [pngId, appId, msg1Id, owner.id, pngData.length, pngData,
     mdId, mdData.length, mdData,
     htmlId, htmlData.length, htmlData,
     txtId, msg2Id, txtData.length, txtData]
  );

  log.info('db', 'Staging group-chat-attachments fixture seeded', {
    appId, owner: owner.username, msg1Id, msg2Id,
  });
}


// Spec-viewer fixtures (#233): three dev-chat sessions in differing
// spec states so a tester can verify that switching sessions never
// shows another session's spec. A and C each carry a (different) spec —
// spec_md + a frozen v1 in chat_session_specs + the inline preview card
// message that opens the viewer — while B has no spec at all, so the
// viewer's "No spec yet" empty state is reachable. chat_sessions /
// chat_session_messages / chat_session_specs are staging:private
// (schema-only in staging), hence the seed. Owner is the user the
// tester logs in as (first admin), same selection as the other session
// fixtures. Idempotent via the branch-name existence check; spec
// content conforms to the two-half convention (#196) so the viewer's
// User-facing / Technical tabs render too.
async function seedStagingSpecViewerSessions(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging spec-viewer fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging spec-viewer fixtures skipped: no users');
    return;
  }
  const owner = userRows[0];

  const specA = [
    '# Staging demo spec A: welcome banner',
    '',
    'Fixture spec for session A — if you see this in session B or C, that is bug #233.',
    '',
    '## User-facing changes',
    '',
    '- A "Welcome back" banner appears at the top of the home screen.',
    '- It can be dismissed and stays dismissed for the rest of the day.',
    '',
    '## Technical implementation',
    '',
    '- Render the banner in the home view; persist dismissal in localStorage.',
  ].join('\n');

  const specC = [
    '# Staging demo spec C: compact session rows',
    '',
    'Fixture spec for session C — if you see this in session A or B, that is bug #233.',
    '',
    '## User-facing changes',
    '',
    '- Session rows in the dev tab get a tighter, single-line layout.',
    '- Long titles truncate with an ellipsis instead of wrapping.',
    '',
    '## Technical implementation',
    '',
    '- CSS-only change to the session list row component.',
  ].join('\n');

  const fixtures = [
    { branch: 'staging-fixture/spec-viewer-a', title: 'Staging demo: spec session A', spec: specA, minutesAgo: 60 },
    { branch: 'staging-fixture/spec-viewer-b', title: 'Staging demo: spec-less session B', spec: null, minutesAgo: 55 },
    { branch: 'staging-fixture/spec-viewer-c', title: 'Staging demo: spec session C', spec: specC, minutesAgo: 50 },
  ];

  let inserted = 0;
  for (const f of fixtures) {
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, f.branch]
    );
    if (existing.length) continue;

    const { rows: sessionRows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_title, status, spec_md, created_at)
       VALUES ($1, $2, $3, $4, 'active', $5, NOW() - ($6::int * INTERVAL '1 minute'))
       RETURNING id`,
      [appId, owner.id, f.branch, `[staging fixture] ${f.title}`, f.spec || '', f.minutesAgo]
    );
    const sessionId = sessionRows[0].id;
    inserted++;

    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, created_at)
       VALUES ($1, 'user', $2, NOW() - ($3::int * INTERVAL '1 minute'))`,
      [sessionId, f.spec
        ? 'Draft a spec for this change please.'
        : 'Just exploring — no spec here yet.', f.minutesAgo]
    );

    if (f.spec) {
      // Mirror the real scout flow: freeze v1 (spec_md stays
      // byte-identical to the latest version) and persist the inline
      // preview card the viewer opens from.
      await pool.query(
        `INSERT INTO chat_session_specs (session_id, version, content, built_at)
         VALUES ($1, 1, $2, NOW() - ($3::int * INTERVAL '1 minute'))
         ON CONFLICT (session_id, version) DO NOTHING`,
        [sessionId, f.spec, f.minutesAgo - 1]
      );
      const lineCount = f.spec.split('\n').length;
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, 'system', $2, $3, NOW() - ($4::int * INTERVAL '1 minute'))`,
        [sessionId, `Scout drafted a ${lineCount}-line spec from the codebase.`,
         JSON.stringify({ specPreview: f.spec, specLines: lineCount, specVersion: 1 }),
         f.minutesAgo - 1]
      );
    }
  }

  log.info('db', 'Staging spec-viewer fixtures seeded', {
    appId,
    owner: owner.username,
    total: fixtures.length,
    inserted,
  });
}

// NON-owner spec panel fixture: a session owned by staging-demo-user whose
// spec has an UNSHARED v1 draft, a group-shared v2, and a live spec_md that
// has moved ahead of v2. The dapp.json check opens it as
// usernode-capture-admin — an admin, so the session view answers, but a
// non-owner, so GET /spec takes its shared-visibility arm — and asserts the
// shared v2 renders (the exact production bug: session 3455's group-shared
// spec showed "No spec yet" to every viewer but the owner). v1 and the
// spec_md draft must stay invisible on that screen; their marker strings
// say so if they ever leak. Fixed id 900830 so the check route is stable
// across staging rebuilds (the 9008xx convention). chat_sessions /
// chat_session_messages / chat_session_specs are staging:private, hence
// the seed. Idempotent via the branch existence check, which also
// re-asserts the demo-user ownership a tester might have mutated.
async function seedStagingSharedSpecPanelSession(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging shared-spec-panel fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  // Owner must be the synthetic demo user, never the check viewer — a
  // fixture owned by the visitor would exercise the owner path and prove
  // nothing (the "never seed the visitor" rule).
  const { rows: demoRows } = await pool.query(
    'SELECT id FROM users WHERE username = $1', ['staging-demo-user']
  );
  const demoUserId = demoRows[0]?.id;
  if (!demoUserId) {
    log.warn('db', 'Staging shared-spec-panel fixture skipped: demo user missing');
    return;
  }

  const sharedV2 = [
    '# Staging demo shared spec (v2)',
    '',
    'This version was shared to the group — any viewer of this session',
    'should see it in the spec panel, share buttons and all owner',
    'affordances hidden.',
    '',
    '## User-facing changes',
    '',
    '- A viewer who does not own this session still sees this shared spec.',
    '- The version dropdown lists only the shared versions.',
    '',
    '## Technical implementation',
    '',
    '- GET /api/sessions/:id/spec takes its shared-visibility arm here.',
  ].join('\n');

  const privateV1 = [
    '# Staging demo PRIVATE draft (v1)',
    '',
    'Never shared. If a non-owner can read this line the shared-visibility',
    'gate has leaked an unshared draft.',
    '',
    '## User-facing changes',
    '',
    '- (private draft)',
    '',
    '## Technical implementation',
    '',
    '- (private draft)',
  ].join('\n');

  // The live buffer is AHEAD of the last shared version — the owner-only
  // shape from the production report. A non-owner must get v2, not this.
  const draftAhead = sharedV2
    .replace('(v2)', '(unshared v3 draft)')
    .replace('This version was shared to the group', 'This revision was NOT shared yet');

  const fixtureBranch = 'staging-fixture/shared-spec-panel';
  const sessionId = 900830;
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (existing.length) {
    await pool.query(
      'UPDATE chat_sessions SET user_id = $1 WHERE id = $2',
      [demoUserId, existing[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, session_title, status, spec_md, created_at)
       VALUES ($1, $2, $3, $4,
               '[staging fixture] Staging demo: spec shared to the group', 'paused',
               $5, NOW() - INTERVAL '2 hours')`,
      [sessionId, appId, demoUserId, fixtureBranch, draftAhead]
    );

    const transcript = [
      ['user', '[staging fixture] Plan the shared-spec change and post it to the group.', {}, 110],
      ['system', 'Spec drafted', {
        specPreview: sharedV2.slice(0, 400), specLines: sharedV2.split('\n').length, specVersion: 2,
      }, 100],
      ['assistant', '[staging fixture] Spec v2 is in the viewer — I shared it with the group.', {}, 99],
    ];
    for (const [role, content, metadata, mins] of transcript) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, $2, $3, $4::jsonb, NOW() - (($5::int) * INTERVAL '1 minute'))`,
        [sessionId, role, content, JSON.stringify(metadata), mins]
      );
    }
  }

  const specSessionId = existing.length ? existing[0].id : sessionId;
  await pool.query(
    `INSERT INTO chat_session_specs (session_id, version, content, built_at)
     VALUES ($1, 1, $2, NOW() - INTERVAL '105 minutes')
     ON CONFLICT (session_id, version) DO NOTHING`,
    [specSessionId, privateV1]
  );
  await pool.query(
    `INSERT INTO chat_session_specs (session_id, version, content, built_at, shared_to_group_at)
     VALUES ($1, 2, $2, NOW() - INTERVAL '100 minutes', NOW() - INTERVAL '95 minutes')
     ON CONFLICT (session_id, version) DO NOTHING`,
    [specSessionId, sharedV2]
  );
  // Self-heal the share flag on re-runs — the whole fixture hangs off it.
  await pool.query(
    `UPDATE chat_session_specs
        SET shared_to_group_at = COALESCE(shared_to_group_at, NOW() - INTERVAL '95 minutes')
      WHERE session_id = $1 AND version = 2`,
    [specSessionId]
  );

  log.info('db', 'Staging shared-spec-panel fixture seeded', {
    appId, sessionId: specSessionId,
  });
}

// Checkbox-flicker fix fixture. The fix is a client-rendering change, but
// every checkbox surface is data-driven, so seed a scout/proposal session
// named "Staging demo proposal" carrying GFM task lists across all three
// rendered surfaces: the spec viewer body (spec_md + frozen v1), the inline
// spec-preview snippet (a system message with specPreview whose checklist
// straddles the ~200-char clip boundary, exercising the whole-line clip),
// and the post-turn ccOutput markdown (the dc-cc-attached-md surface). With
// these present a tester can open the session and confirm the ☐ / ✓ rows
// render once and stay put. chat_sessions / chat_session_specs are
// staging:private (schema-only in clones), so without this the session is
// unreachable in a preview. Idempotent on the fixture branch; strict no-op
// in production. Live-streaming flicker itself can't be reproduced from
// seed data alone — start a real turn here to watch it.
async function seedStagingDemoProposal(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging demo-proposal fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging demo-proposal fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const fixtureBranch = 'staging-fixture/demo-proposal';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (existing.length) return;

  // Spec body with a GFM task list mixing unchecked / checked items, so the
  // spec viewer and the inline preview snippet both render ☐ and ✓ rows.
  const specMd = [
    '# Staging demo proposal',
    '',
    '## User-facing changes',
    '',
    'A small demo widget lands on the home screen so we can exercise the',
    'task-checkbox rendering across every surface.',
    '',
    '### Checklist',
    '',
    '- [ ] Add the widget to the home view',
    '- [x] Wire the route on the server',
    '- [ ] Style the widget to match the theme',
    '- [x] Add a unit test for the helper',
    '- [ ] Document the widget in the README',
    '',
    '## Technical implementation',
    '',
    '- Render the widget client-side; persist its state in `localStorage`.',
    '- [ ] Confirm the ☐ / ✓ rows render once and stay put while streaming.',
  ].join('\n');

  // Preview snippet whose checklist sits right around the ~200-char clip
  // boundary, so the whole-line clip (change #3) is exercised: the leading
  // prose pushes the first task lines toward 200 chars, and later items
  // must be dropped on a line boundary rather than half-included.
  const specPreview = [
    '# Staging demo proposal',
    '',
    'This preview snippet deliberately runs long so its checklist sits near',
    'the 200-character clip boundary, exercising the whole-line clip.',
    '',
    '- [ ] Add the widget to the home view',
    '- [x] Wire the route on the server',
    '- [ ] Style the widget to match the theme',
    '- [x] Add a unit test for the helper',
  ].join('\n');
  const specLines = specMd.split('\n').length;

  // Post-turn ccOutput markdown (the dc-cc-attached-md surface) — its own
  // checklist so the finished-status disclosure renders checkboxes too.
  const ccOutput = [
    '[staging fixture] Added the demo widget:',
    '',
    '- [x] Wired the route on the server',
    '- [x] Added a unit test for the helper',
    '- [ ] Styling + README still to do',
  ].join('\n');

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, pr_summary_md, status, spec_md, created_at)
     VALUES
       ($1, $2, $3, '[staging fixture] Staging demo proposal', $5, 'active', $4,
        NOW() - INTERVAL '45 minutes')
     RETURNING id`,
    [appId, owner.id, fixtureBranch, specMd,
     'In plain terms: this proposal adds a small demo widget to the app so people have one more handy thing to interact with.']
  );
  const sessionId = sessionRows[0].id;

  // Freeze v1 (spec_md stays byte-identical to the latest version), mirroring
  // the real scout flow so the spec viewer opens a numbered version.
  await pool.query(
    `INSERT INTO chat_session_specs (session_id, version, content, built_at)
     VALUES ($1, 1, $2, NOW() - INTERVAL '44 minutes')
     ON CONFLICT (session_id, version) DO NOTHING`,
    [sessionId, specMd]
  );

  const messages = [
    { role: 'user', content: '[staging fixture] Please draft a proposal for a demo widget.', metadata: {}, minutesAgo: 45 },
    { role: 'system', content: `Scout drafted a ${specLines}-line spec from the codebase.`,
      metadata: { specPreview, specLines, specVersion: 1 }, minutesAgo: 44 },
    { role: 'system', content: 'Claude Code finished', metadata: { ccOutput, ccOutcome: 'success', durationMs: 198000 }, minutesAgo: 40 },
  ];

  for (const m of messages) {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'))`,
      [sessionId, m.role, m.content, JSON.stringify(m.metadata), m.minutesAgo]
    );
  }

  log.info('db', 'Staging demo-proposal fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}

// (#86) Staging fixtures for the private "Share to user" spec flow.
// chat_sessions, chat_session_specs, chat_session_spec_user_shares and
// notifications are all staging:private (schema-only in clones), so
// without seeding the recipient-side path — the 'spec_shared' drawer
// row and its click-through into the read-only spec panel — would be
// unreachable in a staging preview. Must run AFTER
// seedStagingSpecViewerSessions (shares the admin-first "staging login
// user" convention with seedStagingNotifications).
//
// The fixture session is owned by the SECOND user (when one exists) so
// the recipient genuinely exercises the share-widened read gate rather
// than the owner fast-path. Idempotent: session keyed off its fixture
// branch, the share row off its UNIQUE constraint + ON CONFLICT, the
// notification off an existence check.
async function seedStagingSpecUserShareFixtures(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging spec-user-share fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 2`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging spec-user-share fixtures skipped: no users');
    return;
  }
  const recipient = userRows.find((u) => u.is_admin) || userRows[0];
  const sharer = userRows.find((u) => u.id !== recipient.id) || recipient;

  const specContent = [
    '# Staging demo spec: privately shared',
    '',
    'This spec was shared privately with you via the "Share to user"',
    'button — nobody else can see it, and nothing was posted to the',
    'group chat.',
    '',
    '## User-facing changes',
    '',
    '- A "Share to user" button appears in the dev-session spec viewer.',
    '- The recipient gets a notification that opens this read-only panel.',
    '',
    '## Technical implementation',
    '',
    '- chat_session_spec_user_shares rows gate the private read access.',
  ].join('\n');

  const fixtureBranch = 'staging-fixture/spec-user-share';
  let sessionId;
  const { rows: sessionRows } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (sessionRows.length) {
    sessionId = sessionRows[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_title, status, spec_md, created_at)
       VALUES ($1, $2, $3, '[staging fixture] Privately shared spec session', 'active',
               $4, NOW() - INTERVAL '45 minutes')
       RETURNING id`,
      [appId, sharer.id, fixtureBranch, specContent]
    );
    sessionId = rows[0].id;
  }

  await pool.query(
    `INSERT INTO chat_session_specs (session_id, version, content, built_at)
     VALUES ($1, 1, $2, NOW() - INTERVAL '44 minutes')
     ON CONFLICT (session_id, version) DO NOTHING`,
    [sessionId, specContent]
  );

  await pool.query(
    `INSERT INTO chat_session_spec_user_shares (session_id, version, recipient_id, shared_by)
     VALUES ($1, 1, $2, $3)
     ON CONFLICT (session_id, version, recipient_id) DO NOTHING`,
    [sessionId, recipient.id, sharer.id]
  );

  const { rows: existingNotif } = await pool.query(
    `SELECT id FROM notifications
      WHERE user_id = $1 AND app_id = $2 AND kind = 'spec_shared'
        AND session_id = $3
      LIMIT 1`,
    [recipient.id, appId, sessionId]
  );
  if (!existingNotif.length) {
    await pool.query(
      `INSERT INTO notifications
         (user_id, app_id, session_id, source_user_id, kind, detail, created_at)
       VALUES ($1, $2, $3, $4, 'spec_shared', '1', NOW() - INTERVAL '40 minutes')`,
      [recipient.id, appId, sessionId, sharer.id]
    );
  }

  log.info('db', 'Staging spec-user-share fixtures seeded', {
    appId,
    sessionId,
    recipient: recipient.username,
    sharer: sharer.username,
  });
}

// Staging fixtures for the issue panel's headless proposal-run states
// (#228 rename verification). The /github-issues route serves mock issues
// 900001–900005 in staging (stagingMockIssues, routes/issues.js), but the
// per-issue `headless` field comes from chat_sessions rows that never
// exist in a staging clone — so the "Generating proposal…" / retry /
// notification states would be unreachable by clicking around. Seed one
// headless session per state, keyed to the mock issue numbers, plus the
// two auto_solve_done notifications (notifications is staging:private,
// copied schema-only).
//
// user_id is deliberately NULL on every fixture session: boot-time
// resumeHeadlessRuns INNER JOINs users, so NULL keeps the 'generating'
// fixture from being "resumed" (which would hit GitHub for a mock issue
// number and fail the run); the issue panel and notification queries both
// LEFT JOIN and degrade gracefully. headless_step is set on the
// 'generating' row so failOrphanedHeadlessRuns (which sweeps step-less
// generating rows) leaves it alone. Idempotent: sessions keyed off their
// fixture branch name, notifications off (user, app, kind, session).
async function seedStagingHeadlessFixtures(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging headless fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging headless fixtures skipped: no users');
    return;
  }
  const target = userRows[0];

  // Issue numbers match stagingMockIssues; 900001 is left without a run so
  // the idle "Generate proposal" button stays reachable on its row.
  const fixtures = [
    { branch: 'staging-fixture/headless-generating', status: 'generating', outcome: null, issue: 900002, step: 'planning' },
    { branch: 'staging-fixture/headless-question', status: 'ready', outcome: 'question', issue: 900003, step: null },
    { branch: 'staging-fixture/headless-spec', status: 'ready', outcome: 'spec', issue: 900004, step: null },
    { branch: 'staging-fixture/headless-failed', status: 'failed', outcome: null, issue: 900005, step: null },
    // #361: a `code` outcome — the auto-run produced a reviewable commit.
    // Its viewer-owned clones (below) carry "Changes ready" cards.
    { branch: 'staging-fixture/headless-code', status: 'ready', outcome: 'code', issue: 900006, step: null },
  ];

  const sessionIds = {};
  let inserted = 0;
  for (const f of fixtures) {
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, f.branch]
    );
    if (existing.length) {
      sessionIds[f.branch] = existing[0].id;
      continue;
    }
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, status, is_headless,
          headless_status, headless_outcome, headless_issue_number,
          headless_step, created_at)
       VALUES ($1, NULL, $2, 'active', TRUE, $3, $4, $5, $6,
               NOW() - INTERVAL '30 minutes')
       RETURNING id`,
      [appId, f.branch, f.status, f.outcome, f.issue, f.step]
    );
    sessionIds[f.branch] = rows[0].id;
    inserted++;

    // #1001: the auto run's own final assistant row. In production these
    // rows carried NO metadata at all, which made every one of the 94
    // measured headless sessions resolve to the client's built-in generic
    // default. They now get the deterministic set keyed off the outcome
    // (headlessWrapUpMeta in routes/sessions.js) — a model call would be
    // wasted here, since nobody reads an auto session's pill bar until it
    // is cloned, and the clone path authors its own. The 'question' outcome
    // stays pill-free: its answer chips own that turn.
    const wrapUp = {
      spec: {
        text: '_Spec drafted — review it in the spec viewer after starting a session from this auto session._',
        kind: 'spec_done',
        pills: ['Build the spec', 'Revise the spec', 'What will this change?'],
      },
      code: {
        text: '_Change committed and pushed — start a session from this auto session to open the PR._',
        kind: 'code_done',
        pills: ['Propose it to the group', 'Make a tweak', 'What did it change?'],
      },
    }[f.outcome];
    if (wrapUp) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, model, metadata, created_at)
         VALUES ($1, 'assistant', $2, 'claude-opus-5', $3, NOW() - INTERVAL '28 minutes')`,
        [rows[0].id, wrapUp.text, JSON.stringify({
          quickReplies: wrapUp.pills,
          quickRepliesSource: 'static',
          quickRepliesKind: wrapUp.kind,
        })]
      );
    }
  }

  // Viewer-owned clone of the ready/spec headless session for issue 900004,
  // so the issues route resolves mySessionId for the tester (the target
  // admin) and that row renders "Go to session" + the violet
  // issueProposalMine chip. Owned by `target` (the user the tester logs in
  // as) and cloned_from the headless-spec session; non-headless, 'active'
  // (the myCloneByHeadlessId lookup excludes 'archived'). The other ready
  // issues stay clone-less so a reviewer sees the sky-vs-violet contrast.
  const specHeadlessId = sessionIds['staging-fixture/headless-spec'];
  let cloneInserted = 0;
  if (specHeadlessId) {
    const cloneBranch = 'staging-fixture/headless-spec-myclone';
    const { rows: existingClone } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, cloneBranch]
    );
    if (!existingClone.length) {
      await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, status, is_headless,
            cloned_from_session_id, created_at)
         VALUES ($1, $2, $3, 'active', FALSE, $4,
                 NOW() - INTERVAL '20 minutes')`,
        [appId, target.id, cloneBranch, specHeadlessId]
      );
      cloneInserted++;
    }
  }

  // #361: two viewer-owned clones of the `code` headless session, each
  // seeded with a "Changes ready" system status message so both card
  // variants are reviewable in staging WITHOUT running a real build:
  //   - preview-OK clone: changesReady + a (fake) stagingUrl → full card
  //     (Preview staging + Propose to group).
  //   - preview-failed clone: changesReady + stagingFailed + a missing-key
  //     hint → card with a disabled Preview button + working Propose.
  // Both also carry the cloned follow-up assistant message (reusing the
  // real builders) so the intro copy + quick replies sit alongside the
  // card, exactly like a freshly-cloned auto session. Owned by `target`
  // (the tester), non-headless, 'active' (so the Propose button renders).
  const codeHeadlessId = sessionIds['staging-fixture/headless-code'];
  if (codeHeadlessId) {
    const { buildHeadlessFollowUpMessage, buildHeadlessFollowUpQuickReplies } =
      require('../routes/sessions');
    // Mirror the `src` shape buildHeadlessFollowUp* reads off a session row.
    const cloneSrc = { headless_issue_number: 900006, headless_outcome: 'code', spec_md: null };
    const followUp = buildHeadlessFollowUpMessage(cloneSrc);
    const followUpQuickReplies = buildHeadlessFollowUpQuickReplies(cloneSrc);
    // #1001: the live clone path now authors these from the auto run's own
    // output and keeps buildHeadlessFollowUpQuickReplies only as its
    // fallback. The fixture reuses the builder (so its wording can't drift
    // from the real fallback) and stamps the source the fallback rung writes.
    const followUpMeta = JSON.stringify(
      followUpQuickReplies
        ? { quickReplies: followUpQuickReplies, quickRepliesSource: 'static' }
        : {}
    );

    // #647: the inherited Claude Code timeline. A real clone copies the auto
    // session's whole conversation, so its coding-agent disclosures — two
    // long progress logs plus the finished-run summary — used to open
    // EXPANDED and bury the "Changes ready" card under a wall of log text.
    // These rows reproduce that history at production scale so the
    // collapsed-by-default behaviour is reviewable in a preview without
    // running a real auto session.
    //
    // `carryMarker: false` on the legacy clone below omits
    // metadata.inheritedFrom, exercising the client's follow-up-prefix
    // fallback for clones that predate the marker.
    const inheritedProgressScout = [
      '[staging fixture]',
      '[claude (mode scout)]',
      '… Reading the codebase before drafting the spec',
      ...Array.from({ length: 18 }, (_, i) => [
        `Reading src/routes/module-${i + 1}.js`,
        `  ⎿ Read: ${120 + i * 37} lines`,
      ]).flat(),
      '… The change belongs in the renderer, not the route',
      '[done]',
    ];
    const inheritedProgressBuild = [
      '[staging fixture]',
      '[claude (mode build)]',
      '… Planning the change before touching any files',
      ...Array.from({ length: 40 }, (_, i) => (i % 2 === 0
        ? [`Editing src/routes/module-${i + 1}.js`, '  ⎿ Edit: ok']
        : [`$ node --test tests/module-${i + 1}.test.js`, `  ⎿ ${4 + i} lines`])).flat(),
      '$ git add -A && git commit -m "[staging fixture] Apply the spec"',
      '  ⎿ 3 lines',
      '[commit]',
      '[push]',
      '[done]',
    ];
    const inheritedCcOutput = [
      '[staging fixture] Implemented the spec from the auto session:',
      '',
      '- Reworked the renderer so the inherited blocks collapse.',
      '- Stamped the copied rows so the client can tell them apart.',
      '- Added tests covering both defaults.',
      '',
      'The change is committed and pushed on this branch.',
    ].join('\n');

    // The auto-session history every clone inherits, oldest first. Rendered
    // BEFORE the follow-up row so the pairing pre-pass attaches each
    // 'Claude Code progress' row to the status line preceding it.
    const inheritedTimeline = [
      { content: 'Scout reading the codebase...', metadata: {}, minutesAgo: 30 },
      { content: 'Claude Code progress', metadata: { progressLog: inheritedProgressScout }, minutesAgo: 30 },
      { content: 'Claude Code is running...', metadata: {}, minutesAgo: 26 },
      { content: 'Claude Code progress', metadata: { progressLog: inheritedProgressBuild }, minutesAgo: 26 },
      {
        content: 'Claude Code finished',
        metadata: { ccOutput: inheritedCcOutput, ccOutcome: 'success', durationMs: 264000 },
        minutesAgo: 20,
      },
    ];

    // A turn the HUMAN ran after cloning — never marked, so it must stay
    // expanded. Seeded alongside the inherited rows so one session shows
    // both defaults side by side.
    const ownTurn = [
      { role: 'user', content: '[staging fixture] Tweak the wording on the summary line.', metadata: {}, minutesAgo: 12 },
      { role: 'system', content: 'Claude Code is running...', metadata: {}, minutesAgo: 11 },
      {
        role: 'system', content: 'Claude Code progress',
        metadata: {
          progressLog: [
            '[staging fixture]',
            '[claude (mode build)]',
            'Editing public/js/dev-chat.js',
            '  ⎿ Edit: ok',
            '[commit]',
            '[push]',
            '[done]',
          ],
        },
        minutesAgo: 11,
      },
      {
        role: 'system', content: 'Claude Code finished',
        metadata: {
          ccOutput: '[staging fixture] Reworded the summary line as asked.',
          ccOutcome: 'success', durationMs: 48000,
        },
        minutesAgo: 9,
      },
    ];

    const codeClones = [
      {
        branch: 'staging-fixture/headless-code-myclone-ok',
        statusText: 'Staging preview built',
        metadata: {
          changesReady: true,
          stagingUrl: `https://staging-fixture-code-ok.${process.env.USERNODE_APPS_DOMAIN || process.env.USERNODE_DOMAIN || 'apps.example.invalid'}`,
          prNumber: null,
        },
        // The #647 review target: inherited history (collapsed) + the
        // tester's own later turn (expanded).
        inherited: true,
        carryMarker: true,
        ownTurn: true,
      },
      {
        branch: 'staging-fixture/headless-code-myclone-failed',
        statusText: 'Staging build failed',
        metadata: {
          changesReady: true,
          stagingFailed: true,
          stagingErrorName: 'MissingSecretsError',
          stagingMissingKeys: ['EXAMPLE_KEY'],
          prNumber: null,
        },
      },
      {
        // #647: a clone whose copied rows carry NO marker — what every
        // session cloned before this shipped looks like. The client falls
        // back to the follow-up message as the inherited/own boundary, so
        // these blocks must collapse too.
        branch: 'staging-fixture/headless-code-myclone-legacy',
        statusText: 'Staging preview built',
        metadata: {
          changesReady: true,
          stagingUrl: `https://staging-fixture-code-legacy.${process.env.USERNODE_APPS_DOMAIN || process.env.USERNODE_DOMAIN || 'apps.example.invalid'}`,
          prNumber: null,
        },
        inherited: true,
        carryMarker: false,
        ownTurn: false,
      },
    ];

    for (const c of codeClones) {
      const { rows: existingClone } = await pool.query(
        'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
        [appId, c.branch]
      );
      if (existingClone.length) continue;
      const { rows: cloneRows } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, status, is_headless,
            cloned_from_session_id, created_at)
         VALUES ($1, $2, $3, 'active', FALSE, $4,
                 NOW() - INTERVAL '18 minutes')
         RETURNING id`,
        [appId, target.id, c.branch, codeHeadlessId]
      );
      const cloneId = cloneRows[0].id;
      // #647: the inherited auto-session history, copied in the same order
      // the clone route copies it — BEFORE the follow-up, which is the
      // boundary between "what the auto session did" and "this session's
      // own work". Rows carry metadata.inheritedFrom exactly as the route
      // stamps them, unless the fixture is the legacy (pre-marker) one.
      if (c.inherited) {
        for (const m of inheritedTimeline) {
          const meta = c.carryMarker
            ? { ...m.metadata, inheritedFrom: codeHeadlessId }
            : { ...m.metadata };
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
             VALUES ($1, 'system', $2, $3, NOW() - ($4::int * INTERVAL '1 minute'))`,
            [cloneId, m.content, JSON.stringify(meta), m.minutesAgo]
          );
        }
      }
      // Cloned follow-up assistant message (intro copy + quick replies).
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, 'assistant', $2, $3, NOW() - INTERVAL '17 minutes')`,
        [cloneId, followUp, followUpMeta]
      );
      // The "Changes ready" card driver — a system status row whose
      // metadata carries the staging-independent marker.
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, 'system', $2, $3, NOW() - INTERVAL '16 minutes')`,
        [cloneId, c.statusText, JSON.stringify(c.metadata)]
      );
      // #647: an unmarked turn the tester "ran" after cloning — stays
      // expanded, so the contrast with the collapsed inherited rows above
      // is visible in a single session.
      if (c.ownTurn) {
        for (const m of ownTurn) {
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
             VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'))`,
            [cloneId, m.role, m.content, JSON.stringify(m.metadata), m.minutesAgo]
          );
        }
      }
      cloneInserted++;
    }
  }

  // Unread completion notifications for the renamed drawer rows / toast /
  // tab-title markers: one ready-with-spec, one failed.
  const notifFixtures = [
    { branch: 'staging-fixture/headless-spec', detail: 'spec', minutesAgo: 4 },
    { branch: 'staging-fixture/headless-failed', detail: 'failed', minutesAgo: 3 },
  ];
  let notifInserted = 0;
  for (const f of notifFixtures) {
    const sessionId = sessionIds[f.branch];
    if (!sessionId) continue;
    const { rows: existing } = await pool.query(
      `SELECT id FROM notifications
        WHERE user_id = $1 AND app_id = $2 AND kind = 'auto_solve_done'
          AND session_id = $3
        LIMIT 1`,
      [target.id, appId, sessionId]
    );
    if (existing.length) continue;
    await pool.query(
      `INSERT INTO notifications
         (user_id, app_id, session_id, source_user_id, kind, detail,
          read_at, created_at)
       VALUES ($1, $2, $3, NULL, 'auto_solve_done', $4, NULL,
               NOW() - ($5::int * INTERVAL '1 minute'))`,
      [target.id, appId, sessionId, f.detail, f.minutesAgo]
    );
    notifInserted++;
  }

  log.info('db', 'Staging headless proposal fixtures seeded', {
    appId,
    targetUser: target.username,
    sessionsInserted: inserted,
    clonesInserted: cloneInserted,
    notificationsInserted: notifInserted,
  });
}

// Fixture for the "PR proposal I created" violet chip (proposalMine). The
// notifications fixture above seeds a promoted PR, but owns it to the
// `source` user, so it never shows "Open session" for the tester. This
// seeds one open/awaiting-votes (status 'promoted') PR owned by the
// `target` user — the admin the tester logs in as — so pr.user_id ===
// App.user.id holds, rendering the violet proposalMine chip + the "Open
// session" button. A couple of pr_votes give the tally pill a realistic
// fill, matching the merged-PR fixture pattern. chat_sessions is
// staging:private (schema-only in staging), so this is the only way the
// state is reachable; gated on staging + idempotent by branch name.
async function seedStagingMyOpenPr(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging my-open-PR fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: users } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 3`
  );
  if (!users.length) {
    log.warn('db', 'Staging my-open-PR fixture skipped: no users');
    return;
  }
  const target = users[0];

  const branch = 'staging-fixture/my-open-pr';
  const prBody = '## What changed\n\nThe proposal improves the Dev voting experience while preserving the existing vote and merge workflow.\n\n## How to test\n\n1. Review the proposal summary and merge status.\n2. Cast or clear a vote.\n3. Confirm the proposal remains open with the updated tally.';
  let sessionId;
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (existing.length) {
    sessionId = existing[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, pr_body, status,
          votes_required, created_at)
       VALUES
         ($1, $2, $3, 9200, '[staging fixture] My open PR — awaiting votes',
          $5, $6, 'promoted', $4, NOW() - INTERVAL '15 minutes')
       RETURNING id`,
      [appId, target.id, branch, Math.max(1, Math.ceil(users.length / 2)),
       'In plain terms: this proposed change makes the app a little nicer to use. Open it to read the details and cast your vote.',
       prBody]
    );
    sessionId = rows[0].id;
  }

  // A yes-vote or two so the tally pill renders a realistic fill. The
  // author's own vote plus a second user when one exists.
  await pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
     VALUES ($1, $2, 'yes', NOW() - INTERVAL '14 minutes')
     ON CONFLICT (session_id, user_id) DO NOTHING`,
    [sessionId, target.id]
  );
  if (users.length > 1) {
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
       VALUES ($1, $2, 'yes', NOW() - INTERVAL '13 minutes')
       ON CONFLICT (session_id, user_id) DO NOTHING`,
      [sessionId, users[1].id]
    );
  }

  // #361/#384/#386: give the main fixture the 'conflict' state (idempotent
  // UPDATE on re-runs). Post-#384 'conflict' means "an auto-merge was
  // attempted, GitHub rejected it for a real conflict, and the auto-
  // resolver is now running" — and post-#386 that no longer paints the red
  // warning. With behind_main = 2 it falls through to the neutral amber
  // "Behind main · 2" badge, which is exactly what this fixture should
  // demonstrate (the 'failed' sibling below is the one that shows the red
  // affordance).
  await pool.query(
    `UPDATE chat_sessions
        SET merge_conflict_state = 'conflict',
            conflict_files = '["src/app.js","public/index.html"]'::jsonb,
            behind_main = 2,
            conflict_checked_at = NOW(),
            pr_body = $2,
            -- #1442: this fixture's conflict is an ATTEMPTED merge that
            -- failed, so the predicted-conflict note must stand down for it.
            -- Measured and clean says so; leaving it null would not.
            mergeability = 'clean',
            mergeability_files = '[]'::jsonb,
            mergeability_files_complete = TRUE,
            freshness_behind_by = 2,
            freshness_ahead_by = 1,
            checks_base_verdict = 'current',
            checks_base_behind_by = 0,
            freshness_checked_at = NOW() - INTERVAL '2 minutes'
      WHERE id = $1`,
    [sessionId, prBody]
  );

  // #361: two sibling promoted fixtures so all the new badge states show
  // at once — a red "Conflict resolution failed" card and an amber
  // "Behind main · 2" card. Idempotent via branch-name lookup.
  const siblings = [
    {
      branch: 'staging-fixture/conflict-failed',
      pr: 9201,
      title: '[staging fixture] Conflict resolution failed',
      state: 'failed',
      files: '["src/server.js"]',
      behind: 1,
    },
    {
      branch: 'staging-fixture/behind-main',
      pr: 9202,
      title: '[staging fixture] Behind main — still mergeable',
      state: 'behind',
      files: '[]',
      behind: 2,
    },
    // #1442 — the false-clean proposal, which is the whole issue in one
    // card. `state: null` is load-bearing: NO merge has been attempted, so
    // merge_conflict_state is empty and the only thing that knows this
    // cannot merge is the freshness measurement. Before this shipped the
    // card read "In vote · all checks passed" and nothing else. The seven
    // paths are the real ones `git merge-tree` reported for PR #1431.
    {
      branch: 'staging-fixture/false-clean-conflict',
      pr: 9203,
      title: '[staging fixture] All checks passed, conflicts with main',
      state: null,
      files: '[]',
      behind: 8,
      fresh: {
        mergeability: 'conflict',
        files: JSON.stringify([
          'dapp.json', 'public/js/app-view.js', 'public/js/merge-status.js',
          'src/db/schema.sql', 'src/routes/votes.js', 'src/services/mcp-tools.js',
          'src/services/visuals.js',
        ]),
        filesComplete: true,
        behindBy: 8,
        baseVerdict: 'superseded',
        baseBehindBy: 12,
        checkState: 'passing',
      },
    },
    // #1442 — green checks earned against a main that has since moved. This
    // one still merges, so it is the SOFT case: a sentence under the verdict
    // and an "attention" pill, never a block.
    {
      branch: 'staging-fixture/checks-superseded-base',
      pr: 9204,
      title: '[staging fixture] Checks passed on an older main',
      state: null,
      files: '[]',
      behind: 3,
      fresh: {
        mergeability: 'clean',
        files: '[]',
        filesComplete: true,
        behindBy: 3,
        baseVerdict: 'superseded',
        baseBehindBy: 5,
        checkState: 'passing',
      },
    },
    // #1442 — GitHub could not be reached, so nothing is measured. 'unknown'
    // is a real answer and must never read as clean; this fixture is how
    // that renders.
    {
      branch: 'staging-fixture/freshness-unmeasured',
      pr: 9205,
      title: '[staging fixture] Freshness not measured yet',
      state: null,
      files: '[]',
      behind: 0,
      fresh: {
        mergeability: 'unknown',
        files: '[]',
        filesComplete: null,
        behindBy: null,
        baseVerdict: 'unknown',
        baseBehindBy: null,
        checkState: 'passing',
        error: 'GitHub API unreachable (staging fixture)',
      },
    },
  ];
  for (const s of siblings) {
    const { rows: have } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, s.branch]
    );
    let sibId = have[0]?.id;
    if (!sibId) {
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status,
            votes_required, behind_main, merge_conflict_state, conflict_files,
            conflict_checked_at, created_at)
         VALUES
           ($1, $2, $3, $4, $5,
            'In plain terms: a demo proposal showing the new merge-status badge.',
            'promoted', $6, $7, $8, $9::jsonb, NOW(), NOW() - INTERVAL '20 minutes')
         RETURNING id`,
        [appId, target.id, s.branch, s.pr, s.title,
         Math.max(1, Math.ceil(users.length / 2)), s.behind, s.state, s.files]
      );
      sibId = rows[0].id;
    } else {
      await pool.query(
        `UPDATE chat_sessions
            SET behind_main = $2, merge_conflict_state = $3,
                conflict_files = $4::jsonb, conflict_checked_at = NOW()
          WHERE id = $1`,
        [sibId, s.behind, s.state, s.files]
      );
    }
    // #1442 — the freshness block, written in its own statement so the two
    // pre-existing siblings above keep their INSERT verbatim. Every fixture
    // gets a measurement: an unmeasured row is indistinguishable from a
    // healthy one on the screen, which is exactly the bug, so "clean and
    // current" is stated rather than left null.
    const f = s.fresh || {
      mergeability: 'clean', files: '[]', filesComplete: true,
      behindBy: s.behind, baseVerdict: 'current', baseBehindBy: 0, checkState: null,
    };
    await pool.query(
      `UPDATE chat_sessions
          SET mergeability = $2,
              mergeability_files = $3::jsonb,
              mergeability_files_complete = $4,
              freshness_behind_by = $5,
              freshness_ahead_by = 1,
              freshness_main_sha = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1',
              freshness_merge_base_sha = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e',
              checks_base_sha = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e',
              checks_base_verdict = $6,
              checks_base_behind_by = $7,
              freshness_checked_at = NOW() - INTERVAL '2 minutes',
              freshness_error = $8,
              check_state = COALESCE($9, check_state),
              checks_checked_at = CASE WHEN $9 IS NULL THEN checks_checked_at
                                       ELSE NOW() - INTERVAL '10 minutes' END
        WHERE id = $1`,
      [sibId, f.mergeability, f.files, f.filesComplete, f.behindBy,
       f.baseVerdict, f.baseBehindBy, f.error || null, f.checkState || null]
    );
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
       VALUES ($1, $2, 'yes', NOW() - INTERVAL '18 minutes')
       ON CONFLICT (session_id, user_id) DO NOTHING`,
      [sibId, target.id]
    );
  }

  log.info('db', 'Staging my-open-PR fixture seeded', {
    appId,
    targetUser: target.username,
    sessionId,
  });
}

// #687 (PR-import, Slice 2): staging fixtures for imported proposals so the
// "Imported PR" badge, the GitHub-maintained note, and the hidden dev-side
// controls are reviewable in a staging preview (imported rows are created by
// the flag-gated import route, so a fresh staging DB has none). Two rows:
//   1. A healthy imported proposal with passing checks and a couple of yes
//      votes — exercises the badge + GitHub link + read-only rendering.
//   2. An imported proposal whose PR head just moved: tally reset to zero and
//      a "the PR was updated — please re-review" note in its thread, previewing
//      the Slice 3 head-change behaviour.
// Idempotent (keyed on branch name), obviously-fake "[staging fixture]"
// content, strict no-op outside staging.
async function seedStagingImportedPrProposal(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1', [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging imported-PR fixture skipped: self-app row missing', { slug: config.selfAppSlug });
    return;
  }

  const { rows: users } = await pool.query(
    `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 3`
  );
  if (!users.length) {
    log.warn('db', 'Staging imported-PR fixture skipped: no users');
    return;
  }
  const importer = users[0];
  const votesRequired = Math.max(1, Math.ceil(users.length / 2));

  // Fixture 1: healthy imported proposal with passing checks + yes votes.
  const headSha1 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  const branch1 = 'staging-fixture/imported-pr';
  let id1;
  {
    const { rows: have } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch1]
    );
    id1 = have[0]?.id;
    if (!id1) {
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_url, pr_title, pr_summary_md,
            status, source, imported_pr_head_sha, imported_pr_author,
            check_state, test_results, checks_commit_sha, checks_checked_at,
            votes_required, promoted_at, created_at)
         VALUES
           ($1, $2, $3, 9310, 'https://github.com/example/example/pull/9310',
            '[staging fixture] Imported PR — feature from an external contributor',
            'In plain terms: an outside contributor built this on GitHub and it was imported here so the group can vote on it.',
            'promoted', 'imported', $4, 'octo-contributor',
            'passing', '[{"name":"loads with no console errors","status":"pass"}]'::jsonb,
            $4, NOW() - INTERVAL '10 minutes',
            $5, NOW() - INTERVAL '12 minutes', NOW() - INTERVAL '12 minutes')
         RETURNING id`,
        [appId, importer.id, branch1, headSha1, votesRequired]
      );
      id1 = rows[0].id;
    } else {
      await pool.query(
        `UPDATE chat_sessions
            SET source = 'imported', imported_pr_head_sha = $2,
                imported_pr_author = 'octo-contributor', check_state = 'passing',
                checks_commit_sha = $2, checks_checked_at = NOW()
          WHERE id = $1`,
        [id1, headSha1]
      );
    }
    // A yes vote or two so the tally pill fills.
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
       VALUES ($1, $2, 'yes', NOW() - INTERVAL '9 minutes')
       ON CONFLICT (session_id, user_id) DO NOTHING`,
      [id1, importer.id]
    );
    if (users.length > 1) {
      await pool.query(
        `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
         VALUES ($1, $2, 'yes', NOW() - INTERVAL '8 minutes')
         ON CONFLICT (session_id, user_id) DO NOTHING`,
        [id1, users[1].id]
      );
    }
  }

  // Fixture 2: imported proposal whose head just moved — tally reset, a
  // re-review note in its thread, checks re-running against the new head.
  const headSha2 = 'f0e9d8c7b6a5049382716f5e4d3c2b1a09f8e7d6';
  const branch2 = 'staging-fixture/imported-pr-updated';
  let id2;
  {
    const { rows: have } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch2]
    );
    id2 = have[0]?.id;
    if (!id2) {
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_url, pr_title, pr_summary_md,
            status, source, imported_pr_head_sha, imported_pr_author,
            check_state, check_phase, checks_commit_sha,
            votes_required, promoted_at, created_at)
         VALUES
           ($1, $2, $3, 9311, 'https://github.com/example/example/pull/9311',
            '[staging fixture] Imported PR — head updated, please re-review',
            'In plain terms: the contributor pushed new code to this PR, so earlier votes were cleared and the checks are running again.',
            'promoted', 'imported', $4, 'octo-contributor',
            -- The preview for this head is already up, so the run is in its
            -- TESTING half: renders "Running the automated tests…".
            'pending', 'testing', $4,
            $5, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes')
         RETURNING id`,
        [appId, importer.id, branch2, headSha2, votesRequired]
      );
      id2 = rows[0].id;
    } else {
      await pool.query(
        `UPDATE chat_sessions
            SET source = 'imported', imported_pr_head_sha = $2,
                imported_pr_author = 'octo-contributor', check_state = 'pending',
                check_phase = 'testing',
                checks_commit_sha = $2
          WHERE id = $1`,
        [id2, headSha2]
      );
    }
    // Tally reset: this row deliberately carries NO pr_votes. Post the
    // re-review note into the proposal's own thread (idempotent — only when
    // the thread has no message yet).
    const { rows: msgHave } = await pool.query(
      `SELECT 1 FROM chat_messages
        WHERE app_id = $1 AND thread_type = 'session' AND thread_ref = $2
        LIMIT 1`,
      [appId, id2]
    );
    if (!msgHave.length) {
      await pool.query(
        `INSERT INTO chat_messages
           (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
         VALUES ($1, NULL,
           '[Mock] The pull request was updated on GitHub — earlier votes were cleared, please re-review the new changes.',
           'system', 'session', $2, NOW() - INTERVAL '5 minutes')`,
        [appId, id2]
      );
    }
  }

  // Fixture 3 (#846): the state a user lands on the instant an import
  // completes — checks pending against the head, no staging preview yet, no
  // votes. In mock-GitHub mode a real staging import records a 'skipped'
  // verdict immediately, so this is the only way to review the
  // "Checks are starting…" / no-Preview-pill arrival page in a preview. It
  // also gives the dev-chat redirect guard something to redirect FROM: it's
  // owned by the seed importer, so opening
  // #app/<slug>/dev/sessions/<this id> must bounce to the proposal page.
  const headSha3 = 'c4d3b2a1908f7e6d5c4b3a29180f7e6d5c4b3a29';
  const branch3 = 'staging-fixture/imported-pr-fresh';
  let id3;
  {
    const { rows: have } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch3]
    );
    id3 = have[0]?.id;
    if (!id3) {
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_url, pr_title, pr_summary_md,
            status, source, imported_pr_head_sha, imported_pr_author,
            check_state, check_phase, checks_commit_sha, checks_checked_at,
            votes_required, promoted_at, created_at)
         VALUES
           ($1, $2, $3, 9312, 'https://github.com/example/example/pull/9312',
            '[staging fixture] Imported PR — just imported, preview still building',
            'In plain terms: this pull request was just imported from GitHub, so its preview is still being built and the automated checks haven''t finished yet.',
            'promoted', 'imported', $4, 'octo-contributor',
            -- Just imported: the SHA-pinned preview is still being built and
            -- its database cloned, so the run is in its BUILDING half —
            -- renders "Preparing the staging preview…".
            'pending', 'building', $4, NOW(),
            $5, NOW(), NOW())
         RETURNING id`,
        [appId, importer.id, branch3, headSha3, votesRequired]
      );
      id3 = rows[0].id;
    } else {
      // Re-stamp on every boot so the row keeps reading as "just imported"
      // (a fresh checks_checked_at is what keeps the pending block on the
      // plain spinner instead of the stale "re-run checks" affordance), and
      // clear any preview a sweep may have attached to it.
      await pool.query(
        `UPDATE chat_sessions
            SET source = 'imported', imported_pr_head_sha = $2,
                imported_pr_author = 'octo-contributor', check_state = 'pending',
                check_phase = 'building',
                checks_commit_sha = $2, checks_checked_at = NOW(),
                staging_url = NULL, staging_container_id = NULL,
                promoted_at = NOW()
          WHERE id = $1`,
        [id3, headSha3]
      );
    }
    // The import announcement the real route posts, so the arrival page has
    // a thread rather than an empty one. Idempotent, like fixture 2's note.
    const { rows: msgHave3 } = await pool.query(
      `SELECT 1 FROM chat_messages
        WHERE app_id = $1 AND thread_type = 'session' AND thread_ref = $2
        LIMIT 1`,
      [appId, id3]
    );
    if (!msgHave3.length) {
      await pool.query(
        `INSERT INTO chat_messages
           (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
         VALUES ($1, NULL, $3, 'vote', 'session', $2, NOW())`,
        [appId, id3,
         `[Mock] ${importer.username} imported PR #9312 — [staging fixture] Imported PR — just imported, preview still building for voting`]
      );
    }
  }

  log.info('db', 'Staging imported-PR fixtures seeded', {
    appId, healthy: id1, headChanged: id2, justImported: id3,
  });
}

// #1019: staging fixtures for the checks card at REALISTIC scale. Every
// declared dapp.json check now runs on every build, so this repo's own card
// went from ~12 rows to ~240 — and the rows stopped being equal in weight
// (blocking vs advisory vs pass). None of that is reviewable from a staging
// preview otherwise: a fresh staging DB's proposals have a handful of
// synthesized baseline checks at most, so the folding, the ordering, the
// advisory chip and the summary line all render on a sample too small to
// show whether they work.
//
// Two rows:
//   1. A big FAILING suite — 40 passes, one blocking failure with console
//      errors, two advisory failures, and the collapsed "didn't finish in
//      the run budget" row. Exercises ordering, the amber wrapper, the
//      badge count (which must say 1, not 4), and the pass fold.
//   2. A PASSING suite that still carries an advisory failure. This is the
//      case that reads wrong if the card keys its heading off row status
//      instead of the stored verdict: green wrapper, "every merge-blocking
//      check passed", merge NOT blocked.
// Also seeds the matching app_check_history so the Dev-side graduation
// story is coherent with what the cards claim.
// Idempotent (keyed on branch name), obviously-fake "[staging fixture]"
// content, strict no-op outside staging.
async function seedStagingChecksAdvisoryCard(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1', [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging checks-card fixture skipped: self-app row missing', { slug: config.selfAppSlug });
    return;
  }
  const { rows: users } = await pool.query(
    'SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 2'
  );
  if (!users.length) {
    log.warn('db', 'Staging checks-card fixture skipped: no users');
    return;
  }
  const author = users[0];
  const votesRequired = Math.max(1, Math.ceil(users.length / 2));

  const passRow = (i) => ({
    index: i,
    name: `[staging fixture] check ${i + 1} renders`,
    path: `/fixture/route-${i + 1}`,
    status: 'pass',
    advisory: false,
    consoleErrors: [],
    failureReason: '',
  });
  const passes = [];
  for (let i = 0; i < 40; i += 1) passes.push(passRow(i));

  const blockingFailure = {
    index: 40,
    name: '[staging fixture] standings screen shows a ranked list',
    path: '/standings',
    status: 'fail',
    advisory: false,
    consoleErrors: [
      { kind: 'console', message: 'TypeError: Cannot read properties of undefined (reading \'rank\')', source: '/js/standings.js:214' },
      { kind: 'pageerror', message: 'Uncaught (in promise) TypeError: rows.map is not a function', source: '' },
    ],
    failureReason: 'Expected element "[data-standings-row]" was not found',
  };
  const advisoryFailures = [
    {
      index: 41,
      name: '[staging fixture] legacy export screen loads',
      path: '/export',
      status: 'fail',
      advisory: true,
      consoleErrors: [{ kind: 'console', message: 'Failed to load resource: 404 (/api/export/manifest)', source: '' }],
      failureReason: 'Page returned HTTP 404',
    },
    {
      index: 42,
      name: '[staging fixture] archive filter chips render',
      path: '/archive',
      status: 'fail',
      advisory: true,
      consoleErrors: [],
      failureReason: 'Expected text "Filter" was not found on the page',
    },
  ];
  const unfinishedRow = {
    index: -1,
    name: '3 checks did not finish in the run budget',
    path: '',
    status: 'fail',
    advisory: true,
    consoleErrors: [],
    failureReason: 'These checks have never been observed passing, so they do not block the merge.',
  };

  const failingResults = [blockingFailure, ...advisoryFailures, unfinishedRow, ...passes];
  const passingResults = [
    ...passes,
    {
      index: 41,
      name: '[staging fixture] legacy export screen loads',
      path: '/export',
      status: 'fail',
      advisory: true,
      consoleErrors: [],
      failureReason: 'Page returned HTTP 404',
    },
  ];

  const seedOne = async (branch, prNumber, title, checkState, results, sha) => {
    const { rows: have } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch]
    );
    if (have[0]?.id) {
      await pool.query(
        `UPDATE chat_sessions
            SET check_state = $2, test_results = $3::jsonb,
                checks_commit_sha = $4, checks_checked_at = NOW() - INTERVAL '6 minutes',
                check_phase = NULL, check_error_detail = NULL
          WHERE id = $1`,
        [have[0].id, checkState, JSON.stringify(results), sha]
      );
      return have[0].id;
    }
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_url, pr_title, pr_summary_md,
          status, check_state, test_results, checks_commit_sha, checks_checked_at,
          votes_required, promoted_at, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6,
          'In plain terms: a fixture proposal that exists so the checks card can be reviewed at the row counts it now really sees.',
          'promoted', $7, $8::jsonb, $9, NOW() - INTERVAL '6 minutes',
          $10, NOW() - INTERVAL '8 minutes', NOW() - INTERVAL '8 minutes')
       RETURNING id`,
      [appId, author.id, branch, prNumber,
       `https://github.com/example/example/pull/${prNumber}`, title,
       checkState, JSON.stringify(results), sha, votesRequired]
    );
    return rows[0].id;
  };

  const failingId = await seedOne(
    'staging-fixture/checks-advisory-failing', 9401,
    '[staging fixture] Big check suite — one blocking failure, two advisory',
    'failing', failingResults, '11223344556677889900aabbccddeeff00112233'
  );
  const passingId = await seedOne(
    'staging-fixture/checks-advisory-passing', 9402,
    '[staging fixture] Big check suite — passing, with an advisory failure',
    'passing', passingResults, '445566778899aabbccddeeff0011223344556677'
  );

  // Matching history: the 40 passes and the blocking failure have all been
  // observed passing at some point (so they gate), the advisory ones never
  // have (first_passed_at NULL). Without these rows the cards would claim a
  // graduation state the Dev-side data doesn't back up.
  const crypto = require('crypto');
  const key = (name, p) => crypto.createHash('sha256').update(`${name}\n${p}`).digest('hex');
  const graduated = passes.concat([blockingFailure]);
  for (const r of graduated) {
    await pool.query(
      `INSERT INTO app_check_history
         (app_id, check_key, check_name, check_path, first_passed_at, last_passed_at, last_seen_at, pass_count)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '30 days', NOW() - INTERVAL '1 day', NOW(), 12)
       ON CONFLICT (app_id, check_key) DO NOTHING`,
      [appId, key(r.name, r.path), r.name, r.path]
    );
  }
  for (const r of advisoryFailures) {
    await pool.query(
      `INSERT INTO app_check_history
         (app_id, check_key, check_name, check_path, last_failed_at, last_seen_at, fail_count)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 day', NOW(), 5)
       ON CONFLICT (app_id, check_key) DO NOTHING`,
      [appId, key(r.name, r.path), r.name, r.path]
    );
  }

  log.info('db', 'Staging checks-card fixtures seeded', {
    appId, failing: failingId, passing: passingId, rows: failingResults.length,
  });
}

// #967 (hosted MCP connector, pass 2): staging fixtures for a proposal that
// arrived through the connector — the user asked Claude Code on the web (or
// Codex) to build it, their own agent pushed to their own fork on their own
// subscription, and submit_work turned that branch into an ordinary imported
// proposal. Nothing about the row is special except chat_sessions
// .external_agent, so these fixtures exist to make the provenance surfaces
// reviewable in a staging preview without a real GitHub fork round-trip:
//
//   1. claude-code — "built with Claude Code" in the card's meta line and on
//      the change page's hero, beside "imported from GitHub". (#2588 retired
//      the longer "on their own coding-agent subscription, from a branch in
//      their GitHub fork" note that used to repeat it as a row of the steps
//      sheet; the provenance itself is still on both surfaces.)
//   2. codex — the same surfaces with the other agent, proving the label is
//      driven by the column rather than hardcoded, and that two agent chips
//      can sit side by side in one vote panel.
//
// source stays exactly 'imported': the connector adds an author, not a new
// kind of proposal, and every downstream imported-PR behaviour (no in-app dev
// session, head-change vote reset, GitHub-maintained note) must still apply.
// Idempotent on branch name, obviously-fake "[staging fixture]" content,
// strict no-op outside staging.
async function seedStagingExternalAgentProposal(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1', [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging external-agent fixture skipped: self-app row missing', { slug: config.selfAppSlug });
    return;
  }

  const { rows: users } = await pool.query(
    `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 3`
  );
  if (!users.length) {
    log.warn('db', 'Staging external-agent fixture skipped: no users');
    return;
  }
  const proposer = users[0];
  const votesRequired = Math.max(1, Math.ceil(users.length / 2));

  // The fork the work order would have pointed the agent at. Fake owner, so
  // the GitHub links are obviously non-resolving like the rest of the
  // imported fixtures.
  const forkOwner = `${proposer.username || 'someone'}-fixture`;

  const rows = [
    {
      branch: 'staging-fixture/external-agent-claude-code',
      prNumber: 9320,
      headSha: 'b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8',
      agent: 'claude-code',
      title: '[staging fixture] Built with Claude Code — keyboard shortcuts for the vote panel',
      summary: 'In plain terms: a member asked Claude Code on the web to build this. Their own coding agent wrote the code in their GitHub fork, and Homeroom opened the pull request so the group can vote on it.',
      body: '## What changed\n\nThe vote panel now supports keyboard shortcuts for casting and clearing a vote.\n\n## How to test\n\n1. Focus the vote panel.\n2. Use the displayed shortcuts.\n3. Confirm the selected vote updates without leaving the proposal.',
    },
    {
      branch: 'staging-fixture/external-agent-codex',
      prNumber: 9321,
      headSha: 'd2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3',
      agent: 'codex',
      title: '[staging fixture] Built with Codex — remember the last tab you were on',
      summary: 'In plain terms: a member asked Codex to build this from their ChatGPT account. Their own coding agent wrote the code in their GitHub fork, and Homeroom opened the pull request so the group can vote on it.',
      body: '## What changed\n\nThe Dev screen remembers the last tab you selected and restores it when you return.\n\n## How to test\n\n1. Select a different Dev tab.\n2. Leave the screen and return.\n3. Confirm the selected tab is restored.',
    },
  ];

  const seeded = {};
  for (const row of rows) {
    const { rows: have } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, row.branch]
    );
    let id = have[0]?.id;
    if (!id) {
      const { rows: ins } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_url, pr_title, pr_summary_md, pr_body,
            status, source, external_agent, imported_pr_head_sha, imported_pr_author,
            check_state, test_results, checks_commit_sha, checks_checked_at,
            votes_required, promoted_at, created_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8,
            'promoted', 'imported', $9, $10, $11,
            'passing', '[{"name":"loads with no console errors","status":"pass"}]'::jsonb,
            $10, NOW() - INTERVAL '6 minutes',
            $12, NOW() - INTERVAL '7 minutes', NOW() - INTERVAL '7 minutes')
         RETURNING id`,
        [appId, proposer.id, row.branch, row.prNumber,
         `https://github.com/example/example/pull/${row.prNumber}`,
         row.title, row.summary, row.body, row.agent, row.headSha, forkOwner, votesRequired]
      );
      id = ins[0].id;
    } else {
      // Re-stamp the provenance columns on every boot so an older fixture row
      // from before this pass picks up external_agent instead of quietly
      // rendering without the chip the fixture exists to show.
      await pool.query(
        `UPDATE chat_sessions
            SET source = 'imported', external_agent = $2,
                imported_pr_head_sha = $3, imported_pr_author = $4,
                pr_body = $5,
                check_state = 'passing', checks_commit_sha = $3,
                checks_checked_at = NOW()
          WHERE id = $1`,
        [id, row.agent, row.headSha, forkOwner, row.body]
      );
    }
    // One yes vote so the tally pill renders next to the chip rather than an
    // empty slot; the second row stays unvoted so the "Vote" nudge shows too.
    if (row.agent === 'claude-code') {
      await pool.query(
        `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
         VALUES ($1, $2, 'yes', NOW() - INTERVAL '5 minutes')
         ON CONFLICT (session_id, user_id) DO NOTHING`,
        [id, proposer.id]
      );
    }
    seeded[row.agent] = id;
  }

  log.info('db', 'Staging external-agent proposal fixtures seeded', { appId, ...seeded });
}

// #390: fixtures for the boot-time auto-merge reconcile sweep. Auto-merge
// used to fire only in the background of a live vote, so a proposal that
// crossed the vote-majority threshold while the platform was down stayed
// stuck "up for voting" forever. The boot sweep (reconcileEligibleMerges in
// server.js) now re-evaluates every open proposal at startup and merges the
// eligible ones. These fixtures make that scenario visible in the Dev vote
// panel without live voting:
//
//   1. An OVER-THRESHOLD promoted proposal (more yes votes than the active-
//      user majority, clean/no-conflict, no merged_at) — "approved while the
//      platform was down". This is what the boot sweep would merge.
//   2. A BELOW-THRESHOLD promoted proposal (no yes votes) — must be left
//      untouched by the sweep (the #380 "no pre-emptive resolution" bar).
//   3. A row stuck in 'merging' with no real GitHub merge (crash mid-merge).
//      recoverStuckMerges demotes it back to 'promoted' on boot, then the
//      reconcile sweep re-evaluates it — demonstrating the chained ordering.
//
// All three use fake high pr_numbers and obviously-fake "[staging fixture]"
// titles, keyed off their unique branch names for idempotency. The 'merging'
// row is reset to 'merging' on each seed run (it runs during migrate, before
// recoverStuckMerges) so the ordering is re-demonstrated on every boot. A
// strict no-op outside staging.
async function seedStagingRestartEligibleMerge(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging restart-eligible-merge fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: users } = await pool.query(
    `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 3`
  );
  if (!users.length) {
    log.warn('db', 'Staging restart-eligible-merge fixture skipped: no users');
    return;
  }
  const votesRequired = Math.max(1, Math.ceil(users.length / 2));

  // Helper: ensure a promoted fixture session exists for a branch, returning
  // its id. Clean (behind_main = 0, no conflict snapshot) so it reads as
  // directly mergeable.
  const ensureSession = async (branch, prNumber, title, status) => {
    const { rows: have } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch]
    );
    if (have.length) {
      // Keep the 'merging' fixture pinned to 'merging' on each boot so the
      // recoverStuckMerges → reconcile ordering is re-demonstrated; leave the
      // promoted fixtures as-is (a real merge during testing should stick).
      if (status === 'merging') {
        await pool.query(
          `UPDATE chat_sessions SET status = 'merging' WHERE id = $1 AND status <> 'merged'`,
          [have[0].id]
        );
      }
      return have[0].id;
    }
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status,
          votes_required, behind_main, merge_conflict_state, conflict_checked_at, created_at)
       VALUES
         ($1, $2, $3, $4, $5,
          'In plain terms: a seeded demo proposal used to exercise the boot-time auto-merge sweep.',
          $6, $7, 0, 'clean', NOW(), NOW() - INTERVAL '40 minutes')
       RETURNING id`,
      [appId, users[0].id, branch, prNumber, title, status, votesRequired]
    );
    return rows[0].id;
  };

  const addYesVote = async (sessionId, userId, minutesAgo) => {
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
       VALUES ($1, $2, 'yes', NOW() - ($3::int * INTERVAL '1 minute'))
       ON CONFLICT (session_id, user_id) DO NOTHING`,
      [sessionId, userId, minutesAgo]
    );
  };

  // 1. Over-threshold "approved while the platform was down" proposal: every
  //    available user (up to 3) has voted yes, comfortably past the majority.
  const eligibleId = await ensureSession(
    'staging-fixture/restart-eligible-merge', 9210,
    '[staging fixture] Approved while platform was down — should auto-merge on boot',
    'promoted'
  );
  for (let i = 0; i < users.length; i++) await addYesVote(eligibleId, users[i].id, 38 - i);

  // 2. Below-threshold proposal: no yes votes, so the sweep must skip it.
  await ensureSession(
    'staging-fixture/restart-below-threshold', 9211,
    '[staging fixture] Not enough votes yet — must NOT auto-merge',
    'promoted'
  );

  // 3. Crash-mid-merge row: stuck in 'merging' with a fake PR. recoverStuckMerges
  //    demotes it to 'promoted' on boot; the reconcile sweep then re-evaluates it.
  const mergingId = await ensureSession(
    'staging-fixture/restart-stuck-merging', 9212,
    '[staging fixture] Stuck mid-merge across a restart — should recover',
    'merging'
  );
  for (let i = 0; i < users.length; i++) await addYesVote(mergingId, users[i].id, 36 - i);

  log.info('db', 'Staging restart-eligible-merge fixtures seeded', {
    appId, eligibleId, mergingId, votesRequired,
  });
}

// Community-voted priority + assigned-person votes on the staging
// my-open-PR fixture proposal, so a prod-cloned staging preview shows the
// chips backed by REAL topic_attribute_votes rows — a clear winner, more
// than one voter, and the viewer's own pick highlighted in the dropdown
// (the admin/target user votes, and the admin is who staging logs in as).
// Idempotent via the UNIQUE(app_id, target_type, target_ref, field,
// user_id) constraint. No-op outside staging.
async function seedStagingTopicAttributes(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) return;

  const { rows: users } = await pool.query(
    `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 3`
  );
  if (!users.length) return;
  const u0 = users[0];
  const u1 = users[1] || users[0];
  const u2 = users[2] || users[0];

  // #1187: the assignee picker is a TOGGLE — clicking your own pick
  // withdraws it. Make that state URL-reachable for checks/screenshots:
  // real assignee votes on mock issue 900009 (the card the existing
  // shot=card-menu&row=assignee deep link opens), cast BY the two capture
  // identities — proposal checks run as usernode-capture-admin and
  // screenshots as usernode-capture (services/visuals.js), so keying the
  // votes to those rows (not "the first admins", which a prod-cloned DB
  // orders differently) is what guarantees the picker opens with the
  // VIEWER's own pick checked and re-clickable for both. The value is the
  // obviously-fake staging-demo-user, matching the synthetic summaries the
  // demo feed paints. Mock issue numbers are safe targets:
  // topic_attribute_votes carries no FK to issues.
  const { rows: capRows } = await pool.query(
    `SELECT id FROM users
      WHERE username IN ('usernode-capture', 'usernode-capture-admin')
      ORDER BY id ASC`
  );
  for (let i = 0; i < capRows.length; i++) {
    await pool.query(
      `INSERT INTO topic_attribute_votes
         (app_id, target_type, target_ref, field, value, user_id, created_at)
       VALUES ($1, 'issue', 900009, 'assignee', 'staging-demo-user', $2,
               NOW() - ($3 || ' minutes')::interval)
       ON CONFLICT (app_id, target_type, target_ref, field, user_id) DO NOTHING`,
      [appId, capRows[i].id, String(26 - i)]
    );
  }

  const { rows: sessRows } = await pool.query(
    `SELECT id FROM chat_sessions
      WHERE app_id = $1 AND branch_name = $2 LIMIT 1`,
    [appId, 'staging-fixture/my-open-pr']
  );
  if (!sessRows.length) {
    log.warn('db', 'Staging topic-attribute fixture skipped: open-PR fixture missing');
    return;
  }
  const sessionId = sessRows[0].id;

  // priority: u0 + u1 → 'high' (clear winner, includes the viewer), u2 → 'low'.
  // assignee: u0 + u1 → @<u1.username> (winner), u2 → @<u0.username>.
  const votes = [
    ['priority', 'high', u0.id, "NOW() - INTERVAL '30 minutes'"],
    ['priority', 'high', u1.id, "NOW() - INTERVAL '25 minutes'"],
    ['priority', 'low', u2.id, "NOW() - INTERVAL '20 minutes'"],
    ['assignee', u1.username, u0.id, "NOW() - INTERVAL '28 minutes'"],
    ['assignee', u1.username, u1.id, "NOW() - INTERVAL '24 minutes'"],
    ['assignee', u0.username, u2.id, "NOW() - INTERVAL '22 minutes'"],
  ];
  // De-dup the per-user upserts when the staging DB has fewer than 3 users
  // (u1/u2 collapse onto u0): keep the first vote seen per (field, user).
  const seen = new Set();
  for (const [field, value, uid, when] of votes) {
    const key = `${field}:${uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await pool.query(
      `INSERT INTO topic_attribute_votes
         (app_id, target_type, target_ref, field, value, user_id, created_at)
       VALUES ($1, 'proposal', $2, $3, $4, $5, ${when})
       ON CONFLICT (app_id, target_type, target_ref, field, user_id) DO NOTHING`,
      [appId, sessionId, field, value, uid]
    );
  }

  log.info('db', 'Staging topic-attribute votes seeded', { appId, sessionId });
}

// #363: the topic sub-view (issue / PR proposal / governance proposal) now
// scrolls as ONE region — the topic card/body and the discussion share a
// single scroller, with only the back bar and composer pinned. That unified
// scroll is only visible when a topic carries enough content to overflow one
// screen, so seed a long human discussion thread for one topic of EACH kind:
//
//   - a GitHub issue   → thread_type 'issue',      ref = mock issue #900001
//   - a PR proposal    → thread_type 'session',    ref = the open-PR fixture
//   - a governance prop → thread_type 'governance', ref = the env-var fixture
//
// Idempotent: each row is keyed on (app_id, thread_type, thread_ref, content)
// and skipped if already present (chat_messages.id is SERIAL, so we don't pin
// ids). Strictly a no-op outside staging. Anchors are the fixtures seeded
// earlier in this run; any missing anchor is skipped with a warning.
async function seedStagingTopicScrollThreads(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging topic-scroll threads skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  // A few authors so the thread reads like a real back-and-forth. Falls back
  // to a single author when staging has only one user.
  const { rows: userRows } = await pool.query(
    `SELECT id FROM users ORDER BY is_admin DESC, id ASC LIMIT 3`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging topic-scroll threads skipped: no users');
    return;
  }
  const authorIds = userRows.map((u) => u.id);

  // Resolve the PR-proposal anchor (the open-PR fixture session).
  const { rows: sessRows } = await pool.query(
    `SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1`,
    [appId, 'staging-fixture/my-open-pr']
  );
  const sessionRef = sessRows[0]?.id || null;

  // Resolve the governance anchor (the env-var change proposal fixture).
  const { rows: govRows } = await pool.query(
    `SELECT id FROM issues WHERE app_id = $1 AND title = $2 LIMIT 1`,
    [appId, 'Set secret "STAGING_DEMO_PUBLIC_URL"']
  );
  const govRef = govRows[0]?.id || null;

  // The GitHub-issue anchor: mock issue #900001, always served in staging by
  // the mock-issues fallback in routes/issues.js. Thread ref = issue number.
  const issueRef = 900001;

  // 18 human turns — long enough that header + messages overflow one screen
  // and the single scroller is genuinely exercised on every preview.
  const bodies = [
    'Kicking off the discussion here — does the proposed direction match what we agreed in the last round?',
    'I think it does, but I want to double-check the edge cases before we commit.',
    'Good point. The main risk I see is the narrow-phone layout — has anyone tried it at 360px?',
    'Tried it on my end; the action row wraps cleanly now, no overflow past the card edge.',
    'Nice. What about dark mode — does the contrast still pass on the muted text?',
    'Contrast is fine in dark mode. Light mode the secondary text is a touch low but acceptable.',
    'Can we keep the change scoped? I’d rather not expand into a full redesign in one pass.',
    'Agreed, let’s keep it tight. Follow-ups can be their own proposals.',
    'One more thing: how does this behave when the body is really long?',
    'That’s exactly the case we’re testing — the whole thing should scroll as one continuous area.',
    'So the header and the conversation move together, and only the reply box stays put?',
    'Right, only the back bar at the top and the composer at the bottom are pinned.',
    'That matches the main group chat, which is what people kept asking for.',
    'Reading from the top down feels much more natural than two boxes fighting for space.',
    'Did the vote roster and the Ask-AI button survive the move into the scroll area?',
    'They did — still interactive, they just scroll up with the rest of the header now.',
    'Great. I’m comfortable voting this through once the preview looks right.',
    'Same here. Scroll all the way down to confirm the composer never gets pushed off-screen.',
  ];

  const seedThread = async (threadType, threadRef, label) => {
    if (!threadRef) {
      log.warn('db', 'Staging topic-scroll thread skipped: missing anchor', { threadType });
      return 0;
    }
    const messages = bodies.map((body, i) => ({
      user_id: authorIds[i % authorIds.length],
      content: `[Staging demo] ${label} #${i + 1}: ${body}`,
      minutes_ago: (bodies.length - i) * 4,
    }));
    const result = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
       SELECT $1::int, m.user_id, m.content, 'message', $2::text, $3::int,
              NOW() - (m.minutes_ago * INTERVAL '1 minute')
         FROM jsonb_to_recordset($4::jsonb) AS m(user_id int, content text, minutes_ago int)
        WHERE NOT EXISTS (
          SELECT 1 FROM chat_messages existing
           WHERE existing.app_id = $1 AND existing.thread_type = $2
             AND existing.thread_ref = $3 AND existing.content = m.content
        )
        ORDER BY m.minutes_ago DESC`,
      [appId, threadType, threadRef, JSON.stringify(messages)]
    );
    return result.rowCount;
  };

  const n1 = await seedThread('issue', issueRef, 'issue thread');
  const n2 = await seedThread('session', sessionRef, 'proposal thread');
  const n3 = await seedThread('governance', govRef, 'governance thread');

  log.info('db', 'Staging topic-scroll threads seeded', {
    appId, issueRef, sessionRef, govRef, inserted: n1 + n2 + n3,
  });
}

// #313/#321/#827: a PROMOTED proposal owned by a user OTHER than the
// tester, so the card-level "✨ Explore in dev chat" pill (rendered only on
// proposals you do NOT own) is exercisable in staging.
// seedStagingMyOpenPr covers the owned case; this covers the non-owned case
// those issues are about. Opening this proposal FULL-SCREEN is also how a
// tester confirms the pill is the ONLY AI affordance in the topic head.
// #827 dropped the advisor-history rows this used to seed alongside the
// session (the panel they populated is gone). Idempotent via branch name; a
// no-op outside staging.
async function seedStagingOtherUserProposal(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging other-user-proposal fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: users } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 5`
  );
  if (!users.length) {
    log.warn('db', 'Staging other-user-proposal fixture skipped: no users');
    return;
  }
  // The tester logs in as the first admin (same selection as the other
  // fixtures). The proposal must be owned by SOMEONE ELSE so the card has
  // no "Open session" button and the Explore-in-dev-chat pill renders.
  const tester = users[0];
  const owner = users.find((u) => u.id !== tester.id);
  if (!owner) {
    log.warn('db', 'Staging other-user-proposal fixture skipped: need a second user');
    return;
  }

  const branch = 'staging-fixture/other-user-open-pr';
  let sessionId;
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (existing.length) {
    sessionId = existing[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status,
          votes_required, created_at)
       VALUES
         ($1, $2, $3, 9300,
          '[staging fixture] Another user''s proposal — explore it in dev chat',
          $5, 'promoted', $4, NOW() - INTERVAL '20 minutes')
       RETURNING id`,
      [appId, owner.id, branch, Math.max(1, Math.ceil(users.length / 2)),
       'In plain terms: another collaborator proposed a small improvement to the app. This summary explains what it does for users before you vote.']
    );
    sessionId = rows[0].id;
  }

  // The owner's own yes-vote so the tally pill renders a realistic fill.
  await pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
     VALUES ($1, $2, 'yes', NOW() - INTERVAL '19 minutes')
     ON CONFLICT (session_id, user_id) DO NOTHING`,
    [sessionId, owner.id]
  );

  log.info('db', 'Staging other-user-proposal fixture seeded', {
    appId, ownerUser: owner.username, testerUser: tester.username, sessionId,
  });
}

// Archive-restore fixtures (#287-style regression): seed the two states
// that exercise the restored Archive action but are hard to reach by
// clicking around in a fresh staging container.
//
//  1. A viewer-owned PROMOTED session with NO warm worker. Because it's
//     never registered in worker.warmRegistrySnapshot(), GET
//     /api/apps/:slug/sessions reports `warm: false`, exactly the
//     cold-promoted case that used to lose its Archive button in the
//     dev-chat session list — and the same proposer-owned promoted state
//     the proposal card now shows an Archive button for on the Dev feed.
//  2. A viewer-owned ARCHIVED session so the Unarchive control and the
//     archived-inline listing are visible without first archiving one.
//
// Owned by the user the tester logs in as (first admin, same selection
// as the other session fixtures) so both appear in that user's own
// owner-scoped sessions list. chat_sessions is staging:private (copied
// schema-only into staging), hence the seed. Idempotent via the
// branch-name existence check; strictly a no-op outside staging.
async function seedStagingArchiveProposalFixtures(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging archive-proposal fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: users } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 3`
  );
  if (!users.length) {
    log.warn('db', 'Staging archive-proposal fixtures skipped: no users');
    return;
  }
  const owner = users[0];
  const votesRequired = Math.max(1, Math.ceil(users.length / 2));

  // Cold promoted proposal — PR up for vote, worker spun down.
  const coldBranch = 'staging-fixture/archive-cold-promoted';
  const { rows: coldExisting } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, coldBranch]
  );
  let coldSessionId = coldExisting[0]?.id;
  if (!coldSessionId) {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, pr_url, status,
          votes_required, created_at, promoted_at)
       VALUES
         ($1, $2, $3, 9300,
          '[Mock] Cold promoted proposal — worker spun down, still archivable',
          'https://github.com/usernode-staging/demo/pull/9300',
          'promoted', $4,
          NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')
       RETURNING id`,
      [appId, owner.id, coldBranch, votesRequired]
    );
    coldSessionId = rows[0].id;
  }
  // The author's own yes-vote so the tally pill renders a realistic fill.
  await pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
     VALUES ($1, $2, 'yes', NOW() - INTERVAL '3 days')
     ON CONFLICT (session_id, user_id) DO NOTHING`,
    [coldSessionId, owner.id]
  );

  // Already-archived session — shows the Unarchive control + archived
  // row in the inline session list.
  const archivedBranch = 'staging-fixture/archive-already-archived';
  const { rows: archivedExisting } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, archivedBranch]
  );
  if (!archivedExisting.length) {
    await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, status,
          created_at, promoted_at, archived_at)
       VALUES
         ($1, $2, $3, 9301,
          '[Mock] Archived proposal — restorable via Unarchive',
          'archived',
          NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days',
          NOW() - INTERVAL '1 day')`,
      [appId, owner.id, archivedBranch]
    );
  }

  // Active, non-promoted session — surfaces as a chip in the viewer's
  // "Your dev session" strip with the new inline Archive button. No
  // promoted_at so it stays a live in-progress session (not a proposal
  // card). /api/me/active-sessions (status IN active/promoted/paused)
  // returns it and the strip filters to active/paused for this app.
  const activeBranch = 'staging-fixture/archive-active';
  const { rows: activeExisting } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, activeBranch]
  );
  if (!activeExisting.length) {
    await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_title, status, created_at)
       VALUES
         ($1, $2, $3, '[Mock] Active session — archivable from the strip',
          'active', NOW() - INTERVAL '2 hours')`,
      [appId, owner.id, activeBranch]
    );
  }

  // Paused, non-promoted session — exercises the paused-row variant of
  // the strip chip (status tag + Archive button).
  const pausedBranch = 'staging-fixture/archive-paused';
  const { rows: pausedExisting } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, pausedBranch]
  );
  if (!pausedExisting.length) {
    await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_title, status, created_at)
       VALUES
         ($1, $2, $3, '[Mock] Paused session — archivable from the strip',
          'paused', NOW() - INTERVAL '1 day')`,
      [appId, owner.id, pausedBranch]
    );
  }

  log.info('db', 'Staging archive-proposal fixtures seeded', {
    appId,
    owner: owner.username,
    coldSessionId,
  });
}

// Topochain (testnet competition) staging fixtures (plan Task 4; SPEC §6
// staging privacy 3080-3088).
//
// The topochain block of schema.sql (Task 1) is brand new — its 22
// tables never carry a row outside a real topochain data load (Task
// 16's §8 load script), and several of them (`token_allocation`,
// `user_terms_consents`, and the mobile_* tables) are additionally
// `staging:private` at the TABLE level, so a staging clone truncates
// them entirely (schema.sql:2743-2756). Without a seed, every /api/v4
// public/admin/mobile screen built in later tasks has nothing to render
// in a staging preview. This seeds one deterministic, self-contained
// fixture set — a season, two season_events, a challenge taxonomy, six
// users, onchain accounts, a points ledger, two leaderboard snapshots,
// and the supporting settings/terms/version-gate/token rows — so the
// whole surface is exercisable end to end. It has since grown a second,
// CLOSED season plus an archive event and a deliberately challenge-free
// one, two block-producer-queue users and three waitlist signups — all of
// them for the admin console (Seasons, Events & Challenges), whose lists
// each had exactly one state to show while a single running season was the
// only thing seeded. `topochain_*` platform_settings are NOT seeded here:
// schema.sql:3819-3834 inserts all seven on every boot, so the settings
// screen is already populated and a second copy would only drift.
//
// Idempotent via fixed ids in the 900500+ range (this platform's
// "obviously fake, staging-demo" numbering convention — see
// seedStagingWalletUsers, seedStagingLeaderboardProfile above) plus
// `ON CONFLICT (id) DO NOTHING` (or the table's own natural unique,
// e.g. app_version_configs.os) on every insert, so a reboot never
// duplicates rows. Strict no-op outside staging; best-effort (try/catch
// + log.warn) so a fixture bug never blocks boot, matching
// seedStagingDbExports/seedStagingWalletUsers above.
//
// Scope invariants (app/ETL-enforced per the schema.sql comments on
// user_enrollments/onchain_accounts — no cross-table DB CHECK exists):
// every row that carries a season_event_id must carry THAT event's
// season_id. Enforced below by construction: every event-scoped row
// literally reuses SEASON_ID alongside its season_event_id. The closed
// season owns exactly one event (EVENT_ARCHIVE_ID) and no scoped rows
// point at it, so adding it cannot break that invariant.
async function seedStagingTopochain(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  // ─── IDs (one constant block per table; see header comment) ──────────
  // Declared at function scope, not inside the try below, because the two
  // sections that follow are separate failure domains and both need them.
  const SEASON_ID = 900500;
  const EVENT_REGULAR_ID = 900500; // season_events — type 'regular'
  const EVENT_SEASON_ID = 900501;  // season_events — type 'season'
  // Fully-past event. The two above both span "now", so without this one
  // the between-events fallback (public/js/topochain-events.js) can never
  // fire in a preview — pick it from the leaderboard's event picker to
  // see the "Nothing is running right now" state.
  const EVENT_ENDED_ID = 900502;

  // A SECOND season, closed (is_active = FALSE, ends_at in the past), and
  // two more events — added for the Seasons, Events & Challenges admin
  // console, where a single always-active season left three screens
  // showing only one state each:
  //   - Seasons list: no closed row, so the inactive badge never rendered.
  //   - Season events: every row hung off the same season, so the
  //     season column read as decoration rather than as a scope.
  //   - Challenges: every event had challenges, so the per-event EMPTY
  //     state ("No challenges yet") was unreachable in a preview — and an
  //     empty state nobody can look at is an empty state nobody approved.
  // EVENT_ARCHIVE_ID belongs to the CLOSED season, EVENT_EMPTY_ID to the
  // active one; the scope invariant (a row carrying a season_event_id
  // carries THAT event's season_id) holds for both by construction.
  const SEASON_CLOSED_ID = 900501;
  const EVENT_ARCHIVE_ID = 900503; // on SEASON_CLOSED_ID; has challenges
  const EVENT_EMPTY_ID = 900504;   // on SEASON_ID; deliberately has NONE

  // A THIRD season and a season-less event, added with the Seasons admin
  // CRUD (/api/v4/admin/seasons). Both exist to make a state reachable in
  // a preview that the two seasons above cannot produce:
  //   - SEASON_INTERNAL_ID is internal = TRUE (the Internal badge) AND
  //     has NO events, enrollments, onchain accounts or allocations —
  //     which makes it the one season whose DELETE actually succeeds.
  //     Deleting either of the other two returns the 409 `season_in_use`
  //     guard, so without this row the happy path could only be reviewed
  //     by first creating a season.
  //   - EVENT_UNASSIGNED_ID carries season_id = NULL, which nothing else
  //     in this fixture does: it is what the Seasons screen's "Events not
  //     assigned to a season" panel and the events list's `season_id=none`
  //     filter are for. Kept is_active = FALSE so no public surface picks
  //     it up (it has no season to scope a leaderboard to anyway).
  const SEASON_INTERNAL_ID = 900502;
  const EVENT_UNASSIGNED_ID = 900505;

  const USERS = {
    seasonWide1: 900500, // exclude_podium = TRUE
    seasonWide2: 900501,
    eventA1: 900502,
    eventA2: 900503,
    eventB1: 900504,
    mixed: 900505, // event-scoped AND season-wide enrollment; real password
    bpPending: 900506,  // block-producer queue: requested, not released
    bpReleased: 900507, // block-producer queue: requested AND released;
                        // the one row with accept_logs = FALSE
  };

  try {
    // Do this before the larger fixture block: any later best-effort seed
    // collision must not make the version-gate warning depend on how far a
    // long-lived cloned database got through the rest of the fixtures.
    // Production can carry an active Android rule; changing the staging copy
    // is deliberate and is reset on every preview boot.
    await pool.query(
      `UPDATE app_version_configs
          SET is_active = FALSE, updated_at = NOW()
        WHERE os = 'android'`
    );

    // ─── Users (8) ─────────────────────────────────────────────────────
    // Sentinel password for seven of the eight (never-login fixtures, same
    // idiom as seedStagingWalletUsers); the sixth gets a real bcrypt hash
    // so the "one with password set" requirement is exercisable.
    //
    // `bp_requested_at`/`bp_released_at` are the BLOCK-PRODUCER QUEUE the
    // admin console's Waitlist screen renders beside the platform waitlist
    // (GET /api/v4/admin/bp-queue is literally `users WHERE bp_requested_at
    // IS NOT NULL`). Participants 7 and 8 are the only rows in it, one per
    // side of that screen's pending/released filter — with neither, the
    // queue is empty in every preview and both the table and its filter
    // read as broken rather than as unused.
    //
    // Participant 8 is also the one row with `accept_logs = FALSE` (the
    // column defaults to TRUE), so the users screen shows both values of
    // the flag instead of a column that is the same all the way down.
    const realHash = await bcrypt.hash('staging-demo-topochain-password', 12);
    await pool.query(
      `INSERT INTO users
         (id, username, password, email, exclude_podium, accept_logs,
          bp_requested_at, bp_released_at)
       VALUES
         ($1, 'staging-demo-topochain-participant-1', '!staging-fixture-no-login!',
          'staging-demo-topochain-1@example.invalid', TRUE, TRUE, NULL, NULL),
         ($2, 'staging-demo-topochain-participant-2', '!staging-fixture-no-login!',
          'staging-demo-topochain-2@example.invalid', FALSE, TRUE, NULL, NULL),
         ($3, 'staging-demo-topochain-participant-3', '!staging-fixture-no-login!',
          'staging-demo-topochain-3@example.invalid', FALSE, TRUE, NULL, NULL),
         ($4, 'staging-demo-topochain-participant-4', '!staging-fixture-no-login!',
          'staging-demo-topochain-4@example.invalid', FALSE, TRUE, NULL, NULL),
         ($5, 'staging-demo-topochain-participant-5', '!staging-fixture-no-login!',
          'staging-demo-topochain-5@example.invalid', FALSE, TRUE, NULL, NULL),
         ($6, 'staging-demo-topochain-participant-6', $7,
          'staging-demo-topochain-6@example.invalid', FALSE, TRUE, NULL, NULL),
         ($8, 'staging-demo-topochain-participant-7', '!staging-fixture-no-login!',
          'staging-demo-topochain-7@example.invalid', FALSE, TRUE,
          NOW() - INTERVAL '12 days', NULL),
         ($9, 'staging-demo-topochain-participant-8', '!staging-fixture-no-login!',
          'staging-demo-topochain-8@example.invalid', FALSE, FALSE,
          NOW() - INTERVAL '25 days', NOW() - INTERVAL '20 days')
       ON CONFLICT (id) DO NOTHING`,
      [USERS.seasonWide1, USERS.seasonWide2, USERS.eventA1, USERS.eventA2,
       USERS.eventB1, USERS.mixed, realHash, USERS.bpPending, USERS.bpReleased]
    );

    // ─── Seasons (3): one running, one closed, one internal + empty ─────
    // The closed one is not decoration: the admin console's Seasons screen
    // renders an active/closed badge and orders by display_order, and with
    // a single always-active row neither the inactive badge nor the sort
    // was reviewable. It also gives the season events screen two distinct
    // scopes, so its season column reads as a scope rather than as a
    // constant.
    await pool.query(
      `INSERT INTO seasons
         (id, name, description, starts_at, ends_at, is_active, internal,
          display_order, pool_info, created_at, updated_at)
       VALUES
         ($1, 'Staging Demo Season — Topochain',
          'Fixture season for exercising the topochain staging surface end to end.',
          NOW() - INTERVAL '60 days', NOW() + INTERVAL '30 days', TRUE, FALSE, 0,
          'Staging demo token pool', NOW(), NOW()),
         ($2, 'Staging Demo Season — Archive',
          'Closed fixture season: ended months ago and is_active = FALSE, so the admin Seasons list has a non-running row to render.',
          NOW() - INTERVAL '240 days', NOW() - INTERVAL '150 days', FALSE, FALSE, 1,
          'Staging demo token pool (closed)', NOW(), NOW()),
         ($3, 'Staging Demo Season — Internal Dry Run',
          'Internal fixture season with nothing hanging off it: renders the Internal badge, and is the one row whose admin DELETE is not blocked by the season_in_use guard.',
          NOW() - INTERVAL '5 days', NOW() + INTERVAL '25 days', TRUE, TRUE, 2,
          'Staging demo token pool (internal)', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [SEASON_ID, SEASON_CLOSED_ID, SEASON_INTERNAL_ID]
    );

    // ─── Season events (2): one 'regular' with epochs + scoring_formula,
    // one type='season' ─────────────────────────────────────────────────
    await pool.query(
      `INSERT INTO season_events
         (id, season_id, name, description, starts_at, ends_at, is_active,
          scoring_formula, start_epoch, end_epoch, internal, display_leaderboard,
          score_start_time, score_end_time, display_disclaimer, chain_id,
          display_activities, type, created_at, updated_at)
       VALUES
         ($1, $3, 'Staging Demo Event — Block Production Sprint',
          'Regular event fixture with an epoch range and a scoring formula.',
          NOW() - INTERVAL '45 days', NOW() + INTERVAL '15 days', TRUE,
          '{"metrics": [], "offchain_weight": 1}'::jsonb, 100, 130, FALSE, TRUE,
          NOW() - INTERVAL '45 days', NOW() + INTERVAL '15 days', FALSE,
          'staging-demo-chain-1', TRUE, 'regular', NOW(), NOW()),
         ($2, $3, 'Staging Demo Event — Season Standings',
          'type=''season'' event fixture: its standings are the WHOLE season''s aggregate (computeStandings), not one event''s snapshots. Starts with this preview so cloned season rows cannot outrank it as the DEFAULT leaderboard — see DEFAULT_PUBLIC_EVENT_SQL step 1.',
          NOW(), NOW() + INTERVAL '30 days', TRUE,
          '{"metrics": [], "offchain_weight": 1}'::jsonb, NULL, NULL, FALSE, TRUE,
          NULL, NULL, FALSE, NULL, FALSE, 'season', NOW(), NOW()),
         ($4, $3, 'Staging Demo Event — Finished Sprint',
          'Fully-past event fixture. Selecting it exercises the between-events fallback: the leaderboard shows standings with a "nothing is running right now" caption instead of an error.',
          NOW() - INTERVAL '120 days', NOW() - INTERVAL '90 days', TRUE,
          '{"metrics": [], "offchain_weight": 1}'::jsonb, 60, 90, FALSE, TRUE,
          NOW() - INTERVAL '120 days', NOW() - INTERVAL '90 days', FALSE,
          'staging-demo-chain-1', TRUE, 'regular', NOW(), NOW()),
         -- On the CLOSED season, and is_active = FALSE: the admin events
         -- list is the only screen that shows an event outside the running
         -- season, and without this row its season filter had nothing to
         -- filter. Kept inactive so no public surface (the leaderboard's
         -- event picker, the between-events fallback) changes because of
         -- these two additions.
         ($5, $6, 'Staging Demo Event — Archive Sprint',
          'Inactive event on the closed season. Exercises the admin events list across two seasons; deliberately invisible to the public event picker.',
          NOW() - INTERVAL '230 days', NOW() - INTERVAL '200 days', FALSE,
          '{"metrics": [], "offchain_weight": 1}'::jsonb, 10, 40, FALSE, FALSE,
          NOW() - INTERVAL '230 days', NOW() - INTERVAL '200 days', FALSE,
          'staging-demo-chain-1', TRUE, 'regular', NOW(), NOW()),
         -- Deliberately CHALLENGE-FREE. Every other event here has
         -- challenges, so "No challenges yet" — the empty state the admin
         -- challenges list draws under a season event — could not be
         -- looked at in a preview. Nothing else about this row is special:
         -- that is the point, it is an ordinary event nobody has filled in.
         ($7, $3, 'Staging Demo Event — Unfilled Sprint',
          'Event with NO challenges, so the per-event empty state is reachable in a preview.',
          NOW() + INTERVAL '20 days', NOW() + INTERVAL '50 days', FALSE,
          '{"metrics": [], "offchain_weight": 1}'::jsonb, NULL, NULL, FALSE, FALSE,
          NULL, NULL, FALSE, NULL, FALSE, 'regular', NOW(), NOW()),
         -- season_id NULL: the only unassigned event in the fixture. See
         -- the EVENT_UNASSIGNED_ID note in the id block above.
         ($8, NULL, 'Staging Demo Event — Unassigned Sprint',
          'Event with no season at all, so the Seasons screen''s unassigned panel and the events list''s season_id=none filter both have something to show.',
          NOW() + INTERVAL '10 days', NOW() + INTERVAL '40 days', FALSE,
          '{"metrics": [], "offchain_weight": 1}'::jsonb, NULL, NULL, FALSE, FALSE,
          NULL, NULL, FALSE, NULL, FALSE, 'regular', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [EVENT_REGULAR_ID, EVENT_SEASON_ID, SEASON_ID, EVENT_ENDED_ID,
       EVENT_ARCHIVE_ID, SEASON_CLOSED_ID, EVENT_EMPTY_ID, EVENT_UNASSIGNED_ID]
    );

    // A staging database is cloned from production before these fixtures are
    // added. A newly-created real `type = 'season'` row in that clone can
    // therefore start after this fixed-id fixture was first seeded. The
    // default-event rule quite correctly chooses that newer row, but if it
    // has no standings yet the preview's default leaderboard is empty and the
    // fixture no longer exercises the table it exists to cover. Refresh only
    // the staging-demo row's window on every boot (the INSERT above remains
    // idempotent) so it deterministically wins among started season rows.
    await pool.query(
      `UPDATE season_events
          SET starts_at = NOW(),
              ends_at = NOW() + INTERVAL '30 days',
              updated_at = NOW()
        WHERE id = $1`,
      [EVENT_SEASON_ID]
    );

    // ─── Challenge kinds (4) ────────────────────────────────────────────
    await pool.query(
      `INSERT INTO challenge_kinds (id, name, description, icon, created_at, updated_at)
       VALUES
         ('REPORT_BUG_CHALLENGE', 'Report a bug',
          'Find and report a reproducible bug.', '🐞', NOW(), NOW()),
         ('SEND_TRANSACTION_CHALLENGE', 'Send a testnet transaction',
          'Send a transaction on the testnet (or produce a block).', '🔗', NOW(), NOW()),
         ('SOCIAL_SHARE_CHALLENGE', 'Share on social media',
          'Share the season announcement on social media.', '📣', NOW(), NOW()),
         ('INVITE_PARTICIPANT_CHALLENGE', 'Invite a participant',
          'Invite a new participant into the competition.', '🤝', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`
    );
    // Backfill the icon on rows seeded before the column existed. Scoped to
    // the four the platform seeds and to a NULL icon, so an organiser who has
    // since chosen a different face keeps it.
    await pool.query(
      `UPDATE challenge_kinds SET icon = v.icon, updated_at = NOW()
         FROM (VALUES
           ('REPORT_BUG_CHALLENGE', '🐞'),
           ('SEND_TRANSACTION_CHALLENGE', '🔗'),
           ('SOCIAL_SHARE_CHALLENGE', '📣'),
           ('INVITE_PARTICIPANT_CHALLENGE', '🤝')
         ) AS v(id, icon)
        WHERE challenge_kinds.id = v.id AND challenge_kinds.icon IS NULL`
    );

    // ─── Challenge templates (5; one kind is reused across two templates) ──
    // `illustration` names a drawing from the client registry
    // (frontend/src/lib/challenge-illustrations.ts). 900502 and 900503 carry
    // none: nothing in the set shows a share or an invite, and they keep the
    // kind-icon fallback in view on the seeded screens.
    await pool.query(
      `INSERT INTO challenge_templates
         (id, category, goal, task, reward, description, kind,
          metric_type, metric_target, metric_label, illustration, created_at, updated_at)
       VALUES
         (900500, 'bug', 'Report a reproducible bug',
          'Find and file a reproducible bug report against the testnet client.',
          '250 points', 'Bug-report challenge template.', 'REPORT_BUG_CHALLENGE',
          NULL, NULL, NULL, 'useful-feedback', NOW(), NOW()),
         (900501, 'onchain', 'Send your first testnet transaction',
          'Send a transaction on the testnet within the event window.',
          '100 points', 'Send-transaction challenge template.',
          'SEND_TRANSACTION_CHALLENGE', 'transactions_sent', 1, 'transactions',
          'network-participation', NOW(), NOW()),
         (900502, 'social', 'Share the season announcement',
          'Share the season announcement post on social media.',
          '50 points', 'Social-share challenge template.', 'SOCIAL_SHARE_CHALLENGE',
          NULL, NULL, NULL, NULL, NOW(), NOW()),
         (900503, 'growth', 'Invite a new participant',
          'Invite a new participant who successfully enrolls in the season.',
          '150 points', 'Invite challenge template.', 'INVITE_PARTICIPANT_CHALLENGE',
          NULL, NULL, NULL, NULL, NOW(), NOW()),
         (900504, 'onchain', 'Produce your first block',
          'Produce at least one block during the event window.',
          '250 points', 'Block-production challenge template.',
          'SEND_TRANSACTION_CHALLENGE', 'blocks_produced', 1, 'blocks',
          'block-production', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`
    );

    // ─── Challenge templates for the home-screen Challenges card (#911) ──
    // Three NUMERIC-metric templates, because that card's progress bar only
    // renders for a challenge with a metric target and the five templates
    // above give it only 'blocks_produced' (which reads from snapshots,
    // not the ledger). The second one's reward is the bare string '1500'
    // on purpose — it exercises the card's "append pts to a plain number"
    // path alongside the "render organiser prose verbatim" one.
    //
    // The third (900507) is the FINISHED numeric: its challenge is credited
    // to the target below, so the card draws a full bar AND the ✓ glyph on
    // the same row. Without it the only completed state a reviewer could
    // see was the binary one, and "numeric, but finished" — the state a bar
    // spends its whole life heading towards — was never on screen.
    await pool.query(
      `INSERT INTO challenge_templates
         (id, category, goal, task, reward, description, kind,
          metric_type, metric_target, metric_label, illustration, created_at, updated_at)
       VALUES
         (900505, 'onchain', 'Staging demo challenge — test the demo dApps',
          'Open eight of the demo dApps and leave a note on each.',
          'Up to 2,100 pts', 'Numeric-metric challenge template (home panel fixture).',
          'SEND_TRANSACTION_CHALLENGE', 'count', 8, 'Apps tested', 'try-three-apps', NOW(), NOW()),
         (900506, 'social', 'Staging demo challenge — give kudos to five builders',
          'Send kudos on five merged proposals from other builders.',
          '1500', 'Numeric-metric challenge template (bare-number reward fixture).',
          'SOCIAL_SHARE_CHALLENGE', 'count', 5, 'Kudos', 'proposal-accepted', NOW(), NOW()),
         (900507, 'community', 'Staging demo challenge — vote on five proposals',
          'Cast a vote on five open proposals from other builders.',
          '900 pts', 'Numeric-metric challenge template (completed fixture).',
          'SOCIAL_SHARE_CHALLENGE', 'count', 5, 'Proposals voted', 'make-a-proposal', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`
    );

    // Backfill the artwork on templates seeded before the column existed: the
    // INSERTs above only land on a database that has none of these ids. This
    // runs on every staging boot, so it touches only a row still in its seeded
    // state — no illustration, and updated_at still equal to the created_at the
    // seed stamped from the same NOW(). An admin save bumps updated_at, so an
    // organiser's pick AND a deliberate clear to (none), which stores the same
    // NULL, both survive the reboot. The pairs repeat the INSERTs;
    // tests/topochain-staging-seed.test.js checks the two lists agree.
    for (const [id, illustration] of [
      [900500, 'useful-feedback'],
      [900501, 'network-participation'],
      [900504, 'block-production'],
      [900505, 'try-three-apps'],
      [900506, 'proposal-accepted'],
      [900507, 'make-a-proposal'],
    ]) {
      await pool.query(
        'UPDATE challenge_templates SET illustration = $2 WHERE id = $1 AND illustration IS NULL AND updated_at = created_at',
        [id, illustration]
      );
    }

    // ─── Challenges (8): 5 on the regular event, 3 on the season-type event ──
    await pool.query(
      `INSERT INTO challenges
         (id, season_event_id, challenge_template_id, goal, task, reward,
          description, kind, enabled, display_order, completed, featured,
          featured_order, created_at, updated_at)
       VALUES
         (900500, $1, 900500, 'Report a reproducible bug',
          'Find and file a reproducible bug report against the testnet client.',
          '250 points', 'Bug-report challenge.', 'REPORT_BUG_CHALLENGE',
          TRUE, 1, TRUE, FALSE, NULL, NOW(), NOW()),
         (900501, $1, 900501, 'Send your first testnet transaction',
          'Send a transaction on the testnet within the event window.',
          '100 points', 'Send-transaction challenge.', 'SEND_TRANSACTION_CHALLENGE',
          TRUE, 2, TRUE, FALSE, NULL, NOW(), NOW()),
         (900502, $1, 900502, 'Share the season announcement',
          'Share the season announcement post on social media.',
          '50 points', 'Social-share challenge.', 'SOCIAL_SHARE_CHALLENGE',
          TRUE, 3, TRUE, FALSE, NULL, NOW(), NOW()),
         (900503, $1, 900504, 'Produce your first block',
          'Produce at least one block during the event window.',
          '250 points', 'Block-production challenge.', 'SEND_TRANSACTION_CHALLENGE',
          TRUE, 4, TRUE, TRUE, 1, NOW(), NOW()),
         (900504, $1, 900503, 'Invite a new participant',
          'Invite a new participant who successfully enrolls in the season.',
          '150 points', 'Invite challenge.', 'INVITE_PARTICIPANT_CHALLENGE',
          TRUE, 5, TRUE, FALSE, NULL, NOW(), NOW()),
         (900505, $2, 900500, 'Report a reproducible bug',
          'Find and file a reproducible bug report against the testnet client.',
          '250 points', 'Bug-report challenge (season event).', 'REPORT_BUG_CHALLENGE',
          TRUE, 1, TRUE, FALSE, NULL, NOW(), NOW()),
         (900506, $2, 900501, 'Send your first testnet transaction',
          'Send a transaction on the testnet within the event window.',
          '100 points', 'Send-transaction challenge (season event).',
          'SEND_TRANSACTION_CHALLENGE', TRUE, 2, TRUE, FALSE, NULL, NOW(), NOW()),
         (900507, $2, 900502, 'Share the season announcement',
          'Share the season announcement post on social media.',
          '50 points', 'Social-share challenge (season event).', 'SOCIAL_SHARE_CHALLENGE',
          TRUE, 3, FALSE, FALSE, NULL, NOW(), NOW()),
         (900508, $3, 900500, 'Report a reproducible bug',
          'Find and file a reproducible bug report against the testnet client.',
          '250 points', 'Bug-report challenge (finished event).', 'REPORT_BUG_CHALLENGE',
          TRUE, 1, TRUE, FALSE, NULL, NOW(), NOW()),
         (900509, $3, 900504, 'Produce your first block',
          'Produce at least one block during the event window.',
          '250 points', 'Block-production challenge (finished event).',
          'SEND_TRANSACTION_CHALLENGE', TRUE, 2, TRUE, TRUE, 1, NOW(), NOW()),
         -- Archive-season challenges. Two things here that no other event
         -- provides, both of them admin-console states rather than viewer
         -- ones: a DISABLED challenge (900711 — the list draws a muted row
         -- and offers "Enable" instead of "Disable", which was dead code in
         -- every preview), and NON-CONTIGUOUS display orders (2, 6, 8, 11).
         -- Contiguous 1..n orders make the reorder controls untestable by
         -- inspection: any renumbering looks right. With gaps, a move that
         -- silently rewrites its neighbours' orders is visible.
         -- Ids at 900710+, not 900515+: 900520-900579 is the per-viewer
         -- window in the tables below, and the seed's own tests identify a
         -- viewer row by that id range alone — a 9005[2-9]x row in ANY
         -- table reads as one. Staying above it keeps that cheap check
         -- honest.
         (900710, $4, 900500, 'Report a reproducible bug',
          'Find and file a reproducible bug report against the testnet client.',
          '250 points', 'Bug-report challenge (archive event).', 'REPORT_BUG_CHALLENGE',
          TRUE, 2, TRUE, FALSE, NULL, NOW(), NOW()),
         (900711, $4, 900502, 'Share the season announcement',
          'Share the season announcement post on social media.',
          '50 points', 'DISABLED challenge (archive event) — the only enabled = FALSE fixture.',
          'SOCIAL_SHARE_CHALLENGE', FALSE, 6, FALSE, FALSE, NULL, NOW(), NOW()),
         (900712, $4, 900503, 'Invite a new participant',
          'Invite a new participant who successfully enrolls in the season.',
          '150 points', 'Enabled-but-unfinished challenge (archive event).',
          'INVITE_PARTICIPANT_CHALLENGE', TRUE, 11, FALSE, FALSE, NULL, NOW(), NOW()),
         -- The archive event's block-production challenge. It exists so the
         -- one block_produced activity on this event (900701 below) has a
         -- challenge to point at: user_activities.challenge_id is NOT NULL.
         (900713, $4, 900504, 'Produce your first block',
          'Produce at least one block during the event window.',
          '250 points', 'Block-production challenge (archive event).',
          'SEND_TRANSACTION_CHALLENGE', TRUE, 8, TRUE, FALSE, NULL, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [EVENT_REGULAR_ID, EVENT_SEASON_ID, EVENT_ENDED_ID, EVENT_ARCHIVE_ID]
    );

    // ─── OPEN challenges for the home-screen Challenges card (#911) ─────
    // The eight challenges above are all organiser-`completed` (or sit on
    // the future-windowed season event), so the card's "open" filter —
    // enabled AND NOT completed AND inside its window — matches almost
    // none of them and the card would render empty in every preview.
    // These five are live for the next ten days and cover every state the
    // card can draw: binary not-done, binary done, a featured numeric one
    // the viewer is part-way through, a numeric one the viewer has taken
    // partway, and a numeric one CREDITED TO ITS TARGET (900514) so the
    // full bar and the ✓ appear on the same row. The per-viewer activity
    // rows that produce all that progress are seeded in the
    // VIEWER_USERNAMES loop below.
    await pool.query(
      `INSERT INTO challenges
         (id, season_event_id, challenge_template_id, goal, task, reward,
          description, kind, enabled, display_order, completed, featured,
          featured_order, schedule_start, schedule_end, created_at, updated_at)
       VALUES
         (900510, $1, 900500, 'Staging demo challenge — report a reproducible bug',
          'Find and file a reproducible bug report against the testnet client.',
          '250 points', 'Open binary challenge (home panel fixture, not done).',
          'REPORT_BUG_CHALLENGE', TRUE, 10, FALSE, FALSE, NULL,
          NOW() - INTERVAL '5 days', NOW() + INTERVAL '10 days', NOW(), NOW()),
         (900511, $1, 900502, 'Staging demo challenge — share the season announcement',
          'Share the season announcement post on social media.',
          '50 points', 'Open binary challenge (home panel fixture, done by the viewer).',
          'SOCIAL_SHARE_CHALLENGE', TRUE, 11, FALSE, FALSE, NULL,
          NOW() - INTERVAL '5 days', NOW() + INTERVAL '10 days', NOW(), NOW()),
         (900512, $1, 900505, NULL, NULL, NULL,
          'Open numeric challenge (home panel fixture, viewer at 3/8), featured.',
          'SEND_TRANSACTION_CHALLENGE', TRUE, 12, FALSE, TRUE, 1,
          NOW() - INTERVAL '5 days', NOW() + INTERVAL '10 days', NOW(), NOW()),
         (900513, $1, 900506, NULL, NULL, NULL,
          'Open numeric challenge (home panel fixture, viewer at 3/5).',
          'SOCIAL_SHARE_CHALLENGE', TRUE, 13, FALSE, FALSE, NULL,
          NOW() - INTERVAL '5 days', NOW() + INTERVAL '10 days', NOW(), NOW()),
         (900514, $1, 900507, NULL, NULL, NULL,
          'Open numeric challenge (home panel fixture, viewer at 5/5 — DONE).',
          'SOCIAL_SHARE_CHALLENGE', TRUE, 14, FALSE, FALSE, NULL,
          NOW() - INTERVAL '5 days', NOW() + INTERVAL '10 days', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [EVENT_REGULAR_ID]
    );

    // ─── User enrollments (mix of season-wide and event-scoped; the
    // "mixed" user gets both, proving they can coexist under the two
    // partial uniques). Every row's season_id is SEASON_ID — the scope
    // invariant satisfied by construction. ────────────────────────────
    await pool.query(
      `INSERT INTO user_enrollments (id, season_event_id, user_id, season_id, registered_at)
       VALUES
         (900500, NULL, $1, $7, NOW() - INTERVAL '55 days'),
         (900501, NULL, $2, $7, NOW() - INTERVAL '50 days'),
         (900502, $5, $3, $7, NOW() - INTERVAL '40 days'),
         (900503, $5, $4, $7, NOW() - INTERVAL '38 days'),
         (900504, $6, $8, $7, NOW() - INTERVAL '10 days'),
         (900505, $5, $9, $7, NOW() - INTERVAL '35 days'),
         (900506, NULL, $9, $7, NOW() - INTERVAL '35 days'),
         -- The two block-producer-queue users. Ids sit at 900700+, not
         -- immediately after 900506: the per-viewer blocks below own
         -- 900520-900579 in this table with no upper bound, and a row that
         -- grows into one of them is swallowed by ON CONFLICT (id) rather
         -- than failing. $12 is EVENT_EMPTY_ID, which belongs to $7 — the
         -- scope invariant holds, and the challenge-free event gets
         -- participants so its empty CHALLENGE list can't be mistaken for
         -- an empty event.
         (900700, NULL, $10, $7, NOW() - INTERVAL '26 days'),
         (900701, $12, $11, $7, NOW() - INTERVAL '13 days')
       ON CONFLICT (id) DO NOTHING`,
      [USERS.seasonWide1, USERS.seasonWide2, USERS.eventA1, USERS.eventA2,
       EVENT_REGULAR_ID, EVENT_SEASON_ID, SEASON_ID, USERS.eventB1, USERS.mixed,
       USERS.bpReleased, USERS.bpPending, EVENT_EMPTY_ID]
    );

    // ─── Onchain accounts (6): mix of season-wide/event-scoped and
    // assigned/unassigned, used/unused; secret_key is a fake testnet
    // credential (scrubbed in staging clones — schema.sql:2766). ───────
    await pool.query(
      `INSERT INTO onchain_accounts
         (id, amount, identity_uid, address, public_key, secret_key, tier,
          registration_code, season_event_id, season_id, user_id, is_used, used_at,
          created_at, updated_at)
       VALUES
         (900500, 500, 'staging-demo-identity-0001', 'ut1stagingdemotopochainacct000001',
          'utpk1stagingdemotopochainacct000001', 'sk_staging_demo_fake_0000000000001',
          'standard', 'STAGING-DEMO-TOPOCHAIN-0001', NULL, $6, $1, TRUE,
          NOW() - INTERVAL '5 days', NOW(), NOW()),
         (900501, 500, 'staging-demo-identity-0002', 'ut1stagingdemotopochainacct000002',
          'utpk1stagingdemotopochainacct000002', 'sk_staging_demo_fake_0000000000002',
          'standard', 'STAGING-DEMO-TOPOCHAIN-0002', NULL, $6, $2, FALSE, NULL,
          NOW(), NOW()),
         (900502, 1000, 'staging-demo-identity-0003', 'ut1stagingdemotopochainacct000003',
          'utpk1stagingdemotopochainacct000003', 'sk_staging_demo_fake_0000000000003',
          'premium', 'STAGING-DEMO-TOPOCHAIN-0003', $5, $6, $3, TRUE,
          NOW() - INTERVAL '4 days', NOW(), NOW()),
         (900503, 500, 'staging-demo-identity-0004', 'ut1stagingdemotopochainacct000004',
          'utpk1stagingdemotopochainacct000004', 'sk_staging_demo_fake_0000000000004',
          'standard', 'STAGING-DEMO-TOPOCHAIN-0004', $5, $6, NULL, FALSE, NULL,
          NOW(), NOW()),
         (900504, 1000, 'staging-demo-identity-0005', 'ut1stagingdemotopochainacct000005',
          'utpk1stagingdemotopochainacct000005', 'sk_staging_demo_fake_0000000000005',
          'premium', 'STAGING-DEMO-TOPOCHAIN-0005', $7, $6, $4, TRUE,
          NOW() - INTERVAL '3 days', NOW(), NOW()),
         (900505, 500, 'staging-demo-identity-0006', 'ut1stagingdemotopochainacct000006',
          'utpk1stagingdemotopochainacct000006', 'sk_staging_demo_fake_0000000000006',
          'standard', 'STAGING-DEMO-TOPOCHAIN-0006', $7, $6, NULL, FALSE, NULL,
          NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [USERS.seasonWide1, USERS.seasonWide2, USERS.eventA1, USERS.eventB1,
       EVENT_REGULAR_ID, SEASON_ID, EVENT_SEASON_ID]
    );

    // ─── User activities (8): challenge completions + one block-production
    // credit, spread across both events and four of the six users. Each
    // row's metadata.kind = 'challenge_completion' so the anti-replay
    // partial unique (user_id, challenge_id) is exercised. ─────────────
    await pool.query(
      `INSERT INTO user_activities
         (id, user_id, season_event_id, activity_type, points, description,
          metadata, activity_at, challenge_id)
       VALUES
         (900500, $1, $5, 'challenge_completion', 250, 'Reported a reproducible bug.',
          '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '6 days', 900500),
         (900501, $1, $5, 'challenge_completion', 100, 'Sent a testnet transaction.',
          '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '5 days', 900501),
         (900502, $2, $5, 'challenge_completion', 250, 'Reported a reproducible bug.',
          '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '6 days', 900500),
         (900503, $2, $5, 'block_produced', 250, 'Produced a testnet block.',
          '{"kind": "block_production"}'::jsonb, NOW() - INTERVAL '4 days', 900503),
         (900504, $3, $5, 'challenge_completion', 50, 'Shared the season announcement.',
          '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '3 days', 900502),
         (900505, $3, $5, 'challenge_completion', 150, 'Invited a new participant.',
          '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '2 days', 900504),
         (900506, $4, $6, 'challenge_completion', 250, 'Reported a reproducible bug.',
          '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '3 days', 900505),
         (900507, $4, $6, 'challenge_completion', 100, 'Sent a testnet transaction.',
          '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '2 days', 900506),
         -- Four rows on the ARCHIVE event (ids at 900700+, clear of the
         -- per-viewer blocks). Two reasons, both admin-screen ones: the
         -- activities list filters by event, and until now every row in it
         -- belonged to the running season, so the filter could only ever
         -- return everything; and 900701 is a block_produced row, so the
         -- activity-type filter has something to separate on this event too.
         --
         -- 900701 used to carry a NULL challenge_id to put the activities
         -- table's "—" cell on screen. It can't: user_activities.challenge_id
         -- is BIGINT NOT NULL REFERENCES challenges(id), so that INSERT
         -- failed on every boot and took the whole Topochain block down with
         -- it (the seed's try/catch only warns) — which is why #profile had
         -- no completed challenges to link out to. The "—" fallback in
         -- admin-topochain.js is unreachable defensive code, not a state a
         -- fixture can demonstrate.
         (900700, $8, $7, 'challenge_completion', 250, 'Reported a reproducible bug.',
          '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '210 days', 900710),
         (900701, $8, $7, 'block_produced', 250, 'Produced a testnet block.',
          '{"kind": "block_production"}'::jsonb, NOW() - INTERVAL '208 days', 900713),
         (900702, $9, $7, 'challenge_completion', 50, 'Shared the season announcement.',
          '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '206 days', 900711),
         (900703, $9, $7, 'challenge_completion', 150, 'Invited a new participant.',
          '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '205 days', 900712)
       ON CONFLICT (id) DO NOTHING`,
      [USERS.eventA1, USERS.eventA2, USERS.mixed, USERS.eventB1,
       EVENT_REGULAR_ID, EVENT_SEASON_ID, EVENT_ARCHIVE_ID,
       USERS.bpPending, USERS.bpReleased]
    );

    // ─── Leaderboard snapshots (2 snapshot times x 6 users, all against
    // the regular/display_leaderboard event). Points roughly track the
    // activities above: eventA1 and eventA2 accumulate between the two
    // snapshots, mixed shows up only in the later one, the rest sit at 0.
    // Unique (season_event_id, user_id, snapshot_at) is respected since
    // every row differs by user_id or snapshot_at. ─────────────────────
    // 130 hours (~5.4 days) ago: after both users' first challenge
    // (6 days ago) but before their second (5/4/3/2 days ago) — so the
    // earlier snapshot's totals below genuinely predate the later ones.
    const EARLIER_SNAPSHOT = `NOW() - INTERVAL '130 hours'`;
    const LATER_SNAPSHOT = 'NOW()';
    await pool.query(
      `INSERT INTO leaderboard_snapshots
         (id, season_event_id, user_id, rank, total_points, extra_points,
          snapshot_at, season_id, created_at, updated_at)
       VALUES
         (900500, $7, $3, 1, 250, 0, ${EARLIER_SNAPSHOT}, $8, NOW(), NOW()),
         (900501, $7, $4, 2, 250, 0, ${EARLIER_SNAPSHOT}, $8, NOW(), NOW()),
         (900502, $7, $5, 3, 0,   0, ${EARLIER_SNAPSHOT}, $8, NOW(), NOW()),
         (900503, $7, $1, 4, 0,   0, ${EARLIER_SNAPSHOT}, $8, NOW(), NOW()),
         (900504, $7, $2, 5, 0,   0, ${EARLIER_SNAPSHOT}, $8, NOW(), NOW()),
         (900505, $7, $6, 6, 0,   0, ${EARLIER_SNAPSHOT}, $8, NOW(), NOW()),
         (900506, $7, $4, 1, 500, 0, ${LATER_SNAPSHOT}, $8, NOW(), NOW()),
         (900507, $7, $3, 2, 350, 0, ${LATER_SNAPSHOT}, $8, NOW(), NOW()),
         (900508, $7, $6, 3, 200, 0, ${LATER_SNAPSHOT}, $8, NOW(), NOW()),
         -- The podium-EXCLUDED user (seasonWide1, exclude_podium = TRUE)
         -- leads the event on points in the later snapshot. That is the
         -- whole point of seeding it high: the standings table shows the
         -- row with a "—" rank and a non-podium tag, and the home widget's
         -- leaderboard fill must SKIP it when picking its three podium
         -- rows. Left at 0 it sat at the bottom and neither behaviour was
         -- reachable by looking at a preview.
         (900509, $7, $1, 1, 600, 0, ${LATER_SNAPSHOT}, $8, NOW(), NOW()),
         (900510, $7, $2, 5, 0,   0, ${LATER_SNAPSHOT}, $8, NOW(), NOW()),
         (900511, $7, $5, 6, 0,   0, ${LATER_SNAPSHOT}, $8, NOW(), NOW()),
         -- Standings for the fully-past event, so selecting it renders a
         -- populated table under the "nothing is running" caption rather
         -- than an empty one (which would read as the bug being fixed).
         (900512, $9, $4, 1, 800, 0, NOW() - INTERVAL '90 days', $8, NOW(), NOW()),
         (900513, $9, $3, 2, 450, 0, NOW() - INTERVAL '90 days', $8, NOW(), NOW()),
         (900514, $9, $6, 3, 300, 0, NOW() - INTERVAL '90 days', $8, NOW(), NOW()),
         (900515, $9, $5, 4, 125, 0, NOW() - INTERVAL '90 days', $8, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [USERS.seasonWide1, USERS.seasonWide2, USERS.eventA1, USERS.eventA2,
       USERS.eventB1, USERS.mixed, EVENT_REGULAR_ID, SEASON_ID, EVENT_ENDED_ID]
    );

    // ─── Leaderboard snapshots for the SEASON event (2 snapshot times x 6
    // users) ────────────────────────────────────────────────────────────
    //
    // Why this block exists (issue #999): the leaderboard now DEFAULTS to
    // the season-level aggregate (DEFAULT_PUBLIC_EVENT_SQL step 1), so the
    // season board is the first thing a staging preview paints. Without
    // rows here the aggregate was just EVENT_REGULAR + EVENT_ENDED, whose
    // ordering matches the regular event's own board — a tester could not
    // tell the season path from the per-event path, which is precisely the
    // bug being fixed.
    //
    // The numbers are chosen so the preview proves three things at a glance:
    //
    //   1. THE SEASON BOARD IS A DIFFERENT BOARD. `mixed` sits third on
    //      EVENT_REGULAR (200 pts) and tops the season board (4700) —
    //      so "the default changed" is visible without opening the picker.
    //   2. SEASON TOTALS DWARF ANY SINGLE EVENT'S. Four figures here
    //      against three on every per-event board, mirroring production
    //      (67973.66 season vs 1900.00 on one sub-event).
    //   3. THE PODIUM-EXCLUDED ROW STILL BEHAVES. `seasonWide1`
    //      (exclude_podium = TRUE) leads on POINTS (5200) but must render
    //      with a "—" rank and the non-podium tag, and the home widget's
    //      fill must skip it when picking its three podium rows. Seeded
    //      high for the same reason it is seeded high on EVENT_REGULAR:
    //      mid-table, neither behaviour is reachable by looking.
    //
    // Two snapshot times, like the regular event's block above, so the
    // "latest snapshot per (user, event)" rule the aggregate depends on
    // (standings.js's DISTINCT ON) is genuinely exercised on this event —
    // the EARLIER totals below are strictly lower, so a rule that picked
    // the wrong row would visibly under-count.
    //
    // ids: 900500-900516 is used above, and the viewer blocks below start at
    // 900520 with 20 reserved PER VIEWER — an open-ended range (a fourth
    // tester identity would take 900580-900599). So this block sits clear of
    // it at 900600-900611 rather than immediately after today's last viewer,
    // which a new viewer would silently grow into and ON CONFLICT (id) would
    // swallow.
    await pool.query(
      `INSERT INTO leaderboard_snapshots
         (id, season_event_id, user_id, rank, total_points, extra_points,
          snapshot_at, season_id, created_at, updated_at)
       VALUES
         (900600, $7, $6, 1, 2100, 0, ${EARLIER_SNAPSHOT}, $8, NOW(), NOW()),
         (900601, $7, $4, 2, 1200, 0, ${EARLIER_SNAPSHOT}, $8, NOW(), NOW()),
         (900602, $7, $3, 3, 1100, 0, ${EARLIER_SNAPSHOT}, $8, NOW(), NOW()),
         (900603, $7, $5, 4,  400, 0, ${EARLIER_SNAPSHOT}, $8, NOW(), NOW()),
         (900604, $7, $2, 5,  150, 0, ${EARLIER_SNAPSHOT}, $8, NOW(), NOW()),
         (900605, $7, $1, 1, 2300, 0, ${EARLIER_SNAPSHOT}, $8, NOW(), NOW()),
         -- Later snapshot: the one the aggregate actually sums.
         (900606, $7, $6, 1, 4200, 0, ${LATER_SNAPSHOT}, $8, NOW(), NOW()),
         (900607, $7, $4, 2, 2500, 0, ${LATER_SNAPSHOT}, $8, NOW(), NOW()),
         (900608, $7, $3, 3, 2400, 0, ${LATER_SNAPSHOT}, $8, NOW(), NOW()),
         (900609, $7, $5, 4,  900, 0, ${LATER_SNAPSHOT}, $8, NOW(), NOW()),
         (900610, $7, $2, 5,  300, 0, ${LATER_SNAPSHOT}, $8, NOW(), NOW()),
         (900611, $7, $1, 1, 4600, 0, ${LATER_SNAPSHOT}, $8, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [USERS.seasonWide1, USERS.seasonWide2, USERS.eventA1, USERS.eventA2,
       USERS.eventB1, USERS.mixed, EVENT_SEASON_ID, SEASON_ID]
    );

    // ─── Epoch stats (3 epochs x 3 wallets = 9 rows) — one wallet per
    // linked user (eventA1, eventB1), plus one wallet-only row (user_id
    // NULL, matching the unassigned account 900503's address) proving the
    // nullable/SET NULL column works. ──────────────────────────────────
    const CHAIN_ID = 'staging-demo-chain-1';
    const W1 = 'ut1stagingdemotopochainacct000003'; // eventA1's account
    const W2 = 'ut1stagingdemotopochainacct000005'; // eventB1's account
    const W3 = 'ut1stagingdemotopochainacct000004'; // unassigned account
    await pool.query(
      `INSERT INTO epoch_stats
         (id, chain_id, wallet_address, user_id, epoch, epoch_won_slots,
          epoch_produced_blocks, epoch_canonical_blocks, epoch_orphaned_blocks,
          epoch_failed_blocks, created_at, updated_at)
       VALUES
         (900500, $4, $1, $5, 100, 2, 1, 1, 0, 0, NOW(), NOW()),
         (900501, $4, $1, $5, 101, 3, 2, 2, 0, 0, NOW(), NOW()),
         (900502, $4, $1, $5, 102, 1, 1, 1, 0, 0, NOW(), NOW()),
         (900503, $4, $2, $6, 100, 1, 0, 0, 0, 1, NOW(), NOW()),
         (900504, $4, $2, $6, 101, 2, 1, 1, 0, 0, NOW(), NOW()),
         (900505, $4, $2, $6, 102, 2, 2, 2, 0, 0, NOW(), NOW()),
         (900506, $4, $3, NULL, 100, 1, 1, 1, 0, 0, NOW(), NOW()),
         (900507, $4, $3, NULL, 101, 0, 0, 0, 0, 1, NOW(), NOW()),
         (900508, $4, $3, NULL, 102, 1, 1, 1, 0, 0, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [W1, W2, W3, CHAIN_ID, USERS.eventA1, USERS.eventB1]
    );

    // ─── Terms version (1) + consents (2) ──────────────────────────────
    await pool.query(
      `INSERT INTO terms_versions
         (id, version, title, body_markdown, terms_link, published_at, created_at, updated_at)
       VALUES
         (900500, 'staging-demo-v1', 'Staging Demo Terms of Service',
          '# Staging Demo Terms' || chr(10) || chr(10) ||
          'Fixture terms document for staging previews.',
          'https://staging-demo.example.invalid/terms',
          NOW() - INTERVAL '10 days', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO user_terms_consents
         (id, user_id, terms_version_id, status, responded_at, app_version, created_at, updated_at)
       VALUES
         (900500, $1, 900500, 'accepted', NOW() - INTERVAL '9 days', '1.4.0', NOW(), NOW()),
         (900501, $2, 900500, 'accepted', NOW() - INTERVAL '8 days', '1.3.0', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [USERS.seasonWide1, USERS.eventA1]
    );
    // Every OTHER cloned user gets an accepted consent too. The web shell
    // now auto-prompts any signed-in user whose consent for the current
    // published version is null (issue #1297,
    // frontend/src/features/settings/terms-first-run.js) — without this
    // blanket row the sheet would slide over EVERY staging preview route,
    // including the ones the declared checks screenshot. The deliberate way
    // to see the sheet in a preview is ?shot=terms-consent (public/js/
    // app.js). `user_terms_consents` is staging:private — truncated on
    // clone — so this collides with nothing real, and the natural-key
    // arbiter keeps re-boots (and the two explicit rows above) idempotent.
    await pool.query(
      `INSERT INTO user_terms_consents
         (user_id, terms_version_id, status, responded_at, created_at, updated_at)
       SELECT u.id, 900500, 'accepted', NOW() - INTERVAL '7 days', NOW(), NOW()
         FROM users u
       ON CONFLICT (user_id, terms_version_id) DO NOTHING`
    );

    // ─── App version config (1 per OS) ─────────────────────────────────
    // The only table in this seed whose natural key can already be taken by
    // CLONED PRODUCTION DATA: `app_version_configs.os` is UNIQUE, and a real
    // deployment has an 'ios'/'android' row under its own serial id. Every
    // other fixture here is keyed on a value nothing but this seed invents
    // (900500+ ids, 'staging-demo-*' names), so `ON CONFLICT (id)` covers
    // them. Here it does not: the conflict fires on os, not on id, and an
    // unhandled one aborts the whole seed — which is exactly what happened
    // in staging, silently emptying every viewer-facing topochain surface
    // seeded after this point. So skip the row when the OS is already
    // configured, and keep the id arbiter for the plain re-boot case.
    await pool.query(
      `INSERT INTO app_version_configs
         (id, os, min_build_number, recommended_build_number, current_version,
          is_active, should_update_message, update_url, created_at, updated_at)
       SELECT v.id, v.os, v.min_build, v.rec_build, v.version, v.is_active,
              v.message, v.url, NOW(), NOW()
         FROM (VALUES
         (900500, 'ios', 100, 110, '1.4.0', TRUE,
          'A new version is available.', 'https://staging-demo.example.invalid/ios'),
         -- Deliberately INACTIVE: with no active row for an OS the version
         -- gate is off for it (every build is told it is up to date), and
         -- the admin screen's "No active version rule for Android" warning
         -- is only reviewable in a preview if one OS is left in that state.
         (900501, 'android', 90, 95, '1.4.0', FALSE,
          'A new version is available.', 'https://staging-demo.example.invalid/android')
              ) AS v(id, os, min_build, rec_build, version, is_active, message, url)
        WHERE NOT EXISTS (
                SELECT 1 FROM app_version_configs x WHERE x.os = v.os
              )
       ON CONFLICT (id) DO NOTHING`
    );

    // …and because the insert above SKIPS a configured OS, the clone also
    // took the inactive-Android state with it: production configures both
    // OSes and keeps both active, so on a prod-cloned staging DB neither
    // row above is inserted and the "No active version rule for Android"
    // warning — the whole point of the second fixture row — can never
    // render. The fixture's declared state has to be asserted, not merely
    // offered: switch Android off whatever the clone brought. iOS is left
    // exactly as it arrived, so the screen still shows one OS gated and one
    // OS open, which is the contrast the warning exists to draw.
    await pool.query(
      `UPDATE app_version_configs
          SET is_active = FALSE, updated_at = NOW()
        WHERE os = 'android' AND is_active = TRUE`
    );

    // ─── Waitlist signups (7) ──────────────────────────────────────────
    // The admin console's Waitlist screen reads `waitlist_signups`
    // directly, and in a staging clone that table is emptied along with
    // every other signup surface — so the screen, its filters, its columns
    // and its per-row Admit button were all reviewable only as an empty
    // state. Seven rows, one per thing the screen renders differently:
    //
    //   900500  waiting, CONFIRMED, every survey section answered, and the
    //           row two others came in through → the "7 of 7 answered"
    //           Answers cell, the "Brought in 2" Referrals cell, and the
    //           Details block with something in every line.
    //   900501  waiting, UNCONFIRMED, no answers      → the plain row, the
    //           "Nothing answered yet" cell, and the only one that proves
    //           confirmed_at can be null.
    //   900502  ADMITTED and linked to a fixture account → the admitted
    //           half of the filter, the linked-username cell, and the row
    //           whose invite mail has a delivery record behind it (seeded
    //           by seedStagingPlatformMail, since mail_deliveries is
    //           staging:private and arrives empty).
    //   900503  waiting, CONFIRMED, RETIRED REGION answer → the row whose
    //           country is `X-LA`, one of the five namespaced pseudo-codes
    //           the old region-bucket picker produced.
    //   900504  waiting, came in through 900500       → the other half of
    //           the invite graph, which the screen used to never show.
    //   900505  waiting, came in through 900500, and asked to be admitted
    //           together with them → the Referrals cell's third line.
    //   900506  waiting, answers in the RETIRED pre-survey shape → the
    //           "Other answers" line, which exists because an answers blob
    //           spans several schema versions and an admin reading a row is
    //           entitled to see what is actually stored in it.
    //
    // The country on 900500 is `UY` on purpose: Uruguay is the exact place
    // the old curated list could not express (#1527), and its "Where" line
    // is what proves the disclosure renders a NAME now rather than a code.
    // 900503 sits beside it so a reviewer can see the two are told apart —
    // "Uruguay" against "Elsewhere in Latin America (region)" — rather than
    // both collapsing into a raw two-letter string.
    //
    // The answer VALUES are real option codes from waitlist-questions.js
    // (`friend`, `lt10`, `organizer`, `shutdown`), not invented strings:
    // the screen labels them through /api/public/waitlist/options, so a
    // fixture carrying a made-up code would render as the code and quietly
    // look like the lookup was broken.
    //
    // 900504 and 900505 point at 900500, which is inserted earlier in the
    // same VALUES list — the foreign key is checked per row, so the order
    // is load-bearing.
    //
    // Emails are `.invalid` and nothing here is ever mailed: admitting is
    // the only thing that sends, and a tester triggering it in staging hits
    // the same skipped_staging path as every other fixture.
    await pool.query(
      `INSERT INTO waitlist_signups
         (id, email, submitted_at, ip, answers, released_at, linked_user_id,
          confirmed_at, invited_by)
       VALUES
         (900500, 'staging-demo-topochain-waitlist-1@example.invalid',
          NOW() - INTERVAL '30 days', NULL,
          '{"made_url": "https://staging-demo.example.invalid/what-i-made", "made_note": "Staging demo build note.", "country": "UY", "discovery": {"source": "friend", "detail": "Staging demo: heard about it at lunch."}, "group": {"name": "Staging demo crew", "size": "lt10", "role": "organizer", "tools": ["groupchat", "spreadsheet"], "need": "Staging demo group need."}, "loss": {"had": "yes", "product": "Staging demo defunct tool", "kind": ["shutdown"], "story": "Staging demo loss story."}, "handles": {"farcaster": "staging-demo"}, "followed_claim": true}'::jsonb,
          NULL, NULL, NOW() - INTERVAL '29 days', NULL),
         (900501, 'staging-demo-topochain-waitlist-2@example.invalid',
          NOW() - INTERVAL '18 days', NULL, NULL, NULL, NULL, NULL, NULL),
         (900502, 'staging-demo-topochain-waitlist-3@example.invalid',
          NOW() - INTERVAL '40 days', NULL,
          '{"made_url": "https://staging-demo.example.invalid/admitted", "country": "PT", "discovery": {"source": "podcast"}, "handles": {"telegram": "staging-demo-admitted"}}'::jsonb,
          NOW() - INTERVAL '20 days', $1, NOW() - INTERVAL '39 days', NULL),
         (900503, 'staging-demo-topochain-waitlist-4@example.invalid',
          NOW() - INTERVAL '25 days', NULL,
          '{"country": "X-LA", "made_note": "Staging demo legacy region answer."}'::jsonb,
          NULL, NULL, NOW() - INTERVAL '24 days', NULL),
         (900504, 'staging-demo-topochain-waitlist-5@example.invalid',
          NOW() - INTERVAL '12 days', NULL,
          '{"country": "UY", "discovery": {"source": "friend"}, "made_note": "Staging demo: came in through someone else."}'::jsonb,
          NULL, NULL, NOW() - INTERVAL '12 days', 900500),
         (900505, 'staging-demo-topochain-waitlist-6@example.invalid',
          NOW() - INTERVAL '11 days', NULL,
          '{"country": "UY", "discovery": {"source": "friend"}, "admit_together": true, "made_note": "Staging demo: wants to come in with the others."}'::jsonb,
          NULL, NULL, NULL, 900500),
         (900506, 'staging-demo-topochain-waitlist-7@example.invalid',
          NOW() - INTERVAL '9 days', NULL,
          '{"role": "Validator", "chain": "Testnet", "why": "Staging demo answer in the retired shape."}'::jsonb,
          NULL, NULL, NOW() - INTERVAL '9 days', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [USERS.bpReleased]
    );

    // ON CONFLICT DO NOTHING above means an edit to a seeded `answers`
    // literal only lands on a database that has never seen the row. Three
    // fixtures are re-asserted here so a staging DB seeded before this
    // change picks them up too, the same way the platform-mail fixture
    // re-asserts its row.
    //
    // 900500 is rewritten WHOLESALE rather than patched: it used to carry
    // the retired `{role, chain, why}` shape, which answers none of the
    // seven survey sections, so a re-cloned database would have shown "0 of
    // 7 answered" on the one row that exists to show the opposite. Gated on
    // that shape being present (`role`, which the survey never writes) so
    // the statement is a no-op on an already-correct row and can never
    // clobber a fixture somebody edited by hand.
    await pool.query(
      `UPDATE waitlist_signups
          SET answers = $2::jsonb
        WHERE id = $1 AND answers IS NOT NULL
          AND answers->>'role' IS NOT NULL`,
      [900500, JSON.stringify({
        made_url: 'https://staging-demo.example.invalid/what-i-made',
        made_note: 'Staging demo build note.',
        country: 'UY',
        discovery: { source: 'friend', detail: 'Staging demo: heard about it at lunch.' },
        group: {
          name: 'Staging demo crew',
          size: 'lt10',
          role: 'organizer',
          tools: ['groupchat', 'spreadsheet'],
          need: 'Staging demo group need.',
        },
        loss: {
          had: 'yes',
          product: 'Staging demo defunct tool',
          kind: ['shutdown'],
          story: 'Staging demo loss story.',
        },
        handles: { farcaster: 'staging-demo' },
        followed_claim: true,
      })]
    );
    await pool.query(
      `UPDATE waitlist_signups
          SET answers = jsonb_set(answers, '{country}', to_jsonb($2::text))
        WHERE id = $1 AND answers IS NOT NULL
          AND answers->>'country' IS DISTINCT FROM $2`,
      [900500, 'UY']
    );
    await pool.query(
      `UPDATE waitlist_signups
          SET answers = jsonb_set(answers, '{country}', to_jsonb($2::text))
        WHERE id = $1 AND answers IS NOT NULL
          AND answers->>'country' IS DISTINCT FROM $2`,
      [900503, 'X-LA']
    );

    // The epoch-policy cutover cannot carry these two historical staging
    // catalogue rows: one is an open delegation for an account that is not a
    // real managed producer. Retire only the exact reserved fixtures before
    // cutover. Once any canonical cutover exists the predicate matches no
    // rows, so the legacy-table freeze trigger is never invoked on reboot.
    await pool.query(
      `DELETE FROM account_delegation_periods
        WHERE ((id = 900500 AND account = 'ut1stagingdemotopochainacct000001')
            OR (id = 900501 AND account = 'ut1stagingdemotopochainacct000004'))
          AND NOT EXISTS (
            SELECT 1 FROM native_epoch_delegation_fences
             WHERE cutover_epoch IS NOT NULL
          )`
    );

    // ─── Token allocation (3 users, matching the later leaderboard totals) ──
    await pool.query(
      `INSERT INTO token_allocation
         (id, user_id, season_id, total_points, total_season_tokens, allocated_tokens,
          description, created_at, updated_at)
       VALUES
         (900500, $1, $4, 350, 3500, 35.00000000, 'Staging demo allocation', NOW(), NOW()),
         (900501, $2, $4, 500, 5000, 50.00000000, 'Staging demo allocation', NOW(), NOW()),
         (900502, $3, $4, 200, 2000, 20.00000000, 'Staging demo allocation', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [USERS.eventA1, USERS.eventA2, USERS.mixed, SEASON_ID]
    );

    log.info('db', 'Topochain staging fixtures seeded', { seasonId: SEASON_ID });
  } catch (err) {
    log.warn('db', 'Topochain staging fixtures seeding failed', { message: err.message });
  }

  // A SECOND failure domain, deliberately. Everything above is a catalogue
  // nobody signs in as; everything below is what the SIGNED-IN tester sees.
  // Sharing one try/catch made a single conflicting catalogue row (see the
  // app_version_configs note above) empty the viewer's profile, leaderboard
  // and challenge screens all at once, and the only trace was one warn line
  // — the screens themselves just looked like an unfinished feature. Split,
  // a catalogue failure costs the fixture users and nothing else.
  try {
    // ─── The staging VIEWER's own topochain rows ───────────────────────
    // Everything above belongs to six fixture users nobody logs in as. The
    // #profile screen renders the SIGNED-IN user (the /challenges-api/me/*
    // routes scope to the session), and the leaderboard's "View my full
    // profile" card keys off the viewer's own usernode_pubkey — so without
    // these rows a tester who opens Profile in a preview sees an empty
    // screen and cannot tell it apart from the screen being broken.
    //
    // Grant them to every identity a tester's eyes look through: the
    // interactive admin login (config.adminUsername), plus the two capture
    // identities — screenshots sign as usernode-capture and the declared
    // dapp.json tests sign as usernode-capture-admin (see
    // services/visuals.js) — so the /#profile check and the before/after
    // shots render the POPULATED screen rather than the empty state. Same
    // convention as the app-discovery fixtures earlier in this file.
    //
    // Resolved by username rather than by fixed id, because these rows are
    // created by seedAdmin() / the capture bootstrap with serial ids. The
    // id block is keyed off each name's position in VIEWER_USERNAMES, NOT
    // off the query result order, so a viewer's ids never shift when
    // another identity appears or disappears between boots — that would
    // re-insert its rows under fresh ids and defeat ON CONFLICT (id).
    // 900500-900516 is fully used above, so the viewers start at 900520
    // with a 20-wide block each — three names, so through 900579, and the
    // range is deliberately open-ended. (The season-event snapshot block
    // above sits at 900600+, clear of any viewer growth, for that reason.)
    // Twenty, not ten: the home-panel fixtures
    // below need fourteen user_activities rows per viewer (five of them
    // just to credit the 5-of-5 challenge), and a block that overflows into
    // its neighbour is silently swallowed by ON CONFLICT (id) rather than
    // failing — the exact trap the per-username keying above avoids.
    const VIEWER_USERNAMES = [
      config.adminUsername, 'usernode-capture', 'usernode-capture-admin',
    ];
    const { rows: viewerRows } = await pool.query(
      'SELECT id, username FROM users WHERE username = ANY($1::text[])',
      // Filtered for the lookup only — the slot arithmetic below still
      // indexes into the unfiltered list, so an unset adminUsername shifts
      // nobody's id block.
      [VIEWER_USERNAMES.filter(Boolean)]
    );
    for (const viewer of viewerRows) {
      const viewerId = viewer.id;
      const slot = VIEWER_USERNAMES.indexOf(viewer.username);
      if (slot < 0) continue;
      const base = 900520 + slot * 20;
      // Two forms of the same identity, mirroring the fixture accounts
      // above: `address` is the bech32m form the UI shows, `public_key` the
      // VRF-side key. epoch_stats keys off the address form. Both are
      // per-viewer, so the unique indexes hold with three seeded at once.
      const VIEWER_WALLET = `ut1stagingdemotopochainviewer000${slot + 1}`;
      const VIEWER_PUBKEY = `utpk1stagingdemotopochainviewer0${slot + 1}`;

      // A linked wallet is what the leaderboard drill-down matches on.
      await pool.query(
        `UPDATE users SET usernode_pubkey = COALESCE(usernode_pubkey, $2)
          WHERE id = $1`,
        [viewerId, VIEWER_WALLET]
      );
      await pool.query(
        `INSERT INTO onchain_accounts
           (id, amount, identity_uid, address, public_key, secret_key, tier,
            registration_code, season_event_id, season_id, user_id, is_used,
            used_at, created_at, updated_at)
         VALUES (${base}, 1000, 'staging-demo-identity-viewer-${slot + 1}', $2, $3,
                 'sk_staging_demo_fake_0000000viewer${slot + 1}', 'premium',
                 'STAGING-DEMO-TOPOCHAIN-VIEWER-${slot + 1}', NULL, $4, $1, TRUE,
                 NOW() - INTERVAL '6 days', NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [viewerId, VIEWER_WALLET, VIEWER_PUBKEY, SEASON_ID]
      );
      // Both rows sit in the RUNNING season on purpose (issue #2495): the
      // Leaderboard screen shows its event picker to admins and to members
      // with a season to go back to, and usernode-capture — the member
      // every screenshot signs as — is meant to show the new-member state,
      // the board with no picker. The checks identity is an admin and sees
      // the picker by role.
      await pool.query(
        `INSERT INTO user_enrollments
           (id, user_id, season_id, season_event_id, created_at, updated_at)
         VALUES
           (${base},     $1, $2, NULL, NOW(), NOW()),
           (${base + 1}, $1, $2, $3,   NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [viewerId, SEASON_ID, EVENT_REGULAR_ID]
      );
      // Two completed challenges → the profile's "completed" list and its
      // points header both have content.
      //
      // Rows base+2…base+5 additionally give the home-screen Challenges
      // card (#911) something to draw: one completion on the binary 900511
      // (→ "✓ Done"), and three units on the numeric 900512 (→ 3 of 8;
      // that card derives numeric progress by counting ledger rows, see
      // resolveProgress in src/routes/home-panels.js). 900510 and 900513
      // are deliberately left uncredited so the not-done chip and the
      // empty bar are both on screen too. ONE statement per table per
      // viewer, deliberately — tests/topochain-staging-seed.test.js pins
      // that shape ("seeded once per viewer, not once in total").
      //
      // Rows base+6…base+8 additionally put 900513 at 3 of 5 — a clear
      // MID-PROGRESS bar (the outlined track visibly part-filled), which
      // 0/5 and 3/8 alone didn't give a reviewer. 900511 (base+2) is the
      // binary the viewer has COMPLETED, so the ✓ state is seeded too.
      //
      // Rows base+9…base+13 credit 900514 to its full target of five,
      // which is the FINISHED NUMERIC state: a bar filled end to end with
      // the ✓ beside it. It sits next to the completed binary (900511) in
      // the expanded list, which is where a reviewer can compare the two
      // kinds of "done" side by side.
      //
      // Ids base+2…base+13 all sit inside the viewer's 20-wide block.
      await pool.query(
        `INSERT INTO user_activities
           (id, user_id, season_event_id, activity_type, points, description,
            metadata, activity_at, challenge_id)
         VALUES
           (${base},     $1, $2, 'challenge_completion', 250, 'Reported a reproducible bug.',
            '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '4 days', 900500),
           (${base + 1}, $1, $2, 'challenge_completion', 100, 'Sent a testnet transaction.',
            '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '3 days', 900501),
           (${base + 2}, $1, $2, 'challenge_completion', 50, 'Shared the season announcement.',
            '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '2 days', 900511),
           (${base + 6}, $1, $2, 'COMMUNITY', 250, 'Gave kudos to a builder (1 of 5).',
            '{"kind": "kudos_given"}'::jsonb, NOW() - INTERVAL '30 hours', 900513),
           (${base + 7}, $1, $2, 'COMMUNITY', 250, 'Gave kudos to a builder (2 of 5).',
            '{"kind": "kudos_given"}'::jsonb, NOW() - INTERVAL '20 hours', 900513),
           (${base + 8}, $1, $2, 'COMMUNITY', 250, 'Gave kudos to a builder (3 of 5).',
            '{"kind": "kudos_given"}'::jsonb, NOW() - INTERVAL '10 hours', 900513),
           (${base + 3}, $1, $2, 'COMMUNITY', 200, 'Tested a demo dApp (1 of 8).',
            '{"kind": "app_tested"}'::jsonb, NOW() - INTERVAL '2 days', 900512),
           (${base + 4}, $1, $2, 'COMMUNITY', 200, 'Tested a demo dApp (2 of 8).',
            '{"kind": "app_tested"}'::jsonb, NOW() - INTERVAL '1 days', 900512),
           (${base + 5}, $1, $2, 'COMMUNITY', 200, 'Tested a demo dApp (3 of 8).',
            '{"kind": "app_tested"}'::jsonb, NOW() - INTERVAL '6 hours', 900512),
           (${base + 9},  $1, $2, 'COMMUNITY', 180, 'Voted on a proposal (1 of 5).',
            '{"kind": "vote_cast"}'::jsonb, NOW() - INTERVAL '4 days', 900514),
           (${base + 10}, $1, $2, 'COMMUNITY', 180, 'Voted on a proposal (2 of 5).',
            '{"kind": "vote_cast"}'::jsonb, NOW() - INTERVAL '3 days', 900514),
           (${base + 11}, $1, $2, 'COMMUNITY', 180, 'Voted on a proposal (3 of 5).',
            '{"kind": "vote_cast"}'::jsonb, NOW() - INTERVAL '2 days', 900514),
           (${base + 12}, $1, $2, 'COMMUNITY', 180, 'Voted on a proposal (4 of 5).',
            '{"kind": "vote_cast"}'::jsonb, NOW() - INTERVAL '28 hours', 900514),
           (${base + 13}, $1, $2, 'COMMUNITY', 180, 'Voted on a proposal (5 of 5).',
            '{"kind": "vote_cast"}'::jsonb, NOW() - INTERVAL '5 hours', 900514)
         ON CONFLICT (id) DO NOTHING`,
        [viewerId, EVENT_REGULAR_ID]
      );
      // A rank the profile header can show — and, since the home screen's
      // Challenges widget previews these same standings, the "you" row of
      // its leaderboard fill. Rank 2 on 350 points ties the fixture user
      // holding exactly those points, so seeding several viewers reads as
      // a tie rather than as three contradictory #1s.
      await pool.query(
        `INSERT INTO leaderboard_snapshots
           (id, season_event_id, user_id, rank, total_points, extra_points,
            snapshot_at, season_id, created_at, updated_at)
         VALUES (${base}, $2, $1, 2, 350, 0, NOW(), $3, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [viewerId, EVENT_REGULAR_ID, SEASON_ID]
      );
      // Gives the profile's blurred "Reveal" token figure something to
      // reveal — otherwise that control renders against a null allocation.
      await pool.query(
        `INSERT INTO token_allocation
           (id, user_id, season_id, total_points, total_season_tokens,
            allocated_tokens, description, created_at, updated_at)
         VALUES (${base}, $1, $2, 350, 3500, 35.00000000,
                 'Staging demo allocation (viewer)', NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [viewerId, SEASON_ID]
      );
      // Block-production numbers for the profile's epoch breakdown.
      await pool.query(
        `INSERT INTO epoch_stats
           (id, chain_id, wallet_address, user_id, epoch, epoch_won_slots,
            epoch_produced_blocks, epoch_canonical_blocks, epoch_orphaned_blocks,
            epoch_failed_blocks, created_at, updated_at)
         VALUES
           (${base},     'staging-demo-chain-1', $2, $1, 100, 3, 2, 2, 0, 0, NOW(), NOW()),
           (${base + 1}, 'staging-demo-chain-1', $2, $1, 101, 4, 4, 3, 1, 0, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [viewerId, VIEWER_WALLET]
      );
    }

    log.info('db', 'Topochain staging viewer credits seeded', {
      viewers: viewerRows.length,
    });
  } catch (err) {
    log.warn('db', 'Topochain staging viewer-credit seeding failed', {
      message: err.message,
    });
  }
}

// Profile customization fixtures (issue #982).
//
// TWO of the three "missing in staging" categories apply here:
//   1. `user_avatars` is a brand-new table — the boot migration creates it
//      EMPTY in every staging clone, so without this seed the profile
//      screen, the drawer row and the edit sheet all show the
//      initial-circle fallback and the image path is never exercised.
//   2. `users.bio` is new for the same reason, and `display_name` is null
//      for most cloned accounts (production: 71 of 299), so the identity
//      card would render as a bare @handle with nothing under it.
//
// The COMPLETED-CHALLENGES half needs no new activity rows:
// seedStagingTopochain above already credits every viewer identity across
// a deliberate mix — binary done (900500/900501/900511), numeric done
// (900514, 5 of 5) and numeric NOT done (900512 at 3 of 8, 900513 at
// 3 of 5) — which is exactly the regression coverage the per-user done
// rule needs on screen. Those challenges sit on EVENT_REGULAR_ID inside
// SEASON_ID, the season fetchProfileSeason resolves.
//
// Avatar bytes are inline base64 16x16 solid-colour PNGs (79 bytes each):
// enough to prove GET /avatars/:id serves real image bytes with the right
// content type, small enough to keep the migration cheap. Ids are fixed so
// re-running the seed on every staging boot is a no-op.
// The size/digest the real upload route records, derived from the same
// bytes rather than hardcoded beside them — a fixture whose metadata
// disagreed with its BYTEA would be a trap for whoever reads the table
// next.
function pngBytes(b64) {
  return Buffer.from(b64, 'base64').length;
}
function pngSha256(b64) {
  return crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
}

async function seedStagingProfileCustomization(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  // 16x16 solid PNGs. Distinct colours so three seeded viewers are
  // visually distinguishable in a screenshot.
  const PNG_VIOLET = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mOosXpLEmIY1TCqYfhqAABPn6MQ2bsByAAAAABJRU5ErkJggg==';
  const PNG_TEAL = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mPgndJBEmIY1TCqYfhqAABqqikQLgE1SQAAAABJRU5ErkJggg==';
  const PNG_AMBER = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4Wc5GEmIY1TCqYfhqAACkxFYQZWitdgAAAABJRU5ErkJggg==';

  try {
    // ─── The viewer identities a tester's eyes look through ────────────
    // Same three the topochain seed grants challenge activity to: the
    // interactive admin login, plus the two capture identities
    // (screenshots sign as usernode-capture, declared dapp.json tests as
    // usernode-capture-admin — see services/visuals.js), so the /#profile
    // check and the before/after shots both render the POPULATED card
    // rather than the empty one.
    //
    // Resolved by username, not by fixed id, because these rows are
    // created by seedAdmin() / the capture bootstrap with serial ids.
    // Avatar ids are keyed off each name's POSITION in the list so a
    // viewer's id never shifts when another identity appears or
    // disappears between boots.
    const VIEWER_USERNAMES = [
      config.adminUsername, 'usernode-capture', 'usernode-capture-admin',
    ];
    const VIEWER_PNGS = [PNG_VIOLET, PNG_TEAL, PNG_AMBER];
    // Fixed 32-hex ids in an obviously-synthetic block — the real route
    // generates random ones, but a seed must be idempotent.
    const VIEWER_AVATAR_IDS = [
      'a0a0a0a0a0a0a0a0a0a0a0a0a0a05201',
      'a0a0a0a0a0a0a0a0a0a0a0a0a0a05202',
      'a0a0a0a0a0a0a0a0a0a0a0a0a0a05203',
    ];

    const { rows: viewerRows } = await pool.query(
      'SELECT id, username FROM users WHERE username = ANY($1::text[])',
      // Filtered for the lookup only — the slot arithmetic below still
      // indexes into the unfiltered list, so an unset adminUsername
      // shifts nobody's avatar id.
      [VIEWER_USERNAMES.filter(Boolean)]
    );

    for (const viewer of viewerRows) {
      const slot = VIEWER_USERNAMES.indexOf(viewer.username);
      if (slot < 0) continue;
      // COALESCE, not a bare assignment: a staging clone may already
      // carry a real display name / handle from production, and the
      // fixture must never clobber it.
      await pool.query(
        `UPDATE users
            SET display_name = COALESCE(display_name, $2),
                bio          = COALESCE(bio, $3),
                github       = COALESCE(github, 'staging-demo'),
                x            = COALESCE(x, 'staging_demo'),
                updated_at   = NOW()
          WHERE id = $1`,
        [viewer.id, `[Staging demo] ${viewer.username}`,
         '[Staging demo] Building the platform from inside the platform. ' +
         'This bio is fixture text, not a real person’s words.']
      );
      const png = VIEWER_PNGS[slot];
      await pool.query(
        `INSERT INTO user_avatars (id, user_id, content_type, size_bytes, data, sha256)
         VALUES ($1, $2, 'image/png', $4, decode($3, 'base64'), $5)
         ON CONFLICT (user_id) DO NOTHING`,
        [VIEWER_AVATAR_IDS[slot], viewer.id, png, pngBytes(png), pngSha256(png)]
      );
    }

    // ─── The kudos-leaderboard fixture accounts ────────────────────────
    // Keyed by USERNAME, not by a fixed id: seedStagingLeaderboardProfile
    // declares staging-demo-author as id 900001, but 900001 is already
    // taken by staging-demo-user (seedStagingDemoAppCard runs first), so
    // its ON CONFLICT DO NOTHING leaves that row named staging-demo-user.
    // Resolving by name means this fixture decorates whoever is actually
    // there, and inserts nothing at all when the account is absent.
    //
    // staging-demo-user GETS a picture; staging-demo-giver deliberately
    // does NOT, so the photo row and the initial-circle fallback are both
    // on screen the moment the leaderboard surfaces land in the follow-up.
    await pool.query(
      `UPDATE users
          SET display_name = COALESCE(display_name, '[Staging demo] Ada Author'),
              bio          = COALESCE(bio, '[Staging demo] Ships small PRs, reviews smaller ones.'),
              github       = COALESCE(github, 'staging-demo-author'),
              updated_at   = NOW()
        WHERE username = 'staging-demo-user'`
    );
    await pool.query(
      `INSERT INTO user_avatars (id, user_id, content_type, size_bytes, data, sha256)
       SELECT 'a0a0a0a0a0a0a0a0a0a0a0a0a0a05210', id, 'image/png', $2,
              decode($1, 'base64'), $3
         FROM users WHERE username = 'staging-demo-user'
       ON CONFLICT (user_id) DO NOTHING`,
      [PNG_TEAL, pngBytes(PNG_TEAL), pngSha256(PNG_TEAL)]
    );
    // staging-demo-giver keeps NO avatar on purpose — see above. It gets a
    // display name only, so the fallback row still reads as a real person.
    await pool.query(
      `UPDATE users
          SET display_name = COALESCE(display_name, '[Staging demo] Grace Giver'),
              updated_at   = NOW()
        WHERE username = 'staging-demo-giver'`
    );

    log.info('db', 'Profile-customization staging fixtures seeded', {
      viewers: viewerRows.length,
    });
  } catch (err) {
    log.warn('db', 'Profile-customization staging fixtures seeding failed', {
      message: err.message,
    });
  }
}

// Per-app postgres role migration. Pre-migration model: every per-app
// database (`app_<slug>`) is owned by the shared `usernode` superuser
// and accessed via DATABASE_URL embedding the superuser password.
// Compromise of any one app's URL grants access to every DB in the
// cluster. Post-migration model: each DB has a dedicated role
// `<dbName>_owner` with a unique random password persisted in
// apps.db_password (staging:private). Compromise of one app's URL
// only authorizes access to that one DB.
//
// This runs on every platform boot, idempotent in two modes:
//   - Adopt (db_password IS NULL): create role, ALTER DATABASE OWNER,
//     REASSIGN OWNED, REVOKE PUBLIC, persist password. After this
//     succeeds, the running app container's URL is stale (still
//     superuser); we restart it via app-respawn so it picks up the
//     new credential immediately.
//   - Verify (db_password IS NOT NULL): confirm the role exists with
//     the stored password. If it was dropped (manual postgres
//     intervention, partial backup restore, etc.), recreate it.
//
// Skipped for self_hosted apps: the platform's own DB is owned by
// the `usernode` superuser intentionally — db-manager needs that
// superuser to spawn child app DBs and create roles.
//
// Failure for any one app is logged but does NOT abort boot; other
// apps continue to migrate. A failed adoption leaves the app in the
// pre-migration state (still working with the shared superuser URL)
// and will be retried on next boot.
async function migrateAppDbsToPerRole(pool, config) {
  // A preview owns one already-created clone and receives only that clone's
  // DATABASE_URL. It deliberately has no DB_ADMIN_URL and must not inspect or
  // repair roles for the production child-app fleet. The production platform
  // runs this migration before the clone is made, so the copied app metadata
  // is already current. Besides being unnecessary, spawning one psql role
  // check per copied app added about 22 seconds to every self-app preview.
  if (process.env.USERNODE_ENV === 'staging') {
    log.info('db', 'Per-app role migration skipped in staging preview');
    return;
  }

  log.info('db', 'Running per-app role migration');

  const { rows } = await pool.query(
    `SELECT id, slug, container_id, manifest_snapshot, db_password, status, self_hosted
       FROM apps
       WHERE COALESCE(self_hosted, FALSE) = FALSE
         AND status NOT IN ('deleted', 'creating', 'awaiting_secrets')`
  );

  if (rows.length === 0) {
    log.info('db', 'No apps to migrate to per-role model');
    return;
  }

  const respawnQueue = [];
  let adopted = 0, verified = 0, recreated = 0, skipped = 0, failed = 0;

  for (const app of rows) {
    const dbName = dbManager.appDbName(app.slug);

    try {
      if (!app.db_password) {
        // First-time adoption. Verify the DB actually exists before
        // trying to ALTER it — apps in transient states (failed
        // create, errored mid-deploy) might be in apps without a
        // matching postgres database yet.
        const exists = await dbManager.databaseExists(dbName);
        if (!exists) {
          log.info('db', 'Skipping per-role migration; app DB does not exist yet', {
            slug: app.slug, dbName, status: app.status,
          });
          skipped += 1;
          continue;
        }
        const { password } = await dbManager.adoptExistingDatabase(dbName);
        await pool.query(
          'UPDATE apps SET db_password = $1 WHERE id = $2',
          [password, app.id]
        );
        // Mutate in place so the respawn loop sees the new password.
        app.db_password = password;
        adopted += 1;
        if (app.status === 'running' && app.container_id) {
          respawnQueue.push(app);
        }
      } else {
        // Verify role still exists; recreate with stored password if not.
        const role = dbManager.ownerRoleName(dbName);
        const exists = await dbManager.roleExists(role);
        if (!exists) {
          await dbManager.ensureRoleExists(dbName, app.db_password);
          recreated += 1;
        } else {
          verified += 1;
        }
      }
    } catch (err) {
      log.error('db', 'Per-role migration failed for app', {
        slug: app.slug, dbName, err: err.message,
      });
      failed += 1;
    }
  }

  log.info('db', 'Per-app role migration scan complete', {
    adopted, verified, recreated, skipped, failed,
    toRespawn: respawnQueue.length,
  });

  // Restart freshly-adopted apps so they pick up the per-role URL.
  // Sequential rather than parallel: each restart briefly stops a
  // child app, and we don't want a thundering herd of new container
  // boots all hitting Docker at once on a small VPS.
  if (respawnQueue.length > 0) {
    log.info('db', 'Respawning freshly-adopted app containers', {
      count: respawnQueue.length, apps: respawnQueue.map((a) => a.slug),
    });
    const { respawnAppContainer } = require('../services/app-respawn');
    for (const app of respawnQueue) {
      try {
        await respawnAppContainer(config, app);
      } catch (err) {
        log.error('db', 'App respawn failed during per-role migration', {
          slug: app.slug, err: err.message,
        });
      }
    }
  }
}

// Staging fixture for the outbound-mail card (Admin → Topochain →
// Settings). `mail_deliveries` is tagged staging:private, so a staging
// clone TRUNCATEs it and the card renders an empty "no mail yet" table —
// which shows nothing about how the card actually looks with each status
// in it. These five rows cover every status the renderer branches on:
// sent, skipped_staging, suppressed_rate_limit, failed, no_transport.
//
// All addresses are @example.invalid (reserved by RFC 2606, can never
// resolve) and all are visibly named staging-demo-*, so nobody mistakes
// one for a real signup. The waitlist row exists so a tester can exercise
// the confirm link end to end against a known token.
async function seedStagingPlatformMail(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  // Obvious, fixed tokens so the testing steps can name the exact URL.
  // 48 hex chars each, matching the real more_token shape. Three rows,
  // one per state the stage-2 screen's status pill can be in — the pill
  // is derived from timestamps a tester cannot set by clicking, so
  // without fixtures two of its three states are unreachable in a
  // preview.
  const DEMO_MORE_TOKEN = 'dead'.repeat(12);          // pending
  const DEMO_CONFIRMED_TOKEN = 'beef'.repeat(12);     // confirmed, not admitted
  const DEMO_ADMITTED_TOKEN = 'cafe'.repeat(12);      // admitted, account linked

  const ROWS = [
    // A staging preview never delivers, so this is the status a tester's
    // OWN actions produce here.
    { kind: 'otp', to: 'staging-demo-user@example.invalid', provider: 'log', status: 'skipped_staging', error: null },
    { kind: 'waitlist_joined', to: 'staging-demo-waitlist@example.invalid', provider: 'log', status: 'skipped_staging', error: null },
    // A REQUESTED code, from POST /api/public/waitlist/resend or a re-join.
    // Its own kind because waitlist_joined is capped at one per address per
    // day, which is the thing a resend exists to work around. Seeded so the
    // admin mail log shows the kind at all in a preview: without a row, a
    // reviewer cannot tell the filter has a value for it.
    { kind: 'waitlist_code', to: 'staging-demo-waitlist@example.invalid', provider: 'log', status: 'skipped_staging', error: null },
    // The throttled shape of the same kind: what a sixth request in a day
    // records. It delivers nothing and counts toward nothing, and the log is
    // the only place that is visible.
    { kind: 'waitlist_code', to: 'staging-demo-throttled@example.invalid', provider: 'log', status: 'suppressed_rate_limit', error: 'another waitlist_code mail went to this address 12s ago' },
    // What production looks like when it works.
    { kind: 'waitlist_released', to: 'staging-demo-released@example.invalid', provider: 'gmail', status: 'sent', error: null },
    // The same kind, addressed to the ADMITTED waitlist fixture (900502).
    // The waitlist screen's Details block reads this row back to answer
    // "did the 'you're in' mail actually leave?", which is otherwise
    // invisible: mail_deliveries is staging:private, so without a fixture
    // every admitted row in a preview reads "No delivery recorded" and the
    // line looks broken rather than empty.
    { kind: 'waitlist_released', to: 'staging-demo-topochain-waitlist-3@example.invalid', provider: 'gmail', status: 'sent', error: null },
    // The throttle firing, which is the system working, not an error.
    { kind: 'otp', to: 'staging-demo-throttled@example.invalid', provider: 'log', status: 'suppressed_rate_limit', error: 'another otp mail went to this address 12s ago' },
    // A provider refusal, so the card's error column is exercised.
    { kind: 'otp', to: 'staging-demo-broken@example.invalid', provider: 'gmail', status: 'failed', error: 'Staging demo — provider rejected the sender' },
    // Admin → Email delivery sends kind='admin_test'. Its "Test emails
    // only" filter would show an empty table in a fresh preview
    // otherwise, and an empty table looks identical to a broken filter.
    { kind: 'admin_test', to: 'staging-demo-mailtest@example.invalid', provider: 'gmail', status: 'sent', error: null },
    { kind: 'admin_test', to: 'staging-demo-mailfail@example.invalid', provider: 'gmail', status: 'failed', error: 'Staging demo — HTTP 401: invalid_grant' },
    { kind: 'admin_test', to: 'staging-demo-mailskipped@example.invalid', provider: 'log', status: 'skipped_staging', error: null },
  ];

  try {
    // Idempotent by (recipient, kind, status): re-running a boot must not
    // grow the table. mail_deliveries has no natural unique key (it is an
    // append-only log in real use), so the guard is an existence check
    // scoped to the obviously-synthetic addresses.
    for (const row of ROWS) {
      await pool.query(
        // The ::text casts are load-bearing. In `INSERT … SELECT $1`
        // Postgres cannot take a parameter's type from the target column,
        // so $1/$2/$4 stay `unknown` in the SELECT list while the same
        // placeholders resolve to varchar against the columns in the
        // NOT EXISTS — "inconsistent types deduced for parameter $1", which
        // skipped this whole fixture on every staging boot.
        `INSERT INTO mail_deliveries (kind, recipient, provider, status, error)
         SELECT $1::text, $2::text, $3::text, $4::text, $5::text
          WHERE NOT EXISTS (
            SELECT 1 FROM mail_deliveries
             WHERE recipient = $2::text AND kind = $1::text AND status = $4::text
          )`,
        [row.kind, row.to, row.provider, row.status, row.error]
      );
    }

    // An unconfirmed waitlist signup with a known token, so a tester can
    // open /api/public/waitlist/confirm/<token> and watch confirmed_at
    // appear in Admin → Topochain → Waitlist.
    await pool.query(
      `INSERT INTO waitlist_signups (email, answers, more_token)
       VALUES ($1, NULL, $2)
       ON CONFLICT (email) DO NOTHING`,
      ['staging-demo-waitlist@example.invalid', DEMO_MORE_TOKEN]
    );
    // Never pre-confirmed: the point is that a tester makes it happen.
    await pool.query(
      `UPDATE waitlist_signups SET confirmed_at = NULL, more_token = $2
        WHERE email = $1 AND released_at IS NULL AND linked_user_id IS NULL`,
      ['staging-demo-waitlist@example.invalid', DEMO_MORE_TOKEN]
    );

    // A signup that has confirmed its address and is still waiting. The
    // middle state, and the one a tester cannot produce here: confirming
    // the row above takes a click, but the pill it then shows is the
    // point, so it needs a row that is already there.
    await pool.query(
      `INSERT INTO waitlist_signups (email, answers, more_token)
       VALUES ($1, NULL, $2)
       ON CONFLICT (email) DO NOTHING`,
      ['staging-demo-waitlist-confirmed@example.invalid', DEMO_CONFIRMED_TOKEN]
    );
    await pool.query(
      `UPDATE waitlist_signups
          SET confirmed_at = COALESCE(confirmed_at, NOW() - INTERVAL '2 days'),
              released_at = NULL,
              linked_user_id = NULL,
              more_token = $2
        WHERE email = $1`,
      ['staging-demo-waitlist-confirmed@example.invalid', DEMO_CONFIRMED_TOKEN]
    );

    // A signup that has been let in AND has redeemed the invite into an
    // account. linked_user_id points at 900001, the canonical fake
    // `staging-demo-user` seeded before any fixture runs — never a real
    // account, and never whoever opened the preview. Nothing keys off
    // this row: linkUserByEmail matches on EMAIL, and no address ending
    // in .invalid can be registered.
    await pool.query(
      `INSERT INTO waitlist_signups (email, answers, more_token)
       VALUES ($1, NULL, $2)
       ON CONFLICT (email) DO NOTHING`,
      ['staging-demo-waitlist-admitted@example.invalid', DEMO_ADMITTED_TOKEN]
    );
    await pool.query(
      `UPDATE waitlist_signups
          SET confirmed_at = COALESCE(confirmed_at, NOW() - INTERVAL '9 days'),
              released_at = COALESCE(released_at, NOW() - INTERVAL '1 day'),
              linked_user_id = COALESCE(
                linked_user_id,
                (SELECT id FROM users WHERE username = 'staging-demo-user')
              ),
              more_token = $2
        WHERE email = $1`,
      ['staging-demo-waitlist-admitted@example.invalid', DEMO_ADMITTED_TOKEN]
    );

    // A live verification code for the two CONFIRMED addresses, so a
    // tester can exercise #1538's check-my-status read without a mailbox.
    // Both of those addresses end in .invalid, so the code mail this
    // flow would normally send can never actually be delivered — the
    // seeded literal is the only way in, and it is the whole reason the
    // staging preview can show the confirmed and admitted panels at all.
    //
    // Not a shortcut through the real check: the app still hashes what
    // was typed and bcrypt.compares it against this row, still counts
    // attempts, still consumes the row on success. Only the code's VALUE
    // is known. Nothing outside staging is touched, and the two rows are
    // for fake identities, never whoever opened the preview.
    //
    // Idempotent by the same existence check issueVerificationCode's
    // uniqueness rests on: one unconsumed row per address. Consuming it
    // (which the tester does on the first successful read) leaves the
    // next boot free to seed a fresh one, so the fixture heals rather
    // than accumulating duplicates.
    const DEMO_STATUS_CODE = '000000';
    const demoCodeHash = await bcrypt.hash(DEMO_STATUS_CODE, 10);
    for (const email of [
      'staging-demo-waitlist-confirmed@example.invalid',
      'staging-demo-waitlist-admitted@example.invalid',
    ]) {
      await pool.query(
        `INSERT INTO waitlist_verification_codes (email, code_hash, expires_at)
         SELECT $1::text, $2::text, NOW() + INTERVAL '30 days'
          WHERE NOT EXISTS (
            SELECT 1 FROM waitlist_verification_codes
             WHERE email = $1::text AND consumed_at IS NULL
          )`,
        [email, demoCodeHash]
      );
    }

    // ── The two delivery states #2201 turns on, as fixtures ────────────
    //
    // Both are about mail that does NOT go out, which is exactly the kind
    // of state a preview cannot reach by clicking: a tester would have to
    // sit through a real 24-hour window, or hit submit twice inside one
    // second and hope. Seeded, each is one address away.

    // 1. AT THE DAILY CEILING. An unconfirmed signup carrying a full
    // window of counted waitlist_code sends, so the next ask is refused
    // by the per-address cap in services/mail/rate-limit.js. What it
    // makes reachable is the screen's answer to that: the join still
    // returns 200 and still advances to the code step, no code arrives,
    // and the constant cap advisory beside the send controls is the only
    // thing that explains why. Reviewing that sentence in place is the
    // point of the fixture.
    const CAPPED_EMAIL = 'staging-demo-waitlist-capped@example.invalid';
    await pool.query(
      `INSERT INTO waitlist_signups (email, answers, more_token)
       VALUES ($1, NULL, $2)
       ON CONFLICT (email) DO NOTHING`,
      [CAPPED_EMAIL, 'feed'.repeat(12)]
    );
    await pool.query(
      `UPDATE waitlist_signups
          SET confirmed_at = NULL, released_at = NULL, linked_user_id = NULL
        WHERE email = $1`,
      [CAPPED_EMAIL]
    );
    // Idempotent by SHORTFALL rather than by an existence check: the rows
    // are identical to each other by construction (same recipient, kind
    // and status), so the (recipient, kind, status) guard the ROWS loop
    // above uses would seed exactly one of them and call it done. Topping
    // the window up to the ceiling is also what heals it — rows age out
    // of the 24h window on a long-lived container, and the next boot puts
    // back however many are missing.
    const { rows: cappedRows } = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM mail_deliveries
        WHERE recipient = $1 AND kind = 'waitlist_code'
          AND status IN ('sent', 'skipped_staging')
          AND created_at > NOW() - INTERVAL '24 hours'`,
      [CAPPED_EMAIL]
    );
    // The cap the rule actually enforces, read from the rule rather than
    // written down twice: a fixture that hardcoded 10 would stop sitting
    // at the ceiling the moment somebody retuned it, and would do so
    // silently.
    const codeCap = mailRateLimit.RULES.waitlist_code.perWindow;
    const shortfall = Math.max(0, codeCap - (cappedRows[0]?.n || 0));
    if (shortfall > 0) {
      // Spaced 90 minutes apart, so all of them sit inside the 24h window
      // and the newest is far outside the one-minute gap. That matters:
      // it makes the DAILY CEILING the reason the next send is refused,
      // which is the state being demonstrated, rather than the gap, which
      // any double-tap reaches.
      await pool.query(
        `INSERT INTO mail_deliveries (kind, recipient, provider, status, created_at)
         SELECT 'waitlist_code', $1::text, 'log', 'sent',
                NOW() - (INTERVAL '90 minutes' * g.i)
           FROM generate_series(1, $2::int) AS g(i)`,
        [CAPPED_EMAIL, shortfall]
      );
    }

    // 2. INSIDE THE REUSE WINDOW. An unconfirmed signup whose live code
    // was minted seconds ago, which is the state a re-join must answer by
    // doing nothing at all: no new code minted, the live one left alone,
    // no second mail. Before #2201 this was the damaging case — minting
    // deletes every unconsumed code first and the throttle only decides
    // afterwards, so a second ask inside the minute destroyed the code
    // that was already in the inbox and delivered nothing in its place.
    //
    // The window is 60 seconds from the created_at below, so this fixture
    // is live for the first minute after a boot and the UPDATE is what
    // makes every redeploy a fresh minute. A tester who arrives later
    // reproduces it the same way a person does: ask for a code, then ask
    // again straight away.
    const FRESH_EMAIL = 'staging-demo-waitlist-fresh@example.invalid';
    await pool.query(
      `INSERT INTO waitlist_signups (email, answers, more_token)
       VALUES ($1, NULL, $2)
       ON CONFLICT (email) DO NOTHING`,
      [FRESH_EMAIL, 'f00d'.repeat(12)]
    );
    await pool.query(
      `UPDATE waitlist_signups
          SET confirmed_at = NULL, released_at = NULL, linked_user_id = NULL
        WHERE email = $1`,
      [FRESH_EMAIL]
    );
    // Same DEMO_STATUS_CODE as the confirmed fixtures, so the code path
    // stays walkable: a tester can type 000000 and watch it confirm.
    // attempts = 0 and a real future expiry are not decoration — they are
    // three of the four things hasReusableCode() checks, and a fixture
    // that got one wrong would demonstrate the opposite of the state it
    // is named for.
    await pool.query(
      `INSERT INTO waitlist_verification_codes (email, code_hash, expires_at)
       SELECT $1::text, $2::text, NOW() + INTERVAL '15 minutes'
        WHERE NOT EXISTS (
          SELECT 1 FROM waitlist_verification_codes
           WHERE email = $1::text AND consumed_at IS NULL
        )`,
      [FRESH_EMAIL, demoCodeHash]
    );
    // Re-arm an existing row instead of stacking a second one beside it.
    // issueVerificationCode's whole contract is that exactly one code is
    // live per address, so a fixture that inserted a duplicate would seed
    // a state the app itself cannot produce.
    await pool.query(
      `UPDATE waitlist_verification_codes
          SET created_at = NOW(),
              expires_at = NOW() + INTERVAL '15 minutes',
              attempts = 0
        WHERE email = $1 AND consumed_at IS NULL`,
      [FRESH_EMAIL]
    );
    // The delivery that carried it. Without this row the throttle would
    // allow another send, and "the code is live but nothing was mailed"
    // is not a state the app can be in.
    await pool.query(
      `INSERT INTO mail_deliveries (kind, recipient, provider, status)
       SELECT 'waitlist_code', $1::text, 'log', 'sent'
        WHERE NOT EXISTS (
          SELECT 1 FROM mail_deliveries
           WHERE recipient = $1::text AND kind = 'waitlist_code'
             AND status = 'sent'
             AND created_at > NOW() - INTERVAL '5 minutes'
        )`,
      [FRESH_EMAIL]
    );

    log.info('migrate', 'Staging platform-mail fixture seeded', {
      deliveries: ROWS.length,
    });
  } catch (err) {
    // Same contract as every other staging seed: a fixture failure must
    // never stop a boot.
    log.warn('migrate', 'Staging platform-mail seed skipped', { message: err.message });
  }
}

// seedStagingTopochain is exported alongside migrate() solely so
// tests/topochain-staging-seed.test.js can invoke it directly against a
// mock pool (idempotency/param-flow behaviour, not just a source-text
// regex) without running the entire migrate() boot sequence. It is not
// meant to be called from anywhere else in the app.
module.exports = {
  migrate, seedStagingTopochain, seedStagingProfileCustomization,
  seedStagingPlatformMail, auditDuplicatePrSessions,
  migrateWaitlistCountryCodes,
  backfillProposalIssuerAssignments,
  seedStagingTopicScrollThreads, seedStagingLlmUsage, seedStagingHomeLayout,
  seedStagingAnalyticsCharts, seedStagingSpendDistribution,
};
