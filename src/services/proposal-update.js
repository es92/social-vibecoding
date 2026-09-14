'use strict';

// ── Updating a proposal that is already up for a vote (#1054) ──────────
//
// Until this existed, a connector-submitted proposal was a one-shot: an agent
// pushed a branch to its own fork, Homeroom copied that branch into the app's
// own repository and opened a pull request, and from then on the proposal
// tracked a BOT-OWNED branch the agent had no way to write to. The advice in
// get_proposal's own description — "fix the named tests and push again to the
// same branch" — was therefore false for exactly the proposals that most
// needed it: a failing check gates merge, and the agent that wrote the code
// could not land the one-line fix.
//
// So a proposal now has a stated BRANCH HOME, and when it is the app repo
// there is a path for its author to advance it:
//
//   the author pushes to their own fork, as always
//     → Homeroom verifies the fork branch is theirs and sits AHEAD of the
//       proposal's current head
//     → Homeroom pushes that branch onto the proposal's bot-owned branch
//       under a `--force-with-lease`, with the platform's own credentials
//     → the EXISTING head-moved machinery clears the votes, posts the
//       "please re-review" note and rebuilds the preview and the checks.
//
// Three properties this file exists to keep, all of them checked by
// tests/proposal-update.test.js:
//
//   1. NO USER GITHUB CREDENTIAL. The fork is read unauthenticated (it is
//      public) and the app repository is written with the platform's own bot
//      credential, resolved by services/external-agent-head.js exactly as
//      every other platform push resolves it. Nothing here asks for, stores
//      or forwards a token belonging to the user.
//   2. THE ATTRIBUTION GATE IS NEVER RELAXED. `verifyForkBranch` runs against
//      a FRESHLY READ `githubLink.linkStatus`, and `fork_owner` is that
//      linked login — never a value the caller passed in. It runs here for
//      the ancestry read and again inside `pushForkBranchToAppBranch`; there
//      is no path from a caller's arguments to a push that skips it.
//   3. NOTHING IS CLOBBERED. The push carries a lease pinned to the head this
//      call actually read from GitHub a moment earlier, so a proposal that
//      somebody else advanced in the meantime produces `branch_moved` rather
//      than a silently discarded revision.
//
// Deliberately NOT here: any call to services/sync-main.js's
// `recordPlatformPush`. The head this path installs is the AUTHOR'S work, so
// it must classify as an `author_push` and clear the tally. Recording it as a
// platform push would carry every existing approval onto code nobody in the
// group has read.

const log = require('./logger');
const externalAgentHead = require('./external-agent-head');
const { PROPOSAL_UPDATE_LOCK } = require('./advisory-locks');

const SHA_RE = /^[0-9a-f]{40}$/i;

// The two homes a proposal's head can live in.
//
//   'user_fork' — the head is a branch in the AUTHOR'S OWN fork. The platform
//                 only tracks it (`imported_pr_head_sha`); the author pushes
//                 to GitHub and the proposal follows.
//   'app_repo'  — the head is `branch_name` inside the app's own repository,
//                 and ONLY the platform bot can write it — which is why this
//                 file exists.
//
// This used to read `source === 'imported' ? 'user_fork' : 'app_repo'`, on the
// reasoning that the source column had always said which. It does not, and
// #1196 is what that cost: a connector submission runs the MIRROR rung in
// services/external-agent-head.js (the last rung then, the first one since
// task 153), which copies the agent's verified fork branch into a
// `usernode/from-…` branch in the APP repository, opens a same-repo pull
// request from the bot, and imports THAT. The row is
// `source='imported'` and its head is a branch the author cannot push to.
// get_proposal told the agent to push to a fork branch that does not exist,
// and submit_work — reading the same helper — dispatched to `advanceForkHead`,
// which correctly refused with `not_your_fork`. Both halves of that came from
// this one function.
//
// So the question is answered from WHERE THE HEAD ACTUALLY IS, which is
// recorded at import time (`imported_pr_head_repo`, added by #1196). Two rows
// cannot answer from it — one imported before the column existed, and one
// whose app has lost its repo_url — and those fall back to the branch
// namespace: `usernode/from-` and `usernode/patch-` are the platform's own
// prefixes for branches it writes into an app repository
// (services/external-agent-head.js), deliberately distinct from anything a
// person names a branch. `dev/` is NOT in that list: it is the native-session
// prefix, no imported row has it, and users name fork branches `dev/…` all
// the time.
const APP_REPO_BRANCH_PREFIXES = ['usernode/from-', 'usernode/patch-'];

function normalizeRepoName(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return null;
  const m = /^([a-z0-9._-]+)\/([a-z0-9._-]+?)(?:\.git)?$/.exec(raw);
  return m ? `${m[1]}/${m[2]}` : null;
}

// 'owner/repo' for an app's GitHub URL, in the same lowercase shape
// `normalizeRepoName` produces, so the two are comparable with `===`.
function repoNameFromUrl(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return null;
  const m = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(raw);
  return m ? normalizeRepoName(`${m[1]}/${m[2]}`) : null;
}

function platformOwnedBranch(name) {
  const branch = String(name == null ? '' : name).trim();
  return APP_REPO_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix));
}

// The owner half of the head repository, when it is known. This is the value
// `advanceForkHead` compares against the freshly-read linked login, and it is
// what makes `authorCanPush` agree with the gate rather than approximate it.
function headRepoOwnerOf(session) {
  const repo = normalizeRepoName(session && session.imported_pr_head_repo);
  return repo ? repo.split('/')[0] : null;
}

function branchHomeOf(session) {
  if (String(session && session.source) !== 'imported') return 'app_repo';
  const headRepo = normalizeRepoName(session.imported_pr_head_repo);
  const appRepo = repoNameFromUrl(session.repo_url);
  if (headRepo && appRepo) return headRepo === appRepo ? 'app_repo' : 'user_fork';
  return platformOwnedBranch(session.branch_name) ? 'app_repo' : 'user_fork';
}

// Can the author move this proposal's head with a plain `git push`?
//
// The honest answer is the one `advanceForkHead` will give when they try, so
// this asks its question: the head has to be in a repository owned by the
// GitHub account linked to the caller's profile. `viewerLogin` is that login,
// freshly read by whoever is reporting; when it or the head owner is unknown
// there is nothing to disprove and a fork home still answers true — the same
// answer this returned before #1196, and the refusal still comes from the gate
// rather than from a guess made here.
function authorCanPush(session, viewerLogin) {
  if (branchHomeOf(session) !== 'user_fork') return false;
  const owner = headRepoOwnerOf(session);
  const login = String(viewerLogin == null ? '' : viewerLogin).trim();
  if (!owner || !login) return true;
  return externalAgentHead.sameLogin(owner, login);
}

// Is the pull request under this row the CALLER's OWN (#1319)? Only an
// imported row can carry somebody else's — a native proposal's PR is one the
// platform opened for this author — and for an imported one the honest test
// is the head repository's owner against the caller's freshly-read GitHub
// login, the same comparison authorCanPush makes. An unknown owner or an
// unknown login leaves nothing to disprove, and ownershipGate has already
// established that the caller owns the row, so it answers true rather than
// refusing an author their own name.
function callerOwnsPr(session, viewerLogin) {
  if (String(session && session.source) !== 'imported') return true;
  const owner = headRepoOwnerOf(session);
  const login = String(viewerLogin == null ? '' : viewerLogin).trim();
  if (!owner || !login) return true;
  return externalAgentHead.sameLogin(owner, login);
}

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

// `verifyForkBranch` and `pushForkBranchToAppBranch` speak the mirror path's
// vocabulary. This path's refusals are named for what the CALLER did wrong,
// so the two fork-shaped codes are renamed and everything else — including
// `branch_moved`, `invalid_request` and `platform_unavailable` — is passed
// through with its message intact.
function renameHeadFailure(result, branch) {
  if (result.code === 'fork_mismatch') {
    return fail(
      'not_your_fork',
      `${branch} was not found in a repository owned by the GitHub account linked to your Homeroom profile. `
      + 'A proposal is only advanced from its author\'s own fork. Push the branch to your fork and try again.',
      { retryable: false }
    );
  }
  if (result.code === 'branch_not_found') {
    return fail(
      'fork_branch_not_found',
      `Your fork has no branch called ${branch}. Push it first: GitHub creates branches on push, and Homeroom `
      + 'reads it from your fork rather than from your machine.',
      { retryable: true }
    );
  }
  return fail(result.code, result.message, {
    ...(result.retryable ? { retryable: true } : {}),
  });
}

// ── The lock ───────────────────────────────────────────────────────────
//
// Two agents can hold the same proposal id: the coding agent that wrote the
// change and the chat assistant the user told about it. Without this they
// both read the same head, both pass the lease check, and the second push
// either loses its own commits or lands on a proposal whose votes were
// cleared for a revision that no longer exists.
//
// Keyed on the SESSION id, on a dedicated client, held across the whole
// update and released in `finally` — the same shape as
// external-agent-tasks.js's task lock, and for the same reason: a git fetch
// and push take seconds of network, and holding a transaction open across
// that is worse than the race it prevents. Degrades to running unlocked when
// the pool has no `connect()`, which is never a reason to refuse an update.
async function withProposalLock(pool, sessionId, fn) {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0 || !pool || typeof pool.connect !== 'function') {
    return fn();
  }
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    log.warn('proposal-update', 'update lock unavailable, proceeding unlocked', {
      sessionId: id, err: err.message,
    });
    return fn();
  }
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [PROPOSAL_UPDATE_LOCK, id]);
    return await fn();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [PROPOSAL_UPDATE_LOCK, id]);
    } catch { /* releasing the client drops the session lock anyway */ }
    client.release();
  }
}

