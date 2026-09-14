'use strict';

// #2038 — the integration queue.
//
// One proposal per app is brought onto current main, checked against the
// merged tree, and merged. Everything else is left alone and simply measured.
//
// ── What this replaces ─────────────────────────────────────────────────
//
// services/conflict-resolver.js ran a two-phase drain: phase 1 merged
// anything directly mergeable, phase 2 ran worker syncs for the rest. The
// split existed because a blocked proposal's minutes-long sync ran INSIDE the
// single-flight drain and froze every clean sibling behind it. A queue where
// a blocked proposal leaves the queue does not have that failure, so the
// phases are gone.
//
// Two behaviours change, and both were bugs:
//
//   - The drain's candidate filter was the merge gate, so only proposals
//     already eligible to merge were ever touched. A proposal that drifted
//     before reaching threshold was synced by nobody, measured by nobody and
//     reconciled by nobody, while its card read "Behind main · N — syncing
//     automatically" (#2038 F2). MEASUREMENT is now separate and universal
//     (services/integration.js, driven by the sweep); only INTEGRATION —
//     which costs a worker turn and real tokens — is gated on eligibility,
//     and the card says so honestly instead of promising a sync.
//
//   - Checks in flight were QUEUED behind, not superseded. #1728 recorded
//     the cost: two syncs, two abandoned runs (one of them 490 checks in),
//     two ten-minute dead waits and three full runs for one proposal. The
//     supersede primitive already existed in services/preview-lifecycle.js;
//     it simply was not used here.
//
// ── How the line is worked ─────────────────────────────────────────────
//
// One candidate at a time, cheapest first (nextCandidate / effortOf), and a
// pass stops the moment what happens next arrives as its own trigger — a
// merge, a check run or a sync already in flight (passShouldStop). A sync
// whose machinery failed backs its candidate off instead of costing every
// pass the same timeout (noteSyncFailure), and each pass first retires any
// 'integrating' a dead process left behind (retireStaleIntegrating).
//
// ── What is NOT here any more ──────────────────────────────────────────
//
// pollMergeable and waitForMergeableTrue — up to fourteen GitHub reads and
// ~30 seconds of sleeping per cycle, spent asking a lazily-computed field
// whether a branch merges. The mirror answers that exactly, before the call.
// The exact-sha merge is still the real guard: if main moves between the
// measurement and the merge, GitHub refuses with a 409 and the queue comes
// back round. That was always the only guarantee; the polling just made the
// window narrower at considerable cost.

const log = require('./logger');
const github = require('./github');
const limits = require('./limits');
const integration = require('./integration');
const { runSyncMain } = require('./sync-main');
const { currentVotePredicateSql, reviewedHeadSql, sameSha } = require('./pr-vote-revision');
const { getPool } = require('../db/pool');

// App-level single-flight. Every trigger — a vote crossing threshold, a
// post-merge cascade, the drift poller, the eligible-merge sweep — funnels
// here, so concurrent triggers for one app coalesce into one sequential pass
// instead of N parallel worker syncs against the same main.
const _running = new Map(); // appId -> Promise
const _rekick = new Set();  // appId -> a trigger arrived mid-pass

/** True while this app is integrating something. Read by the status routes. */
function isIntegrating(appId) {
  return _running.has(appId);
}

/**
 * Ask the app's queue to make progress. Safe to call from anywhere, as often
 * as you like: a call while a pass is running flags a re-kick rather than
 * starting a second one.
 */
function enqueue(config, appId, options = {}) {
  if (appId == null) return Promise.resolve();
  if (_running.has(appId)) {
    _rekick.add(appId);
    return _running.get(appId);
  }
  const run = runQueue(config, appId, options)
    .catch((err) => log.error('merge-queue', 'queue pass threw', { appId, err: err.message }))
    .finally(() => {
      _running.delete(appId);
      if (_rekick.delete(appId)) {
        enqueue(config, appId).catch((err) => log.error('merge-queue', 're-kick failed', {
          appId, err: err.message,
        }));
      }
    });
  _running.set(appId, run);
  return run;
}

