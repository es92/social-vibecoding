'use strict';

// #2038 — the one answer to "where does this proposal stand relative to
// main", and the one rule for whether its approvals still describe it.
//
// ── What this replaces ─────────────────────────────────────────────────
//
// Six column groups with five writers and no owner: behind_main,
// merge_conflict_state, conflict_files, mergeability*, freshness_*,
// checks_base_*. They disagree with each other in normal operation — the
// card reads freshness_behind_by while the merge gate reads behind_main, and
// a successful sync writes only the second — and two of them have no
// re-measuring writer at all. See the schema block for the full account.
//
// Everything here answers from a local bare mirror (services/repo-mirror.js),
// never from GitHub's REST API. That is not an optimisation: GitHub cannot
// answer two of these questions correctly at all. `mergeable` is computed
// lazily and returns null while it thinks, and there is no conflicting-files
// endpoint, so the old path polled the first and estimated the second.
//
// ── The classifier ─────────────────────────────────────────────────────
//
// classifyHeadMove is the piece that lets approval follow the patch. When a
// proposal's head moves, exactly one question decides what it costs the
// approvals: did anybody write bytes that were not already approved?
//
// The old answer needed a provenance ledger — a table of every commit the
// platform pushed, a five-hop first-parent walk, and a fail-closed branch for
// when GitHub would not say who a commit's parent was. It needed all that
// because a commit's SHAPE can be forged: anyone can craft a merge whose
// first parent is the reviewed SHA, so "looks like our sync commit" could
// never be trusted.
//
// Recomputing the merge cannot be forged, because it does not ask the branch
// anything. It asks git to redo the merge and compares the result. The
// answer is arithmetic, it costs no network, and it is the same answer for
// everybody.

const log = require('./logger');
const mirror = require('./repo-mirror');

const SHA_RE = /^[0-9a-f]{40}$/;

// How long a measurement is good enough on a read path a voter is waiting on.
// Short on purpose — the number somebody reads a second before they click
// should be the current one — and cheap to honour, because a measurement is
// local plumbing rather than four GitHub round trips.
const MEASURE_TTL_MS = 30 * 1000;

function normalizeSha(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return SHA_RE.test(s) ? s : null;
}

