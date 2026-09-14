// The Leaderboard screen (#leaderboard) as a React island — #1083 chunk F
// step 3, and the biggest of the four regions by module count: five legacy
// modules retire into the bundle with it.
//
// ── What the screen is ─────────────────────────────────────────────────
//
// One screen, three top-level SECTIONS, one pane visible at a time:
//
//   topochain   #topochain-leaderboard-root   TopochainLeaderboard  (default)
//   kudos       #leaderboard-root             Leaderboard itself
//   challenges  #challenges-root              TopochainChallenges
//
// The two Topochain-domain sections share one event selection, rendered into
// #leaderboard-event-bar by TopochainEventContext and hidden on Kudos.
//
// ── What this island owns, and what it does not ────────────────────────
//
// It owns the FRAME — the <main>, the column, the title, the four hosts — and
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
// screen's first open, from _renderSectionTabs) and the two hosts that shipped
// visible still ship visible while #leaderboard-root and #challenges-root ship
// hidden. Visibility of the screen itself comes from the store:
// App._showOnlyScreen publishes (screenId, visible) for every id in
// App.REACT_SCREEN_IDS and useVisibilityHiddenClass writes the class
// synchronously inside that notification, because _showOnlyScreen runs inside
// PlatformUI.transition(fn) and the native kit snapshots the DOM before fn
// returns. `false` is the shipped state.

import { useRef } from 'react';
import {
  SECTION_TAB_ACTIVE,
  SECTION_TAB_BASE,
  SECTION_TAB_INACTIVE,
  SECTION_TABS_LIST,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
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
import { topochainChallengesStore } from './topochain-challenges-store.js';

// The strip, in TAB ORDER. Moved here verbatim from the template that
// _renderSectionTabs used to hold, labels included: the standings tab is
// labelled simply "Leaderboard" because it is the primary ranking on this
// platform and the screen's own title, and the `key`s are the platform's
// vocabulary for these tabs — every hash alias in app.js and every dapp.json
// check speaks in them, and Leaderboard.SECTIONS still validates against them.
const SECTION_TABS = [
  { key: 'topochain', label: 'Leaderboard' },
  { key: 'kudos', label: 'Kudos' },
  { key: 'challenges', label: 'Challenges' },
];

export function LeaderboardScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'leaderboard-screen', false);
  const { mounted, section } = useLeaderboardSection();
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
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: "relative" }}
    >
      {/*
          max-w-5xl for the Topochain table's sake; the Kudos pane keeps its
          narrower max-w-3xl reading column below.
      */}
      <div className="max-w-5xl mx-auto p-4 w-full">
        <div className={detailOpen ? 'hidden' : undefined}>
          <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-3">
            Leaderboard
          </h2>
          <Tabs
            value={section}
            onValueChange={(key) => {
              // Straight back into the module: it validates the key, records the
              // section, syncs the hash, re-publishes (which re-renders this
              // strip) and applies the pane switch.
              window.Leaderboard?._setSection?.(key);
            }}
          >
            <TabsList id="standings-tabs" className={SECTION_TABS_LIST}>
              {mounted
                ? SECTION_TABS.map((s) => (
                    <TabsTrigger
                      key={s.key}
                      value={s.key}
                      data-standings-tab={s.key}
                      className={SECTION_TAB_BASE}
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

              The host ships VISIBLE, with the standings pane below (the default
              section is an event section), and EMPTY — the bar's interior was
              written on the screen's first open, so the store's initial
              `mounted: false` renders nothing. `_applySection` hides the host on
              Kudos by `classList`, which is safe for the reason the two pane
              roots' comments give: this `className` is a constant React never
              writes again.
          */}
          <div id="leaderboard-event-bar" className="w-full mb-4">
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
        */}
        <div id="leaderboard-root" className="hidden max-w-3xl">
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
        <div id="topochain-leaderboard-root" className="w-full">
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
        <div id="challenges-root" className="hidden w-full">
          <ChallengesPane />
        </div>
      </div>
    </main>
  );
}