// The next proposal worth spending a worker turn on: promoted, eligible on
// votes, and not the one we just merged.
//
// Ordered by how little stands between it and a merge (effortOf, below);
// the vote tally and then waiting time break ties. Every candidate here is
// one the group has already approved, so the tally is a tie-break rather
// than the order. It WAS the order until the afternoon #2104 landed, when
// the line for the platform app read: a proposal that CONFLICTED with main
// (an AI resolution turn), then one whose worker could not mount its volume
// (a warm-ready timeout, every pass), and only then one that was two commits
// behind, merged clean and had passing checks on its pinned head. Each
// merge restarts the platform and puts every sibling one further behind, so
// the order the line is worked in decides how many syncs and rebuilds the
// whole board costs — not just who waits.
//
// Three things a sync cannot fix are filtered here rather than discovered
// after the worker turn has been spent. The first two used to reach
// checkAndMerge, which refused them at a gate the queue had no way to
// satisfy, and the pass then moved on to the next candidate and synced that
// one too:
//
//   - a locked app with no admin yes vote in the current epoch. The lock
//     gate is exactly the admin's say-so; integrating ahead of it spends
//     tokens on a change that may never merge, and the admin's vote itself
//     enqueues the app when it lands;
//   - checks that FAILED (or errored) against the commit currently pinned.
//     "They re-run on the next push" — the author has to act, and a merge of
//     main into a failing branch does not change that. A verdict about an
//     OLDER commit is not a reason to skip: the pinned head still needs its
//     rebuild, which the checks gate kicks;
//   - a sync turn that threw for it recently (noteSyncFailure). Infrastructure
//     that failed a minute ago has usually not been fixed since.
async function nextCandidate(pool, appId, { excludeId = 0, attempted = [] }) {
  const governance = require('./governance');
  const gov = await governance.getGovernance(pool, appId);
  const electorate = await governance.getElectorate(pool, appId, gov);

  const { rows } = await pool.query(
    `SELECT cs.id, cs.promoted_at, cs.created_at, cs.requires_explicit_approval,
            cs.integration_behind_by, cs.integration_merges_clean, cs.check_state,
            cs.checks_commit_sha,
            ${reviewedHeadSql('cs')} AS reviewed_head,
            a.locked AS app_locked,
            EXISTS (SELECT 1 FROM pr_votes pv
                      JOIN users u ON u.id = pv.user_id
                     WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                       AND ${currentVotePredicateSql('pv', 'cs')}
                       AND u.is_admin = TRUE AND u.admin_readonly = FALSE) AS admin_yes,
            (SELECT COUNT(*)::int FROM pr_votes pv
              WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                AND ${currentVotePredicateSql('pv', 'cs')}) AS yes_count,
            (SELECT COUNT(*)::int FROM pr_votes pv
              WHERE pv.session_id = cs.id AND pv.vote = 'no'
                AND ${currentVotePredicateSql('pv', 'cs')}) AS no_count
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
      WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.id <> $2
        AND NOT (cs.id = ANY($3::int[]))`,
    [appId, excludeId, attempted]
  );

  const qualified = electorate.approverIds
    ? await governance.qualifiedCountsBatch(pool, 'pr', rows.map((r) => r.id), electorate.approverIds)
    : null;

  const eligible = rows.filter((r) => {
    const q = qualified ? (qualified.get(r.id) || { yes: 0, no: 0 })
      : { yes: r.yes_count, no: r.no_count };
    if (!governance.computeGate(
      gov, electorate.active, q.yes, q.no, r.promoted_at || r.created_at, null,
      { explicitApproval: !!r.requires_explicit_approval }
    ).mergeable) return false;
    const blockedBy = unintegrableReason(r);
    if (blockedBy) {
      log.debug('merge-queue', 'candidate skipped: a sync cannot unblock it', {
        appId, sessionId: r.id, blockedBy,
      });
      return false;
    }
    return true;
  });

  const toMs = (v) => (v instanceof Date ? v.getTime()
    : typeof v === 'number' ? v : (Date.parse(v) || 0));

  eligible.sort((a, b) => compareEffort(effortOf(a), effortOf(b))
    || (b.yes_count - a.yes_count)
    || (toMs(a.promoted_at || a.created_at) - toMs(b.promoted_at || b.created_at)));

  return eligible[0] || null;
}