function intOrNull(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function parseRepo(repoUrl) {
  const m = String(repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// ── The pure read ──────────────────────────────────────────────────────

/**
 * The `integration` block the API serializes and the card renders. Calls
 * nothing, never throws, and is correct on a row that predates the columns.
 *
 * `measuredAt` is deliberately part of the answer rather than hidden. A card
 * that says "behind by 6, measured 30 seconds ago" is telling the truth; one
 * that says "behind by 6" is making a claim about the present that it cannot
 * support. Every "the UI is out of sync" report was about the second kind.
 */
function readIntegration(session) {
  const s = session || {};
  const paths = Array.isArray(s.integration_conflict_paths) ? s.integration_conflict_paths : [];
  return {
    measuredAt: s.integration_measured_at
      ? new Date(s.integration_measured_at).toISOString() : null,
    headSha: normalizeSha(s.integration_head_sha),
    mainSha: normalizeSha(s.integration_main_sha),
    baseSha: normalizeSha(s.integration_base_sha),
    behindBy: intOrNull(s.integration_behind_by),
    aheadBy: intOrNull(s.integration_ahead_by),
    mergesClean: s.integration_merges_clean == null ? null : !!s.integration_merges_clean,
    conflictPaths: paths.slice(0, 50),
    mergedTree: normalizeSha(s.integration_merged_tree),
    checksBaseCurrent: s.integration_checks_base_current == null
      ? null : !!s.integration_checks_base_current,
    blockReasons: Array.isArray(s.integration_block_reasons)
      ? s.integration_block_reasons : [],
    error: s.integration_error || null,
    // Derived, so every surface agrees without re-deriving: is this answer
    // about the head the row currently claims? A measurement about a head
    // that has since moved is stale by construction.
    stale: !!(normalizeSha(s.integration_head_sha)
      && normalizeSha(s.reviewed_head_sha)
      && normalizeSha(s.integration_head_sha) !== normalizeSha(s.reviewed_head_sha)),
  };
}

/** Is this measurement young enough that a read path should not re-take it? */
function isFresh(session, ttlMs = MEASURE_TTL_MS) {
  const at = session && session.integration_measured_at;
  if (!at) return false;
  const t = new Date(at).getTime();
  return Number.isFinite(t) && (Date.now() - t) < Math.max(0, ttlMs);
}

// ── The classifier ─────────────────────────────────────────────────────

/**
 * What did this head move cost the approvals?
 *
 *   same        the head did not actually move.
 *   mechanical  the new tree is EXACTLY what git produces merging the
 *               approved head with the slice of main the proposal absorbed.
 *               Nobody wrote anything, so the approvals still describe the
 *               code and keep counting. Nothing is carried or advanced —
 *               the epoch simply does not move.
 *   resolved    conflicts existed and were resolved, but every byte that
 *               differs from the mechanical attempt lies in a file git
 *               itself could not merge. The resolution is bounded by the
 *               conflict. Policy decides whether that keeps the approvals.
 *   authored    anything else. Somebody changed the proposal.
 *
 * `unknown` is returned when the mirror cannot answer (a commit it has never
 * seen, an unrelated history). Callers must treat it as authored — failing
 * open here would let an author push inherit an approval — but the DISTINCT
 * value matters, because "we could not tell" deserves a different message to
 * the group than "you changed it".
 *
 * Note which main is used: the merge base of the new head and main, NOT
 * main's current tip. The proposal absorbed some slice of main when it was
 * synced, and main has very likely moved since. Comparing against the tip
 * would make every mechanical merge look authored the moment anything else
 * landed — the false positive that costs people their votes, which is the
 * exact direction this must never fail in.
 */
async function classifyHeadMove(dir, { approvedHead, newHead, mainSha }) {
  const approved = normalizeSha(approvedHead);
  const next = normalizeSha(newHead);
  const main = normalizeSha(mainSha);
  if (!approved || !next) return { kind: 'unknown', reason: 'missing_sha' };
  if (approved === next) return { kind: 'same' };

  try {
    if (!(await mirror.hasCommit(dir, next)) || !(await mirror.hasCommit(dir, approved))) {
      return { kind: 'unknown', reason: 'commit_not_in_mirror' };
    }

    // The slice of main this head actually contains. With no main to compare
    // against, fall back to the approved head's own base — a head move with
    // no main involved is an author push by definition.
    const containedMain = main ? await mirror.mergeBase(dir, next, main) : null;
    if (!containedMain) return { kind: 'authored', reason: 'no_shared_main' };

    const attempt = await mirror.mergeTree(dir, approved, containedMain);
    const nextTree = await mirror.treeOf(dir, next);
    if (!nextTree || !attempt.tree) return { kind: 'unknown', reason: 'tree_unreadable' };

    if (attempt.clean && attempt.tree === nextTree) {
      return { kind: 'mechanical', mergedTree: nextTree, absorbedMain: containedMain };
    }

    // Conflicts existed. The resolution is "bounded" when every path that
    // differs from the conflicted merge attempt is a path git could not
    // resolve on its own. A resolution that also touched an unconflicted
    // file changed something nobody was asked to approve.
    if (!attempt.clean) {
      const touched = await mirror.changedPaths(dir, attempt.tree, nextTree);
      const conflicted = new Set(attempt.conflicts);
      const strayed = touched.filter((p) => !conflicted.has(p));
      if (!strayed.length) {
        return {
          kind: 'resolved',
          mergedTree: nextTree,
          absorbedMain: containedMain,
          conflictPaths: attempt.conflicts,
        };
      }
      return { kind: 'authored', reason: 'edits_outside_conflicts', paths: strayed.slice(0, 20) };
    }

    return { kind: 'authored', reason: 'tree_differs' };
  } catch (err) {
    log.warn('integration', 'Head-move classification failed', {
      approvedHead: approved, newHead: next, err: err.message,
    });
    return { kind: 'unknown', reason: err.message };
  }
}

// ── The measurement ────────────────────────────────────────────────────

/**
 * Re-measure one promoted proposal against main and write the answer through.
 *
 * NEVER throws. This runs inside a sweep and inside a read path a voter is
 * waiting on, so a failure records itself in integration_error and leaves the
 * previous numbers alone — the same stance services/proposal-freshness.js
 * took, for the same reasons.
 *
 * `blockReasons` is supplied by the caller rather than computed here: only
 * the merge gate knows the two things the browser cannot derive from columns
 * — that the queue is working on this proposal right now, and that it needs a
 * merge the shared token budget cannot pay for. Everything else the card
 * shows it still derives itself from the columns it already reads.
 */
async function measure({ pool, session }, options = {}) {
  const s = session || {};
  const answer = readIntegration(s);
  const parsed = parseRepo(s.repo_url);

  if (!pool || !parsed || !s.branch_name) {
    return { ...answer, skipped: 'incomplete_session' };
  }
  if (!options.force && isFresh(s, options.ttlMs)) {
    return { ...answer, skipped: 'fresh' };
  }

  const next = {
    headSha: null, mainSha: null, baseSha: null,
    behindBy: null, aheadBy: null,
    mergesClean: null, conflictPaths: [], mergedTree: null,
    checksBaseCurrent: null, error: null,
  };

  try {
    const known = [s.reviewed_head_sha, s.checks_base_sha, s.checks_commit_sha]
      .map(normalizeSha).filter(Boolean);
    const dir = await mirror.ensureMirror(parsed.owner, parsed.repo, { refs: known });

    const mainSha = await mirror.defaultBranchSha(dir);
    if (!mainSha) throw new Error(`${parsed.owner}/${parsed.repo} has no default-branch commit`);
    next.mainSha = mainSha;

    // The live head, from the mirror's own refs. One fetch per app answered
    // this for every open proposal on it; the old path spent a getPR each.
    const head = await mirror.resolveBranch(dir, s.branch_name);
    if (!head) throw new Error(`branch ${s.branch_name} is not in the mirror`);
    next.headSha = head;

    next.baseSha = await mirror.mergeBase(dir, mainSha, head);
    next.behindBy = await mirror.behindBy(dir, mainSha, head);
    next.aheadBy = await mirror.aheadBy(dir, mainSha, head);

    const merged = await mirror.mergeTree(dir, head, mainSha);
    next.mergesClean = merged.clean;
    next.conflictPaths = merged.conflicts;
    // Only meaningful for a clean merge: on a conflicted one the tree carries
    // conflict markers and is not something anybody would merge.
    next.mergedTree = merged.clean ? merged.tree : null;

    const checksBase = normalizeSha(s.checks_base_sha);
    if (checksBase) {
      next.checksBaseCurrent = await mirror.hasCommit(dir, checksBase)
        ? await mirror.isAncestor(dir, checksBase, mainSha)
        : null;
    }
  } catch (err) {
    next.error = String(err && err.message ? err.message : 'unknown error').slice(0, 300);
    try {
      await pool.query(
        `UPDATE chat_sessions
            SET integration_measured_at = NOW(), integration_error = $2
          WHERE id = $1`,
        [s.id, next.error]
      );
    } catch (e) {
      log.warn('integration', 'error stamp failed', { sessionId: s.id, err: e.message });
    }
    return { ...answer, measuredAt: new Date().toISOString(), error: next.error };
  }

  const blockReasons = options.blockReasons === undefined
    ? (Array.isArray(s.integration_block_reasons) ? s.integration_block_reasons : [])
    : (Array.isArray(options.blockReasons) ? options.blockReasons
      : [options.blockReasons].filter(Boolean));

  // What the row said before this write, read in the same statement so the
  // comparison is against the STORED answer rather than the caller's copy of
  // the session, which may be minutes and several measurements old.
  let wasClean = null;
  let wasHead = null;
  try {
    const { rows } = await pool.query(
      `WITH prev AS (
         SELECT integration_merges_clean AS was_clean, integration_head_sha AS was_head
           FROM chat_sessions WHERE id = $1
       )
       UPDATE chat_sessions
          SET integration_measured_at = NOW(),
              integration_head_sha = $2,
              integration_main_sha = $3,
              integration_base_sha = $4,
              integration_behind_by = $5,
              integration_ahead_by = $6,
              integration_merges_clean = $7,
              integration_conflict_paths = $8::jsonb,
              integration_merged_tree = $9,
              integration_checks_base_current = $10,
              integration_block_reasons = $11::jsonb,
              integration_error = NULL
        WHERE id = $1
    RETURNING (SELECT was_clean FROM prev) AS was_clean,
              (SELECT was_head FROM prev) AS was_head`,
      [
        s.id, next.headSha, next.mainSha, next.baseSha,
        next.behindBy, next.aheadBy, next.mergesClean,
        JSON.stringify(next.conflictPaths), next.mergedTree,
        next.checksBaseCurrent, JSON.stringify(blockReasons),
      ]
    );
    wasClean = rows[0] ? rows[0].was_clean : null;
    wasHead = rows[0] ? rows[0].was_head : null;
  } catch (err) {
    log.warn('integration', 'write failed', { sessionId: s.id, err: err.message });
    return { ...answer, error: err.message };
  }

  // The one transition that starts work: a head that conflicted and now
  // merges cleanly is a head whose checks were held back (check-admission)
  // and can run. Same head only — a NEW head that measures clean gets its
  // checks from the build its push started, and a hook here would run them
  // twice. The hook is registered at boot, since this module has no config
  // of its own; unregistered, the transition is simply logged.
  if (wasClean === false && next.mergesClean === true
      && wasHead && normalizeSha(wasHead) === normalizeSha(next.headSha)) {
    log.info('integration', 'proposal now merges cleanly with main', {
      sessionId: s.id, headSha: next.headSha,
    });
    if (typeof _onBecameClean === 'function') {
      Promise.resolve()
        .then(() => _onBecameClean({ ...s, integration_head_sha: next.headSha }))
        .catch((err) => log.warn('integration', 'became-clean hook failed', {
          sessionId: s.id, err: err && err.message,
        }));
    }
  }

  const written = readIntegration({
    ...s,
    integration_measured_at: new Date(),
    integration_head_sha: next.headSha,
    integration_main_sha: next.mainSha,
    integration_base_sha: next.baseSha,
    integration_behind_by: next.behindBy,
    integration_ahead_by: next.aheadBy,
    integration_merges_clean: next.mergesClean,
    integration_conflict_paths: next.conflictPaths,
    integration_merged_tree: next.mergedTree,
    integration_checks_base_current: next.checksBaseCurrent,
    integration_block_reasons: blockReasons,
    integration_error: null,
  });

  try {
    const { pushSessionUpdate } = require('./ws');
    pushSessionUpdate({
      action: 'integration',
      sessionId: s.id,
      appSlug: s.app_slug || null,
      integration: written,
    });
  } catch (_) { /* ws failures are non-fatal */ }

  return written;
}

// Read paths are concurrent — several voters open the same proposal, a poll
// lands on a click. One in-flight measurement per session is plenty.
const _inFlight = new Map();

function measureDeduped(deps, options = {}) {
  const id = deps && deps.session && deps.session.id;
  if (id == null) return measure(deps, options);
  const existing = _inFlight.get(id);
  if (existing) return existing;
  const p = measure(deps, options)
    .catch((err) => {
      log.warn('integration', 'unexpected rejection', { sessionId: id, err: err && err.message });
      return readIntegration(deps.session);
    })
    .finally(() => { _inFlight.delete(id); });
  _inFlight.set(id, p);
  return p;
}

/**
 * Record what the SERVER knows is holding this proposal, without re-measuring.
 *
 * The merge gate is the only thing that knows why a merge did not happen, and
 * it has always known and then discarded it — which is why the card had to
 * guess with a precedence table, and why the group got told "needs 3/3 yes
 * votes" about a proposal whose votes were in and whose checks were running.
 *
 * Cheap enough to call on every blocking return: one UPDATE, no git, no
 * network. Never throws — a proposal whose reason could not be recorded is a
 * worse card, not a failed merge.
 */
async function setBlockReasons(pool, sessionId, reasons) {
  const list = (Array.isArray(reasons) ? reasons : [reasons]).filter(Boolean);
  try {
    await pool.query(
      `UPDATE chat_sessions
          SET integration_block_reasons = $2::jsonb
        WHERE id = $1 AND integration_block_reasons IS DISTINCT FROM $2::jsonb`,
      [sessionId, JSON.stringify(list)]
    );
  } catch (err) {
    log.warn('integration', 'block reasons write failed', { sessionId, err: err.message });
  }
}

// ── The epoch ──────────────────────────────────────────────────────────

/**
 * Clear a proposal's approvals by moving its epoch on.
 *
 * There is no DELETE here on purpose. Votes keep their own epoch stamp, so
 * bumping the session's makes every earlier vote stop counting in one
 * statement, atomically, with no window in which a tally is half-cleared —
 * and the rows survive as a record of what was approved and when.
 *
 * Returns the new epoch, or null when the row was gone.
 */
async function clearApprovals(pool, sessionId, reason) {
  const { rows } = await pool.query(
    `UPDATE chat_sessions
        SET approval_epoch = approval_epoch + 1
      WHERE id = $1
      RETURNING approval_epoch`,
    [sessionId]
  );
  const epoch = rows[0] ? parseInt(rows[0].approval_epoch, 10) : null;
  if (epoch != null) {
    log.info('integration', 'Approvals cleared', { sessionId, epoch, reason: reason || null });
  }
  return epoch;
}

// ── The conflict lane's one pre-approval resolution ─────────────────────

/**
 * Record that the queue spent a resolution on this proposal's current
 * authored head. "Current authored head" IS the approval epoch: an authored
 * push bumps it, the platform's own mechanical or resolved moves do not
 * (routes/votes.js reconcileNativeReviewedHead), so stamping the epoch ties
 * the resolution to the author's work rather than to a commit that the
 * resolution itself is about to replace. Never throws.
 */
async function markResolutionSpent(pool, sessionId) {
  try {
    await pool.query(
      `UPDATE chat_sessions SET integration_resolved_epoch = approval_epoch WHERE id = $1`,
      [sessionId]
    );
  } catch (err) {
    log.warn('integration', 'resolution stamp failed', { sessionId, err: err.message });
  }
}

/**
 * Has this authored head already had its pre-approval resolution?
 * Reads the two columns off a row; a row that predates the stamp has not.
 */
function resolutionSpent(session) {
  const s = session || {};
  const spent = intOrNull(s.integration_resolved_epoch);
  if (spent == null) return false;
  return spent === (intOrNull(s.approval_epoch) ?? 0);
}

// Registered once at boot (server.js) with the platform config in scope; see
// measure() for the one transition that calls it.
let _onBecameClean = null;
function onBecameClean(fn) {
  _onBecameClean = typeof fn === 'function' ? fn : null;
}

// The SQL predicate for "this vote still counts" is owned by
// services/pr-vote-revision.js — the module named for exactly that concern,
// and the one all eighteen call sites already import. Re-exported here so a
// caller holding this module does not need both.
const { currentVotePredicateSql } = require('./pr-vote-revision');

module.exports = {
  readIntegration,
  isFresh,
  measure,
  measureDeduped,
  setBlockReasons,
  classifyHeadMove,
  clearApprovals,
  markResolutionSpent,
  resolutionSpent,
  onBecameClean,
  currentVotePredicateSql,
  MEASURE_TTL_MS,
  _normalizeSha: normalizeSha,
  _parseRepo: parseRepo,
  _inFlight,
};
