// #1408 — a textarea that grows with its content, up to a ceiling.
//
// The browser gives you `rows` (a fixed height) or a scrollbar, and nothing in
// between: a one-row composer holding four lines of text shows the last line
// and hides the rest, which is the complaint. CSS has no "height: content, but
// stop at N" for a form control either — `field-sizing: content` is exactly
// that and is not portable yet — so this is the small JS that fills the gap.
//
// ── Why it sets height and lets CSS hold the ceiling ───────────────────
//
// The measurement is the standard one: collapse to `auto` so scrollHeight
// reports the CONTENT height rather than the current box, then pin the box to
// it. Read without the reset, scrollHeight only ever grows — a textarea that
// had been dragged tall stays tall when its text is deleted.
//
// The MAXIMUM is usually the stylesheet's: every React caller already has a
// `max-height` there beside its other sizing. Setting `height` past it is
// harmless — the used height is clamped — so the element simply stops growing
// and scrolls. Callers must therefore set `overflow-y: auto`, or the overflow
// is clipped and unreachable. A caller with no stylesheet rule to lean on
// passes `max` instead (the group chat's composers cap at 140px in JS).
//
// ── Why it collapses only when the text lost something ─────────────────
//
// The collapse is two layouts per keystroke: `height: auto` invalidates the
// box, the `scrollHeight` read lays it out collapsed, and the height written
// back lays it out again. On a phone, in a long conversation, that was most
// of what a keystroke cost. It is only NEEDED when the content may have got
// shorter, because that is the one case the uncollapsed box cannot report.
// So the collapse runs on the first measure and whenever the new value is
// not the old one with text inserted into it (a deletion, a replacement, a
// clear after send). While text is only being inserted, the content can only
// grow, and ONE read is enough: `scrollHeight` beyond `clientHeight` means it
// outgrew the box, and the height is written only when it differs from the
// one last written. A box dragged taller by hand (`resize: vertical`) also
// keeps its height while text is being typed into it.
//
// ── Why a layout effect ────────────────────────────────────────────────
//
// ── Why a collapse puts a followed scroller back at its bottom ─────────
//
// #6810: collapsing the box makes it one row for an instant, so the scroller
// BELOW it (the composer is a sibling of the transcript) is taller by the
// box's extra lines. A scroller sitting at its bottom cannot stay scrolled
// that far and the browser pulls `scrollTop` back; the height written back
// leaves the scroller the size it was, so its ResizeObserver sees no change,
// never follows, and once the gap passes the follow threshold nothing
// follows again. So when a scroller is named, its gap is read before the
// collapse and, if it was at its bottom, it is put back there after the height
// is written — synchronously, before the frame is drawn.
//
// ── Why a layout effect ────────────────────────────────────────────────
//
// The height is written before the browser paints, so a restored draft or a
// pasted paragraph is never visibly one row for a frame before snapping open.
// It is client-only by construction, so the first render still matches the
// server's markup: the inline style appears after mount, and no host renders
// this on the server today anyway.

import { useIsomorphicLayoutEffect } from './legacy-dom';

import type { RefObject } from 'react';

/**
 * Whether `next` is `previous` with text inserted at one place (typing,
 * pasting without a selection): the only edits after which the content
 * cannot have got shorter.
 */
export function onlyInserted(previous: string, next: string): boolean {
  if (next.length < previous.length) return false;
  if (next.length === previous.length) return next === previous;
  let head = 0;
  while (head < previous.length && previous.charCodeAt(head) === next.charCodeAt(head)) head += 1;
  return next.endsWith(previous.slice(head));
}

/** What was last measured and written, per element. */
const measured = new WeakMap<HTMLTextAreaElement, { value: string; height: number }>();

export interface FitOptions {
  /** Ceiling for the written height, for a caller with no `max-height` in CSS. */
  max?: number;
  /** The transcript beside the box: a collapse puts it back at its bottom when it was there. */
  scroller?: HTMLElement | null;
}

/**
 * Size `el` to `value`, which it already holds. Exported for the tests, which
 * drive it against a fake element that counts its layouts.
 */
export function fitToContent(el: HTMLTextAreaElement, value: string, opts?: FitOptions): void {
  const max = opts?.max;
  const capped = (height: number) => (typeof max === 'number' ? Math.min(height, max) : height);
  const last = measured.get(el);
  if (!last || !onlyInserted(last.value, value)) {
    // The scroller's gap before the box collapses, which is the only place
    // the data is (see the header): at its bottom (≤1px), it goes back there
    // after the height is written.
    const scroller = opts?.scroller || null;
    const atBottom = !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1;
    // Two writes, in this order, for the reason in the header: without the
    // collapse, scrollHeight is measured against the box the element already
    // has and can only ratchet upwards.
    el.style.height = 'auto';
    const height = capped(el.scrollHeight);
    el.style.height = `${height}px`;
    measured.set(el, { value, height });
    if (atBottom && scroller) scroller.scrollTop = scroller.scrollHeight;
    return;
  }
  // Only inserted: one read. The box is written only once the content has
  // outgrown it, and never with the height it already has — so at the cap
  // nothing is written and nothing is laid out again.
  const content = el.scrollHeight;
  const height = capped(content);
  if (content > el.clientHeight && height !== last.height) {
    el.style.height = `${height}px`;
    measured.set(el, { value, height });
  } else {
    measured.set(el, { value, height: last.height });
  }
}

/**
 * Keep `ref`'s textarea sized to its content, re-measuring whenever `value`
 * changes.
 *
 * `value` is the dependency rather than an input listener because every caller
 * is already a controlled component: React has re-rendered by the time this
 * runs, so the DOM holds the new text and one measurement covers typing,
 * pasting, a programmatic clear on send, and a draft restored on mount.
 * `scroller` is the transcript beside the box, when a collapse may take height
 * from it (#6810).
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  scroller?: RefObject<HTMLElement | null>,
): void {
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    fitToContent(el, value, { scroller: scroller?.current || null });
  }, [ref, value, scroller]);
}

// The group chat and the general chat are classic scripts: they reach this as
// a global, as they do the keyboard hold (./keyboard-hold.ts).
if (typeof window !== 'undefined') {
  (window as unknown as { UsernodeAutoGrow?: { fit: typeof fitToContent; onlyInserted: typeof onlyInserted } }).UsernodeAutoGrow = {
    fit: fitToContent,
    onlyInserted,
  };
}
