/**
 * #6440: a governance vote as its page reads it — pure, so tests read it
 * without a DOM; drawn by ./governance-head.tsx.
 *
 * A decision is one `issues` row of a governance kind (src/workflow/rules/
 * governance-kinds.ts). The ones about the PROJECT (a rename, a secret
 * change, a maintenance campaign, a new featured picture) have a page of
 * their own, drawn in the request page's thread layout. The ones about one
 * request or thread (`reopen_issue`, `thread_move`) are not drawn here at
 * all: the server names the page they belong to (`row.home`) and the router
 * forwards there.
 *
 * A secret change's payload is stripped of its ciphertext by the server
 * (routes/issues.js) and this model has no field a value could go in: the
 * key and the action are what a voter reads.
 */

export type GovernanceOutcome = 'open' | 'applying' | 'applied' | 'refused' | 'withdrawn' | 'superseded';

export type GovernanceKind =
  | 'rename' | 'secret_change' | 'maintenance_campaign' | 'featured_illustration'
  | 'close_issue' | 'reopen_issue' | 'thread_move';

/** A picture the featured-illustration preview draws (card/model.ts's spec). */
export interface GovernancePicture {
  url: string;
  darkUrl?: string | null;
  zoom?: number;
  x?: number;
  y?: number;
  tint?: string | null;
  /** The card's animated preview loop, as the record stores it. */
  preview?: { url?: string; type?: string } | null;
}

export type GovernanceContent =
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'secret'; key: string; action: 'set' | 'remove' }
  | { kind: 'campaign'; title: string; description: string }
  | { kind: 'illustration'; current: GovernancePicture | null; proposed: GovernancePicture | null; remove: boolean }
  | { kind: 'close'; number: number | null; title: string; reason: string };

export interface GovernanceVotes {
  yes: number;
  need: number;
  mine: 'yes' | 'no' | null;
  /** Still counting: the card offers Yes and No and never an ending. */
  open: boolean;
  outcome: GovernanceOutcome;
}

export interface GovernanceView {
  id: number;
  kind: GovernanceKind;
  /** "Rename #4812", as the bar says it. */
  kicker: { id: string; values: Record<string, string | number> };
  title: string;
  /** Who proposed it, and when. */
  by: string;
  at: string | null;
  /** `at` as the page says it ("2h ago"). */
  atText: string;
  content: GovernanceContent;
  votes: GovernanceVotes;
  /** The viewer proposed it, and the vote is still open. */
  canWithdraw: boolean;
  /** The ⋯ menu's key in AppView's registry (`_registerCardMenu`). */
  menuKey: string;
  /** The bar's status pill while the vote is open (AppView.statusPillState). */
  pill: any;
  /** The votes cast, in the voters' own words (topic-head.tsx Roster). */
  roster: any;
}

const KICKERS: Record<string, string> = {
  rename: 'project:topic.decision.bar.rename',
  secret_change: 'project:topic.decision.bar.secret',
  maintenance_campaign: 'project:topic.decision.bar.campaign',
  featured_illustration: 'project:topic.decision.bar.illustration',
  close_issue: 'project:topic.decision.bar.close',
  reopen_issue: 'project:topic.decision.bar.reopen',
  thread_move: 'project:topic.decision.bar.move',
};

/**
 * How the vote stands or ended. `row.outcome` from the server wins (it knows
 * what the apply records say); derived from the row otherwise, so a mock row
 * or a list row reads the same way. Pure.
 */
export function governanceOutcome(row: any): GovernanceOutcome {
  const said = row && row.outcome;
  if (said && said !== 'open') return said as GovernanceOutcome;
  const p = (row && row.payload) || {};
  if (p.appliedAt) return String(p.appliedBy || '').startsWith('refused:') ? 'refused' : 'applied';
  if (p.withdrawnAt || (row && row.status === 'withdrawn')) return 'withdrawn';
  if (p.supersededAt) return 'superseded';
  if (row && row.status && row.status !== 'open') return 'applied';
  // Passed and being carried out: the same two facts `_govApplyState`
  // reads — the gate is met and its window has elapsed.
  const yes = Number(row && row.qualified_yes_count != null ? row.qualified_yes_count : row && row.up_count) || 0;
  const need = Number(row && row.approvals_required != null ? row.approvals_required : row && row.votes_required) || 0;
  const ends = row && row.merge_window_ends_at ? Date.parse(row.merge_window_ends_at) : NaN;
  if (need > 0 && yes >= need && !(row && row.contested) && Number.isFinite(ends) && ends <= Date.now()) {
    return 'applying';
  }
  return 'open';
}

