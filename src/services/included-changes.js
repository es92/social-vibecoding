'use strict';

// A change that went live inside another one.
//
// A change can be built on top of another open change: the Homeroom bot
// asked to "fix mark as done in Jordan's first version" built its fix on the
// first version's branch, so the fix's pull request carried the first
// version's commit as well as its own (Flat 4B Chores, 5 Oct 2026: PR 8 built
// on PR 3). When the fix merged, the first version's work went live with it,
// but nothing said so: GitHub squashes, so PR 3's own commit is not on main
// and GitHub never marked it merged. PR 3 stayed open and still asked for
// votes, its lazy window would have tried to merge it again, request #1 stayed
// open, and the App tab kept saying the first version was being built over
// the live app.
//
// So when a change merges, every other change of the app that is up for a
// vote and whose head commit is one of the merged pull request's own commits
// (GitHub's list of the commits on it, which it keeps after a squash merge)
// is INCLUDED in it. The signal is exact and costs one GitHub read per merge,
// and none when nothing else is up for a vote: a head on that list is a
// commit the merged change brought to main, so the included change has
// nothing left that is not live. A head the list does not have (a newer
// revision, a change never built on) is left alone, and a change already on
// main before the merge is never on the list, so the other order (the lower
// change merging first) includes nothing.
//
// An included change is marked merged with the merge it went live in
// (merged_at and merge_commit_sha are that merge's, so its deploy state is
// that merge's) and `included_in_session_id` names the change that carried
// it. Being merged is what every reader already understands: the vote panel,
// Needs you and the lazy window only look at changes up for a vote, a vote on
// it is refused, its requests read "approved and live", and a project's first
// version reads live (homeroom-bot-dm.js firstVersionState). Then, in the
// background, what a merge does for a change is done for it: its pull
// request is closed with a line saying where it went, its thread says so, its
// requests are closed, the bot's other work on them stops
// (homeroom-bot.js noteRequestMerged), whoever asked for it hears it is live
// (homeroom-bot-dm.js noteProposalMerged), the journey records it
// (journey-events.js recordChangeLive), and its preview and worker go.
//
// Called from the merge (routes/votes.js finalizeMerge) once the merged
// change is marked merged. Never a reason a merge fails.

const log = require('./logger');
const { reviewedHeadForSession } = require('./pr-vote-revision');

function parseRepo(url) {
  const [, owner, repo] = String(url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo: repo.replace(/\.git$/i, '') } : null;
}

function fullSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// What is said about an included change (its closing comment, its thread's
// lines, its author's notification): src/workflow/rules/included-lines.ts,
// which the merge-followups machine writes with.
const { prLabel, closingComment, threadLine, liveLine, authorLine } = require('../workflow/rules/included-lines.ts');

/**
 * Pure: the candidates whose head is one of `commitShas`, the merged pull
 * request's own commits. A candidate with no recorded head is never one.
 */
function containedIn(candidates, commitShas) {
  const listed = new Set((commitShas || []).map(fullSha).filter(Boolean));
  return (candidates || []).filter((c) => {
    const head = fullSha(reviewedHeadForSession(c));
    return !!head && listed.has(head);
  });
}

// The app's other changes up for a vote, with a pull request and a recorded
// head. Not one whose turn is running (a revision may be on its way, and it
// decides), and not one holding a secret value for a variable it declares:
// that value is applied only by the change's own merge
// (services/pending-secrets.js), so it waits for that.
const CANDIDATES_SQL = `SELECT cs.id, cs.source, cs.reviewed_head_sha, cs.imported_pr_head_sha
   FROM chat_sessions cs
  WHERE cs.app_id = $1 AND cs.id <> $2
    AND cs.status = 'promoted' AND cs.is_headless = FALSE
    AND cs.pr_number IS NOT NULL AND cs.active_turn IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pending_secret_declarations p
       WHERE p.session_id = cs.id AND p.status = 'pending'
    )
  ORDER BY cs.id`;

