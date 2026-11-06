/**
 * Mobile browsers collapse their toolbars when the document scrolls. The
 * native/installed shell and viewport-bound surfaces (app frames and chats)
 * keep their element scrollers. Only <html> is written here (and <body>'s
 * offset, to undo a stranded pan); React continues to own the screen roots. Controllers use PlatformUI.scrollElement() when
 * reading or restoring a page's position.
 */
export const MOBILE_PAGE_QUERY = '(max-width: 767px), (hover: none) and (pointer: coarse)';
export const INSTALLED_QUERY = '(display-mode: standalone), (display-mode: fullscreen)';

/**
 * One MediaQueryList per query per window, reused. `sync()` runs after every
 * batch of DOM mutations anywhere in the document (a streamed reply, a list
 * repaint) and asked `matchMedia` for two fresh lists each time, which the
 * engine parses and evaluates anew. A list's `matches` is live, so the one
 * made first answers every later read.
 */
const queryLists = new WeakMap<Window, Map<string, MediaQueryList>>();
export function mediaQuery(win: Window, query: string): MediaQueryList {
  let lists = queryLists.get(win);
  if (!lists) {
    lists = new Map();
    queryLists.set(win, lists);
  }
  let list = lists.get(query);
  if (!list) {
    list = win.matchMedia(query);
    lists.set(query, list);
  }
  return list;
}

const AUTH_PAGES = [
  'auth-login-screen', 'auth-register-screen', 'auth-waiting-screen',
  'auth-waitlist-screen', 'auth-more-screen', 'auth-landing-screen',
];
const PAGES = ['home-screen', 'leaderboard-screen', 'profile-screen', 'settings-screen'];

export function pageScroller(doc: Document, preferred?: string | null): HTMLElement | null {
  const visible = (id: string) => {
    const el = doc.getElementById(id);
    return el && !el.classList.contains('hidden') ? el : null;
  };
  for (const id of AUTH_PAGES) {
    const root = visible(id);
    if (!root) continue;
    if (id !== 'auth-landing-screen') return root;
    // The guest app viewer shares the landing root but needs a bounded frame.
    return visible('auth-landing-scroll');
  }
  // A zoom transition can temporarily paint both the incoming and outgoing
  // roots. The router's revealed screen is authoritative during that overlap.
  if (preferred && PAGES.includes(preferred) && visible(preferred)) return visible(preferred);
  const appView = visible('app-view');
  if (appView) {
    return appView.dataset.appSurface === 'platform' && visible('app-content')
      ? visible('dev-forum-scroll') : null;
  }
  for (const id of PAGES) if (visible(id)) return visible(id);
  return null;
}

export function allowsPageScroll(win: Window, doc: Document): boolean {
  return win.self === win.top
    && mediaQuery(win, MOBILE_PAGE_QUERY).matches
    && !mediaQuery(win, INSTALLED_QUERY).matches
    && !(win.navigator as Navigator & { standalone?: boolean }).standalone
    && !doc.documentElement.classList.contains('in-native-webview');
}

// The kit's own threshold for "a keyboard is up" (native.js KB_MIN_INSET):
// no real keyboard is shorter, and URL-bar transients are.
const KEYBOARD_MIN = 50;

// Input types that never raise a keyboard.
const NO_KEYBOARD = /^(button|checkbox|radio|range|color|file|submit|reset|image|hidden)$/i;

/**
 * #2823: could a keyboard be up at all? Only while something that takes text
 * has focus. An iframe counts, because an app's field is focused inside it
 * and this document cannot see which. Without this, a visual viewport iOS
 * left short after the keyboard went read as "keyboard still up" for good,
 * and the pan it left behind was never put back.
 */
export function textFocused(doc: Document): boolean {
  const el = doc.activeElement as (HTMLElement & { type?: string }) | null;
  if (!el || el === doc.body || el === doc.documentElement) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'IFRAME' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && !NO_KEYBOARD.test(el.type || 'text');
}

