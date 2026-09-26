'use strict';

// Title auto-heal sweeper. When the Anthropic API is unavailable (credits
// exhausted, outage), two surfaces silently degrade to template titles:
//
//  - PRs: pr-metadata.js falls back to "<user>'s changes" and marks the
//    session with chat_sessions.pr_title_fallback = TRUE.
//  - Feedback issues: routes/feedback.js files with "Feedback from
//    Homeroom" and enqueues a title_heal_queue row.
//
// Both used to require a manual one-off to repair (2026-07-13 credits
// outage). This sweeper retries generation on a timer once the API is
// back: PR rows re-run the full applyPrMetadata pipeline (which clears the
// flag and updates GitHub + the session title on success); issue rows get
// a fresh Haiku title PATCHed onto the GitHub issue, then the queue row is
// deleted. PR retries re-resolve the owner's current payer before making a
// new model call, so the sweeper cannot bypass their daily tier.
//
// Bounded per pass (a handful of Haiku calls), never overlapping, and a
// no-op while llm.isEnabled() is false — no point hammering a dead API.

const log = require('./logger');
const llm = require('./llm');
const github = require('./github');
const prMetadata = require('./pr-metadata');
const limits = require('./limits');
const { getPool } = require('../db/pool');
const { pushVoteUpdate, pushIssueUpdate } = require('./ws');

// Give up on a queued issue title after this many failed attempts (~2
// weeks at the backoff cap). The issue keeps its fallback title forever at
// that point — same outcome as pre-feature, so abandoning is safe.
const MAX_ISSUE_ATTEMPTS = 10;
// Per-row exponential backoff: 15m, 30m, 1h, ... capped at 24h. Keeps a
// multi-day outage from burning an attempt every sweep tick.
const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_CAP_MS = 24 * 60 * 60 * 1000;

