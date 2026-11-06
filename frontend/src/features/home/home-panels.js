// Home-screen sections (issue #911) — the blocks stacked under the launcher
// grid. THE UI OVERHAUL fixed their order and their hosts; One Home (#6361)
// took Discover's lane off Home (its directory is Communities to join), so
// one is left:
//
//   challenges — what the viewer can do next: their First challenges while
//                any is unfinished, then up to three open ones, in the
//                Challenges tab's order, or one line when nothing is open. "See all"
//                in its heading goes to the Challenges tab.
//
// CREATE APP WAS THE THIRD. It is the launcher grid's trailing tile now
// (features/home/create-tile.tsx, placed by Home.render() — the prototype's
// scrHome), so it has no section, no view model and nothing in this module.
// The server's registry still lists `create` (src/routes/home-panels.js), and
// a cached older shell still renders its section from it; this module simply
// no longer asks for it.
//
// PLACEMENT IS GONE, and with it a whole dimension of this module. Each
// block used to be a draggable ITEM of the launcher grid — home.js planted a
// `[data-panel-slot="<key>"]` host inside #app-list at the viewer's stored
// (column, row) cell, HomeLayout carried a per-breakpoint footprint table for
// each one, and PUT /api/home-layout persisted where they had been dropped.
// They are fixed <section> hosts in a fixed order now, outside
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
// DENSITY — a section sizes to its own CONTENT. The capped variants
// (`inGrid: true`, the phone one-cell branch with its two-row budget) were
// concessions to a fixed rectangle of the launcher canvas and went with the
// placement. Challenges draws a short pick (challengesView) and leaves the
// rest to the Challenges tab behind "See all" — never an inner scroller (a
// nested scroll region inside the page scroller is a touch trap), never a
// horizontal pager (invisible to the screenshot capture and to dapp.json
// checks, which can only navigate), and no longer an in-place expansion.
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

import { t as message } from '../../lib/i18n/runtime';
import { warmIllustrations } from '../../lib/challenge-illustrations';
import { panelsStore } from './panels-store';

