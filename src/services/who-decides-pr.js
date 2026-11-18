'use strict';

/**
 * #4666: WHO CAN SEE & CHANGE IT, proposed as one change.
 *
 * The sheet of that name (frontend/src/features/dialogs/who-decides.tsx)
 * puts who can see a project and how its changes are approved in one place,
 * and whatever is changed there goes up as ONE pull request on dapp.json:
 * the `visibility` block, the `governance` block, or both. Same lifecycle as
 * a visibility or a governance change (services/rename-pr.js
 * createManifestPR): the PR drops into the vote panel, and when it merges
 * the production rebuild's reconciles apply it.
 *
 *   visibility   'private' (a private community: members see and build it)
 *                or 'public' (a public community: anyone can see and join
 *                it, and everyone who can see it can suggest changes).
 *                "Public, invite-only building" is not offered any more; a
 *                project that has it keeps it until it proposes one of the
 *                two, and its sheet says what it has.
 *   governance   `{ preset }` or `{ groups, rules }`
 *                (services/governance-rules.js), written as dapp.json's
 *                `governance` block, which replaces the old two keys.
 *
 * A change to who decides is always flagged for explicit approval, so it is
 * decided by the creator's yes or the group's real votes, never on a quiet
 * wait (services/governance.js computeRulesGate; on a project still on the
 * old two columns, the #788 modifier as before).
 *
 * The route (POST /api/apps/:slug/who-decides-pr) owns the gates. This
 * module owns reading the body (pure: parseChange, describeChange) and the
 * edit.
 */

const governance = require('./governance');
const governanceRules = require('./governance-rules');
const renamePr = require('./rename-pr');
const appManifest = require('./app-manifest');

const VISIBILITIES = Object.freeze(['private', 'public']);

class WhoDecidesError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'WhoDecidesError';
    this.status = status;
    this.extra = extra;
  }
}

/**
 * The body as a change: `{ visibility: 'private'|'public'|null,
 * governance: rules value | null }`, or throw WhoDecidesError. Neither is
 * a 400: there is nothing to propose.
 */
function parseChange(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  let visibility = null;
  if (b.visibility != null) {
    if (!VISIBILITIES.includes(b.visibility)) throw new WhoDecidesError('visibility must be "private" or "public"');
    visibility = b.visibility;
  }
  let governance = null;
  if (b.governance != null) {
    try {
      governance = governanceRules.parseRulesBlock(b.governance);
    } catch (err) {
      if (err instanceof governanceRules.RulesError) throw new WhoDecidesError(err.message);
      throw err;
    }
    if (!governance) throw new WhoDecidesError('governance needs a preset, or groups and rules');
  }
  if (!visibility && !governance) throw new WhoDecidesError('Choose who can see it, how changes are approved, or both');
  return { visibility, governance };
}

/** The two visibility columns a choice means. */
function columnsFor(visibility) {
  return visibility === 'public'
    ? { collab: 'public', view: 'public' }
    : { collab: 'private', view: 'private' };
}

/**
 * What changes, against the app as it is: `{ visibility, governance }` with
 * each part kept only when it differs. `current` is
 * `{ collab, view, rules }` (the app row's columns and its rules value, null
 * for a project on the old two columns, which no rules value equals).
 */
function diffChange(change, current) {
  const out = { visibility: null, governance: null };
  if (change.visibility) {
    const want = columnsFor(change.visibility);
    if (want.collab !== current.collab || want.view !== current.view) out.visibility = change.visibility;
  }
  if (change.governance) {
    const was = current.rules ? JSON.stringify(governanceRules.blockFor(current.rules)) : null;
    const now = JSON.stringify(governanceRules.blockFor(change.governance));
    if (was !== now) out.governance = change.governance;
  }
  return out;
}

/** The PR's title: what it does, in the sheet's words. */
function describeChange({ visibility, governance }) {
  const vis = visibility === 'public' ? 'a public community' : 'a private community';
  const rule = governance ? governanceRules.describeRules(governance) : null;
  if (visibility && rule) return `Make this ${vis}, approved by ${rule}`;
  if (visibility) return `Make this ${vis}`;
  return `Approve changes by ${rule}`;
}

/**
 * Check that a named group's people are people: each must be a registered
 * user. Resolves `{ ok: true }` or throws WhoDecidesError naming who is not.
 */
async function checkPeople(pool, governance) {
  const names = [...new Set((governance.groups || []).filter((g) => !g.keptByApp).flatMap((g) => g.people.map((p) => p.toLowerCase())))];
  if (!names.length) return;
  const usernames = require('./usernames');
  const found = await usernames.resolveHandles(pool, names);
  const known = new Set(found.map((r) => r.declared));
  const missing = names.filter((n) => !known.has(n));
  if (missing.length) {
    throw new WhoDecidesError(`@${missing[0]} is not on Homeroom`, 400, { missing });
  }
}

/** How many people, in words the proposal's readers count: "12 people today". */
function peopleToday(n) {
  return `${n} ${n === 1 ? 'person' : 'people'} today`;
}

/**
 * "Lifeguards: @evan, @maya.", "Lifeguards: nobody yet.", or a kept group.
 * #6811: a kept group the app has sent a list for says its size, so the
 * people voting on it see how big it is. Counts only.
 */
function groupPeopleLine(group, sizes) {
  if (group.keptByApp) {
    const sent = sizes && sizes.get(governanceRules.groupKey(group.name));
    return sent ? `${group.name}: kept by the app, ${peopleToday(sent.size)}.` : `${group.name}: kept by the app.`;
  }
  return group.people.length
    ? `${group.name}: ${group.people.map((p) => `@${p}`).join(', ')}.`
    : `${group.name}: nobody yet.`;
}

