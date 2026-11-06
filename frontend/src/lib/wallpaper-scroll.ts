/**
 * THE STAR RIDES THE PAGE; THE WASHES DO NOT.
 *
 * The home wallpaper (see "The home ground" in public/css/app.css) is the
 * body's background in the bounded shell, where each screen root is its
 * own scroller. On mobile web it is a fixed body::before layer while the
 * document scrolls. In both cases the wallpaper stays viewport-sized. That is
 * right for the washes, which are ambient, and wrong for the star, which
 * the design places on the PAGE: it should slide away under the bar with
 * the tiles and come back when the page does.
 *
 * Moving the star into the scrollers would put it below the bar, since a
 * scroller starts where the bar ends and clips its overflow, and the bar
 * band is exactly where the design puts it (behind the bell, cropped by
 * the top edge). So the star stays a wallpaper layer and follows the
 * visible screen's scroll offset instead: its vertical position in the
 * shorthand is `var(--home-star-y, 0px)`, and this module writes that
 * property on <html> from the scroller that is showing. The write happens
 * inside the scroll event itself (not deferred to a frame), so the star
 * paints with the content that moved it; rAF is used only when the visible
 * screen changes, where the DOM has not settled yet.
 *
 * "At rest" is not scrollTop 0 on the launcher: Home._searchReveal parks
 * its scroller at the pulled-down search bar's height, so the offset is
 * measured from there — pulling the bar into view moves the star down with
 * the rest of the page, as it should.
 *
 * The app view has no scroller of its own (the app scrolls inside its
 * frame), so in an app the star sits at rest; the same for any route that
 * paints no wallpaper, where the property is simply unread.
 */
import { getVisibilityStore } from './visibility-store';

export const STAR_Y_PROP = '--home-star-y';

/**
 * The star's height in px — the `97px 78px` in its layer in app.css
 * (tests/wallpaper-scroll.test.js pins the two together).
 *
 * THE OFFSET STOPS AT MINUS THIS. The property is written on <html> and the
 * wallpaper shorthand that reads it is inherited, so every write restyles the
 * whole document and repaints the body's background: about 9ms of style work
 * per frame, measured scrolling Settings in an emulated iPhone viewport, on
 * every frame of every scroll of these screens. Once the star has slid fully
 * above the top edge it is out of sight wherever it is, so the value clamps
 * there and scrolling further writes nothing. The star looks exactly as it
 * did; only the first ~80px of a scroll still pay.
 */
export const STAR_HEIGHT_PX = 78;

/** Wallpaper roots → the element that scrolls for them. The landing shell
 *  is a fixed overlay above everything else, so it is checked first. */
export const SCROLLER_OF: ReadonlyArray<readonly [root: string, scroller: string]> = [
  ['auth-landing-screen', 'auth-landing-scroll'],
  ['home-screen', 'home-screen'],
  ['leaderboard-screen', 'leaderboard-screen'],
  ['profile-screen', 'profile-screen'],
  ['settings-screen', 'settings-screen'],
];

const SCROLLER_IDS = new Set(SCROLLER_OF.map(([, scroller]) => scroller));

type DocLike = EventTarget & Pick<Document, 'getElementById'> & {
  documentElement: {
    style: Pick<CSSStyleDeclaration, 'setProperty'>;
    dataset?: DOMStringMap;
  };
  scrollingElement?: Pick<Element, 'scrollTop'> | null;
};
type WinLike = Pick<Window, 'addEventListener' | 'requestAnimationFrame'>;

/**
 * The scroll position a root reads as "not scrolled": Home's parks its
 * search bar, on a phone only (#17; features/home/home.js
 * `_searchReveal.tucks`, the same question asked the same way).
 */
export function restTop(doc: DocLike, rootId: string): number {
  if (rootId !== 'home-screen') return 0;
  const ui = typeof window === 'undefined' ? undefined
    : (window as unknown as { PlatformUI?: { isPhoneLayout?: () => boolean } }).PlatformUI;
  if (ui?.isPhoneLayout?.() === false) return 0;
  const bar = doc.getElementById('home-search-bar');
  return (bar && (bar as HTMLElement).offsetHeight) || 0;
}

/** The wallpaper root that is showing, if any. */
export function visibleRoot(doc: DocLike): { root: string; scroller: string } | null {
  for (const [root, scroller] of SCROLLER_OF) {
    const el = doc.getElementById(root);
    if (el && !el.classList.contains('hidden')) return { root, scroller };
  }
  return null;
}

/** The star's vertical offset, in px, for the document's current state. */
export function starY(doc: DocLike): number {
  const showing = visibleRoot(doc);
  if (!showing) return 0;
  const scroller = doc.documentElement.dataset?.browserScroller === showing.scroller
    ? doc.scrollingElement : doc.getElementById(showing.scroller);
  if (!scroller) return 0;
  return Math.max(-STAR_HEIGHT_PX, -Math.round(scroller.scrollTop - restTop(doc, showing.root)));
}

export function initWallpaperScroll(doc: DocLike, win: WinLike): () => void {
  let last: number | null = null;
  let queued = false;
  const apply = () => {
    queued = false;
    const y = starY(doc);
    if (y === last) return;
    last = y;
    doc.documentElement.style.setProperty(STAR_Y_PROP, `${y}px`);
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(apply);
  };
  // Scroll events do not bubble, but they are observable in the capture
  // phase from the document — one listener for every scroller, including
  // ones React mounts later. Nested scrollers (the discover rail, a sheet)
  // fire the same event and are filtered out by id.
  doc.addEventListener('scroll', (event) => {
    const target = event.target as Element | null;
    if (event.target === doc || (target && target.id && SCROLLER_IDS.has(target.id))) apply();
  }, { capture: true, passive: true });
  // A screen change is published through the visibility store by both the
  // React islands and the legacy router; the hash covers the routes that
  // change scrollers without a visibility flip (the landing's sub-screens).
  getVisibilityStore().listeners.add(schedule);
  win.addEventListener('hashchange', schedule);
  win.addEventListener('usernode:page-scroll', schedule);
  schedule();
  return apply;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  initWallpaperScroll(document, window);
}
