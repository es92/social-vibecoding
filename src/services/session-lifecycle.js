'use strict';

// Shared session lifecycle transitions, callable from both HTTP route
// handlers (manual pause/resume) and the background sweeper (auto-pause).
//
// Why a service instead of inline route logic: the auto-pause sweeper in
// server.js needs to run the exact same teardown the manual POST /pause
// endpoint does (status flip + staging teardown + worker destroy + WS
// notify), and we don't want two copies drifting apart. Resume's LRU
// logic in routes/sessions.js also leans on pauseSession here.

const log = require('./logger');
const notifications = require('./notifications');
const staging = require('./staging');
const turnLifecycle = require('./turn-lifecycle');
const worker = require('./worker');
const { isSessionBusy } = require('./active-workers');
const workerProgress = require('./worker-progress');
const github = require('./github');
const branchNames = require('./branch-names');
const externalAgentTasks = require('./external-agent-tasks');

// 14 Oct 2026 (#5162's follow-up): whether a durable build holds the
// session (services/build-runs.js holdsSession: its build is still under
// way, wherever it runs, its turns and the time between them). Slot eviction
// pauses a session without its asking, and pausing destroys its worker: a
// build on a draining process can sit idle between turns longer than the
// grace these use, so a held session is never their victim. A read that
// fails answers false, and the eviction goes on as it did before.
async function heldByDurableBuild(pool, sessionId, why) {
  const held = await require('./build-runs').holdsSession(pool, sessionId);
  if (held) log.info('session-lifecycle', 'Not pausing a session a durable build holds', { sessionId, why });
  return held;
}

