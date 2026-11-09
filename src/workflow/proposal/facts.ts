// What the proposal machine reads inside a transition. The proposal's row is
// locked first and read by the next statement: a statement that waited for a
// lock keeps the snapshot it started with, so a vote, a turn or a merge
// committed while this transition waited would be missing from a read folded
// into the locking one. Everything a decision rests on is read here, under
// that lock, and nothing is cached:
//
//   - who is working on the proposal (src/workflow/session-work.ts: its
//     coding turn, a turn on its author's own machine, its shots run, an old
//     flow's recorded operation, a durable build that holds it);
//   - for a move into a slot or into review, the caps, counted under a lock
//     on the owner's users row and, for the platform-wide cap, a
//     transaction-scoped advisory lock: two such moves for one owner wait for
//     each other, so neither counts the other out (R5);
//   - for a merge claim and the review check, the vote gate (rules/pr-gate.ts),
//     so a vote committed before the decision is counted (R1, R2);
//   - for a move that brings the session back (a resume, a reopen), the
//     teardown work still owed for it, its rows locked: one not claimed yet
//     cannot be claimed before the move cancels it (the claim skips locked
//     rows), and one any attempt has started is read as under way, so the
//     move waits for it rather than racing it.

import type { Event, Tx } from '../kernel/index.ts';
import { readPrGate } from '../rules/pr-gate.ts';
import { readClaimFacts } from '../rules/merge-claim.ts';
import type { ClaimFacts } from '../rules/merge-claim.ts';
import type { GovernedGate } from '../rules/governance-gate.ts';
import { appMetaFromRow, governanceFromRow } from '../rules/governance-gate.ts';
import { electorate, getApproverSet } from '../rules/electorate.ts';
import { parseRepoAddress } from '../rules/github-url.ts';
import { onMain, readBaseOwner, readWaiting } from '../rules/pr-base.ts';
import type { BaseOwner } from '../rules/pr-base.ts';
import { NOT_MOVING_KINDS, botLookingSql, buildHoldSql, movingTurnSql, operationsLiveSql, shotsRunningSql, syncWorkingSql } from '../session-work.ts';

export interface Row {
  id: number;
  appId: number;
  appSlug: string;
  selfHosted: boolean;
  repo: { owner: string; repo: string } | null;
  userId: number | null;
  ownerName: string | null;
  ownerSynthetic: boolean;
  status: string;
  imported: boolean;
  // A maintenance campaign's proposal (source 'maintenance'): it holds no
  // worker slot.
  platform: boolean;
  headless: boolean;
  prNumber: number | null;
  prTitle: string | null;
  branch: string | null;
  // The commit the vote is on: an import's pull-request head, else the
  // reviewed head; and the two columns themselves.
  head: string | null;
  reviewedHead: string | null;
  importedHead: string | null;
  epoch: number;
  promotedAt: string | null;
  createdAt: string;
  staleNotifiedAt: string | null;
  lastActivityAt: string | null;
  // Closed: since when, and whether its CC volume is gone already (the
  // retention purge, cc.purge).
  archivedAt: string | null;
  ccPurged: boolean;
  linkedIssues: number[];
  agentSessionId: number | null;
  explicitApproval: boolean;
  explicitReason: string | null;
  mergeAttemptAt: string | null;
  // Its before & after shots have been declared or asked for: a head move
  // tells the shots machine (one that never declared anything is left alone).
  shots: boolean;
  // A staging fixture (migrate.js seeds it active to show what an active
  // session paints): never paused for being idle on a staging deployment.
  fixture: boolean;
  // Somebody works on it: its coding turn (activeTurn, its journal), a turn
  // on its author's own machine or an old flow's recorded operation other
  // than the caller's own (workedOn), its shots run (shotsRunning).
  // `moving`: what may still move its branch under a promote or an
  // unpromote: its coding turn, a turn on its author's machine, an old
  // flow's operation (a sync, an upload) other than the caller's own, a
  // worker's turn record (whose end is recorded after the turn, and is
  // read as its journal instead) and a hand-off's pipeline (which checks
  // the very commit being proposed, as [main] let it).
  // `mergeMoving`: the same, less the shots agent's turn, for the merge
  // queue's ask (machine.ts askRefusal). It only takes pictures of the head
  // (session-work.ts NOT_MOVING_TURN_MODES), so a merge does not wait for
  // it; a promote or an unpromote still does (an unpromote destroys the
  // worker it runs in).
  activeTurn: boolean;
  workedOn: boolean;
  moving: boolean;
  mergeMoving: boolean;
  shotsRunning: boolean;
  // A durable build (the Homeroom bot's, a bench trial's) holds it.
  buildHold: boolean;
  pendingSecret: boolean;
  // The merge and a sync with main: the verdict's commit and state, the
  // once-records of the platform's own syncs, the mirror's last measurement
  // (head and main), the epoch rule C spent its resolution on, and whether
  // its head lives on its author's fork (nowhere to push a resolution).
  checkState: string | null;
  checksCommitSha: string | null;
  bootFailureSyncHead: string | null;
  fixedCheckSyncHead: string | null;
  fixedCheckSyncKeys: string[];
  integrationHead: string | null;
  integrationMain: string | null;
  // #6546: how far behind main the mirror last measured it (null: never).
  integrationBehindBy: number | null;
  integrationResolvedEpoch: number | null;
  forkHead: boolean;
  // An import's base on GitHub as last read, and the open change whose branch
  // it is (rules/pr-base.ts): a base that is not main is never merged. That
  // change's status: it is waited for only while it is open.
  baseRef: string | null;
  waitsFor: number | null;
  waitsForStatus: string | null;
}

