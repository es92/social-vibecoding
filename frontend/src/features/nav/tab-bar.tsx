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
  ChatIcon,
  CogIcon,
  CompassIcon,
  HomeIcon,
  HomeroomBotIcon,
  Squares2X2Icon,
  UserGroupIcon,
  UserIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useClassToggle, useHiddenClass } from '../../lib/legacy-dom';
import { useCommunityColor } from '../../lib/community-color';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import {
  communityScopeStore, goToCommunity, hydrateCommunityScope, tabVotes, warmCommunities,
  type CommunityInfo,
} from '../workshop/community-scope';
import { CommunitySwitcher } from '../workshop/community-switcher';
import { pressLitTab } from '../workshop/tab-ladder';
import { navStore } from './nav-store.js';
import { runningAppStore } from './parked-store.js';
import { SideApps } from './side-apps';
import { RailCommunities, useRailCommunities } from './rail-communities';
import { RailConversations } from './rail-conversations';
import { RailPinned } from './rail-pinned';
import { useSidebarRows } from './sidebar-rows';
import { clearPeekTimer, clearPeekTimerByMouse, enterPeekByMouse, leavePeekByMouse } from './rail-peek';
import { schedulePress, type PendingPress } from './tab-press';

/**
 * The tabs, in the DESKTOP RAIL's order: the markup is that order.
 *
 * WHY THESE, and why in this order (#6019, decided 29 Oct 2026): Home is the
 * launcher, Communities is the ones you are in, AI is your chat with the
 * Homeroom bot, Messages is the people and agents you talk to, and Me is
 * your own account. Challenges, Settings, Wallet, Validator and Admin are
 * all reached from Me, which is why five is enough on a phone — a sixth tab
 * there would be a section nobody visits daily.
 *
 * TWO ORDERS, ONE MARKUP (Evan, 29 Oct 2026). The desktop rail reads Home,
 * Discover, Messages, AI, Communities, then you at its foot; the phone's bar
 * reads Home · Communities · AI · Messages · You. The markup is the RAIL's
 * order, so a keyboard's focus order on a desktop is the order on screen,
 * and app.css lays the phone's five cells out with `order` ("TWO ORDERS,
 * ONE MARKUP" there). The rail's nested groups keep their places in it:
 * your conversations under Messages, your communities just above
 * Communities.
 *
 * DISCOVER IS A TAB ON THE RAIL AND A PAGE OF HOME'S ON A PHONE. The rail
 * has room for it, so it sits under Home there and is lit on its own screen.
 * The phone's bar has five cells and the fifth went to AI, the one
 * conversation everybody has (it used to be the first row of Messages):
 * there app.css hides the Discover tab, Home's Discover block opens the
 * page, Back returns to Home and Home stays lit on it (nav-store.js
 * tabForScreen, App._backSlotFor). Communities' key is still
 * `workshop`: the key names the screen (`#workshop-screen`) and the
 * declared checks select on `#platform-tab-workshop`, while the words a
 * person sees are Communities and `#communities` (AGENTS.md, "Communities
 * own projects"). Inside a project, "Workshop" is the build tab beside its
 * hub — the one place that word is shown now.
 *
 * Discover is a compass (v3, 18 Oct 2026), on every bar alike, where it
 * kept the magnifier the app menu's `#switcher-row-discover` drew: it is
 * where you go to find something new, and a magnifier says "search", which
 * the sidebar's Communities heading and the inbox already offer. One glyph
 * a destination, whatever bar it is on.
 */
