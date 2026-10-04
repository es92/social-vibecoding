// The browse-all-apps screen (#apps) as a React island — #1083 chunk F step 1,
// made STATEFUL by #1191 slice 6 (conversion 3).
//
// The whole subtree below #browse-screen is React-owned now. ./browse.js kept
// every decision it ever made — the sort, the search filter, the level
// derivation, the two fetches, the contributor cache, the action-list
// filtering, the screenshot deep link — and stopped making HTML: it pushes
// descriptors into ./browse-store.js, and ./browse-list.tsx and
// ./browse-detail.tsx render them. No `public/js/**` module writes into any
// node below this screen, which is what the island rule requires before a
// region may hold state.
//
// The three things the controller used to toggle from outside React are store
// fields now, for exactly that reason:
//   `level`     — was three classList.toggle calls in _syncLevel, across
//                 #browse-list-level, #browse-detail and #browse-search-bar.
//   `empty`     — was classList + textContent on #browse-empty.
//   `showClear` — was a classList.toggle on #browse-search-clear.
//
// #1383 added a fourth, `sort`: the directory's Sort control. It is the one
// field the controller reads back out (#browse-sort-select is CONTROLLED off
// it, unlike the search field), and 'recommended' is its prerender value — the
// remembered choice and the ?sort= override are resolved on screen entry, not
// during render, because neither localStorage nor location.search exists in
// the SSG pass.
//
// The SEARCH FIELD stays uncontrolled: nothing re-renders its value, so the
// caret cannot jump mid-word — the same property the old wire-once discipline
// bought. Keystrokes go to Browse.setQuery, which still coalesces them on the
// 100ms debounce the input listener used to own.
//
// The prototype's FILTER CHIPS (scrDiscover: All / Featured / Joined / New)
// ride the same bar, between the search and Sort. `filter` is the second
// CONTROLLED store field beside `sort` — the pressed chip is drawn off it, so
// it can never disagree with the rows — rendered from a copy of Browse.FILTERS
// for the reason SORT_OPTIONS is a copy of Browse.SORTS. 'all' is its prerender
// value; ?filter= and the session's choice apply on screen entry.
//
// INITIAL RENDER is the shipped shell exactly: #browse-list and #browse-empty
// empty, #browse-empty and #browse-detail hidden, the search bar and
// #browse-list-level visible, the clear button hidden. Every one of those
// falls out of browse-store.js's initial value, so the SSG prerender pass and
// the first client render agree and hydration is silent. Data loads in
// effects (App.navigateToBrowse → Browse.open → _load), never here.
//
// Visibility of the SCREEN itself is still the shell's visibility store, not
// this file's business: App._showOnlyScreen publishes (screenId, visible) for
// every id in App.REACT_SCREEN_IDS, and useVisibilityHiddenClass writes the
// class synchronously inside that notification, because _showOnlyScreen runs
// inside PlatformUI.transition(fn) and the native kit snapshots the DOM before
// fn returns. `false` is the shipped state: the shell ships this screen hidden.

import { useRef } from 'react';

import { Chip, ChipRail } from '@/components/ui/chip';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SearchIcon } from '@/components/ui/icons';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { useStoreState } from '../../lib/use-store-state';
import { BrowseDetail } from './browse-detail';
import { BrowseRows } from './browse-list';
import { AppsLoadError } from './load-error';
import { browseStore } from './mount';

const CLEAR_CLASS = 'absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center '
  + 'justify-center rounded-full text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200  dark:text-zinc-400'
  + 'hover:bg-zinc-500/10 text-base leading-none';

function browse(): any {
  return (typeof window !== 'undefined' ? (window as any).Browse : null) || null;
}

// The five orders of the Sort control (#1383), as the <option> list.
//
// A COPY of Browse.SORTS rather than a read of it, and deliberately so:
// ./browse.js publishes itself on `window.Browse`, which does not exist in the
// SSG prerender pass, so reading the controller here would prerender an empty
// <select> and hydrate a full one — a mismatch, and therefore a console.error
// on a route that has a declared check. The controller stays the authority on
// what a key MEANS (resolveSort, the comparators); this is only the labelling.
// tests/browse-screen.test.js asserts the two lists never drift apart.
const SORT_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'recommended', label: 'Recommended' },
  { key: 'users', label: 'Most users' },
  { key: 'active', label: 'Most active' },
  { key: 'merged', label: 'Most changes live' },
  { key: 'new', label: 'Newest' },
];