// What a candidate still costs before it can merge, from the columns the
// integration record and the checks already keep. Compared field by field,
// most decisive first:
//
//   conflict  0 merges clean · 1 never measured · 2 conflicts. A conflict is
//             an AI resolution turn, then a tree nobody has tested, so a
//             rebuild too — the most expensive thing the queue does.
//   rebuild   0 when a settled verdict stands on the pinned head, so a
//             mechanical sync carries it and the merge follows the sync
//             directly; 1 when the merged commit will need the full run
//             (the ~5 min of preview + browser checks + unit suite) first.
//   behind    the sync's size, 0 meaning no sync at all. Unmeasured sorts last.
//
// Ties fall through to the tally and then to age, as before.
function effortOf(row) {
  const behind = parseInt(row.integration_behind_by, 10);
  const settled = (row.check_state === 'passing' || row.check_state === 'skipped')
    && sameSha(row.checks_commit_sha, row.reviewed_head);
  return {
    conflict: row.integration_merges_clean === true ? 0
      : (row.integration_merges_clean == null ? 1 : 2),
    rebuild: settled ? 0 : 1,
    behind: Number.isFinite(behind) ? Math.max(0, behind) : Number.MAX_SAFE_INTEGER,
  };
}

function compareEffort(a, b) {
  return (a.conflict - b.conflict) || (a.rebuild - b.rebuild) || (a.behind - b.behind);
}

// ── Sync backoff ─────────────────────────────────────────────────────────
//
// A sync turn that THREW — the worker never came up, the push was refused,
// the mirror was unreadable — says nothing about the proposal; it says the
// machinery under it is broken right now. It is also the one refusal the
// pass used to pay for again on every trigger: #2102's worker could not
// mount its volume, so each pass sat through a warm-ready timeout (minutes)
// to rediscover that, with every sibling waiting in line behind it. A thrown
// sync now backs its candidate off — two minutes, doubling to a half-hour
// ceiling — and a candidate inside its window is skipped the way lock- and
// failing-blocked ones are, while the rest of the line moves.
//
// Deliberately in memory, per process. A restart is a fresh look, and on
// this platform a restart usually IS the rollout that fixed the machinery.
// A conflict verdict and a completed sync both clear the entry: those are
// answers about the proposal, not about the infrastructure.
const SYNC_BACKOFF_BASE_MS = 2 * 60 * 1000;
const SYNC_BACKOFF_MAX_MS = 30 * 60 * 1000;
const _syncBackoff = new Map(); // sessionId -> { until, failures, err }

function noteSyncFailure(sessionId, err, now = Date.now()) {
  const failures = ((_syncBackoff.get(sessionId) || {}).failures || 0) + 1;
  const wait = Math.min(SYNC_BACKOFF_MAX_MS, SYNC_BACKOFF_BASE_MS * (2 ** (failures - 1)));
  const entry = { until: now + wait, failures, err: (err && err.message) || String(err) };
  _syncBackoff.set(sessionId, entry);
  return entry;
}

// An expired entry stays until a sync completes: the failure count is what
// makes the next wait longer, and a candidate that fails every time it is
// retried should not start again from two minutes.
function syncBackoffRemaining(sessionId, now = Date.now()) {
  const entry = _syncBackoff.get(sessionId);
  return entry ? Math.max(0, entry.until - now) : 0;
}

