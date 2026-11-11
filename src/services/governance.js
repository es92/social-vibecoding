'use strict';

// Per-app proposal-approval governance (issue #646) — the one shared
// layer between the two dapp.json-declared settings
// (apps.approver_policy / apps.approvals_required, reconciled by
// services/app-manifest.js reconcileAppGovernance) and every
// merge-gate consumer (evaluateMergeGate, the /promoted + /me/proposals
// serializers, the proposal machine's review check, the merge queue, and
// the governance-issue apply paths in routes/issues.js).
//
// Three regimes, combined from the two settings:
//
//   1. approver_policy='anyone' + approvals_required=NULL (the
//      defaults): bit-for-bit today's behavior — the dynamic
//      time-&-majority gate (services/active-users.js mergeGate) over
//      the active-user electorate, counting every vote.
//
//   2. approver_policy='invited' + approvals_required=NULL: the same
//      mergeGate math with the electorate swapped — `active` becomes
//      the number of approver members (app_approvers status='member',
//      floored at 1) and only THEIR votes feed the yes/no counts.
//      Everyone else's votes are recorded and displayed but advisory.
//
//   3. approvals_required=N ("at least N", either policy): a proposal
//      is mergeable as soon as it has N qualifying yes votes. No
//      visibility window, no lazy-consensus clock, no contested state,
//      and no auto-rejection — the countdown machinery is off in this
//      mode. Qualifying = approver votes when the policy is 'invited',
//      all votes when 'anyone'.
//
// The checks gate, behind-main gate, and locked-app admin-yes gate are
// mode-independent and enforced by evaluateMergeGate as before. Vote WRITE
// eligibility (app-access collab guards) is deliberately unchanged —
// approver-ness only changes which votes COUNT.
//
// 4. #4666, WHO SAYS YES: a project whose dapp.json names a `preset` or
//    `rules` (services/governance-rules.js) is decided by those rules
//    instead of the two columns: the creator's yes, a count from a group,
//    a share of a group, or the time-&-majority vote over a group, any
//    one passing. Stored in apps.governance_rules; NULL keeps regimes 1-3
//    exactly as they were, for every project that never chose. The facts
//    a rule needs that a count cannot give (who voted, who made the
//    project, who is in a group) are read by governedGate, and handed to
//    computeGate by the serializers that batch them (rulesContext).
//
// Deadlock escape: when the policy is 'invited' but the app has zero
// approver members (e.g. the self-app before any invite is accepted,
// or every approver left), full admins (is_admin AND NOT
// admin_readonly — the same predicate as the locked-app gate in
// services/admin-approval.js) act as the approver set, so an app can
// never make its own merge gate unreachable.

const log = require('./logger');
const { countedVotePredicateSql } = require('./pr-vote-revision');
// The gate's rule and the electorate are the workflow's
// (src/workflow/rules/), one copy for this module and the governance
// machine, which decides with them inside its transaction.
const gateRules = require('../workflow/rules/governance-gate.ts');
const electorateRules = require('../workflow/rules/electorate.ts');
const governanceRules = require('./governance-rules');
// 13 Oct 2026, D1: whether a change is its project's first version, which
// goes live without a vote (the gate's own rule is governance-gate.ts
// applyFirstVersion).
const { firstVersionSql, isFirstVersion } = require('./first-version-rule');
// #5803: an admin's lone No starts the week-long takedown. The SQL lives with
// the proposal gate so the deciding read and the display reads arm the same
// clock.
const { adminNoAtSql, approverNoAtSql } = require('../workflow/rules/pr-gate.ts');

// Lazy accessor rather than a top-level destructure: tests stub
// services/active-users via require.cache, and this module may be
// loaded before the stub lands — resolve at call time so both bind.
function activeUsers() {
  // eslint-disable-next-line global-require
  return require('./active-users');
}

// Short in-process TTL cache for the governance columns, mirroring the
// visibility caches in services/app-access.js: reads happen on every
// vote/serialize, changes are rare and always call invalidateGovernance.
const GOV_CACHE_TTL_MS = 10 * 1000;
const govCache = new Map(); // appId -> { at, value: { approverPolicy, approvalsRequired, rules } }
// The app facts a rules project's gate reads (rulesFacts), on the same TTL.
const factsCache = new Map(); // appId -> { at, value }

