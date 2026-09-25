// The Leaderboard screen (#leaderboard) as a React island — #1083 chunk F
// step 3, and the biggest of the four regions by module count: five legacy
// modules retire into the bundle with it.
//
// ── What the screen is ─────────────────────────────────────────────────
//
// One screen, four top-level SECTIONS, one pane visible at a time:
//
//   topochain   #topochain-leaderboard-root   TopochainLeaderboard
//   kudos       #leaderboard-root             Leaderboard itself
//   challenges  #challenges-root              TopochainChallenges   (default)
//   seasons     #leaderboard-history-root     LeaderboardHistory    ("History")
//
// The two Topochain-domain sections share one event selection, rendered into
// #leaderboard-event-bar by TopochainEventContext and hidden on Kudos.
//
// ── What this island owns, and what it does not ────────────────────────
//
// It owns the FRAME — the <main>, the column, the five hosts — and
// the SECTION TAB STRIP, which is the one piece of DOM that actually changes
// hands here. Everything below a host is still the owning module's innerHTML,
// exactly as in chunks A–E: React owns the container, the module owns the
// subtree.
//
// The strip is the screen's only state. `Leaderboard._renderSectionTabs()`
// used to innerHTML three buttons into #standings-tabs and bind a click
// handler; it now publishes the active section through ./section-store.ts and
// this component renders the strip from the Tabs primitive. The click goes
// back the way it came — a trigger calls `Leaderboard._setSection(key)`, which
// is exactly what the innerHTML'd button's listener did, so hash syncing, pane
// visibility and each guest module's lazy mount all still run in the module.
//
// Pane visibility deliberately did NOT move. `_applySection()` keeps
// `classList.toggle('hidden', …)`-ing the three pane roots and the event bar,
// which is safe for the reason lib/legacy-dom.ts documents: React renders
// their `className` as a CONSTANT prop, writes it once at hydration and never
// again, so a legacy toggle is never clobbered by a re-render. Making them
// stateful would mean owning a lifecycle — lazy mount, teardown on close,
// in-flight fetch guards — that lives in three separate modules; that is the
// next conversion, not this one.
//
// ── Prerender parity ──────────────────────────────────────────────────
//
// The first render must be the hand-written shell character for character, so
// the strip renders EMPTY until the store reports `mounted` (it flips on the
// screen's first open, from _renderSectionTabs) and only the DEFAULT section's
// hosts ship visible: #challenges-root and the event bar, while
// #leaderboard-root and #topochain-leaderboard-root ship hidden (#2374 swapped
// the last two — a pane shipped visible that is not the default paints for a
// frame before _applySection runs). Visibility of the screen itself comes from the store:
// App._showOnlyScreen publishes (screenId, visible) for every id in
// App.REACT_SCREEN_IDS and useVisibilityHiddenClass writes the class
// synchronously inside that notification, because _showOnlyScreen runs inside
// PlatformUI.transition(fn) and the native kit snapshots the DOM before fn
// returns. `false` is the shipped state.

