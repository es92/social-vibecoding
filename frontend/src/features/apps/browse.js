'use strict';

// Browse-all-apps screen (#apps) — the directory half of the home-screen
// split, laid out as an app store. The home feed is "Your apps" only (see
// frontend/src/features/home/home.js render()), so every OTHER app this viewer may see
// lives here.
//
// TWO LEVELS inside the one #browse-screen <main>, the same shape the
// admin console uses for its menu → section drill-in:
//
//   level 1  #apps          #browse-list-level — the row/box list
//   level 2  #apps/<slug>   #browse-detail     — one app's page
//
// The list renders ONE row markup and lets CSS pick the layout: a
// hairline-divided vertical list of full-width rows on a phone, bordered
// boxes in a 2/3-column grid on a wide screen. The grid is Tailwind
// responsive classes on #browse-list, the box treatment is .browse-row in
// app.css — no matchMedia, no re-render on resize.
//
// The detail page ABSORBS the per-row "…" menu the rows used to carry: its
// action rows are derived by filtering Home.menuItemsFor(app), so every
// permission gate (admin-only lock/delete, creator-or-admin retry,
// involved-user build log, non-self-hosted fork) stays in exactly one
// place and a new menu item shows up here for free.
//
// Still deliberately thin on the shared pieces, so this screen and the home
// grid cannot drift — but the pieces now come from two places rather than
// one (#1083 chunk F). The shared tile/chip decisions come from
// ./app-card.js, and as of #1191 slice 6 this file no longer touches them at
// all: ./browse-list.tsx and ./browse-detail.tsx render them through
// ./app-card-view.tsx, off the same descriptor functions the home grid's strings
// are built from. The rest is still Home's, reached through the global,
// because each one reads Home's loaded-app list or the viewer's permissions:
// isYours, filterApps, toggleAdded, menuItemsFor.
//
// WHAT THIS FILE DOES NOW (#1191 slice 6, conversion 3): every decision, and
// no markup. The sort, the search filter, the level derivation, the two
// fetches, the contributor cache, the action-list filtering and the
// screenshot deep link are all unchanged; where they used to end in an
// `innerHTML =`, they now end in a `Browse._store.set(…)` of a plain
// descriptor. It stays a plain .js module (not .ts, no JSX) because
// tests/browse-screen.test.js compiles this exact source in a vm context.
//
// Mounted by App.navigateToBrowse; PTR is wired once by
// App._wirePullToRefresh and covers both levels.