// Parse "owner/repo" out of a stored GitHub repo URL. Returns [owner,
// repo] or [] when the URL is missing/unparseable.
function ownerRepo(repoUrl) {
  const [, owner, repo] = (repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? [owner, repo] : [];
}

// Transition a session 'active'|'promoted' -> 'paused'. Reversible: keeps
// the CC volume, branch, PR, AND the staging preview so /resume restores
// cleanly (and cheaply — no staging rebuild). Mirrors the historical
// POST /pause handler body, minus the HTTP-only concerns (auth scoping,
// already-paused soft-200, the in-flight activeWorkers set that lives in
// routes/sessions.js).
//
// NOTE: pause deliberately no longer tears down staging. Staging has its
// own lifecycle now (kept alive across pause so reopening is cheap;
// reclaimed by teardownStagingForSession on a longer idle timer, or on
// archive/merge). Worker re-warm is cheap (~5-30s); a staging rebuild is
// not (docker build + pg clone), so pausing on a short idle timer must
// not pay that cost.
//
// Callers that pause a session which might have a CC turn in flight (the
// manual endpoint, where the user may pause to abort) handle the
// activeWorkers bookkeeping themselves before calling this. The sweeper
// only ever calls this for sessions that are NOT in flight, so there's
// nothing to clear there.
//
// Params:
//   pool      - pg pool
//   sessionId - numeric session id
//   userId    - optional; when set, scopes the status flip to that owner
//               (authz for the manual endpoint). Omit for system actions.
//   reason    - free-form string for logs ('manual' | 'auto-idle' | 'lru')
//
// Returns { paused: boolean, appSlug?: string }. paused=false means the
// row wasn't in a pausable state (already paused/archived/merged, or not
// owned by userId) and nothing was torn down.
async function pauseSession({ pool, sessionId, userId = null, reason = 'manual' }) {
  const params = [sessionId];
  let ownerClause = '';
  if (userId != null) {
    params.push(userId);
    ownerClause = ' AND user_id = $2';
  }

  // Only 'active' sessions are demoted to 'paused'. A 'promoted' session
  // must keep its status so its PR stays up for vote — pausing the
  // proposer's worker must not yank the PR out of the vote (the vote
  // endpoint and cast-vote handler key off status IN ('promoted','merging')).
  // This mirrors the auto-pause sweeper and LRU eviction, which already
  // refuse to pause promoted sessions. The manual /pause endpoint handles
  // the worker teardown for promoted sessions itself (see routes/sessions.js).
  const { rows } = await pool.query(
    `UPDATE chat_sessions SET status = 'paused'
     WHERE id = $1${ownerClause} AND status = 'active'
       AND source IS DISTINCT FROM 'imported'
     RETURNING id`,
    params
  );
  if (!rows.length) return { paused: false };

  const { rows: sessionRows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug
     FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  const session = sessionRows[0];
  const appSlug = session?.app_slug;

  // Clear any lingering progress + tear down the worker container. Both
  // are no-ops if there's nothing there (the common auto-pause case:
  // worker was already idle-evicted minutes ago). Staging is left up on
  // purpose — see the note above.
  workerProgress.clear(sessionId);
  await worker.destroyWorker(worker.workerContainerName(sessionId)).catch(() => {});

  const { pushSessionUpdate } = require('./ws');
  pushSessionUpdate({ action: 'paused', sessionId, appSlug });
  log.info('session-lifecycle', 'Session paused', { sessionId, reason });

  if (SYSTEM_PAUSE_REASONS.has(reason) && pausedMidTurn(session)) {
    await notifyPausedMidTurn(pool, session);
  }

  return { paused: true, appSlug };
}

// #3181: the pauses the platform makes on its own. A pause the owner asked
// for ('manual', or parking a change from an agent session) is a deliberate
// end, like pressing stop, and never reports a stall.
const SYSTEM_PAUSE_REASONS = new Set(['auto-idle', 'pressure', 'lru']);

// Was a turn still open on this session when it was paused? The slot sweeps
// skip sessions busy in THIS process, but a turn record can outlive that:
// one running on another process, or one left detached by a restart and not
// yet recovered. Destroying the worker ends it either way. A record that is
// only waiting for its final cleanup belongs to a turn that already finished.
function pausedMidTurn(session) {
  if (!session || session.is_headless) return false;
  return turnLifecycle.recoveryAction(session.active_turn) === 'resume';
}

// Tell the owner, in the bell and as a push, that the session stopped before
// finishing (same kind and unread dedup the chat turn uses). Best-effort: a
// failed notification never fails the pause.
async function notifyPausedMidTurn(pool, session) {
  try {
    const created = await notifications.createSessionStalledNotification(pool, {
      userId: session.user_id, appId: session.app_id, sessionId: session.id,
    });
    if (created.length) await notifications.hydrateAndPush(pool, created[0]);
  } catch (err) {
    log.warn('session-lifecycle', 'session_stalled notify failed', {
      sessionId: session.id, err: err.message,
    });
  }
}

// #3114: take a proposal out of review and back to Underway, for when its
// author wants to keep working on it before the group can merge it. The
// opposite of the promote route (routes/votes.js), and deliberately NOT a
// withdraw: the pull request, branch, staging preview and CC volume all stay
// exactly as they are, so a later promote reuses them.
//
// Everything that decides safety happens in ONE guarded UPDATE:
//   - `status = 'promoted'` is the same compare-and-set the merge claim in
//     checkAndMerge uses ('promoted' -> 'merging'). Exactly one of the two can
//     win, so a proposal that has started merging is never pulled back, and
//     one that has been pulled back can never be claimed for a merge.
//   - `approval_epoch + 1` voids every vote cast so far, the way
//     integration.clearApprovals does (no DELETE: the rows stay as a record
//     and a re-promote shows voters "Still yes?"). recordVote locks the row
//     and requires 'promoted'/'merging', so a vote racing this either lands
//     before it (and is voided) or finds the row Underway and is refused.
//   - `active_turn IS NULL` plus the in-process busy check keep a running
//     build from being cut off mid-turn.
//   - A secret-declaration proposal is refused: its held value is discarded
//     the moment the session leaves review (services/pending-secrets.js), so
//     the author must decide to withdraw it rather than lose it silently.
//
// Native sessions land in 'paused' (the worker is torn down like /pause, and
// sending a message resumes it through the usual caps); an imported PR has
// no worker and no paused state, so it returns to 'active', the state it was
// promoted from.
//
// Returns { ok: true, status, appSlug } on success, { ok: true, already: true,
// status } when the proposal is already Underway, or { ok: false, code } with
// code in 'not_found' | 'forbidden' | 'merging' | 'closed' | 'busy' |
// 'pending_secret'.
async function unpromoteSession({ pool, sessionId, userId, actorUsername = null }) {
  // An in-process turn (the chat handler's set, a sync-main run) is not in
  // the row, so it is checked here; a busy session skips the write and is
  // reported below, after the ownership answer.
  const busyNow = require('./active-workers').isSessionBusy(sessionId);

  const { rows } = busyNow ? { rows: [] } : await pool.query(
    `UPDATE chat_sessions cs
        SET status = CASE WHEN cs.source = 'imported' THEN 'active' ELSE 'paused' END,
            approval_epoch = cs.approval_epoch + 1,
            stale_notified_at = NULL
      WHERE cs.id = $1 AND cs.user_id = $2
        AND cs.status = 'promoted'
        AND cs.is_headless = FALSE
        AND cs.active_turn IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM pending_secret_declarations p
           WHERE p.session_id = cs.id AND p.status = 'pending'
        )
      RETURNING cs.id, cs.status, cs.app_id, cs.pr_number, cs.pr_title, cs.source`,
    [sessionId, userId]
  );

  if (!rows.length) {
    const { rows: current } = await pool.query(
      `SELECT cs.status, cs.user_id, cs.active_turn IS NOT NULL AS turn_running,
              EXISTS (
                SELECT 1 FROM pending_secret_declarations p
                 WHERE p.session_id = cs.id AND p.status = 'pending'
              ) AS pending_secret
         FROM chat_sessions cs
        WHERE cs.id = $1 AND cs.is_headless = FALSE`,
      [sessionId]
    );
    const row = current[0];
    if (!row) return { ok: false, code: 'not_found' };
    if (Number(row.user_id) !== Number(userId)) {
      // A proposal in review is public, so naming it as someone else's leaks
      // nothing; a private Underway session stays indistinguishable from a
      // missing one.
      return ['promoted', 'merging', 'merged'].includes(row.status)
        ? { ok: false, code: 'forbidden' }
        : { ok: false, code: 'not_found' };
    }
    if (row.status === 'active' || row.status === 'paused') {
      return { ok: true, already: true, status: row.status };
    }
    if (row.status === 'merging' || row.status === 'merged') return { ok: false, code: 'merging' };
    if (row.status !== 'promoted') return { ok: false, code: 'closed' };
    if (busyNow || row.turn_running) return { ok: false, code: 'busy' };
    if (row.pending_secret) return { ok: false, code: 'pending_secret' };
    // Promoted a moment ago and changed again under us: report it as a
    // conflict rather than guessing which state it is in now.
    return { ok: false, code: 'merging' };
  }

  const session = rows[0];
  const { rows: appRows } = await pool.query('SELECT slug FROM apps WHERE id = $1', [session.app_id]);
  const appSlug = appRows[0]?.slug || null;

  // The merge gate's "what it still needs" list describes a proposal under
  // review; an Underway change has nothing blocking it.
  await require('./integration').setBlockReasons(pool, session.id, []).catch(() => {});

  if (session.source !== 'imported') {
    workerProgress.clear(sessionId);
    await worker.destroyWorker(worker.workerContainerName(sessionId)).catch(() => {});
  }

  // The lifecycle feed: promote, merge and withdraw all post here, so the
  // move back is on the record in the app chat and the proposal's own thread.
  const label = session.pr_number
    ? (session.pr_title ? `PR #${session.pr_number}: ${session.pr_title}` : `PR #${session.pr_number}`)
    : `Proposal #${session.id}`;
  const content = `${actorUsername || 'The author'} moved ${label} back to Underway. Its votes were cleared, and it goes up for a fresh vote when it is proposed again`;
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(pool, session.app_id, content, 'system', null,
      { type: 'session', ref: session.id }).catch(() => {});
  } catch (err) {
    log.warn('session-lifecycle', 'Failed to post moved-to-Underway chat message', { sessionId, err: err.message });
  }

  try {
    const { pushSessionUpdate, pushVoteUpdate } = require('./ws');
    pushSessionUpdate({ action: 'unpromoted', sessionId, appSlug });
    pushVoteUpdate({ sessionId, appSlug, appId: session.app_id, merged: false });
  } catch (_) { /* ws failures are non-fatal */ }

  log.info('session-lifecycle', 'Proposal moved back to Underway', { sessionId, status: session.status });
  return { ok: true, status: session.status, appSlug };
}

// Demand-driven global-cap eviction. Called when a new session is needed
// (create or resume) but the platform is at the global cap. Pauses the
// globally least-recently-active 'active' session that has been idle
// longer than `graceMs` and isn't mid-turn — freeing a slot immediately
// rather than making the requester wait for the slow background auto-
// pause. The grace window protects anyone actively working: only
// sessions idle past it are eligible victims.
//
// Cross-user by design: under contention, an idle session belonging to
// any user can be paused to admit a new one. The victim's worker is
// already long gone (idle-evicted), so reopening auto-resumes cleanly.
//
// Params:
//   pool             - pg pool
//   graceMs          - minimum idle time (ms) a session must exceed to be
//                      an eviction candidate. <= 0 disables (returns
//                      {freed:false} without touching anything).
//   excludeSessionId - optional id to never evict (e.g. the session being
//                      resumed).
//
// Returns { freed: boolean, sessionId?: number }.
async function freeGlobalSlot({ pool, graceMs, excludeSessionId = null }) {
  if (!graceMs || graceMs <= 0) return { freed: false };

  const params = [graceMs];
  let exclude = '';
  if (excludeSessionId != null) {
    params.push(excludeSessionId);
    exclude = ' AND id <> $2';
  }

  const { rows } = await pool.query(
    `SELECT id FROM chat_sessions
     WHERE status = 'active'
       AND source IS DISTINCT FROM 'imported'
       AND last_activity_at < NOW() - make_interval(secs => $1::double precision / 1000.0)${exclude}
     ORDER BY last_activity_at ASC
     LIMIT 20`,
    params
  );

  for (const row of rows) {
    // Never evict a session with any turn/pipeline in flight. Native CLI
    // proposal staging has no worker exec, but it owns the same session and
    // must be allowed to finish just like a web coding turn.
    if (isSessionBusy(row.id)) continue;
    if (await heldByDurableBuild(pool, row.id, 'pressure')) continue;
    const { paused } = await pauseSession({ pool, sessionId: row.id, reason: 'pressure' });
    if (paused) {
      log.info('session-lifecycle', 'Freed global slot under pressure', { sessionId: row.id });
      return { freed: true, sessionId: row.id };
    }
  }
  return { freed: false };
}

// The per-user cap, handled for the user rather than put to them. When their
// own work needs one of their slots and every slot is taken, pause their
// least-recently-active session that is not mid-turn. Pausing keeps the
// branch, the pull request, the preview and the agent's context, and opening
// or messaging the session resumes it, so it is bookkeeping the user never
// sees: "paused" is not a state anybody is asked to manage (#2779 follow-up).
// The resume route has always done this; starting new work does it too now.
//
// Params:
//   userId           - whose slot to free (only their own sessions).
//   excludeSessionId - a session never to pause (the one being resumed or
//                      replaced).
//   includeHeadless  - the resume route's count includes headless rows, so
//                      its victims may be headless too; every other count
//                      excludes them.
//
// Returns { freed: boolean, sessionId?: number }.
async function freeUserSlot({ pool, userId, excludeSessionId = null, includeHeadless = false }) {
  const { rows } = await pool.query(
    `SELECT id FROM chat_sessions
      WHERE user_id = $1 AND status = 'active' AND id <> $2
        AND source IS DISTINCT FROM 'imported'
        AND ($3::boolean OR is_headless = FALSE)
      ORDER BY last_activity_at ASC`,
    [userId, excludeSessionId == null ? 0 : excludeSessionId, !!includeHeadless]
  );
  for (const row of rows) {
    const id = Number(row && row.id);
    if (!Number.isInteger(id) || id <= 0 || isSessionBusy(id)) continue;
    if (await heldByDurableBuild(pool, id, 'lru')) continue;
    const { paused } = await pauseSession({ pool, sessionId: id, userId, reason: 'lru' });
    if (paused) {
      log.info('session-lifecycle', 'Freed a user slot', { userId, sessionId: id });
      return { freed: true, sessionId: id };
    }
  }
  return { freed: false };
}

// The one thing a user is told when their slots cannot be freed: every other
// session of theirs is in the middle of a turn.
const USER_SLOTS_BUSY = 'Your other sessions are all busy finishing turns. Try again in a moment.';

// What anybody is told when the platform-wide cap is full and nothing idle
// could be paused to make room.
const PLATFORM_AT_CAPACITY = 'Platform is at capacity right now. Try again in a few minutes.';

/**
 * Somebody was turned away by a session cap: `cap` 'global' (the
 * platform-wide one) or 'user' (their own), `path` where they asked. One
 * event each (events.SESSION_CAPACITY_REFUSED), which the infra topic's
 * "Turned away at a session cap" figure counts: the admins' alert samples
 * the count every few minutes, so it shows how often a cap was full, not
 * how many people met it. Fire-and-forget, never throws.
 */
function recordCapacityRefusal(pool, { cap, path, userId = null, appId = null } = {}) {
  const events = require('./events');
  log.info('session-lifecycle', 'Turned away at a session cap', { cap, path, userId });
  return events.record(pool, {
    type: events.EVENT_TYPES.SESSION_CAPACITY_REFUSED, userId, appId, metadata: { cap, path },
  });
}

/**
 * The platform-wide gate every start, resume and reopen passes: under
 * config.maxGlobalSessions (session-caps.countGlobalSessions), or at it with
 * an idle session paused to make room (freeGlobalSlot). `discount` is a slot
 * the request gives back (a replaced session). Answers { ok } and, when not,
 * records the refusal; the caller answers 429 with PLATFORM_AT_CAPACITY.
 */
async function claimGlobalSlot({
  pool, config, path, userId = null, appId = null, excludeSessionId = null, discount = 0,
}) {
  const { countGlobalSessions } = require('./session-caps');
  const cap = config && config.maxGlobalSessions != null ? Number(config.maxGlobalSessions) : 100;
  if ((await countGlobalSessions(pool)) - discount < cap) return { ok: true };
  // Through the exports, as the routes called it before this gate existed,
  // so a test's stand-in applies here too.
  const { freed } = await module.exports.freeGlobalSlot({
    pool, graceMs: config && config.sessionPressureGraceMs, excludeSessionId,
  });
  if (freed) return { ok: true };
  await recordCapacityRefusal(pool, { cap: 'global', path, userId, appId });
  return { ok: false };
}

// Tear down a session's staging preview (container + cloned DB + Caddy
// route) WITHOUT changing the session's status. This is the staging GC
// path — pausing no longer does it, so a separate, longer-horizon
// sweeper reclaims staging from sessions that have gone cold. Nulls the
// staging_* columns so a repeat sweep treats it as already reclaimed and
// so a later /resume + push rebuilds fresh.
//
// Never call this for 'promoted'/'merging' sessions — their preview
// backs the group's PR vote. The sweeper query enforces that; this
// function just does the teardown it's told to.
async function teardownStagingForSession({ pool, sessionId, reason = 'idle' }) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug
     FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  const session = rows[0];
  if (!session || !(session.staging_runtime_name || session.staging_container_id)) return { torn: false };

  // #851: teardownStaging owns the nulling and now reports whether the
  // container actually went away. On a leak the row deliberately still names
  // the survivor so the stale-preview sweeper can retry through the same
  // chokepoint — so this must NOT null the columns behind its back (which is
  // exactly how ten production previews became untracked orphans) and must
  // not announce a teardown that didn't happen.
  const result = await staging.teardownStaging(session, { slug: session.app_slug })
    .catch((err) => {
      log.warn('session-lifecycle', 'Staging teardown threw', { sessionId, err: err.message });
      return { removed: false, leaked: true };
    });
  if (result && result.leaked) {
    log.warn('session-lifecycle', 'Staging GC left a container behind — link kept for retry', {
      sessionId, reason,
    });
    return { torn: false, leaked: true };
  }

  const { pushSessionUpdate } = require('./ws');
  pushSessionUpdate({ action: 'staging_torn_down', sessionId, appSlug: session.app_slug });
  log.info('session-lifecycle', 'Staging torn down (GC)', { sessionId, reason });
  return { torn: true };
}

