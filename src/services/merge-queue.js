'use strict';

// The integration queue — direct-merge lanes.
//
// ── What this replaces ─────────────────────────────────────────────────
//
// #2038's queue brought ONE approved proposal per app onto current main (a
// worker sync), re-checked the merged tree (a rebuild and a full run), then
// merged it — and stopped, because the merge had just put every sibling one
// further behind, each of which then needed its own sync and its own re-run
// before it could go. Ten clean, approved, passing proposals cost ten worker
// turns and ten full check runs, strictly in series, and the board watched
// "bringing up to date with main" walk down the line. That was correct and it
// was slow, and its slowness was structural: a proposal was never merged as
// the group had reviewed it, only as the platform had re-made it.
//
// ── The two lanes ──────────────────────────────────────────────────────
//
// A proposal that MERGES CLEANLY with main merges as it stands. GitHub
// produces the same merge commit the sync would have pushed, so the sync is
// pure cost; and its checks judged its own head against the main of the
// time, which is the thing the group approved. Being behind main is not a
// reason to do anything. (The one exception is a preview that will not
// start, which gives no verdict to judge it on: services/boot-failure-sync.js
// syncs that proposal itself.) The DIRECT LANE merges every approved, clean
// candidate in a pass, one exact-sha GitHub call each and no worker turn:
// checkAndMerge re-measures each head at its integration gate, so a sibling
// landing a moment earlier is noticed there (a fresh merge-tree, not a stale
// column), and GitHub's own refusal is the last guard behind that.
//
// A proposal that CONFLICTS with main cannot merge as it stands, and that is
// the only thing that still costs a worker turn: an AI resolution that
// pushes a new head, which comes back through the pipeline on its own
// (measured, previewed, checked, merged direct). The CONFLICT LANE works one
// at a time, cheapest first, and holds while the direct lane has work in
// flight — a resolution made against a main that is about to move is a
// resolution made twice.
//
// Who gets a resolution — rule C:
//
//   - approved and merges-blocked only by the conflict: now, front of the
//     lane. The group has said yes; the platform's job is to land it.
//   - not yet approved, first conflict of this authored head: now, once.
//     Voters should review a head that can merge, with a real preview and
//     (once clean) a real verdict. "This authored head" is the approval
//     epoch (integration.markResolutionSpent): the author's next push is a
//     new head with its own one chance.
//   - not yet approved, conflicting again: waits for the vote. The card
//     says so ('awaiting_approval').
//   - a head the platform cannot push to (the author's fork), or one the
//     AI already failed to resolve against this very main: the author has
//     to update it ('fork_head' / 'unresolvable'). No turn is spent.
//
// ── The safety net ─────────────────────────────────────────────────────
//
// Every direct merge lands a tree that nobody ran the checks against as a
// whole. services/main-watch.js runs the repo's unit suite on each merge
// commit; red pauses the app's merges (checkAndMerge's main_healthy gate)
// until a fix lands or an admin resumes them. That is where the
// re-check-after-sync went, and it runs once per merge instead of once per
// sibling per merge.
//
// ── What is NOT here ───────────────────────────────────────────────────
//
// pollMergeable / waitForMergeableTrue (GitHub's lazily-computed field,
// asked up to fourteen times per cycle — the mirror answers exactly), the
// two-phase drain of services/conflict-resolver.js, and the sync-then-merge
// step itself. The exact-sha merge remains the real guard: if main moves
// between the measurement and the merge, GitHub refuses with a 409 and the
// row comes back round measured against the new main.

const log = require('./logger');
const github = require('./github');
const limits = require('./limits');
const integration = require('./integration');
const { runSyncMain } = require('./sync-main');
const { currentVotePredicateSql, countedVotePredicateSql, reviewedHeadSql, sameSha } = require('./pr-vote-revision');
const { firstVersionSql } = require('./first-version-rule');
const { getPool } = require('../db/pool');
const lifecycle = require('./lifecycle');
const inflightWork = require('./inflight-work');
const processes = require('./processes');
const { MERGE_QUEUE_PASS_LOCK } = require('./advisory-locks');

