/**
 * #platform-header — the shell's top bar, as a React island (#1079 chunk B).
 *
 * The markup is the shell's, moved here verbatim: same ids, same class strings,
 * same order. What makes it an island rather than an extracted static component
 * is ./use-header-layout.ts, the port of the retired public/js/header-layout.js
 * — the one module that owned nodes in here, and now the only thing that writes
 * to this subtree from React's side.
 *
 * Everything INSIDE this bar is still written by public/js/app.js by id
 * (App.setBackIcon on #back-btn, the title text, the red unread badge), so
 * React must never reconcile over those nodes: every class string below is a
 * constant prop, rendered once at hydration and never again. The exceptions
 * are React-owned end to end: <ImproveButton/> (which carries the work-in-
 * flight indicators) and <AppSwitcherChip/> — both of whose
 * writers publish through improveStore rather than touching the DOM.
 *
 * The bar's OWN visibility is the one piece of state it holds. Chromeless mode
 * (`#app/<slug>/app`) hides the whole header, and App.setChromeless used to do
 * that with a classList toggle from outside React — the thing the migration's
 * visibility rule exists to stop. It publishes through
 * ../../lib/visibility-store now and this component subscribes, with `true` as
 * the initial value because the shipped markup ships the header visible.
 *
 * Even so the toggle lands via useHiddenClass rather than a rendered
 * `className`: PlatformUI.attachScreenFx is handed this element as its top bar
 * (app-view.js, group-chat.js) and the kit writes to it at runtime, so React
 * re-rendering the attribute would drop whatever the kit put there.
 */

import { useRef } from 'react';

import {
  BellIcon,
  ChevronLeftIcon,
  HomeIcon,
} from '@/components/ui/icons';

import { useHiddenClass, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useVisibility } from '../../lib/visibility-store';
import { useStoreState } from '../../lib/use-store-state';
import { backButtonStore } from './back-button-store.js';
import { ChromelessPill } from './chromeless-pill';
import { AppSwitcherChip } from './app-switcher-chip';
import { ImproveButton } from '../improve/improve-button';
import { boardHref, improveStore } from '../improve/improve-store.js';
import { useHeaderLayout } from './use-header-layout';
// ── The bundle's boot seam ────────────────────────────────────────────
//
// These six imports and the four inits below rode on the hamburger drawer's
// island for as long as there was one. They were never ABOUT the drawer: each
// installs a `window.*` global that app.js's boot looks for, and the drawer
// island simply happened to be the earliest thing in the bundle. This island
// is earlier still — it is the first one in Shell.tsx and it never unmounts —
// so the seam moves here rather than following any single row to its new home.
// Hanging a boot-time global off a surface nobody has opened yet would be a
// boot-order regression dressed up as tidiness.
//
// The AI-credit renderer, whose ROW is Settings → Anthropic API key. It
// installs window.AiCredit and App.init() calls AiCredit.Budget.init().
import './ai-credit.js';
// The installed mobile-app version, whose row is Settings' About block.
import './native-app-version.js';
import './node-pill.js';
import './wallet-sheet.js';
// The Improve button's two publishers — what it is about, and what its
// version dot says. A side-effect module like the rest: it installs
// window.ImproveStatus, which app.js forwards onto as App.ImproveStatus.
import '../improve/improve-status.js';
// The bell's module. ../notifications/mount.ts installs the store's flush and
// publishes the controller; this pulls both in.
import '../notifications/mount';

// THE SESSION LIFECYCLE PILL MOVED INTO THE CHIP.
//
// It used to render here, in the bar's left seat beside the back arrow, as
// `function SessionStatusPill()` wrapping a #header-status-pill span. On a new
// change that left the top of the screen reading as one grey word — "Draft" —
// with nothing naming the app being changed, because #1431 also left the chip
// empty on this route.
//
// Both halves are fixed in one place instead: the chip renders on session
// routes now, and the pill is its subtitle. Same store, same component, same
// #header-status-pill id and still inside #platform-header — see
// ./app-switcher-chip.tsx.

