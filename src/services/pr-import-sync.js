'use strict';

// #687 Slice 3 — sync poller for IMPORTED PR proposals.
//
// An imported row tracks a GitHub PR whose branch the platform does
// NOT own; the external author keeps pushing to it. Votes and checks are
// cast/run against a specific commit (imported_pr_head_sha), so when the
// author pushes new commits the head moves. This module notices that on the
// next sweeper pass and advances the row to the new head:
//
//   - update imported_pr_head_sha to the new head,
//   - once the row is promoted, ask services/integration.js what the move
//     cost the approvals — the platform's own sync commit (the merge queue
//     pushes those onto imported branches too, #2038) is mechanical and
//     keeps them; an author push moves the approval epoch on and asks for
//     re-review,
//   - refresh behind_main / conflict state from GitHub (the native path's
//     drift snapshot), and
//   - re-run the proposal checks against the new head via the SHA-pinned
//     staging build from Slice 1, unless a settled verdict carries across a
//     mechanical merge.
//
// The same reconciliation is available WITHOUT a GitHub read for a branch
// the app's mirror can see (reconcileImportedHead); the merge path uses it
// so an exact-sha merge is never offered a pin the platform itself just
// superseded.
//
// It is also the only pass that can correct a STALE conflict snapshot
// (#1365). The drift refresh above runs only on a head change, and GitHub
// answers `mergeable: null` for the first read after a push — the very read
// that head change triggers — so a snapshot could be stranded claiming a
// conflict the author had already resolved. See refreshStrandedConflictState.
//
// Purely additive to the native proposal/vote/merge path.

const log = require('./logger');
const github = require('./github');
const githubMock = require('./github-mock');
const { usesMockGithubForImports } = require('../config');
const { sameSha } = require('./pr-vote-revision');

function parseRepo(url) {
  const [, owner, repo] = (url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo } : null;
}

// #687: talk to the in-memory mock GitHub source in staging previews (no
// GitHub credentials there — see usesMockGithubForImports in config.js);
// the real client everywhere else.
function activeGithub() {
  return usesMockGithubForImports() ? githubMock : github;
}

// Human label for the proposal in thread notes ("PR #123 — Fix the footer").
function prLabel(session) {
  return session.pr_title
    ? `PR #${session.pr_number}: ${session.pr_title}`
    : `PR #${session.pr_number}`;
}