function invalidateGovernanceHere(appId) {
  if (appId == null) {
    govCache.clear();
    factsCache.clear();
    return;
  }
  govCache.delete(appId);
  factsCache.delete(appId);
}

// Here and in every other process (access-change.js).
function invalidateGovernance(appId) {
  invalidateGovernanceHere(appId);
  require('./access-change').shareAccessChange(appId);
}

async function getGovernance(pool, appId) {
  const hit = govCache.get(appId);
  if (hit && Date.now() - hit.at < GOV_CACHE_TTL_MS) return hit.value;
  const value = await readGovernance(pool, appId);
  govCache.set(appId, { at: Date.now(), value });
  return value;
}

// The same read without the cache, for a decision taken under a lock (the
// workflow governance machine's gate): a cached value is only as fresh as
// its TTL, and a settings change must not be missed by the vote it races.
async function readGovernance(pool, appId) {
  const { rows } = await pool.query(
    'SELECT approver_policy, approvals_required FROM apps WHERE id = $1',
    [appId]
  );
  const gov = governanceFromRow(rows[0]);
  gov.rules = await readRules(pool, appId);
  return gov;
}

// #4666: the rules a project chose (apps.governance_rules), or null. Its own
// statement, so the two-column read above is the one every caller and test
// has always seen. A failed read is the columns' rule, which is never more
// permissive than a rule a project chose: the creator's yes and the counted
// rules only ever ADD ways in.
async function readRules(pool, appId) {
  try {
    const { rows } = await pool.query(
      'SELECT governance_rules FROM apps WHERE id = $1',
      [appId]
    );
    return rulesFromColumn(rows[0]?.governance_rules);
  } catch (err) {
    log.warn('governance', 'Could not read the approval rules; using the columns', { appId, err: err.message });
    return null;
  }
}

// The governance columns of an apps row (and its rules, when the row
// carries governance_rules), and apps.governance_rules as the gate reads it.
const { governanceFromRow, rulesFromColumn } = gateRules;

// The approver electorate for an 'invited'-policy app: member rows in
// app_approvers, or (when the roster is empty) the full-admin fallback
// described in the header. Returns { ids, adminFallback }.
const { getApproverSet } = electorateRules;

// Whether a user's vote QUALIFIES (counts toward the gate) on this
// app. Under 'anyone' every vote qualifies; under 'invited' only the
// approver set's (incl. the admin fallback). Used by the vote-roster
// serializer to tag approver votes.
async function isApprover(pool, appId, userId) {
  if (!userId) return false;
  const gov = await getGovernance(pool, appId);
  if (gov.approverPolicy !== 'invited' || gov.rules) return false;
  const { ids } = await getApproverSet(pool, appId);
  return ids.includes(userId);
}

// The pure gate (src/workflow/rules/governance-gate.ts explains each
// part): "at least N" (atLeastGate), the #788 no-timer modifier
// (applyNoTimerMerge), the member floor (memberFloor) and the mode dispatch
// (computeGate). The default mode's curves are reached through
// services/active-users.js, as they always were, so a test that stubs that
// module still reaches the gate it stubbed.
const { applyNoTimerMerge, memberFloor } = gateRules;

function atLeastGate(n, yesCount, noCount = 0, openedAt = null, now = Date.now(), opts = {}) {
  return gateRules.atLeastGate(n, yesCount, noCount, openedAt, now, opts, activeUsers().oppositionWindowMs);
}

function computeGate(gov, active, yesCount, noCount, openedAt, now, opts = {}) {
  const au = activeUsers();
  return gateRules.computeGate(gov, active, yesCount, noCount, openedAt, now, opts,
    { mergeGate: au.mergeGate, oppositionWindowMs: au.oppositionWindowMs });
}

// #4666: whether a flagged proposal is a change to who decides, and the
// gate for a project with rules of its own (computeGate dispatches to it):
// src/workflow/rules/governance-gate.ts.
const { isWhoDecidesReason } = gateRules;