function parseRepo(repoUrl) {
  const m = (repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

// Retry PR title generation for sessions still marked pr_title_fallback.
// applyPrMetadata owns the whole pipeline (context gather, generation,
// GitHub update, DB persist, flag clear), so this is just "find flagged
// rows and re-drive it". Production passes dataKey and enforces the current
// payer; omitting it preserves the direct unit-helper contract.
async function healPrTitles(pool, { limit = 5, dataKey } = {}) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.id AS heal_app_id, a.slug AS heal_app_slug, a.repo_url AS heal_repo_url,
            u.username AS heal_username
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
       JOIN users u ON u.id = cs.user_id
      WHERE cs.pr_title_fallback = TRUE
        AND cs.pr_number IS NOT NULL
        AND cs.status != 'archived'
      ORDER BY cs.id ASC
      LIMIT $1`,
    [limit]
  );
  let healed = 0;
  for (const session of rows) {
    const repo = parseRepo(session.heal_repo_url);
    if (!repo) continue;
    try {
      let apiKey = null;
      let billedUserId = null;
      if (dataKey !== undefined) {
        const billing = await limits.resolveBillingPath(pool, dataKey, session.user_id);
        if (billing.error) {
          log.info('title-heal', 'PR title heal deferred: no payer available', {
            sessionId: session.id, reason: billing.reason || null,
          });
          continue;
        }
        apiKey = billing.apiKey;
        billedUserId = session.user_id;
      }
      await prMetadata.applyPrMetadata({
        pool, session,
        repoOwner: repo.owner, repoName: repo.repo,
        username: session.heal_username,
        apiKey,
        userId: billedUserId,
        // A PR that got its fallback title before the author's submitted
        // title could reach it (e.g. minted by staging recovery pre-update)
        // heals to that title rather than to a generated guess.
        preferredTitle: session.proposed_pr_title || null,
      });
      // applyPrMetadata mutates session in place; the flag flips to false
      // only when generation actually succeeded (fallback keeps it TRUE).
      if (session.pr_title_fallback === false) {
        healed++;
        log.info('title-heal', 'PR title regenerated', {
          sessionId: session.id, prNumber: session.pr_number, title: session.pr_title,
        });
        pushVoteUpdate({ sessionId: session.id, appId: session.app_id, appSlug: session.heal_app_slug, merged: false });
      }
    } catch (err) {
      log.warn('title-heal', 'PR title heal attempt failed', {
        sessionId: session.id, code: err.code || null, ...github.describeGithubError(err),
      });
    }
  }
  return { scanned: rows.length, healed };
}

// Retry title generation for feedback issues in title_heal_queue. Success
// deletes the row; failure bumps attempts with exponential backoff and
// abandons the row past MAX_ISSUE_ATTEMPTS. A reply that is no usable
// title resolves (not throws) with the reporter's own words (#3193), so
// that is what gets PATCHed: a refusal never reaches GitHub, and the row
// is not retried for an answer that won't change.
async function healIssueTitles(pool, { limit = 10, dataKey } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM title_heal_queue
      WHERE next_attempt_at <= NOW()
      ORDER BY next_attempt_at ASC
      LIMIT $1`,
    [limit]
  );
  let healed = 0;
  for (const row of rows) {
    try {
      let apiKey = null;
      let billedUserId = null;
      if (dataKey !== undefined) {
        if (!row.user_id) throw new Error('queued title has no attributable user');
        const billing = await limits.resolveBillingPath(pool, dataKey, row.user_id);
        if (billing.error) throw new Error(`title billing unavailable: ${billing.error}`);
        apiKey = billing.apiKey;
        billedUserId = row.user_id;
      }
      const generated = await llm.generateIssueTitle({
        description: row.description,
        apiKey: apiKey || undefined,
      });
      const { title } = generated;
      if (generated.usage && billedUserId != null) {
        const costCents = llm.estimateCostCents(generated.usage, generated.model);
        await limits.recordSpend(pool, billedUserId, costCents, { byok: !!apiKey });
      }
      // PAT-first PATCH with installation fallback — lives in github.js
      // since #556 shares it with the author-rename route.
      await github.patchIssueTitle(row.owner, row.repo, row.issue_number, title);
      await pool.query(`DELETE FROM title_heal_queue WHERE id = $1`, [row.id]);
      healed++;
      log.info('title-heal', 'Issue title regenerated', {
        repo: `${row.owner}/${row.repo}`, issueNumber: row.issue_number, title,
      });
      // Bust the open-issues cache + nudge any open panel to refetch, so
      // the healed title (and the disappearing placeholder chip) show up
      // without a reload. Best-effort — the cache TTL heals this anyway.
      try {
        github.invalidateIssuesCache(row.owner, row.repo);
        const { rows: apps } = await pool.query('SELECT id, slug, repo_url FROM apps');
        const target = apps.find((a) => {
          const r = parseRepo(a.repo_url);
          return r && r.owner.toLowerCase() === row.owner.toLowerCase()
            && r.repo.toLowerCase() === row.repo.toLowerCase();
        });
        if (target) {
          pushIssueUpdate({
            action: 'updated', source: 'github',
            appSlug: target.slug, appId: target.id, issueNumber: row.issue_number,
          });
        }
      } catch (err) {
        log.warn('title-heal', 'Failed to announce healed issue title', { err: err.message });
      }
    } catch (err) {
      const attempts = (parseInt(row.attempts, 10) || 0) + 1;
      if (attempts >= MAX_ISSUE_ATTEMPTS) {
        await pool.query(`DELETE FROM title_heal_queue WHERE id = $1`, [row.id]);
        log.warn('title-heal', 'Giving up on issue title heal', {
          repo: `${row.owner}/${row.repo}`, issueNumber: row.issue_number, attempts, err: err.message,
        });
      } else {
        const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
        await pool.query(
          `UPDATE title_heal_queue
              SET attempts = $2, next_attempt_at = NOW() + ($3 || ' milliseconds')::interval
            WHERE id = $1`,
          [row.id, attempts, String(delayMs)]
        );
        log.warn('title-heal', 'Issue title heal attempt failed; backing off', {
          repo: `${row.owner}/${row.repo}`, issueNumber: row.issue_number, attempts, delayMs, err: err.message,
        });
      }
    }
  }
  return { scanned: rows.length, healed };
}

// One sweep pass. Skips entirely while the LLM is disabled (no admin key)
// — a per-call BYOK key can't help here, this is platform work.
async function sweep(config) {
  if (!llm.isEnabled()) return { skipped: true };
  const pool = getPool(config);
  const pr = await healPrTitles(pool, { dataKey: config.dataEncryptionKey });
  const issues = await healIssueTitles(pool, { dataKey: config.dataEncryptionKey });
  if (pr.healed || issues.healed) {
    log.info('title-heal', 'Sweep pass healed titles', { pr, issues });
  }
  return { pr, issues };
}

module.exports = {
  sweep, healPrTitles, healIssueTitles,
  MAX_ISSUE_ATTEMPTS, BACKOFF_BASE_MS, BACKOFF_CAP_MS,
};