// LIGHT-MODE SURFACES ARE zinc-50, NOT zinc-100. tailwind.config.js overrides
// the ramp, and `zinc-100` there is #eaeaea — byte-identical to the light page
// ground these controls sit on, so every one of these discs was invisible in
// light mode and the bar read as three bare glyphs on nothing. #eaeaea is also
// what the chip was given when it first got a surface, which is how the bug
// surfaced. zinc-50 (#f5f5f7) lifts off the ground; dark mode was always fine
// (zinc-800 on zinc-950) and is unchanged.
//
// The anchor's own classes, hoisted out of the JSX so the `hidden` suffix is
// the ONLY thing that varies between the two states — the string itself has to
// stay byte-identical to the hand-written shell's (tests/baselines).
// The homescreen design draws the bar's glyph controls — back, bell — and the
// app chip beside them all the same way: periwinkle ink on a periwinkle tint
// with a hairline one step darker (--brand-ink / --brand-tint / --brand-line
// in app.css, which also carry the dark values, so no dark: variants here).
// Discs at 28px, not the design's larger circle: the header's content row is
// pinned to 28px (tests/header-height-parity.test.js, and #909 before it), so
// the ratio scales rather than the row. The hairline is inside the h-7 box
// (border-box), so the row's ceiling holds.
const BACK_BTN_CLASS = 'inline-flex items-center justify-center w-7 h-7 rounded-full'
  + ' border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)]'
  + ' text-[color:var(--brand-ink)] un-touch-target';

/** Where the header's home glyph points. NavLink owns the spelling. */
function homeHref(): string {
  const nav = (window as unknown as { NavLink?: { homeHref?(): string } }).NavLink;
  return nav?.homeHref?.() || '/';
}

/**
 * The level ABOVE an app route, as an href — or null when the route has no
 * level above it (so the slot falls back to the plain home glyph).
 *
 * ── Why this is derived and not published ──────────────────────────────
 *
 * These are the four screens whose parent is another screen INSIDE the same
 * app, and the answer is a pure function of the route. Publishing it would
 * mean an imperative call per sub-view hop — and sub-view hops never pass
 * `App._showOnlyScreen`, the usual single owner of the back-slot reset, which
 * is precisely how the session's arrow used to linger on the Board.
 *
 * ── The ladder ─────────────────────────────────────────────────────────
 *
 *   Board / Activity   →  the app itself. They are the app's dev surface, and
 *                         the app is what you were looking at before it.
 *   The general chat   →  the board. It is reached from a card there.
 *   A topic (issue,    →  the board. `activeAppView` already counts a topic
 *   proposal, gov,        as the Board for the view strip's purposes; a card
 *   shared session)       opened full-screen is still the board's content.
 *   A dev session      →  wherever it was opened from — see `sessionOrigin`
 *                         in ../improve/improve-store.js — falling back to
 *                         the board on a cold deep link, which is where the
 *                         session's own card lives.
 *
 * ── "The board" is TWO screens, and the arrow has to pick ──────────────
 *
 * Workshop and Board are one screen in two layouts, and the layout IS the
 * route. So the three rows above that read "the board" cannot spell one:
 * `#app/<slug>/board` sent a viewer who had opened an issue from the Workshop
 * to the Kanban board — a screen they had not been on — and, because that
 * route applies its own layout, rewrote their stored preference to kanban as
 * it went. `boardView` (published with the route by `Improve.setTab`) names
 * the layout that was on screen when the sub-view was entered, and
 * `boardHref` turns it into the matching address for this arrow and for a
 * session's captured origin alike.
 *
 * ── The self-hosted exception ──────────────────────────────────────────
 *
 * The platform's own app has no App tab: `App.switchTab` coerces a request
 * for one straight back to the dev forum, because its iframe target does not
 * resolve. So "up from the Board" cannot be the app there — it would bounce
 * back to the Board it just left. Returning null hands the slot to the home
 * glyph, which is the honest parent of the platform's own board.
 */
