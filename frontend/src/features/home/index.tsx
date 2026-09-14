/**
 * The home screen — `#home-screen`, the launcher grid a signed-in viewer lands
 * on (#1083 chunk F, step 4; the last of the chunk's four regions).
 *
 * ── What the island owns ───────────────────────────────────────────────
 *
 * The screen's STRUCTURE, and nothing else: the pull-to-reveal search bar, the
 * `.home-column` body, and the hosts inside it. THIS component renders once and
 * never again — it holds no state, and the only effect it runs is the
 * visibility subscription below. What lives inside it has moved on, one host at
 * a time:
 *
 *   * `<AppGrid/>`, `<WidgetStrip/>` and `<AppsMore/>` are stateful islands
 *     rendering plain view models `home.js` pushes (./grid-store.ts and
 *     ./chrome-store.ts);
 *   * `<DiscoverSection/>`, `<ChallengesSection/>` and `<CreateSection/>` are
 *     the same arrangement for the three blocks below the grid, from
 *     ./panels-store.ts.
 *
 * ── FOUR AREAS, in this order ──────────────────────────────────────────
 *
 * THE UI OVERHAUL gave this screen a shape: Your apps, Discover, Challenges,
 * Create app, stacked. The last three used to be draggable WIDGETS on the
 * launcher canvas — see the block comment beside them below for what that
 * traded away and why the fixed order is worth more than the freedom was.
 *
 * That is deliberate rather than incidental. Two things depend on it:
 *
 *   * **The search input keeps its focus and caret.** `Home.render()` replaces
 *     `#app-list`'s innerHTML on every WS app event and every keystroke, so the
 *     input has always had to live OUTSIDE the grid — that is why the bar is the
 *     scroller's first child and not part of it. Rendering it from React would
 *     regress the same thing in a new way if the island ever re-rendered, so it
 *     doesn't: `#home-search-input` is emitted once at hydration and no React
 *     update ever touches it again.
 *   * **Drag-to-rearrange stays with PlatformUI and the native kit.** The
 *     gesture, its grid overlay, the drop-cell maths and the layout write all
 *     stay in `home.js`, driving `#app-list`'s own children. React never
 *     reconciles inside that subtree, so a drag cannot race a render.
 *
 * ── What is stateful, and what that cost ───────────────────────────────
 *
 * The stateful-island rule (AGENTS.md): a region may hold state only when its
 * whole subtree is React-owned. This screen shipped with none — every dynamic
 * part of it was written by a `public/js`-era module — and it has gained three,
 * each paid for by moving that module's RENDERER (not its data, not its
 * gestures) across the line:
 *
 *   * `#app-list` (#1191): `Home.render()` computes a view model instead of an
 *     HTML string. The layout engine, the WS fan-out, the drag geometry and
 *     the kit attachment all stayed in home.js.
 *   * `#home-widget-strip-section` and `#home-apps-more`: the same split for
 *     the two hosts outside the canvas, on the same push.
 *   * the three panel sections: `HomePanels.render()` computes three view
 *     models where it used to build ~800 lines of HTML string and then
 *     re-attach eight families of listener over the result.
 *
 * Nothing on this screen is an `innerHTML` host any more. The data, the
 * fetches and the gestures all stayed where they were.
 *
 * `data-revealed` on the search bar is written by `home.js` at runtime through
 * `dataset`, which is safe for exactly the reason
 * `frontend/src/lib/legacy-dom.ts` documents: React renders its `className`
 * once, as a constant prop, and never writes the attribute again. The two
 * `hidden` toggles that used to sit beside it are React's own state now.
 *
 * ── Visibility ─────────────────────────────────────────────────────────
 *
 * `#home-screen` is the first converted root that ships VISIBLE, so
 * `shippedVisible` is `true` here where every other island passes `false`. The
 * matching read-side change is in `App._isScreenVisible` (public/js/app.js),
 * which now falls back to the DOM for a converted screen nobody has published
 * yet — see the comment there.
 *
 * ── Prerender parity ───────────────────────────────────────────────────
 *
 * The initial render is byte-for-byte the markup the hand-written shell shipped:
 * an empty widget strip, an empty grid, an empty panels section, and no `hidden`
 * on the root. Nothing fetches from render — `Home.load()` is still called by
 * app.js's router.
 */

import { useRef } from 'react';

import { SearchIcon } from '@/components/ui/icons';

import { AppGrid } from './app-grid';
import { AppsMore } from './apps-more';
import { ChallengesSection, CreateSection, DiscoverSection } from './panels/sections';
import { SectionHeading } from './panels/ui';
import { WelcomeBanner } from './welcome-banner';
import { WidgetStrip } from './widget-strip';

import { useVisibilityHiddenClass } from '../../lib/visibility-store';