// The four filter chips — Browse.FILTERS, labelled. A COPY for the same reason
// SORT_OPTIONS is one: the controller is not on `window` in the SSG pass, and
// a chip row that prerendered empty and hydrated full would be a mismatch.
// tests/browse-screen.test.js pins the two lists together.
const FILTER_CHIPS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'featured', label: 'Featured' },
  { key: 'yours', label: 'Joined' },
  { key: 'new', label: 'New' },
];

export function BrowseScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'browse-screen', false);

  const state = useStoreState(browseStore) as {
    level: 'list' | 'detail';
    rows: any[] | null;
    empty: string | null;
    error: boolean;
    detail: any;
    showClear?: boolean;
    sort: string;
    filter: string;
    curated: boolean;
    grouped: boolean;
    moreExpanded: boolean;
  };
  const onDetail = state.level === 'detail';

  // Escape clears the field and re-filters immediately — the debounce exists
  // to coalesce typing, and a deliberate clear is not typing.
  const clear = (focus: boolean) => {
    const input = inputRef.current;
    if (input) input.value = '';
    browse()?.setQuery('', { immediate: true });
    if (focus && input) input.focus();
  };

  return (
    <main
      ref={screenRef}
      id="browse-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: "relative" }}
      data-page-bounce=""
    >
      {/*
          The search bar rides the level: searching the directory is a level-1
          affordance, and on a detail page the field would filter a list
          nobody can see.

          At md and up its fill is the wallpaper's base (--home-ground, set
          by the body rule that paints the wallpaper on this route — see "The
          home ground" in app.css), not white: a sticky bar needs an opaque
          fill for the rows to scroll under, and a white one read as a slab
          across a cream page. Dark mode reads the same variable, which the
          body's dark rule points at the inverted ground.

          ON A PHONE it sits ON THE GROUND, above the list's card, not as
          the card's head. #1919 drew the search, the sort and the list as
          one frosted pane; the communities prototype keeps the controls
          outside the card they narrow, the way Home and the Communities
          screen put a control row over a card, so the card holds only
          what it lists. The head still pins at the top, on the ground's own
          colour, and the rows slide under it. The parts keep their names —
          `browse-pane-head` / `browse-pane-body` / `browse-pane-note` in
          app.css, next to the .browse-row rules — so the phone padding and
          fill live there and only the md+ utilities stay here.
      */}
      <div
        id="browse-search-bar"
        className={`${onDetail ? 'hidden ' : ''}browse-pane-head sticky top-0 z-20 md:px-3 md:pt-3 md:pb-2 md:bg-[color:var(--home-ground)]`}
      >
        <div className="relative max-w-xl">
          <SearchIcon
            className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none dark:text-zinc-400"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            id="browse-search-input"
            type="text"
            autoComplete="off"
            placeholder="Search all apps…"
            aria-label="Search all apps"
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 pl-9 pr-9 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:border-violet-400 dark:focus:border-violet-600"
            onInput={(e) => browse()?.setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && e.currentTarget.value) {
                e.preventDefault();
                clear(false);
              }
            }}
          />
          <button
            id="browse-search-clear"
            className={state.showClear ? CLEAR_CLASS : `hidden ${CLEAR_CLASS}`}
            title="Clear search"
            aria-label="Clear search"
            onClick={() => clear(true)}
          >
            &times;
          </button>
        </div>
        {/*
            THE FILTER CHIPS (the prototype's scrDiscover): a chip picks WHICH
            apps the list holds, Sort below orders them, and the search above
            narrows them — see Browse.filterApps for what each chip admits.
            The language's own filter chip (@/components/ui/chip): a toggle
            with `aria-pressed`, selection drawn as the solid inversion, not
            the accent. `bar` is its size for a control row; `px-4` (over the
            primitive's `px-6`, through cn's twMerge) keeps all four on one
            line at 390px, and the rail scrolls rather than wrapping if a
            larger text size does not fit them.
        */}
        <ChipRail
          id="browse-filter-chips"
          role="group"
          aria-label="Filter apps"
          className="mt-2 max-w-xl gap-2 px-0 py-0"
        >
          {FILTER_CHIPS.map((f) => (
            <Chip
              key={f.key}
              size="bar"
              className="browse-filter-chip px-4"
              selected={state.filter === f.key}
              data-filter={f.key}
              onClick={() => browse()?.setFilter(f.key)}
            >
              {f.label}
            </Chip>
          ))}
        </ChipRail>
        {/*
            Sort (#1383). Rides the search bar rather than sitting in its own
            strip: both narrow the same list, and one sticky row costs the
            phone less of the fold than two would.

            CONTROLLED, off the store — so a ?sort= deep link, the remembered
            choice and a hand change all show the same value in the field, and
            the field can never disagree with the rows below it. `w-auto`
            overrides the cva's `w-full` through cn's twMerge (the control
            should be as wide as its longest label, not as wide as the bar).
        */}
        <div id="browse-sort-bar" className="mt-2 flex items-center gap-2 max-w-xl">
          <Label htmlFor="browse-sort-select" className="shrink-0">Sort</Label>
          <Select
            id="browse-sort-select"
            className="w-auto py-1.5"
            aria-label="Sort apps"
            value={state.sort}
            onChange={(e) => browse()?.setSort(e.currentTarget.value)}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </Select>
        </div>
      </div>
      {/*
          Level 1: the app-store list. ONE row markup, two layouts, and the
          switch is pure CSS — no matchMedia, no re-render on resize.
          Narrow: a hairline-divided vertical list of full-width rows (the
          App Store idiom). md and up: a 2/3-column grid whose rows pick up
          a bordered-box treatment from .browse-row in app.css.
      */}
      <div id="browse-list-level" className={onDetail ? 'hidden' : undefined}>
        {/*
            Grid only. Every border — the phone hairline AND the desktop box —
            is .browse-row in app.css; a divide-* utility here would win the
            cascade against it and strip the boxes' top/bottom edges.
        */}
        <div
          id="browse-list"
          // The rendering anchor for the declared ?sort= checks: it names the
          // order the rows below were actually built with, which a screenshot
          // of a <select> cannot be asserted on.
          data-sort={state.sort}
          // The chip the rows were filtered with, beside the order: the
          // declared check for the chips reads it for the same reason.
          data-filter={state.filter}
          // Phone: the BODY of the pane whose head is the search bar above
          // (#1919) — one frosted sheet holding the hairline-separated rows,
          // continuing the head's ring and closing its radius. It used to be
          // a plain white rounded-2xl card under a wallpaper-coloured bar;
          // the pane treatment is `browse-pane-body` in app.css, scoped to
          // below md. At md+ nothing changes: every row is its own box in the
          // grid (app.css), so only the grid utilities live here.
          //
          // Three columns only from xl (1280px), not lg (QA 2026-09-24 Q10):
          // at 1024 the sidebar leaves ~770px, and a third column squeezed
          // the name out of every box entirely.
          className="browse-pane-body md:grid md:grid-cols-2 xl:grid-cols-3 md:gap-3 md:p-3"
        >
          {state.error
            ? (
              // #1899: the shared error card, spanning the md+ grid; Retry
              // re-runs the same directory load.
              <AppsLoadError
                className="md:col-span-full"
                title="Couldn't load the app directory"
                onRetry={() => browse()?._load?.()}
              />
            )
            : <BrowseRows rows={state.rows} curated={state.curated} grouped={state.grouped} moreExpanded={state.moreExpanded} />}
        </div>
        {/*
            The nothing-to-show line. On a phone it stands in for the list as
            the pane's body (`browse-pane-note`, app.css): the list above it
            is empty and collapsed then, and without this the head would end
            on two square corners over a bare page.
        */}
        <div
          id="browse-empty"
          className={state.empty
            ? 'browse-pane-note px-3 pb-8 text-sm text-zinc-500 dark:text-zinc-400'
            : 'hidden browse-pane-note px-3 pb-8 text-sm text-zinc-500 dark:text-zinc-400'}
        >{state.empty}</div>
      </div>
      {/*
          Level 2: the per-app detail page (#apps/<slug>). Absorbs what the
          browse rows' "…" menu used to offer — see Browse._renderDetail.
      */}
      <div id="browse-detail" className={onDetail ? 'max-w-2xl mx-auto p-4' : 'hidden max-w-2xl mx-auto p-4'}>
        <BrowseDetail detail={state.detail} />
      </div>
    </main>
  );
}
