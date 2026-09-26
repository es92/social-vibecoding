'use strict';

/**
 * The choices POST /api/apps accepts beyond a name and a repo (communities,
 * stage 3): who the project is for, who is invited into it, and who approves
 * its changes. Pure, so every rule here is tested without a server
 * (tests/create-options.test.js); the route resolves usernames and writes
 * rows with what this returns.
 *
 * ── Who it is for ───────────────────────────────────────────────────────
 *
 * `audience` is the create screen's first question in the platform's own
 * words (services/communities.js): `solo` (Just me), `invited` (A group) or
 * `open` (A community). It is not stored — audience is derived, never
 * stored — so it resolves here to the two visibility columns it implies:
 *
 *   solo, invited → collab private, view private. A private project; it
 *                   reads as a Group once anyone else is in it or invited.
 *   open          → collab public, view public. Anyone can see, join and
 *                   build.
 *
 * "Public to use, invite-only building" is not an audience a creator picks:
 * it stays in the project's settings for later. A body without `audience`
 * is an older client (or a script) and keeps today's two fields, with
 * today's defaults and today's combination rule.
 *
 * ── Who is invited ─────────────────────────────────────────────────────
 *
 * `invitees` is a list of usernames, for a Group only: an invite into a
 * project anyone can already build is meaningless (the invites route refuses
 * it for the same reason), and into a Just-me project it would make it a
 * Group, which is a different answer to the first question.
 *
 * ── Who approves ───────────────────────────────────────────────────────
 *
 * `governance` is dapp.json's own block, in dapp.json's own shape
 * (services/app-manifest.js readGovernance), because that is where it is
 * written: the new repository's dapp.json carries it, so the rule is
 * votable later like any other line of the manifest. Strict here where the
 * manifest reader is lenient: a creator who sent a value meant it, and a
 * silently dropped rule would be a project that approves changes
 * differently from what its creator chose. Not for an import: an existing
 * repository's own dapp.json decides that on its first deploy.
 *
 * ── What it is ─────────────────────────────────────────────────────────
 *
 * `description` is dapp.json's top-level one line about what the project
 * is, optional, and written where the approval rule is: the new
 * repository's dapp.json, so a community changes it later with a vote like
 * any other line there. The join screen, Discover and the project's page
 * read it off the manifest snapshot. Whitespace collapses to single spaces;
 * at most DESCRIPTION_MAX characters, the length the join screen shows
 * whole. Not for an import either: its own dapp.json describes it.
 */

const AUDIENCES = new Set(['solo', 'invited', 'open']);
const VISIBILITIES = new Set(['public', 'private']);
const MAX_INVITEES = 20;
const MAX_APPROVALS_REQUIRED = 50;
const USERNAME_MAX = 64;
const DESCRIPTION_MAX = 100;

/** The two visibility columns an audience implies. */
function visibilityForAudience(audience) {
  return audience === 'open'
    ? { collabVisibility: 'public', viewVisibility: 'public' }
    : { collabVisibility: 'private', viewVisibility: 'private' };
}

/** Today's rule for the two raw fields, unchanged (routes/apps.js had it). */
function visibilityComboError(collab, view) {
  if (!VISIBILITIES.has(collab) || !VISIBILITIES.has(view)) {
    return 'Visibility must be "public" or "private"';
  }
  if (collab === 'public' && view === 'private') {
    return 'An app that everyone can build cannot be private to view';
  }
  return null;
}

function parseInvitees(raw) {
  if (raw == null) return { invitees: [] };
  if (!Array.isArray(raw)) return { error: 'invitees must be a list of usernames' };
  const seen = new Set();
  const invitees = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return { error: 'invitees must be a list of usernames' };
    const name = entry.trim().replace(/^@/, '');
    if (!name) continue;
    if (name.length > USERNAME_MAX) return { error: `@${name.slice(0, 24)}… is not a username` };
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    invitees.push(name);
  }
  if (invitees.length > MAX_INVITEES) {
    return { error: `Invite at most ${MAX_INVITEES} people when you create it; add more from its page.` };
  }
  return { invitees };
}