// #866: post a note into an imported proposal's VISIBLE thread.
//
// The native staging flows narrate build start/finish/failure into
// chat_session_messages — the dev-chat transcript. An imported proposal has
// no dev chat (nobody in the app owns its session), so those rows render
// nowhere and every minute of a multi-minute build looks like nothing
// happening. The thread an imported proposal DOES have is the group
// discussion keyed ('session', id) — the same channel checkAndMerge and the
// head-change note use. Best-effort by construction: narration must never
// affect the build's outcome.
async function postProposalNote(pool, session, text, metadata) {
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(
      pool, session.app_id, text, 'system',
      { prNumber: session.pr_number || null, ...(metadata || {}) },
      { type: 'session', ref: session.id }
    );
  } catch (err) {
    log.warn('pr-import-sync', 'proposal thread note failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  }
}

// Fetch the imported PR's current head SHA and, when it has moved since the
// stored imported_pr_head_sha, reset the proposal against the new head.
//
// Returns one of:
//   'skipped'   — not an imported row, GitHub not configured, or
//                 the getPR fetch failed (transient — retried next sweep).
//   'unchanged' — the head SHA matches the stored one (the common case).
//                 One getPR call, and no head machinery. It may still heal
//                 two things the same fetch has the answer to: a drifted
//                 description mirror, and (#1365) a conflict snapshot left
//                 claiming the proposal is blocked after GitHub decided it
//                 is not. Both are no-ops unless there is something wrong.
//   'updated'   — the head moved: tally cleared, note posted, drift +
//                 checks refreshed against the new head.
//
// `session` must carry (at least): id, app_id, app_slug, source, pr_number,
// pr_title, branch_name, repo_url, imported_pr_head_sha — i.e. the
// `cs.*, a.slug AS app_slug, a.repo_url` shape the sweeper selects. Never
// throws: infrastructure failures are logged and swallowed so one bad PR
// can't wedge the sweep.
async function syncImportedProposal({ config, pool, session }) {
  try {
    if (!session || session.source !== 'imported' || !session.pr_number) return 'skipped';
    const repo = parseRepo(session.repo_url);
    const gh = activeGithub();
    if (!repo || !gh.isEnabled()) return 'skipped';

    let pr;
    try {
      pr = await gh.getPR(repo.owner, repo.repo, session.pr_number);
    } catch (err) {
      log.warn('pr-import-sync', 'getPR failed — will retry next sweep', {
        sessionId: session.id, prNumber: session.pr_number, err: err.message,
      });
      return 'skipped';
    }

    // #1333. Every sweep already has a fresh PR in hand, so the description
    // mirror is refreshed here BEFORE the head check returns. That is what
    // heals rows written before the column existed — and what keeps the
    // description current when an author edits it on GitHub rather than
    // through submit_work. Best-effort: a sweep must never fail over a
    // display field.
    const freshBody = typeof pr.body === 'string' ? pr.body : null;
    if (freshBody !== (session.pr_body == null ? null : session.pr_body)) {
      try {
        await pool.query('UPDATE chat_sessions SET pr_body = $1 WHERE id = $2', [freshBody, session.id]);
        session.pr_body = freshBody;
      } catch (err) {
        log.warn('pr-import-sync', 'description mirror refresh failed (non-fatal)', {
          sessionId: session.id, err: err.message,
        });
      }
    }

    const newHead = pr.head && pr.head.sha ? pr.head.sha : null;
    if (!newHead) return 'skipped';
    const oldHead = session.imported_pr_head_sha || null;
    if (newHead === oldHead) {
      // #1365. The head is where we left it — but the CONFLICT SNAPSHOT may
      // not be, and this is the only pass that can put it right.
      await refreshStrandedConflictState({ pool, session, pr, repo });
      return 'unchanged';
    }

    await applyHeadChange({ config, pool, session, pr, repo, newHead, oldHead });
    return 'updated';
  } catch (err) {
    log.warn('pr-import-sync', 'syncImportedProposal failed', {
      sessionId: session && session.id, err: err.message,
    });
    return 'skipped';
  }
}

// What did this head move cost the approvals? The same question, and the
// same answer, as the native path (routes/votes.js reconcileNativeReviewedHead):
// services/integration.js redoes the merge from the local mirror and compares
// trees, so nothing here trusts the shape of the new commit.
//
// This used to be assumed rather than asked. The comment read "an imported
// head moving is always an author push by definition: the platform does not
// write to the author's fork" — which stopped being true the day the merge
// queue (#2038) started bringing imported proposals up to date with main by
// pushing a merge commit onto their branch. Every one of those syncs then
// came back through the poller as an "author push", cleared the votes, and
// asked the group to re-review a change nobody had changed (#2100, #2095).
//
// 'unknown' — the mirror cannot answer — is treated by the caller as
// authored. Failing open here would let a real push inherit approvals.
async function classifyImportedHeadMove({ session, oldHead, newHead }) {
  // The staging mock has no repository to redo the merge from, and a mock
  // "push" (github-mock.bumpHead) is an author push by construction.
  if (usesMockGithubForImports()) return { kind: 'authored', reason: 'mock_github' };
  const integration = require('./integration');
  const mirror = require('./repo-mirror');
  const parsed = integration._parseRepo(session.repo_url);
  if (!parsed) return { kind: 'unknown', reason: 'no_repo' };
  try {
    const dir = await mirror.ensureMirror(parsed.owner, parsed.repo, { refs: [oldHead, newHead] });
    const mainSha = await mirror.defaultBranchSha(dir);
    return await integration.classifyHeadMove(dir, { approvedHead: oldHead, newHead, mainSha });
  } catch (err) {
    log.warn('pr-import-sync', 'head-move classification failed; treating as authored', {
      sessionId: session.id, oldHead, newHead, err: err.message,
    });
    return { kind: 'unknown', reason: err.message };
  }
}

// Verdicts that describe a finished run. Only these can be carried onto a
// mechanically merged head: a 'pending' verdict is a run still going (or one
// the sync just superseded), and carrying its stamp forward would leave the
// row 'pending' with nothing building — the ten-minute stale wait of #1728.
// 'error' is left out too: it usually means the preview did not boot, which
// a rebuild against the merged commit is the right way to find out about.
const CARRIABLE_CHECK_STATES = new Set(['passing', 'skipped', 'failing']);

// Apply a head change: advance the stored SHA, decide what the move costs the
// approvals and the checks, refresh drift, and re-run SHA-pinned checks where
// the verdict cannot carry. An active import has no votes to protect and
// simply follows the new head.
//
// `move` is the classification when the caller already has it (the
// mirror-driven path below); otherwise it is computed here for a row up for
// vote. `pr`/`repo` are the GitHub read the poller had in hand and are only
// used for the drift snapshot; the mirror-driven path has neither.
//
// `checks`:
//   'await'      — (default; the poller) run the rebuild here and wait for
//                  it, so the sweep's per-session cooldown bounds concurrency.
//   'background' — kick the rebuild and return.
//   'defer'      — leave the rebuild to the caller's checkAndMerge, whose
//                  checks gate rebuilds exactly the pinned head when the
//                  verdict's commit does not match it. Only honoured while
//                  the approvals survive: a run that cleared them stops at
//                  the approvals gate and would never reach the checks gate,
//                  so that case degrades to 'background'.
//
// `notify: false` suppresses the group message and the vote broadcast for a
// caller that is about to say something more specific itself (the merge
// path's 409 handler).
//
// Returns { applied, votesKept, checksCarry, kind, epoch }. `applied` is
// false when the row's pin no longer matched `oldHead` — another pass got
// there first — and NOTHING was written or posted. The sweep and the queue
// can both notice the same move; the second must be a no-op, not a second
// epoch bump and a second "please re-review" (PR #2101 saw both).
async function applyHeadChange({
  config, pool, session, pr = null, repo = null, newHead, oldHead,
  move = null, checks = 'await', notify = true,
}) {
  const { sendSystemMessage, pushVoteUpdate } = require('./ws');
  const upForVote = session.status === 'promoted' || session.status === 'merging';

  // 1. What the move costs. Only a proposal up for vote has approvals to
  //    protect, so only it pays for the classification.
  if (upForVote && !move) {
    move = await classifyImportedHeadMove({ session, oldHead, newHead });
  }
  const kind = upForVote ? ((move && move.kind) || 'unknown') : 'authored';
  const keepsApprovals = upForVote && (kind === 'mechanical' || kind === 'resolved');
  const bumpEpoch = upForVote && !keepsApprovals;
  // Checks policy follows who wrote the tree, as on the native path: a
  // mechanical merge is pure git over a tested branch and a tested main, so
  // a settled verdict carries. A 'resolved' tree is one nobody has tested.
  const checksCarry = kind === 'mechanical'
    && sameSha(session.checks_commit_sha, oldHead)
    && CARRIABLE_CHECK_STATES.has(session.check_state);

  // 2. One statement. If the epoch bump and the head install could land
  //    separately, a crash between them would leave a row whose approvals
  //    describe neither the old code nor the new. The WHERE is the guard
  //    against a second applier: it only fires if the pin is still the one
  //    this decision was made about.
  const { rows: claimed } = await pool.query(
    `UPDATE chat_sessions
        SET imported_pr_head_sha = $1,
            stale_notified_at = NULL,
            approval_epoch = approval_epoch + CASE WHEN $3::boolean THEN 1 ELSE 0 END,
            checks_commit_sha = CASE WHEN $4::boolean THEN $1 ELSE checks_commit_sha END
      WHERE id = $2
        AND imported_pr_head_sha IS NOT DISTINCT FROM $5::varchar
      RETURNING approval_epoch`,
    [newHead, session.id, bumpEpoch, checksCarry, oldHead]
  );
  if (!claimed.length) {
    log.info('pr-import-sync', 'Head change already applied by another pass; nothing to do', {
      sessionId: session.id, prNumber: session.pr_number, oldHead, newHead,
    });
    // Let the caller carry on with the row as it now is, not as it was read:
    // a merge attempt that kept the stale pin would offer GitHub the old
    // commit and buy exactly the 409 this path exists to avoid.
    const { rows: current } = await pool.query(
      `SELECT imported_pr_head_sha, approval_epoch, checks_commit_sha, check_state
         FROM chat_sessions WHERE id = $1`,
      [session.id]
    ).catch(() => ({ rows: [] }));
    if (current[0]) Object.assign(session, current[0]);
    return { applied: false, votesKept: false, checksCarry: false, kind, epoch: null };
  }
  const epoch = parseInt(claimed[0].approval_epoch, 10);
  session.imported_pr_head_sha = newHead;
  session.approval_epoch = epoch;
  if (checksCarry) session.checks_commit_sha = newHead;
  if (bumpEpoch) {
    log.info('integration', 'Approvals cleared', {
      sessionId: session.id, epoch, reason: `imported_head_${kind}`,
    });
  }

  const label = prLabel(session);
  const shortHead = String(newHead).slice(0, 8);
  const needsChecks = !checksCarry && !sameSha(session.checks_commit_sha, newHead);
  const rebuildClause = needsChecks
    ? ' The staging preview and automated checks are being rebuilt against the new commit.'
    : '';
  let message;
  if (!upForVote) {
    message = `${label} was updated on GitHub.${rebuildClause}`;
  } else if (kind === 'mechanical') {
    message = `${label} was brought up to date with main. Nothing in the proposal changed, so its votes still stand.`
      + (needsChecks ? ' The automated checks are re-running against the merged commit.' : '');
  } else if (kind === 'resolved') {
    const n = Array.isArray(move.conflictPaths) ? move.conflictPaths.length : 0;
    message = `${label} was brought up to date with main and ${n || 'its'} conflicting file${n === 1 ? '' : 's'} `
      + 'were resolved automatically. The votes still stand; the staging preview and automated checks are '
      + 'being rebuilt against the merged commit, and it will merge on its own once they pass.';
  } else if (kind === 'unknown') {
    message = `${label} moved to commit ${shortHead}, which the platform could not verify`
      + `${move && move.reason ? ` (${move.reason})` : ''}. Earlier votes were cleared, so please re-review the new changes.${rebuildClause}`;
  } else {
    message = `${label} was updated on GitHub. Earlier votes were cleared, so please re-review the new changes.${rebuildClause}`;
  }

  if (upForVote) {
    await require('./app-admins').refreshExplicitApproval(pool, session, session);
  }
  if (notify) {
    await sendSystemMessage(
      pool, session.app_id, message, 'system',
      { headChanged: true, votesKept: keepsApprovals, prNumber: session.pr_number, headSha: newHead },
      { type: 'session', ref: session.id }
    ).catch((err) => log.warn('pr-import-sync', 'head-change note failed', {
      sessionId: session.id, err: err.message,
    }));
    if (upForVote) {
      try {
        pushVoteUpdate({
          sessionId: session.id, appSlug: session.app_slug || null, merged: false,
          headMoved: true, ...(keepsApprovals ? { votesKept: true } : {}),
        });
      } catch (_) { /* ws failures are non-fatal */ }
    }
  }

  // 3. Refresh behind_main / conflict snapshot the way the native path does —
  //    only when the caller had the GitHub read in hand. The mirror-driven
  //    callers have just measured the integration record instead.
  if (pr && repo) {
    await refreshDriftState({ pool, session, pr, repo }).catch((err) =>
      log.warn('pr-import-sync', 'drift refresh failed', { sessionId: session.id, err: err.message }));
  }

  // 4. Re-run the proposal checks against the NEW head — the SHA-pinned
  //    staging build from Slice 1 (storeChecks / storeChecksSkipped) — unless
  //    the verdict carried, or the caller's merge attempt is about to do it.
  if (needsChecks) {
    const mode = (checks === 'defer' && !keepsApprovals) ? 'background' : checks;
    if (mode === 'await') {
      await rerunChecksForNewHead({ config, pool, session, newHead }).catch((err) =>
        log.warn('pr-import-sync', 'checks re-run failed', { sessionId: session.id, err: err.message }));
    } else if (mode === 'background') {
      rerunChecksForNewHead({ config, pool, session, newHead }).catch((err) =>
        log.warn('pr-import-sync', 'checks re-run failed', { sessionId: session.id, err: err.message }));
    }
  }

  log.info('pr-import-sync', 'Imported PR head changed', {
    sessionId: session.id, prNumber: session.pr_number, oldHead, newHead, upForVote,
    moveKind: kind, votesKept: keepsApprovals, checksCarry, checksRerun: needsChecks ? checks : 'none',
  });
  return { applied: true, votesKept: keepsApprovals, checksCarry, kind, epoch };
}

// Re-pin an imported proposal to the live head of its branch WITHOUT asking
// GitHub — the imported analogue of routes/votes.js reconcileNativeReviewedHead.
//
// The poller above learns of a head move from getPR on its own cadence. Two
// callers cannot wait for that: the merge queue, which has just pushed a sync
// commit onto this very branch and is about to offer GitHub the pinned
// commit (a pin still on the pre-sync head is a guaranteed 409 — the
// "wasn't merged, because the PR was updated on GitHub" loop of #2100); and
// the 409 handler itself, which would otherwise release the claim and leave
// the row waiting for the next sweep.
//
// Only answers for a head the mirror can see: a branch in the app's own
// repository. A head on the author's fork is left to the poller, exactly as
// before. Never throws.
async function reconcileImportedHead({ config, pool, session, checks = 'defer', notify = true }) {
  try {
    if (!session || session.source !== 'imported' || !session.pr_number) {
      return { reconciled: false, reason: 'not_imported' };
    }
    const oldHead = session.imported_pr_head_sha || null;
    if (!oldHead) return { reconciled: false, reason: 'unpinned' };
    if (!session.branch_name || !session.repo_url) return { reconciled: false, reason: 'no_branch' };
    if (require('./proposal-update').branchHomeOf(session) !== 'app_repo') {
      return { reconciled: false, reason: 'fork_head' };
    }
    const integration = require('./integration');
    const mirror = require('./repo-mirror');
    const parsed = integration._parseRepo(session.repo_url);
    if (!parsed) return { reconciled: false, reason: 'no_repo' };

    let dir; let mainSha; let liveHead;
    try {
      dir = await mirror.ensureMirror(parsed.owner, parsed.repo, { refs: [oldHead] });
      mainSha = await mirror.defaultBranchSha(dir);
      liveHead = await mirror.resolveBranch(dir, session.branch_name);
    } catch (err) {
      log.warn('pr-import-sync', 'mirror unreadable; leaving the imported pin as it stands', {
        sessionId: session.id, err: err.message,
      });
      return { reconciled: false, reason: 'mirror_unreadable' };
    }
    if (!liveHead) return { reconciled: false, reason: 'branch_missing' };
    if (sameSha(liveHead, oldHead)) {
      return { reconciled: true, changed: false, headSha: liveHead };
    }

    const move = await integration.classifyHeadMove(dir, {
      approvedHead: oldHead, newHead: liveHead, mainSha,
    });
    const applied = await applyHeadChange({
      config, pool, session, newHead: liveHead, oldHead, move, checks, notify,
    });
    return {
      reconciled: true,
      changed: applied.applied,
      // The row's pin as it stands — liveHead when this call installed it,
      // whatever the other pass installed when it got there first.
      headSha: session.imported_pr_head_sha || liveHead,
      kind: move.kind,
      votesKept: applied.votesKept,
      checksCarry: applied.checksCarry,
    };
  } catch (err) {
    log.warn('pr-import-sync', 'reconcileImportedHead failed', {
      sessionId: session && session.id, err: err.message,
    });
    return { reconciled: false, reason: err.message };
  }
}

// The snapshot states that say a proposal is BLOCKED. Only these are worth
// re-reading on an unchanged head: 'clean' and 'behind' are settled answers,
// and re-deriving them every sweep would spend a compareCommits per open
// imported proposal per tick to learn nothing. A null snapshot is excluded
// too — it renders no banner and the merge-candidate ordering already reads
// it as clean, so there is no stale claim to correct.
//
// 'resolving' is deliberately absent: the conflict-resolver owns that state
// for as long as its attempt is in flight and transitions out of it itself,
// and overwriting it from here would race the resolver rather than help it.
const STRANDED_CONFLICT_STATES = new Set(['conflict', 'failed']);

// #1365 — the missing half of refreshDriftState's "the next sweep re-checks".
//
// That comment was never true for an imported row. refreshDriftState only
// ever runs from applyHeadChange, which only runs when the head MOVES, and
// it declines to write anything when GitHub answers `mergeable: null`.
// GitHub computes mergeability asynchronously and returns null for the first
// read after a push — which is exactly the read applyHeadChange makes,
// BECAUSE it fires when the head just moved. So the snapshot was written at
// the one moment GitHub was least likely to have an answer, and every later
// sweep returned at the unchanged-head check before reaching the re-check.
//
// The visible cost: an author who did what the card told them to do — resolve
// the conflict and push — kept being told "the last automatic conflict
// resolution failed" on a pull request that was by then a clean fast-forward,
// with no way out but pushing another commit and hoping the timing landed
// better (which clears the vote tally again, for nothing).
//
// So: on an unchanged head, if the stored snapshot still claims the proposal
// is blocked and GitHub has since made its mind up, re-derive it. Cheap by
// construction — a settled snapshot returns before any API call, and an
// undecided `mergeable` returns before the compareCommits, leaving the next
// sweep to try again.
async function refreshStrandedConflictState({ pool, session, pr, repo }) {
  if (!STRANDED_CONFLICT_STATES.has(session.merge_conflict_state || null)) return false;
  // Still computing. Nothing to write, and no reason to pay for drift here.
  if (pr.mergeable !== true && pr.mergeable !== false) return false;
  await refreshDriftState({ pool, session, pr, repo });
  log.info('pr-import-sync', 'Re-derived a stranded conflict snapshot on an unchanged head', {
    sessionId: session.id, prNumber: session.pr_number,
    was: session.merge_conflict_state, mergeable: pr.mergeable,
  });
  return true;
}

// Refresh the proposal card's behind_main + merge-conflict snapshot from
// GitHub, mirroring the native drift path (services/sync-main.js
// persistBehindMain / persistConflictState) — but WITHOUT a worker turn,
// because the platform doesn't own an imported PR's branch. behind_by comes
// from compareCommits(base…head); the conflict verdict from GitHub's
// mergeable flag (true → clean, false → conflict; null = still computing,
// left as-is for the next sweep).
async function refreshDriftState({ pool, session, pr, repo }) {
  const syncMain = require('./sync-main');
  const base = (pr.base && pr.base.ref) || 'main';
  const head = session.branch_name || (pr.head && pr.head.ref) || null;
  if (!head) return;

  let behindBy = null;
  try {
    const octokit = await activeGithub().getOctokit(repo.owner);
    const { data } = await octokit.rest.repos.compareCommits({
      owner: repo.owner, repo: repo.repo, base, head,
    });
    behindBy = Number.isFinite(data.behind_by) ? data.behind_by : null;
  } catch (err) {
    log.warn('pr-import-sync', 'compareCommits failed', { sessionId: session.id, err: err.message });
  }

  if (behindBy != null) {
    await syncMain.persistBehindMain(pool, session, behindBy);
  }

  // GitHub's mergeable is true / false / null (null = still being computed).
  if (pr.mergeable === true) {
    await syncMain.persistConflictState(pool, session, { state: 'clean', files: [] });
  } else if (pr.mergeable === false) {
    await syncMain.persistConflictState(pool, session, { state: 'conflict', files: [] });
  }
  // mergeable === null: leave the prior snapshot; the next sweep re-checks.
}

// Re-run the proposal's checks against the new head. Builds a fresh staging
// preview pinned to `newHead` (Slice 1's exact-SHA clone) and captures the
// checks against it — the same shape as the import-time kick — rather than
// re-checking the still-running old-head container, which would test the
// superseded code. Fire-and-forget at the capture layer, matching the
// import + dev-turn callers; a genuine build failure is recorded as a
// terminal 'error' verdict (recordStagingBootFailure) so the gate never
// dead-ends on a NULL/pending state.
async function rerunChecksForNewHead({ config, pool, session, newHead }) {
  const visuals = require('./visuals');
  const staging = require('./staging');
  const app = {
    id: session.app_id, slug: session.app_slug,
    name: session.app_name, repo_url: session.repo_url,
  };

  // Stamp 'pending' immediately so the badge stops showing the old-head
  // verdict while the (minutes-long) rebuild runs.
  await visuals.setChecksPending(pool, session.id, newHead, 'building', 'pr-import')
    .catch((err) => log.warn('pr-import-sync', 'setChecksPending failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    }));
  visuals.notifyChecksPending(session.id, newHead, 'building', 'pr-import');

  // #687: in mock-GitHub mode (staging previews) there is no real repo to
  // clone against the new head — record a gate-passing 'skipped' verdict
  // instead of building staging, so the head-change flow stays clickable.
  if (usesMockGithubForImports()) {
    await visuals.storeChecksSkipped(pool, session.id, newHead,
      'mock GitHub preview: automated checks not run')
      .catch((err) => log.warn('pr-import-sync', 'mock storeChecksSkipped failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      }));
    return;
  }

  let result;
  try {
    result = await staging.buildAndDeployStaging(config, session, app, newHead || 'latest');
  } catch (err) {
    const stagingRecovery = require('./staging-recovery');
    await stagingRecovery.recordStagingBootFailure({
      config, pool, session, commitHash: newHead || null, err,
    }).catch((e) => log.warn('pr-import-sync', 'recordStagingBootFailure failed (non-fatal)', {
      sessionId: session.id, err: e.message,
    }));
    notifyStagingFailed({ session, app });
    throw err;
  }

  // #866: the author can withdraw (or the group can close) the proposal
  // while a minutes-long rebuild runs. See kickImportedChecks for the full
  // rationale — persisting a preview onto a no-longer-open row leaks a
  // container and re-arms a Preview button on a dead proposal.
  if (!(await stillOpenForPreview(pool, session))) {
    await discardStagingResult({ staging, session, app, result });
    return;
  }

  await pool.query(
    `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
    [result.containerId, result.stagingUrl, session.id]
  );
  try {
    await staging.verifyStagingEdge(session, result.hostname, result.stagingUrl);
  } catch (_) { /* edge verification is best-effort */ }

  await visuals.captureForSession(config, session, app, newHead || null, result, { send: () => {}, trigger: 'pr-import' })
    .catch((err) => log.warn('pr-import-sync', 'checks capture failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    }));
}

// #866: is this proposal still one a staging preview belongs to?
//
// Re-read from the DB rather than trusting the in-memory `session` — it was
// loaded before a build that takes minutes. A withdrawn proposal is
// 'archived'; a merged one is 'merged'. Fails OPEN (returns true) if the row
// can't be read, so a transient DB hiccup never throws away a good build.
async function stillOpenForPreview(pool, session) {
  try {
    const { rows } = await pool.query(
      `SELECT status FROM chat_sessions WHERE id = $1`, [session.id]
    );
    const status = rows[0] ? rows[0].status : null;
    if (rows.length && status !== 'active' && status !== 'promoted' && status !== 'merging') {
      log.info('pr-import-sync', 'Imported PR is no longer live while its preview was building — discarding the build', {
        sessionId: session.id, status,
      });
      return false;
    }
    return true;
  } catch (err) {
    log.warn('pr-import-sync', 'post-build status re-check failed — keeping the build', {
      sessionId: session.id, err: err.message,
    });
    return true;
  }
}

// #866: throw away a preview that finished building for a proposal which is
// no longer open. Without this the row keeps a staging_container_id nothing
// will ever reclaim (the idle GC skips 'archived'/'merged' rows) and the card
// re-grows a Preview button pointing at a withdrawn proposal. The fresh
// runtime identity + URL are threaded in explicitly: the session object was
// fetched before the build, and Kubernetes returns no Docker container ID.
// teardownStaging needs the fresh runtime name before it can remove the
// deployment and safely drop the database derived from `staging_url`.
async function discardStagingResult({ staging, session, app, result }) {
  try {
    await staging.teardownStaging(
      {
        ...session,
        staging_container_id: result.containerId,
        staging_runtime_kind: result.runtimeKind || 'docker',
        staging_runtime_name: result.runtimeName || result.containerId,
        staging_url: result.stagingUrl,
      },
      { slug: app.slug }
    );
  } catch (err) {
    log.warn('pr-import-sync', 'discarding staging build failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  }
}

// #866: flip open proposal cards from "Preview building…" to "Preview
// unavailable" the moment a build fails, instead of leaving a spinner up
// until something else happens to refetch.
//
// The narration itself is NOT here: recordStagingBootFailure (called
// immediately before this, on both build paths) is the one chokepoint that
// posts the reason, and it is imported-aware — it routes an imported row's
// note to the group thread rather than the invisible dev-chat transcript,
// and it dedups to one post per failure streak. Duplicating the note here
// would double-post every import-time failure.
function notifyStagingFailed({ session, app }) {
  try {
    const { pushSessionUpdate } = require('./ws');
    pushSessionUpdate({
      action: 'staging_failed', sessionId: session.id,
      appSlug: (app && app.slug) || session.app_slug || null,
    });
  } catch (e) {
    log.warn('pr-import-sync', 'staging_failed notify failed (non-fatal)', {
      sessionId: session.id, err: e.message,
    });
  }
}

// #687 Slice 1 / #846 — the IMPORT-TIME checks kick. Called (un-awaited) by
// POST /api/apps/:slug/pr-import once the proposal row exists, so the route
// can answer immediately while the SHA-pinned staging build runs behind it.
// Sibling of rerunChecksForNewHead above — same sequence, same mock-mode
// short-circuit — kept here rather than inline in the route so it is
// testable on its own.
//
// #846: the staging_ready broadcast at the end is what makes an open
// proposal page grow its Preview pill the moment the build lands, instead of
// waiting minutes for the checks verdict to arrive and trigger a refetch.
// It must fire AFTER the staging_url persist: Caddy's on-demand TLS gate
// only approves a host once chat_sessions.staging_url equals it.
//
// Never throws — every failure is logged, and a genuine build failure is
// recorded as a terminal 'error' verdict by recordStagingBootFailure so the
// merge gate doesn't dead-end on a NULL/pending state.
async function kickImportedChecks({ config, pool, session, app, headSha }) {
  const visuals = require('./visuals');
  const staging = require('./staging');
  try {
    await visuals.setChecksPending(pool, session.id, headSha || null, 'building', 'pr-import')
      .catch((err) => log.warn('pr-import-sync', 'import setChecksPending failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      }));
    visuals.notifyChecksPending(session.id, headSha || null, 'building', 'pr-import');

    // #687 Slice 6: in mock-GitHub mode there is no real repo to clone, so
    // skip the staging build entirely and record a gate-passing 'skipped'
    // verdict — the imported proposal shows a neutral (mergeable) check so
    // the whole preview flow (import → vote → merge) is exercisable.
    if (usesMockGithubForImports()) {
      await visuals.storeChecksSkipped(pool, session.id, headSha || null,
        'mock GitHub preview: automated checks not run')
        .catch((err) => log.warn('pr-import-sync', 'import mock storeChecksSkipped failed (non-fatal)', {
          sessionId: session.id, err: err.message,
        }));
      return;
    }

    // #866: say out loud that a build started. This is the note that makes
    // the minutes between "proposal appeared" and "Preview button appeared"
    // legible — the card's "Preview building…" pill says the same thing, and
    // this leaves a timestamped trace in the thread for anyone who arrives
    // later or was looking at the discussion rather than the card.
    await postProposalNote(
      pool, session,
      `Building a staging preview for ${prLabel(session)} is being built. This usually takes a few minutes. `
        + 'The automated checks run against it, and a Preview button appears on this proposal when it\'s ready.',
      { stagingBuild: 'started', headSha: headSha || null }
    );

    let result;
    try {
      result = await staging.buildAndDeployStaging(config, session, app, headSha || 'latest');
    } catch (err) {
      const stagingRecovery = require('./staging-recovery');
      await stagingRecovery.recordStagingBootFailure({
        config, pool, session, commitHash: headSha || null, err,
      }).catch((e) => log.warn('pr-import-sync', 'import recordStagingBootFailure failed (non-fatal)', {
        sessionId: session.id, err: e.message,
      }));
      notifyStagingFailed({ session, app });
      throw err;
    }

    // #866: a proposal can be withdrawn (or merged) during the build. The
    // row we loaded minutes ago says 'promoted'; re-read before writing a
    // preview onto it. Persisting anyway would (a) leak the container —
    // the idle-GC sweep skips non-open statuses, so nothing would ever
    // reclaim it — and (b) put a live Preview button back on a card whose
    // vote is over.
    if (!(await stillOpenForPreview(pool, session))) {
      await discardStagingResult({ staging, session, app, result });
      return;
    }

    await pool.query(
      `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
      [result.containerId, result.stagingUrl, session.id]
    );
    await staging.verifyStagingEdge(session, result.hostname, result.stagingUrl);

    // #866: and that it landed. The URL rides in metadata rather than the
    // body — a preview host is long, ugly, and rotates on every rebuild,
    // while the Preview button on the card is the durable way in.
    await postProposalNote(
      pool, session,
      `The staging preview for ${prLabel(session)} is ready. Use the Preview button on this proposal to try the change. Automated checks are running against it now.`,
      { stagingBuild: 'ready', headSha: headSha || null, stagingUrl: result.stagingUrl }
    );

    // Tell any open proposal page the preview is live (see above for why
    // this is ordered after the persist). No chat_session_messages row: an
    // imported proposal has no transcript surface to render it.
    try {
      const { broadcastGlobal, pushSessionUpdate } = require('./ws');
      broadcastGlobal({
        type: 'session_event', sessionId: session.id,
        event: 'staging_ready', url: result.stagingUrl,
      });
      pushSessionUpdate({
        action: 'staging_ready', sessionId: session.id, appSlug: app.slug,
      });
    } catch (err) {
      log.warn('pr-import-sync', 'import staging_ready notify failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      });
    }

    visuals.captureForSession(config, session, app, headSha || null, result, { trigger: 'pr-import' })
      .catch((err) => log.warn('pr-import-sync', 'import visuals capture failed', {
        sessionId: session.id, err: err.message,
      }));
  } catch (err) {
    log.warn('pr-import-sync', 'import staging build failed', {
      sessionId: session.id, err: err.message,
    });
  }
}

module.exports = {
  syncImportedProposal,
  refreshStrandedConflictState,
  applyHeadChange,
  classifyImportedHeadMove,
  reconcileImportedHead,
  refreshDriftState,
  rerunChecksForNewHead,
  kickImportedChecks,
  parseRepo,
  // #866: exported for the thread-narration + withdrawn-mid-build tests.
  prLabel,
  postProposalNote,
  stillOpenForPreview,
  discardStagingResult,
  notifyStagingFailed,
};