/**
 * The governance part of the PR body: each rule as a sentence, every named
 * group with its people, and what is different from the rules the project
 * has today (`change.was`, absent on an operation queued before it was
 * passed). Nothing here decides anything: it describes the change.
 */
function describeRulesChange(change, sizes = null) {
  const full = governanceRules.describeRulesInFull(change.governance);
  const lines = ['A change goes live when any one of these rules passes:'];
  for (const sentence of full.sentences) lines.push(`- ${sentence}`);
  if (full.groups.length) {
    lines.push('');
    for (const group of full.groups) lines.push(groupPeopleLine(group, sizes));
  }
  const was = change.was || null;
  const diff = was ? governanceRules.diffRules(was.rules, change.governance) : null;
  if (diff) {
    // A removed rule may name a group that is going too: read both lists.
    const groups = [...(change.governance.groups || []), ...((was.rules && was.rules.groups) || [])];
    const changes = [];
    for (const rule of diff.added) changes.push(`- Added: ${governanceRules.ruleSentence(rule, groups)}.`);
    for (const rule of diff.removed) changes.push(`- Removed: ${governanceRules.ruleSentence(rule, groups)}.`);
    for (const group of diff.groupsAdded) {
      // #6811: with the app's size when it has sent this group's list.
      const sent = group.keptByApp && sizes && sizes.get(governanceRules.groupKey(group.name));
      const people = group.keptByApp
        ? (sent ? ` (kept by the app, ${peopleToday(sent.size)})` : ' (kept by the app)')
        : (group.people.length ? ` (${group.people.map((p) => `@${p}`).join(', ')})` : '');
      changes.push(`- New group: ${group.name}${people}.`);
    }
    for (const group of diff.groupsRemoved) changes.push(`- Group removed: ${group.name}.`);
    for (const { name, added, removed } of diff.peopleChanged) {
      const how = [];
      if (added.length) how.push(`adds ${added.map((p) => `@${p}`).join(', ')}`);
      if (removed.length) how.push(`removes ${removed.map((p) => `@${p}`).join(', ')}`);
      changes.push(`- ${name}: ${how.join(', ')}.`);
    }
    if (changes.length) {
      lines.push('');
      lines.push('Compared with today:');
      lines.push(...changes);
    }
  }
  if (was && !was.rules) {
    lines.push('');
    lines.push(`Until now: ${appManifest.describeGovernance(was.approverPolicy, was.approvalsRequired)}.`);
  }
  return lines.join('\n');
}

/**
 * Open the PR. `change` is diffChange's output (at least one part set).
 * Resolves `{ sessionId, prNumber, prUrl, branch, title }`.
 */
async function createWhoDecidesPR(config, pool, app, change, actor, { steps } = {}) {
  const title = describeChange(change);
  const parts = [];
  if (change.visibility) {
    parts.push(change.visibility === 'public'
      ? 'makes it a public community: anyone can see it and join, and everyone who can see it can suggest changes'
      : 'makes it a private community: only its members can see it');
  }
  const intro = change.governance && !change.visibility
    ? `${actor.username} (via Homeroom) proposed a change to how changes to "${app.name}" are approved.`
    : `${actor.username} (via Homeroom) proposed a change to who can see and change "${app.name}": it ${parts.join(', and ')}.`;
  const block = change.governance ? governanceRules.blockFor(change.governance) : null;
  // #6811: the app's own sizes, so a kept group's line says how many people it
  // has today. Best-effort: a failed read leaves the line as it was.
  const sizes = new Map();
  if (change.governance) {
    try {
      for (const g of await governance.listAppGroups(pool, app.id)) {
        if (g.reportedAt) sizes.set(g.key, { size: g.size });
      }
    } catch { /* the description is the rules without sizes */ }
  }
  const result = await renamePr.createManifestPR(config, pool, app, actor, {
    steps,
    mutate: (m) => {
      if (change.visibility) {
        const cols = columnsFor(change.visibility);
        m.visibility = { build: cols.collab, view: cols.view };
      }
      if (block) m.governance = block;
    },
    branchPrefix: 'who-decides',
    commitMessage: title,
    prTitle: title,
    prBody:
      intro + '\n\n'
      + (change.governance ? `${describeRulesChange(change, sizes)}\n\n` : '')
      + 'This PR updates '
      + [change.visibility ? 'the `visibility` block' : null, block ? 'the `governance` block' : null].filter(Boolean).join(' and ')
      + ' in `dapp.json`. A change to who decides goes live on the creator\'s yes, or on the group\'s real yes votes, '
      + 'never on a quiet wait. It applies automatically once the PR merges and the project redeploys.',
    chatText: (prData) => `${actor.username} proposed: ${title}. Opened PR #${prData.number}.`,
    eventMetadata: { whoDecides: true, visibility: !!change.visibility, governance: !!block },
    explicitApproval: true,
    explicitApprovalReason: block ? 'governance' : 'visibility',
  });
  return { ...result, title };
}

/**
 * The change to who decides already up for a vote, if one is: a
 * who-decides PR, or one of the single-block PRs it replaces.
 */
async function findWhoDecidesPr(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url, pr_title FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND (branch_name LIKE 'who-decides/%' OR branch_name LIKE 'governance/%'
             OR branch_name LIKE 'visibility/%')
      ORDER BY id DESC
      LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

module.exports = {
  VISIBILITIES,
  WhoDecidesError,
  parseChange,
  columnsFor,
  diffChange,
  describeChange,
  describeRulesChange,
  checkPeople,
  createWhoDecidesPR,
  findWhoDecidesPr,
};
