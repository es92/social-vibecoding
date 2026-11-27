'use strict';

// The staging seeds a boot runs, as an ordered list the before & after shots
// runner can also run one at a time (src/db/seed-other-copy.js). A normal
// boot must behave exactly as before: same order, translations still left in
// the background, and the starter-project seed never run against another
// copy because it reaches beyond the database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STAGING_SEEDS, runStagingSeeds } = require('../src/db/migrate');

test('the seed list keeps the boot order and gives every seed a unique name', () => {
  const names = STAGING_SEEDS.map((entry) => entry.name);
  assert.equal(names[0], 'reservePreviewReviewerIds');
  assert.equal(names.at(-1), 'seedStagingFeedback');
  assert.equal(new Set(names).size, names.length, 'each seed is named once');
  assert.ok(names.indexOf('seedCaptureUser') < names.indexOf('seedStagingDemoUser'));
  assert.ok(names.indexOf('seedStagingGeneralChannel') < names.indexOf('seedStagingGroupFacesRows'),
    'a seed that needs another runs after it');
  for (const entry of STAGING_SEEDS) {
    assert.equal(typeof entry.run, 'function', `${entry.name} has a run function`);
  }
});

test('only the starter-project seed reaches beyond the database', () => {
  const ownCopyOnly = STAGING_SEEDS.filter((entry) => entry.ownCopyOnly).map((entry) => entry.name);
  assert.deepEqual(ownCopyOnly, ['seedChangedStarters']);
});

test('a normal boot leaves translations in the background', () => {
  const translations = STAGING_SEEDS.find((entry) => entry.name === 'seedStagingTranslations');
  assert.equal(translations.background, true);
  assert.equal(STAGING_SEEDS.filter((entry) => entry.background).length, 1);
});

test('the seed runner walks the list in order, background seeds included, and skips own-copy-only', async () => {
  const seen = [];
  const phases = [];
  await runStagingSeeds(null, {}, {
    each: async (entry) => { seen.push(entry.name); },
    onPhase: (name) => phases.push(name),
  });
  assert.deepEqual(seen, STAGING_SEEDS.filter((entry) => !entry.ownCopyOnly).map((entry) => entry.name));
  assert.ok(seen.includes('seedStagingTranslations'), 'a background seed is awaited too');
  assert.ok(!seen.includes('seedChangedStarters'));
  assert.deepEqual(phases, ['coreSeedMs'], 'the phase boundary inside the list still fires');
});