// The three modules that fill this screen, imported in the order their
// <script> tags had: HomeLayout (pure geometry) is read by both of the others,
// and home-panels.js is read by home.js's grid renderer. Each still publishes
// its global for the classic half — see the note at the bottom of each file.
import './home-layout.js';
import './home-panels.js';
import './home.js';

export function HomeScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'home-screen', true);

  return (
    <main ref={screenRef} id="home-screen" className="flex-1 overflow-y-auto" style={{ position: 'relative' }}>
      {/*
          Hidden-until-pulled search bar (iOS idiom). Deliberately the FIRST
          child of the scroller and NOT sticky: it occupies real scroll space
          above the content, so Home._searchReveal can park the scroller at
          scrollTop = <bar height> and a slight pull down (a scroll up on
          desktop) slides it into view. Keep pulling once it is fully shown
          and the kit's pull-to-refresh takes over — attachPullToRefresh only
          engages from scrollTop 0, so the two stages compose with no extra
          gesture code.
          Still OUTSIDE #app-list: Home.render() wholesale-replaces the
          grid's innerHTML on every WS app event and every keystroke, and the
          input must keep its focus/caret through those re-renders. Wired
          once by Home._wireSearch().
      */}
      {/*
          NO background of its own. It carried `bg-white dark:bg-zinc-950`,
          and in light mode that painted a white band across a #eaeaea page —
          a slab around the input rather than a field sitting on the ground.
          The bar is a real scroll-space child and never sticky, so nothing
          passes underneath it and there is nothing for an opaque fill to
          hide. Letting the page ground show through is both the correct
          colour and the one that cannot drift if the ground ever moves.
      */}
      <div id="home-search-bar" data-revealed="false">
        {/*
            The bar's box stays full-bleed; only its content sits in the
            1024px column, and the px-3 gutter lives here (not on the bar) so
            this column's content edges match #home-body's exactly.
        */}
        {/*
            #1951: the field spans the column. It was capped at `max-w-xl`
            (576px) and sat against the column's LEFT edge, so on anything
            wider than a phone it read as off-centre and short of the content
            below it. Uncapped, it lines up edge to edge with #home-body, and
            the column itself is what centres it.
        */}
        <div className="home-column px-3 pt-3 pb-2">
          <div className="relative w-full">
            <SearchIcon
              className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none dark:text-zinc-400"
              aria-hidden="true"
            />
            <input
              id="home-search-input"
              type="text"
              autoComplete="off"
              placeholder="Search your apps…"
              aria-label="Search your apps"
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 pl-9 pr-9 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:border-violet-400 dark:focus:border-violet-600"
            />
            <button
              id="home-search-clear"
              className="hidden absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-500/10 text-base leading-none dark:text-zinc-400"
              title="Clear search"
              aria-label="Clear search"
            >
              &times;
            </button>
          </div>
        </div>
      </div>
      {/*
          .home-body-fill (app.css) makes this a min-height:100% flex column:
          the min-height guarantees the scroller can always be scrolled by at
          least the search bar's height, even with an empty "Your apps" — a
          short page would otherwise leave the bar permanently on screen.
          (It used to do double duty as the flex context for
          .home-bottom-anchor on the two trailing sections; those are widgets
          in the grid now, so nothing below the grid is anchored any more.)
      */}
      <div id="home-body" className="home-column home-body-fill">
        {/*
            #1561: the once-per-account explainer. Above everything, because
            it is the thing a first-time viewer needs before the grid means
            anything; always in the document and `hidden` until its effect
            says otherwise, which is what keeps the prerender byte-identical.
        */}
        <WelcomeBanner />
        {/*
            iOS in-app only: the "Homeroom widget" editing strip, mirroring
            the pinned grid the homescreen widget renders. It lives ABOVE the
            launcher grid rather than inside it — a full-width flow item
            cannot coexist with the explicit cell placement #app-list now
            uses. Stateful (chromeStore), and it ships EMPTY and hidden
            everywhere but the iOS app — see widget-strip.tsx for what the
            component took over from Home._wireWidgetStrip and what it left
            there.
        */}
        <WidgetStrip />
        {/*
            ── AREA 1 of 4: YOUR APPS ─────────────────────────────────

            THE LAUNCHER GRID. Every child is placed at an explicit
            (column, row) cell by Home.render() — so a viewer's arrangement
            can have holes in it, exactly like a phone home screen. Nothing
            here flows.

            FOUR COLUMNS AT EVERY WIDTH, and two rows by default. It was
            `grid-cols-4 sm:grid-cols-5` until THE UI OVERHAUL: a launcher
            reads as a launcher at phone density, and a second breakpoint
            bought a fifth column at the price of a whole second stored
            layout per viewer (see the note this removed in
            features/home/home-layout.js). The desktop grid is width-capped
            by .home-column rather than stretched, so four columns there are
            four bigger tiles, not four tiny ones with a gulf beside them.
            HomeLayout.COLS mirrors this and tests/home-layout-model.test.js
            greps both files.

            `grid-auto-rows` and `position: relative` (needed by the
            drag-time grid overlay) live in app.css. How many rows the
            collapsed grid draws is Home.visibleRowBudget: as many as fit in
            the first two-thirds of the screen, floored at
            HomeLayout.DEFAULT_ROWS. Either way it is a cap on what is SHOWN,
            never on what a viewer may have — a ninth app grows the grid
            rather than being stranded.

            NO TOP PADDING ON THIS SECTION. It used to carry `pt-1.5 sm:pt-2`
            on top of the `pt-1.5 sm:pt-2` #app-list already has, so the first
            row of tiles sat a doubled gutter below the header for no reason
            anybody could point at. The grid keeps its own — and it has to,
            because `.home-grid-overlay`'s inset mirrors #app-list's padding
            EXACTLY (app.css says so, twice, once per breakpoint) and
            Home._rectForCell measures those overlay cells to land a committed
            drop. Trim the padding here, never there.
        */}
        <section id="home-apps-section" className="px-3">
          {/*
              The area's label, in the same treatment the four below it use —
              see ./panels/ui.tsx's SectionHeading for why every area on this
              screen is now "grey label, then the thing". This one is what the
              reference screen calls "Your saved apps"; "Your apps" is the name
              the rest of the product already uses for the same set (the tile
              menus' "Add to Your apps", the browse screen's badge), and two
              names for one collection is worse than a shorter label.
          */}
          <SectionHeading>Your apps</SectionHeading>
          <AppGrid />
          {/*
              "Show all N apps" — revealed by Home.render() only when the
              viewer has more than the visible rows hold. Ships hidden
              and empty; it is React's now (chromeStore), which is what lets
              its listener be attached once instead of on every paint.
          */}
          <AppsMore />
        </section>
        {/*
            ── AREAS 2-4: DISCOVER, CHALLENGES, CREATE APP ────────────

            These three were WIDGETS until THE UI OVERHAUL — draggable blocks
            placed on the launcher canvas alongside the app tiles, each with
            its own footprint, its own anchor cell and a per-column-count
            size table. They are fixed sections in a fixed order now, and the
            drag gesture applies to app tiles alone.

            What that bought: the home screen has a shape you can describe.
            "Your apps, then what to try next, then what the group is working
            towards, then make something" is a page; the same four things at
            wherever-you-dropped-them was a canvas with no reading order, and
            it made every one of them optional in a way none of them are.

            Each renders its own host now (./panels/sections.tsx) from a view
            model HomePanels.render() pushes — the three `innerHTML` hosts and
            the `_stampState` pass that mirrored each block's state up onto
            them went together. All three still ship EMPTY and un-hidden: the
            panels cache is fetched, so drawing anything at hydration would
            disagree with the prerendered document.

            `data-panel-slot` rides along from the grid host each one
            replaces. It names WHICH block a host is for, which is as true of
            a section as it was of a cell, and it is the hook everything
            outside this file already selects on: the dapp.json checks
            (`[data-panel-slot="create"][data-create-enabled="true"]`) and the
            screenshot assertions. That selector is why the block's own state
            attributes appear on the host as well as on the block — one model
            now feeds both, rather than a second pass copying one to the
            other.
        */}
        <DiscoverSection />
        <ChallengesSection />
        <CreateSection />
        {/*
            THE "YOU" AREA IS GONE, and Profile did not go with it. A fifth
            area held one row — an avatar, "Profile", "Your points, settings
            and account" — as the entrance the retired hamburger took away.
            The chip's menu has carried that entrance since #1443: a "You"
            group with #switcher-row-profile and #switcher-row-settings in
            it, pinned by the destination-order check in dapp.json. So the
            row was a second door to the same screen, on the one screen
            people open to reach their apps, and the design's own answer is
            a Profile tab in a bottom bar rather than a card at the foot of
            the launcher. Home ends on "make something" now.

            App.applyUserAvatar went with it: Home's pair was the only one
            left (the header chip's copy was retired in the same #1443
            round), so the function had no nodes to write to. Profile's own
            editor re-reads the picture from App.user when it saves.
        */}
        {/*
            #home-panels — the widgets' FALLBACK host — is gone with the
            placement it existed for. It caught the moment before the first
            grid paint and the active-search view, because a widget that
            lived IN the grid vanished whenever the grid did. The three
            sections above are outside #app-list and never re-rendered by a
            search keystroke, so there is nothing left to catch.
        */}
      </div>
    </main>
  );
}