// The proposal, re-read under the lock. The caller's copy was loaded before
// the queue, and in the seconds spent waiting it may have merged, closed, or
// moved its head — so every gate below is applied to THIS row. Best-effort:
// a read that fails leaves the caller's copy in place rather than refusing an
// update over a transient database hiccup.
async function reloadSession(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
              a.collab_visibility, a.view_visibility
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
        WHERE cs.id = $1`,
      [sessionId]
    );
    return rows[0] || null;
  } catch (err) {
    log.warn('proposal-update', 'proposal re-read failed, using the caller\'s snapshot', {
      sessionId, err: err.message,
    });
    return null;
  }
}

// How many votes the update is about to invalidate. Counted BEFORE the write,
// because both reconciliation paths delete the rows — and "your update
// cleared 4 votes" is the one consequence the caller must be able to relay to
// the user without guessing.
async function countVotes(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pr_votes WHERE session_id = $1`,
      [sessionId]
    );
    return Number(rows[0] && rows[0].n) || 0;
  } catch {
    return 0;
  }
}

// deps: { pool, config, gh, githubLink, head, votes, prImportSync,
//         githubPublic, serialize, busy, beginOperation }
//   Everything after `pool`/`config` is injectable purely so the tests can
//   drive this without a database, a git binary or a GitHub account; the
//   defaults are the real modules.
//
// params: { user, session, branch, forkRepo, expectedHeadSha, testing, origin }
//   `session` is the joined chat_sessions row the route loaded and
//   access-checked. `branch` is the branch in the caller's OWN fork that
//   carries the new work. `forkRepo` is only its NAME, for an agent that
//   forked under a name the platform did not predict — the OWNER always
//   comes from the verified GitHub link. `testing` is the revision's capture
//   routes and steps, already validated by services/testing-notes.js's
//   `parseSubmitted` — see applyTestingMetadata.
async function updateProposalFromForkBranch(deps, params) {
  const { pool, config } = deps;
  const gh = deps.gh || require('./github');
  const githubLink = deps.githubLink || require('./github-link');
  const head = deps.head || externalAgentHead;
  const votes = deps.votes || require('../routes/votes');
  const prImportSync = deps.prImportSync || require('./pr-import-sync');
  const githubPublic = deps.githubPublic || require('./external-agent-tasks').githubPublic;
  const serialize = deps.serialize
    || require('./handoff-pipeline').serializeHandoffSubmission;

  const { user, origin } = params;

  // ── Argument shapes, before anything is read ─────────────────────────
  //
  // The branch name reaches a `git fetch` argv and the fork name reaches a
  // URL path, so both are validated by the same predicates the submit path
  // uses. One definition, in services/external-agent-head.js.
  const branch = params.branch ? String(params.branch).trim() : '';
  if (!head.validRef(branch)) {
    return fail('invalid_request', 'branch must be the git branch you pushed to your fork.');
  }
  const forkRepoName = params.forkRepo ? String(params.forkRepo).trim() : null;
  if (forkRepoName && !head.validSegment(forkRepoName)) {
    return fail('invalid_request', 'That fork name is not a valid GitHub repository name.');
  }
  const expectedHeadSha = params.expectedHeadSha
    ? String(params.expectedHeadSha).trim().toLowerCase()
    : null;
  if (expectedHeadSha && !SHA_RE.test(expectedHeadSha)) {
    return fail('invalid_request', 'expectedHeadSha must be a 40-character commit id.');
  }

  const gate = ownershipGate(params.session, user);
  if (gate) return gate;

  if (!gh.isEnabled()) {
    return fail('platform_unavailable', 'Homeroom cannot reach GitHub right now. Try again shortly.', { retryable: true });
  }
  // An unconfigured deployment and an unlinked user are two different
  // refusals, and the deployment is checked first — otherwise an operator's
  // missing value is reported as the user's missing click.
  if (!githubLink.isEnabled(config)) {
    return fail(
      'github_link_unavailable',
      'This Homeroom deployment has no GitHub OAuth app configured, so it cannot verify which GitHub account is '
      + 'yours, and a proposal is only advanced from its author\'s verified fork. Ask an admin to set '
      + 'GITHUB_LINK_CLIENT_ID and GITHUB_LINK_CLIENT_SECRET in the platform variables panel.',
      { retryable: false }
    );
  }

  // FRESHLY READ, every time, and the only source of the fork owner. A
  // linked account can be disconnected or re-linked to a different GitHub
  // login between the submission that opened this proposal and this update.
  const link = await githubLink.linkStatus(pool, user.id);
  if (!link || !link.linked || !link.login) {
    return fail(
      'github_not_linked',
      'Connect your GitHub account first: Homeroom only advances a proposal from a fork it can confirm is yours.',
      { ...(origin ? { settingsUrl: `${origin}/#settings/connectors` } : {}) }
    );
  }

  const sessionId = Number(params.session.id);
  return serialize(sessionId, () => withProposalLock(pool, sessionId, async () => {
    // Everything from here on judges the row as it is NOW, not as it was
    // when the caller queued.
    const session = (await reloadSession(pool, sessionId)) || params.session;
    const reGate = ownershipGate(session, user);
    if (reGate) return reGate;

    const parsed = gh.parseGithubUrl(session.repo_url);
    if (!parsed) {
      return fail('no_repository', 'That app has no GitHub repository, so its proposals have no branch to advance.');
    }
    const { owner, repo } = parsed;
    const forkRepo = forkRepoName || repo;

    const busy = deps.busy || defaultBusyCheck;
    if (busy(session)) {
      return fail(
        'session_busy',
        'This proposal is in the middle of a build right now. Retry in a minute. Pushing onto it mid-build '
        + 'would leave its preview and its checks describing two different commits.',
        { retryable: true }
      );
    }

    const beginOperation = deps.beginOperation
      || require('./active-workers').beginSessionOperation;
    const releaseOperation = beginOperation(sessionId);
    try {
      const ctx = {
        pool, config, gh, head, votes, prImportSync, githubPublic,
        session, owner, repo, forkOwner: link.login, forkRepo, branch,
        expectedLogin: link.login, expectedHeadSha, sessionId,
        testing: normalizeTesting(params.testing),
        title: normalizeProposedTitle(params.title),
        description: normalizeProposedDescription(params.description),
        // #1323. A re-run of the checks against the commit already there.
        recheck: params.recheck === true,
        linkedIssues: normalizeLinkedIssues(params.linkedIssues),
        // The one module the same-commit resubmit path needs and no other
        // path does: re-running the checks against corrected capture routes
        // is the same operation the "Re-run checks" button performs.
        recovery: deps.recovery,
        // Carried through so the session tails' three real-work modules stay
        // injectable from the caller's deps — sessionParts() below fills in
        // the live modules for every key nobody overrode.
        visuals: deps.visuals,
        pipeline: deps.pipeline,
        lifecycle: deps.lifecycle,
        pushSessionUpdate: deps.pushSessionUpdate,
      };
      return branchHomeOf(session) === 'user_fork'
        ? await advanceForkHead(ctx)
        : await advanceAppRepoBranch(ctx);
    } finally {
      releaseOperation();
    }
  }));
}

// A managed local upload has already advanced the bot-owned PR branch. Apply
// the same reviewed-head reconciliation as update-from-fork, including the
// atomic stale-vote deletion, but defer the expensive check run until
// proposal_submit_build. That preserves the oldest-first multi-commit upload
// contract without leaving any approval attached to the earlier SHA.
async function reconcileManagedCommitUpload(deps, params) {
  const votes = deps.votes || require('../routes/votes');
  const expectedHeadSha = String(params.expectedHeadSha || '').toLowerCase();
  const revision = await votes.reconcileNativeReviewedHead({
    config: deps.config,
    pool: deps.pool,
    session: params.session,
    fresh: true,
    notify: true,
    deferChecks: true,
  });
  if (revision.blocked) {
    return fail(
      revision.transient ? 'platform_unavailable' : 'proposal_closed',
      revision.reason || 'Homeroom could not reconcile the proposal revision.',
      { retryable: !!revision.transient }
    );
  }
  const reconciledHead = String(revision.headSha || '').toLowerCase();
  if (!SHA_RE.test(expectedHeadSha) || reconciledHead !== expectedHeadSha) {
    return fail(
      'branch_moved',
      reconciledHead
        ? `The proposal branch moved again to commit ${reconciledHead.slice(0, 8)} while this upload was being reconciled.`
        : 'Homeroom could not pin the promoted proposal to the uploaded commit.',
      { retryable: false, ...(reconciledHead ? { headSha: reconciledHead } : {}) }
    );
  }
  return { ok: true, ...revision };
}

// ── The revision's testing metadata (#1199) ────────────────────────────
//
// A revision changes which SCREEN the group should be looking at, so the
// capture routes travel with it. Until this existed they did not: submit_work
// accepted `testingPaths`, the update path dropped them on the floor, and
// chat_sessions.testing_paths kept whatever the FIRST submission said — NULL
// for a proposal imported without any. The capture then fell back to '/' and
// set `captureDefaultedToRoot`, so a change to a dialog behind a deep link was
// voted on from screenshots of the app's home page.
//
// Three properties this pair of functions keeps:
//
//   1. OMISSION IS NOT ERASURE. An update that says nothing about testing
//      leaves the stored routes and steps exactly as they are — the common
//      case is a one-line fix to a failing check, and it must not blank the
//      routes the first submission got right.
//   2. THE WRITE HAPPENS BEFORE THE CAPTURE. Every tail below ends in
//      visuals.captureForSession, which reads `session.testing_paths` off the
//      IN-MEMORY row it is handed — so the row is mutated here as well as
//      written, or the run that follows a successful update still shoots the
//      old routes.
//   3. IT IS NEVER THE REASON AN UPDATE FAILS. The commit is already on the
//      branch by the time this runs; a metadata write that throws is logged
//      and reported as `testingUpdated: false`.