/**
 * How far the bounded shell has been panned, by every measure iOS keeps one
 * in (#2823). #2771 read the root's offset and `scrollY`; iOS can also leave
 * <body> scrolled (it is `overflow: hidden`, which stops the user, not a
 * focus reveal) or the visual viewport sitting below the layout viewport's
 * top. Any of them lifts the fixed tab bar off the bottom edge.
 */
export function panOffset(win: Window, doc: Document): number {
  const root = (doc.scrollingElement || doc.documentElement) as HTMLElement | null;
  return Math.max(
    root?.scrollTop || 0,
    doc.body?.scrollTop || 0,
    win.scrollY || 0,
    win.visualViewport?.offsetTop || 0,
  );
}

/**
 * #2771: is the bounded shell's document left panned with nothing to justify
 * it? Installed apps and the native WebView never scroll the document —
 * html and body are 100dvh and `overflow: hidden` — but iOS pans it anyway to
 * reveal a focused field and does not always pan it back when the keyboard
 * goes. The whole shell then sits shifted up: the tab bar, fixed to that
 * viewport, rides off the bottom edge and the page's foot shows beneath it.
 *
 * Only on a phone-sized, top-level load that is NOT paging the document
 * (`active` covers that), and never while a keyboard is up or the page is
 * pinch-zoomed: those pans are the browser doing its job. A short visual
 * viewport only counts as a keyboard while a text field has focus (#2823).
 */
export function strandedPan(win: Window, doc: Document, top: number): boolean {
  if (!(top > 0) || win.self !== win.top) return false;
  if (!mediaQuery(win, MOBILE_PAGE_QUERY).matches) return false;
  if (doc.documentElement.classList.contains('un-kb')) return false;
  const vv = win.visualViewport;
  if (vv) {
    if (Math.abs(vv.scale - 1) > 0.01) return false;
    const layout = Math.max(win.innerHeight || 0, doc.documentElement.clientHeight || 0);
    if (layout - vv.height >= KEYBOARD_MIN && textFocused(doc)) return false;
  }
  return true;
}

/**
 * #3565: how far below its top the paged document must sit before its far
 * edge may bounce again, marked on <html> as `data-browser-past-top`.
 *
 * app.css turns the viewport's rubber band off (`overscroll-behavior-y:
 * none`) so neither the browser's bounce nor its own refresh can join the
 * kit's pull at the top. On <html> that holds at the bottom as well, and iOS
 * Safari tucks its toolbar away only when a drag moves the page: at the end
 * of a page nothing moved, so the bar stayed. While the mark is up, app.css
 * gives a phone's viewport `contain` instead, which bounces (and keeps
 * Chrome's own refresh off). A drag heading back up loses the mark this far
 * short of the top, more than a finger covers in the frame or two the new
 * style takes to reach the scroll view, so a pull that STARTS at the top
 * always meets `none`. A page with less than this to scroll is never marked.
 */
export const PAST_TOP_PX = 64;