import { useRef } from 'react';
import {
  SECTION_TAB_ACTIVE,
  SECTION_TAB_INACTIVE,
  SECTION_TABS_LIST,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { useScrollFade } from '../../lib/use-scroll-fade';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { useLeaderboardSection } from './section-store';
import './kudos.js';
import './topochain-event-context.js';
// ./mount imports all three pane controllers and plants each one's store on
// it. Importing any of them directly here would publish its global without a
// store and leave that pane permanently blank.
import './mount';
import { EventBar } from './event-bar';
import { KudosPane } from './kudos-pane';
import { TopochainStandingsPane } from './topochain-standings';
import { ChallengesPane } from './challenges-pane';
import { HistoryPane } from './history-pane';
import { topochainChallengesStore } from './topochain-challenges-store.js';

// The strip, in TAB ORDER. Moved here verbatim from the template that
// _renderSectionTabs used to hold, labels included: the standings tab is
// labelled simply "Leaderboard" because it is the primary ranking on this
// platform and the screen's own title, and the `key`s are the platform's
// vocabulary for these tabs — every hash alias in app.js and every dapp.json
// check speaks in them, and Leaderboard.SECTIONS still validates against them.
//
// #1917 reordered the strip to Challenges → Kudos → Leaderboard: what you can
// do next leads, the ranking it feeds comes last. Only the ORDER moved — the
// keys and labels are as they were. #2374 then made the first tab the default
// section too, behind a bare #leaderboard.
//
// The navigation prototype names this page's segments Challenges, Standings,
// History and Kudos, and two of those are this change:
//
//   * HISTORY is new — the seasons that have ended and who won them
//     (./history.js). It sits right after the standings because it IS past
//     standings, and last because it is the least-visited; #1917's order for
//     the other three is kept.
//   * the standings tab is labelled "Standings", the prototype's word and the
//     one the Me row that leads here uses ("Challenges & standings"). It was
//     "Leaderboard" because it was the screen's own title too; the screen's
//     <h2> is gone (the bar names the tab now, see Leaderboard._syncTitle),
//     so the label no longer has to double as one. Its KEY stays `topochain`
//     — every hash alias and dapp.json check speaks in keys.
//
// History's key is `seasons`, not `history`: #leaderboard/history has long
// been the Kudos pane's "My history" sub-view, and a deep link must keep
// meaning what it meant.
const SECTION_TABS = [
  { key: 'challenges', label: 'Challenges' },
  { key: 'kudos', label: 'Kudos' },
  { key: 'topochain', label: 'Standings' },
  { key: 'seasons', label: 'History' },
];

// Four labels at the strip's px-4 are wider than a 390px phone's column, so
// the triggers tighten to px-2 below `sm` — the same track, the same face —
// and the list scrolls sideways rather than wrapping on anything narrower
// still (a 320px phone). Complete literals, for Tailwind's extractor.
//
// The scrollbar stays hidden, so the scroll is shown instead (QA 2026-09-24
// Q21): useScrollFade fades whichever edge has more beyond it and brings the
// selected tab into view. At 360px the strip used to end on "Histo" with
// nothing to say it went on. (px-2, not px-2.5, since the same fix: at 390
// the four labels overflowed their track by 4px.)
const STRIP_TAB = 'inline-flex items-center justify-center h-8 px-2 sm:px-4 rounded-full text-sm font-semibold transition-colors shrink-0';
const STRIP_LIST = `${SECTION_TABS_LIST} max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`;

// Me's reading column, which the Kudos pane takes (see its root below). The
// strip steps into it too while Kudos is showing, so the strip's left edge is
// the list's rather than the wide frame's — 176px to the left of it on a
// desktop, which read as the tab belonging to some other page.
const KUDOS_COLUMN = 'max-w-[40rem] mx-auto';

export function LeaderboardScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'leaderboard-screen', false);
  const { mounted, section } = useLeaderboardSection();
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stripFade = useScrollFade(stripRef, `${mounted ? 1 : 0}:${section}`);
  // A challenge's detail page is a LEVEL of this screen (see
  // ./challenges-pane.tsx): while one is open the platform header is its nav
  // bar, and the screen's own title, tab strip and event bar step aside so the
  // page takes their place. Null in the prerender, so the shipped markup is
  // unchanged.
  const detailOpen = (useStoreState(topochainChallengesStore) as { detail: unknown }).detail != null;

  return (
    <main
      ref={screenRef}
      id="leaderboard-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll [scrollbar-gutter:stable]"
      style={{ position: "relative" }}
    >
      {/*
          max-w-5xl for the Topochain table's sake (and the challenge grid's);
          the Kudos pane narrows to the Me/Workshop reading column below.

          `pt-5`, not `p-4`'s 16px (#2832's rule, applied here for Kudos): the
          platform bar is `rounded-b-2xl -mb-2`, so every screen root starts
          8px UNDER it; `pt-5` is those 8 plus the 12px of air Workshop, Me
          and Messages leave above their first element. `p-4` left the tab
          strip 8px from the bar. It is the frame's, so all four tabs step
          down together and the strip never jumps between them. `px-4`/`pb-4`
          are the 16px gutter and foot this frame always had.
      */}
      {/*
          `[scrollbar-gutter:stable]` on the scroller above: Kudos and
          Standings run past the fold and Challenges and History do not, so
          with a classic (non-overlay) scrollbar the centered column — strip
          included — shifted half a scrollbar's width left on the long tabs
          and back on the short ones. Reserving the gutter on every tab keeps
          the column where it is; overlay scrollbars (phones, default macOS)
          reserve nothing and are unaffected.
      */}
      <div className="max-w-5xl mx-auto px-4 pt-5 pb-4 w-full">
        <div className={detailOpen ? 'hidden' : section === 'kudos' ? KUDOS_COLUMN : undefined}>
          {/*
              No <h2> here any more. The screen said "Leaderboard" twice — once
              in the platform bar and once as this heading — and neither named
              the tab you were on. The platform's rule is one name per screen,
              in the bar; the bar now follows the active tab
              (Leaderboard._syncTitle → App._leaderboardTitle), so the tab
              strip is the first thing under it, as on every other tabbed
              screen.
          */}
          <Tabs
            value={section}
            onValueChange={(key) => {
              // Straight back into the module: it validates the key, records the
              // section, syncs the hash, re-publishes (which re-renders this
              // strip) and applies the pane switch.
              window.Leaderboard?._setSection?.(key);
            }}
          >
            <TabsList id="standings-tabs" ref={stripRef} className={STRIP_LIST} style={stripFade}>
              {mounted
                ? SECTION_TABS.map((s) => (
                    <TabsTrigger
                      key={s.key}
                      value={s.key}
                      data-standings-tab={s.key}
                      className={STRIP_TAB}
                      activeClassName={SECTION_TAB_ACTIVE}
                      inactiveClassName={SECTION_TAB_INACTIVE}
                    >
                      {s.label}
                    </TabsTrigger>
                  ))
                : null}
            </TabsList>
          </Tabs>
          {/*
              The shared event picker + hero for the two Topochain-domain
              sections. STATEFUL as of #1191: ./event-bar.tsx is the only writer
              below this host, driven by what ./topochain-event-context.js pushes
              into ./event-bar-store.js — that module still owns the two fetches,
              the default pick and the subscriber list both panes register with.

              The host ships VISIBLE, with the challenges pane below (the default
              section is an event section), and EMPTY — the bar's interior was
              written on the screen's first open, so the store's initial
              `mounted: false` renders nothing. It stays empty for a viewer
              with no season to go back to (#2495, see ./event-bar.tsx), and
              the gap below the bar is the bar's own, so an empty host adds
              no space between the strip and the board. `_applySection`
              hides the host on Kudos by `classList`, which is safe for the
              reason the two pane roots' comments give: this `className` is
              a constant React never writes again.
          */}
          <div id="leaderboard-event-bar" className="w-full">
            <EventBar />
          </div>
        </div>
        {/*
            The Kudos pane. STATEFUL as of #1191 slice 6 conversion 6:
            ./kudos-pane.tsx is the only writer below this root now, driven by
            the descriptors ./leaderboard.js pushes into ./kudos-pane-store.js.
            The root's own `className` is a CONSTANT for the same reason the
            standings root's is — `_applySection()` still toggles `hidden` on
            it, per the note above.

            THE COLUMN IS ME'S (#2832 follow-up). Me's Kudos row opens this
            pane, so it takes Me's column — Workshop's — rather than one of
            its own: it was `max-w-3xl`, 96px wider than the page it opens
            from. Me is `max-w-2xl px-4`: a 672px box whose content (its
            cards) is 640px. This root sits INSIDE the frame's `px-4`, which
            already supplies that gutter, so the same content edge is
            `max-w-[40rem]` (672 − 2×16): at every viewport width the rows
            here span exactly the x-range Me's cards do, centered with its
            own `mx-auto` (#2921) as before.
        */}
        <div id="leaderboard-root" className={`hidden ${KUDOS_COLUMN}`}>
          <KudosPane />
        </div>
        {/*
            The standings pane. STATEFUL as of #1191 slice 6 conversion 5:
            ./topochain-standings.tsx is the only writer below this root now,
            driven by the descriptors ./topochain-leaderboard.js pushes into
            ./topochain-standings-store.js. The root's own `className` is still
            a CONSTANT — `_applySection()` keeps toggling `hidden` on it, per
            the note above.
        */}
        <div id="topochain-leaderboard-root" className="hidden w-full">
          <TopochainStandingsPane />
        </div>
        {/*
            The challenges pane. STATEFUL as of #1191 slice 6 conversion 7:
            ./challenges-pane.tsx is the only writer below this root now,
            driven by the descriptors ./topochain-challenges.js pushes into
            ./topochain-challenges-store.js. With this one the screen has no
            innerHTML host left. The root's own `className` is still a
            CONSTANT — `_applySection()` keeps toggling `hidden` on it, per the
            note above.
        */}
        <div id="challenges-root" className="w-full">
          <ChallengesPane />
        </div>
        {/*
            The History pane (#leaderboard/seasons): the seasons that have
            ended. React-owned end to end from the start — ./history-pane.tsx
            is its only writer — and shipped EMPTY and hidden like the two
            non-default roots above, with a CONSTANT className that
            `_applySection()` toggles `hidden` on.
        */}
        <div id="leaderboard-history-root" className="hidden w-full">
          <HistoryPane />
        </div>
      </div>
    </main>
  );
}
