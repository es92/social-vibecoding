// Home-screen sections (issue #911) — the three blocks stacked under the
// launcher grid. THE UI OVERHAUL fixed their order and their hosts:
//
//   discover   — the admin-curated featured tiles, the Popular lane, and
//                "Browse all apps". The shell's ONLY door to the app
//                directory, which is why it cannot be hidden.
//   challenges — the season's open challenges with the viewer's progress,
//                and under them the LEADERBOARD standings preview. That
//                preview is where the standings live on the home screen now
//                that the hamburger's Leaderboard row is gone.
//   create     — the create-an-app block. On EVERY home screen, for every
//                account: an account with no app quota gets the same block,
//                dimmed, explaining itself on tap (see renderCreatePanel for
//                why this is unconditional rather than conditionally shown).
//
// PLACEMENT IS GONE, and with it a whole dimension of this module. Each
// block used to be a draggable ITEM of the launcher grid — home.js planted a
// `[data-panel-slot="<key>"]` host inside #app-list at the viewer's stored
// (column, row) cell, HomeLayout carried a per-breakpoint footprint table for
// each one, and PUT /api/home-layout persisted where they had been dropped.
// They are three fixed <section> hosts in a fixed order now, outside
// #app-list, and the drag gesture belongs to app tiles alone. The hosts still
// carry `data-panel-slot="<key>"` — the attribute names WHICH block a host is
// for, which is as true of a section as it was of a grid cell, and it is what
// the dapp.json checks and the screenshot assertions select on.
//
// What that removed, in this file: `gridSlotKeys()`/`hasLayoutRegistry()`
// (the placement membership list), the `#home-panels` stacked fallback host
// (it existed only because a block inside #app-list vanished whenever
// #app-list did — a search keystroke, or the moment before the first paint),
// and the whole `inGrid` / `cols` split described below.
//
// NAMING — "panel", not "widget". home.js already owns a DIFFERENT concept
// called "widget" (Home.widgetSectionView / #widget-strip / .widget-tile:
// the iOS home-screen widget's pinned app grid, whose UI says "Homeroom
// widget"). Both render on this same screen, so everything here says
// `panel`. Nothing user-facing says either: the blocks are titled by their
// own headings.
//
// LAYOUT — each panel is its OWN bordered <article class="home-panel">, so a
// block reads as a distinct box rather than another row inside a shared card.
// Each section has its own heading and navigation. Blocks are plain
// full-width children — .home-column bounds the feed.
//
// DENSITY — a section sizes to its own CONTENT. That is the shape the full
// render branch was always written for, and it is now the only one: the
// capped variants (`inGrid: true`, the phone one-cell branch with its
// two-row budget and its footer-less title bar) were concessions to a fixed
// rectangle of the launcher canvas and went with the placement. What
// survives is the four-row budget itself — a ~26px title bar, up to FOUR
// 40px single-line rows, a ~27px footer — because it is a good density for
// a home-screen block. Overflow is still handled by
// rendering fewer rows plus the footer's expand toggle — never an inner
// scroller (a nested scroll region inside the page scroller is a touch trap)
// and never a horizontal pager (invisible to the screenshot capture and to
// dapp.json checks, which can only navigate).
//
// THE LEADERBOARD FILL IS GONE. A standings preview used to sit under the
// challenge rows — first as something to spend the fixed 2x2 rectangle on,
// then, once the hamburger's Leaderboard row was retired, as the home
// screen's only view of the standings. Two labelled lists with two different
// tap destinations inside one card called Challenges made the reader work out
// which one they were looking at before they could read either. The standings
// are a screen, and this section's heading carries the one tap to it in every
// branch. `fillView`, `fillRowView`, `formatFillScore`, FILL_SLOTS and the
// server's `panel.leaderboard` (with its two board queries) went together.
//
// FETCH DISCIPLINE. Home.load() is called from a dozen WS/event paths, so
// this module must NOT fetch per Home.load(): ensureLoaded() is TTL-guarded
// and de-duped on an in-flight promise, while render() is pure paint from
// the cache. The three section hosts are static markup the home island
// renders once (frontend/src/features/home/index.tsx) and they live OUTSIDE
// #app-list, so Home.render()'s wholesale innerHTML rewrite of the grid
// never destroys them — and React never reconciles over what this module
// paints into them, because the island renders each host empty and leaves it
// alone for good.
'use strict';

import { panelsStore } from './panels-store';

