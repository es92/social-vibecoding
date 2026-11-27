const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getPool } = require('./pool');
const log = require('../services/logger');
const appManifest = require('../services/app-manifest');
const dbManager = require('../services/db-manager');
const { encrypt } = require('../services/secrets');
const { reindexAfterHostMove } = require('./reindex-after-host-move');
const { applySchemaWithLockRetry } = require('./schema-migrations');
const { seedReferenceData } = require('./reference-data');
const { withStagingMedia } = require('../services/staging-media');
const media = require('../services/media-store');
const { runSeedWithOutcome, seedSkipped } = require('./staging-seed-outcome');
// Read by seedStagingPlatformMail's at-the-ceiling fixture, so the number
// of seeded sends tracks the rule instead of restating it.
const mailRateLimit = require('../services/mail/rate-limit');

// What a staging fixture's password is hashed at. Each is a literal written
// in this file, or random bytes nobody keeps, for an account that exists
// only in a preview, so a slow hash protects nothing, and at the cost real
// passwords get (12) the three of them were 0.6 seconds of every preview's
// start. bcrypt.compare reads the cost from the hash, so signing in with
// them works as before. Never used for anything a person chose.
const STAGING_FIXTURE_BCRYPT_COST = 4;

// One entry of STAGING_SEEDS (which follows migrate()). `background` keeps a
// slow seed off the boot's critical path as it always was; `ownCopyOnly`
// marks a seed that reaches beyond the database, so the pair's other copy
// never runs it; `phaseEnd` is a boot timing boundary that falls inside the
// list.
function stagingSeed(name, run, options = {}) {
  return Object.freeze({ name, run, ...options });
}

/**
 * Run the staging seeds in order. With no `each`, exactly as a boot always
 * has: awaited, except a `background` seed which is left to finish on its
 * own. With `each(entry)`, awaits it for every seed in order (background
 * seeds too) and skips `ownCopyOnly` ones; `onPhase` hears a phase boundary
 * that falls inside the list.
 */
async function runStagingSeeds(pool, config, {
  each = null, onPhase = null, seeds = STAGING_SEEDS, onOutcome = null,
} = {}) {
  const outcomes = [];
  const boot = typeof each !== 'function';
  // Background seeds are fired, not awaited; the report is written once when
  // the last of them settles, not once per seed — a boot's own writes are
  // what a check copy's first requests run beside, and N-1 of them said
  // nothing new.
  let pending = 0;
  let registered = false;
  const settle = (outcome) => {
    outcomes.push(outcome);
    onOutcome?.(outcome);
    return outcome;
  };
  const settled = async () => {
    pending -= 1;
    if (boot && registered && pending === 0) await writeStagingSeedReport(pool, outcomes);
  };
  for (const entry of seeds) {
    if (typeof each === 'function') {
      if (entry.ownCopyOnly) continue;
      await each(entry);
    } else if (entry.background) {
      pending += 1;
      void runSeedWithOutcome(entry, pool, config)
        .then((outcome) => settle(outcome))
        .catch((error) => {
          log.warn('db', 'A background staging seed failed', { seed: entry.name, message: error?.message || String(error) });
        })
        .finally(() => settled());
    } else {
      settle(await runSeedWithOutcome(entry, pool, config));
    }
    if (entry.phaseEnd) onPhase?.(entry.phaseEnd);
  }
  registered = true;
  // After the seeds a boot waits for. A background one still running when
  // this lands writes the report again when the last of them settles.
  if (boot) await writeStagingSeedReport(pool, outcomes);
  return outcomes;
}

// The non-`wrote` outcomes of a boot's staging seeds, in `platform_settings`
// so a screenshot run can name the demo data its after copy never got (#7172).
// A fresh copy's seeds rerun on every boot; this row is rewritten, never
// duplicated.
const SEED_REPORT_KEY = 'staging_seed_report';
async function writeStagingSeedReport(pool, outcomes) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const wroteNothing = outcomes
    .filter((outcome) => outcome && outcome.outcome && outcome.outcome !== 'wrote')
    .slice(0, 300)
    .map(({ name, outcome, reason }) => ({ name, outcome, reason: reason || null }));
  try {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [SEED_REPORT_KEY, JSON.stringify({ version: 1, outcomes: wroteNothing })]);
  } catch (error) {
    log.warn('db', 'Could not record what the staging seeds did', { message: error?.message || String(error) });
  }
}

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

  // #687 (PR-import, Slice 1): READ-ONLY pre-flight guard. Run BEFORE the
  // schema apply so we abort the boot cleanly (before any DDL) if the
  // invariant the PR-import feature is about to rely on is already
  // violated in this database. Read-and-throw only — it never mutates.
  await auditDuplicatePrSessions(pool);
  finishPhase('preflightMs');

  log.info('db', 'Running migrations...');
  await applySchemaWithLockRetry(pool);
  await seedReferenceData(pool);
  // Never fails a boot, and costs one query once every email has its row. The
  // seeds are English and read no translation, so a preview seeds here too.
  await require('./email-template-seeds').seedEmailTemplates(pool);
  await require('../services/moderation-migration').importLegacyReports(pool);
  await require('../services/moderation').purgeExpired(pool);
  // The verified-identity rule's one-time production rollout: on, with $20
  // a week for new members who have not verified (services/identity-rollout.js).
  await require('../services/identity-rollout').applyIdentityRollout(pool);
  // The move off GitHub (services/github-move.js): requests from their
  // twins, each app whose repository is now on the git host repointed, and
  // its proposals' GitHub links turned into their change pages.
  await require('../services/github-move').migrate(pool);
  // Threads (#6019, stage 1): attach every request, change, governance row
  // and message that existed before threads did. After the move above, so a
  // request it copied has its thread; once, behind its marker.
  await require('../services/threads').backfill(pool);
  // And, once, whether each thread is open or closed (the follow-up's
  // threads_refresh_state keeps that current from now on).
  await require('../services/threads').refreshStates(pool);
  // And, once, the changes that sat in a request's thread only because their
  // PR number was the request's.
  await require('../services/threads').separateNumberCollisions(pool);
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

  await runStagingSeeds(pool, config, { onPhase: finishPhase });
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
  await backfillSettingsProposalSource(pool);
  await markBareDateActivities(pool);
  await migrateWaitlistCountryCodes(pool);
  // Phone review #103: the welcome message's sign-off is a name, not a list.
  await plainWelcomeSignOffs(pool);
  // After backfillVotesRequired, which reads the merge announcements.
  await clearAutomatedChannelLines(pool);
  // 14 Nov 2026: Main Chat is removed. What each person and Homeroom bot
  // said there moves, once, under their Earlier chat thread.
  await moveMainChatToThreads(pool);
  await moveOldChatsToThreads(pool);
  await backfillPlanRows(pool);
  // Artifacts, stage 0: a plan an older build posted during a rollout names its design.
  await require('../services/plan-design-source').backfill(pool);
  await backfillFiledDraftCards(pool);
  await revokeLegacyGithubGrants(pool, config);
  await failOrphanedHeadlessRuns(pool);
  // After the staging fixtures: the changes they made (and any other) up
  // for a vote or merging with no work state yet are marked for the drain.
  await markChangesWithoutWorkState(pool);
  await migrateAppDbsToPerRole(pool, config);
  finishPhase('maintenanceMs');
  timings.totalMs = Date.now() - startedAt;
  log.info('db', 'Migration phases complete', timings);
  return timings;
}

// The staging fixtures in the order a boot has always run them (the calls the
// boot made inline until #7139). The before & after shots runner runs them one
// at a time against the pair's other copy (src/db/seed-other-copy.js), and
// runStagingSeeds runs them all here. Each entry keeps the boot's own call
// text, so the order and the arguments are exactly what main ran; keeping the
// list after migrate() also keeps each call where a reader of the boot expects
// it.
const STAGING_SEEDS = Object.freeze([
  stagingSeed('reservePreviewReviewerIds', async (pool, config) => { await reservePreviewReviewerIds(pool); }),
  stagingSeed('seedAdmin', async (pool, config) => {
    await seedAdmin(pool, config);
  }),
  stagingSeed('seedCaptureUser', async (pool, config) => { await seedCaptureUser(pool); }),
  stagingSeed('seedCaptureAdminUser', async (pool, config) => { await seedCaptureAdminUser(pool); }),
  stagingSeed('seedStagingLongInbox', async (pool, config) => { await seedStagingLongInbox(pool); }),
  // #7159: three web sign-ins of the fixture member from one kind of browser,
  // so Settings › Linked devices has a device that holds several.
  stagingSeed('seedStagingLinkedBrowsers', async (pool, config) => { await seedStagingLinkedBrowsers(pool); }),
  // Must run BEFORE every staging fixture — a dozen of them own rows via a
  // hard-coded created_by = 900001. See seedStagingDemoUser.
  stagingSeed('seedStagingDemoUser', async (pool, config) => { await seedStagingDemoUser(pool); }),
  stagingSeed('seedStagingAdminDetailsUser', async (pool, config) => { await seedStagingAdminDetailsUser(pool); }),
  stagingSeed('seedStagingSupportUser', async (pool, config) => { await seedStagingSupportUser(pool); }),
  stagingSeed('seedStagingDuplicateUser', async (pool, config) => { await seedStagingDuplicateUser(pool); }),
  stagingSeed('seedSelfApp', async (pool, config) => { await seedSelfApp(pool, config); }),
  stagingSeed('seedTermsVersions', async (pool, config) => { await seedTermsVersions(pool); }),
  stagingSeed('seedStagingPrivateRequest', async (pool, config) => { await seedStagingPrivateRequest(pool); }),
  // #6664's shots: a project anyone may see but only its collaborators may
  // take part in, with a vote waiting that the capture member can see and
  // cannot cast. Obviously fake, staging only.
  stagingSeed('seedStagingCollabOnlyVote', async (pool, config) => { await seedStagingCollabOnlyVote(pool); }),
  // #6990's shots: a request with an open vote to close it, so the Votes
  // card that now shows a saved vote at once has a state to show.
  stagingSeed('seedStagingCloseVote', async (pool, config) => { await seedStagingCloseVote(pool); }),
  // #7027's shots: an invitation to build that its person answered by
  // joining the project another way, so the bell row reads as an offer and
  // the member list tags them "offered to build". Obviously fake, staging
  // only.
  stagingSeed('seedStagingJoinedBuildOffer', async (pool, config) => { await seedStagingJoinedBuildOffer(pool); }),
  // Mobile 04's shots (24 Nov 2026): somebody named the capture member with
  // @ in a request's thread, so the Homeroom bot tab's Needs you has its
  // Reply and Dismiss row. Obviously fake, staging only.
  stagingSeed('seedStagingNamedInThread', async (pool, config) => { await seedStagingNamedInThread(pool); }),
  // #6158: a mix of Waiting rows on the Homeroom bot tab (queued, held for
  // a slot, handed back, never read, an operator task), for its shots.
  stagingSeed('seedStagingBotWaitingRows', async (pool, config) => { await seedStagingBotWaitingRows(pool); }),
  // #6667: a request whose bot-built change was handed back to its asker, so
  // the Homeroom bot tab's Needs you row has a state to show.
  stagingSeed('seedStagingBotHandedBackFix', async (pool, config) => { await seedStagingBotHandedBackFix(pool); }),
  // #6533: a change's thread whose bot reply already holds its email pictures.
  // #6420's shots: a change on one request's page that names another request
  stagingSeed('seedStagingChangePictures', async (pool, config) => { await seedStagingChangePictures(pool); }),
  // as one it closes, so that request's page shows "Change #N says it closes
  // this" and the requester can answer it. Obviously fake, staging only.
  stagingSeed('seedStagingChangeClaim', async (pool, config) => { await seedStagingChangeClaim(pool); }),
  // #6306's shots: a request the bot read and found already works, so Needs
  // you says "Already works" with Propose to close and the request's page
  // says why. Staging has no model, so the bot's note is stored.
  stagingSeed('seedStagingBotAlreadyWorks', async (pool, config) => { await seedStagingBotAlreadyWorks(pool); }),
  // #6988's shots: the already-works request's bot offer once it is gone, so
  // its thread says so and carries Propose to close, which opens the close
  // dialog with the bot's reason already in it.
  stagingSeed('seedStagingBotGoneCloseOffer', async (pool, config) => { await seedStagingBotGoneCloseOffer(pool); }),
  // #6752's shots: a request the bot read as filed on the wrong project, so
  // its page and the requester's chat say where it seems to belong and offer
  // the close vote. Staging has no model, so the bot's note is stored.
  stagingSeed('seedStagingBotWrongProject', async (pool, config) => { await seedStagingBotWrongProject(pool); }),
  // #6399's shots: a request handed back over a plan the bot could not read,
  // which a later release made readable, so its card offers a read again.
  stagingSeed('seedStagingBotOutdatedReason', async (pool, config) => { await seedStagingBotOutdatedReason(pool); }),
  // #6271's shots: a private thread with the bot, already marked done this
  // week, so Live this week has a closed thread to show. Staging has no
  // model, so the bot's reply is stored rather than asked for.
  stagingSeed('seedStagingClosedPrivateThread', async (pool, config) => { await seedStagingClosedPrivateThread(pool); }),
  // 24 Nov 2026's shots: an open private thread with only two messages, so
  // the bot tab's column shows where its reply box stands under a short
  // thread. Staging has no model, so the bot's reply is stored.
  stagingSeed('seedStagingShortPrivateThread', async (pool, config) => { await seedStagingShortPrivateThread(pool); }),
  // #6566's shots: the bot's reply after it filed a problem report, and its
  // answer when asked for the link. Staging has no model, so both replies
  // are stored messages.
  stagingSeed('seedStagingBotReportReply', async (pool, config) => { await seedStagingBotReportReply(pool); }),
  // #6581's shots: a request whose build failed twice, with a reply under the
  // first failure note. The change keeps that note and posts the second note
  // below it. Staging runs no build, so the thread is seeded.
  stagingSeed('seedStagingBotFailureNotes', async (pool, config) => { await seedStagingBotFailureNotes(pool); }),
  // #6426's shots: Main Chat shows "Welcome back" after a day away, so the
  // capture member's chat with the bot has a visit old enough to show it.
  stagingSeed('seedStagingMainChatLastVisit', async (pool, config) => { await seedStagingMainChatLastVisit(pool); }),
  // #6441's shots: three requests gone live within an hour, so the bell's
  // Unread shows them folded into one row that lists each.
  stagingSeed('seedStagingFoldedLiveNotifications', async (pool, config) => { await seedStagingFoldedLiveNotifications(pool); }),
  // #6494's shots: the bell's two storage notices, one at half full and one
  // nearly full, each saying how much is used and what the limit is. Staging
  // runs no sweep against a growing database, so they are seeded.
  stagingSeed('seedStagingStorageNotices', async (pool, config) => { await seedStagingStorageNotices(pool); }),
  // 20 Nov 2026 (live-draft review): a thread with a live draft up for a vote, for G and J's shots.
  stagingSeed('seedStagingLiveDraftThread', async (pool, config) => { await seedStagingLiveDraftThread(pool); }),
  // #6901's shots: while the server is full, Admin → Limits says how many
  // people were turned away, and the bell has a refusal notice. A fresh
  // staging copy has no run of refusals at all, and staging notifies nobody,
  // so both are seeded with obviously fake people.
  stagingSeed('seedStagingLimitRefusals', async (pool, config) => { await seedStagingLimitRefusals(pool); }),
  // #6261's shots: a design thread with a version in the capture member's
  // chat, for the comment picture's design frames.
  stagingSeed('seedStagingDesignThread', async (pool, config) => { await seedStagingDesignThread(pool); }),
  // #6354's shots: a design that started from a copy of the Homeroom bot
  // page, an obviously fake one, with the bot's change as version 2.
  stagingSeed('seedStagingCapturedPageThread', async (pool, config) => { await seedStagingCapturedPageThread(pool); }),
  // K's shots (20 Nov 2026): one thread holding two artifacts, each with its
  // own versions, so the artifacts column has a picker to show.
  stagingSeed('seedStagingArtifactsThread', async (pool, config) => { await seedStagingArtifactsThread(pool); }),
  stagingSeed('seedStagingBotPlanWaiting', async (pool, config) => { await seedStagingBotPlanWaiting(pool); }),
  // #6860's shots: a plan whose build is over says what became of it, which
  // a fresh staging copy has no run to show: one built into a change up for
  // a vote, and one whose build stopped. Obviously fake; staging only.
  stagingSeed('seedStagingBotPlanSettled', async (pool, config) => { await seedStagingBotPlanSettled(pool); }),
  // #6264: a request whose bot kept its word, for the before & after shots
  // of "tell me when it's done" (the promise, then the line it posted).
  stagingSeed('seedStagingBotFollowUp', async (pool, config) => { await seedStagingBotFollowUp(pool); }),
  // #6211's shots: a request the bot read as part of another one, so its
  // discussion has the overlap note and its three choices. Nothing here runs
  // a model, so the note is stored as the bot would have said it.
  stagingSeed('seedStagingBotOverlap', async (pool, config) => { await seedStagingBotOverlap(pool); }),
  stagingSeed('seedStagingBotOverlapBuilt', async (pool, config) => { await seedStagingBotOverlapBuilt(pool); }),
  // #6255's shots: the member asks the bot, in Main Chat, to say when a
  // request it is still building is made, and it agrees. Nothing here runs
  // a model, so a fresh staging copy has no such exchange to show.
  stagingSeed('seedStagingBotTellMeWhen', async (pool, config) => { await seedStagingBotTellMeWhen(pool); }),
  // #6228's shots: a reply on the handed-back request #9103 (above), for the
  // thread's status line, its track card and the Homeroom bot page's row.
  stagingSeed('seedStagingBotReplyWaiting', async (pool, config) => { await seedStagingBotReplyWaiting(pool); }),
  // #6263's shots: a bot-built change on a request page whose description is
  // marked out of date, so the note under it has a state to show.
  stagingSeed('seedStagingBotStaleDescription', async (pool, config) => { await seedStagingBotStaleDescription(pool); }),
  stagingSeed('seedStagingClosedGoingLive', async (pool, config) => { await seedStagingClosedGoingLive(pool); }),
  // #6284's shots: a bot change whose checks failed after the bot stopped at
  // its own limit of three fixes, so the Testing card and the Homeroom bot
  // page have the stopped state to show (and Let it try again).
  stagingSeed('seedStagingBotFixesStopped', async (pool, config) => { await seedStagingBotFixesStopped(pool); }),
  // #6388's shots: a bot change whose one failing check reports the preview
  // answering 503, so the Testing card says the preview looks at fault (and
  // never "Its author needs to fix this").
  stagingSeed('seedStagingBotFixesPlatform', async (pool, config) => { await seedStagingBotFixesPlatform(pool); }),
  // #6389's shots: the capture member's OWN change, made in Claude Code, its
  // vote met but its tests failing and conflicting with main. A fresh
  // staging copy has no such change (it comes from a coding agent outside
  // Homeroom), so Needs you has the row that says what it waits on, its page
  // the Votes card and the bot's plain reply.
  stagingSeed('seedStagingOwnChangeWaitingOnFix', async (pool, config) => { await seedStagingOwnChangeWaitingOnFix(pool); }),
  // The capture member's own change with its tests passed and its before &
  // after screenshots still being taken, on that same demo project, so the
  // Homeroom bot tab has the row that says so.
  stagingSeed('seedStagingOwnChangeTakingScreenshots', async (pool, config) => { await seedStagingOwnChangeTakingScreenshots(pool); }),
  // #6651's shots: the capture member's own change still waiting on a vote,
  // which the badge counts and Needs you must list.
  stagingSeed('seedStagingOwnChangeWaitingOnVote', async (pool, config) => { await seedStagingOwnChangeWaitingOnVote(pool); }),
  // #6599's shots: the capture member's own built draft, ready to put up for a vote.
  stagingSeed('seedStagingReadyDraftChange', async (pool, config) => { await seedStagingReadyDraftChange(pool); }),
  // #6225's shots: a change of the capture member's up for a vote that
  // closes three requests, one of them filed by someone else, so the Votes
  // card's "Closes N requests" list (and one unconfirmed request) has a state
  // to show on a fresh staging copy.
  stagingSeed('seedStagingClosesListFixture', async (pool, config) => { await seedStagingClosesListFixture(pool); }),
  // #6421's shots: one thread holding several requests, and a consent question.
  stagingSeed('seedStagingMergedThreads', async (pool, config) => { await seedStagingMergedThreads(pool); }),
  // #6282's shots: an update queued on that same change, so the AI tab has
  // "Update queued" to show instead of a Vote, and its Votes card the note.
  stagingSeed('seedStagingBotUpdateComing', async (pool, config) => { await seedStagingBotUpdateComing(pool); }),
  stagingSeed('seedStagingNewerPlan', async (pool, config) => { await seedStagingNewerPlan(pool); }),
  // The Homeroom bot's first-version configurations (services/bot-configs.js):
  // the three it starts from, each written once; then, once, an untouched
  // seeded current version moved on to its next (two review rounds in 20
  // minutes, where the first deploy seeded three in 25).
  stagingSeed('seedConfigs', async (pool, config) => { await require('../services/bot-configs').seedConfigs(pool); }),
  stagingSeed('upgradeSeedConfigs', async (pool, config) => { await require('../services/bot-configs').upgradeSeedConfigs(pool); }),
  // Once: the later changes' current version names its triage and
  // follow-ups, which its recipe decides from now on (what they ran on).
  stagingSeed('fillLaterStages', async (pool, config) => { await require('../services/bot-configs').fillLaterStages(pool, config); }, { phaseEnd: 'coreSeedMs' }),
  // In the background: a slow or unreachable production never holds up the
  // preview's boot (it logs either way).
  // It cannot reject.
  stagingSeed('seedStagingTranslations', async (pool) => { await seedStagingTranslations(pool); }, { background: true }),
  stagingSeed('seedStagingNotifications', async (pool, config) => { await seedStagingNotifications(pool, config); }),
  // #1130: must run AFTER seedStagingNotifications — its delivery rows hang
  // off a notification id that seeder owns.
  stagingSeed('seedStagingPushDeliveries', async (pool, config) => { await seedStagingPushDeliveries(pool, config); }),
  stagingSeed('seedStagingAdminConsoleData', async (pool, config) => { await seedStagingAdminConsoleData(pool); }),
  stagingSeed('seedStagingHelperCalls', async (pool, config) => { await seedStagingHelperCalls(pool); }),
  stagingSeed('seedStagingEnvProposal', async (pool, config) => { await seedStagingEnvProposal(pool, config); }),
  stagingSeed('seedStagingMergedPrs', async (pool, config) => { await seedStagingMergedPrs(pool, config); }),
  // Must run AFTER seedStagingMergedPrs — its snapshot dates are chosen
  // so the merged fixtures straddle the newest one (reporting-period).
  stagingSeed('seedStagingReportSnapshots', async (pool, config) => { await seedStagingReportSnapshots(pool, config); }),
  // Must run AFTER seedStagingMergedPrs — its tags hang off those fixtures.
  stagingSeed('seedStagingSmallChangeTags', async (pool, config) => { await seedStagingSmallChangeTags(pool, config); }),
  stagingSeed('seedStagingMyOpenPr', async (pool, config) => { await seedStagingMyOpenPr(pool, config); }),
  // #5803: a change an admin voted No on, nobody voting Yes, so the card's
  // week-long "Set aside in …" pill is reviewable on a fresh staging copy.
  stagingSeed('seedStagingAdminNoPr', async (pool, config) => { await seedStagingAdminNoPr(pool, config); }),
  stagingSeed('seedStagingApproverNoPr', async (pool, config) => { await seedStagingApproverNoPr(pool, config); }),
  stagingSeed('seedStagingImportedPrProposal', async (pool, config) => { await seedStagingImportedPrProposal(pool, config); }),
  stagingSeed('seedStagingChecksAdvisoryCard', async (pool, config) => { await seedStagingChecksAdvisoryCard(pool, config); }),
  stagingSeed('seedStagingExternalAgentProposal', async (pool, config) => { await seedStagingExternalAgentProposal(pool, config); }),
  stagingSeed('seedStagingRestartEligibleMerge', async (pool, config) => { await seedStagingRestartEligibleMerge(pool, config); }),
  // #6563's shots: an approved, tested change whose merge GitHub is holding
  // while its own required checks finish, so the change page has the Merging
  // card to show. A fresh copy never meets it: GitHub has to refuse a merge.
  stagingSeed('seedStagingGithubChecksHold', async (pool, config) => { await seedStagingGithubChecksHold(pool); }),
  // The admin limits area's shots: the bot's credit under its warning line,
  // so a full admin's Notifications sheet has a row to show.
  stagingSeed('seedStagingPlatformLimit', async (pool, config) => { await seedStagingPlatformLimit(pool); }),
  stagingSeed('seedStagingOtherUserProposal', async (pool, config) => { await seedStagingOtherUserProposal(pool, config); }),
  stagingSeed('seedStagingTopicScrollThreads', async (pool, config) => { await seedStagingTopicScrollThreads(pool, config); }),
  stagingSeed('seedStagingGroupedFollowOns', async (pool, config) => { await seedStagingGroupedFollowOns(pool, config); }),
  stagingSeed('seedStagingArchiveProposalFixtures', async (pool, config) => { await seedStagingArchiveProposalFixtures(pool, config); }),
  stagingSeed('seedStagingActiveSessions', async (pool, config) => { await seedStagingActiveSessions(pool, config); }),
  stagingSeed('seedStagingSharedSession', async (pool, config) => { await seedStagingSharedSession(pool, config); }),
  // #5007: independent of the fixtures above — its two sessions are keyed
  // on their own branch_name.
  stagingSeed('seedStagingChangeBuiltForRequest', async (pool, config) => { await seedStagingChangeBuiltForRequest(pool, config); }),
  // #6224: one change that closes several requests, for the line that says so.
  stagingSeed('seedStagingChangeAlsoCloses', async (pool, config) => { await seedStagingChangeAlsoCloses(pool, config); }),
  // #945: must run AFTER seedStagingSharedSession — the proposal-thread
  // half hangs off that fixture's session id.
  stagingSeed('seedStagingDiscussionContext', async (pool, config) => { await seedStagingDiscussionContext(pool, config); }),
  // #5351: independent of the fixtures above — its offer is keyed on its own row.
  stagingSeed('seedStagingBotCloseOffer', async (pool, config) => { await seedStagingBotCloseOffer(pool, config); }),
  stagingSeed('seedStagingDemoAppCard', async (pool, config) => { await seedStagingDemoAppCard(pool); }),
  stagingSeed('seedStagingLandingDirectory', async (pool, config) => { await seedStagingLandingDirectory(pool); }),
  // After both: it tags their demo apps with a type.
  stagingSeed('seedStagingAppCategories', async (pool, config) => { await seedStagingAppCategories(pool); }),
  // #6585: the kinds the directory works out for three fake public projects,
  // so Home's kind chips have Money, Health & fitness and Food & drink to
  // show on a fresh staging copy (which has no model key and no rows).
  stagingSeed('seedStagingInferredCategories', async (pool, config) => { await seedStagingInferredCategories(pool); }),
  stagingSeed('seedStagingFailedApp', async (pool, config) => { await seedStagingFailedApp(pool, config); }),
  stagingSeed('seedStagingForkLineage', async (pool, config) => { await seedStagingForkLineage(pool, config); }),
  // After the fork fixtures: it switches one of them into demo mode.
  stagingSeed('seedStagingDemoMode', async (pool, config) => { await seedStagingDemoMode(pool); }),
  stagingSeed('seedStagingMembersPanel', async (pool, config) => { await seedStagingMembersPanel(pool); }),
  stagingSeed('seedStagingUserDirectory', async (pool, config) => { await seedStagingUserDirectory(pool); }),
  stagingSeed('seedStagingApproverPanel', async (pool, config) => { await seedStagingApproverPanel(pool); }),
  stagingSeed('seedStagingAppAdminsPanel', async (pool, config) => { await seedStagingAppAdminsPanel(pool); }),
  stagingSeed('seedStagingReadonlyDevTab', async (pool, config) => { await seedStagingReadonlyDevTab(pool); }),
  stagingSeed('seedStagingQuietDiscussion', async (pool, config) => { await seedStagingQuietDiscussion(pool); }),
  // #5458: must run AFTER seedStagingQuietDiscussion — it clears the rows
  // that seed's first attempt hung in the quiet app, and owns the
  // vote-card app instead. Needs the capture member (seedCaptureAdminUser).
  stagingSeed('seedStagingVoteCardChat', async (pool, config) => { await seedStagingVoteCardChat(pool); }),
  // #5877: the bot's "Ready to try" row about a project, for the bell's
  // leading tile. Needs the capture member (seedCaptureAdminUser).
  stagingSeed('seedStagingBotProjectNotification', async (pool, config) => { await seedStagingBotProjectNotification(pool); }),
  // #6371: the one weekly digest row in the bell, which opens This week.
  // Needs the capture member (seedCaptureUser).
  stagingSeed('seedStagingWeeklyDigestRow', async (pool, config) => { await seedStagingWeeklyDigestRow(pool); }),
  // #6133's shots: the quiet "close to this week's building time" line in a
  // request's thread. Needs the capture member (seedCaptureUser).
  stagingSeed('seedStagingBotAllowanceWarning', async (pool, config) => { await seedStagingBotAllowanceWarning(pool); }),
  stagingSeed('seedStagingYourApps', async (pool, config) => { await seedStagingYourApps(pool, config); }),
  stagingSeed('seedCatalog', async (pool, config) => { await require('../services/staging-apps').seedCatalog(pool, config); }),
  // #6811's shots: a group the project's app keeps, listed on the Who can
  // see & change it sheet with its size and when it was sent. After the
  // catalog, whose fake people fill it. Obviously fake, staging only, and
  // only if the project is there.
  stagingSeed('seedStagingAppGroups', async (pool, config) => { await seedStagingAppGroups(pool); }),
  // A platform preview that can make projects (services/preview-projects-client.js):
  // one ready to open for each starter this proposal changed. Nothing
  // anywhere else; never throws.
  stagingSeed('seedChangedStarters', async (pool, config) => { await require('../services/preview-projects-client').seedChangedStarters(pool, config); }, { ownCopyOnly: true }),
  stagingSeed('seedStagingBrowseCardBranches', async (pool, config) => { await seedStagingBrowseCardBranches(pool, config); }),
  // #1383: must run AFTER seedStagingBrowseCardBranches (it ranks that
  // fixture's four apps) and AFTER seedStagingMergedPrs, which owns the
  // self-app's merged history.
  stagingSeed('seedStagingAppSortSignals', async (pool, config) => { await seedStagingAppSortSignals(pool); }),
  // Must run AFTER seedStagingYourApps — it features that fixture's apps.
  stagingSeed('seedStagingFeaturedApps', async (pool, config) => { await seedStagingFeaturedApps(pool); }),
  stagingSeed('seedStagingFeaturedKinds', async (pool, config) => { await seedStagingFeaturedKinds(pool); }),
  stagingSeed('seedStagingAppQuotaUsers', async (pool, config) => { await seedStagingAppQuotaUsers(pool); }),
  // Must run AFTER seedStagingYourApps (it references those demo apps) and
  // AFTER seedStagingAppQuotaUsers (it seeds the zero-quota fixture's grid).
  stagingSeed('seedStagingHomeLayout', async (pool, config) => { await seedStagingHomeLayout(pool, config); }),
  stagingSeed('seedStagingViewOnlyAdmin', async (pool, config) => { await seedStagingViewOnlyAdmin(pool); }),
  stagingSeed('seedStagingWalletUsers', async (pool, config) => { await seedStagingWalletUsers(pool); }),
  stagingSeed('seedStagingEmailCodeAccounts', async (pool, config) => { await seedStagingEmailCodeAccounts(pool); }),
  // #4405: must run AFTER seedCaptureAdminUser and
  // seedStagingEmailCodeAccounts (the two accounts it makes app admins are
  // seeded there) and AFTER seedStagingReadonlyDevTab (its live domain hangs
  // off that app).
  stagingSeed('seedStagingCustomDomains', async (pool, config) => { await seedStagingCustomDomains(pool); }),
  // #6601: the shots' own waiting card-picture vote, whose proposer is the
  // capture member, so Edit proposal and Replace the waiting change are
  // reachable on a fresh staging copy. Obviously fake, idempotent.
  stagingSeed('seedStagingWaitingIllustration', async (pool, config) => { await seedStagingWaitingIllustration(pool); }),
  stagingSeed('seedStagingPublicApiContributors', async (pool, config) => { await seedStagingPublicApiContributors(pool); }),
  stagingSeed('seedStagingVisuals', async (pool, config) => { await seedStagingVisuals(pool); }),
  // Must run AFTER seedStagingVisuals: it owns the gallery demo app this
  // fixture's proposal belongs to.
  stagingSeed('seedStagingShotsNoticed', async (pool, config) => { await seedStagingShotsNoticed(pool); }),
  // After seedStagingDemoAppCard, whose demo app it belongs to.
  stagingSeed('seedStagingShotsScreens', async (pool, config) => { await seedStagingShotsScreens(pool); }),
  stagingSeed('seedStagingCompetingChanges', async (pool, config) => { await seedStagingCompetingChanges(pool); }),
  stagingSeed('seedStagingShotsFailed', async (pool, config) => { await seedStagingShotsFailed(pool); }),
  stagingSeed('seedStagingLeaderboardProfile', async (pool, config) => { await seedStagingLeaderboardProfile(pool); }),
  stagingSeed('seedStagingGeneralChannel', async (pool, config) => { await seedStagingGeneralChannel(pool); }),
  // After it: the fake speaker who cast the vote below is that seed's person.
  // #5482's before/after shots follow a proposal_vote row about a change
  // that has merged, and its leaving the bell's list: a fresh clone has no
  // such row for the shots' member fixture, so one is seeded, with the news
  // that the same change went live beside it (that row stays after).
  stagingSeed('seedStagingMergedVoteRow', async (pool, config) => { await seedStagingMergedVoteRow(pool, config); }),
  // #7216's shots: a request whose bot-built change carries a No vote whose
  // reason was handed to the bot, so its page has a vote line with a reason
  // to show beside a Yes that kept its own.
  stagingSeed('seedStagingVoteReasonOnRequest', async (pool, config) => { await seedStagingVoteReasonOnRequest(pool, config); }),
  // After it: a private thread about that live change, for the shots'
  // member fixture. Since a thread about a change is finished with its
  // change, History has it ("Live") and Needs you does not.
  stagingSeed('seedStagingLiveChangePrivateThread', async (pool, config) => { await seedStagingLiveChangePrivateThread(pool); }),
  // A first version's thread that starts on an older message, as the move
  // off Main Chat listed them, for the shots' member fixture: the thread the
  // bot page could list but never open.
  stagingSeed('seedStagingOlderFirstVersionThread', async (pool, config) => { await seedStagingOlderFirstVersionThread(pool); }),
  // #6803's shots: a first version being built, its plan answered with Build
  // it, so its card offers to watch the bot build it. A fresh copy has no bot
  // mid-build, so one is seeded, for the same member.
  stagingSeed('seedStagingFirstVersionBuildingThread', async (pool, config) => { await seedStagingFirstVersionBuildingThread(pool); }),
  // #6816's shots: enough recent threads for the shots' member fixture that
  // Home's card beside Pinned apps cannot list them all, so its last row has
  // a "N more" state to show. Obviously fake, idempotent.
  stagingSeed('seedStagingRecentThreads', async (pool, config) => { await seedStagingRecentThreads(pool); }),
  // #6124's before/after shots follow a change renamed before it had a pull
  // request: the correction is in proposed_pr_title and the session still
  // carries the old name. A fresh clone has no such row for the shots'
  // member fixture, so one is seeded on the self app.
  stagingSeed('seedStagingRenamedChange', async (pool, config) => { await seedStagingRenamedChange(pool, config); }),
  // After it: this thread's second speaker is that seed's fake person.
  stagingSeed('seedStagingScrollTestThread', async (pool, config) => { await seedStagingScrollTestThread(pool); }),
  // Must run AFTER seedStagingScrollTestThread — it invites the same member fixture.
  stagingSeed('seedStagingGroupInviteNote', async (pool, config) => { await seedStagingGroupInviteNote(pool); }),
  // #5393: must run AFTER seedStagingGeneralChannel — its fake speakers are that seed's people.
  stagingSeed('seedStagingGroupFacesRows', async (pool, config) => { await seedStagingGroupFacesRows(pool); }),
  // Desktop polish 11: a run of follow-up lines from a fake person. The same people.
  stagingSeed('seedStagingFollowUpBubbles', async (pool, config) => { await seedStagingFollowUpBubbles(pool); }),
  // After seedStagingRenamedChange and #general's people: one of them is sent
  // that change, so its card in a message shows the name it has everywhere.
  stagingSeed('seedStagingSharedRenamedChange', async (pool, config) => { await seedStagingSharedRenamedChange(pool, config); }),
  stagingSeed('seedStagingOwnReviewChange', async (pool, config) => { await seedStagingOwnReviewChange(pool, config); }),
  stagingSeed('seedStagingGroupChatAttachments', async (pool, config) => { await seedStagingGroupChatAttachments(pool, config); }),
  stagingSeed('seedStagingAppFiles', async (pool, config) => { await seedStagingAppFiles(pool); }),
  stagingSeed('seedStagingComplicatedPlanSpec', async (pool, config) => { await seedStagingComplicatedPlanSpec(pool, config); }),
  stagingSeed('seedStagingSpecUserShareFixtures', async (pool, config) => { await seedStagingSpecUserShareFixtures(pool, config); }),
  stagingSeed('seedStagingChatEditFixtures', async (pool, config) => { await seedStagingChatEditFixtures(pool, config); }),
  stagingSeed('seedStagingBotChatRequest', async (pool, config) => { await seedStagingBotChatRequest(pool, config); }),
  // #6763's shots: a private thread where someone asks to make a new app and
  // the bot's reply offers New project under it. Staging runs no model, so
  // the exchange is seeded.
  stagingSeed('seedStagingNewProjectOfferThread', async (pool, config) => { await seedStagingNewProjectOfferThread(pool); }),
  stagingSeed('seedStagingLlmUsage', async (pool, config) => { await seedStagingLlmUsage(pool); }),
  stagingSeed('seedStagingWeeklyCaps', async (pool, config) => { await seedStagingWeeklyCaps(pool); }),
  stagingSeed('seedStagingSpendDistribution', async (pool, config) => { await seedStagingSpendDistribution(pool); }),
  stagingSeed('seedStagingCapReached', async (pool, config) => { await seedStagingCapReached(pool, config); }),
  stagingSeed('seedStagingAppCapApps', async (pool, config) => { await seedStagingAppCapApps(pool, config); }),
  stagingSeed('seedStagingSystemTokenUsage', async (pool, config) => { await seedStagingSystemTokenUsage(pool); }),
  stagingSeed('seedStagingDashboardAdminSplit', async (pool, config) => { await seedStagingDashboardAdminSplit(pool); }),
  stagingSeed('seedStagingModerationCase', async (pool, config) => { await seedStagingModerationCase(pool); }),
  stagingSeed('seedStagingAnalyticsCharts', async (pool, config) => { await seedStagingAnalyticsCharts(pool); }),
  stagingSeed('seedStagingTopicAttributes', async (pool, config) => { await seedStagingTopicAttributes(pool, config); }),
  stagingSeed('seedStagingSubmittedFeatures', async (pool, config) => { await seedStagingSubmittedFeatures(pool, config); }),
  // #6081: a message and a request in another language, with the English the
  // translation route serves without a model key the copies do not have.
  stagingSeed('seedStagingUserContentTranslations', async (pool, config) => { await seedStagingUserContentTranslations(pool); }),
  stagingSeed('seedStagingDbExports', async (pool, config) => { await seedStagingDbExports(pool); }),
  // #3654: the Homeroom bot console's Benchmark area (services/bench/demo.js).
  // Its tables are staging:private, so a preview would otherwise show none.
  stagingSeed('seedStagingBench', async (pool, config) => { await require('../services/bench/demo').seedStagingBench(pool); }),
  // #3737: and its taste eval, with screenshots to look at.
  stagingSeed('seedStagingTaste', async (pool, config) => { await require('../services/bench/demo').seedStagingTaste(pool); }),
  // And the App bench studio's gallery, with builds side by side.
  stagingSeed('seedStagingStudio', async (pool, config) => { await require('../services/bench/demo').seedStagingStudio(pool); }),
  // The Homeroom bot's configurations table, with first versions to measure.
  stagingSeed('seedStagingBotConfigs', async (pool, config) => { await require('../services/bot-configs').seedStagingBotConfigs(pool); }),
  // A failed bot run whose reply had no verdict block, kept on the run.
  stagingSeed('seedStagingUnreadableReply', async (pool, config) => { await require('../services/homeroom-bot').seedStagingUnreadableReply(pool); }),
  // After the proposal seeds above: the platform-env fixture stamps a
  // failing verdict onto an existing staging proposal.
  stagingSeed('seedStagingPlatformEnv', async (pool, config) => { await seedStagingPlatformEnv(pool, config); }),
  stagingSeed('seedStagingTopochain', async (pool, config) => { await seedStagingTopochain(pool, config); }),
  // After it: it seeds the invite challenge (900504) whose "Your invites"
  // list this fixture fills, and the viewer identities the link belongs to.
  stagingSeed('seedStagingInviteChallengeStatuses', async (pool, config) => { await seedStagingInviteChallengeStatuses(pool); }),
  // After it: the First challenges hang off its season-type event.
  stagingSeed('seedStagingFirstChallenges', async (pool, config) => { await seedStagingFirstChallenges(pool); }),
  stagingSeed('seedStagingCountedCredit', async (pool, config) => { await seedStagingCountedCredit(pool, config); }),
  // #7152: the feedback challenge whose itemized report list the shots show.
  stagingSeed('seedStagingChallengeItems', async (pool, config) => { await seedStagingChallengeItems(pool); }),
  // Must run AFTER seedStagingTopochain (it decorates the same three viewer
  // identities) and AFTER seedStagingLeaderboardProfile (it decorates that
  // seed's 900001 / 900002 fixture accounts).
  stagingSeed('seedStagingProfileCustomization', async (pool, config) => { await seedStagingProfileCustomization(pool, config); }),
  // #7133's shots: the profile's "Projects you've helped build" shows one card
  // per project where the capture member has a live change. A fresh staging
  // copy has none, so the section would only have its empty state.
  stagingSeed('seedStagingProfileProjects', async (pool, config) => { await seedStagingProfileProjects(pool); }),
  // #7189's shots: a project the member made, whose only other "contributor"
  // was Homeroom bot's merged build for their own request, so App settings
  // now offers to delete it.
  stagingSeed('seedStagingBotBuiltDeleteApp', async (pool, config) => { await seedStagingBotBuiltDeleteApp(pool); }),
  stagingSeed('seedStagingPhoneFailures', async (pool, config) => { await seedStagingPhoneFailures(pool); }),
  stagingSeed('seedStagingPlatformMail', async (pool, config) => { await seedStagingPlatformMail(pool); }),
  // #7147's shots: the desktop sidebar keeps ten pinned communities now, not
  // four. A fresh staging copy has none for the shots' member fixture, so
  // eleven obviously fake private ones are seeded, ten pinned in the order
  // the sidebar shows them and the eleventh joined but unpinned, so pinning
  // it is refused with the new number. Obviously fake, idempotent.
  stagingSeed('seedStagingPinnedCommunities', async (pool, config) => { await seedStagingPinnedCommunities(pool); }),
  // #7170: one fake request in an emoji project, so a thread header's tile can
  // be shot with an emoji in it. Obviously fake, idempotent.
  stagingSeed('seedStagingEmojiThreadRequest', async (pool, config) => { await seedStagingEmojiThreadRequest(pool); }),
  // The hub's Discussion (26 Nov 2026): two fake private projects with
  // posts to draw, one of them folded into "Earlier discussion".
  stagingSeed('seedStagingDiscussion', async (pool, config) => { await seedStagingDiscussion(pool); }),
  // #7230's shots: the hub's faces, Top contributors and Discussion authors
  // show profile pictures. The Book Club has people active this week but no
  // contributions, so its Top contributors card would be missing; two
  // obviously fake merged changes give it two people to list.
  stagingSeed('seedStagingHubContributors', async (pool, config) => { await seedStagingHubContributors(pool); }),
  // The signed-out project page's shots (26 Nov 2026): one obviously fake
  // public project busy enough to show who is around, changes approved by
  // several people and by its creator alone, and Top contributors.
  stagingSeed('seedStagingGuestProjectPage', async (pool, config) => { await seedStagingGuestProjectPage(pool); }),
  // Its Discussion, for a visitor to read (posts, replies, a picture).
  stagingSeed('seedStagingGuestDiscussion', async (pool, config) => { await seedStagingGuestDiscussion(pool); }),
  // Hearts and plays on that project, for its card, its hub and its
  // signed-out page (services/app-popularity.js).
  stagingSeed('seedStagingHeartsAndPlays', async (pool, config) => seedStagingHeartsAndPlays(pool)),
  // #4803: feedback is private in clones and GitHub writes are unavailable.
  stagingSeed('seedStagingFeedback', async (pool, config) => { await require('../services/staging-feedback').seedStagingFeedback(pool, config); }),
]);

// 11 Nov 2026 (docs/plans/bot-one-model.md): Needs you and the vote digest
// ask for a vote only off a change's own work state (work_states.vote_open),
// and the work states are staging:private, so a staging copy starts with
// none while its changes are there. Every change up for a vote or merging
// with no row yet is marked (work_state_dirty), and the work-state drain
// makes its row within seconds; production's were marked once by migration
// work-state-backfill-and-indexes, and this finds any since. Idempotent: a
// change marked already, or with its row, is skipped. Never fails a boot.
async function markChangesWithoutWorkState(pool) {
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO work_state_dirty (session_id)
       SELECT cs.id FROM chat_sessions cs
        WHERE cs.status IN ('promoted', 'merging') AND cs.is_headless IS NOT TRUE
          AND NOT EXISTS (SELECT 1 FROM work_states ws WHERE ws.item_kind = 'change' AND ws.session_id = cs.id)
       ON CONFLICT (session_id) WHERE session_id IS NOT NULL DO NOTHING`,
    );
    if (rowCount) log.info('db', 'Marked changes with no work state for the drain', { count: rowCount });
  } catch (err) {
    log.warn('db', 'Marking changes with no work state failed', { message: err.message });
  }
}

// Proposal authorship predates proposal-level assignee votes, so existing
// open work may have an owner but no assignment. Seed only genuinely missing
// proposal fields: any explicit proposal-level vote wins, even when it names
// somebody other than the issuer. Headless work is sponsored rather than
// issued by its user_id, and maintenance proposals belong to the platform,
// so neither is assigned by this human-work backfill.
// #6811: the Who can see & change it sheet lists the groups an app keeps,
// so the shots need one the app has sent. Gym Tracker sends "15-minute
// finishers"; a fresh staging copy has no such list, so this writes it with
// obviously fake people. Idempotent, staging only, and a missing project is
// simply nothing to seed.
async function seedStagingAppGroups(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const app = (await pool.query(
      "SELECT id FROM apps WHERE lower(name) = 'gym tracker' AND NOT self_hosted ORDER BY id LIMIT 1")).rows[0];
    if (!app) return seedSkipped('no project Gym Tracker');
    await pool.query(
      `INSERT INTO app_groups (app_id, key, name, reported_at)
       SELECT $1, '15-minute finishers', '15-minute finishers', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM app_groups WHERE app_id = $1 AND key = '15-minute finishers')`, [app.id]);
    const group = (await pool.query(
      "SELECT id FROM app_groups WHERE app_id = $1 AND key = '15-minute finishers'", [app.id])).rows[0];
    if (!group) return;
    await pool.query(
      `INSERT INTO app_group_members (group_id, user_id)
       SELECT $1, id FROM users
        WHERE username IN ('usernode-capture', 'usernode-capture-admin', 'staging-demo-catalog-1',
                           'staging-demo-catalog-2', 'staging-demo-catalog-3')
       ON CONFLICT DO NOTHING`, [group.id]);
  } catch (err) {
    log.warn('db', 'Staging app groups seed failed', { message: err.message });
  }
}

// A solid-colour PNG, written by hand (IHDR, one IDAT of flat scanlines,
// IEND) so a staging fixture's logo needs no file and no dependency. The
// bytes are what /app-icons/:id serves, so they have to be a real PNG.
function solidPng([r, g, b], size = 64) {
  const zlib = require('zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour RGB
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// #7133: the profile's project cards, for their before & after shots. Three
// obviously fake projects, each with one live merged change by the capture
// member, so the card row has more than the demo's one project to show. The
// merged insert trigger fills live_at. Each carries its own logo (#7153), so
// the cards show the pictures the change puts there. Staging only and
// idempotent.
async function seedStagingProfileProjects(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const member = (await pool.query(
      "SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1")).rows[0];
    if (!member) return seedSkipped('no user usernode-capture');
    const projects = [
      { id: 900809, slug: 'staging-demo-profile-garden', name: 'Staging demo garden',
        title: 'Staging demo: a reminder when the soil is dry', hoursAgo: 1,
        iconId: 'facade00facade00facade00facade11', rgb: [122, 92, 214] },
      { id: 900810, slug: 'staging-demo-profile-tides', name: 'Staging demo tides',
        title: 'Staging demo: the tide table in your own time', hoursAgo: 2,
        iconId: 'facade00facade00facade00facade12', rgb: [233, 163, 91] },
      { id: 900811, slug: 'staging-demo-profile-notes', name: 'Staging demo notes',
        title: 'Staging demo: pin a note to the top', hoursAgo: 3,
        iconId: 'facade00facade00facade00facade13', rgb: [242, 167, 160] },
    ];
    for (const project of projects) {
      await pool.query(
        `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
         VALUES ($1, $2, $3, 'running', 'private', 'private', $4)
         ON CONFLICT (id) DO NOTHING`,
        [project.id, project.name, project.slug, member.id]);
      // app_icons.app_id is UNIQUE, so an icon an earlier boot wrote under a
      // different id would block this insert and take the whole seed down.
      await pool.query(
        'DELETE FROM app_icons WHERE app_id = $1 AND id <> $2', [project.id, project.iconId]);
      const png = solidPng(project.rgb);
      await pool.query(
        `INSERT INTO app_icons (id, app_id, content_type, data, sha256)
         VALUES ($1, $2, 'image/png', $3, $4) ON CONFLICT (id) DO NOTHING`,
        [project.iconId, project.id, png, crypto.createHash('sha256').update(png).digest('hex')]);
      await pool.query(
        'UPDATE apps SET icon_image_id = $2 WHERE id = $1', [project.id, project.iconId]);
      await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, session_title, pr_title, status, merged_at)
         SELECT $1, $2, $3::varchar(255), $4::text, $4::text, 'merged',
                NOW() - make_interval(hours => $5::int)
          WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE app_id = $1 AND branch_name = $3::varchar(255))`,
        [project.id, member.id, `staging-fixture/profile-${project.slug}`, project.title, project.hoursAgo]);
    }
  } catch (err) {
    log.warn('db', 'Staging profile projects seed failed', { message: err.message });
  }
}

// #7189's shots: a project the shots' member fixture made whose only other
// "contributor" was Homeroom bot, because the bot built it from a request
// the member filed. A contributor is a person, so the bot's merged build
// counts for the member and the member may delete the project: App settings
// shows the Danger zone instead of "This app has 1 other contributor". A
// fresh staging copy has no such project (it truncates chat_sessions and
// nothing there runs a build), so one is seeded. Obviously fake, idempotent
// by id, slug and branch, and strictly a no-op outside staging. Nothing here
// is a signal the code reads to decide anything.
async function seedStagingBotBuiltDeleteApp(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const APP_ID = 900812;
  const SLUG = 'staging-demo-bot-built';
  try {
    const member = (await pool.query(
      "SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1")).rows[0];
    if (!member) return seedSkipped('no user usernode-capture');
    // The bot's account, in the posture botAccount() reads, is the merged
    // session's author. Other staging seeds write it too, but only once
    // their own fixtures exist (a copy with no self-hosted project never
    // reaches that line), so this seed writes it rather than depend on the
    // order, or on another seed having run at all.
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const bot = (await pool.query(
      "SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1")).rows[0];
    if (!bot) return seedSkipped('no user homeroom_bot');
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by, icon_emoji)
       VALUES ($1, 'Staging demo bot-built app', $2, 'running', 'private', 'private', $3, '🏁')
       ON CONFLICT (id) DO NOTHING`,
      [APP_ID, SLUG, member.id]);
    // The request the bot built from, asked for by the member.
    const number = 900099;
    const title = 'Staging demo: a scoreboard for the race';
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1::int, $2::int, $3::text, 'Staging demo: obviously fake. Homeroom bot built this from the request.', $4::int,
              NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1::int AND number = $2::int)`,
      [APP_ID, number, title, member.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, created_at)
       VALUES ($1::int, $2::int, $3::int, $4::text, NOW() - INTERVAL '3 days')
       ON CONFLICT (app_id, issue_number) DO NOTHING`,
      [APP_ID, number, member.id, title]);
    // The bot's merged build: a session authored by the synthetic account,
    // from that request, so it is the member's change.
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, session_title, pr_title, status, merged_at,
                                  created_from_issue_number, created_at, last_activity_at)
       SELECT $1::int, $2::int, 'staging-fixture/bot-built-delete', $3::text, $3::text, 'merged',
              NOW() - INTERVAL '2 days', $4::int, NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE app_id = $1::int AND branch_name = 'staging-fixture/bot-built-delete')`,
      [APP_ID, bot.id, title, number]);
    // Two more of the member's own, so the row reads "Creator · 3 live".
    for (const [branch, name] of [
      ['staging-fixture/bot-built-flag', 'Staging demo: a flag for the finish line'],
      ['staging-fixture/bot-built-laps', 'Staging demo: lap times on the board'],
    ]) {
      await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, session_title, pr_title, status, merged_at,
                                    created_at, last_activity_at)
         SELECT $1::int, $2::int, $3::text, $4::text, $4::text, 'merged',
                NOW() - INTERVAL '1 day', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day'
          WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE app_id = $1::int AND branch_name = $3::text)`,
        [APP_ID, member.id, branch, name]);
    }
    // On the member's Home, so the project is one tile away.
    await pool.query(
      `INSERT INTO app_favorites (app_id, user_id, sort_order)
       VALUES ($1, $2, 3) ON CONFLICT (app_id, user_id) DO UPDATE
         SET hidden = FALSE, sort_order = EXCLUDED.sort_order`,
      [APP_ID, member.id]);
  } catch (err) {
    log.warn('db', 'Staging bot-built delete seeding failed', { message: err.message });
  }
}

// #6544: a closed request with a merged change still awaiting release.
// Obviously fake data for the shots member; no production writes.
async function seedStagingClosedGoingLive(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const member = (await tx.query("SELECT id FROM users WHERE username = 'usernode-capture'")).rows[0];
    if (!member) { await tx.query('ROLLBACK'); return seedSkipped('no user usernode-capture'); }
    await tx.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
       SELECT 'Staging demo release', 'staging-demo-closed-going-live', 'running', $1, 'public', 'members'
        WHERE NOT EXISTS (SELECT 1 FROM apps WHERE slug = 'staging-demo-closed-going-live')`, [member.id]);
    const app = (await tx.query("SELECT id FROM apps WHERE slug = 'staging-demo-closed-going-live'")).rows[0];
    await tx.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, state)
       SELECT $1, 96544, 'Staging demo: a closed request going live', 'Obviously fake release example.', $2, 'closed'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = 96544)`, [app.id, member.id]);
    // The merge machine alone may leave a merged change not yet live.
    await tx.query("SELECT set_config('app.wf_writer', 'transition', true)");
    await tx.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, session_title, pr_number,
                                  linked_issues, status, shared_at, promoted_at, merged_at)
       SELECT $1, $2, 'staging-fixture/closed-going-live', 'Staging demo: a closed request going live', 96545,
              '{96544}', 'merged', NOW(), NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE app_id = $1 AND branch_name = 'staging-fixture/closed-going-live')`,
      [app.id, member.id]);
    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK');
    log.warn('db', 'Staging closed request going-live seed failed', { message: err.message });
  } finally { tx.release(); }
}

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

// 31 Oct 2026: a request the bot drafted and File it filed carries its
// number on the offer's message from now on (homeroom-bot-mayor.js
// settleOffer), and the card is drawn as that request. An offer filed before
// kept "not filed yet" for good: its number was only on the offer's row.
// Copied once from there; a no-op after its first run. Best-effort.
async function backfillFiledDraftCards(pool) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE conversation_messages m
          SET metadata = jsonb_set(m.metadata, '{homeroomBot}',
                (m.metadata->'homeroomBot') || jsonb_build_object('issueNumber', a.issue_number, 'issueTitle', a.title))
         FROM bot_cards a
        WHERE a.message_id = m.id AND a.kind = 'file_request' AND a.status = 'done' AND a.issue_number IS NOT NULL
          AND jsonb_typeof(m.metadata->'homeroomBot') = 'object'
          AND m.metadata->'homeroomBot'->>'kind' = 'confirm'
          AND (m.metadata->'homeroomBot'->'issueNumber') IS NULL`
    );
    if (rowCount) log.info('db', 'Filed drafts\' cards now name their requests', { messages: rowCount });
  } catch (err) {
    log.warn('db', 'Could not put filed requests on their drafts\' cards', { message: err.message });
  }
}

// #5379: manifest proposals the platform wrote before createManifestPR began
// stamping source='settings' still read as native agent sessions, so they
// showed up in the agent lists. Tag them the same way, identified by the
// branch prefix createManifestPR gives every flavour (rename, visibility,
// governance, admins, secret-declare, who-decides, topics). Three guards
// keep it to exactly those rows: source IS NULL (a backfill, so a re-run
// matches nothing — idempotent on every boot), agent_session_id IS NULL (a
// real agent change that happens to use one of these branch names keeps its
// chat), and a transcript guard (no user/assistant conversation ever backed
// a manifest PR; dev chats branch as dev/…). Best effort: a failure logs and
// boot goes on, the rows just stay listed until the next boot.
// Papote #3 (18 Oct 2026): Homeroom bot's plan rows on requests kept saying
// "Waiting for @snait to say Build it" after their plans stopped waiting:
// request #3 on Papote showed four. What became of each plan is written on
// its row from now on (homeroom-bot-live.js notePlanRows); a row from
// before is told here, once. Only a row still reading 'waiting' whose plan
// no longer waits changes, so it is a no-op after its first run. Step 4
// (11 Nov 2026): its status only; the words shown stay.
async function backfillPlanRows(pool) {
  let result;
  try {
    result = await pool.query(
      `UPDATE chat_messages m
          SET metadata = jsonb_set(m.metadata, '{specShare,botNote}', to_jsonb(s.note))
         FROM (SELECT p.thread_message_id AS id,
                      CASE WHEN r.plan->'chosen' IS NOT NULL THEN 'building'
                           WHEN r.build_error = 'skipped: the request was read again'
                             OR r.build_error LIKE 'skipped: % asked to change the plan' THEN 'replaced'
                           ELSE 'stopped' END AS note
                 FROM homeroom_bot_posts p
                 JOIN homeroom_bot_runs r ON r.id = p.run_id
                WHERE p.kind = 'plan' AND p.thread_message_id IS NOT NULL AND r.awaiting_go_at IS NULL) s
        WHERE m.id = s.id AND m.metadata->'specShare'->>'botNote' = 'waiting'`,
    );
  } catch (err) {
    log.warn('db', 'Plan-row backfill skipped (query failed)', { err: err.message });
    return 0;
  }
  if (result.rowCount) log.info('db', 'Said what became of plans still marked waiting on their requests', { count: result.rowCount });
  return result.rowCount;
}

async function backfillSettingsProposalSource(pool) {
  let result;
  try {
    result = await pool.query(
      `UPDATE chat_sessions
          SET source = 'settings'
        WHERE source IS NULL
          AND pr_number IS NOT NULL
          AND agent_session_id IS NULL
          AND (branch_name LIKE 'rename/%' OR branch_name LIKE 'visibility/%'
               OR branch_name LIKE 'governance/%' OR branch_name LIKE 'admins/%'
               OR branch_name LIKE 'secret-declare/%' OR branch_name LIKE 'who-decides/%'
               OR branch_name LIKE 'topics/%')
          AND NOT EXISTS (SELECT 1 FROM chat_session_messages m
                           WHERE m.session_id = chat_sessions.id
                             AND m.role IN ('user', 'assistant'))`
    );
  } catch (err) {
    log.warn('db', 'Settings-proposal source backfill skipped (query failed)', { err: err.message });
    return 0;
  }
  if (result.rowCount) {
    log.info('db', 'Tagged platform-written settings proposals in flight', {
      count: result.rowCount,
    });
  }
  return result.rowCount || 0;
}

// A partner, the identity check or an admin can send an activity with a
// calendar date and no time of day. Those were read as midnight UTC and served
// as an exact moment, so the activity list printed "12:00 AM" (the evening
// before, west of UTC) for something done in the afternoon. Writers now pin
// such a value to noon UTC marked `timestamp_precision: 'day'`; this marks the
// rows written before that, so the list shows the date alone.
//
// Only the three writers that could produce a bare-date row are touched, and
// only a row sitting exactly at midnight UTC with no precision already set.
// A real action at exactly midnight to the millisecond from one of those
// sources loses its hour; that is accepted (see the change's spec).
//
// `activity_at` is deliberately not moved: the renderer reads a 'day' row's
// calendar date in UTC, which is the right day, and week caps
// (`rules.weekStartMs`) do not change. Every boot, and a no-op once clean.
async function markBareDateActivities(pool) {
  let result;
  try {
    result = await pool.query(
      `UPDATE user_activities
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || '{"timestamp_precision":"day"}'::jsonb
        WHERE source IN ('api', 'zkpassport', 'admin_ui')
          AND activity_at = (date_trunc('day', activity_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
          AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'timestamp_precision')`
    );
  } catch (err) {
    log.warn('db', 'Day-only activity backfill skipped (query failed)', { err: err.message });
    return 0;
  }
  if (result.rowCount) {
    log.info('db', 'Marked activities saved at midnight as day-only', { count: result.rowCount });
  }
  return result.rowCount || 0;
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

// 15 Nov 2026: the unattended run of a request (a headless session) is
// retired with the agent chats, and nothing resumes one any more. A run that
// was still generating when this release arrived is failed here and its turn
// lease cleared, so its request does not read as being worked on for ever.
// Idempotent; no-ops when nothing is stuck.
async function failOrphanedHeadlessRuns(pool) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE chat_sessions SET headless_status = 'failed', active_turn = NULL
        WHERE is_headless = TRUE AND headless_status = 'generating'`
    );
    if (rowCount > 0) {
      log.info('db', 'Marked unattended runs that nothing resumes as failed', { count: rowCount });
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

// ── Channels are what people said ─────────────────────────────────────
//
// Homeroom used to write its activity into a project's channel — a proposal
// put up for a vote, a merge, a check verdict, a setting changed, main going
// red — and, for its own project, into #general. It writes none now
// (services/ws.js sendSystemMessage), and this clears the lines it wrote
// before, so every channel holds only what people said:
//
//   - an app's channel (`chat_messages`, main stream) loses its platform
//     rows: no sender, `system` / `vote` / `conflict`. Nobody can reply to
//     one (app-chat.findThreadRoot takes a person's message only), and a
//     proposal's, request's or decision's own thread keeps its copy where
//     one was posted: only the main stream is touched.
//   - a channel conversation (#general) loses Homeroom's rows: no sender,
//     `system`. One that somebody answered in a thread is deleted the way a
//     person's message with replies is — it keeps its place and loses its
//     words — so the replies keep their root; the rest are removed.
//
// A reader whose #general cursor sat on a removed line is moved back to the
// last line that stays (conversation_members' cursor would otherwise be set
// NULL by its foreign key, and a NULL cursor reads the whole room as
// unread). Nothing between the two can count as unread: every row between
// them is one of the removed lines. An app channel's cursor is a plain id
// compared with `>`, so it needs no move.
//
// Every boot, and a no-op once clean: it also sweeps up a line an older
// instance wrote while a deploy was rolling. The app table is found through
// its (user_id, app_id) index; the channel conversations are few. Best-effort:
// a failure never aborts boot, and the channel half is one transaction.
// PHONE REVIEW #103 (23 Nov 2026): the welcome message's sign-off is a
// name, not a one-item list. The template admins saved ended "- Evan" on a
// line of its own, which the chat drew as a bullet point; the sweep now
// sends it without the dash (services/welcome-dm.js plainSignOff), and this
// takes the dash off the saved template and off the welcomes already sent
// (their idempotency key is `welcome-dm:<user id>`), the words otherwise as
// they were. Every boot, and a no-op once clean. Best-effort: a failure
// never aborts boot.
async function plainWelcomeSignOffs(pool) {
  const { plainSignOff } = require('../services/welcome-dm');
  try {
    const { rows: settings } = await pool.query(
      "SELECT value FROM platform_settings WHERE key = 'welcome_dm_message'"
    );
    for (const row of settings) {
      const next = plainSignOff(row.value);
      if (next !== row.value) {
        await pool.query(
          "UPDATE platform_settings SET value = $1 WHERE key = 'welcome_dm_message' AND value = $2",
          [next, row.value]
        );
      }
    }
    const { rows: sent } = await pool.query(
      `SELECT id, content FROM conversation_messages
        WHERE idempotency_key LIKE 'welcome-dm:%' AND deleted_at IS NULL
          AND content ~ '\\n[ \\t]*[-*+][ \\t]+\\S[^\\n]*\\s*$'`
    );
    for (const row of sent) {
      const next = plainSignOff(row.content);
      if (next !== row.content) {
        await pool.query(
          'UPDATE conversation_messages SET content = $1 WHERE id = $2 AND content = $3',
          [next, row.id, row.content]
        );
      }
    }
  } catch (err) {
    log.warn('db', 'Welcome sign-offs were not tidied', { err: err.message });
  }
}

async function clearAutomatedChannelLines(pool) {
  let client = null;
  try {
    const app = await pool.query(
      `DELETE FROM chat_messages
        WHERE user_id IS NULL AND thread_type IS NULL
          AND msg_type IN ('system', 'vote', 'conflict')`
    );
    client = await pool.connect();
    await client.query('BEGIN');
    // Homeroom's main-stream lines in a channel, and whether anybody replied.
    const { rows: lines } = await client.query(
      `SELECT m.id, m.conversation_id,
              EXISTS (SELECT 1 FROM conversation_messages r WHERE r.thread_root_id = m.id) AS answered
         FROM conversation_messages m
         JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'channel'
        WHERE m.sender_id IS NULL AND m.msg_type = 'system'
          AND m.thread_root_id IS NULL AND m.deleted_at IS NULL
        FOR UPDATE OF m`
    );
    const removed = lines.filter((l) => !l.answered).map((l) => l.id);
    const kept = lines.filter((l) => l.answered).map((l) => l.id);
    if (removed.length) {
      await client.query(
        `UPDATE conversation_members cm
            SET last_read_message_id = (
              SELECT MAX(p.id) FROM conversation_messages p
               WHERE p.conversation_id = cm.conversation_id
                 AND p.id < cm.last_read_message_id
                 AND p.id <> ALL($1::int[]))
          WHERE cm.last_read_message_id = ANY($1::int[])`,
        [removed]
      );
      await client.query('DELETE FROM conversation_messages WHERE id = ANY($1::int[])', [removed]);
    }
    if (kept.length) {
      await client.query(
        `UPDATE conversation_messages SET content = '', deleted_at = NOW() WHERE id = ANY($1::int[])`,
        [kept]
      );
    }
    await client.query('COMMIT');
    if (app.rowCount || removed.length || kept.length) {
      log.info('db', 'Cleared Homeroom activity lines from channels', {
        appChannels: app.rowCount, general: removed.length, keptForReplies: kept.length,
      });
    }
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    log.warn('db', 'Clearing activity lines from channels skipped', { err: err.message });
  } finally {
    if (client) client.release();
  }
}

// 14 Nov 2026: Main Chat, the one mixed stream of a person's chat with
// Homeroom bot, is removed; every conversation with the bot is a thread.
// What was said in Main before moves, once, under one private thread per
// person named "Earlier chat" (services/earlier-chat.js says what moves, why
// its first message is the earliest one, and why nothing new is unread).
//
// It is here, with the other boot repairs, and not a file under
// db/migrations/: a migration file is one transaction that cannot commit as
// it goes (docs/database/schema-migrations.md), and this is a data move over
// every chat with the bot, taken one person at a time under the lock a send
// in that chat takes, so nobody's message waits behind somebody else's
// move. The schema it needs (the thread kind, the read cursor) is the
// tracked migration bot-chat-threads-only.
//
// Every boot, and a no-op once clean: it also sweeps up a message an older
// instance wrote outside a thread while a release was rolling. Best-effort:
// a failure never aborts boot, and a person it could not move is left for
// the next one.
async function moveMainChatToThreads(pool) {
  try {
    const done = await require('../services/earlier-chat').moveAll(pool);
    if (done.moved || done.listed) {
      log.info('db', 'Moved Main Chat under Earlier chat threads', done);
    }
  } catch (err) {
    log.warn('db', 'Moving Main Chat under Earlier chat threads skipped', { err: err.message });
  }
}

// 15 Nov 2026: agent chats and dev chats are retired. What was said in each
// is copied, once, into its owner's chat with Homeroom bot as one finished
// thread (services/old-chat-move.js says what is copied, why the thread
// arrives done and read, and how an old link finds it).
//
// Here with the other boot repairs, not a file under db/migrations/, for the
// reason moveMainChatToThreads gives: it is a data move over every such
// conversation, taken one at a time under the lock a send in that person's
// chat with the bot takes. The table it records in is the tracked migration
// moved-chats. The old tables are left as they are: a later migration drops
// them, once this has run everywhere.
//
// Every boot, and a no-op once clean: it also copies what an older instance
// wrote in an agent chat while a release was rolling. Best-effort: a failure
// never aborts boot, and a conversation it could not move is left for the
// next one.
async function moveOldChatsToThreads(pool) {
  try {
    const done = await require('../services/old-chat-move').moveAll(pool);
    if (done.copied) log.info('db', 'Moved agent chats and dev chats into Homeroom bot threads', done);
  } catch (err) {
    log.warn('db', 'Moving agent chats and dev chats into Homeroom bot threads skipped', { err: err.message });
  }
}

async function backfillLinkedIssuesFromPrBodies(pool) {
  const github = require('../services/github');
  const prMetadata = require('../services/pr-metadata');

  // The GitHub App itself, not isEnabled(): with the git host configured
  // isEnabled() is true in the migration Job too, which never sets the App
  // up and may not reach GitHub, and this read every GitHub-hosted
  // proposal's body there, each one timing out (release of 26 Oct 2026).
  if (typeof github.hasApp === 'function' && !github.hasApp()) {
    log.debug('db', 'linked-issues backfill skipped (no GitHub App in this process)');
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
// version cards open). Only the specs that can be wrapped are read, those whose
// first mark is a fence: reading every spec ever written took seconds of every
// release, and a wrapped one is rare (a spec handed in from the CLI is stored
// as it came, so this keeps running).
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
        WHERE left(spec_md, 4000) ~ '^[^[:alnum:][:punct:]]*[\`~]{3}'`
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
        WHERE left(content, 4000) ~ '^[^[:alnum:][:punct:]]*[\`~]{3}'`
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
      `INSERT INTO chat_session_specs (session_id, version, content, content_html)
         SELECT cs.id, COALESCE(latest.max_version, 0) + 1, cs.spec_md, cs.spec_html
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

  // The newest merge announcement of each candidate, found in ONE pass over
  // the chat and handed back as at most one line per candidate.
  //
  // This used to be one search of the app's chat per merged row. A preview
  // starts with nine merged fixtures that have no announcement at all, and
  // the nine searches of Homeroom's copied chat were 0.8 seconds of each
  // start. Now the chat of the apps concerned is read once: every merge
  // line (the two LIKEs; promote / vote / revert lines also mention the PR
  // but carry neither phrase) gives up the PR numbers it names, those are
  // matched to the candidates by equality, and the newest line per
  // candidate wins before its figure is read, as it did.
  //
  // "(^|[^0-9])PR #" and a greedy run of digits is the old per-row pattern
  // "(^|[^0-9])PR #<ref>([^0-9]|$)" read the other way round: "PR #12"
  // yields 12 and never 1, and the comparison is on text, so "PR #012" is
  // not PR 12, as before. Only ids and timestamps are held while matching;
  // a line's text is fetched for the winners alone, so what reaches this
  // process does not grow with the chat. Both CTEs are MATERIALIZED so the
  // planner cannot turn the pass back into one chat scan per candidate.
  //
  // Two things differ from the per-row search when something else writes
  // while this runs. The statement sees the chat at ONE moment, where each
  // search saw its own: a line that arrives too late leaves its row empty
  // for a later boot, and that boot finds it only if it is still there
  // (clearAutomatedChannelLines, below in migrate(), deletes a system line
  // with no sender and no thread; nothing writes one now, see
  // ws.sendSystemMessage). And `candidate` reads app_id and pr_number
  // again by id, rather than using the values the query above returned.
  // PostgreSQL still reads every merge line of these apps once and sorts
  // their ids, on disk if they outgrow work_mem; what is bounded is what
  // comes back here.
  let winners;
  try {
    ({ rows: winners } = await pool.query(
      `WITH candidate AS MATERIALIZED (
         SELECT id, app_id, COALESCE(NULLIF(pr_number, 0), id)::text AS ref
           FROM chat_sessions
          WHERE id = ANY($1::int[])
       ), named AS MATERIALIZED (
         SELECT m.id, m.app_id, m.created_at, hit.pr[1] AS ref
           FROM chat_messages m
          CROSS JOIN LATERAL regexp_matches(m.content, '(?:^|[^0-9])PR #([0-9]+)', 'g') AS hit(pr)
          WHERE m.app_id IN (SELECT app_id FROM candidate)
            AND m.msg_type = 'system'
            AND (m.content LIKE '%merged and deployed!%'
                 OR m.content LIKE '%force-merged by admin%')
       ), winner AS (
         SELECT DISTINCT ON (c.id) c.id AS session_id, n.id AS message_id
           FROM candidate c
           JOIN named n ON n.app_id = c.app_id AND n.ref = c.ref
          ORDER BY c.id, n.created_at DESC
       )
       SELECT w.session_id, m.content
         FROM winner w
         JOIN chat_messages m ON m.id = w.message_id`,
      [sessions.map((s) => s.id)]
    ));
  } catch (err) {
    // One statement now, so one failure: nothing is filled on this boot and
    // the next one tries again (the per-row search could lose one row and
    // carry on). Never abort boot here.
    log.warn('db', 'votes_required backfill skipped (query failed)', { err: err.message });
    return;
  }
  const announcementOf = new Map(winners.map((w) => [w.session_id, w.content]));

  let filled = 0;
  for (const s of sessions) {
    try {
      const msgs = announcementOf.has(s.id) ? [{ content: announcementOf.get(s.id) }] : [];
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

// The published terms-of-service versions, one entry per revision (#6043).
// The rows before these came across once from the old database
// (scripts/topochain-load.js) and nothing writes terms_versions in
// production otherwise, so a new revision is published by adding it here:
// on the next boot it becomes the current version (the latest
// published_at, routes/topochain/mobile.js), the sign-in screens link to its
// terms_link, and anybody who accepted an earlier version is told the terms
// changed (frontend/src/features/settings/terms-first-run.js).
//
// Nothing serves body_markdown (the terms sheet shows the title, the version
// and the link), so it names the revision and points at the full text on the
// website rather than carrying a second copy that could drift from it.
// Keyed on the unique `version`, so a reboot writes nothing, and an entry is
// never edited in place once shipped: a corrected text is a new version.
const TERMS_VERSIONS = [
  {
    version: '1.0-2026-10-29',
    title: 'Homeroom Platform - Terms of Service',
    link: 'https://onhomeroom.com/legal/terms-of-service',
    publishedAt: '2026-10-29T00:00:00Z',
  },
];

async function seedTermsVersions(pool) {
  for (const v of TERMS_VERSIONS) {
    const body = `# ${v.title}\n\nVersion ${v.version}. The full text is at ${v.link}`;
    await pool.query(
      `INSERT INTO terms_versions
         (version, title, body_markdown, terms_link, published_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (version) DO NOTHING`,
      [v.version, v.title, body, v.link, v.publishedAt]
    );
  }
}

// #6501: enough obviously fake group conversations to exercise a long inbox.
// The fixture member alone sees them; no messages or notifications are sent.
async function seedStagingLongInbox(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const member = (await pool.query("SELECT id FROM users WHERE username = 'usernode-capture'")).rows[0];
  if (!member) return seedSkipped('no user usernode-capture');
  for (let i = 1; i <= 18; i += 1) {
    const title = `Staging demo inbox ${String(i).padStart(2, '0')}`;
    await pool.query(
      `INSERT INTO conversations (kind, title, created_by)
       SELECT 'group', $1::varchar, $2::int WHERE NOT EXISTS (
         SELECT 1 FROM conversations WHERE title = $1 AND created_by = $2)`, [title, member.id]);
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, status, joined_at, responded_at)
       SELECT id, $2, 'owner', 'member', NOW(), NOW() FROM conversations
        WHERE title = $1 AND created_by = $2
       ON CONFLICT (conversation_id, user_id) DO NOTHING`, [title, member.id]);
  }
}

// #7159: Settings › Linked devices shows one row per device with how many
// sign-ins it holds. A fresh copy holds only the sign-in the viewer just made,
// so the fixture member gets three more, all "Chrome on Mac", made on fixed
// fake dates. Each token is random and kept nowhere else: no browser holds
// it, so the rows are only something for the list to count. The fixed
// sign-in dates are how a second boot knows the rows are there.
const STAGING_LINKED_BROWSER_DAYS = ['2026-11-03', '2026-11-10', '2026-11-19'];
async function seedStagingLinkedBrowsers(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const member = (await pool.query("SELECT id FROM users WHERE username = 'usernode-capture'")).rows[0];
  if (!member) return seedSkipped('no user usernode-capture');
  for (const dayOf of STAGING_LINKED_BROWSER_DAYS) {
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at, created_at, user_agent_class, last_seen_at)
       SELECT $3, $1::int, NOW() + INTERVAL '30 days', $2::timestamptz, 'chrome/mac', NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (
          SELECT 1 FROM sessions
           WHERE user_id = $1 AND created_at = $2::timestamptz AND user_agent_class = 'chrome/mac')`,
      [member.id, `${dayOf}T09:00:00Z`, crypto.randomBytes(32).toString('hex')]);
  }
}

// A platform preview's database can start empty (SEC-06), and a reviewer's row
// there takes their production id on first sign-in (middleware/auth.js
// createPreviewReviewer). So before any seed takes the next id, the users
// sequence moves far above any production id, and a fixture never sits on a
// reviewer's id (production's earliest accounts would otherwise be refused).
// Fixed-id fixtures keep their own ids. A no-op once it has moved.
const PREVIEW_USER_ID_FLOOR = 1_000_000_000;
async function reservePreviewReviewerIds(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  await pool.query(
    `SELECT setval(q.seq, GREATEST($1::bigint, COALESCE(s.last_value, 0)))
       FROM (SELECT pg_get_serial_sequence('users', 'id') AS seq) q
       JOIN pg_sequences s ON format('%I.%I', s.schemaname, s.sequencename) = q.seq`,
    [PREVIEW_USER_ID_FLOOR]
  );
}

// A platform preview's database can start empty (SEC-06), so its translation
// cache is filled once from production's public export (GET
// /api/languages/cache, services/language-cache.js exportEntries): the same
// public text the packs serve, with the English each translation was made
// from, so a message this proposal rewords is not shown in its old
// translation. Production is reached at its public origin, which every
// preview is given (app-identity-env.js USERNODE_PLATFORM_ORIGIN). Best
// effort and bounded: English stands in for anything not imported.
const STAGING_TRANSLATIONS_TIMEOUT_MS = 10_000;
async function seedStagingTranslations(pool, { fetchImpl = fetch } = {}) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const origin = String(process.env.USERNODE_PLATFORM_ORIGIN || '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(origin)) return;
  try {
    const { rows: [cached] } = await pool.query('SELECT EXISTS (SELECT 1 FROM language_translations) AS any');
    if (cached.any) return;
    const res = await fetchImpl(`${origin}/api/languages/cache`, {
      signal: AbortSignal.timeout(STAGING_TRANSLATIONS_TIMEOUT_MS), redirect: 'error',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const added = await require('../services/language-cache').importEntries(pool, body?.entries, { model: 'production' });
    log.info('db', 'Staging translations imported', { added });
  } catch (err) {
    log.warn('db', 'Staging translations not imported; English stands in', { err: err.message });
  }
}

// A screenshot persona's id in a platform preview (SEC-06): the fixed one the
// platform signs its tokens with (services/preview-personas.js), since a
// preview's database can start empty. Undefined anywhere else, where the row
// takes the next id.
function previewPersonaId(username) {
  if (process.env.USERNODE_ENV !== 'staging') return undefined;
  return require('../services/preview-personas').PREVIEW_PERSONA_IDS.get(username);
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
      `INSERT INTO users (id, username, password, is_admin, can_create_apps,
         has_platform_access, platform_access_granted_at)
       VALUES (COALESCE($3::int, nextval(pg_get_serial_sequence('users', 'id'))), $1, $2, FALSE, FALSE, TRUE, NOW())
       ON CONFLICT (username) DO UPDATE SET
         has_platform_access = TRUE,
         platform_access_granted_at = COALESCE(users.platform_access_granted_at, NOW())`,
      ['usernode-capture', hash, previewPersonaId('usernode-capture') ?? null]
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
// can never change platform state. Its declared-check frames are pass/fail
// and console errors. The before & after shots a change declares for this
// persona are images, which is why they are shown only to signed-in people
// who can see the project and never to anybody signed out: what a visitor
// may see is the member account's stills alone (services/shots-public.js).
// can_create_apps stays FALSE; the discarded-random-bytes bcrypt password
// blocks interactive login (visuals.js mints a JWT directly). Idempotent:
// keyed on the unique username, DO NOTHING on conflict. Runs unconditionally
// on boot so the platform (prod) DB has it for token minting; a platform
// preview makes it at its fixed id (previewPersonaId), as usernode-capture.
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
    // In a platform preview it also has platform access, as every account
    // there does, so it joins the Homeroom community like the member.
    const previewId = previewPersonaId('usernode-capture-admin') ?? null;
    await pool.query(
      `INSERT INTO users (id, username, password, is_admin, admin_readonly, can_create_apps,
         has_platform_access, platform_access_granted_at)
       VALUES (COALESCE($3::int, nextval(pg_get_serial_sequence('users', 'id'))), $1, $2, TRUE, TRUE, FALSE,
         $3::int IS NOT NULL, CASE WHEN $3::int IS NOT NULL THEN NOW() END)
       ON CONFLICT (username) DO NOTHING`,
      ['usernode-capture-admin', hash, previewId]
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
// One private request (#5048) on the platform's own project, so a preview's
// Workshop shows its Private requests section to the admins who open it.
// private_requests is staging:private, so the copy has no rows of its own.
// Fixed ids, owned by the staging demo user, idempotent, a no-op outside
// staging.
async function seedStagingPrivateRequest(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const { rows } = await pool.query(
      'SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1'
    );
    if (!rows.length) return;
    await pool.query(
      `INSERT INTO private_requests (id, app_id, title, description, created_by, created_at, updated_at)
       VALUES (900501, $1, 'Staging demo private request',
               'Staging demo: a confidential request only platform admins can see.',
               900001, NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day')
       ON CONFLICT DO NOTHING`,
      [rows[0].id]
    );
    await pool.query(
      `INSERT INTO private_request_comments (id, private_request_id, user_id, body, created_at)
       VALUES (900501, 900501, 900001, 'Staging demo comment on a private request.', NOW() - INTERVAL '1 day')
       ON CONFLICT DO NOTHING`
    );
  } catch (err) {
    log.warn('db', 'Staging private request seeding failed', { message: err.message });
  }
}

// #6664's shots: a project that lets anyone see it but only its collaborators
// take part (view_visibility 'public', collab_visibility 'private'), with one
// change waiting on a vote. The shots' member fixture (usernode-capture) is a
// member of its community and NOT one of its collaborators, so the vote used
// to show on her sidebar and in Needs you while pressing Yes was refused; this
// change leaves it out of both. Rows for the fixture account and an obviously
// fake author; nothing here is a signal the code reads to decide anything, and
// a staging copy never acts on the change. Idempotent by slug and branch,
// strictly a no-op outside staging.
async function seedStagingCollabOnlyVote(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const member = (await tx.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1")).rows[0];
    if (!member) { await tx.query('ROLLBACK'); return seedSkipped('no user usernode-capture'); }
    const author = (await tx.query(
      `INSERT INTO users (username, password, has_platform_access)
       VALUES ('staging-demo-collab-author', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
       RETURNING id`)).rows[0];
    await tx.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
       SELECT 'Staging demo: Trading journal', 'staging-demo-collab-only', 'running', $1, 'public', 'private'
        WHERE NOT EXISTS (SELECT 1 FROM apps WHERE slug = 'staging-demo-collab-only')`, [member.id]);
    const app = (await tx.query(
      "SELECT id, community_id FROM apps WHERE slug = 'staging-demo-collab-only'")).rows[0];
    await tx.query(
      `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`, [app.id, author.id]);
    // A member of the community, deliberately without an app_collaborators row.
    await tx.query(
      `INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, 'joined')
       ON CONFLICT DO NOTHING`, [app.community_id, member.id]);
    await tx.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, session_title, pr_number, pr_title,
                                  linked_issues, status, shared_at, promoted_at, check_state,
                                  integration_merges_clean, pr_summary_md)
       SELECT $1, $2, 'staging-fixture/collab-only-vote',
              'Staging demo: a vote on a collaborators-only project',
              96664, 'Staging demo: add a monthly summary', '{}'::int[], 'promoted', NOW(), NOW(),
              'passing', TRUE,
              'Obviously fake: a change waiting on a vote in a project only its collaborators take part in.'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions
                           WHERE app_id = $1 AND branch_name = 'staging-fixture/collab-only-vote')`,
      [app.id, author.id]);
    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK');
    log.warn('db', 'Staging collaborator-only vote seed failed', { message: err.message });
  } finally { tx.release(); }
}


// #6990's shots: the Votes card a vote to close draws had no staging state
// to show — a fresh copy has no request with an open close vote. This seeds
// one, obviously fake, on a small demo project: a request filed by the
// shots' member fixture (usernode-capture) and a proposal to close it by a
// fake author, in the request's own thread. The project needs three Yes
// votes and only its chosen approver (the member) is counted, so her first
// Yes shows on the card as one of three and does not decide it. Nothing
// here is a signal the code reads to decide anything, and a staging copy
// never acts on the vote. Idempotent by slug and request number; strictly a
// no-op outside staging.
async function seedStagingCloseVote(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const member = (await tx.query(
      "SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1")).rows[0];
    if (!member) { await tx.query('ROLLBACK'); return; }
    const author = (await tx.query(
      `INSERT INTO users (username, password, has_platform_access)
       VALUES ('staging-demo-close-author', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
       RETURNING id`)).rows[0];
    // The project carries a repository address even though nothing on it is
    // real: the single-request read resolves the project BY that address
    // (services/requests.js appFor, reached from GET .../github-issues/:number),
    // so without one the request's own page answered 404 and bounced to the
    // Workshop before its Votes card could render. The address is obviously
    // fake and matches no app anywhere else.
    const repoUrl = 'https://github.com/staging-demo/staging-demo-close-vote';
    await tx.query(
      `INSERT INTO apps (name, slug, repo_url, status, created_by, view_visibility, collab_visibility,
                         approver_policy, approvals_required)
       SELECT 'Staging demo: a vote to close', 'staging-demo-close-vote', $2, 'running', $1,
              'public', 'members', 'invited', 3
        WHERE NOT EXISTS (SELECT 1 FROM apps WHERE slug = 'staging-demo-close-vote')`,
      [author.id, repoUrl]);
    // An earlier run of this seed (before the address was written) left the
    // project without one; repair it so a re-run still reaches the page.
    await tx.query(
      `UPDATE apps SET repo_url = $1
        WHERE slug = 'staging-demo-close-vote' AND repo_url IS NULL`,
      [repoUrl]);
    const app = (await tx.query(
      "SELECT id, community_id FROM apps WHERE slug = 'staging-demo-close-vote'")).rows[0];
    if (!app) { await tx.query('ROLLBACK'); return; }
    // The member reads and takes part: community membership, and the one
    // counted approver, so her Yes is a counted vote that does not decide.
    if (app.community_id) {
      await tx.query(
        `INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, 'joined')
         ON CONFLICT DO NOTHING`, [app.community_id, member.id]);
    }
    await tx.query(
      `INSERT INTO app_approvers (app_id, user_id, status) VALUES ($1, $2, 'member')
       ON CONFLICT (app_id, user_id) DO NOTHING`, [app.id, member.id]);
    const number = 9160;
    const title = 'Staging demo: a request with a vote to close';
    await tx.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, $3, 'Staging demo: obviously fake. Someone asked to close this request, and the vote is open.', $4, NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [app.id, number, title, member.id],
    );
    const thread = (await tx.query(
      `INSERT INTO threads (app_id, number)
       SELECT $1, $2
        WHERE NOT EXISTS (SELECT 1 FROM threads WHERE app_id = $1 AND number = $2)
       RETURNING id`,
      [app.id, number],
    )).rows[0];
    if (thread) {
      await tx.query(
        'UPDATE requests SET thread_id = $1 WHERE app_id = $2 AND number = $3 AND thread_id IS NULL',
        [thread.id, app.id, number],
      );
    }
    await tx.query(
      `INSERT INTO issues (app_id, title, description, kind, payload, created_by, status, thread_id)
       SELECT $1, 'Close this request', 'Staging demo: obviously fake.', 'close_issue', $2::jsonb, $3, 'open', t.id
         FROM threads t
        WHERE t.app_id = $1 AND t.number = $4
          AND NOT EXISTS (
            SELECT 1 FROM issues i
             WHERE i.app_id = $1 AND i.kind = 'close_issue' AND i.payload->>'issueNumber' = $4::text)`,
      [app.id, JSON.stringify({
        issueNumber: number,
        reason: 'This is already covered by the new search page.',
      }), author.id, number],
    );
    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK');
    log.warn('db', 'Staging close-vote seeding failed', { message: err.message });
  } finally { tx.release(); }
}

// #7147's shots: the desktop sidebar keeps ten pinned communities now, not
// four. A fresh staging copy has no communities at all for the shots' member
// fixture, so eleven obviously fake private ones are seeded; ten are pinned
// for that account in the order the sidebar shows them, and the eleventh is
// joined but unpinned, so its row's pin is refused with the new number. Rows
// are for the fixture account and an obviously fake host; nothing here is a
// signal the code reads to decide anything, and it is idempotent by slug.
async function seedStagingPinnedCommunities(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const member = (await tx.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1")).rows[0];
    if (!member) { await tx.query('ROLLBACK'); return seedSkipped('no user usernode-capture'); }
    const host = (await tx.query(
      `INSERT INTO users (username, password, has_platform_access)
       VALUES ('staging-demo-pin-host', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
       RETURNING id`)).rows[0];
    const names = ['Chess Club', 'Running Group', 'Plant Pal', 'Choir', 'Book Swap',
      'Recipe Box', 'Trail Maps', 'Sketch Night', 'Puzzle Room', 'Bike Repair', 'Kite Club'];
    for (let i = 0; i < names.length; i++) {
      const slug = `staging-demo-pin-${i + 1}`;
      await tx.query(
        `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, icon_emoji)
         SELECT $1::text, $2::text, 'running', $3, 'private', 'private', '🎲'
          WHERE NOT EXISTS (SELECT 1 FROM apps WHERE slug = $2::text)`,
        [`Staging demo: ${names[i]}`, slug, host.id]);
      const app = (await tx.query('SELECT id, community_id FROM apps WHERE slug = $1', [slug])).rows[0];
      if (!app || !app.community_id) continue;
      await tx.query(
        `INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, 'joined')
         ON CONFLICT DO NOTHING`, [app.community_id, member.id]);
      // A member of a private community may see its project, so the row's
      // pin works from the sidebar.
      await tx.query(
        `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`, [app.id, member.id]);
      // Ten pinned, in pin order; the eleventh waits to be pinned.
      if (i < 10) {
        await tx.query(
          `INSERT INTO community_pins (community_id, user_id, position) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`, [app.community_id, member.id, i]);
      }
    }
    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK');
    log.warn('db', 'Staging pinned communities seed failed', { message: err.message });
  } finally { tx.release(); }
}

// The hub's Discussion (26 Nov 2026): a project's #general drawn as posts
// with replies. A fresh staging copy has no project with a channel worth
// drawing for the shots' member fixture, so two obviously fake private
// projects are seeded, the member in each: one with four posts, their
// replies and reactions, and one whose #general was a busy chat before
// Discussion, twelve old messages that fold into "Earlier in #general", with
// two posts and a reply written since. Fake people only, idempotent by
// project (a project that already has messages is left alone), and nothing
// here is a signal any code reads to decide anything.
async function seedStagingDiscussion(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const member = (await tx.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1")).rows[0];
    if (!member) { await tx.query('ROLLBACK'); return seedSkipped('no user usernode-capture'); }
    const people = {};
    for (const name of ['priya', 'dev', 'ana', 'jo', 'marcus']) {
      people[name] = (await tx.query(
        `INSERT INTO users (username, password, has_platform_access)
         VALUES ($1, 'staging-demo-not-a-login', TRUE)
         ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
         RETURNING id`, [`staging-demo-${name}`])).rows[0].id;
    }
    const project = async (slug, name, emoji) => {
      await tx.query(
        `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, icon_emoji)
         SELECT $1::text, $2::text, 'running', $3, 'private', 'private', $4::text
          WHERE NOT EXISTS (SELECT 1 FROM apps WHERE slug = $2::text)`,
        [name, slug, people.priya, emoji]);
      const app = (await tx.query('SELECT id, community_id FROM apps WHERE slug = $1', [slug])).rows[0];
      if (!app || !app.community_id) return null;
      for (const id of [member.id, ...Object.values(people)]) {
        await tx.query(
          `INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, 'joined')
           ON CONFLICT DO NOTHING`, [app.community_id, id]);
        await tx.query(
          `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')
           ON CONFLICT DO NOTHING`, [app.id, id]);
      }
      const said = (await tx.query('SELECT 1 FROM chat_messages WHERE app_id = $1 LIMIT 1', [app.id])).rows[0];
      return said ? null : app.id;
    };
    // `ago` is minutes before now; null is now. Where a message lands beside
    // the Discussion marker decides whether it is a post or part of the
    // Earlier post, and a staging copy takes that marker from production, so
    // the times are held to their side of it (seedDiscussionClock).
    // The oldest post is the library's, 26 hours back.
    const at = await seedDiscussionClock(tx, 26 * 60);
    const say = async (appId, who, content, ago, rootId = null, earlier = false) => (await tx.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
       RETURNING id`,
      [appId, people[who], `Staging demo: ${content}`, rootId ? 'message' : null, rootId, at(ago, earlier)])).rows[0].id;
    const react = async (messageId, emoji, who) => {
      for (const name of who) {
        await tx.query(
          `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`, [messageId, people[name], emoji]);
      }
    };
    // A post or reply with files (the follow-up's attachments): the files
    // are obviously fake, a placeholder picture and a short text file.
    const sayWith = (appId, who, content, ago, files, rootId = null) => seedDiscussionFiles(tx, {
      appId, userId: people[who], content: content ? `Staging demo: ${content}` : '', at: at(ago), files, rootId,
    });
    const club = await project('staging-demo-discussion', 'Staging demo: Book Club', '📖');
    if (club) {
      const library = await say(club, 'dev', 'the library has four copies of Piranesi on hold for us. Pick up by Friday.', 26 * 60);
      await react(library, '👍', ['jo', 'ana']);
      const finished = await say(club, 'ana', 'finished The Remains of the Day last night. I need a week to recover.', 300);
      await react(finished, '❤️', ['priya', 'jo', 'dev', 'marcus', 'ana']);
      await say(club, 'jo', 'same, the last chapter got me.', 290, finished);
      await say(club, 'marcus', 'Adding it to my list for the winter.', 280, finished);
      await say(club, 'dev', 'Was it the letter, or the pier?', 275, finished);
      await say(club, 'priya', 'The pier. Every time.', 270, finished);
      const shelf = await say(club, 'jo', 'can we get a shelf for what everyone is reading right now? I keep asking in here.', 180);
      await react(shelf, '👍', ['marcus', 'ana', 'dev']);
      const yeses = await say(club, 'marcus', 'Put it up as a change. It needs two more yeses.', 170, shelf);
      await react(yeses, '👍', ['jo']);
      const host = await say(club, 'priya', 'I can host on the 14th if we start at 7. Who is in?', 60);
      await react(host, '👍', ['dev', 'ana', 'jo', 'marcus']);
      await react(host, '🎉', ['ana']);
      // #7232: one post and its reply written in another language, so the
      // Discussion's translation has something to translate for a reader of
      // English. Obviously fake, by a fake person, and nothing reads it to
      // decide anything.
      const abroad = await say(club, 'jo', 'Selamat pagi semua, buku bulan ini sudah datang. Siapa yang mau ikut baca bareng hari Sabtu?', 130);
      await say(club, 'ana', 'Aku ikut! Jam sepuluh pagi di perpustakaan ya.', 125, abroad);
      // ...and their answers, kept as the route keeps them (a digest of the
      // exact words, answers/user-content-translations), so the translation
      // shows where no model can be asked (the before & after copies).
      for (const [content, text] of [
        ['Staging demo: Selamat pagi semua, buku bulan ini sudah datang. Siapa yang mau ikut baca bareng hari Sabtu?',
          'Staging demo: Morning everyone, this month\'s book has arrived. Who wants to read it together on Saturday?'],
        ['Staging demo: Aku ikut! Jam sepuluh pagi di perpustakaan ya.',
          'Staging demo: Count me in! Ten in the morning at the library, okay?'],
      ]) {
        await tx.query(
          `INSERT INTO user_content_translations (source_digest, language, text, source_language, model)
           VALUES ($1, 'en', $2, 'id', 'staging-seed')
           ON CONFLICT (source_digest, language) DO NOTHING`,
          [crypto.createHash('sha256').update(content).digest('hex'), text]);
      }
      const chairs = await say(club, 'dev', 'In. I can bring four chairs.', 50, host);
      await react(chairs, '🙌', ['priya', 'ana']);
      // #2783: `#1` reads as the project's request.
      await say(club, 'ana', 'In, and I will bring dessert. The list is in #1.', 40, host);
      // The follow-up's states: formatting, files, a deleted post with its
      // replies, and a run of shared plans the Discussion folds (#2884).
      await say(club, 'marcus', '**Reading for March:** _Klara and the Sun_. Bring one question each.', 120);
      const photo = await sayWith(club, 'jo', 'the reading corner is ready.', 90, [SEED_PICTURE]);
      await react(photo, '😍', ['ana', 'priya']);
      await sayWith(club, 'priya', 'here is the schedule for the spring.', 85, [SEED_TEXT_FILE], photo);
      // A post its author deleted after a reply came: written deleted, as the
      // delete leaves it (no words), so the Discussion says so above its reply.
      const gone = (await tx.query(
        `INSERT INTO chat_messages (app_id, user_id, content, created_at, deleted_at)
         VALUES ($1, $2, '', $3::timestamptz, NOW()) RETURNING id`,
        [club, people.dev, at(70)])).rows[0].id;
      await say(club, 'ana', 'Thursday works for me.', 65, gone);
      for (let i = 0; i < 4; i += 1) {
        await tx.query(
          `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, created_at)
           VALUES ($1, $2, '', 'spec_share', $3::jsonb, $4::timestamptz)`,
          [club, people.priya, JSON.stringify({ specShare: { title: `Staging demo: plan ${i + 1} for the reading shelf`, prNumber: null } }), at(100 - i)]);
      }
    }
    const busy = await project('staging-demo-discussion-busy', 'Staging demo: Trail Runners', '⛰️');
    if (busy) {
      const old = [
        ['marcus', 'who is running the ridge loop on Saturday?'], ['jo', 'Me, if it is not raining.'],
        ['dev', 'Count me in.'], ['ana', 'Is the north gate open again?'], ['priya', 'Yes, since Tuesday.'],
        ['marcus', 'Meet at the car park at 8.'], ['jo', 'Who has a spare head torch?'], ['dev', 'I have two.'],
        ['ana', 'Pace for the long run?'], ['priya', 'Easy, about 6 minutes a kilometre.'],
        ['marcus', 'New shoes day. Wish me luck.'], ['jo', 'Seconded on the trail shoes thread, they are worth it.'],
      ];
      let last = null;
      for (let i = 0; i < old.length; i += 1) {
        const ago = (old.length - i) * 24 * 60 + 300;
        last = await say(busy, old[i][0], old[i][1], ago, null, true);
        // One of them had a reply thread of its own, inside the Earlier post.
        if (i === 6) await say(busy, 'dev', 'I can lend one.', ago - 30, last, true);
      }
      // Written into "Earlier discussion" since: a reply under its last message.
      await say(busy, 'ana', 'Catching up on all of this. Count me in for the next long run.', null, last);
      const route = await say(busy, 'marcus', 'Proposing a new Sunday route along the river. Thoughts?', null);
      await react(route, '👍', ['jo', 'ana']);
      await say(busy, 'jo', 'Yes please, the hills are wrecking my knees.', null, route);
      await say(busy, 'priya', 'Race day photos are up on the shared album.', null);
      // The Earlier post's own reactions, on the project's anchor.
      for (const name of ['jo', 'ana', 'dev']) {
        await tx.query(
          `INSERT INTO discussion_earlier_reactions (app_id, user_id, emoji)
           SELECT a.id, $2, '❤️' FROM apps a WHERE a.slug = $1 ON CONFLICT DO NOTHING`,
          ['staging-demo-discussion-busy', people[name]]);
      }
    }
    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK');
    log.warn('db', 'Staging discussion seed failed', { message: err.message });
  } finally { tx.release(); }
}

// An obviously fake picture and text file for the Discussion's seeds.
const SEED_PICTURE = Object.freeze({ kind: 'image', filename: 'staging-demo-reading-corner.png', contentType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAPAAAACMCAIAAADN17N/AAAB30lEQVR42u3coQ3AMAxFQY+dSTpDcGcoLOwYBRmh1CTQxD3pD/BkHXaczyravN+iada8Wzi0ZqAdWjPQcGgGGg7NQGsG2qE1A+3QmoGGQzPQcGgGWjPQDq0ZaIfWDDQcmoGGQzPQmoF2aM1AO7RmoOHQDLRmzUBrBtqhNQPt0JqBhkMz0Jo1A60ZaIfWDLRDawYaDs1Aa9acQDuH5k7NQGsG2qE1Aw2HZqDh0Ay0ZqAdWjPQDq0ZaDg0Aw2HZqA1A+3QmoF2aM1Aw6EZaDg0A60ZaIfWDLRDawYaDs1Aw6EZaM1AO7RmoB1aM9BwaAZas2agNQPt0JqBdmjNQMOhGWjNmjNo59DsP7RDawYaDs1Aw6EZaM1AO7RmoB1aM9BwaAYaDs1AawbaoTUD7dCagYZDM9BwaAZaM9AOrRloh9YMNByagdasGWjNQDu0ZqAdWjPQcGgGWrNmoDUD7dCagXZozUDDoRlozZqB1twV9HENszYD2oA2A9oMaDOgDWgzoM2ANgPaDGgD2gxoM6DNgDYD2oA2A9oMaDOgzYA2oM2ANgPaDGgzoA1oM6DNgDYD2gxoA9oMaDOgzYA2A9qANgPaDGgzoA1oVzCgzYA2A9oMaAPaDGgzoM2ANgPafrcPyHxo0DKcOWgAAAAASUVORK5CYII=' });
const SEED_TEXT_FILE = Object.freeze({ kind: 'text', filename: 'staging-demo-schedule.txt', contentType: 'text/plain', text: 'Staging demo: obviously fake.\nMarch 14: Klara and the Sun\nApril 11: Piranesi\n' });

/**
 * The Discussion seeds' clock. A message before the Discussion marker
 * (platform_settings.discussion_posts_since, services/discussion.js) is part
 * of the Earlier post once there are enough of them; one after it is a post.
 * A staging copy's marker may be minutes old (a fresh database's) or
 * production's, so a time "N minutes ago" could land on either side of it.
 * `at(ago)` is a post's time: as asked when the marker is older than the
 * seed's oldest post (`span` minutes ago), else the seed's span pressed in
 * between the marker and now, in the same order. `at(ago, true)` is held
 * before the marker, in the order asked (the Earlier post's).
 */
async function seedDiscussionClock(db, span) {
  const row = (await db.query("SELECT value FROM platform_settings WHERE key = 'discussion_posts_since'")).rows[0];
  const since = row ? Date.parse(String(row.value).replace(/^"|"$/g, '')) : NaN;
  const now = Date.now();
  const oldest = now - span * 60000;
  let before = 0;
  return (ago, earlier = false) => {
    const t = now - (Number(ago) || 0) * 60000;
    if (!Number.isFinite(since)) return new Date(t).toISOString();
    if (earlier) {
      before += 1;
      return new Date(Math.min(t, since - (400 - before) * 3600000)).toISOString();
    }
    if (since < oldest) return new Date(t).toISOString();
    const start = Math.min(since + 1000, now);
    return new Date(start + ((Math.max(t, oldest) - oldest) * (now - start)) / (now - oldest || 1)).toISOString();
  };
}

/**
 * A post or a reply carrying files, as the chat's upload and send write them
 * (chat_message_attachments rows linked to the message, and the message's
 * metadata.attachments). Returns the message's id.
 */
async function seedDiscussionFiles(db, { appId, userId, content, at, files, rootId = null }) {
  const crypto = require('crypto');
  const rows = files.map((file) => {
    const data = file.base64 ? Buffer.from(file.base64, 'base64') : Buffer.from(file.text || '', 'utf8');
    return { ...file, id: crypto.randomBytes(16).toString('hex'), data };
  });
  const metadata = { attachments: rows.map((f) => ({ id: f.id, kind: f.kind, filename: f.filename, sizeBytes: f.data.length })) };
  const id = (await db.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
     RETURNING id`,
    [appId, userId, content, rootId ? 'message' : null, rootId, JSON.stringify(metadata), at])).rows[0].id;
  for (const f of rows) {
    await db.query(
      `INSERT INTO chat_message_attachments (id, app_id, message_id, user_id, kind, filename, content_type, size_bytes, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [f.id, appId, id, userId, f.kind, f.filename, f.contentType, f.data.length, f.data]);
  }
  return id;
}

// Hearts and plays (services/app-popularity.js): a fresh staging copy has no
// hearts and no visitor plays, so the busy public project
// seedStagingGuestProjectPage makes is given some, for its hub's card, its
// signed-out page and its card on Communities to draw: hearts from fourteen
// of its own fake members, and three days of visitors' plays. Fake people on
// a fake project only, and nothing here is read to decide anything.
// Idempotent: every row is ON CONFLICT DO NOTHING. A no-op outside staging.
async function seedStagingHeartsAndPlays(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
  const app = (await pool.query("SELECT id FROM apps WHERE slug = 'staging-guest-page-busy'")).rows[0];
  if (!app) return seedSkipped('no project staging-guest-page-busy');
  const members = (await pool.query(
    `SELECT c.user_id FROM app_collaborators c
      WHERE c.app_id = $1 AND c.status = 'member' ORDER BY c.user_id LIMIT 14`, [app.id])).rows;
  if (!members.length) return seedSkipped('staging-guest-page-busy has no members');
  for (const { user_id: userId } of members) {
    await pool.query(
      `INSERT INTO app_hearts (app_id, user_id, created_at)
       VALUES ($1, $2, NOW() - INTERVAL '2 days') ON CONFLICT DO NOTHING`,
      [app.id, userId]
    );
  }
  for (const [daysAgo, plays] of [[1, 64], [2, 58], [3, 61]]) {
    await pool.query(
      `INSERT INTO app_visitor_plays (app_id, day, plays)
       VALUES ($1, CURRENT_DATE - $2::int, $3) ON CONFLICT DO NOTHING`,
      [app.id, daysAgo, plays]
    );
  }
  log.info('db', 'Staging hearts and plays seeded');
  } catch (err) {
    log.warn('db', 'Staging hearts and plays seeding failed', { message: err.message });
  }
}

// The signed-out project page's Discussion (26 Nov 2026): the busy public
// project seedStagingGuestProjectPage makes has no posts, so a few are
// written there by its own fake people, in its own "[Mock]" voice: posts
// with replies, reactions and a picture, for a visitor to read. Idempotent:
// a project that has any message is left alone.
async function seedStagingGuestDiscussion(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const app = (await tx.query("SELECT id, created_by FROM apps WHERE slug = 'staging-guest-page-busy'")).rows[0];
    if (!app) { await tx.query('ROLLBACK'); return seedSkipped('no project staging-guest-page-busy'); }
    if ((await tx.query('SELECT 1 FROM chat_messages WHERE app_id = $1 LIMIT 1', [app.id])).rows[0]) {
      await tx.query('ROLLBACK');
      return seedSkipped('staging-guest-page-busy already has a discussion');
    }
    const people = (await tx.query(
      `SELECT c.user_id FROM app_collaborators c WHERE c.app_id = $1 ORDER BY c.user_id LIMIT 4`, [app.id])).rows.map((r) => r.user_id);
    const [a, b, c, d] = [app.created_by, ...people].filter(Boolean);
    if (!a || !b) { await tx.query('ROLLBACK'); return seedSkipped('staging-guest-page-busy has too few people'); }
    const at = await seedDiscussionClock(tx, 600);
    const say = async (who, content, ago, rootId = null) => (await tx.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz) RETURNING id`,
      [app.id, who, `[Mock] ${content}`, rootId ? 'message' : null, rootId, at(ago)])).rows[0].id;
    const react = (messageId, emoji, who) => Promise.all(who.filter(Boolean).map((u) => tx.query(
      'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [messageId, u, emoji])));
    const welcome = await say(a, 'Welcome, everyone. Post what you would like this project to do next.', 600);
    await react(welcome, '👋', [b, c, d]);
    const idea = await say(b, 'Could the list remember where I left off?', 240);
    await say(c || a, 'Yes please, I lose my place every time.', 230, idea);
    await say(a, 'Put it up as a change and we can vote on it.', 220, idea);
    await react(idea, '👍', [a, c, d]);
    const picture = await seedDiscussionFiles(tx, { appId: app.id, userId: d || b, content: '[Mock] A sketch of the new layout.', at: at(60), files: [SEED_PICTURE] });
    await react(picture, '🎉', [a, b]);
    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK');
    log.warn('db', 'Staging guest discussion seed failed', { message: err.message });
  } finally { tx.release(); }
}

// #7170's shots: a request's header draws the project's emoji in its tile. A
// fresh staging copy has a request only in a project whose icon is a picture,
// so one obviously fake request is seeded in the first of the emoji projects
// above, for the shots' member fixture. Nothing here is a signal the code
// reads to decide anything, and it is idempotent by app and number.
async function seedStagingEmojiThreadRequest(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const app = (await pool.query("SELECT id FROM apps WHERE slug = 'staging-demo-pin-1'")).rows[0];
    if (!app) return seedSkipped('no project staging-demo-pin-1');
    const member = (await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1")).rows[0];
    if (!member) return seedSkipped('no user usernode-capture');
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, 'Staging demo: a request in an emoji project',
              'Staging demo: obviously fake. The project''s emoji sits in the thread header''s tile.',
              $3, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [app.id, 9170, member.id],
    );
  } catch (err) {
    log.warn('db', 'Staging emoji thread request seed failed', { message: err.message });
  }
}

// #7027's shots: an invitation to build is not a waiting invitation once its
// person is in the project. Two obviously fake projects, one per screen:
//
//   * someone else's, where the capture member already joined the community
//     and still has an unread invitation to build it, so the bell's Invites
//     row reads "@inviter offered to let you build …" and "You joined it";
//   * the capture member's own, where a fake person joined the community and
//     was offered building, so Members & approvals tags them "offered to
//     build" instead of "invited".
//
// Rows are for the fixture account and fake people; nothing here is a signal
// the code reads to decide anything, and the invitation's status is the one a
// real join leaves behind. Idempotent by slug, a no-op outside staging.
async function seedStagingJoinedBuildOffer(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const member = (await tx.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1")).rows[0];
    if (!member) { await tx.query('ROLLBACK'); return seedSkipped('no user usernode-capture'); }
    const inviter = (await tx.query(
      `INSERT INTO users (username, password, has_platform_access)
       VALUES ('staging-demo-offer-inviter', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
       RETURNING id`)).rows[0];
    const offered = (await tx.query(
      `INSERT INTO users (username, password, has_platform_access)
       VALUES ('staging-demo-offer-builder', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
       RETURNING id`)).rows[0];

    // Someone else's project, which the capture member has already joined.
    await tx.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
       SELECT 'Staging demo: Page Turners', 'staging-demo-build-offer', 'running', $1, 'public', 'private'
        WHERE NOT EXISTS (SELECT 1 FROM apps WHERE slug = 'staging-demo-build-offer')`, [inviter.id]);
    const theirs = (await tx.query(
      "SELECT id, community_id FROM apps WHERE slug = 'staging-demo-build-offer'")).rows[0];
    await tx.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
       VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING`, [theirs.id, inviter.id]);
    await tx.query(
      `INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, 'joined')
       ON CONFLICT DO NOTHING`, [theirs.community_id, member.id]);
    // The invitation to build, still waiting, though they are in the project.
    await tx.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by)
       VALUES ($1, $2, 'invited', $3) ON CONFLICT DO NOTHING`, [theirs.id, member.id, inviter.id]);
    await tx.query(
      `INSERT INTO notifications (user_id, app_id, source_user_id, kind, created_at, read_at)
       SELECT $1, $2, $3, 'collab_invite', NOW() - INTERVAL '2 days', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM notifications
                           WHERE user_id = $1 AND app_id = $2 AND kind = 'collab_invite')`,
      [member.id, theirs.id, inviter.id]);

    // The capture member's own project, with a fake person in it who was
    // offered building and has not taken it up.
    await tx.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
       SELECT 'Staging demo: Reading Club', 'staging-demo-members-offer', 'running', $1, 'public', 'private'
        WHERE NOT EXISTS (SELECT 1 FROM apps WHERE slug = 'staging-demo-members-offer')`, [member.id]);
    const own = (await tx.query(
      "SELECT id, community_id FROM apps WHERE slug = 'staging-demo-members-offer'")).rows[0];
    await tx.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
       VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING`, [own.id, member.id]);
    await tx.query(
      `INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, 'joined')
       ON CONFLICT DO NOTHING`, [own.community_id, offered.id]);
    await tx.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by)
       VALUES ($1, $2, 'invited', $3) ON CONFLICT DO NOTHING`, [own.id, offered.id, member.id]);
    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK');
    log.warn('db', 'Staging build-offer seed failed', { message: err.message });
  } finally { tx.release(); }
}

// Mobile 04's shots (24 Nov 2026): being named with @ in a thread is Needs
// you on the Homeroom bot tab until you answer or dismiss it
// (services/thread-mentions.js). A fresh staging copy names the capture
// member nowhere, so an obviously fake person names her in the thread of an
// obviously fake request on the self-hosted Homeroom project: the message,
// and the 'mention' notification the socket writes for it. Rows for
// the fixture account and a fake person; nothing here is a signal the code
// reads to decide anything. Only an @ from the last week starts a row, so a
// copy kept longer has the @ moved back to two hours ago on its next boot,
// unless she has answered it. Idempotent by request number and message text;
// strictly a no-op outside staging.
const NAMED_SEED_NUMBER = 907004;
const NAMED_SEED_TEXT = '@usernode-capture could you check the swap times on this one? (Staging demo: obviously fake.)';
async function seedStagingNamedInThread(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const member = (await tx.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1")).rows[0];
    const app = (await tx.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1')).rows[0];
    if (!member || !app) { await tx.query('ROLLBACK'); return; }
    const namer = (await tx.query(
      `INSERT INTO users (username, password, has_platform_access)
       VALUES ('staging-demo-namer', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
       RETURNING id`)).rows[0];
    await tx.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, 'Staging demo: a sign-up sheet for the plant swap',
              'Staging demo: obviously fake. Somebody named you in its thread.', $3,
              NOW() - INTERVAL '1 day', NOW() - INTERVAL '2 hours'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [app.id, NAMED_SEED_NUMBER, namer.id]);
    await tx.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, created_at)
       SELECT $1, $2, $3, 'issue', $4, NOW() - INTERVAL '2 hours'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages WHERE app_id = $1 AND user_id = $2 AND content = $3)`,
      [app.id, namer.id, NAMED_SEED_TEXT, NAMED_SEED_NUMBER]);
    const msg = (await tx.query(
      'SELECT id, thread_id FROM chat_messages WHERE app_id = $1 AND user_id = $2 AND content = $3 ORDER BY id LIMIT 1',
      [app.id, namer.id, NAMED_SEED_TEXT])).rows[0];
    // A week old and not answered yet: two hours ago again.
    await tx.query(
      `UPDATE chat_messages m SET created_at = NOW() - INTERVAL '2 hours'
        WHERE m.id = $1 AND m.created_at < NOW() - INTERVAL '5 days'
          AND NOT EXISTS (SELECT 1 FROM chat_messages w
                           WHERE w.thread_id = m.thread_id AND w.user_id = $2 AND w.created_at > m.created_at)`,
      [msg.id, member.id]);
    await tx.query(
      `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind)
       SELECT $1, $2, $3, $4, 'mention'
        WHERE NOT EXISTS (SELECT 1 FROM notifications
                           WHERE user_id = $1 AND chat_message_id = $3 AND kind = 'mention')`,
      [member.id, app.id, msg.id, namer.id]);
    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK');
    log.warn('db', 'Staging named-in-thread seed failed', { message: err.message });
  } finally { tx.release(); }
}

// #6158: the Homeroom bot tab's Waiting rows now say what each request waits
// on, read from the bot's own records. A fresh staging copy has no such
// records, so the before & after shots get a small, obviously fake mix on the
// self-hosted Homeroom project, filed by the shots' member fixture
// (usernode-capture): one in the bot's queue, one held for a slot, one it
// handed back to a person, one it never read, one operator task, and (#6532)
// one whose ready build still waits its turn. Rows for that fixture account
// only; nothing here is a signal the bot reads to decide anything, and a
// staging copy never acts on its queue. Idempotent by request number; strictly
// a no-op outside staging.
async function seedStagingBotWaitingRows(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!apps.rows.length || !people.rows.length) return seedSkipped('no self-hosted project or no user usernode-capture');
    const appId = apps.rows[0].id;
    const userId = people.rows[0].id;
    const demo = [
      { number: 9101, title: 'Staging demo: a request in the bot\'s queue', queue: true },
      { number: 9102, title: 'Staging demo: a request held for a slot', held: 'proposals_per_app' },
      {
        number: 9103,
        title: 'Staging demo: a request handed back to a person',
        verdict: 'person',
        // 6 Nov 2026 (#6395): the reason matches the note below, which offers
        // no Go ahead because one cannot settle operator work outside the app.
        reason: 'Staging demo: moving App secrets in the infra repo and deleting a GitHub Actions secret are operator work outside this app.',
        firstStep: 'Remove the dead bot token line from the deploy workflow',
        cannot: true,
      },
      { number: 9104, title: 'Staging demo: a request the bot has not read' },
      { number: 9105, title: 'Operator: staging demo, rotate the demo mail key' },
      // #6532: the state the report found: `issue.bot` already says building
      // while the stored track still waits its turn (`live_build_waiting_at`
      // set, no build session). Says Ready to build and "will build this
      // next", never "is building this".
      { number: 9106, title: 'Staging demo: a request the bot is ready to build', buildQueued: true },
      // #6867: a request a build left owed because OpenRouter's credit ran
      // out. Its row on the bot's tab and its own page say it waits for
      // building credit and that the bot picks it up again by itself.
      { number: 9119, title: 'Staging demo: a request waiting for building credit', creditWait: true },
      // #7215: a report filed on Homeroom's board from another project's
      // page. Its body carries the About line the route writes, by app id
      // only, and its reply (below) is the bot's answer that nothing needs
      // building. Staging has no model, so the reply is stored.
      {
        number: 9121,
        title: 'Staging demo: a report from another project\'s page',
        body: '**About:** a private project (app id 412)\n\nStaging demo: a request still showed in the Requests column after its change was already in Done.',
        // The before copy has main's schema, which has no about_app_id, so the
        // same request there is the one filed without the About line. Both
        // sides of the pair then show what the change altered.
        bodyBefore: 'Staging demo: a request still showed in the Requests column after its change was already in Done.',
      },
    ];
    // #7215: this seed also runs on the before copy of a before & after pair,
    // from the after copy's code against main's schema. That copy has no
    // about_app_id column, so it gets the request as it was filed before this
    // change: no About line, and the bot's old answer.
    const aboutColumn = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'feedback_reports' AND column_name = 'about_app_id' LIMIT 1`,
    );
    const hasAboutColumn = aboutColumn.rows.length > 0;
    for (const d of demo) {
      const body = d.number === 9121 && !hasAboutColumn
        ? d.bodyBefore
        : (d.body || 'Staging demo: obviously fake.');
      await pool.query(
        `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
         SELECT $1, $2, $3, $5, $4, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'
          WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
        [appId, d.number, d.title, userId, body],
      );
      if (d.queue) {
        await pool.query(
          `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, requested_by, enqueued_at)
           SELECT $1, $2, 2, 'refresh', $3, NOW() - INTERVAL '1 day'
            WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2)`,
          [appId, d.number, userId],
        );
      }
      if (d.held || d.verdict) {
        await pool.query(
          `INSERT INTO homeroom_bot_runs
             (app_id, issue_number, mode, verdict, reason, cap_suppressed, go_ahead_decides, first_step, go_ahead_blocker, created_at)
           SELECT $1, $2, 'live', $3, $4, $5, $6, $7, $8, NOW() - INTERVAL '1 day'
            WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs
                               WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND verdict = $3)`,
          [appId, d.number, d.verdict || 'ready', d.reason || null, d.held || null,
            d.cannot ? false : null, d.firstStep || null, d.cannot ? 'operator_work' : null],
        );
      }
      if (d.creditWait) {
        // #6867: the row the bot owes itself after a build found OpenRouter's
        // credit gone. It waits, quietly, and nothing but the balance read
        // starts it again: no run is written, so it is never in the bot's tray.
        await pool.query(
          `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
           VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, issue_number) DO NOTHING`,
          [appId, d.number, userId, d.title],
        );
        await pool.query(
          `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, requested_by, enqueued_at)
           SELECT $1, $2, 2, 'credit_wait', $3, NOW() - INTERVAL '1 day'
            WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2)`,
          [appId, d.number, userId],
        );
      }
      if (d.buildQueued) {
        // The capture member's own track, so the row is in their Homeroom bot
        // tab's Waiting & in progress list as well as its page.
        await pool.query(
          `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
           VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, issue_number) DO NOTHING`,
          [appId, d.number, userId, d.title],
        );
        await pool.query(
          `INSERT INTO homeroom_bot_runs
             (app_id, issue_number, mode, verdict, live_build_waiting_at, created_at)
           SELECT $1, $2, 'live', 'ready', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour'
            WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs
                               WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND verdict = 'ready')`,
          [appId, d.number],
        );
      }
    }
    // 3 Nov 2026 (#6213): the note the bot handed 9103 back to a person with,
    // carrying the suggested replies only its requester sees and taps. The
    // request page draws the thread's messages, so this is the state the
    // before & after shots need; nothing here is a signal the bot reads.
    // 6 Nov 2026 (#6395): the request is operator work a go-ahead cannot
    // settle, so the note leads with the part the bot can build and offers
    // no Go ahead. The before copy's own seed still has the old note.
    // The bot's account, in the posture botAccount() reads (the later
    // staging fixtures seed it too, ON CONFLICT-safe), so this note has its
    // author even when they have not run yet.
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const botRow = await pool.query(
      "SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1",
    );
    if (botRow.rows.length) {
      // #7215: the bot's answer on the report filed from another project's
      // page: it read that project and found the request had already closed
      // by itself, so it built nothing. Idempotent by its stagingDemo mark.
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
         SELECT $1, $2, $3, 'message', 'issue', 9121, $4, NOW() - INTERVAL '20 minutes'
          WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                             WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9121
                               AND metadata->>'stagingDemo' = 'about-project-reply')`,
        [
          appId, botRow.rows[0].id,
          hasAboutColumn
            ? 'I checked the project you were looking at. That request closed by itself 13 seconds before you sent this, '
              + 'as its change merged: Homeroom closes a merged change\'s requests a few seconds after the merge, and '
              + 'your screenshot caught that moment. Nothing needs fixing, so I haven\'t built anything.'
            : 'On this project a change is a pull request, numbered by GitHub. I\'ll hide any request whose change is in Done.',
          JSON.stringify({ stagingDemo: 'about-project-reply', homeroomBot: { kind: 'person' } }),
        ],
      );
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
         SELECT $1, $2, $3, 'message', 'issue', 9103, $4, NOW() - INTERVAL '1 day'
          WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                             WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9103
                               AND metadata->>'stagingDemo' = 'person-note')`,
        [
          appId, botRow.rows[0].id,
          'This needs something set up outside this app, which I can\'t do from here: Staging demo: moving App secrets in the infra '
            + 'repo and deleting a GitHub Actions secret are operator work outside this app. A person has to build it, '
            + 'for example with a coding agent, and the group votes on it as usual. I can build this part now: Remove '
            + 'the dead bot token line from the deploy workflow.',
          JSON.stringify({
            stagingDemo: 'person-note',
            homeroomBot: {
              kind: 'note',
              suggest: { status: 'open', forUserIds: [userId] },
              actions: [
                {
                  id: 'smaller',
                  label: 'Remove the dead bot token line from the deploy workflow',
                  style: 'primary',
                  type: 'prompt',
                },
                { id: 'not_now', label: 'Not now', style: 'secondary', type: 'prompt' },
              ],
            },
          }),
        ],
      );
      // 6 Nov 2026 (#6395): the same request after its requester said Go
      // ahead, and the one plain line the bot answers with instead of the
      // note again. Staging has no model, so both messages are stored.
      // Idempotent by their stagingDemo marks.
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
         SELECT $1, $2, 'Go ahead', 'message', 'issue', 9103, $3, NOW() - INTERVAL '2 hours'
          WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                             WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9103
                               AND metadata->>'stagingDemo' = 'go-ahead-ask')`,
        [appId, userId, JSON.stringify({ stagingDemo: 'go-ahead-ask' })],
      );
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
         SELECT $1, $2, $3, 'message', 'issue', 9103, $4, NOW() - INTERVAL '1 hour'
          WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                             WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9103
                               AND metadata->>'stagingDemo' = 'go-ahead-reply')`,
        [
          appId, botRow.rows[0].id,
          'A go-ahead can\'t settle this one. This needs something set up outside this app, which I can\'t do from here: moving App secrets and deleting a GitHub '
            + 'Actions secret are operator work outside this app. A person has to build it, for example you with a '
            + 'coding agent, and the group votes on it as usual. I can build this part now: Remove the dead bot token '
            + 'line from the deploy workflow.',
          JSON.stringify({ stagingDemo: 'go-ahead-reply' }),
        ],
      );

      // #6391: a later word from the bot in the same thread that carries the
      // other members' set. Nobody in particular was answered, so a member
      // who opens it (usernode-capture) is not one it answered and gets
      // those buttons. The before & after shots need the state on the after
      // copy; nothing here is a signal the bot reads. Idempotent by its
      // stagingDemo mark.
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
         SELECT $1, $2, $3, 'message', 'issue', 9103, $4, NOW() - INTERVAL '19 hours'
          WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                             WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9103
                               AND metadata->>'stagingDemo' = 'others-suggestions')`,
        [
          appId, botRow.rows[0].id,
          'Staging demo: I am on it now. I will say here when this request is ready to vote.',
          JSON.stringify({
            stagingDemo: 'others-suggestions',
            homeroomBot: {
              kind: 'voice',
              suggest: { status: 'open', forUserIds: [] },
              actions: [],
              othersActions: [
                { id: 'others-1', label: 'I\'d like this too', style: 'secondary', type: 'prompt' },
                { id: 'others-2', label: 'Can I try it?', style: 'secondary', type: 'prompt' },
                { id: 'others-3', label: 'What\'s left to do?', style: 'secondary', type: 'prompt' },
              ],
            },
          }),
        ],
      );
      // #6920: a thread answer the bot held for OpenRouter's credit, and the
      // answer it gave in the thread once credit was back. A fresh staging
      // copy has no model and the bot is off there, so the words are stored
      // for the before & after shots; nothing here is a signal the bot reads.
      // Idempotent by their stagingDemo marks.
      for (const m of [
        {
          mark: 'credit-held-ask', author: userId, interval: '2 days',
          text: '@Homeroom bot is the header blue on the settings page too?', bot: false,
        },
        {
          mark: 'credit-held-line', author: botRow.rows[0].id, interval: '47 hours',
          text: 'OpenRouter\'s credit ran out. I\'ll answer this here as soon as it\'s back.', bot: true,
        },
        {
          mark: 'credit-held-answer', author: botRow.rows[0].id, interval: '1 day',
          text: 'Yes. The settings page uses the same header as the rest of the app, so it is blue there too.', bot: true,
        },
      ]) {
        await pool.query(
          `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
           SELECT $1, $2, $3, 'message', 'issue', 9119, $4, NOW() - ($5)::interval
            WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                               WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9119
                                 AND metadata->>'stagingDemo' = $6)`,
          [
            appId, m.author, m.text,
            JSON.stringify({ stagingDemo: m.mark, ...(m.bot ? { homeroomBot: { kind: 'voice' } } : {}) }),
            m.interval, m.mark,
          ],
        );
      }
      // #6311: the note about Homeroom itself, with the copy offer under it
      // (Put it on Homeroom's board / Keep it here only). The before & after
      // shots need the state on the after copy; nothing here is a signal the
      // bot reads. Idempotent by its stagingDemo mark.
      const copyNote = await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
         SELECT $1, $2, $3, 'message', 'issue', 9103, $4, NOW() - INTERVAL '20 hours'
          WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                             WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9103
                               AND metadata->>'stagingDemo' = 'copy-offer-note')
          RETURNING id`,
        [
          appId, botRow.rows[0].id,
          'I think this is about Homeroom itself, not Staging demo: Staging demo: the signed-out page sends a person '
            + 'to the authorize page. I can put it on Homeroom\'s own board too and keep this request open here.',
          JSON.stringify({ stagingDemo: 'copy-offer-note' }),
        ],
      );
      if (copyNote.rows.length) {
        const messageId = Number(copyNote.rows[0].id);
        const { rows: [offer] } = await pool.query(
          // A thread's offer is one of Homeroom bot's cards (bot_cards, 5 Nov 2026).
          `INSERT INTO bot_cards (place, app_id, kind, args, user_id, chat_message_id)
           VALUES ('thread', $1, 'copy_request', $2, $3, $4) RETURNING id`,
          [appId, JSON.stringify({ issueNumber: 9103, title: 'Staging demo: the signed-out page sends a person to the authorize page' }), userId, messageId],
        );
        const offerId = Number(offer.id);
        await pool.query('UPDATE chat_messages SET metadata = $2 WHERE id = $1', [messageId, JSON.stringify({
          stagingDemo: 'copy-offer-note',
          homeroomBot: {
            kind: 'voice',
            offer: { id: offerId, kind: 'copy_request', status: 'open', forUserId: userId },
            actions: [
              { id: 'yes', label: 'Put it on Homeroom\'s board', style: 'primary', offerId },
              { id: 'no', label: 'Keep it here only', style: 'secondary', offerId },
            ],
          },
        })]);
      }
      // 11 Nov 2026 (#6614): a reply about work the bot queued, with the
      // plain yes first, and the one short line that answers that yes with
      // no buttons. Staging has no model, so both are stored. For the shots'
      // member fixture on request 9103; idempotent by their stagingDemo
      // marks; strictly a no-op outside staging.
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
         SELECT $1, $2, $3, 'message', 'issue', 9103, $4, NOW() - INTERVAL '40 minutes'
          WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                             WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9103
                               AND metadata->>'stagingDemo' = 'affirmed-work')`,
        [
          appId, botRow.rows[0].id,
          'Staging demo: I have queued a fix on Change #178. The one failing check is the repo unit suite.',
          JSON.stringify({
            stagingDemo: 'affirmed-work',
            homeroomBot: {
              kind: 'voice',
              affirm: { label: 'Sounds good' },
              suggest: { status: 'open', forUserIds: [userId] },
              actions: [
                { id: 'suggest-1', label: 'Sounds good', style: 'secondary', type: 'prompt' },
                { id: 'suggest-2', label: 'Tell me when it\'s ready', style: 'secondary', type: 'prompt' },
              ],
              othersActions: [
                { id: 'others-1', label: 'I\'d like this too', style: 'secondary', type: 'prompt' },
                { id: 'others-2', label: 'Can I try it?', style: 'secondary', type: 'prompt' },
              ],
            },
          }),
        ],
      );
      const yes = await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
         SELECT $1, $2, 'Sounds good', 'message', 'issue', 9103, $3, NOW() - INTERVAL '30 minutes'
          WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                             WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9103
                               AND metadata->>'stagingDemo' = 'affirm-yes')
          RETURNING id`,
        [appId, userId, JSON.stringify({ stagingDemo: 'affirm-yes' })],
      );
      const yesId = yes.rows[0]?.id || (await pool.query(
        `SELECT id FROM chat_messages
          WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9103
            AND metadata->>'stagingDemo' = 'affirm-yes' LIMIT 1`, [appId],
      )).rows[0]?.id;
      if (yesId) {
        await pool.query(
          `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
           SELECT $1, $2, $3, 'message', 'issue', 9103, $4, NOW() - INTERVAL '20 minutes'
            WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                               WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9103
                                 AND metadata->>'stagingDemo' = 'affirm-ack')`,
          [
            appId, botRow.rows[0].id,
            'Thanks, I\'ll tell you here when it\'s ready.',
            JSON.stringify({
              stagingDemo: 'affirm-ack',
              homeroomBot: { kind: 'voice', affirmed: { messageId: Number(yesId) } },
            }),
          ],
        );
      }
      // 20 Nov 2026 (#6914): a request's page whose Homeroom bot reply carries
      // a comparison, so the shots can show it drawn under the reply with
      // nothing running. Obviously fake and inert (no script, no address);
      // idempotent by its stagingDemo mark; a no-op outside staging.
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
         SELECT $1, $2, $3, 'message', 'issue', 9103, $4, NOW() - INTERVAL '10 minutes'
          WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                             WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9103
                               AND metadata->>'stagingDemo' = 'thread-comparison')`,
        [
          appId, botRow.rows[0].id,
          'Staging demo: here they are side by side. Today\'s filter row on the left, the request\'s on the right.',
          JSON.stringify({
            stagingDemo: 'thread-comparison',
            homeroomBot: {
              kind: 'voice',
              comparison: {
                title: 'Before and after',
                html: '<!doctype html><html><head><style>'
                  + 'body{margin:0;padding:16px;font:14px/1.45 system-ui,sans-serif;color:#18181b;background:#fff}'
                  + '.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}'
                  + 'h3{margin:0 0 8px;font-size:14px}'
                  + '.chips{display:flex;gap:6px;flex-wrap:wrap}'
                  + '.chip{padding:4px 10px;border-radius:999px;background:#f4f4f5}'
                  + '.chip.new{background:#dbe8ff}'
                  + 'p{margin:8px 0 0;color:#71717a;font-size:12px}'
                  + '</style></head><body><div class="cols">'
                  + '<div><h3>Today</h3><div class="chips"><span class="chip">Open</span><span class="chip">Mine</span>'
                  + '<span class="chip">Voting</span></div><p>Three chips, each wrapping onto its own line.</p></div>'
                  + '<div><h3>With this change</h3><div class="chips"><span class="chip new">Open</span>'
                  + '<span class="chip new">Mine</span><span class="chip new">Voting</span></div>'
                  + '<p>One line: all three fit, and wrap together when they cannot.</p></div>'
                  + '</div></body></html>',
              },
            },
          }),
        ],
      );
    }
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot waiting rows seeding failed', { message: err.message });
  }
}

// #6420's shots: a change that lives on request #9140's page and names
// request #9141 among the ones it closes, so #9141's page shows "Change says
// it closes this" and, for the request's requester (usernode-capture), "This
// doesn't close it". Built by the staging demo person so the requester is not
// the change's own builder. Obviously fake; idempotent by its change number;
// a no-op outside staging. No claim row is written: the card reads
// `linked_issues`, which is the feature.
async function seedStagingChangeClaim(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const builder = await pool.query("SELECT id FROM users WHERE username = 'staging-demo-user' LIMIT 1");
    if (!apps.rows.length || !builder.rows.length) return seedSkipped('no self-hosted project or no builder');
    const appId = apps.rows[0].id;
    // The pages the shots open: #9141 is the request the change names (asked
    // by usernode-capture, so the requester sees the answer), #9140 the
    // request whose page the change lives on.
    const capture = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!capture.rows.length) return;
    for (const [number, title, createdBy] of [
      [9140, 'Staging demo: show who replied last on each request row', Number(builder.rows[0].id)],
      [9141, 'Staging demo: a request another change says it closes', Number(capture.rows[0].id)],
    ]) {
      await pool.query(
        `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
         SELECT $1, $2, $3, 'Staging demo: obviously fake.', $4, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'
          WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
        [appId, number, title, createdBy],
      );
    }
    await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, status, shared_at, linked_issues, pr_number, pr_title, pr_summary_md, branch_name, created_at)
       SELECT $1, $2, 'active', NOW() - INTERVAL '2 days', '{9140,9141}', 9901,
              'Staging demo: tidy the request rows',
              'Request rows show who replied last. Staging demo: obviously fake.',
              'feature/staging-demo-request-rows', NOW() - INTERVAL '2 days'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE app_id = $1 AND pr_number = 9901)`,
      [appId, Number(builder.rows[0].id)],
    );
    const { rows: [change] } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND pr_number = 9901 LIMIT 1', [appId],
    );
    if (!change) return;
    // The claim row means the sweep announces it no more: the bot's line is
    // stored below, as a fresh staging copy has no model to write it.
    await pool.query(
      `INSERT INTO change_request_claims (session_id, app_id, request_number, announced_at)
       VALUES ($1, $2, 9141, NOW() - INTERVAL '2 days') ON CONFLICT DO NOTHING`,
      [Number(change.id), appId],
    );
    const bot = await pool.query("SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1");
    if (!bot.rows.length) return seedSkipped('no Homeroom bot user');
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
       SELECT $1, $2, 'Change PR 9901 says it closes your request #9141.', 'message', 'issue', 9141,
              $3, NOW() - INTERVAL '2 days'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9141
                             AND metadata->>'stagingDemo' = 'change-claim')`,
      [appId, Number(bot.rows[0].id), JSON.stringify({ stagingDemo: 'change-claim', kind: 'change_claim', sessionId: Number(change.id), request: 9141 })],
    );
    // The requester's bell row for that line, so the notice is visible there
    // too. No push is sent for a seeded row.
    await pool.query(
      `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind, detail)
       SELECT $3, $1, m.id, $2, 'issue_thread_reply', '9141'
         FROM chat_messages m
        WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = 9141
          AND m.metadata->>'stagingDemo' = 'change-claim'
          AND NOT EXISTS (SELECT 1 FROM notifications n
                           WHERE n.chat_message_id = m.id AND n.user_id = $3)`,
      [appId, Number(bot.rows[0].id), Number(capture.rows[0].id)],
    );
  } catch (err) {
    log.warn('db', 'Staging change-claim seeding failed', { message: err.message });
  }
}

// #6667: the Homeroom bot tab moves a request to Needs you once the bot
// hands its failing change back to the person who asked for it. A fresh
// staging copy has no such change (nothing there runs a model), so the before
// & after shots get one: an obviously fake request on the self-hosted
// Homeroom project, filed by the shots' member fixture (usernode-capture),
// with a promoted bot change whose checks failed and a run that gave it to a
// person. Nothing here is a signal the code reads to decide anything, and a
// staging copy never acts on its queue. Idempotent by request number and
// branch; strictly a no-op outside staging.
async function seedStagingBotHandedBackFix(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query(
      "SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')",
    );
    const appId = apps.rows[0]?.id;
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    if (!appId || !member || !bot) return;
    const number = 9109;
    const head = 'stagingdemo6667';
    const branch = 'staging-fixture/bot-handed-back-6667';
    const title = 'Staging demo: a change Homeroom bot handed back';
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, $3, 'Staging demo: obviously fake. Homeroom bot built a change for this request, its checks failed, and it handed the fix back to a person.', $4, NOW() - INTERVAL '3 hours', NOW() - INTERVAL '1 hour'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [appId, number, title, member.id],
    );
    // The asker, so the tab knows this request is theirs.
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
       VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, issue_number) DO NOTHING`,
      [appId, number, member.id, title],
    );
    // The bot's change: promoted, its checks failing on the head it reviewed.
    let change = (await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch],
    )).rows[0];
    if (!change) {
      change = (await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_title, status, linked_issues, check_state,
            reviewed_head_sha, promoted_at, last_activity_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'promoted', ARRAY[$4]::int[], 'failing', $6,
                 NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '3 hours')
         RETURNING id`,
        [appId, bot.id, branch, number, title, head],
      )).rows[0];
    }
    // The run that tried and gave up: the change's page and the tab read it.
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha, created_at)
       SELECT $1, $2, 'live', 'person', $3, $4, NOW() - INTERVAL '1 hour'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs
                           WHERE proposal_session_id = $3 AND LOWER(checks_head_sha) = $4 AND verdict = 'person')`,
      [appId, number, change.id, head],
    );
  } catch (err) {
    log.warn('db', 'Staging bot handed-back fix seeding failed', { message: err.message });
  }
}

// #6533: the before & after shots show a change's thread whose Homeroom bot
// reply already carries its email pictures. A fresh staging copy has no model
// to answer in a change's thread, so the two pictures (the same admit email,
// as it is today and with the change) and the reply under them are stored
// here. Rows for the shots' member fixture (usernode-capture) on the
// self-hosted Homeroom project only; nothing here is a signal the code reads
// to decide anything. Idempotent by change number and picture id; strictly a
// no-op outside staging.
async function seedStagingChangePictures(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id, name, slug FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query(
      "SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')",
    );
    const app = apps.rows[0];
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    if (!app || !member || !bot) return;
    const changeNumber = 9653;
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, pr_number, pr_title, session_title, status, source, created_at, last_activity_at)
       SELECT $1, $2, 'staging/demo-change-pictures', $3,
              'Staging demo: what a change looks like', 'Staging demo: what a change looks like',
              'promoted', 'native', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE app_id = $1 AND pr_number = $3)`,
      [app.id, member.id, changeNumber],
    );
    const { rows: [change] } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND pr_number = $2 LIMIT 1', [app.id, changeNumber],
    );
    if (!change) return;
    const { renderMessage } = require('../services/mail/render');
    const { actionFor } = require('../services/mail/actions');
    const { englishTemplate, seededLayout } = require('./email-template-seeds');
    const kind = 'waitlist_released';
    const template = englishTemplate(kind);
    const layout = seededLayout(template.layout);
    const drawn = renderMessage(kind, { template, layout }, actionFor(kind).sample);
    const pictures = [
      { id: 'a1'.repeat(16), side: 'before', subject: "You're in. Welcome to Homeroom", preheader: drawn.preheader, sha: 'a'.repeat(40) },
      // The after side is the same email with words a change could give it.
      { id: 'b2'.repeat(16), side: 'after', subject: "You're in. Bring your people", preheader: 'Invite up to three friends.', sha: 'b'.repeat(40) },
    ];
    for (const picture of pictures) {
      const body = {
        kind, side: picture.side, subject: picture.subject, preheader: picture.preheader,
        html: drawn.html.replace(/You&#39;re in[\s\S]*?(?=<table role="presentation" cellpadding="0")/, ''),
        text: drawn.text,
      };
      const data = Buffer.from(JSON.stringify(body), 'utf8');
      await withStagingMedia(pool, data, 'application/json', (tx, m) => tx.query(
        `INSERT INTO change_pictures (id, app_id, session_id, mail_kind, side, is_new, subject, preheader, sha, object_key, created_at)
         VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7, $8, $9, NOW() - INTERVAL '2 days')
         ON CONFLICT DO NOTHING`,
        [picture.id, app.id, change.id, kind, picture.side, picture.subject, picture.preheader,
          picture.sha, m.key],
      ));
    }
    const gallery = {
      type: 'gallery', v: 1, purpose: 'change',
      project: { slug: app.slug, name: app.name || app.slug },
      change: { sessionId: Number(change.id), number: changeNumber },
      images: pictures.map((picture) => ({
        id: picture.id, source: 'email', side: picture.side, isNew: false,
        // #6541: a caption names the version it was drawn from.
        caption: `${picture.subject} · ${picture.sha.slice(0, 7)}`,
      })),
    };
    // 20 Nov 2026: the comparison a thread reply carries is drawn under it,
    // static, with nothing running (homeroom-bot-voice.js say). A fresh
    // staging copy has no model to lay one out, so this obviously fake one is
    // stored with the reply. It is inert markup: no script, no address.
    const comparison = {
      title: 'Staging demo: the filter row, today and with this change',
      html: '<!doctype html><html><head><style>'
        + 'body{margin:0;padding:16px;font:14px/1.45 system-ui,sans-serif;color:#18181b;background:#fff}'
        + '.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}'
        + 'h3{margin:0 0 8px;font-size:14px}'
        + '.row{display:flex;gap:6px;margin:0 0 8px;flex-wrap:wrap}'
        + '.chip{padding:4px 10px;border-radius:999px;background:#f4f4f5}'
        + '.chip.new{background:#dbe8ff}'
        + 'p{margin:0;color:#71717a;font-size:12px}'
        + '</style></head><body><div class="cols">'
        + '<div><h3>Today</h3><div class="row"><span class="chip">Open</span><span class="chip">Mine</span>'
        + '<span class="chip">Voting</span></div><p>Three chips, each wrapping onto its own line.</p></div>'
        + '<div><h3>With this change</h3><div class="row"><span class="chip new">Open</span>'
        + '<span class="chip new">Mine</span><span class="chip new">Voting</span></div>'
        + '<p>One line: all three fit, and wrap together when they cannot.</p></div>'
        + '</div></body></html>',
    };
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
       SELECT $1, $2, 'Here is what this change looks like, drawn from bbbbbbb, its newest version: the admit email as it is today and with this change.',
              'message', 'session', $3, $4, NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1 AND thread_type = 'session' AND thread_ref = $3
                             AND metadata->>'stagingDemo' = 'change-pictures')`,
      [app.id, bot.id, Number(change.id), JSON.stringify({
        stagingDemo: 'change-pictures', homeroomBot: { kind: 'voice', gallery, comparison },
      })],
    );
  } catch (err) {
    log.warn('db', 'Staging change pictures seeding failed', { message: err.message });
  }
}

// #6306 (4 Nov 2026): a request Homeroom bot read and found already works.
// Its run carries `already_done`, so the Homeroom bot tab's Needs you offers
// "Already works: …" with Propose to close, and its page's note says why.
// Filed by the shots' member fixture (usernode-capture); the bot's note is
// stored because staging has no model. Idempotent by request number and a
// no-op outside staging.
async function seedStagingBotAlreadyWorks(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id, slug FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    const bot = await pool.query("SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1");
    if (!apps.rows.length || !people.rows.length || !bot.rows.length) return seedSkipped('no self-hosted project, no user usernode-capture or no Homeroom bot');
    const appId = apps.rows[0].id;
    const appSlug = apps.rows[0].slug;
    const userId = people.rows[0].id;
    const botId = bot.rows[0].id;
    const number = 9110;
    const title = 'Staging demo: a request the bot found already works';
    const reason = 'Staging demo: visitors can already get in and play without an account.';
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, $3, 'Staging demo: obviously fake.', $4, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [appId, number, title, userId],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
       VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, issue_number) DO NOTHING`,
      [appId, number, userId, title],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, reason, already_done, created_at)
       SELECT $1, $2, 'live', 'person', $3, TRUE, NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs
                           WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND verdict = 'person')`,
      [appId, number, reason],
    );
    const note = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
       SELECT $1, $2, $3, 'message', 'issue', $4, $5, NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $4
                             AND metadata->>'stagingDemo' = 'already-works-note')
       RETURNING id`,
      [
        appId, botId,
        `Already works: ${reason} Anyone in the project can tap Propose to close below to start a vote, or reply here if something is missing.`,
        number,
        JSON.stringify({ stagingDemo: 'already-works-note', homeroomBot: { kind: 'note' } }),
      ],
    );
    // The bell row the real sender writes for the same moment, worded by the
    // service that words it (#6306): Needs you, "Already works", the bot's
    // sentence. It hangs off the note above so its row opens the request's
    // thread, and carries `i`/`p` so the bell links to that request, not to
    // Main Chat. Rows for the shots' member fixture only.
    let noteId = note.rows[0] ? note.rows[0].id : null;
    if (noteId == null) {
      const existing = await pool.query(
        `SELECT id FROM chat_messages
          WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2
            AND metadata->>'stagingDemo' = 'already-works-note'
          ORDER BY id LIMIT 1`,
        [appId, number],
      );
      noteId = existing.rows[0] ? existing.rows[0].id : null;
    }
    const { botNotificationDetail } = require('../services/homeroom-bot-notify-copy');
    const detail = botNotificationDetail({
      moment: 'needs_you', said: 'done', kind: 'person',
      appName: 'Homeroom', appSlug, requestTitle: title, reason, issueNumber: number,
    });
    if (noteId != null && detail) {
      await pool.query(
        `INSERT INTO notifications
           (user_id, app_id, chat_message_id, source_user_id, kind, detail, read_at, created_at)
         SELECT $1::int, $2::int, $3::int, $4::int, 'build_needs_you', $5::varchar, NULL, NOW() - INTERVAL '1 day'
          WHERE NOT EXISTS (SELECT 1 FROM notifications n
                             WHERE n.user_id = $1 AND n.kind = 'build_needs_you' AND n.chat_message_id = $3::int)`,
        [userId, appId, noteId, botId, detail],
      );
    }
    // #6321: the note with Propose to close and Keep it open under it for
    // any member. A copy that already has the note gets its buttons, so the
    // after copy shows the state either way (its words stay as written). A
    // row nobody decides with until a person taps; idempotent by the offer
    // tied to the note.
    if (noteId != null) {
      const tied = await pool.query(
        `SELECT 1 FROM bot_cards WHERE place = 'thread' AND chat_message_id = $1
          UNION ALL SELECT 1 FROM homeroom_bot_voice_offers WHERE message_id = $1 LIMIT 1`, [noteId],
      );
      if (!tied.rows.length) {
        const { rows: [offer] } = await pool.query(
          `INSERT INTO bot_cards (place, app_id, kind, args, user_id, chat_message_id)
           VALUES ('thread', $1, 'close_request', $2, NULL, $3) RETURNING id`,
          [appId, JSON.stringify({ issueNumber: number, title, why: reason }), noteId],
        );
        const offerId = Number(offer.id);
        // Its buttons only: a message's words never change once written
        // (step 4, 11 Nov 2026), so the note is written with these words.
        await pool.query('UPDATE chat_messages SET metadata = $2 WHERE id = $1', [
          noteId,
          JSON.stringify({
            stagingDemo: 'already-works-note',
            homeroomBot: {
              kind: 'voice',
              offer: { id: offerId, kind: 'close_request', status: 'open', forUserId: null },
              actions: [
                { id: 'yes', label: 'Propose to close', style: 'primary', offerId },
                { id: 'no', label: 'Keep it open', style: 'secondary', offerId },
              ],
            },
          }),
        ]);
      }
    }
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot already-works seeding failed', { message: err.message });
  }
}

// #6988's shots: the already-works request's bot offer once it is gone, so
// its line keeps saying so and carries Propose to close, which opens the
// close dialog with the bot's reason already in its box. Stored because
// staging has no model. It rides the #6306 request the seed above stages
// (that fixture's own test pins it at one note and one bell row, so this is
// its own function, not a second note inside that one). Idempotent by its
// stagingDemo mark; a no-op outside staging. Nothing here is a signal the bot
// reads.
async function seedStagingBotGoneCloseOffer(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const bot = await pool.query("SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1");
    if (!apps.rows.length || !bot.rows.length) return seedSkipped('no self-hosted project or no Homeroom bot');
    const appId = apps.rows[0].id;
    const botId = bot.rows[0].id;
    const number = 9110;
    const reason = 'Staging demo: visitors can already get in and play without an account.';
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
       SELECT $1, $2, $3, 'message', 'issue', $4, $5, NOW() - INTERVAL '20 hours'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $4
                             AND metadata->>'stagingDemo' = 'gone-close-offer-note')`,
      [
        appId, botId,
        `Already works: ${reason}`,
        number,
        JSON.stringify({
          stagingDemo: 'gone-close-offer-note',
          homeroomBot: {
            kind: 'voice',
            offer: {
              kind: 'close_request', status: 'gone', forUserId: null,
              issueNumber: number, why: reason,
            },
            actions: [],
          },
        }),
      ],
    );
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot gone-offer seeding failed', { message: err.message });
  }
}

// #6752 (17 Nov 2026): a request Homeroom bot read as filed on the wrong
// project. Its run carries `wrong_project`, its note says where the request
// seems to belong and quotes what points there, and Propose to close under
// it opens the same close vote a finished request gets. Filed by the shots'
// member fixture (usernode-capture); the bot's note is stored because
// staging has no model. Idempotent by request number and a no-op outside
// staging.
async function seedStagingBotWrongProject(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id, slug, name FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    const bot = await pool.query("SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1");
    if (!apps.rows.length || !people.rows.length || !bot.rows.length) return seedSkipped('no self-hosted project, no user usernode-capture or no Homeroom bot');
    const { id: appId, slug: appSlug, name: appName } = apps.rows[0];
    const userId = people.rows[0].id;
    const botId = bot.rows[0].id;
    const number = 9111;
    const title = 'Staging demo: a request the bot found on the wrong project';
    const wrongProject = {
      project: 'Plant Pal',
      why: 'It asks for "Plant Pal\'s watering screen", which this project does not have.',
    };
    const live = require('../services/homeroom-bot-live');
    const noteText = live.wrongProjectHomeroomText({ wrongProject, project: appName });
    const why = live.wrongProjectReason(wrongProject);
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, $3, 'Staging demo: obviously fake.', $4, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [appId, number, title, userId],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
       VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, issue_number) DO NOTHING`,
      [appId, number, userId, title],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, reason, wrong_project, created_at)
       SELECT $1, $2, 'live', 'person', $3, $4, NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs
                           WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND verdict = 'person')`,
      [appId, number, why, JSON.stringify(wrongProject)],
    );
    const note = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
       SELECT $1, $2, $3, 'message', 'issue', $4, $5, NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $4
                             AND metadata->>'stagingDemo' = 'wrong-project-note')
       RETURNING id`,
      [
        appId, botId, noteText, number,
        JSON.stringify({ stagingDemo: 'wrong-project-note', homeroomBot: { kind: 'note' } }),
      ],
    );
    let noteId = note.rows[0] ? note.rows[0].id : null;
    if (noteId == null) {
      const existing = await pool.query(
        `SELECT id FROM chat_messages
          WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2
            AND metadata->>'stagingDemo' = 'wrong-project-note'
          ORDER BY id LIMIT 1`,
        [appId, number],
      );
      noteId = existing.rows[0] ? existing.rows[0].id : null;
    }
    const { botNotificationDetail } = require('../services/homeroom-bot-notify-copy');
    const detail = botNotificationDetail({
      moment: 'needs_you', said: 'stopped', kind: 'person',
      appName, appSlug, requestTitle: title, reason: why, issueNumber: number,
    });
    if (noteId != null && detail) {
      await pool.query(
        `INSERT INTO notifications
           (user_id, app_id, chat_message_id, source_user_id, kind, detail, read_at, created_at)
         SELECT $1::int, $2::int, $3::int, $4::int, 'build_needs_you', $5::varchar, NULL, NOW() - INTERVAL '1 day'
          WHERE NOT EXISTS (SELECT 1 FROM notifications n
                             WHERE n.user_id = $1 AND n.kind = 'build_needs_you' AND n.chat_message_id = $3::int)`,
        [userId, appId, noteId, botId, detail],
      );
    }
    // The note with Propose to close and Keep it open under it for any
    // member. Idempotent by the offer tied to the note.
    if (noteId != null) {
      const tied = await pool.query(
        `SELECT 1 FROM bot_cards WHERE place = 'thread' AND chat_message_id = $1
          UNION ALL SELECT 1 FROM homeroom_bot_voice_offers WHERE message_id = $1 LIMIT 1`, [noteId],
      );
      if (!tied.rows.length) {
        const { rows: [offer] } = await pool.query(
          `INSERT INTO bot_cards (place, app_id, kind, args, user_id, chat_message_id)
           VALUES ('thread', $1, 'close_request', $2, NULL, $3) RETURNING id`,
          [appId, JSON.stringify({ issueNumber: number, title, why }), noteId],
        );
        const offerId = Number(offer.id);
        await pool.query('UPDATE chat_messages SET metadata = $2 WHERE id = $1', [
          noteId,
          JSON.stringify({
            stagingDemo: 'wrong-project-note',
            homeroomBot: {
              kind: 'voice',
              offer: { id: offerId, kind: 'close_request', status: 'open', forUserId: null },
              actions: [
                { id: 'yes', label: 'Propose to close', style: 'primary', offerId },
                { id: 'no', label: 'Keep it open', style: 'secondary', offerId },
              ],
            },
          }),
        ]);
      }
    }
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot wrong-project seeding failed', { message: err.message });
  }
}

// #6399's shots: #6351's state, a request the bot handed back on 5 Nov 2026
// because it could not read a plan a person posted. Homeroom can read one
// since 6 Nov 13:05 UTC, so the page says the reason may be out of date and
// offers to read it again. A fresh staging copy has no such record, so this
// seeds one for the shots' member fixture (usernode-capture), obviously
// fake, with the run's clock fixed before that release. Nothing here is a
// signal the bot reads to decide anything, and a staging copy never acts on
// its queue. Idempotent by request number; strictly a no-op outside staging.
async function seedStagingBotOutdatedReason(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!apps.rows.length || !people.rows.length) return seedSkipped('no self-hosted project or no user usernode-capture');
    const appId = apps.rows[0].id;
    const userId = people.rows[0].id;
    const number = 9112;
    const title = 'Staging demo: a request handed back over a plan the bot could not read';
    const reason = "A design decision: the new look exists only in a person's version 3 plan, which cannot be read here.";
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, $3, 'Staging demo: obviously fake.', $4, '2026-11-05T10:00:00Z', '2026-11-05T10:00:00Z'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [appId, number, title, userId],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
       VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, issue_number) DO NOTHING`,
      [appId, number, userId, title],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, reason, created_at)
       SELECT $1, $2, 'live', 'person', $3, '2026-11-05T11:19:00Z'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs
                           WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND verdict = 'person')`,
      [appId, number, reason],
    );
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot out-of-date reason seeding failed', { message: err.message });
  }
}

// #6441's shots: three of the capture member's requests gone live within an
// hour of each other, so the bell's Unread shows the folded "3 of your
// requests went live" row with each one listed under it. A fresh staging
// copy has no such news, and staging runs no bot to make it, so the rows the
// bot would have rung are seeded, worded by the service that words the real
// ones. Obviously fake, for the shots' member fixture only (usernode-capture),
// and nothing here is a signal the code reads to decide anything. Idempotent
// by the rows' own "Staging demo:" detail; strictly a no-op outside staging.
async function seedStagingFoldedLiveNotifications(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query(
      'SELECT id, name, slug FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1',
    );
    const people = await pool.query(
      `SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')`,
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    const app = apps.rows[0];
    if (!app || !member || !bot) return;
    const { botNotificationDetail } = require('../services/homeroom-bot-notify-copy');
    const rows = [
      { number: 9201, minutesAgo: 3, title: 'Staging demo: a swap calendar for the group' },
      // #7132's shots: one title long enough for the chip's two-line clamp.
      { number: 9202, minutesAgo: 5, title: 'Staging demo: label every seed packet by season and note where it was sown, so the next swap is quicker to pack' },
      { number: 9203, minutesAgo: 8, title: 'Staging demo: a reminder before the next swap' },
    ];
    for (const row of rows) {
      const detail = botNotificationDetail({
        moment: 'live',
        said: 'live',
        appName: app.name || app.slug,
        appSlug: app.slug,
        issueNumber: row.number,
        requestTitle: row.title,
      });
      await pool.query(
        `INSERT INTO notifications
           (user_id, app_id, source_user_id, kind, detail, read_at, created_at)
         SELECT $1::int, $2::int, $3::int, 'build_live', $4::varchar, NULL,
                NOW() - make_interval(mins => $5::int)
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications n
             WHERE n.user_id = $1 AND n.kind = 'build_live' AND n.detail = $4::varchar
          )`,
        [member.id, app.id, bot.id, detail, row.minutesAgo],
      );
    }
  } catch (err) {
    log.warn('db', 'Staging folded "went live" seeding failed', { message: err.message });
  }
}

// #6494's shots: the two storage notices the sweep now writes, "over half
// full" and "nearly full", each carrying the space used and the limit. A
// fresh staging copy has no project whose database grew, and staging runs no
// sweep against one, so both rows are seeded for the shots' member fixture
// (usernode-capture), on obviously fake projects of its own. Nothing here is
// a signal the code reads to decide anything. Idempotent by app and detail
// token; strictly a no-op outside staging.
//
// Two projects, not one: a newer storage notice replaces an unread older one
// for the same project, so a real bell holds one per project. The one at
// half full has only the early notice, and the one nearly full has only the
// warning (a sweep that jumped past both lines sends the highest alone).
// #6901's shots: the run of refusals Admin → Limits counts, and the bell's
// refusal notices. Obviously fake people, staging only, idempotent.
async function seedStagingLimitRefusals(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = (await pool.query(
      `SELECT id FROM users
        WHERE username IN ('usernode-capture', 'usernode-capture-admin', 'staging-demo-user')
        ORDER BY id`
    )).rows;
    if (!people.length) return;
    const refusals = people.slice(0, 3);
    await pool.query(
      `INSERT INTO platform_limit_alerts
         (limit_key, level, used, cap, measured_at, refusals_since, refusals_notified_at)
       VALUES ('apps', 'full', 50, 50, NOW(), NOW() - interval '4 hours', NOW() - interval '4 hours')
       ON CONFLICT (limit_key) DO UPDATE
         SET refusals_since = COALESCE(platform_limit_alerts.refusals_since, NOW() - interval '4 hours'),
             refusals_notified_at = COALESCE(platform_limit_alerts.refusals_notified_at, NOW() - interval '4 hours')`
    );
    for (const person of refusals) {
      await pool.query(
        `INSERT INTO platform_limit_refusals (limit_key, user_id, day, refused_at)
         VALUES ('apps', $1, (NOW() AT TIME ZONE 'UTC')::date, NOW() - interval '2 hours')
         ON CONFLICT DO NOTHING`,
        [person.id]
      );
    }
    // The bell's two notices, as the code writes them: the first refusal of
    // the run, then a count a few hours later. The shots pair's own full admin
    // (services/shots-fixtures.js) is inserted AFTER boot, so a seed here
    // cannot write to it by lookup. On a shots copy only, make the row it will
    // claim, unable to sign in and not an admin; installFullAdminFixture then
    // promotes it in place. SHOTS_PHONE_TEST_CODE is set on the self app's
    // pair and never on production or an ordinary staging preview, so no
    // other copy grows this account. An ordinary staging copy still seeds the
    // notices for the administrators it has, which is what the Admin → Limits
    // card reads.
    const shotsCopy = !!require('../config').shotsPhoneTestCodeFrom(process.env).code;
    let fixtureUsername = null;
    if (shotsCopy) {
      const shotsFixtures = require('../services/shots-fixtures');
      fixtureUsername = shotsFixtures.FULL_ADMIN_USERNAME;
      await pool.query(
        `INSERT INTO users (id, username, password, is_admin, admin_readonly,
                            can_create_apps, has_platform_access)
         VALUES ($1, $2, '__shots_not_a_login__', FALSE, FALSE, FALSE, FALSE)
         ON CONFLICT DO NOTHING`,
        [shotsFixtures.FULL_ADMIN_USER_ID, fixtureUsername]
      );
    }
    const notices = [
      { detail: 'apps_away:1:50:0', minutesAgo: 4 * 60 },
      { detail: `apps_away:${refusals.length}:50:230`, minutesAgo: 10 },
    ];
    for (const notice of notices) {
      await pool.query(
        `INSERT INTO notifications (user_id, source_user_id, kind, detail, created_at)
         SELECT u.id, NULL, 'platform_limit', $1::varchar(32), NOW() - make_interval(mins => $2::int)
           FROM users u
          WHERE ((u.is_admin = TRUE AND u.admin_readonly = FALSE) OR u.username = $3)
            AND NOT EXISTS (
              SELECT 1 FROM notifications n
               WHERE n.user_id = u.id AND n.kind = 'platform_limit' AND n.detail = $1::varchar(32)
            )`,
        [notice.detail, notice.minutesAgo, fixtureUsername]
      );
    }
  } catch (err) {
    log.warn('db', 'Staging limit refusals seed failed', { message: err.message });
  }
}

// 20 Nov 2026 (live-draft review, C, G, I, J): the before & after shots
// show a private thread whose live draft is up for a vote and has one change
// not in the proposal yet: no bar under its head, its Artifacts button, and
// its preview's header with Update proposal, Close draft and where it
// stands. A fresh staging copy has no draft (one is opened by asking
// Homeroom bot, which staging has no model for), so its rows are stored:
// the shots' member fixture (usernode-capture) on the fake project
// seedStagingStorageNotices made theirs, the bot's lines as words, the
// draft's change and its proposal as paused and promoted fixture changes
// with no preview and no pull request. Nothing here is a signal the code
// reads to decide anything. Idempotent through the root message's key and
// the draft's own row; strictly a no-op outside staging.
async function seedStagingLiveDraftThread(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = await pool.query(
      "SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')",
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    const app = (await pool.query("SELECT id, slug, name FROM apps WHERE slug = 'staging-demo-recipe-box' LIMIT 1")).rows[0];
    if (!member || !bot || !app || member.id === bot.id) return;
    const low = Math.min(member.id, bot.id);
    const high = Math.max(member.id, bot.id);
    const conversationId = (await pool.query(
      'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2',
      [low, high],
    )).rows[0]?.conversation_id;
    if (!conversationId) return;
    const key = 'staging-demo-live-draft-thread';
    let rootId = (await pool.query(
      'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3',
      [conversationId, bot.id, key],
    )).rows[0]?.id;
    if (!rootId) {
      rootId = (await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, NOW() - INTERVAL '40 minutes') RETURNING id`,
        [conversationId, bot.id, `New thread, about ${app.name}.`,
          JSON.stringify({ homeroomBot: { kind: 'opened_thread', appSlug: app.slug, appName: app.name } }), key],
      )).rows[0].id;
      await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id, created_at)
         VALUES ($1, $2, 'Staging demo: can you make the recipe rows look more like a phone app''s list?', $4, NOW() - INTERVAL '39 minutes'),
                ($1, $3, 'Staging demo: done in the app''s preview: each recipe is one white row with its cooking time in grey under its name, and a chevron at the end.', $4, NOW() - INTERVAL '37 minutes'),
                ($1, $2, 'Staging demo: nice. Now the rows should line up with the search box above them.', $4, NOW() - INTERVAL '6 minutes'),
                ($1, $3, 'Staging demo: done in the app''s preview: the rows now share the search box''s left and right edges. That change is saved on the draft and is not in the proposal yet: Update proposal in the preview''s header puts it there, which clears its votes.', $4, NOW() - INTERVAL '5 minutes')`,
        [conversationId, member.id, bot.id, rootId],
      );
    }
    const thread = (await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state, title, title_source,
                                    created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'ask', 'open', 'Staging demo: recipe rows like a phone app', 'person',
               NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '5 minutes')
       ON CONFLICT (root_message_id) DO UPDATE SET updated_at = private_threads.updated_at
       RETURNING id`,
      [member.id, conversationId, rootId, app.id],
    )).rows[0];
    const had = await pool.query('SELECT id FROM live_drafts WHERE root_message_id = $1 AND user_id = $2', [rootId, member.id]);
    if (had.rows.length) {
      // Kept open on every boot: a seeded draft is never idle or over.
      await pool.query("UPDATE live_drafts SET updated_at = NOW(), live_state = 'live' WHERE id = $1", [had.rows[0].id]);
      return;
    }
    const sha = (c) => c.repeat(40);
    const change = (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, linked_issues, session_title, branch_name, last_activity_at)
       VALUES ($1, $2, 'paused', FALSE, '{}', $3, 'staging-fixture/live-draft', NOW()) RETURNING id`,
      [app.id, member.id, `Live draft of ${app.name}`],
    )).rows[0];
    const proposal = (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, linked_issues, session_title, branch_name,
                                  promoted_at, last_activity_at)
       VALUES ($1, $2, 'promoted', FALSE, '{}', 'Staging demo: recipe rows like a phone app', 'staging-fixture/live-draft-proposal',
               NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes') RETURNING id`,
      [app.id, member.id],
    )).rows[0];
    const draft = (await pool.query(
      `INSERT INTO live_drafts (app_id, user_id, private_thread_id, root_message_id, session_id, state, base_sha, head_sha,
                                edits, live_state, proposal_session_id, proposed_head_sha, proposed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'proposed', $6, $7, 2, 'live', $8, $9, NOW() - INTERVAL '30 minutes',
               NOW() - INTERVAL '40 minutes', NOW())
       RETURNING id`,
      [app.id, member.id, thread.id, rootId, change.id, sha('a'), sha('c'), proposal.id, sha('b')],
    )).rows[0];
    await pool.query(
      `INSERT INTO live_draft_edits (draft_id, commit_sha, summary, paths, created_at)
       VALUES ($1, $2, 'Staging demo: recipe rows as one list with grey cooking times', ARRAY['public/index.html'], NOW() - INTERVAL '37 minutes'),
              ($1, $3, 'Staging demo: rows line up with the search box', ARRAY['public/index.html'], NOW() - INTERVAL '5 minutes')`,
      [draft.id, sha('b'), sha('c')],
    );
  } catch (err) {
    log.warn('db', 'Staging live draft thread seeding failed', { message: err.message });
  }
}

async function seedStagingStorageNotices(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!people.rows.length) return seedSkipped('no user usernode-capture');
    const memberId = people.rows[0].id;
    const projects = [
      {
        id: 900096, name: 'Staging demo: recipe box', slug: 'staging-demo-recipe-box',
        bytes: 2684354560, warnLevel: 2, detail: 'storage_warn:2560:3072', minutesAgo: 8,
      },
      {
        id: 900095, name: 'Staging demo: spice shelf', slug: 'staging-demo-spice-shelf',
        bytes: 1717567488, warnLevel: 1, detail: 'storage_early:1638:3072', minutesAgo: 3 * 24 * 60,
      },
    ];
    for (const project of projects) {
      const app = await pool.query(
        `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by,
                           db_size_bytes, db_size_measured_at, db_storage_warned_at, db_storage_warn_level)
         VALUES ($1::int, $2::text, $3::text, 'running', 'members', 'private', $4::int,
                 $5::bigint, NOW() - make_interval(mins => $6::int),
                 CASE WHEN $7::int >= 2 THEN NOW() - make_interval(mins => $6::int) END, $7::int)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [project.id, project.name, project.slug, memberId, project.bytes, project.minutesAgo, project.warnLevel],
      );
      const appId = app.rows[0]?.id || (await pool.query(
        'SELECT id FROM apps WHERE id = $1', [project.id],
      )).rows[0]?.id;
      if (!appId) continue;
      // The bell lists a private project's row only for someone who can still
      // open that project (services/notifications.js APP_ACCESS_SQL: public,
      // an admin, or an app_collaborators member). A project's INSERT mints
      // its community but joins nobody to it, and a community membership is
      // not what this check reads, so the creator's own collaborator row is
      // written here, which also puts them in that community by trigger.
      await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
         VALUES ($1::int, $2::int, 'member', NOW())
         ON CONFLICT (app_id, user_id) DO NOTHING`,
        [appId, memberId],
      );
      await pool.query(
        `INSERT INTO notifications
           (user_id, app_id, source_user_id, kind, detail, read_at, created_at)
         SELECT $1::int, $2::int, NULL, 'app_health', $3::varchar, NULL,
                NOW() - make_interval(mins => $4::int)
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications n
             WHERE n.user_id = $1 AND n.app_id = $2
               AND n.kind = 'app_health' AND n.detail = $3::varchar
          )`,
        [memberId, appId, project.detail, project.minutesAgo],
      );
    }
  } catch (err) {
    log.warn('db', 'Staging storage notice seeding failed', { message: err.message });
  }
}

// #6271 (4 Nov 2026): a private thread marked done now stays under Live this
// week for a week. A fresh staging copy has no private thread with the bot,
// and staging has no model to make one, so this seeds one already closed,
// with the bot's reply stored. Rows for the shots' own member fixture
// (usernode-capture) only; nothing here is a signal the bot reads to decide
// anything. Idempotent through the root message's idempotency key and the
// private thread's unique root; strictly a no-op outside staging.
async function seedStagingClosedPrivateThread(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const people = await pool.query(
      `SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')`,
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    if (!member || !bot || member.id === bot.id) return;
    const low = Math.min(member.id, bot.id);
    const high = Math.max(member.id, bot.id);
    const found = await pool.query(
      'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2',
      [low, high],
    );
    let conversationId = found.rows[0]?.conversation_id;
    if (!conversationId) {
      const created = await pool.query(
        'INSERT INTO conversations (kind, created_by) VALUES (\'direct\', $1) RETURNING id',
        [member.id],
      );
      conversationId = created.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, low, high],
      );
    }
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'member'), ($1, $3, 'member', 'member')
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET status = 'member'`,
      [conversationId, member.id, bot.id],
    );
    const key = 'staging-demo-closed-private-thread';
    const had = await pool.query(
      'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3',
      [conversationId, member.id, key],
    );
    let rootId = had.rows[0]?.id;
    if (!rootId) {
      const root = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, idempotency_key, created_at)
         VALUES ($1, $2, 'Staging demo: a private thread marked done this week', $3, NOW() - INTERVAL '2 days')
         RETURNING id`,
        [conversationId, member.id, key],
      );
      rootId = root.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id, created_at)
         VALUES ($1, $2, 'Staging demo: kept here for a week so it can be reopened.', $3, NOW() - INTERVAL '2 days')`,
        [conversationId, bot.id, rootId],
      );
    }
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const appId = apps.rows[0]?.id || null;
    await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state, done_at, done_from)
       VALUES ($1, $2, $3, $4, 'idea', 'done', NOW() - INTERVAL '2 days', 'open')
       ON CONFLICT (root_message_id) DO NOTHING`,
      [member.id, conversationId, rootId, appId],
    );
  } catch (err) {
    log.warn('db', 'Staging closed private thread seeding failed', { message: err.message });
  }
}

// 24 Nov 2026: a private thread with Homeroom bot fills the bot tab's column
// whatever its length, with its reply box at the bottom (app.css, "A PRIVATE
// THREAD KEEPS ITS BOX AT THE FOOT"). A fresh staging copy's private threads
// with the bot are each about something else (a filed report, a design, a
// first version), and staging has no model to start a plain one, so this
// seeds one that is open and short: the shots' member fixture's
// (usernode-capture) question and the bot's reply, stored, under a title
// that says what it is. Nothing here is a signal the bot reads to decide
// anything. Idempotent through the root message's idempotency key and the
// private thread's unique root; strictly a no-op outside staging.
async function seedStagingShortPrivateThread(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const people = await pool.query(
      `SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')`,
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    if (!member || !bot || member.id === bot.id) return;
    const low = Math.min(member.id, bot.id);
    const high = Math.max(member.id, bot.id);
    const found = await pool.query(
      'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2',
      [low, high],
    );
    let conversationId = found.rows[0]?.conversation_id;
    if (!conversationId) {
      const created = await pool.query(
        'INSERT INTO conversations (kind, created_by) VALUES (\'direct\', $1) RETURNING id',
        [member.id],
      );
      conversationId = created.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, low, high],
      );
    }
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'member'), ($1, $3, 'member', 'member')
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET status = 'member'`,
      [conversationId, member.id, bot.id],
    );
    const key = 'staging-demo-short-private-thread';
    const had = await pool.query(
      'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3',
      [conversationId, member.id, key],
    );
    let rootId = had.rows[0]?.id;
    if (!rootId) {
      const root = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, idempotency_key, created_at)
         VALUES ($1, $2, 'Staging demo: where does the reply box sit in a short thread?', $3, NOW() - INTERVAL '20 minutes')
         RETURNING id`,
        [conversationId, member.id, key],
      );
      rootId = root.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id, created_at)
         VALUES ($1, $2, 'Staging demo: a stored reply. This thread holds two messages, so it is a short one.', $3, NOW() - INTERVAL '19 minutes')`,
        [conversationId, bot.id, rootId],
      );
    }
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const appId = apps.rows[0]?.id || null;
    await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state, title, title_source)
       VALUES ($1, $2, $3, $4, 'idea', 'open', 'Staging demo: a short private thread', 'person')
       ON CONFLICT (root_message_id) DO NOTHING`,
      [member.id, conversationId, rootId, appId],
    );
  } catch (err) {
    log.warn('db', 'Staging short private thread seeding failed', { message: err.message });
  }
}

// 13 Nov 2026: a private thread about a change is finished with its change
// (services/ai-work.js ABOUT_CHANGE_END_SQL): once the change is live or
// closed the thread leaves Needs you and History lists it. A fresh staging
// copy has no private thread about a change, so this seeds one for the
// shots' member fixture (usernode-capture), about the fake change
// seedStagingMergedVoteRow has already put live, opened and written in the
// day before it went live. Staging has no model, so the bot's lines are
// stored. Nothing here is a signal the bot reads to decide anything.
// Idempotent through the root message's key and the private thread's unique
// root; strictly a no-op outside staging.
async function seedStagingLiveChangePrivateThread(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const changes = await pool.query(
      `SELECT cs.app_id, cs.pr_number, cs.thread_id, cs.live_at, a.slug, a.name,
              COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, '')) AS title
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
        WHERE cs.branch_name = 'staging-fixture/merged-vote-row' AND cs.status = 'merged'
          AND cs.live_at IS NOT NULL AND cs.pr_number IS NOT NULL
        ORDER BY cs.id DESC LIMIT 1`,
    );
    const change = changes.rows[0];
    const people = await pool.query(
      `SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')`,
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    if (!change || !member || !bot || member.id === bot.id) return;
    const low = Math.min(member.id, bot.id);
    const high = Math.max(member.id, bot.id);
    const found = await pool.query(
      'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2',
      [low, high],
    );
    const conversationId = found.rows[0]?.conversation_id;
    // The seeds above made their chat; without it there is nothing to hang a thread on.
    if (!conversationId) return;
    const key = 'staging-demo-live-change-private-thread';
    const had = await pool.query(
      'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3',
      [conversationId, bot.id, key],
    );
    let rootId = had.rows[0]?.id;
    if (!rootId) {
      // The bot's line in Main the thread hangs off, as startAbout writes it
      // (services/private-threads.js aboutLine and its metadata).
      const root = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz - INTERVAL '1 day')
         RETURNING id`,
        [
          conversationId, bot.id,
          `New thread about change #${Number(change.pr_number)} ${change.title || 'Staging demo change'}. Only you can see it.`,
          JSON.stringify({ homeroomBot: {
            kind: 'opened_about', appSlug: change.slug, appName: change.name || change.slug,
            aboutKind: 'change', aboutNumber: Number(change.pr_number),
            ...(change.title ? { aboutTitle: change.title } : {}),
          } }),
          key, change.live_at,
        ],
      );
      rootId = root.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id, created_at)
         VALUES ($1, $2, 'Staging demo: does this list keep the books I finished?', $4, $5::timestamptz - INTERVAL '1 day' + INTERVAL '1 minute'),
                ($1, $3, 'Staging demo: yes, finished books stay on the list, at the end.', $4, $5::timestamptz - INTERVAL '1 day' + INTERVAL '2 minutes')`,
        [conversationId, member.id, bot.id, rootId, change.live_at],
      );
    }
    await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state,
                                    about_thread_id, about_kind, about_number, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'ask', 'open', $5, 'change', $6,
               $7::timestamptz - INTERVAL '1 day', $7::timestamptz - INTERVAL '1 day')
       ON CONFLICT (root_message_id) DO NOTHING`,
      [member.id, conversationId, rootId, change.app_id, change.thread_id, change.pr_number, change.live_at],
    );
  } catch (err) {
    log.warn('db', 'Staging live change private thread seeding failed', { message: err.message });
  }
}

// 15 Nov 2026: a first version's thread that starts on an older message.
// Until 14 Nov 2026 a first version's news was a line of Main Chat. The move
// to threads (services/earlier-chat.js) listed each such line people had
// answered as the first message of a thread of its own, "<Project>, first
// version". That first message carries `firstVersion: true`, which the
// client read as "the project's hub" (features/messages/request-page.ts),
// so the thread closed as it opened and the hub came up in its place. A
// fresh staging copy's first-version thread starts on the bot's "setting it
// up" line, which never did that, so this seeds one of the older shape for
// the shots' member fixture (usernode-capture): the "live" line as the bot
// wrote it then, a question of theirs and the bot's answer under it, on the
// fake project seedStagingStorageNotices made theirs. Staging has no model,
// so the bot's lines are stored. Nothing here is a signal the bot reads to
// decide anything. Idempotent through the first message's key and the
// private thread's unique root; strictly a no-op outside staging.
async function seedStagingOlderFirstVersionThread(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = await pool.query(
      `SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')`,
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    const apps = await pool.query(`SELECT id, slug, name FROM apps WHERE slug = 'staging-demo-recipe-box'`);
    const app = apps.rows[0];
    if (!member || !bot || !app || member.id === bot.id) return;
    const found = await pool.query(
      'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2',
      [Math.min(member.id, bot.id), Math.max(member.id, bot.id)],
    );
    const conversationId = found.rows[0]?.conversation_id;
    // The seeds above made their chat; without it there is nothing to hang a thread on.
    if (!conversationId) return;
    const key = 'staging-demo-older-first-version-thread';
    const had = await pool.query(
      'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3',
      [conversationId, bot.id, key],
    );
    let rootId = had.rows[0]?.id;
    if (!rootId) {
      const name = app.name || app.slug;
      // The line that told its maker their first version was live, as the
      // bot sent it into Main Chat (services/homeroom-bot-dm.js requestLine
      // and mergedText, and the metadata its senders stamp).
      const root = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, NOW() - INTERVAL '20 days')
         RETURNING id`,
        [
          conversationId, bot.id,
          `**${name}**, its first version\n\nYour first version is live. Open ${name} to try it.`,
          JSON.stringify({ homeroomBot: {
            kind: 'merged', appSlug: app.slug, appName: name, issueNumber: 1, firstVersion: true, live: true,
          } }),
          key,
        ],
      );
      rootId = root.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id, created_at)
         VALUES ($1, $2, 'Staging demo: can it sort the recipes by how long they take?', $4, NOW() - INTERVAL '20 days' + INTERVAL '5 minutes'),
                ($1, $3, 'Staging demo: not yet. Ask for it as a change to the project and I will build it.', $4, NOW() - INTERVAL '20 days' + INTERVAL '6 minutes')`,
        [conversationId, member.id, bot.id, rootId],
      );
    }
    // Read, as a thread from weeks ago is: it opens calm.
    await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state,
                                    last_read_message_id, created_at, updated_at)
       SELECT $1, $2, $3, $4, 'first_version', 'open',
              (SELECT MAX(m.id) FROM conversation_messages m WHERE m.id = $3 OR m.thread_root_id = $3),
              NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days'
       ON CONFLICT (root_message_id) DO NOTHING`,
      [member.id, conversationId, rootId, app.id],
    );
  } catch (err) {
    log.warn('db', 'Staging older first version thread seeding failed', { message: err.message });
  }
}

// 18 Nov 2026 (request #6803): a project's first version being built, in its
// maker's thread with Homeroom bot. Its plan was answered with Build it, so
// the plan card there carries "We'll tell you when it's live" and, under
// that switch, the way to watch the build (features/messages/bot-plan.tsx
// notifyFooter). No staging copy reaches that state: the demo chat's plants
// thread still waits for Build it, its built plan names no project to watch,
// and a fresh copy never has the bot mid-build. So this seeds one for the
// shots' member fixture (usernode-capture): an obviously fake project of
// theirs, its first version's request and the build under way, the thread's
// three messages, and the records the activity read needs to say the card is
// still working (homeroom_bot_dm_messages, a ready run whose build has
// started). Staging has no model, so the bot's lines are stored. Nothing here
// is a signal the app reads to decide what to show beyond the state itself.
// Idempotent through the project's fixed id, each message's key and the
// private thread's unique root; strictly a no-op outside staging.
const STAGING_BUILDING_FIRST_VERSION = Object.freeze({
  appId: 900156,
  slug: 'staging-demo-seed-packets',
  name: 'Staging demo: seed packets',
  issueNumber: 1,
});

async function seedStagingFirstVersionBuildingThread(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const fixture = STAGING_BUILDING_FIRST_VERSION;
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const people = await pool.query(
      `SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')`,
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    if (!member || !bot || member.id === bot.id) return;
    // The fake project, theirs: a project's INSERT mints its community, and
    // their own collaborator row is what lets them open it (and puts them in
    // that community by trigger), as seedStagingStorageNotices writes it.
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES ($1::int, $2::text, $3::text, 'running', 'members', 'private', $4::int)
       ON CONFLICT (id) DO NOTHING`,
      [fixture.appId, fixture.name, fixture.slug, member.id],
    );
    const app = await pool.query('SELECT id, slug, name FROM apps WHERE id = $1', [fixture.appId]);
    if (!app.rows.length) return;
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
       VALUES ($1::int, $2::int, 'member', NOW())
       ON CONFLICT (app_id, user_id) DO NOTHING`,
      [fixture.appId, member.id],
    );
    // Its first version is theirs, so the "We'll tell you when it's live"
    // switch above the button is drawn (services/homeroom-bot-dm.js
    // firstVersionNotify: the maker's own only).
    await pool.query(
      `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number, filed_at)
       VALUES ($1::int, $2::int, 'Staging demo: obviously fake, a box of seed packets sorted by when to sow them.', 'filed', $3::int, NOW() - INTERVAL '40 minutes')
       ON CONFLICT (app_id) DO NOTHING`,
      [fixture.appId, member.id, fixture.issueNumber],
    );
    const title = 'First version of Staging demo: seed packets';
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, $3, 'Staging demo: obviously fake.', $4, NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '40 minutes'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [fixture.appId, fixture.issueNumber, title, member.id],
    );
    // The build under way, as a started one is: its session taken and its
    // turn the build's, so where it stands reads "Building it"
    // (services/homeroom-bot-progress.js stageOf, build_turn_mode) and its
    // card is working (homeroom-bot-activity.js buildUnderWay). Its moment is
    // after its card's begin, which is how the read pairs a run with the card
    // it follows (cardRows: created_at >= the card's).
    const branch = 'staging-fixture/first-version-building';
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, session_title, status, linked_issues,
                                  active_turn, created_at, last_activity_at)
       SELECT $1::int, $2::int, $3::varchar, 'First version of Staging demo: seed packets', 'active', ARRAY[$4]::int[],
              jsonb_build_object('mode', 'build',
                                 'startedAt', to_char(NOW() - INTERVAL '32 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
              NOW() - INTERVAL '32 minutes', NOW() - INTERVAL '2 minutes'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE app_id = $1::int AND branch_name = $3::varchar)`,
      [fixture.appId, member.id, branch, fixture.issueNumber],
    );
    const build = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 ORDER BY id LIMIT 1',
      [fixture.appId, branch],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id, created_at)
       SELECT $1, $2, 'live', 'ready', $3, NOW() - INTERVAL '32 minutes'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = $2 AND mode = 'live')`,
      [fixture.appId, fixture.issueNumber, build.rows[0]?.id || null],
    );
    const run = await pool.query(
      `SELECT id FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' ORDER BY id LIMIT 1`,
      [fixture.appId, fixture.issueNumber],
    );
    const runId = run.rows[0]?.id || null;
    // Their chat with the bot, made here when no seed above made it.
    const low = Math.min(member.id, bot.id);
    const high = Math.max(member.id, bot.id);
    const found = await pool.query(
      'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2',
      [low, high],
    );
    let conversationId = found.rows[0]?.conversation_id;
    if (!conversationId) {
      const created = await pool.query(
        'INSERT INTO conversations (kind, created_by) VALUES (\'direct\', $1) RETURNING id',
        [member.id],
      );
      conversationId = created.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, low, high],
      );
    }
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'member'), ($1, $3, 'member', 'member')
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET status = 'member'`,
      [conversationId, member.id, bot.id],
    );
    const rootKey = 'staging-demo-first-version-building';
    const had = await pool.query(
      'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3',
      [conversationId, bot.id, rootKey],
    );
    let rootId = had.rows[0]?.id;
    if (!rootId) {
      const root = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, NOW() - INTERVAL '40 minutes')
         RETURNING id`,
        [
          conversationId, bot.id,
          `**${fixture.name}**\n\nThanks! I'm setting up ${fixture.name} now. `
            + 'Once it\'s ready I\'ll send you my plan here first, then build its first version and tell you here when it\'s live.',
          JSON.stringify({ homeroomBot: {
            kind: 'first_version_started', appSlug: fixture.slug, appName: fixture.name,
          } }),
          rootKey,
        ],
      );
      rootId = root.rows[0].id;
      // The card the plan hangs off (drawn only as the plan's step, planLayout),
      // and the plan its maker answered with Build it, both in the thread.
      const card = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id, metadata, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW() - INTERVAL '35 minutes')
         RETURNING id`,
        [
          conversationId, bot.id,
          `**${fixture.name}** · request #${fixture.issueNumber}\n\n`
            + 'I\'m working on the first version now. This card updates as I go.',
          rootId,
          JSON.stringify({ homeroomBot: {
            kind: 'activity', appSlug: fixture.slug, appName: fixture.name,
            issueNumber: fixture.issueNumber, firstVersion: true,
          } }),
          'staging-demo-first-version-building-card',
        ],
      );
      const plan = {
        bullets: [
          'Staging demo: a box of seed packets, sorted by when to sow each one',
          'A Today view of what to sow now, and what is next',
          'Tap a packet to mark it sown; the list moves on by itself',
        ],
        questions: [{ question: 'How should the packets be sorted?', answers: ['By when to sow', 'By plant name'] }],
      };
      const planMessage = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id, metadata, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW() - INTERVAL '25 minutes')
         RETURNING id`,
        [
          conversationId, bot.id,
          `Here's my plan for **${fixture.name}**:\n\n${plan.bullets.map((b) => `- ${b}`).join('\n')}`
            + '\n\nOne choice for you, or I\'ll go with what I suggest.\n\nTap Build it when it looks right, or Change something.',
          rootId,
          JSON.stringify({ homeroomBot: {
            kind: 'plan', appSlug: fixture.slug, appName: fixture.name,
            issueNumber: fixture.issueNumber, firstVersion: true, plan,
            status: 'answered', chosen: 'build', answer: 'Build it',
            choices: [plan.questions[0].answers[0]],
          } }),
          'staging-demo-first-version-building-plan',
        ],
      );
      // What the bot records about its own messages, which the activity read
      // joins (services/homeroom-bot-activity.js cardRows): the card, and the
      // plan it answered.
      await pool.query(
        `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id)
         VALUES ($1, $2, $3, $4, $5, 'activity', $6), ($7, $2, $3, $4, $5, 'plan', $6)
         ON CONFLICT (message_id) DO NOTHING`,
        [card.rows[0].id, member.id, conversationId, fixture.appId, fixture.issueNumber, runId, planMessage.rows[0].id],
      );
    }
    // Read, as a thread from a while ago is: it opens calm.
    await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state,
                                    last_read_message_id, created_at, updated_at)
       SELECT $1, $2, $3, $4, 'first_version', 'open',
              (SELECT MAX(m.id) FROM conversation_messages m WHERE m.id = $3 OR m.thread_root_id = $3),
              NOW() - INTERVAL '35 minutes', NOW() - INTERVAL '25 minutes'
       ON CONFLICT (root_message_id) DO NOTHING`,
      [member.id, conversationId, rootId, fixture.appId],
    );
  } catch (err) {
    log.warn('db', 'Staging building first version thread seeding failed', { message: err.message });
  }
}

// #6816's shots: Home's card beside Pinned apps lists the viewer's recent
// threads, as many as fit, and when some do not fit its last row says how
// many more there are and opens the whole list. A fresh staging copy holds a
// handful of threads for the shots' member fixture (usernode-capture) and
// they all fit beside Pinned apps, so the "N more" row is a state no copy can
// reach. This seeds ten requests filed by them, spread over the last ten
// days, on one obviously fake project of their own: each request joins a
// thread of its own (requests_attach_thread), so the card has more to list
// than a column can hold. Nothing here is a signal the app reads to decide
// what to show beyond being the threads it lists. Idempotent through the
// project's fixed id and each request's number; strictly a no-op outside
// staging.
const STAGING_RECENT_THREADS = Object.freeze({
  appId: 900157,
  slug: 'staging-demo-kite-log',
  name: 'Staging demo: kite log',
  firstNumber: 990601,
});

/** Each obviously fake request's title, with how many minutes ago it was filed, newest first. */
const STAGING_RECENT_THREAD_TITLES = Object.freeze([
  ['Staging demo: log a kite by its colour', 20],
  ['Staging demo: count how many kites flew today', 95],
  ['Staging demo: add a picture to a kite\'s entry', 260],
  ['Staging demo: list the windiest afternoons', 700],
  ['Staging demo: share a kite with a friend', 1500],
  ['Staging demo: remind me to fly on a Sunday', 2900],
  ['Staging demo: sort kites by how high they flew', 4300],
  ['Staging demo: hide kites I have given away', 6100],
  ['Staging demo: name the field I fly from', 9000],
  ['Staging demo: export my kite log', 13000],
]);

async function seedStagingRecentThreads(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const fixture = STAGING_RECENT_THREADS;
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!people.rows.length) return seedSkipped('no user usernode-capture');
    const memberId = people.rows[0].id;
    // The fake project, theirs: a project's INSERT mints its community, and
    // their own collaborator row is what lets them open it (and puts them in
    // that community by trigger), as seedStagingStorageNotices writes it.
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES ($1::int, $2::text, $3::text, 'running', 'members', 'private', $4::int)
       ON CONFLICT (id) DO NOTHING`,
      [fixture.appId, fixture.name, fixture.slug, memberId],
    );
    const app = await pool.query('SELECT id FROM apps WHERE id = $1', [fixture.appId]);
    if (!app.rows.length) return;
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
       VALUES ($1::int, $2::int, 'member', NOW())
       ON CONFLICT (app_id, user_id) DO NOTHING`,
      [fixture.appId, memberId],
    );
    for (const [index, [title, minutesAgo]] of STAGING_RECENT_THREAD_TITLES.entries()) {
      const number = fixture.firstNumber + index;
      await pool.query(
        `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
         SELECT $1::int, $2::int, $3::text, 'Staging demo: obviously fake.', $4::int,
                NOW() - make_interval(mins => $5::int), NOW() - make_interval(mins => $5::int - 5)
          WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1::int AND number = $2::int)`,
        [fixture.appId, number, title, memberId, minutesAgo],
      );
      // The request's trigger made its thread just now (requests_attach_thread),
      // and a thread's creation counts as its last activity: without this the
      // ten would all read "just now" and sort by id. Its request's own moment
      // is when it started, so the thread takes that.
      await pool.query(
        `UPDATE threads t
            SET created_at = r.created_at
           FROM requests r
          WHERE r.app_id = $1::int AND r.number = $2::int
            AND t.id = r.thread_id AND t.created_at <> r.created_at`,
        [fixture.appId, number],
      );
    }
  } catch (err) {
    log.warn('db', 'Staging recent threads seeding failed', { message: err.message });
  }
}

// #6566 (10 Nov 2026): the Homeroom bot's reply after it files a problem
// report now gives the report's number and its card, and asking for the
// link answers with the report already filed. A staging copy has no model,
// so this writes both replies as stored messages in a private thread about
// Homeroom, for the shots' member fixture (usernode-capture). Idempotent
// through the root message's key; strictly a no-op outside staging.
async function seedStagingBotReportReply(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const people = await pool.query(
      `SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')`,
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    if (!member || !bot || member.id === bot.id) return;
    const low = Math.min(member.id, bot.id);
    const high = Math.max(member.id, bot.id);
    const found = await pool.query(
      'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2',
      [low, high],
    );
    let conversationId = found.rows[0]?.conversation_id;
    if (!conversationId) {
      const created = await pool.query(
        'INSERT INTO conversations (kind, created_by) VALUES (\'direct\', $1) RETURNING id',
        [member.id],
      );
      conversationId = created.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, low, high],
      );
    }
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'member'), ($1, $3, 'member', 'member')
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET status = 'member'`,
      [conversationId, member.id, bot.id],
    );
    const key = 'staging-demo-bot-report-reply';
    const had = await pool.query(
      'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3',
      [conversationId, member.id, key],
    );
    let rootId = had.rows[0]?.id;
    if (!rootId) {
      const root = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, idempotency_key, created_at)
         VALUES ($1, $2, 'Staging demo: neither works, I have to kill the app', $3, NOW() - INTERVAL '1 day')
         RETURNING id`,
        [conversationId, member.id, key],
      );
      rootId = root.rows[0].id;
      const filed = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id, created_at)
         VALUES ($1, $2, 'Filed as #6564 in Homeroom''s Workshop, where anyone can read it; the last few messages of this chat went only to the team, privately.', $3, NOW() - INTERVAL '1 day')
         RETURNING id`,
        [conversationId, bot.id, rootId],
      );
      await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id, created_at)
         VALUES ($1, $2, 'can you give me a link to it?', $3, NOW() - INTERVAL '1 day' + INTERVAL '1 minute')`,
        [conversationId, member.id, rootId],
      );
      const again = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id, created_at)
         VALUES ($1, $2, 'Already filed as #6564 in Homeroom''s Workshop. Nothing new was filed.', $3, NOW() - INTERVAL '1 day' + INTERVAL '2 minutes')
         RETURNING id`,
        [conversationId, bot.id, rootId],
      );
      // The report's card, as the bot's reply carries it: a request on
      // Homeroom's own board.
      const platform = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
      const platformId = platform.rows[0]?.id;
      if (platformId) {
        for (const messageId of [filed.rows[0].id, again.rows[0].id]) {
          await pool.query(
            `INSERT INTO conversation_message_objects (message_id, position, object_type, app_id, object_ref)
             VALUES ($1, 0, 'github_issue', $2, 6564) ON CONFLICT (message_id, position) DO NOTHING`,
            [messageId, platformId],
          );
        }
      }
      await pool.query(
        `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state)
         VALUES ($1, $2, $3, $4, 'idea', 'open')
         ON CONFLICT (root_message_id) DO NOTHING`,
        [member.id, conversationId, rootId, platformId || null],
      );
    }
  } catch (err) {
    log.warn('db', 'Staging bot report reply seeding failed', { message: err.message });
  }
}

// #6581 (11 Nov 2026): a failure note with new words, or one somebody has
// replied under, stays as it was posted and the new note goes below it. A
// staging copy runs no build, so this seeds the after state for the shots:
// a request whose build failed twice, with the shots' member fixture
// (usernode-capture) answering under the first note. Obviously fake,
// idempotent by request number and its stagingDemo marks, and a no-op
// outside staging. Nothing here is a signal the bot decides on.
async function seedStagingBotFailureNotes(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query(
      `SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')`,
    );
    const appId = apps.rows[0]?.id;
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    if (!appId || !member || !bot || member.id === bot.id) return;
    const number = 9116;
    const title = 'Staging demo: a request whose build failed twice';
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, $3, 'Staging demo: obviously fake. Its build failed, so the bot said so.', $4, NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [appId, number, title, member.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
       VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, issue_number) DO NOTHING`,
      [appId, number, member.id, title],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, error, created_at)
       SELECT $1, $2, 'live', 'failed', 'Staging demo: the build took longer than it is allowed.', NOW() - INTERVAL '2 hours'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs
                           WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND verdict = 'failed')`,
      [appId, number],
    );
    const note = async (mark, userId, content, minutesAgo) => pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
       SELECT $1, $2, $3, 'message', 'issue', $4, $5, NOW() - ($6::int * INTERVAL '1 minute')
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $4
                             AND metadata->>'stagingDemo' = $7)`,
      [appId, userId, content, number, JSON.stringify({ stagingDemo: mark }), minutesAgo, mark],
    );
    await note(
      'failure-note-1', bot.id,
      'I couldn\'t finish building this: something went wrong during the build. Reply here and it will try again.',
      120,
    );
    await note('failure-reply', member.id, 'Staging demo: could it be the deployment step?', 90);
    // What the change does: a failure that says something different is a new
    // note below the one that was answered, never a rewrite of it.
    await note(
      'failure-note-2', bot.id,
      'I couldn\'t finish building this: the build took longer than it\'s allowed. Reply here and it will try again.',
      30,
    );
  } catch (err) {
    log.warn('db', 'Staging bot failure notes seeding failed', { message: err.message });
  }
}

// #6426 (6 Nov 2026): Main Chat's "Welcome back" card shows after 8 hours
// away. A fresh staging copy has no visit recorded yet, so this gives the
// shots' member fixture (usernode-capture) an old one in their chat with
// Homeroom bot, made of a message so the transcript is not empty. Idempotent
// through `last_visit_at IS NULL`: a real visit already recorded is kept.
// Strictly a no-op outside staging.
async function seedStagingMainChatLastVisit(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const people = await pool.query(
      `SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')`,
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    if (!member || !bot || member.id === bot.id) return;
    const low = Math.min(member.id, bot.id);
    const high = Math.max(member.id, bot.id);
    const found = await pool.query(
      'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2',
      [low, high],
    );
    let conversationId = found.rows[0]?.conversation_id;
    if (!conversationId) {
      const created = await pool.query(
        'INSERT INTO conversations (kind, created_by) VALUES (\'direct\', $1) RETURNING id',
        [member.id],
      );
      conversationId = created.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, low, high],
      );
    }
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'member'), ($1, $3, 'member', 'member')
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET status = 'member'`,
      [conversationId, member.id, bot.id],
    );
    const said = await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, idempotency_key, created_at)
       VALUES ($1, $2, 'Staging demo: anything else?', 'staging-demo-main-chat-caught-up', NOW() - INTERVAL '2 days')
       ON CONFLICT DO NOTHING RETURNING id`,
      [conversationId, bot.id],
    );
    if (said.rows[0]?.id) {
      await pool.query(
        `UPDATE conversation_members SET last_read_message_id = $1
          WHERE conversation_id = $2 AND user_id = $3 AND last_read_message_id IS NULL`,
        [said.rows[0].id, conversationId, member.id],
      );
    }
    await pool.query(
      `UPDATE conversation_members SET last_visit_at = NOW() - INTERVAL '1 day'
        WHERE conversation_id = $1 AND user_id = $2 AND last_visit_at IS NULL`,
      [conversationId, member.id],
    );
  } catch (err) {
    log.warn('db', 'Staging Main Chat last visit seeding failed', { message: err.message });
  }
}

// #6228 (3 Nov 2026): the thread's status line and the track card after a
// person replies on a request the bot handed back. A fresh staging copy has
// no such request, so this seeds one on a request page staging can open (a
// mock issue, stagingMockIssues), handed back to a person, with the reply
// the shots' member fixture (usernode-capture) wrote on it and an unstarted
// queue row so the read still waits when the shots run (a reply alone stops
// reading as waiting after REPLY_WAIT_MS). Obviously fake, idempotent, and a
// no-op outside staging: a staging copy never acts on its queue.
async function seedStagingBotReplyWaiting(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!apps.rows.length || !people.rows.length) return seedSkipped('no self-hosted project or no user usernode-capture');
    const appId = apps.rows[0].id;
    const userId = people.rows[0].id;
    const number = 900002;
    const title = 'Staging demo: a request the bot handed back';
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, $3, 'Staging demo: obviously fake.', $4, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [appId, number, title, userId],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
       VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, issue_number) DO NOTHING`,
      [appId, number, userId, title],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, reason, created_at)
       SELECT $1, $2, 'live', 'person', 'Staging demo: a person must decide which of the two columns to keep.', NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs
                           WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' AND verdict = 'person')`,
      [appId, number],
    );
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
       SELECT $1, $2, 'Staging demo: yep, go ahead.', 'message', 'issue', $3, NOW() - INTERVAL '30 seconds'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $3
                             AND user_id = $2 AND msg_type = 'message' AND deleted_at IS NULL
                             AND content = 'Staging demo: yep, go ahead.')`,
      [appId, userId, number],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, requested_by, enqueued_at)
       SELECT $1, $2, 2, 'refresh', $3, NOW() - INTERVAL '20 seconds'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2)`,
      [appId, number, userId],
    );
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot reply-waiting seeding failed', { message: err.message });
  }
}

// #6207/#6210 (3 Nov 2026): a plan of Homeroom bot's waiting for Build it is
// a ▷ row on the Homeroom bot page that opens its request's page, where the
// plan is drawn for everyone with its Build it. A fresh staging copy has no
// such plan, so the before & after shots get one, obviously fake, for the
// shots' member fixture (usernode-capture) as its requester. Its card text is
// the plan's own (#6220). Nothing here is a signal the bot decides on, and a
// staging copy never acts on its queue. Idempotent by project, request
// number and run; a no-op outside staging.
//
// #7236: the plan is also what draws the amber "waiting for your OK" chip on
// a request card, and a card is only on a board whose list a seed's row can
// reach. Homeroom's own project lists GitHub's issues, never a seeded
// request, so the plan lives in a project of the member's own with no
// repository: on staging a project without one lists the requests stored for
// it (#7172), which is the one board a seeded card appears on. Filed just
// now, so it heads that list.
async function seedStagingBotPlanWaiting(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!people.rows.length) return seedSkipped('no user usernode-capture');
    const userId = people.rows[0].id;
    const slug = 'staging-demo-plan-waiting';
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by, icon_emoji)
       VALUES (900813, 'Staging demo: Bake sale', $1, 'running', 'private', 'private', $2, '🍪')
       ON CONFLICT DO NOTHING`,
      [slug, userId],
    );
    const app = (await pool.query('SELECT id FROM apps WHERE slug = $1', [slug])).rows[0];
    if (!app) return seedSkipped('no project staging-demo-plan-waiting');
    const appId = app.id;
    // A private project is readable by its members, and a member is a
    // collaborator row: the creator alone is not one. The row also joins the
    // member's community by trigger, so the project is one they can open.
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
       VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING`,
      [appId, userId],
    );
    const number = 9122;
    const title = 'Staging demo: the bake sale poster gets bigger type';
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, $3, 'Staging demo: obviously fake. A plan waits for its OK.', $4, NOW() - INTERVAL '1 hour', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [appId, number, title, userId],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
       VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, issue_number) DO NOTHING`,
      [appId, number, userId, title],
    );
    const plan = {
      complicated: true,
      questions: [],
      bullets: ['Staging demo: the poster\'s first line gets the larger type.'],
      card: {
        summary: 'Staging demo: the poster\'s first line gets the larger type. Nothing else changes.',
        lines: [
          { n: 1, text: 'Staging demo: "Bake sale" is set in the larger type, as it was last year.' },
          { n: null, text: 'Staging demo: the prices and the date stay as they are.' },
        ],
      },
    };
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, plan, awaiting_go_at, created_at)
       SELECT $1, $2, 'live', 'ready', $3::jsonb, NOW() - INTERVAL '50 minutes', NOW() - INTERVAL '55 minutes'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = $2 AND mode = 'live')`,
      [appId, number, JSON.stringify(plan)],
    );
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot plan seeding failed', { message: err.message });
  }
}

// #6860 (19 Nov 2026): the plan card said "Building it" for as long as its
// request stayed open, whatever became of that build (Gym Tracker #78). The
// card now says what became of the plan instead, and a fresh staging copy has
// no run whose build is over: these two, on their own request numbers 9117
// and 9118 (no mock and no other seed's), are the states the before & after
// shots need. Filed by the shots' member fixture (usernode-capture),
// obviously fake, idempotent, and strictly a no-op outside staging.
async function seedStagingBotPlanSettled(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!apps.rows.length || !people.rows.length) return seedSkipped('no self-hosted project or no user usernode-capture');
    const appId = apps.rows[0].id;
    const userId = people.rows[0].id;
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const botRow = await pool.query("SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1");
    if (!botRow.rows.length) return seedSkipped('no Homeroom bot user');
    const plan = {
      complicated: true,
      questions: [],
      bullets: ['Staging demo: the sample screen gets a sample banner.'],
      card: {
        summary: 'Staging demo: the sample screen gets a sample banner. Nothing else changes.',
        lines: [
          { n: 1, text: 'Staging demo: a sample banner sits at the top of the sample screen.' },
          { n: null, text: 'Staging demo: nothing else on the screen moves.' },
        ],
      },
    };
    const request = async (number, title) => {
      await pool.query(
        `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
         SELECT $1, $2, $3, 'Staging demo: obviously fake.', $4, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'
          WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
        [appId, number, title, userId],
      );
    };
    // Its change was closed without merging: set aside, and the card names it.
    const built = 9117;
    await request(built, 'Staging demo: a plan whose change was set aside');
    // A closed change is the workflow machine's to write, as at merge time.
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query("SELECT set_config('app.wf_writer', 'transition', true)");
      await tx.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, session_title, status, linked_issues, promoted_at, pr_number, created_at, last_activity_at)
         SELECT $1, $2, 'staging-fixture/settled-plan-aside', 'Staging demo: a plan whose change was set aside',
                'archived', ARRAY[$3]::int[], NOW() - INTERVAL '2 days', 96531, NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day'
          WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE app_id = $1 AND branch_name = 'staging-fixture/settled-plan-aside')`,
        [appId, botRow.rows[0].id, built],
      );
      await tx.query('COMMIT');
    } catch (err) {
      await tx.query('ROLLBACK');
      throw err;
    } finally { tx.release(); }
    const change = await pool.query(
      "SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = 'staging-fixture/settled-plan-aside'", [appId]);
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, plan, go_ahead_at, build_ok, proposal_session_id, created_at)
       SELECT $1, $2, 'live', 'ready', $3::jsonb, NOW() - INTERVAL '3 days', TRUE, $4, NOW() - INTERVAL '3 days'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = $2 AND mode = 'live')`,
      [appId, built, JSON.stringify(plan), change.rows[0] ? change.rows[0].id : null],
    );
    // Its build stopped: the card says so, in the page's own words.
    const stopped = 9118;
    await request(stopped, 'Staging demo: a plan whose build stopped');
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, plan, go_ahead_at, build_ok, build_error, created_at)
       SELECT $1, $2, 'live', 'ready', $3::jsonb, NOW() - INTERVAL '3 days', FALSE, 'the build ran out of steps', NOW() - INTERVAL '3 days'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = $2 AND mode = 'live')`,
      [appId, stopped, JSON.stringify(plan)],
    );
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot settled plan seeding failed', { message: err.message });
  }
}

// #6263 (4 Nov 2026): a bot-built change whose description no longer matches
// it, on a request page a fresh staging copy can open. The note under the
// summary is the state the before & after shots need; without the row there
// is no change for it to sit under. Filed by the shots' member fixture
// (usernode-capture), the change owned by homeroom_bot as a real one is;
// obviously fake, idempotent, and strictly a no-op outside staging.
async function seedStagingBotStaleDescription(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!apps.rows.length || !people.rows.length) return seedSkipped('no self-hosted project or no user usernode-capture');
    const appId = apps.rows[0].id;
    const userId = people.rows[0].id;
    const number = 900004;
    const title = 'Staging demo: a change whose description is out of date';
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const botRow = await pool.query(
      "SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1",
    );
    if (!botRow.rows.length) return seedSkipped('no Homeroom bot user');
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, $3, 'Staging demo: obviously fake.', $4, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [appId, number, title, userId],
    );
    await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, session_title, status, linked_issues, promoted_at,
          pr_summary_md, pr_summary_source, pr_summary_input_version, pr_summary_stale,
          created_at, last_activity_at)
       SELECT $1, $2, 'staging-fixture/stale-description', $3, 'promoted', ARRAY[$4]::int[], NOW() - INTERVAL '2 days',
              'Staging demo: the sample screen gets a sample banner. This text describes the first version of the change, not what it does now.',
              'author', 1, TRUE, NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE app_id = $1 AND branch_name = 'staging-fixture/stale-description')`,
      [appId, botRow.rows[0].id, title, number],
    );
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot stale-description seeding failed', { message: err.message });
  }
}

// #6421's shots: a change for requests in several threads, gathered into one
// thread with each requester's consent. A fresh staging copy has none of it.
// The Homeroom project's thread #6207 holds nine requests (ten with #6212,
// which sits in its own thread with the consent question still waiting for
// its requester, sam), Change #6223 closes three of them, every message keeps
// its request's tag, and the AI tab has one row with "10 requests" to show.
// Obviously fake, idempotent by number, and a no-op outside staging.
async function seedStagingMergedThreads(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    if (!apps.rows.length) return seedSkipped('no self-hosted project');
    const appId = apps.rows[0].id;
    const people = await pool.query(
      "SELECT id, username FROM users WHERE username IN ('usernode-capture', 'usernode-capture-admin')",
    );
    const member = people.rows.find((r) => r.username === 'usernode-capture');
    if (!member) return seedSkipped('no user usernode-capture');
    const sam = (await pool.query(
      `INSERT INTO users (username, password, is_synthetic)
       VALUES ('staging-demo-sam', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE
       RETURNING id`,
    )).rows[0];
    // Ten requests; #6207 leads. #6212 is sam's and stays in its own thread.
    const numbers = [6207, 6208, 6209, 6210, 6211, 6212, 6213, 6214, 6215, 6216];
    for (const n of numbers) {
      const by = n === 6212 ? sam.id : member.id;
      await pool.query(
        `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
         SELECT $1, $2, $3, 'Staging demo: obviously fake.', $4, NOW() - INTERVAL '4 days', NOW() - INTERVAL '2 days'
          WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
        [appId, n, `Staging demo: request #${n} joins a merged thread`, by],
      );
      await pool.query('SELECT thread_for_number($1, $2)', [appId, n]);
    }
    // Only the rows this seed wrote. The platform's own app already carries
    // real requests under these numbers on a long-lived copy, and merging
    // those would corrupt them: a request whose body is not this seed's is
    // left exactly as it is.
    const owned = (await pool.query(
      `SELECT number FROM requests
        WHERE app_id = $1 AND number = ANY($2::int[]) AND body = 'Staging demo: obviously fake.'`,
      [appId, numbers],
    )).rows.map((r) => r.number);
    if (!owned.includes(6207)) return;
    const lead = (await pool.query('SELECT thread_for_number($1, $2) AS id', [appId, 6207])).rows[0].id;
    // Nine of them share #6207's thread; #6212 keeps its own until sam answers.
    for (const n of owned) {
      if (n === 6212) continue;
      await pool.query(
        `UPDATE threads SET merged_into = $1, state = 'closed', closed_at = NOW()
          WHERE app_id = $2 AND number = $3 AND id <> $1 AND merged_into IS NULL`,
        [lead, appId, n],
      );
      await pool.query(
        `UPDATE requests SET thread_id = $1 WHERE app_id = $2 AND number = $3`, [lead, appId, n],
      );
    }
    // Messages, each tagged with its request (thread_ref keeps the number).
    for (const n of owned) {
      if (n === 6212) continue;
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, thread_id, created_at)
         SELECT $1, $2, $3, 'message', 'issue', $4, $5, NOW() - INTERVAL '2 days'
          WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                             WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $4
                               AND content = $3 AND deleted_at IS NULL)`,
        [appId, n === 6210 ? sam.id : member.id,
         `Staging demo: a note on #${n}, kept after the merge.`, n, lead],
      );
    }
    // The change lives in #6207's thread and closes 3 of the thread's 10.
    // Only over this seed's own requests: a long-lived copy's real #6210 or
    // #6212 must never be claimed by a staging change.
    if (![6207, 6210, 6212].every((n) => owned.includes(n))) return;
    const change = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, session_title, status, linked_issues, thread_id, promoted_at, created_at, last_activity_at)
       SELECT $1, $2, 'staging-fixture/merged-threads', 'Staging demo: vote card lists every request a change closes',
              'promoted', ARRAY[6207,6210,6212]::int[], $3, NOW() - INTERVAL '1 day', NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE app_id = $1 AND branch_name = 'staging-fixture/merged-threads')
        RETURNING id`,
      [appId, member.id, lead],
    );
    const sessionId = change.rows[0]?.id;
    // The consent question waiting for sam on #6212.
    const talk = (await pool.query('SELECT thread_for_number($1, $2) AS id', [appId, 6212])).rows[0].id;
    if (sessionId && talk && talk !== lead) {
      await pool.query(
        `INSERT INTO thread_moves (app_id, thread_id, kind, input, proposed_by, state, deadline, for_session_id, created_at)
         SELECT $1, $2, 'merge', $3::jsonb, $4, 'pending', NOW() + INTERVAL '30 days', $5, NOW() - INTERVAL '1 day'
          WHERE NOT EXISTS (SELECT 1 FROM thread_moves WHERE thread_id = $2 AND for_session_id = $5)`,
        [appId, talk, JSON.stringify({
          into: String(lead), intoNumber: 6207,
          forChange: { id: sessionId, number: 6223 }, requests: [6212], author: member.id,
        }), member.id, sessionId],
      );
    }
  } catch (err) {
    log.warn('db', 'Staging merged-thread seeding failed', { message: err.message });
  }
}

// #6651's shots: the capture member's own change, still waiting on a vote
// because the only Yes is from somebody who does not approve. Needs you lists
// it (and its count says one) instead of saying nothing waits, which a fresh
// staging copy has no way to show: the state needs a second member's vote on
// an approver project. Obviously fake, idempotent by session id, and a no-op
// outside staging.
async function seedStagingOwnChangeWaitingOnVote(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const SESSION_ID = 999_999_989;
  try {
    const people = await pool.query(
      "SELECT id, username FROM users WHERE username IN ('usernode-capture', 'usernode-capture-admin', 'homeroom_bot')",
    );
    if (!people.rows.length) return seedSkipped('no user usernode-capture');
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const approver = people.rows.find((row) => row.username === 'usernode-capture-admin');
    const voter = people.rows.find((row) => row.username === 'homeroom_bot');
    if (!member || !approver || !voter) return;
    const app = await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES (900094, 'Staging demo: credit reason', 'staging-demo-needs-vote-waiting',
               'running', 'members', 'public', $1)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [member.id],
    );
    const appId = app.rows[0]?.id || (await pool.query(
      'SELECT id FROM apps WHERE id = 900094',
    )).rows[0]?.id;
    if (!appId) return;
    // An approver project: only its roster's Yes counts.
    await pool.query(
      `UPDATE apps SET approver_policy = 'invited', approvals_required = 1 WHERE id = $1`,
      [appId],
    );
    await pool.query(
      `INSERT INTO app_approvers (app_id, user_id, status) VALUES ($1, $2, 'member')
       ON CONFLICT (app_id, user_id) DO NOTHING`,
      [appId, approver.id],
    );
    // The feed lists a project the viewer is a MEMBER of (community_members),
    // and creating the app directly does not join its creator.
    await pool.query(
      `INSERT INTO community_members (community_id, user_id)
       SELECT community_id, $1 FROM apps WHERE id = $2 AND community_id IS NOT NULL
       ON CONFLICT DO NOTHING`,
      [member.id, appId],
    );
    const number = 900094;
    const title = 'Staging demo: show the reason beside each credit';
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1::int, $2::int, $3::text, 'Staging demo: obviously fake. Its change waits on a vote.', $4::int,
              NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1::int AND number = $2::int)`,
      [appId, number, title, member.id],
    );
    const session = await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, session_title, pr_title, pr_number, status, linked_issues,
          promoted_at, external_agent, check_state, check_phase, mergeability,
          integration_merges_clean, approval_epoch, created_at, last_activity_at)
       SELECT $1::int, $2::int, $3::int, 'staging-fixture/own-change-waiting-on-vote', $4::text, $4::text,
              $5::int, 'promoted', ARRAY[$6::int]::int[], NOW() - INTERVAL '1 day',
              'claude-code', 'passing', 'done', 'clean', TRUE, 0, NOW() - INTERVAL '2 days',
              NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE id = $1::int)
        RETURNING id`,
      [SESSION_ID, appId, member.id, title, number, number],
    );
    if (!session.rows.length) return;
    // The only Yes is from somebody the project did not invite to approve.
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch, created_at)
       SELECT $1::int, $2::int, 'yes', 0, NOW() - INTERVAL '20 hours'
        WHERE NOT EXISTS (SELECT 1 FROM pr_votes WHERE session_id = $1::int AND user_id = $2::int AND approval_epoch = 0)`,
      [SESSION_ID, voter.id],
    );
    // Open for votes, as the work-state sweep derives it: the gate is not met.
    await pool.query(
      `INSERT INTO work_states (app_id, item_kind, item_ref, issue_number, session_id, stage, since, vote_open)
       VALUES ($1::int, 'change', $2::int, $3::int, $2::int, 'up_for_vote', NOW() - INTERVAL '1 day', TRUE)
       ON CONFLICT (app_id, item_kind, item_ref) DO NOTHING`,
      [appId, SESSION_ID, number],
    );
  } catch (err) {
    log.warn('db', 'Staging own-change waiting-on-vote seeding failed', { message: err.message });
  }
}

// #6389 (6 Nov 2026): a change the capture member made in Claude Code, with
// its vote already in (a Yes from another member, as an explicit-approval
// app needs), its tests failing and a conflict with main. A fresh staging
// copy has no such change: it comes from a coding agent outside Homeroom.
// Needs you has the row that says what it waits on, its page the Votes card
// that names Claude Code, and the bot's plain reply with the two suggestions.
// Obviously fake, idempotent by session id, and a no-op outside staging.
async function seedStagingOwnChangeWaitingOnFix(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const SESSION_ID = 999_999_993;
  try {
    const people = await pool.query(
      "SELECT id, username FROM users WHERE username IN ('usernode-capture', 'usernode-capture-admin', 'homeroom_bot')",
    );
    if (!people.rows.length) return seedSkipped('no user usernode-capture');
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const other = people.rows.find((row) => row.username === 'usernode-capture-admin');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    if (!member || !other || !bot) return;
    // Its own public demo project: the Homeroom project itself is self-hosted
    // and the AI tab leaves a non-admin's self-hosted rows out.
    const app = await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES (900097, 'Staging demo: sign-in token guard', 'staging-demo-signin-token-guard',
               'running', 'members', 'public', $1)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [member.id],
    );
    const appId = app.rows[0]?.id || (await pool.query(
      'SELECT id FROM apps WHERE id = 900097',
    )).rows[0]?.id;
    if (!appId) return;
    // The feed lists a project the viewer is a MEMBER of (community_members),
    // and creating the app directly does not join its creator.
    await pool.query(
      `INSERT INTO community_members (community_id, user_id)
       SELECT community_id, $1 FROM apps WHERE id = $2 AND community_id IS NOT NULL
       ON CONFLICT DO NOTHING`,
      [member.id, appId],
    );
    const number = 900098;
    const changeNumber = 999999993;
    const title = 'Staging demo: guard apps against reading the sign-in token before the bridge';
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1::int, $2::int, $3::text, 'Staging demo: obviously fake. Its change is from Claude Code.', $4::int,
              NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1::int AND number = $2::int)`,
      [appId, number, title, member.id],
    );
    // A thread of its own, so the change page's discussion (the bot's reply)
    // is reachable and the change is in the member's own threads.
    const thread = await pool.query(
      `INSERT INTO threads (app_id, number, kind, title, created_at)
       SELECT $1::int, $2::int, 'work', $3::text, NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM threads WHERE app_id = $1::int AND number = $2::int AND kind = 'work')
        RETURNING id`,
      [appId, changeNumber, title],
    );
    const threadId = thread.rows[0]?.id || (await pool.query(
      "SELECT id FROM threads WHERE app_id = $1 AND number = $2 AND kind = 'work'", [appId, changeNumber],
    )).rows[0]?.id || null;
    const session = await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, session_title, pr_title, pr_number, status, linked_issues,
          thread_id, promoted_at, external_agent, check_state, check_phase, mergeability,
          integration_merges_clean, merge_conflict_state, votes_required, approval_epoch,
          requires_explicit_approval, created_at, last_activity_at)
       SELECT $1::int, $2::int, $3::int, 'staging-fixture/own-change-signin-token', $4::text, $4::text,
              $5::int, 'promoted', ARRAY[$6::int]::int[], $7::int, NOW() - INTERVAL '1 day',
              'claude-code', 'failing', 'done', 'conflict', FALSE, 'conflict', 1, 0, TRUE,
              NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE id = $1::int)
        RETURNING id`,
      [SESSION_ID, appId, member.id, title, changeNumber, number, threadId],
    );
    if (!session.rows.length) return;
    // The Yes it needs, from another member (its explicit approval), so the
    // vote is met and the row says what the change waits on instead.
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch, created_at)
       SELECT $1::int, $2::int, 'yes', 0, NOW() - INTERVAL '20 hours'
        WHERE NOT EXISTS (SELECT 1 FROM pr_votes WHERE session_id = $1::int AND user_id = $2::int AND approval_epoch = 0)`,
      [SESSION_ID, other.id],
    );
    // The member's question and the bot's plain reply, with the two
    // suggestions the reply tool offers as buttons.
    const asked = 'Staging demo: @Homeroom bot can you fix these?';
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
       SELECT $1::int, $2::int, $3::text, 'message', 'session', $4::int, NOW() - INTERVAL '2 hours'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1::int AND thread_type = 'session' AND thread_ref = $4::int
                             AND user_id = $2::int AND content = $3::text AND deleted_at IS NULL)`,
      [appId, member.id, asked, SESSION_ID],
    );
    const answer = 'You made this change in Claude Code, so I can\'t edit it. Its tests fail: 19 in '
      + 'tests/mayor-turn-golden.test.js, where the billing calls don\'t match what the tests expect. '
      + 'It also conflicts with main. Fix both in Claude Code and send the update, or I can make my own '
      + 'version from yours, paid from your week. Votes on yours wouldn\'t carry over to mine.';
    const metadata = {
      homeroomBot: {
        kind: 'voice',
        actions: [
          { id: 'own-version', label: 'Make your own version', style: 'primary' },
          { id: 'fix-there', label: 'I\'ll fix it in Claude Code', style: 'secondary' },
        ],
      },
    };
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, created_at)
       SELECT $1::int, $2::int, $3::text, 'message', $4::jsonb, 'session', $5::int, NOW() - INTERVAL '2 hours'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1::int AND thread_type = 'session' AND thread_ref = $5::int
                             AND user_id = $2::int AND content = $3::text AND deleted_at IS NULL)`,
      [appId, bot.id, answer, JSON.stringify(metadata), SESSION_ID],
    );
  } catch (err) {
    log.warn('db', 'Staging own-change waiting-on-fix seeding failed', { message: err.message });
  }
}

// A change of the capture member's own whose tests passed and whose before
// & after screenshots are still being taken: the row the Homeroom bot tab
// words "Taking screenshots". A fresh staging copy has no such change (a
// screenshots run is the platform's own, and nothing there runs one), so the
// shots get an obviously fake one on the demo project the seed above makes.
// It is no run: nothing reads this row to take screenshots, and no turn is
// on it. The hold it shows lasts 45 minutes from the later of its checks'
// verdict and its screenshots' last move (bot-readiness.ts heldUntil), both
// the moment the row is made, as a copy boots for the first time; after
// that it reads as up for a vote, like the fake change of
// seedStagingOwnChangeWaitingOnVote. The row is written once, whole: the
// screenshots' columns are the shots machine's to update, never a seed's.
// Idempotent by session id, and a no-op outside staging.
async function seedStagingOwnChangeTakingScreenshots(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const SESSION_ID = 999_999_994;
  try {
    const member = (await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1")).rows[0];
    // The demo project seedStagingOwnChangeWaitingOnFix makes and joins.
    const appId = (await pool.query('SELECT id FROM apps WHERE id = 900097')).rows[0]?.id;
    if (!member || !appId) return;
    // Short enough for the number's column on the Homeroom bot tab's rows.
    const changeNumber = 900093;
    const head = 'stagingdemotakingscreenshots';
    const title = 'Staging demo: say which app a sign-in token was made for';
    // A thread of its own, so the change is in the member's own threads.
    const thread = await pool.query(
      `INSERT INTO threads (app_id, number, kind, title, created_at)
       SELECT $1::int, $2::int, 'work', $3::text, NOW() - INTERVAL '20 minutes'
        WHERE NOT EXISTS (SELECT 1 FROM threads WHERE app_id = $1::int AND number = $2::int AND kind = 'work')
        RETURNING id`,
      [appId, changeNumber, title],
    );
    const threadId = thread.rows[0]?.id || (await pool.query(
      "SELECT id FROM threads WHERE app_id = $1 AND number = $2 AND kind = 'work'", [appId, changeNumber],
    )).rows[0]?.id || null;
    // Promoted, its tests passed on the head up for a vote, and its
    // screenshots under way on that head, as of now.
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, session_title, pr_title, pr_number, status,
          thread_id, promoted_at, external_agent, check_state, check_phase, mergeability,
          integration_merges_clean, checks_commit_sha, reviewed_head_sha, votes_required, approval_epoch,
          checks_checked_at, shots_state, shots_run_id, shots_detail, shots_updated_at,
          created_at, last_activity_at)
       SELECT $1::int, $2::int, $3::int, 'staging-fixture/own-change-taking-screenshots', $4::text, $4::text,
              $5::int, 'promoted', $6::int, NOW() - INTERVAL '10 minutes',
              'claude-code', 'passing', 'done', 'clean', TRUE, $7::text, $7::text, 1, 0,
              NOW(), 'exploring', $8::varchar, $9::jsonb, NOW(),
              NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '10 minutes'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE id = $1::int)`,
      [SESSION_ID, appId, member.id, title, changeNumber, threadId, head,
        'stagingdemotakingscreenshots0001', JSON.stringify({ headSha: head, required: true })],
    );
  } catch (err) {
    log.warn('db', 'Staging own-change taking-screenshots seeding failed', { message: err.message });
  }
}

// #6599 (11 Nov 2026): a built draft of the shots' member fixture
// (usernode-capture), its checks passing and nothing working on it, on its
// request's page, so the card's Put it up for a vote has a state to show. A
// fresh staging copy cannot reach it: a draft comes from a coding agent's
// build, and nothing there builds or runs checks. Obviously fake, idempotent,
// and strictly a no-op outside staging.
//
// Beside it, on a second request of the same demo project, a built draft
// whose checks ran and failed: its card still offers Put it up for a vote,
// with the line that says it merges only once they pass (services/threads.js
// `promotable`). Before that it offered nothing.
async function seedStagingReadyDraftChange(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = await pool.query(
      "SELECT id FROM users WHERE username = 'usernode-capture'",
    );
    const member = people.rows[0];
    if (!member) return seedSkipped('no user usernode-capture');
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES (900099, 'Staging demo: a built draft', 'staging-demo-ready-draft',
               'running', 'members', 'public', $1)
       ON CONFLICT (id) DO NOTHING`,
      [member.id],
    );
    const appId = (await pool.query('SELECT id FROM apps WHERE id = 900099')).rows[0]?.id;
    if (!appId) return;
    await pool.query(
      `INSERT INTO community_members (community_id, user_id)
       SELECT community_id, $1 FROM apps WHERE id = $2 AND community_id IS NOT NULL
       ON CONFLICT DO NOTHING`,
      [member.id, appId],
    );
    // Each on a request number staging's mock issue list knows
    // (routes/issues.js stagingMockIssues): a fresh copy has no GitHub to
    // read, and a page it cannot load bounces to the board, so the card would
    // have no page. Its session id sits above every real one (see the test).
    const drafts = [
      // Built, checks passing on its current head, nothing working on it.
      { sessionId: 999_999_990, number: 900001, prNumber: 900141, checkState: 'passing',
        branch: 'staging-fixture/ready-draft', title: 'Staging demo: say how long a build may take' },
      // Built, its checks ran on its current head and failed.
      { sessionId: 999_999_988, number: 900002, prNumber: 900148, checkState: 'failing',
        branch: 'staging-fixture/failing-draft', title: 'Staging demo: name the check that failed' },
    ];
    for (const draft of drafts) {
      const { number, title } = draft;
      // The thread is found by the request's own number, so its page is
      // where the card is drawn.
      const thread = await pool.query(
        `INSERT INTO threads (app_id, number, kind, title, created_at)
         SELECT $1::int, $2::int, 'work', $3::text, NOW() - INTERVAL '1 day'
          WHERE NOT EXISTS (SELECT 1 FROM threads WHERE app_id = $1::int AND number = $2::int AND kind = 'work')
          RETURNING id`,
        [appId, number, title],
      );
      const threadId = thread.rows[0]?.id || (await pool.query(
        "SELECT id FROM threads WHERE app_id = $1 AND number = $2 AND kind = 'work'", [appId, number],
      )).rows[0]?.id || null;
      await pool.query(
        `INSERT INTO requests (app_id, number, title, body, created_by, thread_id, created_at, updated_at)
         SELECT $1::int, $2::int, $3::text, 'Staging demo: obviously fake.', $4::int, $5::int,
                NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 day'
          WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1::int AND number = $2::int)`,
        [appId, number, title, member.id, threadId],
      );
      // services/threads.js changeBuiltSql reads exactly these.
      await pool.query(
        `INSERT INTO chat_sessions
           (id, app_id, user_id, branch_name, session_title, pr_title, pr_number, status, linked_issues,
            created_from_issue_number, thread_id, external_agent, check_state, check_phase,
            checks_commit_sha, mergeability, integration_merges_clean, merge_conflict_state,
            votes_required, approval_epoch, requires_explicit_approval, created_at, last_activity_at)
         SELECT $1::int, $2::int, $3::int, $7::text, $4::text, $4::text,
                $8::int, 'active', ARRAY[$5::int]::int[], $5::int, $6::int,
                'claude-code', $9::text, 'done', repeat('a', 40), 'clean', TRUE, 'clean', 1, 0, TRUE,
                NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day'
          WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE id = $1::int)`,
        [draft.sessionId, appId, member.id, title, number, threadId, draft.branch, draft.prNumber, draft.checkState],
      );
    }
  } catch (err) {
    log.warn('db', 'Staging ready-draft seeding failed', { message: err.message });
  }
}


// #6225 (6 Nov 2026): the Votes card's closes list, before & after shots. A
// change of the shots' member fixture (usernode-capture) is up for a vote and
// names three requests in linked_issues, one of them filed by somebody else,
// so the card lists all three and marks that one "not confirmed by its
// requester". Obviously fake, idempotent, and strictly a no-op outside staging.
async function seedStagingClosesListFixture(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const SESSION_ID = 999_999_992;
  try {
    const people = await pool.query(
      "SELECT id, username FROM users WHERE username IN ('usernode-capture', 'usernode-capture-admin')",
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const other = people.rows.find((row) => row.username === 'usernode-capture-admin');
    if (!member || !other) return;
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES (900098, 'Staging demo: the closes list', 'staging-demo-closes-list',
               'running', 'members', 'public', $1)
       ON CONFLICT (id) DO NOTHING`,
      [member.id],
    );
    const appId = (await pool.query('SELECT id FROM apps WHERE id = 900098')).rows[0]?.id;
    if (!appId) return;
    await pool.query(
      `INSERT INTO community_members (community_id, user_id)
       SELECT community_id, $1 FROM apps WHERE id = $2 AND community_id IS NOT NULL
       ON CONFLICT DO NOTHING`,
      [member.id, appId],
    );
    const title = 'Staging demo: the request the change was built for';
    const requests = [
      [900120, title, member.id],
      [900121, 'Staging demo: a request it also closes, filed by the change\'s author', member.id],
      [900122, 'Staging demo: a request it also closes, filed by somebody else', other.id],
    ];
    // #6606: the change lives on its first request's thread, which is the
    // thread a request's own page reads (its number is the request's).
    const thread = await pool.query(
      `INSERT INTO threads (app_id, number, kind, title, created_at)
       SELECT $1::int, $2::int, 'work', $3::text, NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM threads WHERE app_id = $1::int AND number = $2::int AND kind = 'work')
        RETURNING id`,
      [appId, 900120, title],
    );
    const threadId = thread.rows[0]?.id || (await pool.query(
      'SELECT id FROM threads WHERE app_id = $1 AND number = $2 AND kind = \'work\'', [appId, 900120],
    )).rows[0]?.id || null;
    for (const [number, requestTitle, filer] of requests) {
      // #6606: the change lives on the first request's thread; each other
      // request has a thread of its own, so its page says "Change PR … says
      // it closes this" and its filer can answer there (the shots need the
      // one filed by somebody else to exist on a page of its own).
      let requestThread = threadId;
      if (number !== 900120) {
        const own = await pool.query(
          `INSERT INTO threads (app_id, number, kind, title, created_at)
           SELECT $1::int, $2::int, 'work', $3::text, NOW() - INTERVAL '4 days'
            WHERE NOT EXISTS (SELECT 1 FROM threads WHERE app_id = $1::int AND number = $2::int AND kind = 'work')
            RETURNING id`,
          [appId, number, requestTitle],
        );
        requestThread = own.rows[0]?.id || (await pool.query(
          `SELECT id FROM threads WHERE app_id = $1 AND number = $2 AND kind = 'work'`,
          [appId, number],
        )).rows[0]?.id || threadId;
      }
      await pool.query(
        `INSERT INTO requests (app_id, number, title, body, created_by, thread_id, created_at, updated_at)
         SELECT $1::int, $2::int, $3::text, 'Staging demo: obviously fake.', $4::int, $5::int,
                NOW() - INTERVAL '4 days', NOW() - INTERVAL '2 days'
          WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1::int AND number = $2::int)`,
        [appId, number, requestTitle, filer, requestThread],
      );
    }
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, session_title, pr_title, pr_number, status, linked_issues,
          created_from_issue_number, thread_id, promoted_at, external_agent, check_state, check_phase,
          mergeability, integration_merges_clean, merge_conflict_state, votes_required, approval_epoch,
          requires_explicit_approval, created_at, last_activity_at)
       SELECT $1::int, $2::int, $3::int, 'staging-fixture/closes-list', $4::text, $4::text,
              $1::int, 'promoted', ARRAY[900120, 900121, 900122]::int[], 900120, $5::int,
              NOW() - INTERVAL '1 day', 'claude-code', 'passing', 'done', 'clean', TRUE, 'clean', 1, 0, TRUE,
              NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE id = $1::int)`,
      [SESSION_ID, appId, member.id, title, threadId],
    );
  } catch (err) {
    log.warn('db', 'Staging closes-list seeding failed', { message: err.message });
  }
}

// #6282 (4 Nov 2026): an update queued on the change above, so the before &
// after shots have the state this change is about: the AI tab says Update
// queued instead of asking for a Vote, and the change's Votes card says an
// update is coming. Filed by the shots' member fixture
// (usernode-capture), as an ask on a real change is; obviously fake,
// idempotent, and strictly a no-op outside staging.
async function seedStagingBotUpdateComing(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const change = await pool.query(
      `SELECT id, app_id, linked_issues[1] AS issue_number FROM chat_sessions
        WHERE branch_name = 'staging-fixture/stale-description' AND status = 'promoted' LIMIT 1`,
    );
    const person = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!change.rows.length || !person.rows.length) return;
    const { id: sessionId, app_id: appId, issue_number: issueNumber } = change.rows[0];
    await pool.query(
      `INSERT INTO homeroom_bot_change_asks
         (app_id, session_id, issue_number, asker_id, instruction, source, status, created_at)
       SELECT $1, $2, $3, $4, 'Staging demo: drop the second credit line', 'staging-fixture', 'queued', NOW() - INTERVAL '2 minutes'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_change_asks
                           WHERE session_id = $2 AND source = 'staging-fixture')`,
      [appId, sessionId, issueNumber, person.rows[0].id],
    );
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot update-coming seeding failed', { message: err.message });
  }
}

/**
 * #6406's shots: a request whose promoted Change #178 was built from plan v1
 * while a newer v2 was posted, with the bot's two lines in its discussion.
 * A fresh staging copy cannot reach that state on its own because nothing
 * there runs a build. Obviously fake, idempotent, and strictly a no-op
 * outside staging. Its ids are in a range no real session can reach.
 */
async function seedStagingNewerPlan(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const PLAN_SESSION_ID = 999_999_996;
  const CHANGE_SESSION_ID = 999_999_995;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!apps.rows.length || !people.rows.length) return seedSkipped('no self-hosted project or no user usernode-capture');
    const appId = apps.rows[0].id;
    const userId = people.rows[0].id;
    const number = 900098;
    const title = 'Staging demo: a request whose change follows an older plan';
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1::int, $2::int, $3::text, 'Staging demo: obviously fake. A newer plan was posted while the bot built an older one.', $4::int,
              NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1::int AND number = $2::int)`,
      [appId, number, title, userId],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, created_at)
       SELECT $1::int, $2::int, $3::int, $4::text, NOW() - INTERVAL '2 days'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_requesters WHERE app_id = $1::int AND issue_number = $2::int)`,
      [appId, number, userId, title],
    );
    // A plan's numbered versions live on a `request_spec` session.
    await pool.query(
      `INSERT INTO chat_sessions (id, app_id, user_id, session_title, source, status, created_from_issue_number, linked_issues, created_at, last_activity_at)
       SELECT $1::int, $2::int, $3::int, $4::text, 'request_spec', 'active', $5::int, ARRAY[$5::int]::int[], NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE id = $1::int)`,
      [PLAN_SESSION_ID, appId, userId, title, number],
    );
    await pool.query(
      `INSERT INTO chat_session_specs (session_id, version, content, shared_to_group_at, created_at)
       SELECT $1::int, $2::int, $3::text, NOW() - ($2::int * INTERVAL '1 minute'), NOW() - ($2::int * INTERVAL '1 minute')
        WHERE NOT EXISTS (SELECT 1 FROM chat_session_specs WHERE session_id = $1::int AND version = $2::int)`,
      [PLAN_SESSION_ID, 1, 'Staging demo: the sample screen gets a banner at its top.'],
    );
    await pool.query(
      `INSERT INTO chat_session_specs (session_id, version, content, shared_to_group_at, created_at)
       SELECT $1::int, $2::int, $3::text, NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute'
        WHERE NOT EXISTS (SELECT 1 FROM chat_session_specs WHERE session_id = $1::int AND version = $2::int)`,
      [PLAN_SESSION_ID, 2, 'Staging demo: the sample screen gets a banner at its top, and a sample footer.'],
    );
    // The promoted change, built from v1 of that plan.
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, session_title, pr_title, pr_number, status, linked_issues, promoted_at,
          built_from_session_id, built_from_version, created_at, last_activity_at)
       SELECT $6::int, $1::int, $2::int, 'staging-fixture/newer-plan', $3::text, $3::text, 178, 'promoted', ARRAY[$4::int]::int[],
              NOW() - INTERVAL '1 hour', $5::int, 1, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE id = $6::int)`,
      [appId, userId, title, number, PLAN_SESSION_ID, CHANGE_SESSION_ID],
    );
    const bot = await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE
       RETURNING id`,
    );
    const botId = bot.rows[0].id;
    const lines = [
      '@usernode-capture, you posted v2 while I was building v1. I\'ll finish it, then update the change to follow v2.',
      'Change #178 is built from v1, and @usernode-capture posted v2 while I was building. I\'ve queued its update to v2: its votes clear when the update lands.',
    ];
    for (const content of lines) {
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, created_at)
         SELECT $1::int, $2::int, $3::text, 'message', '{}'::jsonb, 'issue', $4::int, NOW() - INTERVAL '1 hour'
          WHERE NOT EXISTS (SELECT 1 FROM chat_messages WHERE app_id = $1::int AND user_id = $2::int AND content = $3::text AND thread_type = 'issue' AND thread_ref = $4::int)`,
        [appId, botId, content, number],
      );
    }
  } catch (err) {
    log.warn('db', 'Staging newer-plan seeding failed', { message: err.message });
  }
}

/**
 * #6388's shots: a change Homeroom bot built for the capture member, whose
 * one failing check reports the preview answering HTTP 503, so the Testing
 * card says the preview looks at fault rather than "Its author needs to fix
 * this". A fresh staging copy cannot reach it on its own because nothing
 * there runs checks. Obviously fake, idempotent, and strictly a no-op
 * outside staging. Its id is apart from the stopped fixture's and in a range
 * no real session can reach.
 */
async function seedStagingBotFixesPlatform(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const SESSION_ID = 999_999_998;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!apps.rows.length || !people.rows.length) return seedSkipped('no self-hosted project or no user usernode-capture');
    const appId = apps.rows[0].id;
    const memberId = people.rows[0].id;
    const number = 900096;
    const title = 'Staging demo: a change the bot left to Homeroom\'s preview';
    const branch = 'staging-fixture/bot-fixes-platform';
    // Not a 40-character hex sha on purpose: the preview machine adopts every
    // promoted change with a real head and builds it, and this fixture has no
    // branch to build. Nothing here runs checks either.
    const head = 'staging-fixture-head';
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const botRow = await pool.query(
      "SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1",
    );
    if (!botRow.rows.length) return seedSkipped('no Homeroom bot user');
    const botId = botRow.rows[0].id;
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1::int, $2::int, $3::text, 'Staging demo: obviously fake. Its checks failed because the preview did not answer.', $4::int,
              NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1::int AND number = $2::int)`,
      [appId, number, title, memberId],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, created_at)
       SELECT $1::int, $2::int, $3::int, $4::text, NOW() - INTERVAL '3 days'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_requesters WHERE app_id = $1::int AND issue_number = $2::int)`,
      [appId, number, memberId, title],
    );
    const session = await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, session_title, pr_title, status, linked_issues, promoted_at,
          check_state, check_phase, reviewed_head_sha, checks_commit_sha, test_results,
          pr_summary_md, created_at, last_activity_at)
       SELECT $8::int, $1::int, $2::int, $3::text, $4::text, $4::text, 'promoted', ARRAY[$5::int]::int[], NOW() - INTERVAL '2 hours',
              'failing', 'done', $6::text, $6::text, $7::jsonb,
              'Staging demo: a change Homeroom bot built, whose checks the preview failed.',
              NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 hours'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE id = $8::int)
        RETURNING id`,
      [appId, botId, branch, title, number, head,
        JSON.stringify([{
          name: 'Pages render with their stylesheets (platform check)',
          path: '/app/staging-demo-admins',
          status: 'fail',
          failureReason: 'HTTP 503 Service Unavailable for /b/594ec2a2/usernode-native/v1/native.css and /b/594ec2a2/css/app.css',
        }]),
        SESSION_ID],
    );
    if (!session.rows.length) {
      const taken = await pool.query('SELECT branch_name FROM chat_sessions WHERE id = $1', [SESSION_ID]);
      if (taken.rows[0]?.branch_name !== branch) {
        log.warn('db', 'Staging Homeroom bot platform-fix fixture id is taken', { sessionId: SESSION_ID });
      }
    }
    // #6388's second card: a person's failing change, so the Testing card
    // names the person who has to fix it. Its author is the capture member;
    // the shots read it as another member (or an admin).
    const personNumber = 900097;
    const personTitle = 'Staging demo: a person\'s change whose checks failed';
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1::int, $2::int, $3::text, 'Staging demo: obviously fake. A person''s change failed its checks.', $4::int,
              NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1::int AND number = $2::int)`,
      [appId, personNumber, personTitle, memberId],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, created_at)
       SELECT $1::int, $2::int, $3::int, $4::text, NOW() - INTERVAL '3 days'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_requesters WHERE app_id = $1::int AND issue_number = $2::int)`,
      [appId, personNumber, memberId, personTitle],
    );
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, session_title, pr_title, status, linked_issues, promoted_at,
          check_state, check_phase, reviewed_head_sha, checks_commit_sha, test_results,
          pr_summary_md, created_at, last_activity_at)
       SELECT $8::int, $1::int, $2::int, $3::text, $4::text, $4::text, 'promoted', ARRAY[$5::int]::int[], NOW() - INTERVAL '2 hours',
              'failing', 'done', $6::text, $6::text, $7::jsonb,
              'Staging demo: a change a person made, whose checks failed.',
              NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 hours'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE id = $8::int)
        RETURNING id`,
      [appId, memberId, 'staging-fixture/person-checks-failing', personTitle, personNumber, head,
        JSON.stringify([{
          name: 'Signed-in people see the vote button',
          path: '/vote',
          status: 'fail',
          failureReason: 'Expected selector #vote-btn',
        }]),
        999_999_997],
    );
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot platform-fix seeding failed', { message: err.message });
  }
}

/**
 * #6284's shots: a change Homeroom bot built for the capture member, its
 * checks failing after the bot stopped at its own limit of three fixes. The
 * Testing card and the Homeroom bot page's Needs you show the stopped state
 * and Let it try again, which a fresh staging copy cannot reach on its own
 * because nothing there runs checks or a model. Obviously fake, idempotent,
 * and strictly a no-op outside staging.
 *
 * Its id is fixed because the declared start path names the change, and it
 * is in a range no real session can reach: a preview cloned from production
 * already holds every id up to production's counter, and an id already taken
 * silently skipped this fixture once (#6284's own shots could not find it).
 */
async function seedStagingBotFixesStopped(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  // Nine digits: the client's change address (_changeNumber) reads at most
  // that many, and no real session counter gets near it.
  const SESSION_ID = 999_999_999;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    if (!apps.rows.length || !people.rows.length) return seedSkipped('no self-hosted project or no user usernode-capture');
    const appId = apps.rows[0].id;
    const memberId = people.rows[0].id;
    const number = 900095;
    const title = 'Staging demo: a change the bot stopped fixing';
    const branch = 'staging-fixture/bot-fixes-stopped';
    // Not a 40-character hex sha on purpose: the preview machine adopts every
    // promoted change with a real head and builds it, and this fixture has no
    // branch to build. Nothing here runs checks either, so the head it looks
    // at is just the string its runs carry.
    const head = 'staging-fixture-head';
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const botRow = await pool.query(
      "SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1",
    );
    if (!botRow.rows.length) return seedSkipped('no Homeroom bot user');
    const botId = botRow.rows[0].id;
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1::int, $2::int, $3::text, 'Staging demo: obviously fake. Its checks failed and the bot stopped.', $4::int,
              NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1::int AND number = $2::int)`,
      [appId, number, title, memberId],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, created_at)
       SELECT $1::int, $2::int, $3::int, $4::text, NOW() - INTERVAL '3 days'
        WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_requesters WHERE app_id = $1::int AND issue_number = $2::int)`,
      [appId, number, memberId, title],
    );
    const session = await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, session_title, pr_title, status, linked_issues, promoted_at,
          check_state, check_phase, reviewed_head_sha, checks_commit_sha, test_results,
          pr_summary_md, created_at, last_activity_at)
       SELECT $8::int, $1::int, $2::int, $3::text, $4::text, $4::text, 'promoted', ARRAY[$5::int]::int[], NOW() - INTERVAL '2 hours',
              'failing', 'done', $6::text, $6::text, $7::jsonb,
              'Staging demo: a change Homeroom bot built, whose checks are failing.',
              NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 hours'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE id = $8::int)
        RETURNING id`,
      [appId, botId, branch, title, number, head,
        JSON.stringify([{ name: 'The page loads', path: '/', status: 'fail', failureReason: '1 console error on load' }]),
        SESSION_ID],
    );
    if (!session.rows.length) {
      // The id was taken by something that is not this fixture: say so,
      // rather than leaving the shots to find nothing and report a skip.
      const taken = await pool.query('SELECT branch_name FROM chat_sessions WHERE id = $1', [SESSION_ID]);
      if (taken.rows[0]?.branch_name !== branch) {
        log.warn('db', 'Staging Homeroom bot stopped-fix fixture id is taken', { sessionId: SESSION_ID });
      }
      return;
    }
    const sessionId = session.rows[0].id;
    for (const [i, limitStop] of [[1, null], [2, null], [3, null], [4, 'own_revisions']]) {
      const reason = i === 4 ? 'its attempt to fix them changed nothing' : `fix round ${i} (staging demo)`;
      await pool.query(
        `INSERT INTO homeroom_bot_runs
           (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha, asked, limit_stop, reason, created_at)
         SELECT $1::int, $2::int, 'live', $3::text, $4::int, $5::text, FALSE, $6::text, $7::text,
                NOW() - ($8::int * INTERVAL '10 minutes')
          WHERE NOT EXISTS (SELECT 1 FROM homeroom_bot_runs
                             WHERE app_id = $1::int AND issue_number = $2::int
                               AND proposal_session_id = $4::int AND reason = $7::text)`,
        [appId, number, i === 4 ? 'person' : 'revise', sessionId, head, limitStop, reason, i],
      );
    }
    // The bot's own stop message in the change's discussion, with Let it try
    // again and Not now under it, as a real stop posts it. The same words
    // followup.stoppedHandOffText says for one failing check.
    const stopText = 'I stopped after 3 tries at getting this change past its checks. 1 check is still failing. '
      + 'The person who asked for it or an admin can let me try once more.';
    let offer = (await pool.query(
      `SELECT id FROM bot_cards
        WHERE place = 'thread' AND app_id = $1 AND kind = 'try_again' AND args->>'sessionId' = $2
       UNION ALL
       SELECT id FROM homeroom_bot_voice_offers
        WHERE app_id = $1 AND kind = 'try_again' AND args->>'sessionId' = $2 LIMIT 1`,
      [appId, String(sessionId)],
    )).rows[0];
    if (!offer) {
      offer = (await pool.query(
        `INSERT INTO bot_cards (place, app_id, kind, args, user_id)
         VALUES ('thread', $1, 'try_again', $2::jsonb, $3) RETURNING id`,
        [appId, JSON.stringify({ sessionId: Number(sessionId) }), memberId],
      )).rows[0];
    }
    const actions = [
      { id: 'yes', label: 'Let it try again', style: 'primary', offerId: Number(offer.id) },
      { id: 'no', label: 'Not now', style: 'secondary', offerId: Number(offer.id) },
    ];
    const metadata = {
      homeroomBot: {
        kind: 'voice',
        offer: { id: Number(offer.id), kind: 'try_again', status: 'open', forUserId: Number(memberId) },
        actions,
      },
    };
    const posted = await pool.query(
      `INSERT INTO chat_messages
         (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, created_at)
       SELECT $1::int, $2::int, $3::text, 'message', $4::jsonb, 'session', $5::int, NOW() - INTERVAL '2 hours'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1::int AND thread_type = 'session' AND thread_ref = $5::int
                             AND user_id = $2::int AND content = $3::text AND deleted_at IS NULL)
       RETURNING id`,
      [appId, botId, stopText, JSON.stringify(metadata), sessionId],
    );
    const messageId = posted.rows[0]?.id || (await pool.query(
      `SELECT id FROM chat_messages
        WHERE app_id = $1 AND thread_type = 'session' AND thread_ref = $2
          AND user_id = $3 AND content = $4 AND deleted_at IS NULL
        ORDER BY id LIMIT 1`,
      [appId, sessionId, botId, stopText],
    )).rows[0]?.id;
    if (messageId) {
      await pool.query(
        "UPDATE bot_cards SET chat_message_id = $2 WHERE id = $1 AND place = 'thread' AND chat_message_id IS NULL",
        [offer.id, messageId],
      );
    }
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot stopped-fix seeding failed', { message: err.message });
  }
}

// #6264: a request where the bot promised to say when an update was in, and
// then said it. A fresh staging copy has no such exchange (nothing here runs
// a model), so the before & after shots get one, obviously fake, on the
// self-hosted Homeroom project, for the shots' member fixture
// (usernode-capture) as the person who asked. The messages are ordinary bot
// bubbles in the request's discussion; none of it is a signal anything
// reads. Idempotent by request number and by each line's text; a no-op
// outside staging.
async function seedStagingBotFollowUp(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    const bots = await pool.query("SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1");
    if (!apps.rows.length || !people.rows.length || !bots.rows.length) return seedSkipped('no self-hosted project, no user usernode-capture or no Homeroom bot');
    const appId = apps.rows[0].id;
    const userId = people.rows[0].id;
    const botId = bots.rows[0].id;
    const number = 9107;
    const title = 'Staging demo: a request where the bot kept its word';
    await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       SELECT $1, $2, $3, 'Staging demo: obviously fake. An update was asked for and told.', $4, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'
        WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
      [appId, number, title, userId],
    );
    const lines = [
      [botId, "Got it, @usernode-capture: I've queued that update to PR 9107. I start on it now.", '2 days'],
      [userId, 'Tell me when the update is made.', '47 hours'],
      [botId, "Sure, @usernode-capture. I'll tell you here when it's in.", '47 hours'],
      [botId, '@usernode-capture, the update to PR 9107 is in, and its checks are running.', '46 hours'],
    ];
    for (const [author, content, ago] of lines) {
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
         SELECT $1, $2, $3, 'message', 'issue', $4, NOW() - ($5)::interval
          WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                             WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $4
                               AND user_id = $2 AND content = $3 AND deleted_at IS NULL)`,
        [appId, author, content, number, ago],
      );
    }
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot follow-up seeding failed', { message: err.message });
  }
}

// #6211: two obviously fake requests on the staging demo app, the smaller
// one's discussion carrying the note Homeroom bot says when its read finds
// it part of the other, with the three choices under it for the capture
// member. A fresh staging copy has no model, so the note is stored rather
// than asked for: nothing here reads it to decide anything. Idempotent
// through each request's number and the note's words; a no-op outside
// staging.
async function seedStagingBotOverlap(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id, slug FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    const bots = await pool.query("SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1");
    if (!apps.rows.length || !people.rows.length || !bots.rows.length) return seedSkipped('no self-hosted project, no user usernode-capture or no Homeroom bot');
    const app = apps.rows[0];
    const appId = Number(app.id);
    const member = Number(people.rows[0].id);
    const bot = Number(bots.rows[0].id);
    if (!appId || !member || !bot || member === bot) return;
    // The larger request first, then the one that is part of it.
    const bigger = 9114;
    const smaller = 9115;
    const requests = [
      [bigger, 'Staging demo: Main Chat keeps only what you said there', 'Staging demo: obviously fake. A request a smaller one is part of.'],
      [smaller, 'Staging demo: a plan row opens Main Chat', 'Staging demo: obviously fake. One piece of the larger request.'],
    ];
    for (const [number, title, body] of requests) {
      await pool.query(
        `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
         SELECT $1, $2, $3, $4, $5, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'
          WHERE NOT EXISTS (SELECT 1 FROM requests WHERE app_id = $1 AND number = $2)`,
        [appId, number, title, body, member],
      );
    }
    const domain = require('../services/caddy').USERNODE_DOMAIN;
    const link = (n) => `https://${domain}/#app/${app.slug}/dev/issues/${n}`;
    const note = `This looks like part of [#${bigger}](${link(bigger)}) `
      + '(Staging demo: Main Chat keeps only what you said there). Both move a request\'s news out of Main Chat. '
      + `You can fold it into #${bigger}, build this one first, or keep them separate.`;
    const { rows: [said] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
       SELECT $1, $2, $3, 'message', 'issue', $4, NOW() - INTERVAL '2 days'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $4
                             AND user_id = $2 AND content = $3 AND deleted_at IS NULL)
       RETURNING id`,
      [appId, bot, note, smaller],
    );
    // #6211's third screen: the larger request's discussion carries one line
    // saying what was chosen, so a shot of it can be taken too.
    const linkLine = `Request [#${smaller}](${link(smaller)}) is part of this one. `
      + 'usernode-capture chose to fold it in, so it is built as part of this request.';
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
       SELECT $1, $2, $3, 'message', 'issue', $4, NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $4
                             AND user_id = $2 AND content = $3 AND deleted_at IS NULL)`,
      [appId, bot, linkLine, bigger],
    );
    // A later boot finds the note already there. It still makes sure the
    // card and the choices are attached: an earlier boot that stopped
    // between the two would otherwise leave the note without buttons, and
    // every boot after it would skip the repair.
    const noteId = said?.id || (await pool.query(
      `SELECT id FROM chat_messages
        WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2
          AND user_id = $3 AND content = $4 AND deleted_at IS NULL
        ORDER BY id LIMIT 1`,
      [appId, smaller, bot, note],
    )).rows[0]?.id;
    if (!noteId) return;
    const { rows: [existingNote] } = await pool.query(
      'SELECT metadata FROM chat_messages WHERE id = $1', [Number(noteId)],
    );
    // The note already carries its choices: nothing to repair.
    if (existingNote?.metadata?.homeroomBot?.offer?.id) return;
    const { rows: [card] } = await pool.query(
      `INSERT INTO bot_cards (place, app_id, kind, args, user_id, chat_message_id)
       VALUES ('thread', $1, 'overlap', $2, $3, $4) RETURNING id`,
      [appId, JSON.stringify({ issueNumber: smaller, other: bigger, overlap: 'part_of' }), member, Number(noteId)],
    );
    const actions = [
      { id: 'yes', label: `Fold it into #${bigger}`, style: 'primary', offerId: Number(card.id) },
      { id: 'first', label: 'Build this one first', style: 'secondary', offerId: Number(card.id) },
      { id: 'no', label: 'Keep separate', style: 'secondary', offerId: Number(card.id) },
    ];
    await pool.query(
      'UPDATE chat_messages SET metadata = $2 WHERE id = $1',
      [Number(noteId), JSON.stringify({
        homeroomBot: {
          kind: 'voice',
          offer: { id: Number(card.id), kind: 'overlap', status: 'open', forUserId: member },
          actions,
        },
      })],
    );
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot overlap seeding failed', { message: err.message });
  }
}

// #6535's shots: the same overlap note on #9115, with its plan now building.
// The change closes the question's buttons when that happens; nothing here
// runs a model, so the after copy needs the state stored: an obviously fake
// plan row under the note, and the note's offer retired as the request's
// move to building retires it. The before copy has no such seed, so it
// still shows the open question and its three buttons. Idempotent: the plan row is made once and
// the retirement is a no-op after it. A no-op outside staging.
async function seedStagingBotOverlapBuilt(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const apps = await pool.query('SELECT id, slug FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    const bots = await pool.query("SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1");
    if (!apps.rows.length || !bots.rows.length) return seedSkipped('no self-hosted project or no Homeroom bot');
    const app = apps.rows[0];
    const appId = Number(app.id);
    const bot = Number(bots.rows[0].id);
    if (!appId || !bot) return;
    const smaller = 9115;
    const { rows: [note] } = await pool.query(
      `SELECT id FROM chat_messages
        WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2
          AND user_id = $3 AND metadata->'homeroomBot'->'offer'->>'kind' = 'overlap'
          AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      [appId, smaller, bot],
    );
    if (!note) return;
    const planContent = '📋 Plan v1: Main Chat keeps only what you said there. I\'m building it now.';
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
       SELECT $1, $2, $3, 'spec_share', 'issue', $4, $5, NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages
                           WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $4
                             AND msg_type = 'spec_share' AND content = $3 AND deleted_at IS NULL)`,
      [appId, bot, planContent, smaller, JSON.stringify({
        specShare: {
          sessionId: 900832, version: 1, botNote: 'building',
          title: 'Main Chat keeps only what you said there',
          sharedBy: { id: bot, username: 'homeroom_bot' },
        },
      })],
    );
    const { rows: [plan] } = await pool.query(
      `SELECT id FROM chat_messages
        WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2
          AND msg_type = 'spec_share' AND content = $3 AND deleted_at IS NULL
        ORDER BY id LIMIT 1`,
      [appId, smaller, planContent],
    );
    if (!plan) return;
    // Its buttons go as the request's move to building retires them
    // (bot-cards.js retireFor): a no-op once they have.
    const { rows: cards } = await pool.query(
      `SELECT id, kind, place, user_id, chat_message_id, message_id, conversation_id FROM bot_cards
        WHERE place = 'thread' AND chat_message_id = $1 AND status = 'open'`,
      [Number(note.id)],
    );
    await require('../services/bot-cards').retireCards(pool, cards, 'building');
  } catch (err) {
    log.warn('db', 'Staging Homeroom bot overlap build seeding failed', { message: err.message });
  }
}

// #6255: the bot agrees, in the member fixture's Main Chat, to say when a
// request it is still building is made ("I'll tell you here when it's ready
// to vote"). A fresh staging copy has no such exchange, because nothing here
// runs a model, so the before & after shots would find an empty chat. The
// lines are obviously fake and nothing reads them. Idempotent through the
// direct pair and each line's key; a no-op outside staging.
async function seedStagingBotTellMeWhen(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = await pool.query("SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1");
    const bots = await pool.query("SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1");
    if (!people.rows.length || !bots.rows.length) return seedSkipped('no user usernode-capture or no Homeroom bot');
    const member = Number(people.rows[0].id);
    const bot = Number(bots.rows[0].id);
    if (member === bot) return;
    const low = Math.min(member, bot);
    const high = Math.max(member, bot);
    const found = await pool.query(
      `SELECT p.conversation_id FROM conversation_direct_pairs p
        WHERE p.user_low_id = $1 AND p.user_high_id = $2 LIMIT 1`,
      [low, high],
    );
    let conversationId = found.rows[0]?.conversation_id;
    if (!conversationId) {
      const created = await pool.query(
        `INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`,
        [bot],
      );
      conversationId = created.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, low, high],
      );
    }
    await pool.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, invited_by, responded_at, joined_at)
       SELECT $1, u.id, 'member', 'member', $2, NOW(), NOW()
         FROM users u WHERE u.id IN ($2, $3)
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, bot, member],
    );
    const lines = [
      [member, 'staging-tellmewhen-1', 'Staging demo: can you build request #9108 on Homeroom?', '27 minutes'],
      [bot, 'staging-tellmewhen-2', "I've started building Homeroom request #9108. It usually takes about 20 minutes.", '26 minutes'],
      [member, 'staging-tellmewhen-3', "Great, tell me when it's made.", '25 minutes'],
      [bot, 'staging-tellmewhen-4', "I'll tell you here when it's ready to vote.", '25 minutes'],
    ];
    for (const [sender, key, content, ago] of lines) {
      await pool.query(
        `INSERT INTO conversation_messages
           (conversation_id, sender_id, content, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, NOW() - $5::interval)
         ON CONFLICT (conversation_id, sender_id, idempotency_key)
           WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL
         DO NOTHING`,
        [conversationId, sender, content, key, ago],
      );
    }
    log.info('db', 'Staging tell-me-when chat seeded', { conversationId });
  } catch (err) {
    log.warn('db', 'Staging tell-me-when chat seeding failed', { message: err.message });
  }
}

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
// gets its room from the boot reference seed and starts with no
// history. Two fake speakers of their own, never the viewer: the checks read
// the room as the view-only check user, and seeding THAT user's words would
// fabricate the thing being checked. Idempotent through the messages'
// idempotency keys; strictly a no-op outside staging.
async function seedStagingGeneralChannel(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (id, username, password, profile_published)
       VALUES (902783, 'staging-demo-general-ada', 'staging-demo-not-a-login', TRUE),
              (902784, 'staging-demo-general-lin', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT DO NOTHING`
    );
    // The persisted demo inbox uses these same identities. Repair profiles
    // from older previews, preserving any moderation decision.
    await pool.query(
      `UPDATE users SET profile_published = TRUE
        WHERE (id, username) IN ((902783, 'staging-demo-general-ada'),
                                 (902784, 'staging-demo-general-lin'))
          AND password = 'staging-demo-not-a-login'
          AND profile_published = FALSE AND profile_disabled_at IS NULL`
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
      // #6525: one line in another language, so a fresh preview of #general
      // has the row auto-translate puts its line under. Its English is seeded
      // with the other translation fixtures, below.
      [902784, 'staging-general-translate-1', 'Pagi semua ☕ hari ini mau aku push update kecil di tryconnect, semoga lancar. Ada yang lagi main game seru di sini rekomendasi dong', '1 hour'],
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

// #5019's before/after shots follow a conversation being paged from its top,
// which needs a thread longer than one page of fifty: a fresh clone has no
// such conversation, and typing one through the UI is not a step anybody can
// take. One direct thread between the shots' own member fixture
// (usernode-capture) and one of the fake speakers above, its lines marked as
// a staging demo throughout. Two pages and a tail, so a reader at the bottom
// starts with real older history to load. Idempotent through the direct pair
// and the messages' idempotency keys; strictly a no-op outside staging.
async function seedStagingScrollTestThread(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = await pool.query(
      `SELECT id, username FROM users
        WHERE username IN ('usernode-capture', 'staging-demo-general-ada')`
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const other = people.rows.find((row) => row.username === 'staging-demo-general-ada');
    if (!member || !other || member.id === other.id) {
      log.warn('db', 'Staging scroll-test thread skipped: fixture users missing');
      return;
    }
    const low = Math.min(member.id, other.id);
    const high = Math.max(member.id, other.id);
    const found = await pool.query(
      `SELECT c.id FROM conversations c
         JOIN conversation_direct_pairs p ON p.conversation_id = c.id
        WHERE p.user_low_id = $1 AND p.user_high_id = $2
        LIMIT 1`,
      [low, high]
    );
    let conversationId = found.rows[0]?.id;
    if (!conversationId) {
      const created = await pool.query(
        `INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`,
        [member.id]
      );
      conversationId = created.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_direct_pairs
           (conversation_id, user_low_id, user_high_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, low, high]
      );
    }
    // Re-asserted even on an existing thread, so a partial earlier boot
    // self-heals, as the #general seed does for its members.
    await pool.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, responded_at, joined_at)
       SELECT $1, u.id, 'member', 'member', NOW(), NOW()
         FROM users u WHERE u.id IN ($2, $3)
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, member.id, other.id]
    );
    const inserted = await pool.query(
      `INSERT INTO conversation_messages
         (conversation_id, sender_id, content, idempotency_key, created_at)
       SELECT $1::int,
              CASE WHEN n % 2 = 0 THEN $3::int ELSE $2::int END,
              'Staging demo: history line ' || n || ' of 130 of the scroll test.',
              'staging-scroll-' || n,
              NOW() - ((131 - n) * INTERVAL '30 seconds')
         FROM generate_series(1, 130) AS n
       ON CONFLICT (conversation_id, sender_id, idempotency_key)
         WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL
       DO NOTHING`,
      [conversationId, member.id, other.id]
    );
    if (inserted.rowCount > 0) {
      log.info('db', 'Staging scroll-test thread seeded', {
        conversationId, inserted: inserted.rowCount,
      });
    }
  } catch (err) {
    log.warn('db', 'Staging scroll-test thread seeding failed', { message: err.message });
  }
}

// #6081's before/after shots follow words written in another language, read
// in English on a tap. The copies have no model key, so a tap there cannot
// ask for a translation; the route still answers from what is stored. This
// seeds one message and one request in Spanish, with the English the route
// serves at once, so the after build can show the translated state. The rows
// are obviously fake, in the staging ranges, idempotent, and a strict no-op
// outside staging.
async function seedStagingUserContentTranslations(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
  try {
    const people = await pool.query(
      `SELECT id, username FROM users
        WHERE username IN ('usernode-capture', 'staging-demo-general-lin', 'staging-demo-general-ada')`
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const lin = people.rows.find((row) => row.username === 'staging-demo-general-lin');
    const ada = people.rows.find((row) => row.username === 'staging-demo-general-ada');
    if (!member || !lin || !ada) {
      log.warn('db', 'Staging translation fixtures skipped: fixture users missing');
      return;
    }

    // A direct thread the member can open from Messages, with one line in
    // Spanish from the other person and the English for it.
    const low = Math.min(member.id, lin.id);
    const high = Math.max(member.id, lin.id);
    const found = await pool.query(
      `SELECT c.id FROM conversations c
         JOIN conversation_direct_pairs p ON p.conversation_id = c.id
        WHERE p.user_low_id = $1 AND p.user_high_id = $2
        LIMIT 1`,
      [low, high]
    );
    let conversationId = found.rows[0]?.id;
    if (!conversationId) {
      const created = await pool.query(
        `INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`,
        [member.id]
      );
      conversationId = created.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, low, high]
      );
    }
    await pool.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, responded_at, joined_at)
       SELECT $1, u.id, 'member', 'member', NOW(), NOW()
         FROM users u WHERE u.id IN ($2, $3)
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, member.id, lin.id]
    );
    const spanishMessage = '¿Alguien puede revisar el cambio del botón antes del viernes?';
    const englishMessage = 'Can someone review the button change before Friday?';
    await pool.query(
      `INSERT INTO conversation_messages
         (conversation_id, sender_id, content, idempotency_key, created_at)
       VALUES ($1, $2, $3, 'staging-translate-demo-1', NOW() - INTERVAL '2 minutes')
       ON CONFLICT (conversation_id, sender_id, idempotency_key)
         WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL
       DO NOTHING`,
      [conversationId, lin.id, spanishMessage]
    );
    await pool.query(
      `INSERT INTO user_content_translations
         (source_digest, language, text, source_language, same_language, model, attempted_at)
       VALUES ($1, 'en', $2, 'es', FALSE, 'staging-fixture', NOW())
       ON CONFLICT (source_digest, language) DO NOTHING`,
      [digest(spanishMessage), englishMessage]
    );

    // #6525: the line in another language that `seedStagingGeneralChannel`
    // puts in #general, with the English auto-translate shows under it.
    const indonesianMessage = 'Pagi semua ☕ hari ini mau aku push update kecil di tryconnect, semoga lancar. Ada yang lagi main game seru di sini rekomendasi dong';
    const englishIndonesian = "Morning everyone ☕ today I'm pushing a small update to tryconnect, hope it goes smoothly. Is anyone playing a fun game here? Recommendations please";
    await pool.query(
      `INSERT INTO user_content_translations
         (source_digest, language, text, source_language, same_language, model, attempted_at)
       VALUES ($1, 'en', $2, 'id', FALSE, 'staging-fixture', NOW())
       ON CONFLICT (source_digest, language) DO NOTHING`,
      [digest(indonesianMessage), englishIndonesian]
    );

    // A request on a demo app, written by one of the fake people, with its
    // title and words translated. Its id is its number on the page.
    const app = await pool.query("SELECT id FROM apps WHERE slug = 'staging-demo-alpha'");
    if (!app.rows[0]?.id) {
      log.warn('db', 'Staging translation request skipped: demo app missing');
      return;
    }
    const title = 'La página del desafío no muestra por qué cuenta el progreso';
    const body = 'En la cuenta seacookie19910814, la solicitud #123 se convirtió en el cambio #124, '
      + 'y el cambio muestra que está en votación. La página del desafío dice que '
      + '"Suggest an improvement" cuenta una propuesta enviada a votación, pero el desafío sigue sin empezar.';
    const englishTitle = "The challenge page doesn't show why progress counts";
    const englishBody = 'On the account seacookie19910814, request #123 became change #124, and the '
      + 'change shows that it is up for a vote. The challenge page says that "Suggest an improvement" '
      + 'counts one proposal sent to a vote, but the challenge has still not started.';
    await pool.query(
      `INSERT INTO issues (id, app_id, title, description, created_by, status)
       VALUES (9056199, $1, $2, $3, $4, 'open')
       ON CONFLICT (id) DO NOTHING`,
      [app.rows[0].id, title, body, ada.id]
    );
    for (const [source, translated] of [[title, englishTitle], [body, englishBody]]) {
      await pool.query(
        `INSERT INTO user_content_translations
           (source_digest, language, text, source_language, same_language, model, attempted_at)
         VALUES ($1, 'en', $2, 'es', FALSE, 'staging-fixture', NOW())
         ON CONFLICT (source_digest, language) DO NOTHING`,
        [digest(source), translated]
      );
    }
    log.info('db', 'Staging translation fixtures seeded', { conversationId, issue: 9056199 });
  } catch (err) {
    log.warn('db', 'Staging translation fixtures seeding failed', { message: err.message });
  }
}

// #3228's before/after shots follow a group invitation card: who added the
// viewer and why, the group's name and how many people have already joined.
// A fresh clone has no pending invitation for the shots' member fixture, so
// one is seeded: a group owned by one of the fake speakers above, one fake
// member accepted, and usernode-capture invited with a note. Idempotent
// through the membership rows' primary key; strictly a no-op outside staging.
async function seedStagingGroupInviteNote(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = await pool.query(
      `SELECT id, username FROM users
        WHERE username IN ('usernode-capture', 'staging-demo-general-ada',
                           'staging-demo-general-lin', 'staging-code-signin@usernode.test')`
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const ada = people.rows.find((row) => row.username === 'staging-demo-general-ada');
    const lin = people.rows.find((row) => row.username === 'staging-demo-general-lin');
    // The proposal checks' sign-in fixture gets the same invitation, so a
    // check or a person driving the app as that account reaches the card
    // too. It is seeded later in the boot than this runs; skipped here and
    // self-healed by the next boot when it is not there yet.
    const viewer = people.rows.find((row) => row.username === 'staging-code-signin@usernode.test');
    if (!member || !ada || !lin || member.id === ada.id || member.id === lin.id) {
      log.warn('db', 'Staging group invite note skipped: fixture users missing');
      return;
    }
    const found = await pool.query(
      `SELECT c.id FROM conversations c
        JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
          AND cm.status = 'invited'
        JOIN conversation_members owner ON owner.conversation_id = c.id
          AND owner.user_id = $2 AND owner.role = 'owner'
       WHERE c.kind = 'group' AND c.title = $3
       LIMIT 1`,
      [member.id, ada.id, 'Friday demo crew (staging demo)']
    );
    let conversationId = found.rows[0]?.id;
    if (!conversationId) {
      const created = await pool.query(
        `INSERT INTO conversations (kind, title, created_by)
         VALUES ('group', $1, $2) RETURNING id`,
        ['Friday demo crew (staging demo)', ada.id]
      );
      conversationId = created.rows[0].id;
    }
    // The owner and the fake member have accepted; the capture member sits
    // on the invitation, with the note the card shows. Re-asserted on every
    // boot so a partial earlier boot self-heals.
    await pool.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, invited_by, responded_at, joined_at)
       SELECT $1, u.id, 'owner', 'member', u.id, NOW(), NOW()
         FROM users u WHERE u.id = $2
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, ada.id]
    );
    await pool.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, invited_by, responded_at, joined_at)
       SELECT $1, u.id, 'member', 'member', $2, NOW(), NOW()
         FROM users u WHERE u.id = $3
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, ada.id, lin.id]
    );
    await pool.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, invited_by, invite_note)
       SELECT $1, u.id, 'member', 'invited', $2,
              'Staging demo: planning the Friday demo, we need someone for the slides'
         FROM users u WHERE u.id = ANY($3::int[])
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, ada.id, [member.id, viewer?.id].filter(Boolean)]
    );
    log.info('db', 'Staging group invite note seeded', { conversationId });
  } catch (err) {
    log.warn('db', 'Staging group invite note seeding failed', { message: err.message });
  }
}

// #5393's before/after shots follow a group chat's ROW: two members' faces
// on its tile and the last sender before the preview. A fresh clone has no
// accepted group for the shots' member fixture, so two are seeded, both
// obviously fake: one whose last word was a fake member's ("@ada: …"), one
// whose last word was the member's own ("You: …"). Idempotent through the
// membership rows' primary key and the messages' idempotency keys; strictly
// a no-op outside staging.
async function seedStagingGroupFacesRows(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = await pool.query(
      `SELECT id, username FROM users
        WHERE username IN ('usernode-capture', 'staging-demo-general-ada',
                           'staging-demo-general-lin')`
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const ada = people.rows.find((row) => row.username === 'staging-demo-general-ada');
    const lin = people.rows.find((row) => row.username === 'staging-demo-general-lin');
    if (!member || !ada || !lin || member.id === ada.id || member.id === lin.id) {
      log.warn('db', 'Staging group faces rows skipped: fixture users missing');
      return;
    }
    // Both groups are owned by the fake member, with the capture member and
    // the other fake person accepted. Re-asserted on every boot so a partial
    // earlier boot self-heals.
    const conversationIdByTitle = {};
    for (const [title, others] of [
      ['Row faces crew (staging demo)', [member.id, lin.id]],
      ['Row faces own word (staging demo)', [member.id, lin.id]],
    ]) {
      const found = await pool.query(
        `SELECT c.id FROM conversations c
          JOIN conversation_members owner ON owner.conversation_id = c.id
            AND owner.user_id = $2 AND owner.role = 'owner'
         WHERE c.kind = 'group' AND c.title = $1
         LIMIT 1`,
        [title, ada.id]
      );
      let conversationId = found.rows[0]?.id;
      if (!conversationId) {
        const created = await pool.query(
          `INSERT INTO conversations (kind, title, created_by)
           VALUES ('group', $1, $2) RETURNING id`,
          [title, ada.id]
        );
        conversationId = created.rows[0].id;
      }
      await pool.query(
        `INSERT INTO conversation_members
           (conversation_id, user_id, role, status, responded_at, joined_at)
         SELECT $1, u.id, CASE WHEN u.id = $2 THEN 'owner' ELSE 'member' END,
                'member', NOW(), NOW()
           FROM users u WHERE u.id = ANY($3::int[])
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [conversationId, ada.id, [ada.id, ...others]]
      );
      conversationIdByTitle[title] = conversationId;
    }
    // The messages, inserted oldest-first per conversation so the later id
    // is the later word (the list reads the latest by id). The first group
    // ends on ada's word, the second on the member's own.
    const lines = [
      ['Row faces crew (staging demo)', lin.id,
        'Staging demo: anyone up for the Thursday standup?', 'crew-lin', 120],
      ['Row faces crew (staging demo)', ada.id,
        'Staging demo: ok sir, see you there', 'crew-ada', 60],
      ['Row faces own word (staging demo)', ada.id,
        'Staging demo: draft slides are in the folder', 'own-ada', 300],
      ['Row faces own word (staging demo)', member.id,
        'Staging demo: thanks, taking a look now', 'own-member', 60],
    ];
    let insertedCount = 0;
    for (const [title, senderId, content, slug, minutesAgo] of lines) {
      const row = await pool.query(
        `INSERT INTO conversation_messages
           (conversation_id, sender_id, content, idempotency_key, created_at)
         VALUES ($1, $2, $3, 'staging-row-faces-' || $4,
                 NOW() - ($5 * INTERVAL '1 minute'))
         ON CONFLICT (conversation_id, sender_id, idempotency_key)
           WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL
         DO NOTHING`,
        [conversationIdByTitle[title], senderId, content, slug, minutesAgo]
      );
      insertedCount += row.rowCount;
    }
    if (insertedCount > 0) {
      log.info('db', 'Staging group faces rows seeded', { inserted: insertedCount });
    }
  } catch (err) {
    log.warn('db', 'Staging group faces rows seeding failed', { message: err.message });
  }
}

// Desktop polish 11's before/after shots hover a CONTINUATION line from
// somebody else in a group chat: a second, third and fourth message in one
// person's run, with no name line over it, in bubbles short and long (one
// narrower than the hover bar), and a reply thread with three replies in a
// row from one person. A fresh clone's conversations for the shots' member
// fixture alternate speakers line by line, so none has one; this seeds one
// group, owned by a fake person, with the member and the other fake person
// accepted. Obviously fake, idempotent through the membership rows' primary
// key and the messages' idempotency keys, and a strict no-op outside
// staging. One minute apart, so the run holds together on screen.
async function seedStagingFollowUpBubbles(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = await pool.query(
      `SELECT id, username FROM users
        WHERE username IN ('usernode-capture', 'staging-demo-general-ada',
                           'staging-demo-general-lin')`
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const ada = people.rows.find((row) => row.username === 'staging-demo-general-ada');
    const lin = people.rows.find((row) => row.username === 'staging-demo-general-lin');
    if (!member || !ada || !lin || member.id === ada.id || member.id === lin.id) {
      log.warn('db', 'Staging follow-up bubbles skipped: fixture users missing');
      return;
    }
    const title = 'Follow-up bubbles (staging demo)';
    const found = await pool.query(
      `SELECT c.id FROM conversations c
        JOIN conversation_members owner ON owner.conversation_id = c.id
          AND owner.user_id = $2 AND owner.role = 'owner'
       WHERE c.kind = 'group' AND c.title = $1
       LIMIT 1`,
      [title, lin.id]
    );
    let conversationId = found.rows[0]?.id;
    if (!conversationId) {
      conversationId = (await pool.query(
        `INSERT INTO conversations (kind, title, created_by)
         VALUES ('group', $1, $2) RETURNING id`,
        [title, lin.id]
      )).rows[0].id;
    }
    await pool.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, responded_at, joined_at)
       SELECT $1, u.id, CASE WHEN u.id = $2 THEN 'owner' ELSE 'member' END,
              'member', NOW(), NOW()
         FROM users u WHERE u.id = ANY($3::int[])
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, lin.id, [lin.id, ada.id, member.id]]
    );
    // Oldest first, so the later id is the later word.
    const lines = [
      ['lin-1', lin.id, 'Staging demo: morning! Two things before the Friday demo.', 30],
      ['lin-2', lin.id, 'Staging demo: first, can we move the walkthrough to after lunch, so the people joining from the other office are awake for it, and keep the questions for the end? I can take the slides if nobody else wants them.', 29],
      ['lin-3', lin.id, 'Staging demo: second, who brings the coffee?', 28],
      ['member-1', member.id, 'Staging demo: after lunch works for me.', 20],
      ['ada-1', ada.id, 'Staging demo: same here, after lunch suits me.', 10],
      ['ada-2', ada.id, 'Staging demo: coffee ☕', 9],
    ];
    let inserted = 0;
    let rootId = null;
    for (const [slug, senderId, content, minutesAgo] of lines) {
      const row = await pool.query(
        `INSERT INTO conversation_messages
           (conversation_id, sender_id, content, idempotency_key, created_at)
         VALUES ($1, $2, $3, 'staging-follow-up-' || $4, NOW() - ($5 * INTERVAL '1 minute'))
         ON CONFLICT (conversation_id, sender_id, idempotency_key)
           WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [conversationId, senderId, content, slug, minutesAgo]
      );
      inserted += row.rowCount;
      if (slug === 'lin-1' && row.rows[0]) rootId = row.rows[0].id;
    }
    // The thread under the first line, inserted with it: three replies in a
    // row from the other fake person, the last narrower than the bar.
    if (rootId) {
      await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id, created_at)
         VALUES ($1, $2, 'Staging demo: what is the second thing?', $3, NOW() - INTERVAL '27 minutes'),
                ($1, $2, 'Staging demo: oh, the coffee. Never mind, I see it now in the chat, and I am happy to help carry the cups from the kitchen.', $3, NOW() - INTERVAL '26 minutes'),
                ($1, $2, 'Staging demo: thanks', $3, NOW() - INTERVAL '25 minutes')`,
        [conversationId, ada.id, rootId]
      );
    }
    if (inserted > 0) log.info('db', 'Staging follow-up bubbles seeded', { inserted });
  } catch (err) {
    log.warn('db', 'Staging follow-up bubbles seeding failed', { message: err.message });
  }
}

// Declared dapp.json checks are authenticated as this exact view-only user
// (services/visuals.js), not as the first administrator in the database.
// Owner-scoped staging fixtures must therefore resolve their owner by
// username: production clones can contain older admins with lower ids, and
// choosing one of those leaves a check on a fixed change id without the
// author's controls it asserts.
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
  // A platform preview's database can start empty (SEC-06), and the sign-in
  // tokens it accepts are bound to production's app id (USERNODE_APP_ID), so
  // the row is made with that id there and the sequence moved past it.
  const previewAppId = process.env.USERNODE_ENV === 'staging' && /^[1-9][0-9]{0,9}$/.test(process.env.USERNODE_APP_ID || '')
    ? Number(process.env.USERNODE_APP_ID) : null;

  // Single UPSERT keyed on slug. Insert covers fresh-DB; the DO UPDATE
  // covers every subsequent boot so main_sha and manifest_snapshot
  // reflect the running build. The insert seeds name='Homeroom'; the
  // DO UPDATE deliberately does NOT touch name — the reconcile below is
  // the single place the self-app display name is resolved from
  // dapp.json (so a merged self-app rename PR actually applies on the
  // post-deploy reboot, same as child apps do in deployProduction).
  const { rows: selfRows } = await pool.query(
    `INSERT INTO apps
       (id, name, slug, repo_url, container_id, status, self_hosted,
        main_sha, last_deploy_at, manifest_snapshot)
     VALUES
       (COALESCE($5::int, nextval(pg_get_serial_sequence('apps', 'id'))), 'Homeroom', $1, $2, 'usernode', 'running', TRUE,
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
      previewAppId,
    ]
  );
  if (previewAppId) {
    await pool.query(
      `SELECT setval(q.seq, GREATEST($1::bigint, COALESCE(s.last_value, 0)))
         FROM (SELECT pg_get_serial_sequence('apps', 'id') AS seq) q
         JOIN pg_sequences s ON format('%I.%I', s.schemaname, s.sequencename) = q.seq`,
      [previewAppId]
    );
  }

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
    // GitHub Actions (deployProduction never runs for it), so this
    // boot-time reconcile is where a merged governance-change PR's
    // proposal-approval settings actually apply.
    await appManifest.reconcileAppGovernance(pool, selfRows[0], manifest)
      .catch((err) => log.warn('db', 'Self-app governance reconcile failed', { err: err.message }));
    // And the `topics` array (#4417), for the same reason: the self-app
    // never runs deployProduction, so a merged topics PR's new topic,
    // rename, merge or archive applies on the post-deploy boot.
    await appManifest.reconcileAppTopics(pool, selfRows[0], manifest)
      .catch((err) => log.warn('db', 'Self-app topics reconcile failed', { err: err.message }));
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
// Staging only: a few made-up helper calls (Homeroom bot → Calls,
// llm-telemetry.js helperCallsReport), so a fresh preview's Calls tab has
// rows to show: quick replies on GLM then on DeepSeek V4.1 Flash 1017, one
// late and answered by Haiku, and a plan at Make it. Content-free, like the
// ledger itself; nothing reads these to decide anything. Idempotent: each
// row's invocation key is unique (idx_events_llm_invocation_key).
async function seedStagingHelperCalls(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const GLM = 'z-ai/glm-5.3-flash';
  const DS = 'deepseek/deepseek-v4.1-flash-1017';
  const HAIKU = 'claude-haiku-5-5';
  const calls = [
    ['quick_replies', 1, GLM, 'success', 820, 0.00009, null, 2],
    ['quick_replies', 1, GLM, 'error', 2500, null, 'timeout', 2],
    ['quick_replies', 2, HAIKU, 'success', 900, 0.0004, null, 2],
    ['quick_replies', 1, DS, 'success', 560, 0.00008, null, 1],
    ['quick_replies', 1, DS, 'success', 610, 0.00009, null, 1],
    ['quick_replies', 1, DS, 'success', 700, 0.0001, null, 1],
    ['first_version_plan', 1, DS, 'success', 1700, 0.0003, null, 1],
    ['first_version_plan', 1, DS, 'success', 2300, 0.0003, null, 1],
    ['content_review', 1, DS, 'success', 640, 0.0001, null, 1],
  ];
  try {
    let run = 0;
    for (let i = 0; i < calls.length; i += 1) {
      const [component, attempt, model, outcome, ms, cost, errorClass, daysAgo] = calls[i];
      if (attempt === 1) run += 1;
      const metadata = {
        invocation_key: `staging-demo-helper-${i + 1}`,
        provider: model === HAIKU ? 'anthropic' : 'openrouter',
        backend: 'helper', component, requested_model: model, served_model: outcome === 'success' ? model : null,
        billing_path: 'platform', outcome, duration_ms: ms,
        cost_usd: cost, cost_source: cost == null ? 'unavailable' : 'provider_reported',
        attempt_number: attempt, correlation_id: `staging-demo-call-${run}`,
        ...(errorClass ? { error_class: errorClass } : {}),
      };
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO events (event_type, metadata, created_at)
         VALUES ('llm_invocation', $1::jsonb, NOW() - make_interval(days => $2::int))
         ON CONFLICT DO NOTHING`,
        [JSON.stringify(metadata), daysAgo],
      );
    }
  } catch (err) {
    log.warn('db', 'Staging helper calls not seeded', { err: err.message });
  }
}

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

    // Also the admin's invite link to Homeroom (/welcome/STAGING-DEMO-UNUSED,
    // services/access-links.js), with the note an admin writes for who it is for.
    await pool.query(
      `INSERT INTO activation_codes (code, note)
       VALUES ('STAGING-DEMO-UNUSED', 'Sample: a creator trying Homeroom (staging fixture)')
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

// A moderation case for the console's Moderation section (#5072). The
// moderation tables are staging:private, so a preview clone starts with an
// empty queue and the section's deep link (#admin/reports/<id>) has nothing
// to open. Two obviously-fake people of their own, never the viewer, and a
// report that says it is a staging fixture. Idempotent: the case keys on its
// UNIQUE(target_type, target_id), the report on an existence check scoped to
// the fake target. Strictly a no-op outside staging.
async function seedStagingModerationCase(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (id, username, password, profile_published)
       VALUES (900320, 'staging-demo-reported', 'staging-demo-not-a-login', TRUE),
              (900321, 'staging-demo-reporter', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO moderation_cases (target_type, target_id, target_label, target_user_id, status)
       VALUES ('user', 900320, '@staging-demo-reported', 900320, 'new')
       ON CONFLICT (target_type, target_id) DO NOTHING`
    );
    const has = await pool.query(
      `SELECT 1 FROM moderation_reports r JOIN moderation_cases c ON c.id = r.case_id
        WHERE c.target_type = 'user' AND c.target_id = 900320 LIMIT 1`
    );
    if (!has.rowCount) {
      await pool.query(
        `INSERT INTO moderation_reports (case_id, cycle, reporter_user_id, reason, detail, evidence)
         SELECT c.id, c.cycle, 900321, 'spam',
                'Staging fixture: a fake report so the Moderation screens have a case to open.',
                NULL
           FROM moderation_cases c
          WHERE c.target_type = 'user' AND c.target_id = 900320`
      );
    }
    // #5102: a second fake case, reported for child safety, so the queue
    // shows a case sorted to the top with its marks. Inserted after the first
    // so the first keeps case id 1 (the deep-link check opens it).
    await pool.query(
      `INSERT INTO users (id, username, password, profile_published)
       VALUES (900322, 'staging-demo-flagged', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO moderation_cases (target_type, target_id, target_label, target_user_id, status, preserve_evidence)
       VALUES ('user', 900322, '@staging-demo-flagged', 900322, 'new', TRUE)
       ON CONFLICT (target_type, target_id) DO NOTHING`
    );
    const hasChildSafety = await pool.query(
      `SELECT 1 FROM moderation_reports r JOIN moderation_cases c ON c.id = r.case_id
        WHERE c.target_type = 'user' AND c.target_id = 900322 LIMIT 1`
    );
    if (!hasChildSafety.rowCount) {
      await pool.query(
        `INSERT INTO moderation_reports (case_id, cycle, reporter_user_id, reason, detail, evidence)
         SELECT c.id, c.cycle, 900321, 'child_safety',
                'Staging fixture: a fake child-safety report so the Moderation queue shows a priority case.',
                NULL
           FROM moderation_cases c
          WHERE c.target_type = 'user' AND c.target_id = 900322`
      );
    }
    log.info('db', 'Staging moderation case seeded');
  } catch (err) {
    log.warn('db', 'Staging moderation case seeding failed', { message: err.message });
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
    const knownHash = await bcrypt.hash('staging-code-password', STAGING_FIXTURE_BCRYPT_COST);
    // Nobody knows what this one hashes: 32 random bytes, thrown away.
    const unusableHash = await bcrypt.hash(
      crypto.randomBytes(32).toString('hex'),
      STAGING_FIXTURE_BCRYPT_COST
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
// resolves — so a process killed mid-export (deploy cutover, OOM, hard
// crash) leaves the row stuck in `requested` or `streaming`. A boot settles
// the ones nothing will finish: a dump whose process stopped renewing it,
// and a request whose ticket expired (services/db-export.js
// settleAbandoned, which a claim runs too). A dump another process still
// streams is left alone. NOT staging-gated — this is a production
// correctness sweep.
async function sweepInterruptedDbExports(pool) {
  try {
    const count = await require('../services/db-export').settleAbandoned(pool);
    if (count) {
      log.warn('db', 'Marked stale database exports interrupted', { count });
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

  // #5527: the capture account's unread backlog — the exact shape the bell
  // could not show before this change. 120 obviously-fake READ rows newer
  // than everything, so the sheet's first page is full of read rows, and 5
  // UNREAD rows older than all of them, so the badge counts rows the first
  // page never reaches and the Unread tab has to fill itself up to the
  // bell. Fixture rows only: a person can spot every one of them as fake,
  // and nothing in the code reads their presence to decide anything.
  const { rows: captureRows } = await pool.query(
    `SELECT id FROM users WHERE username = $1 LIMIT 1`,
    ['usernode-capture']
  );
  let unreadBacklogInserted = 0;
  if (captureRows.length) {
    const captureId = captureRows[0].id;
    for (const [prefix, unread, count, ageFloor] of [
      ['[staging fixture] unread-backlog read notification', false, 120, 1],
      ['[staging fixture] unread-backlog UNREAD notification', true, 5, 230],
    ]) {
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at)
         SELECT $1, $2, $3 || ' #' || g, 'message',
                NOW() - (($4::int + g) * INTERVAL '1 minute')
           FROM generate_series(1, $5) AS g
          WHERE NOT EXISTS (
            SELECT 1 FROM chat_messages m
             WHERE m.app_id = $1 AND m.content = $3 || ' #' || g
          )`,
        [appId, source.id, prefix, ageFloor, count]
      );
      const { rowCount } = await pool.query(
        `INSERT INTO notifications
           (user_id, app_id, chat_message_id, source_user_id, kind, read_at, created_at)
         SELECT $1, $2, m.id, $3, 'mention',
                CASE WHEN $4 THEN NULL ELSE NOW() - INTERVAL '1 minute' END,
                m.created_at
           FROM chat_messages m
          WHERE m.app_id = $2
            AND m.content LIKE $5 || ' #%'
            AND NOT EXISTS (
              SELECT 1 FROM notifications n
               WHERE n.user_id = $1 AND n.chat_message_id = m.id
            )`,
        [captureId, appId, source.id, unread, prefix]
      );
      if (unread) unreadBacklogInserted = rowCount || 0;
    }
  }

  log.info('db', 'Staging notification fixtures seeded', {
    targetUser: target.username,
    inserted,
    multiAppInserted,
    backlogInserted,
    unreadBacklogInserted,
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
// B9: a message in the platform's own chat that asked Homeroom bot for a
// change, wearing the status chip everybody in the room sees ("Building").
// The bot never acts on staging, so without this a preview has no chat
// request to show. Its author is a staging demo account, never whoever
// opened the preview; the requester's private card is theirs alone and is
// not seeded. Idempotent by explicit id; a no-op outside staging.
async function seedStagingBotChatRequest(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const { rows: appRows } = await pool.query(
      'SELECT id FROM apps WHERE slug = $1',
      [config.selfAppSlug]
    );
    const appId = appRows[0]?.id;
    if (!appId) {
      log.warn('db', 'Staging bot chat request skipped: self-app row missing', { slug: config.selfAppSlug });
      return;
    }
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES (900083, 'staging-demo-asker', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO chat_messages (id, app_id, user_id, content, msg_type, metadata, created_at)
       VALUES (900083, $1, 900083,
               'Staging demo: @Homeroom bot could the plant list show which ones need water today?',
               'message', '{"botRequest": {"status": "building"}}', NOW() - INTERVAL '2 minutes')
       ON CONFLICT DO NOTHING`,
      [appId]
    );
    log.info('db', 'Staging bot chat request seeded');
  } catch (err) {
    log.warn('db', 'Staging bot chat request seeding failed', { message: err.message });
  }
}

// 17 Nov 2026 (#6763): New project under the bot's reply. Someone who says
// they want to make a new app is told to tap New project, and the button is
// offered with that reply (metadata.homeroomBot.newProject, which the
// thread's foot reads). A staging copy runs no model, so the exchange is
// stored for the shots' member fixture (usernode-capture): their private
// thread, the bot's reply, and the thread's row. The thread is a "+" one
// (kind 'ask') whose chip was preset to Homeroom, so app_id is set: the
// project is where they happened to be, not what the idea is about, and the
// foot still shows New project. Nothing here is a signal the bot reads to
// decide anything. Idempotent through the root message's key and the private
// thread's unique root; strictly a no-op outside staging.
async function seedStagingNewProjectOfferThread(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const people = await pool.query(
      `SELECT id, username FROM users WHERE username IN ('usernode-capture', 'homeroom_bot')`,
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const bot = people.rows.find((row) => row.username === 'homeroom_bot');
    if (!member || !bot || member.id === bot.id) return;
    const low = Math.min(member.id, bot.id);
    const high = Math.max(member.id, bot.id);
    const found = await pool.query(
      'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2',
      [low, high],
    );
    let conversationId = found.rows[0]?.conversation_id;
    if (!conversationId) {
      const created = await pool.query(
        'INSERT INTO conversations (kind, created_by) VALUES (\'direct\', $1) RETURNING id',
        [member.id],
      );
      conversationId = created.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, low, high],
      );
    }
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'member'), ($1, $3, 'member', 'member')
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET status = 'member'`,
      [conversationId, member.id, bot.id],
    );
    const key = 'staging-demo-new-project-offer-thread';
    const had = await pool.query(
      'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3',
      [conversationId, member.id, key],
    );
    const idea = 'A garden planner for my street: it shows which plants need water this week and who is watering '
      + 'them. Neighbours join with an invite link and see the shared list, while each household keeps its own '
      + 'notes private, and everyone can tick off a watering and see who is next.';
    // 17 Nov 2026 (#6781): the offer now carries the brief and the name the
    // make screen opens with. A copy seeded before them gets both here.
    const brief = {
      homeroomBot: {
        kind: 'chat', newProject: true,
        projectIdea: idea,
        projectName: 'Street Garden',
        looked: { items: [{ what: 'how a new project starts' }], ms: 7000 },
      },
    };
    // #6783: the offer is a card under the reply, so the reply points at it
    // rather than at a button at the foot of the thread. The reply keeps
    // `newProject` as the fallback an older reply has.
    const reply = 'Staging demo: here is the plan from your answers. It shows this week\'s plants and who waters '
      + 'them, and each person can tick theirs off. Check the name and what it will do below, then Make it.';
    let rootId;
    if (had.rows[0]) {
      rootId = had.rows[0].id;
      await pool.query(
        `UPDATE conversation_messages
            SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, content = $4
          WHERE conversation_id = $2 AND sender_id = $3 AND metadata->'homeroomBot'->>'newProject' = 'true'`,
        [JSON.stringify(brief), conversationId, bot.id, reply],
      );
    } else {
      const root = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, idempotency_key, created_at)
         VALUES ($1, $2, 'Staging demo: I want to work on a new app, can you help me do that?', $3,
                 NOW() - INTERVAL '10 minutes')
         RETURNING id`,
        [conversationId, member.id, key],
      );
      rootId = root.rows[0].id;
      // The plan comes first, as the prompt now says: the bot asks what the app
      // should do, the person answers, and its plan carries the offer.
      await pool.query(
        `INSERT INTO conversation_messages
           (conversation_id, sender_id, content, thread_root_id, created_at)
         VALUES ($1, $2, $3, $4, NOW() - INTERVAL '9 minutes')`,
        [
          conversationId, bot.id,
          'I can help. What should the app do, and who is it for? I will put a plan here for you before anything gets '
            + 'built.',
          rootId,
        ],
      );
      await pool.query(
        `INSERT INTO conversation_messages
           (conversation_id, sender_id, content, thread_root_id, created_at)
         VALUES ($1, $2, 'Staging demo: a garden planner for my street: which plants need water this week, and who is '
                          || 'watering them.', $3, NOW() - INTERVAL '5 minutes')`,
        [conversationId, member.id, rootId],
      );
      await pool.query(
        `INSERT INTO conversation_messages
           (conversation_id, sender_id, content, thread_root_id, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW() - INTERVAL '2 minutes')`,
        [conversationId, bot.id, reply, rootId, JSON.stringify(brief)],
      );
    }
    // #6783: the card itself, the newest message in the thread: the name the
    // bot suggested and what it will do. A copy seeded before it gets it once.
    const cardKey = 'staging-demo-new-project-card';
    await pool.query(
      `INSERT INTO conversation_messages
         (conversation_id, sender_id, content, thread_root_id, metadata, idempotency_key, created_at)
       SELECT $1, $2, '**Street Garden** · a new project', $3, $4::jsonb, $5::text, NOW() - INTERVAL '1 minute'
        WHERE NOT EXISTS (
          SELECT 1 FROM conversation_messages WHERE conversation_id = $1 AND idempotency_key = $5::text
        )`,
      [
        conversationId, bot.id, rootId,
        JSON.stringify({
          homeroomBot: {
            kind: 'make_offer', question: 'Make Street Garden?',
            makeProject: { name: 'Street Garden', rootId, version: null, brief: idea },
            projectIdea: idea, projectName: 'Street Garden',
            actions: [{ id: 'make', label: 'Make it', style: 'primary', type: 'make' }],
            status: 'open', mirrors: false,
          },
        }),
        cardKey,
      ],
    );
    const platform = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1');
    await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state)
       VALUES ($1, $2, $3, $4, 'ask', 'open')
       ON CONFLICT (root_message_id) DO NOTHING`,
      [member.id, conversationId, rootId, platform.rows[0]?.id || null],
    );
    log.info('db', 'Staging new project offer thread seeded');
  } catch (err) {
    log.warn('db', 'Staging new project offer thread seeding failed', { message: err.message });
  }
}

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
// apply branch (write via the platform-env DAO, no deployProduction) and
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

  // #6547: one merge LAST WEEK, before the same point in the week, so a
  // fresh staging copy's Workshop has a "by this time last week" figure to
  // compare against. Timed from the server's own calendar week, so it sits
  // inside last week's to-date window (last Monday 00:00 to now minus seven
  // days) whatever day the build runs. Idempotent through the branch name.
  {
    const branch = 'staging-fixture/merged-pr-to-date';
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch]
    );
    if (!existing.length) {
      const author = users[0];
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status,
            votes_required, active_users_at_merge, created_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, 'merged', $7, $8,
            date_trunc('week', NOW()) - INTERVAL '7 days')
         RETURNING id`,
        [appId, author.id, branch, 9110,
         '[staging fixture] Tidy the workshop tiles for small screens',
         'In plain terms: this completed change improves the app for everyone who uses it, with no extra steps needed on your part.',
         Math.max(1, Math.ceil(users.length / 2)), users.length]
      );
      await pool.query(
        `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
         VALUES ($1, $2, 'yes', date_trunc('week', NOW()) - INTERVAL '7 days' + INTERVAL '2 hours')
         ON CONFLICT (session_id, user_id) DO NOTHING`,
        [rows[0].id, author.id]
      );
      inserted++;
    }
  }

  log.info('db', 'Staging merged-PR fixtures seeded', {
    appId,
    total: fixtures.length,
    inserted,
  });
}

// #5482's before/after shots follow a bell row that names a change which has
// already merged: before, its "Voted yes" row is in the list, with the unread
// news that the change went live beside it; after (#5487, like #5482), the
// news row is gone from the list too — it is seeded unread exactly so the
// before side shows it and the after side does not. A fresh clone has no
// such pair for the shots' member fixture (usernode-capture), so one is
// seeded: a fake merged change with an unread "Voted yes" row from one of
// the fake speakers, and the unread merge news beside it. Idempotent through
// the branch name and the (user, kind, session) lookup; strictly a no-op
// outside staging.
async function seedStagingMergedVoteRow(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = await pool.query(
      `SELECT id, username FROM users
        WHERE username IN ('usernode-capture', 'staging-demo-general-ada')`
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const voter = people.rows.find((row) => row.username === 'staging-demo-general-ada');
    if (!member || !voter || member.id === voter.id) {
      log.warn('db', 'Staging merged-vote row skipped: fixture users missing');
      return;
    }
    const { rows: appRows } = await pool.query(
      'SELECT id FROM apps WHERE slug = $1', [config.selfAppSlug]
    );
    const appId = appRows[0]?.id;
    if (!appId) {
      log.warn('db', 'Staging merged-vote row skipped: self-app row missing', {
        slug: config.selfAppSlug,
      });
      return;
    }

    const branch = 'staging-fixture/merged-vote-row';
    let sessionId;
    const { rows: sessionRows } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch]
    );
    if (sessionRows.length) {
      sessionId = sessionRows[0].id;
    } else {
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_title, session_title, status,
            merged_at, live_at, created_at)
         VALUES
           ($1, $2, $3, 9042, '[staging fixture] Books read list',
            '[staging fixture] Books read list', 'merged',
            NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours',
            NOW() - INTERVAL '1 day')
         RETURNING id`,
        [appId, voter.id, branch]
      );
      sessionId = rows[0].id;
    }

    const fixtures = [
      { kind: 'proposal_vote', sourceUserId: voter.id, detail: 'yes', minutesAgo: 200 },
      // The news that it went live: listed before #5487 (this proposal's
      // before side), gone from the list after, stored all the same.
      { kind: 'voted_change_merged', sourceUserId: null, detail: null, minutesAgo: 170 },
    ];
    let inserted = 0;
    for (const f of fixtures) {
      const { rowCount } = await pool.query(
        `INSERT INTO notifications
           (user_id, app_id, session_id, source_user_id, kind, detail, read_at, created_at)
         SELECT $1::int, $2::int, $3::int, $4::int, $5::varchar, $6::varchar,
                NULL, NOW() - ($7::int * INTERVAL '1 minute')
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications n
             WHERE n.user_id = $1 AND n.session_id = $3 AND n.kind = $5)
           RETURNING id`,
        [member.id, appId, sessionId, f.sourceUserId, f.kind, f.detail, f.minutesAgo]
      );
      inserted += rowCount;
    }
    if (inserted > 0) {
      log.info('db', 'Staging merged-vote row seeded', { sessionId, inserted });
    }
  } catch (err) {
    log.warn('db', 'Staging merged-vote row seeding failed', { message: err.message });
  }
}

// #7216's shots: a request's thread where a No vote's reason was handed to
// Homeroom bot. The reason is the voter's own reply in the change's
// discussion (routes/votes.js postOnProposal) and the vote row names it
// (`metadata.vote.reasonMessageId`), so the request's page can draw one vote
// line, "usernode-capture voted no: “…”", in place of the plain message it
// used to be.
// A fresh staging copy has no such state (nothing there runs the hand-off),
// so it is seeded here, obviously fake: the shots' member fixture is the
// voter and a second fixture account is the Yes that kept its own reason.
// Idempotent by request number; strictly a no-op outside staging.
async function seedStagingVoteReasonOnRequest(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const number = 900719;
  const changeNumber = 900719;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const app = (await tx.query('SELECT id, community_id FROM apps WHERE slug = $1', [config.selfAppSlug])).rows[0];
    if (!app) { await tx.query('ROLLBACK'); return seedSkipped('no self-app row'); }
    const people = (await tx.query(
      "SELECT id, username FROM users WHERE username IN ('usernode-capture', 'usernode-capture-admin', 'homeroom_bot')",
    )).rows;
    const member = people.find((row) => row.username === 'usernode-capture');
    const other = people.find((row) => row.username === 'usernode-capture-admin');
    const bot = people.find((row) => row.username === 'homeroom_bot');
    if (!member || !bot) { await tx.query('ROLLBACK'); return seedSkipped('no user usernode-capture or homeroom_bot'); }
    const { rowCount } = await tx.query(
      `INSERT INTO requests (app_id, number, title, body, created_by, created_at, updated_at)
       VALUES ($1, $2, 'Staging demo: keep the request list in its order after a refresh',
               'Staging demo: obviously fake. Its change waits on a vote, and a No came with a reason for Homeroom bot.',
               $3, NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 day')
       ON CONFLICT DO NOTHING`,
      [app.id, number, member.id],
    );
    if (!rowCount) { await tx.query('ROLLBACK'); return; }
    // The feed lists a project the viewer is a MEMBER of.
    if (app.community_id) {
      await tx.query(
        `INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [app.community_id, member.id],
      );
    }
    const change = (await tx.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, session_title, pr_title, pr_number, status, linked_issues,
          promoted_at, check_state, created_at, last_activity_at)
       VALUES ($1, $2, 'staging-fixture/vote-reason-on-request',
               'Staging demo: sort the request list on the server',
               'Staging demo: sort the request list on the server', $3, 'promoted',
               ARRAY[$4::int]::int[], NOW() - INTERVAL '1 day', 'passing',
               NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day')
       RETURNING id`,
      [app.id, bot.id, changeNumber, number],
    )).rows[0];
    const reasonText = 'I do not agree with the approach. Sorting should happen on the server.';
    const reason = (await tx.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
       VALUES ($1, $2, $3, 'message', 'session', $4, $5, NOW() - INTERVAL '20 hours')
       RETURNING id`,
      [app.id, member.id, reasonText, change.id, JSON.stringify({ stagingDemo: 'vote-reason-on-request' })],
    )).rows[0];
    // The vote row names the reply that carried its reason (#7216).
    await tx.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
       VALUES ($1, NULL, $2, 'vote', 'session', $3, $4, NOW() - INTERVAL '20 hours' + INTERVAL '20 seconds')`,
      [app.id, `${member.username} voted no on PR #${changeNumber}: Staging demo: sort the request list on the server`,
        change.id, JSON.stringify({ vote: { sessionId: change.id, prNumber: changeNumber, reason: null, reasonMessageId: reason.id } })],
    );
    // A Yes that kept its own reason on the row, as every vote not handed to
    // the bot does, and a person's reply that stays a message.
    if (other) {
      await tx.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
         VALUES ($1, NULL, $2, 'vote', 'session', $3, $4, NOW() - INTERVAL '19 hours')`,
        [app.id, `${other.username} voted yes: “Small and right.”`, change.id,
          JSON.stringify({ vote: { sessionId: change.id, prNumber: changeNumber, reason: 'Small and right.' } })],
      );
      await tx.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, created_at)
         VALUES ($1, $2, 'Looks fine on my phone. The sort order is the one thing to check.', 'message', 'session', $3, '{}'::jsonb, NOW() - INTERVAL '18 hours')`,
        [app.id, other.id, change.id],
      );
    }
    await tx.query('COMMIT');
    log.info('db', 'Staging vote-reason-on-request seeded', { appId: app.id, number, sessionId: change.id });
  } catch (err) {
    await tx.query('ROLLBACK');
    log.warn('db', 'Staging vote-reason-on-request seeding failed', { message: err.message });
  } finally { tx.release(); }
}

// #6124: a change renamed before it has a pull request is saved as the name
// that pull request will take (proposed_pr_title), and the card reads it
// before the session's old name. A fresh clone has no such row for the
// shots' member fixture, so one is seeded on the self app, owned by
// usernode-capture and still Underway. Idempotent through the branch name;
// strictly a no-op outside staging.
async function seedStagingRenamedChange(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const { rows: people } = await pool.query(
      "SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1"
    );
    const member = people[0];
    if (!member) {
      log.warn('db', 'Staging renamed-change fixture skipped: fixture user missing');
      return seedSkipped('no user usernode-capture');
    }
    const { rows: appRows } = await pool.query(
      'SELECT id FROM apps WHERE slug = $1', [config.selfAppSlug]
    );
    const appId = appRows[0]?.id;
    if (!appId) {
      log.warn('db', 'Staging renamed-change fixture skipped: self-app row missing', {
        slug: config.selfAppSlug,
      });
      return;
    }
    const branch = 'staging-fixture/renamed-change';
    const { rowCount } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, session_title, proposed_pr_title, status,
          created_at, last_activity_at)
       SELECT $1::int, $2::int, $3::varchar, $4::text, $5::text, 'active',
              NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '5 minutes'
        WHERE NOT EXISTS (
          SELECT 1 FROM chat_sessions WHERE app_id = $1 AND branch_name = $3)`,
      [
        appId, member.id, branch,
        '[staging fixture] Add dark mdoe toggel to settings',
        '[staging fixture] Add a dark mode toggle to Settings',
      ]
    );
    if (rowCount) {
      log.info('db', 'Staging renamed-change fixture seeded', { appId });
    }
  } catch (err) {
    log.warn('db', 'Staging renamed-change fixture seeding failed', { message: err.message });
  }
}

// The one model of a change: a change shared in a message is named as every
// other screen names it (its pull request's title, else the one chosen before
// it had one, else its session's name). The share card led with the session's
// old name. The renamed change above is the case: its correction is in
// proposed_pr_title, so this shares it in a direct thread between the shots'
// member fixture and one of #general's fake speakers, where its card shows
// the name. Obviously fake, idempotent through the direct pair, the message's
// idempotency key and the card's position; strictly a no-op outside staging.
// Nothing here is a signal the code reads to decide anything.
async function seedStagingSharedRenamedChange(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const people = await pool.query(
      `SELECT id, username FROM users
        WHERE username IN ('usernode-capture', 'staging-demo-general-lin')`
    );
    const member = people.rows.find((row) => row.username === 'usernode-capture');
    const other = people.rows.find((row) => row.username === 'staging-demo-general-lin');
    if (!member || !other || member.id === other.id) {
      log.warn('db', 'Staging shared renamed change skipped: fixture users missing');
      return seedSkipped('no user usernode-capture or staging-demo-general-lin');
    }
    const { rows: [change] } = await pool.query(
      `SELECT cs.id, cs.app_id FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
        WHERE a.slug = $1 AND cs.branch_name = 'staging-fixture/renamed-change'
        ORDER BY cs.id ASC LIMIT 1`,
      [config.selfAppSlug]
    );
    if (!change) return seedSkipped('no renamed change');
    const low = Math.min(member.id, other.id);
    const high = Math.max(member.id, other.id);
    const found = await pool.query(
      'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2',
      [low, high]
    );
    let conversationId = found.rows[0]?.conversation_id;
    if (!conversationId) {
      const created = await pool.query(
        `INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`,
        [member.id]
      );
      conversationId = created.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, low, high]
      );
    }
    await pool.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, responded_at, joined_at)
       SELECT $1, u.id, 'member', 'member', NOW(), NOW()
         FROM users u WHERE u.id IN ($2, $3)
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, member.id, other.id]
    );
    const key = 'staging-demo-shared-renamed-change';
    await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, idempotency_key, created_at)
       VALUES ($1, $2, 'Staging demo: the change I renamed, have a look', $3, NOW() - INTERVAL '2 days')
       ON CONFLICT (conversation_id, sender_id, idempotency_key)
         WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL
       DO NOTHING`,
      [conversationId, member.id, key]
    );
    const { rows: [message] } = await pool.query(
      'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3',
      [conversationId, member.id, key]
    );
    if (!message) return;
    await pool.query(
      `INSERT INTO conversation_message_objects (message_id, position, object_type, app_id, object_ref)
       VALUES ($1, 0, 'code_proposal', $2, $3) ON CONFLICT (message_id, position) DO NOTHING`,
      [message.id, change.app_id, change.id]
    );
  } catch (err) {
    log.warn('db', 'Staging shared renamed change seeding failed', { message: err.message });
  }
}

// Small changes (#admin/small-changes): the watch-only small-change tag only
// writes rows when a checks run settles, and nothing settles in a staging
// preview, so the section would only ever show its empty state there. Tag
// the first five merged-PR fixtures above, one of each verdict, so the
// table, its badges, the veto words and the week's totals all render. Every
// head is an obviously fake `5c...` sha, so a real head can never collide,
// and ON CONFLICT on (session_id, head_sha) makes it idempotent. Strictly a
// no-op outside staging.
async function seedStagingSmallChangeTags(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const { rows: apps } = await pool.query('SELECT id FROM apps WHERE slug = $1', [config.selfAppSlug]);
    const appId = apps[0]?.id;
    if (!appId) return;
    const { rows: sessions } = await pool.query(
      `SELECT id, branch_name FROM chat_sessions
        WHERE app_id = $1 AND branch_name LIKE 'staging-fixture/merged-pr-%'
        ORDER BY branch_name ASC LIMIT 5`,
      [appId]
    );
    const fixtures = [
      { verdict: 'small', kind: 'fix', reason: '[staging fixture] Fixes the vote pill so it no longer overflows on narrow screens.', vetoes: [], files: 2, lines: 14, cost: 0.0004, hoursAgo: 2 },
      { verdict: 'small', kind: 'wording', reason: '[staging fixture] Changes the empty-state wording on the dashboard tiles.', vetoes: [], files: 1, lines: 6, cost: 0.0003, hoursAgo: 5 },
      { verdict: 'not_small', kind: null, reason: '[staging fixture] Changes how the activity feed sorts, which people rely on.', vetoes: [], files: 3, lines: 48, cost: 0.0006, hoursAgo: 20 },
      { verdict: 'vetoed', kind: null, reason: null, vetoes: ['schema_or_data_sql', 'too_large'], files: 9, lines: 410, cost: null, hoursAgo: 30 },
      { verdict: 'unavailable', kind: null, reason: null, vetoes: [], files: 2, lines: 22, cost: null, hoursAgo: 40, error: 'no_key' },
    ];
    let inserted = 0;
    for (let i = 0; i < Math.min(sessions.length, fixtures.length); i++) {
      const f = fixtures[i];
      const { rowCount } = await pool.query(
        `INSERT INTO small_change_tags
           (session_id, app_id, head_sha, verdict, kind, reason, vetoes, files_changed,
            lines_changed, model, cost_usd, duration_ms, error, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13,
                 NOW() - ($14::int * INTERVAL '1 hour'))
         ON CONFLICT (session_id, head_sha) DO NOTHING`,
        [sessions[i].id, appId, `5c${String(i + 1).padStart(38, '0')}`, f.verdict, f.kind, f.reason,
          JSON.stringify(f.vetoes), f.files, f.lines,
          f.verdict === 'vetoed' ? null : 'z-ai/glm-5.3-flash', f.cost,
          f.verdict === 'vetoed' ? null : 1800, f.error || null, f.hoursAgo]
      );
      inserted += rowCount;
    }
    log.info('db', 'Staging small-change tags seeded', { appId, inserted });
  } catch (err) {
    log.warn('db', 'Staging small-change tags failed', { message: err.message });
  }
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
        model: 'claude-haiku-5-5',
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
        model: 'claude-haiku-5-5',
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
         (app_id, user_id, branch_name, pr_number, session_title, status, shared_at, created_at)
       VALUES
         ($1, $2, $3, 9301, 'Staging demo shared session', 'paused',
          NOW() - INTERVAL '45 minutes', NOW() - INTERVAL '2 hours')
       RETURNING id`,
      [appId, demoUserId, fixtureBranch]
    );
    sessionId = rows[0].id;
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
    appId, sessionId, threadInserted,
  });
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
    // #5483's shots: the bot-DM fixture's "ready to try" card (staging-
    // messages.js) is voted with its Approve, which posts to session 990901.
    // Without a row there the Approve answers 404 and the after build can
    // never show the card saying the vote. A private demo app keeps the vote
    // off the public-app identity gate, votes_required 2 keeps one Yes from
    // deciding anything, and the session's app takes its viewers as
    // collaborators so the session collab guard (app-access.js) lets the
    // shot personas' Approve through. Obviously fake, in the same
    // 900xxx/99xxxx staging ranges, idempotent like its siblings.
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES (900002, 'Staging demo bot change', 'staging-demo-bot-change', 'running', 'members', 'private', 900001)
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status)
       SELECT 900002, u.id, 'member' FROM users u
       WHERE u.username IN ('usernode-capture', 'staging-code-signin@usernode.test')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status, promoted_at, votes_required, approval_epoch)
       VALUES (990901, 900002, 900001, 'staging-demo/bot-change-pr', 900002,
               'Staging demo change — grey out finished items', 'promoted', NOW(), 2, 0)
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
// be exercised. This seeds ONE open tile, ONE gated tile and ONE guest-ready
// tile whose app asks for an account (guest_shell public, anon_shell gated;
// #7128), so every branch of the `requires_login`/`guest_ready` mapping is
// visible side by side, plus a little app_activity so the open tile's
// active-users badge is nonzero.
//
// The far-future anon_shell_checked_at is load-bearing: src/services/
// shell-probe.js re-probes every running public app whose check is stale
// (NULL, older than an hour, or predating last_deploy_at), and these
// fixtures have no container behind them — a plain NOW() stamp would be
// overwritten with 'unknown' (→ gated) inside one 5-minute sweep and the
// open tile would silently flip. Stamping a year out keeps the fixtures
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
    // #7128: a public project whose app answers a guest but still asks for an
    // account (anon_shell gated, guest_shell public): Open from its page must
    // keep Homeroom's bar around the app for a visitor with no account.
    const GUEST_READY_APP_ID = 900102;
    await pool.query(
      `INSERT INTO apps
         (id, name, slug, status, view_visibility, created_by,
          icon_emoji, last_deploy_at, anon_shell, guest_shell, anon_shell_checked_at)
       VALUES
         ($1, '[Mock] Open demo app', 'staging-landing-open',
          'running', 'public', $4, '🛝',
          NOW() - INTERVAL '2 days', 'public', 'unknown', NOW() + INTERVAL '1 year'),
         ($2, '[Mock] Gated demo app', 'staging-landing-gated',
          'running', 'public', $4, '🔒',
          NOW() - INTERVAL '3 days', 'gated', 'unknown', NOW() + INTERVAL '1 year'),
         ($3, '[Mock] Guest-ready demo app', 'staging-landing-guest-ready',
          'running', 'public', $4, '🎲',
          NOW() - INTERVAL '1 day', 'gated', 'public', NOW() + INTERVAL '1 year')
       ON CONFLICT DO NOTHING`,
      [OPEN_APP_ID, GATED_APP_ID, GUEST_READY_APP_ID, OWNER_ID]
    );

    // Re-stamp on every boot: ON CONFLICT above skips rows that already
    // exist, and the probe may have clobbered the classification of a
    // fixture seeded by an earlier deploy.
    await pool.query(
      `UPDATE apps
          SET anon_shell = CASE WHEN id = $1 THEN 'public' ELSE 'gated' END,
              guest_shell = CASE WHEN id = $3 THEN 'public' ELSE guest_shell END,
              anon_shell_checked_at = NOW() + INTERVAL '1 year'
        WHERE id IN ($1, $2, $3)`,
      [OPEN_APP_ID, GATED_APP_ID, GUEST_READY_APP_ID]
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

// #7230's shots: the hub's Top contributors card, on the Book Club the
// Discussion seed makes (staging-demo-discussion), as its member sees it. A
// fresh staging copy has people active this week there but no contributions,
// so the card is missing. Two obviously fake merged changes, one by each of
// two seeded people, give it two people to list. Idempotent by branch, a
// strict no-op outside staging, and a missing project or people is simply
// nothing to seed.
async function seedStagingHubContributors(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const { rows: [app] } = await pool.query("SELECT id FROM apps WHERE slug = 'staging-demo-discussion'");
    if (!app) return seedSkipped('no staging-demo-discussion');
    const { rows: people } = await pool.query(
      `SELECT id FROM users WHERE username IN ('staging-demo-priya', 'staging-demo-dev') ORDER BY username`);
    if (people.length < 2) return seedSkipped('no staging demo people');
    for (const [i, person] of people.entries()) {
      await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, session_title, pr_title, status, merged_at)
         SELECT $1, $2, $3::varchar(255), 'Staging demo: a shelf for what we are reading',
                'Staging demo: a shelf for what we are reading', 'merged',
                NOW() - make_interval(days => $4::int)
          WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE app_id = $1 AND branch_name = $3::varchar(255))`,
        [app.id, person.id, `staging-fixture/hub-contributor-${i + 1}`, i + 1]);
    }
  } catch (err) {
    log.warn('db', 'Staging hub contributors seed failed', { message: err.message });
  }
}

// THE SIGNED-OUT PROJECT PAGE, BUSY (26 Nov 2026): what a visitor with no
// account sees of a public project (frontend/src/features/guest/
// guest-project.tsx) only says who is around from 25 members and 10 people
// active this week, says who approved a change that went live from its
// counted yeses (services/public-project.js approvedBy), and lists Top
// contributors from two people (GET /api/public/apps/:slug/top-contributors).
// A fresh staging copy has no public project with any of that, so this makes
// one, obviously fake: "[Mock] Busy public project" (a game, public to see
// and to join, its app answering a guest as #7128's fixture does), its
// creator and thirty members, four changes that went live (one approved by
// three people, one by its creator alone, one by two people, and an older
// one with no vote, as a first version goes live) and two up for a vote
// with recent yeses, which make the week's people.
//
// Ids sit in the 9013xx block. Idempotent: rows are inserted with ON
// CONFLICT DO NOTHING, and on every boot the yeses are stamped within the
// week again so "active this week" holds on a long-lived copy (a change's
// merge time is the merge machine's to write, so it keeps its first stamp).
// The accounts cannot sign in. Strictly a no-op outside staging.
async function seedStagingGuestProjectPage(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const OWNER_ID = 901300;
  const APP_ID = 901300;
  const SLUG = 'staging-guest-page-busy';
  const MEMBER_IDS = Array.from({ length: 30 }, (_, i) => 901301 + i);
  const SHA = 'f'.repeat(40);
  try {
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES ($1, 'staging-guest-page-owner', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`,
      [OWNER_ID]
    );
    for (const [i, id] of MEMBER_IDS.entries()) {
      await pool.query(
        `INSERT INTO users (id, username, password)
         VALUES ($1, $2, 'staging-demo-not-a-login')
         ON CONFLICT DO NOTHING`,
        [id, `staging-guest-member-${String(i + 1).padStart(2, '0')}`]
      );
    }
    await pool.query(
      `INSERT INTO apps
         (id, name, slug, status, created_by, collab_visibility, view_visibility, icon_emoji,
          manifest_snapshot, last_deploy_at, anon_shell, guest_shell, anon_shell_checked_at, created_at)
       VALUES ($1, '[Mock] Busy public project', $2, 'running', $3, 'public', 'public', '🧮',
               jsonb_build_object('secrets', '[]'::jsonb, 'category', 'games',
                 'description', 'Sample data: a busy public project for the signed-out page.'),
               NOW() - INTERVAL '1 day', 'gated', 'public', NOW() + INTERVAL '1 year',
               NOW() - INTERVAL '60 days')
       ON CONFLICT DO NOTHING`,
      [APP_ID, SLUG, OWNER_ID]
    );
    // The app is ours only if it carries our slug: a cloned row in the block
    // would be somebody else's.
    const { rows: [app] } = await pool.query('SELECT id FROM apps WHERE id = $1 AND slug = $2', [APP_ID, SLUG]);
    if (!app) return;
    // Members join by the collaborators' trigger (communities.js), never by
    // writing community_members.
    for (const id of [OWNER_ID, ...MEMBER_IDS]) {
      await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
         VALUES ($1, $2, 'member', NOW() - INTERVAL '30 days')
         ON CONFLICT DO NOTHING`,
        [APP_ID, id]
      );
    }
    // [id, title, author, hours ago, yes from]: live changes, then two up for a vote.
    const live = [
      [901300, 'Sample: resume a half-played game instead of dealing a new board', MEMBER_IDS[0], 1, MEMBER_IDS.slice(1, 4)],
      [901301, 'Sample: add an Undo button that takes back the last move', OWNER_ID, 3, [OWNER_ID]],
      [901302, 'Sample: explain why a hint failed and let it work on an empty row', MEMBER_IDS[4], 5, MEMBER_IDS.slice(5, 7)],
      [901303, 'Sample: the first version', OWNER_ID, 24 * 40, []],
    ];
    for (const [id, title, author, hours] of live) {
      await pool.query(
        `INSERT INTO chat_sessions (id, app_id, user_id, status, pr_title, reviewed_head_sha, created_at, merged_at)
         VALUES ($1, $2, $3, 'merged', $4, $5, NOW() - make_interval(hours => $6::int + 2), NOW() - make_interval(hours => $6::int))
         ON CONFLICT DO NOTHING`,
        [id, APP_ID, author, title, SHA, hours]
      );
    }
    const open = [
      [901310, 'Sample: show moves, time and highest tile on the win card', MEMBER_IDS[7], MEMBER_IDS.slice(7, 15)],
      [901311, 'Sample: keep the Play button pinned to the bottom of the screen', MEMBER_IDS[15], MEMBER_IDS.slice(15, 19)],
    ];
    for (const [id, title, author] of open) {
      await pool.query(
        `INSERT INTO chat_sessions (id, app_id, user_id, status, pr_title, reviewed_head_sha, created_at, promoted_at)
         VALUES ($1, $2, $3, 'promoted', $4, $5, NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day')
         ON CONFLICT DO NOTHING`,
        [id, APP_ID, author, title, SHA]
      );
    }
    for (const [id, , , , yes] of live) {
      for (const voter of yes) {
        await pool.query(
          `INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes') ON CONFLICT DO NOTHING`,
          [id, voter]
        );
      }
    }
    for (const [id, , , yes] of open) {
      for (const voter of yes) {
        await pool.query(
          `INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes') ON CONFLICT DO NOTHING`,
          [id, voter]
        );
      }
    }
    // Within the week on every boot, so the week's people hold.
    await pool.query(
      `UPDATE pr_votes SET created_at = NOW() - INTERVAL '6 hours'
        WHERE session_id = ANY($1::int[])`,
      [[...live.map((r) => r[0]), ...open.map((r) => r[0])]]
    );
    log.info('db', 'Staging guest project page fixture seeded');
  } catch (err) {
    log.warn('db', 'Staging guest project page seeding failed', { message: err.message });
  }
}

// #3962: Discover's "Filter by type" row appears only once some app's
// dapp.json says what kind of app it is, and a staging copy of production
// has none that do yet (nothing backfills real repositories). This writes a
// `category` into the manifest snapshot of three demo fixture apps the two
// seeds above make, so the row and its chips can be seen and pressed: the
// open landing tile is a game, the demo app a tool, the gated tile a social
// app. Display data on fake apps only; the snapshot is what a deploy of
// those apps' dapp.json would have written. Idempotent: `||` sets the same
// key to the same value on every boot. Strictly a no-op outside staging.
async function seedStagingAppCategories(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `UPDATE apps AS a
          SET manifest_snapshot = COALESCE(a.manifest_snapshot, '{"secrets": []}'::jsonb)
                || jsonb_build_object('category', v.category)
         FROM (VALUES (900100, 'games'), (900001, 'tools'), (900101, 'social'))
              AS v(id, category)
        WHERE a.id = v.id`
    );
    log.info('db', 'Staging app categories seeded');
  } catch (err) {
    log.warn('db', 'Staging app categories seeding failed', { message: err.message });
  }
}

// #6585: Home's kind chips show the kinds projects have. A fresh staging copy
// has no app_inferred_categories rows and no helper-model key, so three
// obviously fake public projects are seeded with the description the kind was
// worked out from, and their rows: one food, one money (with the template's
// starting `other` in its snapshot, to show that being sorted) and one
// health. The source description is exactly what public-app-directory.js
// compares against, so the rows count. Display data on fake apps only;
// idempotent on every boot. Strictly a no-op outside staging.
//
// The ids sit in the 90015x range, clear of every other 900xxx fixture. They
// must not be 900110-900112: those belong to the quiet, vote-card and notes
// demo apps, which are seeded later, and an app row taken here would make
// their ON CONFLICT DO NOTHING skip them.
async function seedStagingInferredCategories(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const OWNER_ID = 900100;
    const fixtures = [
      {
        id: 900150, name: '[Mock] Recipe box', slug: 'staging-landing-recipes',
        description: 'Recipes from what is in the fridge, shared with the people you cook for.',
        category: null, inferred: 'food', emoji: '🍲',
      },
      {
        id: 900151, name: '[Mock] Bill splitter', slug: 'staging-landing-bills',
        description: 'Split the bills for a shared house and keep a simple budget.',
        category: 'other', inferred: 'money', emoji: '💸',
      },
      {
        id: 900152, name: '[Mock] Run club', slug: 'staging-landing-runs',
        description: 'Log your runs and keep a streak with your running club.',
        category: null, inferred: 'health', emoji: '🏃',
      },
    ];
    // Self-heal a copy that booted the first version of this seed: it wrote
    // these three apps at 900110-900112, before the quiet, vote-card and
    // notes fixtures had their ids. Delete only rows carrying both that id
    // and this seed's slug, so no real fixture can match; the inferred rows
    // go with them (ON DELETE CASCADE), and each seed below makes its app
    // again.
    await pool.query(
      `DELETE FROM apps
        WHERE (id, slug) IN ((900110, 'staging-landing-recipes'),
                             (900111, 'staging-landing-bills'),
                             (900112, 'staging-landing-runs'))`
    ).catch((err) => {
      // Never let the cleanup stop the fixtures below: the three chips are
      // what the landing check needs, and a fresh copy has nothing to delete.
      log.warn('db', 'Staging inferred app-category cleanup failed', { message: err.message });
    });
    for (const f of fixtures) {
      await pool.query(
        `INSERT INTO apps
           (id, name, slug, status, view_visibility, created_by, manifest_snapshot,
            icon_emoji, last_deploy_at, anon_shell, anon_shell_checked_at)
         VALUES ($1, $2, $3, 'running', 'public', $4, $5::jsonb,
                 $6, NOW() - INTERVAL '2 days', 'public', NOW() + INTERVAL '1 year')
         ON CONFLICT (id) DO NOTHING`,
        [f.id, f.name, f.slug, OWNER_ID, JSON.stringify({
          secrets: [], description: f.description, ...(f.category ? { category: f.category } : {}),
        }), f.emoji]
      );
      await pool.query(
        `INSERT INTO app_inferred_categories (app_id, category, source_description, model, inferred_at)
         VALUES ($1, $2, $3, 'staging-seed', NOW())
         ON CONFLICT (app_id) DO UPDATE
           SET category = EXCLUDED.category,
               source_description = EXCLUDED.source_description,
               model = EXCLUDED.model,
               inferred_at = NOW()`,
        [f.id, f.inferred, f.description]
      );
    }
    log.info('db', 'Staging inferred app categories seeded');
  } catch (err) {
    log.warn('db', 'Staging inferred app categories seeding failed', { message: err.message });
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

// Fixtures for custom domains (#4405). app_domains is staging:private, so
// a preview's copy is empty: these rows give the Custom domain dialog, Share
// and the admin Domains section something to show. `.invalid` never
// resolves, and the sweep runs on the leader only (never a preview), so
// nothing can act on them.
//
// The project the dialog is photographed on, `staging-demo-custom-domain`,
// is managed by the account the declared checks sign in as (an app admin of
// it, the way seedStagingAppAdminsPanel gives its roster app admins): the
// Custom domain row shows only to whoever manages a project. That account
// is `usernode-capture-admin` (selectCaptureTokens in services/visuals.js),
// a VIEW-ONLY admin, so its admin rank never grants can_manage; only this
// app_admins row does. The fixture once granted the email-code sign-in
// account instead, which no check signs in as, and the ⋯ menu's Custom
// domain check failed on every proposal. That account keeps its grant, so
// a tester signing in with the documented password sees the row too. It is
// a public, running project owned by the demo user, so it changes nothing
// about what either account has made. Its claim is still waiting for DNS,
// with the sentence the sweep would have recorded.
// The read-only demo app carries a LIVE one, so Share there offers the
// custom address with the Homeroom address named under it.
async function seedStagingCustomDomains(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by,
                         repo_url, admin_usernames)
       VALUES (900140, 'Staging demo custom domain', 'staging-demo-custom-domain', 'running',
               'public', 'public', 900001, 'https://github.com/staging-demo/staging-demo-custom-domain',
               ARRAY['usernode-capture-admin', 'staging-code-signin@usernode.test'])
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO app_admins (app_id, user_id)
       SELECT 900140, id FROM users
        WHERE username IN ('usernode-capture-admin', 'staging-code-signin@usernode.test')
       ON CONFLICT (app_id, user_id) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO app_domains (id, app_id, hostname, verification_token, status, dns_checked_at,
                                last_error, failure_count, created_by)
       VALUES (900102, 900140, 'staging-demo-pending.example.invalid', '0123456789abcdef0123456789abcdef',
               'pending', NOW() - INTERVAL '1 minute',
               'No CNAME record found for staging-demo-pending.example.invalid.', 3, 900001)
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO app_domains (id, app_id, hostname, verification_token, status, verified_at, live_at,
                                cert_expires_at, dns_checked_at, created_by)
       SELECT 900101, id, 'staging-demo.example.invalid', 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff', 'live',
              NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', NOW() + INTERVAL '80 days', NOW(), 900001
         FROM apps WHERE slug = 'staging-demo-readonly'
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `SELECT setval('app_domains_id_seq', GREATEST((SELECT MAX(id) FROM app_domains), 1))`
    );
  } catch (err) {
    log.warn('db', 'Staging custom-domain fixtures skipped', { err: err.message });
  }
}

// #6601's shots: a waiting card-picture change on a project the capture
// member owns, so the vote's ⋯ menu offers Edit proposal and the editor
// opens on that waiting record with "Replace the waiting change". The
// picture bytes wait in app_illustration_proposals under the urls the card
// previews, exactly as a real proposal carries them. A fresh staging copy
// has no such vote (the feature is new), and this is the only place it is
// made. Obviously fake, idempotent, staging only.
async function seedStagingWaitingIllustration(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const capture = (await pool.query("SELECT id, username FROM users WHERE username = 'usernode-capture'")).rows[0];
    if (!capture) return;
    // The browse-card fixture's real PNG, so /app-illustrations/<id> decodes.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAYAAAByDd+UAAAAg0lEQVR42r3NuRGAMAwEQNdFbXRAIVRHAyQwDmB4/MjS3QUbb5qn7VBKymxddl2YM1l4ZZLwmdHDb0YNSxktrGWUsJXBw14GDS0ZLLRmkHAkC4ejWSj0ZO7Qm7nCSDYcRrOhEJGZQ1RmCpFZN0RnzZCRVUNWVgyZ2S9kZ69Qkd2hKstOLPva44BQr+EAAAAASUVORK5CYII=',
      'base64'
    );
    const lightId = 'fed66010000000000000000000000a01';
    const darkId = 'fed66010000000000000000000000a02';
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, view_visibility, created_by)
       VALUES (900160, 'Staging demo waiting picture', 'staging-demo-waiting-picture', 'running', 'public', $1)
       ON CONFLICT DO NOTHING`, [capture.id]
    );
    const app = (await pool.query("SELECT id FROM apps WHERE slug = 'staging-demo-waiting-picture'")).rows[0];
    if (!app) return seedSkipped('no project');
    const proposed = {
      url: `/app-illustrations/${lightId}`, darkUrl: `/app-illustrations/${darkId}`,
      zoom: 1.2, x: 5, y: -3, tint: 'teal',
    };
    await pool.query(
      `INSERT INTO issues (id, app_id, title, description, kind, payload, created_by, status)
       VALUES (9076601, $1, 'Change the featured illustration', $2, 'featured_illustration', $3::jsonb, $4, 'open')
       ON CONFLICT DO NOTHING`,
      [app.id,
        `${capture.username} proposed changing the featured illustration on the project's Discover card. `
          + 'It applies when the group votes it in.',
        JSON.stringify({ proposed, current: null, remove: false }), capture.id]
    );
    await pool.query(
      `INSERT INTO app_illustration_proposals
         (issue_id, app_id, id, content_type, data, dark_id, dark_content_type, dark_data)
       VALUES (9076601, $1, $2, 'image/png', $3, $4, 'image/png', $3)
       ON CONFLICT DO NOTHING`, [app.id, lightId, png, darkId]
    );
    log.info('db', 'Staging waiting-illustration fixture seeded', { appId: app.id });
  } catch (err) {
    log.warn('db', 'Staging waiting-illustration fixture skipped', { err: err.message });
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

  // #5104: a search finds nobody who keeps their profile out of it, and that
  // is now everybody until they choose otherwise. These fake people exist
  // to be found by a preview's typeahead, so they opt in, and take
  // messages and invitations from anyone, the way a real person can choose
  // to. Only the sentinel-password fixtures: never a real account.
  try {
    await pool.query(
      `UPDATE users SET profile_discoverable = TRUE, contact_policy = 'anyone'
        WHERE username LIKE 'staging-demo-%'
          AND password = 'staging-demo-not-a-login'
          AND (NOT profile_discoverable OR contact_policy <> 'anyone')`
    );
  } catch (err) {
    log.warn('db', 'Staging user-directory privacy seeding failed', { message: err.message });
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

// A QUIET app for the channel's quiet card and a proposal's own story
// (features/group-chat/quiet-card.tsx, proposal-event.tsx): an app whose
// channel holds not one message from a person and, since Homeroom writes no
// activity into a channel (services/ws.js sendSystemMessage), nothing else
// either. So its channel is the quiet card alone, and its one open proposal
// keeps the line that put it up for a vote in the proposal's own thread,
// where the change page's Discussion draws it as a message from whoever
// proposed it. The platform app's own staging transcript cannot serve here:
// its fixtures seed dozens of human rows, which is exactly what makes the
// card go away.
//
// The line carries the metadata tag the live promote path writes, so the
// Discussion resolves its vote out of /promoted. Its id, 900118, is new: the
// channel lines this fixture used to seed (900111-900117) are removed by
// clearAutomatedChannelLines, and reusing one of their ids would leave the
// thread copy behind their ON CONFLICT on the boot that removes them.
// Read-only viewers see the same rows. Idempotent via explicit ids + ON
// CONFLICT DO NOTHING; a no-op outside staging.
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
    // The open proposal's own thread, worded like the platform's promote
    // line (routes/votes.js) with "Staging demo" in its title.
    await pool.query(
      `INSERT INTO chat_messages (id, app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, created_at)
       VALUES
         (900118, 900110, NULL,
          'staging-demo-quiet-builder promoted PR #900110: Staging demo: a proposal that is still up for a vote for voting',
          'vote', '{"vote": {"sessionId": 900110, "prNumber": 900110}}', 'session', 900110,
          NOW() - INTERVAL '30 minutes')
       ON CONFLICT DO NOTHING`
    );
    // #5458's first shot attempt hung the chat vote card here: a "built
    // this" line (900119) in this channel plus a usernode-capture
    // membership. That broke the two checks above — this app is the quiet
    // card alone, and a line from the bot is exactly what the channel must
    // not hold — so the card moved to its own app
    // (seedStagingVoteCardChat, below) and the rows it wrote are removed
    // here, the way clearAutomatedChannelLines clears platform lines: a
    // staging copy the earlier commit already ran in self-heals on boot.
    await pool.query(`DELETE FROM chat_messages WHERE id = 900119`);
    await pool.query(
      `DELETE FROM app_collaborators
        WHERE app_id = 900110
          AND user_id = (SELECT id FROM users WHERE username = 'usernode-capture')`
    );
    log.info('db', 'Staging quiet-discussion fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging quiet-discussion seeding failed', { message: err.message });
  }
}

// #5458's shots: the vote card a chat hangs under the Homeroom bot's
// "built this" line — an ordinary message whose metadata names the
// proposal (features/group-chat/transcript.tsx), with Yes/No buttons and
// the count beside them, the thing the change lets a member's tap repaint
// at once. The product writes no such line on a fresh copy any more: its
// own proposal lines go to the proposal's own thread. And the quiet app
// above cannot carry it — its channel is the quiet card alone, which the
// declared checks pin — so the card gets an app of its own: one builder
// (a fixture person, never a login), one open proposal, the bot's line
// under it, and nothing else.
//
// The line's author is the bot, the voice that really says it, and a
// sender the channel sweep keeps: clearAutomatedChannelLines removes a
// channel row only when nobody (user_id IS NULL) wrote it, and the bot's
// own lines survive it the same way. The capture member
// (services/visuals.js signs shots as usernode-capture) taps the card,
// and voting is members-only, so it holds a membership here the way a
// real invite would have landed it. Idempotent via fixed ids + ON
// CONFLICT DO NOTHING; a no-op outside staging.
async function seedStagingVoteCardChat(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES (900111, 'staging-demo-vote-card-builder', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    // The bot's account, in the posture botAccount() reads: the username
    // with is_synthetic on top, sentinel password, never a login.
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`
    );
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES (900111, 'Staging demo vote card', 'staging-demo-vote-card', 'running',
               'private', 'public', 900111)
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status, promoted_at, created_at)
       VALUES (900111, 900111, 900111, 'staging-demo/vote-card-open-proposal', 900111,
               'Staging demo: a proposal that is still up for a vote', 'promoted',
               NOW() - INTERVAL '1 hour', NOW() - INTERVAL '2 hours')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO chat_messages (id, app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, created_at)
       VALUES
         (900120, 900111, (SELECT id FROM users WHERE username = 'homeroom_bot'),
          'I built this. It''s up for a vote: Staging demo: a proposal that is still up for a vote',
          'message', '{"vote": {"sessionId": 900111, "prNumber": 900111}}', NULL, NULL,
          NOW() - INTERVAL '30 minutes')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
       SELECT 900111, viewer.id, 'member', 900111, NOW()
         FROM users viewer
        WHERE viewer.username = 'usernode-capture'
       ON CONFLICT (app_id, user_id) DO NOTHING`
    );
    log.info('db', 'Staging vote-card chat fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging vote-card chat seeding failed', { message: err.message });
  }
}

// #5877's shots: the Homeroom bot's "Ready to try" row about one project,
// so the bell's leading tile can be seen wearing that project's icon (a
// picture, an emoji, or the name's letter) instead of the Homeroom mark. A
// fresh copy has no such row: the bot writes one only after it has built
// something, and there is no bot here.
//
// Display data only. The app is a made-up one ("Staging demo notes", an
// emoji icon), its maker a fixture account that cannot log in, and the
// notification is a plain unread row for the capture member whose detail is
// the same one the bot's own copy builds. The conversation is a real direct
// thread between the bot's account and that member, because the bell reads a
// conversation row only while its recipient is still in the conversation.
// Idempotent through fixed ids, ON CONFLICT DO NOTHING, and an existence
// check on the notification row; a no-op outside staging.
async function seedStagingBotProjectNotification(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    const viewer = await pool.query(
      `SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1`
    );
    const member = viewer.rows[0];
    if (!member) {
      log.warn('db', 'Staging bot-project notification skipped: fixture member missing');
      return seedSkipped('no user usernode-capture');
    }

    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES (900112, 'staging-demo-notes-maker', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    // The bot's account, in the posture botAccount() reads: the username
    // with is_synthetic on top, sentinel password, never a login.
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`
    );
    const bot = (await pool.query(
      `SELECT id FROM users WHERE username = 'homeroom_bot' LIMIT 1`
    )).rows[0];

    // Private, with a membership for the capture member: the row belongs to
    // that one account's bell, and a public fixture app would add itself to
    // Discover, which this change does not touch.
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, icon_emoji, created_by)
       VALUES (900112, 'Staging demo notes', 'staging-demo-notes', 'running',
               'private', 'private', '📝', 900112)
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
       VALUES (900112, $1, 'member', 900112, NOW())
       ON CONFLICT (app_id, user_id) DO NOTHING`,
      [member.id]
    );

    // One direct conversation per pair (conversation_direct_pairs is unique
    // on it), found rather than created twice.
    const low = Math.min(member.id, bot.id);
    const high = Math.max(member.id, bot.id);
    const found = await pool.query(
      `SELECT c.id FROM conversations c
         JOIN conversation_direct_pairs p ON p.conversation_id = c.id
        WHERE p.user_low_id = $1 AND p.user_high_id = $2
        LIMIT 1`,
      [low, high]
    );
    let conversationId = found.rows[0]?.id;
    if (!conversationId) {
      const created = await pool.query(
        `INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`,
        [bot.id]
      );
      conversationId = created.rows[0].id;
      await pool.query(
        `INSERT INTO conversation_direct_pairs
           (conversation_id, user_low_id, user_high_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, low, high]
      );
    }
    // Both sides as members, re-asserted on an existing thread so a partial
    // earlier boot self-heals.
    await pool.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, responded_at, joined_at)
       SELECT $1, u.id, 'member', 'member', NOW(), NOW()
         FROM users u WHERE u.id IN ($2, $3)
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, member.id, bot.id]
    );

    // The bot's ready moment over a request, worded by the service that
    // words the real one, so the fixture cannot drift from what production
    // writes.
    const { botNotificationDetail } = require('../services/homeroom-bot-notify-copy');
    const detail = botNotificationDetail({
      moment: 'ready',
      said: 'ready',
      appName: 'Staging demo notes',
      requestTitle: 'Solarized light/dark theming that follows the platform theme',
    });

    await pool.query(
      `INSERT INTO notifications
         (user_id, app_id, conversation_id, source_user_id, kind, detail, read_at, created_at)
       SELECT $1::int, 900112, $2::int, $3::int, 'build_ready', $4::varchar, NULL, NOW() - INTERVAL '1 hour'
        WHERE NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.user_id = $1 AND n.kind = 'build_ready' AND n.conversation_id = $2
        )`,
      [member.id, conversationId, bot.id, detail]
    );
    log.info('db', 'Staging bot-project notification fixture seeded');
  } catch (err) {
    log.warn('db', 'Staging bot-project notification seeding failed', { message: err.message });
  }
}

// #6371's before/after shots: the one weekly digest row in the bell, whose
// tap opens This week. A staging copy has no such row for the shots' member
// fixture, and the page's own read is the demo week (`#week?demo=1`).
async function seedStagingWeeklyDigestRow(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const viewer = await pool.query(
      `SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1`
    );
    const member = viewer.rows[0];
    if (!member) {
      log.warn('db', 'Staging weekly digest row skipped: fixture member missing');
      return seedSkipped('no user usernode-capture');
    }
    await pool.query(
      `INSERT INTO notifications (user_id, app_id, source_user_id, kind, detail)
       SELECT $1, NULL, NULL, 'weekly_digest', 'w:3:12:3'
        WHERE NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.user_id = $1 AND n.kind = 'weekly_digest' AND n.detail = 'w:3:12:3'
        )`,
      [member.id]
    );
    log.info('db', 'Staging weekly digest row fixture seeded');
  } catch (err) {
    log.warn('db', 'Staging weekly digest row seeding failed', { message: err.message });
  }
}

// #6133's before/after shots: the quiet line the bot says in a request's
// thread when it begins reading again and the person paying has under a
// fifth of the week's building time left. Only the live loop says it, and a
// staging copy never runs the bot, so a fresh copy has no such thread. The
// rows here are the ones the bot would have sent: one made-up request whose
// card is the root of its thread, the look's "Reading it again." line, and
// the warning under it, in that order.
//
// The card names no project's page (no appSlug), so its thread is the story
// that opens where it was told (the staging demo's own requests are the
// same), which is where the shots can see the line. Nothing hangs off the
// bell, and both lines count as read, so no Unread badge rides on the tab.
//
// The week's spend is NOT seeded: that allowance is the signal the change
// itself reads, and a preview must not answer it. Idempotent through the
// messages' own keys; a no-op outside staging.
async function seedStagingBotAllowanceWarning(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    const member = (await pool.query(
      `SELECT id FROM users WHERE username = 'usernode-capture' AND is_synthetic = FALSE LIMIT 1`
    )).rows[0];
    if (!member) {
      log.warn('db', 'Staging bot allowance-warning fixture skipped: the capture member is missing');
      return seedSkipped('no user usernode-capture');
    }
    // The bot's account, in the posture botAccount() reads: the username with
    // is_synthetic on top, sentinel password, never a login.
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT DO NOTHING`
    );
    const bot = (await pool.query(
      `SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1`
    )).rows[0];
    if (!bot || Number(bot.id) === Number(member.id)) return seedSkipped('no separate Homeroom bot user');

    // Their chat with the bot: the pair's conversation when it exists, else
    // one made the way the platform makes it, both sides already in.
    const low = Math.min(member.id, bot.id);
    const high = Math.max(member.id, bot.id);
    const found = await pool.query(
      `SELECT conversation_id FROM conversation_direct_pairs
        WHERE user_low_id = $1 AND user_high_id = $2`,
      [low, high]
    );
    let conversationId = found.rows[0]?.conversation_id;
    if (!conversationId) {
      conversationId = (await pool.query(
        `INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`,
        [bot.id]
      )).rows[0].id;
      await pool.query(
        `INSERT INTO conversation_direct_pairs
           (conversation_id, user_low_id, user_high_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, low, high]
      );
    }
    await pool.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, invited_by, responded_at, joined_at)
       SELECT $1, u.id, 'member', 'member', $2, NOW(), NOW()
         FROM users u WHERE u.id IN ($2, $3)
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, bot.id, member.id]
    );
    // An earlier boot (or the AI tab's own open) may have left one side
    // invited: re-assert both, as ensureAdmittedDirect does.
    await pool.query(
      `UPDATE conversation_members
          SET status = 'member', responded_at = COALESCE(responded_at, NOW()),
              joined_at = COALESCE(joined_at, NOW()), left_at = NULL
        WHERE conversation_id = $1 AND status <> 'member'`,
      [conversationId]
    );
    await pool.query(
      `UPDATE conversations SET status = 'active', updated_at = NOW()
        WHERE id = $1 AND status <> 'active'`,
      [conversationId]
    );

    const about = {
      appName: 'Staging demo app', issueNumber: 19,
      issueTitle: 'Staging demo, show how much of the week is left',
    };
    const cardKey = 'staging-hrbot-allowance-low-card';
    let card = (await pool.query(
      `SELECT id FROM conversation_messages
        WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3`,
      [conversationId, bot.id, cardKey]
    )).rows[0];
    if (!card) {
      card = (await pool.query(
        `INSERT INTO conversation_messages
           (conversation_id, sender_id, content, idempotency_key, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW() - INTERVAL '20 minutes')
         RETURNING id`,
        [conversationId, bot.id,
          `**${about.appName}** · request #${about.issueNumber}: ${about.issueTitle}\n\n`
            + 'I\'m working on this now. This card updates as I go.',
          cardKey, JSON.stringify({ homeroomBot: { kind: 'activity', ...about, mirrors: true } })]
      )).rows[0];
    }

    // The look's own line, then the warning: the order the live loop writes
    // them in (homeroom-bot-activity.js noteReading, noteLowAllowance).
    for (const line of [
      { key: 'staging-hrbot-allowance-low-reading', step: 'reading', content: 'Reading it again.', minutesAgo: 3 },
      { key: 'staging-hrbot-allowance-low-line', step: 'allowance_low', content: 'You\'re close to this week\'s building time.', minutesAgo: 2 },
    ]) {
      await pool.query(
        `INSERT INTO conversation_messages
           (conversation_id, sender_id, content, idempotency_key, metadata, thread_root_id, created_at)
         SELECT $1, $2, $3, $4, $5::jsonb, $6, NOW() - ($7::int * INTERVAL '1 minute')
          WHERE NOT EXISTS (
            SELECT 1 FROM conversation_messages
             WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $4::varchar
          )`,
        [conversationId, bot.id, line.content, line.key,
          JSON.stringify({ homeroomBot: { kind: 'step', step: line.step, ...about } }),
          card.id, line.minutesAgo]
      );
    }

    // Read by the member, so the tab's badge is as it was before the seed.
    await pool.query(
      `UPDATE conversation_members
          SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0),
                (SELECT MAX(id) FROM conversation_messages WHERE conversation_id = $1))
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, member.id]
    );
    log.info('db', 'Staging bot allowance-warning fixture seeded', { conversationId });
  } catch (err) {
    log.warn('db', 'Staging bot allowance-warning seeding failed', { message: err.message });
  }
}

// #6261: a comment's picture left every frame out, so a design's frame was a
// blank box. A clean staging copy has no design thread, so this seeds one in
// the capture member's chat with Homeroom bot, with a version and the bot's
// line saying it: the state the before & after shots need (the pane and the
// small card in the chat). Obviously fake, idempotent by the member already
// having a design thread, and strictly a no-op outside staging.
async function seedStagingDesignThread(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const member = (await pool.query(
      `SELECT id FROM users WHERE username = 'usernode-capture' AND is_synthetic = FALSE LIMIT 1`
    )).rows[0];
    if (!member) return seedSkipped('no user usernode-capture');
    // One design thread is enough; if theirs already holds one, leave it.
    const had = await pool.query(
      `SELECT 1 FROM private_threads p JOIN design_threads d ON d.private_thread_id = p.id
        WHERE p.user_id = $1 LIMIT 1`,
      [member.id]
    );
    if (had.rows.length) return;
    const app = (await pool.query(
      'SELECT id, slug, name FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1'
    )).rows[0];
    if (!app) return seedSkipped('no project');
    // The bot's account, in the posture botAccount() reads.
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`
    );
    const bot = (await pool.query(
      `SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1`
    )).rows[0];
    if (!bot || Number(bot.id) === Number(member.id)) return seedSkipped('no separate Homeroom bot user');

    const named = 'Staging demo: a screen with an unread badge';
    const dm = require('../services/homeroom-bot-dm');
    const opened = await dm.sendDm(pool, {
      bot,
      userId: member.id,
      content: `Staging demo: I opened a design thread for ${named}, in a thread only you can see. `
        + 'Tell me what to change there, or pin a comment on the preview, and I\'ll make the next version.',
      // The thread's first message, its row written with it (sendDm `thread`).
      thread: { kind: 'design', appId: app.id },
      moment: null,
      metadata: { kind: 'opened_design', appSlug: app.slug, appName: app.name || app.slug, designTitle: named },
    });
    if (!opened?.messageId) return;
    const thread = (await pool.query(
      'SELECT id FROM private_threads WHERE root_message_id = $1 AND user_id = $2',
      [opened.messageId, member.id]
    )).rows[0];
    if (!thread) return;
    await pool.query(
      `INSERT INTO design_threads (private_thread_id, title, surface, route, width, height)
       VALUES ($1, $2, 'platform', '#home', 390, 844)
       ON CONFLICT (private_thread_id) DO NOTHING`,
      [thread.id, named]
    );
    // Version 1 draws the obviously fake screen the shots look at: inline
    // styles only, so it needs no image or font from anywhere.
    const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
      + '<body style="margin:0;font-family:system-ui,sans-serif;background:#faf8f5;color:#18181b">'
      + '<div style="padding:24px 16px">'
      + '<div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#71717a">Needs you</div>'
      + '<div style="margin-top:12px;border-radius:16px;background:#fff;box-shadow:0 0 0 1px #e4e4e7;padding:14px">'
      + '<div style="display:flex;align-items:center;gap:8px">'
      + '<span style="width:8px;height:8px;border-radius:50%;background:#0a6ee0;display:inline-block"></span>'
      + '<strong style="font-size:15px">Needs you &middot; 3 new</strong></div>'
      + '<p style="font-size:13px;color:#52525b;margin:8px 0 0">Staging demo: a fake screen for the comment picture.</p>'
      + '</div></div></body></html>';
    await pool.query(
      `INSERT INTO design_versions (private_thread_id, version, html, author, note)
       VALUES ($1, 1, $2, 'capture', 'As it is now')
       ON CONFLICT (private_thread_id, version) DO NOTHING`,
      [thread.id, html]
    );
    const said = await dm.sendDm(pool, {
      bot,
      userId: member.id,
      content: 'Version 1: Staging demo: a screen with an unread badge.',
      threadRootId: opened.messageId,
      moment: null,
      idempotencyKey: `staging-design-${thread.id}-v1`,
      metadata: { kind: 'design_version', appSlug: app.slug, appName: app.name || app.slug, designVersion: 1 },
    }).catch((err) => {
      log.warn('db', 'Staging design thread version line failed', { message: err.message });
      return null;
    });
    if (said?.messageId) {
      await pool.query(
        'UPDATE design_versions SET message_id = $2 WHERE private_thread_id = $1 AND version = 1',
        [thread.id, said.messageId]
      );
    }
    // #6350: Request it starts its box from the note of the version filed, so
    // the shots need a second version with a note: version 1 is the capture,
    // whose "As it is now" is a marker and is skipped. Obviously fake.
    const second = html
      .replace('padding:24px 16px', 'padding:24px 16px 40px')
      .replace('<strong style="font-size:15px">Needs you &middot; 3 new</strong>',
        '<strong style="font-size:15px">Needs you &middot; 3 new</strong>'
        + '<span style="margin-left:auto;font-size:12px;color:#0a6ee0">Unread, in the corner</span>');
    await pool.query(
      `INSERT INTO design_versions (private_thread_id, version, html, author, note)
       VALUES ($1, 2, $2, 'bot', $3)
       ON CONFLICT (private_thread_id, version) DO NOTHING`,
      [thread.id, second, 'Staging demo: the unread count sits in the corner, under more space']
    );
    const saidTwo = await dm.sendDm(pool, {
      bot,
      userId: member.id,
      content: 'Version 2: Staging demo: the unread count sits in the corner, under more space.',
      threadRootId: opened.messageId,
      moment: null,
      idempotencyKey: `staging-design-${thread.id}-v2`,
      metadata: { kind: 'design_version', appSlug: app.slug, appName: app.name || app.slug, designVersion: 2 },
    }).catch((err) => {
      log.warn('db', 'Staging design thread version line failed', { message: err.message });
      return null;
    });
    if (saidTwo?.messageId) {
      await pool.query(
        'UPDATE design_versions SET message_id = $2 WHERE private_thread_id = $1 AND version = 2',
        [thread.id, saidTwo.messageId]
      );
    }
    // #6353: the plan card as it is when a script builds the screen's rows:
    // the warning and "Write the rows in first" beside posting as it is. A
    // stored bot reply, never asked for, and obviously fake like the rest.
    await dm.sendDm(pool, {
      bot,
      userId: member.id,
      content: [
        'Want me to post this as your plan on request #6351?',
        '',
        `**Staging demo** · a plan on request #6351: version 2 of ${named}`,
        '',
        'The plan would show its lists empty, because a script builds them. I can write the rows into the screen first.',
      ].join('\n'),
      threadRootId: opened.messageId,
      moment: null,
      idempotencyKey: `staging-design-${thread.id}-plan-card`,
      metadata: {
        kind: 'confirm', status: 'open', question: 'Post version 2 as a plan on #6351?',
        answers: ['Post as a plan on #6351', 'Not yet'],
        actions: [
          { id: 'fill', label: 'Write the rows in first', style: 'primary', type: 'prompt', quote: true },
          { id: 'yes', label: 'Post as a plan on #6351', style: 'secondary', type: 'server' },
          { id: 'no', label: 'Not yet', style: 'secondary', type: 'server' },
        ],
        mirrors: false,
      },
    }).catch((err) => {
      log.warn('db', 'Staging design plan card failed', { message: err.message });
    });
    log.info('db', 'Staging design thread fixture seeded', { threadId: thread.id });
  } catch (err) {
    log.warn('db', 'Staging design thread seeding failed', { message: err.message });
  }
}

// #6354: a design started from Homeroom's own copy of a page. A clean
// staging copy has no bot turn to run (there is no model), so this stores
// what a capture_page turn leaves in the capture member's chat: version 1
// the page "as it is now", and version 2 the bot's change to it. Obviously
// fake, idempotent by its title, and a strict no-op outside staging.
async function seedStagingCapturedPageThread(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const named = 'Staging demo: the Homeroom bot page';
    const had = await pool.query('SELECT 1 FROM design_threads WHERE title = $1 LIMIT 1', [named]);
    if (had.rows.length) return;
    const member = (await pool.query(
      'SELECT id FROM users WHERE username = \'usernode-capture\' AND is_synthetic = FALSE LIMIT 1'
    )).rows[0];
    if (!member) return seedSkipped('no user usernode-capture');
    const app = (await pool.query(
      'SELECT id, slug, name FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1'
    )).rows[0];
    if (!app) return seedSkipped('no project');
    const bot = (await pool.query(
      'SELECT id FROM users WHERE username = \'homeroom_bot\' AND is_synthetic = TRUE LIMIT 1'
    )).rows[0];
    if (!bot) return seedSkipped('no Homeroom bot user');
    const dm = require('../services/homeroom-bot-dm');
    const opened = await dm.sendDm(pool, {
      bot,
      userId: member.id,
      content: `Staging demo: I opened a design thread for ${named.replace('Staging demo: ', '')}, in a thread only you can see. `
        + 'Tell me what to change there, and I\'ll make the next version.',
      // The thread's first message, its row written with it (sendDm `thread`).
      thread: { kind: 'design', appId: app.id },
      moment: null,
      metadata: { kind: 'opened_design', appSlug: app.slug, appName: app.name || app.slug, designTitle: named },
    });
    if (!opened?.messageId) return;
    const thread = (await pool.query(
      'SELECT id FROM private_threads WHERE root_message_id = $1 AND user_id = $2',
      [opened.messageId, member.id]
    )).rows[0];
    if (!thread) return;
    await pool.query(
      `INSERT INTO design_threads (private_thread_id, title, surface, route, width, height)
       VALUES ($1, $2, 'platform', '/?demo=1#homeroom-bot', 1280, 800)
       ON CONFLICT (private_thread_id) DO NOTHING`,
      [thread.id, named]
    );
    // A small, obviously fake Homeroom bot page with demo rows: the shape a
    // real copy keeps, at its real columns (rail 212, list 668, Main 400).
    const rows = ['A request to review its plan', 'A change waiting for votes', 'A flaky check to fix']
      .map((say) => `<div style="padding:10px 14px;border-radius:12px;box-shadow:inset 0 0 0 1px #e4e4e7;margin-top:8px">`
        + `<strong style="font-size:14px">${say}</strong>`
        + '<div style="font-size:12px;color:#71717a;margin-top:2px">Staging demo row</div></div>')
      .join('');
    const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
      + '<body style="margin:0;font-family:system-ui,sans-serif;background:#f4f4f5;color:#18181b;display:flex;width:1280px;height:800px">'
      + '<nav style="width:212px;box-sizing:border-box;background:#fff;box-shadow:inset -1px 0 0 #e4e4e7;padding:16px 12px">'
      + '<div style="font-weight:700;font-size:17px;padding:4px 8px 16px">Homeroom</div>'
      + '<div style="padding:8px;font-size:15px;border-radius:10px;background:#eef2ff;color:#1d4ed8;font-weight:650">AI</div>'
      + '</nav>'
      + '<main style="flex:1;padding:24px;box-sizing:border-box">'
      + '<div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#71717a">Needs you</div>'
      + rows + '</main>'
      + '<aside style="width:400px;background:#fff;box-shadow:inset 1px 0 0 #e4e4e7;padding:18px">'
      + '<div style="font-size:15px;font-weight:650">Main Chat</div>'
      + '<div style="font-size:13px;color:#71717a;margin-top:4px">Only you can see this thread</div>'
      + '<p style="font-size:14px;color:#52525b;margin-top:16px">Staging demo: the Homeroom bot page as it is now.</p>'
      + '</aside></body></html>';
    await pool.query(
      `INSERT INTO design_versions (private_thread_id, version, html, author, note)
       VALUES ($1, 1, $2, 'capture', 'As it is now')
       ON CONFLICT (private_thread_id, version) DO NOTHING`,
      [thread.id, html]
    );
    const change = html.replace(
      '<div style="font-size:15px;font-weight:650">Main Chat</div>',
      '<input placeholder="Search threads" style="box-sizing:border-box;width:100%;height:34px;border-radius:10px;'
        + 'border:1px solid #d4d4d8;padding:0 10px;font-size:14px;margin-bottom:10px">'
        + '<div style="font-size:15px;font-weight:650">Main Chat</div>'
    );
    await pool.query(
      `INSERT INTO design_versions (private_thread_id, version, html, author, note)
       VALUES ($1, 2, $2, 'bot', 'a search box over the list')
       ON CONFLICT (private_thread_id, version) DO NOTHING`,
      [thread.id, change]
    );
    const first = await dm.sendDm(pool, {
      bot,
      userId: member.id,
      content: 'Version 1: As it is now.\n\nVersion 2: a search box over the list.',
      threadRootId: opened.messageId,
      moment: null,
      idempotencyKey: `staging-captured-page-${thread.id}`,
      metadata: { kind: 'design_version', appSlug: app.slug, appName: app.name || app.slug, designVersion: 2 },
    }).catch(() => null);
    if (first?.messageId) {
      await pool.query(
        'UPDATE design_versions SET message_id = $2 WHERE private_thread_id = $1 AND version IN (1, 2)',
        [thread.id, first.messageId]
      );
    }
    log.info('db', 'Staging captured design thread seeded', { threadId: thread.id });
  } catch (err) {
    log.warn('db', 'Staging captured design thread seeding failed', { message: err.message });
  }
}

// 20 Nov 2026 (live-draft review, K): a thread holds several artifacts, and
// the thread's artifacts column picks between them. A clean staging copy has
// no bot turn to run (there is no model), so this stores what two turns
// leave in the capture member's chat: one thread holding two pages, the
// first at version 2 and the second at version 1, each version said by the
// bot's line as a turn says it. Written through the store
// (services/artifacts.js). Obviously fake, idempotent by the thread's first
// message (its key) and its holding two artifacts already, and a strict
// no-op outside staging.
const STAGING_ARTIFACTS_KEY = 'staging-artifacts-thread';
const STAGING_ARTIFACT_TITLES = Object.freeze(['Staging demo: style directions', 'Staging demo: list layouts']);

/** Pure: a small, obviously fake page for the two-artifact fixture. */
function stagingArtifactPage(title, rows, accent) {
  const items = rows.map((row) => `<li style="padding:12px 14px;border-radius:12px;background:#fff;`
    + `box-shadow:inset 0 0 0 1px #e4e4e7;margin-top:8px;font-size:15px">${row}</li>`).join('');
  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + `<body style="margin:0;font-family:system-ui,sans-serif;background:#faf8f5;color:#18181b">`
    + `<main style="padding:24px 16px"><h1 style="font-size:20px;margin:0;color:${accent}">${title}</h1>`
    + '<p style="font-size:13px;color:#71717a;margin:6px 0 0">Staging demo page: obviously fake.</p>'
    + `<ul style="list-style:none;margin:12px 0 0;padding:0">${items}</ul></main></body></html>`;
}

async function seedStagingArtifactsThread(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const member = (await pool.query(
      'SELECT id FROM users WHERE username = \'usernode-capture\' AND is_synthetic = FALSE LIMIT 1'
    )).rows[0];
    if (!member) return seedSkipped('no user usernode-capture');
    // The bot's account, in the posture botAccount() reads.
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`
    );
    const bot = (await pool.query(
      'SELECT id FROM users WHERE username = \'homeroom_bot\' AND is_synthetic = TRUE LIMIT 1'
    )).rows[0];
    if (!bot || Number(bot.id) === Number(member.id)) return seedSkipped('no separate Homeroom bot user');
    const dm = require('../services/homeroom-bot-dm');
    const store = require('../services/artifacts');
    const user = { id: Number(member.id) };
    // The thread's first message, its row written with it (sendDm `thread`),
    // as a thread the bot opens for a page starts (design-threads.js
    // openDrawThread). The same key finds the same message on a later boot.
    const opened = await dm.sendDm(pool, {
      bot,
      userId: member.id,
      content: 'Staging demo: I\'m writing two artifacts in this thread, a page of style directions and a page of list '
        + 'layouts. Only you can see it.',
      thread: { kind: 'ask', appId: null },
      moment: null,
      idempotencyKey: STAGING_ARTIFACTS_KEY,
      metadata: { kind: 'opened_thread', changeKind: 'any', designTitle: STAGING_ARTIFACT_TITLES[0] },
    });
    if (!opened?.messageId) return;
    const room = { rootId: Number(opened.messageId), conversationId: Number(opened.conversationId), app: null };
    const held = await store.artifactFor(pool, { userId: member.id, rootId: room.rootId });
    if ((held?.artifacts || []).length >= 2) return;
    // Each version as a turn keeps it: the store's version, then the bot's
    // line that says it ("Title, version N: ..." once the thread holds two),
    // and that line's id on the version.
    const say = async (artifact, html, note, line) => {
      const made = await store.addVersion(pool, { threadId: artifact.threadId, artifactId: artifact.artifactId, html, author: 'bot', note });
      if (!made) return;
      const sent = await dm.sendDm(pool, {
        bot,
        userId: member.id,
        content: line,
        threadRootId: room.rootId,
        moment: null,
        idempotencyKey: `${STAGING_ARTIFACTS_KEY}-a${artifact.artifactId}-v${made.version}`,
        metadata: { kind: 'design_version', designVersion: made.version, artifactId: artifact.artifactId, designTitle: artifact.title },
      }).catch(() => null);
      await store.noteVersionMessage(pool, {
        threadId: artifact.threadId, artifactId: artifact.artifactId, version: made.version, messageId: sent?.messageId,
      });
    };
    let first = held;
    if (!first) {
      const made = await store.addArtifact(pool, {
        user, thread: room, kind: 'page', title: STAGING_ARTIFACT_TITLES[0], viewport: 'phone', surface: 'new',
      });
      first = made.ok ? made.artifact : null;
    }
    if (!first) return;
    if (!first.latest) {
      const rows = ['Calm: warm greys, one blue accent', 'Bold: dark ground, bright type', 'Soft: rounded cards, pastel tints'];
      await say(first, stagingArtifactPage('Style directions', rows, '#0a6ee0'), 'Staging demo: three style directions',
        'Version 1: Staging demo: three style directions.');
      await say(first, stagingArtifactPage('Style directions', rows, '#18181b'), 'Staging demo: a darker title',
        'Version 2: Staging demo: a darker title.');
    }
    const second = await store.addArtifact(pool, {
      user, thread: room, kind: 'page', title: STAGING_ARTIFACT_TITLES[1], viewport: 'phone', surface: 'new',
    });
    if (!second.ok) return;
    await say(second.artifact,
      stagingArtifactPage('List layouts', ['Plain rows with a chevron', 'Inset grouped cards', 'Rows with a leading icon'], '#0a6ee0'),
      'three ways to lay out a list',
      require('../services/design-threads').versionLine(1, 'three ways to lay out a list', { title: STAGING_ARTIFACT_TITLES[1] }));
    log.info('db', 'Staging two-artifact thread seeded', { rootId: room.rootId });
  } catch (err) {
    log.warn('db', 'Staging two-artifact thread seeding failed', { message: err.message });
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
      // One Home (#6361): Home's Pinned communities. The demo app's
      // community (one the viewer is in) and Chess Arena's (followed, not
      // joined: a pin is not a join), so the shots and the checks see both
      // kinds of tile. The other demo apps stay Communities to join.
      await pool.query(
        `INSERT INTO home_community_pins (community_id, user_id, position)
         SELECT a.community_id, $1, CASE a.slug WHEN 'staging-demo-app' THEN 0 ELSE 1 END
           FROM apps a
          WHERE a.slug IN ('staging-demo-app', 'staging-demo-chess-arena')
            AND a.community_id IS NOT NULL
         ON CONFLICT (user_id, community_id) DO NOTHING`,
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
// has a featured list, preserving its ordering. Only the synthetic fixtures
// are added here, never one an admin flagged, and ON CONFLICT keeps their
// positions on subsequent boots.
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
    // Explicitly synthetic fixtures for captures and the reversible
    // Discover-add check: a featured app needs an icon for its card.
    await pool.query(
      `UPDATE apps SET icon_emoji = '🧩'
       WHERE slug IN ('staging-demo-puzzle-chain', 'staging-demo-word-garden',
                      'staging-demo-pixel-racer')
         AND created_by = (SELECT id FROM users WHERE username = 'staging-demo-user')
         AND icon_emoji IS NULL AND icon_image_id IS NULL`
    );
    const { rows: candidates } = await pool.query(
      `SELECT id FROM apps
        WHERE slug IN ('staging-demo-puzzle-chain', 'staging-demo-word-garden',
                       'staging-demo-pixel-racer')
          AND created_by = (SELECT id FROM users WHERE username = 'staging-demo-user')
          AND directory_review_status NOT IN ('demo', 'broken')
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

// #6660: Home's Featured heading names the chosen kind ("Featured in Games")
// once one is picked, and the sort beside More communities needs two cards to
// order, so the after copy needs featured games and more than one game. The
// featured fixtures above carry no category, and a fresh staging copy has no
// app_inferred_categories rows either. Two of them are games here, and so is
// the unfeatured chess fixture, which leaves something under More
// communities: display data on fake apps only, and only where no category is
// set, so a real one is never overwritten. Idempotent on every boot; strictly
// a no-op outside staging.
async function seedStagingFeaturedKinds(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    await pool.query(
      `UPDATE apps AS a
          SET manifest_snapshot = COALESCE(a.manifest_snapshot, '{"secrets": []}'::jsonb)
                || '{"category": "games"}'::jsonb
        WHERE a.slug IN ('staging-demo-puzzle-chain', 'staging-demo-word-garden',
                         'staging-demo-chess-arena')
          AND NOT (COALESCE(a.manifest_snapshot, '{}'::jsonb) ? 'category')`
    );
    log.info('db', 'Staging featured-app kinds seeded');
  } catch (err) {
    log.warn('db', 'Staging featured-app kinds seeding failed', { message: err.message });
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
      await withStagingMedia(pool, data, CT[r.media], (tx, m) => tx.query(
        `INSERT INTO session_visuals
           (id, session_id, commit_hash, kind, media, content_type, object_key, captured_path, capture_index, captured_viewport, before_fell_back,
            sha256, bytes, legacy_etag)
         SELECT $1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
          WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $2)
         ON CONFLICT (id) DO NOTHING`,
        [r.id, DEMO_SESSION_ID, r.kind, r.media, CT[r.media], m.key, r.path, r.idx, r.viewport || null, !!r.fellBack,
          m.sha256, m.bytes, m.legacyEtag]
      ));
    }
    // Give the promoted demo session a 'partial' capture outcome so the
    // proposal card's capture-state surfaces render against it (its group 1
    // before row is a fell-back shot and group 4 is after-only).
    await pool.query(
      `UPDATE chat_sessions
          SET capture_state = 'partial',
              capture_detail = $1::jsonb,
              captured_at = NOW()
        WHERE id = $2 AND capture_state IS NULL AND NOT wf_holds('preview', 'session:' || id)`,
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
        await withStagingMedia(pool, a.media === 'webm' ? WEBM_PLACEHOLDER : PNG_1X1, CT[a.media], (tx, m) => tx.query(
          `INSERT INTO session_visuals
             (id, session_id, commit_hash, kind, media, content_type, object_key,
              captured_path, capture_index, captured_viewport, shot_status, before_fell_back, sha256, bytes, legacy_etag)
           SELECT $1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, 200, $10, $11, $12, $13
            WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $2)
           ON CONFLICT (id) DO NOTHING`,
          [id, p.id, a.kind, a.media, CT[a.media], m.key,
            a.path, a.idx, a.viewport || null, !!a.fellBack, m.sha256, m.bytes, m.legacyEtag]
        ));
      }
    }
    log.info('db', 'Staging gallery fixtures seeded', { proposals: proposals.length });
  } catch (err) {
    log.warn('db', 'Staging gallery seeding failed', { message: err.message });
  }
}

// A proposal with published before & after shots whose shots agent also
// noticed problems on the after build, so the card's "Also noticed" can be
// seen (and shot) on a preview. shot_runs and shot_artifacts are
// staging:private, so no clone has a published run, and the demo states the
// shots copies get are written by the deployed platform's code, not this
// revision's. One merged proposal on the gallery's own demo app
// (seedStagingGalleryProposals, which must run first), so it is listed
// first in the admin Screenshot gallery as well, and its change page is
// /#app/staging-demo-gallery-app/dev/proposals/900108. The run is verified
// on the proposal's reviewed head, with a desktop and a phone screen per
// side drawn as plain bars (services/bench/demo.js demoPng) in light and,
// so the card's theme flip is reachable (#4459), in dark, and two
// notices: one also on the before build, one not. Every word is an
// obviously fake "Staging demo" line; fixed ids, idempotent, and a strict
// no-op outside staging.
const STAGING_SHOTS_NOTICED_SESSION_ID = 900108;

// #6825: the smaller copies a saved still keeps, and its blurred preview, as
// a real run makes them (services/shots-sized.js). Seeded beside the
// artifact so a staging preview has what a saved still has; a copy that
// cannot be made leaves the still exactly as it was.
async function seedSizedCopies(pool, file) {
  const { sizedCopies } = require('../services/shots-sized');
  const copies = await sizedCopies(file.data);
  const keys = {};
  for (const name of ['thumb', 'screen']) {
    const copy = copies[name];
    if (!copy) continue;
    await withStagingMedia(pool, copy.data, copy.contentType || 'image/webp', (tx, m) => Promise.resolve(m));
    keys[name] = copy;
  }
  if (!keys.thumb && !keys.screen && !copies.placeholder) return;
  await pool.query(
    `UPDATE shot_artifacts
        SET thumb_object_key = $2, thumb_width = $3, thumb_height = $4, thumb_bytes = $5, thumb_sha256 = $6,
            screen_object_key = $7, screen_width = $8, screen_height = $9, screen_bytes = $10, screen_sha256 = $11,
            placeholder = $12, thumb_content_type = $13, screen_content_type = $14
      WHERE id = $1`,
    [file.id,
      keys.thumb ? media.objectKey(keys.thumb.data) : null, keys.thumb?.width ?? null, keys.thumb?.height ?? null,
      keys.thumb?.bytes ?? null, keys.thumb?.sha256 ?? null,
      keys.screen ? media.objectKey(keys.screen.data) : null, keys.screen?.width ?? null, keys.screen?.height ?? null,
      keys.screen?.bytes ?? null, keys.screen?.sha256 ?? null,
      copies.placeholder, keys.thumb?.contentType ?? null, keys.screen?.contentType ?? null]
  );
}

async function seedStagingShotsNoticed(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const crypto = require('crypto');
  const { demoPng } = require('../services/bench/demo');
  const planContract = require('../services/visible-changes');
  const shotsState = require('../services/shots-state');
  const id = STAGING_SHOTS_NOTICED_SESSION_ID;
  const runId = `${id}`.padEnd(32, 'e');
  const baseSha = 'c'.repeat(40);
  const headSha = 'd'.repeat(40);
  try {
    const intent = planContract.parseIntent({
      version: 1,
      impact: 'ui',
      rationale: 'Staging demo: the board gains a sort control.',
      stories: [{
        id: 'board-sort',
        claim: 'Staging demo: the board shows a Newest sort control above its columns.',
        persona: 'member',
        viewports: [
          { name: 'desktop', width: 1280, height: 800 },
          { name: 'phone', width: 390, height: 844 },
        ],
        intent: {
          startPath: '/board',
          steps: ['Open the board'],
          checkpoint: 'The sort control is above the columns',
          focus: 'Sort control',
          baseState: 'not_present',
          animation: 'none',
        },
      }],
    });
    const notices = [
      { text: 'Staging demo: the Newest sort control overlaps the Done column heading.',
        change: 'board-sort', screen: 'desktop', shot: 'screen', alsoBefore: true },
      { text: 'Staging demo: the last column is cut off at the right edge.',
        change: 'board-sort', screen: 'phone', shot: 'screen', alsoBefore: false },
    ];
    // Plain bars: a header, then the columns; the after side adds the
    // sort control (the accent bar) between them.
    const ground = [250, 250, 249];
    const ink = [214, 211, 209];
    const accent = [37, 99, 235];
    const shot = (width, height, side) => demoPng(width, height, ground, [
      { y: 32, h: 40, rgb: ink },
      ...(side === 'head' ? [{ y: 96, h: 32, rgb: accent }] : []),
      ...[0, 1, 2].map((i) => ({ y: 152 + i * 104, h: 80, rgb: ink })),
    ]);
    const files = [];
    for (const [viewport, width, height] of [['desktop', 1280, 800], ['phone', 390, 844]]) {
      for (const side of ['base', 'head']) {
        const data = shot(width, height, side);
        files.push({
          id: crypto.createHash('sha256').update(`staging-shots-noticed:${viewport}:${side}`).digest('hex').slice(0, 32),
          viewport, side, data, width, height,
          sha256: crypto.createHash('sha256').update(data).digest('hex'),
          theme: 'light',
        });
      }
    }
    // The same screens in the viewer's other mode (#4459), so the card's
    // theme flip is reachable on a preview: dark ground, dimmer bars, and
    // the sort control in the accent's dark-tuning shade. Kept out of the
    // verdict the way a real run leaves its dark shots out of a story's
    // file count.
    const darkGround = [24, 24, 27];
    const darkInk = [82, 82, 91];
    const darkAccent = [139, 92, 246];
    const darkShot = (width, height, side) => demoPng(width, height, darkGround, [
      { y: 32, h: 40, rgb: darkInk },
      ...(side === 'head' ? [{ y: 96, h: 32, rgb: darkAccent }] : []),
      ...[0, 1, 2].map((i) => ({ y: 152 + i * 104, h: 80, rgb: darkInk })),
    ]);
    for (const [viewport, width, height] of [['desktop', 1280, 800], ['phone', 390, 844]]) {
      for (const side of ['base', 'head']) {
        const data = darkShot(width, height, side);
        files.push({
          id: crypto.createHash('sha256').update(`staging-shots-noticed:${viewport}:${side}:dark`).digest('hex').slice(0, 32),
          viewport, side, data, width, height,
          sha256: crypto.createHash('sha256').update(data).digest('hex'),
          theme: 'dark',
        });
      }
    }
    const verdict = {
      passed: true, mode: 'shots', runs: 1,
      stories: [{ id: 'board-sort', status: 'ready', files: files.length }],
      notices,
      // #5063: the card's side-by-side view crops to the declared changes,
      // so the demo run carries where they differ: the accent bar the after
      // image draws between the header and the rows.
      screens: [['desktop', 1280, 800], ['phone', 390, 844]].map(([viewport, width, height]) => ({
        viewport,
        shot: 'board-sort',
        stories: ['board-sort'],
        width,
        heightBefore: height,
        heightAfter: height,
        regions: [{ story: 'board-sort', b: [0, 96, width, 32], a: [0, 96, width, 32], bMark: null, aMark: null }],
      })),
    };
    const planHash = crypto.createHash('sha256')
      .update(`staging-shots-noticed:${files.map((file) => file.sha256).join(':')}`).digest('hex');
    // The proposal's own copy of the run, as a published run leaves it.
    const detail = {
      ...shotsState.runSummary({
        id: runId, state: 'verified', intent, base_sha: baseSha, head_sha: headSha,
        plan_hash: planHash, hard_verdict: verdict,
      }),
      intent,
    };

    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status,
          promoted_at, merged_at, reviewed_head_sha,
          shots_state, shots_run_id, shots_detail, shots_updated_at)
       SELECT $1::int, 900106, u.id, 'staging-demo/shots-also-noticed', $1::int,
              '[Mock] Staging demo: before & after with Also noticed', 'merged',
              NOW() - interval '2 hours', NOW() - interval '1 hour', $2::varchar,
              'verified', $3::varchar, $4::jsonb, NOW()
         FROM users u
        WHERE u.username = 'staging-demo-user'
          AND EXISTS (SELECT 1 FROM apps WHERE id = 900106)
       ON CONFLICT (id) DO NOTHING`,
      [id, headSha, runId, JSON.stringify(detail)]
    );
    // Its builds are long gone, as a published run's are: the cleanup sweep
    // has nothing to tear down for it.
    const cleaned = {
      cleanupComplete: true,
      cleanupVersion: require('../services/shots-environment').RESOURCE_CLEANUP_VERSION,
    };
    await pool.query(
      `INSERT INTO shot_runs
         (id, session_id, base_sha, head_sha, plan_hash, intent, hard_verdict,
          trace_summary, state, trigger, started_at, completed_at)
       SELECT $1::varchar, $2::int, $3::varchar, $4::varchar, $5::varchar, $6::jsonb, $7::jsonb, $8::jsonb,
              'verified', 'staging-fixture', NOW() - interval '3 hours', NOW() - interval '3 hours'
        WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $2::int AND app_id = 900106)
          AND NOT wf_holds('shots', 'session:' || $2::int)
       ON CONFLICT (id) DO NOTHING`,
      [runId, id, baseSha, headSha, planHash, JSON.stringify(intent), JSON.stringify(verdict),
        JSON.stringify(cleaned)]
    );
    for (const file of files) {
      await withStagingMedia(pool, file.data, 'image/png', (tx, m) => tx.query(
        `INSERT INTO shot_artifacts
           (id, run_id, story_id, viewport, side, variant, media, content_type,
            object_key, width, height, bytes, sha256, theme)
         SELECT $1::varchar, $2::varchar, 'board-sort', $3::varchar, $4::varchar, 'context', 'png', 'image/png',
                $5::text, $6::int, $7::int, $8::int, $9::varchar, $10::varchar
          WHERE EXISTS (SELECT 1 FROM shot_runs WHERE id = $2::varchar)
         ON CONFLICT (id) DO NOTHING`,
        [file.id, runId, file.viewport, file.side, m.key, file.width, file.height,
          file.data.length, file.sha256, file.theme]
      ));
      // #6825: the still's smaller copies and its blurred preview, which a
      // real run makes as it saves (services/shots-sized.js), so a slot on a
      // preview picks a copy by size and draws the preview while it loads.
      await seedSizedCopies(pool, file);
    }
    log.info('db', 'Staging shots "Also noticed" fixture seeded', { sessionId: id });
  } catch (err) {
    log.warn('db', 'Staging shots "Also noticed" seeding failed', { message: err.message });
  }
}

// A proposal waiting on the shots member's vote whose published before &
// after shots hold THREE phone screens, so a preview's Needs you can draw a
// change with several screens (the new review flow's row of screens under
// its picture, features/review-flow/). The demo PR seedStagingDemoAppCard
// makes has only the old one-picture capture, and seedStagingShotsNoticed's
// two screens are on a merged proposal, so nothing in a fresh copy showed
// more than one screen to vote on. One promoted proposal on the demo app
// (900001, where usernode-capture is a member), owned by staging-demo-user,
// its run verified on its reviewed head. Each screen is plain bars
// (services/bench/demo.js demoPng), light only, with its change at a
// different height: near the top, in the middle, near the foot. Every word
// is an obviously fake "Staging demo" line; fixed ids, idempotent, and a
// strict no-op outside staging.
const STAGING_SHOTS_SCREENS_SESSION_ID = 900160;

async function seedStagingShotsScreens(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const crypto = require('crypto');
  const { demoPng } = require('../services/bench/demo');
  const planContract = require('../services/visible-changes');
  const shotsState = require('../services/shots-state');
  const id = STAGING_SHOTS_SCREENS_SESSION_ID;
  const runId = `${id}`.padEnd(32, 'e');
  const baseSha = 'e'.repeat(40);
  const headSha = 'f'.repeat(40);
  const phone = { name: 'phone', width: 390, height: 844 };
  // Where each screen changed: the accent bar its after side adds.
  const SCREENS = [
    { story: 'top-filter', y: 96, h: 32, claim: 'Staging demo: the list gains a filter row under its heading.' },
    { story: 'middle-badge', y: 392, h: 40, claim: 'Staging demo: each row in the middle of the list shows a badge.' },
    { story: 'foot-action', y: 704, h: 48, claim: 'Staging demo: a Save button sits at the foot of the form.' },
  ];
  try {
    const intent = planContract.parseIntent({
      version: 1,
      impact: 'ui',
      rationale: 'Staging demo: three screens, each changed in a different place.',
      stories: SCREENS.map((screen) => ({
        id: screen.story,
        claim: screen.claim,
        persona: 'member',
        viewports: [phone],
        intent: {
          startPath: '/',
          steps: ['Open the screen'],
          checkpoint: 'The change is on the screen',
          focus: 'The changed bar',
          baseState: 'not_present',
          animation: 'none',
        },
      })),
    });
    const ground = [250, 250, 249];
    const ink = [214, 211, 209];
    const accent = [37, 99, 235];
    // A header, then rows; the after side adds the screen's accent bar.
    const draw = (screen, side) => demoPng(phone.width, phone.height, ground, [
      { y: 32, h: 40, rgb: ink },
      ...(side === 'head' ? [{ y: screen.y, h: screen.h, rgb: accent }] : []),
      ...[0, 1, 2, 3, 4, 5].map((i) => ({ y: 152 + i * 96, h: 64, rgb: ink }))
        .filter((bar) => side !== 'head' || bar.y + bar.h <= screen.y || bar.y >= screen.y + screen.h),
    ]);
    const files = [];
    for (const screen of SCREENS) {
      for (const side of ['base', 'head']) {
        const data = draw(screen, side);
        files.push({
          id: crypto.createHash('sha256').update(`staging-shots-screens:${screen.story}:${side}`).digest('hex').slice(0, 32),
          story: screen.story, side, data,
          sha256: crypto.createHash('sha256').update(data).digest('hex'),
        });
      }
    }
    const verdict = {
      passed: true, mode: 'shots', runs: 1,
      stories: SCREENS.map((screen) => ({ id: screen.story, status: 'ready', files: 2 })),
      notices: [],
      screens: SCREENS.map((screen) => ({
        viewport: 'phone',
        shot: screen.story,
        stories: [screen.story],
        width: phone.width,
        heightBefore: phone.height,
        heightAfter: phone.height,
        regions: [{ story: screen.story, b: null, a: [0, screen.y, phone.width, screen.h], bMark: null, aMark: null }],
      })),
    };
    const planHash = crypto.createHash('sha256')
      .update(`staging-shots-screens:${files.map((file) => file.sha256).join(':')}`).digest('hex');
    const detail = {
      ...shotsState.runSummary({
        id: runId, state: 'verified', intent, base_sha: baseSha, head_sha: headSha,
        plan_hash: planHash, hard_verdict: verdict,
      }),
      intent,
    };

    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status,
          promoted_at, reviewed_head_sha, check_state,
          shots_state, shots_run_id, shots_detail, shots_updated_at)
       SELECT $1::int, 900001, u.id, 'staging-demo/three-screens', $1::int,
              '[Mock] Staging demo: three screens to compare', 'promoted',
              NOW() - interval '1 hour', $2::varchar, 'passing',
              'verified', $3::varchar, $4::jsonb, NOW()
         FROM users u
        WHERE u.username = 'staging-demo-user'
          AND EXISTS (SELECT 1 FROM apps WHERE id = 900001)
       ON CONFLICT (id) DO NOTHING`,
      [id, headSha, runId, JSON.stringify(detail)]
    );
    const cleaned = {
      cleanupComplete: true,
      cleanupVersion: require('../services/shots-environment').RESOURCE_CLEANUP_VERSION,
    };
    await pool.query(
      `INSERT INTO shot_runs
         (id, session_id, base_sha, head_sha, plan_hash, intent, hard_verdict,
          trace_summary, state, trigger, started_at, completed_at)
       SELECT $1::varchar, $2::int, $3::varchar, $4::varchar, $5::varchar, $6::jsonb, $7::jsonb, $8::jsonb,
              'verified', 'staging-fixture', NOW() - interval '2 hours', NOW() - interval '2 hours'
        WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $2::int AND app_id = 900001)
          AND NOT wf_holds('shots', 'session:' || $2::int)
       ON CONFLICT (id) DO NOTHING`,
      [runId, id, baseSha, headSha, planHash, JSON.stringify(intent), JSON.stringify(verdict),
        JSON.stringify(cleaned)]
    );
    for (const file of files) {
      await withStagingMedia(pool, file.data, 'image/png', (tx, m) => tx.query(
        `INSERT INTO shot_artifacts
           (id, run_id, story_id, viewport, side, variant, media, content_type,
            object_key, width, height, bytes, sha256, theme)
         SELECT $1::varchar, $2::varchar, $3::varchar, 'phone', $4::varchar, 'context', 'png', 'image/png',
                $5::text, $6::int, $7::int, $8::int, $9::varchar, 'light'
          WHERE EXISTS (SELECT 1 FROM shot_runs WHERE id = $2::varchar)
         ON CONFLICT (id) DO NOTHING`,
        [file.id, runId, file.story, file.side, m.key, phone.width, phone.height,
          file.data.length, file.sha256]
      ));
    }
    log.info('db', 'Staging three-screen shots fixture seeded', { sessionId: id });
  } catch (err) {
    log.warn('db', 'Staging three-screen shots seeding failed', { message: err.message });
  }
}

// Two changes built for one request, both up for a vote: the case a thread's
// page draws as a ballot between them (thread-changes.tsx Competing), which a
// fresh staging copy otherwise never has. Both are for the demo project's
// request #900001 and are obviously fake "Staging demo" rows by fake people.
// Their tests are marked passed so the ballot opens; no code stands behind
// them. Idempotent, and a no-op outside staging.
const STAGING_COMPETING_SESSION_IDS = [900170, 900171];

async function seedStagingCompetingChanges(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const rows = [
    { id: STAGING_COMPETING_SESSION_IDS[0], by: 'staging-demo-user', branch: 'staging-demo/competing-a', sha: 'a'.repeat(40), age: '2 hours',
      title: '[Mock] Staging demo: the switch beside the bell',
      summary: 'Staging demo summary. Adds the switch to the header, beside the bell.', source: 'generated' },
    { id: STAGING_COMPETING_SESSION_IDS[1], by: 'staging-demo-collab', branch: 'staging-demo/competing-b', sha: 'b'.repeat(40), age: '1 hour',
      title: '[Mock] Staging demo: the switch in the account menu',
      summary: 'Staging demo summary. Puts the switch in the account menu instead.', source: 'author' },
  ];
  try {
    for (const row of rows) {
      await pool.query(
        `INSERT INTO chat_sessions
           (id, app_id, user_id, branch_name, pr_number, pr_title, status,
            promoted_at, reviewed_head_sha, check_state, linked_issues,
            pr_summary_md, pr_summary_source)
         SELECT $1::int, 900001, u.id, $2::varchar, $1::int, $3::varchar, 'promoted',
                NOW() - $4::interval, $5::varchar, 'passing', ARRAY[900001],
                $6::text, $7::varchar
           FROM users u
          WHERE u.username = $8
            AND EXISTS (SELECT 1 FROM apps WHERE id = 900001)
         ON CONFLICT (id) DO NOTHING`,
        [row.id, row.branch, row.title, row.age, row.sha, row.summary, row.source, row.by]
      );
    }
    log.info('db', 'Staging competing changes seeded', { sessionIds: STAGING_COMPETING_SESSION_IDS });
  } catch (err) {
    log.warn('db', 'Staging competing changes seeding failed', { message: err.message });
  }
}

// The failed sibling of the two shots fixtures above (#6551): a change
// waiting for a vote whose before & after screenshots could not be taken.
// Authored by the shots' own member fixture (usernode-capture), who is a
// member of this app, so the retake that failure now offers its author is
// reachable on a preview. Every word is an obviously fake "Staging demo"
// line; fixed id, idempotent, and a strict no-op outside staging.
const STAGING_SHOTS_FAILED_SESSION_ID = 900161;

async function seedStagingShotsFailed(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const planContract = require('../services/visible-changes');
  const shotsState = require('../services/shots-state');
  const id = STAGING_SHOTS_FAILED_SESSION_ID;
  const runId = `${id}`.padEnd(32, 'f');
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const planHash = 'f'.repeat(64);
  const failureCode = 'shots_capture_incomplete';
  const failureReason = 'Staging demo: the screenshot agent could not reach the dialog.';
  try {
    const intent = planContract.parseIntent({
      version: 1,
      impact: 'ui',
      rationale: 'Staging demo: the header gains a sort control.',
      stories: [{
        id: 'header-sort',
        claim: 'Staging demo: the header shows a Newest sort control.',
        persona: 'member',
        viewports: [{ name: 'desktop', width: 1280, height: 800 }],
        intent: {
          startPath: '/',
          steps: ['Open the screen'],
          checkpoint: 'The sort control is in the header',
          focus: 'Sort control',
          baseState: 'not_present',
          animation: 'none',
        },
      }],
    });
    const cleaned = {
      cleanupComplete: true,
      cleanupVersion: require('../services/shots-environment').RESOURCE_CLEANUP_VERSION,
    };
    // The proposal's own copy of the run, as a failed run leaves it.
    const detail = {
      ...shotsState.runSummary({
        id: runId, state: 'failed', intent, base_sha: baseSha, head_sha: headSha,
        plan_hash: planHash, failure_code: failureCode, failure_reason: failureReason,
        hard_verdict: null, trace_summary: cleaned,
      }),
      intent,
    };
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status,
          created_at, promoted_at, reviewed_head_sha, check_state,
          shots_state, shots_run_id, shots_detail, shots_updated_at)
       SELECT $1::int, 900001, u.id, 'staging-demo/shots-failed', 9301::int,
              '[Mock] Staging demo: before & after could not be taken', 'promoted',
              NOW() - interval '4 hours', NOW() - interval '3 hours', $2::varchar, 'passing',
              'failed', $3::varchar, $4::jsonb, NOW() - interval '2 hours'
         FROM users u
        WHERE u.username = 'usernode-capture'
          AND EXISTS (SELECT 1 FROM apps WHERE id = 900001)
       ON CONFLICT (id) DO NOTHING`,
      [id, headSha, runId, JSON.stringify(detail)]
    );
    await pool.query(
      `INSERT INTO shot_runs
         (id, session_id, base_sha, head_sha, plan_hash, intent, hard_verdict,
          trace_summary, state, trigger, failure_code, failure_reason,
          started_at, completed_at)
       SELECT $1::varchar, $2::int, $3::varchar, $4::varchar, $5::varchar, $6::jsonb, NULL,
              $7::jsonb, 'failed', 'staging-fixture', $8::varchar, $9::text,
              NOW() - interval '3 hours', NOW() - interval '2 hours'
        WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $2::int AND app_id = 900001)
          AND NOT wf_holds('shots', 'session:' || $2::int)
       ON CONFLICT (id) DO NOTHING`,
      [runId, id, baseSha, headSha, planHash, JSON.stringify(intent),
        JSON.stringify(cleaned), failureCode, failureReason]
    );
    log.info('db', 'Staging failed-shots fixture seeded', { sessionId: id });
  } catch (err) {
    log.warn('db', 'Staging failed-shots seeding failed', { message: err.message });
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
// with the $20+ tier split into "capped" vs "kept going on own key" (own-key
// spend recorded that day). llm_usage is staging:private (schema-only clone
// → empty), so there is no per-day spend to bucket at all without seeding it
// here. We create obviously-fake users (staging-demo-spend-*) at fixed high
// ids, give a subset own-key spend so that branch lights up (the stored
// Anthropic key sentinel it used went with those keys, task 2275), and write
// 30 days of llm_usage spanning every bucket. A couple
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
      base: { 1: 250, 2: 750, 3: 1250, 4: 1750, 5: 2200, 6: 2500 }[f.tier] || 0,
      tier: f.tier,
    }));
    // Sentinel passwords are non-loginable and carry no real secret.
    await pool.query(
      `INSERT INTO users (id, username, password, is_admin)
       SELECT f.id, f.name, '!staging-fixture-no-login!', f.admin
         FROM jsonb_to_recordset($1::jsonb) AS f(id int, name text, admin boolean)
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(records)]
    );
    // Re-pin roles, and only backdate signups that are too recent.
    await pool.query(
      `UPDATE users u SET is_admin = f.admin,
              created_at = CASE WHEN u.created_at > NOW() - INTERVAL '45 days'
                                THEN NOW() - INTERVAL '45 days' ELSE u.created_at END
         FROM jsonb_to_recordset($1::jsonb) AS f(id int, admin boolean)
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

// #370: make the token/spend cap reproducible in a staging preview, so a
// tester meets what a send says once the cap is hit. Two idempotent,
// staging-only steps against the tester's own login (the admin / first
// user, the account staging previews sign in as):
//   1. Pin their per-user daily limit to 1¢ (users.daily_limit_cents).
//   2. Ensure today's recorded spend is well over that (≥ 50¢), so
//      limits.checkBudget reports "Daily limit reached".
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

  // How close to the cap to fill. One below the cap so a tester can
  // create exactly one app to hit the wall, without pre-tripping it. The
  // cap is the one the create route enforces (services/app-limit.js): a
  // preview clones production's platform_settings, so an app limit an
  // admin set there applies here too, and filling to MAX_APPS instead would
  // leave the wall out of reach.
  const cap = (await require('../services/app-limit').effective(pool, config))
    || config.maxApps || 30;
  const target = Math.max(0, cap - 1);
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

// #945: discussion-thread context for the bots. The threads themselves
// (chat_messages) ARE staging-copied, but chat_sessions is
// staging:private and truncated — so the fixture proposal sessions this
// file seeds land with no Discussion thread at all, and the
// proposal-thread half of the feature is unobservable on a staging
// preview. This seeds both halves of what a bot now reads:
//
//   * a proposal thread (thread_type='session') on the shared-session
//     fixture, with messages from two different people;
//   * an issue thread (thread_type='issue') on fixture issue #42, with one
//     message shaped like numbered answers to the bot's clarifying
//     questions;
//   * one 'vote' row and one 'system' row in the same threads, which the
//     loader must EXCLUDE, so a tester can confirm the bot cites the
//     human messages and not the lifecycle noise.
//
// Every message is prefixed "[staging fixture]" so it is recognisable
// verbatim when an agent quotes it back. Idempotent on the first
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

  // #6268: a message a person's coding agent posted for them that Homeroom
  // bot will not answer says so, quietly, under it. An agent cannot post
  // through the connector on a copy with no model, so the state the shots
  // need is written here: one agent row on the request's discussion, with
  // the reason the route stores when it skips one.
  await pool.query(
    `INSERT INTO chat_messages
       (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, posted_via, created_at)
     VALUES ($1, $2, $3, 'message', $4::jsonb, 'issue', 42, 'agent', NOW() - INTERVAL '42 minutes')`,
    [appId, other,
      '[staging fixture] @Homeroom bot, one more thing while you are in here: keep the mobile header as it is.',
      JSON.stringify({ homeroomBotSkip: { why: 'connector_run' } })],
  );

  log.info('db', 'Seeded staging discussion-context fixture', { appId, sessionId, issueNumber: 42 });
}

// #5351's shots: a close offer Homeroom bot has ALREADY made in a project's
// chat. The voice makes one only when its model answers a mention with an
// offer_close_request call, and a copy without a model key can never take
// that turn, so the state a fresh clone needs is written here: the shots'
// member (usernode-capture) asks the bot to propose closing a request, and
// the bot's reply in a reply thread under it carries the open offer — its
// buttons in metadata and its card (bot_cards, place thread), so a tap
// decides it through the ordinary route. The member is put in the self
// app's community, since membership gates taking part, not reading. Idem-
// potent on the open close_request offer row; strictly a no-op outside
// staging.
async function seedStagingBotCloseOffer(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    // The voice's own account, in the posture botAccount() reads: the
    // username with is_synthetic on top, sentinel password, never a login.
    await pool.query(
      `INSERT INTO users (username, password, is_synthetic)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE)
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`
    );
    const who = await pool.query(
      `SELECT
         (SELECT id FROM users WHERE username = 'homeroom_bot') AS bot,
         (SELECT id FROM users WHERE username = 'usernode-capture') AS member`
    );
    const botId = who.rows[0]?.bot || null;
    const memberId = who.rows[0]?.member || null;
    const { rows: appRows } = await pool.query('SELECT id, community_id FROM apps WHERE slug = $1', [config.selfAppSlug]);
    const app = appRows[0] || null;
    if (!botId || !memberId || !app) {
      log.warn('db', 'Staging bot close-offer fixture skipped', { botId, memberId, app: !!app });
      return seedSkipped('no Homeroom bot, no user usernode-capture or no project');
    }
    if (app.community_id) {
      await pool.query(
        `INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [app.community_id, memberId]
      );
    }
    const { rows: open } = await pool.query(
      // Its own, the member's: #6321's already-works note carries one for nobody.
      `SELECT id FROM bot_cards WHERE place = 'thread' AND app_id = $1 AND kind = 'close_request' AND status = 'open' AND user_id = $2
       UNION ALL
       SELECT id FROM homeroom_bot_voice_offers WHERE app_id = $1 AND kind = 'close_request' AND status = 'open' AND for_user_id = $2 LIMIT 1`,
      [app.id, memberId]
    );
    if (open.length) return;
    const ask = '[staging fixture] @Homeroom bot request #1 is done, can you propose closing it?';
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_messages WHERE app_id = $1 AND content = $2 LIMIT 1', [app.id, ask]
    );
    if (existing.length) return;
    const { rows: [askRow] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at)
       VALUES ($1, $2, $3, 'message', NOW() - INTERVAL '6 minutes') RETURNING id`,
      [app.id, memberId, ask]
    );
    const { rows: [offerRow] } = await pool.query(
      `INSERT INTO bot_cards (place, app_id, kind, args, user_id)
       VALUES ('thread', $1, 'close_request',
               '{"issueNumber": 1, "title": "Staging demo request", "why": "It is done"}'::jsonb,
               $2)
       RETURNING id`,
      [app.id, memberId]
    );
    const { rows: [replyRow] } = await pool.query(
      `INSERT INTO chat_messages
         (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, created_at)
       VALUES ($1, $2, $3, 'message',
               jsonb_build_object('homeroomBot', jsonb_build_object(
                 'kind', 'voice',
                 'offer', jsonb_build_object(
                   'id', $4::int, 'kind', 'close_request', 'status', 'open', 'forUserId', $5::int),
                 'actions', jsonb_build_array(
                   jsonb_build_object('id', 'yes', 'label', 'Propose to close', 'style', 'primary', 'offerId', $4::int),
                   jsonb_build_object('id', 'no', 'label', 'Keep it open', 'style', 'secondary', 'offerId', $4::int)))),
               'message', $6, NOW() - INTERVAL '5 minutes')
       RETURNING id`,
      [app.id, botId,
        'Thanks. If request #1 is done, it can go: tap Propose to close below to open a vote on closing it. Nothing happens until you do, and it closes only if the group votes for it.',
        offerRow.id, memberId, askRow.id]
    );
    await pool.query("UPDATE bot_cards SET chat_message_id = $2 WHERE id = $1 AND place = 'thread'", [offerRow.id, replyRow.id]);
    log.info('db', 'Staging bot close-offer fixture seeded', { appId: app.id, offerId: offerRow.id, replyId: replyRow.id });
  } catch (err) {
    log.warn('db', 'Staging bot close-offer seeding failed', { message: err.message });
  }
}


// A change in review owned by the identity the declared checks sign in as
// (getStagingCheckViewer), so its page offers what only an author is offered:
// the title's pencil. chat_sessions is staging:private (schema-only in
// staging), hence the seed. Its id is fixed so the change page has a stable
// address for the dapp.json check
// (/#app/<self-slug>/dev/proposals/900801). Seeded 'promoted' and dated 30
// days old, so no sweep that looks at recent or active sessions touches it.
// Idempotent on the id, which also re-asserts the owner and the title.
const STAGING_OWN_REVIEW_CHANGE_ID = 900801;

async function seedStagingOwnReviewChange(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging own-review-change fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const owner = await getStagingCheckViewer(pool, 'Staging own-review-change fixture');
  if (!owner) return;

  const specMd = '## User-facing changes\n\nStaging demo: the leaderboard sorts by score.\n\n'
    + '## Technical implementation\n\nStaging demo: no real change, a fixture for the change page.';
  await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, pr_number, pr_title, status, spec_md, is_headless,
        created_at, last_activity_at, promoted_at)
     VALUES
       ($1, $2, $3, 'staging-fixture/own-review-change', 4242, $4, 'promoted', $5, FALSE,
        NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')
     ON CONFLICT (id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       pr_title = EXCLUDED.pr_title`,
    [STAGING_OWN_REVIEW_CHANGE_ID, appId, owner.id,
     '[staging fixture] Staging demo: sort the leaderboard by score', specMd]
  );

  log.info('db', 'Staging own-review-change fixture seeded', {
    appId, owner: owner.username, sessionId: STAGING_OWN_REVIEW_CHANGE_ID,
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


// 20 Oct 2026: the plan behind the staging Homeroom bot chat's
// complicated-change plan card (services/staging-messages.js
// BOT_DM_COMPLICATED_PLAN_SPEC), whose card now shows its plan: a
// leaderboard, as the card's lines say, with one phone screen before and
// after. Shared to the group, as the bot
// shares a plan it asks about, so the demo chat's reader may read it. Owned
// by the demo user; fixed id 900832.
async function seedStagingComplicatedPlanSpec(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const { specHtmlToMarkdown } = require('../services/spec-html');

  const { rows: appRows } = await pool.query('SELECT id FROM apps WHERE slug = $1', [config.selfAppSlug]);
  const appId = appRows[0]?.id;
  const { rows: demoRows } = await pool.query('SELECT id FROM users WHERE username = $1', ['staging-demo-user']);
  const demoUserId = demoRows[0]?.id;
  if (!appId || !demoUserId) {
    log.warn('db', 'Staging complicated-plan fixture skipped: self-app row or demo user missing');
    return;
  }

  const html = `<article data-spec-styles="platform" data-spec>
  <h1>Staging demo: a Leaderboard tab beside the list</h1>
  <p>A staging fixture: the plan Homeroom bot's demo chat asks about before it builds request #17.</p>
  <section data-spec-tab="user">
    <figure data-screens>
      <ol data-changes>
        <li data-change="1" data-steps="Open the list → Leaderboard">A Leaderboard tab beside the list</li>
        <li data-change="2" data-steps="Open the list → Leaderboard">Points for each item finished this week, your own place at the top</li>
      </ol>
      <template data-screen data-size="phone" data-focus="0 0 390 300">
        <style>
          .sl-page{font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:var(--bg-primary,#fff);color:var(--text-primary,#0a0a0a);height:844px;padding:20px 16px}
          .sl-title{font-size:22px;font-weight:700;margin:0 0 14px}
          .sl-tabs{display:flex;gap:8px;margin-bottom:14px}.sl-tabs span{padding:7px 14px;border-radius:999px;font-size:14px;font-weight:600;background:var(--bg-tertiary,#e9e9ec)}
          .sl-tabs .on{background:#18181b;color:#fff}
          .sl-row{display:flex;justify-content:space-between;align-items:center;padding:12px 4px;border-bottom:1px solid var(--border,#e3e3e6)}
          .sl-muted{color:var(--text-muted,#68686c);font-size:13px}.sl-you{font-weight:700}
        </style>
        <div class="sl-page">
          <p class="sl-title">Staging demo app</p>
          <div class="sl-tabs" data-side="before"><span class="on">List</span></div>
          <div class="sl-tabs" data-side="after" data-change="1"><span>List</span><span class="on">Leaderboard</span></div>
          <div data-side="before">
            <div class="sl-row"><span>Water the plants</span><span class="sl-muted">Today</span></div>
            <div class="sl-row"><span>Take the bins out</span><span class="sl-muted">Tomorrow</span></div>
            <div class="sl-row"><span>Clean the kitchen</span><span class="sl-muted">Friday</span></div>
          </div>
          <div data-side="after" data-change="2">
            <div class="sl-row sl-you"><span>You · 2nd</span><span>40 points</span></div>
            <div class="sl-row"><span>1. ada</span><span class="sl-muted">60 points</span></div>
            <div class="sl-row"><span>3. mika</span><span class="sl-muted">25 points</span></div>
          </div>
        </div>
      </template>
    </figure>
    <h3>What changes</h3>
    <ul><li><b>A Leaderboard tab.</b> It sits beside the list.</li><li><b>Points for each item you finish.</b> They count up over the week and start again on Monday.</li><li><b>Your own place at the top.</b> Then everyone else, most points first.</li></ul>
  </section>
  <section data-spec-tab="tech">
    <p>A staging fixture: no code stands behind this plan.</p>
  </section>
</article>`;
  const markdown = specHtmlToMarkdown(html).trim();

  const sessionId = 900832;
  await pool.query(
    `INSERT INTO chat_sessions
       (id, app_id, user_id, branch_name, session_title, status, spec_md, spec_html, created_at)
     VALUES ($1, $2, $3, 'staging-fixture/complicated-plan', '[staging fixture] Staging demo: a leaderboard plan', 'paused',
       $4, $5, NOW() - INTERVAL '30 minutes')
     ON CONFLICT (id) DO UPDATE SET spec_md = EXCLUDED.spec_md, spec_html = EXCLUDED.spec_html`,
    [sessionId, appId, demoUserId, markdown, html]
  );
  await pool.query(
    `INSERT INTO chat_session_specs (session_id, version, content, content_html, shared_to_group_at)
     VALUES ($1, 1, $2, $3, NOW() - INTERVAL '25 minutes')
     ON CONFLICT (session_id, version) DO UPDATE SET content = EXCLUDED.content, content_html = EXCLUDED.content_html,
       shared_to_group_at = COALESCE(chat_session_specs.shared_to_group_at, EXCLUDED.shared_to_group_at)`,
    [sessionId, markdown, html]
  );
  log.info('db', 'Staging complicated-plan fixture seeded', { appId, sessionId });
}

// (#86) Staging fixtures for the private "Share to user" spec flow.
// chat_sessions, chat_session_specs, chat_session_spec_user_shares and
// notifications are all staging:private (schema-only in clones), so
// without seeding the recipient-side path — the 'spec_shared' drawer
// row and its click-through into the read-only spec panel — would be
// unreachable in a staging preview. Shares the admin-first "staging login
// user" convention with seedStagingNotifications.
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
// #5803: an admin's lone No starts a one-week countdown on a change. One
// fixture on the self-app shows it: a promoted change with two app admins,
// one of whom voted No two days ago and nobody voted Yes, so its card reads
// "Set aside in 5d" where it read "0 of 1 approval". The two admins are
// fake people; the author is the capture account the shots sign in as, so
// the change is theirs to see under Waiting for approval. Idempotent (the
// branch name), obviously fake, strictly a no-op outside staging.
async function seedStagingAdminNoPr(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging admin-No fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  // The fake people: the author (the capture account, when it exists) and
  // two app admins, one of whom votes No.
  const { rows: captureRows } = await pool.query(
    "SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1"
  );
  if (!captureRows.length) {
    log.warn('db', 'Staging admin-No fixture skipped: capture user missing');
    return;
  }
  const authorId = captureRows[0].id;
  await pool.query(
    `INSERT INTO users (id, username, password)
     VALUES
       (900320, 'staging-demo-admin-no', 'staging-demo-not-a-login'),
       (900321, 'staging-demo-admin-yes', 'staging-demo-not-a-login')
     ON CONFLICT DO NOTHING`
  );
  await pool.query(
    `INSERT INTO app_admins (app_id, user_id)
     VALUES ($1, 900320), ($1, 900321)
     ON CONFLICT (app_id, user_id) DO NOTHING`,
    [appId]
  );

  const branch = 'staging-fixture/admin-no';
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
          promoted_at, created_at)
       VALUES
         ($1, $2, $3, 9210, '[staging fixture] An admin voted No, and nobody said Yes',
          $4, 'promoted', NOW() - INTERVAL '3 days', NOW() - INTERVAL '4 days')
       RETURNING id`,
      [appId, authorId, branch,
       'In plain terms: this proposed change shows what a change looks like after one of the project\'s admins voted No and nobody has voted Yes yet.']
    );
    sessionId = rows[0].id;
  }

  // The admin's No, two days old: the week has five days left to run. No Yes
  // beside it, so the countdown is armed.
  await pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch, created_at)
     SELECT $1, 900320, 'no', cs.approval_epoch, NOW() - INTERVAL '2 days'
       FROM chat_sessions cs WHERE cs.id = $1
     ON CONFLICT (session_id, user_id) DO UPDATE
       SET vote = 'no', approval_epoch = EXCLUDED.approval_epoch, created_at = EXCLUDED.created_at`,
    [sessionId]
  );

  log.info('db', 'Staging admin-No fixture seeded', { appId, sessionId });
}

// #5947: an approver's lone No sets a change aside two days after it. One
// fixture on the self-app shows the countdown: a promoted change one of the
// project's approvers voted No on a day ago, with an advisory Yes from a
// person who is not an approver, so its card reads "Set aside in 1d". The
// approver and the supporter are fake people; the author is the capture
// account the shots sign in as. Idempotent (the branch name), obviously
// fake, strictly a no-op outside staging.
async function seedStagingApproverNoPr(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    "SELECT id FROM apps WHERE slug = $1 AND approver_policy = 'invited'",
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging approver-No fixture skipped: no invited self-app row', {
      slug: config.selfAppSlug,
    });
    return;
  }
  const { rows: captureRows } = await pool.query(
    "SELECT id FROM users WHERE username = 'usernode-capture' LIMIT 1"
  );
  if (!captureRows.length) {
    log.warn('db', 'Staging approver-No fixture skipped: capture user missing');
    return;
  }
  const authorId = captureRows[0].id;
  await pool.query(
    `INSERT INTO users (id, username, password)
     VALUES
       (900330, 'staging-demo-approver-no', 'staging-demo-not-a-login'),
       (900331, 'staging-demo-supporter', 'staging-demo-not-a-login')
     ON CONFLICT DO NOTHING`
  );
  await pool.query(
    `INSERT INTO app_approvers (app_id, user_id, status, accepted_at)
     VALUES ($1, 900330, 'member', NOW())
     ON CONFLICT (app_id, user_id) DO NOTHING`,
    [appId]
  );

  const branch = 'staging-fixture/approver-no';
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
          promoted_at, created_at)
       VALUES
         ($1, $2, $3, 9230, '[staging fixture] An approver voted No, and no approver said Yes',
          $4, 'promoted', NOW() - INTERVAL '3 days', NOW() - INTERVAL '4 days')
       RETURNING id`,
      [appId, authorId, branch,
       'In plain terms: this proposed change shows what a change looks like after one of the project\'s approvers voted No and no approver has voted Yes yet.']
    );
    sessionId = rows[0].id;
  }

  // The approver's No, a day old: one of the two days is left. The
  // supporter's Yes is advisory (not an approver), so the countdown is armed.
  await pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch, created_at)
     SELECT $1, v.user_id, v.vote, cs.approval_epoch, NOW() - INTERVAL '1 day'
       FROM chat_sessions cs, (VALUES (900330, 'no'), (900331, 'yes')) AS v(user_id, vote)
      WHERE cs.id = $1
     ON CONFLICT (session_id, user_id) DO UPDATE
       SET vote = EXCLUDED.vote, approval_epoch = EXCLUDED.approval_epoch, created_at = EXCLUDED.created_at`,
    [sessionId]
  );

  log.info('db', 'Staging approver-No fixture seeded', { appId, sessionId });
}

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
              -- The preview machine's once it holds the row (its guard refuses
              -- a write from here).
              check_state = CASE WHEN wf_holds('preview', 'session:' || id) THEN check_state
                                 ELSE COALESCE($9, check_state) END,
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
  // #2722: an advisory "Content rules" flag rides on this passing proposal so
  // the staging preview shows the row without calling the reviewer. Advisory,
  // so check_state stays 'passing'.
  const fixture1Results = JSON.stringify([
    { name: 'loads with no console errors', status: 'pass' },
    {
      index: -5, name: 'Content rules', path: 'proposal diff', status: 'fail', advisory: true,
      consoleErrors: [], summary: '',
      failureReason: 'Flagged: Violence in src/staging-demo/game.js. Staging demo: the demo game shows a cartoon sword fight.',
      reviewedSha: headSha1,
    },
  ]);
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
            'passing', $6::jsonb,
            $4, NOW() - INTERVAL '10 minutes',
            $5, NOW() - INTERVAL '12 minutes', NOW() - INTERVAL '12 minutes')
         RETURNING id`,
        [appId, importer.id, branch1, headSha1, votesRequired, fixture1Results]
      );
      id1 = rows[0].id;
    } else {
      await pool.query(
        `UPDATE chat_sessions
            SET source = 'imported', imported_pr_head_sha = $2,
                imported_pr_author = 'octo-contributor', check_state = 'passing',
                checks_commit_sha = $2, checks_checked_at = NOW(),
                test_results = $3::jsonb
          WHERE id = $1 AND NOT wf_holds('preview', 'session:' || id)`,
        [id1, headSha1, fixture1Results]
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
          WHERE id = $1 AND NOT wf_holds('preview', 'session:' || id)`,
        [id2, headSha2]
      );
    }
    // Its run part-way through, with a unit suite it did not run again: the
    // same commit passed it 25 minutes earlier on the same worker image and
    // setup, and the run copied that pass (services/unit-suite-reuse.js). So
    // the Checks step's Unit tests row reads "Reused: … (run 5e1f0c2a)".
    // Re-stamped on every boot, so the age stays 25 minutes.
    await pool.query(
      `UPDATE chat_sessions
          SET checks_progress = jsonb_build_object(
                'ran', 312, 'passed', 312, 'failed', 0, 'expected', 840, 'done', false,
                'unit', jsonb_build_object(
                  'phase', 'done', 'ran', 23402, 'passed', 23380, 'failed', 0, 'skipped', 22,
                  'expected', 23402, 'done', true, 'exitOk', true,
                  'reused', jsonb_build_object(
                    'runId', '5e1f0c2a-9311-4a7b-8c3d-000000009311', 'sessionId', id,
                    'passedAt', to_char((NOW() - INTERVAL '25 minutes') AT TIME ZONE 'UTC',
                                        'YYYY-MM-DD"T"HH24:MI:SS"Z"'))))
        WHERE id = $1`,
      [id2]
    );
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
  // "Checks are starting…" / no-Preview-pill arrival page in a preview.
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
                promoted_at = CASE WHEN wf_holds('proposal', 'session:' || id) THEN promoted_at ELSE NOW() END
          WHERE id = $1 AND NOT wf_holds('preview', 'session:' || id)`,
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

  // Fixture 4: an imported proposal stacked on fixture 1's branch, so it
  // waits for #9310 (src/workflow/rules/pr-base.ts): the card's "Waits for
  // #9310" tag and the change page's notice. The row holds what a look at
  // the pull request records: the mock GitHub reports the same base for
  // #9313 (services/github-mock.js FIXTURE_BASES), so a look keeps it. The
  // wait is stamped only while #9310 is open. A preview that merged #9310
  // moves #9313 onto main; after a restart the mock forgets that move and
  // reports #9310's branch again, so #9313 then reads "Not based on main".
  const headSha4 = 'd5e4c3b2a1f0e9d8c7b6a5948372615f4e3d2c1b';
  const branch4 = 'staging-fixture/imported-pr-stacked';
  let id4;
  {
    const { rows: have } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch4]
    );
    id4 = have[0]?.id;
    if (!id4) {
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_url, pr_title, pr_summary_md,
            status, source, imported_pr_head_sha, imported_pr_author,
            imported_pr_base_ref, waits_for_session_id,
            check_state, checks_commit_sha, checks_checked_at,
            votes_required, promoted_at, created_at)
         VALUES
           ($1, $2, $3, 9313, 'https://github.com/example/example/pull/9313',
            '[staging fixture] Imported PR, stacked on #9310',
            'In plain terms: this pull request is built on top of #9310, so it goes live only after #9310 does.',
            'promoted', 'imported', $4, 'octo-contributor',
            $6, (SELECT id FROM chat_sessions WHERE id = $7 AND status IN ('active', 'paused', 'promoted', 'merging')),
            'passing', $4, NOW() - INTERVAL '6 minutes',
            $5, NOW() - INTERVAL '7 minutes', NOW() - INTERVAL '8 minutes')
         RETURNING id`,
        [appId, importer.id, branch4, headSha4, votesRequired, branch1, id1]
      );
      id4 = rows[0].id;
    } else {
      await pool.query(
        `UPDATE chat_sessions
            SET source = 'imported', imported_pr_head_sha = $2, imported_pr_author = 'octo-contributor',
                imported_pr_base_ref = $3, waits_for_session_id = $4
          WHERE id = $1 AND status = 'promoted'
            AND EXISTS (SELECT 1 FROM chat_sessions o WHERE o.id = $4 AND o.status IN ('active', 'paused', 'promoted', 'merging'))`,
        [id4, headSha4, branch1, id1]
      );
    }
  }

  log.info('db', 'Staging imported-PR fixtures seeded', {
    appId, healthy: id1, headChanged: id2, justImported: id3, stacked: id4,
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
          WHERE id = $1 AND NOT wf_holds('preview', 'session:' || id)`,
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

  // Matching history: the 40 passes and the blocking failure have all
  // passed on a change that merged (so they gate: merged_pass_at), the
  // advisory ones never have. Without these rows the cards would claim a
  // graduation state the Dev-side data doesn't back up.
  const crypto = require('crypto');
  const key = (name, p) => crypto.createHash('sha256').update(`${name}\n${p}`).digest('hex');
  const graduated = passes.concat([blockingFailure]);
  for (const r of graduated) {
    await pool.query(
      `INSERT INTO app_check_history
         (app_id, check_key, check_name, check_path, first_passed_at, last_passed_at, last_seen_at, pass_count,
          merged_pass_at, merged_pass_known)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '30 days', NOW() - INTERVAL '1 day', NOW(), 12,
               NOW() - INTERVAL '30 days', TRUE)
       ON CONFLICT (app_id, check_key) DO NOTHING`,
      [appId, key(r.name, r.path), r.name, r.path]
    );
  }
  for (const r of advisoryFailures) {
    await pool.query(
      `INSERT INTO app_check_history
         (app_id, check_key, check_name, check_path, last_failed_at, last_seen_at, fail_count, merged_pass_known)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 day', NOW(), 5, TRUE)
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
          WHERE id = $1 AND NOT wf_holds('preview', 'session:' || id)`,
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
// stuck "up for voting" forever. Every release's boot now asks each app's
// merge queue (the merge-queue workflow machine, platform.adoptMergeQueues),
// which re-reads every open proposal and merges the eligible ones. These fixtures make that scenario visible in the Dev vote
// panel without live voting:
//
//   1. An OVER-THRESHOLD promoted proposal (more yes votes than the active-
//      user majority, clean/no-conflict, no merged_at) — "approved while the
//      platform was down". This is what the boot sweep would merge.
//   2. A BELOW-THRESHOLD promoted proposal (no yes votes) — must be left
//      untouched by the sweep (the #380 "no pre-emptive resolution" bar).
//   3. A row stuck in 'merging' with no real GitHub merge (crash mid-merge).
//      The proposal machine adopts it as a claim an older release made and,
//      once the claim is old, asks GitHub what happened: not merged puts it
//      back up for its vote. A staging preview has no GitHub credentials, so
//      there it stays merging and the ask is retried (as the old boot sweep
//      also left it); the row shows the state a person would see meanwhile.
//
// All three use fake high pr_numbers and obviously-fake "[staging fixture]"
// titles, keyed off their unique branch names for idempotency. The 'merging'
// row is reset to 'merging' on each seed run while the machine does not hold
// it yet. A strict no-op outside staging.
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
      // Keep the 'merging' fixture pinned to 'merging' on each boot while the
      // proposal machine does not hold it; leave the promoted fixtures as-is
      // (a real merge during testing should stick).
      if (status === 'merging') {
        await pool.query(
          `UPDATE chat_sessions SET status = 'merging'
            WHERE id = $1 AND status <> 'merged' AND NOT wf_holds('proposal', 'session:' || id)`,
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

  // 3. Crash-mid-merge row: stuck in 'merging' with a fake PR, adopted by the
  //    proposal machine as an older release's claim (see above).
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

// #6563's shots: an approved, tested change whose merge GitHub is holding
// while its own required checks finish. It is what puts the Merging card
// under Votes and Tested on the change's page. A fresh staging copy never
// meets it, because it comes from GitHub refusing a merge the platform asked
// for, so the records that refusal writes are seeded here in the shape the
// machine keeps them: the session's `github_checks` hold reason and its
// instance's `refused` record with the last try, the next one and when the
// wait began. Obviously fake (a "[staging fixture]" title and a made-up pull
// request), idempotent, and strictly a no-op outside staging. Its session id
// is apart from every other fixture's and in a range no real session can
// reach.
// The admin limits area's shots (services/platform-limits-view.js,
// frontend/src/features/notifications/platform-limits.tsx): a fresh staging
// copy carries production's credit state, which is usually well above the
// warning line, so the area would have nothing to show. This writes a sample
// read, as the credit sweep stores one (openrouter-credit.js): the account's
// credit at $184, going down about $92 a day over two days of readings, and
// the bot's key with $152 left of an $800 week, so $648 used. The area then
// shows both rows: the account's credit under its $200 line, and Homeroom
// bot's weekly budget at 81%. Staging only. A preview has no OpenRouter key
// and no management key, so its own credit sweep has nothing to ask and
// leaves this standing. A read goes stale after 45 minutes (the area then
// says it could not check), and a preview outlives that, so the sample read
// is dated twelve hours ahead: it stays "just read" for the preview's life.
// The readings behind the days estimate stay in the past, where a rate is
// measured. Warnings are never sent from staging (openrouter-credit.js and
// platform-limit-alerts.js isStaging), so no admin is told.
const STAGING_SAMPLE_READ_AHEAD_MS = 12 * 60 * 60 * 1000;

async function seedStagingPlatformLimit(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const now = Date.now();
  const at = new Date(now + STAGING_SAMPLE_READ_AHEAD_MS).toISOString();
  const state = {
    accountCents: 18400,
    keyCents: 15200,
    keyLimitCents: 80000,
    keyReset: 'weekly',
    management: true,
    creditCents: 18400,
    creditAt: at,
    creditSource: 'account',
    spendableCents: 15200,
    at,
    armed: { low: false, urgent: false },
    outage: null,
    readings: [48, 36, 24, 12, 0].map((hours) => ({
      at: new Date(now - hours * 60 * 60 * 1000).toISOString(),
      cents: 18400 + Math.round((hours * 9200) / 24),
    })),
    stagingFixture: 'platform limits area',
  };
  try {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ('homeroom_bot_credit_state', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(state)],
    );
    // The weekly budget's row is built from its limit's stored level, which
    // its sweep writes every five minutes: measured once here, by that same
    // code, so the row is there before the first sweep.
    await require('../services/platform-limit-alerts').evaluate(pool, {}, 'bot_budget', { staging: true, limitsChanged: () => {} });
    log.info('db', 'Staging platform-limit fixture seeded', { creditCents: state.creditCents, keyCents: state.keyCents });
  } catch (err) {
    log.warn('db', 'Staging platform-limit fixture failed', { err: err.message });
  }
}

async function seedStagingGithubChecksHold(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const SESSION_ID = 999_999_991;
  const BRANCH = 'staging-fixture/github-checks-hold';
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const app = (await tx.query(
      'SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1'
    )).rows[0];
    if (!app) {
      await tx.query('ROLLBACK');
      log.warn('db', 'Staging GitHub-checks-hold fixture skipped: self-app row missing');
      return seedSkipped('no self-hosted project');
    }
    const appId = app.id;
    await tx.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE`,
    );
    const botId = (await tx.query(
      "SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE LIMIT 1",
    )).rows[0]?.id;
    if (!botId) {
      await tx.query('ROLLBACK');
      return seedSkipped('no Homeroom bot user');
    }
    // Read before the session insert, so an id another fixture owns is left
    // alone rather than read as this one.
    const taken = (await tx.query('SELECT branch_name FROM chat_sessions WHERE id = $1', [SESSION_ID])).rows[0];
    if (taken && taken.branch_name !== BRANCH) {
      await tx.query('ROLLBACK');
      log.warn('db', 'Staging GitHub-checks-hold fixture id is taken', { sessionId: SESSION_ID });
      return;
    }
    const prNumber = 900099;
    const title = '[staging fixture] A change waiting on GitHub to merge it';
    // Not a 40-character hex sha on purpose: the preview machine builds every
    // promoted change with a real head, and this fixture has no branch to
    // build. Every read that compares it to the row compares the same string.
    const head = 'staging-fixture-head';
    if (!taken) {
      await tx.query(
        `INSERT INTO chat_sessions
           (id, app_id, user_id, branch_name, session_title, pr_title, pr_number, pr_url,
            status, promoted_at, reviewed_head_sha, check_state, check_phase,
            checks_commit_sha, checks_checked_at, test_results,
            integration_head_sha, integration_main_sha, integration_merges_clean,
            merge_conflict_state, behind_main, votes_required, approval_epoch,
            pr_summary_md, created_at, last_activity_at)
         VALUES
           ($1::int, $2::int, $3::int, $4::text, $5::text, $5::text, $6::int,
            'https://github.com/example/example/pull/' || $6::int,
            'promoted', NOW() - INTERVAL '2 hours', $7::text, 'passing', 'done',
            $7::text, NOW() - INTERVAL '2 minutes', '[]'::jsonb,
            $7::text, $7::text, TRUE, 'clean', 0, 1, 0,
            'Staging demo: obviously fake. Homeroom built it, its checks passed, and GitHub is still running its own required checks before it merges.',
            NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 minutes')`,
        [SESSION_ID, appId, botId, BRANCH, title, prNumber, head],
      );
    } else {
      // Keep the fixture in the state it is for on every boot where neither
      // workflow machine holds the row yet: once the proposal machine holds
      // it, its status and promotion are the machine's to move, and once the
      // preview machine holds it, the checks' verdict is its own. A seed that
      // wrote either would be a second writer of a column only src/workflow/
      // may write. The instance's own record below still resets the wait, so
      // the times keep counting on a copy that has been up a while.
      await tx.query(
        `UPDATE chat_sessions
            SET status = 'promoted', pr_number = $2, pr_title = $3, pr_url = $4,
                reviewed_head_sha = $5, check_state = 'passing', check_phase = 'done',
                checks_commit_sha = $5, checks_checked_at = NOW() - INTERVAL '2 minutes',
                integration_head_sha = $5, integration_main_sha = $5,
                integration_merges_clean = TRUE, merge_conflict_state = 'clean', behind_main = 0,
                integration_block_reasons = '["github_checks"]'::jsonb,
                votes_required = 1, promoted_at = NOW() - INTERVAL '2 hours',
                last_activity_at = NOW() - INTERVAL '2 minutes'
          WHERE id = $1
            AND NOT wf_holds('proposal', 'session:' || id)
            AND NOT wf_holds('preview', 'session:' || id)`,
        [SESSION_ID, prNumber, title, `https://github.com/example/example/pull/${prNumber}`, head],
      );
    }
    await tx.query(
      `UPDATE chat_sessions
          SET integration_block_reasons = '["github_checks"]'::jsonb
        WHERE id = $1`,
      [SESSION_ID],
    );
    // The yeses an approved change has: other members, never the bot itself.
    await tx.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch, created_at)
       SELECT $1::int, u.id, 'yes', 0, NOW() - INTERVAL '1 hour'
         FROM (SELECT id FROM users
                WHERE is_synthetic = FALSE AND COALESCE(admin_readonly, FALSE) = FALSE
                ORDER BY is_admin DESC, id ASC LIMIT 3) u
       ON CONFLICT (session_id, user_id) DO NOTHING`,
      [SESSION_ID],
    );
    // The refusal the proposal machine wrote when GitHub held the merge: its
    // instance carries the times the card counts, and is what the merge queue
    // reads to know it may not ask again until `retryAt`. Ten minutes keeps
    // it held while the shots are taken, and the queue tries again after.
    await tx.query("SELECT set_config('app.wf_writer', 'transition', true)");
    await tx.query(
      `INSERT INTO wf_instances (machine, key, app_id, state, data, version, machine_version)
       VALUES ('proposal', $1::text, $2::int, 'in_review', jsonb_build_object(
                 'sessionId', $3::int, 'appId', $2::int, 'imported', false,
                 'slot', 'none', 'n', 1, 'attempt', NULL, 'sync', NULL,
                 'claim', jsonb_build_object('n', 1, 'at', NOW() - INTERVAL '3 minutes'),
                 'refused', jsonb_build_object(
                   'head', NULL, 'main', NULL, 'kind', 'blocked', 'checks', 'pending',
                   'at', NOW() - INTERVAL '2 minutes',
                   'retryAt', NOW() + INTERVAL '10 minutes',
                   'since', NOW() - INTERVAL '2 minutes')), 0, 6)
       ON CONFLICT (machine, key) DO UPDATE
         SET state = EXCLUDED.state, data = EXCLUDED.data,
             version = wf_instances.version + 1, machine_version = EXCLUDED.machine_version,
             updated_at = NOW()`,
      [`session:${SESSION_ID}`, appId, SESSION_ID],
    );
    await tx.query('COMMIT');
    log.info('db', 'Staging GitHub-checks-hold fixture seeded', { appId, sessionId: SESSION_ID, prNumber });
  } catch (err) {
    await tx.query('ROLLBACK');
    log.warn('db', 'Staging GitHub-checks-hold seeding failed', { message: err.message });
  } finally {
    tx.release();
  }
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

// #5007: a change built for a request points its reply thread at that
// request — "Conversation lives on #N" where "No replies yet" used to be,
// #5165: the grouped-gutter fix shows only where ONE author posted two
// messages in a row, and every thread fixture above hands each turn to a
// different voice so every row draws a header. Two consecutive follow-on
// messages from staging-demo-user at the tail of the mock issue's thread,
// inside the seven-minute window so the second groups under the first and
// its text lines up with the first message's. Idempotent on content, like
// seedStagingTopicScrollThreads; strictly a no-op outside staging.
async function seedStagingGroupedFollowOns(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) return;

  const { rows: demoRows } = await pool.query(
    'SELECT id FROM users WHERE username = $1', ['staging-demo-user']
  );
  const authorId = demoRows[0]?.id;
  if (!authorId) return;

  const bodies = [
    '[Staging demo] grouped follow-on #1: The narrow-phone layout is the part I would keep as it is.',
    '[Staging demo] grouped follow-on #2: And the dark-mode contrast holds up on my screen too.',
  ];
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
     SELECT $1::int, $2::int, m.content, 'message', 'issue', 900001::int,
            NOW() - (m.minutes_ago * INTERVAL '1 minute')
       FROM jsonb_to_recordset($3::jsonb) AS m(content text, minutes_ago float8)
      WHERE NOT EXISTS (
        SELECT 1 FROM chat_messages existing
         WHERE existing.app_id = $1 AND existing.content = m.content
      )`,
    [appId, authorId, JSON.stringify(bodies.map((content, i) => ({ content, minutes_ago: bodies.length - i - 0.5 })))]
  );
  log.info('db', 'Staging grouped follow-on messages seeded', { appId, threadRef: 900001 });
}

// "More of the conversation is on #N" above the count, and the closed
// notes say the conversation is on the request. Every session fixture
// above has linked_issues = {}, so a fresh staging copy has no state that
// shows any of it. Two changes owned by usernode-capture (the signed-in
// capture identity), both built for mock issue #900001 — the one the
// mock-issues fallback in routes/issues.js always serves in staging: one
// unshared, for the closed notes and the pointer row, and one shared with
// a single stored reply, for the "More of the conversation" line above the
// count. Idempotent on branch_name; the reply on (thread_type, thread_ref,
// content).
async function seedStagingChangeBuiltForRequest(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging change-built-for-request fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: captureRows } = await pool.query(
    'SELECT id FROM users WHERE username = $1',
    ['usernode-capture']
  );
  const ownerId = captureRows[0]?.id;
  if (!ownerId) {
    log.warn('db', 'Staging change-built-for-request fixture skipped: capture user missing');
    return;
  }

  // The stored reply's author: anyone but the owner, so the thread reads
  // as a back-and-forth. Falls back to the owner when staging has one user.
  const { rows: otherRows } = await pool.query(
    'SELECT id FROM users WHERE id <> $1 ORDER BY is_admin DESC, id ASC LIMIT 1',
    [ownerId]
  );
  const replyAuthorId = otherRows[0]?.id || ownerId;

  const seedSession = async (branch, title, sharedMinutesAgo, createdMinutesAgo) => {
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch]
    );
    if (existing.length) return existing[0].id;
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_title, status, linked_issues, shared_at, created_at)
       VALUES
         ($1, $2, $3, $4, 'active', ARRAY[900001]::int[], $5,
          NOW() - ($6 * INTERVAL '1 minute'))
       RETURNING id`,
      [appId, ownerId, branch, title,
        sharedMinutesAgo == null ? null : new Date(Date.now() - sharedMinutesAgo * 60000),
        createdMinutesAgo]
    );
    return rows[0].id;
  };

  const unsharedId = await seedSession('staging-fixture/change-built-for-request',
    '[staging fixture] Change built for a request — only you can see it', null, 20);
  const sharedId = await seedSession('staging-fixture/change-built-for-request-shared',
    '[staging fixture] Change built for a request — shared, one reply', 10, 30);

  const reply = '[staging fixture] This covers what the request asked for — replying here from now on.';
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
     SELECT $1, $2, $3, 'message', 'session', $4, NOW() - INTERVAL '8 minutes'
      WHERE NOT EXISTS (
        SELECT 1 FROM chat_messages existing
         WHERE existing.app_id = $1 AND existing.thread_type = 'session'
           AND existing.thread_ref = $4 AND existing.content = $3
      )`,
    [appId, replyAuthorId, reply, sharedId]
  );

  log.info('db', 'Staging change-built-for-request fixtures seeded', {
    appId, unsharedId, sharedId,
  });
}

// #6224: a change for several requests is drawn on its first request's page,
// and says there which others it closes. Every session fixture has at most
// one linked issue, so a fresh staging copy has no state that shows that
// line. One promoted change owned by usernode-capture, built for mock issue
// #900001 (the one the mock-issues fallback always serves in staging) and
// linked to nine more mock issues, so the line, its links and its fold have
// something real to draw. Idempotent on branch_name.
async function seedStagingChangeAlsoCloses(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging change-also-closes fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: captureRows } = await pool.query(
    'SELECT id FROM users WHERE username = $1',
    ['usernode-capture']
  );
  const ownerId = captureRows[0]?.id;
  if (!ownerId) {
    log.warn('db', 'Staging change-also-closes fixture skipped: capture user missing');
    return;
  }

  const branch = 'staging-fixture/change-also-closes';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (existing.length) return;

  const { rows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, pr_number, status, linked_issues,
        shared_at, approval_epoch, created_at)
     VALUES
       ($1, $2, $3, $4, 96231, 'promoted', $5::int[], NOW(), 1,
        NOW() - INTERVAL '5 minutes')
     RETURNING id`,
    [appId, ownerId, branch, '[staging fixture] Ten small fixes for the request pages',
      [900001, 900002, 900003, 900004, 900005, 900006, 900007, 900008, 900009, 900010]]
  );
  log.info('db', 'Staging change-also-closes fixture seeded', { appId, id: rows[0]?.id });
}

// #313/#321/#827: a PROMOTED proposal owned by a user OTHER than the
// tester, so the card-level "✨ Ask Homeroom bot" pill (rendered only on
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
  // the Ask Homeroom bot pill.
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
          '[staging fixture] Another user''s proposal — ask Homeroom bot about it',
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
//     /api/apps/:slug/sessions reports `warm: false`: the
//     proposer-owned, cold promoted state the proposal card shows an
//     Archive button for on the Dev feed.
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

  // #6100: the shots' own member (usernode-capture) made a change the vote
  // set aside, so a fresh staging copy can show why a change was closed, on
  // its page and in its author's bell. Obviously fake and written only here:
  // the row is the state a real close leaves (the proposal machine did not
  // run). Idempotent on the branch name.
  const whyBranch = 'staging-fixture/change-closed-reason';
  const { rows: [member] } = await pool.query(
    "SELECT id FROM users WHERE username = 'usernode-capture'"
  );
  if (member) {
    const { rows: [whyClosed] } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, status, close_reason,
          created_at, promoted_at, archived_at)
       SELECT $1::int, $2::int, $3::varchar, 9302,
              '[Mock] Closed change, with why it closed',
              'archived', 'auto-rejected',
              NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE app_id = $1 AND branch_name = $3)
       RETURNING id`,
      [appId, member.id, whyBranch]
    );
    if (whyClosed) {
      await pool.query(
        `INSERT INTO notifications (user_id, app_id, session_id, kind, detail)
         VALUES ($1, $2, $3, 'change_closed', 'event:staging-fixture')`,
        [member.id, appId, whyClosed.id]
      );
    }
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
// only thing seeded. The boot reference seed restores the seven default
// `topochain_*` platform_settings before these fixtures run; schema replay
// is not required, and operator-set values remain untouched.
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
    const realHash = await bcrypt.hash('staging-demo-topochain-password', STAGING_FIXTURE_BCRYPT_COST);
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

    // ─── The one GRADED activity (#3200) ────────────────────────────────
    // A graded activity shows the grader's reason in the standings
    // drill-down (metadata.grade, drawn as a "Why:" line under the label),
    // and every point row above is ungraded — so the state no preview could
    // reach is one this row reaches at boot. It sits on the season event's
    // share challenge (900507) because the standings demo state
    // (shots-demo-states.js, shots-demo-standings-activities-v1) writes its
    // players' rows on the other two (900505, 900506) unconditionally: a
    // seeded row there would come out twice in the same drill-down. The
    // demo states run from the deployed build, which does not know a new
    // state until it merges — the seed is what carries the state across
    // that gap.
    //
    // The grade is the fixture's own content (the same shape
    // shots-demo-standings-graded-v1 writes: score, reason, model), not a
    // signal any code reads to decide something — the reason is the
    // sentence the change's declaration shows the group, so the shot reads
    // the way the change was described. Points track the challenge's own
    // reward, as every row above does.
    await pool.query(
      `INSERT INTO user_activities
         (id, user_id, season_event_id, activity_type, points, description,
          metadata, activity_at, source, challenge_id)
       SELECT 900704, u.id, c.season_event_id, COALESCE(ct.category, 'activity'), 50,
              '[shots fixture] Shared the season announcement.', $1::jsonb,
              NOW() - INTERVAL '40 minutes', 'api', c.id
         FROM users u
         JOIN challenges c ON c.id = 900507 AND c.season_event_id = 900501
         LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
        WHERE u.username = 'staging-demo-topochain-participant-6'
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify({
        fixture: 'shots-demo',
        grade: {
          score: 50,
          reason: 'Says what broke, where, and what was expected. Easy to act on.',
          model: 'fixture',
        },
      })]
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
    //
    // Every PUBLISHED version, not just the demo one above: the real
    // versions come across with the clone (terms_versions is public) and
    // seedTermsVersions adds new ones, and whichever is newest is the
    // current one the shell checks (#6043).
    await pool.query(
      `INSERT INTO user_terms_consents
         (user_id, terms_version_id, status, responded_at, created_at, updated_at)
       SELECT u.id, tv.id, 'accepted', NOW() - INTERVAL '7 days', NOW(), NOW()
         FROM users u
        CROSS JOIN terms_versions tv
        WHERE tv.published_at IS NOT NULL
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

    // 900507: a PHONE row (#4223), the eighth thing the screen renders
    // differently. Joined from Home's card with a verified phone, so it has
    // no email, is linked to its account and confirmed at once. The screen
    // shows it by account ("@username", "Phone") with Admit disabled and
    // "Needs SMS (#4096)", since nothing can tell it that it is in yet.
    await pool.query(
      `INSERT INTO waitlist_signups
         (id, email, submitted_at, linked_user_id, confirmed_at, more_token)
       VALUES (900507, NULL, NOW() - INTERVAL '5 days', $1, NOW() - INTERVAL '5 days', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [USERS.bpPending]
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
      // Ids base+2…base+14 all sit inside the viewer's 20-wide block.
      //
      // base+14 is a partner-style credit saved at exactly midnight UTC with
      // no time-of-day mark, from an `api` source — the state the activity
      // drill-down used to print as "12:00 AM". The day-only backfill marks
      // it, so the list shows the date alone. It is the row the change's
      // before/after shots point at; every other row here carries a real
      // time (or no precision at all, from the default source).
      await pool.query(
        `INSERT INTO user_activities
           (id, user_id, season_event_id, activity_type, points, description,
            metadata, activity_at, challenge_id, source)
         VALUES
           (${base},     $1, $2, 'challenge_completion', 250, 'Reported a reproducible bug.',
            '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '4 days', 900500, DEFAULT),
           (${base + 1}, $1, $2, 'challenge_completion', 100, 'Sent a testnet transaction.',
            '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '3 days', 900501, DEFAULT),
           (${base + 2}, $1, $2, 'challenge_completion', 50, 'Shared the season announcement.',
            '{"kind": "challenge_completion"}'::jsonb, NOW() - INTERVAL '2 days', 900511, DEFAULT),
           (${base + 6}, $1, $2, 'COMMUNITY', 250, 'Gave kudos to a builder (1 of 5).',
            '{"kind": "kudos_given"}'::jsonb, NOW() - INTERVAL '30 hours', 900513, DEFAULT),
           (${base + 7}, $1, $2, 'COMMUNITY', 250, 'Gave kudos to a builder (2 of 5).',
            '{"kind": "kudos_given"}'::jsonb, NOW() - INTERVAL '20 hours', 900513, DEFAULT),
           (${base + 8}, $1, $2, 'COMMUNITY', 250, 'Gave kudos to a builder (3 of 5).',
            '{"kind": "kudos_given"}'::jsonb, NOW() - INTERVAL '10 hours', 900513, DEFAULT),
           (${base + 3}, $1, $2, 'COMMUNITY', 200, 'Tested a demo dApp (1 of 8).',
            '{"kind": "app_tested"}'::jsonb, NOW() - INTERVAL '2 days', 900512, DEFAULT),
           (${base + 4}, $1, $2, 'COMMUNITY', 200, 'Tested a demo dApp (2 of 8).',
            '{"kind": "app_tested"}'::jsonb, NOW() - INTERVAL '1 days', 900512, DEFAULT),
           (${base + 5}, $1, $2, 'COMMUNITY', 200, 'Tested a demo dApp (3 of 8).',
            '{"kind": "app_tested"}'::jsonb, NOW() - INTERVAL '6 hours', 900512, DEFAULT),
           (${base + 9},  $1, $2, 'COMMUNITY', 180, 'Voted on a proposal (1 of 5).',
            '{"kind": "vote_cast"}'::jsonb, NOW() - INTERVAL '4 days', 900514, DEFAULT),
           (${base + 10}, $1, $2, 'COMMUNITY', 180, 'Voted on a proposal (2 of 5).',
            '{"kind": "vote_cast"}'::jsonb, NOW() - INTERVAL '3 days', 900514, DEFAULT),
           (${base + 11}, $1, $2, 'COMMUNITY', 180, 'Voted on a proposal (3 of 5).',
            '{"kind": "vote_cast"}'::jsonb, NOW() - INTERVAL '2 days', 900514, DEFAULT),
           (${base + 12}, $1, $2, 'COMMUNITY', 180, 'Voted on a proposal (4 of 5).',
            '{"kind": "vote_cast"}'::jsonb, NOW() - INTERVAL '28 hours', 900514, DEFAULT),
           (${base + 13}, $1, $2, 'COMMUNITY', 180, 'Voted on a proposal (5 of 5).',
            '{"kind": "vote_cast"}'::jsonb, NOW() - INTERVAL '5 hours', 900514, DEFAULT),
           (${base + 14}, $1, $2, 'partner_challenge', 100, 'Completed a partner challenge (staging demo).',
            '{"kind": "partner_challenge"}'::jsonb,
            (date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - INTERVAL '2 days',
            900500, 'api')
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

// #3650: the challenge page's "Your invites" list needs state no other
// fixture makes — an open invite challenge a member can open on the DEFAULT
// event (the season's), a scoring rule on INVITES_JOINED (without one the
// challenge is never scored and the list does not draw at all), and the
// invite records behind each status word, all belonging to the capture
// viewer (usernode-capture), the member the shots sign as.
//
// DATA ONLY, NO SIGNAL (same rule as seedStagingFirstChallenges below): the
// ledger rows here are the fixture for the "Counted" word itself — the list
// reads the ledger for what is paid — so they are the visible state, not a
// signal the code decides on. The scorer never touches these rows; the
// fixture people are never-login accounts, like every staging demo person.
//
// Its own failure domain, so a clone missing the viewer or the invite
// challenge skips only this. Fixed ids at 900730 (the challenge) and
// 900900-900910 (rule and ledger, clear of the snapshots at 900600-900611
// and the archive activities at 900700-900703), and ON CONFLICT DO NOTHING
// throughout, so a reboot changes nothing.
async function seedStagingInviteChallengeStatuses(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    // The invite challenge itself, open on the season-type event (the one a
    // signed-in member lands on). Seeded, not 900504: that one's `completed`
    // stands (its Done card is another fixture's state), and a closed
    // challenge is never scored — no rule would speak for it. A schedule of
    // its own, not the event's: the season event's window is refreshed to
    // "now" on every boot, which would put every seeded join outside it.
    await pool.query(
      `INSERT INTO challenges
         (id, season_event_id, challenge_template_id, schedule_start,
          schedule_end, enabled, display_order, completed, created_at, updated_at)
       VALUES (900730, 900501, 900503, NOW() - INTERVAL '45 days',
               NOW() + INTERVAL '45 days', TRUE, 5, FALSE, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`
    );
    // The rule it is scored by: three joined people, 250 points each, on the
    // event's running window (no schedule of its own). The invite status
    // reader resolves the same rule row. It also carries the scheduled
    // count's times (#6895), which is what a challenge's page reads to say
    // when progress was last counted and when the next count is due: an
    // interval of ten minutes and a count four minutes ago, so a fresh
    // preview shows the line without waiting for the scorer's first beat.
    // The timestamps are filled only when absent, so a reboot (or a real
    // pass) never rewinds them.
    await pool.query(
      `INSERT INTO challenge_scoring_rules
         (id, name, measure, challenge_template_id, challenge_id, target,
          points, interval_minutes, last_scored_at, enabled, notes, created_at, updated_at)
       VALUES (900900, 'Staging demo: invite three participants',
               'INVITES_JOINED', NULL, 900730, 3, 250, 10,
               NOW() - INTERVAL '4 minutes', TRUE,
               'Staging demo: backs the invite challenge''s per-person list.',
               NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         challenge_id = EXCLUDED.challenge_id, measure = EXCLUDED.measure,
         target = EXCLUDED.target, points = EXCLUDED.points, enabled = TRUE,
         interval_minutes = COALESCE(challenge_scoring_rules.interval_minutes, EXCLUDED.interval_minutes),
         last_scored_at = COALESCE(challenge_scoring_rules.last_scored_at, EXCLUDED.last_scored_at)`
    );
    const { rows: viewerRows } = await pool.query(
      "SELECT id FROM users WHERE username = 'usernode-capture'");
    if (!viewerRows.length) return;
    const VIEWER = viewerRows[0].id;
    const { rows: appRows } = await pool.query(
      'SELECT id, community_id FROM apps WHERE id = 1 AND community_id IS NOT NULL');
    if (!appRows.length) return;
    const APP = appRows[0].id;
    const COMMUNITY = appRows[0].community_id;

    // Seven fixture people, one per status word the list shows. The names
    // carry the demo mark.
    await pool.query(
      `INSERT INTO users (username, password, is_admin, is_synthetic)
       VALUES
         ('staging-demo-invitee-counted', 'staging-demo-not-a-login', FALSE, FALSE),
         ('staging-demo-invitee-soon',    'staging-demo-not-a-login', FALSE, FALSE),
         ('staging-demo-invitee-waiting', 'staging-demo-not-a-login', FALSE, FALSE),
         ('staging-demo-invitee-gone',    'staging-demo-not-a-login', FALSE, FALSE),
         ('staging-demo-invitee-other',   'staging-demo-not-a-login', FALSE, FALSE),
         ('staging-demo-invitee-early',   'staging-demo-not-a-login', FALSE, FALSE),
         ('staging-demo-invitee-notalk',  'staging-demo-not-a-login', FALSE, FALSE)
       ON CONFLICT (username) DO NOTHING`
    );
    const { rows: people } = await pool.query(
      "SELECT id, username FROM users WHERE username LIKE 'staging-demo-invitee-%'");
    const byName = new Map(people.map((p) => [p.username, p.id]));
    const counted = byName.get('staging-demo-invitee-counted');
    const soon = byName.get('staging-demo-invitee-soon');
    const waiting = byName.get('staging-demo-invitee-waiting');
    const gone = byName.get('staging-demo-invitee-gone');
    const other = byName.get('staging-demo-invitee-other');
    const early = byName.get('staging-demo-invitee-early');
    const notalk = byName.get('staging-demo-invitee-notalk');

    // The viewer's links: the live one (joined and queued people hang off
    // it) and a turned-off one. The other inviter is the fixture admin.
    await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, uses, created_at)
       VALUES
         ('stagingdemoinvitemain01', $1, $2, $3, 3, NOW() - INTERVAL '3 days'),
         ('stagingdemoinvitegone01', $1, $2, $3, 1, NOW() - INTERVAL '10 days')
       ON CONFLICT (token) DO NOTHING`,
      [COMMUNITY, APP, VIEWER]
    );
    const { rows: linkRows } = await pool.query(
      `SELECT token, id FROM community_invites
        WHERE token IN ('stagingdemoinvitemain01', 'stagingdemoinvitegone01')`);
    const links = new Map(linkRows.map((l) => [l.token, l.id]));
    const MAIN = links.get('stagingdemoinvitemain01');
    const GONE = links.get('stagingdemoinvitegone01');
    if (!MAIN || !GONE) return;
    await pool.query(
      `UPDATE community_invites SET revoked_at = NOW() - INTERVAL '1 day'
         WHERE token = 'stagingdemoinvitegone01' AND revoked_at IS NULL`);

    // Whoever invited first: each person counts once, for the FIRST invite
    // they took. The "someone else's invite" person joined through the
    // admin's link a day before they followed the viewer's.
    const { rows: inviterRows } = await pool.query(
      "SELECT id FROM users WHERE is_admin ORDER BY id ASC LIMIT 1");
    const ADMIN = inviterRows.length ? inviterRows[0].id : null;
    if (ADMIN && ADMIN !== VIEWER) {
      await pool.query(
        `INSERT INTO community_invites (token, community_id, app_id, created_by, uses, created_at)
         VALUES ('stagingdemoinviteadmin1', $1, $2, $3, 1, NOW() - INTERVAL '9 days')
         ON CONFLICT (token) DO NOTHING`,
        [COMMUNITY, APP, ADMIN]
      );
      await pool.query(
        `INSERT INTO community_invite_redemptions (invite_id, user_id, status, created_at, applied_at)
         SELECT id, $1, 'joined', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'
           FROM community_invites WHERE token = 'stagingdemoinviteadmin1'
         ON CONFLICT (invite_id, user_id) DO NOTHING`,
        [other]
      );
      // The point went to whoever invited first, as the scorer would pay it.
      await pool.query(
        `INSERT INTO user_activities
           (id, user_id, season_event_id, activity_type, points, description,
            metadata, activity_at, source, challenge_id, created_at, updated_at)
         VALUES (900902, $1, 900501, 'growth', 250, $2,
                 $3::jsonb, NOW() - INTERVAL '2 days', 'challenge_scorer', 900730, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           user_id = EXCLUDED.user_id, season_event_id = EXCLUDED.season_event_id,
           activity_type = EXCLUDED.activity_type, points = EXCLUDED.points,
           description = EXCLUDED.description, metadata = EXCLUDED.metadata,
           activity_at = EXCLUDED.activity_at, source = EXCLUDED.source,
           challenge_id = EXCLUDED.challenge_id`,
        [ADMIN, '@staging-demo-invitee-other joined by your invite',
         JSON.stringify({ source_key: `invitee:${other}`, rule_id: 900900, measure: 'INVITES_JOINED', timestamp_precision: 'instant' })]
      );
    }

    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, created_at, applied_at)
       VALUES
         -- Counted: joined three days ago... the ledger row below pays it.
         ($1, $2, 'joined', NOW() - INTERVAL '3 days', NOW() - INTERVAL '30 hours'),
         -- Counts soon: joined through the viewer's link, not yet on the pass.
         ($1, $3, 'joined', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '4 hours'),
         -- Waiting: followed the link, queued for admission, the maker can
         -- still grant it.
         ($1, $4, 'queued', NOW() - INTERVAL '2 hours', NULL),
         -- Won't join: followed the turned-off link.
         ($5, $6, 'queued', NOW() - INTERVAL '2 days', NULL),
         -- Not counted (someone else's invite): joined through the viewer's
         -- link too, but somebody else's came first.
         ($1, $7, 'joined', NOW() - INTERVAL '1 day', NOW() - INTERVAL '20 hours'),
         -- Not counted (outside the challenge's dates): joined before the
         -- event's window opened.
         ($1, $8, 'joined', NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days')
       ON CONFLICT (invite_id, user_id) DO NOTHING`,
      [MAIN, counted, soon, waiting, GONE, gone, other, early]
    );

    // The not-accepted one: the viewer's collaborator invite, unanswered.
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, created_at)
       VALUES ($1, $2, 'invited', $3, NOW() - INTERVAL '6 hours')
       ON CONFLICT (app_id, user_id) DO NOTHING`,
      [APP, notalk, VIEWER]
    );

    // The Counted person's paid row, exactly as the scorer writes it
    // (writeCredits): the viewer's, on the invitee's key.
    const { rows: ruleRows } = await pool.query(
      'SELECT id FROM challenge_scoring_rules WHERE id = 900900');
    if (!ruleRows.length) return;
    await pool.query(
      `INSERT INTO user_activities
         (id, user_id, season_event_id, activity_type, points, description,
          metadata, activity_at, source, challenge_id, created_at, updated_at)
       VALUES (900901, $1, 900501, 'growth', 250, $2,
               $3::jsonb, NOW() - INTERVAL '30 hours', 'challenge_scorer', 900730, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         user_id = EXCLUDED.user_id, season_event_id = EXCLUDED.season_event_id,
         activity_type = EXCLUDED.activity_type, points = EXCLUDED.points,
         description = EXCLUDED.description, metadata = EXCLUDED.metadata,
         activity_at = EXCLUDED.activity_at, source = EXCLUDED.source,
         challenge_id = EXCLUDED.challenge_id`,
      [VIEWER,
       '@staging-demo-invitee-counted joined by your invite',
       JSON.stringify({ source_key: `invitee:${counted}`, rule_id: 900900, measure: 'INVITES_JOINED', timestamp_precision: 'instant' })]
    );
  } catch (err) {
    log.warn('db', 'Invite-challenge status seeding failed', { message: err.message });
  }
}

// The staging season's First challenges (2026-10-01).
//
// The season's first four ONBOARDING challenges are its First challenges
// (src/services/topochain/challenge-onboarding.js), which Home's Challenges
// area lists first for an account that has not done them. (Until #4635 they
// were also a Getting started card on top of Home, and a gate over the rest
// of the season.) The fixture season above has no ONBOARDING challenge, so
// a preview had no First challenges to show.
// These four are the list evan sets up in production (join, try, vote,
// suggest), under obviously-staging names, on the fixture season's own
// season-type event (EVENT_SEASON_ID, whose window seedStagingTopochain keeps
// on "now") and with no schedule of their own, so they never close. The
// staging mark comes AFTER the action ("Try an app (staging demo)"), not
// before it as the fixture's other names have it: a card's title truncates
// on a phone, and four reading "Staging demo challenge …" were four nobody
// could tell apart.
//
// DATA ONLY, NO SIGNAL (platform conventions, "Seeded data must not
// fabricate a signal your logic reads"): no credits, for anybody, and no
// scoring rules, so nothing scores a cloned account on them behind its back.
// A reviewer who signs up in the preview ticks them by doing them, or an
// admin credits them from the console. The first three carry a
// call-to-action of their own; the fourth has none.
//
// Its own function rather than a block in seedStagingTopochain, whose seeded
// template and challenge counts its test pins; its own failure domain too, so
// a clone that lacks the fixture event skips only this. Fixed ids above every
// range the fixture uses (templates 900508-900511, challenges 900720-900723,
// clear of the viewer window at 900520-900579), and ON CONFLICT (id) DO
// NOTHING, so a reboot changes nothing.
async function seedStagingFirstChallenges(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const EVENT_SEASON_ID = 900501;
  try {
    await pool.query(
      `INSERT INTO challenge_templates
         (id, category, goal, task, reward, description, cta_label, cta_link, created_at, updated_at)
       VALUES
         (900508, 'ONBOARDING', 'Join a community (staging demo)',
          'Join any community that is not Homeroom.', '500 pts',
          'First challenge fixture (Getting started).', 'Find a community', '#apps', NOW(), NOW()),
         (900509, 'ONBOARDING', 'Try an app (staging demo)',
          'Open an app somebody else made and try it.', '500 pts',
          'First challenge fixture (Getting started).', 'Find an app', '#apps', NOW(), NOW()),
         (900510, 'ONBOARDING', 'Vote on an app (staging demo)',
          'Vote on a change somebody proposed.', '250 pts',
          'First challenge fixture (Getting started).', 'See what needs you', '#needs', NOW(), NOW()),
         (900511, 'ONBOARDING', 'Send feedback (staging demo)',
          'Tell a community what would make it better.', '250 pts',
          'First challenge fixture (Getting started).', NULL, NULL, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO challenges
         (id, season_event_id, challenge_template_id, enabled, display_order, completed,
          created_at, updated_at)
       VALUES
         (900720, $1, 900508, TRUE, 1, FALSE, NOW(), NOW()),
         (900721, $1, 900509, TRUE, 2, FALSE, NOW(), NOW()),
         (900722, $1, 900510, TRUE, 3, FALSE, NOW(), NOW()),
         (900723, $1, 900511, TRUE, 4, FALSE, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [EVENT_SEASON_ID]
    );
    log.info('db', 'Staging First challenges seeded', { event: EVENT_SEASON_ID });
  } catch (err) {
    log.warn('db', 'Staging First challenges seed skipped', { message: err.message });
  }
}

// A credit on a challenge's page that links to its change (#3247). No fresh
// copy has a credit with a merge behind it for the shots' member, so this seeds
// one: a weekly challenge nothing scores, a fake merged change on the self app,
// its merge event and one credit, 1/2 this week. The shots' member alone, so the
// declared checks' account keeps its Home order. Ids clear of the First
// challenges above; the credit's date moves with every boot, because a weekly
// count drops anything older than Monday.
async function seedStagingCountedCredit(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const EVENT_SEASON_ID = 900501;
  try {
    const [{ rows: people }, { rows: apps }] = await Promise.all([
      pool.query(`SELECT id FROM users WHERE username = 'usernode-capture'`),
      pool.query('SELECT id FROM apps WHERE slug = $1', [config.selfAppSlug]),
    ]);
    if (!people.length || !apps.length) return;
    const member = people[0].id;
    await pool.query(
      `INSERT INTO challenge_templates
         (id, category, goal, task, reward, description, metric_type, metric_target, metric_label,
          created_at, updated_at)
       VALUES (900512, 'WEEKLY', 'Get 2 proposals accepted (staging demo)',
               'Get two of your proposals accepted this week.', '500 pts each',
               'Weekly challenge fixture with one linked credit.', 'count', 2, 'Proposals accepted',
               NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO challenges
         (id, season_event_id, challenge_template_id, enabled, display_order, completed,
          created_at, updated_at)
       VALUES (900724, $1, 900512, TRUE, 5, FALSE, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [EVENT_SEASON_ID]
    );
    // The rule that scores it, so the page can say what counts (#6986) and
    // how often it is counted. Before this the fixture challenge had no rule
    // at all, so the card carried no `counted_by` and the page could not
    // state the proposal rule. Times filled only when absent, like the
    // invite challenge's rule above.
    await pool.query(
      `INSERT INTO challenge_scoring_rules
         (id, name, measure, challenge_template_id, challenge_id, target,
          points, interval_minutes, last_scored_at, enabled, notes, created_at, updated_at)
       VALUES (900901, 'Staging demo: get two proposals accepted',
               'PROPOSAL_ACCEPTED', NULL, 900724, 2, 500, 10,
               NOW() - INTERVAL '4 minutes', TRUE,
               'Staging demo: backs the accepted-proposal challenge''s count and note.',
               NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         challenge_id = EXCLUDED.challenge_id, measure = EXCLUDED.measure,
         target = EXCLUDED.target, points = EXCLUDED.points, enabled = TRUE,
         interval_minutes = COALESCE(challenge_scoring_rules.interval_minutes, EXCLUDED.interval_minutes),
         last_scored_at = COALESCE(challenge_scoring_rules.last_scored_at, EXCLUDED.last_scored_at)`
    );
    // The change is the Homeroom bot's, built from a request the capture
    // account filed — the exact shape #6986 was reported in, so the credit
    // reads "Your request went live on Homeroom" and resolving it to the
    // change goes through the request, not the session's author.
    const { rows: botRows } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic, display_name)
       VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
       ON CONFLICT (username) DO UPDATE SET is_synthetic = TRUE
       RETURNING id`
    );
    const fileNumber = 9043;
    // Two of them, so the page shows the counter off 0 the way the request
    // reported it (0 of 2, now 2 of 2) rather than a single credit.
    const builds = [
      { number: fileNumber, pr: 9043, title: '[Staging demo] Show the reason beside each challenge credit',
        branch: 'staging-fixture/counted-credit' },
      { number: fileNumber + 1, pr: 9044, title: '[Staging demo] Say what counts under the challenge',
        branch: 'staging-fixture/counted-credit-2' },
    ];
    for (const build of builds) {
      await pool.query(
        `INSERT INTO requests (app_id, number, title, body, state, created_by, source)
         VALUES ($1, $2, $3, 'Staging demo fixture for the accepted-proposal challenge.',
                 'closed', $4, 'homeroom')
         ON CONFLICT (app_id, number) DO NOTHING`,
        [apps[0].id, build.number, build.title, member]
      );
      const { rows: found } = await pool.query(
        'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
        [apps[0].id, build.branch]
      );
      const session = found[0] || (await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_title, session_title, status,
            linked_issues, created_from_issue_number, merged_at, live_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $5, 'merged',
                 ARRAY[$6]::int[], $6, NOW(), NOW(), NOW() - INTERVAL '1 day')
         RETURNING id`,
        [apps[0].id, botRows[0].id, build.branch, build.pr, build.title, build.number]
      )).rows[0];
      const { rows: merged } = await pool.query(
        `SELECT id FROM events WHERE session_id = $1 AND event_type = 'pr_merged' LIMIT 1`, [session.id]
      );
      const event = merged[0] || (await pool.query(
        `INSERT INTO events (user_id, app_id, session_id, event_type, created_at)
         VALUES ($1, $2, $3, 'pr_merged', NOW()) RETURNING id`,
        [botRows[0].id, apps[0].id, session.id]
      )).rows[0];
      await pool.query(
        `INSERT INTO user_activities
           (user_id, season_event_id, activity_type, points, description, metadata, activity_at,
            challenge_id, created_at, updated_at)
         VALUES ($1, $2, 'challenge_completion', 500, 'Your request went live on Homeroom', $3::jsonb, NOW(),
                 900724, NOW(), NOW())
         ON CONFLICT (challenge_id, user_id, (metadata->>'source_key'))
           WHERE metadata->>'source_key' IS NOT NULL
         DO UPDATE SET activity_at = NOW()`,
        [member, EVENT_SEASON_ID, JSON.stringify({ source_key: `merged:${event.id}`, via: 'request' })]
      );
    }
    // #7152: the challenge page's proposal list lists only changes that went
    // through a promote, as the scorer's own proposals did; the fixture's
    // sessions were merged directly, so give them the promote time they
    // never had. Their merged/live times move with the credit's own
    // activity_at above: the season event's window is refreshed to "now" on
    // every boot, and a fixture left behind it would drop out of the list.
    // Fixture rows only: a row the proposal or merge-followups machine holds
    // is the machine's, and this seed leaves it alone.
    await pool.query(
      `UPDATE chat_sessions
          SET promoted_at = COALESCE(promoted_at, merged_at, created_at),
              merged_at = NOW(), live_at = NOW()
        WHERE app_id = $1 AND branch_name LIKE 'staging-fixture/counted-credit%'
          AND NOT wf_holds('proposal', 'session:' || id)
          AND NOT wf_holds('merge-followups', 'session:' || id)`,
      [apps[0].id]
    );
    await pool.query(
      `UPDATE events e
          SET created_at = NOW()
         FROM chat_sessions cs
        WHERE cs.id = e.session_id AND e.event_type = 'pr_merged'
          AND cs.app_id = $1 AND cs.branch_name LIKE 'staging-fixture/counted-credit%'`,
      [apps[0].id]
    );
  } catch (err) {
    log.warn('db', 'Staging counted credit seed skipped', { message: err.message });
  }
}

// #7152: the itemized report list on the Send useful feedback challenge's
// page. A fresh staging copy has no USEFUL_FEEDBACK challenge at all (the
// seeded "Report a reproducible bug" one has no scoring rule), so the list
// could not draw. This seeds a weekly challenge with its rule and three
// reports for the shots' member (usernode-capture), one already paid by the
// ledger, one still grading, and one too short to act on.
//
// DATA ONLY, NO SIGNAL: the ledger row is the visible "Counted" state, not a
// signal the code reads to decide something. Fixed ids clear of the ranges
// the other challenge fixtures use, and idempotent throughout.
async function seedStagingChallengeItems(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  const EVENT_SEASON_ID = 900501;
  try {
    await pool.query(
      `INSERT INTO challenge_templates
         (id, category, goal, task, reward, description, illustration, created_at, updated_at)
       VALUES (900513, 'WEEKLY', 'Send useful feedback (staging demo)',
               'Send a report about Homeroom or a project somebody else made.',
               '250 pts a report', 'Weekly feedback challenge fixture for the itemized list.',
               'useful-feedback', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO challenges
         (id, season_event_id, challenge_template_id, schedule_start, schedule_end,
          enabled, display_order, completed, created_at, updated_at)
       VALUES (900731, $1, 900513, NOW() - INTERVAL '45 days', NOW() + INTERVAL '45 days',
               TRUE, 6, FALSE, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [EVENT_SEASON_ID]
    );
    await pool.query(
      `INSERT INTO challenge_scoring_rules
         (id, name, measure, challenge_template_id, challenge_id, target,
          points, interval_minutes, last_scored_at, enabled, notes, created_at, updated_at)
       VALUES (900902, 'Staging demo: send four useful reports',
               'USEFUL_FEEDBACK', NULL, 900731, 4, 1000, 10,
               NOW() - INTERVAL '4 minutes', TRUE,
               'Staging demo: backs the feedback challenge''s itemized list.',
               NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         challenge_id = EXCLUDED.challenge_id, measure = EXCLUDED.measure,
         target = EXCLUDED.target, points = EXCLUDED.points, enabled = TRUE,
         interval_minutes = COALESCE(challenge_scoring_rules.interval_minutes, EXCLUDED.interval_minutes),
         last_scored_at = COALESCE(challenge_scoring_rules.last_scored_at, EXCLUDED.last_scored_at)`
    );
    const { rows: viewerRows } = await pool.query(
      "SELECT id FROM users WHERE username = 'usernode-capture'");
    if (!viewerRows.length) return;
    const VIEWER = viewerRows[0].id;
    // Somebody else's public project, so every report is about a project the
    // member did not make.
    const { rows: appRows } = await pool.query(
      `SELECT id FROM apps
        WHERE created_by IS NOT NULL AND created_by <> $1
          AND view_visibility = 'public'
        ORDER BY id ASC LIMIT 1`, [VIEWER]);
    if (!appRows.length) return;
    const APP = appRows[0].id;

    const reports = [
      {
        title: '[Staging demo] The map will not zoom on a phone',
        description: 'Opening the map on a phone leaves it stuck at one zoom level, and pinching does nothing.',
        hours: 3,
      },
      {
        title: '[Staging demo] Search skips accented names',
        description: 'Searching for “café” finds nothing while “cafe” finds the place, so accented names are missed.',
        hours: 2,
      },
      {
        title: '[Staging demo] Add dark mode',
        description: 'test',
        hours: 1,
      },
    ];
    const ids = [];
    for (const report of reports) {
      await pool.query(
        `INSERT INTO feedback_reports
           (user_id, target, app_id, issue_owner, issue_repo, issue_number, title, description, created_at)
         SELECT $1, 'app', $2, NULL, NULL, 9100 + $4, $3::text, $5,
                GREATEST(NOW() - ($6::int * INTERVAL '1 hour'), date_trunc('week', NOW()))
          WHERE NOT EXISTS (
            SELECT 1 FROM feedback_reports WHERE user_id = $1 AND title = $3::text)`,
        [VIEWER, APP, report.title, reports.indexOf(report), report.description, report.hours]
      );
      const { rows: found } = await pool.query(
        'SELECT id FROM feedback_reports WHERE user_id = $1 AND title = $2 LIMIT 1',
        [VIEWER, report.title]);
      if (found[0]) {
        ids.push(found[0].id);
        // The week moves with every boot, so a preview rebooted after Monday
        // keeps its reports inside the count's week.
        await pool.query(
          `UPDATE feedback_reports
              SET description = $3,
                  created_at = GREATEST(NOW() - ($4::int * INTERVAL '1 hour'), date_trunc('week', NOW()))
            WHERE id = $1 AND user_id = $2`,
          [found[0].id, VIEWER, report.description, report.hours]
        );
      }
    }
    if (!ids.length) return;
    // The counted one: the ledger row is what the list reads as Counted.
    await pool.query(
      `INSERT INTO user_activities
         (user_id, season_event_id, activity_type, points, description, metadata, activity_at,
          challenge_id, created_at, updated_at)
       VALUES ($1, $2, 'WEEKLY', 210, 'Feedback on a project', $3::jsonb, NOW(),
               900731, NOW(), NOW())
       ON CONFLICT (challenge_id, user_id, (metadata->>'source_key'))
         WHERE metadata->>'source_key' IS NOT NULL
       DO UPDATE SET activity_at = NOW(), points = EXCLUDED.points`,
      [VIEWER, EVENT_SEASON_ID, JSON.stringify({
        source_key: `feedback:${ids[0]}`,
        grade: { score: 210, reason: 'says what happened and where' },
      })]
    );
  } catch (err) {
    log.warn('db', 'Staging challenge items seed skipped', { message: err.message });
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
// Self-hosted apps keep the platform's schema identity. In split mode the
// migrator owns it; tenant lifecycle uses the separate provisioner. The
// bootstrap refuses unresolved legacy tenant ownership before cutover.
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
    `SELECT id, slug, name, container_id, manifest_snapshot, db_password, status, self_hosted
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

  const inventoryStarted = Date.now();
  const existingRoles = await dbManager.existingRoles(rows.filter(app => app.db_password)
    .map(app => dbManager.ownerRoleName(dbManager.appDbName(app.slug))));
  const inventoryMs = Date.now() - inventoryStarted;

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
        const exists = existingRoles.has(role);
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
    adopted, verified, recreated, skipped, failed, inventoryMs,
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
// A few rows for Admin → SMS delivery's "Recent failures" table. The table
// is staging:private, so a preview would otherwise show only its empty
// state and nobody could review the populated one. One row per failure
// shape the table exists to answer, all obviously fake, the demo user for
// the one signed-in row; idempotent (only when the table is empty), and
// strictly a no-op outside staging.
async function seedStagingPhoneFailures(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  try {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM phone_auth_failures');
    if (!rows[0] || rows[0].n > 0) return;
    await pool.query(
      `INSERT INTO phone_auth_failures
         (kind, user_id, phone_last4, error_code, provider_code, message, created_at)
       VALUES
         ('link_verify', 900001, '0101', 'phone_in_use', NULL,
          'Staging demo: that phone number already has an account.',
          NOW() - INTERVAL '2 days'),
         ('verify', NULL, NULL, 'invalid_or_expired_code', 'INVALID_CODE',
          'Staging demo: the code was mistyped or had expired.',
          NOW() - INTERVAL '1 day'),
         ('code_request', NULL, '9001', 'too_many_attempts', 'TOO_MANY_ATTEMPTS_TRY_LATER',
          'Staging demo: too many attempts. Try again later.',
          NOW() - INTERVAL '3 hours')`
    );
    log.info('db', 'Staging phone failure log seeded', { rows: 3 });
  } catch (err) {
    log.warn('db', 'Staging phone failure log seeding failed', { message: err.message });
  }
}

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

    // Tracking demo contains only synthetic recipients. Stable opaque ids
    // and event keys keep repeated staging boots idempotent.
    const demoMessageId = crypto.createHash('sha256').update('Staging demo mail tracking').digest('hex').slice(0, 48);
    await pool.query(
      `UPDATE mail_deliveries SET message_id = $1, provider_message_id = 'staging-demo-receipt'
        WHERE id = (SELECT id FROM mail_deliveries
          WHERE recipient = 'staging-demo-released@example.invalid'
            AND kind = 'waitlist_released' AND status = 'sent' ORDER BY id LIMIT 1)`,
      [demoMessageId]
    );
    await pool.query(
      `INSERT INTO mail_events (delivery_id, type, event_key, meta)
       SELECT id, 'delivered', 'staging-demo:delivered', '{"demo":"Staging demo"}'::jsonb
         FROM mail_deliveries WHERE message_id = $1
       ON CONFLICT (event_key) DO NOTHING`, [demoMessageId]
    );

    for (const [kind, label, recipient, types] of [
      ['build_ready', 'build', 'staging-demo-tracking-build@example.invalid', ['delivered', 'opened', 'clicked', 'unsubscribed']],
      ['project_invite', 'invite', 'staging-demo-tracking-invite@example.invalid', ['bounced', 'complained']],
    ]) {
      const id = crypto.createHash('sha256').update(`Staging demo tracking ${label}`).digest('hex').slice(0, 48);
      await pool.query(
        `INSERT INTO mail_deliveries (kind, recipient, provider, status, message_id, tracking_links, engagement_tracked, created_at)
         SELECT $1::text, $2::text, 'http', 'sent', $3::text, '["https://app.onhomeroom.com/#home"]'::jsonb, TRUE,
           NOW() - INTERVAL '1 day'
         WHERE NOT EXISTS (SELECT 1 FROM mail_deliveries WHERE message_id = $3::text)`,
        [kind, recipient, id]
      );
      await pool.query('UPDATE mail_deliveries SET engagement_tracked = TRUE WHERE message_id = $1', [id]);
      for (const type of types) {
        await pool.query(
          `INSERT INTO mail_events (delivery_id, type, event_key, url, user_agent_class, meta)
           SELECT id, $2::text, $3::text, $4::text, $5::text, '{"demo":"Staging demo","approximate":true}'::jsonb
             FROM mail_deliveries WHERE message_id = $1
           ON CONFLICT (event_key) DO NOTHING`,
          [id, type, `staging-demo:${label}:${type}`, type === 'clicked' ? 'https://app.onhomeroom.com/#home' : null,
            type === 'opened' ? 'image_proxy' : null]
        );
      }
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
  STAGING_SEEDS,
  runStagingSeeds,
  // #7172: the boot's record of seeds that wrote nothing, as its test seam.
  writeStagingSeedReport,
  backfillFenceWrappedSpecs,
  // 20 Nov 2026 (live-draft review): its own suite runs it (tests/live-draft-seed-postgres.test.js).
  seedStagingLiveDraftThread,
  migrateAppDbsToPerRole,
  markChangesWithoutWorkState,
  seedStagingTranslations,
  migrate, seedStagingTopochain, seedStagingFirstChallenges, seedStagingCountedCredit,
  seedStagingProfileCustomization,
  seedStagingProfileProjects,
  seedStagingBotBuiltDeleteApp,
  // #7147: the eleven fake communities, ten pinned, the sidebar's shots need.
  seedStagingPinnedCommunities,
  // #7170: the request in an emoji project the thread header's tile shot needs.
  seedStagingEmojiThreadRequest,
  seedTermsVersions, TERMS_VERSIONS,
  seedStagingBotChatRequest,
  // #6284: the stopped-fix change the Testing card and Homeroom bot page
  // shots need, as its own test seam (the fixtures are staging-only).
  seedStagingBotFixesStopped,
  // #6599: the ready draft the thread card's Put it up for a vote has to show.
  seedStagingReadyDraftChange,
  seedStagingBotFixesPlatform,
  // #6563: the approved change GitHub is holding, the Merging card's shot.
  seedStagingGithubChecksHold,
  seedStagingPlatformLimit,
  seedStagingBotProjectNotification,
  seedStagingBotAllowanceWarning,
  // #6306: the already-works request (run, note and bell row) the shots need.
  seedStagingBotAlreadyWorks,
  // #6988: the already-works request's gone close offer, with its line and
  // Propose to close, the shots need.
  seedStagingBotGoneCloseOffer,
  // #6752: the wrong-project request (run, note and offer) the shots need.
  seedStagingBotWrongProject,
  // #6399: the handed-back request whose reason a later release lifted.
  seedStagingBotOutdatedReason,
  // #6441: the folded "went live" rows the bell's Unread shows.
  seedStagingFoldedLiveNotifications,
  seedStagingDesignThread,
  seedStagingCapturedPageThread,
  // K (20 Nov 2026): one thread holding two artifacts, the picker's shots.
  seedStagingArtifactsThread,
  // The private thread about a change that is live, which History lists.
  seedStagingLiveChangePrivateThread,
  // A short open private thread, whose reply box stands at the column's foot.
  seedStagingShortPrivateThread,
  seedStagingOlderFirstVersionThread,
  // A first version being built, whose plan was answered with Build it.
  seedStagingFirstVersionBuildingThread,
  // #6816: more recent threads than Home's card beside Pinned apps can list.
  seedStagingRecentThreads,
  seedStagingPlatformMail, auditDuplicatePrSessions,
  migrateWaitlistCountryCodes,
  seedStagingHelperCalls,
  clearAutomatedChannelLines,
  plainWelcomeSignOffs,
  moveMainChatToThreads,
  moveOldChatsToThreads,
  backfillFiledDraftCards,
  backfillLinkedIssuesFromPrBodies,
  backfillPlanRows,
  backfillProposalIssuerAssignments, backfillVotesRequired,
  backfillSettingsProposalSource,
  markBareDateActivities,
  seedStagingTopicScrollThreads, seedStagingLlmUsage, seedStagingHomeLayout,
  seedStagingAnalyticsCharts, seedStagingSpendDistribution,
  seedStagingGeneralChannel, seedStagingShotsNoticed, seedStagingShotsScreens, seedStagingCompetingChanges, seedStagingShotsFailed,
  seedStagingVisuals, seedStagingGalleryProposals,
  // A test seam: preview-projects-source-repo.test.js counts what a preview's
  // sample apps leave room for under the limit it runs with.
  seedStagingAppCapApps,
};
