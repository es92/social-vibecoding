/**
 * #platform-tabs — the shell's five places, as a permanent bar.
 *
 * ── What this replaces ────────────────────────────────────────────────
 *
 * Nothing, structurally: it is new markup. What it replaces is a JOB the app
 * chip's menu was doing badly. That menu holds two unlike lists — the app's
 * own options (Workshop, discussion, feedback, terminal) and the platform's
 * places (Home, Discover, Challenges, Messages, Profile, Wallet, Validator,
 * Settings, Admin) — and #1443's charter put them together on the reasoning
 * that one control should name where you are and list everywhere you can go.
 *
 * Every host this shell is modelled on splits those two lists. WeChat,
 * Telegram, Discord, Slack and Teams all give a mini-app a flat menu of its
 * own options behind one button, AND keep a permanent bar of the host's
 * sections underneath; the menu's deeper rows link OUT to those sections,
 * filtered to the app you were in. This shell had the menu and no bar, so
 * there was nowhere to link out TO, and the platform's places sat in the
 * app's menu because there was no other list to put them in.
 *
 * This is that bar. The chip's menu becomes the app's menu in the same
 * change (see ../header/), and the rows that move here leave it.
 *
 * ── Why it is fixed, and not the last flex item in the body column ────
 *
 * The body is a 100dvh flex column, so a `flex: none` child at its end would
 * pin to the bottom of the screen — on the routes where that column is the
 * scroller. `html[data-browser-scroller]` is the routes where it is not: the
 * DOCUMENT scrolls there so browser toolbars can follow it (#1518), body
 * height goes `auto`, and a flex child at the end scrolls away with the page.
 * A tab bar that leaves the screen when you scroll is not a tab bar.
 *
 * So it is `position: fixed`, which is what public/css/app.css's
 * `.dev-ws-tabs` settled on for the same reason after `sticky` failed on a
 * real iOS PWA three times. Nothing in this element's ancestor chain
 * establishes a containing block — it is a direct child of <body>, above the
 * dialogs and outside every `backdrop-filter` wrapper in the shell — so it
 * needs no portal the way the Workshop's bar does.
 *
 * The space it covers is reserved in CSS, keyed off this element's own
 * `hidden` class (`body:has(#platform-tabs:not(.hidden))`), so the screens
 * reserve it exactly when it is there and nothing has to publish a second
 * fact for them to read. app.css carries that arithmetic and the reasoning.
 *
 * ── The two facts it reads, from two different stores ─────────────────
 *
 * WHETHER the bar is there comes from ../../lib/visibility-store.ts, with
 * the rest of the shell's chrome: `App.setChromeless()` and
 * `App._showOnlyScreen()` publish it, and it may be published BEFORE this
 * bundle has evaluated (public/js/app.js is a classic script and the React
 * entry is a deferred module), which the visibility store is the one that
 * survives.
 *
 * WHICH TAB is lit comes from ./nav-store.js through the bridge, like the
 * header title and the back button beside it, and so does WHOSE NAME the
 * fifth tab carries (#2760). Nothing writes either before hydration, so both
 * can be rendered directly.
 *
 * The visibility lands as `useHiddenClass` rather than a rendered
 * `className`, for the reason ../header/platform-header.tsx gives: this is
 * chrome, `PlatformUI` writes classes onto the shell's bars at runtime, and
 * a React-rendered class attribute would drop whatever the kit put there on
 * the next render. The class string below is a constant prop.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  BoardIcon,
  ChatIcon,
  HomeIcon,
  SearchIcon,
  UserIcon,
} from '@/components/ui/icons';

import { useClassToggle, useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { navStore } from './nav-store.js';
import { clearPeekTimer, enterPeek, leavePeek } from './rail-peek';
import { RecentsList } from './recents-list';

/**
 * The five tabs, in order.
 *
 * WHY THESE FIVE, and why in this order: the bar reads left to right as
 * distance from you. Home is the launcher, Discover is everyone else's apps,
 * Messages and Workshop are the two things that can be WAITING for you (the
 * conversation and the change), and Me is your own account. Challenges,
 * Settings, Wallet, Validator and Admin are all reached from Me, which is
 * why five is enough — a sixth tab would be a section nobody visits daily.
 *
 * Discover keeps the magnifier rather than taking a grid glyph: it is the
 * same row the app menu spelled `#switcher-row-discover` with a
 * <SearchIcon/>, and moving a destination should not also rename its glyph.
 */
