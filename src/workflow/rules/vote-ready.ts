// 6 Nov 2026 (#6402): one definition of "this change is ready to be voted
// on", for every list, count and notification that asks someone for a vote.
//
// Before this, Needs you listed any promoted change that was not yours and
// that you had not voted on, whatever its checks were doing: a yes cast
// while its tests ran (or while it waited to sync with main) was often
// thrown away when a fix push cleared the votes. A change is ready only once
// its checks passed (or it had nothing to test) AND it merges cleanly with
// main. Until then it waits under Waiting & in progress, worded by
// services/work-state.js, and voting early stays possible on the change's
// own page (routes/votes.js is untouched).
//
// #6531 (9 Nov 2026): the one conflict that IS ready is the one only a yes can
// move: the conflict lane has spent its free pre-vote resolution and waits for
// an approval (awaitingYesSql). It is asked for, counted and pinged like any
// ready change, and worded "Conflicts with main: Homeroom resolves it once you
// approve". Everything else that conflicts is Homeroom's to catch up and stays
// under Waiting & in progress.
//
// The predicate itself is one copy here, so the SQL readers cannot drift:
// services/vote-ready.js re-exports it with the pure `syncWaits(row)` test
// for facts rows, and services/workshop-overview.js (OWED_PROPOSALS_WHERE,
// and so every count, the feed and OWED_BY_COMMUNITY_SQL),
// services/vote-digest.js and the proposal machine's proposed/ready
// notification read it.

import { checkedAlias } from './vote-predicate.ts';

/**
 * The boolean SQL predicate "session alias `cs` waits to sync with main":
 * the checks are deferred until it merges cleanly, or a conflict with main
 * was recorded, or a measured merge did not come out clean. `NULL`
 * (`unknown`) is not a wait: a change nobody measured keeps today's
 * behaviour.
 */
export function syncWaitSql(sessionAlias = 'cs'): string {
  const cs = checkedAlias(sessionAlias);
  return `(${cs}.check_phase = 'deferred'
     OR ${cs}.merge_conflict_state IN ('conflict', 'failed')
     OR ${cs}.integration_merges_clean = FALSE)`;
}

/**
 * #6531 (9 Nov 2026): the boolean SQL predicate "session alias `cs` conflicts
 * with main and only a yes can move it": the conflict lane has already spent
 * its one free pre-vote resolution and is waiting for the group's approval.
 * Such a change IS ready for a vote even though it does not merge cleanly.
 */
export function awaitingYesSql(sessionAlias = 'cs'): string {
  const cs = checkedAlias(sessionAlias);
  return `(${cs}.integration_merges_clean = FALSE
     AND COALESCE(${cs}.integration_block_reasons, '[]'::jsonb) ? 'awaiting_approval')`;
}

/**
 * The boolean SQL predicate "session alias `cs` is ready for a vote": its
 * checks passed or were skipped, and it either waits only for a yes on a
 * conflict (awaitingYesSql) or does not wait to sync with main at all.
 */
export function voteReadySql(sessionAlias = 'cs'): string {
  const cs = checkedAlias(sessionAlias);
  return `(${cs}.check_state IN ('passing', 'skipped')
     AND (${awaitingYesSql(cs)} OR NOT COALESCE(${syncWaitSql(cs)}, FALSE)))`;
}
