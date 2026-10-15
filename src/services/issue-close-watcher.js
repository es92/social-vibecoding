'use strict';

// Post-merge issue-close watcher (#135).
//
// When a PR merges, GitHub itself closes the issues referenced via closing
// keywords (`Closes #N`, `Fixes #N`, `Resolves #N`) in the PR body — but it
// does so asynchronously, often a few seconds after the merge reports
// success. The platform's "Open Issues" panel in the group chat area busts
// its cache and refetches at merge time, which races that delay: the
// refetch can see the issue still open and re-cache it as open for the
// 5-minute fetchPublicIssues TTL, so the panel keeps showing a closed
// issue.
//
// This watcher closes the gap: it polls the referenced issues with
// retry/backoff until they read as closed (or attempts run out), and once
// closes are observed it busts the open-issues cache and broadcasts the same
// `github_synced` refresh event the merge path uses, so every group-chat
// panel refetches and drops the issue.
//
// GitHub's own keyword handling is not reliable enough to be the only path:
// on 2026-09-30 it stopped applying `Closes #N` to merged PRs for hours. So
// when the polls run out, the watcher closes the session's LINKED issues
// that are still open itself (closeLinkedIssues below) — and only those,
// and only after re-reading the PR as merged into the repo's default branch.
// Numbers that come solely from a hand-edited PR body are watched but never
// closed here.
//
// Every number it sees closed, or closes, also closes the platform's own
// `general` twin row for that request (closeTwinRows below), which nothing
// else did on a merge, and withdraws the Homeroom bot's proposals that were
// built for it alone (withdrawBotProposals below).

// Everything here is best-effort. watchIssuesClosedAfterMerge is
// fired-and-forgotten from the merge path (routes/votes.js checkAndMerge)
// and must never block, slow down, or roll back the merge flow — failures
// are logged and abandoned.

const log = require('./logger');
const github = require('./github');
const { parseClosingKeywords, sanitizeIssueNumbers } = require('./pr-metadata');

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Tunables (env-overridable so tests can zero the delays):
// - GRACE: wait before the first poll — GitHub's auto-close usually lands
//   within a couple of seconds, so the first check often already sees
//   everything closed.
// - ATTEMPTS / BACKOFF: poll rounds; the delay between rounds doubles each
//   time (3s, 6s, 12s, 24s by default → ~45s of total patience).
const GRACE_DELAY_MS = envInt('ISSUE_CLOSE_WATCH_GRACE_MS', 2000);
const MAX_ATTEMPTS = envInt('ISSUE_CLOSE_WATCH_ATTEMPTS', 5);
const BACKOFF_BASE_MS = envInt('ISSUE_CLOSE_WATCH_BACKOFF_MS', 3000);

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// Fetch the merged PR once: its body feeds resolveIssueNumbers and its merge
// state gates closeLinkedIssues. Null when the fetch fails.
async function fetchPr(owner, repo, prNumber) {
  try {
    return await github.getPR(owner, repo, prNumber);
  } catch (err) {
    log.warn('issue-close-watcher', 'Failed to fetch merged PR body; using linked_issues only', {
      repo: `${owner}/${repo}`, pr: prNumber, err: err.message,
    });
    return null;
  }
}

// Resolve the set of issue numbers the merged PR closes: the session's
// linked_issues (the deterministic source behind the PR body's `Closes #N`
// block) unioned with whatever closing keywords the merged body actually
// carries — a hand-edited body can reference issues the session never
// linked. Falls back to linkedIssues alone if the PR fetch fails. `pr`, when
// passed, is the already-fetched PR (null = the fetch failed).
async function resolveIssueNumbers({ owner, repo, prNumber, linkedIssues, pr }) {
  const fetched = pr === undefined ? await fetchPr(owner, repo, prNumber) : pr;
  const parsed = parseClosingKeywords(fetched && fetched.body);
  const linked = Array.isArray(linkedIssues) ? linkedIssues : [];
  return sanitizeIssueNumbers([...linked, ...parsed]);
}

// Whether `pr` is merged into the default branch of owner/repo itself — the
// condition under which GitHub's own `Closes #N` would have fired. A PR from
// another repository's base, an unmerged PR, or a payload missing any of
// these fields answers false, and nothing is closed.
function mergedIntoDefaultBranch(pr, owner, repo) {
  if (!pr || pr.merged !== true) return false;
  const base = pr.base || {};
  const baseRepo = base.repo || {};
  const norm = (s) => String(s || '').replace(/\.git$/i, '').toLowerCase();
  if (!baseRepo.full_name || norm(baseRepo.full_name) !== norm(`${owner}/${repo}`)) return false;
  return !!base.ref && base.ref === baseRepo.default_branch;
}