/** The line an ended vote's card carries, as a message id; null while it counts. Pure. */
export function outcomeLine(outcome: GovernanceOutcome): string | null {
  if (outcome === 'applied') return 'project:topic.decision.outcome.applied';
  if (outcome === 'applying') return 'project:topic.decision.outcome.applying';
  if (outcome === 'refused') return 'project:topic.decision.outcome.refused';
  if (outcome === 'withdrawn') return 'project:topic.decision.outcome.withdrawn';
  if (outcome === 'superseded') return 'project:topic.decision.outcome.superseded';
  return null;
}

/** A stored picture record with its loop's URL beside it, as the preview row reads it. Pure. */
function withPreviewUrl(rec: GovernancePicture): GovernancePicture & { previewUrl: string | null } {
  const url = rec.preview && typeof rec.preview.url === 'string' ? rec.preview.url : null;
  return { ...rec, previewUrl: url };
}

/** What the root post says it does, in the kind's own words. Pure. */
export function governanceContent(row: any, appName = ''): GovernanceContent {
  const p = (row && row.payload) || {};
  const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  switch (row && row.kind) {
    case 'rename':
      return { kind: 'rename', from: text(p.oldName) || appName, to: text(p.newName) || text(row.title) };
    case 'secret_change':
      // The key and the action only. The server strips the ciphertext and
      // marks `hasValue`; nothing here can carry a value.
      return { kind: 'secret', key: text(p.key), action: p.action === 'remove' ? 'remove' : 'set' };
    case 'maintenance_campaign':
      return { kind: 'campaign', title: text(row.title), description: text(p.instructions) || text(row.description) };
    case 'featured_illustration':
      return {
        kind: 'illustration',
        current: p.current && p.current.url ? withPreviewUrl(p.current) : null,
        proposed: p.proposed && p.proposed.url ? withPreviewUrl(p.proposed) : null,
        remove: p.remove === true,
      };
    default:
      return {
        kind: 'close',
        number: Number.isInteger(Number(p.issueNumber)) && Number(p.issueNumber) > 0 ? Number(p.issueNumber) : null,
        title: text(p.issueTitle) || text(row && row.title),
        reason: text(p.reason),
      };
  }
}

/** The tally the Votes card draws: the qualified count where the rule keeps one. Pure. */
function tally(row: any): { yes: number; need: number; mine: 'yes' | 'no' | null } {
  const yes = Number(row && row.qualified_yes_count != null ? row.qualified_yes_count : row && row.up_count) || 0;
  const need = Math.max(1, Number(row && row.approvals_required != null ? row.approvals_required : row && row.votes_required) || 1);
  const mine = row && row.my_vote === 'up' ? 'yes' : row && row.my_vote === 'down' ? 'no' : null;
  return { yes, need, mine };
}

export interface GovernanceViewer {
  /** The viewer's username, for the withdraw row. */
  username?: string | null;
  /** The project's own name, for a rename proposed without its old name. */
  appName?: string;
  /** The ⋯ menu's key (AppView registers the rows). */
  menuKey?: string;
  /** The votes cast, already read (`AppView._govVoteRoster`). */
  roster?: any;
  /** `created_at` in the page's words (GroupsChat._stamp). */
  atText?: string;
  /** The status pill AppView computed for an open vote. */
  pill?: any;
}

/** One governance row as its page reads it. Pure. */
export function governanceView(row: any, viewer: GovernanceViewer = {}): GovernanceView {
  const kind = String((row && row.kind) || '') as GovernanceKind;
  const outcome = governanceOutcome(row);
  const votes = tally(row);
  const id = Number(row && row.id) || 0;
  const by = (row && (row.created_by_username || row.username)) || '';
  const content = governanceContent(row, viewer.appName || '');
  const title = content.kind === 'close' ? content.title
    : content.kind === 'campaign' ? content.title
      : content.kind === 'secret' ? content.key
        : content.kind === 'rename' ? content.to
          : (row && row.title) || '';
  return {
    id,
    kind,
    kicker: {
      id: KICKERS[kind] || 'project:topic.decision.bar.close',
      values: { number: id },
    },
    title: String(title || ''),
    by,
    at: (row && row.created_at) || null,
    atText: viewer.atText || '',
    content,
    votes: { ...votes, open: outcome === 'open', outcome },
    canWithdraw: outcome === 'open' && !!by && !!viewer.username && by === viewer.username,
    menuKey: viewer.menuKey || '',
    pill: viewer.pill || null,
    roster: viewer.roster || null,
  };
}