// The worker's own guard against two turns in one container. Reaching it
// from the queue means a sync for this very proposal is already running —
// in practice one the process resumed from its journal after a restart, a
// few seconds before the startup drain asked for the same proposal. That
// is not a failure and not a reason to back off: the row IS integrating.
function isTurnInFlightError(err) {
  return !!err && (err.code === 'TURN_IN_FLIGHT'
    || /a turn is already in flight/.test(String(err.message || '')));
}

// The mode of the turn the worker is running for a session, from the durable
// record every dispatch writes (chat_sessions.active_turn) — 'sync', 'build',
// 'scout', …, or null when there is none to read. Never throws.
async function inFlightTurnMode(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT active_turn->>'mode' AS mode FROM chat_sessions WHERE id = $1`,
      [sessionId]
    );
    return (rows[0] && rows[0].mode) || null;
  } catch (err) {
    log.warn('merge-queue', 'active_turn read failed', { sessionId, err: err.message });
    return null;
  }
}

// Why a vote-eligible candidate is still not worth a worker turn, or null.
// `undefined` fields exist only in narrow unit-test rows that predate the
// selected columns; PostgreSQL returns null or a value for a real row.
function unintegrableReason(row) {
  if (row.app_locked === true && row.admin_yes === false) return 'lock';
  const verdictIsCurrent = row.checks_commit_sha !== undefined
    && row.reviewed_head !== undefined
    && sameSha(row.checks_commit_sha, row.reviewed_head);
  if ((row.check_state === 'failing' || row.check_state === 'error') && verdictIsCurrent) {
    return `checks_${row.check_state}`;
  }
  if (syncBackoffRemaining(row.id) > 0) return 'sync_backoff';
  return null;
}

async function loadSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.name AS app_name,
            a.self_hosted AS app_self_hosted
       FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
      WHERE cs.id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

// Outcomes after which the pass has nothing useful left to do, because what
// happens next arrives as its own trigger:
//
//   merged      — main just moved, so every other candidate's measurement is
//                 now stale and a sync for it would be the SECOND sync it
//                 needs. finalizeMerge re-kicks the queue (excluding the
//                 merged row), and that fresh pass measures against the new
//                 main. Carrying on here was the "thundering herd" of #2100:
//                 one merge, then every sibling synced and rebuilt in a row,
//                 each to be synced and rebuilt again once the next one landed.
//   checks      — a run is in flight for the current pin. Nothing merges
//                 before it reports, and visuals.maybeAutoMergeAfterChecks
//                 enqueues the app the moment it does. Syncing the next
//                 candidate meanwhile would only put it behind whatever this
//                 one merges.
//   in_progress — another caller holds the merge claim; its finalizer
//                 cascades.
//
// Everything else — a conflict only the author can fix, checks that failed,
// a lock with no admin yes, an epoch that moved under the vote, a budget cap
// — leaves the candidate and lets the next one be tried, as before.
function passShouldStop(outcome) {
  if (!outcome) return false;
  if (outcome.reason === 'merged' || outcome.reason === 'in_progress') return true;
  return outcome.reason === 'checks' && outcome.waiting === true;
}

// 'integrating' is the one block reason the server records rather than the
// card derives, and it is only ever true of a sync some pass of THIS process
// is running. A process that dies mid-pass leaves the word behind on the row
// it was working on, and there is no pass left to take it back: after the
// three platform restarts that followed #2104, six cards read "bringing up
// to date with main" with one sync actually running, and stayed that way
// until each row happened to get a turn. So every pass starts by retiring
// the claim from any promoted row of the app that no live sync can account
// for.
//
// Two things vouch for a live sync. `_inFlight` is this process's own
// integrateOne, which set the flag moments ago and may not have dispatched
// the worker yet. `active_turn` is the worker's durable turn record, which
// every dispatch writes and a restart resumes from (server.js
// resumeDetachedTurn): a row whose durable turn is a sync is one the
// previous process was syncing when it died and this one is about to pick
// back up — or has already. That row keeps its flag; the resumed turn's
// completion hands it back to the queue, which clears it then.
async function retireStaleIntegrating(pool, appId) {
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT id, integration_block_reasons
         FROM chat_sessions
        WHERE app_id = $1 AND status = 'promoted'
          AND integration_block_reasons @> '["integrating"]'::jsonb
          AND COALESCE(active_turn->>'mode', '') <> 'sync'`,
      [appId]
    ));
  } catch (err) {
    log.warn('merge-queue', 'stale-integrating scan failed', { appId, err: err.message });
    return;
  }
  for (const row of rows) {
    if (_inFlight.has(row.id)) continue;
    const kept = (Array.isArray(row.integration_block_reasons) ? row.integration_block_reasons : [])
      .filter((r) => r !== 'integrating');
    log.info('merge-queue', "retiring an 'integrating' no live sync accounts for", {
      appId, sessionId: row.id,
    });
    await integration.setBlockReasons(pool, row.id, kept);
    broadcast({ id: row.id, app_id: appId }, { integrating: false });
  }
}

