/**
 * `#dev-kanban-board` — the kanban board — as the only React writer below
 * that host. The host stays app-view.js's; the columns, the mobile tab
 * strip and every card render from `devKanbanStore`.
 *
 * ── The retired drag seam (#613) ──────────────────────────────────────
 *
 * Cards once carried a six-dot grip in a 24px left gutter, and
 * `_initKanbanDrag`'s pointer recognizer reordered a column by moving these
 * nodes underneath React. The grip was the gesture's only entry point, and
 * it cost every card that gutter on the narrowest screen there is — so the
 * whole affordance is gone: no handle, no recognizer, no `_dragState`
 * publish guard, no remount-on-drop. What survives is the READ side.
 * `_applyManualOrder` still lays a saved order over the derived one in
 * `_kanbanView`, so a column somebody already arranged keeps its
 * arrangement; nothing in the UI can write a new one.
 *
 * ── Tabs (#814) ───────────────────────────────────────────────────────
 *
 * All four columns are always in the DOM; `dev-kanban-col-active` marks the
 * one the strip shows and CSS acts on it only below 640px. A tab tap calls
 * `AppView._onKanbanTabSelect`, which persists the choice and republishes
 * `activeTab` — replacing `_applyKanbanTab`'s class-toggling DOM pass.
 *
 * ── The cards fold (#1787) ────────────────────────────────────────────
 *
 * A column draws each card as the Workshop's one-line row and unfolds the
 * one you tap into the dense card, in place (./fold.tsx). Which row is open
 * is the COLUMN's state — one per column, so a board with four open cards
 * is still four columns of rows — and it lives in the component, so the
 * WS-driven republishes that repaint the board leave it alone. The open card
 * is the card the column always drew, with the "Open card" pill as the last
 * pill of its action band (the facts-line seat moves the actions up beside
 * it, which a column cannot hold), leading to the item's own page — the
 * same link with the same label the Workshop's card carries since #1884
 * round two. `?cards=open` draws every card unfolded: the board as it was,
 * and the state the declared checks that read a card's anatomy run in.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ArrowUpIcon } from '@/components/ui/icons';
import { SECTION_TAB_ACTIVE, SECTION_TAB_INACTIVE } from '@/components/ui/tabs';

import { useNarrowViewport } from '../../../lib/use-narrow';
import { useStoreState } from '../../../lib/use-store-state';
import { devKanbanStore } from './cards-store';
import { callAppView } from './fold';
import { FooterView } from './footer';
import { ListRowView } from './list-rows';
import type { KanbanColView, ListRow } from './model';
import { CardSkeleton, CountSkeleton } from './skeleton';

function selectTab(key: string): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av._onKanbanTabSelect === 'function') av._onKanbanTabSelect(key);
}

/*
 * One tab — the language's segmented control since #2441, not the underline
 * row it shipped as.
 *
 * ── Why the classes and not <TabsTrigger> ─────────────────────────────
 *
 * The SELECTED TREATMENT comes from @/components/ui/tabs.tsx, so this strip
 * and the Leaderboard's section strip invert the same way. The COMPONENT does
 * not, for two reasons that both point the same direction:
 *
 * - `SECTION_TAB_BASE`'s geometry is a single line of text 32px tall. These
 *   tabs are two lines (title over count) at a 44px minimum, four of them
 *   sharing a phone's width — a shape that primitive does not spell.
 * - `<TabsTrigger>` renders `aria-current` and cannot be talked out of it.
 *   This strip is a real `role="tablist"` whose tabs say `aria-selected` and
 *   point at their panel with `aria-controls`; tabs.tsx's own header notes
 *   that `aria-current` is the OTHER convention, and a button wearing both
 *   states its selection twice in two vocabularies. dapp.json's
 *   `#dev-kanban-tabs [data-kanban-tab="…"]` checks and three suites here
 *   read these attributes, so every one of them is byte-identical to what it
 *   was: only the class strings changed.
 */