// App-level single-flight. Every trigger — a vote crossing threshold, a
// post-merge cascade, the drift poller, the eligible-merge sweep — funnels
// here, so concurrent triggers for one app coalesce into one sequential pass
// instead of N parallel passes against the same main.
//
// Across processes too (docs/plans/web-and-conductor.md): a vote lands on a
// web process, and the sweep and the drift poller run on the conductor. A
// pass holds MERGE_QUEUE_PASS_LOCK for its app (claimPass), and is held in
// the process registry ('merge_pass') so every process can see it. A trigger
// that finds the app's pass running in another process asks that process,
// over the bus ('merge_kick'), to run again once it is done, exactly as a
// trigger arriving mid-pass in the same process does.
const _running = processes.heldMap('merge_pass'); // appId -> Promise
const _rekick = new Set();  // appId -> a trigger arrived mid-pass
// The config the last pass ran with, for a re-kick that arrives over the bus.
let _config = null;

/** True while this app's queue is running a pass, in any process. Read by the status routes. */
function isIntegrating(appId) {
  return _running.has(appId) || processes.heldElsewhere('merge_pass', appId);
}

// The app's pass lock, on a client of its own for as long as the pass runs.
// Resolves { release } when this process may run the pass, or null when
// another one holds it. A pool with no clients to give (a test's stub) or a
// lock the database will not answer runs the pass anyway: two passes is
// what happened before, and the merge claim stays the guard.
async function claimPass(config, appId) {
  const open = { release: async () => {} };
  const pool = getPool(config);
  if (!pool || typeof pool.connect !== 'function') return open;
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    log.warn('merge-queue', 'Could not take a client for the pass lock; running without it', { appId, err: err.message });
    return open;
  }
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [MERGE_QUEUE_PASS_LOCK, Number(appId)]);
    if (!rows[0] || !rows[0].ok) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    log.warn('merge-queue', 'Could not take the pass lock; running without it', { appId, err: err.message });
    return open;
  }
  return {
    async release() {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [MERGE_QUEUE_PASS_LOCK, Number(appId)]);
        client.release();
      } catch (err) {
        // The connection goes, and the lock with it.
        client.release(err);
      }
    },
  };
}

// Ask over the bus for one more pass of this app: `to` the processes named
// (the holder, from the registry's copy, when the pass runs elsewhere), or
// ['*'], anyone serving (a process shutting down hands on its re-kick).
function kick(appId, to) {
  try {
    require('./ws-bus').publish('merge_kick', null, { appId: Number(appId), to });
  } catch (err) {
    log.warn('merge-queue', 'Could not ask another process for a pass', { appId, err: err.message });
  }
}

function kickElsewhere(appId) {
  kick(appId, processes.heldElsewhereBy('merge_pass', appId));
}

/**
 * A pass another process asked for (kick), over the bus. A pass under way
 * here runs again when it ends. One that is not running here runs now only
 * where it was asked of this process by name (its pass ended between the
 * two) or of anyone serving: never on a kick that names nobody, which every
 * process unsure who holds the pass would otherwise answer by asking the
 * others in turn. A pass lost that way is the eligible-merge sweep's.
 */
function receiveKick({ appId, to } = {}) {
  const id = Number(appId);
  if (!Number.isInteger(id) || id <= 0) return;
  if (_running.has(id)) { _rekick.add(id); return; }
  const list = Array.isArray(to) ? to : [];
  if (!list.includes(processes.ID) && !list.includes('*')) return;
  if (!_config || lifecycle.isShuttingDown()) return;
  enqueue(_config, id).catch((err) => log.error('merge-queue', 'kicked pass failed', { appId: id, err: err.message }));
}

/**
 * Ask the app's queue to make progress. Safe to call from anywhere, as often
 * as you like: a call while a pass is running flags a re-kick rather than
 * starting a second one, and the re-kick runs a fresh pass once this one ends.
 *
 * Each pass is held in services/inflight-work.js, so a shutdown's drain lets
 * a merge under way finish instead of exiting from under it, whichever
 * trigger started it (most answer their request first and never await it).
 * A re-kick once shutdown has begun is handed to a process serving (kick,
 * ['*']); if none takes it, the next leader's reconcile and the
 * eligible-merge sweep drain every app with open proposals.
 */