// Re-run the shared validator over whatever the caller handed in. The route
// has already parsed it, and this is idempotent — but proposal-update.js is
// also called by the browser twin, and nothing unvalidated may reach a column
// the capture step later loads into an iframe URL.
function normalizeTesting(testing) {
  if (!testing || typeof testing !== 'object') return null;
  const notes = require('./testing-notes');
  const parsed = notes.parseSubmitted({
    testingPaths: Array.isArray(testing.testingPaths) ? testing.testingPaths : undefined,
    testingSteps: typeof testing.testingSteps === 'string' ? testing.testingSteps : testing.testingMd,
  });
  // The caller parsed the RAW body and this re-parse sees its already-shaped
  // output, so anything the caller rejected is invisible here — carry its list
  // rather than recomputing an empty one (#1214). An entry this second pass
  // drops is added to it; in practice there is none, which is the point.
  const dropped = [
    ...(Array.isArray(testing.dropped) ? testing.dropped : []),
    ...parsed.dropped,
  ];
  if (!parsed.provided) return dropped.length ? { ...parsed, dropped } : null;
  return { ...parsed, dropped };
}

// The stored list and the submitted one, compared in the normalized
// { path, viewport } shape so a row written before #768 (plain strings)
// doesn't read as a change against the same routes resubmitted today.
function samePaths(stored, next) {
  const notes = require('./testing-notes');
  const current = (Array.isArray(stored) ? stored : [])
    .map((entry) => notes.normalizeStoredPath(entry))
    .filter(Boolean);
  if (current.length !== next.length) return false;
  return current.every((entry, i) => entry.path === next[i].path && entry.viewport === next[i].viewport);
}

// The submitted routes in the form the caller wrote them, for the response.
// An agent that reads back exactly what it sent can tell at a glance that the
// annotation it added survived. One spelling of that, in testing-notes.js,
// shared with the connector's own response (#1214).
function displayPaths(paths) {
  return require('./testing-notes').displayPaths(paths);
}

// The routes that did NOT become capture routes, each with its reason, for the
// same response (#1214). Null when nothing was rejected, so a caller that
// branches on it never has to distinguish an empty list from "all fine".
function rejectedPaths(testing) {
  return require('./testing-notes').explainDrops(testing && testing.dropped);
}

// The title the agent submitted with the work, in the shape the PR will
// carry it: trimmed, single-spaced, GitHub's title length. Null when absent
// or empty — the caller then leaves the stored value alone.
function normalizeProposedTitle(title) {
  if (typeof title !== 'string') return null;
  const t = title.trim().replace(/\s+/g, ' ').slice(0, 256);
  return t || null;
}

// The description the group reads, clipped to the same 4000 the create path's
// PR body takes. Empty after trimming is "said nothing", never "blank it".
function normalizeProposedDescription(description) {
  if (typeof description !== 'string') return null;
  const t = description.trim().slice(0, 4000);
  return t || null;
}

// Apply the submitted title. Two cases, both author-initiated (the update
// path's ownership gate has already run):
//
//   - No PR yet: store it as the name the lazily-created PR will take at
//     propose time (chat_sessions.proposed_pr_title; used by
//     routes/votes.js's promote path via pr-metadata's preferredTitle).
//   - A PR exists: RENAME it — pr_title/session_title in the panel, the PR
//     on GitHub best-effort after. This is how an auto-titled proposal
//     ("Initialize repository" over a Klondike rebuild — PR #171) gets its
//     real name back: the title-heal sweeper already renames PRs while
//     votes stand, so an author's own rename moves nothing new, and not one
//     line of code changes with it. Clearing pr_title_fallback keeps the
//     sweeper from re-renaming a deliberate name.
//
// WHOSE PULL REQUEST IS IT (#1319). `source === 'imported'` is NOT the same
// question as "somebody else's pull request", and reading it as one disabled
// the rename for the entire external-agent path: branchHomeOf marks a row
// 'user_fork' ONLY when it is imported, so every proposal an agent pushes
// from its author's own fork is an imported row. The question that actually
// separates the two is whose repository the head branch sits in — the one
// authorCanPush asks, and the one advanceForkHead has already answered by the
// time a rename reaches here. An external contributor's pull request keeps
// its author's title, and the caller is TOLD that it did.
//
// Returns { changed, rejected }: `rejected` names why a rename was refused,
// so the caller reports it instead of returning a success shape that quietly
// dropped the field. Mirrors applyTestingMetadata's contract otherwise:
// mutates the in-memory row, no-ops on same-value, and a failed write is
// logged, never fatal to an update that landed.
async function applyProposedTitle({ pool, gh, session, owner, repo, title, viewerLogin }) {
  const nothing = { changed: false, rejected: null };
  if (!title) return nothing;
  if (session.pr_number) {
    if (!callerOwnsPr(session, viewerLogin)) {
      log.info('proposal-update', 'left an imported proposal\'s title to its external author', {
        sessionId: Number(session.id), prNumber: session.pr_number,
      });
      return { changed: false, rejected: 'imported_pr' };
    }
    if ((session.pr_title || null) === title) return nothing;
    try {
      await pool.query(
        'UPDATE chat_sessions SET pr_title = $1, session_title = $1, pr_title_fallback = FALSE WHERE id = $2',
        [title, Number(session.id)]
      );
    } catch (err) {
      log.error('proposal-update', 'could not rename the proposal', {
        sessionId: Number(session.id), err: err.message,
      });
      return { changed: false, rejected: 'write_failed' };
    }
    session.pr_title = title;
    session.session_title = title;
    session.pr_title_fallback = false;
    // The panel is renamed either way; GitHub is the cosmetic mirror.
    try {
      await gh.updatePR(owner, repo, session.pr_number, { title });
    } catch (err) {
      log.warn('proposal-update', 'panel renamed but the GitHub PR title update failed', {
        sessionId: Number(session.id), prNumber: session.pr_number, err: err.message,
      });
    }
    log.info('proposal-update', 'renamed the proposal to the submitted title', {
      sessionId: Number(session.id), prNumber: session.pr_number,
    });
    return { changed: true, rejected: null };
  }
  if ((session.proposed_pr_title || null) === title) return nothing;
  try {
    await pool.query(
      'UPDATE chat_sessions SET proposed_pr_title = $1 WHERE id = $2',
      [title, Number(session.id)]
    );
  } catch (err) {
    log.error('proposal-update', 'could not store the revision\'s proposed title', {
      sessionId: Number(session.id), err: err.message,
    });
    return { changed: false, rejected: 'write_failed' };
  }
  session.proposed_pr_title = title;
  log.info('proposal-update', 'stored the revision\'s proposed title', {
    sessionId: Number(session.id),
  });
  return { changed: true, rejected: null };
}

// Apply the submitted description (#1323). submit_work has always ACCEPTED a
// description on an update and never done anything with it: submitUpdate did
// not forward it, so the body the group votes on kept whatever the FIRST
// submission said. That is the title bug (#1319) on the surface that matters
// more — voters read the description — and it was invisible for the same
// reason, a success-shaped answer that mentioned nothing.
//
// Whose PR it is decides this exactly as it decides a rename, through the same
// callerOwnsPr: an external contributor's body is theirs.
//
// The two MANAGED blocks survive. `Closes #N` is rebuilt from the keywords
// already in the body, and the marker-delimited "Before / after" block the
// capture upserts is carried across verbatim — replacing a body wholesale
// would drop the screenshots the group is looking at, which is a worse bug
// than the one being fixed.
async function applyProposedDescription({ pool, gh, session, owner, repo, description, viewerLogin }) {
  const nothing = { changed: false, rejected: null };
  if (!description) return nothing;
  if (!session.pr_number) {
    // No PR yet: the body is built at promote time from the task, so there is
    // nothing to rewrite and nothing to mirror.
    return { changed: false, rejected: 'no_pr_yet' };
  }
  if (!callerOwnsPr(session, viewerLogin)) return { changed: false, rejected: 'imported_pr' };

  const prMetadata = require('./pr-metadata');
  let existing = '';
  try {
    const pr = await gh.getPR(owner, repo, session.pr_number);
    existing = String((pr && pr.body) || '');
  } catch (err) {
    log.warn('proposal-update', 'could not read the pull request body to rewrite it', {
      sessionId: Number(session.id), prNumber: session.pr_number, err: err.message,
    });
    return { changed: false, rejected: 'github_unreadable' };
  }

  const visuals = prMetadata.extractVisualsBlock(existing);
  const closing = prMetadata.buildClosingBlock(prMetadata.parseClosingKeywords(existing));
  let body = closing ? `${description}\n\n${closing}` : description;
  if (visuals) body = prMetadata.upsertVisualsBlock(body, visuals);
  if (body === existing) return nothing;

  try {
    await gh.updatePR(owner, repo, session.pr_number, { body });
  } catch (err) {
    log.warn('proposal-update', 'could not rewrite the pull request body', {
      sessionId: Number(session.id), prNumber: session.pr_number, err: err.message,
    });
    return { changed: false, rejected: 'github_write_failed' };
  }
  // Mirrored so get_proposal can report it without a GitHub call on a path
  // agents poll. Best-effort: the body on GitHub is the source of truth and it
  // is already updated, so a failed mirror must not fail the update.
  try {
    await pool.query('UPDATE chat_sessions SET pr_body = $1 WHERE id = $2', [body, Number(session.id)]);
    session.pr_body = body;
  } catch (err) {
    log.warn('proposal-update', 'pull request body updated but the mirror write failed', {
      sessionId: Number(session.id), err: err.message,
    });
  }
  log.info('proposal-update', 'rewrote the proposal description', {
    sessionId: Number(session.id), prNumber: session.pr_number,
  });
  return { changed: true, rejected: null };
}

