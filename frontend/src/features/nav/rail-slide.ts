/**
 * THE SIDEBAR SLIDES WHEN #sidebar-toggle SHOWS OR HIDES IT (N21 of the
 * 19 Oct polish board).
 *
 * It used to be instant: the rail went, and the page under it jumped 212px
 * sideways in one frame. The layout still changes at once, in one step (the
 * screens move over by padding, app.css), and what moves is drawn on the
 * compositor afterwards: a FLIP. The screen on view is measured before and
 * after the change and played from where it was to where it is, as a
 * transform; the rail slides in from its edge, or out to it, as a transform.
 * Nothing is laid out again on any frame of it.
 *
 * Going away, the rail is still drawn for the length of its slide:
 * `platform-tabs-leaving` keeps it on screen (app.css) over the folded
 * layout, and is taken off when the slide ends.
 *
 * Not at all under `prefers-reduced-motion`, on a phone (there is no fold
 * there), on a route with no rail, or from a peek, where the rail is
 * already on screen and only docks.
 */

import { flushSync } from 'react-dom';

import { navStore } from './nav-store.js';

/** The slide's clock: short, and decelerating into place. */
export const RAIL_SLIDE: KeyframeAnimationOptions = { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/** The screens the rail's width moves over (app.css, "THE SCREENS MOVE OVER"). */
const SCREENS = '#home-screen, #browse-screen, #workshop-screen, #leaderboard-screen, #profile-screen, '
  + '#admin-screen, #settings-screen, #messages-screen, #agent-session-screen, '
  + '#profile-proposals-screen, #app-view';

/**
 * The screen on view, and the child of it that reads as its content: the
 * largest one. Its left edge is what the reader sees move (a centred column
 * moves half as far as a page that starts at the rail).
 */
function onScreen(): { root: HTMLElement; mark: Element } | null {
  for (const root of document.querySelectorAll<HTMLElement>(SCREENS)) {
    if (root.classList.contains('hidden') || !root.getClientRects().length) continue;
    let mark: Element = root;
    let area = 0;
    for (const child of root.children) {
      const box = child.getBoundingClientRect();
      if (box.width * box.height > area) {
        area = box.width * box.height;
        mark = child;
      }
    }
    return { root, mark };
  }
  return null;
}

/**
 * Run `commit` (the store change that shows or folds the rail) and slide
 * what it moved.
 */
export function slideRail(commit: () => void): void {
  // Where the rail is going: the press turns it over.
  const open = !navStore.get().railOpen;
  const bar = document.getElementById('platform-tabs');
  const still = !bar
    || typeof bar.animate !== 'function'
    || !window.matchMedia?.('(min-width: 768px)').matches
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || bar.classList.contains('hidden');
  if (still) {
    commit();
    return;
  }
  // From a peek the rail is already on screen: it docks where it is.
  const fromPeek = bar.classList.contains('platform-tabs-peek');
  const screen = onScreen();
  const before = screen ? screen.mark.getBoundingClientRect().left : null;
  if (!open && !fromPeek) bar.classList.add('platform-tabs-leaving');
  // The class the fold reads is written in a layout effect, so the new
  // layout is there to measure as soon as this returns.
  flushSync(commit);
  const leaving = () => bar.classList.remove('platform-tabs-leaving');
  if (bar.classList.contains('platform-tabs-folded') === open) {
    leaving();
    return;
  }
  const after = screen ? screen.mark.getBoundingClientRect().left : null;
  const dx = before !== null && after !== null ? Math.round(before - after) : 0;
  if (screen && dx) {
    screen.root.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], RAIL_SLIDE);
  }
  if (fromPeek) return;
  const slide = bar.animate(open
    ? [{ transform: 'translateX(-100%)' }, { transform: 'none' }]
    : [{ transform: 'none' }, { transform: 'translateX(-100%)' }], RAIL_SLIDE);
  if (!open) slide.finished.then(leaving, leaving);
}