// Archive a session. Reversible now: it tears down the live resources
// (staging + worker) and closes the PR, but KEEPS the CC volume + branch
// so /unarchive can restore it. The CC volume is only destroyed later by
// purgeArchivedCc once the retention window elapses (or immediately when
// purgeCc=true, for callers that want the old hard-delete).
//
// Params:
//   pool, sessionId
//   userId  - optional owner scope (HTTP authz). Omit for system actions.
//   reason  - 'manual' | 'stale-pr' | ... The Homeroom bot's own proposals
//             (#11, WP3) close with 'withdrawn' (asked for in its DM),
//             'superseded' (another proposal for the same request covers it)
//             or 'request-closed' (every request it was built for closed
//             another way: homeroom-bot-closed-requests.js).
//   purgeCc - destroy the CC volume immediately (skip retention). Default
//             false. The activeWorkers in-flight set (routes/sessions.js)
//             is cleared by the HTTP handler, not here.
// Returns { archived: boolean, appSlug?: string }.
async function archiveSession({ pool, sessionId, userId = null, reason = 'manual', purgeCc = false }) {
  const params = [sessionId];
  let ownerClause = '';
  if (userId != null) {
    params.push(userId);
    ownerClause = ' AND user_id = $2';
  }

  const { rows } = await pool.query(
    `UPDATE chat_sessions SET status = 'archived', archived_at = NOW()
     WHERE id = $1${ownerClause} AND status IN ('active', 'promoted', 'paused')
     RETURNING id`,
    params
  );
  if (!rows.length) return { archived: false };

  return finalizeArchivedSession({ pool, sessionId, userId, reason, purgeCc });
}

