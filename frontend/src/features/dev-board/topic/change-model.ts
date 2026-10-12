/**
 * #4455 — a change's page, drawn as a Messages reply thread: the change as
 * the root post (./change-head.tsx), where it stands under it, then "N
 * replies" and one stream in time order (../../group-chat/transcript.tsx
 * `ChangeRows`).
 *
 * The stream's rules live here, pure, so they can be read and tested
 * without a page: which rows are people (drawn as Messages rows), which are
 * things that happened (one quiet line each), and which say what the page
 * already says and are left out.
 */

import type { TranscriptMessage } from '../../group-chat/transcript-store';
import { eventText } from '../../group-chat/proposal-event';

/**
 * One thing that happened, as its line: a glyph and the line's words. A line
 * the page words itself is a whole message (`id`, read with `values` where
 * it is drawn, with `<0>` around who did it and `<1>` around a vote's
 * reason); a line somebody else worded, the merge event's or a platform
 * notice's, arrives as `text`.
 */
export interface ChangeLine {
  kind: 'submitted' | 'vote' | 'preview' | 'merged' | 'spec' | 'notice';
  glyph: string;
  /** Bold at the line's start, or null when the line names nobody. */
  actor: string | null;
  /** The whole line's message id. */
  id?: string;
  /** What `id` is read with: who did it, a spec's version, a vote's reason. */
  values?: Record<string, string | number>;
  /** A line already worded: the merge event's sentence, or a notice. */
  text?: string;
  /** `preview`: the line ends "· Try it". */
  tryIt?: boolean;
}

/**
 * A vote's line, one whole message for each case: who voted (or nobody
 * named), yes or no, on this version or an earlier one, with or without the
 * voter's reason.
 */
const VOTE_LINE = {
  named: {
    yes: {
      current: { bare: 'project:topic.change.line.votedYes', reason: 'project:topic.change.line.votedYesReason' },
      earlier: { bare: 'project:topic.change.line.votedYesEarlier', reason: 'project:topic.change.line.votedYesEarlierReason' },
    },
    no: {
      current: { bare: 'project:topic.change.line.votedNo', reason: 'project:topic.change.line.votedNoReason' },
      earlier: { bare: 'project:topic.change.line.votedNoEarlier', reason: 'project:topic.change.line.votedNoEarlierReason' },
    },
  },
  unnamed: {
    yes: {
      current: { bare: 'project:topic.change.line.unnamedVotedYes', reason: 'project:topic.change.line.unnamedVotedYesReason' },
      earlier: { bare: 'project:topic.change.line.unnamedVotedYesEarlier', reason: 'project:topic.change.line.unnamedVotedYesEarlierReason' },
    },
    no: {
      current: { bare: 'project:topic.change.line.unnamedVotedNo', reason: 'project:topic.change.line.unnamedVotedNoReason' },
      earlier: { bare: 'project:topic.change.line.unnamedVotedNoEarlier', reason: 'project:topic.change.line.unnamedVotedNoEarlierReason' },
    },
  },
} as const;

/**
 * The line a row is drawn as, or null for a person's message (a Messages
 * row) and for a row the page leaves out.
 *
 *   - "snait asked for approval", for the row that put it up for a vote;
 *   - "cilokman voted yes", or "…voted yes on an earlier version" once a
 *     newer push has retired that yes (`GroupChat._votedOnEarlierVersion`);
 *   - "The preview is ready · Try it", in place of the two long build
 *     notices: the one that says the build started is the Testing card's to
 *     say, so it leaves the stream;
 *   - "This change went live with 2/3 votes", in the event's own words;
 *   - any other notice, as the platform wrote it for this page.
 */
export function changeLine(msg: TranscriptMessage): ChangeLine | null {
  if (msg.kind === 'message' || msg.kind === 'github') return null;
  if (msg.kind === 'spec_share' && msg.specShare) {
    // Homeroom bot's plan reads as the plan itself, "Plan v1: Dark mode",
    // with its Read (homeroom-bot-live.js specCard).
    if (msg.specShare.botNote || (!msg.specShare.sharedByUnknown && /^homeroom_bot$/i.test(msg.specShare.sharedBy))) {
      return {
        kind: 'spec', glyph: '📋', actor: null, id: 'project:topic.change.line.botPlan',
        values: { version: msg.specShare.version, title: msg.specShare.title },
      };
    }
    return {
      kind: 'spec', glyph: '📋', actor: msg.specShare.sharedBy,
      // Nobody to name has a wording of its own.
      id: msg.specShare.sharedByUnknown ? 'project:topic.change.line.postedSpecUnnamed' : 'project:topic.change.line.postedSpec',
      values: msg.specShare.sharedByUnknown
        ? { version: msg.specShare.version }
        : { author: msg.specShare.sharedBy, version: msg.specShare.version },
    };
  }
  if (msg.stagingBuild === 'started') return null;
  if (msg.stagingBuild === 'ready') return { kind: 'preview', glyph: '👀', actor: null, id: 'project:topic.change.line.previewReady', tryIt: true };
  const ev = msg.event;
  if (ev && ev.type === 'vote') {
    const ids = VOTE_LINE[ev.actor ? 'named' : 'unnamed'][ev.vote === 'no' ? 'no' : 'yes'][ev.earlier ? 'earlier' : 'current'];
    return {
      kind: 'vote',
      glyph: ev.vote === 'no' ? '✋' : '✅',
      actor: ev.actor || null,
      id: ev.reason ? ids.reason : ids.bare,
      values: { voter: ev.actor || '', ...(ev.reason ? { reason: ev.reason } : {}) },
    };
  }
  if (ev && ev.type === 'submitted') {
    return ev.actor
      ? { kind: 'submitted', glyph: '🗳️', actor: ev.actor, id: 'project:topic.change.line.askedForApproval', values: { author: ev.actor } }
      : { kind: 'submitted', glyph: '🗳️', actor: null, id: 'project:topic.change.line.unnamedAskedForApproval' };
  }
  if (ev && ev.type === 'merged') return { kind: 'merged', glyph: '🎉', actor: null, text: eventText(msg) };
  const text = ev && ev.type === 'notice' ? (ev.text || '') : (msg.systemText || '');
  if (!text.trim()) return null;
  return { kind: 'notice', glyph: '•', actor: null, text };
}

/** The rows a change's page draws: every person, and every line it keeps. */
export function changeStream(rows: TranscriptMessage[]): TranscriptMessage[] {
  return rows.filter((m) => m.kind === 'message' || changeLine(m) !== null);
}

/** The people in the stream: what "N replies" counts. */
export function changeReplyCount(rows: TranscriptMessage[]): number {
  return rows.filter((m) => m.kind === 'message' && !m.deleted).length;
}