// Writes only the columns the caller actually supplied, and mutates the
// in-memory row to match. Returns { changed, pathsChanged, stepsChanged,
// paths } — `changed` false when nothing was supplied OR when what was
// supplied is what the row already said, which is what stops a duplicate
// resubmit from kicking a pointless capture run.
async function applyTestingMetadata({ pool, session, testing }) {
  const unchangedResult = (paths) => ({
    changed: false, pathsChanged: false, stepsChanged: false, paths: paths || null,
  });
  if (!testing) return unchangedResult(null);

  const pathsChanged = !!testing.testingPaths && !samePaths(session.testing_paths, testing.testingPaths);
  const stepsChanged = !!testing.testingMd && String(session.testing_md || '') !== testing.testingMd;
  if (!pathsChanged && !stepsChanged) return unchangedResult(testing.testingPaths);

  const sets = [];
  const values = [];
  if (pathsChanged) {
    values.push(JSON.stringify(testing.testingPaths));
    sets.push(`testing_paths = $${values.length}::jsonb`);
    values.push(testing.testingPath);
    sets.push(`testing_path = $${values.length}`);
  }
  if (stepsChanged) {
    values.push(testing.testingMd);
    sets.push(`testing_md = $${values.length}`);
  }
  values.push(Number(session.id));
  try {
    await pool.query(`UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
  } catch (err) {
    log.error('proposal-update', 'could not store the revision\'s testing metadata', {
      sessionId: Number(session.id), err: err.message,
    });
    return unchangedResult(testing.testingPaths);
  }

  // Property 2 above: the tails hand THIS object to captureForSession.
  if (pathsChanged) {
    session.testing_paths = testing.testingPaths;
    session.testing_path = testing.testingPath;
  }
  if (stepsChanged) session.testing_md = testing.testingMd;

  log.info('proposal-update', 'stored the revision\'s testing metadata', {
    sessionId: Number(session.id), pathsChanged, stepsChanged,
    paths: displayPaths(testing.testingPaths),
  });
  return { changed: true, pathsChanged, stepsChanged, paths: testing.testingPaths || null };
}

// ── The request this revision implements (#1310) ───────────────────────
//
// #1217 linked a proposal to the request it was built from — the task's issue
// number becomes `Closes #N` in the PR body and `chat_sessions.linked_issues`
// on the row — but only on the CREATE path. An update dropped it on the
// floor, the same shape of loss #1199 names for the capture routes above.
//
// The case that shipped broken (recipebot-33b169 issue #45): a work-order
// continuation of a dev SESSION has no PR yet. Its PR is created lazily at
// promote time by pr-metadata's applyPrMetadata, whose `Closes #N` block is
// built from chat_sessions.linked_issues — which nothing on the update path
// had written. The PR opened without the closing line, GitHub never linked
// the issue, and it had to be closed by hand after the merge.
//
// Same properties as the testing pair above: omission is not erasure (an
// update that names no request leaves the stored set alone, and nothing is
// ever REMOVED here — a scope cut is declared on a build turn, #733); the
// write happens before the tails (promotion reads the row this mutates); and
// it is never the reason an update fails.
//
// Re-sanitized here whatever the route already did, for normalizeTesting's
// reason: this service is also called by the browser twin, and nothing
// unvalidated may reach an integer[] column. pr-metadata is required lazily —
// it pulls in the LLM stack, and only this pair of functions needs it.
function normalizeLinkedIssues(linkedIssues) {
  return require('./pr-metadata').sanitizeIssueNumbers(linkedIssues);
}

// Update the issue associations on a session that already exists (#2028).
// This is the one write shared by the browser, the hosted connector and the
// older update-from-fork path below. `linked_issues` is the durable source of
// truth; the PR body is a best-effort projection of it while a native PR is
// still open.
//
// Additions and removals are DELTAS, not a replacement list. That matters to
// agents and browser tabs working from a recently-read proposal: an unrelated
// link added in between is preserved. Removal wins when a number appears in
// both lists, matching applyIssueDeclarations and the dev-session dispatch
// tools. The route bounds the final list to 50; the service sanitizes again so
// no second caller can put malformed values into the integer[] column.
async function updateLinkedIssues({
  pool, gh, session, owner, repo, addIssues, removeIssues,
}) {
  const prMetadata = require('./pr-metadata');
  const existing = prMetadata.sanitizeIssueNumbers(session.linked_issues);
  const adds = prMetadata.sanitizeIssueNumbers(addIssues);
  const removes = prMetadata.sanitizeIssueNumbers(removeIssues);
  const linkedIssues = prMetadata.applyIssueDeclarations(existing, adds, removes);
  const added = linkedIssues.filter((n) => !existing.includes(n));
  const removed = existing.filter((n) => !linkedIssues.includes(n));
  const changed = !prMetadata.sameIssueSet(linkedIssues, existing);
  if (changed) {
    await pool.query(
      'UPDATE chat_sessions SET linked_issues = $1 WHERE id = $2',
      [linkedIssues, Number(session.id)]
    );
    session.linked_issues = linkedIssues;
    log.info('proposal-update', 'stored the proposal\'s linked issues', {
      sessionId: Number(session.id), linkedIssues,
    });
  }

  const result = {
    changed,
    linkedIssues,
    addedIssues: added,
    removedIssues: removed,
    prBodyUpdated: false,
    prBodyStatus: 'no_pr',
  };

  // A row with no PR is done: the closing block is assembled from the row
  // when the PR is created (pr-metadata.applyPrMetadata at promote time). A
  // row with a LIVE PR gets a targeted body append instead — GitHub only
  // acts on a closing keyword while the PR is open, so waiting for the next
  // full body regeneration (a dev turn this proposal may never take) could
  // miss the merge. Only numbers the body does not already declare are
  // appended, via the same parser the migrate-time backfill trusts, so a
  // hand-written "Fixes #N" is never doubled. Imported PRs are skipped:
  // that body belongs to its external author on GitHub. Best-effort like
  // the GitHub rename above — the row is the source of truth either way.
  if (!session.pr_number) return result;
  if (String(session.source) === 'imported') {
    result.prBodyStatus = 'imported_pr';
    return result;
  }

  let pr;
  try {
    pr = await gh.getPR(owner, repo, Number(session.pr_number));
  } catch (err) {
    result.prBodyStatus = 'github_unavailable';
    log.warn('proposal-update', 'stored the linked issues but could not read the PR body', {
      sessionId: Number(session.id), prNumber: Number(session.pr_number), err: err.message,
    });
    return result;
  }
  const open = pr && !pr.merged && (!pr.state || pr.state === 'open');
  if (!open) {
    result.prBodyStatus = 'pr_not_open';
    return result;
  }

  const previousBody = pr && typeof pr.body === 'string' ? pr.body : '';
  const appliedBefore = prMetadata.sanitizeIssueNumbers(session.pr_linked_issues_applied);
  // Only remove exact `Closes #N` lines the applied snapshot says Usernode
  // previously projected. Other closing-keyword forms remain the PR author's.
  // Use the requested deltas as repair candidates too. If the association
  // write succeeded but GitHub was temporarily unavailable, repeating the
  // same idempotent call must repair the body rather than stop at “already
  // linked”.
  const managedRemovals = removes.filter((n) => appliedBefore.includes(n));
  let nextBody = prMetadata.stripClosingLines(previousBody, managedRemovals);
  if (nextBody !== previousBody) {
    nextBody = nextBody.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
  }
  const declared = prMetadata.parseClosingKeywords(nextBody);
  const requestedAdds = adds.filter((n) => linkedIssues.includes(n));
  const missing = requestedAdds.filter((n) => !declared.includes(n));
  if (missing.length) {
    const closing = prMetadata.buildClosingBlock(missing);
    nextBody = nextBody ? `${nextBody}\n\n${closing}` : closing;
  }

  try {
    if (nextBody !== previousBody) {
      await gh.updatePR(owner, repo, Number(session.pr_number), { body: nextBody });
      result.prBodyUpdated = true;
      try {
        await pool.query(
          'UPDATE chat_sessions SET pr_body = $1 WHERE id = $2',
          [nextBody || null, Number(session.id)]
        );
        session.pr_body = nextBody || null;
      } catch (err) {
        log.warn('proposal-update', 'PR issue links changed but its body mirror did not', {
          sessionId: Number(session.id), err: err.message,
        });
      }
    }

    // Keep pr-metadata's drift gate truthful: every surviving association
    // that was already applied, and every new association now declared in the
    // live body, belongs in the snapshot. Removed links are subtracted.
    const bodyIssues = prMetadata.parseClosingKeywords(nextBody);
    const applied = prMetadata.sanitizeIssueNumbers([
      ...appliedBefore.filter((n) => linkedIssues.includes(n)),
      ...requestedAdds.filter((n) => bodyIssues.includes(n)),
    ]);
    if (!prMetadata.sameIssueSet(applied, appliedBefore)) {
      await pool.query(
        'UPDATE chat_sessions SET pr_linked_issues_applied = $1 WHERE id = $2',
        [applied, Number(session.id)]
      );
      session.pr_linked_issues_applied = applied;
    }
    result.prBodyStatus = result.prBodyUpdated ? 'updated' : 'already_current';
  } catch (err) {
    result.prBodyStatus = 'github_unavailable';
    log.warn('proposal-update', 'stored the linked issues but could not patch the PR body', {
      sessionId: Number(session.id), prNumber: Number(session.pr_number), err: err.message,
    });
  }
  return result;
}

// The update-from-fork path predates #2028 and intentionally treats issue
// linkage as best-effort metadata: a GitHub or database hiccup must not reject
// an otherwise valid code update. Keep its boolean contract while routing the
// actual mutation through the shared implementation above.
async function applyLinkedIssues({ pool, gh, session, owner, repo, linkedIssues }) {
  const prMetadata = require('./pr-metadata');
  const adds = prMetadata.sanitizeIssueNumbers(linkedIssues);
  if (!adds.length) return false;
  try {
    const result = await updateLinkedIssues({
      pool, gh, session, owner, repo, addIssues: adds, removeIssues: [],
    });
    return result.changed;
  } catch (err) {
    log.error('proposal-update', 'could not store the revision\'s linked issues', {
      sessionId: Number(session.id), err: err.message,
    });
    return false;
  }
}

// ── A resubmit that moves nothing (#1199) ──────────────────────────────
//
// The fork branch is already this proposal's head. That has always been a
// success rather than an error — an agent that submits twice, or a user who
// relays "it's pushed" after the agent already did, must not be told their
// work is missing — but it was also a total no-op, and that made a proposal
// whose screenshots came out wrong UNFIXABLE: the routes are only read when a
// capture runs, a capture only runs when the head moves, and the head cannot
// move for a change that is already correct. The advice left was "push an
// empty commit", which clears every vote the proposal has collected to correct
// a screenshot.
//
// So a resubmit that carries DIFFERENT testing metadata now stores it and
// re-runs the checks against it. What it deliberately does not do is touch the
// votes: not one line of code changed, so the tally is still about the code the
// group read.
async function resubmitUnchanged(ctx, headSha, via) {
  const { pool, config, gh, session, sessionId, owner, repo } = ctx;
  const base = unchanged(session, headSha, via);
  const applied = await applyTestingMetadata({ pool, session, testing: ctx.testing });
  // Same-commit resubmits are also how a title correction arrives — the
  // update that should have carried it may already have landed (#1199's
  // reasoning, applied to the name instead of the screenshots). On a row
  // that already has a PR this RENAMES it, votes untouched.
  const titleApplied = await applyProposedTitle({
    pool, gh, session, owner, repo, title: ctx.title, viewerLogin: ctx.expectedLogin,
  });
  // And the description the group reads (#1323), by the same ownership rule.
  const descApplied = await applyProposedDescription({
    pool, gh, session, owner, repo, description: ctx.description, viewerLogin: ctx.expectedLogin,
  });
  // And the request linkage (#1310): a same-commit resubmit is also how a
  // dropped `Closes #N` arrives once the agent (or a fixed platform) knows
  // to send it.
  const linkedApplied = await applyLinkedIssues({
    pool, gh, session, owner, repo, linkedIssues: ctx.linkedIssues,
  });
  const reported = {
    ...base,
    testingUpdated: applied.changed,
    testingPaths: displayPaths(applied.paths),
    testingPathsRejected: rejectedPaths(ctx.testing),
    captureRerun: false,
    titleUpdated: titleApplied.changed,
    ...(titleApplied.rejected ? { titleRejected: titleApplied.rejected } : {}),
    descriptionUpdated: descApplied.changed,
    ...(descApplied.rejected ? { descriptionRejected: descApplied.rejected } : {}),
    linkedIssuesUpdated: linkedApplied,
  };
  // #1323. Until `recheck` existed, THIS early return was the reason an agent
  // could not ask for a fresh verdict: the re-run below was reachable only as
  // a side effect of changing a capture route, so correcting a stale verdict
  // meant editing a route that was already right. An explicit ask reaches it
  // now, and nothing else about the path changes.
  if (!applied.changed && !ctx.recheck) return reported;

  // A paused session has no container and no preview to shoot against, and
  // starting a build for one is the thing settlePausedSession exists to avoid.
  // The metadata is stored; the screenshots follow when it is reopened.
  if (session.status === 'paused') {
    log.info('proposal-update', 'stored new testing metadata on a paused session', { sessionId });
    return { ...reported, resumeRequired: true };
  }

  // The same operation the "Re-run checks" button performs, under the same
  // reason→trigger mapping: rebuild the preview if it has died, otherwise
  // re-run the checks and the capture straight against the live container.
  // FORCED, because the row may already read passing and a redundant-run skip
  // is exactly what would leave the old screenshots in place.
  //
  // Detached: a dead preview means a full staging rebuild, which takes
  // minutes, and the caller is an HTTP request that has been told the answer
  // already. `previewRebuilding` stays false — nothing about the code changed,
  // so no reviewer is waiting on a new preview of it.
  const recovery = ctx.recovery || require('./staging-recovery');
  try {
    const run = recovery.recheckSessionChecks({ config, pool, session, reason: 'testing-update' });
    if (run && typeof run.catch === 'function') {
      run.catch((err) => log.warn('proposal-update', 'testing-metadata recheck failed (non-fatal)', {
        sessionId, err: err.message,
      }));
    }
  } catch (err) {
    log.error('proposal-update', 'could not re-run the checks for new testing metadata', {
      sessionId, err: err.message,
    });
    return reported;
  }
  log.info('proposal-update', 'same-commit resubmit re-ran the checks', {
    sessionId, headSha, via, paths: displayPaths(applied.paths),
    because: applied.changed ? 'new testing routes' : 'recheck requested',
  });
  return { ...reported, captureRerun: true, checksRerun: true };
}

// ── What a push may land on ────────────────────────────────────────────
//
// One predicate, three answers, and every caller shares it — the options menu
// (through describeTargetProposal), the ownership gate below, and the tails of
// advanceAppRepoBranch. That matters more than it looks: if the menu offered
// "continue this session" for a status the gate then refused, the user would
// have followed a button straight into an error, and a second copy of this
// list is exactly how that drifts into being.
//
//   'proposal' — promoted: up for a vote. A push moves it and CLEARS the votes
//                it has already collected.
//   'session'  — active or paused: still being built, nobody is voting on it,
//                so a push is just the next commit.
//   null       — everything else. merging/merged are frozen by definition, and
//                archived is an explicit put-away that a push must not
//                silently reopen.
function isContinuableStatus(status) {
  const s = status == null ? '' : String(status);
  if (s === 'promoted') return 'proposal';
  if (s === 'active' || s === 'paused') return 'session';
  return null;
}

// Whose proposal it is, and whether it can still take a revision. Applied
// twice — once cheaply before the queue and once under the lock — so a
// proposal that merged while the caller waited is refused rather than pushed
// onto.
function ownershipGate(session, user) {
  if (!session || !user || Number(session.user_id) !== Number(user.id)) {
    return fail(
      'not_your_proposal',
      'That proposal was not opened by you. Only its author advances it; anyone else contributes by opening '
      + 'their own proposal, which the group votes on separately.',
      { retryable: false }
    );
  }
  if (!isContinuableStatus(session.status)) {
    return fail(
      'proposal_closed',
      session.status === 'merging' || session.status === 'merged'
        ? 'That proposal has already passed its vote and is merging, so its code is frozen. Anything further is a '
          + 'new proposal. Call prepare_work again.'
        : `That proposal is ${session.status || 'no longer open'}, so it cannot take a new revision. Open a new `
          + 'proposal with prepare_work.',
      { retryable: false }
    );
  }
  return null;
}

// Is the platform itself mid-write on this proposal? Same four questions the
// commit-upload route asks, and for the same reason: a staging build or a
// screenshot capture in flight is pinned to the CURRENT head, and moving the
// branch underneath it produces a preview of one commit labelled with
// another.
function defaultBusyCheck(session) {
  const { isSessionBusy } = require('./active-workers');
  const staging = require('./staging');
  const visuals = require('./visuals');
  const { hasInFlightHandoffPipeline } = require('./handoff-pipeline');
  const id = Number(session.id);
  return isSessionBusy(id)
    || hasInFlightHandoffPipeline(session.id)
    || staging.hasInFlightBuild(id)
    || visuals.hasInFlightCapture(session.id);
}

// ── The bot-owned branch ───────────────────────────────────────────────
//
// The case this whole change exists for. The proposal's head is a `dev/…`
// branch in the app's own repository that only the platform can write, so
// the author's commits are copied onto it with the platform's credential and
// under a lease.
async function advanceAppRepoBranch(ctx) {
  const {
    pool, config, gh, head, votes, prImportSync, githubPublic, session,
    owner, repo, forkOwner, forkRepo, branch, expectedLogin, expectedHeadSha, sessionId,
  } = ctx;
  // The session tails talk to three modules that do real work — a staging
  // build, a container teardown, a websocket fan-out. Injectable for the same
  // reason `votes` and `head` are: a test about which tail ran must not have
  // to start a container to find out.
  const parts = sessionParts(ctx);

  const targetBranch = session.branch_name;
  if (!targetBranch || !head.validRef(targetBranch)) {
    return fail(
      'platform_unavailable',
      'Homeroom cannot tell which branch this proposal lives on, so it will not push anything. Its author can '
      + 'still open a new proposal.',
      { retryable: false }
    );
  }

  // The head as GITHUB has it, read now. Both the ancestry base and the
  // push's lease come from this one value: a lease pinned to anything the
  // caller supplied would be a lease against the caller's own belief.
  //
  // ── …unless there is no head yet ────────────────────────────────────
  //
  // A 404 here is not an unreadable head. It is a branch NOBODY HAS CREATED,
  // and the row it belongs to is the one #1347's share route writes: a session
  // whose commits are still only in the author's fork, recorded ahead of the
  // landing that puts them in the app's repository. Read as a failure — which
  // it was until this branch existed — no first share could ever succeed, and
  // the route deleted the card it had just made.
  //
  // Both of the things this function does before a push exist to protect a
  // head that is already there:
  //
  //   * the LEASE stops two agents silently overwriting each other's
  //     revision, and
  //   * the ANCESTRY check stops a branch that does not build on the reviewed
  //     commit from dropping commits the group has read.
  //
  // Neither has anything to guard when the branch does not exist, which is why
  // external-agent-head's mirror rung — the platform's own "copy a verified
  // fork branch into a NEW app-repo branch", used by pr-import — takes no
  // lease either. So a first landing skips exactly those two and nothing else:
  // the attribution gate below still runs, twice, as it does on every push.
  //
  // Narrowed to the platform's OWN branch namespace, which is the one the
  // share route mints into. A `dev/…` head missing from the app repository is
  // a different story with a different cause (routes/sessions.js creates that
  // branch best-effort, and a session whose creation failed has a pull request
  // and possibly a tally pinned to it), so it keeps the answer it has always
  // had rather than being quietly re-created underneath a proposal.
  let liveHead;
  let firstLanding = false;
  try {
    liveHead = await gh.getBranchSha(owner, repo, targetBranch);
  } catch (err) {
    if (err && err.status === 404 && platformOwnedBranch(targetBranch)) {
      firstLanding = true;
    } else {
      log.warn('proposal-update', 'could not read the proposal branch head', {
        sessionId, targetBranch, err: err.message,
      });
      return fail('platform_unavailable', 'Homeroom could not read this proposal\'s current commit. Try again shortly.', { retryable: true });
    }
  }
  if (!firstLanding) {
    if (!liveHead || !SHA_RE.test(String(liveHead).trim())) {
      return fail('platform_unavailable', 'Homeroom could not read this proposal\'s current commit. Try again shortly.', { retryable: true });
    }
    liveHead = String(liveHead).trim().toLowerCase();
    if (expectedHeadSha && expectedHeadSha !== liveHead) {
      return movedError(liveHead);
    }
  } else {
    // `expectedHeadSha` names the commit the caller believes this proposal is
    // at. There is no such commit, so there is nothing for it to disagree
    // with — and refusing a first share for naming one would be refusing it
    // for the caller's optimism rather than for a conflict.
    liveHead = null;
  }

  // THE ATTRIBUTION GATE. Run here for the ancestry comparison, and again
  // inside pushForkBranchToAppBranch immediately before the push — the
  // second run is the load-bearing one, and this one is not permitted to
  // replace it.
  const verified = await head.verifyForkBranch({
    githubPublic, forkOwner, forkRepo, branch, expectedLogin,
  });
  if (!verified.ok) return renameHeadFailure(verified, branch);

  if (!firstLanding) {
    // Nothing to push — but a resubmit may still be correcting the capture
    // routes, which is the one thing that used to have no way through (#1199).
    if (verified.headSha === liveHead) return resubmitUnchanged(ctx, liveHead, 'update_branch');

    const ancestry = await checkAncestry({ gh, owner, repo, base: liveHead, head: verified.headSha, branch });
    if (ancestry) return ancestry;
  }

  // Which of the three tails this push takes, decided from the row read UNDER
  // the lock — `params.session` is the caller's snapshot and may be minutes
  // old, which is long enough for a proposal to have been promoted or a
  // session to have been paused.
  const kind = isContinuableStatus(session.status);
  const promoted = kind === 'proposal';

  // Votes exist only on a proposal that is up for a vote, and the count has to
  // happen BEFORE the write that deletes them. A session nobody is voting on
  // has nothing to count and nothing to clear.
  const votesCleared = promoted ? await countVotes(pool, sessionId) : 0;

  // The lease-less create and the lease-checked advance are the same push with
  // the same gate in front of it; `mirrorForkBranch` is not a second
  // implementation of anything, it is the one the mirror rung already uses,
  // pointed at the name this row recorded instead of one it mints.
  const pushed = firstLanding
    ? await head.mirrorForkBranch({
      gh, githubPublic, owner, repo, forkOwner, forkRepo, branch, expectedLogin,
      targetBranch,
    })
    : await head.pushForkBranchToAppBranch({
      githubPublic, owner, repo, forkOwner, forkRepo, branch, expectedLogin,
      targetBranch, expectedRemoteSha: liveHead, sessionId,
    });
  if (!pushed.ok) return renameHeadFailure(pushed, branch);

  // BEFORE the tails, every one of which ends in a capture that reads the
  // routes off this session object (#1199).
  const testingApplied = await applyTestingMetadata({ pool, session, testing: ctx.testing });
  // And the submitted title: stored for the promote-time lazy PR creation
  // when the row has no PR yet, or a rename of the existing PR when it does.
  const titleApplied = await applyProposedTitle({
    pool, gh, session, owner, repo, title: ctx.title, viewerLogin: ctx.expectedLogin,
  });
  // And the description the group reads (#1323), by the same ownership rule.
  const descApplied = await applyProposedDescription({
    pool, gh, session, owner, repo, description: ctx.description, viewerLogin: ctx.expectedLogin,
  });
  // And the request linkage (#1310) — BEFORE the tails for the same reason
  // as the routes: a session tail's promote path builds the PR's `Closes #N`
  // block off this row.
  const linkedApplied = await applyLinkedIssues({
    pool, gh, session, owner, repo, linkedIssues: ctx.linkedIssues,
  });

  // Everything the three tails agree on. They differ only in what they do to
  // the session afterwards and in the three booleans that describe it.
  const landed = {
    ok: true,
    updated: true,
    proposalId: sessionId,
    appSlug: session.app_slug || null,
    prNumber: session.pr_number || null,
    prUrl: session.pr_url || null,
    branchHome: 'app_repo',
    branch: targetBranch,
    headSha: verified.headSha,
    previousHeadSha: liveHead,
    // What this push actually landed on, decided here and not by the work
    // order — which was written before the agent started and may be an hour
    // out of date. `submittedVia` stays 'update_branch' in all three: the
    // schema's widened CHECK already allows it and a third value would need a
    // migration for no gain.
    targetKind: promoted ? 'proposal' : 'session',
    submittedVia: 'update_branch',
    // What the screenshots this revision's capture shoots will be of — and
    // what it will NOT be of, because a route the caller sent was unusable.
    testingUpdated: testingApplied.changed,
    testingPaths: displayPaths(testingApplied.paths),
    testingPathsRejected: rejectedPaths(ctx.testing),
    titleUpdated: titleApplied.changed,
    ...(titleApplied.rejected ? { titleRejected: titleApplied.rejected } : {}),
    descriptionUpdated: descApplied.changed,
    ...(descApplied.rejected ? { descriptionRejected: descApplied.rejected } : {}),
    linkedIssuesUpdated: linkedApplied,
  };

  // ── Tail 1a: an IMPORTED proposal on a bot-owned branch (#1196) ─────
  //
  // The connector's mirror rung imports a pull request whose head is a branch
  // in the APP repository, so a revision lands here — but everything an
  // imported row's votes and checks are pinned to is `imported_pr_head_sha`,
  // and `reconcileNativeReviewedHead` returns without doing anything for
  // `source='imported'`. Tail 1 would therefore push the commit and leave the
  // tally describing code nobody has read until the next sync sweep.
  //
  // `syncImportedProposal` is that sweep's own per-proposal step: it re-reads
  // the pull request, sees the head this push just moved, and runs the
  // existing imported-head machinery — advance the tracked SHA, clear the
  // tally, post the re-review note, re-run the SHA-pinned checks. Nothing
  // about it is reimplemented here. 'unchanged' means GitHub had not caught
  // up with the push yet, which is honest to report as "not rebuilt": the
  // sweeper takes it from there.
  if (String(session.source) === 'imported') {
    let synced = 'skipped';
    try {
      synced = await prImportSync.syncImportedProposal({ config, pool, session });
    } catch (err) {
      log.error('proposal-update', 'imported head sync failed after a successful push', {
        sessionId, err: err.message,
      });
    }
    const applied = synced === 'updated';
    log.info('proposal-update', 'advanced an imported proposal on its app-repo branch', {
      sessionId, owner, repo, targetBranch, previousHeadSha: liveHead,
      headSha: verified.headSha, votesCleared: applied ? votesCleared : 0, synced,
      votesClearing: applied ? 'now' : (votesCleared > 0 ? 'on_sync' : 'none'), votesAtRisk: votesCleared,
    });
    return {
      ...landed,
      votesCleared: applied ? votesCleared : 0,
      // `votesCleared` is what THIS call cleared. On the mirror path the head
      // is advanced by the next pr-import sweep, which is when the tally
      // resets — so a 0 here with votesClearing 'on_sync' means "not yet",
      // not "never". votesAtRisk is the count that will go.
      votesClearing: applied ? 'now' : (votesCleared > 0 ? 'on_sync' : 'none'),
      votesAtRisk: votesCleared,
      checksRerun: applied,
      previewRebuilding: applied,
    };
  }

  // ── Tail 2: an ACTIVE session (#1071) ───────────────────────────────
  //
  // No votes, no re-review note, no reconciliation — nobody is voting on it.
  // What it needs is the thing a native session gets after every other commit:
  // its checks marked pending against the new head and the staging pipeline
  // started, so its preview describes the code that just arrived.
  if (kind === 'session' && session.status === 'active') {
    const settled = await settleActiveSession({
      config, pool, session, sessionId, headSha: verified.headSha, parts,
    });
    log.info('proposal-update', 'advanced an active session from its author\'s fork', {
      sessionId, owner, repo, targetBranch, previousHeadSha: liveHead,
      headSha: verified.headSha, rebuilding: settled.rebuilding,
    });
    return {
      ...landed,
      votesCleared: 0,
      checksRerun: settled.rebuilding,
      previewRebuilding: settled.rebuilding,
      ...(settled.rebuilding ? {} : { resumeRequired: true }),
    };
  }

  // ── Tail 3: a PAUSED session (#1071) ────────────────────────────────
  //
  // The commit is welcome; the build is not. A paused session has no
  // container, and handoff-pipeline's persistence UPDATE is scoped to
  // `status = 'active'` — so starting the pipeline here would build a preview,
  // fail to attach it, and then discard it. Instead: forget the verdict that
  // described the OLD commit (a green tick beside code nobody has run is
  // worse than no tick), tear the stale preview down, and tell the caller the
  // session has to be reopened for the rest to happen.
  if (kind === 'session') {
    await settlePausedSession({ pool, session, sessionId, headSha: verified.headSha, parts });
    log.info('proposal-update', 'advanced a paused session from its author\'s fork', {
      sessionId, owner, repo, targetBranch, previousHeadSha: liveHead,
      headSha: verified.headSha,
    });
    return {
      ...landed,
      votesCleared: 0,
      checksRerun: false,
      previewRebuilding: false,
      resumeRequired: true,
    };
  }

  // ── Tail 1: the existing machinery, unchanged ───────────────────────
  //
  // Nothing about clearing votes, posting the re-review note or rebuilding
  // the preview is reimplemented here: the branch moved, and the platform
  // already has one place that reconciles a moved native head.
  // `fresh: true` makes it re-read GitHub rather than trust the stored pin.
  //
  // And no `recordPlatformPush` call anywhere above — which is exactly what
  // makes classifyNativeHeadMove see an `author_push` and DELETE the tally
  // instead of carrying it onto code the group has not read.
  let reconciled = null;
  try {
    reconciled = await votes.reconcileNativeReviewedHead({
      config, pool, session, fresh: true, notify: true,
    });
  } catch (err) {
    // The push landed. A reconciliation that failed is caught up by the next
    // vote (every vote reconciles first), so this is reported as a completed
    // update with an unknown vote effect rather than as a failure — the
    // alternative tells the author their work did not arrive when it did.
    log.error('proposal-update', 'head-move reconciliation failed after a successful push', {
      sessionId, err: err.message,
    });
  }
  // Boolean, not the truthy value: `checksRerun` and `previewRebuilding` are
  // reported to a client that branches on them, and `null` is neither answer.
  const settled = !!(reconciled && reconciled.updated === true);

  log.info('proposal-update', 'advanced a proposal from its author\'s fork', {
    sessionId, owner, repo, targetBranch, previousHeadSha: liveHead,
    headSha: verified.headSha, votesCleared: settled ? votesCleared : 0,
    votesClearing: settled ? 'now' : (votesCleared > 0 ? 'on_sync' : 'none'), votesAtRisk: votesCleared,
  });

  return {
    ...landed,
    // Honest about what actually happened: the votes were counted before the
    // write and are only reported cleared when the reconciliation that
    // clears them ran.
    votesCleared: settled ? votesCleared : 0,
    votesClearing: settled ? 'now' : (votesCleared > 0 ? 'on_sync' : 'none'),
    votesAtRisk: votesCleared,
    checksRerun: settled,
    previewRebuilding: settled,
  };
}

// The active-session tail, in the words the rest of the platform uses for the
// same moment (see routes/proposal-handoff.js's submit_build): pin the checks
// to the new head, clear the old verdict, drop the pointers to the preview
// that described the previous commit, then run the SAME staging pipeline every
// other native commit runs, detached from this request.
//
// Returns { rebuilding } — false when the session stopped being active between
// the lock and here, which is the one case where the commit landed and the
// build deliberately did not.
// The three modules the session tails reach for, resolved once. Every one is
// overridable through ctx, and the defaults are the real ones — so production
// behaviour needs no wiring at the call sites and a test needs no container.
function sessionParts(ctx) {
  const c = ctx || {};
  return {
    visuals: c.visuals || require('./visuals'),
    pipeline: c.pipeline || require('./handoff-pipeline'),
    lifecycle: c.lifecycle || require('./session-lifecycle'),
    // A function rather than the module: ws is required lazily elsewhere in
    // this file for the same reason — it pulls in the server's socket state.
    pushSessionUpdate: c.pushSessionUpdate
      || ((payload) => require('./ws').pushSessionUpdate(payload)),
  };
}

async function settleActiveSession({ config, pool, session, sessionId, headSha, parts }) {
  const { visuals, pipeline } = parts;
  const { beginHandoffPipeline, startHandoffPipeline, OWNED_SOURCE_SQL } = pipeline;

  // Guarded on `status = 'active'`: a manual pause or archive between the
  // ownership gate and here is allowed to win, and it must not be undone by a
  // write that re-arms a check pipeline for a session that is no longer live.
  // Guarded on `checks_commit_sha` as well — the value read UNDER THE LOCK, so
  // a newer head that took the session while this push was in flight keeps it
  // rather than being regressed to an older commit's pending state.
  const adopted = await pool.query(
    `UPDATE chat_sessions
        SET check_state = 'pending', checks_commit_sha = $1,
            check_error_detail = NULL,
            staging_container_id = NULL, staging_url = NULL,
            last_activity_at = NOW()
      WHERE id = $2 AND status = 'active' AND ${OWNED_SOURCE_SQL}
        AND checks_commit_sha IS NOT DISTINCT FROM $3`,
    [headSha, sessionId, session.checks_commit_sha || null]
  );
  if (!adopted.rowCount) {
    await settlePausedSession({ pool, session, sessionId, headSha, parts });
    return { rebuilding: false };
  }

  await recordChangesReadyCard({ pool, session, sessionId, headSha });

  const pending = await visuals.setChecksPending(pool, sessionId, headSha, 'building', 'commit-push')
    .catch((err) => {
      log.warn('proposal-update', 'setChecksPending failed (non-fatal)', { sessionId, err: err.message });
      return true;
    });
  if (pending === false) return { rebuilding: false };
  try { visuals.notifyChecksPending(sessionId, headSha, 'building', 'commit-push'); } catch { /* notify only */ }

  const app = {
    id: session.app_id,
    slug: session.app_slug,
    name: session.app_name,
    repo_url: session.repo_url,
  };
  const fresh = { ...session, checks_commit_sha: headSha };
  const releasePipeline = beginHandoffPipeline(sessionId);
  try {
    // Detached on purpose: the build and the visual capture take minutes, and
    // the caller is an HTTP request that has already been told the push
    // landed. startHandoffPipeline owns the release.
    startHandoffPipeline(config, pool, fresh, app, headSha, releasePipeline);
  } catch (err) {
    releasePipeline();
    log.error('proposal-update', 'could not start the staging pipeline after an update', {
      sessionId, headSha, err: err.message,
    });
    return { rebuilding: false };
  }
  return { rebuilding: true };
}

// The paused-session tail. Deliberately does NOT start the pipeline: a paused
// session is one nobody is watching, its preview has been reclaimed, and
// handoff-pipeline's persistence UPDATE only matches `status = 'active'` — so
// a build started here would run for minutes and then throw its own result
// away.
//
// What it MUST do is stop the old verdict from describing the new code.
// `checks_commit_sha` is left ALONE on purpose: it names the commit the last
// verdict was about, and the resume path compares it against the branch head
// to decide that a re-check is owed. Null it here and the session comes back
// looking like it had never been checked at all.
async function settlePausedSession({ pool, session, sessionId, headSha, parts }) {
  const { lifecycle: sessionLifecycle, pushSessionUpdate } = parts;
  // The same column list the CLI commit-upload route clears for a commit
  // nothing has run yet, minus the 'pending' verdict itself — nothing IS
  // running, and a 'pending' no pipeline will ever resolve is a spinner
  // forever. NULL check_state is the honest "no verdict for the current code",
  // and it blocks merge, which is the correct answer here.
  await pool.query(
    `UPDATE chat_sessions
        SET check_state = NULL, check_phase = NULL,
            check_error_detail = NULL, check_error_notified_at = NULL,
            check_next_retry_at = NULL,
            test_results = '[]'::jsonb, checks_checked_at = NULL,
            consecutive_check_failures = 0,
            first_check_failure_at = NULL, last_check_failure_at = NULL,
            capture_state = NULL, capture_detail = NULL, captured_at = NULL,
            last_activity_at = NOW()
      WHERE id = $1 AND status = 'paused'`,
    [sessionId]
  ).catch((err) => log.warn('proposal-update', 'could not clear the stale verdict', {
    sessionId, err: err.message,
  }));

  await recordChangesReadyCard({ pool, session, sessionId, headSha });

  // Best effort: a leaked container is retried by the stale-preview sweeper
  // through the same chokepoint, and a teardown failure must not be reported
  // as a failed update — the commit is already on the branch.
  await sessionLifecycle.teardownStagingForSession({
    pool, sessionId, reason: 'external_update',
  }).catch((err) => log.warn('proposal-update', 'staging teardown after an update failed (non-fatal)', {
    sessionId, err: err.message,
  }));

  try {
    pushSessionUpdate({
      action: 'session_update', sessionId, appSlug: session.app_slug || null,
    });
  } catch (err) {
    log.warn('proposal-update', 'session-update notify failed (non-fatal)', { sessionId, err: err.message });
  }
}

// Every platform path that lands a reviewable commit into a session persists
// a `changesReady: true` system row — the marker the dev chat renders as the
// "Changes ready" card, which carries the Preview / Test / **Propose to
// group** buttons (see the #361/#183 parity notes around the build tails in
// routes/sessions.js). An external agent's update reaches the same
// committed-and-pushed state, so it must leave the same marker: the chat's
// synthetic fallback (_hydrateChangesReadyFromSession) needs a staging URL or
// a CLI-handoff head, and a session advanced only through submit_work has
// neither — leaving its owner with no way to put the change up for a vote at
// all (session 3401). Best-effort: the push already landed, so a failed
// insert is logged, never fatal.
async function recordChangesReadyCard({ pool, session, sessionId, headSha }) {
  const sha8 = SHA_RE.test(String(headSha || '')) ? String(headSha).slice(0, 8) : null;
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata)
     VALUES ($1, 'system', $2, $3)`,
    [sessionId,
      sha8
        ? `Changes ready: commit ${sha8} arrived from your coding agent.`
        : 'Changes ready: an update arrived from your coding agent.',
      JSON.stringify({
        changesReady: true,
        externalUpdate: true,
        prNumber: session.pr_number || null,
        prUrl: session.pr_url || null,
      })]
  ).catch((err) => log.warn('proposal-update', 'changes-ready card insert failed (non-fatal)', {
    sessionId, err: err.message,
  }));
}

// ── The imported pull request ──────────────────────────────────────────
//
// Here the author already has write access to the head — it is a branch in
// their own fork — so there is nothing to push. Their push IS the update;
// this only advances the head the platform TRACKS, which is what clears the
// votes and rebuilds the checks. Calling it is still worth it: the sweeper
// would get there eventually, and "eventually" is minutes of the group
// voting on a revision that no longer exists.
async function advanceForkHead(ctx) {
  const {
    pool, config, gh, head, prImportSync, githubPublic, session,
    owner, repo, forkOwner, forkRepo, branch, expectedLogin, expectedHeadSha, sessionId,
  } = ctx;

  // #1071 widened the ownership gate to active and paused sessions, and every
  // one of those is a NATIVE session whose branch lives in the app repo. An
  // imported pull request is only ever continuable while it is up for a vote,
  // and this tail — advancing the head the platform tracks for a PR — has no
  // meaning outside that. Refuse rather than guess.
  if (session.status !== 'promoted') {
    return fail(
      'proposal_closed',
      `That proposal is ${session.status || 'no longer open'}, so it cannot take a new revision. Open a new `
      + 'proposal with prepare_work.',
      { retryable: false }
    );
  }

  const prNumber = Number(session.pr_number);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return fail('platform_unavailable', 'Homeroom cannot tell which pull request this proposal follows.', { retryable: false });
  }

  let pr;
  try {
    pr = await gh.getPR(owner, repo, prNumber);
  } catch (err) {
    log.warn('proposal-update', 'could not read the proposal pull request', { sessionId, prNumber, err: err.message });
    return fail('platform_unavailable', 'Homeroom could not read this proposal\'s pull request. Try again shortly.', { retryable: true });
  }
  if (!pr || pr.merged || (pr.state && pr.state !== 'open')) {
    return fail(
      'proposal_closed',
      `Pull request #${prNumber} is no longer open on GitHub, so this proposal cannot take a new revision.`,
      { retryable: false }
    );
  }

  // The gate, in the shape this path allows: the head repository must be
  // owned by the freshly-read linked login. Same comparison
  // external-agent-tasks.js applies to a submitted PR, against the same
  // value, and again never against anything the caller passed in.
  const headOwner = pr.head && pr.head.repo && pr.head.repo.owner && pr.head.repo.owner.login;
  if (!headOwner || !head.sameLogin(headOwner, expectedLogin)) {
    return fail(
      'not_your_fork',
      `Pull request #${prNumber} comes from ${headOwner ? `${headOwner}'s` : 'another'} repository, not from your `
      + 'fork. Homeroom only advances a proposal from its author\'s own account.',
      { retryable: false }
    );
  }
  const prBranch = pr.head && pr.head.ref ? String(pr.head.ref) : '';
  if (prBranch !== branch) {
    return fail(
      'invalid_request',
      `This proposal follows ${prBranch || 'the pull request\'s own branch'} in your fork, not ${branch}. Push your `
      + 'new commits to that branch (an open pull request cannot be repointed at a different one), or open a new '
      + 'proposal from this branch with prepare_work.',
      { retryable: false }
    );
  }

  const verified = await head.verifyForkBranch({
    githubPublic, forkOwner, forkRepo, branch, expectedLogin,
  });
  if (!verified.ok) return renameHeadFailure(verified, branch);

  const liveHead = pr.head && pr.head.sha ? String(pr.head.sha).toLowerCase() : null;
  if (!liveHead || liveHead !== verified.headSha) {
    // GitHub's own two views of the same branch disagree, which it does for a
    // second or two after a push. Nothing is written on a disagreement.
    return fail(
      'platform_unavailable',
      'GitHub is still catching up with your push: its pull request and its branch report different commits. '
      + 'Try again in a few seconds.',
      { retryable: true }
    );
  }

  const oldHead = session.imported_pr_head_sha
    ? String(session.imported_pr_head_sha).toLowerCase()
    : null;
  if (expectedHeadSha && oldHead && expectedHeadSha !== oldHead) {
    return movedError(oldHead);
  }
  if (oldHead && oldHead === liveHead) return resubmitUnchanged(ctx, liveHead, 'update_fork_head');

  if (oldHead) {
    const ancestry = await checkAncestry({ gh, owner, repo, base: oldHead, head: liveHead, branch });
    if (ancestry) return ancestry;
  }

  const votesCleared = await countVotes(pool, sessionId);

  // Before applyHeadChange, whose own tail re-runs the SHA-pinned checks off
  // this session object (#1199).
  const testingApplied = await applyTestingMetadata({ pool, session, testing: ctx.testing });
  // The request linkage (#1310). On an imported row this stores the DB half
  // only — the close watcher and the Dev board read it — and applyLinkedIssues
  // itself leaves the PR body alone: that body belongs to the pull request's
  // author on GitHub.
  const linkedApplied = await applyLinkedIssues({
    pool, gh, session, owner, repo, linkedIssues: ctx.linkedIssues,
  });
  // And the submitted title (#1319). This path had no title call at all, so
  // an update that MOVED the head — the ordinary way an agent revises a
  // fork-tracked proposal — dropped the name silently even when the author
  // owned every part of it. applyProposedTitle decides whether the rename is
  // the caller's to make; the fork gate above has already proved the head
  // repository is theirs, so for this path it answers yes.
  const titleApplied = await applyProposedTitle({
    pool, gh, session, owner, repo, title: ctx.title, viewerLogin: ctx.expectedLogin,
  });
  // And the description the group reads (#1323), by the same ownership rule.
  const descApplied = await applyProposedDescription({
    pool, gh, session, owner, repo, description: ctx.description, viewerLogin: ctx.expectedLogin,
  });

  // The existing imported-head machinery, unchanged: it advances the tracked
  // SHA, clears the tally, re-classifies dapp.json admins, posts the
  // "earlier votes were cleared" note and re-runs the SHA-pinned checks and
  // staging build.
  try {
    await prImportSync.applyHeadChange({
      config, pool, session, pr, repo: { owner, repo }, newHead: liveHead, oldHead,
    });
  } catch (err) {
    log.error('proposal-update', 'imported head change failed', { sessionId, err: err.message });
    return fail(
      'platform_unavailable',
      'Homeroom could not record your new commit against this proposal. Your push is on GitHub either way, so try '
      + 'again shortly.',
      { retryable: true }
    );
  }

  log.info('proposal-update', 'advanced an imported proposal to its fork\'s head', {
    sessionId, prNumber, previousHeadSha: oldHead, headSha: liveHead, votesCleared,
  });

  return {
    ok: true,
    updated: true,
    proposalId: sessionId,
    appSlug: session.app_slug || null,
    prNumber,
    prUrl: session.pr_url || pr.html_url || null,
    branchHome: 'user_fork',
    branch,
    headSha: liveHead,
    previousHeadSha: oldHead,
    votesCleared,
    checksRerun: true,
    previewRebuilding: true,
    submittedVia: 'update_fork_head',
    titleUpdated: titleApplied.changed,
    ...(titleApplied.rejected ? { titleRejected: titleApplied.rejected } : {}),
    descriptionUpdated: descApplied.changed,
    ...(descApplied.rejected ? { descriptionRejected: descApplied.rejected } : {}),
    testingUpdated: testingApplied.changed,
    testingPaths: displayPaths(testingApplied.paths),
    testingPathsRejected: rejectedPaths(ctx.testing),
    linkedIssuesUpdated: linkedApplied,
  };
}