async function runQueue(config, appId, { excludeSessionId = 0 } = {}) {
  const pool = getPool(config);
  const attempted = [];
  const seen = new Set();

  await retireStaleIntegrating(pool, appId);

  // Termination is belt AND braces. The candidate query excludes what has
  // already been attempted, but this loop runs unattended in a background
  // service: if that exclusion ever stopped working — a query edit, a
  // parameter-type surprise — the pass would spin forever dispatching worker
  // turns. So the JS side refuses a repeat too, and an absolute cap bounds
  // the pass no matter what. An app cannot have more eligible proposals than
  // it has proposals.
  const MAX_PASSES = 50;
  for (let i = 0; i < MAX_PASSES; i++) {
    _rekick.delete(appId);
    const candidate = await nextCandidate(pool, appId, {
      excludeId: excludeSessionId, attempted,
    });
    if (!candidate) {
      if (_rekick.has(appId)) continue;
      return;
    }
    if (seen.has(candidate.id)) {
      log.warn('merge-queue', 'candidate query returned an already-attempted proposal; stopping', {
        appId, sessionId: candidate.id,
      });
      return;
    }
    seen.add(candidate.id);
    attempted.push(candidate.id);
    let outcome = null;
    try {
      outcome = await integrateOne(config, pool, candidate.id);
    } catch (err) {
      log.error('merge-queue', 'integrateOne threw', { sessionId: candidate.id, err: err.message });
    }
    if (passShouldStop(outcome)) {
      log.info('merge-queue', 'pass complete; the next step arrives as its own trigger', {
        appId, sessionId: candidate.id, reason: outcome.reason,
      });
      return;
    }
  }
  log.warn('merge-queue', 'queue pass hit its iteration cap', { appId, attempted: attempted.length });
}

// Per-session coalescing: a vote and a sweep can name the same proposal at
// once, and two concurrent syncs for one session hit the worker's
// "a turn is already in flight" guard.
const _inFlight = new Map();

function integrateOne(config, pool, sessionId) {
  const existing = _inFlight.get(sessionId);
  if (existing) return existing;
  const p = integrateOneInner(config, pool, sessionId)
    .finally(() => { _inFlight.delete(sessionId); });
  _inFlight.set(sessionId, p);
  return p;
}

/** True while this proposal is being integrated. Read by the status routes. */
function isIntegratingSession(sessionId) {
  return _inFlight.has(sessionId);
}