// `label` is a message id (frontend/locales/en/core.json), read when the bar
// renders so the words follow the language on screen.
const TABS = [
  {
    key: 'home' as const,
    label: 'core:tabs.home',
    // A REAL PATH, not a fragment, and that is deliberate: Home is the only
    // one of the five that is a document address rather than a hash route,
    // so a cmd-click on it opens the launcher in a new tab the way the app
    // menu's Home row already does. The click handler below is what makes a
    // PLAIN click stay in this document.
    href: '/',
    Icon: HomeIcon,
  },
  // The rail's alone: app.css hides it on the phone's bar (see above).
  { key: 'discover' as const, label: 'core:tabs.discover', href: '#apps', Icon: CompassIcon },
  { key: 'messages' as const, label: 'core:tabs.messages', href: '#messages', Icon: ChatIcon },
  // #6019: the Homeroom bot's chat, which left the Messages list for a tab
  // of its own. `#ai` opens it (app.js), and the tab is lit while it is the
  // conversation on screen (the nav store's `bot`). Its glyph is the bot's
  // own picture in line, not a sparkle (29 Oct 2026).
  { key: 'ai' as const, label: 'core:tabs.ai', href: '#ai', Icon: HomeroomBotIcon },
  { key: 'workshop' as const, label: 'core:tabs.communities', href: '#communities', Icon: UserGroupIcon },
  // "You", signed in or not (N7 of the 19 Oct polish board); the accessible
  // name adds whose account it is — see tabLabel below.
  { key: 'me' as const, label: 'core:tabs.me', href: '#profile', Icon: UserIcon },
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
 * Home, Discover, Communities and Messages would be read out as a person rather
 * than a place, so the label names both, and it starts with the visible text
 * so a voice command that says what is on screen still finds it.
 *
 * …AND THE TAB SAYS "You" NOW (N7 of the 19 Oct 2026 polish board; the owner
 * agreed). A username is up to 32 characters, and in a fifth of a phone's
 * width a long one was cut to "newbie_t1…", the only label on the bar that
 * did not fit. "You" is the account's place, as Home and Messages are
 * places; it is the prerender too, so the name arriving changes no text on
 * screen, and the accessible name still says whose it is.
 */
export function tabLabel(
  key: string,
  label: string,
  viewer: string | null,
): { text: string; ariaLabel: string | undefined } {
  if (key === 'me' && viewer) return { text: label, ariaLabel: translate('core:tabs.meNamed', { username: viewer }) };
  return { text: label, ariaLabel: undefined };
}

/**
 * The Communities tab's accessible name (#3709).
 *
 * THE WORD STAYS "Communities" WHEREVER THE TAB IS. It used to take the
 * community it was on as its label, "Recipe Box" under the tile, which made
 * the fourth tab read as one project rather than the place all of yours are,
 * and the owner asked for the word back, on the phone's bar and the desktop
 * rail alike. The tile still says which community the tab is on, so only the
 * spoken name has to add it: it starts with the visible word, for the reason
 * tabLabel gives, and names the community after it. On All communities the
 * word is the whole of it, and the anchor carries no label of its own, as
 * the prerender ships it.
 */
export function communitiesAriaLabel(scoped: { name: string } | null, votes = 0): string | undefined {
  // #5040: the blue number is said in words too, after the tab's own name.
  if (votes > 0) {
    return scoped
      ? translate('core:tabs.communitiesOnVotes', { community: scoped.name, count: votes })
      : translate('core:tabs.communitiesVotes', { count: votes });
  }
  return scoped ? translate('core:tabs.communitiesOn', { community: scoped.name }) : undefined;
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
 *
 * ON A PHONE THE HREF IS NOT WHAT IT DID BEFORE (#5581). `#communities` is
 * the full-screen Communities page, with the header's "Communities ⌄" and
 * the list drawn as a page; the list on a phone is the drawer's own level 0
 * (../nav-drawer/), as the lit tab already opens it from a community's page.
 * So the tab takes the switcher's "All communities" door instead
 * (../workshop/community-scope.ts `goToCommunity`), which opens the drawer's
 * list over a community. A new account with no community to show it over
 * still lands on the page, which is where Join and Start are.
 */
function onWorkshopClick(event: React.MouseEvent<HTMLAnchorElement>): void {
  const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
  if (nav?.isNativeClick?.(event)) return;
  const app = (window as unknown as { App?: { resumeWorkshopView?: () => boolean } }).App;
  if (app?.resumeWorkshopView?.()) { event.preventDefault(); return; }
  if (wideWindow()) return;
  event.preventDefault();
  goToCommunity(null);
}

/** The desktop's sidebar, where the tab's href (the full-screen list) is right. */
function wideWindow(): boolean {
  try { return !window.matchMedia || window.matchMedia('(min-width: 768px)').matches; } catch { return true; }
}

/**
 * THE COMMUNITIES TAB'S FACE: the community it is on, or All communities.
 * Only the glyph changes: the tab's label says Communities either way
 * (#3709, communitiesAriaLabel).
 *
 * On the phone's bar, a square ring, the shape of an app's own tile, around
 * either that community's tile, in its colour (features/workshop/
 * community-scope.ts says which; lib/community-color.ts what colour), or, on
 * All communities, the tab's own people glyph. The ring says which community
 * the tab is on; switching is the drawer's list. Holding the tab no longer
 * opens "Your communities" (18 Oct 2026): that was the old switcher, which
 * the drawer replaced on a phone. The desktop rail draws no ring (app.css):
 * the header's name is the switcher there.
 *
 * All communities is THE PRERENDER: the scope arrives from localStorage in
 * an effect flushed with the hydration (before the first paint) and from
 * app.js, so the shipped markup and the first client render are both this
 * branch.
 */
function CommunityTabFace({ info }: { info: CommunityInfo | null }) {
  const color = useCommunityColor(info
    ? { color: info.iconColor, iconUrl: info.iconUrl, iconEmoji: info.iconEmoji, key: info.slug }
    : null);
  if (!info) {
    return (
      <span className="platform-tab-ring platform-tab-ring-all" aria-hidden="true">
        <UserGroupIcon className="platform-tab-glyph" aria-hidden="true" />
      </span>
    );
  }
  const app = { slug: info.slug, name: info.name, icon_url: info.iconUrl, icon_emoji: info.iconEmoji };
  return (
    <span className="platform-tab-ring" style={{ ['--ring' as string]: color }} aria-hidden="true">
      <span className="app-icon-tile platform-tab-tile" data-icon={appIconKind(app as never)}>
        <AppIconContent app={app as never} />
      </span>
    </span>
  );
}

/**
 * The votes the tab's community is waiting on you for (All communities: all
 * of them, less an unchosen community's: ../workshop/community-scope.ts
 * `tabVotes`), in the accent, because it asks for you. Only above zero, and
 * never in the prerender (the store starts empty). While it shows, app.css
 * hides the quiet unread-channels count beside it: one number per glyph.
 */
function VotesBadge({ count }: { count: number }) {
  const t = useMessages();
  if (!(count > 0)) return null;
  return (
    <span className="platform-tab-votes" aria-label={t('core:tabs.votesWaiting', { count })}>
      {count > 99 ? '99+' : String(count)}
    </span>
  );
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
function TabBadge({ count, id = 'platform-tabs-badge', label }: {
  count: number;
  id?: string;
  /** The accessible name, already in the language on screen. */
  label: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useHiddenClass(ref, count <= 0);
  return (
    <span
      ref={ref}
      id={id}
      className="platform-tab-badge hidden"
      aria-label={label}
    >
      {count > 0 ? (count > 99 ? '99+' : String(count)) : ''}
    </span>
  );
}

/**
 * The rail, peeked back over a folded rail (#2718, #2764, desktop only).
 *
 * ── Where it comes from now ───────────────────────────────────────────
 *
 * It began as the rail peeked back over an OPEN APP: on a laptop the pointer
 * is at the left edge half the time, so the rail came back on hover there.
 * That is exactly why it was taken away over a running app (#3138) — an app's
 * own menus, lists and scrollbars put the pointer at the left edge all the
 * time, and the rail kept landing on top of what the reader was using. Inside
 * an app the way out is the header's ✕, as on a phone.
 *
 * What remains is the FOLDED rail on a platform screen: hovering the window's
 * edge (the hot zone below) or #sidebar-toggle fades it in over the page, and
 * going anywhere from it is an ordinary tab press. Slack's collapsed rail and
 * a desktop OS's auto-hiding dock are the same move.
 *
 * ── Why the peek is its own fact ──────────────────────────────────────
 *
 * It is NOT the bar's visibility. A folded rail is still the route's rail,
 * and the peek is a temporary overlay ON TOP of that — the screens reserve no
 * band while it is up, and the page stays full width. That is why it is a
 * separate field and why the CSS that reserves the band excludes a peeking
 * bar explicitly: a rail that reserved 224px on the way in would reflow the
 * page under the pointer.
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
  return { enter: enterPeekByMouse, leave: peek ? leavePeekByMouse : clearPeekTimerByMouse };
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
 * THE BOX HUGS THE TAB'S GLYPH AND LABEL, not the tab. The tab is the full
 * 56px cell edge to edge, which is right for the thumb and wrong for the
 * pill: a pill inset 4px from the cell was sized by the bar's width divided
 * by five, so a long label ("Workshop", "Messages") met its edges with a
 * pixel to spare and a short one ("Home") floated in a wide lozenge. The
 * pill is now what it holds plus the same padding on every tab — 5px over
 * the glyph, 8px either side, 3px under the label — with a floor so a
 * three-letter label still gets a pill rather than a capsule, and the tab
 * under it keeps the whole cell as its target. The desktop rail does not
 * use it at all — its rows carry a fill of their own, and app.css hides the
 * marker there.
 */
interface TabMarkerBox {
  x: number;
  y: number;
  w: number;
  h: number;
  slide: boolean;
}

/** The fallback when the tab's contents cannot be measured: the cell, inset. */
const MARKER_INSET = 4;
/** The pill's padding around the glyph and label, and its narrowest width. */
const MARKER_PAD = { top: 5, x: 8, bottom: 3 } as const;
const MARKER_MIN_W = 58;

/** A box relative to the tab it sits in, as getBoundingClientRect deltas. */
export type ContentRect = { left: number; top: number; width: number; height: number };

/**
 * The marker's box on the bar. `content` is the union of the tab's glyph and
 * label relative to the tab; without one (not measurable, or nothing laid
 * out inside) the box falls back to the cell inset 4px, the old geometry.
 * Integers, so a re-measure that lands on the same pixel keeps the previous
 * box (useTabMarker compares them) rather than restarting a slide.
 *
 * `inCell`: the pill keeps to its cell's width, inset 4px a side, and hugs
 * the contents only up and down. That is the bar stood up in an iPhone
 * Duo's side strip (../../lib/side-strip.ts), a 64px column whose cells are
 * the pill's whole width: sized by its label there, the pill ran past the
 * column's sides ("Communities" made it 71px).
 */
export function markerBoxFor(
  el: { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number },
  content?: ContentRect | null,
  inCell = false,
): Omit<TabMarkerBox, 'slide'> | null {
  // A bar that is not laid out (hidden, or the keyboard is up) has nothing to
  // say about where the tab is; keep the last box rather than collapse it.
  if (!(el.offsetWidth > 0) || !(el.offsetHeight > 0)) return null;
  if (!content || !(content.width > 0) || !(content.height > 0)) {
    return {
      x: el.offsetLeft + MARKER_INSET,
      y: el.offsetTop + MARKER_INSET,
      w: Math.max(0, el.offsetWidth - MARKER_INSET * 2),
      h: Math.max(0, el.offsetHeight - MARKER_INSET * 2),
    };
  }
  const h = Math.round(content.height + MARKER_PAD.top + MARKER_PAD.bottom);
  const y = Math.round(el.offsetTop + content.top - MARKER_PAD.top);
  if (inCell) {
    return {
      x: el.offsetLeft + MARKER_INSET,
      y,
      w: Math.max(0, el.offsetWidth - MARKER_INSET * 2),
      h,
    };
  }
  const w = Math.round(Math.max(MARKER_MIN_W, content.width + MARKER_PAD.x * 2));
  const centre = el.offsetLeft + content.left + content.width / 2;
  return {
    x: Math.round(centre - w / 2),
    y,
    w,
    h,
  };
}

/**
 * The union of a tab's glyph and label, relative to the tab. Null when
 * either is missing or not laid out, which sends markerBoxFor to its
 * fallback.
 */
export function tabContentRect(tab: HTMLElement): ContentRect | null {
  const parts = [tab.querySelector('.platform-tab-mark'), tab.querySelector('.platform-tab-label')]
    .map((node) => (node as HTMLElement | null)?.getBoundingClientRect?.())
    .filter((r): r is DOMRect => !!r && r.width > 0 && r.height > 0);
  if (parts.length < 2) return null;
  const base = tab.getBoundingClientRect();
  const left = Math.min(...parts.map((r) => r.left));
  const top = Math.min(...parts.map((r) => r.top));
  const right = Math.max(...parts.map((r) => r.right));
  const bottom = Math.max(...parts.map((r) => r.bottom));
  return { left: left - base.left, top: top - base.top, width: right - left, height: bottom - top };
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
 * A PRESS ON THE BAR NO LONGER TAKES THIS PATH (#3259). Waiting out one
 * heavy frame was not enough on a phone: the swap is several long frames
 * (measured in the iOS simulator: the router's own task, then frames of 40
 * to 150ms while the new screen lays out and its data lands), so a slide
 * started two frames out still began inside one of them and showed from its
 * middle. So a press moves the pill FIRST, in the press's own task, and it is
 * the NAVIGATION that waits, for the frame that lights the tab and no longer
 * (useTabMarker's `press`, ./tab-press.ts schedulePress says why). This
 * path is still what a tab change the bar did not start takes (Back, a link,
 * a deep link).
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

/**
 * THE SLIDE ITSELF: the Workshop strip's duration and curve
 * (`.dev-ws-tab-marker`), run as a transform-only animation (#3259).
 *
 * It was a CSS transition of transform, width and height. The transform ran
 * on the compositor, but width and height are layout and ran on the main
 * thread, so once a press started the slide ahead of the screen swap, the
 * swap froze them mid-slide: the pill glided at the old tab's width (from
 * Communities to Me it ran past the screen's right edge in the iOS
 * simulator) and snapped to size when the swap let go. So the pill takes its
 * new size at once, and the slide is a FLIP: it starts scaled to the box it
 * is leaving and eases into the new one, all transform, all compositor.
 *
 * NO DELAY, deliberately. Measured on a test page in the iOS simulator with
 * the main thread blocked for 250ms two frames after the press: a translate
 * transition, a translate+scale transition and this animation all painted
 * 20%, 43%, 68%… straight through the block, while the same animation or
 * transition given a 34ms delay stood still and then appeared at the end.
 * A delay keeps WebKit from handing it to the compositor.
 */
export const MARKER_SLIDE = { duration: 260, easing: 'cubic-bezier(.32, .72, 0, 1)' } as const;

type Box = { x: number; y: number; w: number; h: number };

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * The two transforms of a slide from `from` to `to`, for a marker laid out
 * at `to`'s size with `transform-origin: 0 0` (app.css).
 *
 * BOTH ENDS SPELL THE SAME FUNCTIONS, `translate() scale()`, the end with a
 * scale of 1, so the two interpolate function by function rather than as
 * matrices. That is the form measured running on the compositor through a
 * blocked main thread (MARKER_SLIDE); keep the lists matched when changing it.
 */
export function slideKeyframes(from: Box, to: Box): [string, string] {
  const sx = to.w > 0 ? round4(from.w / to.w) : 1;
  const sy = to.h > 0 ? round4(from.h / to.h) : 1;
  return [
    `translate(${from.x}px, ${from.y}px) scale(${sx}, ${sy})`,
    `translate(${to.x}px, ${to.y}px) scale(1, 1)`,
  ];
}

/**
 * Where a marker laid out at `laidOut`'s size is on screen under `transform`,
 * a computed `matrix(a, b, c, d, e, f)`. A press during a slide starts the
 * next one from where the pill IS, not from the box it was leaving.
 */
export function shownBox(laidOut: Box, transform: string): Box {
  const m = /^matrix\(([^)]+)\)$/.exec(String(transform || '').trim());
  const v = m ? m[1].split(',').map(Number) : [];
  if (v.length !== 6 || v.some((n) => !Number.isFinite(n))) return laidOut;
  return { x: v[4], y: v[5], w: laidOut.w * v[0], h: laidOut.h * v[3] };
}

/** Reduced motion asks for none; unreadable answers that motion is welcome. */
function motionWelcome(): boolean {
  try {
    return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return true;
  }
}

/** A press slides only where a slide can show: a placed, drawn marker, with motion welcome. */
function canSlide(bar: HTMLElement): boolean {
  const marker = bar.querySelector<HTMLElement>('.platform-tabs-marker[data-marker-at]');
  // Unplaced (nothing lit yet), or `display: none` (the desktop rail).
  if (!marker || marker.getClientRects().length === 0) return false;
  return motionWelcome();
}

/**
 * What the marker lights while no tab is: the app on screen, in iPhone Duo's
 * side strip (./side-apps.tsx). Off the strip that element is never drawn,
 * so the marker finds nothing to measure there and keeps out of it.
 */
const APP_TARGET = 'app';

function useTabMarker(
  barRef: React.RefObject<HTMLElement | null>,
  tab: string | null,
  appLit = false,
): {
  box: TabMarkerBox | null;
  lit: string | null;
  markerRef: React.RefObject<HTMLSpanElement | null>;
  press: (el: HTMLElement, key: string, go: () => void, fallback?: () => void) => boolean;
} {
  const [box, setBox] = useState<TabMarkerBox | null>(null);
  const markerRef = useRef<HTMLSpanElement | null>(null);
  // The box the marker was last laid out at, which the next slide leaves.
  const laidOut = useRef<TabMarkerBox | null>(null);
  // THE TAB A PRESS LIT, until the router has answered it (#3259). The bar
  // answers a press at once, pill and label together, and the router's tab
  // takes over when it lands; `lit` is what the bar draws. Null at first,
  // so the first render is the prerender's.
  const [pressed, setPressed] = useState<string | null>(null);
  const lit = pressed ?? tab;
  const target = lit ?? (appLit ? APP_TARGET : null);
  // The press waiting for its route. A ref, not state: nothing renders from
  // it, and the callbacks that read it outlive the render they came from.
  const pending = useRef<PendingPress | null>(null);

  const place = (el: HTMLElement, selectionChanged: boolean) => {
    const inStrip = document.documentElement.hasAttribute('data-side-strip');
    const next = markerBoxFor(el, tabContentRect(el), inStrip);
    if (!next) return;
    setBox((prev) => {
      if (prev && prev.x === next.x && prev.y === next.y
        && prev.w === next.w && prev.h === next.h) return prev;
      return { ...next, slide: !!prev && selectionChanged };
    });
  };

  // The router lit the tab a press slid to: the press is answered, and the
  // bar is the router's again with nothing to move.
  useLayoutEffect(() => {
    if (!pending.current || pending.current.key !== tab) return;
    pending.current.cancel();
    pending.current = null;
    setPressed(null);
  }, [tab]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    if (!target) {
      setBox(null);
      return;
    }
    // A slide waiting for the swap's frame to be painted (see afterNextFrame).
    let cancelSlide: (() => void) | null = null;
    const selector = target === APP_TARGET ? '.platform-side-app[aria-current="page"]' : '.platform-tab[aria-current="page"]';
    const measure = (selectionChanged: boolean) => {
      const el = bar.querySelector<HTMLElement>(selector);
      if (!el) return;
      place(el, selectionChanged);
    };
    // This run is the tab having changed; the observer's are layout moving.
    // The first placement lands now; a move from a tab already marked waits
    // out the screen swap's frame and then slides, re-measuring then so it
    // goes where the tab IS rather than where it was a frame ago. After a
    // press the pill is already there, so this lands on the same box.
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
    // The pill is sized by the lit tab's label now, and a label can change
    // width with the bar standing still (the Me tab takes the viewer's name
    // once it has loaded), so the label is watched as well.
    const label = bar.querySelector(`${selector} .platform-tab-label`);
    if (label) ro.observe(label);
    return () => {
      ro.disconnect();
      cancelSlide?.();
    };
  }, [barRef, target]);

  // THE SLIDE (MARKER_SLIDE). React has just laid the marker out at `box`;
  // a selection change plays it in from the box it left, or from wherever a
  // slide still running had got to. Anything else lands where it is: the
  // first placement, a re-measure, reduced motion, nothing lit.
  useLayoutEffect(() => {
    const el = markerRef.current;
    const prev = laidOut.current;
    laidOut.current = box;
    if (!el || typeof el.animate !== 'function') return;
    const running = typeof el.getAnimations === 'function' ? el.getAnimations() : [];
    const from = prev && running.length ? shownBox(prev, getComputedStyle(el).transform) : prev;
    for (const animation of running) animation.cancel();
    if (!box || !from || !box.slide || !motionWelcome()) return;
    const [start, end] = slideKeyframes(from, box);
    el.animate([{ transform: start }, { transform: end }], {
      duration: MARKER_SLIDE.duration,
      easing: MARKER_SLIDE.easing,
    });
  }, [box]);

  // Unmounting abandons a press: its navigation and its settle timer.
  useEffect(() => () => {
    pending.current?.cancel();
    pending.current = null;
  }, []);

  /**
   * A press on another tab (#3259): light it and slide to it NOW, and
   * navigate once that frame is painted (schedulePress). The slide is made in
   * the press's own task; the swap no longer waits for it to be running
   * (polish board #2: that wait held the old screen up for 120 to 205ms).
   * `go` is the tab's own navigation, run a frame late.
   *
   * False when the pill cannot slide (the desktop rail, reduced motion,
   * nothing lit yet): the caller navigates as it always did, at once.
   *
   * If the router never lights `key`, the bar goes back to the tab it did
   * light after PRESS_SETTLE_MS rather than sitting on the wrong one — unless
   * the press was given a `fallback` (tab-press.ts): then that runs once at
   * settle time, and the press is given the same wait again (#5730).
   */
  const press = (el: HTMLElement, key: string, go: () => void, fallback?: () => void): boolean => {
    const bar = barRef.current;
    if (!bar || !canSlide(bar)) return false;
    place(el, true);
    setPressed(key);
    // A second press before the first has navigated replaces it.
    schedulePress(pending, key, go, () => setPressed(null), undefined, undefined, undefined, fallback);
    return true;
  };

  return { box, lit, markerRef, press };
}

/**
 * A tab's navigation, run by a press after the pill has started (#3259). The
 * same three roads the bar's clicks take at once: Home through the router
 * (onHomeClick), Communities back to the Workshop you left when there is one
 * (onWorkshopClick), and otherwise the tab's own href.
 */
function goToTab(key: string, href: string): void {
  const app = (window as unknown as {
    App?: { navigateHome?: (opts?: { viaTab?: boolean }) => void; resumeWorkshopView?: () => boolean };
  }).App;
  if (key === 'home' && app?.navigateHome) {
    app.navigateHome({ viaTab: true });
    return;
  }
  if (key === 'workshop' && app?.resumeWorkshopView?.()) return;
  // #5581: on a phone the list is the drawer's, not the page the href names.
  if (key === 'workshop' && !wideWindow()) {
    goToCommunity(null);
    return;
  }
  window.location.assign(href);
}

/**
 * The Communities destination that always lands (#5730): the All communities
 * page, at `#communities`.
 *
 * A press on Communities from Me or Discover can reveal nothing. Its resume
 * (`App.resumeWorkshopView`) hands off to `navigateToApp`, which gives up
 * quietly when its record does not land, and the phone's list over it
 * (`goToCommunity(null)`) needs a community to open it over. The router then
 * never lights `workshop`, and the bar slid the pill back to the tab the
 * press left.
 *
 * So the page, which is an ordinary address: the hashchange routes through
 * `restoreFromHash` to `navigateToWorkshop`, which reveals `#workshop-screen`
 * and lights the tab. The remembered view is forgotten first, as choosing
 * All communities does, so the next press does not try the same dead resume;
 * that also clears `currentApp`, which is what makes a `navigateToApp` still
 * waiting from the first attempt drop itself. Deliberately not
 * `goToCommunity(null)`: its phone road is the drawer's list, the one that
 * just failed to show anything.
 */
function openCommunitiesPage(): void {
  try { (window as unknown as { App?: { _forgetWorkshopView?: () => void } }).App?._forgetWorkshopView?.(); }
  catch { /* nothing stored to forget */ }
  if (window.location.hash !== '#communities') window.location.hash = '#communities';
}

export function PlatformTabs() {
  const barRef = useRef<HTMLElement | null>(null);
  const t = useMessages();
  // `true` is what the prerendered document ships: the bar is present and
  // visible, and the routes that hide it (an app, chromeless, the signed-out
  // shell) publish `false` once the router has run.
  const visible = useVisibility('platform-tabs', true);
  const { tab: routedTab, messages, communities, ai, bot, screen, peek, peekOut, railOpen, viewer } = useStoreState(navStore);
  // #6019: the Homeroom bot's chat is on the Messages screen, and is the AI
  // tab's: AI is lit there, not Messages.
  const tab = routedTab === 'messages' && bot ? 'ai' : routedTab;
  // THE COMMUNITY THE FOURTH TAB IS ON (../workshop/community-scope.ts). Read
  // from storage by this effect, which is flushed with the hydration itself
  // (main.tsx hydrates in flushSync), so before the first paint; the viewer's
  // list of communities follows in the same task (lib/shell-snapshot-apply.ts),
  // and every community's votes owed a
  // moment after sign-in, so the badge can say so before anybody opens the
  // switcher.
  const scope = useStoreState(communityScopeStore);
  useEffect(() => { hydrateCommunityScope(); }, []);
  // On a desktop the sidebar's own rows are your communities (D), so they are
  // read at once rather than a moment after sign-in.
  const sidebarRows = useSidebarRows();
  useEffect(() => (viewer ? warmCommunities(sidebarRows ? 0 : undefined) : undefined), [viewer, sidebarRows]);
  const scoped = scope.slug ? scope.info[scope.slug] || null : null;
  // Less an unchosen community's votes: the one every account is put in,
  // until you have taken part there (tabVotes says why).
  const votes = tabVotes(scope);
  // THE SIDEBAR OF ROWS (./sidebar-rows.ts, from 768px): the five
  // communities it lists (./rail-communities.tsx), and on its All row every
  // vote waiting on you, the tab's own figure (#18 of the 19 Oct polish
  // board). It was the votes in the communities the rows above did not
  // list, which read as a total and was not one: 67 there while Needs you
  // said 93.
  const railShown = useRailCommunities();
  const allVotes = Number(scope.badgeNeeds) || 0;
  const allCount = scope.list ? scope.list.length : 0;
  // #5040: the blue number the tab shows at this width, which its tooltip names.
  const titleVotes = sidebarRows ? allVotes : votes;
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
  // A RUNNING APP, as this store tells it: the app view with no tab lit. Its
  // Workshop and its threads light Workshop or Messages (App._syncPlatformTabs),
  // so they are not this. The hot zone below needs it since the rail stays
  // beside a running app on the desktop.
  const runningApp = screen === 'app-view' && !tab;
  // …which iPhone Duo's strip shows among its tabs, lit (./side-apps.tsx).
  const onScreenApp = useStoreState(runningAppStore).app;
  const { box: marker, lit, markerRef, press } = useTabMarker(barRef, tab, runningApp && !!onScreenApp);
  // A plain press on another tab lights it and slides the pill first, and
  // navigates a frame later (useTabMarker's `press`, #3259). A modified click
  // stays the browser's, a second press on a tab still waiting for its route
  // adds nothing, and a press the pill cannot slide for navigates at once,
  // the way every press did before.
  const onTabClick = (event: React.MouseEvent<HTMLAnchorElement>, key: string, href: string) => {
    const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
    if (nav?.isNativeClick?.(event)) return;
    if (key === lit && lit !== tab) {
      event.preventDefault();
      return;
    }
    // THE LIT COMMUNITIES TAB GOES UP A LEVEL (#3701), the same on the
    // phone's bar and the desktop rail: from a page below a community's tabs
    // back to the community, then to the top, then to All communities, whose
    // own press only scrolls (../workshop/tab-ladder.ts). It used to open
    // "Your communities" on a phone and go to All communities on the rail.
    // On a wide window the switcher is the header's name; a phone has the
    // drawer's list, and holding the tab opens nothing (18 Oct 2026).
    // v3: IN THE SIDEBAR OF ROWS THE TAB IS "All 13 communities", and goes
    // there, from a community's page too: a community's own row is the way
    // up its page, and resuming the last one (App.resumeWorkshopView) is the
    // strip's tab, whose face is that community. On the list itself it only
    // scrolls, as before.
    if (key === 'workshop' && sidebarRows) {
      event.preventDefault();
      if (screen === 'workshop-screen') pressLitTab(screen);
      else goToCommunity(null);
      return;
    }
    if (key === 'workshop' && lit === 'workshop' && tab === 'workshop') {
      event.preventDefault();
      pressLitTab(screen);
      return;
    }
    // A press from another tab always resumes the view left, whatever the
    // blue number says (#5708): the Needs you detour overwrote the place.
    // Communities is the one press that can reveal nothing (#5730 — from Me
    // or Discover), so it carries the page as its fallback, and only while
    // the screen it left is still the one on show: a Back or another
    // navigation during the wait is never overridden.
    const left = navStore.get().screen;
    const fallback = key === 'workshop'
      ? () => { if (navStore.get().screen === left) openCommunitiesPage(); }
      : undefined;
    if (key !== lit && press(event.currentTarget, key, () => goToTab(key, href), fallback)) {
      event.preventDefault();
      return;
    }
    const now = key === 'home' ? onHomeClick : key === 'workshop' ? onWorkshopClick : undefined;
    now?.(event);
  };

  return (
    <>
      {/*
          THE HOT ZONE. A strip at the window's left edge, and the only thing
          that can start a peek. It renders ONLY where the viewer folded a
          rail the route has — `visible && !railOpen` — and app.css hides it
          below the desktop breakpoint, because a phone has no pointer to
          hover with and a hidden touch target at the screen edge would eat
          swipes.

          NOT OVER A RUNNING APP (#3138). It used to render there too
          (#2718), so the rail came back over the app whenever the pointer
          drifted to the window's left edge — which is where an app's own
          menus, lists and scrollbars put the pointer all the time, and the
          rail landed on top of whatever the reader was reaching for. On a
          desktop the rail stays beside a running app now, and folding it
          there gives the app the window: the way back is #sidebar-toggle in
          the header's corner, never the edge (`!runningApp`). On a phone,
          or with "Keep sidebar open in apps" off, the way out is the
          header's ✕ and the rail is the route's to hide (`!visible`). That
          holds even with the rail folded by hand: `railOpen` outlives the
          screen, and a fold made on Home must not bring the hot zone into
          the next app opened.

          Nor on the chromeless and signed-out shells, the other routes with
          no rail: a strip that peeked one in there would be conjuring
          navigation out of nothing. `visible` answers all three at once.

          A folded rail on a platform screen keeps it: that is the fold's
          way back by hover, beside #sidebar-toggle, which docks it again
          (the toggle hovered peeks it too). On an app's Workshop the rail is
          UP, so this is that same case — and while the rail is open the strip
          is absent, because at `z-index: 39` against the rail's 30 it would
          lay an invisible 18px column down the left edge of the tabs and
          swallow the press meant for the one under the pointer.
      */}
      {visible && !railOpen && !runningApp ? (
        <div
          id="platform-rail-peek"
          className="platform-rail-peek"
          aria-hidden="true"
          onPointerEnter={enter}
          onPointerLeave={leave}
        />
      ) : null}
      <nav
        ref={barRef}
        id="platform-tabs"
        className="platform-tabs"
        aria-label={t('core:tabs.sections')}
        onPointerEnter={enter}
        onPointerLeave={leave}
      >
      {/*
          iPhone Duo's side strip: the app on screen and the app you left,
          under their Apps heading (./side-apps.tsx). First in the bar, even
          before the marker, so the sibling chain the declared checks pin
          (the marker, then Home, through to the settings row last) is
          untouched; app.css draws it under Communities, and only on the
          strip. Its tiles stand a step above the marker, which still
          paints behind them.
      */}
      <SideApps />
      {/*
          THE LIT TAB'S MARKER (#2824). Before the tabs so it paints behind
          them (app.css raises each tab one step), `aria-hidden` because
          `aria-current` already says which tab is lit, and bare until
          measured — see useTabMarker. `data-marker-at` is what makes it
          visible. The style is where it rests; the slide there is an
          animation useTabMarker plays over it (MARKER_SLIDE).
      */}
      <span
        ref={markerRef}
        className="platform-tabs-marker"
        aria-hidden="true"
        {...(marker ? { 'data-marker-at': '' } : {})}
        style={marker ? {
          transform: `translate(${marker.x}px, ${marker.y}px)`,
          width: `${marker.w}px`,
          height: `${marker.h}px`,
        } : undefined}
      />
      {TABS.flatMap(({ key, label, href, Icon }) => [
        // 18 Oct 2026: THE COMMUNITIES YOU PINNED, under their heading,
        // above your communities (./rail-pinned.tsx). Each community's app
        // is the first row under it now, so the apps the strip listed apart
        // from them (#4417, Pinned and Recent apps) have no section of their
        // own. From 768px only; app.css keeps it off the phone's bar.
        key === 'workshop' ? <RailPinned key="pinned" /> : null,
        // D (18 Oct 2026): YOUR COMMUNITIES, under their heading, just above
        // the Communities tab, which the sidebar of rows draws as their
        // "All 13 communities" row. From 768px only; app.css keeps it off
        // the strip and the phone's bar.
        key === 'workshop' ? <RailCommunities key="communities" shown={railShown} /> : null,
        <a
          key={key}
          id={`platform-tab-${key}`}
          className="platform-tab"
          href={href}
          data-tab={key}
          // `aria-current="page"` and nothing else marks the active tab:
          // it is what a screen reader announces and what the declared
          // checks select on, and it costs no second attribute to keep in
          // step with. The colour comes from app.css keying off it. It is the
          // router's tab, except for the moment between a press and its route
          // landing, when it is the tab pressed (useTabMarker, #3259).
          aria-current={lit === key ? 'page' : undefined}
          // Beside the sidebar's list the tab is its All row, and named by
          // the words it shows ("All 13 communities"), not the community.
          aria-label={key === 'workshop'
            ? (sidebarRows ? undefined : communitiesAriaLabel(scoped, votes))
            : tabLabel(key, t(label), viewer).ariaLabel}
          // #5040: pointed at, the tab says what its blue number counts (on
          // the sidebar's All row, every vote waiting on you). None at zero,
          // as the prerender ships it.
          title={key === 'workshop' && titleVotes > 0 ? t('core:tabs.votesWaiting', { count: titleVotes }) : undefined}
          onClick={(event) => onTabClick(event, key, href)}
        >
          <span className="platform-tab-mark">
            {key === 'workshop'
              ? <CommunityTabFace info={scoped} />
              : <Icon className="platform-tab-glyph" aria-hidden="true" />}
            {/*
                THE ALL ROW'S GLYPH, in the sidebar of rows (D): the grid,
                drawn in the ring's place there, as the screen it opens is
                every community at once. app.css shows one of the two.
            */}
            {key === 'workshop' ? <Squares2X2Icon className="platform-tab-glyph platform-tab-all-glyph" aria-hidden="true" /> : null}
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

                AND IT IS THE QUIET ONE (#2912). Grey is "new to read"
                everywhere (#18, 19 Oct 2026): the bell's red counts what
                happened to you and leaves plain messages to this count, so
                one message lights one number. On the phone's bar a grey disc
                on the glyph's corner, on the desktop rail a grey pill at the
                row's far end. It stays
                HERE in the markup for both; app.css moves it on the rail by
                dissolving this wrapper, so the phone keeps its anchor and a
                declared check keeps finding it inside the Messages tab.
            */}
            {key === 'messages' ? <TabBadge count={messages} label={t('core:tabs.unreadConversations')} /> : null}
            {/* #6019: the bot's chat has something unread. */}
            {key === 'ai' ? <TabBadge count={ai} id="platform-tabs-ai-badge" label={t('core:tabs.unreadAi')} /> : null}
            {/*
                THE CHANNELS' COUNT, on Communities. A project's channel lives
                on its hub now, not in Messages, so "something was said in a
                room you are in" is counted where the room is: how many of
                your communities' channels have unread messages (#general is
                Homeroom's). The same quiet grey disc, for the same reason.
            */}
            {key === 'workshop' ? (
              <TabBadge count={communities} id="platform-tabs-badge-communities" label={t('core:tabs.unreadChannels')} />
            ) : null}
            {key === 'workshop' ? <VotesBadge count={votes} /> : null}
          </span>
          <span className="platform-tab-label">{tabLabel(key, t(label), viewer).text}</span>
          {/*
              THE ALL ROW'S WORDS AND COUNT, in the sidebar of rows (D): how
              many communities you are in, so the row says there are more than
              the five above it, and every vote waiting on you (#18). Blue
              wins its seat: the grey count of unread channels gives way
              while a vote is owed (app.css), one number per row.
              app.css shows these instead of the label and the tab's own
              badge there; a hidden element is not in the accessible name, so
              each width's name is what it shows.
          */}
          {key === 'workshop' ? (
            <span className="platform-tab-all-label">
              {allCount > 0 ? t('core:rail.all', { count: allCount }) : t('core:rail.allPlain')}
            </span>
          ) : null}
          {key === 'workshop' && allVotes > 0 ? (
            <span className="platform-tab-all-votes" aria-label={t('core:tabs.votesWaiting', { count: allVotes })}>
              {allVotes > 99 ? '99+' : String(allVotes)}
            </span>
          ) : null}
        </a>,
        // v3 (18 Oct 2026): THE CONVERSATIONS, nested under Messages while
        // its screen is up in the sidebar of rows (./rail-conversations.tsx).
        // The element is there at every width and on every screen, empty
        // when shut, so the bar's sibling order is one order.
        key === 'messages' ? <RailConversations key="conversations" /> : null,
      ])}
      {/*
          SETTINGS, ONE CLICK FROM THE RAIL'S FOOT (#3120). A cog beside the
          account row, the way Slack, Discord and Linear put the settings
          control next to you rather than inside a page about you. Before
          this, Settings on a desktop was Me → scroll → the Settings row.

          DESKTOP ONLY. app.css draws it inside `@media (min-width: 768px)`
          and nowhere else: the phone's bar is five equal cells and stays
          that way, and Settings stays a row of the Profile screen there.

          AFTER Me in the markup, so the reading order is "you, then your
          settings" and the declared check's sibling chain that ENDS at
          #platform-tab-me is untouched. It is not a `.platform-tab` (the
          phone's marker and the bar's grid count those), and it lights on
          the Settings screen itself — the Me row stays lit too, because
          Settings still belongs to the Me section on both bars.
      */}
      <a
        id="platform-rail-settings"
        className="platform-rail-settings"
        href="#settings"
        aria-label={t('core:tabs.settings')}
        title={t('core:tabs.settings')}
        aria-current={screen === 'settings-screen' ? 'page' : undefined}
      >
        <CogIcon className="platform-rail-settings-glyph" aria-hidden="true" />
      </a>
      </nav>
      <CommunitySwitcher />
    </>
  );
}