// The same compare-and-set the merge claim uses ('promoted' -> 'merging'):
// a change that started merging on its own, was withdrawn or was moved back
// to Underway since the read above is left as it is.
const MARK_SQL = `UPDATE chat_sessions c
    SET status = 'merged',
        merged_at = COALESCE(m.merged_at, NOW()),
        live_at = COALESCE(m.live_at, NOW()),
        merge_commit_sha = m.merge_commit_sha,
        included_in_session_id = m.id
   FROM chat_sessions m
  WHERE m.id = $1 AND m.status = 'merged'
    AND c.id = ANY($2::int[]) AND c.app_id = m.app_id
    AND c.status = 'promoted' AND c.active_turn IS NULL
  RETURNING c.id`;

const INCLUDED_SQL = `SELECT c.*, a.slug AS app_slug, a.repo_url
   FROM chat_sessions c JOIN apps a ON a.id = c.app_id
  WHERE c.id = ANY($1::int[]) AND c.included_in_session_id = $2
  ORDER BY c.id`;

function depsOf(deps = {}) {
  return {
    github: deps.github || require('./github'),
    ws: deps.ws || require('./ws'),
    staging: deps.staging || require('./staging'),
    worker: deps.worker || require('./worker'),
    notifications: deps.notifications || require('./notifications'),
    agentSessions: deps.agentSessions || require('./agent-sessions'),
    bot: deps.bot || require('./homeroom-bot'),
    dm: deps.dm || require('./homeroom-bot-dm'),
    live: deps.live || require('./homeroom-bot-live'),
    journey: deps.journey || require('./journey-events'),
    watcher: deps.watcher || require('./issue-close-watcher'),
    isSessionBusy: deps.isSessionBusy || require('./active-workers').isSessionBusy,
    resolveIssueBounty: deps.resolveIssueBounty || require('../workflow/rules/bounties.ts').resolveIssueBounty,
  };
}

function githubOn(github) {
  return !!github && typeof github.isEnabled === 'function' && github.isEnabled();
}

/**
 * Mark the changes `session` (just merged) carried as included in it.
 * Resolves `{ included: [ids], done }`: `done` settles once the background
 * work for them is finished (tests await it; the merge does not). Throws
 * only when the database cannot be read or written; the caller catches.
 * `deployed: false` is a merge whose deploy failed (routes/votes.js
 * checkAndMerge): what it carried is merged and closed the same way, but
 * nobody is told it is live, as the merge itself tells nobody then.
 */
async function includeStackedChanges({ config = null, pool, session, sha = null, deployed = true, deps = {} } = {}) {
  const none = { included: [], done: Promise.resolve([]) };
  if (!pool || !session?.id || !session.app_id || !session.pr_number) return none;
  const d = depsOf(deps);
  const repo = parseRepo(session.repo_url);
  if (!repo || !githubOn(d.github) || typeof d.github.listPullRequestCommitShas !== 'function') return none;

  const { rows: candidates = [] } = await pool.query(CANDIDATES_SQL, [session.app_id, session.id]);
  const idle = candidates.filter((c) => !d.isSessionBusy(Number(c.id)));
  if (!idle.length) return none;

  let listed;
  try {
    listed = await d.github.listPullRequestCommitShas(repo.owner, repo.repo, session.pr_number);
  } catch (err) {
    log.warn('included-changes', 'Could not read the merged pull request\'s commits; nothing is included', {
      sessionId: session.id, prNumber: session.pr_number, err: err.message,
    });
    return none;
  }
  if (listed && listed.complete === false) {
    log.info('included-changes', 'The merged pull request lists more commits than GitHub returns; only those listed are compared', {
      sessionId: session.id, prNumber: session.pr_number, listed: (listed.shas || []).length,
    });
  }
  const contained = containedIn(idle, listed?.shas);
  if (!contained.length) return none;

  const { rows: marked = [] } = await pool.query(MARK_SQL, [session.id, contained.map((c) => Number(c.id))]);
  if (!marked.length) return none;
  const ids = marked.map((r) => Number(r.id));
  const { rows: included = [] } = await pool.query(INCLUDED_SQL, [ids, session.id]);
  log.info('included-changes', 'Changes built on by a merged change went live with it', {
    sessionId: session.id, prNumber: session.pr_number, included: ids,
  });

  const carrier = { id: Number(session.id), pr_number: session.pr_number, pr_title: session.pr_title || null };
  const done = (async () => {
    const out = [];
    for (const row of included) {
      out.push(await settleIncluded({ config, pool, row, carrier, sha, deployed, d }));
    }
    return out;
  })().catch((err) => {
    log.warn('included-changes', 'Settling the included changes stopped', { sessionId: session.id, err: err.message });
    return [];
  });
  return { included: ids, done };
}

