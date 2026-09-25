// Admin & moderation console (#818) — the full-page SPA screen behind the
// header shield icon. #588 shipped the icon plus a "Coming soon"
// placeholder; this module is the real console. Hash route
// #admin[/section], hosted in #admin-screen / #admin-root and
// mounted/unmounted by App.navigateToAdminConsole / App._exitAdminConsole
// (public/js/app.js), the same shape as the Challenges / Profile screens.
//
// ── #1082 chunk E: this file used to be public/js/admin-console.js ──────
// The screen root and the console CHASSIS are a React island now
// (./index.tsx): #admin-screen, #admin-root, the md:flex column pair, the
// desktop nav host, the view-only banner, #admin-section-content and the
// temporary-password dialog are all rendered by React and ship in
// public/index.html. This module was MOVED into that bundle rather than
// rewritten — the change here is the three lines that seam it to React:
//
//   * the AdminUI registry is an `export` (plus the same window publication
//     it always had), so the ten section modules import it instead of
//     depending on <script> order;
//   * _renderShell() no longer writes root.innerHTML — the chassis is
//     React's, and writing over it is the one thing the island rule
//     forbids. It repaints the nav host and the banner instead, which is
//     exactly what setSection() already did on every switch;
//   * window.AdminConsole is published behind a `typeof window` guard,
//     because the SSG prerender pass evaluates this module in Node.
//
// Everything below that is unchanged: #admin-section-content is still an
// innerHTML host that this file and the section modules own outright, so
// every render()/destroy() lifecycle, every id and every declared #admin/*
// dapp test sees the DOM it saw before.
//
// It reorganizes the standalone /admin page's sections (public/admin.html:
// Operations overview, Maintenance campaigns, LLM spend limits, Activation
// codes, Users) plus the /admin-features viewer into one page with a
// navigation menu — a fixed sidebar on md+ viewports. Every data endpoint
// is enforced server-side by adminMiddleware (reads) and requireAdminWrite
// (mutations); the client-side visibility gates are only presentation.
//
// MOBILE HIERARCHY: below md the sidebar has no room, and the horizontally
// scrolling tab strip that used to stand in for it (the Dev board's
// kanban-tabs pattern, #814) made sixteen ungrouped sections a thumb-swipe
// scavenger hunt. Phones now get a real two-level nav instead:
//
//   level 1 (#admin)        the grouped section menu, one tappable row per
//                           section under the same Operations / People /
//                           Insights / Platform headings as the sidebar;
//   level 2 (#admin/<key>)  that one section, full width, with the platform
//                           header's back button flipped to an arrow and
//                           its title set to the section label.
//
// The hash stays the single source of truth for WHICH section shows; the
// level is derived from it (bare #admin on mobile = the menu). A menu tap
// is a REAL hash navigation, so it pushes a history entry and the device /
// WebView back gesture pops back to the menu through exactly the same code
// path as the on-screen arrow (see _openSection / handleBack / route).
// Desktop is untouched: same sidebar, same instant switching, same URLs.
//
// #860 completed the consolidation: /status, /node-status, /dashboard,
// /debug and /gallery are sections here too, and all seven old URLs are
// now client-side redirect stubs into the matching #admin/<key>. Nothing
// in the admin experience opens a new browser tab any more, which is why
// the old TOOLS external-link block is gone.
//
// Permissions: the page itself is reachable for anyone with
// App.user.isAdmin (full AND view-only admins — the navigation gate lives
// in app.js). Write controls render only when App.user.canAdminWrite is
// true; view-only admins get read-only labels plus the amber banner,
// mirroring public/admin.html's CAN_WRITE behaviour (issue #311). The
// "View as non-admin" preview masks both flags before this module can read
// them (see the boot masking in app.js), so no extra handling is needed
// here. Never gated on USERNODE_ENV — identical in staging and production.
//
// PUBLIC MODE (#860): the two sections carrying a `public: true` flag —
// Health & status and Node & chain — were publicly reachable as /status
// and /node-status before the fold, so they stay reachable for a
// signed-in NON-admin who follows an old link. app.js mounts the console
// in public mode for those, and _publicMode() below filters the menu down
// to just them and suppresses the view-only banner. The DATA boundary is
// entirely server-side: GET /api/status runs the payload through
// src/services/status.js redact(), which withholds worker progress, model
// names, spend, host load, stuck sessions and the event log from
// non-admins.

// ── AdminUI: shared class recipes, in the platform's widget language ────
// Data-only class-string constants used by this file and every admin-*.js
// section module. They used to depend on <script> ORDER for this object to
// exist — this file loaded first, the section modules read the global. Now
// that the console lives in the React bundle (#1082 chunk E) the dependency
// is a real `import { AdminUI } from './admin-console.js'` in each of them,
// which is also what makes the SSG prerender pass work: admin-topochain.js
// reads AdminUI.card at module-evaluation time, and in Node there is no
// `window` to have published it.
//
// THE CONSOLE SPEAKS THE SHELL'S LANGUAGE NOW. It used to be a second design
// system on purpose — gray neutrals and an indigo accent, matching
// ../topochain's admin verbatim, kept apart from the shell's zinc/violet by
// tests/admin-ui-registry.test.js. The widget-language reskin folded it in:
// same scales, same figure/ground, same filled controls, same radii.
//
// What survives is a RENDERING boundary, not a palette one, and that is why
// the registry still exists. The console draws with template literals and
// `innerHTML`; the shell draws with React components under
// @/components/ui/. You cannot interpolate a component into a template
// string, so the same vocabulary needs two forms — components there, class
// recipes here. The test still forbids the console from importing the
// shell's primitives, for exactly that reason.
//
// Every value is a COMPLETE class literal: Tailwind's extractor is a regex
// over the content globs (which now include frontend/src/**/*.js), and
// tests/admin-ui-registry.test.js + tests/tailwind-build.test.js enforce
// the discipline. Never index this registry dynamically.
export const AdminUI = Object.freeze({
  // Surfaces — a floating card: no border, no shadow, the language's radius.
  // The language separates by FIGURE/GROUND, so the card is the surface and
  // the hairline it used to trace is what the ground now does.
  card: 'bg-white dark:bg-zinc-900 rounded-2xl',
  cardHeader: 'flex items-center justify-between gap-2 mb-4',
  cardTitle: 'text-lg font-semibold text-zinc-900 dark:text-zinc-100',
  cardDescription: 'text-sm text-zinc-500 dark:text-zinc-400',
  // Tables — topochain data-table. NOTE: deliberately no sideways-scroll
  // utility on the wrapper — nothing in the console scrolls horizontally
  // (#860, pinned by admin-console-page.test.js, which regexes this file's
  // raw source).
  // A table inside a card needs no second box around it.
  tableWrap: 'w-full rounded-xl overflow-hidden',
  table: 'w-full text-sm',
  // No fill on the head: the column labels are already uppercase and muted,
  // and a tinted band inside a floating card reads as a second surface.
  thead: 'border-b border-zinc-200 dark:border-zinc-800',
  th: 'px-6 py-3 text-left align-middle text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400',
  td: 'px-6 py-4 align-middle',
  trHover: 'border-b border-zinc-100 dark:border-zinc-800/60 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
  // Buttons — topochain's canonical button strings.
  btn: Object.freeze({
    primary: 'bg-violet-600 hover:bg-violet-500 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium',
    // `outline` keeps its KEY and stops being an outline. The language draws
    // no outlined control — a filled neutral is its secondary, the same shape
    // the profile screen's buttons and every dialog's Cancel now take. The
    // key stays because 60-odd call sites name it, and renaming them would be
    // a diff with no rendered difference.
    //
    // zinc-100, not white: these sit ON a card, and white on white is the
    // invisible half of this palette. (On the page ground it is the reverse —
    // see the note on the browse detail page's pill.)
    outline: 'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-zinc-800 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors',
    destructive: 'bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium',
    ghost: 'font-medium transition-colors text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
    link: 'font-medium transition-colors text-violet-700 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300',
    primarySm: 'bg-violet-600 hover:bg-violet-500 text-white px-3 py-1.5 rounded-lg transition-colors text-xs font-medium',
    outlineSm: 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-zinc-800 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors',
    destructiveSm: 'bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-lg transition-colors text-xs font-medium',
  }),
  // Form controls — topochain's canonical input string (+ dark translation).
  input: 'w-full border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500',
  select: 'w-full border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500',
  textarea: 'w-full min-h-[80px] border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500',
  label: 'text-sm font-medium text-zinc-700 dark:text-zinc-300',
  // Badges — topochain's ring-tinted rounded-full pills.
  badge: Object.freeze({
    default: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-zinc-50 text-zinc-600 ring-1 ring-inset ring-zinc-500/10 dark:bg-zinc-500/10 dark:text-zinc-300 dark:ring-zinc-400/20',
    secondary: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-700/10 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/20',
    outline: 'inline-flex items-center rounded-full border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:text-zinc-300',
    destructive: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-50 text-red-700 ring-1 ring-inset ring-red-700/10 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20',
    success: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-700/10 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20',
    warn: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-700/10 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20',
  }),
  // Overlay — topochain modal: black/50 backdrop, xl-rounded white panel.
  dialogOverlay: 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4',
  dialogPanel: 'w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl p-6 shadow-xl',
  // Typography / misc.
  sectionTitle: 'text-lg font-semibold text-zinc-900 dark:text-zinc-100',
  muted: 'text-sm text-zinc-500 dark:text-zinc-400',
  // Loading — ONE spelling of "waiting for data" for the whole console. The
  // eleven programme screens draw a shaped placeholder (topochain/ui.tsx's
  // <Skeleton>, which the fetching row/table layouts earn); everywhere else
  // the wait is a single line, and it used to be spelled six different ways
  // — bare unstyled text, `text-xs` muted, a hand-written copy of `muted`,
  // `muted` itself with no ellipsis, and admin-node's EMPTY-state recipe
  // standing in for a load (#2448).
  //
  // `inline-flex` so one recipe serves both slots it lands in: a block <p>
  // of its own, and a <span> inside a summary paragraph that already exists
  // (rollover, staging-reap) — a <p> may not nest inside a <p>. The
  // `animate-pulse` is the tie to the skeleton: the same signal that this is
  // a wait and not a result, at the two densities the console draws at.
  loading: 'inline-flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400 animate-pulse',
  separator: 'border-t border-zinc-200 dark:border-zinc-800',
  kbd: 'rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-900 dark:text-zinc-100',
});