const HomePanels = {
  // Cache of GET /api/home-panels: { registry, panels }.
  _data: null,
  _fetchedAt: 0,
  _inflight: null,
  // The first read has answered, well or not: a failed read keeps no copy,
  // and the sections then hide rather than wait (render's first-paint rule).
  _answered: false,
  TTL_MS: 60 * 1000,

  // ── The pick ───────────────────────────────────────────────────────
  //
  // How many open challenges "Next challenges" draws. The server sends the
  // whole open scope (up to its 40-row ceiling, CHALLENGE_EXPANDED_LIMIT in
  // src/routes/home-panels.js) and this module picks from it
  // (challengesView): a short look at what to do next, with the whole list one
  // tap away behind "See all". The four-row preview, its "See all N
  // challenges" / "Show less" toggle and the in-place expansion it fetched
  // (`?expand=challenges`) went with the Semi design, 2026-10-16.
  NEXT_SLOTS: 3,

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
    if (!/^[\d][\d.,]*$/.test(s)) return s;
    // The number is shown as it was written; its digits pick the plural form.
    return message('home:challenges.reward.points', { points: s, count: Number(s.replace(/[.,]/g, '')) || 0 });
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

  // The block's rows in the Challenges tab's order
  // (TopochainChallenges._ordered), so the same challenges come out in the
  // same sequence on both surfaces. THE CLIENT IS THE SOURCE OF TRUTH: the
  // server's ORDER BY only decides which rows survive its row ceiling.
  // "Next challenges" breaks its ties in this sequence (nextRows).
  //
  // The keys, in order: the group (groupRankOf: First challenges while unfinished,
  // This week, Always open, Season challenges, then a finished First challenges group),
  // then unfinished challenges first (orderDone, the tab's _isDone: the
  // viewer's own progress on every card), then organiser-featured (`featured`, the
  // flag the tab's personalization row carries), then the tab's public list
  // order: `display_order`, then `id`. A payload whose rows do not all carry a
  // `display_order` (the staging demo, or a cache written before the field)
  // keeps the server's sequence for that last key instead. Stable, and the
  // input is not mutated. `onboarding` is the payload's old gate summary,
  // which a server before #4635 sent and none sends now; without it the rows
  // decide whether the First challenges group is finished (setupFinished).
  orderRows(rows, onboarding) {
    const list = (rows || []).slice();
    const finished = HomePanels.setupFinished(list, onboarding);
    const byOrder = list.length > 0 && list.every((c) => c && c.display_order != null
      && c.display_order !== '' && Number.isFinite(Number(c.display_order)));
    return list
      .map((c, i) => ({ c, i, g: HomePanels.groupRankOf(HomePanels.groupOf(c), finished) }))
      .sort((a, b) => {
        if (a.g !== b.g) return a.g - b.g;
        const ad = HomePanels.orderDone(a.c) ? 1 : 0;
        const bd = HomePanels.orderDone(b.c) ? 1 : 0;
        if (ad !== bd) return ad - bd;
        const af = a.c?.featured === true ? 1 : 0;
        const bf = b.c?.featured === true ? 1 : 0;
        if (af !== bf) return bf - af;
        if (byOrder) {
          const ao = Number(a.c.display_order);
          const bo = Number(b.c.display_order);
          if (ao !== bo) return ao - bo;
          const ai = Number(a.c.id);
          const bi = Number(b.c.id);
          if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
        }
        return a.i - b.i;
      })
      .map((x) => x.c);
  },

  // The First challenges in the admin's order, done ones IN PLACE: a card
  // the viewer finished keeps its seat and shows its Done rail, so the four
  // read as one checklist being ticked rather than a list that reshuffles
  // under the thumb. `display_order`, then `id`, when every row carries an
  // order (the tab's public list order); otherwise the server's sequence.
  inAdminOrder(rows) {
    const list = (rows || []).slice();
    const byOrder = list.length > 0 && list.every((c) => c && c.display_order != null
      && c.display_order !== '' && Number.isFinite(Number(c.display_order)));
    if (!byOrder) return list;
    return list
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (Number(a.c.display_order) - Number(b.c.display_order))
        || (Number(a.c.id) - Number(b.c.id)) || (a.i - b.i))
      .map((x) => x.c);
  },

  // "Next challenges": the open challenges the viewer has not finished, in
  // the Challenges tab's own order (orderRows), cut to NEXT_SLOTS. A
  // challenge carried while not open (organiser-closed, or outside its
  // window) is not something to do next. Stable, and the input is not
  // mutated.
  //
  // NOT BY PROGRESS (polish N11). It was furthest along first, and progress
  // is what moves: the boot copy and the fresh read a moment later
  // disagreed, and every visit after a step, so the three cards swapped
  // places, and which three they were, while you looked at them. The tab's
  // order changes only when a challenge is finished, opens or closes.
  nextRows(rows, onboarding) {
    return HomePanels.orderRows(rows, onboarding)
      .filter((c) => c && HomePanels.groupOf(c).key !== 'setup'
        && !HomePanels.orderDone(c) && c.open !== false)
      .slice(0, HomePanels.NEXT_SLOTS);
  },

  // ── Data ───────────────────────────────────────────────────────────

  // Called from Home.load(). At most one fetch per TTL, and concurrent
  // callers share the in-flight promise.
  //
  // A FORCED read is a refresh, not a boot. Its caller knows the copy is
  // behind something that just happened (a join the server has counted, an
  // app visit credited, a First challenge ticked), so two things that suit a
  // boot are wrong for it:
  //   * sharing a read already in flight, which may have left before that
  //     thing happened. It waits for that read and then reads again, once,
  //     however many forced callers arrive meanwhile (Home.load()'s rule);
  //   * the service worker's zero-deadline lane, which answers
  //     /api/home-panels from its cache on a device that has drawn Home
  //     before. It is told first (App._announceRefreshIntent), as a pull and
  //     a board refresh tell it.
  //
  // `fresh` (a pull, a live re-read) goes further: the worker waits for the
  // network instead of answering from its saved copy after its one-second
  // deadline (public/sw.js, wantsFreshAnswer; lib/live-reads.ts's FRESH).
  _queued: null,
  _queuedFresh: false,

  ensureLoaded(opts) {
    const force = !!(opts && opts.force);
    const fresh = force && !!(opts && opts.fresh);
    if (!window.App || !App.user) return Promise.resolve();
    HomePanels._watchLiveReads();
    if (HomePanels._inflight) {
      if (!force) return HomePanels._inflight;
      if (fresh) HomePanels._queuedFresh = true;
      if (!HomePanels._queued) {
        const again = () => {
          const queuedFresh = HomePanels._queuedFresh;
          HomePanels._queued = null;
          HomePanels._queuedFresh = false;
          return HomePanels.ensureLoaded({ force: true, fresh: queuedFresh });
        };
        HomePanels._queued = HomePanels._inflight.then(again, again);
      }
      return HomePanels._queued;
    }
    if (!force && HomePanels._data
        && Date.now() - HomePanels._fetchedAt < HomePanels.TTL_MS) {
      return Promise.resolve();
    }
    if (force) App._announceRefreshIntent?.();
    // ?demo=1 rides along exactly like Home.load()'s own demoQS — the
    // server only honours it in staging.
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
    const qs = params.toString() ? `?${params.toString()}` : '';

    const init = { credentials: 'same-origin' };
    if (fresh) init.cache = 'no-cache';
    HomePanels._inflight = fetch(`/api/home-panels${qs}`, init)
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
      .then(() => HomePanels._warmArt())
      .then(() => {
        HomePanels._inflight = null;
        HomePanels._answered = true;
        HomePanels.render();
      });
    return HomePanels._inflight;
  },

  // Live reads (#3985, lib/live-reads.ts): coming back to the tab after a
  // while, the socket reconnecting or the browser coming back online reads
  // the block again, past its minute, while Home is the screen showing it. A
  // challenge finished in another app then shows its new count on return.
  //
  // It also owns /api/home-panels, so the service worker's correction of it
  // reaches the block. App._onApiUpdated's Home.load() could not: the copy the
  // worker served had just restarted the minute, so that ordinary call read
  // nothing and the old numbers stayed up after a reload. Registered once, on
  // the first read.
  _unwatchLive: null,
  _watchLiveReads() {
    if (HomePanels._unwatchLive) return;
    const live = typeof window !== 'undefined' && window.UsernodeReact && window.UsernodeReact.liveReads;
    if (!live || typeof live.watch !== 'function') return;
    HomePanels._unwatchLive = live.watch(() => {
      if (!HomePanels._data || !window.App?._isScreenVisible?.('home-screen')) return undefined;
      return HomePanels.ensureLoaded({ force: true, fresh: true });
    }, { reads: (url) => url.pathname === '/api/home-panels' });
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
  // fixed section hosts, rendered in a fixed order, that no search
  // keystroke or grid re-render can take away. The fallback existed only
  // because a widget inside #app-list vanished whenever #app-list did.
  // The section hosts, keyed the way panelFor() keys them. The ids are
  // ./panels/sections.tsx's now — each section component renders its own host
  // — but the mapping stays here because it is what makes "which blocks are
  // there" one list rather than a call site per block. `create` left this map
  // when Create app became the launcher grid's trailing tile.
  SECTION_HOSTS: {
    challenges: 'home-challenges-section',
  },

  // One paint: compute the view models and push them.
  //
  // Was an `innerHTML` assignment and a `classList.toggle('hidden')` per host, a
  // `_stampState` pass that mirrored each block's own state attributes up onto
  // its host, and a `_wire` pass that re-attached eight families of listener
  // to nodes the assignment had just created. All four collapse into the push:
  // ./panels/sections.tsx renders the host AND the block from one model, so
  // the mirror is a prop rather than a second pass over somebody else's
  // markup, and every listener is a prop on an element React keeps.
  render() {
    // Signed out draws NOTHING — every block here is me-scoped (your
    // challenge progress, the apps you don't have yet), and
    // the guard used to live in renderAll(), the one entry point there was.
    const signedIn = !!(window.App && App.user);
    // THE FIRST PAINT WAITS FOR BOTH READS (#10, the polish board of 19 Oct
    // 2026). Two paths call this: /api/home-panels answering, and Home.render
    // when /api/apps does. Painting on whichever came first drew a page that
    // the second one rearranged: with only the apps in, both sections hid
    // (no panels yet) and then reappeared; with only the panels in, Discover
    // drew "Nothing to discover" from an empty app list and then grew into a
    // rail of cards, while the grid's rows arrived above it and pushed both
    // sections down. Until both have answered (a failure counts: a failed
    // read hides its section, and a failed apps read still lets the panels
    // draw), the sections keep their skeletons at the height this device
    // last drew them at (lib/first-paint-reserve.ts), and the paint after that is the
    // page's final shape. Only the FIRST paint waits; every later call is a
    // repaint of a page already drawn.
    if (signedIn && !panelsStore.get().painted && !HomePanels.readyToPaint()) return;
    const viewFor = (key, build) => {
      if (!signedIn) return null;
      const panel = HomePanels.panelFor(key);
      return panel ? build(panel) : null;
    };
    panelsStore.set({
      painted: true,
      challenges: viewFor('challenges', HomePanels.challengesView),
    });
  },

  // THE CARDS' ART, DECODED BEFORE THE CARDS DRAW (#1, #10). The challenge
  // cards drew with an empty tone where the picture goes and the picture a
  // frame later; the rows this read is about to draw are decoded first
  // (lib/challenge-illustrations.ts warmIllustrations, at most ART_WAIT_MS),
  // so they paint with their art. Imported, unlike the slug shape below,
  // because nothing a test runs reaches it: the vm strips the import, and
  // `typeof` of the missing binding is what lets it pass.
  ART_WAIT_MS: 400,
  _warmArt() {
    try {
      if (typeof warmIllustrations !== 'function') return Promise.resolve();
      const panel = HomePanels.panelFor('challenges');
      const view = panel ? HomePanels.challengesView(panel) : null;
      const rows = view && Array.isArray(view.rows) ? view.rows : [];
      return warmIllustrations(
        rows.map((row) => ({ slug: row.illustration, tone: row.illustrationTone })),
        HomePanels.ART_WAIT_MS,
      ).catch(() => {});
    } catch (err) {
      return Promise.resolve();
    }
  },

  // Both reads have answered: the panels (or this copy came from a test that
  // set `_data`), and the apps, when there is a launcher to wait for. A Home
  // module without `_appsLoaded` (a test's stand-in) waits for nothing.
  readyToPaint() {
    if (!HomePanels._answered && !HomePanels._data) return false;
    const home = window.Home;
    if (!home || home._appsLoaded !== false) return true;
    return home._appsSettled === true;
  },

  // A NEW ACCOUNT SEES CHALLENGES (first-session run-through, 2026-10-05).
  // #3847 hid this block for an account's first seven days (the first
  // chapter, without points). Evan reversed that: a brand-new account found
  // Challenges missing from Home and expected it there, with its First
  // challenges. So nothing about an account's age hides it, and GET
  // /api/auth/me no longer reports `firstWeek`.

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
  // attribute contract is unchanged; only the second pass is gone. (The
  // create pair lives on the launcher's trailing tile now, one element that
  // carries both — features/home/create-tile.tsx.)

  // `hasLayoutRegistry()` and `gridSlotKeys()` lived here: the list of widgets
  // HomeLayout should place for this viewer, and the flag that told home.js
  // the authoritative footprints had arrived so a derived layout was safe to
  // persist. Both went with the placement — the sections are in the
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
    return (built && built.title) || message('home:panels.fallbackTitle');
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
  // THE BLOCK IS NAMED BY WHAT IT HOLDS (the Semi design, 2026-10-16). One
  // of four modes, each its own heading:
  //
  //   first — "First challenges" while any First challenge (ONBOARDING) is
  //           unfinished: every one of them, in the admin's order, the done
  //           ones in place with their Done rail (inAdminOrder).
  //   next  — "Next challenges" once they are all done: up to NEXT_SLOTS open
  //           challenges the viewer has not finished, in the Challenges
  //           tab's order (nextRows).
  //   done  — "Challenges" over one line, when nothing is open and every
  //           This week challenge is done: "All done for this week", and how
  //           many start again on Monday (the week the scorer counts by).
  //   none  — "Challenges" over one line, when nothing is open otherwise,
  //           a season with no challenges included: "No challenges right
  //           now". The only mode without "See all": there is nothing behind
  //           it to see.
  //
  // What it no longer says, on purpose: the season and its progress bar, a
  // points total, "N of M done", group headers, and any deadline or
  // countdown. The payload still carries `season`, `points_*`, `all_*` and
  // `ends_at`; they are ignored here.
  challengesView(panel) {
    const all = Array.isArray(panel.challenges) ? panel.challenges.filter(Boolean) : [];
    const base = {
      key: panel.key,
      title: panel.title || message('home:challenges.fallbackTitle'),
    };
    const rowsOf = (list) => list.map((c) => HomePanels.challengeRowView(c));
    const setup = all.filter((c) => HomePanels.groupOf(c).key === 'setup');
    if (setup.length && !HomePanels.setupFinished(all, panel.onboarding)) {
      return {
        ...base,
        mode: 'first',
        heading: message('home:challenges.headingFirst'),
        seeAll: true,
        rows: rowsOf(HomePanels.inAdminOrder(setup)),
        note: null,
      };
    }
    const next = HomePanels.nextRows(all, panel.onboarding);
    if (next.length) {
      return {
        ...base,
        mode: 'next',
        heading: message('home:challenges.headingNext'),
        seeAll: true,
        rows: rowsOf(next),
        note: null,
      };
    }
    const weekly = all.filter((c) => HomePanels.groupOf(c).key === 'week');
    if (weekly.length && weekly.every((c) => HomePanels.orderDone(c))) {
      return {
        ...base,
        mode: 'done',
        heading: message('home:challenges.heading'),
        seeAll: true,
        rows: [],
        note: {
          title: message('home:challenges.allDone.title'),
          text: message('home:challenges.allDone.text', { count: weekly.length }),
        },
      };
    }
    return {
      ...base,
      mode: 'none',
      heading: message('home:challenges.heading'),
      seeAll: false,
      rows: [],
      note: {
        title: message('home:challenges.none.title'),
        text: message('home:challenges.none.text'),
      },
    };
  },

  // ── The categories ─────────────────────────────────────────────────
  //
  // A challenge's category decides two things here: whether it is a First
  // challenge (ONBOARDING, the `setup` key) and whether it counts by the week
  // (WEEKLY, `week`), whose rail says "this week". The Challenges tab reads
  // the same two facts and whether a challenge is done the same way, and
  // tests/challenge-group-parity.test.js holds the two copies to those three
  // answers. It carries no headings any more: Home draws no group headers.
  // `order` is each category's rank while setup is unfinished; groupRankOf
  // moves a finished First challenges group to the end.
  CHALLENGE_GROUPS: {
    ONBOARDING: { key: 'setup', order: 0 },
    WEEKLY: { key: 'week', order: 1 },
    PERSISTENT: { key: 'always', order: 2 },
  },
  OTHER_GROUP: { key: 'other', order: 3 },

  // A challenge's group, from its label: the category, trimmed and uppercased.
  groupOf(c) {
    const category = String(c && c.label != null ? c.label : '').trim().toUpperCase();
    return Object.prototype.hasOwnProperty.call(HomePanels.CHALLENGE_GROUPS, category)
      ? HomePanels.CHALLENGE_GROUPS[category] : HomePanels.OTHER_GROUP;
  },

  // Whether setup is behind the viewer, which decides between First and Next.
  // The rows must hold at least one setup card and every one of them must be
  // done. A server before #4635 sent a gate summary that decided instead
  // (`unlocked === true`); none does now, and the branch stays for it.
  setupFinished(rows, onboarding) {
    if (onboarding) return onboarding.unlocked === true;
    const setup = (Array.isArray(rows) ? rows : [])
      .filter((c) => c && HomePanels.groupOf(c).key === 'setup');
    return setup.length > 0 && setup.every((c) => HomePanels.orderDone(c));
  },

  // Whether the viewer has finished a challenge: the tab's _isDone. Both
  // lists carry the viewer's own `progress` on every card; a row without it
  // falls back to the organiser's `completed` flag, as the tab's does.
  orderDone(c) {
    if (!c) return false;
    if (c.progress) return c.progress.done === true;
    return c.completed === true;
  },

  // A group's rank in the board's order, the tab's _groupRankOf: First challenges
  // while unfinished (0), This week (1), Always open (2), the rest (3), then
  // First challenges once finished (4, last). Pure: a group from
  // CHALLENGE_GROUPS/OTHER_GROUP and the setupFinished answer.
  groupRankOf(group, setupFinished) {
    const g = group || HomePanels.OTHER_GROUP;
    return g.key === 'setup' && setupFinished === true ? 4 : g.order;
  },

  // `renderChallengesPanel` and `_countFillRows` lived here. The first is
  // `challengesView` above; the second counted the standings-preview rows the
  // renderer had actually drawn, and went with the preview itself.

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
  // `createView()` lived here: the Create block's quota state and its locked
  // hint, for the fixed section below Challenges. The block is the launcher
  // grid's trailing tile now, and Home.render() builds its view model on the
  // same paint that places it (gridStore's `create`), so nothing is left here.

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
  // label, its fill, the reward, and "Earned N pts" on a finished challenge
  // the viewer scored on. The words are the tab's ("Not started", "3/8 apps
  // tested", "Started", "Done"), composed here so a number and its unit stay
  // one text node. Progress is this payload's own — resolveProgress on the
  // server, which reads snapshot blocks — so "Not started" is a counted fact
  // here. The card is the art, the title with its points and the rail only:
  // no deadline, no category, no task and no organiser CTA, all of which are
  // a tap away on the Challenges tab.
  //
  // A COUNTED challenge (a target above one) shows its count and bar from
  // zero — "0/3 Apps tried" — so a challenge with steps never reads as the
  // plain "Not started" of a yes-or-no one. A This week challenge counts by
  // the week, so its count says so: "2/3 apps tried this week". A yes-or-no
  // one keeps Started / Not started: it has no count to put a week on.
  challengeRowView(c) {
    const numeric = HomePanels.hasMeter(c);
    const done = !!(c.progress && c.progress.done);
    const target = numeric ? Number(c.progress.target) : null;
    const current = numeric ? Math.max(0, Number(c.progress.current) || 0) : 0;
    const points = Number(c.earned_points) > 0 ? Number(c.earned_points) : 0;
    const weekly = HomePanels.groupOf(c).key === 'week';
    let rail;
    if (done) {
      rail = { state: 'done', stateLabel: message('home:challenges.row.done'), fill: 1, counted: false };
    } else if (numeric && target > 1) {
      const count = Math.min(current, target);
      let stateLabel;
      if (weekly) {
        stateLabel = c.metric.label
          ? message('home:challenges.row.countOfUnitThisWeek', { current: count, target, unit: c.metric.label })
          : message('home:challenges.row.countOfThisWeek', { current: count, target });
      } else {
        stateLabel = c.metric.label
          ? message('home:challenges.row.countOfUnit', { current: count, target, unit: c.metric.label })
          : message('home:challenges.row.countOf', { current: count, target });
      }
      rail = {
        state: count > 0 || points ? 'progress' : 'new',
        stateLabel,
        fill: count / target,
        counted: true,
      };
    } else if (points) {
      rail = { state: 'progress', stateLabel: message('home:challenges.row.started'), fill: null, counted: false };
    } else {
      rail = { state: 'new', stateLabel: message('home:challenges.row.notStarted'), fill: 0, counted: false };
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
      earned: done && points
        ? message('home:challenges.row.earned', { points: points.toLocaleString('en-US'), count: points })
        : null,
    };
  },

  // `seasonView` and `timeLeft` lived here: the season progress line over the
  // block ("3/9 done in Season 2", with its points) and the "5d left" clocks
  // on the cards and the group headers, with `endsOf` / `weekEnd` working out
  // when a This week challenge's count started again. The Semi design
  // (2026-10-16) took the season, the points total and every deadline off
  // Home; a This week card says "this week" on its rail instead, and the
  // "All done for this week" line says the count starts again on Monday.

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

  // The Leaderboard screen's standings tab. It is named explicitly — the
  // bare hash opens the Challenges tab since #2374; `kind` survives
  // because the ⋮ menu's own row still passes one, and it is the same real
  // hash navigation as goToChallenges, so the device back gesture returns
  // home. (The Challenges heading's link used to come here as "Open
  // leaderboard"; since #1916 it reads "Open challenges" and goes through
  // goToChallenges instead.)
  //
  // #5249: while kudos is parked (no window.Kudos, see
  // features/leaderboard/kudos-parked.ts) there is no Top users list, so the
  // kudos kind lands on Challenges.
  goToLeaderboard(kind) {
    location.hash = kind === 'kudos'
      ? (window.Kudos ? '#leaderboard/users' : '#leaderboard/challenges')
      : '#leaderboard/topochain';
  },

  // `_wire(section)` lived here: eight `querySelectorAll` sweeps re-run after
  // every paint, because the paint had just destroyed the nodes they were on.
  // Every one of them is a prop in ./panels/ now — the challenge rows, the
  // heading's leaderboard link, the
  // expand toggle, the ⋮, Discover's browse control, and the create tile's two
  // branches.
  //
  // Two of its calls did not become props. `Home._wireDiscoveryCards(lane)`
  // ran from the Discover lane's effect until One Home (#6361) took the lane
  // off Home; it went with it. And:
  //
  //   * `Home.wireCreateButtons()` is gone. It was a `cloneNode`
  //     + `replaceChild` — a structural DOM write, and discipline the string
  //     renderer needed only because every paint rebuilt the node. React keeps
  //     the element and the handler is a prop, so both problems go together;
  //     this was its only caller and the create tile its only element.
  //
  // The `pointerdown` guard on `.home-panel button` went earlier, with the
  // placement: the blocks were grid items and the recognizer listened on
  // #app-list, so stopping the event AT the button was what kept a press on ⋮
  // from arming a drag. These sections are outside #app-list now.

  // `toggleExpanded` lived here: the footer's "See all N challenges" / "Show
  // less", which grew the block in place and refetched it with
  // `?expand=challenges`. "See all" in the heading is a link to the
  // Challenges tab now (./panels/ui.tsx, SeeAllLink).
};