const Browse = {
  // The rendered-state store, planted by ./mount.ts (#1191 slice 6, conv. 3).
  // Reached through the object rather than imported for the same reason
  // Notifications._store is: tests/browse-screen.test.js evaluates this file's
  // real source in a vm context, which runs classic script text and strips the
  // imports, so a second import would be a binding that resolves to nothing at
  // call time. Every render method no-ops without it — which is the state the
  // pure sort/filter/derive tests run in.
  _store: null,

  _open: false,
  _apps: [],
  _query: '',
  // Which of Browse.SORTS orders the list (#1383). 'recommended' is the
  // default and the store's initial value; the persisted / URL choice is
  // applied on screen ENTRY, never during render — see _applyInitialSort.
  _sort: 'recommended',
  _moreExpanded: false,
  _searchDebounce: null,
  // Slug of the app whose detail page is showing; null = the list level.
  _slug: null,
  // Guards the cold-deep-link fetch below so a miss can't loop.
  _detailFetching: null,
  _detailMissing: false,
  _detailBlocked: false,
  // Where the CURRENT detail page was entered from, so the header's back
  // button lands where the user actually came from:
  //   'list' — a browse row tap, or a deep link / screenshot state. Back
  //            means up to the list (the default: it is the enclosing
  //            screen, and a deep link has no better answer).
  //   'home' — a home app card's "App details" menu item. The list was
  //            never on screen, so backing out to it would strand the user
  //            on a screen they never visited; back means home. (The
  //            browser/OS back gesture already does this on its own — it
  //            pops the hash entry home returned from — so this only
  //            teaches the header button to agree with it.)
  _detailOrigin: 'list',
  // The current detail page's action items, as returned by detailActionsFor.
  // They carry `run` closures, so the descriptor the store publishes holds
  // only their labels and an index back into this array.
  _detailActions: [],
  // Set by the opener BEFORE it writes the hash, consumed when the detail
  // level actually opens. A separate field from _detailOrigin so a stale
  // note can't relabel a later, differently-entered page.
  _pendingOrigin: null,

  // ── Contributors section state (#919) ─────────────────────────────
  //
  // _renderDetail republishes the whole page descriptor on EVERY render(),
  // and render() fires often — syncFrom on each /api/apps refresh, and
  // after every favourite toggle. So the fetched list has to live out here
  // or each repaint would refetch and flash. Keyed by slug, cleared on
  // close() so re-entering the screen gets fresh counts.
  //   slug -> { state: 'loading' | 'ready' | 'error', items, total }
  _contrib: new Map(),
  // Single-flight guard, same discipline as _detailFetching.
  _contribFetching: null,
  // Whether the current page's list is past the 5-row fold. Reset on every
  // level change alongside _detailMissing so a new page never inherits it.
  _contribExpanded: false,
  // True between an open({ chrome: false }) and the syncChrome() app.js
  // runs inside the screen transition (#979).
  _chromeSuspended: false,
  // Apps joined from a row during this visit (#5267). They keep their place
  // in "Recommended for you" and under Not joined, now saying Open, so a
  // tap on Join never makes the row it was on jump away. Cleared on a new
  // visit and on a chip change, when the list is rebuilt anyway.
  _keptJoins: new Set(),

  isOpen() { return Browse._open; },

  // Declared by whoever is about to open a detail page, immediately before
  // it assigns location.hash (the hashchange lands in a later task, so the
  // note is always in place by the time route()/open() reads it).
  noteDetailOrigin(origin) {
    Browse._pendingOrigin = origin === 'home' ? 'home' : 'list';
  },

  // Consume the pending note exactly once per detail entry.
  _takeOrigin() {
    Browse._detailOrigin = Browse._pendingOrigin || 'list';
    Browse._pendingOrigin = null;
  },

  // Screen entry. `slug` (from #apps/<slug>) opens straight onto a detail
  // page. First paint borrows Home's cache when it has one — the user
  // almost always arrives from the home feed — then the refetch reconciles.
  //
  // `opts.chrome === false` renders without touching the platform header;
  // the caller runs Browse.syncChrome() inside the screen transition
  // instead (#979 — see _syncChrome).
  open(slug, opts) {
    if (!Browse._open) {
      // Pure disclosure state for review captures; no requests or writes.
      Browse._moreExpanded = new URLSearchParams(location.search).get('shot') === 'browse-more';
      Browse._keptJoins.clear();
    }
    Browse._open = true;
    Browse._chromeSuspended = !!(opts && opts.chrome === false);
    Browse._slug = slug || null;
    Browse._detailMissing = false;
    Browse._detailBlocked = false;
    Browse._contribExpanded = false;
    if (Browse._slug) Browse._takeOrigin();
    else Browse._pendingOrigin = null;
    if (!Browse._apps.length && Array.isArray(Home._apps) && Home._apps.length) {
      Browse._apps = Home._apps;
    }
    Browse._applyInitialSort();
    Browse._applyInitialFilter();
    Browse._syncLevel();
    Browse.render();
    Browse._load();
  },

  close() {
    Browse._open = false;
    Browse._slug = null;
    Browse._detailMissing = false;
    Browse._detailBlocked = false;
    // Leaving the screen retires the entry note with it — the next detail
    // page declares its own origin.
    Browse._detailOrigin = 'list';
    Browse._pendingOrigin = null;
    // Contributor counts move as proposals merge, so don't carry a cache
    // across a whole screen visit — the next entry re-reads them.
    Browse._contrib.clear();
    Browse._contribExpanded = false;
  },

  // ── Level switching ───────────────────────────────────────────────
  //
  // The hash is the source of truth for WHICH level shows (#apps vs
  // #apps/<slug>); these just apply it. route() is the in-screen
  // navigation entry point App.navigateToBrowse hands off to when the
  // screen is already mounted.

  route(slug) {
    const next = slug || null;
    if (next === Browse._slug) {
      // Same level re-entered (a repeat hash write) — repaint, no animation.
      Browse.render();
      return;
    }
    const goingDeeper = !!next && !Browse._slug;
    Browse._slug = next;
    Browse._detailMissing = false;
    Browse._detailBlocked = false;
    Browse._contribExpanded = false;
    if (next) Browse._takeOrigin();
    else Browse._pendingOrigin = null;
    PlatformUI.transition(() => {
      Browse._syncLevel();
      Browse.render();
    }, { type: goingDeeper ? 'push' : 'pop' });
  },

  showDetail(slug) {
    if (!slug) return;
    Browse._slug = slug;
    Browse._detailMissing = false;
    Browse._detailBlocked = false;
    Browse._contribExpanded = false;
    Browse._takeOrigin();
    Browse._syncLevel();
    Browse.render();
  },

  showList() {
    Browse._slug = null;
    Browse._detailMissing = false;
    Browse._detailBlocked = false;
    Browse._contribExpanded = false;
    Browse._pendingOrigin = null;
    Browse._syncLevel();
    Browse.render();
  },

  // The header's single back button. Inside a detail page it goes back the
  // way the user came in — up to the list for a row tap or a deep link,
  // out to home when the page was opened from a home card's "App details"
  // menu (see _detailOrigin). Both routes match what the browser/OS back
  // gesture does from the same state. On the list it declines and the
  // #back-btn handler's App.navigateHome runs.
  handleBack() {
    if (!Browse._slug) return false;
    if (Browse._detailOrigin === 'home') {
      // navigateHome() runs _exitBrowse() and updateHash(), so the URL
      // stops naming a screen that is no longer showing.
      App.navigateHome();
      return true;
    }
    // #3620: up to the list is a step Back when the list is the entry below,
    // so Back afterwards leaves Discover rather than reopening the page.
    if (typeof App !== 'undefined' && App._stepBackTo && App._stepBackTo('#apps')) return true;
    location.hash = '#apps';
    return true;
  },

  // Container + chrome for the current level. Borrows the admin console's
  // arrow-vs-house back icon convention for a drill-in.
  // The level is a store field now, not three classList.toggle calls: all
  // three nodes are rendered by ./browse-screen.tsx, and the migration's rule
  // is that nothing outside React writes into a React-owned subtree. The
  // search bar rides along because searching the directory is a level-1
  // affordance — on a detail page the field would filter a list nobody sees.
  _syncLevel() {
    if (Browse._store) Browse._store.set({ level: Browse._slug ? 'detail' : 'list' });
    Browse._syncChrome();
  },

  // The public half of _syncChrome: clears the suspension a
  // `chrome: false` open() set and applies the chrome for real. app.js
  // calls this INSIDE the screen transition's callback (#979).
  syncChrome() {
    Browse._chromeSuspended = false;
    Browse._syncChrome();
  },

  // The platform-header half of _syncLevel, split out so screen ENTRY can
  // defer it (#979). The rest of _syncLevel writes inside #browse-screen,
  // which is still hidden at that point and therefore invisible; the
  // header is not, and writing it before the screen transition starts
  // bakes the incoming screen's title into the View Transition's snapshot
  // of the page being left.
  _syncChrome() {
    if (Browse._chromeSuspended) return;
    const onDetail = !!Browse._slug;
    // #1036: the header control is a real anchor, so it needs the same
    // target handleBack() would take — up to the list, or all the way
    // home when the detail page was opened from a home card's "App
    // details" entry (there is no list behind it to go up to).
    // #2639: the LIST shows the house. #1569 read the list and Home as peer
    // destinations and kept their bars identical, which left the directory
    // with an empty bar and the chip menu's Home row as the only way out.
    // Browse took the house after that, like every other screen you navigate
    // into.
    //
    // IT IS A TAB ROOT NOW (#2718 review), so the list level shows NOTHING:
    // Discover is its own tab, the bar is on screen beside it, and a corner
    // control that goes home is a second way to press a button already in
    // view. The empty bar #2639 fixed is not back — what fixed it was giving
    // the viewer a way out, and the tab bar is a better one than the house.
    //
    // DETAILS ARE UNCHANGED in shape and differ in one case: the arrow up to
    // the list when there is a list behind it, and otherwise nothing, because
    // a detail opened from a Home card has the same tab bar under it and no
    // list to go up to.
    //
    // This runs AFTER _showOnlyScreen inside the same transition and calls
    // setBackIcon unconditionally, so it is the value that survives. The two
    // have to agree or the later one silently wins — which is exactly how a
    // first attempt at #2639 changed only app.js and did nothing at all.
    // App._BACK_SLOT is the other writer; 'browse-screen' is a root there.
    const upToList = onDetail && Browse._detailOrigin !== 'home';
    const backMode = upToList ? 'arrow' : 'none';
    App.setBackIcon(backMode, upToList ? '#apps' : undefined);
    if (onDetail) {
      const app = Browse.appBySlug(Browse._slug);
      App.setHeaderTitle(app?.name || Browse._slug);
    } else {
      App.setHeaderTitle(PlatformI18n.t('discover:browse.headerTitle'));
    }
  },

  // ── Data ──────────────────────────────────────────────────────────

  appBySlug(slug) {
    return (Browse._apps || []).find((a) => a && a.slug === slug) || null;
  },

  // Adopt a fresh /api/apps payload that somebody ELSE fetched, and
  // repaint. Home.load() calls this while this screen is on top, which is
  // how the detail page's actions (add/remove, retry, lock, delete — they
  // all settle through Home.load()) land here without this file knowing
  // anything about them.
  syncFrom(apps) {
    if (!Array.isArray(apps)) return;
    Browse._apps = apps;
    // A delete that succeeded takes its app out of the payload — there is
    // no page left to show, so fall back to the list.
    if (Browse._slug && !Browse.appBySlug(Browse._slug)) {
      if (Browse._detailFetching) return; // a cold-load fetch is still in flight
      location.hash = '#apps';
      return;
    }
    Browse.render();
    // The name can change under us (a merged rename), so re-title.
    if (Browse._slug) Browse._syncLevel();
  },

  // Same endpoint (and same ?demo=1 passthrough) as Home.load: one
  // visibility-filtered payload backs home, this list and the detail page,
  // so a private app is simply absent for a viewer who can't see it — no
  // extra gating here. Writes land in Home._apps too, so returning home
  // shows the adds made here even before its own reload.
  async _load() {
    try {
      const params = new URLSearchParams(location.search);
      const demoQS = params.get('demo') === '1' ? `?demo=1${params.get('curation') === '1' ? '&curation=1' : ''}` : '';
      const res = await fetch(`/api/apps${demoQS}`);
      if (!res.ok) throw new Error('Failed to load apps');
      const { apps } = await res.json();
      Browse._apps = apps;
      Home._apps = apps;
      Browse.render();
      if (Browse._slug) Browse._syncLevel();
    } catch (err) {
      if (Browse._store && !Browse._slug) {
        Browse._store.set({ rows: [], empty: null, error: true });
      }
    }
  },

  // ── Sorting (#1383) ───────────────────────────────────────────────
  //
  // "When viewing the list of apps that are available, it'd be useful to be
  // able to sort it by number of users, how actively developed it is, etc."
  // Five orders over the ONE /api/apps payload the screen already holds, so
  // switching is instant: no second endpoint, no paging, no spinner.
  //
  // The order of this array is the order of the <select>; the first entry is
  // the default. Labels are user-facing.
  SORTS: [
    { key: 'recommended', label: 'discover:sort.recommended' },
    { key: 'users', label: 'discover:sort.users' },
    { key: 'active', label: 'discover:sort.active' },
    { key: 'merged', label: 'discover:sort.merged' },
    { key: 'new', label: 'discover:sort.newest' },
  ],

  // localStorage key for the remembered choice. Namespaced like the rest of
  // the shell's client-side preferences.
  SORT_STORAGE_KEY: 'usernode:browse-sort',

  // Anything unrecognised — a stale stored value, a hand-typed ?sort= — falls
  // back to the default rather than emptying the screen. Pure — unit-tested.
  resolveSort(raw) {
    const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return Browse.SORTS.some((s) => s.key === key) ? key : 'recommended';
  },

  // Precedence on screen entry: ?sort= (a link someone was handed, and what
  // the before/after captures and the declared checks navigate to) beats the
  // remembered choice, which beats the default.
  //
  // The URL form is READ-ONLY: it seeds the control for this visit and is
  // never written back to storage, so following a `?sort=new` link cannot
  // silently repoint somebody's directory forever. Changing the control by
  // hand IS an explicit choice, and setSort persists that.
  //
  // Runs on ENTRY, not during render: reading localStorage while rendering
  // would throw in the SSG prerender (no localStorage in Node) and make the
  // first client render disagree with the prerendered markup, which is a
  // hydration console.error — and a console error on any route fails checks.
  _applyInitialSort() {
    const fromUrl = Browse._urlSort();
    const key = fromUrl || Browse._storedSort() || 'recommended';
    Browse._sort = Browse.resolveSort(key);
    if (Browse._store) Browse._store.set({ sort: Browse._sort });
  },

  // null when absent/unrecognised, so the caller can fall through to storage.
  _urlSort() {
    let raw = null;
    try { raw = new URLSearchParams(location.search).get('sort'); } catch (err) { return null; }
    if (!raw) return null;
    const key = Browse.resolveSort(raw);
    return key === 'recommended' && raw.trim().toLowerCase() !== 'recommended' ? null : key;
  },

  // Storage can throw outright (Safari private mode, an iframe denied
  // storage), so both accessors swallow — a missing preference is not an
  // error, it is the default.
  _storedSort() {
    try {
      const raw = window.localStorage.getItem(Browse.SORT_STORAGE_KEY);
      if (!raw) return null;
      const key = Browse.resolveSort(raw);
      return key === 'recommended' && raw !== 'recommended' ? null : key;
    } catch (err) { return null; }
  },

  // The control's onChange. Always persists: this is the user saying so.
  setSort(key) {
    const next = Browse.resolveSort(key);
    Browse._sort = next;
    try { window.localStorage.setItem(Browse.SORT_STORAGE_KEY, next); } catch (err) { /* ignore */ }
    if (Browse._store) Browse._store.set({ sort: next });
    Browse.render();
  },

  // ── Filter chips (the prototype's scrDiscover) ────────────────────
  //
  // All · Featured · Not joined · Joined · New, in a row above the list,
  // and Not yet reviewed after them for an admin (ADMIN_FILTERS). A chip
  // FILTERS where Sort only reorders, and the three controls compose in one
  // fixed order: the chip picks the set, Sort orders it, the search narrows
  // it. So "Featured, by Most users" is the featured apps ranked by users,
  // and switching chips never loses the order the viewer chose.
  //
  // The order of this array is the order of the chips; the first is the
  // default and the store's prerender value. Labels are user-facing, and
  // browse-screen.tsx keeps a COPY of them for the same reason it keeps one
  // of SORTS (tests/browse-screen.test.js pins the two together).
  FILTERS: [
    { key: 'all', label: 'discover:filter.all' },
    { key: 'featured', label: 'discover:filter.featured' },
    // What you could still join (#5267): Discover is for finding new
    // things, and this chip is the list without the ones you are in.
    { key: 'notjoined', label: 'discover:filter.notJoined' },
    // The key stays `yours` — ?filter=yours links and the declared checks
    // select on it — while the label says what the chip now holds: the
    // communities you are in, not the shortcuts on your Home screen.
    { key: 'yours', label: 'discover:filter.joined' },
    { key: 'new', label: 'discover:filter.new' },
  ],

  // The chips only an admin gets, after the rest (#5267). "Not yet
  // reviewed" is moderation state: it used to be a heading in everybody's
  // default list, and it is now a filter for the people who review. The
  // apps under it are NOT hidden from anyone: they still sit in the default
  // list, after the reviewed ones, as they always have (directoryTier), with
  // no heading or label naming the review. browse-screen.tsx keeps a copy,
  // for the reason it keeps one of FILTERS.
  ADMIN_FILTERS: [
    { key: 'unreviewed', label: 'discover:filter.unreviewed' },
  ],

  // An admin, as the shell sees one: `App.user.isAdmin`, which "View as
  // non-admin" masks, so that view loses the chip too.
  isAdminViewer() {
    try { return !!(typeof App !== 'undefined' && App.user && App.user.isAdmin); } catch (err) { return false; }
  },

  // "New" is the apps CREATED in the last NEW_WINDOW_DAYS days (by
  // `created_at`). A directory where nothing is that young would give the
  // chip an empty list, which reads as a broken filter rather than a quiet
  // fortnight, so it then answers with the NEW_FALLBACK_COUNT most recently
  // created apps instead: the chip always shows what arrived last.
  NEW_WINDOW_DAYS: 14,
  NEW_FALLBACK_COUNT: 6,

  // The chip, remembered for the SESSION only: it lives on this object, so it
  // survives leaving Discover and coming back, and a reload starts on All. No
  // storage, unlike Sort — a filter left on by a visit last week is a
  // directory that silently hides most of itself.
  _filter: 'all',
  // ?filter= seeds the FIRST entry of a page load and is then spent, so a
  // link someone was handed (and every declared check) lands on its chip
  // without overriding a choice made by hand later in the same visit.
  _urlFilterTaken: false,

  // Anything unrecognised falls back to All rather than emptying the screen,
  // and so does an admin chip asked for by anyone else.
  // Pure but for the admin read; unit-tested.
  resolveFilter(raw) {
    const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (Browse.FILTERS.some((f) => f.key === key)) return key;
    if (Browse.ADMIN_FILTERS.some((f) => f.key === key) && Browse.isAdminViewer()) return key;
    return 'all';
  },

  // Runs on screen ENTRY, never during render — the same reason
  // _applyInitialSort gives: location.search does not exist in the SSG pass,
  // and a first client render that disagreed with the prerender (All) would
  // be a hydration console.error.
  _applyInitialFilter() {
    if (!Browse._urlFilterTaken) {
      Browse._urlFilterTaken = true;
      let raw = null;
      try { raw = new URLSearchParams(location.search).get('filter'); } catch (err) { raw = null; }
      if (raw) Browse._filter = Browse.resolveFilter(raw);
    }
    if (Browse._store) Browse._store.set({ filter: Browse._filter, adminFilters: Browse.isAdminViewer() });
  },

  // A chip's onClick.
  setFilter(key) {
    const next = Browse.resolveFilter(key);
    Browse._filter = next;
    Browse._keptJoins.clear();
    if (Browse._store) Browse._store.set({ filter: next });
    Browse.render();
  },

  // ── Type chips (#3962) ────────────────────────────────────────────
  //
  // A second row under the filter chips: All types, then one chip per KIND
  // of app (dapp.json's top-level `category`, which the deploy reads into
  // the manifest snapshot GET /api/apps already carries). Nothing guesses a
  // type: an app is under a type only when its own dapp.json says so, so an
  // app that says nothing is listed under All types alone.
  //
  // A COPY of app-manifest.js APP_CATEGORIES, labelled, in its order; the
  // server's list is the authority on which words are valid and
  // tests/browse-screen.test.js pins the two together. The screen draws the
  // row from the `categories` the list render publishes, never from this
  // array directly, so the chips are only the types some app has.
  CATEGORIES: [
    { key: 'games', label: 'discover:category.games' },
    { key: 'social', label: 'discover:category.social' },
    { key: 'tools', label: 'discover:category.tools' },
    { key: 'learning', label: 'discover:category.learning' },
    { key: 'creative', label: 'discover:category.creative' },
    { key: 'other', label: 'discover:category.other' },
  ],

  // Remembered for the session only, like _filter, and for the same reason.
  _category: 'all',

  // An app's type, or null: the snapshot's `category` when it is one of
  // CATEGORIES. Pure — unit-tested.
  appCategory(app) {
    const snap = app && app.manifest_snapshot;
    const raw = snap && typeof snap === 'object' ? snap.category : null;
    const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return Browse.CATEGORIES.some((c) => c.key === key) ? key : null;
  },

  // The chips the row shows: every type at least one app in the directory
  // has, in CATEGORIES order. Read off the whole directory, not the filtered
  // list, so the row stays put while the other controls change. Empty while
  // no app has a type other than `other`: a row of All types and Other
  // alone would sort nothing, so it stays absent until projects tag
  // themselves. Pure — unit-tested.
  presentCategories(apps) {
    const have = new Set();
    for (const a of apps || []) {
      const key = Browse.appCategory(a);
      if (key) have.add(key);
    }
    if (![...have].some((key) => key !== 'other')) return [];
    return Browse.CATEGORIES.filter((c) => have.has(c.key));
  },

  // A type the directory has, else All types: a chip that is gone (its last
  // app retagged) cannot stay pressed over an empty list.
  resolveCategory(raw, apps) {
    const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    const present = Browse.presentCategories(apps === undefined ? Browse._apps : apps);
    return present.some((c) => c.key === key) ? key : 'all';
  },

  // A type chip's onClick.
  setCategory(key) {
    Browse._category = Browse.resolveCategory(key);
    if (Browse._store) Browse._store.set({ category: Browse._category });
    Browse.render();
  },

  // The type's set. 'all' is the list unchanged. Pure — unit-tested.
  categoryApps(apps, key) {
    const list = (apps || []).filter(Boolean);
    if (!key || key === 'all') return list;
    return list.filter((a) => Browse.appCategory(a) === key);
  },

  // The New chip's set: see NEW_WINDOW_DAYS. `now` is injectable for the
  // tests. Pure — unit-tested.
  newApps(apps, now) {
    const at = Number.isFinite(now) ? now : Date.now();
    const created = (a) => {
      const t = a && a.created_at ? new Date(a.created_at).getTime() : NaN;
      return Number.isNaN(t) ? null : t;
    };
    const windowMs = Browse.NEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const list = (apps || []).filter(Boolean);
    const recent = list.filter((a) => {
      const t = created(a);
      return t != null && at - t <= windowMs;
    });
    if (recent.length) return recent;
    return list
      .filter((a) => created(a) != null)
      .sort((x, y) => created(y) - created(x))
      .slice(0, Browse.NEW_FALLBACK_COUNT);
  },

  // The chip's set, before any sort or search. Each chip reads a predicate
  // that already exists rather than growing its own:
  //   featured — the per-viewer `featured` flag GET /api/apps serializes: the
  //              admin's curation, the same flag Home's featured lane reads
  //              (Home.featuredApps). Here it is the WHOLE curated set: the
  //              directory lists apps you have too, and has no six-card cap.
  //   yours    — Home.isJoined: the communities you are in, the same flag the
  //              rows' Join pill reads, so the chip and the pill can never
  //              disagree. Not Home.isYours — taking an app off Home is not
  //              leaving it, and Discover is where you join and leave.
  //   notjoined: the rest, not Home.isJoined, plus the apps joined from a
  //              row during this visit (_keptJoins), which stay until the
  //              list is rebuilt.
  //   new      — newApps above.
  //   unreviewed: admins only, directoryTier 'unreviewed', exactly the
  //              apps the "Not yet reviewed" heading used to hold.
  // Pure — unit-tested.
  filterApps(apps, key, now) {
    const filter = Browse.resolveFilter(key == null ? Browse._filter : key);
    const list = (apps || []).filter(Boolean);
    if (filter === 'featured') return list.filter((a) => !!a.featured);
    if (filter === 'notjoined') return list.filter((a) => !Home.isJoined(a) || Browse._keptJoins.has(a.slug));
    if (filter === 'yours') return list.filter((a) => Home.isJoined(a));
    if (filter === 'new') return Browse.newApps(list, now);
    if (filter === 'unreviewed') return list.filter((a) => Browse.directoryTier(a) === 'unreviewed');
    return list;
  },

  // The nothing-to-show line, per chip. With a type picked and no search,
  // it says the type has nothing here, since the type row only offers types
  // some app has: it is the filter chip that emptied it. Pure — unit-tested.
  emptyText(query, key, category) {
    const filter = Browse.resolveFilter(key == null ? Browse._filter : key);
    const q = String(query || '').trim();
    if (!q && category && category !== 'all') return PlatformI18n.t('discover:empty.category');
    if (q) {
      if (filter === 'featured') return PlatformI18n.t('discover:empty.search.featured', { query: q });
      if (filter === 'notjoined') return PlatformI18n.t('discover:empty.search.notJoined', { query: q });
      if (filter === 'yours') return PlatformI18n.t('discover:empty.search.joined', { query: q });
      if (filter === 'unreviewed') return PlatformI18n.t('discover:empty.search.unreviewed', { query: q });
      if (filter === 'new') return PlatformI18n.t('discover:empty.search.new', { query: q });
      return PlatformI18n.t('discover:empty.search.all', { query: q });
    }
    if (filter === 'featured') return PlatformI18n.t('discover:empty.featured');
    if (filter === 'notjoined') return PlatformI18n.t('discover:empty.notJoined');
    if (filter === 'yours') return PlatformI18n.t('discover:empty.joined');
    if (filter === 'unreviewed') return PlatformI18n.t('discover:empty.unreviewed');
    return PlatformI18n.t('discover:empty.all');
  },

  // Unreviewed is not the same as broken. Apps with icons that have not yet
  // been reviewed remain visible after the reviewed ones (#5267: in the same
  // list, under no heading of their own); explicit demos,
  // failures, and apps still needing setup/icon work go under Show more.
  directoryTier(app) {
    if (Home.isDiscoveryReady(app)) return 'ready';
    if (app?.directory?.tier === 'more' || app?.status === 'error') return 'more';
    return 'unreviewed';
  },

  // Where an app sits in the admin's featured order: its featured_order, an
  // unordered featured app after the ordered ones, everything else last.
  featuredRank(a) {
    return a && a.featured
      ? (a.featured_order == null ? Number.MAX_SAFE_INTEGER - 1 : a.featured_order)
      : Number.MAX_SAFE_INTEGER;
  },

  // "Recommended for you" (#5267), the default list's first section. There
  // is no recommender behind it, on purpose: it is the admin's featured set
  // (the same `featured` flag the Featured chip and Home's featured lane
  // read), less the apps you are already in, in the featured order. An app
  // you join from it stays for the visit (_keptJoins). The `more` tier
  // (demos, apps needing fixes) never leads the page, featured or not.
  // Pure; unit-tested.
  recommendedApps(apps) {
    return (apps || [])
      .filter((a) => a && a.featured
        && (!Home.isJoined(a) || Browse._keptJoins.has(a.slug))
        && Browse.directoryTier(a) !== 'more')
      .slice()
      .sort((x, y) => Browse.featuredRank(x) - Browse.featuredRank(y));
  },

  toggleMore() {
    Browse._moreExpanded = !Browse._moreExpanded;
    Browse.render();
  },

  // Sorting REORDERS, it never filters: every order returns the same set of
  // rows, so a switch can't make an app disappear. (Deliberately unlike the
  // home screen's Popular lane, which drops zero-user apps.)
  //
  // Every comparator returns 0 on a tie, so Array.prototype.sort's stability
  // falls the tail back to the order /api/apps returned — its own
  // chat-activity ranking — rather than to an arbitrary one.
  //
  // FEATURED PINNING applies under 'recommended' ONLY. That list is an admin
  // curation and the default must not silently override it; but under an
  // explicit "Most users" a featured app that nobody uses sitting on top
  // would just look like the control is broken, so there it takes the
  // position its numbers earn.
  // Pure — unit-tested in tests/browse-screen.test.js.
  sortApps(apps, key) {
    const sort = Browse.resolveSort(key == null ? Browse._sort : key);
    const num = (v) => (parseInt(v, 10) || 0);
    const users = (a) => num(a && a.active_users);
    const time = (v) => {
      if (!v) return null;
      const t = new Date(v).getTime();
      return Number.isNaN(t) ? null : t;
    };
    // Newest first, with unparseable/missing timestamps last in either
    // direction (they carry no information; they should not lead).
    const byTimeDesc = (a, b) => {
      if (a === b) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return b - a;
    };
    const featuredRank = Browse.featuredRank;
    // The later of "last change merged" and "last deploy" — an app can ship
    // without a community proposal and vice versa, and either is a sign of
    // life.
    const touched = (a) => {
      const m = time(a && a.last_merged_at);
      const d = time(a && (a.last_deploy_at || a.created_at));
      if (m == null) return d;
      if (d == null) return m;
      return Math.max(m, d);
    };

    const cmp = {
      // Reviewed apps first. Within each quality tier, preserve the admin's
      // featured order and then rank by users. Popularity is not verification.
      recommended: (x, y) => {
        const tiers = { ready: 0, unreviewed: 1, more: 2 };
        const tier = tiers[Browse.directoryTier(x)] - tiers[Browse.directoryTier(y)];
        if (tier) return tier;
        const fx = featuredRank(x);
        const fy = featuredRank(y);
        if (fx !== fy) return fx - fy;
        // Same bucket. Inside the featured bucket the ranks already differ
        // (distinct sort_order), so this only orders the non-featured tail.
        return users(y) - users(x);
      },
      users: (x, y) => users(y) - users(x),
      // "How actively developed is it" — accepted community proposals in the
      // last 30 days, then recency of the last sign of life, then size.
      active: (x, y) => (
        num(y && y.merged_prs_recent) - num(x && x.merged_prs_recent)
        || byTimeDesc(touched(x), touched(y))
        || users(y) - users(x)
      ),
      // All-time accepted proposals: the app with the deepest history of
      // community changes, not the busiest month.
      merged: (x, y) => (
        num(y && y.merged_prs) - num(x && x.merged_prs)
        || byTimeDesc(time(x && x.last_merged_at), time(y && y.last_merged_at))
      ),
      new: (x, y) => byTimeDesc(time(x && x.created_at), time(y && y.created_at)),
    }[sort];

    return (apps || []).slice().sort(cmp);
  },

  // A query that looks like a web address offers to open the site, the way a
  // browser's address bar does (#5364). The row is appended to the same list
  // the app matches render in; app search itself is untouched (Home.filterApps).
  //
  // Pure — unit-tested in tests/browse-screen.test.js. Returns
  // { href, label } or null:
  //   href  — the address to open, https:// added when the person left it off
  //   label — the address as they typed it, without the http(s):// prefix and
  //           without a trailing /
  siteFor(query) {
    const raw = String(query == null ? '' : query).trim();
    if (!raw || /\s/.test(raw)) return null;
    let candidate = raw;
    if (!/^https?:\/\//i.test(candidate)) {
      // A bare "name.tld" shape, optionally a :port and a path/query/hash.
      // Plain words ("notes"), decimals ("1.5") and phrases never trigger.
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([\/?#].*)?$/i.test(candidate)) return null;
      candidate = `https://${candidate}`;
    }
    let url;
    try { url = new URL(candidate); } catch (err) { return null; }
    // Only web pages open. This also rejects javascript:, data:, a host with
    // no dot (https://localhost) and anything malformed URL cannot parse.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    const label = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return { href: url.href, label };
  },

  // The rows for the current chip and query. The chip picks the set first
  // (filterApps), then the sort orders it, then the search narrows it. The
  // search covers every app the chip admits (home's own search is scoped to
  // "Your apps"), reusing Home's search (Home.filterApps) so both fields
  // behave identically. The three compose, and searching keeps the sort's
  // order with one exception (#4793): an app whose name or slug IS the
  // query moves to the top, the rest staying where the sort put them.
  visibleApps() {
    const chipped = Browse.filterApps(Browse._apps, Browse._filter);
    const pool = Browse.categoryApps(chipped, Browse.resolveCategory(Browse._category));
    const sorted = Browse.sortApps(pool, Browse._sort);
    return Home.filterApps(sorted, Browse._query);
  },

  // ── Row rendering ─────────────────────────────────────────────────

  // The row's second line. There is no description column on `apps` (and
  // dapp.json carries descriptions only per-secret), so this is derived
  // META, not prose: who's using it, when it last shipped, and the status
  // word when the app isn't actually running.
  //
  // It ADAPTS to the current sort (#1383), so the number a row was ranked by
  // is the number the row shows — a list ordered by merged proposals whose
  // rows only mention users reads as unsorted. The user count leads in every
  // variant: it is the one figure people scan for.
  //
  //   recommended / users   12 users · Updated 3d ago
  //   active                12 users · 4 merged in 30d · Updated 3d ago
  //   merged                12 users · 37 changes merged · Updated 3d ago
  //   new                   12 users · Created 5d ago
  //
  // A zero-merge app omits the merge segment rather than printing "0 merged",
  // which reads as a defect rather than as an absence. So does a zero user
  // count (polish N12): "0 users" beside the row's "Joined" read as a
  // contradiction, and a zero says nothing in this shell.
  // Pure — unit-tested.
  metaLine(app, key) {
    if (!app) return '';
    const sort = Browse.resolveSort(key == null ? Browse._sort : key);
    const bits = [];
    const users = parseInt(app.active_users || 0, 10) || 0;
    if (users > 0) bits.push(PlatformI18n.t('discover:row.meta.users', { count: users }));
    if (sort === 'active') {
      const recent = parseInt(app.merged_prs_recent || 0, 10) || 0;
      if (recent > 0) bits.push(PlatformI18n.t('discover:row.meta.liveRecently', { count: recent }));
    } else if (sort === 'merged') {
      const merged = parseInt(app.merged_prs || 0, 10) || 0;
      if (merged > 0) bits.push(PlatformI18n.t('discover:row.meta.changesLive', { count: merged }));
    }
    if (sort === 'new') {
      const created = formatRelativeTime(app.created_at);
      if (created) bits.push(PlatformI18n.t('discover:row.meta.created', { when: created }));
    } else {
      const rel = formatRelativeTime(app.last_deploy_at || app.created_at);
      if (rel) bits.push(PlatformI18n.t('discover:row.meta.updated', { when: rel }));
    }
    const status = app.status === 'running' ? ''
      : app.status === 'creating' ? PlatformI18n.t('discover:row.status.creating')
      : app.status === 'awaiting_secrets' ? PlatformI18n.t('discover:row.status.awaitingSecrets')
      : app.status === 'error' ? PlatformI18n.t('discover:row.status.error')
      : app.status || '';
    if (status) bits.push(status);
    return bits.length ? joinFacts(bits) : '';
  },

  // One app-store row, as DATA: icon · name + meta + status pills · Add
  // button. ./browse-list.tsx renders it; the same descriptor is the desktop
  // box, because the layout switch is pure CSS (.browse-row in app.css).
  //
  // `app` travels on the descriptor because the shared card primitives take
  // the record, not a pre-rendered fragment — see ./app-card-view.tsx.
  // Pure — unit-tested in tests/browse-screen.test.js.
  rowView(app) {
    const isDemo = !!app.demo;
    // The pill is membership now (Join, or Open once joined), not the Home shortcut it
    // used to be: see Home.setMembership. `added` keeps its name because the
    // row's data-added attribute is what the declared checks select on.
    const isAdded = Home.isJoined(app);
    // A joined row offers Open (#5267), the app itself, where it used to
    // say "✓ Joined"; only an app that can run gets one (the detail page's
    // canOpen rule), and an inert staging fixture never does.
    const canOpen = !isDemo && (app.status === 'running' || app.status === 'awaiting_secrets');
    return {
      app,
      directoryTier: Browse.directoryTier(app),
      slug: app.slug,
      name: app.name || app.slug,
      meta: Browse.metaLine(app, Browse._sort),
      status: app.status || '',
      statusDot: app.status === 'running' ? 'running'
        : app.status === 'error' ? 'error' : 'creating',
      // Staging ?demo=1 rows are inert: their slugs have no DB row, so the
      // detail page would 404 and the favorite POST would too.
      demo: isDemo,
      openable: !isDemo,
      added: isAdded,
      canOpen,
      addTitle: isAdded
        ? PlatformI18n.t('discover:row.open.tip', { app: app.name || app.slug })
        : PlatformI18n.t('discover:row.join.tip', { app: app.name || app.slug }),
    };
  },

  // ── Render (dispatches to the level that is showing) ──────────────

  render() {
    if (!Browse._slug) Browse._renderList();
    else Browse._renderDetail();
  },

  _renderList() {
    if (!Browse._store) return;
    const apps = Browse.visibleApps();
    const query = (Browse._query || '').trim();
    // The DEFAULT list (#5267): Recommended order, the All chip, no search.
    // Only it is grouped, and it leads with "Recommended for you"; every
    // other chip and sort is one list in its own order.
    const categories = Browse.presentCategories(Browse._apps);
    const category = Browse.resolveCategory(Browse._category);
    const grouped = Browse._sort === 'recommended' && !query && Browse._filter === 'all' && category === 'all';
    const picked = grouped ? Browse.recommendedApps(apps) : [];
    const pickedSlugs = new Set(picked.map((a) => a.slug));
    const rest = picked.length ? apps.filter((a) => !pickedSlugs.has(a.slug)) : apps;
    const rows = rest.map((a) => Browse.rowView(a));
    rows.unshift(...picked.map((a) => ({ ...Browse.rowView(a), recommended: true })));
    // The "Open site" row, when the query is a web address (#5364). It rides
    // the list descriptor; browse-list.tsx draws it above the app rows.
    const site = Browse.siteFor(query);

    Browse._store.set({
      site,
      rows,
      // Republished on every list render so the <select> and the
      // #browse-list[data-sort] anchor can never lag the rows they describe.
      sort: Browse._sort,
      // …and the chips and #browse-list[data-filter], for the same reason.
      filter: Browse._filter,
      // The type row (#3962): the chips it holds (none hides it) and the
      // pressed one, published together with the rows they picked.
      categories,
      category,
      // #1912: EVERY sort tucks the demos and apps needing fixes behind
      // Show more — the disclosure used to exist on Recommended only, so
      // switching to a metric sort suddenly showed everything. Only
      // Recommended GROUPS the rest under tier headings; a metric sort keeps
      // one list in its own order (headings would break the order it
      // promises). A search still shows every match, expanded.
      // Returning from a detail page keeps the user's disclosure choice.
      curated: !query,
      grouped,
      moreExpanded: Browse._moreExpanded,
      adminFilters: Browse.isAdminViewer(),
      error: false,
      // The site row IS a result, so the "No apps match" line never shows
      // right under it.
      empty: site ? null : (rows.length ? null : Browse.emptyText(query, Browse._filter, category)),
    });

    Browse._maybeShotDetail(rows);
  },

  // ── Row intents ───────────────────────────────────────────────────
  //
  // ./browse-list.tsx binds the listeners now (the rows are its children),
  // so what used to be _wireRows is these three intents. The GUARDS stay
  // here, unchanged and still unit-tested: a demo row is inert, and the Add
  // button never drills in.

  // #1036: the row can't BE an anchor (it wraps its own "Add" button), so
  // cmd/middle-click is intercepted instead — NavLink.wireModified takes this
  // as its hrefFor, and it repeats the same guards openRow applies so an inert
  // row stays inert under a modifier too.
  //
  // THE ROW OPENS THE PROJECT'S HUB (the communities prototype). What a
  // person browsing wants first is what it is, who it is for and Join, which
  // is the hub's hero, with its channel and what it is working on under it —
  // not a store page one level short of that. The address is the one
  // App._hubHref builds (`#app/<slug>/workshop`, which opens on the hub),
  // spelled here so the controller stays testable without App. The About
  // page (#apps/<slug>) stays: Home's card menu opens it, links to it still
  // work, and ?shot=browse-detail still drills into it for the captures.
  rowHref(view) {
    if (!view || view.demo || !view.slug) return null;
    return `#app/${encodeURIComponent(view.slug)}/workshop`;
  },

  openRow(view) {
    const href = Browse.rowHref(view);
    if (!href) return;
    // The hub, not the tab that project page was last left on.
    if (typeof AppView !== 'undefined' && AppView._landOnHub) AppView._landOnHub(view.slug);
    location.hash = href;
  },

  // #931: a warm-up for opening the app from its page one screen later — by
  // then the token is minted and the connection to the app's origin is
  // open. The hub is a screen short of the app, as the About page was.
  warmRow(view) {
    if (!view || view.demo || !view.slug) return;
    try { App.prewarmApp(view.slug); } catch (err) { /* ignore */ }
  },

  // The row's Join (#5267: a joined row says Open instead, so this only
  // ever joins now; leaving is on the project's own page).
  toggleRowAdded(view) {
    if (!view || !view.slug) return;
    if (!view.added) Browse._keptJoins.add(view.slug);
    Home.setMembership(view.slug, !view.added, () => Browse.render());
  },

  // The row's Open: the app itself, as the detail page's Open does.
  openRowApp(view) {
    if (!view || !view.slug || !view.canOpen) return;
    App.navigateToApp(view.slug);
  },

  // Screenshot-state deep link (?shot=browse-detail): the detail page is
  // interaction-gated, and the before/after captures can never click. This
  // drills into the FIRST real row so the link keeps working as the seeded
  // data changes. Pure UI state — no writes, no env gate — so it works in
  // production the moment it ships. Fires once per page load.
  //
  // Drills in directly AND aligns the URL with replaceState (rather than
  // assigning location.hash): this runs during boot, inside the very
  // restoreFromHash that mounted the screen, so a hashchange round-trip
  // races the rest of boot and loses — the level was reverted to the list
  // by a later re-derivation. Setting _slug is immediate, and the matching
  // #apps/<slug> in the URL means any later re-derivation resolves to the
  // same level instead of undoing it.
  _shotDetailDone: false,

  _maybeShotDetail(rows) {
    if (Browse._shotDetailDone || Browse._slug) return;
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'browse-detail') return;
    // Reads the descriptor array rather than querying the painted DOM: the
    // rows are React's children now and this runs in the same tick that
    // publishes them, before they have been reconciled.
    const row = (rows || []).find((r) => r && !r.demo && r.slug);
    if (!row) return;
    Browse._shotDetailDone = true;
    const slug = row.slug;
    try {
      history.replaceState(null, '', `${location.search}#apps/${encodeURIComponent(slug)}`);
    } catch (err) { /* non-fatal: the level change below still happens */ }
    Browse.showDetail(slug);
  },

  // ── Detail page ───────────────────────────────────────────────────

  // The action rows, derived from the home card's menu rather than
  // re-implemented: every permission gate lives in Home.menuItemsFor, so
  // this only decides what does NOT belong on a page that already has
  // dedicated Open and Add/Remove buttons above it.
  //   favorite           — the Add/Remove button IS this action
  //   add-to-homescreen  — "Your apps" only; it belongs on the home grid
  //   app-details        — THIS page; a row linking here would be a no-op
  //                        that looks broken (the hash never changes)
  // Pure — unit-tested in tests/browse-screen.test.js.
  DETAIL_EXCLUDED_KEYS: ['favorite', 'add-to-homescreen', 'app-details'],

  detailActionsFor(app) {
    if (!app) return [];
    let items = [];
    try { items = Home.menuItemsFor(app) || []; } catch (err) { items = []; }
    return items.filter((i) => i && !Browse.DETAIL_EXCLUDED_KEYS.includes(i.key));
  },

  // ── Share (the prototype's About sheet: More, then Share) ─────────
  //
  // The link handed out is the app's PUBLIC one: `app.url`, the address the
  // app itself is served on (GET /api/apps sets it for a running app). That
  // is exactly what the platform's existing Share already gives away — the
  // mark menu's About, "Share app" (Improve.share, then AppView.openShareModal,
  // then features/dialogs/share.tsx), which reads the RUNNING app's
  // `appData.url` through window.resolveDevHost and draws the row only on
  // `canShare`: running, with a URL, and never the platform itself (its row
  // has no per-slug app URL). The directory has no running app to read, so it
  // takes the same field off the row it is showing, through the same rewrite
  // and behind the same gate. Null means "no Share row".
  // Pure — unit-tested.
  shareUrlFor(app) {
    if (!app || app.self_hosted) return null;
    if (app.status !== 'running' || !app.url) return null;
    // A public project's link is its page on Homeroom, which a stranger
    // opens as the project's page and a link preview names (dialogs/
    // share.tsx publicPageUrl, routes/project-preview.js).
    if (app.view_visibility === 'public' && app.slug && typeof location !== 'undefined') {
      return `${location.origin}/app/${encodeURIComponent(app.slug)}`;
    }
    const raw = String(app.url);
    try {
      return typeof window !== 'undefined' && typeof window.resolveDevHost === 'function'
        ? window.resolveDevHost(raw)
        : raw;
    } catch (err) {
      return raw;
    }
  },

  // The detail page's Share row. The Web Share API where the device has one
  // (a phone's own share sheet: Messages, Mail, AirDrop, a chat app); where it
  // has none, which is most desktop browsers, the link goes to the clipboard
  // and a toast says so, through PlatformUI.copyText (the shell's one
  // clipboard helper, with the fallback the share dialog's own copy button
  // documents).
  async shareDetailApp(app) {
    const url = Browse.shareUrlFor(app);
    if (!url) return;
    const data = { title: (app && (app.name || app.slug)) || '', url };
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (nav && typeof nav.share === 'function'
      && (typeof nav.canShare !== 'function' || nav.canShare(data))) {
      try {
        await nav.share(data);
        return;
      } catch (err) {
        // Dismissing the sheet is an answer, not a failure: nothing to copy.
        if (err && err.name === 'AbortError') return;
        // Anything else (a refused permission, a webview with no share
        // target) falls through to the clipboard, which always has one.
      }
    }
    let ok = false;
    try {
      ok = !!(await PlatformUI.copyText(url));
    } catch (err) {
      ok = false;
    }
    PlatformUI.toast(ok ? PlatformI18n.t('discover:detail.share.copied') : PlatformI18n.t('discover:detail.share.copyFailed'));
  },

  // ── Contributors (#919) ───────────────────────────────────────────
  //
  // Who has actually shipped changes to this app, ranked by merged
  // proposals. The set (creator ∪ accepted members ∪ merged-proposal
  // authors), the counts and the ordering are ALL decided server-side by
  // src/services/contributors.js — shared with the public contributors
  // API — so this file only paints what it is handed, in the order it
  // arrives.

  // How many rows show before the "Show all" fold.
  CONTRIB_FOLD: 5,

  // The card, as a pure function of the cached entry + expanded flag.
  // Pure so tests/browse-screen.test.js can pin every state without a
  // DOM or a fetch, exactly like sortApps / metaLine / rowView.
  //
  // Returns a DESCRIPTOR now (#1191 slice 6, conversion 3);
  // ./browse-detail.tsx renders it. Every decision this function ever made —
  // which of the four body states shows, where the count chip appears, how
  // the fold is computed, what the toggle is labelled — is still made here.
  contributorsView(entry, opts) {
    const expanded = !!(opts && opts.expanded);
    const state = (entry && entry.state) || 'loading';
    const items = (entry && Array.isArray(entry.items)) ? entry.items : [];
    // `total` is the server's full set size, which can exceed items.length
    // when the query was capped — so the count and the toggle label stay
    // honest about what exists rather than what arrived.
    const total = (entry && Number.isFinite(entry.total)) ? entry.total : items.length;

    // The heading paints in every state (including loading) so the page
    // doesn't jump when the fetch lands.
    const view = {
      state,
      // null hides the chip entirely, rather than rendering an empty span.
      count: (state === 'ready' && total > 0) ? total : null,
      rows: [],
      toggle: null,
      // Whether the fold is open, so the toggle can say so to assistive tech
      // (aria-expanded) and not only through its label (#2991).
      expanded,
      note: null,
    };

    if (state === 'loading') {
      view.note = PlatformI18n.t('discover:detail.contributors.loading');
    } else if (state === 'error') {
      view.note = PlatformI18n.t('discover:detail.contributors.loadFailed');
    } else if (!items.length) {
      view.note = PlatformI18n.t('discover:detail.contributors.none');
    } else {
      const shown = expanded ? items : items.slice(0, Browse.CONTRIB_FOLD);
      view.rows = shown.map((c, i) => Browse.contributorRowView(c, i + 1));
      // The fold is decided by what ARRIVED (items.length), not by total —
      // a capped list has nothing more to reveal locally. The label still
      // quotes `total` so the number matches the heading.
      if (items.length > Browse.CONTRIB_FOLD) {
        view.toggle = expanded
          ? PlatformI18n.t('discover:detail.contributors.showFewer')
          : PlatformI18n.t('discover:detail.contributors.showAll', { count: total });
      }
    }

    return view;
  },

  // One contributor row. Deliberately mirrors the Top-users leaderboard's
  // row (features/leaderboard/leaderboard.js, _renderUserRows) — rank,
  // initial-avatar circle, @username, a muted meta line, a count pill on the
  // right — so the platform's two ranked people-lists read as one system. A
  // <button> so it is keyboard-focusable like those rows are. Pure.
  contributorRowView(c, rank) {
    // `who` is also the row's key (data-username, openContributor), so the
    // missing-name value stays this literal; `unnamed` tells the tooltip to
    // use its own wording instead of taking it as a username.
    const who = (c && c.username) || 'unknown';
    const unnamed = !(c && c.username);
    const merged = parseInt(c && c.merged_count, 10) || 0;
    const votes = parseInt(c && c.votes_count, 10) || 0;
    // Role first (it says what they ARE on this app), then the vote count.
    // Creator wins over member — the creator is always backfilled as one,
    // so showing both would be noise on every single first row.
    const bits = [];
    if (c && c.is_creator) bits.push(PlatformI18n.t('discover:detail.contributor.creator'));
    else if (c && c.is_member) bits.push(PlatformI18n.t('discover:detail.contributor.member'));
    if (votes > 0) bits.push(PlatformI18n.t('discover:detail.contributor.votes', { count: votes }));
    return {
      who,
      unnamed,
      rank,
      initial: (who[0] || '?').toUpperCase(),
      merged,
      // null rather than '' so the renderer drops the line instead of
      // drawing an empty one, exactly as the string version did.
      meta: bits.length ? joinFacts(bits) : null,
      // A zero stays visible in muted grey rather than vanishing, so every
      // row keeps the same shape and the column doesn't ragged out.
      pillTint: merged > 0
        ? 'bg-violet-50 dark:bg-violet-900/30 border-violet-200 dark:border-violet-700 text-violet-700 dark:text-violet-300'
        : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400',
    };
  },

  // A contributor row opens that person's existing profile page (every
  // proposal they've proposed) — the leaderboard's own drill-in route, so this
  // screen owns no profile rendering of its own. An unresolvable username
  // lands on that pane's "User not found" state.
  openContributor(who) {
    if (who) location.hash = `#leaderboard/users/${encodeURIComponent(who)}`;
  },

  // The fold toggle is purely local — the full list is already in hand, so
  // this repaints and never refetches.
  toggleContributors() {
    Browse._contribExpanded = !Browse._contribExpanded;
    Browse.render();
  },

  // Read one app's ranked contributors. Mirrors _fetchDetail: single-flight
  // on the slug, and only repaints if that page is still the one showing.
  // Carries the same ?demo=1 passthrough _load() uses so the staging demo
  // rows reach the detail page too.
  async _fetchContributors(slug) {
    if (!slug || Browse._contribFetching === slug) return;
    Browse._contribFetching = slug;
    Browse._contrib.set(slug, { state: 'loading', items: [], total: 0 });
    try {
      const demoQS = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/contributors${demoQS}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      Browse._contrib.set(slug, {
        state: 'ready',
        items: Array.isArray(data && data.contributors) ? data.contributors : [],
        total: Number.isFinite(data && data.total)
          ? data.total
          : ((data && data.contributors) || []).length,
      });
    } catch (err) {
      Browse._contrib.set(slug, { state: 'error', items: [], total: 0 });
    } finally {
      Browse._contribFetching = null;
      if (Browse._slug === slug) Browse.render();
    }
  },

  _renderDetail() {
    if (!Browse._store) return;
    const slug = Browse._slug;
    const app = Browse.appBySlug(slug);

    if (!app) {
      if (Browse._detailMissing) {
        Browse._store.set({ detail: { state: Browse._detailBlocked ? 'blocked' : 'missing' } });
        return;
      }
      Browse._store.set({ detail: { state: 'loading' } });
      Browse._fetchDetail(slug);
      return;
    }

    const isAdded = Home.isYours(app);
    const canOpen = app.status === 'running' || app.status === 'awaiting_secrets';
    // Same build-info block the "…" menu header assembles, so the version
    // chip looks identical everywhere and shows a live deploying state.
    const pillHtml = (typeof AppView !== 'undefined' && AppView.renderAppVersionPillHTML)
      ? AppView.renderAppVersionPillHTML({
          slug: app.slug,
          version: app.version || null,
          deployProgress: app.deployProgress || null,
          includePrContext: false,
        })
      : '';
    // Fork lineage — "⑂ Remixed from <name>", under the version chip.
    //
    // This was the hamburger drawer's last footer row, painted by
    // AppView.renderForkBadge() into a slot by id and revealed through
    // App.DrawerStatus.setForkVisible(). Both are gone: the Streamlined
    // Concept board draws no reference footer, and lineage is a fact about
    // an app rather than about the drawer you happen to have open, so it
    // belongs on the app's own page next to the version it qualifies.
    //
    // Derived here rather than fetched: GET /api/apps and GET /api/apps/:slug
    // both resolve the stored reference to { appId, slug, name, linkable }
    // (attachForkLineage in src/routes/apps.js), so whichever of the two
    // filled Browse._apps, this reads. A source that has been deleted comes
    // back as `linkable: false` with the literal name "<deleted>", and
    // renders as inert text — the same two states the badge had.
    const forkRef = app.forked_from;
    const forkedFrom = (forkRef && typeof forkRef === 'object')
      ? {
          name: forkRef.name || '<deleted>',
          // The original is gone: the line has its own wording, and `name` is a placeholder.
          deleted: !forkRef.name,
          href: (forkRef.linkable && forkRef.slug)
            ? `#app/${encodeURIComponent(forkRef.slug)}`
            : null,
        }
      : null;
    const updatedRel = formatRelativeTime(app.last_deploy_at || app.created_at);
    const actions = Browse.detailActionsFor(app);
    // Contributors ride the same paint: first visit to this page renders the
    // loading card and kicks the read off (which repaints when it lands);
    // every later render() — a syncFrom repaint, a favourite toggle, the
    // show-all toggle — reads the cache and never refetches.
    let contribEntry = Browse._contrib.get(slug);
    if (!contribEntry) {
      contribEntry = { state: 'loading', items: [], total: 0 };
      Browse._fetchContributors(slug);
    }
    // The action list is kept on the instance as well as on the descriptor:
    // each item carries a `run` closure that the store has no business
    // serialising, and _runDetailAction hands the clicked BUTTON to it so a
    // keepOpen item (Check for updates) can flip its label in place exactly
    // as it does inside the popover.
    Browse._detailActions = actions;

    Browse._store.set({
      detail: {
        state: 'ready',
        app,
        name: app.name || app.slug,
        slug: app.slug,
        // AppView.renderAppVersionPillHTML is a pure string builder in the
        // (still legacy) app view — it reads nothing and mutates nothing — so
        // the hero renders its output as markup rather than re-deriving a
        // chip that would then have two owners. '' draws no wrapper at all.
        versionPillHtml: pillHtml,
        forkedFrom,
        updatedRel,
        canOpen,
        openLabel: canOpen
          ? PlatformI18n.t('discover:detail.open.action')
          : (app.status === 'creating' ? PlatformI18n.t('discover:detail.open.creating')
            : app.status === 'error' ? PlatformI18n.t('discover:detail.open.notRunning')
            : (app.status || PlatformI18n.t('discover:detail.open.unavailable'))),
        isAdded,
        favLabel: isAdded ? PlatformI18n.t('discover:detail.myApps.remove') : PlatformI18n.t('discover:detail.myApps.add'),
        // The Share row (shareDetailApp). A flag, not the URL: the click
        // resolves the link from the app record it is handed, the same one
        // Open and Add act on, rather than from a string frozen at paint.
        canShare: !!Browse.shareUrlFor(app),
        actions: actions.map((a, i) => ({
          index: i,
          label: a.label,
          title: a.title || null,
          // The line under the label, for an item that has one (Remix's
          // "Make your own copy"); absent for every other row.
          ...(a.sub ? { sub: a.sub } : {}),
          danger: !!a.danger,
          disabled: !!a.disabled,
        })),
        contributors: Browse.contributorsView(contribEntry, {
          expanded: Browse._contribExpanded,
        }),
      },
    });
  },

  // ── Detail intents ────────────────────────────────────────────────

  openDetailApp(slug) {
    App.navigateToApp(slug);
  },

  // #931: warm the mint + origin connection on press/hover, so the tap can
  // point the app frame at the app in its own tick.
  warmDetailApp(slug) {
    try { App.prewarmApp(slug); } catch (err) { /* ignore */ }
  },

  toggleDetailAdded(app) {
    if (!app) return;
    Home.toggleAdded(app.slug, !Home.isYours(app), () => Browse.render());
  },

  _runDetailAction(index, btnEl) {
    const item = (Browse._detailActions || [])[index];
    if (item && typeof item.run === 'function') item.run(btnEl);
  },

  // Cold deep link (#apps/<slug> on a fresh load, or a link from
  // elsewhere): the list payload hasn't arrived or doesn't carry this
  // slug, so read the one app directly and merge it into the cache.
  async _fetchDetail(slug) {
    if (Browse._detailFetching === slug) return;
    Browse._detailFetching = slug;
    try {
      // `manifest=summary`: the row joins the list's rows, which carry the
      // same summary, and shares the service worker's copy with AppView.
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}?manifest=summary`);
      if (!res.ok) {
        const failure = await res.json().catch(() => ({}));
        Browse._detailBlocked = failure.code === 'app_blocked';
        throw new Error(`HTTP ${res.status}`);
      }
      Browse._detailBlocked = false;
      // The route answers `{ app: … }` (src/routes/apps.js), NOT a bare app
      // row — reading it as one made every cold deep link resolve to the
      // "isn't available" state. It only ever surfaced when the concurrent
      // /api/apps list didn't carry the slug (which is why it went unnoticed:
      // that list normally wins the race and paints the page first).
      const payload = await res.json();
      const app = (payload && payload.app) || null;
      if (app && app.slug) {
        Browse._apps = [...(Browse._apps || []).filter((a) => a.slug !== app.slug), app];
      }
      Browse._detailMissing = !app || !app.slug;
    } catch (err) {
      Browse._detailMissing = true;
    } finally {
      Browse._detailFetching = null;
      if (Browse._slug === slug) {
        Browse.render();
        Browse._syncLevel();
      }
    }
  },

  // ── Search (level 1) ──────────────────────────────────────────────
  //
  // The listeners moved to ./browse-screen.tsx (the field and its clear
  // button are its children now), but the DEBOUNCE and what a query means
  // stayed here. The component reports keystrokes; setQuery coalesces them on
  // the same 100ms timer the input listener used to, so a fast typist still
  // gets one re-filter per pause rather than one per character. The clear
  // button's own visibility is a store field for the same reason the level is
  // — it used to be a classList.toggle into a node React renders.
  //
  // The field itself stays UNCONTROLLED: nothing re-renders it, so the caret
  // cannot jump mid-word, which is the same "no focus loss" property the
  // wire-once discipline bought before.
  SEARCH_DEBOUNCE_MS: 100,

  setQuery(value, opts) {
    const immediate = !!(opts && opts.immediate);
    clearTimeout(Browse._searchDebounce);
    const apply = () => {
      Browse._query = value;
      if (Browse._store) Browse._store.set({ showClear: !!value });
      Browse.render();
    };
    if (immediate) apply();
    else Browse._searchDebounce = setTimeout(apply, Browse.SEARCH_DEBOUNCE_MS);
  },
};

// formatRelativeTime used to be AMBIENT here: as classic scripts, home.js's
// top-level function declarations were window properties and this file just
// called them. Inside the bundle a module's identifiers are its own, so it is
// module-local — same body, copied rather than imported for the reason
// app-card.js gives for its own copy. (home.js is still a classic script
// until step 4, so its copy stays too; three lines of formatter is not worth
// a cross-module dependency that would then have to survive that move.)
//
// escapeHtml and browseEscapeAttr went with the markup (#1191 slice 6): this
// file emits descriptors, and React escapes its own text.

// Compact "Nx ago" formatter for the row and detail meta lines. Returns null
// for unparseable input so callers can drop the segment rather than render
// "NaN ago".
function formatRelativeTime(input) {
  if (!input) return null;
  const t = new Date(input);
  if (Number.isNaN(t.getTime())) return null;
  const seconds = Math.floor((Date.now() - t.getTime()) / 1000);
  if (seconds < 60) return PlatformI18n.t('discover:time.justNow');
  if (seconds < 3600) return PlatformI18n.t('discover:time.minutesAgo', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return PlatformI18n.t('discover:time.hoursAgo', { count: Math.floor(seconds / 3600) });
  if (seconds < 86400 * 30) return PlatformI18n.t('discover:time.daysAgo', { count: Math.floor(seconds / 86400) });
  if (seconds < 86400 * 365) return PlatformI18n.t('discover:time.monthsAgo', { count: Math.floor(seconds / (86400 * 30)) });
  return PlatformI18n.t('discover:time.yearsAgo', { count: Math.floor(seconds / (86400 * 365)) });
}

// Short facts on one line of a row ("12 users · Updated 3d ago"). Each fact is
// a whole message of its own, and what joins two of them is a message too, so
// a language can use its own separator.
function joinFacts(facts) {
  return facts.reduce((first, second) => PlatformI18n.t('discover:row.meta.pair', { first, second }));
}

// Still published as a global: App.navigateToBrowse, app.js's hash router and
// nav-link.js all reach this through `window.Browse`, and they are classic
// scripts. Guarded because the SSG prerender pass evaluates this module in
// Node (the island imports it).
if (typeof window !== 'undefined') window.Browse = Browse;

// The descriptors above hold text, so a language change rebuilds them from
// the same state: the rows or the detail page, and the header's title.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('homeroom:language-changed', () => {
    if (!Browse._open) return;
    Browse.render();
    Browse._syncChrome();
  });
}
