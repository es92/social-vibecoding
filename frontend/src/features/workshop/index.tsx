/**
 * `#workshop-screen` — the Workshop across all of your apps.
 *
 * ── What it is for ─────────────────────────────────────────────────────
 *
 * Every app has a Workshop page: its Dev lander, which opens on "What you
 * are working on" and carries a "Needs you" tab beside it
 * (features/dev-board/workshop/workshop.tsx). That page answers "what is
 * happening in THIS app", and it is the right page — but the question a
 * person actually arrives with is one level up: WHICH of my apps wants
 * something from me right now. Answering it meant opening each app's
 * Workshop in turn, which is how a good screen becomes a chore.
 *
 * So this is the same two numbers, once per app, on one screen. A row says
 * how many items that app's own Workshop holds for you, and tapping it goes
 * to that Workshop — the existing page, not a copy of it. The header's back
 * control then points back here (see App.navigateToWorkshop and
 * `App._appBackHref` in public/js/app.js), so the two screens read as one
 * level and its drill-in rather than as two places that happen to link.
 *
 * ── Where the numbers come from ────────────────────────────────────────
 *
 * GET /api/workshop/counts (src/routes/workshop-overview.js), which answers
 * for every app in one query. NOT the board's own load: that is eight
 * requests per app, and at forty apps it is not a page. Its module header
 * documents the two populations and the one thing the "needs you" number
 * leaves out — the unclaimed GitHub issues at the tail of that deck, which
 * are not in Postgres — which is why this screen's own legend says "votes
 * waiting" rather than claiming the whole tab.
 *
 * The APP LIST is a second read, and deliberately a different one:
 * GET /api/apps plus `Home.partitionApps(...).yours`, exactly as the app
 * chip's menu composes its strip (features/app-context/app-context-sheet.tsx).
 * "Which apps are mine" is a decision the platform already makes once, and a
 * count endpoint that re-answered it in SQL would be a second copy of it that
 * could drift. The counts arrive keyed by slug and are joined onto those rows
 * here; a slug the endpoint said nothing about is two zeroes.
 *
 * ── The island rules it keeps ──────────────────────────────────────────
 *
 * Nothing in `public/js/**` writes inside this root, so the region may hold
 * state. Its FIRST render is the shipped document — `hidden`, an empty list,
 * no rows — and both fetches run from `open()`, never during render. Screen
 * visibility is the shell's store (`#workshop-screen` is in
 * App.REACT_SCREEN_IDS) and the root's `className` is a constant, so the
 * class has exactly one owner.
 */

import { useRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { HandRaisedIcon, SpeechCheckIcon } from '@/components/ui/icons';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { AppsLoadError } from '../apps/load-error';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { workshopStore } from './workshop-store.js';

// The legacy router reads the DOM on the line after it routes — the ?shot=
// capture fixtures assert the revealed screen inside the same task — so the
// store's notification has to land synchronously. Same install, same reason,
// as features/header/mount.ts.
workshopStore.setFlush(flushSync);

type WorkshopRow = {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  working: number;
  needs: number;
};

type Counts = Record<string, { working?: number; needs?: number } | undefined>;

/** The demo flag the board's own fetches forward, in the same spelling. */
function demoQuery(): string {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

/**
 * The viewer's apps with their two counts, newest question first.
 *
 * Exported and pure so tests can drive the ordering without a fetch. The
 * order is the argument this screen makes: an app that needs a decision from
 * you outranks one where you have work of your own outstanding, which
 * outranks a quiet one — and inside each band the platform's own "Your apps"
 * order (favourite order, then activity) is preserved, because `sort` is
 * stable and this comparator answers 0 for two rows in the same band.
 */
export function orderRows(apps: WorkshopRow[]): WorkshopRow[] {
  const band = (row: WorkshopRow) => (row.needs > 0 ? 0 : (row.working > 0 ? 1 : 2));
  return apps.slice().sort((a, b) => band(a) - band(b));
}

/** Join a counts map onto the app rows. A slug with no entry is two zeroes. */

export function joinCounts(apps: Array<Omit<WorkshopRow, 'working' | 'needs'>>, counts: Counts): WorkshopRow[] {
  return apps.map((app) => {
    const found = counts[app.slug];
    return {
      ...app,
      working: Number(found?.working) || 0,
      needs: Number(found?.needs) || 0,
    };
  });
}

/**
 * One number with its glyph.
 *
 * TINTED ONLY WHEN IT IS NOT ZERO. A row of grey zeroes is the common case on
 * a big account, and painting those in the accent would make every app look
 * like it was asking for something. The glyphs are the ones the app's own
 * Workshop uses for the same two things — the raised hand for your own work,
 * the bubble-with-a-tick for the Needs-you deck — so the number here and the
 * pane it counts wear the same mark.
 */
function Count({ kind, n, label }: { kind: 'working' | 'needs'; n: number; label: string }) {
  const lit = n > 0;
  const tint = kind === 'needs'
    ? 'text-violet-700 dark:text-violet-300 bg-violet-500/10'
    : 'text-zinc-700 dark:text-zinc-200 bg-zinc-500/10';
  return (
    <span
      {...{ [`data-workshop-${kind}`]: String(n) }}
      // ONE accessible name, not a glyph plus a bare digit. The pill reads
      // "2 items you are working on" to a screen reader and carries the same
      // sentence as its pointer tooltip; the glyph is decoration, which is
      // what a legend a thumb cannot hover is for.
      aria-label={`${n} ${label}`}
      title={`${n} ${label}`}
      className={'shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 '
        + 'text-xs font-semibold tabular-nums '
        + (lit ? tint : 'text-zinc-400 dark:text-zinc-500')}
    >
      {kind === 'needs'
        ? <SpeechCheckIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        : <HandRaisedIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
      {n}
    </span>
  );
}

/**
 * One app, as a grouped-list row.
 *
 * `ListRow` from @/components/ui/grouped-list is the widget language's primary
 * content shape, and this is the shape it is for: a leading app tile, the
 * app's name as the row's subject, something on the trailing edge and a
 * disclosure chevron. It draws the inset hairline between rows (a
 * pseudo-element, so the last row has none without this file knowing which
 * one is last) and the `active:` press state.
 *
 * AN ANCHOR, which is what `as="a"` on that primitive is for: cmd/ctrl-click,
 * middle-click, "open in new tab" and the context menu are the browser's to
 * give, and the shell takes that seriously enough that #back-btn and the app
 * chip's own menu rows are anchors. `/app/<slug>/workshop` is App._appUrl's
 * spelling for that page (`boardView: 'workshop'`), so a copied address
 * restores the same screen cold.
 *
 * A plain primary click routes in place through `App.navigateToApp`, which is
 * also what records the back breadcrumb — it reads `App._inWorkshop`, so the
 * arrow appears because the visit came from here rather than because this row
 * asked for it. A modified click never reaches the handler: the browser
 * handles it natively, which is the whole reason this is an anchor.
 *
 * The leading tile is `.app-icon-tile` at the primitive's own `sm` geometry
 * (2.75rem, `rounded-xl`), exactly as features/apps/browse-list.tsx draws it —
 * app.css owns that face, and a call site must not repaint it.
 */
function AppRow({ row }: { row: WorkshopRow }) {
  return (
    <ListRow
      as="a"
      href={`/app/${encodeURIComponent(row.slug)}/workshop`}
      data-workshop-app={row.slug}
      onClick={(event) => {
        const win = window as any;
        if (win.NavLink?.isNativeClick?.(event)) return;
        event.preventDefault();
        win.App?.navigateToApp?.(row.slug, 'dev');
      }}
      leading={(
        <div
          className={'app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden '
            + 'flex items-center justify-center font-bold text-lg'}
          data-icon={appIconKind(row as any)}
        >
          <AppIconContent app={row as any} />
        </div>
      )}
      title={row.name || row.slug}
      trailing={(
        /* ONE trailing group, with its own tight gap. `ListRow` sets `gap-4`
           between every element it lays out, which is right between the tile,
           the title and the trailing edge and is 16px too much BETWEEN two
           numbers that read as one column. Grouping them also buys the title
           that width back, and at phone width the title is what truncates. */
        <span className="flex shrink-0 items-center gap-1.5">
          <Count kind="working" n={row.working} label="items you are working on" />
          <Count kind="needs" n={row.needs} label="votes waiting on you" />
        </span>
      )}
    />
  );
}

/**
 * Four rows of the real geometry, so the list does not change shape on load.
 *
 * The bars sit in a `ListRow` rather than a hand-built div, which is what
 * keeps "the real geometry" true when the row's padding or its tile size
 * changes. `chevron={false}` because a disclosure arrow on a row that
 * discloses nothing yet is the one part of the shape worth NOT reproducing.
 */
function RowSkeletons(): ReactNode {
  return (
    <SkeletonGroup label="Loading your apps">
      {[0, 1, 2, 3].map((i) => (
        <ListRow
          key={i}
          chevron={false}
          leading={<Skeleton shape="block" className="w-11 h-11 rounded-xl" />}
          title={<Skeleton className="max-w-[40%]" />}
          trailing={(
            <>
              <Skeleton shape="block" className="w-10 h-5 rounded-full" />
              <Skeleton shape="block" className="w-10 h-5 rounded-full" />
            </>
          )}
        />
      ))}
    </SkeletonGroup>
  );
}

export function WorkshopScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  const state = useStoreState(workshopStore) as {
    open: boolean; rows: WorkshopRow[] | null; error: boolean;
  };
  useVisibilityHiddenClass(screenRef, 'workshop-screen', false);
  // ONE LIST, EVERY APP. The three tabs — Current status / Needs you / All
  // items — are gone from this screen (see ./workshop-chrome.tsx): they are
  // the APP Workshop's tabs, about one app's items, and up here they were
  // filtering a list of apps by whether a number on it was non-zero. Each row
  // already carries both numbers, so the filter hid apps to say something the
  // rows were saying anyway.
  const rows = state.rows ? orderRows(state.rows) : null;
  const all = rows;
  // `#workshop-empty` keeps its ONE meaning — you have no apps at all — and
  // that is a contract rather than a nicety: dapp.json selects
  // `#workshop-empty.hidden` to prove the card is gone once the list has
  // rows, so a tab that merely filters to nothing must not raise it. A tab
  // with nothing in it says so in its own line below.
  // The totals the legend prints. Across EVERY app, not the filtered tab:
  // the question is "how much is there altogether", and an answer that moved
  // when you changed tabs would be answering a different one. Null until the
  // list has answered — see the legend's note.
  // Nothing to total with no apps: the empty card below already says why the
  // screen is bare, and "0 working on · 0 waiting on your vote" over it is the
  // same nothing said twice, in the confident voice of a measurement.
  const TOTAL = 'font-semibold text-zinc-900 dark:text-zinc-100';
  const totals = all && all.length > 0
    ? all.reduce((acc, row) => ({
      working: acc.working + (row.working || 0),
      needs: acc.needs + (row.needs || 0),
    }), { working: 0, needs: 0 })
    : null;
  const empty = !!all && all.length === 0 && !state.error;

  return (
    <main
      ref={screenRef}
      id="workshop-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: 'relative' }}
    >
      {/* SECTION LABEL over a card of hairline-separated rows — the widget
          language's primary content shape, drawn by @/components/ui/grouped-list
          rather than by hand. The card carries no border: the language
          separates by figure/ground, and this route paints the wallpaper
          ground (see the `:is(...)` list in app.css) that the white card
          floats on. `max-w-2xl mx-auto` is the only thing here that is this
          screen's own — GroupedList owns its own `mx-4` gutter and radius. */}
      <div className="max-w-2xl mx-auto pb-8">
        {/* NO TITLE HERE (#2718 review). This screen and Messages both drew
            their own name under a bar that was already saying it — the same
            word twice, an inch apart, on the two screens that had been made
            to agree about what a title IS. The bar is the title, which is
            what it is for on every other screen in the shell. */}
        {/* NO SCOPE CHIP HERE EITHER (#2759). It read "All apps" and its
            panel listed your apps so you could pick one — but this screen IS
            that list, every row the way into its app's Workshop, so the chip
            was the one control on the page that repeated the page. The chip
            lives on ONE app's Workshop now (./workshop-chrome.tsx), where
            naming the app and offering the others is something the screen
            does not already say. */}
        {/* THE LEGEND IS NOT DECORATION. Two bare numbers on a row cannot be
            read, and the per-pill tooltip is not available to a thumb — so the
            two glyphs are named once, here, in the muted line the language
            uses under a section label.

            IT CARRIES THE TOTALS NOW (#2718). The design study put three
            count cards at the top of this screen — "4 in vote / 2 working / 7
            open issues" — and the question they answer is a fair one this
            screen could not answer: the rows say which APPS need you, and
            nowhere said how much there is altogether.

            As numbers in the legend rather than as cards, because the legend
            is already the line that explains these two glyphs, and a card
            deck above a list whose every row carries the same two figures
            would be the third telling of one fact. "Open issues" is not here:
            /api/workshop/counts folds governance issues into `working`
            alongside sessions and promoted proposals, so a third figure would
            have to be invented rather than read.

            Null until the list answers — the totals are a fact about the
            rows, so they wait for the rows rather than printing a confident
            zero over skeletons.

            THE WORDS ARE NOT THE NUMBER'S TO CHANGE. This first shipped as
            "2 working on" / "3 waiting on your vote", which reworded the
            legend on the way past — and a declared check pins the phrase
            "Votes waiting on you" on this screen, so it went red on the
            platform's own run. The number is ADDITIVE: the legend says
            exactly what it said before and gains a figure at the end. That is
            also the better reading, because the glyph's name and its count
            are two different things and the name is the one that has to be
            legible cold. */}
        {/* `pt-5` CLEARS THE HEADER'S NOTCH (#2718 review). The bar is
            `rounded-b-2xl -mb-2`, so every screen root starts 8px UNDER its
            bottom edge and whatever leads a screen has to step down past it.
            The chip carried that step while it led the screen; the legend
            leads now, so it carries it: the 8 the notch owes plus 12 of air,
            which is what Messages' own first element steps down by. */}
        <p className="px-4 pt-5 pb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-500 dark:text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <HandRaisedIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
            You are working on
            {totals ? <b id="workshop-total-working" className={TOTAL}>{totals.working}</b> : null}
          </span>
          <span className="inline-flex items-center gap-1">
            <SpeechCheckIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
            Votes waiting on you
            {totals ? <b id="workshop-total-needs" className={TOTAL}>{totals.needs}</b> : null}
          </span>
        </p>
        <GroupedList id="workshop-list">
          {/* #2445: THE EMPTY STATE IS A CARD, NOT A GREY CAPTION — the same
              correction Home's Discover block took in #1913
              (features/home/panels/discover.tsx): a title, a quieter second
              line and a trailing chevron, and the whole thing is the way on
              to the one thing there is to do here. It reads as an
              INVITATION rather than as an error note where the rows usually
              are. Same destination as Discover's, `#apps`, because "you have
              no apps" and "there is nothing to discover" are answered by the
              same directory.

              It is a `ListRow`, not a hand-rolled copy of Discover's plate:
              that card wears the Home panels' lane language
              (`home-discover-lane`, a tint, a hairline) because that is the
              surface it sits on, and THIS surface is the grouped-list card
              every other row on this screen is drawn in. Same shape, this
              screen's vocabulary. An anchor rather than a button for the
              reason AppRow gives — a hash href is the browser's to open in a
              new tab — and with no leading tile.

              FIRST, not last, and that is load-bearing: the row separator is
              `[&:not(:last-child)]:after:*` on the row itself, so a note after
              the rows would leave the last one drawing a hairline under
              nothing. Ahead of them it changes which element is last not at
              all. It ships in the prerender — hidden — because the shell's id
              inventory resolves against that document.

              THE CARD DRAWS NO HAIRLINE OF ITS OWN, in either state, and that
              is right rather than incidental. Showing, it is the only thing in
              the list, and a rule under the last row is a rule under nothing —
              which is the very reason this sits first. Hidden, the wrapper is
              `display: none`, so neither it nor the row inside it renders
              anything at all, and the rows below keep the separators they
              would have had. The row gets there by being the wrapper's only
              child, so `:not(:last-child)` is false for it always.

              THE ID AND THE `hidden` CLASS ARE THE API. dapp.json selects
              `#workshop-empty.hidden` to prove the card is gone once the list
              has rows, so the id stays on ONE element and visibility stays a
              class toggle on it — never conditional rendering, which would
              take the element out of the document the check resolves against.

              AND IT IS A WRAPPER, NOT THE ANCHOR ITSELF. That is the whole
              reason this div exists, and removing it breaks a merge-gating
              check silently. A second declared selector reads

                #workshop-list a[data-workshop-app]:first-of-type
                  [data-workshop-needs]:not([data-workshop-needs="0"])

              to prove an app with a decision waiting LEADS the list.
              `:first-of-type` counts siblings OF THAT ELEMENT NAME and is
              purely structural — `display: none` does not exempt an element
              from it — so an `<a id="workshop-empty">` sitting here as a
              sibling of the rows makes the first app row the SECOND `<a>`,
              and that selector matches nothing whether the card is showing or
              not. It shipped that way once (#2445) and the check failed on
              the very next run. Inside this div the card's anchor is the
              first `<a>` among ITS siblings, where it satisfies nothing and
              blocks nothing, and the first row is the first `<a>` among the
              list's own children again. */}
          <div id="workshop-empty" className={empty ? '' : 'hidden'}>
            <ListRow
              as="a"
              href="#apps"
              title="You have no apps yet"
              subtitle="Browse the directory to find one to join."
              subtitleClassName="whitespace-normal"
            />
          </div>
          {state.error
            ? (
              <AppsLoadError
                title="Couldn't load your workshop"
                onRetry={() => { void workshopController.reload(); }}
              />
            )
            : rows === null
              ? <RowSkeletons />
              : rows.map((row) => <AppRow key={row.slug} row={row} />)}
        </GroupedList>
      </div>
    </main>
  );
}

/**
 * The legacy seam, the same shape as `window.UsernodeReact.messages`.
 *
 * `App.navigateToWorkshop()` calls `open()` on the still-hidden root and
 * `_exitWorkshop` calls `close()` on the way out. `open` is not decoration:
 * it is the LIVENESS flag a load checks before it publishes, so a fetch that
 * lands after the viewer has left cannot paint rows into a screen they are no
 * longer on — and cannot race the next entry's own load. The re-entry guard
 * is the router's (see App.navigateToWorkshop), not this flag's, for the
 * reason its note gives.
 *
 * Both reads are fired together and the counts are tolerated as missing: an
 * app list with no numbers is a usable launcher, a screen that refuses to
 * draw because one of two requests failed is not. Losing the LIST is the
 * error card, because there is then nothing to draw.
 */
export const workshopController = {
  open() {
    workshopStore.set({ open: true });
    return workshopController.reload();
  },
  close() {
    workshopStore.set({ open: false });
  },
  isOpen() {
    return workshopStore.get().open;
  },
  async reload() {
    const demo = demoQuery();
    workshopStore.set({ error: false });
    let apps: Array<Omit<WorkshopRow, 'working' | 'needs'>> | null = null;
    let counts: Counts = {};
    try {
      const [appsRes, countsRes] = await Promise.all([
        fetch(`/api/apps${demo}`),
        fetch(`/api/workshop/counts${demo}`).catch(() => null),
      ]);
      if (appsRes.ok) {
        const data = await appsRes.json();
        const home = (window as any).Home;
        apps = home?.partitionApps
          ? home.partitionApps(data.apps || []).yours
          : (data.apps || []);
      }
      if (countsRes && countsRes.ok) {
        const data = await countsRes.json().catch(() => null);
        if (data && data.counts && typeof data.counts === 'object') counts = data.counts;
      }
    } catch {
      // Offline is a state, not a crash: fall through to the error card,
      // which offers the same load again rather than a page reload.
    }
    // Left the screen while this was in flight: say nothing. The rows are
    // kept as they were, so a re-entry paints the last list at once and
    // refreshes under it — the app strip in the chip's menu takes the same
    // view of a stale answer.
    if (!workshopStore.get().open) return;
    if (!apps) {
      workshopStore.set({ error: true });
      return;
    }
    workshopStore.set({ rows: joinCounts(apps, counts), error: false });
  },
};

if (typeof window !== 'undefined') {
  const host = (window as unknown as { UsernodeReact?: Record<string, unknown> });
  const bridge = (host.UsernodeReact ||= {});
  bridge.workshop = workshopController;
}

export { workshopStore };