// Finish the reversible-archive side effects after the status transition.
// proposal_start uses this after atomically archiving a predecessor and
// inserting its successor in one transaction; ordinary archiveSession calls
// it immediately after its own guarded UPDATE. These operations are
// best-effort, so a process restart can leave only resources the existing
// staging/worker reapers already know how to collect.
async function finalizeArchivedSession({
  pool,
  sessionId,
  userId = null,
  reason = 'manual',
  purgeCc = false,
}) {

  // A work order is one ATTEMPT at an issue, and this is where the attempt
  // ends. It had a beginning (prepare) and two endings (submit, "Start over")
  // but none for "the session it belonged to is over", so dead attempts
  // leaked: each held one of the owner's ten open-work-order slots for the
  // full 14-day expiry, and they piled up into a backlog the launchpad then
  // tried to hand back out, one per new change. Best-effort like every side
  // effect here — an archive must not fail because a reservation could not be
  // closed, and the expiry still collects anything this misses.
  await externalAgentTasks.abandonTasksForSession(pool, sessionId)
    .then((closed) => {
      if (closed) {
        log.info('session-lifecycle', 'Work orders closed with the session', { sessionId, closed });
      }
    })
    .catch((err) => {
      log.warn('session-lifecycle', 'Failed to close work orders on archive', { sessionId, err: err.message });
    });

  // owner_username feeds the PR-withdrawn group-chat line (#200). The
  // manual archive endpoint is owner-scoped, so when userId is present
  // the session owner IS the actor. LEFT JOIN: a missing user row must
  // not block the archive — the message just falls back to actor-less.
  const { rows: sessionRows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug, a.repo_url, u.username AS owner_username
     FROM chat_sessions cs
     JOIN apps a ON cs.app_id = a.id
     LEFT JOIN users u ON u.id = cs.user_id
     WHERE cs.id = $1`,
    [sessionId]
  );
  const session = sessionRows[0];
  const appSlug = session?.app_slug;

  // #2779: a change an agent session started tells that conversation it is
  // closed, and stops being its active change. Best-effort, like everything
  // else here: the note never holds up the archive.
  if (session) {
    await require('./agent-sessions').noteChangeClosed(pool, {
      change: session,
      outcome: require('./agent-sessions').outcomeForArchiveReason(reason),
    });
  }

  if (session?.staging_runtime_name || session?.staging_container_id) {
    // Same contract as teardownStagingForSession above (#851): the chokepoint
    // nulls the columns itself once removal is CONFIRMED, and a leak keeps
    // them so the sweeper can retry. The archive itself proceeds regardless —
    // closing the PR and changing status must not hinge on docker.
    const result = await staging.teardownStaging(session, { slug: appSlug })
      .catch((err) => {
        log.warn('session-lifecycle', 'Staging teardown threw on archive', { sessionId, err: err.message });
        return { removed: false, leaked: true };
      });
    if (result && result.leaked) {
      log.warn('session-lifecycle', 'Archive left a staging container behind — link kept for retry', {
        sessionId, reason,
      });
    }
  }

  if (session?.pr_number) {
    const [owner, repo] = ownerRepo(session.repo_url);
    if (owner) await github.closePR(owner, repo, session.pr_number).catch((err) => {
      log.warn('session-lifecycle', 'Failed to close PR on archive', { sessionId, err: err.message });
    });

    // #200: say the withdrawal in the proposal's own thread, completing its
    // story (promote/merge already post there — a withdrawn PR otherwise
    // vanishes silently; a channel carries no activity, ws.sendSystemMessage).
    // Posted regardless of closePR's
    // outcome: the close is best-effort and the PR leaves the vote
    // panel either way. Own catch so a chat failure never fails the
    // archive itself.
    // Named by its title, in Homeroom's words: a change, never "PR #n".
    const label = session.pr_title ? `“${session.pr_title}”` : 'This change';
    // Rejection (auto-takedown) gets its own line so the lifecycle feed reads
    // correctly: the group voted it down rather than it just going quiet.
    const content = reason === 'auto-rejected'
      ? `${label} was set aside for now (more No than Yes, and not enough support to carry it).`
      : reason === 'proposal-replaced' && userId != null && session.owner_username
        ? `${session.owner_username} replaced ${session.pr_title ? label : 'this change'} with a new one.`
      : reason === 'superseded'
        ? `${label} was withdrawn: another change for the same request covers it.`
      : reason === 'request-closed'
        ? `${label} was withdrawn: the request it was built for is closed.`
      : reason === 'withdrawn'
        ? `${label} was withdrawn.`
      : userId != null && session.owner_username
        ? `${session.owner_username} withdrew ${session.pr_title ? label : 'this change'}.`
        : `${label} went quiet and was set aside. It can always come back as a new change.`;
    try {
      const { sendSystemMessage } = require('./ws');
      await sendSystemMessage(pool, session.app_id, content, 'system', null, { type: 'session', ref: session.id });
    } catch (err) {
      log.warn('session-lifecycle', 'Failed to post PR-withdrawn chat message', { sessionId, err: err.message });
    }
  }

  workerProgress.clear(sessionId);
  await worker.destroyWorker(worker.workerContainerName(sessionId)).catch(() => {});

  // A withdrawn / voted-down declaration proposal takes its held secret
  // value with it: the group didn't approve the change, so the value must
  // stop existing rather than sit around waiting for a PR that will never
  // merge (services/pending-secrets.js). This covers every abandonment
  // path, since they all funnel through archiveSession. Best-effort — the
  // panel also treats a row whose session left the live statuses as dead.
  await require('./pending-secrets').discardForSession(pool, sessionId)
    .catch((err) => log.warn('session-lifecycle', 'Pending-declaration discard failed', {
      sessionId, err: err.message,
    }));

  // Retention: keep the CC volume so /unarchive can restore conversation
  // memory. purgeArchivedCc (or purgeCc=true here) destroys it later.
  if (purgeCc) {
    await worker.destroyCcVolume(sessionId).catch(() => {});
    await pool.query(`UPDATE chat_sessions SET cc_purged = TRUE WHERE id = $1`, [sessionId]);
  }

  const { pushSessionUpdate, pushIssueUpdate } = require('./ws');
  pushSessionUpdate({ action: 'archived', sessionId, appSlug });
  // #8 (WP3): one of the Homeroom bot's proposals closed, by any of the
  // paths above: the activity tray of whoever asked for it reads again.
  // Never throws, and finds nobody for anybody else's session.
  await require('./homeroom-bot-dm').noteProposalChanged(pool, sessionId);
  // 5 October (Page Turners): a closed change asks nobody anything: its
  // "ready to try" rows, vote nudges and digests are settled
  // (notifications.settleDecidedChange). Best-effort like the rest.
  await require('./notifications').settleDecidedChange(pool, sessionId).catch((err) => {
    log.warn('session-lifecycle', 'Settling the bell for a closed change failed', { sessionId, err: err.message });
  });
  // Issues this session's dispatches declared lose their contribution to
  // the derived "In progress" chip the moment the row leaves the live
  // statuses — tell open Dev panels to refetch. This one hook covers every
  // abandonment path (manual withdraw, vote-down auto-takedown, stale-PR
  // sweeper): they all funnel through archiveSession.
  if (Array.isArray(session?.linked_issues) && session.linked_issues.length) {
    pushIssueUpdate({
      action: 'updated', source: 'session_archived',
      appSlug, appId: session.app_id,
    });
  }
  log.info('session-lifecycle', 'Session archived', { sessionId, reason, purgeCc });
  return { archived: true, appSlug };
}

// Reverse an archive (within the retention window). Restores the session
// to 'paused' — reopening it then goes through the normal auto-resume
// path. Best-effort reopens the PR; if that fails (branch gone, install
// restrictions), the session still has its branch + (unless purged) its
// CC memory, and the user can propose a fresh PR.
//
// Returns { unarchived: boolean, ccPurged?: boolean, prReopened?: boolean }.
async function unarchiveSession({ pool, sessionId, userId = null }) {
  const params = [sessionId];
  let ownerClause = '';
  if (userId != null) {
    params.push(userId);
    ownerClause = ' AND user_id = $2';
  }

  const { rows } = await pool.query(
    `UPDATE chat_sessions SET status = 'paused', archived_at = NULL
     WHERE id = $1${ownerClause} AND status = 'archived'
     RETURNING id`,
    params
  );
  if (!rows.length) return { unarchived: false };

  const { rows: sessionRows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug, a.repo_url
     FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  const session = sessionRows[0];

  let prReopened = false;
  if (session?.pr_number) {
    const [owner, repo] = ownerRepo(session.repo_url);
    if (owner) {
      try {
        await github.reopenPR(owner, repo, session.pr_number);
        prReopened = true;
      } catch (err) {
        log.warn('session-lifecycle', 'Could not reopen PR on unarchive (branch may need re-proposing)', { sessionId, err: err.message });
        // Self-heal: when GitHub definitively reports the PR
        // closed-unmerged, drop the dead reference (keep pr_title for
        // reuse) so the promote route's lazy PR creation mints a fresh
        // PR on the same branch. Carrying the closed pr_number forward
        // is what made a re-promoted proposal permanently unmergeable
        // (session 2398 / PR #26). A transient GET failure leaves the
        // row as-is — the promote-time reopen guard still catches it.
        try {
          const pr = await github.getPR(owner, repo, session.pr_number);
          if (pr && pr.state === 'closed' && !pr.merged) {
            await pool.query(
              `UPDATE chat_sessions SET pr_number = NULL, pr_url = NULL WHERE id = $1`,
              [sessionId]
            );
            log.info('session-lifecycle', 'Cleared closed-unmerged PR reference on unarchive', {
              sessionId, pr: session.pr_number,
            });
          }
        } catch (checkErr) {
          log.warn('session-lifecycle', 'PR state check on unarchive failed (leaving PR reference)', {
            sessionId, err: checkErr.message,
          });
        }
      }
    }
  }

  const { pushSessionUpdate, pushIssueUpdate } = require('./ws');
  pushSessionUpdate({ action: 'unarchived', sessionId, appSlug: session?.app_slug });
  // Mirror of the archive-time broadcast: a restored session's linked
  // issues regain their "In progress" chip on the next panel refetch.
  if (Array.isArray(session?.linked_issues) && session.linked_issues.length) {
    pushIssueUpdate({
      action: 'updated', source: 'session_unarchived',
      appSlug: session?.app_slug, appId: session?.app_id,
    });
  }
  log.info('session-lifecycle', 'Session unarchived', { sessionId, prReopened, ccPurged: !!session?.cc_purged });
  return { unarchived: true, ccPurged: !!session?.cc_purged, prReopened };
}

// Hard GC for the retention window: destroy the CC volume of an archived
// session so its conversation memory stops occupying disk. Idempotent —
// flips cc_purged so the sweeper won't revisit it. The row + branch
// survive; /unarchive still works but with fresh Claude memory.
async function purgeArchivedCc({ pool, sessionId }) {
  await worker.destroyCcVolume(sessionId).catch(() => {});
  await pool.query(`UPDATE chat_sessions SET cc_purged = TRUE WHERE id = $1`, [sessionId]);
  log.info('session-lifecycle', 'Archived CC volume purged (retention elapsed)', { sessionId });
  return { purged: true };
}


// ── Deferred branch creation (#1350) ────────────────────────────────────
//
// A native session no longer gets a git branch when it is created. Nothing
// is on the branch until an agent turn runs, and most created sessions
// never run one: the branch was an empty ref off main, plus a GitHub API
// call, minted for a session the owner might abandon on the start screen
// or hand straight over to an off-platform agent that pushes to its own
// fork. So the mint moved to the first thing that actually needs it.
//
// This helper is that mint, and it is the ONLY one on the deferred path.
// Three properties it has to have, because the callers below are a first
// chat turn, two worker-dispatch seams and the push proxy, any of which
// can be the first to arrive and two of which can arrive at once:
//
//   idempotent  - a session that already has a branch returns it untouched.
//   serialized  - SELECT ... FOR UPDATE holds the row for the whole mint,
//                 so two concurrent callers cannot mint two names for one
//                 session (the loser sees the winner's name on its read).
//   all-or-nothing - the name is persisted ONLY after GitHub has the ref.
//                 A stored branch_name whose ref does not exist is the one
//                 state the worker cannot survive: run-cc.sh dies on
//                 "branch missing upstream: origin/$BRANCH" for every
//                 build and sync turn, forever, with no way back.
//
// Off-platform venues (web-claude-code, web-codex, own-tools-pr) never run
// an on-platform turn, so they never reach any caller of this and never
// mint a branch at all. That is the second half of #1350, and it falls out
// of the deferral rather than needing its own switch.
//
// Params:
//   pool      - pg pool
//   sessionId - numeric session id
//   username  - optional; the branch's owner segment. Defaults to the
//               session owner's stored username.
//   label     - optional; words for what the session is about (#3229), the
//               first turn's deterministic title. Defaults to the session's
//               stored title, so a titled session (the bot's builds, a
//               dispatch backstop) is still named after its change.
//
// Returns { branchName, created }. Throws with `code` set when the session
// is gone ('no_session') or GitHub refused the ref ('branch_create_failed',
// carrying a userMessage safe to show in chat).
async function ensureSessionBranch({ pool, sessionId, username = null, label = null }) {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    const { rows } = await client.query(
      `SELECT cs.id, cs.branch_name, cs.user_id, cs.session_title, u.username, a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON a.id = cs.app_id
         LEFT JOIN users u ON u.id = cs.user_id
        WHERE cs.id = $1
        FOR UPDATE OF cs`,
      [sessionId]
    );
    const row = rows[0];
    if (!row) {
      await client.query('COMMIT');
      open = false;
      const err = new Error(`Session ${sessionId} not found`);
      err.code = 'no_session';
      throw err;
    }
    if (row.branch_name) {
      await client.query('COMMIT');
      open = false;
      return { branchName: row.branch_name, created: false };
    }

    const branchName = branchNames.devBranchName(
      username || row.username || `u${row.user_id}`, Date.now(), label || row.session_title || null,
    );
    const [owner, repo] = ownerRepo(row.repo_url);
    if (github.isEnabled() && owner && repo) {
      try {
        await github.createBranch(owner, repo, branchName);
      } catch (err) {
        await client.query('ROLLBACK');
        open = false;
        log.warn('session-lifecycle', 'Deferred branch creation failed', {
          sessionId, branch: branchName, err: err.message,
        });
        const wrapped = new Error(`Could not create branch ${branchName}: ${err.message}`);
        wrapped.code = 'branch_create_failed';
        wrapped.userMessage = 'Homeroom could not create this session\'s branch on GitHub. '
          + 'Send your message again in a moment. If it keeps failing, ask an admin to check '
          + 'the GitHub connection for this app.';
        throw wrapped;
      }
    }

    await client.query(`UPDATE chat_sessions SET branch_name = $2 WHERE id = $1`, [sessionId, branchName]);
    await client.query('COMMIT');
    open = false;
    log.info('session-lifecycle', 'Session branch created on first use', { sessionId, branch: branchName });
    return { branchName, created: true };
  } catch (err) {
    if (open) { try { await client.query('ROLLBACK'); } catch { /* already unwound */ } }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ensureSessionBranch,
  pauseSession,
  unpromoteSession,
  freeGlobalSlot,
  freeUserSlot,
  USER_SLOTS_BUSY,
  PLATFORM_AT_CAPACITY,
  recordCapacityRefusal,
  claimGlobalSlot,
  teardownStagingForSession,
  archiveSession,
  finalizeArchivedSession,
  unarchiveSession,
  purgeArchivedCc,
};