const HomePanels = {
  // Cache of GET /api/home-panels: { registry, panels }.
  _data: null,
  _fetchedAt: 0,
  _inflight: null,
  TTL_MS: 60 * 1000,

  // Which panels the viewer has expanded in place, this visit only. The
  // expand toggle grows the block past its height cap and asks the server
  // for the full list (finished challenges included); nothing is
  // persisted, so a reload comes back collapsed. Deliberate: the cap is
  // the default contract, and an expansion the user forgot about would
  // quietly eat the fold forever.
  _expanded: Object.create(null),

  // ── The row budget ─────────────────────────────────────────────────
  //
  // How many challenge rows the block draws before the footer takes over
  // with "See all N". The server returns at most this many challenges
  // (CHALLENGE_ROW_LIMIT, kept in step with it).
  //
  // It used to be a per-breakpoint pair — four here, and a PHONE_ROW_SLOTS of
  // two for the single grid cell the block owned below 640px (#968). A fixed
  // section has no cell to fit into, so there is one budget at every width,
  // and the phone half went with the placement. Four survives as a PREVIEW
  // cap; the footer's "See all N challenges" is the way past it.
  ROW_SLOTS: 4,

  // `esc()` and `safeHref()` lived here. Both existed for the string
  // renderers: organiser prose (challenge goals, metric labels) landed in BOTH
  // text nodes and double-quoted attribute values, so & < > alone was not
  // enough — an unescaped `"` would let a goal break out of `title="…"` and
  // inject attributes. React escapes both contexts by construction and there
  // is no interpolated href left in this module, so neither has a caller.
  // tests/home-panels-render.test.js keeps the CONTRACT, asserted against the
  // rendered output rather than against a helper.

  // Rewards are organiser prose — rendered verbatim ("Up to 6,500 pts",
  // "½ of your final credits"). The single exception: a bare number gets
  // " pts" appended, because organisers do type just "1500".
  formatReward(reward) {
    const s = String(reward == null ? '' : reward).trim();
    if (!s) return '';
    return /^[\d][\d.,]*$/.test(s) ? `${s} pts` : s;
  },

  // Bar fill, 0-100. A missing/zero/NaN target is 0 (the caller renders no
  // bar in that case anyway); over-target is clamped so a viewer who blew
  // past the goal doesn't get a bar wider than its track.
  progressPercent(current, target) {
    const t = Number(target);
    const c = Number(current);
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(c) || c <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((c / t) * 100)));
  },

  // Client mirror of the server's ORDER BY, so a cached or demo payload
  // renders in exactly the order a fresh query would produce: not-done
  // first (lead with something actionable), then the server's own order.
  // Stable — Array#sort is stable, so equal rows keep the server sequence.
  orderRows(rows) {
    return (rows || []).slice().sort((a, b) => {
      const ad = a?.progress?.done ? 1 : 0;
      const bd = b?.progress?.done ? 1 : 0;
      if (ad !== bd) return ad - bd;
      return 0;
    });
  },

  // How many rows to draw. Collapsed spends the budget on at most `slots`
  // rows (ROW_SLOTS unless a caller says otherwise); the overflow affordance
  // is the footer's expand toggle, so it costs no row slot of its own (it
  // used to take the fourth).
  // Expanded draws everything the server sent and the CSS cap lifts.
  //
  // `collapsed` forced the un-expanded rendering for the phone branch, whose
  // one-cell footprint could not grow (#968). Nothing forces it now — the
  // section grows with its content — but it stays honoured so the option is
  // still the way to render a preview of a block somebody has expanded.
  //
  // `link` stays in the return shape as a compatibility flag for anything
  // still reading it, but it is always false: the footer owns overflow.
  visibleSlots(panel, opts) {
    const rows = HomePanels.orderRows(panel && panel.challenges);
    const total = Number(panel && panel.total) || 0;
    const key = panel && panel.key;
    const slots = Number(opts && opts.slots) > 0
      ? Number(opts.slots) : HomePanels.ROW_SLOTS;
    const collapsed = !!(opts && opts.collapsed);
    if (!collapsed && key && HomePanels._expanded[key]) {
      return { rows, link: false, total, expanded: true };
    }
    return {
      rows: rows.slice(0, slots),
      link: false, total, expanded: false,
    };
  },

  // "1 of 6 · 3,900 pts left" — folded into the title bar rather than
  // spending a row of its own. The points clause only appears when the
  // server could total the open rewards honestly (organiser prose can't
  // be summed; see parseRewardPoints server-side).
  summaryLine(panel) {
    if (!panel) return '';
    const total = Number(panel.total) || 0;
    const done = Number(panel.done) || 0;
    let line = `${done} of ${total}`;
    const remaining = panel.points_remaining;
    if (typeof remaining === 'number' && Number.isFinite(remaining) && remaining > 0) {
      line += ` · ${remaining.toLocaleString('en-US')} pts left`;
    }
    return line;
  },

  // ── Data ───────────────────────────────────────────────────────────

  // Called from Home.load(). At most one fetch per TTL, and concurrent
  // callers share the in-flight promise.
  ensureLoaded(opts) {
    const force = !!(opts && opts.force);
    if (!window.App || !App.user) return Promise.resolve();
    if (HomePanels._inflight) return HomePanels._inflight;
    if (!force && HomePanels._data
        && Date.now() - HomePanels._fetchedAt < HomePanels.TTL_MS) {
      return Promise.resolve();
    }
    // ?demo=1 rides along exactly like Home.load()'s own demoQS — the
    // server only honours it in staging. `expand` names the one panel the
    // viewer has opened in place, so the fetch brings its full list.
    //
    // `challenges=few|none` rides along WITH it: the demo variant is chosen
    // server-side, so a param left in the address bar but not on the fetch
    // would silently serve the default payload — which is what the deep link,
    // the dapp.json check and the before/after screenshots would then all
    // capture. (`board=kudos` went with the standings preview it selected.)
    const params = new URLSearchParams();
    try {
      const here = new URLSearchParams(location.search);
      if (here.get('demo') === '1') {
        params.set('demo', '1');
        const variant = here.get('challenges');
        if (variant) params.set('challenges', variant);
      }
    } catch (err) { /* ignore */ }
    const expandKey = Object.keys(HomePanels._expanded)
      .find((k) => HomePanels._expanded[k]);
    if (expandKey) params.set('expand', expandKey);
    const qs = params.toString() ? `?${params.toString()}` : '';

    HomePanels._inflight = fetch(`/api/home-panels${qs}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json && Array.isArray(json.panels)) {
          HomePanels._data = json;
          HomePanels._fetchedAt = Date.now();
        }
      })
      // Silent on failure: a home screen must never break (or shout in the
      // console) because the challenge read hiccuped. The block just stays
      // absent until the next mount.
      .catch(() => {})
      .then(() => {
        HomePanels._inflight = null;
        HomePanels.render();
      });
    return HomePanels._inflight;
  },

  panelFor(key) {
    const panels = HomePanels._data && HomePanels._data.panels;
    if (!Array.isArray(panels)) return null;
    return panels.find((p) => p && p.key === key) || null;
  },

  // ── Rendering ──────────────────────────────────────────────────────

  // Painted from the cache only — never fetches. Deliberately NOT gated on
  // Home._dragActive: these sections are outside #app-list, so painting them
  // mid-drag can't yank a card out from under the pointer.
  //
  // ── One host per section, in a fixed order ─────────────────────────
  //
  // This used to paint into TWO shapes: `[data-panel-slot="<key>"]` hosts
  // that Home.render() planted inside #app-list at each widget's stored
  // (column, row) cell, and a standalone #home-panels stack below the grid as
  // the fallback for views with no grid to ride in (an active search, or a
  // grid that had not painted yet).
  //
  // THE UI OVERHAUL retired the placement, so both shapes collapse into one:
  // three fixed section hosts, rendered in a fixed order, that no search
  // keystroke or grid re-render can take away. The fallback existed only
  // because a widget inside #app-list vanished whenever #app-list did.
  // The three section hosts, keyed the way panelFor() keys them. The ids are
  // ./panels/sections.tsx's now — each section component renders its own host
  // — but the mapping stays here because it is what makes "which blocks are
  // there" one list rather than three call sites.
  SECTION_HOSTS: {
    discover: 'home-discover-section',
    challenges: 'home-challenges-section',
    create: 'home-create-section',
  },

  // One paint: compute the three view models and push them.
  //
  // Was three `innerHTML` assignments, three `classList.toggle('hidden')`, a
  // `_stampState` pass that mirrored each block's own state attributes up onto
  // its host, and a `_wire` pass that re-attached eight families of listener
  // to nodes the assignment had just created. All four collapse into the push:
  // ./panels/sections.tsx renders the host AND the block from one model, so
  // the mirror is a prop rather than a second pass over somebody else's
  // markup, and every listener is a prop on an element React keeps.
  render() {
    // Signed out draws NOTHING — every block here is me-scoped (your
    // challenge progress, the apps you don't have yet, your app quota), and
    // the guard used to live in renderAll(), the one entry point there was.
    const signedIn = !!(window.App && App.user);
    const viewFor = (key, build) => {
      if (!signedIn) return null;
      const panel = HomePanels.panelFor(key);
      return panel ? build(panel) : null;
    };
    panelsStore.set({
      painted: true,
      discover: viewFor('discover', HomePanels.discoverView),
      challenges: viewFor('challenges', HomePanels.challengesView),
      create: viewFor('create', HomePanels.createView),
    });
  },

  // `_stampState` and `STATE_ATTRS` lived here. They mirrored a block's own
  // state attributes (`data-create-enabled`, Discover's two lane counts) from
  // the markup up onto its HOST, because a selector written the way the spec,
  // the dapp.json checks and the screenshot assertions write it —
  // `[data-panel-slot="create"][data-create-enabled="true"]` — asks for both
  // on ONE element, and the block that knows the value is a child of the host
  // that carries the slot name.
  //
  // ./panels/sections.tsx renders both from the same view model, so the value
  // reaches both elements as a prop and there is nothing to mirror. The
  // attribute contract is unchanged; only the second pass is gone.

  // `hasLayoutRegistry()` and `gridSlotKeys()` lived here: the list of widgets
  // HomeLayout should place for this viewer, and the flag that told home.js
  // the authoritative footprints had arrived so a derived layout was safe to
  // persist. Both went with the placement — the three sections are in the
  // markup at fixed positions now, so nothing has to be placed and nothing
  // has to wait for a registry to know where it goes.

  titleFor(key) {
    const data = HomePanels._data;
    const entry = data && Array.isArray(data.registry)
      ? data.registry.find((r) => r.key === key) : null;
    if (entry && entry.title) return entry.title;
    // A built payload carries its own title; fall back to it so a partial
    // response (panels but no registry) still names the widget in its menu
    // rather than heading the action sheet "Widget".
    const built = data && Array.isArray(data.panels)
      ? data.panels.find((p) => p && p.key === key) : null;
    return (built && built.title) || 'Widget';
  },

  // The widget CONTENT for one key, whether or not the server built a
  // payload for it. `challenges` has a real builder; `discover` and `create`
  // are markers, so panelFor() may hand back a bare `{ key }` — enough for
  // renderPanel() to dispatch on.
  panelFor(key) {
    if (!key) return null;
    const data = HomePanels._data;
    const panels = data && data.panels;
    if (Array.isArray(panels)) {
      const built = panels.find((p) => p && p.key === key);
      if (built) return built;
    }
    // Not in `panels` (a marker widget, or one whose build failed): still
    // renderable if the registry knows it. Ignore stale hidden preferences
    // from older server responses: these sections are permanent (#1801).
    if (!data || !Array.isArray(data.registry)) return null;
    if (!data.registry.some((r) => r.key === key)) return null;
    return { key, title: HomePanels.titleFor(key) };
  },

  // `renderAll()` — one article per visible panel, joined into a stack —
  // lived here for the #home-panels fallback host. Both went together: the
  // three sections have hosts of their own and render() paints each one
  // directly, so nothing needs the blocks as one string any more.

  // `renderPanel` dispatched on the key and `_panelShell` / `_leaderboardLink`
  // / `_panelFooter` / `_fillFooter` drew the bordered block, its title bar and
  // its two footer shapes. All five are ./panels/ui.tsx and ./panels/*.tsx now,
  // and the dispatch is the three `*View` builders below — the store has a
  // field per block, so an unknown key simply never reaches a builder, which is
  // the same "not shown rather than a blank home screen" degradation the
  // dispatch gave.

  // ── The Challenges block's view model ──────────────────────────────
  //
  // THE PHONE SHAPE (#968) IS GONE. It existed because the widget owned ONE
  // grid cell below five columns — two rows, the way out in the title bar, no
  // footer, never expanded — and every one of those was a concession to a
  // 116px rectangle. THE UI OVERHAUL made this a fixed SECTION that sizes to
  // its own content, so the full shape is right at every width. The
  // `opts`/`inGrid`/`cols` triple that chose between them went with it; the
  // four-row budget is now simply THE budget.
  challengesView(panel) {
    const total = Number(panel.total) || 0;
    const expanded = !!HomePanels._expanded[panel.key];
    const empty = !total
      || !Array.isArray(panel.challenges)
      || !panel.challenges.length;
    // A payload that came back empty can't be expanded — and leaving the flag
    // set would keep ?expand=challenges on every later fetch, asking for a
    // finished-challenge list that would repopulate the block.
    if (empty && HomePanels._expanded[panel.key]) HomePanels._expanded[panel.key] = false;
    if (empty) {
      return {
        key: panel.key,
        title: panel.title || 'Challenges',
        summary: null,
        season: null,
        total,
        allTotal: total,
        expandable: false,
        expanded: false,
        rows: [],
      };
    }
    const { rows } = HomePanels.visibleSlots(panel, { slots: HomePanels.ROW_SLOTS });
    // #1824: whether the footer's expand toggle has anything to reveal.
    // `total` counts the OPEN challenges and `all_total` the ones an
    // expansion would draw (the season's finished and out-of-window ones
    // too), so the honest question is "are there more than are on screen?" —
    // and a block already showing every challenge there is draws no toggle,
    // instead of a "See all 3 challenges" beside three challenges. An older
    // cached payload has no `all_total`; `total` alone is the fallback.
    const allTotal = Math.max(
      total,
      Number.isFinite(Number(panel.all_total)) ? Number(panel.all_total) : 0
    );
    const expandable = expanded || rows.length < allTotal;
    const season = HomePanels.seasonView(panel);
    return {
      key: panel.key,
      title: panel.title || 'Challenges',
      // Still computed, and still the one-line form of the same counts
      // the season progress draws — it is the block's accessible summary and what the ⋮
      // menu and the tests read. It is no longer rendered in the section
      // heading; `season` is where it shows.
      summary: HomePanels.summaryLine(panel),
      season,
      onboardingNote: panel.onboarding
        ? (panel.onboarding.unlocked
          ? 'Persistent and weekly challenges are unlocked.'
          : 'Finish these to unlock persistent and weekly challenges.')
        : null,
      total,
      allTotal,
      expandable,
      expanded,
      rows: rows.map((c) => HomePanels.challengeRowView(c, panel)),
    };
  },

  // `renderChallengesPanel` and `_countFillRows` lived here. The first is
  // `challengesView` above; the second counted the standings-preview rows the
  // renderer had actually drawn, and went with the preview itself.

  // ── Discover ───────────────────────────────────────────────────────
  //
  // The former "Featured apps" section, now a widget in the grid: the
  // admin-curated tiles plus the way into the #apps directory. The tiles are
  // the same per-viewer `featured` flags GET /api/apps already serializes
  // (Home.featuredApps derives them; no second query), and the browse
  // control is the same #home-browse-btn that used to sit under the old card.
  //
  // Tiles are the COMPACT 40px treatment (the widget-strip tile, not the
  // 56px launcher card): the block is ~366px wide on a phone and ~397px on
  // desktop, and a full card simply does not fit.
  //
  // ONE SHAPE AT EVERY WIDTH. It used to be two (#949), because the widget's
  // registry footprint was asymmetric — 4x1 on a phone, 2x2 on desktop — and
  // the content had to follow: a phone got the title bar and the featured
  // lane and nothing else, because the second lane would not fit the one row
  // it owned. THE UI OVERHAUL made Discover a fixed section, so the Popular
  // lane — the most-used apps this viewer doesn't have yet
  // (Home.popularApps) — renders everywhere. That is the point of an area
  // called Discover rather than a strip of curated tiles: the curated lane
  // alone is whatever an admin got round to featuring.
  //
  // THE BROWSE CONTROL RIDES IN THE TITLE BAR, not in a footer of its own.
  // Discover has ONE destination, so it belongs beside the title rather than
  // in 27px of chrome under two lanes. (Challenges keeps _panelFooter for its
  // expand toggle, and #980 moved its leaderboard door up to the bar for the
  // same reason this one lives there.) _wire() needs no change for this: its
  // pointerdown guard is on `.home-panel button` generally, so the button is
  // excluded from the drag handle the bar otherwise is.
  //
  // The browse control ALWAYS renders — it is THE discovery path, so it must
  // not depend on curation existing. With nothing left to feature the tile
  // lane is dropped entirely (rather than drawn empty) and one centred line
  // takes its place.
  discoverView(panel) {
    const hasHome = !!(window.Home && typeof Home.featuredApps === 'function');
    const featured = hasHome ? Home.featuredApps(Home._apps || []) : [];
    // The "Popular" lane was DESKTOP ONLY: it was the second row the widget
    // earned at its 2x2 desktop footprint, and there was no room for it in the
    // one cell it owned on a phone. A fixed section has room at every width, so
    // it always renders now — which is the point of the area being called
    // Discover rather than being a strip of curated tiles.
    const popular = (hasHome && typeof Home.popularApps === 'function')
      ? Home.popularApps(Home._apps || []) : [];
    return {
      key: panel.key,
      title: panel.title || 'Discover',
      featured: featured.map((a) => HomePanels.discoverTileView(a)),
      popular: popular.map((a) => HomePanels.discoverTileView(a)),
    };
  },

  // One compact discovery tile. `added` is the whole of the +/✓ badge's
  // treatment, and it is read HERE rather than in the component because
  // `Home.isYours` is the same predicate the launcher grid partitions on —
  // the badge and "Your apps" can never disagree about what is added.
  //
  // The icon is spelled out rather than delegated to AppCard.iconViewFor for
  // one reason: this module has no import of the card builders and the tests
  // that run it in a vm supply no binding for one. The three kinds and their
  // priority order are the same, and tests/home-panels-render.test.js pins
  // that against the shared helper.
  discoverTileView(app) {
    let icon;
    if (app.icon_url) icon = { kind: 'image', src: app.icon_url };
    else if (app.icon_emoji) icon = { kind: 'emoji', emoji: app.icon_emoji };
    else icon = { kind: 'letter', letter: String(app.name || '?').charAt(0).toUpperCase() };
    return {
      slug: app.slug,
      name: String(app.name || ''),
      status: String(app.status || ''),
      demo: !!app.demo,
      added: !!(window.Home && Home.isYours && Home.isYours(app)),
      icon,
      illustration: app.featured_illustration || null,
      blurb: HomePanels.appBlurb(app),
      contributors: Number(app.contributor_count) || 0,
    };
  },

  // The card's sentence. There is no description COLUMN on `apps` — the
  // directory's rows derive a meta line instead — so the one place an app can
  // say what it is in its own words is its manifest, and the row already
  // carries the whole of it (`manifest_snapshot` is a non-secret column).
  // Absent or blank on most apps today, and the card draws nothing rather
  // than a filler sentence: an invented blurb is worse than a short card.
  // Capped here as well as at the manifest reader, because the snapshot is
  // whatever the app's own repository last committed.
  appBlurb(app) {
    const snap = app && app.manifest_snapshot;
    const raw = snap && typeof snap === 'object' ? snap.description : null;
    if (typeof raw !== 'string') return null;
    const text = raw.replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 160) : null;
  },

  // ── Create app ─────────────────────────────────────────────────────
  //
  // The former "Create an app" section, now a 1x1 tile-sized widget.
  //
  // IT IS ON EVERY HOME SCREEN, FOR EVERY ACCOUNT. An account with no app
  // quota gets the same widget in the same cell — dimmed, and tapping it
  // opens the dialog with exact usage — rather than having it silently
  // absent. Two reasons this is
  // the right shape and not a conditional placement:
  //
  //   1. canCreateApps is DERIVED per request (full-admin write access or
  //      live app count < app_quota — see /api/auth/me), so it flips without
  //      any user action:
  //      creating your one allowed app, an admin editing your quota, an app
  //      erroring out. Conditional placement would turn each of those flips
  //      into a layout mutation that re-packs the grid under the user.
  //   2. It's the majority rendering — most accounts carry no quota — so
  //      "absent" would read as a missing feature rather than a locked one.
  //
  // The locked treatment belongs to the widget, not to a disabled button:
  // that button's available action is opening the exact quota details.
  createView(panel) {
    return {
      key: panel.key,
      canCreate: !!(window.Home && typeof Home.canCreate === 'function' && Home.canCreate()),
      hint: (window.Home && Home.CREATE_DISABLED_HINT)
        || 'View your app allowance or request more slots.',
    };
  },

  // Does this challenge carry a metric with a target? With a target above one
  // it is COUNTED — "0/8 apps tested" — and challengeRowView gives it a count
  // and a bar from zero; a target of one is a yes-or-no and gets words.
  hasMeter(c) {
    return !!(c && c.metric && c.progress && c.progress.target != null);
  },

  // The shape of a challenge illustration slug, the Challenges tab
  // controller's ILLUSTRATION_SLUG. Spelled out rather than imported from
  // lib/challenge-illustrations.ts: this module runs in the tests' vm with its
  // imports stripped (tests/helpers/home-modules.js), and a row needs only
  // the shape — the card resolves the slug (a built-in by membership, an
  // upload by its `u-` slug).
  ILLUSTRATION_SLUG: /^[a-z0-9][a-z0-9-]{0,63}$/,
  // The shape of an uploaded illustration's tone, the controller's
  // ILLUSTRATION_TONE, spelled out for the same reason; the registry decides
  // whether it is one of its TONES.
  ILLUSTRATION_TONE: /^[a-z]{3,10}$/,

  // ONE CARD ON BOTH SURFACES. Home's Challenges block draws the Challenges
  // tab's card (features/leaderboard/challenge-card.tsx), so a row carries the
  // descriptor that tab's controller builds: the rail's state, its one short
  // label, its fill, and "Earned N pts" on a finished challenge the viewer
  // scored on. The words are the tab's ("Not started", "3/8 apps tested",
  // "Started", "Done"), composed here so a number and its unit stay one text
  // node. Progress is this payload's own — resolveProgress on the server,
  // which reads snapshot blocks — so "Not started" is a counted fact here.
  // The card is the title, its deadline and the rail only: the organiser CTA,
  // the category and the task stay off it, and all three are a tap away on
  // the Challenges tab.
  //
  // A COUNTED challenge (a target above one) shows its count and bar from
  // zero — "0/3 Apps tried" — so a challenge with steps never reads as the
  // plain "Not started" of a yes-or-no one.
  //
  // The DEADLINE is the row's `ends_at` — its own schedule_end, else its
  // event's end, the same date the Challenges tab uses — else the season's
  // end; none on a finished or not-open challenge. It stays on every open card
  // until deadline bands group the challenges by when they end.
  challengeRowView(c, panel) {
    const numeric = HomePanels.hasMeter(c);
    const done = !!(c.progress && c.progress.done);
    const target = numeric ? Number(c.progress.target) : null;
    const current = numeric ? Math.max(0, Number(c.progress.current) || 0) : 0;
    const points = Number(c.earned_points) > 0 ? Number(c.earned_points) : 0;
    let rail;
    if (done) {
      rail = { state: 'done', stateLabel: 'Done', fill: 1, counted: false };
    } else if (numeric && target > 1) {
      const count = Math.min(current, target);
      const unit = c.metric.label ? ` ${c.metric.label}` : '';
      rail = {
        state: count > 0 || points ? 'progress' : 'new',
        stateLabel: `${count}/${target}${unit}`,
        fill: count / target,
        counted: true,
      };
    } else if (points) {
      rail = { state: 'progress', stateLabel: 'Started', fill: null, counted: false };
    } else {
      rail = { state: 'new', stateLabel: 'Not started', fill: 0, counted: false };
    }
    const eventId = Number(c.season_event_id);
    return {
      id: String(c.id),
      // The event the challenge belongs to, for the card's deep link to its
      // page on the Challenges tab (goToChallenge); null without one.
      eventId: Number.isSafeInteger(eventId) && eventId > 0 ? eventId : null,
      // The kind's icon (challenge_kinds.icon — one setting gives every
      // challenge of a kind the same face), the tile's fallback when the
      // template names no illustration the registry resolves or its artwork fails
      // to load. Null on a kind that has none; with no artwork either, the
      // tile is then an empty neutral face.
      icon: typeof c.icon === 'string' && c.icon.trim() ? c.icon.trim().slice(0, 8) : null,
      // The template's illustration, which the tile draws in place of the
      // icon when the registry resolves it; null without one or when malformed.
      illustration: typeof c.illustration === 'string' && HomePanels.ILLUSTRATION_SLUG.test(c.illustration)
        ? c.illustration : null,
      // An uploaded illustration's tone (null for a built-in, which has its
      // own); the tile draws an upload on gray without a tone it knows.
      illustrationTone: typeof c.illustration_tone === 'string' && HomePanels.ILLUSTRATION_TONE.test(c.illustration_tone)
        ? c.illustration_tone : null,
      goal: String(c.goal || ''),
      done,
      reward: HomePanels.formatReward(c.reward) || null,
      ...rail,
      // No countdown on a finished challenge, nor on one the expanded list
      // carries while it is not open (organiser-closed, or outside its
      // window). `ends_at` is the challenge's own end, else its event's.
      deadline: done || c.open === false ? null
        : HomePanels.timeLeft(c.ends_at || (panel && panel.season && panel.season.ends_at)),
      earned: done && points ? `Earned ${points.toLocaleString('en-US')} pts` : null,
    };
  },

  // ── The season progress ────────────────────────────────────────────
  //
  // "3/9 done in Season 2" over one segment per challenge, drawn by
  // features/leaderboard/season-progress.tsx: the component the Leaderboard
  // screen's Challenges tab opens on too, so the season reads the same on
  // both. It replaced a ring with a points lead and a count under it, which
  // took three lines to say what the segments say in one.
  //
  // The scope is the season (the payload's own `done` of `total`), except
  // while setup gates the rest: the block then holds only the setup
  // challenges, so the progress is setup's ("done in Get started"), the
  // board's "progress has a scope" rule. Deadlines and points stay on the
  // cards.
  seasonView(panel) {
    const total = Number(panel && panel.total) || 0;
    if (!total) return null;
    const gate = panel.onboarding;
    if (gate && !gate.unlocked && Number(gate.total) > 0) {
      const t = Number(gate.total);
      return {
        done: Math.max(0, Math.min(t, Number(gate.completed) || 0)),
        total: t,
        caption: 'done in Get started',
      };
    }
    const name = panel.season && typeof panel.season.name === 'string'
      ? panel.season.name.trim() : '';
    return {
      done: Math.max(0, Math.min(total, Number(panel.done) || 0)),
      total,
      caption: name ? `done in ${name}` : 'done',
    };
  },

  // An end date as the cards say it, in the board's short form: whole days
  // rounded UP ("5d left"; 23.5 hours is "1d left"), hours under a day ("7h
  // left", at least "1h left"), and null once past or unparseable rather than
  // a negative count — the panel is only built for a running season, so that
  // is a clock skew case, not a state. The Challenges tab says the same words
  // (TopochainChallenges._timeLeft); both test files pin one table.
  timeLeft(raw) {
    if (!raw) return null;
    const ends = Date.parse(raw);
    if (!Number.isFinite(ends)) return null;
    const ms = ends - Date.now();
    if (ms <= 0) return null;
    const hours = Math.ceil(ms / 3600000);
    return hours < 24 ? `${hours}h left` : `${Math.ceil(ms / 86400000)}d left`;
  },

  // Real hash navigation (not a router call) so the Challenges screen gets a
  // history entry and the device back gesture returns to the home screen.
  goToChallenges() {
    location.hash = '#leaderboard/challenges';
  },

  // A challenge CARD opens that challenge's own page, not the list: the
  // Challenges tab's deep link, #leaderboard/challenges/<event>/<challenge>.
  // Real hash navigation for the same reason as goToChallenges, and that page's
  // back chevron returns here. A row with no event id (a demo row) has no
  // address the tab could resolve, so it lands on the list instead.
  goToChallenge(eventId, challengeId) {
    const ev = Number(eventId);
    const ch = Number(challengeId);
    if (!Number.isSafeInteger(ev) || ev <= 0 || !Number.isSafeInteger(ch) || ch <= 0) {
      HomePanels.goToChallenges();
      return;
    }
    location.hash = `#leaderboard/challenges/${ev}/${ch}`;
  },

  // The Leaderboard screen's standings tab. The Topochain standings ARE the
  // screen's primary tab, so they address as the bare hash; `kind` survives
  // because the ⋮ menu's own row still passes one, and it is the same real
  // hash navigation as goToChallenges, so the device back gesture returns
  // home. (The Challenges heading's link used to come here as "Open
  // leaderboard"; since #1916 it reads "Open challenges" and goes through
  // goToChallenges instead.)
  goToLeaderboard(kind) {
    location.hash = kind === 'kudos' ? '#leaderboard/users' : '#leaderboard';
  },

  // `_wire(section)` lived here: eight `querySelectorAll` sweeps re-run after
  // every paint, because the paint had just destroyed the nodes they were on.
  // Every one of them is a prop in ./panels/ now — the challenge rows and the
  // footer's Open button (Challenges), the heading's leaderboard link, the
  // expand toggle, the ⋮, Discover's browse control, and the create tile's two
  // branches.
  //
  // Two of its calls did not become props, for two different reasons:
  //
  //   * `Home._wireDiscoveryCards(lane)` still runs, from an effect in
  //     ./panels/discover.tsx. It binds tap-to-open, the modified-click anchor
  //     and the +/✓ badge — attaching listeners to nodes and writing no
  //     markup, which is the split AGENTS.md sanctions and the same one
  //     app-grid.tsx makes for the canvas recognizer.
  //   * `Home.wireCreateButtons()` does NOT, and is gone. It was a `cloneNode`
  //     + `replaceChild` — a structural DOM write, and discipline the string
  //     renderer needed only because every paint rebuilt the node. React keeps
  //     the element and the handler is a prop, so both problems go together;
  //     this was its only caller and the create tile its only element.
  //
  // The `pointerdown` guard on `.home-panel button` went earlier, with the
  // placement: the blocks were grid items and the recognizer listened on
  // #app-list, so stopping the event AT the button was what kept a press on ⋮
  // from arming a drag. These sections are outside #app-list now.

  // Grow the block past its height cap in place, showing every challenge
  // including the organiser-finished ones; the same control collapses it.
  // Expanding needs a refetch because the collapsed payload is filtered
  // server-side (finished challenges never left the database), so the
  // toggle paints the state it can immediately and fills in when the
  // wider list lands.
  async toggleExpanded(key) {
    if (!key) return false;
    const next = !HomePanels._expanded[key];
    HomePanels._expanded[key] = next;
    HomePanels.render();
    try {
      await HomePanels.ensureLoaded({ force: true });
      return true;
    } catch (err) {
      // A failed refetch leaves the rows as they were rather than emptying
      // the block; the toggle can simply be pressed again.
      return false;
    }
  },
};

// Home calls this module through the legacy global. Guard the
// publication for the shell's server-side prerender, where window is absent.
if (typeof window !== 'undefined') window.HomePanels = HomePanels;