/**
 * dapp.json's governance block → the two columns, or an error. `null`
 * (absent) is the default rule: anyone approves, time and majority.
 */
function parseGovernance(raw) {
  if (raw == null) return { governance: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'governance must be an object' };
  const approvers = raw.approvers == null ? 'anyone' : raw.approvers;
  if (approvers !== 'anyone' && approvers !== 'invited') {
    return { error: 'governance.approvers must be "anyone" or "invited"' };
  }
  let approvalsRequired = null;
  if (raw.approvals != null && raw.approvals !== 'default') {
    const n = raw.approvals && typeof raw.approvals === 'object' && !Array.isArray(raw.approvals)
      ? raw.approvals.atLeast : undefined;
    if (!Number.isInteger(n) || n < 1 || n > MAX_APPROVALS_REQUIRED) {
      return { error: `governance.approvals must be "default" or { "atLeast": 1-${MAX_APPROVALS_REQUIRED} }` };
    }
    approvalsRequired = n;
  }
  if (approvers === 'anyone' && approvalsRequired == null) return { governance: null };
  return { governance: { approverPolicy: approvers, approvalsRequired } };
}

/** The one line, tidied, or null when blank. */
function parseDescription(raw) {
  if (raw == null) return { description: null };
  if (typeof raw !== 'string') return { error: 'description must be a line of text' };
  const text = raw.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  if (!text) return { description: null };
  if (text.length > DESCRIPTION_MAX) {
    return { error: `Say what it is in ${DESCRIPTION_MAX} characters or fewer.` };
  }
  return { description: text };
}

/**
 * Everything POST /api/apps needs to know about who a new project is for.
 * Returns `{ error }` for a 400, otherwise
 * `{ audience, collabVisibility, viewVisibility, invitees, governance,
 * description }`.
 */
function parseCreateOptions(body = {}, { imported = false } = {}) {
  let audience = null;
  let collabVisibility;
  let viewVisibility;
  if (body.audience != null) {
    if (!AUDIENCES.has(body.audience)) return { error: 'audience must be "solo", "invited" or "open"' };
    audience = body.audience;
    ({ collabVisibility, viewVisibility } = visibilityForAudience(audience));
  } else {
    collabVisibility = body.collabVisibility || 'public';
    viewVisibility = body.viewVisibility || 'public';
    const comboError = visibilityComboError(collabVisibility, viewVisibility);
    if (comboError) return { error: comboError };
  }

  const inv = parseInvitees(body.invitees);
  if (inv.error) return { error: inv.error };
  if (inv.invitees.length && audience !== 'invited') {
    return { error: 'Only a group is created with invites. Invite people from a project’s page.' };
  }

  const gov = parseGovernance(body.governance);
  if (gov.error) return { error: gov.error };
  if (gov.governance && imported) {
    return { error: 'An imported repo’s own dapp.json decides who approves changes.' };
  }

  const desc = parseDescription(body.description);
  if (desc.error) return { error: desc.error };
  if (desc.description && imported) {
    return { error: 'An imported repo’s own dapp.json describes it.' };
  }

  return {
    audience,
    collabVisibility,
    viewVisibility,
    invitees: inv.invitees,
    governance: gov.governance,
    description: desc.description,
  };
}

/**
 * The block a new repository's dapp.json carries for a governance choice, in
 * the shape readGovernance reads back. Null for the default rule, so a
 * default project's dapp.json stays the one-line `{ "secrets": [] }` it
 * always was.
 */
function governanceBlock(governance) {
  if (!governance) return null;
  const { approverPolicy = 'anyone', approvalsRequired = null } = governance;
  if (approverPolicy === 'anyone' && approvalsRequired == null) return null;
  return {
    approvers: approverPolicy,
    approvals: approvalsRequired == null ? 'default' : { atLeast: approvalsRequired },
  };
}

module.exports = {
  AUDIENCES,
  MAX_INVITEES,
  DESCRIPTION_MAX,
  parseCreateOptions,
  governanceBlock,
  visibilityForAudience,
  visibilityComboError,
};
