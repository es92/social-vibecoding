/**
 * What the About pane SAYS — pure, so the wording is pinned by tests with
 * plain objects rather than by a browser.
 *
 * ── The build-by-vote note has to be true for THIS app ──────────────────
 *
 * The design's line is "Anyone can propose; a proposal merges when a majority
 * of active members vote yes and checks pass." That is one of three regimes
 * the platform actually runs, per app, from dapp.json's `governance` block
 * (services/governance.js, apps.approver_policy / apps.approvals_required):
 *
 *   the default    every eligible vote counts, over a dynamic time-and-
 *                  majority gate among the app's active members — a clear
 *                  majority merges fast, thin unopposed support after a
 *                  window, and No votes raise the bar;
 *   'invited'      the same gate, but only the app's invited approvers'
 *                  votes count;
 *   at least N     a fixed number of yes votes (approvers' only, when the
 *                  policy is 'invited') and no clock at all.
 *
 * Two more facts hold whatever the regime: a LOCKED app also needs an admin's
 * yes (services/admin-approval.js), and nothing merges until its checks pass.
 * And "anyone can propose" is only true where anyone can build: an
 * invite-only-build app (collab_visibility 'private') takes proposals from
 * its members.
 *
 * So the sentence is assembled from the row the pane already has — both
 * GET /api/apps and GET /api/apps/:slug carry all four columns — and a row
 * that lacks them reads as the default, which is what an absent column means
 * on the server too. It is deliberately a SUMMARY: the Workshop's "How voting
 * works" popover (../dev-board/voting-help.tsx) is where the clocks are
 * spelled out.
 */

export type AppRow = Record<string, any>;

/** "a, b and c" — the list a sentence can carry. */
export function joinClauses(parts: Array<string | null | undefined | false>): string {
  const list = parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

function approvalsRequired(row: AppRow | null | undefined): number | null {
  const raw = row ? row.approvals_required : null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The vote half of "a proposal merges once …", for `who` ("the app’s",
 * "the platform’s").
 */
export function voteClause(row: AppRow | null | undefined, who: string): string {
  const invited = !!row && row.approver_policy === 'invited';
  const n = approvalsRequired(row);
  if (n != null) {
    if (invited) {
      return n === 1
        ? `one of ${who} invited approvers votes yes`
        : `${n} of ${who} invited approvers vote yes`;
    }
    return n === 1 ? 'it has a yes vote' : `it has ${n} yes votes`;
  }
  return invited
    ? `${who} invited approvers back it in a vote`
    : `${who} active members back it in a vote`;
}

/** Everything a proposal waits on, in the order it reads. */
export function mergeConditions(row: AppRow | null | undefined, who: string): string {
  return joinClauses([
    voteClause(row, who),
    row && row.locked ? 'an admin votes yes' : null,
    'its checks pass',
  ]);
}

/** The build-by-vote note under an app's actions. */
export function appNote(row: AppRow | null | undefined): string {
  const proposers = row && row.collab_visibility === 'private'
    ? 'Its members can suggest a change'
    : 'Anyone can suggest a change';
  return 'Built by the group, one approved change at a time. '
    + `${proposers}; it goes live once ${mergeConditions(row, 'the app’s')}.`;
}

/**
 * The platform's note. `row` is the self-hosted row when this viewer is
 * served it; `restricted` when they are not, in which case they cannot
 * propose to it either, and the sentence says how it is built without
 * inviting them to do something the platform will refuse.
 */
export function platformNote(row: AppRow | null | undefined, restricted: boolean): string {
  const tail = ' This menu is the same one every app has.';
  if (restricted) {
    return 'The platform is built the same way as the apps on it: every change to the tabs, '
      + 'the bell or the workshop is suggested, approved, and goes live once its checks pass. '
      + 'On this server its workshop is open to admins only.' + tail;
  }
  const proposers = row && row.collab_visibility === 'private'
    ? 'its members can suggest'
    : 'anyone can suggest';
  return `The platform is built the same way as the apps on it: ${proposers} a change to the `
    + `tabs, the bell or the workshop, and it goes live once ${mergeConditions(row, 'the platform’s')}.`
    + tail;
}

/** The app's tagline: its manifest's one-line description (HomePanels.appBlurb's rule). */
export function taglineOf(row: AppRow | null | undefined): string | null {
  const snap = row && row.manifest_snapshot;
  const raw = snap && typeof snap === 'object' ? snap.description : null;
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 160) : null;
}

/** The short SHA of what is running, from either payload shape. */
export function shortVersionOf(row: AppRow | null | undefined): string | null {
  if (!row) return null;
  if (row.version && typeof row.version === 'object' && row.version.shortSha) {
    return String(row.version.shortSha);
  }
  return row.main_sha ? String(row.main_sha).slice(0, 7) : null;
}

/**
 * The pill beside the avatars: "<version> · <updated>".
 *
 * The design writes "v41 · 2h ago". The platform has no version NUMBER — what
 * an app is running is named by its commit, which is what every other
 * version surface here prints — so the pill reads "a1b2c3d · 2h ago". With
 * only one of the two it says that one, and with neither there is no pill:
 * "version —" is worse than silence.
 */
export function versionPillText(version: string | null, updated: string | null): string | null {
  if (version && updated) return `${version} · ${updated}`;
  if (version) return version;
  if (updated) return `Updated ${updated}`;
  return null;
}

export interface StatCard { key: 'apps' | 'members' | 'merged'; value: string; label: string }

/** About Homeroom's three cards, in the design's order. */
export function statCards(stats: { apps?: number; members?: number; merged?: number } | null): StatCard[] {
  const n = (v: unknown) => {
    const x = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  const s = stats || {};
  const apps = n(s.apps);
  const members = n(s.members);
  const merged = n(s.merged);
  return [
    { key: 'apps', value: apps.toLocaleString(), label: apps === 1 ? 'app' : 'apps' },
    { key: 'members', value: members.toLocaleString(), label: members === 1 ? 'member' : 'members' },
    { key: 'merged', value: merged.toLocaleString(), label: 'live' },
  ];
}

export interface ContributorView { who: string; initial: string; merged: number }

/**
 * One contributor row, from GET /api/apps/:slug/contributors' shape — the
 * payload Discover's app page reads (../apps/browse.js contributorRowView).
 */
export function contributorView(c: AppRow | null | undefined): ContributorView {
  const who = (c && typeof c.username === 'string' && c.username) || 'unknown';
  const merged = parseInt(String(c ? c.merged_count : 0), 10) || 0;
  return { who, initial: (who[0] || '?').toUpperCase(), merged };
}

/**
 * The Open button's words, the way Discover's app page words them
 * (../apps/browse.js _renderDetail): Resume for the app you left, Open for
 * one that can open, and the reason for one that cannot.
 */
export function openLabel(status: string | null | undefined, parked: boolean): { label: string; canOpen: boolean } {
  const canOpen = status === 'running' || status === 'awaiting_secrets';
  if (canOpen) return { label: parked ? 'Resume' : 'Open', canOpen };
  if (status === 'creating') return { label: 'Spinning up…', canOpen };
  if (status === 'error') return { label: 'Not running', canOpen };
  return { label: status || 'Unavailable', canOpen };
}