// Check one issue's state. Returns:
//   'closed'  — GitHub's auto-close has landed
//   'open'    — not yet; keep polling
//   'skipped' — #N is a PR (issue/PR numbers share one sequence and the
//               closing-keyword regex can't tell them apart), or the issue
//               is gone (404/410) — either way, stop watching it
//   'error'   — transient fetch failure; keep polling
async function checkIssueState(owner, repo, issueNumber) {
  try {
    const issue = await github.getIssue(owner, repo, issueNumber);
    if (issue && issue.pull_request) return 'skipped';
    return issue && issue.state === 'closed' ? 'closed' : 'open';
  } catch (err) {
    const status = err.status || (err.response && err.response.status);
    if (status === 404 || status === 410) return 'skipped';
    log.warn('issue-close-watcher', 'Issue state check failed; will retry', {
      repo: `${owner}/${repo}`, issue: issueNumber, err: err.message,
    });
    return 'error';
  }
}

// Bust this repo's open-issues cache and tell every client viewing the
// app's group chat to refetch (App.handleIssueUpdate → loadVotePanel).
// Same event shape the merge path broadcasts at merge time. `closed`
// carries the numbers whose closure was just observed — they're
// recorded on the known-closed suppression list (#144) so the refetch
// can't resurrect them even when GitHub's eventually-consistent
// anonymous list endpoint still reports them open.
function bustAndBroadcast({ owner, repo, appSlug, appId, closed }) {
  try {
    if (Array.isArray(closed) && closed.length) {
      github.noteIssuesClosed(owner, repo, closed);
    }
    github.invalidateIssuesCache(owner, repo);
    const { pushIssueUpdate } = require('./ws');
    pushIssueUpdate({
      action: 'github_synced',
      appSlug: appSlug || null,
      appId: appId || null,
      source: 'issue_close_watcher',
    });
  } catch (err) {
    log.warn('issue-close-watcher', 'Cache bust / broadcast failed', {
      repo: `${owner}/${repo}`, err: err.message,
    });
  }
}

// Auto-resolve open close-issue governance proposals whose target was just
// observed closed (or gone). Lazy require of routes/issues (same pattern as
// the ./ws require in bustAndBroadcast — the routes module requires this
// service's siblings, never this file, so there's no cycle). `pool` is
// optional: without one (older call sites, unit tests) this is a silent
// no-op and the watcher behaves exactly as before. Fired-and-forgotten —
// a failure must never affect the poll loop. Resolves when it is done (the
// watch awaits it before it returns, so a durable caller that saw it return
// knows the proposals were told). `strict` rejects on a failure instead
// (the merge-followups workflow machine retries its work on it).
function resolveSupersededProposals({ pool, appId, appSlug, prNumber, numbers, strict = false }) {
  if (!pool || !appId || !Array.isArray(numbers) || !numbers.length) return Promise.resolve();
  try {
    const { resolveSupersededCloseProposals } = require('../routes/issues');
    return resolveSupersededCloseProposals(pool, {
      appId,
      appSlug,
      numbers,
      cause: { kind: 'pr-merge', prNumber },
      strict,
    }).catch((err) => {
      if (strict) throw err;
      log.warn('issue-close-watcher', 'Superseded close-proposal resolve failed', {
        pr: prNumber, err: err.message,
      });
    });
  } catch (err) {
    if (strict) return Promise.reject(err);
    log.warn('issue-close-watcher', 'Superseded close-proposal resolve setup failed', {
      pr: prNumber, err: err.message,
    });
    return Promise.resolve();
  }
}

// Close the platform's own record of each request just observed closed: the
// `general` twin row a platform-filed request keeps beside its GitHub issue
// to remember who filed it (services/governance-kinds.js). Until this, the
// only path that closed a twin was an applied close-issue vote
// (routes/issues.js), so every request a merged proposal closed kept an open
// twin for good, and every reader counting open rows counted it (Plant Pal's
// #1 still read open after PR #2 closed it). Only numbers GitHub reported
// closed, or that the watcher closed itself, land here. Same contract as
// resolveSupersededProposals: a no-op without a pool, fired-and-forgotten,
// and a failure never touches the poll loop. `strict` as there.
function closeTwinRows({ pool, appId, prNumber, numbers, strict = false }) {
  if (!pool || !appId || !Array.isArray(numbers) || !numbers.length) return Promise.resolve();
  try {
    return Promise.resolve(pool.query(
      `UPDATE issues SET status = 'closed'
        WHERE app_id = $1 AND kind = 'general' AND status = 'open'
          AND github_issue_number = ANY($2::int[])`,
      [appId, numbers]
    )).then(() => {}, (err) => {
      if (strict) throw err;
      log.warn('issue-close-watcher', 'Closing request twin rows failed', {
        pr: prNumber, issues: numbers, err: err.message,
      });
    });
  } catch (err) {
    if (strict) return Promise.reject(err);
    log.warn('issue-close-watcher', 'Closing request twin rows failed', {
      pr: prNumber, issues: numbers, err: err.message,
    });
    return Promise.resolve();
  }
}