function enqueue(config, appId, options = {}) {
  if (appId == null) return Promise.resolve();
  if (config) _config = config;
  if (_running.has(appId)) {
    _rekick.add(appId);
    return _running.get(appId);
  }
  const run = (async () => {
    const lock = await claimPass(config, appId);
    if (!lock) {
      // Another process runs this app's pass: it runs again for this
      // trigger, and for any that came here while the lock was asked for.
      _rekick.delete(appId);
      kickElsewhere(appId);
      return;
    }
    try {
      await runQueue(config, appId, options);
    } finally {
      await lock.release();
    }
  })()
    .catch((err) => log.error('merge-queue', 'queue pass threw', { appId, err: err.message }))
    .finally(() => {
      _running.delete(appId);
      if (!_rekick.delete(appId)) return;
      if (lifecycle.isShuttingDown()) {
        // A release replaced this process: a process serving runs it.
        kick(appId, ['*']);
        return;
      }
      enqueue(config, appId).catch((err) => log.error('merge-queue', 're-kick failed', {
        appId, err: err.message,
      }));
    });
  _running.set(appId, run);
  return inflightWork.track('merge-queue', run);
}

// ── The line ─────────────────────────────────────────────────────────────

// Every promoted proposal of the app, with what the two lanes need to know
// about it: whether the group has approved it (`approved`, from the
// governance gate), where it stands against main (the integration columns),
// where its verdict stands (the checks columns), and the rule-C bookkeeping
// (approval_epoch / integration_resolved_epoch). One query per pass.
async function loadLine(pool, appId, { excludeId = 0 } = {}) {
  const governance = require('./governance');
  const gov = await governance.getGovernance(pool, appId);
  const electorate = await governance.getElectorate(pool, appId, gov);

  const { rows } = await pool.query(
    `SELECT cs.id, cs.user_id, cs.source, cs.promoted_at, cs.created_at,
            cs.requires_explicit_approval, cs.explicit_approval_reason, cs.approval_epoch, cs.integration_resolved_epoch,
            cs.integration_behind_by, cs.integration_merges_clean, cs.integration_conflict_paths,
            cs.integration_head_sha, cs.integration_main_sha, cs.integration_block_reasons,
            cs.check_state, cs.check_phase, cs.checks_commit_sha, cs.checks_checked_at,
            cs.branch_name, cs.imported_pr_head_repo,
            ${reviewedHeadSql('cs')} AS reviewed_head,
            a.locked AS app_locked, a.repo_url,
            EXISTS (SELECT 1 FROM pr_votes pv
                      JOIN users u ON u.id = pv.user_id
                     WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                       AND ${currentVotePredicateSql('pv', 'cs')}
                       AND u.is_admin = TRUE AND u.admin_readonly = FALSE) AS admin_yes,
            (SELECT COUNT(*)::int FROM pr_votes pv
              WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                AND ${countedVotePredicateSql('pv', 'cs')}) AS yes_count,
            (SELECT COUNT(*)::int FROM pr_votes pv
              WHERE pv.session_id = cs.id AND pv.vote = 'no'
                AND ${countedVotePredicateSql('pv', 'cs')}) AS no_count,
            -- The member floor (services/governance.js applyNoTimerMerge):
            -- a flagged proposal is approved only once someone other than
            -- its author has said Yes.
            CASE WHEN cs.requires_explicit_approval THEN
              (SELECT COUNT(*)::int FROM pr_votes pv
                WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                  AND pv.user_id IS DISTINCT FROM cs.user_id
                  AND ${countedVotePredicateSql('pv', 'cs')})
            END AS other_yes_count,
            -- 13 Oct 2026, D1: a project's first version goes live without
            -- a vote (governance-gate.ts applyFirstVersion).
            ${firstVersionSql('cs')} AS first_version
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
      WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.id <> $2`,
    [appId, excludeId]
  );

  const qualified = electorate.approverIds
    ? await governance.qualifiedCountsBatch(pool, 'pr', rows.map((r) => r.id), electorate.approverIds)
    : null;
  const memberCount = rows.some((r) => r.requires_explicit_approval)
    ? await governance.communityMemberCount(pool, appId)
    : undefined;
  // #4666: a project with rules needs who voted, not how many: the
  // creator's yes and a group's count are answers the tallies cannot give.
  const rulesCtx = gov.rules ? await governance.rulesContext(pool, appId, gov, 'pr', rows.map((r) => r.id)) : null;

  return rows.map((r) => {
    const q = qualified ? (qualified.get(r.id) || { yes: 0, no: 0, otherYes: 0 })
      : { yes: r.yes_count, no: r.no_count, otherYes: r.other_yes_count };
    const approved = !!governance.computeGate(
      gov, electorate.active, q.yes, q.no, r.promoted_at || r.created_at, null,
      {
        explicitApproval: !!r.requires_explicit_approval, otherYes: q.otherYes, memberCount,
        ...(rulesCtx ? governance.rulesGateOpts(rulesCtx, r.id, r.user_id, r.explicit_approval_reason || null) : {}),
        firstVersion: r.first_version === true,
      }
    ).mergeable;
    return { ...r, approved };
  });
}