function appRouteUpHref(
  slug: string | null,
  tab: string | null,
  subTab: string | null,
  selfHosted: boolean,
  sessionOrigin: string | null,
  boardView: string,
): string | null {
  if (!slug || tab !== 'dev') return null;
  const board = boardHref(slug, boardView);
  if (subTab === 'sessions') return sessionOrigin || board;
  if (subTab === 'chat' || subTab === 'topic') return board;
  // The Board and the Activity feed themselves: up is the app.
  if (subTab === 'forum') return selfHosted ? null : `#app/${slug}/app`;
  return null;
}

export function PlatformHeader() {
  // The four elements the centering measurement needs. Passing them as refs
  // replaces the classic script's document.querySelector('header') +
  // previousElementSibling / nextElementSibling walk.
  const headerRef = useRef<HTMLElement>(null);
  const leftGroupRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);

  useHeaderLayout(headerRef, leftGroupRef, titleRef, rightGroupRef);

  // The back slot's state (see ./back-button-store.js): App.setBackIcon
  // publishes here rather than writing `hidden` into React-owned DOM.
  const { mode: backMode, href: backHref } = useStoreState(backButtonStore);
  // …and INSIDE AN APP the slot is derived from the ROUTE, not from the
  // imperative call. <AppSwitcherChip/> already gates on exactly this
  // condition — it is what swaps the chip's subtitle for the lifecycle pill —
  // so leaving the back slot to an ordering-dependent setBackIcon() call was
  // the odd one out, and it is the one that kept coming up hidden on staging
  // while the rest were right. Components agreeing by construction beats call
  // sites agreeing by convention.
  const {
    slug: backSlug, tab: backTab, subTab: backSubTab,
    selfHosted, sessionOrigin, boardView,
  } = useStoreState(improveStore);
  const routeUp = appRouteUpHref(
    backSlug, backTab, backSubTab, selfHosted, sessionOrigin, boardView,
  );
  // An app route that has a level above it wins over the imperative call;
  // everything else keeps whatever the last setBackIcon() published, which on
  // a platform screen is 'home' by default and 'arrow' where that screen owns
  // a sub-level of its own (a Settings section, a Browse detail, a thread).
  const mode = routeUp ? 'arrow' : backMode;
  const backArrow = mode === 'arrow';
  const resolvedBackHref = routeUp
    || (mode === 'home' ? homeHref() : backHref);

  // A LAYOUT effect, and that is load-bearing: it runs inside main.tsx's
  // flushSync(hydrateRoot), which is after hydration has adopted these nodes
  // and still before DOMContentLoaded — where the classic scripts' own init()
  // used to run. A passive effect could be scheduled after app.js's init, and
  // `sv:authed` fires at most once, so a late Notifications listener would
  // never get the first fetch.
  useIsomorphicLayoutEffect(() => {
    window.NodePill?.init();
    window.WalletSheet?.init();
    window.NativeAppVersion?.init();
    window.Notifications?.init();
  }, []);

  // Chromeless mode hides the bar and floats the "Open in Homeroom" pill in
  // its place; App.setChromeless publishes the flag, this reads it.
  const visible = useVisibility('platform-header', true);
  useHiddenClass(headerRef, !visible);

  return (
    <>
      {/*
          Top bar.
          Layout note: the title is *absolutely* positioned at the geometric
          center of the header (left:50%, translate-x:-50%) rather than living
          between two flex spacers. The flex-spacer approach drifted the title
          leftward as right-side icons accumulated, because the spacers split
          only the space *not* consumed by content — so an unbalanced left/right
          made the title's center point unbalanced too. Absolute positioning
          decouples the title from the flow entirely, so left and right groups
          can grow independently without ever moving it. `pointer-events-none`
          prevents the (potentially overlapping) title from blocking icon
          clicks; `truncate` + max-width keeps long app names from running
          into the right-side group.
      */}
      {/*
          Two-mode header: title is *viewport-centered* when there's room
          for it without overlapping the back-btn area or the variable-width
          right group, otherwise it falls back to *flex-flow* (left-aligned,
          truncating from the right). The mode switch is driven by
          ./use-header-layout.ts, which observes header / right-group /
          title size changes and toggles `.is-centered` accordingly.
          
          Layout invariants:
          - The back-btn wrapper is always 20px wide (`w-5 shrink-0`) so
          toggling the button's `hidden` class doesn't collapse the
          leftmost column and shift the title.
          - The right group has `ml-auto` so when the title goes absolute
          (centered mode) and is removed from flex flow, the right group
          still sits at the right edge instead of collapsing next to the
          back-btn.
          - The title's default state is flow mode (left-aligned). JS
          upgrades to centered after measurement, so first paint is safe
          even if the JS is slow to run.
          
          `gap-4` between the three groups, not `gap-3`: the chip is the one
          control on this bar that carries a NAME, and at 12px it sat tight
          against the back chevron on its left and the right group's discs on
          its right, reading as part of a run of controls rather than as the
          thing the bar is about. The gap is horizontal only, so the height
          invariant below is untouched.

          HEADER HEIGHT INVARIANT (see the matching block in
          public/css/app.css): this bar is `py-3` around a 28px content
          row, so it is 52px + safe-area on EVERY screen. The row height
          must not depend on which children happen to be present — the
          `h-7` on the back-btn wrapper below is the floor (it survives
          #header-title being display:none in the native WebView), and no
          direct child may exceed 28px (the ceiling).

          It was 53px until the reskin: there used to be a 1px `border-b`
          hairline here, and the border box counted it. The widget language
          draws NO rule under a top bar — the page ground runs to the top of
          the screen and the controls float on it — so the hairline went,
          from this bar and from #landing-header together. Parity is the
          invariant, not the number: both bars lost the same pixel.
      */}
      {/*
          THE BAR'S OWN SURFACE, and why it is zinc-200 rather than the
          zinc-50 every control on it uses.

          The bar was transparent until now: the body ground (zinc-100
          #eaeaea light, zinc-950 #0b0b0c dark — frontend/scripts/build-shell.mjs)
          ran straight through it. Giving it a surface has to clear the trap
          the BACK_BTN_CLASS comment above describes from the other side: the
          discs on this bar are zinc-50, so painting the bar zinc-50 would
          make all three of them vanish into it, which is the #eaeaea bug
          again with the operands swapped. zinc-200 (#e3e3e6) goes the other
          way — a shade DARKER than the page ground, so the bar reads as its
          own surface, and the zinc-50 discs still lift off it. Dark mode is
          the same relationship every sheet already uses (zinc-900 on
          zinc-950; cf. notifications-sheet.tsx, anchored-panel.tsx).

          `rounded-b-2xl` + `-mb-2` is the "eats into the app area" corner: a
          16px radius curves the bar's bottom corners away so the page ground
          shows through the two notches, and an 8px overlap onto the next
          sibling puts that curve slightly INSIDE the area below, which is
          what makes the content read as having rounded top corners. The
          overlap is deliberately half the radius: every screen root below
          opens with its own padding, so 8px comes out of that padding rather
          than off the top of a card, and nothing is clipped at rest.
          It was `rounded-b-lg` + `-mb-1` (8px over 4px) until #1571, which
          asked for a corner that reads as INTENDED rather than as a
          rendering artifact — doubling it is the whole of that half of the
          request. Keep the two in step: the overlap is half the radius, and
          features/dev-chat/view.tsx's #dc-session-header carries the same
          radius token because it is the second bar on that screen
          (tests/dev-chat-view.test.js pins them to each other).

          WHAT THIS CORNER CANNOT REACH, and what does instead: the notch is
          cut out of the BAR, so it needs the bar to have a surface. On the
          wallpaper routes it has none — app.css clears it so the ground runs
          to the top of the screen — and #app-view is one of them. There the
          radius belongs to the app frame itself; see "THE APP SHEET" in
          app.css for the whole of that argument. The two mechanisms do not
          overlap: #app-frame-host is the only opaque thing below this bar,
          and every other root is transparent and has nothing to round.
          `z-10` is load-bearing — #home-screen and #messages-screen set
          `position:relative` with z-index:auto, so without it two positioned
          siblings paint in DOM order and the screen wins.

          ON THE HOME ROUTE AND INSIDE AN APP THE SURFACE IS CLEARED. app.css
          paints the home wallpaper on the body and sets this bar's background
          to transparent under `body:has(#home-screen:not(.hidden))` and
          `body:has(#app-view:not(.hidden))`, so the cream ground and its
          star run up behind the bell as the design draws them — and the bar
          is the same object on both sides of the launcher → app push, so
          that push has nothing to animate in it. The zinc-200 here is what
          every other route still gets.

          No `overflow-hidden` here, ever: see the badge rule in app.css and
          tests/header-height-parity.test.js. Height is untouched — the radius
          and the negative margin are both outside the border-box padding
          contract that tests/header-height-parity.test.js pins.
      */}
      <header
        ref={headerRef}
        id="platform-header"
        className={'un-safe-top-extend relative z-10 flex items-center gap-4 px-4 pt-3 pb-5 shrink-0'
          + ' bg-zinc-200 dark:bg-zinc-900 rounded-b-2xl -mb-2'}
      >
        {/*
            The LEFT group: the back chevron when there is somewhere to go
            back to, then the chip. Nothing else, and NO RESERVED SLOT.

            #1443 took the fixed 28px box out. It existed to keep the title
            from shifting as the back anchor came and went, and with the
            title centred that mattered; the chip is flush left and the box
            was simply an inch of dead space at the top-left of every root
            screen — which is what "there's an extra space for an icon right
            now that isn't used" was. `#back-btn` is a direct child now, so
            `hidden` collapses it and the chip moves to the edge.

            The house glyph went with it, on the same reasoning — and came
            back, because the box going away is what made it affordable: the
            group is `hidden` when the slot is empty, so the house occupies
            space only on the screens that have somewhere to send you, rather
            than reserving an inch at the top-left of every one. The slot
            means one thing either way — leave this screen upward — and the
            glyph says how far: a level, or all the way home.
        */}
        {/*
            `hidden` when it holds nothing, and that is not cosmetic: the
            header's own `gap-3` applies to this element as a flex ITEM, so an
            empty-but-present group still reserved 12px and the chip started at
            x=28 instead of the header's own 16px padding. `display:none`
            removes it from the flex layout, gap included. Measured, not
            assumed — see the browser check in the commit for this change.

            Derived from the same two flags the children use, so there is no
            third source of truth about whether this group has content.
        */}
        <div
          ref={leftGroupRef}
          className={'h-7 shrink-0 flex items-center gap-1.5 min-w-0'
            + (mode === 'none' ? ' hidden' : '')}
        >
          {/*
                #1036: a real anchor, not a button, so cmd/ctrl-click,
                middle-click and right-click → "Open in new tab" work on it.
                Its href is maintained by App.setBackIcon(mode, href) — the
                single choke point every screen entry already goes through
                (App._showOnlyScreen). `inline-flex items-center` keeps the
                20px icon centred: an <a> is `inline` where a <button> was
                `inline-block`, and while this element is a flex item today
                (so it is blockified anyway) the 28px header content-row floor
                is load-bearing enough not to leave to that. No target=_blank:
                in the native WebView that would push a plain tap out to the
                system browser.

                RENDERED FROM A STORE, not written by classList from outside.
                setBackIcon used to toggle `hidden` on these nodes directly,
                which held only while this island never re-rendered. It does
                now — the chip re-renders on every lifecycle change — and React
                rewrites a rendered className from its own props on every
                render, so the legacy write was being undone. The store is
                ./back-button-store.js; setBackIcon publishes into it.

                THE HOUSE IS BACK, so the anchor has two children again and
                its `hidden` is no longer the whole of the visibility state.
                #1443 retired the house on the grounds that the chip's menu
                carries a Home row an inch to its right — true, and the cost
                was that the app itself, Profile, Settings, Admin and Messages
                offered nothing in the bar at all. Those screens keep a back
                or home button. Home and the top-level Browse list share the
                same root header (#1569), so only those two hide this slot;
                their navigation menu still provides the route between them.
            */}
          <a
            id="back-btn"
            className={BACK_BTN_CLASS + (mode === 'none' ? ' hidden' : '')}
            aria-label={backArrow ? 'Back' : 'Home'}
            {...(resolvedBackHref ? { href: resolvedBackHref } : {})}
          >
            {/*
                BOTH GLYPHS SHIP, exactly one is shown. Rendering only the
                active one would take `#back-icon-arrow` out of the cold
                document whenever the initial mode is not 'arrow' — and the
                shipped markup's id inventory is a contract
                (tests/shell-id-inventory.test.js, and dapp.json selectors
                written against it). Two nodes toggling a class is cheaper
                than an id that comes and goes.
            */}
            <ChevronLeftIcon
              id="back-icon-arrow"
              className={backArrow ? 'w-5 h-5' : 'hidden w-5 h-5'}
            />
            <HomeIcon
              id="back-icon-home"
              className={backArrow ? 'hidden w-5 h-5' : 'w-5 h-5'}
            />
          </a>
        </div>
        {/*
            The chip: the screen's only h1, and on every screen but a dev
            session a tappable "(avatar) name ⌄" control that opens the
            switcher menu. #1431 gated it on being inside an app; #1443
            made it unconditional, which is what lets every other header
            slot go. See app-switcher-chip.tsx.
        */}
        <AppSwitcherChip titleRef={titleRef} />
        {/* `gap-2.5`, not `gap-1`. The bell and Improve are an ALERT and an
            ACTION — one tells you something happened, the other starts work —
            and at 4px they read as two halves of one segmented control, which
            is what "they look joined together" was. 10px is the smallest gap
            that separates them without the right group growing enough to
            change the title's centred-vs-flow decision on a 390pt screen. */}
        <div ref={rightGroupRef} className="ml-auto shrink-0 flex items-center gap-2.5">
          {/*
              HEADER SLIM-DOWN: the fork label, the platform + app build pills
              and the kudos-budget badge used to live here as four inline
              slots. They are rows of the slide-out drawer now — same element
              ids, same renderers, just a new parent: the kudos + AI-credit
              meters in its status pane (#drawer-status-pane), the two build
              lines + fork label in its bottom-anchored footer
              (#drawer-footer). The trophy (#leaderboard-btn) became
              #drawer-row-leaderboard and the admin shield
              (#admin-dashboard-btn) became #drawer-row-admin.

              THE UI OVERHAUL took four more out, and they all went to the
              same place — the Improve panel:

                #app-mode-switch   the App/Dev segmented control. An app is
                                   just an app now; "Dev" is a destination the
                                   panel links to rather than a mode the header
                                   toggles. `#improve-btn` inherits its exact
                                   show/hide lifecycle.
                #feedback-btn      → the panel's "Give feedback" row. Its
                                   outbox dot (#feedback-queue-dot) moved onto
                                   #improve-btn, keeping its id and its writer.
                #work-drawer-btn   → the panel's session sections, split into
                                   this app's and everything else.
                #dev-console-btn   → the panel's "Developer terminal" row,
                                   shown on the same DevConsole signal that
                                   used to show the button.

              What is left here is navigation + alerting only, in DOM order:
              improve, bell, hamburger (last).
          */}
          {/*
              Node status + wallet (native app chrome absorbed into SV,
              NATIVE-BRIDGE.md) live as rows in the slide-out drawer below —
              never here in the header. See #drawer-row-node /
              #drawer-row-wallet, populated by ./node-pill.js /
              ./wallet-sheet.js in the native top frame. Capability and state
              availability change their contents, never whether the rows exist.
          */}
          {/*
              The Improve button. It MUST stay inside this right-group div:
              rightGroupRef is what use-header-layout.ts measures as the
              title's right side group, so a control moved out of it stops
              counting towards the clearance the centering measurement needs.
              (Until #1079 chunk B the group was resolved as the <h1>'s
              nextElementSibling, and a sibling wedged in between broke the
              measurement silently; the ref removed that particular trap, not
              the requirement.)

              Unlike everything else in this bar it is React-owned end to end —
              no public/js/** module writes to it — so its className is
              rendered rather than constant. See ../improve/improve-button.tsx.
          */}
          {/*
              The App / Feed / Kanban segmented control rode here between
              #1367 and the Streamlined Concept. The app-context sheet behind
              the center title tab is the view switcher now — a segmented
              control and a dropdown tab announcing the same three
              destinations would be two owners of one decision.
          */}
          {/*
              MESSAGES and NOTIFICATIONS, as the board's app-opened bar draws
              them: a glyph each, carrying its own unread badge. Only the
              bell survives here — see the #1443 note in RETIRED_IDS for
              where the chat bubble went.

              IT SITS TO IMPROVE'S LEFT, which is the arrangement the board
              draws and the one this bar has always had. It was moved to the
              far right for a round on the argument that a standing alert
              wants a fixed address and Improve's width moves it; the
              arrangement was preferred as it was, so the alert reads inward
              from the edge and the ACTION owns the corner your thumb reaches
              for. Both orders are defensible — this is the one we ship, and
              a declared check pins it so it does not drift back by accident.

              THE UI OVERHAUL folded both into the hamburger and the
              Streamlined Concept takes that back, for a reason the drawer
              makes concrete: that drawer is the APP's surface now (its views
              and its changes), so platform-wide alerting has no business
              inside it. Real anchors, so a modified click opens a tab, and
              the same hrefs the retired drawer rows carried.

              Both badges keep the ids and the writer they had as rows
              (Notifications._renderBadge), so nothing about how a count is
              computed changes — only which control wears it.

              THEY OPEN SHEETS, and they stay real anchors anyway. A plain
              click presents the sheet over the screen you are on, with no
              hash write and so no history entry to back out of — which is
              the whole point of them not being screens. A modified click is
              left alone and opens the href in a tab, where the same hash is
              a deep link that resolves to a screen and presents the sheet
              over it. `NavLink.isNativeClick` is what tells the two apart,
              and it is checked BEFORE preventDefault — the rule
              tests/nav-new-tab.test.js pins across the whole shell.
          */}
          <a
            id="notifications-btn"
            href="#notifications"
            className="relative w-7 h-7 flex items-center justify-center rounded-full un-touch-target border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)] text-[color:var(--brand-ink)]"
            aria-label="Notifications"
            aria-haspopup="dialog"
            onClick={(event) => {
              if ((window as any).NavLink?.isNativeClick?.(event)) return;
              event.preventDefault();
              (window as any).NotificationsSheet?.toggle?.();
            }}
          >
            <BellIcon className="w-5 h-5" />
            <span
              id="notifications-badge"
              /*
                 Constant, and deliberately so. Notifications._renderBadge
                 overwrites it with the live count of unread finished dev
                 sessions, which is what a declared check selects on to prove
                 the badge is showing BECAUSE work completed. Rendering it as
                 a constant keeps the prerender, the first client render and
                 React's reconciliation all agreeing on "0", so the painted
                 value is never patched back out.
              */
              data-session-done="0"
              className="hidden absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-bold flex items-center justify-center"
              aria-label="Unread notifications"
            >
            </span>
          </a>
          <ImproveButton />
          {/*
              The "Create new app" entry point used to live here in the header
              as a "+" pill; it's been moved into the home-screen feed itself,
              rendered below the app list (and as the empty-state CTA when no
              apps exist). See frontend/src/features/home/home.js.
          */}
        </div>
      </header>
      {/*
          The chromeless-mode pill, mounted as a SIBLING of the bar it replaces
          (App._mountChromelessPill used to document.body.appendChild it, which
          put an un-hydrated node inside a body React now owns). It renders
          nothing at all until the flag flips, which is exactly what the shipped
          markup had here.
      */}
      <ChromelessPill />
    </>
  );
}