// Still published on the global: admin-topochain.js's sub-modules and a few
// section modules read `AdminUI` as a bare identifier inside functions, and
// the standalone /admin page's remaining scripts have never imported it.
// Guarded because the prerender pass evaluates this module in Node.
if (typeof window !== 'undefined') window.AdminUI = AdminUI;

// Which menu groups (Operations, Programme, People, Insights, Platform) the
// viewer has COLLAPSED, persisted per browser (#1152). Versioned key, same
// shape as Notifications' notif_expanded_groups_v1.
//
// The set stores the COLLAPSED names, not the expanded ones, and that
// inversion is load-bearing: SECTIONS has grown repeatedly (Push delivery,
// Email delivery, Estimator accuracy, Seasons), so "absent means expanded" is
// what keeps every future section visible to someone whose store predates it.
// It also makes "all four expanded on a first visit" the empty-store default.
const NAV_COLLAPSED_KEY = 'admin_nav_collapsed_groups_v1';

const AdminConsole = {
  _open: false,
  _section: 'overview',
  _menusWired: false,
  // Set by app.js when the console is mounted for a non-admin who
  // deep-linked one of the `public` sections. Never true for an admin.
  _public: false,
  // The section module (if any) currently rendered — used to call its
  // destroy() before swapping in the next one. See _renderSection.
  _activeModule: null,

  // ── Mobile two-level state ───────────────────────────────────────────
  // Which level the phone layout is showing: 1 = the section menu,
  // 2 = one section. Kept in sync on desktop too (it is ignored there)
  // so a viewport crossing resolves without guessing.
  _level: 1,
  // True while the level-2 entry we're sitting on was PUSHED by a menu
  // tap during this mount — the only case where history.back() is
  // guaranteed to land on our own menu entry. A deep link (bookmark, one
  // of the retired-page redirect stubs) leaves it false, and back
  // replaces the entry instead of creating a forward one. Per-mount
  // state: open() resets it, because the stack below the console stops
  // being ours to reason about the moment we leave.
  _pushedFromMenu: false,
  // #admin-screen scrollTop saved on drill-in, restored on the way back.
  _menuScrollTop: 0,
  _mediaBound: false,
  // True between an open({ chrome: false }) and the syncChrome() app.js
  // runs inside the screen transition (#979) — _syncChrome is a no-op
  // while it is set, so the platform header is never rewritten before the
  // View Transition has captured the page the viewer is leaving.
  _chromeSuspended: false,

  // The single source of truth in JS for where the sidebar layout starts.
  // Must stay in step with the `md:` classes in _renderShell (Tailwind's
  // md breakpoint IS 768px) — same discipline as AppView's
  // KANBAN_MULTICOL_MEDIA / _STAGING_DOCK_MEDIA.
  DESKTOP_MEDIA: '(min-width: 768px)',

  // In-SPA sections. Keys are the #admin/<key> hash segments; `group` is
  // the heading they sit under — in the desktop sidebar AND in the mobile
  // level-1 menu, which share _groupedSections(). Order here IS menu order.
  SECTIONS: [
    { key: 'overview', label: 'Overview', group: 'Operations' },
    // Health & status and Node & chain are the two `public` sections —
    // see the PUBLIC MODE note above.
    { key: 'status', label: 'Health & status', group: 'Operations', public: true },
    { key: 'node', label: 'Node & chain', group: 'Operations', public: true },
    { key: 'push', label: 'Push delivery', group: 'Operations' },
    { key: 'merges', label: 'Merge debug', group: 'Operations' },
    { key: 'rollover', label: 'Container rollover', group: 'Operations' },
    { key: 'staging-reap', label: 'Stale previews', group: 'Operations' },

    // Programme (#1179): what the programme IS — the seasons, the events
    // inside them, and the template library challenges are stamped out of.
    // These screens (and the People/Platform ones below marked #1179)
    // used to hide behind a single "Seasons, Events & Challenges" entry
    // with its own horizontal sub-nav; each is a first-class section now,
    // all still rendered by admin-topochain.js via SECTION_MODULES. The
    // module file name, the AdminTopochain global, the `topochain_`
    // settings-key prefix and the /api/v4/admin/* routes are historical
    // and deliberately unchanged. Season events still owns the tail
    // segments below its section (#admin/season-events/<eventId>
    // [/new-challenge[/<templateId>]]) — mirroring leaderboard.js's
    // _setSub/_syncHash pattern — so this file still needs no multi-level
    // routing. Maintenance campaigns does the same for
    // #admin/campaigns/<id>.
    { key: 'seasons', label: 'Seasons', group: 'Programme' },
    { key: 'season-events', label: 'Season events', group: 'Programme' },
    { key: 'challenge-templates', label: 'Challenge templates', group: 'Programme' },
    // The rules that credit challenges automatically, and the service
    // that applies them. Under Programme rather than Platform: it is
    // about what a season pays for, not about how the box is run.
    { key: 'challenge-scoring', label: 'Challenge scoring', group: 'Programme' },

    // The Users section carries BOTH user surfaces since #1179: the
    // platform accounts card (roles, quotas, caps) and the programme
    // users card (enrolment, podium/log settings, CSV import/export) —
    // one menu entry, merged. See features/admin/admin-users.tsx.
    // Support (#admin/support): one read-mostly screen per participant for
    // answering account, points, event and kudos questions. See
    // features/admin/admin-support.tsx.
    { key: 'support', label: 'Support', group: 'People' },
    { key: 'users', label: 'Users', group: 'People' },
    { key: 'reports', label: 'Reports', group: 'People' },
    { key: 'codes', label: 'Activation codes', group: 'People' },
    { key: 'limits', label: 'Spend limits', group: 'People' },
    // Programme people screens, promoted by the same #1179 reshuffle.
    { key: 'waitlist', label: 'Waitlist', group: 'People' },
    { key: 'onchain-accounts', label: 'Onchain accounts', group: 'People' },
    { key: 'user-activities', label: 'User activities', group: 'People' },
    // Read-only view over the testnet accounts' staking delegation
    // periods (the mobile app is the delegation actor; admins only look).
    { key: 'delegations', label: 'Delegations', group: 'People' },

    { key: 'analytics', label: 'Analytics', group: 'Insights' },
    // Estimator accuracy (#898): platform analytics, split out of the
    // Analytics section, which is otherwise entirely USER analytics.
    { key: 'estimator', label: 'Estimator accuracy', group: 'Insights' },
    { key: 'gallery', label: 'Screenshot gallery', group: 'Insights' },
    { key: 'features', label: 'Submitted features', group: 'Insights' },
    // The last full end-to-end sweep of the product against production.
    // A generated REPORT, not a runner — the counterpart to the unit and
    // dapp suites, which cover components rather than journeys.
    { key: 'e2e', label: 'E2E coverage', group: 'Insights' },

    { key: 'campaigns', label: 'Maintenance campaigns', group: 'Platform' },
    // The home screen's "Featured apps" row. NOT the `features` key
    // above — that one is "Submitted features" (user feature requests).
    { key: 'featured-apps', label: 'Featured apps', group: 'Platform' },
    { key: 'db-export', label: 'Database export', group: 'Platform' },
    // #2253: how much of its database each app is using against the
    // per-app cap, and the levers that undo a freeze.
    { key: 'storage', label: 'App storage', group: 'Platform' },
    // #2570: the note and the expected cost the model picker states for
    // each model, beside what changes on that model actually cost.
    { key: 'model-costs', label: 'Model costs', group: 'Platform' },
    // #2684: the Homeroom bot's shadow-mode verdicts — what it would have
    // asked or built on each open request — and the ratings that calibrate it.
    { key: 'homeroom-bot', label: 'Homeroom bot', group: 'Platform' },
    // Platform outbound mail: configuration, a test send, and the
    // delivery ledger. Separate from the programme's Settings section
    // (which keeps its own read-only status/activity card) because the
    // audience is every mail flow, not just the programme's.
    { key: 'mail', label: 'Email delivery', group: 'Platform' },
    // Programme operator tooling, promoted by #1179 — deliberately last:
    // these are the sharp ones (raw SQL, arbitrary API calls, the
    // settings that change how the mobile app behaves).
    { key: 'settings', label: 'Settings', group: 'Platform' },
    { key: 'app-version', label: 'App version', group: 'Platform' },
    { key: 'sql-console', label: 'SQL console', group: 'Platform' },
    { key: 'api-tester', label: 'API tester', group: 'Platform' },
  ],

  // Retired section keys that must keep resolving forever, so links and
  // bookmarks minted before a rename don't 404 into the fallback section.
  // Resolved at the two entry points (open/setSection) BEFORE visibility,
  // module lookup, nav highlighting or hash writing see the key, so the
  // rest of the file only ever deals in canonical keys. app.js rewrites
  // the address bar itself so the bookmark self-heals.
  LEGACY_SECTION_KEYS: {
    topochain: 'seasons',
  },

  // Heroicons v2 outline, one per section — same icon treatment as
  // ../topochain's admin sidebar (w-5 h-5, stroke-width 1.5). Path data is
  // copied from topochain's blade views where an equivalent icon exists.
  // Complete inline literals; the shell loads no cross-origin assets.
  NAV_ICONS: Object.freeze({
    'overview': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"/></svg>',
    'status': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    'node': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9"/></svg>',
    'push': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.08 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"/></svg>',
    'merges': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"/></svg>',
    'rollover': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12a7.5 7.5 0 0015 0m-15 0a7.5 7.5 0 1115 0m-15 0H3m16.5 0H21m-1.5 0H12m-8.457 3.077l1.41-.513m14.095-5.13l1.41-.513M5.106 17.785l1.15-.964m11.49-9.642l1.149-.964M7.501 19.795l.75-1.3m7.5-12.99l.75-1.3m-6.063 16.658l.26-1.477m2.605-14.772l.26-1.477m0 17.726l-.26-1.477M10.698 4.614l-.26-1.477M16.5 19.794l-.75-1.299M7.5 4.205L12 12m6.894 5.785l-1.149-.964M6.256 7.794l-1.15-.964"/></svg>',
    'staging-reap': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>',
    // Support: lifebuoy.
    'support': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.75"/><path stroke-linecap="round" stroke-linejoin="round" d="M5.64 5.64l3.7 3.7m5.32 5.32l3.7 3.7m0-12.72l-3.7 3.7m-5.32 5.32l-3.7 3.7"/></svg>',
    'users': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"/></svg>',
    'reports': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 3v18m0-16.5h13.5l-1.5 3 1.5 3H3"/></svg>',
    'codes': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>',
    'limits': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    'analytics': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"/></svg>',
    'estimator': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75"/></svg>',
    'gallery': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/></svg>',
    'features': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"/></svg>',
    // E2E coverage (#1862): clipboard-document-check — a checked-off report.
    'e2e': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M11.35 3.836c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m8.9-4.414c.376.023.75.05 1.124.08 1.131.094 1.976 1.057 1.976 2.192V16.5A2.25 2.25 0 0118 18.75h-2.25m-7.5-10.5H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V18.75m-7.5-10.5h6.375c.621 0 1.125.504 1.125 1.125v9.375m-8.25-3l1.5 1.5 3-3.75"/></svg>',
    'campaigns': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 01-1.44-4.282m3.102.069a18.03 18.03 0 01-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 018.835 2.535M10.34 6.66a23.847 23.847 0 008.835-2.535m0 0A23.74 23.74 0 0018.795 3m.38 1.125a23.91 23.91 0 011.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 001.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 010 3.46"/></svg>',
    'featured-apps': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"/></svg>',
    'db-export': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"/></svg>',
    'storage': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z"/></svg>',
    // Model costs (#2570): currency-dollar — the screen is about what a
    // change on each model costs.
    'model-costs': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    'homeroom-bot': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z"/></svg>',
    'mail': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"/></svg>',
    'seasons': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 012.916.52 6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0"/></svg>',
    'season-events': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"/></svg>',
    'challenge-templates': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 00-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 01-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 00.657-.643v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 01-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959v0c0 .333.277.599.61.58a48.1 48.1 0 005.427-.63 48.05 48.05 0 00.582-4.717.532.532 0 00-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.96.401v0a.656.656 0 00.658-.663 48.422 48.422 0 00-.37-5.36c-1.886.342-3.81.574-5.766.689a.578.578 0 01-.61-.58v0z"/></svg>',
    'challenge-scoring': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 15.75V18m-7.5-6.75h.008v.008H8.25v-.008zm0 2.25h.008v.008H8.25V13.5zm0 2.25h.008v.008H8.25v-.008zm0 2.25h.008v.008H8.25V18zm2.498-6.75h.007v.008h-.007v-.008zm0 2.25h.007v.008h-.007V13.5zm0 2.25h.007v.008h-.007v-.008zm0 2.25h.007v.008h-.007V18zm2.504-6.75h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V13.5zm0 2.25h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V18zm2.498-6.75h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V13.5zM8.25 6h7.5v2.25h-7.5V6zM12 2.25c-1.892 0-3.758.11-5.593.322C5.307 2.7 4.5 3.65 4.5 4.757V19.5a2.25 2.25 0 002.25 2.25h10.5a2.25 2.25 0 002.25-2.25V4.757c0-1.108-.806-2.057-1.907-2.185A48.507 48.507 0 0012 2.25z"/></svg>',
    'waitlist': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    'onchain-accounts': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z"/></svg>',
    'user-activities': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"/></svg>',
    'delegations': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"/></svg>',
    'settings': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
    'app-version': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3"/></svg>',
    'sql-console': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z"/></svg>',
    'api-tester': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>',
  }),

  _canonicalSection(key) {
    return (key && AdminConsole.LEGACY_SECTION_KEYS[key]) || key;
  },

  isOpen() { return AdminConsole._open; },

  // Below the sidebar breakpoint — i.e. the two-level layout is live.
  // Anything that can't answer (no matchMedia) is treated as desktop, so
  // a browser without it keeps today's behaviour rather than a phone
  // layout it never asked for.
  _isMobile() {
    try { return !window.matchMedia(AdminConsole.DESKTOP_MEDIA).matches; }
    catch { return false; }
  },

  // One-time viewport listener: crossing the breakpoint re-resolves the
  // layout in place. Crossing UP renders the active section in the
  // sidebar shell; crossing DOWN keeps that section as level 2 (no menu
  // flash) and writes its explicit hash so the address matches what's on
  // screen. Lazy-bound like AppView._ensureStagingDockListeners.
  _ensureMediaListener() {
    if (AdminConsole._mediaBound || !window.matchMedia) return;
    try {
      const mql = window.matchMedia(AdminConsole.DESKTOP_MEDIA);
      const onChange = () => {
        if (!AdminConsole._open) return;
        // A real section is showing (or was, on desktop) → keep it as
        // level 2 on the way down. Only a menu-level mobile view, or a
        // desktop view sitting on the bare #admin overview, lands on 1.
        if (!mql.matches && AdminConsole._level !== 1) {
          AdminConsole._writeHash(AdminConsole._section);
        }
        AdminConsole._renderShell();
        AdminConsole._renderContent();
        AdminConsole._syncChrome();
      };
      if (mql.addEventListener) mql.addEventListener('change', onChange);
      else if (mql.addListener) mql.addListener(onChange);
      AdminConsole._mediaBound = true;
    } catch { /* no matchMedia — desktop path stands */ }
  },

  // True while the console is mounted for a non-admin on a `public`
  // section. Belt-and-braces: also require the absence of isAdmin, so a
  // stale flag can never narrow an admin's own menu.
  _publicMode() {
    return !!AdminConsole._public && !(window.App && App.user && App.user.isAdmin);
  },

  // The sections the current viewer may navigate to.
  _visibleSections() {
    return AdminConsole._publicMode()
      ? AdminConsole.SECTIONS.filter((s) => s.public)
      : AdminConsole.SECTIONS;
  },

  // Single write gate for every mutating control on the page. View-only
  // admins (is_admin && admin_readonly) carry isAdmin but not
  // canAdminWrite — they see everything read-only.
  canWrite() { return !!(window.App && App.user && App.user.canAdminWrite); },

  // `opts.public` is set by app.js when a non-admin deep-linked one of the
  // `public` sections; it must be resolved BEFORE the first _renderShell so
  // the menu is filtered on the very first paint.
  //
  // `opts.chrome === false` renders WITHOUT touching the platform header
  // (#979): the console renders into a still-hidden #admin-screen, which
  // is invisible, but the header title / back icon are not — writing them
  // before the screen transition starts bakes the incoming console's
  // chrome into the snapshot of the page being left. app.js calls
  // AdminConsole.syncChrome() inside the transition callback instead.
  open(section, opts) {
    AdminConsole._open = true;
    AdminConsole._public = !!(opts && opts.public);
    AdminConsole._pushedFromMenu = false;
    AdminConsole._chromeSuspended = !!(opts && opts.chrome === false);
    AdminConsole._menuScrollTop = 0;
    AdminConsole._ensureMediaListener();
    section = AdminConsole._canonicalSection(section);
    const visible = AdminConsole._visibleSections();
    const valid = visible.some((s) => s.key === section);
    // In public mode, fall back to the first PUBLIC section rather than
    // Overview (which the viewer can't see) — and never resurrect a
    // last-visited admin section from an earlier admin login in this tab.
    const fallback = AdminConsole._publicMode()
      ? (visible.some((s) => s.key === AdminConsole._section) ? AdminConsole._section : visible[0]?.key)
      : (AdminConsole._section || 'overview');
    // On mobile, a bare #admin means the MENU — never a last-visited
    // section resurrected from earlier in this tab. On desktop it keeps
    // meaning Overview (or the last section), exactly as before.
    if (AdminConsole._isMobile() && !valid) {
      AdminConsole._level = 1;
      AdminConsole._section = fallback;
      // This branch repaints without going through setSection, so the
      // arrival rule has to be applied here too (#1152).
      AdminConsole._ensureActiveGroupExpanded();
      AdminConsole._renderShell();
      AdminConsole._renderContent();
      AdminConsole._syncChrome();
      return;
    }
    AdminConsole._level = 2;
    AdminConsole._renderShell();
    // Deep-linked section wins; otherwise keep the last-visited section
    // (instant repaint on re-entry), defaulting to Overview.
    AdminConsole.setSection(valid ? section : fallback, { writeHash: false });
    // Runs after app.js's own setHeaderTitle, so on a mobile deep link the
    // header ends up showing the section's name rather than the console's.
    AdminConsole._syncChrome();
  },

  close() {
    AdminConsole._open = false;
    AdminConsole._public = false;
    AdminConsole._pushedFromMenu = false;
    // Tear the active section's timers/listeners down: leaving the console
    // must not leave a 5s /api/status or 2s /api/node-status poll running
    // for the life of the tab (see _teardownActiveSection).
    AdminConsole._teardownActiveSection();
  },

  // Re-entry while the console is ALREADY mounted (app.js routes here
  // instead of re-running the whole screen swap — see
  // navigateToAdminConsole). Resolves the target level from the requested
  // section, picks the transition direction by comparing it to the level
  // we're on, and repaints. On desktop this is just setSection.
  //
  // IDEMPOTENT (#1102), for the same reason Settings.route is — this is a
  // copy of the same two-level router, over an already-VISIBLE screen root.
  // One history traversal fires popstate AND hashchange, so restoreFromHash
  // runs twice in one tick and this is called twice with the same section;
  // the second call resolves the same level, asks for 'none', and the kit
  // runs 'none' SYNCHRONOUSLY — landing the level swap before the first
  // call's pending View Transition captured the outgoing page, so the
  // animation played two copies of the incoming page. Resolve the target
  // first and bail out when it is already on screen.
  route(section, opts) {
    // Applied before the comparison: _visibleSections() reads it, so the
    // public-mode flag decides what "the same target" even means.
    if (opts && typeof opts.public === 'boolean') AdminConsole._public = !!opts.public;
    const visible = AdminConsole._visibleSections();
    const valid = !!section && visible.some((s) => s.key === section);
    const mobile = AdminConsole._isMobile();
    // The level and section this call WOULD end on. Level 1 keeps whatever
    // section sits behind the menu, so there the level is the whole target.
    const targetLevel = (!mobile || valid) ? 2 : 1;
    const targetSection = valid
      ? section
      : (mobile
        ? AdminConsole._section
        : (AdminConsole._publicMode() ? (visible[0]?.key || 'status') : 'overview'));
    if (targetLevel === AdminConsole._level && targetSection === AdminConsole._section) {
      AdminConsole._reapplySectionHash();
      return;
    }
    if (!mobile) {
      // Desktop: bare #admin is Overview, as it has always been.
      AdminConsole.setSection(targetSection, { writeHash: false });
      AdminConsole._level = 2;
      AdminConsole._syncChrome();
      return;
    }
    // 1→2 push, 2→1 pop, same level (section→section deep link) instant:
    // the kit's fidelity rule is no animation on same-level repaints.
    const type = targetLevel === AdminConsole._level
      ? 'none'
      : (targetLevel === 2 ? 'push' : 'pop');
    if (targetLevel === 2) {
      AdminConsole._menuScrollTop = AdminConsole._level === 1
        ? AdminConsole._scrollTop()
        : AdminConsole._menuScrollTop;
      AdminConsole._section = section;
    } else {
      AdminConsole._pushedFromMenu = false;
    }
    AdminConsole._level = targetLevel;
    AdminConsole._transition(() => {
      // Mobile drill-in / pop repaints without setSection — same arrival
      // rule, applied before the menu and sidebar are rebuilt (#1152).
      AdminConsole._ensureActiveGroupExpanded();
      AdminConsole._renderShell();
      AdminConsole._renderContent();
      AdminConsole._syncChrome();
      AdminConsole._restoreScroll();
    }, type);
  },

  // The address this console last rendered itself from, recorded AFTER the
  // render so it holds whatever the section module healed the hash to (both
  // AdminTopochain and AdminCampaigns own a second level below the section
  // segment and replaceState it back themselves). Compared, not merely
  // remembered — see _reapplySectionHash.
  _routedHash: null,

  _markRouted() {
    AdminConsole._routedHash = location.hash;
  },

  // #1146: the level+section bail-out above is a guard against ONE dispatch
  // arriving twice, not a statement that the address hasn't moved. Sections
  // that own a second hash level are addressed by a tail the comparison
  // above cannot see — #admin/season-events, #admin/season-events/12 and
  // #admin/season-events/12/new-challenge/3 all resolve to level 2,
  // section 'season-events' — so a switch BETWEEN two of those siblings
  // used to return here without repainting, leaving the previous tail's
  // screen up.
  // Cold loading hid it (the module reads the address in render()); a
  // sibling-fragment hash switch, which is how the grouped capture runner
  // reaches every cohort of a document, does not.
  //
  // Re-running _renderSection() is exactly the cold-load path: it tears the
  // section down and calls the module's render(), which re-reads the hash
  // and resets whatever the tail no longer names. Gated on the address
  // having actually CHANGED since the last render, which is what preserves
  // the #1102 guard — a traversal's popstate and hashchange carry the same
  // hash, so the second of the pair still bails out.
  _reapplySectionHash() {
    if (AdminConsole._routedHash === location.hash) return;
    // Mark before as well as after: the render below replaceStates the
    // healed address, and a mark-only-after would leave a window in which a
    // re-entrant call saw the stale value.
    AdminConsole._markRouted();
    // Level 1 on mobile is the menu, not a section — nothing below the
    // #admin segment is addressing anything there.
    if (AdminConsole._isMobile() && AdminConsole._level === 1) return;
    AdminConsole._renderSection();
    AdminConsole._markRouted();
  },

  // The on-screen back arrow AND the platform header's back button both
  // land here (app.js:back-btn). Returns true when the press was consumed
  // — i.e. mobile, inside a section — so the header falls through to
  // navigateHome() everywhere else (all of desktop included).
  handleBack() {
    if (!AdminConsole._open) return false;
    if (!AdminConsole._isMobile() || AdminConsole._level !== 2) return false;
    if (AdminConsole._pushedFromMenu) {
      // We pushed that entry ourselves, so the one below it IS our menu:
      // popping routes back through popstate → restoreFromHash → route(),
      // the same path the device back gesture takes.
      history.back();
      return true;
    }
    // Deep link / redirect stub: nothing of ours below. REPLACE the entry
    // with the menu rather than pushing one, so back can't bounce the
    // viewer between the section and the menu forever.
    try { history.replaceState(null, '', '#admin'); } catch { /* non-fatal */ }
    AdminConsole._level = 1;
    AdminConsole._transition(() => {
      AdminConsole._renderShell();
      AdminConsole._renderContent();
      AdminConsole._syncChrome();
      AdminConsole._restoreScroll();
    }, 'pop');
    return true;
  },

  // Drill-in from a level-1 menu row. A REAL hash navigation (the
  // leaderboard profile drill-in precedent) so the pushed entry makes the
  // browser / WebView back gesture work for free; restoreFromHash routes
  // it back into route() a tick later. Assigning location.hash preserves
  // the query string, so ?demo=1 survives the drill-in.
  _openSection(key) {
    AdminConsole._menuScrollTop = AdminConsole._scrollTop();
    AdminConsole._pushedFromMenu = true;
    const target = `#admin/${key}`;
    if (location.hash === target) {
      // Same-value assignment fires no hashchange — route by hand.
      AdminConsole.route(key);
      return;
    }
    location.hash = target;
  },

  _transition(fn, type) {
    if (window.PlatformUI?.transition) PlatformUI.transition(fn, { type: type || 'none' });
    else fn();
  },

  _scrollTop() {
    const el = document.getElementById('admin-screen');
    return el ? el.scrollTop : 0;
  },

  // A pushed screen starts at the top; a pop restores where the menu was.
  _restoreScroll() {
    const el = document.getElementById('admin-screen');
    if (!el) return;
    el.scrollTop = (AdminConsole._isMobile() && AdminConsole._level === 1)
      ? AdminConsole._menuScrollTop
      : 0;
  },

  // Platform-header chrome for the current level: inside a mobile section
  // the header becomes that section's nav bar (arrow + section name),
  // everywhere else it stays the console's own title and the home icon.
  // setHeaderTitle mirrors into document.title, so the native shell's
  // AppBar picks the section name up too.
  // The public half of _syncChrome: clears the suspension a
  // `chrome: false` open() set and applies the chrome for real. app.js
  // calls this INSIDE the screen transition's callback (#979).
  syncChrome() {
    AdminConsole._chromeSuspended = false;
    AdminConsole._syncChrome();
  },

  _syncChrome() {
    if (!window.App || AdminConsole._chromeSuspended) return;
    const inSection = AdminConsole._isMobile() && AdminConsole._level === 2;
    // #1036: the header control is a real anchor — inside a section the
    // chevron pops to the console's own menu, so that is its href. LEVEL 2
    // ONLY, exactly as in features/settings/settings.js: see the note there
    // and beside App.navigateToProfile.
    //
    // ALWAYS AN ARROW SINCE #2718's REVIEW, and the target is the level.
    // The root used to draw the house, which was the right answer while
    // Admin was reached from Home's account row; it is reached from the Me
    // tab now, and a house there sent you past the screen you came from to
    // one the bar's own Home tab already reaches. The two targets are the
    // two levels above: the console menu from inside a section, the Me tab
    // from the root. This must agree with App._BACK_SLOT['admin-screen'],
    // which the screen reveal writes a moment earlier — this is the second
    // writer and the later one wins (tests/header-back-home.test.js derives
    // the two from each other).
    if (App.setBackIcon) App.setBackIcon('arrow', inSection ? '#admin' : '#profile');
    if (!App.setHeaderTitle) return;
    if (inSection) {
      const s = AdminConsole._visibleSections().find((x) => x.key === AdminConsole._section);
      App.setHeaderTitle(s ? s.label : 'Admin & moderation');
    } else {
      App.setHeaderTitle(AdminConsole._publicMode() ? 'Platform status' : 'Admin & moderation');
    }
  },

  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  // Safe fetch+parse for the admin endpoints (ported from
  // public/admin.html). Returns { status, ok, data } and NEVER throws: a
  // non-OK response, a non-JSON content-type, or a body that fails to
  // parse all yield data === null. This matters when an /api/* route
  // falls through to the SPA shell on auth loss and returns 200 + HTML —
  // res.json() on that throws "Unexpected token '<'".
  async fetchJson(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return { status: res.status, ok: false, data: null };
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        return { status: res.status, ok: true, data: null };
      }
      try {
        return { status: res.status, ok: true, data: await res.json() };
      } catch {
        return { status: res.status, ok: true, data: null };
      }
    } catch {
      return { status: 0, ok: false, data: null };
    }
  },

  // The DB and API are cents-native; the UI presents dollars. Convert at
  // the edge only (ported from public/admin.html).
  centsToDollars(c) {
    return (Number(c) / 100).toFixed(2);
  },
  parseDollarsToCents(label, raw) {
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${label} must be a non-negative dollar amount or blank.`);
    }
    return Math.round(n * 100);
  },

  _alert(message) {
    if (window.PlatformUI?.alert) {
      PlatformUI.alert({ title: 'Admin', message: String(message) });
    } else {
      try { window.alert(message); } catch {}
    }
  },

  async _confirm(opts) {
    if (window.PlatformUI?.confirm) return PlatformUI.confirm(opts);
    try {
      return window.confirm([opts.title, opts.message].filter(Boolean).join('\n\n'));
    } catch { return false; }
  },

  // ── Menu group collapse state (#1152) ─────────────────────────────────

  // The COLLAPSED group names, lazily loaded from localStorage on first
  // read. Both menu builders regenerate their markup from THIS on every
  // repaint and neither derives anything from the DOM, so a toggle survives
  // a section switch, a viewport crossing and a reload identically.
  _collapsedGroups: null,

  _collapsed() {
    if (!AdminConsole._collapsedGroups) AdminConsole._loadCollapsedGroups();
    return AdminConsole._collapsedGroups;
  },

  // Corrupt, foreign or unavailable storage all resolve to "nothing
  // collapsed": this runs inside a render path, so it must never throw.
  _loadCollapsedGroups() {
    AdminConsole._collapsedGroups = new Set();
    // Only render/toggle paths reach here, but the guard sits next to the
    // storage read regardless — the prerender pass evaluates this module in
    // Node, where there is no localStorage (see the window.AdminUI guard).
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(NAV_COLLAPSED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return;
      // Prune names no SECTIONS entry carries any more, so the store can't
      // grow unbounded and a RENAMED group resets to expanded — the safe
      // direction, since a stale entry would hide live rows.
      const live = new Set(AdminConsole.SECTIONS.map((s) => s.group || 'Other'));
      let changed = false;
      for (const name of arr) {
        const key = String(name);
        if (live.has(key)) AdminConsole._collapsedGroups.add(key);
        else changed = true;
      }
      if (changed) AdminConsole._saveCollapsedGroups();
    } catch {
      AdminConsole._collapsedGroups = new Set();
    }
  },

  _saveCollapsedGroups() {
    try {
      localStorage.setItem(
        NAV_COLLAPSED_KEY,
        JSON.stringify([...AdminConsole._collapsed()])
      );
    } catch { /* storage may be unavailable; non-fatal, in-memory for the session */ }
  },

  _isGroupCollapsed(name) {
    return AdminConsole._collapsed().has(String(name));
  },

  _setGroupCollapsed(name, collapsed) {
    const set = AdminConsole._collapsed();
    const key = String(name);
    if (collapsed) set.add(key);
    else set.delete(key);
    AdminConsole._saveCollapsedGroups();
  },

  // "Never hide where I am": arriving at a section reveals its group, so a
  // deep link into a collapsed group (a bookmark, one of the retired-page
  // redirect stubs) can't leave the highlighted row invisible. Called
  // BEFORE the repaint that follows it, and only on ARRIVAL — deliberately
  // not enforced continuously, or the group you are using would be the one
  // group you cannot collapse.
  _ensureActiveGroupExpanded() {
    const s = AdminConsole._visibleSections().find((x) => x.key === AdminConsole._section);
    if (!s) return;
    const name = String(s.group || 'Other');
    const set = AdminConsole._collapsed();
    if (!set.has(name)) return;
    set.delete(name);
    AdminConsole._saveCollapsedGroups();
  },

  // aria-controls targets have to be unique, and at phone width the hidden
  // desktop sidebar and the level-1 menu are BOTH in the document — hence
  // one id prefix per surface ('admin-nav-group', 'admin-menu-group').
  _groupDomId(prefix, name) {
    return `${prefix}-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  },

  // The heading affordance both menus share: a real <button>, so Tab plus
  // Enter/Space come for free and no keydown handler is needed, with the
  // aria-expanded/aria-controls pair and the platform's chevron idiom
  // (down when open, right when closed — home-panels.js's rotation trick).
  _groupToggleHtml(name, domId, collapsed, cls) {
    const label = `${collapsed ? 'Expand' : 'Collapse'} ${name}`;
    const chevron = `<svg data-admin-group-chevron aria-hidden="true"
        class="w-3 h-3 shrink-0 transition-transform${collapsed ? ' -rotate-90' : ''}"
        fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>`;
    return `<button type="button" data-admin-group-toggle="${AdminConsole.esc(name)}"
        aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${domId}"
        title="${AdminConsole.esc(label)}" aria-label="${AdminConsole.esc(label)}"
        class="${cls}">${chevron}<span class="flex-1 min-w-0 truncate">${AdminConsole.esc(name)}</span></button>`;
  },

  // ── Shell: menu (sidebar / mobile list) + content host ────────────────

  // The visible sections bucketed by `group`, in first-appearance order.
  // Shared by the desktop sidebar and the mobile level-1 menu so the two
  // can never drift into different groupings.
  _groupedSections() {
    const groups = [];
    for (const s of AdminConsole._visibleSections()) {
      const name = s.group || 'Other';
      let g = groups.find((x) => x.name === name);
      if (!g) { g = { name, items: [] }; groups.push(g); }
      g.items.push(s);
    }
    return groups;
  },

  // Desktop sidebar rows, grouped under headings. Nineteen flat rows is a
  // lot to scan; the headings are the mitigation, and since #1152 each one
  // is a collapse/expand button whose state persists per browser.
  _navItemsHtml() {
    const active = AdminConsole._section;
    const itemHtml = (s) => {
      const isActive = s.key === active;
      const cls = 'admin-nav-item flex items-center gap-3 w-full text-left rounded-md px-3 py-2.5 text-sm font-medium transition-colors '
        + (isActive
          ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
          : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/60');
      // Section links of the sidebar's <nav>, the current one marked
      // aria-current (QA 2026-09-24 Q20). They used to be tabs with no
      // tablist around them, and a tablist may not hold the group headings.
      return `<button type="button"${isActive ? ' aria-current="page"' : ''}
        data-admin-section="${s.key}" class="${cls}">${AdminConsole.NAV_ICONS[s.key] || ''}<span class="flex-1 min-w-0 truncate">${AdminConsole.esc(s.label)}</span></button>`;
    };
    return AdminConsole._groupedSections().map((g, i) => {
      // Rendered from the persisted set, never from the DOM — so this
      // wholesale repaint (it runs on every section switch) reproduces
      // whatever the viewer collapsed.
      const collapsed = AdminConsole._isGroupCollapsed(g.name);
      const domId = AdminConsole._groupDomId('admin-nav-group', g.name);
      // No spacing utility on the items wrapper: the rows were adjacent
      // before this became a wrapped group, and they stay adjacent.
      return `
      <div class="${i === 0 ? '' : 'mt-6'}">
        ${AdminConsole._groupToggleHtml(g.name, domId, collapsed,
          'flex items-center gap-1.5 w-full text-left px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors')}
        <div id="${domId}" data-admin-group="${AdminConsole.esc(g.name)}"${collapsed ? ' class="hidden"' : ''}>
          ${g.items.map(itemHtml).join('')}
        </div>
      </div>`;
    }).join('');
  },

  // Mobile level 1: the section menu. A list, not a tab set — so plain
  // buttons in a <nav>, no role="tab"/aria-selected, and the drawer-row
  // idiom from index.html (44px minimum, hairline between rows, chevron
  // on the right) rather than the kit's inset-grouped card, which would
  // read as a foreign surface next to the rest of the platform.
  _mobileMenuHtml() {
    const chevron = `<svg class="w-4 h-4 shrink-0 text-zinc-500 dark:text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>`;
    const rowHtml = (s) => `
      <button type="button" data-admin-section="${s.key}"
              class="admin-menu-row flex items-center gap-3 w-full text-left min-h-[44px] px-4 py-2
                     border-b border-zinc-100 dark:border-zinc-800
                     text-zinc-700 dark:text-zinc-200
                     hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors">
        <span class="text-zinc-500 dark:text-zinc-500">${AdminConsole.NAV_ICONS[s.key] || ''}</span>
        <span class="flex-1 min-w-0 text-sm font-medium truncate">${AdminConsole.esc(s.label)}</span>
        ${chevron}
      </button>`;
    // The toggle stays OUTSIDE the card, so [&>button:last-child] keeps
    // meaning "the last section row" rather than picking up a heading.
    const groups = AdminConsole._groupedSections().map((g) => {
      const collapsed = AdminConsole._isGroupCollapsed(g.name);
      const domId = AdminConsole._groupDomId('admin-menu-group', g.name);
      return `
      <div class="mb-5">
        ${AdminConsole._groupToggleHtml(g.name, domId, collapsed,
          'flex items-center gap-1.5 w-full text-left px-4 pb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500')}
        <div id="${domId}" data-admin-group="${AdminConsole.esc(g.name)}"
             class="${AdminUI.card} overflow-hidden
                    [&>button:last-child]:border-b-0${collapsed ? ' hidden' : ''}">
          ${g.items.map(rowHtml).join('')}
        </div>
      </div>`;
    }).join('');
    return `<nav id="admin-mobile-menu" aria-label="Admin sections" class="-mx-4">${groups}</nav>`;
  },

  // Repaint the chassis's two variable parts. React owns the chassis MARKUP
  // (./index.tsx), which is why this no longer touches root.innerHTML: the
  // nav host and the banner are the only things about it that depend on who
  // is looking, and both were already repainted in place on every section
  // switch (see setSection). The name is kept because eight call sites and
  // the mobile transition callbacks read as "repaint the shell".
  //
  // #admin-nav-desktop ships EMPTY, exactly as #settings-nav-desktop does:
  // React hydrates an empty host and never looks inside it again, so the
  // innerHTML write below is not a write into React-owned DOM.
  _renderShell() {
    const sideHost = document.getElementById('admin-nav-desktop');
    if (sideHost) {
      sideHost.innerHTML = AdminConsole._navItemsHtml();
      // Scoped to the sidebar, where the old whole-root wire was scoped to a
      // subtree this function had just emptied. It has to be: #admin-root is
      // no longer wiped here, so wiring the whole root would ALSO re-bind the
      // level-1 menu buttons still sitting in #admin-section-content, one
      // extra click handler per repaint. The other two [data-admin-section]
      // producers wire their own output — _renderMobileMenu right after its
      // innerHTML write, and each section module for its own controls.
      AdminConsole._wireSectionButtons(sideHost);
      AdminConsole._wireGroupToggles(sideHost);
    }
    // In public mode the viewer isn't an admin at all, so the view-only
    // ADMIN banner would be nonsense — suppress it rather than showing an
    // amber "you can't make changes" strip to a regular member.
    const viewOnly = !AdminConsole.canWrite() && !AdminConsole._publicMode();
    const banner = document.getElementById('admin-view-only-banner');
    // classList, not a rendered className: the banner is a static React node
    // and its class attribute must be written once at hydration and then
    // only ever toggled from here (the useHiddenClass contract).
    if (banner) banner.classList.toggle('hidden', !viewOnly);
  },

  // Every [data-admin-section] control routes through here. On mobile a
  // press is a DRILL-IN (a real hash navigation that pushes history); on
  // desktop it's the same in-place sidebar switch it has always been.
  _wireSectionButtons(root) {
    if (!root) return;
    root.querySelectorAll('[data-admin-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.adminSection;
        if (AdminConsole._isMobile()) AdminConsole._openSection(key);
        else AdminConsole.setSection(key);
      });
    });
  },

  // Menu-group headings (#1152). A press is a MENU-ONLY action: it mutates
  // the persisted set and then the DOM IN PLACE — never setSection,
  // _renderShell, _renderContent, _writeHash or location.hash. Three
  // reasons: the section on screen keeps rendering untouched, a phone
  // repaint would tear the menu's own rows down mid-gesture, and focus
  // stays on the heading you just pressed so several can be collapsed in a
  // row. Scoped to the host just written, exactly like _wireSectionButtons,
  // so repaints can't accumulate handlers.
  _wireGroupToggles(root) {
    if (!root) return;
    root.querySelectorAll('[data-admin-group-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.adminGroupToggle;
        const next = !AdminConsole._isGroupCollapsed(name);
        AdminConsole._setGroupCollapsed(name, next);
        btn.setAttribute('aria-expanded', next ? 'false' : 'true');
        const label = `${next ? 'Expand' : 'Collapse'} ${name}`;
        btn.setAttribute('title', label);
        btn.setAttribute('aria-label', label);
        const chevron = btn.querySelector('[data-admin-group-chevron]');
        if (chevron) chevron.classList.toggle('-rotate-90', next);
        // `hidden` takes the rows out of tab order too, so tabbing skips a
        // collapsed group rather than walking invisible buttons.
        const id = btn.getAttribute('aria-controls');
        const items = id && document.getElementById(id);
        if (items) items.classList.toggle('hidden', next);
      });
    });
  },

  setSection(key, opts) {
    key = AdminConsole._canonicalSection(key);
    const visible = AdminConsole._visibleSections();
    if (!visible.some((s) => s.key === key)) {
      key = AdminConsole._publicMode() ? (visible[0]?.key || 'status') : 'overview';
    }
    AdminConsole._section = key;
    // Arrival at a section reveals its group, before the repaint that would
    // otherwise draw the active row inside a collapsed one (#1152).
    AdminConsole._ensureActiveGroupExpanded();
    // Repaint the sidebar's active state. This used to be the "the shell is
    // already built" half of a branch whose other half rebuilt #admin-root
    // from scratch; the chassis is React's now, so it always exists and
    // _renderShell IS this repaint.
    AdminConsole._renderShell();
    if (!opts || opts.writeHash !== false) AdminConsole._writeHash(key);
    AdminConsole._renderSection();
    // Recorded after the render, so it holds whatever the section module
    // healed the address to. See _reapplySectionHash.
    AdminConsole._markRouted();
  },

  // Section switches update the address without polluting history —
  // replaceState, and only while we're actually on the #admin route (the
  // Leaderboard._setSub pattern). Entering/leaving the page still gets a
  // real history entry via normal hash navigation.
  //
  // Sections that own a second hash level (seasons, campaigns) are left
  // alone once we're already inside them, so their own replaceState isn't
  // fought over on every repaint.
  //
  // Mobile writes #admin/overview rather than bare #admin: down here a
  // bare #admin means the MENU, so Overview needs an explicit segment to
  // stay distinguishable (and deep-linkable) from level 1. Desktop keeps
  // the historical overview → #admin mapping.
  _writeHash(key) {
    const target = (key === 'overview' && !AdminConsole._isMobile())
      ? '#admin'
      : `#admin/${key}`;
    if (location.hash.startsWith(`${target}/`)) return;
    if (location.hash.startsWith('#admin') && location.hash !== target) {
      history.replaceState(null, '', target);
    }
  },

  // Sections whose content is owned by a separate module (#860). Each
  // exposes render(host) / destroy(); destroy() is what stops their
  // polling when you navigate away. Resolved lazily by name so a module
  // that failed to load degrades to a message instead of a crash.
  SECTION_MODULES: {
    // `overview` is also the console's DEFAULT section — see the `default:`
    // arm of _renderSection, which dispatches through the same helper.
    overview: 'AdminOverview',
    codes: 'AdminCodes',
    'featured-apps': 'AdminFeaturedApps',
    'db-export': 'AdminDbExport',
    storage: 'AdminStorage',
    'model-costs': 'AdminModelCosts',
    'homeroom-bot': 'AdminHomeroomBot',
    features: 'AdminFeatures',
    limits: 'AdminLimits',
    support: 'AdminSupport',
    users: 'AdminUsers',
    reports: 'AdminReports',
    rollover: 'AdminRollover',
    'staging-reap': 'AdminStagingReap',
    status: 'AdminStatus',
    node: 'AdminNode',
    analytics: 'AdminAnalytics',
    estimator: 'AdminEstimator',
    merges: 'AdminMerges',
    gallery: 'AdminGallery',
    campaigns: 'AdminCampaigns',
    mail: 'AdminMail',
    push: 'AdminPush',
    e2e: 'AdminE2E',
    // The ten promoted programme screens (#1179) all render through
    // admin-topochain.js — the section key names the screen, and the
    // module reads it back in its render(). The programme's Users screen
    // is the one exception: it is merged into the Users section, which
    // embeds AdminTopochain.renderUsers in a host of its own
    // (features/admin/admin-users.tsx).
    seasons: 'AdminTopochain',
    'season-events': 'AdminTopochain',
    'challenge-templates': 'AdminTopochain',
    'challenge-scoring': 'AdminTopochain',
    waitlist: 'AdminTopochain',
    'onchain-accounts': 'AdminTopochain',
    'user-activities': 'AdminTopochain',
    delegations: 'AdminTopochain',
    settings: 'AdminTopochain',
    'app-version': 'AdminTopochain',
    'sql-console': 'AdminTopochain',
    'api-tester': 'AdminTopochain',
  },

  // Stop the outgoing section's background work before its DOM is replaced.
  // Without this, Health & status keeps polling /api/status every 5s (which
  // shells out to `docker stats` server-side) and Node & chain keeps polling
  // every 2s, for the rest of the tab's life.
  _teardownActiveSection() {
    const mod = AdminConsole._activeModule;
    AdminConsole._activeModule = null;
    if (mod && typeof mod.destroy === 'function') {
      try { mod.destroy(); } catch (err) { console.error('admin section destroy failed', err); }
    }
  },

  // The single dispatcher for what goes in the content host: the mobile
  // level-1 menu, or a section. Everything that changes level goes through
  // here so the teardown below can't be skipped.
  _renderContent() {
    if (AdminConsole._isMobile() && AdminConsole._level === 1) {
      const host = document.getElementById('admin-section-content');
      if (!host) return;
      // Leaving a section for the menu MUST tear it down: otherwise a back
      // press out of Health & status leaves its 5s /api/status poll (which
      // shells out to `docker stats` server-side) running for the life of
      // the tab — exactly the leak #860's lifecycle work fixed.
      AdminConsole._teardownActiveSection();
      AdminConsole._renderMobileMenu(host);
      AdminConsole._markRouted();
      return;
    }
    AdminConsole._renderSection();
    AdminConsole._markRouted();
  },

  _renderMobileMenu(host) {
    host.innerHTML = AdminConsole._mobileMenuHtml();
    AdminConsole._wireSectionButtons(host);
    AdminConsole._wireGroupToggles(host);
  },

  _renderSection() {
    const host = document.getElementById('admin-section-content');
    if (!host) return;
    // Always tear the previous section down first — this is the single
    // choke point every section switch passes through.
    AdminConsole._teardownActiveSection();

    const key = AdminConsole._section;
    const modName = AdminConsole.SECTION_MODULES[key];
    if (modName) return AdminConsole._renderModule(host, modName, key);
    // Anything the address bar names that this build does not know about
    // lands on the default section, which is Overview — a delegated module
    // since #1120, so it goes through the same dispatch. Every section is a
    // delegated module now, so this is the only arm left: the `switch` the
    // console dispatched its own renderers through is gone (#1120 slice 23).
    return AdminConsole._renderModule(host, 'AdminOverview', 'overview');
  },

  // ── The sections arrive with the first open, not with the shell ──────
  //
  // ./sections.ts is the twenty section modules as one lazy chunk: 422KB of
  // the shell's 1.75MB bundle that every visitor used to download so that an
  // admin could open a console the isAdmin gate keeps everyone else out of.
  //
  // Splittable because the seam was already here. A section has never been in
  // the document before it was opened — _renderSection hands it a host and
  // calls mod.render(host) — so making its CODE arrive at the same moment
  // changes no markup, no id and no baseline. The chassis (features/admin/
  // index.tsx) stays static and prerendered exactly as before.
  _sectionsPromise: null,
  _sectionsReady: false,

  /**
   * Start (or join) the section-chunk load. Returns the promise while it is
   * outstanding and null once the modules are in, so a caller can tell "not
   * here yet" from "genuinely missing" — which is the distinction
   * _renderModule's failure copy has always been about.
   */
  _ensureSections() {
    if (AdminConsole._sectionsReady) return null;
    if (!AdminConsole._sectionsPromise) {
      AdminConsole._sectionsPromise = import('./sections.ts')
        .then(() => { AdminConsole._sectionsReady = true; })
        .catch((err) => {
          // Leave _sectionsPromise set: a chunk that failed to load is not
          // going to succeed on a retry loop driven by re-rendering, and
          // _renderModule's own copy is the honest thing to show.
          AdminConsole._sectionsReady = true;
          console.warn('[admin] section modules failed to load', err);
        });
    }
    return AdminConsole._sectionsPromise;
  },

  /**
   * Warm the chunk for somebody who is going to want it. Called from
   * App.renderAdminButton, which already runs exactly when the viewer is
   * known to be an admin, and deferred to idle so it never competes with the
   * first paint. A non-admin never reaches it.
   */
  prefetchSections() {
    // NOT on a ?shot= or ?demo= route. Those exist to render one state
    // deterministically for a screenshot or a declared check, and a
    // background chunk arriving mid-assertion is exactly the kind of
    // nondeterminism they are supposed to be free of. Same guard, for the
    // same reason, as TermsFirstRun.maybePrompt. Nothing is lost: the
    // console still loads on demand, which is what the #admin checks
    // exercise.
    try {
      const q = new URLSearchParams(location.search);
      if (q.get('shot') || q.get('demo')) return;
    } catch { /* no URL to read is not a reason to skip a real prefetch */ }
    // Genuinely idle, and patient about it. The first version forced this
    // through within 4s of boot, which on a phone means parsing 421KB
    // against whatever the page is still doing. This chunk is worth having
    // EVENTUALLY and worth nothing urgently — a first open that has to wait
    // for it costs about as long as one navigation.
    const start = () => { AdminConsole._ensureSections(); };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 15000 });
    else setTimeout(start, 8000);
  },

  // Hand a section host to a delegated module, and remember it so the next
  // switch can tear it down. Extracted from _renderSection when `overview`
  // became a module: it is now reachable both by name and as the default.
  _renderModule(host, modName, key) {
    const mod = window[modName];
    if (!mod || typeof mod.render !== 'function') {
      // Not here YET is the ordinary first open. Show the same skeleton the
      // sections use while they fetch, then re-enter — via _renderSection,
      // so a viewer who navigated to another section meanwhile gets the one
      // they actually asked for rather than the one this call was for.
      const pending = AdminConsole._ensureSections();
      if (pending) {
        host.innerHTML = `<p class="${AdminUI.loading} p-4">Loading…</p>`;
        pending.then(() => {
          const live = document.getElementById('admin-section-content');
          if (live && AdminConsole._open) AdminConsole._renderSection();
        });
        return;
      }
      host.innerHTML = `<p class="${AdminUI.muted} p-4">The ${AdminConsole.esc(key)} console module failed to load.</p>`;
      return;
    }
    AdminConsole._activeModule = mod;
    mod.render(host);
  },

  // ── Delegated sections ──────────────────────────────────────────────
  //
  // Topochain (Task 15), Health & status / Node & chain / Analytics /
  // Merge debug / Screenshot gallery / Maintenance campaigns (#860) and
  // Estimator accuracy (#898) all
  // live in their own modules, dispatched by SECTION_MODULES above rather
  // than by a render*Section method here. Two of them own tail segments
  // below the section entirely on their own — AdminTopochain under
  // #admin/season-events/<eventId> and AdminCampaigns under
  // #admin/campaigns/<id> — reading location.hash directly and writing it
  // back with replaceState, the same pattern leaderboard.js uses for its
  // own tab state, so this file never needs general multi-level routing.

  // ── Sweep forwarders (Container rollover / Stale previews) ───────────
  //
  // Both sections are React modules now (#1120 slice 23:
  // features/admin/admin-rollover.tsx and admin-staging-reap.tsx), but they
  // are the only two with a caller OUTSIDE the console: public/js/app.js
  // routes `admin_rollover_status` / `admin_staging_reap_status` frames from
  // the shell's /ws/events socket to the two handlers below, and calls the
  // two loaders on socket reconnect so a dropped socket cannot leave a job
  // half-painted.
  //
  // That surface belongs to the shell, not to the console, so it stays
  // exactly where app.js already looks for it and forwards to the module.
  // Each forwarder is a no-op while its section is not mounted — the module
  // holds a `live` handle that is non-null exactly while it is on screen,
  // which is what the old handlers approximated with a `_section === …`
  // check plus a getElementById probe. Nothing is lost by dropping a frame:
  // the next mount reads the job from the GET.
  handleRolloverStatus(data) {
    if (!AdminConsole._open) return;
    window.AdminRollover?.handleStatus?.(data);
  },

  loadRollover() { window.AdminRollover?.reload?.(); },

  handleStagingReapStatus(data) {
    if (!AdminConsole._open) return;
    window.AdminStagingReap?.handleStatus?.(data);
  },

  loadStagingReap() { window.AdminStagingReap?.reload?.(); },

  // ── Temporary-password dialog (filled for the Users section) ───────────
  //
  // The dialog is chassis furniture: index.tsx renders #admin-temp-pw-modal
  // as static React markup and this fills it. It stayed here when the Users
  // section moved out (#1120 slice 22), so that section never reaches for a
  // chassis id — the OFF_LIMITS rule in
  // tests/admin-heavy-sections-island.test.js.

  // Temporary-password modal — shows the one-time plaintext exactly once.
  _showTempPasswordModal(username, tempPassword) {
    const modal = document.getElementById('admin-temp-pw-modal');
    if (!modal) return;
    document.getElementById('admin-temp-pw-username').textContent = username;
    const valueEl = document.getElementById('admin-temp-pw-value');
    valueEl.textContent = tempPassword;
    const copyBtn = document.getElementById('admin-temp-pw-copy');
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(tempPassword);
        copyBtn.textContent = 'Copied';
      } catch {
        // Clipboard API can be blocked (insecure context); select instead.
        const range = document.createRange();
        range.selectNodeContents(valueEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        copyBtn.textContent = 'Select & copy';
      }
    };
    document.getElementById('admin-temp-pw-close').onclick = () => {
      modal.classList.add('hidden');
      valueEl.textContent = '';
    };
    modal.classList.remove('hidden');
  }
};

// app.js reaches for window.AdminConsole (route / open / syncChrome / the
// rollover + stale-preview WS handlers), and _renderSection dispatches the
// section modules through window[modName], so the global publication stays.
// Guarded: the prerender pass evaluates this module in Node.
if (typeof window !== 'undefined') window.AdminConsole = AdminConsole;