const toMs = (v) => (v instanceof Date ? v.getTime()
  : typeof v === 'number' ? v : (Date.parse(v) || 0));

// Ties within a lane: the group's stronger preference, then the longer wait.
function compareTally(a, b) {
  return (b.yes_count - a.yes_count)
    || (toMs(a.promoted_at || a.created_at) - toMs(b.promoted_at || b.created_at));
}

// What a candidate still costs before it can merge, from the columns the
// integration record and the checks already keep. Compared field by field,
// most decisive first:
//
//   conflict  0 merges clean · 1 never measured · 2 conflicts. A conflict is
//             an AI resolution turn, then a new head that is previewed and
//             checked from scratch — the most expensive thing the queue does.
//   rebuild   0 when a settled verdict stands on the pinned head, so the
//             merge can follow at once; 1 when the head still needs its run
//             (the ~5 min of preview + browser checks + unit suite) first.
//   paths     the size of the conflict, for the conflict lane's order.
//
// Being behind main costs nothing any more and is not a field.
function effortOf(row) {
  const settled = (row.check_state === 'passing' || row.check_state === 'skipped')
    && sameSha(row.checks_commit_sha, row.reviewed_head);
  const paths = Array.isArray(row.integration_conflict_paths) ? row.integration_conflict_paths.length : 0;
  return {
    conflict: row.integration_merges_clean === true ? 0
      : (row.integration_merges_clean == null ? 1 : 2),
    rebuild: settled ? 0 : 1,
    paths: row.integration_merges_clean === false ? paths : 0,
  };
}

function compareEffort(a, b) {
  return (a.conflict - b.conflict) || (a.rebuild - b.rebuild) || (a.paths - b.paths);
}

// ── Sync backoff ─────────────────────────────────────────────────────────
//
// A sync turn that THREW — the worker never came up, the push was refused,
// the mirror was unreadable — says nothing about the proposal; it says the
// machinery under it is broken right now. It is also the one refusal the
// pass used to pay for again on every trigger: #2102's worker could not
// mount its volume, so each pass sat through a warm-ready timeout (minutes)
// to rediscover that, with every sibling waiting in line behind it. A thrown
// sync backs its candidate off — two minutes, doubling to a half-hour
// ceiling — and a candidate inside its window is skipped while the rest of
// the line moves.
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

// ── "The AI could not resolve it" ────────────────────────────────────────
//
// A resolution turn that ran to a CONFLICT answer — Claude tried and could
// not — is an answer about this head against this main, and the same
// question asked again gets the same answer at the same price. Remembered
// per (head, main) pair so that either moving makes it a new question: the
// author pushing, or a sibling landing that changes what the conflict is.
// In memory like the backoff, and for the same reason.
const _gaveUp = new Map(); // sessionId -> { head, main }

function noteResolutionGaveUp(sessionId, head, main) {
  if (!sessionId || !head) return;
  _gaveUp.set(sessionId, { head: String(head).toLowerCase(), main: main ? String(main).toLowerCase() : null });
}