const TABS = [
  {
    key: 'home' as const,
    label: 'Home',
    // A REAL PATH, not a fragment, and that is deliberate: Home is the only
    // one of the five that is a document address rather than a hash route,
    // so a cmd-click on it opens the launcher in a new tab the way the app
    // menu's Home row already does. The click handler below is what makes a
    // PLAIN click stay in this document.
    href: '/',
    Icon: HomeIcon,
  },
  { key: 'discover' as const, label: 'Discover', href: '#apps', Icon: SearchIcon },
  { key: 'messages' as const, label: 'Messages', href: '#messages', Icon: ChatIcon },
  { key: 'workshop' as const, label: 'Workshop', href: '#workshop', Icon: BoardIcon },
  // "Me" is the label only until somebody is signed in: from then on this tab
  // is named after them (#2760) — see tabLabel below.
  { key: 'me' as const, label: 'Me', href: '#profile', Icon: UserIcon },
];

/**
 * What a tab says, and what it is called (#2760).
 *
 * The fifth tab is the reader's own account, and "Me" was a word standing in
 * for a name the shell already has. So once somebody is signed in it carries
 * their USERNAME, on the phone's bar and the desktop rail alike — the owner
 * asked for both — the way the account row at the foot of Slack's, Discord's
 * and Linear's sidebars names you rather than a pronoun.
 *
 * "Me" STAYS THE PRERENDER. The document is built in Node with no session, so
 * the shipped markup can only say "Me", and a first client render that said
 * anything else would be React #418 on every route. `viewer` is null in the
 * nav store's INITIAL and is published from App.enterAuthed, which runs after
 * hydration, so the name arrives as an update — exactly how the lit tab does.
 *
 * THE ACCESSIBLE NAME KEEPS SAYING WHAT THE TAB IS. A bare username among
 * Home, Discover, Messages and Workshop would be read out as a person rather
 * than a place, so the label names both, and it starts with the visible text
 * so a voice command that says what is on screen still finds it. Long names
 * are cut by app.css with an ellipsis; usernames are at most 32 characters
 * and never contain a space, so a clipped one is still recognisably yours.
 */
export function tabLabel(
  key: string,
  label: string,
  viewer: string | null,
): { text: string; ariaLabel: string | undefined } {
  if (key === 'me' && viewer) return { text: viewer, ariaLabel: `${viewer}, your profile` };
  return { text: label, ariaLabel: undefined };
}

/**
 * Home's plain click, routed in place.
 *
 * Copied in shape from `#switcher-row-home` in
 * ../app-context/app-context-sheet.tsx: let NavLink decide whether this was
 * a modified click (cmd/ctrl/middle/shift — "open it in a new tab", which
 * the href already does correctly), and otherwise stop the navigation and
 * hand it to the router. Without the guard a cmd-click both opened a tab
 * AND navigated this one.
 */
function onHomeClick(event: React.MouseEvent<HTMLAnchorElement>): void {
  const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
  if (nav?.isNativeClick?.(event)) return;
  event.preventDefault();
  // `viaTab`: a press on a tab swaps like one, even out of an app's Workshop,
  // where navigateHome otherwise shrinks the page into the app's tile (#2881).
  (window as unknown as { App?: { navigateHome?: (opts?: { viaTab?: boolean }) => void } })
    .App?.navigateHome?.({ viaTab: true });
}

/**
 * The Workshop tab's plain click: back to the app Workshop you left (#2776).
 *
 * The router decides (App.resumeWorkshopView, public/js/app.js): when this
 * device remembers an app's Workshop view and you are not already in one, it
 * takes you there and says so, and the href's navigation is stopped. Every
 * other time — nothing remembered, or already inside an app's Workshop,
 * where the tab pops to the selector as it always did — it answers false and
 * the href does exactly what it did before. A modified click is left alone,
 * as Home's is.
 */
