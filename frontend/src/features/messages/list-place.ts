/*
 * #6508: the list keeps its place while it updates live.
 *
 * "scrolling the long proposal list on a trackpad, it jerks back up a few
 * rows on its own now and then. only on the inbox, other lists are smooth"
 * (Maztrilover, 9 Nov 2026).
 *
 * The inbox re-sorts on its own clock: a change moving stage, a bot reply or
 * a new message rebuilds it (`buildInbox`, ./inbox.ts), and a row that was
 * below the reader is drawn above them. The browser's own scroll anchoring
 * used to pick that row as its anchor and move `scrollTop` with it, which,
 * with the reader's trackpad scroll in progress, reads as the list jumping
 * back several rows.
 *
 * So the scroller remembers which row is at the top of what it shows (and
 * how far that row sits from the top edge), and after a re-sort it moves the
 * content by however far that same row travelled. Nothing here touches the
 * DOM: the conversation list (./index.tsx) measures and writes, and these
 * two functions decide.
 */

/** A row as the list measures it, in the scroller's own coordinates. */
export interface MeasuredRow {
  key: string;
  /** Distance from the scroller's top edge to the row's top: zero or negative when partly scrolled past. */
  top: number;
  /** Distance from the scroller's top edge to the row's bottom. */
  bottom: number;
}

/** The row at the top of what the scroller shows, and where it sits. */
export interface SavedPlace {
  key: string;
  /** The row's top less the view's top, as it was when it was saved. */
  offset: number;
}

/**
 * The first row, in document order, that is at least partly below the view's
 * top edge, with its offset. A row partly scrolled past gives a negative
 * offset. Null when the list draws no rows.
 */
export function firstRowInView(rows: readonly MeasuredRow[], viewTop: number): SavedPlace | null {
  for (const row of rows) {
    if (row.bottom > viewTop) return { key: row.key, offset: row.top - viewTop };
  }
  return null;
}

/**
 * How far to move the scroller to put the saved row back where it was: what
 * that row is now, minus where it was. Zero when there is nothing to hold,
 * when the row is no longer drawn, and when the difference is under a pixel
 * (rounding, not a move).
 */
export function scrollCorrection(saved: SavedPlace | null, nowTop: number | null, viewTop: number): number {
  if (!saved || nowTop === null) return 0;
  const delta = (nowTop - viewTop) - saved.offset;
  return Math.abs(delta) < 1 ? 0 : delta;
}