function gaveUpOn(row) {
  const entry = _gaveUp.get(row.id);
  if (!entry) return false;
  const head = row.integration_head_sha ? String(row.integration_head_sha).toLowerCase() : null;
  const main = row.integration_main_sha ? String(row.integration_main_sha).toLowerCase() : null;
  return !!head && entry.head === head && (entry.main == null || main == null || entry.main === main);
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

// ── Admission ────────────────────────────────────────────────────────────

// Why an approved candidate is not worth a merge attempt, or null. Both are
// things only a person can change, and their action enqueues the app:
//
//   - a locked app with no admin yes vote in the current epoch. The lock
//     gate is exactly the admin's say-so; the admin's vote itself enqueues
//     the app when it lands;
//   - checks that FAILED (or errored) against the commit currently pinned.
//     "They re-run on the next push" — the author has to act. A verdict
//     about an OLDER commit is not a reason to skip: the pinned head still
//     needs its run, which the checks gate kicks.
//
// `undefined` fields exist only in narrow unit-test rows that predate the
// selected columns; PostgreSQL returns null or a value for a real row.
function unmergeableReason(row) {
  if (row.app_locked === true && row.admin_yes === false) return 'lock';
  const verdictIsCurrent = row.checks_commit_sha !== undefined
    && row.reviewed_head !== undefined
    && sameSha(row.checks_commit_sha, row.reviewed_head);
  if ((row.check_state === 'failing' || row.check_state === 'error') && verdictIsCurrent) {
    return `checks_${row.check_state}`;
  }
  return null;
}

// Is a head one the platform can push a resolution to? An imported proposal
// whose head lives on the author's fork is not: the resolution has nowhere
// to go, and the author is the only one who can update it.
function headIsPushable(row) {
  try {
    return require('./proposal-update').branchHomeOf(row) !== 'user_fork';
  } catch (err) {
    log.warn('merge-queue', 'branch home lookup failed; assuming pushable', {
      sessionId: row && row.id, err: err.message,
    });
    return true;
  }
}

/**
 * Rule C, as a function of one row: does the conflict lane spend a worker
 * turn on this conflicting head right now, and if not, what does the card
 * say? Pure and synchronous, so the merge gate and the tests can ask it too.
 *
 * @returns {{ admit: boolean, reason: string }}
 *   admit=true  reason 'approved' | 'first_conflict'
 *   admit=false reason 'fork_head' | 'unresolvable' | 'sync_backoff'
 *                      | 'checks_failing' | 'checks_error' | 'lock'
 *                      | 'awaiting_approval'
 */
function conflictAdmission(row) {
  if (!headIsPushable(row)) return { admit: false, reason: 'fork_head' };
  if (gaveUpOn(row)) return { admit: false, reason: 'unresolvable' };
  if (syncBackoffRemaining(row.id) > 0) return { admit: false, reason: 'sync_backoff' };
  const blocked = unmergeableReason(row);
  // Failing checks on the pinned head: the author has to push anyway, and
  // that push is a new authored head with its own first resolution. A turn
  // spent on this one is spent on a head about to be replaced.
  if (blocked === 'checks_failing' || blocked === 'checks_error') return { admit: false, reason: blocked };
  if (row.approved && !blocked) return { admit: true, reason: 'approved' };
  if (!integration.resolutionSpent(row)) return { admit: true, reason: 'first_conflict' };
  return { admit: false, reason: row.approved ? blocked : 'awaiting_approval' };
}

// The block reasons the conflict lane owns on a row. Written when the lane
// declines a conflicting head so the card can say why nobody is resolving
// it; cleared the moment the head is clean again or the lane admits it.
const LANE_REASONS = new Set(['awaiting_approval', 'unresolvable', 'fork_head']);

async function writeLaneReason(pool, row, reason) {
  const current = Array.isArray(row.integration_block_reasons) ? row.integration_block_reasons : [];
  const kept = current.filter((r) => !LANE_REASONS.has(r));
  const next = reason && LANE_REASONS.has(reason) ? [...kept, reason] : kept;
  if (next.length === current.length && next.every((r, i) => r === current[i])) return false;
  await integration.setBlockReasons(pool, row.id, next);
  return true;
}

// ── The pass ─────────────────────────────────────────────────────────────

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
// resolveOne, which set the flag moments ago and may not have dispatched
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

// A run is going for this head: 'pending' about the pinned commit, not a
// deferral (nothing was started for those), and not overdue (the stale
// sweeper owns those). Its finalizer enqueues the app when it reports, so
// the pass has nothing to do for it but wait — and the conflict lane holds
// meanwhile, because what it merges moves main.
function checkRunInFlight(row) {
  if (row.check_state !== 'pending') return false;
  if (row.check_phase === 'deferred') return false;
  if (!sameSha(row.checks_commit_sha, row.reviewed_head)) return false;
  try {
    return !require('./staging-recovery').checkRunOverdue(row);
  } catch (err) {
    log.debug('merge-queue', 'overdue check lookup failed; treating the run as live', {
      sessionId: row.id, err: err.message,
    });
    return true;
  }
}

async function runQueue(config, appId, { excludeSessionId = 0 } = {}) {
  const pool = getPool(config);
  await retireStaleIntegrating(pool, appId);

  const line = await loadLine(pool, appId, { excludeId: excludeSessionId });
  if (!line.length) return;

  // ── Direct lane ──
  //
  // Every approved candidate that is not measured conflicting, cheapest
  // first. Each attempt is the whole gate (checkAndMerge): it re-measures
  // the head against the main of THIS moment — a sibling that merged three
  // lines up is already in the mirror — so a candidate that no longer
  // merges cleanly is refused there and handed to the conflict lane, and
  // the exact-sha merge is the guard behind that. Nothing here spends a
  // worker turn, so the pass does not stop after a merge: the next
  // candidate is simply measured against the new main.
  const direct = line
    .filter((r) => r.approved && r.integration_merges_clean !== false && !unmergeableReason(r))
    .sort((a, b) => compareEffort(effortOf(a), effortOf(b)) || compareTally(a, b));

  let merged = 0;
  let directInFlight = 0;
  for (const r of direct) {
    if (checkRunInFlight(r)) {
      // Its run reports on its own; nothing merges before it does.
      directInFlight++;
      continue;
    }
    let outcome = null;
    try {
      outcome = await mergeDirect(config, pool, r.id);
    } catch (err) {
      log.error('merge-queue', 'direct merge attempt threw', { sessionId: r.id, err: err.message });
    }
    if (!outcome) continue;
    if (outcome.reason === 'merged') merged++;
    else if (outcome.reason === 'in_progress' || (outcome.reason === 'checks' && outcome.waiting)) {
      directInFlight++;
    }
  }

  // A head that is clean again does not need whatever the conflict lane
  // last said about it.
  for (const r of line) {
    if (r.integration_merges_clean === false) continue;
    const reasons = Array.isArray(r.integration_block_reasons) ? r.integration_block_reasons : [];
    if (reasons.some((x) => LANE_REASONS.has(x))) {
      await writeLaneReason(pool, r, null).catch(() => {});
    }
  }

  // ── Conflict lane ──
  //
  // One at a time, cheapest first, and only when nothing in the direct lane
  // is about to move main under the resolution. Every conflicting head gets
  // its admission recorded on the row whether or not it goes, so the card
  // can say who is expected to act.
  const conflicts = line.filter((r) => r.integration_merges_clean === false);
  const admitted = [];
  for (const r of conflicts) {
    const admission = conflictAdmission(r);
    if (admission.admit) {
      await writeLaneReason(pool, r, null).catch(() => {});
      admitted.push({ row: r, admission });
    } else {
      await writeLaneReason(pool, r, admission.reason).catch(() => {});
      log.debug('merge-queue', 'conflicting head not admitted to the conflict lane', {
        appId, sessionId: r.id, reason: admission.reason,
      });
    }
  }
  if (!admitted.length) {
    if (merged || conflicts.length) {
      log.info('merge-queue', 'pass complete', {
        appId, merged, directInFlight, conflicts: conflicts.length, admitted: 0,
      });
    }
    return;
  }
  if (directInFlight > 0) {
    log.info('merge-queue', 'conflict lane held: direct work is in flight', {
      appId, directInFlight, waiting: admitted.map((a) => a.row.id),
    });
    return;
  }

  // Approved candidates go to the front — the group has said yes — then the
  // smaller conflict, then the tally.
  admitted.sort((a, b) => (Number(b.admission.reason === 'approved') - Number(a.admission.reason === 'approved'))
    || compareEffort(effortOf(a.row), effortOf(b.row))
    || compareTally(a.row, b.row));

  // One resolution per pass. A candidate whose turn could not START — the
  // machinery threw (it is backed off now), or the branch is busy in its
  // dev chat — has not been resolved and has not moved main, so the next
  // in line is tried instead; anything that actually dispatched ends the
  // pass, and its completion is the next trigger. An exhausted budget is
  // the whole platform's, not the candidate's, so it ends the pass too.
  const tried = [];
  let outcome = null;
  for (const { row, admission } of admitted) {
    tried.push(row.id);
    outcome = null;
    try {
      outcome = await resolveOne(config, pool, row.id, admission);
    } catch (err) {
      log.error('merge-queue', 'resolveOne threw', { sessionId: row.id, err: err.message });
    }
    if (!outcome || !TRY_NEXT_AFTER.has(outcome.reason)) break;
  }
  log.info('merge-queue', 'pass complete', {
    appId, merged, directInFlight, conflicts: conflicts.length, admitted: admitted.length,
    tried, outcome: outcome && outcome.reason,
  });
}

const TRY_NEXT_AFTER = new Set(['cancel_failed', 'sync_threw', 'turn_in_flight', 'not_promoted', 'github_disabled_or_no_pr']);

// ── Direct lane: one attempt ─────────────────────────────────────────────

async function mergeDirect(config, pool, sessionId) {
  const session = await loadSession(pool, sessionId);
  if (!session || session.status !== 'promoted') return { ok: false, reason: 'not_promoted' };
  if (!github.isEnabled() || !session.repo_url || !session.pr_number) {
    return { ok: false, reason: 'github_disabled_or_no_pr' };
  }
  const { checkAndMerge } = require('../routes/votes');
  return runMerge(config, pool, session, checkAndMerge);
}

// ── Conflict lane: one resolution ────────────────────────────────────────

// Per-session coalescing: a vote and a sweep can name the same proposal at
// once, and two concurrent syncs for one session hit the worker's
// "a turn is already in flight" guard. Held in the process registry, so a
// sweep in another process (boot-failure-sync, fixed-check-sync) sees it.
const _inFlight = processes.heldMap('merge_resolve');

function resolveOne(config, pool, sessionId, admission) {
  const existing = _inFlight.get(sessionId);
  if (existing) return existing;
  const p = resolveOneInner(config, pool, sessionId, admission)
    .finally(() => { _inFlight.delete(sessionId); });
  _inFlight.set(sessionId, p);
  return p;
}

/** True while this proposal is being resolved, in any process. Read by the status routes. */
function isIntegratingSession(sessionId) {
  return _inFlight.has(sessionId) || processes.heldElsewhere('merge_resolve', sessionId);
}

async function resolveOneInner(config, pool, sessionId, admission = { reason: 'approved' }) {
  const session = await loadSession(pool, sessionId);
  if (!session || session.status !== 'promoted') return { ok: false, reason: 'not_promoted' };
  if (!github.isEnabled() || !session.repo_url || !session.pr_number) {
    return { ok: false, reason: 'github_disabled_or_no_pr' };
  }

  // Measure first, from the mirror: the columns the pass read may be a
  // sweep old, and a head that has become clean meanwhile belongs to the
  // direct lane, not here.
  const measured = await integration.measureDeduped({ pool, session }, { force: true });
  if (measured.mergesClean !== false) {
    if (admission.reason === 'approved') {
      const { checkAndMerge } = require('../routes/votes');
      return runMerge(config, pool, session, checkAndMerge);
    }
    return { ok: true, reason: 'clean_now' };
  }

  // A worker sync is platform housekeeping, billed to the system budget
  // rather than to whoever voted last.
  const budget = await limits.checkSystemBudget(pool);
  if (budget.error) {
    await integration.setBlockReasons(pool, session.id, ['budget']);
    log.info('merge-queue', 'Skipped: system token budget exhausted', { sessionId });
    return { ok: false, reason: 'over_budget' };
  }

  // Rule C's one pre-approval resolution is spent when it is DISPATCHED,
  // not when it lands: a turn that dies half-way must not buy a second.
  if (admission.reason === 'first_conflict') {
    await integration.markResolutionSpent(pool, session.id);
  }

  await integration.setBlockReasons(pool, session.id, ['integrating']);
  broadcast(session, { integrating: true });

  // Supersede and await the pre-resolution preview before the sync moves
  // its branch. An error here must not admit a worker against a live run.
  try {
    await require('./preview-lifecycle').supersede(config, session.id, measured.headSha);
  } catch (err) {
    log.warn('merge-queue', 'Could not stop the old preview before conflict repair', {
      sessionId, err: err.message,
    });
    await integration.setBlockReasons(pool, session.id, []);
    broadcast(session, { integrating: false });
    return { ok: false, reason: 'cancel_failed' };
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
        // integrating, so the flag stands; the resumed turn's completion
        // hands the proposal back to the queue (server.js
        // resumeDetachedTurn), which is when the next step belongs.
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
    // The worker could not resolve it. Remembered against this head and
    // this main so the same question is not asked again until one of them
    // moves; the row says the author is the one to act.
    noteResolutionGaveUp(session.id, measured.headSha, measured.mainSha);
    const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
    await postGroup(pool, session,
      `PR #${session.pr_number} conflicts with main and could not be resolved automatically. `
      + `${owner}: open the session's dev-chat to resolve it.`);
    // The card derives the conflict itself from merge_conflict_state, which
    // the sync turn just wrote; the lane adds only what it alone knows.
    await integration.setBlockReasons(pool, session.id, ['unresolvable']);
    broadcast(session, { integrating: false });
    return { ok: false, reason: 'unresolved_conflict' };
  }

  // The integrating phase is over on EVERY path from here. 'integrating' is
  // the one block reason the server owns (the card derives the rest), and
  // checkAndMerge only clears it on a successful claim — so a row whose
  // merge then stopped at approvals, the lock or a pending check kept a
  // card that said "syncing with main" long after the sync had finished
  // (#2100's "the UI is not matching up").
  await integration.setBlockReasons(pool, session.id, []);

  // Re-read: the sync moved the head.
  const fresh = await loadSession(pool, session.id);
  if (!fresh || fresh.status !== 'promoted') {
    broadcast(session, { integrating: false });
    return { ok: true, reason: 'no_longer_promoted' };
  }

  // Measure the pushed head first — it contains main, so it measures clean
  // — so that the columns say so before anything reads them for the run
  // that follows. measure() carries the row's recorded reasons forward
  // unless told otherwise, and a row read a moment ago may still say
  // 'integrating'. (The became-clean hook does not fire here: the head
  // changed, and a new head gets its run from its own push, below.)
  await integration.measureDeduped(
    { pool, session: fresh }, { force: true, blockReasons: [] }
  ).catch(() => {});
  broadcast(fresh, { integrating: false });

  // Install the new head as the reviewed revision and start its run. The
  // classifier reads the move as 'resolved' (every byte outside the
  // mechanical merge lies in a file git could not merge), which keeps the
  // approvals and re-checks the tree — the run that judges what the
  // resolution produced. For an approved candidate checkAndMerge would do
  // this itself; a candidate on its pre-approval resolution has no merge
  // attempt coming, so it is done here for both.
  await reconcileResolvedHead(config, pool, fresh).catch((err) => {
    log.warn('merge-queue', 'post-resolution head reconciliation failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  });

  if (admission.reason !== 'approved') {
    // The group has not said yes yet. The new head is being previewed and
    // checked; the vote brings it back round.
    return { ok: true, reason: 'resolved' };
  }
  const { checkAndMerge } = require('../routes/votes');
  return runMerge(config, pool, fresh, checkAndMerge);
}

// Re-pin the reviewed revision to the head the resolution pushed and kick
// the run for it — the native reconciler for native rows, the imported one
// (which only answers for a head in the app's own repository) for imported.
async function reconcileResolvedHead(config, pool, session) {
  if (session.source === 'imported') {
    return require('./pr-import-sync').reconcileImportedHead({
      config, pool, session, checks: 'background', notify: false,
    });
  }
  return require('../routes/votes').reconcileNativeReviewedHead({
    config, pool, session, fresh: true, notify: false,
  });
}

async function runMerge(config, pool, session, checkAndMerge) {
  let result;
  try {
    // autoResolve:false so a merge that fails here cannot re-enter the queue
    // from inside the queue. One attempt per candidate per pass.
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

// Into the proposal's own thread: a channel carries no activity
// (ws.sendSystemMessage).
async function postGroup(pool, session, content) {
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(pool, session.app_id, content, 'conflict', null, { type: 'session', ref: session.id });
  } catch (err) {
    log.warn('merge-queue', 'group message failed', { sessionId: session?.id, err: err.message });
  }
}

module.exports = {
  enqueue,
  receiveKick,
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
  // Rule C, for the merge gate's copy and for the tests.
  conflictAdmission,
  LANE_REASONS,
  // The ordering and the backoff, for the tests that pin them.
  effortOf,
  compareEffort,
  noteSyncFailure,
  syncBackoffRemaining,
  noteResolutionGaveUp,
  _syncBackoff,
  _gaveUp,
};