function onWorkshopClick(event: React.MouseEvent<HTMLAnchorElement>): void {
  const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
  if (nav?.isNativeClick?.(event)) return;
  const app = (window as unknown as { App?: { resumeWorkshopView?: () => boolean } }).App;
  if (app?.resumeWorkshopView?.()) event.preventDefault();
}

/**
 * The Messages tab's count — ALWAYS IN THE MARKUP, hidden until it has one.
 *
 * It renders unconditionally for the reason #notifications-badge in the
 * header does: the element is part of the shell's structural inventory
 * (tests/baselines/shell-markup.json), and an id that appears only once some
 * data has arrived is an id no declared check can select on a cold document.
 * The `hidden` class is therefore a CONSTANT in the class string — React
 * writes the attribute once at hydration and never again — and the toggle
 * goes through useHiddenClass, the same seam the shell uses everywhere a
 * class has to change without React owning it.
 *
 * The TEXT is React's, and it is empty at zero, so the prerender and the
 * first client render agree on an empty hidden span.
 */
function TabBadge({ count }: { count: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useHiddenClass(ref, count <= 0);
  return (
    <span
      ref={ref}
      id="platform-tabs-badge"
      className="platform-tab-badge hidden"
      aria-label="Unread conversations"
    >
      {count > 0 ? (count > 99 ? '99+' : String(count)) : ''}
    </span>
  );
}

/**
 * The rail, peeked back over an open app (#2718, desktop only).
 *
 * ── The problem, on a laptop ──────────────────────────────────────────
 *
 * An app covers the rail — "the app is the whole window" is what makes a
 * mini-app feel like a program rather than a page — and the way out is the ✕
 * in the header. That is right on a phone, where the ✕ is under your thumb.
 * On a laptop the pointer is already at the left edge half the time, and the
 * five places you might want are behind a control at the top-left corner and
 * a screen swap.
 *
 * So the rail comes BACK on hover, over the app, and going anywhere from it
 * leaves the app the way tapping a tab always does. WeChat's floating
 * capsule, a desktop OS's auto-hiding dock and Slack's own collapsed rail are
 * all the same move: the navigation is still there, it is just not spending
 * width while you are working.
 *
 * ── Why the peek is its own fact ──────────────────────────────────────
 *
 * It is NOT the bar's visibility. The router's answer is still "hidden" —
 * `App._syncPlatformTabs` said so, the screens reserve no band, and the app
 * is full width. The peek is a temporary overlay ON TOP of that answer, which
 * is why it is a separate field and why the CSS that reserves the band
 * excludes a peeking bar explicitly: a rail that reserved 224px on the way in
 * would reflow the app under the pointer.
 *
 * ── The grace period, and what it is for ──────────────────────────────
 *
 * The pointer has to cross a gap to get from the hot zone onto the rail, and
 * on the way back out it crosses the same gap. ./rail-peek.ts holds the delay
 * that covers it — as module state now, because #sidebar-toggle is a second
 * way in (#2764) and the toggle's leave and this bar's enter must share one
 * timer. It is cancelled on unmount so a screen swap cannot land a timer on a
 * bar that has since become the real one.
 */
function useRailPeek(peek: boolean) {
  useEffect(() => clearPeekTimer, []);
  return { enter: enterPeek, leave: peek ? leavePeek : clearPeekTimer };
}

/**
 * The lit tab's marker on the phone's bar (#2824): a blue pill behind the
 * tab you are on that SLIDES to the next one, borrowed from the Workshop's
 * own tab strip (`useTabMarker` in ../dev-board/workshop/workshop.tsx, and
 * `.dev-ws-tab-marker` in app.css). Colour alone was the only mark the bar
 * had, and at 11px on a phone that is easy to miss.
 *
 * THE SAME THREE RULES as the Workshop's, for the same reasons:
 *   - `null` until the first measurement, so the prerender and the first
 *     client render agree on a bare, unstyled span (nothing is lit until the
 *     router has spoken — see the hydration test in tests/nav-tab-bar.test.js);
 *   - only a SELECTION CHANGE slides. The first placement, and a re-measure
 *     of the tab you are already on (a rotation, the bar coming back from
 *     hidden, a desktop window narrowed to a phone), land instantly;
 *   - unchanged geometry keeps the previous box, so the ResizeObserver's
 *     delivery on `observe()` cannot cancel a slide that is still running.
 *
 * One addition: with nothing lit (the tab is `null`) the box goes back to
 * null and the marker hides, so the next tab to light lands rather than
 * sliding in from wherever the last one was.
 *
 * The box is an INSET of the lit tab, not the tab itself: the tab is the
 * full 56px cell edge to edge, and a fill that met its neighbour's would read
 * as the bar being split into panels. The desktop rail does not use it at
 * all — its rows already carry a `--brand-tint` fill of their own, and
 * app.css hides the marker there.
 */
interface TabMarkerBox {
  x: number;
  y: number;
  w: number;
  h: number;
  slide: boolean;
}

const MARKER_INSET = 4;

export function markerBoxFor(
  el: { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number },
): Omit<TabMarkerBox, 'slide'> | null {
  // A bar that is not laid out (hidden, or the keyboard is up) has nothing to
  // say about where the tab is; keep the last box rather than collapse it.
  if (!(el.offsetWidth > 0) || !(el.offsetHeight > 0)) return null;
  return {
    x: el.offsetLeft + MARKER_INSET,
    y: el.offsetTop + MARKER_INSET,
    w: Math.max(0, el.offsetWidth - MARKER_INSET * 2),
    h: Math.max(0, el.offsetHeight - MARKER_INSET * 2),
  };
}

/**
 * Run `fn` once the NEXT frame has been produced — two animation frames out,
 * not one (#3046). Returns a cancel.
 *
 * WHY THE SLIDE WAITS A FRAME. A tab press is a screen swap, and on the phone
 * the swap is synchronous (PlatformUI.phoneMotion makes every push/pop
 * 'none'): the router reveals the incoming screen in the same task that
 * lights the tab. So the first frame after the press is the EXPENSIVE one —
 * style, layout and paint of a whole screen that was `hidden` a moment ago.
 * A CSS transition's clock starts at the frame its style change is resolved
 * in, so a marker written in that frame had already spent the heavy frame's
 * duration by the time anything was painted, and on this curve (a steep
 * ease-out: two-thirds of the travel in the first third of the time) that is
 * most of the slide. What showed was the pill appearing half-way across and
 * settling — "missing the first half of the animation". The Workshop's own
 * strip runs the same hook on the same curve and looked right, because
 * switching ITS tab swaps no screen.
 *
 * One `requestAnimationFrame` is not enough: it fires at the START of that
 * heavy frame, before its style and layout, so a write there still lands in
 * it. The second fires once it has been produced. The label colour still
 * changes with the press (it keys off `aria-current`); only the pill's start
 * is held, by one frame nobody saw anyway.
 *
 * Without rAF (a test environment) it runs at once.
 */
export function afterNextFrame(
  fn: () => void,
  raf: ((cb: () => void) => number) | undefined
    = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined,
  caf: ((id: number) => void) | undefined
    = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined,
): () => void {
  if (!raf) {
    fn();
    return () => {};
  }
  let id = raf(() => {
    id = raf(() => {
      id = 0;
      fn();
    });
  });
  return () => {
    if (id && caf) caf(id);
    id = 0;
  };
}

function useTabMarker(
  barRef: React.RefObject<HTMLElement | null>,
  tab: string | null,
): TabMarkerBox | null {
  const [box, setBox] = useState<TabMarkerBox | null>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    if (!tab) {
      setBox(null);
      return;
    }
    // A slide waiting for the swap's frame to be painted (see afterNextFrame).
    let cancelSlide: (() => void) | null = null;
    const measure = (selectionChanged: boolean) => {
      const el = bar.querySelector<HTMLElement>('.platform-tab[aria-current="page"]');
      if (!el) return;
      const next = markerBoxFor(el);
      if (!next) return;
      setBox((prev) => {
        if (prev && prev.x === next.x && prev.y === next.y
          && prev.w === next.w && prev.h === next.h) return prev;
        return { ...next, slide: !!prev && selectionChanged };
      });
    };
    // This run is the tab having changed; the observer's are layout moving.
    // The first placement lands now; a move from a tab already marked waits
    // out the screen swap's frame and then slides, re-measuring then so it
    // goes where the tab IS rather than where it was a frame ago.
    const hadBox = bar.querySelector('.platform-tabs-marker[data-marker-at]') !== null;
    if (hadBox) {
      cancelSlide = afterNextFrame(() => {
        cancelSlide = null;
        measure(true);
      });
    } else {
      measure(true);
    }
    if (typeof ResizeObserver === 'undefined') return () => cancelSlide?.();
    // The observer delivers once on observe(); while a slide is pending that
    // delivery must not land the marker at the new tab without it (the
    // pending slide re-measures anyway), so it waits for the slide too.
    const ro = new ResizeObserver(() => { if (!cancelSlide) measure(false); });
    ro.observe(bar);
    return () => {
      ro.disconnect();
      cancelSlide?.();
    };
  }, [barRef, tab]);
  return box;
}