// Home calls this module through the legacy global. Guard the
// publication for the shell's server-side prerender, where window is absent.
if (typeof window !== 'undefined') window.HomePanels = HomePanels;

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  // The views pushed to the store hold text, so a language change rebuilds
  // them from the same payload. Only once there is something to paint;
  // before the first read, render() would mark the sections settled with
  // nothing in them.
  document.addEventListener('homeroom:language-changed', () => {
    if (HomePanels._data) HomePanels.render();
  });
}

// A join or a leave has landed: Home.setMembership's `sv:membership-changed`
// (Discover's Join pill and detail page, the join-required prompt, the
// Mayor's join card, a project page's Leave) or the join screen's
// `sv:communities-joined`. The server counted a join before it answered
// ("Join a community", challengeScorer.scoreOnJoin), so the block reads
// again now rather than at the end of its minute, and the challenge ticks on
// Home as it does on the Challenges tab. Only once there is a block to
// correct, or a first read under way that may predate the write: before
// that, Home's own first load brings the current answer.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  const reread = () => {
    if (HomePanels._data || HomePanels._inflight) HomePanels.ensureLoaded({ force: true });
  };
  document.addEventListener('sv:membership-changed', reread);
  document.addEventListener('sv:communities-joined', reread);
  // An acknowledged app-visit upload (#5235, app-activity.js): the visit that
  // credits a "Try apps" challenge is often counted as the person leaves the
  // app, and the return-to-Home read can be answered first, before the credit
  // lands. So the block reads again fresh now, even inside its minute. The
  // same gate _watchLiveReads uses: only a block already painted, and only
  // while Home is the screen showing it. A forced read already queues behind
  // one in flight, so this and the return-to-Home read cannot hide each other.
  document.addEventListener('sv:app-activity-recorded', () => {
    if (!HomePanels._data || !window.App?._isScreenVisible?.('home-screen')) return;
    HomePanels.ensureLoaded({ force: true, fresh: true });
  });
}
