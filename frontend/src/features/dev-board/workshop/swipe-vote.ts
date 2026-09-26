/**
 * Swipe to vote on a Needs-you card (#3052): the arithmetic, and nothing else.
 *
 * On a phone the Needs-you feed already pages VERTICALLY: a drag up snaps to
 * the next card. This adds the other axis on a card the viewer can vote on:
 * drag right for Yes, left for No. The two gestures share one finger, so the
 * first thing a press has to do is pick an axis, and the last thing it has to
 * do is decide whether it travelled far enough to count.
 *
 * Its own module, like ./ask-stream.ts, so the suite can EXECUTE those rules
 * (tests/lib/render-tsx.js `loadTsx`) rather than grep for them. The pointer
 * handling, the DOM writes and the vote itself are workshop.tsx's; the
 * numbers that decide what a drag means live here.
 */

/**
 * How far a press travels, in CSS px, before it commits to an axis. Below it
 * a press is still a tap, and nothing moves.
 */
export const SWIPE_LOCK_PX = 10;

/** The share of the card's width a drag has to cross before it votes. */
export const SWIPE_COMMIT_SHARE = 0.35;

/**
 * The shortest drag that votes, whatever the card's width. A card measured
 * at 0 (not laid out yet) or a very narrow one must not vote on a nudge.
 */
export const SWIPE_COMMIT_MIN_PX = 96;

export type SwipeAxis = 'x' | 'y';
export type SwipeSide = 'yes' | 'no';

/**
 * Which axis a press has chosen, once it has moved `SWIPE_LOCK_PX` from where
 * it went down; null until then.
 *
 * A tie goes to `y`. Paging is this screen's own gesture and the vote is the
 * newcomer, so a diagonal drag keeps doing what it always did: only a drag
 * that is plainly sideways becomes a vote.
 */
export function swipeAxis(dx: number, dy: number): SwipeAxis | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (!(Math.hypot(ax, ay) >= SWIPE_LOCK_PX)) return null;
  return ax > ay ? 'x' : 'y';
}

/**
 * The distance a drag has to cover on a card this wide to vote, in whole px
 * (a share of a width is rarely a whole number, and a line at 125.99999px is
 * one nobody can reason about).
 */
export function commitDistance(width: number): number {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  return Math.max(SWIPE_COMMIT_MIN_PX, Math.round(w * SWIPE_COMMIT_SHARE));
}

/** Which answer a horizontal offset points at: right is Yes, left is No. */
export function swipeSide(dx: number): SwipeSide | null {
  if (!Number.isFinite(dx) || dx === 0) return null;
  return dx > 0 ? 'yes' : 'no';
}

/**
 * How far along to the threshold the drag is, from 0 to 1. The hint's
 * opacity: it fades in as the card travels and is at its strongest exactly
 * where letting go would vote.
 */
export function swipeProgress(dx: number, width: number): number {
  if (!Number.isFinite(dx)) return 0;
  return Math.min(1, Math.abs(dx) / commitDistance(width));
}

/**
 * What letting go here does: the answer, once the drag has reached the
 * threshold, and null below it (the card snaps back and nothing is sent).
 */
export function swipeVerdict(dx: number, width: number): SwipeSide | null {
  if (!Number.isFinite(dx) || Math.abs(dx) < commitDistance(width)) return null;
  return swipeSide(dx);
}
