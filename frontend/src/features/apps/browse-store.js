/**
 * The browse screen's rendered state (#1191 slice 6, conversion 3).
 *
 * ./browse.js keeps every decision it already made — the sort, the search
 * filter, the level derivation, the contributor cache, the fetches — and stops
 * making HTML. It pushes descriptors here; ./browse-list.tsx and
 * ./browse-detail.tsx render them.
 *
 * `level` moved in here too. _syncLevel() used to toggle `hidden` on
 * #browse-list-level, #browse-detail and #browse-search-bar from outside
 * React; those three nodes are rendered by ./browse-screen.tsx, so the toggle
 * is now a store field the component reads. (The SCREEN's own visibility is
 * still the shell's visibility-store — that is App._showOnlyScreen's business,
 * not this module's.)
 *
 * The initial value is the PRERENDER state: level 'list', nothing loaded. The
 * hand-written shell shipped #browse-list and #browse-empty empty, #browse-
 * empty and #browse-detail hidden, and #browse-list-level and the search bar
 * visible — which is exactly what these values render. Data loads in effects,
 * never here.
 */

import { createStore } from '../../lib/plain-store.js';

export const browseStore = createStore({
  /** 'list' | 'detail' — which of the two levels inside #browse-screen shows. */
  level: 'list',
  /** null until the first _renderList; else an array of row descriptors. */
  rows: null,
  /**
   * The directory has not answered yet and nothing is held from Home's own
   * read (overnight audit L06): the rows' place shows their skeleton, and the
   * empty line waits rather than saying there are no apps. False in the
   * prerender, which renders neither.
   */
  loading: false,
  /**
   * The "Open site" row's descriptor ({ href, label }) while the search text
   * is a web address (#5364), else null — so the prerender, which has no
   * query, renders no site row and hydration is silent.
   */
  site: null,
  curated: true,
  grouped: true,
  moreExpanded: false,
  /**
   * The #browse-empty line: null hides it, a string shows it. A separate field
   * from `rows` because the load-failure state has neither rows nor an empty
   * hint — it has `error`.
   */
  empty: null,
  /**
   * The search text #browse-empty offers to make (#5928), while a search
   * matches no app in the whole directory; else null, which draws no button.
   * null is the PRERENDER value: there is no query in the SSG pass.
   */
  make: null,
  /** True after a failed /api/apps read, while the list level is showing. */
  error: false,
  /** null until the detail level is entered; else a detail descriptor. */
  detail: null,
  /**
   * Which of Browse.SORTS orders the list (#1383). 'recommended' is the
   * PRERENDER value: the persisted choice and the ?sort= override are read on
   * screen entry (Browse._applyInitialSort), never during render — neither
   * localStorage nor location.search exists in the SSG pass, and a first
   * client render that disagreed with the prerendered markup is a hydration
   * console.error, which fails proposal checks.
   */
  sort: 'recommended',
  /**
   * Which of Browse.VIEWS is showing ('foryou' | 'browse' | 'joined').
   * 'foryou' is the PRERENDER value, for the same reason as `sort`: ?filter=
   * and the session's own choice are applied on screen entry
   * (Browse._applyInitialFilter), never during render.
   */
  view: 'foryou',
  /**
   * The Show only switches that are on: keys of Browse.SHOW_ONLY. Empty is
   * the PRERENDER value.
   */
  only: [],
  /**
   * How many filter choices differ from the defaults: the switches that are
   * on, a picked type and a non-Recommended order. The number beside Filters;
   * 0 hides it. Derived by Browse.activeFilterCount(), never stored as a
   * preference. 0 is the PRERENDER value.
   */
  activeCount: 0,
  /**
   * The filter key DERIVED from `view` and `only`, not a control of its own:
   * 'yours' in the Joined view, otherwise the switches joined with a space,
   * 'all' when none. Read by #browse-list[data-filter] and the empty line.
   * 'all' is the PRERENDER value, for the same reason as `sort`.
   */
  filter: 'all',
  /**
   * The type chips (#3962) the page row shows, from
   * Browse.presentCategories: the types at least one app has, 'other' aside
   * unless a real type is present too ({ key, label } each), in order. Empty
   * hides the whole row, and is the PRERENDER value: which types the
   * directory holds is known only once /api/apps answers, so the row never
   * appears in the first render.
   */
  categories: [],
  /** The pressed type chip: 'all' or a key of Browse.CATEGORIES. */
  category: 'all',
});
