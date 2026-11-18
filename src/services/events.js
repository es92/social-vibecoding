// Append-only product-analytics event emitter.
//
// Writes rows into the `events` table (see schema.sql) that power the
// admin /dashboard growth, retention, and funnel views. Emission is
// `record()` is deliberately fire-and-forget: a missed ordinary analytics row
// must NEVER break or slow down the user action that produced it, so it
// swallows every error (logging at debug). A dapp_opened signal is the one
// delivery exception: services/app-openings.js awaits an idempotent insert so
// its client retry queue can distinguish "durable" from "try again".
//
// Historical rows for the original event vocabulary are synthesized once
// by backfillEvents() in src/db/migrate.js. Newer action types can have no
// complete historical source; callers must treat this as a best-effort log,
// and analytics may combine it with the corresponding domain table.

const { getPool } = require('../db/pool');
const log = require('./logger');

// Canonical event vocabulary. Mirrored by the backfill in migrate.js and
// consumed by the funnel/growth/retention queries in routes/dashboard.js.
// Keep these three in sync when adding a new event type.
const EVENT_TYPES = Object.freeze({
  USER_SIGNED_UP: 'user_signed_up',
  // Username change. The metadata carries both handles because the
  // retired one is the only way to read back who an old `@mention` or a
  // shared #leaderboard/users/<name> link used to mean — `username_history`
  // holds the reservation, this holds the WHEN and the audit trail.
  USERNAME_CHANGED: 'username_changed',
  // A successful top-level App-tab entry. Written through app-openings.js;
  // created_at is the bounded occurrence time, while metadata.receivedAt is
  // the server receipt time after any retry.
  DAPP_OPENED: 'dapp_opened',
  DAPP_ACTIVE_DAY: 'dapp_active_day',
  CHAT_MESSAGE_SENT: 'chat_message_sent',
  PR_VOTE_CAST: 'pr_vote_cast',
  ISSUE_VOTE_CAST: 'issue_vote_cast',
  PR_VOTE_RECEIVED: 'pr_vote_received',
  // A vote on a change taken back while the change was still up for a vote
  // (DELETE /api/sessions/:id/vote, the review flow's Undo), with { vote }:
  // the side that was taken back. Append-only ledger like KUDOS_RETRACTED:
  // the pr_vote_cast row stays, and a consumer netting "votes cast" from
  // raw events subtracts these. No backfill: there were no retractions
  // before this shipped.
  PR_VOTE_RETRACTED: 'pr_vote_retracted',
  KUDOS_GIVEN: 'kudos_given',
  // Retraction of a previously given PR kudos (issue #197). Append-only
  // ledger: the original kudos_given row stays; any consumer netting
  // "kudos given" from raw events should subtract these. No backfill —
  // historical retractions don't exist by definition.
  KUDOS_RETRACTED: 'kudos_retracted',
  APP_FAVORITED: 'app_favorited',
  APP_CREATED: 'app_created',
  DEV_SESSION_STARTED: 'dev_session_started',
  PR_OPENED: 'pr_opened',
  PR_PROMOTED: 'pr_promoted',
  PR_MERGED: 'pr_merged',
  BOUNTY_CREATED: 'bounty_created',
  BOUNTY_AWARDED: 'bounty_awarded',
  COLLAB_INVITED: 'collab_invited',
  COLLAB_JOINED: 'collab_joined',
  VISIBILITY_CHANGED: 'visibility_changed',
  // Proposal-approval governance (issue #646): settings change applied
  // from dapp.json, and the approver-invite lifecycle (mirrors
  // COLLAB_INVITED / COLLAB_JOINED).
  GOVERNANCE_CHANGED: 'governance_changed',
  // Per-app admin roster applied from dapp.json (issue #788).
  APP_ADMINS_CHANGED: 'app_admins_changed',
  APPROVER_INVITED: 'approver_invited',
  APPROVER_JOINED: 'approver_joined',
  // The app's lock toggled (POST /api/apps/:slug/lock), with { locked }.
  // Read back by services/app-notices.js with the settings changes above.
  APP_LOCK_CHANGED: 'app_lock_changed',
  // A project's custom domain (#4405, services/app-domains.js): metadata
  // carries { hostname, action } with action one of added | live | removed
  // | failed | disabled | enabled. Read back by services/app-notices.js.
  APP_DOMAIN_CHANGED: 'app_domain_changed',
  // The Friday card (services/weekly-digest.js), its data as metadata. A
  // channel carries no activity, so this is where the card lives, and a
  // project's Workshop shows it for a few days (services/app-notices.js).
  WEEKLY_DIGEST: 'weekly_digest',
  // Invite links (services/community-invites.js): made, turned off, and
  // followed, with { inviteId, ... }. The redemption rows are the record of
  // who followed whose link; these are the analytics trail. A link the
  // leaked-link guard paused is a platform incident (invite_link_paused);
  // opening it again is this.
  INVITE_LINK_CREATED: 'invite_link_created',
  INVITE_LINK_REVOKED: 'invite_link_revoked',
  INVITE_LINK_REDEEMED: 'invite_link_redeemed',
  INVITE_LINK_REOPENED: 'invite_link_reopened',
  // Sync-with-main completed (issue: make sync emit session activity).
  // Attributed to the session owner (sync bills the owner), recorded on
  // the terminal path with { syncResult, behind, sha, pushOk, trigger }.
  SYNC_MAIN: 'sync_main',
  // Fable 5 classifier fallback: a platform-authored Anthropic call was
  // served by the fallback model (usage.iterations detection), recorded
  // with { requested, served, category, source }. No code records it now;
  // the kind stays so the rows already written keep their name.
  MODEL_FALLBACK: 'model_fallback',
  // Whole-chain refusal: the requested model AND its fallback declined
  // (or the fallback couldn't run and the direct retry declined too).
  MODEL_REFUSAL: 'model_refusal',
  // A full platform database export was streamed to an admin's browser
  // (src/routes/admin.js /api/admin/db-export). Emitted only on the
  // completed path — the authoritative record of every attempt, including
  // denials and failures, is the append-only `db_exports` table. No
  // backfill: the capability didn't exist before this shipped.
  DB_EXPORTED: 'db_exported',
  // A platform environment variable was set or cleared from the admin
  // console (src/routes/admin.js /api/admin/platform-env). Metadata
  // carries { key, action:'set'|'clear', private } — never the value.
  // No backfill: before this shipped, changing a platform variable meant
  // editing deploy.yml, which leaves its trace in git, not here.
  PLATFORM_ENV_CHANGED: 'platform_env_changed',
  // An admin sent a diagnostic email from Admin → Email delivery
  // (src/routes/admin.js POST /api/admin/mail/test). Metadata carries
  // { status, provider, recipient } — the same fields the mail_deliveries
  // ledger already holds, never the message body and never a credential.
  // Emitted for every outcome, including `failed` and `no_transport`: an
  // operator probing an address is worth a durable trace whether or not
  // the provider accepted it. No backfill — the button didn't exist
  // before this shipped.
  MAIL_TEST_SENT: 'mail_test_sent',
  // An admin switched who sends platform mail (src/routes/admin.js PUT
  // /api/admin/mail/provider). Metadata carries { from, to }, provider names
  // (`from` is null when nothing could send before), never a credential.
  MAIL_PROVIDER_CHANGED: 'mail_provider_changed',
  // An admin changed an email template or layout from Admin > Email templates
  // (src/routes/admin-email-templates.js). Metadata carries { what:
  // 'template'|'layout', change: 'saved'|'restored'|'deleted', id, action or
  // familyId, version or replacementId }: which version, never its words. The
  // version rows themselves (created_by) keep who wrote each one; this is the
  // trace of restores and deletes, which write no new row. A test send from the
  // editor is a MAIL_TEST_SENT with { action }. No backfill: the section did
  // not exist before this shipped.
  EMAIL_TEMPLATE_CHANGED: 'email_template_changed',
  // An admin sent a diagnostic text from Admin → SMS delivery
  // (src/routes/admin.js POST /api/admin/sms/test). Metadata carries
  // { status, providerCode, phoneLast4 } — the last four digits only,
  // never the whole number, the code or a credential. Emitted for every
  // outcome Firebase gave, including `refused` and `unreachable`. No
  // backfill — the button didn't exist before this shipped.
  SMS_TEST_SENT: 'sms_test_sent',
  // An admin switched who sends texts (src/routes/admin.js PUT
  // /api/admin/sms/provider). Metadata carries { from, to }, provider names,
  // never a credential.
  SMS_PROVIDER_CHANGED: 'sms_provider_changed',
  // An admin ran the bulk container rollover (src/services/app-rollover.js
  // via POST /api/admin/rollover): every running child-app container
  // recreated with freshly assembled env. Metadata carries the tally
  // { jobId, total, rolled, rebuilt, skipped, failed, failedSlugs,
  // durationMs }. Emitted once, at job end — the job record itself is
  // in-memory, so this is its only durable trace. No backfill.
  CONTAINERS_ROLLED_OVER: 'containers_rolled_over',
  // An admin ran the stale-staging-preview sweep
  // (src/services/staging-reap.js via POST /api/admin/staging-reap): every
  // preview container torn down so the next Preview click rebuilds it with
  // current env. The preview half of CONTAINERS_ROLLED_OVER — the rollover
  // deliberately covers production app containers only. Metadata carries
  // { jobId, total, tornDown, dbsDropped, skipped, failed, failedNames,
  // byClassification, durationMs }. Emitted once, at job end — the job
  // record itself is in-memory, so this is its only durable trace. No
  // backfill.
  STALE_PREVIEWS_REAPED: 'stale_previews_reaped',

  // A mobile shell asked POST /api/v4/app-version/check whether it must
  // update. Recorded so the Topochain → App version admin screen can show
  // whether the release gate is doing anything at all: with no
  // app_version_configs row the endpoint answers `upgrade: 0` to every
  // build, which is indistinguishable from "no app is calling" unless the
  // calls themselves are counted. metadata: { os, upgrade }.
  APP_VERSION_CHECKED: 'app_version_checked',

  // Content-free, provider-neutral LLM invocation baseline (#717). Detailed
  // fields live in a strict allowlisted metadata shape written by
  // services/llm-telemetry.js; OpenRouter's existing agent_turns ledger is
  // normalized alongside these rows by the admin aggregate report.
  LLM_INVOCATION: 'llm_invocation',
  // Privacy-bounded client experience records. `services/ui-telemetry.js`
  // owns the entire metadata vocabulary and rejects arbitrary keys before a
  // row reaches this table. There is deliberately no historical backfill:
  // these are observations from instrumented builds, not inferred actions.
  UI_EXPERIENCE: 'ui_experience',
  // One server receipt per accepted client batch. This is separate from the
  // observations so the admin report can say how much telemetry arrived,
  // how much was retried/dropped locally, and when reporting last worked.
  UI_TELEMETRY_DELIVERY: 'ui_telemetry_delivery',
  // The admin Journey's creation path, written by services/journey-events.js
  // and read by services/journey.js creationPath. No backfill: nothing
  // recorded these moments before.
  //   app_running    a project's first successful run (once, beside
  //                  apps.first_running_at). metadata: { secondsFromCreation }
  //   preview_opened a preview answered as ready to somebody, once per
  //                  viewer per change. metadata: { sessionId, viewerRole }
  //   change_live    a change merged and deployed, once per change.
  //                  metadata: { sessionId, requesterIds, firstVersion, live, sha }
  APP_RUNNING: 'app_running',
  PREVIEW_OPENED: 'preview_opened',
  CHANGE_LIVE: 'change_live',
  // Where a new project's time to running went (#4895): one row per
  // creation attempt, whatever its outcome, written by
  // services/app-creation-timing.js and read by journey.js creationPath.
  // No backfill: nothing timed creation before.
  //   app_creation_timed  metadata: { outcome ('running' | 'awaiting_secrets'
  //                       | 'error'), kind ('new_repo' | 'existing_repo'),
  //                       starter, totalMs, stages: { name: ms }, failedIn?,
  //                       build?, pod? }
  APP_CREATION_TIMED: 'app_creation_timed',
  // The admin Journey's first session (services/journey.js firstSession).
  // No backfill: nothing recorded these moments before.
  //   first_artefact_shown  the first thing of theirs a maker sees: the sketch
  //                         of a project made from the first session, shown
  //                         to its maker (once per project, written by
  //                         journey-events.noteFirstArtefactShown).
  //                         metadata: { artefact, secondsFromCreation }
  //   invite_opened         a live invite link opened, once per person
  //                         (an account, else a browser) and maker and
  //                         project (services/invite-activity.js); user_id
  //                         is the visitor when signed in. Recorded signed
  //                         out too, though only a signed-in open tells the
  //                         maker (#4176). metadata: { inviteId, signedIn }
  //   invite_signed_in      the invite funnel's middle step: somebody signed
  //                         up or in from a live invite link (the sign-in
  //                         carried it: communityInvites.redeemCarried, or
  //                         dropCarried when it does not follow it), or
  //                         opened one already signed in, before joining.
  //                         Once per person per link (the unique index in
  //                         schema.sql), written by
  //                         journey-events.noteInviteSignedIn. metadata:
  //                         { inviteId, how: 'signed_up' | 'signed_in' |
  //                         'was_signed_in' }; the first two are the
  //                         sign-ins the link brought, the last somebody
  //                         already signed in (#4272)
  //   first_session_looked_around
  //                         the first session's question, "What do you want
  //                         to make?", answered with "Look around first"
  //                         (#4039): the other outcome beside a project made
  //                         from it (app_created with from 'first-session').
  //                         Written once, with the answer itself
  //                         (services/first-session.js answerJoinScreen).
  //                         metadata: { via } (how the question reached
  //                         them: 'story' or 'sign_in')
  FIRST_ARTEFACT_SHOWN: 'first_artefact_shown',
  INVITE_OPENED: 'invite_opened',
  INVITE_SIGNED_IN: 'invite_signed_in',
  FIRST_SESSION_LOOKED_AROUND: 'first_session_looked_around',
  // An account let in at once because the waitlist was off when it signed
  // up (#6633, services/waitlist.js admitIfOpen). Written once, with the
  // grant; Admin › Journey reads it to say how the account came in.
  OPEN_SIGNUP_LET_IN: 'open_signup_let_in',
  // An account let in by an admin's invite link to Homeroom (/welcome/<code>,
  // services/access-links.js), which spent that link. metadata: { codeId }.
  ACCESS_LINK_LET_IN: 'access_link_let_in',
  // Something on the platform that should not happen, kept for admins
  // (services/platform-incidents.js, #4210). metadata: { kind, ... } where
  // kind names the incident ('build_interrupted': a bot build a restart or
  // a lost worker cut short; { runId, issueNumber, why, outcome }.
  // 'checks_not_change': a bot change's red check that its fix turn found the
  // change did not cause; { runId, issueNumber, prNumber, head, failing, why }).
  PLATFORM_INCIDENT: 'platform_incident',
  // The Homeroom bot's build turns that quit early, and their nudges
  // (homeroom-bot-live.js recordNoChange), so a weekly query can read the
  // early-quit rate per OpenRouter provider and how often a nudge saves the
  // build. Both carry the turn's facts: { lane, runId, trialId,
  // issueNumber, turn ('build' | 'nudge'), ended, provider, providers,
  // model, harness, requests, toolCalls, fileEdits, outputTokens, seconds,
  // recovered }. Never what the agent said: that is kept on its run.
  //   bot_build_no_change  a build turn that ended cleanly and pushed
  //                        nothing new; the build's own adds { nudged,
  //                        notNudged }
  //   bot_build_nudged     a nudge, once it ended; adds { committed }
  BOT_BUILD_NO_CHANGE: 'bot_build_no_change',
  BOT_BUILD_NUDGED: 'bot_build_nudged',
  // A first version's spec turn, once it ends (homeroom-bot-live.js
  // draftSpec, newcomer run five): how many screens it saved with
  // `usernode-screen` while it ran, and how long into the turn the first
  // one was read, so a weekly query can read how often the first look comes
  // early and how early. { saved, firstSavedMs (null when none was),
  // specMs, ok, stopped, model }. A spec that saved none is also logged as
  // a warning.
  BOT_SPEC_SCREENS: 'bot_spec_screens',
  // #6269: a plan's card text that failed its checks, once per plan, with
  // { kinds (its problems by code), repaired (whether a repair turn changed
  // it), kindsAfter (what still fails), used ('whole', 'lines' or
  // 'fallback') and model }. Rollout health reads it; the log line stays.
  BOT_PLAN_CARD: 'bot_plan_card',
  // Step 5 of the Homeroom bot's one model (11 Nov 2026): a tap on one of
  // its offers or cards, as the route answered it: { surface ('thread': a
  // project thread's offer, routes/chat.js; 'chat': an offer in a person's
  // chat with it, routes/conversations.js actions; 'card': a card under a
  // reply there, homeroom-bot-cards), status (the HTTP status answered) }.
  // Rollout health counts the 404s and 410s per week: a button that no
  // longer does anything.
  BOT_OFFER_TAP: 'bot_offer_tap',
  // #4449: Live, the new app shown taking shape while its first version is
  // built (services/first-version-live.js). Written to compare build times
  // with and without the watcher, and to see how often Live showed nothing.
  //   first_version_build_turn  every first version's build turn, once it
  //                        ends: { runId, buildTurnMs (its first turn),
  //                        turnsMs (with a nudge), nudged, watcher (whether
  //                        the watcher ran), setting (whether Live was on) }
  //   live_build_stream    per run, when its watcher stops: { runId,
  //                        restartsKept, restartsFailed, goodFrame (ever had
  //                        one), memoryStop, stoppedWhy, bytes }
  //   live_build_opened    a member opened Live: { runId }
  //   live_build_watched   how long they watched, sent when they close or
  //                        hide it: { runId, seconds, goodFrame }
  FIRST_VERSION_BUILD_TURN: 'first_version_build_turn',
  LIVE_BUILD_STREAM: 'live_build_stream',
  LIVE_BUILD_OPENED: 'live_build_opened',
  LIVE_BUILD_WATCHED: 'live_build_watched',
  // Newcomer run five (13 Oct 2026): what a first version's timings could
  // only be pieced together from screenshots and a polling watcher.
  //   first_version_stage   a first version moved to a new stage, written
  //                        by the pipeline as it moves
  //                        (services/first-version-timeline.js), for its
  //                        maker and project. metadata: { stage, runId,
  //                        issueNumber, ... } (STAGES there names each stage
  //                        and what it adds)
  //   first_session_moment  the made screen showed something, or was tapped
  //                        (services/first-session-moments.js), for the
  //                        person and project: { kind, clientAt (the
  //                        browser's clock), receivedAt (the server's), ... }.
  //                        Test accounts' too: the Journey's made-screen
  //                        reading counts real people only (journey.js
  //                        MADE_SCREEN_SQL).
  FIRST_VERSION_STAGE: 'first_version_stage',
  FIRST_SESSION_MOMENT: 'first_session_moment',
  // Somebody was refused a session because a session cap was full
  // (services/session-lifecycle.js recordCapacityRefusal): { cap: 'global'
  // | 'user', path: where they asked }. The infra topic's "Turned away at a
  // session cap" figure counts these (services/topic-figures.js).
  SESSION_CAPACITY_REFUSED: 'session_capacity_refused',
  // An app's merges paused by a red main, and the pause ending
  // (services/main-watch.js notePauseChange): { sha, confirming } and
  // { sha, by: 'green' | 'flakes' | 'admin' }. The proposal-pipeline
  // topic's "Merges paused by a red main" figure pairs them.
  MAIN_PAUSED: 'main_paused',
  MAIN_RESUMED: 'main_resumed',
  // A merged commit of Homeroom itself that did not become the running
  // release in time (services/release-watch.js, once per commit and kind):
  // { sha, kind: 'workflow_failed' | 'workflow_running' | 'rollout_missing'
  // | 'unknown', prNumber }. The infra topic's "Homeroom releases that
  // stalled" counts the commits.
  RELEASE_STALLED: 'release_stalled',
  // A Homeroom server process came up on Kubernetes
  // (services/platform-release.js recordBoot): { sha, pod }. A second boot
  // in the same pod is its container started again after the process died
  // (a crash, the memory limit, a failed liveness probe): the infra topic's
  // "Homeroom crashes" counts those. A rollout starts new pods instead.
  PLATFORM_BOOTED: 'platform_booted',
  // What ended the last process in a Homeroom pod, read off the Pod by the
  // process that came up after it (services/platform-release.js
  // recordPodExit): { pod, role, container, reason (OOMKilled, Error, ...),
  // exitCode, signal, startedAt, finishedAt, restartCount, memoryLimit }. A
  // second platform_booted says a process died; this says why. The platform
  // signals group them by role (signal-observers/homeroom-crashes.js).
  PLATFORM_POD_EXIT: 'platform_pod_exit',
  // A retained recovery of an interrupted turn ran out of attempts and was
  // given up on (services/recovery-retry.js scheduleRetainedRecovery):
  // { sessionId, recovery: 'interactive' | ..., code, failures }.
  // The turn is left to the stale-turn watchdog; the platform signals file
  // these (signal-observers/turn-recovery.js).
  TURN_RECOVERY_GAVE_UP: 'turn_recovery_gave_up',
  // A checks run got its slot in the checks queue (services/checks-queue.js
  // waitForSlot), or went ahead without one because the queue could not be
  // read or joined: { runId, kind, class, waitedMs, failedOpen }. Admin →
  // Health & status reads the last day of them for its Checks queue block.
  // No backfill: a wait left nothing behind before this shipped.
  CHECKS_SLOT_GRANTED: 'checks_slot_granted',
});

