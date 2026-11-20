/**
 * THE THREAD'S HEAD SAYS ITS TITLE, AND TIGHTENS AS THE READER SCROLLS
 * (19 Nov 2026). A request's or a change's page leads with a head card, as
 * the Homeroom bot page leads with its own: the project's tile, a small line
 * (the project, the topic, "Request #N" and where it stands) over the title
 * in two lines (app.css "THE THREAD'S HEAD IS A CARD"). It lies over the top
 * of the thread's scroller, so two things are read off it here:
 *
 *   - its height, as `--thread-head-h` on the page (`.dev-request`): the
 *     scroller starts under it, and a title of one line or two, or a window
 *     that wraps it differently, moves where that is. Read only while the
 *     head is at its full size, so the scroller's top never moves on scroll.
 *   - whether the thread has scrolled, as `data-thread-head-tight` on the
 *     page: then the head tightens to one line of title over the small line,
 *     and the cards go up behind it. Nothing in the scroller moves when it
 *     does, so tightening cannot feed back into the scroll that caused it.
 *
 * ONE LINE TO TIGHTEN, ANOTHER TO OPEN AGAIN (20 Nov 2026). The head
 * tightened past 24px and opened again under it, so a reader moving a few
 * pixels about that line (a trackpad's small steps, its bounce) watched it
 * swap back and forth. It now opens only once the thread is back within
 * 8px of its top, where the card under the full head is clear of it again.
 *
 * AND IT EASES. The head's card, tile and ⋯ ease between the two sizes
 * (app.css "THE HEAD EASES"), and its words, which move between two
 * layouts no transition can join, come up into the new one. While it
 * eases its height is in between, so it is measured once it has settled,
 * never mid-way: the scroller's top would move with every frame of it.
 *
 * Found from the head itself, never by a document-wide id: another pane can
 * hold the same page (#4640).
 */

import { useEffect, type RefObject } from 'react';

import { reducedMotion } from '../../../lib/reduced-motion';

/** How far the thread scrolls before its head tightens. */
export const HEAD_TIGHT_AFTER_PX = 24;
/** How near the top the thread comes back before its head opens again. */
export const HEAD_OPEN_BELOW_PX = 8;
/** The head's ease, app.css's 180ms. */
export const HEAD_EASE_MS = 180;

/**
 * Fit the page to `head` and follow its scroller; returns what undoes it.
 * Does nothing (and undoes nothing) when the head is not in a thread page.
 */
export function fitThreadHead(head: HTMLElement): () => void {
  const page = head.closest<HTMLElement>('.dev-request');
  const scroller = page?.querySelector<HTMLElement>(':scope > .dev-request-sheet > .dev-request-scroll') || null;
  if (!page || !scroller) return () => {};
  let tight = false;
  let waiting = false;
  let gone = false;
  const measure = () => {
    if (gone || tight) return;
    const easing = typeof head.getAnimations === 'function' ? head.getAnimations({ subtree: true }) : [];
    if (easing.length) {
      if (!waiting) {
        waiting = true;
        void Promise.allSettled(easing.map((a) => a.finished)).then(() => { waiting = false; measure(); });
      }
      return;
    }
    const h = Math.round(head.getBoundingClientRect().height);
    if (h > 0) page.style.setProperty('--thread-head-h', `${h}px`);
  };
  const onScroll = () => {
    const top = scroller.scrollTop;
    const next = tight ? top >= HEAD_OPEN_BELOW_PX : top > HEAD_TIGHT_AFTER_PX;
    if (next === tight) return;
    tight = next;
    page.toggleAttribute('data-thread-head-tight', tight);
    if (!reducedMotion()) {
      head.querySelector<HTMLElement>('.dev-thread-bar-text')?.animate?.(
        [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
        { duration: HEAD_EASE_MS, easing: 'ease-out' },
      );
    }
  };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  resize?.observe(head);
  measure();
  onScroll();
  scroller.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    gone = true;
    resize?.disconnect();
    scroller.removeEventListener('scroll', onScroll);
    page.removeAttribute('data-thread-head-tight');
    page.style.removeProperty('--thread-head-h');
  };
}

/** `on` is false where the head is not drawn (a frame look's page draws the kit's head). */
export function useThreadHeadFit(ref: RefObject<HTMLElement | null>, on: boolean): void {
  useEffect(() => {
    const head = on ? ref.current : null;
    return head ? fitThreadHead(head) : undefined;
  }, [ref, on]);
}