export interface Caps {
  promoted: number;      // the owner's proposals in review or going up for one
  active: number;        // the owner's sessions holding a slot
  global: number;        // the sessions spending the platform-wide budget
}

export interface Facts {
  row: Row | null;
  caps: Caps | null;
  gate: GovernedGate | null;
  // ReviewCheck: the last sign of interest (its promotion or the newest vote
  // that counts).
  interestAt: string | null;
  // ReviewCheck on a proposal whose votes are met: the app's merges are
  // paused by a red main (rules/merge-claim.ts mainPaused).
  mergesPaused: boolean;
  // review.open's success: the electorate, stamped as it goes up for a vote.
  electorate: number | null;
  // merge.gate found it ready: what the claim reads again under the lock.
  claim: ClaimFacts | null;
  // Resume, Reopen: teardown work (a worker destroy, a CC purge) under way
  // or done and not reported yet.
  tearingDown: boolean;
  // Promote of an import whose pull request's base is not main: the open
  // change whose branch that base is (it waits for it), or the one it waited
  // for, merged since (it is being moved onto main), else none.
  baseOwner: BaseOwner | null;
  // Merged, PrLooked: the open changes stacked on this one's branch, told
  // once it is on main (rules/pr-base.ts readWaiting).
  waiting: number[];
}

export const NO_FACTS: Facts = {
  row: null, caps: null, gate: null, interestAt: null, mergesPaused: false, electorate: null, tearingDown: false, claim: null,
  baseOwner: null, waiting: [],
};

// The platform-wide slot count's lock: every move into a slot takes it, for
// the length of its transaction.
export const GLOBAL_SLOTS_LOCK = 'homeroom:proposal-slots';

