/**
 * One model of a change, behind every place that summarises one.
 *
 * The facts about a single change (its name, its summary, where its vote
 * stands, its checks and what this person can do about it) used to be put
 * together by each place that summarises it, each its own way: the Needs you
 * review (../../review-flow/model.ts), the Needs you rows
 * (../../workshop/needs-reel.tsx), the vote-type chips above them
 * (../../workshop/vote-filter.tsx), the vote card under a line about a change
 * in a chat (../../group-chat/vote-card.tsx) and the preview's bar
 * (../../staging/staging-overlay.tsx). Two of them flattened a summary with
 * the same function, word for word; three said which votes are advisory with
 * the same test, and two worded the vote's standing with the same branches.
 * Each place now takes this one description and asks it each fact; what it
 * draws, and how, stays its own.
 *
 * It is read from either kind of row a screen holds about a change:
 *
 *   changeFromFeed   a Needs you row (GET /api/workshop/needs-feed), across
 *                    projects: a `ChangeModel`;
 *   ChangeVote       the change's row in the vote snapshot
 *                    (AppView.voteState), the board's own row, as
 *                    group-chat.js `_voteView` resolves it for the chat's
 *                    card and the staging store for the preview's bar.
 *
 * The name a change is known by is chosen once on each side of the wire, in
 * one order: its pull request's own title, else the title chosen before it
 * had one, else its session's name (AppView._changeTitle, and the server's
 * feed and shared cards, src/services/shared-objects.js). Here it is only
 * cleaned of the prefix a bot change once carried.
 *
 * Pure: no React, no DOM, no window. Every phrase is a whole message id, read
 * where it is drawn.
 */

// Type only: the reel's rows are what `changeFromFeed` reads.
import type { NeedsFeedItem } from '../../workshop/needs-reel';

/** The project a change belongs to, as the feed names it. */
export type ChangeApp = NeedsFeedItem['app'];

export interface ChangeModel {
  /** A code change (a proposal) or a group decision. */
  kind: 'proposal' | 'governance';
  /** The change's session id, or the decision's id. */
  id: number;
  /** Its pull request's number, when it has one. */
  number: number | null;
  /** Its name as people read it (`cleanTitle`); '' when it has none, which each place says in its own words. */
  title: string;
  /** Its summary as one plain paragraph (`plainSummary`); '' when it has none. */
  summary: string;
  author: string | null;
  at: string | null;
  /** The approval epoch a vote on it is cast against (AppView.castVote). */
  epoch: number | null;
  app: ChangeApp;
  /**
   * What this person's Yes is: Approve, on a project that is just theirs
   * whose Yes is the one it needs (#4270, the server's rule for
   * `_cardVoteButtonSpecs`' `approve`).
   */
  approve: boolean;
  /** Their vote is recorded but does not decide: they are outside its deciders (#4747, #5365). */
  advisory: boolean;
  /** A test account's vote: recorded, not counted. */
  uncounted: boolean;
  /** Its code did not come across when Homeroom moved off GitHub (src/services/code-missing.js). */
  codeMissing: boolean;
}

/**
 * A summary written in Markdown, as one plain paragraph: headings, emphasis,
 * code ticks and list markers go, a link keeps its words, a picture and a
 * code block go, and the whitespace collapses. Where the whole summary is
 * shown, it is rendered instead.
 */
export function plainSummary(md: string | null | undefined): string {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A title as people read it: the request prefix a bot change carries is dropped. */
export function cleanTitle(title: string): string {
  return String(title || '')
    .replace(/^\s*implement this change in the app:\s*/i, '')
    .replace(/^\s*title:\s*/i, '')
    .trim();
}

/** A Needs you row (a change or a group decision) as the one model. */
export function changeFromFeed(item: NeedsFeedItem): ChangeModel {
  return {
    kind: item.kind === 'governance' ? 'governance' : 'proposal',
    id: item.id,
    number: item.number ?? null,
    title: cleanTitle(item.title || ''),
    summary: plainSummary(item.summary),
    author: item.author || null,
    at: item.at || null,
    epoch: item.epoch ?? null,
    app: item.app,
    approve: !!item.approve,
    advisory: !!item.advisory,
    uncounted: !!item.uncounted,
    codeMissing: !!item.codeMissing,
  };
}

/** The two kinds a vote falls into (#6199): one that decides, and one that is advice. */
export type VoteType = 'deciding' | 'advisory';

/**
 * Whether this person's vote decides: advisory when they are outside the
 * change's deciders or theirs is a test account's vote, recorded but not
 * counted. Everything else decides: a plain change, a group decision, a
 * ballot, the bot's question. Reads the marks off a change, a feed row, or a
 * row's Yes, which carries the same two.
 */
export function voteTypeOf(marks: { advisory?: boolean | null; uncounted?: boolean | null } | null | undefined): VoteType {
  return marks && (marks.advisory || marks.uncounted) ? 'advisory' : 'deciding';
}

/**
 * A change's vote, as its row in the vote snapshot carries it once resolved
 * (group-chat.js `_voteView`, the staging store's `vote`): where it is, the
 * yes votes that count and how many it needs, whether one must come from
 * another member (#788), and this person's own vote.
 */
export interface ChangeVote {
  /** 'promoted' while the vote is open; 'merging' and 'merged' once it is decided. */
  status: string;
  yes: number | null;
  needed: number | null;
  needsOtherMember: boolean;
  myVote: 'yes' | 'no' | null;
}

/** A phrase about a change: a whole message id and what it is read with. */
export interface ChangeWords {
  id: string;
  values?: Record<string, string | number>;
  /** It asks something of this person ("Needs 1 more yes", not voted yet): drawn in the accent where a place marks that. */
  ask?: boolean;
}

/**
 * Where the vote stands, in one phrase: gone live, going live, how many more
 * yes votes it needs, the yes votes in but one wanted from another member,
 * or the count it reached.
 */
export function voteStanding(vote: ChangeVote): ChangeWords {
  if (vote.status === 'merged') return { id: 'chat:group.voteCard.merged' };
  if (vote.status === 'merging') return { id: 'chat:group.voteCard.merging' };
  const yes = vote.yes ?? 0;
  const needed = vote.needed ?? 1;
  if (yes < needed) return { id: 'chat:group.voteCard.needsMore', values: { count: needed - yes }, ask: !vote.myVote };
  if (vote.needsOtherMember) return { id: 'chat:group.voteCard.needsOtherMember' };
  return { id: 'chat:group.voteCard.reached', values: { yes, needed } };
}

/** This person's own vote on it, in one phrase; null before they vote. */
export function myVoteWords(vote: Pick<ChangeVote, 'myVote'>): ChangeWords | null {
  if (vote.myVote === 'yes') return { id: 'chat:group.voteCard.youVotedYes' };
  if (vote.myVote === 'no') return { id: 'chat:group.voteCard.youVotedNo' };
  return null;
}

/** The checks' state, as a change's row carries it; null when unknown or not run. */
export type ChecksState = 'passing' | 'failing' | 'pending' | 'error' | 'skipped' | null;

/** Where its checks stand, in one phrase; null when there is nothing to say (none run, or skipped). */
export function checksWords(checks: ChecksState | undefined): ChangeWords | null {
  if (checks === 'passing') return { id: 'chat:group.voteCard.checks.passed' };
  if (checks === 'failing') return { id: 'chat:group.voteCard.checks.failing' };
  if (checks === 'pending') return { id: 'chat:group.voteCard.checks.running' };
  if (checks === 'error') return { id: 'chat:group.voteCard.checks.error' };
  return null;
}