export function PlatformTabs() {
  const barRef = useRef<HTMLElement | null>(null);
  // `true` is what the prerendered document ships: the bar is present and
  // visible, and the routes that hide it (an app, chromeless, the signed-out
  // shell) publish `false` once the router has run.
  const visible = useVisibility('platform-tabs', true);
  const { tab, messages, screen, peek, peekOut, railOpen, viewer } = useStoreState(navStore);
  // TWO WAYS TO HAVE NO RAIL, and they are not the same fact. The ROUTE can
  // say there is none (an app, chromeless, signed out) and the VIEWER can
  // fold the one there is (../header/../nav/sidebar-toggle.tsx). The peek
  // brings it back over either.
  const collapsed = !visible || !railOpen;
  // A peek un-hides the bar without the router having changed its mind, so
  // the class it renders is the OR of the two and the overlay treatment is a
  // second class app.css keys the peeking case off.
  useHiddenClass(barRef, !visible && !peek);
  // …AND THE ROUTE'S OWN ANSWER RIDES BESIDE IT, because `hidden` alone can
  // no longer carry it. app.css decides whether the header's sidebar toggle
  // exists from `#platform-tabs:not(.hidden)`, and a peek over a running app
  // takes `hidden` off: pointing at the window's edge inside an app drew the
  // toggle into the app's strip, shoved ✕, the tile and the name 34px right,
  // and a press on it folded the docked rail behind the app. A rail that only
  // the peek is showing is not the route's, so there is nothing to fold.
  useClassToggle(barRef, 'platform-tabs-route-hidden', !visible);
  useClassToggle(barRef, 'platform-tabs-peek', collapsed && peek);
  // THE FADE OUT (#2795). The peek stays up for the length of the fade and
  // this class is what app.css turns into it; ./rail-peek.ts times both.
  useClassToggle(barRef, 'platform-tabs-peek-out', collapsed && peek && peekOut);
  // FOLDED IS A CLASS, NOT A `hidden`, and that is the whole safety of it: a
  // phone's bar is at the FOOT of the screen and is the only navigation there
  // is, so folding must never reach it. app.css acts on this class inside
  // `@media (min-width: 768px)` and nowhere else, which means a desktop
  // window narrowed to a phone gets its bar back without this store having to
  // watch the viewport.
  useClassToggle(barRef, 'platform-tabs-folded', !railOpen);
  const { enter, leave } = useRailPeek(peek);
  const marker = useTabMarker(barRef, tab);

  return (
    <>
      {/*
          THE HOT ZONE. A strip at the window's left edge, and the only thing
          that can start a peek. It renders wherever there is no rail to point
          at — inside an app, or with the rail folded by hand — and app.css
          hides it below the desktop breakpoint, because a phone has no
          pointer to hover with and a hidden touch target at the screen edge
          would eat swipes.

          NOT `collapsed`, and not a bare `screen === 'app-view'` either.
          `collapsed` is also true on the chromeless and signed-out shells,
          where there is no rail behind the edge to bring back and a strip
          that peeked one in would be conjuring navigation out of nothing.
          And the app view is TWO screens now (#2718 review): on its Workshop
          the rail is UP, and this strip is `z-index: 39` against the rail's
          30 — an invisible 18px column down the left edge of the tabs,
          swallowing the press meant for the one under the pointer.

          So: the app view WITH ITS RAIL DOWN, which is the running app, or a
          rail the viewer folded anywhere. A folded rail is the running app's
          arrangement reached another way and the way back has to be the same
          one, or the toggle is a door that only opens; `!railOpen` implies a
          rail existed, because the toggle renders only where one does.
      */}
      {(screen === 'app-view' && !visible) || !railOpen ? (
        <div
          id="platform-rail-peek"
          className="platform-rail-peek"
          aria-hidden="true"
          onMouseEnter={enter}
          onMouseLeave={leave}
        />
      ) : null}
      <nav
        ref={barRef}
        id="platform-tabs"
        className="platform-tabs"
        aria-label="Sections"
        onMouseEnter={enter}
        onMouseLeave={leave}
      >
      {/*
          THE LIT TAB'S MARKER (#2824). Before the tabs so it paints behind
          them (app.css raises each tab one step), `aria-hidden` because
          `aria-current` already says which tab is lit, and bare until
          measured — see useTabMarker. `data-marker-at` is what makes it
          visible; `data-marker-slide` is what app.css hangs the slide on.
      */}
      <span
        className="platform-tabs-marker"
        aria-hidden="true"
        {...(marker ? { 'data-marker-at': '' } : {})}
        {...(marker && marker.slide ? { 'data-marker-slide': '' } : {})}
        style={marker ? {
          transform: `translate(${marker.x}px, ${marker.y}px)`,
          width: `${marker.w}px`,
          height: `${marker.h}px`,
        } : undefined}
      />
      {TABS.flatMap(({ key, label, href, Icon }) => [
        // RECENTS SIT BETWEEN THE SECTIONS AND YOU (#2802): after Workshop,
        // before Me at the rail's foot, which is where the Resume strip it
        // replaces sat. Desktop only; app.css keeps it off the phone's bar.
        key === 'me' ? <RecentsList key="recents" /> : null,
        <a
          key={key}
          id={`platform-tab-${key}`}
          className="platform-tab"
          href={href}
          data-tab={key}
          // `aria-current="page"` and nothing else marks the active tab:
          // it is what a screen reader announces and what the declared
          // checks select on, and it costs no second attribute to keep in
          // step with. The colour comes from app.css keying off it.
          aria-current={tab === key ? 'page' : undefined}
          aria-label={tabLabel(key, label, viewer).ariaLabel}
          onClick={key === 'home' ? onHomeClick : key === 'workshop' ? onWorkshopClick : undefined}
        >
          <span className="platform-tab-mark">
            <Icon className="platform-tab-glyph" aria-hidden="true" />
            {/*
                THE SECOND BADGE IN THE SHELL, and the first one that is not
                the bell's. #1443 argued the platform should carry exactly
                one count, on #notifications-badge, on the grounds that an
                unread message IS a notification and a menu is where you say
                where you are going, not where you learn something happened.
                That argument holds for a MENU ROW. A tab is a place you can
                see without opening anything, and a bar whose Messages tab
                cannot say "there is something here" makes the bell the only
                way to find out — which puts a conversation behind the same
                sheet the bar exists to get things out of.

                It counts CONVERSATIONS with something unread, not messages,
                because the number has to mean "how many things to open".
                Rendered only above zero, so the prerender (INITIAL is 0)
                and the first client render agree with no badge at all.

                AND IT IS THE QUIET ONE (#2912). Unread messages are counted
                in the bell too, so this one is grey rather than the bell's
                red: on the phone's bar a grey disc on the glyph's corner, on
                the desktop rail a grey pill at the row's far end. It stays
                HERE in the markup for both; app.css moves it on the rail by
                dissolving this wrapper, so the phone keeps its anchor and a
                declared check keeps finding it inside the Messages tab.
            */}
            {key === 'messages' ? <TabBadge count={messages} /> : null}
          </span>
          <span className="platform-tab-label">{tabLabel(key, label, viewer).text}</span>
        </a>,
      ])}
      </nav>
    </>
  );
}