async function integrateOneInner(config, pool, sessionId) {
  const session = await loadSession(pool, sessionId);
  if (!session || session.status !== 'promoted') return { ok: false, reason: 'not_promoted' };
  if (!github.isEnabled() || !session.repo_url || !session.pr_number) {
    return { ok: false, reason: 'github_disabled_or_no_pr' };
  }

  const { checkAndMerge } = require('../routes/votes');

  // Measure first, from the mirror. No GitHub call, no polling window, and
  // the answer is exact rather than a field GitHub may still be computing.
  const measured = await integration.measureDeduped({ pool, session }, { force: true });

  const needsIntegration = (measured.behindBy || 0) > 0 || measured.mergesClean === false;
  if (!needsIntegration) {
    // Already on main and clean: the only thing between it and a merge is
    // the rest of the gate, so go straight there.
    return runMerge(config, pool, session, checkAndMerge);
  }

  // A worker sync is platform housekeeping, billed to the system budget
  // rather than to whoever voted last.
  const budget = await limits.checkSystemBudget(pool);
  if (budget.error) {
    await integration.setBlockReasons(pool, session.id, ['budget']);
    log.info('merge-queue', 'Skipped: system token budget exhausted', { sessionId });
    return { ok: false, reason: 'over_budget' };
  }

  await integration.setBlockReasons(pool, session.id, ['integrating']);
  broadcast(session, { integrating: true });

  // #1728: supersede any check run in flight before moving the branch under
  // it. The run that is going tested the PRE-merge commit, and its verdict
  // is keyed to the commit it started on, so letting it finish writes a
  // verdict nowhere and leaves the row 'pending' until the stale sweeper
  // notices ten minutes later.
  try {
    const previewLifecycle = require('./preview-lifecycle');
    if (typeof previewLifecycle.cancelled === 'function') {
      previewLifecycle.cancelled(session.id, 'superseded by integration');
    }
  } catch (err) {
    log.debug('merge-queue', 'no in-flight check run to supersede', { sessionId, err: err.message });
  }

  let sync;
  try {
    sync = await runSyncMain(config, pool, session.id, {
      sessionRow: session, trigger: 'merge_queue',
    });
  } catch (err) {
    if (isTurnInFlightError(err)) {
      // The worker is already running a turn for this session. Which kind
      // decides what the refusal means, and the durable turn record says.
      const mode = await inFlightTurnMode(pool, session.id);
      if (mode === 'sync') {
        // A sync for this proposal is already running — the one this process
        // resumed from its journal after the restart, typically. The row is
        // integrating, so the flag stands; and the pass stops here, as it
        // does for a check run in flight: the resumed turn's completion
        // hands the proposal back to the queue (server.js
        // resumeDetachedTurn), which is when the merge attempt belongs.
        // Before this it was logged as a failure, the flag was cleared under
        // a live sync, and the pass moved on to sync the next sibling.
        log.info('merge-queue', 'a sync is already in flight for this proposal; waiting for it', {
          sessionId,
        });
        return { ok: true, reason: 'in_progress' };
      }
      // Someone is working on the branch in its dev chat. Not integrating,
      // not broken: the row goes back to how it was and the line moves on.
      // The push that turn ends with re-measures and re-checks the proposal
      // and brings it back round on its own.
      log.info('merge-queue', 'a turn is in flight for this session; leaving it to finish', {
        sessionId, mode: mode || 'unknown',
      });
      await integration.setBlockReasons(pool, session.id, []);
      broadcast(session, { integrating: false });
      return { ok: false, reason: 'turn_in_flight' };
    }
    const backoff = noteSyncFailure(session.id, err);
    log.error('merge-queue', 'sync turn threw', {
      sessionId, err: err.message,
      failures: backoff.failures, retryAfterMs: backoff.until - Date.now(),
    });
    await integration.setBlockReasons(pool, session.id, []);
    broadcast(session, { integrating: false });
    return { ok: false, reason: 'sync_threw' };
  }
  // The turn ran to an answer about the proposal; the machinery works.
  _syncBackoff.delete(session.id);

  if (sync.syncResult === 'conflict') {
    // The worker could not resolve it. This proposal leaves the queue: it
    // needs a person, and holding the app's queue open for it would block
    // every sibling behind something only its author can fix.
    const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
    await postGroup(pool, session,
      `PR #${session.pr_number} could not be brought up to date with main automatically. `
      + `${owner}: open the session's dev-chat to resolve it.`);
    // The queue is done with it; the card derives the conflict itself from
    // merge_conflict_state, which the sync turn just wrote.
    await integration.setBlockReasons(pool, session.id, []);
    broadcast(session, { integrating: false });
    return { ok: false, reason: 'unresolved_conflict' };
  }

  // The integrating phase is over on EVERY path from here, whatever the merge
  // attempt decides. 'integrating' is the one block reason the server owns
  // (the card derives the rest), and checkAndMerge only clears it on a
  // successful claim — so a row whose merge then stopped at approvals, the
  // lock or a pending check kept a card that said "syncing with main" long
  // after the sync had finished (#2100's "the UI is not matching up").
  await integration.setBlockReasons(pool, session.id, []);

  // Re-read: the sync moved the head, and the reconciliation inside
  // checkAndMerge needs the current row.
  const fresh = await loadSession(pool, session.id);
  if (!fresh || fresh.status !== 'promoted') {
    broadcast(session, { integrating: false });
    return { ok: true, reason: 'no_longer_promoted' };
  }
  // measure() carries the row's recorded reasons forward unless told
  // otherwise, and a row read a moment ago may still say 'integrating'.
  await integration.measureDeduped(
    { pool, session: fresh }, { force: true, blockReasons: [] }
  ).catch(() => {});
  broadcast(fresh, { integrating: false });

  return runMerge(config, pool, fresh, checkAndMerge);
}