export function createBrowserScroll(doc: Document, win: Window) {
  let active: HTMLElement | null = null;
  let lastTop = 0;
  // Written only when it changes: this runs on every document scroll.
  const markPastTop = () => {
    const html = doc.documentElement;
    const past = !!active && lastTop >= PAST_TOP_PX;
    if (past === (html.dataset.browserPastTop !== undefined)) return;
    if (past) html.dataset.browserPastTop = '';
    else delete html.dataset.browserPastTop;
  };
  const positions = new Map<string, number>();
  const originalRestoration = win.history?.scrollRestoration;
  const root = () => (doc.scrollingElement || doc.documentElement) as HTMLElement;
  const preferred = () => (win as Window & { App?: { _revealedScreen?: string } }).App?._revealedScreen;
  const remember = () => {
    // Dev owns per-app feed memory and restores it after the feed loads.
    if (active && active.id !== 'dev-forum-scroll') positions.set(active.id, lastTop);
  };
  const capture = () => {
    if (!active) return;
    lastTop = root().scrollTop;
    remember();
    markPastTop();
  };
  const sync = () => {
    const enabled = allowsPageScroll(win, doc);
    // Hash routes share a document. Browser history restoration otherwise
    // races the per-screen positions when Back also triggers a transition.
    // Written only when it differs: this runs after every DOM mutation.
    if (win.history && originalRestoration) {
      const restoration = enabled ? 'manual' : originalRestoration;
      if (win.history.scrollRestoration !== restoration) win.history.scrollRestoration = restoration;
    }
    const next = enabled ? pageScroller(doc, preferred()) : null;
    if (next === active) return;
    const previous = active;
    // lastTop survives layout clamping when a route hides the outgoing page.
    remember();
    const previousTop = lastTop;
    const top = next ? (positions.get(next.id) ?? next.scrollTop) : 0;
    active = next;
    if (next) doc.documentElement.dataset.browserScroller = next.id;
    else delete doc.documentElement.dataset.browserScroller;
    if (previous) previous.scrollTop = previousTop;
    root().scrollTop = top;
    lastTop = root().scrollTop;
    // A restored offset fires no scroll event when it lands where the last
    // page left the document, and leaving the paged layout fires none at all.
    markPastTop();
    // Notify effects which also follow the page when the offset stays at 0.
    win.dispatchEvent(new Event('usernode:page-scroll'));
  };
  // Put a stranded pan back (#2771, #2823). `scrollTo` as well as the root's
  // offset because iOS keeps the pan on the window, and <body> as well
  // because a focus reveal can scroll it past its `overflow: hidden`.
  const settle = () => {
    if (active || !strandedPan(win, doc, panOffset(win, doc))) return;
    root().scrollTop = 0;
    if (doc.body && doc.body.scrollTop) doc.body.scrollTop = 0;
    win.scrollTo?.(0, 0);
  };
  return {
    capture,
    sync,
    settle,
    scrollElement(el: HTMLElement | null) {
      // Callers can restore immediately after a synchronous screen render,
      // before the MutationObserver has received the visibility change.
      sync();
      return el && el === active ? root() : el;
    },
    onScroll(event: Event) {
      if (event.target === doc && !active) settle();
      else if (event.target === doc && active === pageScroller(doc, preferred())) capture();
      else if (!active && event.target === pageScroller(doc, preferred())) {
        const el = event.target as HTMLElement;
        positions.set(el.id, el.scrollTop);
      }
    },
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const controller = createBrowserScroll(document, window);
  (window as Window & { UsernodeBrowserScroll?: typeof controller }).UsernodeBrowserScroll = controller;
  // Observe the visibility seam after React applies it, including the landing
  // app viewer and Dev sub-views which change without a top-level route swap.
  new MutationObserver(controller.sync).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'data-app-surface'],
  });
  document.addEventListener('scroll', controller.onScroll, { capture: true, passive: true });
  window.addEventListener('resize', controller.sync);
  mediaQuery(window, INSTALLED_QUERY).addEventListener('change', controller.sync);
  // The keyboard closing is a visual-viewport resize, and it is the moment a
  // pan iOS left behind stops being justified. A frame later, so the kit's
  // own tracker has dropped `un-kb` by then. Blur covers a keyboard that
  // closes without resizing anything this page can see.
  const settleSoon = () => requestAnimationFrame(controller.settle);
  window.visualViewport?.addEventListener('resize', settleSoon, { passive: true });
  document.addEventListener('focusout', () => setTimeout(controller.settle, 350));
  // #2823: the pan does not always arrive with one of the three moments
  // above. A visual-viewport pan fires no document scroll; a rubber-band
  // drag ends in a touchend; and an installed app resumed from the
  // background, rotated, or moved to another tab is a fresh chance to find
  // the bar off the edge. Each is a few reads when nothing is stranded.
  const settleLater = () => setTimeout(controller.settle, 400);
  window.visualViewport?.addEventListener('scroll', settleSoon, { passive: true });
  document.addEventListener('touchend', settleLater, { passive: true });
  window.addEventListener('pageshow', settleSoon);
  window.addEventListener('orientationchange', settleLater);
  window.addEventListener('hashchange', settleSoon);
  window.addEventListener('popstate', settleSoon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') settleSoon();
  });
  controller.sync();
}
