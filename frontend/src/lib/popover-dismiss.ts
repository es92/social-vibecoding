import { useEffect, useRef, type RefObject } from 'react';

/**
 * Taking down a small popover anchored to the button that opened it — the
 * vote picker's desktop home (features/dev-board/card/dev-card.tsx) and
 * Messages' "+" (#2778).
 *
 * Where such a popover GOES is ./anchor-popover.ts (`placeUnderAnchor`);
 * this is the other half, what makes it go away, which the vote picker
 * carried inline. What each popover shows stays its own.
 */

import type { AnchorRect } from './anchor-popover';
import { nearAny } from './dismiss-edge';

/** The part of a DOMRect `placeUnderAnchor` places from. */
export function anchorRectOf(el: Element): AnchorRect {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, right: r.right };
}

/**
 * How far the anchor may drift before a scroll counts as having moved it. A
 * focus nudge or a list re-laying itself out under a sticky header is a
 * pixel or two; a real scroll is far more, and it is measured against where
 * the anchor was at opening, so a slow trackpad scroll still adds up.
 */
export const ANCHOR_SCROLL_SLOP = 4;

/**
 * While `open`, close on a click outside every element in `inside` (the
 * anchor and the panel), on Escape, on a resize, and on a scroll that MOVED
 * THE ANCHOR — a fixed panel placed from a rect is wrong the moment that rect
 * moves.
 *
 * `inside[0]` is the anchor. It used to be any scroll at all, anywhere
 * (QA 2026-09-24 Q18): Messages' "+" sits above the inbox list, and the list
 * scrolling underneath it (a row arriving, focus moving into the menu) shut
 * the menu while the button it hangs from had not moved a pixel. A scroll
 * inside the panel itself never closes it.
 *
 * Escape hands focus back to the anchor when it was inside the panel, so a
 * keyboard user is not dropped at the top of the document.
 *
 * The click listener is on the CAPTURE phase so a click that something else
 * stops still closes the panel. `close` is read through a ref: the effect
 * binds once per opening, and the caller's function may change identity on
 * every render in between.
 */
export function useAnchoredDismiss(
  open: boolean,
  inside: ReadonlyArray<RefObject<HTMLElement | null>>,
  close: () => void,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const insideRef = useRef(inside);
  insideRef.current = inside;
  useEffect(() => {
    if (!open) return undefined;
    const shut = () => closeRef.current();
    const within = (t: EventTarget | null) => !!t && (t as Node).nodeType === 1
      && insideRef.current.some((ref) => ref.current?.contains(t as Node));
    const nearInside = (x: number, y: number) =>
      nearAny(x, y, insideRef.current.map((ref) => ref.current));
    // Where the press that led to a click began. A click on the dimmed area
    // after a press inside the panel (a drag, a selection) must not close it;
    // neither must a press or a click within a finger's width of the panel's
    // edge (#6475).
    let pressedOutside: boolean | null = null;
    const onPointerDown = (ev: PointerEvent) => {
      pressedOutside = !within(ev.target) && !nearInside(ev.clientX, ev.clientY);
    };
    const anchorAt = () => insideRef.current[0]?.current?.getBoundingClientRect() || null;
    const start = anchorAt();
    const onDoc = (ev: Event) => {
      const startedOutside = pressedOutside;
      pressedOutside = null;
      if (within(ev.target)) return;
      // A press that began inside (or at the edge of) the anchor and panel is
      // not an outside press, however the click landed.
      if (startedOutside === false) return;
      const me = ev as MouseEvent;
      if (nearInside(me.clientX, me.clientY)) return;
      shut();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      const refocus = within(document.activeElement);
      shut();
      if (refocus) insideRef.current[0]?.current?.focus({ preventScroll: true });
    };
    const onScroll = (ev: Event) => {
      if (within(ev.target)) return;
      const now = anchorAt();
      if (start && now && Math.abs(now.top - start.top) <= ANCHOR_SCROLL_SLOP
        && Math.abs(now.left - start.left) <= ANCHOR_SCROLL_SLOP) return;
      shut();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('click', onDoc, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', shut);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('click', onDoc, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', shut);
    };
  }, [open]);
}
