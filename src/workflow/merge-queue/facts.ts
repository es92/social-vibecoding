// What the merge queue reads: the app's line, every proposal in review with
// what its two lanes need to know about it, read in the queue's transaction.
// Nothing here is locked: the queue only asks, and the proposal machine
// decides under its own lock whether the proposal may be measured, claimed
// or synced, and answers. (The rules are the ones the old in-process
// queue, services/merge-queue.js, kept, #2038: workflow-foundation's design-merge.md.)
//
//   approved   the vote gate as it stands (rules/pr-gate.ts)
//   effort     what the candidate still costs: a measured conflict, then a
//              head whose verdict is not settled yet
//   lanes      a head that merges cleanly (or was never measured) goes to the
//              direct lane; one measured conflicting to the conflict lane,
//              admitted by rule C
//
// An import based on a branch that is not main is not in the line at all
// (rules/pr-base.ts): it waits for the change under it, and is neither merged
// nor synced until it has been moved onto main.

import type { Tx } from '../kernel/index.ts';
import { readPrGate } from '../rules/pr-gate.ts';
import { parseRepoAddress } from '../rules/github-url.ts';

const SHA = /^[0-9a-f]{40}$/;
const sha = (v: unknown) => (SHA.test(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null);
const ms = (v: unknown) => (v == null ? 0 : new Date(v as string).getTime() || 0);

export interface Candidate {
  id: number;
  head: string | null;
  epoch: number;
  approved: boolean;
  forced: boolean;
  // The commit an admin's force skips the checks on (rules/merge-claim.ts).
  forcedHead: string | null;
  yes: number;
  waitedSince: number;
  // The mirror's last measurement of this head: true clean, false conflict,
  // null never measured.
  mergesClean: boolean | null;
  // GitHub refused this head against this main as a conflict the mirror did
  // not measure: it is the conflict lane's (and its sync runs the turn).
  githubConflict: boolean;
  conflictPaths: number;
  // The paths that conflicted against main (#6531): a conflict only in a
  // mechanical file is settled without a resolution.
  conflictFiles: string[];
  integrationMain: string | null;
  // A settled verdict stands on the pinned head; a run for it is under way.
  settled: boolean;
  runInFlight: boolean;
  // Something only a person can change: a locked app with no admin Yes,
  // checks that failed on the pinned head.
  unmergeable: string | null;
  // What the proposal machine holds: its state, a gate, an attempt or a sync
  // under way, GitHub's last refusal, what the AI could not resolve, the
  // back-off after a broken sync.
  state: string;
  busy: boolean;
  // GitHub's last refusal of this head. `retryAt` is when the queue may try
  // it again (a busy answer, or a plain refusal nobody has to act on), or
  // null for one that stays held until the head or main moves.
  refused: { head: string | null; main: string | null; kind: string; retryAt: string | null } | null;
  gaveUp: { head: string | null; main: string | null } | null;
  backoffUntil: number;
  // Rule C's one resolution before the vote: spent on this epoch already.
  resolutionSpent: boolean;
  forkHead: boolean;
  laneReasons: string[];
}

export interface Facts {
  line: Candidate[];
  // Check: the instances of the proposals the queue waits on.
  waiting: Map<number, { state: string; data: any }>;
}

export const NO_FACTS: Facts = { line: [], waiting: new Map() };

const PLATFORM_BRANCHES = ['usernode/from-', 'usernode/patch-'];
function repoName(v: unknown): string | null {
  const m = /^([a-z0-9._-]+)\/([a-z0-9._-]+?)(?:\.git)?$/.exec(String(v ?? '').trim().toLowerCase());
  return m ? `${m[1]}/${m[2]}` : null;
}
function forkOf(r: any): boolean {
  if (r.source !== 'imported') return false;
  const head = repoName(r.imported_pr_head_repo);
  const parsed = parseRepoAddress(r.repo_url);
  const app = parsed ? repoName(`${parsed.owner}/${parsed.repo}`) : null;
  if (head && app) return head !== app;
  return !PLATFORM_BRANCHES.some((p) => String(r.branch_name ?? '').startsWith(p));
}

// The whole line, never a first page: which proposals the queue may merge
// is decided after the read (the vote gate, a force), so a cut-off before it
// left an approved proposal behind 200 older ones out of reach for good.
// What bounds it is the promoted caps.
const LINE_SQL = `
  SELECT cs.id, cs.user_id, cs.source, cs.promoted_at, cs.created_at, cs.branch_name, cs.imported_pr_head_repo,
         cs.requires_explicit_approval, cs.explicit_approval_reason, cs.approval_epoch, cs.integration_resolved_epoch,
         cs.integration_merges_clean, cs.integration_conflict_paths, cs.integration_main_sha, cs.integration_block_reasons,
         cs.check_state, cs.check_phase, cs.checks_commit_sha,
         CASE WHEN cs.source = 'imported' THEN cs.imported_pr_head_sha ELSE cs.reviewed_head_sha END AS head,
         a.locked, a.repo_url,
         EXISTS (SELECT 1 FROM pr_votes pv JOIN users u ON u.id = pv.user_id
                  WHERE pv.session_id = cs.id AND pv.vote = 'yes' AND pv.approval_epoch = cs.approval_epoch
                    AND u.is_admin = TRUE AND u.admin_readonly = FALSE) AS admin_yes,
         (SELECT COUNT(*)::int FROM pr_votes pv
           WHERE pv.session_id = cs.id AND pv.vote = 'yes' AND pv.approval_epoch = cs.approval_epoch
             AND counts_toward_session_outcome(pv.user_id, pv.session_id)) AS yes_count,
         w.state AS wf_state, w.data AS wf_data
    FROM chat_sessions cs
    JOIN apps a ON a.id = cs.app_id
    LEFT JOIN wf_instances w ON w.machine = 'proposal' AND w.key = 'session:' || cs.id
   WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.is_headless = FALSE
     AND cs.imported_pr_base_ref IS NULL
   ORDER BY cs.id`;

export async function readLine(tx: Tx, appId: number, now: Date): Promise<Candidate[]> {
  const { rows } = await tx.query(LINE_SQL, [appId]);
  const out: Candidate[] = [];
  for (const r of rows) {
    const d = r.wf_data || {};
    const gate = await readPrGate(tx, {
      sessionId: r.id, appId, openedAt: r.promoted_at || r.created_at,
      explicitApproval: !!r.requires_explicit_approval, explicitReason: r.explicit_approval_reason ?? null,
      authorId: r.user_id ?? null, now,
    });
    const head = sha(r.head);
    const checksSha = sha(r.checks_commit_sha);
    const onHead = !head || checksSha === head;
    const settled = (r.check_state === 'passing' || r.check_state === 'skipped') && onHead;
    const integrationMain = sha(r.integration_main_sha);
    const githubConflict = d.refused?.kind === 'conflict' && !!head && sha(d.refused.head) === head
      && (!d.refused.main || !integrationMain || sha(d.refused.main) === integrationMain);
    const unmergeable = r.locked === true && r.admin_yes === false ? 'lock'
      : (r.check_state === 'failing' || r.check_state === 'error') && onHead && !!checksSha ? `checks_${r.check_state}` : null;
    out.push({
      id: Number(r.id), head, epoch: Number(r.approval_epoch) || 0,
      approved: !!gate?.mergeable, forced: !!d.force, forcedHead: sha(d.force?.head), yes: Number(r.yes_count) || 0,
      waitedSince: ms(r.promoted_at || r.created_at),
      mergesClean: githubConflict ? false : r.integration_merges_clean == null ? null : !!r.integration_merges_clean,
      githubConflict,
      conflictPaths: Array.isArray(r.integration_conflict_paths) ? r.integration_conflict_paths.length : 0,
      conflictFiles: Array.isArray(r.integration_conflict_paths) ? r.integration_conflict_paths.map(String) : [],
      integrationMain,
      settled,
      runInFlight: r.check_state === 'pending' && r.check_phase !== 'deferred' && onHead && !!checksSha,
      unmergeable,
      state: r.wf_state || 'in_review',
      busy: !!d.attempt || !!d.sync,
      refused: d.refused ? {
        head: d.refused.head ?? null, main: d.refused.main ?? null, kind: d.refused.kind,
        retryAt: d.refused.retryAt ?? null,
      } : null,
      gaveUp: d.gaveUp || null,
      backoffUntil: d.backoff?.until ? ms(d.backoff.until) : 0,
      resolutionSpent: r.integration_resolved_epoch != null && Number(r.integration_resolved_epoch) === (Number(r.approval_epoch) || 0),
      forkHead: forkOf(r),
      laneReasons: Array.isArray(r.integration_block_reasons) ? r.integration_block_reasons.map(String) : [],
    });
  }
  return out;
}

async function readWaiting(tx: Tx, ids: number[]): Promise<Map<number, { state: string; data: any }>> {
  const out = new Map<number, { state: string; data: any }>();
  if (!ids.length) return out;
  const { rows } = await tx.query(
    `SELECT key, state, data FROM wf_instances WHERE machine = 'proposal' AND key = ANY($1::text[])`,
    [ids.map((id) => `session:${id}`)]);
  for (const r of rows) out.set(Number(String(r.key).slice('session:'.length)), { state: r.state, data: r.data || {} });
  return out;
}

export async function readFacts(tx: Tx, appId: number, eventType: string, waitingOn: number[], now: Date): Promise<Facts> {
  if (eventType === 'Check') return { line: [], waiting: await readWaiting(tx, waitingOn) };
  return { line: await readLine(tx, appId, now), waiting: new Map() };
}
