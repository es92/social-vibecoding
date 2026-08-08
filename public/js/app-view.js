const AppView = {
  appData: null,
  iframeToken: null,
  // Slug the held iframeToken was minted for (app-scoped RS256 audience).
  iframeTokenSlug: null,
  // #743: validated inner app path (path+query, wire-encoded) from a
  // chromeless deep link (#app/<slug>/full?path=/t/123). Written by
  // App.restoreFromHash on every pass (null when the hash carries none),
  // consumed by buildAppIframeSrc, cleared by close().
  pendingInnerPath: null,

  // #621: true when the viewer may see the app (view access) but is not
  // a collaborator on an invite-only-build app. The Dev tab renders,
  // but every write control (composer, votes, kudos, "+" actions,
  // attribute chips, kanban drag) is hidden — the server enforces the
  // same read-only boundary on every API and the group-chat WS.
  get readOnly() {
    return !!AppView.appData && AppView.appData.can_collaborate === false;
  },
  activityInterval: null,
  tokenRefreshInterval: null,
  activeSeconds: 0,
  iframeFocused: false,

  // #685: the WindowProxy that announced a usernode.issueState provider
  // (`available` via postMessage). Kept as the source object — not a
  // boolean — so the feedback modal can verify at open time that the
  // announcing frame is still the mounted production iframe.
  _issueStateSource: null,

  // Open-issues state. `_ghIssues` caches the last-fetched GitHub issue
  // list (with bounty_count/my_bounty) so feed paging and the
  // give-bounty optimistic update can re-render without a refetch.
  _ghIssues: [],
  _ghIssuesMeta: { truncatedList: false, note: null, repoUrl: null, myRemaining: null },
  _bountyInFlight: new Set(),

  // #396: per-issue-number cache of the GitHub comment thread fetched
  // lazily when an issue topic opens, so _renderTopicHead's live-refreshes
  // (WS-driven) reuse it instead of refetching. Each entry is
  // `{ comments, truncated }`; absent means "not loaded yet".
  _ghComments: {},

  // Scroll-position memory for the Dev card list, keyed by app slug
  // (`App.currentApp`). In-memory only — reset on a full page reload by
  // design, so a hard refresh starts at the top. Mirrors the
  // per-session chat scroll memory in dev-chat.js
  // (`_savedScrollBySession`): we capture the list's scrollTop when
  // leaving it (any route that re-enters renderDevView) and restore it
  // after the feed repaints, so tapping into an item and coming Back
  // lands the user where they left off instead of at the top.
  _savedFeedScroll: {},

  // Store the Dev list's scroll offset under an app slug. A missing
  // slug or a non-positive offset clears any saved value (top is the
  // default, so there's nothing to remember). Pure besides the map
  // write — DOM-free for unit testing.
  _saveFeedScroll(slug, scrollTop) {
    if (!slug) return;
    const n = Number(scrollTop);
    if (!Number.isFinite(n) || n <= 0) { delete AppView._savedFeedScroll[slug]; return; }
    AppView._savedFeedScroll[slug] = n;
  },

  // Read back a saved offset for a slug, or 0 (top) when none is
  // stored. Positions stay isolated per slug.
  _getFeedScroll(slug) {
    const v = AppView._savedFeedScroll[slug];
    return Number.isFinite(v) && v > 0 ? v : 0;
  },

  // Clamp a saved offset to the maximum scrollable offset of the
  // (possibly shorter) rebuilt list — the same clamp the browser's own
  // scrollTo applies — so a collapsed "Show more" list lands at the
  // bottom of its available content rather than overshooting.
  _clampScrollTop(saved, scrollHeight, clientHeight) {
    const max = Math.max(0, Number(scrollHeight) - Number(clientHeight));
    return Math.max(0, Math.min(Number(saved) || 0, max));
  },

  // Shared list-item shell for every card on the Dev page — the General
  // chat card, issue/proposal/governance cards, Your-sessions rows, and
  // Recently-merged rows — so the whole page reads as one uniform list
  // (same row structure, padding, border, radius). Tappable cards add
  // DEV_CARD_HOVER_CLS on top.
  DEV_CARD_CLS: 'w-full flex items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 px-3.5 py-3 text-left transition-colors',
  // Trailing chevron marking a card as tappable (same affordance as the
  // General chat card).
  DEV_CARD_CHEVRON: '<svg class="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>',
  DEV_CARD_HOVER_CLS: 'hover:border-violet-300 dark:hover:border-violet-700 cursor-pointer',
  // A PRIVATE dev session — nobody else can see it. Muted/draft treatment
  // (dashed border, slightly dimmed) so that fact reads off the card itself
  // instead of needing the grey caption that used to sit above the group.
  //
  // Session cards used to be the board's only TWO-row card (title row + an
  // indented actions row) because their five inline pills would otherwise
  // crush the flex-1 title. With the action budget capped at "icon Preview
  // + ⋯" that pressure is gone, so they now use the standard single-row
  // DEV_CARD_CLS shell like every other card; .dev-card-headline's
  // progressive-wrap rule is what actually protects the title.
  DEV_CARD_MUTED_CLS: 'dev-card-muted',

  // Per-type tinted icon chips — the Dev list's identity system, a mini
  // version of the home tiles' avatar square. [tint classes, SVG path].
  DEV_CARD_ICONS: {
    chat: ['bg-violet-600/15 text-violet-500', 'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z'],
    // Pencil (Heroicons outline) — sessions are edits-in-progress, not
    // terminals (#219). Distinct from the issue icon's pencil-in-bubble.
    session: ['bg-emerald-500/15 text-emerald-500', 'M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z'],
    // Comment-bubble-with-pencil: the chat bubble outline (dots removed)
    // plus the Heroicons pencil-alt tip scaled to sit inside it — issues
    // are written feedback, not warnings (hence no more exclamation).
    issue: ['bg-amber-500/15 text-amber-500', 'M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5zM15.35 6.95a1.2 1.2 0 111.7 1.7l-5.15 5.15H10.2v-1.7l5.15-5.15z'],
    proposal: ['bg-sky-500/15 text-sky-500', 'M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-11h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5'],
    gov: ['bg-slate-500/15 text-slate-400', 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z'],
    done: ['bg-emerald-500/10 text-emerald-500', 'M5 13l4 4L19 7'],
    // Document-text (Heroicons outline) — an issue with an auto-generated
    // proposal attached (#250). Sky keeps "blue = proposal" consistent with
    // the proposal cards, while the page shape stays distinct from their
    // thumbs-up: this is a drafted spec on an issue, not a PR up for a vote.
    issueProposal: ['bg-sky-500/15 text-sky-500', 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'],
    // "Mine" variants — distinguished from their base by GLYPH ONLY: they keep
    // the same sky tint as the base issue/PR chips but swap in a self-contained
    // pencil/edit mark = "your work-in-progress, jump back in." They mark the
    // two feed rows where the viewer already has a session waiting: a ready
    // issue they cloned (Go to session) and an open PR they authored (Open
    // session). No manual coordinate compositing: issueProposalMine is a true
    // document-with-pencil (page + folded corner + pencil) so it still reads
    // as a document; proposalMine is a plain pencil "edit" mark.
    issueProposalMine: ['bg-sky-500/15 text-sky-500', 'M14 3v4a1 1 0 0 0 1 1h4M17 21h-7a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v4M18.42 15.61a2.1 2.1 0 0 1 2.97 2.97l-3.39 3.42h-3v-3l3.42 -3.39z'],
    proposalMine: ['bg-sky-500/15 text-sky-500', 'M12 15l8.385 -8.415a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3zM16 5l3 3'],
  },

  _devCardIcon(type, opts) {
    const [tint, d] = AppView.DEV_CARD_ICONS[type] || AppView.DEV_CARD_ICONS.issue;
    const small = !!(opts && opts.small);
    // pulse: animate the whole chip for in-progress states (#250).
    // title: hover tooltip naming the state the tint encodes.
    const pulse = opts && opts.pulse ? ' animate-pulse' : '';
    const title = opts && opts.title ? ` title="${escapeAttr(opts.title)}"` : '';
    return `<span class="${small ? 'w-7 h-7' : 'w-9 h-9'} rounded-lg ${tint} flex items-center justify-center shrink-0${pulse}"${title}>`
      + `<svg class="${small ? 'w-4 h-4' : 'w-5 h-5'}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg></span>`;
  },

  // ── Dev view state (#194, card-list revision) ─────────────────────
  // The Dev mode is one card list plus full-screen sub-views (general
  // chat, topics, sessions, settings). _devTopic (declared with the
  // topic sub-view below) tracks the open topic for hash deep links.
  // How many feed items are visible (the rest sit behind "Show more").
  _feedShown: 20,

  // ── Dev view mode (list ↔ kanban) ─────────────────────────────────
  // A personal display preference, persisted to localStorage and shared
  // across every app's Dev view (same pattern as DevConsole's MODE_KEY
  // and the "view as non-admin" toggle). An explicitly saved choice
  // always wins; with nothing saved the default is width-based (#462):
  // 'kanban' on viewports ≥640px — Tailwind's sm breakpoint, lowered
  // from 1024px (lg) because the board is worth having on a narrow
  // window even though the four columns only fit at their readable
  // width by scrolling sideways there (see the 640-1023px block in
  // app.css) — and 'list' (the historical default) below it.
  // Read/written only through the two helpers below so the
  // localStorage access stays guarded in one place.
  VIEW_MODE_KEY: 'devViewMode',
  // The single source of truth in JS for where the board goes
  // side-by-side. Must stay in step with the two kanban media queries in
  // app.css (`max-width: 639px` for the tab strip, `min-width: 640px`
  // for the multi-column band) and with `sm:hidden` on #dev-kanban-tabs.
  KANBAN_MULTICOL_MEDIA: '(min-width: 640px)',
  // Width-based default, resolved lazily ONCE per page load and never
  // written to localStorage — so an undecided user keeps getting the
  // responsive default on future visits, and the mode can't flip
  // mid-flight between the paired _getViewMode() reads inside async
  // flows like loadMoreMerged if the window is resized across 640px.
  _viewModeAutoDefault: null,
  // #814: `?view=list|kanban|pm` — a one-shot URL override that wins over
  // BOTH the stored preference and the width default, resolved once per
  // page load (undefined = not parsed yet, null = nothing usable in the
  // URL). It exists so a fresh browser can be pointed straight at a given
  // view: the capture container boots with empty localStorage at the
  // 390x844 phone frame, where the width default below resolves to 'list',
  // so without this no mobile screenshot could ever show the board.
  // Cleared by _setViewMode so an explicit toggle click always wins.
  _viewModeUrlOverride: undefined,
  _readViewModeOverride() {
    if (AppView._viewModeUrlOverride !== undefined) return AppView._viewModeUrlOverride;
    let v = null;
    try {
      const raw = new URLSearchParams(window.location.search).get('view');
      if (raw === 'list' || raw === 'kanban' || raw === 'pm') v = raw;
    } catch { v = null; }
    AppView._viewModeUrlOverride = v;
    return v;
  },
  _getViewMode() {
    try {
      const override = AppView._readViewModeOverride();
      if (override) return override;
      const stored = window.localStorage.getItem(AppView.VIEW_MODE_KEY);
      if (stored === 'kanban' || stored === 'list' || stored === 'pm') return stored;
      if (AppView._viewModeAutoDefault === null) {
        AppView._viewModeAutoDefault =
          (typeof window.matchMedia === 'function'
            && window.matchMedia(AppView.KANBAN_MULTICOL_MEDIA).matches)
            ? 'kanban' : 'list';
      }
      return AppView._viewModeAutoDefault;
    } catch { return 'list'; }
  },
  _setViewMode(mode) {
    const next = (mode === 'kanban' || mode === 'pm') ? mode : 'list';
    // An explicit choice retires the URL override (#814) — otherwise
    // ?view= would keep winning over every later toggle click.
    AppView._viewModeUrlOverride = null;
    try { window.localStorage.setItem(AppView.VIEW_MODE_KEY, next); } catch {}
  },
  // #482: kanban filter-bar state. The active object always reflects the
  // CURRENT app; it is (re)loaded per slug from sessionStorage whenever the
  // board mounts (_repaintDevBody) and written back on every change
  // (_repaintKanbanBoard). sessionStorage — not localStorage — is deliberate:
  // filters survive in-app navigation and a page reload within the tab
  // session, but auto-clear when the tab closes, so a filter can't land a
  // user on a mysteriously empty board days later.
  KANBAN_FILTERS_KEY: 'devKanbanFilters',
  // #633: sentinel value for the assignee dropdown's "Unassigned" option.
  // The leading space makes it collision-free against real assignees:
  // stored assignee values are trimmed server-side (topic-attributes
  // normalizeValue), so no assignee.top can ever begin with whitespace.
  KANBAN_ASSIGNEE_UNASSIGNED: ' __unassigned__',
  _kanbanFilters: { q: '', priority: null, assignee: null, category: null, needsVote: false },
  // Single source of truth for the empty/default filter set.
  _defaultKanbanFilters() {
    return { q: '', priority: null, assignee: null, category: null, needsVote: false };
  },
  // Load the saved filters for an app slug, merged over the defaults so a
  // stored object missing a (future) field degrades gracefully. Returns
  // defaults for a falsy slug, nothing stored, or any storage/parse failure.
  _loadKanbanFilters(slug) {
    const def = AppView._defaultKanbanFilters();
    if (!slug) return def;
    try {
      const raw = window.sessionStorage.getItem(`${AppView.KANBAN_FILTERS_KEY}:${slug}`);
      if (!raw) return def;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return def;
      return { ...def, ...parsed };
    } catch { return def; }
  },
  // Persist the current filters under the app slug. Clears the key when the
  // filters are at their defaults so a cleared board leaves no residue.
  _saveKanbanFilters(slug) {
    if (!slug) return;
    try {
      const key = `${AppView.KANBAN_FILTERS_KEY}:${slug}`;
      if (AppView._kanbanFiltersActive()) {
        window.sessionStorage.setItem(key, JSON.stringify(AppView._kanbanFilters));
      } else {
        window.sessionStorage.removeItem(key);
      }
    } catch {}
  },
  // #814: mobile kanban tabs. Below 640px the board shows ONE column at a
  // time behind a tab strip instead of scrolling sideways; which column is
  // showing is this key. Same storage shape and lifetime as the filters
  // above — per-app sessionStorage, so the tab survives in-app navigation
  // and a reload but resets when the browser tab closes. Purely a display
  // preference: the markup always carries all four columns and CSS decides
  // what's visible, so desktop never reads this beyond marking the column.
  KANBAN_TAB_KEY: 'devKanbanTab',
  // Column identities, in board order. Shared by the render, the tab strip,
  // the stored value and the ?col= override. NOTE: distinct from the
  // drag-order column keys ('issues' / 'review', see routes/board-order.js)
  // — same words in places, different namespace.
  KANBAN_TABS: ['issues', 'inprogress', 'inreview', 'done'],
  _kanbanTab: 'issues',
  // `?col=<key>` — one-shot URL override for the active tab, mirroring
  // ?view= above: it seeds the tab on mount, wins over the stored value,
  // and is retired the moment the user taps a tab.
  _kanbanTabUrlOverride: undefined,
  _readKanbanTabOverride() {
    if (AppView._kanbanTabUrlOverride !== undefined) return AppView._kanbanTabUrlOverride;
    let v = null;
    try {
      const raw = new URLSearchParams(window.location.search).get('col');
      if (AppView.KANBAN_TABS.includes(raw)) v = raw;
    } catch { v = null; }
    AppView._kanbanTabUrlOverride = v;
    return v;
  },
  // Resolve the tab for an app slug: URL override first, then the stored
  // per-app value, then the leftmost column. Anything unrecognized (a stale
  // key from a future/older column set, a storage failure) degrades to
  // 'issues' rather than leaving the board with no visible column.
  _loadKanbanTab(slug) {
    const override = AppView._readKanbanTabOverride();
    if (override) return override;
    if (!slug) return 'issues';
    try {
      const raw = window.sessionStorage.getItem(`${AppView.KANBAN_TAB_KEY}:${slug}`);
      return AppView.KANBAN_TABS.includes(raw) ? raw : 'issues';
    } catch { return 'issues'; }
  },
  // Persist the active tab under the app slug. The default column leaves no
  // residue, matching _saveKanbanFilters' "clean state stores nothing" rule.
  _saveKanbanTab(slug) {
    if (!slug) return;
    try {
      const key = `${AppView.KANBAN_TAB_KEY}:${slug}`;
      if (AppView._kanbanTab && AppView._kanbanTab !== 'issues') {
        window.sessionStorage.setItem(key, AppView._kanbanTab);
      } else {
        window.sessionStorage.removeItem(key);
      }
    } catch {}
  },
  // Active tab as used by the render — never trusts the field blindly, so a
  // bad assignment can't produce a board with every column hidden.
  _activeKanbanTab() {
    return AppView.KANBAN_TABS.includes(AppView._kanbanTab) ? AppView._kanbanTab : 'issues';
  },
  // Session caches for the In progress area — see _refreshSessionCaches.
  _mySessions: [],
  _sharedSessions: [],
  _sharedById: {},
  _archivedSessions: [],
  _sessionsSig: null,
  // Cached Proposals-tab data for in-place re-renders.
  _proposals: [],
  _govProposals: [],
  _proposalsCtx: { majority: 1, activeUsers: 1, locked: false, lockedHint: '' },
  // #613: manual drag-and-drop order overlay for the kanban Issues + In
  // review columns, loaded by _loadDevData from GET /board-order. Shape
  // { issues: [{type,ref}], review: [{type,ref}] }; empty arrays mean the
  // default derived sort (today's board).
  _boardOrder: { issues: [], review: [] },
  // Manual drag-and-drop order overlay for the PM view, keyed by the
  // case-folded assignee (a person), loaded by _loadDevData from GET
  // /pm-order. Shape { "<assignee_key>": [{type,ref}], … }; an absent key
  // means that person's section uses the default derived (recency) sort.
  _pmOrder: {},
  // One-shot flag set by the "Create proposal" button so the freshly
  // opened dev session renders a "promoting this PR creates the
  // proposal" hint.
  _proposalHint: false,

  // Iframe tokens are signed for 1h. Refresh at 45min so the child app never
  // sees an expired JWT during a long reading/editing session.
  TOKEN_REFRESH_MS: 45 * 60 * 1000,

  async open(slug) {
    // #931: the token mint runs ALONGSIDE the detail fetch, not after it.
    // These used to be strictly sequential, which cost a full extra round
    // trip before the app iframe could even be built — the thing that made
    // a tapped app animate in as an empty window. The mint needs nothing
    // but the slug (and enforces its own access gate server-side), and it
    // is single-flight, so on the eager-launch path this call just joins
    // the mint the launch already started.
    const tokenReady = AppView.refreshToken(slug);
    const res = await fetch(`/api/apps/${slug}`);
    if (!res.ok) {
      // The server won't confirm this app, but a launch surface may already
      // be mounted and pointing at it (beginLaunch runs off the cached list
      // record). Drop both, so the switchTab that follows lands on
      // renderAppTab's "App not available" branch instead of leaving an
      // orphan frame under a cover that would never reveal.
      await tokenReady;
      if (AppView.appData && AppView.appData.slug === slug) AppView.appData = null;
      AppView._teardownLaunch();
      return;
    }
    const { app: appData } = await res.json();
    // #1010: local "being applied" state is per-app and per-page-visit —
    // proposal ids are global, but a stale entry carried into another app
    // would spin a card whose apply this client never started. Cleared on
    // every app load (NOT in _loadDevData, which re-runs on every WS event
    // and would wipe a spinner mid-apply).
    if (!AppView.appData || AppView.appData.slug !== appData.slug) {
      Object.keys(AppView._govApplyTimers).forEach(AppView._clearGovApplyTimers);
      AppView._govApplying = Object.create(null);
      AppView._govDueSince = Object.create(null);
    }
    AppView.appData = appData;

    // Mode visibility (App tab hidden for self-hosted apps, whose
    // appData.url maps to a slug-derived subdomain that doesn't resolve;
    // Dev visible to everyone who can see the app per #621, read-only for
    // non-collaborators via AppView.readOnly) used to be two per-button
    // `hidden` toggles on the bottom tab bar's cells. The bar is now the
    // header's #app-mode-switch, whose whole-control visibility is owned
    // by App.DrawerStatus.setAppOpen() — called from navigateToApp right
    // after this fetch resolves, on the same lifecycle as the drawer's
    // app-scoped rows. Nothing to toggle here any more.

    await tokenReady;
    AppView.startActivityTracking(slug);
    AppView.startTokenRefresh();
    if (window.DevConsole) DevConsole.setCurrentApp(slug);
    // Populate the deployed-version pill in the header. It lives in the
    // shared header so it's visible across tabs (App / group-chat /
    // dev-chat) for the duration this app is open; close() clears it.
    AppView.refreshVersionPill();
    // Amber "⑂ Forked from <name>" lineage label in the shared header
    // (cleared by close()). No-op for non-forks.
    AppView.renderForkBadge();
    // Missing-secrets badge lives inside the dev-chat tab now and is
    // re-applied by renderDevChatTab() on every mount, so the call here
    // is just a primer for the case where the tab is already rendered.
    if (window.Secrets) {
      Secrets.applyMissingBadge(appData.missingSecrets || null);
    }

    // Screenshot-state deep link (`?shot=secrets`): the secrets panel —
    // "Platform variables" on the platform's own row — is a modal reached
    // from the "+" menu, so plain navigation can't render it and the
    // before/after captures would silently show the home feed. Opening it
    // from a URL param makes it capturable and testable. Pure UI state: it
    // just opens the same modal a click opens, in every environment, so
    // the "before" side of a capture works too.
    //
    // DEFERRED, not opened inline: open() is awaited from the middle of
    // App.navigateToApp, which still has a switchTab() to run after it.
    // Opening here directly puts the modal's present-animation in a race
    // with that render — PlatformUI adopts the modal into the native kit
    // by moving its card, and a hide/show landing mid-present leaves the
    // kit shell on screen with the card back in its old home: a blank
    // white panel. Letting navigation finish first makes it the same
    // sequence a real click produces.
    //
    // `?shot=secrets-new` goes one step further and expands the "New
    // variable" form, which is otherwise behind a click inside a modal —
    // two layers of interaction that neither the capture pipeline nor a
    // dapp.json test can reach.
    try {
      const shot = new URLSearchParams(location.search).get('shot');
      if (shot === 'secrets' || shot === 'secrets-new') {
        setTimeout(() => {
          // Still on this app? A fast navigate-away must not pop a modal
          // onto whatever screen the user actually landed on.
          if (window.Secrets && AppView.appData?.slug === slug) {
            Secrets.open(slug, { declare: shot === 'secrets-new' });
          }
        }, 300);
      }
      // #816: the preview loader is the screen this change is about, and it
      // only exists mid-click on a Preview button — no URL reaches it, so
      // the before/after captures would show the dev board instead. These
      // links paint each loader state directly. Pure UI state (no fetch, no
      // write, no container), so they render identically in every
      // environment and the "before" side of a capture works too.
      // #929: the dev screen's "+" menu is the other surface that broke on
      // mobile, and it was untestable for the same reason as the secrets
      // modal — it only exists after a tap. This link taps the button
      // itself, so whichever idiom the platform picks (kit action sheet on
      // touch, the anchored #dev-plus-menu dropdown on desktop) is the one
      // a check sees. Pure UI state, no writes, not env-gated.
      if (shot === 'plus-menu') {
        setTimeout(() => {
          if (!String(location.hash || '').includes(`app/${slug}`)) return;
          document.getElementById('dev-plus-btn')?.click();
        }, 300);
      }
      // A card's ⋯ menu is interaction-gated in exactly the same way, and
      // its whole point is the row inventory — the leading icon column, the
      // wording, which actions a role gets. Tap the first card's trigger so
      // a check (and a before/after capture) sees the open menu instead of
      // the board it hangs off. Pure UI state, no writes, not env-gated.
      // Unlike the "+" menu this one has to wait on _loadDevData's fetches
      // (a board with no cards has no trigger to tap) AND survive the
      // repaints those fetches trigger, each of which dismisses an open menu
      // by design. So it retries on a short interval until a menu is up and
      // stays up, then stops — a capture must not race a websocket push.
      // It also picks the trigger out of the ACTIVE column: below 640px the
      // other three are display:none, and a menu anchored to a hidden card
      // lands in the corner beside nothing.
      if (shot === 'card-menu') {
        let tries = 0;
        const tick = setInterval(() => {
          // Retries only until the board has cards to tap — an open menu now
          // SURVIVES the repaints those fetches trigger (_reanchorCardMenu),
          // so once it is up this is done. Stop on route change too, and cap
          // the window so a link left open in a real tab can't keep polling.
          if (AppView._openCardMenu || !String(location.hash || '').includes(`app/${slug}`)
              || (tries += 1) > 40) {
            clearInterval(tick);
            return;
          }
          // Scoped to the ACTIVE column: below 640px the other three are
          // display:none, and a menu anchored to a hidden card lands in the
          // corner beside nothing.
          const scope = document.querySelector('.dev-kanban-col-active') || document.getElementById('dev-body');
          scope?.querySelector('[data-card-menu]')?.click();
        }, 300);
      }
      if (shot === 'preview-loading' || shot === 'preview-rebuilding') {
        setTimeout(() => {
          // Gate on the ROUTE, not on appData: the dev tab clears appData
          // as it mounts, so an appData check here would race the render.
          // A fast navigate-away must not pop the overlay onto whatever
          // screen the user actually landed on.
          if (String(location.hash || '').includes(`app/${slug}`)) {
            AppView.showPreviewLoaderShot(shot);
          }
        }, 300);
      }
    } catch { /* malformed query string — nothing to open */ }
  },

  // #816: paint one staging-preview loader state with no preview behind it.
  // Screenshot-state deep link only (see the `?shot=` block above) — never
  // reached by a real Preview click, which goes through ensureStaging.
  showPreviewLoaderShot(shot) {
    const overlay = document.getElementById('staging-overlay');
    if (!overlay) return;
    // Take a load id so the Back button's teardown (and any later real
    // preview) supersedes this exactly as it would a genuine open.
    AppView._stagingLoadId += 1;
    AppView._stagingDockable = false;
    AppView._setStagingMode('fullscreen');
    const iframe = document.getElementById('staging-iframe');
    if (iframe) iframe.src = '';
    const label = document.getElementById('staging-url-label');
    if (label) label.textContent = 'https://staging-demo-preview.example';
    overlay.classList.remove('hidden');
    const back = document.getElementById('staging-back');
    if (back) back.onclick = () => AppView.closeStagingOverlay();
    if (shot === 'preview-rebuilding') {
      // The ONE state that still promises 20–60 seconds: a real rebuild.
      AppView._setStagingLoader(true, {
        title: 'Spinning the preview back up…',
        sub: 'The preview was paused after a while of inactivity. Rebuilding it '
          + 'from the session’s latest changes — this usually takes 20–60 seconds.',
      });
      return;
    }
    // The common post-build path: the server verified the preview, so this
    // is a plain "the page is rendering" spinner with no invented duration.
    AppView._setStagingLoader(true, {
      title: 'Loading the preview…',
      sub: 'Automated checks are running against this preview, so the first load may be a little slower.',
    });
  },

  close() {
    AppView.stopActivityTracking();
    AppView.stopTokenRefresh();
    AppView._issueStateSource = null;
    // #931: retire any in-flight eager launch (generation bump + timers), so
    // a frame we're about to unmount can't reveal itself over the next screen.
    AppView._teardownLaunch();
    GroupChat.disconnect();
    // Detach kit scroll/keyboard handles for every app-scoped screen.
    ['dev-chat', 'group-chat', 'gc-thread', 'dev-feed'].forEach((k) => PlatformUI.detachScreenFx(k));
    // Drop any in-memory dev-chat session state belonging to the app
    // we're leaving. Without this, opening a different app and clicking
    // the dev-chat tab would render the prior app's session instead of
    // the new app's session list (fixes #20).
    if (window.DevChat) DevChat.reset();
    AppView.appData = null;
    AppView.iframeToken = null;
    AppView.iframeTokenSlug = null;
    if (window.DevConsole) {
      DevConsole.hide();
      DevConsole.setCurrentApp(null);
    }
    if (window.Secrets) Secrets.hide();
    AppView.pendingInnerPath = null;
    // Both slots live in the drawer's bottom-anchored footer now (same
    // ids, new parent). Blank them AND hide their rows, or the previous
    // app's build/fork lines linger in the menu on the home feed.
    const slot = document.getElementById('app-version-pill-slot');
    if (slot) slot.innerHTML = '';
    const forkSlot = document.getElementById('app-fork-badge-slot');
    if (forkSlot) forkSlot.innerHTML = '';
    if (window.App?.DrawerStatus) App.DrawerStatus.setAppOpen(false);
  },

  // Iframe tokens are APP-SCOPED since the RSA cutover: each one carries
  // audience `usernode:app:<id>` and verifies against exactly one app, so
  // the mint call must name the app it is for. `iframeTokenSlug` records
  // which app the held token belongs to — both iframe-src builders check
  // it before attaching the token, so a token left over from a previously
  // opened app is never sent to a different app's iframe (it would fail
  // that app's audience check anyway; omitting it keeps the failure mode
  // "no token" rather than "rejected token").
  //
  // #931: minting goes through a small single-flight + short-freshness
  // layer, because the launch path now asks for a token up to three times
  // for the same app within a few hundred milliseconds (prewarm on
  // pointerdown, beginLaunch on the tap, open() alongside the detail
  // fetch). Without it those would be three mints and — worse — the eager
  // iframe src could differ from the one renderAppTab rebuilds, which is
  // what makes the double-load-free adoption in renderAppTab possible.
  //
  // 60s is deliberately short. Tokens live an hour and the long-session
  // refresh below runs at 45min, so this window only ever covers
  // "pointerdown → click → open" and expires long before anything that
  // would need cache invalidation (logout, user switch) could matter.
  TOKEN_FRESH_MS: 60 * 1000,
  _tokenInflight: {},
  _tokenFresh: null,

  // Resolves the token string for `slug`, or null on any failure. Never
  // rejects, and never touches iframeToken/iframeTokenSlug — a prewarm for
  // an app the user hasn't opened must not repoint the held token away from
  // the app that IS open (that would make its next iframe render tokenless).
  _mintToken(slug) {
    if (!slug) return Promise.resolve(null);
    const fresh = AppView._tokenFresh;
    if (fresh && fresh.slug === slug
        && (Date.now() - fresh.at) < AppView.TOKEN_FRESH_MS) {
      return Promise.resolve(fresh.token);
    }
    const inflight = AppView._tokenInflight[slug];
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const res = await fetch(`/api/iframe-token?app=${encodeURIComponent(slug)}`);
        if (!res.ok) return null;
        const { token } = await res.json();
        if (!token) return null;
        AppView._tokenFresh = { slug, token, at: Date.now() };
        return token;
      } catch {
        return null;
      } finally {
        delete AppView._tokenInflight[slug];
      }
    })();
    AppView._tokenInflight[slug] = p;
    return p;
  },

  // True when a token for `slug` is already in hand, i.e. beginLaunch can
  // assign the iframe src synchronously on the tap instead of waiting a
  // round trip for the mint.
  hasFreshToken(slug) {
    const fresh = AppView._tokenFresh;
    return !!(slug && fresh && fresh.slug === slug
      && (Date.now() - fresh.at) < AppView.TOKEN_FRESH_MS);
  },

  async refreshToken(slug) {
    const target = slug || (AppView.appData && AppView.appData.slug) || null;
    if (!target) {
      AppView.iframeToken = null;
      AppView.iframeTokenSlug = null;
      return;
    }
    const token = await AppView._mintToken(target);
    if (token) {
      AppView.iframeToken = token;
      AppView.iframeTokenSlug = target;
    } else {
      // 404 (unknown app / no view access) or 400 — drop any stale token
      // rather than keeping one that no longer matches the open app.
      AppView.iframeToken = null;
      AppView.iframeTokenSlug = null;
    }
  },

  // The token to attach for `slug`, or null when the held token was minted
  // for a different app (or there is none).
  tokenForSlug(slug) {
    if (!slug || !AppView.iframeToken) return null;
    return AppView.iframeTokenSlug === slug ? AppView.iframeToken : null;
  },

  // Compose the production iframe src from the app origin, the pending
  // chromeless inner path (#743), and the iframe token — same URL-API
  // pattern as the staging buildSrc below, so an inner query composes
  // with the token param (and searchParams.set clobbers any `token`
  // smuggled inside the forwarded path). The origin check means a
  // hostile path (`/\evil.com` and friends) can never point the iframe
  // off the app's own origin — it falls back to the app root.
  buildAppIframeSrc() {
    const appUrl = resolveDevHost(AppView.appData.url);
    let url;
    try {
      url = new URL(AppView.pendingInnerPath || '/', appUrl);
      if (url.origin !== new URL(appUrl).origin) url = new URL(appUrl);
    } catch {
      try { url = new URL(appUrl); } catch { return appUrl; }
    }
    const token = AppView.tokenForSlug(AppView.appData && AppView.appData.slug);
    if (token) url.searchParams.set('token', token);
    return url.toString();
  },

  startTokenRefresh() {
    AppView.stopTokenRefresh();
    AppView.tokenRefreshInterval = setInterval(async () => {
      await AppView.refreshToken(AppView.appData && AppView.appData.slug);
      // Rewrite the iframe src so the child app picks up the fresh token.
      // Only when the App tab is the visible one; other tabs re-fetch on
      // next render anyway. Reuses the inner deep link so a mid-session
      // refresh doesn't yank the viewer back to the app root (#743).
      const iframe = document.getElementById('app-iframe');
      if (iframe && AppView.appData?.url
          && AppView.tokenForSlug(AppView.appData.slug)) {
        iframe.src = AppView.buildAppIframeSrc();
      }
    }, AppView.TOKEN_REFRESH_MS);
  },

  stopTokenRefresh() {
    if (AppView.tokenRefreshInterval) {
      clearInterval(AppView.tokenRefreshInterval);
      AppView.tokenRefreshInterval = null;
    }
  },

  // ==========================================================================
  // #931: eager app launch.
  //
  // The old sequence was: tap → zoom-in animates an EMPTY #app-view (opaque
  // --un-zoom-bg) → the animation finishes → open() fetches the detail →
  // then mints a token → only THEN is the iframe created. So the app's first
  // byte wasn't even requested until after the 380ms zoom, and the app
  // "popped in" over a white window.
  //
  // Now the iframe is mounted and pointed at the app INSIDE the transition's
  // reveal callback, off the cached list record (which already carries `url`),
  // so it loads during the animation. A cover — the app's own icon and name
  // on the theme background, so it reads as the app opening rather than as a
  // blank frame — sits on top and cross-fades out the moment the frame
  // reports load. When open() later resolves and switchTab renders the App
  // tab, renderAppTab ADOPTS this frame instead of rebuilding it, so there
  // is exactly one document load.
  // ==========================================================================

  // Reveal ladder (all relative to the src assignment):
  //   0ms      cover up, iframe at opacity 0, loading.
  //   500ms    add a small spinner to the cover — enough of a wait that a
  //            still frame would start to read as stuck.
  //   on load  cross-fade: iframe → 1, cover → 0, cover removed after the
  //            fade. This is the normal exit and usually lands mid-zoom.
  //   2000ms   reveal anyway. A `load` event can be arbitrarily late (or
  //            never fire, e.g. a download-disposition response); holding
  //            the cover past two seconds hides an app that is very likely
  //            already painting.
  //   20000ms  swap the cover note to a "taking longer" line. Only reachable
  //            when the cap was skipped because the mint hadn't settled.
  LAUNCH_SPINNER_MS: 500,
  LAUNCH_REVEAL_CAP_MS: 2000,
  LAUNCH_SLOW_MS: 20000,
  // Keep in sync with `.app-launch-cover` / `#app-iframe` transition
  // durations in public/css/app.css.
  LAUNCH_FADE_MS: 160,

  // Generation counter. Every launch, teardown and close bumps it; every
  // async callback (load, error, each timer, the post-mint src assignment)
  // re-checks it, so a superseded launch can never touch the DOM of the one
  // that replaced it.
  _launchId: 0,
  _launchTimers: [],
  // Set by beginLaunch to the exact (launchId, slug, src) it mounted, read
  // ONCE by renderAppTab to decide adopt-vs-rebuild.
  _launchAdopt: null,

  _reduceMotion() {
    try {
      return !!(window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch { return false; }
  },

  // Cleared IN PLACE, not reassigned: watchSurfaceLoad captures the array
  // it pushes into, so swapping in a fresh one would leave a re-armed
  // ladder pushing timers nobody can cancel.
  _clearLaunchTimers() {
    AppView._launchTimers.forEach((t) => clearTimeout(t));
    AppView._launchTimers.length = 0;
  },

  // ── App-view surface flag (#970) ────────────────────────────────────
  //
  // Which KIND of thing is mounted in #app-content right now:
  //   'app'      — a running app's iframe (or its launch cover), which
  //                must reach the true bottom edge of the screen. The
  //                shell reserves no home-indicator strip; the insets are
  //                forwarded into the app instead (see the safe-area
  //                section near the bottom of this file).
  //   'platform' — anything WE render (Dev mode and all its sub-views,
  //                the creating / awaiting-secrets / error / offline
  //                placeholders), which keeps its clearance above the
  //                home indicator.
  //
  // The bottom padding itself lives in app.css, keyed on the attribute
  // this sets — see `#app-view[data-app-surface="platform"]`. Every place
  // that owns #app-content's contents calls this, so the flag can never
  // drift from what is actually on screen. Changing surface also changes
  // the frame's rect, so a change re-broadcasts the insets.
  // Purely presentational, and called from the middle of every render —
  // so it must never be able to throw one. Feature-detected rather than
  // assumed: #app-view may be absent (a sub-page that never mounts it) or
  // a partial stub (the node-side render tests), and neither is a reason
  // to fail the surface it was about to paint.
  _setSurface(kind) {
    const view = typeof document !== 'undefined' && document.getElementById
      ? document.getElementById('app-view') : null;
    if (!view || typeof view.setAttribute !== 'function') return;
    const next = kind === 'app' ? 'app' : 'platform';
    if (typeof view.getAttribute === 'function'
        && view.getAttribute('data-app-surface') === next) {
      return;
    }
    view.setAttribute('data-app-surface', next);
    AppView.scheduleSafeAreaBroadcast();
  },

  // Abandon any in-flight launch: bump the generation (so pending callbacks
  // go inert), drop the adoption offer, stop the timers. Does NOT touch the
  // DOM — callers either replace #app-content wholesale or are hiding it.
  _teardownLaunch() {
    AppView._launchId += 1;
    AppView._launchAdopt = null;
    AppView._clearLaunchTimers();
  },

  // home.js is a classic script: its `const Home = {…}` is a top-level
  // LEXICAL binding, reachable as a bareword from other classic scripts but
  // NOT a property of window (the same trap the `window.AppView = AppView`
  // note at the bottom of this file documents — home.js never made that
  // assignment). Gating on `window.Home` here would be permanently false in
  // a real browser and would silently disable the whole eager launch.
  _home() {
    try {
      if (typeof Home !== 'undefined' && Home) return Home;
    } catch { /* not defined in this context */ }
    return (typeof window !== 'undefined' && window.Home) || null;
  },

  // The cached list record for `slug`, from whichever surface the user
  // tapped. Both caches hold the /api/apps payload, which carries `url`,
  // `status` and the icon fields — everything the launch surface needs.
  launchRecordFor(slug) {
    if (!slug) return null;
    const home = AppView._home();
    const fromHome = home && Array.isArray(home._apps)
      ? home._apps.find((a) => a && a.slug === slug) : null;
    if (fromHome) return fromHome;
    const fromBrowse = window.Browse && typeof Browse.appBySlug === 'function'
      ? Browse.appBySlug(slug) : null;
    return fromBrowse || null;
  },

  // Only launch eagerly when the frame we'd mount is the same frame
  // renderAppTab would build. Anything else (a self-hosted app, whose
  // default tab is Dev; a demo card, which has no real origin; an explicit
  // non-app tab; offline) falls back to the old path untouched.
  canEagerLaunch(slug, tab) {
    if (tab && tab !== 'app') return false;
    if (window.Offline && Offline.isOffline()) return false;
    const rec = AppView.launchRecordFor(slug);
    if (!rec) return false;
    if (rec.demo) return false;
    if (rec.self_hosted) return false;
    if (rec.status !== 'running' || !rec.url) return false;
    return true;
  },

  // The one place the sandboxed-iframe attribute contract is written.
  // NOTE: when `src` is null the attribute is OMITTED entirely — `src=""`
  // resolves against the parent document, which would load the platform
  // shell inside its own app frame.
  _appIframeHtml({ src = null, hidden = false } = {}) {
    const srcAttr = src ? `\n        src="${src}"` : '';
    const styleAttr = hidden ? '\n        style="opacity:0"' : '';
    return `
      <iframe
        id="app-iframe"${srcAttr}${styleAttr}
        class="w-full h-full border-0"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock"
        allow="clipboard-write; pointer-lock"
      ></iframe>`;
  },

  // The cover: app icon + name on the theme background. `pinned` marks a
  // cover that must never be revealed away (the screenshot state).
  _launchCoverHtml(record, { id = 'app-launch-cover', pinned = false } = {}) {
    const home = AppView._home();
    const tile = home && typeof home.iconTileFor === 'function'
      ? home.iconTileFor(record || {})
      : { kind: 'letter', html: escapeHtml(((record && record.name) || '?').charAt(0).toUpperCase()) };
    const name = escapeHtml((record && record.name) || '');
    return `
      <div id="${id}" class="app-launch-cover"${pinned ? ' data-pinned="true"' : ''} aria-hidden="true">
        <div class="app-icon-tile app-launch-cover-icon" data-icon="${tile.kind}">${tile.html}</div>
        <p class="app-launch-cover-name">${name}</p>
        <p class="app-launch-cover-note" id="${id}-note">Opening…</p>
        <div class="dc-status-spinner-arc app-launch-cover-spinner hidden" id="${id}-spinner"></div>
      </div>`;
  },

  // Mount the launch surface and start the app loading. Called from inside
  // PlatformUI.transition's reveal callback in App.navigateToApp, so the
  // frame exists before the zoom's first frame paints. Returns true when it
  // took over; false leaves the old (empty-then-render) path in place.
  beginLaunch(slug, tab) {
    if (!AppView.canEagerLaunch(slug, tab)) return false;
    const content = document.getElementById('app-content');
    if (!content) return false;
    const rec = AppView.launchRecordFor(slug);

    AppView._launchId += 1;
    const launchId = AppView._launchId;
    AppView._clearLaunchTimers();
    AppView._launchAdopt = null;
    // #685: a new frame invalidates any prior issue-state announcement,
    // same reason renderAppTab clears it.
    AppView._issueStateSource = null;

    // Stand appData up from the list record so buildAppIframeSrc (and any
    // status-driven re-render that arrives mid-launch) has something
    // consistent to read. open() replaces it with the full detail payload.
    AppView.appData = rec;

    content.innerHTML = `
      <div class="app-launch-host w-full h-full">
        ${AppView._appIframeHtml({ hidden: true })}
        ${AppView._launchCoverHtml(rec)}
      </div>`;
    // #970: an app frame is on screen from this moment — the shell stops
    // reserving the home-indicator strip and forwards it to the app.
    AppView._setSurface('app');

    const iframe = document.getElementById('app-iframe');
    if (!iframe) return false;

    const proceed = (src) => {
      if (launchId !== AppView._launchId) return;
      if (!src || !iframe.isConnected) return;
      // Record the exact src so renderAppTab can prove the frame it finds
      // is the frame it would have built — a mismatch (deep link, token
      // refresh, different app) rebuilds instead of adopting.
      AppView._launchAdopt = { launchId, slug, src };
      AppView._watchLaunchLoad(iframe, launchId);
      iframe.src = src;
    };

    if (AppView.hasFreshToken(slug)) {
      // Prewarm landed: no await, so the document request goes out in the
      // same tick as the tap.
      AppView.iframeToken = AppView._tokenFresh.token;
      AppView.iframeTokenSlug = slug;
      proceed(AppView.buildAppIframeSrc());
    } else {
      // Wait for the mint to SETTLE (not just resolve successfully) before
      // assigning src, so the eager src is byte-identical to the one
      // renderAppTab builds — including the no-token case.
      AppView.refreshToken(slug).then(() => {
        if (launchId !== AppView._launchId) return;
        if (!AppView.appData || AppView.appData.slug !== slug) return;
        proceed(AppView.buildAppIframeSrc());
      });
      // A mint that never settles would leave a src-less frame under the
      // cover; the spinner and slow-note rungs still run, and the reveal
      // cap deliberately does not (see _watchLaunchLoad).
      AppView._watchLaunchLoad(iframe, launchId);
    }
    return true;
  },

  // The reveal ladder, over any (iframe, cover) pair. Two callers: the App
  // tab's launch (below) and the anonymous landing viewer, which mounts the
  // same cover over #app-viewer-frame. `isCurrent` is the caller's
  // "still the surface on screen" predicate — every async branch re-checks
  // it, so a superseded surface can never touch the DOM. Timers are pushed
  // into the caller's own array so it can cancel them on teardown.
  watchSurfaceLoad(iframe, { iframeId, coverId, isCurrent, timers }) {
    const current = () => !!isCurrent() && iframe.isConnected;
    const reveal = () => AppView._revealLaunch({ iframeId, coverId, timers });

    iframe.onload = () => {
      // A src-less mount navigates to about:blank, which fires `load`.
      // Ignore it — revealing here would show an empty frame.
      if (!iframe.getAttribute('src')) return;
      if (!current()) return;
      if (iframeId === 'app-iframe') AppView.iframeFocused = true;
      // #970: the app's document is up — hand it this frame's insets.
      AppView.scheduleSafeAreaBroadcast();
      reveal();
    };
    iframe.onerror = () => {
      if (!iframe.getAttribute('src')) return;
      if (!current()) return;
      // Nothing better to show than the app's own frame: it will render
      // whatever the origin returned (its own error page, usually).
      reveal();
    };

    const at = (ms, fn) => timers.push(setTimeout(() => {
      if (!current()) return;
      fn();
    }, ms));

    at(AppView.LAUNCH_SPINNER_MS, () => {
      document.getElementById(`${coverId}-spinner`)?.classList.remove('hidden');
    });
    at(AppView.LAUNCH_REVEAL_CAP_MS, () => {
      // Never strip the cover off a frame that has no src yet (a stalled
      // mint) — that would reveal a blank white iframe, the exact bug this
      // whole change removes.
      if (!iframe.getAttribute('src')) return;
      reveal();
    });
    at(AppView.LAUNCH_SLOW_MS, () => {
      const note = document.getElementById(`${coverId}-note`);
      if (note) note.textContent = 'This is taking longer than expected…';
    });
  },

  // Arm the ladder for the App tab's launch. Idempotent per generation:
  // called once when the src is known synchronously, or once up-front plus
  // once more after the mint settles — re-arming resets the same handlers,
  // and clearing first re-bases every rung on the src assignment.
  _watchLaunchLoad(iframe, launchId) {
    if (launchId !== AppView._launchId) return;
    AppView._clearLaunchTimers();
    AppView.watchSurfaceLoad(iframe, {
      iframeId: 'app-iframe',
      coverId: 'app-launch-cover',
      isCurrent: () => launchId === AppView._launchId,
      timers: AppView._launchTimers,
    });
  },

  // Cross-fade the app in and the cover out. Safe to call more than once.
  _revealLaunch(opts = {}) {
    const iframeId = opts.iframeId || 'app-iframe';
    const coverId = opts.coverId || 'app-launch-cover';
    // Once revealed, the remaining rungs (spinner, cap, slow note) are moot.
    const timers = opts.timers || AppView._launchTimers;
    timers.forEach((t) => clearTimeout(t));
    timers.length = 0;
    const iframe = document.getElementById(iframeId);
    if (iframe) iframe.style.opacity = '1';
    const cover = document.getElementById(coverId);
    if (!cover) return;
    // The screenshot state pins its cover: it is the subject of the shot.
    if (cover.dataset.pinned === 'true') return;
    if (AppView._reduceMotion()) {
      cover.remove();
      return;
    }
    cover.classList.add('app-launch-cover--out');
    setTimeout(() => cover.remove(), AppView.LAUNCH_FADE_MS + 40);
  },

  // #931: the anonymous landing viewer's launch surface. Its iframe is a
  // fixed element in index.html rather than markup this module writes, so
  // instead of replacing a container the cover is APPENDED to the viewer
  // host (which the CSS makes a positioning context) and the frame is faded
  // in underneath. Same cover markup and same ladder as the App tab; the
  // caller owns the generation counter and the timer array, and removes the
  // cover on close. No token is involved — landing apps are public.
  mountViewerCover(host, iframe, record, { timers, isCurrent }) {
    if (!host || !iframe) return;
    host.classList.add('app-launch-host');
    const coverId = 'app-viewer-cover';
    document.getElementById(coverId)?.remove();
    iframe.style.opacity = '0';
    // insertAdjacentHTML, not innerHTML: the frame is a long-lived element
    // in the document — replacing the host's children would destroy it.
    host.insertAdjacentHTML('beforeend', AppView._launchCoverHtml(record, { id: coverId }));
    AppView.watchSurfaceLoad(iframe, {
      iframeId: iframe.id,
      coverId,
      isCurrent,
      timers,
    });
  },

  // #931: paint the launch surface with NO app behind it, spinner showing.
  // Screenshot-state deep link only (`?shot=app-launching`) — a real launch
  // always goes through beginLaunch. The record falls back to a self-
  // contained stub so this renders against a fresh, empty database.
  showLaunchCoverShot() {
    const content = document.getElementById('app-content');
    if (!content) return;
    const home = AppView._home();
    const apps = (home && Array.isArray(home._apps)) ? home._apps : [];
    // Prefer an app a tap could really open (so the shot shows a real icon),
    // then any app at all, then a self-contained stub — the fallback is what
    // makes this link work against a fresh, empty checks database.
    const rec = apps.find((a) => a && a.status === 'running' && a.url && !a.demo)
      || apps[0]
      || { slug: 'staging-demo-launch', name: 'Staging demo app', icon_emoji: '🚀' };
    AppView._launchId += 1;
    AppView._clearLaunchTimers();
    AppView._launchAdopt = null;
    // Pinned: nothing may reveal this away, and no iframe is mounted at all
    // (the shot is the cover, and a frame would try to load a real origin).
    content.innerHTML = `
      <div class="app-launch-host w-full h-full">
        ${AppView._launchCoverHtml(rec, { pinned: true })}
      </div>`;
    // #970: the shot stands in for a real launch, so it gets the same
    // full-bleed geometry the launch it depicts would have.
    AppView._setSurface('app');
    document.getElementById('app-launch-cover-spinner')?.classList.remove('hidden');
    document.getElementById('home-screen')?.classList.add('hidden');
    document.getElementById('app-view')?.classList.remove('hidden');
    document.getElementById('back-btn')?.classList.remove('hidden');
  },

  renderAppTab() {
    const content = document.getElementById('app-content');
    const appData = AppView.appData;

    // #685: every render replaces the iframe (or removes it), so any
    // prior issue-state announcement is stale. A WindowProxy keeps its
    // identity across same-iframe navigations, so clearing here (not
    // just on close) is what invalidates it on re-render.
    AppView._issueStateSource = null;

    if (!appData || appData.status !== 'running' || !appData.url) {
      // #931: this branch replaces #app-content, so any launch surface under
      // it is gone — retire the generation so its pending callbacks and the
      // adoption offer can't outlive the frame they belong to.
      AppView._teardownLaunch();
      let inner;
      if (appData?.status === 'creating') {
        inner = '<div class="status-dot creating"></div><p class="text-sm">App is spinning up...</p>';
      } else if (appData?.status === 'awaiting_secrets') {
        const missing = Array.isArray(appData.missingSecrets) && appData.missingSecrets.length
          ? appData.missingSecrets : (appData.missingSecrets || []);
        const missingList = missing.length
          ? `<p class="text-xs font-mono text-red-500">${missing.map(escapeHtml).join(', ')}</p>` : '';
        inner = `
          <div class="status-dot creating"></div>
          <p class="text-sm">Awaiting required secrets — deploy is blocked.</p>
          ${missingList}
          <button id="awaiting-open-secrets"
            class="mt-3 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white">
            Configure secrets
          </button>
        `;
      } else if (appData?.status === 'error') {
        // #416: show the one-line failure reason (server-gated
        // `lastFailure` from the detail fetch, or the live WS
        // errorReason) plus a "View build log" button for involved
        // users. Outsiders keep the bare failed-to-start state.
        const failReason = (appData.lastFailure && appData.lastFailure.reason)
          || appData.errorReason || null;
        const reasonHtml = failReason
          ? `<p class="text-xs font-mono text-red-500 max-w-md break-words">${escapeHtml(String(failReason).slice(0, 280))}</p>`
          : '';
        const involved = !!(appData.lastFailure || appData.is_collaborator || appData.can_manage);
        const logBtnHtml = involved
          ? `<button id="app-error-build-log"
              class="mt-3 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white">
              View build log
            </button>`
          : '';
        inner = `
          <div class="status-dot error"></div>
          <p class="text-sm">App failed to start</p>
          ${reasonHtml}
          ${logBtnHtml}
        `;
      } else {
        inner = '<p class="text-sm">App not available</p>';
      }
      content.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full text-zinc-500 dark:text-zinc-400 gap-2 p-4 text-center">
          ${inner}
        </div>`;
      // #970: platform-rendered status text, not an app — keep the
      // home-indicator clearance.
      AppView._setSurface('platform');
      // The "Configure secrets" button is wired here rather than via a
      // delegated handler because this branch re-renders on every
      // status change and the listener would otherwise re-attach.
      const openBtn = document.getElementById('awaiting-open-secrets');
      if (openBtn && window.Secrets && appData?.slug) {
        openBtn.addEventListener('click', () => Secrets.open(appData.slug));
      }
      // Same wiring rationale for the build-log button (#416).
      const buildLogBtn = document.getElementById('app-error-build-log');
      if (buildLogBtn && window.BuildLog && appData?.slug) {
        buildLogBtn.addEventListener('click', () => BuildLog.open(appData.slug));
      }
      // Status updates pushed via WebSocket — no polling needed
      return;
    }

    // Offline mode (#487): the running app lives on its own subdomain —
    // a different origin the platform's service worker can't cache — so
    // offline the iframe would render a broken frame. Show a placeholder
    // instead and re-render automatically once connectivity returns.
    if (window.Offline && Offline.isOffline()) {
      AppView._teardownLaunch();
      content.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full text-zinc-500 dark:text-zinc-400 gap-2 p-4 text-center">
          <p class="text-sm">This app needs a connection — reconnect to open it.</p>
        </div>`;
      // #970: our placeholder, not the app — keep the clearance.
      AppView._setSurface('platform');
      const retry = (ev) => {
        if (ev.detail && ev.detail.offline) return;
        window.removeEventListener('usernode:offline-change', retry);
        // Only re-render if this app's App tab is still what's on screen.
        if (AppView.appData === appData) AppView.renderAppTab();
      };
      window.addEventListener('usernode:offline-change', retry);
      return;
    }

    const iframeSrc = AppView.buildAppIframeSrc();

    // #931: one-shot adoption. beginLaunch may already have mounted this
    // exact frame during the open animation; read the offer and null it in
    // the same breath, so only the FIRST render after a launch can adopt.
    // Every later render (WS status flip, swapToProduction, the offline
    // retry, a post-merge reload) rebuilds as it always did.
    const adopt = AppView._launchAdopt;
    AppView._launchAdopt = null;
    if (adopt
        && adopt.launchId === AppView._launchId
        && adopt.slug === appData.slug
        && adopt.src === iframeSrc
        && document.getElementById('app-iframe')) {
      // Same app, same URL, frame already loading (or loaded) — touching
      // the DOM here would restart the document load and undo the whole
      // point of the eager launch. The surface flag still has to be
      // asserted (#970): beginLaunch set it, but a render that adopts must
      // not depend on that, or an adopted launch could keep a stale flag.
      AppView._setSurface('app');
      return;
    }
    AppView._teardownLaunch();

    content.innerHTML = AppView._appIframeHtml({ src: iframeSrc });
    // #970: full-bleed frame; the insets go to the app instead.
    AppView._setSurface('app');

    const iframe = document.getElementById('app-iframe');
    iframe.addEventListener('load', () => {
      AppView.iframeFocused = true;
      // #970: the app's document is up — hand it the insets that apply to
      // this frame's rect. Also covers the token-refresh re-src, which
      // reloads the frame without re-rendering.
      AppView.scheduleSafeAreaBroadcast();
    });
  },

  // #21: fetch + render the "live on <sha> · PR #N" pill. Called on App
  // tab render and again whenever an `app_version_changed` or
  // `app_redeploy_status` WS event fires for this app (so the pill
  // updates live when a PR merges in another tab/session, and turns
  // yellow + spinning while the rebuild is in flight).
  async refreshVersionPill() {
    const slot = document.getElementById('app-version-pill-slot');
    if (!slot || !AppView.appData) return;
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/version`);
      if (!res.ok) return;
      const info = await res.json();
      slot.innerHTML = AppView.renderAppVersionPillHTML({
        slug: AppView.appData.slug,
        version: info.sha ? info : null,
        deployProgress: info.deployProgress || null,
        // The drawer footer's line gets the richer PR-context tooltip
        // (title + author + merge time). The home-screen card uses the
        // same helper without this and gets the plain commit-hash tip.
        includePrContext: true,
        // Text form, not a pill — the footer line is labelled "App".
        plain: true,
      });
      // Mirror the deploying state onto the hamburger — the pill itself
      // is only visible with the drawer open.
      if (window.App?.DrawerStatus) App.DrawerStatus.refreshDeployDot();
    } catch {
      // Non-critical; if the fetch fails the pill just doesn't render.
    }
  },

  // Apply a deploy-progress update to the header pill without going
  // back to the server. Called from the `app_redeploy_status` WS
  // handler so the pill flips into its yellow/spinner state the
  // instant the broadcast arrives, even before refreshVersionPill
  // would re-fetch on the trailing `app_version_changed` event.
  applyHeaderDeployProgress(deployProgress) {
    const slot = document.getElementById('app-version-pill-slot');
    if (!slot || !AppView.appData) return;
    // Preserve whatever version data the previous render captured by
    // re-querying the DOM — the slot stores all the fields we'd need
    // via dataset. We don't need them, though: while deploying we
    // render a stripped-down pill that doesn't show the prior SHA.
    slot.innerHTML = AppView.renderAppVersionPillHTML({
      slug: AppView.appData.slug,
      version: null, // hidden during deploy; the next refresh fills it in
      deployProgress,
      includePrContext: true,
      plain: true,
    });
    if (window.App?.DrawerStatus) App.DrawerStatus.refreshDeployDot();
  },

  // Single source of truth for the per-app version pill. Used by both
  // the header (AppView) and the home-screen cards (Home), so the two
  // surfaces stay visually identical and stay in lockstep when new
  // states (e.g. a future "rollback available" variant) are added.
  //
  // `version` shape: { sha, shortSha, prNumber, prUrl?, commitUrl?,
  // prTitle?, mergedBy?, mergedAt? } — null means "no SHA yet".
  // `deployProgress` shape: { deploying:true, startedAt, fromSha,
  // toSha?, failed?, stale? } — null means "no in-flight deploy".
  renderAppVersionPillHTML(opts) {
    const slug = opts && opts.slug ? String(opts.slug) : '';
    const version = opts && opts.version;
    const deployProgress = opts && opts.deployProgress;
    const includePrContext = !!(opts && opts.includePrContext);
    // `plain` callers want the drawer footer's TEXT form instead of a
    // pill: a bare mono version beside the row's own "App" label, no
    // border, no slug, no status dot. Same states, same tooltips — only
    // the chrome differs, so the two surfaces can't drift apart.
    const plain = !!(opts && opts.plain);
    const cls = plain
      ? { base: 'drawer-ver', deploying: 'drawer-ver--deploying', dev: 'drawer-ver--dev', spinner: 'drawer-ver-spinner' }
      : { base: 'app-version-pill', deploying: 'app-version-pill--deploying', dev: '', spinner: 'app-version-pill-spinner' };
    // `quiet` callers want a border-only chip with no state modifiers
    // even when a deploy is in flight — the home-tile pills use it so
    // the tile's status dot is the single visual signal for "this app
    // is redeploying" (yellow pulse). Without quiet the pill would
    // double-signal the same event next to the status dot.
    const quiet = !!(opts && opts.quiet);
    if (!slug) return '';

    // Slug prefix (`<slug> ·`) is shown only in quiet mode (home tiles),
    // where it's the *only* identifier — there's no other affordance on
    // the card telling you which commit pill belongs to which app. In
    // the AppView header (non-quiet), the page title already names the
    // app, so repeating the slug inside the pill just widens the right
    // group and pushes the title into truncation territory. Dropping it
    // there is the second half of the title-overlap fix (the first half
    // is the grid header layout in index.html — see the comment there).
    const slugPart = quiet
      ? `<span class="app-version-pill-name">${escapeHtml(slug)}</span><span class="app-version-pill-sep">·</span>`
      : '';

    const isDeploying = !quiet && !!(deployProgress && deployProgress.deploying);
    if (isDeploying) {
      const elapsed = deployProgress.startedAt
        ? Math.max(0, Math.floor((Date.now() - new Date(deployProgress.startedAt).getTime()) / 1000))
        : null;
      const tipParts = ['Redeploying'];
      if (deployProgress.fromSha) tipParts.push(`from ${String(deployProgress.fromSha).slice(0, 7)}`);
      if (elapsed != null) tipParts.push(`${elapsed}s elapsed`);
      const tip = tipParts.join(' · ');
      if (plain) {
        return `
          <span class="${cls.base} ${cls.deploying}" title="${escapeAttr(tip)}">
            <span class="${cls.spinner}" aria-hidden="true"></span>deploying
          </span>`;
      }
      return `
        <span class="app-version-pill app-version-pill--deploying" title="${escapeAttr(tip)}">
          <span class="app-version-pill-spinner" aria-hidden="true"></span>
          <span class="app-version-pill-label">
            ${slugPart}
            deploying
          </span>
        </span>`;
    }

    if (!version || !version.sha) {
      // Mirror the platform-version pill's "dev" state: render a
      // low-key chip so the slot is never empty (which can look like
      // a layout bug or a JS failure to render). Reachable for apps
      // still in `creating`, apps without a repo, or pre-#21 rows
      // that haven't been backfilled yet. The leading status dot is
      // dropped in quiet mode (home tiles) — the tile already has its
      // own status dot at the top.
      if (plain) {
        return `
          <span class="${cls.base} ${cls.dev}" title="No deployed version recorded yet">dev</span>`;
      }
      return `
        <span class="app-version-pill" title="No deployed version recorded yet">
          ${quiet ? '' : '<span class="app-version-pill-dot" style="background:#71717a;box-shadow:none"></span>'}
          <span class="app-version-pill-label">
            ${slugPart}
            dev
          </span>
        </span>`;
    }

    const href = version.prUrl || version.commitUrl || '#';
    const parts = [];
    if (includePrContext && version.prTitle) parts.push(version.prTitle);
    if (includePrContext && version.mergedBy) parts.push(`by @${version.mergedBy}`);
    if (includePrContext && version.mergedAt) parts.push(relTime(version.mergedAt));
    const tip = parts.length ? parts.join(' · ') : `Commit ${version.shortSha}`;
    const sha = version.prNumber
      ? `${version.shortSha} · #${version.prNumber}`
      : version.shortSha;
    // Drop the green status dot inside the pill in quiet mode for the
    // same reason as the dev branch above — the home tile's outer
    // status dot already covers "this app's lifecycle state", and the
    // user doesn't need a second tiny dot duplicating it inside the
    // commit chip.
    if (plain) {
      return `
        <a href="${href}" target="_blank" rel="noopener" class="${cls.base}" title="${escapeAttr(tip)}">${escapeHtml(sha)}</a>`;
    }
    return `
      <a href="${href}" target="_blank" rel="noopener" class="app-version-pill" title="${escapeAttr(tip)}">
        ${quiet ? '' : '<span class="app-version-pill-dot"></span>'}
        <span class="app-version-pill-label">
          ${slugPart}
          ${escapeHtml(sha)}
        </span>
      </a>`;
  },

  // Returns the mount point for dev-view section renderers: the
  // #dev-section slot inside the Dev mode's sub-tab layout when present,
  // falling back to #app-content (defensive — every call site should be
  // inside renderDevView these days).
  _devContainer() {
    return document.getElementById('dev-section') || document.getElementById('app-content');
  },

  // ── Dev mode (#194, forum revision): one page ──────────────────────
  // subTab ∈ 'forum' | 'sessions'. For 'sessions', `ref` is the dev
  // session id (no id → forum). For 'forum', `ref` is an optional
  // { kind: 'issue'|'proposal', id } deep link naming the card to
  // expand.
  async renderDevView(subTab, ref) {
    const content = document.getElementById('app-content');
    if (!content) return;

    // #970: every Dev sub-view below is platform-rendered (card list,
    // chat, session, topic) and wants clearance above the home indicator.
    // Set once here rather than per branch — they all replace #app-content.
    AppView._setSurface('platform');

    // Capture the Dev list's scroll position before any branch below
    // overwrites #app-content. #dev-forum-scroll only exists when the
    // outgoing view was the card list, so this is a no-op for
    // topic/session/chat sub-views. Every back-navigation re-enters
    // renderDevView, so this single point covers the Back buttons,
    // browser back/forward, and programmatic navigation alike.
    const outgoingScroll = document.getElementById('dev-forum-scroll');
    if (outgoingScroll) AppView._saveFeedScroll(App.currentApp, outgoingScroll.scrollTop);

    // Leaving whatever thread surface was open: drop the live render
    // target so incoming thread messages turn into badge bumps.
    if (typeof GroupChat !== 'undefined' && GroupChat.unmountThread) GroupChat.unmountThread();
    if (subTab !== 'topic') AppView._devTopic = null;

    // Session view — a single DevChat session, full-screen, reached
    // from the Your-sessions strip, proposal cards, or the "+" flow.
    if (subTab === 'sessions' && ref) {
      content.innerHTML = `
        <div class="flex flex-col h-full min-h-0">
          <div id="dev-section" class="flex-1 min-h-0 flex flex-col" style="overflow:hidden"></div>
        </div>`;
      await AppView.renderDevChatTab(ref);
      return;
    }

    // Full-screen general chat (card-list revision: chat is a card you
    // tap into, not a pinned pane).
    if (subTab === 'chat') {
      AppView._renderChatSubView(content);
      return;
    }

    // Full-screen topic (issue / proposal / governance) discussion.
    if (subTab === 'topic' && ref && ref.kind && ref.id) {
      await AppView._renderTopicSubView(content, ref);
      return;
    }

    // The card list.
    AppView._feedShown = 20;
    // #482: kanban filters are NOT reset here — they persist per app across
    // in-app navigation and are (re)loaded per slug from sessionStorage when
    // the board mounts in _repaintDevBody. Resetting on every card-list mount
    // was the cause of filters vanishing on Back / tab switches.

    content.innerHTML = `
      <div class="flex flex-col h-full min-h-0">
        <!-- Header bar: caption + view-mode toggle + the "+" menu (top
             right). The "DEV" caption renders ONLY when the header's
             #app-mode-switch is hidden — i.e. on the self-hosted platform
             row. Everywhere else the header now says "Dev" a few pixels
             above this row, and printing it twice reads as a bug. The
             flex-1 spacer keeps the toggle and "+" right-aligned either
             way. -->
        <div class="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          ${AppView.appData?.self_hosted
            ? '<span class="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider flex-1">Dev</span>'
            : '<span class="flex-1"></span>'}
          ${AppView._renderViewToggle()}
          <div class="relative ${AppView.readOnly && AppView.appData?.self_hosted ? 'hidden' : ''}">
            <button id="dev-plus-btn" aria-haspopup="true" aria-expanded="false"
              class="rounded-lg bg-violet-600 hover:bg-violet-500 w-7 h-7 flex items-center justify-center text-base font-bold leading-none text-white transition-colors"
              title="${AppView.readOnly ? 'Fork this app' : 'Propose a change, file an issue, or manage this app'}">+</button>
            <div id="dev-plus-menu" class="hidden absolute right-0 top-9 z-30 w-64 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden">
              ${AppView.readOnly ? '' : `
              <button data-plus="proposal" class="w-full text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Propose a change</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">Start an AI dev session — promoting its PR creates the proposal</span>
              </button>
              ${AppView.appData?.can_collaborate ? `
              <button data-plus="import-pr" class="w-full text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors border-t border-zinc-200 dark:border-zinc-800">
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Import Feature from a PR</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">Turn an existing GitHub pull request into a proposal people can vote on</span>
              </button>` : ''}
              <button data-plus="proposal-external" class="w-full text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors border-t border-zinc-200 dark:border-zinc-800">
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Propose with Claude Code or Codex</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">Build it on your own Claude or ChatGPT plan — no Usernode credits</span>
              </button>
              <button data-plus="issue" class="w-full text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors border-t border-zinc-200 dark:border-zinc-800">
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">New issue</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">Report a problem or idea without building it yourself</span>
              </button>
              ${AppView._plusMenuShowsMembers() ? `
              <button data-plus="members" class="w-full text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors border-t border-zinc-200 dark:border-zinc-800">
                ${AppView.appData?.self_hosted ? `
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Proposal approvals</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">Who approves proposals and how many approvals are needed</span>` : `
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Members &amp; visibility</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">Who can build and see this app</span>`}
              </button>` : ''}
              <button data-plus="rename" class="w-full text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors border-t border-zinc-200 dark:border-zinc-800">
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">App display name</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">Renames are proposals — applied once voted in</span>
              </button>
              <button data-plus="secrets" class="w-full text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors border-t border-zinc-200 dark:border-zinc-800">
                <span class="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">${
                  AppView.appData?.self_hosted ? 'Platform variables' : 'App secrets'}
                  <span id="dc-secrets-state" class="text-xs font-normal text-zinc-400 dark:text-zinc-500"></span>
                </span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">${AppView.appData?.self_hosted
                  ? 'The platform\'s own env — applied on its next deploy'
                  : 'Set or update secret values'}</span>
              </button>`}
              ${AppView.appData?.self_hosted ? '' : `
              <button data-plus="fork" class="w-full text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors ${AppView.readOnly ? '' : 'border-t border-zinc-200 dark:border-zinc-800'}">
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Fork this app</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">Stand up your own independent copy</span>
              </button>`}
            </div>
          </div>
        </div>

        <!-- The card list: locked notice, general-chat card, session
             rows, the intermixed feed, and the Completed section. -->
        <div id="dev-forum-scroll" class="flex-1 min-h-0 overflow-y-auto overscroll-contain platform-safe-scroll">
          <div id="dev-locked-notice" class="px-3 pt-2 hidden"></div>
          <div class="px-3 pt-2">
            <button id="dev-chat-card" class="${AppView.DEV_CARD_CLS} ${AppView.DEV_CARD_HOVER_CLS}"
              title="Open the general chat">
              ${AppView._devCardIcon('chat')}
              <span class="flex-1 min-w-0">
                <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">General chat</span>
                <span id="dev-chat-card-preview" class="block text-xs text-zinc-500 dark:text-zinc-400 truncate">Talk with everyone building this app</span>
              </span>
              <svg class="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            </button>
          </div>
          <!-- Body region: list mode mounts #dev-feed + #gc-merged here;
               kanban mode mounts #dev-kanban. _repaintDevBody() owns the
               swap. The wrapper node is stable across mode switches so the
               delegated card-open handler (bound below) survives both. -->
          <div id="dev-body" class="px-3 py-2">
            <div id="dev-feed"><div class="text-xs text-zinc-500 dark:text-zinc-400">Loading…</div></div>
            <div id="gc-merged" class="mt-4"></div>
          </div>
        </div>
      </div>`;

    AppView._wirePlusMenu(content);
    // Pull down on the dev feed to re-pull it (touch only; the scroller
    // is re-created on every render so this re-attaches each time).
    const devScroll = document.getElementById('dev-forum-scroll');
    if (devScroll) {
      PlatformUI.pullToRefresh(devScroll, () => AppView._loadDevFeed());
    }
    AppView._wireViewToggle(content);
    AppView._attrInit();
    AppView._cardMenuInit();
    document.getElementById('dev-chat-card').addEventListener('click', () => {
      App.switchTab('dev', null, 'chat');
    });
    AppView._loadChatCardPreview();

    // Delegated card-open handler: tapping a topic card anywhere except
    // its links/pills opens that topic full-screen. Bound on the stable
    // #dev-body wrapper (its innerHTML re-renders on every repaint and
    // mode switch, but the node itself survives until the next
    // renderDevView). One handler covers issue / proposal / gov rows in
    // the list feed, merged rows in the Completed block, and every card
    // in the kanban columns — they all carry the same
    // data-issue-row / data-proposal-row / data-gov-row hooks.
    const bodyEl = document.getElementById('dev-body');
    bodyEl.addEventListener('click', (e) => {
      // #313/#827: the card-level "Explore in dev chat" button is a
      // <button>, so the guard below would swallow it — handle it first,
      // then bail. The node is passed along so the opener can disable it
      // for the duration (a double-tap would otherwise create two chats).
      const exploreBtn = e.target.closest('.gc-explore-chat-btn');
      if (exploreBtn) {
        AppView.exploreProposalInDevChat(exploreBtn.dataset.proposalId, exploreBtn);
        return;
      }
      // Session-card controls used to be inline pills delegated from here
      // (share / unshare / share-chat / read-chat / archive). They are now
      // ⋯ menu descriptors whose `act` closures call the same methods
      // directly, so those branches are gone — only the hooks that still
      // appear in card markup remain below.
      const unarchiveBtn = e.target.closest('[data-unarchive-chip]');
      if (unarchiveBtn) { AppView._unarchiveSession(parseInt(unarchiveBtn.dataset.unarchiveChip, 10), unarchiveBtn); return; }
      const archToggle = e.target.closest('[data-archived-toggle]');
      if (archToggle) { AppView._toggleArchivedList(archToggle); return; }
      if (e.target.closest('a, button, input, form')) return;
      const sessionChip = e.target.closest('[data-session-chip]');
      if (sessionChip) {
        // Own session → the owner's dev chat, exactly as the old strip.
        App.switchTab('dev', parseInt(sessionChip.dataset.sessionChip, 10), 'sessions');
        return;
      }
      const sharedRow = e.target.closest('[data-shared-session-row]');
      if (sharedRow) {
        // Someone else's shared session → its public discussion topic
        // (never their dev chat — that stays owner-scoped server-side).
        AppView.openTopic('session', parseInt(sharedRow.dataset.sharedSessionRow, 10));
        return;
      }
      const issueRow = e.target.closest('[data-issue-row]');
      if (issueRow) {
        AppView.openTopic('issue', parseInt(issueRow.dataset.issueRow, 10));
        return;
      }
      const prRow = e.target.closest('[data-proposal-row]');
      if (prRow) {
        AppView.openTopic('proposal', parseInt(prRow.dataset.proposalRow, 10));
        return;
      }
      const govRow = e.target.closest('[data-gov-row]');
      if (govRow) AppView.openTopic('gov', parseInt(govRow.dataset.govRow, 10));
    });
    // Keyboard access for the session rows (role="button" divs): Enter /
    // Space activate, mirroring the old strip's per-row keydown wiring.
    bodyEl.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const el = ev.target.closest
        && ev.target.closest('[data-session-chip], [data-shared-session-row]');
      if (!el) return;
      ev.preventDefault();
      if (el.dataset.sessionChip) {
        App.switchTab('dev', parseInt(el.dataset.sessionChip, 10), 'sessions');
      } else {
        AppView.openTopic('session', parseInt(el.dataset.sharedSessionRow, 10));
      }
    });

    await AppView._loadDevFeed();

    // Restore the saved scroll position now that the feed has painted.
    // requestAnimationFrame waits for layout so scrollHeight is final;
    // scrollTo({ behavior: 'instant' }) overrides any CSS smooth-scroll
    // (matching dev-chat.js's restoreSessionScroll) so this is an
    // instant jump, not a visible animation. We clamp to the rebuilt
    // list's max offset — a shorter list (collapsed "Show more") lands
    // near the old spot rather than overshooting. No saved value (or 0)
    // → top, as before.
    const savedScroll = AppView._getFeedScroll(App.currentApp);
    if (savedScroll > 0) {
      requestAnimationFrame(() => {
        const container = document.getElementById('dev-forum-scroll');
        if (!container) return;
        const top = AppView._clampScrollTop(savedScroll, container.scrollHeight, container.clientHeight);
        container.scrollTo({ top, behavior: 'instant' });
      });
    }
  },

  // ── Full-screen topic sub-view ──────────────────────────────────────
  // One issue / PR proposal / governance proposal opened from its card
  // (or a deep link): back header, the card itself (vote/preview/kudos
  // pills still live, minus the open-discussion affordance), the body
  // (issue text / vote details), and the discussion thread filling the
  // remaining height with the composer pinned to the bottom.
  _devTopic: null, // { kind: 'issue'|'proposal'|'gov', id } while open

  // #1036: the address of the app's dev page — what every "← Back" in a
  // dev sub-view (topic, general chat) points at as a real anchor, so a
  // cmd-click opens the dev page in a new tab instead of leaving this
  // one. Returns '' when there is no open app to name rather than
  // minting "#app/undefined/dev": NavLink.bind and the markup both treat
  // an empty href as "inert", which is the honest state.
  _devPageHref() {
    const slug = (AppView.appData && AppView.appData.slug) || App.currentApp;
    return slug ? `#app/${encodeURIComponent(slug)}/dev` : '';
  },

  async _renderTopicSubView(content, ref) {
    AppView._devTopic = { kind: ref.kind, id: ref.id };
    // #363: only the back bar is pinned here. The topic card/body no longer
    // sits in its own capped, separately scrolling box — it's painted into the
    // mounted thread's in-scroll header slot (#gc-thread-head) so the header
    // and the discussion scroll as ONE area (matching the general chat, where
    // only the composer is pinned). The topic's icon, title and number live on
    // that header card, so repeating them up here would be pure duplication.
    content.innerHTML = `
      <div class="flex flex-col h-full min-h-0">
        <div class="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <a id="dev-topic-back" class="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-sm shrink-0" title="Back to the dev page" href="${AppView._devPageHref()}">&larr; Back</a>
        </div>
        <div id="dev-topic-thread" class="flex-1 min-h-0"></div>
      </div>`;

    document.getElementById('dev-topic-back').addEventListener('click', (e) => {
      // #1036: real anchor — leave a modified click to the browser.
      if (window.NavLink && NavLink.isNativeClick(e)) return;
      e.preventDefault();
      App.switchTab('dev');
    });

    const ok = await AppView._loadDevData();
    // The view may have been replaced (or retargeted) while the fetch
    // was in flight.
    let t = AppView._devTopic;
    if (!document.getElementById('dev-topic-thread') || !t
        || t.kind !== ref.kind || t.id !== ref.id) return;
    // The Completed list is keyset-paginated, so a merged proposal beyond
    // the first page (deep link, shared URL, or one paged-in then lost when
    // _loadDevData reset _merged) won't be in any cached list. Rather than
    // bounce to the forum, fetch just that one proposal on demand and keep
    // it in a dedicated cache that survives WS-driven _loadDevData resets.
    if (ok && ref.kind === 'proposal' && !AppView._findTopicItem()) {
      await AppView._fetchProposalById(ref.id);
      // Re-check staleness: the user may have navigated away mid-fetch.
      t = AppView._devTopic;
      if (!document.getElementById('dev-topic-thread') || !t
          || t.kind !== ref.kind || t.id !== ref.id) return;
    }
    if (!ok || !AppView._findTopicItem()) {
      // Missing ref (closed issue, archived session, bad link, or a
      // proposal that genuinely doesn't exist / is inaccessible) — fall
      // back to the card list.
      App.switchTab('dev');
      return;
    }
    // #363: mount the thread FIRST so its header slot (#gc-thread-head) exists,
    // then paint the topic card/body into it.
    AppView._mountTopicThread();
    AppView._renderTopicHead();
  },

  _findTopicItem() {
    const t = AppView._devTopic;
    if (!t) return null;
    if (t.kind === 'issue') {
      return (AppView._ghIssues || []).find((i) => i.number === t.id) || null;
    }
    if (t.kind === 'proposal') {
      // Open proposals first; merged ones stay viewable with a still-live,
      // postable discussion thread (voting is settled, talking isn't).
      // _topicProposal is the fetch-on-demand fallback (a proposal opened
      // from beyond the cached Completed page) — checked last, and keyed by
      // id so a stale one from a previous topic never resolves.
      return (AppView._proposals || []).find((p) => p.id === t.id)
        || (AppView._merged || []).find((p) => p.id === t.id)
        || (AppView._topicProposal && AppView._topicProposal.id === t.id
            ? AppView._topicProposal : null)
        || null;
    }
    if (t.kind === 'session') {
      // A shared in-flight session's public discussion. Others resolve
      // from the shared list; the owner (opening via their card's 💬
      // badge) from their own pinned rows. Un-shared / archived mid-view
      // → miss → the topic view falls back to the card list.
      return (AppView._sharedSessions || []).find((s) => s.id === t.id)
        || (AppView._mySessions || []).find((s) => s.id === t.id)
        || null;
    }
    // Open governance proposals first; APPLIED close-issue proposals live
    // on in the Completed stream (row_type='close_issue' rows in _merged)
    // with a still-postable discussion thread, so resolve them too.
    return (AppView._govProposals || []).find((i) => i.id === t.id)
      || (AppView._merged || []).find(
        (r) => r.row_type === 'close_issue' && r.id === t.id)
      || null;
  },

  // Single-item cache for a proposal opened from beyond the cached
  // Completed page (the fetch-on-demand recovery path). Kept SEPARATE from
  // _merged because _loadDevData() resets _merged to its first page on
  // every call (including WS-driven refreshes while the topic is open), and
  // an injected row would vanish on the next reset and re-trigger the
  // forum fallback. Cleared on openTopic so it never leaks across topics.
  _topicProposal: null,

  // Fetch one proposal by id when it isn't in any cached list, caching it
  // in _topicProposal and seeding the inline vote/kudos snapshot the same
  // way loadMoreMerged does. Best-effort: a miss (404 / no access / network
  // error) leaves _topicProposal untouched, so the caller falls back to the
  // forum exactly as before.
  async _fetchProposalById(id) {
    if (!AppView.appData || !id) return null;
    const slug = AppView.appData.slug;
    try {
      const res = await fetch(`/api/apps/${slug}/proposals/${id}${AppView._demoQS()}`);
      if (!res.ok) return null;
      const data = await res.json();
      const row = data.proposal || null;
      if (!row) return null;
      AppView._topicProposal = row;
      // Keep the inline vote/kudos controls in sync so the discussion
      // thread's activity row renders its tally + per-viewer state, just
      // like a row loaded via the list (loadMoreMerged does the same).
      if (AppView.voteState && AppView.voteState.bySession) {
        AppView.voteState.bySession[String(row.id)] = row;
        if (row.pr_number != null) {
          AppView.voteState.byPrNumber[String(row.pr_number)] = row;
        }
        if (typeof GroupChat !== 'undefined' && GroupChat.refreshVoteControls) {
          GroupChat.refreshVoteControls();
        }
      }
      return row;
    } catch {
      return null;
    }
  },

  // #665: pure predicate behind _renderTopicHead's repaint guard — true
  // when the repaint must be SKIPPED because the inline issue-title editor
  // (beginIssueTitleEdit) is open on the mounted topic. Blocks only when
  // the topic is the issue being edited AND the editor element is actually
  // in the DOM; the caller supplies that DOM lookup so this stays
  // node-testable (tests/issue-title-edit-guard.test.js).
  _titleEditBlocksRepaint(topic, editingIssueNumber, editorInDom) {
    return !!(topic && topic.kind === 'issue'
      && editingIssueNumber != null
      && editingIssueNumber === topic.id
      && editorInDom);
  },

  // Paint (or live-refresh) the topic title + header card + body.
  // Leaves #dev-topic-thread untouched so the mounted thread survives
  // WS-driven refreshes.
  _renderTopicHead() {
    const t = AppView._devTopic;
    // #363: the topic card/body lives inside the thread's unified scroll
    // region (#gc-thread-head), a sibling of #gc-thread-messages, so it
    // survives renderThread()'s message-list rewrites and WS-driven refreshes.
    const head = document.getElementById('gc-thread-head');
    if (!t || !head) return;
    const item = AppView._findTopicItem();
    // Closed / merged away mid-view: keep the last render readable.
    if (!item) return;

    // #665: while the inline title editor is open, skip the repaint —
    // head.innerHTML below would destroy the editor and any typed text.
    // Every refresh trigger (checks poll, WS events, _repaintCards, the
    // post-withdraw/close repaints) converges here, so this one guard
    // covers them all. Data still refreshes in the background (_loadDevData
    // runs regardless); save/cancel clear the flag and repaint from the
    // fresh cache.
    const editorInDom = !!document.getElementById('dev-issue-title-input');
    if (AppView._titleEditBlocksRepaint(t, AppView._editingIssueTitle, editorInDom)) return;
    // Proceeding wipes any editor markup, so a still-set flag is stale by
    // definition — drop it (self-healing: a torn-down editor can never
    // freeze future repaints).
    AppView._editingIssueTitle = null;

    let cardHtml;
    let bodyHtml;
    if (t.kind === 'issue') {
      cardHtml = AppView._renderIssueRow(item, { noNav: true });
      // #396: the issue body, then a placeholder for the GitHub comment
      // thread. The thread is fetched lazily (after paint) and rendered
      // into the placeholder, so a cached (or empty) result reuses what's
      // already there across WS-driven _renderTopicHead refreshes.
      bodyHtml = AppView._detailActionsHtml('issue', item)
        + AppView._issueBodyHtml(item)
        + '<div id="dev-issue-comments" class="mt-2"></div>';
    } else if (t.kind === 'proposal') {
      cardHtml = AppView._renderProposalCard(item, { noNav: true });
      // Plain-language summary (when one was generated) sits at the very top
      // of the proposal body region, above proposer / linked issues / roster
      // and the discussion thread — mirroring _issueBodyHtml for issues.
      bodyHtml = AppView._detailActionsHtml('proposal', item)
        + AppView._proposalSummaryHtml(item) + AppView._proposalDetailsHtml(item)
        // shared_at (and so transcript_shared) survives promotion and
        // merge, so a proposal whose owner published the dev chat keeps
        // offering it here — the "how did this change come about?" read,
        // available while voting and after it merged.
        + AppView._transcriptSectionHtml(item);
    } else if (t.kind === 'session') {
      // A shared session's public page: the static card (no nav — we're
      // already here) plus a one-line explainer. The discussion mounts
      // beneath exactly like a proposal's. No "Explore in dev chat" (there's
      // no PR to explore yet) and no vote panel — there's nothing to vote
      // on yet either.
      // Shared rows carry username; the viewer's own rows (from
      // /api/me/active-sessions) don't — the owner is the viewer then.
      const ownerName = item.username || (App.user ? App.user.username : '') || 'someone';
      const owner = escapeHtml(ownerName);
      cardHtml = AppView._renderSharedSessionCard({ ...item, username: ownerName }, { noNav: true });
      bodyHtml = AppView._detailActionsHtml('session', item)
        + `<div class="text-xs text-zinc-500 dark:text-zinc-400 mt-2 px-1">Live dev session by ${owner} — the discussion below is visible to everyone and carries over if this becomes a proposal.</div>`
        + AppView._transcriptSectionHtml(item);
    } else {
      cardHtml = AppView._renderGovCard(item, { noNav: true });
      // Close-issue proposals store the proposer's reason in the payload;
      // fall back to it when the description is empty so a completed
      // close-issue topic still shows why the close was proposed.
      const govBody = item.description
        || (item.payload && item.payload.reason) || '';
      bodyHtml = govBody
        ? `<div class="text-xs text-zinc-500 dark:text-zinc-400 mt-2 px-1">${escapeHtml(govBody)}</div>`
        : '';
    }

    // #827: the only AI affordance on a proposal is the card pill —
    // "✨ Explore in dev chat" (_exploreChatBtnHtml, gated by
    // _showExplorePill).
    // It replaced the old private read-only "Ask AI" advisor panel: instead
    // of a bespoke side-chat, the pill opens the user's real dev chat with a
    // message about this PR pre-filled (never sent) in the composer.
    //
    // Who gets it: see _showExplorePill — the one predicate every render
    // site shares. Here it additionally decides whether to bind the pill's
    // click and run the availability pass below (the head has no delegated
    // handler), so it must agree with what _renderProposalCard painted.
    const cardHasExplorePill = (t.kind === 'proposal' && AppView._showExplorePill(item));

    head.innerHTML = cardHtml + bodyHtml;
    AppView._wireDetailActions(head, t.kind, item);
    if (window.Kudos) Kudos.attach(head);
    if (t.kind === 'issue') AppView._loadIssueComments(item);
    if (t.kind === 'proposal' && item.status !== 'merged') AppView._loadVoteRoster(item.id);

    // Transcript section: same reason as the Explore pill below — the topic
    // head has no delegated handler, so bind per paint. Rebinding on every
    // repaint is leak-free because the old nodes go with the innerHTML.
    // Auto-expanded (arrived via "Read chat") sections load immediately.
    const transcriptToggle = head.querySelector('[data-transcript-toggle]');
    if (transcriptToggle) {
      transcriptToggle.addEventListener('click', () => AppView._toggleTranscript(transcriptToggle));
      if (transcriptToggle.getAttribute('aria-expanded') === 'true') {
        AppView._loadSessionTranscript(parseInt(transcriptToggle.dataset.transcriptToggle, 10));
      }
    }
    // "Fork this chat" is painted INSIDE the transcript body (after its
    // fetch), so it can't be bound here — delegate from the section.
    const transcriptSection = head.querySelector('[data-transcript-section]');
    if (transcriptSection) {
      transcriptSection.addEventListener('click', (ev) => {
        const forkBtn = ev.target.closest('[data-fork-chat]');
        if (!forkBtn || forkBtn.disabled) return;
        ev.preventDefault();
        AppView.forkSharedChat(parseInt(forkBtn.dataset.forkChat, 10), forkBtn);
      });
    }

    // #321: wire the card pill in the topic head. Unlike the feed and
    // Completed list, #gc-thread-head has no delegated
    // .gc-explore-chat-btn handler, so without this the pill would be inert
    // (no click, no availability dimming). Bind the click to the same opener
    // the delegated handler uses and run the shared availability pass over
    // this container.
    if (cardHasExplorePill) {
      const pill = head.querySelector('.gc-explore-chat-btn');
      if (pill) {
        pill.addEventListener('click', () => {
          if (pill.disabled) return;
          AppView.exploreProposalInDevChat(t.id, pill);
        });
      }
      AppView._applyExploreChatAvailability(head);
    }

    // Keep the generating-state poller in sync with what we just painted, the
    // same way _renderFeedInner does for the feed. An issue opened while its
    // headless run is 'generating' begins polling so the card advances to its
    // outcome label without a manual refresh.
  },

  // #1045: the ONE rule for whether a proposal row offers the "Explore in
  // dev chat" pill. Every render site (the feed/board card, the Completed
  // card, the topic head) calls this instead of re-deriving `!mine`, so the
  // three can't drift — the topic head in particular uses it to decide
  // whether to BIND the pill's click, and a head that disagrees with the
  // card it just painted leaves an inert button.
  //
  // Who gets it:
  // - Another user's PR proposal: yes (#313/#827) — the pill rides in the
  //   card action row, and #321's "no duplicate standalone in the head"
  //   rule still holds (there is no standalone button any more at all).
  // - The viewer's OWN native PR proposal: no (#313/#348) — "Open session"
  //   on their own PR is the better door to the same dev chat, so a pill
  //   beside it is redundant clutter.
  // - The viewer's OWN IMPORTED proposal: YES (#1045). An imported PR has
  //   no platform-owned dev chat at all — src/routes/sessions.js refuses a
  //   chat turn on a `source='imported'` row, so _renderProposalCard hides
  //   "Open session" for it too (#687). Without this the owner of a PR they
  //   imported (or had their own Claude Code / Codex build and submit
  //   through the connector) gets NO AI affordance on their own proposal.
  //   The pill opens a SEPARATE ordinary dev chat that reads the PR — it
  //   never takes over the imported branch.
  // - Governance proposals and applied close-issue rows: no (#827). A dev
  //   chat can only reason about repo code and cannot act on a rename /
  //   secret change / close-issue vote, so a "let's explore this" seed
  //   there would mislead. Both carry `kind` (and close-issue rows a
  //   `row_type`); PR-proposal rows from /promoted and mergedRowSelect
  //   carry neither.
  //
  // Read-only viewers are NOT filtered here: that gate lives in
  // _exploreChatBtnHtml (#621), so it stays in exactly one place.
  _showExplorePill(pr) {
    if (!pr) return false;
    if (pr.kind || pr.row_type === 'close_issue') return false;
    const mine = !!(App.user && pr.user_id === App.user.id);
    const imported = pr.source === 'imported';
    return !mine || imported;
  },

  // ── The detail view's actions & state block ─────────────────────────
  //
  // Cards are pointers now: at most two text actions, an icon Preview and a
  // ⋯ menu. Everything else has to have somewhere to LIVE, and this is it —
  // one canonical destination per card, hosting the full action set, the
  // preview, and (for a blocked proposal) every reason it can't merge rather
  // than a row of badges the reader has to reverse-engineer.
  //
  // Sits between the topic head's card and its body. `kind` ∈
  // 'issue' | 'proposal' | 'session'; governance proposals keep their card's
  // own Yes/No + ⋯ and need no extra block.
  _detailActionsHtml(kind, item) {
    if (!item) return '';
    const rows = [];

    // Preview: the full-width, LABELLED affordance. The board's version is
    // icon-only to fit the card budget; here there is room to say what it
    // is, and to say why there isn't one yet when that's the case.
    const previewKind = kind === 'session'
      ? (item.username && App.user && item.user_id !== App.user.id ? 'shared-session' : 'own-session')
      : 'proposal';
    const preview = AppView.cardPreviewHtml(item, {
      kind: previewKind, sessionId: item.id, iconOnly: false,
    });
    if (preview) rows.push(preview);

    if (kind === 'proposal') {
      const mine = !!(App.user && item.user_id === App.user.id);
      const isMerged = item.status === 'merged';
      if (mine && item.source !== 'imported') {
        rows.push(`<button class="gc-vote-btn" title="Open the dev session behind this proposal" onclick="AppView.openProposalSession(${item.id})">Open the dev session behind this</button>`);
      }
      // #1047: the shared predicate, not a bare `!mine` — a viewer's OWN
      // IMPORTED proposal has no dev session behind it, so the "Open the dev
      // session" row above is empty and Explore is the owner's only AI
      // affordance here.
      if (AppView._showExplorePill(item) && !AppView.readOnly) rows.push(AppView._exploreChatBtnHtml(item));
      if (!AppView.readOnly && !isMerged && mine && item.status === 'promoted') {
        rows.push(`<button class="gc-vote-btn" title="Withdraw this proposal (closes the PR, removes it from the vote panel)" onclick="AppView.withdrawProposal(${item.id})">Withdraw</button>`);
      }
      if (window.Kudos) rows.push(Kudos.renderButton(item, { compact: true }));
    } else if (kind === 'issue') {
      // The issue card's demoted actions, spelled out where there is room.
      if (!AppView.readOnly) {
        const h = item.headless;
        const generating = !!(h && h.status === 'generating');
        const clonedReady = !!(h && h.status === 'ready' && h.mySessionId);
        if (!generating && !clonedReady) {
          rows.push(`<button class="gc-vote-btn" title="Spin up a headless AI session that starts solving this issue on its own — uses your credits" onclick="AppView.confirmAutoSession(${item.number})">Generate proposal</button>`);
        }
        const ipClaims = (item.in_progress && Array.isArray(item.in_progress.claims))
          ? item.in_progress.claims : [];
        const myClaim = ipClaims.some((c) => c.mine);
        rows.push(myClaim
          ? `<button class="gc-vote-btn" title="Remove your in-progress mark from this issue" onclick="AppView.clearIssueClaim(${item.number})">Clear in progress</button>`
          : `<button class="gc-vote-btn" title="Mark this issue as in progress — you're working on it" onclick="AppView.markIssueInProgress(${item.number})">Mark in progress</button>`);
        const meta = AppView._ghIssuesMeta || {};
        const kudosDisabled = item.my_bounty || meta.myRemaining === 0;
        rows.push(`<button class="gc-vote-btn"${kudosDisabled ? ' disabled' : ''} title="Pledge a kudos bounty — paid to whoever's merged PR closes this issue" onclick="AppView.giveIssueBounty(${item.number})">${item.my_bounty ? '&#9733; Bountied' : 'Pledge kudos'}</button>`);
        const hasCloseProposal = (AppView._govProposals || []).some((g) =>
          g.kind === 'close_issue' && g.status === 'open'
          && Number(g.payload && g.payload.issueNumber) === item.number);
        rows.push(hasCloseProposal
          ? '<button class="gc-vote-btn" disabled title="A close proposal for this issue is up for vote">Close proposed</button>'
          : `<button class="gc-vote-btn" title="Propose closing this issue — the group votes; if it passes, the issue is closed here and on GitHub" onclick="AppView.promptCloseIssue(${item.number})">Propose to close</button>`);
      }
    }

    const actionRow = rows.filter(Boolean).length
      ? `<div class="gc-card-actions">${rows.filter(Boolean).join('')}</div>`
      : '';

    // The blocked-reason enumeration. The pill on the card names the single
    // most severe reason; here every one of them is spelled out, so a
    // reader never has to infer "behind main AND checks failing AND console
    // errors" from three badges sitting side by side.
    let reasonsBlock = '';
    if (kind === 'proposal' && item.status !== 'merged') {
      const reasons = AppView.blockReasons(item);
      if (reasons.length) {
        const blocking = reasons.some((r) => !r.soft);
        reasonsBlock = `<div class="dev-detail-reasons">
            <div class="dev-detail-reasons-head">${blocking ? 'Why this can’t merge yet' : 'Worth knowing before you vote'}</div>
            <ul class="dev-detail-reasons-list">${reasons.map((r) =>
              `<li class="${r.soft ? 'dev-detail-reason-soft' : 'dev-detail-reason-hard'}"><span class="dev-detail-reason-label">${escapeHtml(r.label)}</span> ${escapeHtml(r.detail)}</li>`
            ).join('')}</ul>
          </div>`;
      }
    }

    // The before/after captures moved off the card and live here. They wait
    // in an inert <template> (no bandwidth, no autoplay loops) until
    // expanded; _visualsOpen keeps the open/closed state across the topic
    // head's frequent repaints, and the card's ⋯ row pre-sets it so
    // "Before/after screenshots" lands with the block already open.
    let visualsBlock = '';
    if (kind === 'proposal') {
      const tiles = AppView.visualsTilesHtml(item.visuals);
      if (tiles) {
        const open = AppView._visualsOpen.has(item.id);
        visualsBlock = `<div class="mt-2" data-visuals-scope="1">
            <button type="button" class="gc-vote-btn" aria-expanded="${open ? 'true' : 'false'}" onclick="AppView.toggleVisuals(${item.id}, this)">${open ? 'Hide before/after' : 'Show before/after'}</button>
            <template class="usn-visuals-tpl">${tiles}</template>
            <div class="usn-visuals-body">${open ? tiles : ''}</div>
          </div>`;
      }
    }

    const inner = actionRow + reasonsBlock + visualsBlock;
    return inner ? `<div class="dev-detail-actions">${inner}</div>` : '';
  },

  // The detail block's Explore pill needs the same per-paint binding the
  // card pill gets in the topic head (that container has no delegated
  // handler of its own). Rebinding per paint is leak-free: the old nodes go
  // with the innerHTML.
  _wireDetailActions(head, kind, item) {
    if (!head) return;
    head.querySelectorAll('.dev-detail-actions .gc-explore-chat-btn').forEach((pill) => {
      pill.addEventListener('click', () => {
        if (pill.disabled) return;
        AppView.exploreProposalInDevChat(item && item.id, pill);
      });
    });
    AppView._applyExploreChatAvailability(head);
  },

  // #313/#827: a compact "Explore in dev chat" action for the proposal CARD
  // action row (the Dev feed, the kanban board, the Completed list). Cards
  // render many at once, so this uses a class + data-proposal-id hook (ids
  // must stay unique). Whether a given row gets one at all is
  // _showExplorePill's call. Click is dispatched by the delegated
  // feed/merged handler (and wired directly in the topic head).
  _exploreChatBtnHtml(pr) {
    // #621: the dev chat spends the viewer's LLM budget and its API is
    // collab-gated — nothing to offer read-only viewers.
    if (AppView.readOnly) return '';
    return `<button type="button" class="gc-vote-btn gc-explore-chat-btn" data-proposal-id="${pr.id}"
      title="${escapeAttr(AppView.EXPLORE_CHAT_TITLE)}"><span aria-hidden="true">✨</span> Explore in dev chat</button>`;
  },

  // ── A card's action row: primary + preview + overflow ────────────────
  //
  // #404 put EVERY action inline in one flat row, deliberately rejecting an
  // overflow menu. The card-as-pointer revision REVERSES that: a card is a
  // pointer, not a control panel, so the row is now capped at
  //
  //   • at most ACTION_PRIMARY_MAX text pills (the actions you'd actually
  //     take from a list),
  //   • one icon-only Preview affordance (kept as an icon precisely so a
  //     read-only viewer — who gets no vote buttons — still has a visible
  //     "go look at this" affordance),
  //   • one ⋯ trigger holding everything else.
  //
  // `spec` is an object, not an array:
  //   primary — ordered array of button-HTML strings (falsy dropped, sliced
  //             to the cap; anything past it is a bug, not a silent trim, so
  //             the overflow is where extra actions belong)
  //   preview — the icon affordance HTML ('' when there's nothing to preview)
  //   menu    — DESCRIPTORS (see _cardMenuTriggerHtml), not HTML, so the same
  //             list renders as an anchored dropdown on pointer devices and as
  //             a PlatformUI action sheet on touch
  //   menuKey — stable identity for the menu ('proposal:45'), used as the
  //             registry key the delegated handler looks the descriptors up by
  //
  // An array is still accepted (legacy shape) and treated as `{ primary }`
  // with no cap, so the transcript/roster call sites and any external caller
  // keep working. Returns '' when there is nothing at all to show.
  ACTION_PRIMARY_MAX: 2,
  _cardActionsHtml(spec) {
    if (Array.isArray(spec) || spec == null) {
      const legacy = (spec || []).filter(Boolean).join('');
      return legacy ? `<div class="gc-card-actions">${legacy}</div>` : '';
    }
    const primary = (spec.primary || []).filter(Boolean)
      .slice(0, AppView.ACTION_PRIMARY_MAX);
    const inner = primary.join('') + (spec.preview || '');
    return inner ? `<div class="gc-card-actions">${inner}</div>` : '';
  },

  // ── The shared card body ─────────────────────────────────────────────
  //
  // Every card type assembles the same four bands inside the shell, so they
  // are built here once rather than copy-pasted into six renderers:
  //
  //   head    — the headline (title + meta) and the badge row, with the ⋯
  //             trigger pinned TOP-RIGHT beside them. It sits in the head
  //             rather than the action row because a card is a pointer: the
  //             corner is where "more about this card" belongs, and it keeps
  //             the action row to the one or two things you'd actually do.
  //             Its own flex column means it can never collide with the 💬
  //             badge (which lives inside the wrapping badge row) or with the
  //             drag grip (a gutter outside the card entirely).
  //   pill    — the composite status pill, FULL WIDTH on its own row. A
  //             proportional tally reads far better as a bar than as a
  //             thumbnail-sized capsule wedged between chips, and giving it
  //             the whole width is what makes the fill legible at a glance.
  //   actions — the ≤2 text pills plus the icon Preview.
  //
  // opts: { headlineHtml, badges, chatCount, uncapped, pill, inlinePill,
  //         actions, extraHtml }
  //
  // The ⋯ trigger is NOT here — it lives in the card's right rail
  // (_cardRailHtml) so it shares a column with the chevron instead of
  // eating a third of the badge row's width.
  //
  // `inlinePill` is the detail head's variant: that page already has the
  // full page width, so a second full-width bar under the header would read
  // as a rule rather than a status. There the pill leads the badge row as a
  // capsule instead, which is also why it is exempt from the badge cap.
  _cardContentHtml(opts) {
    const o = opts || {};
    const chips = o.inlinePill
      ? [o.inlinePill, ...(o.badges || [])]
      : (o.badges || []);
    const badges = AppView._cardBadgesHtml(chips, o.chatCount, {
      uncapped: o.uncapped || !!o.inlinePill,
    });
    const pillRow = o.pill ? `<div class="dev-status-row">${o.pill}</div>` : '';
    return `<div class="flex-1 min-w-0">
          <div class="dev-card-head">
            <div class="dev-card-head-main">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                ${o.headlineHtml || ''}
                ${badges}
              </div>
            </div>
          </div>
          ${pillRow}
          ${o.actions || ''}
          ${o.extraHtml || ''}
        </div>`;
  },

  // The headline cell — title over meta. Shared so the wrap rule
  // (.dev-card-headline) is applied identically everywhere.
  _cardHeadlineHtml(titleHtml, metaHtml, titleAttrs) {
    return `<div class="dev-card-headline">
                  <div class="dev-card-title"${titleAttrs || ''}>${titleHtml}</div>
                  <div class="dev-card-headline-meta">${metaHtml || ''}</div>
                </div>`;
  },

  // ── Card overflow (⋯) menu ───────────────────────────────────────────
  //
  // Cards are HTML strings assigned with innerHTML, so a menu's items can't
  // be closures attached to the DOM. Instead each card REGISTERS its
  // descriptor list under a stable key at render time and emits a trigger
  // carrying `data-card-menu="<key>"`; one document-level delegated handler
  // (installed once by _cardMenuInit) looks the list up and presents it.
  // Repaints re-register under the same key, so a stale registry entry is
  // always overwritten rather than accumulating a second copy.
  //
  // A descriptor is { label, title?, icon?, disabled?, danger?, act? }:
  //   label    — the row text (same wording the pill had)
  //   title    — tooltip / the disabled reason
  //   icon     — a MENU_ICONS key; the glyph is decorative, never the name
  //   disabled — renders inert (kept, rather than hidden, so "Close proposed"
  //              still explains itself)
  //   danger   — red row (Archive, Withdraw, Undo)
  //   act      — the click handler; omitted on a purely informational row
  _cardMenus: Object.create(null),
  _cardMenuSeq: 0,
  // The presented menu's dismissal hooks, or null. Body-mounted like
  // .attr-popover so a kanban column's overflow-x:auto can't clip it.
  _openCardMenu: null,

  // ── One icon vocabulary for every ⋯ menu ──────────────────────────────
  //
  // Keyed by MEANING, not by card type, so the same action wears the same
  // glyph wherever it appears: "Admin merge" is ⚡ on a proposal card, a
  // governance card and the topic head alike, and a reader who learns one
  // menu has learned all five. Because it is looked up from the descriptor
  // (never baked into the label), the anchored dropdown and the touch action
  // sheet render from ONE source — the whole point of descriptors over HTML.
  //
  // The glyph is DECORATIVE: `aria-hidden` in the dropdown and never part of
  // the accessible name, so a screen reader still hears "Withdraw", not
  // "multiplication sign Withdraw". Danger rows deliberately use monochrome
  // text glyphs rather than emoji, so they inherit the row's red instead of
  // sitting in it as a coloured sticker.
  MENU_ICONS: {
    merge: '⚡',            // ⚡ admin bypass of the vote
    session: '💻',    // 💻 the dev session behind a proposal
    withdraw: '✕',         // ✕ danger
    undo: '↩',             // ↩ danger
    kudos: '★',            // ★ matches the bounty badge on the meta line
    explore: '✨',          // ✨ was inline in the label; now the icon
    generate: '✧',         // ✧ sibling sparkle: the headless AI run
    retry: '↻',            // ↻
    visuals: '🖼',    // 🖼 before/after captures
    github: '↗',           // ↗ leaves the platform
    priority: '⚑',         // ⚑ the same flag the priority chip uses
    category: '🏷',   // 🏷
    assignee: '@',              // the assignee chip renders "@name"
    progress: '◐',         // ◐ half-filled: in progress
    clear: '○',            // ○ the same circle, emptied
    close: '⊘',            // ⊘ danger
    visible: '👁',    // 👁
    hide: '🔒',       // 🔒 private again
    chat: '💬',       // 💬 matches the message-count badge
    archive: '📦',    // 📦
    campaign: '📊',   // 📊
    // Nothing should reach this, but a descriptor added later without an
    // icon must still line up with its neighbours rather than losing the
    // leading column and shifting its own label left.
    default: '•',          // •
  },

  // The glyph for one descriptor. Unknown / absent keys fall back to the
  // neutral bullet so the fixed-width leading column is never empty.
  _menuIconGlyph(it) {
    const key = it && it.icon;
    return (key && AppView.MENU_ICONS[key]) || AppView.MENU_ICONS.default;
  },

  // The touch action sheet takes a plain string per row (the native kit
  // owns that markup), so the SAME glyph rides in as a label prefix there.
  // Two spaces, not one: the sheet has no leading column to align against.
  _menuSheetLabel(it) {
    return `${AppView._menuIconGlyph(it)}  ${it.label}`;
  },

  // Register `items` under `key` and return the ⋯ trigger, or '' when there
  // is nothing to demote (a card with an empty menu must not grow a dead
  // button). Falsy entries are dropped so callers can inline conditionals.
  _cardMenuTriggerHtml(key, items) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return '';
    // Keys are per-card and stable across repaints; the counter is only a
    // fallback for a card with no identity. Reset the registry if it ever
    // grows past any plausible board size — a runaway-growth backstop, not a
    // cache eviction policy.
    if (AppView._cardMenuSeq > 4000) {
      AppView._cardMenus = Object.create(null);
      AppView._cardMenuSeq = 0;
    }
    const mkey = key || `anon:${(AppView._cardMenuSeq += 1)}`;
    AppView._cardMenus[mkey] = list;
    const dots = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">'
      + '<circle cx="4" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="16" cy="10" r="1.6"/></svg>';
    return `<button type="button" class="gc-vote-btn gc-vote-btn-icon dev-card-menu-btn" data-card-menu="${escapeAttr(mkey)}"`
      + ` aria-haspopup="true" aria-label="More actions" title="More actions">${dots}</button>`;
  },

  // Install the one-time document-level handlers that open / close the card
  // menu. Idempotent, and bound on `document` rather than #dev-body so the
  // same menus work on the board, the list feed, the PM view AND the topic
  // detail head (which has no delegated container of its own).
  _cardMenuInit() {
    if (AppView._cardMenuInited) return;
    AppView._cardMenuInited = true;
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest && e.target.closest('[data-card-menu]');
      if (trigger) {
        e.preventDefault();
        e.stopPropagation();
        AppView._toggleCardMenu(trigger);
        return;
      }
      // Any click outside the presented menu dismisses it.
      if (AppView._openCardMenu && !(e.target.closest && e.target.closest('.dev-card-menu'))) {
        AppView._closeCardMenu();
      }
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && AppView._openCardMenu) AppView._closeCardMenu();
    });
    // The board scrolls in both axes and the menu is position:fixed, so a
    // scroll would leave it stranded beside nothing. Dismiss rather than
    // re-anchor: a menu is a momentary choice, not a persistent panel.
    window.addEventListener('scroll', () => {
      if (AppView._openCardMenu) AppView._closeCardMenu();
    }, true);
    window.addEventListener('resize', () => {
      if (AppView._openCardMenu) AppView._closeCardMenu();
    });
  },

  _closeCardMenu() {
    const open = AppView._openCardMenu;
    AppView._openCardMenu = null;
    if (!open) return;
    if (open.el && open.el.parentNode) open.el.parentNode.removeChild(open.el);
    if (open.trigger && open.trigger.setAttribute) {
      open.trigger.setAttribute('aria-expanded', 'false');
    }
  },

  _toggleCardMenu(trigger) {
    const key = trigger.dataset.cardMenu;
    const items = AppView._cardMenus[key];
    // Re-clicking the open trigger closes it (the popover idiom).
    const wasOpen = AppView._openCardMenu && AppView._openCardMenu.key === key;
    AppView._closeCardMenu();
    if (wasOpen || !items || !items.length) return;
    // Touch: the same descriptors as a bottom action sheet, matching the
    // "+" menu's behaviour rather than anchoring a dropdown under a finger.
    if (typeof PlatformUI !== 'undefined' && PlatformUI.isTouch && PlatformUI.isTouch()) {
      PlatformUI.actionSheet({
        actions: items.filter((it) => !it.disabled && it.act).map((it) => ({
          label: AppView._menuSheetLabel(it),
          destructive: !!it.danger,
          handler: () => { try { it.act(); } catch { /* handler owns its errors */ } },
        })),
      });
      return;
    }
    const menu = document.createElement('div');
    menu.className = 'dev-card-menu';
    menu.setAttribute('role', 'menu');
    AppView._fillCardMenu(menu, items);
    document.body.appendChild(menu);
    AppView._positionCardMenu(menu, trigger);
    menu.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-menu-idx]');
      if (!btn || btn.disabled) return;
      // Read the CURRENT descriptor list rather than the one captured when
      // the menu opened: a repaint re-registers under the same key, and the
      // menu now survives repaints (see _reanchorCardMenu), so a captured
      // closure could act on a row the board has already replaced.
      const live = AppView._cardMenus[key] || items;
      const it = live[parseInt(btn.dataset.menuIdx, 10)];
      AppView._closeCardMenu();
      if (it && it.act) {
        try { it.act(); } catch { /* handler owns its errors */ }
      }
    });
    trigger.setAttribute('aria-expanded', 'true');
    AppView._openCardMenu = { key, el: menu, trigger };
    const first = menu.querySelector('[data-menu-idx]:not([disabled])');
    if (first && first.focus) first.focus();
  },

  // Render `items` into an existing menu element. Split out of
  // _toggleCardMenu so a repaint can refresh the rows in place without
  // tearing the menu down (the click handler is bound on the menu element,
  // so replacing its innerHTML keeps the wiring).
  _fillCardMenu(menu, items) {
    menu.innerHTML = (items || []).map((it, i) => {
      const cls = 'dev-card-menu-item' + (it.danger ? ' dev-card-menu-item-danger' : '');
      const t = it.title ? ` title="${escapeAttr(it.title)}"` : '';
      const dis = (it.disabled || !it.act) ? ' disabled' : '';
      // The glyph is aria-hidden and the label keeps its own element, so the
      // button's accessible name stays exactly the label text.
      const icon = `<span class="dev-card-menu-icon" aria-hidden="true">${escapeHtml(AppView._menuIconGlyph(it))}</span>`;
      return `<button type="button" role="menuitem" class="${cls}" data-menu-idx="${i}"${t}${dis}>`
        + `${icon}<span class="dev-card-menu-label">${escapeHtml(it.label)}</span></button>`;
    }).join('');
  },

  // Flip / clamp into the viewport, same arithmetic as _positionAttrPopover.
  _positionCardMenu(menu, trigger) {
    const r = trigger.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  },

  // Re-attach an open ⋯ menu to the freshly-rendered card after a repaint.
  //
  // This is what makes the menu usable at all. Every repaint replaces
  // #dev-body's innerHTML, and the board repaints on its own schedule —
  // the session-cache poll, the headless poll, and every websocket push.
  // The menu itself is body-mounted and position:fixed, so the swap never
  // touches it; only the trigger element it was anchored to is destroyed.
  // Closing on that basis meant a background refresh nobody asked for tore
  // the menu off the screen, which on the In-progress column (where session
  // rows churn constantly) read as "the ⋯ doesn't open at all" — the menu
  // appeared and vanished inside the same tap.
  //
  // So: find the successor trigger BY KEY (keys are stable per card across
  // repaints, which is what the registry is for). Found → re-point, refresh
  // the rows from the newly-registered descriptors, re-position. Gone —
  // the card was filtered out, archived, merged away — → close, because
  // there is genuinely nothing left to act on.
  //
  // Deliberately NOT re-focused: a background repaint must not yank focus
  // out from under someone reading the menu.
  _reanchorCardMenu() {
    const open = AppView._openCardMenu;
    if (!open) return;
    if (!open.el || !open.el.parentNode) { AppView._closeCardMenu(); return; }
    // Matched by iterating rather than an attribute selector: menu keys carry
    // a ':' ("session:990102") and would need CSS.escape, which isn't worth
    // depending on for a list this short.
    let trigger = null;
    const all = document.querySelectorAll('[data-card-menu]');
    for (let i = 0; i < all.length; i += 1) {
      if (all[i].dataset.cardMenu === open.key) { trigger = all[i]; break; }
    }
    if (!trigger) { AppView._closeCardMenu(); return; }
    open.trigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    AppView._fillCardMenu(open.el, AppView._cardMenus[open.key] || []);
    AppView._positionCardMenu(open.el, trigger);
  },

  // The card's right-edge rail: the ⋯ trigger pinned to the TOP-RIGHT
  // corner with the tap-through chevron centred below it.
  //
  // Both are right-edge controls, so they share ONE column rather than each
  // taking its own. That matters more than it sounds: a kanban column gives
  // a card about 175px of text width, and giving the ⋯ its own flex slot
  // beside the head cost 30px of it — enough to push a single assignee chip
  // onto its own line. Sharing the rail costs 8px instead.
  //
  // `chevron` is false on the topic head's static variants (you are already
  // on the page it would navigate to).
  _cardRailHtml(menuKey, menu, opts) {
    const o = opts || {};
    const trigger = AppView._cardMenuTriggerHtml(menuKey, menu);
    const chevron = o.chevron === false ? '' : AppView.DEV_CARD_CHEVRON;
    if (!trigger && !chevron) return '';
    if (!trigger) return chevron;
    return `<div class="dev-card-rail">${trigger}${chevron}</div>`;
  },

  // A lightweight section divider for a column that groups its cards
  // (today: the In progress column's private / visible / others bands).
  // Replaces the two full grey sentences that used to introduce those
  // groups — the long copy becomes the label's tooltip.
  _columnDividerHtml(label, title) {
    return `<div class="dev-col-divider"><span class="dev-col-divider-label"`
      + `${title ? ` title="${escapeAttr(title)}"` : ''}>${escapeHtml(label)}</span></div>`;
  },

  EXPLORE_CHAT_TITLE: 'Open a dev chat with a message about this PR ready to edit and send',

  // #827: the closing paragraph of every exploration seed. Load-bearing —
  // it is what keeps an UNEDITED send from making the Mayor dispatch the
  // coding agent: the turn stays a chat-only explanation. Pinned
  // byte-for-byte by tests/explore-pr-in-dev-chat.test.js.
  EXPLORE_SEED_TAIL:
    'Please read it and explain in plain terms what it changes, how it works, '
    + "and anything risky or worth checking. Just explain it for now — don't "
    + 'change any code or open a PR.',

  // #827: the editable kickoff message for "Explore in dev chat", built
  // purely from the cached proposal row (no extra fetch). Optional lines are
  // dropped when the data is absent, so an imported PR with no linked issues
  // and a title-only row both produce clean text.
  _exploreSeed(pr) {
    const row = pr || {};
    const title = (row.pr_title || '').trim();
    const author = (row.username || '').trim();
    const by = author ? ` by ${author}` : '';
    const lines = [];
    lines.push(row.pr_number
      ? `Let's explore PR #${row.pr_number} in this app — "${title || `PR #${row.pr_number}`}"${by}.`
      : `Let's explore the proposal "${title || 'this proposal'}" in this app${by}.`);
    if (row.pr_url) lines.push(`PR link: ${row.pr_url}`);
    const issues = Array.isArray(row.linked_issues)
      ? row.linked_issues.filter((n) => Number.isInteger(n))
      : [];
    if (issues.length) lines.push(`Linked issues: ${issues.map((n) => `#${n}`).join(', ')}.`);
    if (row.status === 'merged') lines.push('This proposal is already merged.');
    else if (row.status === 'merging') lines.push('This proposal is currently being merged.');
    return `${lines.join('\n')}\n\n${AppView.EXPLORE_SEED_TAIL}`;
  },

  // #827: is this dev chat one the user has never actually used?
  //
  // The decisive signal is EMPTINESS: /api/me/active-sessions computes
  // last_activity_at as GREATEST(created_at, MAX(message.created_at)), so a
  // session with no messages at all is exactly one where the two timestamps
  // are equal. Don't lean on session_title for this — it's generated by an
  // LLM call that never runs on a deployment without a key (and can fail),
  // so a chat with ten messages can still carry a NULL title. It's kept as a
  // cheap extra veto (a titled chat is definitely used), alongside
  // pr_number (pushed work) and busy (a first turn mid-run).
  _isUnusedChat(s) {
    if (!s || s.pr_number || s.session_title) return false;
    // #1038: live busy, so a first turn that started since the last fetch
    // still vetoes the "unused chat" treatment.
    if (AppView._sessionBusy(s)) return false;
    const created = Date.parse(s.created_at || '');
    const active = Date.parse(s.last_activity_at || s.created_at || '');
    return Number.isFinite(created) && Number.isFinite(active) && created === active;
  },

  // #827: open the viewer's dev chat with a message about this proposal
  // pre-filled in the composer — and NEVER sent. Replaces the old private
  // read-only advisor panel (#297).
  //
  // Session choice, in order:
  //   1. Reuse the most recently active UNUSED chat for this app. Sessions
  //      cost a GitHub branch and a slot from a cap of 3
  //      (config.maxUserSessions), so browsing three proposals in a row must
  //      not burn the user's whole budget on throwaway chats.
  //   2. Otherwise create a fresh one (no issueNumber — this isn't issue
  //      work, so created_from_issue_number stays NULL).
  //   3. If creation is refused (cap / capacity / no repo — createSession
  //      already toasts the server's reason), fall back to the most recent
  //      existing chat so the text still lands somewhere useful.
  //
  // The seed reaches the composer through the per-session draft
  // (_setDraft → _restoreDraft on render), exactly like createPrForIssue's
  // #609 flow. A composer that already holds text is never clobbered — the
  // seed is appended below it.
  async exploreProposalInDevChat(id, btnEl) {
    const pid = parseInt(id, 10);
    const slug = AppView.appData && AppView.appData.slug;
    if (!pid || !slug || typeof DevChat === 'undefined') return;
    const pr = (AppView._proposals || []).find((p) => p.id === pid)
      // Skip close-issue rows: issues.id can collide with a session id.
      || (AppView._merged || []).find((p) => p.id === pid && p.row_type !== 'close_issue');
    if (!pr) return;

    if (btnEl) btnEl.disabled = true;
    try {
      const seed = AppView._exploreSeed(pr);

      // Ground truth before choosing: a cached row may have been archived or
      // promoted in another tab. _refreshSessionCaches swallows its own
      // errors and repopulates _mySessions (this app's active/paused rows,
      // newest activity first).
      await AppView._refreshSessionCaches(slug);
      const mine = AppView._mySessions || [];

      let sessionId = (mine.find(AppView._isUnusedChat) || {}).id || null;
      if (!sessionId) {
        const created = await DevChat.createSession(slug);
        if (created) {
          sessionId = created.id;
        } else if (mine.length) {
          // Cap / capacity / repo error — createSession already explained
          // why. Land in the newest existing chat rather than dead-ending.
          sessionId = mine[0].id;
          PlatformUI.toast('Added the message to your most recent dev chat instead.');
        }
      }
      if (!sessionId) return; // createSession's toast stands

      // Never clobber half-typed text; and a double-tap must not stack the
      // same seed twice.
      const existing = (typeof DevChat._getDraft === 'function'
        ? DevChat._getDraft(sessionId) : '') || '';
      const draft = !existing
        ? seed
        : (existing.includes(seed) ? existing : `${existing}\n\n${seed}`);
      if (typeof DevChat._setDraft === 'function') DevChat._setDraft(sessionId, draft);

      // Land on the Dev Chat tab focused on that session. switchTab →
      // renderDevChatTab(sessionId) opens the session (auto-resuming it when
      // paused), renders the chat view — which calls _restoreDraft() and
      // fills the composer, unsent — and syncs the hash for us.
      if (typeof App !== 'undefined' && App.switchTab) {
        await App.switchTab('dev', sessionId, 'sessions');
      }

      // Fallback for localStorage-disabled browsers (_setDraft silently
      // no-ops there): put the draft straight into the mounted textarea if
      // the draft restore left it empty. Focus with the cursor at the end on
      // fine-pointer devices only — focusing on touch would pop the
      // on-screen keyboard over the chat (#568).
      const input = document.getElementById('dc-input');
      if (input) {
        if (!input.value) {
          input.value = draft;
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        }
        if (typeof DevChat._isCoarsePointer !== 'function' || !DevChat._isCoarsePointer()) {
          try {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          } catch {}
        }
      }
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  },

  // Resolve AI availability once (memoized) and disable every card-level
  // "Explore in dev chat" button under `root` with a tooltip when no LLM is
  // configured — a dev chat with no model behind it can't answer. Must be
  // re-run after each feed/merged re-render, since innerHTML replacement
  // paints fresh, enabled buttons every time.
  _applyExploreChatAvailability(root) {
    const scope = root || document;
    if (!scope.querySelector('.gc-explore-chat-btn')) return;
    AppView._ensureAiAvailability().then((enabled) => {
      scope.querySelectorAll('.gc-explore-chat-btn').forEach((b) => {
        b.disabled = !enabled;
        if (!enabled) {
          b.title = "AI chat isn't configured on this deployment.";
          b.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
          b.title = AppView.EXPLORE_CHAT_TITLE;
          b.classList.remove('opacity-50', 'cursor-not-allowed');
        }
      });
    });
  },

  // Cached check of whether any LLM path is usable (platform key or the
  // user's BYOK key). Resolves to a boolean; the promise is memoized so
  // repeated topic renders don't refetch /api/budget every time.
  _ensureAiAvailability() {
    if (AppView._aiAvailabilityPromise) return AppView._aiAvailabilityPromise;
    AppView._aiAvailabilityPromise = (async () => {
      try {
        const res = await fetch('/api/budget');
        if (!res.ok) return true; // optimistic — the endpoint itself 503s if truly off
        const data = await res.json();
        return data.aiEnabled !== false;
      } catch {
        return true;
      }
    })();
    return AppView._aiAvailabilityPromise;
  },

  _mountTopicThread() {
    const t = AppView._devTopic;
    const slot = document.getElementById('dev-topic-thread');
    if (!t || !slot || typeof GroupChat === 'undefined' || !GroupChat.mountThread) return;
    // 'session' (a shared in-flight dev session) uses the same 'session'
    // thread namespace as promoted proposals — the thread key is the
    // chat_sessions id either way, which is exactly what makes comments
    // carry over when the session is later promoted.
    const typeMap = { issue: 'issue', proposal: 'session', gov: 'governance', session: 'session' };
    // Every topic thread — including merged proposals — mounts with a live,
    // editable composer. Merging settles the vote, not the conversation:
    // people keep posting follow-ups after a proposal lands. The WS handler
    // accepts session-thread posts on merged sessions (existence-only gate),
    // so there is no read-only lock or "voting closed" notice here.
    GroupChat.mountThread({
      type: typeMap[t.kind],
      ref: t.id,
      container: slot,
      fullHeight: true,
      // #363: request the in-scroll header slot so _renderTopicHead can paint
      // the topic card/body above the messages in the same scroll region.
      withHeader: true,
      // #621: non-collaborators read the thread but can't post to it.
      readOnly: AppView.readOnly,
      ...(AppView.readOnly
        ? { notice: "You're viewing this app's dev space read-only — only collaborators can post." }
        : {}),
    });
  },

  // Open a topic full-screen. Called by the cards' tap handler, the
  // Discussion buttons, and chat reference chips (revealInDrawer).
  // Returns switchTab's promise so callers that must not act until the
  // destination has painted (e.g. submitImportPr, which closes its dialog
  // afterwards) can await it. Fire-and-forget callers are unaffected.
  openTopic(kind, id) {
    if (!kind || !id) return;
    // Drop any on-demand proposal cached for a previous topic so its row
    // can never be mistaken for the one being opened now.
    AppView._topicProposal = null;
    // #665: an inline title edit never carries across topics — a stale
    // flag here would freeze the next issue's header repaints.
    AppView._editingIssueTitle = null;
    if (typeof App !== 'undefined' && App.switchTab) {
      return App.switchTab('dev', { kind, id }, 'topic');
    }
  },

  // ── Full-screen general chat sub-view ───────────────────────────────
  // A slim back-button header above the existing chat pane.
  // renderGroupChatTab mounts into #dev-chat-body exactly as it used to
  // mount into the pinned pane — spec side-panel, autocomplete, drafts,
  // and scroll restore all unchanged.
  _renderChatSubView(content) {
    content.innerHTML = `
      <div class="flex flex-col h-full min-h-0">
        <div class="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <a id="dev-chat-back" class="inline-flex items-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-sm" title="Back to the dev page" href="${AppView._devPageHref()}">&larr;</a>
          <span class="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider">General chat</span>
        </div>
        <div id="dev-chat-body" class="flex-1 min-h-0"></div>
      </div>`;

    document.getElementById('dev-chat-back').addEventListener('click', (e) => {
      // #1036: real anchor — leave a modified click to the browser.
      if (window.NavLink && NavLink.isNativeClick(e)) return;
      e.preventDefault();
      App.switchTab('dev');
    });

    AppView.renderGroupChatTab();
    // Vote snapshot for the inline buttons on activity rows — needed
    // here explicitly since the card list's feed load (which also
    // builds it) doesn't run for a cold dev/chat deep link.
    if (AppView.appData) AppView.loadVoteState(AppView.appData.slug);
  },

  // The App settings sub-page (secrets + display name behind a "+"
  // menu entry) was dissolved in #645 — Rename and App secrets now sit
  // directly in the "+" menu, alongside Members & visibility.

  // ── View-mode toggle (list ↔ kanban) ─────────────────────────────────
  // A two-button segmented control sitting to the LEFT of the "+" button.
  // Mirrors the existing inline-SVG icon convention used throughout this
  // file. The active button is tinted violet; both reflect their state
  // via aria-pressed for assistive tech.
  _viewToggleBtnCls(active) {
    return 'dev-view-btn w-7 h-7 flex items-center justify-center transition-colors '
      + (active
        ? 'bg-violet-600 text-white'
        : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800');
  },
  _renderViewToggle() {
    const mode = AppView._getViewMode();
    // List-lines icon (three rows) and a board/columns icon.
    const listSvg = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg>';
    const boardSvg = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z"/></svg>';
    // People icon (two-person silhouette) for the PM assignment overview.
    const peopleSvg = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-1a4 4 0 00-3-3.87M9 20H4v-1a4 4 0 013-3.87m6 4.87v-1a4 4 0 00-3-3.87M12 7a3 3 0 11-6 0 3 3 0 016 0zm7 3a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z"/></svg>';
    return `
      <div class="inline-flex items-center rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden mr-1" role="group" aria-label="Dev view mode">
        <button id="dev-view-list" data-view="list" class="${AppView._viewToggleBtnCls(mode === 'list')}" aria-pressed="${mode === 'list'}" title="List view" aria-label="List view">${listSvg}</button>
        <button id="dev-view-kanban" data-view="kanban" class="${AppView._viewToggleBtnCls(mode === 'kanban')}" aria-pressed="${mode === 'kanban'}" title="Kanban view" aria-label="Kanban view">${boardSvg}</button>
        <button id="dev-view-pm" data-view="pm" class="${AppView._viewToggleBtnCls(mode === 'pm')}" aria-pressed="${mode === 'pm'}" title="PM view — tasks by assignee" aria-label="PM view">${peopleSvg}</button>
      </div>`;
  },
  _wireViewToggle(content) {
    content.querySelectorAll('.dev-view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.view;
        const mode = (v === 'kanban' || v === 'pm') ? v : 'list';
        if (mode === AppView._getViewMode()) return;
        AppView._setViewMode(mode);
        AppView._updateViewToggleUI();
        // Re-flow the already-cached data into the new layout. No refetch.
        AppView._repaintDevBody();
      });
    });
  },
  // Swap the active/inactive styling + aria-pressed on the two toggle
  // buttons in place, so switching modes doesn't re-render the header bar.
  _updateViewToggleUI() {
    const mode = AppView._getViewMode();
    document.querySelectorAll('.dev-view-btn').forEach((btn) => {
      const active = btn.dataset.view === mode;
      btn.className = AppView._viewToggleBtnCls(active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  },

  // ── "+" menu ────────────────────────────────────────────────────────
  // Gate for the menu's Members & visibility item — the full predicate
  // the old hamburger-drawer row used: creator/admin always (visibility
  // + proposal-approval controls), collaborators of an invite-only app
  // (member list + invites), and anyone who can collaborate on an
  // invited-approvers app (read-only approver roster). For the self-app
  // (#646) it shows for admins — the modal there hides the
  // visibility/collaborator sections and offers only the
  // Proposal-approvals + Approvers sections.
  _plusMenuShowsMembers() {
    const a = AppView.appData;
    if (!a) return false;
    if (a.self_hosted) return !!a.can_manage;
    return !!(a.can_manage
      || (a.collab_visibility === 'private' && a.can_collaborate)
      || (a.approver_policy === 'invited' && a.can_collaborate));
  },
  _wirePlusMenu(content) {
    const btn = document.getElementById('dev-plus-btn');
    const menu = document.getElementById('dev-plus-menu');
    if (!btn || !menu) return;
    const close = () => {
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Touch platforms: present the same items as a bottom action
      // sheet (the anchored dropdown stays the desktop idiom). Each
      // sheet action delegates to the hidden menu row's own click
      // handler, so both idioms share one wiring path.
      if (PlatformUI.isTouch()) {
        AppView.refreshDevChatSecretsState();
        const rows = Array.from(menu.querySelectorAll('button[data-plus]'));
        PlatformUI.actionSheet({
          actions: rows.map((row) => ({
            label: (row.querySelector('span')?.textContent || row.textContent).replace(/\s+/g, ' ').trim(),
            handler: () => row.click(),
          })),
        });
        return;
      }
      const open = menu.classList.toggle('hidden') === false;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      // Refresh the App secrets item's "N required missing" state only
      // when the menu actually opens — no fetch on every card-list mount.
      if (open) AppView.refreshDevChatSecretsState();
    });
    // Outside-click dismiss, scoped to the dev view's lifetime (the
    // listener dies with the content innerHTML on the next render).
    content.addEventListener('click', (e) => {
      if (!e.target.closest('#dev-plus-menu, #dev-plus-btn')) close();
    });
    // proposal/issue/rename/secrets render together in the non-read-only
    // block; members is conditional within it (see _plusMenuShowsMembers),
    // so its handler needs an existence check like fork's.
    const proposalBtn = menu.querySelector('[data-plus="proposal"]');
    if (proposalBtn) {
      proposalBtn.addEventListener('click', () => {
        close();
        AppView.createProposal();
      });
    }
    // #1049: the same session, opened straight onto the flow picker. Its own
    // row rather than a sub-option of "Propose a change", because the whole
    // point is that the alternate flows are findable without knowing they
    // exist. Renders in the same non-read-only block as `proposal`.
    const proposalExternalBtn = menu.querySelector('[data-plus="proposal-external"]');
    if (proposalExternalBtn) {
      proposalExternalBtn.addEventListener('click', () => {
        close();
        AppView.createProposal({ pickFlow: true });
      });
    }
    // import-pr renders only when can_collaborate, so (like members/fork)
    // its handler needs an existence check.
    const importPrBtn = menu.querySelector('[data-plus="import-pr"]');
    if (importPrBtn) {
      importPrBtn.addEventListener('click', () => {
        close();
        AppView.openImportPrModal();
      });
    }
    const issueBtn = menu.querySelector('[data-plus="issue"]');
    if (issueBtn) {
      issueBtn.addEventListener('click', () => {
        close();
        // Open the shared Send Feedback modal with the dev-context mode:
        // the open app is preselected as the target (Platform for the
        // self-hosted app or while the repo doesn't exist yet) — #226.
        App.openFeedbackModal({ fromDev: true });
      });
    }
    const membersBtn = menu.querySelector('[data-plus="members"]');
    if (membersBtn) {
      membersBtn.addEventListener('click', () => {
        close();
        AppView.openMembersModal();
      });
    }
    const renameBtn = menu.querySelector('[data-plus="rename"]');
    if (renameBtn) {
      renameBtn.addEventListener('click', () => {
        close();
        AppView.promptRename();
      });
    }
    const secretsBtn = menu.querySelector('[data-plus="secrets"]');
    if (secretsBtn) {
      secretsBtn.addEventListener('click', () => {
        close();
        if (window.Secrets) Secrets.openForCurrentApp();
      });
    }
    const forkBtn = menu.querySelector('[data-plus="fork"]');
    if (forkBtn) {
      forkBtn.addEventListener('click', () => {
        close();
        AppView.promptFork();
      });
    }
  },

  // Best-effort one-line preview of the latest general-chat message for
  // the chat card. A failed fetch leaves the static fallback line.
  async _loadChatCardPreview() {
    const el = document.getElementById('dev-chat-card-preview');
    if (!el || !AppView.appData) return;
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/messages?limit=1`);
      if (!res.ok) return;
      const { messages } = await res.json();
      const m = messages && messages[messages.length - 1];
      if (!m || !m.content) return;
      const live = document.getElementById('dev-chat-card-preview');
      if (!live) return;
      const who = m.username || 'System';
      live.textContent = `${who}: ${String(m.content).slice(0, 140)}`;
    } catch { /* keep the fallback line */ }
  },

  // Re-pull live data for the dev card list. Called from the WS event
  // handlers in app.js (vote_update / issue_update / session_update /
  // lock_changed). The feed re-render preserves the open accordion
  // card. The chat view only needs the vote snapshot refreshed; the
  // session and settings views have their own refresh paths.
  // #607: polling fallback while any loaded proposal's checks are in
  // progress ('pending', or fresh-NULL with no verdict recorded yet). The
  // WS checks_ready broadcasts are the primary update channel; this only
  // covers missed pushes (disconnect, laptop waking from sleep). Called
  // after every dev-data load, so the interval self-clears on the load
  // that finds nothing in progress.
  _checksPollHandle: null,
  _syncChecksPoll(proposals) {
    const inProgress = Array.isArray(proposals) && proposals.some((pr) =>
      pr && pr.status !== 'merged'
      && (pr.check_state === 'pending' || (!pr.check_state && !pr.console_check_state)));
    if (!inProgress) {
      if (AppView._checksPollHandle) {
        clearInterval(AppView._checksPollHandle);
        AppView._checksPollHandle = null;
      }
      return;
    }
    if (AppView._checksPollHandle) return;
    AppView._checksPollHandle = setInterval(() => {
      // Leaving the dev tab (or the app view) ends the poll; a hidden tab
      // just skips the tick and resumes when visible again.
      if (!AppView.appData || typeof App === 'undefined' || App.currentTab !== 'dev') {
        clearInterval(AppView._checksPollHandle);
        AppView._checksPollHandle = null;
        return;
      }
      if (document.hidden) return;
      AppView.refreshDevData('checks-poll');
    }, 20000);
  },

  refreshDevData(kind) {
    if (!AppView.appData || typeof App === 'undefined' || App.currentTab !== 'dev') return;
    if (App.currentSubTab === 'chat') {
      AppView.loadVoteState(AppView.appData.slug);
      return;
    }
    if (App.currentSubTab === 'topic') {
      // Refresh the header card / roster in place; the mounted thread
      // is left alone (it receives live messages directly).
      AppView._loadDevData().then(() => AppView._renderTopicHead());
      return;
    }
    if (App.currentSubTab !== 'forum') return;
    // Session rows render inside the board/feed now, so the full-feed
    // reload below covers session_update events too (no separate strip).
    AppView._loadDevFeed();
  },

  // Fetch the vote snapshot (promoted + merged) that powers the inline
  // vote buttons on group-chat activity rows (AppView.voteState — see
  // group-chat.js refreshVoteControls). The chat sub-tab calls this in
  // place of the old full vote-panel load.
  async loadVoteState(slug) {
    try {
      const [promotedRes, mergedRes] = await Promise.all([
        fetch(`/api/apps/${slug}/promoted`),
        fetch(`/api/apps/${slug}/merged`),
      ]);
      const promotedData = promotedRes.ok ? await promotedRes.json() : { promoted: [] };
      const merged = mergedRes.ok ? (await mergedRes.json()).merged : [];
      const promoted = promotedData.promoted || [];
      // Promoted/merging fill in last so an open PR's live row always
      // wins over its merged snapshot.
      const voteRows = [...(merged || []), ...promoted];
      AppView.voteState = {
        bySession: Object.fromEntries(voteRows.map((pr) => [String(pr.id), pr])),
        byPrNumber: Object.fromEntries(
          voteRows.filter((pr) => pr.pr_number != null).map((pr) => [String(pr.pr_number), pr])
        ),
        majority: promotedData.majority || 1,
        activeUsers: promotedData.activeUsers || 1,
      };
      if (typeof GroupChat !== 'undefined' && GroupChat.refreshVoteControls) {
        GroupChat.refreshVoteControls();
      }
      // #607: keep the checks-in-progress polling fallback in sync on the
      // chat sub-tab's vote-snapshot path too.
      AppView._syncChecksPoll(promoted);
      return { promoted, merged, promotedData };
    } catch {
      return null;
    }
  },

  renderGroupChatTab() {
    // Card-list revision: general chat mounts into the full-screen chat
    // sub-view's body (falling back to the generic container for any
    // legacy caller).
    const content = document.getElementById('dev-chat-body') || AppView._devContainer();
    if (!content) return;

    // (#3) First-arrival framing: name what Group Chat is for. Group chat
    // is rarely empty (system messages), so a permanent banner would be
    // clutter — show it once per browser, then it disappears.
    const gcAppName = (AppView.appData && AppView.appData.name) ? AppView.appData.name : 'this app';
    let gcIntroHtml = '';
    try {
      if (!localStorage.getItem('usernode_seen_gc_intro')) {
        gcIntroHtml = `<div class="mx-3 mt-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-xs text-zinc-600 dark:text-zinc-300">This is where everyone using <span class="font-medium">${escapeHtml(gcAppName)}</span> talks and votes on proposed changes to it.</div>`;
        localStorage.setItem('usernode_seen_gc_intro', '1');
      }
    } catch { /* private-mode / disabled storage: just skip the intro */ }
    // Layout mirrors dev-chat's session view: a flex-row body that
    // holds the chat pane on the left and a slot for the spec
    // side-panel on the right. The slot is empty + display:none until
    // "View full spec" is clicked, so the chat occupies 100% width by
    // default. CSS toggles the side-panel layout vs. fullscreen-modal
    // layout based on viewport width. (#194: the old vote/issue panel
    // that sat above the chat is decomposed into the Issues and
    // Proposals sub-tabs — this tab is the message stream only.)
    content.innerHTML = `
      <div class="flex flex-col h-full">
        <div class="gc-tab-body flex-1 flex min-h-0">
          <div class="gc-chat-pane flex-1 flex flex-col min-h-0">
            ${gcIntroHtml}
            <!-- Messages -->
            <div id="gc-messages" class="flex-1 overflow-y-auto py-2 space-y-0.5"></div>

            <!-- Typing indicator -->
            <div id="gc-typing" class="px-3 text-xs text-zinc-500 h-5 shrink-0"></div>

            <!-- Input (#621: read-only viewers get a notice instead).
                 platform-safe-bar (app.css) adds the home-indicator
                 inset to this bar's own p-2 — it wraps both the composer
                 and the read-only notice, so both clear the indicator.
                 (No backticks in this comment: it lives inside a template
                 literal, and one would close it.) -->
            <div class="shrink-0 border-t border-zinc-200 dark:border-zinc-800 p-2 platform-safe-bar">
              ${AppView.readOnly ? `
              <div class="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400 text-center">You're viewing this app's dev space read-only — only collaborators can post.</div>
              ` : `
              <!-- #15: "Replying to …" preview chip; populated by
                   GroupChat._renderQuotePreview when a quote is staged. -->
              <div id="gc-reply-preview" class="hidden"></div>
              <!-- #694: file attachments — error line + pending strip above
                   the composer (reuses the dev-chat dc-attach-* styles). -->
              <div id="gc-attach-error" class="dc-attach-error hidden"></div>
              <div id="gc-attachments" class="dc-attach-strip"></div>
              <form id="gc-form" class="flex gap-2 items-end">
                <button type="button" id="gc-attach-btn" title="Attach files" aria-label="Attach files" class="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-500 hover:border-violet-500 transition-colors">&#128206;</button>
                <input type="file" id="gc-file-input" class="hidden" multiple>
                <textarea
                  id="gc-input"
                  maxlength="${typeof GC_MAX_MESSAGE_LEN !== 'undefined' ? GC_MAX_MESSAGE_LEN : 8000}"
                  rows="1"
                  placeholder="Type a message..."
                  autocomplete="off"
                  class="gc-composer-input flex-1 min-w-0 resize-none overflow-y-auto rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                ></textarea>
                <button type="submit" class="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors shrink-0">Send</button>
              </form>`}
            </div>
          </div>

          <!-- Draggable divider between chat pane and spec panel.
               CSS keeps it display:none until both
                 (a) .gc-spec-resizer-open is added (panel is open), and
                 (b) viewport >= 1024px (side-panel layout, not modal).
               GroupChat._initSpecPanelResizer wires a pointer-event
               drag handler that updates the panel inline width and
               persists the final value to localStorage. -->
          <div id="gc-spec-resizer" class="gc-spec-resizer" role="separator" aria-orientation="vertical" aria-label="Resize spec panel"></div>

          <!-- Spec side-panel slot. Lives empty in the DOM so a
               re-render of this tab doesn't tear down a panel the
               user has open. _showSpecPanel populates + toggles
               .gc-spec-side-panel-open; CSS handles the responsive
               side-panel-vs-fullscreen-modal switch at 1024px. -->
          <div id="gc-spec-side-panel" class="gc-spec-side-panel"></div>
        </div>
      </div>`;

    // Kit polish: fixed-shell keyboard avoidance on the general-chat
    // scroller (the screen's top bar is the shared platform header, so
    // the nav-bar hairline treatment is skipped — navBar:false).
    PlatformUI.attachScreenFx(
      'group-chat',
      document.getElementById('gc-messages'),
      document.getElementById('platform-header'),
      { navBar: false },
    );

    const gcInput = document.getElementById('gc-input');
    // #621: read-only viewers have no composer — mount the live stream
    // (WS connects at view level; the server drops any write) and stop.
    if (!gcInput) {
      if (AppView.appData) GroupChat.mount(AppView.appData.slug);
      return;
    }
    // Restore any in-progress draft. The input element is a new DOM node
    // on every tab switch, so we rehydrate from the persisted draft
    // (localStorage-backed, keyed by app slug) — this also survives full
    // page refreshes.
    const slugForDraft = AppView.appData?.slug;
    if (slugForDraft) {
      const saved = GroupChat.getDraft(slugForDraft);
      if (saved) gcInput.value = saved;
    }
    // Size the (now multi-line) composer to its restored draft, then back
    // to one row after a send.
    GroupChat._autoGrowTextarea(gcInput);

    const submitGeneral = () => {
      const content = gcInput.value.trim();
      // #694: an attachments-only send is allowed; a send while an upload
      // is still in flight waits (input keeps its text).
      if (GroupChat.attachmentsUploading(null)) {
        GroupChat._setAttachError('Still uploading — one moment…', null);
        return;
      }
      if (!content && !GroupChat.hasPendingAttachments(null)) return;
      GroupChat.send(content);
      gcInput.value = '';
      if (slugForDraft) GroupChat.setDraft(slugForDraft, '');
      GroupChat._autoGrowTextarea(gcInput);
    };

    document.getElementById('gc-form').addEventListener('submit', (e) => {
      e.preventDefault();
      submitGeneral();
    });

    // #694: paperclip / paste / drag-and-drop attachment wiring for the
    // general composer (thread composers wire their own in mountThread).
    GroupChat.setupAttachments(null);

    gcInput.addEventListener('input', () => {
      if (slugForDraft) GroupChat.setDraft(slugForDraft, gcInput.value);
      GroupChat._autoGrowTextarea(gcInput);
      GroupChat.sendTyping();
    });

    // Multi-line submit semantics: a <textarea> doesn't auto-submit on
    // Enter, so we drive it here. Enter (no Shift) sends; Shift+Enter
    // inserts a newline (default). On touch the on-screen return key
    // always inserts a newline (no Shift chord there) — the Send button is
    // the reliable send action. Bubble phase, so the autocomplete's
    // capture-phase keydown still owns Enter while its dropdown is open.
    gcInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !GroupChat._isTouch()) {
        e.preventDefault();
        submitGeneral();
      }
    });

    // #87: @mention autocomplete. Re-attaches on every tab mount (the
    // input is a fresh DOM node each time). Its capture-phase keydown
    // handler intercepts Enter/Tab/Arrows/Escape while the dropdown is
    // open, so the form submit + the Escape-clears-reply handler below
    // only see those keys once the dropdown is closed.
    if (typeof MentionAutocomplete !== 'undefined') {
      MentionAutocomplete.attach(gcInput, slugForDraft);
    }

    // #130: PR# / # reference autocomplete (open PRs + open issues). Same
    // attach lifecycle as mentions; its capture-phase keydown only consumes
    // keys while its own menu is open, and the `@` vs `#` triggers are
    // mutually exclusive so the two menus never fight.
    if (typeof RefAutocomplete !== 'undefined') {
      RefAutocomplete.attach(gcInput, slugForDraft);
    }

    // #15: Escape clears a staged reply quote (when the input is empty so
    // we don't fight other Escape semantics mid-typing).
    gcInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && GroupChat.replyDraft && !gcInput.value) {
        e.preventDefault();
        GroupChat.clearQuote();
      }
    });

    if (AppView.appData) {
      // `mount` re-uses the existing WS + message cache when the user
      // comes back to this tab, preserving their scroll position; it only
      // opens a fresh connection on the first visit to an app.
      GroupChat.mount(AppView.appData.slug);
      // The inline vote buttons on activity rows read AppView.voteState,
      // which the forum's feed load (running right after this mount)
      // populates from the same /promoted + /merged data — no separate
      // fetch needed here.
    }
    // Re-render any staged reply preview (the composer DOM was just
    // recreated on this tab (re-)entry, but replyDraft persists).
    GroupChat._renderQuotePreview();
  },

  // ── Forum feed (#194 revision) ──────────────────────────────────────
  // One intermixed list — GitHub issues + PR proposals + governance
  // proposals — sorted by most recent activity (the item's own
  // timestamp vs. the latest message in its thread). Data comes from
  // the same four endpoints the old Issues/Proposals tabs used.

  // Staging-only demo mode: when the page itself was opened with
  // ?demo=1 (hash navigation preserves the search string), forward it
  // to the dev-data fetches so the server appends "[Mock]" long-title
  // issues/proposals for layout verification. The server only honors
  // the flag when USERNODE_ENV === 'staging', so this is inert in
  // production no matter what's in the URL.
  _demoQS() {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  },

  // Session caches for the Dev board's In progress area:
  //   _mySessions        — the viewer's active/paused sessions on THIS app
  //                        (pinned at the top of In progress), most recent
  //                        activity first. From /api/me/active-sessions.
  //   _sharedSessions    — OTHER users' shared sessions (bottom of In
  //                        progress), oldest-shared first. Derived from
  //                        /api/apps/:slug/shared-sessions.
  //   _sharedById        — every shared row (own included) keyed by id, so
  //                        the owner's pinned card can show its 💬 count.
  //   _archivedSessions  — the viewer's archived rows for this app (the
  //                        collapsed "Show archived" toggle).
  // Refreshed with the full dev load AND by the 15s busy-indicator poll;
  // returns true when anything changed (JSON signature) so the poll can
  // skip repainting on idle ticks.
  async _refreshSessionCaches(slug) {
    const actTs = (s) => {
      const t = Date.parse(s.last_activity_at || s.created_at || '');
      return Number.isFinite(t) ? t : 0;
    };
    let mine = [];
    let sharedAll = [];
    let archived = [];
    // #1038: stamped BEFORE the requests go out — see SessionState.seed.
    const issuedAt = Date.now();
    try {
      const [activeRes, sharedRes, allRes] = await Promise.all([
        // ?demo=1 forwarded so the staging mock own-session row (pinned
        // block caption + Make visible button) renders in demo previews.
        fetch(`/api/me/active-sessions${AppView._demoQS()}`).catch(() => null),
        fetch(`/api/apps/${encodeURIComponent(slug)}/shared-sessions${AppView._demoQS()}`).catch(() => null),
        // ?demo=1 forwarded here too so the staging mock archived row
        // (the "Show archived" toggle demo anchor) renders in previews.
        fetch(`/api/apps/${encodeURIComponent(slug)}/sessions${AppView._demoQS()}`).catch(() => null),
      ]);
      if (activeRes && activeRes.ok) {
        const data = await activeRes.json().catch(() => ({}));
        mine = (data.sessions || [])
          .filter((s) => s.app_slug === slug && (s.status === 'active' || s.status === 'paused'))
          .sort((a, b) => actTs(b) - actTs(a));
      }
      if (sharedRes && sharedRes.ok) {
        const data = await sharedRes.json().catch(() => ({}));
        sharedAll = data.sessions || [];
      }
      if (allRes && allRes.ok) {
        const data = await allRes.json().catch(() => ({}));
        archived = (data.sessions || [])
          .filter((s) => s.status === 'archived')
          .sort((a, b) => actTs(b) - actTs(a));
      }
    } catch { /* keep whatever loaded */ }
    // Fold both payloads' busy flags into the live store; a pushed event
    // newer than `issuedAt` still wins, so a slow response can't resurrect
    // a finished turn's spinner.
    if (typeof window !== 'undefined' && window.SessionState) {
      SessionState.seed([...mine, ...sharedAll], issuedAt);
    }
    const sig = JSON.stringify([mine, sharedAll, archived]);
    const changed = sig !== AppView._sessionsSig;
    AppView._sessionsSig = sig;
    AppView._mySessions = mine;
    AppView._sharedById = Object.fromEntries(sharedAll.map((s) => [s.id, s]));
    const myId = (typeof App !== 'undefined' && App.user) ? App.user.id : null;
    AppView._sharedSessions = sharedAll
      .filter((s) => s.user_id !== myId)
      .sort((a, b) => (Date.parse(a.shared_at || '') || 0) - (Date.parse(b.shared_at || '') || 0));
    AppView._archivedSessions = archived;
    return changed;
  },

  // Fetch + cache everything the dev surfaces render from (the same
  // four endpoints the old tabs used): GitHub issues, governance
  // proposals, open PR proposals, merged PRs, plus voteState for the
  // chat's inline vote rows — plus the session caches above (the In
  // progress area renders them now). Shared by the card list and the
  // topic sub-view. Returns false on a failed load.
  async _loadDevData() {
    if (!AppView.appData) return false;
    const slug = AppView.appData.slug;
    try {
      const [ghRes, issuesRes, promotedRes, mergedRes, orderRes, pmOrderRes] = await Promise.all([
        fetch(`/api/apps/${slug}/github-issues${AppView._demoQS()}`),
        // Forward ?demo=1 here too so the staging mock GOVERNANCE rows
        // (stagingMockGovernance — rename / secret / close-issue cards)
        // actually reach the board. Server-side the append is gated on
        // IS_STAGING, so this is a no-op in production.
        fetch(`/api/apps/${slug}/issues${AppView._demoQS()}`),
        fetch(`/api/apps/${slug}/promoted${AppView._demoQS()}`),
        // Forward ?demo=1 to /merged too so the kanban "Done" column (and
        // the list's Completed block) populate in a staging ?demo=1 preview.
        // Server-side the demo append is gated on IS_STAGING, so this is a
        // no-op in production. votes.js stagingMockMerged() supplies the rows.
        fetch(`/api/apps/${slug}/merged${AppView._demoQS()}`),
        // #613: the manual drag-and-drop order overlay for the Issues + In
        // review columns. Forward ?demo=1 so a staging preview seeds a
        // visibly non-default order; a no-op in production. `.catch` keeps a
        // failed order fetch from sinking the whole board load — an absent
        // order just means the default (derived) sort, i.e. today's board.
        fetch(`/api/apps/${slug}/board-order${AppView._demoQS()}`).catch(() => null),
        // The PM view's per-person manual order overlay. Same tolerance +
        // ?demo=1 forwarding as board-order; an absent map means every
        // section uses the default recency sort (today's PM view).
        fetch(`/api/apps/${slug}/pm-order${AppView._demoQS()}`).catch(() => null),
        // Session caches (own + shared + archived) ride along in the same
        // parallel load; the helper stores them on AppView directly, so
        // there's no destructured slot for it.
        AppView._refreshSessionCaches(slug),
        // #780: the app's category vocabulary (built-ins + custom), needed
        // before the first paint so custom chips get their label/colour and
        // the filter bar offers them. Stores onto AppView directly and
        // swallows failures, so no destructured slot and no board-load risk.
        AppView._loadAppCategories(),
      ]);
      const ghData = ghRes.ok ? await ghRes.json() : { issues: [] };
      const issuesData = issuesRes.ok ? await issuesRes.json() : { issues: [] };
      const promotedData = promotedRes.ok ? await promotedRes.json() : { promoted: [] };
      const mergedData = mergedRes.ok ? await mergedRes.json() : { merged: [], hasMore: false };
      const merged = mergedData.merged || [];
      // #613: manual card-order overlay per column. Shape { issues:[{type,ref}],
      // review:[{type,ref}] }. Tolerates a missing/failed fetch (older server
      // or transient error) by keeping the previous cache / defaulting empty.
      const orderData = (orderRes && orderRes.ok) ? await orderRes.json().catch(() => null) : null;
      AppView._boardOrder = {
        issues: (orderData && Array.isArray(orderData.issues)) ? orderData.issues : [],
        review: (orderData && Array.isArray(orderData.review)) ? orderData.review : [],
      };
      // PM per-person order overlay. Shape { <assignee_key>: [{type,ref}] }.
      // Tolerates a missing/failed fetch by defaulting to an empty map (every
      // section falls back to the derived recency sort).
      const pmOrderData = (pmOrderRes && pmOrderRes.ok) ? await pmOrderRes.json().catch(() => null) : null;
      AppView._pmOrder = (pmOrderData && typeof pmOrderData === 'object' && !Array.isArray(pmOrderData))
        ? pmOrderData : {};

      AppView._ghIssues = Array.isArray(ghData.issues) ? ghData.issues : [];
      AppView._ghIssuesMeta = {
        truncatedList: !!ghData.truncatedList,
        note: ghData.note || null,
        repoUrl: (AppView.appData && AppView.appData.repo_url) || null,
        myRemaining: typeof ghData.myRemaining === 'number' ? ghData.myRemaining : null,
      };
      // GitHub twins of open env-var proposals render as governance
      // cards only — keep their issue rows out of the feed (#131).
      AppView._envIssueNumbers = new Set(
        (issuesData.issues || [])
          .filter((i) => i.kind === 'secret_change')
          .map((i) => i.github_issue_number)
          .filter(Boolean)
      );

      const promoted = promotedData.promoted || [];
      const majority = promotedData.majority || 1;
      const activeUsers = promotedData.activeUsers || 1;
      const locked = !!promotedData.locked;

      // Shared inline-vote snapshot (same shape loadVoteState builds) so
      // the chat view's activity rows stay in sync without a refetch.
      // Close-issue rows stay OUT of voteState: it's a PR concept keyed by
      // chat_sessions ids, and issues.id can collide with those numerically.
      const voteRows = [
        ...(merged || []).filter((r) => (r.row_type || 'pr') === 'pr'),
        ...promoted,
      ];
      AppView.voteState = {
        bySession: Object.fromEntries(voteRows.map((pr) => [String(pr.id), pr])),
        byPrNumber: Object.fromEntries(
          voteRows.filter((pr) => pr.pr_number != null).map((pr) => [String(pr.pr_number), pr])
        ),
        majority,
        activeUsers,
      };
      if (typeof GroupChat !== 'undefined' && GroupChat.refreshVoteControls) {
        GroupChat.refreshVoteControls();
      }

      AppView._proposals = promoted;
      AppView._govProposals = (issuesData.issues || [])
        .filter((i) => i.kind === 'secret_change' || i.kind === 'rename' || i.kind === 'close_issue'
          || i.kind === 'maintenance_campaign');
      AppView._proposalsCtx = {
        majority,
        activeUsers,
        locked,
        // #646: the app's configured approval settings, for the
        // "How voting works" explainer copy.
        approverPolicy: promotedData.approverPolicy || 'anyone',
        approvalsRequired: promotedData.approvalsRequired != null
          ? promotedData.approvalsRequired : null,
        // #788: is the viewer one of this app's declared admins? Drives
        // whether the "Admin merge" button renders for a non-platform
        // admin. The server re-checks on every force-merge, so this is
        // purely an affordance.
        isAppAdmin: !!promotedData.isAppAdmin,
        lockedHint: locked
          ? ' <span class="text-amber-500 font-normal">· locked: also needs an admin yes</span>'
          : '',
      };
      AppView._merged = merged;
      AppView._mergedCtx = { majority, activeUsers };
      // #429: reset the pager state on a fresh load. _mergedHasMore drives
      // the "Load more" footer; the cursor is the (created_at, id) of the
      // last loaded row, used by loadMoreMerged() for keyset paging.
      AppView._mergedHasMore = !!mergedData.hasMore;
      AppView._mergedCursor = merged.length
        ? {
          created_at: merged[merged.length - 1].created_at,
          id: merged[merged.length - 1].id,
          // The stream mixes PR + close-issue rows from independent id
          // sequences, so the cursor carries the last row's type too.
          row_type: merged[merged.length - 1].row_type || 'pr',
        }
        : null;
      // #433: the true count of merged tasks for this app, used by the
      // Kanban "Done" column header (which renders only the first page of
      // cards and would otherwise show the loaded count, ~20). Falls back to
      // the loaded length on an older server that doesn't return `total`.
      AppView._mergedTotal = (typeof mergedData.total === 'number')
        ? mergedData.total
        : merged.length;
      // #607: keep the checks-in-progress polling fallback in sync with
      // what this load actually saw.
      AppView._syncChecksPoll(promoted);
      return true;
    } catch {
      return false;
    }
  },

  async _loadDevFeed() {
    const ok = await AppView._loadDevData();
    const body = document.getElementById('dev-body');
    if (!body) return;
    if (!ok) {
      body.innerHTML = '<div class="text-xs text-zinc-500 dark:text-zinc-400">Couldn&#39;t load the feed right now.</div>';
      return;
    }
    AppView._renderLockedNotice();
    AppView._repaintDevBody();
  },

  // Paint #dev-body for the current view mode from cached data only (no
  // refetch). Mode-aware so every caller — the initial load, WS-driven
  // refreshes, the toggle, and optimistic card-action repaints — routes
  // through one place. No-ops when #dev-body isn't mounted (topic / chat
  // / settings sub-views), matching the old _rerenderFeed guard.
  _repaintDevBody() {
    const body = document.getElementById('dev-body');
    if (!body) return;
    // The ⋯ menu is body-mounted and position:fixed, so this innerHTML swap
    // never touches it — only the trigger it was anchored to. Each branch
    // below therefore ends in _reanchorCardMenu() rather than dismissing an
    // open menu outright; see that function for why that distinction is the
    // difference between the ⋯ working and appearing not to.
    if (AppView._getViewMode() === 'kanban') {
      // #482: two-node shell — the filter bar is built + wired once per
      // mount and kept stable across repaints (so search-input focus and
      // typed text survive WS-driven refreshes); only the board region
      // re-renders. Switching list → kanban rebuilds the bar from the
      // surviving _kanbanFilters, so filter state outlives the toggle.
      if (!document.getElementById('dev-kanban-filterbar')
          || !document.getElementById('dev-kanban-board')) {
        // Restore this app's persisted filters before building the bar, so
        // the controls (and the board) come back exactly as the user left
        // them across navigation / reload. Keyed per slug, so switching apps
        // shows that app's own filters (or a clean board).
        AppView._kanbanFilters = AppView._loadKanbanFilters(App.currentApp);
        // #814: restore this app's active mobile tab alongside its filters,
        // so switching apps shows that app's own column (or Issues).
        AppView._kanbanTab = AppView._loadKanbanTab(App.currentApp);
        body.innerHTML = '<div id="dev-kanban-filterbar" class="mb-2"></div><div id="dev-kanban-board"></div>';
        AppView._renderKanbanFilterBar();
      }
      AppView._repaintKanbanBoard();
      return;
    }
    if (AppView._getViewMode() === 'pm') {
      // PM view: a single scrolling container of per-assignee sections plus
      // an Unassigned section. No #gc-merged block (merged + gov are
      // excluded from this overview). #625: the kanban filter bar mounts
      // here too — same two-node shell as the kanban branch, sharing
      // _kanbanFilters and its per-app persistence, so filters survive the
      // kanban↔PM toggle and the bar node stays stable across repaints.
      if (!document.getElementById('dev-kanban-filterbar')
          || !document.getElementById('dev-pm')) {
        AppView._kanbanFilters = AppView._loadKanbanFilters(App.currentApp);
        body.innerHTML = '<div id="dev-kanban-filterbar" class="mb-2"></div><div id="dev-pm"></div>';
        AppView._renderKanbanFilterBar();
      }
      AppView._repaintPmView();
      return;
    }
    // List mode: rebuild the two-container shell, then fill it exactly as
    // before. _rerenderFeed targets #dev-feed and re-attaches kudos/ask-AI
    // there; the Completed block is filled + wired here.
    body.innerHTML = '<div id="dev-feed"></div><div id="gc-merged" class="mt-4"></div>';
    AppView._rerenderFeed();
    const mergedEl = document.getElementById('gc-merged');
    if (mergedEl) {
      mergedEl.innerHTML = (AppView._merged || []).length ? AppView._renderMergedInner() : '';
      if (window.Kudos) Kudos.attach(mergedEl);
      AppView._applyExploreChatAvailability(mergedEl);
    }
    AppView._reanchorCardMenu();
  },

  // Locked-app banner at the very top of the card list (above the
  // General chat card), per the card-list polish revision.
  _renderLockedNotice() {
    const el = document.getElementById('dev-locked-notice');
    if (!el) return;
    const locked = !!(AppView._proposalsCtx && AppView._proposalsCtx.locked);
    el.classList.toggle('hidden', !locked);
    el.innerHTML = locked
      ? '<div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-600 dark:text-amber-400">App is locked — an admin must approve any proposal before it applies.</div>'
      : '';
  },

  // The feed's display order: fixed groups — proposals being voted on
  // (PR promotions and governance proposals alike) above open issues —
  // then auto-solve rank within the issues group (#227: 'generating'
  // runs first, finished 'ready' runs awaiting review next, plain
  // issues last — see _headlessRank), then most-recent-activity-first.
  // Every item carries a lastActivity sort key = max(its own timestamp,
  // the latest message in its thread); equal keys keep the per-source
  // order (GitHub updated-desc for issues) via stable sort. The
  // general-chat card and the viewer's session rows sit above this feed
  // in the card list, so the full order the user sees is:
  // chat → sessions → proposals → issues.
  _feedItems() {
    const ts = (v) => {
      const t = Date.parse(v || '');
      return Number.isFinite(t) ? t : 0;
    };
    // Lower group renders first. Proposals (both kinds) share a group;
    // other users' shared sessions live inside the issues group (their
    // in-tier rank places them below the in-progress issues).
    const GROUP = { proposal: 0, gov: 0, issue: 1, 'shared-session': 1 };
    const items = [];
    for (const issue of AppView._visibleGhIssues()) {
      items.push({
        kind: 'issue', id: issue.number, item: issue,
        r: AppView._headlessRank(issue),
        t: Math.max(ts(issue.updatedAt), ts(issue.lastMessageAt)),
      });
    }
    for (const pr of AppView._proposals || []) {
      items.push({
        // #388: pin PRs in the merge pipeline to the top of the proposal
        // group — _proposalPinRank mirrors the badge precedence (merging >
        // resolving > conflict-failed > normal), reusing the per-group `r`
        // slot just like _headlessRank does for issues.
        kind: 'proposal', id: pr.id, item: pr, r: AppView._proposalPinRank(pr),
        t: Math.max(ts(pr.promoted_at || pr.created_at), ts(pr.last_message_at)),
      });
    }
    for (const g of AppView._govProposals || []) {
      items.push({
        // Governance proposals have no merge/conflict state, so they sort
        // in the normal (unpinned) tier alongside non-pipeline PRs (#388).
        kind: 'gov', id: g.id, item: g, r: 3,
        t: Math.max(ts(g.created_at), ts(g.last_message_at)),
      });
    }
    for (const s of AppView._sharedSessions || []) {
      // Other users' shared sessions sit at the BOTTOM of the list's
      // in-progress cluster: inside the issues group, ranked between
      // 'ready' headless issues (1) and plain issues (2). Within the
      // tier they order oldest-shared first (matching the kanban
      // column), so t is the negated shared_at — the feed sorts t
      // descending, and negation flips that into shared_at ascending.
      items.push({
        kind: 'shared-session', id: s.id, item: s, r: 1.5,
        t: -(ts(s.shared_at)),
      });
    }
    // Array.prototype.sort is stable, so equal keys keep source order.
    // Rank competes only within a group: the headless rank (0-2, with
    // shared sessions at 1.5) inside the issues group, the merge-pipeline
    // pin rank (0-3) inside the proposal group — the two never interleave
    // because GROUP dominates.
    return items.sort((a, b) =>
      (GROUP[a.kind] - GROUP[b.kind]) || (a.r - b.r) || (b.t - a.t));
  },

  _renderFeedInner() {
    const ctx = AppView._proposalsCtx || {};
    const meta = AppView._ghIssuesMeta || {};
    const items = AppView._feedItems();

    // The viewer's own sessions are pinned above the feed proper (top of
    // the list), outside the "Show more" pager, with the visibility
    // caption + the archived toggle. Renders '' when there's nothing.
    let html = AppView._mySessionsBlockHtml();
    if (!items.length) {
      const note = meta.note
        ? 'Couldn&#39;t load open issues right now. '
        : '';
      html += `<div class="text-xs text-zinc-500 dark:text-zinc-400 mb-2">${note}Nothing is open right now. Press <span class="font-medium text-violet-500">+</span> to propose a change or file an issue.</div>`;
      return html;
    }

    const shown = Math.min(AppView._feedShown || 20, items.length);
    html += '<div class="space-y-2">';
    for (let i = 0; i < shown; i++) {
      const it = items[i];
      if (it.kind === 'issue') html += AppView._renderIssueRow(it.item);
      else if (it.kind === 'proposal') html += AppView._renderProposalCard(it.item);
      else if (it.kind === 'shared-session') html += AppView._renderSharedSessionCard(it.item);
      else html += AppView._renderGovCard(it.item);
    }
    html += '</div>';

    // Keep the generating-state poller in sync with what we just
    // rendered (idempotent set/clear of one timer).

    // Paging footer: more local items, or a GitHub link when the repo
    // has more open issues than the fetch ceiling.
    if (shown < items.length) {
      html += `<div class="mt-1"><button class="gc-vote-btn" onclick="AppView.showMoreFeed()">Show ${Math.min(10, items.length - shown)} more</button></div>`;
    } else if (meta.truncatedList && meta.repoUrl) {
      const issuesUrl = `${meta.repoUrl.replace(/\.git$/, '').replace(/\/$/, '')}/issues`;
      html += `<div class="mt-1"><a href="${issuesUrl}" target="_blank" rel="noopener" class="text-xs text-violet-400 hover:underline">More open issues on GitHub &rarr;</a></div>`;
    }
    return html;
  },

  // Re-render the feed in place from the cached data, then re-mount the
  // expanded card's thread + roster (innerHTML replacement wipes any
  // previous mount).
  _rerenderFeed() {
    const el = document.getElementById('dev-feed');
    if (!el) return;
    el.innerHTML = AppView._renderFeedInner();
    if (window.Kudos) Kudos.attach(el);
    AppView._applyExploreChatAvailability(el);
    AppView._startMergeCountdownTimer();
  },

  // Compact "time remaining" label for the merge-window countdown pill.
  // Two-unit, floor-rounded (#627): ~Xd Yh above a day, ~Xh Ym above an
  // hour, ~Xm (min 1) below — zero second units are omitted (~2d, ~5h).
  _fmtCountdown(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const d = Math.floor(s / 86400);
    if (d >= 1) {
      const h = Math.floor((s % 86400) / 3600);
      return h >= 1 ? `~${d}d ${h}h` : `~${d}d`;
    }
    const h = Math.floor(s / 3600);
    if (h >= 1) {
      const m = Math.floor((s % 3600) / 60);
      return m >= 1 ? `~${h}h ${m}m` : `~${h}h`;
    }
    const m = Math.max(1, Math.floor(s / 60));
    return `~${m}m`;
  },

  // Ticks the "Merging in ~X" / "Rejecting in ~X" countdown pills purely from
  // the passage of time (vote changes already refetch via the WS vote-update
  // path). Updates each pill's label in place; when a window crosses zero it
  // refetches the feed so the row reflects server truth — the actual merge /
  // takedown is server-driven (next vote, or the stale-PR sweeper's
  // window-elapsed / rejection pass). Self-clears when no countdown pills
  // remain so it never runs idle.
  _COUNTDOWN_SEL: '.gc-merge-countdown[data-window-ends], .gc-reject-countdown[data-window-ends]',
  _startMergeCountdownTimer() {
    const feed = document.getElementById('dev-feed');
    if (!feed || !feed.querySelector(AppView._COUNTDOWN_SEL)) {
      if (AppView._mergeCountdownTimer) {
        clearInterval(AppView._mergeCountdownTimer);
        AppView._mergeCountdownTimer = null;
      }
      return;
    }
    if (AppView._mergeCountdownTimer) return;
    AppView._mergeCountdownTimer = setInterval(() => {
      const el = document.getElementById('dev-feed');
      const pills = el ? el.querySelectorAll(AppView._COUNTDOWN_SEL) : [];
      if (!pills.length) {
        clearInterval(AppView._mergeCountdownTimer);
        AppView._mergeCountdownTimer = null;
        return;
      }
      let anyExpired = false;
      pills.forEach((pill) => {
        const ends = parseInt(pill.getAttribute('data-window-ends'), 10);
        const remaining = ends - Date.now();
        if (remaining <= 0) {
          anyExpired = true;
          return;
        }
        const verb = pill.classList.contains('gc-reject-countdown') ? 'Rejecting' : 'Merging';
        const label = pill.querySelector('.gc-vote-count-label');
        // Lazy-consensus pills carry the live tally after the countdown
        // (data-label-suffix, e.g. " · 1/2") — keep it across ticks.
        const suffix = pill.getAttribute('data-label-suffix') || '';
        if (label) label.textContent = `${verb} in ${AppView._fmtCountdown(remaining)}${suffix}`;
      });
      if (anyExpired) AppView._loadDevFeed();
    }, 30000);
  },

  // Sub-tab-aware repaint for card-action handlers that perform an optimistic
  // local mutation. The Dev area paints cards on two surfaces from the same
  // cached data: the feed list (#dev-feed) and the opened-topic full-screen
  // card (#gc-thread-head). _rerenderFeed alone no-ops in the topic view, so
  // an in-card action looked dead there (#368-class bug). This repaints
  // whichever surface is mounted, purely from cache — no _loadDevData — so the
  // just-set optimistic state isn't clobbered by a slower/racing refetch.
  _repaintCards() {
    // Repaint whichever Dev body is mounted (list feed or kanban board) —
    // _repaintDevBody no-ops when #dev-body is absent (topic view).
    AppView._repaintDevBody();
    if (typeof App !== 'undefined' && App.currentSubTab === 'topic'
        && document.getElementById('gc-thread-head')) {
      AppView._renderTopicHead();
    }
  },

  showMoreFeed() {
    AppView._feedShown = (AppView._feedShown || 20) + 10;
    AppView._rerenderFeed();
  },

  // ── Kanban view ──────────────────────────────────────────────────────
  //
  // Pure bucketing of the cached dev data into the four lifecycle columns.
  // No DOM, no AppView state reads — everything comes in via `data` — so it
  // is unit-testable in isolation (see tests/dev-kanban-buckets.test.js).
  //
  //   data = { issues, proposals, gov, merged, mySessions, sharedSessions }
  //     issues         — visible GitHub issues (already env-twin-filtered)
  //     proposals      — promoted/merging PR sessions (carry linked_issues[])
  //     gov            — governance proposals (secret_change / rename)
  //     merged         — merged PR sessions
  //     mySessions     — the viewer's active/paused sessions on this app
  //     sharedSessions — OTHER users' shared (shared_at-set) sessions
  //
  // Returns { issues, inProgress, inReview, done }:
  //   issues     — open issues with no proposal yet (headless none/failed/
  //                absent) AND not linked to any open promoted proposal
  //   inProgress — TYPED entries {kind:'my-session'|'issue'|'shared-session',
  //                item}: the viewer's sessions pinned first (most recent
  //                activity first), then issues whose headless proposal is
  //                generating/ready (same dedup as before), then other
  //                users' shared sessions (oldest-shared first)
  //   inReview   — [{kind:'proposal'|'gov', item}] sorted by pin-rank then
  //                recency, exactly as the list feed's proposal group
  //   done       — merged proposals, most-recent-activity first
  _bucketDevItems(data) {
    const d = data || {};
    const issues = Array.isArray(d.issues) ? d.issues : [];
    const proposals = Array.isArray(d.proposals) ? d.proposals : [];
    const gov = Array.isArray(d.gov) ? d.gov : [];
    const merged = Array.isArray(d.merged) ? d.merged : [];
    const mySessions = Array.isArray(d.mySessions) ? d.mySessions : [];
    const sharedSessions = Array.isArray(d.sharedSessions) ? d.sharedSessions : [];

    const ts = (v) => {
      const t = Date.parse(v || '');
      return Number.isFinite(t) ? t : 0;
    };
    const issueT = (i) => Math.max(ts(i.updatedAt), ts(i.lastMessageAt));
    const prT = (p) => Math.max(ts(p.promoted_at || p.created_at), ts(p.last_message_at));
    const govT = (g) => Math.max(ts(g.created_at), ts(g.last_message_at));
    const mergedT = (m) => Math.max(ts(m.created_at), ts(m.last_message_at));
    // Mirror of _proposalPinRank, inlined to keep this helper self-contained
    // (merging > resolving > conflict-failed/merge-conflict > normal).
    const pinRank = (pr) => {
      if (!pr) return 3;
      if (pr.status === 'merging') return 0;
      if (pr.resolving) return 1;
      if (pr.merge_conflict_state === 'failed' || pr.merge_conflict_state === 'conflict') return 2;
      return 3;
    };

    // Issue numbers already represented by an open promoted proposal card
    // (Column 3) — kept out of the issue columns so they don't double up.
    const linked = new Set();
    for (const p of proposals) {
      const arr = Array.isArray(p.linked_issues) ? p.linked_issues : [];
      for (const n of arr) {
        const num = parseInt(n, 10);
        if (Number.isFinite(num)) linked.add(num);
      }
    }

    const col1 = [];
    const col2 = [];
    for (const i of issues) {
      if (linked.has(i.number)) continue;
      // Any live work routes the issue to the In-progress column: a
      // headless run (the historical rule), a live linked dev session,
      // or a manual claim — the shared _issueInProgress predicate.
      if (AppView._issueInProgress(i)) col2.push(i);
      else col1.push(i);
    }
    col1.sort((a, b) => issueT(b) - issueT(a));
    col2.sort((a, b) => issueT(b) - issueT(a));

    const review = [];
    for (const p of proposals) review.push({ kind: 'proposal', item: p, _r: pinRank(p), _t: prT(p) });
    for (const g of gov) review.push({ kind: 'gov', item: g, _r: 3, _t: govT(g) });
    review.sort((a, b) => (a._r - b._r) || (b._t - a._t));

    const done = merged.slice().sort((a, b) => mergedT(b) - mergedT(a));

    // In progress = pinned own sessions (most recent activity first) →
    // headless-working issues → other users' shared sessions (oldest
    // shared_at first, so newly shared rows append at the bottom).
    const sessT = (s) => Math.max(ts(s.last_activity_at), ts(s.created_at));
    const mine = mySessions.slice().sort((a, b) => sessT(b) - sessT(a));
    const shared = sharedSessions.slice()
      .sort((a, b) => ts(a.shared_at) - ts(b.shared_at));
    const inProgress = [
      ...mine.map((s) => ({ kind: 'my-session', item: s })),
      ...col2.map((i) => ({ kind: 'issue', item: i })),
      ...shared.map((s) => ({ kind: 'shared-session', item: s })),
    ];

    return {
      issues: col1,
      inProgress,
      inReview: review.map((x) => ({ kind: x.kind, item: x.item })),
      done,
    };
  },

  // ── Manual card order overlay (#613) ─────────────────────────────────
  //
  // Pure re-sort of one already-bucketed column against a stored manual
  // order. `cards` is the column array in its derived (default) order;
  // `orderRefs` is the saved [{type, ref}, …] list; `keyFn(card)` returns
  // the card's identity string (or null if it has none). Cards whose
  // identity is NOT in `orderRefs` come FIRST, in their derived order
  // (newest-first for Issues) — a drag snapshots the whole column, so an
  // unranked card is one that arrived AFTER the last drag and must surface
  // at the top, not sink below every ranked card (#617). Ranked cards
  // follow, in stored order. Stale stored refs whose card is no longer in
  // the column are simply skipped. No DOM, no AppView state —
  // unit-testable in isolation (see tests/dev-board-order.test.js).
  // Empty/absent order → array returned untouched, so the unordered board
  // stays byte-identical to today.
  _applyManualOrder(cards, orderRefs, keyFn) {
    const arr = Array.isArray(cards) ? cards : [];
    const order = Array.isArray(orderRefs) ? orderRefs : [];
    if (!order.length || arr.length < 2) return arr.slice();
    // Rank each stored identity by its position in the saved order.
    const rank = new Map();
    order.forEach((o, i) => {
      if (!o) return;
      rank.set(`${o.type}:${o.ref}`, i);
    });
    const placed = [];   // [{ card, r }] — cards with a stored position
    const rest = [];     // cards without one, in derived order
    for (const card of arr) {
      const key = keyFn(card);
      const r = (key != null) ? rank.get(key) : undefined;
      if (r === undefined) rest.push(card);
      else placed.push({ card, r });
    }
    placed.sort((a, b) => a.r - b.r);
    return [...rest, ...placed.map((p) => p.card)];
  },

  // Identity string for a bucketed card, matching the (card_type, card_ref)
  // pairs the server stores and the data-*-row attributes the drag handler
  // reads. `column` picks how to read the ref: Issues holds bare issue rows,
  // In review holds { kind, item } entries (proposal | gov).
  _cardOrderKey(column, entry) {
    if (entry == null) return null;
    if (column === 'issues') {
      return (entry.number != null) ? `issue:${entry.number}` : null;
    }
    // 'review' — { kind: 'proposal'|'gov', item }
    const it = entry.item || {};
    if (entry.kind === 'proposal') return (it.id != null) ? `proposal:${it.id}` : null;
    if (entry.kind === 'gov') return (it.id != null) ? `gov:${it.id}` : null;
    return null;
  },

  // Identity string for a PM-view card entry ({ kind, item }), matching the
  // (card_type, card_ref) pairs the /pm-order server stores and the
  // data-order-key attribute the drag handler reads. PM sections mix issues
  // (ref = issue NUMBER) and proposals (ref = chat_sessions.id); no gov cards.
  // A standalone fn (not `_cardOrderKey('issues', …)`) because both PM kinds
  // arrive as { kind, item } entries, unlike the kanban Issues column's bare
  // rows.
  _pmCardOrderKey(entry) {
    if (entry == null) return null;
    const it = entry.item || {};
    if (entry.kind === 'issue') return (it.number != null) ? `issue:${it.number}` : null;
    if (entry.kind === 'proposal') return (it.id != null) ? `proposal:${it.id}` : null;
    return null;
  },

  // ── Kanban filters (#482) ───────────────────────────────────────────
  //
  // Pure card-level filter predicate for the kanban filter bar. kind ∈
  // 'issue' | 'proposal' | 'gov' | 'merged' | 'session'. A 'session' card
  // matches on its displayed label and its linked issue numbers, and is
  // exempt from priority/category/assignee (which it cannot carry). No DOM, no AppView state
  // reads — the filters come in explicitly — so it is unit-testable in
  // isolation (see tests/dev-kanban-filters.test.js). Empty/default
  // filters match everything, keeping the unfiltered board identical to
  // the pre-filter output.
  _devCardMatches(kind, item, filters) {
    const f = filters || {};
    const it = item || {};
    const q = (f.q || '').trim().toLowerCase();
    if (q) {
      let title; let author; let num;
      if (kind === 'issue') {
        title = it.title || '';
        author = it.created_by_username || it.user || '';
        num = it.number;
      } else if (kind === 'gov') {
        // Mirror _renderGovCard's title choice for renames.
        title = (it.kind === 'rename' && it.payload && it.payload.newName)
          ? it.payload.newName : (it.title || '');
        author = it.created_by_username || '';
        num = it.github_issue_number;
      } else if (kind === 'merged' && it.row_type === 'close_issue') {
        // Applied close-issue rows in the Done column — mirror
        // _renderCompletedCloseIssueCard's title/meta sources.
        title = (it.payload && it.payload.issueTitle) || it.title || '';
        author = it.created_by_username || '';
        num = it.payload && it.payload.issueNumber;
      } else if (kind === 'session') {
        // Dev sessions: match the label the card actually shows, and their
        // linked issue numbers (so "#900002" finds the session working on
        // that issue, matching the reverse #N chips on the card).
        title = it.session_title || it.pr_title || it.branch_name || '';
        author = it.username || '';
        num = it.pr_number != null ? it.pr_number : null;
      } else {
        // proposal | merged — mirror the card renderers' title fallback.
        title = it.pr_title || `Change by ${it.username || ''}`;
        author = it.username || '';
        num = it.pr_number != null ? it.pr_number : it.id;
      }
      // A leading '#' targets the issue/PR number ("#482" and "482" both
      // match); the number check is substring-based like the text checks.
      const qNum = q.replace(/^#/, '');
      let hit = String(title).toLowerCase().includes(q)
        || String(author).toLowerCase().includes(q)
        || (qNum !== '' && num != null && String(num).includes(qNum));
      // A session has no number of its own worth searching, but it does
      // carry the issue numbers it's working on.
      if (!hit && kind === 'session' && qNum !== '' && Array.isArray(it.linked_issues)) {
        hit = it.linked_issues.some((v) => String(v).includes(qNum));
      }
      if (!hit) return false;
    }
    if (kind === 'session') {
      // "Needs my vote" genuinely excludes a session — there is nothing to
      // vote on until it becomes a proposal.
      if (f.needsVote) return false;
      // Priority / category / assignee, though, are an explicit NO-OP rather
      // than a rule a session can never satisfy: it carries no such
      // metadata, so hiding every session whenever someone picks a priority
      // would be silently wrong. _sessionFilterNoteHtml says so out loud in
      // the In-progress column instead.
      return true;
    }
    // priority / assignee filter on the community-voted top value. Cards
    // without the attribute set — and gov cards, which never carry them —
    // fail the match by design.
    if (f.priority && !(it.priority && it.priority.top === f.priority)) return false;
    // #504: category filter on the community-voted top value. Cards without a
    // category set — and gov cards, which never carry one — fail by design.
    if (f.category && !(it.category && it.category.top === f.category)) return false;
    if (f.assignee === AppView.KANBAN_ASSIGNEE_UNASSIGNED) {
      // #633: "Unassigned" matches cards whose assignee is unset. Gov cards
      // are excluded here too (mirroring the named-assignee rule): they can
      // never be assigned, so letting them all match would just flood the
      // board whenever Unassigned is picked.
      if (kind === 'gov') return false;
      if (it.assignee && it.assignee.top) return false;
    } else if (f.assignee && !(it.assignee && it.assignee.top === f.assignee)) {
      return false;
    }
    if (f.needsVote) {
      if (kind === 'proposal') {
        // Same condition as the card's pulsing "Vote" badge (isUnvoted).
        if (!(it.status === 'promoted' && !it.my_vote)) return false;
      } else if (kind === 'gov') {
        if (it.my_vote) return false;
      } else {
        return false;
      }
    }
    return true;
  },

  _kanbanFiltersActive() {
    const f = AppView._kanbanFilters || {};
    return !!((f.q && f.q.trim()) || f.priority || f.category || f.assignee || f.needsVote);
  },

  // Assignee dropdown options: the union of top-voted assignees across all
  // cached board data, sorted alphabetically. The current selection is
  // always kept in the list even if it disappears from the data on a
  // refresh, so an active filter never silently self-clears.
  _kanbanAssigneeOptions() {
    const set = new Set();
    const add = (it) => { if (it && it.assignee && it.assignee.top) set.add(it.assignee.top); };
    AppView._visibleGhIssues().forEach(add);
    (AppView._proposals || []).forEach(add);
    (AppView._merged || []).forEach(add);
    const cur = AppView._kanbanFilters && AppView._kanbanFilters.assignee;
    // The Unassigned sentinel is a fixed option, never a name in this list.
    if (cur && cur !== AppView.KANBAN_ASSIGNEE_UNASSIGNED) set.add(cur);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  },

  // #780: the category filter's options — built-ins then this app's custom
  // categories, mirroring the dropdown's order. Like the assignee select, the
  // current selection is always kept in the list even if it vanishes from the
  // vocabulary, so an active filter never silently self-clears.
  _kanbanCategoryOptionsHtml() {
    const f = AppView._kanbanFilters || {};
    const opt = (v, label) =>
      `<option value="${escapeAttr(v)}"${f.category === v ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    const seen = new Set();
    let html = '<option value="">Any category</option>';
    for (const v of AppView.ATTR_CATEGORY_VALUES) {
      seen.add(v);
      html += opt(v, AppView._categoryMeta(v).label);
    }
    for (const c of AppView._customCategories()) {
      if (seen.has(c.value)) continue;
      seen.add(c.value);
      html += opt(c.value, AppView._categoryMeta(c.value).label);
    }
    if (f.category && !seen.has(f.category)) {
      html += opt(f.category, AppView._categoryMeta(f.category).label);
    }
    return html;
  },

  _kanbanNeedsVoteChipCls(active) {
    return 'text-xs px-2.5 py-1.5 rounded-lg border transition-colors shrink-0 '
      + (active
        ? 'bg-violet-600 border-violet-600 text-white'
        : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800');
  },

  _kanbanAssigneeOptionsHtml() {
    const f = AppView._kanbanFilters || {};
    const un = AppView.KANBAN_ASSIGNEE_UNASSIGNED;
    return '<option value="">Anyone</option>'
      + `<option value="${escapeAttr(un)}"${f.assignee === un ? ' selected' : ''}>Unassigned</option>`
      + AppView._kanbanAssigneeOptions().map((name) =>
        `<option value="${escapeAttr(name)}"${f.assignee === name ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('');
  },

  // #625: the filter bar is shared between the kanban and PM views, but
  // each mode repaints a different surface. Every bar control routes its
  // change through this dispatcher instead of calling _repaintKanbanBoard
  // directly (which no-ops when #dev-kanban-board isn't mounted).
  _repaintBoardSurface() {
    if (AppView._getViewMode() === 'pm') AppView._repaintPmView();
    else AppView._repaintKanbanBoard();
  },

  // Build the filter bar into #dev-kanban-filterbar and wire its controls.
  // Called once per kanban / PM mount (and by Clear, to reset control
  // values); ordinary board repaints leave this node untouched so the
  // search input keeps its focus and text.
  _renderKanbanFilterBar() {
    const el = document.getElementById('dev-kanban-filterbar');
    if (!el) return;
    const f = AppView._kanbanFilters || {};
    const ctlCls = 'rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-xs text-zinc-900 dark:text-zinc-100';
    const priOpt = (v, label) =>
      `<option value="${v}"${f.priority === v ? ' selected' : ''}>${label}</option>`;
    el.innerHTML = `
      <div class="flex flex-wrap items-center gap-2">
        <input id="dev-kanban-search" type="search" placeholder="Filter by title, author or #number"
          value="${escapeAttr(f.q || '')}" aria-label="Filter cards"
          class="${ctlCls} flex-1 min-w-[10rem]" />
        <select id="dev-kanban-priority" class="${ctlCls}" aria-label="Filter by priority">
          <option value="">Any priority</option>
          ${priOpt('high', 'High')}${priOpt('medium', 'Medium')}${priOpt('low', 'Low')}
        </select>
        <select id="dev-kanban-category" class="${ctlCls}" aria-label="Filter by category">
          ${AppView._kanbanCategoryOptionsHtml()}
        </select>
        <select id="dev-kanban-assignee" class="${ctlCls}" aria-label="Filter by assignee">
          ${AppView._kanbanAssigneeOptionsHtml()}
        </select>
        <button id="dev-kanban-needsvote" type="button" aria-pressed="${f.needsVote ? 'true' : 'false'}"
          class="${AppView._kanbanNeedsVoteChipCls(!!f.needsVote)}"
          title="Show only proposals you haven't voted on">Needs my vote</button>
        <button id="dev-kanban-clear" type="button"
          class="text-xs text-violet-500 hover:underline shrink-0${AppView._kanbanFiltersActive() ? '' : ' hidden'}">Clear</button>
      </div>`;

    const input = el.querySelector('#dev-kanban-search');
    let debounce = null;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        AppView._kanbanFilters.q = input.value;
        AppView._repaintBoardSurface();
      }, 150);
    });
    el.querySelector('#dev-kanban-priority').addEventListener('change', (ev) => {
      AppView._kanbanFilters.priority = ev.target.value || null;
      AppView._repaintBoardSurface();
    });
    el.querySelector('#dev-kanban-category').addEventListener('change', (ev) => {
      AppView._kanbanFilters.category = ev.target.value || null;
      AppView._repaintBoardSurface();
    });
    el.querySelector('#dev-kanban-assignee').addEventListener('change', (ev) => {
      AppView._kanbanFilters.assignee = ev.target.value || null;
      AppView._repaintBoardSurface();
    });
    const chip = el.querySelector('#dev-kanban-needsvote');
    chip.addEventListener('click', () => {
      AppView._kanbanFilters.needsVote = !AppView._kanbanFilters.needsVote;
      chip.className = AppView._kanbanNeedsVoteChipCls(AppView._kanbanFilters.needsVote);
      chip.setAttribute('aria-pressed', AppView._kanbanFilters.needsVote ? 'true' : 'false');
      AppView._repaintBoardSurface();
    });
    el.querySelector('#dev-kanban-clear').addEventListener('click', () => {
      AppView._kanbanFilters = AppView._defaultKanbanFilters();
      // Rebuild the bar so every control snaps back to its default value.
      AppView._renderKanbanFilterBar();
      AppView._repaintBoardSurface();
    });
  },

  // Keep the stable filter bar in sync after each board repaint: Clear-link
  // visibility, and the assignee option list (which follows the data).
  _updateKanbanFilterBarUI() {
    const bar = document.getElementById('dev-kanban-filterbar');
    if (!bar) return;
    const clear = bar.querySelector('#dev-kanban-clear');
    if (clear) clear.classList.toggle('hidden', !AppView._kanbanFiltersActive());
    const sel = bar.querySelector('#dev-kanban-assignee');
    // Rebuilding options closes an open dropdown — skip while the select is
    // being interacted with; the next repaint catches it up.
    if (sel && document.activeElement !== sel) {
      sel.innerHTML = AppView._kanbanAssigneeOptionsHtml();
    }
    // #780: same treatment for the category select, so a category created
    // during this session (or a vocabulary that finished loading after the
    // bar was built) shows up without a reload.
    const catSel = bar.querySelector('#dev-kanban-category');
    if (catSel && document.activeElement !== catSel) {
      catSel.innerHTML = AppView._kanbanCategoryOptionsHtml();
    }
  },

  // Repaint only the board region (#dev-kanban-board) from cached data,
  // leaving the filter bar node untouched. Every filter-control event and
  // WS-driven kanban refresh routes through here.
  _repaintKanbanBoard() {
    // #613: never rebuild the board out from under an in-progress drag — a
    // mid-drag innerHTML swap (e.g. a WS board_order_update from another
    // user) would drop the pointer capture and strand the card. The commit
    // that ends the drag repaints once it lands.
    if (AppView._dragState) return;
    const board = document.getElementById('dev-kanban-board');
    if (!board) return;
    // Every filter-control change (and Clear) funnels through here, so this
    // is the single write point that keeps the persisted per-app filters in
    // sync. WS-driven repaints re-save the same values — idempotent.
    AppView._saveKanbanFilters(App.currentApp);
    board.innerHTML = AppView._renderKanbanInner();
    // The headless-state poller is keyed off the cached issue data, same
    // as the list feed — filtering a generating row off-screen doesn't
    // stop it.
    if (window.Kudos) Kudos.attach(board);
    AppView._applyExploreChatAvailability(board);
    AppView._updateKanbanFilterBarUI();
    AppView._initKanbanDrag(board);
    AppView._initKanbanTabs(board);
    AppView._reanchorCardMenu();
  },

  // ── Drag-to-reorder within a column (#613) ───────────────────────────
  //
  // Pointer-events based (not native HTML5 DnD) so it works with touch and
  // doesn't hijack the card's own click/vote/kudos handlers: a drag only
  // starts from the grip handle in the card's left gutter. On drop the new
  // order is optimistically applied to _boardOrder + repainted, then POSTed;
  // a failed save reverts to server truth. _dragState is non-null for the
  // life of one drag and blocks board repaints (see _repaintKanbanBoard).
  _dragState: null,

  _initKanbanDrag(board) {
    if (!board || board._dragBound) return;
    if (AppView.readOnly) return; // #621: no reordering for read-only viewers
    board._dragBound = true;
    board.addEventListener('pointerdown', AppView._onDragPointerDown);
  },

  _onDragPointerDown(e) {
    // Left mouse button only (touch/pen report button 0 / -1); ignore others.
    if (typeof e.button === 'number' && e.button > 0) return;
    const handle = e.target.closest && e.target.closest('.dev-drag-handle');
    if (!handle) return;
    const item = handle.closest('.dev-drag-item');
    const list = item && item.closest('.dev-drag-list');
    if (!item || !list || !item.dataset.orderKey) return;
    e.preventDefault();
    // PM view drags span multiple per-person lists (reorder within, reassign
    // across); kanban drags stay inside one column. `scope` is the container
    // the move handler hit-tests its sibling lists within.
    const pmScope = item.closest && item.closest('#dev-pm');
    if (pmScope) {
      AppView._dragState = {
        item, list, handle, pm: true,
        scope: pmScope,
        sourceList: list,
        sourceAssignee: list.dataset.pmAssignee || null,
        sourceName: list.dataset.pmName || null,
        pointerId: e.pointerId,
        moved: false,
      };
    } else {
      AppView._dragState = {
        item, list, handle,
        column: list.dataset.orderCol,
        pointerId: e.pointerId,
        moved: false,
      };
    }
    try { handle.setPointerCapture(e.pointerId); } catch {}
    item.classList.add('opacity-50');
    handle.classList.add('cursor-grabbing');
    document.addEventListener('pointermove', AppView._onDragPointerMove);
    document.addEventListener('pointerup', AppView._onDragPointerUp);
    document.addEventListener('pointercancel', AppView._onDragPointerUp);
  },

  _onDragPointerMove(e) {
    const st = AppView._dragState;
    if (!st) return;
    st.moved = true;
    // PM drags can cross into another person's list; re-target st.list to the
    // drop list under the pointer first, so the card can move between sections
    // (reassign) as well as within one (reorder). Kanban stays single-list.
    if (st.pm) {
      const target = AppView._pmListUnderPoint(st.scope, e.clientX, e.clientY);
      if (target && target !== st.list) st.list = target;
    }
    // Insert the dragged item before the first sibling whose vertical
    // midpoint is below the pointer; append when the pointer is past them
    // all. Direct children only, so nested cards never confuse the scan.
    const items = Array.from(st.list.children).filter((el) => el.classList.contains('dev-drag-item'));
    const y = e.clientY;
    let before = null;
    for (const other of items) {
      if (other === st.item) continue;
      const rect = other.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) { before = other; break; }
    }
    if (before) {
      if (st.item.nextElementSibling !== before) st.list.insertBefore(st.item, before);
    } else if (st.list.lastElementChild !== st.item) {
      st.list.appendChild(st.item);
    }
  },

  // Find the PM drop list (.dev-drag-list) under a pointer within `scope`.
  // Prefers a list whose bounding box contains the point; falls back to the
  // list with the nearest vertical edge so a drop in the gap between sections
  // still lands somewhere sensible. Returns null when there are no lists.
  _pmListUnderPoint(scope, x, y) {
    if (!scope) return null;
    const lists = Array.from(scope.querySelectorAll('.dev-drag-list'));
    if (!lists.length) return null;
    let nearest = null;
    let nearestDist = Infinity;
    for (const list of lists) {
      const r = list.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return list;
      const dist = (y < r.top) ? (r.top - y) : (y > r.bottom ? y - r.bottom : 0);
      if (dist < nearestDist) { nearestDist = dist; nearest = list; }
    }
    return nearest;
  },

  _onDragPointerUp() {
    const st = AppView._dragState;
    if (!st) return;
    document.removeEventListener('pointermove', AppView._onDragPointerMove);
    document.removeEventListener('pointerup', AppView._onDragPointerUp);
    document.removeEventListener('pointercancel', AppView._onDragPointerUp);
    try { st.handle.releasePointerCapture(st.pointerId); } catch {}
    st.item.classList.remove('opacity-50');
    st.handle.classList.remove('cursor-grabbing');
    const { list, column, moved, pm } = st;
    AppView._dragState = null;
    if (!moved) return;
    if (pm) { AppView._onPmDrop(st); return; }
    const keys = Array.from(list.children)
      .filter((el) => el.classList.contains('dev-drag-item'))
      .map((el) => el.dataset.orderKey)
      .filter(Boolean);
    AppView._commitBoardOrder(column, keys);
  },

  // Parse an identity string ('issue:123' / 'proposal:45') back into the
  // { type, ref } the server stores. Returns null on a malformed key.
  _orderKeyToRef(key) {
    const idx = String(key || '').indexOf(':');
    if (idx < 0) return null;
    const type = key.slice(0, idx);
    const ref = parseInt(key.slice(idx + 1), 10);
    if (!Number.isFinite(ref)) return null;
    return { type, ref };
  },

  // Persist a column's new order. Optimistically updates _boardOrder +
  // repaints (so the order sticks and the handles re-bind), then POSTs. On
  // failure, reverts to the pre-drag order and repaints.
  async _commitBoardOrder(column, keys) {
    if (column !== 'issues' && column !== 'review') return;
    const order = (keys || []).map(AppView._orderKeyToRef).filter(Boolean);
    const prev = AppView._boardOrder || { issues: [], review: [] };
    AppView._boardOrder = { ...prev, [column]: order };
    AppView._repaintKanbanBoard();
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug) return;
    try {
      const res = await fetch(`/api/apps/${slug}/board-order${AppView._demoQS()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column, order }),
      });
      if (!res.ok) throw new Error('save failed');
      const data = await res.json().catch(() => null);
      if (data && Array.isArray(data.issues) && Array.isArray(data.review)) {
        AppView._boardOrder = { issues: data.issues, review: data.review };
        AppView._repaintKanbanBoard();
      }
    } catch {
      AppView._boardOrder = prev;
      AppView._repaintKanbanBoard();
      PlatformUI.toast('Couldn’t save the new order — reverted.');
    }
  },

  // ── PM view drag: reorder within / reassign across / unassign ─────────
  //
  // Reuses the shared pointer machinery above (_onDragPointerDown/Move/Up).
  // A PM drag can end in three ways, decided purely from the source + drop
  // list identities by _classifyPmDrop; _onPmDrop then performs the matching
  // side effect (reassign = an assignee vote; unassign = withdraw that vote)
  // plus a per-person order write for each affected section.

  _initPmDrag(container) {
    if (!container || container._dragBound) return;
    if (AppView.readOnly) return; // no reordering for read-only viewers
    container._dragBound = true;
    container.addEventListener('pointerdown', AppView._onDragPointerDown);
  },

  // Pure classification of a completed PM drag. Given the source section key
  // and the drop list's dataset ({ pmAssignee, pmName, pmUnassigned }),
  // returns { action, ... }: 'reorder' (same person), 'reassign' (new person,
  // carries destName), or 'unassign' (dropped on the Unassigned list). No DOM,
  // no state — unit-tested directly.
  _classifyPmDrop(sourceKey, destData) {
    const d = destData || {};
    if (d.pmUnassigned === '1' || d.pmUnassigned === true) return { action: 'unassign' };
    const destKey = d.pmAssignee || null;
    if (destKey == null) return { action: 'none' };
    if (destKey === sourceKey) return { action: 'reorder' };
    return { action: 'reassign', destName: d.pmName || destKey };
  },

  // Card identity keys ('issue:123' / 'proposal:45') currently in a list's DOM.
  _pmListKeys(listEl) {
    if (!listEl) return [];
    return Array.from(listEl.children)
      .filter((el) => el.classList && el.classList.contains('dev-drag-item'))
      .map((el) => el.dataset && el.dataset.orderKey)
      .filter(Boolean);
  },

  // Orchestrate a dropped PM card: classify, apply the reassign/unassign vote
  // side effect, then persist the affected per-person orders. Optimistic —
  // any failure reconciles by re-pulling the board (refreshDevData).
  async _onPmDrop(st) {
    const destList = st.list;
    const cls = AppView._classifyPmDrop(st.sourceAssignee, destList && destList.dataset);
    const ref = AppView._orderKeyToRef(st.item.dataset.orderKey);
    // DOM already reflects the move: dest list holds the card, source doesn't.
    const destKeys = AppView._pmListKeys(destList);
    const sourceKeys = AppView._pmListKeys(st.sourceList);
    const prev = AppView._pmOrder || {};
    try {
      if (cls.action === 'reorder') {
        await AppView._commitPmOrder(st.sourceName, destKeys);
      } else if (cls.action === 'reassign') {
        if (ref) await AppView._castAssigneeForCard(ref.type, ref.ref, cls.destName);
        await AppView._commitPmOrder(cls.destName, destKeys);
        if (st.sourceName) await AppView._commitPmOrder(st.sourceName, sourceKeys);
      } else if (cls.action === 'unassign') {
        if (ref) await AppView._clearAssigneeForCard(ref.type, ref.ref);
        if (st.sourceName) await AppView._commitPmOrder(st.sourceName, sourceKeys);
        else AppView._repaintPmView();
      } else {
        AppView._repaintPmView();
      }
    } catch (err) {
      AppView._pmOrder = prev;
      // Reconcile against server truth (assignee summary + saved order) and
      // repaint from the reloaded cache.
      if (AppView.refreshDevData) AppView.refreshDevData('pm-order');
      else AppView._repaintPmView();
      PlatformUI.toast('Couldn’t save that change — reverted.');
    }
  },

  // Persist one person's new card order. Optimistically updates _pmOrder +
  // repaints (so the order sticks and grips re-bind), then POSTs. On failure,
  // throws so _onPmDrop reverts + reconciles. `assigneeName` is the display
  // name; the server case-folds it to the storage key.
  async _commitPmOrder(assigneeName, keys) {
    const key = String(assigneeName == null ? '' : assigneeName).trim().toLowerCase();
    if (!key) return;
    const order = (keys || []).map(AppView._orderKeyToRef).filter(Boolean);
    AppView._pmOrder = { ...(AppView._pmOrder || {}), [key]: order };
    AppView._repaintPmView();
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug) return;
    const res = await fetch(`/api/apps/${slug}/pm-order${AppView._demoQS()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignee: assigneeName, order }),
    });
    if (!res.ok) throw new Error('pm-order save failed');
    const data = await res.json().catch(() => null);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      AppView._pmOrder = data;
      AppView._repaintPmView();
    }
  },

  // Cast the viewer's assignee vote for a card (reassign-by-drag). Mirrors the
  // chip popover's _castAttrVote POST, then writes the refreshed summary onto
  // the cached item so the regroup places the card under the new person.
  async _castAssigneeForCard(targetType, targetRef, name) {
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug) throw new Error('no app');
    const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/topics/${targetType}/${targetRef}/attributes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: 'assignee', value: name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'reassign failed');
    AppView._applyAttrSummary(targetType, targetRef, 'assignee', data);
  },

  // Withdraw the viewer's assignee vote for a card (drag-to-Unassigned).
  async _clearAssigneeForCard(targetType, targetRef) {
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug) throw new Error('no app');
    const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/topics/${targetType}/${targetRef}/attributes?field=assignee`, {
      method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'unassign failed');
    AppView._applyAttrSummary(targetType, targetRef, 'assignee', data);
  },

  // Render the kanban board (inner HTML for #dev-kanban-board) from cached
  // data. Reuses the exact per-card renderers the list mode uses, so every
  // card keeps its buttons, badges, and data-*-row open hooks.
  _renderKanbanInner() {
    const buckets = AppView._bucketDevItems({
      issues: AppView._visibleGhIssues(),
      proposals: AppView._proposals || [],
      gov: AppView._govProposals || [],
      merged: AppView._merged || [],
      mySessions: AppView._mySessions || [],
      sharedSessions: AppView._sharedSessions || [],
    });
    const meta = AppView._ghIssuesMeta || {};

    // #613: apply the manual drag order overlay to the Issues + In review
    // columns BEFORE filtering, so hiding cards via the filter bar never
    // disturbs the saved order. Empty order → no change (identical to the
    // pre-#613 board).
    const order = AppView._boardOrder || { issues: [], review: [] };
    buckets.issues = AppView._applyManualOrder(
      buckets.issues, order.issues, (c) => AppView._cardOrderKey('issues', c));
    buckets.inReview = AppView._applyManualOrder(
      buckets.inReview, order.review, (c) => AppView._cardOrderKey('review', c));

    // #482: apply the filter bar AFTER bucketing, per column. Filtering
    // the inputs instead would resurrect issues whose open proposal was
    // filtered out (the bucketer dedups linked_issues out of the issue
    // columns), so post-bucket filtering keeps every card's lifecycle
    // placement identical to the unfiltered board.
    const f = AppView._kanbanFilters || {};
    const filtering = AppView._kanbanFiltersActive();
    const kIssues = filtering
      ? buckets.issues.filter((i) => AppView._devCardMatches('issue', i, f))
      : buckets.issues;
    // Session entries used to be EXEMPT from the filter bar entirely — type
    // a search term and they just sat there unexplained. They now go
    // through _devCardMatches with kind 'session' (title + linked-issue
    // number), which returns true unconditionally for the three filters a
    // session cannot carry; _inProgressCardsHtml says so visibly.
    const kInProgress = filtering
      ? buckets.inProgress.filter((e) => (e.kind === 'issue'
        ? AppView._devCardMatches('issue', e.item, f)
        : AppView._devCardMatches('session', e.item, f)))
      : buckets.inProgress;
    const kInReview = filtering
      ? buckets.inReview.filter((x) => AppView._devCardMatches(x.kind, x.item, f))
      : buckets.inReview;
    const kDone = filtering
      ? buckets.done.filter((m) => AppView._devCardMatches('merged', m, f))
      : buckets.done;

    // "More open issues on GitHub" link — the Issues column inherits the
    // list footer's GitHub link when the repo has more open issues than
    // the fetch ceiling, so the cap is never silent.
    let issuesFooter = '';
    if (meta.truncatedList && meta.repoUrl) {
      const issuesUrl = `${meta.repoUrl.replace(/\.git$/, '').replace(/\/$/, '')}/issues`;
      issuesFooter = `<a href="${issuesUrl}" target="_blank" rel="noopener" class="text-xs text-violet-400 hover:underline">More open issues on GitHub &rarr;</a>`;
    }

    // #433: the Done column header shows the true merged total (set in
    // _loadDevData), not the loaded-page length. When the board has loaded
    // fewer cards than the total, surface a static "+N more completed" hint
    // — mirroring the Issues column's truncation footer — so the count and
    // the visible cards stay reconciled and the page cap is never silent.
    const doneTotal = (typeof AppView._mergedTotal === 'number')
      ? AppView._mergedTotal
      : buckets.done.length;
    // When the server has more merged pages, the footer is a real "Load
    // more" button wired to the same pager the list view uses — clicking
    // it fetches the next keyset page and re-paints the board in place
    // (loadMoreMerged is view-mode aware). Falls back to the static hint
    // only in the degenerate case where the total exceeds the loaded rows
    // yet the server reports no more pages (shouldn't normally happen,
    // since total + hasMore derive from the same merged set).
    let doneFooter = '';
    if (filtering) {
      // #482: while filtered, the server total and the "+N more" hint would
      // both misstate what's visible — the header shows the matching loaded
      // count instead, and "Load more" stays reachable (uncounted) so older
      // matches can still be pulled in; the repaint re-applies the filter.
      if (AppView._mergedHasMore) {
        const loading = AppView._mergedLoadingMore;
        doneFooter = `<button class="gc-vote-btn" ${loading ? 'disabled' : ''} onclick="AppView.loadMoreMerged()">${loading ? 'Loading…' : 'Load more'}</button>`;
      }
    } else if (doneTotal > buckets.done.length) {
      const moreCount = doneTotal - buckets.done.length;
      if (AppView._mergedHasMore) {
        const loading = AppView._mergedLoadingMore;
        doneFooter = `<button class="gc-vote-btn" ${loading ? 'disabled' : ''} onclick="AppView.loadMoreMerged()">${loading ? 'Loading…' : `Load more (${moreCount})`}</button>`;
      } else {
        doneFooter = `<span class="text-xs text-zinc-400 dark:text-zinc-500 italic">+${moreCount} more completed</span>`;
      }
    }

    const cols = [
      // #613: `orderCol` marks a column as drag-reorderable and names the
      // stored column_key; `orderKey(item)` yields the card identity the
      // overlay + drag handler share. Filtering disables dragging (the saved
      // order applies to the full column, not a filtered subset).
      { key: 'issues', title: 'Issues', items: kIssues, render: (i) => AppView._renderIssueRow(i), footer: issuesFooter,
        orderCol: 'issues', orderKey: (i) => AppView._cardOrderKey('issues', i) },
      // In progress renders through a dedicated builder: pinned own
      // sessions (+ the visibility caption and the archived toggle),
      // then issue cards, then other users' shared sessions.
      { key: 'inprogress', title: 'In progress', items: kInProgress, cardsHtml: AppView._inProgressCardsHtml(kInProgress, filtering) },
      { key: 'inreview', title: 'In review', items: kInReview, render: (x) => (x.kind === 'proposal' ? AppView._renderProposalCard(x.item) : AppView._renderGovCard(x.item)),
        orderCol: 'review', orderKey: (x) => AppView._cardOrderKey('review', x) },
      { key: 'done', title: 'Done', items: kDone, render: (m) => (m.row_type === 'close_issue' ? AppView._renderCompletedCloseIssueCard(m) : AppView._renderMergedCard(m)), count: filtering ? kDone.length : doneTotal, footer: doneFooter },
    ];

    // #814: the counts are computed ONCE per column and consumed by both the
    // column header and its tab, so the two can never drift (Done's is the
    // server total unfiltered, the matching-card count while filtering).
    const counts = cols.map((col) => (typeof col.count === 'number') ? col.count : col.items.length);
    const activeTab = AppView._activeKanbanTab();

    let html = AppView._renderKanbanTabs(cols, counts, activeTab);
    html += `<div id="dev-kanban" class="flex gap-3 overflow-x-auto pb-2" data-kanban-active="${escapeAttr(activeTab)}">`;
    for (let ci = 0; ci < cols.length; ci++) {
      const col = cols[ci];
      // Cards render from the in-memory (paged) items; the header count can
      // be overridden (Done uses the server total) and falls back to the
      // loaded length for every other column.
      const count = counts[ci];
      // Reorder is offered only on a reorderable column that isn't being
      // filtered (a filtered view hides cards the saved order still covers).
      const reorder = !!col.orderCol && !filtering;
      let cards;
      if (typeof col.cardsHtml === 'string') {
        cards = col.cardsHtml;
      } else if (!col.items.length) {
        cards = `<div class="text-xs text-zinc-400 dark:text-zinc-500 italic py-2">${filtering ? 'No matching cards' : 'Nothing here yet'}</div>`;
      } else if (reorder) {
        cards = `<div class="space-y-2 dev-drag-list" data-order-col="${col.orderCol}">`
          + col.items.map((it) => AppView._wrapDraggable(col.orderKey(it), col.render(it))).join('')
          + '</div>';
      } else {
        cards = `<div class="space-y-2">${col.items.map(col.render).join('')}</div>`;
      }
      const footer = col.footer ? `<div class="mt-2">${col.footer}</div>` : '';
      // #814: every column is always in the DOM; `dev-kanban-col-active`
      // marks the one the tab strip is showing and CSS acts on it only
      // below 640px, so the desktop board is unchanged. The column's flex
      // sizing is `.dev-kanban-col` in app.css rather than Tailwind
      // utilities here — utilities would outrank the media queries.
      const activeCls = col.key === activeTab ? ' dev-kanban-col-active' : '';
      html += `
        <div id="dev-kanban-col-${escapeAttr(col.key)}" data-kanban-col="${escapeAttr(col.key)}"
          class="dev-kanban-col${activeCls}">
          <div class="dev-kanban-col-head text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider mb-2 px-0.5">
            ${escapeHtml(col.title)} <span class="text-zinc-400 dark:text-zinc-500 font-mono">· ${count}</span>
          </div>
          ${cards}
          ${footer}
        </div>`;
    }
    html += '</div>';
    return html;
  },

  // #814: the mobile tab strip — one tab per kanban column, hidden at
  // ≥640px (`sm:hidden`) where all four columns show side by side. Each
  // tab carries the column name plus the same count its header shows, on
  // two lines so all four fit a 390px phone without the strip itself
  // needing to scroll (the whole point of the change). An empty column
  // keeps its tab, dimmed and showing 0, so the strip never reflows.
  _renderKanbanTabs(cols, counts, activeTab) {
    const tabs = cols.map((col, i) => {
      const active = col.key === activeTab;
      const count = counts[i];
      const cls = 'dev-kanban-tab flex-1 basis-0 min-w-0 min-h-[44px] px-1 py-1.5 flex flex-col items-center justify-center '
        + 'border-b-2 transition-colors '
        + (active
          ? 'border-violet-500 text-violet-500 font-semibold'
          : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200');
      const countCls = 'font-mono text-[11px] leading-tight '
        + (active ? 'text-violet-400' : (count ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-300 dark:text-zinc-600'));
      return `<button type="button" role="tab" id="dev-kanban-tab-${escapeAttr(col.key)}"
          data-kanban-tab="${escapeAttr(col.key)}" aria-selected="${active ? 'true' : 'false'}"
          aria-controls="dev-kanban-col-${escapeAttr(col.key)}" class="${cls}">
          <span class="text-xs leading-tight truncate max-w-full">${escapeHtml(col.title)}</span>
          <span class="${countCls}">${count}</span>
        </button>`;
    }).join('');
    return `<div id="dev-kanban-tabs" role="tablist" aria-label="Board columns"
      class="sm:hidden flex items-stretch gap-1 mb-2 border-b border-zinc-200 dark:border-zinc-800">${tabs}</div>`;
  },

  // #814: one delegated click listener on the STABLE #dev-kanban-board node
  // (same `_dragBound` guard style as _initKanbanDrag) so it survives every
  // innerHTML rewrite. Switching tabs deliberately does NOT repaint the
  // board: all four columns are already rendered, so moving the active
  // marker is enough — no scroll jump, no re-binding, and no interaction
  // with the mid-drag repaint guard.
  _initKanbanTabs(board) {
    if (!board || board._tabsBound) return;
    board._tabsBound = true;
    board.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('[data-kanban-tab]');
      if (!btn || !board.contains(btn)) return;
      const key = btn.dataset.kanbanTab;
      if (!AppView.KANBAN_TABS.includes(key)) return;
      // An explicit tap retires the ?col= override, mirroring _setViewMode.
      AppView._kanbanTabUrlOverride = null;
      if (key === AppView._activeKanbanTab()) return;
      AppView._kanbanTab = key;
      AppView._saveKanbanTab(App.currentApp);
      AppView._applyKanbanTab(board);
    });
  },

  // Move the active-column marker + tab styling to AppView._kanbanTab
  // in place. Keeps the classes in sync with what _renderKanbanTabs would
  // have produced, so a later repaint is a no-op visually.
  _applyKanbanTab(board) {
    const scope = board || document.getElementById('dev-kanban-board');
    if (!scope) return;
    const active = AppView._activeKanbanTab();
    const kanban = scope.querySelector('#dev-kanban');
    if (kanban) kanban.setAttribute('data-kanban-active', active);
    scope.querySelectorAll('[data-kanban-col]').forEach((col) => {
      col.classList.toggle('dev-kanban-col-active', col.dataset.kanbanCol === active);
    });
    scope.querySelectorAll('[data-kanban-tab]').forEach((btn) => {
      const on = btn.dataset.kanbanTab === active;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.classList.toggle('border-violet-500', on);
      btn.classList.toggle('text-violet-500', on);
      btn.classList.toggle('font-semibold', on);
      btn.classList.toggle('border-transparent', !on);
      btn.classList.toggle('text-zinc-500', !on);
      btn.classList.toggle('dark:text-zinc-400', !on);
    });
  },

  // #613: wrap one rendered card in a drag shell — a grip handle in a left
  // gutter (44px tall for touch) plus the card. `key` is the card identity
  // ('issue:123' / 'proposal:45'); a card with no identity (shouldn't happen
  // for the reorderable columns) renders un-draggable so it can't be moved
  // into an unsaveable state.
  _wrapDraggable(key, cardHtml) {
    // #621: read-only viewers can't reorder the board — no grip handle
    // (and _initKanbanDrag never binds for them).
    if (!key || AppView.readOnly) return `<div class="dev-drag-item">${cardHtml}</div>`;
    const grip = '<svg viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4" aria-hidden="true">'
      + '<circle cx="7" cy="5" r="1.4"/><circle cx="13" cy="5" r="1.4"/>'
      + '<circle cx="7" cy="10" r="1.4"/><circle cx="13" cy="10" r="1.4"/>'
      + '<circle cx="7" cy="15" r="1.4"/><circle cx="13" cy="15" r="1.4"/></svg>';
    return `<div class="dev-drag-item relative pl-6" data-order-key="${escapeAttr(key)}">
        <button type="button" class="dev-drag-handle absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center text-zinc-300 dark:text-zinc-600 hover:text-zinc-500 dark:hover:text-zinc-400 cursor-grab touch-none"
          aria-label="Drag to reorder" title="Drag to reorder">${grip}</button>
        ${cardHtml}
      </div>`;
  },

  // ── PM view (tasks by assignee) ──────────────────────────────────────
  //
  // Pure grouping of the cached dev data into a project-manager's
  // assignment overview. No DOM, no AppView state reads — everything comes
  // in via `data` — so it is unit-testable in isolation (see
  // tests/dev-pm-groups.test.js), mirroring _bucketDevItems.
  //
  //   data = { issues, proposals }
  //     issues    — visible GitHub issues (env-twin-filtered; both the
  //                 Issues and In-progress kanban buckets — i.e. every
  //                 open issue), each carrying an { assignee: { top } }
  //     proposals — open promoted/merging PR proposals
  //   (merged + governance are deliberately NOT passed: completed work
  //    isn't an open assignment, and gov cards never carry an assignee.)
  //
  // Returns { groups, unassigned, unassignedTotal }:
  //   groups          — [{ name, count, items: [{kind, item}] }] for every
  //                     person with ≥1 assigned task, ordered by count desc
  //                     then name asc; items within a group newest-first
  //   unassigned      — [{kind, item}] with no assignee, newest-first,
  //                     capped to PM_UNASSIGNED_MAX (override with
  //                     opts.cap — #633 passes Infinity while the
  //                     Unassigned filter is active)
  //   unassignedTotal — the pre-cap count, for the "+N more" note
  //
  //   opts.pmOrder — optional per-person manual order overlay, shape
  //                  { "<assignee_key>": [{type,ref}], … } (AppView._pmOrder).
  //                  When present, each group's items are re-sorted by
  //                  _applyManualOrder AFTER the recency sort: cards absent
  //                  from a person's saved order lead (newest-first), ranked
  //                  cards follow in stored order (#617). The Unassigned
  //                  bucket is NEVER reordered. Passed in explicitly (not read
  //                  off AppView) so this helper stays pure + unit-testable.
  PM_UNASSIGNED_MAX: 10,
  _groupByAssignee(data, opts) {
    const d = data || {};
    const issues = Array.isArray(d.issues) ? d.issues : [];
    const proposals = Array.isArray(d.proposals) ? d.proposals : [];
    const pmOrder = (opts && opts.pmOrder && typeof opts.pmOrder === 'object') ? opts.pmOrder : null;

    const ts = (v) => {
      const t = Date.parse(v || '');
      return Number.isFinite(t) ? t : 0;
    };
    // Recency key per kind — mirrors _bucketDevItems' issueT / prT so the
    // ordering matches the rest of the dev view.
    const recency = (kind, it) => (kind === 'issue'
      ? Math.max(ts(it.updatedAt), ts(it.lastMessageAt))
      : Math.max(ts(it.promoted_at || it.created_at), ts(it.last_message_at)));

    const assigneeTop = (it) => (it && it.assignee && it.assignee.top) || null;

    // Flatten both kinds into one list carrying kind, item and its sort key.
    const cards = [];
    for (const i of issues) cards.push({ kind: 'issue', item: i, _t: recency('issue', i) });
    for (const p of proposals) cards.push({ kind: 'proposal', item: p, _t: recency('proposal', p) });

    // Bucket by case-folded assignee; first-seen casing is the display name.
    const byKey = new Map(); // lower(top) -> { name, entries: [{kind,item,_t}] }
    const unassigned = [];
    for (const c of cards) {
      const top = assigneeTop(c.item);
      if (top == null || String(top).trim() === '') { unassigned.push(c); continue; }
      const key = String(top).toLowerCase();
      if (!byKey.has(key)) byKey.set(key, { name: String(top), entries: [] });
      byKey.get(key).entries.push(c);
    }

    const groups = Array.from(byKey.values()).map((g) => {
      const entries = g.entries.slice().sort((a, b) => b._t - a._t);
      let items = entries.map((e) => ({ kind: e.kind, item: e.item }));
      // Apply this person's manual order overlay on top of the recency sort.
      if (pmOrder) {
        const savedOrder = pmOrder[g.name.toLowerCase()];
        if (Array.isArray(savedOrder) && savedOrder.length) {
          items = AppView._applyManualOrder(items, savedOrder, AppView._pmCardOrderKey);
        }
      }
      return { name: g.name, count: items.length, items };
    });
    groups.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));

    const unassignedSorted = unassigned.slice().sort((a, b) => b._t - a._t);
    const cap = (opts && opts.cap != null) ? opts.cap : AppView.PM_UNASSIGNED_MAX;
    return {
      groups,
      unassigned: unassignedSorted.slice(0, cap).map((e) => ({ kind: e.kind, item: e.item })),
      unassignedTotal: unassignedSorted.length,
    };
  },

  // Render the PM view (inner HTML for #dev-pm) from cached data. Reuses the
  // exact per-kind card renderers the list/kanban modes use, so every card
  // keeps its buttons, badges, and data-*-row open hooks.
  _renderPmInner() {
    // #625: apply the shared filter bar BEFORE grouping — unlike kanban's
    // post-bucket rule, PM grouping has no cross-item dedup, so a
    // filtered-out card simply vanishes and each person's header count
    // reflects exactly the cards rendered under it. _groupByAssignee stays
    // pure and filter-unaware.
    const f = AppView._kanbanFilters || {};
    const filtering = AppView._kanbanFiltersActive();
    let issues = AppView._visibleGhIssues();
    let proposals = AppView._proposals || [];
    if (filtering) {
      issues = issues.filter((i) => AppView._devCardMatches('issue', i, f));
      proposals = proposals.filter((p) => AppView._devCardMatches('proposal', p, f));
    }
    // #633: with the Unassigned filter active the section IS the view —
    // lift the cap so the full unassigned backlog renders, no "+N more".
    const unassignedOnly = f.assignee === AppView.KANBAN_ASSIGNEE_UNASSIGNED;
    const { groups, unassigned, unassignedTotal } = AppView._groupByAssignee(
      { issues, proposals },
      { cap: unassignedOnly ? Infinity : undefined, pmOrder: AppView._pmOrder }
    );
    // Reorder/reassign by drag is offered unless the filter bar is active (a
    // saved order applies to the full section, not a filtered subset —
    // mirroring the kanban rule at _renderKanbanInner). Read-only viewers get
    // no grips either: _wrapDraggable omits them and _initPmDrag never binds.
    const reorder = !filtering && !AppView.readOnly;

    // With a named-user filter active, the Unassigned section can never
    // match — hide it rather than rendering a permanently-empty stub.
    const showUnassigned = !f.assignee || unassignedOnly;
    if (filtering && !groups.length && (!showUnassigned || unassignedTotal === 0)) {
      return '<div class="space-y-5"><div class="text-xs text-zinc-400 dark:text-zinc-500 italic py-2">No cards match the current filters.</div></div>';
    }

    const renderCard = (c) => (c.kind === 'proposal'
      ? AppView._renderProposalCard(c.item)
      : AppView._renderIssueRow(c.item));
    const sectionHead = (inner) => `<div class="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider mb-2 px-0.5 flex items-center gap-1.5">${inner}</div>`;

    let html = '<div class="space-y-5">';

    // Tasks-by-assignee area.
    if (groups.length) {
      for (const g of groups) {
        const head = sectionHead(
          `${AppView._assigneeAvatarHtml(g.name)}<span class="normal-case text-zinc-700 dark:text-zinc-200">@${escapeHtml(g.name)}</span>`
          + `<span class="text-zinc-400 dark:text-zinc-500 font-mono">· ${g.count}</span>`
        );
        let body;
        if (reorder) {
          // Each person's section is a drop-target list keyed by their
          // case-folded assignee (data-pm-assignee) + display name
          // (data-pm-name, used to cast the assignee vote on a cross-section
          // drop). Cards carry a grip + data-order-key via _wrapDraggable.
          const key = g.name.toLowerCase();
          body = `<div class="space-y-2 dev-drag-list" data-pm-assignee="${escapeAttr(key)}" data-pm-name="${escapeAttr(g.name)}">`
            + g.items.map((c) => AppView._wrapDraggable(AppView._pmCardOrderKey(c), renderCard(c))).join('')
            + '</div>';
        } else {
          body = `<div class="space-y-2">${g.items.map(renderCard).join('')}</div>`;
        }
        html += `<div>${head}${body}</div>`;
      }
    } else if (!filtering) {
      // While filtering, an empty assigned area with matches below needs no
      // placeholder — the Unassigned section speaks for itself.
      html += '<div class="text-xs text-zinc-400 dark:text-zinc-500 italic py-2">No tasks are assigned to anyone yet.</div>';
    }

    // Unassigned section — shown unless a user filter is active; lists the
    // most recent open work with no assignee, capped, with a "+N more" note
    // when truncated. The cap and count apply AFTER filtering.
    if (showUnassigned) {
      const unHead = sectionHead(
        `${AppView._assigneeAvatarPlaceholderHtml()}<span class="normal-case">Unassigned</span>`
        + `<span class="text-zinc-400 dark:text-zinc-500 font-mono">· ${unassignedTotal}</span>`
      );
      let unBody;
      if (unassigned.length) {
        if (reorder) {
          // The Unassigned section is a DROP TARGET (drop a card here to
          // withdraw your assignee vote) but its own cards carry no grip —
          // _wrapDraggable(null, …) yields a .dev-drag-item with no handle /
          // order-key, so its internal order stays recency-only (not
          // user-sortable), per the spec.
          unBody = '<div class="space-y-2 dev-drag-list" data-pm-unassigned="1">'
            + unassigned.map((c) => AppView._wrapDraggable(null, renderCard(c))).join('')
            + '</div>';
        } else {
          unBody = `<div class="space-y-2">${unassigned.map(renderCard).join('')}</div>`;
        }
        if (unassignedTotal > unassigned.length) {
          // #633: clicking the note switches the assignee filter to
          // Unassigned, revealing the full uncapped list (wired in
          // _repaintPmView after the paint).
          const moreCount = unassignedTotal - unassigned.length;
          unBody += `<div class="mt-2"><button type="button" id="dev-pm-more-unassigned"
            class="text-xs text-zinc-400 dark:text-zinc-500 italic hover:text-violet-500 hover:underline"
            title="Show all unassigned cards">+${moreCount} more unassigned</button></div>`;
        }
      } else {
        unBody = '<div class="text-xs text-zinc-400 dark:text-zinc-500 italic py-2">Nothing unassigned.</div>';
      }
      html += `<div>${unHead}${unBody}</div>`;
    }

    html += '</div>';
    return html;
  },

  // Repaint the PM container (#dev-pm) from cached data. Mirrors
  // _repaintKanbanBoard: fill innerHTML, then re-attach kudos / ask-AI
  // availability and keep the headless-state poller in sync.
  _repaintPmView() {
    // Never rebuild the PM view out from under an in-progress drag — a
    // mid-drag innerHTML swap (e.g. a WS board_order_update from another user)
    // would drop the pointer capture and strand the card. The commit that
    // ends the drag repaints once it lands. Mirrors _repaintKanbanBoard.
    if (AppView._dragState) return;
    const el = document.getElementById('dev-pm');
    if (!el) return;
    // #625: every PM-mode filter-control change funnels through here (via
    // _repaintBoardSurface), so — mirroring _repaintKanbanBoard — persist
    // the shared per-app filters and keep the bar's Clear link / assignee
    // options in sync after the paint.
    AppView._saveKanbanFilters(App.currentApp);
    el.innerHTML = AppView._renderPmInner();
    // #633: "+N more unassigned" jumps to the Unassigned filter; rebuild the
    // bar so the assignee select snaps to the new value, then repaint.
    const more = el.querySelector('#dev-pm-more-unassigned');
    if (more && more.addEventListener) {
      more.addEventListener('click', () => {
        AppView._kanbanFilters.assignee = AppView.KANBAN_ASSIGNEE_UNASSIGNED;
        AppView._renderKanbanFilterBar();
        AppView._repaintBoardSurface();
      });
    }
    if (window.Kudos) Kudos.attach(el);
    AppView._applyExploreChatAvailability(el);
    AppView._updateKanbanFilterBarUI();
    AppView._initPmDrag(el);
    AppView._reanchorCardMenu();
  },

  // ── Session cards in the In progress area ──────────────────────────
  // The viewer's PRIVATE in-progress (active/paused, not-yet-promoted)
  // sessions render pinned at the top of the In progress column (kanban)
  // / top of the list (list view) under the "Only you can see" caption;
  // their VISIBLE (shared) sessions render below the archived toggle
  // under the "Visible to everyone." caption, signaling they appear on
  // everyone's board; other users' shared sessions render at the bottom
  // of the same area. Promoted sessions are absent — they render as
  // proposal cards. All card controls are wired via the delegated
  // #dev-body handler in renderDevView, so repaints stay cheap.

  _sessionCardLabel(s) {
    return escapeHtml(s.session_title || s.pr_title || s.branch_name || `Session #${s.id}`);
  },

  // #1038: busy is read live from window.SessionState, falling back to the
  // `busy` flag on the fetched row for a session it has never heard about.
  // A pushed transition repaints these tags with no refetch.
  _sessionBusy(s) {
    if (!s) return false;
    if (typeof window !== 'undefined' && window.SessionState) {
      return SessionState.isBusy(s.id, s.busy);
    }
    return !!s.busy;
  },

  _sessionStatusTagHtml(s) {
    return AppView._sessionBusy(s)
      ? '<span class="dev-badge bg-emerald-500/10 text-emerald-500"><span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>working…</span>'
      : (s.status === 'paused' ? '<span class="dev-badge bg-zinc-500/10 text-zinc-500">paused</span>' : '');
  },

  // One of the viewer's own session cards. A clickable <div> (not
  // <button>) so the inner Archive / visibility buttons are valid HTML.
  // Two rows: title row (icon + wrapping title + chevron) and an actions
  // row (status tag + buttons) that flex-wraps — the title can never be
  // crushed by fixed-width controls. Clicking the card opens the owner's
  // dev chat; the "Open chat" button (visible sessions only) opens the
  // public discussion instead.
  _renderMySessionCard(s) {
    const label = AppView._sessionCardLabel(s);
    const statusTag = AppView._sessionStatusTagHtml(s);
    const shared = !!s.shared_at;
    const transcriptShared = !!s.transcript_shared_at;
    // Count comes from the shared-sessions row; a freshly-shared session
    // may not be in _sharedById yet (background refresh pending) — the
    // badge still renders, with the count at 0.
    const sh = shared ? (AppView._sharedById || {})[s.id] : null;
    // #689: a PR exists once the first commit is pushed, so pr_number set
    // means there is something to preview. The owner is always authorized
    // on ensure-staging, which rebuilds the preview if the idle GC
    // reclaimed it.
    const preview = AppView.cardPreviewHtml(s, { kind: 'own-session', sessionId: s.id });
    const subtitle = shared
      ? (transcriptShared ? 'Visible to everyone · chat readable' : 'Visible to everyone')
      : 'Only you can see this';

    // "Open chat" is GONE as a pill. Tapping this card opens the owner's dev
    // chat — its working surface, and its canonical destination; the public
    // discussion of a shared session is one ⋯ row rather than a competing
    // affordance on the card face.
    const menu = [
      shared
        ? {
          label: 'Hide',
          icon: 'hide',
          title: "Make this session private again (removes it from everyone's In progress area, and stops anyone reading the chat)",
          act: () => AppView._setSessionShared(s.id, false, null),
        }
        : {
          label: 'Make visible',
          icon: 'visible',
          title: "Show this session in everyone's In progress area — others can comment and open its live preview, but can't read your chat unless you also share it",
          act: () => AppView._setSessionShared(s.id, true, null),
        },
    ];
    // The SECOND opt-in, offered only once the session is visible (there is
    // nowhere for a reader to reach an invisible session's chat from).
    if (shared) {
      menu.push(transcriptShared
        ? {
          label: 'Chat shared — stop sharing',
          icon: 'chat',
          title: 'Stop others reading this chat (they keep the card and the discussion)',
          act: () => AppView._setTranscriptShared(s.id, false, null),
        }
        : {
          label: 'Share chat',
          icon: 'chat',
          title: "Let everyone read this chat, read-only — they can't reply in it, and can't see your costs or uploaded files",
          act: () => AppView._setTranscriptShared(s.id, true, null),
        });
      const chatN = sh ? (parseInt(sh.chat_count, 10) || 0) : 0;
      menu.push({
        label: `Open public discussion${chatN ? ` (${chatN})` : ''}`,
        icon: 'chat',
        title: 'Open the public discussion on this session',
        act: () => AppView.openTopic('session', s.id),
      });
    }
    menu.push({
      label: 'Archive',
      icon: 'archive',
      title: 'Archive this session (closes the PR, frees the slot)',
      danger: true,
      act: () => {
        (async () => {
          const ok = await AppView._archiveSession(s.id, label);
          if (ok) await AppView._loadDevFeed();
        })();
      },
    });
    const actions = AppView._cardActionsHtml({ preview });

    // A private session gets the muted/draft shell — that IS the signal
    // nobody else can see it, replacing the caption that used to sit above
    // the group. Single-row shell like every other card on the board.
    const mutedCls = shared ? '' : ` ${AppView.DEV_CARD_MUTED_CLS}`;
    return `<div data-session-chip="${s.id}" role="button" tabindex="0"
      class="${AppView.DEV_CARD_CLS} ${AppView.DEV_CARD_HOVER_CLS}${mutedCls}"
      title="${s.busy ? 'AI is working — ' : ''}${label}">
      ${AppView._devCardIcon('session')}
      ${AppView._cardContentHtml({
        headlineHtml: AppView._cardHeadlineHtml(label, subtitle),
        badges: [statusTag, AppView.issueChipsHtml(s.linked_issues)],
        chatCount: null,
        actions,
      })}
      ${AppView._cardRailHtml(`session:${s.id}`, menu)}
    </div>`;
  },

  // Another user's shared session. Opens the public discussion topic —
  // never the owner's dev chat (those endpoints stay owner-scoped
  // server-side). `opts.noNav` renders the static header variant for the
  // topic sub-view.
  //
  // "Read chat" is GONE as a pill: the shared transcript lives on this
  // session's own detail page (and auto-expands there), which is the one
  // canonical destination a tap on this card already goes to.
  _renderSharedSessionCard(s, opts) {
    const noNav = !!(opts && opts.noNav);
    const label = AppView._sessionCardLabel(s);
    const owner = escapeHtml(s.username || 'someone');
    const statusTag = AppView._sessionStatusTagHtml(s);
    const preview = AppView.cardPreviewHtml(s, { kind: 'shared-session', sessionId: s.id });
    const nav = noNav ? '' : ` data-shared-session-row="${s.id}" role="button" tabindex="0"`;
    const chevron = noNav ? '' : AppView.DEV_CARD_CHEVRON;
    const actions = noNav ? '' : AppView._cardActionsHtml({ preview });
    return `<div${nav} class="${AppView.DEV_CARD_CLS}${noNav ? '' : ` ${AppView.DEV_CARD_HOVER_CLS}`}" title="${label}">
      ${AppView._devCardIcon('session')}
      ${AppView._cardContentHtml({
        headlineHtml: AppView._cardHeadlineHtml(label, `${owner} is working on this`),
        badges: [statusTag, AppView.issueChipsHtml(s.linked_issues)],
        chatCount: s.chat_count,
        actions,
      })}
      ${chevron}
    </div>`;
  },

  // ── In-progress section dividers ─────────────────────────────────────
  // These replaced two full grey sentences. The long copy is now the
  // divider label's tooltip, and the private group's own cards carry the
  // muted shell, so the information survives at a fraction of the height.
  PRIVATE_DIVIDER_TITLE: 'Only you can see your active sessions.',
  VISIBLE_DIVIDER_TITLE: 'Visible to everyone — including a live preview of your changes.',
  OTHERS_DIVIDER_TITLE: 'Dev sessions other people have made visible.',

  _sessionsCaptionHtml() {
    return AppView._columnDividerHtml('Yours · private', AppView.PRIVATE_DIVIDER_TITLE);
  },

  _visibleSessionsCaptionHtml() {
    return AppView._columnDividerHtml('Yours · visible', AppView.VISIBLE_DIVIDER_TITLE);
  },

  _othersSessionsCaptionHtml() {
    return AppView._columnDividerHtml('Others', AppView.OTHERS_DIVIDER_TITLE);
  },

  // The visible note that replaces the filter bar's silent skip of session
  // cards. Text search and #number DO filter sessions now; priority,
  // category and assignee genuinely cannot apply to a dev session (it
  // carries no such metadata), so rather than quietly ignoring those the
  // column says so. Returns '' when no such filter is active or there are
  // no sessions to explain.
  _sessionFilterNoteHtml(sessionCount) {
    if (!sessionCount) return '';
    const f = AppView._kanbanFilters || {};
    const which = [];
    if (f.priority) which.push('priority');
    if (f.category) which.push('category');
    if (f.assignee) which.push('assignee');
    if (!which.length) return '';
    const list = which.length === 1
      ? which[0]
      : `${which.slice(0, -1).join(', ')} or ${which[which.length - 1]}`;
    return `<div class="text-xs text-zinc-400 dark:text-zinc-500 italic px-0.5">`
      + `Dev sessions don't carry priority, category or assignee — the ${sessionCount} `
      + `session card${sessionCount === 1 ? '' : 's'} below ${sessionCount === 1 ? 'is' : 'are'} not filtered by ${escapeHtml(list)}.</div>`;
  },

  // Archived toggle — collapsed by default on every render (no
  // persistence). Hidden entirely when the viewer has no archived
  // sessions for this app. Toggle + Unarchive are delegated. Keeps its
  // slot between the private and visible session groups.
  _archivedToggleHtml() {
    const archived = AppView._archivedSessions || [];
    if (!archived.length) return '';
    return `
      <div class="pt-1" data-archived-block>
        <button type="button" data-archived-toggle aria-expanded="false"
          class="text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 inline-flex items-center gap-1">
          <svg data-archived-caret class="w-3 h-3 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          Show archived (${archived.length})
        </button>
        <div data-archived-list class="hidden space-y-2 pt-2">
          ${archived.map((s) => {
            const label = AppView._sessionCardLabel(s);
            return `<div class="${AppView.DEV_CARD_CLS} ${AppView.DEV_CARD_MUTED_CLS}">
              ${AppView._devCardIcon('session')}
              <span class="flex-1 min-w-0">
                <span class="block text-sm font-medium text-zinc-500 dark:text-zinc-400 break-words">${label}</span>
                <span class="block text-xs text-zinc-400 dark:text-zinc-500 truncate">Archived</span>
              </span>
              <button type="button" class="gc-vote-btn" data-unarchive-chip="${s.id}" title="Restore this session (reopens its PR)">Unarchive</button>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  },

  _toggleArchivedList(toggle) {
    const block = toggle.closest('[data-archived-block]');
    const listEl = block && block.querySelector('[data-archived-list]');
    if (!listEl) return;
    const caret = block.querySelector('[data-archived-caret]');
    const open = listEl.classList.toggle('hidden') === false;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (caret) caret.style.transform = open ? 'rotate(90deg)' : '';
  },

  // The pinned own-sessions block for LIST view, above the feed and
  // outside its pager: the private divider + private session cards, the
  // archived toggle, then the visible divider + the viewer's shared
  // session cards. '' when the viewer has nothing to show.
  _mySessionsBlockHtml() {
    const mine = AppView._mySessions || [];
    const priv = mine.filter((s) => !s.shared_at);
    const vis = mine.filter((s) => !!s.shared_at);
    const archivedHtml = AppView._archivedToggleHtml();
    if (!mine.length && !archivedHtml) return '';
    let html = '<div class="space-y-2 mb-2">';
    if (priv.length) {
      html += AppView._sessionsCaptionHtml();
      html += priv.map((s) => AppView._renderMySessionCard(s)).join('');
    }
    html += archivedHtml;
    if (vis.length) {
      html += AppView._visibleSessionsCaptionHtml();
      html += vis.map((s) => AppView._renderMySessionCard(s)).join('');
    }
    html += '</div>';
    return html;
  },

  // The In progress KANBAN column's cards: the filter no-op note, then
  // pinned PRIVATE own sessions, the archived toggle, the viewer's VISIBLE
  // own sessions, issue cards, and other users' shared sessions — the
  // ordering is unchanged; only the two grey captions became dividers.
  // `entries` are the typed {kind, item} entries from _bucketDevItems.
  _inProgressCardsHtml(entries, filtering) {
    const list = entries || [];
    const mine = list.filter((e) => e.kind === 'my-session');
    const priv = mine.filter((e) => !e.item.shared_at);
    const vis = mine.filter((e) => !!e.item.shared_at);
    const issues = list.filter((e) => e.kind === 'issue');
    const shared = list.filter((e) => e.kind === 'shared-session');
    const archivedHtml = AppView._archivedToggleHtml();
    if (!list.length && !archivedHtml) {
      return `<div class="text-xs text-zinc-400 dark:text-zinc-500 italic py-2">${filtering ? 'No matching cards' : 'Nothing here yet'}</div>`;
    }
    let html = '<div class="space-y-2">';
    // The visible "these filters don't apply here" note sits above every
    // group, so it can't be mistaken for a note about just one of them.
    html += AppView._sessionFilterNoteHtml(priv.length + vis.length + shared.length);
    if (priv.length) {
      html += AppView._sessionsCaptionHtml();
      html += priv.map((e) => AppView._renderMySessionCard(e.item)).join('');
    }
    html += archivedHtml;
    if (vis.length) {
      html += AppView._visibleSessionsCaptionHtml();
      html += vis.map((e) => AppView._renderMySessionCard(e.item)).join('');
    }
    html += issues.map((e) => AppView._renderIssueRow(e.item)).join('');
    if (shared.length) {
      html += AppView._othersSessionsCaptionHtml();
      html += shared.map((e) => AppView._renderSharedSessionCard(e.item)).join('');
    }
    html += '</div>';
    return html;
  },

  // Share / unshare one of the viewer's own sessions ("Make visible" /
  // "Hide"). Optimistic: flips the cached row and repaints, then pulls
  // server truth (💬 count and canonical shared_at) in the background.
  async _setSessionShared(sessionId, shared, btn) {
    if (!sessionId) return;
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/${shared ? 'share' : 'unshare'}`, { method: 'POST' });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        PlatformUI.toast(body.error || `Failed (HTTP ${resp.status}).`);
        if (btn) { btn.disabled = false; btn.textContent = original; }
        return;
      }
      const s = (AppView._mySessions || []).find((x) => x.id === sessionId);
      if (s) s.shared_at = shared ? (body.shared_at || new Date().toISOString()) : null;
      if (shared) {
        // Seed the shared map so the freshly-shared card's 💬 badge has a
        // target before the background refresh lands.
        AppView._sharedById = { ...(AppView._sharedById || {}) };
        if (!AppView._sharedById[sessionId]) {
          AppView._sharedById[sessionId] = { id: sessionId, chat_count: 0 };
        }
      }
      AppView._repaintDevBody();
      if (AppView.appData) {
        AppView._refreshSessionCaches(AppView.appData.slug).then((changed) => {
          if (changed) AppView._repaintDevBody();
        });
      }
    } catch (err) {
      PlatformUI.toast(`Failed: ${err.message}`);
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  },

  // Confirmation copy for turning transcript sharing ON. Spelled out
  // rather than a generic "are you sure?": the whole point is that the
  // owner knows what becomes readable (their own typed messages included)
  // and what doesn't, before they publish it.
  SHARE_CHAT_CONFIRM: {
    title: 'Let everyone read this chat?',
    message: 'Anyone who can see this app will be able to read the whole conversation — '
      + "your messages, the AI's replies, and what the coding agent did. They can't reply "
      + "in your chat, and they can't see your costs or your uploaded files. You can turn "
      + 'this off at any time.',
    confirmLabel: 'Share chat',
  },

  // Publish / revoke the transcript of one of the viewer's own sessions
  // ("Share chat" / "Chat shared"). Same optimistic shape as
  // _setSessionShared: flip the cached row, repaint, then reconcile with
  // server truth in the background.
  //
  // Turning it ON is gated behind ConfirmModal (webview-safe — native
  // confirm() is suppressed in several shells the platform runs in).
  // Turning it OFF is immediate: revoking access should never be the
  // slower path.
  async _setTranscriptShared(sessionId, on, btn) {
    if (!sessionId) return;
    if (on) {
      const ok = await ConfirmModal.show(AppView.SHARE_CHAT_CONFIRM);
      if (!ok) return;
    }
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
      const resp = await fetch(
        `/api/sessions/${sessionId}/${on ? 'share-transcript' : 'unshare-transcript'}`,
        { method: 'POST' }
      );
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        PlatformUI.toast(body.error || `Failed (HTTP ${resp.status}).`);
        if (btn) { btn.disabled = false; btn.textContent = original; }
        return;
      }
      const s = (AppView._mySessions || []).find((x) => x.id === sessionId);
      if (s) {
        s.transcript_shared_at = on
          ? (body.transcript_shared_at || new Date().toISOString())
          : null;
        // share-transcript implies visibility server-side — mirror that
        // locally so the card jumps to the "Visible to everyone" group in
        // the same repaint rather than after the background refresh.
        if (on && !s.shared_at) s.shared_at = body.shared_at || new Date().toISOString();
      }
      // Drop any cached transcript for this session: what a reader may see
      // just changed, and a stale cache would keep serving the old answer
      // to the owner's own preview.
      if (AppView._transcripts) delete AppView._transcripts[sessionId];
      AppView._repaintDevBody();
      if (AppView.appData) {
        AppView._refreshSessionCaches(AppView.appData.slug).then((changed) => {
          if (changed) AppView._repaintDevBody();
        });
      }
    } catch (err) {
      PlatformUI.toast(`Failed: ${err.message}`);
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  },

  // Restore an archived session (delegated from the archived toggle's
  // Unarchive buttons).
  async _unarchiveSession(sessionId, btn) {
    if (!sessionId) return;
    const original = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/unarchive`, { method: 'POST' });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        PlatformUI.toast(body.error || 'Failed to unarchive session');
        btn.textContent = original;
        btn.disabled = false;
        return;
      }
      if (body.ccPurged) {
        PlatformUI.alert({ title: 'Session restored', message: "Claude's memory had already been cleared, so this picks up as a fresh chat on the same branch." });
      }
    } catch (err) {
      PlatformUI.toast(`Unarchive failed: ${err.message}`);
      btn.textContent = original;
      btn.disabled = false;
      return;
    }
    await AppView._loadDevFeed();
  },

  // Shared archive flow for a dev session: confirm (proposal-card copy,
  // since restore lives in the archived toggle beneath the pinned
  // session block) then POST /api/sessions/:id/archive. Owner-scoped
  // server-side. Returns true on success so callers can re-render. Used
  // by the pinned session cards' Archive button (delegated handler).
  async _archiveSession(sessionId, name) {
    if (!sessionId) return false;
    const ok = await ConfirmModal.show({
      title: `Archive "${name}"?`,
      message: "This closes the PR and frees the slot. You can Unarchive it later to restore it (chat memory is kept for 30 days).",
      confirmLabel: 'Archive',
      danger: true,
    });
    if (!ok) return false;
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/archive`, { method: 'POST' });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        PlatformUI.toast(data.error || `Archive failed (HTTP ${resp.status}).`);
        return false;
      }
    } catch (err) {
      PlatformUI.toast(`Archive failed: ${err.message}`);
      return false;
    }
    return true;
  },

  // Refresh the session cards' busy indicators on a slow tick while the
  // card list is mounted; self-clears when #dev-body leaves the DOM
  // (topic/chat/settings sub-views — renderDevView re-arms on return).
  // Dirty-checks via _refreshSessionCaches so an idle tick never
  // repaints the board (keeping filter-input focus and scroll intact).
  // #1038: subscribe the Dev board's card surfaces to live session state.
  // Replaces the old 15s `_stripTimer`, which re-pulled three full payloads
  // just to notice a "working…" tag had flipped. Registered once at module
  // load (below), not per mount, so it survives every repaint; the repaint
  // itself no-ops when no card surface is mounted.
  _onSessionStateChanged() {
    // Never rebuild the board out from under an in-progress drag — same
    // guard _repaintDevBody / _repaintKanbanBoard apply to WS-driven
    // repaints. The next settled event repaints.
    if (AppView._dragState) return;
    if (!AppView.appData) return;
    if (typeof App !== 'undefined' && App.currentTab !== 'dev') return;
    // _repaintCards, not _repaintDevBody: an auto-run can be watched from
    // the OPENED TOPIC view (#gc-thread-head), where #dev-body isn't
    // mounted at all. The 8s poller this replaced called that case out
    // explicitly, and keying on #dev-body alone would silently strand it.
    // Both halves no-op when their own surface is absent.
    AppView._repaintCards();
  },

  // #1038: an auto-run's card state lives on the cached issue row, not on a
  // session id, so the raw event has to patch it before the repaint reads
  // it. Field-scoped merge (same as the retired 8s poller): bounty state can
  // carry optimistic local edits a broadcast must not clobber.
  _onSessionStateEvent(payload) {
    if (!payload || !payload.headless) return;
    const n = payload.headless.issueNumber;
    if (n == null) return;
    if (!AppView.appData || !payload.appSlug || payload.appSlug !== AppView.appData.slug) return;
    const issue = (AppView._ghIssues || []).find((i) => i && i.number === n);
    if (!issue) return;
    issue.headless = {
      ...(issue.headless || {}),
      sessionId: payload.sessionId,
      status: payload.headless.status,
      outcome: payload.headless.outcome,
    };
  },

  // The issue's body (GitHub markdown), rendered in the topic
  // sub-view between the header card and the thread.
  _issueBodyHtml(issue) {
    // #683: images opt-in so attached screenshots (the **Screenshot:**
    // embed appended by routes/feedback.js) render inline.
    const renderMd = (typeof DevChat !== 'undefined' && DevChat.renderMarkdown)
      ? (s) => DevChat.renderMarkdown(s, { images: true })
      : (s) => `<pre class="whitespace-pre-wrap font-sans">${escapeHtml(s)}</pre>`;
    return issue && issue.body && issue.body.trim()
      ? `<div class="dev-issue-body text-xs text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 mt-2">${renderMd(issue.body)}</div>`
      : '';
  },

  // #396: is this comment author the platform bot? GitHub App actors
  // comment as `<name>[bot]`; the platform bot account is `usernode-bot`.
  // Tolerant of both so the bot's earlier auto-proposal questions are
  // labelled distinctly from the reporter's replies. Mirrors the bot
  // detection in buildHeadlessSeed (server-side).
  _isBotCommentAuthor(author) {
    const a = (author || '').toString().toLowerCase();
    return /\[bot\]$/.test(a) || a === 'usernode-bot' || a.endsWith('-bot');
  },

  // #396: the GitHub comment thread for an issue, rendered beneath the
  // issue body in the topic sub-view. One row per comment (author + date +
  // markdown body), with bot comments tagged. When `truncated`, a final
  // line notes older comments were omitted and links out to the full
  // thread on GitHub. Returns '' when there are no comments so nothing
  // renders. Markdown goes through the same DevChat.renderMarkdown pipeline
  // as the body.
  _issueCommentsHtml(comments, truncated, htmlUrl) {
    const list = Array.isArray(comments) ? comments : [];
    if (!list.length) return '';
    const renderMd = (typeof DevChat !== 'undefined' && DevChat.renderMarkdown)
      ? (s) => DevChat.renderMarkdown(s)
      : (s) => `<pre class="whitespace-pre-wrap font-sans">${escapeHtml(s)}</pre>`;

    const rows = list.map((c) => {
      const isBot = AppView._isBotCommentAuthor(c.author);
      const author = c.author ? escapeHtml(c.author) : 'unknown';
      const date = (c.createdAt || '').slice(0, 10);
      const botTag = isBot
        ? ' <span class="text-[10px] uppercase tracking-wide text-sky-600 dark:text-sky-400">bot</span>'
        : '';
      return `<div class="dev-issue-comment border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-xs font-medium text-zinc-700 dark:text-zinc-200">${author}</span>${botTag}
            ${date ? `<span class="text-[10px] text-zinc-400 dark:text-zinc-500">${escapeHtml(date)}</span>` : ''}
          </div>
          <div class="text-xs text-zinc-600 dark:text-zinc-300">${renderMd(c.body || '')}</div>
        </div>`;
    });

    const omitted = truncated
      ? `<div class="text-[11px] text-zinc-400 dark:text-zinc-500 px-1">Earlier comments omitted — ${
          htmlUrl
            ? `<a href="${escapeHtml(htmlUrl)}" target="_blank" rel="noopener" class="underline hover:text-zinc-600 dark:hover:text-zinc-300">view the full thread on GitHub</a>`
            : 'view the full thread on GitHub'
        }.</div>`
      : '';

    return `<div class="flex flex-col gap-2 mt-2">
        <div class="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500 px-1">Discussion</div>
        ${omitted}
        ${rows.join('')}
      </div>`;
  },

  // ── Shared dev-chat transcript (read-only) ─────────────────────────
  //
  // Rendered on a shared session's topic page, and on a proposal's page
  // when its owner published the chat. Collapsed by default and fetched on
  // expand: a transcript is the biggest payload on either page and most
  // visits are there for the discussion, not the chat.

  // Per-session transcript cache, so re-expanding (or a WS-driven
  // _renderTopicHead repaint) paints from memory instead of refetching.
  // Cleared for a session when its owner toggles sharing (see
  // _setTranscriptShared).
  _transcripts: {},

  // The id of the session whose transcript section is currently EXPANDED
  // (null = collapsed). Deliberately AppView state rather than DOM state:
  // _renderTopicHead re-innerHTML's the whole head on every WS/poll-driven
  // refresh, so a DOM-only open flag gets wiped seconds after the reader
  // expands the chat. Keeping it here means a repaint re-renders the
  // section already open and repaints from _transcripts cache — no flicker,
  // no lost scroll. Also what the "Read chat" chip sets to arrive expanded.
  _transcriptOpen: null,

  // The collapsed section shell. Returns '' when the item's owner hasn't
  // published the transcript — the ONLY gate on the client; the server
  // re-checks both share flags on the fetch, so a stale flag here buys
  // nothing but an empty section.
  //
  // `item` is a shared-session row (transcript_shared + message_count from
  // /shared-sessions) or a proposal row (transcript_shared from
  // mergedRowSelect). The viewer's OWN rows carry transcript_shared_at
  // instead, so accept either shape — the owner gets the section too, as
  // the "preview what everyone else sees" path.
  _transcriptSectionHtml(item) {
    if (!item) return '';
    const shared = !!(item.transcript_shared || item.transcript_shared_at);
    if (!shared) return '';
    const id = item.id;
    const label = (typeof SessionTranscript !== 'undefined' && SessionTranscript.headerText)
      ? SessionTranscript.headerText(item, { expanded: false })
      : 'Read the dev chat';
    const expanded = AppView._transcriptOpen === id;
    return `<div class="st-section" data-transcript-section="${id}">
        <button type="button" class="st-section-head" data-transcript-toggle="${id}"
          aria-expanded="${expanded ? 'true' : 'false'}">
          <span class="st-caret" aria-hidden="true"></span>
          <span data-transcript-label>${escapeHtml(label)}</span>
          <span class="st-readonly-tag">read-only</span>
        </button>
        <div class="st-body" data-transcript-body="${id}" ${expanded ? '' : 'hidden'}></div>
      </div>`;
  },

  // Expand/collapse + lazy load. Flips _transcriptOpen (the durable state)
  // as well as the DOM, so the next repaint of the topic head paints the
  // section in the same state instead of snapping it shut.
  _toggleTranscript(toggle) {
    const id = parseInt(toggle.dataset.transcriptToggle, 10);
    const body = document.querySelector(`[data-transcript-body="${id}"]`);
    if (!body) return;
    const opening = body.hasAttribute('hidden');
    AppView._transcriptOpen = opening ? id : null;
    if (opening) {
      body.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      AppView._loadSessionTranscript(id);
    } else {
      body.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
    }
  },

  // Fetch (or repaint from cache) one session's sanitised transcript.
  // Best-effort in the same style as _loadIssueComments: a failure leaves a
  // short note rather than breaking the page, and we re-resolve the slot
  // after the await in case a repaint replaced it.
  async _loadSessionTranscript(sessionId) {
    if (!sessionId) return;
    const paint = (data) => {
      const slot = document.querySelector(`[data-transcript-body="${sessionId}"]`);
      if (!slot) return;
      // Swap the collapsed label ("Read the dev chat (24 messages)") for the
      // expanded one ("Dev chat by alice · 24 messages · read-only") now
      // that the payload names the owner. Keyed on a data attribute, not
      // nth-child, so reordering the header's spans can't silently break it.
      const head = document.querySelector(`[data-transcript-toggle="${sessionId}"]`);
      if (head && typeof SessionTranscript !== 'undefined' && SessionTranscript.headerText) {
        const label = head.querySelector('[data-transcript-label]');
        if (label) label.textContent = SessionTranscript.headerText(data.session, { expanded: true });
      }
      const body = (typeof SessionTranscript !== 'undefined' && SessionTranscript.renderHtml)
        ? SessionTranscript.renderHtml(data)
        : '';
      slot.innerHTML = body + AppView._transcriptActionsHtml(data.session);
    };

    const cached = AppView._transcripts[sessionId];
    if (cached) { paint(cached); return; }

    const slot = document.querySelector(`[data-transcript-body="${sessionId}"]`);
    if (slot) slot.innerHTML = '<div class="st-truncated">Loading the chat…</div>';
    try {
      const res = await fetch(`/api/sessions/${sessionId}/transcript${AppView._demoQS()}`);
      if (!res.ok) {
        const after = document.querySelector(`[data-transcript-body="${sessionId}"]`);
        if (after) {
          after.innerHTML = `<div class="st-error">${res.status === 404
            ? 'This chat is no longer shared.'
            : `Couldn't load the chat (HTTP ${res.status}).`}</div>`;
        }
        return;
      }
      const data = await res.json();
      AppView._transcripts[sessionId] = data;
      paint(data);
    } catch (err) {
      const after = document.querySelector(`[data-transcript-body="${sessionId}"]`);
      if (after) after.innerHTML = `<div class="st-error">Couldn't load the chat: ${escapeHtml(err.message)}</div>`;
    }
  },

  // "Fork this chat", under the transcript. Suppressed for read-only
  // viewers (a dev chat spends the viewer's own AI budget and its API is
  // collab-gated — same rule as _exploreChatBtnHtml) and for the owner,
  // whose own session is right there. can_fork comes from the server, so
  // the button never appears where the POST would be refused.
  _transcriptActionsHtml(session) {
    if (!session || !session.can_fork || AppView.readOnly) return '';
    return `<div class="st-actions">
        <button type="button" class="gc-vote-btn" data-fork-chat="${session.id}"
          title="${escapeAttr(AppView.FORK_CHAT_TITLE)}">Fork this chat</button>
      </div>`;
  },

  FORK_CHAT_TITLE: 'Start your own dev session from this chat — you get a copy of the '
    + "conversation and your own branch off theirs. Their session isn't affected.",

  // Fork a shared chat into the viewer's own new session, then open it.
  // The server owns every refusal (not shared, your own chat, session caps,
  // platform capacity), so this just surfaces whatever it says.
  async forkSharedChat(sessionId, btn) {
    if (!sessionId) return;
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Forking…'; }
    try {
      const res = await fetch(`/api/sessions/${sessionId}/fork`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        PlatformUI.toast(body.error || `Couldn't fork this chat (HTTP ${res.status}).`);
        if (btn) { btn.disabled = false; btn.textContent = original; }
        return;
      }
      const created = body.session;
      if (!created || !created.id) {
        PlatformUI.toast("Fork created, but couldn't open it — check your sessions.");
        if (btn) { btn.disabled = false; btn.textContent = original; }
        return;
      }
      App.switchTab('dev', created.id, 'sessions');
    } catch (err) {
      PlatformUI.toast(`Couldn't fork this chat: ${err.message}`);
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  },

  // #396: lazily fetch + render an issue's GitHub comment thread into the
  // #dev-issue-comments placeholder. Cached per issue number in _ghComments
  // so WS-driven _renderTopicHead refreshes paint from cache without a
  // refetch. Best-effort: a failed fetch leaves the placeholder empty (the
  // issue body still renders). Re-resolves the placeholder after the await
  // since _renderTopicHead may have repainted, and bails if the user
  // navigated away from this issue.
  async _loadIssueComments(item) {
    if (!item || item.number == null) return;
    const number = item.number;

    const paint = (data) => {
      const t = AppView._devTopic;
      if (!t || t.kind !== 'issue' || t.id !== number) return;
      const slot = document.getElementById('dev-issue-comments');
      if (!slot) return;
      slot.innerHTML = AppView._issueCommentsHtml(data.comments, data.truncated, item.htmlUrl);
    };

    const cached = AppView._ghComments[number];
    if (cached) { paint(cached); return; }

    try {
      const slug = AppView.appData && AppView.appData.slug;
      if (!slug) return;
      const res = await fetch(
        `/api/apps/${slug}/github-issues/${number}/comments${AppView._demoQS()}`
      );
      if (!res.ok) return;
      const data = await res.json();
      const entry = {
        comments: Array.isArray(data.comments) ? data.comments : [],
        truncated: !!data.truncated,
      };
      AppView._ghComments[number] = entry;
      paint(entry);
    } catch (_) { /* best-effort: leave the placeholder empty */ }
  },

  // The proposal's plain-language summary (pr_summary_md), rendered at the
  // top of the proposal topic sub-view above the proposer/linked-issues/
  // roster details. Mirrors _issueBodyHtml: light markdown through the same
  // DevChat.renderMarkdown (marked + DOMPurify) pipeline, same styled
  // container. Empty string when no summary was generated (legacy proposals,
  // or an LLM-unavailable turn) so nothing renders and the rest of the view
  // is unchanged.
  _proposalSummaryHtml(pr) {
    const md = pr && typeof pr.pr_summary_md === 'string' ? pr.pr_summary_md.trim() : '';
    if (!md) return '';
    const renderMd = (typeof DevChat !== 'undefined' && DevChat.renderMarkdown)
      ? (s) => DevChat.renderMarkdown(s)
      : (s) => `<pre class="whitespace-pre-wrap font-sans">${escapeHtml(s)}</pre>`;
    return `<div class="dev-issue-body text-xs text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 mt-2">${renderMd(md)}</div>`;
  },

  // The placeholder-title marker (AI naming was unavailable when this
  // proposal / issue was titled, so it carries a template rather than a
  // description of the change) used to be its own sky CHIP in the badge row.
  // It is a meta-line word now — "auto-title pending", built by
  // _proposalProvenanceWords and by the issue card's meta parts — because it
  // cost one of the four badge slots and never changes what you'd do next.
  // The title-heal sweeper (src/services/title-heal.js) still removes it
  // automatically once the API is back.

  // One PR-proposal card: line 1 is identity + info (icon chip, title,
  // PR meta, tally pill, badges), line 2 is the action pills (vote /
  // preview / kudos / Discussion / Open session). With { noNav: true }
  // (the topic sub-view's header card) the tap-to-open affordance and
  // Discussion button are dropped — you're already in the discussion.
  // On narrow screens line 1 wraps progressively instead of truncating
  // the title: the 💬 badge drops to the next line first, then the
  // tally pill, and only then does the title itself wrap (see
  // .dev-card-headline in app.css).
  _renderProposalCard(pr, opts) {
    const noNav = !!(opts && opts.noNav);
    const ctx = AppView._proposalsCtx || {};
    const majority = ctx.majority || 1;
    const isMerging = pr.status === 'merging';
    const isMerged = pr.status === 'merged';
    let titleHtml;
    if (pr.revert_of_session_id) {
      const origLabel = pr.original_pr_title
        ? `${escapeHtml(pr.original_pr_title)}`
        : `PR #${pr.original_pr_number || pr.revert_of_session_id}`;
      titleHtml = `<span class="text-amber-500">↩ Revert of</span> ${origLabel}`;
    } else {
      titleHtml = pr.pr_title ? escapeHtml(pr.pr_title) : `Change by ${escapeHtml(pr.username || '')}`;
    }
    // ── Meta line ──
    // Provenance moved OFF the badge row and INTO this line as plain words.
    // "Imported PR" / "Built with Codex" / "Platform maintenance" /
    // "Auto-title pending" were four badges competing for the four badge
    // slots with the signals that actually change what you'd do next; as
    // meta words they cost no slot and still read at a glance.
    const metaParts = [
      `<a href="${pr.pr_url || '#'}" target="_blank" rel="noopener" class="font-mono text-violet-400 hover:underline">PR#${pr.pr_number || pr.id}</a>`,
    ];
    const provenance = AppView._proposalProvenanceWords(pr);
    if (provenance) metaParts.push(provenance);
    if (pr.username) metaParts.push(escapeHtml(pr.username));
    if (pr.created_at) metaParts.push(escapeHtml(relTime(pr.created_at)));
    // Live proposals link their "Closes #N" pills to the issue's IN-APP
    // discussion (votes/bounty/thread live there; the GitHub link stays
    // one click away in the issue topic head). Merged cards keep the
    // external GitHub links — those issues are closed, so the in-app
    // topic (resolved from the open-issues cache) would dead-end and
    // GitHub is their permanent record.
    const closesPills = isMerged
      ? AppView.closesPillHtml(pr)
      : AppView.issueChipsHtml(pr.linked_issues, { label: 'Closes' });

    // mine: the viewer authored this PR, so they own its dev session. Drives
    // both "Open session" and the violet "yours" icon below.
    const mine = !!(App.user && pr.user_id === App.user.id);
    // #687: an imported PR has no platform-owned dev session — its code is
    // maintained on GitHub by an external author.
    const imported = pr.source === 'imported';
    const chatN = parseInt(pr.chat_count) || 0;

    // ── Badges: the composite pill + at most three metadata chips ──
    // The pill absorbs the tally, the pulsing "Vote" badge, the merge-state
    // badge, the checks badge, the console-errors badge, the advisory chip
    // and the explicit-approval chip. Unset metadata chips don't render.
    const badges = AppView._attrChipsHtml('proposal', pr.id, pr, {
      readonly: isMerged, omitUnset: !noNav, asArray: true,
    });
    // The pill is its own FULL-WIDTH row now, not one of the four badges.
    // The detail head keeps the inline capsule — it already has a wide
    // header and a second full-width bar there would just be a rule.
    const pill = AppView.statusPillHtml(pr, { majority, locked: ctx.locked, inline: noNav });

    // ── Actions: Yes / No + icon Preview; ⋯ is pinned in the head ──
    const preview = AppView.cardPreviewHtml(pr, { kind: 'proposal', sessionId: pr.id });
    const primary = (isMerged || AppView.readOnly) ? [] : AppView._cardVoteButtonsHtml(pr);
    const menu = AppView._proposalMenuItems(pr, { mine, imported, isMerged, isMerging, noNav });
    const actions = AppView._cardActionsHtml({ primary, preview });

    // #195/#211: the before/after capture tiles no longer live on the card —
    // they are a detail-view concern (see _renderTopicHead's actions block),
    // reached from the ⋯ menu's "Before/after screenshots" item. The card
    // keeps only the data hook so the tiles' own scope resolution still
    // works when the detail view paints them.
    const isUnvoted = pr.status === 'promoted' && !pr.my_vote;

    return `
      <div class="gc-vote-item ${AppView.DEV_CARD_CLS}${noNav ? '' : ` ${AppView.DEV_CARD_HOVER_CLS}`}${isMerging ? ' opacity-70' : ''}"${isUnvoted ? ' data-unvoted="1"' : ''} data-ref-pr="${pr.pr_number || pr.id}"${noNav ? '' : ` data-proposal-row="${pr.id}" title="Open this proposal's discussion"`}>
        ${AppView._devCardIcon(isMerged ? 'done' : (mine ? 'proposalMine' : 'proposal'), mine && !isMerged ? { title: 'This is your PR — open its session.' } : undefined)}
        ${AppView._cardContentHtml({
          headlineHtml: AppView._cardHeadlineHtml(
            titleHtml, metaParts.join(' · ') + (closesPills ? ` ${closesPills}` : '')),
          badges,
          chatCount: chatN,
          uncapped: noNav,
          pill: noNav ? '' : pill,
          inlinePill: noNav ? pill : '',
          actions,
        })}
        ${AppView._cardRailHtml(`proposal:${pr.id}`, menu, { chevron: !noNav })}
      </div>`;
  },

  // The provenance words that replaced four badges on the meta line. Kept
  // short — this line truncates — and ordered so the most load-bearing fact
  // (where the code came from) reads first. Returns '' for an ordinary
  // in-platform proposal, which is the common case.
  _proposalProvenanceWords(pr) {
    const bits = [];
    if (pr.source === 'imported') {
      bits.push(pr.imported_pr_author
        ? `imported from GitHub (${escapeHtml(pr.imported_pr_author)})`
        : 'imported from GitHub');
    }
    const agent = AppView.externalAgentName(pr.external_agent);
    if (agent) bits.push(`built with ${escapeHtml(agent)}`);
    if (pr.source === 'maintenance') bits.push('platform maintenance');
    // The placeholder-title marker: a word, not a chip. The title-heal
    // sweeper removes it on the next refresh once AI naming is back.
    if (pr.pr_title_fallback && !pr.revert_of_session_id) bits.push('auto-title pending');
    return bits.join(' · ');
  },

  // The card's Yes/No pair, and ONLY that pair. voteButtonsHtml stays as it
  // is — group-chat.js's inline activity rows, the work drawer and the home
  // strip all consume it, and its Preview/Retry/Admin-merge concatenation is
  // still the right shape there. On the board those three moved to the icon
  // slot and the ⋯ menu, so the card needs its own narrower builder.
  //
  // Keeps the reviewed_head_sha revision argument: the server rejects a vote
  // cast against a head the voter never saw, and dropping it here would
  // silently disable that guard.
  _cardVoteButtonsHtml(pr) {
    if (!pr || pr.status !== 'promoted') return [];
    const nativeHead = pr.source !== 'imported'
      && typeof pr.reviewed_head_sha === 'string'
      && /^[0-9a-f]{40}$/i.test(pr.reviewed_head_sha)
      ? pr.reviewed_head_sha.toLowerCase()
      : null;
    const revisionArg = nativeHead ? `, '${nativeHead}'` : '';
    const yesT = AppView._voteBtnTally(pr.qualified_yes_count, pr.yes_count, pr.approval_policy, 'Yes');
    const noT = AppView._voteBtnTally(pr.qualified_no_count, pr.no_count, pr.approval_policy, 'No');
    return [
      `<button class="gc-vote-btn gc-vote-btn-yes${pr.my_vote === 'yes' ? ' gc-vote-active' : ''}"${yesT.title} onclick="AppView.castVote(${pr.id}, 'yes'${revisionArg})">Yes (${yesT.label})</button>`,
      `<button class="gc-vote-btn gc-vote-btn-no${pr.my_vote === 'no' ? ' gc-vote-active' : ''}"${noT.title} onclick="AppView.castVote(${pr.id}, 'no'${revisionArg})">No (${noT.label})</button>`,
    ];
  },

  // Everything a proposal card demoted off its face, as ⋯ descriptors.
  // Same labels, same tooltips, same permission rules as the pills they
  // replace — only the location changed.
  _proposalMenuItems(pr, state) {
    const st = state || {};
    const ctx = AppView._proposalsCtx || {};
    const items = [];
    const ro = AppView.readOnly;
    const isMerged = st.isMerged || pr.status === 'merged';
    const isMerging = st.isMerging || pr.status === 'merging';

    if (!ro && !isMerged) {
      // Admin force-merge: platform admins always; the app's own admins
      // except on a proposal that changes the admins block (self-escalation).
      const canForceMerge = App.user?.canAdminWrite
        || (!!ctx.isAppAdmin && !pr.requires_explicit_approval);
      if (canForceMerge && pr.status === 'promoted') {
        items.push({
          label: 'Admin merge',
          icon: 'merge',
          title: pr.requires_explicit_approval
            ? 'Admin: merge this admins-changing PR right now, bypassing the vote'
            : 'Admin: merge this PR right now, bypassing the vote majority',
          danger: true,
          act: () => AppView.castAdminMerge(pr.id),
        });
      }
    }
    // Sessions are owner-scoped server-side, so this only renders for the
    // proposer — and never for an imported PR, which has no in-app session.
    if (st.mine && !st.imported) {
      items.push({
        label: 'Open session',
        icon: 'session',
        title: 'Open the dev session behind this proposal',
        act: () => AppView.openProposalSession(pr.id),
      });
    }
    if (st.mine && !ro && !isMerged && !isMerging && pr.status === 'promoted') {
      items.push({
        label: 'Withdraw',
        icon: 'withdraw',
        title: 'Withdraw this proposal (closes the PR, removes it from the vote panel)',
        danger: true,
        act: () => AppView.withdrawProposal(pr.id),
      });
    }
    if (isMerged && !ro) {
      // Undo opens a revert PR, which then needs its own merge vote.
      if (!pr.revert_of_session_id && !pr.revert_session_id) {
        items.push({
          label: 'Undo',
          icon: 'undo',
          title: 'Open a revert PR for this merge. It still needs a merge vote to land.',
          danger: true,
          act: () => AppView.undoPr(pr.id),
        });
      }
    }
    // Kudos: the pill became a menu row. Mirrors Kudos.attach's own
    // click routing (retract a direct kudos, otherwise give) and the same
    // self-kudos / bounty-credit disables the button carries, so the row
    // never offers a POST the server would refuse.
    if (window.Kudos && !ro) {
      const entry = Kudos._ensureCache ? Kudos._ensureCache(pr.id) : {};
      const isSelf = !!(App.user && pr.user_id && pr.user_id === App.user.id);
      const mineKudos = !!entry.my_kudos;
      const direct = !!entry.my_kudos_direct;
      const reason = isSelf
        ? 'You can’t give kudos to your own PR'
        : (mineKudos && !direct ? 'Credited via an issue bounty award — can’t be retracted' : '');
      const count = entry.count || 0;
      items.push({
        label: (mineKudos && direct ? 'Retract kudos' : 'Give kudos') + (count ? ` (${count})` : ''),
        icon: 'kudos',
        title: reason || (mineKudos && direct
          ? 'You gave kudos to this PR — this retracts it'
          : 'Thank the author of this change'),
        disabled: !!reason,
        act: reason ? null : () => {
          const live = Kudos._ensureCache(pr.id);
          if (live.my_kudos && live.my_kudos_direct) Kudos.retract(pr.id);
          else Kudos.give(pr.id);
        },
      });
    }
    // #313/#827/#1045/#1047: owners reach the Mayor via "Open session" on
    // their own PR, so Explore is offered on proposals the viewer does NOT
    // own — plus their OWN IMPORTED ones, which have no dev session behind
    // them and so get no "Open session" row to cover them. One shared
    // predicate, so this rule can't drift between the card and the detail
    // view.
    if (AppView._showExplorePill(pr) && !ro) {
      items.push({
        label: 'Explore in dev chat',
        icon: 'explore',
        title: AppView.EXPLORE_CHAT_TITLE,
        act: () => AppView.exploreProposalInDevChat(pr.id, null),
      });
    }
    if (!ro && !pr.staging_url && pr.staging_error) {
      items.push({
        label: 'Retry preview',
        icon: 'retry',
        title: "Try building this proposal's staging preview again",
        act: () => AppView.swapToStagingForSession(pr.id, ''),
      });
    }
    if (AppView.visualsTilesHtml(pr.visuals)) {
      items.push({
        label: 'Before/after screenshots',
        icon: 'visuals',
        title: 'Open this proposal and expand its before/after captures',
        act: () => { AppView._visualsOpen.add(pr.id); AppView.openTopic('proposal', pr.id); },
      });
    }
    if (!st.noNav) {
      items.push(...AppView._attrMenuItems('proposal', pr.id, pr, { readonly: isMerged }));
    }
    if (pr.pr_url) {
      items.push({
        label: 'View PR on GitHub',
        icon: 'github',
        title: pr.pr_url,
        act: () => window.open(pr.pr_url, '_blank', 'noopener'),
      });
    }
    return items;
  },

  // The proposal's details block (PR link, proposer, linked issues,
  // vote roster, locked note), rendered in the topic sub-view between
  // the header card and the thread.
  _proposalDetailsHtml(pr) {
    const ctx = AppView._proposalsCtx || {};
    const slug = AppView.appData ? AppView.appData.slug : '';
    const linked = (Array.isArray(pr.linked_issues) ? pr.linked_issues : [])
      .map((v) => (typeof v === 'number' ? v : Number(v)))
      .filter((n) => Number.isInteger(n) && n > 0);
    const chips = linked.map((n) =>
      `<a href="#app/${slug}/dev/issues/${n}" class="dev-badge font-mono bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20" title="Open issue #${n}">#${n}</a>`
    ).join(' ');
    const imported = pr.source === 'imported';
    const details = [];
    if (pr.pr_url) details.push(`<a href="${pr.pr_url}" target="_blank" rel="noopener" class="text-violet-400 hover:underline">View PR on GitHub</a>`);
    details.push(`${imported ? 'imported by' : 'proposed by'} <span class="font-medium">${escapeHtml(pr.username || '')}</span>`);
    if (pr.created_at) details.push(escapeHtml(relTime(pr.created_at)));
    // #687: imported proposals have no in-app dev session — the code is
    // maintained on GitHub by its author, so there's no continue-in-dev-chat,
    // sync-with-main, or in-app edit. Spell that out where those controls
    // would otherwise be discovered.
    const importedNote = imported
      ? `<div class="text-xs text-amber-600 dark:text-amber-400 mt-1">Imported pull request${pr.imported_pr_author ? ` — authored by <span class="font-medium">${escapeHtml(pr.imported_pr_author)}</span>` : ''}. The code is maintained on GitHub; there's no in-app dev session for it. Voting and checks work the same as any proposal.</div>`
      : '';
    // #967: for a connector-authored proposal, say plainly who wrote the
    // code and on whose account — an imported proposal that arrived this
    // way was built by the proposer's own agent, not by a stranger and not
    // out of the platform's credits.
    const agentName = AppView.externalAgentName(pr.external_agent);
    const agentNote = agentName
      ? `<div class="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Built with <span class="font-medium">${escapeHtml(agentName)}</span> by <span class="font-medium">${escapeHtml(pr.username || 'the proposer')}</span>, on their own coding-agent subscription, from a branch in their GitHub fork.</div>`
      : '';
    // #866: say in prose what the Preview slot says in a pill, so the
    // detail view explains why there's no Preview button yet (or why there
    // won't be one) instead of leaving a reviewer to guess.
    let previewNote = '';
    if (!pr.staging_url && pr.staging_building) {
      previewNote = '<div class="text-xs text-zinc-500 dark:text-zinc-400 mt-1">A staging preview is being built for this proposal — it usually takes a few minutes, and a Preview button appears as soon as it\'s ready. Automated checks run against that preview, so they\'ll still be pending until then.</div>';
    } else if (!pr.staging_url && pr.staging_error) {
      previewNote = `<div class="text-xs text-amber-600 dark:text-amber-400 mt-1">The staging preview couldn't be built, so there's nothing to preview and the automated checks can't run: ${escapeHtml(String(pr.staging_error).slice(0, 300))}</div>`;
    }
    const lockedNote = (ctx.locked && pr.status !== 'merged')
      ? '<div class="text-xs text-amber-500 mt-1">App is locked — this also needs at least one admin yes before it merges.</div>'
      : '';
    // #788 follow-up: a flagged proposal explains itself inline instead
    // of only via the chip tooltip / help popover. Numbers derive
    // exactly as _votingHelpText's (qualified tally first, votes_required
    // snapshot first) so the note can never contradict the pill.
    let explicitNote = '';
    if (pr.requires_explicit_approval && pr.status !== 'merged' && pr.status !== 'merging') {
      const eYes = pr.qualified_yes_count != null
        ? (parseInt(pr.qualified_yes_count) || 0) : (parseInt(pr.yes_count) || 0);
      const eSnap = parseInt(pr.votes_required);
      const eReq = (Number.isFinite(eSnap) && eSnap > 0)
        ? eSnap : (parseInt(ctx.majority) || 1);
      const eBody = eYes >= eReq
        ? `It has the Yes votes it needs (${eYes} of ${eReq}) and will merge as soon as the usual checks and conflict gates clear.`
        : `It needs ${eReq} real Yes vote${eReq === 1 ? '' : 's'} and has ${eYes} so far.`;
      explicitNote = `<div class="text-xs text-amber-600 dark:text-amber-400 mt-1">This proposal edits the app's admins list, so it won't merge on a timer. ${eBody} It can still be voted down, and it still closes on the usual schedule if nobody engages.</div>`;
    }
    const roster = pr.status !== 'merged'
      ? `<div id="dev-vote-roster-${pr.id}" class="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Loading votes…</div>`
      : '';
    // "How voting works" explainer affordances — only on live proposals
    // (the vote/time rules are settled once merged). The circular "?" sits
    // on the meta line next to the tally that the card above renders; the
    // one-line hint under the roster is the discoverable text entry point.
    // Both carry data-voting-help and open the same popover (see _attrInit
    // → _openVotingHelpPopover), reading the current topic item live.
    const showHelp = pr.status !== 'merged';
    const helpBtn = showHelp
      ? ` <button type="button" class="voting-help-btn" data-voting-help aria-label="How voting and merges work" title="How voting and merges work">?</button>`
      : '';
    const helpHint = showHelp
      ? `<div class="voting-help-hint mt-1">Merges are decided by votes over time. <button type="button" class="voting-help-link" data-voting-help>How voting works</button></div>`
      : '';
    return `
      <div class="text-xs text-zinc-500 dark:text-zinc-400 mt-2 px-1">
        <div>${details.join(' · ')}${helpBtn}</div>
        ${importedNote}
        ${agentNote}
        ${previewNote}
        ${chips ? `<div class="mt-1 flex flex-wrap gap-1 items-center"><span>Linked issues:</span> ${chips}</div>` : ''}
        ${AppView._mergeConflictDetailHtml(pr)}
        ${AppView._checksDetailHtml(pr)}
        ${AppView._platformEnvDetailHtml(pr)}
        ${roster}
        ${helpHint}
        ${explicitNote}
        ${lockedNote}
      </div>`;
  },

  // ── "How voting works" explainer ────────────────────────────────────
  // A read-only, client-side explainer for the vote/merge rules, anchored
  // in the focused proposal view (see _proposalDetailsHtml). The static
  // rules blurb is kept in ONE place so copy edits happen once; it
  // describes the SHAPE of the rules ("a few days", "shorter with more
  // support") rather than exact durations, since the window lengths and
  // fractions are env-tunable (MERGE_GATE_CONSTANTS in
  // services/active-users.js) and per-app thresholds are on the roadmap
  // (issue #428) — so quoting fixed numbers here would drift out of date.
  _VOTING_HELP_RULES_HTML:
    '<ul class="voting-help-rules">'
    + '<li>Only people who’ve actually used the app recently count as voters. The number of Yes votes needed scales with how many active testers there are.</li>'
    + '<li>A proposal with clear support and no objections merges on its own after a short visibility window (a few days), so everyone has a chance to look — <strong>silence counts as agreement</strong>.</li>'
    + '<li>The more support a proposal has, the shorter the wait. A clear majority merges almost immediately; thin, unopposed support waits longer.</li>'
    + '<li><strong>No</strong> votes make a proposal harder to pass: they raise the number of Yes votes needed and lengthen the wait.</li>'
    + '<li>If enough people vote No, the proposal becomes <strong>Contested</strong> — the time-based path turns off and it needs a straight majority of Yes votes to merge.</li>'
    + '<li>A proposal that’s being voted down with little support is closed automatically after a countdown (“Rejecting in …”).</li>'
    + '<li>Even after winning the vote, a proposal only merges once its <strong>automated checks pass</strong> and it’s <strong>up to date with the main app</strong>. Locked apps also need an admin’s Yes.</li>'
    + '<li>Apps can customize these rules: restricting approvals to <strong>invited approvers</strong> (everyone else’s votes stay visible but advisory) and/or requiring a fixed <strong>“at least N approvals”</strong> instead of the timed majority system.</li>'
    + '</ul>',

  // The live "This proposal, right now" line. Reads the serialized gate
  // fields the /promoted endpoint attaches (votes_required,
  // merge_window_ends_at, reject_window_ends_at, rejection_armed,
  // contested) plus status/check_state/behind_main, so the wording never
  // contradicts the tally pill / countdown beside it (voteCountPill). Pure
  // given (pr + _proposalsCtx), so it's unit-testable under Node. Returns
  // '' for a missing row.
  _votingHelpText(pr) {
    if (!pr) return '';
    const ctx = AppView._proposalsCtx || {};
    // #646: qualifying tallies when only invited approvers' votes count.
    const yes = pr.qualified_yes_count != null
      ? (parseInt(pr.qualified_yes_count) || 0) : (parseInt(pr.yes_count) || 0);
    const no = pr.qualified_no_count != null
      ? (parseInt(pr.qualified_no_count) || 0) : (parseInt(pr.no_count) || 0);
    const snap = parseInt(pr.votes_required);
    const required = (Number.isFinite(snap) && snap > 0)
      ? snap : (parseInt(ctx.majority) || 1);
    const active = parseInt(ctx.activeUsers) || Math.max(required, yes + no, 1);
    const tally = `Currently ${yes} Yes, ${no} No.`;
    const reached = yes >= required;

    // Terminal / in-flight lifecycle states win first.
    if (pr.status === 'merged') return 'This proposal has already merged into the app.';
    if (pr.status === 'merging') return 'This passed and is being merged into the app right now.';

    // A single merge-blocking clause (lowercase, no trailing period) when
    // one applies — folded into the "reached" sentence, or appended as a
    // note to the others so the explainer never implies a countdown will
    // merge straight past a blocked gate. Ordered by checkAndMerge's own
    // gate precedence (conflict → checks → behind → lock).
    let blocker = '';
    const mcs = pr.merge_conflict_state;
    const check = pr.check_state;
    if (mcs === 'failed') {
      blocker = 'automatic conflict resolution failed, so the proposer must resolve it before it can merge';
    } else if (mcs === 'resolving' || pr.resolving === true) {
      blocker = 'conflicts with the main app are being reconciled automatically before it can merge';
    } else if (check === 'failing') {
      blocker = 'its automated checks are failing, so it can’t merge until they pass';
    } else if (check === 'pending') {
      blocker = 'its automated checks are still running, so it can’t merge until they finish';
    } else if (check === 'error') {
      blocker = 'its automated checks couldn’t run, so it can’t merge until they pass';
    } else if ((parseInt(pr.behind_main, 10) || 0) > 0 || mcs === 'behind' || mcs === 'conflict') {
      blocker = 'it’s behind the main app and will sync automatically before merging';
    } else if (reached && ctx.locked) {
      blocker = 'the app is locked, so it also needs an admin’s Yes';
    }

    // #788: this proposal changes who can administer the app, so the
    // time-based merge paths are off. The app's NORMAL rules still
    // decide the threshold — which is why this is a suffix appended to
    // the regime-specific wording below rather than a branch that
    // replaces it. Every countdown branch is skipped because the server
    // sends no merge_window_ends_at for a flagged row.
    const noTimer = !!pr.requires_explicit_approval;
    const noTimerNote = noTimer
      ? ` This changes who can administer the app, so it won’t merge on a timer — it needs ${required} actual Yes vote${required === 1 ? '' : 's'}.`
      : '';

    // #646: "at least N approvals" mode — clock-free, so none of the
    // countdown/contested branches below apply. Describe the configured
    // rule, the current progress, and any merge blocker.
    if (pr.approvals_required != null) {
      const n = parseInt(pr.approvals_required) || 1;
      const who = pr.approval_policy === 'invited'
        ? 'its invited approvers' : 'any user';
      let s;
      if (reached) {
        s = blocker
          ? `It has the approvals it needs (${yes} of ${n}), but it can’t merge yet: ${blocker}.`
          : `It has the approvals it needs (${yes} of ${n}) — queued to merge shortly.`;
      } else {
        s = `This app requires at least ${n} approval${n === 1 ? '' : 's'} from ${who}. Currently ${yes} of ${n}.`;
        if (blocker) s += ` Note: ${blocker}.`;
      }
      if (pr.approval_policy === 'invited') {
        s += ' Everyone can still vote, but only approvers’ votes count toward the target.';
      }
      // In at-least-N mode the clocks were already off, so the note just
      // explains WHY the chip is showing — it isn't a behaviour change.
      return s + noTimerNote;
    }

    // Countdown geometry, mirroring voteCountPill.
    const now = Date.now();
    const mergeEnds = pr.merge_window_ends_at ? Date.parse(pr.merge_window_ends_at) : NaN;
    const inMergeWindow = Number.isFinite(mergeEnds) && mergeEnds > now;
    const rejectEnds = pr.reject_window_ends_at ? Date.parse(pr.reject_window_ends_at) : NaN;
    const inReject = Number.isFinite(rejectEnds) && rejectEnds > now;
    const lazyLead = !reached && yes >= 1 && yes > no;
    const contested = !!pr.contested;

    let sentence;
    let foldedBlocker = false;
    if (noTimer && reached) {
      // No visibility window to sit out — it merges as soon as the
      // normal threshold is met, subject to the usual blockers.
      sentence = blocker
        ? `It has enough Yes votes (${yes} of ${required}), but it can’t merge yet: ${blocker}.`
        : `It has the votes it needs (${yes} of ${required}) — queued to merge shortly.`;
      foldedBlocker = true;
    } else if (noTimer && pr.rejection_armed && inReject) {
      // Rejection is deliberately untouched by the no-timer modifier.
      const cd = AppView._fmtCountdown(rejectEnds - now);
      sentence = `More No than Yes, without enough support — this closes in ${cd} unless it gains support. ${tally}`;
    } else if (noTimer) {
      sentence = `It needs ${required} of ${active} active testers to vote Yes. ${tally}`;
    } else if (!contested && inMergeWindow && (reached || lazyLead)) {
      const cd = AppView._fmtCountdown(mergeEnds - now);
      sentence = reached
        ? `There are enough Yes votes (${yes} of ${required}) — this merges in ${cd} unless someone objects.`
        : `It has support (${yes} of ${required} needed) and no objections — it merges in ${cd} unless the vote changes; silence counts as agreement.`;
    } else if (pr.rejection_armed && inReject) {
      const cd = AppView._fmtCountdown(rejectEnds - now);
      sentence = `More No than Yes, without enough support — this closes in ${cd} unless it gains support. ${tally}`;
    } else if (contested) {
      sentence = `It’s contested — enough people object that the timed path is off, so it now needs a clear majority of Yes votes to pass. ${tally}`;
    } else if (reached) {
      sentence = blocker
        ? `It has enough Yes votes (${yes} of ${required}), but it can’t merge yet: ${blocker}.`
        : `It has the votes it needs (${yes} of ${required}) and green checks — queued to merge shortly.`;
      foldedBlocker = true;
    } else {
      sentence = `It needs ${required} of ${active} active testers to vote Yes. ${tally}`;
    }
    if (blocker && !foldedBlocker) sentence += ` Note: ${blocker}.`;
    // #695: invited-approver apps on the default clock — say who counts,
    // and how many recorded votes are merely advisory.
    if (pr.approval_policy === 'invited') {
      sentence += ' Everyone can still vote, but only approvers’ votes count toward the target.';
      const advisory = pr.qualified_yes_count != null
        ? Math.max(0, (parseInt(pr.yes_count) || 0) - yes)
          + Math.max(0, (parseInt(pr.no_count) || 0) - no)
        : 0;
      if (advisory > 0) {
        sentence += advisory === 1
          ? ' 1 advisory vote from a non-approver is recorded but doesn’t count.'
          : ` ${advisory} advisory votes from non-approvers are recorded but don’t count.`;
      }
    }
    return sentence + noTimerNote;
  },

  _closeVotingHelpPopover() {
    const el = document.getElementById('voting-help-popover');
    if (el) el.remove();
    AppView._votingHelpOpen = null;
  },

  // Open the "How voting & merges work" popover anchored under `anchorEl`
  // (the "?" button or the inline "How voting works" link). Read-only —
  // renders the live status line + the static rules blurb, no fetch.
  // Modeled on _openAttrPopover: a fixed, viewport-clamped element on
  // document.body, toggled off on re-trigger / outside-click / scroll /
  // resize / Escape (wired in _attrInit).
  _openVotingHelpPopover(anchorEl, pr) {
    // Toggle closed if one is already open (only one proposal is in view).
    if (AppView._votingHelpOpen) { AppView._closeVotingHelpPopover(); return; }
    AppView._closeAttrPopover();

    const pop = document.createElement('div');
    pop.id = 'voting-help-popover';
    pop.className = 'voting-help-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'How voting and merges work');
    const live = AppView._votingHelpText(pr);
    pop.innerHTML =
      '<div class="attr-pop-head">How voting &amp; merges work</div>'
      + (live
        ? '<div class="vh-live"><div class="vh-live-title">This proposal, right now</div>'
          + `<div class="vh-live-body">${escapeHtml(live)}</div></div>`
        : '')
      + `<div class="vh-rules">${AppView._VOTING_HELP_RULES_HTML}</div>`;
    document.body.appendChild(pop);
    AppView._votingHelpOpen = { prId: pr && pr.id };

    // Position under the anchor, fully clamped to the viewport so it never
    // runs off the bottom or sides on small / mobile screens. Falls back to
    // the top-left corner when the anchor has no rect (e.g. under the
    // unit-test sandbox). The popover has overflow-y:auto, so capping
    // max-height to the room actually available makes its body scroll
    // internally instead of spilling past the viewport edge.
    const MARGIN = 8;
    const GAP = 6;
    const rect = anchorEl && anchorEl.getBoundingClientRect
      ? anchorEl.getBoundingClientRect()
      : { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN };
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 360;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 640;

    // Width: preferred 320, but never wider than the viewport minus margins.
    const W = Math.min(320, vw - MARGIN * 2);
    pop.style.position = 'fixed';
    pop.style.width = `${W}px`;

    // Horizontal: align to the anchor's left edge, then clamp so the whole
    // popover stays on-screen (both edges within the margins).
    const left = Math.max(MARGIN, Math.min(Math.round(rect.left || MARGIN), vw - W - MARGIN));
    pop.style.left = `${left}px`;

    // Vertical: prefer opening below the anchor; flip above when there's
    // more room there. Either way, cap the height to the chosen side's
    // available space so it fits within the viewport.
    const spaceBelow = vh - (rect.bottom || 0) - GAP - MARGIN;
    const spaceAbove = (rect.top || 0) - GAP - MARGIN;
    const placeBelow = spaceBelow >= spaceAbove;
    const avail = Math.max(120, Math.floor(placeBelow ? spaceBelow : spaceAbove));
    pop.style.maxHeight = `${avail}px`;
    if (placeBelow) {
      pop.style.top = `${Math.round((rect.bottom || 0) + GAP)}px`;
      pop.style.bottom = 'auto';
    } else {
      // Anchor to the bottom so the popover grows upward from just above
      // the trigger, keeping its top edge inside the viewport.
      pop.style.bottom = `${Math.round(vh - (rect.top || 0) + GAP)}px`;
      pop.style.top = 'auto';
    }
  },

  // #47: expanded per-test detail for the proposal detail screen — the
  // structured replacement for the old flat console-error list. Renders a
  // green-tick / red-cross row per test with the screen it checked and, for
  // a failure, the reason (failed load, missing element, or the console
  // errors that fired). Only renders once a run exists with results; a
  // passing/empty/legacy-null state falls back to the advisory console
  // detail so mid-rollout proposals still surface something.
  _checksDetailHtml(pr) {
    if (!pr) return '';
    const state = pr.check_state;
    if (!state) {
      // #607: a fresh proposal with nothing recorded yet — the first run
      // hasn't stamped 'pending' (staging build still going). Show an
      // explicit starting state instead of a bare "Re-run checks" button.
      // The re-run escape hatch only appears once the proposal is old
      // enough (10 min, mirroring the server's stale-checks sweep) that
      // "starting" has plausibly wedged.
      if (!pr.console_check_state) {
        const stale = AppView._checksRunStale(pr.created_at);
        return `
        <div class="mt-2 rounded border border-zinc-300/40 dark:border-zinc-700/60 bg-zinc-500/5 px-2 py-1.5 text-zinc-600 dark:text-zinc-400">
          <div class="font-medium"><span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>Checks are starting…</div>
          <div class="mt-0.5 opacity-90">The staging preview is being prepared, then automated tests run against it. Merge is blocked until all tests pass.</div>
          ${stale ? '<div class="mt-1 opacity-80">If this has been stuck for a while, the platform re-runs the checks automatically — or re-run them now.</div>' : ''}
          ${stale ? AppView._recheckBtnHtml(pr) : ''}
        </div>`;
      }
      // #447: a never-recorded legacy/clone check still offers a manual
      // re-run for owners/admins so it isn't stuck blocked with no way out.
      const fallback = AppView._consoleCheckDetailHtml(pr);
      const rb = AppView._recheckBtnHtml(pr);
      return rb ? `${fallback}<div class="mt-1">${rb}</div>` : fallback;
    }
    const results = Array.isArray(pr.test_results) ? pr.test_results : [];

    if (state === 'pending') {
      // #447: stuck-'pending' checks now self-heal (the platform re-runs them
      // automatically once they've been running too long) and can be kicked
      // manually. #607: a FRESH run (under the ~10-min stale window) shows
      // just the spinner + started-at line — offering "Re-run checks"
      // seconds after a run began was the confusion in the issue report.
      const stale = AppView._checksRunStale(pr.checks_checked_at);
      const started = pr.checks_checked_at
        ? `<div class="mt-0.5 opacity-80">Started ${escapeHtml(relTime(pr.checks_checked_at))}.</div>`
        : '';
      // Name the STAGE the run is actually in. A checks run is two very
      // differently-sized halves — build the branch + clone the app's data,
      // then run the suite against the live preview — and one opaque message
      // for both made a mid-flight build look identical to a wedged one. An
      // unrecognised / absent phase (legacy rows, a proposal checked before
      // this shipped) keeps the previous wording verbatim.
      const phase = AppView._checksPhaseCopy(pr.check_phase);
      return `
        <div class="mt-2 rounded border border-zinc-300/40 dark:border-zinc-700/60 bg-zinc-500/5 px-2 py-1.5 text-zinc-600 dark:text-zinc-400">
          <div class="font-medium"><span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>${escapeHtml(phase.title)}</div>
          <div class="mt-0.5 opacity-90">${escapeHtml(phase.detail)} Merge is blocked until all tests pass.</div>
          ${started}
          ${stale ? '<div class="mt-1 opacity-80">If this has been running for a while, the platform re-runs the checks automatically — or re-run them now.</div>' : ''}
          ${stale ? AppView._recheckBtnHtml(pr) : ''}
        </div>`;
    }
    if (state === 'error') {
      return `
        <div class="mt-2 rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-red-500">
          <div class="font-medium">⚠ Checks couldn't run.</div>
          <div class="mt-0.5 opacity-90">The staging build or the test run itself broke, so the platform can't confirm the app works. Merge is blocked until checks pass.</div>
          <div class="mt-1 opacity-80">Pushing a fix rebuilds the preview and re-runs the checks.</div>
          ${AppView._recheckBtnHtml(pr)}
        </div>`;
    }
    if (state === 'skipped') {
      // #461: an explicit terminal "nothing to test" verdict — grey and
      // NON-blocking (the merge gate treats it like passing). The recorded
      // reason rides in check_error_detail; owners/admins can still force a
      // real run via the re-run button.
      const reason = pr.check_error_detail
        ? escapeHtml(String(pr.check_error_detail).slice(0, 280))
        : 'there was nothing to test';
      return `
        <div class="mt-2 rounded border border-zinc-300/40 dark:border-zinc-700/60 bg-zinc-500/5 px-2 py-1.5 text-zinc-600 dark:text-zinc-400">
          <div class="font-medium">Checks skipped.</div>
          <div class="mt-0.5 opacity-90">Automated checks were skipped — ${reason}. This does not block the merge.</div>
          ${AppView._recheckBtnHtml(pr)}
        </div>`;
    }
    if (!results.length) return ''; // 'passing' with no detail to show — the green badge is enough.

    // Every declared check now runs, so a suite is hundreds of rows rather
    // than a dozen, and the rows are no longer equal in weight: a BLOCKING
    // failure is why the merge is stuck, an ADVISORY failure is a check that
    // has never been seen passing (it reports, it does not block), and a
    // pass is context. Ordered by that weight, and the passes — the bulk —
    // fold away so the card opens on what someone has to act on.
    const rowHtml = (r) => {
      const pass = r && r.status === 'pass';
      const advisory = !pass && !!(r && r.advisory);
      const icon = pass ? '✓' : '✗';
      const iconCls = pass ? 'text-emerald-500' : (advisory ? 'text-zinc-500' : 'text-red-500');
      const name = escapeHtml(String((r && r.name) || 'test'));
      const path = (r && r.path) ? `<span class="opacity-60 font-mono">${escapeHtml(String(r.path))}</span>` : '';
      const chip = advisory
        ? ' <span class="rounded bg-zinc-500/10 px-1 text-[0.65rem] uppercase tracking-wide opacity-70">advisory</span>'
        : '';
      let detail = '';
      if (!pass) {
        const reason = (r && r.failureReason) ? escapeHtml(String(r.failureReason).slice(0, 500)) : 'failed';
        const errs = Array.isArray(r && r.consoleErrors) ? r.consoleErrors : [];
        const errItems = errs.map((e) => {
          const msg = escapeHtml(String((e && e.message) || '').slice(0, 500));
          const src = (e && e.source) ? escapeHtml(String(e.source).slice(0, 200)) : '';
          const kind = (e && e.kind) ? escapeHtml(String(e.kind)) : 'console';
          return `<li class="font-mono text-[0.7rem] break-all opacity-90"><span class="opacity-70">[${kind}]</span> ${msg}${src ? ` <span class="opacity-60">(${src})</span>` : ''}</li>`;
        }).join('');
        detail = `<div class="ml-4 opacity-90">${reason}</div>${errItems ? `<ul class="ml-6 list-disc space-y-0.5">${errItems}</ul>` : ''}`;
      }
      const rowCls = advisory ? ' class="opacity-70"' : '';
      return `<li${rowCls}><span class="${iconCls} font-medium">${icon}</span> ${name} ${path}${chip}</li>${detail}`;
    };

    const blockingRows = results.filter((r) => r && r.status !== 'pass' && !r.advisory);
    const advisoryRows = results.filter((r) => r && r.status !== 'pass' && r.advisory);
    const passRows = results.filter((r) => r && r.status === 'pass');
    // 'failing' is the stored verdict and the merge gate's own answer; the
    // blocking count is only used to phrase the heading, never to override
    // it, so a legacy row with no `advisory` flags still reads correctly.
    const failing = state === 'failing';

    // A row usually IS one check, but the "N checks did not finish" row
    // stands for N of them. Count checks, not rows, or the summary
    // under-reports the suite it is summarising.
    const weight = (r) => (r && r.count > 1 ? r.count : 1);
    const total = (rows) => rows.reduce((n, r) => n + weight(r), 0);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const advisoryChecks = total(advisoryRows);
    const summaryBits = [
      plural(total(results), 'check', 'checks'),
      `${passRows.length} passed`,
    ];
    if (blockingRows.length) summaryBits.push(plural(total(blockingRows), 'blocking failure', 'blocking failures'));
    if (advisoryChecks) summaryBits.push(plural(advisoryChecks, 'advisory failure', 'advisory failures'));
    const summary = `<div class="mt-0.5 opacity-80">${escapeHtml(summaryBits.join(' · '))}</div>`;

    const failureList = blockingRows.concat(advisoryRows).map(rowHtml).join('');
    // Under this many, folding costs a click and saves nothing.
    const PASS_FOLD_AT = 8;
    let passList = '';
    if (passRows.length && passRows.length <= PASS_FOLD_AT) {
      passList = `<ul class="mt-1 ml-1 space-y-0.5">${passRows.map(rowHtml).join('')}</ul>`;
    } else if (passRows.length) {
      passList = `
        <details class="mt-1">
          <summary class="cursor-pointer opacity-80">Show ${passRows.length} passing checks</summary>
          <ul class="mt-1 ml-1 space-y-0.5">${passRows.map(rowHtml).join('')}</ul>
        </details>`;
    }

    const wrapCls = failing
      ? 'border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-500'
      : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-500';
    let heading;
    if (failing) heading = '⚠ Some checks failed — merge is blocked until they pass.';
    else if (advisoryRows.length) heading = '✓ Every merge-blocking check passed on the staging build.';
    else heading = '✓ All checks passed on the staging build.';
    const advisoryNote = (!failing && advisoryRows.length)
      ? '<div class="mt-1 opacity-80">Advisory checks have never been observed passing on this app, so they report without blocking. Fix one and its first pass makes it a permanent guard rail.</div>'
      : '';
    const checked = pr.checks_checked_at
      ? `<div class="mt-1 opacity-80">Last checked ${escapeHtml(relTime(pr.checks_checked_at))}.</div>`
      : '';
    return `
      <div class="mt-2 rounded border px-2 py-1.5 ${wrapCls}">
        <div class="font-medium">${heading}</div>
        ${summary}
        ${failureList ? `<ul class="mt-1 ml-1 space-y-0.5">${failureList}</ul>` : ''}
        ${passList}
        ${advisoryNote}
        ${checked}
        ${failing ? '<div class="mt-1 opacity-80">Pushing a fix rebuilds the preview and re-runs the checks — the block clears when they pass.</div>' : ''}
        ${failing ? AppView._recheckBtnHtml(pr) : ''}
      </div>`;
  },

  // Platform-variables check row. Only ever renders for a proposal that
  // touches the platform's own `platform_env` declarations — for every
  // other proposal platform_env_state is 'skipped' or NULL and this is a
  // no-op, which is why it can sit unconditionally in the checks card.
  //
  // 'passing' renders nothing when the proposal added no variables: a
  // green line saying "adds no environment variables" on every PR would
  // be noise. It DOES render when variables were added and are all set,
  // because "the new variable is configured" is worth confirming before
  // you vote to deploy it.
  _platformEnvDetailHtml(pr) {
    if (!pr) return '';
    const state = pr.platform_env_state;
    if (!state || state === 'skipped') return '';
    const detail = pr.platform_env_detail || {};
    const added = Array.isArray(detail.added) ? detail.added : [];
    const missing = Array.isArray(detail.missing) ? detail.missing : [];

    if (state === 'error') {
      return `
        <div class="mt-2 rounded border border-zinc-300/40 dark:border-zinc-700/60 bg-zinc-500/5 px-2 py-1.5 text-zinc-600 dark:text-zinc-400">
          <div class="font-medium">Platform variables couldn't be checked.</div>
          <div class="mt-0.5 opacity-90">This does not block the merge — the check is re-run when votes reach the threshold.</div>
        </div>`;
    }

    if (state === 'failing') {
      const items = missing.map((m) => {
        const key = escapeHtml(String((m && m.key) || ''));
        const desc = (m && m.description)
          ? ` <span class="opacity-80">— ${escapeHtml(String(m.description).slice(0, 240))}</span>`
          : '';
        return `<li><code class="font-mono">${key}</code>${desc}</li>`;
      }).join('');
      // The panel that fixes this lives on THIS app (the card only ever
      // renders for a self-app proposal), so open it in place rather than
      // sending anyone off to a deep link. A full admin sets the value
      // outright; everyone else opens a proposal from the same panel.
      const fixLabel = App.user && App.user.canAdminWrite ? 'Set them now' : 'Propose a value';
      return `
        <div class="mt-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-amber-600 dark:text-amber-500">
          <div class="font-medium">⚠ New platform variables have no value set — merge is blocked.</div>
          <ul class="mt-1 ml-4 list-disc space-y-0.5">${items}</ul>
          <div class="mt-1 opacity-90">Deploying without ${missing.length === 1 ? 'it' : 'them'} would restart the platform missing configuration it now expects.</div>
          <div class="mt-1 opacity-80">No rebuild needed — set the value${missing.length === 1 ? '' : 's'} and vote again.</div>
          <button type="button" class="mt-1.5 text-xs px-2 py-1 rounded border border-amber-500/50 hover:bg-amber-500/10 transition-colors" onclick="AppView.openPlatformVariables()">${fixLabel}</button>
        </div>`;
    }

    if (!added.length) return '';
    const list = added.map((k) => `<code class="font-mono">${escapeHtml(String(k))}</code>`).join(', ');
    // Keys whose value THIS proposal carries (the panel's "+ New variable"
    // flow) read differently from keys somebody set separately: the value
    // is part of what a voter is approving, and it lands on merge.
    const carried = Array.isArray(detail.pendingValues) ? detail.pendingValues : [];
    const carriedList = carried.map((k) => `<code class="font-mono">${escapeHtml(String(k))}</code>`).join(', ');
    return `
      <div class="mt-2 rounded border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5 text-emerald-600 dark:text-emerald-500">
        <div class="font-medium">✓ New platform variables are configured.</div>
        <div class="mt-0.5 opacity-90">This proposal adds ${list}, already set and ready for the deploy.</div>
        ${carried.length ? `<div class="mt-0.5 opacity-90">${carriedList} ${carried.length === 1 ? 'carries its value' : 'carry their values'} with this proposal — applied when it merges.</div>` : ''}
      </div>`;
  },

  // Open the Platform variables panel from the blocked-merge note above.
  // The note only ever renders on a self-app proposal, so "the current app"
  // is already the platform — no navigation, no deep link that a
  // non-admin would land on and find empty.
  openPlatformVariables() {
    if (window.Secrets) Secrets.openForCurrentApp();
  },

  // #607: is an in-progress checks run old enough to count as stuck? A
  // fresh run keeps the quiet spinner; past the window (mirrors the
  // server's CHECKS_STALE_MS default) the detail offers the manual re-run
  // escape hatch. A missing/unparseable timestamp counts as stale so a
  // row with no bookkeeping is never left without a way out.
  CHECKS_STALE_CLIENT_MS: 10 * 60 * 1000,
  _checksRunStale(ts) {
    if (!ts) return true;
    const t = new Date(ts).getTime();
    return !Number.isFinite(t) || (Date.now() - t) > AppView.CHECKS_STALE_CLIENT_MS;
  },

  // Copy for the two stages a 'pending' checks run can be in
  // (chat_sessions.check_phase). The build half is where the long wait
  // actually lives — the platform's own preview has to clone its database —
  // so saying which half is running is the difference between "this is
  // progressing" and "this looks stuck". Anything unrecognised, including
  // NULL on rows checked before the column existed, falls back to the
  // wording this block had before, so no legacy proposal changes.
  CHECKS_PHASE_COPY: {
    building: {
      title: 'Preparing the staging preview…',
      detail: 'The change is being built and a preview copy of the app’s data is being made.',
    },
    testing: {
      title: 'Running the automated tests…',
      detail: 'The preview is up and the automated tests are running against it.',
    },
  },

  _checksPhaseCopy(phase) {
    return AppView.CHECKS_PHASE_COPY[phase] || {
      title: 'Checks are still running…',
      detail: 'The staging build is being tested.',
    };
  },

  // #447: the "Re-run checks" action. Renders for the proposal's owner or an
  // admin when the checks are stuck running, couldn't run, were never
  // recorded, or are failing — never for a clean 'passing' run. Hitting it
  // rebuilds the staging preview if it's gone and re-runs the test suite; the
  // badge updates in place off the existing checks broadcasts.
  _recheckBtnHtml(pr) {
    if (!pr) return '';
    if (AppView.readOnly) return '';
    if (pr.check_state === 'passing') return '';
    const owner = !!(App.user && pr.user_id === App.user.id);
    // `recheckable` is a staging ?demo=1 hint (set only on mock rows) so the
    // button is reviewable regardless of the demo viewer's owner/admin status;
    // real proposals never carry it and stay owner/admin-only.
    if (!owner && !App.user?.isAdmin && !pr.recheckable) return '';
    // #607: a WS/poll-driven re-render mid-request must not resurrect an
    // enabled button — keep it disabled while the request is in flight.
    if (AppView._recheckInFlight.has(pr.id)) {
      return `<button type="button" class="gc-vote-btn mt-1" disabled>Re-running…</button>`;
    }
    return `<button type="button" class="gc-vote-btn mt-1" title="Rebuild the staging preview if needed and re-run the automated tests" onclick="AppView.castRecheck(${pr.id}, this)">Re-run checks</button>`;
  },

  // POST /api/sessions/:id/recheck (owner/admin). Fire-and-forget on the
  // server; progress arrives via the checks_ready / staging_ready broadcasts
  // that drive refreshDevData, so we just disable the button transiently.
  _recheckInFlight: new Set(),
  async castRecheck(sessionId, btn) {
    if (AppView._recheckInFlight.has(sessionId)) return;
    AppView._recheckInFlight.add(sessionId);
    if (btn) { btn.disabled = true; btn.textContent = 'Re-running…'; }
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/recheck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        PlatformUI.toast(data.error || `Re-run failed (HTTP ${resp.status}).`);
        if (btn) { btn.disabled = false; btn.textContent = 'Re-run checks'; }
        return;
      }
      const data = await resp.json().catch(() => ({}));
      // Rechecks can't run inside a staging preview of the platform itself.
      if (data.status === 'unavailable') {
        PlatformUI.toast('Re-running checks is unavailable in this preview.');
        if (btn) { btn.disabled = false; btn.textContent = 'Re-run checks'; }
        return;
      }
      // #607: the server stamped 'pending' before responding — refresh so
      // the spinning "Checks running…" badge renders immediately (the WS
      // pending broadcast covers everyone else's screens).
      AppView.refreshDevData('recheck');
    } catch (err) {
      PlatformUI.toast(`Re-run failed: ${err.message}`);
      if (btn) { btn.disabled = false; btn.textContent = 'Re-run checks'; }
    } finally {
      AppView._recheckInFlight.delete(sessionId);
    }
  },

  // #381: expanded console-error detail for the proposal detail screen.
  // Lists the error messages the staging preview's headless browser
  // captured, when it last ran, and the standing remediation (push a fix
  // → rebuild → the check re-runs and clears the warning). Only renders for
  // the 'errors' state; clean/unknown proposals show nothing (the absence
  // of a badge is enough). Advisory — no vote/merge implications.
  _consoleCheckDetailHtml(pr) {
    if (!pr || pr.console_check_state !== 'errors') return '';
    const errors = Array.isArray(pr.console_errors) ? pr.console_errors : [];
    const items = errors.map((e) => {
      const msg = escapeHtml(String((e && e.message) || '').slice(0, 500));
      const src = (e && e.source) ? escapeHtml(String(e.source).slice(0, 200)) : '';
      const kind = (e && e.kind) ? escapeHtml(String(e.kind)) : 'console';
      return `<li class="font-mono text-[0.7rem] break-all"><span class="opacity-70">[${kind}]</span> ${msg}${src ? ` <span class="opacity-60">(${src})</span>` : ''}</li>`;
    }).join('');
    const list = items
      ? `<ul class="mt-1 ml-3 list-disc space-y-0.5">${items}</ul>`
      : '<div class="mt-1">Console errors were detected on the staging preview.</div>';
    const checked = pr.console_checked_at
      ? `<div class="mt-1 opacity-80">Last checked ${escapeHtml(relTime(pr.console_checked_at))}.</div>`
      : '';
    return `
      <div class="mt-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-amber-600 dark:text-amber-500">
        <div class="font-medium">⚠ This change may break the app.</div>
        <div class="mt-0.5 opacity-90">The staging preview logged these console errors when it loaded:</div>
        ${list}
        ${checked}
        <div class="mt-1 opacity-80">Pushing a fix rebuilds the preview and re-runs the check — the warning clears if the errors are gone.</div>
      </div>`;
  },

  // #361: expanded merge-conflict detail for the proposal detail screen.
  // Lists the conflicting file paths and when the snapshot was last
  // checked, plus the standing guidance to run "Sync with main" from the
  // session's dev-chat.
  // #386: renders for the 'failed' state — an auto-resolve attempt actually
  // ran and could not fix the conflict — and (since the silent-merge-failure
  // fix) for 'conflict': a real merge attempt 405'd at GitHub. 'conflict'
  // matters because the auto-resolver only picks up vote-eligible proposals,
  // so a failed merge can otherwise sit with no visible record of the
  // attempt and nothing telling anyone who has to act. While the resolver
  // IS actively working the card shows "Resolving conflicts…" instead
  // (the 'resolving' state outranks both in MergeStatus.lifecycle).
  _mergeConflictDetailHtml(pr) {
    const mcs = pr.merge_conflict_state;
    if (mcs !== 'failed' && mcs !== 'conflict') return '';
    if (pr.resolving) return '';
    const files = Array.isArray(pr.conflict_files) ? pr.conflict_files : [];
    const heading = mcs === 'failed'
      ? 'Automatic conflict resolution failed.'
      : 'A merge was attempted, but this proposal conflicts with main.';
    const fileList = files.length
      ? `<div class="mt-1">Conflicting files:</div>
         <ul class="mt-0.5 ml-3 list-disc space-y-0.5">${files.map((f) =>
           `<li class="font-mono text-[0.7rem] break-all">${escapeHtml(String(f))}</li>`).join('')}</ul>`
      : '';
    const checked = pr.conflict_checked_at
      ? `<div class="mt-1 opacity-80">Last attempt ${escapeHtml(relTime(pr.conflict_checked_at))}.</div>`
      : '';
    const creator = pr.username ? `<span class="font-medium">${escapeHtml(pr.username)}</span>` : 'the proposal\u2019s creator';
    const guidance = mcs === 'failed'
      ? `${creator} needs to resolve it: run "Sync with main" from the session's dev-chat.`
      : `Automatic resolution may not run for this proposal — ${creator} needs to finish the merge: open the session's dev-chat and run "Sync with main".`;
    return `
      <div class="mt-2 rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-red-500">
        <div class="font-medium">${heading}</div>
        ${fileList}
        ${checked}
        <div class="mt-1 opacity-80">${guidance}</div>
      </div>`;
  },

  // ── Governance "being applied" state (#1010) ─────────────────────────
  //
  // A deciding up-vote on a governance proposal runs the whole apply inside
  // the vote request — for a close_issue that's a GitHub close + comment,
  // 2–5s in production and longer when GitHub is slow. The card used to
  // change in NO way for that entire window: buttons stayed live, the tally
  // stayed pre-vote, then the row silently vanished into Done. This is the
  // spinner that fills that gap.
  //
  // Two sources feed one descriptor, checked in this order:
  //   1. _govApplying — the LOCAL, per-actor state, set the instant the
  //      deciding vote is posted (before awaiting the fetch), so the voter
  //      sees the spinner for the full round-trip. Always wins.
  //   2. _derivedGovApplying — computed from the gate fields every viewer
  //      already receives, so OTHER clients (and the actor after a reload)
  //      see the same state without any persisted marker.
  //
  // Kept in a plain object rather than patched into the DOM because the
  // Dev feed re-renders wholesale on every WS event / checks poll — a
  // DOM-patched spinner would be wiped by the next unrelated refresh.
  _govApplying: Object.create(null),
  _govApplyTimers: Object.create(null),
  // First time THIS client saw a row in its due-but-open state, for rows the
  // server gives no window end to anchor on (see _derivedGovApplying).
  _govDueSince: Object.create(null),

  // How long a local apply may run before the copy softens to "still
  // working" (SLOW) and before the spinner gives up entirely (STALLED).
  // STALLED is a safety net for a response that never arrives at all —
  // aborting the fetch wouldn't stop the server-side apply, so we stop
  // spinning and tell the viewer to refresh instead of lying forever.
  GOV_APPLY_SLOW_MS: 12000,
  GOV_APPLY_STALLED_MS: 60000,
  // How long past a merge window's end the DERIVED state still reads as
  // "actively closing". The governance-apply ticker runs every ~60s, so a
  // healthy apply lands well inside this; past it something is wrong
  // (GitHub unreachable) and the calmer "will retry automatically" copy is
  // the honest one.
  GOV_APPLY_DERIVED_GRACE_MS: 120000,

  // Per-kind status copy. The verb has to name the actual side effect —
  // "Applying…" tells a voter nothing about whether their issue is closing.
  _govApplyLabel(kind, targetIssueNumber) {
    if (kind === 'close_issue') {
      return targetIssueNumber
        ? `Closing issue #${targetIssueNumber}…`
        : 'Closing issue…';
    }
    if (kind === 'secret_change') return 'Applying env-var change…';
    if (kind === 'rename') return 'Renaming app…';
    if (kind === 'maintenance_campaign') return 'Starting campaign…';
    return 'Applying…';
  },

  // The local (actor-side) descriptor for one proposal, or null.
  _localGovApplying(issue) {
    const st = issue && AppView._govApplying[issue.id];
    if (!st) return null;
    const label = AppView._govApplyLabel(st.kind, st.targetIssueNumber);
    if (st.phase === 'failed') {
      return {
        spinner: false, tone: 'amber', busy: false,
        label: st.kind === 'close_issue'
          ? 'Close didn\'t complete — try voting again'
          : 'Didn\'t complete — try voting again',
        title: st.error
          ? `The apply didn't finish: ${st.error}`
          : 'The apply didn\'t finish. Voting again re-drives it.',
      };
    }
    if (st.phase === 'stalled') {
      return {
        spinner: false, tone: 'amber', busy: false,
        label: st.kind === 'close_issue'
          ? 'Still closing — refresh to check'
          : 'Still applying — refresh to check',
        title: 'This is taking much longer than usual. The apply may still '
          + 'be running on the server — refresh to see where it landed.',
      };
    }
    if (st.phase === 'slow') {
      return {
        spinner: true, tone: 'amber', busy: true,
        label: `${label.replace(/…$/, '')} — still working, GitHub may be slow…`,
        title: 'Still working. GitHub can be slow to accept the close; '
          + 'nothing is lost while this runs.',
      };
    }
    return {
      spinner: true, tone: 'amber', busy: true, label,
      title: issue.kind === 'close_issue'
        ? 'The vote passed — the issue is being closed here and on GitHub.'
        : 'The vote passed — this change is being applied.',
    };
  },

  // The DERIVED descriptor: what every viewer can infer from the gate
  // fields the /issues serializer already sends. True when the proposal has
  // passed and its clock has run out, yet the row is still open — i.e. the
  // apply is due or in flight.
  //
  // The locked-app suppression is load-bearing: on a locked app a
  // threshold-met proposal legitimately waits for an admin's Yes, which
  // this client cannot verify, so it would otherwise show a spinner for a
  // proposal that is not being applied at all. The locked notice above the
  // list already explains that wait.
  _derivedGovApplying(issue) {
    if (!issue || issue.status !== 'open') return null;
    const ctx = AppView._proposalsCtx || {};
    if (ctx.locked || issue.contested) {
      delete AppView._govDueSince[issue.id];
      return null;
    }

    const yes = issue.qualified_yes_count != null
      ? (parseInt(issue.qualified_yes_count, 10) || 0)
      : (parseInt(issue.up_count, 10) || 0);
    // "At least N" mode is clock-free, so its own target is the gate.
    const atLeast = issue.approvals_required != null
      ? (parseInt(issue.approvals_required, 10) || 1) : null;
    const required = atLeast != null
      ? atLeast
      : (parseInt(issue.votes_required, 10) || 0);
    if (!(required > 0) || yes < required) {
      delete AppView._govDueSince[issue.id];
      return null;
    }

    const endsMs = issue.merge_window_ends_at
      ? Date.parse(issue.merge_window_ends_at) : NaN;
    // A window still running means the countdown pill owns this row.
    if (Number.isFinite(endsMs) && endsMs > Date.now()) {
      delete AppView._govDueSince[issue.id];
      return null;
    }

    const label = AppView._govApplyLabel(
      issue.kind, issue.payload && issue.payload.issueNumber
    );
    // Past the grace window the spinner would be a promise nothing is
    // keeping — degrade to the retry copy instead of spinning forever.
    //
    // The window's end is the natural anchor, but it can be absent: a clear
    // majority collapses the window to zero, and at-least-N mode has no clock
    // at all. Those rows are due RIGHT NOW, so with no anchor they would spin
    // forever if the apply kept failing (GitHub unreachable). Fall back to
    // when THIS client first saw the row in its due state — bounded in every
    // regime, and a reload simply grants a fresh grace period, which is the
    // same generosity any other viewer's first load gets.
    let elapsed;
    if (Number.isFinite(endsMs)) {
      elapsed = Date.now() - endsMs;
    } else {
      if (!AppView._govDueSince[issue.id]) AppView._govDueSince[issue.id] = Date.now();
      elapsed = Date.now() - AppView._govDueSince[issue.id];
    }
    if (elapsed > AppView.GOV_APPLY_DERIVED_GRACE_MS) {
      return {
        spinner: false, tone: 'neutral', busy: false,
        label: issue.kind === 'close_issue'
          ? 'Close pending — will retry automatically'
          : 'Apply pending — will retry automatically',
        title: 'The vote passed, but the change hasn\'t gone through yet. '
          + 'The platform retries automatically.',
      };
    }
    return {
      spinner: true, tone: 'amber', busy: true, label,
      title: issue.kind === 'close_issue'
        ? 'The vote passed — the issue is being closed here and on GitHub.'
        : 'The vote passed — this change is being applied.',
    };
  },

  // One descriptor per row, local state winning over derived.
  _govApplyState(issue) {
    return AppView._localGovApplying(issue) || AppView._derivedGovApplying(issue);
  },

  // Same slot + treatment as the proposal card's "Merging…" badge, so an
  // applying governance row reads identically to an in-flight merge.
  _govApplyBadgeHtml(state) {
    if (!state || !state.label) return '';
    const cls = state.tone === 'neutral'
      ? 'gc-merging-badge gc-checks-running-badge' : 'gc-merging-badge';
    const spin = state.spinner
      ? '<span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>'
      : '';
    const title = state.title ? ` title="${escapeAttr(state.title)}"` : '';
    return `<span class="${cls}"${title}>${spin}${escapeHtml(state.label)}</span>`;
  },

  // Mark a proposal as locally applying and paint it immediately. Timers
  // soften the copy rather than cancelling anything — the server-side apply
  // runs to completion regardless of what this client does.
  _beginGovApply(issue, vote) {
    if (!issue) return false;
    AppView._govApplying[issue.id] = {
      kind: issue.kind,
      targetIssueNumber: (issue.payload && issue.payload.issueNumber) || null,
      startedAt: Date.now(),
      phase: 'applying',
      vote,
    };
    AppView._clearGovApplyTimers(issue.id);
    AppView._govApplyTimers[issue.id] = {
      slow: setTimeout(() => {
        const st = AppView._govApplying[issue.id];
        if (st && st.phase === 'applying') { st.phase = 'slow'; AppView._repaintCards(); }
      }, AppView.GOV_APPLY_SLOW_MS),
      stalled: setTimeout(() => {
        const st = AppView._govApplying[issue.id];
        if (st && (st.phase === 'applying' || st.phase === 'slow')) {
          st.phase = 'stalled';
          AppView._repaintCards();
        }
      }, AppView.GOV_APPLY_STALLED_MS),
    };
    AppView._repaintCards();
    return true;
  },

  _clearGovApplyTimers(issueId) {
    const t = AppView._govApplyTimers[issueId];
    if (!t) return;
    clearTimeout(t.slow);
    clearTimeout(t.stalled);
    delete AppView._govApplyTimers[issueId];
  },

  // Clear the local state (the normal ending), or park it on a terminal
  // phase so the failure stays legible until the next refresh replaces the
  // row. Either way the timers go.
  _endGovApply(issueId, phase, error) {
    AppView._clearGovApplyTimers(issueId);
    if (phase && AppView._govApplying[issueId]) {
      AppView._govApplying[issueId].phase = phase;
      if (error) AppView._govApplying[issueId].error = error;
    } else {
      delete AppView._govApplying[issueId];
    }
    AppView._repaintCards();
  },

  // Would casting `vote` on this row be the vote that DECIDES it? Mirrors
  // the server's gate (governedGate + the locked-app admin-Yes rule) closely
  // enough to choose the copy; a wrong guess is self-correcting — a false
  // positive clears on the response's gate fields, a false negative picks
  // the spinner up from the derived state on the next refresh.
  _govVoteWouldDecide(issue, vote) {
    if (!issue || vote !== 'up' || issue.status !== 'open') return false;
    const ctx = AppView._proposalsCtx || {};
    if (ctx.locked) return false;
    if (issue.contested) return false;
    const yes = issue.qualified_yes_count != null
      ? (parseInt(issue.qualified_yes_count, 10) || 0)
      : (parseInt(issue.up_count, 10) || 0);
    // Re-casting an existing Yes adds nothing; a switch from No does.
    const next = issue.my_vote === 'up' ? yes : yes + 1;
    const atLeast = issue.approvals_required != null
      ? (parseInt(issue.approvals_required, 10) || 1) : null;
    const required = atLeast != null
      ? atLeast : (parseInt(issue.votes_required, 10) || 0);
    if (!(required > 0) || next < required) return false;
    const endsMs = issue.merge_window_ends_at
      ? Date.parse(issue.merge_window_ends_at) : NaN;
    // A window still running means the apply is deferred, not immediate.
    if (Number.isFinite(endsMs) && endsMs > Date.now()) return false;
    return true;
  },

  // One governance card (env-var change, or a legacy rename row still
  // open from before renames moved to dapp.json PRs). Up/down controls
  // post to the existing /api/issues/:id/vote.
  _renderGovCard(issue, opts) {
    const noNav = !!(opts && opts.noNav);
    const ctx = AppView._proposalsCtx || {};
    const majority = ctx.majority || 1;
    const upCount = parseInt(issue.up_count) || 0;
    const downCount = parseInt(issue.down_count) || 0;
    const isRename = issue.kind === 'rename';
    const isCloseIssue = issue.kind === 'close_issue';
    const titleText = isRename
      ? `Rename to "${(issue.payload && issue.payload.newName) || issue.title}"`
      : isCloseIssue
        ? `Close issue #${(issue.payload && issue.payload.issueNumber) || '?'}: "${(issue.payload && issue.payload.issueTitle) || issue.title}"`
        : issue.title;
    // A settled (applied/closed) governance row — a close-issue proposal
    // opened from the Completed list. The vote is history: no Yes/No/
    // admin/withdraw controls, no countdown; the pill is a snapshot.
    const settled = !!issue.status && issue.status !== 'open';
    const applied = !!(issue.payload && issue.payload.appliedAt);
    const metaParts = ['Governance proposal'];
    if (issue.created_by_username) metaParts.push(escapeHtml(issue.created_by_username));
    if (issue.created_at) metaParts.push(escapeHtml(relTime(issue.created_at)));
    if (settled && applied) {
      const how = String(issue.payload.appliedBy || '').startsWith('admin:')
        ? 'closed by admin' : 'closed by vote';
      metaParts.push(escapeHtml(`${how} ${relTime(issue.payload.appliedAt)}`));
    }
    // The governance row is shaped into the same fields statusPillState
    // reads, so a rename / secret-change / close-issue proposal gets the
    // identical pill (dynamic denominator, countdown, needs-your-vote,
    // contested) a PR does. Settled rows pass status 'merged' with the
    // threshold captured at apply time, which keeps the pill clock-free.
    const pillRow = settled
      ? {
        status: 'merged',
        yes_count: upCount,
        no_count: downCount,
        votes_required: (issue.payload && issue.payload.required != null)
          ? issue.payload.required : issue.votes_required,
      }
      : {
        status: 'promoted',
        yes_count: upCount,
        no_count: downCount,
        my_vote: issue.my_vote,
        votes_required: issue.votes_required,
        merge_window_ends_at: issue.merge_window_ends_at,
        reject_window_ends_at: issue.reject_window_ends_at,
        rejection_armed: issue.rejection_armed,
        contested: issue.contested,
        // #695: qualifying (approver-only) tallies + policy so invited apps
        // get the approver-only headline and the advisory suffix.
        qualified_yes_count: issue.qualified_yes_count,
        qualified_no_count: issue.qualified_no_count,
        approval_policy: issue.approval_policy,
        approvals_required: issue.approvals_required,
      };
    const statusPill = AppView.statusPillHtml(pillRow, { majority, kind: 'gov', inline: noNav });

    // #621: read-only viewers see the pill only — no vote / admin /
    // withdraw controls. Settled rows show none for anyone.
    const ro = AppView.readOnly || settled;
    // #1010: the "being applied" state. Rendered for read-only viewers too —
    // it is status, not an action. While it's up the controls stay in place
    // but go `disabled`, rather than being dropped: the row must not reflow
    // under the cursor mid-apply, and a second Yes click would otherwise hit
    // the server's toggle-off branch and silently retract the vote.
    const applyState = settled ? null : AppView._govApplyState(issue);
    const busy = !!(applyState && applyState.busy);
    const applyBadge = AppView._govApplyBadgeHtml(applyState);
    const busyAttr = busy
      ? ` disabled title="${escapeAttr(applyState.label)}"` : '';
    const upT = AppView._voteBtnTally(issue.qualified_yes_count, upCount, issue.approval_policy, 'Yes');
    const downT = AppView._voteBtnTally(issue.qualified_no_count, downCount, issue.approval_policy, 'No');
    const primary = ro ? [] : [
      `<button class="gc-vote-btn gc-vote-btn-yes${issue.my_vote === 'up' ? ' gc-vote-active' : ''}"${busy ? busyAttr : upT.title} onclick="AppView.castIssueVote(${issue.id}, 'up')">Yes (${upT.label})</button>`,
      `<button class="gc-vote-btn gc-vote-btn-no${issue.my_vote === 'down' ? ' gc-vote-active' : ''}"${busy ? busyAttr : downT.title} onclick="AppView.castIssueVote(${issue.id}, 'down')">No (${downT.label})</button>`,
    ];

    // Admin merge, View campaign and Withdraw are the demoted three.
    const isCampaign = issue.kind === 'maintenance_campaign';
    const menu = [];
    if (!ro && (issue.kind === 'secret_change' || isCloseIssue || isCampaign) && App.user?.canAdminWrite) {
      menu.push({
        label: 'Admin merge',
        icon: 'merge',
        title: busy ? (applyState.title || applyState.label) : 'Admin: apply this change right now, bypassing the vote majority',
        disabled: busy,
        danger: true,
        act: () => AppView.castIssueAdminApply(issue.id),
      });
    }
    // An applied campaign proposal links to its live dashboard (fan-out
    // progress, per-app PRs, retry, merge-all-green) on /admin. Admin-only:
    // /admin is admin-gated.
    if (isCampaign && issue.payload && issue.payload.campaignId && App.user?.canAdminWrite) {
      menu.push({
        label: 'View campaign',
        icon: 'campaign',
        title: "Open this campaign's per-app progress",
        act: () => window.open(`/admin#campaign-${issue.payload.campaignId}`, '_blank', 'noopener'),
      });
    }
    // mine: the viewer created this governance proposal, so they may
    // withdraw it (creator-scoped POST /api/issues/:id/close).
    if (!ro && !!(App.user && issue.created_by === App.user.id)) {
      menu.push({
        label: 'Withdraw',
        icon: 'withdraw',
        title: busy ? (applyState.title || applyState.label) : 'Withdraw this proposal (removes it from the vote panel)',
        disabled: busy,
        danger: true,
        act: () => AppView.withdrawGovProposal(issue.id),
      });
    }
    const actions = AppView._cardActionsHtml({ primary });

    const govChatN = parseInt(issue.chat_count) || 0;
    // Chat-reference highlighting hook: twins carry github_issue_number;
    // close-issue proposals have no twin, so their TARGET number stands in.
    const refIssueN = issue.github_issue_number
      || (isCloseIssue && issue.payload ? issue.payload.issueNumber : null);

    return `
      <div class="gc-vote-item ${AppView.DEV_CARD_CLS}${noNav ? '' : ` ${AppView.DEV_CARD_HOVER_CLS}`}${busy ? ' opacity-70' : ''}" data-gov-row="${issue.id}"${refIssueN ? ` data-ref-issue="${refIssueN}"` : ''}${noNav ? '' : ' title="Open this proposal\'s discussion"'}>
        ${AppView._devCardIcon('gov')}
        ${AppView._cardContentHtml({
          headlineHtml: AppView._cardHeadlineHtml(escapeHtml(titleText), metaParts.join(' · ')),
          badges: [applyBadge],
          chatCount: govChatN,
          uncapped: noNav,
          pill: noNav ? '' : statusPill,
          inlinePill: noNav ? statusPill : '',
          actions,
        })}
        ${AppView._cardRailHtml(`gov:${issue.id}`, menu, { chevron: !noNav })}
      </div>`;
  },

  // Who voted yes/no on a PR proposal (GET /api/sessions/:id/votes),
  // painted into the expanded card.
  async _loadVoteRoster(sessionId) {
    const el = document.getElementById(`dev-vote-roster-${sessionId}`);
    if (!el) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/votes`);
      if (!res.ok) { el.textContent = ''; return; }
      const data = await res.json();
      const ctx = AppView._proposalsCtx || {};
      // #646: on invited-approver apps the endpoint lists which voters'
      // votes QUALIFY — tag those names so advisory votes are legible.
      const approverSet = new Set(data.approvers || []);
      const fmt = (arr) => (arr && arr.length
        ? arr.map((u) => '@' + u + (approverSet.has(u) ? '&nbsp;✓' : '')).join(', ')
        : '—');
      // #695: on invited apps the headline count splits into approver
      // votes (✓, the ones that count) + the advisory surplus; under the
      // default policy it stays the plain total.
      const rosterCount = (arr) => {
        const names = arr || [];
        if (!data.approvers) return `(${names.length})`;
        const q = names.filter((u) => approverSet.has(u)).length;
        const a = names.length - q;
        return a > 0 ? `(${q}✓ + ${a} advisory)` : `(${q}✓)`;
      };
      const pr = (AppView._proposals || []).find((p) => p.id === sessionId) || {};
      const needs = pr.approvals_required != null
        ? ` · needs at least ${pr.approvals_required} approval${pr.approvals_required === 1 ? '' : 's'}${data.approvers ? ' from invited approvers (✓)' : ''}`
        : (data.approvers
          ? ` · only invited approvers' (✓) votes count`
          : ` · needs ${ctx.majority || 1} of ${ctx.activeUsers || 1} active users`);
      el.innerHTML =
        `<span class="text-emerald-500 font-medium">Yes ${rosterCount(data.yes)}:</span> ${fmt((data.yes || []).map((u) => escapeHtml(u)))}`
        + ` &nbsp;<span class="text-red-400 font-medium">No ${rosterCount(data.no)}:</span> ${fmt((data.no || []).map((u) => escapeHtml(u)))}`
        + `<span class="text-zinc-500">${escapeHtml(needs)}</span>`;
    } catch {
      el.textContent = '';
    }
  },

  // "Create proposal" — proposals are PRs, and PRs come from dev
  // sessions, so this opens a fresh session on the Sessions sub-tab
  // with a one-line hint that promoting the session's PR creates the
  // proposal.
  // "Open session" on a proposal card — jump into the dev session
  // behind the proposal (proposer only; sessions are owner-scoped).
  openProposalSession(sessionId) {
    if (!sessionId) return;
    if (typeof App !== 'undefined' && App.switchTab) {
      App.switchTab('dev', sessionId, 'sessions');
    }
  },

  // Withdraw a live PR proposal straight from its card (proposer-only; the
  // button only renders on your own promoted proposals). A proposal's id is
  // its session id, so this reuses the owner-scoped POST
  // /api/sessions/:id/archive — but with withdraw-flavoured confirm copy,
  // distinct from the dev-sessions strip's "Archive" wording (that surface
  // is about freeing slots, not withdrawing proposals). On success the feed
  // reloads; GET /api/apps/:slug/promoted only returns status IN
  // ('promoted','merging'), so the withdrawn card drops out.
  async withdrawProposal(sessionId) {
    if (!sessionId) return;
    const pr = (AppView._proposals || []).find((p) => p.id === sessionId);
    const prNum = pr ? (pr.pr_number || pr.id) : sessionId;
    const ok = await ConfirmModal.show({
      title: 'Withdraw this proposal?',
      message: `This closes PR #${prNum} and removes it from the vote panel. You can propose it again later.`,
      confirmLabel: 'Withdraw',
      danger: true,
    });
    if (!ok) return;
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/archive`, { method: 'POST' });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        PlatformUI.toast(data.error || `Withdraw failed (HTTP ${resp.status}).`);
        return;
      }
    } catch (err) {
      PlatformUI.toast(`Withdraw failed: ${err.message}`);
      return;
    }
    await AppView._loadDevFeed();
    // _loadDevFeed's repaint no-ops in the opened-topic view (#dev-feed is
    // absent), so the withdrawn proposal card would stay stale there. Repaint
    // the topic head from the freshly-refetched data.
    if (typeof App !== 'undefined' && App.currentSubTab === 'topic'
        && document.getElementById('gc-thread-head')) {
      AppView._renderTopicHead();
    }
  },

  // Withdraw a governance proposal (secret_change / legacy rename) from its
  // card (creator-only; the button only renders when issue.created_by is the
  // viewer). Posts to the creator-gated POST /api/issues/:id/close, which
  // marks the issue closed, posts a withdrawal chat line, and pushes an
  // issue update so open clients drop the card. Gov-worded confirm (no PR
  // mention — governance proposals have no pull request).
  async withdrawGovProposal(issueId) {
    if (!issueId) return;
    const ok = await ConfirmModal.show({
      title: 'Withdraw this proposal?',
      message: 'This removes it from the vote panel and stops the vote. You can propose it again later.',
      confirmLabel: 'Withdraw',
      danger: true,
    });
    if (!ok) return;
    try {
      const resp = await fetch(`/api/issues/${issueId}/close`, { method: 'POST' });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        PlatformUI.toast(data.error || `Withdraw failed (HTTP ${resp.status}).`);
        return;
      }
    } catch (err) {
      PlatformUI.toast(`Withdraw failed: ${err.message}`);
      return;
    }
    await AppView._loadDevFeed();
    // Same as withdrawProposal: refresh the opened-topic card too, since
    // _loadDevFeed's feed repaint no-ops when #dev-feed isn't mounted.
    if (typeof App !== 'undefined' && App.currentSubTab === 'topic'
        && document.getElementById('gc-thread-head')) {
      AppView._renderTopicHead();
    }
  },

  // ── "Propose to close" an issue ──────────────────────────────────────
  // Opens #close-issue-modal (index.html) with an optional reason textarea
  // and files a vote-only close_issue governance proposal via the existing
  // POST /api/apps/:slug/issues route. The plain ConfirmModal isn't used
  // because it has no input support. Modal wiring (cancel / backdrop /
  // submit) lives in app.js next to the rename modal's.
  _closeIssueTarget: null,

  promptCloseIssue(issueNumber) {
    if (!AppView.appData) return;
    const modal = document.getElementById('close-issue-modal');
    const numEl = document.getElementById('close-issue-number');
    const reason = document.getElementById('close-issue-reason');
    const err = document.getElementById('close-issue-error');
    if (!modal || !numEl || !reason) return;

    AppView._closeIssueTarget = issueNumber;
    numEl.textContent = `#${issueNumber}`;
    reason.value = '';
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
    modal.classList.remove('hidden');
    setTimeout(() => reason.focus(), 0);
  },

  closeCloseIssueModal() {
    const modal = document.getElementById('close-issue-modal');
    const reason = document.getElementById('close-issue-reason');
    const err = document.getElementById('close-issue-error');
    if (modal) modal.classList.add('hidden');
    if (reason) reason.value = '';
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
    AppView._closeIssueTarget = null;
  },

  async submitCloseIssue(e) {
    if (e) e.preventDefault();
    const issueNumber = AppView._closeIssueTarget;
    if (!issueNumber || !AppView.appData) return;
    const err = document.getElementById('close-issue-error');
    const submitBtn = document.getElementById('close-issue-submit');
    const reason = (document.getElementById('close-issue-reason')?.value || '').trim();
    const showErr = (msg) => {
      if (!err) { PlatformUI.toast(msg); return; }
      err.textContent = msg;
      err.classList.remove('hidden');
    };
    if (submitBtn) submitBtn.disabled = true;
    try {
      const resp = await fetch(`/api/apps/${AppView.appData.slug}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'close_issue',
          payload: { issueNumber, ...(reason ? { reason } : {}) },
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        showErr(data.error || `Proposal failed (HTTP ${resp.status}).`);
        return;
      }
    } catch (fetchErr) {
      showErr(`Proposal failed: ${fetchErr.message}`);
      return;
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
    AppView.closeCloseIssueModal();
    await AppView._loadDevFeed();
    // Refresh the opened-topic card too (the issue row's button flips to
    // "Close proposed") — _loadDevFeed's repaint no-ops without #dev-feed.
    if (typeof App !== 'undefined' && App.currentSubTab === 'topic'
        && document.getElementById('gc-thread-head')) {
      AppView._renderTopicHead();
    }
  },

  // `opts.pickFlow` (#1049) opens the new session on the development-flow
  // picker even for someone who ticked "remember my option" — they asked
  // for the choice explicitly from the "+" menu, so the saved shortcut is
  // not what they want this time. `opts.flow` skips the question entirely
  // and opens the walkthrough for that agent, which is what the
  // out-of-credits card's "Use Claude Code" / "Use Codex" buttons do.
  async createProposal(opts) {
    if (!AppView.appData || typeof DevChat === 'undefined') return;
    const session = await DevChat.createSession(AppView.appData.slug);
    if (!session) return; // createSession already alerts (cap reached / error)
    AppView._proposalHint = true;
    const pickFlow = !!(opts && opts.pickFlow);
    const flowAgent = (opts && opts.flow) || null;
    if (typeof App !== 'undefined' && App.switchTab) {
      await App.switchTab('dev', session.id, 'sessions');
    }
    // AFTER the switch: opening the session resets the per-session flow
    // state, so the request has to land on the other side of it.
    if ((pickFlow || flowAgent) && DevChat._devFlow) {
      if (flowAgent) {
        DevChat._devFlow.mode = 'wizard';
        DevChat._devFlow.agent = flowAgent;
      } else {
        DevChat._devFlow.forcePicker = true;
      }
      DevChat._devFlowEnsureStatus(true);
      DevChat.renderMessages();
    }
  },

  // Small "💬 N" thread-message badge shared by issue rows and proposal
  // cards. Always rendered (even at 0) so live bumps have a target, but
  // visually hidden until the thread has at least one human message —
  // a sea of gray "💬 0" pills was pure noise.
  _devChatBadge(count) {
    const n = parseInt(count) || 0;
    // .dev-badge owns the geometry; the utility classes only supply the tint.
    return `<span class="dev-chat-badge dev-badge ${n ? 'bg-violet-500/10 text-violet-400' : 'hidden bg-zinc-500/10 text-zinc-500'}" data-count="${n}" title="Messages in this thread">&#128172; ${n}</span>`;
  },

  // ── Community-voted priority + assigned-person chips ─────────────────
  // Two chips per issue / proposal card: the top-voted priority and the
  // top-voted assignee. Clicking a chip opens a dropdown (see _attrInit /
  // _openAttrPopover) to vote for an existing option or suggest a new one.
  // Anyone may vote (including the filer / proposer / yourself); the chip
  // shows whichever value currently leads. A social signal only — no feed
  // re-sort, no notification, no merge-rule impact.
  ATTR_PRIORITY_VALUES: ['low', 'medium', 'high'],

  // Display label + colour classes for a priority value. Mirrors the
  // existing badge palette (zinc/amber/red) used elsewhere on the cards.
  // `cls` is the static two-tone tint (matching the 💬/★/#N pills); `hover`
  // deepens that same tint to /20 on the interactive chip — the exact
  // hover the linked-issue pills use, never a brightness filter.
  _priorityMeta(value) {
    switch (value) {
      case 'high': return { label: 'High', cls: 'bg-red-500/10 text-red-500', hover: 'hover:bg-red-500/20' };
      case 'medium': return { label: 'Medium', cls: 'bg-amber-500/10 text-amber-500', hover: 'hover:bg-amber-500/20' };
      case 'low': return { label: 'Low', cls: 'bg-sky-500/10 text-sky-500', hover: 'hover:bg-sky-500/20' };
      default: return null;
    }
  },

  // #504: the BUILT-IN category vocabulary (mirrors CATEGORY_VALUES in
  // services/topic-attributes.js — keep the two in sync). #780 added
  // per-app CUSTOM categories on top of these; they arrive from the server
  // in _appCategories and list under these six everywhere.
  ATTR_CATEGORY_VALUES: ['feature', 'bug', 'improvement', 'design', 'docs', 'chore'],

  // #780: mirrors MAX_CATEGORY_LEN in services/topic-attributes.js — the
  // input's maxlength, so the server's length rejection is unreachable by
  // typing (paste still hits it and toasts).
  ATTR_CATEGORY_MAX_LEN: 24,

  // #780: the app's full category vocabulary as
  // [{ value, label, custom }] — the six built-ins plus this app's custom
  // options — loaded once per Dev-tab mount and refreshed from any
  // attributes GET/POST that carries `categories`. `null` means "not loaded
  // yet"; every reader falls back to built-ins-only so a failed fetch just
  // degrades to the pre-#780 behaviour instead of blanking the chips.
  _appCategories: null,

  // #780: tint pairs for CUSTOM categories, deliberately in colour families
  // the six built-ins don't use so a custom chip never reads as a built-in
  // one. Picked by a stable string hash (see _categoryTint) so a given
  // category is always the same colour across the board, list and filter.
  CATEGORY_CUSTOM_TINTS: [
    { cls: 'bg-teal-500/10 text-teal-500', hover: 'hover:bg-teal-500/20' },
    { cls: 'bg-cyan-500/10 text-cyan-500', hover: 'hover:bg-cyan-500/20' },
    { cls: 'bg-fuchsia-500/10 text-fuchsia-500', hover: 'hover:bg-fuchsia-500/20' },
    { cls: 'bg-lime-500/10 text-lime-600', hover: 'hover:bg-lime-500/20' },
    { cls: 'bg-indigo-500/10 text-indigo-400', hover: 'hover:bg-indigo-500/20' },
    { cls: 'bg-orange-500/10 text-orange-500', hover: 'hover:bg-orange-500/20' },
  ],

  // Deterministic tint for a custom category slug — the same small string
  // hash _assigneeTint uses, so two different categories generally differ
  // and a given one never changes colour between repaints.
  _categoryTint(slug) {
    const s = String(slug || '');
    let h = 0;
    for (let i = 0; i < s.length; i += 1) {
      h = ((h * 31) + s.charCodeAt(i)) | 0;
    }
    const tints = AppView.CATEGORY_CUSTOM_TINTS;
    return tints[Math.abs(h) % tints.length];
  },

  // Display label + colour classes for a category slug, drawn from the same
  // badge palette family the priority chip / assignee avatars use. `cls` is
  // the static tint; `hover` deepens it to /20 on the interactive chip.
  //
  // #780: unknown (custom) slugs no longer return null — they resolve to
  // their registered label (or a title-cased slug when the vocabulary hasn't
  // loaded) plus a deterministic tint. Callers dereference the result for
  // any non-empty value, so returning null here would throw. `label` is RAW
  // USER INPUT for custom categories — every caller must escapeHtml it.
  _categoryMeta(value) {
    switch (value) {
      case 'feature': return { label: 'Feature', cls: 'bg-emerald-500/10 text-emerald-500', hover: 'hover:bg-emerald-500/20' };
      case 'bug': return { label: 'Bug', cls: 'bg-red-500/10 text-red-500', hover: 'hover:bg-red-500/20' };
      case 'improvement': return { label: 'Improvement', cls: 'bg-sky-500/10 text-sky-500', hover: 'hover:bg-sky-500/20' };
      case 'design': return { label: 'Design', cls: 'bg-violet-500/10 text-violet-400', hover: 'hover:bg-violet-500/20' };
      case 'docs': return { label: 'Docs', cls: 'bg-amber-500/10 text-amber-500', hover: 'hover:bg-amber-500/20' };
      case 'chore': return { label: 'Chore', cls: 'bg-zinc-500/10 text-zinc-500', hover: 'hover:bg-zinc-500/20' };
      default: break;
    }
    if (!value) return null;
    const known = (AppView._appCategories || []).find((c) => c.value === value);
    const slug = String(value);
    const label = (known && known.label) || (slug.charAt(0).toUpperCase() + slug.slice(1));
    const tint = AppView._categoryTint(slug);
    return { label, cls: tint.cls, hover: tint.hover, custom: true };
  },

  // #780: the custom half of the vocabulary, in registry (creation) order.
  // Empty until the vocabulary loads, which is exactly the pre-#780 view.
  _customCategories() {
    return (AppView._appCategories || []).filter((c) => c.custom);
  },

  // #780: adopt a `categories` payload from any attributes GET/POST (or the
  // dedicated vocabulary endpoint) so a category typed just now can be
  // labelled + coloured by the very next repaint. Ignores anything that
  // isn't an array, so a partial/failed response never clears the cache.
  _setAppCategories(categories) {
    if (!Array.isArray(categories)) return;
    AppView._appCategories = categories.filter((c) => c && typeof c.value === 'string');
  },

  // #780: load the app's category vocabulary. Called on Dev-tab mount;
  // failures are swallowed (the UI falls back to built-ins only).
  async _loadAppCategories() {
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug) return;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/topic-categories`);
      if (!res.ok) return;
      const data = await res.json();
      AppView._setAppCategories(data && data.categories);
    } catch { /* built-ins only */ }
  },

  // #489: a small fixed palette of tint pairs (bg /20 + text 600/dark 300)
  // for the assignee initial-avatar, drawn from the same colour family the
  // card badges use so the circles sit consistently in light + dark themes.
  ASSIGNEE_AVATAR_TINTS: [
    'bg-violet-500/20 text-violet-600 dark:text-violet-300',
    'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300',
    'bg-sky-500/20 text-sky-600 dark:text-sky-300',
    'bg-amber-500/20 text-amber-600 dark:text-amber-300',
    'bg-rose-500/20 text-rose-600 dark:text-rose-300',
  ],

  // Deterministic tint for a username — a small stable string hash into the
  // palette above, so a given assignee is ALWAYS the same colour across the
  // board and list (and two different names generally differ).
  _assigneeTint(username) {
    const s = String(username || '');
    let h = 0;
    for (let i = 0; i < s.length; i += 1) {
      h = ((h * 31) + s.charCodeAt(i)) | 0;
    }
    const tints = AppView.ASSIGNEE_AVATAR_TINTS;
    return tints[Math.abs(h) % tints.length];
  },

  // The assignee's initial-avatar: a tiny tinted circle carrying the
  // uppercased first letter of the username. Mirrors the leaderboard's
  // initial-in-a-circle at chip scale (no photo avatars anywhere in the app).
  // Falls back to '?' for an empty/space-leading value.
  _assigneeAvatarHtml(username) {
    const s = String(username || '');
    const initial = (s.trim().charAt(0) || '?').toUpperCase();
    const tint = AppView._assigneeTint(s);
    return `<span class="attr-avatar ${tint}">${escapeHtml(initial)}</span>`;
  },

  // The muted placeholder avatar for an unassigned task — a dashed grey
  // outline circle with no letter.
  _assigneeAvatarPlaceholderHtml() {
    return '<span class="attr-avatar attr-avatar-empty"></span>';
  },

  // One chip. `summary` is { top, count, myValue } as the feed routes
  // attach it. Both the interactive <button> and the read-only (merged)
  // <span> reuse the SAME geometry class every other chip in the badge row
  // uses (.dev-badge — one height, one padding, one radius), with the
  // utility classes supplying only the tint, so a row of them sits on a
  // single baseline. The button-only `.attr-chip` reset strips UA chrome so
  // the button matches the span exactly.
  _attrChipHtml(field, targetType, targetRef, summary, readonly) {
    const s = summary || { top: null, count: 0, myValue: null };
    const count = parseInt(s.count) || 0;
    let label;
    let cls;
    let hover;
    if (field === 'priority') {
      const meta = AppView._priorityMeta(s.top);
      if (meta) { label = `&#9873; ${meta.label}`; cls = meta.cls; hover = meta.hover; }
      else { label = '&#9873; Set priority'; cls = 'bg-zinc-500/10 text-zinc-500'; hover = 'hover:bg-zinc-500/20'; }
    } else if (field === 'category') {
      // #504: lead with a small colour swatch (the same attr-dot used in the
      // popover) so the category reads at a glance, then the label.
      // #780: escapeHtml the label — for a custom category it is user input.
      const meta = AppView._categoryMeta(s.top);
      if (meta) { label = `<span class="attr-dot ${meta.cls}"></span>${escapeHtml(meta.label)}`; cls = meta.cls; hover = meta.hover; }
      else { label = '<span class="attr-dot bg-zinc-500/10 text-zinc-500"></span>Set category'; cls = 'bg-zinc-500/10 text-zinc-500'; hover = 'hover:bg-zinc-500/20'; }
    } else {
      // #489: the assignee now leads with a coloured initial-avatar (an at-a-
      // glance "who owns this") instead of the generic person emoji, and the
      // empty state reads as an explicit "Unassigned" rather than only a CTA.
      if (s.top) {
        label = `${AppView._assigneeAvatarHtml(s.top)}<span class="dev-badge-name">@${escapeHtml(s.top)}</span>`;
        cls = 'bg-violet-500/10 text-violet-400';
        hover = 'hover:bg-violet-500/20';
      } else {
        label = `${AppView._assigneeAvatarPlaceholderHtml()}<span class="dev-badge-name">Unassigned</span>`;
        cls = 'bg-zinc-500/10 text-zinc-500';
        hover = 'hover:bg-zinc-500/20';
      }
    }
    // Faint trailing count, matching how the ★ bounty pill shows its number.
    // No leading space: .dev-badge's flex gap owns the spacing now, and a
    // literal space on top of it read as a gap-and-a-half.
    const countHtml = count > 1 ? `<span class="opacity-60">&middot;${count}</span>` : '';
    const base = 'attr-chip dev-badge';
    let title;
    if (field === 'priority') {
      title = 'Vote on this card\'s priority';
    } else if (field === 'category') {
      title = 'Vote on this card\'s category';
    } else {
      title = s.top ? 'Suggest or vote on who should take this' : 'Assign someone to this task';
    }
    if (readonly) {
      return `<span class="${base} ${cls}">${label}${countHtml}</span>`;
    }
    return `<button type="button" class="${base} ${cls} ${hover}" data-attr-chip data-attr-field="${field}" data-attr-target-type="${targetType}" data-attr-target-ref="${targetRef}" title="${escapeAttr(title)}">${label}${countHtml}</button>`;
  },

  // All three chips for a card, in the badge row. opts.readonly drops the
  // dropdown (used on merged/completed proposals, and forced for
  // read-only viewers — #621).
  //
  // opts.omitUnset — skip a chip whose value nobody has set. This is the
  // BOARD default now: rendering "⚑ Set priority", "Set category" and
  // "Unassigned" on every card meant a brand-new card carried three grey
  // chips of pure noise. The empty-state entry points moved into the card's
  // ⋯ menu ("Set priority…" etc.). The DETAIL view keeps omitUnset off —
  // that page is where metadata gets set, so all three belong there whether
  // or not they carry a value.
  //
  // Returns an ARRAY when opts.asArray is set, so _cardBadgesHtml can apply
  // the badge budget across chips and the status pill together.
  _attrChipsHtml(targetType, targetRef, item, opts) {
    const readonly = !!(opts && opts.readonly) || AppView.readOnly;
    const omitUnset = !!(opts && opts.omitUnset);
    const it = item || {};
    // Order is the badge-priority order: priority, then assignee, then
    // category (who owns it reads before what kind of work it is).
    const fields = [
      ['priority', it.priority],
      ['assignee', it.assignee],
      ['category', it.category],
    ];
    const out = [];
    for (const [field, summary] of fields) {
      if (omitUnset && !(summary && summary.top)) continue;
      out.push(AppView._attrChipHtml(field, targetType, targetRef, summary, readonly));
    }
    return (opts && opts.asArray) ? out : out.join('');
  },

  // The ⋯ descriptors that replace the unset attribute chips: the three
  // "set this for the first time" entry points. Each opens the SAME
  // attribute popover the chip would have, anchored to the menu row.
  // Returns [] for a read-only viewer or a settled/merged card.
  _attrMenuItems(targetType, targetRef, item, opts) {
    if (AppView.readOnly || (opts && opts.readonly)) return [];
    const it = item || {};
    const labels = {
      priority: ['Set priority…', 'Change priority…'],
      category: ['Set category…', 'Change category…'],
      assignee: ['Assign someone…', 'Change assignee…'],
    };
    return ['priority', 'category', 'assignee'].map((field) => {
      const set = !!(it[field] && it[field].top);
      return {
        label: labels[field][set ? 1 : 0],
        // Each field's icon matches the chip it sets, so the row and the
        // chip it produces are recognisably the same thing.
        icon: field,
        title: field === 'assignee'
          ? 'Suggest or vote on who should take this'
          : `Vote on this card's ${field}`,
        act: () => AppView._openAttrMenuPopover(field, targetType, targetRef),
      };
    });
  },

  // Open the attribute popover from a ⋯ menu row rather than from a chip.
  // The popover anchors to whatever chip for the same target is on screen;
  // with no chip rendered (the unset case, which is exactly why this exists)
  // it anchors to the card itself so it still lands beside the right row.
  _openAttrMenuPopover(field, targetType, targetRef) {
    const chip = document.querySelector(
      `[data-attr-chip][data-attr-field="${field}"][data-attr-target-type="${targetType}"][data-attr-target-ref="${targetRef}"]`
    );
    if (chip) { AppView._openAttrPopover(chip); return; }
    // No chip on screen (the unset case — exactly why this path exists), so
    // anchor to the card and hand _openAttrPopover a shim carrying the same
    // dataset it reads off a real chip.
    const card = document.querySelector(
      targetType === 'issue' ? `[data-ref-issue="${targetRef}"]` : `[data-proposal-row="${targetRef}"]`
    );
    if (!card) return;
    AppView._openAttrPopover({
      dataset: { attrField: field, attrTargetType: targetType, attrTargetRef: String(targetRef) },
      getBoundingClientRect: () => card.getBoundingClientRect(),
    });
  },

  // Install the one-time document-level handlers that open / close the
  // chip dropdown. Idempotent — safe to call on every renderDevView.
  _attrInit() {
    if (AppView._attrInited) return;
    AppView._attrInited = true;
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-attr-chip]');
      if (chip) {
        // Don't let the card's open-discussion handler fire.
        e.preventDefault();
        e.stopPropagation();
        AppView._openAttrPopover(chip);
        return;
      }
      // "How voting works" help affordance (topic-head "?" button + the
      // inline "How voting works" link). Both carry data-voting-help and
      // open the same read-only popover for the current topic item.
      const help = e.target.closest('[data-voting-help]');
      if (help) {
        e.preventDefault();
        e.stopPropagation();
        AppView._openVotingHelpPopover(help, AppView._findTopicItem());
        return;
      }
      // A click anywhere outside an open popover closes it.
      if (!e.target.closest('#attr-popover')) AppView._closeAttrPopover();
      if (!e.target.closest('#voting-help-popover')) AppView._closeVotingHelpPopover();
    });
    // Reposition / close on scroll + resize so the popovers never drift
    // away from their anchor.
    window.addEventListener('resize', () => {
      AppView._closeAttrPopover();
      AppView._closeVotingHelpPopover();
    });
    document.addEventListener('scroll', (e) => {
      AppView._closeAttrPopover();
      // Ignore the popover's OWN internal overflow scrolling (it has a
      // capped max-height and scrolls its rules list) — only an
      // outside-page scroll should dismiss it. The scroll event's target
      // is the scrolled element (or `document` for the page itself).
      const t = e.target;
      const insidePopover = t && t.nodeType === 1 && typeof t.closest === 'function'
        && t.closest('#voting-help-popover');
      if (!insidePopover) AppView._closeVotingHelpPopover();
    }, true);
    // Escape dismisses either popover (a11y — the help popover is a dialog).
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        AppView._closeAttrPopover();
        AppView._closeVotingHelpPopover();
      }
    });
  },

  _closeAttrPopover() {
    const el = document.getElementById('attr-popover');
    if (el) el.remove();
    AppView._attrPopover = null;
  },

  // Open the dropdown anchored under `chip`, fetch its full option tally,
  // and render it. Re-clicking the same chip toggles it closed.
  async _openAttrPopover(chip) {
    const field = chip.dataset.attrField;
    const targetType = chip.dataset.attrTargetType;
    const targetRef = parseInt(chip.dataset.attrTargetRef, 10);
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug || !field || !targetType || !targetRef) return;

    // Toggle: clicking the chip that owns the open popover closes it.
    const open = AppView._attrPopover;
    if (open && open.field === field && open.targetType === targetType && open.targetRef === targetRef) {
      AppView._closeAttrPopover();
      return;
    }
    AppView._closeAttrPopover();

    const pop = document.createElement('div');
    pop.id = 'attr-popover';
    pop.className = 'attr-popover';
    pop.innerHTML = '<div class="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">Loading…</div>';
    document.body.appendChild(pop);
    AppView._attrPopover = { field, targetType, targetRef, slug };

    // Position under the chip, clamped to the viewport.
    AppView._positionAttrPopover(pop, chip);

    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/topics/${targetType}/${targetRef}/attributes?field=${field}`);
      if (!res.ok) throw new Error('load failed');
      const data = await res.json();
      // #780: adopt the vocabulary BEFORE rendering so the custom block and
      // its labels/colours paint on this first open.
      AppView._setAppCategories(data && data.categories);
      // The popover may have been closed/replaced while the fetch was in flight.
      if (AppView._attrPopover && AppView._attrPopover.field === field
          && AppView._attrPopover.targetRef === targetRef) {
        AppView._renderAttrPopoverBody(data);
      }
    } catch {
      const live = document.getElementById('attr-popover');
      if (live) live.innerHTML = '<div class="px-3 py-2 text-xs text-red-500">Couldn\'t load options.</div>';
    }
  },

  // Place the popover just under `chip`, clamped to the viewport. Shared
  // by the initial open and the post-repaint re-anchor (#608) so both use
  // the same math.
  _positionAttrPopover(pop, chip) {
    const r = chip.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    const left = Math.min(Math.round(r.left), window.innerWidth - 240);
    pop.style.left = `${Math.max(8, left)}px`;
  },

  // Render the popover contents from a { field, options, myValue } payload
  // and wire its controls. Re-run after each vote so counts/checks update
  // in place without closing the dropdown.
  _renderAttrPopoverBody(data) {
    const pop = document.getElementById('attr-popover');
    if (!pop) return;
    const field = data.field;
    const check = '<svg class="w-3.5 h-3.5 text-violet-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';

    const optRow = (label, value, count, mine) =>
      `<button type="button" class="attr-opt" data-attr-opt-value="${escapeAttr(value)}">
        <span class="attr-opt-label">${label}</span>
        <span class="attr-opt-right">${count ? `<span class="attr-opt-count">${count}</span>` : ''}${mine ? check : ''}</span>
      </button>`;

    let inner = '';
    if (field === 'priority') {
      const byVal = new Map((data.options || []).map((o) => [o.value, o]));
      inner += '<div class="attr-pop-head">Priority</div>';
      for (const v of AppView.ATTR_PRIORITY_VALUES) {
        const o = byVal.get(v);
        const meta = AppView._priorityMeta(v);
        inner += optRow(`<span class="attr-dot ${meta.cls}"></span>${meta.label}`, v, o ? o.count : 0, !!(o && o.mine));
      }
    } else if (field === 'category') {
      // #504: list the fixed category set (like priority), each with its
      // colour swatch, showing counts + the viewer's current check.
      // #780: then the app's CUSTOM options under a divider, and a text box
      // to type a new one. Counts come from this card's tally either way, so
      // an option nobody has voted for here shows 0.
      const byVal = new Map((data.options || []).map((o) => [o.value, o]));
      const catRow = (v) => {
        const o = byVal.get(v);
        const meta = AppView._categoryMeta(v);
        return optRow(
          `<span class="attr-dot ${meta.cls}"></span>${escapeHtml(meta.label)}`,
          v, o ? o.count : 0, !!(o && o.mine)
        );
      };
      inner += '<div class="attr-pop-head">Category</div>';
      for (const v of AppView.ATTR_CATEGORY_VALUES) inner += catRow(v);
      const customs = AppView._customCategories();
      if (customs.length) {
        inner += '<div class="attr-pop-head attr-pop-head-divided">Custom</div>';
        for (const c of customs) inner += catRow(c.value);
      }
      inner += `<div class="attr-pop-add">
        <input type="text" id="attr-category-input" class="attr-pop-input" placeholder="Type a category…" autocomplete="off" maxlength="${AppView.ATTR_CATEGORY_MAX_LEN}" />
        <button type="button" id="attr-category-add" class="attr-pop-addbtn">Add</button>
      </div>`;
    } else {
      inner += '<div class="attr-pop-head">Assigned person</div>';
      const opts = data.options || [];
      if (opts.length) {
        for (const o of opts) {
          inner += optRow(`@${escapeHtml(o.value)}`, o.value, o.count, !!o.mine);
        }
      } else {
        inner += '<div class="px-3 py-1.5 text-xs text-zinc-400 dark:text-zinc-500">No suggestions yet.</div>';
      }
      inner += `<div class="attr-pop-add">
        <input type="text" id="attr-assignee-input" class="attr-pop-input" placeholder="Type a name…" autocomplete="off" maxlength="64" />
        <div id="attr-assignee-suggest" class="attr-pop-suggest hidden"></div>
        <button type="button" id="attr-assignee-add" class="attr-pop-addbtn">Add</button>
      </div>`;
    }

    pop.innerHTML = inner;

    // Vote on an existing option.
    pop.querySelectorAll('.attr-opt').forEach((b) => {
      b.addEventListener('click', () => AppView._castAttrVote(b.dataset.attrOptValue));
    });

    if (field === 'category') {
      // #780: type a new category. No typeahead (unlike assignee) — the
      // options are all listed right above. Before POSTing we fold the typed
      // text onto an option already listed when it matches case-insensitively,
      // so "Bug" votes for the built-in `bug` and "PERFORMANCE" votes for the
      // existing custom option rather than attempting a duplicate.
      const input = pop.querySelector('#attr-category-input');
      const addBtn = pop.querySelector('#attr-category-add');
      const submit = () => {
        const typed = (input.value || '').trim().replace(/\s+/g, ' ');
        if (!typed) return;
        const lower = typed.toLowerCase();
        const known = AppView.ATTR_CATEGORY_VALUES.includes(lower)
          ? lower
          : (AppView._customCategories().find((c) => c.value.toLowerCase() === lower) || {}).value;
        AppView._castAttrVote(known || typed);
      };
      addBtn.addEventListener('click', submit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
      });
      input.focus();
    } else if (field === 'assignee') {
      const input = pop.querySelector('#attr-assignee-input');
      const addBtn = pop.querySelector('#attr-assignee-add');
      const suggest = pop.querySelector('#attr-assignee-suggest');
      const submit = () => {
        const v = (input.value || '').trim();
        if (v) AppView._castAttrVote(v);
      };
      addBtn.addEventListener('click', submit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
      });
      // Username typeahead off /api/users/search (same endpoint the invite
      // typeahead uses). Free text is still allowed — these are hints only.
      input.addEventListener('input', () => {
        const q = (input.value || '').trim();
        clearTimeout(AppView._attrSuggestTimer);
        if (!q) { suggest.classList.add('hidden'); suggest.innerHTML = ''; return; }
        AppView._attrSuggestTimer = setTimeout(async () => {
          try {
            const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
            if (!res.ok) return;
            const { users } = await res.json();
            if (!users || !users.length) { suggest.classList.add('hidden'); suggest.innerHTML = ''; return; }
            suggest.innerHTML = users.map((u) =>
              `<button type="button" class="attr-suggest-item" data-attr-suggest="${escapeAttr(u.username)}">@${escapeHtml(u.username)}</button>`).join('');
            suggest.classList.remove('hidden');
            suggest.querySelectorAll('[data-attr-suggest]').forEach((it) => {
              it.addEventListener('click', () => AppView._castAttrVote(it.dataset.attrSuggest));
            });
          } catch { /* ignore */ }
        }, 200);
      });
      // #600: default the name box to the signed-in user's own username so
      // "assign it to me" is one click of Add — but only when the viewer has
      // no current pick (!data.myValue), so we never quietly overwrite a vote
      // they already made. Setting .value programmatically does NOT fire the
      // `input` listener above, so the typeahead stays closed; select() keeps
      // "assign someone else" a first-keystroke away.
      const me = (typeof App !== 'undefined' && App.user && App.user.username) || '';
      if (me && !data.myValue) {
        input.value = me;
        input.select();
      }
      input.focus();
    }
  },

  // POST the caller's vote for `value`, then repaint the on-card chips and
  // the open popover from the refreshed tally the server returns.
  async _castAttrVote(value) {
    const ctx = AppView._attrPopover;
    if (!ctx || !value) return;
    const { field, targetType, targetRef, slug } = ctx;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/topics/${targetType}/${targetRef}/attributes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { PlatformUI.toast(data.error || 'Could not save your vote.'); return; }
      // #780: adopt the refreshed vocabulary FIRST — a just-typed category
      // has no entry yet, and the chip repaint below needs its label+colour.
      AppView._setAppCategories(data.categories);
      // Update the cached item's summary so re-renders show the new leader.
      AppView._applyAttrSummary(targetType, targetRef, field, data);
      // Repaint whichever card surface is mounted (list / kanban / PM /
      // topic head) and the popover.
      AppView._refreshAttrCards();
      if (AppView._attrPopover && AppView._attrPopover.field === field
          && AppView._attrPopover.targetRef === targetRef) {
        AppView._renderAttrPopoverBody(data);
      }
    } catch (err) {
      PlatformUI.toast(`Could not save your vote: ${err.message}`);
    }
  },

  // Find the cached issue / proposal object a chip refers to and write the
  // new { top, count, myValue } summary onto it. options[0] is the leader
  // (the server sorts the list), so the chip reads straight off it.
  _applyAttrSummary(targetType, targetRef, field, data) {
    const top = (data.options && data.options[0]) || null;
    const summary = { top: top ? top.value : null, count: top ? top.count : 0, myValue: data.myValue || null };
    let item = null;
    if (targetType === 'issue') {
      item = (AppView._ghIssues || []).find((i) => i.number === targetRef);
    } else {
      item = (AppView._proposals || []).find((p) => p.id === targetRef)
        || (AppView._merged || []).find((p) => p.id === targetRef);
    }
    if (item) item[field] = summary;
  },

  // Repaint every surface that shows chips. #608: this used to repaint
  // only #dev-feed / #gc-thread-head / #gc-merged, so in kanban and PM
  // view modes (which mount #dev-kanban-board / #dev-pm instead) a vote
  // updated the cache but the visible chips stayed stale until a reload.
  // _repaintCards is mode-aware (list feed + Completed block, kanban
  // board, PM view, plus the opened-topic head), all from cache. The
  // popover lives on <body>, positioned by coordinates, so the repaint
  // never removes it — but its chip's card can move (PM view regroups by
  // assignee) or leave the board (kanban filter no longer matching), so
  // re-anchor it to the freshly-rendered chip, or close it when the chip
  // is gone.
  _refreshAttrCards() {
    AppView._repaintCards();
    AppView._reanchorAttrPopover();
  },

  // Snap the open popover back under its chip's current position after a
  // repaint; close it when the chip is no longer rendered anywhere.
  _reanchorAttrPopover() {
    const ctx = AppView._attrPopover;
    if (!ctx) return;
    const pop = document.getElementById('attr-popover');
    if (!pop) return;
    const chip = document.querySelector(
      `[data-attr-chip][data-attr-field="${ctx.field}"]`
      + `[data-attr-target-type="${ctx.targetType}"]`
      + `[data-attr-target-ref="${ctx.targetRef}"]`
    );
    if (chip) AppView._positionAttrPopover(pop, chip);
    else AppView._closeAttrPopover();
  },

  // Live badge bump for a thread the viewer doesn't have open (called
  // from GroupChat when a threaded message arrives).
  bumpThreadBadge(type, ref) {
    let sel = null;
    if (type === 'issue') {
      const issue = (AppView._ghIssues || []).find((i) => i.number === ref);
      if (issue) issue.chatCount = (parseInt(issue.chatCount) || 0) + 1;
      sel = `[data-issue-row="${ref}"] .dev-chat-badge`;
    } else if (type === 'session') {
      const pr = (AppView._proposals || []).find((p) => p.id === ref);
      if (pr) pr.chat_count = (parseInt(pr.chat_count) || 0) + 1;
      sel = `[data-proposal-row="${ref}"] .dev-chat-badge`;
    } else if (type === 'governance') {
      // Open proposals live in _govProposals; applied close-issue rows
      // live on in the Completed stream (_merged, row_type='close_issue').
      const g = (AppView._govProposals || []).find((i) => i.id === ref)
        || (AppView._merged || []).find(
          (r) => r.row_type === 'close_issue' && r.id === ref);
      if (g) g.chat_count = (parseInt(g.chat_count) || 0) + 1;
      sel = `[data-gov-row="${ref}"] .dev-chat-badge`;
    }
    const el = sel && document.querySelector(sel);
    if (el) {
      const n = (parseInt(el.dataset.count) || 0) + 1;
      el.dataset.count = String(n);
      el.innerHTML = `&#128172; ${n}`;
      el.classList.remove('hidden', 'bg-zinc-500/10', 'text-zinc-500');
      el.classList.add('bg-violet-500/10', 'text-violet-400');
    }
  },

  // #130/#194: reveal a PR / issue reference (from a chat chip or a
  // notification) — opens the matching full-screen topic view. Falls
  // back to GitHub for PR numbers that aren't resolvable locally.
  revealInDrawer(type, number) {
    const n = parseInt(number, 10);
    if (!n || typeof App === 'undefined') return;

    if (type !== 'pr') {
      // Bare-# chips are issues first. A closed issue won't resolve in
      // the topic view, which falls back to the card list.
      AppView.openTopic('issue', n);
      return;
    }

    const st = AppView.voteState || {};
    const pr = (st.byPrNumber && st.byPrNumber[String(n)])
      || (st.bySession && st.bySession[String(n)]);
    if (pr) {
      // Open, merging, or merged — the topic view handles all three
      // (merged renders with a read-only thread).
      AppView.openTopic('proposal', pr.id);
      return;
    }

    // GitHub fallback — same repo_url normalization as before.
    const repo = AppView.appData && AppView.appData.repo_url;
    if (!repo) return;
    const base = repo.replace(/\.git$/, '').replace(/\/$/, '');
    window.open(`${base}/pull/${n}`, '_blank', 'noopener');
  },

  // #16: undo a merged PR. A single click opens a revert PR (like
  // proposing a change) which then needs the normal merge vote to land —
  // no separate undo-vote gate. Guarded by a ConfirmModal since it's a
  // concrete action (it creates a PR). The revert (clone + git revert +
  // push + PR create) runs server-side in the background and takes a few
  // seconds; the resulting revert PR appears via the WS vote_update
  // broadcast, which refreshes this panel.
  async undoPr(sessionId) {
    const key = `undo:${sessionId}`;
    if (AppView._voteInFlight.has(key)) return;
    const ok = await ConfirmModal.show({
      title: 'Undo this merge?',
      message:
        'This opens a revert PR that backs out this merged change.\n\n'
        + 'It still needs a merge vote to land — undoing is a proposal the group votes on, just like any other change.',
      confirmLabel: 'Open revert PR',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    AppView._voteInFlight.add(key);
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        // 409 means a revert is already in flight, or eligibility was
        // lost between render and click. Show the message and re-fetch
        // so the UI reflects reality.
        PlatformUI.toast(data.error || `Undo failed (HTTP ${resp.status}).`);
      }
      AppView.refreshDevData('vote');
    } catch (err) {
      PlatformUI.toast(`Undo failed: ${err.message}`);
    } finally {
      AppView._voteInFlight.delete(key);
    }
  },

  // Admin force-apply for an env-var (secret_change) proposal: bypass the
  // active-user vote majority and apply the change right now. Gated
  // server-side by /api/issues/:id/admin-apply (admin-only). Mirrors
  // castAdminMerge's ConfirmModal misclick guard — the button sits inline
  // with the regular Yes/No buttons.
  async castIssueAdminApply(issueId) {
    if (!App.user?.isAdmin) return;
    const key = `issue-admin-apply:${issueId}`;
    if (AppView._voteInFlight.has(key)) return;
    // Kind-aware confirm copy: the same route force-applies env-var
    // (secret_change), close-issue, and maintenance-campaign proposals.
    const gov = (AppView._govProposals || []).find((g) => g.id === issueId);
    const isCloseIssue = gov?.kind === 'close_issue';
    const isCampaign = gov?.kind === 'maintenance_campaign';
    const targetN = gov?.payload?.issueNumber;
    const ok = await ConfirmModal.show({
      title: isCloseIssue
        ? `Close issue ${targetN ? `#${targetN} ` : ''}now?`
        : isCampaign
          ? 'Start this maintenance campaign now?'
          : 'Apply this env-var change now?',
      message: (isCloseIssue
        ? 'This bypasses the active-user vote majority and closes the issue right now, here and on GitHub.\n\n'
        : isCampaign
          ? 'This bypasses the platform vote and starts the campaign right now: an AI will open one maintenance PR per app across the fleet.\n\n'
          : 'This bypasses the active-user vote majority and applies the proposed secret change right now (the app redeploys with the new value).\n\n')
        + 'Use only when you\'re confident the change should ship — the override is announced in group chat with your username.',
      confirmLabel: isCloseIssue ? 'Close now' : isCampaign ? 'Start now' : 'Apply now',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    AppView._voteInFlight.add(key);
    try {
      const resp = await fetch(`/api/issues/${issueId}/admin-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        PlatformUI.toast(data.error || `Admin apply failed (HTTP ${resp.status}).`);
      }
      AppView.refreshDevData('vote');
    } catch (err) {
      PlatformUI.toast(`Admin apply failed: ${err.message}`);
    } finally {
      AppView._voteInFlight.delete(key);
    }
  },

  // ---- Open Issues section ------------------------------------------------

  // Auto-solve rank for the feed sort (#177/#227). Lower renders first
  // within the issues group: an in-flight run ('generating') tops the
  // list, a finished run awaiting review ('ready') follows, everything
  // else — no headless session, or defensively any unknown/future
  // status — sorts as a plain issue. 'failed' never reaches the client
  // (the /github-issues query filters to generating/ready), so it lands
  // in the plain bucket too. Ranking happens at render time (not
  // server-side) because the optimistic auto-solve start and the
  // headless poller both mutate `headless` in place and re-render
  // without refetching.
  _headlessRank(issue) {
    const s = issue.headless && issue.headless.status;
    return s === 'generating' ? 0 : s === 'ready' ? 1 : 2;
  },

  // #388: merge-pipeline pin rank for the feed sort. Lower renders first
  // within the proposal group, so a PR actually being merged (or having
  // its conflicts resolved) surfaces at the top of the stack instead of
  // sinking under proposals with newer chatter — "it's obvious it's the
  // next one to merge". The precedence deliberately matches the card's
  // state-badge precedence (#361/#386: merging > resolving > failed) so
  // the list position always agrees with the badge the user sees:
  //   0 — 'merging'  ("Merging…")            being merged right now
  //   1 — resolving  ("Resolving conflicts…")  auto-resolver sync in flight
  //   2 — merge_conflict_state 'failed' ("⚠ Conflict resolution failed") or
  //       'conflict' ("⚠ Merge failed — conflict"): a real attempt failed
  //       and the auto-resolver may never pick it up (it only touches
  //       vote-eligible proposals), so the card must stay visible until the
  //       creator finishes the merge.
  //   3 — everything else (normal, by recency)
  // A bare 'behind' snapshot is NOT pinned: it renders as the neutral
  // "Behind main · N" badge, and many PRs can be behind main.
  _proposalPinRank(pr) {
    if (!pr) return 4;
    if (pr.status === 'merging') return 0;
    if (pr.resolving) return 1;
    if (pr.merge_conflict_state === 'failed' || pr.merge_conflict_state === 'conflict') return 2;
    // #47: a proposal whose checks failed / couldn't run blocks merge and
    // needs the owner's attention — pin it just below the conflict-failed
    // affordance so it stays visible above ordinary chatter.
    if (pr.check_state === 'failing' || pr.check_state === 'error') return 3;
    return 4;
  },

  // The Open Issues list exactly as rendered: env-var-proposal twins
  // filtered out (#131 — those rows render in the dedicated Environment
  // variables section). Ordering is owned by _feedItems(), whose
  // comparator folds in the auto-solve rank (_headlessRank) ahead of
  // recency. The filter runs on a copy, so _ghIssues itself keeps the
  // canonical fetch order (GitHub updated-desc). The feed renderer and
  // the open-card index lookup must both use this helper so paging
  // counts match what's on screen.
  _visibleGhIssues() {
    return (AppView._ghIssues || [])
      .filter((i) => !(AppView._envIssueNumbers && AppView._envIssueNumbers.has(i.number)));
  },

  // One issue row for the forum feed, with everything the old Open
  // Issues section rendered per row (bounty/kudos, Create proposal, the
  // Generate-proposal state machine, Preview, creator attribution) plus the
  // accordion expansion into the issue body + thread chat.
  // The middle "start work" button reads "Create proposal" (no session yet)
  // or "Create new proposal" (viewer already has one) — see createBtn below.
  _renderIssueRow(issue, opts) {
    const noNav = !!(opts && opts.noNav);
    const meta = AppView._ghIssuesMeta || {};
    const n = issue.number;
    const href = issue.htmlUrl || '#';

    // ── Meta line ──
    // #N, the creator, and the facts that used to be badges: the ★ bounty
    // count and the auto-title marker. Both cost a badge slot each and
    // neither changes what you'd do next, so they read as meta words.
    const metaParts = [
      `<a href="${href}" target="_blank" rel="noopener" class="font-mono text-violet-400 hover:underline">#${n}</a>`,
    ];
    if (issue.created_by_username) metaParts.push(escapeHtml(issue.created_by_username));
    if (issue.bounty_count) {
      metaParts.push(`<span title="Kudos bounties pledged on this issue" class="text-amber-500">&#9733; ${parseInt(issue.bounty_count, 10) || 0}</span>`);
    }
    if (issue.title_fallback) metaParts.push('auto-title pending');

    // ── Icon ──
    // #250: mirrors the auto-solve state so proposal issues read at a
    // glance — pulsing sky document while generating, steady sky document
    // once ready, violet document-with-pencil when the viewer already has a
    // session cloned off it, plain amber issue chip otherwise.
    const h = issue.headless;
    const icon = h && h.status === 'generating'
      ? AppView._devCardIcon('issueProposal', { pulse: true, title: 'A proposal is being generated for this issue' })
      : h && h.status === 'ready'
        ? (h.mySessionId
            ? AppView._devCardIcon('issueProposalMine', { title: 'You have a session for this issue — go to it.' })
            : AppView._devCardIcon('issueProposal', { title: 'Proposal ready — review it to start a session' }))
        : AppView._devCardIcon('issue');

    // "Propose to close" — opens the reason modal and files a close_issue
    // governance proposal. While one is already open for this issue (an open
    // close_issue row in _govProposals targeting this number), the ⋯ menu
    // row below renders disabled as "Close proposed" instead (the server
    // also 409s a duplicate).
    const closeProposal = (AppView._govProposals || []).find((g) =>
      g.kind === 'close_issue' && g.status === 'open'
      && Number(g.payload && g.payload.issueNumber) === n);
    // #1010: once that proposal's vote has passed and the close is being
    // applied, say so HERE too — this row is where the reporter is looking
    // when they wonder whether the issue is actually closing. This is a
    // status, not an action, so it renders as a badge on the card face
    // rather than hiding inside the ⋯ menu.
    const closeApplying = closeProposal ? AppView._govApplyState(closeProposal) : null;
    const closeBadge = closeApplying && closeApplying.busy
      ? `<span class="gc-merging-badge" title="${escapeAttr(closeApplying.title || closeApplying.label)}"><span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>Closing&hellip;</span>`
      : closeProposal
        ? `<span class="gc-checks-running-badge" title="A close proposal for this issue is up for vote">Close proposed</span>`
        : '';

    // ── Badges: close status + In progress + at most three metadata chips ──
    const badges = [
      closeBadge,
      AppView._inProgressChipHtml(issue),
      ...AppView._attrChipsHtml('issue', n, issue, { omitUnset: !noNav, asArray: true }),
    ];

    // ── Actions: ONE state-driven primary + icon Preview + ⋯ ──
    const primaryBtn = AppView.readOnly ? '' : AppView._issuePrimaryActionHtml(issue);
    // A ready auto-solve run with a live preview gets the same icon
    // affordance every other previewable thing on the board gets.
    const hasRunPreview = !!(h && h.status === 'ready' && h.stagingUrl
      && (h.outcome === 'code' || h.outcome === 'spec_code'));
    const preview = hasRunPreview
      ? AppView.cardPreviewHtml({ staging_url: h.stagingUrl },
        { kind: 'issue-run', sessionId: h.sessionId })
      : '';
    const menu = AppView._issueMenuItems(issue, { noNav });
    const actions = AppView._cardActionsHtml({ primary: [primaryBtn], preview });

    // Topic-view-only admin escape hatch: the live claimer list with a
    // per-claim clear control, so a stuck claim can be removed without
    // SQL. The DELETE route is the authoritative gate (claimer or
    // write-admin); this affordance just doesn't render for others.
    const ipClaims = (issue.in_progress && Array.isArray(issue.in_progress.claims))
      ? issue.in_progress.claims : [];
    const adminClaimList = (noNav && ipClaims.length
      && typeof App !== 'undefined' && App.user && App.user.canAdminWrite)
      ? `<div class="mt-1 flex flex-wrap items-center gap-1 px-0.5 text-[0.65rem] text-zinc-500 dark:text-zinc-400">In-progress claims:${ipClaims.map((c) =>
          ` <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-500">${escapeHtml(c.username || '?')}<button type="button" class="hover:text-sky-700 dark:hover:text-sky-300" title="Clear ${escapeAttr(c.username || 'this user')}'s in-progress claim (admin)" onclick="AppView.clearIssueClaim(${n}, ${parseInt(c.userId, 10) || 0})">&times;</button></span>`
        ).join('')}</div>`
      : '';

    // #133/#556: the creating user renders in the meta line above, and the
    // author-only inline title edit is topic-head only (noNav) — feed cards
    // are whole-card tap targets, so an inline editor there would fight the
    // delegated open handler. The check is cosmetic (decides whether the
    // pencil renders); the PATCH route's author check is authoritative.
    const rowTitle = issue.created_by_username
      ? `${issue.title} · ${issue.created_by_username}`
      : issue.title;
    const canEditTitle = !!(noNav && !AppView.readOnly && issue.created_by_username
      && typeof App !== 'undefined' && App.user
      && issue.created_by_username === App.user.username);
    const editTitleBtn = canEditTitle
      ? ` <button type="button" class="align-middle text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors" title="Edit this issue's title (you created it)" aria-label="Edit title" onclick="AppView.beginIssueTitleEdit(${n})"><svg class="w-3.5 h-3.5 inline -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg></button>`
      : '';

    return `
      <div class="gc-vote-item ${AppView.DEV_CARD_CLS}${noNav ? '' : ` ${AppView.DEV_CARD_HOVER_CLS}`}" data-ref-issue="${n}"${noNav ? '' : ` data-issue-row="${n}" title="Open this issue's discussion"`}>
        ${icon}
        ${AppView._cardContentHtml({
          headlineHtml: AppView._cardHeadlineHtml(
            `${escapeHtml(issue.title)}${editTitleBtn}`, metaParts.join(' · '),
            `${canEditTitle ? ` data-issue-title="${n}"` : ''} title="${escapeHtml(rowTitle)}"`),
          badges,
          chatCount: issue.chatCount,
          uncapped: noNav,
          actions,
          extraHtml: adminClaimList,
        })}
        ${AppView._cardRailHtml(`issue:${n}`, menu, { chevron: !noNav })}
      </div>`;
  },

  // ── The issue card's ONE primary action ──────────────────────────────
  //
  // An issue card used to carry up to SEVEN pills, including two competing
  // "Generate proposal" buttons at once (#155's rerun affordance sitting
  // beside the clone affordance on a question outcome). They fold into one
  // state machine, which is also what makes the card's action budget
  // achievable:
  //
  //   no run, no session of mine   → Create proposal
  //   no run, I have a session     → Create new proposal
  //   run generating               → Generating proposal…      (disabled)
  //   run ready, I cloned it       → Go to session
  //   run ready, outcome question  → Answer & regenerate       (ONE button:
  //                                  it opens the issue's discussion where
  //                                  the questions were posted, from which
  //                                  the ⋯ "Generate proposal" re-runs)
  //   run ready, other outcomes    → Review spec / Review solution /
  //                                  Changes ready — review & start session
  //
  // "Generate proposal" for a never-run issue lives in the ⋯ menu: starting
  // a headless run spends the viewer's credits, so it should be a chosen
  // action rather than the card's most prominent button.
  _issuePrimaryActionHtml(issue) {
    const n = issue.number;
    const h = issue.headless;
    if (h && h.status === 'generating') {
      return `<button class="gc-vote-btn" disabled title="A headless AI session is working on this issue${h.username ? ` (started by ${escapeAttr(h.username)})` : ''}">Generating proposal&hellip;</button>`;
    }
    if (h && h.status === 'ready') {
      if (h.mySessionId) {
        return `<button class="gc-vote-btn" title="You already started a session from this proposal — open it" onclick="AppView.goToAutoSessionClone(${h.mySessionId})">Go to session</button>`;
      }
      if (h.outcome === 'question') {
        // One button, not two. It lands on the issue's discussion, where the
        // run posted its questions; re-running is the ⋯ menu's Generate
        // proposal row once they're answered.
        return `<button class="gc-vote-btn" title="The auto-solve run has a question for you — answer it on this issue, then use ⋯ → Generate proposal to re-run" onclick="AppView.openTopic('issue', ${n})">Answer &amp; regenerate</button>`;
      }
      const hasPreview = !!h.stagingUrl && (h.outcome === 'code' || h.outcome === 'spec_code');
      const outcomeNote = h.outcome === 'spec' ? 'it drafted a spec'
        : h.outcome === 'code' ? 'it pushed a code change'
          : h.outcome === 'spec_code' ? 'it drafted a spec and pushed a code change'
            : 'it finished a run';
      const label = hasPreview ? 'Changes ready &mdash; review &amp; start session'
        : h.outcome === 'spec' ? 'Review spec &amp; start session'
          : h.outcome === 'code' ? 'Review solution &amp; start session'
            : 'Start session from proposal';
      return `<button class="gc-vote-btn" title="Clone the finished proposal (${outcomeNote}) into your own dev chat — others can clone it too" onclick="AppView.startFromAutoSession(${h.sessionId})">${label}</button>`;
    }
    // #287: strictly per-viewer, and reverts to "Create proposal" once the
    // session is archived (the server filters archived rows out of
    // myPrSessionId).
    return issue.myPrSessionId
      ? `<button class="gc-vote-btn" title="Start another dev chat for this issue" onclick="AppView.createPrForIssue(${n})">Create new proposal</button>`
      : `<button class="gc-vote-btn" title="Start a dev chat to solve this issue" onclick="AppView.createPrForIssue(${n})">Create proposal</button>`;
  },

  // Everything an issue card demoted off its face, as ⋯ descriptors.
  _issueMenuItems(issue, state) {
    const st = state || {};
    const n = issue.number;
    const h = issue.headless;
    const meta = AppView._ghIssuesMeta || {};
    const items = [];

    if (!AppView.readOnly) {
      // Generate proposal — the headless run. Not on the card face because
      // it spends the viewer's credits. Absent while a run is in flight
      // (the primary already says "Generating proposal…") and while the
      // viewer has a clone of a finished run (the primary is "Go to
      // session", and offering a re-run there produces two competing
      // actions for a proposal that already exists — #150's rule, now
      // enforced by having exactly one place the action can live).
      const generating = !!(h && h.status === 'generating');
      const clonedReady = !!(h && h.status === 'ready' && h.mySessionId);
      if (!generating && !clonedReady) {
        items.push({
          label: 'Generate proposal',
          icon: 'generate',
          title: h && h.status === 'ready' && h.outcome === 'question'
            ? 'Questions were posted on the issue — answer them, then generate a proposal again'
            : 'Spin up a headless AI session that starts solving this issue on its own — uses your credits',
          act: () => AppView.confirmAutoSession(n),
        });
      }
      // "Pledge kudos" disables once the viewer has an open bounty here or
      // has spent their shared weekly allowance.
      const budgetSpent = meta.myRemaining === 0;
      const kudosReason = issue.my_bounty
        ? 'You already placed a bounty on this issue'
        : (budgetSpent ? 'Weekly kudos allowance spent' : '');
      items.push({
        label: issue.my_bounty ? 'Bountied' : 'Pledge kudos',
        icon: 'kudos',
        title: kudosReason
          || 'Pledge a kudos bounty — paid to whoever’s merged PR closes this issue',
        disabled: !!kudosReason,
        act: kudosReason ? null : () => AppView.giveIssueBounty(n),
      });
      // Manual "In progress" claim, keyed strictly off the VIEWER's own
      // claim: they can always add theirs alongside others' (claims are
      // per-user, never exclusive) and can only clear their own from here.
      const ipClaims = (issue.in_progress && Array.isArray(issue.in_progress.claims))
        ? issue.in_progress.claims : [];
      const myClaim = ipClaims.some((c) => c.mine);
      items.push(myClaim
        ? {
          label: 'Clear in progress',
          icon: 'clear',
          title: 'Remove your in-progress mark from this issue',
          act: () => AppView.clearIssueClaim(n),
        }
        : {
          label: 'Mark in progress',
          icon: 'progress',
          title: 'Mark this issue as in progress — you’re working on it. Expires on its own after ~7 days without activity; discussion in the issue’s thread keeps it alive.',
          act: () => AppView.markIssueInProgress(n),
        });
      // While a close proposal is already open for this issue the row is
      // disabled rather than hidden, so it still explains itself. The
      // server also 409s a duplicate.
      const closeProposal = (AppView._govProposals || []).find((g) =>
        g.kind === 'close_issue' && g.status === 'open'
        && Number(g.payload && g.payload.issueNumber) === n);
      // #1010: once that proposal's vote has passed and the close is being
      // applied, say so HERE too — this row is where the reporter is looking
      // when they wonder whether the issue is actually closing.
      const closeApplying = closeProposal ? AppView._govApplyState(closeProposal) : null;
      items.push(closeApplying && closeApplying.busy
        ? {
          label: 'Closing…',
          icon: 'close',
          title: closeApplying.title || closeApplying.label,
          disabled: true,
        }
        : closeProposal
          ? {
            label: 'Close proposed',
            icon: 'close',
            title: 'A close proposal for this issue is up for vote',
            disabled: true,
          }
          : {
            label: 'Propose to close',
            icon: 'close',
            title: 'Propose closing this issue — the group votes; if it passes, the issue is closed here and on GitHub',
            danger: true,
            act: () => AppView.promptCloseIssue(n),
          });
      if (!st.noNav) {
        items.push(...AppView._attrMenuItems('issue', n, issue));
      }
    }
    if (issue.htmlUrl) {
      items.push({
        label: 'Open on GitHub',
        icon: 'github',
        title: issue.htmlUrl,
        act: () => window.open(issue.htmlUrl, '_blank', 'noopener'),
      });
    }
    return items;
  },

  // #556: inline issue-title editor in the topic head. Swaps the title div
  // (marked data-issue-title by _renderIssueRow's noNav variant) for an
  // input + Save/Cancel. Cancel just repaints the head; Save PATCHes the
  // rename route, then optimistically updates the cached _ghIssues row so
  // this tab repaints even if its events socket is momentarily down (the
  // server's issue_update broadcast covers everyone else).
  //
  // #665: the issue number being edited, or null. While set (and the editor
  // is actually in the DOM) _renderTopicHead skips its repaint so the
  // WS/poll-driven refresh cycle can't clobber the editor mid-typing.
  // Cleared on cancel, on save success/no-op (NOT on save error — the
  // editor stays open showing the error), and on openTopic.
  _editingIssueTitle: null,

  beginIssueTitleEdit(n) {
    const holder = document.querySelector(`#gc-thread-head [data-issue-title="${n}"]`);
    const issue = (AppView._ghIssues || []).find((i) => i.number === n);
    if (!holder || !issue) return;
    AppView._editingIssueTitle = n;
    holder.innerHTML = `
      <div class="flex flex-wrap items-center gap-2">
        <input id="dev-issue-title-input" type="text" maxlength="200"
          class="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500">
        <button type="button" class="gc-vote-btn" onclick="AppView.saveIssueTitle(${n})">Save</button>
        <button type="button" class="gc-vote-btn" onclick="AppView.cancelIssueTitleEdit()">Cancel</button>
        <span id="dev-issue-title-error" class="w-full text-xs text-red-400 hidden"></span>
      </div>`;
    const input = document.getElementById('dev-issue-title-input');
    input.value = issue.title || '';
    input.focus();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); AppView.saveIssueTitle(n); }
      if (e.key === 'Escape') { e.preventDefault(); AppView.cancelIssueTitleEdit(); }
    });
  },

  cancelIssueTitleEdit() {
    // Repaint the head from the cached row — drops the editor. The flag
    // clears FIRST so the repaint guard doesn't block this paint.
    AppView._editingIssueTitle = null;
    AppView._renderTopicHead();
  },

  async saveIssueTitle(n) {
    const input = document.getElementById('dev-issue-title-input');
    const errEl = document.getElementById('dev-issue-title-error');
    const issue = (AppView._ghIssues || []).find((i) => i.number === n);
    if (!input || input.disabled || !issue || !AppView.appData) return;
    const newTitle = input.value.trim();
    // Empty or unchanged → treat as cancel (the server would no-op too).
    if (!newTitle || newTitle === issue.title) {
      AppView._editingIssueTitle = null;
      AppView._renderTopicHead();
      return;
    }
    input.disabled = true;
    const showError = (msg) => {
      input.disabled = false;
      if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
    };
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/github-issues/${n}/title`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return showError(data.error || 'Failed to update the title');
      issue.title = data.title || newTitle;
      issue.title_fallback = false;
      AppView._editingIssueTitle = null;
      AppView._renderTopicHead();
    } catch {
      showError('Network error');
    }
  },

  // ---- Merged (closed) PRs section ----------------------------------------

  // #149: only the first 3 closed PRs render by default; the rest sit behind
  // a show-more toggle, mirroring the Open Issues pattern above.
  _mergedShownDefault: 3,

  // Build the inner HTML for the Merged section from the cached
  // AppView._merged list. Rendered once inside loadVotePanel's bodyHtml and
  // re-rendered in place (into #gc-merged) by toggleMergedPrs so the
  // show-more/show-less toggle needs no refetch.
  _renderMergedInner() {
    const merged = AppView._merged || [];
    const { majority, activeUsers } = AppView._mergedCtx || { majority: 1, activeUsers: 1 };
    const shown = AppView._mergedExpanded
      ? merged.length
      : Math.min(AppView._mergedShownDefault, merged.length);

    let html = `<div class="text-xs uppercase font-semibold text-zinc-500 dark:text-zinc-400 tracking-wider mb-1">Completed</div><div class="space-y-2">`;
    for (let i = 0; i < shown; i++) {
      html += merged[i].row_type === 'close_issue'
        ? AppView._renderCompletedCloseIssueCard(merged[i])
        : AppView._renderMergedCard(merged[i], majority);
    }
    html += '</div>';

    // Footer pager, same styling as the Open Issues pager.
    //   • collapsed (with more loaded rows) → "Show N more" reveals the
    //     rest of the already-fetched page (client-side, no refetch).
    //   • expanded, server has more pages → "Load more" fetches the next
    //     keyset page from the server and appends it (#429).
    //   • expanded, no more pages → "Show less" collapses back to 3.
    const btns = [];
    if (!AppView._mergedExpanded && merged.length > AppView._mergedShownDefault) {
      btns.push(`<button class="gc-vote-btn" onclick="AppView.toggleMergedPrs()">Show ${merged.length - shown} more</button>`);
    }
    if (AppView._mergedExpanded) {
      if (AppView._mergedHasMore) {
        const loading = AppView._mergedLoadingMore;
        btns.push(`<button class="gc-vote-btn" ${loading ? 'disabled' : ''} onclick="AppView.loadMoreMerged()">${loading ? 'Loading…' : 'Load more'}</button>`);
      }
      if (merged.length > AppView._mergedShownDefault) {
        btns.push(`<button class="gc-vote-btn" onclick="AppView.toggleMergedPrs()">Show less</button>`);
      }
    }
    if (btns.length) {
      html += `<div class="mt-1 flex gap-2">${btns.join('')}</div>`;
    }
    return html;
  },

  // #429: fetch the next keyset page of merged PRs and append it in place.
  // Uses the (created_at, id) cursor of the last loaded row so paging is
  // stable even as new PRs merge at the top. Re-renders #gc-merged and
  // re-wires kudos / Ask-AI on the freshly painted cards, mirroring the
  // mount in loadVotePanel.
  async loadMoreMerged() {
    if (AppView._mergedLoadingMore || !AppView._mergedHasMore) return;
    if (!AppView.appData || !AppView._mergedCursor) return;
    const slug = AppView.appData.slug;
    AppView._mergedLoadingMore = true;
    // Reflect the disabled/"Loading…" state immediately. In kanban mode the
    // Done-column footer lives in #dev-kanban (there is no #gc-merged), so
    // repaint the whole board; in list mode update the Completed section in
    // place.
    if (AppView._getViewMode() === 'kanban') {
      AppView._repaintDevBody();
    } else {
      const el0 = document.getElementById('gc-merged');
      if (el0) el0.innerHTML = AppView._renderMergedInner();
    }
    try {
      const cur = AppView._mergedCursor;
      const qs = AppView._demoQS();
      const sep = qs ? '&' : '?';
      const url = `/api/apps/${slug}/merged${qs}${sep}before=${encodeURIComponent(cur.created_at)}&before_id=${encodeURIComponent(cur.id)}&before_type=${encodeURIComponent(cur.row_type || 'pr')}`;
      const res = await fetch(url);
      const data = res.ok ? await res.json() : { merged: [], hasMore: false };
      const more = data.merged || [];
      // De-dup defensively in case the cursor straddled equal timestamps.
      // Keyed by (type, id): PR and close-issue rows draw ids from
      // independent sequences, so a bare id isn't unique in the stream.
      const rowKey = (r) => `${r.row_type || 'pr'}:${r.id}`;
      const have = new Set((AppView._merged || []).map(rowKey));
      const fresh = more.filter((r) => !have.has(rowKey(r)));
      AppView._merged = (AppView._merged || []).concat(fresh);
      AppView._mergedHasMore = !!data.hasMore;
      if (AppView._merged.length) {
        const last = AppView._merged[AppView._merged.length - 1];
        AppView._mergedCursor = { created_at: last.created_at, id: last.id, row_type: last.row_type || 'pr' };
      }
      // Keep inline vote/kudos state in sync so the newly loaded merged
      // rows get their group-chat activity controls too. Close-issue rows
      // stay out (voteState is PR-keyed — see _loadDevData).
      if (AppView.voteState && AppView.voteState.bySession) {
        for (const pr of fresh) {
          if ((pr.row_type || 'pr') === 'close_issue') continue;
          AppView.voteState.bySession[String(pr.id)] = pr;
          if (pr.pr_number != null) AppView.voteState.byPrNumber[String(pr.pr_number)] = pr;
        }
        if (typeof GroupChat !== 'undefined' && GroupChat.refreshVoteControls) {
          GroupChat.refreshVoteControls();
        }
      }
    } catch {
      // Leave the existing rows in place; surface nothing destructive.
    } finally {
      AppView._mergedLoadingMore = false;
      // Paint the freshly loaded cards into whichever view is active.
      // _repaintDevBody re-renders #dev-kanban and re-attaches Kudos /
      // Ask-AI for the kanban Done column; list mode updates #gc-merged.
      if (AppView._getViewMode() === 'kanban') {
        AppView._repaintDevBody();
      } else {
        const el = document.getElementById('gc-merged');
        if (el) {
          el.innerHTML = AppView._renderMergedInner();
          if (window.Kudos) Kudos.attach(el);
          AppView._applyExploreChatAvailability(el);
        }
      }
    }
  },

  // One merged ("Completed") proposal card. Extracted from
  // _renderMergedInner so the kanban "Done" column can render the same
  // markup per row without the section header / show-more footer.
  // `majority` defaults to the cached merged context.
  _renderMergedCard(pr, majority) {
    const maj = majority != null
      ? majority
      : ((AppView._mergedCtx && AppView._mergedCtx.majority) || 1);
    const date = new Date(pr.created_at).toLocaleDateString();
    const mergedLabel = pr.pr_title
      ? escapeHtml(pr.pr_title)
      : `Change by ${escapeHtml(pr.username)}`;
    const mergedQuoteTitle = pr.pr_title || `PR #${pr.pr_number || pr.id}`;
    const mine = !!(App.user && pr.user_id === App.user.id);

    // ── Meta line ──
    // The revert relationship reads here rather than as an action pill: on a
    // merged card it is a FACT about the change, not something to do.
    const metaParts = [
      `<a href="${pr.pr_url || '#'}" target="_blank" rel="noopener" class="font-mono text-emerald-400 hover:underline">PR#${pr.pr_number || pr.id}</a>`,
    ];
    if (pr.username) metaParts.push(escapeHtml(pr.username));
    metaParts.push(date);
    if (pr.revert_of_session_id) {
      metaParts.push('<span class="text-amber-500" title="This PR is itself a revert">↩ revert</span>');
    } else if (pr.revert_session_id) {
      const rs = pr.revert_status;
      const rpr = pr.revert_pr_number || pr.revert_session_id;
      const label = rs === 'merged'
        ? `Undone by PR#${rpr}`
        : rs === 'merging'
          ? `Revert merging (PR#${rpr})`
          : `Revert in vote · PR#${rpr}`;
      metaParts.push(`<a href="${pr.revert_pr_url || '#'}" target="_blank" rel="noopener" class="text-amber-500 hover:text-amber-400 font-medium">${escapeHtml(label)}</a>`);
    }
    const closes = AppView.closesPillHtml(pr);

    // The settled pill (denominator is the threshold snapshotted at merge
    // time) plus the frozen metadata chips that actually carry a value.
    const badges = AppView._attrChipsHtml('proposal', pr.id, pr, {
      readonly: true, omitUnset: true, asArray: true,
    });
    const pill = AppView.statusPillHtml(pr, { majority: maj });

    // No text actions on a settled card: Undo / Kudos / Explore all live in
    // ⋯, and the read-only "You voted X" box is gone from the card face —
    // the pill's tooltip and the detail view's vote roster carry that.
    const menu = AppView._proposalMenuItems(pr, { mine, imported: pr.source === 'imported', isMerged: true });

    return `
        <div class="gc-vote-item ${AppView.DEV_CARD_CLS} ${AppView.DEV_CARD_HOVER_CLS}" data-ref-pr="${pr.pr_number || pr.id}" data-proposal-row="${pr.id}" title="Open this proposal's discussion">
          ${AppView._devCardIcon('done')}
          ${AppView._cardContentHtml({
            headlineHtml: AppView._cardHeadlineHtml(
              mergedLabel, metaParts.join(' · ') + (closes ? ` ${closes}` : ''),
              ` title="${escapeHtml(mergedQuoteTitle)}"`),
            badges,
            chatCount: parseInt(pr.chat_count) || 0,
            pill,
          })}
          ${AppView._cardRailHtml(`merged:${pr.id}`, menu)}
        </div>`;
  },

  // One APPLIED close-issue proposal ("Issue close") card in the Completed
  // list / kanban Done column (row_type='close_issue' rows from /merged).
  // Same green check icon as merged PRs so the column reads uniformly, but
  // the meta line says "Issue close" where a code proposal shows its PR
  // number, and there are deliberately NO code-proposal actions (Undo,
  // kudos, Explore in dev chat, priority/assignee chips). The settled tally pill mirrors
  // the merged-PR treatment: payload.required is the threshold snapshotted
  // at apply time; status 'merged' keeps voteCountPill clock-free. Clicking
  // opens the governance discussion via the delegated [data-gov-row]
  // handler (openTopic('gov', id)).
  _renderCompletedCloseIssueCard(row) {
    const p = row.payload || {};
    const issueN = p.issueNumber || null;
    const titleText = issueN
      ? `Close issue #${issueN}: "${p.issueTitle || row.title}"`
      : (row.title || 'Close issue');
    const who = row.created_by_username
      ? ` <span class="text-zinc-500">· ${escapeHtml(row.created_by_username)}</span>`
      : '';
    const how = String(p.appliedBy || '').startsWith('admin:')
      ? 'closed by admin' : 'closed by vote';
    const when = p.appliedAt || row.created_at;
    const date = when ? new Date(when).toLocaleDateString() : '';
    // GitHub link for the closed target, normalized like the kanban Issues
    // footer's repo link.
    const repo = (AppView.appData && AppView.appData.repo_url) || '';
    const base = repo ? repo.replace(/\.git$/, '').replace(/\/$/, '') : '';
    const issueRef = issueN
      ? (base
        ? `<a href="${base}/issues/${issueN}" target="_blank" rel="noopener" class="font-mono text-emerald-400 hover:underline">#${issueN}</a> · `
        : `<span class="font-mono">#${issueN}</span> · `)
      : '';
    // Same composite pill as every other settled row: status 'merged'
    // keeps it clock-free, and payload.required is the threshold
    // snapshotted at apply time.
    const tallyPill = AppView.statusPillHtml({
      yes_count: parseInt(row.up_count) || 0,
      no_count: parseInt(row.down_count) || 0,
      votes_required: p.required != null ? p.required : null,
      status: 'merged',
    }, { majority: parseInt(p.required) || 1, kind: 'gov' });
    // No actions at all on a settled close-issue row, so no ⋯ either.
    return `
        <div class="gc-vote-item ${AppView.DEV_CARD_CLS} ${AppView.DEV_CARD_HOVER_CLS}" data-gov-row="${row.id}"${issueN ? ` data-ref-issue="${issueN}"` : ''} title="Open this proposal's discussion">
          ${AppView._devCardIcon('done')}
          ${AppView._cardContentHtml({
            headlineHtml: AppView._cardHeadlineHtml(
              `${escapeHtml(titleText)}${who}`,
              `Issue close · ${issueRef}${how}${date ? ` · ${date}` : ''}`,
              ` title="${escapeHtml(titleText)}"`),
            badges: [],
            chatCount: parseInt(row.chat_count) || 0,
            pill: tallyPill,
          })}
          ${AppView.DEV_CARD_CHEVRON}
        </div>`;
  },

  // Expand / collapse the Merged section in place (no panel reload).
  toggleMergedPrs() {
    AppView._mergedExpanded = !AppView._mergedExpanded;
    const el = document.getElementById('gc-merged');
    if (el) {
      el.innerHTML = AppView._renderMergedInner();
      AppView._applyExploreChatAvailability(el);
    }
  },

  // "Give kudos" — pledge a bounty on a GitHub issue. Debits the shared
  // weekly kudos allowance server-side; optimistically bumps the local count
  // and disables the button on success.
  async giveIssueBounty(issueNumber) {
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug) return;
    const key = `bounty:${issueNumber}`;
    if (AppView._bountyInFlight.has(key)) return;
    AppView._bountyInFlight.add(key);
    try {
      const resp = await fetch(`/api/apps/${slug}/issues/${issueNumber}/bounty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        PlatformUI.toast(data.error || `Couldn't place bounty (HTTP ${resp.status}).`);
        return;
      }
      // Reflect the new state locally: mark this issue bountied, set its
      // count from the server, and update the remaining-allowance gate.
      const issue = (AppView._ghIssues || []).find((i) => i.number === issueNumber);
      if (issue) {
        issue.my_bounty = true;
        issue.bounty_count = typeof data.bountyCount === 'number' ? data.bountyCount : (issue.bounty_count || 0) + 1;
      }
      if (typeof data.remaining === 'number') AppView._ghIssuesMeta.myRemaining = data.remaining;
      // #964: the drawer's Kudos meter draws from its own budget state, so
      // without this it kept showing the pre-pledge figure until the hourly
      // poll came round. A pledge here spends from the same weekly pool.
      window.Kudos?.Budget?.refresh?.();
      AppView._repaintCards();
    } catch (err) {
      PlatformUI.toast(`Couldn't place bounty: ${err.message}`);
    } finally {
      AppView._bountyInFlight.delete(key);
    }
  },

  // "Mark in progress" — add (or renew) the viewer's own claim on an
  // issue. Optimistic: the cached row gains the claim and repaints right
  // away; the server's issue_update broadcast reconciles everyone
  // (including this client) with authoritative data moments later.
  async markIssueInProgress(issueNumber) {
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug) return;
    try {
      const resp = await fetch(`/api/apps/${slug}/github-issues/${issueNumber}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        PlatformUI.toast(data.error || `Couldn't mark in progress (HTTP ${resp.status}).`);
        return;
      }
      const issue = (AppView._ghIssues || []).find((i) => i.number === issueNumber);
      if (issue) {
        const me = (typeof App !== 'undefined' && App.user) ? App.user : { id: 0, username: 'you' };
        const ip = issue.in_progress || { count: 0, users: [], mine: false, claims: [], target: null };
        if (!Array.isArray(ip.claims)) ip.claims = [];
        if (!ip.claims.some((c) => c.mine)) {
          ip.claims.push({
            username: me.username, userId: me.id, mine: true,
            claimedAt: new Date().toISOString(), expiresAt: null,
          });
        }
        ip.mine = true;
        issue.in_progress = ip;
        AppView._repaintCards();
        if (document.getElementById('gc-thread-head')) AppView._renderTopicHead();
      }
    } catch (err) {
      PlatformUI.toast(`Couldn't mark in progress: ${err.message}`);
    }
  },

  // "Clear in progress" — remove a claim. With no userId: the viewer's
  // own. With one (admin per-claim clear control in the topic view):
  // that user's — the server 403s anyone but the claimer or a
  // write-admin. Optimistic like markIssueInProgress; the `mine` flag is
  // left alone when live sessions remain (it covers those too) and the
  // WS-driven refetch reconciles shortly.
  async clearIssueClaim(issueNumber, userId) {
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug) return;
    try {
      const hasTarget = userId != null;
      const resp = await fetch(`/api/apps/${slug}/github-issues/${issueNumber}/claim`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        ...(hasTarget ? { body: JSON.stringify({ userId }) } : {}),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        PlatformUI.toast(data.error || `Couldn't clear the in-progress mark (HTTP ${resp.status}).`);
        return;
      }
      const issue = (AppView._ghIssues || []).find((i) => i.number === issueNumber);
      if (issue && issue.in_progress) {
        const me = (typeof App !== 'undefined' && App.user) ? App.user : null;
        const clearedId = hasTarget ? userId : (me && me.id);
        const ip = issue.in_progress;
        ip.claims = (Array.isArray(ip.claims) ? ip.claims : []).filter((c) => c.userId !== clearedId);
        if (!ip.count && !ip.claims.length) {
          issue.in_progress = null;
        } else if (!ip.count) {
          ip.mine = ip.claims.some((c) => c.mine);
        }
        AppView._repaintCards();
        if (document.getElementById('gc-thread-head')) AppView._renderTopicHead();
      }
    } catch (err) {
      PlatformUI.toast(`Couldn't clear the in-progress mark: ${err.message}`);
    }
  },

  // "Create proposal" / "Create new proposal" — spin up a fresh dev chat for
  // this issue and PREFILL (never send) the composer with a kickoff message
  // built from the issue's number/title/body, so the user can edit it before
  // the agent starts (#609). Sending the default text as-is makes the Mayor
  // link the issue (addresses_issues → linked_issues → `Closes #N`) and solve
  // it. Mirrors DevChat.startNewChange's create→open→render flow; the seed
  // lands in the box via the per-session draft (_setDraft → _restoreDraft on
  // render). Safe to call from either button state — each call spawns a
  // brand-new session.
  async createPrForIssue(issueNumber) {
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug || typeof DevChat === 'undefined') return;
    const issue = (AppView._ghIssues || []).find((i) => i.number === issueNumber);

    // #287: pass the issue number so the session is persistently linked
    // (created_from_issue_number) and the row keeps the has-session state.
    const session = await DevChat.createSession(slug, issueNumber);
    if (!session) return; // createSession already alerts (cap reached / error)

    // #287: optimistically move the row into the has-session state right away
    // ("Create proposal" → "Create new proposal"), before the next
    // /github-issues load confirms the link server-side.
    if (issue) {
      issue.myPrSessionId = session.id;
      if (typeof AppView._repaintCards === 'function') AppView._repaintCards();
    }

    // Kickoff seed the user gets to edit before sending. Naming the number
    // is what drives the merge-time bounty payout, so the default text keeps
    // the `Closes #N` guidance intact.
    const title = issue ? issue.title : '';
    const body = issue && issue.body ? `\n\n${issue.body}` : '';
    const seed =
      `Please implement GitHub issue #${issueNumber}: "${title}".${body}\n\n`
      + `Open a PR that closes this issue (include "Closes #${issueNumber}" so it links and closes the issue on merge).`;

    // #609: stash the seed as the session's draft BEFORE navigating — the
    // chat view's render path calls _restoreDraft(), which fills the
    // composer (unsent) for us. Nothing is sent until the user hits Send.
    if (typeof DevChat._setDraft === 'function') DevChat._setDraft(session.id, seed);

    // Land on the Dev Chat tab focused on the new session. switchTab
    // ('individual-chat') → renderDevChatTab(sessionId) opens the session,
    // renders the chat view, and syncs the hash for us.
    if (typeof App !== 'undefined' && App.switchTab) {
      await App.switchTab('dev', session.id, 'sessions');
    }

    // Fallback for localStorage-disabled browsers (_setDraft silently
    // no-ops there): put the seed straight into the mounted textarea if the
    // draft restore left it empty. Focus with the cursor parked at the end
    // on fine-pointer devices only — focusing on touch would pop the
    // on-screen keyboard over the chat (#568, same rule as the quick-reply
    // pills).
    const input = document.getElementById('dc-input');
    if (input) {
      if (!input.value) {
        input.value = seed;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      }
      if (typeof DevChat._isCoarsePointer !== 'function' || !DevChat._isCoarsePointer()) {
        try {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        } catch {}
      }
    }
  },

  // ---- Headless auto sessions (#155) --------------------------------------

  // "Generate proposal" — confirmation popup (token warning + model selector)
  // before spinning up a headless AI session on this issue. The session is
  // billed to the clicking user but isn't attached to their dev chat.
  async confirmAutoSession(issueNumber) {
    const slug = AppView.appData && AppView.appData.slug;
    if (!slug) return;

    // Model list comes from the same GET /api/models the dev-chat dropdown
    // uses, so the popup can never offer a model the server would reject.
    let models = [];
    let defaultModel = '';
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      models = Array.isArray(data.models) ? data.models : [];
      defaultModel = data.default || (models[0] && models[0].id) || '';
    } catch {
      PlatformUI.toast("Couldn't load the model list — try again.");
      return;
    }
    const stored = localStorage.getItem('usernode:dc:model');
    const preselect = models.some((m) => m.id === stored) ? stored : defaultModel;

    const choice = await AppView._showAutoSessionModal(issueNumber, models, preselect);
    if (!choice) return;

    try {
      const resp = await fetch(`/api/apps/${slug}/issues/${issueNumber}/headless-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: choice }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        // Out of daily credits is not an ordinary error — it has three real
        // ways forward (own API key, a coding tool on your computer, a
        // connected Claude.ai / ChatGPT subscription). Show the same card
        // the dev chat shows instead of a one-line toast the user can only
        // read and dismiss. Every other failure keeps the toast.
        if (data.code === 'budget_exceeded') {
          AppView._showCreditOptionsModal(data.error);
          return;
        }
        PlatformUI.toast(data.error || `Couldn't start generating the proposal (HTTP ${resp.status}).`);
        return;
      }
      const issue = (AppView._ghIssues || []).find((i) => i.number === issueNumber);
      if (issue) issue.headless = { sessionId: data.session.id, status: 'generating' };
      AppView._repaintCards();
      // #1038: no poller to arm. The server broadcasts this run's state
      // changes (services/session-state.js) and _onSessionStateEvent patches
      // the cached issue row, so the card advances to its outcome label on
      // its own — on every open board, not just this one.
    } catch (err) {
      PlatformUI.toast(`Couldn't start generating the proposal: ${err.message}`);
    }
  },

  // Out-of-credits popup for the Generate-proposal path. Same scrim/card
  // chrome as _showAutoSessionModal below; the body is the shared card from
  // public/js/credit-options.js, so the copy and the three Settings
  // destinations are identical to the dev-chat card and the red banner.
  // Choosing a route is a hash navigation, which unmounts this screen —
  // so the modal only has to handle explicit dismissal.
  _showCreditOptionsModal(errorText) {
    const existing = document.getElementById('credit-options-modal');
    if (existing) existing.remove();
    if (!window.CreditOptions) {
      PlatformUI.toast(errorText || "You're out of today's free AI credits.");
      return;
    }
    const root = document.createElement('div');
    root.id = 'credit-options-modal';
    root.className = 'fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-black/60';
    const state = {
      error: errorText || '',
      hasApiKey: !!(window.Settings && Settings.state && Settings.state.hasApiKey),
      // The headless route refuses on the user's own allowance the same way
      // the chat does; the shared-budget wording is reachable through the
      // budget meter, which this modal doesn't read.
      globalOut: false,
      // #1049: whether to lead with the Claude Code / Codex hand-offs. From
      // /api/auth/me, so the card offers only what this deployment supports.
      externalFlowsAvailable: !!(typeof App !== 'undefined' && App.user
        && App.user.externalFlowsAvailable),
    };
    root.innerHTML = `
      <div class="min-h-full flex items-center justify-center p-4">
        <div class="dc-credits-modal-card w-full max-w-lg rounded-xl bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 shadow-xl p-4">
          ${CreditOptions.cardHtml(state)}
          <div class="flex justify-end mt-3">
            <button type="button" data-credits-close
              class="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">Not now</button>
          </div>
        </div>
      </div>`;
    const close = () => {
      root.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    root.addEventListener('click', (e) => {
      if (e.target === root) close();
      if (e.target.closest('[data-credits-close]')) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(root);
    // #1049: "Use Claude Code" / "Use Codex" start the guided walkthrough in
    // a new session rather than dropping the user in Settings to work out
    // what to do next. Every other route is still a hash navigation, which
    // unmounts this screen on its own.
    CreditOptions.wire(root, {
      onFlow: (flow) => {
        close();
        AppView.createProposal({ flow });
      },
    });
  },

  // Singleton confirm popup for Generate proposal. Same scrim/card styling as
  // ConfirmModal (confirm-modal.js) plus a model <select>; resolves to the
  // chosen model id, or null on cancel/backdrop/Esc.
  _showAutoSessionModal(issueNumber, models, preselect) {
    let root = document.getElementById('auto-session-modal');
    if (root) root.remove();
    root = document.createElement('div');
    root.id = 'auto-session-modal';
    root.className = 'fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-black/60';
    // #800: same option text as the dev-chat composer (solve-rate range +
    // recommended change size), built by the shared DevChat helpers so
    // the two pickers can't drift. Falls back to the bare label when
    // dev-chat.js isn't loaded on this page (e.g. the gallery shell).
    const optionText = (m) => (
      (typeof DevChat !== 'undefined' && DevChat.modelOptionText)
        ? DevChat.modelOptionText(m)
        : (m.label || m.id)
    );
    const options = models.map((m) =>
      `<option value="${escapeAttr(m.id)}"${m.id === preselect ? ' selected' : ''}>${escapeHtml(optionText(m) || m.id)}</option>`
    ).join('');
    root.innerHTML = `
      <div data-modal-backdrop class="flex min-h-full items-center justify-center p-4">
        <div class="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-md shadow-xl relative">
          <h2 class="text-lg font-bold mb-2 text-zinc-900 dark:text-zinc-100">Generate proposal for issue #${issueNumber}?</h2>
          <p class="text-sm text-zinc-600 dark:text-zinc-400 mb-3">
            This spins up a <b>headless AI session</b> that immediately starts working on the
            issue on its own — investigating the repo and drafting a spec, pushing a code
            change, or coming back with a question. When the drafted spec looks
            straightforward, the session <b>may also implement it</b> in the same run
            (committing and pushing to its own branch — never a PR or deploy). It is not
            connected to your dev chat, but it <b>will automatically use your
            tokens/credits</b> the moment you confirm.
          </p>
          <p class="text-xs text-amber-500 mb-4">
            Experimental — not recommended for normal users at the moment. Costs are billed
            to you even if the result isn't useful.
          </p>
          <label class="block text-xs font-medium text-zinc-500 mb-1" for="auto-session-model">Model</label>
          <select id="auto-session-model"
            class="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100">
            ${options}
          </select>
          <!-- #800: caption for the selected model, kept in sync below. -->
          <p id="auto-session-model-note" class="mt-1 mb-5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400"></p>
          <div class="flex justify-end gap-2">
            <button data-role="cancel" type="button"
              class="rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">Cancel</button>
            <button data-role="confirm" type="button"
              class="rounded-lg px-4 py-2 text-sm font-medium text-white bg-violet-600 hover:bg-violet-500 transition-colors">Generate proposal</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);

    // #800: describe whichever model is selected, updating on change.
    const modelSel = root.querySelector('#auto-session-model');
    const noteEl = root.querySelector('#auto-session-model-note');
    const paintNote = () => {
      if (!noteEl) return;
      const chosen = models.find((m) => m.id === (modelSel && modelSel.value));
      const text = (typeof DevChat !== 'undefined' && DevChat.modelNoteText)
        ? DevChat.modelNoteText(chosen)
        : '';
      noteEl.textContent = text;
      noteEl.title = text && DevChat.MODEL_GUIDANCE_TOOLTIP ? DevChat.MODEL_GUIDANCE_TOOLTIP : '';
    };
    paintNote();
    if (modelSel) modelSel.addEventListener('change', paintNote);

    return new Promise((resolve) => {
      let settled = false;
      const cleanup = (result) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        root.remove();
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
      };
      root.querySelector('[data-role="cancel"]').addEventListener('click', () => cleanup(null));
      root.querySelector('[data-role="confirm"]').addEventListener('click', () => {
        const sel = root.querySelector('#auto-session-model');
        cleanup((sel && sel.value) || null);
      });
      root.addEventListener('click', (e) => {
        if (e.target === root || e.target.dataset.modalBackdrop !== undefined) cleanup(null);
      });
      document.addEventListener('keydown', onKey, true);
    });
  },

  // "Start session from proposal" — clone the finished headless session
  // (chat history + spec + branch + CC memory) into a dev chat owned by the
  // clicking user, then land them in it. Any number of users can do this
  // independently; each clone gets its own branch and PR path.
  async startFromAutoSession(headlessSessionId) {
    if (typeof DevChat === 'undefined') return;
    try {
      const resp = await fetch(`/api/sessions/${headlessSessionId}/clone-headless`, { method: 'POST' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        PlatformUI.toast(data.error || `Couldn't start a session from the proposal (HTTP ${resp.status}).`);
        return;
      }
      // #172: remember the clone locally so a back-navigation to the
      // issues panel shows "Go to session" before the next refetch. The
      // server's headless.mySessionId is the source of truth on every
      // re-render/poll.
      for (const issue of AppView._ghIssues || []) {
        if (issue.headless && issue.headless.sessionId === headlessSessionId) {
          issue.headless.mySessionId = data.session.id;
        }
      }
      DevChat.sessions.unshift(data.session);
      if (typeof App !== 'undefined' && App.switchTab) {
        await App.switchTab('dev', data.session.id, 'sessions');
      }
    } catch (err) {
      PlatformUI.toast(`Couldn't start a session from the proposal: ${err.message}`);
    }
  },

  // #172: "Go to session" — the viewer already cloned this auto session,
  // so navigate to their existing derived session instead of cloning
  // again. No DevChat.sessions.unshift needed: the switchTab path reloads
  // the session list itself before opening the session.
  async goToAutoSessionClone(sessionId) {
    if (typeof DevChat === 'undefined') return;
    if (typeof App !== 'undefined' && App.switchTab) {
      await App.switchTab('dev', sessionId, 'sessions');
    }
  },

  // #287: reopen the viewer's existing proposal dev chat for an issue. No
  // longer wired to the start-work button (which now always creates a new
  // proposal via createPrForIssue — see _renderIssueRow); retained for the
  // deferred "keep both buttons" variant that would re-add a one-tap reopen.
  // Same navigation as goToAutoSessionClone; the switchTab path reloads the
  // session list before opening the session.
  async openIssuePrSession(sessionId) {
    if (typeof DevChat === 'undefined') return;
    if (typeof App !== 'undefined' && App.switchTab) {
      await App.switchTab('dev', sessionId, 'sessions');
    }
  },

  // #1038: the 8s `_syncHeadlessPolling` timer that used to live here is
  // gone. It re-pulled the whole GitHub-issues payload every 8 seconds just
  // to notice a generating auto-run had finished — while the server had
  // been broadcasting exactly that transition all along (the
  // `headless_update` session_event) with no client listening. The board
  // now flips the card from the pushed `session_state` event:
  // _onSessionStateEvent patches the cached issue row's `headless` field
  // (same field-scoped merge the poller did, so optimistic bounty edits
  // survive) and the coalesced repaint follows.

  // Core PR voting controls (Preview / Yes / No / Admin-merge) as an HTML
  // string. Shared by the vote panel rows and the inline buttons on
  // group-chat activity rows (group-chat.js) so the two never diverge.
  // Expects a `pr` row from /promoted (id, status, staging_url, my_vote,
  // yes_count, no_count). Admin merge only renders for admins.
  // Rounded "yes / majority" tally pill, white-filled with a state-colored
  // outline: purple while neither side has enough votes, green once Yes hits
  // majority, red once No hits it. Shared by the vote panel rows and the
  // inline group-chat activity rows so the two never diverge.
  // ── The composite status pill ────────────────────────────────────────
  //
  // A proposal card used to be able to show SEVEN separate elements all
  // answering "where is this in its life": the proportional tally pill, a
  // pulsing "Vote" badge, a merge-state badge, a checks badge, a
  // console-errors badge, an advisory chip and an explicit-approval chip.
  // They collapse into ONE pill, chosen by a strict precedence:
  //
  //   0 settled        ✓ Merged
  //   1 in flight      Merging… / Resolving conflicts…      (spinner)
  //   2 blocked        Checks failing · N / Checks couldn't run /
  //                    Preview won't boot / Merge conflict /
  //                    Conflict resolution failed / Behind main · N
  //   3 contested      Contested · 4/6
  //   4 counting down  Merging in ~2d / Merging in 5h · 1/2 / Rejecting in ~6h
  //   5 needs my vote  Vote · 2/5                           (pulsing dot)
  //   6 plain tally    3 / 5 · 2 of 3 approvals
  //
  // Tiers 3-6 keep voteCountPill's proportional fill (Yes stripe on top, No
  // stripe below, each a fraction of the threshold); tiers 0-2 are a solid
  // token tone. Checks-failing must NEVER degrade to a neutral tally — the
  // pill's whole job is that a glance says whether the thing can land.
  //
  // Deliberately a NEW function rather than a rewrite of voteCountPill:
  // group-chat.js's inline vote rows and home-panels.js's "Your proposals"
  // strip still consume voteCountPill / MergeStatus.pillHtml, and migrating
  // them is separate follow-up work.
  //
  // `kind` ∈ 'proposal' | 'gov' | 'merged'. Pure given (item, opts) apart
  // from reading _proposalsCtx for the fallbacks, so it unit-tests cleanly.
  STATUS_PILL_TONES: ['neutral', 'progress', 'attention', 'blocked', 'ok'],

  // The ordered set of reasons a live proposal cannot merge right now.
  // Highest-severity first, which is also the order the pill picks its
  // single label from. Each entry is { key, label, detail } — `label` is the
  // pill wording, `detail` the sentence the detail view spells out. Empty
  // array = nothing is blocking. Pure; no DOM, no state reads.
  blockReasons(pr) {
    const p = pr || {};
    const out = [];
    // Merge-pipeline conflicts: a real attempt failed and a human is needed.
    if (p.merge_conflict_state === 'failed') {
      out.push({
        key: 'conflict_failed',
        label: 'Conflict resolution failed',
        detail: 'The last automatic conflict resolution failed — the proposal’s owner needs to resolve it manually from their dev session.',
      });
    } else if (p.merge_conflict_state === 'conflict') {
      out.push({
        key: 'merge_conflict',
        label: 'Merge conflict',
        detail: 'A merge was attempted but this proposal conflicts with main. Its creator needs to finish the merge from their dev session ("Sync with main").',
      });
    }
    // Checks: the real merge gate.
    if (p.check_state === 'error') {
      out.push({
        key: 'preview_failed',
        label: 'Preview won’t boot',
        detail: p.check_error_detail
          ? `The staging preview failed to start, so automated checks can’t run: ${String(p.check_error_detail).slice(0, 300)}`
          : 'The staging preview failed to start, so automated checks couldn’t run.',
      });
    } else if (p.check_state === 'failing') {
      const failed = Array.isArray(p.test_results)
        ? p.test_results.filter((r) => r && r.status !== 'pass') : [];
      const n = failed.length;
      out.push({
        key: 'checks_failing',
        label: n ? `Checks failing · ${n}` : 'Checks failing',
        detail: n
          ? `${n} automated test${n === 1 ? '' : 's'} failed on the staging build: ${failed.map((r) => r.name || r.path || 'test').join(', ')}.`
          : 'Automated tests are not passing on the staging build.',
      });
    }
    // Behind main resolves itself, so it is the mildest blocking reason —
    // last in the list and rendered `attention` rather than `blocked`.
    const behind = parseInt(p.behind_main, 10) || 0;
    if (behind > 0 || p.merge_conflict_state === 'behind') {
      out.push({
        key: 'behind',
        label: behind ? `Behind main · ${behind}` : 'Behind main',
        detail: behind
          ? `This proposal is ${behind} commit${behind === 1 ? '' : 's'} behind main — syncing automatically, then it retries the merge.`
          : 'This proposal is behind main — syncing automatically, then it retries the merge.',
        soft: true,
      });
    }
    // Console errors never block the vote, but they belong in the same
    // "what's wrong with this" list the detail view enumerates.
    if (p.console_check_state === 'errors') {
      const n = Array.isArray(p.console_errors) ? p.console_errors.length : 0;
      out.push({
        key: 'console_errors',
        label: n ? `Console errors · ${n}` : 'Console errors',
        detail: n
          ? `The staging preview logged ${n} console error${n === 1 ? '' : 's'} — this change may break the app. It does not block the merge.`
          : 'The staging preview logged console errors — this change may break the app. It does not block the merge.',
        soft: true,
        advisory: true,
      });
    }
    return out;
  },

  // The pill's derived state, separated from its markup so the precedence
  // itself is unit-testable: { tier, key, label, tone, spinner, dot, fill,
  // yes, no, majority, suffix, reasons, lock, advisory }.
  statusPillState(item, opts) {
    const p = item || {};
    const o = opts || {};
    const ctx = AppView._proposalsCtx || {};
    const snap = parseInt(p.votes_required, 10);
    const hasSnap = Number.isFinite(snap) && snap > 0;
    const maj = hasSnap ? snap : (parseInt(o.majority, 10) || parseInt(ctx.majority, 10) || 1);
    const yes = p.qualified_yes_count != null
      ? (parseInt(p.qualified_yes_count, 10) || 0) : (parseInt(p.yes_count, 10) || 0);
    const no = p.qualified_no_count != null
      ? (parseInt(p.qualified_no_count, 10) || 0) : (parseInt(p.no_count, 10) || 0);
    const isOpenRow = p.status !== 'merged' && p.status !== 'merging';
    // Advisory (non-approver) surplus rides inside the label as a muted
    // suffix instead of a separate chip beside the pill.
    const advisory = (p.approval_policy === 'invited' && p.qualified_yes_count != null && isOpenRow)
      ? Math.max(0, (parseInt(p.yes_count, 10) || 0) - yes) : 0;
    const lock = !!(p.requires_explicit_approval && isOpenRow);
    const base = { yes, no, majority: maj, advisory, lock, reasons: [] };

    // 0 — settled.
    if (p.status === 'merged') {
      return { ...base, tier: 0, key: 'merged', label: '✓ Merged', tone: 'ok', lock: false, advisory: 0 };
    }
    // 1 — in flight.
    if (p.status === 'merging') {
      return { ...base, tier: 1, key: 'merging', label: 'Merging…', tone: 'progress', spinner: true, lock: false, advisory: 0,
        title: 'This change is being merged into the app and production is rebuilding.' };
    }
    if (p.merge_conflict_state === 'resolving' || p.resolving === true) {
      return { ...base, tier: 1, key: 'resolving', label: 'Resolving conflicts…', tone: 'progress', spinner: true,
        title: 'Reconciling conflicts with main automatically, then retrying the merge.' };
    }
    // 2 — blocked. The single most severe reason is the label; the rest ride
    // in the tooltip and are enumerated in full in the detail view.
    // `soft` reasons (behind main / console errors) are `attention`.
    // blockReasons is severity-ordered, so reasons[0] IS the label. `soft`
    // reasons (behind main, console errors) render `attention` and keep the
    // tally riding along in the label — they don't stop the thing landing, so
    // the vote is still the other half of the story. A HARD reason drops the
    // tally: the count isn't what matters when it can't merge either way.
    // opts.kind ∈ 'proposal' (default) | 'gov'. A governance proposal has no
    // branch, no staging build and no checks, so every checks/conflict state
    // below is inapplicable to it — including the #607 "no verdict recorded
    // yet" branch, which would otherwise label every gov row "Checks
    // starting…" purely because it has no check_state to record.
    const isCode = (o.kind || 'proposal') !== 'gov';
    const reasons = isCode ? AppView.blockReasons(p) : [];
    if (reasons.length && isOpenRow) {
      const top = reasons[0];
      const soft = !!top.soft;
      return {
        ...base,
        tier: 2,
        key: top.key,
        label: soft ? `${top.label} · ${yes}/${maj}` : top.label,
        tone: soft ? 'attention' : 'blocked',
        fill: soft,
        // A HARD block drops the tally, so the advisory surplus has no
        // tally to be a surplus OF — appending it there reads as part of
        // the reason ('Merge conflict+1'). Soft reasons keep it.
        advisory: soft ? advisory : 0,
        reasons,
      };
    }
    // Checks still running / not yet started / skipped: not blocked in the
    // "someone must fix this" sense, but merge is gated, so it outranks the
    // vote states — neutral, with a spinner while genuinely in flight.
    if (isCode && (p.check_state === 'pending'
      || (!p.check_state && p.status === 'promoted' && !p.console_check_state))) {
      return { ...base, tier: 2, key: 'checks_running',
        label: p.check_state === 'pending' ? 'Checks running…' : 'Checks starting…',
        tone: 'neutral', spinner: true, reasons, advisory: 0,
        title: 'Automated tests are still running on the staging build — merge is blocked until they pass.' };
    }
    // 3 — contested: the timed path is off, it needs a straight majority.
    if (isOpenRow && p.contested) {
      return { ...base, tier: 3, key: 'contested', label: `Contested · ${yes}/${maj}`, tone: 'attention', fill: true, reasons,
        title: 'Enough No votes that the time-based merge path is off — this needs a straight majority of Yes votes.' };
    }
    // "At least N approvals" mode is clock-free, so it can't count down.
    if (p.approvals_required != null && isOpenRow) {
      const n = parseInt(p.approvals_required, 10) || 1;
      const reached = yes >= n;
      return { ...base, tier: 6, key: 'approvals', majority: n, fill: true, reached,
        label: `${yes} of ${n} approval${n === 1 ? '' : 's'}`,
        tone: reached ? 'ok' : 'progress', reasons,
        title: reached
          ? `Approval target reached (${yes} of ${n}) — merges as soon as checks pass`
          : `Needs at least ${n} approval${n === 1 ? '' : 's'} to merge` };
    }
    // 4 — counting down. A flagged (admins-changing) row never merges on a
    // clock, so it must never promise one even from a stale cached row.
    const windowEndsMs = p.merge_window_ends_at ? Date.parse(p.merge_window_ends_at) : NaN;
    const inWindow = Number.isFinite(windowEndsMs) && windowEndsMs > Date.now();
    const reachedMaj = yes >= maj;
    const lazyLead = !reachedMaj && yes >= 1 && yes > no;
    if (isOpenRow && !p.requires_explicit_approval && inWindow && (reachedMaj || lazyLead)) {
      const suffix = reachedMaj ? '' : ` · ${yes}/${maj}`;
      return { ...base, tier: 4, key: 'merge_countdown', tone: 'ok', fill: 'full-yes', countdown: windowEndsMs,
        label: `Merging in ${AppView._fmtCountdown(windowEndsMs - Date.now())}${suffix}`,
        suffix, reasons,
        title: reachedMaj
          ? `Enough yes votes (${yes} / ${maj}) — merges when the visibility window elapses unless opposed`
          : `Has support (${yes} / ${maj} yes) and no opposition — merges when the countdown ends unless more votes arrive` };
    }
    const rejectEndsMs = p.reject_window_ends_at ? Date.parse(p.reject_window_ends_at) : NaN;
    if (isOpenRow && p.rejection_armed && Number.isFinite(rejectEndsMs) && rejectEndsMs > Date.now()) {
      return { ...base, tier: 4, key: 'reject_countdown', tone: 'blocked', fill: 'full-no', countdown: rejectEndsMs, reject: true,
        label: `Rejecting in ${AppView._fmtCountdown(rejectEndsMs - Date.now())}`, reasons,
        title: `More No than Yes and not enough support (${yes} / ${maj}) — closes when this elapses unless support arrives` };
    }
    // 5 — needs your vote. Absorbs the standalone pulsing "Vote" badge.
    if (p.status === 'promoted' && !p.my_vote && !AppView.readOnly) {
      return { ...base, tier: 5, key: 'needs_vote', label: `Vote · ${yes}/${maj}`, tone: 'progress', fill: true, dot: true, reasons,
        title: 'You haven’t voted on this yet' };
    }
    // 6 — plain tally.
    const outcome = yes >= maj ? 'ok' : no >= maj ? 'blocked' : 'progress';
    const activeAtMerge = parseInt(p.active_users_at_merge, 10);
    return { ...base, tier: 6, key: 'tally', label: `${yes} / ${maj}`, tone: outcome, fill: true, reasons,
      title: (hasSnap && Number.isFinite(activeAtMerge) && activeAtMerge > 0)
        ? `needed ${snap} of ${activeAtMerge} active users at merge time` : undefined };
  },

  // Render the composite pill. Reuses .gc-vote-count's shell (and its
  // proportional-fill children) so the geometry is identical to what the
  // tally pill always had — only the label, tone and what's folded inside
  // it change.
  statusPillHtml(item, opts) {
    if (!item) return '';
    const o = opts || {};
    const s = AppView.statusPillState(item, o);
    if (!s || !s.label) return '';
    // Fill: `true` = proportional stripes, 'full-yes'/'full-no' = solid.
    let fills = '';
    if (s.fill === 'full-yes') {
      fills = '<span class="gc-vote-fill gc-vote-fill-full gc-vote-fill-full-yes"></span>';
    } else if (s.fill === 'full-no') {
      fills = '<span class="gc-vote-fill gc-vote-fill-full gc-vote-fill-full-no"></span>';
    } else if (s.fill) {
      const maj = s.majority || 1;
      if (s.yes >= maj) {
        fills = '<span class="gc-vote-fill gc-vote-fill-full gc-vote-fill-full-yes"></span>';
      } else if (s.no >= maj) {
        fills = '<span class="gc-vote-fill gc-vote-fill-full gc-vote-fill-full-no"></span>';
      } else {
        fills = `<span class="gc-vote-fill gc-vote-fill-yes" style="width:${Math.min(100, (s.yes / maj) * 100)}%"></span>`
          + `<span class="gc-vote-fill gc-vote-fill-no" style="width:${Math.min(100, (s.no / maj) * 100)}%"></span>`;
      }
    }
    const dot = s.dot
      ? '<span class="gc-vote-count-dot"><span class="gc-vote-count-dot-ping"></span><span class="gc-vote-count-dot-core"></span></span>'
      : '';
    const spinner = s.spinner
      ? '<span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>'
      : '';
    const advisory = s.advisory > 0
      ? `<span class="gc-vote-count-suffix" title="${escapeAttr(`${s.advisory} advisory vote${s.advisory === 1 ? '' : 's'} from non-approvers — they don't count toward merging`)}">+${s.advisory}</span>`
      : '';
    const lock = s.lock
      ? '<span class="gc-vote-count-lock" aria-hidden="true" title="This changes who can administer the app, so it won’t merge on a timer — it needs real Yes votes to reach the app’s normal threshold.">&#128274;</span>'
      : '';
    // "and N more reasons" — the pill names the worst one; the detail view
    // enumerates every one of them.
    const extra = Array.isArray(s.reasons) ? Math.max(0, s.reasons.length - 1) : 0;
    const titleParts = [];
    if (s.title) titleParts.push(s.title);
    else if (s.reasons && s.reasons[0]) titleParts.push(s.reasons[0].detail);
    if (s.tier === 2 && extra > 0) {
      titleParts.push(`and ${extra} more reason${extra === 1 ? '' : 's'} — open for details`);
    }
    const title = titleParts.length ? ` title="${escapeAttr(titleParts.join(' · '))}"` : '';
    // The 30s ticker rewrites countdown labels in place; carry the same
    // data-window-ends / data-label-suffix contract voteCountPill uses.
    const cd = s.countdown
      ? ` ${s.reject ? 'gc-reject-countdown' : 'gc-merge-countdown'}" data-window-ends="${s.countdown}"${s.suffix ? ` data-label-suffix="${escapeAttr(s.suffix)}"` : ''}`
      : '"';
    // Full-width by default (the board): the pill spans the card's content
    // width so the proportional fill reads as a progress bar rather than a
    // thumbnail-sized capsule. opts.inline keeps the old capsule for any
    // caller that wants it in a row of chips (the detail head uses it).
    const block = o.inline ? '' : ' dev-status-pill-block';
    return `<span class="gc-vote-count gc-vote-count-${s.tone} dev-status-pill${block}${cd}${title}>`
      + fills
      + `<span class="gc-vote-count-label">${dot}${spinner}${escapeHtml(s.label)}${advisory}${lock}</span>`
      + '</span>';
  },

  // ── The badge budget ─────────────────────────────────────────────────
  //
  // A card carries AT MOST BADGE_MAX badges, plus the 💬 count pinned
  // outside the cap (it is a count-with-shortcut, not a status signal).
  // Priority, highest first:
  //
  //   1 In progress · X                  (issues)
  //   2 priority   — only when set
  //   3 assignee   — only when set
  //   4 category   — only when set
  //
  // The composite status pill USED to lead this row and count against the
  // cap. It is now its own full-width row below the head (see
  // _cardContentHtml), so the cap governs the metadata chips only — which
  // is also why four is still the right number: that is exactly the set.
  //
  // Everything that used to compete for this row — Auto-title pending,
  // Imported PR, Built with <agent>, Platform maintenance, Explicit
  // approval, Console errors, the ★ bounty count — moved out: provenance
  // and the bounty are plain words on the META LINE, the rest are folded
  // into the pill (lock glyph / tooltip) and spelled out in the detail view.
  BADGE_MAX: 4,
  _cardBadgesHtml(badges, chatCount, opts) {
    const all = (badges || []).filter(Boolean);
    // opts.uncapped — the topic detail head, which has the full page width
    // and is where every chip must be reachable. The BOARD always caps.
    const kept = (opts && opts.uncapped) ? all : all.slice(0, AppView.BADGE_MAX);
    const chat = (chatCount === null || chatCount === undefined)
      ? '' : AppView._devChatBadge(chatCount);
    return kept.join('') + chat;
  },

  voteCountPill(pr, majority) {
    if (!pr) return '';
    // #58: for merged PRs prefer the threshold snapshotted at merge time
    // (votes_required) so the denominator reflects history rather than the
    // live majority. Open PRs (and legacy merged rows with no snapshot) fall
    // back to the live majority passed in.
    const snap = parseInt(pr.votes_required);
    const hasSnap = Number.isFinite(snap) && snap > 0;
    const maj = hasSnap ? snap : (majority || 1);
    // #646: when only invited approvers' votes count, the pill fills
    // from the QUALIFYING tallies (qualified_*_count, serialized by
    // /promoted); raw tallies keep rendering in the roster/labels.
    const yes = pr.qualified_yes_count != null
      ? (parseInt(pr.qualified_yes_count) || 0) : (parseInt(pr.yes_count) || 0);
    const no = pr.qualified_no_count != null
      ? (parseInt(pr.qualified_no_count) || 0) : (parseInt(pr.no_count) || 0);
    const state = yes >= maj ? 'yes' : no >= maj ? 'no' : 'pending';

    // #695: on invited-approver apps, non-approver Yes votes are advisory —
    // rendered as a muted chip beside the pill, never inside the headline
    // tally. Suppressed on settled (merged/merging) rows: the vote is
    // history there and the snapshot pill stands alone.
    const advisoryYes = (pr.approval_policy === 'invited'
        && pr.qualified_yes_count != null
        && pr.status !== 'merged' && pr.status !== 'merging')
      ? Math.max(0, (parseInt(pr.yes_count) || 0) - yes) : 0;
    const advisoryChip = advisoryYes > 0
      ? `<span class="gc-vote-advisory" title="${advisoryYes} advisory Yes vote${advisoryYes === 1 ? '' : 's'} from non-approvers — they don't count toward merging">+${advisoryYes} advisory</span>`
      : '';

    // #788: this proposal changes who can administer the app. The app's
    // normal threshold is unchanged — only the clocks are off — so the
    // chip sits BESIDE the ordinary tally rather than replacing it.
    // Suppressed on settled rows (the vote is history there).
    const explicitChip = (pr.requires_explicit_approval
        && pr.status !== 'merged' && pr.status !== 'merging')
      ? '<span class="gc-vote-explicit" title="This changes the app\'s admins, so it won\'t merge on a timer — it needs real Yes votes to reach the app\'s normal threshold. It can still be voted down.">Explicit approval</span>'
      : '';

    // #646: "at least N" mode — a clock-free approvals-progress pill
    // ("x of N approvals"). The server never arms a merge/rejection
    // window in this mode, so the countdown branches below can't fire.
    if (pr.approvals_required != null && pr.status !== 'merged' && pr.status !== 'merging') {
      const n = parseInt(pr.approvals_required) || 1;
      const reached = yes >= n;
      const who = pr.approval_policy === 'invited' ? 'invited approvers' : 'any user';
      const title = reached
        ? `Approval target reached (${yes} of ${n}) — merges as soon as checks pass`
        : `Needs at least ${n} approval${n === 1 ? '' : 's'} from ${who} to merge`;
      const fills = reached
        ? `<span class="gc-vote-fill gc-vote-fill-full gc-vote-fill-full-yes"></span>`
        : `<span class="gc-vote-fill gc-vote-fill-yes" style="width:${Math.min(100, (yes / n) * 100)}%"></span>`;
      return `<span class="gc-vote-count gc-vote-count-${reached ? 'yes' : 'pending'}" title="${title}">`
        + fills
        + `<span class="gc-vote-count-label">${yes} of ${n} approval${n === 1 ? '' : 's'}</span>`
        + `</span>` + advisoryChip + explicitChip;
    }

    // Countdown state: a merge clock is running. Two ways one arms (both
    // serialized by the server as merge_window_ends_at — see mergeGate in
    // src/services/active-users.js):
    //   - threshold met, minimum visibility window still running, or
    //   - lazy consensus: below threshold but Yes strictly leads with no
    //     contest — the proposal auto-merges when the clock ends unless
    //     someone objects (silence is consent).
    // Render "Merging in ~X" instead of the bare tally so voters see it's
    // on track and how long they have left to object. Only for live (not
    // merged/merging) rows — a settled row never counts down. The
    // `gc-merge-countdown` class + data-window-ends drive the client timer.
    const isOpenRow = pr.status !== 'merged' && pr.status !== 'merging';
    const windowEndsMs = pr.merge_window_ends_at ? Date.parse(pr.merge_window_ends_at) : NaN;
    const inWindow = Number.isFinite(windowEndsMs) && windowEndsMs > Date.now();
    const lazyLead = state === 'pending' && yes >= 1 && yes > no;
    // #788: a flagged row never merges on a clock, so it must never
    // render a merge countdown. The server already sends no
    // merge_window_ends_at for one; this is the belt-and-braces guard so
    // a stale cached row can't promise a merge that will never happen.
    if (isOpenRow && !pr.requires_explicit_approval
      && !pr.contested && inWindow && (state === 'yes' || lazyLead)) {
      const label = AppView._fmtCountdown(windowEndsMs - Date.now());
      const title = state === 'yes'
        ? `Enough yes votes (${yes} / ${maj}) — merges when the visibility window elapses unless opposed`
        : `Has support (${yes} / ${maj} yes) and no opposition — merges when the countdown ends unless more votes arrive`;
      // Below threshold the tally rides along in the label so it's clear
      // the vote is still open and can be swung either way. The suffix is
      // mirrored into data-label-suffix so the 30s ticker preserves it when
      // it rewrites the label (see _startMergeCountdownTimer).
      const suffix = state === 'yes' ? '' : ` · ${yes}/${maj}`;
      const suffixAttr = suffix ? ` data-label-suffix="${suffix}"` : '';
      return `<span class="gc-vote-count gc-vote-count-yes gc-merge-countdown" data-window-ends="${windowEndsMs}"${suffixAttr}`
        + ` title="${title}">`
        + `<span class="gc-vote-fill gc-vote-fill-full gc-vote-fill-full-yes"></span>`
        + `<span class="gc-vote-count-label">Merging in ${label}${suffix}</span>`
        + `</span>` + advisoryChip + explicitChip;
    }

    // Rejection (auto-takedown) countdown: the group is voting this down
    // (No > Yes, under the 1/3 support line) and the takedown clock is armed.
    // Render a red "Rejecting in ~X" pill. Mutually exclusive with the merge
    // countdown above (can't reach the Yes threshold while losing). The
    // `gc-reject-countdown` class + data-window-ends drive the same timer.
    const rejectEndsMs = pr.reject_window_ends_at ? Date.parse(pr.reject_window_ends_at) : NaN;
    const inReject = Number.isFinite(rejectEndsMs) && rejectEndsMs > Date.now();
    if (isOpenRow && pr.rejection_armed && inReject) {
      const label = AppView._fmtCountdown(rejectEndsMs - Date.now());
      return `<span class="gc-vote-count gc-vote-count-no gc-reject-countdown" data-window-ends="${rejectEndsMs}"`
        + ` title="More No than Yes and not enough support (${yes} / ${maj}) — closes when this elapses unless support arrives">`
        + `<span class="gc-vote-fill gc-vote-fill-full gc-vote-fill-full-no"></span>`
        + `<span class="gc-vote-count-label">Rejecting in ${label}</span>`
        + `</span>` + advisoryChip + explicitChip;
    }
    // #58: when both at-merge figures are present, surface the historical
    // context as a hover tooltip on the pill. Only merged rows carry these.
    const activeAtMerge = parseInt(pr.active_users_at_merge);
    const titleAttr = (hasSnap && Number.isFinite(activeAtMerge) && activeAtMerge > 0)
      ? ` title="needed ${snap} of ${activeAtMerge} active users at merge time"`
      : '';
    let fills;
    if (state === 'yes' || state === 'no') {
      // Finalized: a side reached majority — the whole pill fills solid with
      // the winning side's color (green = Yes, red = No).
      fills = `<span class="gc-vote-fill gc-vote-fill-full gc-vote-fill-full-${state}"></span>`;
    } else {
      // In progress: top stripe = Yes share, bottom stripe = No share, each a
      // fraction of the majority threshold, filling left→right.
      const yesPct = Math.min(100, (yes / maj) * 100);
      const noPct = Math.min(100, (no / maj) * 100);
      fills = `<span class="gc-vote-fill gc-vote-fill-yes" style="width:${yesPct}%"></span>`
        + `<span class="gc-vote-fill gc-vote-fill-no" style="width:${noPct}%"></span>`;
    }
    return `<span class="gc-vote-count gc-vote-count-${state}"${titleAttr}>`
      + fills
      + `<span class="gc-vote-count-label">${yes} / ${maj}</span>`
      + `</span>` + advisoryChip + explicitChip;
  },

  // "Merging…" badge shown alongside (not instead of) the vote controls
  // once a PR crosses the threshold and the merge pipeline is in flight.
  // Shared by the vote panel rows and the inline group-chat rows.
  mergingBadgeHtml() {
    return `<span class="gc-merging-badge"><span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>Merging…</span>`;
  },

  // "Merged" badge — the settled counterpart of the merging badge, shown
  // next to the (now read-only) tally pill / "You voted X" box on group-chat
  // rows after a PR lands so the voting info doesn't disappear.
  mergedBadgeHtml() {
    return `<span class="gc-merged-badge">✓ Merged</span>`;
  },

  // #361's persistent merge-status badges (conflictFailedBadgeHtml /
  // behindBadgeHtml) are GONE: the composite status pill derives
  // "Conflict resolution failed" and "Behind main · N" from blockReasons()
  // and renders them itself, and no other surface ever called them.
  // MergeStatus.badgeHtml still covers the home strip's equivalents.

  // #967: the "built with …" provenance chip for a proposal that arrived
  // through the hosted MCP connector — the code was written by the
  // proposer's OWN coding agent (Claude Code on the web, or Codex), on
  // their subscription, in their own GitHub fork.
  //
  // The vocabulary is closed on purpose. chat_sessions.external_agent is
  // written only by services/external-agent-tasks.js from a fixed set, and
  // an unrecognised value renders the generic label rather than whatever
  // string reached the row — a provenance badge that prints server data
  // verbatim is a provenance badge worth spoofing.
  EXTERNAL_AGENT_NAMES: {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    external: 'an external coding agent',
  },

  externalAgentName(value) {
    if (!value) return '';
    return AppView.EXTERNAL_AGENT_NAMES[value] || AppView.EXTERNAL_AGENT_NAMES.external;
  },

  externalAgentBadgeHtml(value) {
    const name = AppView.externalAgentName(value);
    if (!name) return '';
    const label = (value === 'claude-code' || value === 'codex')
      ? `Built with ${name}` : 'Built with a coding agent';
    return `<span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 shrink-0" title="${escapeHtml('The code was written by the proposer’s own coding agent (' + name + ') on their subscription, in their GitHub fork. Usernode opened the pull request; the group still votes on it.')}">${escapeHtml(label)}</span>`;
  },

  // #381: advisory "may break the app" warning. Shown alongside (not
  // instead of) the merge-state badge when the proposal's staging preview
  // logged console errors / uncaught exceptions / a failed load. Amber, not
  // red — it never blocks the vote (parallels "Behind main"). Only the
  // 'errors' state badges; 'clean'/'unknown'/missing render nothing.
  consoleWarningBadgeHtml(pr) {
    if (!pr || pr.console_check_state !== 'errors') return '';
    const n = Array.isArray(pr.console_errors) ? pr.console_errors.length : 0;
    const label = n ? `Console errors · ${n}` : 'Console errors';
    const title = n
      ? `The staging preview logged ${n} console error${n === 1 ? '' : 's'} — this change may break the app. Open the discussion to see them.`
      : 'The staging preview logged console errors — this change may break the app.';
    return `<span class="gc-warning-badge" title="${escapeHtml(title)}">⚠ ${escapeHtml(label)}</span>`;
  },

  // NOTE: the dev board no longer renders this badge — the composite status
  // pill (statusPillHtml) folds the checks verdict into its own precedence,
  // which is what stopped a proposal showing "Behind main · 2" AND "Checks
  // failing · 3" AND "Console errors · 4" side by side. The helper stays
  // because it is still the canonical standalone renderer for these states
  // (with the per-test counts) for any surface that wants one badge rather
  // than a whole lifecycle pill.
  //
  // #47: "CI for proposals" checks badge — the pass/fail status of the
  // proposal's automated tests against its staging build (check_state from
  // GET /api/apps/:slug/promoted). Unlike the advisory console badge this
  // mirrors a real merge gate (votes.checkAndMerge blocks a non-'passing'
  // proposal), so the badge is the user-facing signal for "can this land".
  //   passing → green ✓        failing → amber ⚠ · N
  //   pending → grey spinner    error  → red ⚠ couldn't run
  // Legacy rows with no check_state fall back to the advisory console badge
  // so a mid-rollout proposal still shows something useful.
  checksBadgeHtml(pr) {
    if (!pr) return '';
    // A merged proposal passed the gate by definition — the "✓ Merged"
    // badge says it all; don't stack a redundant "✓ Checks passing".
    if (pr.status === 'merged') return '';
    const state = pr.check_state;
    if (!state) {
      // #607: a fresh proposal with NOTHING recorded yet (post-#47 rows
      // dual-write console_check_state alongside every verdict, so both
      // missing means the first run hasn't stamped 'pending' yet — e.g.
      // the promote-time staging build is still going). Show the spinner
      // instead of silence. Rows carrying a console snapshot are genuine
      // pre-#47 legacy — keep their advisory fallback.
      if (!pr.console_check_state) {
        return `<span class="gc-checks-running-badge" title="The staging preview is being prepared and automated tests are about to run — merge is blocked until they pass."><span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>Checks starting…</span>`;
      }
      return AppView.consoleWarningBadgeHtml(pr);
    }
    if (state === 'passing') {
      // Its own class, not .gc-merged-badge: sharing that class is what
      // made the PASSING badge inherit the violet 'Merged' colour. Both are
      // the `ok` token now, but separate classes keep them independent.
      return `<span class="gc-checks-passing-badge" title="All automated tests passed on the staging build">✓ Checks passing</span>`;
    }
    if (state === 'failing') {
      const n = Array.isArray(pr.test_results)
        ? pr.test_results.filter((r) => r && r.status !== 'pass').length : 0;
      const label = n ? `Checks failing · ${n}` : 'Checks failing';
      const title = n
        ? `${n} automated test${n === 1 ? '' : 's'} failed on the staging build — merge is blocked until checks pass. Open the discussion to see them.`
        : 'Automated tests failed on the staging build — merge is blocked until checks pass.';
      return `<span class="gc-blocked-badge" title="${escapeHtml(title)}">⚠ ${escapeHtml(label)}</span>`;
    }
    if (state === 'error') {
      return `<span class="gc-conflict-badge" title="The staging build or the test run itself broke, so the platform can't confirm the app works — merge is blocked until checks pass.">⚠ Checks couldn't run</span>`;
    }
    if (state === 'skipped') {
      // #461: explicit terminal "nothing to test" verdict — grey, no
      // spinner, and NON-blocking (the merge gate treats it like passing).
      const why = pr.check_error_detail
        ? `Automated checks were skipped — ${String(pr.check_error_detail).slice(0, 280)}. This does not block the merge.`
        : 'Automated checks were skipped — there was nothing to test. This does not block the merge.';
      return `<span class="gc-checks-running-badge" title="${escapeHtml(why)}">Checks skipped</span>`;
    }
    // 'pending' (or anything else): tests are still running. #405: grey
    // (gc-checks-running-badge), not amber, so a not-yet-started check is
    // visibly distinct from the amber in-flight merge stages.
    return `<span class="gc-checks-running-badge" title="Automated tests are still running on the staging build — merge is blocked until they pass."><span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>Checks running…</span>`;
  },

  // #195/#270: before/after visual tiles for a session's stored capture
  // artifacts. `visuals` is the server shape — either the grouped form
  // { captures: [ { index, path, before: {png,webm,gif}, after: {...} } ] }
  // (one group per captured route), or the legacy flat form
  // { before, after, capturedPath } which is normalized to a single group.
  // Shared by the vote-panel PR rows here and the dev-chat staging card
  // (which calls through window.AppView). Webm plays as a silent loop with
  // the PNG as poster; PNG-only sets render a plain image. Clicking a tile
  // opens an in-app side-by-side comparison overlay (openVisualComparison)
  // rather than the raw asset in a new tab (#353) — each tile carries the
  // whole group's artifact ids as data-* attributes so the overlay can
  // show before+after together. One labelled row per group — the label
  // names the captured path so reviewers see which screen each pair shows;
  // a single root-only group renders unlabelled, exactly as before.
  // Deliberately dedicated DOM — the markdown sanitizer's whitelist stays
  // untouched (<img>/<video> remain stripped from chat markdown).
  // `opts` (added for the admin /gallery page) tunes two things without
  // forking this renderer, so the proposal-card and dev-chat call sites stay
  // byte-identical when it's omitted:
  //   preload — 'none' makes recordings click-to-play instead of autoplaying
  //             looped. The gallery renders up to 20 proposals per page, and
  //             that many autoplaying clips is not acceptable.
  //   overlay — false drops the openVisualComparison click wiring, which
  //             depends on SPA state the standalone gallery page doesn't have
  //             (tiles then render as plain, non-interactive figures).
  visualsTilesHtml(visuals, opts = {}) {
    if (!visuals) return '';
    const clickToPlay = opts.preload === 'none';
    const overlay = opts.overlay !== false;
    const groups = Array.isArray(visuals.captures)
      ? visuals.captures
      : ((visuals.before || visuals.after)
        ? [{ path: visuals.capturedPath || '/', before: visuals.before, after: visuals.after }]
        : []);
    if (!groups.length) return '';

    const idOk = (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
    // Sanitize one side's media ids into a `png|webm|gif`-keyed object of
    // validated 32-hex ids (or null per slot). Reused by the data-*
    // attribute encoder and the overlay builder.
    const sideIds = (v) => {
      if (!v) return null;
      const png = idOk(v.png) ? v.png : null;
      const webm = idOk(v.webm) ? v.webm : null;
      const gif = idOk(v.gif) ? v.gif : null;
      return (png || webm || gif) ? { png, webm, gif } : null;
    };
    // A clickable tile for one side. Carries the FULL group's ids (both
    // sides) plus which side was clicked, so the overlay opens straight
    // onto the matching pair. ids are 32-hex-validated, so they're safe
    // inside the data-* attributes; path goes through esc(). `mobile`
    // flags a phone-frame capture group (#768) so the overlay can label it.
    const tile = (label, side, b, a, path, mobile) => {
      const v = side === 'before' ? b : a;
      if (!v) return '';
      const mediaStyle = 'display:block;width:100%;max-height:160px;object-fit:contain;object-position:top;background:rgba(0,0,0,0.25);border:1px solid rgba(127,127,127,0.25);border-radius:6px';
      // Gallery mode (preload:'none') makes the clip click-to-play with the
      // still as its poster; the default stays the autoplaying silent loop.
      const media = v.webm
        ? (clickToPlay
          ? `<video src="/visuals/${v.webm}"${v.png ? ` poster="/visuals/${v.png}"` : ''} muted loop playsinline controls preload="none" style="${mediaStyle}"></video>`
          : `<video src="/visuals/${v.webm}"${v.png ? ` poster="/visuals/${v.png}"` : ''} muted loop autoplay playsinline style="${mediaStyle}"></video>`)
        : `<img src="/visuals/${v.png || v.gif}" alt="${label}" loading="lazy" style="${mediaStyle}">`;
      // Gallery mode makes a missing recording visible rather than invisible
      // (the whole point of the reliability work) — a still-only tile is
      // marked "no recording" beside its label.
      const marker = (clickToPlay && !v.webm)
        ? ' <span class="text-zinc-400 dark:text-zinc-500" style="text-transform:none;letter-spacing:0">· no recording</span>'
        : '';
      const labelHtml = `<div class="text-[0.65rem] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400" style="margin-bottom:2px">${label}${marker}</div>`;
      // Without the overlay there's nothing to click — render an inert
      // figure so the tile isn't a button that does nothing.
      if (!overlay) {
        return `<figure ${mobile ? 'data-viewport="mobile"' : ''} data-visual-tile="${side}" data-path="${esc(path)}" style="flex:1 1 0;min-width:0;display:block;margin:0">
          ${labelHtml}
          ${media}
        </figure>`;
      }
      const dataAttrs = [
        `data-visual-tile="${side}"`,
        `data-path="${esc(path)}"`,
        mobile ? 'data-viewport="mobile"' : '',
        b && b.png ? `data-before-png="${b.png}"` : '',
        b && b.webm ? `data-before-webm="${b.webm}"` : '',
        b && b.gif ? `data-before-gif="${b.gif}"` : '',
        a && a.png ? `data-after-png="${a.png}"` : '',
        a && a.webm ? `data-after-webm="${a.webm}"` : '',
        a && a.gif ? `data-after-gif="${a.gif}"` : '',
      ].filter(Boolean).join(' ');
      return `<button type="button" ${dataAttrs} title="${label} — open before/after comparison" style="flex:1 1 0;min-width:0;display:block;text-align:left;padding:0;border:0;background:none;cursor:pointer;font:inherit;color:inherit" onclick="AppView.openVisualComparison(this)">
        <div class="text-[0.65rem] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400" style="margin-bottom:2px">${label}</div>
        ${media}
      </button>`;
    };

    const single = groups.length === 1;
    const rows = [];
    for (const g of groups) {
      const b = sideIds(g.before);
      const a = sideIds(g.after);
      const path = g.path || '/';
      const mobile = g.viewport === 'mobile';
      const before = tile('Before', 'before', b, a, path, mobile);
      const after = tile('After', 'after', b, a, path, mobile);
      if (!after && !before) continue;
      // Label the row with its captured path unless it's the single
      // root-only DESKTOP group (unchanged from the pre-#270 single-tile
      // output). A mobile group (#768) is always labelled — the phone
      // frame needs calling out even at the root.
      const label = (single && (path === '/' || !path) && !mobile)
        ? ''
        : `<div class="text-[0.7rem] font-medium text-zinc-500 dark:text-zinc-400" style="margin:6px 0 2px">Before / after — <code>${esc(path)}</code>${mobile ? ' (mobile)' : ''}</div>`;
      // Honest-pair captions: explain a missing "before" (route is new —
      // there's no production version to compare) and a fell-back "before"
      // (the deep route 404'd on production, so the tile shows the home
      // page) so a mismatched-looking comparison isn't read as a bug.
      let note = '';
      if (a && !b) {
        note = 'New page — no production version to compare';
      } else if (b && g.beforeFellBack) {
        note = '"Before" shows the home page — this page didn’t exist in production yet';
      }
      const noteHtml = note
        ? `<div class="text-[0.65rem] text-zinc-500 dark:text-zinc-400" style="margin:2px 0 0">${esc(note)}</div>`
        : '';
      rows.push(`${label}<div class="usn-visual-tiles" style="display:flex;gap:8px;align-items:flex-start;margin:4px 0 2px">${before}${after}</div>${noteHtml}`);
    }
    return rows.join('');
  },

  // #353: open the before/after comparison overlay from a clicked tile.
  // Reads the group's artifact ids off the tile's data-* attributes
  // (written by visualsTilesHtml; all 32-hex-validated at render time)
  // and renders before + after side-by-side at full size — two columns on
  // a wide screen, stacked on a narrow one. webm plays muted/looping with
  // the PNG poster; otherwise the PNG (or GIF) shows as an image. Each
  // column keeps an "open original" link so the raw asset is still one
  // click away. A side with no artifacts renders a "no version" note
  // (e.g. a brand-new screen with no production "before").
  openVisualComparison(triggerEl) {
    const overlay = document.getElementById('visual-compare-overlay');
    const body = document.getElementById('visual-compare-body');
    const labelEl = document.getElementById('visual-compare-label');
    if (!overlay || !body || !triggerEl) return;
    const d = triggerEl.dataset || {};
    const idOk = (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
    const pick = (...ids) => ids.find((id) => idOk(id)) || null;
    const before = {
      png: idOk(d.beforePng) ? d.beforePng : null,
      webm: idOk(d.beforeWebm) ? d.beforeWebm : null,
      gif: idOk(d.beforeGif) ? d.beforeGif : null,
    };
    const after = {
      png: idOk(d.afterPng) ? d.afterPng : null,
      webm: idOk(d.afterWebm) ? d.afterWebm : null,
      gif: idOk(d.afterGif) ? d.afterGif : null,
    };
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
    const path = d.path || '/';
    const mobile = d.viewport === 'mobile';
    if (labelEl) {
      const base = (path && path !== '/') ? path : (mobile ? '/' : '');
      labelEl.textContent = base ? `${base}${mobile ? ' (mobile)' : ''}` : '';
    }

    const colStyle = 'flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:6px';
    const mediaStyle = 'display:block;width:100%;max-height:78vh;object-fit:contain;object-position:top;background:rgba(0,0,0,0.35);border:1px solid rgba(127,127,127,0.25);border-radius:8px';
    const column = (label, v) => {
      const has = v && (v.png || v.webm || v.gif);
      const heading = `<div class="text-[0.7rem] font-semibold uppercase tracking-wide text-zinc-400">${label}</div>`;
      if (!has) {
        return `<div style="${colStyle}">${heading}<div class="text-xs text-zinc-500" style="padding:24px 0;text-align:center;border:1px dashed rgba(127,127,127,0.3);border-radius:8px">No ${label.toLowerCase()} version to compare.</div></div>`;
      }
      const media = v.webm
        ? `<video src="/visuals/${v.webm}"${v.png ? ` poster="/visuals/${v.png}"` : ''} muted loop autoplay playsinline controls style="${mediaStyle}"></video>`
        : `<img src="/visuals/${v.png || v.gif}" alt="${label}" style="${mediaStyle}">`;
      const orig = pick(v.webm, v.gif, v.png);
      const origLink = orig
        ? `<a href="/visuals/${orig}" target="_blank" rel="noopener" class="text-[0.7rem] text-violet-400 hover:text-violet-300">Open original ↗</a>`
        : '';
      return `<div style="${colStyle}">${heading}${media}${origLink}</div>`;
    };

    const pathLabel = ((path && path !== '/') || mobile)
      ? `<div class="text-xs text-zinc-400" style="margin-bottom:10px">Before / after — <code>${esc(path)}</code>${mobile ? ' (mobile)' : ''}</div>`
      : '';
    body.innerHTML = `${pathLabel}<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">${column('Before', before)}${column('After', after)}</div>`;

    // Reveal now + stamp openedAt so modalDismissGuarded can swallow the
    // opening tap's ghost click (same as the share/members modals).
    AppView.revealModal(overlay);

    // Close affordances: Back button, backdrop click (the overlay root
    // itself, not its children), and Escape. The Escape handler is added
    // on open / removed on close so it never lingers. modalDismissGuarded
    // swallows the opening tap's ghost click (matches the share modal).
    const back = document.getElementById('visual-compare-back');
    if (back) back.onclick = () => AppView.closeVisualComparison();
    overlay.onclick = (e) => {
      if (window.AppView && AppView.modalDismissGuarded && AppView.modalDismissGuarded(overlay)) return;
      if (e.target === overlay) AppView.closeVisualComparison();
    };
    AppView._visualCompareKeyHandler = (e) => {
      if (e.key === 'Escape') AppView.closeVisualComparison();
    };
    document.addEventListener('keydown', AppView._visualCompareKeyHandler);
  },

  // #353: tear down the comparison overlay. Clear the body innerHTML (not
  // display:none) so any looping <video> actually stops, mirroring
  // toggleVisuals, and remove the Escape handler installed on open.
  closeVisualComparison() {
    const overlay = document.getElementById('visual-compare-overlay');
    const body = document.getElementById('visual-compare-body');
    if (body) body.innerHTML = '';
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.onclick = null;
    }
    if (AppView._visualCompareKeyHandler) {
      document.removeEventListener('keydown', AppView._visualCompareKeyHandler);
      AppView._visualCompareKeyHandler = null;
    }
  },

  // #211: sessions whose before/after tiles the viewer expanded in the
  // App-information-and-activity panel. Module-level (not DOM) state so
  // the open/closed choice survives the panel's frequent full re-renders.
  _visualsOpen: new Set(),

  // #211: collapsed-by-default wrapper around visualsTilesHtml for the
  // App-information-and-activity panel's PR rows. Renders a small
  // "Show before/after" toggle; the tiles themselves sit in an inert
  // <template> until expanded, so hidden screenshots/videos cost no
  // bandwidth and autoplay loops don't run off-screen. The dev-chat
  // "Changes ready" card intentionally keeps calling visualsTilesHtml
  // directly — its inline tiles stay as before (issue #211).
  visualsToggleHtml(sessionId, visuals) {
    const tiles = AppView.visualsTilesHtml(visuals);
    if (!tiles) return '';
    const open = AppView._visualsOpen.has(sessionId);
    return `<div class="usn-visuals-toggle">
      <button type="button" class="gc-vote-btn" aria-expanded="${open}" onclick="AppView.toggleVisuals(${sessionId}, this)">${open ? 'Hide before/after' : 'Show before/after'}</button>
      <template class="usn-visuals-tpl">${tiles}</template>
      <div class="usn-visuals-body">${open ? tiles : ''}</div>
    </div>`;
  },

  // #211: expand/collapse handler for the toggle above. Injects the tile
  // markup from the row's <template> on open and clears it on close
  // (clearing, rather than display:none, stops any looping <video>).
  toggleVisuals(sessionId, btn) {
    // Two layouts share this handler: the home panel's self-contained
    // .usn-visuals-toggle wrapper, and the proposal card (the toggle pill
    // lives in the actions row, the template/body below it — the card root
    // carries data-visuals-scope so we can find them).
    const wrap = btn.closest('.usn-visuals-toggle, [data-visuals-scope]');
    if (!wrap) return;
    const body = wrap.querySelector('.usn-visuals-body');
    const tpl = wrap.querySelector('template.usn-visuals-tpl');
    const open = !AppView._visualsOpen.has(sessionId);
    if (open) {
      AppView._visualsOpen.add(sessionId);
      if (body && tpl) body.innerHTML = tpl.innerHTML;
    } else {
      AppView._visualsOpen.delete(sessionId);
      if (body) body.innerHTML = '';
    }
    btn.textContent = open ? 'Hide before/after' : 'Show before/after';
    btn.setAttribute('aria-expanded', String(open));
  },

  // #80: derive the GitHub issue URL for issue #N from a PR's html_url
  // (https://github.com/<owner>/<repo>/pull/<prNumber>) by swapping the
  // `/pull/<n>` segment for `/issues/<issueNumber>`. Returns '' when the
  // PR url is missing or doesn't look like a GitHub PR url so callers can
  // skip rendering a dead link.
  issueUrlFromPrUrl(prUrl, issueNumber) {
    if (!prUrl || !Number.isInteger(issueNumber) || issueNumber <= 0) return '';
    const out = prUrl.replace(/\/pull\/\d+(?=$|[/?#])/, `/issues/${issueNumber}`);
    // No substitution happened → not a recognizable PR url; bail rather
    // than linking to a /pull/ page for an issue.
    return out === prUrl ? '' : out;
  },

  // #80: "Closes #N" / "Closed #N" pills for the GitHub issues a PR closes.
  // Reads `linked_issues` (Postgres INTEGER[], populated in #75 and written
  // into the PR body as `Closes #N` by src/services/pr-metadata.js). Wording
  // follows the canonical merge check used elsewhere: status === 'merged'
  // is the only merged state, everything else ('promoted'/'merging'/'active'/
  // 'paused') reads as still-open. One independently-clickable pill per
  // issue, each opening the issue on GitHub in a new tab (#61). Renders
  // nothing when there are no linked issues or no usable PR url.
  // ── "In progress" status on issue cards ──────────────────────────────
  //
  // An issue is in progress while ANY live signal exists: a live linked
  // session or manual claim (issue.in_progress, from /github-issues) or a
  // live headless auto-solve run (issue.headless generating/ready — kept
  // as a separate field so the 8s headless poller's field-scoped merge
  // stays correct; this predicate ORs the two). Shared by the chip
  // renderer below and the kanban's In-progress-column routing.
  _issueInProgress(issue) {
    if (!issue) return false;
    const h = issue.headless;
    return !!(issue.in_progress || (h && (h.status === 'generating' || h.status === 'ready')));
  },

  // The "In progress" chip on an issue card. Label derives from the
  // distinct PEOPLE involved (session owners + claimers, deduped): one
  // person → their name ("· you" when it's the viewer), several → a
  // count. The tooltip names everyone with their role. When the server
  // chose a link target (in_progress.target — proposal > own session >
  // shared session, per-viewer) the chip is a button that opens the
  // linked work; otherwise a plain informational span (private work,
  // claims-only, or headless-only — those rows' own buttons navigate).
  _inProgressChipHtml(issue) {
    const ip = issue.in_progress || null;
    const h = issue.headless;
    const headlessLive = !!(h && (h.status === 'generating' || h.status === 'ready'));
    if (!ip && !headlessLive) return '';
    const sessUsers = (ip && Array.isArray(ip.users)) ? ip.users.filter(Boolean) : [];
    const claims = (ip && Array.isArray(ip.claims)) ? ip.claims : [];
    const claimUsers = claims.map((c) => c && c.username).filter(Boolean);
    const people = [];
    for (const u of [...sessUsers, ...claimUsers]) {
      if (!people.includes(u)) people.push(u);
    }
    const mine = !!(ip && ip.mine);
    let label;
    if (people.length > 1) label = `In progress · ${people.length}`;
    else if (mine) label = 'In progress · you';
    else if (people.length === 1) label = `In progress · ${people[0]}`;
    else label = 'In progress';
    const tip = [];
    if (claimUsers.length) tip.push(`Claimed by ${claimUsers.join(', ')}`);
    const workers = sessUsers.filter((u) => !claimUsers.includes(u));
    if (workers.length) tip.push(`Working in a dev session: ${workers.join(', ')}`);
    if (headlessLive) tip.push('An auto-solve run is on this issue');
    const title = tip.join(' · ') || 'This issue is being worked on';
    const baseCls = 'dev-badge bg-sky-500/10 text-sky-500';
    const target = ip && ip.target;
    const targetId = target ? parseInt(target.sessionId, 10) : 0;
    if (target && targetId) {
      return `<button type="button" class="${baseCls} hover:bg-sky-500/20" title="${escapeAttr(`${title} — open the linked work`)}" onclick="AppView.openInProgressTarget('${escapeAttr(String(target.kind))}', ${targetId})">${escapeHtml(label)}</button>`;
    }
    return `<span class="${baseCls}" title="${escapeAttr(title)}">${escapeHtml(label)}</span>`;
  },

  // Navigate to the work behind an issue's "In progress" chip, reusing
  // the Dev board's existing handlers verbatim: a proposal opens its
  // discussion topic, the viewer's own session opens their dev chat,
  // and a shared session opens its public discussion (never the owner's
  // dev chat — those endpoints stay owner-scoped server-side).
  openInProgressTarget(kind, sessionId) {
    const id = parseInt(sessionId, 10);
    if (!id) return;
    if (kind === 'proposal') {
      AppView.openTopic('proposal', id);
    } else if (kind === 'session-own') {
      if (typeof App !== 'undefined' && App.switchTab) App.switchTab('dev', id, 'sessions');
    } else if (kind === 'session-shared') {
      AppView.openTopic('session', id);
    }
  },

  // Reverse "#N" issue chips for session/proposal cards: one compact pill
  // per linked issue, opening the issue's IN-APP discussion topic (the
  // same navigation as tapping the issue row). Unlike closesPillHtml
  // below this never needs pr_url (session cards have none pre-PR) and
  // never leaves the app. opts.label prefixes each chip (the live
  // proposal card passes 'Closes' to keep its established wording).
  issueChipsHtml(linkedIssues, opts) {
    const prefix = opts && opts.label ? `${opts.label} ` : '';
    const raw = Array.isArray(linkedIssues) ? linkedIssues : [];
    const seen = new Set();
    const nums = [];
    for (const v of raw) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); nums.push(n); }
    }
    if (!nums.length) return '';
    nums.sort((a, b) => a - b);
    const cls = 'dev-badge font-mono bg-violet-500/10 text-violet-400 hover:bg-violet-500/20';
    return nums.map((n) =>
      `<button type="button" class="${cls}" title="Open issue #${n}'s discussion" data-issue-chip="${n}" onclick="AppView.openTopic('issue', ${n})">${prefix}#${n}</button>`
    ).join(' ');
  },

  closesPillHtml(pr) {
    if (!pr || !pr.pr_url) return '';
    // Sanitize defensively (mirror prMetadata.sanitizeIssueNumbers): drop
    // anything that isn't a positive integer, dedupe, sort ascending.
    const raw = Array.isArray(pr.linked_issues) ? pr.linked_issues : [];
    const seen = new Set();
    const nums = [];
    for (const v of raw) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); nums.push(n); }
    }
    if (!nums.length) return '';
    nums.sort((a, b) => a - b);

    const merged = pr.status === 'merged';
    const verb = merged ? 'Closed' : 'Closes';
    // Match the PR-number link tint at each site: emerald for merged,
    // violet for open.
    const cls = merged
      ? 'dev-badge font-mono bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20'
      : 'dev-badge font-mono bg-violet-500/10 text-violet-400 hover:bg-violet-500/20';

    return nums.map((n) => {
      const href = AppView.issueUrlFromPrUrl(pr.pr_url, n);
      if (!href) return '';
      return `<a href="${href}" target="_blank" rel="noopener" class="${cls}" title="${verb} issue #${n} on GitHub">${verb} #${n}</a>`;
    }).join(' ');
  },

  voteButtonsHtml(pr, opts) {
    if (!pr) return '';
    // Group-chat inline rows pass { collapseVoted: true }: once the viewer
    // has voted, the whole control set is replaced by a single read-only
    // "You voted X" box. The activity drawer passes nothing, so it keeps the
    // full Preview/Yes/No/Admin-merge set (with the chosen side highlighted)
    // so voters can re-cast or preview after voting.
    if (opts && opts.collapseVoted && (pr.my_vote === 'yes' || pr.my_vote === 'no')) {
      const choice = pr.my_vote === 'yes' ? 'Yes' : 'No';
      return `<span class="gc-vote-voted-box gc-vote-voted-box-${pr.my_vote}">You voted ${choice}</span>`;
    }
    // In the chat, a merging/merged PR has closed voting — don't render live
    // (now no-op) Yes/No buttons for someone who never voted; the pill +
    // status badge already convey the outcome.
    if (opts && opts.collapseVoted && pr.status !== 'promoted') return '';
    // #127: stash the PR's testing guidance in the by-session registry so
    // the Preview onclick passes it to the overlay (which renders its own
    // "Test this change" button + instructions panel) without the markdown
    // ever transiting an HTML attribute.
    if (pr.testing_md || pr.testing_path) {
      AppView._sessionTesting[pr.id] = { md: pr.testing_md || null, path: pr.testing_path || null };
    } else {
      delete AppView._sessionTesting[pr.id];
    }
    const preview = AppView._previewAffordanceHtml(pr);
    // #621: read-only viewers keep the Preview affordance but get no
    // vote controls — the tally pill on the card already shows counts.
    // #866: they also get no "Retry preview" (the ensure POST is
    // collab-gated), so the unavailable chip renders bare for them.
    if (AppView.readOnly) return preview;
    const retryPreview = (!pr.staging_url && pr.staging_error)
      ? `<button class="gc-vote-btn" title="Try building this proposal's staging preview again" onclick="AppView.swapToStagingForSession(${pr.id}, '')">Retry preview</button>`
      : '';
    // #788: force-merge is available to platform admins AND to the app's
    // own declared admins (ctx.canManage covers creator + app admins,
    // but only app admins / platform admins get force-merge — the
    // server is the authority; this just decides whether to render the
    // button). The one carve-out: a proposal that changes the admins
    // block can't be force-merged by an app admin (self-escalation), so
    // there the button is platform-admin-only.
    const vbCtx = AppView._proposalsCtx || {};
    const canForceMerge = App.user?.canAdminWrite
      || (!!vbCtx.isAppAdmin && !pr.requires_explicit_approval);
    const adminMerge = canForceMerge
      ? `<button class="gc-vote-btn gc-vote-btn-admin" title="${pr.requires_explicit_approval ? 'Admin: merge this admins-changing PR right now, bypassing the vote' : 'Admin: merge this PR right now, bypassing the vote majority'}" onclick="AppView.castAdminMerge(${pr.id})">Admin merge</button>`
      : '';
    // Native votes carry the exact revision rendered with this card. If the
    // PR moves before the click reaches the server, the server rejects the
    // stale action and asks for a refresh instead of applying it to unseen
    // code. Imported proposals retain their existing vote flow.
    const nativeHead = pr.source !== 'imported'
      && typeof pr.reviewed_head_sha === 'string'
      && /^[0-9a-f]{40}$/i.test(pr.reviewed_head_sha)
      ? pr.reviewed_head_sha.toLowerCase()
      : null;
    const revisionArg = nativeHead ? `, '${nativeHead}'` : '';
    const yesT = AppView._voteBtnTally(pr.qualified_yes_count, pr.yes_count, pr.approval_policy, 'Yes');
    const noT = AppView._voteBtnTally(pr.qualified_no_count, pr.no_count, pr.approval_policy, 'No');
    const yesBtn = `<button class="gc-vote-btn gc-vote-btn-yes${pr.my_vote === 'yes' ? ' gc-vote-active' : ''}"${yesT.title} onclick="AppView.castVote(${pr.id}, 'yes'${revisionArg})">Yes (${yesT.label})</button>`;
    const noBtn = `<button class="gc-vote-btn gc-vote-btn-no${pr.my_vote === 'no' ? ' gc-vote-active' : ''}"${noT.title} onclick="AppView.castVote(${pr.id}, 'no'${revisionArg})">No (${noT.label})</button>`;
    return preview + retryPreview + yesBtn + noBtn + adminMerge;
  },

  // #866: the Preview slot has three states, not two.
  //
  // Native proposals are promoted only after their preview is already up, so
  // "has staging_url" was a fine proxy for "previewable". An imported PR is
  // promoted the instant it's imported and its preview is built afterwards,
  // which leaves the card in a state the old two-way branch rendered as
  // nothing at all — indistinguishable from a permanent failure, and read by
  // reviewers as a broken card. So:
  //   staging_url        → the Preview button (unchanged).
  //   staging_building   → a non-interactive "Preview building…" pill. Not a
  //                        button: clicking through to ensure-staging while
  //                        the first build is still running would only ever
  //                        return 'rebuilding' and park a loader.
  //   staging_error      → "Preview unavailable" with the captured reason in
  //                        the tooltip; voteButtonsHtml adds "Retry preview"
  //                        beside it for viewers who can trigger a rebuild.
  // Neither flag (a plain GC'd or not-yet-built native row) keeps today's
  // empty slot.
  //
  // ── The ONE preview affordance ──────────────────────────────────────
  //
  // "Preview" used to be built in four separate places with four different
  // tooltips and four different gating rules: proposal cards (through
  // voteButtonsHtml), the viewer's own session cards, other users' shared
  // session cards, and the headless branch of an issue card. All four
  // already funnelled into swapToStagingForSession(id, url), so the only
  // real differences were wording and which of staging_url / can_preview /
  // staging_building / staging_error they consulted. cardPreviewHtml folds
  // that into one truth table, and every call site now goes through it.
  //
  // opts.kind ∈ 'proposal' | 'own-session' | 'shared-session' | 'issue-run'
  //   — picks the tooltip wording only; the gating is uniform.
  // opts.iconOnly (the board default) renders the eye glyph rather than the
  //   word "Preview". Deliberate: a read-only viewer gets no vote buttons,
  //   so the icon is the only visible "you can go and look at this" on their
  //   card — dropping it would leave them a card with no affordance at all.
  //   It carries a real accessible name, and the two non-interactive states
  //   render as <span>, not a disabled <button>.
  PREVIEW_EYE_SVG: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">'
    + '<path stroke-linecap="round" stroke-linejoin="round" d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/>'
    + '<circle cx="12" cy="12" r="2.75"/></svg>',
  // The unavailable state: the same eye with a slash through it.
  PREVIEW_EYE_OFF_SVG: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">'
    + '<path stroke-linecap="round" stroke-linejoin="round" d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/>'
    + '<circle cx="12" cy="12" r="2.75"/>'
    + '<path stroke-linecap="round" d="M4 20 20 4"/></svg>',

  PREVIEW_TITLES: {
    proposal: 'Open this proposal’s staging preview',
    'own-session': 'Open this session’s staging preview (rebuilds it if it went to sleep)',
    'shared-session': 'Open this session’s staging preview',
    'issue-run': 'Open the generated proposal’s staging preview',
  },

  cardPreviewHtml(item, opts) {
    const it = item || {};
    const o = opts || {};
    const kind = o.kind || 'proposal';
    const iconOnly = o.iconOnly !== false;
    const sessionId = o.sessionId != null ? o.sessionId : it.id;
    if (!sessionId) return '';
    const url = it.staging_url || o.stagingUrl || '';
    // A shared/own session with no live URL is still previewable when the
    // branch has pushed changes — the click routes through ensure-staging,
    // which rebuilds a GC'd preview on demand. Read-only viewers can't
    // trigger that POST, so for them a live URL is required.
    const canRebuild = !AppView.readOnly && (it.can_preview || (kind === 'own-session' && it.pr_number));
    const live = !!url || canRebuild;
    const label = AppView.PREVIEW_TITLES[kind] || AppView.PREVIEW_TITLES.proposal;

    if (live) {
      const t = url ? label : `${label} (rebuilds it if it went to sleep)`;
      const inner = iconOnly
        ? AppView.PREVIEW_EYE_SVG
        : 'Preview';
      const cls = 'gc-vote-btn gc-vote-btn-preview' + (iconOnly ? ' gc-vote-btn-icon' : '');
      return `<button type="button" class="${cls}" aria-label="Open preview" title="${escapeAttr(t)}"`
        + ` onclick="AppView.swapToStagingForSession(${sessionId}, '${escapeAttr(url)}')">${inner}</button>`;
    }
    if (it.staging_building) {
      const t = 'The staging preview is being built — this usually takes a few minutes. A Preview button appears here as soon as it’s ready.';
      if (!iconOnly) {
        return `<span class="gc-checks-running-badge" title="${escapeAttr(t)}">`
          + '<span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>Preview building…</span>';
      }
      return `<span class="gc-vote-btn gc-vote-btn-icon gc-checks-running-badge" role="img" aria-label="Preview building" title="${escapeAttr(t)}">`
        + '<span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span></span>';
    }
    if (it.staging_error) {
      const t = `Preview unavailable — ${String(it.staging_error).slice(0, 280)}`;
      if (!iconOnly) {
        return `<span class="gc-conflict-badge" title="${escapeAttr(t)}">Preview unavailable</span>`;
      }
      return `<span class="gc-vote-btn gc-vote-btn-icon gc-conflict-badge" role="img" aria-label="Preview unavailable" title="${escapeAttr(t)}">`
        + AppView.PREVIEW_EYE_OFF_SVG + '</span>';
    }
    return '';
  },

  _previewAffordanceHtml(pr) {
    if (!pr) return '';
    if (pr.staging_url) {
      return `<button class="gc-vote-btn gc-vote-btn-preview" onclick="AppView.swapToStagingForSession(${pr.id}, '${pr.staging_url}')">Preview</button>`;
    }
    if (pr.staging_building) {
      return '<span class="gc-checks-running-badge" title="The staging preview for this proposal is being built — this usually takes a few minutes. A Preview button appears here as soon as it&#39;s ready.">'
        + '<span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>Preview building…</span>';
    }
    if (pr.staging_error) {
      return `<span class="gc-conflict-badge" title="${escapeAttr(String(pr.staging_error).slice(0, 300))}">Preview unavailable</span>`;
    }
    return '';
  },

  // #695: the Yes/No button tally. On invited-approver apps (row carries
  // approval_policy='invited' + a qualifying count) the label splits into
  // approver votes (✓, the ones that count) plus the advisory surplus —
  // "1✓ +2" — with an explanatory tooltip. Everywhere else it's the raw
  // total, unchanged. Returns { label, title } (title includes the
  // leading space, or '' when not applicable).
  _voteBtnTally(qualified, raw, policy, side) {
    if (policy !== 'invited' || qualified == null) {
      return { label: `${raw}`, title: '' };
    }
    const q = parseInt(qualified) || 0;
    const a = Math.max(0, (parseInt(raw) || 0) - q);
    const label = a > 0 ? `${q}✓ +${a}` : `${q}✓`;
    const title = ` title="${q} approver ${side} vote${q === 1 ? '' : 's'} · ${a} advisory ${side} vote${a === 1 ? '' : 's'} (advisory votes don't count toward merging)"`;
    return { label, title };
  },

  // Admin force-merge: bypass the active-user vote majority entirely
  // and merge a promoted PR right now. Gated server-side by
  // /api/sessions/:id/admin-merge (admin-only). The ConfirmModal here
  // is the misclick guard — the "Admin merge" button sits inline with
  // the regular Yes/No buttons, and we don't want a fat-finger to
  // accidentally bypass voting when the admin meant to just vote.
  async castAdminMerge(sessionId) {
    if (!App.user?.isAdmin) return;
    const key = `admin-merge:${sessionId}`;
    if (AppView._voteInFlight.has(key)) return;
    const ok = await ConfirmModal.show({
      title: 'Force-merge this PR?',
      message:
        'This bypasses the active-user vote majority and merges the PR right now.\n\n'
        + 'Use only when you\'re confident the change should ship — the override is announced in group chat with your username.',
      confirmLabel: 'Force-merge',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    AppView._voteInFlight.add(key);
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/admin-merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        PlatformUI.toast(data.error || `Force-merge failed (HTTP ${resp.status}).`);
      }
      AppView.refreshDevData('vote');
    } catch (err) {
      PlatformUI.toast(`Force-merge failed: ${err.message}`);
    } finally {
      AppView._voteInFlight.delete(key);
    }
  },


  _voteInFlight: new Set(),
  async castVote(sessionId, vote, expectedHeadSha = null) {
    // Guard against double-click / mashing: one in-flight vote per session.
    // The server is now idempotent on an unchanged vote (won't re-post
    // to chat or re-enter checkAndMerge), but blocking here still avoids
    // pointless network round-trips and keeps the UI responsive.
    const key = `${sessionId}:${vote}`;
    if (AppView._voteInFlight.has(key)) return;
    AppView._voteInFlight.add(key);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vote, expectedHeadSha }),
      });
      const data = await res.json().catch(() => ({}));
      AppView.refreshDevData('vote');
      if (!res.ok) {
        PlatformUI.toast(data.error || `Vote failed (HTTP ${res.status}).`);
        return;
      }
      // Only refresh notifications once the backend confirms the vote — the
      // server clears this PR's nudge as a side effect, so re-pull to drop it
      // from the unread badge. Never optimistic: skip on a non-ok response.
      window.Notifications?.refresh?.();
    } catch {}
    finally {
      AppView._voteInFlight.delete(key);
    }
  },

  // Vote on a governance proposal (env-var change, close-issue, rename,
  // maintenance campaign).
  //
  // #1010: a DECIDING up-vote makes this request run the whole apply
  // server-side, so the fetch stays open for seconds. Three things follow
  // from that, all of which this used to get wrong:
  //   - the row needs an in-progress state for the whole round-trip
  //     (_beginGovApply, painted BEFORE the await);
  //   - a second click must not land, because "same side again" is the
  //     server's toggle-OFF branch — an impatient double-click on Yes used
  //     to retract the vote that had just decided the proposal;
  //   - the outcome must be reported. This swallowed every non-ok response
  //     (including the 409 you get when someone else decided it first) and
  //     every exception, so a failed vote looked exactly like a successful one.
  async castIssueVote(issueId, vote) {
    const key = `issue:${issueId}`;
    if (AppView._voteInFlight.has(key)) return;
    AppView._voteInFlight.add(key);

    const issue = (AppView._govProposals || []).find((g) => g.id === issueId);
    const kind = issue ? issue.kind : null;
    const targetN = (issue && issue.payload && issue.payload.issueNumber) || null;
    // Only the deciding vote gets the spinner: an ordinary vote resolves in
    // well under a second, and a spinner there would be noise.
    const deciding = AppView._govVoteWouldDecide(issue, vote);
    if (deciding) AppView._beginGovApply(issue, vote);

    let settled = false;
    const finish = (phase, error) => {
      if (settled) return;
      settled = true;
      if (deciding) AppView._endGovApply(issueId, phase, error);
    };

    try {
      const res = await fetch(`/api/issues/${issueId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vote }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // 409 "Issue is not open" is the common one: someone else's vote
        // decided it between this card rendering and the click landing.
        finish();
        PlatformUI.toast(data.error || `Vote failed (HTTP ${res.status}).`);
        AppView.refreshDevData('vote');
        return;
      }

      // If a rename proposal just crossed the threshold, the WS app_update
      // event will refresh state for everyone; we just reload the panel.
      if (data?.renamed?.applied) {
        // Optimistic local update; the WS handler will re-sync.
        if (AppView.appData) AppView.appData.name = data.renamed.newName;
      }

      // Report what the apply actually did. `outcome` is whichever of the
      // four per-kind result objects this row produced (all share the
      // { applied, superseded, awaitingAdmin, error, … } shape).
      const outcome = data?.issueClosed || data?.secretChanged
        || data?.renamed || data?.campaignStarted || null;
      finish();
      if (outcome && outcome.applied) {
        if (kind === 'close_issue') {
          PlatformUI.toast(`Issue #${outcome.issueNumber || targetN || '?'} closed by group vote.`);
        }
      } else if (outcome && outcome.superseded) {
        // Not an error: the guard found the target already closed and
        // retired the proposal instead of applying it.
        PlatformUI.toast(
          `Issue #${targetN || '?'} was already closed — the proposal was resolved automatically.`
        );
      } else if (outcome && outcome.awaitingAdmin) {
        PlatformUI.toast('Vote passed — an admin still needs to approve before it applies.');
      } else if (outcome && outcome.error) {
        PlatformUI.toast(`The change didn't complete: ${outcome.error}`);
      }
      // Anything else (vote recorded, gate not met yet, toggled off) needs no
      // toast — the refreshed card's tally / countdown pill says it all.

      AppView.refreshDevData('vote');
      // Voting clears this proposal's nudge server-side; re-pull so the
      // unread badge drops it. Never optimistic — only on an ok response.
      window.Notifications?.refresh?.();
    } catch (err) {
      // Network/abort: the server-side apply may well have completed, so
      // park on the failure copy rather than pretending nothing happened.
      finish('failed', err && err.message);
      PlatformUI.toast(`Vote failed: ${(err && err.message) || 'connection lost'}`);
    } finally {
      AppView._voteInFlight.delete(key);
    }
  },

  promptRename() {
    if (!AppView.appData) return;
    const modal = document.getElementById('rename-modal');
    const input = document.getElementById('rename-input');
    const current = document.getElementById('rename-current');
    const err = document.getElementById('rename-error');
    if (!modal || !input || !current) return;

    current.textContent = AppView.appData.name || '';
    input.value = AppView.appData.name || '';
    err.classList.add('hidden');
    err.textContent = '';
    modal.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 0);
  },

  closeRenameModal() {
    const modal = document.getElementById('rename-modal');
    const input = document.getElementById('rename-input');
    const err = document.getElementById('rename-error');
    if (modal) modal.classList.add('hidden');
    if (input) input.value = '';
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
  },

  // Amber "⑂ Forked from <name>" lineage label. Lived in the header's
  // right-hand action group until the header slim-down moved it under
  // the "App" build line, now in the drawer's footer
  // (#drawer-row-app-fork, whose visibility this function drives — the
  // slot id is unchanged). `forked_from` is resolved server-side to
  // { appId, slug, name, linkable }; when linkable the label links to the
  // source app, otherwise (source deleted → name "<deleted>") it renders
  // as inert text. No-op for non-forks.
  renderForkBadge() {
    const slot = document.getElementById('app-fork-badge-slot');
    if (!slot) return;
    const setRow = (visible) => {
      if (window.App?.DrawerStatus) App.DrawerStatus.setForkVisible(visible);
    };
    const ref = AppView.appData && AppView.appData.forked_from;
    if (!ref || typeof ref !== 'object') { slot.innerHTML = ''; setRow(false); return; }
    const name = ref.name || '<deleted>';
    // Text form, not a pill: this line sits in the drawer footer directly
    // under the "App" version line, and a filled amber pill between two
    // quiet mono version lines shouted louder than a lineage note needs
    // to. Amber is retained as the lineage colour.
    const cls = 'drawer-ver drawer-ver--fork max-w-full truncate';
    const label = `⑂ Forked from ${escapeHtml(name)}`;
    if (ref.linkable && ref.slug) {
      slot.innerHTML = `<a href="#app/${encodeURIComponent(ref.slug)}" `
        + `class="${cls}" `
        + `title="Forked from ${escapeAttr(name)} — open the original">${label}</a>`;
    } else {
      slot.innerHTML = `<span class="${cls} opacity-90" `
        + `title="The original app no longer exists">${label}</span>`;
    }
    setRow(true);
  },

  // Source of the fork being composed: { slug, name }. Set by promptFork
  // so submitFork POSTs to the right app whether the dialog was opened
  // from the app-view header "+" menu (current app) or the home-screen
  // card dropdown (an arbitrary app, with no app open).
  _forkSource: null,

  // `source` (optional) = { slug, name }. Falls back to the currently
  // open app so the header "+" menu keeps working with no argument.
  promptFork(source) {
    const src = source || (AppView.appData
      ? { slug: AppView.appData.slug, name: AppView.appData.name }
      : null);
    if (!src || !src.slug) return;
    AppView._forkSource = src;
    const modal = document.getElementById('fork-modal');
    const input = document.getElementById('fork-input');
    const srcEl = document.getElementById('fork-source-name');
    const err = document.getElementById('fork-error');
    if (!modal || !input) return;
    if (srcEl) srcEl.textContent = src.name || '';
    input.value = `${src.name || 'App'} (fork)`;
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
    AppView.revealModal(modal);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  },

  closeForkModal() {
    const modal = document.getElementById('fork-modal');
    const input = document.getElementById('fork-input');
    const err = document.getElementById('fork-error');
    if (modal) modal.classList.add('hidden');
    if (input) input.value = '';
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
  },

  async submitFork(e) {
    if (e) e.preventDefault();
    const source = AppView._forkSource
      || (AppView.appData ? { slug: AppView.appData.slug } : null);
    if (!source || !source.slug) return;
    const input = document.getElementById('fork-input');
    const err = document.getElementById('fork-error');
    const submitBtn = document.getElementById('fork-submit');
    const name = (input?.value || '').trim();
    const showErr = (msg) => {
      if (err) { err.textContent = msg; err.classList.remove('hidden'); }
    };
    if (name.length < 3) return showErr('Name must be at least 3 characters.');
    const sourceSlug = source.slug;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Forking…'; }
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(sourceSlug)}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showErr(data.error || 'Fork failed.');
        return;
      }
      AppView.closeForkModal();
      // Land the user on the home feed where the new fork tile shows its
      // "Spinning up…" state (identical to creating a new app).
      App.navigateHome();
    } catch (_) {
      showErr('Network error — please try again.');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Fork'; }
    }
  },

  // #687 — PR-import picker. Lists open PRs (not already imported) from
  // GET /pr-import/candidates; importing one POSTs /pr-import.
  //
  // #846: the POST is awaited IN PLACE (progress row, dimmed list, frozen
  // buttons — see _importPrBusy) and only a server-confirmed import routes
  // the user, to the new proposal's DISCUSSION page (openTopic('proposal'))
  // — never the dev-chat session view. An imported proposal has no dev
  // session by design (see the sessionBtn / importedNote branches in
  // _renderProposalCard / _proposalDetailsHtml), and that view renders an
  // empty transcript with a live composer until the minutes-long staging
  // build lands. The proposal page is complete on arrival and refreshes
  // itself on checks_ready / staging_ready. Mirrors the promptFork /
  // submitFork / closeForkModal shape. A 404 from the candidates endpoint
  // degrades to the GitHub-off/empty message rather than crashing.
  _importPrSelected: null,
  // True while the import POST is in flight — freezes the dialog and makes
  // the backdrop-dismiss handler a no-op (a dismiss mid-request would strand
  // the user with an import they can't see the outcome of).
  _importPrBusy: false,
  _importPrSlowTimer: null,

  async openImportPrModal() {
    if (!AppView.appData || !AppView.appData.slug) return;
    const modal = document.getElementById('import-pr-modal');
    const list = document.getElementById('import-pr-list');
    const err = document.getElementById('import-pr-error');
    const submitBtn = document.getElementById('import-pr-submit');
    if (!modal || !list) return;
    AppView._importPrSelected = null;
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
    if (submitBtn) submitBtn.disabled = true;
    list.innerHTML = '<div class="text-sm text-zinc-500 dark:text-zinc-400 py-6 text-center">Loading open pull requests…</div>';
    AppView.revealModal(modal);
    await AppView._loadImportPrCandidates();
  },

  // Fetch + render the candidate rows into the (already open) picker.
  // Split out of openImportPrModal so a 409 "already imported" can refresh
  // the list in place, dropping the stale row the user just tried.
  async _loadImportPrCandidates() {
    if (!AppView.appData || !AppView.appData.slug) return;
    const list = document.getElementById('import-pr-list');
    const err = document.getElementById('import-pr-error');
    const submitBtn = document.getElementById('import-pr-submit');
    if (!list) return;
    AppView._importPrSelected = null;
    if (submitBtn) submitBtn.disabled = true;
    let data = {};
    let ok = false;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(AppView.appData.slug)}/pr-import/candidates`);
      ok = res.ok;
      data = await res.json().catch(() => ({}));
    } catch (_) {
      list.innerHTML = '<div class="text-sm text-red-400 py-6 text-center">Couldn’t load pull requests — please try again.</div>';
      return;
    }
    if (!ok) {
      // 404 = GitHub not configured for this app. Treat as the
      // GitHub-off state rather than an error the user can't act on.
      list.innerHTML = '<div class="text-sm text-zinc-500 dark:text-zinc-400 py-6 text-center">GitHub isn’t configured for this app, so there’s nothing to import.</div>';
      return;
    }
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    if (candidates.length === 0) {
      list.innerHTML = '<div class="text-sm text-zinc-500 dark:text-zinc-400 py-6 text-center">No open pull requests are available to import right now.</div>';
      return;
    }
    list.innerHTML = candidates.map((c) => {
      const num = Number(c.number);
      const title = escapeHtml(String(c.title || ''));
      const author = escapeHtml(String(c.author || 'unknown'));
      const head = escapeHtml(String(c.headBranch || ''));
      const base = escapeHtml(String(c.baseBranch || ''));
      const url = escapeAttr(String(c.htmlUrl || ''));
      // #866: fork provenance. A fork-headed PR's branch lives in someone
      // else's repo — the preview is built from the PR head ref instead, and
      // the code is an outside contributor's. Say so on the row so the choice
      // is informed rather than discovered after importing.
      const fork = c.fromFork
        ? `<span class="block text-xs text-amber-600 dark:text-amber-400 mt-0.5" title="This branch lives in a fork, not in this app's own repository. The preview is built from the pull request's head commit. Review the changes on GitHub before importing.">from a fork — <span class="font-mono">${escapeHtml(String(c.headRepo || 'unknown fork'))}</span></span>`
        : '';
      return `
        <label class="flex items-start gap-3 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 cursor-pointer transition-colors">
          <input type="radio" name="import-pr-choice" value="${num}" class="mt-1 accent-violet-600">
          <span class="flex-1 min-w-0">
            <span class="block text-sm font-medium text-zinc-800 dark:text-zinc-200">#${num} · ${title}</span>
            <span class="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">${author} — <span class="font-mono">${head} → ${base}</span></span>
            ${fork}
            ${url ? `<a href="${url}" target="_blank" rel="noopener" class="inline-block text-xs text-violet-500 hover:underline mt-1" onclick="event.stopPropagation()">View on GitHub ↗</a>` : ''}
          </span>
        </label>`;
    }).join('');
    list.querySelectorAll('input[name="import-pr-choice"]').forEach((el) => {
      el.addEventListener('change', () => {
        AppView._importPrSelected = parseInt(el.value, 10);
        if (submitBtn) submitBtn.disabled = false;
        if (err) { err.classList.add('hidden'); err.textContent = ''; }
      });
    });
  },

  closeImportPrModal() {
    // Never dismiss out from under an in-flight import — the user would be
    // left with no idea whether the proposal was created.
    if (AppView._importPrBusy) return;
    const modal = document.getElementById('import-pr-modal');
    const err = document.getElementById('import-pr-error');
    if (modal) modal.classList.add('hidden');
    AppView._importPrSelected = null;
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
  },

  // #846: freeze / unfreeze the picker around the import POST. `on` shows
  // the progress row (naming the PR), dims the list so a second choice
  // can't be made mid-request, disables BOTH buttons (Cancel is disabled
  // rather than hidden so the footer doesn't reflow), and arms the ~8s
  // "still working" line. Every exit path calls it with `false` so the slow
  // timer can't outlive the request.
  _setImportPrBusy(on, prNumber) {
    AppView._importPrBusy = !!on;
    const list = document.getElementById('import-pr-list');
    const progress = document.getElementById('import-pr-progress');
    const progressText = document.getElementById('import-pr-progress-text');
    const slow = document.getElementById('import-pr-progress-slow');
    const cancelBtn = document.getElementById('import-pr-cancel');
    const submitBtn = document.getElementById('import-pr-submit');
    if (AppView._importPrSlowTimer) {
      clearTimeout(AppView._importPrSlowTimer);
      AppView._importPrSlowTimer = null;
    }
    if (slow) slow.classList.add('hidden');
    if (on) {
      if (progressText) {
        progressText.textContent =
          `Importing PR #${prNumber} — checking it on GitHub and creating the proposal…`;
      }
      if (progress) progress.classList.remove('hidden');
      if (list) list.classList.add('pointer-events-none', 'opacity-50');
      if (cancelBtn) cancelBtn.disabled = true;
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Importing…'; }
      AppView._importPrSlowTimer = setTimeout(() => {
        if (AppView._importPrBusy && slow) slow.classList.remove('hidden');
      }, 8000);
      return;
    }
    if (progress) progress.classList.add('hidden');
    if (list) list.classList.remove('pointer-events-none', 'opacity-50');
    if (cancelBtn) cancelBtn.disabled = false;
    if (submitBtn) {
      submitBtn.textContent = 'Import';
      // A selection may have been dropped by a list refresh (409 already
      // imported) — re-enable only when something is still picked.
      submitBtn.disabled = AppView._importPrSelected == null;
    }
  },

  // Turn an import failure into copy the user can act on. The server's own
  // 404/409 strings are already user-grade (PR not found / not open /
  // already imported / GitHub not configured), so they win; the status-code
  // branches cover the ones that aren't (503 = drainGuard mid-deploy).
  _importPrErrorMessage(status, serverError, prNumber) {
    if (serverError) return serverError;
    if (status === 404) return `PR #${prNumber} wasn’t found on GitHub — it may have been deleted.`;
    if (status === 409) return `PR #${prNumber} can’t be imported right now.`;
    if (status === 503) return 'The platform is restarting — try the import again in a few seconds.';
    return 'Something went wrong importing this PR. Please try again.';
  },

  async submitImportPr(e) {
    if (e) e.preventDefault();
    if (!AppView.appData || !AppView.appData.slug) return;
    if (AppView._importPrBusy) return;
    const pr = AppView._importPrSelected;
    const err = document.getElementById('import-pr-error');
    const showErr = (msg) => {
      if (err) { err.textContent = msg; err.classList.remove('hidden'); }
    };
    if (pr == null) return showErr('Pick a pull request to import.');
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
    AppView._setImportPrBusy(true, pr);
    let sessionId = null;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(AppView.appData.slug)}/pr-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = AppView._importPrErrorMessage(res.status, data.error, pr);
        // Keep the dialog open so the user can pick another PR. An
        // already-imported 409 means the list is stale — reload it so the
        // row they just tried disappears.
        const alreadyImported = res.status === 409
          && /already been imported/i.test(String(data.error || ''));
        AppView._setImportPrBusy(false);
        if (alreadyImported) await AppView._loadImportPrCandidates();
        showErr(msg);
        return;
      }
      sessionId = data.sessionId;
    } catch (_) {
      AppView._setImportPrBusy(false);
      showErr('Network error — please try again.');
      return;
    }
    // Import confirmed. Land on the proposal's discussion page, THEN close
    // the dialog — so it covers the transition instead of flashing the
    // screen the user came from.
    AppView._setImportPrBusy(false);
    try {
      await AppView.openTopic('proposal', sessionId);
    } catch (_) {
      // The proposal exists regardless; say so rather than swallowing it.
      // #866: set the expectation that the Preview button isn't there yet —
      // the staging build takes minutes, and until it lands the proposal
      // shows "Preview building…" with checks pending.
      if (typeof PlatformUI !== 'undefined' && PlatformUI.toast) {
        PlatformUI.toast(`PR #${pr} was imported — its preview is being built now. Find it in the Dev proposals list.`);
      }
    }
    AppView.closeImportPrModal();
  },

  // Share modal — exposes the app's bare subdomain URL so users can pass
  // it around outside the platform. The URL itself never carries auth;
  // child apps that gate visitors handle that at their own login page,
  // public apps (e.g. echo) render directly. resolveDevHost rewrites
  // localhost-shaped URLs to whatever hostname the browser is actually on,
  // so the link is reachable from a phone on the same LAN as the dev box.
  // ── Gesture-safe modal reveal/dismiss (shared by every header modal) ──
  //
  // The bug this guards against: a drawer row's click handler reveals a
  // full-screen modal, and on a touch device / WebView the very tap that
  // opened it — the browser can synthesize a trailing `click` ~300ms after
  // `touchend` — lands on the freshly-shown [data-modal-backdrop] and
  // dismisses the modal in the same gesture. The user saw nothing happen
  // ("Members & visibility does nothing").
  //
  // The fix is the DISMISS GUARD, not a deferral. revealModal() shows the
  // modal SYNCHRONOUSLY (deferring the reveal to requestAnimationFrame
  // proved unreliable in the platform WebView — the frame callback could be
  // throttled or dropped, leaving the drawer closed with no panel at all)
  // and stamps the open time on the element. modalDismissGuarded() then lets
  // each backdrop-dismiss handler ignore any dismiss click that arrives
  // within MODAL_GESTURE_GUARD_MS of the open — i.e. the trailing ghost
  // click. Revealing now guarantees the panel appears; the guard keeps it
  // from being closed by its own opening gesture. Done centrally so every
  // caller (members, share, settings) inherits it.
  MODAL_GESTURE_GUARD_MS: 450,
  revealModal(modal) {
    if (!modal) return;
    modal.dataset.openedAt = String(Date.now());
    modal.classList.remove('hidden');
    // Diagnostic breadcrumb (surfaces in the platform dev console) so a
    // future "panel didn't open" report is debuggable at a glance.
    try { console.debug('[modal] revealed', modal.id || '(no id)'); } catch {}
  },
  modalDismissGuarded(modal) {
    const at = modal && modal.dataset ? Number(modal.dataset.openedAt) : 0;
    return at > 0 && (Date.now() - at) < AppView.MODAL_GESTURE_GUARD_MS;
  },

  openShareModal() {
    const url = AppView.appData?.url ? resolveDevHost(AppView.appData.url) : '';
    const modal = document.getElementById('share-modal');
    const input = document.getElementById('share-url-input');
    const link = document.getElementById('share-open-link');
    const copyBtn = document.getElementById('share-copy-btn');
    if (input) input.value = url;
    if (link) link.href = url || '#';
    if (copyBtn) copyBtn.textContent = 'Copy';
    // Reveal now (see revealModal); the dismiss guard stops the opening tap
    // from ghost-clicking the backdrop closed.
    AppView.revealModal(modal);
    setTimeout(() => { if (input) { input.focus(); input.select(); } }, 0);
  },

  closeShareModal() {
    const modal = document.getElementById('share-modal');
    if (modal) modal.classList.add('hidden');
  },

  // Copy the share URL to the clipboard and flash "Copied!" on the button.
  // Falls back to selecting the input + execCommand for browsers/contexts
  // where navigator.clipboard isn't available (e.g. http: localhost in
  // some browsers).
  async copyShareUrl() {
    const input = document.getElementById('share-url-input');
    const btn = document.getElementById('share-copy-btn');
    const url = input?.value || '';
    if (!url) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {}
    if (!ok && input) {
      try {
        input.focus();
        input.select();
        ok = document.execCommand('copy');
      } catch {}
    }
    if (btn) {
      const original = btn.textContent;
      btn.textContent = ok ? 'Copied!' : 'Copy failed';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
  },

  async submitRename(e) {
    if (e) e.preventDefault();
    if (!AppView.appData) return;
    const input = document.getElementById('rename-input');
    const err = document.getElementById('rename-error');
    const submitBtn = document.getElementById('rename-submit');
    const next = (input?.value || '').trim();
    const current = AppView.appData.name || '';

    const showError = (msg) => {
      if (!err) return;
      err.textContent = msg;
      err.classList.remove('hidden');
    };

    if (!next || next.length < 3) return showError('Name must be at least 3 characters');
    if (next.length > 64) return showError('Name must be 64 characters or fewer');
    if (next === current) return showError('New app name must differ from the current one');

    submitBtn.disabled = true;
    submitBtn.textContent = 'Opening PR...';
    try {
      // Renames now open a PR that edits dapp.json's `name` field; it
      // lands through the normal merge-vote pipeline (the new name applies
      // when the PR merges and the app redeploys). See
      // POST /api/apps/:slug/rename in src/routes/apps.js.
      const res = await fetch(`/api/apps/${AppView.appData.slug}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showError(data.error || 'Failed to open rename PR');
        return;
      }
      AppView.closeRenameModal();
      AppView.refreshDevData('vote');
    } catch {
      showError('Network error while opening rename PR');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Open PR';
    }
  },

  // Called by the global WS handler when this app is renamed by group vote.
  applyRename(newName) {
    if (!AppView.appData) return;
    AppView.appData.name = newName;
    if (App.currentTab === 'dev') {
      AppView.refreshDevData('vote');
    }
  },

  // Forum revision: the dedicated session view. There is no session
  // list / meta panel anymore — sessions are reached from the forum's
  // Your-sessions strip, proposal cards, and the "+" flow, and a
  // missing/unopenable id bounces back to the card list. The App
  // secrets / display-name shortcuts that used to live here now sit
  // directly in the "+" menu (#645).
  async renderDevChatTab(restoreSessionId) {
    const content = AppView._devContainer();
    if (!content) return;
    if (!restoreSessionId) {
      if (typeof App !== 'undefined' && App.switchTab) App.switchTab('dev');
      return;
    }

    content.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;min-height:0">
        <div id="dc-view" style="flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden"></div>
      </div>`;

    if (!AppView.appData) return;

    // Ground-truth guard: if the in-memory session belongs to a
    // different app than the one we're rendering, drop it before
    // loading (fixes #20).
    if (
      DevChat.currentSession &&
      DevChat.currentSession.app_slug &&
      DevChat.currentSession.app_slug !== AppView.appData.slug
    ) {
      DevChat.reset();
    }

    await DevChat.loadSessions(AppView.appData.slug);
    await DevChat.openSession(restoreSessionId);

    // Archived / inaccessible session: fall back to the forum rather
    // than stranding an empty view.
    if (!DevChat.currentSession || String(DevChat.currentSession.id) !== String(restoreSessionId)) {
      if (typeof App !== 'undefined' && App.switchTab) App.switchTab('dev');
      return;
    }

    // #846: an imported PR has NO dev chat — its code lives on GitHub and
    // this view would render an empty transcript with a live composer (see
    // the importedNote in _proposalDetailsHtml). Any route that still
    // reaches it (old bookmark, Back button, pasted link) lands on the
    // proposal's discussion page instead. Nulling currentSession is enough
    // teardown: the heartbeat interval openSession armed no-ops without it,
    // and the outer switchTab's trailing updateHash() reads the topic state
    // the redirect just set, so the URL follows.
    if (DevChat.currentSession.source === 'imported') {
      const importedId = Number(restoreSessionId);
      DevChat.currentSession = null;
      AppView.openTopic('proposal', importedId);
      return;
    }

    DevChat.renderChatView();

    // #194: one-shot hint set by the "+" menu's "Propose a change" —
    // proposals are PRs, so the path runs through a session.
    // #1049: suppressed when the development-flow picker / walkthrough is
    // about to render in the same empty pane — that card asks the same
    // question with more precision, and two stacked explanations of what a
    // proposal is read as noise.
    if (AppView._proposalHint
        && typeof DevChat !== 'undefined'
        && typeof DevChat._devFlowTarget === 'function'
        && DevChat._devFlowTarget()) {
      AppView._proposalHint = false;
    }
    if (AppView._proposalHint) {
      AppView._proposalHint = false;
      const view = document.getElementById('dc-view');
      if (view) {
        view.insertAdjacentHTML('afterbegin',
          '<div class="mx-3 mt-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-xs text-zinc-600 dark:text-zinc-300 shrink-0">'
          + 'Describe the change you want — when it\'s ready, promoting this session\'s PR is what creates the proposal everyone votes on.'
          + '</div>');
      }
    }
  },

  // Fetch the current secrets summary and paint the state slot on the
  // "+" menu's App secrets item (#dc-secrets-state). Called when the
  // menu opens and again from Secrets.handleSet/handleClear so direct
  // admin edits reflect immediately. Silently no-ops when the slot
  // isn't mounted (e.g. user is on a different tab).
  async refreshDevChatSecretsState() {
    const stateEl = document.getElementById('dc-secrets-state');
    if (!stateEl || !AppView.appData) return;

    const setLabel = (text, tone) => {
      stateEl.textContent = text;
      stateEl.className = 'text-xs ' + (tone === 'err'
        ? 'font-medium text-red-500 dark:text-red-400'
        : 'text-zinc-400 dark:text-zinc-500');
    };

    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/secrets`);
      if (!res.ok) {
        setLabel('', 'neutral');
        return;
      }
      const data = await res.json();
      if (!data.manifestKnown) {
        // Pre-first-deploy hint — distinct from "everything's fine"
        // because the manifest just hasn't been ingested yet.
        setLabel('No manifest yet', 'neutral');
        return;
      }
      // Only `required && !hasValue` is actionable: it blocks deploys.
      // Optional-but-unset keys (including ones that fall back to a
      // default declared in dapp.json) are fine, so they shouldn't
      // light anything up. When nothing is broken we leave the slot
      // blank — the chevron alone says "tap to manage".
      //
      // `unwritable` rows are excluded for the same "actionable" reason:
      // the platform's required credential rows (GITHUB_APP_ID,
      // ADMIN_PASSWORD…) come from GitHub secrets, so counting them would
      // permanently badge the menu with a state this panel cannot fix.
      // A `proposed` row is excluded too: its declaration isn't merged, so
      // nothing is broken yet — a proposal in flight is not a blocked
      // deploy, and badging it red would make the panel look wrong for as
      // long as the vote runs.
      const list = Array.isArray(data.secrets) ? data.secrets : [];
      const missing = list.filter((s) => s.required && !s.hasValue
        && !s.unwritable && s.state !== 'proposed').length;
      if (missing > 0) {
        setLabel(`${missing} required missing`, 'err');
      } else {
        setLabel('', 'neutral');
      }
    } catch {
      setLabel('', 'neutral');
    }
  },

  async pollStatus() {
    if (!AppView.appData || App.currentTab !== 'app') return;
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}`);
      if (!res.ok) return;
      const { app: updated } = await res.json();
      AppView.appData = updated;
      if (updated.status === 'running') {
        await AppView.refreshToken(AppView.appData.slug);
        AppView.renderAppTab();
      } else if (updated.status === 'creating') {
        setTimeout(() => AppView.pollStatus(), 3000);
      } else {
        AppView.renderAppTab();
      }
    } catch {}
  },

  // Activity tracking: counts seconds while the user is on the App tab
  startActivityTracking(slug) {
    AppView.activeSeconds = 0;
    AppView.iframeFocused = false;

    AppView.activityInterval = setInterval(() => {
      if (App.currentTab === 'app' && document.visibilityState === 'visible') {
        AppView.activeSeconds++;

        // Flush every 30 seconds
        if (AppView.activeSeconds >= 30) {
          AppView.flushActivity(slug);
        }
      }
    }, 1000);

    // Flush on tab switch or page hide
    document.addEventListener('visibilitychange', AppView._onVisibilityChange);
  },

  stopActivityTracking() {
    if (AppView.activityInterval) {
      clearInterval(AppView.activityInterval);
      AppView.activityInterval = null;
    }
    if (AppView.appData && AppView.activeSeconds > 0) {
      AppView.flushActivity(AppView.appData.slug);
    }
    document.removeEventListener('visibilitychange', AppView._onVisibilityChange);
  },

  _onVisibilityChange() {
    if (document.visibilityState === 'hidden' && AppView.appData && AppView.activeSeconds > 0) {
      AppView.flushActivity(AppView.appData.slug);
    }
  },

  async flushActivity(slug) {
    const seconds = AppView.activeSeconds;
    if (seconds <= 0) return;
    AppView.activeSeconds = 0;

    try {
      await fetch(`/api/apps/${slug}/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds }),
      });
    } catch {}
  },

  // #353: the self-app is a hash-routed SPA — its internal screens live in
  // location.hash (`#app/...`, `#leaderboard`, `#admin/...`), so a testing
  // path joined as a server pathname just loads the home feed. Mirror the
  // server-side normalisation (src/services/visuals.js selfAppHashPath):
  // when the path's first segment is one of the SPA hash routes, move it
  // into the fragment; leave the bare '/', an already-'/#...' path, and
  // genuinely standalone server pages (/cli/authorize) untouched. 'admin'
  // joined the list in #860, when the seven standalone admin pages became
  // #admin console sections.
  _SELF_APP_HASH_ROUTES: ['app', 'leaderboard', 'group-chat', 'individual-chat', 'admin'],
  _selfAppHashPath(p) {
    const path = typeof p === 'string' ? p : null;
    if (!path || !path.startsWith('/') || path.startsWith('/#')) return path;
    const firstSeg = path.slice(1).split(/[/?#]/)[0];
    if (!AppView._SELF_APP_HASH_ROUTES.includes(firstSeg)) return path;
    return '/#' + path.slice(1);
  },

  // #439: ensure-then-open. Every Preview click routes through here so a
  // preview that was torn down while the user was away (idle GC, lost
  // container) is rebuilt on demand instead of opening a dead page. We open
  // the overlay immediately with a "spinning back up" loader, ask the
  // server whether the preview is live, and either open it as-is (`ready`)
  // or wait for the rebuild's `staging_ready` WS event (`rebuilding`).
  //
  //   sessionId  — the session whose preview we're opening (drives the
  //                ensure-staging POST and pending-marker match).
  //   fallbackUrl — the last-known preview URL (may be stale/dead); used
  //                only when the server says `ready` without echoing a URL.
  //   testing    — the session's testing guidance ({ md, path } | null).
  //   opts.jump  — open the deep link directly (the "Test this change" btn).
  //   opts.dock  — #771: open as the docked side panel beside the dev chat
  //                (the caller must have mounted #dc-staging-panel first —
  //                see DevChat.previewStaging / openStagingPanel).
  async ensureStaging(sessionId, fallbackUrl, testing, opts) {
    const overlay = document.getElementById('staging-overlay');
    if (!overlay) return;
    const jump = !!(opts && opts.jump);
    const dock = !!(opts && opts.dock);

    // #621: read-only viewers can't trigger a rebuild (the ensure POST is
    // collab-gated) — open the last-known staging URL directly. If it was
    // GC'd they see the dead-preview page rather than a rebuild spinner.
    if (AppView.readOnly) {
      if (fallbackUrl) AppView.swapToStaging(fallbackUrl, testing, { jump, dock });
      return;
    }

    // Open the overlay + "spinning back up" loader right away, and take a
    // fresh load id so backing out (closeStagingOverlay) cancels this wait.
    overlay.classList.remove('hidden');
    // #771: apply the requested mode before anything paints, so the loader
    // shows inside the side panel on a docked open (and a stale docked
    // class can't leak into a fullscreen open from the vote panel).
    if (dock && document.getElementById('dc-staging-panel')) {
      AppView._stagingDockable = true;
      AppView._setStagingMode('docked');
    } else {
      AppView._stagingDockable = false;
      AppView._setStagingMode('fullscreen');
    }
    if (window.DevConsole) DevConsole.setButtonVisible(true);
    const loadId = ++AppView._stagingLoadId;
    document.getElementById('staging-iframe').src = '';
    AppView._pendingStagingPreview = null;
    // #816: a NEUTRAL opening state. This used to assert "the preview was
    // paused… this usually takes 20–60 seconds" before the server had even
    // been asked whether a rebuild was needed — so the overwhelmingly common
    // case (a preview that is live and answers in well under a second) was
    // fronted by a screen promising a minute's wait. The rebuild copy now
    // lives in the `rebuilding` branch below, where it is actually true.
    AppView._setStagingLoader(true, { title: 'Opening preview…', sub: '' });
    document.getElementById('staging-back').onclick = () => AppView.closeStagingOverlay();

    let data;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/ensure-staging`, { method: 'POST' });
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        AppView._showStagingUnavailable(loadId, data.error || 'This preview could not be rebuilt.');
        return;
      }
    } catch {
      AppView._showStagingUnavailable(loadId, 'Network error while rebuilding the preview. Try again in a moment.');
      return;
    }
    // Backed out while we waited on the POST.
    if (loadId !== AppView._stagingLoadId) return;

    if (data.status === 'ready') {
      // #816: `verified` means the server just watched the container answer
      // its own healthcheck, so the client can point the iframe straight at
      // it instead of re-deriving readiness with a poll of its own.
      // `checksRunning` says the post-build screenshot/checks pass is still
      // hitting the same container, which is the one honest reason a live
      // preview's first load can be slow.
      AppView.swapToStaging(data.url || fallbackUrl, testing, {
        jump,
        verified: !!data.verified,
        checksRunning: !!data.checksRunning,
      });
      return;
    }
    if (data.status === 'unavailable') {
      AppView._showStagingUnavailable(
        loadId,
        data.reason === 'demo'
          ? 'Live previews can’t be rebuilt in this demo environment.'
          : 'This preview isn’t available right now.'
      );
      return;
    }
    // status === 'rebuilding' — the ONE case where a real rebuild is
    // running and the 20–60s estimate is true. Park a marker the
    // staging_ready / staging_failed WS handlers match against, then keep
    // the loader up. A client-side give-up keeps the loader honest if the
    // event never lands (the server rebuild is still allowed to finish on
    // its own).
    AppView._setStagingLoader(true, {
      title: 'Spinning the preview back up…',
      sub: 'The preview was paused after a while of inactivity. Rebuilding it '
        + 'from the session’s latest changes — this usually takes 20–60 seconds.',
    });
    AppView._pendingStagingPreview = { sessionId, jump, testing, dock, loadId };
    if (AppView._stagingRebuildTimer) clearTimeout(AppView._stagingRebuildTimer);
    AppView._stagingRebuildTimer = setTimeout(() => {
      if (loadId !== AppView._stagingLoadId) return;
      if (!AppView._pendingStagingPreview || AppView._pendingStagingPreview.loadId !== loadId) return;
      AppView._setStagingLoader(true, {
        title: 'This is taking longer than expected',
        sub: 'The rebuild is still running on the server. Close this and click '
          + 'Preview again in a moment.',
      });
    }, 180000);
  },

  // #439: terminal loader state when a rebuild can't proceed (no changes,
  // demo env, build failure). Shows the reason in the existing loader with
  // the back button already wired by ensureStaging.
  _showStagingUnavailable(loadId, message) {
    if (loadId !== AppView._stagingLoadId) return;
    AppView._pendingStagingPreview = null;
    AppView._setStagingLoader(true, {
      title: 'Preview unavailable',
      sub: message,
    });
  },

  // #439: called by the staging_ready / staging_failed WS handlers when a
  // pending on-demand rebuild resolves. Opens the (new) URL on success, or
  // surfaces the failure reason in the loader.
  onStagingRebuildResult(sessionId, { url, failed, error } = {}) {
    const pending = AppView._pendingStagingPreview;
    if (!pending || pending.sessionId !== sessionId) return;
    if (pending.loadId !== AppView._stagingLoadId) { AppView._pendingStagingPreview = null; return; }
    if (AppView._stagingRebuildTimer) { clearTimeout(AppView._stagingRebuildTimer); AppView._stagingRebuildTimer = null; }
    AppView._pendingStagingPreview = null;
    if (failed) {
      AppView._setStagingLoader(true, {
        title: 'Preview couldn’t be rebuilt',
        sub: error || 'The staging build failed. See the dev chat for details.',
      });
      return;
    }
    if (url) AppView.swapToStaging(url, pending.testing, { jump: pending.jump });
  },

  // Open staging in the overlay (fullscreen, or docked beside dev chat).
  //
  // #127: `testing` is the session's bot-generated testing guidance
  // ({ md, path } | null) and `opts.jump` opens the iframe directly at the
  // deep-link path (the dev-chat "Test this change" button does this).
  // Callers must never thread the markdown through an HTML attribute —
  // use a wrapper that looks the object up at click time
  // (swapToStagingForSession / DevChat.previewStaging).
  //
  // #771: `opts.dock` (explicit boolean) selects the docked side-panel
  // mode. When absent the CURRENT mode is preserved — the rebuild
  // resolution path (onStagingRebuildResult) relies on this so a mid-wait
  // fullscreen/dock toggle wins over the mode the click originally asked
  // for.
  //
  // #816: `opts.verified` means the server confirmed the container answered
  // its healthcheck moments ago, so the readiness poll is skipped entirely
  // and the iframe is pointed at the preview immediately.
  // `opts.checksRunning` adds one line explaining a legitimately slower
  // first load while the post-build checks pass runs.
  swapToStaging(stagingUrl, testing, opts) {
    const overlay = document.getElementById('staging-overlay');
    const iframe = document.getElementById('staging-iframe');
    const label = document.getElementById('staging-url-label');
    if (!overlay || !iframe) return;

    if (opts && typeof opts.dock === 'boolean') {
      if (opts.dock && document.getElementById('dc-staging-panel')) {
        AppView._stagingDockable = true;
        if (AppView._stagingMode !== 'docked') AppView._setStagingMode('docked');
      } else {
        AppView._stagingDockable = false;
        if (AppView._stagingMode !== 'fullscreen') AppView._setStagingMode('fullscreen');
      }
    }

    const resolved = resolveDevHost(stagingUrl);

    // Re-validate the deep link client-side (the server already did via
    // testing-notes.validatePath, but defense-in-depth is cheap): must be
    // relative and not protocol-relative, so new URL() below can never
    // leave the staging origin.
    const rawPath = testing && typeof testing.path === 'string' ? testing.path : null;
    const safePath = rawPath && rawPath.startsWith('/') && !rawPath.startsWith('//') ? rawPath : null;
    const testingMd = testing && typeof testing.md === 'string' && testing.md.trim() ? testing.md : null;
    AppView._stagingTesting = (safePath || testingMd) ? { md: testingMd, path: safePath } : null;

    // Build iframe URLs with the URL API so a deep link carrying its own
    // query string composes with the token param (no '?token=' concat).
    // The URL API also keeps a `#app/...` fragment after the token query,
    // so the self-app deep link below loads correctly (#353).
    const buildSrc = (path) => {
      const visit = AppView.appData && AppView.appData.self_hosted
        ? AppView._selfAppHashPath(path)
        : path;
      let url;
      try { url = new URL(visit || '/', resolved); } catch { return resolved; }
      // App-scoped token (see refreshToken): only attach it when it was
      // minted for the app this staging preview belongs to.
      const token = AppView.tokenForSlug(AppView.appData && AppView.appData.slug);
      if (token) url.searchParams.set('token', token);
      return url.toString();
    };
    const jump = !!(opts && opts.jump) && !!safePath;
    // Mutable so a "Test this change" click during the readiness poll
    // retargets the pending load instead of being clobbered by it.
    const pending = { src: buildSrc(jump ? safePath : null) };

    if (label) label.textContent = resolved;
    overlay.classList.remove('hidden');
    // #771: the toggle's visibility depends on the overlay being open.
    AppView._updateStagingModeUi();
    if (window.DevConsole) DevConsole.setButtonVisible(true);

    AppView._renderTestingControls(buildSrc, pending, jump);

    document.getElementById('staging-back').onclick = () => {
      AppView.closeStagingOverlay();
    };

    iframe.src = '';
    const loadId = ++AppView._stagingLoadId;
    const checksRunning = !!(opts && opts.checksRunning);

    // #816: FAST PATH. The server verified this container answered its
    // healthcheck moments ago, so there is nothing left to wait for —
    // point the iframe at the preview now. The loader stays up (rather
    // than being hidden before the src is even assigned, as it used to be)
    // so the page render has a spinner instead of a black rectangle, and
    // _watchStagingIframeLoad takes it down the instant the page paints.
    if (opts && opts.verified) {
      AppView._setStagingLoader(true, {
        title: 'Loading the preview…',
        sub: checksRunning
          ? 'Automated checks are running against this preview, so the first load may be a little slower.'
          : '',
      });
      AppView._watchStagingIframeLoad(iframe, loadId);
      iframe.src = pending.src;
      return;
    }

    // FALLBACK. No server verification (a read-only viewer opening a
    // last-known URL, a preview that didn't answer its healthcheck, or a
    // rebuild we're opening straight off the WS event): confirm the host
    // answers before pointing the iframe at it, so a dead preview shows a
    // spinner rather than a browser error page. (The probe always targets
    // the origin root, not the deep link — readiness is a host property,
    // and the deep path may be app-routed or auth-gated.)
    AppView._waitForStagingReady(resolved, loadId, { checksRunning }).then((ready) => {
      // A newer swap (or a close) superseded this one — drop the result.
      if (loadId !== AppView._stagingLoadId) return;
      if (!ready) return;
      // Keep the spinner up across the render, same as the fast path.
      AppView._setStagingLoader(true, { title: 'Loading the preview…', sub: '' });
      AppView._watchStagingIframeLoad(iframe, loadId);
      iframe.src = pending.src;
    });
  },

  // #816: the last leg — the iframe's own page load — used to be
  // unobserved: the loader was hidden before `src` was assigned, so the
  // user watched a black rectangle with no spinner and no timeout while the
  // preview rendered. Hide the loader on the real signal (`load`), surface
  // a failed navigation (`error`), and keep a safety timeout so an app that
  // hangs on first byte can't spin forever.
  //
  // Every path re-checks `_stagingLoadId`: closing the overlay or opening a
  // different preview bumps it, and a late event from the superseded load
  // must not touch the loader.
  _stagingIframeTimer: null,
  _watchStagingIframeLoad(iframe, loadId) {
    if (!iframe) return;
    if (AppView._stagingIframeTimer) {
      clearTimeout(AppView._stagingIframeTimer);
      AppView._stagingIframeTimer = null;
    }
    const settle = () => {
      iframe.onload = null;
      iframe.onerror = null;
      if (AppView._stagingIframeTimer) {
        clearTimeout(AppView._stagingIframeTimer);
        AppView._stagingIframeTimer = null;
      }
    };
    iframe.onload = () => {
      settle();
      if (loadId !== AppView._stagingLoadId) return;
      AppView._setStagingLoader(false);
    };
    iframe.onerror = () => {
      settle();
      if (loadId !== AppView._stagingLoadId) return;
      AppView._setStagingLoader(true, {
        title: 'This is taking longer than expected',
        sub: 'The preview didn’t finish loading. Close this and click Preview '
          + 'again in a moment.',
      });
    };
    AppView._stagingIframeTimer = setTimeout(() => {
      AppView._stagingIframeTimer = null;
      if (loadId !== AppView._stagingLoadId) return;
      AppView._setStagingLoader(true, {
        title: 'This is taking longer than expected',
        sub: 'The preview is still loading. Close this and click Preview '
          + 'again in a moment.',
      });
    }, AppView.STAGING_IFRAME_LOAD_TIMEOUT_MS);
  },

  // #127: Preview entry point for vote-panel / group-chat rows — looks up
  // the testing guidance stashed by voteButtonsHtml at render time, so the
  // existing Preview button passes it through without any new UI there.
  swapToStagingForSession(sessionId, stagingUrl) {
    // #439: route through ensure-then-open so a vote-panel preview that was
    // torn down (idle GC, lost container) rebuilds on click instead of
    // opening a dead page.
    AppView.ensureStaging(sessionId, stagingUrl, (AppView._sessionTesting || {})[sessionId] || null, {});
  },

  // #439: pending on-demand-rebuild marker ({ sessionId, jump, testing,
  // dock, loadId } | null), set by ensureStaging and consumed by the
  // staging_ready / staging_failed WS handlers via onStagingRebuildResult.
  _pendingStagingPreview: null,
  _stagingRebuildTimer: null,

  // ── Docked staging preview (#771) ─────────────────────────────────
  //
  // Dev chat opens the staging preview as a resizable side panel beside
  // the chat (like the spec viewer) instead of the fullscreen overlay.
  // The overlay element never moves in the DOM — reparenting an iframe
  // reloads it — so "docked" is a mode on the SAME fixed #staging-overlay:
  // dev-chat renders an empty placeholder slot (#dc-staging-panel) as a
  // flex sibling of the chat pane, and we pin the overlay over the slot's
  // bounding rect (kept in sync by a ResizeObserver + window resize).
  // Toggling fullscreen just adds/removes the docked class, so the iframe
  // keeps its state either way.
  _stagingMode: 'fullscreen',   // 'fullscreen' | 'docked'
  // True while the current preview was opened from dev chat with a dock
  // request — gates the "Exit full screen" re-dock affordance. Cleared on
  // close so an unrelated later preview can't re-dock into a stale slot.
  _stagingDockable: false,
  _stagingDockObserver: null,   // ResizeObserver on the current slot
  _stagingDockOnResize: null,   // bound window-resize handler (added once)
  _stagingDockMql: null,        // matchMedia('(min-width: 1024px)') (bound once)
  _STAGING_DOCK_MEDIA: '(min-width: 1024px)',

  // Same breakpoint as the spec viewer's side-panel layout.
  _stagingDockViewport() {
    try { return !!(window.matchMedia && window.matchMedia(AppView._STAGING_DOCK_MEDIA).matches); }
    catch { return false; }
  },

  // Enter/leave docked mode on the overlay. Pure presentation — callers
  // own the DevChat slot state (see expandStagingFullscreen /
  // dockStagingPanel / closeStagingOverlay).
  _setStagingMode(mode) {
    const overlay = document.getElementById('staging-overlay');
    AppView._stagingMode = mode === 'docked' ? 'docked' : 'fullscreen';
    if (overlay) {
      if (AppView._stagingMode === 'docked') {
        overlay.classList.add('staging-overlay-docked');
        AppView._ensureStagingDockListeners();
        AppView.rebindStagingDock();
      } else {
        overlay.classList.remove('staging-overlay-docked');
        // Back to the CSS `inset: 0` fullscreen geometry.
        overlay.style.top = '';
        overlay.style.left = '';
        overlay.style.width = '';
        overlay.style.height = '';
        if (AppView._stagingDockObserver) AppView._stagingDockObserver.disconnect();
      }
    }
    AppView._updateStagingModeUi();
  },

  // One-time global listeners: window resize re-syncs the pinned overlay,
  // and crossing below the desktop breakpoint while docked flips to
  // fullscreen (the slot's CSS hides below 1024px, so a docked overlay
  // would be glued to a zero rect). No auto-re-dock on widening — the
  // user explicitly toggles back.
  _ensureStagingDockListeners() {
    if (!AppView._stagingDockOnResize) {
      AppView._stagingDockOnResize = () => AppView._syncStagingDockGeometry();
      try { window.addEventListener('resize', AppView._stagingDockOnResize); } catch {}
    }
    if (!AppView._stagingDockMql && window.matchMedia) {
      try {
        const mql = window.matchMedia(AppView._STAGING_DOCK_MEDIA);
        const onChange = () => {
          if (!mql.matches && AppView._stagingMode === 'docked') {
            AppView.expandStagingFullscreen();
          }
        };
        if (mql.addEventListener) mql.addEventListener('change', onChange);
        else if (mql.addListener) mql.addListener(onChange);
        AppView._stagingDockMql = mql;
      } catch {}
    }
  },

  // Re-attach the ResizeObserver to the CURRENT slot element and re-sync.
  // Called by dev-chat's renderChatView after every re-render (the slot
  // node is recreated by innerHTML rewrites) and by _setStagingMode.
  // Fail-safe: a missing slot while docked means the session view
  // unmounted under us — close rather than float over a dead rect.
  rebindStagingDock() {
    if (AppView._stagingMode !== 'docked') return;
    const slot = document.getElementById('dc-staging-panel');
    if (!slot) { AppView.closeStagingOverlay(); return; }
    if (!AppView._stagingDockObserver && typeof ResizeObserver !== 'undefined') {
      AppView._stagingDockObserver = new ResizeObserver(() => AppView._syncStagingDockGeometry());
    }
    if (AppView._stagingDockObserver) {
      AppView._stagingDockObserver.disconnect();
      try { AppView._stagingDockObserver.observe(slot); } catch {}
    }
    AppView._syncStagingDockGeometry();
  },

  // Pin the overlay over the slot's current bounding rect.
  _syncStagingDockGeometry() {
    if (AppView._stagingMode !== 'docked') return;
    const overlay = document.getElementById('staging-overlay');
    if (!overlay) return;
    const slot = document.getElementById('dc-staging-panel');
    if (!slot) { AppView.closeStagingOverlay(); return; }
    const r = slot.getBoundingClientRect();
    overlay.style.top = `${Math.round(r.top)}px`;
    overlay.style.left = `${Math.round(r.left)}px`;
    overlay.style.width = `${Math.round(r.width)}px`;
    overlay.style.height = `${Math.round(r.height)}px`;
  },

  // "Full screen" (docked header button, and the narrow-viewport
  // auto-flip): expand the SAME overlay to fullscreen — no iframe touch,
  // no reload — and collapse the dev-chat slot so the chat reflows.
  expandStagingFullscreen() {
    if (AppView._stagingMode !== 'docked') return;
    AppView._setStagingMode('fullscreen');
    if (typeof DevChat !== 'undefined' && DevChat.stagingPanel && DevChat.stagingPanel.open) {
      DevChat.stagingPanel.open = false;
      DevChat.renderChatView();
    }
  },

  // "Exit full screen": re-dock the live preview beside the chat. Only
  // meaningful while the preview is dockable (opened from dev chat), the
  // session view is still mounted, and the viewport is wide enough.
  dockStagingPanel() {
    if (AppView._stagingMode === 'docked' || !AppView._stagingDockable) return;
    if (typeof DevChat === 'undefined' || !DevChat.currentSession) return;
    if (!AppView._stagingDockViewport()) return;
    if (DevChat.openStagingPanel) DevChat.openStagingPanel();
    AppView._setStagingMode('docked');
  },

  toggleStagingFullscreen() {
    if (AppView._stagingMode === 'docked') AppView.expandStagingFullscreen();
    else AppView.dockStagingPanel();
  },

  // Sync the mode-dependent header chrome: the Full screen / Exit full
  // screen toggle and the docked ×-close. Idempotent; safe with the
  // overlay hidden.
  _updateStagingModeUi() {
    const overlay = document.getElementById('staging-overlay');
    const btn = document.getElementById('staging-fullscreen-btn');
    const dockClose = document.getElementById('staging-dock-close');
    if (dockClose) dockClose.onclick = () => AppView.closeStagingOverlay();
    if (!btn) return;
    btn.onclick = () => AppView.toggleStagingFullscreen();
    const docked = AppView._stagingMode === 'docked';
    const overlayOpen = !!overlay && !overlay.classList.contains('hidden');
    const canRedock = AppView._stagingDockable
      && typeof DevChat !== 'undefined' && !!DevChat.currentSession
      && AppView._stagingDockViewport();
    btn.classList.toggle('hidden', !overlayOpen || (!docked && !canRedock));
    btn.textContent = docked ? 'Full screen' : 'Exit full screen';
    btn.title = docked
      ? 'Expand the preview to fill the screen'
      : 'Dock the preview back beside the chat';
    // #970: docking / un-docking moves the preview frame's rect, so the
    // insets that apply to it change (a docked panel is nowhere near the
    // home indicator; a fullscreen one sits right on it).
    AppView.scheduleSafeAreaBroadcast();
  },

  // #127: per-render registry of { md, path } testing guidance keyed by
  // session id, populated by voteButtonsHtml. Exists so bot-authored
  // markdown never transits an inline onclick attribute.
  _sessionTesting: {},

  // The current preview's testing guidance ({ md, path } | null), set by
  // swapToStaging and cleared on close.
  _stagingTesting: null,

  // #127: show/hide + wire the overlay's "Test this change" button and the
  // collapsible "How to test" panel for the current preview. `jump` is true
  // only when the preview was entered via an explicit "Test this change"
  // button — the one path where the panel auto-opens (#237).
  _renderTestingControls(buildSrc, pending, jump) {
    const btn = document.getElementById('staging-test-btn');
    const panel = document.getElementById('staging-testing-panel');
    const content = document.getElementById('staging-testing-content');
    const closeBtn = document.getElementById('staging-testing-close');
    const iframe = document.getElementById('staging-iframe');
    if (!btn || !panel || !content) return;

    panel.classList.add('hidden');
    const t = AppView._stagingTesting;
    if (!t) {
      btn.classList.add('hidden');
      content.innerHTML = '';
      return;
    }

    // Bot-authored markdown: render through DevChat's escaping markdown
    // pipeline (marked + DOMPurify), falling back to escaped plain text if
    // dev-chat.js failed to load. Reach DevChat via a bare reference and
    // `typeof` guard rather than `window.DevChat` — DevChat is a top-level
    // `const`, which never becomes a `window` property (#237; same pitfall
    // documented in group-chat.js).
    if (t.md) {
      content.innerHTML = (typeof DevChat !== 'undefined' && typeof DevChat.renderMarkdown === 'function')
        ? DevChat.renderMarkdown(t.md)
        : `<pre class="whitespace-pre-wrap font-sans">${escapeHtml(t.md)}</pre>`;
    } else {
      content.innerHTML = '<span class="text-zinc-500">Use the button above to jump to the changed feature.</span>';
    }

    btn.classList.remove('hidden');
    btn.title = t.path ? 'Open the preview at the changed feature' : 'Show the testing instructions';
    btn.onclick = () => {
      // Toggle: a second click (panel already open) just closes it.
      if (t.md && !panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        return;
      }
      if (t.path) {
        // Retarget the (possibly still pending) load at the deep link —
        // only if it isn't already pointing there, so re-opening the
        // panel doesn't reload the iframe.
        const target = buildSrc(t.path);
        if (pending.src !== target) {
          pending.src = target;
          if (iframe && iframe.src) iframe.src = target;
        }
      }
      if (t.md) panel.classList.remove('hidden');
    };
    if (closeBtn) closeBtn.onclick = () => panel.classList.add('hidden');

    // #237: the panel no longer auto-opens on every preview. It auto-shows
    // only when the user entered through an explicit "Test this change"
    // button (jump) — plain Preview keeps it hidden until asked for.
    if (jump && t.md) panel.classList.remove('hidden');
  },

  // Incremented on every swap/close so an in-flight readiness poll for a
  // superseded preview can detect it's stale and bail without touching the
  // iframe.
  _stagingLoadId: 0,

  // #816: an EXPLICIT empty string clears the line; only `undefined` leaves
  // it alone. The old truthiness check made '' a no-op, which would leave a
  // previous state's sub-line (the rebuild estimate, the checks note)
  // stranded under a title that no longer matches it.
  _setStagingLoader(visible, { title, sub } = {}) {
    const loader = document.getElementById('staging-loader');
    if (!loader) return;
    loader.classList.toggle('hidden', !visible);
    if (title !== undefined) {
      const t = document.getElementById('staging-loader-title');
      if (t) t.textContent = title;
    }
    if (sub !== undefined) {
      const s = document.getElementById('staging-loader-sub');
      if (s) s.textContent = sub;
    }
  },

  // #816: retry schedule for the fallback readiness poll below.
  //
  // This used to be a flat 2500ms sleep with an 8000ms per-attempt abort —
  // granularity sized for the on-demand-TLS era, when a first load really
  // could block for a minute on certificate issuance. That era is gone (one
  // pre-existing wildcard cert covers every preview), and a live preview
  // answers in tens to low hundreds of milliseconds, so a single unlucky
  // first attempt was costing 2.5-10.5s of pure waiting against something
  // that was already serving. Start tight and escalate to the same 2s
  // ceiling, and cut each attempt off at 5s.
  STAGING_POLL_BACKOFF_MS: [300, 600, 1200],
  STAGING_POLL_BACKOFF_MAX_MS: 2000,
  STAGING_POLL_ATTEMPT_TIMEOUT_MS: 5000,
  // Safety net for the iframe's own page load (see _watchStagingIframeLoad).
  STAGING_IFRAME_LOAD_TIMEOUT_MS: 20000,

  _stagingPollBackoffMs(attemptIndex) {
    const table = AppView.STAGING_POLL_BACKOFF_MS;
    return attemptIndex < table.length
      ? table[attemptIndex]
      : AppView.STAGING_POLL_BACKOFF_MAX_MS;
  },

  // Poll the staging host until it answers. Uses a no-cors GET: it resolves
  // for any reply (even opaque/redirect/4xx) and rejects on a network-level
  // failure — exactly the readiness signal we want. Resolves true when the
  // host answers, false only if the user backed out (stale loadId).
  //
  // #816: this is now the FALLBACK only. When the server verified the
  // preview in the ensure-staging response, swapToStaging skips straight to
  // the iframe. The copy makes no claim about WHY a preview isn't answering
  // yet — the old wording blamed a certificate authority that is no longer
  // in the path.
  async _waitForStagingReady(resolved, loadId, opts) {
    const checksRunning = !!(opts && opts.checksRunning);
    AppView._setStagingLoader(true, {
      title: 'Waiting for the preview to respond…',
      sub: checksRunning
        ? 'Automated checks are running against this preview, so the first load may be a little slower.'
        : '',
    });
    const startedAt = Date.now();
    let attempt = 0;
    while (loadId === AppView._stagingLoadId) {
      const controller = new AbortController();
      const to = setTimeout(
        () => controller.abort(), AppView.STAGING_POLL_ATTEMPT_TIMEOUT_MS
      );
      try {
        await fetch(resolved, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
        clearTimeout(to);
        return true; // the host answered
      } catch {
        clearTimeout(to);
        if (loadId !== AppView._stagingLoadId) return false;
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        // Escalate the copy so a longer-than-usual wait doesn't look hung.
        // No cause is asserted — we genuinely don't know one here.
        if (elapsed >= 60) {
          AppView._setStagingLoader(true, {
            title: 'Still waiting on the preview',
            sub: `The preview hasn’t responded yet (${elapsed}s). Hang tight — this keeps retrying automatically.`,
          });
        } else if (elapsed >= 20) {
          AppView._setStagingLoader(true, {
            title: 'Waiting for the preview to respond…',
            sub: `Taking a little longer than usual (${elapsed}s).`,
          });
        }
        await new Promise((r) => setTimeout(r, AppView._stagingPollBackoffMs(attempt)));
        attempt += 1;
      }
    }
    return false; // superseded/closed
  },

  closeStagingOverlay() {
    const overlay = document.getElementById('staging-overlay');
    const iframe = document.getElementById('staging-iframe');
    // #771: leave docked mode first (strips the docked class + pinned
    // geometry, disconnects the slot observer) and collapse the dev-chat
    // placeholder slot. The open check on stagingPanel makes this safe to
    // call from DevChat's own teardown paths without re-render loops.
    const wasDocked = AppView._stagingMode === 'docked';
    AppView._stagingDockable = false;
    if (wasDocked) AppView._setStagingMode('fullscreen');
    if (wasDocked && typeof DevChat !== 'undefined'
        && DevChat.stagingPanel && DevChat.stagingPanel.open) {
      DevChat.stagingPanel.open = false;
      DevChat.renderChatView();
    }
    const fsBtn = document.getElementById('staging-fullscreen-btn');
    if (fsBtn) fsBtn.classList.add('hidden');
    // Invalidate any in-flight readiness poll and hide the loader.
    AppView._stagingLoadId += 1;
    // #439: drop any pending on-demand rebuild marker + its give-up timer so
    // a late staging_ready can't reopen the overlay after the user left.
    AppView._pendingStagingPreview = null;
    if (AppView._stagingRebuildTimer) { clearTimeout(AppView._stagingRebuildTimer); AppView._stagingRebuildTimer = null; }
    // #816: drop the iframe-load watch + its safety timeout so a late load
    // event from the preview being torn down here can't re-touch the loader.
    if (AppView._stagingIframeTimer) { clearTimeout(AppView._stagingIframeTimer); AppView._stagingIframeTimer = null; }
    if (iframe) { iframe.onload = null; iframe.onerror = null; }
    AppView._setStagingLoader(false);
    if (overlay) overlay.classList.add('hidden');
    if (iframe) iframe.src = '';
    // #127: reset the testing affordances so the next preview starts clean.
    AppView._stagingTesting = null;
    const testBtn = document.getElementById('staging-test-btn');
    if (testBtn) testBtn.classList.add('hidden');
    const testPanel = document.getElementById('staging-testing-panel');
    if (testPanel) testPanel.classList.add('hidden');
    // Restore dev-console button visibility based on whatever tab the
    // user lands back on.
    if (window.DevConsole) {
      const showForApp = App.currentTab === 'app'
        && AppView.appData?.status === 'running';
      DevConsole.setButtonVisible(showForApp);
    }
  },

  // Swap back to production
  swapToProduction() {
    if (AppView.appData?.url) {
      AppView.renderAppTab();
    }
  },

  // ── Members & visibility modal ─────────────────────────────────────
  //
  // One modal, two concerns:
  //   - visibility controls (creator/admin only) → PATCH /visibility
  //   - member list + invite typeahead (collab-private apps) →
  //     /collaborators, /invites, /api/users/search
  // State is re-fetched on every open so a stale modal can't show a
  // removed member or an already-accepted invite.

  _membersVis: { collab: 'public', view: 'public' },
  _inviteDebounce: null,

  async openMembersModal() {
    const appData = AppView.appData;
    const modal = document.getElementById('members-modal');
    if (!modal) return;
    // No app loaded: don't fail silently (that's the "button does nothing"
    // symptom). Surface a one-line message and still open the dialog so the
    // tap visibly does something. The row only renders when appData is set,
    // so this is a defensive/diagnostic path, not the normal one.
    if (!appData) {
      console.warn('[members] openMembersModal called with no app loaded');
      const visStatus = document.getElementById('members-vis-error');
      if (visStatus) {
        visStatus.textContent = 'This app is still loading — open Members & visibility again in a moment.';
        visStatus.className = 'text-sm text-red-400';
      }
      AppView.revealModal(modal);
      return;
    }
    // Reveal now (see revealModal); the dismiss guard stops the opening tap
    // from ghost-clicking the backdrop closed. Sections are configured below
    // (the modal is already visible, but they only paint after this frame).
    AppView.revealModal(modal);

    // Self-app: the only sections that apply are the approval ones, so
    // the heading matches the "+" menu item's "Proposal approvals" label.
    const modalTitle = document.getElementById('members-modal-title');
    if (modalTitle) {
      modalTitle.textContent = appData.self_hosted ? 'Proposal approvals' : 'Members & visibility';
    }

    AppView._membersVis = {
      collab: appData.collab_visibility || 'public',
      view: appData.view_visibility || 'public',
    };

    // Visibility section: creator/admin only. Changing visibility opens
    // a dapp.json PR (issue #124), so it needs a repo — without one the
    // pills are disabled with a hint.
    const visSection = document.getElementById('members-visibility-section');
    const visStatus = document.getElementById('members-vis-error');
    if (visStatus) {
      visStatus.textContent = '';
      visStatus.className = 'text-red-400 text-sm hidden';
    }
    if (visSection) {
      // Self-hosted platform app: visibility stays out of repo control
      // (the server 400s visibility-pr for it), so hide the pills — the
      // modal is reachable there for the Proposal-approvals sections.
      visSection.classList.toggle('hidden', !appData.can_manage || !!appData.self_hosted);
      if (appData.can_manage && !appData.self_hosted) {
        AppView._renderMembersVisPills();
        // Set (not just conditionally add) the disabled state: the pills are
        // cloned on every wire, so a `disabled` left over from opening a
        // repo-less app's modal would survive into this app's pills and eat
        // every click.
        visSection.querySelectorAll('[data-m-collab-vis], [data-m-view-vis]')
          .forEach((p) => { p.disabled = !appData.repo_url; });
        if (!appData.repo_url) {
          if (visStatus) {
            visStatus.textContent = 'Visibility changes are proposed as a dapp.json pull request — this app has no GitHub repository, so they\'re unavailable.';
            visStatus.className = 'text-sm text-zinc-500 dark:text-zinc-400';
          }
        }
      }
    }

    // Proposal-approvals section (issue #646): creator/admin only, like
    // the visibility pills; changes open a dapp.json governance PR, so
    // a repo is required.
    AppView._membersGov = {
      policy: appData.approver_policy === 'invited' ? 'invited' : 'anyone',
      atLeast: appData.approvals_required != null ? Number(appData.approvals_required) : null,
    };
    const govSection = document.getElementById('members-governance-section');
    const govStatus = document.getElementById('members-governance-error');
    if (govStatus) { govStatus.textContent = ''; govStatus.className = 'text-red-400 text-sm hidden'; }
    if (govSection) {
      govSection.classList.toggle('hidden', !appData.can_manage);
      if (appData.can_manage) {
        AppView._renderMembersGovPills();
        // Same set-don't-add rationale as the visibility pills above.
        govSection.querySelectorAll('[data-m-approver-policy], [data-m-approvals-mode], #members-approvals-n, #members-approvals-propose')
          .forEach((p) => { p.disabled = !appData.repo_url; });
        if (!appData.repo_url) {
          if (govStatus) {
            govStatus.textContent = 'Approval-settings changes are proposed as a dapp.json pull request — this app has no GitHub repository, so they\'re unavailable.';
            govStatus.className = 'text-sm text-zinc-500 dark:text-zinc-400';
            govStatus.classList.remove('hidden');
          }
        }
      }
    }

    // Approvers roster: managers can always fetch it; everyone else only
    // when the policy is 'invited' (read-only). The section itself stays
    // hidden until the roster fetch decides (_renderApprovers): under the
    // default 'anyone' policy an EMPTY roster keeps it hidden — the "No
    // approvers yet" empty state only misled there, since approvers don't
    // apply until the policy flips — while leftover rows (a dormant
    // roster) still show, with an explanatory note.
    const approversSection = document.getElementById('members-approvers-section');
    const showApprovers = appData.can_manage
      || (appData.approver_policy === 'invited' && appData.can_collaborate);
    if (approversSection) approversSection.classList.add('hidden');
    AppView._approversData = null;
    const approverInviteBox = document.getElementById('members-approver-invite');
    if (approverInviteBox) approverInviteBox.classList.toggle('hidden', !appData.can_manage);
    const apStatus = document.getElementById('members-approver-status');
    if (apStatus) { apStatus.textContent = ''; apStatus.className = 'text-sm mt-2'; }
    const apInput = document.getElementById('members-approver-invite-input');
    if (apInput) apInput.value = '';
    AppView._hideApproverSuggestions();
    // A previous open's abandoned initial-approvers draft must not leak
    // into this one.
    AppView._hideInitialApproversDraft();

    AppView._wireMembersModal();

    // Member list + invite input: collab-private apps only.
    const isPrivate = appData.collab_visibility === 'private';
    const inviteSection = document.getElementById('members-invite-section');
    const listSection = document.getElementById('members-list-section');
    if (inviteSection) inviteSection.classList.toggle('hidden', !isPrivate || !appData.can_collaborate);
    if (listSection) listSection.classList.toggle('hidden', !isPrivate || !appData.can_collaborate);
    const status = document.getElementById('members-invite-status');
    if (status) { status.textContent = ''; status.className = 'text-sm mt-2'; }
    const input = document.getElementById('members-invite-input');
    if (input) input.value = '';
    AppView._hideInviteSuggestions();
    if (isPrivate && appData.can_collaborate) await AppView.loadCollaborators();
    if (showApprovers) await AppView.loadApprovers();
    // #788: collab-level — everyone who can see the modal can see who
    // administers the app; managers get the propose-a-PR editor (see
    // _renderAppAdmins). Reset the previous open's draft/status first so
    // one app's roster can't leak into another's.
    const appAdminsSection = document.getElementById('members-appadmins-section');
    if (appAdminsSection) appAdminsSection.classList.add('hidden');
    AppView._appAdminsData = null;
    AppView._appAdminsDraft = null;
    AppView._appAdminsKnown = null;
    AppView._hideAppAdminSuggestions();
    AppView._setAppAdminsStatus('', false);
    await AppView.loadAppAdmins();
  },

  hideMembersModal() {
    const modal = document.getElementById('members-modal');
    if (modal) modal.classList.add('hidden');
    AppView._hideInviteSuggestions();
  },

  // Idempotent wiring (cloneNode swap clears stale listeners, mirroring
  // Home.wireCreateButtons) for the pills + invite input.
  _wireMembersModal() {
    document.querySelectorAll('#members-visibility-section [data-m-collab-vis], #members-visibility-section [data-m-view-vis]')
      .forEach((pill) => {
        const fresh = pill.cloneNode(true);
        pill.parentNode.replaceChild(fresh, pill);
        fresh.addEventListener('click', () => {
          if (fresh.dataset.mCollabVis) AppView._setMembersVisibility('collab', fresh.dataset.mCollabVis);
          else AppView._setMembersVisibility('view', fresh.dataset.mViewVis);
        });
      });
    const input = document.getElementById('members-invite-input');
    if (input) {
      const fresh = input.cloneNode(true);
      input.parentNode.replaceChild(fresh, input);
      fresh.addEventListener('input', () => {
        clearTimeout(AppView._inviteDebounce);
        AppView._inviteDebounce = setTimeout(() => AppView._searchInviteUsers(fresh.value.trim()), 200);
      });
      fresh.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const name = fresh.value.trim();
          if (name) AppView.sendInvite(name);
        }
        if (e.key === 'Escape') AppView._hideInviteSuggestions();
      });
    }

    // Proposal-approvals pills + at-least count (issue #646).
    document.querySelectorAll('#members-governance-section [data-m-approver-policy]')
      .forEach((pill) => {
        const fresh = pill.cloneNode(true);
        pill.parentNode.replaceChild(fresh, pill);
        fresh.addEventListener('click', () => {
          // Switching TO invited-approvers goes through the inline
          // "Initial approvers" step instead of an immediate confirm —
          // its Propose button is the explicit consent, and it lets the
          // user line up the roster in the same gesture.
          if (fresh.dataset.mApproverPolicy === 'invited'
              && AppView._membersGov.policy !== 'invited') {
            AppView._showInitialApproversDraft();
            return;
          }
          AppView._proposeGovernance({
            policy: fresh.dataset.mApproverPolicy,
            atLeast: AppView._membersGov.atLeast,
          });
        });
      });
    document.querySelectorAll('#members-governance-section [data-m-approvals-mode]')
      .forEach((pill) => {
        const fresh = pill.cloneNode(true);
        pill.parentNode.replaceChild(fresh, pill);
        fresh.addEventListener('click', () => {
          // Switch the segmented control right away — the tap must visibly
          // respond (the old handler left "Time & majority" highlighted, so
          // tapping "At least" read as a dead click). The highlight is a
          // display-only draft: _membersGov (the app's real settings) only
          // changes when the governance proposal merges, and _proposeGovernance
          // repaints from it if the user cancels or the proposal fails.
          AppView._showMembersGovModeDraft(fresh.dataset.mApprovalsMode);
          if (fresh.dataset.mApprovalsMode === 'default') {
            AppView._proposeGovernance({ policy: AppView._membersGov.policy, atLeast: null });
          }
        });
      });
    // At-least count: Enter or the Propose button opens the proposal. No
    // change-listener auto-propose — a number input fires `change` on every
    // spinner click, which popped a confirm dialog mid-adjustment.
    const nInput = document.getElementById('members-approvals-n');
    const proposeFromN = () => {
      const el = document.getElementById('members-approvals-n');
      const n = Math.max(1, Math.min(50, parseInt(el && el.value, 10) || 1));
      AppView._proposeGovernance({ policy: AppView._membersGov.policy, atLeast: n });
    };
    if (nInput) {
      const freshN = nInput.cloneNode(true);
      nInput.parentNode.replaceChild(freshN, nInput);
      freshN.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); proposeFromN(); }
      });
    }
    const proposeBtn = document.getElementById('members-approvals-propose');
    if (proposeBtn) {
      const freshP = proposeBtn.cloneNode(true);
      proposeBtn.parentNode.replaceChild(freshP, proposeBtn);
      freshP.addEventListener('click', proposeFromN);
    }

    // Approver invite typeahead.
    const apInput = document.getElementById('members-approver-invite-input');
    if (apInput) {
      const freshAp = apInput.cloneNode(true);
      apInput.parentNode.replaceChild(freshAp, apInput);
      freshAp.addEventListener('input', () => {
        clearTimeout(AppView._approverInviteDebounce);
        AppView._approverInviteDebounce = setTimeout(
          () => AppView._searchApproverUsers(freshAp.value.trim()), 200
        );
      });
      freshAp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const name = freshAp.value.trim();
          if (name) AppView.sendApproverInvite(name);
        }
        if (e.key === 'Escape') AppView._hideApproverSuggestions();
      });
    }

    // Initial-approvers draft step (switching to invited-approvers).
    const iaInput = document.getElementById('members-initial-approver-input');
    if (iaInput) {
      const freshIa = iaInput.cloneNode(true);
      iaInput.parentNode.replaceChild(freshIa, iaInput);
      freshIa.addEventListener('input', () => {
        clearTimeout(AppView._initialApproverDebounce);
        AppView._initialApproverDebounce = setTimeout(
          () => AppView._searchInitialApprovers(freshIa.value.trim()), 200
        );
      });
      freshIa.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const name = freshIa.value.trim();
          if (name) AppView._addDraftApprover(name);
        }
        if (e.key === 'Escape') AppView._hideInitialApproverSuggestions();
      });
    }
    const iaPropose = document.getElementById('members-initial-approvers-propose');
    if (iaPropose) {
      const freshIaP = iaPropose.cloneNode(true);
      iaPropose.parentNode.replaceChild(freshIaP, iaPropose);
      freshIaP.addEventListener('click', () => {
        AppView._proposeGovernance({
          policy: 'invited',
          atLeast: AppView._membersGov.atLeast,
          initialApprovers: [...AppView._govDraftApprovers],
          skipConfirm: true,
        });
      });
    }
    const iaCancel = document.getElementById('members-initial-approvers-cancel');
    if (iaCancel) {
      const freshIaC = iaCancel.cloneNode(true);
      iaCancel.parentNode.replaceChild(freshIaC, iaCancel);
      // Abandon the draft: repaint from the app's real settings (which
      // also collapses the block — see _renderMembersGovPills).
      freshIaC.addEventListener('click', () => AppView._renderMembersGovPills());
    }

    // App-admins editor (issue #788): typeahead + propose/cancel.
    const aaInput = document.getElementById('members-appadmins-input');
    if (aaInput) {
      const freshAa = aaInput.cloneNode(true);
      aaInput.parentNode.replaceChild(freshAa, aaInput);
      freshAa.addEventListener('input', () => {
        clearTimeout(AppView._appAdminsDebounce);
        AppView._appAdminsDebounce = setTimeout(
          () => AppView._searchAppAdminUsers(freshAa.value.trim()), 200
        );
      });
      freshAa.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const name = freshAa.value.trim();
          if (name) AppView._addAppAdmin(name);
        }
        if (e.key === 'Escape') AppView._hideAppAdminSuggestions();
      });
    }
    const aaPropose = document.getElementById('members-appadmins-propose');
    if (aaPropose) {
      const freshAaP = aaPropose.cloneNode(true);
      aaPropose.parentNode.replaceChild(freshAaP, aaPropose);
      freshAaP.addEventListener('click', () => AppView._proposeAppAdmins());
    }
    const aaCancel = document.getElementById('members-appadmins-cancel');
    if (aaCancel) {
      const freshAaC = aaCancel.cloneNode(true);
      aaCancel.parentNode.replaceChild(freshAaC, aaCancel);
      // Abandon the draft: repaint from the app's real declared list.
      freshAaC.addEventListener('click', () => {
        const declared = AppView._appAdminsData && Array.isArray(AppView._appAdminsData.declared)
          ? AppView._appAdminsData.declared : [];
        AppView._appAdminsDraft = [...declared];
        AppView._hideAppAdminSuggestions();
        AppView._renderAppAdmins(AppView._appAdminsData);
      });
    }
  },

  _renderMembersVisPills() {
    const { collab, view } = AppView._membersVis;
    const collabPublic = collab === 'public';
    document.querySelectorAll('#members-visibility-section [data-m-collab-vis]').forEach((p) => {
      p.classList.toggle('active', p.dataset.mCollabVis === collab);
    });
    document.querySelectorAll('#members-visibility-section [data-m-view-vis]').forEach((p) => {
      p.classList.toggle('active', p.dataset.mViewVis === view);
      p.disabled = collabPublic;
    });
    const hint = document.getElementById('members-vis-hint');
    if (hint) hint.classList.toggle('hidden', !collabPublic);
  },

  // Pill click → confirm → open a visibility-change proposal (a PR that
  // edits dapp.json's `visibility` block — issue #124). NOT optimistic:
  // the pills keep showing the current values until the proposal passes
  // its vote, merges, and the redeploy's reconcile fires the
  // `visibility_changed` WS event (handled in app.js, which re-renders
  // the pills if this modal is open).
  async _setMembersVisibility(kind, value) {
    const cur = {
      collab: AppView.appData.collab_visibility || 'public',
      view: AppView.appData.view_visibility || 'public',
    };
    const v = value === 'private' ? 'private' : 'public';
    const target = { ...cur };
    if (kind === 'collab') {
      target.collab = v;
      if (v === 'public') target.view = 'public';
    } else {
      target.view = (cur.collab === 'private') ? v : 'public';
    }
    if (target.collab === cur.collab && target.view === cur.view) return;

    const statusEl = document.getElementById('members-vis-error');
    const setStatus = (msg, isError) => {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.className = `text-sm ${isError ? 'text-red-400' : 'text-zinc-500 dark:text-zinc-400'}`;
      statusEl.classList.toggle('hidden', !msg);
    };
    setStatus('', false);

    if (!await PlatformUI.confirm({
      title: 'Open a visibility proposal?',
      message: 'Changing visibility opens a proposal that needs the group\'s vote. The change applies after the vote passes and the app redeploys.',
      confirmLabel: 'Open proposal',
    })) return;

    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/visibility-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collabVisibility: target.collab,
          viewVisibility: target.view,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setStatus('A visibility change is already up for vote — see the proposal in the Dev tab\'s vote panel.', false);
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus(
        `Proposal opened (PR #${data.prNumber}) — it needs the group's vote in the Dev tab's vote panel before the new visibility applies.`,
        false
      );
    } catch (err) {
      setStatus(`Could not open the visibility proposal: ${err.message}`, true);
    }
  },

  async loadCollaborators() {
    const list = document.getElementById('members-list');
    if (!list || !AppView.appData) return;
    list.innerHTML = '<div class="px-3 py-2 text-sm text-zinc-500">Loading…</div>';
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/collaborators`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      AppView._renderCollaborators(data.collaborators || []);
    } catch (err) {
      list.innerHTML = `<div class="px-3 py-2 text-sm text-red-400">Failed to load members: ${escapeHtml(err.message)}</div>`;
    }
  },

  _renderCollaborators(rows) {
    const list = document.getElementById('members-list');
    if (!list) return;
    const me = (typeof App !== 'undefined' && App.user) ? App.user : {};
    const canManage = !!AppView.appData?.can_manage;
    if (!rows.length) {
      list.innerHTML = '<div class="px-3 py-2 text-sm text-zinc-500">No collaborators yet.</div>';
      return;
    }
    list.innerHTML = rows.map((r) => {
      const pending = r.status === 'invited';
      const tag = r.isCreator
        ? '<span class="text-[0.65rem] text-violet-500 font-medium ml-1">creator</span>'
        : (pending ? '<span class="text-[0.65rem] text-amber-500 font-medium ml-1">invited</span>' : '');
      // Remove/revoke: creator/admin for anyone but the creator; users
      // may remove themselves (leave). Mirrors the server rules.
      const canRemove = !r.isCreator && (canManage || r.userId === me.id);
      const removeBtn = canRemove
        ? `<button data-remove-user="${r.userId}" class="text-xs text-zinc-400 hover:text-red-500 px-2 py-1" title="${pending ? 'Revoke invite' : (r.userId === me.id ? 'Leave app' : 'Remove')}">${pending ? 'Revoke' : (r.userId === me.id ? 'Leave' : 'Remove')}</button>`
        : '';
      return `<div class="flex items-center justify-between px-3 py-2 ${pending ? 'opacity-70' : ''}">
        <span class="text-sm text-zinc-700 dark:text-zinc-300 truncate">@${escapeHtml(r.username)}${tag}</span>
        ${removeBtn}
      </div>`;
    }).join('');
    list.querySelectorAll('[data-remove-user]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await fetch(
            `/api/apps/${AppView.appData.slug}/collaborators/${btn.dataset.removeUser}`,
            { method: 'DELETE' }
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          // Leaving an app yourself: you may have just lost access —
          // bounce home rather than leave a dead view up.
          if (Number(btn.dataset.removeUser) === me.id && !me.isAdmin) {
            AppView.hideMembersModal();
            App.navigateHome();
            return;
          }
          AppView.loadCollaborators();
        } catch (err) {
          PlatformUI.toast(`Remove failed: ${err.message}`);
          btn.disabled = false;
        }
      });
    });
  },

  async _searchInviteUsers(q) {
    const box = document.getElementById('members-invite-suggestions');
    if (!box || !AppView.appData) return;
    if (!q) { AppView._hideInviteSuggestions(); return; }
    try {
      const params = new URLSearchParams({ q, excludeApp: AppView.appData.slug });
      const res = await fetch(`/api/users/search?${params.toString()}`);
      if (!res.ok) return;
      const { users } = await res.json();
      if (!users || !users.length) { AppView._hideInviteSuggestions(); return; }
      box.innerHTML = users.map((u) =>
        `<button data-invite-user="${escapeAttr(u.username)}" class="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">@${escapeHtml(u.username)}</button>`
      ).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('[data-invite-user]').forEach((btn) => {
        btn.addEventListener('click', () => AppView.sendInvite(btn.dataset.inviteUser));
      });
    } catch { /* typeahead is best-effort */ }
  },

  _hideInviteSuggestions() {
    const box = document.getElementById('members-invite-suggestions');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  },

  async sendInvite(username) {
    const status = document.getElementById('members-invite-status');
    const input = document.getElementById('members-invite-input');
    AppView._hideInviteSuggestions();
    if (status) { status.textContent = 'Inviting…'; status.className = 'text-sm mt-2'; }
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (status) {
        status.textContent = `✓ Invited @${data.username || username}`;
        status.className = 'text-sm mt-2 import-status--ok';
      }
      if (input) input.value = '';
      AppView.loadCollaborators();
    } catch (err) {
      if (status) {
        status.textContent = err.message;
        status.className = 'text-sm mt-2 import-status--err';
      }
    }
  },

  // ── Proposal-approval governance (issue #646) ───────────────────────

  _membersGov: { policy: 'anyone', atLeast: null },
  _approverInviteDebounce: null,

  _renderMembersGovPills() {
    const { policy, atLeast } = AppView._membersGov;
    document.querySelectorAll('#members-governance-section [data-m-approver-policy]').forEach((p) => {
      p.classList.toggle('active', p.dataset.mApproverPolicy === policy);
    });
    const mode = atLeast != null ? 'at_least' : 'default';
    document.querySelectorAll('#members-governance-section [data-m-approvals-mode]').forEach((p) => {
      p.classList.toggle('active', p.dataset.mApprovalsMode === mode);
    });
    const n = document.getElementById('members-approvals-n');
    if (n) {
      n.classList.toggle('hidden', atLeast == null);
      if (atLeast != null) n.value = String(atLeast);
    }
    const proposeBtn = document.getElementById('members-approvals-propose');
    if (proposeBtn) proposeBtn.classList.toggle('hidden', atLeast == null);
    // Repainting from the real settings always collapses the
    // initial-approvers draft (cancel, failure, fresh open).
    AppView._hideInitialApproversDraft();
  },

  // Paint a locally-selected approvals mode without touching _membersGov:
  // the tapped pill highlights and the at-least count input + Propose
  // button reveal (or hide, back on "Time & majority"). Display-only —
  // the app's real settings still come from the merged governance PR;
  // every openMembersModal()/_renderMembersGovPills() repaints from
  // _membersGov, so an abandoned draft resets on the next open.
  _showMembersGovModeDraft(mode) {
    document.querySelectorAll('#members-governance-section [data-m-approvals-mode]').forEach((p) => {
      p.classList.toggle('active', p.dataset.mApprovalsMode === mode);
    });
    const showN = mode === 'at_least';
    const n = document.getElementById('members-approvals-n');
    if (n) {
      n.classList.toggle('hidden', !showN);
      if (showN) {
        n.value = String(AppView._membersGov.atLeast || 1);
        n.focus();
      }
    }
    const proposeBtn = document.getElementById('members-approvals-propose');
    if (proposeBtn) proposeBtn.classList.toggle('hidden', !showN);
    const govStatus = document.getElementById('members-governance-error');
    if (govStatus && showN) {
      govStatus.textContent = 'Set the number of approvals, then tap Propose.';
      govStatus.className = 'text-sm text-zinc-500 dark:text-zinc-400';
    }
  },

  // ── Initial-approvers draft (switching to invited-approvers) ────────
  //
  // Tapping the "Invited approvers" pill on an 'anyone' app reveals this
  // inline step instead of an immediate confirm. It names who will be
  // able to approve once the change lands — the creator is auto-seeded
  // as the first approver by the merge-time reconcile when the roster is
  // empty (services/app-manifest.js applyGovernanceChange); the self-app
  // has no creator and falls back to full admins — and lets the user
  // pick extra approvers to invite in the same gesture. Display-only
  // like _showMembersGovModeDraft: _membersGov is untouched until the
  // proposal merges, and _renderMembersGovPills() collapses the draft.
  _govDraftApprovers: [],
  _initialApproverDebounce: null,

  _showInitialApproversDraft() {
    document.querySelectorAll('#members-governance-section [data-m-approver-policy]').forEach((p) => {
      p.classList.toggle('active', p.dataset.mApproverPolicy === 'invited');
    });
    AppView._govDraftApprovers = [];
    const block = document.getElementById('members-initial-approvers');
    if (block) block.classList.remove('hidden');
    const statusLine = document.getElementById('members-initial-approvers-status');
    if (statusLine) {
      const appData = AppView.appData || {};
      const me = (typeof App !== 'undefined' && App.user) ? App.user : {};
      const roster = ((AppView._approversData && AppView._approversData.approvers) || [])
        .filter((r) => r.status === 'member');
      if (roster.length) {
        statusLine.textContent = `Current approvers stay in place: ${roster.map((r) => `@${r.username}`).join(', ')}. Add more people to invite below (optional).`;
      } else if (appData.self_hosted) {
        statusLine.textContent = 'Platform admins can approve proposals until invited approvers are added — pick some below.';
      } else if (AppView._approversData && AppView._approversData.creatorId != null
                 && AppView._approversData.creatorId !== me.id) {
        statusLine.textContent = 'The app\'s creator will automatically become the first approver. Add more people to invite below (optional).';
      } else {
        statusLine.textContent = 'You\'ll automatically become this app\'s first approver. Add more people to invite below (optional).';
      }
    }
    const input = document.getElementById('members-initial-approver-input');
    if (input) { input.value = ''; input.focus(); }
    AppView._renderDraftApprovers();
    AppView._hideInitialApproverSuggestions();
    const govStatus = document.getElementById('members-governance-error');
    if (govStatus) {
      govStatus.textContent = 'Review the initial approvers, then tap Propose.';
      govStatus.className = 'text-sm text-zinc-500 dark:text-zinc-400';
    }
  },

  _hideInitialApproversDraft() {
    const block = document.getElementById('members-initial-approvers');
    if (block) block.classList.add('hidden');
    AppView._govDraftApprovers = [];
    AppView._hideInitialApproverSuggestions();
  },

  _renderDraftApprovers() {
    const list = document.getElementById('members-initial-approvers-list');
    if (!list) return;
    list.innerHTML = AppView._govDraftApprovers.map((u) =>
      `<div class="flex items-center justify-between px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800">
        <span class="text-sm text-zinc-700 dark:text-zinc-300 truncate">@${escapeHtml(u)}<span class="text-[0.65rem] text-amber-500 font-medium ml-1">will be invited</span></span>
        <button type="button" data-remove-draft-approver="${escapeAttr(u)}" class="text-xs text-zinc-400 hover:text-red-500 px-2 py-1">Remove</button>
      </div>`
    ).join('');
    list.querySelectorAll('[data-remove-draft-approver]').forEach((btn) => {
      btn.addEventListener('click', () => {
        AppView._govDraftApprovers = AppView._govDraftApprovers
          .filter((u) => u !== btn.dataset.removeDraftApprover);
        AppView._renderDraftApprovers();
      });
    });
  },

  _addDraftApprover(username) {
    const name = String(username || '').replace(/^@/, '').trim();
    if (!name) return;
    const lower = name.toLowerCase();
    if (!AppView._govDraftApprovers.some((u) => u.toLowerCase() === lower)) {
      AppView._govDraftApprovers.push(name);
    }
    const input = document.getElementById('members-initial-approver-input');
    if (input) input.value = '';
    AppView._hideInitialApproverSuggestions();
    AppView._renderDraftApprovers();
  },

  async _searchInitialApprovers(q) {
    const box = document.getElementById('members-initial-approver-suggestions');
    if (!box || !AppView.appData) return;
    if (!q) { AppView._hideInitialApproverSuggestions(); return; }
    try {
      const params = new URLSearchParams({ q });
      const res = await fetch(`/api/users/search?${params.toString()}`);
      if (!res.ok) return;
      const { users } = await res.json();
      if (!users || !users.length) { AppView._hideInitialApproverSuggestions(); return; }
      box.innerHTML = users.map((u) =>
        `<button type="button" data-draft-approver-user="${escapeAttr(u.username)}" class="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">@${escapeHtml(u.username)}</button>`
      ).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('[data-draft-approver-user]').forEach((btn) => {
        btn.addEventListener('click', () => AppView._addDraftApprover(btn.dataset.draftApproverUser));
      });
    } catch { /* typeahead is best-effort */ }
  },

  _hideInitialApproverSuggestions() {
    const box = document.getElementById('members-initial-approver-suggestions');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  },

  // Pill click → confirm → open a governance-change proposal (a PR that
  // edits dapp.json's `governance` block). NOT optimistic, like the
  // visibility pills: the controls keep showing the current settings
  // until the proposal passes, merges, and the redeploy's reconcile
  // fires the `governance_changed` WS event (handled in app.js).
  async _proposeGovernance({ policy, atLeast, initialApprovers, skipConfirm }) {
    const cur = AppView._membersGov;
    const targetPolicy = policy === 'invited' ? 'invited' : 'anyone';
    const targetN = atLeast != null ? Math.max(1, Math.min(50, Number(atLeast) || 1)) : null;
    if (targetPolicy === cur.policy && (targetN ?? null) === (cur.atLeast ?? null)) return;

    const statusEl = document.getElementById('members-governance-error');
    const setStatus = (msg, isError) => {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.className = `text-sm ${isError ? 'text-red-400' : 'text-zinc-500 dark:text-zinc-400'}`;
      statusEl.classList.toggle('hidden', !msg);
    };
    setStatus('', false);

    // The initial-approvers step's Propose button IS the explicit
    // consent (skipConfirm) — every other path keeps the dialog.
    if (!skipConfirm && !await PlatformUI.confirm({
      title: 'Open an approval-settings proposal?',
      message: 'Changing the approval settings opens a proposal that is voted on under the current rules. The change applies after the vote passes and the app redeploys.',
      confirmLabel: 'Open proposal',
    })) {
      // The pill click already painted the tapped mode (see
      // _showMembersGovModeDraft) — snap back to the app's real settings.
      AppView._renderMembersGovPills();
      return;
    }

    const picked = Array.isArray(initialApprovers) ? initialApprovers.filter(Boolean) : [];
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/governance-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approverPolicy: targetPolicy,
          approvalsRequired: targetN,
          ...(picked.length ? { initialApprovers: picked } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        AppView._renderMembersGovPills();
        setStatus('A governance change is already up for vote — see the proposal in the Dev tab\'s vote panel.', false);
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      AppView._hideInitialApproversDraft();
      let msg = `Proposal opened (PR #${data.prNumber}) — it needs the group's vote in the Dev tab's vote panel before the new settings apply.`;
      if (Array.isArray(data.inviteWarnings) && data.inviteWarnings.length) {
        msg += ` Some approver invites could not be sent: ${data.inviteWarnings.join('; ')}.`;
      }
      setStatus(msg, false);
      // Freshly-sent approver invites should appear in the roster right
      // away (the section reveals now that rows exist).
      if (picked.length) AppView.loadApprovers();
    } catch (err) {
      // No proposal opened — the draft highlight would misreport the
      // app's settings, so repaint from the real ones.
      AppView._renderMembersGovPills();
      setStatus(`Could not open the governance proposal: ${err.message}`, true);
    }
  },

  // Last-fetched /approvers payload (approvers + creatorId +
  // approverPolicy) — feeds the initial-approvers draft's status line
  // and the section-visibility rule in _renderApprovers. Reset on every
  // modal open so one app's roster can't leak into another's.
  _approversData: null,

  // #788: per-app admins. The roster's only writer is the deploy-time
  // reconcile of dapp.json's `admins` block, so the editor here never
  // mutates the roster directly: managers stage a draft (add / remove
  // rows locally) and Propose opens a PR editing that block
  // (POST .../admins-pr) — an explicit-approval proposal that won't
  // merge on a timer. Non-managers keep the read-only roster, hidden
  // when the app declares no admins (the normal state for almost every
  // app, not something to nag about).

  // Last-fetched /admins payload (admins + declared + unresolved +
  // canManage + openProposal). Reset on every modal open.
  _appAdminsData: null,
  // Working list of declared usernames being edited (display casing).
  // null = not initialized; re-seeded from `declared` on each load.
  _appAdminsDraft: null,
  // Lowercased usernames the typeahead has confirmed exist — added
  // names outside this set (and outside the resolved roster) get the
  // "no account with this username yet" note.
  _appAdminsKnown: null,

  async loadAppAdmins() {
    const section = document.getElementById('members-appadmins-section');
    const list = document.getElementById('members-appadmins-list');
    if (!section || !list || !AppView.appData) return;
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/admins${AppView._demoQuery()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      AppView._appAdminsDraft = [...(Array.isArray(data.declared) ? data.declared : [])];
      AppView._renderAppAdmins(data);
    } catch (err) {
      section.classList.remove('hidden');
      list.innerHTML = `<div class="px-3 py-2 text-sm text-red-400">Failed to load app admins: ${escapeHtml(err.message)}</div>`;
    }
  },

  // Staging demo passthrough: the members modal has no URL of its own,
  // so forward the page's ?demo=1 to the admins fetch. In production the
  // server ignores it entirely.
  _demoQuery() {
    try {
      return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
    } catch { return ''; }
  },

  _setAppAdminsStatus(msg, isError) {
    const el = document.getElementById('members-appadmins-status');
    if (!el) return;
    el.textContent = msg;
    el.className = `text-sm mt-2 ${isError ? 'text-red-400' : 'text-zinc-500 dark:text-zinc-400'}`;
    el.classList.toggle('hidden', !msg);
  },

  // Canonical form for the dirty check, mirroring the server's
  // normalizeAdmins (services/app-admins.js): trimmed, lowercased,
  // deduped, sorted — so re-ordering or re-casing the same names never
  // reads as a change.
  _normAppAdmins(list) {
    const seen = new Set();
    for (const entry of Array.isArray(list) ? list : []) {
      if (typeof entry !== 'string') continue;
      const name = entry.trim().toLowerCase();
      if (name) seen.add(name);
    }
    return [...seen].sort();
  },

  _appAdminsDirty() {
    const d = AppView._appAdminsData || {};
    const a = AppView._normAppAdmins(d.declared);
    const b = AppView._normAppAdmins(AppView._appAdminsDraft);
    return a.length !== b.length || a.some((v, i) => v !== b[i]);
  },

  _renderAppAdmins(data) {
    const section = document.getElementById('members-appadmins-section');
    const list = document.getElementById('members-appadmins-list');
    if (!section || !list) return;
    if (data) AppView._appAdminsData = data;
    const d = AppView._appAdminsData || {};
    const admins = Array.isArray(d.admins) ? d.admins : [];
    const unresolved = Array.isArray(d.unresolved) ? d.unresolved : [];
    const declared = Array.isArray(d.declared) ? d.declared : [];
    const appData = AppView.appData || {};
    // Managers get the editor — except on the self-app, where per-app
    // admins are deliberately not grantable (the deploy reconcile skips
    // self_hosted apps), so it keeps the read-only view.
    const editable = !!d.canManage && !appData.self_hosted;
    // With a proposal already up for vote the rows go read-only too —
    // one admins proposal in flight per app.
    const canEdit = editable && !d.openProposal;
    if (!Array.isArray(AppView._appAdminsDraft)) AppView._appAdminsDraft = [...declared];
    const draft = AppView._appAdminsDraft;

    // Section visibility: managers (outside the self-app) always see it
    // — an empty roster is the entry point for adding the first admin —
    // everyone else keeps the hide-when-empty rule.
    if (!editable && !admins.length && !unresolved.length) {
      section.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    section.classList.remove('hidden');

    const resolvedLower = new Set(admins.map((a) => a.username.toLowerCase()));
    const draftLower = new Set(draft.map((u) => u.toLowerCase()));
    const declaredLower = new Set(declared.map((u) => u.toLowerCase()));
    const rowCls = 'flex items-center justify-between gap-2 px-3 py-2 text-sm';
    const removeBtn = (u) => (canEdit
      ? `<button type="button" data-remove-appadmin="${escapeAttr(u)}" class="text-xs text-zinc-400 hover:text-red-500 px-2 py-1 shrink-0">Remove</button>`
      : '');
    const undoBtn = (u) =>
      `<button type="button" data-restore-appadmin="${escapeAttr(u)}" class="text-xs text-zinc-400 hover:text-violet-500 px-2 py-1 shrink-0">Undo</button>`;

    const rows = [];
    for (const name of declared) {
      const lower = name.toLowerCase();
      // A declared name matching no account is shown rather than
      // silently dropped — it's almost always a typo or someone who
      // hasn't signed up yet, and it starts working on the next deploy
      // once they do.
      const tag = resolvedLower.has(lower)
        ? '<span class="text-[0.65rem] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">Admin</span>'
        : '<span class="text-[0.65rem] text-zinc-500 dark:text-zinc-400" title="Declared in dapp.json but no account with this username exists yet">not a registered user</span>';
      if (draftLower.has(lower)) {
        rows.push(
          `<div class="${rowCls}${resolvedLower.has(lower) ? '' : ' opacity-60'}"><span class="truncate">@${escapeHtml(name)}</span>`
          + `<span class="flex items-center gap-1 shrink-0">${tag}${removeBtn(name)}</span></div>`
        );
      } else {
        // Staged removal: struck through, nothing has happened yet.
        rows.push(
          `<div class="${rowCls} opacity-60"><span class="truncate line-through">@${escapeHtml(name)}</span>`
          + '<span class="flex items-center gap-1 shrink-0"><span class="text-[0.65rem] text-red-500 font-medium">will be removed</span>'
          + `${canEdit ? undoBtn(name) : ''}</span></div>`
        );
      }
    }
    for (const name of draft) {
      const lower = name.toLowerCase();
      if (declaredLower.has(lower)) continue;
      // Staged addition. Unregistered names are allowed by design — the
      // roster starts granting once that person signs up and the app
      // next deploys — but flag them so a typo is visible before the
      // proposal opens.
      const known = resolvedLower.has(lower)
        || (AppView._appAdminsKnown && AppView._appAdminsKnown.has(lower));
      const note = known ? ''
        : '<span class="text-[0.65rem] text-zinc-500 dark:text-zinc-400" title="No account with this username yet — they\'ll become an admin once they sign up and the app next deploys">no account yet</span>';
      rows.push(
        `<div class="${rowCls}"><span class="truncate">@${escapeHtml(name)}</span>`
        + `<span class="flex items-center gap-1 shrink-0"><span class="text-[0.65rem] text-amber-500 font-medium">will be added</span>${note}${removeBtn(name)}</span></div>`
      );
    }
    if (!rows.length) {
      rows.push('<div class="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">No app admins yet. App admins can manage this app\'s settings and force-merge its proposals.</div>');
    }
    list.innerHTML = rows.join('');
    list.querySelectorAll('[data-remove-appadmin]').forEach((btn) => {
      btn.addEventListener('click', () => AppView._removeAppAdmin(btn.dataset.removeAppadmin));
    });
    list.querySelectorAll('[data-restore-appadmin]').forEach((btn) => {
      btn.addEventListener('click', () => AppView._addAppAdmin(btn.dataset.restoreAppadmin));
    });

    // Editor controls. Set (not conditionally add) the disabled state:
    // the input/buttons are cloned on every wire, so a `disabled` left
    // over from a repo-less app's modal would survive into this one.
    const editEl = document.getElementById('members-appadmins-edit');
    if (editEl) editEl.classList.toggle('hidden', !canEdit);
    const noRepo = !appData.repo_url;
    const input = document.getElementById('members-appadmins-input');
    if (input) input.disabled = noRepo;
    const proposeBtn = document.getElementById('members-appadmins-propose');
    if (proposeBtn) proposeBtn.disabled = noRepo;
    const actions = document.getElementById('members-appadmins-actions');
    if (actions) actions.classList.toggle('hidden', !canEdit || !AppView._appAdminsDirty());

    // Managers get the shorter action-oriented explainer; read-only
    // viewers (incl. the self-app) keep the original static note.
    const note = document.getElementById('members-appadmins-note');
    if (note) {
      note.innerHTML = editable
        ? 'Changes are proposed as a pull request editing <code>dapp.json</code>&rsquo;s <code>admins</code> list &mdash; it needs real Yes votes and won&rsquo;t merge on a timer.'
        : 'Set in <code>dapp.json</code>. To change them, open a pull request that edits the <code>admins</code> list &mdash; that proposal needs real Yes votes and won&rsquo;t merge on a timer.';
    }

    // Default status: the open-proposal pointer or the no-repo hint.
    // Callers wanting a custom message (Propose result) overwrite after
    // rendering.
    if (editable && d.openProposal) {
      AppView._setAppAdminsStatus('An app-admins change is already up for vote — see the proposal in the Dev tab.', false);
    } else if (editable && noRepo) {
      AppView._setAppAdminsStatus('Admin changes are proposed as a dapp.json pull request — this app has no GitHub repository, so they\'re unavailable.', false);
    } else {
      AppView._setAppAdminsStatus('', false);
    }
  },

  _addAppAdmin(username, { known = false } = {}) {
    const name = String(username || '').replace(/^@/, '').trim();
    if (!name) return;
    if (!Array.isArray(AppView._appAdminsDraft)) AppView._appAdminsDraft = [];
    const draft = AppView._appAdminsDraft;
    const lower = name.toLowerCase();
    if (!draft.some((u) => u.toLowerCase() === lower)) {
      // Mirrors the server-side MAX_APP_ADMINS cap (app-manifest.js).
      if (draft.length >= 20) {
        AppView._renderAppAdmins();
        AppView._setAppAdminsStatus('An app can declare at most 20 admins.', true);
        return;
      }
      draft.push(name);
    }
    if (known) {
      if (!AppView._appAdminsKnown) AppView._appAdminsKnown = new Set();
      AppView._appAdminsKnown.add(lower);
    }
    const input = document.getElementById('members-appadmins-input');
    if (input) input.value = '';
    AppView._hideAppAdminSuggestions();
    AppView._renderAppAdmins();
  },

  _removeAppAdmin(username) {
    const lower = String(username || '').toLowerCase();
    AppView._appAdminsDraft = (AppView._appAdminsDraft || [])
      .filter((u) => u.toLowerCase() !== lower);
    AppView._renderAppAdmins();
  },

  async _searchAppAdminUsers(q) {
    const box = document.getElementById('members-appadmins-suggestions');
    if (!box || !AppView.appData) return;
    if (!q) { AppView._hideAppAdminSuggestions(); return; }
    try {
      const params = new URLSearchParams({ q });
      const res = await fetch(`/api/users/search?${params.toString()}`);
      if (!res.ok) return;
      const { users } = await res.json();
      if (!users || !users.length) { AppView._hideAppAdminSuggestions(); return; }
      box.innerHTML = users.map((u) =>
        `<button type="button" data-appadmin-user="${escapeAttr(u.username)}" class="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">@${escapeHtml(u.username)}</button>`
      ).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('[data-appadmin-user]').forEach((btn) => {
        btn.addEventListener('click', () => AppView._addAppAdmin(btn.dataset.appadminUser, { known: true }));
      });
    } catch { /* typeahead is best-effort */ }
  },

  _hideAppAdminSuggestions() {
    const box = document.getElementById('members-appadmins-suggestions');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  },

  // Draft → confirm → open an admins-change proposal (a PR editing
  // dapp.json's `admins` array). NOT optimistic: the roster only
  // changes when the merged PR's redeploy runs reconcileAppAdmins, so
  // on success the list repaints from the CURRENT declared names with
  // the open-proposal pointer.
  async _proposeAppAdmins() {
    if (!AppView.appData) return;
    const d = AppView._appAdminsData || {};
    const declared = Array.isArray(d.declared) ? d.declared : [];
    const draft = Array.isArray(AppView._appAdminsDraft) ? [...AppView._appAdminsDraft] : [];
    if (!AppView._appAdminsDirty()) return;

    const emptying = !draft.length && declared.length > 0;
    const message = emptying
      ? 'This removes every app admin — only the creator and platform admins will be able to manage the app. The change opens a proposal that needs real Yes votes and won\'t merge on a timer.'
      : 'Changing who administers this app opens a proposal. Because it grants app-level power, it will not merge on a timer — it needs real Yes votes to reach the app\'s normal threshold, and only a platform admin can force-merge it.';
    if (!await PlatformUI.confirm({
      title: 'Open an app-admins proposal?',
      message,
      confirmLabel: 'Open proposal',
    })) return;

    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/admins-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admins: draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        if (AppView._appAdminsData) {
          AppView._appAdminsData.openProposal = {
            sessionId: data.sessionId, prNumber: data.prNumber, prUrl: data.prUrl,
          };
        }
        AppView._appAdminsDraft = [...declared];
        AppView._renderAppAdmins();
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (AppView._appAdminsData) {
        AppView._appAdminsData.openProposal = {
          sessionId: data.sessionId, prNumber: data.prNumber, prUrl: data.prUrl,
        };
      }
      AppView._appAdminsDraft = [...declared];
      AppView._renderAppAdmins();
      AppView._setAppAdminsStatus(`Proposal opened (PR #${data.prNumber}) — it needs the group's vote in the Dev tab before the new admins apply.`, false);
    } catch (err) {
      // No proposal opened — keep the draft so nothing typed is lost.
      AppView._setAppAdminsStatus(`Could not open the admins proposal: ${err.message}`, true);
    }
  },

  async loadApprovers() {
    const list = document.getElementById('members-approvers-list');
    if (!list || !AppView.appData) return;
    list.innerHTML = '<div class="px-3 py-2 text-sm text-zinc-500">Loading…</div>';
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/approvers`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      AppView._approversData = data;
      AppView._renderApprovers(data.approvers || []);
    } catch (err) {
      // Reveal the section so the failure isn't silently hidden.
      const section = document.getElementById('members-approvers-section');
      if (section) section.classList.remove('hidden');
      list.innerHTML = `<div class="px-3 py-2 text-sm text-red-400">Failed to load approvers: ${escapeHtml(err.message)}</div>`;
    }
  },

  _renderApprovers(rows) {
    const list = document.getElementById('members-approvers-list');
    if (!list) return;
    const me = (typeof App !== 'undefined' && App.user) ? App.user : {};
    // Final section visibility (see openMembersModal): under the default
    // 'anyone' policy the section only appears when leftover rows exist —
    // an empty roster there is the normal state, not a problem to fix —
    // and those dormant rows get an explanatory note.
    const policy = (AppView._approversData && AppView._approversData.approverPolicy)
      || (AppView.appData && AppView.appData.approver_policy) || 'anyone';
    const invited = policy === 'invited';
    const section = document.getElementById('members-approvers-section');
    if (section) section.classList.toggle('hidden', !invited && !rows.length);
    const dormantNote = document.getElementById('members-approvers-dormant-note');
    if (dormantNote) dormantNote.classList.toggle('hidden', invited || !rows.length);
    if (!rows.length) {
      // Only visible when the policy is 'invited' — honest about the
      // merge gate's empty-roster fallback (services/governance.js:
      // full admins act as the approver set).
      list.innerHTML = '<div class="px-3 py-2 text-sm text-zinc-500">No approvers yet — platform admins can approve proposals until an approver is added.</div>';
      return;
    }
    const canManage = !!AppView.appData?.can_manage;
    list.innerHTML = rows.map((r) => {
      const pending = r.status === 'invited';
      const tag = pending
        ? '<span class="text-[0.65rem] text-amber-500 font-medium ml-1">invited</span>'
        : '<span class="text-[0.65rem] text-violet-500 font-medium ml-1">approver</span>';
      // Remove/revoke: creator/admin for anyone; approvers may remove
      // themselves (leave). Mirrors the server rules.
      const canRemove = canManage || r.userId === me.id;
      const removeBtn = canRemove
        ? `<button data-remove-approver="${r.userId}" class="text-xs text-zinc-400 hover:text-red-500 px-2 py-1" title="${pending ? 'Revoke invite' : (r.userId === me.id ? 'Stop being an approver' : 'Remove')}">${pending ? 'Revoke' : (r.userId === me.id ? 'Leave' : 'Remove')}</button>`
        : '';
      return `<div class="flex items-center justify-between px-3 py-2 ${pending ? 'opacity-70' : ''}">
        <span class="text-sm text-zinc-700 dark:text-zinc-300 truncate">@${escapeHtml(r.username)}${tag}</span>
        ${removeBtn}
      </div>`;
    }).join('');
    list.querySelectorAll('[data-remove-approver]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await fetch(
            `/api/apps/${AppView.appData.slug}/approvers/${btn.dataset.removeApprover}`,
            { method: 'DELETE' }
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          AppView.loadApprovers();
        } catch (err) {
          PlatformUI.toast(`Remove failed: ${err.message}`);
          btn.disabled = false;
        }
      });
    });
  },

  async _searchApproverUsers(q) {
    const box = document.getElementById('members-approver-suggestions');
    if (!box || !AppView.appData) return;
    if (!q) { AppView._hideApproverSuggestions(); return; }
    try {
      const params = new URLSearchParams({ q });
      const res = await fetch(`/api/users/search?${params.toString()}`);
      if (!res.ok) return;
      const { users } = await res.json();
      if (!users || !users.length) { AppView._hideApproverSuggestions(); return; }
      box.innerHTML = users.map((u) =>
        `<button data-approver-user="${escapeAttr(u.username)}" class="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">@${escapeHtml(u.username)}</button>`
      ).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('[data-approver-user]').forEach((btn) => {
        btn.addEventListener('click', () => AppView.sendApproverInvite(btn.dataset.approverUser));
      });
    } catch { /* typeahead is best-effort */ }
  },

  _hideApproverSuggestions() {
    const box = document.getElementById('members-approver-suggestions');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  },

  async sendApproverInvite(username) {
    const status = document.getElementById('members-approver-status');
    const input = document.getElementById('members-approver-invite-input');
    AppView._hideApproverSuggestions();
    if (status) { status.textContent = 'Inviting…'; status.className = 'text-sm mt-2'; }
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/approver-invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (status) {
        status.textContent = `✓ Invited @${data.username || username} as an approver`;
        status.className = 'text-sm mt-2 import-status--ok';
      }
      if (input) input.value = '';
      AppView.loadApprovers();
    } catch (err) {
      if (status) {
        status.textContent = err.message;
        status.className = 'text-sm mt-2 import-status--err';
      }
    }
  },

  // ── User locale bridge (issue #757) ────────────────────────────────
  //
  // The bridge's usernode.getUserLocale() posts a `__usernode_locale`
  // "get" message to window.parent; the shell answers with the signed-in
  // user's platform-level language preference (a BCP-47 tag, or null
  // when unset). Read-only and instant — no dialog, no ack stage.
  // Wired via the top-level message listener at the bottom of this file.

  handleLocaleBridgeMessage(e) {
    const data = e.data;
    if (!data || !data.id || data.__usernode_locale !== 'get') return;

    // Only the app iframes this shell owns may ask — same source gate
    // as the LLM consent family above.
    const appIframe = document.getElementById('app-iframe');
    const stagingIframe = document.getElementById('staging-iframe');
    const fromApp = appIframe && e.source === appIframe.contentWindow;
    const fromStaging = stagingIframe && e.source === stagingIframe.contentWindow;
    if (!fromApp && !fromStaging) return;

    const locale = (typeof App !== 'undefined' && App.user) ? (App.user.locale || null) : null;
    try {
      e.source.postMessage(
        { __usernode_locale: 'response', id: data.id, value: { locale } },
        '*'
      );
    } catch {}
  },

  // Push a locale change into any open app/staging iframe so the bridge
  // can dispatch its `usernode:locale-changed` event. Called by
  // settings.js after a successful POST /api/me/locale. Deliberately
  // does NOT rewrite the iframe src (that would reload the app mid-use);
  // the periodic token refresh and next open handle the JWT claim.
  notifyLocaleChanged(locale) {
    ['app-iframe', 'staging-iframe'].forEach((id) => {
      const iframe = document.getElementById(id);
      if (iframe && iframe.contentWindow) {
        try {
          iframe.contentWindow.postMessage(
            { __usernode_locale: 'changed', locale: locale || null },
            '*'
          );
        } catch {}
      }
    });
  },

  // ── Safe-area inset forwarding (issue #970) ────────────────────────
  //
  // WHY THIS EXISTS. `env(safe-area-inset-*)` resolves to 0px inside a
  // cross-origin iframe in every engine, so an embedded app has no way to
  // learn where the notch and the home indicator are. The shell used to
  // paper over that by reserving the bottom strip itself
  // (`un-safe-bottom` on #app-view) — which is exactly what cut apps off
  // short of the screen's rounded bottom edge. Now the frame runs
  // edge-to-edge and we TELL the app the insets instead; the bridge turns
  // them into `--un-safe-inset-*` custom properties on the app's <html>,
  // which the native kit's CSS reads. Note this also fixes something that
  // never worked: every kit safe-area rule was inert inside app frames.
  //
  // The forwarded values are the insets that apply to the FRAME'S RECT,
  // not the page's — see _frameInsets. That is what keeps the header's
  // already-consumed top inset from being counted twice.

  // The zero value, and the shape every path here produces.
  _zeroInsets() {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  },

  // Raw page insets. JS cannot read env() directly, so mount one hidden
  // probe whose padding IS the four env() values and read it back. The
  // probe is created once and reused; `position:fixed` + zero size +
  // `visibility:hidden` keep it out of layout and off the a11y tree.
  _safeAreaProbe: null,

  _readRootInsets() {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
      return AppView._zeroInsets();
    }
    let probe = AppView._safeAreaProbe;
    if (!probe || !probe.isConnected) {
      probe = document.createElement('div');
      probe.id = 'safe-area-probe';
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;'
        + 'visibility:hidden;pointer-events:none;'
        + 'padding-top:env(safe-area-inset-top,0px);'
        + 'padding-right:env(safe-area-inset-right,0px);'
        + 'padding-bottom:env(safe-area-inset-bottom,0px);'
        + 'padding-left:env(safe-area-inset-left,0px);';
      document.body.appendChild(probe);
      AppView._safeAreaProbe = probe;
    }
    const px = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    try {
      const cs = getComputedStyle(probe);
      return {
        top: px(cs.paddingTop),
        right: px(cs.paddingRight),
        bottom: px(cs.paddingBottom),
        left: px(cs.paddingLeft),
      };
    } catch {
      return AppView._zeroInsets();
    }
  },

  // PURE. Which part of each raw inset still lies under the frame.
  // Anything the shell's own chrome already covers is subtracted: with the
  // platform header over the frame's top edge the app's top inset is 0,
  // and it becomes the real status-bar inset the moment the header is
  // hidden (chromeless). Same on the other three edges, so a docked
  // staging panel, the anonymous viewer and desktop all fall out of the
  // same arithmetic.
  //
  // Clamped to [0, raw] per edge and rounded. Both bounds matter: a frame
  // that doesn't reach an edge subtracts past zero, and a frame OVERHANGING
  // the viewport (which happens transiently — the launch zoom pins the view
  // as a fixed overlay) subtracts a negative, which would otherwise forward
  // an inset LARGER than the screen's own. The unsafe strip under a frame
  // can never exceed the unsafe strip of the display. Sub-pixel rects are
  // normal and a fractional px in a CSS var buys nothing.
  //
  // `rect` is a DOMRect-alike in viewport coordinates; `viewport` is
  // { width, height } of the layout viewport.
  _frameInsets(raw, rect, viewport) {
    const zero = AppView._zeroInsets();
    if (!raw || !rect || !viewport) return zero;
    const w = Number(viewport.width);
    const h = Number(viewport.height);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return zero;
    const clamp = (n, max) => {
      if (!Number.isFinite(n) || n <= 0) return 0;
      const cap = Number.isFinite(max) && max > 0 ? max : 0;
      return Math.round(Math.min(n, cap));
    };
    return {
      top: clamp(raw.top - rect.top, raw.top),
      right: clamp(raw.right - (w - rect.right), raw.right),
      bottom: clamp(raw.bottom - (h - rect.bottom), raw.bottom),
      left: clamp(raw.left - rect.left, raw.left),
    };
  },

  // Every frame this shell owns and forwards insets to.
  SAFE_AREA_FRAME_IDS: ['app-iframe', 'app-viewer-frame', 'staging-iframe'],

  // Last value posted per frame id, so an unchanged recompute posts
  // nothing (a rotation is one message per frame, not a stream).
  _safeAreaSent: {},
  _safeAreaRaf: null,

  // The insets for one frame, or null when it isn't on screen.
  safeAreaForFrame(id) {
    if (typeof document === 'undefined' || typeof window === 'undefined') return null;
    const iframe = document.getElementById(id);
    if (!iframe || !iframe.isConnected || typeof iframe.getBoundingClientRect !== 'function') {
      return null;
    }
    const rect = iframe.getBoundingClientRect();
    // A hidden frame (display:none / not yet laid out) has a 0×0 rect,
    // which would read as "flush against every edge" and forward the full
    // page insets. Skip it; the next real layout re-broadcasts.
    if (!rect.width || !rect.height) return null;
    return AppView._frameInsets(
      AppView._readRootInsets(),
      rect,
      { width: window.innerWidth, height: window.innerHeight }
    );
  },

  // Post the current insets into every owned frame whose value changed.
  broadcastSafeArea() {
    if (typeof document === 'undefined') return;
    AppView.SAFE_AREA_FRAME_IDS.forEach((id) => {
      const iframe = document.getElementById(id);
      if (!iframe || !iframe.contentWindow) {
        delete AppView._safeAreaSent[id];
        return;
      }
      const value = AppView.safeAreaForFrame(id);
      if (!value) return;
      const key = `${value.top},${value.right},${value.bottom},${value.left}`;
      if (AppView._safeAreaSent[id] === key) return;
      AppView._safeAreaSent[id] = key;
      try {
        iframe.contentWindow.postMessage(
          { __usernode_safe_area: 'changed', value },
          '*'
        );
      } catch {}
    });
  },

  // rAF-coalesced entry point — everything that can move a frame's rect
  // calls this rather than broadcastSafeArea directly, so a burst of
  // resize/orientation events collapses into one recompute per frame.
  scheduleSafeAreaBroadcast() {
    if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') {
      AppView.broadcastSafeArea();
      return;
    }
    if (AppView._safeAreaRaf !== null) return;
    AppView._safeAreaRaf = requestAnimationFrame(() => {
      AppView._safeAreaRaf = null;
      AppView.broadcastSafeArea();
    });
  },

  // The bridge asks once at startup, so an app never has to wait for a
  // resize to learn its insets (and can't miss a `changed` posted before
  // its listener was installed). Same source gate as the locale family.
  handleSafeAreaBridgeMessage(e) {
    const data = e.data;
    if (!data || !data.id || data.__usernode_safe_area !== 'get') return;

    const match = AppView.SAFE_AREA_FRAME_IDS.find((id) => {
      const iframe = document.getElementById(id);
      return iframe && e.source === iframe.contentWindow;
    });
    if (!match) return;

    const value = AppView.safeAreaForFrame(match) || AppView._zeroInsets();
    // Record it so the next broadcast doesn't re-post the same numbers.
    AppView._safeAreaSent[match] = `${value.top},${value.right},${value.bottom},${value.left}`;
    try {
      e.source.postMessage(
        { __usernode_safe_area: 'response', id: data.id, value },
        '*'
      );
    } catch {}
  },

  // ── App LLM access consent flow (issue #34) ────────────────────────
  //
  // The bridge's usernode.requestLlmAccess()/getLlmAccess()/
  // getLlmUsage() post a `__usernode_llm` message to window.parent;
  // the shell (this file — it owns the app iframe) answers. The
  // consent dialog is platform-owned: it renders over the app, from
  // our origin, so an app cannot approve itself. Wired via the
  // top-level message listener at the bottom of this file.

  async handleLlmBridgeMessage(e) {
    const data = e.data;
    if (!data || !data.id) return;
    const type = data.__usernode_llm;
    if (type !== 'request-access' && type !== 'get-access' && type !== 'get-usage') return;

    // Only the app iframes this shell owns may ask. The staging
    // preview iframe is accepted too so AI-consent flows are
    // exercisable in PR previews (the staging proxy path itself is
    // disabled server-side — staging containers hold no proxy token).
    const appIframe = document.getElementById('app-iframe');
    const stagingIframe = document.getElementById('staging-iframe');
    const fromApp = appIframe && e.source === appIframe.contentWindow;
    const fromStaging = stagingIframe && e.source === stagingIframe.contentWindow;
    if (!fromApp && !fromStaging) return;
    const slug = AppView.appData?.slug;
    if (!slug) return;

    const reply = (value, error) => {
      try {
        e.source.postMessage(
          { __usernode_llm: 'response', id: data.id, value: value ?? null, error: error ?? null },
          '*'
        );
      } catch {}
    };
    // Ack immediately so the bridge stops its "no shell here" timer —
    // the user may take minutes on the dialog below.
    try { e.source.postMessage({ __usernode_llm: 'ack', id: data.id }, '*'); } catch {}

    let info;
    try {
      const r = await fetch(`/api/apps/${slug}/llm-grant`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`status ${r.status}`);
      info = await r.json();
    } catch (err) {
      reply(null, 'Failed to load AI permission state.');
      return;
    }

    const active = info.grant && info.grant.status === 'active';

    // Read-only usage meter (issue #655) — never opens the consent
    // dialog. Both spend buckets are summed because the proxy's cap
    // gate counts BYOK spend against the cap too.
    if (type === 'get-usage') {
      if (!active) {
        reply({ granted: false });
        return;
      }
      reply({
        granted: true,
        spentCentsToday:
          (info.grant.spentTodayCents || 0) + (info.grant.byokSpentTodayCents || 0),
        dailyCapCents: info.grant.dailyCapCents,
      });
      return;
    }

    const current = active
      ? { granted: true, dailyCapCents: info.grant.dailyCapCents, allowByok: info.grant.allowByok }
      : { granted: false };
    if (type === 'get-access' || active) {
      reply(current);
      return;
    }

    const decision = await AppView.showLlmConsentModal(info);
    if (!decision) {
      reply({ granted: false, declined: true });
      return;
    }
    try {
      const r = await fetch('/api/me/llm-grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          appSlug: slug,
          dailyCapCents: decision.dailyCapCents,
          allowByok: decision.allowByok,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        reply(null, j.error || 'Failed to save permission.');
        return;
      }
      reply({
        granted: true,
        dailyCapCents: j.grant.dailyCapCents,
        allowByok: j.grant.allowByok,
      });
    } catch (err) {
      reply(null, 'Network error saving permission.');
    }
  },

  // ── App file storage relay (#752) ───────────────────────────────────
  //
  // The bridge's usernode.uploadFile()/deleteFile()/getStorageUsage()
  // post a `__usernode_storage` message to window.parent; the shell
  // (this file — it owns the app iframe) performs the authenticated
  // call with its own session cookie against /api/apps/:slug/files*.
  // The staging preview iframe is accepted too (uploads from it are
  // stamped staging=1 server-side and GC'd after 7 days) so photo
  // flows are exercisable in PR previews. Wired via the top-level
  // message listener at the bottom of this file.

  async handleStorageBridgeMessage(e) {
    const data = e.data;
    if (!data || !data.id) return;
    const type = data.__usernode_storage;
    if (type !== 'upload' && type !== 'delete' && type !== 'get-usage') return;

    const appIframe = document.getElementById('app-iframe');
    const stagingIframe = document.getElementById('staging-iframe');
    const fromApp = appIframe && e.source === appIframe.contentWindow;
    const fromStaging = stagingIframe && e.source === stagingIframe.contentWindow;
    if (!fromApp && !fromStaging) return;
    const slug = AppView.appData?.slug;
    if (!slug) return;

    const reply = (value, error) => {
      try {
        e.source.postMessage(
          { __usernode_storage: 'response', id: data.id, value: value ?? null, error: error ?? null },
          '*'
        );
      } catch {}
    };
    // Ack immediately so the bridge stops its "no shell here" timer —
    // a multi-MB upload POST can take a while on a slow link.
    try { e.source.postMessage({ __usernode_storage: 'ack', id: data.id }, '*'); } catch {}

    try {
      if (type === 'upload') {
        const bytes = data.bytes;
        if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength) {
          reply(null, 'No file bytes received.');
          return;
        }
        const params = new URLSearchParams({ filename: String(data.filename || '') });
        if (data.visibility === 'private') params.set('visibility', 'private');
        if (fromStaging) params.set('staging', '1');
        const r = await fetch(`/api/apps/${encodeURIComponent(slug)}/files?${params}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          reply(null, j.error || `Upload failed (${r.status}).`);
          return;
        }
        reply(j);
        return;
      }

      if (type === 'delete') {
        const fileId = String(data.fileId || '');
        if (!/^[a-f0-9]{32}$/.test(fileId)) {
          reply(null, 'File not found.');
          return;
        }
        const r = await fetch(`/api/apps/${encodeURIComponent(slug)}/files/${fileId}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          reply(null, j.error || `Delete failed (${r.status}).`);
          return;
        }
        reply({ ok: true });
        return;
      }

      // get-usage
      const r = await fetch(`/api/apps/${encodeURIComponent(slug)}/files/usage`, {
        credentials: 'same-origin',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        reply(null, j.error || `Usage read failed (${r.status}).`);
        return;
      }
      reply(j);
    } catch {
      reply(null, 'Network error talking to the platform.');
    }
  },

  // ── Issue-state snapshots (issue #685) ─────────────────────────────
  //
  // The bridge's usernode.issueState.register() posts an `available`
  // announcement from the app iframe; the feedback modal shows its
  // "Include app state" checkbox only while the announcing frame is
  // still the mounted production iframe, and asks for the snapshot at
  // submit time via a `collect` request. Wired through the same
  // top-level message listener as the LLM consent relay below.
  //
  // Production iframe only — the staging preview is deliberately
  // excluded: a snapshot from a PR preview labeled as app state would
  // be misleading on a production-repo issue.

  handleIssueStateMessage(e) {
    const data = e.data;
    if (!data) return;
    const type = data.__usernode_issue_state;
    if (type !== 'available' && type !== 'unavailable') return;
    const appIframe = document.getElementById('app-iframe');
    if (!appIframe || e.source !== appIframe.contentWindow) return;
    AppView._issueStateSource = type === 'available' ? e.source : null;
  },

  // True iff a provider announced itself from the currently mounted
  // production iframe. The App tab tears its iframe down on every tab
  // switch (renderAppTab rewrites content.innerHTML), so this is
  // naturally false on the Dev screen, where there's no live app to
  // snapshot.
  issueStateAvailable() {
    if (!AppView._issueStateSource) return false;
    const appIframe = document.getElementById('app-iframe');
    return !!appIframe && appIframe.contentWindow === AppView._issueStateSource;
  },

  // Ask the app for its state snapshot. Resolves { json, truncated } or
  // null — never rejects, and never waits past 5 s: filing an issue
  // must not block on a frozen app. No ack leg (unlike the LLM flow) —
  // there's no human decision in the middle, just the provider call.
  collectIssueState() {
    return new Promise((resolve) => {
      if (!AppView.issueStateAvailable()) return resolve(null);
      const target = AppView._issueStateSource;
      const id = `issue-state-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let settled = false;
      let timer = null;
      const onMessage = (e) => {
        if (e.source !== target) return;
        const data = e.data;
        if (!data || data.__usernode_issue_state !== 'response' || data.id !== id) return;
        if (data.error || !data.value || typeof data.value.json !== 'string') {
          finish(null);
          return;
        }
        finish({ json: data.value.json, truncated: !!data.value.truncated });
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => finish(null), 5000);
      window.addEventListener('message', onMessage);
      try {
        target.postMessage({ __usernode_issue_state: 'collect', id }, '*');
      } catch {
        finish(null);
      }
    });
  },

  // Singleton consent dialog, same scrim/card pattern as
  // confirm-modal.js. Resolves { dailyCapCents, allowByok } on Allow,
  // null on "Not now" / backdrop / Esc.
  _llmModalEl: null,
  showLlmConsentModal(info) {
    return new Promise((resolve) => {
      // Recreate the element on every open so listeners from a prior
      // dialog don't accumulate on the reused node.
      if (AppView._llmModalEl) {
        AppView._llmModalEl.remove();
        AppView._llmModalEl = null;
      }
      const root = document.createElement('div');
      root.id = 'llm-consent-modal';
      root.className = 'hidden fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-black/60';
      document.body.appendChild(root);
      AppView._llmModalEl = root;

      const appName = info.app?.name || info.app?.slug || 'This app';
      const suggested = info.llm?.suggestedCapCents ?? null;
      const prefillCents = suggested ?? info.defaultCapCents ?? 100;
      const maxCents = info.maxCapCents || 2500;
      const purposeLine = info.llm?.purpose
        ? `<p class="text-sm text-zinc-600 dark:text-zinc-400 mb-3 italic">&ldquo;${escapeHtml(info.llm.purpose)}&rdquo;</p>`
        : '';
      const suggestedNote = suggested != null
        ? `<p class="text-xs text-zinc-500 dark:text-zinc-500 mt-1">Suggested by this app &mdash; you can change it.</p>`
        : `<p class="text-xs text-zinc-500 dark:text-zinc-500 mt-1">You can change this anytime in Settings.</p>`;
      const byokBlock = info.hasApiKey
        ? `<label class="flex items-start gap-2 cursor-pointer select-none mt-4">
             <input id="llm-consent-byok" type="checkbox" class="accent-violet-500 w-4 h-4 mt-0.5" />
             <span class="text-xs text-zinc-700 dark:text-zinc-300">If my daily platform budget runs out, let this app keep going on my own API key (still limited by the cap above).</span>
           </label>`
        : '';

      root.innerHTML = `
        <div data-modal-backdrop class="flex min-h-full items-center justify-center p-4">
          <div class="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-md shadow-xl relative">
            <h2 class="text-lg font-bold mb-2 text-zinc-900 dark:text-zinc-100">Allow ${escapeHtml(appName)} to use AI?</h2>
            ${purposeLine}
            <p class="text-sm text-zinc-600 dark:text-zinc-400 mb-3">
              This lets <strong>${escapeHtml(appName)}</strong> spend from your daily AI budget &mdash; the same one your dev chats use &mdash; up to the daily cap below.
            </p>
            <label class="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1" for="llm-consent-cap">Daily cap for this app ($ per day)</label>
            <input id="llm-consent-cap" type="number" min="0.01" step="0.01"
              value="${(prefillCents / 100).toFixed(2)}"
              class="w-32 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 font-mono" />
            ${suggestedNote}
            ${byokBlock}
            <div id="llm-consent-error" class="hidden text-sm text-red-500 mt-3"></div>
            <div class="flex justify-end gap-2 mt-5">
              <button id="llm-consent-decline" type="button"
                class="rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">Not now</button>
              <button id="llm-consent-allow" type="button"
                class="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors">Allow</button>
            </div>
          </div>
        </div>`;

      const done = (result) => {
        root.classList.add('hidden');
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onKey = (ev) => {
        if (ev.key === 'Escape') done(null);
      };
      document.addEventListener('keydown', onKey);

      root.addEventListener('click', (ev) => {
        if (ev.target === root || ev.target.dataset.modalBackdrop !== undefined) done(null);
      }, { once: false });
      root.querySelector('#llm-consent-decline').addEventListener('click', () => done(null));
      root.querySelector('#llm-consent-allow').addEventListener('click', () => {
        const errEl = root.querySelector('#llm-consent-error');
        const dollars = parseFloat(root.querySelector('#llm-consent-cap').value);
        const cents = Math.round(dollars * 100);
        if (!Number.isFinite(dollars) || !Number.isInteger(cents) || cents <= 0) {
          errEl.textContent = 'Enter a valid daily cap (at least $0.01).';
          errEl.classList.remove('hidden');
          return;
        }
        if (cents > maxCents) {
          errEl.textContent = `The cap can't exceed your own daily limit ($${(maxCents / 100).toFixed(2)}).`;
          errEl.classList.remove('hidden');
          return;
        }
        const byokInput = root.querySelector('#llm-consent-byok');
        done({ dailyCapCents: cents, allowByok: !!(byokInput && byokInput.checked) });
      });

      root.classList.remove('hidden');
    });
  },
};

// Bridge → shell consent relay for app LLM access (issue #34). One
// top-level listener; handleLlmBridgeMessage verifies the source is an
// iframe this shell owns and ignores everything else.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    try { AppView.handleLlmBridgeMessage(e); } catch {}
    // #685: issue-state availability announcements from the app iframe.
    try { AppView.handleIssueStateMessage(e); } catch {}
    // #752: file-storage relay (uploadFile/deleteFile/getStorageUsage).
    try { AppView.handleStorageBridgeMessage(e); } catch {}
    // #757: usernode.getUserLocale() reads from the app iframe.
    try { AppView.handleLocaleBridgeMessage(e); } catch {}
    // #970: the bridge's startup request for this frame's safe-area insets.
    try { AppView.handleSafeAreaBridgeMessage(e); } catch {}
  });

  // #970: anything that can change a frame's rect relative to the page's
  // safe area re-broadcasts. Rotation and window resizes change the insets
  // themselves; the visualViewport resize covers the on-screen keyboard
  // and iOS toolbar collapse, which move the layout viewport's bottom
  // edge. All three funnel through the rAF-coalesced, value-deduplicated
  // scheduler, so the cost of a burst is one recompute per frame.
  const onViewportChange = () => AppView.scheduleSafeAreaBroadcast();
  window.addEventListener('resize', onViewportChange, { passive: true });
  window.addEventListener('orientationchange', onViewportChange, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewportChange, { passive: true });
  }
}

// Small helpers used by the #21 version pill. Kept local so app-view
// stays self-contained — the dev-console has its own copy of these.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/\n/g, ' '); }

// Browser script first, but expose AppView to node so the pure
// scroll-memory helpers (_saveFeedScroll / _getFeedScroll /
// _clampScrollTop) can be unit-tested without a DOM. No-op in the
// browser, where `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppView;
}

function relTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Expose AppView on the global object. `const AppView = {…}` above is a
// top-level lexical binding: in a classic (non-module) script it's reachable
// as a bareword from other scripts, but it is NOT a property of `window`.
// The header-drawer row handlers in app.js gate on `window.AppView` (mirroring
// `window.App`/`window.Settings`), so without this assignment those handlers
// see `window.AppView === undefined` and never call openMembersModal /
// openShareModal — the drawer closed but no panel ever opened. (Found via the
// staging debug overlay: "drawer-row-members CLICK fired → window.AppView MISSING".)
// Guarded so requiring this file in node (for the pure-helper unit tests,
// see the module.exports block above) doesn't crash on a missing `window`.
if (typeof window !== 'undefined') {
  window.AppView = AppView;
  // #1038: wire the Dev board's card surfaces to live session state. Both
  // subscriptions are registered ONCE here rather than per mount, so no
  // repaint or navigation can leave the board stranded on a stale spinner;
  // the handlers themselves no-op when no card surface is mounted.
  //
  // Order matters: the raw event handler patches the cached issue row's
  // auto-run state, and the coalesced subscriber repaints from that cache.
  if (window.SessionState) {
    SessionState.onEvent(AppView._onSessionStateEvent);
    SessionState.subscribe(AppView._onSessionStateChanged);
  }
}