function Tab({ col, active, loading }: { col: KanbanColView; active: boolean; loading: boolean }): ReactNode {
  const cls = 'dev-kanban-tab flex-1 basis-0 min-w-0 min-h-[44px] px-1 py-1.5 flex flex-col items-center justify-center '
    + 'rounded-full font-semibold transition-colors '
    + (active ? SECTION_TAB_ACTIVE : SECTION_TAB_INACTIVE);
  // The count rides the tab's own ground: page-coloured ink on the selected
  // fill, the zinc ladder off it (a zero column stays the lightest of the
  // three, which is how an empty column reads as empty at a glance).
  const countCls = 'font-mono text-[11px] leading-tight '
    + (active ? 'text-white dark:text-zinc-900' : (col.count ? 'text-zinc-500 dark:text-zinc-500' : 'text-zinc-300 dark:text-zinc-500'));
  return (
    <button
      type="button"
      role="tab"
      id={`dev-kanban-tab-${col.key}`}
      data-kanban-tab={col.key}
      aria-selected={active}
      aria-controls={`dev-kanban-col-${col.key}`}
      className={cls}
      onClick={() => selectTab(col.key)}
    >
      <span className="text-xs leading-tight truncate max-w-full">{col.title}</span>
      <span className={countCls}>{loading ? <CountSkeleton /> : col.count}</span>
    </button>
  );
}