/**
 * What a merge does for a change, done for one that went live inside
 * `carrier`. Each step is on its own: one that fails is logged and the rest
 * go on. Resolves what was done, for tests.
 */
async function settleIncluded({ config, pool, row, carrier, sha, deployed = true, d }) {
  const did = { id: Number(row.id), prClosed: false, requestsClosed: [] };
  const step = async (what, fn) => {
    try {
      return await fn();
    } catch (err) {
      log.warn('included-changes', `Could not ${what}`, { sessionId: row.id, includedIn: carrier.id, err: err.message });
      return null;
    }
  };
  const repo = parseRepo(row.repo_url);
  const github = githubOn(d.github) && repo ? d.github : null;

  // Nothing else of the bot's on its request goes on (a build, another
  // proposal, a queued follow-up), exactly as on its own merge. First: it is
  // only the database.
  await step('settle the bot\'s other work on its request', () => d.bot.noteRequestMerged(pool, row));

  if (github && row.pr_number) {
    await step('comment on its pull request', () => github.createIssueComment(repo.owner, repo.repo, row.pr_number, closingComment(carrier)));
    did.prClosed = !!(await step('close its pull request', async () => {
      await github.closePR(repo.owner, repo.repo, row.pr_number);
      return true;
    }));
  }

  await step('say so in its thread', () => d.ws.sendSystemMessage(pool, row.app_id, threadLine(row, carrier), 'system',
    { included: { sessionId: Number(row.id), inSessionId: carrier.id, inPrNumber: carrier.pr_number || null } },
    { type: 'session', ref: row.id }));

  did.requestsClosed = (await step('close its requests', () => closeRequests({ pool, row, carrier, github, repo, d }))) || [];

  await step('tear down its preview', () => d.staging.teardownStaging(row, { slug: row.app_slug }));
  await step('retire its worker', () => d.worker.retireWorker(row.id));
  await step('tell its agent session', () => d.agentSessions.noteChangeClosed(pool, { change: row, outcome: 'merged' }));

  await step('tell the vote panels', () => d.ws.pushVoteUpdate({
    sessionId: Number(row.id), appSlug: row.app_slug, appId: row.app_id, merged: true, includedIn: carrier.id,
  }));
  // 5 October (Page Turners): and the bell stops asking about it, as on its
  // own merge (notifications.settleDecidedChange).
  await step('settle what the bell asks about it', () => d.notifications.settleDecidedChange?.(pool, row.id));
  if (!deployed) return did;

  await step('tell its author', async () => {
    const created = await d.notifications.createPrMergedNotification?.(pool, {
      userId: row.user_id, appId: row.app_id, sessionId: row.id, credits: authorLine(carrier),
    });
    for (const n of created || []) await d.notifications.hydrateAndPush(pool, n).catch(() => {});
  });

  // #4787: and its voters, yes or no, as its author was told above — a
  // change carried inside another goes live there, and a voter of the
  // carried change had a say in it.
  await step('tell its voters', async () => {
    const created = await d.notifications.createVotedChangeMergedNotifications?.(pool, {
      appId: row.app_id, sessionId: row.id, authorId: row.user_id,
    });
    for (const n of created || []) await d.notifications.hydrateAndPush(pool, n).catch(() => {});
  });

  // Whoever asked for it hears it is live (for a first version, its
  // creator), and the journey records it going live, as on its own merge.
  await step('tell whoever asked for it', () => d.dm.noteProposalMerged(pool, row, { config, sha }));
  // And the request the bot built it for says it is live, once (beside the
  // DM above; the merge of the streams can fold the two into one hook).
  await step('say on its request that it is live', () => d.live.announceLive(pool, { session: row, deps: { github: d.github, ws: d.ws } }));
  await step('record it going live', () => d.journey.recordChangeLive(pool, { config, session: row, sha }));
  return did;
}