// Qualifying yes/no counts for ONE proposal. `kind` picks the vote
// table: 'pr' → pr_votes (yes/no keyed by session_id), 'issue' →
// issue_votes (up/down keyed by issue_id). `approverIds` = null counts
// every vote (policy 'anyone'); an array restricts to those users.
//
// #687 Slice 3 scoped these counts to the exact PR head commit a vote was
// cast against, so that a head change re-opened approval. #2038 keeps the
// intent and changes the key: the scope is chat_sessions.approval_epoch now,
// which the platform bumps only when somebody writes bytes that were not
// already approved. A "sync with main" therefore stops re-opening approval,
// because it changes the commit without changing the work — see
// services/pr-vote-revision.js for why a commit could never answer that on
// its own. Issue votes are unscoped: they have no revision to go stale.
//
// `opts.authorId` asks for one more number, `otherYes`: the qualifying Yes
// votes cast by someone other than the proposal's author (the member floor;
// see applyNoTimerMerge). Only asked for a flagged proposal, so the common
// path keeps its exact queries. A null author (a deleted account) counts
// every Yes as someone else's.
async function qualifiedCounts(pool, kind, id, approverIds, opts) {
  const wantOther = !!opts && typeof opts === 'object'
    && Object.prototype.hasOwnProperty.call(opts, 'authorId');
  const authorNum = wantOther ? parseInt(opts.authorId, 10) : NaN;
  const authorId = Number.isFinite(authorNum) ? authorNum : null;
  const table = kind === 'issue' ? 'issue_votes' : 'pr_votes';
  const keyCol = kind === 'issue' ? 'issue_id' : 'session_id';
  const yesVal = kind === 'issue' ? 'up' : 'yes';
  const noVal = kind === 'issue' ? 'down' : 'no';
  // #2038: approvals are scoped by EPOCH now, not by head sha. The epoch
  // lives on the session row, so the clause is a scalar subquery rather than
  // a bound parameter — which also means it needs no argument juggling as
  // the placeholder numbers shift between the two branches below.
  // PR-only: issue_votes has no epoch, and an issue vote has no revision to
  // go stale against.
  const scoped = kind !== 'issue';
  // Test accounts (D1): a test account's vote on an app a real person made
  // is recorded but not counted — the same rule as countedVotePredicateSql,
  // keyed by the proposal's id because that is all this holds.
  const epochClause = (scoped
    ? ` AND approval_epoch = (SELECT approval_epoch FROM chat_sessions WHERE id = ${'$'}1)`
    : '')
    + (scoped
      ? ` AND counts_toward_session_outcome(user_id, ${'$'}1)`
      : ` AND counts_toward_issue_outcome(user_id, ${'$'}1)`);
  if (approverIds == null) {
    // Unrestricted electorate: the exact two COUNT queries the merge
    // paths always issued (cheaper than a FILTER scan, and existing
    // callers/tests recognize the shape).
    const { rows: yesRows } = await pool.query(
      `SELECT COUNT(*) as cnt FROM ${table} WHERE ${keyCol} = $1 AND vote = '${yesVal}'${epochClause}`,
      [id]
    );
    const { rows: noRows } = await pool.query(
      `SELECT COUNT(*) as cnt FROM ${table} WHERE ${keyCol} = $1 AND vote = '${noVal}'${epochClause}`,
      [id]
    );
    const out = {
      yes: parseInt(yesRows[0]?.cnt, 10) || 0,
      no: parseInt(noRows[0]?.cnt, 10) || 0,
    };
    if (wantOther) {
      const { rows: otherRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM ${table}
          WHERE ${keyCol} = $1 AND vote = '${yesVal}'
            AND user_id IS DISTINCT FROM $2::int${epochClause}`,
        [id, authorId]
      );
      out.otherYes = parseInt(otherRows[0]?.cnt, 10) || 0;
    }
    return out;
  }
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE vote = '${yesVal}') AS yes,
       COUNT(*) FILTER (WHERE vote = '${noVal}') AS no${wantOther
    ? `,
       COUNT(*) FILTER (WHERE vote = '${yesVal}' AND user_id IS DISTINCT FROM $3::int) AS other_yes`
    : ''}
     FROM ${table}
     WHERE ${keyCol} = $1
       AND user_id = ANY($2::int[])${epochClause}`,
    wantOther ? [id, approverIds, authorId] : [id, approverIds]
  );
  const out = {
    yes: parseInt(rows[0]?.yes, 10) || 0,
    no: parseInt(rows[0]?.no, 10) || 0,
  };
  if (wantOther) out.otherYes = parseInt(rows[0]?.other_yes, 10) || 0;
  return out;
}

// Batch variant for serializers: qualifying counts for MANY proposals
// in one query. Only called with a restricted electorate (callers use
// the raw per-row tallies under 'anyone'). Returns a Map of
// id -> { yes, no, otherYes } (missing ids have zero votes from the
// electorate). `otherYes` is the member floor's count: qualifying Yes
// votes from someone other than the row's author (chat_sessions.user_id
// for a PR, issues.created_by for an issue).
async function qualifiedCountsBatch(pool, kind, ids, approverIds) {
  const out = new Map();
  if (!ids.length) return out;
  const yesVal = kind === 'issue' ? 'up' : 'yes';
  const noVal = kind === 'issue' ? 'down' : 'no';
  const sql = kind === 'issue'
    ? `SELECT iv.issue_id AS id,
         COUNT(*) FILTER (WHERE iv.vote = '${yesVal}') AS yes,
         COUNT(*) FILTER (WHERE iv.vote = '${noVal}') AS no,
         COUNT(*) FILTER (WHERE iv.vote = '${yesVal}'
                            AND iv.user_id IS DISTINCT FROM i.created_by) AS other_yes
       FROM issue_votes iv
       JOIN issues i ON i.id = iv.issue_id
       WHERE iv.issue_id = ANY($1::int[])
         AND iv.user_id = ANY($2::int[])
         AND counts_toward_issue_outcome(iv.user_id, iv.issue_id)
       GROUP BY iv.issue_id`
    : `SELECT pv.session_id AS id,
         COUNT(*) FILTER (WHERE pv.vote = '${yesVal}') AS yes,
         COUNT(*) FILTER (WHERE pv.vote = '${noVal}') AS no,
         COUNT(*) FILTER (WHERE pv.vote = '${yesVal}'
                            AND pv.user_id IS DISTINCT FROM cs.user_id) AS other_yes
       FROM pr_votes pv
       JOIN chat_sessions cs ON cs.id = pv.session_id
       WHERE pv.session_id = ANY($1::int[])
         AND pv.user_id = ANY($2::int[])
         AND ${countedVotePredicateSql('pv', 'cs')}
       GROUP BY pv.session_id`;
  const { rows } = await pool.query(sql, [ids, approverIds]);
  for (const r of rows) {
    out.set(r.id, {
      yes: parseInt(r.yes, 10) || 0,
      no: parseInt(r.no, 10) || 0,
      otherYes: parseInt(r.other_yes, 10) || 0,
    });
  }
  return out;
}

// The member floor's two reads (applyNoTimerMerge), for the paths that
// decide something.
//
// How many people are in the community the app belongs to. A missing app
// answers null (floor not evaluated); an app with no community yet answers
// 0, which is a one-person community as far as the floor is concerned.
async function communityMemberCount(pool, appId) {
  const { rows } = await pool.query(
    `SELECT COUNT(m.user_id)::int AS n
       FROM apps a
       LEFT JOIN community_members m ON m.community_id = a.community_id
      WHERE a.id = $1
      GROUP BY a.id`,
    [appId]
  );
  return rows.length ? (parseInt(rows[0].n, 10) || 0) : null;
}

// Who proposed it: chat_sessions.user_id for a PR, issues.created_by for an
// issue. Null for a deleted account, which the floor reads as "every Yes is
// someone else's".
async function proposalAuthorId(pool, kind, id) {
  const { rows } = kind === 'issue'
    ? await pool.query('SELECT created_by AS author_id FROM issues WHERE id = $1', [id])
    : await pool.query('SELECT user_id AS author_id FROM chat_sessions WHERE id = $1', [id]);
  const n = parseInt(rows[0]?.author_id, 10);
  return Number.isFinite(n) ? n : null;
}

// Electorate resolution: who counts, and how many of them there are
// (src/workflow/rules/electorate.ts). Exposed for serializers that
// batch-count many rows. `appMeta` ({ selfHosted, collabPrivate }) is passed
// on to getActiveUserStats by a caller that has already read the app row.
async function getElectorate(pool, appId, gov, appMeta = null) {
  return electorateRules.electorate(pool, appId, gov, appMeta,
    (db, id, meta) => activeUsers().getActiveUserStats(db, id, meta));
}

// #4747: whether this viewer's vote can affect a proposal's outcome under
// the project's governance — the deciding set the gate itself reads, as
// opposed to counts_toward_outcome's identity/app-access question. True for
// a signed-out viewer (they see no vote controls and are not flagged) and
// for every project without approvers or rules. A rules project reads the
// same value the gate does (WHO_DECIDES for a flagged change to who
// decides), and a viewer inside ANY rule's group decides: the gate passes
// when any rule passes. Display only; nothing here changes who counts.
function viewerDecides(gov, { approverIds, facts, explicitApproval, explicitReason }, viewerId) {
  if (viewerId == null) return true;
  const id = parseInt(viewerId, 10);
  if (!Number.isFinite(id)) return true;
  if (gov && gov.rules) {
    const value = explicitApproval && isWhoDecidesReason(explicitReason ?? null)
      ? { rules: governanceRules.WHO_DECIDES }
      : gov.rules;
    return value.rules.some((rule) => {
      if (rule.group === 'members') return true;
      if (rule.group === 'creator') return facts ? facts.creatorId === id : false;
      if (rule.group === 'admins') return !!facts && (facts.adminIds || []).includes(id);
      return !!facts && (facts.groups.get(rule.group) || []).includes(id);
    });
  }
  if (gov && gov.approverPolicy === 'invited') {
    return (approverIds || []).includes(id);
  }
  return true;
}

// ── #4666: what a rules project's gate reads ───────────────────────────

// Who made the project, how many are in its community, its active-member
// electorate, its admins and its named groups' people: the app facts a rule
// can need. Cached like the governance columns, unless `fresh` (a decision
// of a workflow machine's work, which no process's cache may decide). The
// platform's own app has no creator (a rule on `creator` there never passes).
async function rulesFacts(pool, appId, gov, { fresh = false } = {}) {
  const hit = fresh ? null : factsCache.get(appId);
  if (hit && Date.now() - hit.at < GOV_CACHE_TTL_MS) return withGroups(hit.value, gov);
  const { rows } = await pool.query(
    `SELECT a.created_by, a.self_hosted, a.collab_visibility,
            (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id) AS member_count,
            COALESCE((SELECT array_agg(ad.user_id) FROM app_admins ad WHERE ad.app_id = a.id), '{}') AS admin_ids
       FROM apps a WHERE a.id = $1`,
    [appId]
  );
  const r = rows[0] || {};
  const { active } = await activeUsers().getActiveUserStats(pool, appId, activeUsers().appMetaFromRow(r));
  const value = {
    creatorId: !r.self_hosted && r.created_by ? parseInt(r.created_by, 10) : null,
    memberCount: parseInt(r.member_count, 10) || 0,
    membersActive: Math.max(parseInt(active, 10) || 0, 1),
    adminIds: (r.admin_ids || []).map((id) => parseInt(id, 10)).filter(Number.isFinite),
    activeIds: null,
  };
  // The active people are a heavier read, wanted only by a share-of-active
  // rule on a group smaller than the whole community.
  const wantsActive = !!(gov && gov.rules && gov.rules.rules.some((x) => x.kind === 'percentOfActive' && x.group !== 'members'));
  if (wantsActive) {
    const ids = await activeUsers().listActiveUserIds(pool, appId);
    value.activeIds = new Set(ids.map((id) => parseInt(id, 10)));
  }
  factsCache.set(appId, { at: Date.now(), value });
  return withGroups(value, gov);
}

function withGroups(value, gov) {
  const groups = new Map();
  for (const g of (gov && gov.rules && gov.rules.groups) || []) groups.set(g.key, g.ids || []);
  return { ...value, groups };
}

// The counted votes on one proposal, by voter: the same votes qualifiedCounts
// counts under an unrestricted electorate (the approval epoch, test accounts).
async function voterSets(pool, kind, id) {
  if (kind === 'issue') {
    const { rows } = await pool.query(
      `SELECT user_id, vote FROM issue_votes
        WHERE issue_id = $1 AND vote IN ('up', 'down')
          AND counts_toward_issue_outcome(user_id, $1)`,
      [id]
    );
    return votersFromRows(rows, true);
  }
  const { rows } = await pool.query(
    `SELECT user_id, vote FROM pr_votes
      WHERE session_id = $1 AND vote IN ('yes', 'no')
        AND approval_epoch = (SELECT approval_epoch FROM chat_sessions WHERE id = $1)
        AND counts_toward_session_outcome(user_id, $1)`,
    [id]
  );
  return votersFromRows(rows, false);
}

function votersFromRows(rows, issue) {
  const yesVal = issue ? 'up' : 'yes';
  const yes = new Set();
  const no = new Set();
  for (const r of rows) {
    const uid = parseInt(r.user_id, 10);
    if (!Number.isFinite(uid)) continue;
    if (r.vote === yesVal) yes.add(uid); else no.add(uid);
  }
  return { yes, no };
}

// The same for many proposals in one query: Map of id -> { yes, no } (a
// proposal nobody has voted on is missing; voterSetsFor answers it empty).
async function voterSetsBatch(pool, kind, ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  const issue = kind === 'issue';
  const sql = issue
    ? `SELECT iv.issue_id AS id, iv.user_id, iv.vote FROM issue_votes iv
        WHERE iv.issue_id = ANY($1::int[]) AND iv.vote IN ('up', 'down')
          AND counts_toward_issue_outcome(iv.user_id, iv.issue_id)`
    : `SELECT pv.session_id AS id, pv.user_id, pv.vote FROM pr_votes pv
         JOIN chat_sessions cs ON cs.id = pv.session_id
        WHERE pv.session_id = ANY($1::int[]) AND pv.vote IN ('yes', 'no')
          AND ${countedVotePredicateSql('pv', 'cs')}`;
  const { rows } = await pool.query(sql, [ids]);
  const byId = new Map();
  for (const r of rows) {
    const k = parseInt(r.id, 10);
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(r);
  }
  for (const [k, list] of byId) out.set(k, votersFromRows(list, issue));
  return out;
}

/**
 * For a serializer that batch-counts many proposals on ONE app: what
 * computeGate needs to answer a rules project's gate, read once. Null for a
 * project without rules, so the common path issues no extra query. Use with
 * rulesGateOpts(ctx, id, authorId, reason).
 */
async function rulesContext(pool, appId, gov, kind, ids) {
  if (!gov || !gov.rules) return null;
  const [facts, voters] = await Promise.all([
    rulesFacts(pool, appId, gov),
    voterSetsBatch(pool, kind, ids),
  ]);
  return { facts, voters };
}

/** The computeGate options for one proposal out of a rulesContext. */
function rulesGateOpts(ctx, id, authorId, explicitReason) {
  if (!ctx) return {};
  return {
    rulesFacts: ctx.facts,
    voters: ctx.voters.get(parseInt(id, 10)) || { yes: new Set(), no: new Set() },
    authorId: authorId ?? null,
    memberCount: ctx.facts.memberCount,
    ...(explicitReason !== undefined ? { explicitReason } : {}),
  };
}

// The stored reason a PR was flagged for, when the caller did not say.
async function storedExplicitReason(pool, kind, id) {
  if (kind === 'issue') return 'secrets';
  const { rows } = await pool.query(
    'SELECT explicit_approval_reason FROM chat_sessions WHERE id = $1', [id]
  );
  return rows[0]?.explicit_approval_reason || null;
}

// #5803 / #5947: when one of the project's admins, and one of an invited
// project's approvers, last voted No on these proposals, in their current
// approval epoch. Map<sessionId, { adminNoAt, approverNoAt }> with an entry
// only where either has a counted No: one query for a list, for the card
// reads in routes/votes.js. The deciding gate reads the same values on the
// statement it already issues (workflow/rules/pr-gate.ts GATE_SQL).
async function loneNoTimes(pool, sessionIds) {
  const ids = [...new Set((sessionIds || []).map((id) => parseInt(id, 10)).filter(Number.isFinite))];
  const out = new Map();
  if (!ids.length) return out;
  const { rows } = await pool.query(
    `SELECT cs.id, ${adminNoAtSql('cs')} AS admin_no_at, ${approverNoAtSql('cs')} AS approver_no_at
       FROM chat_sessions cs WHERE cs.id = ANY($1::int[])`,
    [ids],
  );
  for (const r of rows) {
    if (r.admin_no_at == null && r.approver_no_at == null) continue;
    out.set(parseInt(r.id, 10), { adminNoAt: r.admin_no_at ?? null, approverNoAt: r.approver_no_at ?? null });
  }
  return out;
}

// One-call convenience: the governed merge gate for a single proposal.
// `kind` = 'pr' (chat_sessions + pr_votes) | 'issue' (issues +
// issue_votes); `id` is the session/issue id; `openedAt` the clock
// anchor (promoted_at || created_at for PRs, created_at for issues).
// Returns the mergeGate-shaped object from computeGate above, extended
// with { policy, mode, approvalsRequired, qualifiedYes, qualifiedNo,
// activeCount, memberFloor }.
//
// A flagged proposal (`explicitApproval`) always has its member floor
// evaluated here: `authorId` when the caller has the row (pass null for a
// deleted author), else it is read off the row. This is the path every
// merge and apply decision takes, so the floor can never be skipped by a
// caller that forgot to ask for it.
//
// The same goes for a project's first version (13 Oct 2026, D1): a change
// is read for it here unless the caller says (`firstVersion`), and the gate
// waives its vote (governance-gate.ts applyFirstVersion). An issue never is
// one.
async function governedGate(pool, appId, {
  kind = 'pr', id, openedAt, now, explicitApproval = false, authorId, explicitReason, firstVersion, fresh = false,
} = {}) {
  // `fresh`: read uncached, as a workflow machine's work must (a process's
  // 10-second copy is lost on a restart and differs between processes).
  const gov = fresh ? await readGovernance(pool, appId) : await getGovernance(pool, appId);
  const first = firstVersion !== undefined
    ? !!firstVersion
    : (kind === 'pr' ? await isFirstVersion(pool, id) : false);
  if (gov.rules) {
    // #4666: a rules project reads who voted and what its groups are, and
    // the author for the member floor (a yes from someone else). Proposing
    // is never the author's yes (governance-rules.ts).
    const [facts, voters, author] = await Promise.all([
      rulesFacts(pool, appId, gov, { fresh }),
      voterSets(pool, kind, id),
      authorId !== undefined ? authorId : proposalAuthorId(pool, kind, id),
    ]);
    const reason = explicitApproval
      ? (explicitReason !== undefined ? explicitReason : await storedExplicitReason(pool, kind, id))
      : null;
    return computeGate(gov, facts.membersActive, voters.yes.size, voters.no.size, openedAt, now, {
      explicitApproval, explicitReason: reason, authorId: author, voters,
      rulesFacts: facts, memberCount: facts.memberCount,
      firstVersion: first,
    });
  }
  const electorate = await getElectorate(pool, appId, gov);
  let floorOpts;
  if (explicitApproval) {
    floorOpts = {
      authorId: authorId !== undefined ? authorId : await proposalAuthorId(pool, kind, id),
    };
  }
  // #2038: scoped by approval epoch inside qualifiedCounts. Callers no
  // longer pass a revision, because the revision was never the right key —
  // a proposal's commit changes for reasons that have nothing to do with
  // whether the approvals still describe it.
  // #5803: an admin's lone No (and #5947 an approver's) is not read here. The deciding gate (the
  // proposal machine's rules/pr-gate.ts) carries it on the statement it
  // already issues, and the cards read it with loneNoTimes below; adding a
  // read to this convenience path would change the queries every existing
  // caller and test pins for no behaviour they use.
  const { yes, no, otherYes } = await qualifiedCounts(
    pool, kind, id, electorate.approverIds, floorOpts
  );
  const memberCount = explicitApproval ? await communityMemberCount(pool, appId) : undefined;
  // #788: the no-timer modifier rides on top of whatever regime the app
  // configured — see applyNoTimerMerge — and with it the member floor.
  const gate = computeGate(gov, electorate.active, yes, no, openedAt, now, {
    explicitApproval, otherYes, memberCount, firstVersion: first,
  });
  if (electorate.adminFallback && gov.approverPolicy === 'invited') {
    log.debug('governance', 'Approver roster empty; full admins acting as approvers', { appId });
  }
  return gate;
}

// The fields a display serializer hangs on a proposal row for the member
// floor, from the gate computeGate returned for it (with `otherYes` and
// `memberCount` passed in). `needs_other_member_yes` is true only when the
// row is flagged AND its community has more than one member; the card's
// requirement row (services/merge-requirements.js) and the status pill
// read these rather than re-deriving the rule.
function explicitApprovalRowFields(row, gate) {
  const flagged = !!(row && row.requires_explicit_approval);
  const floor = flagged && gate ? gate.memberFloor : null;
  return {
    requires_explicit_approval: flagged,
    explicit_approval_reason: flagged ? (row.explicit_approval_reason || null) : null,
    needs_other_member_yes: !!(floor && floor.applies),
    other_member_yes_count: floor ? floor.otherYes : null,
  };
}

// #4666: the rule as the project's page says it (GET /api/apps/:slug/community
// `approval`): which preset it is, each rule with how many people its group
// has and what an unopposed change needs from it today, and the named
// groups. A project on the old two columns reads as Group vote when it has
// the default rule, and as its own (`preset` null) otherwise.
async function describeApproval(pool, appId, gov) {
  if (!gov.rules) {
    return {
      mode: 'columns',
      preset: gov.approverPolicy === 'anyone' && gov.approvalsRequired == null ? 'group_vote' : null,
      rules: null,
      groups: [],
      creatorId: null,
    };
  }
  const facts = await rulesFacts(pool, appId, gov);
  const gate = computeGate(gov, facts.membersActive, 0, 0, null, null, {
    rulesFacts: facts, voters: { yes: new Set(), no: new Set() }, authorId: null, memberCount: facts.memberCount,
  });
  return {
    mode: 'rules',
    preset: gate.preset,
    rules: gate.rules.map((r) => ({
      group: r.group, kind: r.kind, n: r.n, size: r.size, need: r.need, empty: r.empty,
      ...(r.min != null ? { min: r.min } : {}),
    })),
    groups: gov.rules.groups.map((g) => ({ name: g.name, key: g.key, people: g.people })),
    creatorId: facts.creatorId,
    required: gate.required,
  };
}

// #4666: what a serialized proposal row says about a rules project's gate,
// beside the fields every row carries. Nothing for a project without rules,
// so those payloads are exactly what they were.
function ruleRowFields(gate) {
  if (!gate || gate.mode !== 'rules') return {};
  return {
    approval_mode: 'rules',
    approval_preset: gate.preset || null,
    approval_who_decides: !!gate.whoDecides,
    approval_passed_by: gate.passedBy ? gate.passedBy.group : null,
    creator_yes: !!gate.creatorYes,
    // #3800: the rule the Votes card counts for (AppView._changeVoteFacts).
    approval_rule: gate.shownRule || null,
  };
}

// #3234: the electorate count to stamp on a proposal as it is promoted —
// the same number computeGate is handed. Display only, so a failed read
// answers null (no note) rather than holding up the promote.
async function electorateAtPromote(pool, appId) {
  try {
    const gov = await getGovernance(pool, appId);
    const { active } = await getElectorate(pool, appId, gov);
    return Math.max(parseInt(active, 10) || 0, 1);
  } catch (err) {
    log.warn('governance', 'Could not read the electorate at promote', { appId, err: err.message });
    return null;
  }
}

// #3234: the Yes votes this proposal would need had the electorate stayed
// what it was when voting opened, with today's No votes — so the only
// difference from the live threshold is who joined or left. Null when the
// row has no stamp, or under "at least N" (a fixed count that cannot move).
function requiredAtPromote(gov, activeAtPromote, noCount) {
  if (!gov || gov.approvalsRequired != null) return null;
  // A rules project's threshold moves with the electorate only on a members
  // majority rule; the counted rules cannot.
  if (gov.rules && !gov.rules.rules.some((r) => r.group === 'members' && r.kind === 'majority')) return null;
  // A minimum is capped at the group's size then, which no stamp records, so
  // there is no threshold to show beside today's.
  if (gov.rules && gov.rules.rules.some((r) => r.group === 'members' && r.kind === 'majority' && r.min != null)) return null;
  const a = parseInt(activeAtPromote, 10);
  if (!Number.isFinite(a) || a < 1) return null;
  return activeUsers().requiredVotes(a, noCount);
}

module.exports = {
  rulesFacts,
  voterSets,
  voterSetsBatch,
  rulesContext,
  rulesGateOpts,
  firstVersionSql,
  isFirstVersion,
  applyFirstVersion: gateRules.applyFirstVersion,
  rulesFromColumn,
  isWhoDecidesReason,
  electorateAtPromote,
  requiredAtPromote,
  getGovernance,
  readGovernance,
  governanceFromRow,
  invalidateGovernance,
  invalidateGovernanceHere,
  getApproverSet,
  isApprover,
  atLeastGate,
  applyNoTimerMerge,
  memberFloor,
  computeGate,
  qualifiedCounts,
  qualifiedCountsBatch,
  communityMemberCount,
  proposalAuthorId,
  explicitApprovalRowFields,
  ruleRowFields,
  describeApproval,
  getElectorate,
  viewerDecides,
  governedGate,
  loneNoTimes,
};