function Column(
  { col, active, loading, deferred, slug, canPost, unfolded }:
  {
    col: KanbanColView; active: boolean; loading: boolean; deferred: boolean;
    slug: string; canPost: boolean; unfolded: boolean;
  },
): ReactNode {
  // The one open card, by row key. Toggling the open one closes it; opening
  // another closes the first. Survives republishes because it is here and
  // not in the view model.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const hasReviewSort = col.key === 'inreview' && !!col.reviewSort;
  const sortLabel = col.reviewSort === 'priority' ? 'Vote priority' : 'Newest';
  const nextSort = col.reviewSort === 'priority' ? 'newest' : 'priority';
  const nextSortLabel = nextSort === 'priority' ? 'Vote priority' : 'Newest';
  const statusTone = col.status?.tone === 'blocked'
    ? 'text-red-700 dark:text-red-300'
    : col.status?.tone === 'progress'
      ? 'text-violet-700 dark:text-violet-300'
      : col.status?.tone === 'ok'
        ? 'text-emerald-700 dark:text-emerald-300'
        : 'text-zinc-500 dark:text-zinc-400';
  // A merged card's kudos slot is a legacy-filled host (`_fillKudosHosts`,
  // run by app-view.js after every publish). A fold happens BETWEEN
  // publishes, so the slot a card just unfolded with would stay empty until
  // the next repaint; re-run the filler here. It skips filled hosts.
  //
  // A LAYOUT effect, not a plain one: a plain effect runs after the browser
  // has painted the card with the slot empty, so the kudos pill popped in a
  // frame later and shoved "Open card" along the band — the flicker at the
  // bottom-left of every merged card on open. Before paint, the card is
  // whole on its first frame, and the band's fold measurement (which
  // watches its own subtree) re-folds around the filled slot in the same
  // frame.
  //
  // The unfolded card's GitHub-comment slot is the same kind of host and is
  // filled the same way (#1884, `_wireFeedComments`) — but wired from the
  // BOARD, not from this column. That filler keeps ONE observer and replaces
  // it on every call, so four columns wiring their own would leave only the
  // last one watched; one call from `#dev-kanban` covers all four, and a
  // fold only ever happens in one column at a time.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    callAppView('_fillKudosHosts', host);
    callAppView('_wireFeedComments', host.closest('#dev-kanban') || host);
  }, [openKey, unfolded]);
  let cards: ReactNode;
  // Below 640px this column is `display:none` unless it is the active one
  // (see .dev-kanban-col in app.css), so building its cards is work whose
  // only outcome is being hidden. On a warm board that was three quarters
  // of the render — measured as the largest single item in a phone-shaped
  // profile, ahead of every network wait left in the boot.
  //
  // The column SHELL still renders: same id, same data-kanban-col, same
  // heading, same count — the count comes from col.count, not from
  // rows.length, so a deferred column still reports the right number in
  // both the heading and its tab. Only the rows wait, and they arrive the
  // moment the tab is tapped, because activeTab republishes and this
  // column stops being deferred.
  if (deferred) {
    cards = null;
  } else if (loading) {
    // Two rows, not four: the point is to show the column is filling, and a
    // full-height stack of placeholders in each of four columns is a busier
    // screen than the one it is standing in for.
    cards = <CardSkeleton n={2} label={`Loading ${col.title}`} />;
  } else if (col.empty) {
    cards = <div className="text-xs text-zinc-500 dark:text-zinc-500 italic py-2">{col.empty}</div>;
  } else {
    cards = (
      <div className="space-y-2">
        {col.rows.map((row: ListRow) => (
          <ListRowView
            key={row.key}
            row={row}
            fold={{
              slug,
              canPost,
              open: unfolded || openKey === row.key,
              onToggle: () => setOpenKey((k) => (k === row.key ? null : row.key)),
              // "Open card" rides in the action band here, not on the facts
              // line: a column is too narrow for the actions that seat moves
              // up beside it (fold.tsx). Where it LEADS is no longer a
              // per-surface choice — the item's own page, on both — so there
              // is nothing left to pass for that.
              detail: 'actions',
              // No "Open session ›" line under a board card: app.css has no
              // rule for `.dev-ws-sheet-actions` inside `#dev-kanban`, and a
              // column is not where somebody goes looking for their session.
              sessionLink: false,
            }}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      ref={hostRef}
      id={`dev-kanban-col-${col.key}`}
      data-kanban-col={col.key}
      className={`dev-kanban-col${active ? ' dev-kanban-col-active' : ''}`}
    >
      <div
        // Mobile tabs already show the column name and count. Keep only
        // the sorting action visible there; other column headers stay hidden.
        className={`${hasReviewSort ? '' : 'dev-kanban-col-head '}mb-2 px-0.5`}
        title={col.hint || undefined}
      >
        <div className="flex min-h-[44px] items-center justify-between gap-2">
          <span className={`${hasReviewSort ? 'hidden sm:inline ' : ''}text-[0.9375rem] font-semibold text-zinc-500 dark:text-zinc-400 whitespace-nowrap`}>
            {`${col.title} `}
            {loading
              ? <span className="text-zinc-500 dark:text-zinc-500 font-mono">{'· '}<CountSkeleton /></span>
              : <span className="text-zinc-500 dark:text-zinc-500 font-mono">{`· ${col.count}`}</span>}
          </span>
          {hasReviewSort ? (
            <Button
              type="button"
              variant="unstyled"
              size="none"
              ink="muted"
              aria-label={`Sort Waiting for approval: ${sortLabel}. Switch to ${nextSortLabel}.`}
              title={`${col.reviewSort === 'priority'
                ? 'Unvoted first, then fewest qualifying votes still needed. Within each vote group, already-qualified proposals follow those still short. Newest breaks ties.'
                : 'Most recently submitted for review first.'} Click to switch to ${nextSortLabel}.`}
              className="ml-auto inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
              onClick={() => callAppView('_setReviewSort', nextSort)}
            >
              <ArrowUpIcon aria-hidden="true" className="h-3.5 w-3.5 rotate-180" />
              {sortLabel}
            </Button>
          ) : null}
        </div>
      </div>
      {!loading && col.status ? (
        <div
          data-kanban-col-status={col.key}
          className={`text-[11px] leading-snug font-medium mb-2 px-0.5 ${statusTone}`}
          title={col.status.title}
        >
          {col.status.text}
        </div>
      ) : null}
      {cards}
      {(!deferred && col.footer) ? <div className="mt-2"><FooterView f={col.footer} /></div> : null}
    </div>
  );
}

export function DevKanban(): ReactNode {
  const v = useStoreState(devKanbanStore);
  // Wide viewports render every column, exactly as before — including the
  // proposal-checks runner, which asserts in a fixed 1280x800 frame.
  const narrow = useNarrowViewport();
  if (!v.cols.length) return null;
  return (
    <>
      {/*
          The raised white track of SECTION_TABS_LIST, laid out to SPAN the
          phone rather than to hug its labels: four columns share this width
          and each tab is `flex-1 basis-0`, so `flex` and not `inline-flex`.
          The `border-b` rule it replaces is gone with the underline (#2441).
      */}
      <div
        id="dev-kanban-tabs"
        role="tablist"
        aria-label="Board columns"
        className="sm:hidden flex items-stretch gap-0.5 mb-2 rounded-full bg-white dark:bg-zinc-900 p-0.5"
      >
        {v.cols.map((col) => (
          <Tab key={col.key} col={col} active={col.key === v.activeTab} loading={!!v.loading} />
        ))}
      </div>
      <div id="dev-kanban" className="flex gap-3 overflow-x-auto pb-2" data-kanban-active={v.activeTab}>
        {v.cols.map((col) => (
          <Column
            key={col.key}
            col={col}
            active={col.key === v.activeTab}
            loading={!!v.loading}
            deferred={narrow && col.key !== v.activeTab}
            slug={v.slug || ''}
            canPost={!!v.canPost}
            unfolded={!!v.unfolded}
          />
        ))}
      </div>
    </>
  );
}
