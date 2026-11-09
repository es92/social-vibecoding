'use strict';

// WHICH PROPOSAL ADDRESSES AN ISSUE — the reverse of the issue chips a
// proposal's page already draws (#2431).
//
// A closed issue said nothing about what closed it, and an issue being
// worked on said nothing about the change in flight. Both links already
// exist in `chat_sessions`: `linked_issues` (the Mayor's addresses_issues,
// which also writes the PR body's "Closes #N") and
// `created_from_issue_number` (the issue a session was started from). So
// this resolves them rather than reading GitHub's timeline — no extra API
// call, and it answers for work that has not merged yet, which the timeline
// cannot.
//
// ONE query for a whole list of numbers. The issues list route calls it with
// every number on the board and the single-issue route with one, so neither
// pays per card.
//
// What it does NOT do: decide the wording. A merged proposal on a CLOSED
// issue reads "Closed by"; the same row on an issue still open reads
// "Addressed by", and only the caller knows the issue's state. The `state`
// here names the PROPOSAL's lifecycle and stops there.

const { IN_PROGRESS_PAUSED_WINDOW_DAYS } = require('./issue-progress');
const { planRecordSql } = require('./request-specs');

// Best first: a merged change is the record of what happened, a proposal
// under review is the next most definite thing, and live chats come last.
const RANK = { merged: 0, merging: 1, promoted: 2, active: 3, paused: 4 };

/** The three words the FE labels a reference with. */
function stateOf(status) {
  if (status === 'merged') return 'merged';
  if (status === 'promoted' || status === 'merging') return 'review';
  return 'underway';
}

/**
 * Whether this row has a page the viewer can actually open.
 *
 * Proposed work (promoted/merging/merged) is public. A live or paused chat
 * is owner-scoped: it is navigable only to its owner, or once its owner
 * shared it with the group — the same rule `pickInProgressTarget` applies to
 * the in-progress chip, so the two never disagree about what is clickable.
 *
 * #6488: a change that was ever up for a vote (`promoted_at`, set then and
 * never cleared) stays public afterwards, even closed or reopened: its
 * discussion was public, and history keeps it readable.
 */
function isNavigable(row, viewerId) {
  if (row.status === 'merged' || row.status === 'merging' || row.status === 'promoted') return true;
  if (row.promoted_at) return true;
  return !!row.shared_at || (viewerId != null && Number(row.user_id) === Number(viewerId));
}

function activityMs(row) {
  const t = Date.parse(row.last_activity_at || row.created_at || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * The proposal reference for each of `numbers`, as a Map keyed by issue
 * number. Numbers with no linked change are absent from the map — the FE
 * renders nothing rather than "not known yet", which would be a claim.
 */
async function resolveIssueProposalRefs(pool, appId, numbers, viewerId) {
  const out = new Map();
  const wanted = [...new Set((numbers || []).map(Number))]
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!pool || !appId || !wanted.length) return out;

  // Paused rows age out on the same window the in-progress rules use, so an
  // abandoned chat stops claiming an issue here too.
  const { rows } = await pool.query(
    `SELECT cs.id, cs.status, cs.user_id, cs.shared_at, cs.promoted_at, cs.pr_number, cs.pr_url,
            cs.linked_issues, cs.created_from_issue_number,
            cs.last_activity_at, cs.created_at,
            COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, ''),
                     NULLIF(cs.branch_name, '')) AS title
       FROM chat_sessions cs
      WHERE cs.app_id = $1 AND cs.is_headless = FALSE
        -- 1 Nov 2026: a person's posted plan (request-specs.js) is no
        -- change: it has no branch, and Homeroom bot builds from it.
        AND NOT ${planRecordSql('cs')}
        AND (cs.linked_issues && $2::int[]
             OR cs.created_from_issue_number = ANY($2::int[]))
        AND (cs.status IN ('active', 'promoted', 'merging', 'merged')
             OR (cs.status = 'paused'
                 AND cs.last_activity_at > NOW() - make_interval(days => $3)))`,
    [appId, wanted, IN_PROGRESS_PAUSED_WINDOW_DAYS]
  );

  const want = new Set(wanted);
  for (const row of rows) {
    if (!isNavigable(row, viewerId)) continue;
    const linked = new Set((row.linked_issues || []).map(Number));
    if (row.created_from_issue_number != null) linked.add(Number(row.created_from_issue_number));
    for (const n of linked) {
      if (!want.has(n)) continue;
      const best = out.get(n);
      const rank = RANK[row.status] ?? 9;
      if (best && (best._rank < rank
        || (best._rank === rank && best._at >= activityMs(row)))) continue;
      out.set(n, {
        _rank: rank,
        _at: activityMs(row),
        sessionId: row.id,
        state: stateOf(row.status),
        prNumber: row.pr_number || null,
        prUrl: row.pr_url || null,
        title: row.title || null,
      });
    }
  }
  for (const ref of out.values()) { delete ref._rank; delete ref._at; }
  return out;
}

module.exports = { resolveIssueProposalRefs, isNavigable, stateOf };
