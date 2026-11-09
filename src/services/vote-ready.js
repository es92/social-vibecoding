'use strict';

// 6 Nov 2026 (#6402): one definition of "this change is ready to be voted
// on" for every list, count and notification that asks for a vote.
//
// A change is ready only once its checks passed (or it had nothing to test)
// AND it merges cleanly with main. Until then it waits under Waiting & in
// progress, worded by services/work-state.js, and voting early stays
// possible on the change's own page. Before this, Needs you asked for a vote
// while the tests were still running, and a fix push often cleared the yes.
//
// The readers, all of them through this module's two SQL fragments:
//   services/workshop-overview.js  OWED_PROPOSALS_WHERE, and so COUNTS_SQL,
//                                  ITEMS_SQL, NEEDS_FEED_SQL,
//                                  NEEDS_FEED_IN_THREADS_SQL (the Homeroom
//                                  bot tab), OWED_BY_COMMUNITY_SQL and
//                                  services/places.js;
//   services/vote-digest.js        the daily "what needs your vote" digest;
//   workflow/rules/proposal-notifications.ts
//                                  the "new proposal to vote on" ping, now
//                                  sent when the checks pass rather than at
//                                  promotion.
//
// The predicate itself is one copy, in src/workflow/rules/vote-ready.ts, so
// the proposal machine and the preview machine read the same words.

const { syncWaitSql, voteReadySql, awaitingYesSql } = require('../workflow/rules/vote-ready.ts');

/**
 * Pure: whether one facts row is still waiting to sync with main. The same
 * test as syncWaitSql, on a row's columns (`check_phase`,
 * `merge_conflict_state`, `integration_merges_clean`).
 */
function syncWaits(row) {
  if (!row) return false;
  if (row.check_phase === 'deferred') return true;
  if (row.merge_conflict_state === 'conflict' || row.merge_conflict_state === 'failed') return true;
  return row.integration_merges_clean === false;
}

/** Pure: whether one facts row waits for a yes on a conflict (the same test
 * as awaitingYesSql, on a row's columns). */
function awaitsYes(row) {
  if (!row) return false;
  if (row.integration_merges_clean !== false) return false;
  const reasons = Array.isArray(row.integration_block_reasons) ? row.integration_block_reasons : [];
  return reasons.map(String).includes('awaiting_approval');
}

// #6531 (9 Nov 2026): what a change that does not merge cleanly waits on, and
// so where it is listed and what it says. `vote`: only a yes can move it, so
// it is in Needs you. `syncing`: the conflict lane is resolving it now or
// will next, so it stays under Waiting & in progress as "Syncing with main".
// `author`: nobody but its author (or, for a bot change, the bot) can move it.
// `null`: it does not wait to sync at all (today's path).
const AUTHOR_REASONS = new Set(['unresolvable', 'fork_head', 'checks_failing', 'checks_error']);

/** Pure: 'vote' | 'syncing' | 'author' | null for one facts row. */
function syncStand(row) {
  if (!syncWaits(row)) return null;
  const reasons = (Array.isArray(row?.integration_block_reasons) ? row.integration_block_reasons : []).map(String);
  if (awaitsYes(row)) return 'vote';
  if (reasons.some((r) => AUTHOR_REASONS.has(r))) return 'author';
  if (row?.merge_conflict_state === 'failed') return 'author';
  return 'syncing';
}

module.exports = { syncWaitSql, voteReadySql, awaitingYesSql, syncWaits, awaitsYes, syncStand };