async function runMerge(config, pool, session, checkAndMerge) {
  let result;
  try {
    // autoResolve:false so a merge that fails here cannot re-enter the queue
    // from inside the queue. One integrate-and-merge cycle per pass.
    result = await checkAndMerge(config, pool, session, { autoResolve: false });
  } catch (err) {
    log.error('merge-queue', 'checkAndMerge threw', { sessionId: session.id, err: err.message });
    return { ok: false, reason: 'merge_threw' };
  }
  if (result?.merged) {
    try {
      const { pushVoteUpdate } = require('./ws');
      pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: true });
    } catch (_) { /* ws non-fatal */ }
    return { ok: true, reason: 'merged' };
  }
  if (result?.inProgress) return { ok: true, reason: 'in_progress' };
  // Not merged. The block reason is already recorded on the integration
  // record by the gate that refused, so there is nothing to announce here —
  // the old code posted a vote tally at this point even when the blocker was
  // the checks, which is #2038's F5. `waiting` tells the pass whether the
  // blocker resolves on its own (a run in flight) or needs a person.
  const reason = result?.blockReason || 'blocked';
  const waiting = reason === 'checks'
    && result.checkState !== 'failing' && result.checkState !== 'error';
  return { ok: true, reason, waiting, checkState: result?.checkState };
}

function broadcast(session, extra) {
  try {
    const { pushVoteUpdate } = require('./ws');
    pushVoteUpdate({
      sessionId: session.id,
      appSlug: session.app_slug || null,
      // The scan in retireStaleIntegrating has the app id, not its slug;
      // the scoped broadcast accepts either.
      ...(session.app_id != null && !session.app_slug ? { appId: session.app_id } : {}),
      merged: false,
      ...extra,
    });
  } catch (_) { /* ws non-fatal */ }
}

async function postGroup(pool, session, content) {
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(pool, session.app_id, content, 'conflict');
  } catch (err) {
    log.warn('merge-queue', 'group message failed', { sessionId: session?.id, err: err.message });
  }
}

module.exports = {
  enqueue,
  isIntegrating,
  isIntegratingSession,
  // The old name, so the dozen callers across server.js, visuals.js,
  // votes.js and main-drift-poller.js keep working. `trigger.app_id` and
  // `trigger.excludeSessionId` are the only fields any of them set.
  checkAndResolveConflicts(config, trigger) {
    return enqueue(config, trigger && trigger.app_id, {
      excludeSessionId: trigger && (trigger.excludeSessionId != null
        ? trigger.excludeSessionId : (trigger.id || 0)),
    });
  },
  // The ordering and the backoff, for the tests that pin them.
  effortOf,
  compareEffort,
  noteSyncFailure,
  syncBackoffRemaining,
  _syncBackoff,
};