// The exact list main ran inline, in its order, kept here so the extraction
// cannot drop or reorder a seed: a missing one would leave a fresh copy without
// the demo data its declared checks read, which no other test would catch.
const BOOT_ORDER = [
  'reservePreviewReviewerIds', 'seedAdmin', 'seedCaptureUser',
  'seedCaptureAdminUser', 'seedStagingLongInbox', 'seedStagingLinkedBrowsers', 'seedStagingDemoUser',
  'seedStagingAdminDetailsUser', 'seedStagingSupportUser', 'seedStagingDuplicateUser',
  'seedSelfApp', 'seedTermsVersions', 'seedStagingPrivateRequest',
  'seedStagingCollabOnlyVote', 'seedStagingCloseVote', 'seedStagingJoinedBuildOffer', 'seedStagingNamedInThread',
  'seedStagingBotWaitingRows', 'seedStagingBotHandedBackFix', 'seedStagingChangePictures',
  'seedStagingChangeClaim', 'seedStagingBotAlreadyWorks', 'seedStagingBotGoneCloseOffer',
  'seedStagingBotWrongProject', 'seedStagingBotOutdatedReason', 'seedStagingClosedPrivateThread',
  'seedStagingShortPrivateThread', 'seedStagingBotReportReply', 'seedStagingBotFailureNotes',
  'seedStagingMainChatLastVisit', 'seedStagingFoldedLiveNotifications', 'seedStagingStorageNotices',
  'seedStagingLiveDraftThread', 'seedStagingOpenLiveDraft', 'seedStagingLimitRefusals', 'seedStagingDesignThread',
  'seedStagingCapturedPageThread', 'seedStagingArtifactsThread', 'seedStagingBotPlanWaiting',
  'seedStagingBotPlanSettled', 'seedStagingBotFollowUp', 'seedStagingBotOverlap',
  'seedStagingBotOverlapBuilt', 'seedStagingBotTellMeWhen', 'seedStagingBotReplyWaiting',
  'seedStagingBotStaleDescription', 'seedStagingClosedGoingLive', 'seedStagingBotFixesStopped',
  'seedStagingBotFixesPlatform', 'seedStagingOwnChangeWaitingOnFix', 'seedStagingOwnChangeTakingScreenshots',
  'seedStagingOwnChangeWaitingOnVote', 'seedStagingReadyDraftChange', 'seedStagingClosesListFixture',
  'seedStagingMergedThreads', 'seedStagingBotUpdateComing', 'seedStagingNewerPlan',
  'seedConfigs', 'upgradeSeedConfigs', 'fillLaterStages',
  'seedStagingTranslations', 'seedStagingNotifications', 'seedStagingPushDeliveries',
  'seedStagingAdminConsoleData', 'seedStagingHelperCalls', 'seedStagingEnvProposal',
  'seedStagingMergedPrs', 'seedStagingReportSnapshots', 'seedStagingSmallChangeTags',
  'seedStagingMyOpenPr', 'seedStagingAdminNoPr', 'seedStagingApproverNoPr',
  'seedStagingImportedPrProposal', 'seedStagingChecksAdvisoryCard', 'seedStagingExternalAgentProposal',
  'seedStagingRestartEligibleMerge', 'seedStagingGithubChecksHold', 'seedStagingPlatformLimit',
  'seedStagingOtherUserProposal', 'seedStagingTopicScrollThreads', 'seedStagingGroupedFollowOns',
  'seedStagingArchiveProposalFixtures', 'seedStagingActiveSessions', 'seedStagingSharedSession',
  'seedStagingChangeBuiltForRequest', 'seedStagingChangeAlsoCloses', 'seedStagingDiscussionContext',
  'seedStagingBotCloseOffer', 'seedStagingDemoAppCard', 'seedStagingLandingDirectory',
  'seedStagingAppCategories', 'seedStagingInferredCategories', 'seedStagingFailedApp',
  'seedStagingForkLineage', 'seedStagingDemoMode', 'seedStagingMembersPanel',
  'seedStagingUserDirectory', 'seedStagingApproverPanel', 'seedStagingAppAdminsPanel',
  'seedStagingReadonlyDevTab', 'seedStagingQuietDiscussion', 'seedStagingVoteCardChat',
  'seedStagingBotProjectNotification', 'seedStagingWeeklyDigestRow', 'seedStagingBotAllowanceWarning',
  'seedStagingYourApps', 'seedCatalog', 'seedStagingAppGroups',
  'seedChangedStarters', 'seedStagingBrowseCardBranches', 'seedStagingAppSortSignals',
  'seedStagingFeaturedApps', 'seedStagingFeaturedKinds', 'seedStagingAppQuotaUsers',
  'seedStagingHomeLayout', 'seedStagingViewOnlyAdmin', 'seedStagingWalletUsers',
  'seedStagingEmailCodeAccounts', 'seedStagingCustomDomains', 'seedStagingWaitingIllustration',
  'seedStagingPublicApiContributors', 'seedStagingVisuals', 'seedStagingShotsNoticed',
  'seedStagingShotsScreens', 'seedStagingCompetingChanges', 'seedStagingShotsFailed',
  'seedStagingLeaderboardProfile', 'seedStagingGeneralChannel', 'seedStagingMergedVoteRow',
  'seedStagingVoteReasonOnRequest',
  'seedStagingLiveChangePrivateThread', 'seedStagingOlderFirstVersionThread', 'seedStagingFirstVersionBuildingThread',
  'seedStagingRecentThreads', 'seedStagingRenamedChange', 'seedStagingScrollTestThread',
  'seedStagingGroupInviteNote', 'seedStagingGroupFacesRows', 'seedStagingFollowUpBubbles', 'seedStagingSharedRenamedChange',
  'seedStagingOwnReviewChange', 'seedStagingGroupChatAttachments', 'seedStagingAppFiles',
  'seedStagingComplicatedPlanSpec', 'seedStagingSpecUserShareFixtures', 'seedStagingChatEditFixtures',
  'seedStagingBotChatRequest', 'seedStagingNewProjectOfferThread', 'seedStagingLlmUsage',
  'seedStagingWeeklyCaps', 'seedStagingSpendDistribution', 'seedStagingCapReached',
  'seedStagingAppCapApps', 'seedStagingSystemTokenUsage', 'seedStagingDashboardAdminSplit',
  'seedStagingModerationCase', 'seedStagingAnalyticsCharts', 'seedStagingTopicAttributes',
  'seedStagingSubmittedFeatures', 'seedStagingUserContentTranslations', 'seedStagingDbExports',
  'seedStagingBench', 'seedStagingTaste', 'seedStagingStudio',
  'seedStagingBotConfigs', 'seedStagingUnreadableReply', 'seedStagingPlatformEnv',
  'seedStagingTopochain', 'seedStagingInviteChallengeStatuses', 'seedStagingFirstChallenges',
  'seedStagingCountedCredit', 'seedStagingChallengeItems', 'seedStagingProfileCustomization', 'seedStagingProfileProjects',
  'seedStagingBotBuiltDeleteApp', 'seedStagingPhoneFailures', 'seedStagingPlatformMail', 'seedStagingPinnedCommunities',
  'seedStagingEmojiThreadRequest', 'seedStagingDiscussion', 'seedStagingHubContributors',
  'seedStagingGuestProjectPage', 'seedStagingGuestDiscussion', 'seedStagingHeartsAndPlays', 'seedStagingFeedback',
];

test('the extracted list is exactly the boot order main ran, seed for seed', () => {
  assert.deepEqual(STAGING_SEEDS.map((entry) => entry.name), BOOT_ORDER);
});

test('migrate() runs the seeds through the exported runner', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrate.js'), 'utf8');
  assert.match(source, /await runStagingSeeds\(pool, config, \{ onPhase: finishPhase \}\);/);
  assert.match(source, /finishPhase\('stagingFixturesMs'\);/);
});