const SHA = /^[0-9a-f]{40}$/;
const sha = (v: unknown) => (SHA.test(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null);
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const issueNumbers = (v: unknown): number[] =>
  [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

// The sessions spending the platform-wide budget (services/session-caps.js
// GLOBAL_SESSIONS_SQL): active and in review, an import's aside.
const GLOBAL_COUNT = `(SELECT COUNT(*)::int FROM chat_sessions g
                        WHERE g.status IN ('active', 'promoted') AND g.source IS DISTINCT FROM 'imported')`;

async function readRow(tx: Tx, sessionId: number, ownOperation: string | null): Promise<Row | null> {
  await tx.query('SELECT 1 FROM chat_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
  const { rows: [r] } = await tx.query(
    `SELECT cs.id, cs.app_id, cs.user_id, cs.status, cs.source, cs.is_headless, cs.pr_number, cs.pr_title,
            cs.branch_name, cs.reviewed_head_sha, cs.imported_pr_head_sha, cs.approval_epoch, cs.promoted_at,
            cs.created_at, cs.stale_notified_at, cs.last_activity_at, cs.archived_at, cs.cc_purged, cs.linked_issues, cs.agent_session_id,
            cs.requires_explicit_approval, cs.explicit_approval_reason, cs.merge_attempt_at,
            cs.check_state, cs.checks_commit_sha, cs.boot_failure_sync_head, cs.fixed_check_sync_head, cs.fixed_check_sync_keys,
            cs.integration_head_sha, cs.integration_main_sha, cs.integration_behind_by, cs.integration_resolved_epoch, cs.imported_pr_head_repo,
            cs.imported_pr_base_ref, cs.waits_for_session_id,
            (SELECT w.status FROM chat_sessions w WHERE w.id = cs.waits_for_session_id) AS waits_for_status,
            (cs.shots_state IS NOT NULL OR cs.shots_detail IS NOT NULL
              OR EXISTS (SELECT 1 FROM wf_instances sh WHERE sh.machine = 'shots' AND sh.key = 'session:' || cs.id)) AS shots,
            cs.active_turn IS NOT NULL AS active_turn,
            ${movingTurnSql('cs')} AS moving_turn,
            EXISTS (SELECT 1 FROM local_agent_turns t
                     WHERE t.session_id = cs.id AND t.status IN ('queued', 'offered', 'accepted', 'running')) AS local_turn,
            -- A sync and the Homeroom bot's look are their machines' own work
            -- (session-work.ts), counted as the operations they once recorded.
            (${operationsLiveSql('cs.id', '$2::text')} OR ${syncWorkingSql('cs.id')} OR ${botLookingSql('cs.id')}) AS operations,
            (${operationsLiveSql('cs.id', '$2::text', NOT_MOVING_KINDS)} OR ${syncWorkingSql('cs.id')}) AS moving_operations,
            ${shotsRunningSql('cs.id')} AS shots_running,
            ${buildHoldSql('cs')} AS build_hold,
            EXISTS (SELECT 1 FROM pending_secret_declarations p
                     WHERE p.session_id = cs.id AND p.status = 'pending') AS pending_secret,
            a.slug AS app_slug, a.repo_url, a.self_hosted,
            u.username AS owner_name, COALESCE(u.is_synthetic, FALSE) AS owner_synthetic
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.id = $1`, [sessionId, ownOperation]);
  if (!r) return null;
  const imported = r.source === 'imported';
  return {
    id: r.id, appId: r.app_id, appSlug: r.app_slug, selfHosted: !!r.self_hosted,
    repo: r.repo_url ? parseRepoAddress(r.repo_url) : null,
    userId: r.user_id ?? null, ownerName: r.owner_name ?? null, ownerSynthetic: !!r.owner_synthetic,
    status: r.status, imported, platform: r.source === 'maintenance', headless: !!r.is_headless,
    prNumber: r.pr_number ?? null, prTitle: r.pr_title ?? null, branch: r.branch_name ?? null,
    head: imported ? sha(r.imported_pr_head_sha) : sha(r.reviewed_head_sha),
    reviewedHead: sha(r.reviewed_head_sha), importedHead: sha(r.imported_pr_head_sha),
    epoch: Number(r.approval_epoch) || 0,
    promotedAt: iso(r.promoted_at), createdAt: iso(r.created_at)!, staleNotifiedAt: iso(r.stale_notified_at),
    lastActivityAt: iso(r.last_activity_at),
    archivedAt: iso(r.archived_at),
    ccPurged: !!r.cc_purged,
    linkedIssues: issueNumbers(r.linked_issues), agentSessionId: r.agent_session_id ?? null,
    explicitApproval: !!r.requires_explicit_approval, explicitReason: r.explicit_approval_reason ?? null,
    mergeAttemptAt: iso(r.merge_attempt_at), shots: !!r.shots,
    fixture: String(r.branch_name || '').startsWith('staging-fixture/'),
    activeTurn: !!r.active_turn, workedOn: !!r.local_turn || !!r.operations,
    moving: !!r.active_turn || !!r.local_turn || !!r.moving_operations,
    mergeMoving: !!r.moving_turn || !!r.local_turn || !!r.moving_operations, shotsRunning: !!r.shots_running,
    buildHold: !!r.build_hold, pendingSecret: !!r.pending_secret,
    checkState: r.check_state ?? null, checksCommitSha: sha(r.checks_commit_sha),
    bootFailureSyncHead: sha(r.boot_failure_sync_head), fixedCheckSyncHead: sha(r.fixed_check_sync_head),
    fixedCheckSyncKeys: Array.isArray(r.fixed_check_sync_keys) ? r.fixed_check_sync_keys.map(String) : [],
    integrationHead: sha(r.integration_head_sha), integrationMain: sha(r.integration_main_sha),
    integrationBehindBy: r.integration_behind_by == null ? null : Number(r.integration_behind_by),
    integrationResolvedEpoch: r.integration_resolved_epoch == null ? null : Number(r.integration_resolved_epoch),
    forkHead: imported && forkOf(r),
    baseRef: r.imported_pr_base_ref ?? null,
    waitsFor: r.waits_for_session_id ?? null,
    waitsForStatus: r.waits_for_status ?? null,
  };
}

// An imported head on its author's fork (services/proposal-update.js
// branchHomeOf): a resolution has nowhere to be pushed.
const PLATFORM_BRANCHES = ['usernode/from-', 'usernode/patch-'];
function forkOf(r: any): boolean {
  const name = (v: unknown) => {
    const m = /^([a-z0-9._-]+)\/([a-z0-9._-]+?)(?:\.git)?$/.exec(String(v ?? '').trim().toLowerCase());
    return m ? `${m[1]}/${m[2]}` : null;
  };
  const head = name(r.imported_pr_head_repo);
  const parsed = parseRepoAddress(r.repo_url);
  const appRepo = parsed ? name(`${parsed.owner}/${parsed.repo}`) : null;
  if (head && appRepo) return head !== appRepo;
  return !PLATFORM_BRANCHES.some((p) => String(r.branch_name ?? '').startsWith(p));
}

// The caps' counts, under the owner's lock (and the platform's, `global`).
async function readCaps(tx: Tx, row: Row, global: boolean): Promise<Caps> {
  // FOR NO KEY UPDATE: serializes the owner's moves into a slot or review
  // without queueing behind the rows that reference the user.
  if (row.userId != null) await tx.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [row.userId]);
  if (global) await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [GLOBAL_SLOTS_LOCK]);
  const { rows: [c] } = await tx.query(
    `SELECT (SELECT COUNT(*)::int FROM chat_sessions cs
              WHERE cs.user_id = $1 AND cs.is_headless = FALSE
                AND (cs.status IN ('promoted', 'merging')
                     OR EXISTS (SELECT 1 FROM wf_instances w
                                 WHERE w.machine = 'proposal' AND w.key = 'session:' || cs.id
                                   AND w.state = 'proposing'))) AS promoted,
            (SELECT COUNT(*)::int FROM chat_sessions cs
              WHERE cs.user_id = $1 AND cs.status = 'active' AND cs.source IS DISTINCT FROM 'imported') AS active,
            CASE WHEN $2::boolean THEN ${GLOBAL_COUNT} ELSE 0 END AS global`,
    [row.userId, global]);
  return { promoted: Number(c.promoted) || 0, active: Number(c.active) || 0, global: Number(c.global) || 0 };
}

// What the review check reads beside the gate: when the group last showed
// interest (the promotion, or the newest vote on it from someone whose vote
// counts, whatever its epoch). A vote the gate would not count is not the
// group's interest: on 17 Oct one account's fourteen Yes votes, none of
// which counted where they were cast, kept proposals nobody else had looked
// at for a week from ever going stale. The voter is the gate's rule
// (counts_toward_session_outcome, and an invited project's approver set);
// the epoch is not, so new code that cleared the votes does not make a
// proposal look forgotten the hour after it was pushed.
export async function readInterest(tx: Tx, row: Row): Promise<string | null> {
  const { rows: [a] } = await tx.query('SELECT approver_policy, governance_rules FROM apps WHERE id = $1', [row.appId]);
  const gov = a ? governanceFromRow(a) : null;
  const approvers = gov && gov.approverPolicy === 'invited' && !gov.rules ? (await getApproverSet(tx, row.appId)).ids : null;
  const { rows: [r] } = await tx.query(
    `SELECT GREATEST(COALESCE($2::timestamptz, $3::timestamptz),
                     COALESCE((SELECT MAX(pv.created_at) FROM pr_votes pv
                                WHERE pv.session_id = $1 AND pv.vote IN ('yes', 'no')
                                  AND counts_toward_session_outcome(pv.user_id, pv.session_id)
                                  AND ($4::int[] IS NULL OR pv.user_id = ANY($4::int[]))),
                              $2::timestamptz, $3::timestamptz))
              AS at`, [row.id, row.promotedAt, row.createdAt, approvers]);
  return iso(r?.at);
}

async function readElectorate(tx: Tx, appId: number): Promise<number | null> {
  const { rows: [a] } = await tx.query(
    'SELECT approver_policy, approvals_required, governance_rules, self_hosted, collab_visibility FROM apps WHERE id = $1', [appId]);
  if (!a) return null;
  const { active } = await electorate(tx, appId, governanceFromRow(a), appMetaFromRow(a));
  return Math.max(Number(active) || 0, 1);
}

export interface ReadOptions {
  now: Date;
  // A work result for the open review (its result is stamped with the
  // electorate).
  reviewOpened?: boolean;
  // The teardown work a move that brings the session back waits for.
  teardownKinds?: string[];
  // merge.gate found it ready: the claim's inputs (an admin's force skips
  // the votes; the protected-settings check is the one the gate made live).
  claim?: { force: boolean; result: { explicitApproval?: boolean; explicitReason?: string | null } };
}

// Teardown work outstanding for the session, its rows locked (see the top).
// Only an item no attempt has started is cancelled by the move: one running
// (its lease lapsed or not: a lapsed lease does not prove its call stopped,
// a stalled process may still be in it), done and not reported, or waiting
// to be tried again after an attempt (which may have asked for the removal
// already) is teardown under way, and the move waits for it.
async function readTeardown(tx: Tx, sessionId: number, kinds: string[]): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT status, attempt_count FROM wf_work
      WHERE machine = 'proposal' AND key = $1 AND kind = ANY($2::text[]) AND status IN ('queued', 'running', 'reported')
        FOR UPDATE`, [`session:${sessionId}`, kinds]);
  return rows.some((r: any) => r.status !== 'queued' || Number(r.attempt_count) > 0);
}

export async function readFacts(tx: Tx, sessionId: number, event: Event<any>, o: ReadOptions): Promise<Facts> {
  const p = event.payload || {};
  const row = await readRow(tx, sessionId, typeof p.ownOperation === 'string' ? p.ownOperation : null);
  if (!row) return NO_FACTS;
  const out: Facts = { ...NO_FACTS, row };
  if (event.type === 'Promote') out.caps = await readCaps(tx, row, false);
  if (event.type === 'Promote' && row.imported && p.pr && !onMain(p.pr.base)) {
    const owners = await readBaseOwner(tx, { appId: row.appId, sessionId: row.id, base: p.pr.base, waited: row.waitsFor });
    out.baseOwner = owners.open || owners.merged;
  }
  if (event.type === 'Merged' || (event.type === 'PrLooked' && p.merged)) out.waiting = await readWaiting(tx, row.id);
  if (event.type === 'Resume' && p.caps) out.caps = await readCaps(tx, row, true);
  const gated = event.type === 'ReviewCheck';
  if (gated && row.status === 'promoted') {
    out.gate = await readPrGate(tx, {
      sessionId: row.id, appId: row.appId, openedAt: row.promotedAt || row.createdAt,
      // A claim names the protected-settings check it made on the live head;
      // the hourly check reads the stored flag.
      explicitApproval: row.explicitApproval,
      explicitReason: row.explicitReason,
      authorId: row.userId, now: o.now,
    });
  }
  if (event.type === 'ReviewCheck') out.interestAt = await readInterest(tx, row);
  if (gated && out.gate?.mergeable) out.mergesPaused = !!(await readClaimFacts(tx, row.id))?.mainPaused;
  if (o.reviewOpened) out.electorate = await readElectorate(tx, row.appId);
  if (o.teardownKinds?.length) out.tearingDown = await readTeardown(tx, row.id, o.teardownKinds);
  if (o.claim && row.status === 'promoted') {
    out.claim = await readClaimFacts(tx, row.id);
    if (!o.claim.force) {
      out.gate = await readPrGate(tx, {
        sessionId: row.id, appId: row.appId, openedAt: row.promotedAt || row.createdAt,
        explicitApproval: !!o.claim.result?.explicitApproval, explicitReason: o.claim.result?.explicitReason ?? null,
        authorId: row.userId, now: o.now,
      });
    }
  }
  return out;
}
