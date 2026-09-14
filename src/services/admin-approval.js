// Shared helpers for the per-app "locked" change-gate (admin must also
// approve before any group-voted change applies). The lock itself is a
// single `apps.locked` boolean toggled by admins via POST /api/apps/:slug/lock
// (see routes/apps.js); these helpers are consumed by the three vote-apply
// paths — checkAndMerge in routes/votes.js, maybeApplyRenameProposal and
// maybeApplySecretChangeProposal in routes/issues.js — so the rule reads
// the same way in all three places.
//
// Semantics:
//   - `isAppLocked(pool, appId)` — straight column read.
//   - `hasAdminYesVote(pool, sessionId)` — at least one FULL admin
//     (is_admin = TRUE AND admin_readonly = FALSE) has a 'yes' in pr_votes
//     that still counts for this proposal. A view-only admin's vote does
//     NOT satisfy the lock
//     (issue #311): the lock exists to require a trusted full admin to
//     sign off, and a view-only admin is by definition not a privileged
//     approver.
//
//     "Still counts" is the approval EPOCH (services/pr-vote-revision.js
//     currentVotePredicateSql) — the same rule every other tally on the
//     platform uses since #2038. This predicate used to compare the vote's
//     head_sha with the reviewed head instead, which was the pre-#2038
//     commit rule: a mechanical sync moved the head without moving the
//     epoch, so the admin's yes kept counting toward "enough approvals" and
//     stopped counting here — and the card asked the admin who had just
//     voted yes to vote yes. On a locked app that left every synced
//     proposal blocked for good (#2100, #2095), because voting yes again
//     is a no-op for an unchanged vote.
//   - `hasAdminUpVote(pool, issueId)` — same shape for issue_votes
//     ('up' instead of 'yes').
//
// Both lookups are cheap (`LIMIT 1` on indexed columns) and only run on
// the vote-apply path, which is already async + bounded — no perf concern.

const { currentVotePredicateSql } = require('./pr-vote-revision');

async function isAppLocked(pool, appId) {
  const { rows } = await pool.query(
    'SELECT locked FROM apps WHERE id = $1',
    [appId]
  );
  return !!rows[0]?.locked;
}

async function hasAdminYesVote(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM pr_votes pv
       JOIN chat_sessions cs ON cs.id = pv.session_id
       JOIN users u ON u.id = pv.user_id
      WHERE pv.session_id = $1
        AND pv.vote = 'yes'
        AND ${currentVotePredicateSql('pv', 'cs')}
        AND u.is_admin = TRUE
        AND u.admin_readonly = FALSE
      LIMIT 1`,
    [sessionId]
  );
  return rows.length > 0;
}

async function hasAdminUpVote(pool, issueId) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM issue_votes iv
       JOIN users u ON u.id = iv.user_id
      WHERE iv.issue_id = $1
        AND iv.vote = 'up'
        AND u.is_admin = TRUE
        AND u.admin_readonly = FALSE
      LIMIT 1`,
    [issueId]
  );
  return rows.length > 0;
}

module.exports = { isAppLocked, hasAdminYesVote, hasAdminUpVote };