/**
 * Close the requests it was linked to, as its own merge would have through
 * `Closes #N`: bounties on them resolve to its author, and each one closed is
 * then read as closed everywhere (the open-issues cache, its twin row, a
 * close-issue vote on it, the Homeroom bot's proposals built for it alone).
 * Resolves the numbers closed on GitHub, or with
 * `report`, { closed, failed: [{ number, status }] }, so a durable caller
 * (the merge-followups workflow machine) can retry the ones that failed;
 * with `strict`, a failure to record a close here (twin rows, superseded
 * proposals) throws, for the same caller to retry.
 */
async function closeRequests({ pool, row, carrier, github, repo, d, bounties = true, report = false, strict = false }) {
  const { sanitizeIssueNumbers } = require('./pr-metadata');
  const numbers = sanitizeIssueNumbers(row.linked_issues);
  const answer = (closed, failed) => (report ? { closed, failed } : closed);
  if (!numbers.length) return answer([], []);
  // The merge-followups workflow machine pays the bounties itself, in the
  // transition that marks the change merged (bounties: false).
  if (bounties) for (const n of numbers) {
    await d.resolveIssueBounty(pool, {
      appId: row.app_id, sessionId: row.id, awardeeUserId: row.user_id || null, issueNumber: n,
    }).catch((err) => log.warn('included-changes', 'Bounty payout failed', { sessionId: row.id, issueNumber: n, err: err.message }));
  }
  if (!github) return answer([], []);
  github.noteIssuesClosed?.(repo.owner, repo.repo, numbers);
  const closed = [];
  const failed = [];
  for (const n of numbers) {
    try {
      await github.closeIssue(repo.owner, repo.repo, n);
      closed.push(n);
    } catch (err) {
      failed.push({ number: n, status: err.status ?? null });
      log.warn('included-changes', 'Could not close a request of an included change', {
        sessionId: row.id, issueNumber: n, status: err.status, err: err.message,
      });
    }
  }
  if (failed.length) github.unsuppressIssues?.(repo.owner, repo.repo, failed.map((f) => f.number));
  if (closed.length) {
    const prNumber = carrier.pr_number || null;
    d.watcher.bustAndBroadcast({ owner: repo.owner, repo: repo.repo, appSlug: row.app_slug, appId: row.app_id, closed });
    await Promise.all([
      d.watcher.closeTwinRows({ pool, appId: row.app_id, prNumber, numbers: closed, strict }),
      d.watcher.resolveSupersededProposals({ pool, appId: row.app_id, appSlug: row.app_slug, prNumber, numbers: closed, strict }),
      d.watcher.withdrawBotProposals({ pool, appId: row.app_id, prNumber, numbers: closed, strict }),
    ]);
  }
  return answer(closed, failed);
}

module.exports = {
  includeStackedChanges,
  settleIncluded,
  closeRequests,
  depsOf,
  containedIn,
  prLabel,
  closingComment,
  threadLine,
  liveLine,
  authorLine,
  CANDIDATES_SQL,
  MARK_SQL,
};