// Does the new work actually build on what is under review? A revision that
// does not is the one case where accepting it would silently DELETE reviewed
// commits from the proposal — the fork branch could be cut from anywhere,
// including from main before the proposal existed.
//
// The comparison runs against the APP repository with bare commit ids: fork
// network commits are reachable through the parent repo's API, which is how
// services/external-agent-head.js's mirror path already compares them.
//
// A comparison the platform cannot make is not a licence to overwrite a
// branch under review, so an unreadable compare is a retryable refusal
// rather than a pass.
async function checkAncestry({ gh, owner, repo, base, head: newHead, branch }) {
  let cmp;
  try {
    cmp = await gh.compareCommitAncestry(owner, repo, base, newHead);
  } catch (err) {
    log.warn('proposal-update', 'ancestry comparison failed', { owner, repo, err: err.message });
    return fail(
      'platform_unavailable',
      'Homeroom could not check that your branch builds on this proposal\'s current commit, so it did not move it. '
      + 'Try again shortly.',
      { retryable: true }
    );
  }
  if (!cmp || !cmp.status) {
    return fail(
      'platform_unavailable',
      'Homeroom could not check that your branch builds on this proposal\'s current commit, so it did not move it. '
      + 'Try again shortly.',
      { retryable: true }
    );
  }
  if (cmp.status !== 'ahead' && cmp.status !== 'identical') {
    return fail(
      'base_mismatch',
      `${branch} is not built on this proposal's current commit: it is ${cmp.status} relative to it, so pushing it `
      + 'would drop commits that are already under review. Fetch the proposal\'s head, rebase your branch onto it '
      + 'and submit again.',
      { retryable: false, expectedBase: base }
    );
  }
  return null;
}