// Withdraw the Homeroom bot's proposals up for a vote whose requests are now
// all closed (homeroom-bot-closed-requests.js). A request a person's change
// shipped otherwise kept the bot's proposal for it up, and holding one of the
// bot's per-project proposal slots, for good. Lazy require, same reason as
// resolveSupersededProposals. Same contract as closeTwinRows: a no-op without
// a pool, never a reason the watch fails unless `strict`.
function withdrawBotProposals({ pool, appId, prNumber, numbers, strict = false }) {
  if (!pool || !appId || !Array.isArray(numbers) || !numbers.length) return Promise.resolve();
  try {
    const { noteRequestsClosed } = require('./homeroom-bot-closed-requests');
    return noteRequestsClosed(pool, { appId, closed: numbers, strict }).then(() => {}, (err) => {
      if (strict) throw err;
      log.warn('issue-close-watcher', 'Withdrawing the bot\'s proposals for closed requests failed', {
        pr: prNumber, issues: numbers, err: err.message,
      });
    });
  } catch (err) {
    if (strict) return Promise.reject(err);
    log.warn('issue-close-watcher', 'Withdrawing the bot\'s proposals for closed requests failed', {
      pr: prNumber, issues: numbers, err: err.message,
    });
    return Promise.resolve();
  }
}

// Close, on GitHub, the linked issues GitHub left open after the grace polls.
// Returns { closed, failed }.
//
// Why this is safe to do without a vote of its own: the numbers are the
// session's linked_issues, never the PR body's keywords and never anything a
// request supplies here. Only the proposal's author (or a write admin) can
// link an issue (proposal_start / prepare_work / update_proposal_issues), the
// link is shown on the proposal the group votes on, and the platform writes
// it into the PR body as `Closes #N` — so closing it on merge is exactly what
// GitHub itself would have done. It runs only from the merge path (and its
// post-restart resume), only for a PR re-read as merged into this repo's
// default branch, and only in owner/repo, the app's own repository, parsed
// from repo_url the same way the close-issue vote parses it.
async function closeLinkedIssues({ owner, repo, prNumber, pr, linkedIssues, stillOpen }) {
  const linked = new Set(sanitizeIssueNumbers(linkedIssues));
  const targets = stillOpen.filter((n) => linked.has(n));
  const closed = [];
  const failed = [];
  if (!targets.length) return { closed, failed };
  if (!mergedIntoDefaultBranch(pr, owner, repo)) {
    log.warn('issue-close-watcher', 'Not closing linked issues: PR not verified as merged into the default branch', {
      repo: `${owner}/${repo}`, pr: prNumber, issues: targets,
    });
    return { closed, failed: targets };
  }
  for (const n of targets) {
    try {
      await github.closeIssue(owner, repo, n);
      closed.push(n);
      log.info('issue-close-watcher', 'Closed linked issue GitHub left open after merge', {
        repo: `${owner}/${repo}`, pr: prNumber, issue: n,
      });
    } catch (err) {
      failed.push(n);
      log.warn('issue-close-watcher', 'Closing linked issue after merge failed', {
        repo: `${owner}/${repo}`, pr: prNumber, issue: n, status: err.status, err: err.message,
      });
    }
  }
  return { closed, failed };
}