// Record a single analytics event. Fire-and-forget — returns a promise
// that always resolves (never rejects), so callers can either ignore it
// or `.catch(() => {})` it without risk. Pass whichever of
// userId/appId/sessionId are known; all are optional. `metadata` is an
// arbitrary JSON-serializable object stored alongside the row.
//
// `poolOrConfig` accepts either an already-resolved pg Pool (the common
// case — routes already hold one) or a config object, from which the
// shared pool is looked up. This keeps call sites terse regardless of
// what they have in scope.
function record(poolOrConfig, { type, userId, appId, sessionId, metadata } = {}) {
  // Everything is wrapped so a missing pool, a synchronous throw, or a
  // mock pool that returns a non-promise can never escape into the
  // calling request handler. record() ALWAYS returns a resolved promise.
  try {
    if (!type) return Promise.resolve();
    const pool = resolvePool(poolOrConfig);
    const result = pool.query(
      `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        userId ?? null,
        appId ?? null,
        sessionId ?? null,
        type,
        JSON.stringify(metadata || {}),
      ]
    );
    if (result && typeof result.then === 'function') {
      return result.then(() => {}).catch((err) => {
        log.debug('events', 'record failed', { type, err: err.message });
      });
    }
    return Promise.resolve();
  } catch (err) {
    // Never propagate — analytics is best-effort.
    log.debug('events', 'record skipped', { type, err: err && err.message });
    return Promise.resolve();
  }
}

/**
 * A tap on one of the Homeroom bot's offers or cards, as its route answered
 * it (BOT_OFFER_TAP): `surface` 'thread' | 'chat' | 'card' and the HTTP
 * `status`. Best-effort, as every record is.
 */
function recordBotOfferTap(poolOrConfig, { surface, status, userId = null, appId = null } = {}) {
  return record(poolOrConfig, {
    type: EVENT_TYPES.BOT_OFFER_TAP,
    userId,
    appId,
    metadata: { surface: String(surface || ''), status: Number(status) || null },
  });
}

// A pg Pool exposes `.query`; a config object does not. Disambiguate so
// callers can hand us either.
function resolvePool(poolOrConfig) {
  if (poolOrConfig && typeof poolOrConfig.query === 'function') {
    return poolOrConfig;
  }
  return getPool(poolOrConfig);
}

module.exports = { record, recordBotOfferTap, EVENT_TYPES };