function movedError(headSha) {
  return fail(
    'branch_moved',
    `This proposal is now at commit ${headSha.slice(0, 8)}, not the one your update was built against. Somebody `
    + 'advanced it in the meantime. Re-read the proposal, rebase onto its current head and submit again.',
    { retryable: false, headSha }
  );
}

// The fork branch is already this proposal's head. Not an error: an agent
// that submits twice, or a user who relays "it's pushed" after the agent
// already did, must not be told their work is missing.
function unchanged(session, headSha, via) {
  return {
    ok: true,
    updated: false,
    unchanged: true,
    proposalId: Number(session.id),
    appSlug: session.app_slug || null,
    prNumber: session.pr_number || null,
    prUrl: session.pr_url || null,
    branchHome: branchHomeOf(session),
    branch: session.branch_name || null,
    headSha,
    previousHeadSha: headSha,
    votesCleared: 0,
    checksRerun: false,
    previewRebuilding: false,
    submittedVia: via,
  };
}

module.exports = {
  branchHomeOf,
  authorCanPush,
  headRepoOwnerOf,
  repoNameFromUrl,
  isContinuableStatus,
  withProposalLock,
  updateProposalFromForkBranch,
  reconcileManagedCommitUpload,
  // The request-linking half of an update (#1310), unit-tested directly.
  applyLinkedIssues,
  // The post-creation issue association seam shared by the UI + connector.
  updateLinkedIssues,
};