// Entry point, fired-and-forgotten from the merge path. Polls until every
// referenced issue reads as closed (or attempts are exhausted), busting
// the cache + broadcasting whenever new closes are observed. Returns the
// per-bucket outcome (useful for tests); unexpected throws are absorbed by
// the caller's .catch(). `pool` (optional) enables auto-resolving open
// close-issue proposals for observed closes — see resolveSupersededProposals.
// `strict` (the merge-followups workflow machine): a failure to close the
// twin rows or the superseded proposals fails the watch, after its polls,
// so the durable work retries it; otherwise they are logged and dropped.
async function watchIssuesClosedAfterMerge({ owner, repo, prNumber, linkedIssues, appSlug, appId, pool, strict = false }) {
  const empty = { closed: [], skipped: [], stillOpen: [] };
  if (!github.isEnabled() || !owner || !repo || !prNumber) return empty;

  await sleep(GRACE_DELAY_MS);

  const pr = await fetchPr(owner, repo, prNumber);
  const numbers = await resolveIssueNumbers({ owner, repo, prNumber, linkedIssues, pr });
  if (!numbers.length) return empty;

  // #144: optimistically suppress every referenced number up front. The
  // merge path already did this for linked_issues, but the resolved set
  // can be wider (hand-edited `Closes #N` in the PR body), and when this
  // watch is RESUMED after a platform restart (server.js
  // resumeIssueCloseWatches — the self-edits app's GHA deploy rolls the
  // platform right after merge, killing the original watcher) the fresh
  // process has an empty suppression list. Anything that turns out to
  // still be open is unsuppressed below.
  try {
    github.noteIssuesClosed(owner, repo, numbers);
  } catch (err) {
    log.warn('issue-close-watcher', 'Optimistic issue suppression failed', {
      repo: `${owner}/${repo}`, err: err.message,
    });
  }

  const closed = [];
  const skipped = [];
  // The proposal and twin-row updates it starts, awaited before it returns.
  // A strict failure is held (never an unhandled rejection mid-poll) and
  // thrown once they have all settled.
  const settling = [];
  const failures = [];
  const settle = (p) => settling.push(p.catch((err) => { failures.push(err); }));
  let pending = numbers;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.length; attempt++) {
    const stillPending = [];
    const newlyClosed = [];
    const newlySkipped = [];
    for (const n of pending) {
      const state = await checkIssueState(owner, repo, n);
      if (state === 'closed') newlyClosed.push(n);
      else if (state === 'skipped') newlySkipped.push(n);
      else stillPending.push(n); // 'open' or transient 'error'
    }
    if (newlyClosed.length) {
      closed.push(...newlyClosed);
      bustAndBroadcast({ owner, repo, appSlug, appId, closed: newlyClosed });
      settle(closeTwinRows({ pool, appId, prNumber, numbers: newlyClosed, strict }));
      settle(withdrawBotProposals({ pool, appId, prNumber, numbers: newlyClosed, strict }));
    }
    if (newlySkipped.length) skipped.push(...newlySkipped);
    // Retire close-issue proposals for closed AND skipped numbers: a
    // skipped 404/410 issue is gone and no later close will ever arrive,
    // and a skipped-because-PR number can never match a close proposal
    // (proposals only target numbers verified open at creation).
    if (newlyClosed.length || newlySkipped.length) {
      settle(resolveSupersededProposals({
        pool, appId, appSlug, prNumber,
        numbers: [...newlyClosed, ...newlySkipped], strict,
      }));
    }
    pending = stillPending;
    if (pending.length && attempt < MAX_ATTEMPTS) {
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }

  if (pending.length) {
    log.warn('issue-close-watcher', 'Gave up waiting for GitHub to close issues', {
      repo: `${owner}/${repo}`, pr: prNumber, stillOpen: pending, attempts: MAX_ATTEMPTS,
    });
    // Close the linked ones ourselves. What closes stays hidden and is
    // handled like an observed close; the rest falls through to un-hide.
    let selfClosed = [];
    try {
      ({ closed: selfClosed } = await closeLinkedIssues({
        owner, repo, prNumber, pr, linkedIssues, stillOpen: pending,
      }));
    } catch (err) {
      log.warn('issue-close-watcher', 'Closing linked issues failed', {
        repo: `${owner}/${repo}`, pr: prNumber, err: err.message,
      });
    }
    if (selfClosed.length) {
      closed.push(...selfClosed);
      bustAndBroadcast({ owner, repo, appSlug, appId, closed: selfClosed });
      settle(resolveSupersededProposals({ pool, appId, appSlug, prNumber, numbers: selfClosed, strict }));
      settle(closeTwinRows({ pool, appId, prNumber, numbers: selfClosed, strict }));
      settle(withdrawBotProposals({ pool, appId, prNumber, numbers: selfClosed, strict }));
      pending = pending.filter((n) => !selfClosed.includes(n));
    }
  }
  if (pending.length) {
    // These are genuinely still open on GitHub — lift the optimistic
    // suppression so they aren't hidden from the panel for the full
    // suppression TTL.
    try {
      github.unsuppressIssues(owner, repo, pending);
    } catch (err) {
      log.warn('issue-close-watcher', 'Unsuppress failed', {
        repo: `${owner}/${repo}`, err: err.message,
      });
    }
  }
  await Promise.all(settling);
  if (failures.length) throw failures[0];
  log.info('issue-close-watcher', 'Post-merge close watch done', {
    repo: `${owner}/${repo}`, pr: prNumber, closed, skipped, stillOpen: pending,
  });

  return { closed, skipped, stillOpen: pending };
}

module.exports = {
  watchIssuesClosedAfterMerge, resolveIssueNumbers, mergedIntoDefaultBranch,
  // What an observed close does, for a close made elsewhere: a change that
  // went live inside another one closes its requests itself
  // (services/included-changes.js), and they then read closed the same way.
  bustAndBroadcast, resolveSupersededProposals, closeTwinRows, withdrawBotProposals,
};
